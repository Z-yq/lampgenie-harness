/**
 * 事件总线:进程内的发布订阅。比 journal 轻——jounal 管「记什么」,
 * 这里管「谁要实时知道」。
 */

export type Handler<T = unknown> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on<T>(topic: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler as Handler);
    return () => this.off(topic, handler);
  }

  off<T>(topic: string, handler: Handler<T>): void {
    this.handlers.get(topic)?.delete(handler as Handler);
  }

  emit<T>(topic: string, payload: T): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        // 单个订阅者出错不影响其他订阅者。
        console.error(`[eventbus] handler for "${topic}" threw:`, err);
      }
    }
  }
}

/** 全局单例:gateway 进程内共享。 */
export const bus = new EventBus();
