/**
 * 会话最近活动时间索引(J4,2026-11-05 用户口径:「排序要按 session 有动作更新时间」)。
 *
 * 病灶:侧栏会话行的时间与排序键都取 Task.updatedAt,而 Task.updatedAt 只在两处写
 * (submit 建档 task-manager.ts:79 / 状态迁移 task.ts:83)——会话里发消息、跑工具、改白板、
 * 提交 IDE 改动都不刷新它。于是「一直在干活但最近没有状态迁移」的会话被压到分页外,
 * 用户感知为「时不时漏掉最近的执行 session」。
 *
 * 本模块只做一件事:sid → 最近一次「用户可见动作」的 journal 事件时间(ms),给侧栏排序/行时间用。
 * 不改 Task.updatedAt 语义(历史时间戳是事实),也不新增广播帧(复用 session.status.changed 的
 * 200ms per-session 合并,帧内带 lastActivityAt)。
 *
 * 口径(为何是白名单而非黑名单):流式噪声事件(llm.trace/tool.tokens/step.*\/turn.*\/sense.*)
 * 每步都在落账,若一律算活动,运行中的会话时间会随每一帧抖动且排序反复跳变(panel.ts runFirstCmp
 * 注释已有同一教训);故只认「人能看到结果的动作」。
 */

/** 计入会话活动的 journal 事件种类(用户可见动作白名单)。 */
export const SESSION_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  // 会话/消息
  "session.start",
  "message.user",
  "message.agent",
  "message.system",
  // 工具
  "tool.call",
  "tool.result",
  // 任务状态(与侧栏状态点同源)
  "task.enqueue",
  "task.start",
  "task.progress",
  "task.done",
  "task.fail",
  // 白板 / 计划 / 待办
  "board.update",
  "board.audit",
  "board.skeleton",
  "plan.saved",
  "goal.set",
  "todo.updated",
  // 子代理 / 工作流 / 压缩(都是「会话里有产出」的动作)
  "subagent.spawn",
  "subagent.result",
  "workflow.run.start",
  "workflow.run.done",
  "compact.done",
  "checkpoint.create",
]);

/** 该 kind 是否算一次会话活动(纯函数;测试直接断言白名单口径)。 */
export function isSessionActivityKind(kind: string): boolean {
  return SESSION_ACTIVITY_KINDS.has(kind);
}

/** 事件的最小形状(只读需要的三键,不依赖 @lampgenie/core 类型,便于单测构造)。 */
export interface ActivityEventLike {
  kind: string;
  sessionId?: string;
  time?: number;
}

/** sid → 最近活动时间。写入单调(旧时间不覆盖新时间);无 sessionId 的事件忽略。 */
export class SessionActivityIndex {
  private map = new Map<string, number>();

  /** 记录一次活动;返回该会话当前活动时间。 */
  note(sessionId: string | undefined, at: number | undefined): number | undefined {
    if (!sessionId) return undefined;
    const t = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : Date.now();
    const prev = this.map.get(sessionId) ?? 0;
    if (t > prev) this.map.set(sessionId, t);
    return this.map.get(sessionId);
  }

  /** 按 kind 白名单喂一条事件(运行期 journal.subscribe 与启动回放共用)。 */
  noteEvent(ev: ActivityEventLike): number | undefined {
    if (!isSessionActivityKind(ev.kind)) return undefined;
    return this.note(ev.sessionId, ev.time);
  }

  /** 批量回放(启动时复用既有 readAll 的同一遍扫描,不额外扫 journal)。返回命中会话数。 */
  seed(events: Iterable<ActivityEventLike>): number {
    for (const ev of events) this.noteEvent(ev);
    return this.map.size;
  }

  /** 取某会话最近活动时间(缺省 undefined=从未活动,排序回落 Task.updatedAt)。 */
  get(sessionId: string | undefined): number | undefined {
    return sessionId ? this.map.get(sessionId) : undefined;
  }

  /** 删除会话活动记录(会话删除/归档清空):同 sid 被复用时不得继承旧活动时间。 */
  forget(sessionId: string | undefined): void {
    if (sessionId) this.map.delete(sessionId);
  }

  size(): number {
    return this.map.size;
  }

  /** 下发快照(hello 首帧用):独立字段,不污染 TaskIndex。 */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sid, at] of this.map) out[sid] = at;
    return out;
  }
}

/**
 * 面板侧排序/展示口径(与 panel.ts 的 actOf 同源,单测直接对着它断言):
 * 会话时间 = max(会话最近活动时间, 任务 updatedAt, 任务 createdAt)。
 * 缺失活动时间时逐字回落旧行为(Task.updatedAt),老客户端/帧未到也不会排错。
 */
export function sessionSortTime(
  task: { sessionId?: string; updatedAt?: number; createdAt?: number } | undefined | null,
  activity: Map<string, number> | undefined,
): number {
  if (!task) return 0;
  const act = activity && task.sessionId ? activity.get(task.sessionId) ?? 0 : 0;
  return Math.max(act, task.updatedAt ?? 0, task.createdAt ?? 0);
}
