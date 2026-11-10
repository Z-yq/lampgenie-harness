/**
 * Rust structural adapter(legacy 待办「Rust/C#/Ruby/PHP 适配器」落地)。
 * 主路径:tree-sitter-rust wasm(tree-sitter-wasms 自带,零新增依赖),tier=structural、
 * source=tree-sitter;wasm 不可用/解析异常 → 文本回退(source=text,只出符号零边,如实降级)。
 * 提取子集(诚实边界):
 * - 类型符号:struct/enum/union(type alias 记 kind=type,trait 记 kind=interface,mod 记
 *   kind=class);impl 块的目标类型若无本地声明则补一个 class 符号(表示「此处扩展其方法」)。
 * - 可调用符号:function_item/function_signature_item(impl 内=method,container=类型名;
 *   trait 内=method,container=trait 名;mod 内=function,container=mod 名;顶层=function)。
 * - 签名:params/return_type/type_parameters(元组/模式形参不猜,跳过该参数)。
 * - 调用边(同文件):`self.m()`(container 归属)/`Type::m()`/`Self::m()`/`mod::f()`/裸名
 *   唯一函数。字段访问链 `self.a.b.m()` 逐段走 struct 字段表。局部类型证据:
 *   `let x: T` / `let x = T::new()` / `let x = T { .. }` / `Self::new()` / 参数类型。
 * - 跨文件候选(to=""+toName[+receiverType]):本地解析不到、但有类型/路径证据的调用;
 *   merge 层按同扩展名+唯一名(+receiverType)解析,解析不了=丢弃(宁缺勿错)。
 *   无类型证据的接收者调用**不发射**(Rust 静态类型,猜必假边)。
 * 未覆盖(登记):宏调用(println!/vec!)、trait 对象动态派发、泛型实参推导、
 *   `<T as Trait>::m()` 完全限定形式、闭包/async 块内部的接收者类型推导、宏生成的 impl。
 * 文本回退边界(source=text):单行 impl 块内函数、struct 字段表、调用边不可见(wasm 路径正常)。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import { createBraceTracker } from "./braces";
import {
  baseType,
  buildSignature,
  childrenOf,
  collectErrorRanges,
  containsError,
  fieldOf,
  inErrorRange,
  insideNestedFunction,
  isIdentifierText,
  isSameNode,
  lineOf,
  nearestAncestorOf,
  parseLangRoot,
  type LangNode,
} from "./lang-common";

export interface RustSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}

export interface RustParseResult {
  symbols: RustSymbol[];
  edges: FlowEdge[];
  failures: { file: string; reason: string }[];
  /** 本地解析不到、带类型/路径证据的调用(to="" + toName[+receiverType])。 */
  crossFileCandidates?: FlowEdge[];
  /** 解析后端:tree-sitter=wasm AST;text=wasm 不可用/解析异常后的文本回退。 */
  source: "tree-sitter" | "text";
  /** 降级原因(仅 source=text 且仍有符号时;供查询面如实呈报)。 */
  degraded?: string;
}

export const RUST_EXTS = [".rs"] as const;

const RUST_FN_NODE_TYPES = new Set(["function_item", "function_signature_item"]);
const MOD_TYPES = new Set(["mod_item"]);

interface RustBody {
  sym: RustSymbol;
  body: LangNode;
}

function mkId(relFile: string, name: string, container?: string): string {
  return `${relFile}#${container ? container + "." : ""}${name}`;
}

function modAncestorOf(node: LangNode): string | undefined {
  const mod = nearestAncestorOf(node, MOD_TYPES);
  if (!mod) return undefined;
  const name = fieldOf(mod, "name")?.text?.trim();
  return isIdentifierText(name) ? name : undefined;
}

/** impl 块的目标类型名(泛型实参剥除;`impl<T> Point<T>` / `impl Trait for Point<T>`)。 */
function implTargetName(node: LangNode): string | undefined {
  return baseType(fieldOf(node, "type")?.text, "rust");
}

/** 函数所属容器:impl/trait=方法容器;mod=模块容器;嵌套具名函数=无容器(局部符号)。 */
function ownerOf(node: LangNode): { kind: "impl" | "trait" | "mod"; name: string } | undefined {
  let cur = node.parent;
  while (cur) {
    if (RUST_FN_NODE_TYPES.has(cur.type) || cur.type === "closure_expression") return undefined;
    if (cur.type === "impl_item") {
      const name = implTargetName(cur);
      return name ? { kind: "impl", name } : undefined;
    }
    if (cur.type === "trait_item" || cur.type === "mod_item") {
      const name = fieldOf(cur, "name")?.text?.trim();
      if (isIdentifierText(name)) return { kind: cur.type === "trait_item" ? "trait" : "mod", name };
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

export async function parseRustFile(root: string, relFile: string): Promise<RustParseResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }], source: "text" };
  }
  const unit = await parseLangRoot("rust", text);
  if (!unit || (unit.childCount === 0 && text.trim().length > 0)) {
    const fallback = parseRustText(relFile, text);
    if (fallback.symbols.length === 0) {
      fallback.failures.push({
        file: relFile,
        reason: unit ? "tree-sitter 解析结果为空(语法残缺),文本回退亦未发现声明" : "tree-sitter rust wasm 不可用,文本回退亦未发现声明",
      });
    }
    return { ...fallback, degraded: unit ? "tree-sitter 解析结果为空,已回退文本解析" : "tree-sitter rust wasm 不可用,已回退文本解析" };
  }
  if (!text.trim()) return { symbols: [], edges: [], failures: [], source: "tree-sitter" };

  const symbolsById = new Map<string, RustSymbol>();
  const add = (sym: RustSymbol): void => {
    if (!symbolsById.has(sym.id)) symbolsById.set(sym.id, sym);
  };
  const modNames = new Set<string>();
  const structFields = new Map<string, Map<string, string>>();
  const bodies: RustBody[] = [];

  // —— Pass 1a: 类型/模块/trait 声明(嵌套 mod 容器如实登记) ——
  for (const node of unit.descendantsOfType(["struct_item", "enum_item", "union_item", "type_item"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const container = nearestAncestorOf(node, RUST_FN_NODE_TYPES) ? undefined : modAncestorOf(node);
    add({
      name,
      id: mkId(relFile, name, container),
      kind: node.type === "type_item" ? "type" : "class",
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
    });
  }
  for (const node of unit.descendantsOfType(["struct_item", "union_item"])) {
    if (containsError(node)) continue;
    const typeName = fieldOf(node, "name")?.text?.trim();
    const body = fieldOf(node, "body");
    if (!isIdentifierText(typeName) || !body) continue;
    const fields = new Map<string, string>();
    for (const fd of body.descendantsOfType("field_declaration")) {
      if (!isWithin(fd, body)) continue;
      if (containsError(fd)) continue;
      const fname = fieldOf(fd, "name")?.text?.trim();
      const ftype = fieldOf(fd, "type")?.text?.trim();
      if (!isIdentifierText(fname) || !ftype) continue;
      fields.set(fname, ftype);
      add({
        name: fname,
        id: mkId(relFile, fname, typeName),
        kind: "variable",
        file: relFile,
        line: lineOf(fd),
        container: typeName,
        dataType: ftype.slice(0, 120),
      });
    }
    if (fields.size > 0) structFields.set(typeName, fields);
  }
  for (const node of unit.descendantsOfType(["trait_item", "mod_item"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const container = nearestAncestorOf(node, RUST_FN_NODE_TYPES) ? undefined : modAncestorOf(node);
    add({
      name,
      id: mkId(relFile, name, container),
      kind: node.type === "trait_item" ? "interface" : "class",
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
    });
    if (node.type === "mod_item") modNames.add(name);
  }
  // impl 目标类型:本地无声明 → 补 class 符号(此处是该方法集在文件内的归属锚)
  for (const node of unit.descendantsOfType("impl_item")) {
    if (containsError(node)) continue;
    const base = implTargetName(node);
    if (!base) continue;
    const hasLocalDecl = [...symbolsById.values()].some((s) => s.name === base && (s.kind === "class" || s.kind === "interface" || s.kind === "type" || s.kind === "enum"));
    if (!hasLocalDecl) {
      add({ name: base, id: mkId(relFile, base), kind: "class", file: relFile, line: lineOf(node) });
    }
  }
  // 文件/模块级 const/static(有显式类型才入变量符号;函数内局部 const 不冒充文件级)
  for (const node of unit.descendantsOfType(["const_item", "static_item"])) {
    if (containsError(node)) continue;
    if (nearestAncestorOf(node, RUST_FN_NODE_TYPES)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    const typeText = fieldOf(node, "type")?.text?.trim();
    if (!isIdentifierText(name) || !typeText) continue;
    add({ name, id: mkId(relFile, name), kind: "variable", file: relFile, line: lineOf(node), dataType: typeText.slice(0, 120) });
  }

  // —— Pass 1b: 函数/方法声明 ——
  for (const node of unit.descendantsOfType(["function_item", "function_signature_item"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const owner = ownerOf(node);
    const container = owner?.name;
    const kind: RustSymbol["kind"] = owner && (owner.kind === "impl" || owner.kind === "trait") ? "method" : "function";
    const sym: RustSymbol = {
      name,
      id: mkId(relFile, name, container),
      kind,
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
      signature: buildSignature(fieldOf(node, "parameters")?.text, "rust", {
        ...(fieldOf(node, "return_type")?.text ? { returnType: fieldOf(node, "return_type")!.text.trim() } : {}),
        ...(fieldOf(node, "type_parameters")?.text ? { generics: fieldOf(node, "type_parameters")!.text } : {}),
      }),
    };
    add(sym);
    const body = fieldOf(node, "body");
    if (body && node.type === "function_item") bodies.push({ sym, body });
  }

  // —— Pass 2: 调用边 ——
  const callablesByName = new Map<string, RustSymbol[]>();
  for (const s of symbolsById.values()) {
    if (s.kind !== "function" && s.kind !== "method") continue;
    callablesByName.set(s.name, [...(callablesByName.get(s.name) ?? []), s]);
  }
  const methodsOf = (container: string, name: string): RustSymbol | undefined =>
    [...symbolsById.values()].find((s) => (s.kind === "method" || s.kind === "function") && s.container === container && s.name === name);

  const edges: FlowEdge[] = [];
  const crossFileCandidates: FlowEdge[] = [];
  const edgeSeen = new Set<string>();
  const candSeen = new Set<string>();
  const pushEdge = (e: FlowEdge): void => {
    const k = `${e.from}|${e.to}|${e.toName}|${e.line}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push(e);
  };
  const pushCandidate = (callerId: string, toName: string, line: number, receiverType?: string): void => {
    const k = `${callerId}|${toName}|${receiverType ?? ""}`;
    if (candSeen.has(k)) return;
    candSeen.add(k);
    crossFileCandidates.push({
      from: callerId,
      to: "",
      toName,
      file: relFile,
      line,
      tier: "structural",
      evidenceKind: "inferred",
      ...(receiverType ? { receiverType } : {}),
    });
  };

  for (const { sym: caller, body } of bodies) {
    const callerId = caller.id;
    const container = caller.container;
    const errRanges = body.hasError === true ? collectErrorRanges(body) : undefined;
    const localTypes = new Map<string, string>();
    for (const p of caller.signature?.params ?? []) {
      if (p.name === "self" && container) {
        localTypes.set("self", container);
        continue;
      }
      const t = baseType(p.type, "rust");
      if (t) localTypes.set(p.name, t);
    }
    const fieldTypes = container ? structFields.get(container) : undefined;
    const typeOfVar = (name: string): string | undefined => {
      if (name === "self") return container;
      const local = localTypes.get(name);
      if (local) return local;
      const ft = fieldTypes?.get(name);
      return ft ? baseType(ft, "rust") : undefined;
    };
    /** 表达式静态类型(只认确定性形态;返回未知=undefined,绝不猜)。 */
    const typeOfExpr = (node: LangNode): string | undefined => {
      switch (node.type) {
        case "self":
          return container;
        case "identifier":
          return typeOfVar(node.text.trim());
        case "reference_expression": {
          const v = fieldOf(node, "value") ?? childrenOf(node)[0];
          return v ? typeOfExpr(v) : undefined;
        }
        case "field_expression": {
          const value = fieldOf(node, "value");
          const fieldName = fieldOf(node, "field")?.text?.trim();
          const vt = value ? typeOfExpr(value) : undefined;
          if (!vt || !fieldName) return undefined;
          const ft = structFields.get(vt)?.get(fieldName);
          return ft ? baseType(ft, "rust") : undefined;
        }
        case "struct_expression":
          return baseType(fieldOf(node, "name")?.text, "rust");
        case "call_expression": {
          const fn = fieldOf(node, "function");
          return fn ? staticTypeOfCallee(fn) : undefined;
        }
        case "parenthesized_expression": {
          const c = childrenOf(node)[0];
          return c ? typeOfExpr(c) : undefined;
        }
        default:
          return undefined;
      }
    };
    /** 被调表达式能确定返回/构造类型时给出类型名(`T::new()`, `Foo {}`, 元组结构体构造)。 */
    const staticTypeOfCallee = (fn: LangNode): string | undefined => {
      if (fn.type === "identifier") {
        const name = fn.text.trim();
        return /^[A-Z]/.test(name) ? baseType(name, "rust") : undefined;
      }
      if (fn.type === "scoped_identifier") {
        const path = fieldOf(fn, "path");
        if (!path) return undefined;
        const text = path.text.trim();
        if (text === "Self") return container;
        return baseType(text, "rust");
      }
      if (fn.type === "generic_function") {
        const inner = fieldOf(fn, "function");
        return inner ? staticTypeOfCallee(inner) : undefined;
      }
      return undefined;
    };
    const emitTyped = (type: string, name: string, line: number): void => {
      const target = methodsOf(type, name);
      if (target && target.id !== callerId) {
        pushEdge({ from: callerId, to: target.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        return;
      }
      if (!target) pushCandidate(callerId, name, line, type);
    };
    const emitBare = (name: string, line: number): void => {
      // 裸名调用只可能是自由函数/同模块函数(Rust 方法必须带接收者或 Self:: 限定)
      const pool = (callablesByName.get(name) ?? []).filter((s) => !s.container || modNames.has(s.container));
      if (pool.length === 1) {
        if (pool[0]!.id !== callerId) {
          pushEdge({ from: callerId, to: pool[0]!.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        }
        return;
      }
      if (pool.length === 0) pushCandidate(callerId, name, line);
    };
    const handleCallee = (fn: LangNode, line: number): void => {
      if (fn.type === "identifier") {
        emitBare(fn.text.trim(), line);
        return;
      }
      if (fn.type === "field_expression") {
        const name = fieldOf(fn, "field")?.text?.trim();
        if (!isIdentifierText(name)) return;
        const value = fieldOf(fn, "value");
        if (value?.type === "self") {
          if (!container) return;
          emitTyped(container, name, line);
          return;
        }
        const type = value ? typeOfExpr(value) : undefined;
        if (type) emitTyped(type, name, line); // 无类型证据:不猜(静态语言,猜必假边)
        return;
      }
      if (fn.type === "scoped_identifier") {
        const name = fieldOf(fn, "name")?.text?.trim();
        if (!isIdentifierText(name)) return;
        const path = fieldOf(fn, "path");
        const pathText = path?.text?.trim() ?? "";
        const recv = pathText === "Self" ? container : (baseType(pathText, "rust") ?? lastPathSegment(pathText));
        if (recv) emitTyped(recv, name, line);
        else pushCandidate(callerId, name, line);
        return;
      }
      if (fn.type === "generic_function") {
        const inner = fieldOf(fn, "function");
        if (inner) handleCallee(inner, line);
      }
    };

    for (const letDecl of body.descendantsOfType("let_declaration")) {
      if (insideNestedFunction(letDecl, body, RUST_FN_NODE_TYPES)) continue;
      if (inErrorRange(letDecl, errRanges)) continue;
      const pattern = fieldOf(letDecl, "pattern")?.text?.trim();
      if (!isIdentifierText(pattern) || localTypes.has(pattern)) continue;
      const declared = baseType(fieldOf(letDecl, "type")?.text, "rust");
      const value = fieldOf(letDecl, "value");
      const inferred = declared ?? (value ? typeOfExpr(value) : undefined);
      if (inferred) localTypes.set(pattern, inferred);
    }
    for (const call of body.descendantsOfType("call_expression")) {
      if (insideNestedFunction(call, body, RUST_FN_NODE_TYPES)) continue;
      if (inErrorRange(call, errRanges)) continue;
      const fn = fieldOf(call, "function");
      if (!fn) continue;
      handleCallee(fn, lineOf(call));
    }
  }

  const syntaxFailures = symbolsById.size === 0 && containsError(unit)
    ? [{ file: relFile, reason: "语法错误(ERROR/missing 节点)导致无可提取声明" }]
    : [];
  return {
    symbols: [...symbolsById.values()],
    edges,
    failures: syntaxFailures,
    ...(crossFileCandidates.length > 0 ? { crossFileCandidates } : {}),
    source: "tree-sitter",
  };
}

function lastPathSegment(text: string): string | undefined {
  if (!text) return undefined;
  const segs = text.split(/::|\./).map((s) => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1];
  return isIdentifierText(last) ? last : undefined;
}

function isWithin(node: LangNode, ancestor: LangNode): boolean {
  let cur: LangNode | null = node;
  while (cur) {
    if (isSameNode(cur, ancestor)) return true;
    cur = cur.parent;
  }
  return false;
}

// ============================ 文本回退(wasm 不可用) ============================

/** 文本回退:括号深度栈提取类型/impl/trait/mod/fn/const 声明。零调用边(如实降级)。 */
export function parseRustText(relFile: string, text: string): RustParseResult {
  const symbols: RustSymbol[] = [];
  const seen = new Set<string>();
  const open: { name: string; kind: "impl" | "trait" | "mod"; depth: number }[] = [];
  const push = (sym: RustSymbol): void => {
    if (seen.has(sym.id)) return;
    seen.add(sym.id);
    symbols.push(sym);
  };
  const tracker = createBraceTracker();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const depthBefore = tracker.depth;
    const { code, depth } = tracker.feed(lines[i]!);
    while (open.length > 0 && depth < open[open.length - 1]!.depth) open.pop();
    const t = code.trim();
    if (!t) continue;
    const implM = /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?impl\b([\s\S]*)$/.exec(t);
    if (implM) {
      const base = implTargetFromText(implM[1] ?? "");
      if (base) {
        push({ name: base, id: `${relFile}#${base}`, kind: "class", file: relFile, line: i + 1 });
        if (depth > depthBefore) open.push({ name: base, kind: "impl", depth });
      }
      continue;
    }
    const typeM = /^(?:pub(?:\([^)]*\))?\s+)?(struct|enum|union|trait|mod|type)\s+([A-Za-z_]\w*)/.exec(t);
    if (typeM) {
      const kw = typeM[1]!;
      const name = typeM[2]!;
      const kind: RustSymbol["kind"] = kw === "trait" ? "interface" : kw === "type" ? "type" : "class";
      push({ name, id: `${relFile}#${name}`, kind, file: relFile, line: i + 1 });
      if (depth > depthBefore && (kw === "trait" || kw === "mod")) {
        open.push({ name, kind: kw === "trait" ? "trait" : "mod", depth });
      }
      continue;
    }
    const constM = /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_]\w*)\s*:\s*([^=;]+)/.exec(t);
    if (constM) {
      push({
        name: constM[1]!,
        id: `${relFile}#${constM[1]}`,
        kind: "variable",
        file: relFile,
        line: i + 1,
        dataType: constM[2]!.trim().slice(0, 120),
      });
      continue;
    }
    const fnM = /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern\s+(?:"[^"]*"\s+)?)\s+)*fn\s+([A-Za-z_]\w*)\s*(<[^>]*>)?\s*\(/.exec(t);
    if (fnM) {
      const name = fnM[1]!;
      const owner = open[open.length - 1];
      const container = owner?.name;
      const isMethod = owner !== undefined && (owner.kind === "impl" || owner.kind === "trait");
      const rest = t.slice((fnM.index ?? 0) + fnM[0].length - 1); // 从 "(" 起
      const close = matchingParen(rest);
      const paramsRaw = close >= 0 ? rest.slice(1, close) : undefined;
      const tail = close >= 0 ? rest.slice(close + 1) : "";
      const retM = /->\s*([^{;]+)/.exec(tail);
      push({
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind: isMethod ? "method" : "function",
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
        signature: buildSignature(paramsRaw, "rust", {
          ...(retM ? { returnType: retM[1]!.trim() } : {}),
          ...(fnM[2] ? { generics: fnM[2] } : {}),
        }),
      });
    }
  }
  return { symbols, edges: [], failures: [], source: "text" };
}

function matchingParen(s: string): number {
  if (!s.startsWith("(")) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function implTargetFromText(rest: string): string | undefined {
  let s = rest.trim();
  if (s.startsWith("<")) {
    let depth = 0;
    let i = 0;
    for (; i < s.length; i++) {
      if (s[i] === "<") depth++;
      else if (s[i] === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    s = s.slice(i).trim();
  }
  const forM = /\bfor\s+([\s\S]+)$/.exec(s);
  if (forM) s = forM[1]!.trim();
  s = s.replace(/^&\s*(?:mut\s+)?/, "").replace(/^dyn\s+/, "").trim();
  const m = /^([A-Za-z_]\w*)/.exec(s);
  return m?.[1];
}
