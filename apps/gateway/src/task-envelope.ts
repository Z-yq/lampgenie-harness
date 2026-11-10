/**
 * M162 任务执行信封(来源签发)。
 *
 * 背景:机器人/远端/群/子代理的任务此前用自己的默认权限跑;在途改配置对已创建任务无感生效;
 * 重投递会重复执行;远程断线可能悄悄落到同路径本地 workspace。
 *
 * 机制:任务创建时由**服务端**签发 {taskId,generation,capabilitySnapshot,policy,digest}:
 * - generation 由 capabilitySnapshot 规范化哈希派生(同目录=同代,目录一变代即变);
 * - digest 是信封本体的 canonical(键排序/数组排序/忽略 undefined)sha256 截断;
 * - 执行前比对当前能力目录/策略,不匹配 fail-closed(四漂移码,带 expected/actual 短摘要,不含敏感内容);
 * - deliveryKey → 投递键 `env:<kind>:<id>:<deliveryKey>`,复用 TaskSupervisor 幂等索引去重;
 * - 外部来源不得自声明 workspace/projectOverride/permissions(自声明即拒)。
 *
 * 刻意不做的:不引入传输层签名(信封只在本进程内签发/校验),capabilitySnapshot 由装配方注入。
 */
import { createHash } from "node:crypto";
import { BUILTIN_COMMANDS } from "./command-catalog.js";
import type { Task } from "@lampgenie/core";
import type { TaskSupervisor } from "./task-manager.js";

// ── 类型 ────────────────────────────────────────────────────────────────────

export type EnvelopeSourceKind = "bot" | "remote" | "group" | "schedule" | "subagent" | "user";

/** 需要服务端签发信封的「外部来源」;user/subagent 属内部来源(子代理恒走父任务权限)。 */
export const EXTERNAL_SOURCE_KINDS: readonly EnvelopeSourceKind[] = ["bot", "remote", "group", "schedule"];

export interface EnvelopeSource {
  kind: EnvelopeSourceKind;
  id: string;
}

export interface CapabilitySnapshot {
  /** 工具面名(排序去重后进 digest)。 */
  toolsets: string[];
  /** 命令名(内置+自定义;当前实现只收内置命令名)。 */
  commands: string[];
}

export interface EnvelopePolicy {
  /** 审批口径(permission mode 或 preset 名)。 */
  approval: string;
  /** 最大迭代步数(agent.maxSteps 同源)。 */
  maxIterations: number;
  /** 可选 token 预算(P1:本轮只入快照,不参与运行时强制)。 */
  budgetTokens?: number;
}

export interface TaskEnvelope {
  version: 1;
  taskId: string;
  source: EnvelopeSource;
  generation: string;
  capabilitySnapshot: CapabilitySnapshot;
  policy: EnvelopePolicy;
  deliveryKey?: string;
  issuedAt: number;
  digest: string;
}

export type EnvelopeErrorCode =
  | "ENVELOPE_INVALID"
  | "ENVELOPE_DIGEST_MISMATCH"
  | "ENVELOPE_GENERATION_DRIFT"
  | "ENVELOPE_CAPABILITY_DRIFT"
  | "ENVELOPE_POLICY_DRIFT"
  | "SOURCE_NOT_SERVER_ISSUED"
  | "SOURCE_SELF_DECLARED_WORKSPACE"
  | "SOURCE_SELF_DECLARED_PERMISSION";

export interface EnvelopeFailure {
  ok: false;
  code: EnvelopeErrorCode;
  message: string;
  /** 短摘要(哈希片段/代数),绝不带原始 toolsets/commands 内容。 */
  expected?: string;
  actual?: string;
}

export class EnvelopeError extends Error {
  code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = "EnvelopeError";
    this.code = code;
  }
}

// ── canonical 序列化 ─────────────────────────────────────────────────────────

/** 递归规范化:对象键排序、数组排序(原始值按 JSON 字面比较)、忽略 undefined。 */
function normalizeValue(input: unknown): unknown {
  if (input === null) return null;
  if (Array.isArray(input)) {
    return input
      .filter((v) => v !== undefined)
      .map(normalizeValue)
      .sort((a, b) => {
        const sa = JSON.stringify(a) ?? "";
        const sb = JSON.stringify(b) ?? "";
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
  }
  if (typeof input === "object") {
    const src = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined) continue;
      out[key] = normalizeValue(v);
    }
    return out;
  }
  return input;
}

/** canonical JSON(键排序/数组排序/忽略 undefined);digest 与 generation 的唯一来源。 */
export function canonicalJson(input: unknown): string {
  return JSON.stringify(normalizeValue(input));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 短哈希(摘要/代数共用的截断口径)。 */
function shaShort(text: string, len: number): string {
  return sha256Hex(text).slice(0, len);
}

export function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))].sort();
}

export function normalizeCapabilitySnapshot(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return {
    toolsets: uniqSorted(snapshot.toolsets ?? []),
    commands: uniqSorted(snapshot.commands ?? []),
  };
}

export function normalizeEnvelopePolicy(policy: EnvelopePolicy): EnvelopePolicy {
  return {
    approval: policy.approval,
    maxIterations: policy.maxIterations,
    ...(policy.budgetTokens === undefined ? {} : { budgetTokens: policy.budgetTokens }),
  };
}

/** 代数:capabilitySnapshot 的规范化 sha16(同目录=同代,目录一变代即变)。 */
export function generationOf(snapshot: CapabilitySnapshot): string {
  return shaShort(canonicalJson(normalizeCapabilitySnapshot(snapshot)), 16);
}

/** 信封 digest:sha256(canonical JSON,忽略 digest).slice(0,32)。 */
export function envelopeDigest(envelope: TaskEnvelope | Omit<TaskEnvelope, "digest">): string {
  const { digest: _digest, ...body } = envelope as TaskEnvelope;
  const canon = canonicalJson({
    version: body.version,
    taskId: body.taskId,
    source: body.source,
    generation: body.generation,
    capabilitySnapshot: normalizeCapabilitySnapshot(body.capabilitySnapshot),
    policy: normalizeEnvelopePolicy(body.policy),
    ...(body.deliveryKey === undefined ? {} : { deliveryKey: body.deliveryKey }),
    issuedAt: body.issuedAt,
  });
  return shaShort(canon, 32);
}

// ── 能力目录(装配方注入;缺省=当前工具面+命令名)──────────────────────────────

let recordedSurface: CapabilitySnapshot | null = null;

/** 装配方每次装配完工具面后登记(此后签发/校验都用它)。 */
export function recordCapabilitySurface(toolsets: readonly string[], commands: readonly string[]): CapabilitySnapshot {
  recordedSurface = normalizeCapabilitySnapshot({ toolsets: [...toolsets], commands: [...commands] });
  return recordedSurface;
}

/** 冷启动基线:未登记工具面 = 空工具面 + 内置命令名。 */
export function baselineCapabilitySnapshot(): CapabilitySnapshot {
  return normalizeCapabilitySnapshot({ toolsets: [], commands: BUILTIN_COMMANDS.map((c) => c.name) });
}

/** 当前能力目录:登记值优先,未登记=基线。 */
export function currentCapabilitySnapshot(): CapabilitySnapshot {
  return recordedSurface ?? baselineCapabilitySnapshot();
}

/** 测试隔离用:清空登记(生产只在装配时登记,不在别处写)。 */
export function resetCapabilitySurface(): void {
  recordedSurface = null;
}

/** 缺省策略(服务端未注入时的兜底):审批口径 ask、3000 步(与 agent.maxSteps 缺省一致)。 */
export function defaultEnvelopePolicy(): EnvelopePolicy {
  return { approval: "ask", maxIterations: 3000 };
}

// ── 签发 ────────────────────────────────────────────────────────────────────

export interface IssueEnvelopeInput {
  taskId: string;
  source: EnvelopeSource;
  capabilitySnapshot: CapabilitySnapshot;
  policy: EnvelopePolicy;
  deliveryKey?: string;
  issuedAt?: number;
  /** 客户端自带的摘要/签名标记:外部来源不接受(必须服务端签发)→ SOURCE_NOT_SERVER_ISSUED。 */
  clientDigest?: string;
  clientSigned?: boolean;
}

export interface IssuedEnvelope {
  envelope: TaskEnvelope;
  /** journal 落账载荷(kind 固定 custom,type=task.envelope.issued)。 */
  journalPayload: { type: "task.envelope.issued"; taskId: string; envelope: TaskEnvelope };
}

export function isExternalSourceKind(kind: unknown): kind is EnvelopeSourceKind {
  return typeof kind === "string" && (EXTERNAL_SOURCE_KINDS as readonly string[]).includes(kind);
}

export function isEnvelopeSourceKind(kind: unknown): kind is EnvelopeSourceKind {
  return kind === "user" || kind === "subagent" || isExternalSourceKind(kind);
}

export function isTaskEnvelope(value: unknown): value is TaskEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<TaskEnvelope>;
  const source = v.source as EnvelopeSource | undefined;
  return v.version === 1
    && typeof v.taskId === "string" && v.taskId.length > 0
    && !!source && typeof source === "object"
    && isEnvelopeSourceKind(source.kind)
    && typeof source.id === "string"
    && typeof v.generation === "string"
    && !!v.capabilitySnapshot && Array.isArray(v.capabilitySnapshot.toolsets) && Array.isArray(v.capabilitySnapshot.commands)
    && !!v.policy && typeof v.policy.approval === "string" && typeof v.policy.maxIterations === "number"
    && typeof v.issuedAt === "number"
    && typeof v.digest === "string";
}

/**
 * 签发信封。外部来源必须由服务端签发:入参带客户端摘要/签名标记一律拒绝(fail-closed)。
 * 返回 { envelope, journalPayload },落账由调用方完成(kind=custom)。
 */
export function issueEnvelope(input: IssueEnvelopeInput): IssuedEnvelope {
  if (!input || typeof input !== "object") throw new EnvelopeError("ENVELOPE_INVALID", "信封入参缺失");
  if (typeof input.taskId !== "string" || input.taskId.length === 0) throw new EnvelopeError("ENVELOPE_INVALID", "taskId 必填");
  if (!input.source || !isEnvelopeSourceKind(input.source.kind)) throw new EnvelopeError("ENVELOPE_INVALID", "source.kind 非法");
  if (typeof input.source.id !== "string" || input.source.id.length === 0) throw new EnvelopeError("ENVELOPE_INVALID", "source.id 必填");
  if (!input.capabilitySnapshot || !Array.isArray(input.capabilitySnapshot.toolsets) || !Array.isArray(input.capabilitySnapshot.commands)) {
    throw new EnvelopeError("ENVELOPE_INVALID", "capabilitySnapshot 必须是 {toolsets[],commands[]}");
  }
  if (!input.policy || typeof input.policy.approval !== "string" || input.policy.approval.length === 0) {
    throw new EnvelopeError("ENVELOPE_INVALID", "policy.approval 必填");
  }
  if (!Number.isInteger(input.policy.maxIterations) || input.policy.maxIterations <= 0) {
    throw new EnvelopeError("ENVELOPE_INVALID", "policy.maxIterations 必须是正整数");
  }
  if (input.policy.budgetTokens !== undefined && (!Number.isFinite(input.policy.budgetTokens) || input.policy.budgetTokens < 0)) {
    throw new EnvelopeError("ENVELOPE_INVALID", "policy.budgetTokens 非法");
  }
  // 来源签发:外部来源不得自带摘要/签名(客户端签名只能证明它自己,不能证明服务端授权)。
  if (isExternalSourceKind(input.source.kind) && (input.clientDigest !== undefined || input.clientSigned === true)) {
    throw new EnvelopeError("SOURCE_NOT_SERVER_ISSUED", "外部来源的信封必须由服务端签发,不接受客户端自带摘要/签名");
  }
  const capabilitySnapshot = normalizeCapabilitySnapshot(input.capabilitySnapshot);
  const policy = normalizeEnvelopePolicy(input.policy);
  const body: Omit<TaskEnvelope, "digest"> = {
    version: 1,
    taskId: input.taskId,
    source: { kind: input.source.kind, id: input.source.id },
    generation: generationOf(capabilitySnapshot),
    capabilitySnapshot,
    policy,
    ...(input.deliveryKey === undefined ? {} : { deliveryKey: input.deliveryKey }),
    issuedAt: typeof input.issuedAt === "number" ? input.issuedAt : Date.now(),
  };
  const envelope: TaskEnvelope = { ...body, digest: envelopeDigest(body) };
  return {
    envelope,
    journalPayload: { type: "task.envelope.issued", taskId: envelope.taskId, envelope },
  };
}

// ── 校验 ────────────────────────────────────────────────────────────────────

export interface EnvelopeCurrent {
  capabilitySnapshot: CapabilitySnapshot;
  policy: EnvelopePolicy;
}

/** 装配方注入点(server 与 agent-wiring 共用;缺省值见 currentCapabilitySnapshot/defaultEnvelopePolicy)。 */
export interface EnvelopeDeps {
  capabilitySnapshot?: () => CapabilitySnapshot;
  policy?: () => EnvelopePolicy;
}

export type EnvelopeVerifyResult = { ok: true } | EnvelopeFailure;

/**
 * 执行前校验。
 * 判定顺序:digest 完整性 → capabilitySnapshot → generation → policy。
 * generation 由 capabilitySnapshot 派生,能力先判才能给出准确的漂移码;
 * generation 单独被改写时 capability 相等,落到 ENVELOPE_GENERATION_DRIFT。
 */
export function verifyEnvelope(envelope: TaskEnvelope, current: EnvelopeCurrent): EnvelopeVerifyResult {
  if (!isTaskEnvelope(envelope)) {
    return { ok: false, code: "ENVELOPE_INVALID", message: "信封结构非法(缺字段/版本不符)" };
  }
  const expectedDigest = envelopeDigest(envelope);
  if (expectedDigest !== envelope.digest) {
    return {
      ok: false,
      code: "ENVELOPE_DIGEST_MISMATCH",
      message: "信封内容与签发摘要不一致(被篡改)",
      expected: expectedDigest.slice(0, 12),
      actual: envelope.digest.slice(0, 12),
    };
  }
  const currentSnapshot = normalizeCapabilitySnapshot(current.capabilitySnapshot ?? { toolsets: [], commands: [] });
  const envelopeSnapshot = normalizeCapabilitySnapshot(envelope.capabilitySnapshot);
  if (canonicalJson(currentSnapshot) !== canonicalJson(envelopeSnapshot)) {
    return {
      ok: false,
      code: "ENVELOPE_CAPABILITY_DRIFT",
      message: "能力目录已变化(工具面/命令名与签发时不一致),需重新授权",
      expected: generationOf(envelopeSnapshot),
      actual: generationOf(currentSnapshot),
    };
  }
  const currentGeneration = generationOf(currentSnapshot);
  if (currentGeneration !== envelope.generation) {
    return {
      ok: false,
      code: "ENVELOPE_GENERATION_DRIFT",
      message: "信封代数与当前能力目录不符(信封 generation 被改写或过期)",
      expected: envelope.generation,
      actual: currentGeneration,
    };
  }
  const currentPolicy = normalizeEnvelopePolicy(current.policy);
  const envelopePolicy = normalizeEnvelopePolicy(envelope.policy);
  if (canonicalJson(currentPolicy) !== canonicalJson(envelopePolicy)) {
    return {
      ok: false,
      code: "ENVELOPE_POLICY_DRIFT",
      message: "执行策略已变化(审批口径/迭代上限/预算与签发时不一致),需重新授权",
      expected: shaShort(canonicalJson(envelopePolicy), 12),
      actual: shaShort(canonicalJson(currentPolicy), 12),
    };
  }
  return { ok: true };
}

// ── 来源自声明约束 ───────────────────────────────────────────────────────────

export interface DeclaredSourceFields {
  workspace?: unknown;
  projectOverride?: unknown;
  permissions?: unknown;
  policy?: unknown;
}

function containsDeclaration(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/**
 * 外部来源不得自声明执行落点/权限(fail-closed)。
 * 内部来源(user)按现状放行(零变化)。
 */
export function assertSourceDeclaration(source: EnvelopeSource, declared: DeclaredSourceFields = {}): { ok: true } | EnvelopeFailure {
  if (!isExternalSourceKind(source?.kind)) return { ok: true };
  if (containsDeclaration(declared.workspace) || containsDeclaration(declared.projectOverride)) {
    return {
      ok: false,
      code: "SOURCE_SELF_DECLARED_WORKSPACE",
      message: `外部来源(${source.kind})不得自声明 workspace/projectOverride——落点只能由服务端按来源绑定的项目决议`,
    };
  }
  if (containsDeclaration(declared.permissions) || containsDeclaration(declared.policy)) {
    return {
      ok: false,
      code: "SOURCE_SELF_DECLARED_PERMISSION",
      message: `外部来源(${source.kind})不得自声明 permissions/policy——权限只能由签发信封时的服务端策略决定`,
    };
  }
  return { ok: true };
}

// ── 投递键幂等 ───────────────────────────────────────────────────────────────

/** 投递键:`env:<kind>:<id>:<deliveryKey>`;无 deliveryKey=不做投递幂等。 */
export function deliveryIdOf(envelope: Pick<TaskEnvelope, "source" | "deliveryKey">): string | undefined {
  if (!envelope?.deliveryKey) return undefined;
  const kind = envelope.source?.kind ?? "unknown";
  const id = envelope.source?.id ?? "unknown";
  return `env:${kind}:${id}:${envelope.deliveryKey}`;
}

// ── journal 反查(开工前校验用)──────────────────────────────────────────────

export type IssuedEnvelopeLookup =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; envelope: TaskEnvelope };

/** 从 journal 事件里取该 task 最近一条 task.envelope.issued。 */
export function findIssuedEnvelope(
  events: readonly { kind?: string; payload?: unknown }[] | undefined,
  taskId: string,
): IssuedEnvelopeLookup {
  if (!Array.isArray(events)) return { kind: "none" };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const payload = events[i]?.payload as { type?: unknown; taskId?: unknown; envelope?: unknown } | undefined;
    if (!payload || payload.type !== "task.envelope.issued") continue;
    if (payload.taskId !== taskId) continue;
    return isTaskEnvelope(payload.envelope) ? { kind: "ok", envelope: payload.envelope } : { kind: "invalid" };
  }
  return { kind: "none" };
}

// ── 外部来源提交闸(server task.submit 接线的主体,依赖注入可单测)─────────────

/** task.submit 原始消息里的外部来源相关字段(协议未加字段,按存在性读取;面板不会带)。 */
export interface ExternalSubmitRaw {
  owner?: unknown;
  source?: unknown;
  envelope?: unknown;
  deliveryKey?: unknown;
  workspace?: unknown;
  projectOverride?: unknown;
  permissions?: unknown;
  policy?: unknown;
}

/** 外部来源判定:显式 source{kind,id} > source 字符串 > owner 来源标记;user/缺省=非外部。 */
export function externalSourceOf(raw: ExternalSubmitRaw | undefined, fallbackId?: string): EnvelopeSource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw.source;
  if (src && typeof src === "object") {
    const obj = src as { kind?: unknown; id?: unknown };
    if (isExternalSourceKind(obj.kind)) {
      return { kind: obj.kind, id: typeof obj.id === "string" && obj.id.length > 0 ? obj.id : (fallbackId ?? "unspecified") };
    }
    return undefined; // source.kind=user/subagent 或未知:内部路径不动
  }
  if (isExternalSourceKind(src)) return { kind: src, id: fallbackId ?? "unspecified" };
  if (isExternalSourceKind(raw.owner)) return { kind: raw.owner, id: fallbackId ?? "unspecified" };
  return undefined;
}

export interface ExternalSubmitInput {
  sessionId: string;
  instruction: string;
  source: EnvelopeSource;
  envelope?: TaskEnvelope;
  deliveryKey?: string;
  declared?: DeclaredSourceFields;
  extra?: Partial<Pick<Task, "targetNode" | "resourceTags" | "credentialRef" | "projectId" | "title" | "attachments">>;
}

export interface EnvelopeGateDeps {
  taskManager: Pick<TaskSupervisor, "list" | "submit">;
  journal: {
    append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown>; idempotencyKey?: string }): unknown;
    readSession?(sessionId: string): readonly { kind?: string; payload?: unknown }[];
  };
  /** 当前能力目录(装配方注入;缺省=currentCapabilitySnapshot)。 */
  capabilitySnapshot?: () => CapabilitySnapshot;
  /** 当前策略(缺省=defaultEnvelopePolicy)。 */
  policy?: () => EnvelopePolicy;
  now?: () => number;
}

export type EnvelopeGateResult =
  | { ok: true; task: Task; envelope?: TaskEnvelope; duplicate: boolean }
  | EnvelopeFailure;

/**
 * 外部来源提交闸:自声明拒 → 客户端信封 verify(漂移即拒,不建任务) →
 * 投递键去重(命中返回原 task,duplicate=true) → 建任务 → 无信封则服务端签发并 journal。
 */
export function gateExternalSubmit(input: ExternalSubmitInput, deps: EnvelopeGateDeps): EnvelopeGateResult {
  const decl = assertSourceDeclaration(input.source, input.declared ?? {});
  if (!decl.ok) return decl;
  if (!isExternalSourceKind(input.source.kind)) {
    return { ok: false, code: "ENVELOPE_INVALID", message: "非外部来源不走信封闸(内部 user 路径零变化)" };
  }
  if (input.envelope !== undefined && !isTaskEnvelope(input.envelope)) {
    return { ok: false, code: "ENVELOPE_INVALID", message: "信封结构非法(缺字段/版本不符)" };
  }
  const current: EnvelopeCurrent = {
    capabilitySnapshot: deps.capabilitySnapshot?.() ?? currentCapabilitySnapshot(),
    policy: deps.policy?.() ?? defaultEnvelopePolicy(),
  };
  if (input.envelope) {
    const verified = verifyEnvelope(input.envelope, current);
    if (!verified.ok) return verified;
  }
  const deliveryKey = input.envelope?.deliveryKey ?? input.deliveryKey;
  const dedupeKey = deliveryKey === undefined ? undefined : `env:${input.source.kind}:${input.source.id}:${deliveryKey}`;
  if (dedupeKey) {
    const existing = deps.taskManager.list().find((t) => t.idempotencyKey === dedupeKey);
    if (existing) {
      let envelope = input.envelope;
      if (!envelope) {
        try {
          const found = findIssuedEnvelope(deps.journal.readSession?.(existing.sessionId), existing.id);
          if (found.kind === "ok") envelope = found.envelope;
        } catch { /* 反查失败=回执不带原信封,duplicate 语义不变 */ }
      }
      return { ok: true, task: existing, duplicate: true, ...(envelope ? { envelope } : {}) };
    }
  }
  const task = deps.taskManager.submit("user", input.sessionId, input.instruction, {
    ...(input.extra ?? {}),
    ...(dedupeKey === undefined ? {} : { idempotencyKey: dedupeKey }),
  });
  let envelope = input.envelope;
  if (!envelope) {
    const issued = issueEnvelope({
      taskId: task.id,
      source: input.source,
      capabilitySnapshot: current.capabilitySnapshot,
      policy: current.policy,
      ...(input.deliveryKey === undefined ? {} : { deliveryKey: input.deliveryKey }),
      ...(deps.now ? { issuedAt: deps.now() } : {}),
    });
    envelope = issued.envelope;
    try {
      deps.journal.append({ kind: "custom", sessionId: input.sessionId, payload: { ...issued.journalPayload } });
    } catch { /* 留痕失败不阻断(task 已建;开工闸读不到信封=零变化路径) */ }
  }
  return { ok: true, task, envelope, duplicate: false };
}
