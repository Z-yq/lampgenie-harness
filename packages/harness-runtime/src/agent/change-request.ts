/**
 * 源码级改进提案通道(Change Request,RSI #208):把「观察到的问题 + 复现 + 期望行为」写成
 * 可去重、可流转、可发版核对、可投进证据图的提案,而不是散在会话里的一句「这里该改」。
 * 为什么需要一条独立通道:
 * - RSI 产出的改进如果没有稳定 id 与 dedupeKey,同一条缺陷会被反复「发现」并重复派工;
 *   createProposal 用 (kind|module|symbol|归一化期望行为) 的短哈希做 id,deme 去重才有依据。
 * - 提案的生命周期是判断历史:proposed→accepted→scheduled→shipped 每一步「谁在什么时候因为什么
 *   改的口径」都要留痕(lastTransition),所以流转走显式状态表,非法流转不静默通过。
 * - 发版不等于修好:ship 之后必须能核对「这个问题是否仍可观察」(verifyAfterRelease),
 *   仍可观察的提案要退回 accepted 重新排队,而不是带着 shipped 的假完成感沉底。
 * - 提案要能被知识面消费:toGraphNode 把「还没修的问题」投成 direction,把「已发版仍是坑」投成
 *   anti-pattern,并随核对结果降置信度。
 * 纯逻辑:零 IO,不读文件/网络/环境。只用 node:crypto 的 sha256(稳定 id)。
 * 时间一律 epoch ms 数字;每个写时间的函数都可注入 at(缺省 Date.now())。
 * 所有函数不抛异常——非法输入返回稳定码或安全空值。
 */
import { createHash } from "node:crypto";

/** 提案 schema 版本:字段语义变化时递增,读取方据此迁移。 */
export const CHANGE_REQUEST_VERSION = 1;

/** 提案种类:bug=可复现的缺陷,mechanism-gap=机制缺口,improvement=纯改进。 */
export type ChangeRequestKind = "bug" | "mechanism-gap" | "improvement";

/** 提案状态:是判断历史,只能按 TRANSITIONS 表显式流转。 */
export type ChangeRequestStatus = "proposed" | "accepted" | "scheduled" | "shipped" | "superseded" | "rejected";

/** 来源:rsi=机器分析产出,human=人工登记(人工提案不受 bug 证据硬约束之外的影响)。 */
export type ChangeRequestProvenance = "rsi" | "human";

/** 命中位置:模块必填(symbol/commit 可选,越精确越容易判重与定位)。 */
export interface ChangeRequestTarget {
  module: string;
  symbol?: string;
  commit?: string;
}

/** 影响面:改哪些文件、影响谁、爆炸半径多大。 */
export interface ChangeRequestImpact {
  files?: string[];
  users?: string;
  blastRadius?: string;
}

/** 发版信息:哪个版本、什么时候(ship 时写入)。 */
export interface ChangeRequestRelease {
  version: string;
  at: number;
}

/** 发版后核对:何时核对、问题是否仍可观察。 */
export interface ChangeRequestVerification {
  checkedAt: number;
  stillObserved: boolean;
  note?: string;
}

/** 最近一次流转留痕:流向哪、谁做的、为什么、什么时候。 */
export interface ChangeRequestTransition {
  to: string;
  by?: string;
  note?: string;
  at: number;
}

/** 一条源码级改进提案。 */
export interface ChangeRequest {
  id: string;
  title: string;
  kind: ChangeRequestKind;
  target: ChangeRequestTarget;
  evidenceRefs: string[];
  reproSteps: string[];
  impact: ChangeRequestImpact;
  expectedBehavior: string;
  observedBehavior: string;
  status: ChangeRequestStatus;
  dedupeKey: string;
  supersedes?: string;
  supersededBy?: string;
  release?: ChangeRequestRelease;
  verification?: ChangeRequestVerification;
  provenance: ChangeRequestProvenance;
  createdAt: number;
  updatedAt: number;
  lastTransition?: ChangeRequestTransition;
}

/** createProposal 的输入(宽松读取:调用方给原始 JSON 也能用)。 */
export interface ChangeRequestInput {
  id?: string;
  title?: string;
  kind?: ChangeRequestKind;
  target?: ChangeRequestTarget;
  evidenceRefs?: string[];
  reproSteps?: string[];
  impact?: ChangeRequestImpact;
  expectedBehavior?: string;
  observedBehavior?: string;
  provenance?: ChangeRequestProvenance;
}

/** 稳定码:调用方按码断言,不解析文案。 */
export const CHANGE_REQ_INVALID = "CHANGE_REQ_INVALID";
export const CHANGE_REQ_CREATED = "CHANGE_REQ_CREATED";
export const CHANGE_REQ_DUPLICATED = "CHANGE_REQ_DUPLICATED";
export const CHANGE_REQ_MERGED = "CHANGE_REQ_MERGED";
export const CHANGE_REQ_TRANSITION_INVALID = "CHANGE_REQ_TRANSITION_INVALID";
export const CHANGE_REQ_STATUS_UNCHANGED = "CHANGE_REQ_STATUS_UNCHANGED";
export const CHANGE_REQ_STILL_OBSERVED = "CHANGE_REQ_STILL_OBSERVED";
export const CHANGE_REQ_VERIFIED = "CHANGE_REQ_VERIFIED";
export const CHANGE_REQ_SUPERSEDED = "CHANGE_REQ_SUPERSEDED";
export const CHANGE_REQ_REJECTED = "CHANGE_REQ_REJECTED";

/** 全部稳定码(顺序即声明顺序,供 CLI/文档枚举)。 */
export const CHANGE_REQ_CODES = [
  CHANGE_REQ_INVALID,
  CHANGE_REQ_CREATED,
  CHANGE_REQ_DUPLICATED,
  CHANGE_REQ_MERGED,
  CHANGE_REQ_TRANSITION_INVALID,
  CHANGE_REQ_STATUS_UNCHANGED,
  CHANGE_REQ_STILL_OBSERVED,
  CHANGE_REQ_VERIFIED,
  CHANGE_REQ_SUPERSEDED,
  CHANGE_REQ_REJECTED,
] as const;

export type ChangeReqCode = (typeof CHANGE_REQ_CODES)[number];

/** 合法流转表:新状态只许从这里出,其它一律 TRANSITION_INVALID。 */
const TRANSITIONS: Record<ChangeRequestStatus, readonly ChangeRequestStatus[]> = {
  proposed: ["accepted", "rejected", "superseded"],
  accepted: ["scheduled", "superseded", "rejected"],
  scheduled: ["shipped", "superseded"],
  shipped: ["superseded"],
  superseded: [],
  rejected: [],
};

const KINDS: ReadonlySet<string> = new Set<string>(["bug", "mechanism-gap", "improvement"]);

const STATUSES: ReadonlySet<string> = new Set<string>([
  "proposed",
  "accepted",
  "scheduled",
  "shipped",
  "superseded",
  "rejected",
]);

/** 相似度判重阈值:同一模块下标题/期望行为词集 Jaccard 达到这个值即视为同一条。 */
const SIMILARITY_THRESHOLD = 0.7;

/** CJK 字母表(基本区 + 扩展 A + 兼容区);连续段按 2 字 shingle。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 拉丁/数字:一段连续 alnum 就是一个词。 */
const LATIN_RE = /[a-z0-9]/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 去重(保首次顺序)。 */
function uniqInOrder(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/** 字符串数组宽松读取:丢弃非字符串项。 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- 归一化

/**
 * 标题归一化:小写,非字母数字与非 CJK 一律当分隔;拉丁按词切 token,
 * CJK 连续段按 2 字 shingle(段长 1 用单字)。返回去重排序后的 token 数组。
 * 例:"Export 导出丢失!" → ["export","导出","出丢","丢失"] 排序后。
 */
export function normalizeTitle(value: unknown): string[] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.trim() === "") return [];
  const tokens: string[] = [];
  let latin = "";
  let cjk = "";
  const flushLatin = (): void => {
    if (latin !== "") {
      tokens.push(latin);
      latin = "";
    }
  };
  const flushCjk = (): void => {
    if (cjk === "") return;
    const chars = Array.from(cjk);
    const first = chars[0];
    if (chars.length === 1) {
      if (first !== undefined) tokens.push(first);
    } else {
      for (let i = 0; i + 1 < chars.length; i += 1) {
        const a = chars[i];
        const b = chars[i + 1];
        if (a !== undefined && b !== undefined) tokens.push(`${a}${b}`);
      }
    }
    cjk = "";
  };
  for (const ch of Array.from(text)) {
    if (CJK_RE.test(ch)) {
      flushLatin();
      cjk += ch;
      continue;
    }
    if (LATIN_RE.test(ch)) {
      flushCjk();
      latin += ch;
      continue;
    }
    flushLatin();
    flushCjk();
  }
  flushLatin();
  flushCjk();
  return uniqInOrder(tokens).sort(cmpStr);
}

/** 词集 Jaccard(空集返回 0,不做除零)。 */
function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 判重键 = sha256(kind|module|symbol|归一化期望行为) 前 16 位 hex。
 * 「同一个模块、同一个符号、期望行为同义」就该是同一条提案。
 */
export function proposalKey(input: unknown): string {
  const rec = isRecord(input) ? input : {};
  const kind = filled(rec["kind"]) ? rec["kind"].trim() : "";
  const target = isRecord(rec["target"]) ? rec["target"] : {};
  const module = filled(target["module"]) ? target["module"].trim() : "";
  const symbol = filled(target["symbol"]) ? target["symbol"].trim() : "";
  const tokens = normalizeTitle(rec["expectedBehavior"]).join(" ");
  return sha16(`${kind}|${module}|${symbol}|${tokens}`);
}

// ---------------------------------------------------------------- 提案构造

function coerceImpact(value: unknown): ChangeRequestImpact {
  const rec = isRecord(value) ? value : {};
  const impact: ChangeRequestImpact = {};
  const files = stringList(rec["files"]);
  if (files.length > 0) impact.files = files;
  if (filled(rec["users"])) impact.users = rec["users"];
  if (filled(rec["blastRadius"])) impact.blastRadius = rec["blastRadius"];
  return impact;
}

/** 一条记录是否「够得上」一条提案(判重/流转的前置形状检查)。 */
function isChangeRequest(value: unknown): value is ChangeRequest {
  if (!isRecord(value)) return false;
  if (!filled(value["id"])) return false;
  if (typeof value["status"] !== "string" || !STATUSES.has(value["status"])) return false;
  if (!isRecord(value["target"]) || !filled((value["target"] as UnknownRecord)["module"])) return false;
  if (typeof value["dedupeKey"] !== "string") return false;
  if (typeof value["createdAt"] !== "number" || typeof value["updatedAt"] !== "number") return false;
  return true;
}

/**
 * 建提案:title/expectedBehavior/observedBehavior/target.module 必填非空;
 * bug 还要求 evidenceRefs 非空且 reproSteps ≥1(没有证据与复现的 bug 提案是噪音)。
 * 成功 → status proposed、dedupeKey 由 proposalKey 算出、id = "cr-"+dedupeKey(给了非空 id 则沿用)。
 */
export function createProposal(input: unknown, opts: { at?: number } = {}): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isRecord(input)) return { codes: [CHANGE_REQ_INVALID] };
  const title = filled(input["title"]) ? input["title"].trim() : "";
  const expectedBehavior = filled(input["expectedBehavior"]) ? input["expectedBehavior"] : "";
  const observedBehavior = filled(input["observedBehavior"]) ? input["observedBehavior"] : "";
  const targetRaw = isRecord(input["target"]) ? input["target"] : undefined;
  const module = targetRaw !== undefined && filled(targetRaw["module"]) ? targetRaw["module"].trim() : "";
  const kindRaw = input["kind"];
  const kind = typeof kindRaw === "string" && KINDS.has(kindRaw) ? (kindRaw as ChangeRequestKind) : undefined;
  if (title === "" || expectedBehavior === "" || observedBehavior === "" || module === "" || kind === undefined) {
    return { codes: [CHANGE_REQ_INVALID] };
  }
  const evidenceRefs = stringList(input["evidenceRefs"]);
  const reproSteps = stringList(input["reproSteps"]);
  if (kind === "bug" && (evidenceRefs.length === 0 || reproSteps.length === 0)) {
    return { codes: [CHANGE_REQ_INVALID] };
  }
  const provenanceRaw = input["provenance"];
  let provenance: ChangeRequestProvenance = "rsi";
  if (provenanceRaw !== undefined) {
    if (provenanceRaw !== "rsi" && provenanceRaw !== "human") return { codes: [CHANGE_REQ_INVALID] };
    provenance = provenanceRaw;
  }
  const dedupeKey = proposalKey(input);
  const givenId = filled(input["id"]) ? input["id"].trim() : "";
  const target: ChangeRequestTarget = { module };
  if (targetRaw !== undefined && filled(targetRaw["symbol"])) target.symbol = targetRaw["symbol"].trim();
  if (targetRaw !== undefined && filled(targetRaw["commit"])) target.commit = targetRaw["commit"].trim();
  const request: ChangeRequest = {
    id: givenId !== "" ? givenId : `cr-${dedupeKey}`,
    title,
    kind,
    target,
    evidenceRefs,
    reproSteps,
    impact: coerceImpact(input["impact"]),
    expectedBehavior,
    observedBehavior,
    status: "proposed",
    dedupeKey,
    provenance,
    createdAt: at,
    updatedAt: at,
  };
  return { request, codes: [CHANGE_REQ_CREATED] };
}

/**
 * 判重:先比 dedupeKey(跳过 candidate 自身 id),再看「同 module 且标题/期望行为词集 Jaccard ≥0.7」。
 * 命中返回 match + reason,调用方据此合并而不是再开一条。
 */
export function findDuplicate(
  existing: unknown,
  candidate: unknown): { match?: ChangeRequest; reason?: "dedupeKey" | "similarity"; codes: string[] } {
  if (!Array.isArray(existing) || !isChangeRequest(candidate)) return { codes: [CHANGE_REQ_INVALID] };
  const pool = existing.filter((item): item is ChangeRequest => isChangeRequest(item) && item.id !== candidate.id);
  for (const item of pool) {
    if (item.dedupeKey !== "" && item.dedupeKey === candidate.dedupeKey) {
      return { match: deepClone(item), reason: "dedupeKey", codes: [CHANGE_REQ_DUPLICATED] };
    }
  }
  const candidateTokens = normalizeTitle(candidate.title);
  const candidateExpected = normalizeTitle(candidate.expectedBehavior);
  for (const item of pool) {
    if (item.target.module !== candidate.target.module) continue;
    const score = Math.max(
      jaccard(candidateTokens, normalizeTitle(item.title)),
      jaccard(candidateExpected, normalizeTitle(item.expectedBehavior)),
    );
    if (score >= SIMILARITY_THRESHOLD) {
      return { match: deepClone(item), reason: "similarity", codes: [CHANGE_REQ_DUPLICATED] };
    }
  }
  return { codes: [] };
}

/**
 * 合并重复提案:证据去重合并、复现步骤追加去重、观察行为保留首条(新值不同则追加补充)、
 * 影响面缺字段补齐;status/id/dedupeKey 不变(合并不能改变这条的判断历史)。
 */
export function mergeProposal(
  existing: unknown,
  candidate: unknown,
  opts: { at?: number } = {},
): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isChangeRequest(existing) || !isChangeRequest(candidate)) return { codes: [CHANGE_REQ_INVALID] };
  const next = deepClone(existing);
  next.evidenceRefs = uniqInOrder([...existing.evidenceRefs, ...candidate.evidenceRefs]);
  next.reproSteps = uniqInOrder([...existing.reproSteps, ...candidate.reproSteps]);
  const incoming = candidate.observedBehavior;
  if (incoming !== "" && incoming !== next.observedBehavior) {
    next.observedBehavior = `${next.observedBehavior} | 补充: ${incoming}`;
  }
  const impact: ChangeRequestImpact = { ...(isRecord(existing.impact) ? existing.impact : {}) };
  if ((impact.files === undefined || impact.files.length === 0) && candidate.impact?.files && candidate.impact.files.length > 0) {
    impact.files = [...candidate.impact.files];
  }
  if (!filled(impact.users) && filled(candidate.impact?.users)) impact.users = candidate.impact.users;
  if (!filled(impact.blastRadius) && filled(candidate.impact?.blastRadius)) impact.blastRadius = candidate.impact.blastRadius;
  next.impact = impact;
  next.updatedAt = at;
  return { request: next, codes: [CHANGE_REQ_MERGED] };
}

// ---------------------------------------------------------------- 状态流转

/**
 * 显式流转:按 TRANSITIONS 表放行,同状态返回 STATUS_UNCHANGED,其它返回 TRANSITION_INVALID。
 * 成功写 lastTransition{to,by,note,at} 并更新 updatedAt;流向 superseded/rejected 追加对应码。
 */
export function transition(
  request: unknown,
  to: unknown,
  opts: { by?: string; note?: string; at?: number } = {},
): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isChangeRequest(request)) return { codes: [CHANGE_REQ_INVALID] };
  if (typeof to !== "string" || !STATUSES.has(to)) {
    return { request: deepClone(request), codes: [CHANGE_REQ_TRANSITION_INVALID] };
  }
  const target = to as ChangeRequestStatus;
  if (request.status === target) return { request: deepClone(request), codes: [CHANGE_REQ_STATUS_UNCHANGED] };
  const allowed = TRANSITIONS[request.status] ?? [];
  if (!allowed.includes(target)) return { request: deepClone(request), codes: [CHANGE_REQ_TRANSITION_INVALID] };
  const next = deepClone(request);
  next.status = target;
  next.updatedAt = at;
  const lastTransition: ChangeRequestTransition = { to: target, at };
  if (filled(opts.by)) lastTransition.by = opts.by.trim();
  if (filled(opts.note)) lastTransition.note = opts.note;
  next.lastTransition = lastTransition;
  const codes: string[] = [];
  if (target === "superseded") codes.push(CHANGE_REQ_SUPERSEDED);
  if (target === "rejected") codes.push(CHANGE_REQ_REJECTED);
  return { request: next, codes };
}

/**
 * 记发版:version 非空且当前状态在 accepted|scheduled|shipped 才算成功,
 * 写 status=shipped + release{version,at};否则原样返回 + TRANSITION_INVALID。
 */
export function markShipped(
  request: unknown,
  opts: { version?: string; at?: number } = {},
): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isChangeRequest(request)) return { codes: [CHANGE_REQ_INVALID] };
  const version = filled(opts.version) ? opts.version.trim() : "";
  const shippable = request.status === "accepted" || request.status === "scheduled" || request.status === "shipped";
  if (version === "" || !shippable) {
    return { request: deepClone(request), codes: [CHANGE_REQ_TRANSITION_INVALID] };
  }
  const next = deepClone(request);
  next.status = "shipped";
  next.release = { version, at };
  next.updatedAt = at;
  return { request: next, codes: [] };
}

/**
 * 发版后核对(发版不等于修好):
 * - observed=true → 问题仍可观察:退回 accepted 重新排队,码 STILL_OBSERVED;
 * - observed=false → 确认修好:状态留 shipped,码 VERIFIED。
 */
export function verifyAfterRelease(
  request: unknown,
  opts: { observed?: boolean; note?: string; at?: number } = {},
): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isChangeRequest(request)) return { codes: [CHANGE_REQ_INVALID] };
  if (typeof opts.observed !== "boolean") return { request: deepClone(request), codes: [CHANGE_REQ_INVALID] };
  if (request.status !== "shipped") return { request: deepClone(request), codes: [CHANGE_REQ_TRANSITION_INVALID] };
  const next = deepClone(request);
  const verification: ChangeRequestVerification = { checkedAt: at, stillObserved: opts.observed };
  if (filled(opts.note)) verification.note = opts.note;
  next.verification = verification;
  next.updatedAt = at;
  if (opts.observed) {
    next.status = "accepted";
    return { request: next, codes: [CHANGE_REQ_STILL_OBSERVED] };
  }
  return { request: next, codes: [CHANGE_REQ_VERIFIED] };
}

/** 被另一条提案取代:status=superseded + supersededBy=byId。 */
export function supersede(
  request: unknown,
  opts: { byId?: string; at?: number } = {},
): { request?: ChangeRequest; codes: string[] } {
  const at = numOr(opts.at, Date.now());
  if (!isChangeRequest(request)) return { codes: [CHANGE_REQ_INVALID] };
  if (!filled(opts.byId)) return { request: deepClone(request), codes: [CHANGE_REQ_INVALID] };
  const next = deepClone(request);
  next.status = "superseded";
  next.supersededBy = opts.byId.trim();
  next.updatedAt = at;
  return { request: next, codes: [CHANGE_REQ_SUPERSEDED] };
}

// ---------------------------------------------------------------- 知识面投影

export interface ChangeRequestGraphNode {
  kind: "anti-pattern" | "direction";
  statement: string;
  associations: { module: string; symbol?: string; decision: string };
  confidence: number;
}

/**
 * 投成证据图节点:
 * - 未修(proposed/accepted/scheduled)→ direction 0.5(方向,值得做,但还没验证);
 * - 已发版 → anti-pattern 0.35(已成坑);发版核对仍可观察 → 0.2(降置信,因为它可能根本不是主因);
 * - superseded/rejected → null(不再是方向,也不再是坑)。
 */
export function toGraphNode(request: unknown): ChangeRequestGraphNode | null {
  if (!isChangeRequest(request)) return null;
  if (request.status === "superseded" || request.status === "rejected") return null;
  const associations: ChangeRequestGraphNode["associations"] = { module: request.target.module, decision: request.id };
  if (filled(request.target.symbol)) associations.symbol = request.target.symbol;
  const statement = `${request.title}:观察「${request.observedBehavior}」→期望「${request.expectedBehavior}」`;
  if (request.status === "shipped") {
    const still = request.verification?.stillObserved === false;
    return { kind: "anti-pattern", statement, associations, confidence: still ? 0.2 : 0.35 };
  }
  return { kind: "direction", statement, associations, confidence: 0.5 };
}

// ---------------------------------------------------------------- 渲染

function bulletLines(values: readonly string[], empty: string): string[] {
  if (values.length === 0) return [`- ${empty}`];
  return values.map((value) => `- ${value}`);
}

function statusLine(request: ChangeRequest): string[] {
  const parts = [`- 状态:\`${request.status}\``, `- 更新于:${iso(request.updatedAt)}`];
  if (request.release) parts.push(`- 发版:\`${request.release.version}\`(${iso(request.release.at)})`);
  if (request.supersededBy) parts.push(`- 被取代:\`${request.supersededBy}\``);
  if (request.lastTransition) {
    const lt = request.lastTransition;
    const who = lt.by ? ` by ${lt.by}` : "";
    const why = lt.note ? `:「${lt.note}」` : "";
    parts.push(`- 最近流转:\`${lt.to}\`${who}${why} @ ${iso(lt.at)}`);
  }
  return parts;
}

/** 渲染一份人读提案(exportMarkdown 落盘的正文)。非法输入返回空串。 */
export function renderProposalMarkdown(request: unknown): string {
  if (!isChangeRequest(request)) return "";
  const lines: string[] = [];
  lines.push(`# ${request.title}`, "");
  const summaryBits = [
    `\`${request.kind}\``,
    `\`${request.target.module}${request.target.symbol ? `#${request.target.symbol}` : ""}\``,
    `状态 \`${request.status}\``,
    `来源 \`${request.provenance}\``,
    `id \`${request.id}\``,
  ];
  lines.push(`> ${summaryBits.join(" · ")}`, "");
  lines.push("## 摘要", "");
  lines.push(
    `${request.title} —— 现在观察到「${request.observedBehavior}」,期望「${request.expectedBehavior}」。` +
      `(创建于 ${iso(request.createdAt)},判重键 \`${request.dedupeKey}\`)`,
    "",
  );
  lines.push("## 证据链", "", ...bulletLines(request.evidenceRefs, "(未附证据)"), "");
  lines.push("## 复现步骤", "");
  if (request.reproSteps.length === 0) lines.push("_无_");
  else request.reproSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
  lines.push("## 影响面", "");
  const impact = isRecord(request.impact) ? request.impact : {};
  const files = stringList(impact["files"]);
  lines.push(`- 文件:${files.length === 0 ? "(未评估)" : files.map((file) => `\`${file}\``).join("、")}`);
  lines.push(`- 用户:${filled(impact["users"]) ? impact["users"] : "(未评估)"}`);
  lines.push(`- 爆炸半径:${filled(impact["blastRadius"]) ? impact["blastRadius"] : "(未评估)"}`);
  lines.push("");
  lines.push("## 期望行为", "", request.expectedBehavior, "");
  lines.push("## 观察行为", "", request.observedBehavior, "");
  lines.push("## 状态", "", ...statusLine(request), "");
  if (request.verification) {
    const v = request.verification;
    lines.push("## 发版核对", "");
    lines.push(`- 核对时间:${iso(v.checkedAt)}`);
    lines.push(`- 仍可观察:\`${v.stillObserved ? "是" : "否"}\``);
    if (filled(v.note)) lines.push(`- 备注:${v.note}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
