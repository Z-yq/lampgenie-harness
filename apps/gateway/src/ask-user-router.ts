/**
 * ask_user 面板问答(2026-10-19 许愿式编程):主 agent 在**需求有取舍/范围可能膨胀**时
 * 主动向用户发问并阻塞等待答复,用户拍板后再行动——「不确定就 ask,别猜」。
 * 与 WorkflowAskRouter 同构(广播问题→挂起→面板直答→resolve;超时/无面板=null)。
 * 有界:工具侧 Promise.race 兜底,离线(无面板)立即返回 null 由 agent 按最合理推断继续,
 * 绝不静默卡死任务。
 */
export interface AskUserPayload {
  question: string;
  options?: string[];
  context?: string;
}

export class AskUserRouter {
  private waiting = new Map<string, { resolve: (v: string | null) => void; timer: NodeJS.Timeout; question: string; options?: string[]; sessionId: string; since: number }>();
  /** 面板在线性(server 注入)。 */
  online = false;
  /** 双通道:提问广播时的指挥台转接钩子(app.ts 注入 SuperAgentChannel.relayAsk)。
   * 转述归 super agent,答复仍走 answer()(先答先用:面板 askBar 与 relay_answer 任一先答即生效)。 */
  onAsk?: (payload: { requestId: string; sessionId: string; question: string; options?: string[]; context?: string }) => void;

  constructor(
    private readonly broadcast: (msg: Record<string, unknown>) => void,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  /** step-1033:指挥台 inbox 的 ask 数据源(挂起中的提问,旧者在前)。 */
  pending(): { requestId: string; sessionId: string; question: string; options?: string[]; since: number }[] {
    return [...this.waiting.entries()]
      .map(([requestId, p]) => ({ requestId, sessionId: p.sessionId, question: p.question, ...(p.options?.length ? { options: p.options } : {}), since: p.since }))
      .sort((a, b) => a.since - b.since);
  }

  ask(sessionId: string, payload: AskUserPayload): Promise<string | null> {
    if (!this.online) return Promise.resolve(null);
    const requestId = `ask-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const question = String(payload.question || "").slice(0, 800);
    const options = (payload.options || []).slice(0, 6).map((o) => String(o).slice(0, 200));
    return new Promise((resolve) => {
      const settle = (v: string | null) => {
        const p = this.waiting.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        this.waiting.delete(requestId);
        resolve(v);
      };
      this.waiting.set(requestId, {
        resolve: settle, timer: setTimeout(() => settle(null), this.timeoutMs),
        question, sessionId, since: Date.now(), ...(options.length ? { options } : {}),
      });
      this.broadcast({
        v: 1, type: "ask.user", requestId, sessionId,
        question,
        options,
        context: String(payload.context || "").slice(0, 1200),
        timeoutMs: this.timeoutMs,
      });
      // 同一问题同时推给指挥台(super agent 转述/文本可答;未活跃只留痕不触发轮次)。
      try {
        this.onAsk?.({
          requestId, sessionId,
          question,
          options,
          context: String(payload.context || "").slice(0, 1200) || undefined,
        });
      } catch { /* 转接故障不碰 ask 主链 */ }
    });
  }

  answer(requestId: string, value: string): boolean {
    const p = this.waiting.get(requestId);
    if (!p) return false;
    p.resolve(value);
    return true;
  }
}
