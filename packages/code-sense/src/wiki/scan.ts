/**
 * wiki 输入扫描(step-118):文件清单/指纹/git sha/模块归属/import 边/manifest 入口线索。
 * 全部确定性;不构建 c2f 全量索引(分钟级),只做行级词法扫描(页面明确标注词法级)。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, relative } from "node:path";
import { listSourceFiles } from "../callgraph/engine";
import { gitHeadSha } from "../callgraph/c2f";
import { isTestPath } from "../path-filter";
import { deriveModules, moduleAssignment, type ModuleGuide } from "../modulemap/index";
import { sandboxResolve } from "../search";
import { WIKI_GENERATOR_VERSION, type WikiCitation, type WikiConfig, type WikiGraph, type WikiGraphEdge, type WikiGraphNode } from "./types";

export interface SymbolDef {
  name: string;
  kind: "function" | "method" | "class" | "type" | "symbol";
  line: number;
  exported: boolean;
  text: string;
}

export interface FileImport {
  file: string;
  targets: { file: string; line: number; spec: string }[];
  unresolved: number;
}

export interface HintItem {
  label: string;
  file: string;
  line: number;
  anchor: string;
}

export interface EntryFileHint {
  file: string;
  line: number;
  anchor: string;
  reason: string;
}

export interface ManifestHints {
  identity: HintItem[];
  run: HintItem[];
  entryFiles: EntryFileHint[];
}

export interface WikiInput {
  root: string;
  /** 路径身份(sanitized basename,`wikiRepoName`);manifest 与目录用。 */
  repo: string;
  /** 展示名(package.json name / pyproject name / go module / basename)。 */
  displayName: string;
  gitHead: string;
  inputHash: string;
  /** rel → mtimeMs:size(失效指纹)。 */
  files: Record<string, string>;
  /** 参与 wiki 的源码文件(不含测试)。 */
  sourceFiles: string[];
  /** 测试文件(统计展示用;不进模块叙述)。 */
  testFiles: string[];
  /** 源码 + README/manifest(用于树与引用)。 */
  allFiles: string[];
  modules: ModuleGuide[];
  moduleOf: Map<string, string>;
  moduleFiles: Map<string, string[]>;
  imports: FileImport[];
  hints: ManifestHints;
  scanTruncated: { total: number; scanned: number };
}

const DOC_CANDIDATES = [
  "README.md", "README.MD", "readme.md", "README.rst",
  "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "requirements.txt",
];

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".vue", ".rb", ".php", ".kt", ".cs", ".swift",
]);

/** 源码/文档文本缓存(总字符上限,防大仓撑爆内存)。 */
export class SourceCache {
  private map = new Map<string, { lines: string[]; chars: number }>();
  private total = 0;
  constructor(private readonly root: string, private readonly maxChars = 40_000_000) {}

  async load(rel: string): Promise<string[] | null> {
    const hit = this.map.get(rel);
    if (hit) {
      // LRU:刷新顺序
      this.map.delete(rel);
      this.map.set(rel, hit);
      return hit.lines;
    }
    try {
      const abs = await sandboxResolve(this.root, rel);
      const text = await readFile(abs, "utf-8");
      if (text.includes("\u0000")) return null;
      const lines = text.split(/\r?\n/);
      const chars = text.length;
      if (chars <= this.maxChars) {
        while (this.total + chars > this.maxChars && this.map.size > 0) {
          const oldest = this.map.keys().next().value as string;
          const old = this.map.get(oldest)!;
          this.total -= old.chars;
          this.map.delete(oldest);
        }
        this.map.set(rel, { lines, chars });
        this.total += chars;
      }
      return lines;
    } catch {
      return null;
    }
  }

  async line(rel: string, n: number): Promise<string | null> {
    const lines = await this.load(rel);
    if (!lines || n < 1 || n > lines.length) return null;
    return lines[n - 1] ?? null;
  }

  async lineCount(rel: string): Promise<number> {
    const lines = await this.load(rel);
    return lines?.length ?? 0;
  }
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 行内容是否适合作 anchor(太短/纯符号的拒绝,避免 LLM 用 `}` 蒙混)。 */
export function anchorable(line: string): boolean {
  const t = normalizeWs(line);
  if (t.length < 3) return false;
  return /[A-Za-z0-9_\u4e00-\u9fff]/.test(t);
}

/** 引用回查:文件在沙箱内、行号合法、anchor 在范围内逐字出现。 */
export async function validateCitation(
  root: string,
  cache: SourceCache,
  c: WikiCitation,
): Promise<{ ok: boolean; reason?: string; lineText?: string }> {
  if (!c.file || !c.file.trim()) return { ok: false, reason: "file 为空" };
  if (!Number.isInteger(c.startLine) || !Number.isInteger(c.endLine)) return { ok: false, reason: "行号非整数" };
  if (c.startLine < 1 || c.endLine < c.startLine) return { ok: false, reason: `行号范围非法 ${c.startLine}-${c.endLine}` };
  const anchor = normalizeWs(c.anchor ?? "");
  if (anchor.length < 3) return { ok: false, reason: "anchor 为空/过短" };
  let lines: string[] | null;
  try {
    await sandboxResolve(root, c.file);
    lines = await cache.load(c.file);
  } catch (err) {
    return { ok: false, reason: `路径越界/不可读: ${String(err).slice(0, 80)}` };
  }
  if (!lines) return { ok: false, reason: "文件不存在/不可读" };
  if (c.endLine > lines.length) return { ok: false, reason: `endLine ${c.endLine} 超出文件行数 ${lines.length}` };
  const range = lines.slice(c.startLine - 1, c.endLine).map(normalizeWs).join("\n");
  if (!range.includes(anchor)) return { ok: false, reason: "anchor 未出现在引用行范围内" };
  return { ok: true, lineText: lines[c.startLine - 1]?.trim() ?? "" };
}

async function fingerprint(root: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    try {
      const st = await stat(join(root, f));
      if (!st.isFile()) continue;
      out[f] = `${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      // 文件在枚举后消失:如实缺省(不编造指纹)
    }
  }
  return out;
}

export async function scanWikiInputs(root: string, config: WikiConfig, repo: string): Promise<WikiInput> {
  // listSourceFiles 返回绝对路径(engine 的扫描口径);wiki 全程用仓库相对路径
  // (引用可回查、manifest 可迁移、面板 file.read 以项目根解析)。越界项丢弃(防御)。
  const allSource = (await listSourceFiles(root))
    .map((f) => relative(root, f).replace(/\\/g, "/"))
    .filter((f) => f && !f.startsWith("..") && SOURCE_EXT.has(extname(f).toLowerCase()));
  const testFiles = allSource.filter((f) => isTestPath(f)).sort();
  const sourceFiles = allSource.filter((f) => !isTestPath(f)).sort();
  const docs = DOC_CANDIDATES.filter((f) => existsSync(join(root, f)));
  const allFiles = [...new Set([...allSource, ...docs])].sort();
  const files = await fingerprint(root, allFiles);
  const gitHead = gitHeadSha(root);
  const inputHash = createHash("sha256")
    .update(JSON.stringify({ v: 1, generatorVersion: WIKI_GENERATOR_VERSION, config, files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)) }))
    .digest("hex");

  const modules = deriveModules(sourceFiles);
  const moduleOf = moduleAssignment(sourceFiles);
  const moduleFiles = new Map<string, string[]>();
  for (const f of sourceFiles) {
    const key = moduleOf.get(f) ?? "(root)";
    moduleFiles.set(key, [...(moduleFiles.get(key) ?? []), f]);
  }

  const scanList = sourceFiles.slice(0, config.maxScanFiles);
  const allSet = new Set(allFiles);
  const workspace = workspacePackages(root);
  const goModule = readGoModule(root);
  const imports: FileImport[] = [];
  for (const f of scanList) {
    let text = "";
    try {
      text = await readFile(join(root, f), "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const raw = extractImports(f, text);
    const targets: FileImport["targets"] = [];
    let unresolved = 0;
    for (const r of raw) {
      const target = resolveImport(f, r.spec, allSet, workspace, goModule);
      if (target && target !== f) targets.push({ file: target, line: r.line, spec: r.spec });
      else unresolved++;
    }
    imports.push({ file: f, targets, unresolved });
  }

  const hints = await manifestHints(root, modules, sourceFiles);
  return {
    root, repo, displayName: displayNameOf(root, repo), gitHead, inputHash, files, sourceFiles, testFiles, allFiles,
    modules, moduleOf, moduleFiles, imports, hints,
    scanTruncated: { total: sourceFiles.length, scanned: scanList.length },
  };
}

/** 展示名:package.json name > pyproject [project] name > go.mod 模块末段 > 目录名。 */
function displayNameOf(root: string, fallback: string): string {
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string };
      if (j.name) return j.name;
    } catch {
      // ignore
    }
  }
  const py = join(root, "pyproject.toml");
  if (existsSync(py)) {
    try {
      const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(py, "utf-8"));
      if (m?.[1]) return m[1];
    } catch {
      // ignore
    }
  }
  const go = readGoModule(root);
  if (go) return go.split("/").filter(Boolean).pop() ?? fallback;
  return fallback;
}

/** workspace 包名→目录(packages/* 与 apps/* 的 package.json name;失败跳过)。 */
function workspacePackages(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const top of ["packages", "apps"]) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const name of safeReaddir(dir)) {
      const pkg = join(dir, name, "package.json");
      if (!existsSync(pkg)) continue;
      try {
        const j = JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string };
        if (j.name) out.set(j.name, `${top}/${name}`);
      } catch {
        // 坏 package.json 跳过
      }
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

function readGoModule(root: string): string {
  const p = join(root, "go.mod");
  if (!existsSync(p)) return "";
  try {
    const m = /^module\s+(\S+)/m.exec(readFileSync(p, "utf-8"));
    return m?.[1] ?? "";
  } catch {
    return "";
  }
}

// ---- import 提取 ----

interface RawImport {
  spec: string;
  line: number;
}

export function extractImports(rel: string, text: string): RawImport[] {
  const ext = extname(rel).toLowerCase();
  const lines = text.split(/\r?\n/);
  const out: RawImport[] = [];
  const push = (spec: string, idx: number) => {
    if (spec && spec.length < 300) out.push({ spec, line: idx + 1 });
  };
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" || ext === ".vue") {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      let m = /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/.exec(l);
      if (m) { push(m[1]!, i); continue; }
      m = /^\s*export\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/.exec(l);
      if (m) { push(m[1]!, i); continue; }
      const req = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
      let r: RegExpExecArray | null;
      while ((r = req.exec(l))) push(r[1]!, i);
      const dyn = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
      while ((r = dyn.exec(l))) push(r[1]!, i);
    }
    return out;
  }
  if (ext === ".py") {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      let m = /^\s*from\s+(\.[\w.]*)\s+import\s+/.exec(l);
      if (m) { push(m[1]!, i); continue; }
      m = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+/.exec(l);
      if (m) { push(m[1]!, i); continue; }
      m = /^\s*import\s+([A-Za-z_][\w.]*)/.exec(l);
      if (m) { push(m[1]!, i); }
    }
    return out;
  }
  if (ext === ".go") {
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (!inBlock && /^\s*import\s*\(/.test(l)) { inBlock = true; continue; }
      if (inBlock && /^\s*\)/.test(l)) { inBlock = false; continue; }
      if (inBlock) {
        const m = /^\s*(?:[A-Za-z_.]\w*\s+)?"([^"]+)"/.exec(l);
        if (m) push(m[1]!, i);
        continue;
      }
      const single = /^\s*import\s+(?:[A-Za-z_.]\w*\s+)?"([^"]+)"/.exec(l);
      if (single) push(single[1]!, i);
    }
    return out;
  }
  if (ext === ".java" || ext === ".kt") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?/.exec(lines[i]!);
      if (m) push(m[1]!, i);
    }
    return out;
  }
  if (ext === ".rs") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/.exec(lines[i]!);
      if (m) push(m[1]!, i);
    }
    return out;
  }
  if (ext === ".c" || ext === ".cc" || ext === ".cpp" || ext === ".h" || ext === ".hpp") {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*#\s*include\s+[<"]([^>"]+)[>"]/.exec(lines[i]!);
      if (m) push(m[1]!, i);
    }
    return out;
  }
  return out;
}

const RESOLVE_EXTS = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs",
  ".c", ".cc", ".cpp", ".h", ".hpp", ".vue", ".kt", ".cs",
];
const RESOLVE_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/__init__.py", "/mod.rs"];

function tryFile(base: string, all: Set<string>): string | undefined {
  const clean = base.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  for (const ext of RESOLVE_EXTS) if (all.has(clean + ext)) return clean + ext;
  for (const idx of RESOLVE_INDEX) if (all.has(clean + idx)) return clean + idx;
  return undefined;
}

export function resolveImport(
  fromFile: string,
  spec: string,
  all: Set<string>,
  workspace: Map<string, string>,
  goModule: string,
): string | undefined {
  const ext = extname(fromFile).toLowerCase();
  if (spec.startsWith(".") || spec.startsWith("/")) {
    if (ext === ".py") {
      const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
      const baseDir = dots > 1 ? dirname(dirname(fromFile)) : dirname(fromFile);
      const rest = spec.slice(dots).replace(/\./g, "/");
      return tryFile(posix.join(baseDir, rest), all);
    }
    return tryFile(posix.join(dirname(fromFile), spec), all);
  }
  if (ext === ".go") {
    if (!goModule) return undefined;
    // spec===module path 指向模块根包(dir="."),不是 fromFile 所在子目录——
    // 旧实现取同目录首文件,doc/*.go 的 "github.com/spf13/cobra" 被解析成 doc 内文件,
    // 跨模块边整类丢失(step-118 go-cobra 实锤)。
    const dir = spec === goModule ? "." : spec.startsWith(goModule + "/") ? spec.slice(goModule.length + 1) : "";
    if (!dir && spec !== goModule) return undefined;
    const cands = [...all].filter((f) => f.endsWith(".go") && !f.endsWith("_test.go") && posix.dirname(f) === dir);
    return cands.sort()[0];
  }
  if (ext === ".py") {
    const parts = spec.split(".");
    const direct = parts.join("/");
    return tryFile(direct, all) ?? (all.has(direct + "/__init__.py") ? direct + "/__init__.py" : undefined);
  }
  if (ext === ".java" || ext === ".kt") {
    const suffix = spec.replace(/\./g, "/") + (ext === ".java" ? ".java" : ".kt");
    for (const f of all) if (f === suffix || f.endsWith("/" + suffix)) return f;
    const base = basename(suffix);
    for (const f of all) if (f.endsWith("/" + base)) return f;
    return undefined;
  }
  if (ext === ".rs") {
    const rel = spec.replace(/::/g, "/");
    return tryFile(posix.join(dirname(fromFile), rel), all) ?? tryFile(rel, all);
  }
  // TS/JS:workspace 包名
  for (const [name, dir] of workspace) {
    if (spec === name) {
      return tryFile(`${dir}/src/index`, all) ?? tryFile(`${dir}/index`, all) ?? tryFile(`${dir}/src/main`, all);
    }
    if (spec.startsWith(name + "/")) {
      const sub = spec.slice(name.length + 1);
      return tryFile(`${dir}/src/${sub}`, all) ?? tryFile(`${dir}/${sub}`, all);
    }
  }
  return undefined;
}

// ---- 依赖图 ----

export function buildGraphs(input: WikiInput, config: WikiConfig): WikiGraph[] {
  const moduleEdges = new Map<string, WikiGraphEdge>();
  const fileEdges = new Map<string, WikiGraphEdge>();
  for (const imp of input.imports) {
    const fromMod = input.moduleOf.get(imp.file) ?? "(root)";
    for (const t of imp.targets) {
      const toMod = input.moduleOf.get(t.file) ?? "(root)";
      if (toMod !== fromMod) {
        const key = `${fromMod}\u0000${toMod}`;
        const cur = moduleEdges.get(key);
        if (cur) cur.count++;
        else moduleEdges.set(key, { from: fromMod, to: toMod, count: 1, evidence: { file: imp.file, line: t.line } });
      } else if (t.file !== imp.file) {
        const key = `${imp.file}\u0000${t.file}`;
        const cur = fileEdges.get(key);
        if (cur) cur.count++;
        else fileEdges.set(key, { from: imp.file, to: t.file, count: 1, evidence: { file: imp.file, line: t.line } });
      }
    }
  }
  const graphs: WikiGraph[] = [];
  // 图只画度数 top N(大图缩到容器宽后节点文字不可读);完整边保留在 edges[] 供边表展示。
  if (moduleEdges.size > 0) graphs.push(graphOf("module", [...moduleEdges.values()], 8, 24));
  if (fileEdges.size > 0) graphs.push(graphOf("file", [...fileEdges.values()], 10, 28));
  if (graphs.length === 0 && input.modules.length > 1) {
    // 无 import 边时至少给模块节点图(确定性事实:模块清单存在)
    const nodes = input.modules.slice(0, Math.min(8, config.maxModules)).map((m, i) => ({
      id: `m${i}`, label: shortLabel("module", m.name), kind: "module" as const, full: m.name,
    }));
    const lines = ["flowchart TD", ...nodes.map((n) => `  ${n.id}["${n.label.replace(/"/g, "'")}"]`)];
    graphs.push({ scope: "module", mermaid: lines.join("\n"), nodes, edges: [] });
  }
  return graphs;
}

/** 图内短标签:模块去掉 packages/apps 前缀,文件只留 basename(完整名进 node.full/边表)。 */
function shortLabel(scope: "module" | "file", name: string): string {
  if (scope === "module") return name.replace(/^(packages|apps)\//, "") || name;
  const base = name.split("/").pop() || name;
  return base;
}

function graphOf(scope: "module" | "file", raw: WikiGraphEdge[], maxNodes: number, maxEdges: number): WikiGraph {
  const degree = new Map<string, number>();
  for (const e of raw) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.count);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.count);
  }
  const names = [...new Set(raw.flatMap((e) => [e.from, e.to]))]
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, maxNodes);
  const idx = new Map(names.map((n, i) => [n, (scope === "module" ? "m" : "f") + i]));
  const nodes: WikiGraphNode[] = names.map((n, i) => ({
    id: (scope === "module" ? "m" : "f") + i, label: shortLabel(scope, n), kind: scope, full: n,
  }));
  const lines = ["flowchart TD"];
  for (const n of nodes) lines.push(`  ${n.id}["${n.label.replace(/"/g, "'")}"]`);
  const drawn = raw
    .filter((e) => idx.has(e.from) && idx.has(e.to))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, maxEdges);
  for (const e of drawn) {
    lines.push(`  ${idx.get(e.from)} -->|${e.count}| ${idx.get(e.to)}`);
  }
  const allEdges = raw
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, 60);
  return { scope, mermaid: lines.join("\n"), nodes, edges: allEdges };
}

// ---- manifest/入口线索 ----

async function manifestHints(root: string, modules: ModuleGuide[], sourceFiles: string[]): Promise<ManifestHints> {
  const identity: HintItem[] = [];
  const run: HintItem[] = [];
  const entryFiles: EntryFileHint[] = [];
  const seen = new Set<string>();
  const addEntry = (file: string, line: number, anchor: string, reason: string) => {
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    entryFiles.push({ file, line, anchor, reason });
  };

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const lines = readFileSync(pkgPath, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*"(name|description|version|main|module|types)"\s*:/.test(l) && anchorable(l)) {
        identity.push({ label: "package.json", file: "package.json", line: i + 1, anchor: l.trim() });
      }
      if (/^\s*"(bin|scripts|dependencies|devDependencies)"\s*:/.test(l) && anchorable(l)) {
        run.push({ label: "package.json", file: "package.json", line: i + 1, anchor: l.trim() });
      }
    }
  }
  const pyPath = join(root, "pyproject.toml");
  if (existsSync(pyPath)) {
    const lines = readFileSync(pyPath, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(name|description|version)\s*=/.test(l) && anchorable(l)) {
        identity.push({ label: "pyproject.toml", file: "pyproject.toml", line: i + 1, anchor: l.trim() });
      }
      if (/^\s*\[project\.scripts\]/.test(l) && anchorable(l)) {
        run.push({ label: "pyproject.toml scripts", file: "pyproject.toml", line: i + 1, anchor: l.trim() });
      }
    }
  }
  const goMod = join(root, "go.mod");
  if (existsSync(goMod)) {
    const lines = readFileSync(goMod, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*module\s+/.test(l) && anchorable(l)) {
        identity.push({ label: "go.mod", file: "go.mod", line: i + 1, anchor: l.trim() });
        break;
      }
    }
  }
  const cargo = join(root, "Cargo.toml");
  if (existsSync(cargo)) {
    const lines = readFileSync(cargo, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/^\s*(name|description|version)\s*=/.test(l) && anchorable(l)) {
        identity.push({ label: "Cargo.toml", file: "Cargo.toml", line: i + 1, anchor: l.trim() });
      }
      if (/^\s*\[\[bin\]\]/.test(l) && anchorable(l)) run.push({ label: "Cargo bin", file: "Cargo.toml", line: i + 1, anchor: l.trim() });
    }
  }
  const readme = ["README.md", "README.MD", "readme.md", "README.rst"].find((f) => existsSync(join(root, f)));
  if (readme) {
    const lines = readFileSync(join(root, readme), "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length && run.length < 8; i++) {
      const l = lines[i]!;
      if (/^\s*(npm|pnpm|yarn|bun|go\s+run|cargo\s+run|python3?\s|pip3?\s|uv\s|make\b|docker\s)/.test(l) && anchorable(l)) {
        run.push({ label: "README 运行提示", file: readme, line: i + 1, anchor: l.trim() });
      }
    }
  }

  const entryRe = /(^|\/)(main|index|app|server|gateway|cli|__main__)\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|kt)$/;
  for (const mod of modules) {
    if (mod.entryFile && sourceFiles.includes(mod.entryFile)) {
      const line = await firstAnchorLine(root, mod.entryFile, /(^|\/)(main|index|app|server|gateway|cli|__main__)\./);
      addEntry(mod.entryFile, line.line, line.anchor, "模块入口(静态推导)");
    }
  }
  for (const f of sourceFiles) {
    if (entryRe.test(f)) {
      const line = await firstAnchorLine(root, f, entryRe);
      addEntry(f, line.line, line.anchor, "入口文件命名");
    }
    if (f.endsWith(".go")) {
      try {
        const text = readFileSync(join(root, f), "utf-8");
        const m = /^func\s+main\s*\(/m.exec(text);
        if (m) {
          const idx = text.slice(0, m.index).split("\n").length;
          const lineText = text.split("\n")[idx - 1] ?? "func main(";
          addEntry(f, idx, lineText.trim(), "Go main");
        }
      } catch {
        // ignore
      }
    }
    if (f.endsWith(".py")) {
      try {
        const text = readFileSync(join(root, f), "utf-8");
        const m = /^if\s+__name__\s*==\s*["']__main__["']/m.exec(text);
        if (m) {
          const idx = text.slice(0, m.index).split("\n").length;
          const lineText = text.split("\n")[idx - 1] ?? 'if __name__ == "__main__"';
          addEntry(f, idx, lineText.trim(), "Python __main__");
        }
      } catch {
        // ignore
      }
    }
    if (entryFiles.length >= 12) break;
  }
  if (identity.length === 0) {
    // 无 manifest:README 标题作身份锚点
    const idx = ["README.md", "README.MD", "readme.md"].find((f) => existsSync(join(root, f)));
    if (idx) {
      const lines = readFileSync(join(root, idx), "utf-8").split(/\r?\n/);
      const n = lines.findIndex((l) => /^#\s+/.test(l));
      if (n >= 0) identity.push({ label: "README 标题", file: idx, line: n + 1, anchor: lines[n]!.trim() });
    }
  }
  return { identity, run, entryFiles };
}

async function firstAnchorLine(root: string, rel: string, _re: RegExp): Promise<{ line: number; anchor: string }> {
  try {
    const lines = (await readFile(join(root, rel), "utf-8")).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (anchorable(l) && !/^\s*(\/\/|#|\*|--)/.test(l)) return { line: i + 1, anchor: l.trim() };
    }
    return { line: 1, anchor: (lines[0] ?? basename(rel)).trim() };
  } catch {
    return { line: 1, anchor: basename(rel) };
  }
}

// ---- 符号提取(词法级,页面显式标注) ----

const SYMBOL_SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor"]);

export function extractSymbols(rel: string, text: string, max = 300): SymbolDef[] {
  const ext = extname(rel).toLowerCase();
  const lines = text.split(/\r?\n/);
  const out: SymbolDef[] = [];
  const add = (name: string, kind: SymbolDef["kind"], idx: number, exported: boolean) => {
    if (!name || SYMBOL_SKIP.has(name) || out.length >= max) return;
    const textLine = lines[idx]?.trim() ?? "";
    out.push({ name, kind, line: idx + 1, exported, text: textLine });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const t = l.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--")) continue;
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
      let m = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { add(m[1]!, "function", i, true); continue; }
      m = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { add(m[1]!, "function", i, false); continue; }
      m = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { add(m[1]!, "class", i, true); continue; }
      m = /^\s*class\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { add(m[1]!, "class", i, false); continue; }
      m = /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(l);
      if (m) { add(m[1]!, "type", i, true); continue; }
      m = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(l);
      if (m) { add(m[1]!, "function", i, /^\s*export/.test(l)); continue; }
      continue;
    }
    if (ext === ".py") {
      let m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(l);
      if (m) { add(m[1]!, "function", i, !m[1]!.startsWith("_")); continue; }
      m = /^\s*class\s+(\w+)/.exec(l);
      if (m) { add(m[1]!, "class", i, !m[1]!.startsWith("_")); }
      continue;
    }
    if (ext === ".go") {
      let m = /^\s*func\s+\(\s*\w+\s+\*?([\w.]+)\s*\)\s*(\w+)\s*\(/.exec(l);
      if (m) { add(m[2]!, "method", i, /^[A-Z]/.test(m[2]!)); continue; }
      m = /^\s*func\s+(\w+)\s*\(/.exec(l);
      if (m) { add(m[1]!, "function", i, /^[A-Z]/.test(m[1]!)); continue; }
      m = /^\s*type\s+(\w+)\s+(struct|interface)\b/.exec(l);
      if (m) { add(m[1]!, "type", i, /^[A-Z]/.test(m[1]!)); }
      continue;
    }
    if (ext === ".java" || ext === ".kt") {
      let m = /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/.exec(l);
      if (m) { add(m[1]!, "class", i, /public/.test(l)); continue; }
      m = /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\], ?]+\s+(\w+)\s*\(/.exec(l);
      if (m) { add(m[1]!, "method", i, /public/.test(l)); }
      continue;
    }
    if (ext === ".rs") {
      let m = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(l);
      if (m) { add(m[1]!, "function", i, /^\s*pub/.test(l)); continue; }
      m = /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+(\w+)/.exec(l);
      if (m) { add(m[1]!, "type", i, /^\s*pub/.test(l)); }
      continue;
    }
    if (ext === ".c" || ext === ".cc" || ext === ".cpp" || ext === ".h" || ext === ".hpp") {
      const cls = /^\s*(?:class|struct)\s+(\w+)/.exec(l);
      if (cls) { add(cls[1]!, "class", i, false); continue; }
      const fn = /^\s*(?:[\w:*&<>]+\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?/.exec(l);
      if (fn && !/^\s*(if|for|while|switch|return)\b/.test(l)) add(fn[1]!, "function", i, false);
    }
  }
  return out;
}
