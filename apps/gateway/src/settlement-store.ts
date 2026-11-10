/**
 * 结算落盘层(tool-settlement 的持久面):把「哪几个任务被 fork 出去、谁被 await、谁被 drain
 * 掉、race 谁赢、超时砍了谁」写成可复核的事件流 `<root>/.genie/rsi/settlement.jsonl`。
 *
 * 文件形状:JSONL,一行一个事件(v=1):
 *   { v: 1, at: <number>, kind, taskId?, payload }
 * - **只 append,不改写**:结算动作本质是时序事实,重排/覆盖会把「谁先被观察」这条因果抹掉;
 * - **坏行不整文件失效**:逐行 JSON.parse,坏行只记 1-based 行号并跳过——一条脏行不该让整段
 *   结算历史变成不可读(与 tool-pins-store 的 countLines/append 口径同源);
 * - **写后行数校验**:append 后重数非空行,必须 before+1,否则返回 false(不 throw、不回滚)。
 *
 * 依赖纪律:node:fs / node:path + runtime 结算原语(两跳惰性解析:先包 spec,vitest 的
 * `--conditions=development` 走 src 入口;`node --experimental-strip-types` 跑 CLI 时 spec 解析不到
 * dist,回退仓内相对 src URL——同 fixture-store.ts:107 的口径)。类型面用 `import type`,被
 * verbatimModuleSyntax 擦除,故运行时零静态依赖。
 * 除参数错误(root 不是非空字符串 → TypeError)外不 throw:IO 失败折叠成 false / 空结果。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SettleHandle,
  SettleTask,
  SettlementLog,
} from "@lampgenie/runtime/agent/tool-settlement";

/* ------------------------------------------------------------------ *
 * 事件模型
 * ------------------------------------------------------------------ */

export type SettlementEventKind = "fork" | "await" | "drain" | "race" | "timeout" | "report" | "cancel";

export const SETTLEMENT_KINDS: readonly SettlementEventKind[] = [
  "fork",
  "await",
  "drain",
  "race",
  "timeout",
  "report",
  "cancel",
];

const KIND_SET = new Set<string>(SETTLEMENT_KINDS);

export interface SettlementEvent {
  v: 1;
  at: number;
  kind: SettlementEventKind;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface SettlementEventInput {
  /** 事件时间戳(ms);缺省 Date.now()。测试/回放可注入以复现时序。 */
  at?: number;
  kind: SettlementEventKind;
  taskId?: string;
  payload?: Record<string, unknown>;
}

export interface SettlementReadResult {
  events: SettlementEvent[];
  /** 1-based 行号:JSON 不合法,或形状不合法(v !== 1 / kind 未知 / payload 非对象)。 */
  badLines: number[];
  /** 仅统计 JSON.parse 失败的行数(形状不合法计入 badLines 但不计入这里)。 */
  parseErrors: number;
}

export interface SettlementReport {
  total: number;
  byKind: Record<SettlementEventKind, number>;
  /** 各事件 payload.diagnostics 计数之和 = 未观察拒绝数。 */
  diagnostics: number;
  recent: SettlementEvent[];
  badLines: number[];
  parseErrors: number;
}

/* ------------------------------------------------------------------ *
 * runtime 惰性加载(两跳:包 spec → 仓内 src)
 * ------------------------------------------------------------------ */

interface SettlementRuntime {
  eagerFork<T>(
    tasks: SettleTask<T>[],
    opts?: { env?: { maxConcurrency?: number; now?: () => number }; onStart?: (h: SettleHandle<T>, i: number) => void },
  ): { handles: SettleHandle<T>[]; drain: () => Promise<SettlementLog> };
  drain(handles: SettleHandle[]): Promise<SettlementLog>;
  raceSettle<T>(
    handles: SettleHandle<T>[],
  ): Promise<{ winner: SettleHandle<T>; aborted: string[]; log: SettlementLog }>;
  awaitHandle<T>(h: SettleHandle<T>): Promise<T>;
  abortHandle(h: SettleHandle, code?: string): void;
  withTimeout(
    handles: SettleHandle[],
    ms: number,
  ): Promise<
    | { status: "completed"; log: SettlementLog }
    | { status: "timeout"; code: "SETTLE_TIMEOUT_ABORTED"; aborted: string[] }
  >;
}

let settlementRuntime: SettlementRuntime | undefined;

async function loadRuntime<T>(specifier: string, fallbackPath: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    const url = new URL(fallbackPath, import.meta.url).href;
    return (await import(url)) as T;
  }
}

async function runtime(): Promise<SettlementRuntime> {
  if (settlementRuntime !== undefined) return settlementRuntime;
  settlementRuntime = await loadRuntime<SettlementRuntime>(
    "@lampgenie/runtime/agent/tool-settlement",
    "../../../packages/harness-runtime/src/agent/tool-settlement.ts",
  );
  return settlementRuntime;
}

/* ------------------------------------------------------------------ *
 * 路径与读写
 * ------------------------------------------------------------------ */

function ensureRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("settlement-store: root 必须是非空字符串");
  return root.trim();
}

/** 结算事件流路径。 */
export function settlementPath(root: string): string {
  return join(ensureRoot(root), ".genie", "rsi", "settlement.jsonl");
}

/** 统计非空行数;文件不存在/读失败按 0。 */
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

/**
 * 追加一条结算事件。成功(true)= 落盘且写后行数 = before + 1;
 * IO 失败或 kind 非法 → false,不 throw、不回滚。
 */
export function appendSettlementEvent(root: string, ev: SettlementEventInput): boolean {
  if (ev === null || typeof ev !== "object" || !KIND_SET.has(ev.kind)) return false;
  const payload = ev.payload !== null && typeof ev.payload === "object" ? ev.payload : {};
  const event: SettlementEvent = {
    v: 1,
    at: typeof ev.at === "number" && Number.isFinite(ev.at) ? ev.at : Date.now(),
    kind: ev.kind,
    ...(typeof ev.taskId === "string" && ev.taskId !== "" ? { taskId: ev.taskId } : {}),
    payload,
  };
  const path = settlementPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

function normalizeEvent(value: unknown): SettlementEvent | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return undefined;
  if (typeof raw.kind !== "string" || !KIND_SET.has(raw.kind)) return undefined;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  const payload = raw.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const event: SettlementEvent = {
    v: 1,
    at: raw.at,
    kind: raw.kind as SettlementEventKind,
    payload: payload as Record<string, unknown>,
  };
  if (typeof raw.taskId === "string" && raw.taskId !== "") event.taskId = raw.taskId;
  return event;
}

/** 逐行读;坏行记 1-based 行号并跳过,不整文件失效。文件不存在 → 空结果零错误。 */
export function readSettlementEvents(root: string): SettlementReadResult {
  const path = settlementPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { events: [], badLines: [], parseErrors: 0 };
  }
  const events: SettlementEvent[] = [];
  const badLines: number[] = [];
  let parseErrors = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      badLines.push(i + 1);
      parseErrors += 1;
      continue;
    }
    const event = normalizeEvent(parsed);
    if (event === undefined) {
      badLines.push(i + 1);
      continue;
    }
    events.push(event);
  }
  return { events, badLines, parseErrors };
}

/* ------------------------------------------------------------------ *
 * 聚合
 * ------------------------------------------------------------------ */

function emptyByKind(): Record<SettlementEventKind, number> {
  const out = {} as Record<SettlementEventKind, number>;
  for (const kind of SETTLEMENT_KINDS) out[kind] = 0;
  return out;
}

function diagnosticsOf(event: SettlementEvent): number {
  const value = event.payload.diagnostics;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (Array.isArray(value)) return value.length;
  return 0;
}

/** 事件流排序:按 at 升序(同 at 保持落盘顺序),供「最近 limit 条」取样。 */
function sortedEvents(events: SettlementEvent[]): SettlementEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (a.event.at === b.event.at ? a.index - b.index : a.event.at - b.event.at))
    .map((entry) => entry.event);
}

/** 聚合:总数 / 分 kind 计数 / 未观察拒绝数 / 最近 limit 条 / 坏行。 */
export function settlementReport(root: string, opts: { limit?: number } = {}): SettlementReport {
  const read = readSettlementEvents(root);
  const byKind = emptyByKind();
  let diagnostics = 0;
  for (const event of read.events) {
    byKind[event.kind] += 1;
    diagnostics += diagnosticsOf(event);
  }
  const ordered = sortedEvents(read.events);
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
    ? Math.trunc(opts.limit)
    : 20;
  const recent = ordered.slice(Math.max(0, ordered.length - limit));
  return {
    total: read.events.length,
    byKind,
    diagnostics,
    recent,
    badLines: read.badLines,
    parseErrors: read.parseErrors,
  };
}

/* ------------------------------------------------------------------ *
 * 五个包装:动作发生即落盘,并原样返回 runtime 结果
 * ------------------------------------------------------------------ */

export interface SettlementWrapperOptions {
  /** 事件时间戳来源(缺省 Date.now());测试注入以稳定时序。 */
  now?: () => number;
}

export interface ForkOptions extends SettlementWrapperOptions {
  env?: { maxConcurrency?: number; now?: () => number };
  onStart?: (handle: SettleHandle, index: number) => void;
}

export interface ForkResult<T = unknown> {
  handles: SettleHandle<T>[];
  /** 本次新落盘的 fork 事件对应的 handle id。 */
  forked: string[];
  /** 已落过 fork 事件的 handle id(重复 fork 幂等跳过)。 */
  skipped: string[];
  drain: () => Promise<SettlementLog>;
}

function isTask(value: unknown): value is SettleTask {
  return value !== null && typeof value === "object" && typeof (value as { run?: unknown }).run === "function";
}

function isHandle(value: unknown): value is SettleHandle {
  return value !== null && typeof value === "object" && "promise" in value && "controller" in value;
}

function statesOf(handles: readonly SettleHandle[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const handle of handles) out[handle.id] = handle.state;
  return out;
}

function codesOf(handle: SettleHandle): string[] {
  return Array.isArray(handle.codes) ? handle.codes.map((code) => String(code)) : [];
}

/**
 * fork:任务列表 → runtime eagerFork 并逐个落 fork 事件;handle 列表 → 只补落尚未记录的 fork
 * 事件(同 id 重复 fork 幂等,不重复记账)。
 */
export async function fork<T = unknown>(
  root: string,
  items: readonly SettleTask<T>[] | readonly SettleHandle<T>[],
  opts: ForkOptions = {},
): Promise<ForkResult<T>> {
  const at = opts.now;
  const list: readonly unknown[] = Array.isArray(items) ? items : [];
  if (list.every(isTask) && list.length > 0) {
    const rt = await runtime();
    const started = rt.eagerFork(list as SettleTask<T>[], {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.onStart !== undefined ? { onStart: opts.onStart as (h: SettleHandle<T>, i: number) => void } : {}),
    });
    const forked: string[] = [];
    started.handles.forEach((handle, index) => {
      const ok = appendSettlementEvent(root, {
        ...(at !== undefined ? { at: at() } : {}),
        kind: "fork",
        taskId: handle.id,
        payload: { index, state: handle.state, total: started.handles.length },
      });
      if (ok) forked.push(handle.id);
    });
    return { handles: started.handles, forked, skipped: [], drain: started.drain };
  }
  const handles = list.filter(isHandle) as SettleHandle<T>[];
  const known = new Set<string>();
  for (const event of readSettlementEvents(root).events) {
    if (event.kind === "fork" && typeof event.taskId === "string") known.add(event.taskId);
  }
  const forked: string[] = [];
  const skipped: string[] = [];
  handles.forEach((handle, index) => {
    if (known.has(handle.id)) {
      skipped.push(handle.id);
      return;
    }
    const ok = appendSettlementEvent(root, {
      ...(at !== undefined ? { at: at() } : {}),
      kind: "fork",
      taskId: handle.id,
      payload: { index, state: handle.state, total: handles.length },
    });
    if (ok) {
      forked.push(handle.id);
      known.add(handle.id);
    }
  });
  return {
    handles,
    forked,
    skipped,
    drain: async (): Promise<SettlementLog> => ({ handles: handles.map((h) => h as SettleHandle), diagnostics: [] }),
  };
}

export interface AwaitAllResult {
  results: { id: string; ok: boolean; value?: unknown; error?: unknown; state: string; codes: string[] }[];
  failures: number;
}

/** awaitAll:逐个 awaitHandle(观察权在此转移),每个 handle 落一条 await 事件。 */
export async function awaitAll<T = unknown>(
  root: string,
  handles: readonly SettleHandle<T>[],
  opts: SettlementWrapperOptions = {},
): Promise<AwaitAllResult> {
  const rt = await runtime();
  const results: AwaitAllResult["results"] = [];
  let failures = 0;
  for (const handle of handles) {
    let ok = true;
    let value: unknown;
    let error: unknown;
    try {
      value = await rt.awaitHandle(handle);
    } catch (err) {
      ok = false;
      error = err;
      failures += 1;
    }
    results.push({
      id: handle.id,
      ok,
      ...(ok ? { value } : { error }),
      state: handle.state,
      codes: codesOf(handle),
    });
    appendSettlementEvent(root, {
      ...(opts.now !== undefined ? { at: opts.now() } : {}),
      kind: "await",
      taskId: handle.id,
      payload: {
        ok,
        state: handle.state,
        observed: handle.observed === true,
        awaitCount: typeof handle.awaitCount === "number" ? handle.awaitCount : 0,
        codes: codesOf(handle),
      },
    });
  }
  return { results, failures };
}

/** drain:等全部落定,落一条 drain 事件(带未观察拒绝数),原样返回 SettlementLog。 */
export async function drain(
  root: string,
  handles: readonly SettleHandle[],
  opts: SettlementWrapperOptions = {},
): Promise<SettlementLog> {
  const rt = await runtime();
  const log = await rt.drain(handles as SettleHandle[]);
  const diagnostics = Array.isArray(log?.diagnostics) ? log.diagnostics : [];
  appendSettlementEvent(root, {
    ...(opts.now !== undefined ? { at: opts.now() } : {}),
    kind: "drain",
    payload: {
      handles: handles.length,
      states: statesOf(handles),
      diagnostics: diagnostics.length,
      details: diagnostics.map((d) => ({ kind: d.kind, handleId: d.handleId, at: d.at })),
    },
  });
  return log;
}

export interface RaceResult<T = unknown> {
  winner: SettleHandle<T>;
  aborted: string[];
  log: SettlementLog;
}

/** race:首个落定者胜出,其余 abort;落一条 race 事件(winner + aborted 名单)。 */
export async function race<T = unknown>(
  root: string,
  handles: readonly SettleHandle<T>[],
  opts: SettlementWrapperOptions = {},
): Promise<RaceResult<T>> {
  const rt = await runtime();
  const result = await rt.raceSettle(handles as SettleHandle<T>[]);
  const diagnostics = Array.isArray(result?.log?.diagnostics) ? result.log.diagnostics : [];
  appendSettlementEvent(root, {
    ...(opts.now !== undefined ? { at: opts.now() } : {}),
    kind: "race",
    taskId: result.winner?.id,
    payload: {
      winner: result.winner?.id ?? null,
      winnerState: result.winner?.state ?? null,
      aborted: Array.isArray(result.aborted) ? result.aborted : [],
      handles: handles.length,
      diagnostics: diagnostics.length,
    },
  });
  return result;
}

/** report:聚合 + 落一条 report 事件,返回聚合结果。 */
export async function report(
  root: string,
  opts: SettlementWrapperOptions & { limit?: number } = {},
): Promise<SettlementReport> {
  const aggregate = settlementReport(root, opts.limit !== undefined ? { limit: opts.limit } : {});
  appendSettlementEvent(root, {
    ...(opts.now !== undefined ? { at: opts.now() } : {}),
    kind: "report",
    payload: {
      total: aggregate.total,
      byKind: aggregate.byKind,
      diagnostics: aggregate.diagnostics,
      badLines: aggregate.badLines.length,
      parseErrors: aggregate.parseErrors,
      limit: opts.limit ?? 20,
    },
  });
  return aggregate;
}

/* ------------------------------------------------------------------ *
 * 附加包装(kind 里已有 timeout / cancel,CLI 需要同一套落盘)
 * ------------------------------------------------------------------ */

export interface TimeoutResult {
  status: "completed" | "timeout";
  code?: "SETTLE_TIMEOUT_ABORTED";
  aborted: string[];
  log?: SettlementLog;
}

/** withTimeout:落一条 timeout 事件(completed 也算一次超时判定的留痕)。 */
export async function withTimeout(
  root: string,
  handles: readonly SettleHandle[],
  ms: number,
  opts: SettlementWrapperOptions = {},
): Promise<TimeoutResult> {
  const rt = await runtime();
  const result = await rt.withTimeout(handles as SettleHandle[], ms);
  if (result.status === "timeout") {
    appendSettlementEvent(root, {
      ...(opts.now !== undefined ? { at: opts.now() } : {}),
      kind: "timeout",
      payload: { status: "timeout", code: result.code, aborted: result.aborted, ms, handles: handles.length },
    });
    return { status: "timeout", code: result.code, aborted: Array.isArray(result.aborted) ? result.aborted : [] };
  }
  const diagnostics = Array.isArray(result.log?.diagnostics) ? result.log.diagnostics : [];
  appendSettlementEvent(root, {
    ...(opts.now !== undefined ? { at: opts.now() } : {}),
    kind: "timeout",
    payload: { status: "completed", ms, handles: handles.length, diagnostics: diagnostics.length },
  });
  return { status: "completed", aborted: [], log: result.log };
}

/** cancelAll:逐个 abort,落一条 cancel 事件(带被砍的 id 与码)。 */
export async function cancelAll(
  root: string,
  handles: readonly SettleHandle[],
  code?: string,
  opts: SettlementWrapperOptions = {},
): Promise<{ aborted: string[] }> {
  const rt = await runtime();
  const aborted: string[] = [];
  for (const handle of handles) {
    if (handle.state === "pending") {
      rt.abortHandle(handle, code);
      aborted.push(handle.id);
    }
  }
  appendSettlementEvent(root, {
    ...(opts.now !== undefined ? { at: opts.now() } : {}),
    kind: "cancel",
    payload: { aborted, code: code ?? "SETTLE_CANCELLED", handles: handles.length },
  });
  return { aborted };
}
