/**
 * 用真实 journal 轨迹回放「热区→温区→冷区」全链路。
 * 不跑 LLM、不改 journal:按会话事件顺序模拟 loop 的段闭合扫描、settle(仅 turn 首步/末)、
 * 段批 microcompact、applied 台账与三区切分。用于审计:
 * - 热→温:哪些段闭合入队/批准/应用;
 * - 温→冷:frozenCount 何时前移、冷区 token 如何增长;
 * - 热区是否在 turn 末清空(turn.end 后 hot 应为 0/仅段锚);
 * - 每条结果是否只定价一次(增量定价 + applied 跳过)。
 * 简化(与真实 loop 的差异,结果里显式标注):
 * 1. 普通 token 阈值清理关闭(threshold=1e9),只走段批档——本工具测的是段化链路;
 * 2. digest 用确定性 mock(不调模型);`--summary-wprime` 可降低 W′ 以在既有轨迹上触发摘要分支;
 * 3. 未复刻 deriveMessages 的 discarded/truncate 边界差异(条数可能 ±1)。
 * 用法:
 * npx tsx packages/harness-runtime/scripts/replay-context-zones.ts --session web-1794382830254
 * npx tsx ... --session ws-mwojk2gy --stress
 * npx tsx ... --session ws-mwojk2gy --stress --summary-wprime 100 --every-turn
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { deriveMessages } from "../src/agent/loop";
import { createDegradationQueue, observationExpired } from "../src/agent/degradation-queue";
import {
  scanSegmentClosures, isCandidateStillReferenced, type SegmentEvent,
} from "../src/agent/segment-tracker";
import { microcompactMessages, priceRatioOf, isSegmentCompactableResult, type MicrocompactConfig } from "../src/agent/microcompact";

interface Ev { kind?: string; seq?: number; payload?: any; sessionId?: string }
interface Rec {
  label: string; turn: number; step: number; frozen: number;
  coldMsgs: number; warmMsgs: number; hotMsgs: number;
  coldTok: number; warmTok: number; hotTok: number;
  pending: number; applied: number; openChains: number;
  compactReason?: string; cleared?: number; summarized?: number;
 /** 首个改写点之后的 token(缓存失效 tail)与本次实际省下的 token。 */
  tailTok?: number; savedTok?: number;
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

const root = process.cwd();
const sid = arg("session", "web-1794382830254")!;
const maxEvents = Number(arg("max-events", "0")) || 0;
const stress = flag("stress");
const everyTurn = flag("every-turn");
const summaryWPrime = Number(arg("summary-wprime", "0")) || undefined;
const priceRatio = 10;

const sessionFile = join(root, ".genie/journals/sessions", `${sid}.jsonl`);
const globalFile = join(root, ".genie/journals/global.jsonl");
const bySeq = new Map<number, Ev>();
for (const file of [sessionFile, globalFile]) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes(sid)) continue;
    try {
      const e = JSON.parse(t) as Ev;
      if (String(e.sessionId ?? "") !== sid || typeof e.seq !== "number") continue;
      bySeq.set(e.seq, e);
    } catch { /* 跳过损坏行 */ }
  }
}
let events = [...bySeq.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
if (maxEvents > 0) events = events.slice(0, maxEvents);
if (events.length === 0) { console.error(`[replay] 无事件: ${sessionFile}`); process.exit(1); }

const sessionEvents = (): Ev[] => visible;
let visible: Ev[] = [];
const journal = {
  readAll: () => visible,
  readSession: (_sid: string, sinceSeq = 0) => visible.filter((e) => (e.seq ?? 0) >= sinceSeq),
};

const queue = createDegradationQueue();
const seenCloses = new Set<string>();
const appliedIds = new Set<string>();
const pendingClear = new Set<string>();
const pendingSummaryIds = new Set<string>();
const pendingKeep = new Set<string>();
let frozenCount = 0;
let clock = 0;
let resetsThisTurn = 0;
let lastResetClock: number | undefined;
let lastResetTokens: number | undefined;
let turnFirstStep = false;
let turnOrdinal = 0;
let currentTurn = 0;
let currentStep = 0;
const turnStepHistory: number[] = [];
let currentTurnSteps = 0;
let lastSettledTurn = -1;
function recordTurnSteps(turn: number): void {
  if (lastSettledTurn === turn) return;
  lastSettledTurn = turn;
  turnStepHistory.push(Math.max(1, currentTurnSteps));
  if (turnStepHistory.length > 3) turnStepHistory.shift();
}
function remainingSteps(): number {
  return turnStepHistory.length > 0 ? Math.max(1, Math.min(...turnStepHistory)) : 1;
}
let currentUserText = "";
let turnStart = false;
/** 最近一步实际会发给模型的 compacted 消息(zone 统计必须用它,不能用 raw derive)。 */
let requestMessages: ReturnType<typeof deriveMessages> = [];

const closuresByReason: Record<string, number> = {};
const records: Rec[] = [];
const counters = { closed: 0, priced: 0, enqueued: 0, approved: 0, deferred: 0, applied: 0, summarized: 0, coldAdvances: 0 };

function segEvents(): SegmentEvent[] {
  return visible.map((e) => ({ type: e.kind ?? "", seq: Number(e.seq ?? 0), payload: e.payload }));
}

function scanAndEnqueue(): void {
  const segs = segEvents();
  const scan = scanSegmentClosures(segs, seenCloses, {
    ...(summaryWPrime !== undefined ? { summaryTokensWPrime: summaryWPrime } : {}),
    priceRatio,
    isPricedTool: (tool, content) => isSegmentCompactableResult(tool, content),
  });
  for (const seg of scan.closed) {
    seenCloses.add(seg.segmentId);
    closuresByReason[seg.closeReason] = (closuresByReason[seg.closeReason] ?? 0) + 1;
    counters.closed += 1;
    for (const item of seg.items) {
      counters.priced += 1;
      if (item.observeOnly || appliedIds.has(item.id)) continue;
      const added = queue.enqueue({
        id: item.id,
        tool: item.tool, where: item.where, resultSeq: item.resultSeq,
        product: item.product,
        savedTokensW: item.savedTokensW,
        productTokensWPrime: item.productTokensWPrime,
        tailTokens: item.tailTokens,
        remainingStepsN: 1,
        queuedAtStep: clock,
      });
      if (added) counters.enqueued += 1;
    }
  }
}

/** 整批 rewrite 的共享 tail:最早候选消息之后的全部字节(候选用 W′ 产物估)。 */
function estimateBatchTail(messages: ReturnType<typeof deriveMessages>, candidates: readonly { id: string; productTokensWPrime: number }[]): number {
  const ids = new Set(candidates.map((c) => c.id));
  if (ids.size === 0) return 0;
  const product = new Map(candidates.map((c) => [c.id, Math.max(0, c.productTokensWPrime)]));
  let first = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] as { role?: string; toolCallId?: string };
    if (m.role === "tool" && m.toolCallId && ids.has(m.toolCallId)) { first = i; break; }
  }
  if (first < 0) return 0;
  let tail = 0;
  for (let i = first; i < messages.length; i += 1) {
    const m = messages[i] as { role?: string; toolCallId?: string; content?: unknown };
    if (m.role === "tool" && m.toolCallId && product.has(m.toolCallId)) tail += product.get(m.toolCallId)!;
    else tail += String(m.content ?? "").length / 4;
  }
  return Math.round(tail);
}

function settle(messages: ReturnType<typeof deriveMessages>, remainingStepsN: number): number {
  const pending = queue.pending();
  if (pending.length === 0) return 0;
  const segs = segEvents();
 // 观察期到期:刚闭合段至少过 1 步才取得可裁资格(turn 末新闭合留到下一 turn)。
  const expired = pending.filter((c) => observationExpired(c.queuedAtStep, clock));
  if (expired.length === 0) { counters.deferred += pending.length; return 0; }
  const referenced = new Set(expired.filter((c) => isCandidateStillReferenced(c, segs)).map((c) => c.id));
  for (const id of referenced) pendingKeep.add(id);
  const expiredSet = new Set(expired.map((c) => c.id));
  const exclude = new Set([...pending.map((c) => c.id).filter((id) => !expiredSet.has(id)), ...referenced]);
  const tailTokens = estimateBatchTail(messages, expired);
  const n = Math.max(1, remainingStepsN);
  const batch = queue.settleBatch(priceRatio, { remainingStepsN: n, tailTokens, exclude });
  if (flag("debug")) console.log(`[econ] T${currentTurn} N=${n} W=${batch.batchW} Wp=${batch.batchWPrime} tail=${tailTokens} gate=${n * batch.batchW} cost=${(batch.batchWPrime + tailTokens) * priceRatio} -> ${batch.economic ? "approve" : "defer"}`);
  if (!batch.economic) { counters.deferred += pending.length; return 0; }
  for (const c of batch.approved) {
    pendingClear.add(c.id);
    if (c.product === "summary") pendingSummaryIds.add(c.id);
  }
  counters.approved += batch.approved.length;
  counters.deferred += pending.length - batch.approved.length;
  return batch.approved.length;
}

/** 每步都跑 microcompact(与 loop 同序):即使没有 plan,也要用当前 frozenCount 重放冻结前缀,
 * 否则回放记录会拿 raw deriveMessages 的原文,看不到段批后的 token 下降。 */
function runMicrocompact(messages: ReturnType<typeof deriveMessages>, stepTurnStart: boolean): {
  messages: ReturnType<typeof deriveMessages>; reason?: string; cleared: number; summarized: number;
  tailTok: number; savedTok: number;
} {
 // 确定性 mock 摘要:只验证摘要分支的链路,不调模型;summaryWPrime 未设置时通常不会命中摘要。
  const summaryPlan = new Map<string, string>();
  for (const id of pendingSummaryIds) {
    if (pendingClear.has(id)) summaryPlan.set(id, `关键结论:${id} 段批摘要(mock)\n精确锚点:toolCallId=${id}`);
  }
  const config: MicrocompactConfig = {
 // 关闭普通阈值清理,隔离段化链路;段批档在 threshold 之前执行。
    thresholdTokens: 1_000_000,
    minContextTokens: 1,
    policyState: {
      clock, turnStart: stepTurnStart, frozenCount, resetsThisTurn,
      ...(lastResetClock !== undefined ? { lastResetClock } : {}),
      ...(lastResetTokens !== undefined ? { lastResetTokens } : {}),
    },
    breakEvenGateV2: true,
    modelName: "replay",
    ...(pendingClear.size > 0 ? { segmentClearPlan: new Set(pendingClear) } : {}),
    ...(summaryPlan.size > 0 ? { segmentSummaryPlan: summaryPlan } : {}),
    ...(pendingKeep.size > 0 ? { modelKeep: new Set(pendingKeep) } : {}),
    ...(stress ? { pruneMinBatchTokens: 1, maxResetCutRatio: 1, resetCooldownSteps: 0 } : {}),
  };
  const r = microcompactMessages(messages, config);
  const clearedIds = (r.pruned ?? []).filter((p) => p.action === "cleared" && p.toolCallId).map((p) => p.toolCallId);
 // 冻结区每个请求都会重放同一批 clear(读侧不持久化):只统计首次应用的 id,
 // 否则 counters 会被「每步重放」放大成几千。
  const newCleared = clearedIds.filter((id) => !appliedIds.has(id));
  for (const id of clearedIds) appliedIds.add(id);
  queue.drop(new Set(clearedIds)); // 已清 id 不再参与后续 ΣW
  counters.applied += newCleared.length;
  const summarized = newCleared.filter((id) => summaryPlan.has(id)).length;
  counters.summarized += summarized;
  if (r.prefixBreak === true) {
    frozenCount = r.frozenCount ?? frozenCount;
    lastResetClock = clock;
    lastResetTokens = r.contextTokensAfter;
    resetsThisTurn += 1;
    counters.coldAdvances += 1;
  } else if (r.frozenCount !== undefined) {
    frozenCount = r.frozenCount;
  }
  if (r.reason === "segment-empty") {
    pendingClear.clear();
    pendingSummaryIds.clear();
    pendingKeep.clear();
  } else {
 // 与 loop 同口径:任何真正 cleared 的 id(段批/冻结区重放)都从待执行 plan 移除。
    for (const id of clearedIds) { pendingClear.delete(id); pendingSummaryIds.delete(id); }
    if (pendingClear.size === 0) pendingKeep.clear();
  }
  const changed = newCleared.length > 0 || r.prefixBreak === true || r.reason === "segment-applied";
 // 缓存成本审计:首个被改写消息之后的所有字节 = 本次前缀失效的 tail。
 // 经济门当前按 tail=0 逐条裁决;这个读数用来判断是否“省了上下文却亏了缓存”。
  const newSet = new Set(newCleared);
  let firstChanged = -1;
  r.messages.forEach((m, i) => {
    if (firstChanged >= 0 || m.role !== "tool" || !m.toolCallId || !newSet.has(m.toolCallId)) return;
    const c = String(m.content ?? "");
    if (c.startsWith("[工具结果已清除") || c.startsWith("[段批摘要")) firstChanged = i;
  });
  let tailTok = 0;
  if (firstChanged >= 0) {
    for (let i = firstChanged; i < r.messages.length; i++) tailTok += String((r.messages[i] as { content?: unknown })?.content ?? "").length / 4;
  }
  let savedTok = 0;
  for (const id of newCleared) {
    const before = messages.find((m) => m.role === "tool" && (m as { toolCallId?: string }).toolCallId === id);
    const after = r.messages.find((m) => m.role === "tool" && (m as { toolCallId?: string }).toolCallId === id);
    const b = String((before as { content?: unknown } | undefined)?.content ?? "").length;
    const a = String((after as { content?: unknown } | undefined)?.content ?? "").length;
    savedTok += Math.max(0, b - a) / 4;
  }
  return {
    messages: r.messages,
    ...(changed && r.reason ? { reason: r.reason } : {}),
    cleared: newCleared.length,
    summarized,
    tailTok: Math.round(tailTok),
    savedTok: Math.round(savedTok),
  };
}

function record(label: string, msgs: ReturnType<typeof deriveMessages>, compact?: { reason?: string; cleared: number; summarized: number; tailTok?: number; savedTok?: number }): void {
  const total = msgs.length;
  const coldEnd = Math.min(Math.max(0, frozenCount), total);
  const scans = segEvents();
 // 轻量热区扫描(与 panel 同口径);这里只用于记录,不参与机制。
  const computedHotStart = (() => {
    let count = 0; let openStart = 0; let openChains = 0;
    const roots: string[] = [];
    const close = () => { openStart = count; openChains = 0; roots.length = 0; };
    for (const e of scans) {
      const kind = e.type; const p = (e.payload ?? {}) as Record<string, any>;
      if (kind === "message.user") { count++; openStart = count - 1; openChains = 1; roots.length = 0; }
      else if (kind === "message.agent") {
        count++;
        if (Array.isArray(p.toolCalls) && p.toolCalls.length > 0) { if (openChains === 0) { openStart = count - 1; openChains = 1; roots.length = 0; } }
        else close();
      } else if (kind === "tool.result") count++;
      else if (kind === "turn.end") close();
      else if (kind === "message.system") { count++; openStart = count; openChains = 0; }
      else if (kind === "custom") {
        const t = String(p.type ?? ""); const what = String(p.what ?? "");
        if (["task.phase", "context.path.abandoned", "goal_progress"].includes(t)
          || ["task_phase", "context.path.abandoned", "goal_progress"].includes(what)) close();
      } else if (kind === "context.prune") {
        const c = Number(p.compacted ?? 0); const pol = String(p.policy ?? "");
        if (c > 0 || pol === "reset" || pol === "growth-spurt") close();
      }
    }
    return Math.max(coldEnd, Math.min(openStart, total));
  })();
 // turn.end 是热区最硬边界:其后若没有消息事件,热区必须为 0。
 // (deriveMessages 的配对补齐会产生少量派生消息,轻量扫描不计数;这里按 design。)
  let lastTurnEnd = -1;
  scans.forEach((e, i) => { if (e.type === "turn.end") lastTurnEnd = i; });
  const hasMessageAfterTurnEnd = lastTurnEnd >= 0 && scans.slice(lastTurnEnd + 1)
    .some((e) => e.type === "message.user" || e.type === "message.agent" || e.type === "tool.result" || e.type === "message.system");
  const hotStart = lastTurnEnd >= 0 && !hasMessageAfterTurnEnd ? total : computedHotStart;
  const tok = (a: number, b: number) => {
    let chars = 0;
    for (let i = a; i < b; i++) chars += String((msgs[i] as { content?: unknown })?.content ?? "").length;
    return Math.round(chars / 4);
  };
  records.push({
    label, turn: currentTurn, step: currentStep, frozen: frozenCount,
    coldMsgs: coldEnd, warmMsgs: Math.max(0, hotStart - coldEnd), hotMsgs: Math.max(0, total - hotStart),
    coldTok: tok(0, coldEnd), warmTok: tok(coldEnd, hotStart), hotTok: tok(hotStart, total),
    pending: pendingClear.size, applied: appliedIds.size, openChains: 0,
    ...(compact?.reason ? { compactReason: compact.reason } : {}),
    ...(compact ? { cleared: compact.cleared, summarized: compact.summarized, ...(compact.tailTok !== undefined ? { tailTok: compact.tailTok } : {}), ...(compact.savedTok !== undefined ? { savedTok: compact.savedTok } : {}) } : {}),
  });
}

for (let i = 0; i < events.length; i++) {
  const e = events[i]!;
  visible.push(e);
  const p = (e.payload ?? {}) as Record<string, any>;
  if (e.kind === "turn.start") {
 // journal 的 turn 字段每个任务都从 1 起(每任务新 loop),审计用自增序号更可读。
    turnOrdinal += 1;
    currentTurn = turnOrdinal;
    turnFirstStep = true;
    turnStart = true;
    currentTurnSteps = 0;
    resetsThisTurn = 0;
  } else if (e.kind === "message.user") {
    currentUserText = String(p.text ?? "");
  } else if (e.kind === "step.start") {
    currentStep = Number(p.step ?? currentStep + 1);
    currentTurnSteps += 1;
    clock += 1;
    scanAndEnqueue();
    const base = deriveMessages(journal as never, sid);
    let approved = 0;
    if (turnFirstStep) {
      approved = settle(base, remainingSteps());
      turnFirstStep = false;
    }
    const compact = runMicrocompact(base, turnStart);
    requestMessages = compact.messages;
    turnStart = false;
    if (everyTurn || approved > 0 || compact.cleared > 0 || compact.reason === "segment-applied") {
      record(`T${currentTurn}:s${currentStep}`, requestMessages, compact);
    }
  } else if (e.kind === "turn.end") {
    recordTurnSteps(currentTurn);
    scanAndEnqueue();
    const approved = settle(deriveMessages(journal as never, sid), remainingSteps());
    if (everyTurn || approved > 0) {
      record(`T${currentTurn}:end`, requestMessages.length > 0 ? requestMessages : deriveMessages(journal as never, sid), { cleared: 0, summarized: 0 });
    }
  }
}

// 即使一次段批都没批,也记录最终三区(短 turn 全部 defer 的证据)。
record("final", requestMessages.length > 0 ? requestMessages : deriveMessages(journal as never, sid), { cleared: 0, summarized: 0 });
const final = records.at(-1);
console.log(`[replay] ${basename(sessionFile)} events=${events.length} stress=${stress} summaryWPrime=${summaryWPrime ?? "-"}`);
console.log(`[replay] 闭合 ${counters.closed} / 定价 ${counters.priced} / 入队 ${counters.enqueued} / 批准 ${counters.approved} / 延迟 ${counters.deferred} / 应用 ${counters.applied} / 摘要 ${counters.summarized} / 冷区前移 ${counters.coldAdvances}`);
console.log(`[replay] 闭合原因 ${JSON.stringify(closuresByReason)}`);
console.log(`[replay] 最终 frozen=${final?.frozen ?? frozenCount} cold=${final?.coldTok ?? "?"}tok warm=${final?.warmTok ?? "?"}tok hot=${final?.hotTok ?? "?"}tok records=${records.length}`);
const shown = records.length > 40 && !everyTurn
  ? records.filter((r, i) => i < 3 || i >= records.length - 3 || (i > 0 && r.frozen !== records[i - 1]!.frozen))
  : records;
console.log("label\tfrozen\tcold(msgs/tok)\twarm(msgs/tok)\thot(msgs/tok)\tpending/applied\tcompact\ttail/saved");
for (const r of shown) {
  console.log(`${r.label}\t${r.frozen}\t${r.coldMsgs}/${r.coldTok}\t${r.warmMsgs}/${r.warmTok}\t${r.hotMsgs}/${r.hotTok}\t${r.pending}/${r.applied}\t${r.compactReason ?? ""}${r.cleared ? ` cleared=${r.cleared}` : ""}${r.summarized ? ` summary=${r.summarized}` : ""}\t${r.tailTok !== undefined ? `${r.tailTok}/${r.savedTok}` : "-"}`);
}