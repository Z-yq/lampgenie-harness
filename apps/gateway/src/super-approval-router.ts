/**
 * super 派发任务的权限审批自决路由:
 * 「由 super agent 发送的任务,coding agent 会时不时请求我来授权...这个请求应该发给 super agent,
 * 由 super agent 全权调度」。
 * 语义(分支点在 PermissionBroker.ask:只有 submittedBy=super **且命中 super 审批分级**的任务
 * 进本路由——危险/重资源/重启/发布/宽影响;日常读写与普通命令走聊天窗权限设置,
 * 分级见 super-approval-policy.ts):
 * - 申请排队送 super(SuperAgentChannel 串行队列,忙时排队不并发),super 用 permission_decide 工具自决;
 * - allow -> coding agent 继续执行;deny -> 拒绝理由回灌任务会话(message.system)+ 指挥台留痕;
 * - 兜底绝不静默:单请求最大等待(缺省 120s,env GENIE_SUPER_APPROVAL_TIMEOUT_MS 可调)或
 * super 轮次结束仍未决、轮次异常 -> 升级转用户,摘要前缀「super 未决」;不允许「超时=默默拒绝把任务卡死」;
 * - 非 super 任务(用户直发、系统、RSI)不经过本模块,原面板审批路径逐字不变。
 * 留痕三处(都可追溯):
 * 1) journal permission.gate:by=super-approved、super-denied、super-escalated-user(+reason);
 * 2) 任务会话 message.system:「[super 审批] 已批准/已拒绝 ...,理由:...」(模型下一轮可见、面板会话可见);
 * 3) super.notice 广播:「[super 审批] ...」与「[super 未决] ...」(指挥台可见)。
 */
import type { Journal } from "@lampgenie/core";
import type { PermissionAskInput, PermissionOutcome } from "./permission-broker.js";

export type SuperApprovalDecision = "allow-once" | "reject" | "escalate";

/** 送 super 自决的申请(broker 透传的 PermissionAskInput + 任务归属)。 */
export interface SuperApprovalTarget extends PermissionAskInput {
  taskId?: string;
  submittedBy?: string;
 /** 任务书节选(范围+红线的判定依据)。 */
  brief?: string;
}

interface PendingApproval {
  input: SuperApprovalTarget;
  since: number;
 /** 送达 super 的时刻(通道轮次真正开始;决策窗从这里起算)。未送达=undefined。 */
  deliveredAt?: number;
  done: boolean;
  finish: (outcome: PermissionOutcome, note?: string) => void;
}

export interface SuperApprovalHistoryItem {
  requestId: string;
  taskId?: string;
  tool: string;
  summary: string;
  decision: "allow-once" | "reject";
  by: string;
  since: number;
  settledAt: number;
  note: string;
}

export interface SuperApprovalRouterDeps {
  journal: Journal;
 /** 把申请排进 super 轮次(channel.requestPermissionDecision;resolve=该轮结束)。
 * onDelivered:通道在**轮次真正开始前**调用,作为「送达」回执;返回 false 表示该申请
 * 已在排队期间失效(已升级/已决),通道应跳过本申请不再白跑一轮 LLM。 */
  askSuper: (input: SuperApprovalTarget, onDelivered?: () => boolean) => Promise<void>;
 /** 升级转用户(app 注入 broker.ask(noSuper);离线时由 broker 按既有口径快速收敛,不挂起)。 */
  escalate: (input: SuperApprovalTarget) => Promise<PermissionOutcome>;
 /** 广播留痕(super.notice;缺省 no-op)。 */
  notify?: (text: string, extra?: Record<string, unknown>) => void;
 /** **送达 super 之后**的决策窗毫秒(env GENIE_SUPER_APPROVAL_TIMEOUT_MS 优先)。
 * 修正:此前该计时从 ask 当场起算,super 串行队列排队 70~163s 即吃掉整个窗口,
 * 使 super 的合法决策全部撞「申请已失效」;现改为送达回执(onDelivered)才起算。 */
  timeoutMs?: number;
 /** **送达前**的排队等待上限毫秒(兜底:super 通道长期忙也不许静默挂起;
 * env GENIE_SUPER_APPROVAL_QUEUE_TIMEOUT_MS 优先)。 */
  queueTimeoutMs?: number;
}

export const DEFAULT_SUPER_APPROVAL_TIMEOUT_MS = 120_000;
/** 排队等待上限缺省 5min:super 单轮经验证 40~121s,4 条申请成串排队时经验证 163s 仍未送达,
 * 故排队窗须显著大于单轮耗时;超过它即升级转用户(不静默挂起)。 */
export const DEFAULT_SUPER_APPROVAL_QUEUE_TIMEOUT_MS = 5 * 60_000;

function envMs(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = Number(env[key]);
  if (Number.isFinite(raw) && raw >= 1_000) return Math.min(Math.trunc(raw), 30 * 60_000);
  return fallback;
}

export function superApprovalTimeoutMs(env = process.env): number {
  return envMs(env, "GENIE_SUPER_APPROVAL_TIMEOUT_MS", DEFAULT_SUPER_APPROVAL_TIMEOUT_MS);
}

export function superApprovalQueueTimeoutMs(env = process.env): number {
  return envMs(env, "GENIE_SUPER_APPROVAL_QUEUE_TIMEOUT_MS", DEFAULT_SUPER_APPROVAL_QUEUE_TIMEOUT_MS);
}

function clip(s: unknown, n: number): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

/** 任务短标(便于人读留痕)。 */
function taskTag(input: SuperApprovalTarget): string {
  return input.taskId ? input.taskId.slice(0, 8) : input.sessionId.slice(0, 12);
}

export class SuperApprovalRouter {
  private pending = new Map<string, PendingApproval>();
 /** 最近决议(内存 ring,重启即失;journal 才是持久真源)。 */
  recent: SuperApprovalHistoryItem[] = [];

  constructor(private readonly deps: SuperApprovalRouterDeps) {}

 /** 发起自决:挂起 -> 排队送 super -> 决定、排队超时、送达后超时、异常四路收敛。
 * 计时拆两段——排队窗(queueTimeoutMs,起于入队)与决策窗(timeoutMs,起于送达回执),
 * 修经验证根因:super 串行队列排队 70~163s 曾整段吃掉 120s 决策窗。 */
  ask(input: SuperApprovalTarget): Promise<PermissionOutcome> {
    const timeoutMs = this.deps.timeoutMs ?? superApprovalTimeoutMs();
    const queueTimeoutMs = this.deps.queueTimeoutMs ?? superApprovalQueueTimeoutMs();
    return new Promise<PermissionOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let queueTimer: NodeJS.Timeout | undefined;
      let rec!: PendingApproval;
      const finish = (outcome: PermissionOutcome, note?: string) => {
        if (!rec || rec.done) return;
        rec.done = true;
        if (timer) clearTimeout(timer);
        if (queueTimer) clearTimeout(queueTimer);
        if (this.pending.get(input.requestId) === rec) this.pending.delete(input.requestId);
        this.recent.push({
          requestId: input.requestId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          tool: input.tool,
          summary: clip(input.summary, 160),
          decision: outcome.decision,
          by: outcome.by,
          since: rec.since,
          settledAt: Date.now(),
          note: note ?? "",
        });
        if (this.recent.length > 100) this.recent.splice(0, this.recent.length - 100);
        resolve(outcome);
      };
      rec = { input, since: Date.now(), done: false, finish };
      this.pending.set(input.requestId, rec);
      this.notice(`[super 审批] 任务 ${taskTag(input)} 申请 ${input.tool}:${clip(input.summary, 80)}(等待 super 自决)[rid=${input.requestId}]`, input.taskId);
 // 排队窗:只兜底「通道长期忙」,到期即升级转用户(不静默挂起)。
      queueTimer = setTimeout(() => { void this.escalate(input, `排队 ${Math.max(1, Math.round(queueTimeoutMs / 1000))}s 仍未送达 super(通道忙)`); }, queueTimeoutMs);
      queueTimer.unref?.();
 // 送达回执:通道在轮次真正开始前调用。返回 false=排队期间已失效(已升级/已决),通道应跳过本申请。
      const onDelivered = (): boolean => {
        const cur = this.pending.get(input.requestId);
        if (!cur || cur.done) return false;
        cur.deliveredAt = Date.now();
        if (queueTimer) clearTimeout(queueTimer);
        timer = setTimeout(() => { void this.escalate(input, `超过 ${Math.max(1, Math.round(timeoutMs / 1000))}s 未决(已送达 super)`); }, timeoutMs);
        timer.unref?.();
        return true;
      };
 // 排队送 super:resolve=该轮结束。轮次结束仍未决、抛错 -> 升级转用户(不静默)。
      void this.deps.askSuper(input, onDelivered).then(() => {
        if (this.pending.has(input.requestId)) void this.escalate(input, "super 未给出决定");
      }).catch((err) => {
        if (this.pending.has(input.requestId)) void this.escalate(input, `super 轮次异常:${clip(String(err), 80)}`);
      });
    });
  }

 /** super 工具 permission_decide 的落点:allow-once、reject、escalate。 */
  decide(requestId: string, decision: SuperApprovalDecision, reason?: string): { ok: boolean; error?: string } {
    const rec = this.pending.get(requestId);
    if (!rec || rec.done) {
 // 失效也要说清去向(排障面:4 条经验证申请全是「超时升级」而非「已决」)。
      const prev = [...this.recent].reverse().find((r) => r.requestId === requestId);
      const where = prev ? `已由「${prev.by}」结算${prev.note ? `:${prev.note}` : ""}` : "未登记或已决";
      return { ok: false, error: `申请已失效(${where}):${requestId}` };
    }
    const why = clip(reason, 300);
    if (decision === "escalate") {
      void this.escalate(rec.input, why ? `super 主动升级:${why}` : "super 主动升级");
      return { ok: true };
    }
    this.trace(rec.input, decision === "allow-once" ? "allowed" : "denied", decision === "allow-once" ? "super-approved" : "super-denied", why);
    rec.finish({ decision, by: "super" }, why);
    return { ok: true };
  }

 /** 挂起中的申请(旧者在前;审计与测试用)。 */
  pendingList(): { requestId: string; taskId?: string; tool: string; summary: string; since: number }[] {
    return [...this.pending.values()]
      .filter((p) => !p.done)
      .map((p) => ({ requestId: p.input.requestId, ...(p.input.taskId ? { taskId: p.input.taskId } : {}), tool: p.input.tool, summary: p.input.summary, since: p.since }))
      .sort((a, b) => a.since - b.since);
  }

 /**
 * 兜底升级:超时、super 未决、轮次异常 -> 转用户,摘要明确标注「super 未决」。
 * 不论用户侧如何收敛(批准/拒绝/离线),都以 super-escalated-user 留痕,任务不静默挂起。
 */
  private async escalate(input: SuperApprovalTarget, why: string): Promise<void> {
    const rec = this.pending.get(input.requestId);
    if (!rec || rec.done) return;
    this.pending.delete(input.requestId);
    this.trace(input, "escalated", "super-escalated-user", why);
    this.notice(`[super 未决] 权限申请 ${input.tool} 已升级给用户(${why})`, input.taskId);
    let out: PermissionOutcome;
    try {
      out = await this.deps.escalate({ ...input, summary: `[super 未决] ${input.summary}` });
    } catch {
      out = { decision: "reject", by: "super-error" };
    }
    const settled: PermissionOutcome = { decision: out.decision, by: "super-escalated-user" };
    try {
      this.deps.journal.append({
        kind: "permission.gate",
        sessionId: input.sessionId,
        payload: {
          tool: input.tool,
          effect: settled.decision === "allow-once" ? "allowed" : "denied",
          by: settled.by,
          requestId: input.requestId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          reason: `${why};用户侧=${out.by}`,
        },
      });
    } catch { /* 留痕失败不碰主链 */ }
    rec.finish(settled, `${why};用户侧=${out.by}`);
  }

 /** 指挥台留痕:journal super.notice(持久,super.history 回放与下一轮系统注入同源)+ 实时广播。 */
  private notice(text: string, taskId?: string): void {
    try {
      this.deps.journal.append({
        kind: "super.notice",
        sessionId: "super",
        payload: { text, ...(taskId ? { taskId } : {}), state: "permission" },
      });
    } catch { /* 留痕失败不碰主链 */ }
    this.deps.notify?.(text, { ...(taskId ? { taskId } : {}), state: "permission" });
  }

 /** journal + 任务会话 message.system + 广播 三处留痕。 */
  private trace(input: SuperApprovalTarget, effect: "allowed" | "denied" | "escalated", by: string, reason?: string): void {
    const why = clip(reason, 300);
    try {
      this.deps.journal.append({
        kind: "permission.gate",
        sessionId: input.sessionId,
        payload: {
          tool: input.tool,
          effect,
          by,
          requestId: input.requestId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(why ? { reason: why } : {}),
        },
      });
    } catch { /* 留痕失败不碰主链 */ }
    if (effect === "escalated") return; // 升级提示由 notify 的「super 未决」承担
    const verdict = effect === "allowed" ? "已批准" : "已拒绝";
    const text = `[super 审批] 任务 ${taskTag(input)} ${verdict} ${input.tool}(${clip(input.summary, 120)})${why ? `,理由:${why}` : ""}`;
    try {
 // message.system 回灌任务会话:面板可回放、模型下一轮可见(与「重操作审批」同机制)。
      this.deps.journal.append({ kind: "message.system", sessionId: input.sessionId, payload: { text } });
    } catch { /* 留痕失败不碰主链 */ }
    this.notice(text, input.taskId);
  }
}
