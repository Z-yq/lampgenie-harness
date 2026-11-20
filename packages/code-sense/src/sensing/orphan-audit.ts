/**
 * sensing/orphan-audit(§14.2):孤儿审计工具面——「写了没接线」的全仓四类检测。
 * 四类(与 review/antipatterns.ts 的 diff 扫描检测器同族,但这里是**全仓形态**而非 diff 形态):
 * lonely-export 导出符号全仓(除定义文件)零引用(入口文件豁免——词法正则口径);
 * test-only 引用全部来自测试文件(生产链路零调用);
 * orphan-event emit 的事件名全仓无 .on/.once/subscribe 消费 / on 注册的名无 .emit/publish 发出;
 * twins 两个函数体逐行相同(跨文件也算;词法提取:函数签名行到配对大括号闭合)。
 * 红线:零 LLM、不触发索引构建、确定性;检测帽(lonely-export/test-only 各≤40、
 * orphan-event≤20、twins≤20,超帽 truncated=true);knownLimits 恒在场。
 * 与 review 插件检测器不同源(那边吃 diff 前缀解析 + 行号还原,形态不匹配):本文件自写
 * 全仓简化版;文件遍历/排除目录/命中帽复用 retrieval/literal-refs.ts 的 walk 工具
 * (isExcludedPath/DEFAULT_EXCLUDE_DIRS/CODE_EXTS/DOC_EXTS),不新造 walker。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { isExcludedPath } from "../retrieval/literal-refs";

/** 代码扩展名(literal-refs 的 CODE_EXTS 未导出,本地同清单声明;DOC 同)。 */
const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".java", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".cs",
  ".rb", ".php", ".swift", ".kt", ".kts", ".scala", ".sh", ".bash", ".zsh", ".ps1",
  ".lua", ".dart", ".sql", ".proto", ".graphql", ".gql",
  ".json", ".jsonc", ".yaml", ".yml", ".toml",
]);
const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".asciidoc", ".txt"]);

export interface OrphanFinding {
  kind: "lonely-export" | "test-only" | "orphan-event" | "twins";
 /** 相对 root 的 POSIX 路径。 */
  file: string;
 /** 1-based 行号。 */
  line: number;
 /** 标题(渲染首行)。 */
  title: string;
  detail: string;
}

export interface OrphanScanResult {
  root: string;
 /** 扫描范围(target 前缀或 "(全仓)")。 */
  scope: string;
  scannedFiles: number;
  findings: OrphanFinding[];
  truncated: boolean;
  knownLimits: string[];
}

const KNOWN_LIMITS = [
  "反射/动态拼接的调用不识别(词法标识符匹配口径)——动态接线会被误报为孤儿。",
  "入口豁免名单为词法正则(^|/)(main|index|app|gateway|server),不读 package.json bin 字段。",
  "与 review 插件检测器不同源:那边吃 diff 前缀解析,本文件是全仓简化形态(词法扫描)。",
  "函数体提取为「签名行到配对大括号闭合」的词法扫描,签名跨行/表达式箭头函数体可能漏。",
];

// ---- 检测帽 ----
const CAP_LONELY = 40;
const CAP_TEST_ONLY = 40;
const CAP_EVENT = 20;
const CAP_TWINS = 20;
const MAX_FILES = 8000;
const MAX_FILE_BYTES = 1_500_000;

/** 入口豁免(词法正则,与 antipatterns.ts:210 同形态)。 */
const ENTRY_RE = /(^|\/)(main|index|app|gateway|server)\.[tj]sx?$/;

const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$|(^|\/)(__tests__|test|tests)(\/|$)/;

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(toPosix(path));
}

/** 构建文件裸名(literal-refs 同清单,那边未导出)。 */
const BUILD_FILE_RE = /^(CMakeLists\.txt|Makefile|makefile|GNUmakefile|meson\.build|BUILD|BUILD\.bazel|WORKSPACE)$|\.(cmake|mk|bazel)$/;

/** 代码文件(不含文档:孤儿判定以代码引用为准)。 */
function isCodeFileName(name: string): boolean {
  if (BUILD_FILE_RE.test(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return CODE_EXTS.has(name.slice(dot).toLowerCase());
}

function isTextFileName(name: string): boolean {
  if (BUILD_FILE_RE.test(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return CODE_EXTS.has(ext) || DOC_EXTS.has(ext);
}

/** 文件遍历(参考 literal-refs.walkMatches 的目录栈+排除目录+命中帽做法)。 */
function walkFiles(root: string, prefix: string, maxFiles: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(root, relDir) : root;
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (files.length >= maxFiles) {
        truncated = true;
        stack.length = 0;
        break;
      }
      if (e.isDirectory()) {
        if (!isExcludedPath(rel)) stack.push(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (prefix && !(rel === prefix || rel.startsWith(prefix + "/") || rel.startsWith(prefix))) continue;
      if (prefix && !(rel === prefix || rel.startsWith(prefix + "/") || rel.startsWith(toPosix(prefix)))) continue;
      files.push(toPosix(rel));
    }
  }
  return { files, truncated };
}

function readLines(root: string, rel: string): string[] | null {
  try {
    const st = statSync(join(root, rel));
    if (st.size > MAX_FILE_BYTES) return null;
    const buf = readFileSync(join(root, rel));
    if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) return null; // 二进制
    return buf.toString("utf8").split("\n");
  } catch {
    return null;
  }
}

// ---- ① lonely-export / ② test-only:导出符号 + 全仓引用计数 ----

interface ExportSym { name: string; file: string; line: number }

/** 导出提取(全文件形态,非 diff;与 addedExports 同口径的 TS 家族正则 + python 顶层 def)。 */
function extractExports(lines: string[], file: string): ExportSym[] {
  const out: ExportSym[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^\s*export\s*\{([^}]+)\}/.exec(line);
    if (m) {
      if (m[1]!.includes(",")) {
        for (const n of m[1]!.split(",")) {
          const nm = n.trim().split(/\s+as\s+/)[0]!.trim();
          if (nm && !seen.has(nm)) { seen.add(nm); out.push({ name: nm, file, line: i + 1 }); }
        }
      } else if (!seen.has(m[1]!)) {
        seen.add(m[1]!);
        out.push({ name: m[1]!, file, line: i + 1 });
      }
      continue;
    }
    if (/\.(py|pyi)$/.test(file)) {
      const d = /^\s*def\s+([A-Za-z_]\w*)/.exec(line);
 // python 无 export:顶层 def(无缩进)视作导出
      if (d && !/^\s/.test(line) && !seen.has(d[1]!)) {
        seen.add(d[1]!);
        out.push({ name: d[1]!, file, line: i + 1 });
      }
    }
  }
  return out;
}

/** 定义行形态(引用计数时排除:定义本身不算调用方——与 grepRefFiles 同口径)。 */
function defLineRe(name: string): RegExp {
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?` +
    `(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b|class\\s+${name}\\b|def\\s+${name}\\b` +
    `|interface\\s+${name}\\b|(?:type|enum)\\s+${name}\\b)`,
  );
}

// ---- ③ orphan-event:emit/on 事件名 + 接线对账(全文件) ----

const EMIT_RE = /\.(?:emit|publish|dispatchEvent|notify)\s*\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g;
const ON_RE = /\.(?:on|once|addListener|subscribe)\s*\(\s*["'`]([A-Za-z0-9_.:-]+)["'`]/g;

interface EventSym { name: string; file: string; line: number; side: "emit" | "on" }

// ---- ④ twins:函数体词法提取(签名行到配对大括号闭合) ----

const FN_DEF_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*)([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|^\s*def\s+([A-Za-z_]\w*)/;

interface FnBody { name: string; file: string; line: number; body: string }

/** 函数体提取:签名行起、配对大括号(或 python 缩进块)闭合;体行归一化(trim+剥注释)。 */
function extractFunctionBodies(lines: string[], file: string): FnBody[] {
  const out: FnBody[] = [];
  let i = 0;
  while (i < lines.length && out.length < 400) {
    const m = FN_DEF_RE.exec(lines[i]!);
    if (!m) { i++; continue; }
    const name = m[1] ?? m[2] ?? m[3] ?? "?";
    const startLine = i + 1;
    const body: string[] = [];
    const norm = (s: string) => s.trim().replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (/^\s*def\s+/.test(lines[i]!)) {
 // python:缩进块闭合=回到 ≤ 签名缩进的非空行
      const sigIndent = lines[i]!.length - lines[i]!.trimStart().length;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.trim().length > 0 && l.length - l.trimStart().length <= sigIndent) break;
        const n = norm(l.replace(/#.*$/, ""));
        if (n) body.push(n);
        j++;
      }
      if (body.length >= 3) out.push({ name, file, line: startLine, body: body.join("\n") });
      i = j;
      continue;
    }
 // C 家族:花括号配对(签名行起计;闭到 0 深度)
    let depth = 0;
    let opened = false;
    let j = i;
    let closed = false;
    while (j < lines.length) {
      for (const ch of lines[j]!) {
        if (ch === "{") { depth++; opened = true; }
        else if (ch === "}") { depth--; if (opened && depth <= 0) { closed = true; break; } }
      }
      if (j > i) {
        const n = norm(lines[j]!);
        if (n) body.push(n);
      }
      if (closed) break;
      j++;
    }
    if (body.length >= 3 && closed) out.push({ name, file, line: startLine, body: body.join("\n") });
    i = Math.max(j + 1, i + 1);
  }
  return out;
}

// ---- 主入口 ----

export async function scanOrphans(root: string, target?: string): Promise<OrphanScanResult> {
  const scope = target ?? "(全仓)";
  const knownLimits = [...KNOWN_LIMITS];
  const { files: allFiles, truncated: walkTruncated } = walkFiles(root, target ?? "", MAX_FILES);
  if (walkTruncated) knownLimits.push(`文件数达到上限 ${MAX_FILES},扫描范围已截断。`);

  const codeFiles = allFiles.filter((f) => isCodeFileName(f.split("/").pop()!));
  const textFiles = allFiles.filter((f) => isTextFileName(f.split("/").pop()!));

 // 两遍:① 扫描范围内提符号(导出/事件/函数体);② 全部文本文件(含测试/文档)里数引用。
  const exports: ExportSym[] = [];
  const events: EventSym[] = [];
  const fnBodies: FnBody[] = [];
  for (const rel of codeFiles) {
    const lines = readLines(root, rel);
    if (!lines) continue;
    exports.push(...extractExports(lines, rel));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
      for (const m of line.matchAll(EMIT_RE)) events.push({ name: m[1]!, file: rel, line: i + 1, side: "emit" });
      for (const m of line.matchAll(ON_RE)) events.push({ name: m[1]!, file: rel, line: i + 1, side: "on" });
    }
    fnBodies.push(...extractFunctionBodies(lines, rel));
  }

 // 引用计数:一次遍历全部文本文件,对每个候选名查「非定义行」的出现文件。
  const refFiles = new Map<string, Set<string>>();
  const emitCount = new Map<string, number>();
  const onCount = new Map<string, number>();
  const defRes = new Map<string, RegExp>();
  for (const e of exports) if (!defRes.has(e.name)) defRes.set(e.name, defLineRe(e.name));
  const exportNames = [...new Set(exports.map((e) => e.name))];
  const eventNames = [...new Set(events.map((e) => e.name))];
  const nameRes = new Map<string, RegExp>();
  for (const n of [...exportNames, ...eventNames]) nameRes.set(n, new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));

  for (const rel of textFiles) {
    const lines = readLines(root, rel);
    if (!lines) continue;
    const isPy = /\.(py|pyi)$/.test(rel);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const n of exportNames) {
        const re = nameRes.get(n)!;
        if (!re.test(line)) continue;
        const dr = defRes.get(n)!;
 // 定义行不算调用方(grepRefFiles 同口径);定义行判定按文件与语言粗匹配
        if (!isPy && dr.test(line)) continue;
        if (isPy && new RegExp(`^def\\s+${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line)) continue;
        let s = refFiles.get(n);
        if (!s) refFiles.set(n, (s = new Set()));
        s.add(rel);
      }
      for (const n of eventNames) {
        const re = nameRes.get(n)!;
        if (!re.test(line)) continue;
        if (/\.(emit|publish|dispatchEvent|notify)\s*\(/.test(line)) emitCount.set(n, (emitCount.get(n) ?? 0) + 1);
        if (/\.(on|once|addListener|subscribe)\s*\(/.test(line)) onCount.set(n, (onCount.get(n) ?? 0) + 1);
      }
    }
  }

  const findings: OrphanFinding[] = [];
  let truncated = walkTruncated;
  let lonelyN = 0, testOnlyN = 0, eventN = 0, twinsN = 0;

  const push = (f: OrphanFinding): boolean => {
    findings.push(f);
    return true;
  };

  for (const e of exports) {
    const refs = [...(refFiles.get(e.name) ?? [])].filter((f) => f !== e.file || false);
 // 同文件其他调用=合法接线(grepRefFiles 口径):refFiles 已含同文件引用行,按内容判过定义行,
 // 这里只需检查「除定义文件外是否还有引用」与「非测试引用是否存在」。
    const refsOther = refs.filter((f) => f !== e.file);
    const refsAny = refs.length > 0 || refsOther.length > 0;
    const isEntry = ENTRY_RE.test(e.file);
    if (!refsAny) {
      if (isEntry) continue; // 入口豁免
      if (lonelyN >= CAP_LONELY) { truncated = true; continue; }
      lonelyN++;
      push({
        kind: "lonely-export", file: e.file, line: e.line,
        title: `孤独导出: ${e.name} 全仓零引用`,
        detail: `导出符号在全仓(除定义文件)零引用——写了没接线,或是死代码。`,
      });
    } else if (refsOther.every((f) => isTestFile(f))) {
      if (testOnlyN >= CAP_TEST_ONLY) { truncated = true; continue; }
      testOnlyN++;
      push({
        kind: "test-only", file: e.file, line: e.line,
        title: `仅测试接线: ${e.name} 生产链路零调用`,
        detail: `引用全部来自测试文件([${refsOther.slice(0, 4).map((x) => x.split("/").pop()).join(", ")}]),生产代码没有任何调用方。`,
      });
    }
  }

  for (const ev of events) {
    if (eventN >= CAP_EVENT) { truncated = true; break; }
    if (ev.side === "emit" && (onCount.get(ev.name) ?? 0) === 0) {
      eventN++;
      push({
        kind: "orphan-event", file: ev.file, line: ev.line,
        title: `孤儿事件: emit "${ev.name}" 全仓无监听`,
        detail: `发出了事件但没有任何 .on/.once/subscribe 消费——跨模块接线缺失。`,
      });
    } else if (ev.side === "on" && (emitCount.get(ev.name) ?? 0) === 0) {
      eventN++;
      push({
        kind: "orphan-event", file: ev.file, line: ev.line,
        title: `孤儿监听: on "${ev.name}" 全仓无发出者`,
        detail: `注册了监听但没有任何 .emit/publish 发出该事件——回调永远不触发(死接线)。`,
      });
    }
  }

  {
    const seen = new Map<string, FnBody>();
    outer:
    for (const fn of fnBodies) {
      const prev = seen.get(fn.body);
      if (prev) {
        if (twinsN >= CAP_TWINS) { truncated = true; break outer; }
        twinsN++;
        push({
          kind: "twins", file: fn.file, line: fn.line,
          title: `双胞胎实现: ${fn.name} 与 ${prev.name} 函数体逐行相同`,
          detail: `与 ${prev.file}:${prev.line} 的 ${prev.name} 函数体逐行相同——复制漂移温床,应提取共用或删除。`,
        });
      } else {
        seen.set(fn.body, fn);
      }
    }
  }

  findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
  return { root, scope, scannedFiles: textFiles.length, findings, truncated, knownLimits };
}

// ---- 渲染 ----

const KIND_LABEL: Record<OrphanFinding["kind"], string> = {
  "lonely-export": "孤独导出",
  "test-only": "仅测试接线",
  "orphan-event": "孤儿事件",
  twins: "双胞胎实现",
};

export function renderOrphans(r: OrphanScanResult): string {
  const lines: string[] = [];
  lines.push(`孤儿审计: ${r.findings.length} 条(范围 ${r.scope};扫描文件 ${r.scannedFiles}${r.truncated ? ";已截断" : ""})`);
  if (r.findings.length === 0) {
    lines.push("  (零发现——未检出孤独导出/仅测试接线/孤儿事件/双胞胎实现;见已知边界)");
  }
  for (const f of r.findings) {
    lines.push(`  [${KIND_LABEL[f.kind]}] ${f.title}`);
    lines.push(`    ${f.file}:${f.line}`);
    lines.push(`    ${f.detail}`);
  }
  lines.push("");
  lines.push("已知边界");
  for (const l of r.knownLimits) lines.push(`  - ${l}`);
  return lines.join("\n");
}
