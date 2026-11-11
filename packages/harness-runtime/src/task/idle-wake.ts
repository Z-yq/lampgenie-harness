/**
 *  后台子代理 idle wake —— 纯逻辑零 IO。
 * 背景:后台子代理完成/失败后,父会话若已空闲(上一 turn 已结束、没有在跑的任务),
 * 应当自动起一次 model-only turn 消费这条通知;父会话仍在跑则不打扰——它自己
 * 下一 turn 会看到队列里的通知,再插一条唤醒只会制造并发的两个模型 turn 互相打架
 * (同一 session 的 turn 串行前提被打破,journal 顺序与工具状态都会乱)。
 * 本模块只做判定与文本拼装,不读不写、不抛错、不改入参;调用方负责 submit/投递。
 */

/** 判定码(封闭枚举):WAKE=可唤醒;BUSY=父会话忙/上一 turn 刚结束;NO_PENDING=无通知;STALE=通知全属旧 generation;INVALID=入参不合法。 */
export const WAKE_CODES = ["WAKE", "BUSY", "NO_PENDING", "STALE", "INVALID"] as const;
export type WakeCode = (typeof WAKE_CODES)[number];

export interface PendingNotification {
  id: string;
 /** 通知产生时刻(ms),批内按它升序拼接。 */
  at: number;
 /** 通知所属分支代次;与 currentGeneration 不等即视为旧代(换分支/重开后的迟到通知)。 */
  generation: number;
  kind: string;
  summary: string;
}

export interface IdleWakeInput {
  sessionId: string;
  now: number;
 /** 上一 turn 结束时刻(journal 最近 turn.end.time);缺失=未知,按保守策略不唤醒。 */
  lastTurnEndAt?: number | null;
 /** 同 session 处于 running/queued 的任务数。 */
  activeTaskCount: number;
  pendingNotifications: PendingNotification[];
 /** 当前主任务 turn 号;通知 generation 与之不等即旧代。 */
  currentGeneration: number;
  minIdleMs?: number;
  maxBatch?: number;
}

export interface WakeVerdict {
  ok: true;
  wake: boolean;
  code: WakeCode;
  reason: string;
 /** 只含「本次将被唤醒消费」的通知 id(旧代/未选出的一律不进)。 */
  ids: string[];
  prompt?: string;
}

export const DEFAULT_MIN_IDLE_MS = 1500;
export const DEFAULT_MAX_BATCH = 5;
const SUMMARY_MAX_CHARS = 160;
const PROMPT_MAX_CHARS = 1200;
const HEADER = "[后台单元完成] 以下后台任务已结束(可能成功/失败):";
const FOOTER =
  "这些通知可能对应你之前派出的工作:检查结果并继续;若无需处理,忽略本消息,不要重复已完成的工作。";

function verdict(code: WakeCode, reason: string, ids: string[] = []): WakeVerdict {
  return { ok: true, wake: code === "WAKE", code, reason, ids };
}

function summaryLine(notification: PendingNotification): string {
  const kind = String(notification?.kind ?? "bg");
  const summary = String(notification?.summary ?? "").slice(0, SUMMARY_MAX_CHARS);
  return `- ${kind}: ${summary}`;
}

function promptLength(lines: string[]): number {
  return [HEADER, ...lines, FOOTER].join("\n").length;
}

/**
 * 拼装唤醒 prompt(稳定中文文本,≤1200 字)。
 * 超出上限时从最旧的通知开始丢(保留最近的),保证文本有界且确定性。
 */
export function wakePrompt(notifications: PendingNotification[]): string {
  const items = Array.isArray(notifications) ? [...notifications] : [];
  items.sort((left, right) => {
    const byAt = Number(left?.at ?? 0) - Number(right?.at ?? 0);
    if (byAt !== 0) return byAt;
    return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  });
  let lines = items.map(summaryLine);
  while (lines.length > 0 && promptLength(lines) > PROMPT_MAX_CHARS) {
    lines = lines.slice(0, -1);
  }
  return [HEADER, ...lines, FOOTER].join("\n");
}

/**
 * 判定是否该给父会话起一次唤醒 turn。
 * busy 时为什么不唤醒:同一 session 的 turn 本应串行——父会话还在跑(activeTaskCount>0)
 * 或上一 turn 刚结束(minIdleMs 保护窗)时插入 model-only turn,会让两个模型 turn 同时
 * 推进同一份工具状态与 journal;而空闲父会话下一次 turn 本来就会看到通知,迟一步不丢信息。
 */
export function wakeVerdict(input: IdleWakeInput): WakeVerdict {
  try {
    if (!input || typeof input !== "object") return verdict("INVALID", "入参不是对象");
    if (typeof input.now !== "number" || !Number.isFinite(input.now)) {
      return verdict("INVALID", "now 不是有限数字");
    }
    if (!Array.isArray(input.pendingNotifications)) {
      return verdict("INVALID", "pendingNotifications 不是数组");
    }
    if (typeof input.activeTaskCount !== "number" || !Number.isFinite(input.activeTaskCount) || input.activeTaskCount < 0) {
      return verdict("INVALID", "activeTaskCount 不是非负数字");
    }

    const minIdleMs =
      typeof input.minIdleMs === "number" && Number.isFinite(input.minIdleMs) && input.minIdleMs >= 0
        ? input.minIdleMs
        : DEFAULT_MIN_IDLE_MS;
    const maxBatch =
      typeof input.maxBatch === "number" && Number.isFinite(input.maxBatch) && input.maxBatch >= 1
        ? Math.floor(input.maxBatch)
        : DEFAULT_MAX_BATCH;

 // 1) 父会话仍在跑/排队:一律不打扰。
    if (input.activeTaskCount > 0) {
      return verdict("BUSY", `父会话仍有 ${input.activeTaskCount} 个任务在跑/排队,等它自己下一 turn 消费`);
    }

 // 2) 没有任何待投递通知。
    const pending = input.pendingNotifications.filter(
      (item): item is PendingNotification =>
        Boolean(item) && typeof item === "object" && typeof (item as PendingNotification).id === "string",
    );
    if (pending.length === 0) return verdict("NO_PENDING", "没有待投递的后台通知");

 // 3) 旧代通知丢弃(换分支/重开后迟到的结果不能污染新上下文)。
    const currentGeneration =
      typeof input.currentGeneration === "number" && Number.isFinite(input.currentGeneration)
        ? input.currentGeneration
        : 0;
    const fresh = pending.filter((item) => {
      const generation = typeof item.generation === "number" && Number.isFinite(item.generation) ? item.generation : 0;
      return generation === currentGeneration;
    });
    if (fresh.length === 0) {
      return verdict("STALE", `${pending.length} 条通知全属旧 generation(当前 ${currentGeneration}),丢弃`);
    }

 // 4) 上一 turn 已结束才唤醒;缺失结束时刻按保守处理(可能是刚起、还没写出 turn.end)。
    const lastTurnEndAt =
      typeof input.lastTurnEndAt === "number" && Number.isFinite(input.lastTurnEndAt) ? input.lastTurnEndAt : null;
    if (lastTurnEndAt === null) {
      return verdict("BUSY", "缺少上一 turn 结束时刻,保守不唤醒");
    }
    const idleMs = input.now - lastTurnEndAt;
    if (idleMs < minIdleMs) {
      return verdict("BUSY", `上一 turn 结束仅 ${idleMs}ms(<${minIdleMs}ms),可能仍在收尾`);
    }

 // 5) 同批合并:按 at 升序取最近 maxBatch 条,一次唤醒。
    const sorted = [...fresh].sort((left, right) => {
      const byAt = Number(left.at ?? 0) - Number(right.at ?? 0);
      if (byAt !== 0) return byAt;
      return String(left.id).localeCompare(String(right.id));
    });
    const selected = sorted.slice(-maxBatch);
    return {
      ok: true,
      wake: true,
      code: "WAKE",
      reason: `父会话已空闲 ${idleMs}ms,合并 ${selected.length} 条通知起一次唤醒 turn`,
      ids: selected.map((item) => item.id),
      prompt: wakePrompt(selected),
    };
  } catch {
 // 判定链绝不把异常抛给子代理终态回调(通知失败不许影响收尾)。
    return verdict("INVALID", "判定过程异常");
  }
}

/** 从 journal 事件取分支代次:event.payload.generation 为有限数字才采用,否则 0。 */
export function generationOfEvent(event: { payload?: { generation?: unknown } } | null | undefined): number {
  const raw = event?.payload?.generation;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}
