/**
 * F6 workflow ask 面板应答(ZCode WorkflowRunPendingQuestion 面板直答的等价):
 * engine dispatch 前,先把问题广播给面板,等待直答;超时/无面板回退 executor dispatch。
 * journal-first 语义不变:engine 侧 ask 落盘照旧,直答只替代 dispatch 的执行方。
 */
export class WorkflowAskRouter {
  private pending = new Map<string, { resolve: (v: string) => void; timer: NodeJS.Timeout }>();
  /** 面板在线性(server 注入;离线=直接走 executor,不广播不等待)。 */
  online = false;

  constructor(
    private readonly broadcast: (msg: Record<string, unknown>) => void,
    private readonly timeoutMs = 90_000) {}

  /** 询问:面板在线→广播+挂起等待直答;离线→null(调用方回退 executor)。 */
  ask(wfId: string, cacheKey: string, instructions: string): Promise<string | null> {
    if (!this.online) return Promise.resolve(null);
    return new Promise((resolve) => {
      const settle = (v: string | null) => {
        const p = this.pending.get(cacheKey);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(cacheKey);
        resolve(v);
      };
      this.pending.set(cacheKey, {
        resolve: settle,
        timer: setTimeout(() => settle(null), this.timeoutMs),
      });
      this.broadcast({ v: 1, type: "workflow.question", wfId, cacheKey, instructions: instructions.slice(0, 800), timeoutMs: this.timeoutMs });
    });
  }

  /** 面板直答。 */
  answer(cacheKey: string, value: string): boolean {
    const p = this.pending.get(cacheKey);
    if (!p) return false;
    p.resolve(value);
    return true;
  }
}
