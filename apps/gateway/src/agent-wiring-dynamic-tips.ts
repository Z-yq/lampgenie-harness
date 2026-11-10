/**
 * 任务内「动态指导」行式卡(J1 token 轮,2026-11)。
 * 定位:与 agent-wiring-sop-tips.ts 的五硬阶段卡同族——同样是行式短句卡(一行一个动作、动词开头、
 * 每卡 ≤DYN_TIP_MAX_LINES 行),区别只在触发源:
 * - SOP 卡按 **phase 首见** 触发(阶段事件驱动,一次为限);
 * - 动态卡按 **任务内步态信号** 触发(连续改同一文件 / 反复验证仍带错 / 步数很多却没落板),
 *   由 buildLoopTips 每步算一次信号再逐条按 key 注入。
 * 为什么不塞进 SOP_TIPS:sop: 前缀的 key 与阶段一一对应(有 phase 才有卡),而这三卡的触发与
 * phase 无关(implement 阶段里也可能连改同一文件 5 步),混在一张表里会让「一次为限」的 episode
 * 语义与阶段绑定,反而说不清。
 * 本文件是**纯函数 + 常量**(零 io、零状态):判定口径可在 apps/gateway/test/dynamic-tips.test.ts
 * 单独构造信号直测,不依赖 buildLoopTips 的闭包状态。
 * 文案出处:全部为本仓已验证教训(见各卡注释),不新造纪律;行式、不喊口号。
 */

/** 每卡行数上限(含标题行);dynamic-tips.test.ts 逐卡断言。 */
export const DYN_TIP_MAX_LINES = 6;

/**
 * 三张任务内动态卡(键=注入 key 的后缀,完整 key 形如 `dyn:hypothesis`)。
 */
export const DYN_TIPS = {
  /** 触发:同一文件连续 ≥3 步被改动(fileEditStreak[file]>=3)。
   *  出处:systematic-debugging「先立假设再动手」+ 收尾纪律「同一逻辑最多 2 轮」——
   *  连改同一文件多步的典型失败形态是「边猜边补」,每步补一处、永远不验证。 */
  hypothesis: [
    "动态·先立假设(同一文件连改 3 步)",
    "先说一句「我赌根因是 X」再动手(最近变更优先)",
    "改一笔立刻验一次,别攒三处再一起验",
    "同一逻辑第 3 轮仍不对 → 停手写最小复现,换思路",
  ],
  /** 触发:验证轮次 ≥2 且 totalErrors>=2。
 * 出处:builtin/systematic-debugging「失败即停」+ 经验证 shotgun 形态(连换 5 条命令都不看输出)。 */
  verifyStop: [
    "动态·失败即停(已验证 2 轮仍带错)",
    "停下先复现:最小命令 + 最小输入,确认能稳定变红",
    "只改一条假设对应的那一处,别一次补齐所有猜测",
    "两次验证仍红 → 回到复现结论,不换等价命令硬试",
  ],
  /** 触发:step>40 且本任务从未落过板(boardTouched===false)。
   *  出处:规划纪律「多文件/多模块 → 落板,验收 accept 带可执行命令」——40 步还没落板
   *  通常是边做边飘,阶段锚已经丢了。 */
  phaseAlign: [
    "动态·阶段对齐(步数 40+ 未落板)",
    "先 board_upsert 落阶段锚(目标/子目标/验收命令)",
    "回看轨迹:偏离目标的探索分支砍掉",
    "剩余动作按依赖排序,同批无依赖动作一起发",
  ],
  /** 触发:step≥12 且 lastVerifyStep 有值且 step-lastVerifyStep≥10(工作 10 步未验证)。
 * 出处:经验证长会话最常见的失效形态——连改十步不跑一次测试,错误攒成一堆后无法定位是谁引入的。
   *  lastVerifyStep 缺省(从未验证过)=不触发:那时该说的是「先跑第一轮验证」,由 SOP 卡负责。 */
  verifyCadence: [
    "动态·验证节奏(已工作 10 步未验证)",
    "先跑一条最小验证:最小测试命令或最小复现",
    "把验证结果记进进展(phase/step/note)再继续",
    "验证红了就停下改那一处,别接着改下一处",
  ],
  /** 触发:step≥25 且本任务从未 spawn_subagent 且 tokensSpent≥120k(上下文已重)。
 * 出处:J1 token 轮经验证——单轨长读是上下文膨胀主因,独立调研/批量读取本可隔离在子代理里。 */
  delegate: [
    "动态·上下文委派(步数 25+ 且上下文已重)",
    "把下一段独立调研/批量读取派给 spawn_subagent",
    "主轨只收结论与改动点,不自己逐文件读原文",
    "隔离上下文:子代理读的原文不进主线窗口",
  ],
} as const;

/** 动态卡 key(注入 key + `tip.injected` 分类展示用)。 */
export type DynTipKey =
  | "dyn:hypothesis"
  | "dyn:verify-stop"
  | "dyn:phase-align"
  | "dyn:verify-cadence"
  | "dyn:delegate";

/** 动态卡判定信号(buildLoopTips 每步算好后交进来;纯数据,便于单测构造)。 */
export interface DynSignals {
  /** 上一步工具调用涉及的文件夹具参数(path/file_path/file)。 */
  lastStepFiles: string[];
  /** 本任务内每个文件已连续被改动多少步(非连续即归零;由装配方闭包维护)。 */
  fileEditStreak: Record<string, number>;
  /** 本任务内已发生的验证轮次(跑了验证类工具——测试/命令/终端——的步数;由装配方闭包维护)。 */
  verifyRounds: number;
  /** 本任务内累计工具错误数。 */
  totalErrors: number;
  /** 当前步号(1-based)。 */
  step: number;
  /** 本任务内是否已落过板(ctx.lastStepTools 里出现过 board_upsert 即 true)。 */
  boardTouched: boolean;
  /** 上一次跑验证类工具的步号(从未验证=undefined → verify-cadence 卡不触发;旧调用方不传=零行为变化)。 */
  lastVerifyStep?: number;
  /** 本任务内是否已 spawn_subagent 过(缺省 undefined 按「无信号不触发」处理)。 */
  spawnedSubagent?: boolean;
  /** 本任务累计消耗 tokens(缺省 undefined 按「无信号不触发」处理)。 */
  tokensSpent?: number;
}

/** 同一文件连续改动步数阈值(hypothesis 卡)。 */
export const DYN_HYPOTHESIS_FILE_STREAK = 3;
/** 验证轮次阈值(verifyStop 卡)。 */
export const DYN_VERIFY_STOP_ROUNDS = 2;
/** 累计错误阈值(verifyStop 卡)。 */
export const DYN_VERIFY_STOP_ERRORS = 2;
/** 步数阈值(phaseAlign 卡)。 */
export const DYN_PHASE_ALIGN_STEP = 40;
/** 起始步数阈值(verify-cadence 卡:步数太少不必提醒节奏)。 */
export const DYN_VERIFY_CADENCE_STEP = 12;
/** 距上次验证的步数间隔阈值(verify-cadence 卡:工作 10 步未验证)。 */
export const DYN_VERIFY_CADENCE_GAP = 10;
/** 步数阈值(delegate 卡)。 */
export const DYN_DELEGATE_STEP = 25;
/** 累计 token 阈值(delegate 卡:上下文已重)。 */
export const DYN_DELEGATE_TOKENS = 120_000;

/**
 * 判定本步该注入哪些动态卡(纯函数,**无 gate / 无 fired 语义**——那两层在 buildLoopTips)。
 * 返回顺序固定:hypothesis → verify-stop → phase-align → verify-cadence → delegate
 * (先具体动作、后泛化的上下文治理;新卡追加末尾,既有三卡相对顺序不变)。
 */
export function dynTipKeys(sig: DynSignals): DynTipKey[] {
  const out: DynTipKey[] = [];
  const streakHit = Object.keys(sig.fileEditStreak).some((f) => (sig.fileEditStreak[f] ?? 0) >= DYN_HYPOTHESIS_FILE_STREAK);
  if (streakHit) out.push("dyn:hypothesis");
  if (sig.verifyRounds >= DYN_VERIFY_STOP_ROUNDS && sig.totalErrors >= DYN_VERIFY_STOP_ERRORS) out.push("dyn:verify-stop");
  if (sig.step > DYN_PHASE_ALIGN_STEP && sig.boardTouched === false) out.push("dyn:phase-align");
  // verify-cadence:有验证历史(lastVerifyStep 有值)且已连着 10 步没验证;从未验证=不触发此卡。
  if (
    sig.step >= DYN_VERIFY_CADENCE_STEP
    && sig.lastVerifyStep !== undefined
    && sig.step - sig.lastVerifyStep >= DYN_VERIFY_CADENCE_GAP
  ) out.push("dyn:verify-cadence");
  // delegate:步数够 + 从未派过子代理 + 上下文已重(三条件同时满足;可选字段缺省=无信号不触发)。
  if (
    sig.step >= DYN_DELEGATE_STEP
    && sig.spawnedSubagent === false
    && (sig.tokensSpent ?? 0) >= DYN_DELEGATE_TOKENS
  ) out.push("dyn:delegate");
  return out;
}

/** 卡文本(行 join("\n"));未知 key 返回空串(调用方按空=不注入处理)。 */
export function dynTipText(key: DynTipKey): string {
  if (key === "dyn:hypothesis") return (DYN_TIPS.hypothesis as readonly string[]).join("\n");
  if (key === "dyn:verify-stop") return (DYN_TIPS.verifyStop as readonly string[]).join("\n");
  if (key === "dyn:phase-align") return (DYN_TIPS.phaseAlign as readonly string[]).join("\n");
  if (key === "dyn:verify-cadence") return (DYN_TIPS.verifyCadence as readonly string[]).join("\n");
  if (key === "dyn:delegate") return (DYN_TIPS.delegate as readonly string[]).join("\n");
  return "";
}
