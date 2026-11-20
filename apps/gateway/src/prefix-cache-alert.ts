/**
 * 前缀缓存命中率告警落账 + 去重( §4.6.2 缺口2 闭环。
 * 判定本身在 `@lampgenie/runtime/agent/prefix-cache-health`(纯函数);这里只负责
 * 「把不达标变成可观测的告警」:面板 2s 一拍地拉 trace.stats,每条都落事件会刷满 journal,
 * 所以按会话记住已告警的严重度,只在**升级**(ok→warn→block)时落一条 `prefix.cache.warn`。
 * 只写观测事件,不参与请求装配——请求前缀字节零影响。
 */
import type { Journal } from "@lampgenie/core";

/** 与 runtime 判定模块的 verdict 同名;用宽松 string 收,避免跨包类型耦合。 */
export interface PrefixCacheAlertHealth {
  verdict: string;
  hitRate?: number;
  localHitRate?: number;
  target: number;
  block: number;
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  reason: string;
}

/** 严重度序:insufficient 不算劣化(样本不足时不该打扰)。 */
export const PREFIX_ALERT_RANK: Record<string, number> = { insufficient: -1, ok: 0, warn: 1, block: 2 };

const alerts = new Map<string, { rank: number; calls: number }>();
const MAX_TRACKED_SESSIONS = 256;

/** 测试用:清空去重水位(生产路径不需要)。 */
export function resetPrefixCacheAlerts(): void {
  alerts.clear();
}

/**
 * 按会话去重地落一条命中率告警。
 * @returns true=本次真的落了事件(false=达标/样本不足/未升级/无 journal)。
 */
export function notePrefixCacheHealth(
  sessionId: string,
  health: PrefixCacheAlertHealth,
  journal: Pick<Journal, "append"> | undefined,
  extra?: Record<string, unknown>,
): boolean {
  const rank = PREFIX_ALERT_RANK[health.verdict] ?? -1;
  const prev = alerts.get(sessionId);
  if (rank <= 0) {
 // 达标/样本不足不告警;达标时把水位归零,允许下一次劣化重新告警一次。
    if (rank === 0) alerts.set(sessionId, { rank: 0, calls: health.calls });
    return false;
  }
  if (prev && prev.rank >= rank) return false;
  if (alerts.size > MAX_TRACKED_SESSIONS && !alerts.has(sessionId)) {
    const oldest = alerts.keys().next().value;
    if (oldest !== undefined) alerts.delete(oldest);
  }
  alerts.set(sessionId, { rank, calls: health.calls });
  if (!journal) return false;
  try {
    journal.append({ kind: "prefix.cache.warn", sessionId, payload: { ...health, ...(extra ?? {}) } });
    return true;
  } catch {
    return false; // 遥测落账失败不打断主链
  }
}