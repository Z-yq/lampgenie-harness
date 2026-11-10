/**
 * 夹具录制/回放的落盘层(#110 生产侧):把 fixture-replay 的纯逻辑接到
 * `<root>/.genie/fixtures/<name>.json`,让「这个 scope 期望哪几个请求、录到了第几条、
 * 关没关、是不是 CI 缺夹具」成为可复核的事实。
 * 文件形状(v=1):
 *   { v, name, mode:"record"|"replay", expected[], entries[], cursor, status, createdAt, updatedAt }
 * - `mode` 是**打开时的决议结果**,只作留痕:回放/录制时一律重新按 modeOf 判(否则夹具从
 *   record 转 replay 后旧文件会自称 record,读的人会误判);
 * - `cursor` 落盘,使得 CLI 每次进程启动后仍能接着上一条继续——不做内存缓存,磁盘是唯一真源。
 * 原子 append:写临时文件(同目录,避免跨设备 rename)+ rename 覆盖。这样「写到一半进程被杀」
 * 不会留下半截 JSON:要么是旧文件,要么是新文件。写入前先 scanForSecrets:
 * 命中即**不写盘**,内存与旧文件都保持原样(调用方据 FIXTURE_SECRET_DETECTED 拒绝覆盖)。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑(两跳惰性解析:先包 spec,vitest 的
 * `--conditions=development` 走 src 入口;`node --experimental-strip-types` 直接跑 CLI 时
 * spec 解析不到 dist,回退仓内相对 src URL,与 tool-pins-store 同口径)。
 * 除参数错误(root/name/expected 形态不对 → TypeError,与 experiment-store 同口径)外不 throw:
 * IO 失败一律折叠成 FIXTURE_STORE_ERROR。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CloseResult,
  ExpectedRequest,
  FixtureEntry,
  FixtureMode,
  FixtureScope,
  RecordResult,
  ScopeSummary,
  SecretHit,
} from "@lampgenie/runtime/agent/fixture-replay";

/** store 层自产码(其余沿用 runtime 的 FIXTURE_*)。 */
export const FIXTURE_STORE_ERROR = "FIXTURE_STORE_ERROR";
export const FIXTURE_NOT_FOUND = "FIXTURE_NOT_FOUND";
export const FIXTURE_REPORT = "FIXTURE_REPORT";

/** store 自产码表(只读数组,上游可整体遍历/断言)。 */
export const FIXTURE_STORE_CODES = [FIXTURE_STORE_ERROR, FIXTURE_NOT_FOUND, FIXTURE_REPORT] as const;

/** 落盘快照里额外带的元信息(不参与匹配,只为人读)。 */
export interface FixtureFile {
  v: 1;
  name: string;
  mode: "record" | "replay";
  expected: ExpectedRequest[];
  entries: FixtureEntry[];
  cursor: number;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
}

export interface FixtureStoreResult {
  code: string;
  path?: string;
  mode?: FixtureMode;
  scope?: FixtureScope;
  summary?: ScopeSummary;
  reports?: ScopeSummary[];
  response?: unknown;
  index?: number;
  expected?: ExpectedRequest;
  hits?: SecretHit[];
  errors?: string[];
  reason?: string;
  /** replay 打开时:调用方给的 expected 与文件里的不一致(不改文件,只告警)。 */
  expectedDrift?: boolean;
  /** CI 缺夹具:调用方必须当失败处理,不允许回退录制。 */
  missing?: boolean;
  /** record 被密钥扫描拒绝时为 false(旧文件一个字节都没动)。 */
  written?: boolean;
  removed?: boolean;
}

/* ------------------------------------------------------------------ *
 * runtime 惰性解析
 * ------------------------------------------------------------------ */

interface FixtureRuntime {
  FIXTURE_VERSION: number;
  createScope(name: unknown, expected: unknown): { code: "FIXTURE_OPENED" | "FIXTURE_INVALID"; scope: FixtureScope; errors: string[] };
  cloneScope(scope: FixtureScope): FixtureScope;
  matchNext(scope: FixtureScope, request: ExpectedRequest): { code: string; index: number; expected?: ExpectedRequest; reason?: string };
  recordEntry(scope: FixtureScope, entry: { request: ExpectedRequest; response: unknown; at?: number }): RecordResult;
  closeScope(scope: FixtureScope): CloseResult;
  normalizeScope(raw: unknown, fallbackName?: string): { code: string; scope?: FixtureScope; errors: string[] };
  scanForSecrets(text: unknown, opts?: { envValues?: unknown }): { code: string; hits: SecretHit[]; detail?: string };
  modeOf(input: { fixtureExists?: unknown; passthrough?: unknown; envMode?: unknown }): {
    mode: FixtureMode;
    code: string;
    ci: boolean;
    fixtureExists: boolean;
    missing: boolean;
    reason: string;
  };
  summarizeScope(scope: FixtureScope): ScopeSummary;
}

let fixtureRuntime: FixtureRuntime | undefined;

async function loadRuntime<T>(specifier: string, fallbackPath: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    const url = new URL(fallbackPath, import.meta.url).href;
    return (await import(url)) as T;
  }
}

async function runtime(): Promise<FixtureRuntime> {
  if (fixtureRuntime !== undefined) return fixtureRuntime;
  fixtureRuntime = await loadRuntime<FixtureRuntime>(
    "@lampgenie/runtime/agent/fixture-replay",
    "../../../packages/harness-runtime/src/agent/fixture-replay.ts",
  );
  return fixtureRuntime;
}

/* ------------------------------------------------------------------ *
 * 参数与路径
 * ------------------------------------------------------------------ */

function ensureRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError("fixture-store: root 必须是非空字符串");
  return root.trim();
}

function ensureName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") throw new TypeError("fixture-store: scope name 必须是非空字符串");
  const trimmed = name.trim();
  if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new TypeError(`fixture-store: scope name 不能是路径(收到 ${trimmed})`);
  }
  return trimmed;
}

/** 夹具目录。 */
export function fixturesDir(root: string): string {
  return join(ensureRoot(root), ".genie", "fixtures");
}

/** 单个夹具文件路径。 */
export function fixturePath(root: string, name: string): string {
  return join(fixturesDir(root), `${ensureName(name)}.json`);
}

function isoNow(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

function toFile(scope: FixtureScope, mode: "record" | "replay", createdAt: string): FixtureFile {
  return {
    v: 1,
    name: scope.name,
    mode,
    expected: scope.expected,
    entries: scope.entries,
    cursor: scope.cursor,
    status: scope.status,
    createdAt,
    updatedAt: isoNow(),
  };
}

function readFileShape(path: string): { file?: FixtureFile; error?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { error: `读夹具失败:${(error as Error).message}` };
  }
  try {
    return { file: JSON.parse(text) as FixtureFile };
  } catch (error) {
    return { error: `夹具不是合法 JSON:${(error as Error).message}` };
  }
}

/** 原子写:同目录临时文件 → rename 覆盖。失败不会留下半截 JSON。 */
function writeAtomic(path: string, file: FixtureFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

/** 读并归一化夹具;不存在 → undefined。 */
export async function readFixture(root: string, name: string): Promise<{ scope?: FixtureScope; raw?: FixtureFile; path: string; error?: string; code: string }> {
  const rt = await runtime();
  const path = fixturePath(root, name);
  if (!existsSync(path)) return { path, code: FIXTURE_NOT_FOUND };
  const { file, error } = readFileShape(path);
  if (file === undefined) return { path, code: FIXTURE_STORE_ERROR, error };
  const normalized = rt.normalizeScope(file, name);
  if (normalized.code !== "FIXTURE_MATCHED" || normalized.scope === undefined) {
    return { path, code: "FIXTURE_INVALID", error: normalized.errors.join("; "), raw: file };
  }
  return { path, raw: file, scope: normalized.scope, code: "FIXTURE_MATCHED" };
}

function persistedAt(raw: FixtureFile | undefined): string {
  return typeof raw?.createdAt === "string" && raw.createdAt !== "" ? raw.createdAt : isoNow();
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

/**
 * 打开 scope:夹具存在 → replay 载入;缺失且非 CI → 建空 scope 落盘(record);
 * CI 缺失 → FIXTURE_REPLAY_MISSING(调用方当失败处理);passthrough 显式放行。
 * 传入 expected 只用于建 scope 与漂移检测(漂移只告警,绝不改文件)。
 */
export async function openScope(
  root: string,
  name: string,
  expected: ExpectedRequest[] = [],
  opts: { envMode?: string; passthrough?: boolean } = {},
): Promise<FixtureStoreResult> {
  const rt = await runtime();
  const path = fixturePath(root, name);
  const exists = existsSync(path);
  const modeRes = rt.modeOf({ fixtureExists: exists, passthrough: opts.passthrough === true, envMode: opts.envMode });
  if (modeRes.mode === "passthrough") {
    return { code: "FIXTURE_PASSTHROUGH", mode: "passthrough", path, reason: modeRes.reason };
  }
  if (exists) {
    const loaded = await readFixture(root, name);
    if (loaded.scope === undefined) {
      return { code: loaded.code === FIXTURE_NOT_FOUND ? "FIXTURE_REPLAY_MISSING" : loaded.code, path, mode: "replay", reason: loaded.error };
    }
    const drift = expectedDrift(expected, loaded.scope);
    // 打开一份已存在的夹具 = 开始本轮回放:消费指针清零(cursor 是「本轮跑到第几条」,
    // 不是持久事实;录制态的 cursor 由 entries 数在 load 时等价恢复)。
    const replayScope = rt.cloneScope(loaded.scope);
    replayScope.cursor = 0;
    replayScope.status = "open";
    try {
      writeAtomic(path, toFile(replayScope, "replay", persistedAt(loaded.raw)));
    } catch (error) {
      return { code: FIXTURE_STORE_ERROR, path, mode: "replay", reason: (error as Error).message };
    }
    return {
      code: "FIXTURE_OPENED",
      mode: "replay",
      path,
      scope: replayScope,
      summary: rt.summarizeScope(replayScope),
      ...(drift ? { expectedDrift: true } : {}),
    };
  }
  if (modeRes.missing) {
    return { code: "FIXTURE_REPLAY_MISSING", mode: "replay", path, missing: true, reason: modeRes.reason };
  }
  const created = rt.createScope(name, expected);
  if (created.code !== "FIXTURE_OPENED") {
    return { code: "FIXTURE_INVALID", path, mode: "record", errors: created.errors, reason: created.errors.join("; ") };
  }
  try {
    writeAtomic(path, toFile(created.scope, "record", isoNow()));
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path, mode: "record", reason: (error as Error).message };
  }
  return { code: "FIXTURE_OPENED", mode: "record", path, scope: created.scope, summary: rt.summarizeScope(created.scope) };
}

function expectedDrift(expected: ExpectedRequest[], scope: FixtureScope): boolean {
  if (expected.length !== scope.expected.length) return true;
  for (let i = 0; i < expected.length; i += 1) {
    const a = expected[i] as ExpectedRequest;
    const b = scope.expected[i] as ExpectedRequest;
    if (a.id !== b.id) return true;
    if (a.method.trim().toUpperCase() !== b.method.trim().toUpperCase()) return true;
    if (a.url !== b.url) return true;
    if ((a.bodyHash ?? "") !== (b.bodyHash ?? "")) return true;
  }
  return false;
}

/**
 * 回放一条请求:严格按 cursor 匹配,命中则返回已录制的响应并推进 cursor(落盘);
 * 乱序/内容不符 → FIXTURE_MISMATCH 且**不推进**(现场可重放);夹具缺失 → FIXTURE_REPLAY_MISSING。
 */
export async function replayNext(root: string, name: string, request: ExpectedRequest): Promise<FixtureStoreResult> {
  const rt = await runtime();
  const loaded = await readFixture(root, name);
  if (loaded.scope === undefined) {
    const code = loaded.code === FIXTURE_NOT_FOUND ? "FIXTURE_REPLAY_MISSING" : loaded.code;
    return { code, path: loaded.path, mode: "replay", reason: loaded.error };
  }
  const scope = loaded.scope;
  // 已关闭的夹具是最终态:直接回放等于「从第一条重跑」,不该因为上次录制把 cursor 走到尾就
  // 报 expected-exhausted。未关闭(录制中)则保留 cursor,继续按顺序追加/回放。
  if (scope.status === "closed" && scope.cursor >= scope.expected.length) scope.cursor = 0;
  const matched = rt.matchNext(scope, request);
  if (matched.code !== "FIXTURE_MATCHED") {
    return { code: matched.code, path: loaded.path, mode: "replay", index: matched.index, expected: matched.expected, reason: matched.reason };
  }
  const entry = scope.entries[matched.index];
  if (entry === undefined) {
    return { code: "FIXTURE_MISMATCH", path: loaded.path, mode: "replay", index: matched.index, expected: matched.expected, reason: "entry-missing" };
  }
  const next = rt.cloneScope(scope);
  next.cursor = matched.index + 1;
  try {
    writeAtomic(loaded.path, toFile(next, "replay", persistedAt(loaded.raw)));
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path: loaded.path, mode: "replay", reason: (error as Error).message };
  }
  return {
    code: "FIXTURE_MATCHED",
    path: loaded.path,
    mode: "replay",
    index: matched.index,
    response: entry.response,
    expected: matched.expected,
    scope: next,
    summary: rt.summarizeScope(next),
  };
}

/**
 * 录一条:先扫密钥(命中 → FIXTURE_SECRET_DETECTED,不写盘,旧文件保持原样),
 * 再按 expected 顺序 append(乱序 → FIXTURE_MISMATCH,不写盘),原子落盘后返回条数。
 */
export async function record(
  root: string,
  name: string,
  entry: { request: ExpectedRequest; response: unknown; at?: number },
  opts: { envValues?: string[] } = {},
): Promise<FixtureStoreResult> {
  const rt = await runtime();
  const loaded = await readFixture(root, name);
  if (loaded.scope === undefined) {
    return {
      code: "FIXTURE_INVALID",
      path: loaded.path,
      reason: loaded.code === FIXTURE_NOT_FOUND ? "scope-not-open:先 openScope" : loaded.error,
      mode: "record",
    };
  }
  if (entry === null || typeof entry !== "object" || entry.request === undefined) {
    return { code: "FIXTURE_INVALID", path: loaded.path, mode: "record", reason: "entry 缺 request" };
  }
  const scanText = [
    JSON.stringify(entry.response ?? null),
    JSON.stringify(entry.request.headers ?? {}),
    entry.request.url,
    entry.request.bodyHash ?? "",
  ].join("\n");
  const scan = rt.scanForSecrets(scanText, { envValues: opts.envValues ?? [] });
  if (scan.code === "FIXTURE_SECRET_DETECTED") {
    return { code: "FIXTURE_SECRET_DETECTED", path: loaded.path, mode: "record", hits: scan.hits, written: false, reason: "secret-detected" };
  }
  const recorded = rt.recordEntry(loaded.scope, entry);
  if (recorded.code !== "FIXTURE_RECORDED") {
    return { code: recorded.code, path: loaded.path, mode: "record", index: recorded.index, expected: recorded.expected, reason: recorded.reason, written: false };
  }
  try {
    writeAtomic(loaded.path, toFile(recorded.scope, "record", persistedAt(loaded.raw)));
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path: loaded.path, mode: "record", reason: (error as Error).message, written: false };
  }
  return {
    code: "FIXTURE_RECORDED",
    path: loaded.path,
    mode: "record",
    index: recorded.index,
    scope: recorded.scope,
    summary: rt.summarizeScope(recorded.scope),
    written: true,
  };
}

/** 关闭 scope:used==total 才落 status=closed,否则 FIXTURE_INCOMPLETE(文件不动)。 */
export async function close(root: string, name: string): Promise<FixtureStoreResult> {
  const rt = await runtime();
  const loaded = await readFixture(root, name);
  if (loaded.scope === undefined) {
    const code = loaded.code === FIXTURE_NOT_FOUND ? "FIXTURE_REPLAY_MISSING" : loaded.code;
    return { code, path: loaded.path, reason: loaded.error };
  }
  const closed = rt.closeScope(loaded.scope);
  if (closed.code !== "FIXTURE_CLOSED") {
    return {
      code: closed.code,
      path: loaded.path,
      scope: closed.scope,
      summary: rt.summarizeScope(closed.scope),
      reason: closed.reason,
    };
  }
  try {
    const mode: "record" | "replay" = loaded.raw?.mode === "record" ? "record" : "replay";
    writeAtomic(loaded.path, toFile(closed.scope, mode, persistedAt(loaded.raw)));
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path: loaded.path, reason: (error as Error).message };
  }
  return { code: "FIXTURE_CLOSED", path: loaded.path, scope: closed.scope, summary: rt.summarizeScope(closed.scope) };
}

/** 刷新 = 删文件(重录的最小实现:删除后下次 openScope 自然回到 record)。 */
export async function refresh(root: string, name: string): Promise<FixtureStoreResult> {
  const path = fixturePath(root, name);
  const existed = existsSync(path);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path, reason: (error as Error).message, removed: false };
  }
  return { code: "FIXTURE_REFRESHED", path, removed: existed };
}

/** 报告:给 name 报单个;不给则列目录里全部夹具(坏文件计入 errors 但不抛)。 */
export async function report(root: string, name?: string): Promise<FixtureStoreResult> {
  const rt = await runtime();
  if (name !== undefined) {
    const loaded = await readFixture(root, name);
    if (loaded.scope === undefined) {
      return { code: loaded.code === FIXTURE_NOT_FOUND ? FIXTURE_NOT_FOUND : loaded.code, path: loaded.path, reason: loaded.error };
    }
    return { code: FIXTURE_REPORT, path: loaded.path, mode: loaded.raw?.mode ?? "replay", summary: rt.summarizeScope(loaded.scope) };
  }
  const dir = fixturesDir(root);
  if (!existsSync(dir)) return { code: FIXTURE_REPORT, path: dir, reports: [] };
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    return { code: FIXTURE_STORE_ERROR, path: dir, reason: (error as Error).message };
  }
  const reports: ScopeSummary[] = [];
  const errors: string[] = [];
  for (const file of names) {
    const scopeName = file.slice(0, -".json".length);
    const loaded = await readFixture(root, scopeName);
    if (loaded.scope === undefined) {
      errors.push(`${scopeName}: ${loaded.code}${loaded.error ? ` ${loaded.error}` : ""}`);
      continue;
    }
    reports.push(rt.summarizeScope(loaded.scope));
  }
  return { code: FIXTURE_REPORT, path: dir, reports, ...(errors.length > 0 ? { errors } : {}) };
}
