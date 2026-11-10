/**
 * 字面量引用面(refs):删除/修改一个「字符串标识」时的确定性引用清单。
 * 背景(验收盲区):删除 `action === "graph"` 这类字符串标识时,symbol/impact 全空
 * (它不是符号)、review --scan 0 条、explore 不命中——只能手工 grep。本模块把这件事
 * 做成一等能力:
 *   扫描面 = 产品源码 + 测试 + 文档/agent 提示词文本;
 *   每条命中按语境分类:case-literal / eq-literal / z-literal / object-key /
 *   string-literal / doc,带 file:line 与所属符号(静态索引在场时,取最近前置声明);
 *   末尾给代码/测试/文档统计与可复制的下一步(impact <所属符号>)。
 * 实现纪律:
 *  - 纯分类函数(classifyLiteralOccurrences)可单测;扫描引擎优先复用 search.ts 的
 *    rg/grep 通道,不可用时回退本文件自实现的文件遍历(不加依赖);
 *  - 默认排除 node_modules/dist/.genie/vendor(路径段口径);不读二进制/超大文件;
 *  - 诚实:所属符号拿不到就留空;截断/降级写进 knownLimits,不静默。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { grepMatchesAny } from "../search.js";
import { isDocLikePath, isTestPath } from "../path-filter";
import { loadIndexCached } from "./symbol-recall.js";
import type { C2fNode } from "../callgraph/c2f";
import type { DecisionPoint } from "../sensing/decision.js";

// ---- 语境分类 ----

export const LITERAL_REF_CONTEXTS = [
  "case-literal",
  "eq-literal",
  "z-literal",
  "object-key",
  "cpp-macro",
  "string-literal",
  "build-file",
  "doc",
] as const;

export type LiteralRefContext = (typeof LITERAL_REF_CONTEXTS)[number];

export const CONTEXT_LABEL: Record<LiteralRefContext, string> = {
  "case-literal": 'case "x":',
  "eq-literal": '=== / !== / == "x"',
  "z-literal": 'z.literal("x")',
  "object-key": "对象键 { x: } / \"x\":",
  "cpp-macro": "#ifdef / #if defined / #define 宏引用",
  "string-literal": "其它字符串(消息/错误串/提示词)",
  "build-file": "构建文件(CMake/Make/meson/bazel)",
  doc: "文档 .md",
};

export type LiteralRefKind = "code" | "test" | "doc" | "build";

export interface LiteralRefHit {
  /** 相对 root 的 POSIX 路径。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  context: LiteralRefContext;
  kind: LiteralRefKind;
  /** 行文本摘要(trim 后截断)。 */
  text: string;
  /** 所属符号(静态索引中该文件内最近的前置声明);拿不到=缺省。 */
  symbol?: string;
 /** 最内层决策点(if/elif/else/while/for/switch/case——条件键落在哪个分支体。 */
  decision?: { kind: string; condition?: string; line: number };
  /** ±2 行源码预览(仅结构位点且代码命中 ≤40 时;行格式 `>N | text`)。 */
  preview?: string[];
}

export interface LiteralRefsTotals {
  hits: number;
  files: number;
  code: number;
  test: number;
  doc: number;
 /** 构建文件命中(CMake/Make/meson/bazel; 新增)。 */
  build: number;
  byContext: Record<LiteralRefContext, number>;
}

export interface LiteralRefsResult {
  query: "refs";
  root: string;
  literal: string;
  groups: Record<LiteralRefContext, LiteralRefHit[]>;
  /** 全量命中(按语境序 + file/line 排序;与 groups 同一份对象)。 */
  hits: LiteralRefHit[];
  totals: LiteralRefsTotals;
  /** 被过滤器丢掉的条数(诚实计数:排除目录/--no-tests/--no-docs)。 */
  filtered: { excludedDirs: number; tests: number; docs: number };
  /** 可复制的下一步(impact <所属符号> / symbol / explore)。 */
  nextSteps: string[];
  /** 静态索引不可用=所属符号全会留空(不猜)。 */
  indexAvailable: boolean;
  /** 扫描引擎:grep=rg/grep 复用;walk=自实现遍历(降级)。 */
  engine: "grep" | "walk";
  /** 实际遍历过的候选文件数(仅 walk 引擎回报;grep 通道不回该数,缺席=不知道)。 */
  scannedFiles?: number;
  truncated: boolean;
  knownLimits: string[];
}

export interface LiteralRefsOptions {
  /** 含测试文件(缺省 true;删除动作必须看测试)。 */
  includeTests?: boolean;
  /** 含文档/提示词文本(缺省 true;删除动作必须看文档)。 */
  includeDocs?: boolean;
  /** 扫描引擎:grep(缺省,复用 rg/grep)或 walk(自实现文件遍历)。 */
  engine?: "grep" | "walk";
  /** 总命中上限(缺省 5000)。 */
  maxHits?: number;
  /** 单文件命中上限(缺省 500)。 */
  maxPerFile?: number;
  /** walk 引擎的文件数上限(缺省 20000)。 */
  maxFiles?: number;
  /** 单文件字节上限(缺省 1.5MB)。 */
  maxFileBytes?: number;
  /** 未加引号的标识符出现也算命中(缺省 false = refs 工具口径逐字不变)。
   *  概念足迹(surface)要的是「概念出现在哪」,不是「是不是字面量」——由它显式打开。 */
  includeBare?: boolean;
}

/** 默认排除目录段(路径任一段命中即排除;.git 必须排除,其余按产品口径)。 */
export const DEFAULT_EXCLUDE_DIRS = ["node_modules", "dist", ".genie", "vendor", ".git"] as const;

const REFS_GLOB =
  "*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,go,java,rs,c,h,cc,cpp,hpp,cxx,cs,rb,php,swift,kt,kts," +
  "scala,sh,bash,zsh,ps1,lua,dart,sql,proto,graphql,gql,json,jsonc,yaml,yml,toml,cmake,mk,bazel," +
  "md,mdx,markdown,rst,adoc,asciidoc,txt,html}";
/** 构建文件裸名(无扩展名,不能并进 REFS_GLOB 的 `*.{}`):单独作为 -g 传入。 */
const REFS_BUILD_GLOBS = ["Makefile", "makefile", "GNUmakefile", "meson.build", "BUILD", "BUILD.bazel", "WORKSPACE"];
const REFS_GLOBS = [REFS_GLOB, ...REFS_BUILD_GLOBS];

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".py", ".go", ".java", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".cs",
  ".rb", ".php", ".swift", ".kt", ".kts", ".scala", ".sh", ".bash", ".zsh", ".ps1",
  ".lua", ".dart", ".sql", ".proto", ".graphql", ".gql",
  ".json", ".jsonc", ".yaml", ".yml", ".toml",
]);

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".asciidoc", ".txt"]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** 压缩产物(vendored minified bundle)不是可编辑源码:命中只会淹没真引用。 */
const MINIFIED_RE = /\.min\.(?:js|mjs|cjs|css)$/i;

export function isExcludedPath(rel: string): boolean {
  const p = toPosix(rel);
  if (MINIFIED_RE.test(p)) return true;
  return p.split("/").some((seg) => (DEFAULT_EXCLUDE_DIRS as readonly string[]).includes(seg));
}

function isCandidateFile(name: string): boolean {
  if (isBuildFileName(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot).toLowerCase();
  return CODE_EXTS.has(ext) || DOC_EXTS.has(ext);
}

/** 构建文件判定:CMakeLists.txt / Makefile 等此前被归进 doc(.txt)或直接不扫,
 *  导致 refs 查模块名时看不到 add_library/add_subdirectory 的接线点。 */
const BUILD_FILE_RE = /(^|\/)(CMakeLists\.txt|Makefile|makefile|GNUmakefile|meson\.build|BUILD|BUILD\.bazel|WORKSPACE)(\/|$)|\.(cmake|mk|bazel)$/;
function isBuildFileName(name: string): boolean {
  return /^(CMakeLists\.txt|Makefile|makefile|GNUmakefile|meson\.build|BUILD|BUILD\.bazel|WORKSPACE)$/.test(name)
    || /\.(cmake|mk|bazel)$/.test(name);
}
function isBuildFilePath(rel: string): boolean {
  return BUILD_FILE_RE.test(toPosix(rel));
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/") || t.startsWith("#");
}

function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface QuotedOccurrence {
  /** 开引号下标。 */
  start: number;
  /** 闭引号下标。 */
  end: number;
  /** 引号内原文。 */
  content: string;
}

/** 单行内的完整引号串(不跨行;转义内容按原文保留)。 */
function quotedOccurrences(line: string): QuotedOccurrence[] {
  const out: QuotedOccurrence[] = [];
  for (let i = 0; i < line.length; i++) {
    const q = line[i]!;
    if (q !== '"' && q !== "'" && q !== "`") continue;
    let j = i + 1;
    let content = "";
    let closed = false;
    while (j < line.length) {
      const c = line[j]!;
      if (c === "\\") {
        content += c;
        if (j + 1 < line.length) content += line[j + 1]!;
        j += 2;
        continue;
      }
      if (c === q) {
        closed = true;
        break;
      }
      content += c;
      j++;
    }
    if (closed) {
      // 模板插值 `${graph.x}` 是变量而不是字面量文本:剥离后再做内容判定
      // (否则 console.log(`...${graph.missing}...`) 会被记成 "graph" 的字面量引用)。
      const text = q === "`" ? content.replace(/\$\{[^}]*\}/g, "") : content;
      out.push({ start: i, end: j, content: text });
      i = j;
    }
  }
  return out;
}

/** string-literal 的子串口径:标识符形态按词边界匹配(错误串里的 `/graph/`、`action=graph`
 * 算命中;`graphify`/`paragraph` 不算),非标识符字面量按普通子串。 */
function containsLiteralText(haystack: string, literal: string): boolean {
  if (!isIdentifier(literal)) return haystack.includes(literal);
  const re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(literal)}(?![A-Za-z0-9_$])`);
  return re.test(haystack);
}

function objectKeyContext(pre: string, after: string, prevLine: string): boolean {
  if (!/^\s*:/.test(after)) return false;
  if (/[{,]\s*$/.test(pre)) return true;
 // 多行对象:`"graph": ...` 单独一行,上一非空行以 { 或, 结尾
  return /^\s*$/.test(pre) && /[{,]\s*$/.test(prevLine);
}

/** 未加引号键的值若是单个 PascalCase 标识符并以,; }) 收尾,多半是 TS 类型注解
 * (`graph: CallGraph`)而不是运行时对象字面量——不计 object-key,减少变量名/类型名噪声。 */
function valueLooksLikeType(afterColon: string): boolean {
  return /^\s*[A-Z][A-Za-z0-9_$]*\s*(?:[,;}\)]|$)/.test(afterColon);
}

function hasUnquotedKey(line: string, literal: string, prevLine: string): boolean {
  const esc = escapeRegExp(literal);
  // 行内对象:只认 `{ graph:`(首个键);`(a, graph: T)` 这类参数表不再误报。
  const inline = new RegExp(`\\{\\s*${esc}(?![\\w$])\\s*:`);
  const im = inline.exec(line);
  if (im && !valueLooksLikeType(line.slice(im.index + im[0].length))) return true;
 // 多行对象:`graph: ...` 单独一行,上一非空行以 { 或, 结尾。
  const lineStart = new RegExp(`^\\s*${esc}(?![\\w$])\\s*:`);
  const sm = lineStart.exec(line);
  if (sm && /[{,]\s*$/.test(prevLine) && !valueLooksLikeType(line.slice(sm[0].length))) return true;
  return false;
}

/**
 * 行内字面量的语境分类(纯函数,单测直测)。
 * - case/eq/z-literal/object-key 要求**完整**字面量(引号内逐字相等 / 键名相等);
 * - string-literal 按子串命中:错误串、提示词、消息串里出现即算(例:
 *   `"action 必须是 ... graph ..."` 是删除 graph 时必须同步修改的错误串)。
 * 一行可能有多个命中语境(如 `{ graph: "graph" }` 同时是 object-key + string-literal),
 * 返回去重后的语境集合。注释行只按 string-literal 记(不把注释里的 case 当分派)。
 */
export function classifyLiteralOccurrences(line: string, literal: string, prevLine = ""): LiteralRefContext[] {
  if (!literal) return [];
  const out = new Set<LiteralRefContext>();
  // C/C++ 预处理行以 # 开头,不是注释(isCommentLine 的 Python 口径会误判)。
  const preproc = /^\s*#\s*(?:if|ifdef|ifndef|elif|define|undef)\b/.test(line);
  const commentOnly = !preproc && isCommentLine(line);
  for (const occ of quotedOccurrences(line)) {
    const exact = occ.content === literal;
    const contains = exact || containsLiteralText(occ.content, literal);
    if (!contains) continue;
    if (commentOnly || !exact) {
      // 注释里的提及 / 长串内出现:只能归到 string-literal(不做语境臆测)
      out.add("string-literal");
      continue;
    }
    const pre = line.slice(0, occ.start);
    const after = line.slice(occ.end + 1);
    if (/z\.literal\(\s*$/.test(pre)) out.add("z-literal");
    else if (/\bcase\s+$/.test(pre)) out.add("case-literal");
    else if (/(?:===|!==|==)\s*$/.test(pre)) out.add("eq-literal");
    else if (objectKeyContext(pre, after, prevLine)) out.add("object-key");
    else out.add("string-literal");
  }
  if (!commentOnly && isIdentifier(literal) && !out.has("object-key") && hasUnquotedKey(line, literal, prevLine)) {
    out.add("object-key");
  }
 // P0:C/C++ 预处理宏引用(#ifdef USE_FIXED / #if defined(X) / #define X ...)。
  // 旧语境表只认引号字面量,构建开关/条件编译的引用整片漏掉——删宏时无法判断哪些实现被条件包裹。
  if (!commentOnly && isIdentifier(literal) && /^\s*#\s*(?:if|ifdef|ifndef|elif|define|undef)\b/.test(line)) {
    const words: string[] = line.replace(/^\s*#\s*\w+\s*/, "").match(/[A-Za-z_]\w*/g) ?? [];
    if (words.includes(literal)) out.add("cpp-macro");
  }
  return [...out];
}

// ---- 静态索引:所属符号 ----

interface OwnerIndex {
  byFile: Map<string, C2fNode[]>;
}

/** 只读现成索引(绝不触发构建);null=索引未就绪。节点按行号升序,二分取最近前置声明。 */
function loadOwnerIndex(root: string): OwnerIndex | null {
  const index = loadIndexCached(root);
  if (!index) return null;
  const byFile = new Map<string, C2fNode[]>();
  for (const n of index.nodes) {
    if (n.line <= 0) continue;
    const arr = byFile.get(n.file);
    if (arr) arr.push(n);
    else byFile.set(n.file, [n]);
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.line - b.line);
  return { byFile };
}

function ownerAt(idx: OwnerIndex | null, file: string, line: number): string | undefined {
  const nodes = idx?.byFile.get(file);
  if (!nodes || nodes.length === 0) return undefined;
  let lo = 0;
  let hi = nodes.length - 1;
  let best: C2fNode | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const n = nodes[mid]!;
    if (n.line <= line) {
      best = n;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best?.name;
}

// ---- 扫描引擎 ----

interface RawMatch {
  file: string;
  line: number;
  text: string;
  prevText?: string;
}

interface EngineResult {
  matches: RawMatch[];
  truncated: boolean;
  scannedFiles?: number;
}

async function grepMatches(root: string, literal: string, maxHits: number, perFile: number): Promise<EngineResult> {
  const raw = await grepMatchesAny(root, [literal], { glob: REFS_GLOBS, max: maxHits + 1, perFile });
  const truncated = raw.length > maxHits;
  return {
    matches: raw.slice(0, maxHits).map((m) => ({ file: toPosix(m.file), line: m.line, text: m.text })),
    truncated,
  };
}

/** 自实现文件遍历(无外部命令依赖;grep 通道不可用时的确定性回退)。 */
function walkMatches(root: string, literal: string, opts: {
  maxHits: number; maxPerFile: number; maxFiles: number; maxFileBytes: number;
}): EngineResult {
  const matches: RawMatch[] = [];
  let truncated = false;
  let scannedFiles = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    if (matches.length >= opts.maxHits) {
      truncated = true;
      break;
    }
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
      if (e.isDirectory()) {
        if (!isExcludedPath(rel)) stack.push(rel);
        continue;
      }
      if (!e.isFile() || !isCandidateFile(e.name)) continue;
      if (scannedFiles >= opts.maxFiles) {
        truncated = true;
        stack.length = 0;
        break;
      }
      scannedFiles++;
      const abs = join(root, rel);
      try {
        const st = statSync(abs);
        if (st.size > opts.maxFileBytes) continue;
        const buf = readFileSync(abs);
        const head = buf.subarray(0, Math.min(8192, buf.length));
        if (head.includes(0)) continue; // 二进制
        const text = buf.toString("utf8");
        if (!text.includes(literal)) continue;
        const lines = text.split("\n");
        let taken = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i]!.includes(literal)) continue;
          matches.push({
            file: rel,
            line: i + 1,
            text: lines[i]!,
            prevText: i > 0 ? lines[i - 1]! : "",
          });
          taken++;
          if (taken >= opts.maxPerFile || matches.length >= opts.maxHits) {
            truncated = true;
            break;
          }
        }
      } catch {
        // 读失败=如实缺席(不中断整轮)
      }
    }
  }
  return { matches, truncated, scannedFiles };
}

// ---- 主入口 ----

export async function scanLiteralRefs(
  rootInput: string,
  literal: string,
  opts: LiteralRefsOptions = {},
): Promise<LiteralRefsResult> {
  const root = resolve(rootInput);
  const includeTests = opts.includeTests !== false;
  const includeDocs = opts.includeDocs !== false;
  const maxHits = Math.max(1, opts.maxHits ?? 5000);
  const maxPerFile = Math.max(1, opts.maxPerFile ?? 500);
  const knownLimits: string[] = [
    "case/eq/z-literal/object-key 只认完整字面量;string-literal 按词边界子串(错误串/提示词里出现即算,graphify 不算)。拼接串/变量中转/模板插值不识别。",
    "所属符号取静态索引中该文件内最近的前置声明(嵌套取最内层);索引缺失或过期时留空,不猜。",
    `默认排除 ${DEFAULT_EXCLUDE_DIRS.join("/")}(路径段)与 *.min.js 压缩产物;二进制与 >${Math.round((opts.maxFileBytes ?? 1_500_000) / 1024)}KB 的文件不读。`,
    "文档命中=行内出现该文本(不做词边界/语境判定,短字面量在文档里的噪声会偏高)。",
    "代码命中带最内层决策点标注(if/elif/else/while/for/switch;tree-sitter 不可用/语言不支持/文件数超 120 时缺席);结构位点(case/eq/z-literal/object-key/cpp-macro)在代码命中 ≤40 时带 ±2 行预览。",
    "grep 引擎遵守 rg 的 .gitignore 与隐藏目录缺省;需要连隐藏目录一起扫时用 engine='walk'(CLI 暂未暴露该开关)。",
    `单文件命中上限 ${maxPerFile},总命中上限 ${maxHits}。`,
  ];
  const emptyGroups = (): Record<LiteralRefContext, LiteralRefHit[]> => ({
    "case-literal": [], "eq-literal": [], "z-literal": [], "object-key": [], "cpp-macro": [], "string-literal": [], "build-file": [], doc: [],
  });
  if (!literal) {
    knownLimits.unshift("需要非空字面量(不含引号,如 refs graph)。");
    return {
      query: "refs", root, literal: "", groups: emptyGroups(), hits: [],
      totals: { hits: 0, files: 0, code: 0, test: 0, doc: 0, build: 0, byContext: Object.fromEntries(LITERAL_REF_CONTEXTS.map((c) => [c, 0])) as Record<LiteralRefContext, number> },
      filtered: { excludedDirs: 0, tests: 0, docs: 0 },
      nextSteps: [], indexAvailable: loadOwnerIndex(root) !== null, engine: "grep", truncated: false, knownLimits,
    };
  }

  const engine = opts.engine ?? "grep";
  let used: "grep" | "walk" = engine;
  let result: EngineResult;
  if (engine === "walk") {
    result = walkMatches(root, literal, { maxHits, maxPerFile, maxFiles: opts.maxFiles ?? 20000, maxFileBytes: opts.maxFileBytes ?? 1_500_000 });
  } else {
    try {
      result = await grepMatches(root, literal, maxHits, maxPerFile);
    } catch (err) {
      used = "walk";
      knownLimits.unshift(`grep 通道不可用(${String(err instanceof Error ? err.message : err).slice(0, 160)}),已回退自实现文件遍历。`);
      result = walkMatches(root, literal, { maxHits, maxPerFile, maxFiles: opts.maxFiles ?? 20000, maxFileBytes: opts.maxFileBytes ?? 1_500_000 });
    }
  }

  const ownerIndex = loadOwnerIndex(root);
  if (!ownerIndex) {
    knownLimits.push("静态索引不可用(.genie/sense-index 无 index.json):所属符号全部留空;codesense index 构建后恢复。");
  }
  if (!includeTests) knownLimits.push("已排除测试文件(--no-tests)。");
  if (!includeDocs) knownLimits.push("已排除文档/提示词文本(--no-docs)。");
  if (result.truncated) knownLimits.push("命中达到上限,结果已截断(--json 同样截断)。");

  const fileLineCache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (fileLineCache.has(file)) return fileLineCache.get(file)!;
    let lines: string[] | null = null;
    try {
      lines = readFileSync(join(root, file), "utf8").split("\n");
    } catch {
      lines = null;
    }
    fileLineCache.set(file, lines);
    return lines;
  };

  const filtered = { excludedDirs: 0, tests: 0, docs: 0 };
  const hits: LiteralRefHit[] = [];
  const seen = new Set<string>();
  for (const m of result.matches) {
    const file = toPosix(m.file);
    if (isExcludedPath(file)) {
      filtered.excludedDirs++;
      continue;
    }
    const build = isBuildFilePath(file);
    const doc = !build && isDocLikePath(file);
    const test = isTestPath(file);
    if (doc && !includeDocs) {
      filtered.docs++;
      continue;
    }
    if (!doc && !build && test && !includeTests) {
      filtered.tests++;
      continue;
    }
    const kind: LiteralRefKind = build ? "build" : doc ? "doc" : test ? "test" : "code";
    const fileLines = linesOf(file);
    const lineText = fileLines?.[m.line - 1] ?? m.text;
    const prevText = fileLines ? (m.line > 1 ? fileLines[m.line - 2] ?? "" : "") : m.prevText ?? "";
    const contexts: LiteralRefContext[] = build
      ? ["build-file"]
      : doc
        ? ["doc"]
        : classifyLiteralOccurrences(lineText, literal, prevText);

 // 概念足迹(surface)要的是「概念出现在哪」,不是「是不是字面量」。
    // 旧口径只保留 classifyLiteralOccurrences 认得的引号语境行,未加引号的标识符出现
    // (类型名/函数名/import/使用点)contexts=[] → 整行被丢弃,symbol 面对「替换一个符号」
    // 是瞎的、链路图的 call 边也永远触发不了。includeBare 缺省 false,refs 工具行为逐字不变。
    if (opts.includeBare === true && contexts.length === 0 && !build && !doc && containsLiteralText(lineText, literal)) {
      contexts.push("string-literal");
    }
    const symbol = ownerAt(ownerIndex, file, m.line);
    const summary = lineText.trim().slice(0, 180);
    for (const context of contexts) {
      const key = `${file}:${m.line}:${context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ file, line: m.line, context, kind, text: summary, ...(symbol ? { symbol } : {}) });
    }
  }

  const order = new Map(LITERAL_REF_CONTEXTS.map((c, i) => [c, i]));
  hits.sort((a, b) =>
    (order.get(a.context) ?? 99) - (order.get(b.context) ?? 99)
    || a.file.localeCompare(b.file)
    || a.line - b.line);

  const groups = emptyGroups();
  const byContext = Object.fromEntries(LITERAL_REF_CONTEXTS.map((c) => [c, 0])) as Record<LiteralRefContext, number>;
  for (const h of hits) {
    groups[h.context].push(h);
    byContext[h.context]++;
  }
  const totals: LiteralRefsTotals = {
    hits: hits.length,
    files: new Set(hits.map((h) => h.file)).size,
    code: hits.filter((h) => h.kind === "code").length,
    test: hits.filter((h) => h.kind === "test").length,
    doc: hits.filter((h) => h.kind === "doc").length,
    build: hits.filter((h) => h.kind === "build").length,
    byContext,
  };

 // 决策点标注(ASR 考题盲区修复):代码命中挂「最内层决策点」——
  // 条件键落在哪个 if/while/for 分支体直接可见,分支语义不用再回源码;
  // 结构位点(case/eq/object-key/cpp-macro)在代码命中 ≤40 时附 ±2 行预览。
  {
    const codeHits = hits.filter((h) => h.kind === "code");
    if (codeHits.length > 0) {
      const { decisionLangOf, extractDecisionPoints, innermostDecisionAt } = await import("../sensing/decision.js");
      const ptsCache = new Map<string, DecisionPoint[] | null>();
      let parsedFiles = 0;
      const pointsOf = async (file: string): Promise<DecisionPoint[] | null> => {
        if (ptsCache.has(file)) return ptsCache.get(file)!;
        let pts: DecisionPoint[] | null = null;
        const lang = decisionLangOf(file);
        if (lang && parsedFiles < 120) {
          parsedFiles++;
          const lines = linesOf(file);
          if (lines && lines.length > 0) pts = await extractDecisionPoints(lang, lines.join("\n"));
        }
        ptsCache.set(file, pts);
        return pts;
      };
      for (const h of codeHits) {
        const pts = await pointsOf(h.file);
        if (!pts) continue;
        const pt = innermostDecisionAt(pts, h.line);
        if (pt) h.decision = { kind: pt.kind, ...(pt.condition ? { condition: pt.condition } : {}), line: pt.lineStart };
      }
      const structural = new Set<LiteralRefContext>(["case-literal", "eq-literal", "z-literal", "object-key", "cpp-macro"]);
      if (totals.code <= 40) {
        for (const h of hits) {
          if (h.kind !== "code" || !structural.has(h.context)) continue;
          const lines = linesOf(h.file);
          if (!lines) continue;
          const preview: string[] = [];
          for (let n = Math.max(1, h.line - 2); n <= Math.min(lines.length, h.line + 2); n++) {
            preview.push(`${n === h.line ? ">" : " "}${n} | ${lines[n - 1]!.trim().slice(0, 160)}`);
          }
          h.preview = preview;
        }
      }
    }
  }

  // 建议下一步的排序按语境精度加权:分派分支/字面量定义(case/eq/z-literal/object-key)
  // 比长串里顺带出现(string)更值得先看——删除动作的第一步应是改这些结构位点。
  const contextWeight: Record<LiteralRefContext, number> = {
    "case-literal": 4, "eq-literal": 4, "z-literal": 4, "object-key": 3, "cpp-macro": 4, "string-literal": 1, "build-file": 3, doc: 0,
  };
  // 只从生产代码符号里给建议(测试 helper 常含大量字面量,`impact fixture` 不是删除动作的下一步)。
  const kindWeight: Record<LiteralRefKind, number> = { code: 1, build: 0.9, test: 0, doc: 0 };
  const symbolScores = new Map<string, { hits: number; score: number }>();
  for (const h of hits) {
    if (!h.symbol) continue;
    // 注释里的提及仍计入引用清单(删动作时注释也该同步改),但不参与「下一步」符号排序。
    if (/^(\/\/|\/\*|\*|#)/.test(h.text)) continue;
    const cur = symbolScores.get(h.symbol) ?? { hits: 0, score: 0 };
    cur.hits++;
    cur.score += contextWeight[h.context] * kindWeight[h.kind];
    symbolScores.set(h.symbol, cur);
  }
  const topSymbols = [...symbolScores.entries()]
    .filter(([, v]) => v.score > 0)
    .sort((a, b) => b[1].score - a[1].score || b[1].hits - a[1].hits || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name]) => name);
  // 第一个「精确结构位点」(case/eq/z-literal)所在符号恒排第一:删除动作的第一跳是改分派分支,
  // 不该被长串里顺带出现的 string-literal 计数挤下去。
  const firstStructural = hits.find(
    (h) => h.symbol && h.kind === "code"
      && (h.context === "case-literal" || h.context === "eq-literal" || h.context === "z-literal"),
  )?.symbol;
  if (firstStructural) {
    const at = topSymbols.indexOf(firstStructural);
    if (at > 0) topSymbols.splice(at, 1);
    if (at !== 0) topSymbols.unshift(firstStructural);
  }
  const nextSteps: string[] = topSymbols.slice(0, 3).map((s) => `codesense impact ${s}`);
  if (hits.length === 0) {
    nextSteps.push(`codesense explore "${literal}"`);
  } else if (isIdentifier(literal)) {
    nextSteps.push(`codesense symbol ${literal}`);
  }

  return {
    query: "refs",
    root,
    literal,
    groups,
    hits,
    totals,
    filtered,
    nextSteps,
    indexAvailable: ownerIndex !== null,
    engine: used,
    ...(typeof result.scannedFiles === "number" ? { scannedFiles: result.scannedFiles } : {}),
    truncated: result.truncated,
    knownLimits,
  };
}

// ---- 渲染 ----

export function renderLiteralRefs(r: LiteralRefsResult): string {
  const lines: string[] = [];
  lines.push(`codesense refs "${r.literal}" — 字面量引用面`);
  lines.push(`  root: ${r.root}`);
  const ctxCounts = LITERAL_REF_CONTEXTS.map((c) => `${c.replace("-literal", "")} ${r.totals.byContext[c] ?? 0}`).join(" / ");
  lines.push(
    `  命中 ${r.totals.hits} 行 / ${r.totals.files} 文件` +
    `(代码 ${r.totals.code} / 测试 ${r.totals.test} / 构建 ${r.totals.build} / 文档 ${r.totals.doc})` +
    (r.engine === "walk" ? "(walk 遍历)" : ""),
  );
  lines.push(`  语境: ${ctxCounts}`);
  if (r.totals.hits === 0) {
    lines.push("");
    lines.push("(零命中——字面量可能未出现,或被默认排除目录/--no-tests/--no-docs 过滤;见已知边界)");
  }
  for (const ctx of LITERAL_REF_CONTEXTS) {
    const items = r.groups[ctx];
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`[${ctx}] ${items.length} 处 — ${CONTEXT_LABEL[ctx]}`);
    const cap = 40;
    for (const h of items.slice(0, cap)) {
      const sym = h.symbol ? `  [${h.symbol}]` : "";
      lines.push(`  ${h.file}:${h.line}${sym}`);
      lines.push(`    ${h.text || "(空行)"}`);
      if (h.decision) {
        lines.push(`    ⟂ ${h.decision.kind}${h.decision.condition ? ` ${h.decision.condition}` : ""} (@${h.decision.line})`);
      }
      if (h.preview) for (const p of h.preview) lines.push(`    ${p}`);
    }
    if (items.length > cap) lines.push(`  …还有 ${items.length - cap} 条(见 --json)`);
  }
  lines.push("");
  lines.push(`统计: 代码 ${r.totals.code} / 测试 ${r.totals.test} / 构建 ${r.totals.build} / 文档 ${r.totals.doc}(共 ${r.totals.hits} 行 / ${r.totals.files} 文件)`);
  if (r.filtered.excludedDirs + r.filtered.tests + r.filtered.docs > 0) {
    lines.push(
      `  已过滤: 排除目录 ${r.filtered.excludedDirs} / 测试 ${r.filtered.tests} / 文档 ${r.filtered.docs}`,
    );
  }
  if (r.nextSteps.length > 0) {
    lines.push("建议下一步:");
    for (const s of r.nextSteps) lines.push(`  ${s}`);
  }
  lines.push("已知边界");
  for (const l of r.knownLimits) lines.push(`  - ${l}`);
  return lines.join("\n");
}
