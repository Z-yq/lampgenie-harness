/**
 * presence 状态机(designs/04 §2):六态,判定规则确定性(只用心跳+事件计数,不用模型)。
 * 纯函数——状态推导在 relay 侧集中,客户端只上行事实。
 *
 * 规则(设计稿原文):
 * ①dnd 手动置位,优先于一切自动态;
 * ②coding 优先于 reviewing(人没在看审批,但 agent 在跑);
 * ③offline 由连接层判定(WS 断开),不在本函数职责内——本函数只推「连接活着时」的状态。
 */
import type { PresenceFacts, PresenceStateName } from "@lampgenie/protocol";

/** away 判定阈值(>15min 无输入;设计稿标注值待标定,单测可注入时钟)。 */
export const PRESENCE_AWAY_MS = 15 * 60 * 1000;
export function derivePresence(facts: PresenceFacts, now: number): PresenceStateName {
  if (facts.dnd) return "dnd";
  if (facts.runningSessions > 0) return "coding";
  if (facts.pendingAsks > 0) return "reviewing";
  if (now - facts.lastInputAt > PRESENCE_AWAY_MS) return "away";
  return "online";
}

/** 卡片「当前任务」语义(designs/04 §3):名下最近活跃的非终态任务;单成员只置顶一个。 */
export interface MemberCardInput {
  username: string;
  facts: PresenceFacts;
  /** 该成员名下 team 可见项目里 updated_at 最新的非终态任务名(无=null)。 */
  currentTask: string | null;
}

export function memberCard(
  input: MemberCardInput,
  now: number,
): { username: string; state: PresenceStateName; currentTask: string | null } {
  return {
    username: input.username,
    state: derivePresence(input.facts, now),
    currentTask: input.currentTask,
  };
}
