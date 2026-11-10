/**
 * senseB21:内嵌脚本索引(网页结构感知地基。
 * 盲区:panel.ts 这类单文件 SPA 的 JS 写在模板字符串/HTML <script> 块里——ts-morph 视之为
 * 字符串,内嵌函数(refreshModelPill/renderBoardCanvas 等)全不进索引,网页结构/前端路由/
 * 内嵌业务逻辑三重全盲。本模块对 *.ts 索引时额外提取「模板字符串里形似 JS 的片段」:
 *   - form A(script-block):HTML 生成模板里的 <script> 块(无 src、非 js 类型标注的跳过);
 *   - form B(template-js):整段就是 JS 源的超长模板字符串(function/=> 密度门)。
 * 每个片段按 `file:script-N` 虚拟单元用 tree-sitter javascript 解析,符号登记为虚拟符号:
 *   - file=宿主文件(原始 .ts,byFile/file 查询面直接可见);
 *   - kind="inline-js"(C2fNode.symKind 透传,与 function/method 区分);
 *   - container=`<模板变量名>·script-N`(与宿主 TS 符号 id 隔离,防同名互踩);
 *   - 行号=片段在宿主文件中的真实行(字节偏移换算;单行 ${} 插值替换为 undefined 不移行,
 *     含换行的插值才标 approx——panel.ts 主战场唯一插值 ${PRESETS_JSON} 为单行,精确)。
 * 防误伤:<style>/mermaid/纯文本不解析(密度门+<script> 语境门);tree-sitter 有 ERROR
 * 节点=整单元静默跳过(诚实降级,不产生半成品假符号)。
 * 边语义:内嵌 JS 是浏览器侧代码,永不解析到宿主仓的 TS/其它语言符号——调用目标只在
 * **同宿主文件的内嵌符号集**内按唯一名解析(跨单元可见,panel 单大 script 块的主形态),
 * 解析不到保持 toName 未解析边(to=""),不造跨语言假边。模块级调用归 `<module>` 虚调用方
 * (与 engine ts-morph 档同一约定)。
 */
import { SyntaxKind, type SourceFile } from "ts-morph";
import { loadTsParser } from "../adapters/tree-sitter.js";
import type { CallGraph, FlowEdge, Symbol } from "./engine";

/** 模块级虚调用方后缀(engine.MODULE_CALLER 同值;本地定义防 engine↔inline-js 运行时环)。 */
const MODULE_CALLER = "<module>";

// ---- 虚拟单元与提取 ----

export interface InlineJsUnit {
  /** 虚拟单元标识:`<宿主相对路径>:script-N`(form B 为 `:js-N`)。 */
  unit: string;
  /** 符号 container(唯一,防同文件两单元同名互踩):`<模板变量名>·script-N`。 */
  container: string;
  /** 可解析 JS 源(${} 插值已替换为 undefined 占位)。 */
  js: string;
  /** js 首行在宿主文件中的 1-based 行号(字节偏移换算)。 */
  startLine: number;
  /** true=存在含换行的 ${} 插值,行号可能漂移(诚实标注;panel 主战场为 false)。 */
  approxLines: boolean;
  form: "script-block" | "template-js";
  /** 宿主文件相对路径(登记/标注用)。 */
  hostRelFile: string;
}

/** <script> 块内容门槛:太短的(空块/一行 polyfill)不值得建单元。 */
const SCRIPT_MIN_JS_LEN = 64;
/** form B(整段模板即 JS)门槛:更严,防把提示词/SQL/mermaid 当 JS。 */
const TPL_JS_MIN_LEN = 512;
/** form B 密度门:function 声明 ≥2 且 function|=> 总密度 ≥4。 */
const TPL_JS_MIN_FN_DECLS = 2;
const TPL_JS_MIN_DENSITY = 4;

/** JS 密度(function 关键字 + 箭头出现次数;启发式主信号)。 */
function jsDensity(s: string): number {
  return (s.match(/\bfunction\b/g) ?? []).length + (s.match(/=>/g) ?? []).length;
}

/** 文本级预闸(毫秒级,不建 AST 就能排除绝大多数文件)。 */
export function inlineJsTextCandidate(full: string): boolean {
  if (full.includes("<script")) return true;
  if (full.length < TPL_JS_MIN_LEN) return false;
  return (full.match(/^[ \t]*function\s+[\w$]+\s*\(/gm) ?? []).length >= TPL_JS_MIN_FN_DECLS;
}

/** ${...} 插值替换为 undefined(无换行占位):tree-sitter 把 `${x}` 当语法错;
 * 替换后行数不变(单行插值)→ 行号映射保持精确;插值含换行=approx 诚实标注。
 * 括号深度扫描:嵌套 {}(如 ${JSON.stringify(x)})正确闭合。 */
function substituteInterpolations(js: string): { js: string; approx: boolean } {
  let out = "";
  let i = 0;
  let approx = false;
  while (i < js.length) {
    const at = js.indexOf("${", i);
    if (at === -1) {
      out += js.slice(i);
      break;
    }
    let depth = 1;
    let j = at + 2;
    while (j < js.length && depth > 0) {
      const ch = js[j];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (js.slice(at, j).includes("\n")) approx = true;
    out += js.slice(i, at) + "undefined";
    i = j;
  }
  return { js: out, approx };
}

/** 模板变量的归属名(const PAGE = `…` → "PAGE";其余形态空=用 "tpl")。 */
function templateVarName(node: { getParent: () => { getKind: () => SyntaxKind; getNameNode?: () => { getText(): string } } | undefined }): string {
  try {
    const p = node.getParent();
    if (!p) return "";
    if (p.getKind() === SyntaxKind.VariableDeclaration) {
      const t = p.getNameNode?.()?.getText().trim();
      if (t && /^[$_\w][$\w]*$/.test(t)) return t;
    }
  } catch {
    /* 归属名只是显示增强,失败=空 */
  }
  return "";
}

const SCRIPT_BLOCK_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;

/** 从 ts-morph SourceFile 提取全部内嵌 JS 虚拟单元(AST 定位模板边界,防字符串/注释里的假 backtick)。 */
export function extractInlineJsUnits(sf: SourceFile, relFile: string): InlineJsUnit[] {
  const full = sf.getFullText();
  const lineAt = (absOffset: number): number => full.lastIndexOf("\n", absOffset - 1) === -1 ? 1 : full.slice(0, absOffset).split("\n").length;
  const units: InlineJsUnit[] = [];
  let n = 0;
  const templates: { text: string; start: number; varName: string }[] = [];
  for (const kind of [SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateExpression] as const) {
    for (const node of sf.getDescendantsOfKind(kind)) {
      const text = node.getText();
      if (text.length < SCRIPT_MIN_JS_LEN) continue;
      templates.push({ text, start: node.getStart(), varName: templateVarName(node) });
    }
  }
  // 稳定序(文档序):两族 getDescendantsOfKind 各自有序,合并后按 start 排
  templates.sort((a, b) => a.start - b.start);
  for (const tpl of templates) {
    const hasScript = tpl.text.includes("<script");
    if (hasScript) {
      // form A:逐个 <script> 块(外链 src=/非 js type 跳过)
      SCRIPT_BLOCK_RE.lastIndex = 0;
      for (const m of tpl.text.matchAll(SCRIPT_BLOCK_RE)) {
        const attrs = m[1] ?? "";
        if (/\bsrc\s*=/.test(attrs)) continue;
        const typeM = /type\s*=\s*["']([^"']*)["']/i.exec(attrs);
        if (typeM && !/javascript|module|^text\/js$/i.test(typeM[1]!)) continue;
        const content = m[2]!;
        if (content.trim().length < SCRIPT_MIN_JS_LEN) continue;
        if (jsDensity(content) < 2 && !/\bfunction\s+[\w$]+\s*\(/.test(content)) continue; // 密度门:mermaid/纯 JSON-LD 不进
        n++;
        const tagEndRel = m.index + m[0].indexOf(">");
        const absContentStart = tpl.start + tagEndRel + 1;
        const sub = substituteInterpolations(content);
        units.push({
          unit: `${relFile}:script-${n}`,
          container: `${tpl.varName || "tpl"}·script-${n}`,
          js: sub.js,
          startLine: lineAt(absContentStart),
          approxLines: sub.approx,
          form: "script-block",
          hostRelFile: relFile,
        });
      }
    } else {
      // form B:整段模板即 JS(严密度门;tree-sitter hasError 是最终裁判)
      if (tpl.text.length < TPL_JS_MIN_LEN) continue;
      const fnDecls = (tpl.text.match(/^[ \t]*function\s+[\w$]+\s*\(/gm) ?? []).length;
      if (fnDecls < TPL_JS_MIN_FN_DECLS || jsDensity(tpl.text) < TPL_JS_MIN_DENSITY) continue;
      n++;
      const absContentStart = tpl.start + 1; // 跳过开 backtick
      const sub = substituteInterpolations(tpl.text.slice(1, -1));
      units.push({
        unit: `${relFile}:js-${n}`,
        container: `${tpl.varName || "tpl"}·js-${n}`,
        js: sub.js,
        startLine: lineAt(absContentStart),
        approxLines: sub.approx,
        form: "template-js",
        hostRelFile: relFile,
      });
    }
  }
  return units;
}

// ---- tree-sitter javascript 解析 ----

/** web-tree-sitter 节点(结构类型;parent 0.25 为属性,解析器接口未声明故此处可选)。 */
export interface JsNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column?: number };
  endPosition: { row: number; column?: number };
  text: string;
  childCount: number;
  children: JsNode[] | (() => JsNode[]);
  parent?: JsNode | null;
  child(i: number): JsNode | null;
  descendantsOfType(t: string): JsNode[];
}

export interface InlineJsDecl {
  name: string;
  kind: "function" | "arrow";
  /** 单元 js 内的 [start,end) 字节区间(内层函数归属判定用)。 */
  startIdx: number;
  endIdx: number;
  /** 单元内行(0-based;宿主行=startLine+row)。 */
  row: number;
  params: string[];
}

export interface InlineJsCall {
  name: string;
  startIdx: number;
  row: number;
}

export interface InlineJsAst {
  decls: InlineJsDecl[];
  calls: InlineJsCall[];
  root: JsNode;
 /** true=整段解析失败后按顶层声明切段容错解析(只覆盖无 ERROR 的段。 */
  partial?: boolean;
}

function childrenOf(node: JsNode): JsNode[] {
  const c = node.children;
  return typeof c === "function" ? c.call(node) : (c ?? []);
}

function childOfType(node: JsNode, type: string): JsNode | undefined {
  return childrenOf(node).find((c) => c.type === type);
}

function containsError(node: JsNode): boolean {
  if (node.type === "ERROR" || node.type.startsWith("missing")) return true;
  return childrenOf(node).some(containsError);
}

function validIdent(s: string | undefined): s is string {
  return !!s && /^[$_\w][$\w]*$/.test(s);
}

/** 形参名解析(纯名字,剥默认值/解构残留;JS 无类型注解)。 */
function paramNames(fnNode: JsNode): string[] {
  const params = childOfType(fnNode, "formal_parameters");
  if (!params) return [];
  const out: string[] = [];
  for (const c of childrenOf(params)) {
    if (c.type !== "identifier") continue;
    if (validIdent(c.text)) out.push(c.text);
  }
  return out.slice(0, 8);
}

/** 解析单元 JS(语言 wasm 缺失/语法 ERROR=undefined,诚实降级不吐半成品)。 */
export async function parseInlineJsAst(js: string): Promise<InlineJsAst | undefined> {
  const parser = await loadTsParser("javascript");
  if (!parser) return undefined;
  let tree: { rootNode: JsNode };
  try {
    tree = parser.parse(js);
  } catch {
    return undefined;
  }
  const root = tree.rootNode;
  if (!root || root.childCount === 0) return undefined;
  if ((root as unknown as { hasError?: boolean }).hasError === true || containsError(root)) return undefined;

  const decls: InlineJsDecl[] = [];
  // function NAME(...) {...}(嵌套也收:内层函数是合法调用归属目标)
  for (const f of root.descendantsOfType("function_declaration")) {
    const name = childOfType(f, "identifier")?.text;
    if (!validIdent(name)) continue;
    decls.push({ name, kind: "function", startIdx: f.startIndex, endIdx: f.endIndex, row: f.startPosition.row, params: paramNames(f) });
  }
  // const/let/var NAME = (...) => {} | function(){}
  for (const ld of [...root.descendantsOfType("lexical_declaration"), ...root.descendantsOfType("variable_declaration")]) {
    for (const vd of ld.descendantsOfType("variable_declarator")) {
      const nameNode = childOfType(vd, "identifier");
      const kids = childrenOf(vd);
      const init = kids[kids.length - 1];
      if (!nameNode || !init || (init.type !== "arrow_function" && init.type !== "function_expression")) continue;
      if (!validIdent(nameNode.text)) continue;
      decls.push({ name: nameNode.text, kind: "arrow", startIdx: vd.startIndex, endIdx: init.endIndex, row: vd.startPosition.row, params: paramNames(init) });
    }
  }

  const calls: InlineJsCall[] = [];
  for (const c of root.descendantsOfType("call_expression")) {
    const first = childrenOf(c)[0];
    const t = first?.text?.trim();
    if (!t) continue;
    const name = t.includes(".") ? t.split(".").at(-1)! : t;
    if (!validIdent(name)) continue;
    calls.push({ name, startIdx: c.startIndex, row: c.startPosition.row });
  }
  return { decls, calls, root };
}

/** 顶层声明行(分段容错锚):列 0 的 function/class/const/let/var 声明。
 *  只认行首——函数体内的同名声明都缩进,不会误切。 */
const TOP_DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function\s+[\w$]+\s*\(|class\s+[\w$]+|(?:const|let|var)\s+[\w$]+\s*=)/;

interface JsSegment { text: string; /** 段首在整段 js 里的字符偏移 */ baseIdx: number; /** 段首行(0-based) */ startRow: number }

/** 按顶层声明切段:大内联脚本(panel 主脚本 1.37MB)tree-sitter 整段解析会因
 *  局部语法 ERROR 整单元判死 → 上千函数全丢。切段后逐段解析,坏段只丢自己,好段照常登记。
 *  切分点=「上一行是空行」后的列 0 声明行;声明之间的顶层语句归前一段。 */
function splitJsSegments(js: string): JsSegment[] {
  const lines = js.split("\n");
  const starts: { line: number; idx: number }[] = [];
  let idx = 0;
  let prevBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0 || (prevBlank && TOP_DECL_RE.test(line))) starts.push({ line: i, idx });
    prevBlank = line.trim() === "";
    idx += line.length + 1; // + "\n"
  }
  if (starts.length <= 1) return [{ text: js, baseIdx: 0, startRow: 0 }];
  const segs: JsSegment[] = [];
  for (let k = 0; k < starts.length; k++) {
    const cur = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]!.idx : js.length;
    segs.push({ text: js.slice(cur.idx, end), baseIdx: cur.idx, startRow: cur.line });
  }
  return segs;
}

/** 容错解析:先整段解析(好文件零行为变化);失败→按顶层声明切段逐段解析,
 *  只收「无 ERROR」的段,行号/字符偏移按段基址回填到整段坐标系。坏段不产生半成品符号。
 *  全段都无法解析才返回 undefined(保持原有诚实降级)。 */
export async function parseInlineJsAstTolerant(js: string): Promise<InlineJsAst | undefined> {
  const full = await parseInlineJsAst(js);
  if (full) return full;
  const parser = await loadTsParser("javascript");
  if (!parser) return undefined;
  const segs = splitJsSegments(js);
  if (segs.length <= 1) return undefined;
  const decls: InlineJsDecl[] = [];
  const calls: InlineJsCall[] = [];
  let root: JsNode | undefined;
  let okSegments = 0;
  for (const seg of segs) {
    let tree: { rootNode: JsNode };
    try {
      tree = parser.parse(seg.text);
    } catch {
      continue;
    }
    const r = tree.rootNode;
    if (!r || r.childCount === 0) continue;
    if ((r as unknown as { hasError?: boolean }).hasError === true || containsError(r)) continue; // 坏段只丢自己
    okSegments++;
    root ??= r;
    for (const f of r.descendantsOfType("function_declaration")) {
      const name = childOfType(f, "identifier")?.text;
      if (!validIdent(name)) continue;
      decls.push({ name, kind: "function", startIdx: seg.baseIdx + f.startIndex, endIdx: seg.baseIdx + f.endIndex, row: seg.startRow + f.startPosition.row, params: paramNames(f) });
    }
    for (const ld of [...r.descendantsOfType("lexical_declaration"), ...r.descendantsOfType("variable_declaration")]) {
      for (const vd of ld.descendantsOfType("variable_declarator")) {
        const nameNode = childOfType(vd, "identifier");
        const kids = childrenOf(vd);
        const init = kids[kids.length - 1];
        if (!nameNode || !init || (init.type !== "arrow_function" && init.type !== "function_expression")) continue;
        if (!validIdent(nameNode.text)) continue;
        decls.push({ name: nameNode.text, kind: "arrow", startIdx: seg.baseIdx + vd.startIndex, endIdx: seg.baseIdx + init.endIndex, row: seg.startRow + vd.startPosition.row, params: paramNames(init) });
      }
    }
    for (const c of r.descendantsOfType("call_expression")) {
      const first = childrenOf(c)[0];
      const t = first?.text?.trim();
      if (!t) continue;
      const name = t.includes(".") ? t.split(".").at(-1)! : t;
      if (!validIdent(name)) continue;
      calls.push({ name, startIdx: seg.baseIdx + c.startIndex, row: seg.startRow + c.startPosition.row });
    }
  }
  if (!root || okSegments === 0) return undefined;
  return { decls, calls, root, partial: true };
}

// ---- 引擎集成(buildCallGraph / buildCallGraphFromFiles 的 Pass 3.5) ----

/** 纯噪声调用名(未解析时不值得进边表;$ 为 panel 的 getElementById 惯用缩写)。 */
const NOISE_CALL_NAMES = new Set([
  "$", "addEventListener", "removeEventListener", "querySelector", "querySelectorAll",
  "getElementById", "createElement", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "fetch", "alert", "confirm", "prompt",
  "log", "warn", "error", "info", "debug", "stringify", "parse", "now", "keys", "values",
  "entries", "includes", "indexOf", "split", "join", "slice", "trim", "replace", "match",
  "forEach", "map", "filter", "find", "some", "every", "reduce", "push", "pop", "shift",
  "classList", "style", "dataset", "focus", "click", "remove", "append", "prepend",
  "getItem", "setItem", "removeItem", "valueOf", "toString",
]);

export interface InlineJsCollectStat { units: number; symbols: number; edges: number; skippedUnits: number; partialUnits?: number }

/**
 * 单文件内嵌脚本收集:符号(虚拟)+ 边(inline 作用域解析)并入 CallGraph。
 * 任何失败=该文件零产出(静默诚实降级),绝不抛出毙掉整图构建。
 */
export async function collectInlineJs(sf: SourceFile, graph: CallGraph, root: string): Promise<InlineJsCollectStat | null> {
  const full = sf.getFullText();
  if (!inlineJsTextCandidate(full)) return null;
  const absFile = sf.getFilePath();
  const relFile = absFile.replace(root + "/", "");
  const units = extractInlineJsUnits(sf, relFile);
  if (units.length === 0) return null;
  const stat: InlineJsCollectStat = { units: 0, symbols: 0, edges: 0, skippedUnits: 0 };
  const asts: { unit: InlineJsUnit; ast: InlineJsAst }[] = [];
  // Pass 1:符号登记(全部单元先登记完,跨单元名字才可见)
  const inlineIds = new Map<string, string[]>();
  for (const u of units) {
 // 容错解析——整段 ERROR 时按顶层声明切段,坏段只丢自己(panel 主脚本 1.37MB
    // 整段曾直接判死,上千函数全丢);好文件走原整段路径,零行为变化。
    const ast = await parseInlineJsAstTolerant(u.js);
    if (!ast) {
      stat.skippedUnits++;
      continue;
    }
    if (ast.partial) stat.partialUnits = (stat.partialUnits ?? 0) + 1;
    asts.push({ unit: u, ast });
    stat.units++;
    for (const d of ast.decls) {
      const id = `${absFile}#${u.container}.${d.name}`;
      if (graph.symbols.has(id)) continue; // 同单元同名(函数/const 双形态)取先登记者
      const sym: Symbol = {
        name: d.name,
        id,
        kind: "inline-js",
        file: absFile,
        line: u.startLine + d.row,
        container: u.container,
        tier: "structural",
        signature: { params: d.params.map((p) => ({ name: p })) },
      };
      graph.symbols.set(id, sym);
      stat.symbols++;
      const list = inlineIds.get(d.name) ?? [];
      list.push(id);
      inlineIds.set(d.name, list);
    }
  }
  // byName 登记(在符号全量登记后,与 mergeStructAdapters 的 lexical 纪律无关——inline-js
  // 是结构档全功能符号,参与唯一名/trunk-leaf 语义)
  for (const [name, ids] of inlineIds) {
    const list = graph.byName.get(name) ?? [];
    for (const id of ids) if (!list.includes(id)) list.push(id);
    graph.byName.set(name, list);
  }
  // Pass 2:边(目标只在同宿主文件 inline 符号集内解析;唯一才认)
  for (const { unit, ast } of asts) {
    for (const call of ast.calls) {
      const targets = inlineIds.get(call.name) ?? [];
      const toId = targets.length === 1 ? targets[0]! : "";
      if (!toId && NOISE_CALL_NAMES.has(call.name)) continue; // 纯噪声未解析调用不进边表
      // 归属:包含该调用点的最内层声明;无=模块级 <module>(顶层 onclick 接线的主形态)
      let callerDecl: InlineJsDecl | undefined;
      for (const d of ast.decls) {
        if (call.startIdx >= d.startIdx && call.startIdx < d.endIdx) {
          if (!callerDecl || d.endIdx - d.startIdx < callerDecl.endIdx - callerDecl.startIdx) callerDecl = d;
        }
      }
      const callerId = callerDecl ? `${absFile}#${unit.container}.${callerDecl.name}` : `${absFile}#${MODULE_CALLER}`;
      const edge: FlowEdge = {
        from: callerId,
        to: toId,
        toName: call.name,
        file: relFile,
        line: unit.startLine + call.row,
        tier: "structural",
        evidenceKind: toId ? "ast" : "inferred",
      };
      const out = graph.outEdges.get(callerId) ?? [];
      out.push(edge);
      graph.outEdges.set(callerId, out);
      if (toId) {
        const inc = graph.inEdges.get(toId) ?? [];
        inc.push(edge);
        graph.inEdges.set(toId, inc);
      }
      stat.edges++;
    }
  }
  return stat;
}
