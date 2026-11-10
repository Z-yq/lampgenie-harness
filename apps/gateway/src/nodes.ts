/** 节点注册表:register/heartbeat/失联检测。 */
export interface NodeInfo {
  nodeId: string;
  capabilities: string[];
  reachability: string[];
  load: { cpu: number; mem: number; runningTasks: number };
  lastHeartbeat: number;
}

export class NodeRegistry {
  private nodes = new Map<string, NodeInfo>();
  /** 失联判定阈值(默认 60s,待标定)。 */
  staleMs = 60_000;

  register(info: Omit<NodeInfo, "lastHeartbeat" | "load">): NodeInfo {
    const node: NodeInfo = { ...info, load: { cpu: 0, mem: 0, runningTasks: 0 }, lastHeartbeat: Date.now() };
    this.nodes.set(node.nodeId, node);
    return node;
  }

  heartbeat(nodeId: string, load: NodeInfo["load"]): boolean {
    const n = this.nodes.get(nodeId);
    if (!n) return false;
    n.lastHeartbeat = Date.now();
    n.load = load;
    return true;
  }

  list(): NodeInfo[] {
    return [...this.nodes.values()];
  }

  /** 在线节点(心跳未失联)。 */
  online(): NodeInfo[] {
    const now = Date.now();
    return this.list().filter((n) => now - n.lastHeartbeat <= this.staleMs);
  }

  /** 可达性分派(designs/09 §4):requirements 全满足的在线节点,负载最低优先。
   *  step-1042:requirements.nodeId 给定时精确钉选该节点(仍须在线)——node.exec「对指定节点下发」用。 */
  dispatch(requirements: { capabilities?: string[]; reachability?: string[]; nodeId?: string }): NodeInfo | null {
    const candidates = this.online().filter((n) => {
      if (requirements.nodeId !== undefined && n.nodeId !== requirements.nodeId) return false;
      const capOk = (requirements.capabilities ?? []).every((c) => n.capabilities.includes(c));
      const reachOk = (requirements.reachability ?? []).every((r) => n.reachability.includes(r));
      return capOk && reachOk;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.load.runningTasks - b.load.runningTasks);
    return candidates[0]!;
  }
}

/**
 * 分派守卫(R5-C11 修复:把 dispatch 从死代码接进两条执行路径):
 * 带 reachability/capabilities 要求的任务必须命中在线节点,否则显式失败;
 * 无要求直通(单机默认);命中时返回解释(调用方落 journal)。
 * 一期单机形态:本机注册为 local 节点(app.ts),跨节点真执行在 node-agent 二期。
 */
export function dispatchGuard(
  nodes: NodeRegistry,
  requirements: { capabilities?: string[]; reachability?: string[] },
): { ok: true; node: NodeInfo | null; note?: string } | { ok: false; reason: string } {
  const caps = requirements.capabilities ?? [];
  const reach = requirements.reachability ?? [];
  if (caps.length === 0 && reach.length === 0) return { ok: true, node: null };
  const node = nodes.dispatch({ capabilities: caps, reachability: reach });
  if (!node) {
    const online = nodes.online()
      .map((n) => `${n.nodeId}(${[...n.capabilities, ...n.reachability].join(",") || "无标签"})`);
    return {
      ok: false,
      reason: `无可达节点:需要 capabilities=[${caps.join(",")}] reachability=[${reach.join(",")}];在线节点: ${online.join("; ") || "(无)"}`,
    };
  }
  return {
    ok: true,
    node,
    note: `分派至节点 ${node.nodeId}(硬门通过:cap/reach 全满足,负载 runningTasks=${node.load.runningTasks})`,
  };
}

// ---- step-033:委派通道与失联重派(designs/09 §4) ----

/** nodeId → ws 连接表(node.register 时登记,断开即除名)。 */
export class NodeConnections {
  private conns = new Map<string, { send: (raw: string) => void }>();

  register(nodeId: string, send: (raw: string) => void): void {
    this.conns.set(nodeId, { send });
  }

  drop(nodeId: string): void {
    this.conns.delete(nodeId);
  }

  has(nodeId: string): boolean {
    return this.conns.has(nodeId);
  }

  send(nodeId: string, raw: string): boolean {
    const c = this.conns.get(nodeId);
    if (!c) return false;
    try {
      c.send(raw);
      return true;
    } catch {
      return false;
    }
  }
}

export interface DelegateSpec {
  taskId: string;
  instruction: string;
  /** 凭证引用名——值永不在 gateway 侧出现(红线,designs/09 §4)。 */
  credentialRef?: string;
  /** 任务已累积的委派深度:网关原生任务=0;已是节点回流的委派任务=1(再委派即机制拒绝)。 */
  delegatedDepth?: number;
}

export interface DelegateResult {
  ok: boolean;
  output?: string;
  error?: string;
}

/**
 * tunnel 委派:任务书经 WS 下发远端节点代执行,结果回流。
 * 机制红线:①委派深度≤1(已委派任务不再委派);②失联扫描面(staleAssignments)供重派;
 * ③凭证只传引用名。
 */
export class NodeDispatch {
  private pending = new Map<string, { nodeId: string; resolve: (r: DelegateResult) => void; timer: NodeJS.Timeout }>();
  private assignments = new Map<string, { nodeId: string; spec: DelegateSpec; sessionId: string }>();

  constructor(
    private readonly nodes: NodeRegistry,
    private readonly connections: NodeConnections,
    private readonly timeoutMs = 120_000,
  ) {}

  /** 委派(已在委派链上的任务再委派=机制拒绝;按硬门要求选节点;发送失败=显式失败,不假装已派)。
   *  step-1042:requirements.nodeId 支持精确钉选(node.exec「对指定节点下发」);仍拒绝 local(本机走任务链)。 */
  delegate(
    spec: DelegateSpec,
    sessionId: string,
    requirements: { capabilities?: string[]; reachability?: string[]; nodeId?: string } = {},
  ): Promise<DelegateResult> {
    if ((spec.delegatedDepth ?? 0) >= 1) {
      return Promise.resolve({ ok: false, error: "委派深度>1 被拒(机制拒绝,designs/09 §4:节点不可再委派)" });
    }
    const picked = this.nodes.dispatch(requirements);
    const node = picked && picked.nodeId !== "local" && this.connections.has(picked.nodeId) ? picked : null;
    if (!node) {
      return Promise.resolve({ ok: false, error: "无可委派节点(硬门通过且 node-agent 已连接的节点不存在)" });
    }
    return new Promise((resolve) => {
      const sent = this.connections.send(node.nodeId, JSON.stringify({
        v: 1,
        type: "node.task.dispatch",
        taskId: spec.taskId,
        instruction: spec.instruction,
        ...(spec.credentialRef ? { credentialRef: spec.credentialRef } : {}),
        delegatedDepth: 1, // 下发即第 1 跳;节点侧执行不回委(无委派代码路径)=机制保证
      }));
      if (!sent) {
        resolve({ ok: false, error: `委派发送失败(节点 ${node.nodeId} 连接不可写)` });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(spec.taskId);
        this.assignments.delete(spec.taskId);
        resolve({ ok: false, error: `委派超时(${this.timeoutMs}ms,节点 ${node.nodeId})` });
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(spec.taskId, { nodeId: node.nodeId, resolve, timer });
      this.assignments.set(spec.taskId, { nodeId: node.nodeId, spec, sessionId });
    });
  }

  /** 节点结果回流。 */
  handleResult(msg: { nodeId: string; taskId: string; ok: boolean; output?: string; error?: string }): boolean {
    const p = this.pending.get(msg.taskId);
    if (!p || p.nodeId !== msg.nodeId) return false;
    clearTimeout(p.timer);
    this.pending.delete(msg.taskId);
    this.assignments.delete(msg.taskId);
    p.resolve({ ok: msg.ok, output: msg.output, error: msg.error });
    return true;
  }

  /** 失联扫描:已委派但节点已 stale 的任务(重派输入面)。 */
  staleAssignments(): { taskId: string; nodeId: string; spec: DelegateSpec; sessionId: string }[] {
    const out: { taskId: string; nodeId: string; spec: DelegateSpec; sessionId: string }[] = [];
    const onlineIds = new Set(this.nodes.online().map((n) => n.nodeId));
    for (const [taskId, a] of this.assignments) {
      if (!onlineIds.has(a.nodeId)) out.push({ taskId, ...a });
    }
    return out;
  }

  /** 放弃一个任务的重派资格(终态清理)。 */
  forget(taskId: string): void {
    const p = this.pending.get(taskId);
    if (p) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "cancelled" });
    }
    this.pending.delete(taskId);
    this.assignments.delete(taskId);
  }
}
