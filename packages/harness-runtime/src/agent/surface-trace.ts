/**
 * 表面替换溯源契约(surface trace):纯逻辑、零 IO。
 * 为什么需要这一层:压缩、裁剪、offload、上下文代替换都会**改写已有消息**。如果这些改写
 * 不带「来源」与「覆盖节点」的声明,会出三类静默事故:
 * ① 历史丢行——被覆盖的消息从视图里消失,但没有任何记录说明它去哪了,journal 无法复盘;
 * ② tool_call / tool_result 配对断裂——只替换了配对的一端,模型看到悬空的 half-pair;
 * ③ 并发压缩基于旧 surface 提交——两个压缩者各自基于第 N 代内容写回,后写者覆盖新内容。
 * 契约(本模块只做判定与投影,不做 IO):
 * - 一切 message-producing 事件必须带 `surfaceOp`:`append`(新行)或 `replace`(改写已存在内容);
 * - `replace` 必须声明 `sourceEventSeqs`:非空、逐个唯一、**只引用更早事件**(seq 全 < 自身 seq)、
 *   且全部存在于既有事件流;若给出 `shadowedSeqs`(本次被覆盖的节点)则必须被 source 全覆盖;
 * - `kind=tool_call|tool_result` 的 replace **只允许改 content**,其余工具字段(toolCallId/name/args…)
 *   逐键比较必须不变,否则配对与工具审计身份会被悄悄换掉;
 * - `replaceGeneration`(基于哪一代内容写回)与 `contentGeneration`(替换后的新代际)分离:
 *   前者对不上当前代际就是 `SURFACE_GENERATION_STALE`(并发覆盖),后者必须是前者 + 1;
 * - 人读转录只取 append-origin 事件(被 shadow 的不出现在「发生过什么」的线里);
 * - 派生缓存(索引/摘要/记号统计)按 `contentGeneration` 重建,而不是猜。
 * 投影语义:被 replace 的原事件**不删除**,只进 shadowed——journal 保留全部历史行,
 * 视图(transcript)才按 shadow 收窄。所有函数纯函数、不改入参、不抛异常(非法输入折叠成稳定码)。
 */

/** 表面事件类别。 */
export type SurfaceKind = "message" | "tool_call" | "tool_result" | "compact_start" | "compact_end";

/** 表面操作:新行 / 改写。 */
export type SurfaceOp = "append" | "replace";

/** 一条表面事件(journal 行)。 */
export interface SurfaceEvent {
  seq: number;
  kind: SurfaceKind;
  surfaceOp: SurfaceOp;
  sourceEventSeqs?: number[];
  content?: string;
  replaceGeneration?: number;
  contentGeneration?: number;
  at: number;
  /** 其它工具字段(toolCallId/name/args…)允许存在,但 replace 时不得变(content 除外)。 */
  [k: string]: unknown;
}

/** 表面投影状态。 */
export interface SurfaceState {
  events: SurfaceEvent[];
  /** append-origin:从未被任何 replace 覆盖过的事件 seq(人读转录的来源)。 */
  appendOrigin: Set<number>;
  /** 当前内容代际(replace 后 = replaceGeneration + 1)。 */
  contentGeneration: number;
  /** 被 replace 覆盖的节点 seq(原事件仍留在 events 里)。 */
  shadowed?: Set<number>;
}

/** 稳定码前缀(所有码都以此开头,调用方按前缀分流即可)。 */
export const SURFACE_PREFIX = "SURFACE_";

/** 全部稳定码。 */
export const SURFACE_CODES = [
  "SURFACE_APPENDED",
  "SURFACE_REPLACED",
  "SURFACE_GENERATION_BUMPED",
  "SURFACE_TRANSCRIPT_BUILT",
  "SURFACE_SOURCE_MISSING",
  "SURFACE_SOURCE_DUPLICATE",
  "SURFACE_SOURCE_NOT_EARLIER",
  "SURFACE_SHADOW_INCOMPLETE",
  "SURFACE_TOOL_FIELDS_MUTATED",
  "SURFACE_GENERATION_STALE",
  "SURFACE_INVALID",
  "SURFACE_TOOL_CALL_UNPAIRED",
  "SURFACE_TOOL_RESULT_UNPAIRED",
] as const;

export type SurfaceCode = (typeof SURFACE_CODES)[number];

/**
 * 失败码(出现即 ok=false)。
 * 注:SURFACE_TOOL_CALL_UNPAIRED / SURFACE_TOOL_RESULT_UNPAIRED 只出现在
 * detectBrokenReplacements 的 issues 里,不是 validateEvent 的拒收码,故不计入这里。
 */
export const SURFACE_FAILURE_CODES = [
  "SURFACE_SOURCE_MISSING",
  "SURFACE_SOURCE_DUPLICATE",
  "SURFACE_SOURCE_NOT_EARLIER",
  "SURFACE_SHADOW_INCOMPLETE",
  "SURFACE_TOOL_FIELDS_MUTATED",
  "SURFACE_GENERATION_STALE",
  "SURFACE_INVALID",
] as const;

const FAILURE_SET: ReadonlySet<string> = new Set<string>(SURFACE_FAILURE_CODES);
const KIND_SET: ReadonlySet<string> = new Set<string>([
  "message",
  "tool_call",
  "tool_result",
  "compact_start",
  "compact_end",
]);

/** replace 时不许变动的「结构性字段」(它们天然每次都不同,或本身就是本次改写的声明)。 */
const REPLACE_STRUCTURAL_FIELDS: ReadonlySet<string> = new Set<string>([
  "content",
  "seq",
  "at",
  "surfaceOp",
  "sourceEventSeqs",
  "replaceGeneration",
  "contentGeneration",
]);

export interface SurfaceValidateOptions {
  /** 本次 replace 打算覆盖的节点;给出时必须被 sourceEventSeqs 全覆盖。 */
  shadowedSeqs?: number[];
  /** 被改写的原事件(tool_call / tool_result 的字段不变性校验用)。 */
  oldEvent?: SurfaceEvent;
}

export interface SurfaceValidateResult {
  ok: boolean;
  codes: string[];
}

function codesOf(...codes: string[]): string[] {
  return Array.from(new Set(codes));
}

function isFailure(codes: readonly string[]): boolean {
  return codes.some((code) => FAILURE_SET.has(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** 当前内容代际:没有 replace 历史即第 0 代。 */
export function currentGeneration(existing: readonly SurfaceEvent[] = []): number {
  let gen = 0;
  for (const event of existing) {
    if (isRecord(event) && isInt(event.contentGeneration) && event.contentGeneration > gen) {
      gen = event.contentGeneration;
    } else if (
      isRecord(event) &&
      event.surfaceOp === "replace" &&
      isInt(event.replaceGeneration) &&
      event.replaceGeneration + 1 > gen
    ) {
      gen = event.replaceGeneration + 1;
    }
  }
  return gen;
}

/** 内部已解析状态(shadowed 恒存在,免去调用点到处判空)。 */
interface ResolvedSurfaceState extends SurfaceState {
  appendOrigin: Set<number>;
  contentGeneration: number;
  shadowed: Set<number>;
}

function coerceState(state: Partial<SurfaceState> | undefined | null): ResolvedSurfaceState {
  const events = Array.isArray(state?.events) ? state!.events : [];
  const appendOrigin = state?.appendOrigin instanceof Set ? new Set(state.appendOrigin) : new Set<number>();
  const shadowed = state?.shadowed instanceof Set ? new Set(state.shadowed) : new Set<number>();
  const contentGeneration =
    typeof state?.contentGeneration === "number" && Number.isFinite(state.contentGeneration)
      ? state.contentGeneration
      : currentGeneration(events);
  return { events: [...events], appendOrigin, contentGeneration, shadowed };
}

/** tool_call / tool_result 的结构字段是否被改动(返回被动过的键名)。 */
function mutatedToolFields(oldEvent: SurfaceEvent, event: SurfaceEvent): string[] {
  const keys = new Set<string>([...Object.keys(oldEvent), ...Object.keys(event)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (REPLACE_STRUCTURAL_FIELDS.has(key)) continue;
    if (!sameValue((oldEvent as Record<string, unknown>)[key], (event as Record<string, unknown>)[key])) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * 判定一条事件能不能进流。
 * append:恒 ok(SURFACE_APPENDED),唯一例外是 seq 与既有事件重复(SURFACE_INVALID)。
 * replace:逐条过来源唯一/更早/存在、shadow 全覆盖、工具字段不变、代际对齐、新代际 = 旧 + 1。
 */
export function validateEvent(
  event: SurfaceEvent,
  existing: readonly SurfaceEvent[] = [],
  opts: SurfaceValidateOptions = {},
): SurfaceValidateResult {
  const history = Array.isArray(existing) ? existing : [];
  if (!isRecord(event) || !isInt(event.seq) || !KIND_SET.has(String(event.kind))) {
    return { ok: false, codes: ["SURFACE_INVALID"] };
  }
  const existingSeqs = new Set<number>();
  for (const e of history) if (isRecord(e) && isInt(e.seq)) existingSeqs.add(e.seq);
  const duplicateSeq = existingSeqs.has(event.seq);

  if (event.surfaceOp === "append") {
    if (duplicateSeq) return { ok: false, codes: ["SURFACE_INVALID"] };
    return { ok: true, codes: ["SURFACE_APPENDED"] };
  }
  if (event.surfaceOp !== "replace") return { ok: false, codes: ["SURFACE_INVALID"] };

  const codes: string[] = [];

  // ① 来源声明必须存在且非空。
  const sources = event.sourceEventSeqs;
  if (!Array.isArray(sources) || sources.length === 0) {
    codes.push("SURFACE_SOURCE_MISSING");
  } else {
    const seen = new Set<number>();
    for (const source of sources) {
      if (!isInt(source)) {
        codes.push("SURFACE_SOURCE_MISSING");
        continue;
      }
      if (seen.has(source)) codes.push("SURFACE_SOURCE_DUPLICATE");
      seen.add(source);
      if (source >= event.seq) codes.push("SURFACE_SOURCE_NOT_EARLIER");
      if (!existingSeqs.has(source)) codes.push("SURFACE_SOURCE_MISSING");
    }
  }

  // ② shadow 必须被 source 全覆盖(只声明一部分就等于静默丢行)。
  if (Array.isArray(opts.shadowedSeqs) && opts.shadowedSeqs.length > 0) {
    const declared = new Set<number>(Array.isArray(sources) ? sources.filter(isInt) : []);
    for (const seq of opts.shadowedSeqs) {
      if (!isInt(seq) || !declared.has(seq)) {
        codes.push("SURFACE_SHADOW_INCOMPLETE");
        break;
      }
    }
  }

  // ③ compact_end 必须闭合到更早的 compact_start。
  if (event.kind === "compact_end") {
    const starts = history.filter((e) => isRecord(e) && e.kind === "compact_start" && isInt(e.seq) && e.seq < event.seq);
    if (starts.length === 0) codes.push("SURFACE_INVALID");
  }

  // ④ seq 不得与既有事件重复。
  if (duplicateSeq) codes.push("SURFACE_INVALID");

  // ⑤ 工具事件的非 content 字段不得变。
  if ((event.kind === "tool_call" || event.kind === "tool_result") && isRecord(opts.oldEvent)) {
    if (mutatedToolFields(opts.oldEvent, event).length > 0) codes.push("SURFACE_TOOL_FIELDS_MUTATED");
  }

  // ⑥ 代际:必须基于当前代际写回,并声明新代际 = 旧 + 1。
  const current = currentGeneration(history);
  if (!isInt(event.replaceGeneration)) {
    codes.push("SURFACE_INVALID");
  } else {
    if (event.replaceGeneration !== current) codes.push("SURFACE_GENERATION_STALE");
    if (event.contentGeneration !== undefined && event.contentGeneration !== event.replaceGeneration + 1) {
      codes.push("SURFACE_INVALID");
    }
  }

  const uniq = codesOf(...codes);
  if (isFailure(uniq)) return { ok: false, codes: uniq };
  return { ok: true, codes: ["SURFACE_REPLACED"] };
}

/**
 * 把事件应用到表面状态(纯函数,入参不被修改)。
 * append:入 events、记 append-origin、代际不变。
 * replace:入 events(被 shadow 的原事件**不删除**)、source 全进 shadowed 并从 append-origin 移除、
 * contentGeneration = replaceGeneration + 1。落盘事件补上归一化的 contentGeneration,
 * 使 currentGeneration(events) 与 state.contentGeneration 恒等(重放一致的前提)。
 */
export function applySurfaceEvent(
  state: SurfaceState,
  event: SurfaceEvent): { state: SurfaceState; codes: string[] } {
  const base = coerceState(state);
  if (!isRecord(event)) {
    return { state: base, codes: ["SURFACE_INVALID"] };
  }
  if (event.surfaceOp === "append") {
    return {
      state: {
        events: [...base.events, { ...event }],
        appendOrigin: new Set([...base.appendOrigin, event.seq]),
        contentGeneration: base.contentGeneration,
        shadowed: new Set(base.shadowed),
      },
      codes: ["SURFACE_APPENDED"],
    };
  }

  const contentGeneration =
    (isInt(event.replaceGeneration) ? event.replaceGeneration : base.contentGeneration) + 1;
  const shadowed = new Set(base.shadowed);
  const appendOrigin = new Set(base.appendOrigin);
  const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.filter(isInt) : [];
  for (const seq of sources) {
    shadowed.add(seq);
    appendOrigin.delete(seq);
  }
  // replace 事件自身是「当前有效内容」的新节点:它进 append-origin(未被 shadow),
  // 被它覆盖的 source 移出——这样人读转录既不丢改写后的内容,也不出现已被覆盖的行。
  appendOrigin.add(event.seq);
  return {
    state: {
      events: [...base.events, { ...event, contentGeneration }],
      appendOrigin,
      contentGeneration,
      shadowed,
    },
    codes: ["SURFACE_REPLACED", "SURFACE_GENERATION_BUMPED"],
  };
}

/** 人读转录:只含 append-origin 事件,按 seq 升序(被 shadow 的内容不出现)。 */
export function humanTranscript(state: SurfaceState): { events: SurfaceEvent[]; codes: string[] } {
  const base = coerceState(state);
  const events = base.events
    .filter((event) => base.appendOrigin.has(event.seq))
    .sort((a, b) => a.seq - b.seq)
    .map((event) => ({ ...event }));
  return { events, codes: ["SURFACE_TRANSCRIPT_BUILT"] };
}

/** 派生缓存版本 = contentGeneration(缓存按内容代际重建,不按行序猜)。 */
export function derivedCacheVersion(state: SurfaceState): number {
  return coerceState(state).contentGeneration;
}

export interface SurfaceIssue {
  code: string;
  seq?: number;
  detail?: string;
}

/**
 * 结构体检:① tool_call / tool_result 配对(按 toolCallId,只看当前可见事件)
 * ② 悬空 shadow(shadowed 指向不存在的 seq,或 replace 的 source 没全进 shadowed)
 * ③ compact_start 未闭合(扩展项:起而不断,压缩事务既不结束也不可复盘)。
 */
export function detectBrokenReplacements(state: SurfaceState): { ok: boolean; issues: SurfaceIssue[] } {
  const base = coerceState(state);
  const issues: SurfaceIssue[] = [];
  const bySeq = new Map<number, SurfaceEvent>();
  for (const event of base.events) bySeq.set(event.seq, event);

  for (const seq of base.shadowed) {
    if (!bySeq.has(seq)) {
      issues.push({ code: "SURFACE_INVALID", seq, detail: "shadowed 引用的 seq 不在事件流里(悬空 shadow)" });
    }
  }
  for (const event of base.events) {
    if (event.surfaceOp !== "replace") continue;
    for (const source of Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []) {
      if (!base.shadowed.has(source)) {
        issues.push({
          code: "SURFACE_SHADOW_INCOMPLETE",
          seq: event.seq,
          detail: `source ${source} 未进 shadowed(journal 与实际覆盖不一致)`,
        });
      }
    }
  }

  const visible = base.events.filter((event) => !base.shadowed.has(event.seq));
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const event of visible) {
    if (event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    const id = typeof event.toolCallId === "string" && event.toolCallId !== "" ? event.toolCallId : undefined;
    if (id === undefined) {
      issues.push({ code: "SURFACE_INVALID", seq: event.seq, detail: `${event.kind} 缺 toolCallId,无法配对` });
      continue;
    }
    if (event.kind === "tool_call") calls.set(id, event.seq);
    else results.set(id, event.seq);
  }
  for (const [id, seq] of calls) {
    if (!results.has(id)) {
      issues.push({ code: "SURFACE_TOOL_CALL_UNPAIRED", seq, detail: `toolCallId=${id} 缺 tool_result` });
    }
  }
  for (const [id, seq] of results) {
    if (!calls.has(id)) {
      issues.push({ code: "SURFACE_TOOL_RESULT_UNPAIRED", seq, detail: `toolCallId=${id} 缺 tool_call` });
    }
  }

  const starts = visible.filter((event) => event.kind === "compact_start");
  const ends = visible.filter((event) => event.kind === "compact_end");
  for (const start of starts) {
    const closed = ends.some((end) => end.seq > start.seq);
    if (!closed) {
      issues.push({ code: "SURFACE_INVALID", seq: start.seq, detail: "compact_start 未闭合(缺 compact_end)" });
    }
  }

  return { ok: issues.length === 0, issues };
}
