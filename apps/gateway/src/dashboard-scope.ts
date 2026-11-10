/**
 * 运行看板作用域(参考项目 dashboard/workspaces 的本地对应物):
 * 参考项目的 workspace(用户域/项目域/未归属)对应我们的项目注册表。
 * 机制适配:
 *  - ref 用 dataHome/anchor/worktree 推项目归属;我们直接用任务事件携带的 projectId
 *    (sessionProjectOwners,首条带 projectId 的 task.* 事件定主,后续非空才改判);
 *  - 「未归属」桶只在确有无主会话时出现(ref PR #604 review #3 同语义)。
 */
import type { JournalEvent } from "@lampgenie/core";
import { sessionProjectOwners } from "./dashboard-collector.js";

export const UNASSIGNED_SCOPE = "unassigned";

export interface DashScope {
  id: string;
  label: string;
  kind: "all" | "project" | "unassigned";
}

/** 看板作用域清单:全部 + 有会话的项目 + 未归属(仅当存在无主会话)。 */
export function dashboardScopes(events: JournalEvent[], projects: { id: string; label: string }[]): DashScope[] {
  const owners = sessionProjectOwners(events);
  const used = new Set<string>();
  let unassigned = false;
  for (const sid of new Set(events.map((e) => e.sessionId))) {
    const pid = owners.get(sid) ?? null;
    if (pid) used.add(pid);
    else unassigned = true;
  }
  const result: DashScope[] = [{ id: "all", label: "全部", kind: "all" }];
  for (const p of projects) {
    if (used.has(p.id)) result.push({ id: p.id, label: p.label, kind: "project" });
  }
  if (unassigned) result.push({ id: UNASSIGNED_SCOPE, label: "未归属", kind: "unassigned" });
  return result;
}

/** 按作用域过滤事件('all'=全量;projectId=归属该项目的会话;unassigned=无主会话)。 */
export function eventsForScope(events: JournalEvent[], scopeId: string | null | undefined): JournalEvent[] {
  if (!scopeId || scopeId === "all") return events;
  const owners = sessionProjectOwners(events);
  return events.filter((ev) => {
    const owner = owners.get(ev.sessionId) ?? null;
    return scopeId === UNASSIGNED_SCOPE ? owner === null : owner === scopeId;
  });
}
