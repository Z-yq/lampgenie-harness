/**
 * 错误路径定向剪枝(用户设想补全):LLM 决策过程中发现之前的某条路径错了,
 * 触发对该路径积累上下文的定向压缩——错误路径的大块工具输出折叠成占位,教训(为什么错)
 * 以一条系统提醒留在声明点上,上下文还给正确路径。
 * 与既有剪枝的分工(为什么这是缺的那块):
 * - microcompact/autoCompact/model-scoring 全部是**尺寸/年龄/评分**驱动(大、旧、低分才剪);
 * - microcompact Phase 0 甚至**硬保护错误结果**(错误日志是诊断线索)——在「尚未认定」时正确,
 * 但 agent 已判定路径错误后,这些大块原文变成死重:既耗预算又持续干扰注意力;
 * - 本机制是**认知驱动**:agent 的「此路不通」结论才是剪枝依据,与 negative-knowledge 同源
 * (教训可登记 negkb,「此路不通|原因|替代」跨会话复用)。
 * 实现语义(与 session.truncate 同范式的 journal 事件):
 * - 声明 = 一条 custom 事件 `context.path.abandoned`{reason, lesson?, tools?, keywords?, keepRecent?};
 * - deriveMessages 重放时,seq < 声明 seq 且命中选择器的 tool.result 内容替换为占位
 * (journal 原文不动——审计/回放/面板照旧可查全量);
 * - 教训在声明点位注入一条 [系统提醒](时间线保留「何时意识到错了」这个地标);
 * - 保护:edit_file/write_file 回执(不可逆动作历史)永不折;声明前最近 keepRecent(缺省 3)
 * 个工具结果不折(模型刚看过,立即失忆比留着重);
 * - 稳定性:事件恒在 → 每步重放形态一致,无锯齿;声明时一次性破前缀(受控,同 truncate)。
 */

/** journal custom 事件类型标记(与 session.truncate 的 payload.type 同风格)。 */
export const PATH_ABANDONED_TYPE = "context.path.abandoned";

/** 不可逆动作:回执是「动作历史」不是可重读内容——硬保护,与 microcompact IRREVERSIBLE_TOOLS 同源。 */
export const PATH_PRUNE_IRREVERSIBLE_TOOLS = new Set(["edit_file", "write_file"]);

/** 占位里保留的原文头部字符数(与 HEAD 相比刻意小:占位的目的指路不是保内容)。 */
export const ABANDONED_PLACEHOLDER_HEAD_CHARS = 200;

/* ------------------------------------------------------------------ *
 * 缺口#15/§4.8.7 成败分档:失败压狠(结论+锚点,原文头可至 0)/
 * 成功留细节(head/tail + 寻址)。判定复用 microcompact 的 looksLikeErrorResult
 * 同族特征(不 import,防两模块耦合;特征表保持保守:命中即失败档)。
 * ------------------------------------------------------------------ */
const FAILURE_MARKERS: readonly RegExp[] = [
  /error/i, /\bfail(ed|ure)?\b/i, /\bexit code [1-9]\d*\b/i, /command not found/i,
  /no such file or directory/i, /permission denied/i, /\btimeout\b/i, /ECONNREFUSED/, /ENOENT/,
];

/** 结果是否为失败形态(保守:命中任一特征即失败;误判=压狠一档,占位仍可寻址回读)。 */
export function isFailureResult(content: string): boolean {
  if (!content) return false;
  return FAILURE_MARKERS.some((re) => re.test(content));
}

/** 成功档保留的头/尾字符(§4.8.7「成功留细节」)。 */
export const SUCCESS_TIER_HEAD_CHARS = 400;
export const SUCCESS_TIER_TAIL_CHARS = 200;

/** 一次声明的分档计数(落 journal stats,审计「两档各折了多少」)。 */
export interface OutcomeTiers { failure: number; success: number }

/** 折叠占位 v1.2(成败分档):失败=一行结论+锚点(原文头 0);成功=head+tail+寻址。 */
export function renderAbandonedPlaceholderTiered(
  d: PathAbandonedDeclaration, toolCallId: string, originalContent: string,
): { text: string; tier: "failure" | "success" } {
  if (isFailureResult(originalContent)) {
    const firstErrLine = originalContent.split("\n").find((l) => l.trim() !== "" && FAILURE_MARKERS.some((re) => re.test(l)));
    const err = (firstErrLine ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      tier: "failure",
      text: [
        `[路径已放弃·失败已折叠](toolCallId=${toolCallId}) 原因:${d.reason}`,
        err !== "" ? `尝试失败:${err}` : "尝试失败(原文见 journal,可按 toolCallId 回查)",
        "此路不通已认定;不要沿此路径继续探索,细节按 toolCallId 重查。",
      ].join("\n"),
    };
  }
  const head = originalContent.slice(0, SUCCESS_TIER_HEAD_CHARS).replace(/\s+/g, " ").trim();
  const tail = originalContent.slice(-SUCCESS_TIER_TAIL_CHARS).replace(/\s+/g, " ").trim();
  return {
    tier: "success",
    text: [
      `[路径已放弃](toolCallId=${toolCallId}) 原因:${d.reason}`,
      head !== "" ? `原始输出(前 ${head.length} 字):${head}…已折叠` : "原始输出已折叠(内容为空)",
      tail !== "" ? `尾部(末 ${tail.length} 字):…${tail}` : "",
      "需要细节时按该调用的原参数重跑/重读;不要沿此路径继续探索。",
    ].filter((line) => line !== "").join("\n"),
  };
}

/** 声明前最近 N 个工具结果豁免(模型刚看过;0=不豁免,由声明方显式选择)。 */
export const DEFAULT_PATH_PRUNE_KEEP_RECENT = 3;

/** 声明载荷(derive 侧宽松读:坏字段缺省兜底,坏声明整条跳过——永不 throw)。 */
export interface PathAbandonedPayload {
  reason: string;
  lesson?: string;
  tools?: string[];
  keywords?: string[];
  keepRecent?: number;
 /** 起始锚点( v1.1):只折 seq ∈ [fromSeq, 声明seq) 的结果。 */
  fromSeq?: number;
}

/** 归一化后的声明。 */
export interface PathAbandonedDeclaration {
 /** 声明事件自身 seq:只折 seq 小于它的结果(声明后的新内容永不受旧声明影响)。 */
  seq: number;
  reason: string;
  lesson: string;
  tools: Set<string>;
  keywords: string[];
  keepRecent: number;
 /** 起始锚点:undefined = 不设下界(全会话命中即折)。 */
  fromSeq?: number;
}

/** 一次 tool 调用的已知信息(从 tool.call 事件取;结果内容匹配时并入)。 */
export interface ToolCallInfo {
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArrayOf(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())
    .slice(0, cap);
}

/** 事件流 → 声明列表(宽松:reason 空白/选择器全空/形状坏的声明整条丢弃,不冒充成功)。 */
export function collectPathAbandons(
  events: Array<{ seq: number; sessionId?: string; kind?: string; payload?: unknown }>,
  sessionId: string,
): PathAbandonedDeclaration[] {
  const out: PathAbandonedDeclaration[] = [];
  for (const e of events) {
    if (e.sessionId !== sessionId || e.kind !== "custom") continue;
    const p = isRecord(e.payload) ? e.payload : undefined;
    if (p === undefined || p.type !== PATH_ABANDONED_TYPE) continue;
    const reason = textOf(p.reason).trim();
    if (reason === "") continue;
    const tools = stringArrayOf(p.tools, 12);
    const keywords = stringArrayOf(p.keywords, 12);
 // 选择器全空 = 无法界定「哪条路径」,丢弃(工具面会拦,这里防御性兜底)。
    if (tools.length === 0 && keywords.length === 0) continue;
    const keepRecentRaw = Number(p.keepRecent);
    const keepRecent = Number.isFinite(keepRecentRaw) && keepRecentRaw >= 0 && keepRecentRaw <= 20
      ? Math.floor(keepRecentRaw)
      : DEFAULT_PATH_PRUNE_KEEP_RECENT;
    const seq = Number(e.seq);
    if (!Number.isFinite(seq)) continue;
 // 起始锚点:正整数才生效(0/负数/NaN = 不设下界,与旧载荷兼容)。
    const fromSeqRaw = Number(p.fromSeq);
    const fromSeq = Number.isFinite(fromSeqRaw) && fromSeqRaw > 0 && Number.isInteger(fromSeqRaw)
      ? fromSeqRaw
      : undefined;
    out.push({
      seq,
      reason: reason.slice(0, 300),
      lesson: textOf(p.lesson).trim().slice(0, 400),
      tools: new Set(tools),
      keywords,
      keepRecent,
      ...(fromSeq !== undefined ? { fromSeq } : {}),
    });
  }
  return out;
}

/** 声明点位注入的教训提醒(时间线地标:「何时意识到错了」)。 */
export function renderAbandonedReminder(d: PathAbandonedDeclaration): string {
  const parts = [`[路径已放弃] ${d.reason}`];
  if (d.lesson !== "") parts.push(`教训:${d.lesson}`);
  parts.push("该路径此前的工具输出已折叠为占位(可按占位寻址重查),后续沿正确路径推进。");
  return `[系统提醒] ${parts.join(";")}`;
}

/** 折叠占位:原文头部 + 原因 + 寻址回查指引。 */
export function renderAbandonedPlaceholder(d: PathAbandonedDeclaration, toolCallId: string, originalContent: string): string {
  const head = originalContent.slice(0, ABANDONED_PLACEHOLDER_HEAD_CHARS).replace(/\s+/g, " ").trim();
  return [
    `[路径已放弃](toolCallId=${toolCallId}) 原因:${d.reason}`,
    head !== "" ? `原始输出(前 ${head.length} 字):${head}…已折叠` : "原始输出已折叠(内容为空)",
    "需要细节时按该调用的原参数重跑/重读;不要沿此路径继续探索。",
  ].join("\n");
}

/** 单条结果是否命中声明(工具名精确 + 关键词任意命中 name/args/内容头;两组都给=AND)。 */
export function matchesDeclaration(
  d: PathAbandonedDeclaration,
  info: ToolCallInfo | undefined,
  resultHead: string,
): boolean {
  const name = info?.name ?? "";
  if (d.tools.size > 0 && !d.tools.has(name)) return false;
  if (d.keywords.length > 0) {
    const haystack = `${name} ${info?.arguments ?? ""} ${resultHead}`.toLowerCase();
    if (!d.keywords.some((k) => haystack.includes(k.toLowerCase()))) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 线程分段( v1.1):「失败决策的起始点」不再靠 agent 猜 seq——
 * 把会话的工具结果按 (工具名, 目标) 归成**连续探索线程**,预览列出每段的
 * seq 区间/条数/字节,agent 选线程锚定(fromSeq/fromToolCallId)。
 * 只用于预览与建议,不参与匹配语义(匹配仍由声明字段决定)。
 * ------------------------------------------------------------------ */

/** 一段连续线程:同 (tool, target) 的相邻结果;被别的 target 打断即开新段。 */
export interface ToolThread {
  fromSeq: number;
  toSeq: number;
  tool: string;
  target: string;
  count: number;
  chars: number;
}

/** 从参数 JSON 里抽「操作目标」:path > command 首词 > symbol/query/target > 空。 */
export function targetOfArguments(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    for (const key of ["path", "file", "file_path", "target", "symbol", "query", "concept"]) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim().slice(0, 60);
    }
    const cmd = parsed.command;
    if (typeof cmd === "string" && cmd.trim() !== "") {
 // 命令取首个非 env 前缀词(docker-compose up → docker-compose;cd x && y → cd)。
      const words = cmd.trim().split(/\s+/).filter((w) => !w.includes("="));
      return (words[0] ?? cmd).slice(0, 60);
    }
  } catch {
 // 参数不是 JSON(terminal send 等自由文本):取首个词。
    const w = args.trim().split(/\s+/)[0];
    if (w !== undefined && w !== "") return w.slice(0, 60);
  }
  return "";
}

/**
 * 结果行 → 连续线程段:相邻两行 (tool,target) 相同则并入当前段,否则开新段。
 * 线程内允许目标为空串(同工具的自由探索归一段);跨段边界 = 工具或目标变化。
 */
export function segmentToolThreads(
  rows: Array<{ seq: number; name: string; args: string; content: string }>,
): ToolThread[] {
  const threads: ToolThread[] = [];
  for (const r of rows) {
    const target = targetOfArguments(r.args);
    const last = threads[threads.length - 1];
    if (last !== undefined && last.tool === r.name && last.target === target) {
      last.toSeq = r.seq;
      last.count += 1;
      last.chars += r.content.length;
    } else {
      threads.push({ fromSeq: r.seq, toSeq: r.seq, tool: r.name, target, count: 1, chars: r.content.length });
    }
  }
  return threads;
}

/** 线程段的一行预览文本(`#3 run_cmd+docker-compose: seq 41-87 ×5 · 12.3KB`)。 */
export function renderThreadLine(index: number, t: ToolThread): string {
  const label = `${t.tool || "(未知)"}${t.target !== "" ? `+${t.target}` : ""}`;
  const range = t.fromSeq === t.toSeq ? `seq ${t.fromSeq}` : `seq ${t.fromSeq}-${t.toSeq}`;
  const kb = (t.chars / 1024).toFixed(1);
  return `  #${index} ${label}: ${range} ×${t.count} · ${kb}KB(锚定用 fromSeq=${t.fromSeq})`;
}
