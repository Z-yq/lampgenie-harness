/**
 * 团队周报聚合(designs/30 §1 #23 / §2.7;形状参照 teamai-cli digest,MIT,自有实现)。
 * 纯函数:只对已取到的 activity 事件做聚合,不读盘不联网。
 * 排序:count 降序 + key 字典序(稳定排序,便于断言与面板展示一致)。
 */
import type { ActivityEvent } from "@lampgenie/protocol";

export interface TeamActivityDigestResult {
  perMember: { userId: string; count: number }[];
  perCategory: { category: string; count: number }[];
  total: number;
}

/** 计数表 → 稳定有序数组:count 降序,同 count 按 key 字典序(统一 localeCompare)。 */
function rank(counts: Map<string, number>): { k: string; count: number }[] {
  return [...counts.entries()]
    .map(([k, count]) => ({ k, count }))
    .sort((a, b) => b.count - a.count || a.k.localeCompare(b.k));
}

/**
 * 按成员/类别聚合活动事件。
 * @param events 事件流(可含早于 sinceTs 的历史)
 * @param sinceTs 下限(含):只统计 ts >= sinceTs 的事件
 */
export function teamActivityDigest(events: ActivityEvent[], sinceTs: number): TeamActivityDigestResult {
  const members = new Map<string, number>();
  const categories = new Map<string, number>();
  let total = 0;
  for (const e of events) {
    if (!e || typeof e.ts !== "number" || e.ts < sinceTs) continue;
    total += 1;
    members.set(e.userId, (members.get(e.userId) ?? 0) + 1);
    categories.set(e.category, (categories.get(e.category) ?? 0) + 1);
  }
  return {
    perMember: rank(members).map((r) => ({ userId: r.k, count: r.count })),
    perCategory: rank(categories).map((r) => ({ category: r.k, count: r.count })),
    total,
  };
}
