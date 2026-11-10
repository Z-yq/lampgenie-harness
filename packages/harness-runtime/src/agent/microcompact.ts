/**
 * microcompact(读侧工具结果治理),两条独立路径:
 * ①超大结果精炼( content > 8KB 的可占位工具结果替换为
 *   head 4K + 剪除标记 + tail 1K,dsh pruner 同语义;寻址参数保留可精确重读);
 * ②阈值触发的组清理(对齐 ZCode compact/microcompact.ts 阈值语义):
 *   token 估算 ≥ thresholdTokens 才触发;按工具结果组保留最近 keepRecent(缺省 5)组,
 *   更早的清为带寻址的「已清除」占位;minSavings 不足整体回滚。
 * Phase 0在两条路径前
 * 增加确定性治理:
 * - 硬保护:错误/异常结果、认知工具、不可逆动作回执(edit_file/write_file)永不剪
 *   (错误日志的中段栈帧往往就是根因,head/tail 也不能碰);
 * - dedup:相同 (tool, 寻址, 内容) 的旧结果折叠,只留最新一份;
 * - supersede:只读可重跑工具同 (tool, 寻址) 的旧结果被后续调用取代(错误结果不参与);
 * - per-tool cap:可按工具覆写超大结果阈值;
 * - pruned/manifest:返回本次折叠/剪除清单,供 loop 注入上下文清单与 journal 留痕。
 * 历史教训(用户用户反馈,不可回退):旧实现按「最近 N 组」**无条件**滚动占位,
 * 第 6 组起模型对全部旧工具结果失忆 → read_file×31 重读死循环。所以路径②**只在
 * token 估算达到阈值时触发**(ZCode thresholdTokens 语义),绝不回到无条件滚动。
 * 与 ZCode 的已知差异(如实登记):我们的 Message 无 isError 字段,错误结果用内容特征
 * (traceback/ERROR/failed/exit code 等)保守识别——宁可多留,不静默丢错误。
 */
import { createHash } from "node:crypto";
// token 口径统一见 agent/token-estimate.ts(真分词器 + 标定;本文件不再自带字符系数近似)。
import { rawTokens, estimateMessagesTokens, estimateMessageTokens, approxTokensOfChars } from "./token-estimate";
import type { Message, ToolCall } from "./loop";

/** 可占位工具(harness 实际工具名;原始大内容可按参数重新获取)。 */
export const COMPACTABLE_TOOLS = new Set([
  "read_file", "grep", "glob", "list_dir", "terminal", "run_cmd", "edit_file", "write_file",
]);
/** 认知类工具(结构化浓缩结果,清了就得重查/重审——豁免;不在 COMPACTABLE_TOOLS 内,
 * 组清理与超大占位都不碰)。 */
export const NEVER_COMPACT_TOOLS = new Set([
  "code_sense", "code_index", "code_review", "code_sense_cli", "board_upsert", "board_read",
  "todo_write", "skill_view", "experience_fold", "session_search", "spawn_subagent", "run_workflow",
  "ask", "web_search", "web_fetch",
]);
/** 不可逆动作:edit/write 的回执是「动作历史」而不是可重读内容——硬保护。 */
export const IRREVERSIBLE_TOOLS = new Set(["edit_file", "write_file"]);
/** 同目标后续结果可安全取代旧结果的只读、可重跑工具(terminal/run_cmd 有副作用,不在此列)。 */
const SUPERSEDABLE_TOOLS = new Set(["read_file", "grep", "glob", "list_dir"]);

/** 超大结果阈值(字符):超过才精炼(路径①)。 
 * 48KB→8KB,且形态从「整体占位+重读」改为 head/tail 保留中段剪除(deepseek-harness
 * compaction-tool-result-pruner 同语义:head 4K + 标记 + tail 1K——尾部往往是错误与最终结果,
 * 头部是上下文,中段价值最低)。寻址参数保留在标记里,需要中段细节仍可精确重读。 */
export const HUGE_RESULT_CHARS = 8_000;
/** 精炼保留的头部长度(字符)。 */
export const PRUNE_HEAD_CHARS = 4_000;
/** 精炼保留的尾部长度(字符)。 */
export const PRUNE_TAIL_CHARS = 1_000;
/** 路径②最小节省 tokens,不足整体回滚(ZCode DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS)。 */
export const MIN_TOKEN_SAVINGS = 256;

/**
 * cache-aware 剪枝策略 v2(校准:前缀稳定是第一约束)。
 * v1(批量 + 粘性重放)**不够**:它只保证「不新增清空」,但 `deriveMessages` 每步从 journal 重建,
 * 而 dedup「保最后一份」/ args 摘要「保最后一条」/ supersede / keepRecent 窗口都是**随追加而变**的规则
 * ——新来一条就把上一步已发出去的消息改写掉 → 公共前缀从改写点起塌陷。
 * 用户注意:250k→160k→240k→200k 的起伏把命中率压到极低,因为前缀每步都在变。
 * v2 不变量(实现即这套):
 * ①**append-only 常态**:已进入上一次请求的消息,渲染结果必须逐字节不变。唯一满足该性质的是
 *   「只看单条消息自身内容」的变换(head/tail 精炼,幂等);随追加而变的规则一律不许常态化跑。
 * ②**冻结区(frozen zone)**:[0, frozenCount) 由纯函数渲染(旧全量管线只作用在这个固定切片上),
 *   区外(新到达的 tail)只做 head/tail 后原样接回。frozenCount 不变 → 请求前缀逐字不变。
 * ③**重置(reset)**:唯一允许改写前缀的动作。条件:est ≥ 触发阈值、冷却已过、本 turn 未重置过、
 *   削减 ≥ 最小批量、净收益为正。目标基线 = 触发阈值 × 88%(85~90%),单次削减 ≤ 20%(禁大起大落)。
 * ④**冷却**:重置后须再增长 ≥ 50k tok 或过 ≥ 20 步才允许下一次重置;同一 turn ≤ 1 次。
 * ⑤**新增预算**:单步增量 ≤ max(1.5%, 1.5k tok) —— 在**写时**用 spill 落盘定形压住(loop 侧),
 *   绝不「先全量进上下文再靠 prune 减回」(那正是用户点名的震荡形态)。
 * 只在调用方传 `policyState` 时生效(loop 默认传 → 默认开启;单测/旧构造点不传 → 旧行为逐字不变)。
 */
export const MIN_PRUNE_CONTEXT_TOKENS = 110_000;
/** 重置后基线目标 = 触发阈值 × 该比例(85~90%:别压太低,否则「压到底再长回」= 锯齿)。 */
export const RESET_TARGET_RATIO = 0.88;
/** 单次重置的最大削减比例(禁止 250k→160k 这种 36% 大跳)。 */
export const MAX_RESET_CUT_RATIO = 0.2;
/** 重置后冷却:上下文再增长多少 tokens 才允许下一次重置。 */
export const RESET_COOLDOWN_TOKENS = 50_000;
/** 重置后冷却:经过多少步才允许下一次重置。 */
export const RESET_COOLDOWN_STEPS = 20;
/** 同一 turn 内允许的前缀重置次数上限(≤1)。 */
export const MAX_RESETS_PER_TURN = 1;
/** 重置的最小削减 tokens(太小 = 白白打碎一次前缀)。 */
export const PRUNE_MIN_BATCH_TOKENS = 20_000;
/** 收益门:剩余调用次数的保守假设。重置削 12~20%,按 10 次回本即可(比 v1 的 5 更保守)。 */
export const PRUNE_ASSUMED_REMAINING_CALLS = 10;
/** 每步新增预算比例(1~2%,缺省 1.5%)。 */
export const GROWTH_BUDGET_RATIO = 0.015;
/** 每步新增预算下限(tokens):小上下文按比例算出来太小,会误伤早期步。 */
export const GROWTH_BUDGET_MIN_TOKENS = 1_500;
/** 清除占位的估算长度(字符;只用于削减量估算,最终 savedTokens 走 savedTokensOf 真值)。 */
const CLEARED_PLACEHOLDER_EST_CHARS = 160;

/** 策略判定结果(落 context.prune 的 policy 字段)。 */
export type MicrocompactPolicy =
  /** 常态:冻结区渲染 + tail 原样追加,已发出去的前缀逐字不变。 */
  | "append-only"
  /** 本次推进冻结区(唯一允许改写前缀的动作)。 */
  | "reset"
  /** 增长突增档(装配方显式配置):按 keepRecent 清到窗口外,不受重置水位/冷却约束。 */
  | "growth-spurt"
  | "low-context-skip"
  | "cooldown-skip"
  | "turn-cap-skip"
  | "deferred"
  | "benefit-skip";

/** 调用方维护的跨步剪枝状态(loop 侧累积;实例新建时从 journal 末条 context.prune 播种)。 */
export interface MicrocompactPolicyState {
  /** 步计数(每步 +1,跨 turn 累计)。 */
  clock?: number;
  /** 本步是否 turn 边界首步。 */
  turnStart?: boolean;
  /** 冻结区消息条数(重置时前移,平时不动)。 */
  frozenCount?: number;
  /** 冻结区最后一个 tool 结果的 toolCallId(硬压缩/历史重建后按它重新定位 frozenCount)。 */
  frozenAnchor?: string;
  /** 上次重置时的 clock / 上下文估算(冷却判定基线)。 */
  lastResetClock?: number;
  lastResetTokens?: number;
  /** 本 turn 已发生的重置次数(turn 首步由 loop 归零)。 */
  resetsThisTurn?: number;
  /** 增长突增强制档:按 keepRecent 清到窗口外(装配方显式配置的意图)。 */
  force?: boolean;
}
/** 路径②保留最近 N 组工具结果(ZCode DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS)。 */
export const DEFAULT_KEEP_RECENT_GROUPS = 5;
/** micro 阈值比例(ZCode DEFAULT_MICROCOMPACT_THRESHOLD_RATIO)。 */
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9;
/** micro 阈值 buffer tokens(ZCode DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS)。 */
export const MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
/** per-tool cap 的下限:再小就会「占位比原文还长」,失去意义。 */
export const MIN_TOOL_CAP_CHARS = 2_000;
/** 兼容导出:模型 drop 现在改用固定短占位,不再 head/tail 到 2KB;保留常量供旧调用方。 */
export const MODEL_DROP_CAP_CHARS = 2_000;
/** 模型 drop 不碰最近 N 条消息(热区逐字,避免刚产生的关键结果被模型误判压掉)。 */
const MODEL_HOT_TAIL_MESSAGES = 6;
/** 增长突增的缺省阈值(tokens):单步新增达到此值时触发激进组清理(0/未配置=关闭)。 */
export const DEFAULT_GROWTH_SPURT_TOKENS = 12_000;

/**
 * 本地 token 估算系数(经验证标定,替换旧的 chars/4)。
 * ⚠️ 2026-11 token 轮:**仅作回退系数**,真值走 `agent/token-estimate.ts`(cl100k 真分词器 +
 * 标定 ratio)。下面两个常量只为「其它模块仍 import 系数」与「分词器不可用时的回退口径」保留,
 * 本文件不再用它们做任何估算。
 * 历史标定(仍作回退档位的依据):近 5 天 `.genie/journals/sessions` 6,975 个「会话内累计字符量 vs
 * 上游 usage.inputTokens」采样点(只取累计字符 >50k 的点,排除 system/tools schema 占比过高的早期步)。网格搜索系数 W
 * 使 |usage/est − 1| 的中位数最小:
 * - 旧口径 chars/4(等价 W=1.0 / ASCII 0.25):中位相对误差 **45.0%**,p90 74.6%
 * - CJK≈1.95 tok、ASCII≈0.25 tok(本常量):中位 **10.1%**,p90 30.0%
 * 语义解释:中文 1 字符 ≈1~2 token(BPE 常见 1.5~2),英文/代码 1 字符 ≈0.25 token。
 * 影响:同一阈值下组清理触发率 14.6% → 33.5%(同批数据复算)——这正是「更早压缩」的档位。
 */
export const CJK_TOKENS_PER_CHAR = 1.95;
/** ASCII/非 CJK 字符的 token 系数(4 字符 ≈1 token)。仅作回退系数,真值走 token-estimate。 */
export const ASCII_TOKENS_PER_CHAR = 0.25;

/** 一段文本的 tokens(纯函数,导出供测试与调用方复用)。
 *  token 口径统一见 agent/token-estimate.ts:已迁至 token-estimate.ts,作为分词器不可用时的回退。 */
export function estimateTokensOfText(text: string): number {
  return rawTokens(text);
}

/** 路径①精炼内容前缀( head/tail 形态)。 */
const HUGE_PLACEHOLDER_PREFIX = "[工具结果已精炼:";
/** 路径②占位内容前缀(已清除/可重读标记)。 */
const CLEARED_PLACEHOLDER_PREFIX = "[工具结果已清除(上下文压力):";
/** 确定性折叠前缀。 */
const DEDUP_PLACEHOLDER_PREFIX = "[工具结果已去重:";
const SUPERSEDED_PLACEHOLDER_PREFIX = "[工具结果已被后续同类调用取代:";
/** 模型明确判定「不需要」:不留正文,但必须留下调用发生过的可核记账。 */
const MODEL_DROP_PLACEHOLDER_PREFIX = "[工具结果已按模型判断不保留:";

/** assistant 侧历史写入正文摘要标记( token 轮:写工具参数里的整文件正文
 * 是历史 token 的最大单一来源,且一旦 later 写入成功就是死重)。summary 值以此开头,
 * 由 isPlaceholderContent 识别 → 幂等(二次处理不再摘要,输出逐字节相同)。 */
const ARGS_SUMMARY_PREFIX = "[历史正文已省略:";
/** 需摘要的参数正文键(按工具名;其余键——path/offset/replace_all——逐字保留,
 * toolWhere 寻址必须靠 path)。 */
const WRITE_TEXT_ARGS: Record<string, readonly string[]> = {
  write_file: ["content"],
  edit_file: ["old_string", "new_string"],
};
/** 正文合计短于此不摘要:占位比原文还长,且小片段往往就是有效信息。 */
const MIN_ARGS_SUMMARY_CHARS = 400;
/** 单个参数值短于此不摘要(edit_file 的 old_string 常常很短,替换成摘要反而更长)。 */
const MIN_SINGLE_ARGS_SUMMARY_CHARS = 200;
/** 全量去重的「热区年龄」:只有距末尾至少这么多条消息的旧副本才折叠。
 * 设计理由(prefix-stability / system-in-history ④ 经验证踩到):去重是「新副本到达时改写旧副本」,
 *  若对贴着末尾的副本立即折叠,每来一次重复就把历史中段改一次 → 公共前缀从该处起全部失效
 *  (token 轮的目标恰好包括缓存命中)。让副本先滑出热区再折叠:折叠在长会话里仍会发生
 * (经验证重复回执一般都在几十条之前),但不会出现「每步都改历史」。折叠一旦发生即稳定,
 *  因为占位内容被 isPlaceholderContent 识别、不再参与后续折叠。 */
const DEDUP_MIN_AGE_MESSAGES = 8;

/** 错误/异常特征;全量扫描(错误可能在长结果中段,采样会漏保护)。 */
const ERROR_MARKERS: RegExp[] = [
  /Traceback \(most recent call last\)/i,
  /\b(?:Error|ERROR|FATAL|CRITICAL|PANIC)\b/,
  /\b(?:Exception|AssertionError)\b/,
  /\b[1-9]\d*\s+failed\b/i,
  /\bexit code\s*[:=]?\s*[1-9]\d*/i,
  /\bexit status\s*[:=]?\s*[1-9]\d*/i,
  /\bcommand failed\b/i,
  /\bcommand not found\b/i,
  /\b(?:ENOENT|EACCES|EPERM|ENOTDIR)\b/,
  /\bNo such file or directory\b/i,
  /\bpermission denied\b/i,
  /\b(?:timed?\s*out|timeout)\b/i,
  /Segmentation fault/i,
 // 中文工具错误(真实链路经验证:`错误:路径非法或越出项目根...` 曾漏过 hard-protect)
  /^\s*(?:错误|失败|异常)[：:]/m,
  /^\s*(?:参数错误|路径非法|越出项目根|权限不足|拒绝访问)/m,
  // 结构化工具错误:{"ok":false,"error":"..."} / {"is_error":true}
  /"ok"\s*:\s*false/i,
  /"is_error"\s*:\s*true/i,
];

/** microcompact 结果里可观测的折叠/剪除动作。 */
export type MicrocompactAction = "head_tail" | "cleared" | "dedup" | "superseded" | "model_drop" | "args_summarized";

/** 一条被折叠/剪除的工具结果(不携带正文;shadow/审计可按 toolCallId 回查 journal)。 */
export interface MicrocompactPrunedItem {
  toolCallId: string;
  tool: string;
  where: string;
  action: MicrocompactAction;
  originalChars: number;
  newChars: number;
}

/** microcompact 配置:thresholdTokens 未给(或 ≤0)=路径②关闭,只走超大占位。 */
export interface MicrocompactConfig {
  /** 组清理触发阈值(估算 tokens ≥ 此值才触发)。 */
  thresholdTokens?: number;
  /** 保留最近 N 组工具结果(缺省 5;ZCode keepRecentToolResults)。 */
  keepRecent?: number;
  /** 最小节省 tokens,清完省不足此值整体回滚(缺省 256;ZCode minTokenSavings)。 */
  minSavings?: number;
  /** 按工具的「超大结果」阈值覆写(字符;下限 MIN_TOOL_CAP_CHARS)。 */
  toolCaps?: Record<string, number>;
  /** 相同 (tool, 寻址, 内容) 的旧结果折叠(缺省 true)。 */
  dedup?: boolean;
  /** 只读可重跑工具同目标的旧结果被后续调用取代(缺省 true)。 */
  supersede?: boolean;
  /** 错误/异常结果硬保护(缺省 true)。 */
  protectErrors?: boolean;
  /** 不可逆动作回执硬保护(缺省 true)。 */
  protectIrreversible?: boolean;
  /** 模型高置信度判定「还要」的 toolCallId:全量保护(不 dedup/supersede/head-tail/clear)。 */
  modelKeep?: ReadonlySet<string>;
  /** 模型高置信度判定「不要」的 toolCallId:不保留正文,只留「调用已发生/有效内容未保留」占位。 */
  modelDrop?: ReadonlySet<string>;
  /** assistant 侧历史写入正文摘要化(缺省 true):write_file/edit_file 参数里的整文件正文,
   * **除最近 1 条外**替换为带 path 的合法 JSON 摘要(回头重写前按 path 重新 read_file 即可)。 */
  summarizeWriteArgs?: boolean;
  /** 全量结果去重(缺省 true):不区分工具名/寻址/保护名单,content 完全相同的旧 tool 结果
   * 只保留最后一份。写工具回执(edit_file/write_file)不折叠的病根就在旧的
   * foldDuplicateAndSuperseded 三重限制(COMPACTABLE_TOOLS + where 非空 + IRREVERSIBLE_TOOLS)。 */
  dedupAnyTool?: boolean;
  /** 裁剪净收益门(缺省 true)：就地改写历史中段会让**前面所有 token 的前缀缓存失效**
 * (经验证 57k 前缀因裁 1 条 500 字符的旧结果而全量重算,一次多花 5.7 万 token)。
   *  开启后:只有当「省下的 token ≥ 前缀失效代价 × 系数」时才真正裁剪,否则放弃本次裁剪。
   *  关闭 = 恢复旧的无条件裁剪行为(仅用于对照实验)。 */
  breakEvenGate?: boolean;
  /** 净收益门的保守系数(缺省 3):省 1 token 至少要抵 3 token 的重算代价才值得裁。 */
  breakEvenFactor?: number;
 /** cache-aware 前缀稳定策略 v2:传了 `policyState` 才生效(loop 默认传)。
   *  以下字段可覆写默认值;`cacheAware:false` = 整条策略关闭(恢复旧的每步增量行为)。 */
  cacheAware?: boolean;
  /** 最小上下文门槛(tokens,缺省 110_000;自动夹到触发阈值的 90%)。低于它不做重置。 */
  minContextTokens?: number;
 /** 重置后基线目标 = 触发阈值 × 该比例(缺省 0.88,即85~90%)。 */
  resetTargetRatio?: number;
  /** 单次重置的最大削减比例(缺省 0.2):禁止「250k→160k」这种大起大落。 */
  maxResetCutRatio?: number;
  /** 重置后冷却:上下文再增长多少 tokens 才允许下一次重置(缺省 50_000)。 */
  resetCooldownTokens?: number;
  /** 重置后冷却:经过多少步才允许下一次重置(缺省 20;turn 首步可越)。 */
  resetCooldownSteps?: number;
  /** 同一 turn 允许的重置次数上限(缺省 1)。 */
  maxResetsPerTurn?: number;
  /** 重置的最小削减 tokens(缺省 20_000)。 */
  pruneMinBatchTokens?: number;
  /** 收益门:剩余调用的保守假设(缺省 10;0 = 关闭收益门)。 */
  assumedRemainingCalls?: number;
  /** 跨步策略状态(调用方持有;新状态由结果返回)。 */
  policyState?: MicrocompactPolicyState;
  /** 内部用:渲染已冻结前缀时清空**该切片内所有**候选组(不回退 keepRecent 窗口)。
   *  冻结边界已在重置决策时定下,渲染阶段再按 keepRecent 留一组就会「算了省 9 组、实际只清 7 组」。 */
  clearAllGroups?: boolean;
}

/** 净收益门默认系数:省 1 token 必须抵得上 3 token 的前缀重算,才认为裁剪划算。 */
const BREAK_EVEN_FACTOR = 3;
// token 口径统一见 agent/token-estimate.ts:没有原文、只有字符量的场合用统一模块的
// approxTokensOfChars,本文件不再自带 chars→tokens 系数。

/** 估算「最早改写点之前」的字符量——它就是缓存失效后需要重算的前缀规模。 */
function estimateCharsBeforeFirstRewrite(
  messages: Message[],
  items: MicrocompactPrunedItem[],
  idx: Map<string, { name: string; where: string }>,
): number {
  const touched = new Set<string>();
  for (const it of items) if (it.toolCallId) touched.add(it.toolCallId);
  if (touched.size === 0) return 0;
  // 找到第一条被改写的消息位置
  let firstIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId && touched.has(m.toolCallId)) { firstIndex = i; break; }
    if (m.role === "assistant" && m.toolCalls?.length && m.toolCalls.some((c) => touched.has(c.id))) { firstIndex = i; break; }
  }
  if (firstIndex <= 0) return 0;
  return messages.slice(0, firstIndex).reduce((s, m) => s + messageChars(m), 0);
}

export interface MicrocompactResult {
  messages: Message[];
  compacted: number;
  reason?: string;
  /** 本次实际折叠/剪除的条目(供 manifest/journal/shadow 使用)。 */
  pruned?: MicrocompactPrunedItem[];
  /** 注入模型的「上下文清单」(无折叠时为空串)。 */
  manifest?: string;
  /** 估算节省 tokens(字符差/4;含 dedup/supersede/head-tail/clear)。 */
  savedTokens?: number;
  /** 净收益门放弃裁剪的说明(有值=本次未裁剪,原因在此)。 */
  skipped?: string;
  /** cache-aware 策略判定(传 policyState 时才有):append-only=本步纯追加;reset=推进了冻结区。 */
  policy?: MicrocompactPolicy;
  /** 本次新进入冻结区而被清掉的项数(重置规模);append-only 步为 0。 */
  planCount?: number;
  /** 本次是否改写了**已在历史里发过**的前缀(head_tail 只精炼刚到达的结果,不算)。 */
  prefixBreak?: boolean;
  /** 本步上下文 tokens 估算(策略判定输入)。 */
  contextTokensBefore?: number;
  /** 渲染后的上下文 tokens 估算(loop 用它做下次冷却基线)。 */
  contextTokensAfter?: number;
  /** 本次重置后的冻结区条数(append-only 步 = 上一步的值)。 */
  frozenCount?: number;
  /** 冻结区最后的 toolCallId(loop 记住并在后续步回传,用于重定位)。 */
  anchor?: string;
  /** 本次重置估算削掉的 tokens。 */
  cutTokens?: number;
}

/** micro 阈值推导(对齐 ZCode buildDefaultMicrocompactThreshold):
 * max(0, min(⌊auto×0.9⌋, auto−2000)),auto=autoCompact 阈值(compact-gate 同源口径)。
 * 极小 auto(<2000)推导出 0 = 关闭组清理。 */
export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  const ratio = Math.floor(autoCompactThreshold * MICROCOMPACT_THRESHOLD_RATIO);
  const buffer = autoCompactThreshold - MICROCOMPACT_THRESHOLD_BUFFER_TOKENS;
  return Math.max(0, Math.min(ratio, buffer));
}

/** 增长突增判定:当前上下文估算 − 上次请求实际/估算 tokens ≥ 阈值。纯函数,便于测试。 */
export function shouldAggressivePrune(
  currentTokens: number,
  lastRequestTokens: number | undefined,
  growthSpurtTokens: number | undefined): boolean {
  if (growthSpurtTokens === undefined || growthSpurtTokens <= 0) return false;
  if (lastRequestTokens === undefined || lastRequestTokens <= 0) return false;
  return currentTokens - lastRequestTokens >= growthSpurtTokens;
}

/** 快估 token(消息数组)。
 * token 轮:assistant 的 toolCalls[].arguments 也计入——write_file 的整文件正文
 *  全在 arguments 里,旧口径只累加 content.length,导致写文件型膨胀对阈值判定完全隐形。
 *  2026-11 token 轮:token 口径统一见 agent/token-estimate.ts(真分词器 + 标定 ratio),
 *  本函数只做转调;argChars 的口径由统一模块实现,本文件不再自己算。 */
function estimateTokensLocal(messages: Message[]): number {
  return estimateMessagesTokens(messages);
}

/** 单条消息的 token 估算(token 口径统一见 agent/token-estimate.ts)。 */
function estimateMessageTokensLocal(m: Message): number {
  return estimateMessageTokens(m);
}

/** 单条消息计入 token 估算的字符数(content + toolCalls 的 id/name/arguments)。 */
function messageChars(m: Message): number {
  const content = String(m.content ?? "").length;
  const calls = m.role === "assistant" && m.toolCalls ? m.toolCalls : undefined;
  if (!calls) return content;
  return calls.reduce((sum, c) => sum + c.id.length + c.name.length + String(c.arguments ?? "").length, content);
}

/** 内容指纹(dedup 用;只取前 16 hex,碰撞概率对本场景足够低)。 */
function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** 保守识别错误结果:全量扫描,命中任一特征即保护(误判=多留,不会丢)。
 * 不用 head/tail 采样:审计经验证 8KB 中段的 ERROR 会被采样漏掉,随后 head/tail 把中段剪掉。 */
export function looksLikeErrorResult(content: string): boolean {
  if (!content) return false;
  return ERROR_MARKERS.some((re) => re.test(content));
}

function isProtectedTool(name: string, config?: MicrocompactConfig): boolean {
  if (NEVER_COMPACT_TOOLS.has(name)) return true;
  if (config?.protectIrreversible !== false && IRREVERSIBLE_TOOLS.has(name)) return true;
  return false;
}

function isProtectedResult(name: string, content: string, config?: MicrocompactConfig): boolean {
  if (isProtectedTool(name, config)) return true;
  return config?.protectErrors !== false && looksLikeErrorResult(content);
}

function capForTool(name: string, config?: MicrocompactConfig): number {
  const raw = config?.toolCaps?.[name];
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : HUGE_RESULT_CHARS;
  return Math.max(MIN_TOOL_CAP_CHARS, Math.floor(value));
}

/** 工具目标摘要:必须保留「区分查询」的参数。
 * grep 只取 path 会丢掉 pattern——不同 pattern 会被误判成同一目标而被 supersede。
 * read_file 保留 offset/limit,避免同一文件的不同窗口互相取代。 */
function toolWhere(name: string, args: Record<string, unknown>): string {
  const bits: string[] = [];
  const add = (key: string, value: unknown): void => {
    if (typeof value === "string" && value.trim()) bits.push(`${key}=${value.trim()}`);
  };
  if (name === "grep") {
    add("pattern", args.pattern);
    add("path", args.path ?? args.file_path);
    add("glob", args.glob);
  } else if (name === "glob") {
    add("pattern", args.pattern);
    add("path", args.path);
  } else {
    const primary = args.path ?? args.file_path ?? args.command ?? args.pattern ?? args.query ?? args.target;
    if (typeof primary === "string" && primary.trim()) bits.push(primary.trim());
  }
  if (args.offset !== undefined) bits.push(`offset=${String(args.offset)}`);
  if (args.limit !== undefined) bits.push(`limit=${String(args.limit)}`);
  return bits.join(" ").slice(0, 120);
}

/** 从 assistant 消息的 toolCalls 建 callId→(name, 关键参数摘要) 索引(占位寻址用)。 */
export function toolCallIndex(messages: Message[]): Map<string, { name: string; where: string }> {
  const idx = new Map<string, { name: string; where: string }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      let where = "";
      try {
        const a = (typeof c.arguments === "string" ? JSON.parse(c.arguments) : (c.arguments ?? {})) as Record<string, unknown>;
        where = toolWhere(c.name, a);
      } catch { /* 参数不可解析就不带寻址 */ }
      idx.set(c.id, { name: c.name, where });
    }
  }
  return idx;
}

/** 组清理候选(消息下标+寻址元数据)。 */
interface ClearCandidate {
  index: number;
  meta: { name: string; where: string };
}

/** 已是占位/已精炼的内容——不再算候选(幂等,二次处理省不出 token)。 */
function isPlaceholderContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return content.includes(HUGE_PLACEHOLDER_PREFIX)
    || content.includes(ARGS_SUMMARY_PREFIX)
    || content.startsWith("[超大工具结果已外置:")
    || content.startsWith(CLEARED_PLACEHOLDER_PREFIX)
    || content.startsWith(DEDUP_PLACEHOLDER_PREFIX)
    || content.startsWith(SUPERSEDED_PLACEHOLDER_PREFIX)
    || content.startsWith(MODEL_DROP_PLACEHOLDER_PREFIX);
}

/** 从 pruned 清单生成上下文清单(模型可见「哪些历史被折叠了、怎么回读」)。 */
export function buildContextManifest(items: readonly MicrocompactPrunedItem[]): string {
  if (items.length === 0) return "";
  const labels: Record<MicrocompactAction, string> = {
    head_tail: "头尾保留",
    cleared: "已清除",
    dedup: "重复折叠",
    superseded: "被后续调用取代",
    model_drop: "模型判定不保留(调用已记录)",
    args_summarized: "写入正文已省略(按 path 重读)",
  };
  const shown = items.slice(0, 10).map((item) =>
    `- ${item.tool} ${item.where || "(无寻址)"} — ${labels[item.action]}(${item.originalChars}→${item.newChars} 字)`,
  );
  if (items.length > 10) shown.push(`- …另有 ${items.length - 10} 条`);
  let text = [
    `[上下文清单] 已压缩/折叠 ${items.length} 条旧工具结果(需要细节可按 path/offset/command 重读):`,
    ...shown,
  ].join("\n");
  if (text.length > 1_500) text = text.slice(0, 1_450) + "\n…";
  return text;
}

/** 把 pruned 清单换算成可观测的 savedTokens。 */
function savedTokensOf(items: readonly MicrocompactPrunedItem[]): number {
  return Math.ceil(
    items.reduce((sum, item) => sum + Math.max(0, item.originalChars - item.newChars), 0) / 4);
}

function resultOf(
  messages: Message[],
  items: MicrocompactPrunedItem[],
  reason: string,
  extra?: {
    policy?: MicrocompactPolicy;
    planCount?: number;
    prefixBreak?: boolean;
    contextTokensBefore?: number;
    contextTokensAfter?: number;
    skipped?: string;
  },
): MicrocompactResult {
  return {
    messages,
    compacted: items.length,
    reason,
    pruned: items,
    manifest: buildContextManifest(items),
    savedTokens: savedTokensOf(items),
    // head_tail 精炼的是「刚到达、尚未发过」的结果 → 不改写已缓存前缀;其余动作都改历史中段。
    prefixBreak: extra?.prefixBreak ?? items.some((it) => it.action !== "head_tail"),
    ...extra,
  };
}

interface FoldResult {
  messages: Message[];
  items: MicrocompactPrunedItem[];
}

/** 单条 write/edit 调用里「正文类参数」的字符合计(content / old_string / new_string)。 */
function writeTextChars(call: ToolCall): number {
  const keys = WRITE_TEXT_ARGS[call.name];
  if (!keys) return 0;
  let parsed: Record<string, unknown>;
  try {
    parsed = (typeof call.arguments === "string" ? JSON.parse(call.arguments) : (call.arguments ?? {})) as Record<string, unknown>;
  } catch {
    return 0; // 参数不可解析:不摘要(保住原文,宁可多花 token)
  }
  return keys.reduce((sum, key) => {
    const value = parsed[key];
    return typeof value === "string" ? sum + value.length : sum;
  }, 0);
}

/** 该调用的参数是否已被摘要化(幂等键:摘要前缀出现在 arguments 里)。 */
function isArgsSummarized(call: ToolCall): boolean {
  return typeof call.arguments === "string" && call.arguments.includes(ARGS_SUMMARY_PREFIX);
}

/**
 * assistant 侧 pass:历史写入正文摘要化( token 轮)。
 * 病根:write_file 的整文件正文全部躺在 assistant.toolCalls[].arguments 里,写入成功后就是死重
 * ——文件内容已经落盘,模型真要再看必须 read_file(而 read_file 结果本身有 head/tail+组清理治理)。
 * 只保留**最近 1 条**写入的完整正文(热区逐字:模型刚写完,正在自检/贴诊断),更早的换成摘要。
 * 摘要必须是**合法 JSON 且保留 path**:toolWhere 靠 path 生成占位寻址,derive/tool 配对也只看 id。
 * 摘要前缀进 arguments → isPlaceholderContent 可识别 → 二次处理跳过,输出逐字节稳定。
 */
function summarizeWriteArgsPass(messages: Message[], config?: MicrocompactConfig): FoldResult {
  if (config?.summarizeWriteArgs === false) return { messages, items: [] };
  const candidates: number[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return;
    const calls = message.toolCalls.filter((c) => WRITE_TEXT_ARGS[c.name] !== undefined);
    if (calls.length === 0) return;
    if (calls.some(isArgsSummarized)) return; // 已摘要:幂等跳过
    if (config?.modelKeep && calls.some((c) => config.modelKeep?.has(c.id))) return; // 模型 keep:逐字保留
    if (calls.reduce((sum, c) => sum + writeTextChars(c), 0) < MIN_ARGS_SUMMARY_CHARS) return;
    candidates.push(index);
  });
  if (candidates.length <= 1) return { messages, items: [] }; // 最近 1 条(乃至唯一一条)保留全文

  const out = [...messages];
  const items: MicrocompactPrunedItem[] = [];
  for (const index of candidates.slice(0, -1)) {
    const message = out[index];
    if (!message || message.role !== "assistant" || !message.toolCalls) continue;
    let originalChars = 0;
    let newChars = 0;
    let label = "";
    let where = "";
    const calls = message.toolCalls.map((call) => {
      const keys = WRITE_TEXT_ARGS[call.name];
      if (!keys) return call;
      let parsed: Record<string, unknown>;
      try {
        parsed = (typeof call.arguments === "string" ? JSON.parse(call.arguments) : (call.arguments ?? {})) as Record<string, unknown>;
      } catch {
        return call;
      }
      const nextArgs: Record<string, unknown> = { ...parsed };
      let changed = false;
      for (const key of keys) {
        const value = nextArgs[key];
        // 小片段不摘要:占位可能比原文还长,而且常常就是有用信息
        if (typeof value !== "string" || value.length < MIN_SINGLE_ARGS_SUMMARY_CHARS) continue;
        if (value.includes(ARGS_SUMMARY_PREFIX)) continue;
        nextArgs[key] = `${ARGS_SUMMARY_PREFIX}${key} 共 ${value.length} 字符, 完整内容见 journal;需要原文请按此 path 重新 read_file]`;
        changed = true;
      }
      if (!changed) return call;
      const nextArguments = JSON.stringify(nextArgs);
      originalChars += call.arguments.length;
      newChars += nextArguments.length;
      if (!label) {
        label = call.name;
        where = toolWhere(call.name, parsed);
      }
      return { ...call, arguments: nextArguments };
    });
    if (originalChars === 0) continue; // 没有可读正文(参数坏/全小片段)
    out[index] = { ...message, toolCalls: calls };
    items.push({
      toolCallId: message.toolCalls[0]?.id ?? "",
      tool: label,
      where,
      action: "args_summarized",
      originalChars,
      newChars,
    });
  }
  return { messages: out, items };
}

/**
 * 全量结果去重( token 轮):**只按内容指纹**,不看工具名/寻址/保护名单。
 * 旧 foldDuplicateAndSuperseded 被三重限制(COMPACTABLE_TOOLS + where 非空 + IRREVERSIBLE_TOOLS),
 * 写工具回执因此永不折叠:经验证反复 write_file 同一文件后,每次「已覆写 xxx(1234 字节)」回执
 * 逐字相同却全部留在历史里。这一遍补上:完全相同内容的旧 tool 结果只保留最后一份。
 * toolCallId 全部保留 → tool 配对不破;只改读侧副本,journal 原文不动。
 */
function dedupIdenticalResults(
  messages: Message[],
  idx: Map<string, { name: string; where: string }>,
  config?: MicrocompactConfig): FoldResult {
  if (config?.dedupAnyTool === false) return { messages, items: [] };
  const lastByHash = new Map<string, number>();
  const hashByIndex = new Map<number, string>();
  messages.forEach((message, index) => {
    if (message.role !== "tool" || typeof message.content !== "string") return;
    if (isPlaceholderContent(message.content)) return; // 已是占位:不参与(幂等)
    const hash = contentHash(message.content);
    hashByIndex.set(index, hash);
    lastByHash.set(hash, index);
  });
  if (hashByIndex.size === 0) return { messages, items: [] };

  const out = [...messages];
  const items: MicrocompactPrunedItem[] = [];
  const hotTailStart = messages.length - DEDUP_MIN_AGE_MESSAGES;
  for (const [index, hash] of [...hashByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (lastByHash.get(hash) === index) continue; // 最后一份保留全文
    if (index >= hotTailStart) continue; // 热区:不就地改写(前缀缓存稳定,见 DEDUP_MIN_AGE_MESSAGES)
    const message = out[index];
    if (!message || message.role !== "tool") continue;
    const meta = idx.get(message.toolCallId);
    const original = String(message.content ?? "");
    const where = meta?.where ?? "";
    const placeholder = `${DEDUP_PLACEHOLDER_PREFIX}${meta?.name ?? "tool"}${where ? ` ${where}` : ""} 与前一份内容完全相同,仅保留最后一份(原 ${original.length} 字符)——需要时按原参数重取]`;
    out[index] = { ...message, content: placeholder };
    items.push({
      toolCallId: message.toolCallId,
      tool: meta?.name ?? "tool",
      where,
      action: "dedup",
      originalChars: original.length,
      newChars: placeholder.length,
    });
  }
  return { messages: out, items };
}

/**
 * 确定性 dedup/supersede:只动 COMPACTABLE_TOOLS 且未受保护的结果。
 * - dedup:相同 (tool, 寻址, 内容) 的旧副本折叠,保留最新;
 * - supersede:只读可重跑工具同 (tool, 寻址) 的旧结果,若新旧都不是错误,标记为被取代。
 * 占位仍保留 toolCallId,工具调用/结果配对不被破坏。
 */
function foldDuplicateAndSuperseded(
  messages: Message[],
  idx: Map<string, { name: string; where: string }>,
  config?: MicrocompactConfig): FoldResult {
  const eligible = new Map<number, { tool: string; where: string; content: string }>();
  messages.forEach((message, index) => {
    if (message.role !== "tool" || typeof message.content !== "string") return;
    const meta = idx.get(message.toolCallId);
    if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) return; // 无寻址=不可回读,不参与折叠
    if (config?.modelKeep?.has(message.toolCallId)) return; // 模型高置信度 keep:全量保护
    if (isPlaceholderContent(message.content)) return;
    if (isProtectedResult(meta.name, message.content, config)) return;
    eligible.set(index, { tool: meta.name, where: meta.where, content: message.content });
  });

  const actionByIndex = new Map<number, "dedup" | "superseded">();

  if (config?.dedup !== false) {
    const seen = new Map<string, number>();
    for (const [index, entry] of eligible) {
      const key = `${entry.tool}\0${entry.where}\0${contentHash(entry.content)}`;
      const previous = seen.get(key);
      if (previous !== undefined && !actionByIndex.has(previous)) {
        actionByIndex.set(previous, "dedup");
      }
      seen.set(key, index);
    }
  }

  if (config?.supersede !== false) {
    const seenTarget = new Map<string, number>();
    for (const [index, entry] of eligible) {
      if (actionByIndex.has(index)) continue;
      if (!SUPERSEDABLE_TOOLS.has(entry.tool)) continue;
      const key = `${entry.tool}\0${entry.where}`;
      const previous = seenTarget.get(key);
      if (previous !== undefined && !actionByIndex.has(previous)) {
        const old = eligible.get(previous);
        if (old && !looksLikeErrorResult(old.content) && !looksLikeErrorResult(entry.content)) {
          actionByIndex.set(previous, "superseded");
        }
      }
      seenTarget.set(key, index);
    }
  }

  if (actionByIndex.size === 0) return { messages, items: [] };

  const out = [...messages];
  const items: MicrocompactPrunedItem[] = [];
  for (const [index, action] of [...actionByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const message = out[index];
    if (!message || message.role !== "tool") continue;
    const meta = idx.get(message.toolCallId);
    if (!meta) continue;
    const original = String(message.content ?? "");
    const placeholder = action === "dedup"
      ? `${DEDUP_PLACEHOLDER_PREFIX}${meta.name} ${meta.where} 与后续相同调用结果一致,原文已折叠——需要时按上述寻址参数重读]`
      : `${SUPERSEDED_PLACEHOLDER_PREFIX}${meta.name} ${meta.where} 原共 ${original.length} 字符——需要旧内容时按上述寻址参数重读]`;
    out[index] = { ...message, content: placeholder };
    items.push({
      toolCallId: message.toolCallId,
      tool: meta.name,
      where: meta.where,
      action,
      originalChars: original.length,
      newChars: placeholder.length,
    });
  }
  return { messages: out, items };
}

/**
 * microcompact(读侧工具结果治理),两条独立路径:
 * ①超大结果精炼(head/tail;per-tool cap 可覆写);
 * ②阈值触发的组清理(保留最近 keepRecent 组,更早的清为可寻址占位)。
 * 两者之前先做 dedup/supersede;错误/认知/不可逆结果硬保护。
 * 未配置 thresholdTokens=路径②关闭(向后兼容)。
 */
/**
 * 入口分发( v2):
 * - 传了 `policyState`(loop 每步都传)→ cache-aware 冻结区/重置策略(前缀稳定优先);
 * - 未传(单测旧构造点、auto-compact pre-prune、`cacheAware:false`)→ 旧全量管线,行为逐字不变。
 */
export function microcompactMessages(
  messages: Message[],
  config?: MicrocompactConfig): MicrocompactResult {
  // 缺省「未配置 microcompact(无阈值)= 旧行为逐字不变」:此时不进 cache-aware 管线,
  // 否则 dedup / args 摘要 / model_drop 这些「随追加而变」的规则会被尾区渲染跳过(功能回退)。
  const cacheAware = config?.cacheAware !== false
    && config?.policyState !== undefined
    && (config?.thresholdTokens ?? 0) > 0;
  if (!cacheAware) return legacyMicrocompact(messages, config);
  return cacheAwareMicrocompact(messages, config as MicrocompactConfig);
}

/** 旧全量管线(会就地改写历史中段的每一条):只在无策略态时使用,以及作为冻结区/尾区的渲染器。 */
function legacyMicrocompact(
  messages: Message[],
  config?: MicrocompactConfig): MicrocompactResult {
  const idx = toolCallIndex(messages);
 // 回归安全顺序(读侧历史裁剪):
  // ①assistant 写入正文摘要化、②全量结果去重——两者都**只消费派生消息副本**:
  //   去重的"最后一份"判定若跑在②之后会对外置/精炼文本做二次比对,故顺序固定为:
  //   args 摘要 → 全量去重(未折叠前的内容指纹)→ 旧 dedup/supersede → head/tail → 组清理。
  const argsSummary = summarizeWriteArgsPass(messages, config);
  const anyDedup = dedupIdenticalResults(argsSummary.messages, idx, config);
  const folded = foldDuplicateAndSuperseded(anyDedup.messages, idx, config);
  const items: MicrocompactPrunedItem[] = [...argsSummary.items, ...anyDedup.items, ...folded.items];

 // 净收益门:就地改写历史中段 = 该处之前所有 token 的前缀缓存全部失效。
 // 经验证事故:57k 前缀只裁掉一条 500 字符旧结果,当轮 input 全量重算(cached=0),多花 5.7 万 token ——
  // 省 125 token、亏 1.4 万 token,净亏 100 倍。故裁剪前先算账:省得不够就不裁。
  // 只管「纯为省 token」的两类(args_summarized / dedup);superseded / model_drop 是**正确性**裁剪
  // (旧结果已被取代或模型判丢,留着会误导 agent),那类必须裁,不进净收益账。
  if (config?.breakEvenGate !== false) {
    const TOKEN_SAVING_ACTIONS = new Set(["args_summarized", "dedup"]);
    const savingItems = items.filter((it) => TOKEN_SAVING_ACTIONS.has(it.action));
    const mustKeepItems = items.filter((it) => !TOKEN_SAVING_ACTIONS.has(it.action));
    if (savingItems.length > 0) {
      const factor = config?.breakEvenFactor ?? BREAK_EVEN_FACTOR;
      const savedSoFar = savingItems.reduce((s, it) => s + Math.max(0, it.originalChars - it.newChars), 0);
      const savedTokens = approxTokensOfChars(savedSoFar);
      // 改写点之前的内容长度 = 会被判失效的前缀规模(取最早改写点位置)
      const breakPointChars = estimateCharsBeforeFirstRewrite(messages, savingItems, idx);
      const breakCostTokens = approxTokensOfChars(breakPointChars);
      if (breakCostTokens > 0 && savedTokens < breakCostTokens * factor) {
        // 只丢纯省 token 的那部分,正确性裁剪照做：
        // 必须从**原始 messages** 重跑(不能传 folded.messages,那里摘要已生效),
        // 并关掉两个纯省 token 的 pass;结果上保留 break-even 标记供观测。
        const retried = legacyMicrocompact(messages, {
          ...config,
          breakEvenGate: false,
          summarizeWriteArgs: false,
          dedupAnyTool: false,
        });
        return {
          ...retried,
          reason: retried.compacted > 0 ? retried.reason : "break-even-skip",
          skipped: `净收益不足:省 ${savedTokens} tok < 前缀重算 ${breakCostTokens} tok × ${factor};已跳过纯省 token 的裁剪以保住缓存`,
        };
      }
    }
  }

  // 路径①:超大结果精炼(head/tail 保留,中段剪除;未变工具/受保护结果豁免)
  const pass1 = folded.messages.map((message, index) => {
    if (message.role !== "tool" || typeof message.content !== "string") return message;
    const meta = idx.get(message.toolCallId);
    if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) return message; // 无寻址=不可回读
    if (config?.modelKeep?.has(message.toolCallId)) return message; // 模型 keep:逐字保留
    if (isPlaceholderContent(message.content)) return message;
 // 错误结果硬保护:head/tail 也不行——关键栈帧可能就在中段(审计经验证 8KB 中段被剪)。
    if (isProtectedResult(meta.name, message.content, config)) return message;
    const modelDrop = config?.modelDrop?.has(message.toolCallId) === true
      && index < folded.messages.length - MODEL_HOT_TAIL_MESSAGES;
    const content = message.content;
    if (modelDrop) {
      // 关键:模型判 drop 时不能把「调用发生过」也弄丢。正文不保留,但留一条
      // 可核账占位(工具名+寻址+原因),避免 agent 误以为没调用而反复重试。
      const marker = `${MODEL_DROP_PLACEHOLDER_PREFIX}${meta.name} ${meta.where} 原共 ${content.length} 字符;调用已发生,有效内容未保留;确有需要再按原参数重读]`;
      if (marker.length >= content.length) return message; // 小结果保留原文,避免占位比正文还长
      items.push({
        toolCallId: message.toolCallId,
        tool: meta.name,
        where: meta.where,
        action: "model_drop",
        originalChars: content.length,
        newChars: marker.length,
      });
      return { ...message, content: marker };
    }
    const cap = capForTool(meta.name, config);
    if (content.length <= cap) return message;
    const headChars = Math.min(PRUNE_HEAD_CHARS, Math.floor(cap * 0.8));
    const tailChars = Math.min(PRUNE_TAIL_CHARS, Math.max(0, cap - headChars));
    const prunedChars = content.length - headChars - tailChars;
    if (prunedChars < 200) return message; // 省不出有意义的空间,不做「越剪越长」的精炼
    const nextContent = content.slice(0, headChars)
      + `\n${HUGE_PLACEHOLDER_PREFIX}${meta.name} ${meta.where} 原共 ${content.length} 字符,中段 ${prunedChars} 字符已剪除——保留头尾;需要中段细节按上述参数精确重读(offset/limit 局部读)]\n`
      + content.slice(-tailChars);
    items.push({
      toolCallId: message.toolCallId,
      tool: meta.name,
      where: meta.where,
      action: "head_tail",
      originalChars: content.length,
      newChars: nextContent.length,
    });
    return { ...message, content: nextContent };
  });

  // 路径②:阈值触发的组清理;未配置阈值=关闭(向后兼容,绝无「无条件滚动」)
  const threshold = config?.thresholdTokens;
  if (threshold === undefined || !(threshold > 0)) {
    return resultOf(pass1, items, "huge-only");
  }
  const est = estimateTokensLocal(pass1);
  if (est < threshold) return resultOf(pass1, items, "below-threshold");

  // 分组(ZCode collectCompactableToolResultGroups 语义):assistant.toolCalls 开新组;
  // 候选=COMPACTABLE_TOOLS 且内容未占位/未受保护。认知/未知工具不入组,天然豁免。
  const groups: ClearCandidate[][] = [];
  let current: ClearCandidate[] | undefined;
  pass1.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      if (current && current.length > 0) groups.push(current);
      current = [];
      return;
    }
    if (message.role !== "tool") return;
    const meta = idx.get(message.toolCallId);
    if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) return; // 无寻址=不可回读
    if (config?.modelKeep?.has(message.toolCallId)) return; // 模型 keep:不参与组清理
    if (isPlaceholderContent(message.content)) return;
    if (isProtectedResult(meta.name, message.content, config)) return;
    const candidate = { index, meta };
    if (!current) { groups.push([candidate]); return; }
    current.push(candidate);
  });
  if (current && current.length > 0) groups.push(current);

  const keep = config?.clearAllGroups === true
    ? 0
    : Math.max(1, Math.floor(config?.keepRecent ?? DEFAULT_KEEP_RECENT_GROUPS));
  const clearGroupCount = Math.max(0, groups.length - keep);
  if (clearGroupCount === 0) return resultOf(pass1, items, "nothing-to-clear");

  const out = [...pass1];
  const clearedItems: MicrocompactPrunedItem[] = [];
  for (let groupIndex = 0; groupIndex < clearGroupCount; groupIndex++) {
    const group = groups[groupIndex];
    if (!group) continue;
    for (const candidate of group) {
      const message = out[candidate.index];
      if (!message || message.role !== "tool") continue;
      const original = String(message.content ?? "");
      const placeholder = `${CLEARED_PLACEHOLDER_PREFIX}${candidate.meta.name} ${candidate.meta.where} 原共 ${original.length} 字符——需要时按上述寻址参数重读(path/command/offset/limit)]`;
      out[candidate.index] = { ...message, content: placeholder };
      clearedItems.push({
        toolCallId: message.toolCallId,
        tool: candidate.meta.name,
        where: candidate.meta.where,
        action: "cleared",
        originalChars: original.length,
        newChars: placeholder.length,
      });
    }
  }
  // minSavings 回滚门(ZCode below_min_savings):省不足此值,清了白清(占位符本身也占 token)。
  const saved = est - estimateTokensLocal(out);
  const minSavings = config?.minSavings ?? MIN_TOKEN_SAVINGS;
  if (saved < minSavings) {
    return resultOf(pass1, items, "rolled-back");
  }
  return resultOf(out, [...items, ...clearedItems], "applied");
}

/* ───────────────────────── cache-aware v2 ───────────────────────── */

/**
 * cache-aware 渲染:冻结区 + 尾区。
 * ①冻结区 [0, frozenCount):用旧全量管线渲染(**只渲染这个固定切片**,故输出逐字节稳定);
 *   组清理由 `thresholdTokens: 1` 强制生效(重置时已定下「清哪些」,之后每步只是重放同一结果)。
 * ②尾区 [frozenCount, end):只做 head/tail 精炼——它是**单条消息自决**的幂等变换,
 *   dedup/supersede/args 摘要这类「随追加而变」的规则一律不跑(跑了就会改上一步已发出去的内容)。
 */
function cacheAwareMicrocompact(messages: Message[], config: MicrocompactConfig): MicrocompactResult {
  const state = config.policyState ?? {};
  const threshold = config.thresholdTokens ?? 0;
  const estBefore = estimateTokensLocal(messages);
  const frozenBefore = resolveFrozenCount(messages, state);
  const decision = decideReset(messages, estBefore, frozenBefore, config);
  const nextFrozen = decision.frozenCount;

  const rendered = renderFrozenAndTail(messages, nextFrozen, config);
  const estAfter = estimateTokensLocal(rendered.messages);
  const isReset = policyBreaksPrefix(decision.policy);

  return {
    messages: rendered.messages,
    compacted: rendered.items.length,
    reason: decision.reason,
    pruned: rendered.items,
    manifest: buildContextManifest(rendered.items),
    savedTokens: savedTokensOf(rendered.items),
    ...(decision.skipped ? { skipped: decision.skipped } : {}),
    policy: decision.policy,
    // planCount = 本次「新进入冻结区」而被清掉的项数(重置规模);append-only 步为 0。
    planCount: isReset ? decision.clearedItems : 0,
    prefixBreak: isReset,
    contextTokensBefore: estBefore,
    contextTokensAfter: estAfter,
    frozenCount: nextFrozen,
    ...(rendered.anchor ? { anchor: rendered.anchor } : {}),
    ...(decision.cutTokens !== undefined ? { cutTokens: decision.cutTokens } : {}),
  };
}

/** 这个 policy 是否改写了「已发出去的前缀」。 */
function policyBreaksPrefix(policy: MicrocompactPolicy): boolean {
  return policy === "reset" || policy === "growth-spurt";
}

/** 定位冻结区条数:优先用 anchor(toolCallId)在历史里重新定位,缺失则退回 frozenCount。 */
function resolveFrozenCount(messages: Message[], state: MicrocompactPolicyState): number {
  const raw = typeof state.frozenCount === "number" && Number.isFinite(state.frozenCount)
    ? Math.floor(state.frozenCount)
    : 0;
  if (raw <= 0) return 0;
  const target = Math.min(raw, messages.length);
  if (!state.frozenAnchor) return target;
  // 锚点自校验:锚点应正好落在 frozenCount-1 的消息上;否则说明历史被重压/重建过,重新定位。
  const last = messages[target - 1] as { toolCallId?: string } | undefined;
  if (last?.toolCallId === state.frozenAnchor) return target;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { toolCallId?: string })?.toolCallId === state.frozenAnchor) return i + 1;
  }
  return 0; // 锚点不存在(硬压缩切掉/重放失败)→ 冻结区作废,从头开始
}

/** 重置决策:何时允许推进冻结区、推进到哪、削多少。纯函数(便于单测)。 */
function decideReset(
  messages: Message[],
  est: number,
  frozenCount: number,
  config: MicrocompactConfig): {
  policy: MicrocompactPolicy;
  frozenCount: number;
  reason: string;
  skipped?: string;
  clearedItems: number;
  cutTokens?: number;
} {
  const threshold = config.thresholdTokens ?? 0;
  const keepAppendOnly = (reason: string, skipped?: string) => ({
    policy: "append-only" as const,
    frozenCount,
    reason,
    ...(skipped ? { skipped } : {}),
    clearedItems: 0,
  });
  const skip = (policy: MicrocompactPolicy, skipped: string) => ({
    policy, frozenCount, reason: policy, skipped, clearedItems: 0,
  });

  // 阈值未配置 = 路径②关闭:只做 head/tail(仍是 append-only 安全)。
  if (!(threshold > 0)) return keepAppendOnly("huge-only");

  const state = config.policyState ?? {};
  const groups = collectClearGroups(messages, config);
  const keep = Math.max(1, Math.floor(config?.keepRecent ?? DEFAULT_KEEP_RECENT_GROUPS));

  // 增长突增档(装配方显式配置):按 keepRecent 清到窗口外,不受冷却/水位/同 turn 上限约束。
  if (state.force) {
    const boundary = groups.length > keep ? groups[groups.length - 1] : undefined;
    void boundary;
    const cleared = groups.slice(0, Math.max(0, groups.length - keep));
    if (cleared.length === 0) return skip("deferred", "增长突增但没有窗口外的候选组");
    const nextFrozen = lastIndexAfter(cleared) + 1;
    return {
      policy: "growth-spurt",
      frozenCount: nextFrozen,
      reason: "growth-spurt",
      clearedItems: cleared.reduce((s, g) => s + g.length, 0),
      cutTokens: Math.max(1, est - estimateAfterClear(messages, cleared, config)),
    };
  }

  const minContext = config.minContextTokens
    ?? Math.min(MIN_PRUNE_CONTEXT_TOKENS, Math.floor(threshold * 0.9));
  if (est < minContext) {
    return skip("low-context-skip", `上下文 ${est} tok < 门槛 ${minContext} tok:小上下文压缩省得少、却打碎整段前缀`);
  }
  // 未到触发阈值:纯追加(前缀稳定是第一约束,不提前压)。
  if (est < threshold) return keepAppendOnly("below-threshold");

  // 冷却:重置后须再增长 ≥ RESET_COOLDOWN_TOKENS 或过 ≥ RESET_COOLDOWN_STEPS 步(turn 首步可越)。
  const cooldownTokens = config.resetCooldownTokens ?? RESET_COOLDOWN_TOKENS;
  const cooldownSteps = config.resetCooldownSteps ?? RESET_COOLDOWN_STEPS;
  if (!state.turnStart && state.lastResetClock !== undefined) {
    const stepsSince = (state.clock ?? 0) - state.lastResetClock;
    const growth = est - (state.lastResetTokens ?? 0);
    if (stepsSince < cooldownSteps && growth < cooldownTokens) {
      return skip("cooldown-skip", `距上次重置 ${stepsSince} 步、仅增 ${growth} tok(需 ≥${cooldownSteps} 步或 ≥${cooldownTokens} tok):冷却期内不动前缀`);
    }
  }
 // 同 turn 上限(≤1)。
  const maxPerTurn = config.maxResetsPerTurn ?? MAX_RESETS_PER_TURN;
  if ((state.resetsThisTurn ?? 0) >= maxPerTurn) {
    return skip("turn-cap-skip", `本 turn 已重置 ${state.resetsThisTurn} 次(上限 ${maxPerTurn}):下 turn 前保持前缀稳定`);
  }

  // 目标基线 = 触发阈值 × 88%;削减量夹在 [最小批量, est×20%]。
  const target = Math.floor(threshold * (config.resetTargetRatio ?? RESET_TARGET_RATIO));
  const wanted = est - target;
  const cap = Math.floor(est * (config.maxResetCutRatio ?? MAX_RESET_CUT_RATIO));
  const cutTarget = Math.min(wanted, cap);
  const minBatch = config.pruneMinBatchTokens ?? PRUNE_MIN_BATCH_TOKENS;
  if (cutTarget < minBatch) {
    return skip("deferred", `需要削减 ${cutTarget} tok < 最小批量 ${minBatch} tok:等涨到值得一次重置的水位`);
  }
  // 收益门:一次重置 = 当前 input 全量重算;削掉的量要在保守剩余调用里回本。
  const calls = config.assumedRemainingCalls ?? PRUNE_ASSUMED_REMAINING_CALLS;
  if (calls > 0 && cutTarget * calls < est) {
    return skip("benefit-skip", `削减 ${cutTarget} tok × 剩余 ${calls} 次 = ${cutTarget * calls} tok < 一次前缀失效 ${est} tok:不划算`);
  }

  // 从冻结区之后按组累积,直到累计节省 ≥ cutTarget(只清窗口外的组;最近 keep 组留原文)。
  const candidates = groups.slice(0, Math.max(0, groups.length - keep));
  const chosen: typeof candidates = [];
  let saved = 0;
  for (const group of candidates) {
    if (lastIndexAfter([group]) + 1 <= frozenCount) continue; // 已在冻结区内的组不重复计入
    const gain = estimateGroupSavings(group, messages);
 // 上限硬约束(禁 250k→160k 大跳):再加这一组就超 est×20% 且已有可清组,就停手。
 // 不夹住的话,「凑够 cutTarget 的最后一组」会把削减量顶到 cap 之外(经验证 1368 > 1038)。
    if (chosen.length > 0 && saved + gain > cap) break;
    chosen.push(group);
    saved += gain;
    if (saved >= cutTarget) break;
  }
  if (chosen.length === 0 || saved < minBatch) {
    return skip("deferred", `窗口外可清组仅省 ${saved} tok(需 ${minBatch} tok):攒够再一次重置`);
  }
  return {
    policy: "reset",
    frozenCount: lastIndexAfter(chosen) + 1,
    reason: "applied",
    clearedItems: chosen.reduce((s, g) => s + g.length, 0),
    cutTokens: saved,
  };
}

/** 一组候选组里最大的消息下标(冻结区终点 = 它 + 1)。 */
function lastIndexAfter(groups: ClearCandidate[][]): number {
  let last = -1;
  for (const group of groups) for (const c of group) if (c.index > last) last = c.index;
  return last;
}

/** 渲染:冻结区用旧全量管线(清空强制生效),尾区只做 head/tail;两侧拼回。 */
function renderFrozenAndTail(
  messages: Message[],
  frozenCount: number,
  config: MicrocompactConfig): { messages: Message[]; items: MicrocompactPrunedItem[]; anchor?: string } {
  const frozenSlice = messages.slice(0, frozenCount);
  const tailSlice = messages.slice(frozenCount);
  const items: MicrocompactPrunedItem[] = [];
  const out: Message[] = [];
  if (frozenSlice.length > 0) {
    // 冻结区:thresholdTokens=1 强制清空生效(清哪些在重置时已定,这里只是重放);
    // breakEvenGate 关闭(重置本身已经算过账),minSavings=0(不做二次回滚——回滚会改前缀)。
    const frozenRendered = legacyMicrocompact(frozenSlice, {
      ...config,
      policyState: undefined,
      thresholdTokens: 1,
      minSavings: 0,
      breakEvenGate: false,
      // 冻结边界已在 decideReset 定死:渲染阶段必须把切片内候选组**全清**,
      // 否则「算了省 9 组、实际只清 7 组」,下次 decideReset 又要多压一批 → 变成多次小重置。
      clearAllGroups: true,
    });
    out.push(...frozenRendered.messages);
    items.push(...(frozenRendered.pruned ?? []));
  }
  if (tailSlice.length > 0) {
    // 尾区:只做 head/tail(单条自决 + 幂等 → 与上一步逐字节相同)。
    const idx = toolCallIndex(messages);
    const tailItems: MicrocompactPrunedItem[] = [];
    for (const message of tailSlice) {
      out.push(refineHugeResult(message, idx, config, tailItems) ?? message);
    }
    items.push(...tailItems);
  }
  const lastFrozen = frozenCount > 0 ? messages[frozenCount - 1] as { toolCallId?: string } : undefined;
  return {
    messages: out,
    items,
    ...(lastFrozen?.toolCallId ? { anchor: lastFrozen.toolCallId } : {}),
  };
}

/** 单条消息的 head/tail 精炼(与 legacy 路径①同语义;返回新消息或 undefined=不变)。 */
function refineHugeResult(
  message: Message,
  idx: Map<string, { name: string; where: string }>,
  config: MicrocompactConfig | undefined,
  items: MicrocompactPrunedItem[],
): Message | undefined {
  if (message.role !== "tool" || typeof message.content !== "string") return undefined;
  const meta = idx.get(message.toolCallId);
  if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) return undefined;
  if (config?.modelKeep?.has(message.toolCallId)) return undefined;
  if (isPlaceholderContent(message.content)) return undefined;
  if (isProtectedResult(meta.name, message.content, config)) return undefined;
  const cap = capForTool(meta.name, config);
  const content = message.content;
  if (content.length <= cap) return undefined;
  const headChars = Math.min(PRUNE_HEAD_CHARS, Math.floor(cap * 0.8));
  const tailChars = Math.min(PRUNE_TAIL_CHARS, Math.max(0, cap - headChars));
  const prunedChars = content.length - headChars - tailChars;
  if (prunedChars < 200) return undefined;
  const nextContent = content.slice(0, headChars)
    + `\n${HUGE_PLACEHOLDER_PREFIX}${meta.name} ${meta.where} 原共 ${content.length} 字符,中段 ${prunedChars} 字符已剪除——保留头尾;需要中段细节按上述参数精确重读(offset/limit 局部读)]\n`
    + content.slice(-tailChars);
  items.push({
    toolCallId: message.toolCallId,
    tool: meta.name,
    where: meta.where,
    action: "head_tail",
    originalChars: content.length,
    newChars: nextContent.length,
  });
  return { ...message, content: nextContent };
}

/** 收集可清的候选组(与 legacy 路径②同一口径:assistant.toolCalls 开新组;保护面逐字保留)。 */
function collectClearGroups(messages: Message[], config?: MicrocompactConfig): ClearCandidate[][] {
  const idx = toolCallIndex(messages);
  const groups: ClearCandidate[][] = [];
  let current: ClearCandidate[] | undefined;
  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      if (current && current.length > 0) groups.push(current);
      current = [];
      return;
    }
    if (message.role !== "tool") return;
    const meta = idx.get(message.toolCallId);
    if (!meta || !meta.where || !COMPACTABLE_TOOLS.has(meta.name)) return;
    if (config?.modelKeep?.has(message.toolCallId)) return;
    if (isPlaceholderContent(message.content)) return;
    if (isProtectedResult(meta.name, message.content, config)) return;
    const candidate = { index, meta };
    if (!current) { groups.push([candidate]); return; }
    current.push(candidate);
  });
  if (current && current.length > 0) groups.push(current);
  return groups;
}

/** 估算「清掉这些组」能省多少 tokens(占位长度按常数估)。 */
function estimateGroupSavings(group: ClearCandidate[] | undefined, messages: Message[]): number {
  if (!group || group.length === 0) return 0;
  let sum = 0;
  for (const candidate of group) {
    const message = messages[candidate.index];
    const original = typeof message?.content === "string" ? message.content : "";
    if (!original) continue;
    const placeholderEst = Math.min(
      original.length,
      CLEARED_PLACEHOLDER_EST_CHARS + candidate.meta.name.length + candidate.meta.where.length);
    sum += Math.max(0, estimateTokensOfText(original) - placeholderEst * ASCII_TOKENS_PER_CHAR);
  }
  return Math.ceil(sum);
}

function estimateAfterClear(messages: Message[], groups: ClearCandidate[][], config?: MicrocompactConfig): number {
  return estimateTokensLocal(messages) - groups.reduce((s, g) => s + estimateGroupSavings(g, messages), 0);
}

