/**
 *  用户停止标记。
 * 问题:用户点停止后,取消只改任务状态 + abort loop,journal 里没有任何「用户已停止」事实——
 * 冷恢复分不清「用户取消」与「普通失败/重启中断」,于是重启后会把用户主动停掉的任务
 * 当 interrupted 续跑,面板一键续跑也会复活它。
 * 方案:取消时落一条 journal custom(`payload.type="task.user_stopped"`),恢复/续跑入口读它。
 * - 写点唯一:agent-wiring 的 task.cancel (onChange state=cancelled 且有活跃 loop),
 *   **先落标记再 abort**(标记失败只告警,绝不改取消结果——取消是用户意图,不能被落账失败阻塞)。
 * - 读点:server.ts task.resume / app.ts resumeTask / 启动 restore / autoResumeInterrupted。
 * - 走通用 `custom` kind + payload.type:不新增 core 的 EventKind 联合成员,worker 子进程与
 *   存量 journal 全兼容(改 core 联合会牵动 protocol/journal schema 的版本面)。
 */
import type { Journal } from "@lampgenie/core";

/** payload.type 值(与 custom 事件同族:goal.continue / goal.blocked)。 */
export const USER_STOPPED_EVENT = "task.user_stopped";

export interface UserStoppedMarker {
  taskId: string;
  sessionId: string;
  at: number;
  /** 触发源(cancel=面板/WS 取消;dispatch-now=排队消息抢占)。 */
  source: string;
}

/** 落一条用户停止标记。失败只 warn(返回 false),调用方不得据此改变取消结果。 */
export function appendUserStoppedMarker(
  journal: Journal,
  input: { taskId: string; sessionId: string; source?: string; at?: number },
): boolean {
  const marker: UserStoppedMarker = {
    taskId: input.taskId,
    sessionId: input.sessionId,
    at: input.at ?? Date.now(),
    source: input.source ?? "cancel",
  };
  try {
    journal.append({ kind: "custom", sessionId: marker.sessionId, payload: { type: USER_STOPPED_EVENT, ...marker } });
    return true;
  } catch (err) {
    console.warn(`[user-stop] 停止标记落账失败(取消结果不变):${String(err).slice(0, 160)}`);
    return false;
  }
}

/** 读出会话内全部用户停止标记(at 升序)。 */
export function readUserStoppedMarkers(journal: Journal, sessionId: string): UserStoppedMarker[] {
  const out: UserStoppedMarker[] = [];
  for (const e of journal.readAll()) {
    if (e.sessionId !== sessionId || e.kind !== "custom") continue;
    const p = e.payload as Partial<UserStoppedMarker> & { type?: unknown } | undefined;
    if (!p || p.type !== USER_STOPPED_EVENT) continue;
    out.push({ taskId: String(p.taskId ?? ""), sessionId, at: typeof p.at === "number" ? p.at : e.time, source: String(p.source ?? "cancel") });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 该任务能否续跑: 口径=「本任务或本会话存在 at >= 任务 createdAt 的停止标记 → 不能」。
 * 取会话级(而非严格 taskId 级)是因为一个会话里用户停过一次之后,同会话早先那些任务的
 * 续跑同样不该再自动复活;`at >= createdAt` 保证「停完再提新任务」不受历史标记影响。
 */
export function hasUserStoppedSince(
  journal: Journal,
  input: { taskId: string; sessionId: string; since: number },
): UserStoppedMarker | undefined {
  return readUserStoppedMarkers(journal, input.sessionId).find((m) => m.at >= input.since);
}

/** 拒续跑的稳定文案(WS error.message 与 super 工具 reason 同源)。 */
export const USER_STOPPED_RESUME_MESSAGE = "用户已停止该任务,不自动/手动续跑;要继续请用户明确新指令";
/** 拒续跑的稳定错误码。 */
export const USER_STOPPED_RESUME_CODE = "task-stopped-by-user";
