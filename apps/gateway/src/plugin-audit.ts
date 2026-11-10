/**
 * 插件清单 ABI 校验 / 能力白名单 / 授权指纹(consent hash)/ 安装审计 / kill list。
 * 纯函数模块(零 IO、零依赖,唯一实现):plugins.ts 只做接线,便于单测与外部复用。
 * 设计要点(fail-closed):
 * - 清单结构错了就拒装(PLUGIN_ABI_INVALID),不写任何资产;
 * - componentTypes 出现白名单外的组件类型即拒装(PLUGIN_CAPABILITY_UNKNOWN);
 * - ui/hook 合法但「运行时无宿主」→ 审计行 status=unsupported(reason=unsupported-runtime);
 * - consentHash = 声明集(版本 + 各类资产名)的规范化 sha256 前 32 位:清单静默变更
 *   (加命令/改版本)会让指纹变化,加载态据此置 needs-consent;
 * - kill list 是运维兜底(JSON 坏=空,不阻断正常安装)。
 */
import { createHash } from "node:crypto";

// ── 稳定错误码 ─────────────────────────────────────────────

export const PLUGIN_ABI_INVALID = "PLUGIN_ABI_INVALID";
export const PLUGIN_CAPABILITY_UNKNOWN = "PLUGIN_CAPABILITY_UNKNOWN";
export const PLUGIN_UNPINNED = "PLUGIN_UNPINNED";
export const PLUGIN_KILLED = "PLUGIN_KILLED";
export const PLUGIN_CONSENT_REQUIRED = "PLUGIN_CONSENT_REQUIRED";

// ── 类型 ──────────────────────────────────────────────────

export interface AbiIssue { path: string; message: string }

export interface AuditAsset {
  kind: "command" | "agent" | "mcp" | "skill" | "ui" | "hook";
  name: string;
  status: "ok" | "unsupported" | "skipped" | "degraded";
  reason?: string;
}

export interface PluginAudit {
  id: string;
  version: string;
  assets: AuditAsset[];
  ok: boolean;
}

export interface KillEntry { id: string; version?: string; reason?: string }

/** 清单声明集(consent hash 的规范化输入)。 */
export interface DeclaredSet {
  version: string;
  commands: string[];
  agents: string[];
  mcp: string[];
  skills: string[];
}

// ── 结构白名单 ────────────────────────────────────────────

/** 顶层允许键(ABI 面)。 */
const TOP_KEYS = new Set([
  "id", "name", "description", "version", "author", "category",
  "source", "componentTypes", "icon", "provides",
]);
/** 目录元数据键(user catalog 的 pin 输入):容忍但不参与 ABI。 */
const TOLERATED_KEYS = new Set(["uid", "url", "zip", "sha256"]);
const REQUIRED_STRINGS = ["id", "name", "description", "version", "author", "category"] as const;
const SOURCES = new Set(["builtin", "official", "user"]);

/** 能力 id 白名单(插件可声明的运行时能力)。 */
export const PLUGIN_CAPABILITIES = ["command", "agent", "mcp", "skill"] as const;
/** componentTypes 允许集合:ui/hook 合法,但运行时无宿主(审计 unsupported)。 */
const ALLOWED_COMPONENT_TYPES = new Set(["skill", "command", "agent", "mcp", "hook", "ui"]);
/** 无运行时宿主的组件类型。 */
const RUNTIME_UNSUPPORTED = new Set(["ui", "hook"]);

interface AssetSpec {
  required: string[];
  optional: Record<string, (v: unknown) => boolean>;
}

const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

/** provides 的资产类型 → 审计 kind 与字段形状。 */
const ASSET_SPECS: Record<string, AssetSpec & { kind: AuditAsset["kind"] }> = {
  commands: { kind: "command", required: ["name", "body"], optional: {} },
  agents: { kind: "agent", required: ["name", "description", "systemPrompt"], optional: { tools: isStringArray } },
  mcp: { kind: "mcp", required: ["name", "command"], optional: { args: isStringArray } },
  skills: { kind: "skill", required: ["name", "description", "body"], optional: {} },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateAsset(item: unknown, path: string, spec: AssetSpec, issues: AbiIssue[]): void {
  if (!isObj(item)) { issues.push({ path, message: "必须是对象" }); return; }
  const known = new Set([...spec.required, ...Object.keys(spec.optional)]);
  for (const k of Object.keys(item)) {
    if (!known.has(k)) issues.push({ path: `${path}.${k}`, message: "未知字段" });
  }
  for (const k of spec.required) {
    const v = item[k];
    if (v === undefined) issues.push({ path: `${path}.${k}`, message: "缺少必填字段" });
    else if (typeof v !== "string") issues.push({ path: `${path}.${k}`, message: "必须是字符串" });
  }
  for (const [k, check] of Object.entries(spec.optional)) {
    const v = item[k];
    if (v !== undefined && !check(v)) issues.push({ path: `${path}.${k}`, message: "类型不符" });
  }
}

/**
 * 清单 ABI 校验:一次收集全部 issues(不短路)。
 * 通过 → {ok:true};否则 → {ok:false, code:"PLUGIN_ABI_INVALID", issues}。
 */
export function validateManifest(m: unknown): { ok: true } | { ok: false; code: typeof PLUGIN_ABI_INVALID; issues: AbiIssue[] } {
  const issues: AbiIssue[] = [];
  if (!isObj(m)) {
    return { ok: false, code: PLUGIN_ABI_INVALID, issues: [{ path: "", message: "清单必须是对象" }] };
  }
  for (const k of Object.keys(m)) {
    if (!TOP_KEYS.has(k) && !TOLERATED_KEYS.has(k)) issues.push({ path: k, message: "未知顶层键" });
  }
  for (const k of REQUIRED_STRINGS) {
    const v = m[k];
    if (v === undefined) issues.push({ path: k, message: "缺少必填字段" });
    else if (typeof v !== "string") issues.push({ path: k, message: "必须是字符串" });
  }
  const source = m.source;
  if (source !== undefined && (typeof source !== "string" || !SOURCES.has(source))) {
    issues.push({ path: "source", message: "必须是 builtin/official/user 之一" });
  }
  const ct = m.componentTypes;
  if (ct !== undefined) {
    if (!Array.isArray(ct)) issues.push({ path: "componentTypes", message: "必须是字符串数组" });
    else if (!isStringArray(ct)) issues.push({ path: "componentTypes", message: "必须是字符串数组" });
  }
  const icon = m.icon;
  if (icon !== undefined && typeof icon !== "string") issues.push({ path: "icon", message: "必须是字符串" });

  const p = m.provides;
  if (p === undefined) issues.push({ path: "provides", message: "缺少必填字段" });
  else if (!isObj(p)) issues.push({ path: "provides", message: "必须是对象" });
  else {
    for (const k of Object.keys(p)) {
      if (!(k in ASSET_SPECS)) issues.push({ path: `provides.${k}`, message: "未知资产类型" });
    }
    for (const [k, spec] of Object.entries(ASSET_SPECS)) {
      const arr = p[k];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) { issues.push({ path: `provides.${k}`, message: "必须是数组" }); continue; }
      arr.forEach((item, i) => validateAsset(item, `provides.${k}[${i}]`, spec, issues));
    }
  }
  return issues.length ? { ok: false, code: PLUGIN_ABI_INVALID, issues } : { ok: true };
}

/**
 * 能力校验:componentTypes 出现白名单外值 → PLUGIN_CAPABILITY_UNKNOWN。
 * ui/hook 合法(运行时 unsupported,见审计表)。
 */
export function checkCapabilities(m: unknown): { ok: true } | { ok: false; code: typeof PLUGIN_CAPABILITY_UNKNOWN; unknown: string[] } {
  const raw = isObj(m) && Array.isArray(m.componentTypes) ? m.componentTypes : [];
  const unknown: string[] = [];
  for (const t of raw) {
    const id = typeof t === "string" ? t : String(t);
    if (typeof t !== "string" || !ALLOWED_COMPONENT_TYPES.has(t)) {
      if (!unknown.includes(id)) unknown.push(id);
    }
  }
  return unknown.length ? { ok: false, code: PLUGIN_CAPABILITY_UNKNOWN, unknown } : { ok: true };
}

function assetNames(m: unknown, key: keyof typeof ASSET_SPECS): string[] {
  if (!isObj(m) || !isObj(m.provides)) return [];
  const arr = m.provides[key];
  if (!Array.isArray(arr)) return [];
  const names = arr
    .map((it) => (isObj(it) && typeof it.name === "string" ? it.name : undefined))
    .filter((n): n is string => typeof n === "string");
  return names.sort();
}

/** 声明集(规范化:各类资产名排序,固定键序 version→commands→agents→mcp→skills)。 */
export function declaredSet(m: unknown): DeclaredSet {
  const version = isObj(m) && typeof m.version === "string" ? m.version : "";
  return {
    version,
    commands: assetNames(m, "commands"),
    agents: assetNames(m, "agents"),
    mcp: assetNames(m, "mcp"),
    skills: assetNames(m, "skills"),
  };
}

/** 授权指纹:声明集 canonical JSON 的 sha256 hex 前 32 位。 */
export function consentHash(m: unknown): string {
  return createHash("sha256").update(JSON.stringify(declaredSet(m))).digest("hex").slice(0, 32);
}

/**
 * 安装审计表:
 * - 静态(无 outcomes):provides 每项一行 status=ok;
 * - componentTypes 含 ui/hook:追加 unsupported 行(reason=unsupported-runtime);
 * - 传 outcomes 时以 outcomes 为准合并覆盖(按 kind+name 覆盖同名行,其余追加)。
 * ok = 全部资产 status==="ok"(空资产视为 ok)。
 */
export function buildPluginAudit(m: unknown, outcomes?: AuditAsset[]): PluginAudit {
  const id = isObj(m) && typeof m.id === "string" ? m.id : "";
  const version = isObj(m) && typeof m.version === "string" ? m.version : "";
  const assets: AuditAsset[] = [];
  if (isObj(m) && isObj(m.provides)) {
    for (const [key, spec] of Object.entries(ASSET_SPECS)) {
      const arr = m.provides[key];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const name = isObj(it) && typeof it.name === "string" ? it.name : "";
        assets.push({ kind: spec.kind, name, status: "ok" });
      }
    }
  }
  const types = isObj(m) && Array.isArray(m.componentTypes) ? m.componentTypes : [];
  for (const t of types) {
    if (typeof t !== "string" || !RUNTIME_UNSUPPORTED.has(t)) continue;
    const kind = t as "ui" | "hook";
    if (assets.some((a) => a.kind === kind)) continue;
    assets.push({ kind, name: "(runtime)", status: "unsupported", reason: "unsupported-runtime" });
  }
  for (const o of outcomes ?? []) {
    const idx = assets.findIndex((a) => a.kind === o.kind && a.name === o.name);
    if (idx >= 0) assets[idx] = o;
    else assets.push(o);
  }
  return { id, version, assets, ok: assets.every((a) => a.status === "ok") };
}

/** kill list 解析:JSON 坏/非数组 → [](运维兜底不阻断安装)。 */
export function parseKillList(text: string | null | undefined): KillEntry[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: KillEntry[] = [];
  for (const e of raw) {
    if (!isObj(e) || typeof e.id !== "string") continue;
    const entry: KillEntry = { id: e.id };
    if (typeof e.version === "string") entry.version = e.version;
    if (typeof e.reason === "string") entry.reason = e.reason;
    out.push(entry);
  }
  return out;
}

/** 命中判断:entry.version 缺省=任意版本,否则精确相等。 */
export function isKilled(entries: KillEntry[], id: string, version: string): KillEntry | undefined {
  return entries.find((e) => e.id === id && (e.version === undefined || e.version === version));
}
