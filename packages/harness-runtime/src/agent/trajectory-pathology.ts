/**
 * 轨迹病理(Trajectory Pathology):把一段执行轨迹里的「病态形状」拆成六个可检测的原语,
 * 再用「原语签名 ⊆ 产物形态签名」的方式把轨迹归到已知病理形态,并给出干预载体路由。
 * 为什么要原语 + 形态两层:
 * - 只按形态打标签,新增轨迹一旦不完全吻合就只能丢弃;先检测原语,未命中的新组合可以作为
 *   **候选形态**(NEW_CANDIDATE)回报,形态库才有生长路径,而不是靠人手改枚举。
 * - 形态只是名字,真正让人/agent 采取行动的是「干预载体」(tip / decision-gate / tool / ...)。
 *   同一形态在不同族里的首选载体不同,干预先后顺序也不同,所以路由必须由形态族决定。
 * 六个原语(检测口径见 detectPrimitives):
 * - re-entry:windowMs 内重复同一 tool/file/args(转圈,同一个动作反复做)。
 * - reversal:同一文件的编辑回到此前出现过的状态(回环),或决策序列来回反复(≥2 次)。
 * - fanout  :一次变更后接连 ≥2 次救火,或变更节点扇出边 ≥2(点替换而非面替换)。
 * - overlap :多个会话改动范围相交且时间重叠(并行冲突)。
 * - dangling:提问无人回答 / 失败后无成功修复(悬空)。
 * - decay   :读到的信息已过期,或同一 ref 反复读 ≥3 次(陈旧 / 缓存失效)。
 * 红线:
 * - 纯逻辑:零 IO(不读文件 / 网络 / 环境 / 真实时钟),不引用 agent loop。
 *   时间一律为 epoch ms 数字,全部来自输入(at)或注入(opts);唯一允许的外部依赖是
 *   node:crypto 的 createHash(给新形态生成确定性 id,保证同输入同 id)。
 * - 绝不 throw:任何非法形状(trace 缺字段、steps 非数组、未知原语、未知族)都按空值兜底,
 *   并通过稳定码(PATHOLOGY_CODES)表达,调用方只按码分支,不解析文案。
 * - 干预绝不上线即生效:buildInterventionPlan 恒返回 experimentRequired=true,
 *   干预必须先走 #192 实验账本才有资格进上下文。
 */

import { createHash } from "node:crypto";

/** 病理目录 schema 版本:字段语义变化时递增。 */
export const PATHOLOGY_VERSION = 1;

/** 六个原语,顺序即签名规范化顺序(排序/比较一律以此为准,保证确定性)。 */
export const PATHOLOGY_PRIMITIVES = [
  "re-entry",
  "reversal",
  "fanout",
  "overlap",
  "dangling",
  "decay",
] as const;

export type PathologyPrimitive = (typeof PATHOLOGY_PRIMITIVES)[number];

/** 形态族:决定默认干预载体与优先级口径。 */
export const PATHOLOGY_FAMILIES = [
  "rework-chain",
  "evolution-chain",
  "waste",
  "coordination",
  "statistics",
  "meta",
] as const;

export type PathologyFamily = (typeof PATHOLOGY_FAMILIES)[number];

/** 干预载体:形态「怎么治」的唯一枚举。tip 最便宜且最易过拟合,故单列 tipAllowed 门。 */
export const INTERVENTION_CARRIERS = [
  "tip",
  "decision-gate",
  "tool",
  "refactor-task",
  "contract-ledger",
  "invariant-assert",
  "world-model",
  "capability-index",
  "negative-kb",
  "no-progress-detector",
  "claim-lock",
  "search-scope",
  "checklist",
  "targeted-tool",
  "pruning-budget",
] as const;

export type InterventionCarrier = (typeof INTERVENTION_CARRIERS)[number];

/** 一条干预:载体 + 一句可执行说明。 */
export interface PathologyIntervention {
  carrier: InterventionCarrier;
  detail: string;
}

/** 一个病理形态:签名(原语集合) + 族 + 干预清单 + tip 门 + 是否内置。 */
export interface PathologyForm {
  id: string;
  family: PathologyFamily;
  signature: PathologyPrimitive[];
  description: string;
  interventions: PathologyIntervention[];
  tipAllowed: boolean;
  builtin: boolean;
}

/** 重复检测的默认时间窗(30 分钟)。 */
export const DEFAULT_WINDOW_MS = 1_800_000;

/** 重复检测的默认阈值(同 key 至少 3 次才算转圈;2 次视为正常重试)。 */
export const DEFAULT_MIN_REPEATS = 3;

/** 稳定码:调用方按码分支,不解析文案。 */
export const PATHOLOGY_CODES = {
  MATCHED: "PATHOLOGY_MATCHED",
  NEW_CANDIDATE: "PATHOLOGY_NEW_CANDIDATE",
  FORM_REGISTERED: "PATHOLOGY_FORM_REGISTERED",
  FORM_DUPLICATE: "PATHOLOGY_FORM_DUPLICATE",
  TIP_FORBIDDEN: "PATHOLOGY_TIP_FORBIDDEN",
  NO_MATCH: "PATHOLOGY_NO_MATCH",
  INVALID: "PATHOLOGY_INVALID",
} as const;

export type PathologyCode =
  (typeof PATHOLOGY_CODES)[keyof typeof PATHOLOGY_CODES];

/** 全部稳定码的值清单(测试与审计枚举用,顺序同 PATHOLOGY_CODES)。 */
export const PATHOLOGY_CODE_LIST: string[] = Object.values(PATHOLOGY_CODES);

/** 轨迹一步:at 必填(epoch ms),其余宽松可选。 */
export interface PathologyStep {
  at: number;
  tool?: string;
  file?: string;
  argsHash?: string;
  decision?: string;
  ok?: boolean;
}

/** 一次编辑:at + 文件 + 前后内容 hash(用于识别回环)。 */
export interface PathologyEdit {
  at: number;
  file: string;
  beforeHash: string;
  afterHash: string;
}

/** 一次提问:id + 是否已被回答。 */
export interface PathologyAsk {
  at: number;
  id: string;
  resolvedAt?: number;
}

/** 一次读取:ref + 版本 + 是否已过期。 */
export interface PathologyRead {
  at: number;
  ref: string;
  version?: string;
  expired?: boolean;
}

/** 一个会话:改动文件集合(用于并行冲突判定)。 */
export interface PathologySession {
  id: string;
  files: string[];
}

/** 变更节点:扇出边数。 */
export interface PathologyChangeNode {
  at: number;
  fanoutEdges: number;
}

/** 轨迹:全部字段可选,非法形状按空数组处理。 */
export interface PathologyTrace {
  steps?: PathologyStep[];
  edits?: PathologyEdit[];
  asks?: PathologyAsk[];
  reads?: PathologyRead[];
  sessions?: PathologySession[];
  changeNodes?: PathologyChangeNode[];
}

/** 检测参数:窗口与阈值,缺省走 DEFAULT_*。 */
export interface DetectOptions {
  windowMs?: number;
  minRepeats?: number;
}

/** 单原语检测结果:hit + 短证据串 + 计数。 */
export interface PrimitiveHit {
  hit: boolean;
  evidence: string[];
  count: number;
}

/** 形态族默认干预载体:新建形态未显式给载体时按族兜底。 */
const FAMILY_DEFAULT_CARRIERS: Record<PathologyFamily, InterventionCarrier[]> =
  {
    "rework-chain": ["tip", "decision-gate", "tool"],
    "evolution-chain": ["refactor-task", "contract-ledger", "invariant-assert"],
    waste: ["world-model", "capability-index", "negative-kb"],
    coordination: ["claim-lock", "search-scope"],
    statistics: ["checklist", "targeted-tool"],
    meta: ["pruning-budget"],
  };

/** 新建形态的干预说明:载体未经验证,必须人工确认。 */
const CUSTOM_DETAIL = "新组合需人工确认干预载体";

// ---------------------------------------------------------------- 归一化兜底

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPrimitive(value: unknown): value is PathologyPrimitive {
  return (
    typeof value === "string" &&
    (PATHOLOGY_PRIMITIVES as readonly string[]).includes(value)
  );
}

function isFamily(value: unknown): value is PathologyFamily {
  return (
    typeof value === "string" &&
    (PATHOLOGY_FAMILIES as readonly string[]).includes(value)
  );
}

function isCarrier(value: unknown): value is InterventionCarrier {
  return (
    typeof value === "string" &&
    (INTERVENTION_CARRIERS as readonly string[]).includes(value)
  );
}

function emptyHit(): PrimitiveHit {
  return { hit: false, evidence: [], count: 0 };
}

function normalizeSteps(raw: unknown): PathologyStep[] {
  const out: PathologyStep[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isNum(o.at)) continue;
    const step: PathologyStep = { at: o.at };
    const tool = str(o.tool);
    const file = str(o.file);
    const argsHash = str(o.argsHash);
    const decision = str(o.decision);
    if (tool) step.tool = tool;
    if (file) step.file = file;
    if (argsHash) step.argsHash = argsHash;
    if (decision) step.decision = decision;
    if (typeof o.ok === "boolean") step.ok = o.ok;
    out.push(step);
  }
  return out;
}

function normalizeEdits(raw: unknown): PathologyEdit[] {
  const out: PathologyEdit[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const file = str(o.file);
    if (!isNum(o.at) || !file) continue;
    out.push({
      at: o.at,
      file,
      beforeHash: str(o.beforeHash),
      afterHash: str(o.afterHash),
    });
  }
  return out;
}

function normalizeAsks(raw: unknown): PathologyAsk[] {
  const out: PathologyAsk[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!isNum(o.at) || !id) continue;
    const ask: PathologyAsk = { at: o.at, id };
    if (isNum(o.resolvedAt)) ask.resolvedAt = o.resolvedAt;
    out.push(ask);
  }
  return out;
}

function normalizeReads(raw: unknown): PathologyRead[] {
  const out: PathologyRead[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ref = str(o.ref);
    if (!isNum(o.at) || !ref) continue;
    const read: PathologyRead = { at: o.at, ref };
    const version = str(o.version);
    if (version) read.version = version;
    if (o.expired === true) read.expired = true;
    out.push(read);
  }
  return out;
}

function normalizeSessions(raw: unknown): PathologySession[] {
  const out: PathologySession[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    if (!id) continue;
    const files = asArray(o.files)
      .map((f) => str(f))
      .filter((f) => f.length > 0);
    out.push({ id, files });
  }
  return out;
}

function normalizeChangeNodes(raw: unknown): PathologyChangeNode[] {
  const out: PathologyChangeNode[] = [];
  for (const item of asArray(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isNum(o.at) || !isNum(o.fanoutEdges)) continue;
    out.push({ at: o.at, fanoutEdges: o.fanoutEdges });
  }
  return out;
}

interface NormalizedTrace {
  steps: PathologyStep[];
  edits: PathologyEdit[];
  asks: PathologyAsk[];
  reads: PathologyRead[];
  sessions: PathologySession[];
  changeNodes: PathologyChangeNode[];
}

function normalizeTrace(
  trace: PathologyTrace | undefined | null): NormalizedTrace {
  const t = (trace && typeof trace === "object" ? trace : {}) as Record<
    string,
    unknown
  >;
  return {
    steps: normalizeSteps(t.steps).sort((a, b) => a.at - b.at),
    edits: normalizeEdits(t.edits),
    asks: normalizeAsks(t.asks),
    reads: normalizeReads(t.reads),
    sessions: normalizeSessions(t.sessions),
    changeNodes: normalizeChangeNodes(t.changeNodes),
  };
}

function resolveWindow(opts?: DetectOptions): number {
  const w = opts && isNum(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  return w > 0 ? w : DEFAULT_WINDOW_MS;
}

function resolveMinRepeats(opts?: DetectOptions): number {
  const m =
    opts && isNum(opts.minRepeats)
      ? Math.floor(opts.minRepeats)
      : DEFAULT_MIN_REPEATS;
  return m >= 2 ? m : DEFAULT_MIN_REPEATS;
}

/** 排序后的时间序列在固定窗口内的最大重复次数(窗口按每次出现向后延伸滚动)。 */
function maxInWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0; i < times.length; i += 1) {
    const start = times[i] ?? 0;
    let j = i;
    while (j + 1 < times.length && (times[j + 1] ?? 0) - start <= windowMs)
      j += 1;
    const size = j - i + 1;
    if (size > best) best = size;
  }
  return best;
}

// ---------------------------------------------------------------- 六原语检测

/** re-entry:同一 key(tool > file > argsHash)在窗口内重复 ≥ minRepeats 次。 */
function detectReEntry(
  steps: PathologyStep[],
  windowMs: number,
  minRepeats: number): PrimitiveHit {
  const hit = emptyHit();
  const groups = new Map<string, number[]>();
  for (const step of steps) {
    const key = step.tool
      ? `tool:${step.tool}`
      : step.file
        ? `file:${step.file}`
        : step.argsHash
          ? `args:${step.argsHash}`
          : "";
    if (!key) continue;
    const times = groups.get(key) ?? [];
    times.push(step.at);
    groups.set(key, times);
  }
  for (const [key, times] of groups) {
    const max = maxInWindow(
      times.sort((a, b) => a - b),
      windowMs);
    if (max < minRepeats) continue;
    hit.hit = true;
    hit.count += max - minRepeats + 1;
    hit.evidence.push(`re-entry ${key} x${max}/${windowMs}ms`);
  }
  return hit;
}

/** 相邻三连里的「A,B,A」次数 = 来回反复次数(A,B,A 记 1,A,B,A,B 记 2)。 */
function backAndForth(seq: string[]): number {
  let n = 0;
  for (let i = 0; i + 2 < seq.length; i += 1) {
    if (seq[i] === seq[i + 2] && seq[i] !== seq[i + 1]) n += 1;
  }
  return n;
}

/** reversal:同文件编辑回到此前出现过的状态(≥3 次编辑),或决策序列反复 ≥2 次。 */
function detectReversal(
  steps: PathologyStep[],
  edits: PathologyEdit[],
): PrimitiveHit {
  const hit = emptyHit();

  const byFile = new Map<string, PathologyEdit[]>();
  for (const edit of edits) {
    const list = byFile.get(edit.file) ?? [];
    list.push(edit);
    byFile.set(edit.file, list);
  }
  let loopCount = 0;
  for (const [file, list] of byFile) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const states = [
      sorted[0]?.beforeHash ?? "",
      ...sorted.map((e) => e.afterHash),
    ];
    const seen = new Map<string, number>();
    let loops = 0;
    let loopEvidence = "";
    for (let i = 0; i < states.length; i += 1) {
      const state = states[i];
      if (state && seen.has(state)) {
        loops += 1;
        if (!loopEvidence) {
          const from = seen.get(state) as number;
          loopEvidence = `reversal file:${file} ${states.slice(from, i + 1).join("→")}`;
        }
      }
      if (state) seen.set(state, i);
    }
    if (loops > 0) {
      loopCount += loops;
      hit.evidence.push(loopEvidence);
    }
  }

  const globalSeq = steps
    .map((s) => s.decision)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  const globalFlips = backAndForth(globalSeq);
  const byFileDecision = new Map<string, string[]>();
  for (const step of steps) {
    if (!step.file || !step.decision) continue;
    const list = byFileDecision.get(step.file) ?? [];
    list.push(step.decision);
    byFileDecision.set(step.file, list);
  }
  let fileFlips = 0;
  for (const [file, seq] of byFileDecision) {
    const n = backAndForth(seq);
    if (n > 0) {
      fileFlips += n;
      hit.evidence.push(`reversal decisions file:${file} flips=${n}`);
    }
  }
  // 反转次数取「同一 file 维度」与「全局维度」的较大者,不做相加:
  // 带 file 的步骤同时出现在两条序列里,相加会把 A,B,A 一次反复算成 2 次而误判命中。
  const flips = Math.max(globalFlips, fileFlips);
  if (globalFlips > 0) {
    // 全局反转也留一条证据,便于人工复盘
    hit.evidence.push(`reversal decisions global flips=${globalFlips}`);
  }

  hit.count = loopCount + flips;
  // 回环一次即命中;决策来回必须 ≥2 次才算反复(2 次只算一次纠偏)。
  hit.hit = loopCount > 0 || flips >= 2;
  return hit;
}

/** fanout:扇出边 ≥2 的变更节点,或一次编辑后窗口内同文件 ≥2 次失败。 */
function detectFanout(
  steps: PathologyStep[],
  edits: PathologyEdit[],
  changeNodes: PathologyChangeNode[],
  windowMs: number): PrimitiveHit {
  const hit = emptyHit();
  for (const node of changeNodes) {
    if (node.fanoutEdges < 2) continue;
    hit.count += 1;
    hit.evidence.push(
      `fanout change-node @${node.at} edges=${node.fanoutEdges}`,
    );
  }
  for (const edit of edits) {
    const fixes = steps.filter(
      (s) =>
        s.file === edit.file &&
        s.ok === false &&
        s.at >= edit.at &&
        s.at - edit.at <= windowMs);
    if (fixes.length < 2) continue;
    hit.count += 1;
    hit.evidence.push(
      `fanout edit ${edit.file} @${edit.at} → ${fixes.length} fix edges`,
    );
  }
  hit.hit = hit.count > 0;
  return hit;
}

/** overlap:两会话文件相交,且时间区间重叠(区间不可得视为重叠)。 */
function detectOverlap(
  steps: PathologyStep[],
  sessions: PathologySession[],
): PrimitiveHit {
  const hit = emptyHit();
  const intervalOf = (
    session: PathologySession): { min: number; max: number } | undefined => {
    const times = steps
      .filter((s) => s.file && session.files.includes(s.file))
      .map((s) => s.at);
    if (times.length === 0) return undefined;
    return { min: Math.min(...times), max: Math.max(...times) };
  };
  for (let i = 0; i < sessions.length; i += 1) {
    const a = sessions[i];
    if (!a) continue;
    for (let j = i + 1; j < sessions.length; j += 1) {
      const b = sessions[j];
      if (!b) continue;
      const shared = a.files.filter((f) => b.files.includes(f));
      if (shared.length === 0) continue;
      const ia = intervalOf(a);
      const ib = intervalOf(b);
      const overlapping = !ia || !ib || (ia.min <= ib.max && ib.min <= ia.max);
      if (!overlapping) continue;
      hit.count += 1;
      hit.evidence.push(`overlap ${shared.join(",")}: ${a.id}∩${b.id}`);
    }
  }
  hit.hit = hit.count > 0;
  return hit;
}

/** dangling:提问无 resolvedAt,或失败后同文件/全局再无成功步骤。 */
function detectDangling(
  steps: PathologyStep[],
  asks: PathologyAsk[],
): PrimitiveHit {
  const hit = emptyHit();
  for (const ask of asks) {
    if (isNum(ask.resolvedAt)) continue;
    hit.count += 1;
    hit.evidence.push(`dangling ask ${ask.id} unresolved`);
  }
  const ordered = [...steps].sort((a, b) => a.at - b.at);
  for (let i = 0; i < ordered.length; i += 1) {
    const step = ordered[i];
    if (!step || step.ok !== false) continue;
    const fixedAfter = ordered.slice(i + 1).some((later) => {
      if (later.ok !== true) return false;
      return step.file ? later.file === step.file : true;
    });
    if (fixedAfter) continue;
    hit.count += 1;
    const label = step.tool ? ` tool:${step.tool}` : "";
    const file = step.file ? ` ${step.file}` : "";
    hit.evidence.push(`dangling step${label}${file} ok=false no fix`);
  }
  hit.hit = hit.count > 0;
  return hit;
}

/** decay:读到过期内容,或同一 ref(同 version/无 version)重复读 ≥3 次。 */
function detectDecay(reads: PathologyRead[]): PrimitiveHit {
  const hit = emptyHit();
  for (const read of reads) {
    if (read.expired !== true) continue;
    hit.count += 1;
    hit.evidence.push(`decay read ${read.ref} expired`);
  }
  const groups = new Map<string, number>();
  for (const read of reads) {
    const key = `${read.ref}@${read.version ?? ""}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, times] of groups) {
    if (times < 3) continue;
    hit.count += 1;
    const ref = key.slice(0, key.lastIndexOf("@"));
    hit.evidence.push(`decay read ${ref} x${times}`);
  }
  hit.hit = hit.count > 0;
  return hit;
}

/** 六原语一次算完:返回固定顺序的 Record,绝不抛。 */
export function detectPrimitives(
  trace: PathologyTrace | undefined | null,
  opts?: DetectOptions): Record<PathologyPrimitive, PrimitiveHit> {
  const result: Record<PathologyPrimitive, PrimitiveHit> = {
    "re-entry": emptyHit(),
    reversal: emptyHit(),
    fanout: emptyHit(),
    overlap: emptyHit(),
    dangling: emptyHit(),
    decay: emptyHit(),
  };
  try {
    const t = normalizeTrace(trace);
    const windowMs = resolveWindow(opts);
    const minRepeats = resolveMinRepeats(opts);
    result["re-entry"] = detectReEntry(t.steps, windowMs, minRepeats);
    result.reversal = detectReversal(t.steps, t.edits);
    result.fanout = detectFanout(t.steps, t.edits, t.changeNodes, windowMs);
    result.overlap = detectOverlap(t.steps, t.sessions);
    result.dangling = detectDangling(t.steps, t.asks);
    result.decay = detectDecay(t.reads);
  } catch {
    // 红线:检测器绝不把异常抛给调用方;任一原语失败只损失该原语的信息。
  }
  return result;
}

// ---------------------------------------------------------------- 形态目录

function normalizeCatalog(
  catalog: PathologyForm[] | undefined | null): PathologyForm[] {
  return Array.isArray(catalog)
    ? catalog.filter((f): f is PathologyForm => !!f && typeof f === "object")
    : DEFAULT_CATALOG;
}

/** 签名规范化:丢弃未知原语与重复项,按 PATHOLOGY_PRIMITIVES 顺序排序。 */
function normalizeSignature(signature: unknown): PathologyPrimitive[] {
  const set = new Set<PathologyPrimitive>();
  for (const item of asArray(signature)) {
    if (isPrimitive(item)) set.add(item);
  }
  return PATHOLOGY_PRIMITIVES.filter((p) => set.has(p));
}

/** 保持形态自身书写顺序的签名(展示用):只丢弃未知原语与重复项。 */
function orderedSignature(signature: unknown): PathologyPrimitive[] {
  const seen = new Set<PathologyPrimitive>();
  const out: PathologyPrimitive[] = [];
  for (const item of asArray(signature)) {
    if (!isPrimitive(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** 按字符串键排序(字典序,不依赖 locale,保证跨环境确定性)。 */
function sortByKey<T>(rows: T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

const DEFAULT_CATALOG: PathologyForm[] = [
  {
    id: "oscillation",
    family: "rework-chain",
    signature: ["reversal", "re-entry"],
    description: "在两种错误之间来回改:要的是取舍决策,不是更快的转向",
    interventions: [
      { carrier: "tip", detail: "先写清两种方案的取舍点,再决定往哪边改" },
      {
        carrier: "decision-gate",
        detail: "回改同一处前必须先给出取舍结论,否则阻断",
      },
      { carrier: "tool", detail: "把两种改法的判定脚本固化成可执行校验" },
    ],
    tipAllowed: true,
    builtin: true,
  },
  {
    id: "patch-pileup",
    family: "evolution-chain",
    signature: ["re-entry", "fanout"],
    description: "一遍遍局部补丁堆出多次救火:根因是点替换,面没换",
    interventions: [
      {
        carrier: "refactor-task",
        detail: "把点替换升级成面替换,立独立重构任务",
      },
      { carrier: "contract-ledger", detail: "登记受影响的契约面清单,逐条勾销" },
      { carrier: "invariant-assert", detail: "给被反复破坏的不变量补断言" },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "contract-drift",
    family: "evolution-chain",
    signature: ["reversal", "fanout", "decay"],
    description: "契约语义在多次回改中漂移,依赖方读到的是旧版本口径",
    interventions: [
      {
        carrier: "contract-ledger",
        detail: "把契约版本与语义写入账本,变更留痕",
      },
      {
        carrier: "invariant-assert",
        detail: "契约不变量用断言固化,漂移即失败",
      },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "dead-end-spin",
    family: "waste",
    signature: ["re-entry", "dangling"],
    description: "在死路上反复重试且失败无人接手:缺的是止损判据,不是更多尝试",
    interventions: [
      {
        carrier: "negative-kb",
        detail: "把这条死路写进负向知识库,禁止重复尝试",
      },
      {
        carrier: "no-progress-detector",
        detail: "连续无进展即触发中止,而不是继续重试",
      },
      { carrier: "capability-index", detail: "换一条已有能力索引里的可用路径" },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "repeat-exploration",
    family: "waste",
    signature: ["re-entry", "overlap"],
    description: "多个会话重复探索同一片区域:缺的是世界模型与检索范围约定",
    interventions: [
      { carrier: "world-model", detail: "把已探索区域沉淀成世界模型,先查再探" },
      { carrier: "capability-index", detail: "按能力索引复用已有结论" },
      {
        carrier: "search-scope",
        detail: "显式声明本次检索范围,避免与他人重叠",
      },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "parallel-clash",
    family: "coordination",
    signature: ["overlap", "fanout"],
    description: "并行会话改动范围相交并互相引爆:缺的是认领锁与范围划分",
    interventions: [
      { carrier: "claim-lock", detail: "改动前先认领文件,冲突即等待而非硬改" },
      { carrier: "search-scope", detail: "按范围划分并行任务,交集部分串行" },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "blind-spot",
    family: "statistics",
    signature: ["dangling", "decay"],
    description: "关键信息悬空且引用了过期口径:缺的是清单与定向取证",
    interventions: [
      { carrier: "checklist", detail: "悬空项进清单,收尾前逐项确认为已解决" },
      { carrier: "targeted-tool", detail: "对过期来源做定向重取,不用记忆作答" },
    ],
    tipAllowed: false,
    builtin: true,
  },
  {
    id: "rule-bloat",
    family: "meta",
    signature: ["re-entry", "decay", "overlap"],
    description: "规则越叠越多且互相重叠、部分已过期:要的是剪枝预算,不是新规则",
    interventions: [
      {
        carrier: "pruning-budget",
        detail: "给规则集设剪枝预算,过期重叠项按预算删除",
      },
    ],
    tipAllowed: false,
    builtin: true,
  },
];

export { DEFAULT_CATALOG };

/** 活跃原语集合:Record 取 hit=true,或原语数组。顺序恒为 PATHOLOGY_PRIMITIVES。 */
function activePrimitives(
  primitives:
    Record<PathologyPrimitive, PrimitiveHit> | readonly PathologyPrimitive[],
): PathologyPrimitive[] {
  if (Array.isArray(primitives)) {
    return normalizeSignature(primitives);
  }
  if (!primitives || typeof primitives !== "object") return [];
  const record = primitives as Record<string, PrimitiveHit | undefined>;
  const set = new Set<PathologyPrimitive>();
  for (const primitive of PATHOLOGY_PRIMITIVES) {
    const hit = record[primitive];
    if (hit && typeof hit === "object" && hit.hit === true) set.add(primitive);
  }
  return PATHOLOGY_PRIMITIVES.filter((p) => set.has(p));
}

/** 候选形态的族建议:按固定顺序判断,先命中先返回。 */
function suggestFamily(active: PathologyPrimitive[]): PathologyFamily {
  const has = (p: PathologyPrimitive) => active.includes(p);
  if (has("reversal") && has("decay")) return "evolution-chain";
  if (has("reversal")) return "rework-chain";
  if (has("overlap") && has("fanout")) return "coordination";
  if (has("fanout")) return "coordination";
  if (has("dangling")) return "waste";
  if (has("overlap")) return "waste";
  return "statistics";
}

/**
 * 形态匹配:form.signature ⊆ 活跃原语 即命中;未命中且活跃原语 ≥2 时给恰好 1 条候选。
 * 候选是形态库的生长入口——不要在这里自动登记形态,登记必须走 registerForm。
 */
export function matchForms(
  primitives:
    Record<PathologyPrimitive, PrimitiveHit> | readonly PathologyPrimitive[],
  catalog?: PathologyForm[],
): {
  matched: {
    form: PathologyForm;
    matchedSignature: PathologyPrimitive[];
    extraPrimitives: PathologyPrimitive[];
  }[];
  candidates: {
    signature: PathologyPrimitive[];
    familySuggestion: PathologyFamily;
    reason: string;
  }[];
  codes: string[];
} {
  const active = activePrimitives(primitives);
  const activeSet = new Set(active);
  const forms = normalizeCatalog(catalog);
  const matched = sortByKey(
    forms
      .filter((form) => {
        const sig = normalizeSignature(form.signature);
        return sig.length > 0 && sig.every((p) => activeSet.has(p));
      })
      .map((form) => {
        const signature = normalizeSignature(form.signature);
        const signatureForDisplay = orderedSignature(form.signature);
        return {
          form,
          matchedSignature: signatureForDisplay,
          extraPrimitives: active.filter((p) => !signature.includes(p)),
        };
      }),
    (row) => row.form.id);

  if (matched.length > 0) {
    return { matched, candidates: [], codes: [PATHOLOGY_CODES.MATCHED] };
  }
  if (active.length < 2) {
    return { matched: [], candidates: [], codes: [PATHOLOGY_CODES.NO_MATCH] };
  }
  const familySuggestion = suggestFamily(active);
  return {
    matched: [],
    candidates: [
      {
        signature: [...active],
        familySuggestion,
        reason: `活跃原语 ${active.join("+")} 未命中内置形态,建议按 ${familySuggestion} 族评估新形态`,
      },
    ],
    codes: [PATHOLOGY_CODES.NEW_CANDIDATE],
  };
}

function hashSignature(signature: PathologyPrimitive[]): string {
  return createHash("sha256")
    .update(signature.join("|"))
    .digest("hex")
    .slice(0, 8);
}

function sameSignature(
  a: PathologyPrimitive[],
  b: PathologyPrimitive[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p === b[i]);
}

/**
 * 登记形态:签名集合相等即视为重复(幂等,返回既有形态,不改目录);
 * 新组合生成 custom-<hash8>,同输入恒同 id。
 */
export function registerForm(
  catalog: PathologyForm[],
  input: {
    family: PathologyFamily;
    signature: PathologyPrimitive[];
    interventions?: PathologyIntervention[];
    description?: string;
  },
): { catalog: PathologyForm[]; form: PathologyForm; codes: string[] } {
  const forms = normalizeCatalog(catalog);
  const placeholder: PathologyForm = {
    id: "",
    family: "statistics",
    signature: [],
    description: "",
    interventions: [],
    tipAllowed: false,
    builtin: false,
  };
  const raw = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const family = raw.family;
  if (!isFamily(family)) {
    return {
      catalog: forms,
      form: placeholder,
      codes: [PATHOLOGY_CODES.INVALID],
    };
  }
  const rawSignature = asArray(raw.signature);
  // 含未知原语一律判非法(不做静默丢弃):静默丢弃会把 ['re-entry','nope'] 登记成新形态。
  if (rawSignature.some((item) => !isPrimitive(item))) {
    return {
      catalog: forms,
      form: placeholder,
      codes: [PATHOLOGY_CODES.INVALID],
    };
  }
  const signature = normalizeSignature(rawSignature);
  if (signature.length === 0) {
    return {
      catalog: forms,
      form: placeholder,
      codes: [PATHOLOGY_CODES.INVALID],
    };
  }

  for (const form of forms) {
    if (sameSignature(normalizeSignature(form.signature), signature)) {
      return { catalog: forms, form, codes: [PATHOLOGY_CODES.FORM_DUPLICATE] };
    }
  }

  const provided = Array.isArray(raw.interventions)
    ? (raw.interventions as unknown[]).filter(
        (item): item is PathologyIntervention =>
          !!item &&
          typeof item === "object" &&
          isCarrier((item as Record<string, unknown>).carrier),
      )
    : [];
  const interventions: PathologyIntervention[] =
    provided.length > 0
      ? provided.map((item) => ({
          carrier: item.carrier,
          detail: str(item.detail) || CUSTOM_DETAIL,
        }))
      : FAMILY_DEFAULT_CARRIERS[family].map((carrier) => ({
          carrier,
          detail: CUSTOM_DETAIL,
        }));

  const form: PathologyForm = {
    id: `custom-${hashSignature(signature)}`,
    family,
    signature,
    description:
      str(raw.description) ||
      `新组合 ${signature.join("+")}:待人工确认族归属与干预载体`,
    interventions,
    tipAllowed: family === "rework-chain",
    builtin: false,
  };
  return {
    catalog: [...forms, form],
    form,
    codes: [PATHOLOGY_CODES.FORM_REGISTERED],
  };
}

/**
 * 干预路由:tip 门在这里落地——form.tipAllowed === false 时先剔除 tip 载体;
 * 调用方显式 requestTip 但形态禁止 tip 时追加 TIP_FORBIDDEN,便于上层提示而非静默丢弃。
 */
export function routeInterventions(
  form: PathologyForm,
  opts?: { requestTip?: boolean },
): { carriers: PathologyIntervention[]; tipAllowed: boolean; codes: string[] } {
  if (!form || typeof form !== "object" || typeof form.id !== "string") {
    return {
      carriers: [],
      tipAllowed: false,
      codes: [PATHOLOGY_CODES.INVALID],
    };
  }
  const tipAllowed = form.tipAllowed === true;
  const base = Array.isArray(form.interventions)
    ? form.interventions.filter((i) => i && isCarrier(i.carrier))
    : [];
  const carriers = tipAllowed
    ? base.map((i) => ({ carrier: i.carrier, detail: str(i.detail) }))
    : base
        .filter((i) => i.carrier !== "tip")
        .map((i) => ({ carrier: i.carrier, detail: str(i.detail) }));
  const codes: string[] = [];
  if (opts && opts.requestTip === true && !tipAllowed)
    codes.push(PATHOLOGY_CODES.TIP_FORBIDDEN);
  return { carriers, tipAllowed, codes };
}

/** 族内优先级:靠前载体优先,未知载体从 4 起顺序后排。 */
function priorityOf(
  family: PathologyFamily,
  carrier: InterventionCarrier,
  index: number,
  unknownOffset: number): number {
  if (family === "rework-chain") {
    if (carrier === "tip") return 1;
    if (carrier === "decision-gate") return 2;
    if (carrier === "tool") return 3;
    return 4 + unknownOffset;
  }
  if (family === "evolution-chain") {
    if (carrier === "refactor-task") return 1;
    if (carrier === "contract-ledger") return 2;
    if (carrier === "invariant-assert") return 3;
    return 4 + unknownOffset;
  }
  return index + 1;
}

/**
 * 干预计划:steps 按优先级升序。experimentRequired 恒 true——
 * 任何干预上线都必须先走 #192 实验账本(对照 + 指标 + 回滚),不允许直接进上下文。
 */
export function buildInterventionPlan(
  match: {
    form: PathologyForm;
    matchedSignature?: PathologyPrimitive[];
    extraPrimitives?: PathologyPrimitive[];
  },
  opts?: { requestTip?: boolean },
): {
  steps: { carrier: InterventionCarrier; detail: string; priority: number }[];
  experimentRequired: boolean;
  codes: string[];
} {
  const form = match && typeof match === "object" ? match.form : undefined;
  if (
    !form ||
    typeof form !== "object" ||
    typeof form.id !== "string" ||
    form.id.length === 0
  ) {
    return {
      steps: [],
      experimentRequired: true,
      codes: [PATHOLOGY_CODES.INVALID],
    };
  }
  const family: PathologyFamily = isFamily(form.family)
    ? form.family
    : "statistics";
  const routed = routeInterventions(form, opts);
  const unknownSeen = new Map<InterventionCarrier, number>();
  const steps = routed.carriers.map((item, index) => {
    let unknownOffset = 0;
    if (family === "rework-chain" || family === "evolution-chain") {
      unknownOffset = unknownSeen.get(item.carrier) ?? unknownSeen.size;
      unknownSeen.set(item.carrier, unknownOffset);
    }
    return {
      carrier: item.carrier,
      detail: item.detail,
      priority: priorityOf(family, item.carrier, index, unknownOffset),
    };
  });
  steps.sort((a, b) => a.priority - b.priority);
  return { steps, experimentRequired: true, codes: routed.codes };
}

/** 审计行:按 formId 字典序,carrier 清单遵守 tip 门(禁 tip 形态不出现 tip)。 */
export function toAuditRows(
  matches: { form: PathologyForm }[],
): {
  formId: string;
  family: PathologyFamily;
  carriers: InterventionCarrier[];
  tipAllowed: boolean;
}[] {
  const rows: {
    formId: string;
    family: PathologyFamily;
    carriers: InterventionCarrier[];
    tipAllowed: boolean;
  }[] = [];
  for (const item of asArray(matches)) {
    if (!item || typeof item !== "object") continue;
    const form = (item as { form?: PathologyForm }).form;
    if (
      !form ||
      typeof form !== "object" ||
      typeof form.id !== "string" ||
      form.id.length === 0
    )
      continue;
    const tipAllowed = form.tipAllowed === true;
    const carriers = (
      Array.isArray(form.interventions) ? form.interventions : []
    )
      .filter((i) => i && isCarrier(i.carrier))
      .map((i) => i.carrier)
      .filter((c) => tipAllowed || c !== "tip");
    rows.push({
      formId: form.id,
      family: isFamily(form.family) ? form.family : "statistics",
      carriers,
      tipAllowed,
    });
  }
  return sortByKey(rows, (row) => row.formId);
}

/** 目录渲染:纯文本,首行给总数与 tip 允许数,每行一个形态。 */
export function renderCatalog(catalog?: PathologyForm[]): string {
  const forms = sortByKey(normalizeCatalog(catalog), (form) => form.id);
  const tipAllowedCount = forms.filter((f) => f.tipAllowed === true).length;
  const lines = [
    `pathology catalog v${PATHOLOGY_VERSION} forms=${forms.length} tipAllowed=${tipAllowedCount}`,
  ];
  for (const form of forms) {
    const signature = orderedSignature(form.signature);
    const carriers = (
      Array.isArray(form.interventions) ? form.interventions : []
    )
      .filter((i) => i && isCarrier(i.carrier))
      .map((i) => i.carrier)
      .filter((c) => form.tipAllowed === true || c !== "tip");
    lines.push(
      `- ${form.id} [${form.family}] ${signature.join("+")} → ${carriers.join(",")} tip=${form.tipAllowed === true}`,
    );
  }
  return lines.join("\n");
}
