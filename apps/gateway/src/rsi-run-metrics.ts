/**
 * RSI 单次运行的成本与「分析了哪些会话」抽取( RSI-SESSION-COST)。
 * 输入是**该机制任务自己的 journal 事件窗口**,不是整个会话:RSI 固定会话窗里多次运行事件交错,
 * 不按 taskId 切窗口就会把上一轮的 token 算到这一轮头上(假账比没账更坏)。
 * 口径真源:
 * - usage 只认 `llm.trace` 事件的 payload.usage(provider 上报值),不本地估算;
 * - 金额由 core 的 computeCost / resolveModelPrice 算(单价缺失 → null + missing,绝不按 0 冒充);
 * - 「已分析了哪些会话」只认 agent 最终回复里那一行 `已分析会话: <sid>, <sid>`(brief 硬要求),
 * 且调用方还要拿候选名单交叉过滤(agent 写错 id 不算数)。
 */
export interface RsiRunEvent {
  kind?: unknown;
  payload?: unknown;
  seq?: unknown;
  time?: unknown;
  sessionId?: unknown;
}

/** LLM 用量汇总(单位:token;calls=llm.trace 事件数)。 */
export interface RsiRunUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
 /** 输入总量 + 输出(输入已含缓存命中/写入,见 model-cost.ts 口径)。 */
  totalTokens: number;
  calls: number;
 /** 窗口内最后一次 llm.trace 上报的模型名(缺=provider 未暴露)。 */
  model?: string;
}

function payloadOf(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const payload = (event as { payload?: unknown }).payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function kindOf(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "";
}

function tokenOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * 切出某个任务的 journal 事件窗口:`task.start(payload.id=taskId)` 起,到
 * `task.done|task.fail(payload.id=taskId)` 止(end 事件不计入)。
 * 交错保护:窗口内出现**另一个任务的 task.start** 时立即——同一 RSI 会话里多任务交错时,
 * 后到任务的 token 不会串进本任务。
 * 找不到该任务的 task.start(例如 journal 已轮转)→ 空窗口(不猜一段事件当成本)。
 */
export function taskWindowOf(events: readonly unknown[], taskId: string): RsiRunEvent[] {
  const id = typeof taskId === "string" ? taskId.trim() : "";
  if (id === "" || !Array.isArray(events)) return [];
  let start = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (kindOf(events[i]) !== "task.start") continue;
    if (stringOf(payloadOf(events[i])?.id) === id) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out: RsiRunEvent[] = [];
  for (let i = start; i < events.length; i += 1) {
    const event = events[i]!;
    const kind = kindOf(event);
    const eventId = stringOf(payloadOf(event)?.id);
    if (i > start) {
      if ((kind === "task.done" || kind === "task.fail") && eventId === id) break;
      if (kind === "task.start" && eventId !== undefined && eventId !== id) break;
    }
    out.push(event as RsiRunEvent);
  }
  return out;
}

/**
 * 窗口内 llm.trace 的 usage 求和 + 调用次数 + 最后一个模型名。
 * 没有 llm.trace(任务排队/派发失败)→ 全 0、calls=0、无 model(调用方据此判「没有可算的用量」)。
 */
export function usageOfWindow(events: readonly unknown[]): RsiRunUsage {
  const usage: RsiRunUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    calls: 0,
  };
  if (!Array.isArray(events)) return usage;
  for (const event of events) {
    if (kindOf(event) !== "llm.trace") continue;
    usage.calls += 1;
    const payload = payloadOf(event);
    const model = stringOf(payload?.model);
    if (model !== undefined) usage.model = model;
    const raw = payload?.usage;
    if (typeof raw !== "object" || raw === null) continue;
    const u = raw as Record<string, unknown>;
    usage.inputTokens += tokenOf(u.inputTokens);
    usage.cachedTokens += tokenOf(u.cachedTokens);
    usage.cacheCreationTokens += tokenOf(u.cacheCreationTokens);
    usage.outputTokens += tokenOf(u.outputTokens);
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

/** 窗口内最后一条 `message.agent` 的文本(agent 最终回复;没有 → "")。 */
export function finalAgentText(events: readonly unknown[]): string {
  if (!Array.isArray(events)) return "";
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (kindOf(events[i]) !== "message.agent") continue;
    const text = payloadOf(events[i])?.text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** 「已分析会话」行的标记(brief 里逐字要求 agent 写这一行;容忍 markdown 的 `**已分析会话**:`)。 */
const ANALYZED_MARKER = /已分析会话\s*\**\s*[:：]/;

/** sessionId 的可接受形状:非空、无标点噪声、不含中文(sessionId 只由字母数字与 ._-:@ 组成)。 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/**
 * 解析 agent 最终回复里的 `已分析会话: sid1, sid2` 行(取**最后**一条含标记的行:最终回复在末尾)。
 * 宽容度:逗号(中英)、顿号、分号、空白都当分隔;markdown 反引号/粗体符号先剥掉;
 * `已分析会话: (无)` / `（无）` / `无` → 空数组。
 * 严格度:只收形如 sessionId 的 token(拒绝「无」「(无)」「3 个」这类词),重复去重、保序。
 */
export function parseAnalyzedSessions(text: string): string[] {
  const raw = typeof text === "string" ? text : "";
  if (raw.trim() === "") return [];
  const lines = raw.split(/\r?\n/);
  let rest: string | undefined;
  for (const line of lines) {
    const marker = ANALYZED_MARKER.exec(line);
    if (marker === null) continue;
    rest = line.slice(marker.index + marker[0].length);
  }
  if (rest === undefined) return [];
  const cleaned = rest.replace(/[`*_~>]/g, " ").trim();
  if (cleaned === "") return [];
  if (/^[(（\[\s]*无[\s)）\]]*[。.]?$/.test(cleaned)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of cleaned.split(/[,，、;；\s]+/)) {
    const id = token.replace(/[。.．]+$/, "").trim();
    if (id === "" || id === "无") continue;
    if (!SESSION_ID_SHAPE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
