/**
 * 改进提案持久层(生产侧,RSI #208):把 change-request 的纯逻辑落到 append-only jsonl。
 *
 * 为什么 append-only:提案的每一次流转、发版、发版核对都是判断的历史——「当初为什么把它标 shipped」
 * 「核对时到底还看不看得见」必须能回看,不能被后来的写入抹掉。单行追加 + 写后重读行数校验让
 * 「写成功了吗」成为可复核断言,而不是信任 appendFileSync 没抛异常。
 *
 * 数据面:`<root>/.genie/rsi/change-requests.jsonl`,每行 `{v:1,type,at,id,request,payload?}`
 * - create     {request}                       新建提案
 * - merge      {request,payload:{reason,candidateId}}  判重合并(证据/复现并入既有条目)
 * - transition {request,payload:{to,by?,note?,version?}} 状态流转(含 ship:to=shipped + version)
 * - verify     {request,payload:{observed,note?}}        发版后核对
 * - supersede  {request,payload:{byId}}                  被另一条取代
 *
 * 投影语义(loadChangeRequests):
 * - 按行序归并,同 id latest-wins(每行都带完整 request,投影即替换)。
 * - 坏行(JSON 坏 / v 不是 1 / type 未知 / 既缺 request 又缺 id)只计入 parseErrors 并跳过:
 *   一行坏不整文件失效、不 throw。
 *
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 业务模块。
 * runtime 模块按 defect-lineage-store 的两跳惰性解析:
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 缺失)外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** store 稳定码:store 层自产的失败码(提案码沿用 runtime 的 CHANGE_REQ_*)。 */
export const CHANGE_REQUEST_STORE_CODES = [
  "CHANGE_REQ_NOT_FOUND",
  "CHANGE_REQ_INVALID",
  "CHANGE_REQ_LEDGER_WRITE_VERIFY_FAILED",
  "CHANGE_REQ_STORE_ERROR",
] as const;

export type ChangeRequestStoreCode = (typeof CHANGE_REQUEST_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const CHANGE_REQUEST_LINE_TYPES = ["create", "merge", "transition", "verify", "supersede"] as const;

export type ChangeRequestLineType = (typeof CHANGE_REQUEST_LINE_TYPES)[number];

/** 提案条目(与 runtime ChangeRequest 同形;此处本地声明,避免依赖 runtime 构建产物)。 */
export interface ChangeRequestLike {
  id: string;
  title: string;
  kind: string;
  target: { module: string; symbol?: string; commit?: string };
  evidenceRefs: string[];
  reproSteps: string[];
  impact: { files?: string[]; users?: string; blastRadius?: string };
  expectedBehavior: string;
  observedBehavior: string;
  status: string;
  dedupeKey: string;
  supersedes?: string;
  supersededBy?: string;
  release?: { version: string; at: number };
  verification?: { checkedAt: number; stillObserved: boolean; note?: string };
  provenance: string;
  createdAt: number;
  updatedAt: number;
  lastTransition?: { to: string; by?: string; note?: string; at: number };
}

/** 一条落盘行。 */
export interface ChangeRequestLine {
  v: 1;
  type: ChangeRequestLineType;
  at: number;
  id?: string;
  request?: ChangeRequestLike;
  payload?: Record<string, unknown>;
}

/** 投影结果:按首次出现顺序的条目 + 坏行/总行计数。 */
export interface ChangeRequestProjection {
  entries: Map<string, ChangeRequestLike>;
  parseErrors: number;
  totalLines: number;
}

/** 单次写入/流转结果:成功带 request 与稳定码,failure 只带码。 */
export interface ChangeRequestResult {
  ok: boolean;
  code?: string;
  id?: string;
  request?: ChangeRequestLike;
  merged?: boolean;
}

/** 列表结果。 */
export interface ChangeRequestListResult {
  ok: true;
  requests: ChangeRequestLike[];
  parseErrors: number;
}

/** 导出结果。 */
export interface ChangeRequestExportResult {
  ok: boolean;
  code?: string;
  path?: string;
}

/** 报表。 */
export interface ChangeRequestReport {
  ok: true;
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  openAged: { olderThanDays: number; count: number; ids: string[] };
  parseErrors: number;
  totalLines: number;
}

/** runtime 纯逻辑面(只声明本文件用到的部分)。 */
interface ChangeRequestRuntime {
  createProposal(input: unknown, opts?: { at?: number }): { request?: ChangeRequestLike; codes: string[] };
  findDuplicate(
    existing: ChangeRequestLike[],
    candidate: ChangeRequestLike,
  ): { match?: ChangeRequestLike; reason?: "dedupeKey" | "similarity"; codes: string[] };
  mergeProposal(
    existing: ChangeRequestLike,
    candidate: ChangeRequestLike,
    opts?: { at?: number },
  ): { request?: ChangeRequestLike; codes: string[] };
  transition(
    request: ChangeRequestLike,
    to: string,
    opts?: { by?: string; note?: string; at?: number },
  ): { request?: ChangeRequestLike; codes: string[] };
  markShipped(
    request: ChangeRequestLike,
    opts?: { version?: string; at?: number },
  ): { request?: ChangeRequestLike; codes: string[] };
  verifyAfterRelease(
    request: ChangeRequestLike,
    opts?: { observed?: boolean; note?: string; at?: number },
  ): { request?: ChangeRequestLike; codes: string[] };
  supersede(
    request: ChangeRequestLike,
    opts?: { byId?: string; at?: number },
  ): { request?: ChangeRequestLike; codes: string[] };
  renderProposalMarkdown(request: ChangeRequestLike): string;
}

let changeRequestRuntime: ChangeRequestRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadChangeRequestRuntime(): Promise<ChangeRequestRuntime> {
  if (changeRequestRuntime) return changeRequestRuntime;
  const spec = "@lampgenie/runtime/agent/change-request";
  try {
    changeRequestRuntime = (await import(spec)) as ChangeRequestRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/change-request.ts", import.meta.url).href;
    changeRequestRuntime = (await import(srcUrl)) as ChangeRequestRuntime;
  }
  return changeRequestRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadChangeRequestRuntime();

/** 稳定码字面量(runtime 不可用时仍能用;取值与 runtime 常量一致)。 */
const CODE_INVALID = "CHANGE_REQ_INVALID";
const CODE_CREATED = "CHANGE_REQ_CREATED";
const CODE_MERGED = "CHANGE_REQ_MERGED";
const CODE_NOT_FOUND = "CHANGE_REQ_NOT_FOUND";
const CODE_WRITE_FAILED = "CHANGE_REQ_LEDGER_WRITE_VERIFY_FAILED";
const CODE_TRANSITION_INVALID = "CHANGE_REQ_TRANSITION_INVALID";
const CODE_SUPERSEDED = "CHANGE_REQ_SUPERSEDED";
const CODE_REJECTED = "CHANGE_REQ_REJECTED";
const CODE_STILL_OBSERVED = "CHANGE_REQ_STILL_OBSERVED";
const CODE_VERIFIED = "CHANGE_REQ_VERIFIED";

/** 终态:不再参与判重(已废弃/已拒绝的条目不该吞掉新提案)。 */
const CLOSED_STATUSES: ReadonlySet<string> = new Set<string>(["superseded", "rejected"]);

/** 仍然「开着」的状态(报表的 aged 口径)。 */
const OPEN_STATUSES: ReadonlySet<string> = new Set<string>(["proposed", "accepted", "scheduled"]);

const STATUSES: ReadonlySet<string> = new Set<string>([
  "proposed",
  "accepted",
  "scheduled",
  "shipped",
  "superseded",
  "rejected",
]);

const LINE_TYPES: ReadonlySet<string> = new Set<string>(CHANGE_REQUEST_LINE_TYPES);

const DAY_MS = 86_400_000;

/** 提案台账文件绝对路径:`<root>/.genie/rsi/change-requests.jsonl`。 */
export function changeRequestsPath(root: string): string {
  return join(root, ".genie", "rsi", "change-requests.jsonl");
}

/** 导出目录:`<root>/.genie/rsi/proposals`。 */
export function proposalsDir(root: string): string {
  return join(root, ".genie", "rsi", "proposals");
}

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

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/**
 * 追加一行并做写后行数校验:重读文件统计非空行数,必须等于「写前行数 + 1」。
 * 校验失败返回 false(调用方折叠成 CHANGE_REQ_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendChangeRequestLine(root: string, line: ChangeRequestLine): boolean {
  const path = changeRequestsPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/**
 * 宽松读一条提案:只要 id 在就收下,缺字段按安全缺省补齐(投影层不因一条残缺记录丢整条)。
 * 返回 undefined 表示「连 id 都没有」。
 */
function coerceRequest(value: unknown, at: number): ChangeRequestLike | undefined {
  if (!isRecord(value)) return undefined;
  if (!filled(value["id"])) return undefined;
  const targetRaw = isRecord(value["target"]) ? value["target"] : {};
  const target: ChangeRequestLike["target"] = {
    module: filled(targetRaw["module"]) ? targetRaw["module"] : "",
  };
  if (filled(targetRaw["symbol"])) target.symbol = targetRaw["symbol"];
  if (filled(targetRaw["commit"])) target.commit = targetRaw["commit"];
  const impactRaw = isRecord(value["impact"]) ? value["impact"] : {};
  const impact: ChangeRequestLike["impact"] = {};
  const files = strList(impactRaw["files"]);
  if (files.length > 0) impact.files = files;
  if (filled(impactRaw["users"])) impact.users = impactRaw["users"];
  if (filled(impactRaw["blastRadius"])) impact.blastRadius = impactRaw["blastRadius"];
  const status = typeof value["status"] === "string" && STATUSES.has(value["status"]) ? value["status"] : "proposed";
  const provenance = value["provenance"] === "human" ? "human" : "rsi";
  const createdAt = numOr(value["createdAt"], at);
  const request: ChangeRequestLike = {
    id: value["id"],
    title: typeof value["title"] === "string" ? value["title"] : "",
    kind: typeof value["kind"] === "string" ? value["kind"] : "improvement",
    target,
    evidenceRefs: strList(value["evidenceRefs"]),
    reproSteps: strList(value["reproSteps"]),
    impact,
    expectedBehavior: typeof value["expectedBehavior"] === "string" ? value["expectedBehavior"] : "",
    observedBehavior: typeof value["observedBehavior"] === "string" ? value["observedBehavior"] : "",
    status,
    dedupeKey: typeof value["dedupeKey"] === "string" ? value["dedupeKey"] : "",
    provenance,
    createdAt,
    updatedAt: numOr(value["updatedAt"], createdAt),
  };
  if (filled(value["supersedes"])) request.supersedes = value["supersedes"];
  if (filled(value["supersededBy"])) request.supersededBy = value["supersededBy"];
  const release = value["release"];
  if (isRecord(release) && filled(release["version"])) {
    request.release = { version: release["version"], at: numOr(release["at"], createdAt) };
  }
  const verification = value["verification"];
  if (isRecord(verification) && typeof verification["stillObserved"] === "boolean") {
    const item: ChangeRequestLike["verification"] = {
      checkedAt: numOr(verification["checkedAt"], createdAt),
      stillObserved: verification["stillObserved"],
    };
    if (filled(verification["note"])) item.note = verification["note"];
    request.verification = item;
  }
  const last = value["lastTransition"];
  if (isRecord(last) && filled(last["to"])) {
    const item: NonNullable<ChangeRequestLike["lastTransition"]> = {
      to: last["to"],
      at: numOr(last["at"], createdAt),
    };
    if (filled(last["by"])) item.by = last["by"];
    if (filled(last["note"])) item.note = last["note"];
    request.lastTransition = item;
  }
  return request;
}

/**
 * 投影:按行序读,同 id latest-wins。坏行(JSON 坏 / v≠1 / type 未知 / 既缺 request 又缺 id)
 * 计入 parseErrors 跳过——一行坏不该让整本台账失效。
 */
export function loadChangeRequests(root: string): ChangeRequestProjection {
  const entries = new Map<string, ChangeRequestLike>();
  const path = changeRequestsPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { entries, parseErrors: 0, totalLines: 0 };
  }
  let parseErrors = 0;
  let totalLines = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!isRecord(parsed) || parsed["v"] !== 1) {
      parseErrors += 1;
      continue;
    }
    if (typeof parsed["type"] !== "string" || !LINE_TYPES.has(parsed["type"])) {
      parseErrors += 1;
      continue;
    }
    const at = numOr(parsed["at"], 0);
    const request = coerceRequest(parsed["request"], at);
    if (request !== undefined) {
      entries.set(request.id, request);
      continue;
    }
    if (filled(parsed["id"])) continue; // 只有 id 的行不能改状态,但它是合法行
    parseErrors += 1;
  }
  return { entries, parseErrors, totalLines };
}

/** 列表(按 createdAt、id 排序;status 可过滤)。 */
export function listRequests(root: string, opts: { status?: string } = {}): ChangeRequestListResult {
  const projection = loadChangeRequests(root);
  const all = Array.from(projection.entries.values());
  const filtered = filled(opts.status) ? all.filter((item) => item.status === opts.status) : all;
  filtered.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt - b.createdAt));
  return { ok: true, requests: filtered, parseErrors: projection.parseErrors };
}

/** 取一条;不存在返回 CHANGE_REQ_NOT_FOUND。 */
export function getRequest(root: string, id: string): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  if (!filled(id)) return { ok: false, code: CODE_NOT_FOUND };
  const projection = loadChangeRequests(root);
  const request = projection.entries.get(id.trim());
  if (request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  return { ok: true, request, id: request.id };
}

/**
 * 建提案(带判重):
 * - 输入非法 → CHANGE_REQ_INVALID(不写盘);
 * - 命中既有开着(非 superseded/rejected)的条目 → 合并进旧条目,追加 merge 行;
 * - 否则追加 create 行。
 */
export function createRequest(
  root: string,
  input: unknown,
  opts: { at?: number } = {},
): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  const at = numOr(opts.at, Date.now());
  const proposal = rt.createProposal(input, { at });
  if (proposal.request === undefined) return { ok: false, code: proposal.codes[0] ?? CODE_INVALID };
  const projection = loadChangeRequests(root);
  const alive = Array.from(projection.entries.values()).filter((item) => !CLOSED_STATUSES.has(item.status));
  // 同 id 即同一条提案(提案 id 由判重键派生):直接合并,再走 dedupeKey/相似度判重。
  const sameId = projection.entries.get(proposal.request.id);
  const dup =
    sameId !== undefined && !CLOSED_STATUSES.has(sameId.status)
      ? { match: sameId, reason: "dedupeKey" as const, codes: [CODE_MERGED] }
      : rt.findDuplicate(alive, proposal.request);
  if (dup.match !== undefined) {
    const merged = rt.mergeProposal(dup.match, proposal.request, { at });
    if (merged.request === undefined) return { ok: false, code: merged.codes[0] ?? CODE_INVALID };
    const request = merged.request;
    const line: ChangeRequestLine = {
      v: 1,
      type: "merge",
      at,
      id: request.id,
      request,
      payload: { reason: dup.reason ?? "dedupeKey", candidateId: proposal.request.id },
    };
    if (!appendChangeRequestLine(root, line)) return { ok: false, code: CODE_WRITE_FAILED };
    return { ok: true, code: CODE_MERGED, id: request.id, request, merged: true };
  }
  const request = proposal.request;
  const line: ChangeRequestLine = { v: 1, type: "create", at, id: request.id, request };
  if (!appendChangeRequestLine(root, line)) return { ok: false, code: CODE_WRITE_FAILED };
  return { ok: true, code: CODE_CREATED, id: request.id, request, merged: false };
}

/** 把一条已就绪的行落盘并组装结果。 */
function commitLine(
  root: string,
  line: ChangeRequestLine,
  codes: string[],
  id: string,
): ChangeRequestResult {
  const request = line.request;
  if (request === undefined) return { ok: false, code: CODE_INVALID };
  const code = codes[0];
  if (!appendChangeRequestLine(root, line)) return { ok: false, code: CODE_WRITE_FAILED, id };
  return code === undefined ? { ok: true, request, id } : { ok: true, request, id, code };
}

/**
 * 状态流转:非法流转不写盘并返回纯函数的码(TRANSITION_INVALID / STATUS_UNCHANGED);
 * 成功追加 transition 行(payload 带 by/note)。
 */
export function transition(
  root: string,
  id: string,
  to: string,
  opts: { by?: string; note?: string; at?: number } = {},
): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  if (!filled(id)) return { ok: false, code: CODE_NOT_FOUND };
  const at = numOr(opts.at, Date.now());
  const found = getRequest(root, id);
  if (!found.ok || found.request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  const payload: Record<string, unknown> = { to };
  if (filled(opts.by)) payload["by"] = opts.by;
  if (filled(opts.note)) payload["note"] = opts.note;
  const res = rt.transition(found.request, to, { by: opts.by, note: opts.note, at });
  if (res.request === undefined) return { ok: false, code: res.codes[0] ?? CODE_INVALID };
  const code = res.codes[0];
  const isFailure = code !== undefined && code !== CODE_SUPERSEDED && code !== CODE_REJECTED;
  if (isFailure) return { ok: false, code, request: res.request, id: found.request.id };
  const line: ChangeRequestLine = { v: 1, type: "transition", at, id: res.request.id, request: res.request, payload };
  return commitLine(root, line, res.codes, res.request.id);
}

/** 记发版:成功写 status=shipped + release,追加 transition 行(payload.to=shipped, version)。 */
export function ship(root: string, id: string, opts: { version?: string; at?: number } = {}): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  if (!filled(id)) return { ok: false, code: CODE_NOT_FOUND };
  const at = numOr(opts.at, Date.now());
  const found = getRequest(root, id);
  if (!found.ok || found.request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  const res = rt.markShipped(found.request, { version: opts.version, at });
  if (res.request === undefined) return { ok: false, code: res.codes[0] ?? CODE_INVALID };
  if (res.codes.length > 0) return { ok: false, code: res.codes[0], request: res.request, id: found.request.id };
  const payload: Record<string, unknown> = { to: "shipped", version: res.request.release?.version ?? opts.version };
  const line: ChangeRequestLine = { v: 1, type: "transition", at, id: res.request.id, request: res.request, payload };
  return commitLine(root, line, res.codes, res.request.id);
}

/** 发版后核对:observed=true 退回 accepted(STILL_OBSERVED),false 留 shipped(VERIFIED)。 */
export function verify(
  root: string,
  id: string,
  opts: { observed?: boolean; note?: string; at?: number } = {},
): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  if (!filled(id)) return { ok: false, code: CODE_NOT_FOUND };
  const at = numOr(opts.at, Date.now());
  const found = getRequest(root, id);
  if (!found.ok || found.request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  const res = rt.verifyAfterRelease(found.request, { observed: opts.observed, note: opts.note, at });
  if (res.request === undefined) return { ok: false, code: res.codes[0] ?? CODE_INVALID };
  const code = res.codes[0];
  if (code !== CODE_STILL_OBSERVED && code !== CODE_VERIFIED) {
    return { ok: false, code: code ?? CODE_TRANSITION_INVALID, request: res.request, id: found.request.id };
  }
  const payload: Record<string, unknown> = { observed: opts.observed === true };
  if (filled(opts.note)) payload["note"] = opts.note;
  const line: ChangeRequestLine = { v: 1, type: "verify", at, id: res.request.id, request: res.request, payload };
  return commitLine(root, line, res.codes, res.request.id);
}

/** 取代:写 superseded + supersededBy,追加 supersede 行(payload.byId)。 */
export function supersede(root: string, id: string, opts: { byId?: string; at?: number } = {}): ChangeRequestResult {
  if (!filled(root)) throw new TypeError("root 必填");
  if (!filled(id)) return { ok: false, code: CODE_NOT_FOUND };
  const at = numOr(opts.at, Date.now());
  const found = getRequest(root, id);
  if (!found.ok || found.request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  const res = rt.supersede(found.request, { byId: opts.byId, at });
  if (res.request === undefined) return { ok: false, code: res.codes[0] ?? CODE_INVALID };
  const line: ChangeRequestLine = {
    v: 1,
    type: "supersede",
    at,
    id: res.request.id,
    request: res.request,
    payload: { byId: opts.byId },
  };
  return commitLine(root, line, res.codes, res.request.id);
}

/** 导出人读提案到 `<root>/.genie/rsi/proposals/<id>.md`。 */
export function exportMarkdown(root: string, id: string): ChangeRequestExportResult {
  if (!filled(root)) throw new TypeError("root 必填");
  const found = getRequest(root, id);
  if (!found.ok || found.request === undefined) return { ok: false, code: CODE_NOT_FOUND };
  const markdown = rt.renderProposalMarkdown(found.request);
  if (markdown === "") return { ok: false, code: CODE_INVALID };
  const path = join(proposalsDir(root), `${found.request.id}.md`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown, "utf8");
  } catch {
    return { ok: false, code: "CHANGE_REQ_STORE_ERROR" };
  }
  return { ok: true, path };
}

/**
 * 报表:按状态/种类计数 + 「开着且超过 7 天没动静」的积压清单
 * (open = proposed|accepted|scheduled;createdAt 早于 now-7d 计入)。
 */
export function reportRequests(root: string, opts: { at?: number } = {}): ChangeRequestReport {
  if (!filled(root)) throw new TypeError("root 必填");
  const at = numOr(opts.at, Date.now());
  const projection = loadChangeRequests(root);
  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const agedIds: string[] = [];
  const olderThanDays = 7;
  const cutoff = at - olderThanDays * DAY_MS;
  for (const request of projection.entries.values()) {
    byStatus[request.status] = (byStatus[request.status] ?? 0) + 1;
    byKind[request.kind] = (byKind[request.kind] ?? 0) + 1;
    if (OPEN_STATUSES.has(request.status) && request.createdAt < cutoff) agedIds.push(request.id);
  }
  agedIds.sort();
  return {
    ok: true,
    total: projection.entries.size,
    byStatus,
    byKind,
    openAged: { olderThanDays, count: agedIds.length, ids: agedIds },
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
  };
}
