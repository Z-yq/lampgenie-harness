/**
 * 工具热升级台账持久层(生产侧,工具热升级协议 2026-11):把 tool-upgrade-protocol 的纯逻辑
 * 落到 append-only jsonl,让「哪个工具现在跑哪个版本、为什么升、回滚过几次」成为可复核的事实。
 * 数据面:`<root>/.genie/rsi/tool-upgrades.jsonl`,每行
 *   `{"v":1,"type":"init|shadow|canary|switch|rollback|retire","at":ISO,"name":...,"version":...,"payload":{...}}`
 * - `at` 统一是 ISO 字符串(审计人读),协议纯函数要的毫秒数由 `Date.parse(line.at)` 反推;
 *   调用方传 `at` 时给毫秒数或 ISO 字符串都接受,一律归一成 ISO 落盘。
 * - `init` 是台账层扩展:协议不覆盖「首个版本怎么落盘」,而投影必须有一个起点
 *   (`initState` 把首版直接记成 stage="switch",它早就在线上)。
 * 投影语义(projectLedger):逐行重放,每行交给协议纯函数应用 → Map<name, UpgradeState>。
 * - 坏行(JSON 坏 / v 不匹配 / 未知 type / 缺 name/version / at 不可解析 / 无 init 前置 /
 *   同 name 重复 init / 纯逻辑拒绝)→ 只计 badLines 并跳过:一行坏不整文件失效、不 throw。
 * - `pull 失败不阻塞`:`switch --experiment-root` 落实验台账失败、`rollback --breaker-root`
 *   落熔断失败,都只把 {name, code} 折进 report.warnings(并把码抄在行 payload 上),升级/回滚本身照样落盘。
 * 依赖纪律:node:fs/node:path + runtime 纯逻辑(两跳惰性解析,先包 spec 后回退相对 src URL)
 * + 同目录 experiment-store / rsi-breaker-store(相对路径 import,不重复实现台账)。
 * 不 import agent loop。参数错误是唯一允许 throw 的情形(TypeError,与 experiment-store 同口径);
 * IO/闸门/下游台账失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CanaryConfig,
  ResolveResult,
  ToolVersion,
  UpgradeStage,
  UpgradeState,
} from "@lampgenie/runtime/agent/tool-upgrade-protocol";

/** runtime 面(只用本文件会调到的纯函数出口;签名以协议文件为准)。 */
interface StateResult {
  ok: boolean;
  codes: string[];
  state?: UpgradeState;
}

interface ToolUpRuntime {
  readonly TOOL_UPGRADE_VERSION: number;
  readonly TOOL_UP_INVALID: string;
  readonly TOOL_UP_NOT_FOUND: string;
  initState(opts: { name: string; version: string; at?: number }): StateResult;
  startShadow(state: UpgradeState, opts: { newVersion: string; alias: string; at: number }): StateResult;
  promoteCanary(state: UpgradeState, opts: { version: string; canary: CanaryConfig; at?: number }): StateResult;
  switchVersion(state: UpgradeState, opts: { version: string; at: number; experimentId?: string }): StateResult;
  rollback(state: UpgradeState, opts: { toVersion: string; at: number }): StateResult;
  resolveForCall(
    state: UpgradeState,
    opts?: { sessionId?: string; projectId?: string; taskClass?: string; alias?: string },
  ): ResolveResult;
  retireVersion(state: UpgradeState, opts: { version: string; at: number; keepWindows?: number }): StateResult;
  buildExperimentRecord(opts: { name: string; from: string; to: string }): unknown;
}

let runtime: ToolUpRuntime | undefined;

/** 两跳解析 runtime 模块:`node --experimental-strip-types` 直接跑 CLI 时 spec 解析不到 dist。 */
async function loadRuntime(): Promise<ToolUpRuntime> {
  if (runtime) return runtime;
  const spec = "@lampgenie/runtime/agent/tool-upgrade-protocol";
  try {
    runtime = (await import(spec)) as unknown as ToolUpRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/tool-upgrade-protocol.ts", import.meta.url)
      .href;
    runtime = (await import(srcUrl)) as unknown as ToolUpRuntime;
  }
  return runtime;
}

/**
 * 同目录下游台账:`.ts` 显式后缀的惰性 import(静态无后缀 import 在 strip-types 下会
 * ERR_MODULE_NOT_FOUND,而 tsc 的 Bundler 解析允许动态 URL 面)。
 */
type ExperimentStoreModule = { recordExperiment: typeof import("./experiment-store").recordExperiment };
type BreakerStoreModule = { pause: typeof import("./rsi-breaker-store").pause };

let experimentStoreModule: ExperimentStoreModule | undefined;
let breakerStoreModule: BreakerStoreModule | undefined;

async function loadExperimentStore(): Promise<ExperimentStoreModule> {
  if (experimentStoreModule) return experimentStoreModule;
  experimentStoreModule = (await import(new URL("./experiment-store.ts", import.meta.url).href)) as ExperimentStoreModule;
  return experimentStoreModule;
}

async function loadBreakerStore(): Promise<BreakerStoreModule> {
  if (breakerStoreModule) return breakerStoreModule;
  breakerStoreModule = (await import(new URL("./rsi-breaker-store.ts", import.meta.url).href)) as BreakerStoreModule;
  return breakerStoreModule;
}

/** 顶层 await:所有导出函数保持同步签名(switch 要同步写实验台账)。 */
const rt = await loadRuntime();
const expStore = await loadExperimentStore();

/** 台账 schema 版本(与 runtime 同源)。 */
const SCHEMA_VERSION = rt.TOOL_UPGRADE_VERSION;

/** 协议稳定码(按常量引用,不写字面量)。 */
const TOOL_UP_INVALID = rt.TOOL_UP_INVALID;
const TOOL_UP_NOT_FOUND = rt.TOOL_UP_NOT_FOUND;

/** 台账行类型(只增不改)。 */
export const TOOL_UP_LINE_TYPES = ["init", "shadow", "canary", "switch", "rollback", "retire"] as const;

export type ToolUpLineType = (typeof TOOL_UP_LINE_TYPES)[number];

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(TOOL_UP_LINE_TYPES);

/** store 层自产失败码(闸门码沿用协议 TOOL_UP_*)。 */
export const TOOL_UP_STORE_ERROR = "TOOL_UP_STORE_ERROR";

const STORE_ERROR_CODES = [TOOL_UP_STORE_ERROR];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串(去空白后仍非空)。 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 参数错误校验(唯一允许 throw 的情形)。 */
function assertRoot(fn: string, root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new TypeError(`${fn}: root 必须是非空字符串`);
  return root;
}

/** 台账路径:`<root>/.genie/rsi/tool-upgrades.jsonl`。 */
export function toolUpgradePaths(root: string): { dir: string; file: string } {
  const base = assertRoot("toolUpgradePaths", root);
  const dir = join(base, ".genie", "rsi");
  return { dir, file: join(dir, "tool-upgrades.jsonl") };
}

/** 毫秒时间戳:入参缺省 → 当前时钟;接受毫秒数与 ISO 字符串。 */
function msOf(fn: string, at: unknown): number {
  if (at === undefined || at === null) return Date.now();
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new TypeError(`${fn}: at 必须是毫秒数或 ISO 字符串`);
}

/** 毫秒 → ISO(台账行的 at 单位)。 */
function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** 投影结果:可复核的升级台账视图。 */
export interface ToolUpgradeProjection {
  states: Map<string, UpgradeState>;
  badLines: number;
  totalLines: number;
  warnings: { name: string; code: string }[];
}

/** 一次写盘结果(内部用)。 */
interface WriteOutcome {
  ok: boolean;
  codes: string[];
  state?: UpgradeState;
}

/** 一行台账的公共形状。 */
function buildLine(
  type: ToolUpLineType,
  at: string,
  name: string,
  version: string,
  payload: UnknownRecord = {},
): UnknownRecord {
  return { v: SCHEMA_VERSION, type, at, name, version, payload };
}

/** 追加一行(建目录 + 追加 + 写后行数复核);失败返回 false 不 throw。 */
function appendLine(root: string, line: UnknownRecord): boolean {
  const { dir, file } = toolUpgradePaths(root);
  let before = 0;
  try {
    before = countNonEmptyLines(readFileSync(file, "utf8"));
  } catch {
    before = 0;
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
    return countNonEmptyLines(readFileSync(file, "utf8")) === before + 1;
  } catch {
    return false;
  }
}

function countNonEmptyLines(text: string): number {
  let count = 0;
  for (const raw of text.split("\n")) if (raw.trim() !== "") count += 1;
  return count;
}

/** 逐行重放成 Map<name, UpgradeState>;坏行跳过并计数,永不 throw。 */
export function projectLedger(root: string): ToolUpgradeProjection {
  const { file } = toolUpgradePaths(root);
  const states = new Map<string, UpgradeState>();
  const warnings: { name: string; code: string }[] = [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { states, badLines: 0, totalLines: 0, warnings };
  }

  let badLines = 0;
  let totalLines = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    totalLines += 1;
    const applied = applyLine(states, raw, warnings);
    if (!applied) badLines += 1;
  }
  return { states, badLines, totalLines, warnings };
}

/** 应用一行:解析 + 校验 + 交给协议纯函数;返回是否成功应用。 */
function applyLine(
  states: Map<string, UpgradeState>,
  raw: string,
  warnings: { name: string; code: string }[],
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (parsed["v"] !== SCHEMA_VERSION) return false;
  const type = parsed["type"];
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return false;
  const name = nonEmpty(parsed["name"]);
  const version = nonEmpty(parsed["version"]);
  const atRaw = parsed["at"];
  if (name === undefined || version === undefined || typeof atRaw !== "string") return false;
  const ms = Date.parse(atRaw);
  if (!Number.isFinite(ms)) return false;
  const payload: UnknownRecord = isRecord(parsed["payload"]) ? parsed["payload"] : {};

  const previous = states.get(name);
  let result: StateResult | undefined;

  switch (type as ToolUpLineType) {
    case "init": {
      if (previous !== undefined) return false;
      result = rt.initState({ name, version, at: ms });
      break;
    }
    case "shadow": {
      if (previous === undefined) return false;
      const alias = nonEmpty(payload["alias"]);
      if (alias === undefined) return false;
      result = rt.startShadow(previous, { newVersion: version, alias, at: ms });
      break;
    }
    case "canary": {
      if (previous === undefined) return false;
      const canary = payload["canary"];
      if (!isRecord(canary)) return false;
      result = rt.promoteCanary(previous, { version, canary: canary as unknown as CanaryConfig, at: ms });
      break;
    }
    case "switch": {
      if (previous === undefined) return false;
      const experimentId = nonEmpty(payload["experimentId"]);
      result = rt.switchVersion(previous, { version, at: ms, experimentId });
      break;
    }
    case "rollback": {
      if (previous === undefined) return false;
      const toVersion = nonEmpty(payload["toVersion"]) ?? version;
      result = rt.rollback(previous, { toVersion, at: ms });
      break;
    }
    case "retire": {
      if (previous === undefined) return false;
      result = rt.retireVersion(previous, { version, at: ms });
      break;
    }
    default:
      return false;
  }

  if (result === undefined || result.ok !== true || result.state === undefined) return false;
  states.set(name, result.state);

  // 下游台账失败只记 warning,不使这一行失效。
  const experimentError = nonEmpty(payload["experimentError"]);
  const breakerError = nonEmpty(payload["breakerError"]);
  if (experimentError !== undefined) warnings.push({ name, code: experimentError });
  if (breakerError !== undefined) warnings.push({ name, code: breakerError });
  return true;
}

/** 写一行的公共收尾:落盘成功后重新投影,拿到「按台账算出来的」state。 */
function commitLine(root: string, line: UnknownRecord, codes: string[]): WriteOutcome {
  if (!appendLine(root, line)) return { ok: false, codes: STORE_ERROR_CODES };
  const name = String(line["name"]);
  const state = projectLedger(root).states.get(name);
  return { ok: true, codes, state };
}

/** 首个版本落盘(台账扩展:协议不覆盖起点)。同 name 重复 init → TOOL_UP_INVALID。 */
export function initUpgrade(root: string, opts: { name: string; version: string; at?: number | string }): WriteOutcome {
  const base = assertRoot("initUpgrade", root);
  if (!isRecord(opts)) throw new TypeError("initUpgrade: opts 必须是对象");
  const ms = msOf("initUpgrade", opts.at);
  const result = rt.initState({ name: opts.name, version: opts.version, at: ms });
  if (result.ok !== true || result.state === undefined) return { ok: false, codes: result.codes };
  const name = result.state.name;
  if (projectLedger(base).states.has(name)) return { ok: false, codes: [TOOL_UP_INVALID] };
  return commitLine(base, buildLine("init", isoOf(ms), name, result.state.current), result.codes);
}

/** 起影子:新版进别名槽位,不抢流量。 */
export function startShadow(
  root: string,
  opts: { name: string; newVersion: string; alias: string; at?: number | string },
): WriteOutcome {
  const base = assertRoot("startShadow", root);
  if (!isRecord(opts)) throw new TypeError("startShadow: opts 必须是对象");
  const ms = msOf("startShadow", opts.at);
  const previous = projectLedger(base).states.get(String(opts.name));
  if (previous === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND] };

  const result = rt.startShadow(previous, { newVersion: opts.newVersion, alias: opts.alias, at: ms });
  if (result.ok !== true || result.state === undefined) return { ok: false, codes: result.codes };
  const line = buildLine("shadow", isoOf(ms), previous.name, String(opts.newVersion), { alias: opts.alias });
  return commitLine(base, line, result.codes);
}

/** shadow → canary:灰度配置挂到版本上。 */
export function promoteCanary(
  root: string,
  opts: { name: string; version: string; canary: CanaryConfig; at?: number | string },
): WriteOutcome {
  const base = assertRoot("promoteCanary", root);
  if (!isRecord(opts)) throw new TypeError("promoteCanary: opts 必须是对象");
  const ms = msOf("promoteCanary", opts.at);
  const previous = projectLedger(base).states.get(String(opts.name));
  if (previous === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND] };

  const result = rt.promoteCanary(previous, { version: opts.version, canary: opts.canary, at: ms });
  if (result.ok !== true || result.state === undefined) return { ok: false, codes: result.codes };
  const target = result.state.versions.find((item) => item.version === opts.version);
  const line = buildLine("canary", isoOf(ms), previous.name, opts.version, {
    canary: target?.canary ?? opts.canary,
  });
  return commitLine(base, line, result.codes);
}

/**
 * canary/shadow → switch:新版接管 current,旧版降级(demotedFrom + 保留窗口)。
 * 给了 experimentRoot 就同步写 #192 实验台账(recordExperiment 是同步函数);
 * 写失败(返回 code 或 throw)不阻塞升级,把码记进 payload.experimentError + warnings。
 */
export function switchVersion(
  root: string,
  opts: { name: string; version: string; at?: number | string; experimentRoot?: string },
): WriteOutcome & { warnings: { name: string; code: string }[] } {
  const base = assertRoot("switchVersion", root);
  if (!isRecord(opts)) throw new TypeError("switchVersion: opts 必须是对象");
  const ms = msOf("switchVersion", opts.at);
  const previous = projectLedger(base).states.get(String(opts.name));
  if (previous === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND], warnings: [] };

  // 先只做纯逻辑校验,通过后才产生实验台账副作用。
  const checked = rt.switchVersion(previous, { version: opts.version, at: ms });
  if (checked.ok !== true) return { ok: false, codes: checked.codes, warnings: [] };

  const warnings: { name: string; code: string }[] = [];
  let experimentId: string | undefined;
  let experimentError: string | undefined;
  const experimentRoot = nonEmpty(opts.experimentRoot);
  if (experimentRoot !== undefined) {
    const from = previous.current;
    const built = rt.buildExperimentRecord({ name: previous.name, from, to: opts.version });
    if (!isRecord(built) || built["ok"] === false) {
      experimentError = firstCode(built);
    } else {
      try {
        const recorded = expStore.recordExperiment(experimentRoot, built);
        if (recorded.ok === true && typeof recorded.id === "string" && recorded.id !== "") {
          experimentId = recorded.id;
        } else {
          experimentError = recorded.code ?? TOOL_UP_STORE_ERROR;
        }
      } catch {
        experimentError = TOOL_UP_STORE_ERROR;
      }
    }
    if (experimentError !== undefined) warnings.push({ name: previous.name, code: experimentError });
  }

  const applied = rt.switchVersion(previous, { version: opts.version, at: ms, experimentId });
  if (applied.ok !== true || applied.state === undefined) return { ok: false, codes: applied.codes, warnings };

  const payload: UnknownRecord = {};
  if (experimentId !== undefined) payload["experimentId"] = experimentId;
  if (experimentError !== undefined) payload["experimentError"] = experimentError;
  const line = buildLine("switch", isoOf(ms), previous.name, opts.version, payload);
  const outcome = commitLine(base, line, applied.codes);
  return { ...outcome, warnings };
}

/**
 * 回滚 current 到 toVersion;给了 breakerRoot 就同时熔断(async:切闸)。
 * 熔断失败不阻塞回滚,码记进 payload.breakerError + warnings。
 * 注意 pause 要的 at 是 ISO 字符串,协议要的是毫秒 —— 这里不传 at(由熔断台账自己取时钟)。
 */
export async function rollbackVersion(
  root: string,
  opts: { name: string; toVersion: string; at?: number | string; breakerRoot?: string; reason?: string },
): Promise<WriteOutcome & { warnings: { name: string; code: string }[] }> {
  const base = assertRoot("rollbackVersion", root);
  if (!isRecord(opts)) throw new TypeError("rollbackVersion: opts 必须是对象");
  const ms = msOf("rollbackVersion", opts.at);
  const previous = projectLedger(base).states.get(String(opts.name));
  if (previous === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND], warnings: [] };

  const checked = rt.rollback(previous, { toVersion: opts.toVersion, at: ms });
  if (checked.ok !== true || checked.state === undefined) {
    return { ok: false, codes: checked.codes, warnings: [] };
  }

  const warnings: { name: string; code: string }[] = [];
  let breakerError: string | undefined;
  const breakerRoot = nonEmpty(opts.breakerRoot);
  if (breakerRoot !== undefined) {
    const reason =
      nonEmpty(opts.reason) ?? `rollback ${previous.name} ${previous.current}→${opts.toVersion}`;
    try {
      const breaker = await loadBreakerStore();
      const paused = await breaker.pause(breakerRoot, {
        by: "tool-upgrade",
        reason,
        trigger: "auto-guardrail",
      });
      if (paused.ok !== true) breakerError = paused.codes[0] ?? TOOL_UP_STORE_ERROR;
    } catch {
      breakerError = TOOL_UP_STORE_ERROR;
    }
    if (breakerError !== undefined) warnings.push({ name: previous.name, code: breakerError });
  }

  const payload: UnknownRecord = { toVersion: opts.toVersion };
  if (breakerError !== undefined) payload["breakerError"] = breakerError;
  const line = buildLine("rollback", isoOf(ms), previous.name, opts.toVersion, payload);
  const outcome = commitLine(base, line, checked.codes);
  return { ...outcome, warnings };
}

/** 下线版本:keep window 没走完 → TOOL_UP_KEEP_WINDOW_ACTIVE(不落盘)。 */
export function retireVersion(
  root: string,
  opts: { name: string; version: string; at?: number | string },
): WriteOutcome {
  const base = assertRoot("retireVersion", root);
  if (!isRecord(opts)) throw new TypeError("retireVersion: opts 必须是对象");
  const ms = msOf("retireVersion", opts.at);
  const previous = projectLedger(base).states.get(String(opts.name));
  if (previous === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND] };

  const result = rt.retireVersion(previous, { version: opts.version, at: ms });
  if (result.ok !== true || result.state === undefined) return { ok: false, codes: result.codes };
  const line = buildLine("retire", isoOf(ms), previous.name, opts.version);
  return commitLine(base, line, result.codes);
}

/** 解析一次调用落哪个版本(alias → canary 分流 → current)。未知工具 → TOOL_UP_NOT_FOUND。 */
export function resolveCall(
  root: string,
  opts: { name: string; sessionId?: string; projectId?: string; taskClass?: string; alias?: string },
): ResolveResult {
  const base = assertRoot("resolveCall", root);
  if (!isRecord(opts)) throw new TypeError("resolveCall: opts 必须是对象");
  const state = projectLedger(base).states.get(String(opts.name));
  if (state === undefined) return { ok: false, codes: [TOOL_UP_NOT_FOUND], version: "", stage: "", source: "" };
  return rt.resolveForCall(state, {
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    taskClass: opts.taskClass,
    alias: opts.alias,
  });
}

/** 台账列表(name 可选过滤)。 */
export function listUpgrades(
  root: string,
  name?: string): {
  ok: boolean;
  upgrades: { name: string; current: string; stage: UpgradeStage | ""; aliasMap: Record<string, string>; versions: ToolVersion[] }[];
  badLines: number;
  totalLines: number;
} {
  const base = assertRoot("listUpgrades", root);
  const projection = projectLedger(base);
  const filter = nonEmpty(name);
  const upgrades: { name: string; current: string; stage: UpgradeStage | ""; aliasMap: Record<string, string>; versions: ToolVersion[] }[] = [];
  for (const [key, state] of projection.states) {
    if (filter !== undefined && key !== filter) continue;
    const currentVersion = state.versions.find((item) => item.version === state.current);
    upgrades.push({
      name: state.name,
      current: state.current,
      stage: currentVersion?.stage ?? "",
      aliasMap: { ...state.aliasMap },
      versions: state.versions.map((item) => ({ ...item })),
    });
  }
  return { ok: true, upgrades, badLines: projection.badLines, totalLines: projection.totalLines };
}

/** 报告:每个工具的当前版本/段位/别名映射 + 坏行 + 下游 warnings + 台账路径。 */
export function reportUpgrades(root: string): {
  ok: boolean;
  names: string[];
  perName: Record<
    string,
    {
      current: string;
      aliasMap: Record<string, string>;
      versions: { version: string; stage: UpgradeStage; alias?: string; retiredAt?: number }[];
    }
  >;
  badLines: number;
  totalLines: number;
  warnings: { name: string; code: string }[];
  path: string;
} {
  const base = assertRoot("reportUpgrades", root);
  const { file } = toolUpgradePaths(base);
  const projection = projectLedger(base);
  const names = [...projection.states.keys()].sort();
  const perName: Record<
    string,
    {
      current: string;
      aliasMap: Record<string, string>;
      versions: { version: string; stage: UpgradeStage; alias?: string; retiredAt?: number }[];
    }
  > = {};
  for (const key of names) {
    const state = projection.states.get(key);
    if (state === undefined) continue;
    perName[key] = {
      current: state.current,
      aliasMap: { ...state.aliasMap },
      versions: state.versions.map((item) => ({
        version: item.version,
        stage: item.stage,
        ...(item.alias !== undefined ? { alias: item.alias } : {}),
        ...(item.retiredAt !== undefined ? { retiredAt: item.retiredAt } : {}),
      })),
    };
  }
  return {
    ok: true,
    names,
    perName,
    badLines: projection.badLines,
    totalLines: projection.totalLines,
    warnings: projection.warnings,
    path: file,
  };
}

/** 协议码取不到时的兜底字面量(firstCode 只在纯逻辑返回形状异常时用它)。 */
const INVALID_CODE_FALLBACK = "TOOL_UP_INVALID";

/** 从纯逻辑的失败返回里取第一个码(取不到就给 INVALID)。 */
function firstCode(value: unknown): string {
  if (isRecord(value)) {
    const codes = value["codes"];
    if (Array.isArray(codes)) {
      for (const code of codes) if (typeof code === "string" && code !== "") return code;
    }
    const code = value["code"];
    if (typeof code === "string" && code !== "") return code;
  }
  return INVALID_CODE_FALLBACK;
}
