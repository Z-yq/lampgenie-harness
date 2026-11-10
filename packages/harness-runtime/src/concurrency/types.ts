// 并发协调器的对账事件(本仓自有词汇;「AIMD 治理 provider 配额」的问题设定
// 参考 ZCode 项目的 dynamic-workflow,致谢)。

/** 进程级并发 cap 变化的原因。 */
export type ConcurrencyShiftReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset";

/** 协调器对某 provider key 的 cap 调整(按 run 广播,可落 journal 解释「这个 run 为什么慢了」)。 */
export interface ConcurrencyShift {
  /** provider key(`${providerId}/${modelId}`)。 */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyShiftReason;
  lastGood?: number;
  lastBad?: number;
  cooldownMs?: number;
}
