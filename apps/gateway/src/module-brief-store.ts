/**
 * 模块简报 store(IO 层):把磁盘上的模块身份 / 契约 / 一层依赖 / 公开入口 / 允许边采出来,
 * 交给 runtime 纯逻辑 `buildBrief` 组装成有界简报。语义全在
 * packages/harness-runtime/src/agent/module-brief.ts(纯逻辑,已全绿),本文件只做 IO 与定位。
 * 设计口径:
 * - 定位三态:绝对路径 / 相对 root 的路径 / 包名(packages/*、apps/* 及其下一层 package.json name 反查)。
 *   绝对与相对路径 resolve 后必须落在 root 内(path.relative 判定),越界不抛,返回 BRIEF_INVALID + missing 文本。
 * - arch-policy 自己 JSON.parse(容错缺字段),不走 arch-policy.ts 的 loadPolicyFile —— 后者对未知键报错,口径太紧。
 *   managed/layer/owner 匹配规则:①模块目录在 policy module root 之下(含自身,取最长 root 最具体);
 *   ②否则若 policy module root 在该模块目录之下且唯一,则接受(模块目录是 policy root 的父目录);③都不匹配 → managed=false。
 * - 契约缺失 / owner 缺失 / layer 缺失 / 未托管 / 依赖契约缺失的「码」一律由 buildBrief 产出,store 不重复造码;
 *   store 只把本地采集事实(越界、包名无法解析、arch-policy 缺失、已过滤 N 个外部依赖、入口文件缺失)追加进 missing。
 * - 不 throw 到调用方(参数类型错误除外);不 import agent loop;不写仓库 .genie。
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑模块;runtime 按 store 既有两跳惰性解析:
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

type ModuleBriefRuntime = typeof import("@lampgenie/runtime/agent/module-brief");

/** 复用 runtime 的类型(仅类型面,不引入运行期依赖)。 */
export type ModuleBrief = import("@lampgenie/runtime/agent/module-brief").ModuleBrief;
export type ModuleIdentity = import("@lampgenie/runtime/agent/module-brief").ModuleIdentity;
export type ContractRef = import("@lampgenie/runtime/agent/module-brief").ContractRef;
export type DepRef = import("@lampgenie/runtime/agent/module-brief").DepRef;
export type EntryRef = import("@lampgenie/runtime/agent/module-brief").EntryRef;
export type EntryKind = import("@lampgenie/runtime/agent/module-brief").EntryKind;
export type AllowedEdge = import("@lampgenie/runtime/agent/module-brief").AllowedEdge;
export type BriefResult = import("@lampgenie/runtime/agent/module-brief").BriefResult;

let briefRuntime: ModuleBriefRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadBriefRuntime(): Promise<ModuleBriefRuntime> {
  if (briefRuntime) return briefRuntime;
  const spec = "@lampgenie/runtime/agent/module-brief";
  try {
    briefRuntime = (await import(spec)) as ModuleBriefRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/module-brief.ts", import.meta.url).href;
    briefRuntime = (await import(srcUrl)) as ModuleBriefRuntime;
  }
  return briefRuntime;
}

// ---------------------------------------------------------------- 参数与结果类型

export interface CollectBriefOpts {
  /** 绝对路径 / 相对 root 的路径 / 包名。 */
  module: string;
  maxChars?: number;
  maxDeps?: number;
  maxEntries?: number;
}

/** 定位结果三态:成功 / 越界 / 包名无法解析(后两者 CLI 映射 exit 2)。 */
export type CollectStatus = "ok" | "outside-root" | "unresolved";

export type CollectDetailedResult = BriefResult & { status: CollectStatus };

export interface ModuleBriefCliResult {
  output: string;
  code: number;
}

// ---------------------------------------------------------------- policy 视图(容错)

interface PolicyModuleView {
  id: string;
  root: string;
  layer?: string;
  managed: boolean;
  owner?: string;
  allowImport: string[];
}

interface PolicyLayerView {
  name: string;
  mayImport: string[];
}

interface PolicyView {
  modules: PolicyModuleView[];
  layers: PolicyLayerView[];
}

interface ManifestView {
  name?: string;
  description?: string;
  dependencies: Record<string, string>;
}

interface CollectContext {
  root: string;
  policy?: PolicyView;
  policyMissing: boolean;
  packageIndex: Map<string, string>;
}

const POLICY_REL = [".genie", "arch-policy.json"];
const CONTRACT_FILES = ["CONTRACT.md", "README.md"];
const ENTRY_CANDIDATES = ["src/index.ts", "index.ts"];
const DEP_NAME_PREFIX = "@lampgenie/";
const WORKSPACE_PREFIX = "workspace:";
const SCAN_GROUPS = ["packages", "apps"];
const NESTED_SKIP = new Set(["node_modules", "dist", "src", "test", "tests", "assets", "bin"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function normalizeRel(path: string): string {
  return toPosix(path)
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

/** 相对 root 的 posix 路径;越界返回 undefined。 */
function relInside(root: string, abs: string): string | undefined {
  const rel = relative(root, abs);
  if (rel.length === 0) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return toPosix(rel);
}

function readText(abs: string): string | undefined {
  try {
    if (!existsSync(abs)) return undefined;
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonFile(abs: string): unknown {
  const text = readText(abs);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readManifest(dir: string): ManifestView {
  const raw = readJsonFile(join(dir, "package.json"));
  const manifest: ManifestView = { dependencies: {} };
  if (!isRecord(raw)) return manifest;
  const name = nonEmptyString(raw.name);
  if (name) manifest.name = name;
  const description = nonEmptyString(raw.description);
  if (description) manifest.description = description;
  if (isRecord(raw.dependencies)) {
    for (const [key, value] of Object.entries(raw.dependencies)) {
      if (typeof value === "string") manifest.dependencies[key] = value;
    }
  }
  return manifest;
}

function isDirectory(abs: string): boolean {
  try {
    return readdirSync(abs).length >= 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 包名反查

function buildPackageIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();
  const add = (dir: string): void => {
    const manifest = readManifest(dir);
    if (!manifest.name) return;
    if (!index.has(manifest.name)) index.set(manifest.name, dir);
  };
  for (const group of SCAN_GROUPS) {
    const groupDir = join(root, group);
    if (!isDirectory(groupDir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || NESTED_SKIP.has(entry.name)) continue;
      const level1 = join(groupDir, entry.name);
      add(level1);
      let nested: Dirent[] = [];
      try {
        nested = readdirSync(level1, { withFileTypes: true });
      } catch {
        nested = [];
      }
      for (const sub of nested) {
        if (!sub.isDirectory()) continue;
        if (sub.name.startsWith(".") || NESTED_SKIP.has(sub.name)) continue;
        add(join(level1, sub.name));
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------- policy 读取(容错)

function loadPolicyView(root: string): { policy?: PolicyView; missing: boolean } {
  const file = join(root, POLICY_REL[0] as string, POLICY_REL[1] as string);
  const raw = readJsonFile(file);
  if (!isRecord(raw)) return { missing: true };
  const modules: PolicyModuleView[] = [];
  if (Array.isArray(raw.modules)) {
    for (const item of raw.modules) {
      if (!isRecord(item)) continue;
      const id = nonEmptyString(item.id);
      const modRoot = nonEmptyString(item.root);
      if (!id || !modRoot) continue;
      const view: PolicyModuleView = { id, root: normalizeRel(modRoot), managed: item.managed === true, allowImport: [] };
      const layer = nonEmptyString(item.layer);
      if (layer) view.layer = layer;
      const owner = nonEmptyString(item.owner);
      if (owner) view.owner = owner;
      if (Array.isArray(item.allowImport)) {
        view.allowImport = item.allowImport.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
      }
      modules.push(view);
    }
  }
  const layers: PolicyLayerView[] = [];
  if (Array.isArray(raw.layers)) {
    for (const item of raw.layers) {
      if (!isRecord(item)) continue;
      const name = nonEmptyString(item.name);
      if (!name) continue;
      const mayImport = Array.isArray(item.mayImport)
        ? item.mayImport.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
      layers.push({ name, mayImport });
    }
  }
  return { policy: { modules, layers }, missing: false };
}

/**
 * policy module 匹配:①模块目录在 policy root 之下(含相等)→ 取最长 root(最具体),同长取 id 字典序;
 * ②否则 policy root 在模块目录之下且唯一 → 接受;③否则不匹配。
 */
function matchPolicyModule(policy: PolicyView | undefined, moduleRel: string | undefined): PolicyModuleView | undefined {
  if (!policy || moduleRel === undefined) return undefined;
  const target = normalizeRel(moduleRel);
  if (target.length === 0 || target === ".") return undefined;
  const inside: { mod: PolicyModuleView; root: string }[] = [];
  const enclosing: { mod: PolicyModuleView; root: string }[] = [];
  for (const mod of policy.modules) {
    const modRoot = mod.root;
    if (modRoot.length === 0) continue;
    if (target === modRoot || target.startsWith(`${modRoot}/`)) inside.push({ mod, root: modRoot });
    else if (modRoot.startsWith(`${target}/`)) enclosing.push({ mod, root: modRoot });
  }
  const pool = inside.length > 0 ? inside : enclosing.length === 1 ? enclosing : [];
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => b.root.length - a.root.length || a.mod.id.localeCompare(b.mod.id));
  return pool[0]?.mod;
}

// ---------------------------------------------------------------- 契约 / 入口采集

function findContractRef(root: string, dir: string): ContractRef | undefined {
  const runtimeReady = briefRuntime;
  for (const name of CONTRACT_FILES) {
    const abs = join(dir, name);
    const text = readText(abs);
    if (text === undefined) continue;
    const ref: ContractRef = { present: true };
    const rel = relInside(root, abs);
    if (rel !== undefined) ref.path = rel;
    const summary = runtimeReady ? runtimeReady.summarizeContract(text) : undefined;
    if (summary) ref.summary = summary;
    return ref;
  }
  return undefined;
}

function declKind(keyword: string): EntryKind {
  if (keyword === "function") return "function";
  if (keyword === "class") return "class";
  if (keyword === "const" || keyword === "let" || keyword === "var") return "const";
  return "export";
}

const RE_STAR_EXPORT = /^\s*export\s+\*\s+from\s+["']([^"']+)["']/;
const RE_NAMED_EXPORT = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;
const RE_DECL_EXPORT = /^\s*export\s+(?:async\s+)?(function|class|const|let|var|type|interface)\s+([A-Za-z_$][\w$]*)/;

/** 行级解析公开入口:只取名字与行号,绝不复制实现。 */
function parseEntries(root: string, dir: string): { entries: EntryRef[]; file?: string } {
  for (const candidate of ENTRY_CANDIDATES) {
    const abs = join(dir, candidate);
    const text = readText(abs);
    if (text === undefined) continue;
    const rel = relInside(root, abs) ?? candidate;
    const entries: EntryRef[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineNo = i + 1;
      const star = RE_STAR_EXPORT.exec(line);
      if (star) {
        entries.push({ file: rel, line: lineNo, symbol: `* from ${star[1] ?? ""}`, kind: "export" });
        continue;
      }
      const named = RE_NAMED_EXPORT.exec(line);
      if (named) {
        for (const raw of (named[1] ?? "").split(",")) {
          const cleaned = raw.trim().replace(/^type\s+/, "");
          if (cleaned.length === 0) continue;
          const alias = cleaned.split(/\s+as\s+/).pop()?.trim() ?? cleaned;
          if (!/^[A-Za-z_$][\w$]*$/.test(alias)) continue;
          entries.push({ file: rel, line: lineNo, symbol: alias, kind: "export" });
        }
        continue;
      }
      const decl = RE_DECL_EXPORT.exec(line);
      if (decl) {
        entries.push({ file: rel, line: lineNo, symbol: decl[2] ?? "", kind: declKind(decl[1] ?? "") });
      }
    }
    return { entries, file: rel };
  }
  return { entries: [] };
}

// ---------------------------------------------------------------- 依赖采集

function isWorkspaceDep(name: string, version: string): boolean {
  return version.startsWith(WORKSPACE_PREFIX) || name.startsWith(DEP_NAME_PREFIX);
}

interface DepCollection {
  deps: DepRef[];
  droppedExternal: number;
  unresolved: string[];
}

function collectDeps(
  ctx: CollectContext,
  manifest: ManifestView,
  ownerModule: PolicyModuleView | undefined): DepCollection {
  const deps: DepRef[] = [];
  const unresolved: string[] = [];
  let droppedExternal = 0;
  const names = Object.keys(manifest.dependencies).sort((a, b) => a.localeCompare(b));
  for (const depName of names) {
    const version = manifest.dependencies[depName] ?? "";
    if (!isWorkspaceDep(depName, version)) {
      droppedExternal += 1;
      continue;
    }
    const depDir = ctx.packageIndex.get(depName);
    const depManifest = depDir ? readManifest(depDir) : { dependencies: {} };
    const depRel = depDir ? relInside(ctx.root, depDir) : undefined;
    const contract = depDir ? findContractRef(ctx.root, depDir) : undefined;
    const depModule = matchPolicyModule(ctx.policy, depRel);
    const ref: DepRef = { name: depName, contractPresent: contract !== undefined };
    if (depRel !== undefined) ref.path = depRel;
    const pkgName = depManifest.name ?? (depName.startsWith(DEP_NAME_PREFIX) ? depName : undefined);
    if (pkgName) ref.packageName = pkgName;
    if (depManifest.description) ref.description = depManifest.description;
    if (depModule?.layer) ref.layer = depModule.layer;
    const allowedEdge = resolveAllowedEdge(ctx.policy, ownerModule, depModule);
    if (allowedEdge !== undefined) ref.allowedEdge = allowedEdge;
    deps.push(ref);
    if (!depDir) unresolved.push(depName);
  }
  return { deps, droppedExternal, unresolved };
}

/** 允许边:①模块 layer 的 layers.mayImport 含 dep layer;②模块 policy module 的 allowImport 含 dep module id。 */
function resolveAllowedEdge(
  policy: PolicyView | undefined,
  ownerModule: PolicyModuleView | undefined,
  depModule: PolicyModuleView | undefined): boolean | undefined {
  if (!policy || !ownerModule) return undefined;
  if (ownerModule.allowImport.length > 0 && depModule && ownerModule.allowImport.includes(depModule.id)) return true;
  if (!depModule?.layer || !ownerModule.layer) return undefined;
  const layer = policy.layers.find((item) => item.name === ownerModule.layer);
  if (!layer) return undefined;
  return layer.mayImport.includes(depModule.layer);
}

/** 允许边展开:from=模块名,to=本模块 layer 允许的层名。 */
function expandAllowedEdges(policy: PolicyView | undefined, ownerModule: PolicyModuleView | undefined, from: string): AllowedEdge[] {
  if (!policy || !ownerModule?.layer) return [];
  const layer = policy.layers.find((item) => item.name === ownerModule.layer);
  if (!layer) return [];
  return layer.mayImport.map((to) => ({ from, to, reason: `layers.mayImport(${ownerModule.layer ?? ""})` }));
}

// ---------------------------------------------------------------- 模块定位

interface LocatedModule {
  dir?: string;
  status: CollectStatus;
  missing?: string;
}

function locateModule(ctx: CollectContext, module: string): LocatedModule {
  const raw = module.trim();
  if (raw.length === 0) return { status: "unresolved", missing: "无法解析包名:<空>" };
  const looksLikePath = isAbsolute(raw) || raw.startsWith("./") || raw.startsWith("../") || raw.includes("/") || raw.includes("\\");
  const candidates: string[] = [];
  if (isAbsolute(raw)) candidates.push(resolvePath(raw));
  else if (looksLikePath) candidates.push(resolvePath(ctx.root, raw));

  if (isAbsolute(raw)) {
    const abs = resolvePath(raw);
    if (relInside(ctx.root, abs) === undefined) return { status: "outside-root", missing: `模块路径不在 root 内:${raw}` };
    return { dir: abs, status: "ok" };
  }
  for (const candidate of candidates) {
    if (relInside(ctx.root, candidate) === undefined) return { status: "outside-root", missing: `模块路径不在 root 内:${raw}` };
    if (isDirectory(candidate)) return { dir: candidate, status: "ok" };
  }
  const byName = ctx.packageIndex.get(raw);
  if (byName) return { dir: byName, status: "ok" };
  return { status: "unresolved", missing: `无法解析包名:${raw}` };
}

function resolveRoot(root: string): string {
  return resolvePath(root);
}

// ---------------------------------------------------------------- 主流程

/**
 * 采集并组装模块简报(带定位状态;CLI 用它决定 exit 码)。
 * 除参数类型错误外不 throw。
 */
export async function collectBriefDetailed(root: string, opts: CollectBriefOpts): Promise<CollectDetailedResult> {
  if (typeof root !== "string" || root.trim().length === 0) throw new TypeError("collectBrief: root 必须是非空字符串");
  const runtime = await loadBriefRuntime();
  const absRoot = resolveRoot(root);
  const moduleArg = isRecord(opts) ? opts.module : undefined;
  if (typeof moduleArg !== "string") {
    const built = runtime.buildBrief({ identity: { name: "", path: "" } }, {});
    return { ...built, status: "unresolved" };
  }

  const policyView = loadPolicyView(absRoot);
  const ctx: CollectContext = {
    root: absRoot,
    packageIndex: buildPackageIndex(absRoot),
    policyMissing: policyView.missing,
  };
  if (policyView.policy) ctx.policy = policyView.policy;

  const located = locateModule(ctx, moduleArg);
  if (located.status !== "ok" || !located.dir) {
    const built = runtime.buildBrief({ identity: { name: "", path: "" } }, {});
    const storeMissing = [located.missing ?? "无法解析模块"];
    appendStoreMissing(built.brief, storeMissing);
    return { brief: built.brief, codes: built.codes, status: located.status };
  }

  const moduleDir = located.dir;
  const moduleRel = relInside(absRoot, moduleDir) ?? toPosix(moduleDir);
  const manifest = readManifest(moduleDir);
  const ownerModule = matchPolicyModule(ctx.policy, moduleRel);
  const storeMissing: string[] = [];
  if (ctx.policyMissing) storeMissing.push("arch-policy 缺失");

  const identity: Partial<ModuleIdentity> = {
    name: basename(moduleDir),
    path: moduleRel === "." ? toPosix(moduleDir) : moduleRel,
    managed: ownerModule?.managed === true,
  };
  if (manifest.name) identity.packageName = manifest.name;
  if (manifest.description) identity.description = manifest.description;
  if (ownerModule?.owner) identity.owner = ownerModule.owner;
  if (ownerModule?.layer) identity.layer = ownerModule.layer;

  const contract = findContractRef(absRoot, moduleDir) ?? { present: false };

  const depCollection = collectDeps(ctx, manifest, ownerModule);
  for (const name of depCollection.unresolved) storeMissing.push(`依赖目录未解析:${name}`);
  if (depCollection.droppedExternal > 0) storeMissing.push(`已过滤 ${depCollection.droppedExternal} 个外部依赖`);

  const parsedEntries = parseEntries(absRoot, moduleDir);
  if (parsedEntries.file === undefined) storeMissing.push("入口文件缺失(src/index.ts|index.ts)");

  const allowedEdges = expandAllowedEdges(ctx.policy, ownerModule, identity.name ?? basename(moduleDir));

  const built = runtime.buildBrief(
    {
      identity,
      contract,
      deps: depCollection.deps,
      entries: parsedEntries.entries,
      allowedEdges,
    },
    { maxChars: opts.maxChars, maxDeps: opts.maxDeps, maxEntries: opts.maxEntries },
  );
  appendStoreMissing(built.brief, storeMissing);
  return { brief: built.brief, codes: built.codes, status: "ok" };
}

/** 追加 store 侧缺失文本到 missing,并同步 rendered / chars(chars === rendered.length 恒成立)。 */
function appendStoreMissing(brief: ModuleBrief, texts: string[]): void {
  if (texts.length === 0) return;
  brief.missing.push(...texts);
  const block = texts.map((text) => `- ${text}`).join("\n");
  brief.rendered = `${brief.rendered}\n\n## 本地采集补充\n${block}`;
  brief.chars = brief.rendered.length;
}

/** 采集模块简报(只要 brief)。 */
export async function collectBrief(root: string, opts: CollectBriefOpts): Promise<ModuleBrief> {
  const result = await collectBriefDetailed(root, opts);
  return result.brief;
}

/** 采集模块简报(要 brief + 码)。 */
export async function collectBriefResult(root: string, opts: CollectBriefOpts): Promise<BriefResult> {
  const result = await collectBriefDetailed(root, opts);
  return { brief: result.brief, codes: result.codes };
}

// ---------------------------------------------------------------- CLI 逻辑

const USAGE = [
  "用法:module-brief --module <path|pkg> [--root <dir>] [--json] [--out <file>] [--max-chars n] [--max-deps n] [--max-entries n]",
  "",
  "  --root <dir>       仓库根(默认 process.cwd())",
  "  --module <path|pkg> 模块的绝对路径 / 相对 root 路径 / 包名(必填)",
  "  --json             输出 JSON(identity/contract/deps/entries/allowedEdges/missing/chars/codes)",
  "  --out <file>       把输出写到指定文件(仅显式给出时写盘)",
  "  --max-chars n      简报字符上限",
  "  --max-deps n       依赖条数上限",
  "  --max-entries n    入口条数上限",
  "  --help             显示本帮助",
  "",
  "退出码:0 成功 / 1 参数错 / 2 模块不在 root 内或包名无法解析",
].join("\n");

interface ParsedArgs {
  help: boolean;
  json: boolean;
  root?: string;
  module?: string;
  out?: string;
  maxChars?: number;
  maxDeps?: number;
  maxEntries?: number;
  error?: string;
}

const NUMERIC_FLAGS: Record<string, "maxChars" | "maxDeps" | "maxEntries"> = {
  "--max-chars": "maxChars",
  "--max-deps": "maxDeps",
  "--max-entries": "maxEntries",
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--root" || arg === "--module" || arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ...parsed, error: `参数缺少取值:${arg}` };
      i += 1;
      if (arg === "--root") parsed.root = value;
      else if (arg === "--module") parsed.module = value;
      else parsed.out = value;
      continue;
    }
    const numericKey = NUMERIC_FLAGS[arg];
    if (numericKey) {
      const value = argv[i + 1];
      if (value === undefined) return { ...parsed, error: `参数缺少取值:${arg}` };
      const parsedNumber = Number(value);
      if (!Number.isFinite(parsedNumber) || parsedNumber < 0) {
        return { ...parsed, error: `参数取值非法:${arg} ${value}` };
      }
      i += 1;
      parsed[numericKey] = Math.floor(parsedNumber);
      continue;
    }
    return { ...parsed, error: `未知参数:${arg}` };
  }
  return parsed;
}

/**
 * CLI 逻辑(便于单测):解析参数 → 采集 → 渲染 stdout 文本 → 可选写盘 → 退出码。
 * 默认输出 brief.rendered;--json 输出结构化 JSON(不含 rendered)。
 */
export async function runModuleBriefCli(argv: string[], cwd: string): Promise<ModuleBriefCliResult> {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = parseArgs(args);
  if (parsed.error) return { output: `${parsed.error}\n\n${USAGE}`, code: 1 };
  if (parsed.help) return { output: USAGE, code: 0 };
  if (!parsed.module || parsed.module.trim().length === 0) return { output: `参数错误:缺少 --module\n\n${USAGE}`, code: 1 };

  const root = resolvePath(typeof cwd === "string" && cwd.length > 0 ? cwd : ".", parsed.root ?? ".");
  const opts: CollectBriefOpts = { module: parsed.module };
  if (parsed.maxChars !== undefined) opts.maxChars = parsed.maxChars;
  if (parsed.maxDeps !== undefined) opts.maxDeps = parsed.maxDeps;
  if (parsed.maxEntries !== undefined) opts.maxEntries = parsed.maxEntries;

  const result = await collectBriefDetailed(root, opts);
  const { brief, codes } = result;
  let output: string;
  if (parsed.json) {
    output = JSON.stringify(
      {
        identity: brief.identity,
        contract: brief.contract,
        deps: brief.deps,
        entries: brief.entries,
        allowedEdges: brief.allowedEdges,
        missing: brief.missing,
        chars: brief.chars,
        codes,
      },
      null,
      2);
  } else {
    output = brief.rendered;
  }

  if (parsed.out) {
    try {
      writeFileSync(resolvePath(root, parsed.out), `${output}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `写出失败:${parsed.out}(${message})`, code: 1 };
    }
  }

  return { output, code: result.status === "ok" ? 0 : 2 };
}
