/**
 * system 提示词快照落账(token 轮 P1 · designs/token-opt-round3-p1 §3 01)。
 *
 * 背景:改前 loop 每步用当轮 system 原地重写 messages[0](node0),system 一变(任务类别切换 /
 * AGENTS.md 摘要刷新 / 技能索引新增 / memory revision / 计划文件注入 → 同 session 实测 2~4 个版本)
 * 整个前缀缓存从 token 0 失效(样本 run 首调用 19 次 = 1.08M uncached,占 uncached 15.2%,
 * 每次放大 53.7×;docs/analysis/cache-miss-output-audit.md)。
 *
 * 本模块只做一件事:把当轮 system 全文按会话落一条 `system.prompt` 快照,供 loop 冻结 node0
 * (loop 取该 session 第一条非 truncated 快照当 messages[0];后续变更改为在历史之后追加 user
 * 消息 `[系统提示更新]`,对齐 deepseek-harness `systemPromptUpdate:'in-history'`)。
 *
 * 幂等:同 session 同 sha 只落一条。判定=扫该 session 事件比 sha(跨进程重启后仍成立,
 * 走 readSession 的 per-session 索引,不扫全量);另加 idempotencyKey 兜并发/重入同进程双写。
 * 截断:超 65536 字符截断到 65536 并置 truncated:true——loop 侧拒用截断快照当 node0
 * (短于真实 system 会静默丢规则,退回 opts.system 更安全;R1 闭环)。
 * 保留策略(U3=A):快照永久保留。会话内至多 2~4 个版本,单条即全文,journal 删除语义不存在
 * 也不必引入——旧版本快照还是「system 什么时候变成了什么」的确定性审计证据。
 */
import { createHash } from "node:crypto";
import type { Journal } from "@lampgenie/core";

/** 快照文本上限(字符;U4=A)。当前产线 system 实测约 20.8k~25k 字符,64k 留足余量;
 *  超限走 truncated(loop 不用它当 node0),不会静默半截。 */
export const SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS = 65536;

/** sha 位数:与 task.context.systemSha 同口径(sha1 前 12 位)——两处指纹可直接对齐比对。 */
const SHA_LEN = 12;

/** 系统提示指纹。与 `task.context.systemSha` 同一算法(同一函数产出,不会再漂)。 */
export function systemPromptSha(sys: string): string {
  return createHash("sha1").update(sys).digest("hex").slice(0, SHA_LEN);
}

/** system.prompt 事件 payload(结构自证;面板/审计脚本按此读)。 */
export interface SystemPromptSnapshotPayload {
  /** 指纹(全文的 sha1 前 12 位,与 task.context.systemSha 同算法)。 */
  sha: string;
  /** 快照正文(超限已截断)。 */
  text: string;
  /** text 的字符数(= text.length;truncated 时=截断后的长度)。 */
  chars: number;
  /** text 被截断到 SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS 时为 true。 */
  truncated?: boolean;
}

/** 纯函数:system → 快照 payload(截断 + 指纹 + 字符数;无 IO,便于单测)。 */
export function buildSystemPromptSnapshot(sys: string): SystemPromptSnapshotPayload {
  const sha = systemPromptSha(sys);
  const truncated = sys.length > SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS;
  const text = truncated ? sys.slice(0, SYSTEM_PROMPT_SNAPSHOT_MAX_CHARS) : sys;
  return { sha, text, chars: text.length, ...(truncated ? { truncated: true } : {}) };
}

/** 该 session 是否已有快照(幂等判定;per-session 索引切片,不扫全量)。 */
export function hasSystemPromptSnapshot(journal: Journal, sessionId: string, sha: string): boolean {
  return journal.readSession(sessionId).some((e) =>
    e.kind === "system.prompt" && (e.payload as { sha?: unknown }).sha === sha);
}

/** 该 session 是否已有**任意**快照(2026-10-28 code_review:只保留首条)。 */
export function hasAnySystemPromptSnapshot(journal: Journal, sessionId: string): boolean {
  return journal.readSession(sessionId).some((e) => e.kind === "system.prompt");
}

/**
 * 幂等落账当轮 system 快照。返回 true=本次新写入,false=该 session 已有首条快照(未写)。
 *
 * **只落首条**(2026-10-28 code_review 收敛,原实现按 sha 幂等会每版本落一份全文):
 * ① 消费侧只有 loop 的 node0 冻结会读,且只读**第一条** —— 后续版本是永不读取的冗余副本;
 * ② 全文含 AGENTS.md 摘要/soul/memory/技能索引/项目路径,journal 是多处可导出的事实源,
 *    多存一份就多一份暴露面。后续版本的价值(「system 何时变成了什么」)由已有的
 *    `task.context.systemSha` + `systemChars` 审计锚承担,不需要再存正文。
 */
export function recordSystemPromptSnapshot(journal: Journal, sessionId: string, sys: string): boolean {
  if (hasAnySystemPromptSnapshot(journal, sessionId)) return false;
  const payload = buildSystemPromptSnapshot(sys);
  journal.append({
    kind: "system.prompt",
    sessionId,
    payload,
    // 同进程并发/重入双写的第二道闸;跨重启的幂等靠上面的扫描。
    idempotencyKey: `system.prompt.${sessionId}.${payload.sha}`,
  });
  return true;
}
