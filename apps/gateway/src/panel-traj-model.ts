/**
 * 会话轨迹纯函数建模层(panel 轨迹卡的数据面;零 DOM / 零 IO,可直接单测)。
 *
 * 事件形状(核准来源):
 *  - `{ seq, kind, time, sessionId, payload }` —— panel.ts:5604 `let histEvents = []`,
 *    增量入口 session.history.result(panel.ts:12665-12700)与 journal 落盘形状一致
 *    (packages/core src/journal/journal.ts:538 补 time)。
 *  - 各 kind 的 payload 字段(全部在真实 emit 侧核过,消费端一律防御式读取):
 *      llm.trace   → { file, turn, step, model, durationMs, usage{inputTokens,outputTokens,cachedTokens},
 *                      messageRoles, systemHead, responseHead, reminders, error?, toolCalls? }
 *                    apps/gateway/src/llm-trace.ts:145-172(指针事件)+
 *                    packages/harness-runtime/src/agent/loop.ts:1593(失败态 {turn,step,model?,ms,error})
 *      tool.call   → { toolCallId, name, arguments, turn, step }  loop.ts:2034
 *      tool.result → { toolCallId, name, content, durationMs, turn, step, images?, error? }  loop.ts:1792
 *      message.agent → { text, toolCalls, turn, step, llmMs, usage?, reasoning?, model? }  loop.ts:1644
 *      message.user  → { text }  loop.ts:1251
 *      compact.done  → { summary, model?, tokensBefore, tokensAfterMicrocompact, trigger, ... }
 *                    packages/harness-runtime/src/agent/auto-compact.ts:222
 *      compact.skipped → { reason, trigger, ... }  auto-compact.ts:151/165、compact-hook.ts:79
 *      custom type=task.phase → { taskId, phase, note, skip? }  apps/gateway/src/agent-wiring.ts:5155
 *      context.prune → { reason, compacted, savedTokens, growthSpurt, items[] }  loop.ts:1407
 *      context.model.score → { step, mode, durationMs, decisions[], ... }  loop.ts:1088
 *      task.trajectory → { step, turn, steps, tools{}, tokensSpent, errors, phase?, subgoal? }  loop.ts:1155
 *
 * 口径(写死在这里,别在消费端再猜):
 *  - calls:工具调用行数(kind==="tool");tools:去重后的工具名数。
 *  - token:只从 llm.trace.payload.usage 求和。message.agent.payload.usage 与 llm.trace 同源
 *    (同一次调用的两处落账),两边都取会双计 → 只认 llm.trace。
 *  - cacheHitRate = inputTokens > 0 ? cachedTokens / inputTokens : 0(0~1,step-048 口径 =
 *    trace-stats.ts:122 注释「命中率=cached/input」)。
 *  - prunes:真实剪枝事件是 context.prune(loop.ts:1404-1418,只在 microcompact 真折叠时落),
 *    条目数 = Σ payload.items.length(无 items 时按 1 计)。整段没有 context.prune 时回落到
 *    「compact.skipped 事件数」,再回落到「payload 含 prune 标记(microcompact/compacted/savedTokens)
 *    的事件数」——三档递进,避免老会话 prunes 恒 0 的假数据。
 *  - localScores = context.model.score 事件数;errors = status==="error" 的行数;
 *    wallMs = turns 末轮 endAt − 首轮 startAt(单轮=该轮 startAt→endAt)。
 *  - 轮号:llm.trace.payload.turn 决定;缺 turn 的事件按遇到 message.user 递增兜底。
 */

export type TrajRow = {
  seq: number;
  idx: number;
  turn: number;
  kind: "user" | "model" | "tool" | "compact" | "phase" | "other";
  label: string;
  summary: string;
  at: number;
  durationMs?: number;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  status: "ok" | "error" | "pending";
  toolName?: string;
  toolCallId?: string;
  error?: string;
  /** llm.trace 专有(step-1026):全文文件指针 + 步号 + 首字耗时 + 工具名(干条直接用,零额外请求)。 */
  traceFile?: string;
  stepNo?: number;
  ttftMs?: number;
  tools?: string[];
};

export type TrajTurn = {
  turn: number;
  startAt: number;
  endAt: number;
  wallMs: number;
  calls: number;
  errors: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolHistogram: Array<{ name: string; count: number }>;
};

export type TrajSummary = {
  calls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  tools: number;
  errors: number;
  wallMs: number;
  localScores: number;
  prunes: number;
  rows: number;
};

/** 行数上限(超出只保留最近的一批;老会话可有上万事件)。 */
export const TRAJ_ROW_CAP = 1500;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function numOf(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function strOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return "";
  return String(v);
}
function firstLine(s: string, cap = 120): string {
  const line = String(s || "").split(/\r?\n/)[0] ?? "";
  return line.length > cap ? line.slice(0, cap) + "…" : line;
}
/** 错误文本:字符串直接用;对象取 message(loop.ts 的 {origin,message,name} 结构化失败归因)。 */
function errText(v: unknown): string | undefined {
  if (typeof v === "string") return v ? v : undefined;
  const o = obj(v);
  const msg = strOf(o.message);
  return msg ? msg : undefined;
}

/** 事件稳定排序:seq 升序;无 seq 的事件贴着前一条 seq(注入/乐观事件,保序不重排)。 */
function sortEvents(events: unknown[]): Array<{ ev: Record<string, unknown>; seq: number }> {
  const list: Array<{ ev: Record<string, unknown>; seq: number; i: number }> = [];
  let last = 0;
  for (let i = 0; i < events.length; i++) {
    const raw = events[i];
    if (!raw || typeof raw !== "object") continue;
    const ev = raw as Record<string, unknown>;
    const s = numOf(ev.seq);
    if (s !== undefined) last = s;
    list.push({ ev, seq: s !== undefined ? s : last, i });
  }
  list.sort((a, b) => (a.seq === b.seq ? a.i - b.i : a.seq - b.seq));
  return list.map((x) => ({ ev: x.ev, seq: x.seq }));
}

function rowKindOf(kind: string, payload: Record<string, unknown>):
  | "user" | "model" | "tool" | "compact" | "phase" | "other" {
  if (kind === "message.user") return "user";
  if (kind === "message.agent" || kind === "llm.trace") return "model";
  if (kind === "tool.call" || kind === "tool.result") return "tool";
  if (kind === "compact.done" || kind === "compact.skipped") return "compact";
  if (kind === "custom" && payload.type === "task.phase") return "phase";
  return "other";
}

/** 事件数组 → 轨迹行(按 seq 稳定升序,同 toolCallId 的 call/result 合成一行)。 */
export function buildTrajRows(events: unknown): TrajRow[] {
  const src = Array.isArray(events) ? events : [];
  const sorted = sortEvents(src);
  const rows: TrajRow[] = [];
  const byCallId = new Map<string, TrajRow>();
  let curTurn = 0;
  for (const { ev, seq } of sorted) {
    const kind = strOf(ev.kind);
    const p = obj(ev.payload);
    const at = numOf(ev.time) ?? 0;
    const explicitTurn = numOf(p.turn);
    if (explicitTurn !== undefined && explicitTurn > 0) curTurn = explicitTurn;
    else if (kind === "message.user") curTurn = curTurn + 1;
    const turn = curTurn;
    const rk = rowKindOf(kind, p);
    const base: TrajRow = { seq, idx: rows.length, turn, kind: rk, label: kind || "event", summary: "", at, status: "ok" };

    if (kind === "message.user") {
      base.label = "user";
      base.summary = firstLine(strOf(p.text), 160);
    } else if (kind === "message.agent") {
      base.label = strOf(p.model) || "model";
      base.summary = firstLine(strOf(p.text), 160);
      const err = errText(p.error);
      if (err) {
        base.status = "error";
        base.error = err;
      }
    } else if (kind === "llm.trace") {
      const step = numOf(p.step);
      base.label = strOf(p.model) || "llm";
      const bits: string[] = [];
      if (step !== undefined) bits.push("t" + turn + "s" + step);
      else bits.push("t" + turn);
      const head = firstLine(strOf(p.responseHead), 80);
      if (head) bits.push(head);
      const tcs = Array.isArray(p.toolCalls) ? p.toolCalls.length : 0;
      if (tcs) bits.push("调用:" + tcs);
      base.summary = bits.join(" · ");
      const dur = numOf(p.durationMs) ?? numOf(p.ms); // 成功路径 durationMs,失败态 durable 事件用 ms(loop.ts:1598)
      if (dur !== undefined) base.durationMs = dur;
      // step-1026:全文指针/步号/首字/工具名(干条直接用,不用取文件)
      const tf = strOf(p.file);
      if (tf) base.traceFile = tf;
      if (step !== undefined) base.stepNo = step;
      const ttft = numOf(p.ttftMs);
      if (ttft !== undefined) base.ttftMs = ttft;
      if (Array.isArray(p.toolCalls)) base.tools = p.toolCalls.map((x) => strOf(x)).filter(Boolean);
      const u = obj(p.usage);
      const inTok = numOf(u.inputTokens);
      const cached = numOf(u.cachedTokens);
      const outTok = numOf(u.outputTokens);
      if (inTok !== undefined) base.inputTokens = inTok;
      if (cached !== undefined) base.cachedTokens = cached;
      if (outTok !== undefined) base.outputTokens = outTok;
      const err = errText(p.error);
      if (err) {
        base.status = "error";
        base.error = err;
      }
    } else if (kind === "tool.call") {
      const name = strOf(p.name) || "tool";
      const id = strOf(p.toolCallId);
      base.label = name;
      base.toolName = name;
      if (id) base.toolCallId = id;
      base.summary = firstLine(strOf(p.arguments), 120);
      base.status = "pending";
    } else if (kind === "tool.result") {
      const id = strOf(p.toolCallId);
      const name = strOf(p.name) || "tool";
      const dur = numOf(p.durationMs);
      const err = errText(p.error);
      const hit = id ? byCallId.get(id) : undefined;
      if (hit) {
        if (dur !== undefined) hit.durationMs = dur;
        hit.status = err ? "error" : "ok";
        if (err) hit.error = err;
        // 结果正文补进摘要(调用行只有参数);不覆盖已有 error
        const body = firstLine(strOf(p.content), 80);
        if (body && !hit.summary) hit.summary = body;
        continue;
      }
      // 找不到对应 call(截断/跨会话/顺序错乱):自成一行 tool,不丢数据。
      base.label = name;
      base.toolName = name;
      if (id) base.toolCallId = id;
      base.summary = firstLine(strOf(p.content), 120);
      if (dur !== undefined) base.durationMs = dur;
      base.status = err ? "error" : "ok";
      if (err) base.error = err;
    } else if (kind === "compact.done") {
      const trigger = strOf(p.trigger) || "auto";
      const sum = firstLine(strOf(p.summary), 60);
      base.label = "compact";
      base.summary = trigger + (sum ? " · " + sum : "");
    } else if (kind === "compact.skipped") {
      base.label = "compact";
      base.summary = "跳过 · " + firstLine(strOf(p.reason), 100);
    } else if (rk === "phase") {
      base.label = strOf(p.phase) || "phase";
      base.summary = firstLine(strOf(p.note), 120) || (p.skip ? "skip" : "");
    } else if (kind === "context.model.score") {
      base.label = "model.score";
      const decisions = Array.isArray(p.decisions) ? p.decisions.length : 0;
      base.summary = firstLine(strOf(p.mode), 40) + (decisions ? " · 决策 " + decisions : "");
    } else if (kind === "context.prune") {
      const items = Array.isArray(p.items) ? p.items.length : 0;
      base.label = "prune";
      base.summary = "剪枝 " + items + " 项" + (numOf(p.savedTokens) ? " · 省 " + numOf(p.savedTokens) + " tok" : "");
    } else if (kind === "task.trajectory") {
      base.label = "trajectory";
      const steps = numOf(p.steps);
      const toolKinds = Object.keys(obj(p.tools)).length;
      base.summary = (steps !== undefined ? "第 " + steps + " 步" : "") + (toolKinds ? " · 工具 " + toolKinds + " 类" : "");
    } else {
      base.label = kind || "event";
      base.summary = firstLine(strOf(p.text) || strOf(p.type) || strOf(p.reason), 120);
    }

    rows.push(base);
    if (base.kind === "tool" && base.toolCallId && base.status === "pending") {
      byCallId.set(base.toolCallId, base);
    }
  }
  return rows;
}

/** 行 → 轮聚合(turn 升序;calls=工具行数,wallMs=该轮首末事件时间差)。 */
export function groupTrajTurns(rows: TrajRow[]): TrajTurn[] {
  const src = Array.isArray(rows) ? rows : [];
  const byTurn = new Map<number, TrajTurn & { toolCounts: Map<string, number> }>();
  for (const r of src) {
    if (!r) continue;
    const t = Number.isFinite(r.turn) ? r.turn : 0;
    let g = byTurn.get(t);
    if (!g) {
      g = {
        turn: t, startAt: 0, endAt: 0, wallMs: 0, calls: 0, errors: 0,
        inputTokens: 0, cachedTokens: 0, outputTokens: 0, toolHistogram: [], toolCounts: new Map<string, number>(),
      };
      byTurn.set(t, g);
    }
    const at = Number.isFinite(r.at) ? r.at : 0;
    if (at > 0) {
      if (g.startAt === 0 || at < g.startAt) g.startAt = at;
      if (at > g.endAt) g.endAt = at;
    }
    if (r.kind === "tool") {
      g.calls += 1;
      const name = r.toolName || r.label || "tool";
      g.toolCounts.set(name, (g.toolCounts.get(name) ?? 0) + 1);
    }
    if (r.status === "error") g.errors += 1;
    g.inputTokens += r.inputTokens ?? 0;
    g.cachedTokens += r.cachedTokens ?? 0;
    g.outputTokens += r.outputTokens ?? 0;
  }
  const out = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  return out.map((g) => ({
    turn: g.turn,
    startAt: g.startAt,
    endAt: g.endAt,
    wallMs: g.endAt >= g.startAt ? g.endAt - g.startAt : 0,
    calls: g.calls,
    errors: g.errors,
    inputTokens: g.inputTokens,
    cachedTokens: g.cachedTokens,
    outputTokens: g.outputTokens,
    toolHistogram: [...g.toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (b.count === a.count ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : b.count - a.count)),
  }));
}

/** 行+轮 → 汇总(口径见文件头:token 只认 llm.trace,cacheHitRate=cached/input)。 */
export function summarizeTraj(rows: TrajRow[], turns: TrajTurn[]): TrajSummary {
  const src = Array.isArray(rows) ? rows : [];
  const tsrc = Array.isArray(turns) ? turns : [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let errors = 0;
  let localScores = 0;
  let pruneItems = 0;
  let pruneEvents = 0;
  let skipped = 0;
  for (const r of src) {
    if (!r) continue;
    if (r.kind === "tool") calls += 1;
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
    cachedTokens += r.cachedTokens ?? 0;
    if (r.status === "error") errors += 1;
    if (r.label === "model.score") localScores += 1;
    if (r.label === "prune") {
      pruneEvents += 1;
      const m = /剪枝\s+(\d+)/.exec(r.summary);
      pruneItems += m && m[1] !== undefined ? Number(m[1]) || 0 : 1;
    }
    if (r.kind === "compact" && r.summary.startsWith("跳过")) skipped += 1;
  }
  const tools = new Set<string>();
  for (const r of src) if (r && r.kind === "tool" && r.toolName) tools.add(r.toolName);

  // prunes 三档回落(口径见文件头):真剪枝条目 → compact.skipped 数 → 含 prune 标记的行数
  let prunes = pruneItems;
  if (pruneEvents === 0) prunes = skipped > 0 ? skipped : 0;

  let wallMs = 0;
  if (tsrc.length > 0) {
    let startAt = 0;
    let endAt = 0;
    for (const t of tsrc) {
      if (!t) continue;
      if (t.startAt > 0 && (startAt === 0 || t.startAt < startAt)) startAt = t.startAt;
      if (t.endAt > endAt) endAt = t.endAt;
    }
    wallMs = endAt >= startAt ? endAt - startAt : 0;
  }
  return {
    calls,
    turns: tsrc.length,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    tools: tools.size,
    errors,
    wallMs,
    localScores,
    prunes,
    rows: src.length,
  };
}

/** mode 过滤 + query 对 label/summary/toolName 大小写不敏感子串匹配。 */
export function filterTrajRows(
  rows: TrajRow[],
  mode: "all" | "model" | "tool" | "error",
  query?: string,
): TrajRow[] {
  const src = Array.isArray(rows) ? rows : [];
  const q = String(query ?? "").trim().toLowerCase();
  return src.filter((r) => {
    if (!r) return false;
    if (mode === "model" && r.kind !== "model") return false;
    if (mode === "tool" && r.kind !== "tool") return false;
    if (mode === "error" && r.status !== "error") return false;
    if (!q) return true;
    return [r.label, r.summary, r.toolName ?? ""].some((s) => String(s).toLowerCase().includes(q));
  });
}

/** >1500 只保留**最近**的 1500 行(顺序不变,idx 保持原值便于回指)。 */
export function capTrajRows(rows: TrajRow[]): { rows: TrajRow[]; truncated: boolean; total: number } {
  const src = Array.isArray(rows) ? rows : [];
  const total = src.length;
  if (total <= TRAJ_ROW_CAP) return { rows: src.slice(), truncated: false, total };
  return { rows: src.slice(total - TRAJ_ROW_CAP), truncated: true, total };
}

/** token 速览:1234 → "1.2K",1234567 → "1.23M",<1000 原样。 */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? Number(n) : 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.trunc(v));
  if (abs < 1e6) return (v / 1000).toFixed(1) + "K";
  return (v / 1e6).toFixed(2) + "M";
}

/** 耗时速览:<1000 → "123ms",<60000 → "1.2s",否则 "1m05s"。 */
export function fmtDuration(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, Number(ms)) : 0;
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 60000) return (v / 1000).toFixed(1) + "s";
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  return m + "m" + String(s).padStart(2, "0") + "s";
}

// ===================== 逐次决策:公共前缀切分(step-1026) =====================
/** 单条消息的逐字比较键:role + content + toolCalls + toolCallId(对象一律 JSON 化)。 */
function msgKeyOf(m: unknown): string {
  const o = obj(m);
  const c = o.content;
  const cs = typeof c === "string" ? c : c === undefined || c === null ? "" : JSON.stringify(c);
  const tc = Array.isArray(o.toolCalls) ? JSON.stringify(o.toolCalls) : "";
  return strOf(o.role) + "\u0000" + cs + "\u0000" + tc + "\u0000" + strOf(o.toolCallId);
}
/** 粗估 token:中文/CJK 一字≈1 tok,其余 4 字符≈1 tok(仅用于「约 X tok」,不是计费口径)。 */
export function approxTokens(s: unknown): number {
  const str = typeof s === "string" ? s : s === undefined || s === null ? "" : JSON.stringify(s);
  let cjk = 0, other = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.codePointAt(i) ?? 0;
    if (cp > 0xffff) i++; // 代理对只算一次
    if (cp >= 0x2e80 && cp <= 0x9fff) cjk++; else other++;
  }
  return Math.ceil(cjk + other / 4);
}
/** 单条消息的可读全文(content 非字符串时 JSON 化;toolCalls 附在后)。 */
export function msgTextOf(m: unknown): string {
  const o = obj(m);
  const c = o.content;
  const cs = typeof c === "string" ? c : c === undefined || c === null ? "" : JSON.stringify(c, null, 1);
  const tc = Array.isArray(o.toolCalls) && o.toolCalls.length ? JSON.stringify(o.toolCalls, null, 1) : "";
  return cs + (tc ? (cs ? "\n" : "") + tc : "");
}
/**
 * 与上一次请求的最长公共前缀条数(逐字比 role/content/toolCalls/toolCallId)。
 * 首调(prev 缺失/空)= 0;任一条不等即停(公共前缀必须连续,不能跳读)。
 */
export function commonPrefixLen(prevMsgs: unknown, curMsgs: unknown): number {
  const a = Array.isArray(prevMsgs) ? prevMsgs : [];
  const b = Array.isArray(curMsgs) ? curMsgs : [];
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) if (msgKeyOf(a[i]) !== msgKeyOf(b[i])) break;
  return i;
}
export type CachedSplit = { hitCount: number; hitTokens: number; miss: unknown[]; total: number };
/** 前缀=已命中(被省略,只给一行「已命中前缀 N 条 / 约 X tok」);其后=未命中,逐条全文渲染。 */
export function splitCachedInput(prevMsgs: unknown, curMsgs: unknown): CachedSplit {
  const cur = Array.isArray(curMsgs) ? curMsgs : [];
  const hitCount = commonPrefixLen(prevMsgs, cur);
  let hitTokens = 0;
  for (let i = 0; i < hitCount; i++) hitTokens += approxTokens(msgTextOf(cur[i]) + strOf(obj(cur[i]).role));
  return { hitCount, hitTokens, miss: cur.slice(hitCount), total: cur.length };
}

// ===================== 浏览器侧注入串(step-1020 轨迹看板) =====================
/**
 * 为什么是「源码串」而不是 import:PAGE(panel.ts:35)是模板字符串,内联脚本无法 import TS 模块;
 * 本仓既有做法就是注入源码(见 panel.ts:29 ERROR_TEXT_JS,error-text.ts 同款)。
 *
 * 为什么包一层 IIFE:注入串与 PAGE 落地在同一脚本作用域。内部辅助(obj/numOf/strOf/firstLine/
 * errText/sortEvents/rowKindOf)名字过于通用,平铺会与页面既有标识符撞车(SyntaxError 整页白屏);
 * 故私有辅助关在 IIFE 内,只把 7 个公开函数 + TRAJ_ROW_CAP 取到页面作用域——这 8 个名字在
 * panel.ts 里零占用(已核:rg 计数全 0)。
 *
 * 约束(改这里的人必读):参与拼接的函数体内**不得**引用模块级其它符号。新增依赖必须同步
 * 加进 TRAJ_INJECTED_FNS,否则浏览器侧 ReferenceError(单测 panel-traj-board.test.ts 会抓)。
 */
const TRAJ_INJECTED_FNS: Array<(...args: never[]) => unknown> = [
  obj, numOf, strOf, firstLine, errText, sortEvents, rowKindOf,
  buildTrajRows, groupTrajTurns, summarizeTraj, filterTrajRows, capTrajRows, fmtTokens, fmtDuration,
  msgKeyOf, approxTokens, msgTextOf, commonPrefixLen, splitCachedInput,
];

const TRAJ_MODEL_FNS_SRC = TRAJ_INJECTED_FNS.map((f) => f.toString()).join("\n");

/** 注入串:可直接放进 <script> 求值;求值后页面作用域得到 buildTrajRows/TRAJ_ROW_CAP 等公开名字。 */
export const TRAJ_MODEL_JS: string =
  "const TRAJ=(function(){\n" +
  "const TRAJ_ROW_CAP=" + String(TRAJ_ROW_CAP) + ";\n" +
  TRAJ_MODEL_FNS_SRC + "\n" +
  "return {TRAJ_ROW_CAP:TRAJ_ROW_CAP,buildTrajRows:buildTrajRows,groupTrajTurns:groupTrajTurns," +
  "summarizeTraj:summarizeTraj,filterTrajRows:filterTrajRows,capTrajRows:capTrajRows," +
  "fmtTokens:fmtTokens,fmtDuration:fmtDuration," +
  "msgTextOf:msgTextOf,commonPrefixLen:commonPrefixLen,splitCachedInput:splitCachedInput," +
  "approxTokens:approxTokens};})();\n" +
  "const {TRAJ_ROW_CAP,buildTrajRows,groupTrajTurns,summarizeTraj,filterTrajRows,capTrajRows," +
  "fmtTokens,fmtDuration,msgTextOf,commonPrefixLen,splitCachedInput,approxTokens}=TRAJ;\n";
