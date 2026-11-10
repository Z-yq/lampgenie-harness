/**
 * sensing/decision:分支/循环决策点感知——「这个调用在什么条件下发生」。
 * 背景(ASR 考题注意盲区):refs 能定位条件键(vad_endpointing_mode 在 qwen_asr.py:226),
 * 但「if/else 后果」(哪个分支走哪条路)必须回去读源码。本模块把控制流骨架做成一等能力:
 *   if/elif/else 条件文本 + while/do-while/for/for-of/for-in/switch/case/default 循环语义
 *   (迭代目标 ← 被迭代对象)+ 三元 + 每个分支**直接归属**的调用清单 + 所属函数。
 * 形态(probe 经验证,tree-sitter-wasms 0.1.13):
 *   python  if_statement{condition,consequence,alternative=elif_clause|else_clause}(elif/else 独立节点);
 *   js/ts   if_statement{condition,consequence,alternative=else_clause},else-if=else_clause 包 if_statement,
 *           三元=ternary_expression;typescript wasm 独立(typescript 注解在 javascript 语法下必 ERROR);
 *   c/cpp   同 js 形态,for_statement{initializer,condition,update},cpp for_range_loop;三元=conditional_expression;
 *   java    if_statement{condition,alternative 直接挂 if_statement|block(无 else_clause 包装)};
 *           enhanced_for_statement{name,value};switch=switch_expression{switch_block_statement_group};
 *   go      if_statement{condition,alternative 直接挂}(同 java);for 三态:for_clause/range_clause/裸条件;
 *           expression_switch_statement{expression_case|default_case}。
 * 纪律:tree-sitter 不可用=行级降级(kind+条件文本,深度按缩断推断,无归属/调用);语法错误区间
 * (ERROR 节点行界)内的决策点跳过不采;截断/降级写进 knownLimits,不静默。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTsParser, type TsLang } from "../adapters/tree-sitter";

export type DecisionKind =
  | "if" | "elif" | "else" | "while" | "do-while" | "for" | "for-of" | "for-in"
  | "switch" | "case" | "default" | "ternary";

export interface DecisionPoint {
  kind: DecisionKind;
  /** 1-based,含分支体。 */
  lineStart: number;
  lineEnd: number;
  /** 决策嵌套深度(0=函数体内第一层)。 */
  depth: number;
  /** 条件文本(压缩空白/剥一层括号,≤120 字符);else/default/infinite 无。 */
  condition?: string;
  /** for/for-of/for-in/range:迭代变量。 */
  loopTarget?: string;
  /** 被迭代对象(range 右侧/迭代器)。 */
  loopIterates?: string;
  /** 条件/case 值里的字符串字面量(与 refs 字面量键联动;封顶 3)。 */
  literals: string[];
  /** 本层直接归属的调用(含条件内调用;嵌套分支的调用归最内层;封顶 8)。 */
  calls: string[];
  /** 所属函数/方法名(最近外层命名声明;文件顶层=缺省)。 */
  fn?: string;
}

export interface DecisionScanResult {
  query: "branches";
  file: string;
  root: string;
  lang: string;
  engine: "tree-sitter" | "text";
  /** 源文件含 ERROR 节点(错误区间内的点已跳过,其余照采)。 */
  degraded: boolean;
  truncated: boolean;
  totals: { points: number; functions: number };
  points: DecisionPoint[];
  knownLimits: string[];
}

// ---- tree-sitter 节点最小接口(与 adapters/tree-sitter.ts 同款,不导出故本地重申) ----

interface TsNode {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  childCount: number;
  childForFieldName(f: string): TsNode | null;
  children: TsNode[] | (() => TsNode[]);
  namedChildren?: TsNode[] | (() => TsNode[]);
  text: string;
}

function childrenOf(n: TsNode): TsNode[] {
  const c = n.children;
  return typeof c === "function" ? c.call(n) : (c ?? []);
}

/** 具名子(剥匿名关键字 token——裸 for 的条件挑拣不能用 childrenOf,否则挑到 `for` 自身)。 */
function namedChildrenOf(n: TsNode): TsNode[] {
  const c = n.namedChildren;
  if (!c) return childrenOf(n).filter((x) => !["for", "else", "{", "}", "(", ")", ":", ";", ","].includes(x.type));
  return typeof c === "function" ? c.call(n) : c;
}

// ---- 语言映射 ----

/** 决策感知语言族:js 族含 typescript(独立 wasm);py/c/java/go 各自。 */
type Family = "py" | "js" | "c" | "java" | "go";

export function decisionLangOf(file: string): TsLang | undefined {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" || ext === ".vue" || ext === ".svelte") return "javascript";
  if (ext === ".c" || ext === ".h") return "c";
  if (ext === ".cc" || ext === ".cpp" || ext === ".cxx" || ext === ".hpp" || ext === ".hh") return "cpp";
  if (ext === ".java") return "java";
  if (ext === ".go") return "go";
  return undefined;
}

function familyOf(lang: TsLang): Family {
  if (lang === "python") return "py";
  if (lang === "javascript" || lang === "typescript") return "js";
  if (lang === "c" || lang === "cpp") return "c";
  if (lang === "java") return "java";
  return "go";
}

// ---- 文本工具 ----

const MAX_COND = 120;

function normCond(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let t = text.replace(/\s+/g, " ").trim();
  // 剥一层外括号(c/js/java 条件节点/condition_clause 自带)
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
  // js for 条件是 expression_statement,带尾分号
  t = t.replace(/;\s*$/, "");
  if (!t) return undefined;
  return t.length > MAX_COND ? t.slice(0, MAX_COND) + "…" : t;
}

function literalsOf(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\\n]){1,60})\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 3) out.push(m[2]!);
  return out;
}

/** web-tree-sitter 的 child 访问每次可能返回新包装对象,引用比较不可靠——
 * 节点身份用「类型@起止行」(同型同跨度的两个不同节点在同一语法树里不存在)。 */
function nodeKey(n: TsNode): string {
  return `${n.type}@${n.startPosition.row}-${n.endPosition.row}`;
}

// ---- 决策点抽取(按语言族分派) ----

interface PartialPoint {
  kind: DecisionKind;
  lineStart: number;
  lineEnd: number;
  condition?: string;
  loopTarget?: string;
  loopIterates?: string;
  /** 本点要递归的子树(分支体+条件表达式;空=不单独递归,走泛化通道)。 */
  scopes: TsNode[];
}

function row(n: TsNode): number { return n.startPosition.row + 1; }
function endRow(n: TsNode): number { return n.endPosition.row + 1; }

/** else-if 判定:本 if 的父节点形态 = else_clause(js/c)或 if_statement.alternative(java/go,
 * 后者须按节点身份比较——childForFieldName 与 childrenOf 的返回值不是同一包装对象)。 */
function isElseIfChain(n: TsNode, parent: TsNode | undefined): boolean {
  if (!parent) return false;
  if (parent.type === "else_clause") return true;
  if (parent.type === "if_statement") {
    const alt = parent.childForFieldName("alternative");
    return alt !== null && nodeKey(alt) === nodeKey(n);
  }
  return false;
}

/** 泛化取三元条件:老 js 语法 ternary_expression 无字段名,取 ? 前的首子;其余走 condition 字段。 */
function ternaryCondition(n: TsNode): string | undefined {
  return n.childForFieldName("condition")?.text ?? childrenOf(n)[0]?.text;
}

/** js for-in/of 同节点类型区分(tree-sitter-wasms 0.1.13 的 js 语法把 of 形态也归 for_in_statement)。 */
function forKind(n: TsNode): "for-of" | "for-in" {
  const left = n.childForFieldName("left");
  const right = n.childForFieldName("right");
  if (left && right) {
    const mid = n.text.slice(n.text.indexOf(left.text) + left.text.length, n.text.indexOf(right.text, n.text.indexOf(left.text)));
    if (/\bof\b/.test(mid)) return "for-of";
    if (/\bin\b/.test(mid)) return "for-in";
  }
  return /\bof\b/.test(n.text) ? "for-of" : "for-in";
}

/** 一个语法节点可产多个点(java/go 的 if_statement 同时产 if 点与 else 点);空数组=非决策节点。 */
function decisionsOf(n: TsNode, family: Family, parent: TsNode | undefined): PartialPoint[] {
  const t = n.type;
  const cond = (f = "condition") => normCond(n.childForFieldName(f)?.text);
  const body = (f = "body") => n.childForFieldName(f);
  const point = (kind: DecisionKind, lineStart: number, lineEnd: number, extra?: Partial<PartialPoint>): PartialPoint =>
    ({ kind, lineStart, lineEnd, scopes: [], ...extra });

  // ---- python ----
  if (family === "py") {
    switch (t) {
      case "if_statement": {
        // if 点只覆盖首分支(elif/else 是兄弟节点,各自成点)
        const c = n.childForFieldName("consequence");
        return [{ ...point("if", row(n), c ? endRow(c) : endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), c].filter(Boolean) as TsNode[] }];
      }
      case "elif_clause": {
        const c = n.childForFieldName("consequence");
        return [{ ...point("elif", row(n), endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), c].filter(Boolean) as TsNode[] }];
      }
      case "else_clause":
        return [{ ...point("else", row(n), endRow(n)), scopes: [body()] .filter(Boolean) as TsNode[] }];
      case "while_statement":
        return [{ ...point("while", row(n), endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), body()].filter(Boolean) as TsNode[] }];
      case "for_statement":
        return [{
          ...point("for", row(n), endRow(n)),
          condition: undefined,
          loopTarget: n.childForFieldName("left")?.text.replace(/\s+/g, " "),
          loopIterates: n.childForFieldName("right")?.text.replace(/\s+/g, " "),
          scopes: [body()].filter(Boolean) as TsNode[],
        }];
      case "conditional_expression": {
        // g(a) if b else h(a):条件=if 关键字后的下一个具名子
        const kids = childrenOf(n);
        const at = kids.findIndex((c) => c.type === "if");
        const c = at >= 0 ? kids[at + 1] : undefined;
        return [{ ...point("ternary", row(n), endRow(n), { condition: normCond(c?.text) }), scopes: [] }];
      }
      default:
        return [];
    }
  }

  // ---- javascript / typescript ----
  if (family === "js") {
    switch (t) {
      case "if_statement": {
        const alt = n.childForFieldName("alternative");
        return [{ ...point(isElseIfChain(n, parent) ? "elif" : "if", row(n), alt ? row(alt) - 1 : endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), n.childForFieldName("consequence")].filter(Boolean) as TsNode[] }];
      }
      case "else_clause": {
        const stmt = childrenOf(n).find((c) => c.type !== "else");
        if (!stmt || stmt.type === "if_statement") return []; // else-if 链:点归嵌套 if(elif)
        return [{ ...point("else", row(n), endRow(n)), scopes: [stmt] }];
      }
      case "while_statement":
        return [{ ...point("while", row(n), endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), body()].filter(Boolean) as TsNode[] }];
      case "for_statement":
        return [{ ...point("for", row(n), endRow(n), { condition: cond() }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      case "for_in_statement":
      case "for_of_statement":
        return [{
          ...point(forKind(n), row(n), endRow(n)),
          loopTarget: n.childForFieldName("left")?.text.replace(/\s+/g, " "),
          loopIterates: n.childForFieldName("right")?.text.replace(/\s+/g, " "),
          scopes: [body()].filter(Boolean) as TsNode[],
        }];
      case "switch_statement":
        return [{ ...point("switch", row(n), endRow(n), { condition: cond("value") ?? cond() }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      case "switch_case":
        return [{ ...point("case", row(n), endRow(n), { condition: normCond(n.childForFieldName("value")?.text) }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      case "switch_default":
        return [{ ...point("default", row(n), endRow(n)), scopes: [body()].filter(Boolean) as TsNode[] }];
      case "ternary_expression":
      case "conditional_expression":
        return [{ ...point("ternary", row(n), endRow(n), { condition: normCond(ternaryCondition(n)) }), scopes: [] }];
      default:
        return [];
    }
  }

  // ---- c / cpp ----
  if (family === "c") {
    switch (t) {
      case "if_statement": {
        const alt = n.childForFieldName("alternative");
        return [{ ...point(isElseIfChain(n, parent) ? "elif" : "if", row(n), alt ? row(alt) - 1 : endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), n.childForFieldName("consequence")].filter(Boolean) as TsNode[] }];
      }
      case "else_clause": {
        const stmt = childrenOf(n).find((c) => c.type !== "else");
        if (!stmt || stmt.type === "if_statement") return [];
        return [{ ...point("else", row(n), endRow(n)), scopes: [stmt] }];
      }
      case "while_statement":
        return [{ ...point("while", row(n), endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), body()].filter(Boolean) as TsNode[] }];
      case "do_statement":
        return [{ ...point("do-while", row(n), endRow(n), { condition: cond() }),
          scopes: [body(), n.childForFieldName("condition")].filter(Boolean) as TsNode[] }];
      case "for_statement":
        return [{ ...point("for", row(n), endRow(n), { condition: cond() }),
          scopes: [body(), n.childForFieldName("condition")].filter(Boolean) as TsNode[] }];
      case "for_range_loop": // tree-sitter-wasms 0.1.13 的 cpp 形态
      case "range_based_for_statement": {
        const target = n.childForFieldName("declarator") ?? n.childForFieldName("left");
        return [{
          ...point("for-of", row(n), endRow(n)),
          loopTarget: target?.text.replace(/\s+/g, " "),
          loopIterates: n.childForFieldName("right")?.text.replace(/\s+/g, " "),
          scopes: [body()].filter(Boolean) as TsNode[],
        }];
      }
      case "switch_statement":
        return [{ ...point("switch", row(n), endRow(n), { condition: cond() }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      case "case_statement": {
        const val = n.childForFieldName("value") ?? n.childForFieldName("values");
        if (!val) return [point("default", row(n), endRow(n))]; // default: 无 value 子
        const scopes = namedChildrenOf(n).filter((c) => nodeKey(c) !== nodeKey(val));
        return [{ ...point("case", row(n), endRow(n), { condition: normCond(val.text) }), scopes }];
      }
      case "conditional_expression":
        return [{ ...point("ternary", row(n), endRow(n), { condition: cond() }), scopes: [] }];
      default:
        return [];
    }
  }

  // ---- java(alternative 直挂 if_statement|block,无 else_clause 包装) ----
  if (family === "java") {
    switch (t) {
      case "if_statement": {
        const alt = n.childForFieldName("alternative");
        const out: PartialPoint[] = [{
          ...point(isElseIfChain(n, parent) ? "elif" : "if", row(n), alt ? row(alt) - 1 : endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), n.childForFieldName("consequence")].filter(Boolean) as TsNode[],
        }];
        if (alt && alt.type !== "if_statement") {
          const elseKw = childrenOf(n).find((c) => c.type === "else");
          out.push(point("else", elseKw ? row(elseKw) : row(alt), endRow(alt), { scopes: [alt] }));
        }
        return out;
      }
      case "while_statement":
        return [{ ...point("while", row(n), endRow(n), { condition: cond() }),
          scopes: [n.childForFieldName("condition"), body()].filter(Boolean) as TsNode[] }];
      case "do_statement":
        return [{ ...point("do-while", row(n), endRow(n), { condition: cond() }),
          scopes: [body(), n.childForFieldName("condition")].filter(Boolean) as TsNode[] }];
      case "for_statement":
        return [{ ...point("for", row(n), endRow(n), { condition: cond() }),
          scopes: [body(), n.childForFieldName("condition")].filter(Boolean) as TsNode[] }];
      case "enhanced_for_statement":
        return [{
          ...point("for-of", row(n), endRow(n)),
          loopTarget: n.childForFieldName("name")?.text,
          loopIterates: n.childForFieldName("value")?.text,
          scopes: [body()].filter(Boolean) as TsNode[],
        }];
      case "switch_expression":
      case "switch_statement":
        return [{ ...point("switch", row(n), endRow(n), { condition: cond() }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      case "switch_block_statement_group": {
        const label = childrenOf(n).find((c) => c.type === "switch_label");
        const text = label?.text ?? "";
        const scopes = namedChildrenOf(n).filter((c) => c.type !== "switch_label");
        if (/^default\b/.test(text)) return [{ ...point("default", row(n), endRow(n)), scopes }];
        return [{ ...point("case", row(n), endRow(n), { condition: normCond(text.replace(/^case\s*/, "")) }), scopes }];
      }
      case "switch_rule":
        return [{ ...point("case", row(n), endRow(n), { condition: normCond(n.childForFieldName("value")?.text) }), scopes: [] }];
      case "ternary_expression":
      case "conditional_expression":
        return [{ ...point("ternary", row(n), endRow(n), { condition: normCond(ternaryCondition(n)) }), scopes: [] }];
      default:
        return [];
    }
  }

  // ---- go(alternative 直挂,同 java;for 三态:for_clause/range_clause/裸条件) ----
  switch (t) {
    case "if_statement": {
      const alt = n.childForFieldName("alternative");
      const out: PartialPoint[] = [{
        ...point(isElseIfChain(n, parent) ? "elif" : "if", row(n), alt ? row(alt) - 1 : endRow(n), { condition: cond() }),
        scopes: [n.childForFieldName("condition"), n.childForFieldName("consequence")].filter(Boolean) as TsNode[],
      }];
      if (alt && alt.type !== "if_statement") {
        const elseKw = childrenOf(n).find((c) => c.type === "else");
        out.push(point("else", elseKw ? row(elseKw) : row(alt), endRow(alt), { scopes: [alt] }));
      }
      return out;
    }
    case "for_statement": {
      const forClause = childrenOf(n).find((c) => c.type === "for_clause");
      const rangeClause = childrenOf(n).find((c) => c.type === "range_clause");
      if (rangeClause) {
        return [{
          ...point("for-of", row(n), endRow(n)),
          loopTarget: rangeClause.childForFieldName("left")?.text.replace(/\s+/g, " "),
          loopIterates: rangeClause.childForFieldName("right")?.text.replace(/\s+/g, " "),
          scopes: [body()].filter(Boolean) as TsNode[],
        }];
      }
      if (forClause) {
        return [{ ...point("for", row(n), endRow(n), { condition: normCond(forClause.childForFieldName("condition")?.text) }),
          scopes: [body()].filter(Boolean) as TsNode[] }];
      }
      // 裸条件 while 形态(for b > 0)/无限 for {}:条件=首个具名非 block 子
      const expr = namedChildrenOf(n).find((c) => c.type !== "block" && c.type !== "comment");
      return [{ ...point("for", row(n), endRow(n), { condition: normCond(expr?.text) }),
        scopes: [expr, body()].filter(Boolean) as TsNode[] }];
    }
    case "expression_switch_statement":
      return [{ ...point("switch", row(n), endRow(n), { condition: normCond(n.childForFieldName("value")?.text) }),
        scopes: [body()].filter(Boolean) as TsNode[] }];
    case "expression_case": {
      const val = n.childForFieldName("value");
      const scopes = namedChildrenOf(n).filter((c) => !val || nodeKey(c) !== nodeKey(val));
      return [{ ...point("case", row(n), endRow(n), { condition: normCond(val?.text) }), scopes }];
    }
    case "default_case":
      return [point("default", row(n), endRow(n))];
    default:
      return [];
  }
}

// ---- 函数归属 ----

const FN_KINDS: Record<Family, string[]> = {
  py: ["function_definition"],
  js: ["function_declaration", "method_definition", "generator_function_declaration"],
  c: ["function_definition"],
  java: ["method_declaration", "constructor_declaration"],
  go: ["function_declaration", "method_declaration"],
};

function fnNameOf(n: TsNode, family: Family): string | undefined {
  const direct = n.childForFieldName("name")?.text ?? childrenOf(n).find((c) => c.type === "identifier")?.text;
  if (direct && /^[\w$]+$/.test(direct)) return direct;
  if (family === "c") {
    // c function_definition:declarator → function_declarator → identifier,取声明器文本首标识符
    const decl = n.childForFieldName("declarator");
    const m = decl && /^[\s*&]*([A-Za-z_]\w*)/.exec(decl.text.replace(/\s+/g, " "));
    return m?.[1];
  }
  return undefined;
}

// ---- 调用抽取(归属最内层决策点) ----

const CALL_KINDS: Record<Family, string> = {
  py: "call",
  js: "call_expression",
  c: "call_expression",
  java: "method_invocation",
  go: "call_expression",
};

const CALL_KEYWORDS = new Set([
  "if", "else", "while", "for", "switch", "case", "return", "sizeof", "typeof",
  "new", "delete", "throw", "raise", "assert", "defer", "go", "make", "panic",
]);

function callNameOf(n: TsNode, family: Family): string | undefined {
  let t: string | undefined;
  if (family === "java") t = n.childForFieldName("name")?.text ?? childrenOf(n)[0]?.text;
  else if (family === "c") t = n.childForFieldName("function")?.text ?? childrenOf(n)[0]?.text;
  else t = childrenOf(n)[0]?.text;
  if (!t) return undefined;
  const name = t.replace(/\s+/g, "").split(".").at(-1) ?? t;
  return /^[\w$]+$/.test(name) && !CALL_KEYWORDS.has(name) ? name : undefined;
}

// ---- 主提取(tree-sitter) ----

const MAX_POINTS = 200;
const MAX_CALLS = 8;

function collectErrorRows(n: TsNode, out: Array<[number, number]>): void {
  if (n.type === "ERROR" || n.type.startsWith("missing")) out.push([n.startPosition.row, n.endPosition.row]);
  for (const c of childrenOf(n)) collectErrorRows(c, out);
}

function inErrorRows(rows: Array<[number, number]>, r0: number, r1: number): boolean {
  return rows.some(([a, b]) => r0 <= b + 1 && r1 >= a + 1);
}

export async function extractDecisionPoints(lang: TsLang, source: string): Promise<DecisionPoint[] | null> {
  const parser = await loadTsParser(lang);
  if (!parser) return null;
  let root: TsNode & { hasError?: boolean };
  try {
    root = (parser.parse(source) as unknown as { rootNode: TsNode & { hasError?: boolean } }).rootNode;
  } catch {
    return null;
  }
  if (!root || root.childCount === 0) return null;

  const family = familyOf(lang);
  const errorRows: Array<[number, number]> = [];
  const degraded = root.hasError === true;
  if (degraded) collectErrorRows(root, errorRows);

  const fnKinds = new Set(FN_KINDS[family]);
  const callKind = CALL_KINDS[family];
  const points: DecisionPoint[] = [];
  const fnStack: string[] = [];
  let truncated = false;

  const walk = (node: TsNode, parent: TsNode | undefined, stack: DecisionPoint[]): void => {
    if (fnKinds.has(node.type)) {
      const name = fnNameOf(node, family);
      if (name) fnStack.push(name);
      for (const c of childrenOf(node)) walk(c, node, stack);
      if (name) fnStack.pop();
      return;
    }
    const partials = truncated ? [] : decisionsOf(node, family, parent);
    const usable = partials.filter((p) => !inErrorRows(errorRows, p.lineStart, p.lineEnd));
    if (usable.length > 0) {
      if (points.length + usable.length > MAX_POINTS) {
        truncated = true;
      } else {
        // 每个点(如 java 的 if+else)各自的 scope 子节点(条件/分支体)挂各自栈;
        // 其余子节点(clause/alternative 的 else 关键字等)走原栈——兄弟点与嵌套
        // 决策的调用不重复计入外层。
        const stackByKey = new Map<string, DecisionPoint[]>();
        for (const partial of usable) {
          const point: DecisionPoint = {
            kind: partial.kind,
            lineStart: partial.lineStart,
            lineEnd: partial.lineEnd,
            depth: stack.length,
            literals: [...literalsOf(partial.condition)],
            calls: [],
            ...(partial.condition ? { condition: partial.condition } : {}),
            ...(partial.loopTarget ? { loopTarget: partial.loopTarget } : {}),
            ...(partial.loopIterates ? { loopIterates: partial.loopIterates } : {}),
            ...(fnStack.length > 0 ? { fn: fnStack[fnStack.length - 1] } : {}),
          };
          points.push(point);
          for (const s of partial.scopes) stackByKey.set(nodeKey(s), [...stack, point]);
        }
        for (const c of childrenOf(node)) {
          walk(c, node, stackByKey.get(nodeKey(c)) ?? stack);
        }
        return;
      }
    }
    if (node.type === callKind && stack.length > 0) {
      const name = callNameOf(node, family);
      const sink = stack[stack.length - 1]!;
      if (name && !sink.calls.includes(name) && sink.calls.length < MAX_CALLS) sink.calls.push(name);
    }
    for (const c of childrenOf(node)) walk(c, node, stack);
  };

  walk(root, undefined, []);
  points.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
  if (truncated) points.length = Math.min(points.length, MAX_POINTS);
  return points;
}

// ---- 行级降级(tree-sitter 不可用:kind+条件文本,深度按缩进推断) ----

const TEXT_RULES: Array<{ re: RegExp; kind: DecisionKind }> = [
  { re: /^\s*(?:}\s*else\s+)?if\b\s*\(?(.*?)(?:\):|\)\s*\{?|\:)\s*$/, kind: "if" },
  { re: /^\s*(?:el)?if\b\s*(.*?)\s*:?\s*$/, kind: "elif" },
  { re: /^\s*else\s*(?:if\b(.*))?[\{: ]*$/, kind: "else" },
  { re: /^\s*while\b\s*\(?(.*?)\)?\s*\{?\s*:?\s*$/, kind: "while" },
  { re: /^\s*for\b\s*(.*)$/, kind: "for" },
  { re: /^\s*switch\b\s*\(?(.*?)\)?\s*\{?\s*$/, kind: "switch" },
  { re: /^\s*case\b\s*(.*?):\s*$/, kind: "case" },
  { re: /^\s*default\b\s*:?\s*$/, kind: "default" },
];

function textEnginePoints(source: string): DecisionPoint[] {
  const out: DecisionPoint[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length && out.length < MAX_POINTS; i++) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    for (const rule of TEXT_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const cond = normCond(m[1]?.trim());
      out.push({
        kind: rule.kind,
        lineStart: i + 1,
        lineEnd: i + 1,
        depth: Math.floor(indent / 2),
        literals: literalsOf(cond),
        calls: [],
        ...(cond ? { condition: cond } : {}),
      });
      break;
    }
  }
  return out;
}

// ---- 文件级入口 ----

const MAX_FILE_BYTES = 1_500_000;

const TREE_LIMITS = [
  "体内/条件调用取语法树调用名(属性/方法取末段,接收者不辨);嵌套分支的调用归最内层分支;封顶 8 个/点。",
  "条件文本为原文压缩(≤120 字符,剥一层外括号);多行表达式/宏不展开。",
  "决策点上限 200/文件;Go 无 while 语法,裸条件 for 的 kind 仍为 for(条件即循环条件)。",
];

export async function scanDecisionFile(root: string, relFile: string): Promise<DecisionScanResult | null> {
  const lang = decisionLangOf(relFile);
  if (!lang) return null;
  let text: string;
  try {
    text = readFileSync(join(root, relFile), "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) return null;
  const file = relFile.split("\\").join("/");
  const tsPoints = await extractDecisionPoints(lang, text);
  if (tsPoints === null) {
    const points = textEnginePoints(text);
    return {
      query: "branches", file, root, lang: `${lang}(行级降级)`, engine: "text", degraded: true,
      truncated: points.length >= MAX_POINTS, totals: { points: points.length, functions: 0 }, points,
      knownLimits: ["tree-sitter 不可用,已行级降级:无函数归属/体内调用/嵌套归属,深度按缩进推断。", ...TREE_LIMITS],
    };
  }
  const functions = new Set(tsPoints.map((p) => p.fn).filter(Boolean)).size;
  return {
    query: "branches", file, root, lang, engine: "tree-sitter", degraded: false,
    truncated: tsPoints.length >= MAX_POINTS,
    totals: { points: tsPoints.length, functions }, points: tsPoints,
    knownLimits: TREE_LIMITS,
  };
}

/** 命中行所在的最内层决策点(refs 标注用;points 需已按 lineStart 升序)。 */
export function innermostDecisionAt(points: DecisionPoint[], line: number): DecisionPoint | undefined {
  let best: DecisionPoint | undefined;
  for (const p of points) {
    if (p.lineStart <= line && line <= p.lineEnd) {
      if (!best || p.lineStart >= best.lineStart) best = p;
    }
  }
  return best;
}

// ---- 渲染 ----

export function renderDecisionSkeleton(r: DecisionScanResult): string {
  const lines: string[] = [];
  lines.push(`codesense branches ${r.file} — 分支/循环骨架(if/elif/else/while/for/switch/三元)`);
  lines.push(`  root: ${r.root}`);
  lines.push(
    `  引擎: ${r.engine}(${r.lang}) | 决策点 ${r.totals.points}(函数 ${r.totals.functions})` +
    (r.degraded ? " | 已降级" : "") + (r.truncated ? " | 已截断(上限 200)" : ""),
  );
  if (r.points.length === 0) {
    lines.push("");
    lines.push("(零决策点——文件无 if/while/for/switch,或全部落在错误区间;见已知边界)");
  }
  let curFn: string | null | undefined;
  for (const p of r.points) {
    const fnKey = p.fn ?? null;
    if (fnKey !== curFn) {
      curFn = fnKey;
      lines.push("");
      lines.push(fnKey ? `[${fnKey}]` : "(文件顶层)");
    }
    const indent = "  ".repeat(p.depth + 1);
    const head = `${p.kind.padEnd(8)}`;
    const cond = p.condition ? ` ${p.condition}` : "";
    const span = `(${p.lineStart}-${p.lineEnd})`;
    lines.push(`${indent}${head}${cond} ${span}`);
    if (p.loopTarget || p.loopIterates) {
      lines.push(`${indent}         迭代: ${p.loopTarget ?? "?"} ← ${p.loopIterates ?? "?"}`);
    }
    if (p.calls.length > 0) lines.push(`${indent}         调用: ${p.calls.join(", ")}`);
  }
  lines.push("");
  lines.push("已知边界");
  for (const l of r.knownLimits) lines.push(`  - ${l}`);
  return lines.join("\n");
}
