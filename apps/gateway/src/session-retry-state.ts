/**
 * 重试/重连态跨会话保活(batch1b,照设计参考 ZCode(致谢) apiRetry 语义)。
 * 现状问题:模型请求失败重试(429/5xx/建连超时)的「重新连接中」状态此前只活在当前渲染里——
 * 面板切走会话再切回来就丢,用户以为任务卡死。这里在 gateway 侧按 sessionId 做**纯内存**镜像
 * (不落盘:临时运行时态,进程重启由下一次重试重新登记),session.status.result 快照装配时回填
 * apiRetry,面板据此恢复重试条。
 * 语义对齐(只读参考 ZCode/packages/services/src/zcode-session/zcodeSessionApiRetry.ts,
 * Apache-2.0,不 import):
 *  - attempt 从 1 起,maxRetries ≥ attempt;
 *  - **retry 开始不清旧态**(模型请求重新发起不等于已恢复,清早了会闪烁);
 *  - 首个模型进展才清(clearOnProgress);
 *  - 会话终态(done/failed/cancelled)清零(clearOnTerminal)。
 */
import type { ApiRetryStatus } from "@lampgenie/protocol";

/** sessionId → 当前重试态(有键=正在重试;无键=无重试态)。 */
const states = new Map<string, ApiRetryStatus>();

export interface ApiRetryBeginInput {
  /** 显式 attempt(缺省=上一次 +1,首次=1;不传即自动计数)。 */
  attempt?: number;
  /** 本次请求允许的重试上限(GENIE_LLM_RETRY,@see factory.ts providerFromRef)。 */
  maxRetries?: number;
  /** 下一次尝试前的退避(ms)。 */
  retryDelayMs?: number;
  /** 触发重试的 HTTP 状态(429/500…);网络层错误=null。 */
  errorStatus?: number | null;
  /** 人读原因(HTTP 500 / 建连超时…)。 */
  error?: string;
}

/** 重试开始(或又一次重试排期):登记/推进该会话的重试态。返回登记后的状态副本。 */
export function beginRetry(sessionId: string, input: ApiRetryBeginInput = {}): ApiRetryStatus {
  const prev = sessionId ? states.get(sessionId) : undefined;
  const attempt = Math.max(1, Math.floor(input.attempt ?? (prev?.attempt ?? 0) + 1));
  const maxRetries = Math.max(attempt, Math.floor(input.maxRetries ?? prev?.maxRetries ?? 0));
  const status: ApiRetryStatus = {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs: Math.max(0, Math.floor(input.retryDelayMs ?? prev?.retryDelayMs ?? 0)),
    errorStatus: input.errorStatus === undefined ? (prev?.errorStatus ?? null) : input.errorStatus,
    error: String(input.error ?? prev?.error ?? "model retry scheduled").slice(0, 200),
  };
  states.set(sessionId, status);
  return { ...status };
}

/** 首个模型进展(delta/token/成功完成)到达:重试已恢复,清态。无态时为空操作(幂等)。 */
export function clearOnProgress(sessionId: string): void {
  states.delete(sessionId);
}

/** 会话终态(done/failed/cancelled):重试态一律清零(snapshot 之后回包不再带 apiRetry)。 */
export function clearOnTerminal(sessionId: string): void {
  states.delete(sessionId);
}

/** 快照回填读:当前重试态副本(无=null;返回副本,调用方改不动镜像)。 */
export function snapshot(sessionId: string): ApiRetryStatus | null {
  const cur = sessionId ? states.get(sessionId) : undefined;
  return cur ? { ...cur } : null;
}

/** 测试隔离(仅测试用):清空镜像。 */
export function __resetForTest(): void {
  states.clear();
}
