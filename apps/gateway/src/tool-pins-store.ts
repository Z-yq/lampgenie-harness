/**
 * 工具版本钉扎持久层(生产侧,#207 工具会话钉扎 2026-11):把 tool-version-pin 的纯逻辑
 * 落到 append-only jsonl,让「这次会话把每个工具钉在哪个版本、什么时候升过、关没关、
 * 历史调用按哪个 schema 回放」成为可复核的事实。
 *
 * 为什么 append-only:钉扎台账是排查的最后一根绳子——「当时钉的是 1.0.0」不能被后来的写入覆盖;
 * 单行追加 + 写后重读行数校验让「写成功了吗」成为可复核断言。
 *
 * 数据面:`<root>/.genie/rsi/tool-pins.jsonl`,每行 `{v:1,type,at,sessionId,...}`
 * - `at` 统一是 ISO 字符串(审计人读),协议纯函数要的毫秒数由 `Date.parse(line.at)` 反推;
 *   调用方传 `at` 时给毫秒数,落盘归一成 ISO。
 * - create  {catalog,overrides?,versions,status:"open"}  会话开启:把此刻 catalog 快照与钉住的版本一起落盘
 *   (快照落盘是为了「当时目录长什么样」可查;但 replay 仍用调用方传入的 catalog,见下)。
 * - call    {callId,tool,version,args,traceBatchKey?}    一次调用,version 是钉扎解析出来的,不是调用方给的
 * - upgrade {tool,from,to,by,confirmed:true}             会话内升级留痕(未确认的升级不会出现在这里)
 * - close   {sessionId}                                  会话关闭
 *
 * 关于第四种行类型 `close`(对任务书三种类型的必要补充):create/call/upgrade 只能表达
 * 「会话开着、钉着、升过」,而「会话已关闭 → 不再接受新调用/新升级」是协议里
 * TOOL_PIN_SESSION_LOCKED 的判据来源,必须有落点;否则投影永远算不出 status="closed",
 * 关闭后的调用会被静默接受。故以 `close` 行承载,语义等价于协议 pins.status="closed"。
 *
 * 投影语义(loadPins):按行序归并。
 * - create 建会话(带 catalog 快照与 versions);同 sessionId 重复 create 行视为坏行(create 是「会话开启一次」)。
 * - upgrade 更新该会话 versions 并追加 upgrades(无 create 前置 → 坏行)。
 * - close 置 status="closed"(无 create 前置 → 坏行)。
 * - call 直接累积(调用历史不依赖会话是否还开着)。
 * 坏行(JSON 坏 / v 不是 1 / type 未知 / 缺载荷 / at 不可解析)只计入 parseErrors 与 badLines
 * (1-based 行号)并跳过:一行坏不整文件失效、不 throw。
 *
 * replay 不回退落盘快照:catalog 一律用调用方的入参。快照只是审计痕迹,若 replay 偷偷回落到
 * 快照,「catalog 里删掉旧 schema → SCHEMA_MISSING」这个最重要的报警就永远演示不出来。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(两跳惰性解析:先包 spec,vitest 的
 * `--conditions=development` 走 src 入口;`node --experimental-strip-types` 直接跑 CLI 时
 * spec 解析不到 dist,回退仓内相对 src URL)。不 import agent loop、不 import gateway 其余业务模块。
 * 除参数错误(root/sessionId 不是非空字符串 → TypeError,与 experiment-store 同口径)外不 throw:
 * IO 失败一律折叠成 TOOL_PIN_STORE_ERROR。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  JSONSchemaObject,
  SessionToolPins,
  SessionToolPinsUpgrade,
  ToolCallRecord,
  ToolCatalog,
} from "@lampgenie/runtime/agent/tool-version-pin";

/** 协议稳定码(字面量:store 不能静态 import 未 build 的 runtime 包取值,码是公开契约)。 */
const CODE_INVALID = "TOOL_PIN_INVALID";
const CODE_CREATED = "TOOL_PIN_CREATED";
const CODE_UNKNOWN_TOOL = "TOOL_PIN_UNKNOWN_TOOL";
const CODE_SESSION_LOCKED = "TOOL_PIN_SESSION_LOCKED";
const CODE_UPGRADED = "TOOL_PIN_UPGRADED";

/** store 层自产失败码(其余沿用 runtime 的 TOOL_PIN_*)。 */
export const TOOL_PIN_NOT_FOUND = "TOOL_PIN_NOT_FOUND";
export const TOOL_PIN_DUPLICATE = "TOOL_PIN_DUPLICATE";
export const TOOL_PIN_STORE_ERROR = "TOOL_PIN_STORE_ERROR";

/** store 自产码表(只读数组,上游可整体遍历/断言)。 */
export const TOOL_PINS_STORE_CODES = [TOOL_PIN_NOT_FOUND, TOOL_PIN_DUPLICATE, TOOL_PIN_STORE_ERROR] as const;

/** 台账行。`v` 是契约版本,字段语义变化时递增。 */
export interface PinsCreateLine {
  v: 1;
  type: "create";
  at: string;
  sessionId: string;
  catalog: ToolCatalog;
  overrides?: Record<string, string>;
  versions: Record<string, string>;
  status: "open";
}

export interface PinsCallLine {
  v: 1;
  type: "call";
  at: string;
  sessionId: string;
  callId: string;
  tool: string;
  version: string;
  args: Record<string, unknown>;
  traceBatchKey?: string;
}

export interface PinsUpgradeLine {
  v: 1;
  type: "upgrade";
  at: string;
  sessionId: string;
  tool: string;
  from: string;
  to: string;
  by: string;
  confirmed: true;
}

export interface PinsCloseLine {
  v: 1;
  type: "close";
  at: string;
  sessionId: string;
}

export type PinsLine = PinsCreateLine | PinsCallLine | PinsUpgradeLine | PinsCloseLine;

export interface CreatePinsInput {
  sessionId: string;
  catalog: ToolCatalog;
  overrides?: Record<string, string>;
}

export interface CreatePinsResult {
  ok: boolean;
  codes: string[];
  pins?: SessionToolPins;
}

export interface GetPinsResult {
  pins?: SessionToolPins;
  codes: string[];
  parseErrors: number;
  badLines: number[];
}

export interface CloseSessionResult {
  ok: boolean;
  codes: string[];
}

export interface RecordCallStoreInput {
  sessionId: string;
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
  traceBatchKey?: string;
}

export interface RecordCallStoreResult {
  ok: boolean;
  codes: string[];
  call?: ToolCallRecord;
}

export interface ApplyUpgradeStoreInput {
  sessionId: string;
  tool: string;
  to: string;
  by: string;
  confirmed?: boolean;
}

export interface ApplyUpgradeStoreResult {
  ok: boolean;
  codes: string[];
  pins?: SessionToolPins;
}

export interface ReplayCallStoreInput {
  sessionId: string;
  callId: string;
  catalog: ToolCatalog;
}

export interface ReplayCallStoreResult {
  schema?: JSONSchemaObject;
  codes: string[];
}

export interface ListCallsInput {
  sessionId?: string;
}

export interface ListCallsResult {
  calls: ToolCallRecord[];
  parseErrors: number;
  badLines: number[];
}

export interface PinsUpgradeEntry {
  sessionId: string;
  tool: string;
  from: string;
  to: string;
  by: string;
  confirmed: boolean;
  at: string;
}

export interface PinsSessionEntry {
  sessionId: string;
  status: "open" | "closed";
  versions: Record<string, string>;
}

export interface ReportPinsResult {
  path: string;
  open: string[];
  closed: string[];
  callsByVersion: Record<string, number>;
  upgrades: PinsUpgradeEntry[];
  sessions: PinsSessionEntry[];
  parseErrors: number;
  badLines: number[];
  totalLines: number;
}

/** runtime tool-version-pin 在本文件用到的模块面(签名以协议文件为准)。 */
interface ToolPinRuntime {
  readonly TOOL_PIN_VERSION: number;
  createSessionPins(input: unknown): { pins: SessionToolPins; codes: string[] };
  recordCall(pins: unknown, input: unknown): { call?: ToolCallRecord; codes: string[] };
  applyUpgrade(pins: unknown, input: unknown): { pins: SessionToolPins; codes: string[] };
  replayCall(call: unknown, catalog: unknown): { schema?: JSONSchemaObject; codes: string[] };
}

let runtime: ToolPinRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadRuntime(): Promise<ToolPinRuntime> {
  if (runtime) return runtime;
  const spec = "@lampgenie/runtime/agent/tool-version-pin";
  try {
    runtime = (await import(spec)) as unknown as ToolPinRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/tool-version-pin.ts", import.meta.url).href;
    runtime = (await import(srcUrl)) as unknown as ToolPinRuntime;
  }
  return runtime;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 参数错误是唯一允许 throw 的情形(TypeError,与 experiment-store 同口径)。 */
function assertRoot(root: unknown): string {
  if (!isFilled(root)) throw new TypeError("tool-pins-store: root 必须是非空字符串");
  return root;
}

function assertSessionId(sessionId: unknown): string {
  if (!isFilled(sessionId)) throw new TypeError("tool-pins-store: sessionId 必须是非空字符串");
  return sessionId;
}

function toIso(at: number): string {
  return new Date(at).toISOString();
}

/** 台账文件绝对路径:`<root>/.genie/rsi/tool-pins.jsonl`。 */
export function toolPinsPath(root: string): string {
  return join(root, ".genie", "rsi", "tool-pins.jsonl");
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

/** 追加一行并做写后行数校验;失败折叠成 TOOL_PIN_STORE_ERROR,不回滚、不 throw。 */
function appendPinsLine(root: string, line: PinsLine): boolean {
  const path = toolPinsPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return false;
  }
  return countLines(path) === before + 1;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isFilled(item)) return undefined;
    out[key] = item;
  }
  return out;
}

interface NormCreate {
  type: "create";
  at: number;
  sessionId: string;
  versions: Record<string, string>;
  catalog: unknown;
  overrides?: Record<string, string>;
}

interface NormCall {
  type: "call";
  at: number;
  sessionId: string;
  call: ToolCallRecord;
}

interface NormUpgrade {
  type: "upgrade";
  at: number;
  sessionId: string;
  upgrade: SessionToolPinsUpgrade;
}

interface NormClose {
  type: "close";
  at: number;
  sessionId: string;
}

type NormLine = NormCreate | NormCall | NormUpgrade | NormClose;

/** 宽松读一行;任何缺失都返回 undefined(由调用方计入 parseErrors/badLines)。 */
function parseLine(raw: string): NormLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value["v"] !== 1) return undefined;
  const atRaw = value["at"];
  const at = typeof atRaw === "string" ? Date.parse(atRaw) : typeof atRaw === "number" ? atRaw : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const sessionId = value["sessionId"];
  if (!isFilled(sessionId)) return undefined;

  const type = value["type"];
  if (type === "create") {
    const versions = stringMap(value["versions"]);
    if (!versions) return undefined;
    if (!isRecord(value["catalog"])) return undefined;
    const line: NormCreate = { type: "create", at, sessionId: sessionId.trim(), versions, catalog: value["catalog"] };
    const overrides = stringMap(value["overrides"]);
    if (overrides) line.overrides = overrides;
    return line;
  }
  if (type === "call") {
    const callId = value["callId"];
    const tool = value["tool"];
    const version = value["version"];
    if (!isFilled(callId) || !isFilled(tool) || !isFilled(version)) return undefined;
    const rawArgs = value["args"];
    if (rawArgs !== undefined && !isRecord(rawArgs)) return undefined;
    const call: ToolCallRecord = {
      callId: callId.trim(),
      sessionId: sessionId.trim(),
      tool: tool.trim(),
      version: version.trim(),
      args: rawArgs === undefined ? {} : { ...(rawArgs as UnknownRecord) },
      at,
    };
    const batch = value["traceBatchKey"];
    if (isFilled(batch)) call.traceBatchKey = batch;
    return { type: "call", at, sessionId: sessionId.trim(), call };
  }
  if (type === "upgrade") {
    const tool = value["tool"];
    const from = value["from"];
    const to = value["to"];
    const by = value["by"];
    if (!isFilled(tool) || !isFilled(from) || !isFilled(to) || !isFilled(by)) return undefined;
    if (value["confirmed"] !== true) return undefined;
    return {
      type: "upgrade",
      at,
      sessionId: sessionId.trim(),
      upgrade: { at, tool: tool.trim(), from: from.trim(), to: to.trim(), by: by.trim(), confirmed: true },
    };
  }
  if (type === "close") return { type: "close", at, sessionId: sessionId.trim() };
  return undefined;
}

interface PinsProjection {
  sessions: Map<string, SessionToolPins>;
  catalogs: Map<string, unknown>;
  calls: ToolCallRecord[];
  upgrades: PinsUpgradeEntry[];
  parseErrors: number;
  badLines: number[];
  totalLines: number;
  ioError: boolean;
}

function emptyProjection(): PinsProjection {
  return {
    sessions: new Map<string, SessionToolPins>(),
    catalogs: new Map<string, unknown>(),
    calls: [],
    upgrades: [],
    parseErrors: 0,
    badLines: [],
    totalLines: 0,
    ioError: false,
  };
}

/** 读台账并投影;文件不存在 = 空台账,其他读失败标 ioError(由上层折叠成 STORE_ERROR)。 */
function loadPins(root: string): PinsProjection {
  const proj = emptyProjection();
  let text: string;
  try {
    text = readFileSync(toolPinsPath(root), "utf8");
  } catch (error) {
    const code = isRecord(error) ? error["code"] : undefined;
    if (code !== "ENOENT") proj.ioError = true;
    return proj;
  }

  let index = 0;
  for (const raw of text.split("\n")) {
    index += 1;
    if (raw.trim() === "") continue;
    proj.totalLines += 1;
    const line = parseLine(raw);
    if (line === undefined) {
      proj.parseErrors += 1;
      proj.badLines.push(index);
      continue;
    }
    if (line.type === "create") {
      if (proj.sessions.has(line.sessionId)) {
        proj.parseErrors += 1;
        proj.badLines.push(index);
        continue;
      }
      proj.sessions.set(line.sessionId, {
        sessionId: line.sessionId,
        createdAt: line.at,
        versions: { ...line.versions },
        status: "open",
        upgrades: [],
      });
      proj.catalogs.set(line.sessionId, line.catalog);
      continue;
    }
    if (line.type === "call") {
      proj.calls.push(line.call);
      continue;
    }
    const session = proj.sessions.get(line.sessionId);
    if (session === undefined) {
      proj.parseErrors += 1;
      proj.badLines.push(index);
      continue;
    }
    if (line.type === "close") {
      session.status = "closed";
      continue;
    }
    session.versions[line.upgrade.tool] = line.upgrade.to;
    session.upgrades.push(line.upgrade);
    proj.upgrades.push({
      sessionId: line.sessionId,
      tool: line.upgrade.tool,
      from: line.upgrade.from,
      to: line.upgrade.to,
      by: line.upgrade.by,
      confirmed: line.upgrade.confirmed,
      at: toIso(line.upgrade.at),
    });
  }
  return proj;
}

function storeError(): { ok: false; codes: string[] } {
  return { ok: false, codes: [TOOL_PIN_STORE_ERROR] };
}

/**
 * 开启会话钉扎:内部调 createSessionPins 算出 versions,再把 catalog 快照一起落盘。
 * 同 sessionId 已存在 → 不写行,报 TOOL_PIN_DUPLICATE(钉扎一旦开启就不再改快照)。
 */
export async function createPins(root: string, input: CreatePinsInput): Promise<CreatePinsResult> {
  const base = assertRoot(root);
  const sessionId = assertSessionId(input?.sessionId);
  if (!isRecord(input.catalog)) return { ok: false, codes: [CODE_INVALID] };
  const overrides = input.overrides === undefined ? undefined : stringMap(input.overrides);
  if (input.overrides !== undefined && overrides === undefined) return { ok: false, codes: [CODE_INVALID] };

  const proj = loadPins(base);
  if (proj.ioError) return storeError();
  if (proj.sessions.has(sessionId)) return { ok: false, codes: [TOOL_PIN_DUPLICATE] };

  const rt = await loadRuntime();
  const res = rt.createSessionPins({
    sessionId,
    catalog: input.catalog,
    ...(overrides === undefined ? {} : { overrides }),
    at: Date.now(),
  });
  const codes = res.codes.slice();
  if (!codes.includes(CODE_CREATED)) return { ok: false, codes };

  const line: PinsCreateLine = {
    v: 1,
    type: "create",
    at: toIso(res.pins.createdAt),
    sessionId,
    catalog: input.catalog,
    ...(overrides === undefined ? {} : { overrides }),
    versions: { ...res.pins.versions },
    status: "open",
  };
  if (!appendPinsLine(base, line)) return storeError();
  return { ok: true, codes, pins: res.pins };
}

/** 读一个会话的钉扎清单(含 upgrades);不存在 → TOOL_PIN_NOT_FOUND。 */
export function getPins(root: string, sessionId: string): GetPinsResult {
  const base = assertRoot(root);
  const target = assertSessionId(sessionId);
  const proj = loadPins(base);
  if (proj.ioError) return { codes: [TOOL_PIN_STORE_ERROR], parseErrors: 0, badLines: [] };
  const pins = proj.sessions.get(target);
  if (pins === undefined) return { codes: [TOOL_PIN_NOT_FOUND], parseErrors: proj.parseErrors, badLines: proj.badLines };
  return {
    pins: { ...pins, versions: { ...pins.versions }, upgrades: pins.upgrades.map((item) => ({ ...item })) },
    codes: [],
    parseErrors: proj.parseErrors,
    badLines: proj.badLines,
  };
}

/** 关闭会话:已 closed → TOOL_PIN_INVALID 且不重复写行(close 是状态迁移,不是计数器)。 */
export function closeSession(root: string, sessionId: string): CloseSessionResult {
  const base = assertRoot(root);
  const target = assertSessionId(sessionId);
  const proj = loadPins(base);
  if (proj.ioError) return storeError();
  const pins = proj.sessions.get(target);
  if (pins === undefined) return { ok: false, codes: [TOOL_PIN_NOT_FOUND] };
  if (pins.status === "closed") return { ok: false, codes: [CODE_INVALID] };

  const line: PinsCloseLine = { v: 1, type: "close", at: toIso(Date.now()), sessionId: target };
  if (!appendPinsLine(base, line)) return storeError();
  return { ok: true, codes: [] };
}

/**
 * 记一次调用:版本由 runtime 按钉扎现算(落盘行带 version),closed 会话直接拒。
 * callId 按会话判重(同一 callId 在别的会话里合法)。
 */
export async function recordCall(root: string, input: RecordCallStoreInput): Promise<RecordCallStoreResult> {
  const base = assertRoot(root);
  const sessionId = assertSessionId(input?.sessionId);
  if (!isFilled(input?.callId) || !isFilled(input?.tool)) return { ok: false, codes: [CODE_INVALID] };
  if (input.args !== undefined && !isRecord(input.args)) return { ok: false, codes: [CODE_INVALID] };

  const proj = loadPins(base);
  if (proj.ioError) return storeError();
  const pins = proj.sessions.get(sessionId);
  if (pins === undefined) return { ok: false, codes: [TOOL_PIN_NOT_FOUND] };
  if (proj.calls.some((item) => item.sessionId === sessionId && item.callId === input.callId)) {
    return { ok: false, codes: [TOOL_PIN_DUPLICATE] };
  }

  const rt = await loadRuntime();
  const res = rt.recordCall(pins, {
    callId: input.callId,
    tool: input.tool,
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.traceBatchKey === undefined ? {} : { traceBatchKey: input.traceBatchKey }),
    at: Date.now(),
  });
  if (res.call === undefined) return { ok: false, codes: res.codes.length > 0 ? res.codes : [CODE_INVALID] };

  const call = res.call;
  const line: PinsCallLine = {
    v: 1,
    type: "call",
    at: toIso(call.at),
    sessionId,
    callId: call.callId,
    tool: call.tool,
    version: call.version,
    args: { ...call.args },
    ...(call.traceBatchKey === undefined ? {} : { traceBatchKey: call.traceBatchKey }),
  };
  if (!appendPinsLine(base, line)) return storeError();
  return { ok: true, codes: res.codes, call };
}

/** 会话内升级:未确认 → CONFIRM_REQUIRED 且不写行;成功写 upgrade 行(带 from/to/by)。 */
export async function applyUpgrade(root: string, input: ApplyUpgradeStoreInput): Promise<ApplyUpgradeStoreResult> {
  const base = assertRoot(root);
  const sessionId = assertSessionId(input?.sessionId);
  if (!isFilled(input?.tool) || !isFilled(input?.to) || !isFilled(input?.by)) {
    return { ok: false, codes: [CODE_INVALID] };
  }

  const proj = loadPins(base);
  if (proj.ioError) return storeError();
  const pins = proj.sessions.get(sessionId);
  if (pins === undefined) return { ok: false, codes: [TOOL_PIN_NOT_FOUND] };

  const from = pins.versions[input.tool];
  const rt = await loadRuntime();
  const res = rt.applyUpgrade(pins, {
    tool: input.tool,
    to: input.to,
    by: input.by,
    confirmed: input.confirmed === true,
    at: Date.now(),
  });
  const codes = res.codes.slice();
  if (!codes.includes(CODE_UPGRADED)) return { ok: false, codes, pins: res.pins };
  if (!isFilled(from)) return { ok: false, codes: [CODE_UNKNOWN_TOOL], pins: res.pins };

  const line: PinsUpgradeLine = {
    v: 1,
    type: "upgrade",
    at: toIso(Date.now()),
    sessionId,
    tool: input.tool,
    from,
    to: input.to,
    by: input.by,
    confirmed: true,
  };
  if (!appendPinsLine(base, line)) return storeError();
  return { ok: true, codes, pins: res.pins };
}

/** 历史回放:catalog 一律用入参(不回退落盘快照),取不到该版本 schema 就显式 SCHEMA_MISSING。 */
export async function replayCall(root: string, input: ReplayCallStoreInput): Promise<ReplayCallStoreResult> {
  const base = assertRoot(root);
  const sessionId = assertSessionId(input?.sessionId);
  if (!isFilled(input?.callId)) return { codes: [CODE_INVALID] };
  if (!isRecord(input.catalog)) return { codes: [CODE_INVALID] };

  const proj = loadPins(base);
  if (proj.ioError) return { codes: [TOOL_PIN_STORE_ERROR] };
  const call = proj.calls.find((item) => item.sessionId === sessionId && item.callId === input.callId);
  if (call === undefined) return { codes: [TOOL_PIN_NOT_FOUND] };

  const rt = await loadRuntime();
  return rt.replayCall(call, input.catalog);
}

/** 调用列表(可按会话过滤);坏行只计数不清空。 */
export function listCalls(root: string, input?: ListCallsInput): ListCallsResult {
  const base = assertRoot(root);
  const filter = input?.sessionId === undefined ? undefined : assertSessionId(input.sessionId);
  const proj = loadPins(base);
  const calls = filter === undefined ? proj.calls : proj.calls.filter((item) => item.sessionId === filter);
  return {
    calls: calls.map((item) => ({ ...item, args: { ...item.args } })),
    parseErrors: proj.parseErrors,
    badLines: proj.badLines.slice(),
  };
}

/** 台账全景:谁还开着、谁关了、每个版本被调了多少次、升级史。 */
export function reportPins(root: string): ReportPinsResult {
  const base = assertRoot(root);
  const proj = loadPins(base);
  const open: string[] = [];
  const closed: string[] = [];
  const sessions: PinsSessionEntry[] = [];
  const callsByVersion: Record<string, number> = {};

  for (const session of proj.sessions.values()) {
    if (session.status === "open") open.push(session.sessionId);
    else closed.push(session.sessionId);
    sessions.push({ sessionId: session.sessionId, status: session.status, versions: { ...session.versions } });
  }
  for (const call of proj.calls) {
    const key = `${call.tool}@${call.version}`;
    callsByVersion[key] = (callsByVersion[key] ?? 0) + 1;
  }
  return {
    path: toolPinsPath(base),
    open,
    closed,
    callsByVersion,
    upgrades: proj.upgrades.map((item) => ({ ...item })),
    sessions,
    parseErrors: proj.parseErrors,
    badLines: proj.badLines.slice(),
    totalLines: proj.totalLines,
  };
}

/** 供 CLI/上层复用的会话计数(自动 callId 用):只数该会话已有调用行。 */
export function countSessionCalls(root: string, sessionId: string): number {
  const base = assertRoot(root);
  const target = assertSessionId(sessionId);
  return loadPins(base).calls.filter((item) => item.sessionId === target).length;
}

/** 协议码在 store 出口的统一引用(避免调用方各写一份字面量)。 */
export const TOOL_PIN_STORE_PROTOCOL_CODES = {
  invalid: CODE_INVALID,
  created: CODE_CREATED,
  unknownTool: CODE_UNKNOWN_TOOL,
  sessionLocked: CODE_SESSION_LOCKED,
  upgraded: CODE_UPGRADED,
} as const;
