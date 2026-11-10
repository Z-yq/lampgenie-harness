/**
 * Rust / C# / Ruby / PHP 结构 adapter 共用件(2026-10-25)。
 *
 * 这四个语言走 tree-sitter wasm 主路径(adapters/tree-sitter.ts 的 loadTsParser),
 * 本模块只做节点视图/错误区间/签名解析/类型文本归一的单一真相,避免四份拷贝漂移。
 * 纪律与既有 adapter 一致:
 * - 语法错误容忍:只提取「子树无错」的声明;调用点落在 ERROR 区间内不猜(宁缺勿错)。
 * - 签名解析只做确定性形态(无类型标注的参数名照记;复杂模式/元组不猜,跳过该参数)。
 * - 类型文本归一(baseType)只为 receiverType 证据服务:剥引用/可空/泛型实参/命名空间,
 *   泛型容器不还原元素类型,数组/联合类型不判(防把 List<Foo> 的调用算到 Foo 上)。
 */
import type { Signature } from "../callgraph/engine";
import { splitTopLevel } from "./braces";
import { loadTsParser, type TsLang } from "./tree-sitter";

/** web-tree-sitter 0.25 节点视图(只声明本模块用到的面)。 */
export interface LangNode {
  /** 节点身份:web-tree-sitter 每次属性访问返回新包装对象,**引用比较必失效** ——
   * 祖先/包含判定必须用 id(与 AGENTS.md 2026-10-21 决策点感知同一踩坑)。 */
  id?: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column?: number };
  endPosition: { row: number; column?: number };
  childCount: number;
  child(i: number): LangNode | null;
  /** 0.24+:属性 getter;旧版:方法。 */
  children: LangNode[] | (() => LangNode[]);
  parent: LangNode | null;
  hasError?: boolean;
  childForFieldName?(name: string): LangNode | null;
  descendantsOfType(types: string | string[]): LangNode[];
}

export function childrenOf(node: LangNode): LangNode[] {
  const c = node.children;
  return typeof c === "function" ? c.call(node) : (c ?? []);
}

export function fieldOf(node: LangNode, name: string): LangNode | undefined {
  return node.childForFieldName?.(name) ?? undefined;
}

/** 场景:节点自身或任意后代含错。声明提取前必查(语法恢复节点不冒充声明)。 */
export function containsError(node: LangNode): boolean {
  if (node.hasError === true) return true;
  if (node.type === "ERROR" || node.type.startsWith("missing")) return true;
  return childrenOf(node).some(containsError);
}

export interface LangErrorRange {
  start: number;
  end: number;
}

/** ERROR 区间(只收 ERROR;missing 是零宽标记不算区间)。 */
export function collectErrorRanges(node: LangNode, out: LangErrorRange[] = []): LangErrorRange[] {
  const stack: LangNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "ERROR") {
      out.push({ start: n.startIndex, end: n.endIndex });
      continue;
    }
    if (n.type.startsWith("missing")) continue;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

export function inErrorRange(node: LangNode, ranges: LangErrorRange[] | undefined): boolean {
  if (!ranges || ranges.length === 0) return false;
  for (const r of ranges) if (node.startIndex >= r.start && node.startIndex < r.end) return true;
  return false;
}

/** 解析根节点(wasm 不可用/parse 异常=undefined,调用方回退文本解析)。
 * 语法错误不在此拒收:错误恢复节点由 containsError/errorRanges 逐点过滤(与 cpp adapter 同策略)。 */
export async function parseLangRoot(lang: TsLang, source: string): Promise<LangNode | undefined> {
  const parser = await loadTsParser(lang);
  if (!parser) return undefined;
  try {
    const tree = parser.parse(source) as unknown as { rootNode?: LangNode };
    return tree.rootNode;
  } catch {
    return undefined;
  }
}

export function lineOf(node: LangNode): number {
  return node.startPosition.row + 1;
}

/** 声明首行(签名行)文本:source 切片到首个换行,压平空白,截 200。 */
export function firstLineText(source: string, node: LangNode): string {
  const nl = source.indexOf("\n", node.startIndex);
  const end = nl === -1 || nl > node.endIndex ? node.endIndex : nl;
  return source.slice(node.startIndex, end).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** 最近祖先(限定类型集);找不到=undefined。 */
export function nearestAncestorOf(node: LangNode, types: Set<string>): LangNode | undefined {
  let cur = node.parent;
  while (cur) {
    if (types.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

/** 节点同一性(包装对象引用不可比;id 缺省时退回引用)。 */
export function isSameNode(a: LangNode | null | undefined, b: LangNode | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.id !== undefined && b.id !== undefined && a.id === b.id;
}

/** 节点是否位于某个嵌套「具名函数」内部(调用归属判定:嵌套函数里的调用不算外层函数的行为)。 */
export function insideNestedFunction(node: LangNode, bodyNode: LangNode, fnTypes: Set<string>): boolean {
  let cur = node.parent;
  while (cur) {
    if (isSameNode(cur, bodyNode)) return false;
    if (fnTypes.has(cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

/** 标识符契约(符号名不猜:带 :: / <> / 空格的文本直接弃)。 */
export function isIdentifierText(text: string | undefined): text is string {
  return !!text && /^[A-Za-z_$][\w$]*$/.test(text);
}

/** 内建/非类型词(不作为 receiverType 证据)。 */
const NON_TYPE_NAMES = new Set([
  "int", "long", "short", "byte", "char", "bool", "boolean", "float", "double", "decimal",
  "string", "str", "void", "unit", "usize", "isize", "u8", "u16", "u32", "u64", "u128",
  "i8", "i16", "i32", "i64", "i128", "f32", "f64", "number", "object", "any", "mixed",
  "never", "null", "nil", "undefined", "true", "false", "self", "Self", "static", "this",
  "parent", "base", "super", "dynamic", "var", "implicit_type", "auto",
]);

export type LangStyle = "rust" | "csharp" | "php" | "ruby";

/**
 * 类型文本 → 基名(只服务 receiverType 证据;不可判=undefined)。
 * - 剥 Rust 引用/智能指针、C#/PHP 可空、修饰符、泛型实参、命名空间前缀;
 * - 数组(`Foo[]`/`[Foo]`)、联合类型(`A|B`)不判(调用目标可能是扩展方法/联合分支);
 * - 泛型容器(List<Task<Foo>> 等)剥实参后只剩容器名——容器方法才是真实调用目标。
 */
export function baseType(raw: string | undefined, style: LangStyle): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) return undefined;
  // 修饰符/参数修饰
  s = s.replace(/^(?:(?:readonly|const|mut|ref|out|in|this|params)\s+)+/i, "").trim();
  // Rust 引用/裸指针
  if (style === "rust") {
    s = s.replace(/^&\s*(?:mut\s+)?/, "").trim();
    s = s.replace(/^\*\s*(?:const|mut)\s+/, "").trim();
    s = s.replace(/^(?:dyn|impl)\s+/, "").trim();
    // 智能指针自动解引用(Box/Arc/Rc 等的方法调用落在内部类型上)
    for (let i = 0; i < 3; i++) {
      const m = /^(?:Box|Arc|Rc|Pin|Ref|RefMut)\s*<(.+)>$/.exec(s);
      if (!m) break;
      s = m[1]!.trim();
    }
  }
  // 可空(PHP `?B` / C# `B?`)
  s = s.replace(/^\?+/, "").trim();
  s = s.replace(/\?+$/, "").trim();
  if (!s) return undefined;
  if (s.includes("|")) return undefined; // 联合类型:不猜
  if (/\[\s*\]\s*$/.test(s) || s.startsWith("[")) return undefined; // 数组:不判
  // 泛型实参剥除(嵌套一次到位;剩余嵌套不判)
  s = s.replace(/<[^<>]*>/g, "").trim();
  if (s.includes("<") || s.includes(">")) return undefined;
  // 命名空间/嵌套类前缀:取末段(PHP 反斜杠命名空间 / 各语言 :: 与 .)
  const last = s.split(style === "php" ? /::|\.|\\/ : /::|\./).map((x) => x.trim()).filter(Boolean).pop() ?? "";
  if (!/^[A-Za-z_$][\w$]*$/.test(last)) return undefined;
  if (NON_TYPE_NAMES.has(last)) return undefined;
  return last;
}

/** 去掉参数列表外层括号(各语法 params 字段形态不一:PHP/C#/Rust 带,括号 Ruby 无)。 */
export function stripParamParens(text: string): string {
  let s = text.trim();
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  return s;
}

/** 参数列表切分(在 splitTopLevel 基础上认字符串字面量:C# `string s = "a,b"` /
 * Ruby `def f(x = "a,b")` / PHP `$s = 'a,b'` 的逗号不切)。 */
function splitParamsTopLevel(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let paren = 0, brack = 0, brace = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        if (i + 1 < s.length) cur += s[++i]!;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") brack++;
    else if (ch === "]") brack--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    if (ch === "," && paren === 0 && brack === 0 && brace === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** 参数列表 → Signature.params(确定性形态;复杂模式/匿名单跳过该参数,不猜)。 */
export function parseParams(paramsText: string | undefined, style: LangStyle): Signature["params"] {
  const out: Signature["params"] = [];
  if (!paramsText) return out;
  for (const raw of splitParamsTopLevel(stripParamParens(paramsText))) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (!s) continue;
    let name: string | undefined;
    let type: string | undefined;
    if (style === "rust") {
      if (/^&?\s*(?:mut\s+)?self$/.test(s)) {
        out.push({ name: "self" });
        continue;
      }
      let t = s.replace(/^mut\s+/, "");
      const idx = t.indexOf(":");
      if (idx > 0) {
        name = t.slice(0, idx).trim();
        type = t.slice(idx + 1).trim();
      } else {
        name = t;
      }
      name = name.replace(/^ref\s+/, "").replace(/^@/, "").trim();
      if (!/^[A-Za-z_]\w*$/.test(name)) continue; // 元组/模式形参不猜
    } else if (style === "csharp") {
      const noDefault = s.replace(/\s*=[\s\S]*$/, "").trim();
      const toks = noDefault.split(/\s+/).filter(Boolean);
      if (toks.length === 0) continue;
      if (toks.length === 1) {
        name = toks[0]!.replace(/^@/, "");
      } else {
        name = toks[toks.length - 1]!.replace(/^@/, "");
        type = toks.slice(0, -1).join(" ").replace(/^this\s+/, "");
      }
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    } else if (style === "php") {
      const noDefault = s.replace(/\s*=[\s\S]*$/, "").trim();
      const toks = noDefault.split(/\s+/).filter(Boolean);
      const last = toks[toks.length - 1] ?? "";
      const m = /^&?(?:\.\.\.)?\$([A-Za-z_]\w*)$/.exec(last);
      if (!m) continue;
      name = m[1]!;
      type = toks.slice(0, -1).join(" ");
    } else {
      // ruby:默认值先剥(元组/关键字参数不猜)
      let t = s.replace(/\s*=[\s\S]*$/, "").trim();
      t = t.replace(/^[*&]+/, "").replace(/:$/, "").trim();
      if (!/^[A-Za-z_]\w*[?!=]?$/.test(t)) continue;
      name = t;
    }
    if (!name) continue;
    out.push({ name, ...(type ? { type: type.slice(0, 120) } : {}) });
  }
  return out;
}

export function splitGenerics(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  let inner = text.trim();
  if (inner.startsWith("<")) inner = inner.slice(1);
  if (inner.endsWith(">")) inner = inner.slice(0, -1);
  const parts = splitTopLevel(inner).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** 签名合成(泛型/返回类型缺省=不猜)。 */
export function buildSignature(
  paramsText: string | undefined,
  style: LangStyle,
  opts?: { returnType?: string; generics?: string },
): Signature {
  const rt = opts?.returnType?.trim();
  const generics = splitGenerics(opts?.generics);
  return {
    params: parseParams(paramsText, style),
    ...(rt ? { returnType: rt.slice(0, 120) } : {}),
    ...(generics ? { generics } : {}),
  };
}

/** 子节点里第一个指定类型的节点(取字段缺位时的兜底,如 C# type_parameter_list)。 */
export function childOfType(node: LangNode, type: string): LangNode | undefined {
  return childrenOf(node).find((c) => c.type === type);
}
