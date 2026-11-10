/**
 * #198 注入安全边界台账(生产侧):把 rsi-injection-guard 的纯判定落到 append-only jsonl。
 * 为什么 append-only:准入/批准/拉黑都是审计事实,后来的写入不能覆盖先前的判定;
 * 单行追加 + 写后行数校验(重读统计非空行)让「真的写进去了吗」变成可复核断言,
 * 而不是信任 appendFileSync 没抛异常。
 * 数据面:`<root>/.genie/rsi/injection.jsonl`,每行一条 `{"v":1,"type":...,"at":ISO,...}`
 * - `evaluate{id,ok,codes,sourceId,channel,templateId?,textHash,riskFlags?}` —— 一次准入判定。
 * - `approve{id,sourceId,channel,textHash,by,kind}` —— 人类批准(id 指向 evaluate 行)。
 * - `blacklist{sourceId,by,reason}` —— 来源拉黑。
 * **绝不落原文**:evaluate 行只落 `sha256(text)`(textHash)加结构化字段;原文可能含密钥、
 * 机密片段或注入载荷本身,落盘就等于把问题复制进审计日志。审阅靠 sanitizedText 即时返回,
 * 不靠日志回读。
 * 投影语义(读时折叠,不写回):
 * - blacklisted = 有 blacklist 行的 sourceId;
 * - 已批 = 存在同 id 的 approve 行;pendingApproval = 含高风险码且无 approve 行的 evaluate 数;
 * - 坏行(JSON 坏 / v 不认识 / type 不认识 / 缺字段)只计 corruptLines 后跳过:一行坏不整文件失效、不 throw。
 * 依赖纪律:node:fs / node:path / node:crypto + runtime 纯逻辑(惰性 URL 解析,.ts 后缀,
 * 与 rsi-breaker-store 同一跑法);不 import agent loop / gateway server。
 * 参数错误(TypeError)是唯一允许 throw 的情形;IO 失败一律折叠成稳定码返回。
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InjectionApprover,
  InjectionChannel,
  InjectionPayload,
  InjectionPolicy,
  InjectionRiskFlag,
  InjectionSourceKind,
} from "@lampgenie/runtime/agent/rsi-injection-guard";

/**
 * 惰性解析 runtime 的纯逻辑模块。
 * 用 `.ts` 显式后缀的 URL 动态 import:静态包名 import 在 `node --experimental-strip-types`
 * 下会解析到 dist(CLI 场景没有 development 条件),而 tsc/ vitest 侧都走 src。
 */
type GuardModule = {
  evaluateInjection: typeof import("@lampgenie/runtime/agent/rsi-injection-guard").evaluateInjection;
};

let guardModule: GuardModule | undefined;

async function loadGuard(): Promise<GuardModule> {
  if (guardModule) return guardModule;
  const srcUrl = new URL(
    "../../../packages/harness-runtime/src/agent/rsi-injection-guard.ts",
    import.meta.url).href;
  guardModule = (await import(srcUrl)) as GuardModule;
  return guardModule;
}

/** store 层自产的稳定码(闸门码沿用 runtime 的 INJ_CODES)。 */
export const INJ_STORE_CODES = [
  "INJ_STORE_WRITE_FAILED",
  "INJ_AUDIT_NOT_FOUND",
  "INJ_ALREADY_APPROVED",
  "INJ_APPROVAL_MISSING",
  "INJ_ALREADY_BLACKLISTED",
  "INJ_LEDGER_WRITE_MISMATCH",
] as const;

export type InjStoreCode = (typeof INJ_STORE_CODES)[number];

export const INJECTION_LINE_TYPES = ["evaluate", "approve", "blacklist"] as const;
export type InjectionLineType = (typeof INJECTION_LINE_TYPES)[number];

/** 「高风险需要批准」的码;pendingApproval 投影以此为准。 */
const HIGH_RISK_CODES: ReadonlySet<string> = new Set(["INJ_HIGH_RISK_NEEDS_APPROVAL", "INJ_APPROVAL_MISSING"]);

export interface InjectionPaths {
  dir: string;
  file: string;
}

/** 台账行(只增不改)。approve/blacklist 行的 textHash 取被引用行的值(blacklist 为 "")。 */
export interface InjectionAuditLine {
  v: 1;
  type: InjectionLineType;
  at: string;
  id: string;
  ok: boolean;
  codes: string[];
  sourceId: string;
  channel: string;
  templateId?: string;
  textHash: string;
  riskFlags?: InjectionRiskFlag[];
  /** 命中台账人工批准时指向被采信的 evaluate 行(只落 id,不落原文)。 */
  approvalRef?: string;
  by?: string;
  kind?: "human" | "agent";
  reason?: string;
}

export function injectionPaths(root: string): InjectionPaths {
  const dir = join(root, ".genie", "rsi");
  return { dir, file: join(dir, "injection.jsonl") };
}

/** 原文的 sha256(仅此一种形态落盘;不回读原文)。 */
export function hashInjectionText(text: string): string {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

function newAuditId(): string {
  return `inj_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function assertRoot(root: string): void {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("root 必填(非空字符串)");
}

function readRaw(file: string): string[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((line) => line.trim().length > 0);
}

function isLine(value: unknown): value is InjectionAuditLine {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (rec.v !== 1) return false;
  if (typeof rec.type !== "string") return false;
  if (!(INJECTION_LINE_TYPES as readonly string[]).includes(rec.type)) return false;
  if (typeof rec.at !== "string" || typeof rec.id !== "string") return false;
  if (typeof rec.ok !== "boolean") return false;
  if (!Array.isArray(rec.codes) || rec.codes.some((c) => typeof c !== "string")) return false;
  if (typeof rec.sourceId !== "string") return false;
  if (typeof rec.textHash !== "string") return false;
  return true;
}

export interface InjectionLedger {
  lines: InjectionAuditLine[];
  /** 坏行数(跳过,不失效整文件)。 */
  corruptLines: number;
  /** 文件里的非空行数(含坏行)。 */
  rawLines: number;
}

/** 读台账并投影前的拆解:坏行只计数。 */
export function readInjectionLedger(root: string): InjectionLedger {
  assertRoot(root);
  const { file } = injectionPaths(root);
  const raw = readRaw(file);
  const lines: InjectionAuditLine[] = [];
  let corruptLines = 0;
  for (const line of raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptLines++;
      continue;
    }
    if (!isLine(parsed)) {
      corruptLines++;
      continue;
    }
    lines.push({ ...parsed, channel: typeof parsed.channel === "string" ? parsed.channel : "" });
  }
  return { lines, corruptLines, rawLines: raw.length };
}

interface AppendResult {
  ok: boolean;
  /** 写后非空行数与写前不符。 */
  mismatch: boolean;
}

function appendLine(root: string, line: InjectionAuditLine): AppendResult {
  const paths = injectionPaths(root);
  try {
    mkdirSync(paths.dir, { recursive: true });
    const before = readRaw(paths.file).length;
    appendFileSync(paths.file, `${JSON.stringify(line)}\n`, "utf8");
    const after = readRaw(paths.file).length;
    return { ok: true, mismatch: after !== before + 1 };
  } catch {
    return { ok: false, mismatch: false };
  }
}

function iso(now?: number): string {
  return new Date(Number.isFinite(now) ? (now as number) : Date.now()).toISOString();
}

/**
 * 台账里的 riskFlags:secret 命中做遮蔽(前 4 字符 + 长度)。
 * 判定结果里的 riskFlags 保留原字面(即时审阅要看全),但**落盘**的日志是长期驻留的,
 * 把密钥原文抄进 jsonl 等于换个地方泄密。
 */
function maskSecretLiteral(match: string): string {
  const chars = Array.from(match);
  if (chars.length <= 4) return "****";
  return `${chars.slice(0, 4).join("")}…(${chars.length})`;
}

function maskRiskFlagsForLedger(flags: InjectionRiskFlag[]): InjectionRiskFlag[] {
  return flags.map((flag) =>
    flag.kind === "secret" ? { kind: flag.kind, match: maskSecretLiteral(flag.match) } : { ...flag },
  );
}

export interface GuardInjectionOptions {
  policy?: InjectionPolicy;
  approver?: InjectionApprover;
  /** 可注入时钟(单测/审计回放)。 */
  now?: number;
  /** 覆盖 auditId(单测)。 */
  auditId?: string;
}

export interface GuardInjectionResult {
  ok: boolean;
  auditId: string;
  codes: string[];
  sanitizedText?: string;
  wrapped?: string;
  riskFlags: InjectionRiskFlag[];
  templateId?: string;
  /** 命中台账人工批准时,被采信的 evaluate 行 id(供 CLI/调用方展示审批链)。 */
  approvalRef?: string;
  /** store 侧风险(命中也照常返回判定结果,例如 INJ_LEDGER_WRITE_MISMATCH)。 */
  risks?: string[];
}

function pickSourceId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const source = (payload as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return "";
  const id = (source as { id?: unknown }).id;
  return typeof id === "string" ? id.trim() : "";
}

function pickChannel(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const channel = (payload as { channel?: unknown }).channel;
  return typeof channel === "string" ? channel : "";
}

function pickText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export interface LedgerApproval {
  auditId: string;
  by: string;
}

/**
 * 从台账投影解析「已有人类批准」。
 * 绑定口径:先按 sourceId + textHash **完全匹配**找回 evaluate 行(内容换了就找不到,
 * 来源换了也找不到),再找针对该 auditId 的 approve 行且 approver.kind==="human"。
 * agent 批准行不采信(approveInjection 本来就拒了 agent,这里再守一次防线)。
 * 多条命中取最新(从尾部倒扫)。批准过期语义刻意不引入。
 */
function findHumanApproval(
  lines: InjectionAuditLine[],
  sourceId: string,
  textHash: string): LedgerApproval | undefined {
  if (!sourceId || !textHash) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = lines[i]!;
    if (row.type !== "evaluate" || row.sourceId !== sourceId || row.textHash !== textHash) continue;
    const approval = lines.find(
      (l) =>
        l.type === "approve" &&
        l.id === row.id &&
        l.kind === "human" &&
        typeof l.by === "string" &&
        l.by.trim().length > 0);
    if (approval) return { auditId: row.id, by: (approval.by as string).trim() };
  }
  return undefined;
}

/**
 * 准入闸门(解析台账批准 → 查黑名单 → 判定 → 落 evaluate 行)。
 * 顺序说明:黑名单必须在判定**之前**查好并传入纯逻辑,否则被拉黑的来源会拿到 ok:true 的
 * 判定结果;落盘失败不算「通过」,返回 ok:false + INJ_STORE_WRITE_FAILED(宁可挡住也不静默放过)。
 * 人工批准闭环:调用方显式 options.approver 优先;没给时回放台账里「同 sourceId + 同 textHash」
 * 的 human 批准,以 {kind:"human", id:by} 传入纯逻辑。没有这一步,approve 永远无法让内容通过。
 */
export async function guardInjection(
  root: string,
  payload: InjectionPayload,
  options: GuardInjectionOptions = {},
): Promise<GuardInjectionResult> {
  assertRoot(root);
  const guard = await loadGuard();
  const sourceId = pickSourceId(payload);
  const channel = pickChannel(payload);
  const textHash = hashInjectionText(pickText(payload));
  const { lines } = readInjectionLedger(root);
  const blacklisted = sourceId
    ? lines.some((l) => l.type === "blacklist" && l.sourceId === sourceId)
    : false;
  const ledgerApproval = options.approver ? undefined : findHumanApproval(lines, sourceId, textHash);
  const approver: InjectionApprover | undefined =
    options.approver ?? (ledgerApproval ? { kind: "human", id: ledgerApproval.by } : undefined);
  const evaluation = guard.evaluateInjection(payload, options.policy, {
    approver,
    blacklisted,
  });

  const auditId = options.auditId ?? newAuditId();
  const line: InjectionAuditLine = {
    v: 1,
    type: "evaluate",
    at: iso(options.now),
    id: auditId,
    ok: evaluation.ok,
    codes: [...evaluation.codes],
    sourceId,
    channel,
    textHash,
    riskFlags: maskRiskFlagsForLedger(evaluation.riskFlags),
  };
  if (evaluation.templateId) line.templateId = evaluation.templateId;
  if (ledgerApproval) line.approvalRef = ledgerApproval.auditId;

  const appended = appendLine(root, line);
  const risks: string[] = [];
  if (appended.mismatch) risks.push("INJ_LEDGER_WRITE_MISMATCH");

  const base = {
    auditId,
    sanitizedText: evaluation.sanitizedText,
    wrapped: evaluation.wrapped,
    riskFlags: evaluation.riskFlags,
    templateId: evaluation.templateId,
    ...(ledgerApproval ? { approvalRef: ledgerApproval.auditId } : {}),
    ...(risks.length ? { risks } : {}),
  };

  if (!appended.ok) {
    return { ...base, ok: false, codes: [...evaluation.codes, "INJ_STORE_WRITE_FAILED"] };
  }
  return { ...base, ok: evaluation.ok, codes: [...evaluation.codes] };
}

export interface ApproveInput {
  by: string;
  kind: "human" | "agent";
}

export interface StoreActionResult {
  ok: boolean;
  code?: string;
  /** 写后行数校验不符时的提示(不改变 ok)。 */
  risks?: string[];
}

/**
 * 人工批准(只认 human;agent 自批准不算)。
 * 幂等语义刻意做成「重复即拒」:同一 auditId 二次批准会掩盖审批链,审计上必须显形。
 */
export async function approveInjection(
  root: string,
  auditId: string,
  input: ApproveInput): Promise<StoreActionResult> {
  assertRoot(root);
  if (typeof auditId !== "string" || !auditId.trim()) throw new TypeError("auditId 必填");
  if (typeof input !== "object" || input === null) throw new TypeError("input 必填");
  const by = typeof input.by === "string" ? input.by.trim() : "";
  if (!by) throw new TypeError("by 必填");

  if (input.kind !== "human") return { ok: false, code: "INJ_APPROVAL_MISSING" };

  const { lines } = readInjectionLedger(root);
  const target = lines.find((l) => l.type === "evaluate" && l.id === auditId);
  if (!target) return { ok: false, code: "INJ_AUDIT_NOT_FOUND" };
  if (lines.some((l) => l.type === "approve" && l.id === auditId)) {
    return { ok: false, code: "INJ_ALREADY_APPROVED" };
  }

  const line: InjectionAuditLine = {
    v: 1,
    type: "approve",
    at: iso(),
    id: auditId,
    ok: true,
    codes: [],
    sourceId: target.sourceId,
    channel: target.channel,
    textHash: target.textHash,
    by,
    kind: "human",
  };
  const appended = appendLine(root, line);
  if (!appended.ok) return { ok: false, code: "INJ_STORE_WRITE_FAILED" };
  return appended.mismatch ? { ok: true, risks: ["INJ_LEDGER_WRITE_MISMATCH"] } : { ok: true };
}

export interface BlacklistInput {
  by: string;
  reason: string;
}

/** 拉黑一个来源 id:此后该 source 的所有注入在判定前就被打 INJ_BLACKLISTED。 */
export async function blacklistSource(
  root: string,
  sourceId: string,
  input: BlacklistInput): Promise<StoreActionResult> {
  assertRoot(root);
  if (typeof sourceId !== "string" || !sourceId.trim()) throw new TypeError("sourceId 必填");
  if (typeof input !== "object" || input === null) throw new TypeError("input 必填");
  const by = typeof input.by === "string" ? input.by.trim() : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!by) throw new TypeError("by 必填");
  if (!reason) throw new TypeError("reason 必填");
  const id = sourceId.trim();

  const { lines } = readInjectionLedger(root);
  if (lines.some((l) => l.type === "blacklist" && l.sourceId === id)) {
    return { ok: false, code: "INJ_ALREADY_BLACKLISTED" };
  }
  const latest = [...lines].reverse().find((l) => l.type === "evaluate" && l.sourceId === id);

  const line: InjectionAuditLine = {
    v: 1,
    type: "blacklist",
    at: iso(),
    id: newAuditId(),
    ok: true,
    codes: [],
    sourceId: id,
    channel: latest?.channel ?? "",
    textHash: "",
    by,
    reason,
  };
  const appended = appendLine(root, line);
  if (!appended.ok) return { ok: false, code: "INJ_STORE_WRITE_FAILED" };
  return appended.mismatch ? { ok: true, risks: ["INJ_LEDGER_WRITE_MISMATCH"] } : { ok: true };
}

/** 来源是否已拉黑(坏行忽略,不 throw)。 */
export function isBlacklisted(root: string, sourceId: string): boolean {
  assertRoot(root);
  if (typeof sourceId !== "string" || !sourceId.trim()) return false;
  const id = sourceId.trim();
  const { lines } = readInjectionLedger(root);
  return lines.some((l) => l.type === "blacklist" && l.sourceId === id);
}

export interface InjectionReport {
  /** evaluate 行数(= 被评估的注入次数)。 */
  total: number;
  /** 全部合法行数(evaluate + approve + blacklist)。 */
  lines: number;
  byCode: Record<string, number>;
  byChannel: Record<string, number>;
  bySource: Record<string, number>;
  blacklisted: string[];
  /** 含高风险码且尚无 approve 行的 evaluate 数。 */
  pendingApproval: number;
  corruptLines: number;
  risks: string[];
}

/** 台账投影(report):只读、不写回、坏行不 throw。 */
export function reportInjections(root: string): InjectionReport {
  assertRoot(root);
  const { lines, corruptLines } = readInjectionLedger(root);
  const evaluates = lines.filter((l) => l.type === "evaluate");
  const approvedIds = new Set(lines.filter((l) => l.type === "approve").map((l) => l.id));

  const byCode: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let pendingApproval = 0;
  for (const line of evaluates) {
    for (const code of line.codes) byCode[code] = (byCode[code] ?? 0) + 1;
    const channel = line.channel || "unknown";
    byChannel[channel] = (byChannel[channel] ?? 0) + 1;
    const source = line.sourceId || "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;
    if (!approvedIds.has(line.id) && line.codes.some((c) => HIGH_RISK_CODES.has(c))) pendingApproval++;
  }

  const blacklisted = Array.from(
    new Set(lines.filter((l) => l.type === "blacklist").map((l) => l.sourceId)),
  ).sort();

  const risks: string[] = [];
  if (corruptLines > 0) risks.push(`坏行 ${corruptLines} 行已跳过`);

  return {
    total: evaluates.length,
    lines: lines.length,
    byCode,
    byChannel,
    bySource,
    blacklisted,
    pendingApproval,
    corruptLines,
    risks,
  };
}

/** 供 CLI 展示渠道名用(避免调用方自己拼字面量)。 */
export function channelOf(payload: InjectionPayload): InjectionChannel | "" {
  return pickChannel(payload) as InjectionChannel | "";
}

/** 供 CLI/调用方打印来源类型(仅类型收敛用)。 */
export function sourceKindOf(payload: InjectionPayload): InjectionSourceKind | "" {
  if (typeof payload !== "object" || payload === null) return "";
  const source = (payload as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return "";
  const kind = (source as { kind?: unknown }).kind;
  return kind === "rsi" || kind === "human" || kind === "system" ? kind : "";
}
