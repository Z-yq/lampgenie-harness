/**
 * 写时定形(write-time shaping)工具结果 spill —— 对齐 deepseek-harness `spill/spill-policy`:
 * 工具结果**进历史之前**就定形成「头 + 单行标记 + 尾 + 落盘路径 + 回读指引」,之后**永不改写**。
 * 为什么要写时定形(2026-11 token 优化轮 02,经验证代价见 designs/token-opt-round2.md):
 * 旧口径是**读时改写**——journal 全量落账,microcompact 每步 derive 后把超阈 tool content 改成
 * head/tail。同一 toolCallId 的 content 每步重算 → messages 前缀逐字变化 → prompt cache 全量失效
 * (经验证 uncached 单价 = 命中的 50 倍)。改在入口定形一次,此后请求前缀逐字节稳定。
 * 零改动约束:本模块**不改** microcompact.ts / compact-gate.ts。读侧之所以不会二次改写,靠的是
 * 下面这条设计:预览里的单行标记复用读侧既有的「已是占位内容」前缀(`[工具结果已精炼:`),读侧
 * `isPlaceholderContent()` 命中即跳过(路径①超大精炼/路径②组清理/dedup-supersede 三处同判)。
 * 另外预览总长(head+标记+尾)恒 < 8192,天然低于读侧 HUGE_RESULT_CHARS=8000 之上不会有二次剪。
 * fail-open 纪律:落盘失败(权限/磁盘/路径非法)一律返回原文——spill 是省 token 的优化,
 * 绝不能因为它失败而丢掉工具结果(丢结果=模型失忆,比多花 token 严重得多)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 触发 spill 的内容长度阈值(字符):超过才落盘定形(对齐 dsh 8192)。 */
export const SPILL_THRESHOLD_CHARS = 8192;
/** 预览保留的头部长度(字符)。 */
export const SPILL_HEAD_CHARS = 4096;
/** 预览保留的尾部长度(字符;尾部往往是错误与最终结果)。 */
export const SPILL_TAIL_CHARS = 1024;

/**
 * 排除名单:这些工具的结果**不做** spill。
 * - 认知类(code_sense/code_index/tool_view/board_read):结构化浓缩结果,外置后模型还得回读,纯亏;
 * - 回执类(edit_file/write_file/todo_write/task_phase/board_upsert):「动作已发生」的账,不能只剩摘要。
 * read_file **已移出**名单( token 轮 04):旧注释理由是「防 read-spill 循环」——
 * 把 read_file 结果外置等于逼模型再 read_file 那个 spill 文件。但这个顾虑的前提是「占位里只告诉
 * 模型去看 spill 文件」;经验证代价是单次 read_file 峰值 **71,967 字符**全量进历史(227 次调用共
 * 88 万字符),而 read_file 的原始文件本来就在磁盘上、路径已知。
 * 现改法:read_file 走**独立高阈值**(READ_FILE_SPILL_THRESHOLD_CHARS=32000,远超全局 8192),
 * 且占位提示改为「回读原文件 offset/limit」——循环风险由提示语消解,而不是靠不外置。
 * 32000 的取法:经验证 read_file p50=2,659 / p90=6,450,即 99% 的常规读根本不触发;
 * 只有真正整读大文件(如 panel.ts 整篇)才外置。
 */
export const SPILL_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "tool_view", "code_sense", "code_index", "board_read", "board_upsert",
  "edit_file", "write_file", "todo_write", "task_phase",
]);

/** 逐工具阈值覆写(read_file 比全局高,见上方名单注释)。未列出的工具用 opts.thresholdChars 或全局 8192。 */
export const TOOL_SPILL_THRESHOLDS: Readonly<Record<string, number>> = {
  read_file: 32_000,
};

/** read_file 的定制占位提示:指向**原文件**而非 spill 文件(spill 文件只是落盘副本,没有行号语义)。 */
export const READ_FILE_SPILL_HINT =
  "回读请对**原文件**用 read_file(offset/limit) 局部读(不要在 spill 副本上读——它没有行号语义);"
  + "或在原文件上 grep(pattern, path=原文件) 定向检索";

/**
 * 预览标记前缀。**刻意与读侧 microcompact 的 `HUGE_PLACEHOLDER_PREFIX` 同字面**:读侧
 * `isPlaceholderContent()` 用 `content.includes("[工具结果已精炼:")` 判「已定形内容」,
 * 命中即三处全部跳过(精炼/组清理/去重)。这样「写时定形 + 读时零改写」不用改压缩器一行。
 * 语义也成立:它就是该 tool 结果写时做过的一次精炼(中段外置到磁盘,头尾留档)。
 */
export const SPILL_MARKER_PREFIX = "[工具结果已精炼:";

/** 预览总长上限(严格小于,给读侧 8000 阈值留余量;实际默认 4096+1024+标记 ≈ 5.4k)。 */
const SPILL_PREVIEW_MAX_CHARS = SPILL_THRESHOLD_CHARS;

/** spill 配置项(loop 的 `opts.spill` 同形,阈值可按调用方覆写)。 */
export interface SpillConfig {
  /** 落盘根目录(装配方给 `<repo>/.genie/spill`)。 */
  dir: string;
  thresholdChars?: number;
  headChars?: number;
  tailChars?: number;
}

/** 路径段消毒:非 `[A-Za-z0-9._-]` 换 `_`,并截断 ≤80 字符(路径段安全,防注入/超长)。 */
export function safeSegment(raw: unknown, maxLen = 80): string {
  const text = String(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 是否该 spill:内容长度 > 阈值 且 工具不在排除名单。
 * 空/非字符串内容一律不 spill(fail-safe:没内容可省)。
 */
export function shouldSpill(
  toolName: string,
  content: unknown,
  opts?: { thresholdChars?: number },
): boolean {
  if (typeof content !== "string" || content.length === 0) return false;
  if (SPILL_EXCLUDED_TOOLS.has(toolName)) return false;
  // 逐工具阈值优先于调用方阈值:read_file 的 32000 是安全下限,不该被全局 8192 冲掉
  // (否则 spill 立刻退化成旧行为,read-spill 循环风险又回来了)。
  const toolThreshold = TOOL_SPILL_THRESHOLDS[toolName];
  const threshold = toolThreshold ?? positiveInt(opts?.thresholdChars, SPILL_THRESHOLD_CHARS);
  return content.length > threshold;
}

function buildMarker(
  originalChars: number, prunedChars: number, absolutePath: string, headChars: number, tailChars: number,
  toolName?: string): string {
 // read_file 的定制指引( token 轮 04):回读目标是**原文件**而不是 spill 副本。
  // 这是把 read_file 移出排除名单的前提——旧口径的「防 read-spill 循环」靠不外置实现,
  // 现改成靠提示语实现(副本没有行号语义,指回副本才是真循环)。
  const hint = toolName === "read_file"
    ? READ_FILE_SPILL_HINT
    : "需要中段/全文用 read_file(offset/limit) 局部读,或 grep(pattern, path=该文件) 定向检索";
  // 单行标记(不带换行):原字符数 + 剪除量 + 绝对路径 + 回读指引。总长受 SPILL_MARKER_PREFIX 语义约束。
  return `${SPILL_MARKER_PREFIX}中段 ${prunedChars} 字符已写时外置(原共 ${originalChars} 字符,此处保留头 ${headChars} + 尾 ${tailChars});`
    + `全文落盘 ${absolutePath};${hint}]`;
}

/**
 * 构造 spill 预览:头 + 单行标记 + 尾。**总长恒 < 8192**(超预算时按比例压缩头尾,标记永不剪)。
 * 头尾任一侧为 0/不可用时省略该侧(极端小内容不会走到这里,shouldSpill 已把门)。
 */
export function buildSpillPreview(
  content: unknown,
  opts: { path: string; headChars?: number; tailChars?: number; toolName?: string },
): string {
  const text = typeof content === "string" ? content : String(content ?? "");
  const absolutePath = resolve(String(opts.path ?? ""));
  let headChars = positiveInt(opts.headChars, SPILL_HEAD_CHARS);
  let tailChars = positiveInt(opts.tailChars, SPILL_TAIL_CHARS);
  // 头尾不重叠(内容可能刚好比头+尾稍长)。
  if (headChars + tailChars > text.length) {
    headChars = Math.min(headChars, text.length);
    tailChars = Math.max(0, Math.min(tailChars, text.length - headChars));
  }
  const prunedChars = Math.max(0, text.length - headChars - tailChars);
  const marker = buildMarker(text.length, prunedChars, absolutePath, headChars, tailChars, opts.toolName);
  // 预算:标记 + 两个换行 + 头 + 尾必须**严格** < 预览上限(保守:先把尾压到 0,再压头)。
  const budget = SPILL_PREVIEW_MAX_CHARS - marker.length - 3;
  if (headChars + tailChars > budget) {
    const safeBudget = Math.max(0, budget);
    tailChars = Math.min(tailChars, Math.floor(safeBudget / 5));
    headChars = Math.min(headChars, Math.max(0, safeBudget - tailChars));
  }
  const head = headChars > 0 ? text.slice(0, headChars) : "";
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${head}\n${marker}${tail ? "\n" + tail : ""}`;
}

/** spill 落盘路径:`<dir>/<safe(sessionId)>/<safe(callId)>-<safe(toolName)>.txt`(绝对路径)。 */
export function spillFilePath(opts: { dir: string; sessionId: string; callId: string; toolName: string }): string {
  return resolve(join(opts.dir, safeSegment(opts.sessionId), `${safeSegment(opts.callId)}-${safeSegment(opts.toolName)}.txt`));
}

export interface SpillToolResultOptions extends SpillConfig {
  sessionId: string;
  /** 工具调用 id(journal/derive 的配对键;用作文件名主体)。 */
  callId: string;
  toolName: string;
  content: string;
}

/**
 * 写时定形入口:不满足 shouldSpill → 原样返回;满足 → 落盘 + 返回预览。
 * **任何异常 fail-open 返回原文**(不因 spill 失败丢结果)。
 */
export async function spillToolResult(opts: SpillToolResultOptions): Promise<string> {
  const content = typeof opts.content === "string" ? opts.content : String(opts?.content ?? "");
  try {
    if (!shouldSpill(opts.toolName, content, { thresholdChars: opts.thresholdChars })) return content;
    if (!opts.dir) return content; // 没配置落盘根=无从定形,退回原文(不抛)
    const path = spillFilePath(opts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return buildSpillPreview(content, {
      path,
      toolName: opts.toolName,
      ...(opts.headChars !== undefined ? { headChars: opts.headChars } : {}),
      ...(opts.tailChars !== undefined ? { tailChars: opts.tailChars } : {}),
    });
  } catch {
    // fail-open:落盘/定性失败都退回原文(宁可多花 token,不可丢工具结果)。
    return content;
  }
}
