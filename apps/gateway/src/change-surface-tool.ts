/**
 * change_surface 工具 + 全链路变更判据(2026-11-06「全链路闭环变更」机制)。
 *
 * 用户口径:「用户只描述意图,harness 自动找出该意图涉及的所有链路节点(UI/入口/协议/服务/
 * 业务逻辑/数据/journal/配置/资产/文档/测试/部署),一次性全部改到一致,并证明没有残留、
 * 没有孤儿、没有只改一半。」
 *
 * 三件事,全部确定性(不调 LLM):
 *  1) 盘点:scan → scanSurface(概念词) 落 journal `custom/change.surface`(含清单摘要与 id 集),
 *     回 markdown checklist(每项 `[ ] category file:line —— 文本`);
 *  2) 审计:audit → 重扫同一批概念,与 agent 提交的 resolutions(resolved/removed/keep-legacy+理由)
 *     对比,落 journal `custom/change.audit`,passed=false 时列出剩余;
 *  3) 判据:surfaceGateVerdict(纯函数,plan-gate 消费)与 closeAuditVerdict(纯函数,收尾回执消费)。
 *
 * 落 journal 而不加协议字段:packages/protocol 不动(与并行任务隔离),事件仍可回放审计。
 */
import type { Tool } from "@lampgenie/runtime/agent/loop";
import {
  SURFACE_CATEGORIES,
  auditSurface,
  buildSurfaceChainMap,
  renderSurfaceChainMarkdown,
  renderSurfaceMarkdown,
  scanSurface,
} from "@lampgenie/code-sense/surface";
import type {
  SurfaceAudit,
  SurfaceReport,
  SurfaceResolution,
} from "@lampgenie/code-sense/surface";
import { classifyChangeScope } from "@lampgenie/code-sense/surface";
import type { ChangeScope } from "@lampgenie/code-sense/surface";
// 语义孤儿检查(2026-11-06 第二批):复用 code_review 的确定性反模式层,六维算法不重写。
import { collectReviewTarget } from "@lampgenie/code-sense/review";
import type { Finding, ReviewTarget } from "@lampgenie/code-sense/review";
import { detectAntipatterns } from "@lampgenie/code-sense/review/antipatterns";

export const CHANGE_SURFACE_TOOL_NAME = "change_surface";

/** journal 面最小接口(测试可注入假 journal,不绑具体实现)。 */
export interface ChangeSurfaceJournal {
  append(e: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }): unknown;
  readAll(): { kind: string; sessionId?: string; payload?: unknown }[];
}

/**
 * journal `custom/change.surface` 里的链路图摘要(2026-11-06 链路图轮):
 * 由 buildSurfaceChainMap 的结果裁到「回执/判据够用」的量级(数组与长字符串都截断),
 * 旧事件没有这个字段——缺省即「无链路图」,不许炸。
 */
export interface ChangeSurfaceChainSummary {
  /**
   * 本次链路图的输入概念(零命中时 nodes 为空,只有靠它才知道扫的是哪个词)。
   * 可选:链路图轮之前的旧事件与降级占位没有该字段,缺省不炸。
   */
  concepts?: string[];
  stats: { layers: number; nodes: number; edges: number; impactNodes: number; withCallChain: boolean };
  /** 分层落点(files 每层最多 20 个)。 */
  layers: { category: string; hits: number; files: string[] }[];
  /** 建议改动顺序(最多 200 条)。 */
  order: string[];
  /** 上下游边(from/to/kind/label 各截 80 字,最多 300 条)。 */
  edges: { from: string; to: string; kind: string; label?: string }[];
  /** 已知局限(最多 10 条;withCallChain=false 时原因在这里)。 */
  knownLimits: string[];
  /** true=链路图生成失败后的降级占位(仍算「有 chain」,但内容为空)。 */
  degraded?: boolean;
  reason?: string;
}

/** journal `custom/change.surface`:一次盘点的摘要(id 集用于 plan-gate 与收尾判据)。 */
export interface ChangeSurfaceManifest {
  taskId: string;
  concepts: string[];
  /** 命中行 id(`<category>:<file>:<line>:<concept>`),去重后全量(id 集是审计的对照面)。 */
  ids: string[];
  hits: number;
  byCategory: Record<string, number>;
  truncated: boolean;
  /** 本次盘点同时生成的概念链路图摘要(旧清单/生成失败降级之外的旧事件 → 省略)。 */
  chain?: ChangeSurfaceChainSummary;
  at: number;
}

// ---- 链路图摘要规整(scan 落 journal 与回读共用同一口径) ----
const CHAIN_LAYERS_MAX = 20;
const CHAIN_FILES_MAX = 20;
const CHAIN_ORDER_MAX = 200;
const CHAIN_EDGES_MAX = 300;
const CHAIN_EDGE_TEXT_MAX = 80;
const CHAIN_LIMITS_MAX = 10;
const CHAIN_CONCEPTS_MAX = 20;
const CHAIN_REASON_MAX = 200;

function chainNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function chainStr(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * 把链路图(内存里的 SurfaceChainMap 或 journal 回读的 payload)规整成摘要。
 * 形状不合法(stats 不是对象)→ null,调用方据此省略该字段(与旧事件一致,不抛)。
 */
export function normalizeChainSummary(input: unknown): ChangeSurfaceChainSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const rawStats = o.stats;
  if (!rawStats || typeof rawStats !== "object" || Array.isArray(rawStats)) return null;
  const s = rawStats as Record<string, unknown>;
  const layers = (Array.isArray(o.layers) ? o.layers : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .slice(0, CHAIN_LAYERS_MAX)
    .map((x) => ({
      category: chainStr(x.category, CHAIN_EDGE_TEXT_MAX),
      hits: chainNum(x.hits),
      files: (Array.isArray(x.files) ? x.files : [])
        .filter((f): f is string => typeof f === "string")
        .slice(0, CHAIN_FILES_MAX),
    }));
  const order = (Array.isArray(o.order) ? o.order : [])
    .filter((x): x is string => typeof x === "string")
    .slice(0, CHAIN_ORDER_MAX);
  const edges = (Array.isArray(o.edges) ? o.edges : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    .map((x) => ({
      from: chainStr(x.from, CHAIN_EDGE_TEXT_MAX),
      to: chainStr(x.to, CHAIN_EDGE_TEXT_MAX),
      kind: chainStr(x.kind, CHAIN_EDGE_TEXT_MAX),
      ...(typeof x.label === "string" ? { label: x.label.slice(0, CHAIN_EDGE_TEXT_MAX) } : {}),
    }))
    .filter((e) => e.from && e.to && e.kind)
    .slice(0, CHAIN_EDGES_MAX);
  const knownLimits = (Array.isArray(o.knownLimits) ? o.knownLimits : [])
    .filter((x): x is string => typeof x === "string")
    .slice(0, CHAIN_LIMITS_MAX);
  const concepts = (Array.isArray(o.concepts) ? o.concepts : [])
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, CHAIN_CONCEPTS_MAX);
  return {
    ...(concepts.length > 0 ? { concepts } : {}),
    stats: {
      layers: chainNum(s.layers),
      nodes: chainNum(s.nodes),
      edges: chainNum(s.edges),
      impactNodes: chainNum(s.impactNodes),
      withCallChain: s.withCallChain === true,
    },
    layers,
    order,
    edges,
    knownLimits,
    ...(o.degraded === true ? { degraded: true } : {}),
    ...(typeof o.reason === "string" ? { reason: o.reason.slice(0, CHAIN_REASON_MAX) } : {}),
  };
}

/** 链路图生成失败时的降级占位(仍算「有 chain」:老判据不会因此当成「没扫描」)。 */
function degradedChainSummary(reason: string): ChangeSurfaceChainSummary {
  return {
    stats: { layers: 0, nodes: 0, edges: 0, impactNodes: 0, withCallChain: false },
    layers: [],
    order: [],
    edges: [],
    knownLimits: [],
    degraded: true,
    reason: reason.slice(0, CHAIN_REASON_MAX),
  };
}

/** audit 里 agent 自报的 E2E 命令结果(2026-11-06 第二批:验收证据入审计)。 */
export interface VerifyE2eItem {
  command: string;
  passed: boolean;
  output?: string;
}

/** audit 里 agent 自报的负面断言结果(如「非法开关值必须被拒」「非 git 目录不抛」)。 */
export interface VerifyNegativeItem {
  assertion: string;
  passed: boolean;
  evidence?: string;
}

/** 规整后的验收证据事实(回执/journal/收尾判据共用)。 */
export interface VerifyFacts {
  /** e2e 非空且全 passed、negatives 非空且全 passed。 */
  verified: boolean;
  e2e: VerifyE2eItem[];
  e2eFailed: number;
  negatives: VerifyNegativeItem[];
  negativesFailed: number;
  /** 规整说明:截断、非法形状被忽略等(回执要如实写明)。 */
  notes: string[];
}

/** 语义孤儿 finding(确定性反模式层,detail 截 200)。 */
export interface OrphanFinding {
  file: string;
  line: number;
  title: string;
  severity: "blocker" | "warning" | "nit";
  detail: string;
}

/** 语义孤儿检查事实(不可用时 available=false + reason,不让 audit 失败)。 */
export interface OrphanFacts {
  available: boolean;
  reason?: string;
  findings: OrphanFinding[];
  warnings: number;
}

/** journal `custom/change.audit`:一次收尾审计的结论(第二批扩验收证据 + 语义孤儿)。 */
export interface ChangeAuditRecord {
  taskId: string;
  passed: boolean;
  total: number;
  resolved: number;
  justified: number;
  unexplained: number;
  invalidJustifications: number;
  /** 验收证据全通过(旧事件缺字段 → false,不许炸)。 */
  verified: boolean;
  verifyE2e: { n: number; failed: number };
  verifyNegatives: { n: number; failed: number };
  /** 未通过的证据总数(E2E failed + 负面断言 failed;单独存一份便于收尾判据直读)。 */
  verifyFailed: number;
  /** 语义孤儿总数 / warning 级数(旧事件/不可用 → 0)。 */
  orphans: number;
  orphanWarnings: number;
  orphanFindings: OrphanFinding[];
  /** 孤儿检查不可用原因(非 git 根/无 diff/异常)。 */
  orphanNote?: string;
  at: number;
}

function payloadType(e: { payload?: unknown }): string | undefined {
  const p = e.payload as { type?: unknown } | undefined;
  return typeof p?.type === "string" ? p.type : undefined;
}

/** 本任务最近一次盘点清单(同任务多次 scan → 取最新;无=null)。 */
export function readChangeSurfaceManifest(
  journal: ChangeSurfaceJournal,
  sessionId: string,
  taskId: string,
): ChangeSurfaceManifest | null {
  const evs = journal.readAll().filter(
    (e) => e.kind === "custom" && e.sessionId === sessionId && payloadType(e) === "change.surface",
  );
  const p = evs.length ? (evs[evs.length - 1]!.payload as ChangeSurfaceManifest & { type?: string }) : null;
  if (!p || p.taskId !== taskId) return null;
  const chain = normalizeChainSummary((p as { chain?: unknown }).chain);
  return {
    taskId: p.taskId,
    concepts: Array.isArray(p.concepts) ? p.concepts : [],
    ids: Array.isArray(p.ids) ? p.ids : [],
    hits: typeof p.hits === "number" ? p.hits : 0,
    byCategory: p.byCategory ?? {},
    truncated: p.truncated === true,
    // 旧事件(链路图轮之前落的)没有 chain:省略该字段,与既有回读逐字一致。
    ...(chain ? { chain } : {}),
    at: typeof p.at === "number" ? p.at : 0,
  };
}

/** 本任务最近一次审计结论(同任务多次 audit → 取最新;无=null)。 */
export function readChangeAudit(
  journal: ChangeSurfaceJournal,
  sessionId: string,
  taskId: string,
): ChangeAuditRecord | null {
  const evs = journal.readAll().filter(
    (e) => e.kind === "custom" && e.sessionId === sessionId && payloadType(e) === "change.audit",
  );
  const p = evs.length ? (evs[evs.length - 1]!.payload as ChangeAuditRecord & { type?: string }) : null;
  if (!p || p.taskId !== taskId) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const e2e = (p.verifyE2e ?? {}) as { n?: unknown; failed?: unknown };
  const neg = (p.verifyNegatives ?? {}) as { n?: unknown; failed?: unknown };
  return {
    taskId: p.taskId,
    passed: p.passed === true,
    total: num(p.total),
    resolved: num(p.resolved),
    justified: num(p.justified),
    unexplained: num(p.unexplained),
    invalidJustifications: num(p.invalidJustifications),
    // 旧事件(第二批之前落的)缺这些字段:一律按 false/0/[] 回读,不许炸。
    verified: p.verified === true,
    verifyE2e: { n: num(e2e.n), failed: num(e2e.failed) },
    verifyNegatives: { n: num(neg.n), failed: num(neg.failed) },
    verifyFailed: num(p.verifyFailed),
    orphans: num(p.orphans),
    orphanWarnings: num(p.orphanWarnings),
    orphanFindings: Array.isArray(p.orphanFindings) ? p.orphanFindings : [],
    ...(typeof p.orphanNote === "string" ? { orphanNote: p.orphanNote } : {}),
    at: num(p.at),
  };
}

/** 本任务是否已显式豁免全链路盘点(change_surface action=exempt,理由 ≥8 字)。 */
export function readChangeExempt(
  journal: ChangeSurfaceJournal,
  sessionId: string,
  taskId: string,
): string | null {
  const evs = journal.readAll().filter(
    (e) => e.kind === "custom" && e.sessionId === sessionId && payloadType(e) === "change.exempt",
  );
  const p = evs.length ? (evs[evs.length - 1]!.payload as { taskId?: string; reason?: string }) : null;
  if (!p || p.taskId !== taskId) return null;
  return typeof p.reason === "string" ? p.reason : "";
}

/** 概念词规整:支持 `a,b` / `a b` / 数组;去空去重(保持入参顺序=清单稳定)。 */
export function parseConcepts(input: unknown): string[] {
  const raw: string[] = [];
  if (Array.isArray(input)) {
    for (const x of input) if (typeof x === "string") raw.push(x);
  } else if (typeof input === "string") {
    raw.push(...input.split(/[,\s]+/));
  }
  const out: string[] = [];
  for (const c of raw) {
    const t = c.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ---- 判据(纯函数:plan-gate / 收尾回执 / 单测共用) ----

export interface SurfaceGateInput {
  taskClass: string;
  instruction: string;
  /** 本任务是否已有 change.surface 清单(journal 事实,不是提示词自述)。 */
  hasManifest: boolean;
  /**
   * 本任务清单是否带链路图(2026-11-06 链路图轮)。
   * 缺省(undefined)= 调用方不看这一维,按旧尺度放行;显式 false = 旧清单/手造清单。
   */
  hasChain?: boolean;
  /** 本任务是否已显式豁免(board_upsert exemptReason 或 change_surface action=exempt)。 */
  exempt: boolean;
  /** 是否已走直达实施路由(task_phase route=direct)——与既有「明确小改免板」同一尺度豁免语义。 */
  directRoute?: boolean;
}

export interface SurfaceGateVerdict {
  scope: ChangeScope;
  matched: string[];
  /** true=本任务是全链路变更类,必须先把盘点落到 journal。 */
  needsManifest: boolean;
  /** true=拦写操作。 */
  deny: boolean;
  reason?: string;
  hint?: string;
}

/**
 * 全链路硬门判据。
 * 只有「coding + 替换/迁移动词 + 尚无清单 + 未豁免」才拒;
 * normal / qa / office / 已有清单 / 已豁免 一律放行(不误伤旧流程)。
 */
export function surfaceGateVerdict(i: SurfaceGateInput): SurfaceGateVerdict {
  const v = classifyChangeScope(i.instruction ?? "");
  const base = { scope: v.scope, matched: v.matched, needsManifest: v.scope === "surface" };
  if (i.taskClass !== "coding") return { ...base, deny: false };
  if (v.scope !== "surface") return { ...base, deny: false };
  // 直达实施路由(2026-11-06):agent 已在理解阶段判定「明确具体小改」并声明 route=direct——
  // 与既有 plan-gate 的 direct 尺度豁免同一语义,不因词表命中就把它升级成全链路任务;
  // 收尾审计仍按 instruction 判 surface,漏盘点会在终稿处被标「未通过全链路审计」。
  if (i.directRoute) return { ...base, deny: false };
  if (i.exempt) return { ...base, deny: false };
  if (!i.hasManifest) {
    return {
      ...base,
      deny: true,
      reason: "no-change-surface",
      hint:
        "本任务是全链路变更类(指令含替换/迁移/改名词),还没有变更面盘点——"
        + `先 change_surface(action=\"scan\", concept=\"<被替换的概念/符号名>\"),逐条给出该概念的 ${SURFACE_CATEGORIES.length} 类落点去向,再一次改完;`
        + "确无链路影响时用 board_upsert(exemptReason=...) 或 change_surface(action=\"exempt\", reason=...) 显式豁免(落 journal,不许静默)。",
    };
  }
  // 有清单但没链路图(链路图轮之前的旧清单/手造清单):让 agent 重新 scan 一次即可补上。
  if (i.hasChain === false) {
    return {
      ...base,
      deny: true,
      reason: "no-chain-map",
      hint:
        "本任务有变更面清单但没有链路图(旧清单或手造清单)——重新 change_surface(action=\"scan\", concept=\"<同一概念>\") "
        + "即可补生成链路图(纯只读扫描,不改代码、不需重写清单);确无链路影响仍可用 change_surface(action=\"exempt\", reason=...) 豁免。",
    };
  }
  return { ...base, deny: false };
}

export interface CloseAuditVerdict {
  /** true=收尾回执要挂警告。 */
  warn: boolean;
  /** 验收摘要里的标记(空串=不加)。 */
  mark: string;
  text: string;
  /** true=hard 模式下审计事实不满足(调用方据此拒绝静默 done)。 */
  hardFail?: boolean;
}

/**
 * 收尾审计判据(surface 任务在最终 answer 前应有 passed 的 change.audit)。
 * warn(缺省):回执警告 + 验收摘要标记,不硬杀(行为与第一批逐字一致);
 * hard:额外要求 verify 证据全通过、无 warning 级语义孤儿,不满足 → hardFail=true(调用方判 failed)。
 * off:调用方根本不调本函数。
 */
export function closeAuditVerdict(input: {
  taskClass: string;
  instruction: string;
  manifest: ChangeSurfaceManifest | null;
  audit: ChangeAuditRecord | null;
  /** 直达实施路由(明确小改):收尾也不按全链路任务标记。 */
  directRoute?: boolean;
  /** true=hard 模式(agent.changeAudit=hard / env GENIE_CHANGE_AUDIT=hard)。 */
  hard?: boolean;
}): CloseAuditVerdict {
  const v = classifyChangeScope(input.instruction ?? "");
  const hard = input.hard === true;
  const fail = (warn: boolean, mark: string, text: string): CloseAuditVerdict =>
    hard ? { warn, mark, text, hardFail: true } : { warn, mark, text };
  if (input.taskClass !== "coding" || v.scope !== "surface") return { warn: false, mark: "", text: "" };
  if (input.directRoute) return { warn: false, mark: "", text: "" };
  if (!input.manifest) {
    return fail(
      true,
      "未通过全链路审计(无变更面盘点)",
      "[全链路审计] 本任务是全链路变更类,但没有 change.surface 盘点记录——先 change_surface(action=\"scan\")。",
    );
  }
  // 链路图轮(2026-11-06):hard 额外要求清单带链路图(旧清单 → 重新 scan 一次即可)。
  if (hard && !input.manifest.chain) {
    return fail(
      true,
      "未通过全链路审计(缺链路图)",
      "[全链路审计] 本任务的变更面清单没有链路图(旧清单)——重新 change_surface(action=\"scan\") 生成链路图后再 audit;warn 模式不受影响。",
    );
  }
  if (!input.audit) {
    return fail(
      true,
      "未通过全链路审计(未跑 change.audit)",
      `[全链路审计] 盘点 ${input.manifest.hits} 项,但汇报前没有 change_surface(action=\"audit\")——逐条给出去向再审计。`,
    );
  }
  if (!input.audit.passed) {
    return fail(
      true,
      `未通过全链路审计(${input.audit.unexplained} 项未处理)`,
      `[全链路审计] 上次审计未通过:${input.audit.unexplained} 项未处理、${input.audit.invalidJustifications} 项 keep-legacy 缺理由——补完再 audit。`,
    );
  }
  // 验收证据(第二批):hard 才强制;warn 只在摘要标「未提供验收证据」。
  const evN = input.audit.verifyE2e.n + input.audit.verifyNegatives.n;
  const evFailed = input.audit.verifyE2e.failed + input.audit.verifyNegatives.failed;
  if (evFailed > 0) {
    return fail(
      true,
      `未通过全链路审计(验收证据 ${evFailed} 条未通过)`,
      `[全链路审计] 验收证据有 ${evFailed} 条未通过(E2E ${input.audit.verifyE2e.failed}/${input.audit.verifyE2e.n}、负面断言 ${input.audit.verifyNegatives.failed}/${input.audit.verifyNegatives.n})——修到全绿再 audit。`,
    );
  }
  if (!input.audit.verified) {
    // 未提供证据:hard 缺证据不放行;warn 只在标记里说明(既有 warn 行为不变,标记为空)。
    if (hard) {
      return fail(
        true,
        "未通过全链路审计(缺验收证据)",
        `[全链路审计] 审计通过了去向,但没有 E2E/负面断言证据(verify 缺省或未全通过)——hard 模式不放行;补 change_surface(action="audit", verify={e2e,negatives})。`,
      );
    }
    return { warn: false, mark: "", text: "" };
  }
  // 语义孤儿(第二批):warning 级阻断 hard;nit 列出但不阻断。
  if (input.audit.orphanWarnings > 0) {
    const titles = input.audit.orphanFindings
      .filter((f) => f.severity !== "nit")
      .slice(0, 5)
      .map((f) => `${f.file}:${f.line} ${f.title}`)
      .join(";");
    return fail(
      true,
      `未通过全链路审计(${input.audit.orphanWarnings} 条 warning 级孤儿)`,
      `[全链路审计] 语义孤儿检查发现 ${input.audit.orphanWarnings} 条 warning 级问题(共 ${input.audit.orphans} 条):${titles}——接线或删除后重新 audit。`,
    );
  }
  return { warn: false, mark: "", text: "" };
}
// ---- 工具 ----
export interface ChangeSurfaceToolDeps {
  journal: ChangeSurfaceJournal;
  sessionId: string;
  taskId: string;
  /** 扫描根(仓根或 taskRoot;与 board_upsert 同根口径)。 */
  root: string;
}

// ---- 验收证据规整(第二批 B3) ----
const VERIFY_E2E_MAX = 10;
const VERIFY_NEG_MAX = 20;
const VERIFY_TEXT_MAX = 160;

/**
 * verify 入参规整(确定性,不猜):
 * - 只认对象数组;command/assertion 必填非空字符串,passed 必须布尔,否则该条忽略并说明;
 * - e2e 最多 10 条、negatives 最多 20 条,超限截断并说明;
 * - verified = e2e 非空且全 passed 且 negatives 非空且全 passed;缺省 verified=false。
 */
export function normalizeVerify(input: unknown): VerifyFacts {
  const notes: string[] = [];
  const facts: VerifyFacts = { verified: false, e2e: [], e2eFailed: 0, negatives: [], negativesFailed: 0, notes };
  if (input === undefined || input === null) {
    notes.push("未提供 verify(e2e/负面断言),收尾硬门不放行");
    return facts;
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    notes.push("verify 必须是对象 {e2e?, negatives?},已忽略");
    return facts;
  }
  const o = input as { e2e?: unknown; negatives?: unknown };
  const shape = (v: unknown, name: string): unknown[] | null => {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) { notes.push(`${name} 必须是对象数组,已忽略`); return null; }
    return v;
  };
  const e2eRaw = shape(o.e2e, "verify.e2e");
  const negRaw = shape(o.negatives, "verify.negatives");
  if (e2eRaw) {
    let dropped = 0;
    for (const item of e2eRaw) {
      const it = (item ?? {}) as { command?: unknown; passed?: unknown; output?: unknown };
      if (typeof it.command !== "string" || !it.command.trim() || typeof it.passed !== "boolean") { dropped++; continue; }
      if (facts.e2e.length >= VERIFY_E2E_MAX) continue;
      facts.e2e.push({
        command: it.command.trim(),
        passed: it.passed,
        ...(typeof it.output === "string" ? { output: it.output.trim().slice(0, VERIFY_TEXT_MAX) } : {}),
      });
    }
    if (dropped) notes.push(`e2e 有 ${dropped} 条形状非法(command/passed 缺失)已忽略`);
    if (e2eRaw.length > VERIFY_E2E_MAX) notes.push(`e2e 超过 ${VERIFY_E2E_MAX} 条,已截断`);
  }
  if (negRaw) {
    let dropped = 0;
    for (const item of negRaw) {
      const it = (item ?? {}) as { assertion?: unknown; passed?: unknown; evidence?: unknown };
      if (typeof it.assertion !== "string" || !it.assertion.trim() || typeof it.passed !== "boolean") { dropped++; continue; }
      if (facts.negatives.length >= VERIFY_NEG_MAX) continue;
      facts.negatives.push({
        assertion: it.assertion.trim(),
        passed: it.passed,
        ...(typeof it.evidence === "string" ? { evidence: it.evidence.trim().slice(0, VERIFY_TEXT_MAX) } : {}),
      });
    }
    if (dropped) notes.push(`negatives 有 ${dropped} 条形状非法(assertion/passed 缺失)已忽略`);
    if (negRaw.length > VERIFY_NEG_MAX) notes.push(`negatives 超过 ${VERIFY_NEG_MAX} 条,已截断`);
  }
  facts.e2eFailed = facts.e2e.filter((x) => !x.passed).length;
  facts.negativesFailed = facts.negatives.filter((x) => !x.passed).length;
  facts.verified = facts.e2e.length > 0 && facts.e2eFailed === 0 && facts.negatives.length > 0 && facts.negativesFailed === 0;
  if (!facts.verified && facts.e2e.length === 0) notes.push("未提供 E2E 命令,收尾硬门不放行");
  if (!facts.verified && facts.negatives.length === 0) notes.push("未提供负面断言,收尾硬门不放行");
  return facts;
}

// ---- 语义孤儿检查(第二批 B4):复用 code_review 确定性反模式层 ----
const ORPHAN_MAX = 20;

function posix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

/** resolutions 文件与 diff 文件是否同一文件(路径归一 + 允许 stem 匹配)。 */
function sameFile(diffPath: string, want: string): boolean {
  const a = posix(diffPath);
  const b = posix(want);
  if (!a || !b) return false;
  if (a === b || a.endsWith("/" + b) || b.endsWith("/" + a)) return true;
  const stem = (p: string): string => {
    const base = p.split("/").pop() ?? p;
    return base.replace(/\.[a-z0-9]+$/i, "");
  };
  return stem(a) === stem(b) && (a.includes("/") || b.includes("/"));
}

/**
 * 对 resolutions 涉及的文件跑确定性孤儿检查。
 * 复用 collectReviewTarget(本仓未提交 diff,含未跟踪文件)+ detectAntipatterns(六维不重写);
 * 非 git 根/无 diff/异常 → available=false + reason(审计不失败,回执写「不可用」)。
 */
export async function collectOrphanFacts(root: string, resolutions: SurfaceResolution[]): Promise<OrphanFacts> {
  const want = [...new Set(resolutions.map((r) => r.file).filter((f) => typeof f === "string" && f.trim()))];
  if (want.length === 0) {
    return { available: false, reason: "本次审计没有 resolutions 文件,无孤儿检查面", findings: [], warnings: 0 };
  }
  let target: ReviewTarget;
  try {
    target = await collectReviewTarget(root);
  } catch (e: unknown) {
    return {
      available: false,
      reason: `无法收集变更集(${String(e instanceof Error ? e.message : e).slice(0, 120)})——非 git 根或无 diff`,
      findings: [],
      warnings: 0,
    };
  }
  const files = target.files.filter((f) => want.some((w) => sameFile(f.path, w)));
  if (files.length === 0) {
    return {
      available: false,
      reason: `变更集里没有 resolutions 涉及的文件(${want.length} 个目标文件都不在 diff 中)`,
      findings: [],
      warnings: 0,
    };
  }
  let raw: Finding[];
  try {
    raw = await detectAntipatterns(root, { ...target, files });
  } catch (e: unknown) {
    return {
      available: false,
      reason: `反模式检测异常(${String(e instanceof Error ? e.message : e).slice(0, 120)})`,
      findings: [],
      warnings: 0,
    };
  }
  const findings: OrphanFinding[] = raw.slice(0, ORPHAN_MAX).map((f) => ({
    file: String(f.file ?? ""),
    line: typeof f.line === "number" ? f.line : 0,
    title: String(f.title ?? "").slice(0, 160),
    severity: f.severity === "blocker" || f.severity === "warning" ? f.severity : "nit",
    detail: String(f.detail ?? "").slice(0, 200),
  }));
  const warnings = findings.filter((f) => f.severity !== "nit").length;
  return { available: true, findings, warnings };
}

function summarizeVerify(v: VerifyFacts): string[] {
  const lines: string[] = ["验收证据:"];
  if (v.e2e.length === 0 && v.negatives.length === 0) {
    lines.push("- 未提供 E2E/负面断言,收尾硬门不放行");
  } else {
    for (const x of v.e2e.slice(0, 10)) lines.push(`- E2E「${x.command.slice(0, VERIFY_TEXT_MAX)}」→ ${x.passed ? "通过" : "失败"}${x.output ? `(${x.output.slice(0, 80)})` : ""}`);
    for (const x of v.negatives.slice(0, 10)) lines.push(`- 负面断言「${x.assertion.slice(0, VERIFY_TEXT_MAX)}」→ ${x.passed ? "通过" : "失败"}${x.evidence ? `(${x.evidence.slice(0, 80)})` : ""}`);
    lines.push(`- 结论:${v.verified ? "证据全通过(verified)" : `未全通过(E2E ${v.e2eFailed} 失败 / 负面 ${v.negativesFailed} 失败)`}`);
  }
  for (const n of v.notes) lines.push(`- 规整说明:${n}`);
  return lines;
}

function summarizeOrphans(o: OrphanFacts): string[] {
  const lines: string[] = ["语义孤儿:"];
  if (!o.available) {
    lines.push(`- 语义孤儿检查不可用(${o.reason ?? "未知原因"})`);
    return lines;
  }
  if (o.findings.length === 0) {
    lines.push("- 未发现孤儿/反模式问题");
    return lines;
  }
  lines.push(`- 共 ${o.findings.length} 条(blocker/warning ${o.warnings} 条,其余 nit 不阻断)${o.findings.length >= ORPHAN_MAX ? `,已截断到 ${ORPHAN_MAX} 条` : ""}`);
  for (const f of o.findings) lines.push(`- [${f.severity}] ${f.file}:${f.line} ${f.title} — ${f.detail}`);
  return lines;
}

function summarizeAudit(a: SurfaceAudit, verify?: VerifyFacts, orphans?: OrphanFacts): string {
  const head = a.passed
    ? `[全链路审计] 通过:${a.total} 项全部有去向(已改 ${a.resolved} / 保留旧实现 ${a.justified})`
    : `[全链路审计] 未通过:${a.unexplained.length} 项未处理` + (a.invalidJustifications.length ? `,${a.invalidJustifications.length} 项 keep-legacy 缺理由` : "");
  const lines = [head];
  if (a.unexplained.length) {
    lines.push("剩余(未处理,逐条改完或标 keep-legacy+理由):");
    for (const u of a.unexplained.slice(0, 60)) lines.push(`- [ ] ${u.category} ${u.file}:${u.line} — ${u.text.trim().slice(0, 110)}`);
    if (a.unexplained.length > 60) lines.push(`…还有 ${a.unexplained.length - 60} 项(见 journal change.audit)`);
  }
  if (a.invalidJustifications.length) {
    lines.push("keep-legacy 缺理由(补 ≥4 字理由才算 justified):");
    for (const u of a.invalidJustifications.slice(0, 20)) lines.push(`- ${u.file}${u.line ? ":" + u.line : ""} — ${u.why}`);
  }
  return lines.join("\n");
}

/** status 回执的链路图口径:无 chain / 有 chain 但调用链不可用 / 调用链可用。 */
function chainStatusLine(m: ChangeSurfaceManifest): string {
  const c = m.chain;
  if (!c) return "链路图:无(重新 action=\"scan\" 生成)";
  const calls = c.stats.withCallChain ? "有" : `无(${c.knownLimits[0] ?? "索引不可用"})`;
  return `链路图:层 ${c.stats.layers} / 节点 ${c.stats.nodes} / 边 ${c.stats.edges} / 调用链 ${calls}`;
}

export function makeChangeSurfaceTool(deps: ChangeSurfaceToolDeps): Tool {
  return {
    name: CHANGE_SURFACE_TOOL_NAME,
    description:
      "全链路变更面(概念足迹)工具——替换/迁移/下线/重命名一个概念(消息名、journal kind、配置键、面板文案、资源名、测试断言、文档章节)时用它盘点与收尾审计,不靠人肉 grep。"
      + `action=scan:按概念词扫描全仓 ${SURFACE_CATEGORIES.length} 类表面(${SURFACE_CATEGORIES.join("/")}),并生成分层/边/建议顺序的链路图,输出 markdown checklist 并落 journal;`
      + "scan 会生成概念链路图(分层+上下游边+建议改动顺序,索引可用时含调用链);audit 可带 verify 与 hard 硬门语义;"
      + "action=audit:重扫 + 对比你提交的 resolutions(resolved/removed/keep-legacy+reason),passed=false 时列出剩余项;可带 verify={e2e:[{command,passed,output?}],negatives:[{assertion,passed,evidence?}]} 交验收证据,并对 resolutions 涉及文件跑确定性语义孤儿检查;"
      + "action=status:看本任务当前盘点与上次审计结论;action=exempt:确无链路影响时显式豁免(理由必填)。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["scan", "audit", "status", "exempt"], description: "scan=盘点 / audit=收尾审计 / status=看现状 / exempt=显式豁免(理由必填)" },
        concept: { type: "string", description: "被替换/迁移的概念词或符号名(多个用逗号分隔;scan/audit 必填,audit 缺省沿用上次 scan 的概念)" },
        resolutions: {
          type: "array",
          description: "audit 用:逐条去向。status=resolved(已改)/removed(已删)/keep-legacy(保留旧实现,必须带 reason ≥4 字)",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              line: { type: "number" },
              status: { type: "string", enum: ["resolved", "removed", "keep-legacy"] },
              reason: { type: "string" },
            },
            required: ["file", "status"],
          },
        },
        reason: { type: "string", description: "exempt 用:为什么本任务虽含替换/迁移动词却没有全链路影响(≥8 字,落 journal)" },
        verify: {
          type: "object",
          description: "audit 用:验收证据。e2e=[{command,passed,output?}](最多 10 条);negatives=[{assertion,passed,evidence?}](最多 20 条)。全部通过才 verified,收尾硬门(hard)据此放行",
          properties: {
            e2e: {
              type: "array",
              items: {
                type: "object",
                properties: { command: { type: "string" }, passed: { type: "boolean" }, output: { type: "string" } },
                required: ["command", "passed"],
              },
            },
            negatives: {
              type: "array",
              items: {
                type: "object",
                properties: { assertion: { type: "string" }, passed: { type: "boolean" }, evidence: { type: "string" } },
                required: ["assertion", "passed"],
              },
            },
          },
        },
        root: { type: "string", description: "扫描根(缺省=任务根)" },
      },
      required: ["action"],
    },
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const a = (args ?? {}) as { action?: unknown; concept?: unknown; resolutions?: unknown; reason?: unknown; root?: unknown };
      const action = typeof a.action === "string" ? a.action : "";
      const root = typeof a.root === "string" && a.root.trim() ? a.root.trim() : deps.root;
      if (action === "status") {
        const m = readChangeSurfaceManifest(deps.journal, deps.sessionId, deps.taskId);
        const au = readChangeAudit(deps.journal, deps.sessionId, deps.taskId);
        if (!m) return "本任务还没有 change.surface 盘点记录。";
        return [
          `盘点:概念 ${m.concepts.join(", ")} / 命中 ${m.hits} 行`,
          `分类: ${SURFACE_CATEGORIES.map((c) => `${c} ${m.byCategory[c] ?? 0}`).join(" / ")}`,
          au ? `上次审计:${au.passed ? "通过" : `未通过(未处理 ${au.unexplained})`}` : "上次审计:无",
          chainStatusLine(m),
        ].join("\n");
      }
      if (action === "exempt") {
        const reason = typeof a.reason === "string" ? a.reason.trim() : "";
        if (reason.length < 8) return "exempt 需要 reason(≥8 字):说明为什么本任务虽含替换/迁移动词却没有全链路影响。";
        try {
          deps.journal.append({ kind: "custom", sessionId: deps.sessionId, payload: { type: "change.exempt", taskId: deps.taskId, reason, at: Date.now() } });
        } catch { /* 留痕失败不影响回执 */ }
        return `已豁免全链路盘点(理由:${reason}),plan-gate 据此放行;回放可在 journal 查 change.exempt。`;
      }
      const concepts = parseConcepts(a.concept);
      const prior = readChangeSurfaceManifest(deps.journal, deps.sessionId, deps.taskId);
      const effConcepts = concepts.length ? concepts : (prior?.concepts ?? []);
      if (effConcepts.length === 0) return "需要 concept(被替换/迁移的概念词或符号名,多个用逗号分隔;如 SuperAgent,dh-video)。";

      let report: SurfaceReport;
      try {
        report = await scanSurface(root, effConcepts);
      } catch (e: unknown) {
        return `change_surface 扫描失败:${String(e instanceof Error ? e.message : e).slice(0, 300)}`;
      }

      if (action === "scan") {
        const ids = [...new Set(report.hits.map((h) => h.id))];
        // 链路图(2026-11-06 链路图轮):清单 + 分层/边/建议顺序;失败不阻断盘点。
        let chain: ChangeSurfaceChainSummary;
        let chainError = "";
        let chainMarkdown = "";
        try {
          const map = await buildSurfaceChainMap(root, report);
          chain = normalizeChainSummary(map) ?? degradedChainSummary("链路图摘要形状非法(无可回读的 stats)");
          if (chain.degraded) chainError = chain.reason ?? "链路图摘要形状非法";
          else chainMarkdown = renderSurfaceChainMarkdown(map);
        } catch (e: unknown) {
          chainError = String(e instanceof Error ? e.message : e).slice(0, CHAIN_REASON_MAX);
          chain = degradedChainSummary(chainError || "链路图生成异常(无错误信息)");
        }
        try {
          deps.journal.append({
            kind: "custom",
            sessionId: deps.sessionId,
            payload: {
              type: "change.surface",
              taskId: deps.taskId,
              concepts: report.concepts,
              ids,
              hits: report.hits.length,
              byCategory: report.byCategory,
              truncated: report.truncated,
              chain,
              ...(chainError ? { chainError } : {}),
              at: Date.now(),
            },
          });
        } catch { /* 留痕失败不阻断盘点输出 */ }
        if (chainError) {
          return `${renderSurfaceMarkdown(report)}\n\n链路图生成失败(${chainError.slice(0, 160)})(不影响清单;可重试 action="scan")`;
        }
        return `${renderSurfaceMarkdown(report)}\n\n${chainMarkdown}`;
      }
      if (action === "audit") {
        const raw = Array.isArray(a.resolutions) ? a.resolutions : [];
        const resolutions: SurfaceResolution[] = [];
        for (const r of raw) {
          const o = (r ?? {}) as { file?: unknown; line?: unknown; status?: unknown; reason?: unknown };
          if (typeof o.file !== "string" || !o.file) continue;
          const status = o.status === "removed" || o.status === "keep-legacy" || o.status === "resolved" ? o.status : "resolved";
          resolutions.push({
            file: o.file,
            ...(typeof o.line === "number" ? { line: o.line } : {}),
            status,
            ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
          });
        }
        const audit = auditSurface(report, resolutions);
        // 验收证据 + 语义孤儿(第二批):两者都是「审计事实」,决定 hard 模式放不放行。
        const verify = normalizeVerify((a as { verify?: unknown }).verify);
        const orphans = await collectOrphanFacts(root, resolutions);
        try {
          deps.journal.append({
            kind: "custom",
            sessionId: deps.sessionId,
            payload: {
              type: "change.audit",
              taskId: deps.taskId,
              concepts: report.concepts,
              passed: audit.passed,
              total: audit.total,
              resolved: audit.resolved,
              justified: audit.justified,
              unexplained: audit.unexplained.length,
              invalidJustifications: audit.invalidJustifications.length,
              // 验收证据:计数 + 摘要(每条 160 字,各最多 10 条)。
              verified: verify.verified,
              verifyE2e: { n: verify.e2e.length, failed: verify.e2eFailed },
              verifyNegatives: { n: verify.negatives.length, failed: verify.negativesFailed },
              verifyFailed: verify.e2eFailed + verify.negativesFailed,
              verifyE2eItems: verify.e2e.slice(0, 10).map((x) => ({ command: x.command.slice(0, VERIFY_TEXT_MAX), passed: x.passed })),
              verifyNegativeItems: verify.negatives.slice(0, 10).map((x) => ({ assertion: x.assertion.slice(0, VERIFY_TEXT_MAX), passed: x.passed })),
              verifyNotes: verify.notes,
              // 语义孤儿:总数 / warning 级数 / 截断 findings / 不可用原因。
              orphans: orphans.available ? orphans.findings.length : 0,
              orphanWarnings: orphans.warnings,
              orphanFindings: orphans.findings,
              ...(orphans.available ? {} : { orphanNote: orphans.reason ?? "不可用" }),
              at: Date.now(),
            },
          });
        } catch { /* 留痕失败不阻断结论 */ }
        const receipt = [summarizeAudit(audit), ...summarizeVerify(verify), ...summarizeOrphans(orphans)].join("\n");
        // 有链路图就在末尾点明(它是 scan 时的产物,audit 不重算)。
        const c = prior?.chain;
        return c
          ? `${receipt}\n链路图:层 ${c.stats.layers} / 节点 ${c.stats.nodes} / 边 ${c.stats.edges}(scan 时生成)`
          : receipt;
      }
      return `未知 action: ${action}(可选 scan/audit/status/exempt)`;
    },
  };
}
