/**
 * 方向总览(RSI #194)持久层:把 direction-atlas 的纯逻辑落到两份盘上事实。
 * 为什么两块盘:
 * ① `<root>/.genie/rsi/atlas/entries.jsonl` append-only —— 「方向为什么转」是审计事实,
 *    目标/变更/冲突/裁决/决策/缺陷基因逐条追加,永不改写历史行;投影(project)在内存里重放。
 * ② `<root>/.genie/rsi/atlas/<projectId>.json` —— build 出来的快照,给 --show/--render/--report 读;
 *    只用「写 tmp + rename」落盘,并发读者不会读到半截 JSON(同 board-store.ts:1166-1168)。
 * 一次 resolveConflict 失败(冲突不存在 / chosen 不属于该冲突)时**绝不写盘**:既不追加 entries,
 * 也不碰 atlas 快照 —— 失败路径字节不变化。
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不读 cwd;
 * root 一律由调用方传入。除参数错误外不 throw:一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AtlasInput,
  Conflict,
  DefectGene,
  DirectionAtlas,
  DirectionChange,
  Goal,
  KeyDecision,
} from "@lampgenie/runtime/agent/direction-atlas";

/** runtime direction-atlas 在本文件用到的模块面。 */
interface DirectionAtlasRuntime {
  readonly DIRECTION_ATLAS_VERSION: number;
  readonly ATLAS_CODES: Record<string, string>;
  buildAtlas(
    input: AtlasInput,
    opts?: { now?: string; driftWindowDays?: number },
  ): { atlas: DirectionAtlas; codes: string[] };
  emptyAtlas(projectId: string, now?: string): DirectionAtlas;
  resolveConflict(
    atlas: DirectionAtlas,
    conflictId: string,
    opts: { chosenGoalId: string; reason: string; by: string; at: string },
  ): { atlas: DirectionAtlas; codes: string[] };
  timelineSince(atlas: DirectionAtlas, opts?: { from?: string; to?: string }): DirectionChange[];
  topDefectClasses(atlas: DirectionAtlas, opts?: { limit?: number }): Array<{ class: string; count: number }>;
  renderAtlasMarkdown(atlas: DirectionAtlas): string;
  renderAtlasJson(atlas: DirectionAtlas): string;
}

/**
 * runtime 面:静态导入(修)。
 * 旧实现是「两跳动态 import + 顶层 await」——顶层 await 在被 spawn 的 session-worker 模块图里
 * 退化成运行时解析,解析不到时 promise 永不 settle,worker 永不 ready( plan-gate
 * e2e 10/15 挂死注意;同型坑 evidence-graph-store 已修,当时网关静默 exit 13)。
 * bundle 本就把 runtime 内联,静态导入零成本。
 */
import * as rt from "@lampgenie/runtime/agent/direction-atlas";

/** store 层自有码:纯逻辑的 9 码在 runtime(ATLAS_RUNTIME_CODES),这几条只在 IO 面出现。 */
export const ATLAS_NOT_FOUND = "ATLAS_NOT_FOUND" as const;
export const ATLAS_STORE_ERROR = "ATLAS_STORE_ERROR" as const;
export const ATLAS_INVALID_INPUT = "ATLAS_INVALID_INPUT" as const;
export const ATLAS_RENDERED = "ATLAS_RENDERED" as const;
export const ATLAS_BUILT = "ATLAS_BUILT" as const;

export const ATLAS_STORE_CODES = [
  ATLAS_NOT_FOUND,
  ATLAS_STORE_ERROR,
  ATLAS_INVALID_INPUT,
  ATLAS_RENDERED,
  ATLAS_BUILT,
] as const;

/**
 * entries.jsonl 行 kind(只增不改)。
 * goal_progress / goal_close( super agent 管理主线):agent 面的推进/事件——
 * progress 只进快照的 goalProgress 叠加层(runtime Goal 形状不动);close 在投影期改写
 * goal 记录的 status/until/evidenceRefs(readGoal 原样保留这三个字段,投影产物可进 buildAtlas)。
 */
export const ATLAS_EVENT_KINDS = [
  "goal",
  "change",
  "conflict",
  "resolve",
  "decision",
  "defects",
  "goal_progress",
  "goal_close",
] as const;

export type AtlasEventKind = (typeof ATLAS_EVENT_KINDS)[number];

/** 一行事件:at=ISO 字符串,projectId 用于同一 root 下多项目共存时过滤。 */
export interface AtlasEvent {
  at: string;
  kind: AtlasEventKind;
  projectId?: string;
  payload: unknown;
}

export interface AtlasOk {
  ok: boolean;
  code?: string;
}

export interface AtlasBuildResult extends AtlasOk {
  atlas?: DirectionAtlas;
  codes?: string[];
  badLines?: number;
  path?: string;
}

export interface AtlasReadResult extends AtlasOk {
  atlas?: DirectionAtlas;
}

export interface AtlasResolveOpts {
  chosenGoalId: string;
  reason: string;
  by: string;
  at?: string;
}

export interface AtlasTimelineOpts {
  from?: string;
  to?: string;
}

/** 缺陷类聚合行(与 runtime 的 summary.topDefectClasses 同形:{ class, count })。 */
export interface AtlasDefectRow {
  class: string;
  count: number;
}

export interface AtlasReport {
  projectId: string;
  generatedAt: string;
  activeGoals: number;
  achieved: number;
  abandoned: number;
  abandonedGoals: string[];
  openConflicts: number;
  openConflictIds: string[];
  highImpactDecisions: number;
  topDefectClasses: AtlasDefectRow[];
  driftFlags: string[];
  goalCount: number;
  changeCount: number;
  decisionCount: number;
}

/** goal_progress 事件载荷(agent 推进主线;note 必填,evidence 空数组合法)。 */
export interface GoalProgressInput {
  goalId: string;
  note: string;
  nextStep?: string;
  evidence: string[];
  by: string;
}

/** goal_close 事件载荷(achieved/abandoned 二态)。 */
export interface GoalCloseInput {
  goalId: string;
  status: "achieved" | "abandoned";
  reason: string;
  evidence: string[];
  by: string;
}

/** 快照叠加层的单条推进记录(build 后挂到 snapshot.goalProgress[goalId])。 */
export interface GoalProgressRow {
  at: string;
  note: string;
  nextStep?: string;
  evidence: string[];
  by: string;
}

/** entries 的原始投影(保留 unknown:坏条目交给 buildAtlas 判 ATLAS_INVALID)。 */
interface AtlasProjection {
  goals: unknown[];
  changes: unknown[];
  conflicts: unknown[];
  decisions: unknown[];
  defectGenes: unknown[];
  goalProgress: Array<{ goalId: string; row: GoalProgressRow }>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 方向总览快照路径:`<root>/.genie/rsi/atlas/<projectId>.json`。 */
export function atlasJsonPath(root: string, projectId: string): string {
  return join(atlasDir(root), `${projectId}.json`);
}

/** 事件台账路径:`<root>/.genie/rsi/atlas/entries.jsonl`。 */
export function atlasEntriesPath(root: string): string {
  return join(atlasDir(root), "entries.jsonl");
}

/** 数据目录:`<root>/.genie/rsi/atlas`。 */
export function atlasDir(root: string): string {
  return join(root, ".genie", "rsi", "atlas");
}

/** 追加一行事件(单行 + \n,append-only);写失败折叠成 ATLAS_STORE_ERROR,不 throw。 */
function appendEvent(root: string, projectId: string, kind: AtlasEventKind, payload: unknown, at: string): AtlasOk {
  const path = atlasEntriesPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const event: AtlasEvent = { at, kind, projectId, payload };
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    return { ok: true };
  } catch {
    return { ok: false, code: ATLAS_STORE_ERROR };
  }
}

/** 逐行读事件:空行跳过(不计坏行),JSON 坏/结构坏计入 badLines 后跳过,永不 throw。 */
export function loadAtlasEvents(
  root: string,
  projectId: string,
): { events: AtlasEvent[]; badLines: number; totalLines: number } {
  let text: string;
  try {
    text = readFileSync(atlasEntriesPath(root), "utf8");
  } catch {
    return { events: [], badLines: 0, totalLines: 0 };
  }
  const events: AtlasEvent[] = [];
  let badLines = 0;
  let totalLines = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    if (!isRecord(parsed) || !isFilled(parsed.kind) || !isFilled(parsed.at)) {
      badLines += 1;
      continue;
    }
    if (!(ATLAS_EVENT_KINDS as readonly string[]).includes(parsed.kind)) {
      badLines += 1;
      continue;
    }
    const pid = isFilled(parsed.projectId) ? parsed.projectId : undefined;
    if (pid !== undefined && pid !== projectId) continue;
    events.push({ at: parsed.at, kind: parsed.kind as AtlasEventKind, projectId: pid, payload: parsed.payload });
  }
  return { events, badLines, totalLines };
}

/** conflict 关联的两个 goal id(原始记录读 `goals` 二元组)。 */
function conflictGoalIds(value: unknown): string[] {
  const raw = isRecord(value) ? value.goals : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * 重放一条 resolve 事件到原始投影:冲突置 resolved + resolution,被放弃 goal 标
 * superseded/until/supersededBy(与 runtime resolveConflict 的落点一致)。
 */
function applyResolution(goals: unknown[], conflicts: unknown[], payload: unknown, at: string): void {
  if (!isRecord(payload)) return;
  const conflictId = isFilled(payload.conflictId) ? payload.conflictId : undefined;
  const chosenGoalId = isFilled(payload.chosenGoalId) ? payload.chosenGoalId : undefined;
  if (conflictId === undefined || chosenGoalId === undefined) return;
  const target = conflicts.find((item) => isRecord(item) && item.id === conflictId);
  if (!isRecord(target)) return;
  Object.assign(target, {
    status: "resolved",
    resolution: { chosenGoalId, reason: textOf(payload.reason), by: textOf(payload.by), at },
  });
  const ids = conflictGoalIds(target);
  for (const goal of goals) {
    if (!isRecord(goal)) continue;
    const id = textOf(goal.id);
    if (id === chosenGoalId || !ids.includes(id)) continue;
    Object.assign(goal, { status: "superseded", until: at, supersededBy: chosenGoalId });
  }
}

/**
 * 重放一条 goal_close 事件到原始投影:goal 记录置 status/until,evidenceRefs 合并去重
 * (readGoal 原样保留这三个字段,投影产物可直接进 buildAtlas;与 applyResolution 同范式)。
 */
function applyGoalClose(goals: unknown[], payload: unknown, at: string): void {
  if (!isRecord(payload)) return;
  const goalId = isFilled(payload.goalId) ? payload.goalId : undefined;
  if (goalId === undefined) return;
  const status = payload.status === "achieved" || payload.status === "abandoned" ? payload.status : undefined;
  if (status === undefined) return;
  const target = goals.find((item) => isRecord(item) && item.id === goalId);
  if (!isRecord(target)) return;
  const prevEvidence = Array.isArray(target.evidenceRefs)
    ? target.evidenceRefs.filter((item): item is string => typeof item === "string")
    : [];
  const addEvidence = Array.isArray(payload.evidence)
    ? payload.evidence.filter((item): item is string => typeof item === "string")
    : [];
  Object.assign(target, {
    status,
    until: at,
    evidenceRefs: [...new Set([...prevEvidence, ...addEvidence])],
  });
}

/** entries → 原始投影(goal/change/conflict/decision/defects 各取 payload;resolve/goal_close 覆盖 status)。 */
function projectEntries(events: AtlasEvent[]): AtlasProjection {
  const projection: AtlasProjection = {
    goals: [],
    changes: [],
    conflicts: [],
    decisions: [],
    defectGenes: [],
    goalProgress: [],
  };
  const resolutions: AtlasEvent[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "goal":
        if (isRecord(event.payload)) projection.goals.push(event.payload);
        break;
      case "change":
        if (isRecord(event.payload)) projection.changes.push(event.payload);
        break;
      case "conflict":
        if (isRecord(event.payload)) projection.conflicts.push(event.payload);
        break;
      case "decision":
        if (isRecord(event.payload)) projection.decisions.push(event.payload);
        break;
      case "defects": {
 // atlas 机制注意「缺陷基因跨批重复累加,类别权重虚高 1.8 倍」:每批 defects
 // 事件是**快照**不是增量,同 id 多批出现时按 count 取最大(重测删台账重放会重复投)。
        const batch: Record<string, unknown>[] = Array.isArray(event.payload)
          ? event.payload.filter(isRecord)
          : isRecord(event.payload)
            ? [event.payload]
            : [];
        const byId = new Map<string, Record<string, unknown>>(
          projection.defectGenes.map((g) => [String((g as Record<string, unknown>)["id"] ?? ""), g as Record<string, unknown>] as const),
        );
        for (const item of batch) {
          const id = String(item["id"] ?? "");
          const prev = byId.get(id);
          if (prev === undefined) {
            projection.defectGenes.push(item);
            byId.set(id, item);
          } else if (Number(item["count"] ?? 0) > Number(prev["count"] ?? 0)) {
            projection.defectGenes.splice(projection.defectGenes.indexOf(prev), 1, item);
            byId.set(id, item);
          }
        }
        break;
      }
      case "resolve":
        resolutions.push(event);
        break;
      case "goal_close":
        applyGoalClose(projection.goals, event.payload, event.at);
        break;
      case "goal_progress": {
 // 推进轨迹不进 runtime Goal(形状固定),挂快照叠加层 goalProgress;goal 不存在的行
 // 照样投影(事件是 append-only 审计事实,读面(read/brief)按 goalId 过滤)。
        if (isRecord(event.payload) && isFilled(event.payload.goalId) && isFilled(event.payload.note)) {
          const evidence = Array.isArray(event.payload.evidence)
            ? event.payload.evidence.filter((item): item is string => typeof item === "string")
            : [];
          const row: GoalProgressRow = {
            at: event.at,
            note: textOf(event.payload.note),
            evidence,
            by: textOf(event.payload.by),
          };
          if (isFilled(event.payload.nextStep)) row.nextStep = textOf(event.payload.nextStep);
          projection.goalProgress.push({ goalId: event.payload.goalId, row });
        }
        break;
      }
    }
  }
  for (const event of resolutions) applyResolution(projection.goals, projection.conflicts, event.payload, event.at);
  return projection;
}

/** 原始投影 → buildAtlas 的输入(projectId 必填,否则纯逻辑记 ATLAS_INVALID)。 */
function toAtlasInput(projectId: string, projection: AtlasProjection): AtlasInput {
  return {
    projectId,
    // 原始投影保留 unknown(坏行可能缺字段),由 runtime 的 read* 逐条校验后再纳入快照。
    goals: projection.goals as unknown as Goal[],
    changes: projection.changes as unknown as DirectionChange[],
    conflicts: projection.conflicts as unknown as Conflict[],
    decisions: projection.decisions as unknown as KeyDecision[],
    defectGenes: projection.defectGenes as unknown as DefectGene[],
  };
}

/** 原子写快照:mkdir → 写 `<file>.tmp-<pid>` → rename(同 board-store.ts:1166-1168 范式)。 */
/** 快照落盘(原子写; 起导出——atlas-harvest 的 refresh 要把 derived 层合入快照)。 */
export function writeAtlasFile(path: string, atlas: DirectionAtlas): boolean {
  const rename = renameSync;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(atlas, null, 2)}\n`, "utf8");
    rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function atlasArray<T>(atlas: DirectionAtlas, key: string): T[] {
  const raw = (atlas as unknown as UnknownRecord)[key];
  return Array.isArray(raw) ? (raw as T[]) : [];
}

function atlasFlags(atlas: DirectionAtlas): string[] {
  const raw = (atlas as unknown as UnknownRecord).driftFlags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/** 缺陷类聚合行归一化(runtime 用 `class`,历史快照可能是 defectClass/name)。 */
function defectRows(value: unknown): AtlasDefectRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AtlasDefectRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const defectClass = isFilled(item.class)
      ? item.class
      : isFilled(item.defectClass)
        ? item.defectClass
        : isFilled(item.name)
          ? item.name
          : undefined;
    const count = typeof item.count === "number" && Number.isFinite(item.count) ? item.count : undefined;
    if (defectClass === undefined || count === undefined) continue;
    rows.push({ class: defectClass, count });
  }
  return rows;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 追加 goal 事件。 */
export function addGoal(root: string, projectId: string, goal: Goal, at = nowIso()): AtlasOk {
  if (!isFilled(projectId) || !isRecord(goal) || !isFilled(goal.id)) return { ok: false, code: ATLAS_INVALID_INPUT };
  return appendEvent(root, projectId, "goal", goal, at);
}

/** 追加 change(转向时间线)事件。 */
export function addChange(root: string, projectId: string, change: DirectionChange, at = nowIso()): AtlasOk {
  if (!isFilled(projectId) || !isRecord(change)) return { ok: false, code: ATLAS_INVALID_INPUT };
  return appendEvent(root, projectId, "change", change, at);
}

/** 追加 conflict 事件。 */
export function addConflict(root: string, projectId: string, conflict: Conflict, at = nowIso()): AtlasOk {
  if (!isFilled(projectId) || !isRecord(conflict)) return { ok: false, code: ATLAS_INVALID_INPUT };
  return appendEvent(root, projectId, "conflict", conflict, at);
}

/** 追加 decision 事件。 */
export function addDecision(root: string, projectId: string, decision: KeyDecision, at = nowIso()): AtlasOk {
  if (!isFilled(projectId) || !isRecord(decision)) return { ok: false, code: ATLAS_INVALID_INPUT };
  return appendEvent(root, projectId, "decision", decision, at);
}

/** 追加 defects 事件(一批缺陷基因聚成一行,多批累积不覆盖)。 */
export function ingestDefects(root: string, projectId: string, genes: DefectGene[], at = nowIso()): AtlasOk {
  if (!isFilled(projectId) || !Array.isArray(genes)) return { ok: false, code: ATLAS_INVALID_INPUT };
  return appendEvent(root, projectId, "defects", genes.filter((gene) => isRecord(gene)), at);
}

/** goal id 归一化证据上限:一条 progress/close 最多带 8 条证据,单条 ≤200 字。 */
function normalizeEvidence(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim().slice(0, 200))
    .slice(0, 8);
}

/** 投影里找 goal 记录(按 id;含已/被顶替的——幂等判定要用)。 */
function findGoalInProjection(projection: AtlasProjection, goalId: string): UnknownRecord | undefined {
  return projection.goals.find((item) => isRecord(item) && item.id === goalId) as UnknownRecord | undefined;
}

/**
 * agent 推进主线( super agent 管理世界模型):追加 goal_progress 事件。
 * goal 不存在 → ATLAS_NOT_FOUND 且不写盘;note 空白 → ATLAS_INVALID_INPUT。
 * 快照重建归调用方(工具面 build(preserveDerived));本函数与 addGoal 同范式只管 append。
 */
export function recordGoalProgress(
  root: string,
  projectId: string,
  input: GoalProgressInput,
  at = nowIso(),
): AtlasOk {
  const goalId = isFilled(input?.goalId) ? input.goalId.trim() : "";
  const note = isFilled(input?.note) ? input.note.trim().slice(0, 400) : "";
  if (!isFilled(projectId) || goalId === "" || note === "") return { ok: false, code: ATLAS_INVALID_INPUT };
  const { events } = loadAtlasEvents(root, projectId);
  const projection = projectEntries(events);
  if (findGoalInProjection(projection, goalId) === undefined) return { ok: false, code: ATLAS_NOT_FOUND };
  const nextStep = isFilled(input.nextStep) ? input.nextStep.trim().slice(0, 160) : undefined;
  const by = isFilled(input.by) ? input.by.trim().slice(0, 80) : "";
  return appendEvent(
    root,
    projectId,
    "goal_progress",
    { goalId, note, ...(nextStep !== undefined ? { nextStep } : {}), evidence: normalizeEvidence(input.evidence), by },
    at,
  );
}

/**
 * agent 主线:追加 goal_close 事件(achieved/abandoned)。
 * - goal 不存在 → ATLAS_NOT_FOUND;status 非法/reason 空白 → ATLAS_INVALID_INPUT;都不写盘。
 * - 已 achieved/abandoned 且同状态 → 幂等 ok(不追加第二行,entries 不增长)。
 * - superseded(冲突裁决产物)→ ATLAS_INVALID_INPUT:裁决历史不可被 agent 改写。
 */
export function closeGoal(
  root: string,
  projectId: string,
  input: GoalCloseInput,
  at = nowIso(),
): AtlasOk & { idempotent?: boolean } {
  const goalId = isFilled(input?.goalId) ? input.goalId.trim() : "";
  const status = input?.status === "achieved" || input?.status === "abandoned" ? input.status : undefined;
  const reason = isFilled(input?.reason) ? input.reason.trim().slice(0, 300) : "";
  if (!isFilled(projectId) || goalId === "" || status === undefined || reason === "") {
    return { ok: false, code: ATLAS_INVALID_INPUT };
  }
  const { events } = loadAtlasEvents(root, projectId);
  const projection = projectEntries(events);
  const goal = findGoalInProjection(projection, goalId);
  if (goal === undefined) return { ok: false, code: ATLAS_NOT_FOUND };
  const current = textOf(goal.status);
  if (current === "achieved" || current === "abandoned") {
    return current === status
      ? { ok: true, code: "ATLAS_GOAL_CLOSED", idempotent: true }
      : { ok: false, code: ATLAS_INVALID_INPUT };
  }
  if (current === "superseded") return { ok: false, code: ATLAS_INVALID_INPUT };
  const by = isFilled(input.by) ? input.by.trim().slice(0, 80) : "";
  const written = appendEvent(
    root,
    projectId,
    "goal_close",
    { goalId, status, reason, evidence: normalizeEvidence(input.evidence), by },
    at,
  );
  if (!written.ok) return written;
  return { ok: true, code: "ATLAS_GOAL_CLOSED" };
}

/**
 * 裁决冲突:先在内存里 build 一份草稿(不落盘)再走纯逻辑 resolveConflict 演练。
 * - 冲突不存在 → ATLAS_NOT_FOUND;chosen 不属于该冲突 → ATLAS_GOAL_NOT_FOUND;两条都不写盘。
 * - 已 resolved → 幂等:返回 ok + idempotent,不追加第二行(entries 不增长)。
 * - 成功只追加 resolve 事件,快照等下一次 build 重放。
 */
export function resolveConflict(
  root: string,
  projectId: string,
  conflictId: string,
  opts: AtlasResolveOpts,
): AtlasOk & { idempotent?: boolean } {
  const chosenGoalId = isFilled(opts?.chosenGoalId) ? opts.chosenGoalId.trim() : "";
  if (!isFilled(projectId) || !isFilled(conflictId) || chosenGoalId === "") {
    return { ok: false, code: ATLAS_INVALID_INPUT };
  }
  const by = isFilled(opts.by) ? opts.by.trim() : "";
  const reason = typeof opts.reason === "string" ? opts.reason : "";
  const at = isFilled(opts.at) ? opts.at : nowIso();

  const { events } = loadAtlasEvents(root, projectId);
  const draft = rt.buildAtlas(toAtlasInput(projectId, projectEntries(events)), { now: at }).atlas;
  const target = draft.conflicts.find((item) => item.id === conflictId);
  if (target === undefined) return { ok: false, code: ATLAS_NOT_FOUND };
  if (!target.goals.includes(chosenGoalId)) return { ok: false, code: "ATLAS_GOAL_NOT_FOUND" };
  if (target.status === "resolved") {
    return { ok: true, code: "ATLAS_CONFLICT_RESOLVED", idempotent: true };
  }

  const rehearsal = rt.resolveConflict(draft, conflictId, { chosenGoalId, reason, by, at });
  const rehearsalCodes: string[] = Array.isArray(rehearsal?.codes) ? rehearsal.codes : [];
  if (!rehearsalCodes.includes("ATLAS_CONFLICT_RESOLVED")) {
    return { ok: false, code: "ATLAS_GOAL_NOT_FOUND" };
  }

  const written = appendEvent(root, projectId, "resolve", { conflictId, chosenGoalId, reason, by }, at);
  if (!written.ok) return written;
  return { ok: true, code: "ATLAS_CONFLICT_RESOLVED" };
}

/**
 * 重建快照:entries → 投影 → buildAtlas → 原子写 atlas json。
 * 坏行只计入 badLines;有 driftFlags 也照常 ok:true(漂移是结论,不是失败)。
 * preserveDerived( agent 写通道):写入前读旧快照,把 derived 层(会话挖掘的观察值,
 * 只在 nightly refresh 重算)原样带到新快照——agent 的 goal_progress/goal_close 增量 build 不再
 * 把 derived 洗掉(nightly 旧实现「读快照→追加 goal→写回」的同一语义,成通用选项)。
 * goalProgress(推进轨迹叠加层)由 projection 产出,build 后挂到快照顶层。
 */
export function build(
  root: string,
  projectId: string,
  opts: { now?: string; driftWindowDays?: number; preserveDerived?: boolean } = {},
): AtlasBuildResult {
  if (!isFilled(projectId)) return { ok: false, code: ATLAS_INVALID_INPUT };
  const { events, badLines } = loadAtlasEvents(root, projectId);
  const now = isFilled(opts.now) ? opts.now : nowIso();
  const projection = projectEntries(events);
  const built = rt.buildAtlas(toAtlasInput(projectId, projection), {
    now,
    driftWindowDays: opts.driftWindowDays,
  });
  const base: DirectionAtlas = built.atlas ?? rt.emptyAtlas(projectId, now);
  const atlas = base as DirectionAtlas & { derived?: unknown; goalProgress?: Record<string, GoalProgressRow[]> };
  if (projection.goalProgress.length > 0) {
    const byGoal: Record<string, GoalProgressRow[]> = {};
    for (const { goalId, row } of projection.goalProgress) {
      (byGoal[goalId] ??= []).push(row);
    }
    atlas.goalProgress = byGoal;
  }
  if (opts.preserveDerived === true) {
    const prev = getAtlas(root, projectId);
    const prevDerived = (prev.atlas as { derived?: unknown } | undefined)?.derived;
    if (prevDerived !== undefined) atlas.derived = prevDerived;
  }
  const codes: string[] = Array.isArray(built.codes) ? built.codes.slice() : [];
  if (!codes.includes(ATLAS_BUILT)) codes.unshift(ATLAS_BUILT);
  const path = atlasJsonPath(root, projectId);
  if (!writeAtlasFile(path, atlas)) return { ok: false, code: ATLAS_STORE_ERROR };
  return { ok: true, atlas, codes, badLines, path };
}

/** 读快照;文件不存在/坏 JSON 一律 ATLAS_NOT_FOUND(快照可由 entries 重建,不细分)。 */
export function getAtlas(root: string, projectId: string): AtlasReadResult {
  if (!isFilled(projectId)) return { ok: false, code: ATLAS_INVALID_INPUT };
  let text: string;
  try {
    text = readFileSync(atlasJsonPath(root, projectId), "utf8");
  } catch {
    return { ok: false, code: ATLAS_NOT_FOUND };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: ATLAS_NOT_FOUND };
  }
  if (!isRecord(parsed)) return { ok: false, code: ATLAS_NOT_FOUND };
  return { ok: true, atlas: parsed as unknown as DirectionAtlas };
}

/** 转向时间线投影:读快照(未 build → ATLAS_NOT_FOUND),按 from/to ISO 过滤(含端点)。 */
export function timeline(
  root: string,
  projectId: string,
  opts: AtlasTimelineOpts = {},
): AtlasOk & { changes: DirectionChange[] } {
  const got = getAtlas(root, projectId);
  if (!got.ok || got.atlas === undefined) return { ok: false, code: ATLAS_NOT_FOUND, changes: [] };
  const changes = rt.timelineSince(got.atlas, { from: opts.from, to: opts.to });
  return { ok: true, changes: Array.isArray(changes) ? changes : [] };
}

/** 渲染快照:md 五节 / json;成功时附 ATLAS_RENDERED 码。 */
export function render(root: string, projectId: string, opts: { format: "md" | "json" }): AtlasOk & { text?: string } {
  const got = getAtlas(root, projectId);
  if (!got.ok || got.atlas === undefined) return { ok: false, code: ATLAS_NOT_FOUND, text: "" };
  const format = opts?.format === "json" ? "json" : "md";
  const text = format === "json" ? rt.renderAtlasJson(got.atlas) : rt.renderAtlasMarkdown(got.atlas);
  return { ok: true, code: ATLAS_RENDERED, text };
}

/** 摘要报表:只读快照(未 build → ATLAS_NOT_FOUND),字段全部从 atlas 现算。 */
export function reportAtlas(root: string, projectId: string): AtlasOk & { report?: AtlasReport } {
  const got = getAtlas(root, projectId);
  if (!got.ok || got.atlas === undefined) return { ok: false, code: ATLAS_NOT_FOUND };
  const atlas = got.atlas;
  const goals = atlasArray<Goal>(atlas, "goals");
  const changes = atlasArray<DirectionChange>(atlas, "timeline");
  const conflicts = atlasArray<Conflict>(atlas, "conflicts");
  const decisions = atlasArray<KeyDecision>(atlas, "keyDecisions");
  const abandonedGoals = goals.filter((goal) => goal.status === "abandoned").map((goal) => goal.id);
  const openConflictIds = conflicts.filter((conflict) => conflict.status !== "resolved").map((conflict) => conflict.id);
  const rawProjectId = (atlas as unknown as UnknownRecord).projectId;
  const report: AtlasReport = {
    projectId: isFilled(rawProjectId) ? rawProjectId : projectId,
    generatedAt: textOf((atlas as unknown as UnknownRecord).generatedAt),
    activeGoals: goals.filter((goal) => goal.status === "active").length,
    achieved: goals.filter((goal) => goal.status === "achieved").length,
    abandoned: abandonedGoals.length,
    abandonedGoals,
    openConflicts: openConflictIds.length,
    openConflictIds,
    highImpactDecisions: decisions.filter((decision) => decision.impact === "high").length,
    topDefectClasses: defectRows(rt.topDefectClasses(atlas, { limit: 5 })),
    driftFlags: atlasFlags(atlas),
    goalCount: goals.length,
    changeCount: changes.length,
    decisionCount: decisions.length,
  };
  return { ok: true, report };
}

/** 纯逻辑码表 / 版本的只读转出口(CLI 与上层报表用,免得再 import 一次 runtime)。 */
export const DIRECTION_ATLAS_STORE_VERSION = rt.DIRECTION_ATLAS_VERSION;
export const ATLAS_RUNTIME_CODES = rt.ATLAS_CODES;
