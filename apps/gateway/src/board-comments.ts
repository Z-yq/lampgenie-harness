/**
 * 白板评论「待办提示」(2026-10-22 用户口径:评论了要有人接)。
 *
 * 现状问题:board.comment 只把评论写进 node.comments + journal(board.update by:"comment"),
 * agent 只有下次自己调 board_read 或被人工点「按板续作」才看得到 → 体验上「我评论了但没人理」。
 *
 * 本模块补一条轻量链路:评论落盘后登记进进程内 pending 队列;agent loop 每步构造 tips 时
 * 取一次(take),把「有新评论」的提示注入下一步上下文,注入即消费(只提示一次,不刷屏)。
 *
 * 边界(诚实):
 * - 进程内内存态,网关重启即丢(journal 仍是唯一真源;丢了也只是少一次主动提示,board_read 照旧可见)。
 * - 不自动开新轮:会话空闲时只登记,等下一轮任务/续作自然带出。自动唤醒会打断用户既定节奏。
 */
export interface PendingBoardComment {
  sessionId: string;
  taskId: string;
  nodeId: string;
  text: string;
  at: number;
}

const pending = new Map<string, PendingBoardComment[]>();

const key = (sessionId: string): string => sessionId;

/** 登记一条待处理评论(同一节点同文本去重,防双击重复提示)。 */
export function notePendingComment(c: Omit<PendingBoardComment, "at"> & { at?: number }): void {
  if (!c.sessionId || !c.taskId || !c.nodeId || !String(c.text || "").trim()) return;
  const k = key(c.sessionId);
  const list = pending.get(k) ?? [];
  if (list.some((x) => x.taskId === c.taskId && x.nodeId === c.nodeId && x.text === c.text)) return;
  list.push({ ...c, text: String(c.text).trim(), at: c.at ?? Date.now() });
  // 上限:单会话最多留 20 条待提示(与 node.comments 上限对齐;超出丢最旧的,不无限涨内存)
  if (list.length > 20) list.splice(0, list.length - 20);
  pending.set(k, list);
}

/** 取走该会话全部待提示(注入即消费;返回空数组=无待办)。 */
export function takePendingComments(sessionId: string): PendingBoardComment[] {
  const k = key(sessionId);
  const list = pending.get(k) ?? [];
  pending.delete(k);
  return list;
}

/** 只读窥视(面板 chip / 测试断言用,不消费)。 */
export function peekPendingComments(sessionId: string): PendingBoardComment[] {
  return [...(pending.get(key(sessionId)) ?? [])];
}

/** 清空(测试隔离用)。 */
export function clearPendingComments(sessionId?: string): void {
  if (sessionId === undefined) pending.clear();
  else pending.delete(key(sessionId));
}

/** 渲染成注入 agent 上下文的提示块;无待办返回 null(不注入空壳)。 */
export function renderPendingCommentsBlock(list: PendingBoardComment[]): string | null {
  if (list.length === 0) return null;
  const lines = list
    .slice(0, 10)
    .map((c) => `- 板 ${c.taskId} 节点 ${c.nodeId}:${c.text.length > 200 ? c.text.slice(0, 200) + "…" : c.text}`)
    .join("\n");
  const more = list.length > 10 ? `\n(另有 ${list.length - 10} 条未列出)` : "";
  return (
    "【白板新评论】用户在你的设计白板上留了评论(评论=对设计的调整意见,优先于原方案照做):\n" +
    lines +
    more +
    "\n先 board_read 读回该板看全文与当前节点形态,再按评论修正;改完用 board_upsert 更新白板(保持节点 id 稳定)。"
  );
}
