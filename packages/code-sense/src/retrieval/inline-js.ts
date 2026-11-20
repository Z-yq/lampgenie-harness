/**
 * 内联 JS 感知( G-E,设计稿 06-code-sense §15.4):
 * 面板前端 JS 整体内嵌在 TS 模板字符串常量里(`export const PANEL_JS_CANVAS = \`…\`)——
 * tree-sitter 把宿主文件解析成一排字符串常量,串内的函数/类对 symbol/impact/branches
 * 全部不可见(经验证 `symbol cvEdgeInner` 未命中)。近 20 session 里这类地形是 grep 弃用
 * code_sense 的第一根因(§15.3 ①地形力)。
 * 本模块在 symbol miss 时兜底:文本扫描定义形态(`function X` / `const X =` / `class X`),
 * 用反引号状态机判定该行是否落在模板串内,命中则报 `[inline-js]` 并回链宿主常量。
 * 定位级(名字+行号+宿主),不建调用图(串内代码无类型证据,不猜边)。
 * 实现纪律:纯函数 + 只读;状态机覆盖 单/双引号串、行/块注释、转义;模板插值 `${}`
 * 内的嵌套引号/反引号按简化口径处理(嵌套模板罕见,误报由「索引未命中+定义形态」双闸兜住)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grepMatchesAny } from "../search.js";

/** 模板串内定义形态(词法级,不解析)。
 * -F 子串匹配后再做词边界复核,防 `myfunction foo` 命中 `function foo`。 */
const DEF_FORMS = ["function", "const", "let", "var", "class"] as const;
export type InlineDefForm = (typeof DEF_FORMS)[number];

export interface InlineJsDefHit {
 /** 宿主文件(相对 root 的 POSIX 路径;定义所在模板串就在这文件里)。 */
  file: string;
 /** 定义行(模板串内,1-based)。 */
  line: number;
  form: InlineDefForm;
 /** 宿主模板常量名(如 PANEL_JS_CANVAS);拿不到=undefined(仍在模板串内)。 */
  hostConst?: string;
 /** 宿主常量声明行。 */
  hostLine?: number;
 /** 行文本摘要。 */
  text: string;
}

export interface InlineJsResult {
  query: "inline-js";
  name: string;
  hits: InlineJsDefHit[];
 /** 扫描引擎(grep=rg/grep 复用;grepMatchesAny 内部自管回退,此处如实记录)。 */
  scanned: number;
  knownLimits: string[];
}

/** 词边界复核:定义名不能是更长标识符的一部分。 */
function hasWordBoundary(line: string, name: string, form: InlineDefForm): boolean {
  const re = new RegExp(
    `(?<![A-Za-z0-9_$])${form}\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`,
  );
  return re.test(line);
}

// ---- 反引号状态机 ----

interface TemplateSpan {
  startLine: number;
  hostConst?: string;
}

interface ScanState {
  spans: TemplateSpan[];
 /** 每行起始时是否在模板串内 + 所在 span 下标(-1=不在)。 */
  lineSpan: number[];
}

/** 宿主常量形态:`export const PANEL_JS_X = \``(允许 `: Type =` 注解)。 */
const HOST_DECL_RE = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/;

/**
 * 扫描一段源码,记录模板串 span 与每行的所属 span。
 * 状态:code / 'str' / "str" / `tpl` / 行注释 / 块注释;反斜杠转义在各态内生效。
 * 模板插值 ${…} 里的引号/反引号按字面处理(简化口径,嵌套模板罕见)。
 */
export function scanTemplateSpans(text: string): ScanState {
  const spans: TemplateSpan[] = [];
  const lineSpan: number[] = [];
  let state: "code" | "sq" | "dq" | "tpl" | "line-comment" | "block-comment" = "code";
  let curSpan = -1;
  let line = 1;
  const openSpan = (hostConst?: string) => {
    curSpan = spans.length;
    spans.push({ startLine: line, ...(hostConst ? { hostConst } : {}) });
  };
 // 记录行首所属 span(行号 line 从 1 起;在处理每行第一个字符前记)
  lineSpan[0] = curSpan;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      if (state === "line-comment") state = "code";
      lineSpan[line - 1] = state === "tpl" ? curSpan : -1;
      continue;
    }
    switch (state) {
      case "code": {
        if (c === "/" && next === "/") { state = "line-comment"; i++; continue; }
        if (c === "/" && next === "*") { state = "block-comment"; i++; continue; }
        if (c === "'") { state = "sq"; continue; }
        if (c === '"') { state = "dq"; continue; }
        if (c === "`") {
 // 宿主常量判定:本行反引号之前的文本是否以 `const X =` 收尾
          const lineStart = text.lastIndexOf("\n", i) + 1;
          const before = text.slice(lineStart, i);
          const m = HOST_DECL_RE.exec(before.trim());
          openSpan(m ? m[1] : undefined);
 // 同行开模板:该行从开串起算属于此 span(定义与开串同行的罕见形态也接住)
          if (lineSpan[line - 1] === -1) lineSpan[line - 1] = curSpan;
          state = "tpl";
          continue;
        }
        continue;
      }
      case "sq":
        if (c === "\\") { i++; continue; }
        if (c === "'") state = "code";
        continue;
      case "dq":
        if (c === "\\") { i++; continue; }
        if (c === '"') state = "code";
        continue;
      case "tpl":
        if (c === "\\") { i++; continue; }
        if (c === "`") { state = "code"; curSpan = -1; }
        continue;
      case "line-comment":
      case "block-comment":
        if (state === "block-comment" && c === "*" && next === "/") { state = "code"; i++; }
        continue;
    }
  }
  return { spans, lineSpan };
}

/** 每行所属模板 span(-1=不在模板内);索引=行号-1。 */
function spanAtLine(st: ScanState, line: number): TemplateSpan | null {
  const idx = st.lineSpan[line - 1];
  return typeof idx === "number" && idx >= 0 ? st.spans[idx]! : null;
}

const INLINE_JS_MAX_HITS = 12;
const INLINE_JS_MAX_FILE_BYTES = 2_000_000;

/** 主入口:找 `name` 在模板字符串常量内的定义点(symbol miss 兜底;只读,不建索引)。 */
export async function findInlineJsDefs(rootInput: string, name: string): Promise<InlineJsResult> {
  const root = rootInput;
  const knownLimits = [
    "判定口径:定义形态(function/const/let/var/class + 词边界)且行落在模板串内(反引号状态机;插值 ${} 内嵌套引号按简化口径,罕见形态可能漏)。",
    "定位级产物:名字+行号+宿主常量;内联代码无类型证据,不建调用边——引用面用 refs <名>(文本面)。",
  ];
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return { query: "inline-js", name, hits: [], scanned: 0, knownLimits: [...knownLimits, "名字必须是合法标识符。"] };
  }
  const patterns = DEF_FORMS.map((f) => `${f} ${name}`);
  let raw: Awaited<ReturnType<typeof grepMatchesAny>> = [];
  try {
    raw = await grepMatchesAny(root, patterns, {
      glob: "*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}",
      max: 400,
      perFile: 8,
    });
  } catch {
    raw = [];
  }
  const hits: InlineJsDefHit[] = [];
  const seen = new Set<string>();
  const fileCache = new Map<string, ScanState | null>();
  const stateOf = (file: string): ScanState | null => {
    if (fileCache.has(file)) return fileCache.get(file)!;
    let st: ScanState | null = null;
    try {
      const abs = join(root, file);
      const buf = readFileSync(abs);
      if (buf.length <= INLINE_JS_MAX_FILE_BYTES && !buf.subarray(0, Math.min(8192, buf.length)).includes(0)) {
        st = scanTemplateSpans(buf.toString("utf8"));
      }
    } catch {
      st = null;
    }
    fileCache.set(file, st);
    return st;
  };
  for (const m of raw) {
    if (hits.length >= INLINE_JS_MAX_HITS) break;
    const file = m.file.split("\\").join("/");
    if (seen.has(`${file}:${m.line}`)) continue;
    for (const form of DEF_FORMS) {
      if (!m.text.includes(`${form} ${name}`)) continue;
      if (!hasWordBoundary(m.text, name, form)) continue;
      const st = stateOf(file);
      if (!st) continue;
      const span = spanAtLine(st, m.line);
      if (!span) continue; // 不在模板串内=真实源码符号(索引该管;不归 inline-js 报)
      seen.add(`${file}:${m.line}`);
      hits.push({
        file,
        line: m.line,
        form,
        ...(span.hostConst ? { hostConst: span.hostConst, hostLine: span.startLine } : {}),
        text: m.text.trim().slice(0, 160),
      });
      break;
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { query: "inline-js", name, hits, scanned: raw.length, knownLimits };
}

/** 渲染:miss 文本后追加的 [inline-js] 段。 */
export function renderInlineJsDefs(r: InlineJsResult): string {
  if (r.hits.length === 0) return "";
  const lines: string[] = [];
  lines.push(`[inline-js] 在模板字符串常量内发现 ${r.hits.length} 处 "${r.name}" 定义(符号索引不可见——tree-sitter 只见宿主字符串常量,不见串内 JS):`);
  for (const h of r.hits) {
    const host = h.hostConst ? `(宿主 ${h.hostConst} @ :${h.hostLine})` : "(宿主常量未定位)";
    lines.push(`  ${h.form} ${r.name} — ${h.file}:${h.line} ${host}`);
    lines.push(`    ${h.text}`);
  }
  lines.push(`提示:内联函数无调用图(串内代码无类型证据);文本引用面用 refs ${r.name},宿主文件符号表用 file <宿主文件>。`);
  return lines.join("\n");
}
