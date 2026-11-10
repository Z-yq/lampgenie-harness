/**
 * turn 显示序号派生(Trace 看板「永远 Turn 1」修复)。
 * journal 里 payload.turn 来自 AgentLoop 模块静态计数器,每个任务/子进程都从 1 起,
 * 同一会话多次任务提交会重复出现 turn:1,跨任务不可比;
 * 看板需要的「会话内第几轮」必须按 turn.start 出现序派生,不信 payload。
 */
export interface TurnNoEvent {
  kind: string;
  sessionId: string;
}

/** 会话内 turn 序号计数器:每次 turn.start 调 next,各 sessionId 独立 1,2,3… 递增。 */
export class TurnNoCounter {
  private readonly bySid = new Map<string, number>();

  next(sessionId: string): number {
    const n = (this.bySid.get(sessionId) ?? 0) + 1;
    this.bySid.set(sessionId, n);
    return n;
  }
}
