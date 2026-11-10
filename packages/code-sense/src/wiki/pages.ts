/**
 * wiki 页面骨架:确定性事实 + 可校验 file:line 引用 + 可选 LLM 叙述拼接。
 * 页面里的 `path:line` 由面板 CITE_RE 自动变成可点击引用(点开走 file.read 查看器)。
 */
import { extname } from "node:path";
import type {
  WikiCitation, WikiConfig, WikiGraph, WikiNarrative, WikiPageKind, WikiPageSection,
} from "./types";
import { anchorable, extractSymbols, type SourceCache, type WikiInput } from "./scan";

export interface PageDraft {
  id: string;
  title: string;
  kind: WikiPageKind;
  section: WikiPageSection;
  order: number;
  file: string;
  summary: string;
  /** 模块页:模块名(面板跳转结构 tab 用)。 */
  moduleName?: string;
  markdown: string;
  citations: WikiCitation[];
  sources: string[];
  generator: "deterministic" | "llm+validated";
  llm: "on" | "off" | "failed";
}

const SECTION_ORDER: Record<WikiPageSection, number> = {
  overview: 10, structure: 20, modules: 30, entrypoints: 40, graph: 50,
  flow: 15, guide: 60, features: 70, algo: 75,
};

export function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "module";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** anchor 展示文本:折叠空白、截断、去反引号(避免破坏 md 代码 span)。 */
export function quoteAnchor(anchor: string, max = 150): string {
  return clip(oneLine(anchor).replace(/`/g, "'"), max);
}

export function renderCitationList(cites: WikiCitation[]): string {
  const seen = new Set<string>();
  const uniq: WikiCitation[] = [];
  for (const c of cites) {
    const key = `${c.file}:${c.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  if (uniq.length === 0) return "";
  const lines = ["## 引用(行号可校验)", ""];
  for (const c of uniq.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine)) {
    lines.push(`- ${c.file}:${c.startLine} — ${quoteAnchor(c.anchor)}`);
  }
  return lines.join("\n");
}

export function dedupeCitations(cites: WikiCitation[]): WikiCitation[] {
  const seen = new Set<string>();
  const out: WikiCitation[] = [];
  for (const c of cites) {
    const key = `${c.file}:${c.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 直接按源文件行取 anchor(确定性引用;anchor=该行原文)。 */
export async function citeAt(
  cache: SourceCache,
  file: string,
  line: number,
  endLine = line): Promise<WikiCitation | null> {
  const lines = await cache.load(file);
  if (!lines || lines.length === 0) return null;
  const start = Math.max(1, Math.min(line, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  let anchor = lines[start - 1]?.trim() ?? "";
  if (!anchorable(anchor)) {
    for (let i = start; i <= Math.min(lines.length, end + 8); i++) {
      const cand = lines[i - 1]?.trim() ?? "";
      if (anchorable(cand)) return { file, startLine: i, endLine: i, anchor: cand };
    }
    return null;
  }
  return { file, startLine: start, endLine: end, anchor };
}

const DECL_RE = /^\s*(package\s|import\s|export\s|func\s|def\s|class\s|public\s|type\s|module\s|#\s|\[project\]|\[\[bin\]\])/;

/** 文件锚点:优先声明行(package/import/export/func/def/class/type/module/README 标题),
 * 否则首个非注释可引用行。用于补齐每页 ≥5 条引用与文件清单锚点。 */
export async function anchorOfFile(cache: SourceCache, file: string): Promise<WikiCitation | null> {
  const lines = await cache.load(file);
  if (!lines) return null;
  const usable = (l: string) => anchorable(l) && !/^\s*(\/\/|#!\s|\/\*|\*|--|<!--)/.test(l) && !/^\s*[{}[\];,]+\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (usable(lines[i]!) && DECL_RE.test(lines[i]!)) {
      return { file, startLine: i + 1, endLine: i + 1, anchor: lines[i]!.trim() };
  }
  }
  for (let i = 0; i < lines.length; i++) {
    if (usable(lines[i]!)) return { file, startLine: i + 1, endLine: i + 1, anchor: lines[i]!.trim() };
  }
  return null;
}

export async function ensureMinCitations(
  input: WikiInput,
  cache: SourceCache,
  cites: WikiCitation[],
  min = 5,
  preferred: string[] = [],
): Promise<WikiCitation[]> {
  const out = dedupeCitations(cites);
  if (out.length >= min) return out;
  const candidates = [...new Set([...preferred, ...input.allFiles, ...input.sourceFiles])];
  for (const f of candidates) {
    if (out.length >= min) break;
    if (out.some((c) => c.file === f)) continue;
    const c = await anchorOfFile(cache, f);
    if (c) out.push(c);
  }
  return out;
}

export function pageFooter(cites: WikiCitation[]): string {
  const block = renderCitationList(cites);
  return block ? `\n\n${block}\n` : "\n";
}

export function metaLine(input: WikiInput, generator: "确定性骨架" | "LLM+引用回查", extra?: string): string {
  const sha = input.gitHead ? input.gitHead.slice(0, 12) : "无 git sha";
  const bits = [`仓库 ${input.displayName}`, `git ${sha}`, `生成器 ${generator}`];
  if (extra) bits.push(extra);
  return `> ${bits.join(" · ")}`;
}

function languageOf(file: string): string {
  const ext = extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".java": "Java",
    ".rs": "Rust", ".c": "C/C++", ".cc": "C/C++", ".cpp": "C/C++", ".h": "C/C++", ".hpp": "C/C++",
    ".vue": "Vue", ".rb": "Ruby", ".php": "PHP", ".kt": "Kotlin", ".cs": "C#", ".swift": "Swift",
  };
  return map[ext] ?? (ext || "其他");
}

export function renderNarrative(narrative?: WikiNarrative): string {
  if (!narrative || narrative.sections.length === 0) return "";
  const out = ["## 导读(LLM 叙述 · 每条均带引用回查)", ""];
  if (narrative.summary.trim()) out.push(narrative.summary.trim(), "");
  for (const s of narrative.sections) {
    out.push(`### ${oneLine(s.heading).slice(0, 80)}`, "", s.body.trim(), "");
    const evid = s.cites.slice(0, 6).map((c) => `${c.file}:${c.startLine}`).join(", ");
    if (evid) out.push(`证据: ${evid}`, "");
  }
  return out.join("\n");
}

function citeEvidenceLine(file: string, line: number): string {
  return `- ${file}:${line}`;
}

/** README 首段(跳过标题/badge/HTML/代码围栏;只取第一段正文)。 */
async function readmeParagraph(cache: SourceCache, file: string): Promise<{ text: string; startLine: number; endLine: number; anchor: string } | null> {
  const lines = await cache.load(file);
  if (!lines) return null;
  let start = -1;
  let end = -1;
  const buf: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (/^```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!raw || raw.startsWith("#") || raw.startsWith("[![") || raw.startsWith("![") || /^<[^>]+>/.test(raw)) {
      if (start >= 0 && buf.length > 0 && !raw) break;
      continue;
  }
    if (start < 0) start = i + 1;
    end = i + 1;
    buf.push(raw.replace(/^>\s*/, ""));
    if (buf.join(" ").length > 500) break;
  }
  if (start < 0 || buf.length === 0) return null;
  return { text: clip(buf.join(" "), 500), startLine: start, endLine: end, anchor: lines[start - 1]!.trim() };
}

export async function buildOverview(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
 narrative?: WikiNarrative): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const sections: string[] = [];
  sections.push(`# ${input.displayName} 仓库概览`, "", metaLine(input, narrative ? "LLM+引用回查" : "确定性骨架"), "");
  if (narrative) sections.push(renderNarrative(narrative));

  sections.push("## 项目身份", "");
  for (const item of input.hints.identity.slice(0, 10)) {
    const c = await citeAt(cache, item.file, item.line);
    if (c) cites.push(c);
    sections.push(citeEvidenceLine(item.file, item.line) + ` — ${quoteAnchor(item.anchor)}`);
  }
  if (input.hints.identity.length === 0) sections.push("- 未发现 package.json / pyproject.toml / go.mod / Cargo.toml / README 标题");
  sections.push("");

  const readme = ["README.md", "README.MD", "readme.md", "README.rst"].find((f) => input.allFiles.includes(f));
  const para = readme ? await readmeParagraph(cache, readme) : null;
  if (readme && para) {
    const c = await citeAt(cache, readme, para.startLine, para.endLine);
    if (c) cites.push(c);
    sections.push("## 项目说明(README 首段)", "", `> ${para.text}`, "", citeEvidenceLine(readme, para.startLine), "");
  }

  const byLang = new Map<string, number>();
  for (const f of input.sourceFiles) byLang.set(languageOf(f), (byLang.get(languageOf(f)) ?? 0) + 1);
  sections.push("## 语言与规模", "", "| 语言 | 源文件数 |", "| --- | --- |");
  for (const [lang, n] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) sections.push(`| ${lang} | ${n} |`);
  sections.push("", `源码文件合计 ${input.sourceFiles.length};测试文件 ${input.testFiles.length};清单/文档 ${input.allFiles.length - input.sourceFiles.length - input.testFiles.length};依赖扫描上限 ${config.maxScanFiles}。`, "");

  sections.push("## 模块一览", "", "| 模块 | 源文件 | 入口 |", "| --- | --- | --- |");
  for (const m of input.modules.slice(0, config.maxModules)) {
    const files = input.moduleFiles.get(m.name) ?? [];
    const c = await anchorOfFile(cache, m.entryFile);
    if (c) cites.push(c);
    sections.push(`| ${m.name} | ${files.length} | ${m.entryFile}:${c?.startLine ?? 1} |`);
  }
  sections.push("", "## 阅读顺序", "", "1. 本页(概览)", "2. 文件树", "3. 模块页(逐个模块)", "4. 入口与运行", "5. 依赖图", "");
  sections.push(pageFooter(await ensureMinCitations(input, cache, cites, 5, input.sourceFiles.slice(0, 8))));
  return {
    id: "overview", title: `${input.displayName} 仓库概览`, kind: "overview", section: "overview",
    order: SECTION_ORDER.overview, file: "overview.md",
    summary: oneLine((narrative?.summary || para?.text || readmeParaFallback(input)) ?? ""),
    markdown: sections.join("\n"),
    citations: await ensureMinCitations(input, cache, cites, 5, input.sourceFiles.slice(0, 8)),
    sources: [...new Set([...input.hints.identity.map((x) => x.file), ...(readme ? [readme] : []), ...input.modules.slice(0, config.maxModules).map((m) => m.entryFile)])],
    generator: narrative ? "llm+validated" : "deterministic",
    llm: narrative ? "on" : "off",
  };
}

function readmeParaFallback(input: WikiInput): string {
  return `静态推导:${input.modules.length} 个模块,${input.sourceFiles.length} 个源文件。`;
}

export async function buildFileTree(
  input: WikiInput,
  cache: SourceCache,
 config: WikiConfig): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const lines: string[] = [`# ${input.displayName} 文件树`, "", metaLine(input, "确定性骨架"), "", `深度上限 ${config.treeDepth};目录后括号为文件数。`, "", "```text"];
  lines.push(...renderTree(input.allFiles, config.treeDepth));
  lines.push("```", "");
  const sized: { file: string; lines: number }[] = [];
  for (const f of input.allFiles) sized.push({ file: f, lines: await cache.lineCount(f) });
  sized.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  lines.push(`## 文件规模(前 ${Math.min(config.maxFilesPerPage, sized.length)} 个)`, "", "| 文件 | 行数 |", "| --- | --- |");
  for (const s of sized.slice(0, config.maxFilesPerPage)) {
    const c = await anchorOfFile(cache, s.file);
    if (c) cites.push(c);
    lines.push(`| ${s.file} | ${s.lines} |`);
  }
  lines.push(pageFooter(await ensureMinCitations(input, cache, cites, 5, sized.slice(0, 8).map((s) => s.file))));
  const cits = await ensureMinCitations(input, cache, cites, 5, sized.slice(0, 8).map((s) => s.file));
  return {
    id: "file-tree", title: "文件树", kind: "file-tree", section: "structure",
    order: SECTION_ORDER.structure, file: "file-tree.md",
    summary: `${input.allFiles.length} 个待索引文件,${input.sourceFiles.length} 个源码文件`,
    markdown: lines.join("\n"), citations: cits, sources: input.allFiles,
    generator: "deterministic", llm: "off",
  };
}

function renderTree(files: string[], maxDepth: number): string[] {
  interface Node { dirs: Map<string, Node>; files: string[]; count: number }
  const root: Node = { dirs: new Map(), files: [], count: 0 };
  for (const f of files) {
    const segs = f.split("/");
    let cur = root;
    cur.count++;
    for (let i = 0; i < Math.min(segs.length - 1, maxDepth); i++) {
      const d = segs[i]!;
      let n = cur.dirs.get(d);
      if (!n) { n = { dirs: new Map(), files: [], count: 0 }; cur.dirs.set(d, n); }
      n.count++;
      cur = n;
    }
    if (segs.length - 1 <= maxDepth) cur.files.push(segs.slice(Math.min(segs.length - 1, maxDepth)).join("/") || segs[segs.length - 1]!);
    }
  const out: string[] = [];
  const walk = (node: Node, prefix: string, depth: number) => {
    if (out.length > 220) return;
    const dirs = [...node.dirs.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    for (const [name, child] of dirs) {
      out.push(`${prefix}${name}/ (${child.count})`);
      if (depth + 1 < maxDepth) walk(child, prefix + "  ", depth + 1);
    }
    const fs = node.files.slice(0, 14).sort();
    for (const f of fs) out.push(`${prefix}${f}`);
    if (node.files.length > fs.length) out.push(`${prefix}… 其余 ${node.files.length - fs.length} 个文件`);
  };
  walk(root, "", 0);
  if (out.length > 250) return [...out.slice(0, 250), "… 树已截断(见文件规模表)"];
  return out;
}

export async function buildModulePage(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  moduleName: string,
 narrative?: WikiNarrative): Promise<PageDraft> {
  const slug = slugify(moduleName);
  const files = (input.moduleFiles.get(moduleName) ?? []).slice().sort();
  const cites: WikiCitation[] = [];
  const out: string[] = [`# 模块 ${moduleName}`, "", metaLine(input, narrative ? "LLM+引用回查" : "确定性骨架", "符号=词法级"), ""];
  if (narrative) out.push(renderNarrative(narrative));
  const entry = input.modules.find((m) => m.name === moduleName)?.entryFile ?? files[0] ?? "";
  const entryCite = entry ? await anchorOfFile(cache, entry) : null;
  if (entryCite) cites.push(entryCite);
  out.push("## 职责与入口", "", `- 模块:${moduleName}`, `- 源文件:${files.length} 个`, `- 入口:${entry || "未识别"}${entryCite ? ":" + entryCite.startLine : ""}`, `- 静态推导(deriveModules):${input.modules.find((m) => m.name === moduleName)?.responsibility ?? "—"}`, "");

  // 关键符号:按文件行数降序取前几个文件,再按定义行序取符号
  const sized: { file: string; lines: number }[] = [];
  for (const f of files.slice(0, config.maxFilesPerPage)) sized.push({ file: f, lines: await cache.lineCount(f) });
  sized.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  const symbolRows: { name: string; kind: string; file: string; line: number }[] = [];
  for (const s of sized) {
    const lines = await cache.load(s.file);
    if (!lines) continue;
    const syms = extractSymbols(s.file, lines.join("\n"), 80).filter((x) => x.exported || x.kind === "class" || x.kind === "type" || x.name.startsWith("Test") === false);
    for (const sym of syms) {
      if (symbolRows.some((r) => r.name === sym.name && r.file === s.file)) continue;
      symbolRows.push({ name: sym.name, kind: sym.kind, file: s.file, line: sym.line });
    if (symbolRows.length >= config.maxSymbols) break;
  }
    if (symbolRows.length >= config.maxSymbols) break;
  }
  out.push("## 关键符号(词法级,非语义确证)", "", "| 符号 | 类型 | 定义 |", "| --- | --- | --- |");
  for (const row of symbolRows) {
    const c = await citeAt(cache, row.file, row.line);
    if (c) cites.push(c);
    out.push(`| ${row.name} | ${row.kind} | ${row.file}:${row.line} |`);
  }
  if (symbolRows.length === 0) out.push("| — | — | 未提取到符号(非支持语言/空模块) |");
  out.push("");

  out.push("## 文件清单", "", "| 文件 | 行数 |", "| --- | --- |");
  for (const s of sized.slice(0, config.maxFilesPerPage)) {
    const c = await anchorOfFile(cache, s.file);
    if (c) cites.push(c);
    out.push(`| ${s.file} | ${s.lines} |`);
  }
  out.push("");

  const deps = new Map<string, { count: number; file: string; line: number }>();
  for (const imp of input.imports) {
    if ((input.moduleOf.get(imp.file) ?? "(root)") !== moduleName) continue;
    for (const t of imp.targets) {
      const toMod = input.moduleOf.get(t.file) ?? "(root)";
      if (toMod === moduleName) continue;
      const cur = deps.get(toMod);
      if (cur) cur.count++;
      else deps.set(toMod, { count: 1, file: imp.file, line: t.line });
  }
  }
  out.push("## 依赖", "");
  if (deps.size === 0) out.push("- 未解析到跨模块 import 边(单一模块/外部依赖)");
  for (const [to, d] of [...deps.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))) {
    const c = await citeAt(cache, d.file, d.line);
    if (c) cites.push(c);
    out.push(`- ${moduleName} → ${to}(${d.count} 次)证据: ${d.file}:${d.line}`);
  }
  out.push("");
  const finalCites = await ensureMinCitations(input, cache, cites, 5, [entry, ...sized.slice(0, 8).map((s) => s.file)]);
  out.push(pageFooter(finalCites));
  return {
    id: `modules/${slug}`, title: `模块 ${moduleName}`, kind: "modules", section: "modules",
    order: SECTION_ORDER.modules, file: `modules/${slug}.md`,
    summary: `${files.length} 个源文件;入口 ${entry || "未识别"}`, moduleName: moduleName,
    markdown: out.join("\n"), citations: finalCites, sources: files,
    generator: narrative ? "llm+validated" : "deterministic",
    llm: narrative ? "on" : "off",
  };
}

export interface RunnableEntryHint {
  name: string;
  kindLabel: string;
  file: string;
  line: number;
  detail?: string;
}

export async function buildEntrypoints(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  runnable?: RunnableEntryHint[],
): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const out: string[] = [`# 入口与运行`, "", metaLine(input, "确定性骨架"), ""];
 // 真实可运行/服务入口置顶(交互面信号:进程入口+HTTP 服务文件),读者第一问。
  if (runnable && runnable.length > 0) {
    out.push("## 可运行 / 服务入口(先看这里)", "");
    for (const r of runnable.slice(0, 14)) {
      const c = await citeAt(cache, r.file, r.line);
    if (c) cites.push(c);
      out.push(`- ${r.name} — ${r.kindLabel} @ ${r.file}:${r.line}${r.detail ? `(${quoteAnchor(r.detail, 80)})` : ""}`);
  }
  out.push("");
  }
  out.push("## 清单字段", "");
  const seenIdentity = new Set<string>();
  for (const item of input.hints.identity.slice(0, 10)) {
    if (seenIdentity.has(item.file + item.line)) continue;
    seenIdentity.add(item.file + item.line);
    const c = await citeAt(cache, item.file, item.line);
    if (c) cites.push(c);
    out.push(`- ${item.label}: ${item.file}:${item.line} — ${quoteAnchor(item.anchor, 110)}`);
  }
  if (input.hints.identity.length === 0) out.push("- 未发现包清单/README 标题");
  out.push("", "## 运行提示", "");
  for (const item of input.hints.run.slice(0, 10)) {
    const c = await citeAt(cache, item.file, item.line);
    if (c) cites.push(c);
    out.push(`- ${item.file}:${item.line} — ${quoteAnchor(item.anchor, 110)}`);
  }
  if (input.hints.run.length === 0) out.push("- 未在 README/清单中识别到运行命令");
  out.push("", "## 入口文件", "");
  const entrySeen = new Set<string>();
 // __init__.py 是包文档不是可运行入口(依据:静态推导把全部
  // __init__ 排在真入口前面,读者第一眼全是噪声)——过滤掉,真入口才有机会露头。
  const entryFiles = input.hints.entryFiles.filter((e) => !/(^|\/)__init__\.py$/.test(e.file));
  for (const e of entryFiles.slice(0, config.maxFilesPerPage)) {
    if (entrySeen.has(e.file + e.line)) continue;
    entrySeen.add(e.file + e.line);
    const c = await citeAt(cache, e.file, e.line);
    if (c) cites.push(c);
    out.push(`- ${e.file}:${e.line} — ${quoteAnchor(e.anchor, 110)}(${e.reason})`);
  }
  if (entryFiles.length === 0) out.push("- 未识别到可运行入口文件(库形态/非常规命名;被 import 使用)");
  out.push("");
  const finalCites = await ensureMinCitations(input, cache, cites, 5, input.hints.entryFiles.map((e) => e.file));
  out.push(pageFooter(finalCites));
  return {
    id: "entrypoints", title: "入口与运行", kind: "entrypoints", section: "entrypoints",
    order: SECTION_ORDER.entrypoints, file: "entrypoints.md",
    summary: `${input.hints.entryFiles.length} 个入口文件;${input.hints.run.length} 条运行提示`,
    markdown: out.join("\n"), citations: finalCites,
    sources: [...new Set([...input.hints.identity.map((x) => x.file), ...input.hints.entryFiles.map((e) => e.file), ...input.hints.run.map((x) => x.file)])],
    generator: "deterministic", llm: "off",
  };
}

export async function buildDependencies(
  input: WikiInput,
  cache: SourceCache,
  config: WikiConfig,
  graphs: WikiGraph[],
): Promise<PageDraft> {
  const cites: WikiCitation[] = [];
  const out: string[] = [`# 依赖图`, "", metaLine(input, "确定性骨架"), ""];
  if (graphs.length === 0) {
    out.push("未解析到跨文件 import 边(单文件/非支持语言/全部为外部依赖)。", "");
  }
  for (const g of graphs) {
    out.push(`## ${g.scope === "module" ? "模块依赖图" : "文件依赖图"}`, "",
      `图为度数 top ${g.nodes.length} 节点(标签=短名;完整名为边表首列),完整解析边见下表。`, "",
      "```mermaid", g.mermaid, "```", "");
  }
  out.push("## 依赖边", "", "| 从 | 到 | 次数 | 证据 |", "| --- | --- | --- | --- |");
  let rows = 0;
  for (const g of graphs) {
    for (const e of g.edges.slice(0, 40)) {
      const c = e.evidence ? await citeAt(cache, e.evidence.file, e.evidence.line) : null;
      if (c) cites.push(c);
      out.push(`| ${e.from} | ${e.to} | ${e.count} | ${e.evidence ? `${e.evidence.file}:${e.evidence.line}` : "—"} |`);
      rows++;
  }
  }
  if (rows === 0) out.push("| — | — | 0 | 未解析到内部 import 边 |");
  const unresolved = input.imports.reduce((n, x) => n + x.unresolved, 0);
  out.push("", `未解析 import ${unresolved} 处(外部依赖/未支持语言;不冒充内部边)。`, "");
  if (input.scanTruncated.scanned < input.scanTruncated.total) {
    out.push(`扫描上限:${input.scanTruncated.scanned}/${input.scanTruncated.total} 个源文件(超出部分未参与依赖图)。`, "");
  }
  const finalCites = await ensureMinCitations(input, cache, cites, 5, input.sourceFiles.slice(0, 8));
  out.push(pageFooter(finalCites));
  return {
    id: "dependencies", title: "依赖图", kind: "dependencies", section: "graph",
    order: SECTION_ORDER.graph, file: "dependencies.md",
    summary: `${graphs.map((g) => `${g.scope}:${g.edges.length} 边`).join(" / ") || "无内部依赖边"}`,
    markdown: out.join("\n"), citations: finalCites,
    sources: [...new Set(graphs.flatMap((g) => g.edges.map((e) => e.from).concat(g.edges.map((e) => e.to))))],
    generator: "deterministic", llm: "off",
  };
}
