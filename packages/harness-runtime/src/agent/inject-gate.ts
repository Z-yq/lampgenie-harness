/**
 * 注入闸(2026-11 token 轮 J1):所有 ephemeral「提醒/提示」注入共用的 **token 间隔闸**。
 *
 * **硬规则:相同提示词(同 key)两次注入的间隔必须 ≥ 10k token —— 间隔按 provider `usage`
 * 累计的真实 token 计,不是按步数计。** 旧口径「每 N 步刷一次」是零信息复读的主因
 * (readlist 957 次/7d 的触发路径就是周期刷新),而步数与会话膨胀速度完全不对齐:
 * 短步(若干 200 tok 的 board_read)刷十步只值 2k token,长步(一次 write_file)一步就 30k。
 * 按 token 计间隔把「注入频率」与真实的上下文消耗对齐,长会话不再被提醒块淹没。
 *
 * 用途面(loop 的 5 类 ephemeral 注入,共用一把闸):
 * - readlist:已读文件清单(签名变化分支)—— key `remind:readlist`
 * - todo:未完成计划提醒 —— key `remind:todo`
 * - board:落目标再锚定 —— key `remind:board`
 * - 审批:pendingQuestions —— key `remind:pending:<正文 djb2>`,正文变=新 key=立即放行(保到达性)
 * - tips:装配方自用(loop 把闸本体放进 tips ctx.gate,key 由装配方按提示词类别定)
 *
 * 水位单调纪律:同 key 的水位只增不减。若某次传入的 tokensSpent 比记录水位**小**,
 * 视为新一轮计数(例如 runTurn 起点把 tokensSpent 清零重计)→ 按放行处理并把水位重置为该值,
 * 否则新轮里所有 key 都会卡到「凑满 10k 才放行」,首步该有的提醒全部丢失。
 *
 * 无计量放行(fail-open,到达性兜底):若传入的 tokensSpent **等于**水位(计数器一步都没前进,
 * 典型=provider 不返回 usage,或 runtime 未接入用量口径),则闸无法计量间隔,按放行处理。
 * 理由:闸是「省钱」工具,不能变成「断供」工具——计数器不动时若继续按间隔拦,同一提示词会
 * 永久不再到达(父 agent 拿不到 requestId 就无法应答审批,ephemeral 块又不进历史,等于静默丢消息)。
 * 真实 provider 每步 usage 恒为正增量,故该分支在生产只覆盖「用量不可得」这一种情形。
 */

/** 同 key 两次注入的最小 token 间隔(按 usage 累计口径)。 */
export const INJECT_INTERVAL_TOKENS = 10_000;

/** 注入闸:per-key token 水位表。 */
export interface InjectGate {
  /** 是否放行该 key 的本次注入(放行时更新水位);minTokens 缺省用构造时的默认值。 */
  check(key: string, tokensSpent: number, minTokens?: number): boolean;
  /** 该 key 当前水位(未记录=undefined)。 */
  lastTokens(key: string): number | undefined;
  /** 清空全部水位(真压缩边界后调用:模型已失忆,旧水位不再代表「看过」)。 */
  reset(): void;
}

/** 造一把闸。defaultMinTokens 缺省 10k(见 INJECT_INTERVAL_TOKENS)。 */
export function createInjectGate(defaultMinTokens: number = INJECT_INTERVAL_TOKENS): InjectGate {
  const marks = new Map<string, number>();
  return {
    check(key: string, tokensSpent: number, minTokens?: number): boolean {
      const gap = minTokens ?? defaultMinTokens;
      const spent = Number.isFinite(tokensSpent) ? tokensSpent : 0;
      const last = marks.get(key);
      // 无记录 / 无计量(水位未前进,fail-open 保到达性) / 水位回退(新一轮) / 已够间隔 → 放行并抬水位。
      if (last === undefined || spent <= last || spent - last >= gap) {
        marks.set(key, spent);
        return true;
      }
      return false;
    },
    lastTokens(key: string): number | undefined {
      return marks.get(key);
    },
    reset(): void {
      marks.clear();
    },
  };
}
