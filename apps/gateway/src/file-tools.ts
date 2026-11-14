/**
 * 主 agent 直操作文件工具(对标补齐:主循环此前只有 spawn_subagent/code_sense 等,
 * 连 read/write 这类基础文件工具都没有——查文件/小步修改都被迫派子代理,轻活重派)。
 * 六件套:read_file / write_file / edit_file / glob / grep / list_dir。
 * 语义锚点(主流 coding agent 工具契约的诚实子集):
 * - read_file:带行号窗口读(1-based offset + limit,缺省/上限 2000 行,单行截断 2000 字符,
 *   输出总量上限 120KB);读侧登记 mtime(编辑保鲜:写/编辑工具据此拒绝盲写)。
 * - write_file:整文件写(自动建父目录);覆写已存在文件必须先 read_file 且读后未被外部改动。
 * - edit_file:精确字面替换(old_string 与文件内容逐字匹配;缺省要求唯一,不唯一报命中数;
 *   replace_all 全替;old===new 拒绝;编辑成功后本会话视为已读,连续编辑免重读)。
 * - glob:文件名模式匹配(* 不跨目录,** 跨目录,? 单字符,{a,b} 枚举;无 "/" 的模式同时匹配
 *   任意层级的文件名);结果按修改时间新→旧排序(最近改动的文件排前)。
 * - grep:内容检索(content/files_with_matches/count 三种输出模式,缺省 content 带行号)。
 * - list_dir:目录直接子项([d]/[f] 前缀)。
 * 路径围栏:只接受任务项目根内的相对路径——绝对路径与 .. 上跳一律拒绝(board-store 同款判定),
 * 已存在路径再按 realpath 复核,防符号链接逃逸。
 * 权限:读类(read_file/glob/grep/list_dir)声明 isReadOnly——权限闸门豁免,全部权限模式下可用
 * (无副作用的调查不设闸);写类(write_file/edit_file)在 readonly/plan 直接拒绝
 * (permission.gate 落 journal),其余模式交 loop 既有闸门(规则/面板 ask 审批链;
 * 类别别名 file.write——单条规则同时覆盖两个写工具)。
 * journal:tool.call/tool.result 由 loop 统一落账,本模块不重复记(起唯一例外:
 * read_file 成功后旁路追加 tool.tokens 遥测事件,见下方专用段)。
 */
import { existsSync, realpathSync, type Stats } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Journal } from "@lampgenie/core";
import type { Tool } from "@lampgenie/runtime/agent/loop";
// 视觉尺寸守卫(事故):注入前解析图片头判像素,超模型上限直接拒注入——
// 坏 dataUrl 一旦落进 journal(tool.result.payload.images),derive 每轮重放,会话永久 400。
import { checkImageSize, readImageSize } from "./image-size.js";
import { VISION_TOOL_SENTINEL } from "@lampgenie/runtime/agent/loop";
import { checkImageInjected, checkRepeatRead, recordFileRead, recordImageInjected } from "@lampgenie/runtime/agent/read-file-state";
import type { DiagnosticItem, LspSettings } from "@lampgenie/lsp";
import { permissionMode } from "./permission-mode.js";
// 输入边界防御:read guard 顺序(归一→设备/伪文件→stat special→denylist→binary→read)、
// 单行 clamp、编辑比例守卫;阈值常量集中在 input-boundary(本模块只引用)。
import { BINARY_PROBE_BYTES, checkEditRatio, clampLine, readGuardPath, readHeadBytes } from "./input-boundary.js";
import { readToolDump } from "@lampgenie/runtime/agent/big-intake";

/** 异步文件探测(冻结治理):工具执行面的全部文件 IO 从同步 API 改 fs/promises——
 *  WSL 9p 挂载停顿时,readFileSync/statSync 会把 worker 事件循环整个冻住(同 worker 的主 agent
 * 与全部子代理一起停摆, 注意:四个 loop 卡死 35 分钟无人收割)。异步化后单个停顿只
 *  挂起该工具的 Promise(loop 层 toolTimeoutMs 兜底换路),事件循环与心跳保持活着。
 * fencePath 同步残留已清零(existsSync 爬升+realpathSync 是第四次冻结的同类地雷)。 */
async function statOrNull(p: string): Promise<Stats | null> {
  try { return await fsp.stat(p); } catch { return null; }
}

/**
 * 编辑后检查尾缀( /):动态装载 @lampgenie/lsp(包缺失/dist 未建时静默跳过,
 * 行为与旧版一致——fail-soft 不阻塞写入)。生产由 agent-wiring 注入 coding.lsp。
 * baseline/baselineText:写前采集的基线诊断与旧内容(delta 只报新增;不传=旧行为全量报告)。
 */
async function editCheckSuffixSafe(
  root: string,
  absPath: string,
  settings?: LspSettings,
  baseline?: DiagnosticItem[] | null,
  baselineText?: string): Promise<string> {
  if (!settings || settings.enabled === false) return ""; // 低层缺省关闭:零装载开销
  try {
    const mod = await import("@lampgenie/lsp");
    return await mod.editCheckSuffix({ root, absPath, settings, baseline, baselineText });
  } catch {
    return "";
  }
}

/**
 * 写前 baseline 采集:必须在 fsp.writeFile **之前**调用(tsc 兜底按磁盘内容建 program)。
 * @returns undefined=不做 delta(低层关闭 / baseline:false);{baseline:null}=采集失败(标未检查,不阻塞写)。
 */
async function editBaselineSafe(
  root: string,
  absPath: string,
  prevText: string | undefined,
  settings?: LspSettings): Promise<{ baseline: DiagnosticItem[] | null; baselineText: string } | undefined> {
  if (!settings || settings.enabled === false) return undefined;
  if (settings.baseline === false) return undefined;
  if (prevText === "") return { baseline: [], baselineText: "" }; // 新文件:基线为空(不探测)
  if (prevText === undefined) return { baseline: null, baselineText: "" }; // 旧文本读不到=如实不可用
  try {
    const mod = await import("@lampgenie/lsp");
    return { baseline: await mod.collectBaselineDiagnostics({ root, absPath, text: prevText, settings }), baselineText: prevText };
  } catch {
    return { baseline: null, baselineText: prevText };
  }
}

/**
 * 语义 token 旁路发射(面板着色数据面):read_file 成功后 fire-and-forget 计算
 * SemanticTokenFile( §2.1, typed/ 逐文件深提取)并以 `tool.tokens` 事件入账。
 * 设计要点:
 * - 异步旁路:typed 提取暖态 25ms~1.5s(C 大文件经验证),绝不阻塞 agent loop;着色晚一个拉史
 *   周期到面板(≤1.5s 节顿),不可感知。
 * - fail-soft:typed 模块缺失(dist 陈旧)/解析异常/不支持语言=静默跳过,行为与旧版一致;
 *   全链 catch,零 unhandled rejection(087 R3 教训:fire-and-forget 必须自吞异常)。
 * - callId 关联:Tool.execute 第三参 ctx.callId(loop 透传)→ 事件带 toolCallId,面板定向关联。
 * - 省资源:仅支持扩展名发射;串行队列防 ts-morph/wasm 并发内存尖峰;path+mtime 备忘缓存
 *   (≤8 条,同文件重读零重复计算);单事件 2500 token 上限(truncated 如实标记)。
 * - 纯面板遥测:不入 LLM 上下文(deriveMessages 不读该 kind)、不进会话导出(session-export 白名单)。
 */
const TOKENIZED_EXT = /\.(c|h|cpp|cc|cxx|hpp|hh|hxx|py|ts|tsx|js|jsx|mjs|cjs|go|java)$/i;
const TOOL_TOKENS_MAX = 2500;
const TOOL_TOKENS_MEMO_MAX = 8;
const toolTokensMemo = new Map<string, { mtime: number; payload: Record<string, unknown> | null }>();
let toolTokensChain: Promise<void> = Promise.resolve(); // 串行队列(防并发提取内存尖峰)

/** LSP 检查器预热:任务装配时后台加载 typescript,首条编辑不再等模块冷启。 */
let lspWarmed = false;
function warmLspChecker(settings?: LspSettings): void {
  if (lspWarmed || !settings || settings.enabled === false) return;
  lspWarmed = true;
  void import("@lampgenie/lsp").then((m) => m.warmTypeScriptChecker()).catch(() => { /* fail-soft */ });
}

/** 计算 semantic token payload;null=无事件(不支持/降级/零 token),全 catch 静默。 */
async function computeToolTokens(root: string, rel: string): Promise<Record<string, unknown> | null> {
  try {
    const mod = (await import("@lampgenie/code-sense/typed/index")) as {
      extractTypedSymbols(root: string, rel: string): Promise<{ language?: string; degraded?: { reason: string } }>;
      toSemanticTokens(r: unknown): { language: string; tokens: Record<string, unknown>[] } | undefined;
    };
    const r = await mod.extractTypedSymbols(root, rel);
    if (!r.language) return null; // 不支持语言(提取器如实降级)
    const stream = mod.toSemanticTokens(r);
    if (!stream || stream.tokens.length === 0) return null;
    const truncated = stream.tokens.length > TOOL_TOKENS_MAX;
    return {
      language: stream.language,
      tokens: stream.tokens.slice(0, TOOL_TOKENS_MAX),
      ...(truncated ? { truncated: true } : {}),
    };
  } catch {
    return null; // dist 陈旧/模块缺失/解析失败=零事件零报错(优雅降级,不新增阻塞)
  }
}

/** 旁路调度(入串行队列,异常自吞);callId 缺席(单测直调 execute)=跳过。 */
export function scheduleToolTokens(
  journal: Journal,
  sessionId: string,
  callId: string | undefined,
  root: string,
  rel: string,
  mtimeMs: number): void {
  if (!callId || process.env.GENIE_PANEL_TOKENS === "off" || !TOKENIZED_EXT.test(rel)) return;
  toolTokensChain = toolTokensChain
    .then(async () => {
      const memoKey = root + "/" + rel;
      const hit = toolTokensMemo.get(memoKey);
      let payload = hit && hit.mtime === mtimeMs ? hit.payload : null;
      const memoMiss = !hit || hit.mtime !== mtimeMs;
      if (memoMiss) {
        payload = await computeToolTokens(root, rel);
        toolTokensMemo.set(memoKey, { mtime: mtimeMs, payload });
        while (toolTokensMemo.size > TOOL_TOKENS_MEMO_MAX) {
          const first = toolTokensMemo.keys().next().value as string | undefined;
          if (first === undefined) break;
          toolTokensMemo.delete(first);
        }
      }
      if (!payload) return;
      journal.append({
        kind: "tool.tokens",
        sessionId,
        payload: { toolCallId: callId, path: rel, ...payload },
      });
    })
    .catch(() => { /* 旁路遥测永不打断主链(fail-soft) */ });
}

const MAX_READ_BYTES = 120 * 1024;
const MAX_READ_LINES = 2000;
/** 单文件整读上限(超此值拒整读,先按 offset/limit 分窗)。 */
const MAX_READ_FILE_BYTES = 4 * 1024 * 1024;

/** code point 安全截断:末端恰落在代理对(surrogate pair)中间时回退一位。
 * 孤立高位代理经 JSON.stringify 输出 \ud83c 形态转义后,上游 LLM 的 JSON 解析器
 * (serde_json 系:DeepSeek/OpenAI)会报 "unexpected end of hex escape" 直接 400
 * (注意:grep content 行截断 .slice(0,200) 切在 🎙 U+1F399 中间)。 */
export function safeTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const c = text.charCodeAt(max - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}
const MAX_GREP_HITS = 60;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_GLOB_RESULTS = 200;
const MAX_WALK_FILES = 4000;
const MAX_WALK_DEPTH = 12;
/** 扫描跳过目录(与子代理工具面/文件索引对齐:依赖产物与元数据不入检索面)。 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".genie", ".zcode", ".agents", "ref", "devlog", "vendor", "coverage", ".next"]);

/** 上下文卫生尾注阈值:工具输出超过该字节数时提醒主 agent「该拆子任务派子代理」。 */
const CONTEXT_HYGIENE_BYTES = 6 * 1024;

/* ── edit_file 改后上下文快照( session 验证落地)────────────────────────
 * 经验证(journal 11-01→11-08):1,855 次同文件重复 read_file,其中 464 次=编辑后立刻回读
 * 验证——每次回读烧一轮完整 LLM 往返。编辑回执自带改动处上下文(±5 行带行号,read_file
 * 同格式),「改完看一眼」就地完成,无需回读。快照有硬上限(行数/单行/总量),不破上下文卫生。 */
const EDIT_SNIPPET_CONTEXT_LINES = 5;
const EDIT_SNIPPET_MAX_LINES = 40;
const EDIT_SNIPPET_MAX_BYTES = 4096;

/**
 * 构造 <edited> 快照块:定位替换点在最终文本(可能已被格式化)的首处位置,取其 ±5 行窗口。
 * 定位失败(格式化重排/多行替换被改写)时安静降级返回空串——快照是增强,不是承诺。
 * anchorPrefixLen=纯删除(newStr 空)时的锚:编辑点在最终文本中的字符偏移(前缀未变,可直接映射)。
 * 导出仅供单测锚漂移路径(审计 B1:格式化改写/短行降级/删除锚三路径直测)。
 */
export function editedSnippet(rel: string, finalText: string, newStr: string, occurrences: number, anchorPrefixLen = -1): string {
  let idx = newStr ? finalText.indexOf(newStr) : -1;
  if (idx < 0) {
    // 格式化改写了替换体:退而按首行(≥20 字符的行)做**空白归一化**行级比对——prettier 类格式化
    // 只动空白(加空格/缩进)时行内容归一后逐字相等,仍可锚到正确行;再退锚偏移,仍找不到就放弃。
    const firstLine = newStr.split("\n").find((l) => l.trim().length >= 20);
    if (firstLine) {
      const target = firstLine.trim().replace(/\s+/g, " ");
      const linesArr = finalText.split("\n");
      // startsWith:格式化常在行尾追加分号/逗号——归一后前缀命中即算锚定
      const li = linesArr.findIndex((l) => {
        const n = l.trim().replace(/\s+/g, " ");
        return n === target || n.startsWith(target);
      });
      if (li >= 0) idx = li === 0 ? 0 : linesArr.slice(0, li).join("\n").length + 1;
    }
  }
  if (idx < 0) idx = anchorPrefixLen;
  if (idx < 0) return "";
  const lines = finalText.split("\n");
  const startLine = finalText.slice(0, idx).split("\n").length; // 1-based
  const newLines = newStr ? newStr.split("\n").length : 1;
  const endLine = Math.min(startLine + newLines - 1, lines.length);
  // 尾部空行(尾 \n 与删除尾行产生的空元素)不进窗口:窗口上限收到最后非空行,但不低于 endLine。
  let lastNonEmpty = lines.length;
  while (lastNonEmpty > 1 && lines[lastNonEmpty - 1]!.trim() === "") lastNonEmpty -= 1;
  let from = Math.max(1, startLine - EDIT_SNIPPET_CONTEXT_LINES);
  let to = Math.min(Math.min(lines.length, endLine + EDIT_SNIPPET_CONTEXT_LINES), Math.max(lastNonEmpty, endLine));
  let truncatedNote = "";
  if (to - from + 1 > EDIT_SNIPPET_MAX_LINES) {
    to = Math.min(lines.length, from + EDIT_SNIPPET_MAX_LINES - 1);
    truncatedNote = `(窗口超 ${EDIT_SNIPPET_MAX_LINES} 行截断)`;
  }
  const rows: string[] = [];
  let bytes = 0;
  for (let i = from; i <= to; i++) {
    const row = String(i).padStart(6, " ") + "\t" + clampLine(lines[i - 1] ?? "");
    bytes += Buffer.byteLength(row) + 1;
    if (bytes > EDIT_SNIPPET_MAX_BYTES) { rows.push(`…(快照超 4KB 截断;完整内容用 read_file offset=${i})`); break; }
    rows.push(row);
  }
  if (!rows.length) return "";
  const multi = occurrences > 1 ? `(共 ${occurrences} 处,显示第 1 处)` : "";
  return `<edited path="${rel}" lines="${from}-${to}"${multi || truncatedNote ? " " + (multi + truncatedNote).trim() : ""}>\n${rows.join("\n")}\n</edited>`;
}

export interface FileToolsOptions {
  /** 围栏根(=任务项目根;所有路径参数相对它解析)。 */
  root: string;
  journal: Journal;
  sessionId: string;
  /** 编辑后 LSP 诊断/格式化配置(coding.lsp;缺省=关闭,低层单测不受影响)。 */
  lsp?: LspSettings;
 /** plan-gate:写类前置闸——返回非 null 即拒绝文本(agent-wiring 注入:
   * 本任务无规划板时硬拦,防「不经 planner 直接开写」绕过;planner 落板后自动放行)。 */
  planGate?: (tool: string) => string | null | Promise<string | null>;
 /** 视觉能力:mainHasVision=coding.llm.vision(缺省 true);false 时 view_image
 * 走 vlm 兜底(图转文字描述)。vlm 未配置=无法处理图片,如用户反馈错(不硬造能力)。 */
  vision?: {
    mainHasVision?: boolean;
    vlm?: { chat: (messages: { role: string; content: string; images?: string[] }[]) => Promise<{ content: string }> };
  };
 /** 大结果 dump 根(`.genie/tool-dumps`):result_read 按 callId/路径取回原文片段。
   * 不传=result_read 只能吃 dump 路径(仍可用,不报错)。 */
  toolDumpDir?: string;
 /** B:首次编辑某文件时给一次「本模块历史缺陷基因」提示(每任务每模块最多一次,
 * 由调用方闭包自己计数);返回非空串即追加到 edit_file 回执尾部。 */
  editHint?: (rel: string) => string | undefined;
}

/**
 * 路径围栏:相对路径 → 根内绝对地址;越界返回 null。
 * 三层:①绝对路径形态(POSIX / Windows 盘符)拒绝;②.. 段拒绝(解析前判,防解析后合法化);
 * ③resolve 后前缀复核 + 已存在路径 realpath 复核(符号链接逃逸封闭)。
 * 例外:permissionMode()==="auto"(完全访问)时围栏整体放开——resolve 后直接返回(绝对路径与 .. 越界
 * 均放行,跳过①②③);workspace/ask/readonly/plan 沿用上述校验逐字不变(workspace=只能碰项目目录内)。
 */
export async function fencePath(root: string, raw: unknown): Promise<string | null> {
  const p = typeof raw === "string" ? raw.trim() : "";
  if (!p) return null;
  const rootAbs = resolve(root);
  if (permissionMode() === "auto") return resolve(rootAbs, p); // auto=完全访问:围栏放开
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(p)) return null;
  if (p.split(/[\\/]/).includes("..")) return null;
  const abs = resolve(rootAbs, p);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
 // 复核走真实路径(异步化:existsSync 爬升+realpathSync×2 是同步地雷——auto 模式
  // 幸免,但 ask/workspace 模式每个文件工具都走;9p 停顿/单 op 楔死会把 worker 主循环整个冻住,
  // 11-01 冻结收割后彻底清零:fs/promises 化,停顿只挂起本工具的 Promise,心跳保持活着)
  try {
    let probe = abs;
    while (!(await fspStatOk(probe))) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const real = await fsp.realpath(probe);
    const realRoot = await fsp.realpath(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  } catch {
    return null; // 复核失败按越界处理(fail-closed)
  }
  return abs;
}

/** 存在性探测(fsp.access 封装;fencePath 爬升用)。 */
async function fspStatOk(pPath: string): Promise<boolean> {
  try { await fsp.access(pPath); return true; } catch { return false; }
}

/**
 * 命令围栏(workspace=工作区内):对 shell/终端**命令文本**做轻量启发式校验,返回拒因或 null(放行)。
 * 口径与 fencePath 对齐:
 * - 唯一 early-return:permissionMode()!=="workspace" → 立即 null(auto/ask/readonly/plan 四档零回归;
 *   auto=完全访问,ask/readonly/plan 的命令执行仍由既有权限闸门/审批链负责,本函数不介入)。
 * - workspace 下:按空白/; / && / || / | / 换行切 token(**不解析引号嵌套**),逐 token 判:
 *   ①绝对路径形态(/、\、C:\ 开头)且不在 root 内 → 拒;②含 .. 段且 resolve 后越出 root → 拒。
 * - 纯文本启发式的固有上限(如实登记,不假装封死):`cd /` 后相对路径逃逸、`$()`/反引号命令替换、
 *   `bash script.sh` 脚本内部跳转、`node -e` 等解释器内的任意路径拼接都不在文本校验范围。
 *   本函数只挡「命令文本里直接写出项目外绝对路径/越界 .. 段」这类显式形态。
 */
export function fenceCommand(cmd: string, root: string): string | null {
  if (permissionMode() !== "workspace") return null; // 唯一 early-return:四档零回归
  const text = String(cmd ?? "");
  if (!text.trim()) return null;
  const rootAbs = resolve(root);
  const inside = (abs: string): boolean => abs === rootAbs || abs.startsWith(rootAbs + sep);
  for (const { word, prose } of splitCommandWords(text)) {
    const token = word.replace(/^\d*[<>]+/, "").trim(); // 重定向前缀(`2>`/`>>`)不是路径的一部分
    if (!token || prose) continue; // 引号内含空白=散文(提交说明/echo 文案),不当路径判
    if (CMD_SAFE_DEV.has(token.toLowerCase())) continue; // /dev/null 等 I/O 黑洞不算越权
    if (token.startsWith("/") || token.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(token)) {
      if (!inside(resolve(token))) return `命令含项目外绝对路径:${token}`;
      continue;
    }
    if (token.split(/[\\/]+/).includes("..") && !inside(resolve(rootAbs, token))) {
      return `命令含越出项目目录的上级路径:${token}`;
    }
  }
  return null;
}

/** workspace 命令围栏豁免的系统设备路径:纯 I/O 黑洞,不构成越权(`cmd 2>/dev/null` 是 shell 日常写法)。 */
const CMD_SAFE_DEV = new Set(["/dev/null", "/dev/zero", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "con"]);

/**
 * 命令分词:引号内空白不切(引号串=一个 shell 词),并标记「散文」串。
 * 散文 = 带引号且内含空白,如 `git commit -m "fix: 参考 /tmp/x 的日志"`、`echo "见 /etc/hosts"`——
 * 这类是说明文字不是路径参数,按路径拦会大面积误伤(经验证 workspace 下提交说明常含路径)。
 * 代价:`bash -c "cat /etc/hostname"` 这类引号包裹的完整命令也不判(与 `$()`/反引号/脚本内跳转
 * 同属解释器级能力边界,已在 fenceCommand 头注登记)。
 */
function splitCommandWords(text: string): { word: string; prose: boolean }[] {
  const out: { word: string; prose: boolean }[] = [];
  let cur = "";
  let quote = "";
  let quoted = false;
  const flush = (): void => {
    if (cur) out.push({ word: cur, prose: quoted && /\s/.test(cur) });
    cur = "";
    quoted = false;
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (/[\s;|&\r\n]/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/** 文本文件启发(file 命令不可用,扩展名+空字节双判):二进制读出来是乱码,拒读。 */
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|cs|sh|bash|zsh|yaml|yml|toml|ini|cfg|conf|env|html|htm|css|scss|less|vue|svelte|sql|graphql|proto|xml|svg|csv|log|lock|ipynb|gitignore|editorconfig|dockerfile)$/i;

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.length, 8000));
  return probe.includes(0);
}

/** 相对路径展示(工具结果里统一用 / 分隔的根内相对路径,模型可拿去复用为路径参数)。 */
function relDisplay(root: string, abs: string): string {
  const r = relative(resolve(root), abs).split(sep).join("/");
  return r || ".";
}

/** 二进制分级指路(对齐 ZCode Read 的类型面:pdf/office/视频各有诚实出口)。
 * 在整读之前用 head 探测复用本函数(④binary 先于 ⑤read)。 */
function binaryRejection(root: string, abs: string): string {
  const lext = (/\.([a-z0-9]+)$/i.exec(abs)?.[1] ?? "").toLowerCase();
  const rel = relDisplay(root, abs);
  if (lext === "pdf") return "错误:PDF 是二进制,read_file 不读:" + rel + "。可选:① 转 PDF 页面截图(png)后 view_image(多模态);② pdftotext 转出 .txt 后再读";
  if (lext === "docx" || lext === "pptx" || lext === "xlsx" || lext === "doc" || lext === "ppt" || lext === "xls")
    return "错误:Office 文档(" + lext + ")是二进制:" + rel + "。可选:转 pdf/文本后读,或转页面截图后 view_image(多模态)";
  if (["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(lext))
    return "错误:视频(" + lext + ")模型不接收:" + rel + "。转关键帧截图(png)后 view_image 查看";
  return "错误:疑似二进制文件,拒绝读取: " + rel;
}

/** 只读前缀字节(二进制探测用):不把大文件整个读进内存,也不阻塞在特殊文件上(已在 guard 拦截)。 */
async function readHead(abs: string, n: number): Promise<Buffer> {
  return readHeadBytes(abs, n);
}

/** 目录树递归收集文本/代码文件(跳过 SKIP_DIRS 与隐藏目录;深度/数量双上限;异步形态)。 */
async function walkFiles(dir: string, out: string[], depth = 0): Promise<void> {
  if (out.length >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
  let entries: string[];
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = await statOrNull(full);
    if (!st) continue;
    if (st.isDirectory()) await walkFiles(full, out, depth + 1);
    else out.push(full);
    if (out.length >= MAX_WALK_FILES) return;
  }
}

/** glob 段 → 正则片段(* 不跨目录,** 跨目录,? 单字符;先行转义字面特殊字符)。 */
function globSegmentSrc(seg: string): string {
  return seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§GS§")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/§GS§/g, "(?:.*/)?");
}

/** glob 模式 → 正则。{a,b} 枚举先按层展开再逐段转义(不支持嵌套花括号,不支持项内跨目录)。 */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split(/\{([^{}]+)\}/); // 偶数位=字面段,奇数位=枚举体
  let re = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) re += "(?:" + parts[i]!.split(",").map(globSegmentSrc).join("|") + ")";
    else re += globSegmentSrc(parts[i]!);
  }
  return new RegExp("^" + re + "$");
}

function globMatcher(pattern: string): (rel: string, base: string) => boolean {
  const pats = pattern.includes("{")
    ? (function expand(p: string): string[] {
        const m = p.match(/\{([^{}]+)\}/);
        if (!m || m.index === undefined || !m[1]) return [p];
        return m[1].split(",").flatMap((alt) => expand(p.slice(0, m.index!) + alt + p.slice(m.index! + m[0].length)));
      })(pattern)
    : [pattern];
  const res = pats.map(globToRegExp);
  const bare = !pattern.includes("/");
  return (rel, base) => res.some((re) => re.test(rel) || (bare && re.test(base)));
}

/** 编辑保鲜读侧表( ReadFileState 语义):path → 本会话读到的 mtime。 */
export type ReadState = Map<string, number>;

/** 写类统一前置闸:①readonly/plan 模式拒绝(journal 落账);②plan-gate 规划板在场检查
 * (无板硬拦,由 agent-wiring 注入;落 journal 与其它闸门事件同形,回放可审计)。 */
async function writeDeniedByMode(tool: string, opts: FileToolsOptions): Promise<string | null> {
  const mode = permissionMode();
  if (mode === "readonly" || mode === "plan") {
    opts.journal.append({ kind: "permission.gate", sessionId: opts.sessionId, payload: { tool, effect: "denied", by: "mode-" + mode } });
    return `错误:${tool} 是写类工具,当前权限模式为 ${mode === "readonly" ? "只读" : "规划"}——不允许修改文件。可让用户切换权限模式,或把改动建议写进回复。`;
  }
  if (opts.planGate) {
    const blocked = await opts.planGate(tool);
    if (blocked) return blocked;
  }
  return null;
}

/**
 * 主 agent 文件工具六件套(同一任务共享编辑保鲜读侧表)。
 * root=任务项目根(围栏根);write/edit 的权限类别名=file.write(loop 别名表挂接)。
 */
export function createFileTools(opts: FileToolsOptions): Tool[] {
  const readState: ReadState = new Map();
  const root = resolve(opts.root);
  warmLspChecker(opts.lsp);

  const readTool: Tool = {
    name: "read_file",
    description:
      "读取项目内一个文本文件,返回带行号的内容(行号用于后续 edit_file 定位)。" +
      "路径必须是项目相对路径(绝对路径与 .. 上跳会被拒绝)。大文件用 offset(1-based 起始行)/limit(行数,缺省与上限 " + MAX_READ_LINES + ")分窗读;" +
      "超长行截断,输出总量上限 120KB。二进制文件拒绝读取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径(项目相对路径)。同时要看多个文件(或多个区间)时,在同一步并发发多条 read_file(本工具无状态、isConcurrencySafe=true),别一步只读一个文件——每次往返都会把整段上下文重发一遍" },
        offset: { type: "number", description: "起始行号(1-based)。只在文件过大需要分窗读时提供" },
        limit: { type: "number", description: "读取行数(缺省 " + MAX_READ_LINES + ")" },
        force: { type: "boolean", description: "文件未变且该行段已在上下文时,用于强制重新注入正文(缺省省略重复读取、只回短提示)" },
      },
      required: ["path"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown, signal?: AbortSignal, ctx?: { callId: string }) {
      const a = (args ?? {}) as { path?: string; offset?: number; limit?: number; force?: boolean };
      const abs = await fencePath(root, a.path);
      if (!abs) return `错误:路径非法或越出项目根(${String(a.path ?? "")});只接受项目内相对路径`;
 // 输入边界防御:realpath 归一 → ①设备/伪文件系统 → ②stat special → ③denylist。
      // 必须在任何读之前(读 /dev/zero 会挂死、FIFO 永久阻塞、/proc/<pid>/environ 泄密)。
      const guard = await readGuardPath(abs);
      if (!guard.ok) return guard.kind === "missing" ? "错误:文件不存在: " + relDisplay(root, abs) : guard.reason;
      const preSt = await statOrNull(abs);
      if (!preSt || !preSt.isFile()) return "错误:文件不存在: " + relDisplay(root, abs);
      // 先用 stat 大小拒超大,再做 ④binary 探测,最后 ⑤read(整读发生在全部判定之后)
      if (preSt.size > MAX_READ_FILE_BYTES) return `错误:文件过大(${Math.round(preSt.size / 1024)}KB),拒绝整读;用 grep 定位后按 offset/limit 分窗`;
      if (!TEXT_EXT.test(abs)) {
        const head = await readHead(abs, BINARY_PROBE_BYTES);
        if (looksBinary(head)) return binaryRejection(root, abs);
      }
      const buf = await fsp.readFile(abs);
 // 编辑保鲜读侧:记录读取时刻 mtime,write/edit 据此拒盲写
      let mtimeMs = 0;
      try { mtimeMs = (await statOrNull(abs))?.mtimeMs ?? 0; readState.set(abs, mtimeMs); } catch { /* 状态登记失败不阻塞读 */ }
      const lines = buf.toString("utf-8").split("\n");
      const offset = Math.max(Math.min(Number(a.offset) || 1, lines.length), 1);
      const limit = Math.min(Math.max(Number(a.limit) || MAX_READ_LINES, 1), MAX_READ_LINES);
      const winEnd = Math.min(offset + limit - 1, lines.length);
 // 重复读取去重:文件未变 + 该行段已在上下文 → 只回短提示,不重复注入正文。
      // 判定必须在注入前(否则刚登记的行段会自查自中);路径非法/不存在/过大/二进制分支已在前,
      // 首读(无登记)与 force=true 走原路径、返回文本逐字不变。
      const relForRead = relDisplay(root, abs);
      const force = a.force === true;
      try {
        // exactWindow=true:只有「与已登记窗口完全一致」的重读才省略——整读后再读子窗口仍注正文
        // (绝不吞模型点名要的行段;既有 file-tools 用例的行为零漂移)。
        const v = checkRepeatRead(opts.sessionId, relForRead, mtimeMs, offset, winEnd, true);
        if (v.duplicate && !force) {
          const rangeText = offset <= 1 && winEnd >= lines.length ? "全文" : `${offset}-${winEnd}`;
          return `[重复读取·已省略] ${relForRead} 自第 ${v.readCount} 次读取后未变,请求行段(${rangeText})已在上下文;要精确原文用 offset/limit 指定未覆盖窗口,或 force=true 重新注入`;
        }
      } catch { /* 提示层判定失败不阻塞读 */ }
 // 语义 token 旁路:成功读取才发射;fire-and-forget 不阻塞返回
      scheduleToolTokens(opts.journal, opts.sessionId, ctx?.callId, root, relForRead, mtimeMs);
 // 已读文件状态(「同文件读第二遍」机制层):per-session 登记相对路径+mtime+行段,
      // loop 每步组装消息时据此注入已读清单提醒(ephemeral);行段=本次真实窗口,供读传递
 // ( D3:主 agent 已读片段下发给子代理,17.5% 跨 agent 重叠治理)。登记失败不阻塞读。
      try { recordFileRead(opts.sessionId, relForRead, mtimeMs, Date.now(), [{ off: offset, end: winEnd }]); } catch { /* 提示层登记失败不阻塞读 */ }
      const window: string[] = [];
      let bytes = 0;
      for (let i = offset; i <= Math.min(offset + limit - 1, lines.length); i++) {
        let text = lines[i - 1] ?? "";
 // 单行 clamp:超 2000 字符截断并附「…(+N 字符已截断)」,标记计入额度(总长 ≤2000)
        text = clampLine(text);
        const row = String(i).padStart(6, " ") + "\t" + text;
        bytes += Buffer.byteLength(row) + 1;
        if (bytes > MAX_READ_BYTES) { window.push("…(输出总量超 " + Math.round(MAX_READ_BYTES / 1024) + "KB 截断;用 offset=" + i + " 继续读)"); break; }
        window.push(row);
      }
      const more = offset + window.length - 1 < lines.length;
      return (window.join("\n") || "(空文件或窗口为空)") + (more ? `\n(共 ${lines.length} 行,当前读到第 ${offset + window.length - 1} 行;继续读用 offset=${offset + window.length})` : "");
    },
  };

  const writeTool: Tool = {
    name: "write_file",
    description:
      "把完整内容写入项目内一个文件(自动创建父目录)。路径必须是项目相对路径。" +
      "适合新建文件或整体重写;局部修改优先 edit_file。覆写已存在文件前必须先 read_file 它(防盲写覆盖);" +
      "文件在读取后被外部改动过时会被拒绝,重新 read_file 拿最新内容再写。" +
      "写入后若启用 LSP:先保存即格式化,再把类型/语法诊断以 <diagnostics file=…> 块附在结果后(无错不追加)。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径(项目相对路径)" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const denied = await writeDeniedByMode("write_file", opts);
      if (denied) return denied;
      const a = (args ?? {}) as { path?: string; content?: string };
      const abs = await fencePath(root, a.path);
      if (!abs) return `错误:路径非法或越出项目根(${String(a.path ?? "")});只接受项目内相对路径`;
      const content = String(a.content ?? "");
      let prevText: string | undefined = ""; // 新文件:基线为空
      let existed = false;
      const st = await statOrNull(abs);
      if (st) {
        existed = true;
        if (!st.isFile()) return "错误:目标路径是目录: " + relDisplay(root, abs);
        const seen = readState.get(abs);
        if (seen === undefined) return "错误:目标文件已存在但本会话未读过——先 read_file 它(防盲写覆盖;确认要整体重建时 read_file 一次即放行)。";
        if (st.mtimeMs !== seen) return "错误:目标文件在读取后被外部修改过(mtime 变化)——重新 read_file 拿最新内容再写。";
        try { prevText = await fsp.readFile(abs, "utf-8"); } catch { prevText = undefined; } // 读不到=baseline 如实不可用
      }
      try {
 // baseline 必须在落盘前采集(旧内容);采集失败标 unavailable,不阻塞写。
        const base = await editBaselineSafe(root, abs, prevText, opts.lsp);
        await fsp.mkdir(dirname(abs), { recursive: true });
        await fsp.writeFile(abs, content, "utf-8");
        const suffix = await editCheckSuffixSafe(root, abs, opts.lsp, base?.baseline, base?.baselineText);
        readState.set(abs, (await statOrNull(abs))?.mtimeMs ?? 0); // 格式化可能改写文件,mtime 以最终态为准
        return `${existed ? "已覆写" : "已创建"} ${relDisplay(root, abs)}(${Buffer.byteLength(content)} 字节)` + suffix;
      } catch (err) {
        return "错误:" + String(err).slice(0, 150);
      }
    },
  };

  const editTool: Tool = {
    name: "edit_file",
    description:
      "对项目内文件做精确字面替换编辑。old_string 必须与文件内容逐字一致(从 read_file 的行号输出里抄时去掉行号前缀);" +
      "缺省要求全文唯一命中,多命中会报错并列出命中数(用 replace_all 全替,或把 old_string 扩到含前后行使其唯一)。" +
      "new_string 与 old_string 相同=空操作,拒绝。编辑前先 read_file 该文件;刚写/刚编辑过可连续编辑。" +
      "编辑成功后回执自带**改后上下文快照**(<edited> 块:改动处±5行带行号,格式化后的最终内容)——「改完看一眼」就地完成,不要为验证再 read_file 同一文件;" +
      "另做保存格式化与 LSP 诊断,诊断以 <diagnostics file=…> 块附在结果后(无错不追加);" +
      "格式化可能改变空白/引号,连续编辑前若未找到 old_string,重新 read_file 取格式化后的原文。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径(项目相对路径)" },
        old_string: { type: "string", description: "要替换的原文(逐字精确;可为空串仅在文件为空时允许)" },
        new_string: { type: "string", description: "替换后的新文(空串=删除匹配)" },
        replace_all: { type: "boolean", description: "替换全部命中(缺省 false=必须唯一命中)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const denied = await writeDeniedByMode("edit_file", opts);
      if (denied) return denied;
      const a = (args ?? {}) as { path?: string; old_string?: string; new_string?: string; replace_all?: boolean };
      const abs = await fencePath(root, a.path);
      if (!abs) return `错误:路径非法或越出项目根(${String(a.path ?? "")});只接受项目内相对路径`;
      const oldStr = String(a.old_string ?? "");
      const newStr = String(a.new_string ?? "");
      if (!oldStr) return "错误:old_string 不能为空(新建文件用 write_file)";
      if (oldStr === newStr) return "错误:old_string 与 new_string 相同,是空操作";
 // 编辑比例守卫:new 为空或不足 old 一半、且删行 > 20 → 拒(防放宽匹配后静默删大段)
      const ratioDenied = checkEditRatio(oldStr, newStr);
      if (ratioDenied) return ratioDenied;
      const st0 = await statOrNull(abs);
      if (!st0 || !st0.isFile()) return "错误:文件不存在: " + relDisplay(root, abs);
      const cur = st0.mtimeMs;
      const seen = readState.get(abs);
 // 编辑保鲜:未读过拒编;外部改动拒编;刚写过(readState 为最新)可连续编辑
      if (seen === undefined || cur !== seen) {
        return seen === undefined
          ? "错误:编辑前必须先 read_file 该文件(防盲改)"
          : "错误:文件在读取后被外部修改过(mtime 变化)——重新 read_file 拿最新内容再编辑。";
      }
      let text: string;
      try { text = await fsp.readFile(abs, "utf-8"); } catch (err) { return "错误:" + String(err).slice(0, 150); }
      const occurrences = text.split(oldStr).length - 1;
      if (occurrences === 0) {
        const firstLine = safeTruncate(oldStr.split("\n")[0]!.trim(), 60);
        const near = text.split("\n").findIndex((l) => firstLine && l.includes(firstLine.slice(0, Math.min(firstLine.length, 20))));
        return "错误:old_string 在文件中未找到(逐字匹配,注意空白与换行)。" +
          (near >= 0 ? `疑似近似行在第 ${near + 1} 行:「${safeTruncate(text.split("\n")[near]!.trim(), 120)}」——重新 read_file 后按原文精确抄写。` : "重新 read_file 确认原文后再编辑。");
      }
      if (occurrences > 1 && a.replace_all !== true) {
        return `错误:old_string 命中 ${occurrences} 处,缺省只允许唯一命中。确认要全替时传 replace_all=true,或把 old_string 扩到含前后文使其唯一。`;
      }
        const replaced = a.replace_all === true ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      try {
 // baseline 必须在落盘前采集(旧内容 text);采集失败标 unavailable,不阻塞写。
        const base = await editBaselineSafe(root, abs, text, opts.lsp);
        await fsp.writeFile(abs, replaced, "utf-8");
        const suffix = await editCheckSuffixSafe(root, abs, opts.lsp, base?.baseline, base?.baselineText);
        readState.set(abs, (await statOrNull(abs))?.mtimeMs ?? 0); // 格式化可能改写文件,mtime 以最终态为准
        const n = a.replace_all === true ? occurrences : 1;
 // 改后上下文快照:从**最终盘上内容**取(格式化后的),消灭「改完回读验证」往返。
        // 纯删除(newStr 空)时锚=首个替换点的前缀长度(单处/replace_all 首处前缀逐字不变)。
        let snippet = "";
        try {
          const finalText = await fsp.readFile(abs, "utf-8");
          const anchor = text.indexOf(oldStr);
          snippet = editedSnippet(relDisplay(root, abs), finalText, newStr, n, anchor);
        } catch { /* 快照失败不影响编辑回执 */ }
 // B:首次改动某模块时把「该模块历史缺陷基因」注入回执(每任务每模块一次)。
        let hint = "";
        try { hint = opts.editHint ? String(opts.editHint(relDisplay(root, abs)) ?? "") : ""; } catch { hint = ""; }
        return `已编辑 ${relDisplay(root, abs)}:替换 ${n} 处(${text.length} → ${replaced.length} 字符)。` + (snippet ? "\n" + snippet : "") + suffix + (hint ? "\n" + hint : "");
      } catch (err) {
        return "错误:" + String(err).slice(0, 150);
      }
    },
  };

  const globTool: Tool = {
    name: "glob",
    description:
      "按模式匹配项目内文件路径,结果按修改时间新→旧排序(最近改动排前,上限 " + MAX_GLOB_RESULTS + " 条)。" +
      "模式相对项目根:* 匹配单层文件名字符(不跨目录),** 跨任意层目录,? 单字符,{a,b} 枚举。" +
      "示例:src/**/*.ts(源码)、*.md(根目录文档;不含 / 的模式同时匹配任意层级的文件名,如 ** 语义的便捷形态)。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式(如 src/**/*.ts、*.{json,md})" },
        path: { type: "string", description: "起始子目录(项目相对;缺省项目根)" },
      },
      required: ["pattern"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { pattern?: string; path?: string };
      const pattern = String(a.pattern ?? "").trim();
      if (!pattern) return "错误:pattern 必填";
      const base = a.path ? await fencePath(root, a.path) : root;
      if (!base) return `错误:path 非法或越出项目根(${String(a.path)})`;
      const files: string[] = [];
      await walkFiles(base, files);
      const match = globMatcher(pattern);
      const hits: { rel: string; mtime: number }[] = [];
      for (const f of files) {
        const rel = relDisplay(root, f);
        const baseDir = relDisplay(root, base);
        const relFromBase = baseDir === "." ? rel : rel.startsWith(baseDir + "/") ? rel.slice(baseDir.length + 1) : rel;
        if (match(relFromBase, rel.split("/").pop() ?? "")) {
          const st = await statOrNull(f);
          if (st) hits.push({ rel, mtime: st.mtimeMs }); // 条目消失容忍
        }
      }
 // 巨根零命中改进(注意:从工作区根 walk 时 4000 文件配额先被其它顶层目录耗尽,
      // 目标目录永远轮不到匹配,模型 glob 三连零命中后退化成 list_dir 爬目录)——命中 0 且 walk
      // 达上限时显式说明截断,不再裸「(零命中)」误导成「不存在」。
      if (hits.length === 0) {
        return files.length >= MAX_WALK_FILES
          ? `(零命中,但不可信:扫描在 ${MAX_WALK_FILES} 文件配额处被截断——配额可能先被其它顶层目录耗尽,目标文件未必被扫到。` +
            "请带目录前缀收窄 path 后重试(如先 list_dir 定位目标子目录再对它 glob),或改用 code_sense 查结构关系。)"
          : "(零命中)";
      }
      hits.sort((x, y) => y.mtime - x.mtime);
      return hits.slice(0, MAX_GLOB_RESULTS).map((h) => h.rel).join("\n") + (hits.length > MAX_GLOB_RESULTS ? `\n(共 ${hits.length} 条,只列前 ${MAX_GLOB_RESULTS};缩小 pattern 或 path)` : "");
    },
  };

  /**
 * grep 零命中的引导提示( token 轮 P2)。
 * 经验证驱动:24h 内 grep 被调 124 次、read_file 227 次,而 code_sense 只有 14 次;code_sense 硬失败
   * 率还高达 21.4%。也就是说「该用代码感知的地方,模型在用文本检索硬撞」——零命中回执正是最容易
   * 走偏的那一刻,旧口径只回一个裸 `(零命中)`(file-tools.ts 旧 :668),模型只能自己猜:
   * 是关键词写错?还是该换工具?于是常见退化是连撞 3~5 次不同关键词,或改用 read_file 整读。
   * 改法:零命中时按 **pattern 形态** 给定向建议,而不是笼统「请用 code_sense」——
   * ①标识符形态(`doThing`/`Class.method`/`parse_x`)= 典型「在找符号」,指向 code_sense;
   * ②自然语言/中文短语 = 典型「在找文案/日志」,本来就该 grep,只提示换关键词或收窄 path;
   * ③其它(含正则符号)= 提示两种路都试。
   * 只在零命中时出(命中路径零增加),不影响已成功的调用。
   */
  function grepZeroHint(pattern: string): string {
    const p = pattern.trim();
    // 标识符形态:纯 ASCII 且像代码名(驼峰/下划线/点分),且不是正则元字符主导
    const looksIdentifier = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(p) || /^[A-Za-z_$][\w$]*\(?$/.test(p);
    const hasCjk = /[\u4e00-\u9fff]/.test(p);
    if (looksIdentifier) {
      return `。「${p}」像代码标识符——用 code_sense 查它的定义/调用方/影响面比换关键词重撞更快(工具说明见 tool_view);若确认只是文本出现在非代码文件里,可加 glob 收窄重试。`;
    }
    if (hasCjk) {
      return `。中文短语零命中多是关键词不在本仓——先确认概念在仓里叫什么(如 list_dir 看目录命名),或收窄 path/glob 再试;查符号/调用关系可换 code_sense。`;
    }
    return `。可换更短的子串重试、或收窄 path/glob;若在查符号定义/调用关系,改用 code_sense 更准(文本检索会漏间接调用)。`;
  }

  const grepTool: Tool = {
    name: "grep",
    description:
      "在项目文本文件里做正则内容检索(纯文本场景专用)。output_mode=content(缺省,返回 文件:行号: 内容行)/" +
      "files_with_matches(只列文件)/count(每文件命中数)。可用 glob 参数过滤文件(如 *.ts)、-i 忽略大小写、" +
      "head_limit 限条数(缺省/上限 " + MAX_GREP_HITS + ")。适用:配置值/日志串/文案/命名形态不确定的模糊关键词。" +
      "不适用:查符号定义/调用关系/改动影响面/接口结构——这些用 code_sense(毫秒级/秒级,能拿到双向调用闭包与索引面;具体能力见 tool_view),grep 扫文件推断调用关系会漏间接调用与跨语言边。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "正则或字面关键词(非法正则自动降级为字面匹配)。多个关键词用 alternation 合并成一次检索(a|b|c,preferred over 分多次换关键词重撞——每次往返都会把整段上下文重发一遍);要扫多个不相关位置时同一步并发发多条 grep" },
        path: { type: "string", description: "检索起始文件或目录(项目相对;缺省项目根)" },
        glob: { type: "string", description: "文件名过滤模式(如 *.ts、*.{json,md})" },
        output_mode: { type: "string", description: "content|files_with_matches|count(缺省 content)" },
        "-i": { type: "boolean", description: "忽略大小写" },
        head_limit: { type: "number", description: "最大输出条数(缺省 " + MAX_GREP_HITS + ")" },
      },
      required: ["pattern"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { pattern?: string; path?: string; glob?: string; output_mode?: string; "-i"?: boolean; head_limit?: number };
      const raw = String(a.pattern ?? "");
      if (!raw) return "错误:pattern 必填";
      let re: RegExp;
      try { re = new RegExp(raw, a["-i"] ? "i" : ""); } catch {
        try { re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), a["-i"] ? "i" : ""); } catch { return "错误:pattern 非法正则"; }
      }
      const base = a.path ? await fencePath(root, a.path) : root;
      if (!base) return `错误:path 非法或越出项目根(${String(a.path)})`;
      const mode = a.output_mode === "files_with_matches" || a.output_mode === "count" ? a.output_mode : "content";
      const limit = Math.min(Math.max(Number(a.head_limit) || MAX_GREP_HITS, 1), MAX_GREP_HITS);
      const filter = a.glob ? globMatcher(String(a.glob)) : null;
      const baseSt = await statOrNull(base);
      const startIsFile = !!baseSt?.isFile();
      const files = startIsFile ? [base] : await (async () => { const o: string[] = []; await walkFiles(base, o); return o; })();
      const contentLines: string[] = [];
      const fileHits: string[] = [];
      const countHits: string[] = [];
      let truncated = false;
      for (const f of files) {
        const rel = relDisplay(root, f);
        if (filter && !filter(rel, rel.split("/").pop() ?? "")) continue;
        const st = await statOrNull(f);
        if (!st) continue;
        if (st.size > MAX_GREP_FILE_BYTES) continue;
        let text: string;
        try { text = await fsp.readFile(f, "utf-8"); } catch { continue; }
        if (looksBinary(Buffer.from(text.slice(0, 8000)))) continue;
        const ls = text.split("\n");
        let count = 0;
        for (let i = 0; i < ls.length; i++) {
          if (!re.test(ls[i]!)) continue;
          count++;
          if (mode === "content" && contentLines.length < limit) contentLines.push(`${rel}:${i + 1}: ${safeTruncate(ls[i]!.trim(), 200)}`);
          else if (contentLines.length >= limit && mode === "content") { truncated = true; break; }
        }
        if (count > 0) {
          if (mode === "files_with_matches") fileHits.push(rel);
          if (mode === "count") countHits.push(`${rel}: ${count}`);
          if (mode !== "content" && (fileHits.length >= limit || countHits.length >= limit)) { truncated = true; break; }
        }
        if (truncated) break; // content 模式到量:不再翻余下文件(大仓扫描面止损)
      }
      const rows = mode === "content" ? contentLines : mode === "files_with_matches" ? fileHits.slice(0, limit) : countHits.slice(0, limit);
      if (rows.length === 0) return `(零命中)${grepZeroHint(raw)}`;
      const body = rows.join("\n") + (truncated || rows.length >= limit ? `\n(已达上限 ${limit} 条${truncated ? ",结果被截断" : ""};收窄 pattern/path/glob 或加 head_limit 不生效时换更精确的关键词)` : "");
 // 上下文卫生:大输出进主上下文=后续每步 LLM 都背着冗余跑——
      // 尾注提醒主 agent 这类勘察/实施该拆子任务派子代理(其上下文独立)。六件套只挂主 agent,子代理不受扰。
      return Buffer.byteLength(body) > CONTEXT_HYGIENE_BYTES
        ? body + `\n[上下文卫生] 本次输出 ${Math.round(Buffer.byteLength(body) / 1024)}KB 已进入你的上下文——此类大输出勘察/实施建议拆成子任务派 spawn_subagent(子代理上下文独立,过程细节不污染主轨),你只收结论。`
        : body;
    },
  };

  const listDirTool: Tool = {
    name: "list_dir",
    description: "列出一个目录的直接子项([d] 目录/[f] 文件)。路径必须是项目相对路径。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径(项目相对;缺省项目根)" } },
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { path?: string };
      const abs = a.path ? await fencePath(root, a.path) : root;
      if (!abs) return `错误:路径非法或越出项目根(${String(a.path ?? "")})`;
      try {
        const names = await fsp.readdir(abs);
        const rows: string[] = [];
        for (const n of names) {
          const st = await statOrNull(join(abs, n));
          rows.push(st ? (st.isDirectory() ? "[d] " : "[f] ") + n : "    " + n);
        }
        return rows.join("\n") || "(空目录)";
      } catch (err) {
        return "错误:" + String(err).slice(0, 150);
      }
    },
  };

  /**
 * 查看图片(对齐 ZCode Read 工具 read-image 分支; 多图化):
   * paths 数组一次读多张(png/jpg/jpeg/gif/webp),单张 ≤2MB(与聊天窗贴图的视觉通道同限额,
   * agent-wiring VISION_MAX_BYTES)、一次 ≤4 张(对齐 VISION_MAX_IMAGES);失败张逐行报错不拖垮整批
   * (失败隔离,参考 zcode recoverable per-image error);返回视觉哨兵
   * [vision-image]{json} 由 loop 落账时转后置 user 消息注入(OpenAI 系 tool content 不支持图片)。
   * 修复背景:此前无任何主动读图通道(read_file 二进制拒读),模型只能用代码打印像素占位。
   */
  const viewImageTool: Tool = {
    name: "view_image",
    description:
      "查看项目内一张或多张图片(png/jpg/jpeg/gif/webp,单张≤2MB,一次≤4张):读图注入视觉通道,下一轮对话你直接看到图片内容。" +
      "任务涉及看图(截图/UI 对照/图表/设计稿/照片)时必须用本工具;禁止用代码读像素/打印 ASCII/只报尺寸来代替看图。" +
      "路径必须是项目相对路径,paths 数组一次列出全部想看的图片。svg(文本)用 read_file;超大图需先压缩到 2MB 内。",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "图片文件路径列表(项目相对路径,一次可给多张)" },
        force: { type: "boolean", description: "同一张图未变且已注入过时,用它强制重新注入视觉通道(缺省省略重复注入)" },
      },
      required: ["paths"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { paths?: unknown; force?: boolean };
      // 兼容层:旧调用习惯传单 path 字符串也接受(避免依赖该工具的历史提示词/脚本直接断掉)。
      const raw: unknown[] = Array.isArray(a.paths)
        ? a.paths
        : typeof (a as { path?: unknown }).path === "string"
          ? [(a as { path?: unknown }).path]
          : [];
      if (raw.length === 0) return "错误:paths 必须是非空数组(项目相对路径列表)";
      if (raw.length > 4) return "错误:一次最多 4 张(收到 " + raw.length + " 张);分多次调用,每次 ≤4 张";
      const extMime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
      const images: string[] = [];
      const labels: string[] = [];
      const rels: string[] = [];
      const errs: string[] = [];
      const skipped: string[] = [];
      const injected: Array<{ rel: string; mtimeMs: number }> = [];
      const force = a.force === true;
      // 逐张独立校验+读取:失败张只记错误行,不拖垮整批(zcode read-image 失败隔离语义)。
      for (const p of raw) {
        const abs = await fencePath(root, typeof p === "string" ? p : String(p));
        if (!abs) { errs.push("- " + String(p) + ": 路径非法或越出项目根;只接受项目内相对路径"); continue; }
        const st = await statOrNull(abs);
        if (!st || !st.isFile()) { errs.push("- " + relDisplay(root, abs) + ": 文件不存在"); continue; }
        const rel = relDisplay(root, abs);
        rels.push(rel);
        const ext = (/\.([a-z0-9]+)$/i.exec(abs.toLowerCase())?.[1] ?? "").toLowerCase();
        const mime = extMime[ext];
        if (!mime) { errs.push(`- ${rel}: 不支持的图片格式 .${ext || "(无扩展名)"};视觉通道只接受 png/jpg/jpeg/gif/webp(svg 是文本,用 read_file)`); continue; }
        const size = st.size;
        if (size > 2 * 1024 * 1024) { errs.push(`- ${rel}: ${Math.round((size / 1024 / 1024) * 10) / 10}MB 超过视觉通道 2MB 限额;先用图像工具压缩(如 80% 质量 jpg 或缩到 ≤2000px)再查看`); continue; }
 // 尺寸守卫:读取前 48KB 头字节解析像素,长边/总像素超模型上限即拒注入。
        // 修的是根因——超限 dataUrl 一旦进 payload.images 就落进 journal,derive 每轮重放 → 永久 400。
        // 解析失败(null)=放行:未知格式/头被截断不拦正常图(旧 2MB 上限仍在上一行)。
        let dims: ReturnType<typeof readImageSize> = null;
        try {
          const fd = await fsp.open(abs, "r");
          try {
            const head = Buffer.alloc(48 * 1024);
            const { bytesRead } = await fd.read(head, 0, head.length, 0);
            dims = readImageSize(head.subarray(0, bytesRead));
          } finally { await fd.close(); }
        } catch { /* 读头失败=按解析失败放行(不因守卫自身故障拦图) */ }
        const verdict = checkImageSize(dims, rel);
        if (!verdict.ok) { errs.push("- " + verdict.reason); continue; } // 不 push dataUrl → 不进 payload.images
 // 重复读取去重:同图未变且已注入过视觉通道 → 不再花视觉/VLM token 重注。
        if (!force) {
          try {
            if (checkImageInjected(opts.sessionId, rel, st.mtimeMs).seen) {
              skipped.push(`[已看过·未重复注入] ${rel}(mtime 未变;要重看用 force=true)`);
              continue;
            }
          } catch { /* 判定失败不阻塞注入 */ }
        }
        const b64 = (await fsp.readFile(abs)).toString("base64");
        images.push(`data:${mime};base64,${b64}`);
        labels.push(`${rel}(${mime},${Math.round(size / 1024)}KB)`);
        injected.push({ rel, mtimeMs: st.mtimeMs });
      }
      const skipText = skipped.join("\n");
      if (images.length === 0) {
        // 一批全被跳过 → 纯文本回执(不返回视觉哨兵,不重花 token)。
        if (skipped.length > 0) return skipText + (errs.length ? "\n" + errs.join("\n") : "");
        return "错误:没有一张图片读取成功:\n" + errs.join("\n");
      }
      const errSuffix = errs.length ? ";失败:" + errs.join(";") : "";
      /** 注入成功才登记 mtime(失败/报错下次仍可重试)。 */
      const markInjected = () => { for (const it of injected) { try { recordImageInjected(opts.sessionId, it.rel, it.mtimeMs); } catch { /* 台账失败不阻塞 */ } } };
 // 无视觉主模型 → VLM 兜底(不支持图像的模型用 vlm 提供识别,
      // 没有就不能处理图片):图转文字描述作为工具结果返回,图像不进主模型上下文。
      // 去重判定在上面的逐张循环里先做(被跳过的图不进 images,不重复花 VLM token)。
      if (opts.vision?.mainHasVision === false) {
        if (!opts.vision.vlm) {
          return "错误:当前主模型无视觉能力(coding.llm.vision=false),且同一 provider 未配置视觉兜底模型(coding.vlm.model),无法处理图片:" + rels.join("、") + errSuffix + "。请告知用户:本环境的 provider 未提供可用的图像识别模型,处理图片需在配置中指定(coding.vlm.model)。";
        }
        try {
          const r = await opts.vision.vlm.chat([
            {
              role: "user",
              content: "详细描述这些图片的全部可见内容(界面布局/文字/数据/颜色/物体/关系),供代码助手后续工作使用。按图片顺序逐张描述,按要点分行,忠实描述所见,不臆造图中没有的内容。",
              images,
            },
          ]);
          const desc = (r?.content ?? "").trim();
          if (!desc) return "错误:视觉兜底模型返回空描述(" + rels.join("、") + ")" + errSuffix;
          markInjected();
          return "[VLM 图像描述 " + rels.join("、") + "]" + errSuffix + "\n" + desc + (skipText ? "\n" + skipText : "");
        } catch (err) {
          return "错误:视觉兜底模型调用失败(" + rels.join("、") + "):" + String(err).slice(0, 200);
        }
      }
      const payload: { images: string[]; label: string; errors?: string[]; note?: string[] } = { images, label: labels.join("、") };
      if (errs.length) payload.errors = errs;
      if (skipped.length) payload.note = skipped;
      markInjected();
      return VISION_TOOL_SENTINEL + JSON.stringify(payload);
    },
  };

 // 大结果取回:上下文里只看得到「选块/摘要 + 全文已落盘:<path>」,细节靠本工具回原文。
  // 行号沿用原文(dump 逐字节等于原结果),与 read_file 的 `行号|内容` 同形。
  const resultReadTool: Tool = {
    name: "result_read",
    description:
      "取回被「大结果闸门」摘要过的工具结果全文片段。上下文里出现「全文已落盘:<路径>(N 行)」时用它:" +
      "ref 给 callId(如 call_00_xxx)或 dump 路径;offset/limit 按行段读(1-based,缺省 200 行)," +
      "grep 按关键词/正则取命中行(带原文行号)。dump 是原始工具输出的逐字节副本,行号即原文行号——需要细节就精确取,别凭摘要猜。",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "callId(如 call_00_abc)或 dump 文件路径(绝对路径或仓内相对路径)" },
        offset: { type: "number", description: "起始行号(1-based,缺省 1)" },
        limit: { type: "number", description: "读取行数(缺省 200)" },
        grep: { type: "string", description: "关键词或正则:只返回命中行(带原文行号)" },
      },
      required: ["ref"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { ref?: string; offset?: number; limit?: number; grep?: string };
      const res = readToolDump(
        {
          ref: String(a.ref ?? ""),
          ...(a.offset !== undefined ? { offset: Number(a.offset) } : {}),
          ...(a.limit !== undefined ? { limit: Number(a.limit) } : {}),
          ...(a.grep ? { grep: String(a.grep) } : {}),
        },
        { ...(opts.toolDumpDir ? { dumpDir: opts.toolDumpDir } : {}) },
      );
      return res.ok ? res.text : `错误:${res.error}`;
    },
  };

  return [readTool, writeTool, editTool, globTool, grepTool, listDirTool, viewImageTool, resultReadTool];
}
