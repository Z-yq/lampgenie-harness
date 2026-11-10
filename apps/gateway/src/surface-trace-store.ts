/**
 * 表面替换溯源的持久层:把 surface-trace 的纯逻辑落到 append-only jsonl,读时回放成投影。
 *
 * 数据面:`<root>/.genie/rsi/surface.jsonl`,每行 `{v:1,...SurfaceEvent}`(一事件一行)。
 *
 * 为什么 append-only:一次 replace 是「某段历史在某代际被改写」的审计事实。若直接改写原行,
 * 「谁在什么代际覆盖了哪些节点」就永久不可考;并发压缩基于旧 surface 提交也无从发现。
 * 因此:原事件行永不删除、永不改写,replace 只是**新增一行**声明来源与覆盖,读时回放成
 * `{events, appendOrigin, shadowed, contentGeneration}` 投影——journal 全留,视图收窄。
 *
 * 校验:所有写入先过 runtime 的 validateEvent(同一条契约,CLI/agent loop/gateway 共用),
 * 失败返回 `{ok:false,codes}` 且**不写盘**(拒收即零副作用)。
 * `replaceEvent` 在只有一个 source 且该事件存在时自动带上 oldEvent,这样 tool_call/tool_result
 * 的「只允许改 content」不需要调用方每次自己捞旧事件;多 source 时不猜(shadowedSeqs 同理不猜)。
 *
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其它业务模块。
 * runtime 模块按 cohort-signature-store 的两跳套路惰性解析(vitest 走 development 导出、
 * 裸 tsx/dist 回退仓内源文件),顶层 await 以保持所有导出函数同步签名。
 * 除参数错误(root 非法)外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SurfaceEvent,
  SurfaceIssue,
  SurfaceOp,
  SurfaceState,
  SurfaceValidateOptions,
} from "@lampgenie/runtime/agent/surface-trace";

/** store 稳定码(SURFACE_ 前缀,与 runtime 契约码同族;说「存/取失败」而非「契约拒收」)。 */
export const SURFACE_STORE_CODES = [
  "SURFACE_STORE_INVALID_ROOT",
  "SURFACE_STORE_WRITE_FAILED",
] as const;

export const SURFACE_KINDS = ["message", "tool_call", "tool_result", "compact_start", "compact_end"] as const;

export interface SurfaceWriteResult {
  ok: boolean;
  codes: string[];
  /** 写入后的事件流长度(账本行数,不含坏行)。 */
  events?: number;
}

export interface SurfaceProjection {
  state: SurfaceState;
  totalLines: number;
  parseErrors: number;
  badLines: number[];
}

export interface SurfaceTranscriptResult {
  ok: true;
  events: SurfaceEvent[];
  codes: string[];
}

export interface SurfaceReport {
  ok: true;
  events: SurfaceEvent[];
  appendOrigin: number[];
  shadowed: number[];
  contentGeneration: number;
  broken: { ok: boolean; issues: SurfaceIssue[] };
  derivedCacheVersion: number;
  parseErrors: number;
  totalLines: number;
  codes: string[];
}

interface SurfaceRuntime {
  validateEvent(
    event: SurfaceEvent,
    existing: readonly SurfaceEvent[],
    opts?: SurfaceValidateOptions,
  ): { ok: boolean; codes: string[] };
  applySurfaceEvent(state: SurfaceState, event: SurfaceEvent): { state: SurfaceState; codes: string[] };
  humanTranscript(state: SurfaceState): { events: SurfaceEvent[]; codes: string[] };
  derivedCacheVersion(state: SurfaceState): number;
  detectBrokenReplacements(state: SurfaceState): { ok: boolean; issues: SurfaceIssue[] };
}

let surfaceRuntime: SurfaceRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadSurfaceRuntime(): Promise<SurfaceRuntime> {
  if (surfaceRuntime) return surfaceRuntime;
  const spec = "@lampgenie/runtime/agent/surface-trace";
  try {
    surfaceRuntime = (await import(spec)) as SurfaceRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/surface-trace.ts", import.meta.url).href;
    surfaceRuntime = (await import(srcUrl)) as SurfaceRuntime;
  }
  return surfaceRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadSurfaceRuntime();

const KIND_SET: ReadonlySet<string> = new Set<string>(SURFACE_KINDS);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** 表面台账文件绝对路径:`<root>/.genie/rsi/surface.jsonl`。 */
export function surfaceTracePath(root: string): string {
  return join(assertRoot(root), ".genie", "rsi", "surface.jsonl");
}

/** 空投影(文件不存在 / 读失败时的起点)。 */
function emptyProjection(): SurfaceProjection {
  return {
    state: { events: [], appendOrigin: new Set<number>(), contentGeneration: 0, shadowed: new Set<number>() },
    totalLines: 0,
    parseErrors: 0,
    badLines: [],
  };
}

/** 行 → 事件(形状不合法返回 undefined,调用方计入 badLines)。 */
function coerceEventLine(value: unknown): SurfaceEvent | undefined {
  if (!isRecord(value)) return undefined;
  const payload = value["v"] === 1 ? { ...value } : undefined;
  if (payload === undefined) return undefined;
  delete payload["v"];
  if (!isInt(payload["seq"]) || payload["seq"] < 1) return undefined;
  if (typeof payload["kind"] !== "string" || !KIND_SET.has(payload["kind"])) return undefined;
  if (payload["surfaceOp"] !== "append" && payload["surfaceOp"] !== "replace") return undefined;
  if (!isInt(payload["at"])) return undefined;
  const kind = payload["kind"] as SurfaceEvent["kind"];
  const surfaceOp = payload["surfaceOp"] as SurfaceOp;
  return { ...payload, seq: payload["seq"], kind, surfaceOp, at: payload["at"] };
}

/** 读整个台账并回放成投影:坏行计入 parseErrors/badLines 并跳过,不 throw、不整文件失效。 */
export function loadSurfaceTrace(root: string): SurfaceProjection {
  const path = surfaceTracePath(root);
  const projection = emptyProjection();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return projection;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    projection.totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      projection.parseErrors += 1;
      projection.badLines.push(i + 1);
      continue;
    }
    const event = coerceEventLine(parsed);
    if (event === undefined) {
      projection.parseErrors += 1;
      projection.badLines.push(i + 1);
      continue;
    }
    projection.state = rt.applySurfaceEvent(projection.state, event).state;
  }
  return projection;
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** 追加一行并做写后行数校验(写成功是可复核断言,而不是信任 append 没抛)。 */
function appendLine(root: string, event: SurfaceEvent): boolean {
  const path = surfaceTracePath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ v: 1, ...event })}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

/** 单 source 时自动补 oldEvent(工具字段不变性校验用);多 source 不猜。 */
function withOldEvent(
  event: SurfaceEvent,
  existing: readonly SurfaceEvent[],
  opts: SurfaceValidateOptions | undefined,
): SurfaceValidateOptions {
  if (opts?.oldEvent !== undefined) return opts;
  const sources = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [];
  if (sources.length !== 1) return opts ?? {};
  const old = existing.find((e) => e.seq === sources[0]);
  return old === undefined ? (opts ?? {}) : { ...opts, oldEvent: old };
}

function writeEvent(
  root: string,
  input: unknown,
  want: SurfaceOp,
  opts?: SurfaceValidateOptions,
): SurfaceWriteResult {
  const path = surfaceTracePath(root);
  if (!isRecord(input)) return { ok: false, codes: ["SURFACE_INVALID"] };
  const declared = input["surfaceOp"];
  const event = { ...input, surfaceOp: declared ?? want } as SurfaceEvent;
  if (event.surfaceOp !== want) return { ok: false, codes: ["SURFACE_INVALID"] };
  if (!isInt(event.seq) || !KIND_SET.has(String(event.kind))) return { ok: false, codes: ["SURFACE_INVALID"] };

  const projection = loadSurfaceTrace(root);
  const verdict = rt.validateEvent(
    event,
    projection.state.events,
    want === "replace" ? withOldEvent(event, projection.state.events, opts) : opts,
  );
  if (!verdict.ok) return { ok: false, codes: verdict.codes };
  if (!appendLine(root, event)) {
    return { ok: false, codes: ["SURFACE_STORE_WRITE_FAILED"] };
  }
  return { ok: true, codes: verdict.codes, events: projection.state.events.length + 1 };
}

/** 只校验不写盘:给 agent loop / 并发压缩在提交前试探。 */
export function validateIncoming(
  root: string,
  event: unknown,
  opts?: SurfaceValidateOptions,
): { ok: boolean; codes: string[] } {
  if (!isRecord(event)) return { ok: false, codes: ["SURFACE_INVALID"] };
  const projection = loadSurfaceTrace(root);
  const candidate = { ...event } as SurfaceEvent;
  return rt.validateEvent(
    candidate,
    projection.state.events,
    candidate.surfaceOp === "replace" ? withOldEvent(candidate, projection.state.events, opts) : opts,
  );
}

/** 追加一条 append 事件(契约不过就拒收且不写盘)。 */
export function appendEvent(root: string, event: unknown, opts?: SurfaceValidateOptions): SurfaceWriteResult {
  return writeEvent(root, event, "append", opts);
}

/** 追加一条 replace 事件(同上;单 source 自动带 oldEvent)。 */
export function replaceEvent(root: string, event: unknown, opts?: SurfaceValidateOptions): SurfaceWriteResult {
  return writeEvent(root, event, "replace", opts);
}

/** 人读转录:只含 append-origin(被 shadow 的内容不出现)。 */
export function transcript(root: string): SurfaceTranscriptResult {
  const projection = loadSurfaceTrace(root);
  const built = rt.humanTranscript(projection.state);
  return { ok: true, events: built.events, codes: built.codes };
}

/** 派生缓存版本(= contentGeneration)。 */
export function version(root: string): number {
  return rt.derivedCacheVersion(loadSurfaceTrace(root).state);
}

/** 全量体检:投影 + 结构问题(broken)+ 派生缓存版本。 */
export function report(root: string): SurfaceReport {
  const projection = loadSurfaceTrace(root);
  const state = projection.state;
  const broken = rt.detectBrokenReplacements(state);
  return {
    ok: true,
    events: state.events,
    appendOrigin: [...state.appendOrigin].sort((a, b) => a - b),
    shadowed: [...(state.shadowed ?? [])].sort((a, b) => a - b),
    contentGeneration: state.contentGeneration,
    broken,
    derivedCacheVersion: rt.derivedCacheVersion(state),
    parseErrors: projection.parseErrors,
    totalLines: projection.totalLines,
    codes: broken.ok ? ["SURFACE_REPORT_OK"] : ["SURFACE_REPORT_BROKEN"],
  };
}
