/**
 * 测试夹具录制/回放(#110,纯逻辑零 IO)。
 * 为什么需要夹具:端到端测试一旦打到真实模型/HTTP,CI 就变成「看今天上游心情」——同样的代码
 * 今天绿明天红,失败现场也复现不出来。夹具把一次真实交互(请求 + 响应)录成文件,CI 只回放,
 * 于是「同一份夹具 + 同一段代码 = 同一个结论」。本模块只做纯逻辑:顺序匹配、录制、关闭、
 * 密钥扫描、模式决议;落盘在 gateway 的 fixture-store,命令行在 scripts/fixture-replay.mts。
 * 设计取舍(每条都对应一个真实注意):
 * - **严格按请求顺序匹配**:夹具是「一次会话的轨迹」,不是「请求池」。允许跳序/乱序匹配,
 *   调用顺序变了夹具照样过,回放就掩盖了「测试实际发了别的请求」这类回归,故只认 cursor 那一条。
 * - **录制也只能按 expected 顺序 append**:录制是「把真实响应填进这张表」,不是自由追加;
 *   顺序不对立刻 FIXTURE_MISMATCH,避免录出一份与测试意图不一致的夹具。
 * - **closeScope 要求 used==total**:少发一次请求也算夹具不完整——「测试没跑到最后一跳」
 *   往往正是回归现场(例如提前 return),静默关闭会让它变成假绿。
 * - **CI 缺夹具 = replay 且失败(FIXTURE_REPLAY_MISSING),绝不回退 record**:回退录制会让
 *   CI 自己生成夹具并通过,把「夹具缺失」永久藏起来。显式 passthrough 才允许打真实上游。
 * - **密钥扫描先于落盘**:sk-/Bearer/长高熵串/credential-like env 值字面量命中即拒写;
 *   调用方必须保留旧文件(本模块只报码,不碰文件),命中提示里的预览一律打码。
 * - 不发明哈希:bodyHash 由调用方给;bodyHashOf 只提供确定性的变更检测指纹(FNV-1a),
 *   不是密码学哈希,文档里写清楚。
 * 依赖纪律:零 import(不碰 fs/net/path/node:*),不读时钟;时间一律由调用方传数字时间戳
 * (非法按 0);全部函数纯函数:不 throw、不改入参、返回深拷贝。
 */

/** 夹具契约版本:字段语义变化时递增,读取方据此迁移。 */
export const FIXTURE_VERSION = 1;

/** 回放模式:replay=只读夹具;record=录制;passthrough=显式放行打真实上游。 */
export type FixtureMode = "replay" | "record" | "passthrough";

/** 稳定码(调用方与 CLI 的公开契约,禁止改字面量)。 */
export type FixtureCode =
  | "FIXTURE_INVALID"
  | "FIXTURE_MATCHED"
  | "FIXTURE_MISMATCH"
  | "FIXTURE_RECORDED"
  | "FIXTURE_INCOMPLETE"
  | "FIXTURE_CLOSED"
  | "FIXTURE_SECRET_DETECTED"
  | "FIXTURE_REPLAY_MISSING"
  | "FIXTURE_PASSTHROUGH"
  // 补充码(不改变上面九个必需码的语义,只是把「中性成功」也显式化)
  | "FIXTURE_OPENED"
  | "FIXTURE_CLEAN"
  | "FIXTURE_REPLAY_READY"
  | "FIXTURE_RECORD_READY";

/** 任务书要求的九个必需码(测试与 CLI 都断言这一组恒在)。 */
export const FIXTURE_REQUIRED_CODES = [
  "FIXTURE_INVALID",
  "FIXTURE_MATCHED",
  "FIXTURE_MISMATCH",
  "FIXTURE_RECORDED",
  "FIXTURE_INCOMPLETE",
  "FIXTURE_CLOSED",
  "FIXTURE_SECRET_DETECTED",
  "FIXTURE_REPLAY_MISSING",
  "FIXTURE_PASSTHROUGH",
] as const;

/** 全部码表(只读数组,上游可整体遍历/断言)。 */
export const FIXTURE_CODES = [
  ...FIXTURE_REQUIRED_CODES,
  "FIXTURE_OPENED",
  "FIXTURE_CLEAN",
  "FIXTURE_REPLAY_READY",
  "FIXTURE_RECORD_READY",
] as const;

/** 一条期望请求:id 用于人读定位,method/url 必填,bodyHash 给了就必须逐字相等。 */
export interface ExpectedRequest {
  id: string;
  method: string;
  url: string;
  bodyHash?: string;
  headers?: Record<string, string>;
}

/** 一条录制:请求原样留档 + 响应 + 录制时间(毫秒)。 */
export interface FixtureEntry {
  request: ExpectedRequest;
  response: unknown;
  at: number;
}

/** 一个 scope = 一次测试/一次会话的夹具;cursor = 已消费(已录制/已回放)的条数。 */
export interface FixtureScope {
  name: string;
  expected: ExpectedRequest[];
  entries: FixtureEntry[];
  cursor: number;
  status: "open" | "closed";
}

/** 密钥扫描命中:preview 一律打码,绝不回显完整凭据。 */
export interface SecretHit {
  kind: "sk-token" | "bearer" | "high-entropy" | "env-value";
  preview: string;
  at: number;
}

export interface SecretScanResult {
  code: "FIXTURE_SECRET_DETECTED" | "FIXTURE_CLEAN" | "FIXTURE_INVALID";
  hits: SecretHit[];
  detail?: string;
}

export interface MatchResult {
  code: "FIXTURE_MATCHED" | "FIXTURE_MISMATCH" | "FIXTURE_INVALID";
  index: number;
  expected?: ExpectedRequest;
  reason?: string;
}

export interface RecordResult {
  code: "FIXTURE_RECORDED" | "FIXTURE_MISMATCH" | "FIXTURE_CLOSED" | "FIXTURE_INVALID";
  scope: FixtureScope;
  index: number;
  expected?: ExpectedRequest;
  reason?: string;
}

export interface CloseResult {
  code: "FIXTURE_CLOSED" | "FIXTURE_INCOMPLETE" | "FIXTURE_INVALID";
  scope: FixtureScope;
  used: number;
  total: number;
  missing: number;
  reason?: string;
}

export interface ModeResult {
  mode: FixtureMode;
  code: "FIXTURE_REPLAY_READY" | "FIXTURE_RECORD_READY" | "FIXTURE_REPLAY_MISSING" | "FIXTURE_PASSTHROUGH";
  ci: boolean;
  fixtureExists: boolean;
  missing: boolean;
  reason: string;
}

export interface ScopeSummary {
  name: string;
  used: number;
  total: number;
  remaining: number;
  status: "open" | "closed";
  complete: boolean;
}

export interface NormalizedScope {
  code: "FIXTURE_MATCHED" | "FIXTURE_INVALID";
  scope?: FixtureScope;
  errors: string[];
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** JSON 深拷贝(夹具全是 JSON 数据;不可序列化时原样返回,交由调用方报 INVALID)。 */
function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function normalizeMethod(method: unknown): string {
  return typeof method === "string" ? method.trim().toUpperCase() : "";
}

function isExpectedRequest(v: unknown): v is ExpectedRequest {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return isNonEmptyString(r.id) && isNonEmptyString(r.method) && isNonEmptyString(r.url);
}

/** 稳定 JSON:对象键排序,使同一对象不同键序得到同一指纹。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 请求体指纹(确定性变更检测用,非密码学哈希):同一对象不同键序得同一值;
 * 输出 `fnv1a64:<16 位十六进制>`。调用方把它写进 ExpectedRequest.bodyHash。
 */
export function bodyHashOf(body: unknown): string {
  const text = stableStringify(body);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return `fnv1a64:${hex(h1)}${hex(h2)}`;
}

/* ------------------------------------------------------------------ *
 * scope 生命周期
 * ------------------------------------------------------------------ */

/** 建一个空 scope(纯函数)。非法 name/expected 返回 code=FIXTURE_INVALID 与空 scope。 */
export function createScope(name: unknown, expected: unknown): { code: "FIXTURE_OPENED" | "FIXTURE_INVALID"; scope: FixtureScope; errors: string[] } {
  const errors: string[] = [];
  const safeName = isNonEmptyString(name) ? name.trim() : "";
  if (!safeName) errors.push("name 必须是非空字符串");
  const list: ExpectedRequest[] = [];
  if (!Array.isArray(expected)) {
    errors.push("expected 必须是数组");
  } else {
    expected.forEach((item, i) => {
      if (!isExpectedRequest(item)) {
        errors.push(`expected[${i}] 缺 id/method/url`);
        return;
      }
      if (list.some((e) => e.id === item.id)) errors.push(`expected[${i}] id 重复:${item.id}`);
      list.push(cloneJson(item));
    });
  }
  const scope: FixtureScope = { name: safeName, expected: list, entries: [], cursor: 0, status: "open" };
  return { code: errors.length > 0 ? "FIXTURE_INVALID" : "FIXTURE_OPENED", scope, errors };
}

/** 深拷贝一份 scope(调用方要保存/回填时用,避免共享可变结构)。 */
export function cloneScope(scope: FixtureScope): FixtureScope {
  return cloneJson(scope);
}

/** 下一个未被消费的 expected;没有则 undefined。 */
export function nextExpected(scope: FixtureScope): ExpectedRequest | undefined {
  return scope.expected[scope.cursor];
}

/**
 * 严格顺序匹配:只拿 expected[cursor] 与请求比对——不跳序、不乱序、不轮询后续 expected。
 * expected.bodyHash 给了就必须相等(请求未给也算不匹配);没给则只比 method/url。
 * 注意:closed 的 scope **照样可匹配**——录制完关闭的夹具正是 CI 回放的对象,
 * 「关闭后不许录」由 recordEntry 拦截,不该在匹配这一层误伤回放。
 */
export function matchNext(scope: FixtureScope, request: ExpectedRequest): MatchResult {
  if (!scope || typeof scope !== "object") return { code: "FIXTURE_INVALID", index: -1, reason: "scope 非法" };
  const expected = scope.expected[scope.cursor];
  if (expected === undefined) {
    return { code: "FIXTURE_MISMATCH", index: scope.cursor, reason: "expected-exhausted" };
  }
  if (!isExpectedRequest(request)) {
    return { code: "FIXTURE_INVALID", index: scope.cursor, reason: "request 缺 id/method/url", expected: cloneJson(expected) };
  }
  if (normalizeMethod(request.method) !== normalizeMethod(expected.method)) {
    return { code: "FIXTURE_MISMATCH", index: scope.cursor, expected: cloneJson(expected), reason: `method 不匹配:期望 ${expected.method},收到 ${request.method}` };
  }
  if (request.url !== expected.url) {
    return { code: "FIXTURE_MISMATCH", index: scope.cursor, expected: cloneJson(expected), reason: `url 不匹配:期望 ${expected.url},收到 ${request.url}` };
  }
  if (expected.bodyHash !== undefined && request.bodyHash !== expected.bodyHash) {
    return { code: "FIXTURE_MISMATCH", index: scope.cursor, expected: cloneJson(expected), reason: "bodyHash 不匹配" };
  }
  return { code: "FIXTURE_MATCHED", index: scope.cursor, expected: cloneJson(expected) };
}

/**
 * 按 expected 顺序追加一条录制(纯函数:返回新 scope,不改进参)。
 * - 顺序不符 → FIXTURE_MISMATCH(不推进 cursor);
 * - scope 已关闭 → FIXTURE_CLOSED;
 * - response 为 undefined → FIXTURE_INVALID(落盘会变成字段缺失,回放时不可区分);
 * - at 非有限数字 → 记 0(与仓库其它纯模块同口径,不读时钟)。
 */
export function recordEntry(scope: FixtureScope, entry: { request: ExpectedRequest; response: unknown; at?: number }): RecordResult {
  const snapshot = cloneScope(scope);
  if (scope.status === "closed") return { code: "FIXTURE_CLOSED", scope: snapshot, index: scope.cursor, reason: "scope-closed" };
  if (entry === null || typeof entry !== "object") {
    return { code: "FIXTURE_INVALID", scope: snapshot, index: scope.cursor, reason: "entry 非法" };
  }
  const matched = matchNext(scope, entry.request);
  if (matched.code !== "FIXTURE_MATCHED") {
    if (matched.code === "FIXTURE_INVALID") {
      return { code: "FIXTURE_INVALID", scope: snapshot, index: matched.index, expected: matched.expected, reason: matched.reason };
    }
    return { code: "FIXTURE_MISMATCH", scope: snapshot, index: matched.index, expected: matched.expected, reason: matched.reason };
  }
  if (entry.response === undefined) {
    return { code: "FIXTURE_INVALID", scope: snapshot, index: scope.cursor, expected: matched.expected, reason: "response 不能是 undefined" };
  }
  const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? Math.trunc(entry.at) : 0;
  const next = cloneScope(scope);
  next.entries.push({ request: cloneJson(matched.expected as ExpectedRequest), response: cloneJson(entry.response), at });
  next.cursor = next.entries.length;
  return { code: "FIXTURE_RECORDED", scope: next, index: next.cursor - 1, expected: matched.expected };
}

/** used==total 才真正关闭;否则 FIXTURE_INCOMPLETE(scope 保持 open 不变)。 */
export function closeScope(scope: FixtureScope): CloseResult {
  const used = scope.cursor;
  const total = scope.expected.length;
  const snapshot = cloneScope(scope);
  if (scope.status === "closed") {
    return { code: "FIXTURE_INCOMPLETE", scope: snapshot, used, total, missing: 0, reason: "already-closed" };
  }
  if (used !== total) {
    return { code: "FIXTURE_INCOMPLETE", scope: snapshot, used, total, missing: Math.max(0, total - used), reason: `未完成:used=${used} total=${total}` };
  }
  const next = cloneScope(scope);
  next.status = "closed";
  return { code: "FIXTURE_CLOSED", scope: next, used, total, missing: 0 };
}

/** 人读摘要(CLI --report 与日志用)。 */
export function summarizeScope(scope: FixtureScope): ScopeSummary {
  const total = scope.expected.length;
  const used = Math.min(scope.cursor, total);
  return {
    name: scope.name,
    used,
    total,
    remaining: Math.max(0, total - used),
    status: scope.status,
    complete: scope.status === "closed" && used === total,
  };
}

function matchPair(expected: ExpectedRequest, actual: ExpectedRequest): string | undefined {
  if (normalizeMethod(expected.method) !== normalizeMethod(actual.method)) return "method 不同";
  if (expected.url !== actual.url) return "url 不同";
  if (expected.bodyHash !== undefined && actual.bodyHash !== expected.bodyHash) return "bodyHash 不同";
  return undefined;
}

/**
 * 校验并归一化一份「可能来自磁盘」的 scope(未知输入):
 * - v 允许缺省或 1;expected/entries 必须是数组且逐条合法;
 * - cursor 越界时钳到 [0, expected.length]:**不能**拿 entries.length 当下限——回放时 entries
 *   是已录数据、cursor 是消费指针,夹具一载入 cursor 就该是 0(拿 entries 数当下限会让回放
 *   一上来就 expected-exhausted);
 * - entries 多于 expected、或条目顺序与 expected 冲突 → FIXTURE_INVALID。
 */
export function normalizeScope(raw: unknown, fallbackName = ""): NormalizedScope {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object") return { code: "FIXTURE_INVALID", errors: ["scope 必须是对象"] };
  const r = raw as Record<string, unknown>;
  if (r.v !== undefined && r.v !== FIXTURE_VERSION) errors.push(`v 不支持:${String(r.v)}`);
  const created = createScope(isNonEmptyString(r.name) ? r.name : fallbackName, r.expected);
  errors.push(...created.errors);
  const scope = created.scope;
  const entriesRaw = r.entries;
  if (entriesRaw !== undefined && !Array.isArray(entriesRaw)) {
    errors.push("entries 必须是数组");
  } else if (Array.isArray(entriesRaw)) {
    entriesRaw.forEach((item, i) => {
      if (item === null || typeof item !== "object") {
        errors.push(`entries[${i}] 必须是对象`);
        return;
      }
      const e = item as Record<string, unknown>;
      if (!isExpectedRequest(e.request)) {
        errors.push(`entries[${i}].request 缺 id/method/url`);
        return;
      }
      if (e.response === undefined) errors.push(`entries[${i}].response 缺失`);
      const expected = scope.expected[i];
      if (expected === undefined) {
        errors.push(`entries[${i}] 超出 expected 长度`);
        return;
      }
      const mismatch = matchPair(expected, e.request);
      if (mismatch !== undefined) errors.push(`entries[${i}] 与 expected[${i}] 不一致:${mismatch}`);
      const at = typeof e.at === "number" && Number.isFinite(e.at) ? Math.trunc(e.at) : 0;
      scope.entries.push({ request: cloneJson(e.request), response: cloneJson(e.response), at });
    });
  }
  const rawCursor = typeof r.cursor === "number" && Number.isFinite(r.cursor) ? Math.trunc(r.cursor) : scope.entries.length;
  scope.cursor = Math.min(Math.max(rawCursor, 0), scope.expected.length);
  if (r.status === "closed") scope.status = "closed";
  else if (r.status !== undefined && r.status !== "open") errors.push(`status 非法:${String(r.status)}`);
  if (errors.length > 0) return { code: "FIXTURE_INVALID", scope, errors };
  return { code: "FIXTURE_MATCHED", scope, errors };
}

/* ------------------------------------------------------------------ *
 * 密钥扫描
 * ------------------------------------------------------------------ */

const SK_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9+/=_-]{32,}\b/g;

function mask(value: string): string {
  return `${value.slice(0, 4)}***(${value.length})`;
}

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** 高熵判定:≥32 字符、含数字与字母、熵 ≥ 4.0 —— 用于抓随机 token/base64 密钥。 */
function looksHighEntropy(text: string): boolean {
  if (text.length < 32) return false;
  if (!/[0-9]/.test(text) || !/[A-Za-z]/.test(text)) return false;
  return shannonEntropy(text) >= 4;
}

/**
 * 扫描待录制文本里的凭据:sk- token、Bearer、长高熵串、以及调用方给出的 env 值字面量。
 * envValues 建议传「credential-like 名的环境变量值」(如 *KEY/*TOKEN/*SECRET/*PASSWORD);
 * 长度 < 8 的值不参与扫描(过短会误命中普通文本)。命中即 FIXTURE_SECRET_DETECTED,调用方不得覆盖旧文件。
 */
export function scanForSecrets(text: unknown, opts: { envValues?: unknown } = {}): SecretScanResult {
  if (typeof text !== "string") return { code: "FIXTURE_INVALID", hits: [], detail: "text 必须是字符串" };
  const hits: SecretHit[] = [];
  const push = (kind: SecretHit["kind"], raw: string, at: number): void => {
    if (hits.length >= 20) return;
    if (hits.some((h) => h.kind === kind && h.at === at)) return;
    hits.push({ kind, preview: mask(raw), at });
  };
  for (const m of text.matchAll(SK_PATTERN)) push("sk-token", m[0], m.index ?? 0);
  for (const m of text.matchAll(BEARER_PATTERN)) push("bearer", m[0], m.index ?? 0);
  for (const m of text.matchAll(HIGH_ENTROPY_PATTERN)) {
    if (looksHighEntropy(m[0])) push("high-entropy", m[0], m.index ?? 0);
  }
  const envValues = Array.isArray(opts.envValues) ? opts.envValues : [];
  for (const value of envValues) {
    if (typeof value !== "string" || value.length < 8) continue;
    const at = text.indexOf(value);
    if (at >= 0) push("env-value", value, at);
  }
  hits.sort((a, b) => a.at - b.at);
  return { code: hits.length > 0 ? "FIXTURE_SECRET_DETECTED" : "FIXTURE_CLEAN", hits };
}

/**
 * 把 credential-like 名的环境变量挑出来喂给 scanForSecrets(纯函数,调用方传 process.env):
 * 名字匹配 KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL(不区分大小写),值长度 ≥ 8。
 */
export function credentialEnvValues(env: Record<string, string | undefined> | undefined): string[] {
  if (!env || typeof env !== "object") return [];
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(name)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 模式决议
 * ------------------------------------------------------------------ */

function isCi(envMode: unknown): boolean {
  if (typeof envMode !== "string") return false;
  return /^(ci|true|1|yes|on)$/i.test(envMode.trim());
}

/**
 * 模式决议(纯函数,不读 process.env;调用方把 CI 变量值传进来):
 * 1. passthrough=true → passthrough(唯一打真实上游的通道,必须显式);
 * 2. 夹具存在 → replay;
 * 3. CI 且夹具缺失 → 仍返回 replay + missing=true(FIXTURE_REPLAY_MISSING,失败而不回退 record);
 * 4. 否则 record(本地首次跑,录制)。
 */
export function modeOf(input: { fixtureExists?: unknown; passthrough?: unknown; envMode?: unknown } = {}): ModeResult {
  const fixtureExists = input.fixtureExists === true;
  const ci = isCi(input.envMode);
  if (input.passthrough === true) {
    return { mode: "passthrough", code: "FIXTURE_PASSTHROUGH", ci, fixtureExists, missing: false, reason: "explicit-passthrough" };
  }
  if (fixtureExists) {
    return { mode: "replay", code: "FIXTURE_REPLAY_READY", ci, fixtureExists, missing: false, reason: "fixture-exists" };
  }
  if (ci) {
    return { mode: "replay", code: "FIXTURE_REPLAY_MISSING", ci, fixtureExists, missing: true, reason: "ci-fixture-missing" };
  }
  return { mode: "record", code: "FIXTURE_RECORD_READY", ci, fixtureExists, missing: false, reason: "local-first-run" };
}
