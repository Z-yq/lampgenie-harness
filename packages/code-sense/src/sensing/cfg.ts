/**
 * sensing/cfg:函数级控制流图——「这个函数到底怎么走」的语句级答案。
 * 与 flow 的分工:flow 画「模块/文件/函数之间谁调谁」;cfg 画**一个函数体内部**的真实走向:
 *   语句(原文压缩)+ if/elif/else 菱形条件(是/否边)+ while/for 回边(循环/退出)+
 *   switch/case(default 兜底)+ try/catch/finally(异常边)+ return/throw/break/continue +
 *   函数说明/模块常量注释(黄底 note)+ 调用标注。
 * 为什么:模块级方框+端点列表「不是人能看懂的」,示例是语句级流程图——
 * 每步写的是代码里的真实调用/判断/循环,读者不需要回源就能理解算法在做什么。
 * 纪律:
 *  - 诚实全量:节点不设上限(缺省 0=全画);--max-nodes 是显式 opt-in,截断如实登记。
 *  - 只画语法树里真实存在的语句/分支/循环;三元/短路表达式不拆成分支(knownLimits 登记)。
 *  - 跨函数不内联:每个函数一张图(调用点蓝框+调用清单);--depth 由 CLI 决定是否多出图。
 *  - 错误语法:整文件拒收(parser 有 ERROR 时不做半成品图),由调用方给可操作提示。
 *  - 语言族:py/ts/js/c/cpp/java/go(与 sensing/decision 同源;其余语言显式不支持)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTsParser, type TsLang } from "../adapters/tree-sitter";
import { decisionLangOf } from "./decision";

export type CfgNodeKind =
  | "start" | "end" | "stmt" | "call" | "cond" | "loop"
  | "return" | "throw" | "break" | "continue" | "merge" | "note" | "page";

export type CfgEdgeKind = "flow" | "true" | "false" | "loop" | "break" | "continue" | "return" | "throw" | "error" | "note" | "call";

export interface CfgNode {
  id: string;
  kind: CfgNodeKind;
  /** 展示文本(源码压缩;多行用 <br/> 由渲染层处理)。 */
  text: string;
  /** 完整源码文本(未截断,JSON/审计用)。 */
  code?: string;
  line?: number;
  lineEnd?: number;
  /** 语句上方紧邻注释(展示在框内第二行)。 */
  comment?: string;
  /** 本节点直接调用到的函数名(按出现顺序去重)。 */
  calls?: string[];
  /** 连续语句合并展示时,每条语句一行(渲染用;text 仍保留合并摘要)。 */
  lines?: string[];
  /** 循环/异常/with 分组 id。 */
  group?: string;
}

export interface CfgEdge {
  from: string;
  to: string;
  label?: string;
  kind: CfgEdgeKind;
}

export type CfgGroupKind = "loop" | "try" | "catch" | "finally" | "with";

export interface CfgGroup {
  id: string;
  kind: CfgGroupKind;
  label: string;
  line?: number;
  lineEnd?: number;
  parent?: string;
}

export interface CfgStats {
  statements: number;
  decisions: number;
  loops: number;
  calls: string[];
  returns: number;
  throws: number;
  /** McCabe 近似:1 + 条件/循环数。 */
  complexity: number;
}

/** 长函数分页(可读性切分,不丢节点/边):每页 ≤ ~22 个节点;跨页边变成
 * 「← 第 N 页」/「→ 第 N 页」跳转桩,原有标签(是/否/循环/返回)保留在边上。 */
export interface CfgPage {
  index: number;
  total: number;
  title: string;
  lineStart: number;
  lineEnd: number;
  statements: number;
  decisions: number;
  loops: number;
  /** 本页承载的真实节点 id(不含跨页桩;合并展示前)。 */
  nodeIds: string[];
  mermaid: string;
}

export interface CfgParam {
  /** 原始参数文本(含类型/默认值/修饰符)。 */
  raw: string;
  /** 尽力取出的参数名。 */
  name: string;
  type?: string;
  default?: string;
}

export interface CfgCallRef {
  name: string;
  file?: string;
  line?: number;
}

/**
 * 函数说明(参考 deepwiki-open 的页面结构:
 * Introduction / Key functions table / 每条带 file:line,不直接倾倒 docstring)。
 * 设计原则:
 *  - 事实分层:职责(首句)/输入(签名参数)/输出(return 表达式)/关键判断(CFG 菱形)/
 *    循环/异常/副作用(调用名启发式)/上下游(索引解析)/位置;
 *  - 原始 docstring 不丢,但降级为「源码注释/设计备注」,不再占据说明主位;
 *  - 每条都是确定性摘录;无注释就如实写「未写源码注释」,不编造职责。
 */
export interface CfgDescription {
  /** 一句话职责(源码注释首句;无注释=按函数名/签名推断,并标明来源)。 */
  purpose: string;
  /** 职责来源:docstring=源码注释首句;signature=无注释,按名字/签名推断。 */
  purposeSource: "docstring" | "signature";
  params: CfgParam[];
  returnType?: string;
  /** 关键 return 表达式(≤3)。 */
  returns: string[];
  /** 关键 raise/throw 表达式(≤3)。 */
  raises: string[];
  /** if/switch 条件文本(≤5)。 */
  keyConditions: string[];
  /** 循环头(≤3)。 */
  loops: string[];
  /** 调用名启发式识别出的外部动作(≤6;带类别)。 */
  sideEffects: { name: string; category: string }[];
  /** docstring 首句之后的设计备注(≤600)。 */
  details?: string;
  /** 完整源码注释(≤1200;JSON/details 用)。 */
  rawDoc?: string;
  /** 上游调用方(索引填充;CLI/wiki 可选)。 */
  callers?: CfgCallRef[];
  /** 下游被调方(索引解析填充;≤6)。 */
  callees?: CfgCallRef[];
}

export interface CfgFunction {
  name: string;
  /** Class.method / module.func(展示与定位用)。 */
  qualifiedName: string;
  className?: string;
  file: string;
  lang: string;
  line: number;
  lineEnd: number;
  /** 函数头(签名压缩,≤100 字符)。 */
  signature: string;
  /** 源码注释全文(上方注释/文档字符串;≤1200 字符)。 */
  doc?: string;
  /** 结构化函数说明(职责/输入/输出/判断/循环/异常/副作用/上下游)。 */
  description: CfgDescription;
  /** 图内黄色速览卡(函数速览 + 模块常量);完整说明在 description/页面表格。 */
  notes: { title: string; lines: string[] }[];
  nodes: CfgNode[];
  edges: CfgEdge[];
  groups: CfgGroup[];
  stats: CfgStats;
  /** 长函数的可读性分页(全图仍在 nodes/edges;页只影响展示)。 */
  pages?: CfgPage[];
  truncated: boolean;
  knownLimits: string[];
}

export interface CfgFileResult {
  file: string;
  lang: TsLang;
  functions: CfgFunction[];
  /** 模块级常量(name=value;note 用)。 */
  constants: { name: string; value: string; line: number }[];
  degraded: boolean;
  notes: string[];
}

export interface CfgCandidate {
  name: string;
  qualifiedName?: string;
  file: string;
  line: number;
  statements: number;
  decisions: number;
  loops: number;
  calls: number;
  /** CFG 节点数(透明呈现「为什么这个函数没入选」)。 */
  nodes: number;
  score: number;
  picked: boolean;
  /** 未选中/未定位的原因(诚实呈现)。 */
  reason?: string;
}

export interface PipelineCfg {
  pipelineId: string;
  title: string;
  /** 该管线画的函数(按「入口优先 + 复杂度」排序)。 */
  functions: CfgFunction[];
  /** 考虑过的候选函数(含未选中原因)。 */
  candidates: CfgCandidate[];
  notes: string[];
}

// ---- tree-sitter 节点最小接口(同 sensing/decision;web-tree-sitter 的 child 访问
//      每次可能返回新包装对象,引用比较不可靠,节点身份一律用「类型@行界」) ----

interface TsNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  childCount: number;
  childForFieldName(f: string): TsNode | null;
  children: TsNode[] | (() => TsNode[]);
  namedChildren?: TsNode[] | (() => TsNode[]);
  isNamed?: boolean;
  text: string;
}

function childrenOf(n: TsNode): TsNode[] {
  const c = n.children;
  return typeof c === "function" ? c.call(n) : (c ?? []);
}

function namedChildrenOf(n: TsNode): TsNode[] {
  const c = n.namedChildren;
  if (c) return typeof c === "function" ? c.call(n) : c;
  return childrenOf(n).filter((x) => x.isNamed !== false);
}

function nodeKey(n: TsNode): string {
  return `${n.type}@${n.startPosition.row}-${n.endPosition.row}`;
}

type Family = "py" | "js" | "c" | "java" | "go";

function familyOf(lang: TsLang): Family {
  if (lang === "python") return "py";
  if (lang === "javascript" || lang === "typescript") return "js";
  if (lang === "c" || lang === "cpp") return "c";
  if (lang === "java") return "java";
  return "go";
}

const row = (n: TsNode): number => n.startPosition.row + 1;
const endRow = (n: TsNode): number => n.endPosition.row + 1;

// ---- 文本工具 ----

function condense(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

const MAX_STMT = 160;
const MAX_COND = 90;

function stmtText(n: TsNode): string {
  return clip(condense(n.text), MAX_STMT);
}

function condText(n: TsNode | null | undefined): string {
  if (!n) return "";
  let t = condense(n.text);
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let ok = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0 && i < t.length - 1) { ok = false; break; }
    }
    if (!ok) break;
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/;\s*$/, "");
  return clip(t, MAX_COND);
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment", "documentation_comment"]);

function isComment(n: TsNode): boolean {
  return COMMENT_TYPES.has(n.type);
}

function stripCommentMarkers(s: string): string {
  return s
    .replace(/^\/\*+!?/, "")
    .replace(/\*\/$/, "")
    .replace(/^\s*\/\/+\s?/, "")
    .replace(/^\s*#+\s?/, "")
    .replace(/^\s*\*+\s?/, "")
    .trim();
}

function commentText(n: TsNode): string {
  const lines = n.text.split(/\r?\n/).map(stripCommentMarkers).filter(Boolean);
  return clip(condense(lines.join(" ")), 140);
}

/** 上方紧邻的注释块(JS/TS/Java/C 的 /** *\/ 文档注释在函数节点之外)。
 * `#` 只在 Python 是注释;C 的 `#define` 是预处理指令,不能当说明。 */
function docAbove(lines: string[], startLine1: number, family: Family): string | undefined {
  const out: string[] = [];
  let i = startLine1 - 2;
  let sawBlank = false;
  while (i >= 0 && out.length < 14) {
    const t = lines[i]!.trim();
    if (!t) {
      if (sawBlank) break;
      sawBlank = true;
      i--;
      continue;
    }
    const marker = family === "py" ? /^(\/\/|#|\*|\/\*|\*\/)/ : /^(\/\/|\*|\/\*|\*\/)/;
    if (marker.test(t)) {
      out.unshift(t);
      sawBlank = false;
      i--;
      continue;
    }
    break;
  }
  const text = condense(out.map(stripCommentMarkers).filter(Boolean).join(" "));
  return text ? clip(text, 1200) : undefined;
}

/** Python 文档字符串(函数体首个 expression_statement 的字符串)。 */
function pyDocstring(body: TsNode): string | undefined {
  const first = namedChildrenOf(body)[0];
  if (!first || first.type !== "expression_statement") return undefined;
  const s = namedChildrenOf(first)[0];
  if (!s || (s.type !== "string" && s.type !== "string_literal")) return undefined;
  const raw = s.text.trim();
  const q = raw.startsWith('"""') || raw.startsWith("'''") ? 3 : 1;
  const text = condense(raw.slice(q, raw.length - q).split(/\r?\n/).join(" "));
  return text ? clip(text, 1200) : undefined;
}

// ---- 语句分类 ----

type StmtClass =
  | "comment" | "simple" | "call" | "return" | "throw" | "break" | "continue"
  | "if" | "loop" | "do" | "switch" | "try" | "with" | "block" | "nested" | "skip" | "match";

const BLOCK_TYPE: Record<Family, string> = {
  py: "block", js: "statement_block", c: "compound_statement", java: "block", go: "block",
};

const IF_TYPES = new Set(["if_statement"]);
const LOOP_TYPES = new Set(["while_statement", "for_statement", "for_in_statement", "for_of_statement", "for_range_loop", "range_based_for_statement", "enhanced_for_statement"]);
const CALL_NODE_TYPES = new Set(["call", "call_expression", "method_invocation", "new_expression"]);
const NESTED_FN_TYPES = new Set(["function_definition", "function_declaration", "class_definition", "class_declaration", "generator_function_declaration"]);
const TRIVIAL_TYPES = new Set(["pass_statement", "empty_statement", ";"]);
const JS_DECL_FN_TYPES = new Set(["arrow_function", "function_expression", "generator_function", "function_declaration"]);

function classify(n: TsNode, family: Family): StmtClass {
  if (isComment(n)) return "comment";
  const t = n.type;
  if (TRIVIAL_TYPES.has(t)) return "skip";
  if (IF_TYPES.has(t)) return "if";
  if (t === "do_statement") return "do";
  if (LOOP_TYPES.has(t)) return "loop";
  if (t === "switch_statement" || t === "switch_expression" || t === "expression_switch_statement" || t === "type_switch_statement") return "switch";
  if (t === "match_statement") return "match";
  if (t === "try_statement") return "try";
  if (t === "with_statement") return "with";
  if (t === "block" || t === BLOCK_TYPE[family]) {
    // 裸块语句=扁平化(其内部语句仍在同一层展开)
    return "block";
  }
  if (t === "return_statement" || t === "return") return "return";
  if (t === "throw_statement" || t === "raise_statement") return "throw";
  if (t === "break_statement" || t === "break") return "break";
  if (t === "continue_statement" || t === "continue") return "continue";
  if (NESTED_FN_TYPES.has(t)) {
    // 顶层函数由 collectFunctions 处理;函数体内出现=嵌套声明,只画声明不展开
    return "nested";
  }
  if (family === "js" && (t === "function_declaration" || t === "method_definition")) return "nested";
  // 单语句形 call:py expression_statement / js expression_statement / java expression_statement /
  // go call_expression(Go 的调用可直接是语句)
  if (family === "py" && t === "expression_statement") {
    const inner = namedChildrenOf(n)[0];
    if (inner && (inner.type === "call" || (inner.type === "await" && namedChildrenOf(inner)[0]?.type === "call"))) return "call";
  }
  if (family === "js" && t === "expression_statement") {
    const inner = namedChildrenOf(n)[0];
    if (inner && (inner.type === "call_expression" || inner.type === "new_expression"
      || (inner.type === "await_expression" && namedChildrenOf(inner)[0]?.type === "call_expression"))) return "call";
  }
  if (family === "c" && t === "expression_statement") {
    const inner = namedChildrenOf(n)[0];
    if (inner && (inner.type === "call_expression" || inner.type === "new_expression")) return "call";
  }
  if (family === "java" && t === "expression_statement") {
    const inner = namedChildrenOf(n)[0];
    if (inner && (inner.type === "method_invocation" || inner.type === "object_creation_expression")) return "call";
  }
  if (family === "go" && (t === "call_expression" || t === "go_statement" || t === "defer_statement")) return "call";
  return "simple";
}

// ---- 取函数体/语句序列 ----

function bodyNodeOf(n: TsNode, family: Family): TsNode | undefined {
  const byField = n.childForFieldName("body");
  if (byField) return byField;
  // py else_clause 的体字段名为 body;部分语法版本无字段
  const named = namedChildrenOf(n);
  const block = named.find((c) => c.type === BLOCK_TYPE[family]);
  return block;
}

function stmtsOf(body: TsNode | undefined, family: Family): TsNode[] {
  if (!body) return [];
  if (body.type === BLOCK_TYPE[family] || body.type === "block" || body.type === "statement_block") {
    return namedChildrenOf(body);
  }
  return [body];
}

// ---- 调用名抽取 ----

function calleeName(n: TsNode, family: Family): string | undefined {
  let target: TsNode | null | undefined;
  if (family === "java") target = n.childForFieldName("name") ?? namedChildrenOf(n)[0];
  else target = n.childForFieldName("function") ?? n.childForFieldName("constructor") ?? namedChildrenOf(n)[0];
  const text = condense(target?.text);
  if (!text) return undefined;
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(text);
  return m?.[1];
}

function callsIn(n: TsNode, family: Family): string[] {
  const out: string[] = [];
  const walk = (x: TsNode): void => {
    if (CALL_NODE_TYPES.has(x.type)) {
      const name = calleeName(x, family);
      if (name && !out.includes(name)) out.push(name);
    }
    // 不进入嵌套函数/类体:它们的调用不属于本语句
    if (NESTED_FN_TYPES.has(x.type) && x !== n) return;
    for (const c of namedChildrenOf(x)) walk(c);
  };
  walk(n);
  return out;
}

// ---- 模块常量(说明节点用) ----

function collectConstants(root: TsNode, family: Family): { name: string; value: string; line: number }[] {
  const out: { name: string; value: string; line: number }[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string | undefined, line: number): void => {
    const n = name.trim();
    if (!/^[A-Z][A-Z0-9_]{1,}$/.test(n) || !value || seen.has(n)) return;
    seen.add(n);
    out.push({ name: n, value: clip(condense(value), 70), line });
  };
  const top = namedChildrenOf(root);
  if (family === "py") {
    for (const st of top) {
      const expr = st.type === "expression_statement" ? namedChildrenOf(st)[0] : undefined;
      if (expr?.type !== "assignment") continue;
      const left = expr.childForFieldName("left");
      const right = expr.childForFieldName("right");
      if (left?.type === "identifier" && right) push(left.text, right.text, row(st));
    }
  } else if (family === "js") {
    const visit = (n: TsNode): void => {
      if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
        for (const d of namedChildrenOf(n)) {
          if (d.type !== "variable_declarator") continue;
          const name = d.childForFieldName("name");
          const value = d.childForFieldName("value");
          if (name?.type === "identifier" && value) push(name.text, value.text, row(d));
        }
      }
      if (n.type === "export_statement") for (const c of namedChildrenOf(n)) visit(c);
    };
    for (const st of top) visit(st);
  } else if (family === "java") {
    for (const st of top) {
      if (st.type !== "field_declaration") continue;
      for (const d of namedChildrenOf(st)) {
        if (d.type !== "variable_declarator") continue;
        const name = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (name && value) push(name.text, value.text, row(st));
      }
    }
  } else if (family === "go") {
    for (const st of top) {
      if (st.type !== "const_declaration" && st.type !== "var_declaration") continue;
      for (const spec of namedChildrenOf(st)) {
        const name = spec.childForFieldName("name");
        const value = spec.childForFieldName("value");
        if (name && value) push(name.text, value.text, row(spec));
      }
    }
  } else {
    // c/cpp:顶层 declaration 用文本形态取「全大写 = 字面量」;宏 #define 也是常量来源
    for (const st of top) {
      if (st.type === "preproc_def" || st.type === "preproc_function_def") {
        const name = st.childForFieldName("name")?.text ?? /#\s*define\s+(\w+)/.exec(st.text)?.[1];
        const value = st.childForFieldName("value")?.text ?? st.text.replace(/^[\s\S]*?#\s*define\s+\w+/, "").trim();
        if (name) push(name, value, row(st));
        continue;
      }
      if (st.type !== "declaration" && st.type !== "function_definition") continue;
      const m = /^\s*(?:static\s+)?(?:const(?:expr)?\s+)?(?:unsigned\s+|signed\s+)?[\w:<>,*&\s]+\b([A-Z][A-Z0-9_]{1,})\s*=\s*([^;]+)/.exec(st.text);
      if (m) push(m[1]!, m[2]!, row(st));
    }
  }
  return out;
}

// ---- 函数定位 ----

interface FnInfo {
  node: TsNode;
  /** 变量声明节点(箭头函数:const foo = () => {};签名/行号从声明取)。 */
  decl?: TsNode;
  name: string;
  className?: string;
  /** Python decorated_definition 的外层节点(行号/文档注释从装饰器起处取)。 */
  outer?: TsNode;
}

const FN_DECL_TYPES: Record<Family, string[]> = {
  py: ["function_definition"],
  js: ["function_declaration", "method_definition", "generator_function_declaration"],
  c: ["function_definition"],
  java: ["method_declaration", "constructor_declaration"],
  go: ["function_declaration", "method_declaration"],
};

const CLASS_TYPES: Record<Family, string[]> = {
  py: ["class_definition"],
  js: ["class_declaration", "class"],
  c: ["class_specifier", "struct_specifier"],
  java: ["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"],
  go: [],
};

function fnNameOf(n: TsNode, family: Family): string | undefined {
  if (family === "c") {
    let cur: TsNode | null | undefined = n.childForFieldName("declarator");
    for (let i = 0; i < 10 && cur; i++) {
      if (cur.type === "identifier") return cur.text;
      cur = cur.childForFieldName("declarator")
        ?? namedChildrenOf(cur).find((c) => ["identifier", "function_declarator", "pointer_declarator", "reference_declarator", "qualified_identifier", "field_identifier"].includes(c.type));
    }
    const m = /([A-Za-z_]\w*)\s*\(/.exec(n.text);
    return m?.[1];
  }
  if (family === "java") return n.childForFieldName("name")?.text;
  if (family === "go") return n.childForFieldName("name")?.text;
  // py/js
  const direct = n.childForFieldName("name")?.text;
  return direct;
}

function classStackName(n: TsNode, family: Family): string | undefined {
  const named = namedChildrenOf(n);
  const byField = n.childForFieldName("name");
  if (byField) return byField.text;
  const cand = named.find((c) => c.type === "identifier" || c.type === "type_identifier" || c.type === "property_identifier");
  return cand?.text;
}

/** 收集文件内全部函数(含类方法/箭头函数;嵌套函数单独成项,不内联)。 */
function collectFunctions(root: TsNode, family: Family): FnInfo[] {
  const out: FnInfo[] = [];
  const fnTypes = new Set(FN_DECL_TYPES[family]);
  const classTypes = new Set(CLASS_TYPES[family]);

  const walk = (n: TsNode, classNames: string[]): void => {
    if (classTypes.has(n.type)) {
      const cname = classStackName(n, family);
      const kids = childrenOf(n);
      for (const c of kids) walk(c, cname ? [...classNames, cname] : classNames);
      return;
    }
    if (fnTypes.has(n.type)) {
      const name = fnNameOf(n, family);
      if (name) {
        const info: FnInfo = { node: n, name };
        if (classNames.length > 0) info.className = classNames[classNames.length - 1]!;
        if (family === "py") {
          // decorated_definition 包裹:外层节点的起始行才是文档注释/装饰器位置
          // (当前实现拿不到父指针,由 docAbove 从 def 行向上扫;装饰器行会截断注释,已知边界)
        }
        out.push(info);
      }
      // 继续走函数体,嵌套函数也单独收集(文件级清单要全)
      for (const c of childrenOf(n)) walk(c, classNames);
      return;
    }
    if (family === "js" && n.type === "variable_declarator") {
      const value = n.childForFieldName("value");
      if (value && JS_DECL_FN_TYPES.has(value.type)) {
        const nameNode = n.childForFieldName("name");
        const varName = nameNode?.type === "identifier" ? nameNode.text : undefined;
        if (varName) {
          out.push({
            node: value, decl: n, name: varName,
            ...(classNames.length > 0 ? { className: classNames[classNames.length - 1]! } : {}),
          });
        }
        // 箭头函数体里也可能有嵌套函数(极少),继续走
        for (const c of childrenOf(value)) walk(c, classNames);
        return;
      }
    }
    for (const c of childrenOf(n)) walk(c, classNames);
  };
  walk(root, []);
  return out.sort((a, b) => row(a.decl ?? a.outer ?? a.node) - row(b.decl ?? b.outer ?? b.node));
}

// ---- CFG 构建 ----

interface Tail { id: string; label?: string; kind?: CfgEdgeKind }

interface BuildCtx {
  family: Family;
  nodes: CfgNode[];
  edges: CfgEdge[];
  groups: CfgGroup[];
  groupStack: string[];
  seq: number;
  /** 正常落空(顺序结束)的去处。 */
  endId: string;
  /** return/throw 的去处(整函数=endId;分段时是「返回/结束」专用节点)。 */
  exitId: string;
  jumps: { breakTo?: string; continueTo?: string }[];
  maxNodes: number;
  truncated: boolean;
  knownLimits: string[];
  orphans: number;
  calls: string[];
  returns: number;
  throws: number;
  statements: number;
  decisions: number;
  loops: number;
  nested: number;
}

const TRUNCATED = Symbol("cfg-truncated");

function newNode(ctx: BuildCtx, kind: CfgNodeKind, text: string, extra?: Partial<CfgNode>): CfgNode {
  if (ctx.maxNodes > 0 && ctx.nodes.length >= ctx.maxNodes) {
    ctx.truncated = true;
    throw TRUNCATED;
  }
  const id = `n${++ctx.seq}`;
  const group = ctx.groupStack[ctx.groupStack.length - 1];
  const node: CfgNode = { id, kind, text, ...(group ? { group } : {}), ...(extra ?? {}) };
  ctx.nodes.push(node);
  return node;
}

function addGroup(ctx: BuildCtx, kind: CfgGroupKind, label: string, line?: number, lineEnd?: number): CfgGroup {
  const parent = ctx.groupStack[ctx.groupStack.length - 1];
  const group: CfgGroup = {
    id: `g${ctx.groups.length + 1}`, kind, label,
    ...(line ? { line } : {}), ...(lineEnd ? { lineEnd } : {}), ...(parent ? { parent } : {}),
  };
  ctx.groups.push(group);
  return group;
}

function link(ctx: BuildCtx, from: string | undefined, to: string | undefined, label?: string, kind: CfgEdgeKind = "flow"): void {
  if (!from || !to) return;
  if (from === to && !label) return;
  if (ctx.edges.some((e) => e.from === from && e.to === to && (e.label ?? "") === (label ?? "") && e.kind === kind)) return;
  ctx.edges.push({ from, to, ...(label ? { label } : {}), kind });
}

function linkTails(ctx: BuildCtx, tails: Tail[], to: string, label?: string, kind?: CfgEdgeKind): void {
  for (const t of tails) link(ctx, t.id, to, t.label ?? label, t.kind ?? kind ?? "flow");
}

/** 忽略 tail 上挂的分支标签,强制用指定标签(循环回边/do-while 回边用)。 */
function linkTailsForced(ctx: BuildCtx, tails: Tail[], to: string, label: string, kind: CfgEdgeKind): void {
  for (const t of tails) link(ctx, t.id, to, label, kind);
}

function addCallNames(ctx: BuildCtx, names: string[]): void {
  for (const n of names) if (!ctx.calls.includes(n)) ctx.calls.push(n);
}

function nearestJump(ctx: BuildCtx, which: "break" | "continue"): string | undefined {
  for (let i = ctx.jumps.length - 1; i >= 0; i--) {
    const j = ctx.jumps[i]!;
    const to = which === "break" ? j.breakTo : j.continueTo;
    if (to) return to;
  }
  return undefined;
}

// ---- if 链(各语言形态不同) ----

interface IfArm { cond: string; condLine: number; condNode?: TsNode; body: TsNode | undefined }
interface IfParts { arms: IfArm[]; elseBody: TsNode | undefined }

function ifParts(n: TsNode, family: Family): IfParts {
  const arms: IfArm[] = [];
  let elseBody: TsNode | undefined;
  const condField = (x: TsNode): TsNode | null => x.childForFieldName("condition") ?? namedChildrenOf(x).find((c) => c.type === "parenthesized_expression") ?? namedChildrenOf(x)[0] ?? null;
  const pushIf = (x: TsNode): void => {
    const c = condField(x);
    arms.push({
      cond: condText(c), condLine: row(x), ...(c ? { condNode: c } : {}),
      body: x.childForFieldName("consequence") ?? bodyNodeOf(x, family),
    });
  };
  pushIf(n);
  if (family === "py") {
    for (const c of namedChildrenOf(n)) {
      if (c.type === "elif_clause") {
        const condNode = c.childForFieldName("condition");
        arms.push({
          cond: condText(condNode),
          condLine: row(c),
          ...(condNode ? { condNode } : {}),
          body: c.childForFieldName("consequence") ?? bodyNodeOf(c, family),
        });
      } else if (c.type === "else_clause") {
        elseBody = c.childForFieldName("body") ?? bodyNodeOf(c, family);
      }
    }
    return { arms, elseBody };
  }
  if (family === "js" || family === "c") {
    let cur: TsNode = n;
    for (let guard = 0; guard < 32; guard++) {
      const alt = cur.childForFieldName("alternative");
      if (!alt) break;
      let stmt: TsNode | undefined = alt;
      if (alt.type === "else_clause") stmt = namedChildrenOf(alt).find((c) => c.type !== "else");
      if (!stmt) break;
      if (stmt.type === "if_statement") {
        pushIf(stmt);
        cur = stmt;
        continue;
      }
      elseBody = stmt;
      break;
    }
    return { arms, elseBody };
  }
  // java/go:alternative 直挂 if_statement | block
  let cur: TsNode = n;
  for (let guard = 0; guard < 32; guard++) {
    const alt = cur.childForFieldName("alternative");
    if (!alt) break;
    if (alt.type === "if_statement") {
      pushIf(alt);
      cur = alt;
      continue;
    }
    elseBody = alt;
    break;
  }
  return { arms, elseBody };
}

// ---- switch 臂(各语言形态不同) ----

interface SwitchArm { label: string; isDefault: boolean; line: number; body: TsNode[] }

function switchArms(n: TsNode, family: Family): SwitchArm[] {
  const out: SwitchArm[] = [];
  const caseNodes = (parent: TsNode): TsNode[] => {
    const kids = namedChildrenOf(parent);
    return kids.filter((c) => ["switch_case", "switch_default", "case_statement", "expression_case", "default_case", "type_case", "switch_block_statement_group", "switch_rule", "case_clause"].includes(c.type));
  };
  if (family === "go") {
    for (const c of caseNodes(n)) {
      const value = c.childForFieldName("value");
      const body = namedChildrenOf(c).filter((x) => !value || nodeKey(x) !== nodeKey(value));
      out.push({
        label: c.type === "default_case" ? "default:" : `case ${condense(value?.text) || "?"}:`,
        isDefault: c.type === "default_case",
        line: row(c), body,
      });
    }
    return out;
  }
  const body = n.childForFieldName("body") ?? namedChildrenOf(n).find((c) => ["switch_body", "switch_block", "compound_statement", "block"].includes(c.type));
  const list = body ? caseNodes(body) : caseNodes(n);
  for (const c of list) {
    if (c.type === "switch_block_statement_group") {
      const label = namedChildrenOf(c).find((x) => x.type === "switch_label");
      const text = condense(label?.text);
      const bodyNodes = namedChildrenOf(c).filter((x) => x.type !== "switch_label");
      out.push({
        label: /^default\b/.test(text) ? "default:" : `case ${text.replace(/^case\s*/, "")}:`,
        isDefault: /^default\b/.test(text), line: row(c), body: bodyNodes,
      });
      continue;
    }
    if (c.type === "switch_rule") {
      const value = c.childForFieldName("value");
      out.push({
        label: /^default\b/.test(condense(c.text)) ? "default:" : `case ${condense(value?.text) || "?"}:`,
        isDefault: /^default\b/.test(condense(c.text)), line: row(c), body: namedChildrenOf(c).filter((x) => x.type !== "switch_label" && x.type !== "value"),
      });
      continue;
    }
    if (c.type === "case_statement") {
      const value = c.childForFieldName("value") ?? c.childForFieldName("values");
      const bodyNodes = namedChildrenOf(c).filter((x) => !value || nodeKey(x) !== nodeKey(value));
      out.push({
        label: value ? `case ${condense(value.text)}:` : "default:",
        isDefault: !value, line: row(c), body: bodyNodes,
      });
      continue;
    }
    if (c.type === "case_clause") {
      // python match:case <pattern>:
      const text = condense(c.text.split(":")[0]);
      const body = c.childForFieldName("body") ?? bodyNodeOf(c, family);
      out.push({ label: `${text}:`, isDefault: /^case\s*_/.test(text), line: row(c), body: stmtsOf(body, family) });
      continue;
    }
    // js switch_case / switch_default
    const value = c.childForFieldName("value");
    const bodyNodes = namedChildrenOf(c).filter((x) => !value || nodeKey(x) !== nodeKey(value));
    out.push({
      label: c.type === "switch_default" ? "default:" : `case ${condense(value?.text) || "?"}:`,
      isDefault: c.type === "switch_default", line: row(c), body: bodyNodes,
    });
  }
  return out;
}

// ---- try/catch/finally ----

interface TryParts {
  body: TsNode | undefined;
  catches: { label: string; body: TsNode | undefined }[];
  elseBody?: TsNode;
  finallyBody?: TsNode;
  line: number;
}

function tryParts(n: TsNode, family: Family): TryParts {
  const out: TryParts = { body: bodyNodeOf(n, family), catches: [], line: row(n) };
  const named = namedChildrenOf(n);
  if (family === "py") {
    for (const c of named) {
      if (c.type === "except_clause") {
        const head = condense(c.text.split(":")[0]);
        out.catches.push({ label: head || "except", body: c.childForFieldName("body") ?? bodyNodeOf(c, family) });
      } else if (c.type === "else_clause") {
        out.elseBody = c.childForFieldName("body") ?? bodyNodeOf(c, family);
      } else if (c.type === "finally_clause") {
        out.finallyBody = c.childForFieldName("body") ?? bodyNodeOf(c, family) ?? stmtsOf(c, family).find((x) => x.type === "block");
      }
    }
    return out;
  }
  if (family === "js") {
    const handler = n.childForFieldName("handler") ?? named.find((c) => c.type === "catch_clause");
    if (handler) {
      const param = handler.childForFieldName("parameter");
      out.catches.push({ label: `catch${param ? ` (${condense(param.text)})` : ""}`, body: handler.childForFieldName("body") ?? bodyNodeOf(handler, family) });
    }
    out.finallyBody = n.childForFieldName("finalizer") ?? named.find((c) => c.type === "finally_clause") ?? undefined;
    return out;
  }
  // java/cpp
  for (const c of named) {
    if (c.type === "catch_clause") {
      const param = c.childForFieldName("parameters") ?? namedChildrenOf(c).find((x) => x.type === "catch_formal_parameter" || x.type === "parameter_list");
      out.catches.push({ label: `catch${param ? ` ${condense(param.text)}` : ""}`, body: c.childForFieldName("body") ?? bodyNodeOf(c, family) });
    } else if (c.type === "finally_clause") {
      out.finallyBody = c.childForFieldName("body") ?? bodyNodeOf(c, family);
    }
  }
  return out;
}

// ---- 主构建 ----

function buildCtx(endId: string, family: Family, maxNodes: number): BuildCtx {
  return {
    family, nodes: [], edges: [], groups: [], groupStack: [], seq: 0, endId, exitId: endId,
    jumps: [], maxNodes, truncated: false, knownLimits: [], orphans: 0,
    calls: [], returns: 0, throws: 0, statements: 0, decisions: 0, loops: 0, nested: 0,
  };
}

function stmtNodeOf(ctx: BuildCtx, n: TsNode, cls: StmtClass, comment?: string): CfgNode {
  const text = stmtText(n);
  const calls = callsIn(n, ctx.family);
  addCallNames(ctx, calls);
  const kind: CfgNodeKind = cls === "call" ? "call" : cls === "return" ? "return" : cls === "throw" ? "throw"
    : cls === "break" ? "break" : cls === "continue" ? "continue" : "stmt";
  if (cls === "return") ctx.returns++;
  if (cls === "throw") ctx.throws++;
  if (cls !== "return" && cls !== "throw" && cls !== "break" && cls !== "continue") ctx.statements++;
  return newNode(ctx, kind, text, {
    code: n.text,
    line: row(n), lineEnd: endRow(n),
    ...(comment ? { comment } : {}),
    ...(calls.length > 0 ? { calls } : {}),
  });
}

function emitOne(ctx: BuildCtx, st: TsNode, cls: StmtClass, tails: Tail[], comment?: string): Tail[] {
  if (cls === "if") return emitIf(ctx, st, tails, comment);
  if (cls === "loop") return emitLoop(ctx, st, tails, comment);
  if (cls === "do") return emitDo(ctx, st, tails, comment);
  if (cls === "switch" || cls === "match") return emitSwitch(ctx, st, tails, comment);
  if (cls === "try") return emitTry(ctx, st, tails, comment);
  if (cls === "with") return emitWith(ctx, st, tails, comment);
  if (cls === "nested") {
    ctx.nested++;
    const node = newNode(ctx, "stmt", `↳ 嵌套声明: ${clip(condense(st.text.split(/\r?\n/)[0]), 100)}`, {
      code: st.text, line: row(st), lineEnd: endRow(st),
      ...(comment ? { comment } : {}),
    });
    linkTails(ctx, tails, node.id);
    return [{ id: node.id }];
  }
  if (tails.length === 0) ctx.orphans++;
  const node = stmtNodeOf(ctx, st, cls, comment);
  linkTails(ctx, tails, node.id);
  if (cls === "return") {
    link(ctx, node.id, ctx.exitId || ctx.endId, "返回", "return");
    return [];
  }
  if (cls === "throw") {
    link(ctx, node.id, ctx.exitId || ctx.endId, "抛出", "throw");
    return [];
  }
  if (cls === "break") {
    const to = nearestJump(ctx, "break");
    if (to) link(ctx, node.id, to, "break", "break");
    else ctx.knownLimits.push("break 不在循环/switch 内(语法异常),已画成悬空节点");
    return [];
  }
  if (cls === "continue") {
    const to = nearestJump(ctx, "continue");
    if (to) link(ctx, node.id, to, "continue", "continue");
    else ctx.knownLimits.push("continue 不在循环内(语法异常),已画成悬空节点");
    return [];
  }
  return [{ id: node.id }];
}

function emitSeq(ctx: BuildCtx, stmts: TsNode[], active: Tail[], comment?: string): Tail[] {
  let tails = active;
  let pendingComment = comment;
  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i]!;
    const cls = classify(st, ctx.family);
    if (cls === "comment") {
      const text = commentText(st);
      pendingComment = pendingComment ? `${pendingComment} ${text}` : text;
      continue;
    }
    if (cls === "skip") continue;
    if (cls === "block") {
      tails = emitSeq(ctx, stmtsOf(st, ctx.family), tails, pendingComment);
      pendingComment = undefined;
      continue;
    }
    tails = emitOne(ctx, st, cls, tails, pendingComment);
    pendingComment = undefined;
  }
  return tails;
}

function emitIf(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  const parts = ifParts(n, ctx.family);
  const tails: Tail[] = [];
  let prevCond: CfgNode | undefined;
  for (let i = 0; i < parts.arms.length; i++) {
    const arm = parts.arms[i]!;
    ctx.decisions++;
    const condCalls = arm.condNode ? callsIn(arm.condNode, ctx.family) : [];
    addCallNames(ctx, condCalls);
    const cond = newNode(ctx, "cond", arm.cond || "(条件)", {
      code: arm.cond, line: arm.condLine,
      ...(i === 0 && comment ? { comment } : {}),
      ...(condCalls.length > 0 ? { calls: condCalls } : {}),
    });
    if (!prevCond) linkTails(ctx, active, cond.id);
    else link(ctx, prevCond.id, cond.id, "否", "false");
    const bodyTails = emitSeq(ctx, stmtsOf(arm.body, ctx.family), [{ id: cond.id, label: "是", kind: "true" }]);
    tails.push(...bodyTails);
    prevCond = cond;
  }
  if (parts.elseBody) {
    const elseTails = emitSeq(ctx, stmtsOf(parts.elseBody, ctx.family), [{ id: prevCond!.id, label: "否", kind: "false" }]);
    tails.push(...elseTails);
  } else if (prevCond) {
    tails.push({ id: prevCond.id, label: "否", kind: "false" });
  }
  return tails;
}

/** 循环头里「条件/被迭代对象」节点(用于收集条件里的调用;循环体调用不算头)。 */
function loopCondNode(n: TsNode, family: Family): TsNode | undefined {
  if (n.type === "for_in_statement" || n.type === "for_of_statement") return n.childForFieldName("right") ?? undefined;
  if (n.type === "for_range_loop" || n.type === "range_based_for_statement" || n.type === "enhanced_for_statement") {
    return n.childForFieldName("right") ?? n.childForFieldName("value") ?? undefined;
  }
  if (family === "go" && n.type === "for_statement") {
    const clause = namedChildrenOf(n).find((c) => c.type === "for_clause" || c.type === "range_clause");
    return clause?.childForFieldName("condition") ?? clause?.childForFieldName("right") ?? undefined;
  }
  if (family === "py" && n.type === "for_statement") return n.childForFieldName("right") ?? undefined;
  return n.childForFieldName("condition") ?? undefined;
}

function loopHeader(n: TsNode, family: Family): string {
  const body = bodyNodeOf(n, family);
  let head = n.text;
  if (body) {
    const idx = n.text.indexOf(body.text);
    if (idx > 0) head = n.text.slice(0, idx);
  }
  head = condense(head).replace(/\{$/, "").trim();
  if (family === "py") head = head.replace(/:$/, "").trim();
  return clip(head || "loop", MAX_COND);
}

function emitLoop(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  ctx.decisions++;
  ctx.loops++;
  const header = loopHeader(n, ctx.family);
  const condNode = loopCondNode(n, ctx.family);
  const headCalls = condNode ? callsIn(condNode, ctx.family) : [];
  addCallNames(ctx, headCalls);
  const group = addGroup(ctx, "loop", "循环体", row(n), endRow(n));
  ctx.groupStack.push(group.id);
  const head = newNode(ctx, "loop", header, {
    code: n.text, line: row(n), lineEnd: endRow(n),
    ...(comment ? { comment } : {}),
    ...(headCalls.length > 0 ? { calls: headCalls } : {}),
  });
  linkTails(ctx, active, head.id);
  const after = newNode(ctx, "merge", "");
  ctx.groupStack.pop();
  ctx.jumps.push({ breakTo: after.id, continueTo: head.id });
  ctx.groupStack.push(group.id);
  const bodyTails = emitSeq(ctx, stmtsOf(bodyNodeOf(n, ctx.family), ctx.family), [{ id: head.id, label: "进入", kind: "loop" }]);
  ctx.groupStack.pop();
  ctx.jumps.pop();
  // 回边统一叫「循环」:分支体末尾可能挂着 是/否 的 pending 标签,不能让它覆盖回边语义
  linkTailsForced(ctx, bodyTails, head.id, "循环", "loop");
  link(ctx, head.id, after.id, "退出", "false");
  return [{ id: after.id }];
}

function emitDo(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  ctx.decisions++;
  ctx.loops++;
  const group = addGroup(ctx, "loop", "循环体", row(n), endRow(n));
  const entry = newNode(ctx, "merge", "", { line: row(n), ...(comment ? { comment } : {}) });
  linkTails(ctx, active, entry.id);
  const after = newNode(ctx, "merge", "");
  ctx.jumps.push({ breakTo: after.id, continueTo: entry.id });
  ctx.groupStack.push(group.id);
  const bodyTails = emitSeq(ctx, stmtsOf(bodyNodeOf(n, ctx.family), ctx.family), [{ id: entry.id }]);
  const condNode = n.childForFieldName("condition");
  const condCalls = condNode ? callsIn(condNode, ctx.family) : [];
  addCallNames(ctx, condCalls);
  const cond = newNode(ctx, "loop", `条件: ${condText(condNode) || "?"}`, {
    code: n.text, line: row(n), lineEnd: endRow(n),
    ...(condCalls.length > 0 ? { calls: condCalls } : {}),
  });
  ctx.groupStack.pop();
  ctx.jumps.pop();
  linkTails(ctx, bodyTails, cond.id);
  linkTailsForced(ctx, [{ id: cond.id }], entry.id, "继续", "loop");
  link(ctx, cond.id, after.id, "退出", "false");
  return [{ id: after.id }];
}

function emitSwitch(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  ctx.decisions++;
  const isMatch = n.type === "match_statement";
  const subjectNode = isMatch
    ? (n.childForFieldName("subject") ?? namedChildrenOf(n)[0])
    : (n.childForFieldName("value") ?? n.childForFieldName("condition") ?? namedChildrenOf(n)[0]);
  const subject = condText(subjectNode);
  const subjectCalls = subjectNode ? callsIn(subjectNode, ctx.family) : [];
  addCallNames(ctx, subjectCalls);
  const head = newNode(ctx, "cond", `${isMatch ? "match" : "switch"} ${subject}`.trim(), {
    code: n.text, line: row(n), lineEnd: endRow(n),
    ...(comment ? { comment } : {}),
    ...(subjectCalls.length > 0 ? { calls: subjectCalls } : {}),
  });
  linkTails(ctx, active, head.id);
  const after = newNode(ctx, "merge", "");
  ctx.jumps.push({ breakTo: after.id });
  const arms = isMatch ? matchArms(n, ctx.family) : switchArms(n, ctx.family);
  let prevTails: Tail[] = [];
  let hasDefault = false;
  for (const arm of arms) {
    if (arm.isDefault) hasDefault = true;
    const entry = newNode(ctx, "stmt", arm.label, { line: arm.line });
    link(ctx, head.id, entry.id, arm.label.replace(/:$/, ""), "true");
    if (prevTails.length > 0) linkTails(ctx, prevTails, entry.id, "继续", "flow");
    prevTails = emitSeq(ctx, arm.body, [{ id: entry.id }]);
  }
  if (prevTails.length > 0) linkTails(ctx, prevTails, after.id, "结束", "flow");
  if (!hasDefault) link(ctx, head.id, after.id, "其他", "false");
  ctx.jumps.pop();
  return [{ id: after.id }];
}

function matchArms(n: TsNode, family: Family): SwitchArm[] {
  const body = n.childForFieldName("body") ?? namedChildrenOf(n).find((c) => c.type === "block");
  const list = body ? namedChildrenOf(body) : namedChildrenOf(n);
  const out: SwitchArm[] = [];
  for (const c of list) {
    if (c.type !== "case_clause") continue;
    const text = condense(c.text.split(/\r?\n/)[0] ?? "");
    const head = text.slice(0, text.indexOf(":") + 1 || undefined);
    out.push({ label: head, isDefault: /^case\s+_/.test(head), line: row(c), body: stmtsOf(bodyNodeOf(c, family), family) });
  }
  return out;
}

function emitTry(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  const parts = tryParts(n, ctx.family);
  const tryGroup = addGroup(ctx, "try", "try 块", row(n), endRow(n));
  ctx.groupStack.push(tryGroup.id);
  const entry = newNode(ctx, "stmt", "try", {
    code: n.text, line: row(n), lineEnd: endRow(n),
    ...(comment ? { comment } : {}),
  });
  linkTails(ctx, active, entry.id);
  const bodyTails = emitSeq(ctx, stmtsOf(parts.body, ctx.family), [{ id: entry.id }]);
  ctx.groupStack.pop();

  let tails: Tail[] = [...bodyTails];
  for (const c of parts.catches) {
    const g = addGroup(ctx, "catch", "catch 块", row(n));
    ctx.groupStack.push(g.id);
    const ce = newNode(ctx, "stmt", c.label, { line: row(n) });
    ctx.groupStack.pop();
    link(ctx, entry.id, ce.id, "异常", "error");
    ctx.groupStack.push(g.id);
    const ct = emitSeq(ctx, stmtsOf(c.body, ctx.family), [{ id: ce.id }]);
    ctx.groupStack.pop();
    tails.push(...ct);
  }
  if (parts.elseBody) {
    // py:else 只在 try 正常完成时执行
    const okTails = bodyTails;
    tails = tails.filter((t) => !bodyTails.some((b) => b.id === t.id));
    const g = addGroup(ctx, "try", "else 块(正常完成)", row(n));
    ctx.groupStack.push(g.id);
    const ee = newNode(ctx, "stmt", "else", { line: row(n) });
    ctx.groupStack.pop();
    linkTails(ctx, okTails, ee.id);
    ctx.groupStack.push(g.id);
    tails.push(...emitSeq(ctx, stmtsOf(parts.elseBody, ctx.family), [{ id: ee.id }]));
    ctx.groupStack.pop();
  }
  if (parts.finallyBody) {
    const g = addGroup(ctx, "finally", "finally 块", row(n));
    ctx.groupStack.push(g.id);
    const fe = newNode(ctx, "stmt", "finally", { line: row(n) });
    ctx.groupStack.pop();
    linkTails(ctx, tails, fe.id);
    link(ctx, entry.id, fe.id, "异常", "error");
    ctx.groupStack.push(g.id);
    const ft = emitSeq(ctx, stmtsOf(parts.finallyBody, ctx.family), [{ id: fe.id }]);
    ctx.groupStack.pop();
    return ft;
  }
  const after = newNode(ctx, "merge", "");
  linkTails(ctx, tails, after.id);
  return [{ id: after.id }];
}

function emitWith(ctx: BuildCtx, n: TsNode, active: Tail[], comment?: string): Tail[] {
  const header = loopHeader(n, ctx.family);
  const g = addGroup(ctx, "with", "with 块", row(n), endRow(n));
  ctx.groupStack.push(g.id);
  const entry = newNode(ctx, "stmt", header, {
    code: n.text, line: row(n), lineEnd: endRow(n),
    ...(comment ? { comment } : {}),
  });
  linkTails(ctx, active, entry.id);
  const tails = emitSeq(ctx, stmtsOf(bodyNodeOf(n, ctx.family), ctx.family), [{ id: entry.id }]);
  ctx.groupStack.pop();
  return tails;
}

// ---- 单个函数 → CFG ----

function fnHeader(info: FnInfo, family: Family, source: string): string {
  const line = source.split(/\r?\n/)[row(info.decl ?? info.node) - 1] ?? "";
  let head = line;
  if (family === "py") head = head.replace(/:\s*$/, "");
  head = head.replace(/\s*\{\s*$/, "").replace(/\s*=>\s*$/, "");
  if (!head.trim()) head = `${info.name}(...)`;
  return clip(condense(head), 100);
}

// ---- 函数说明(结构化;参考 deepwiki-open 的页面结构:职责/关键函数表/每项有据,不倾倒 docstring) ----

function paramsNodeOf(info: FnInfo, family: Family): TsNode | undefined {
  const byField = info.node.childForFieldName("parameters") ?? info.node.childForFieldName("parameter");
  if (byField) return byField;
  if (family === "c") {
    const decl = info.node.childForFieldName("declarator");
    if (decl) {
      const p = decl.childForFieldName("parameters") ?? decl.childForFieldName("parameter_list");
      if (p) return p;
      let found: TsNode | undefined;
      const walk = (n: TsNode): void => {
        if (found) return;
        if (n.type === "parameter_list" || n.type === "parameters") { found = n; return; }
        for (const c of namedChildrenOf(n)) walk(c);
      };
      walk(decl);
      return found;
    }
  }
  return undefined;
}

/** 顶层分隔符位置(尊重引号/括号/泛型;`=` 跳过 `=>`/`==`)。 */
function topLevelIndex(s: string, target: string): number {
  let depth = 0;
  let angle = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "<") angle++;
    else if (c === ">" && s[i - 1] !== "-" && s[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (c === target && depth === 0 && angle === 0) {
      if (target === "=" && (s[i + 1] === ">" || s[i + 1] === "=")) continue;
      return i;
    }
  }
  return -1;
}

function splitParams(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let angle = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") { cur += inner[++i] ?? ""; } else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "<") angle++;
    else if (c === ">" && inner[i - 1] !== "-" && inner[i - 1] !== "=") angle = Math.max(0, angle - 1);
    if (c === "," && depth === 0 && angle === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseParam(raw: string, family: Family): CfgParam {
  const original = raw.trim();
  let s = original;
  let def: string | undefined;
  const eq = topLevelIndex(s, "=");
  if (eq > 0) { def = s.slice(eq + 1).trim(); s = s.slice(0, eq).trim(); }
  let type: string | undefined;
  const colon = topLevelIndex(s, ":");
  if (colon > 0) { type = s.slice(colon + 1).trim(); s = s.slice(0, colon).trim(); }
  let name = s;
  if (/^[{[]/.test(s)) {
    name = s;
  } else if (colon <= 0) {
    const ids = s.match(/[A-Za-z_$][\w$]*/g) ?? [];
    name = family === "go" ? (ids[0] ?? s) : (ids[ids.length - 1] ?? s);
  }
  name = name
    .replace(/^(public|private|protected|readonly|static|final|const|var|let|in|out|ref)\s+/i, "")
    .replace(/^[*&.]+/, "")
    .trim();
  if (!name) name = original;
  return { raw: original, name, ...(type ? { type } : {}), ...(def ? { default: def } : {}) };
}

function returnTypeOf(info: FnInfo, family: Family, rawHeader: string): string | undefined {
  const byField = info.node.childForFieldName("return_type")
    ?? info.node.childForFieldName("result")
    ?? info.node.childForFieldName("type");
  if (byField?.text) {
    const t = condense(byField.text).replace(/^:\s*/, "");
    if (t) return clip(t, 60);
  }
  if (family === "py") {
    const m = /->\s*([^:]+?)\s*:?\s*$/.exec(rawHeader);
    if (m?.[1]) return clip(condense(m[1]), 60);
  }
  if (family === "js") {
    const m = /\)\s*:\s*(.+?)\s*(?:\{|=>)/.exec(rawHeader);
    if (m?.[1]) return clip(condense(m[1]), 60);
  }
  return undefined;
}

/** docstring → 首句职责 + 其余设计备注(原始注释不丢,但不再占据说明主位)。 */
function splitDoc(doc: string | undefined): { purpose: string; details?: string } {
  const t = (doc ?? "").trim();
  if (!t) return { purpose: "" };
  // 中文句号后常无空格:按「。」切;英文 .!? 仍要求后随空白,避免 e.g. 误切
  const m = /^([\s\S]*?。)/.exec(t) ?? /^([\s\S]*?[.!?])(?:\s|$)/.exec(t);
  const first = (m ? m[1]! : t).trim();
  const rest = m ? t.slice(m[0].length).trim() : "";
  return { purpose: clip(condense(first), 140), ...(rest ? { details: clip(condense(rest), 600) } : {}) };
}

/** 调用名启发式识别外部动作(明确标注「按调用名」,不当作精确副作用分析)。
 * 误报:push(数组)、Map.delete、dict.update、new Error 都曾命中——这里用
 *  「整词/明确复合名」匹配,不用裸子串;数据库动作必须带 db/table/row 限定。 */
const SIDE_EFFECT_RULES: { re: RegExp; category: string }[] = [
  { re: /(^|_)(log|logger|logging|warn|warning|info|debug|trace|print|console)(_|$)/i, category: "日志/输出" },
  { re: /(^|_)(write|save|dump|dumps|open|mkdir|makedirs|remove|unlink|rename|copy|move|chmod|chown|persist|upload|download)(_|$)/i, category: "文件/存储" },
  { re: /(^|_)(request|fetch|http|axios|urlopen|publish|emit|notify|send_message|send_request|post_json|put_json)(_|$)/i, category: "网络/消息" },
  { re: /(^|_)(run|exec|spawn|system|popen|subprocess|shell|ffmpeg|ffprobe)(_|$)/i, category: "进程/命令" },
  { re: /(db|sql|database|table|record|row|dao|repo|store)[._]?(insert|update|delete|select|execute|query)|(insert|update|delete|select|execute|query)[._]?(db|sql|table|record|row)/i, category: "数据库" },
  { re: /(^|_)(sleep|wait|retry|timeout)(_|$)/i, category: "等待/重试" },
];

function sideEffectsOf(calls: string[]): { name: string; category: string }[] {
  const out: { name: string; category: string }[] = [];
  for (const name of calls) {
    for (const rule of SIDE_EFFECT_RULES) {
      if (rule.re.test(name)) {
        if (!out.some((x) => x.name === name && x.category === rule.category)) out.push({ name, category: rule.category });
        break;
      }
    }
    if (out.length >= 6) break;
  }
  return out;
}

function stripReturn(text: string): string {
  return clip(condense(text.replace(/^return\b\s*/i, "").replace(/;\s*$/, "")), 80);
}

function stripThrow(text: string): string {
  return clip(condense(text.replace(/^(raise|throw)\b\s*/i, "").replace(/;\s*$/, "")), 80);
}

/** 无 docstring 时的兜底职责:按函数名/签名推断,明确标注来源,不冒充文档。 */
function nameGloss(name: string): string {
  const base = name.split(".").pop() ?? name;
  return base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 裸标识符/`!x` 条件加人话;复合表达式保持源码原文(不臆造语义)。 */
function humanizeCondition(text: string): string {
  const t = condense(text);
  const bare = /^[A-Za-z_$][\w$]*$/.exec(t);
  if (bare) return `${t} 为真(非空)`;
  const neg = /^!\s*([A-Za-z_$][\w$]*)$/.exec(t);
  if (neg) return `${neg[1]} 为假(空)`;
  return t;
}

/** 关键判断 = 条件 + 为真时的第一个动作(读图时不用再追分支;switch 无「是」边则只给条件)。 */
function keyConditionsOf(fn: CfgFunction): string[] {
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const n of fn.nodes) {
    if (n.kind !== "cond") continue;
    const yes = fn.edges.find((e) => e.from === n.id && (e.label === "是" || e.kind === "true"));
    const then = yes ? byId.get(yes.to) : undefined;
    const action = then && then.kind !== "merge" && then.kind !== "end"
      ? clip(condense(then.text).replace(/[;；]\s*$/, ""), 52)
      : undefined;
    out.push(action ? `${humanizeCondition(n.text)} → ${action}` : humanizeCondition(n.text));
  }
  return [...new Set(out)].slice(0, 5);
}

function prettyReturn(expr: string, returnType: string | undefined): string {
  if (/^[[{]/.test(expr) && returnType) return `${returnType}(对象/数组字面量)`;
  return expr;
}

function returnSummary(d: CfgDescription): string {
  const r = d.returns[0];
  if (r) {
    const p = prettyReturn(r, d.returnType);
    return d.returnType && !p.includes(d.returnType) ? `${p} (${d.returnType})` : p;
  }
  return d.returnType ?? "无显式返回";
}

export function cfgReturnSummary(d: CfgDescription): string {
  return returnSummary(d);
}

function buildDescription(info: FnInfo, family: Family, source: string, fn: CfgFunction, doc: string | undefined): CfgDescription {
  const { purpose, details } = splitDoc(doc);
  const rawHeader = source.split(/\r?\n/)[fn.line - 1] ?? fn.signature;
  const returnType = returnTypeOf(info, family, rawHeader);
  let params: CfgParam[] = [];
  const paramsNode = paramsNodeOf(info, family);
  if (paramsNode) {
    const text = paramsNode.text.trim();
    const inner = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
    params = splitParams(inner)
      .map((p) => parseParam(p, family))
      .filter((p) => !(family === "c" && p.raw === "void"));
    if (family === "py" && params.length > 0 && (params[0]!.name === "self" || params[0]!.name === "cls")) params = params.slice(1);
  }
  const returns = fn.nodes.filter((n) => n.kind === "return").map((n) => stripReturn(n.text)).filter(Boolean).slice(0, 3);
  const raises = fn.nodes.filter((n) => n.kind === "throw").map((n) => stripThrow(n.text)).filter(Boolean).slice(0, 3);
  const keyConditions = keyConditionsOf(fn);
  const loops = [...new Set(fn.nodes.filter((n) => n.kind === "loop").map((n) => n.text).filter(Boolean))].slice(0, 3);
  const paramNames = params.slice(0, 3).map((p) => p.name).join(", ") + (params.length > 3 ? ", …" : "");
  const inferredReturn = returnType ?? (returns[0] ? clip(returns[0], 40) : "无显式返回");
  return {
    purpose: purpose || `无源码注释;按函数名/签名推断:${nameGloss(fn.name)}(${paramNames}) → ${inferredReturn}。`,
    purposeSource: purpose ? "docstring" : "signature",
    params,
    ...(returnType ? { returnType } : {}),
    returns,
    raises,
    keyConditions,
    loops,
    sideEffects: sideEffectsOf(fn.stats.calls),
    ...(details ? { details } : {}),
    ...(doc ? { rawDoc: clip(doc, 1200) } : {}),
  };
}

function buildFunctionFrom(info: FnInfo, family: Family, file: string, lang: string, source: string, constants: { name: string; value: string }[], maxNodes: number): CfgFunction {
  const startLine = row(info.decl ?? info.outer ?? info.node);
  const endLine = endRow(info.decl ?? info.outer ?? info.node);
  const signature = fnHeader(info, family, source);
  const knownLimits: string[] = [
    "语句文本为源码压缩(单行,≤160 字符);多行表达式/宏不展开。",
    "表达式内的三元/布尔短路不拆成分支(只按 if/loop/switch/try 等语句结构展开)。",
    "调用名取语法树末段(属性调用只取末段,接收者不辨);跨函数不内联(每函数一张图)。",
    "嵌套函数/类只画声明节点,不展开其内部流程。",
  ];
  const docFromAbove = docAbove(source.split(/\r?\n/), startLine, family);
  const bodyNode = bodyNodeOf(info.node, family);
  const doc = (family === "py" && bodyNode ? pyDocstring(bodyNode) : undefined) ?? docFromAbove;

  // 表达式体箭头函数:const f = (x) => x + 1
  let bodyStmts: TsNode[] = [];
  const exprBody = (() => {
    const b = info.node.childForFieldName("body");
    return b && b.type !== BLOCK_TYPE[family] && b.type !== "statement_block" ? b : undefined;
  })();
  if (exprBody) {
    bodyStmts = [];
  } else {
    bodyStmts = stmtsOf(bodyNode, family);
    if (family === "py" && bodyStmts.length > 0) {
      const first = bodyStmts[0]!;
      const isDoc = first.type === "expression_statement" && ["string", "string_literal"].includes(namedChildrenOf(first)[0]?.type ?? "");
      if (isDoc) bodyStmts = bodyStmts.slice(1);
    }
  }

  const type = info.node;
  const name = info.className ? `${info.className}.${info.name}` : info.name;
  const startLabel = `开始 · ${clip(name, 44)}`;
  const full = buildBody({
    family, stmts: bodyStmts, startLabel, endLabel: "结束",
    startLine, endLine, maxNodes,
    ...(exprBody ? { exprBody } : {}),
  });
  const ctx = full.ctx;

  if (ctx.orphans > 0) knownLimits.push(`${ctx.orphans} 条语句位于「所有前序分支都已 return/throw」之后,无入边(代码存在但不可达)。`);
  if (ctx.nested > 0) knownLimits.push(`${ctx.nested} 个嵌套函数/类只显示声明,未展开。`);
  if (ctx.truncated) knownLimits.push(`节点达到显式上限(--max-nodes ${maxNodes}),图已截断(缺省 0=不设上限)。`);
  if (!bodyNode && !exprBody) knownLimits.push("未定位到函数体(可能是声明/接口/词法兜底),图只有开始/结束。");

  const calls = ctx.calls;
  const result: CfgFunction = {
    name, qualifiedName: name,
    ...(info.className ? { className: info.className } : {}),
    file, lang,
    line: startLine, lineEnd: endLine, signature,
    ...(doc ? { doc } : {}),
    description: { purpose: "", purposeSource: "signature", params: [], returns: [], raises: [], keyConditions: [], loops: [], sideEffects: [] },
    notes: [],
    nodes: ctx.nodes,
    edges: ctx.edges,
    groups: ctx.groups,
    stats: {
      statements: ctx.statements,
      decisions: ctx.decisions,
      loops: ctx.loops,
      calls,
      returns: ctx.returns,
      throws: ctx.throws,
      complexity: 1 + ctx.decisions,
    },
    truncated: ctx.truncated,
    knownLimits,
  };
  // 结构化说明(职责/输入/输出/判断/循环/异常/副作用);图内只放一张紧凑速览卡,
  // 完整说明在页面表格/CLI 里,避免 docstring 把流程图顶下去。
  result.description = buildDescription(info, family, source, result, doc);
  const used = constants.filter((c) => new RegExp(`\\b${c.name}\\b`).test(source.slice(type.startIndex, type.endIndex)));
  const notes: CfgFunction["notes"] = [{
    title: "函数速览",
    lines: [
      `作用: ${result.description.purpose}`,
      `输入: ${result.description.params.map((p) => p.name || p.raw).slice(0, 4).join(", ") || "无"}`,
      `输出: ${returnSummary(result.description)}`,
      ...(result.description.sideEffects.length > 0
        ? [`副作用: ${result.description.sideEffects.slice(0, 3).map((s) => s.name).join(", ")}`]
        : []),
    ],
  }];
  if (used.length > 0) notes.push({ title: "模块常量", lines: used.slice(0, 12).map((c) => `${c.name} = ${c.value}`) });
  result.notes = notes;
  // 说明节点在图建好之后追加(先有图才知道返回/判断/循环)
  for (const note of notes) {
    const id = `note${++ctx.seq}`;
    result.nodes.push({ id, kind: "note", text: note.title, code: note.lines.join("\n"), line: startLine });
    result.edges.push({ from: id, to: full.start.id, label: "说明", kind: "note" });
  }
  return result;
}

/** 按需分页(缓存到 fn.pages):只对「要展示的函数」付 mermaid 渲染成本;
 *  候选评分阶段用 buildFileCfgs({pages:false}) 跳过。 */
export function paginateFunction(fn: CfgFunction): CfgPage[] | undefined {
  if (fn.pages) return fn.pages;
  if (fn.truncated || fn.nodes.length <= 40) return undefined;
  const pages = paginateGraph(fn);
  if (pages && pages.length > 1) {
    fn.pages = pages;
    if (!fn.knownLimits.some((l) => l.includes("分页展示"))) {
      fn.knownLimits.push(`长函数按节点顺序分页展示(${pages.length} 页,每页 ≤~22 节点;跨页边用「←/→ 第 N 页」跳转桩,不丢节点);完整单图用 --full。`);
    }
    return pages;
  }
  return undefined;
}

interface BodyBuild {
  ctx: BuildCtx;
  start: CfgNode;
  end: CfgNode;
}

/** 构建 CFG(start/end + 语句序列 + 说明节点)。 */
function buildBody(opts: {
  family: Family;
  stmts: TsNode[];
  startLabel: string;
  endLabel: string;
  startLine: number;
  endLine: number;
  maxNodes: number;
  exprBody?: TsNode;
}): BodyBuild {
  const ctx = buildCtx("", opts.family, opts.maxNodes);
  const start = newNode(ctx, "start", opts.startLabel, { line: opts.startLine });
  let end: CfgNode = start;
  try {
    end = newNode(ctx, "end", opts.endLabel, { line: opts.endLine });
    ctx.endId = end.id;
    ctx.exitId = end.id;
    if (opts.exprBody) {
      const node = newNode(ctx, "return", `返回 ${clip(condense(opts.exprBody.text), MAX_STMT - 6)}`, {
        code: opts.exprBody.text, line: row(opts.exprBody), lineEnd: endRow(opts.exprBody),
      });
      link(ctx, start.id, node.id);
      link(ctx, node.id, ctx.exitId, "返回", "return");
      ctx.returns++;
    } else {
      const tails = emitSeq(ctx, opts.stmts, [{ id: start.id }]);
      linkTails(ctx, tails, ctx.endId, "结束");
      // 空体(含只有 pass 的函数):start → end 标成「空函数体」而不是「结束」
      if (ctx.nodes.length === 2 && ctx.edges.length === 1 && ctx.edges[0]!.from === start.id && ctx.edges[0]!.to === ctx.endId) {
        ctx.edges[0] = { ...ctx.edges[0]!, label: "空函数体", kind: "flow" };
      }
    }
  } catch (err) {
    // 显式 --max-nodes 截断:保留已建节点/边,标 truncated(缺省 0 不设上限,不会走这里)
    if (err !== TRUNCATED) throw err;
    ctx.truncated = true;
  }
  return { ctx, start, end };
}

/**
 * 长函数分页(纯展示切分,不丢节点/边):
 * 按节点创建顺序每 ~22 个一页(尽量在完整语句前切,不切 merge/end);
 * 跨页边改成「← 第 N 页」/「→ 第 N 页」跳转桩,原边标签(是/否/循环/返回)保留。
 * 这样长循环体也能按页读,而不必把 100 个节点塞进一张图。
 */
function paginateGraph(fn: CfgFunction): CfgPage[] | undefined {
  const target = 22;
  const pageOf = new Map<string, number>();
  let page = 0;
  let count = 0;
  for (const n of fn.nodes) {
    // 尽量在可读边界切页;merge/end/start 不切(它们要和相邻节点在一起)
    const cutable = n.kind !== "merge" && n.kind !== "end" && n.kind !== "start";
    if (count >= target && cutable) { page++; count = 0; }
    pageOf.set(n.id, page);
    count++;
  }
  const total = page + 1;
  if (total <= 1) return undefined;
  // 说明节点归第 1 页(读图先看上下文);结束节点归最后一页(无论它创建得多早)
  for (const n of fn.nodes) {
    if (n.kind === "note") pageOf.set(n.id, 0);
    else if (n.kind === "end") pageOf.set(n.id, total - 1);
  }

  const groupPages = new Map<string, Set<number>>();
  for (const n of fn.nodes) {
    if (!n.group) continue;
    const p = pageOf.get(n.id);
    if (p === undefined) continue;
    (groupPages.get(n.group) ?? groupPages.set(n.group, new Set()).get(n.group)!).add(p);
  }
  const out: CfgPage[] = [];
  for (let p = 0; p < total; p++) {
    const own = fn.nodes.filter((n) => pageOf.get(n.id) === p);
    if (own.length === 0) continue;
    const inStubs = new Map<number, CfgNode>();
    const outStubs = new Map<number, CfgNode>();
    const edges: CfgEdge[] = [];
    for (const e of fn.edges) {
      const a = pageOf.get(e.from);
      const b = pageOf.get(e.to);
      if (a === undefined || b === undefined) continue;
      if (a === p && b === p) {
        edges.push(e);
      } else if (a === p) {
        let stub = outStubs.get(b);
        if (!stub) {
          const src = fn.nodes.find((n) => n.id === e.from);
          stub = { id: `pg${p}o${b}`, kind: "page", text: `→ 第 ${b + 1} 页`, ...(src?.line ? { line: src.line } : {}) };
          outStubs.set(b, stub);
        }
        edges.push({ ...e, to: stub.id });
      } else if (b === p) {
        let stub = inStubs.get(a);
        if (!stub) {
          const dst = fn.nodes.find((n) => n.id === e.to);
          stub = { id: `pg${p}i${a}`, kind: "page", text: `← 第 ${a + 1} 页`, ...(dst?.line ? { line: dst.line } : {}) };
          inStubs.set(a, stub);
        }
        edges.push({ ...e, from: stub.id });
      }
    }
    // 本页涉及的 group + 祖先(祖先在本页无直接节点时只作外壳)
    const groups: CfgGroup[] = [];
    const addGroup = (id: string): void => {
      if (groups.some((g) => g.id === id)) return;
      const g = fn.groups.find((x) => x.id === id);
      if (!g) return;
      groups.push(g);
      if (g.parent) addGroup(g.parent);
    };
    for (const n of own) if (n.group) addGroup(n.group);
    const labeled = groups.map((g) => ((groupPages.get(g.id)?.size ?? 0) > 1 ? { ...g, label: `${g.label} (续页)` } : g));
    const minLine = own.reduce((m, n) => Math.min(m, n.line ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    const lineStart = minLine === Number.MAX_SAFE_INTEGER ? fn.line : minLine;
    const lineEnd = own.reduce((m, n) => Math.max(m, n.lineEnd ?? n.line ?? 0), lineStart);
    const statements = own.filter((n) => ["stmt", "call", "return", "throw", "break", "continue"].includes(n.kind)).length;
    const decisions = own.filter((n) => n.kind === "cond" || n.kind === "loop").length;
    const loops = own.filter((n) => n.kind === "loop").length;
    const meta: CfgGraphMeta = {
      name: `${fn.name} · 第 ${p + 1}/${total} 页`,
      file: fn.file, line: lineStart, lineEnd,
      stats: {
        statements, decisions, loops,
        calls: fn.stats.calls,
        returns: fn.stats.returns,
        throws: fn.stats.throws,
        complexity: 1 + decisions,
      },
    };
    const nodes = [...inStubs.values(), ...own, ...outStubs.values()];
    out.push({
      index: p, total,
      title: `第 ${p + 1}/${total} 页 · L${lineStart}-${lineEnd}`,
      lineStart, lineEnd, statements, decisions, loops,
      nodeIds: own.map((n) => n.id),
      mermaid: renderGraphMermaid(meta, nodes, edges, labeled, "TD"),
    });
  }
  return out;
}

// ---- 文件级入口 ----

const MAX_FILE_BYTES = 1_500_000;

/** 文件级 CFG。
 *  targets:只构建这些函数名(候选评分/按名查询用;避免整个大文件所有函数都建图)。
 *  pages:false 跳过分页 mermaid 渲染(评分阶段用;选中后再 paginateFunction)。 */
export async function buildFileCfgs(
  root: string,
  relFile: string,
  opts: { maxNodes?: number; pages?: boolean; targets?: { name: string; line?: number }[] } = {},
): Promise<CfgFileResult | null> {
  const lang = decisionLangOf(relFile);
  if (!lang) return null;
  let source: string;
  try {
    source = readFileSync(join(root, relFile), "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(source) > MAX_FILE_BYTES) return null;
  const family = familyOf(lang);
  const parser = await loadTsParser(lang);
  if (!parser) return null;
  let rootNode: TsNode & { hasError?: boolean };
  try {
    rootNode = (parser.parse(source) as unknown as { rootNode: TsNode & { hasError?: boolean } }).rootNode;
  } catch {
    return null;
  }
  if (!rootNode || rootNode.childCount === 0) return null;
  if (rootNode.hasError === true) return null; // 语法错误=整文件拒收,不吐半成品
  const file = relFile.split("\\").join("/");
  const constants = collectConstants(rootNode, family);
  const infosAll = collectFunctions(rootNode, family);
  const infos = opts.targets && opts.targets.length > 0
    ? infosAll.filter((info) => {
      const qualified = info.className ? `${info.className}.${info.name}` : info.name;
      return opts.targets!.some((t) => qualified === t.name || info.name === t.name || qualified.endsWith(`.${t.name}`));
    })
    : infosAll;
  const functions: CfgFunction[] = [];
  for (const info of infos) {
    const fn = buildFunctionFrom(info, family, file, lang, source, constants, opts.maxNodes ?? 0);
    if (opts.pages !== false) paginateFunction(fn);
    functions.push(fn);
  }
  return { file, lang, functions, constants, degraded: false, notes: [] };
}

// ---- 函数选择 ----

function normName(s: string): string {
  return s.replace(/^\(?root\)?\./, "").split(".").pop() ?? s;
}

export function pickFunction(functions: CfgFunction[], name: string, line?: number): CfgFunction | undefined {
  if (functions.length === 0) return undefined;
  const short = normName(name);
  const matches = functions.filter((f) => f.qualifiedName === name || f.name === name || normName(f.name) === short);
  const pool = matches.length > 0 ? matches : functions;
  if (line && line > 0) {
    const inside = pool.filter((f) => f.line <= line && line <= f.lineEnd);
    if (inside.length > 0) return inside.sort((a, b) => (a.lineEnd - a.line) - (b.lineEnd - b.line))[0];
    return pool.slice().sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
  }
  if (matches.length > 0) return matches[0];
  return undefined;
}

function mdCode(s: string, markdown: boolean): string {
  return markdown ? `\`${s.replace(/`/g, "'")}\`` : s;
}

/**
 * 函数说明的展示行(页面表格 / CLI 文本共用):职责、输入、输出、关键判断、循环、
 * 异常、副作用、上下游、模块常量、全部调用、位置。参考 deepwiki-open 的「关键函数表 +
 * 每项有据」结构;没有的事实写「—/索引未提供」,不编造。
 */
export function cfgDescriptionRows(fn: CfgFunction, markdown = true): { label: string; value: string }[] {
  const d = fn.description;
  // Markdown 表格里 `||` 会断列:先换「或」再兜底单竖线;CLI 文本保持原样
  const cell = (s: string, max = 240): string => clip(
    (markdown ? s.replace(/\|\|/g, " 或 ").replace(/\|/g, "/") : s).replace(/\r?\n/g, " "),
    max);
  const params = d.params.slice(0, 6).map((p) => mdCode(p.raw, markdown));
  const paramText = params.length > 0
    ? params.join(", ") + (d.params.length > 6 ? ` …+${d.params.length - 6}` : "")
    : "—";
  const rawOutput = d.returns.length > 0
    ? d.returns.map((r) => mdCode(prettyReturn(r, d.returnType), markdown)).join("; ")
    : d.returnType
      ? mdCode(d.returnType, markdown)
      : "无显式返回(以副作用/异常为主)";
  const output = d.returnType && !rawOutput.includes(d.returnType) ? `${rawOutput} · 类型 ${d.returnType}` : rawOutput;
  const list = (xs: string[], max = 4): string => xs.length > 0
    ? xs.slice(0, max).map((x) => mdCode(x, markdown)).join("; ") + (xs.length > max ? ` …+${xs.length - max}` : "")
    : "—";
  const effects = d.sideEffects.length > 0
    ? d.sideEffects.map((x) => `${x.category}: ${mdCode(x.name, markdown)}`).join("; ")
    : "未检出明显副作用(按调用名启发式)";
  const refs = (xs?: CfgCallRef[]): string => xs && xs.length > 0
    ? xs.slice(0, 4).map((x) => `${x.name}${x.file ? ` @ ${x.file}${x.line ? `:${x.line}` : ""}` : ""}`).join("; ") + (xs.length > 4 ? ` …+${xs.length - 4}` : "")
    : "索引未提供";
  const consts = fn.notes.find((n) => n.title === "模块常量")?.lines.join("; ");
  const calls = fn.stats.calls.length > 0
    ? fn.stats.calls.slice(0, 16).map((c) => mdCode(c, markdown)).join(", ") + (fn.stats.calls.length > 16 ? ` …+${fn.stats.calls.length - 16}` : "")
    : "—";
  return [
    { label: "职责", value: cell(d.purpose) },
    { label: "输入", value: cell(paramText) },
    { label: "输出", value: cell(output) },
    { label: "关键判断", value: cell(list(d.keyConditions, 5)) },
    { label: "循环", value: cell(list(d.loops, 3)) },
    { label: "异常/抛出", value: cell(list(d.raises, 3)) },
    { label: "副作用(按调用名)", value: cell(effects) },
    { label: "上游调用方", value: cell(refs(d.callers)) },
    { label: "下游被调方", value: cell(refs(d.callees)) },
    ...(consts ? [{ label: "模块常量", value: cell(consts) }] : []),
    { label: "全部调用", value: cell(calls) },
    { label: "位置", value: `${fn.file}:${fn.line}-${fn.lineEnd}` },
  ];
}

/** 管线关键函数选择:入口文件优先 + 「决策×3 + 语句 + 调用」评分;不设 node 上限(图全量)。 */
export async function pickPipelineFunctions(
  root: string,
  files: string[],
  entryFiles: string[],
  candidatesIn: { name: string; file: string; line: number }[],
  opts: { max?: number; cache?: Map<string, CfgFileResult | null>; maxNodes?: number } = {},
): Promise<{ functions: CfgFunction[]; candidates: CfgCandidate[]; notes: string[] }> {
  const max = opts.max ?? 3;
  const cache = opts.cache ?? new Map<string, CfgFileResult | null>();
  const notes: string[] = [];
  const entrySet = new Set(entryFiles);
  const seen = new Set<string>();
  const ordered: { name: string; file: string; line: number }[] = [];
  for (const c of candidatesIn) {
    const key = `${c.file}#${normName(c.name)}#${c.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(c);
  }
  // 只保留管线文件里的候选;文件顺序=深度序(接入层在前)
  const fileRank = new Map(files.map((f, i) => [f, i]));
  const considered = ordered
    .filter((c) => fileRank.has(c.file))
    .sort((a, b) => (fileRank.get(a.file)! - fileRank.get(b.file)!) || a.line - b.line)
    .slice(0, 48);
  // 候选按文件分组:一次只构建目标函数(pages:false),不让大文件的全部函数都建图
  const byFile = new Map<string, { name: string; file: string; line: number }[]>();
  for (const c of considered) {
    if (!byFile.has(c.file)) byFile.set(c.file, []);
    byFile.get(c.file)!.push(c);
  }
  for (const [file, list] of byFile) {
    if (cache.has(file)) continue;
    cache.set(file, await buildFileCfgs(root, file, {
      maxNodes: opts.maxNodes,
      pages: false,
      targets: list.map((c) => ({ name: c.name, line: c.line })),
    }));
  }
  // 单函数 150 节点以上不适合塞进档案页(≈7 页图);候选表如实说明并用 CLI 单独看
  const MAX_FN_NODES = 150;
  const picked: { fn: CfgFunction; score: number; entry: boolean }[] = [];
  const records: CfgCandidate[] = [];
  for (const c of considered) {
    const fileRes = cache.get(c.file);
    if (!fileRes) {
      records.push({ ...c, statements: 0, decisions: 0, loops: 0, calls: 0, nodes: 0, score: 0, picked: false, reason: "语言不支持 / 文件不可读 / 语法错误(整文件拒收)" });
      continue;
    }
    const fn = pickFunction(fileRes.functions, c.name, c.line);
    if (!fn) {
      records.push({ ...c, statements: 0, decisions: 0, loops: 0, calls: 0, nodes: 0, score: 0, picked: false, reason: "索引行号处未定位到函数体(可能是类/变量/声明)" });
      continue;
    }
    if (fn.stats.statements < 2 && fn.stats.decisions === 0) {
      records.push({ name: fn.name, qualifiedName: fn.qualifiedName, file: fn.file, line: fn.line, statements: fn.stats.statements, decisions: fn.stats.decisions, loops: fn.stats.loops, calls: fn.stats.calls.length, nodes: fn.nodes.length, score: 0, picked: false, reason: "函数体过短(≤1 条语句且无分支)" });
      continue;
    }
    if (fn.nodes.length > MAX_FN_NODES) {
      records.push({
        name: fn.name, qualifiedName: fn.qualifiedName, file: fn.file, line: fn.line,
        statements: fn.stats.statements, decisions: fn.stats.decisions, loops: fn.stats.loops,
        calls: fn.stats.calls.length, nodes: fn.nodes.length, score: 0, picked: false,
        reason: `函数过大(${fn.nodes.length} 节点,约 ${Math.ceil(fn.nodes.length / 22)} 页),不适合档案页;用 codesense cfg ${fn.name} --full 单独看`,
      });
      continue;
    }
    const entry = entrySet.has(c.file);
    // 90 节点以上的大函数轻微降权:同样清晰度下优先让中小函数进档案页
    const score = fn.stats.decisions * 3 + fn.stats.statements + Math.min(fn.stats.calls.length, 10) + (entry ? 4 : 0)
      - Math.max(0, fn.nodes.length - 90);
    records.push({ name: fn.name, qualifiedName: fn.qualifiedName, file: fn.file, line: fn.line, statements: fn.stats.statements, decisions: fn.stats.decisions, loops: fn.stats.loops, calls: fn.stats.calls.length, nodes: fn.nodes.length, score, picked: false });
    picked.push({ fn, score, entry });
  }
  // 入口优先:每个管线先放一个入口文件里分数最高的函数;其余按分数补
  const chosen: CfgFunction[] = [];
  const entryPick = picked.filter((p) => p.entry).sort((a, b) => b.score - a.score)[0];
  if (entryPick) chosen.push(entryPick.fn);
  for (const p of picked.slice().sort((a, b) => b.score - a.score || a.fn.line - b.fn.line)) {
    if (chosen.length >= max) break;
    if (chosen.some((f) => f.file === p.fn.file && f.name === p.fn.name)) continue;
    chosen.push(p.fn);
  }
  for (const f of chosen) paginateFunction(f);
  for (const r of records) r.picked = chosen.some((f) => f.file === r.file && (f.name === r.name || f.qualifiedName === r.qualifiedName));
  const notPicked = records.filter((r) => !r.picked && !r.reason);
  if (notPicked.length > 0 && records.length > chosen.length) {
    notes.push(`候选 ${records.length} 个函数,按「入口优先 + 决策×3+语句+调用」取前 ${chosen.length};未入选 ${notPicked.length} 个(完整清单见本页候选表)。`);
  }
  return { functions: chosen, candidates: records, notes };
}

// ---- 渲染:文本 ----

export function renderCfgText(fn: CfgFunction, opts: { mermaid?: boolean; full?: boolean; merge?: boolean; header?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.header !== false) lines.push(`codesense cfg ${fn.name} — 函数级控制流图`);
  lines.push(`  ${fn.file}:${fn.line}-${fn.lineEnd} · ${fn.lang} · 签名 ${fn.signature}`);
  lines.push(
    `  语句 ${fn.stats.statements} · 决策 ${fn.stats.decisions} · 循环 ${fn.stats.loops} · 复杂度 ${fn.stats.complexity}` +
    ` · 返回 ${fn.stats.returns} · 抛出 ${fn.stats.throws}` +
    (fn.pages ? ` · 分页 ${fn.pages.length} 页` : ""),
  );
  // 结构化函数说明(参考 deepwiki-open:职责/输入输出/关键判断/上下游,每项可回源)
  for (const row of cfgDescriptionRows(fn, false)) {
    if (row.label === "位置") continue; // 首行已有 file:line
    lines.push(`  ${row.label}: ${row.value}`);
  }
  if (fn.description.details) lines.push(`  源码注释(备注): ${clip(fn.description.details, 220)}`);
  if (fn.truncated) lines.push("  ! 图已按显式上限截断");
  if (opts.mermaid !== false) {
    if (fn.pages && !opts.full && opts.merge !== false) {
      for (const p of fn.pages) {
        lines.push("", `### ${p.title}`, "");
        lines.push("```mermaid");
        lines.push(p.mermaid);
        lines.push("```");
      }
    } else {
      lines.push("");
      lines.push("```mermaid");
      lines.push(renderCfgMermaid(fn, { merge: opts.merge !== false }));
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("读法: 菱形=条件/循环;是/否=分支;紫框=循环体;蓝框=调用;绿=返回;红=抛出;黄=说明;虚线灰框=跨页跳转桩。");
  lines.push("已知边界");
  for (const l of fn.knownLimits) lines.push(`  - ${l}`);
  return lines.join("\n");
}

// ---- 渲染:mermaid ----

/** mermaid 标签转义:方括号必须转义——`["a[b]"]` 的 `]` 会提前闭合节点(经验证 Parse error),
 *  `#` 也要转义,避免源码里的 `#123` 被当实体。 */
const ENT: Record<string, string> = {
  "&": "&amp;", '"': "#quot;", "<": "#lt;", ">": "#gt;", "|": "&#124;",
  "[": "#91;", "]": "#93;", "#": "#35;",
};

function escText(s: string): string {
  return s.replace(/[&"<>|[\]#]/g, (ch) => ENT[ch] ?? ch);
}

function wrapLabel(text: string, width = 46, maxLines = 5): string {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width && out.length < maxLines - 1) {
    let cut = -1;
    for (let i = Math.min(rest.length - 1, width); i >= Math.floor(width * 0.5); i--) {
      if (/[ ,;(:{}]/.test(rest[i]!)) { cut = i + 1; break; }
    }
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out.map(escText).join("<br/>");
}

function nodeLabel(n: CfgNode): string {
 // mermaid 的 circle 节点不接受空引号标签(经验证 Parse error),用空格占位
  if (n.kind === "merge" && !n.text) return " ";
  if (n.kind === "note") {
    const body = (n.code ?? "").split("\n").map((x) => wrapLabel(x, 60, 2));
    return [wrapLabel(n.text, 40, 1), ...body].join("<br/>");
  }
  const main = n.lines && n.lines.length > 1
    ? n.lines.map((x) => wrapLabel(x, 54, 3)).join("<br/>")
    : wrapLabel(n.text, n.kind === "cond" || n.kind === "loop" ? 34 : 54, 5);
  const comment = n.comment ? `<br/><i>${wrapLabel(n.comment, 50, 2)}</i>` : "";
  return main + comment;
}

/** 连续直落语句合并成多行框(纯展示;每条语句仍逐行可见,不丢节点语义)。
 * 只在图较大时启用;合并条件极保守:单出边、单入边、同组、无标签、非分支/循环/返回节点。 */
function mergeStraightChains(nodes: CfgNode[], edges: CfgEdge[], maxPerBox = 3, minNodes = 28): { nodes: CfgNode[]; edges: CfgEdge[] } {
  if (nodes.length < minNodes) return { nodes, edges };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, CfgEdge[]>();
  const inc = new Map<string, CfgEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }
  const mergeable = (n: CfgNode | undefined): n is CfgNode =>
    !!n && (n.kind === "stmt" || n.kind === "call");
  const consumed = new Set<string>();
  const map = new Map<string, string>();
  const replacements = new Map<string, CfgNode>();
  for (const n of nodes) {
    if (consumed.has(n.id) || !mergeable(n)) continue;
    const incoming = inc.get(n.id) ?? [];
    // 链头:不能是另一条可合并语句的直落后继(否则会从中间起链)
    if (incoming.some((e) => e.kind === "flow" && !e.label && mergeable(byId.get(e.from)) && byId.get(e.from)!.group === n.group)) continue;
    const chain: CfgNode[] = [n];
    let cur = n;
    while (chain.length < maxPerBox) {
      const outs = (out.get(cur.id) ?? []).filter((e) => e.kind === "flow" && !e.label);
      if (outs.length !== 1) break;
      const nxt = byId.get(outs[0]!.to);
      if (!nxt || !mergeable(nxt) || nxt.group !== n.group || consumed.has(nxt.id)) break;
      if ((inc.get(nxt.id) ?? []).length !== 1) break;
      chain.push(nxt);
      cur = nxt;
    }
    if (chain.length < 2) continue;
    const first = chain[0]!;
    const last = chain[chain.length - 1]!;
    const calls = [...new Set(chain.flatMap((x) => x.calls ?? []))];
    const comments = chain.map((x) => x.comment).filter((x): x is string => !!x);
    const merged: CfgNode = {
      ...first,
      kind: chain.some((x) => x.kind === "call") ? "call" : "stmt",
      text: chain.map((x) => x.text).join(" / "),
      code: chain.map((x) => x.code ?? x.text).join("\n"),
      lines: chain.map((x) => x.text),
      line: first.line,
      lineEnd: last.lineEnd ?? last.line,
      ...(calls.length > 0 ? { calls } : {}),
      ...(comments.length > 0 ? { comment: comments.join(" / ") } : {}),
    };
    const headId = first.id;
    for (const x of chain) { consumed.add(x.id); map.set(x.id, headId); }
    replacements.set(headId, merged);
  }
  if (replacements.size === 0) return { nodes, edges };
  const newNodes = nodes
    .filter((n) => !consumed.has(n.id) || replacements.has(n.id))
    .map((n) => replacements.get(n.id) ?? n);
  const seen = new Set<string>();
  const newEdges: CfgEdge[] = [];
  for (const e of edges) {
    const from = map.get(e.from) ?? e.from;
    const to = map.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = `${from}->${to}|${e.label ?? ""}|${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    newEdges.push({ ...e, from, to });
  }
  return { nodes: newNodes, edges: newEdges };
}

function nodeShape(n: CfgNode): { open: string; close: string } {
  if (n.kind === "start" || n.kind === "end") return { open: "([", close: "])" };
  if (n.kind === "cond" || n.kind === "loop") return { open: "{", close: "}" };
  if (n.kind === "merge") return { open: "((", close: "))" };
  return { open: "[", close: "]" };
}

function nodeClass(n: CfgNode): string {
  if (n.kind === "start") return "cfgStart";
  if (n.kind === "end") return "cfgEnd";
  if (n.kind === "call") return "cfgCall";
  if (n.kind === "cond") return "cfgCond";
  if (n.kind === "loop") return "cfgLoopHead";
  if (n.kind === "return") return "cfgReturn";
  if (n.kind === "throw") return "cfgThrow";
  if (n.kind === "merge") return "cfgMerge";
  if (n.kind === "note") return "cfgNote";
  if (n.kind === "page") return "cfgPage";
  return "cfgStmt";
}

const GROUP_STYLE: Record<CfgGroupKind, string> = {
  loop: "fill:#efe8fa,stroke:#9a7fc0,color:#2a1a45",
  try: "fill:#e8f4e8,stroke:#6aa06a,color:#0b2410",
  catch: "fill:#fbe3e3,stroke:#c07070,color:#3a0b0b",
  finally: "fill:#f1ece2,stroke:#b0a080,color:#3a2c07",
  with: "fill:#e6f2f5,stroke:#6a9aa8,color:#0e2a33",
};

export interface CfgGraphMeta {
  name: string;
  file: string;
  line: number;
  lineEnd: number;
  stats: CfgStats;
}

function renderGraphMermaid(meta: CfgGraphMeta, nodesIn: CfgNode[], edgesIn: CfgEdge[], groups: CfgGroup[], direction: "TD" | "LR" = "TD", merge = true): string {
  // 图较大时把连续直落语句 3 条一框(全文仍在框内);控制在「能读」的规模,不删语句
  const { nodes, edges } = merge ? mergeStraightChains(nodesIn, edgesIn) : { nodes: nodesIn, edges: edgesIn };
  // 面板默认 rankSpacing=50:语句图节点多,收紧到 36 能少 15-20% 纵向滚动;主题仍由页面控制
  const lines: string[] = [
    '%%{init: {"flowchart": {"nodeSpacing": 26, "rankSpacing": 36, "curve": "basis"}}}%%',
    `flowchart ${direction}`,
  ];
  lines.push(`  %% ${meta.name} — ${meta.file}:${meta.line}-${meta.lineEnd} · 语句 ${meta.stats.statements} · 决策 ${meta.stats.decisions} · 复杂度 ${meta.stats.complexity}`);
  const childrenOf = new Map<string | undefined, CfgGroup[]>();
  const groupIds = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    // 分页时祖先 group 可能不在本页:挂到顶层,别丢子图
    const key = g.parent && groupIds.has(g.parent) ? g.parent : undefined;
    (childrenOf.get(key) ?? childrenOf.set(key, []).get(key)!).push(g);
  }
  const emitNode = (n: CfgNode, indent: string): void => {
    const shape = nodeShape(n);
    lines.push(`${indent}${n.id}${shape.open}"${nodeLabel(n)}"${shape.close}`);
  };
  const emitGroup = (g: CfgGroup, indent: string): void => {
    lines.push(`${indent}subgraph ${g.id}["${escText(g.label)}"]`);
    lines.push(`${indent}  direction TB`);
    for (const n of nodes) if (n.group === g.id) emitNode(n, indent + "  ");
    for (const c of childrenOf.get(g.id) ?? []) emitGroup(c, indent + "  ");
    lines.push(`${indent}end`);
  };
  for (const n of nodes) if (!n.group) emitNode(n, "  ");
  for (const g of childrenOf.get(undefined) ?? []) emitGroup(g, "  ");
  lines.push("");
  for (const e of edges) {
    const arrow = e.kind === "error" || e.kind === "note" || e.kind === "call" || e.kind === "throw" ? "-.->" : "-->";
    const label = e.label ? `|${escText(e.label)}|` : "";
    lines.push(`  ${e.from} ${arrow}${label} ${e.to}`);
  }
  lines.push("");
  for (const n of nodes) lines.push(`  class ${n.id} ${nodeClass(n)};`);
  for (const g of groups) lines.push(`  style ${g.id} ${GROUP_STYLE[g.kind]};`);
  lines.push(
    "  classDef cfgStart fill:#1f6b3a,stroke:#3f9a5a,color:#ffffff,font-weight:bold;",
    "  classDef cfgEnd fill:#1f6b3a,stroke:#3f9a5a,color:#ffffff,font-weight:bold;",
    "  classDef cfgStmt fill:#f6f1e7,stroke:#9c8a6a,color:#241b10;",
    "  classDef cfgCall fill:#dfeaf8,stroke:#5f83ad,color:#0e2038;",
    "  classDef cfgCond fill:#fff4cf,stroke:#b78a24,color:#3a2b05;",
    "  classDef cfgLoopHead fill:#e6dcf7,stroke:#8a6bb8,color:#2a1a45;",
    "  classDef cfgReturn fill:#d9ead3,stroke:#5b8a4a,color:#0b2410;",
    "  classDef cfgThrow fill:#f6d5d8,stroke:#b05050,color:#3a0b0b;",
    "  classDef cfgMerge fill:#e9e3d8,stroke:#b9a98a,color:#5a4a38;",
    "  classDef cfgNote fill:#fff0a8,stroke:#c9a227,color:#3a2c07;",
    "  classDef cfgPage fill:#eceae4,stroke:#9c8a6a,color:#4a3a20,stroke-dasharray:4 3;",
  );
  return lines.join("\n");
}

/** 整函数单图(完整,不切段);长函数的人读形态优先用 fn.segments。
 * merge=false 时逐语句一框(--no-merge;图会很大)。 */
export function renderCfgMermaid(fn: CfgFunction, opts: { direction?: "TD" | "LR"; merge?: boolean } = {}): string {
  return renderGraphMermaid(fn, fn.nodes, fn.edges, fn.groups, opts.direction ?? "TD", opts.merge !== false);
}

// ---- 渲染:DOT(静态图;svg/png 走 graphviz) ----

export function renderCfgDot(fn: CfgFunction): string {
  const shape = (n: CfgNode): string =>
    n.kind === "cond" || n.kind === "loop" ? "diamond"
      : n.kind === "start" || n.kind === "end" ? "ellipse"
        : n.kind === "merge" ? "point"
          : n.kind === "note" ? "note" : "box";
  const fill = (n: CfgNode): string =>
    n.kind === "start" || n.kind === "end" ? "#1f6b3a"
      : n.kind === "call" ? "#dfeaf8"
        : n.kind === "cond" ? "#fff4cf"
          : n.kind === "loop" ? "#e6dcf7"
            : n.kind === "return" ? "#d9ead3"
              : n.kind === "throw" ? "#f6d5d8"
                : n.kind === "note" ? "#fff0a8" : "#f6f1e7";
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  const lines: string[] = [`digraph cfg_${fn.name.replace(/\W/g, "_")} {`, '  rankdir=TB;', '  node [fontname="Microsoft YaHei",fontsize=10];', '  edge [fontname="Microsoft YaHei",fontsize=9,color="#8a7a5a"];'];
  const groupsByParent = new Map<string | undefined, CfgGroup[]>();
  for (const g of fn.groups) (groupsByParent.get(g.parent) ?? groupsByParent.set(g.parent, []).get(g.parent)!).push(g);
  const emitNode = (n: CfgNode, indent: string): void => {
    const label = [n.text, ...(n.comment ? [`// ${n.comment}`] : [])].join("\n");
    lines.push(`${indent}"${n.id}" [label="${esc(label)}",shape=${shape(n)},style="filled",fillcolor="${fill(n)}"];`);
  };
  const emitGroup = (g: CfgGroup, indent: string): void => {
    lines.push(`${indent}subgraph cluster_${g.id} { label="${esc(g.label)}"; style="rounded,filled"; fillcolor="${GROUP_STYLE[g.kind].match(/fill:(#[0-9a-f]+)/i)?.[1] ?? "#f4f0e8"}";`);
    for (const n of fn.nodes) if (n.group === g.id) emitNode(n, indent + "  ");
    for (const c of groupsByParent.get(g.id) ?? []) emitGroup(c, indent + "  ");
    lines.push(`${indent}}`);
  };
  for (const n of fn.nodes) if (!n.group) emitNode(n, "  ");
  for (const g of groupsByParent.get(undefined) ?? []) emitGroup(g, "  ");
  for (const e of fn.edges) {
    const style = e.kind === "error" || e.kind === "note" || e.kind === "call" || e.kind === "throw" ? 'style="dashed",' : "";
    const color = e.kind === "error" || e.kind === "throw" ? 'color="#b05050",' : "";
    const label = e.label ? `label="${esc(e.label)}",` : "";
    lines.push(`  "${e.from}" -> "${e.to}" [${label}${style}${color}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

// ---- JSON ----

export function cfgJson(fn: CfgFunction): Record<string, unknown> {
  return {
    name: fn.name,
    qualifiedName: fn.qualifiedName,
    file: fn.file,
    lang: fn.lang,
    line: fn.line,
    lineEnd: fn.lineEnd,
    signature: fn.signature,
    doc: fn.doc ?? null,
    description: fn.description,
    stats: fn.stats,
    nodes: fn.nodes,
    edges: fn.edges,
    groups: fn.groups,
    notes: fn.notes,
    ...(fn.pages ? { pages: fn.pages } : {}),
    truncated: fn.truncated,
    knownLimits: fn.knownLimits,
  };
}

