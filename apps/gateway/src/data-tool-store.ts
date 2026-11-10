/**
 * data 层工具仓(data layer tool store)。
 *
 * 落盘布局(硬约定):
 * - 工具目录 `<root>/.genie/rsi/tools/*.json`,每个 data 工具一个文件;
 *   文件内容 `{ spec: DataToolSpec, versions: DataToolSpec[] }`(versions 含当前版,semver 降序,首项 === spec)。
 * - 钉扎文件 `<root>/.genie/rsi/tool-pins.json`,`Record<sessionId, Record<toolName, version>>`。
 *
 * 语义全在 packages/harness-runtime/src/agent/data-tool-registry.ts(纯逻辑,已全绿);
 * 本文件只负责 IO:读目录组 registry、原子写盘、热加载(无进程内缓存,每次调用都重读目录)。
 *
 * 依赖纪律:只 import node:fs / node:path + 两跳解析的 runtime 模块;不 import agent loop、
 * 不 import gateway 其它业务模块。全部导出函数同步签名(顶层 await 解析 runtime)。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** data 工具声明(结构化视图;字段名与 runtime 的 DataToolSpec 一致)。 */
export interface DataToolSpecView {
  name: string;
  version: string;
  owner: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: { kind: "skill" | "command" | "mcp"; ref: string; args?: Record<string, unknown> };
  permissions: { mode?: "read" | "write" | "exec"; allowlist?: string[] };
  requires?: Array<{ kind: "binary" | "env" | "file" | "mcp"; name: string }>;
  layer: "data";
  shadowOf?: string;
  wrapOf?: string;
  registeredBy?: "human" | "agent" | "rsi";
  approval?: DataToolApprovalView;
  createdAt?: number;
}

export interface DataToolApprovalView {
  ok: boolean;
  codes?: string[];
  approverId?: string;
  approverKind?: "human" | "owner" | "agent";
  at?: number;
}

/** 注册表视图(结构化;字段名与 runtime 的 DataToolRegistry 一致)。 */
export interface DataToolRegistryView {
  native: string[];
  data: Record<string, DataToolSpecView>;
  versions: Record<string, DataToolSpecView[]>;
  plugin: string[];
  degraded: Record<string, string[]>;
  pins: Record<string, Record<string, string>>;
}

/** 依赖体检输入(与 runtime checkDependencies 的 env 形一致)。 */
export interface DoctorEnv {
  binaries?: string[];
  envVars?: string[];
  files?: string[];
  mcpMethods?: string[];
}

/** #196 门的裁决摘要(注册即过门时的回执)。 */
export interface DataToolGateInfo {
  decision: string;
  codes: string[];
  details?: string[];
}

/** 本文件用到的 runtime 面(只声明用到的部分)。 */
interface DataToolRuntime {
  readonly DATA_TOOL_VERSION: number;
  compareSemver(a: string, b: string): number;
  validateSpec(spec: unknown): { ok: boolean; codes: string[]; reasons: string[] };
  registerTool(
    registry: DataToolRegistryView,
    spec: unknown,
    opts?: { nativeNames?: string[]; now?: number },
  ): { ok: boolean; registry: DataToolRegistryView; codes: string[]; reason?: string };
  unregisterTool(
    registry: DataToolRegistryView,
    name: string,
  ): { ok: boolean; registry: DataToolRegistryView; codes: string[]; restored?: string; reason?: string };
  checkDependencies(
    registry: DataToolRegistryView,
    env: DoctorEnv,
  ): {
    registry: DataToolRegistryView;
    missing: Array<{ name: string; kind: string; dep: string }>;
    degraded: string[];
    codes: string[];
  };
  resolveTool(
    registry: DataToolRegistryView,
    name: string,
    opts?: { sessionPins?: Record<string, Record<string, string>>; sessionId?: string },
  ): { spec?: DataToolSpecView; layer: "native" | "data" | "plugin"; degraded?: string[]; codes: string[] };
  pinToolVersion(
    registry: DataToolRegistryView,
    sessionId: string,
    name: string,
    version: string,
  ): { ok: boolean; pins: Record<string, Record<string, string>>; codes: string[]; reason?: string };
  listTools(registry: DataToolRegistryView): {
    native: string[];
    data: Array<{ name: string; version: string; degraded?: string[]; shadowOf?: string; wrapOf?: string }>;
    plugin: string[];
  };
}

/** ModificationRequest 的最小结构面(只列本文件会填的字段)。 */
interface ModificationRequestLike {
  id: string;
  schemaVersion: number;
  surface: "tool";
  targetRef: string;
  variant: string;
  summary: string;
  author: { kind: "rsi"; id: string };
  approver?: { kind: "human" | "owner" | "agent"; id: string; at?: number };
  evidence: { hypothesisId: string };
  impact: { files: string[]; blastRadius: string };
  dryRun: { command: string; ok: boolean; at: number };
  canary: { scope: "session"; size: number; plannedAt: number };
  rollback: { kind: "snapshot"; ref: string };
  ownerName: string;
  irreversible: boolean;
  riskFlags: string[];
  createdAt: number;
  updatedAt: number;
  decision: { kind: "pending" };
}

interface SelfModRuntime {
  readonly SELF_MOD_SCHEMA_VERSION: number;
  evaluateSelfModification(
    req: ModificationRequestLike,
    policy?: Record<string, unknown>,
  ): { decision: string; codes: string[]; details: string[] };
}

let dataToolRuntime: DataToolRuntime | undefined;

/** 两跳解析 data-tool-registry(打包产物无源码时回落 src .ts,与 self-modification-store 同模式)。 */
async function loadDataToolRuntime(): Promise<DataToolRuntime> {
  if (dataToolRuntime) return dataToolRuntime;
  const spec = "@lampgenie/runtime/agent/data-tool-registry";
  try {
    dataToolRuntime = (await import(spec)) as unknown as DataToolRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/data-tool-registry.ts", import.meta.url).href;
    dataToolRuntime = (await import(srcUrl)) as unknown as DataToolRuntime;
  }
  return dataToolRuntime;
}

let selfModRuntime: SelfModRuntime | undefined;

/** 两跳解析 self-modification(#196 门)。 */
async function loadSelfModRuntime(): Promise<SelfModRuntime> {
  if (selfModRuntime) return selfModRuntime;
  const spec = "@lampgenie/runtime/agent/self-modification";
  try {
    selfModRuntime = (await import(spec)) as unknown as SelfModRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/self-modification.ts", import.meta.url).href;
    selfModRuntime = (await import(srcUrl)) as unknown as SelfModRuntime;
  }
  return selfModRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadDataToolRuntime();
const rt2 = await loadSelfModRuntime();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function versionOf(entry: UnknownRecord): string {
  return text(entry.version);
}

/** 工具目录:`<root>/.genie/rsi/tools`。 */
export function dataToolDir(root: string): string {
  return join(root, ".genie", "rsi", "tools");
}

/** 单个工具文件路径:`<root>/.genie/rsi/tools/<name>.json`。 */
export function dataToolPath(root: string, name: string): string {
  return join(dataToolDir(root), `${name}.json`);
}

/** 钉扎文件路径:`<root>/.genie/rsi/tool-pins.json`。 */
export function toolPinsPath(root: string): string {
  return join(root, ".genie", "rsi", "tool-pins.json");
}

/** 原子写:mkdir(recursive) + 临时文件 + rename。返回是否落盘成功(不 throw)。 */
function writeAtomic(path: string, content: string): boolean {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不影响结论 */
    }
    return false;
  }
}

function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 读 JSON:失败/坏 JSON 给原因,不 throw。 */
function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = readTextOrUndefined(path);
  if (raw === undefined) return { ok: false, reason: "读取失败" };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, reason: `JSON 解析失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 读钉扎文件(不存在/坏 JSON → 空表)。 */
function readPins(root: string): Record<string, Record<string, string>> {
  const parsed = readJson(toolPinsPath(root));
  if (!parsed.ok || !isRecord(parsed.value)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const sessionId of Object.keys(parsed.value)) {
    const row = parsed.value[sessionId];
    if (!isRecord(row)) continue;
    const pins: Record<string, string> = {};
    for (const name of Object.keys(row)) {
      const version = row[name];
      if (typeof version === "string") pins[name] = version;
    }
    out[sessionId] = pins;
  }
  return out;
}

function writePins(root: string, pins: Record<string, Record<string, string>>): boolean {
  return writeAtomic(toolPinsPath(root), `${JSON.stringify(pins, null, 2)}\n`);
}

/** 规范化落盘形态(固定键序 + layer=data;undefined 字段不写)。 */
function canonicalSpec(raw: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {
    name: raw.name,
    version: raw.version,
    owner: raw.owner,
    description: typeof raw.description === "string" ? raw.description : "",
    parameters: raw.parameters,
    handler: raw.handler,
    permissions: raw.permissions,
    layer: "data",
  };
  for (const key of ["requires", "shadowOf", "wrapOf", "registeredBy", "approval", "createdAt"]) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  return out;
}

interface StoreScan {
  registry: DataToolRegistryView;
  files: string[];
  pins: Record<string, Record<string, string>>;
  bad: Array<{ file: string; reason: string }>;
}

/** 读工具目录 + 钉扎文件组 registry(坏文件进 bad,不 throw)。 */
function scanStore(root: string, opts?: { nativeNames?: string[]; pluginNames?: string[] }): StoreScan {
  const dir = dataToolDir(root);
  const files: string[] = [];
  const bad: Array<{ file: string; reason: string }> = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    entries = [];
  }
  const data: Record<string, DataToolSpecView> = {};
  const versions: Record<string, DataToolSpecView[]> = {};
  for (const file of entries) {
    files.push(file);
    const parsed = readJson(join(dir, file));
    if (!parsed.ok) {
      bad.push({ file, reason: parsed.reason });
      continue;
    }
    const raw = parsed.value;
    if (!isRecord(raw)) {
      bad.push({ file, reason: "文件内容不是对象" });
      continue;
    }
    const wrapped = Object.prototype.hasOwnProperty.call(raw, "spec");
    const specRaw = wrapped ? raw.spec : raw;
    const historyRaw = wrapped ? raw.versions : undefined;
    if (!isRecord(specRaw)) {
      bad.push({ file, reason: "缺 spec 对象" });
      continue;
    }
    const name = specRaw.name;
    const version = specRaw.version;
    if (typeof name !== "string" || name.trim() === "") {
      bad.push({ file, reason: "缺 name" });
      continue;
    }
    if (typeof version !== "string" || version.trim() === "") {
      bad.push({ file, reason: "缺 version" });
      continue;
    }
    const spec = specRaw as unknown as DataToolSpecView;
    const history: UnknownRecord[] = [];
    if (Array.isArray(historyRaw)) {
      for (const item of historyRaw) if (isRecord(item) && typeof item.version === "string") history.push(item);
    }
    const merged: DataToolSpecView[] = [];
    const seen = new Set<string>();
    for (const entry of [specRaw, ...history] as UnknownRecord[]) {
      const key = versionOf(entry);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry as unknown as DataToolSpecView);
    }
    merged.sort((left, right) => rt.compareSemver(right.version, left.version));
    data[name] = spec;
    versions[name] = merged;
  }
  const pins = readPins(root);
  return {
    registry: {
      native: [...(opts?.nativeNames ?? [])],
      data,
      versions,
      plugin: [...(opts?.pluginNames ?? [])],
      degraded: {},
      pins,
    },
    files,
    pins,
    bad,
  };
}

/** 热加载:重新读目录 → registry(每次调用都读盘,无进程内缓存)。 */
export function reloadTools(
  root: string,
  opts?: {
    nativeNames?: string[];
    pluginNames?: string[];
    env?: DoctorEnv;
    pins?: Record<string, Record<string, string>>;
  },
): { ok: boolean; codes: string[]; registry: DataToolRegistryView; bad: Array<{ file: string; reason: string }> } {
  const scan = scanStore(root, opts);
  let registry = scan.registry;
  if (opts?.pins && isRecord(opts.pins)) {
    registry = { ...registry, pins: { ...scan.pins, ...opts.pins } };
  }
  let codes: string[] = [];
  if (opts?.env) {
    const checked = rt.checkDependencies(registry, opts.env);
    registry = { ...registry, degraded: checked.registry.degraded ?? {} };
    codes = [...checked.codes];
  }
  if (scan.bad.length > 0) codes = ["DATA_TOOL_INVALID", ...codes.filter((code) => code !== "DATA_TOOL_INVALID")];
  return { ok: scan.bad.length === 0, codes, registry, bad: scan.bad };
}

interface RegisterOpts {
  nativeNames?: string[];
  approval?: { ok?: boolean; by?: string; kind?: "human" | "owner" | "agent" };
  now?: number;
}

function resolveApprover(
  opts: RegisterOpts | undefined,
  owner: string,
  now: number,
): { kind: "human" | "owner" | "agent"; id: string; at: number } | undefined {
  if (opts?.approval?.ok !== true) return undefined;
  return { kind: opts.approval.kind ?? "human", id: opts.approval.by ?? `human:${owner}`, at: now };
}

/** 注册前必过的 #196 门:合成 ModificationRequest 调 evaluateSelfModification。 */
function evaluateGate(raw: UnknownRecord, opts: RegisterOpts | undefined, now: number): DataToolGateInfo {
  const name = text(raw.name);
  const version = text(raw.version);
  const owner = text(raw.owner);
  const approver = resolveApprover(opts, owner, now);
  const description = text(raw.description);
  const request: ModificationRequestLike = {
    id: `data-tool:${name}@${version}`,
    schemaVersion: rt2.SELF_MOD_SCHEMA_VERSION,
    surface: "tool",
    targetRef: `${name}@${version}`,
    variant: raw.shadowOf ? "shadow" : raw.wrapOf ? "wrap" : "add",
    summary: description.trim() !== "" ? description : `注册 data 工具 ${name}`,
    author: { kind: "rsi", id: "rsi" },
    ...(approver ? { approver } : {}),
    evidence: { hypothesisId: `data-tool:${name}@${version}` },
    impact: { files: [`.genie/rsi/tools/${name}.json`], blastRadius: `data 层工具 ${name}` },
    dryRun: { command: `data-tool --register ${name}@${version} --dry-run`, ok: true, at: now },
    canary: { scope: "session", size: 1, plannedAt: now },
    rollback: { kind: "snapshot", ref: `.genie/rsi/tools/${name}.json` },
    ownerName: owner,
    irreversible: false,
    riskFlags: [],
    createdAt: now,
    updatedAt: now,
    decision: { kind: "pending" },
  };
  const evaluated = rt2.evaluateSelfModification(request);
  return { decision: evaluated.decision, codes: [...evaluated.codes], details: [...evaluated.details] };
}

/** 注册/升级 data 工具(registeredBy=rsi 时先过 #196 门;通过才落盘)。 */
export function registerDataTool(
  root: string,
  spec: unknown,
  opts?: RegisterOpts,
): {
  ok: boolean;
  codes: string[];
  reason?: string;
  spec?: DataToolSpecView;
  gate?: DataToolGateInfo;
} {
  const nativeNames = opts?.nativeNames ?? [];
  const now = typeof opts?.now === "number" ? opts.now : Date.now();
  if (!isRecord(spec)) {
    return { ok: false, codes: ["DATA_TOOL_INVALID"], reason: "工具声明必须是普通对象" };
  }
  const checked = rt.validateSpec(spec);
  if (!checked.ok) {
    return { ok: false, codes: ["DATA_TOOL_INVALID"], reason: checked.reasons.join("; ") };
  }

  const reloaded = reloadTools(root, { nativeNames });
  let candidate: UnknownRecord = spec;
  let gate: DataToolGateInfo | undefined;
  if (spec.registeredBy === "rsi") {
    gate = evaluateGate(spec, opts, now);
    if (gate.decision !== "allow") {
      return {
        ok: false,
        codes: [...gate.codes, "DATA_TOOL_NEEDS_APPROVAL"],
        reason: (gate.details ?? []).join("; "),
        gate,
      };
    }
    const approver = resolveApprover(opts, text(spec.owner), now);
    candidate = {
      ...spec,
      approval: {
        ok: true,
        codes: [...gate.codes],
        approverId: approver?.id,
        approverKind: approver?.kind,
        at: now,
      },
    };
  }

  const registered = rt.registerTool(reloaded.registry, candidate, { nativeNames, now });
  if (!registered.ok) return { ok: false, codes: registered.codes, reason: registered.reason, gate };

  const name = text(candidate.name);
  const version = text(candidate.version);
  const path = dataToolPath(root, name);
  const history: UnknownRecord[] = [candidate];
  for (const entry of registered.registry.versions?.[name] ?? []) {
    history.push(entry as unknown as UnknownRecord);
  }
  const ordered: UnknownRecord[] = [];
  const seen = new Set<string>();
  for (const entry of history) {
    const key = versionOf(entry);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    ordered.push(entry);
  }
  ordered.sort((left, right) => rt.compareSemver(versionOf(right), versionOf(left)));
  const payload = {
    spec: canonicalSpec(candidate),
    versions: ordered.map((entry) => canonicalSpec(entry)),
  };

  const before = readTextOrUndefined(path);
  const specView = payload.spec as unknown as DataToolSpecView;
  const result = (): { ok: boolean; codes: string[]; reason?: string; spec?: DataToolSpecView; gate?: DataToolGateInfo } => ({
    ok: true,
    codes: ["DATA_TOOL_REGISTERED"],
    spec: specView,
    ...(gate ? { gate } : {}),
  });
  if (!writeAtomic(path, `${JSON.stringify(payload, null, 2)}\n`)) {
    return { ok: false, codes: ["DATA_TOOL_INVALID"], reason: `写 ${path} 失败`, gate };
  }
  const written = readJson(path);
  const persisted = written.ok && isRecord(written.value) && isRecord(written.value.spec) ? written.value.spec : undefined;
  if (!persisted || text(persisted.name) !== name || text(persisted.version) !== version) {
    try {
      if (before === undefined) unlinkSync(path);
      else writeFileSync(path, before, "utf8");
    } catch {
      /* 恢复尽力而为 */
    }
    return { ok: false, codes: ["DATA_TOOL_INVALID"], reason: "回读校验失败(spec 版本不符)", gate };
  }
  return result();
}

/** 卸载 data 工具:删文件 + 清理所有 session 对该 name 的钉扎。 */
export function unregisterDataTool(
  root: string,
  name: string,
): { ok: boolean; codes: string[]; restored?: string; reason?: string } {
  const scan = scanStore(root);
  const removed = rt.unregisterTool(scan.registry, name);
  if (!removed.ok) return { ok: false, codes: removed.codes, reason: removed.reason };

  const path = dataToolPath(root, name);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (error) {
    return {
      ok: false,
      codes: ["DATA_TOOL_INVALID"],
      reason: `删除 ${path} 失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pins: Record<string, Record<string, string>> = {};
  let pinsChanged = false;
  for (const sessionId of Object.keys(scan.pins)) {
    const row = { ...(scan.pins[sessionId] ?? {}) };
    if (row[name] !== undefined) {
      delete row[name];
      pinsChanged = true;
    }
    pins[sessionId] = row;
  }
  if (pinsChanged) writePins(root, pins);

  const out: { ok: boolean; codes: string[]; restored?: string } = { ok: true, codes: ["DATA_TOOL_UNREGISTERED"] };
  if (removed.restored !== undefined) out.restored = removed.restored;
  return out;
}

/** 列表口径:reload + runtime listTools。 */
export function listToolStore(
  root: string,
  opts?: { nativeNames?: string[]; pluginNames?: string[] },
): {
  native: string[];
  data: Array<{ name: string; version: string; degraded?: string[]; shadowOf?: string; wrapOf?: string }>;
  plugin: string[];
  degraded: Record<string, string[]>;
  pins: Record<string, Record<string, string>>;
  bad: Array<{ file: string; reason: string }>;
} {
  const reloaded = reloadTools(root, opts);
  const listed = rt.listTools(reloaded.registry);
  return {
    native: listed.native,
    data: listed.data,
    plugin: listed.plugin,
    degraded: reloaded.registry.degraded,
    pins: reloaded.registry.pins,
    bad: reloaded.bad,
  };
}

/** 解析生效工具(session 钉扎 > 当前 data 版本 > native)。 */
export function resolveDataTool(
  root: string,
  name: string,
  opts?: { sessionId?: string },
): { spec?: DataToolSpecView; layer: "native" | "data" | "plugin"; degraded?: string[]; codes: string[] } {
  const reloaded = reloadTools(root);
  return rt.resolveTool(reloaded.registry, name, {
    sessionId: opts?.sessionId,
    sessionPins: reloaded.registry.pins,
  });
}

/** 钉扎某 session 的工具版本(成功后整体原子重写 tool-pins.json)。 */
export function pinDataTool(
  root: string,
  sessionId: string,
  name: string,
  version: string,
): { ok: boolean; pins: Record<string, Record<string, string>>; codes: string[]; reason?: string } {
  const reloaded = reloadTools(root);
  const pinned = rt.pinToolVersion(reloaded.registry, sessionId, name, version);
  if (!pinned.ok) return pinned;
  if (!writePins(root, pinned.pins)) {
    return {
      ok: false,
      pins: reloaded.registry.pins,
      codes: ["DATA_TOOL_INVALID"],
      reason: `写 ${toolPinsPath(root)} 失败`,
    };
  }
  return pinned;
}

/** 依赖体检:读目录组 registry → checkDependencies 拿 missing/degraded。 */
export function doctorDataTools(
  root: string,
  env: DoctorEnv,
): { ok: boolean; missing: Array<{ name: string; kind: string; dep: string }>; degraded: string[]; codes: string[] } {
  const scan = scanStore(root);
  const checked = rt.checkDependencies(scan.registry, env);
  const codes = [...checked.codes];
  if (scan.bad.length > 0 && !codes.includes("DATA_TOOL_INVALID")) codes.push("DATA_TOOL_INVALID");
  return {
    ok: checked.missing.length === 0 && scan.bad.length === 0,
    missing: checked.missing,
    degraded: checked.degraded,
    codes,
  };
}

/**
 * 报表口径:reload → 目录/文件/三层清单/钉扎/坏文件。
 * 依赖降级只在给了 opts.env 时判(与 doctor 同一真源);不给则 degraded 为空——
 * 不拿「未知」冒充「缺失」,env 之外的 binary/file/mcp 缺省值不可推断。
 */
export function reportTools(
  root: string,
  opts?: { env?: DoctorEnv; nativeNames?: string[]; pluginNames?: string[] },
): {
  ok: boolean;
  dir: string;
  files: string[];
  native: string[];
  data: Array<{ name: string; version: string; degraded?: string[]; shadowOf?: string; wrapOf?: string }>;
  plugin: string[];
  degraded: Record<string, string[]>;
  pins: Record<string, Record<string, string>>;
  bad: Array<{ file: string; reason: string }>;
} {
  const scan = scanStore(root);
  const base = {
    ...scan.registry,
    native: [...(opts?.nativeNames ?? scan.registry.native)],
    plugin: [...(opts?.pluginNames ?? scan.registry.plugin)],
  };
  const checked = opts?.env ? rt.checkDependencies(base, opts.env) : undefined;
  const registry = checked?.registry ?? base;
  const listed = rt.listTools(registry);
  return {
    ok: scan.bad.length === 0,
    dir: dataToolDir(root),
    files: scan.files,
    native: listed.native,
    data: listed.data,
    plugin: listed.plugin,
    degraded: checked ? registry.degraded : {},
    pins: scan.pins,
    bad: scan.bad,
  };
}
