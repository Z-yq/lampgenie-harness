/**
 * 任务列表载荷索引化(协议改「索引 + 按需详情 + 增量」)。
 * 历史病灶(网关 OOM 二连):五处裸发 tm.list——全部任务的 instruction+result 全文
 * 随每次连接/每次任务变更广播序列化。注意 hello 载荷 960KB(死前日志「ws 发送积压超 2MB
 * (type=task.list)」),数百任务×KB 级全文,序列化 churn + 巨型字符串驻留把 4GB 堆打穿(崩溃栈
 * =JsonStringify)。当时的补丁是「最近 50 条保全文 + 其余截 240 字 + 标「预览,全文 N 字」」——
 * 魔法数压着,且仍在传正文。
 * 索引化后为什么不会再出现 960KB:列表帧只带 TaskIndex(标题/状态/时间/归属),帧长只随任务
 * 条数线性增长(每条约百字节量级),与 instruction/result 长度**无关**;正文只在面板点名某个 id
 * 时经 task.detail.get/task.detail.result 单条往返(或走 session.history)。故没有任何截断阈值,
 * 也没有「预览占位」串。
 */
import type { Task, TaskIndex } from "@lampgenie/protocol";

/** 标题上限(与 TaskSupervisor.deriveTitle 同口径)。 */
const TITLE_MAX = 40;

/** 首行压空白取前 40 字符,超长加省略号;与 deriveTitle 一致(不含「全文等长则不设」的省字段优化)。 */
function deriveTitle(instruction: string): string {
  const first = instruction.trim().split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX) + "…" : first;
}

/** Task → TaskIndex:显式白名单投影(绝不透传正文/凭证字段;新增正文型字段也不会漏进列表帧)。 */
export function taskIndexOf(t: Task): TaskIndex {
  const title = t.title ?? (deriveTitle(t.instruction ?? "") || t.id.slice(0, 8));
  const idx: TaskIndex = {
    id: t.id,
    sessionId: t.sessionId,
    state: t.state,
    title,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
  };
  if (t.archived !== undefined) idx.archived = t.archived;
  if (t.pinned !== undefined) idx.pinned = t.pinned;
  if (t.projectId !== undefined) idx.projectId = t.projectId;
  if (t.group !== undefined) idx.group = t.group;
  if (t.titleCustom !== undefined) idx.titleCustom = t.titleCustom;
  if (t.startedAt !== undefined) idx.startedAt = t.startedAt;
  return idx;
}

/** hello / task.list 载荷:任务清单的索引投影。 */
export function taskIndexList(tasks: Task[]): TaskIndex[] {
  return tasks.map(taskIndexOf);
}