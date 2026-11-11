/**
 * (Issue↔Task 双向链接与终态回写):纯逻辑零 IO。
 * 这里只做「终态 → issue 变更计划」与「幂等键/事件形状」的判定,不碰 fs/网络;
 * 真写入由 issue-service 的 writeBackIssueTask 走通道既有 update/comment。
 * 红线:不 throw、不改入参、同输入必得同输出(确定性)。
 */

export const ISSUE_LINK_CODES = ["OK", "DUPLICATE", "NOT_FOUND", "INVALID"] as const;
export type IssueLinkCode = (typeof ISSUE_LINK_CODES)[number];

export type IssueLinkStatus = "todo" | "doing" | "done";

/** 终态回写的 task 状态(server 侧 task.state=done 映射为 completed)。 */
export type TerminalTaskState = "completed" | "failed" | "cancelled";

/** journal 事件的最小结构面(真 JournalEvent 结构上可赋;便于单测用假 journal)。 */
export interface JournalEventLike {
  kind?: string;
  payload?: unknown;
}

/** journal 最小读写面(真 Journal 结构上可赋;只用到 readAll/append)。 */
export interface JournalLike {
  readAll(sinceSeq?: number): JournalEventLike[];
  append(event: { kind: "custom"; sessionId: string; payload: Record<string, unknown> }): unknown;
}

/** issue 快照(plan 只读,不改)。 */
export interface IssueLinkSnapshot {
  number?: number;
  status?: IssueLinkStatus | string;
  comments?: { author?: string; body?: string }[];
}

export interface TerminalWriteBackInput {
  taskId: string;
  taskState: string;
  issue?: IssueLinkSnapshot | null;
 /** 调用时刻(仅透传给事件,不参与判定;plan 输出固定,保证确定性)。 */
  at: number;
}

export interface TerminalWriteBackPlan {
 /** true = 计划可执行或无副作用地确认已完成(OK/DUPLICATE);false = 不可执行(NOT_FOUND/INVALID)。 */
  ok: boolean;
  code: IssueLinkCode;
  patch?: { status?: IssueLinkStatus; assignee?: string };
  comment?: string;
}

/** 终态回写幂等键:同样 task + issue 只写一次。 */
export function writeBackKey(taskId: string, issueNumber: number): string {
  return `issue-writeback:${taskId}:${issueNumber}`;
}

/** 固定评论文本(≤200 字;含 taskId 与终态,不贴错误详情;超长 taskId 截断兜底)。 */
function commentTextOf(taskId: string, state: TerminalTaskState): string {
  const suffix = state === "failed" ? "失败（终态 failed）" : state === "cancelled" ? "已取消（终态 cancelled）" : "完成（终态 completed）";
  const text = `任务 ${taskId} ${suffix}`;
  return text.length <= 200 ? text : `任务 ${taskId}`.slice(0, 200 - suffix.length - 1) + "…" + suffix;
}

function isTerminalTaskState(s: string): s is TerminalTaskState {
  return s === "completed" || s === "failed" || s === "cancelled";
}

/**
 * 终态 → issue 变更计划。
 * completed: status 置 done(已 done=DUPLICATE);failed/cancelled: 不改 status,追加说明评论
 * (已有同文评论=DUPLICATE)。其它 taskState=INVALID;issue 缺失=NOT_FOUND。
 */
export function terminalWriteBackPlan(input: TerminalWriteBackInput): TerminalWriteBackPlan {
  const issue = input.issue;
  if (!issue) return { ok: false, code: "NOT_FOUND" };
  if (!isTerminalTaskState(input.taskState)) return { ok: false, code: "INVALID" };
  const state = input.taskState;
  if (state === "completed") {
    if (issue.status === "done") return { ok: true, code: "DUPLICATE" };
    return {
      ok: true,
      code: "OK",
      patch: { status: "done" },
      comment: commentTextOf(input.taskId, state),
    };
  }
  const comment = commentTextOf(input.taskId, state);
  const already = (issue.comments ?? []).some((c) => c && c.body === comment);
  if (already) return { ok: true, code: "DUPLICATE" };
  return { ok: true, code: "OK", comment };
}

/** journal 里是否已有同 key 的回写事件(幂等判据;容忍畸形 payload)。 */
export function hasWriteBack(events: readonly JournalEventLike[], key: string): boolean {
  for (const event of events) {
    if (!event || event.kind !== "custom") continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;
    if (p.type === "issue.task.writeback" && p.key === key) return true;
  }
  return false;
}

export interface WriteBackEventInput {
  key: string;
  taskId: string;
  issueNumber: number;
  projectId: string;
  state: string;
  at: number;
}

/** 回写事件载荷(字段顺序固定 = 稳定结构;同输入深相等)。 */
export function buildWriteBackEvent(input: WriteBackEventInput): Record<string, unknown> {
  return {
    type: "issue.task.writeback",
    key: input.key,
    taskId: input.taskId,
    issueNumber: input.issueNumber,
    projectId: input.projectId,
    state: input.state,
    at: input.at,
  };
}
