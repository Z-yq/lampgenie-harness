/**
 * 压缩闸门(「动不动上下文已压缩」根治; 阈值语义收敛):
 * 纯函数判定一次 auto-compact 是否该发起。此前三个洞:
 * ①used 扫描不认 compact.done 边界——压缩后旧 usage 仍被当作当前上下文,刚压完又压(锯齿);
 * ②基线问题无检测——系统提示+记忆注入本身贴着阈值时,压缩压不动基线,每步重压纯烧钱;
 * ③触发原因不可见——用户只看到「上下文已压缩」刷屏,不知道为什么。
 * 闸门输出 fire/force/threshold/used + baselineNotice(基线超阈时给一条可解释的系统提示)。
 * 两处收敛:
 * ④阈值优先序:模型声明 contextWindow → 阈值=窗口口径(改为 ZCode 输出预留式,见下);
 *   未声明窗口 → 显式阈值(fallback,config agent.compactThresholdTokens / env 兜底)生效;
 *   两者皆无 → 0.8×缺省窗口 1M=800_000(宁晚不早;旧缺省 24k 是「动不动压缩」的阈值根因)。
 * ⑤边界识别只认「带摘要的 compact.done」——真压缩(autoCompact)恒写 summary;旧 microcompact
 * 曾写无摘要的 compact.done(占位机制, 起已不再写),此前被当成边界把 used 清零,
 *   闸门在真上下文很大时误走 est 兜底路径。历史 journal(重启恢复的旧会话)同此过滤。
 * O3(口径对齐 ZCode compact/policy.ts):窗口已知时阈值不再用「窗口×80%」,
 * 而是 effectiveContextWindow = 窗口 − min(maxOutputTokens ?? 32000, 21000),再减 13000 buffer。
 * provider 的 contextWindow 是 input+output 共享窗口,压缩只能让出输入侧,扣输出预留才是同一把尺;
 * 显式 compactThresholdTokens 只在**无窗口声明**时兜底(不是上限、不与窗口阈值取 min)。
 */
export interface GateEvent {
  kind: string;
  sessionId?: string;
  seq?: number;
  payload?: unknown;
}

export interface GateDecision {
  /** 是否发起 autoCompact(autoCompact 内部仍有 est 二次闸)。 */
  fire: boolean;
  force: boolean;
  threshold: number;
  /** 最近一次 usage.inputTokens(只认最后一次压缩边界之后的数据)。 */
  used: number;
 /** 压缩边界后的首个经验证水位(0=边界后尚无 usage);floor ≥ 阈值 = 上次压缩没压到阈值下。 */
  floorUsed: number;
  /** true=压不动(基线≥阈值且刚压过);调用方应落一条解释性系统提示。 */
  baseline: boolean;
  agentMsgsSinceCompact: number;
 /** effort 档位对阈值的缩放系数(四档联动;1=未缩放)。 */
  effortRatio: number;
}

/** 压缩阈值×思考力度四档联动(阈值跟聊天窗的思考力度自动调整)。
 * xhigh(最高)=与模型上下文窗口配置一致的口径(窗口−输出预留−buffer,不缩放);
 * low/medium/high 按比例提前压缩——低力度对话不值得背大上下文,高力度深任务给满窗口。
 * 未配置/空串/未知值=1.0(与既有行为逐字节一致,热更新改档位下个判定即生效)。 */
export const EFFORT_COMPACT_RATIOS: Record<string, number> = {
  low: 0.35,
  medium: 0.55,
  high: 0.75,
  xhigh: 1.0,
};

/** effort 归一:空串/未知值 → 1.0(保守,不改既有行为)。 */
export function effortCompactRatio(effort: string | undefined): number {
  if (!effort) return 1.0;
  return EFFORT_COMPACT_RATIOS[String(effort).trim().toLowerCase()] ?? 1.0;
}

/** 压缩触发线=模型上下文窗口的 80%(ZCode ContextWindow 语义)。 */
export const COMPACT_WINDOW_RATIO = 0.8;
/** 未声明 contextWindow 时的缺省窗口 tokens(1M;宁晚不早——缺省宁可压得晚)。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
/** O3:输出预留缺省(对齐 ZCode policy.ts DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS)。 */
export const AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
/** 预留上限(provider 窗口是 input+output 共享,压缩只能让出输入侧;ZCode 经验证封顶 21k)。 */
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
/** 安全 buffer(对齐 ZCode AUTOCOMPACT_BUFFER_TOKENS)。 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * 压缩阈值的绝对封顶( token 轮 03)。
 * 背景(今日 journal/sessions 全量经验证,12 个会话 / 1115 次调用 / input 2.94 亿):
 * - 窗口口径单独使用时,1M 窗口算出 966k 阈值 = 事实上的「永不压缩」。经验证单会话 messages
 *   涨到 1887 条、单次 input 92 万(assistant 占 44%)仍在重发;全天 compact.done 只有 3 次。
 * - 单次 input 中位 239,618、p90 449,593——即「正常步骤」就已经在 24 万量级,
 *   这是历史无界增长的直接后果,不是异常值。
 * - 把超阈部分削到 cap 的上界收益:cap=300k 时 26.9%、cap=200k 时 45.1%(但更伤正常步)。
 * 取值 300_000:高于经验证中位(239,618)约 1.25 倍,只截断病态长会话而不误伤正常步;
 * 上界收益 26.9%,再往下调(200k)反而会把过半调用变成压缩触发点。
 * env GENIE_MAX_COMPACT_TOKENS 可覆盖(0=关闭封顶,回到纯窗口口径)。
 */
export const MAX_COMPACT_TOKENS = 300_000;

/**
 * 强压倍数:used ≥ 阈值 × 此倍数时,忽略基线抑制窗强制压一次。
 * 基线抑制窗（BASELINE_QUIET_MSGS）本意是防「刚压完仍超阈 → 重压 → 仍超」的死循环烧钱,
 * 但它同时拦住了「历史涨得太多」的正常强压:经验证单步工具结果动辄数万 token,一步就能把
 * used 从 18 万推到 25 万,而 agentMsgsSinceCompact 当时是 1 → 被当「压不动」放行。
 * 1.2 倍的取值:一次正常压缩后基线通常回到阈值 40% 以下,再涨到 1.2 倍说明是真实增长而非基线。
 * floor 护栏(死亡螺旋根治):hardOver 旁路只许救「真实增长」——判定依据是
 * floorUsed(压缩边界后的首个经验证水位)< 阈值(证明上次压缩有效,后来又涨上去)。
 * floor ≥ 阈值 = 上次压缩根本没压到阈值之下(基线/注入块在阈值上,或 used 混入了共享
 * journal 的子代理用量),此时强压只会把已经缩小的对话史反复重压:web-1793696471953 注意
 * 60 次连环强压,每次只压 12 条消息、原始用户消息全部丢失(摘要套摘要),同时每轮烧一次
 * 摘要调用+经验沉淀调用。floor 卡死时按基线抑制处理并提示,不再强压。
 */
export const HARD_COMPACT_FACTOR = 1.2;

/** 封顶值解析:env 显式给 0 或非法值 = 关闭封顶(Infinity);缺省=MAX_COMPACT_TOKENS。 */
export function resolveMaxCompactTokens(env: string | undefined = process.env.GENIE_MAX_COMPACT_TOKENS): number {
  if (env === undefined || env.trim() === "") return MAX_COMPACT_TOKENS;
  const n = Number(env);
  if (!Number.isFinite(n) || n < 0) return MAX_COMPACT_TOKENS;
  return n === 0 ? Number.POSITIVE_INFINITY : Math.floor(n);
}

/** 输出预留 = min(maxOutputTokens ?? 32000, 21000)(ZCode 同式)。 */export function autoCompactOutputReserve(maxOutputTokens?: number): number {
  const m = maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : undefined;
  return Math.min(m ?? AUTOCOMPACT_OUTPUT_RESERVE_TOKENS, PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS);
}

/** 真压缩边界:compact.done 且带非空摘要(autoCompact 恒写;microcompact 旧事件无摘要)。 */
function isRealCompactBoundary(e: GateEvent): boolean {
  const s = (e.payload as { summary?: unknown } | null)?.summary;
  return typeof s === "string" && s.trim().length > 0;
}

/** 基线抑制窗:刚压完(边界后消息数 ≤ 此值)且 used 仍 ≥ 阈值 = 压缩压不动基线,不重压。 */
const BASELINE_QUIET_MSGS = 2;

export function autoCompactGate(
  events: GateEvent[],
  sessionId: string,
  contextWindow: number | undefined,
  fallbackThreshold: number,
 /** 模型 maxOutputTokens( O3:输出预留取 min(maxOutputTokens ?? 32000, 21000))。 */
  maxOutputTokens?: number,
 /** 思考力度档位(四档联动:low/medium/high/xhigh → 阈值×0.35/0.55/0.75/1.0)。 */
  reasoningEffort?: string): GateDecision {
  let lastCompactSeq = -1;
  for (const e of events) {
    if (e.sessionId !== sessionId || e.kind !== "compact.done") continue;
    if (!isRealCompactBoundary(e)) continue;
    lastCompactSeq = Math.max(lastCompactSeq, e.seq ?? 0);
  }
  let used = 0;
  let floorUsed = 0;
  let agentMsgsSinceCompact = 0;
  for (const e of events) {
    if (e.sessionId !== sessionId) continue;
    const seq = e.seq ?? 0;
    if (e.kind === "message.agent") {
      if (seq > lastCompactSeq) agentMsgsSinceCompact += 1;
      const u = (e.payload || {}) as { usage?: { inputTokens?: number } };
      if (seq > lastCompactSeq && u?.usage?.inputTokens) {
        used = u.usage.inputTokens; // 只认边界后的实测
        if (floorUsed === 0) floorUsed = used; // 边界后首个水位=压缩是否有效的证据
      }
    }
  }
 // O3(口径对齐 ZCode compact/policy.ts):provider 的 contextWindow 是 input+output
  // 共享窗口,自动压缩只能让出输入侧——阈值分母先扣掉输出预留(min(请求 max_tokens??32000,21000)),
  // 再扣安全 buffer 13000:threshold = contextWindow − reserve − 13000。
  // 显式阈值(compactThresholdTokens)只在**没有声明 contextWindow** 时兜底(它是「无窗口时的绝对门槛」),
  // 窗口已知时它不是上限、也不与窗口阈值取 min——窗口口径(ZCode)是唯一权威。
  // 极小窗口(≤ 预留+buffer,如 8k)ZCode 式会算出 0 阈=「永远压缩」——退回 80% 比例(旧语义,对小窗口更稳)。
 // 背景(经验证):声明 contextWindow=1M 时显式 24000 被完全忽略 → 门槛 800k 全程未压缩,
  // 106 次调用累计 ~10M input tokens、峰值 133k;ZCode 口径下 1M 窗口门槛=966k(输出预留可解释)。
  const zcodeThreshold = Math.max(0, Math.round((contextWindow ?? 0) - autoCompactOutputReserve(maxOutputTokens)) - AUTOCOMPACT_BUFFER_TOKENS);
  const windowThreshold = contextWindow && contextWindow > 0
    ? (zcodeThreshold > 0 ? zcodeThreshold : Math.round(contextWindow * COMPACT_WINDOW_RATIO))
    : Math.round(DEFAULT_CONTEXT_WINDOW_TOKENS * COMPACT_WINDOW_RATIO);
  const threshold = contextWindow && contextWindow > 0
    ? windowThreshold
    : (fallbackThreshold && fallbackThreshold > 0 ? fallbackThreshold : windowThreshold);
 // effort 四档缩放:xhigh=窗口口径原值;low/medium/high 提前压缩。
  // 缩放作用于最终阈值(窗口口径与显式 fallback 同语义),极小值保护=不低于 1000(防 0 阈死循环压缩)。
 // 修两处:
  //  ① 判定必须用 scaledThreshold——旧码 base 里写 scaledThreshold、判定却用未缩放的 threshold,
  //    effort 缩放在**判定侧完全失效**(1M 窗口 + high 仍按 966k 判,而非 724.5k)。
  //  ② 加绝对封顶 MAX_COMPACT_TOKENS:窗口口径随窗口线性放大,1M 窗口下等同「永不压缩」。
  const effortRatio = effortCompactRatio(reasoningEffort);
 // (最高档给满窗口):xhigh=「与模型上下文窗口一致」的档位承诺,不得被
  // 300K 成本封顶截断——1M 窗口 × xhigh = 966K(窗口−输出预留−buffer)。封顶(MAX_COMPACT_TOKENS)
  // 只约束 low/medium/high 这些「提前压缩」档(它们的语义就是比窗口更早压)。
  // 背景:web-1793790405127 用 305K 就每步触发压缩+跳过空转(阈值被 cap 到 300K,骑线刷屏)。
  const isMaxEffort = String(reasoningEffort ?? "").trim().toLowerCase() === "xhigh";
  const maxThreshold = isMaxEffort ? Number.POSITIVE_INFINITY : resolveMaxCompactTokens();
  const scaledThreshold = Math.max(1_000, Math.min(Math.round(threshold * effortRatio), maxThreshold));
  const base: GateDecision = { fire: false, force: false, threshold: scaledThreshold, used, floorUsed, baseline: false, agentMsgsSinceCompact, effortRatio };
  if (used >= scaledThreshold) {
    // 硬超限(≥ 封顶的 HARD_COMPACT_FACTOR 倍):基线抑制窗不该拦住它——历史涨到 1.8 倍阈值还
    // 等「消息数 > 2」才压,等于每步再烧一次全量 input。基线抑制只防「压完仍超」的重复压缩,
    // 不防「涨得太多」的强压。
    const hardOver = used >= Math.round(scaledThreshold * HARD_COMPACT_FACTOR);
 // floor 护栏(见 HARD_COMPACT_FACTOR 注释):floor ≥ 阈值 = 上次压缩没压到
    // 阈值下,强压无效且会连环摧毁对话史——按基线抑制处理,不进 hardOver 旁路。
    const floorStuck = floorUsed > 0 && floorUsed >= scaledThreshold;
    if (agentMsgsSinceCompact <= BASELINE_QUIET_MSGS && !(hardOver && !floorStuck)) {
      // 刚压过仍 ≥ 阈值:压不动基线(系统提示+注入块),重压=纯烧摘要模型的钱
      return { ...base, fire: false, baseline: true };
    }
    return { ...base, fire: true, force: true };
  }
  if (used > 0) return { ...base, fire: false };
 // used=0(该会话从无 usage 经验证):放行给 autoCompact 的 est 二次闸(有窗时 est 阈=同值,天然保守)
  return { ...base, fire: true };
}
