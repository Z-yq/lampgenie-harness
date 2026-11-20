/**
 * 统一保护窗(缺口#27,docs/design/02-context-economy/04-mechanisms.md §4.1.3):
 * 四个裁剪机制各带一套计数保护窗,口径互不一致(组/条/结果/组),也没有一条说明
 * 「为什么这条内容不再属于热区」。本文件把它们收敛为**一套统一登记处**:
 * 每个键 = 一个机制的「热区豁免窗」,note 说明豁免理由;数值与各机制现状缺省**逐字相等**
 * (本文件只做登记与防漂移,不改行为——microcompact / microcompact-age 的缺省改为从这里引用,
 * 测试 import 实际常量对比,防两处漂移)。
 * 三段式降级(§4.1.3):保护区(热·逐字不动)→ 观察期(温·仍受保护但开始定价)→
 * 可裁候选(温·语义保留·经济门裁决)→ 冷区(冻结区,reset 前移是唯一路径)。
 * stageOf 给出四态判定;OBSERVATION_STEPS 是观察期步数(时间/步数口径,不用 token 数)。
 */

import type { Message } from "./loop";

/**
 * 四套保护窗的统一登记(值 = 各机制现状缺省,不许漂移;测试逐键断言)。
 * note = 豁免理由(为什么这个窗内的内容还属于热区)。
 */
export const PROTECTION_WINDOWS = {
 /** microcompact 组清理:保最近 N 组工具结果(原 DEFAULT_KEEP_RECENT_GROUPS=5)。 */
  microcompactKeepRecentGroups: 5,
 /** jev-150m 评分热尾:最近 N 条消息不送模型(原 scoringHotTailMessages=6)。 */
  scoringHotTailMessages: 6,
 /** path_prune:声明前最近 N 个结果豁免(原 pathPruneKeepRecent=3)。 */
  pathPruneKeepRecent: 3,
 /** 按龄 microcompact:保最近 N 组完整对话组(原 AGE_DEFAULTS.keepRecentGroups=3)。 */
  ageKeepRecentGroups: 3,
} as const;

/** 每键的豁免理由(与 PROTECTION_WINDOWS 同键;审计/文档引用,不参与判定)。 */
export const PROTECTION_WINDOW_NOTES: Record<keyof typeof PROTECTION_WINDOWS, string> = {
  microcompactKeepRecentGroups:
    "组清理只清窗口外的旧工具结果:刚产生的结果往往正是当前决策依据,清了会引发重读死循环(2026-10-18 read_file×31 实报)",
  scoringHotTailMessages:
    "评分只看温区:热尾消息刚进上下文,立即送评会误判且每步都改候选集,滞后一步更稳",
  pathPruneKeepRecent:
    "路径裁剪保声明前最近 3 个结果:文件被声明『不再相关』前,最新几次读写可能正是声明依据本身",
  ageKeepRecentGroups:
    "按龄裁剪保最近 3 组完整对话组:闲置回来的会话,最近几组通常就是接下来要续的上下文",
};

/** 观察期步数(§4.1.3 ②:观察期用时间/步数而非 token——刚降级的内容常被再次提及)。 */
export const OBSERVATION_STEPS = 3;

/** 三段式降级里一条内容当前所处的阶段。 */
export type DowngradeStage = "protected" | "observing" | "prunable" | "cold";

/** stageOf 的输入:全部字段由调用方(降级事件/引用追踪/冻结区渲染)确定性给出,本函数零 IO。 */
export interface StageOfItem {
 /** 该内容上次被触碰(读/引用/降级确认)的步号。 */
  lastTouchedStep: number;
 /** 当前步号。 */
  currentStep: number;
 /** 结构信号:观察期到期后它是否仍被引用(§4.1.3 ③-2:被引用 → 回保护区)。 */
  stillReferenced: boolean;
 /** 硬保护(不可逆回执/认知工具/错误结果/未声明失败路径):任何阶段都不许裁。 */
  hardProtected: boolean;
}

/**
 * 三段式四态判定(纯函数,零副作用):
 * - hardProtected → "protected"(硬保护先出局,永远不进可裁池);
 * - 观察期内(currentStep - lastTouchedStep < OBSERVATION_STEPS)→ "observing"
 * (仍逐字保留,但可定价——记 B/W/N,见 §4.1.1);
 * - stillReferenced → "protected"(回保护区);
 * - 其余 → "prunable"(可裁候选,裁不裁由经济门 N>r·B/W 裁决)。
 * "cold" 不由本函数产生:进入冷区的唯一路径是 reset 前移冻结区(§4.1.3 ③),
 * 调用方(冻结区渲染)对已冻结内容直接标 "cold"。
 */
export function stageOf(item: StageOfItem): DowngradeStage {
  if (item.hardProtected) return "protected";
  if (item.currentStep - item.lastTouchedStep < OBSERVATION_STEPS) return "observing";
  if (item.stillReferenced) return "protected";
  return "prunable";
}

/** 一次降级/回迁的审计记录(§4.1.3:降级只影响「是否逐字保护」,不等于可裁)。 */
export interface DowngradeRecord {
 /** 条目标识(工具结果 = toolCallId;其它内容 = 派生稳定 id)。 */
  id: string;
 /** 从哪个阶段迁出。 */
  from: DowngradeStage;
 /** 迁入哪个阶段。 */
  to: DowngradeStage;
 /** 发生迁移的步号。 */
  atStep: number;
 /** 触发信号(焦点边界/被消费/被取代/观察期到期/仍被引用/reset 冻结)。 */
  signal: string;
}

/**
 * 降级候选队列按「消息索引离尾最近优先」排序的辅助口径:返回每条消息中
 * 可定位的 toolCallId → 消息下标映射(orderByTailProximity 用它算尾部邻近度)。
 * 纯函数;只读,不改入参。
 */
export function toolCallMessageIndex(messages: readonly Message[]): Map<string, number> {
  const map = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.role === "tool" && m.toolCallId) map.set(m.toolCallId, i);
  });
  return map;
}
