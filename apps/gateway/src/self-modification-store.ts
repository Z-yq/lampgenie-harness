/**
 * 自我修改台账持久层(RSI #196 闸门的落盘侧):把 self-modification 的纯逻辑落到 append-only jsonl。
 * 为什么 append-only:审批/应用/回滚是审计事实,不能被后来的写入覆盖或抹掉;单行追加 +
 * 写后非空行数校验,让「写成功了吗」变成可复核断言,而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/self-mod/requests.jsonl`,每行一条
 * - `{v:1,type:"request",at,request}` —— 自我修改请求本体(含评估出的 decision)。
 * - `{v:1,type:"approve"|"deny"|"apply"|"rollback",at,id,patch}` —— 后续动作。
 * 投影语义(loadSelfModProjection):
 * - request 建底(同 id 后写覆盖基础字段并重置 applied=false),顺带补 frozenHash
 *   (`freezeSelfModification(request).hash`,不写进行里);
 * - approve/deny/apply/rollback 按行序套用 → latest wins;找不到 id 只计 badLines 并跳过;
 * - 坏行(JSON 坏 / 未知 v / 类型非法 / 缺 id)只计数,一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path + `import type` 引 runtime 类型 + 两跳惰性解析 runtime 函数;
 * 只读复用 的 approvalObjectHash(纯哈希工具,不引 gateway 业务模块、不引 agent loop)。
 * 参数错误是唯一允许 throw 的情形(TypeError);IO/投影/闸门失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ModificationDecision,
  ModificationRequest,
  ModificationSurface,
  SelfModEvaluation,
  SelfModPolicy,
} from "@lampgenie/runtime/agent/self-modification";
import { approvalObjectHash } from "./approval-object";

/** 台账稳定码:store 层自产的失败码(闸门码沿用 runtime 的 SELF_MOD_CODES)。 */
export const SELF_MOD_STORE_CODES = [
  "MOD_DUPLICATE",
  "MOD_NOT_FOUND",
  "MOD_DECISION_FINAL",
  "MOD_REASON_REQUIRED",
  "MOD_APPROVER_MISSING",
  "MOD_AGENT_APPROVAL_FORBIDDEN",
  "MOD_RSI_NEEDS_HUMAN",
  "MOD_HASH_MISMATCH",
  "MOD_LEDGER_WRITE_VERIFY_FAILED",
  "MOD_STORE_ERROR",
] as const;

export type SelfModStoreCode = (typeof SELF_MOD_STORE_CODES)[number];

/** 台账行类型(只增不改)。 */
export const SELF_MOD_LINE_TYPES = ["request", "approve", "deny", "apply", "rollback"] as const;
export type SelfModLineType = (typeof SELF_MOD_LINE_TYPES)[number];

/** 记录 = 请求本体 + 台账派生状态(applied/frozenHash/objectHash/reason/last*)。 */
export interface ModificationRecord extends ModificationRequest {
  applied: boolean;
  frozenHash?: string;
  objectHash?: string;
  reason?: string;
  lastAction?: string;
  lastAt?: number;
}

/** 投影结果:可用记录(按首次出现顺序)+ 坏行/总行计数。 */
export interface SelfModProjection {
  requests: ModificationRecord[];
  badLines: number;
  totalLines: number;
}

/** 请求写入结果:codes 为闸门/校验码(空 = 通过)。 */
export interface SelfModRequestResult {
  ok: boolean;
  id?: string;
  code?: string;
  decision?: string;
  codes: string[];
  details?: string[];
}

/** 动作(审批/拒绝/应用/回滚)写入结果。 */
export interface SelfModActionResult {
  ok: boolean;
  id?: string;
  code?: string;
  decision?: string;
  codes: string[];
  details?: string[];
  applied?: boolean;
  frozenHash?: string;
  objectHash?: string;
}

/** 审批人入参。 */
export interface SelfModApprovalOptions {
  by?: string;
  kind?: "human" | "owner" | "agent";
  reason?: string;
}

/** 列表过滤:按 surface / decision.kind。 */
export interface SelfModFilter {
  surface?: ModificationSurface | string;
  decision?: string;
}

/** 汇报(报表口径)。 */
export interface SelfModReport {
  ok: boolean;
  totalLines: number;
  badLines: number;
  total: number;
  pending: number;
  allowed: number;
  needApproval: number;
  denied: number;
  applied: number;
  rolledBack: number;
  bySurface: Record<string, number>;
}

/** runtime self-modification 在本文件用到的模块面(与 409 行源文件逐一对齐)。 */
interface SelfModRuntime {
  readonly SELF_MOD_SCHEMA_VERSION: number;
  evaluateSelfModification(req: ModificationRequest, policy?: SelfModPolicy): SelfModEvaluation;
  freezeSelfModification(req: ModificationRequest): { hash: string; frozen: string };
  verifySelfModification(frozenHash: string, req: ModificationRequest): { match: boolean; hash: string; code?: string };
}

let selfModRuntime: SelfModRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadSelfModRuntime(): Promise<SelfModRuntime> {
  if (selfModRuntime) return selfModRuntime;
  const spec = "@lampgenie/runtime/agent/self-modification";
  try {
    selfModRuntime = (await import(spec)) as SelfModRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/self-modification.ts", import.meta.url).href;
    selfModRuntime = (await import(srcUrl)) as SelfModRuntime;
  }
  return selfModRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadSelfModRuntime();

/** 台账 schema 版本(与 runtime 同源)。 */
const SCHEMA_VERSION = rt.SELF_MOD_SCHEMA_VERSION;

/** 已终结的决策:allow / deny / rolled-back(need-approval、pending 仍可再动)。 */
const FINAL_DECISIONS: ReadonlySet<string> = new Set<string>(["allow", "deny", "rolled-back"]);

const LINE_TYPES: ReadonlySet<string> = new Set<string>(SELF_MOD_LINE_TYPES);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 台账文件绝对路径:`<root>/.genie/self-mod/requests.jsonl`。 */
export function selfModificationPath(root: string): string {
  return join(root, ".genie", "self-mod", "requests.jsonl");
}

/** 读台账非空行数(文件不存在 → 0)。 */
function countLedgerLines(path: string): number {
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
 * 校验失败返回 false(调用方折叠成 MOD_LEDGER_WRITE_VERIFY_FAILED);不回滚、不 throw。
 */
function appendLedgerLine(root: string, line: UnknownRecord): boolean {
  const path = selfModificationPath(root);
  const before = countLedgerLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLedgerLines(path) === before + 1;
}

/** 结构容器缺省化:只补形状,不补内容(内容缺失仍由闸门判 deny/need-approval)。 */
function normalizeRequest(raw: unknown, now: number): ModificationRequest {
  const src = isRecord(raw) ? raw : {};
  const author = isRecord(src["author"]) ? src["author"] : { kind: "agent", id: "" };
  const decision = isRecord(src["decision"]) ? src["decision"] : { kind: "pending" };
  const draft: ModificationRequest = {
    ...(src as Partial<ModificationRequest>),
    id: str(src["id"]).trim(),
    schemaVersion: typeof src["schemaVersion"] === "number" ? src["schemaVersion"] : SCHEMA_VERSION,
    surface: str(src["surface"]) as ModificationSurface,
    targetRef: str(src["targetRef"]),
    variant: str(src["variant"]),
    summary: str(src["summary"]),
    author: author as unknown as ModificationRequest["author"],
    evidence: isRecord(src["evidence"]) ? (src["evidence"] as unknown as ModificationRequest["evidence"]) : {},
    impact: isRecord(src["impact"]) ? (src["impact"] as unknown as ModificationRequest["impact"]) : {},
    dryRun: isRecord(src["dryRun"])
      ? (src["dryRun"] as unknown as ModificationRequest["dryRun"])
      : { command: "", ok: false, at: now },
    canary: isRecord(src["canary"])
      ? (src["canary"] as unknown as ModificationRequest["canary"])
      : { scope: "session", size: 0 },
    rollback: isRecord(src["rollback"])
      ? (src["rollback"] as unknown as ModificationRequest["rollback"])
      : { kind: "flag", ref: "" },
    ownerName: str(src["ownerName"]),
    irreversible: src["irreversible"] === true,
    riskFlags: Array.isArray(src["riskFlags"]) ? (src["riskFlags"] as string[]) : [],
    createdAt: typeof src["createdAt"] === "number" ? src["createdAt"] : now,
    updatedAt: now,
    decision: decision as unknown as ModificationDecision,
  };
  return draft;
}

/** request 行必需形状校验:缺 id/结构性字段类型不符 → undefined(由调用方计 badLines)。 */
function asModificationRequest(value: unknown): ModificationRequest | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  if (typeof value["surface"] !== "string") return undefined;
  if (typeof value["createdAt"] !== "number" || typeof value["updatedAt"] !== "number") return undefined;
  const author = value["author"];
  if (!isRecord(author) || typeof author["id"] !== "string") return undefined;
  const decision = value["decision"];
  if (!isRecord(decision) || typeof decision["kind"] !== "string") return undefined;
  return value as unknown as ModificationRequest;
}

/** 一条非 request 行(投影用的最小形状)。 */
interface ActionLine {
  at: number;
  type: Exclude<SelfModLineType, "request">;
  id: string;
  patch: UnknownRecord;
}

/** 台账行解析:坏行统一返回 undefined。 */
function parseLine(raw: string): { at: number; type: "request"; request: ModificationRequest } | ActionLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed["v"] !== SCHEMA_VERSION) return undefined;
  const type = parsed["type"];
  if (typeof type !== "string" || !LINE_TYPES.has(type)) return undefined;
  const at = parsed["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (type === "request") {
    const request = asModificationRequest(parsed["request"]);
    if (!request) return undefined;
    return { at, type: "request", request };
  }
  const id = parsed["id"];
  if (typeof id !== "string" || id.trim() === "") return undefined;
  const patch = parsed["patch"];
  if (patch !== undefined && !isRecord(patch)) return undefined;
  return { at, type: type as ActionLine["type"], id: id.trim(), patch: (patch ?? {}) as UnknownRecord };
}

/** request → 记录(建底:applied=false + 冻结 hash)。 */
function recordFromRequest(request: ModificationRequest, at: number): ModificationRecord {
  const record: ModificationRecord = { ...request, applied: false, lastAction: "request", lastAt: at };
  try {
    record.frozenHash = rt.freezeSelfModification(request).hash;
  } catch {
    delete record.frozenHash;
  }
  return record;
}

/** 把一条动作行套到记录上(latest wins)。 */
function applyActionLine(record: ModificationRecord, line: ActionLine): void {
  record.lastAction = line.type;
  record.lastAt = line.at;
  record.updatedAt = line.at;
  const patch = line.patch;
  if (line.type === "approve") {
    if (isRecord(patch["approver"])) {
      record.approver = patch["approver"] as unknown as ModificationRequest["approver"];
    }
    if (isRecord(patch["decision"])) record.decision = patch["decision"] as unknown as ModificationDecision;
  } else if (line.type === "deny" || line.type === "rollback") {
    if (isRecord(patch["decision"])) record.decision = patch["decision"] as unknown as ModificationDecision;
    const reason = patch["reason"];
    if (typeof reason === "string") record.reason = reason;
  } else {
    const frozenHash = patch["frozenHash"];
    if (typeof frozenHash === "string") record.frozenHash = frozenHash;
    const objectHash = patch["objectHash"];
    if (typeof objectHash === "string") record.objectHash = objectHash;
    record.applied = true;
  }
  const decisionAt = record.decision?.at;
  if (typeof decisionAt === "number") record.updatedAt = decisionAt;
}

/**
 * 投影:request 建底(同 id 后写覆盖基础字段并重置 applied=false)+ 动作行按行序套用(latest wins)。
 * 坏行只计 badLines,绝不让整文件失效、不 throw。
 */
export function loadSelfModProjection(root: string): SelfModProjection {
  const path = selfModificationPath(root);
  const requests: ModificationRecord[] = [];
  const index = new Map<string, ModificationRecord>();
  let badLines = 0;
  let totalLines = 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { requests: [], badLines: 0, totalLines: 0 };
  }
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    const line = parseLine(raw);
    if (!line) {
      badLines += 1;
      continue;
    }
    if (line.type === "request") {
      const record = recordFromRequest(line.request, line.at);
      const existing = index.get(record.id);
      if (existing) {
        const at = requests.indexOf(existing);
        requests[at] = record;
      } else {
        requests.push(record);
      }
      index.set(record.id, record);
      continue;
    }
    const record = index.get(line.id);
    if (!record) {
      badLines += 1;
      continue;
    }
    applyActionLine(record, line);
  }
  return { requests, badLines, totalLines };
}

/** 按 id 取记录(不存在 → undefined)。 */
function findRecord(root: string, id: string): ModificationRecord | undefined {
  return loadSelfModProjection(root).requests.find((r) => r.id === id);
}

function writeFailedResult(id?: string): SelfModActionResult {
  return { ok: false, id, code: "MOD_LEDGER_WRITE_VERIFY_FAILED", codes: ["MOD_LEDGER_WRITE_VERIFY_FAILED"] };
}

/** 参数错误校验(唯一允许 throw 的情形)。 */
function assertRoot(fn: string, root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError(`${fn}: root 必须是非空字符串`);
  return root;
}

/**
 * 登记一次自我修改请求。
 * - 已存在同 id → MOD_DUPLICATE(不写盘)。
 * - 否则跑闸门 evaluateSelfModification,把 decision 定为 `{kind, at, codes}` 后写 request 行。
 * - 返回 ok = decision==="allow";need-approval / deny 都是「已落盘的事实」而非错误。
 */
export function requestModification(
  root: string,
  req: ModificationRequest,
  policy: SelfModPolicy = {},
): SelfModRequestResult {
  const base = assertRoot("requestModification", root);
  if (!isRecord(req)) throw new TypeError("requestModification: req 必须是对象");
  const id = str(req["id"]).trim();
  if (id === "") throw new TypeError("requestModification: id 不能为空");
  const now = Date.now();
  try {
    const projection = loadSelfModProjection(base);
    if (projection.requests.some((r) => r.id === id)) {
      return { ok: false, id, code: "MOD_DUPLICATE", codes: ["MOD_DUPLICATE"] };
    }
    const draft = normalizeRequest(req, now);
    draft.id = id;
    const evaluation = rt.evaluateSelfModification(draft, policy ?? {});
    const codes = [...evaluation.codes];
    draft.decision = { kind: evaluation.decision, at: now, codes };
    const line: UnknownRecord = { v: SCHEMA_VERSION, type: "request", at: now, request: draft };
    if (!appendLedgerLine(base, line)) {
      return { ok: false, id, code: "MOD_LEDGER_WRITE_VERIFY_FAILED", codes: ["MOD_LEDGER_WRITE_VERIFY_FAILED"], decision: evaluation.decision };
    }
    return { ok: evaluation.decision === "allow", id, decision: evaluation.decision, codes, details: [...evaluation.details] };
  } catch {
    return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
  }
}

/**
 * 人类/所有者审批。
 * - 不存在 → MOD_NOT_FOUND;已终态(allow/deny/rolled-back)→ MOD_DECISION_FINAL。
 * - rsi 作者只接受 human 审批(owner/agent 一律 MOD_AGENT_APPROVAL_FORBIDDEN + MOD_RSI_NEEDS_HUMAN,不写盘)。
 * - 其余按带上 approver 重评闸门后写 approve 行(decision 以重评结果为准)。
 */
export function approveModification(
  root: string,
  id: string,
  opts: SelfModApprovalOptions = {},
): SelfModActionResult {
  const base = assertRoot("approveModification", root);
  if (typeof id !== "string") throw new TypeError("approveModification: id 必须是字符串");
  if (id.trim() === "") return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
  const by = str(opts?.by).trim();
  const kind: "human" | "owner" | "agent" =
    opts?.kind === "owner" || opts?.kind === "agent" || opts?.kind === "human" ? opts.kind : "human";
  const reason = str(opts?.reason).trim();
  try {
    const record = findRecord(base, id.trim());
    if (!record) return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
    const current = String(record.decision?.kind ?? "pending");
    if (FINAL_DECISIONS.has(current)) {
      return { ok: false, id, code: "MOD_DECISION_FINAL", codes: ["MOD_DECISION_FINAL"], decision: current };
    }
    if (record.author?.kind === "rsi" && kind !== "human") {
      return {
        ok: false,
        id,
        code: "MOD_AGENT_APPROVAL_FORBIDDEN",
        codes: ["MOD_AGENT_APPROVAL_FORBIDDEN", "MOD_RSI_NEEDS_HUMAN"],
        decision: current,
      };
    }
    if (by === "") return { ok: false, id, code: "MOD_APPROVER_MISSING", codes: ["MOD_APPROVER_MISSING"], decision: current };
    const now = Date.now();
    const approver = { kind, id: by, at: now };
    // 重评时把 decision 归零到 pending:need-approval 不是终态,不得触发 MOD_DECISION_FINAL。
    const evaluation = rt.evaluateSelfModification({ ...record, decision: { kind: "pending" }, approver });
    const codes = [...evaluation.codes];
    const decision: ModificationDecision = { kind: evaluation.decision, at: now, codes };
    const patch: UnknownRecord = { approver, decision };
    if (reason !== "") patch["reason"] = reason;
    const line: UnknownRecord = { v: SCHEMA_VERSION, type: "approve", at: now, id: id.trim(), patch };
    if (!appendLedgerLine(base, line)) return writeFailedResult(id);
    return {
      ok: decision.kind === "allow",
      id,
      decision: decision.kind,
      codes,
      details: [...evaluation.details],
    };
  } catch {
    return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
  }
}

/** 拒绝请求(reason 必填;已终态拒绝)。 */
export function denyModification(
  root: string,
  id: string,
  opts: { by?: string; reason?: string } = {},
): SelfModActionResult {
  const base = assertRoot("denyModification", root);
  if (typeof id !== "string") throw new TypeError("denyModification: id 必须是字符串");
  const reason = str(opts?.reason).trim();
  if (reason === "") return { ok: false, id, code: "MOD_REASON_REQUIRED", codes: ["MOD_REASON_REQUIRED"] };
  if (id.trim() === "") return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
  const by = str(opts?.by).trim();
  try {
    const record = findRecord(base, id.trim());
    if (!record) return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
    const current = String(record.decision?.kind ?? "pending");
    if (FINAL_DECISIONS.has(current)) {
      return { ok: false, id, code: "MOD_DECISION_FINAL", codes: ["MOD_DECISION_FINAL"], decision: current };
    }
    const now = Date.now();
    const patch: UnknownRecord = { decision: { kind: "deny", at: now, codes: ["MOD_DENIED"] }, reason };
    if (by !== "") patch["by"] = by;
    const line: UnknownRecord = { v: SCHEMA_VERSION, type: "deny", at: now, id: id.trim(), patch };
    if (!appendLedgerLine(base, line)) return writeFailedResult(id);
    return { ok: true, id, decision: "deny", codes: ["MOD_DENIED"] };
  } catch {
    return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
  }
}

/**
 * 标记已应用:先按冻结 hash 复核变更面(不符 → MOD_HASH_MISMATCH,不写盘),
 * 通过后写 apply 行(frozenHash + 审批对象哈希 objectHash)。
 */
export function markApplied(
  root: string,
  id: string,
  opts: { frozenHash?: string } = {},
): SelfModActionResult {
  const base = assertRoot("markApplied", root);
  if (typeof id !== "string") throw new TypeError("markApplied: id 必须是字符串");
  if (id.trim() === "") return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
  try {
    const record = findRecord(base, id.trim());
    if (!record) return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
    const current = String(record.decision?.kind ?? "pending");
    if (record.applied === true || current !== "allow") {
      return { ok: false, id, code: "MOD_DECISION_FINAL", codes: ["MOD_DECISION_FINAL"], decision: current };
    }
    const frozenHash = str(opts?.frozenHash);
    const verify = rt.verifySelfModification(frozenHash, record);
    if (verify.match !== true) {
      return {
        ok: false,
        id,
        code: "MOD_HASH_MISMATCH",
        codes: ["MOD_HASH_MISMATCH"],
        decision: current,
        frozenHash: verify.hash,
      };
    }
    let objectHash: string;
    try {
      objectHash = approvalObjectHash(record);
    } catch {
      return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
    }
    const now = Date.now();
    const patch: UnknownRecord = { frozenHash: verify.hash, objectHash };
    const line: UnknownRecord = { v: SCHEMA_VERSION, type: "apply", at: now, id: id.trim(), patch };
    if (!appendLedgerLine(base, line)) return writeFailedResult(id);
    return { ok: true, id, applied: true, frozenHash: verify.hash, objectHash, decision: current, codes: [] };
  } catch {
    return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
  }
}

/** 回滚(reason 必填;已 rolled-back 拒绝)。 */
export function rollbackModification(
  root: string,
  id: string,
  opts: { reason?: string; by?: string } = {},
): SelfModActionResult {
  const base = assertRoot("rollbackModification", root);
  if (typeof id !== "string") throw new TypeError("rollbackModification: id 必须是字符串");
  const reason = str(opts?.reason).trim();
  if (reason === "") return { ok: false, id, code: "MOD_REASON_REQUIRED", codes: ["MOD_REASON_REQUIRED"] };
  if (id.trim() === "") return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
  try {
    const record = findRecord(base, id.trim());
    if (!record) return { ok: false, id, code: "MOD_NOT_FOUND", codes: [] };
    const current = String(record.decision?.kind ?? "pending");
    if (current === "rolled-back") {
      return { ok: false, id, code: "MOD_DECISION_FINAL", codes: ["MOD_DECISION_FINAL"], decision: current };
    }
    const now = Date.now();
    const patch: UnknownRecord = { decision: { kind: "rolled-back", at: now, codes: ["MOD_ROLLED_BACK"] }, reason };
    const line: UnknownRecord = { v: SCHEMA_VERSION, type: "rollback", at: now, id: id.trim(), patch };
    if (!appendLedgerLine(base, line)) return writeFailedResult(id);
    return { ok: true, id, decision: "rolled-back", codes: ["MOD_ROLLED_BACK"] };
  } catch {
    return { ok: false, id, code: "MOD_STORE_ERROR", codes: ["MOD_STORE_ERROR"] };
  }
}

/** 列表(可按 surface / decision.kind 过滤;按首次出现顺序)。 */
export function listModifications(root: string, filter: SelfModFilter = {}): ModificationRecord[] {
  const base = assertRoot("listModifications", root);
  const requests = loadSelfModProjection(base).requests;
  const surface = filter?.surface === undefined ? undefined : String(filter.surface);
  const decision = filter?.decision === undefined ? undefined : String(filter.decision);
  return requests.filter((r) => {
    if (surface !== undefined && String(r.surface) !== surface) return false;
    if (decision !== undefined && String(r.decision?.kind ?? "") !== decision) return false;
    return true;
  });
}

/** 取单条记录(不存在 → undefined)。 */
export function getModification(root: string, id: string): ModificationRecord | undefined {
  const base = assertRoot("getModification", root);
  if (typeof id !== "string" || id.trim() === "") return undefined;
  return findRecord(base, id.trim());
}

/** 报表:总/坏行、按决策计数的分组与按 surface 的分布。 */
export function reportModifications(root: string): SelfModReport {
  const base = assertRoot("reportModifications", root);
  const projection = loadSelfModProjection(base);
  const bySurface: Record<string, number> = {};
  let pending = 0;
  let allowed = 0;
  let needApproval = 0;
  let denied = 0;
  let applied = 0;
  let rolledBack = 0;
  for (const record of projection.requests) {
    const kind = String(record.decision?.kind ?? "pending");
    if (kind === "allow") allowed += 1;
    else if (kind === "need-approval") needApproval += 1;
    else if (kind === "deny") denied += 1;
    else if (kind === "rolled-back") rolledBack += 1;
    else pending += 1;
    if (record.applied === true) applied += 1;
    const surface = String(record.surface ?? "");
    bySurface[surface] = (bySurface[surface] ?? 0) + 1;
  }
  return {
    ok: true,
    totalLines: projection.totalLines,
    badLines: projection.badLines,
    total: projection.requests.length,
    pending,
    allowed,
    needApproval,
    denied,
    applied,
    rolledBack,
    bySurface,
  };
}
