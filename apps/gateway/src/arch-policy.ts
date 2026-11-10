/**
 * 架构策略门(M2):唯一 policy 文件 + managed 入座 + 跨层边 + 公开入口 + 内容指纹 baseline ratchet。
 *
 * 设计口径:
 * - policy 是唯一真源(.genie/arch-policy.json,version=1);结构规则只对 managed 模块生效。
 * - 判据是纯函数(scanPolicy/parsePolicy/ratchet),CLI 与测试共用同一套语义,零外部依赖(仅 node 内建)。
 * - baseline 用内容指纹 ratchet:只有 --update 能写,指纹 = sha256(rule + file + 规范化 detail) 前 16 位。
 * - --changed 按 base/upstream merge-base 选基线,选不到就降级全量检查并在 note 里明说(不静默当干净)。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, posix, relative, resolve as resolvePath, sep } from "node:path";

// ---------------------------------------------------------------- 稳定 rule 名

export const RULE_UNMANAGED = "unmanaged-new-file";
export const RULE_CROSS_LAYER = "cross-layer-import";
export const RULE_DEEP_IMPORT = "deep-import";
export const RULES = [RULE_UNMANAGED, RULE_CROSS_LAYER, RULE_DEEP_IMPORT] as const;
export type Rule = (typeof RULES)[number];

// ---------------------------------------------------------------- 类型

export interface PolicyModule {
  id: string;
  /** 仓内相对目录(glob 由 policy 作者手工展开,这里只支持目录/文件前缀) */
  root: string;
  layer: string;
  managed: boolean;
  /** 公开入口(仓内相对文件或目录);跨模块导入必须命中它 */
  entry?: string;
  /** 允许边白名单:目标 module id(优先于 layer 规则) */
  allowImport?: string[];
}

export interface PolicyLayer {
  name: string;
  mayImport: string[];
}

export interface PolicyException {
  id: string;
  rule: Rule;
  /** 仓内相对 glob;** 与 * 受支持 */
  files?: string[];
  reason: string;
  owner: string;
  expires: string;
}

export interface Policy {
  version: 1;
  modules: PolicyModule[];
  layers: PolicyLayer[];
  exceptions: PolicyException[];
  /** 可选:仓内相对 glob,命中的文件完全跳过(测试目录/草稿不入架构面);默认空 */
  ignore?: string[];
}

export interface Violation {
  rule: Rule;
  file: string;
  line?: number;
  /** 规范化 detail(不含行号):同一 detail 的反复出现不会 churn 基线 */
  detail: string;
  /** sha256(rule + file + detail) 前 16 位 */
  hash: string;
  message: string;
}

export interface ExpiredException {
  id: string;
  rule: string;
  expires: string;
  reason: string;
}

export interface ExemptedHit {
  rule: Rule;
  file: string;
  exceptionId: string;
}

export interface ScanResult {
  violations: Violation[];
  expiredExceptions: ExpiredException[];
  exempted: ExemptedHit[];
  checkedFiles: string[];
  notes: string[];
}

export interface BaselineEntry {
  rule: string;
  file: string;
  detailHash: string;
}

export interface Baseline {
  version: 1;
  generatedAt: string;
  entries: BaselineEntry[];
}

export interface PolicyError {
  path: string;
  message: string;
}

// ---------------------------------------------------------------- policy 解析/校验

const POLICY_KEYS = new Set(["$schema", "version", "modules", "layers", "exceptions", "ignore"]);
const MODULE_KEYS = new Set(["id", "root", "layer", "managed", "entry", "allowImport"]);
const LAYER_KEYS = new Set(["name", "mayImport"]);
const EXCEPTION_KEYS = new Set(["id", "rule", "files", "reason", "owner", "expires"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: PolicyError[],
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push({ path: `${path}.${k}`, message: "未知键(unknown key)" });
  }
}

function checkRelPath(value: unknown, path: string, errors: PolicyError[]): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: "必须是非空字符串路径" });
    return false;
  }
  const p = value.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    errors.push({ path, message: "必须是仓内相对路径(不能是绝对路径)" });
    return false;
  }
  if (p.split("/").some((seg) => seg === "..")) {
    errors.push({ path, message: "不能包含 ..(必须留在仓内)" });
    return false;
  }
  return true;
}

function checkStringArray(value: unknown, path: string, errors: PolicyError[]): value is string[] {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || x.trim() === "")) {
    errors.push({ path, message: "必须是非空字符串数组" });
    return false;
  }
  return true;
}

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 校验 policy 原始对象(已 JSON.parse)。返回 errors 时调用方应 exit 3;errors 带路径。 */
export function parsePolicy(raw: unknown): { policy?: Policy; errors: PolicyError[] } {
  const errors: PolicyError[] = [];
  if (!isPlainObject(raw)) return { errors: [{ path: "policy", message: "必须是 JSON 对象" }] };

  checkUnknownKeys(raw, POLICY_KEYS, "policy", errors);
  if (raw.version !== 1) errors.push({ path: "policy.version", message: `必须为 1(实际 ${JSON.stringify(raw.version)})` });

  let ignore: string[] | undefined;
  if (raw.ignore !== undefined) {
    if (checkStringArray(raw.ignore, "policy.ignore", errors)) ignore = [...(raw.ignore as string[])];
  }

  // layers
  const layers: PolicyLayer[] = [];
  if (!Array.isArray(raw.layers)) {
    errors.push({ path: "policy.layers", message: "必须是数组" });
  } else {
    raw.layers.forEach((item, i) => {
      const path = `policy.layers[${i}]`;
      if (!isPlainObject(item)) return errors.push({ path, message: "必须是对象" }) as unknown as void;
      checkUnknownKeys(item, LAYER_KEYS, path, errors);
      if (typeof item.name !== "string" || item.name.trim() === "") {
        errors.push({ path: `${path}.name`, message: "必须是非空字符串" });
        return;
      }
      if (!checkStringArray(item.mayImport, `${path}.mayImport`, errors)) return;
      if (layers.some((l) => l.name === item.name)) errors.push({ path: `${path}.name`, message: "layer 名重复" });
      layers.push({ name: item.name, mayImport: [...item.mayImport] });
    });
  }
  const layerNames = new Set(layers.map((l) => l.name));

  // modules
  const modules: PolicyModule[] = [];
  if (!Array.isArray(raw.modules) || raw.modules.length === 0) {
    errors.push({ path: "policy.modules", message: "必须是非空数组" });
  } else {
    raw.modules.forEach((item, i) => {
      const path = `policy.modules[${i}]`;
      if (!isPlainObject(item)) return errors.push({ path, message: "必须是对象" }) as unknown as void;
      checkUnknownKeys(item, MODULE_KEYS, path, errors);
      if (typeof item.id !== "string" || item.id.trim() === "") {
        errors.push({ path: `${path}.id`, message: "必须是非空字符串" });
        return;
      }
      if (modules.some((m) => m.id === item.id)) errors.push({ path: `${path}.id`, message: "module id 重复" });
      const rootOk = checkRelPath(item.root, `${path}.root`, errors);
      let layerOk = true;
      if (typeof item.layer !== "string" || item.layer.trim() === "") {
        errors.push({ path: `${path}.layer`, message: "必须是非空字符串" });
        layerOk = false;
      } else if (layerNames.size > 0 && !layerNames.has(item.layer)) {
        errors.push({ path: `${path}.layer`, message: `未在 layers 中声明:${item.layer}` });
        layerOk = false;
      }
      if (typeof item.managed !== "boolean") errors.push({ path: `${path}.managed`, message: "必须是 boolean" });
      const entryOk = item.entry === undefined ? true : checkRelPath(item.entry, `${path}.entry`, errors);
      const allowOk = item.allowImport === undefined ? true : checkStringArray(item.allowImport, `${path}.allowImport`, errors);
      if (!rootOk || !layerOk || typeof item.managed !== "boolean" || !entryOk || !allowOk) return;
      const mod: PolicyModule = {
        id: item.id,
        root: normalizeRoot(item.root as string),
        layer: item.layer as string,
        managed: item.managed as boolean,
      };
      if (typeof item.entry === "string") mod.entry = normalizeRoot(item.entry);
      if (Array.isArray(item.allowImport)) mod.allowImport = [...(item.allowImport as string[])];
      modules.push(mod);
    });
  }

  // exceptions
  const exceptions: PolicyException[] = [];
  if (raw.exceptions !== undefined && !Array.isArray(raw.exceptions)) {
    errors.push({ path: "policy.exceptions", message: "必须是数组" });
  } else if (Array.isArray(raw.exceptions)) {
    raw.exceptions.forEach((item, i) => {
      const path = `policy.exceptions[${i}]`;
      if (!isPlainObject(item)) return errors.push({ path, message: "必须是对象" }) as unknown as void;
      checkUnknownKeys(item, EXCEPTION_KEYS, path, errors);
      if (typeof item.id !== "string" || item.id.trim() === "") {
        errors.push({ path: `${path}.id`, message: "必须是非空字符串" });
        return;
      }
      if (exceptions.some((e) => e.id === item.id)) errors.push({ path: `${path}.id`, message: "exception id 重复" });
      if (typeof item.rule !== "string" || !(RULES as readonly string[]).includes(item.rule)) {
        errors.push({ path: `${path}.rule`, message: `必须是已知 rule:${RULES.join("|")}` });
      }
      if (typeof item.reason !== "string" || item.reason.trim().length < 4) {
        errors.push({ path: `${path}.reason`, message: "必须写明理由(≥4 字)" });
      }
      if (typeof item.owner !== "string" || item.owner.trim() === "") {
        errors.push({ path: `${path}.owner`, message: "缺 owner(例外必须有人负责)" });
      }
      if (typeof item.expires !== "string" || !isValidDate(item.expires)) {
        errors.push({ path: `${path}.expires`, message: "缺 expires 或格式非 YYYY-MM-DD" });
      }
      let files: string[] | undefined;
      if (item.files !== undefined) {
        if (!checkStringArray(item.files, `${path}.files`, errors)) return;
        files = [...(item.files as string[])];
      }
      exceptions.push({
        id: item.id,
        rule: item.rule as Rule,
        files,
        reason: typeof item.reason === "string" ? item.reason : "",
        owner: typeof item.owner === "string" ? item.owner : "",
        expires: typeof item.expires === "string" ? item.expires : "",
      });
    });
  }

  if (errors.length > 0) return { errors };
  return { policy: { version: 1, modules, layers, exceptions, ...(ignore ? { ignore } : {}) }, errors };
}

/** 读 policy 文件;文件缺失或 JSON 坏 → errors(调用方决定 exit 3)。 */
export function loadPolicyFile(path: string): { policy?: Policy; errors: PolicyError[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { errors: [{ path, message: "文件不存在或不可读" }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [{ path, message: `JSON 解析失败:${(err as Error).message}` }] };
  }
  return parsePolicy(raw);
}

// ---------------------------------------------------------------- 基础工具

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", "tasks"]);

export function isSourceFile(rel: string): boolean {
  return SOURCE_EXT.test(rel);
}

export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isUnder(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

function toPosixRel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).split(sep).join("/");
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}

export function globMatch(pattern: string, file: string): boolean {
  return globToRegExp(pattern).test(file);
}

export function fingerprint(rule: string, file: string, detail: string): string {
  const norm = normalizeDetail(detail);
  return createHash("sha256").update(`${rule}\n${file}\n${norm}`).digest("hex").slice(0, 16);
}

/** detail 规范化:压空白、落 LF;行号/绝对路径不进 detail(否则无关编辑就 churn 基线)。 */
export function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, " ").trim();
}

function makeViolation(rule: Rule, file: string, detail: string, line?: number): Violation {
  const norm = normalizeDetail(detail);
  return { rule, file, line, detail: norm, hash: fingerprint(rule, file, norm), message: norm };
}

// ---------------------------------------------------------------- 模块归属 / 包名解析

interface OwnerHit {
  module: PolicyModule;
  root: string;
}

function hasGlob(s: string): boolean {
  return /[*?[{]/.test(s);
}

/** module.root 的固定前缀(glob 形态取第一个通配段之前的部分)。 */
export function rootPrefix(pattern: string): string {
  const segs = normalizeRoot(pattern).split("/");
  const fixed: string[] = [];
  for (const seg of segs) {
    if (hasGlob(seg)) break;
    fixed.push(seg);
  }
  return fixed.join("/") || ".";
}

/** module.root 展开:普通目录原样返回;glob 形态按目录名匹配展开(如 apps/[star]/src 这类多包声明)。 */
export function expandRootPattern(repoRoot: string, pattern: string): string[] {
  const p = normalizeRoot(pattern);
  if (!hasGlob(p)) return existsSync(join(repoRoot, p)) ? [p] : [];
  const base = rootPrefix(p);
  const re = globToRegExp(p);
  const maxDepth = p.split("/").length + (p.includes("**") ? 4 : 0);
  const out: string[] = [];
  const visit = (rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIR_NAMES.has(e.name)) continue;
      const child = rel === "." ? e.name : `${rel}/${e.name}`;
      if (re.test(child)) out.push(child);
      visit(child, depth + 1);
    }
  };
  if (existsSync(join(repoRoot, base))) visit(base, base.split("/").length);
  return out.sort();
}

/** 展开后的 (module, root) 归属表:glob root 也参与「最长 root 优先」判定。 */
export type ExpandedRoot = { module: PolicyModule; root: string };

export function expandModuleRoots(repoRoot: string, modules: PolicyModule[]): ExpandedRoot[] {
  const out: ExpandedRoot[] = [];
  for (const m of modules) for (const r of expandRootPattern(repoRoot, m.root)) out.push({ module: m, root: r });
  return out;
}

function ownerOf(roots: ExpandedRoot[], file: string): OwnerHit | undefined {
  let best: OwnerHit | undefined;
  for (const { module, root } of roots) {
    if (!isUnder(file, root)) continue;
    if (!best || root.length > best.root.length) best = { module, root };
  }
  return best;
}

interface PkgInfo {
  name: string;
  dir: string;
}

function readPackageName(repoRoot: string, dirRel: string): string | undefined {
  const p = join(repoRoot, dirRel, "package.json");
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as { name?: unknown };
    return typeof raw.name === "string" ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

function nearestPackageDir(repoRoot: string, rootRel: string): string | undefined {
  let dir = posix.dirname(rootRel);
  for (;;) {
    const name = readPackageName(repoRoot, dir);
    if (name) return dir;
    if (dir === "." || dir === "") return undefined;
    dir = posix.dirname(dir);
  }
}

/** 由 module root 反查所在 package.json(用于解析 `@lampgenie/x/y` 形态的裸导入)。 */
export function packageIndex(repoRoot: string, modules: PolicyModule[]): PkgInfo[] {
  const out: PkgInfo[] = [];
  for (const m of modules) {
    const dir = nearestPackageDir(repoRoot, rootPrefix(m.root));
    if (!dir) continue;
    if (out.some((p) => p.dir === dir)) continue;
    const name = readPackageName(repoRoot, dir);
    if (name) out.push({ name, dir });
  }
  return out;
}

function firstExisting(repoRoot: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const rel = posix.normalize(c);
    if (rel.startsWith("..")) continue;
    const abs = join(repoRoot, rel);
    if (existsSync(abs) && statSync(abs).isFile()) return rel;
  }
  return undefined;
}

/** 把 import 说明符解析成仓内文件(相对路径/包名子路径);解析不到返回 undefined(判据跳过)。 */
export function resolveSpecifier(
  repoRoot: string,
  fromFile: string,
  spec: string,
  pkgs: PkgInfo[],
): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    return firstExisting(repoRoot, [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.js`,
      `${base}.mjs`,
      `${base}/index.ts`,
    ]);
  }
  if (spec.startsWith("/") || spec.startsWith("node:")) return undefined;
  const pkg = [...pkgs]
    .filter((p) => spec === p.name || spec.startsWith(`${p.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!pkg) return undefined;
  const sub = spec === pkg.name ? "" : spec.slice(pkg.name.length + 1);
  const prefixes = [`${pkg.dir}/src`, pkg.dir];
  const candidates: string[] = [];
  if (sub === "") {
    for (const pre of prefixes) candidates.push(`${pre}/index.ts`, `${pre}/index.tsx`, `${pre}/index.js`);
  } else {
    for (const pre of prefixes) {
      candidates.push(
        `${pre}/${sub}`,
        `${pre}/${sub}.ts`,
        `${pre}/${sub}.tsx`,
        `${pre}/${sub}.js`,
        `${pre}/${sub}.mjs`,
        `${pre}/${sub}/index.ts`,
      );
    }
  }
  return firstExisting(repoRoot, candidates);
}

// ---------------------------------------------------------------- 源文件枚举

export function walkSourceFiles(repoRoot: string, rootRel: string): string[] {
  const out: string[] = [];
  const start = join(repoRoot, normalizeRoot(rootRel));
  if (!existsSync(start)) return out;
  const visit = (abs: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        visit(join(abs, e.name));
      } else if (e.isFile()) {
        const rel = toPosixRel(repoRoot, join(abs, e.name));
        if (isSourceFile(rel)) out.push(rel);
      }
    }
  };
  const st = statSync(start);
  if (st.isFile()) {
    const rel = toPosixRel(repoRoot, start);
    return isSourceFile(rel) ? [rel] : [];
  }
  visit(start);
  return out.sort();
}

// ---------------------------------------------------------------- import 解析

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:type\s+)?[^"'`;()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^"'`;()]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

interface ImportRef {
  spec: string;
  line: number;
}

export function extractImports(text: string): ImportRef[] {
  const seen = new Set<string>();
  const out: ImportRef[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      const key = `${m.index}:${spec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = text.slice(0, m.index).split("\n").length;
      out.push({ spec, line });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

function entryAllows(entryRel: string, targetFile: string): boolean {
  const e = normalizeRoot(entryRel);
  if (targetFile === e) return true;
  // 目录级 entry(如 src/agent/)允许其下文件;文件级 entry 只允许它自己
  const dirLike = entryRel.endsWith("/") || !/\.[a-z0-9]+$/i.test(e);
  return dirLike && targetFile.startsWith(`${e}/`);
}

// ---------------------------------------------------------------- 扫描与判据

export interface ScanInput {
  repoRoot: string;
  policy: Policy;
  /** 显式检查集(--changed);缺省=各 module root 全量枚举 */
  files?: string[];
  /** 未跟踪文件(全量模式下用于「新文件必须入座」);undefined=无法判定(记 note) */
  untracked?: string[];
  /** YYYY-MM-DD,默认今天(测试注入) */
  today?: string;
}

export function scanPolicy(input: ScanInput): ScanResult {
  const { repoRoot, policy } = input;
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const notes: string[] = [];
  const modules = policy.modules;
  const layerMap = new Map(policy.layers.map((l) => [l.name, l]));
  const pkgs = packageIndex(repoRoot, modules);

  // 例外:先分过期 / 有效
  const expiredExceptions: ExpiredException[] = [];
  const activeExceptions: PolicyException[] = [];
  for (const ex of policy.exceptions) {
    if (ex.expires < today) {
      expiredExceptions.push({ id: ex.id, rule: ex.rule, expires: ex.expires, reason: ex.reason });
    } else activeExceptions.push(ex);
  }

  // 检查集
  // 范围:policy 声明的模块所在 package 目录(隐式范围)——不在任何模块包内的文件不属于本门禁职责,
  // 否则仓里任何草稿文件都会被误判。ignore 命中的文件同样完全跳过。
  // module.root 支持 glob(如 apps/[star]/src):先展开成真实目录,再参与归属/枚举/范围计算。
  const rootTable = expandModuleRoots(repoRoot, modules);
  for (const m of modules) {
    if (!rootTable.some((r) => r.module.id === m.id)) notes.push(`module-root-not-found:${normalizeRoot(m.root)}`);
  }
  const scopeRoots = [...new Set(rootTable.map((r) => nearestPackageDir(repoRoot, r.root) ?? r.root))];
  const ignorePatterns = policy.ignore ?? [];
  const inScope = (file: string): boolean =>
    scopeRoots.some((r) => isUnder(file, r)) && !ignorePatterns.some((p) => globMatch(p, file));
  const filterScope = (items: string[]): { kept: string[]; dropped: number } => {
    const kept = items.filter((f) => inScope(normalizeRoot(f)));
    return { kept, dropped: items.length - kept.length };
  };

  let candidates: string[];
  if (input.files) {
    const { kept, dropped } = filterScope([...new Set(input.files.map(normalizeRoot).filter(isSourceFile))]);
    candidates = kept.sort();
    notes.push("scope:changed");
    if (dropped > 0) notes.push(`skipped-out-of-scope:${dropped}`);
  } else {
    const all: string[] = [];
    for (const { module, root } of rootTable) {
      if (module.managed) all.push(...walkSourceFiles(repoRoot, root));
      else notes.push(`unmanaged-root:${root}`);
    }
    candidates = [...new Set(all)].filter(inScope).sort();
    notes.push("scope:full");
  }

  const covered = (file: string): OwnerHit | undefined => ownerOf(rootTable, file);
  const raw: Violation[] = [];

  // 入座:每个被检查的源文件必须落在某个 module root 下
  const declaredRoots = [...new Set(rootTable.map((r) => r.root))];
  const seatCandidates = new Set(candidates);
  if (input.untracked) {
    for (const f of input.untracked) {
      if (isSourceFile(f) && inScope(normalizeRoot(f))) seatCandidates.add(normalizeRoot(f));
    }
  } else if (!input.files) {
    // 无 git 信号时无法区分「存量 / 新增」:保守地把 module 所在 package 内的全部源文件都当候选,
    // 未入座的一律报出(可被 baseline 显式收编),而不是静默当干净。
    for (const r of scopeRoots) for (const f of walkSourceFiles(repoRoot, r)) seatCandidates.add(f);
    notes.push("unmanaged-detection-degraded:no-git(all-scope-files)");
  }

  for (const file of [...seatCandidates].sort()) {
    const hit = covered(file);
    if (hit) {
      // 落在 unmanaged root 的新文件 = 未入座(legacy 目录不许接新代码)
      if (!hit.module.managed && (input.untracked?.includes(file) || input.files?.includes(file))) {
        raw.push(
          makeViolation(
            RULE_UNMANAGED,
            file,
            `file not seated in a managed module (under unmanaged root ${hit.root})`,
          ),
        );
      }
      continue;
    }
    raw.push(
      makeViolation(
        RULE_UNMANAGED,
        file,
        `file not seated in any module root (declared roots: ${declaredRoots.join(", ")})`,
      ),
    );
  }

  // 跨层 / 深导入
  const checkedFiles: string[] = [];
  for (const file of candidates) {
    const from = covered(file);
    if (!from) continue;
    if (!from.module.managed) {
      notes.push(`skip-unmanaged-module:${from.module.id}`);
      continue;
    }
    checkedFiles.push(file);
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), "utf-8");
    } catch {
      notes.push(`read-failed:${file}`);
      continue;
    }
    for (const ref of extractImports(text)) {
      const target = resolveSpecifier(repoRoot, file, ref.spec, pkgs);
      if (!target) continue;
      const to = covered(target);
      if (!to) continue; // 目标不在 policy 内(例如 packages/core):不产生违规,避免首跑一片红
      if (to.module.id === from.module.id) continue;
      if (!to.module.managed) continue; // 结构规则只对 managed 模块生效

      const fromLayer = layerMap.get(from.module.layer);
      const layerAllows = fromLayer?.mayImport.includes(to.module.layer) ?? false;
      const allowImport = from.module.allowImport ?? [];
      const explicitAllows = allowImport.includes(to.module.id) || allowImport.includes(to.module.layer);
      if (!layerAllows && !explicitAllows) {
        raw.push(
          makeViolation(
            RULE_CROSS_LAYER,
            file,
            `layer ${from.module.layer} may not import ${to.module.layer}: ${from.module.id} -> ${to.module.id}`,
            ref.line,
          ),
        );
      }

      if (to.module.entry && !explicitAllows && !entryAllows(to.module.entry, target)) {
        raw.push(
          makeViolation(
            RULE_DEEP_IMPORT,
            file,
            `deep import into ${to.module.id} bypasses entry ${to.module.entry}`,
            ref.line,
          ),
        );
      }
    }
  }

  // 例外豁免
  const exempted: ExemptedHit[] = [];
  const violations: Violation[] = [];
  const seenHash = new Set<string>();
  for (const v of raw) {
    const matched = activeExceptions.find(
      (ex) => ex.rule === v.rule && (!ex.files || ex.files.some((p) => globMatch(p, v.file))),
    );
    if (matched) {
      exempted.push({ rule: v.rule, file: v.file, exceptionId: matched.id });
      continue;
    }
    if (seenHash.has(v.hash)) continue;
    seenHash.add(v.hash);
    violations.push(v);
  }

  return { violations, expiredExceptions, exempted, checkedFiles, notes: dedupe(notes) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// ---------------------------------------------------------------- baseline / ratchet

export function emptyBaseline(): Baseline {
  return { version: 1, generatedAt: "", entries: [] };
}

export function loadBaselineFile(path: string): { baseline?: Baseline; error?: string } {
  if (!existsSync(path)) return { baseline: undefined, error: "baseline-missing" };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<Baseline>;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return { error: "baseline-invalid-format" };
    const entries: BaselineEntry[] = [];
    for (const e of raw.entries) {
      if (!e || typeof e.rule !== "string" || typeof e.file !== "string" || typeof e.detailHash !== "string") {
        return { error: "baseline-invalid-format" };
      }
      entries.push({ rule: e.rule, file: e.file, detailHash: e.detailHash });
    }
    return { baseline: { version: 1, generatedAt: String(raw.generatedAt ?? ""), entries } };
  } catch {
    return { error: "baseline-invalid-format" };
  }
}

export function baselineFrom(violations: Violation[], generatedAt: string): Baseline {
  const seen = new Set<string>();
  const entries: BaselineEntry[] = [];
  for (const v of violations) {
    const key = `${v.rule}\u0000${v.file}\u0000${v.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ rule: v.rule, file: v.file, detailHash: v.hash });
  }
  entries.sort((a, b) => (a.rule + a.file + a.detailHash).localeCompare(b.rule + b.file + b.detailHash));
  return { version: 1, generatedAt, entries };
}

export function ratchet(
  violations: Violation[],
  baseline: Baseline | undefined,
): { fresh: Violation[]; baselined: Violation[] } {
  const known = new Set(
    (baseline?.entries ?? []).map((e) => `${e.rule}\u0000${e.file}\u0000${e.detailHash}`),
  );
  const fresh: Violation[] = [];
  const baselined: Violation[] = [];
  for (const v of violations) {
    if (known.has(`${v.rule}\u0000${v.file}\u0000${v.hash}`)) baselined.push(v);
    else fresh.push(v);
  }
  return { fresh, baselined };
}

// ---------------------------------------------------------------- git / --changed

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export interface ChangedFiles {
  base?: string;
  files?: string[];
  note?: string;
}

export function untrackedSourceFiles(repoRoot: string): string[] | undefined {
  const out = gitOut(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (out === undefined) return undefined;
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && isSourceFile(s) && !isSkippedPath(s));
}

function isSkippedPath(rel: string): boolean {
  return rel.split("/").some((seg) => SKIP_DIR_NAMES.has(seg));
}

/** --changed 选基:--base > merge-base(HEAD,@{upstream});解析不到 → undefined(调用方降级全量)。 */
export function resolveChangedFiles(repoRoot: string, explicitBase?: string): ChangedFiles {
  const base = explicitBase ?? gitOut(repoRoot, ["merge-base", "HEAD", "@{upstream}"]);
  if (!base) {
    return { note: "changed-base-unresolved:fallback-full-scan" };
  }
  const diff = gitOut(repoRoot, ["diff", "--name-only", `${base}...HEAD`]);
  if (diff === undefined) return { base, note: "changed-diff-failed:fallback-full-scan" };
  const tracked = diff.split("\n").map((s) => s.trim()).filter((s) => s && isSourceFile(s) && !isSkippedPath(s));
  const untracked = untrackedSourceFiles(repoRoot) ?? [];
  const files = [...new Set([...tracked, ...untracked])].filter((rel) => existsSync(join(repoRoot, rel)));
  return { base, files };
}

// ---------------------------------------------------------------- CLI

export interface CliReport {
  ok: boolean;
  policy: { path: string; modules: number; managedModules: number; layers: string[] };
  checkedFiles: number;
  violations: { rule: string; file: string; line?: number; detail: string; hash: string }[];
  baselined: number;
  expiredExceptions: ExpiredException[];
  notes: string[];
}

export interface CliResult {
  code: number;
  output: string;
  report?: CliReport;
  errors?: PolicyError[];
}

function parseArgs(argv: string[]): {
  mode: "check" | "update";
  changed: boolean;
  json: boolean;
  policyPath?: string;
  base?: string;
  errors: string[];
} {
  const errors: string[] = [];
  let mode: "check" | "update" = "check";
  let changed = false;
  let json = false;
  let policyPath: string | undefined;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--check") mode = "check";
    else if (a === "--update") mode = "update";
    else if (a === "--changed") changed = true;
    else if (a === "--json") json = true;
    else if (a === "--policy") policyPath = argv[++i];
    else if (a === "--base") base = argv[++i];
    else if (a.startsWith("--policy=")) policyPath = a.slice("--policy=".length);
    else if (a.startsWith("--base=")) base = a.slice("--base=".length);
    else if (a === "--help" || a === "-h") errors.push("help");
    else errors.push(`未知参数:${a}`);
  }
  if (policyPath === undefined && argv.includes("--policy")) errors.push("--policy 缺少值");
  return { mode, changed, json, policyPath, base, errors };
}

interface RunCliOptions {
  /** 测试注入时钟(YYYYMMDD 秒级时间戳格式可任意) */
  now?: () => string;
}

/**
 * CLI 主体(可测试):返回 {code, output}。
 * code:0 干净 / 2 有新增违规 / 3 policy 或 IO 错误。
 */
export function runCli(argv: string[], cwd: string, opts: RunCliOptions = {}): CliResult {
  const args = parseArgs(argv);
  const now = opts.now ?? (() => new Date().toISOString());
  if (args.errors.length > 0) {
    return { code: 3, output: `arch-policy: 参数错误\n${args.errors.map((e) => `  - ${e}`).join("\n")}\n`, errors: [] };
  }

  const explicitPolicy = args.policyPath !== undefined;
  const policyPath = args.policyPath ? resolvePath(cwd, args.policyPath) : join(cwd, ".genie", "arch-policy.json");
  const baselinePath = join(dirname(policyPath), "arch-policy-baseline.json");

  const loaded = loadPolicyFile(policyPath);
  if (!loaded.policy) {
    if (!explicitPolicy && !existsSync(policyPath)) {
      const report: CliReport = {
        ok: true,
        policy: { path: policyPath, modules: 0, managedModules: 0, layers: [] },
        checkedFiles: 0,
        violations: [],
        baselined: 0,
        expiredExceptions: [],
        notes: ["no-policy"],
      };
      return { code: 0, output: args.json ? JSON.stringify(report, null, 2) : "arch-policy: note no-policy — 本仓未采用架构策略门\n", report };
    }
    const report: CliReport = {
      ok: false,
      policy: { path: policyPath, modules: 0, managedModules: 0, layers: [] },
      checkedFiles: 0,
      violations: [],
      baselined: 0,
      expiredExceptions: [],
      notes: ["policy-error"],
    };
    const text = `arch-policy: policy 错误(${policyPath})\n${loaded.errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n")}\n`;
    return { code: 3, output: args.json ? JSON.stringify({ ...report, errors: loaded.errors }, null, 2) : text, report, errors: loaded.errors };
  }
  const policy = loaded.policy;

  const notes: string[] = [];
  let files: string[] | undefined;
  if (args.changed) {
    const changed = resolveChangedFiles(cwd, args.base);
    if (changed.base) {
      files = changed.files ?? [];
      notes.push(`changed-base:${changed.base}`);
      notes.push(`changed-files:${files.length}`);
    } else {
      notes.push(changed.note ?? "changed-base-unresolved:fallback-full-scan");
    }
  }

  let untracked: string[] | undefined;
  if (!files) untracked = untrackedSourceFiles(cwd);

  const scan = scanPolicy({ repoRoot: cwd, policy, files, untracked });
  notes.push(...scan.notes);

  const policyInfo = {
    path: policyPath,
    modules: policy.modules.length,
    managedModules: policy.modules.filter((m) => m.managed).length,
    layers: policy.layers.map((l) => l.name),
  };

  if (args.mode === "update") {
    const baseline = baselineFrom(scan.violations, now());
    try {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
    } catch (err) {
      return { code: 3, output: `arch-policy: 写 baseline 失败:${(err as Error).message}\n`, errors: [] };
    }
    const report: CliReport = {
      ok: true,
      policy: policyInfo,
      checkedFiles: scan.checkedFiles.length,
      violations: scan.violations.map((v) => ({ rule: v.rule, file: v.file, line: v.line, detail: v.detail, hash: v.hash })),
      baselined: 0,
      expiredExceptions: scan.expiredExceptions,
      notes: [...notes, `baseline-written:${baseline.entries.length}`],
    };
    const text = [
      `arch-policy: baseline 已写入 ${baselinePath}(${baseline.entries.length} 条)`,
      `检查文件 ${scan.checkedFiles.length} 个,豁免例外 ${scan.exempted.length} 处,过期例外 ${scan.expiredExceptions.length} 条`,
      ...scan.expiredExceptions.map((e) => `  ⚠ exception-expired: ${e.id}(${e.rule},${e.expires})`),
      ...report.notes.map((n) => `  note: ${n}`),
      "",
    ].join("\n");
    return { code: 0, output: args.json ? JSON.stringify(report, null, 2) : text, report };
  }

  const loadedBaseline = loadBaselineFile(baselinePath);
  if (loadedBaseline.error) notes.push(loadedBaseline.error);
  const { fresh, baselined } = ratchet(scan.violations, loadedBaseline.baseline);
  const ok = fresh.length === 0;

  const report: CliReport = {
    ok,
    policy: policyInfo,
    checkedFiles: scan.checkedFiles.length,
    violations: fresh.map((v) => ({ rule: v.rule, file: v.file, line: v.line, detail: v.detail, hash: v.hash })),
    baselined: baselined.length,
    expiredExceptions: scan.expiredExceptions,
    notes,
  };
  const text = [
    `arch-policy: ${ok ? "OK" : "FAIL"} — 检查 ${scan.checkedFiles.length} 个文件,新增违规 ${fresh.length} 条,已 baseline ${baselined.length} 条,例外豁免 ${scan.exempted.length} 处`,
    ...fresh.map((v) => `  ✗ [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ""} — ${v.detail}`),
    ...scan.expiredExceptions.map((e) => `  ⚠ exception-expired: ${e.id}(${e.rule},${e.expires})`),
    ...notes.map((n) => `  note: ${n}`),
    "",
  ].join("\n");

  return { code: ok ? 0 : 2, output: args.json ? JSON.stringify(report, null, 2) : text, report };
}
