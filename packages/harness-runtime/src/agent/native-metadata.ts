/**
 * 原生元数据降级 + overflow 单次守卫(纯逻辑零 IO)。
 * 背景:
 * - provider 原生元数据(reasoning_content / thinking blocks / provider item id 等)只在**同一个模型**
 * 上可解释。把 A 模型的历史硬回放给 B 模型时,这些字段要么被拒(400),要么被当成另一套词表硬解释,
 * 输出质量比「当普通文本重放」更差——所以模型切换/失败轮必须降级成普通文本,宁降级不冒险。
 * - provider 报 context_exceeded 时,死循环压缩会把摘要套摘要,真正的原始消息全丢。
 * 故本 turn 只允许「强制压缩一次 + 原地重放同一请求」;第二次 overflow 或本 turn 已有 durable
 * 工具输出时直接终态失败,把问题交回调用方,而不是无限压缩。
 * 本文件全部是纯函数/纯状态机:不读盘、不发请求、不 throw、不改入参(不可变)。
 */

/** 原生元数据字段白名单(降级时剥离;content/toolCalls 是模型可见真相,永不剥离)。 */
export const NATIVE_METADATA_FIELDS = [
  "reasoning",
  "providerMetadata",
  "thinkingBlocks",
  "providerItemId",
] as const;

/** 判据码。DEGRADED=最终上下文形态(投影结果),其余是原因码。 */
export const NATIVE_METADATA_CODES = ["OK", "MODEL_MISMATCH", "ERROR_TURN", "DEGRADED"] as const;
export type NativeMetadataCode = (typeof NATIVE_METADATA_CODES)[number];

export interface NativeReplayInput {
 /** 该条消息落账时的模型名(journal payload.model);缺失=无法证明同源。 */
  messageModel?: string;
 /** 当前请求要用的模型名;缺失=无法比对。 */
  currentModel?: string;
 /** 该条消息是否带失败标记(错误/失败/未完成的 turn)。 */
  messageHadError?: boolean;
}

export interface NativeReplayDecision {
  replay: boolean;
  code: NativeMetadataCode;
  reason: string;
}

function nonEmptyModel(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 是否允许回放该条消息的 provider 原生元数据。
 * 判据顺序固定:缺模型 → 模型不等 → 失败标记 → 通过(确定性;先判模型再判错误,
 * 模型不同时原因码归 MODEL_MISMATCH)。
 */
export function shouldReplayNativeMetadata(input: NativeReplayInput): NativeReplayDecision {
  const messageModel = nonEmptyModel(input?.messageModel);
  const currentModel = nonEmptyModel(input?.currentModel);
  if (!messageModel || !currentModel) {
 // 宁降级不冒险:缺任一模型都无法证明同源,回放原生字段可能撞词表/协议差异。
    return { replay: false, code: "MODEL_MISMATCH", reason: "缺少消息模型或当前模型,无法证明同源 → 降级" };
  }
  if (messageModel !== currentModel) {
    return { replay: false, code: "MODEL_MISMATCH", reason: `模型不一致(${messageModel} ≠ ${currentModel})→ 降级` };
  }
  if (input?.messageHadError === true) {
    return { replay: false, code: "ERROR_TURN", reason: "该消息带失败标记,原生元数据不完整 → 降级" };
  }
  return { replay: true, code: "OK", reason: "同模型且无失败标记 → 可回放原生元数据" };
}

/** 投影结果码:回放=OK,降级=DEGRADED(具体原因见 shouldReplayNativeMetadata 的 code)。 */
export function projectionCodeOf(decision: NativeReplayDecision): "OK" | "DEGRADED" {
  return decision.replay ? "OK" : "DEGRADED";
}

type Loose = Record<string, unknown>;

function hasNativeField(msg: Loose): boolean {
  for (const f of NATIVE_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(msg, f) && msg[f] !== undefined) return true;
  }
  return false;
}

/**
 * 去掉消息上的 provider 原生字段,保留 content/toolCalls。
 * - 不可变:有原生字段时返回浅拷贝,原对象原样不动;
 * - 无原生字段时**逐字原样返回**(同一引用),保证「不需要降级」的路径零变化。
 */
export function degradeMessageNativeMetadata<T extends object>(msg: T): T {
  if (msg === null || typeof msg !== "object") return msg;
  const src = msg as Loose;
  if (!hasNativeField(src)) return msg;
  const copy: Loose = { ...src };
  for (const f of NATIVE_METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(copy, f)) delete copy[f];
  }
  return copy as T;
}

export interface ProjectMessagesOptions {
 /** 当前请求模型;缺失时保守降级(同 shouldReplayNativeMetadata)。 */
  currentModel?: string;
 /** 已判失败的模型名名单(命中=该消息所在 turn 视为失败轮)。 */
  failedModels?: readonly string[];
}

/**
 * 逐条投影历史消息(只处理 assistant 消息):
 * 满足回放条件→原样保留;不满足→降级为普通文本消息。
 * 返回新数组(不改入参、确定性)。
 */
export function projectMessagesForProvider<T extends object>(
  messages: readonly T[],
  opts: ProjectMessagesOptions = {},
): T[] {
  const failed = opts.failedModels ?? [];
  return messages.map((m) => {
    const src = m as Loose;
    if (src.role !== "assistant") return m;
    const messageModel = nonEmptyModel(src.model);
    const decision = shouldReplayNativeMetadata({
      ...(messageModel ? { messageModel } : {}),
      ...(opts.currentModel ? { currentModel: opts.currentModel } : {}),
      messageHadError: messageModel !== undefined && failed.includes(messageModel),
    });
    return decision.replay ? m : degradeMessageNativeMetadata(m);
  });
}

/** head 文本化的单条截断上限(字符)。 */
export const HEAD_TEXT_CHECKPOINT_LIMIT = 6000;

/**
 * 把 head 逐条序列化为纯文本行(`[role] content`,单条 6000 字截断)。
 * 不含任何原生元数据——压缩边界复用/断言都只认这条文本真相。
 */
export function serializeHeadAsTextCheckpoint<T extends object>(messages: readonly T[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object") continue;
    const src = m as Loose;
    const role = typeof src.role === "string" && src.role ? src.role : "unknown";
    const raw = typeof src.content === "string" ? src.content : "";
    const content = raw.length > HEAD_TEXT_CHECKPOINT_LIMIT
      ? raw.slice(0, HEAD_TEXT_CHECKPOINT_LIMIT) + "…"
      : raw;
    lines.push(`[${role}] ${content}`);
  }
  return lines.join("\n");
}

export type OverflowAction = "compact-and-replay" | "terminal";
export type OverflowCode = "OK_COMPACT" | "OVERFLOW_REPEAT" | "DURABLE_OUTPUT" | "NO_OVERFLOW";

export interface OverflowGuardInput {
 /** 当前 turn(全局递增;同一 turn 内只允许压缩一次)。 */
  turn: number;
 /** 本 turn 已落账的 durable 工具输出 token 粗估(0=还没有持久输出)。 */
  durableOutputTokens?: number;
 /** 本步是否真的发生 context_exceeded。 */
  overflow?: boolean;
}

export interface OverflowGuardDecision {
  action: OverflowAction;
  code: OverflowCode;
  reason: string;
}

/**
 * overflow 单次守卫(跨 turn 复用同一实例):
 * - 同一 turn 内 overflow 只允许一次 compact-and-replay,重现即终态;
 * - 本 turn 已有 durable 工具输出 → 终态(压缩会丢掉刚做出来的事实,重放也救不回来);
 * - 跨 turn 再压缩的前提是「上次压缩后 surface 真的缩小」,不缩小 → 终态,
 * 因为再压只会摘要套摘要。
 * 不 throw;只维护内部计数/水位,不读外部状态。
 */
export class OverflowOnceGuard {
  #lastCompactedTurn: number | undefined = undefined;
  #lastSurfaceTokens: number | undefined = undefined;
  #surfaceStalled = false;

  next(input: OverflowGuardInput): OverflowGuardDecision {
    if (input?.overflow !== true) {
      return { action: "terminal", code: "NO_OVERFLOW", reason: "本步没有 overflow,守卫不介入" };
    }
    const turn = typeof input.turn === "number" && Number.isFinite(input.turn) ? input.turn : -1;
    const durable = typeof input.durableOutputTokens === "number" && Number.isFinite(input.durableOutputTokens)
      ? input.durableOutputTokens
      : 0;
    if (durable > 0) {
      return { action: "terminal", code: "DURABLE_OUTPUT", reason: `本 turn 已有 ${durable} tok durable 工具输出,压缩会丢事实 → 终态失败` };
    }
    if (this.#lastCompactedTurn !== undefined && this.#lastCompactedTurn === turn) {
      return { action: "terminal", code: "OVERFLOW_REPEAT", reason: "同一 turn 已强制压缩过一次,再压只会死循环 → 终态失败" };
    }
    if (this.#surfaceStalled) {
      return { action: "terminal", code: "OVERFLOW_REPEAT", reason: "上次强制压缩后上下文 surface 没有缩小,再压只会摘要套摘要 → 终态失败" };
    }
    this.#lastCompactedTurn = turn;
    return { action: "compact-and-replay", code: "OK_COMPACT", reason: "本 turn 首次 overflow 且无 durable 输出:允许压缩一次并原地重放" };
  }

 /**
 * 每 turn 边界重置(loop.runTurn 开头调用):清「同 turn 已压缩」审批与停滞标记。
 * 上一 turn 压缩后 surface 未缩,不该把新 turn 直接判死——新 turn 仍只允许压缩一次 + 重放,
 * 同 turn 二次 overflow 依旧 terminal。surface 水位(#lastSurfaceTokens)保留:它是
 * 「压缩是否真的缩小上下文」的跨 turn 基线,清掉会让停滞判定永远失效。
 */
  resetForTurn(): void {
    this.#lastCompactedTurn = undefined;
    this.#surfaceStalled = false;
  }

 /** 记录压缩后的 durable surface(token 粗估);比上次小才解除下一 turn 的压缩许可。 */
  noteSurfaceTokens(n: number): void {
    const tokens = typeof n === "number" && Number.isFinite(n) ? n : 0;
    if (this.#lastSurfaceTokens !== undefined && tokens >= this.#lastSurfaceTokens) {
      this.#surfaceStalled = true;
    }
    this.#lastSurfaceTokens = tokens;
  }
}
