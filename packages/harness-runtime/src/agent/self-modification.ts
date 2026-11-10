/**
 * RSI #196 自我修改安全门(Self-Modification Gate,纯逻辑零 IO)。
 *
 * 任何自我修改(tool / tip / prompt / skill / code / config)都走同一道门:
 *   证据(evidence) + 影响面(impact) + dry-run + canary + rollback point + owner 六件套;
 *   RSI 生成的改动不可自批(必须 human approver);不可逆改动必须人类审批。
 *
 * 口径(与 M151 审批对象同源):
 * - canonical JSON:键升序递归、数组保序、undefined/函数/符号忽略 —— 与 approval-object.ts 的
 *   canonicalApprovalJson 同一语义(本模块不 import gateway,故内联一份等价实现)。
 * - freezeSelfModification:只冻结「变更面」字段(surface/targetRef/variant/summary/evidence/
 *   impact/dryRun/rollback/irreversible/riskFlags),sha256 全 64 位十六进制;apply 前按同一对象复核。
 * - 结论优先级:结构性/六件套缺失 → deny;仅审批类 → need-approval;全过 → allow。
 *
 * 依赖纪律:只 import node:crypto;不读写文件、不引 agent loop、不引 gateway。
 */

import { createHash } from "node:crypto";

export const SELF_MOD_SCHEMA_VERSION = 1;

/** 自我修改面(tool/tip/prompt/skill/code/config 六类统一门)。 */
export const MODIFICATION_SURFACES = ["tool", "tip", "prompt", "skill", "code", "config"] as const;
export type ModificationSurface = (typeof MODIFICATION_SURFACES)[number];

/** 作者:owner(人类所有者)/agent(代理)/rsi(自我改进循环生成)。 */
export interface ModificationAuthor {
  kind: "owner" | "agent" | "rsi";
  id: string;
}

/** 审批人:human(人类)/owner(所有者代签)/agent(代理审批)。 */
export interface ModificationApprover {
  kind: "human" | "owner" | "agent";
  id: string;
  at?: number;
}

/** 证据:#192 实验账本 / #201 轨迹契约 / #191 证据图谱的 id 引用 + 变更摘要与测试结果。 */
export interface ModificationEvidence {
  experimentId?: string;
  traceBatchKeys?: string[];
  graphNodeIds?: string[];
  hypothesisId?: string;
  diffSummary?: string;
  testsRun?: string;
}

/** 影响面:改动文件 / code-sense 扫描引用 / 波及半径描述。 */
export interface ModificationImpact {
  files?: string[];
  scanRef?: string;
  blastRadius?: string;
}

/** dry-run:先跑命令、ok=true 才继续。 */
export interface ModificationDryRun {
  command: string;
  ok: boolean;
  outputHash?: string;
  at: number;
}

/** canary:小流量范围与规模。 */
export interface ModificationCanary {
  scope: "session" | "project" | "percent";
  size: number;
  plannedAt?: number;
}

/** 回滚点:code 必须 commit|flag,config 必须 config|snapshot。 */
export interface ModificationRollback {
  kind: "commit" | "flag" | "config" | "snapshot";
  ref: string;
}

export type ModificationDecisionKind = "pending" | "allow" | "need-approval" | "deny" | "rolled-back";

export interface ModificationDecision {
  kind: ModificationDecisionKind;
  at?: number;
  codes?: string[];
}

export interface ModificationRequest {
  id: string;
  schemaVersion: number;
  surface: ModificationSurface;
  targetRef: string;
  variant: string;
  summary: string;
  author: ModificationAuthor;
  approver?: ModificationApprover;
  evidence: ModificationEvidence;
  impact: ModificationImpact;
  dryRun: ModificationDryRun;
  canary: ModificationCanary;
  rollback: ModificationRollback;
  ownerName: string;
  irreversible: boolean;
  riskFlags: string[];
  createdAt: number;
  updatedAt: number;
  decision: ModificationDecision;
}

/** 门的稳定码(顺序即输出顺序;只增不改)。 */
export const SELF_MOD_CODES = [
  "MOD_SURFACE_INVALID",
  "MOD_TARGET_MISSING",
  "MOD_SUMMARY_MISSING",
  "MOD_AUTHOR_MISSING",
  "MOD_OWNER_MISSING",
  "MOD_EVIDENCE_MISSING",
  "MOD_IMPACT_MISSING",
  "MOD_DRYRUN_MISSING",
  "MOD_DRYRUN_FAILED",
  "MOD_CANARY_MISSING",
  "MOD_ROLLBACK_MISSING",
  "MOD_SELF_APPROVAL",
  "MOD_RSI_NEEDS_HUMAN",
  "MOD_AGENT_APPROVAL_FORBIDDEN",
  "MOD_IRREVERSIBLE_NEEDS_HUMAN",
  "MOD_RISK_UNREVIEWED",
  "MOD_HASH_MISMATCH",
  "MOD_DECISION_FINAL",
] as const;

export type SelfModCode = (typeof SELF_MOD_CODES)[number];

/** 审批类码:只缺这些 → need-approval;含其它码 → deny。 */
const APPROVAL_CODES: ReadonlySet<string> = new Set<string>([
  "MOD_SELF_APPROVAL",
  "MOD_RSI_NEEDS_HUMAN",
  "MOD_AGENT_APPROVAL_FORBIDDEN",
  "MOD_IRREVERSIBLE_NEEDS_HUMAN",
  "MOD_RISK_UNREVIEWED",
]);

export interface SelfModPolicy {
  /** 是否要求 canary(缺省 true)。 */
  requireCanary?: boolean;
  /** 是否允许 agent 作者在无 approver 时按 owner 代理放行(缺省 true)。 */
  allowAgentSelfApprove?: boolean;
}

export interface SelfModEvaluation {
  decision: "allow" | "need-approval" | "deny";
  codes: SelfModCode[];
  details: string[];
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function orderCodes(codes: string[]): SelfModCode[] {
  const seen = new Set(codes);
  return SELF_MOD_CODES.filter((code) => seen.has(code));
}

/**
 * 评估一次自我修改请求。纯函数:不改入参、不落盘。
 * - deny:结构性字段缺失 / 六件套不齐 / decision 已是终态。
 * - need-approval:结构齐但审批不满足(rsi 缺人类、不可逆、风险未复核、自批)。
 * - allow:全部通过。
 */
export function evaluateSelfModification(req: ModificationRequest, policy: SelfModPolicy = {}): SelfModEvaluation {
  const codes: string[] = [];
  const details: string[] = [];
  const add = (code: SelfModCode, detail: string): void => {
    if (!codes.includes(code)) codes.push(code);
    details.push(`${code}: ${detail}`);
  };
  const surface = String(req?.surface ?? "");
  const surfaceValid = (MODIFICATION_SURFACES as readonly string[]).includes(surface);
  if (!surfaceValid) add("MOD_SURFACE_INVALID", `surface=${surface || "<空>"}`);
  if (!nonEmpty(req?.targetRef)) add("MOD_TARGET_MISSING", "targetRef 为空");
  if (!nonEmpty(req?.summary)) add("MOD_SUMMARY_MISSING", "summary 为空");
  if (!req?.author || !nonEmpty(req.author.id)) add("MOD_AUTHOR_MISSING", "author.id 为空");
  if (!nonEmpty(req?.ownerName)) add("MOD_OWNER_MISSING", "ownerName 为空");

  const decisionKind = String(req?.decision?.kind ?? "pending");
  if (decisionKind !== "pending" && decisionKind !== "rolled-back") {
    add("MOD_DECISION_FINAL", `decision=${decisionKind} 已是终态,不可再评`);
  }

  const needsArtifacts = surface === "code" || surface === "config";
  const evidence = req?.evidence ?? {};
  const hasEvidenceId =
    nonEmpty(evidence.experimentId) ||
    (evidence.traceBatchKeys?.length ?? 0) > 0 ||
    (evidence.graphNodeIds?.length ?? 0) > 0 ||
    nonEmpty(evidence.hypothesisId);
  if (!hasEvidenceId) {
    add("MOD_EVIDENCE_MISSING", "evidence 缺 experimentId/traceBatchKeys/graphNodeIds/hypothesisId 之一");
  } else if (needsArtifacts && !nonEmpty(evidence.diffSummary) && !nonEmpty(evidence.testsRun)) {
    add("MOD_EVIDENCE_MISSING", "code/config 另需 diffSummary 或 testsRun");
  }

  const impact = req?.impact ?? {};
  if (needsArtifacts && (impact.files?.length ?? 0) === 0 && !nonEmpty(impact.scanRef)) {
    add("MOD_IMPACT_MISSING", "code/config 需 impact.files 或 impact.scanRef 非空");
  }

  const dryRun = req?.dryRun;
  if (!dryRun || !nonEmpty(dryRun.command)) {
    add("MOD_DRYRUN_MISSING", "dryRun.command 为空");
  } else if (dryRun.ok !== true) {
    add("MOD_DRYRUN_FAILED", "dryRun.ok !== true");
  }

  const requireCanary = policy.requireCanary !== false;
  if (requireCanary) {
    const canary = req?.canary;
    const scopeOk = canary !== undefined && ["session", "project", "percent"].includes(String(canary.scope));
    const sizeOk = canary !== undefined && Number(canary.size) > 0;
    if (!canary || !scopeOk || !sizeOk) {
      add("MOD_CANARY_MISSING", "canary.scope/size 缺失或 size<=0");
    }
  }

  const rollback = req?.rollback;
  if (!rollback || !nonEmpty(rollback.ref)) {
    add("MOD_ROLLBACK_MISSING", "rollback.ref 为空");
  } else {
    const kind = String(rollback.kind);
    if (surface === "code" && kind !== "commit" && kind !== "flag") {
      add("MOD_ROLLBACK_MISSING", `code 的 rollback.kind=${kind} 必须为 commit|flag`);
    }
    if (surface === "config" && kind !== "config" && kind !== "snapshot") {
      add("MOD_ROLLBACK_MISSING", `config 的 rollback.kind=${kind} 必须为 config|snapshot`);
    }
  }

  const authorKind = String(req?.author?.kind ?? "");
  const authorId = String(req?.author?.id ?? "");
  const approver = req?.approver;
  const hasApprover = approver !== undefined && nonEmpty(approver.id);
  if (!hasApprover) {
    if (authorKind === "rsi") add("MOD_RSI_NEEDS_HUMAN", "rsi 作者必须人类 approver");
    if (req?.irreversible === true) add("MOD_IRREVERSIBLE_NEEDS_HUMAN", "不可逆改动必须人类 approver");
    if ((req?.riskFlags?.length ?? 0) > 0) add("MOD_RISK_UNREVIEWED", "riskFlags 非空必须人类 approver");
    if (authorKind === "agent" && policy.allowAgentSelfApprove === false) {
      add("MOD_RISK_UNREVIEWED", "策略禁止 agent 自批且无 approver");
    }
  } else {
    const approverKind = String(approver.kind);
    if (approver.id === authorId) add("MOD_SELF_APPROVAL", `approver.id === author.id (${authorId})`);
    if (authorKind === "rsi" && approverKind !== "human") {
      add("MOD_AGENT_APPROVAL_FORBIDDEN", `rsi 作者不接受 ${approverKind} 审批`);
      add("MOD_RSI_NEEDS_HUMAN", `rsi 作者必须人类审批(实际 ${approverKind})`);
    }
    if (req?.irreversible === true && approverKind !== "human") {
      add("MOD_IRREVERSIBLE_NEEDS_HUMAN", `不可逆改动需 human 审批(实际 ${approverKind})`);
    }
    if ((req?.riskFlags?.length ?? 0) > 0 && approverKind !== "human") {
      add("MOD_RISK_UNREVIEWED", `riskFlags 需 human 复核(实际 ${approverKind})`);
    }
  }

  const ordered = orderCodes(codes);
  const decision: SelfModEvaluation["decision"] =
    ordered.length === 0 ? "allow" : ordered.some((code) => !APPROVAL_CODES.has(code)) ? "deny" : "need-approval";
  return { decision, codes: ordered, details };
}

/** 参与冻结的变更面字段(顺序仅供阅读;canonical 会按键排序)。 */
export const FROZEN_FIELDS = [
  "surface",
  "targetRef",
  "variant",
  "summary",
  "evidence",
  "impact",
  "dryRun",
  "rollback",
  "irreversible",
  "riskFlags",
] as const;

/** canonical JSON:键升序递归、数组保序、undefined/函数/符号忽略(数组内降级 null)。 */
function canonicalValue(value: unknown, stack: Set<object>): string | undefined {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    return Number.isFinite(n) ? (JSON.stringify(n) as string) : "null";
  }
  if (t === "bigint") throw new TypeError("自我修改对象含 bigint,不可 JSON 化");
  if (t === "string") return JSON.stringify(value) as string;
  const obj = value as object;
  if (stack.has(obj)) throw new TypeError("自我修改对象存在循环引用");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) parts.push(canonicalValue(item, stack) ?? "null");
      return `[${parts.join(",")}]`;
    }
    const toJson = (obj as { toJSON?: unknown }).toJSON;
    if (typeof toJson === "function") return canonicalValue((toJson as () => unknown).call(obj), stack) ?? "null";
    const rec = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(rec).sort()) {
      const v = canonicalValue(rec[key], stack);
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${v}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** canonical JSON 文本(与 M151 canonicalApprovalJson 同口径)。 */
export function canonicalModificationJson(value: unknown): string {
  const out = canonicalValue(value, new Set());
  if (out === undefined) throw new TypeError("自我修改对象根值不可 JSON 化");
  return out;
}

/** 取出参与冻结的字段(缺省字段不收,保持 canonical 忽略 undefined 的语义)。 */
export function frozenModificationValue(req: ModificationRequest): Record<string, unknown> {
  const source = (req ?? {}) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of FROZEN_FIELDS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** 冻结变更面:规范化 JSON 的 sha256(64 hex)。apply 前按同一对象复核。 */
export function freezeSelfModification(req: ModificationRequest): { hash: string; frozen: string } {
  const frozen = canonicalModificationJson(frozenModificationValue(req));
  const hash = createHash("sha256").update(frozen, "utf8").digest("hex");
  return { hash, frozen };
}

export interface SelfModVerifyResult {
  match: boolean;
  hash: string;
  code?: "MOD_HASH_MISMATCH";
}

/** 复核冻结 hash:与现场重算的 hash 相同才 match;不同带 MOD_HASH_MISMATCH。 */
export function verifySelfModification(frozenHash: string, req: ModificationRequest): SelfModVerifyResult {
  const { hash } = freezeSelfModification(req);
  const match = typeof frozenHash === "string" && frozenHash.trim() !== "" && frozenHash === hash;
  return match ? { match: true, hash } : { match: false, hash, code: "MOD_HASH_MISMATCH" };
}

export type ApplyStepName = "freeze" | "dry-run" | "canary" | "apply" | "verify" | "rollback-ready";

export interface ApplyStep {
  step: ApplyStepName;
  reversible: boolean;
  note: string;
}

/** 有序执行计划:freeze → dry-run → canary → apply → verify → rollback-ready。 */
export function applyPlan(req: ModificationRequest): ApplyStep[] {
  const canary = req?.canary;
  return [
    { step: "freeze", reversible: true, note: "冻结变更面 canonical hash,apply 前复核(不符=MOD_HASH_MISMATCH)" },
    { step: "dry-run", reversible: true, note: `dry-run 先行:${req?.dryRun?.command ?? "<未提供>"}` },
    {
      step: "canary",
      reversible: true,
      note: `canary 小流量:${canary ? `${canary.scope}×${canary.size}` : "<未提供>"}`,
    },
    {
      step: "apply",
      reversible: req?.irreversible !== true,
      note: req?.irreversible === true ? "不可逆应用:须人类审批后执行" : "应用变更(rollback point 已就绪)",
    },
    { step: "verify", reversible: true, note: "结果指标达标才全量,不达标走 rollback" },
    {
      step: "rollback-ready",
      reversible: true,
      note: `回滚点就绪:${req?.rollback?.kind ?? "<未提供>"}:${req?.rollback?.ref ?? ""}`,
    },
  ];
}

export interface RollbackAction {
  kind: string;
  ref: string;
  action: string;
  reversible: boolean;
}

/** 编译回滚动作描述(不执行命令,只给可执行文本)。 */
export function compileRollback(req: ModificationRequest): RollbackAction {
  const kind = String(req?.rollback?.kind ?? "flag");
  const ref = String(req?.rollback?.ref ?? "");
  const action =
    kind === "commit"
      ? `git revert --no-edit ${ref}`
      : kind === "flag"
        ? `关闭开关 ${ref}`
        : kind === "config"
          ? `恢复配置快照 ${ref}`
          : `恢复快照 ${ref}`;
  return { kind, ref, action, reversible: req?.irreversible !== true };
}
