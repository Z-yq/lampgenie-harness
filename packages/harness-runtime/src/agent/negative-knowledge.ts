/**
 * 负面知识库 / 死路账本(Negative Knowledge Base, #215):把「这条路过不通」沉淀成可检索、
 * 可过期、可翻案的账本,并在规划阶段注入,避免 RSI 反复踩同一条死路。
 * 为什么要单独一层:
 * - 正面经验图谱(#191 evidence-graph)只记「什么有效」,不记「什么试过且失败」。缺了死路账本,
 *   agent 会在同一类任务上重复消耗预算重走同一条路,且无法解释「我为什么不走那条路」。
 * - 死路账本必须可翻案:环境变化(依赖升级/凭证到位)后旧死路会失效,所以需要 invalidWhen、
 *   expiresAt 与 revive(带纠正记录)三件套,否则账本会固化成迷信。
 * - 检索要可解释:每条命中都带 reasons(为什么召回),规划注入只放「此路不通|原因|替代」三要素,
 *   不额外解释成本。
 * 纯逻辑:零 IO——只 import node:crypto 做 sha256,不读文件 / 网络 / 环境,不用真实时钟参与打分
 * (now 一律由参数或 opts.now 注入,缺省才回落 Date.now 只用于 createdAt/at 这类审计字段)。
 * 所有导出函数同步且不抛异常:非法输入返回安全空值并带稳定码(NEGKB_*),调用方按码分支。
 */

import { createHash } from "node:crypto";

/** 账本 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const NEGATIVE_KB_VERSION = 1;

/** 失败证据种类:error=运行报错,human-correction=人工纠正,abandon=会话放弃,test-failure=测试失败,other=其他。 */
export const FAILURE_EVIDENCE_KINDS = ["error", "human-correction", "abandon", "test-failure", "other"] as const;

export type FailureEvidenceKind = (typeof FAILURE_EVIDENCE_KINDS)[number];

/** 一条失败证据:为什么判定此路不通、何时、可回指的原始证据。 */
export interface FailureEvidence {
  kind: FailureEvidenceKind;
  detail: string;
  at: number;
  ref?: string;
}

/** 适用范围:越精确,召回越少但越准。keywords 逐字(小写)比对。 */
export interface DeadEndScope {
  taskClass?: string;
  module?: string;
  keywords: string[];
}

/** 当时上下文:工具链与症状,用于人工排查与 invalidWhen 判断,不参与打分(module/taskClass 除外)。 */
export interface DeadEndContext {
  taskClass?: string;
  module?: string;
  tools?: string[];
  symptoms?: string[];
}

/** 一次纠正(翻案):谁在何时为什么推翻这条死路,可附新证据。 */
export interface DeadEndCorrection {
  at: number;
  by: string;
  reason: string;
  newEvidence?: string;
}

/** 一条死路记录。status:active=有效,revived=被翻案,expired=过期。 */
export interface DeadEndRecord {
  id: string;
  plan: string;
  context: DeadEndContext;
  failureEvidence: FailureEvidence[];
  scope: DeadEndScope;
  invalidWhen?: string[];
  alternative?: string;
  confidence: number;
  evidenceRefs: string[];
  status: "active" | "revived" | "expired";
  corrections: DeadEndCorrection[];
  createdAt: number;
  expiresAt?: number;
}

/** 稳定码:调用方按码分支,不解析文案。 */
export const NEGKB_INVALID = "NEGKB_INVALID";
export const NEGKB_RECORDED = "NEGKB_RECORDED";
export const NEGKB_DUPLICATE = "NEGKB_DUPLICATE";
export const NEGKB_MATCH = "NEGKB_MATCH";
export const NEGKB_NO_MATCH = "NEGKB_NO_MATCH";
export const NEGKB_EXPIRED = "NEGKB_EXPIRED";
export const NEGKB_REVIVED = "NEGKB_REVIVED";
export const NEGKB_ALREADY_REVIVED = "NEGKB_ALREADY_REVIVED";
export const NEGKB_LOW_CONFIDENCE = "NEGKB_LOW_CONFIDENCE";

/** 全部稳定码(固定顺序,供下游 store / 观测层枚举)。 */
export const NEGKB_CODES = [
  NEGKB_INVALID,
  NEGKB_RECORDED,
  NEGKB_DUPLICATE,
  NEGKB_MATCH,
  NEGKB_NO_MATCH,
  NEGKB_EXPIRED,
  NEGKB_REVIVED,
  NEGKB_ALREADY_REVIVED,
  NEGKB_LOW_CONFIDENCE,
] as const;

export type NegKbCode = (typeof NEGKB_CODES)[number];

/** 召回/注入的缺省口径:置信度门槛、条数上限、注入字符预算。 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;
export const DEFAULT_RETRIEVE_LIMIT = 5;
export const DEFAULT_INJECT_MAX_CHARS = 800;
/** 注入时内部召回上限:注入按字符预算截断,召回要放宽才不至于被 limit 提前砍掉。 */
export const INJECT_RETRIEVE_LIMIT = 50;
/** 摘要长度:plan 与失败原因在注入文本里的截断长度(按字符,不做词边界处理)。 */
export const SUMMARY_MAX_CHARS = 60;
/** 放弃会话候选:缺省最少几次放弃才算死路。 */
export const DEFAULT_MIN_SESSIONS = 2;

/** 命中项:记录 + 可解释评分。 */
export interface DeadEndHit {
  record: DeadEndRecord;
  score: number;
  reasons: string[];
  alternative?: string;
}

export interface RetrieveQuery {
  planText?: string;
  module?: string;
  taskClass?: string;
  keywords?: string[];
}

export interface RecordDeadEndInput {
  plan: string;
  context?: DeadEndContext;
  failureEvidence?: FailureEvidence[];
  scope?: Partial<DeadEndScope>;
  invalidWhen?: string[];
  alternative?: string;
  confidence?: number;
  evidenceRefs?: string[];
  createdAt?: number;
  expiresAt?: number;
}

export interface RecordDeadEndResult {
  ok: boolean;
  record?: DeadEndRecord;
  codes: string[];
}

export interface RetrieveResult {
  hits: DeadEndHit[];
  codes: string[];
}

export interface ReviveInput {
  by: string;
  reason: string;
  newEvidence?: string;
  at?: number;
}

export interface AbandonSession {
  planText: string;
  module?: string;
  taskClass?: string;
  abandoned: boolean;
  reason?: string;
  at: number;
}

/** 正面经验项:仓库其他模块口径不一,只承诺几个弱字段可选。 */
export type PositiveCandidate = { name?: string; plan?: string; keywords?: string[]; score?: number; [k: string]: unknown };

// ---------------------------------------------------------------------------
// 内部工具:规范化与分词(全纯,无 IO)
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const ALNUM_CHAR = /[\p{L}\p{N}]/u;

function isCjkChar(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return ALNUM_CHAR.test(ch);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asObject<T extends object>(v: unknown): Partial<T> {
  return v && typeof v === "object" ? (v as Partial<T>) : {};
}

/** 文本规范化:trim + 空白折叠 + 小写;非字符串 → ""。 */
export function normalizePlan(plan: string): string {
  if (typeof plan !== "string") return "";
  return plan.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 可读化:trim + 空白折叠,保留大小写(账本 plan 字段给人看)。 */
function collapseText(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** 关键词规范化:逐字小写、去空、去重、升序(排序保证 id 与打分顺序确定)。 */
function normalizeKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    if (typeof raw !== "string") continue;
    const value = normalizePlan(raw);
    if (value) seen.add(value);
  }
  return [...seen].sort();
}

function normalizeStringList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value) out.push(value);
  }
  return out;
}

/**
 * 分词:小写后按「非字母数字且非 CJK」切词;CJK 连续串取二元组(单字串保留单字)。
 * 用于 plan 文本重叠打分(token 重叠数 = 分数)。
 */
export function tokenize(text: unknown): string[] {
  if (typeof text !== "string" || !text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];
  let word = "";
  let cjkRun = "";

  const flushWord = (): void => {
    if (word) {
      out.push(word);
      word = "";
    }
  };
  const flushCjk = (): void => {
    if (!cjkRun) return;
    const chars = [...cjkRun];
    if (chars.length === 1) {
      const only = chars[0];
      if (only) out.push(only);
    } else {
      for (let i = 0; i + 1 < chars.length; i += 1) {
        const a = chars[i];
        const b = chars[i + 1];
        if (a && b) out.push(`${a}${b}`);
      }
    }
    cjkRun = "";
  };

  for (const ch of lower) {
    if (isCjkChar(ch)) {
      flushWord();
      cjkRun += ch;
      continue;
    }
    flushCjk();
    if (isAlnumChar(ch)) {
      word += ch;
    } else {
      flushWord();
    }
  }
  flushWord();
  flushCjk();
  return out;
}

function uniqueTokens(text: unknown): string[] {
  return [...new Set(tokenize(text))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** scope 的规范化串:字段顺序固定、keywords 排序去重 → 同语义同串。 */
function scopeKey(scope: unknown): string {
  const s = asObject<DeadEndScope>(scope);
  const taskClass = normalizePlan(s.taskClass as string);
  const mod = normalizePlan(s.module as string);
  const keywords = normalizeKeywords(s.keywords).join(",");
  return `taskClass=${taskClass};module=${mod};keywords=${keywords}`;
}

function normalizeScope(scope: unknown): DeadEndScope {
  const s = asObject<DeadEndScope>(scope);
  const out: DeadEndScope = { keywords: normalizeKeywords(s.keywords) };
  const taskClass = normalizePlan(s.taskClass as string);
  if (taskClass) out.taskClass = taskClass;
  const mod = normalizePlan(s.module as string);
  if (mod) out.module = mod;
  return out;
}

// ---------------------------------------------------------------------------
// 1) 稳定 id
// ---------------------------------------------------------------------------

/**
 * 死路 id:sha256(规范化 plan + "|" + 排序后的 scope)hex 前 16 位。
 * 同 plan 同 scope 必得同 id(幂等),scope 字段顺序无关,scope 缺失等价于空。
 */
export function deadEndIdOf(input: { plan: string; scope?: Partial<DeadEndScope> }): string {
  const safe = asObject<{ plan: string; scope?: Partial<DeadEndScope> }>(input);
  const plan = normalizePlan(safe.plan as string);
  const digest = createHash("sha256").update(`${plan}|${scopeKey(safe.scope)}`, "utf8").digest("hex");
  return digest.slice(0, 16);
}

// ---------------------------------------------------------------------------
// 2) 记账
// ---------------------------------------------------------------------------

function isEvidence(value: unknown): value is FailureEvidence {
  const v = asObject<FailureEvidence>(value);
  return (
    typeof v.kind === "string" &&
    (FAILURE_EVIDENCE_KINDS as readonly string[]).includes(v.kind) &&
    typeof v.detail === "string" &&
    isFiniteNumber(v.at)
  );
}

function isRecordLike(value: unknown): value is DeadEndRecord {
  const v = asObject<DeadEndRecord>(value);
  return typeof v.id === "string" && v.id.length > 0 && typeof v.plan === "string" && v.plan.length > 0;
}

/**
 * 记一条死路。缺 plan 或缺失败证据 → INVALID(死路必须有证据,否则只是猜测);
 * 同 id 已存在 → DUPLICATE 并回既有记录(含已 expired 的记录,幂等不复活)。
 */
export function recordDeadEnd(
  input: RecordDeadEndInput,
  opts: { now?: number; existing?: DeadEndRecord[] } = {},
): RecordDeadEndResult {
  const safe = asObject<RecordDeadEndInput>(input);
  const plan = collapseText(safe.plan);
  if (!normalizePlan(plan)) return { ok: false, codes: [NEGKB_INVALID] };

  const evidence = (Array.isArray(safe.failureEvidence) ? safe.failureEvidence : []).filter(isEvidence);
  if (evidence.length === 0) return { ok: false, codes: [NEGKB_INVALID] };

  const scope = normalizeScope(safe.scope);
  const id = deadEndIdOf({ plan, scope });

  const existing = Array.isArray(opts?.existing) ? opts.existing : [];
  const duplicate = existing.find((r) => isRecordLike(r) && r.id === id);
  if (duplicate) return { ok: false, record: duplicate, codes: [NEGKB_DUPLICATE] };

  const now = isFiniteNumber(opts?.now) ? opts.now : Date.now();
  const createdAt = isFiniteNumber(safe.createdAt) ? safe.createdAt : now;
  const confidence = clamp01(isFiniteNumber(safe.confidence) ? safe.confidence : 0.6);

  const contextIn = asObject<DeadEndContext>(safe.context);
  const context: DeadEndContext = {};
  const ctxTaskClass = collapseText(contextIn.taskClass);
  if (ctxTaskClass) context.taskClass = ctxTaskClass;
  const ctxModule = collapseText(contextIn.module);
  if (ctxModule) context.module = ctxModule;
  const tools = normalizeStringList(contextIn.tools);
  if (tools.length) context.tools = tools;
  const symptoms = normalizeStringList(contextIn.symptoms);
  if (symptoms.length) context.symptoms = symptoms;

  const invalidWhen = normalizeStringList(safe.invalidWhen);
  const alternative = collapseText(safe.alternative);

  const record: DeadEndRecord = {
    id,
    plan,
    context,
    failureEvidence: evidence.map((e) => ({
      kind: e.kind,
      detail: e.detail,
      at: e.at,
      ...(typeof e.ref === "string" && e.ref ? { ref: e.ref } : {}),
    })),
    scope,
    confidence,
    evidenceRefs: normalizeStringList(safe.evidenceRefs),
    status: "active",
    corrections: [],
    createdAt,
  };
  if (invalidWhen.length) record.invalidWhen = invalidWhen;
  if (alternative) record.alternative = alternative;
  if (isFiniteNumber(safe.expiresAt)) record.expiresAt = safe.expiresAt;

  return { ok: true, record, codes: [NEGKB_RECORDED] };
}

// ---------------------------------------------------------------------------
// 3) 检索
// ---------------------------------------------------------------------------

function scoreRecord(record: DeadEndRecord, q: { keywords: string[]; module: string; taskClass: string; tokens: Set<string> }): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  const recordKeywords = new Set(normalizeKeywords(record.scope?.keywords));
  for (const keyword of q.keywords) {
    if (recordKeywords.has(keyword)) {
      score += 2;
      reasons.push(`keyword:${keyword}`);
    }
  }

  const modules = new Set(
    [normalizePlan(record.scope?.module as string), normalizePlan(record.context?.module as string)].filter(Boolean),
  );
  if (q.module && modules.has(q.module)) {
    score += 3;
    reasons.push(`module:${q.module}`);
  }

  const taskClasses = new Set(
    [normalizePlan(record.scope?.taskClass as string), normalizePlan(record.context?.taskClass as string)].filter(Boolean),
  );
  if (q.taskClass && taskClasses.has(q.taskClass)) {
    score += 3;
    reasons.push(`taskClass:${q.taskClass}`);
  }

  if (q.tokens.size > 0) {
    const planTokens = new Set(tokenize(record.plan));
    let overlap = 0;
    for (const token of q.tokens) if (planTokens.has(token)) overlap += 1;
    if (overlap > 0) {
      score += overlap;
      reasons.push(`plan-overlap:${overlap}`);
    }
  }

  return { score, reasons };
}

function isLive(record: DeadEndRecord, now: number, minConfidence: number): boolean {
  if (record.status !== "active" && record.status !== "revived") return false;
  if (isFiniteNumber(record.expiresAt) && record.expiresAt <= now) return false;
  return isFiniteNumber(record.confidence) && record.confidence >= minConfidence;
}

/**
 * 召回死路:只取 active/revived、未过期、置信度过门的记录,按可解释分数排序。
 * 分数 = 关键词交集×2 + module 精确×3 + taskClass 精确×3 + plan token 重叠×1;
 * 排序 score 降序、id 升序;零分不召回(无关记录进注入只会污染上下文)。
 */
export function retrieveDeadEnds(
  records: DeadEndRecord[],
  query: RetrieveQuery,
  opts: { now?: number; minConfidence?: number; limit?: number } = {},
): RetrieveResult {
  const list = Array.isArray(records) ? records : [];
  const now = isFiniteNumber(opts?.now) ? opts.now : Date.now();
  const minConfidence = isFiniteNumber(opts?.minConfidence) ? opts.minConfidence : DEFAULT_MIN_CONFIDENCE;
  const limit = isFiniteNumber(opts?.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_RETRIEVE_LIMIT;

  const safeQuery = asObject<RetrieveQuery>(query);
  const condition = {
    keywords: normalizeKeywords(safeQuery.keywords),
    module: normalizePlan(safeQuery.module as string),
    taskClass: normalizePlan(safeQuery.taskClass as string),
    tokens: new Set(uniqueTokens(safeQuery.planText)),
  };

  const hits: DeadEndHit[] = [];
  for (const raw of list) {
    if (!isRecordLike(raw)) continue;
    const record = raw as DeadEndRecord;
    if (!isLive(record, now, minConfidence)) continue;
    const { score, reasons } = scoreRecord(record, condition);
    if (score <= 0) continue;
    const hit: DeadEndHit = { record, score, reasons };
    const alternative = collapseText(record.alternative);
    if (alternative) hit.alternative = alternative;
    hits.push(hit);
  }

  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));

  const limited = hits.slice(0, limit);
  return { hits: limited, codes: limited.length > 0 ? [NEGKB_MATCH] : [NEGKB_NO_MATCH] };
}

// ---------------------------------------------------------------------------
// 4) 规划期注入
// ---------------------------------------------------------------------------

/** 单条注入文本:`此路不通:<plan 摘要>|原因:<首条证据摘要>|替代:<alternative 或 "暂无">`。 */
export function formatDeadEndBlock(record: DeadEndRecord): string {
  const plan = truncate(collapseText(record.plan), SUMMARY_MAX_CHARS);
  const first = Array.isArray(record.failureEvidence) ? record.failureEvidence[0] : undefined;
  const reason = truncate(collapseText(first?.detail) || "未记录原因", SUMMARY_MAX_CHARS);
  const alternative = collapseText(record.alternative) || "暂无";
  return `此路不通:${plan}|原因:${reason}|替代:${alternative}`;
}

/**
 * 规划期注入:先检索,再按字符预算拼 blocks。
 * 只整条加入(不截断单条文本,截断的"原因"比不给更误导);超预算即停;
 * 首条即便超预算也保留,保证有输出(否则预算太小 = 静默丢失全部死路)。
 */
export function injectAtPlanning(
  records: DeadEndRecord[],
  query: RetrieveQuery,
  opts: { maxChars?: number; minConfidence?: number; now?: number } = {},
): { blocks: string[]; hits: DeadEndHit[] } {
  const maxChars = isFiniteNumber(opts?.maxChars) && opts.maxChars > 0 ? opts.maxChars : DEFAULT_INJECT_MAX_CHARS;
  const { hits } = retrieveDeadEnds(records, query, {
    now: opts?.now,
    minConfidence: opts?.minConfidence,
    limit: INJECT_RETRIEVE_LIMIT,
  });

  const blocks: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const block = formatDeadEndBlock(hit.record);
    if (blocks.length === 0) {
      blocks.push(block);
      used = block.length;
      continue;
    }
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return { blocks, hits };
}

// ---------------------------------------------------------------------------
// 5) 翻案 / 6) 过期
// ---------------------------------------------------------------------------

/**
 * 翻案(revive):expired 或 active → 副本置 revived、追加纠正记录、清掉 expiresAt(既然翻案,旧期限失效)。
 * 已 revived → 原样返回(多次翻案只认第一次,后续只作 ALREADY_REVIVED 观测)。不改入参。
 */
export function reviveDeadEnd(record: DeadEndRecord, input: ReviveInput): { record: DeadEndRecord; codes: string[] } {
  if (!isRecordLike(record)) return { record, codes: [NEGKB_INVALID] };
  if (record.status === "revived") return { record, codes: [NEGKB_ALREADY_REVIVED] };

  const safe = asObject<ReviveInput>(input);
  const corrections = Array.isArray(record.corrections) ? record.corrections : [];
  const correction: DeadEndCorrection = {
    at: isFiniteNumber(safe.at) ? safe.at : Date.now(),
    by: collapseText(safe.by),
    reason: collapseText(safe.reason),
  };
  const newEvidence = collapseText(safe.newEvidence);
  if (newEvidence) correction.newEvidence = newEvidence;

  return {
    record: { ...record, status: "revived", expiresAt: undefined, corrections: [...corrections, correction] },
    codes: [NEGKB_REVIVED],
  };
}

/** 过期扫描:expiresAt <= now 且尚未 expired 的置 expired;已 expired 的不重复列出。返回新数组(不改入参)。 */
export function expireDeadEnds(records: DeadEndRecord[], now: number): { expired: string[]; records: DeadEndRecord[] } {
  const list = Array.isArray(records) ? records : [];
  const at = isFiniteNumber(now) ? now : 0;
  const expired: string[] = [];
  const next = list.map((record) => {
    if (!isRecordLike(record)) return record;
    if (record.status === "expired") return record;
    if (!isFiniteNumber(record.expiresAt) || record.expiresAt > at) return record;
    expired.push(record.id);
    return { ...record, status: "expired" as const };
  });
  return { expired, records: next };
}

// ---------------------------------------------------------------------------
// 7) 与正面经验合并
// ---------------------------------------------------------------------------

function positiveTokens(item: PositiveCandidate): string[] {
  const keywords = normalizeKeywords(item?.keywords);
  const planTokens = uniqueTokens(item?.plan);
  const nameTokens = uniqueTokens(item?.name);
  return [...new Set([...keywords, ...planTokens, ...nameTokens])];
}

/**
 * 合并:死路在前(先讲为什么不通),正面经验在后;若某正面项与该死路有词面交集,
 * 追加一条 note 提醒「先看死路原因」——否则正面经验会把刚记下的死路重新盖掉。
 */
export function mergeWithPositive(
  negativeResult: { hits: DeadEndHit[] },
  positiveResults: PositiveCandidate[],
  opts: { mode?: "dead-end-first" } = {},
): { ordered: Array<{ source: "dead-end" | "positive"; [k: string]: unknown }>; notes: string[] } {
  const hits = Array.isArray(negativeResult?.hits) ? negativeResult.hits : [];
  const positives = Array.isArray(positiveResults) ? positiveResults.filter((p) => p && typeof p === "object") : [];
  void opts?.mode;

  const ordered: Array<{ source: "dead-end" | "positive"; [k: string]: unknown }> = [];
  for (const hit of hits) {
    const entry: { source: "dead-end"; [k: string]: unknown } = {
      source: "dead-end",
      record: hit.record,
      score: hit.score,
      reasons: hit.reasons,
    };
    if (hit.alternative) entry.alternative = hit.alternative;
    ordered.push(entry);
  }
  for (const positive of positives) ordered.push({ ...positive, source: "positive" });

  const notes: string[] = [];
  for (const hit of hits) {
    const recordKeywords = new Set(normalizeKeywords(hit.record?.scope?.keywords));
    if (recordKeywords.size === 0) continue;
    let overlap = false;
    for (const positive of positives) {
      if (positiveTokens(positive).some((token) => recordKeywords.has(token))) {
        overlap = true;
        break;
      }
    }
    if (overlap) notes.push(`有正面经验可用,先看死路原因:${hit.record.id}`);
  }

  return { ordered, notes };
}

// ---------------------------------------------------------------------------
// 8) 从放弃会话生成候选
// ---------------------------------------------------------------------------

/**
 * 从被放弃的会话推断死路:同 planText 累计放弃次数达阈值才成候选(单次放弃多为一次误判)。
 * confidence = min(0.8, 0.5 + 0.1n):天花板 0.8 —— 没有明确失败证据的死路不该到满分。
 */
export function suggestFromAbandons(
  input: { sessions: AbandonSession[] },
  opts: { minSessions?: number } = {},
): { candidates: DeadEndRecord[] } {
  const sessions = Array.isArray(input?.sessions) ? input.sessions : [];
  const minSessions = isFiniteNumber(opts?.minSessions) && opts.minSessions > 0 ? opts.minSessions : DEFAULT_MIN_SESSIONS;

  const groups = new Map<string, AbandonSession[]>();
  for (const raw of sessions) {
    const session = asObject<AbandonSession>(raw);
    if (typeof session.planText !== "string") continue;
    if (session.abandoned !== true) continue;
    if (!normalizePlan(session.planText)) continue;
    const key = normalizePlan(session.planText);
    const bucket = groups.get(key);
    if (bucket) bucket.push(session as AbandonSession);
    else groups.set(key, [session as AbandonSession]);
  }

  const candidates: DeadEndRecord[] = [];
  for (const [, bucket] of groups) {
    const n = bucket.length;
    if (n < minSessions) continue;
    const first = bucket[0];
    if (!first) continue;

    const tokens = uniqueTokens(first.planText).slice(0, 5);
    const scope: DeadEndScope = { keywords: normalizeKeywords(tokens) };
    const moduleName = collapseText(first.module);
    if (moduleName) scope.module = normalizePlan(moduleName);
    const taskClass = collapseText(first.taskClass);
    if (taskClass) scope.taskClass = normalizePlan(taskClass);

    candidates.push({
      id: deadEndIdOf({ plan: first.planText, scope }),
      plan: collapseText(first.planText),
      context: {
        ...(taskClass ? { taskClass } : {}),
        ...(moduleName ? { module: moduleName } : {}),
      },
      failureEvidence: bucket.map((session) => ({
        kind: "abandon" as const,
        detail: collapseText(session.reason) || "session 放弃",
        at: isFiniteNumber(session.at) ? session.at : 0,
      })),
      scope,
      confidence: Math.min(0.8, 0.5 + 0.1 * n),
      evidenceRefs: [],
      status: "active",
      corrections: [],
      createdAt: Math.min(...bucket.map((session) => (isFiniteNumber(session.at) ? session.at : 0))),
    });
  }

  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { candidates };
}

// ---------------------------------------------------------------------------
// 9) 证据图谱投影(#191 消费)
// ---------------------------------------------------------------------------

/** 投成一条 anti-pattern 图节点:label 取 plan 前 60 字,weight 用 confidence。 */
export function toGraphNode(record: DeadEndRecord): {
  id: string;
  kind: "anti-pattern";
  label: string;
  summary: string;
  weight: number;
  refs: string[];
} {
  const safe = asObject<DeadEndRecord>(record);
  const id = typeof safe.id === "string" ? safe.id : "";
  const plan = truncate(collapseText(safe.plan), SUMMARY_MAX_CHARS);
  const first = Array.isArray(safe.failureEvidence) ? safe.failureEvidence[0] : undefined;
  const reason = truncate(collapseText(first?.detail) || "未记录原因", SUMMARY_MAX_CHARS);
  const alternative = collapseText(safe.alternative) || "暂无";
  return {
    id: `negkb:${id}`,
    kind: "anti-pattern",
    label: plan,
    summary: `原因:${reason};替代:${alternative}`,
    weight: clamp01(isFiniteNumber(safe.confidence) ? safe.confidence : 0),
    refs: normalizeStringList(safe.evidenceRefs),
  };
}
