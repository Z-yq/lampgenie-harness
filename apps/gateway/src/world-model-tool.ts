/**
 * world_model 工具( super agent 管理项目世界模型):agent 面的世界模型读写入口。
 * 为什么需要:此前世界模型的写入面只有 nightly 自动晋升(主题簇→goal)——super agent 只能在
 * 开工简报里**读**主线,既不能登记决策/转向,也不能推进或目标;主线成了「只涨不动的展示品」。
 * 「期望由 super agent 来管理项目世界模型,由 super agent 来推动项目世界模型的主线」。
 * 动作面:
 * - read:主线全景(活跃 goal+进度轨迹+下一步/最近转向/未决冲突/关键决策/derived 摘要)——拉取式,agent 随时自查;
 * - goal_add / goal_progress / goal_close:主线的立线/推进/(append-only 事件,快照即时重建);
 * - decision / change:关键决策与方向转向事件(evidenceRefs 必带,回链审计)。
 * 治理(与治理核心同源的原则,落在工具面):
 * - goal_add 与既有活跃 goal 标题 Jaccard ≥0.6 → 拒并指路 goal_progress(防同一主线重复立线);
 * - goal_progress/goal_close 校验 goalId 存在(store 层 ATLAS_NOT_FOUND 不写盘);
 * 恰有 1 条活跃主线且缺 goalId 时自动补全(多主线时列出候选让 agent 选,不猜);
 * - 写后 build(preserveDerived) —— derived 层(夜间挖掘观察值)不被增量重建洗掉;
 * - 世界模型是本地仓事实(.genie/rsi/atlas):远程项目任务不注册本工具(注册侧门控)。
 */
import { basename } from "node:path";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import {
  addChange,
  addDecision,
  addGoal,
  build,
  closeGoal,
  getAtlas,
  recordGoalProgress,
  type GoalProgressRow,
} from "./direction-atlas-store.js";

/** 唯一工具名(权限/日志按此识别)。 */
export const WORLD_MODEL_TOOL_NAME = "world_model";

export const WORLD_MODEL_ACTIONS = ["read", "goal_add", "goal_progress", "goal_close", "decision", "change"] as const;
export type WorldModelAction = (typeof WORLD_MODEL_ACTIONS)[number];

const CHANGE_KINDS = ["pivot", "refocus", "abandon", "scope-cut", "add"] as const;

function usage(): string {
  return [
    "world_model 用法(super agent 管理项目世界模型/推动主线):",
    "· action=read —— 主线全景(活跃 goal+进度+下一步/转向/冲突/决策/世界模型摘要)",
    "· action=goal_add title=<一句话主线> detail=<为什么> —— 立新主线(与既有主线重复会被拒)",
    "· action=goal_progress goalId=<id> note=<这次推进了什么> nextStep=<下一步> evidence=<file:line/任务id> —— 推进主线",
    "· action=goal_close goalId=<id> status=achieved|abandoned reason=<依据> evidence=<> —— 收口主线",
    "· action=decision decision=<结论> rationale=<依据> impact=high|medium|low evidence=<> —— 登记关键决策",
    "· action=change reason=<为什么转向> kind=pivot|refocus|abandon|scope-cut|add from=<旧> to=<新> —— 登记方向转向",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * 参数面判定(纯函数,测试直测)
 * ------------------------------------------------------------------ */

export type WorldModelDispatch =
  | { kind: "read" }
  | { kind: "goal_add"; title: string; detail?: string; evidence: string[] }
  | { kind: "goal_progress"; goalId: string; note: string; nextStep?: string; evidence: string[] }
  | { kind: "goal_close"; goalId: string; status: "achieved" | "abandoned"; reason: string; evidence: string[] }
  | { kind: "decision"; decision: string; rationale: string; impact: "low" | "medium" | "high"; evidence: string[] }
  | { kind: "change"; kindOfChange: string; reason: string; from?: string; to?: string; evidence: string[] }
  | { kind: "invalid"; reason: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  if (typeof v === "string" && v.trim() !== "") return [v.trim()];
  return [];
}

export function dispatchWorldModelArgs(args: unknown): WorldModelDispatch {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = str(a.action) || "read";
  if (!(WORLD_MODEL_ACTIONS as readonly string[]).includes(action)) {
    return { kind: "invalid", reason: `未知 action: ${action}\n${usage()}` };
  }
  const evidence = strArray(a.evidence);
  switch (action as WorldModelAction) {
    case "read":
      return { kind: "read" };
    case "goal_add": {
      const title = str(a.title);
      if (title === "") return { kind: "invalid", reason: "goal_add 需要 title(一句话主线)\n" + usage() };
      const detail = str(a.detail) || undefined;
      return { kind: "goal_add", title: title.slice(0, 120), ...(detail ? { detail: detail.slice(0, 400) } : {}), evidence };
    }
    case "goal_progress": {
      const note = str(a.note);
      if (note === "") return { kind: "invalid", reason: "goal_progress 需要 note(这次推进了什么)\n" + usage() };
      const nextStep = str(a.nextStep) || undefined;
      return {
        kind: "goal_progress",
        goalId: str(a.goalId),
        note: note.slice(0, 400),
        ...(nextStep ? { nextStep: nextStep.slice(0, 160) } : {}),
        evidence,
      };
    }
    case "goal_close": {
      const reason = str(a.reason);
      const status = str(a.status);
      if (status !== "achieved" && status !== "abandoned") {
        return { kind: "invalid", reason: "goal_close 需要 status=achieved|abandoned\n" + usage() };
      }
      if (reason === "") return { kind: "invalid", reason: "goal_close 需要 reason(收口依据)\n" + usage() };
      return { kind: "goal_close", goalId: str(a.goalId), status, reason: reason.slice(0, 300), evidence };
    }
    case "decision": {
      const decision = str(a.decision);
      const rationale = str(a.rationale);
      if (decision === "" || rationale === "") {
        return { kind: "invalid", reason: "decision 需要 decision(结论)+rationale(依据)\n" + usage() };
      }
      const impact = str(a.impact) || "medium";
      if (!["low", "medium", "high"].includes(impact)) {
        return { kind: "invalid", reason: `impact 取值非法:${impact}(low|medium|high)` };
      }
      return {
        kind: "decision",
        decision: decision.slice(0, 200),
        rationale: rationale.slice(0, 400),
        impact: impact as "low" | "medium" | "high",
        evidence,
      };
    }
    case "change": {
      const reason = str(a.reason);
      if (reason === "") return { kind: "invalid", reason: "change 需要 reason(为什么转向)\n" + usage() };
      const kindOfChange = str(a.kind) || "refocus";
      if (!(CHANGE_KINDS as readonly string[]).includes(kindOfChange)) {
        return { kind: "invalid", reason: `kind 取值非法:${kindOfChange}(${CHANGE_KINDS.join("/")})` };
      }
      const from = str(a.from) || undefined;
      const to = str(a.to) || undefined;
      return { kind: "change", kindOfChange, reason: reason.slice(0, 300), ...(from ? { from } : {}), ...(to ? { to } : {}), evidence };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 治理辅助(纯函数,测试直测)
 * ------------------------------------------------------------------ */

/** 标题相似 token:ascii 词(≥3 字符)+ CJK 二元组。 */
export function titleTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) ?? []) tokens.add(m.toLowerCase());
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** Jaccard 相似度(空集安全:两边都空 → 0,不误判重复)。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 包含度 overlap = 交集 / min(两集大小)。去重判据用它而非 Jaccard:同主线加几个词
 * (「经验编译闭环」→「经验编译生产闭环」)会稀释 Jaccard 到 0.56,但包含度 0.83——
 * 「新标题是否本质是既有主线的细化」正是去重要问的问题。
 */
export function overlapCoeff(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

/** goal id 生成:title slug + 日期;与既有 id 冲突时追加序号。 */
export function goalIdFor(title: string, date: string, existing: Set<string>): string {
  const words = title.match(/[A-Za-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const slug = words.join("-").toLowerCase().slice(0, 40).replace(/^-+|-+$/g, "") || "goal";
  let id = `goal-${slug}-${date}`;
  let n = 2;
  while (existing.has(id)) {
    id = `goal-${slug}-${date}-${n}`;
    n += 1;
  }
  return id;
}

/* ------------------------------------------------------------------ *
 * 读视图渲染
 * ------------------------------------------------------------------ */

interface GoalRow {
  id?: string;
  title?: string;
  status?: string;
  since?: string;
  until?: string;
  detail?: string;
  evidenceRefs?: string[];
}

interface SnapshotView {
  goals?: GoalRow[];
  timeline?: Array<{ at?: string; reason?: string; kind?: string; from?: string; to?: string }>;
  conflicts?: Array<{ id?: string; status?: string; detail?: string }>;
  keyDecisions?: Array<{ at?: string; decision?: string; impact?: string; rationale?: string }>;
  defectGenes?: unknown[];
  derived?: {
    themes?: Array<{ id?: string; sessions?: number }>;
    moduleActivity?: Array<{ path?: string; editSessions?: number }>;
    reworkSignals?: Array<{ path?: string; gapMs?: number }>;
    repeatExploration?: Array<{ path?: string; sessions?: number }>;
  };
  goalProgress?: Record<string, GoalProgressRow[]>;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** goal 的最新下一步(进度轨迹里最后一个带 nextStep 的值;无 → 空)。 */
function lastNextStep(progress: GoalProgressRow[] | undefined): string {
  if (!Array.isArray(progress)) return "";
  for (let i = progress.length - 1; i >= 0; i -= 1) {
    const step = progress[i]?.nextStep;
    if (typeof step === "string" && step.trim() !== "") return step.trim();
  }
  return "";
}

export function renderWorldModelRead(atlas: unknown): string {
  const snap = (atlas ?? {}) as SnapshotView;
  const progressOf = snap.goalProgress ?? {};
  const lines: string[] = ["## 项目世界模型主线全景"];
  const active = (snap.goals ?? []).filter((g) => g.status === undefined || g.status === "active");
  const closed = (snap.goals ?? []).filter((g) => g.status === "achieved" || g.status === "abandoned");
  if (active.length === 0) lines.push("- 活跃主线:无(goal_add 立线;derived 主题簇 ≥5 会话会在夜间自动晋升)");
  for (const goal of active) {
    const rows = progressOf[goal.id ?? ""] ?? [];
    const last = rows[rows.length - 1];
    const next = lastNextStep(rows);
    lines.push(
      `- ▶ ${goal.id ?? "?"} 「${clip(goal.title ?? "", 60)}」`
      + (rows.length > 0 ? `(进度 ${rows.length} 条${last ? ` · 最近:${clip(last.note, 50)}` : ""})` : "(未推进过)")
      + (next !== "" ? `\n    下一步:${clip(next, 80)}` : ""),
    );
  }
  if (closed.length > 0) {
    lines.push(`- 已收口:${closed.length} 条(${closed.slice(-3).map((g) => `${g.id}=${g.status}`).join(", ")})`);
  }
  for (const turn of (snap.timeline ?? []).slice(-3).reverse()) {
    if (turn.reason) lines.push(`- 转向[${turn.kind ?? "?"}]:${clip(turn.reason, 70)}`);
  }
  for (const conflict of (snap.conflicts ?? []).filter((c) => c.status !== "resolved").slice(0, 3)) {
    if (conflict.detail) lines.push(`- ⚠ 未决冲突:${clip(conflict.detail, 70)}`);
  }
  for (const decision of (snap.keyDecisions ?? []).slice(-3).reverse()) {
    if (decision.decision) lines.push(`- 决策[${decision.impact ?? "?"}]:${clip(decision.decision, 60)}`);
  }
  const d = snap.derived;
  if (d !== undefined) {
    const themes = (d.themes ?? []).slice(0, 3).map((t) => `${t.id}×${t.sessions ?? 0}`).join("、");
    if (themes !== "") lines.push(`- 本周主题:${themes}`);
    const hot = (d.moduleActivity ?? []).slice(0, 3).filter((m) => (m.editSessions ?? 0) >= 2).map((m) => `${m.path}(${m.editSessions})`).join("、");
    if (hot !== "") lines.push(`- 热点模块:${hot}`);
    const rework = (d.reworkSignals ?? []).slice(0, 2).map((s) => s.path).join("、");
    if (rework !== "") lines.push(`- 返工信号:${rework}`);
  }
  const genes = Array.isArray(snap.defectGenes) ? snap.defectGenes.length : 0;
  if (genes > 0) lines.push(`- 缺陷基因:${genes} 条(开工简报按任务匹配注入)`);
  lines.push("(管理:goal_progress 推进 · goal_close 收口 · decision/change 登记决策与转向)");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 工具工厂
 * ------------------------------------------------------------------ */

/**
 * @param root 仓根(世界模型落 `<root>/.genie/rsi/atlas/`;projectKey=basename(root),
 * 与开工简报/夜间流水线同口径—— 注意 taskRoot basename 会查错仓)
 * @param by 写入者标识(agent:<sessionId 短码>),进事件的 by 字段留审计链
 */
export function worldModelTool(root: string, by = "agent"): Tool {
  const projectKey = basename(root);
 /** 写后增量重建快照(保留 derived 层);返回 null=成功(回执里拼新状态摘要)。 */
  const rebuild = (): string => {
    const built = build(root, projectKey, { preserveDerived: true });
    if (!built.ok) return `⚠ 快照重建失败(${built.code ?? "?"})——事件已入台账,下次夜间 refresh 会重建`;
    return "";
  };
  const activeGoals = (): { id: string; title: string }[] => {
    const snap = (getAtlas(root, projectKey).atlas ?? {}) as SnapshotView;
    return (snap.goals ?? [])
      .filter((g) => (g.status === undefined || g.status === "active") && typeof g.id === "string")
      .map((g) => ({ id: g.id as string, title: g.title ?? "" }));
  };
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    name: WORLD_MODEL_TOOL_NAME,
    description:
      "Manage and drive the project world model (direction atlas): read = full mainline view (active goals + progress + next steps / pivots / conflicts / decisions / world-model digest); goal_add / goal_progress / goal_close = create / advance / close mainline goals (agent-owned; evidence = file:line or task ids); decision / change = record key decisions and direction pivots (append-only audit). Call read at task start when you need project direction beyond the kickoff brief; call goal_progress during acceptance when this task advanced a mainline goal.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...WORLD_MODEL_ACTIONS], description: "read | goal_add | goal_progress | goal_close | decision | change" },
        goalId: { type: "string", description: "goal id (from read/kickoff brief; omitted = auto-filled when exactly one active mainline)" },
        title: { type: "string", description: "goal_add: one-line mainline title" },
        detail: { type: "string", description: "goal_add: why this mainline matters" },
        note: { type: "string", description: "goal_progress: what advanced this time (≤400 chars)" },
        nextStep: { type: "string", description: "goal_progress: concrete next step along the mainline (shown in kickoff briefs)" },
        status: { type: "string", enum: ["achieved", "abandoned"], description: "goal_close: outcome" },
        reason: { type: "string", description: "goal_close/change: rationale (audit)" },
        decision: { type: "string", description: "decision: the decision" },
        rationale: { type: "string", description: "decision: the rationale" },
        impact: { type: "string", enum: ["low", "medium", "high"], description: "decision impact (default medium)" },
        kind: { type: "string", enum: [...CHANGE_KINDS], description: "change kind (default refocus)" },
        from: { type: "string", description: "change: previous focus" },
        to: { type: "string", description: "change: new focus" },
        evidence: { type: "array", items: { type: "string" }, description: "evidence refs (file:line, task ids, commit sha) — required for goal_close/decision, recommended for goal_progress" },
      },
      required: ["action"],
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(args: unknown) {
      const d = dispatchWorldModelArgs(args);
      if (d.kind === "invalid") return d.reason;
      try {
        if (d.kind === "read") {
          const got = getAtlas(root, projectKey);
          if (!got.ok || got.atlas === undefined) {
            return `世界模型快照不存在(${got.code ?? "?"})——先跑一轮任务/夜间流水线生成,或 goal_add 立第一条主线。`;
          }
          return renderWorldModelRead(got.atlas);
        }
        if (d.kind === "goal_add") {
          const existing = activeGoals();
          const incoming = titleTokens(d.title);
          for (const goal of existing) {
            const sim = overlapCoeff(incoming, titleTokens(goal.title));
            if (sim >= 0.6) {
              return `拒立线:与既有活跃主线「${clip(goal.title, 60)}」相似度 ${sim.toFixed(2)}(≥0.60)——同一主线应推进而非重复立线:\n  world_model action=goal_progress goalId=${goal.id} note=...`;
            }
          }
          const allIds = new Set<string>(
            ((getAtlas(root, projectKey).atlas ?? {}) as SnapshotView).goals?.map((g) => g.id ?? "").filter(Boolean) ?? [],
          );
          const id = goalIdFor(d.title, date, allIds);
          const evidence = d.evidence.length > 0 ? d.evidence : [`by:${by}`];
          const written = addGoal(root, projectKey, {
            id,
            title: d.title,
            status: "active",
            since: new Date().toISOString(),
            evidenceRefs: evidence,
            ...(d.detail ? { detail: d.detail } : {}),
          });
          if (!written.ok) return `goal_add 失败:${written.code ?? "?"}`;
          const warn = rebuild();
          return `✅ 已立主线 ${id}「${d.title}」\n${warn}(推进用 action=goal_progress goalId=${id};下一步写进 nextStep 会出现在后续任务的开工简报)`;
        }
        if (d.kind === "goal_progress" || d.kind === "goal_close") {
          let goalId = d.goalId;
          if (goalId === "") {
            const active = activeGoals();
            if (active.length === 1) goalId = active[0]!.id;
            else if (active.length === 0) return "无活跃主线可操作——先 action=goal_add 立线";
            else return `多条活跃主线,需要 goalId 二选一:\n${active.map((g) => `  · ${g.id} 「${clip(g.title, 50)}」`).join("\n")}`;
          }
          if (d.kind === "goal_progress") {
            const written = recordGoalProgress(root, projectKey, { goalId, note: d.note, nextStep: d.nextStep, evidence: d.evidence, by });
            if (!written.ok) {
              const hint = written.code === "ATLAS_NOT_FOUND" && activeGoals().length === 0 ? "(当前无活跃主线——先 action=goal_add 立线)" : "";
              return `goal_progress 失败:${written.code ?? "?"}(goalId=${goalId})${hint}`;
            }
            const warn = rebuild();
            const rows = ((getAtlas(root, projectKey).atlas ?? {}) as SnapshotView).goalProgress?.[goalId]?.length ?? 0;
            return `✅ 主线 ${goalId} 已登记推进(累计 ${rows} 条)${d.nextStep ? `\n下一步:${d.nextStep}` : ""}\n${warn}`;
          }
          if (d.evidence.length === 0) {
            return "goal_close 需要 evidence(收口必须留证:任务 id/file:line/commit)";
          }
          const written = closeGoal(root, projectKey, { goalId, status: d.status, reason: d.reason, evidence: d.evidence, by });
          if (!written.ok) {
            const hint = written.code === "ATLAS_NOT_FOUND" && activeGoals().length === 0 ? "(当前无活跃主线——先 action=goal_add 立线)" : "";
            return `goal_close 失败:${written.code ?? "?"}(goalId=${goalId})${hint}`;
          }
          const warn = rebuild();
          if (written.idempotent) return `主线 ${goalId} 已是 ${d.status}(幂等,未追加事件)`;
          return `✅ 主线 ${goalId} 已收口为 ${d.status}:${clip(d.reason, 60)}\n${warn}`;
        }
        if (d.kind === "decision") {
          const id = `dec-${date}-${Date.now().toString(36).slice(-5)}`;
          const written = addDecision(root, projectKey, {
            id,
            at: new Date().toISOString(),
            decision: d.decision,
            rationale: d.rationale,
            impact: d.impact,
            evidenceRefs: d.evidence.length > 0 ? d.evidence : [`by:${by}`],
          });
          if (!written.ok) return `decision 失败:${written.code ?? "?"}`;
          return `✅ 决策已登记(${id},impact=${d.impact})${rebuild()}`;
        }
 // change
        const id = `chg-${date}-${Date.now().toString(36).slice(-5)}`;
        const written = addChange(root, projectKey, {
          id,
          at: new Date().toISOString(),
          kind: d.kindOfChange as "pivot",
          reason: d.reason,
          evidenceRefs: d.evidence.length > 0 ? d.evidence : [`by:${by}`],
          ...(d.from ? { from: d.from } : {}),
          ...(d.to ? { to: d.to } : {}),
        });
        if (!written.ok) return `change 失败:${written.code ?? "?"}`;
        return `✅ 方向转向已登记(${id},${d.kindOfChange}):${clip(d.reason, 60)}${rebuild()}`;
      } catch (err) {
        return `world_model 错误:${String(err).slice(0, 200)}`;
      }
    },
  };
}
