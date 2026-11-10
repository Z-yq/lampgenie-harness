/**
 * data 层工具注册表(纯逻辑、零 IO)。
 * 工具面三层:native(编译内,只读不可改写)/ data(本模块,声明式注册:schema + handler 引用
 * skill/命令/MCP 方法)/ plugin(宿主隔离)。本模块不 import fs/net/path,也不 import agent loop:
 * 只做校验、版本、钉扎、依赖降级与解析,副作用(读盘/发命令)由调用方承担。
 */

export const DATA_TOOL_VERSION = 1;

export type ToolLayer = "native" | "data" | "plugin";

export interface DataToolHandler {
  kind: "skill" | "command" | "mcp";
  ref: string;
  args?: Record<string, unknown>;
}

export interface DataToolPermission {
  mode?: "read" | "write" | "exec";
  allowlist?: string[];
}

export interface DataToolRequirement {
  kind: "binary" | "env" | "file" | "mcp";
  name: string;
}

export interface DataToolApproval {
  ok: boolean;
  codes?: string[];
  approverId?: string;
  approverKind?: "human" | "owner" | "agent";
  at?: number;
}

export interface DataToolSpec {
  name: string;
  version: string;
  owner: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: DataToolHandler;
  permissions: DataToolPermission;
  requires?: DataToolRequirement[];
  layer: "data";
  shadowOf?: string;
  wrapOf?: string;
  registeredBy?: "human" | "agent" | "rsi";
  approval?: DataToolApproval;
  createdAt?: number;
}

export const DATA_TOOL_CODES = [
  "DATA_TOOL_INVALID",
  "DATA_TOOL_DUPLICATE",
  "DATA_TOOL_VERSION_STALE",
  "DATA_TOOL_NATIVE_IMMUTABLE",
  "DATA_TOOL_NEEDS_APPROVAL",
  "DATA_TOOL_REGISTERED",
  "DATA_TOOL_UNREGISTERED",
  "DATA_TOOL_DEP_MISSING",
  "DATA_TOOL_DEGRADED",
  "DATA_TOOL_PINNED",
  "DATA_TOOL_PIN_UNKNOWN",
  "DATA_TOOL_RESOLVED",
] as const;

export type DataToolCode = (typeof DATA_TOOL_CODES)[number];

export interface DataToolRegistry {
  native: string[];
  data: Record<string, DataToolSpec>;
  versions: Record<string, DataToolSpec[]>;
  plugin: string[];
  degraded: Record<string, string[]>;
  pins: Record<string, Record<string, string>>;
}

const NAME_RE = /^[a-z0-9_]{3,48}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const HANDLER_KINDS: readonly string[] = ["skill", "command", "mcp"];
const MODES: readonly string[] = ["read", "write", "exec"];
const DEP_KINDS: readonly string[] = ["binary", "env", "file", "mcp"];

type DepKind = DataToolRequirement["kind"];

interface RegistryView {
  native: string[];
  data: Record<string, DataToolSpec>;
  versions: Record<string, DataToolSpec[]>;
  plugin: string[];
  degraded: Record<string, string[]>;
  pins: Record<string, Record<string, string>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(value)) out[key] = strings(value[key]);
  return out;
}

function pinsRecord(value: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(value)) {
    const inner = value[key];
    if (!isPlainObject(inner)) continue;
    const row: Record<string, string> = {};
    for (const name of Object.keys(inner)) {
      const version = inner[name];
      if (typeof version === "string") row[name] = version;
    }
    out[key] = row;
  }
  return out;
}

function specRecord(value: unknown): Record<string, DataToolSpec> {
  const out: Record<string, DataToolSpec> = {};
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (isPlainObject(entry)) out[key] = entry as unknown as DataToolSpec;
  }
  return out;
}

function versionRecord(value: unknown): Record<string, DataToolSpec[]> {
  const out: Record<string, DataToolSpec[]> = {};
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(value)) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.filter((entry): entry is DataToolSpec => isPlainObject(entry)) as DataToolSpec[];
  }
  return out;
}

/** 把任意入参收窄成视图;畸形返回 undefined(调用方转 DATA_TOOL_INVALID,不抛)。 */
function viewRegistry(input: unknown): RegistryView | undefined {
  if (!isPlainObject(input)) return undefined;
  if (!Array.isArray(input.native) || !Array.isArray(input.plugin)) return undefined;
  if (!isPlainObject(input.data)) return undefined;
  return {
    native: strings(input.native),
    data: specRecord(input.data),
    versions: versionRecord(input.versions),
    plugin: strings(input.plugin),
    degraded: stringRecord(input.degraded),
    pins: pinsRecord(input.pins),
  };
}

function cloneRegistry(view: RegistryView): DataToolRegistry {
  const data: Record<string, DataToolSpec> = {};
  for (const key of Object.keys(view.data)) {
    const spec = view.data[key];
    if (spec) data[key] = spec;
  }
  const versions: Record<string, DataToolSpec[]> = {};
  for (const key of Object.keys(view.versions)) versions[key] = [...(view.versions[key] ?? [])];
  const degraded: Record<string, string[]> = {};
  for (const key of Object.keys(view.degraded)) degraded[key] = [...(view.degraded[key] ?? [])];
  const pins: Record<string, Record<string, string>> = {};
  for (const key of Object.keys(view.pins)) pins[key] = { ...(view.pins[key] ?? {}) };
  return { native: [...view.native], data, versions, plugin: [...view.plugin], degraded, pins };
}

function parseVersion(version: unknown): [number, number, number] | undefined {
  if (typeof version !== "string" || !VERSION_RE.test(version)) return undefined;
  const parts = version.split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  const patch = Number(parts[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return undefined;
  return [major, minor, patch];
}

/** semver 三态比较;-1 / 0 / 1,任一非法版本按 0(不可比)。 */
export function compareSemver(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const x = left[index]!;
    const y = right[index]!;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 六项字段校验 + layer/shadowOf/wrapOf 约束;错误类去重成单条 DATA_TOOL_INVALID。 */
export function validateSpec(spec: unknown): { ok: boolean; codes: string[]; reasons: string[] } {
  if (!isPlainObject(spec)) {
    return { ok: false, codes: ["DATA_TOOL_INVALID"], reasons: ["工具声明必须是普通对象"] };
  }
  const reasons: string[] = [];
  const name = spec.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) reasons.push("name 必须匹配 /^[a-z0-9_]{3,48}$/");
  if (parseVersion(spec.version) === undefined) reasons.push("version 必须是严格数字三段式 x.y.z");
  const owner = spec.owner;
  if (typeof owner !== "string" || owner.trim().length === 0) reasons.push("owner 必须是非空字符串");
  const parameters = spec.parameters;
  if (!isPlainObject(parameters) || Object.keys(parameters).length === 0) {
    reasons.push("parameters 必须是非空普通对象(JSON Schema object)");
  }
  const handler = spec.handler;
  if (!isPlainObject(handler)) {
    reasons.push("handler 必须是含 kind 与 ref 的对象");
  } else {
    if (typeof handler.kind !== "string" || !HANDLER_KINDS.includes(handler.kind)) {
      reasons.push("handler.kind 必须是 skill|command|mcp");
    }
    if (typeof handler.ref !== "string" || handler.ref.trim().length === 0) reasons.push("handler.ref 必须是非空字符串");
  }
  const permissions = spec.permissions;
  if (!isPlainObject(permissions)) {
    reasons.push("permissions 必须提供 mode(read|write|exec)或非空 allowlist");
  } else {
    const modeOk = typeof permissions.mode === "string" && MODES.includes(permissions.mode);
    const allow = permissions.allowlist;
    const allowOk = Array.isArray(allow) && allow.length > 0;
    if (!modeOk && !allowOk) reasons.push("permissions 必须提供 mode(read|write|exec)或非空 allowlist");
  }
  if (spec.layer !== undefined && spec.layer !== "data") reasons.push('layer 出现时必须 === "data"');
  for (const key of ["shadowOf", "wrapOf"] as const) {
    const value = spec[key];
    if (value !== undefined && value !== name) reasons.push(`${key} 出现时必须自指(等于 name)`);
  }
  if (reasons.length === 0) return { ok: true, codes: [], reasons };
  return { ok: false, codes: ["DATA_TOOL_INVALID"], reasons };
}

export function createRegistry(opts?: {
  native?: string[];
  plugin?: string[];
  data?: Record<string, DataToolSpec>;
  versions?: Record<string, DataToolSpec[]>;
  degraded?: Record<string, string[]>;
  pins?: Record<string, Record<string, string>>;
}): DataToolRegistry {
  const options = isPlainObject(opts) ? opts : {};
  const data = specRecord(options.data);
  const versions: Record<string, DataToolSpec[]> = {};
  if (isPlainObject(options.versions)) {
    const given = versionRecord(options.versions);
    for (const key of Object.keys(given)) versions[key] = given[key]!;
  }
  for (const key of Object.keys(data)) {
    if (!versions[key] || versions[key]!.length === 0) versions[key] = [data[key]!];
  }
  return {
    native: strings(options.native),
    data,
    versions,
    plugin: strings(options.plugin),
    degraded: stringRecord(options.degraded),
    pins: pinsRecord(options.pins),
  };
}

/** 注册(含升级/同版/降级三种裁决);registry 不可变,永远返回新对象。 */
export function registerTool(
  registry: DataToolRegistry,
  spec: DataToolSpec,
  opts?: { nativeNames?: string[]; now?: number },
): { ok: boolean; registry: DataToolRegistry; codes: string[]; reason?: string } {
  const view = viewRegistry(registry);
  if (!view) return { ok: false, registry, codes: ["DATA_TOOL_INVALID"], reason: "registry 畸形" };
  const check = validateSpec(spec);
  if (!check.ok) return { ok: false, registry, codes: ["DATA_TOOL_INVALID"], reason: check.reasons.join(";") };

  const name = spec.name;
  const shadowed = spec.shadowOf === name || spec.wrapOf === name;
  const nativeSet = new Set([...(strings(opts?.nativeNames) ?? []), ...view.native]);
  if (nativeSet.has(name) && !shadowed) {
    return { ok: false, registry, codes: ["DATA_TOOL_NATIVE_IMMUTABLE"], reason: `native 工具 ${name} 不可被 data 层改写` };
  }
  if (spec.registeredBy === "rsi" && spec.approval?.ok !== true) {
    return { ok: false, registry, codes: ["DATA_TOOL_NEEDS_APPROVAL"], reason: "RSI 注册需要 ok 的审批记录" };
  }

  const createdAt = typeof spec.createdAt === "number" ? spec.createdAt : (opts?.now ?? Date.now());
  const next: DataToolSpec = { ...spec, layer: "data", createdAt };
  const existing = view.data[name];
  if (existing) {
    const cmp = compareSemver(next.version, existing.version);
    if (cmp === 0) {
      return { ok: false, registry, codes: ["DATA_TOOL_DUPLICATE"], reason: `${name}@${next.version} 已注册` };
    }
    if (cmp < 0) {
      return {
        ok: false,
        registry,
        codes: ["DATA_TOOL_VERSION_STALE"],
        reason: `${next.version} 低于已生效的 ${existing.version}`,
      };
    }
  }

  const out = cloneRegistry(view);
  out.data[name] = next;
  const history = (view.versions[name] ?? []).filter((entry) => entry.version !== next.version);
  out.versions[name] = [next, ...history].sort((left, right) => compareSemver(right.version, left.version));
  return { ok: true, registry: out, codes: ["DATA_TOOL_REGISTERED"] };
}

export function unregisterTool(
  registry: DataToolRegistry,
  name: string): { ok: boolean; registry: DataToolRegistry; codes: string[]; restored?: string; reason?: string } {
  const view = viewRegistry(registry);
  if (!view) return { ok: false, registry, codes: ["DATA_TOOL_INVALID"], reason: "registry 畸形" };
  const key = typeof name === "string" ? name : "";
  const spec = view.data[key];
  if (!spec) return { ok: false, registry, codes: ["DATA_TOOL_UNREGISTERED"], reason: "未注册" };
  const out = cloneRegistry(view);
  delete out.data[key];
  delete out.versions[key];
  const shadow = spec.shadowOf ?? spec.wrapOf;
  const restored = typeof shadow === "string" && shadow.length > 0 ? shadow : undefined;
  if (restored) delete out.degraded[restored];
  return { ok: true, registry: out, codes: ["DATA_TOOL_UNREGISTERED"], restored };
}

function depSatisfied(
  kind: DepKind,
  dep: string,
  available: { binaries: Set<string>; envVars: Set<string>; files: Set<string>; mcpMethods: Set<string> },
): boolean {
  if (kind === "binary") return available.binaries.has(dep);
  if (kind === "env") return available.envVars.has(dep);
  if (kind === "file") return available.files.has(dep);
  return available.mcpMethods.has(dep);
}

/** 依赖体检:缺失即降级(记 missing dep 名),补全即摘降级标记。 */
export function checkDependencies(
  registry: DataToolRegistry,
  env: { binaries?: string[]; envVars?: string[]; files?: string[]; mcpMethods?: string[] },
): {
  registry: DataToolRegistry;
  missing: Array<{ name: string; kind: DepKind; dep: string }>;
  degraded: string[];
  codes: string[];
} {
  const view = viewRegistry(registry);
  if (!view) return { registry, missing: [], degraded: [], codes: ["DATA_TOOL_INVALID"] };
  const envView = isPlainObject(env) ? env : {};
  const available = {
    binaries: new Set(strings(envView.binaries)),
    envVars: new Set(strings(envView.envVars)),
    files: new Set(strings(envView.files)),
    mcpMethods: new Set(strings(envView.mcpMethods)),
  };
  const out = cloneRegistry(view);
  const missing: Array<{ name: string; kind: DepKind; dep: string }> = [];
  const degraded: string[] = [];
  for (const name of Object.keys(view.data).sort()) {
    const spec = view.data[name]!;
    const required = Array.isArray(spec.requires) ? spec.requires : [];
    const absent: string[] = [];
    for (const requirement of required) {
      if (!isPlainObject(requirement)) continue;
      const kind = requirement.kind as DepKind;
      const dep = requirement.name;
      if (typeof dep !== "string" || dep.length === 0) continue;
      if (!DEP_KINDS.includes(kind)) continue;
      if (depSatisfied(kind, dep, available)) continue;
      missing.push({ name, kind, dep });
      absent.push(dep);
    }
    if (absent.length > 0) {
      out.degraded[name] = absent;
      degraded.push(name);
    } else if (out.degraded[name] !== undefined) {
      delete out.degraded[name];
    }
  }
  if (degraded.length === 0) return { registry: out, missing, degraded, codes: [] };
  return { registry: out, missing, degraded, codes: ["DATA_TOOL_DEP_MISSING", "DATA_TOOL_DEGRADED"] };
}

function withDegraded(
  payload: { spec?: DataToolSpec; layer: ToolLayer; codes: string[] },
  degraded: string[] | undefined): { spec?: DataToolSpec; layer: ToolLayer; degraded?: string[]; codes: string[] } {
  return degraded && degraded.length > 0 ? { ...payload, degraded } : payload;
}

/** 解析生效工具:session 钉扎 > 当前 data 版本 > native > 未知。 */
export function resolveTool(
  registry: DataToolRegistry,
  name: string,
  opts?: { sessionPins?: Record<string, Record<string, string>>; sessionId?: string },
): { spec?: DataToolSpec; layer: ToolLayer; degraded?: string[]; codes: string[] } {
  const view = viewRegistry(registry);
  if (!view) return { layer: "native", codes: ["DATA_TOOL_INVALID"] };
  const key = typeof name === "string" ? name : "";
  const sessionId = typeof opts?.sessionId === "string" ? opts.sessionId : undefined;
  const sessionRow = pinsRecord(opts?.sessionPins)[sessionId ?? ""] ?? {};
  const pin = sessionId !== undefined ? (sessionRow[key] ?? view.pins[sessionId]?.[key]) : undefined;
  const history = view.versions[key] ?? [];
  const degraded = view.degraded[key];

  if (pin !== undefined) {
    const pinned = history.find((entry) => entry.version === pin);
    if (pinned) {
      return withDegraded({ spec: pinned, layer: "data", codes: ["DATA_TOOL_PINNED", "DATA_TOOL_RESOLVED"] }, degraded);
    }
    const current = view.data[key];
    if (current) {
      return withDegraded(
        { spec: current, layer: "data", codes: ["DATA_TOOL_PIN_UNKNOWN", "DATA_TOOL_RESOLVED"] },
        degraded);
    }
  }

  const current = view.data[key];
  if (current) return withDegraded({ spec: current, layer: "data", codes: ["DATA_TOOL_RESOLVED"] }, degraded);
  if (view.native.includes(key)) return { layer: "native", codes: ["DATA_TOOL_RESOLVED"] };
  return { layer: "native", codes: ["DATA_TOOL_UNREGISTERED"] };
}

export function pinToolVersion(
  registry: DataToolRegistry,
  sessionId: string,
  name: string,
  version: string): { ok: boolean; pins: Record<string, Record<string, string>>; codes: string[]; reason?: string } {
  const view = viewRegistry(registry);
  if (!view) return { ok: false, pins: {}, codes: ["DATA_TOOL_INVALID"], reason: "registry 畸形" };
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { ok: false, pins: view.pins, codes: ["DATA_TOOL_INVALID"], reason: "sessionId 不能为空" };
  }
  const history = view.versions[name] ?? [];
  if (!view.data[name] || !history.some((entry) => entry.version === version)) {
    return { ok: false, pins: view.pins, codes: ["DATA_TOOL_PIN_UNKNOWN"], reason: `${name}@${version} 不在版本历史里` };
  }
  const pins: Record<string, Record<string, string>> = {};
  for (const key of Object.keys(view.pins)) pins[key] = { ...(view.pins[key] ?? {}) };
  pins[sessionId] = { ...(pins[sessionId] ?? {}), [name]: version };
  return { ok: true, pins, codes: ["DATA_TOOL_PINNED"] };
}

export function listTools(registry: DataToolRegistry): {
  native: string[];
  data: Array<{ name: string; version: string; degraded?: string[]; shadowOf?: string; wrapOf?: string }>;
  plugin: string[];
} {
  const view = viewRegistry(registry);
  if (!view) return { native: [], data: [], plugin: [] };
  const data = Object.keys(view.data)
    .sort()
    .map((name) => {
      const spec = view.data[name]!;
      const entry: { name: string; version: string; degraded?: string[]; shadowOf?: string; wrapOf?: string } = {
        name,
        version: typeof spec.version === "string" ? spec.version : "",
      };
      const degraded = view.degraded[name];
      if (degraded && degraded.length > 0) entry.degraded = [...degraded];
      if (typeof spec.shadowOf === "string" && spec.shadowOf.length > 0) entry.shadowOf = spec.shadowOf;
      if (typeof spec.wrapOf === "string" && spec.wrapOf.length > 0) entry.wrapOf = spec.wrapOf;
      return entry;
    });
  return { native: [...view.native], data, plugin: [...view.plugin] };
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "<unserializable>";
  }
}

function depKey(spec: unknown): string {
  if (!isPlainObject(spec)) return "";
  const requires = spec.requires;
  if (!Array.isArray(requires)) return "";
  const keys = requires
    .filter((entry): entry is Record<string, unknown> => isPlainObject(entry))
    .map((entry) => `${String(entry.kind)}:${String(entry.name)}`)
    .sort();
  return keys.join(",");
}

export function diffVersions(
  a: DataToolSpec,
  b: DataToolSpec): { changed: boolean; schemaChanged: boolean; handlerChanged: boolean; permissionsChanged: boolean; depsChanged: boolean } {
  const left: Record<string, unknown> = isPlainObject(a) ? a : {};
  const right: Record<string, unknown> = isPlainObject(b) ? b : {};
  const schemaChanged = stableJson(left.parameters) !== stableJson(right.parameters);
  const handlerChanged = stableJson(left.handler) !== stableJson(right.handler);
  const permissionsChanged = stableJson(left.permissions) !== stableJson(right.permissions);
  const depsChanged = depKey(left) !== depKey(right);
  const changed = schemaChanged || handlerChanged || permissionsChanged || depsChanged;
  return { changed, schemaChanged, handlerChanged, permissionsChanged, depsChanged };
}
