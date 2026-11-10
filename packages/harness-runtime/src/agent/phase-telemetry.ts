/**
 *  阶段遥测合同:turn 内各阶段(llm / tools)的 span 记录 + 单条 turn 级汇总。
 * 纯逻辑:**无 IO**(不碰 journal / 文件 / 网络);时间只经注入的 TelemetryClock 读取,
 * 因此整个模块可用假时钟确定性测试。接线方(loop.ts)只负责 begin/end 与落一条
 * `custom` + `payload.what === "telemetry.phase"` 事件。
 * 口径要点(与  合同逐条对应):
 * - 时钟单调性:一次回退/抛错/非法读数即把该实例**永久**置为不可靠;不可靠时**不得钳零**
 *   (unattributedMs 如实给 null,而不是把负数抹成 0)。
 * - span:同一时刻只允许一个 open span;被新 begin 顶掉的旧 span 记 "unclosed",
 *   顶掉它的新 token 收尾时强制 "overlap"(它是重叠区间的证据)。
 * - 汇总:去重(name + 起点 + 终点,保留首条)→ 跨进程 origin 对齐 → 按 startMono 排序
 *   → TTL 标 expired → maxSpans 丢最旧 → 并集算 unionMs / unattributedMs / quality。
 */

export type SpanStatus = "complete" | "interrupted" | "unclosed" | "overlap" | "expired";

export interface PhaseSpan {
  name: string;
  startMono: number;
  endMono: number;
  durationMs: number;
  status: SpanStatus;
  /** 产出该 span 的时钟原点(跨进程对齐用;时钟无效/无原点时省略)。 */
  originMs?: number;
}

export type TelemetryQuality = "complete" | "missing" | "clock_invalid" | "expired" | "unclosed" | "interrupted";

/** token 用量(与 loop.ts 的 LlmResponse["usage"] 同形;**故意不复用其类型**,免产生循环 import)。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
}

export interface ClockReading {
  originMs: number;
  mono: number;
  reliable: boolean;
}

export interface TelemetryClock {
  calibrate(): ClockReading;
  now(): number;
}

/** begin 返回的不透明句柄(外部只须原样回传给 end)。 */
export interface PhaseToken {
  id: number;
  name: string;
  startMono: number;
  /** 该 token 是顶掉一个未收尾 span 得到的 → 收尾时 status 强制 "overlap"。 */
  overlap?: boolean;
}

export interface TurnTelemetry {
  spans: PhaseSpan[];
  unionMs: number;
  unattributedMs: number | null;
  quality: TelemetryQuality;
  expectedMissing: string[];
  usage?: Usage;
  ttftMs?: number;
  dropped?: number;
  at: number;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MAX_SPANS = 200;
const DEFAULT_EXPECTED_PHASES: readonly string[] = ["llm", "tools"];

function defaultTimeOrigin(): number {
  const perf = (globalThis as { performance?: { timeOrigin?: number } }).performance;
  const origin = perf?.timeOrigin;
  return typeof origin === "number" ? origin : Number.NaN;
}

function defaultMonoNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Number.NaN;
}

/**
 * 单调时钟:originMs 是 wall-clock 原点(与 performance.timeOrigin 同义),mono 是单调毫秒读数。
 * reliable 一旦为 false 就**永久**保持 false(该实例内不再恢复;要恢复须重建实例)。
 */
export function createTelemetryClock(opts: { timeOrigin?: number; now?: () => number } = {}): TelemetryClock {
  const readNow = opts.now ?? defaultMonoNow;
  // 构造时快照原点:运行期原点变化不属于「同一时钟」,快照让对齐判定稳定。
  const originMs = opts.timeOrigin ?? defaultTimeOrigin();
  const originValid = Number.isFinite(originMs) && originMs > 0;
  let broken = false;
  let lastMono: number | undefined;

  const readMono = (): number => {
    let raw: number;
    try {
      raw = readNow();
    } catch {
      broken = true; // 抛错=不可靠,沿用上次读数(不伪造 0)
      return lastMono ?? 0;
    }
    const v = typeof raw === "number" ? raw : Number.NaN;
    if (!Number.isFinite(v) || v < 0) {
      broken = true;
      return lastMono ?? 0;
    }
    if (lastMono !== undefined && v < lastMono) {
      broken = true; // 回退=不可靠(永久);读数原地回退到上次值,便于后续判定仍单调
      return lastMono;
    }
    lastMono = v;
    return v;
  };

  return {
    calibrate(): ClockReading {
      const mono = readMono();
      return { originMs: Number.isFinite(originMs) ? originMs : 0, mono, reliable: originValid && !broken };
    },
    now(): number {
      return readMono();
    },
  };
}

/** 去重 key:name + 起点 + 终点(同阶段同区间只算一条)。 */
function spanKey(s: PhaseSpan): string {
  return `${s.name}\u0000${s.startMono}\u0000${s.endMono}`;
}

/** 去重:保留**首次出现**的条目(不改入参对象)。 */
function dedupeSpans(spans: readonly PhaseSpan[]): PhaseSpan[] {
  const seen = new Set<string>();
  const out: PhaseSpan[] = [];
  for (const s of spans) {
    const key = spanKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s });
  }
  return out;
}

/** 超量时丢最旧(startMono 最小)的条目;返回保留项与丢弃数。 */
function trimOldest(spans: PhaseSpan[], maxSpans: number): { spans: PhaseSpan[]; dropped: number } {
  const limit = Number.isFinite(maxSpans) && maxSpans >= 0 ? Math.floor(maxSpans) : DEFAULT_MAX_SPANS;
  if (spans.length <= limit) return { spans, dropped: 0 };
  const keep = [...spans].sort((a, b) => a.startMono - b.startMono).slice(spans.length - limit);
  const keepSet = new Set(keep);
  return { spans: spans.filter((s) => keepSet.has(s)), dropped: spans.length - limit };
}

/** TTL:结束时刻早于 now - ttlMs 的 span 标 expired(unclosed/interrupted 不覆盖,它们信息更值钱)。 */
function applyTtl(spans: PhaseSpan[], nowMs: number, ttlMs: number): PhaseSpan[] {
  return spans.map((s) => {
    if (s.status === "expired" || s.status === "unclosed" || s.status === "interrupted") return s;
    const age = nowMs - s.endMono;
    if (!Number.isFinite(age) || age <= ttlMs) return s;
    return { ...s, status: "expired" as SpanStatus };
  });
}

/** 区间并集长度(重叠只算一次;负长度按 0)。 */
function unionLength(spans: readonly PhaseSpan[]): number {
  const intervals: Array<[number, number]> = [];
  for (const s of spans) {
    if (!Number.isFinite(s.startMono) || !Number.isFinite(s.endMono)) continue;
    intervals.push([s.startMono, Math.max(s.startMono, s.endMono)]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [start, end] of intervals) {
    if (Number.isNaN(curStart)) {
      curStart = start;
      curEnd = end;
      continue;
    }
    if (start > curEnd) {
      total += curEnd - curStart;
      curStart = start;
      curEnd = end;
      continue;
    }
    if (end > curEnd) curEnd = end;
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

/**
 * 阶段记录器:begin/end 成对,异常路径用 closeAll 兜底。
 * 只用传入时钟读数,不落任何账——spans() 是唯一读数面。
 */
export class PhaseRecorder {
  private readonly clock: TelemetryClock;
  private readonly done: PhaseSpan[] = [];
  private open: PhaseToken | null = null;
  private seq = 0;
  private originProbed = false;
  private spanOrigin: number | undefined;

  constructor(clock: TelemetryClock = createTelemetryClock()) {
    this.clock = clock;
  }

  /** 时钟自检(供接线方在 turn 末判定是否可信)。 */
  calibrate(): ClockReading {
    return this.clock.calibrate();
  }

  begin(name: string): PhaseToken {
    const mono = this.clock.now();
    const hadOpen = this.open !== null;
    if (this.open) this.closeOpen(mono, "unclosed");
    this.seq += 1;
    const token: PhaseToken = { id: this.seq, name, startMono: mono, ...(hadOpen ? { overlap: true } : {}) };
    this.open = token;
    return token;
  }

  end(token: PhaseToken, status: "complete" | "interrupted" = "complete"): PhaseSpan | null {
    const open = this.open;
    // 未知/已 end 的 token:静默返回 null,不改任何状态(重复 end 不应制造 span)。
    if (!open || !token || open.id !== token.id) return null;
    const endMono = this.clock.now();
    const span = this.makeSpan(open, endMono, open.overlap ? "overlap" : status);
    this.open = null;
    this.done.push(span);
    return span;
  }

  closeAll(reason: "interrupted" | "unclosed" = "interrupted"): PhaseSpan[] {
    if (!this.open) return [];
    const span = this.closeOpen(this.clock.now(), reason);
    return span ? [span] : [];
  }

  spans(): PhaseSpan[] {
    return this.done.map((s) => ({ ...s }));
  }

  private closeOpen(endMono: number, status: "interrupted" | "unclosed"): PhaseSpan | null {
    const open = this.open;
    if (!open) return null;
    const span = this.makeSpan(open, endMono, open.overlap ? "overlap" : status);
    this.open = null;
    this.done.push(span);
    return span;
  }

  private makeSpan(token: PhaseToken, endMono: number, status: SpanStatus): PhaseSpan {
    const origin = this.originOf();
    return {
      name: token.name,
      startMono: token.startMono,
      endMono,
      durationMs: Math.max(0, endMono - token.startMono),
      status,
      ...(origin !== undefined ? { originMs: origin } : {}),
    };
  }

  /** span 的 origin 标签只取一次(时钟原点无效时省略该字段)。 */
  private originOf(): number | undefined {
    if (!this.originProbed) {
      this.originProbed = true;
      const reading = this.clock.calibrate();
      this.spanOrigin = Number.isFinite(reading.originMs) && reading.originMs > 0 ? reading.originMs : undefined;
    }
    return this.spanOrigin;
  }
}

export interface BuildTurnTelemetryArgs {
  recorder: PhaseRecorder;
  totalMs: number;
  usage?: Usage;
  expectedPhases?: string[];
  /** 「现在」(与 span 的 mono 同域);缺省取本次校准读数。 */
  now?: number;
  ttlMs?: number;
  maxSpans?: number;
  ttftMs?: number;
  hasContent?: boolean;
  at?: number;
}

/** turn 级汇总:只读 recorder,不改其内部状态(expired 是派生视图)。 */
export function buildTurnTelemetry(args: BuildTurnTelemetryArgs): TurnTelemetry {
  const reading = args.recorder.calibrate();
  const reliable = reading.reliable;
  const baseOrigin = reading.originMs;
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const maxSpans = args.maxSpans ?? DEFAULT_MAX_SPANS;
  const expectedPhases = args.expectedPhases ?? [...DEFAULT_EXPECTED_PHASES];
  const nowMs = typeof args.now === "number" && Number.isFinite(args.now) ? args.now : reading.mono;

  const deduped = dedupeSpans(args.recorder.spans());
  // 跨进程对齐:带上别处 origin 的 span 平移到本次校准的原点坐标系。
  const aligned = deduped.map((s): PhaseSpan => {
    if (s.originMs === undefined || !Number.isFinite(s.originMs)) return s;
    if (!Number.isFinite(baseOrigin) || baseOrigin <= 0) return s;
    if (s.originMs === baseOrigin) return s;
    const delta = baseOrigin - s.originMs;
    return { ...s, startMono: s.startMono + delta, endMono: s.endMono + delta };
  });
  aligned.sort((a, b) => a.startMono - b.startMono);

  const presentNames = new Set(aligned.map((s) => s.name));
  const withTtl = applyTtl(aligned, nowMs, ttlMs);
  const trimmed = trimOldest(withTtl, maxSpans);
  const spans = trimmed.spans;

  const unionMs = unionLength(spans);
  const unattributedMs = reliable ? Math.max(0, args.totalMs - unionMs) : null;

  const expectedMissing = expectedPhases.filter((name) => !presentNames.has(name));
  const has = (status: SpanStatus) => spans.some((s) => s.status === status);
  let quality: TelemetryQuality;
  if (!reliable) quality = "clock_invalid";
  else if (has("unclosed")) quality = "unclosed";
  else if (has("interrupted")) quality = "interrupted";
  else if (has("expired")) quality = "expired";
  else if (expectedMissing.length > 0) quality = "missing";
  else quality = "complete";

  const ttftMs = args.hasContent === true && typeof args.ttftMs === "number" && Number.isFinite(args.ttftMs)
    ? args.ttftMs
    : undefined;

  return {
    spans,
    unionMs,
    unattributedMs,
    quality,
    expectedMissing,
    ...(args.usage ? { usage: args.usage } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    ...(trimmed.dropped > 0 ? { dropped: trimmed.dropped } : {}),
    at: typeof args.at === "number" ? args.at : Date.now(),
  };
}

/**
 * 冷导出(turn 之后批量搬运):去重 → TTL 标 expired → maxSpans 丢最旧 → 按 startMono 排序。
 * **不修改入参**(所有输出对象都是副本);expired 只计本次被标的条数。
 */
export function exportTelemetry(
  batch: { spans: PhaseSpan[] } | PhaseSpan[],
  opts: { maxSpans?: number; ttlMs?: number; now?: number } = {},
): { spans: PhaseSpan[]; dropped: number; expired: number } {
  const input: readonly PhaseSpan[] = Array.isArray(batch) ? batch : (batch?.spans ?? []);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxSpans = opts.maxSpans ?? DEFAULT_MAX_SPANS;
  const nowMs = typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : createTelemetryClock().now();

  const deduped = dedupeSpans(input);
  let expired = 0;
  const withTtl = deduped.map((s) => {
    if (s.status === "expired" || s.status === "unclosed" || s.status === "interrupted") return s;
    const age = nowMs - s.endMono;
    if (!Number.isFinite(age) || age <= ttlMs) return s;
    expired += 1;
    return { ...s, status: "expired" as SpanStatus };
  });
  const trimmed = trimOldest(withTtl, maxSpans);
  const spans = [...trimmed.spans].sort((a, b) => a.startMono - b.startMono);
  return { spans, dropped: trimmed.dropped, expired };
}
