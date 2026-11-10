/**
 * 模型请求准入契约(本仓自有词汇;协调器只需要四面:Route/Ticket/Admission/LifecycleEvent)。
 * 「driver 侧取票→事件回流→结算」的准入模型设计参考 ZCode 项目(致谢),接口形状与命名为本仓独立定义。
 */

export interface ModelRoute {
  providerId: string;
  modelId: string;
}

export interface AdmissionTicket extends ModelEventSink {
  /** 幂等;尝试无论如何结束都在 finally 调一次。 */
  release(): void;
}

export interface RequestAdmission {
  /** 同步快路径:闸门开且无人排队即给票;否则 undefined。 */
  tryTake?(input: { model: ModelRoute }): AdmissionTicket | undefined;
  take(input: {
    model: ModelRoute;
    signal?: AbortSignal;
  }): Promise<AdmissionTicket>;
}

export interface ModelEventSink {
  emit(event: ModelLifecycleEvent): void | Promise<void>;
  emitFailure?(event: ModelFailedEvent, error: unknown): void | Promise<void>;
}

interface ModelLifecycleBase {
  type: string;
  at?: number;
}

export interface ModelQueuedEvent extends ModelLifecycleBase {
  type: "model_request_queued";
}
export interface ModelAdmittedEvent extends ModelLifecycleBase {
  type: "model_request_admitted";
}
export interface ModelStartedEvent extends ModelLifecycleBase {
  type: "model_request_started";
}
export interface ModelCompletedEvent extends ModelLifecycleBase {
  type: "model_request_completed";
}
export interface ModelFailedEvent extends ModelLifecycleBase {
  type: "model_request_failed";
  /** 稳定机器可路由的失败类(如 rate_limited);路由用它,不解析 message。 */
  code?: string;
  reason?: string;
  retryAfterMs?: number;
  /** quota 终态:额度恢复时间(毫秒时间戳),面板据此展示「预计可用时间」。 */
  resetAt?: number;
  /** true 时紧随一条 retry_scheduled,那条才是信号。 */
  retryable?: boolean;
}
export interface ModelRetryEvent extends ModelLifecycleBase {
  type: "model_retry_scheduled";
  reason: string;
  retryAfterMs?: number;
  delayMs?: number;
}
export interface ModelStreamStalledEvent extends ModelLifecycleBase {
  type: "model_stream_stalled";
}

export type ModelLifecycleEvent =
  | ModelQueuedEvent
  | ModelAdmittedEvent
  | ModelStartedEvent
  | ModelCompletedEvent
  | ModelFailedEvent
  | ModelRetryEvent
  | ModelStreamStalledEvent;
