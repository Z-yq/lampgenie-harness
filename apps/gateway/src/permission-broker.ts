/**
 * 权限审批中介( B2,ZCode PermissionDialog/interactionAutoResolution 移植):
 * executor 的 permission-ask 不再只有 auto-fail-closed——面板在线时广播征求用户,
 * 超时/无连接自动拒绝(fail-closed 不变);env GENIE_SUBAGENT_ASK=allow-once 优先级仍最高。
 * 会话级代答层:qwen permission-policy 组件接入——「本次会话总是允许」
 * (allow-always)除写 F2 规则文件外同时登记 policy,同会话后续 ask 免弹窗直通。
 */
export type PermissionDecision = "allow-once" | "reject";
/** 决策+来源(panel=面板应答;timeout=超时自动拒;offline=无面板连接;policy=会话级代答直通;
 * object-changed/object-snapshot-failed= 审批对象复核失败(fail-closed))。 */
export interface PermissionOutcome {
  decision: PermissionDecision;
  by: "panel" | "timeout" | "offline" | "policy" | "object-changed" | "object-snapshot-failed";
}

export interface PermissionAskInput {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  risk?: string;
  /** 会话级代答判定(qwen permission-policy 适配;缺省=不代答)。 */
  taskId?: string;
}

/** policy 窄口(只取 gateway 用得到的两面;适配 qwen TaskSupervisor 差异由装配方做)。 */
export interface PermissionPolicyPort {
  shouldAutoAllow(ownerId: string, sessionId: string, taskId?: string): boolean;
  applyDecision(ownerId: string, sessionId: string, decision: "always" | "task" | "reject", taskId?: string): () => void;
}

interface Pending {
  sessionId: string;
  resolve: (d: PermissionOutcome) => void;
  timer: NodeJS.Timeout;
 /** 审批中心列表面(二期):ask 全量信息驻留。 */
  tool: string;
  summary: string;
  risk: string;
  since: number;
}

/** 已决议记录(关卡 Gate 历史面):一次真实挂起(广播过)的收敛结果。 */
export interface PermissionHistoryItem {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  risk: string;
  since: number;
  settledAt: number;
  decision: PermissionDecision;
  by: PermissionOutcome["by"];
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();
  /** 面板在线性(server 连接时置位;无连接=立即 auto-fail-closed,与既有行为一致)。 */
  online = false;
 /** 会话级代答层:qwen permission-policy;未注入=旧行为。 */
  policy?: PermissionPolicyPort;

  private broadcastFn: (msg: Record<string, unknown>) => void = () => {};
 /** 决议回调(server 注入→广播 permission.resolved + super.inbox.changed;缺省=无)。 */
  onSettle?: (item: PermissionHistoryItem) => void;
 /** 最近决议 ring(内存,重启即失;只收真实挂起过=广播过的 ask;offline/policy 直通不入账)。 */
  recent: PermissionHistoryItem[] = [];

  constructor(private readonly timeoutMs = 60_000) {}

  /** server 侧注入广播通道(wss 创建后调用)。 */
  attach(broadcast: (msg: Record<string, unknown>) => void): void {
    this.broadcastFn = broadcast;
  }

  /** 发起审批:广播+挂起;应答/超时/取消 三路收敛。 */
  ask(input: PermissionAskInput): Promise<PermissionOutcome> {
    return new Promise((resolve) => {
      const settle = (outcome: PermissionOutcome) => {
        const p = this.pending.get(input.requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(input.requestId);
 // 入账历史 ring + 通知(server 用它广播 permission.resolved,多端一致清理)。
        const item: PermissionHistoryItem = {
          requestId: input.requestId, sessionId: p.sessionId, tool: p.tool, summary: p.summary,
          risk: p.risk, since: p.since, settledAt: Date.now(),
          decision: outcome.decision, by: outcome.by,
        };
        this.recent.push(item);
        if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50);
        try { this.onSettle?.(item); } catch { /* 回调失败不碰主链 */ }
        resolve(outcome);
      };
 // 会话级代答:policy 说本会话/任务已授予→不弹窗直通(来源如实标 policy)。
      if (this.policy?.shouldAutoAllow("local", input.sessionId, input.taskId)) {
        resolve({ decision: "allow-once", by: "policy" });
        return;
      }
      if (!this.online) {
        // 无面板连接:与旧 auto-fail-closed 同语义,不广播。
        resolve({ decision: "reject", by: "offline" });
        return;
      }
      this.pending.set(input.requestId, {
        sessionId: input.sessionId,
        resolve: settle,
        timer: setTimeout(() => settle({ decision: "reject", by: "timeout" }), this.timeoutMs),
        tool: input.tool,
        summary: input.summary,
        risk: input.risk ?? "medium",
        since: Date.now(),
      });
      this.broadcastFn({
        v: 1,
        type: "permission.ask",
        requestId: input.requestId,
        sessionId: input.sessionId,
        tool: input.tool,
        summary: input.summary,
        risk: input.risk ?? "medium",
        timeoutMs: this.timeoutMs,
      });
    });
  }

 /** 审批中心挂起清单(二期;旧者在前)。 */
  pendingList(): { requestId: string; sessionId: string; tool: string; summary: string; risk: string; since: number }[] {
    return [...this.pending.entries()]
      .map(([requestId, p]) => ({ requestId, sessionId: p.sessionId, tool: p.tool, summary: p.summary, risk: p.risk, since: p.since }))
      .sort((a, b) => a.since - b.since);
  }

 /** 最近决议(旧在前;limit 截尾)。 */
  history(limit = 20): PermissionHistoryItem[] {
    return this.recent.slice(-Math.max(1, Math.min(100, Math.trunc(limit) || 20)));
  }

  /** 挂起审批的会话 id(allow-always 双写 policy 用;无挂起=undefined)。 */
  sessionOf(requestId: string): string | undefined {
    return this.pending.get(requestId)?.sessionId;
  }

  /** 面板应答。 */
  respond(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve({ decision, by: "panel" });
    return true;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
