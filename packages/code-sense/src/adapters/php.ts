/**
 * PHP structural adapter(legacy 待办「Rust/C#/Ruby/PHP 适配器」落地)。
 * 主路径:tree-sitter-php wasm(tree-sitter-wasms 自带),tier=structural、source=tree-sitter;
 * wasm 不可用/解析异常 → 文本回退(source=text,只出符号零边,如实降级)。
 * 提取子集(诚实边界):
 * - 类型符号:class/interface(interface 记 kind=interface)/enum(记 kind=enum)/trait
 *   (trait 记 class——可复用方法集,容器语义与类同);namespace 不登记。
 * - 成员:带类型的属性登记 variable(dataType+container);方法/函数区分 container;
 *   签名含 `?Type`/返回类型/默认值(默认值与联合类型原样保留,不猜归一)。
 * - 调用边(同文件):`$this->m()`/`self::m()`/`static::m()`/`$obj->m()`(参数/属性/局部
 *   `$x = new T()` 类型证据)/`T::m()`/裸函数调用唯一名。链式 `$this->a->b->m()` 逐段走
 *   属性类型表;`new T()` 连构造器(`__construct`)或类节点。
 * - 跨文件候选:本地无目标的类型证据调用;未知 `T::m()` 按 receiverType 发候选;
 *   未知裸函数按唯一名候选。无类型证据的 `$var->m()` 不猜(宁缺勿错)。
 * 未覆盖(登记):动态 `$obj->$name()`/`call_user_func`/`__call`、trait 使用点的
 *   `use TraitName` 方法归属、PHPDoc 类型(`@var`/`@param`)、联合/交集类型窄化、
 *   enum case 独立符号、匿名类。
 * 文本回退边界(source=text):属性符号不导出;嵌套函数/匿名类不区分,零调用边。
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

export interface PhpSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}

export interface PhpParseResult {
  symbols: PhpSymbol[];
  edges: FlowEdge[];
  failures: { file: string; reason: string }[];
  crossFileCandidates?: FlowEdge[];
  source: "tree-sitter" | "text";
  degraded?: string;
}

export const PHP_EXTS = [".php"] as const;

const PHP_TYPE_NODE_TYPES = new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]);
const PHP_FN_NODE_TYPES = new Set(["function_definition", "method_declaration"]);

/** PHP 内建函数:裸调用不发候选(否则每个 count/strlen 都成噪声点)。 */
const PHP_BUILTIN_FUNCTIONS = new Set([
  "isset", "empty", "unset", "count", "sizeof", "array_map", "array_filter", "array_merge",
  "array_values", "array_keys", "array_slice", "array_push", "array_pop", "array_shift",
  "array_unshift", "array_key_exists", "in_array", "is_array", "is_string", "is_int", "is_null",
  "is_object", "is_bool", "is_callable", "is_float", "is_numeric", "intval", "floatval", "strval",
  "boolval", "gettype", "strlen", "sprintf", "printf", "vsprintf", "json_encode", "json_decode",
  "var_dump", "print_r", "var_export", "str_replace", "str_contains", "str_starts_with",
  "str_ends_with", "substr", "explode", "implode", "trim", "ltrim", "rtrim", "strtolower",
  "strtoupper", "ucfirst", "lcfirst", "preg_match", "preg_match_all", "preg_replace", "preg_split",
  "file_get_contents", "file_put_contents", "fopen", "fclose", "fwrite", "fputs", "fgets", "feof",
  "unlink", "mkdir", "is_dir", "is_file", "file_exists", "dirname", "basename", "realpath",
  "microtime", "time", "date", "error_log", "trigger_error", "usort", "uasort", "uksort",
  "call_user_func", "call_user_func_array", "func_get_args", "get_class", "method_exists",
  "property_exists", "class_exists", "function_exists", "spl_autoload_register", "iterator_to_array",
]);

interface PhpBody {
  sym: PhpSymbol;
  body: LangNode;
}

function mkId(relFile: string, name: string, container?: string): string {
  return `${relFile}#${container ? container + "." : ""}${name}`;
}

function typeDeclKind(node: LangNode): PhpSymbol["kind"] {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  return "class";
}

function typeDeclContainerOf(node: LangNode): string | undefined {
  const outer = nearestAncestorOf(node, PHP_TYPE_NODE_TYPES);
  if (!outer) return undefined;
  const name = fieldOf(outer, "name")?.text?.trim();
  return isIdentifierText(name) ? name : undefined;
}

function typeNameNodeOf(node: LangNode): LangNode | undefined {
  return childrenOf(node).find((c) => c.type === "name" || c.type === "qualified_name");
}

export async function parsePhpFile(root: string, relFile: string): Promise<PhpParseResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }], source: "text" };
  }
  const unit = await parseLangRoot("php", text);
  if (!unit || (unit.childCount === 0 && text.trim().length > 0)) {
    const fallback = parsePhpText(relFile, text);
    if (fallback.symbols.length === 0) {
      fallback.failures.push({
        file: relFile,
        reason: unit ? "tree-sitter 解析结果为空(语法残缺),文本回退亦未发现声明" : "tree-sitter PHP wasm 不可用,文本回退亦未发现声明",
      });
    }
    return { ...fallback, degraded: unit ? "tree-sitter 解析结果为空,已回退文本解析" : "tree-sitter PHP wasm 不可用,已回退文本解析" };
  }
  if (!text.trim()) return { symbols: [], edges: [], failures: [], source: "tree-sitter" };

  const symbolsById = new Map<string, PhpSymbol>();
  const add = (sym: PhpSymbol): void => {
    if (!symbolsById.has(sym.id)) symbolsById.set(sym.id, sym);
  };
  const typeNames = new Set<string>();
  const propertyTypes = new Map<string, Map<string, string>>();
  const bodies: PhpBody[] = [];

  // —— Pass 1a: 类型 + 属性 ——
  for (const node of unit.descendantsOfType([...PHP_TYPE_NODE_TYPES])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const container = typeDeclContainerOf(node);
    add({
      name,
      id: mkId(relFile, name, container),
      kind: typeDeclKind(node),
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
    });
    typeNames.add(name);
    const bodyNode = fieldOf(node, "body");
    if (!bodyNode || node.type === "interface_declaration") continue;
    const props = new Map<string, string>();
    for (const prop of bodyNode.descendantsOfType("property_declaration")) {
      // 嵌套/匿名类型的属性归属最近类型声明(防外层类吸收内层属性)
      if (!isSameNode(nearestAncestorOf(prop, PHP_TYPE_NODE_TYPES), node)) continue;
      if (!isWithin(prop, bodyNode) || containsError(prop)) continue;
      const typeText = fieldOf(prop, "type")?.text?.trim();
      for (const pe of prop.descendantsOfType("property_element")) {
        if (!isWithin(pe, prop)) continue;
        const raw = pe.descendantsOfType("variable_name")[0]?.descendantsOfType("name")[0]?.text?.trim();
        const pname = raw?.replace(/^\$/, "");
        if (!isIdentifierText(pname) || props.has(pname)) continue;
        if (typeText) props.set(pname, typeText);
        add({
          name: pname,
          id: mkId(relFile, pname, name),
          kind: "variable",
          file: relFile,
          line: lineOf(pe),
          container: name,
          ...(typeText ? { dataType: typeText.slice(0, 120) } : {}),
        });
      }
    }
    if (props.size > 0) propertyTypes.set(name, props);
  }

  // —— Pass 1b: 函数/方法 ——
  for (const node of unit.descendantsOfType(["function_definition", "method_declaration"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const nestedInFn = nearestAncestorOf(node, PHP_FN_NODE_TYPES);
    const containerNode = nestedInFn ? undefined : nearestAncestorOf(node, PHP_TYPE_NODE_TYPES);
    const container = containerNode ? fieldOf(containerNode, "name")?.text?.trim() : undefined;
    const hasContainer = isIdentifierText(container);
    const sym: PhpSymbol = {
      name,
      id: mkId(relFile, name, hasContainer ? container : undefined),
      kind: hasContainer ? "method" : "function",
      file: relFile,
      line: lineOf(node),
      ...(hasContainer ? { container } : {}),
      signature: buildSignature(fieldOf(node, "parameters")?.text, "php", {
        ...(fieldOf(node, "return_type")?.text ? { returnType: fieldOf(node, "return_type")!.text.trim() } : {}),
      }),
    };
    add(sym);
    const body = fieldOf(node, "body");
    if (body) bodies.push({ sym, body });
  }

  // —— Pass 2: 调用边 ——
  const callables = [...symbolsById.values()].filter((s) => s.kind === "method" || s.kind === "function");
  const callablesByName = new Map<string, PhpSymbol[]>();
  for (const s of callables) callablesByName.set(s.name, [...(callablesByName.get(s.name) ?? []), s]);
  const methodsOf = (container: string, name: string): PhpSymbol | undefined =>
    callables.find((s) => s.container === container && s.name === name);
  const classByName = (name: string): PhpSymbol | undefined =>
    [...symbolsById.values()].find((s) => s.name === name && (s.kind === "class" || s.kind === "enum"));

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
      const t = baseType(p.type, "php");
      if (t) localTypes.set(p.name, t);
    }
    const containerProps = container ? propertyTypes.get(container) : undefined;
    const typeOfExpr = (node: LangNode | undefined): string | undefined => {
      if (!node) return undefined;
      if (node.type === "variable_name") {
        const raw = node.descendantsOfType("name")[0]?.text?.trim();
        const name = raw?.replace(/^\$/, "");
        if (!name) return undefined;
        if (name === "this") return container;
        return localTypes.get(name);
      }
      if (node.type === "member_access_expression") {
        const object = fieldOf(node, "object");
        const member = fieldOf(node, "name")?.text?.trim();
        const ot = typeOfExpr(object);
        if (!ot || !member) return undefined;
        const pt = propertyTypes.get(ot)?.get(member);
        return pt ? baseType(pt, "php") : undefined;
      }
      if (node.type === "object_creation_expression") {
        const t = typeNameNodeOf(node)?.text;
        return t?.trim() === "self" || t?.trim() === "static" ? container : baseType(t, "php");
      }
      if (node.type === "parenthesized_expression") {
        const c = childrenOf(node)[0];
        return c ? typeOfExpr(c) : undefined;
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
    const emitClassCreation = (typeName: string, line: number): void => {
      const ctor = methodsOf(typeName, "__construct");
      if (ctor && ctor.id !== callerId) {
        pushEdge({ from: callerId, to: ctor.id, toName: "__construct", file: relFile, line, tier: "structural", evidenceKind: "ast" });
        return;
      }
      const cls = classByName(typeName);
      if (cls && cls.id !== callerId) {
        pushEdge({ from: callerId, to: cls.id, toName: typeName, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        return;
      }
      if (!cls) pushCandidate(callerId, typeName, line);
    };
    const emitBareFunction = (name: string, line: number): void => {
      if (PHP_BUILTIN_FUNCTIONS.has(name)) return;
      const pool = (callablesByName.get(name) ?? []).filter((s) => s.kind === "function");
      if (pool.length === 1) {
        if (pool[0]!.id !== callerId) {
          pushEdge({ from: callerId, to: pool[0]!.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        }
        return;
      }
      if (pool.length === 0) pushCandidate(callerId, name, line);
    };

    // 局部类型证据:`$x = new T(...)` / `$x = new self(...)`
    for (const assign of body.descendantsOfType("assignment_expression")) {
      if (insideNestedFunction(assign, body, PHP_FN_NODE_TYPES)) continue;
      if (inErrorRange(assign, errRanges)) continue;
      const left = fieldOf(assign, "left");
      const right = fieldOf(assign, "right");
      if (left?.type !== "variable_name" || right?.type !== "object_creation_expression") continue;
      const lname = left.descendantsOfType("name")[0]?.text?.trim()?.replace(/^\$/, "");
      const t = typeOfExpr(right);
      if (lname && t && !localTypes.has(lname)) localTypes.set(lname, t);
    }
    for (const call of body.descendantsOfType([
      "function_call_expression",
      "member_call_expression",
      "nullsafe_member_call_expression",
      "scoped_call_expression",
    ])) {
      if (insideNestedFunction(call, body, PHP_FN_NODE_TYPES)) continue;
      if (inErrorRange(call, errRanges)) continue;
      const line = lineOf(call);
      if (call.type === "function_call_expression") {
        const fn = fieldOf(call, "function");
        if (!fn) continue;
        const raw = fn.text.trim();
        const last = raw.split(/\\/).map((s) => s.trim()).filter(Boolean).pop();
        if (last && isIdentifierText(last)) {
          if (fn.type === "name") emitBareFunction(last, line);
          else pushCandidate(callerId, last, line); // 命名空间限定函数:交唯一名闸
        }
        continue;
      }
      if (call.type === "scoped_call_expression") {
        const name = fieldOf(call, "name")?.text?.trim();
        if (!isIdentifierText(name)) continue;
        const scope = fieldOf(call, "scope");
        const scopeText = scope?.text?.trim() ?? "";
        if (scopeText === "self" || scopeText === "static") {
          if (container) emitTyped(container, name, line);
          continue;
        }
        if (scopeText === "parent") continue; // 父类方法:跨文件解析不可判(不猜)
        const type = baseType(scopeText, "php");
        if (type) emitTyped(type, name, line);
        continue;
      }
      // member_call_expression / nullsafe_member_call_expression
      const name = fieldOf(call, "name")?.text?.trim();
      if (!isIdentifierText(name)) continue;
      const object = fieldOf(call, "object");
      const type = typeOfExpr(object);
      if (type) emitTyped(type, name, line);
    }
    for (const oc of body.descendantsOfType("object_creation_expression")) {
      if (insideNestedFunction(oc, body, PHP_FN_NODE_TYPES)) continue;
      if (inErrorRange(oc, errRanges)) continue;
      const raw = typeNameNodeOf(oc)?.text?.trim();
      const typeName = raw === "self" || raw === "static" ? container : baseType(raw, "php");
      if (typeName) emitClassCreation(typeName, lineOf(oc));
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

function isWithin(node: LangNode, ancestor: LangNode): boolean {
  let cur: LangNode | null = node;
  while (cur) {
    if (isSameNode(cur, ancestor)) return true;
    cur = cur.parent;
  }
  return false;
}

// ============================ 文本回退(wasm 不可用) ============================

/** 文本回退:括号深度栈提取类型/函数/方法声明。零调用边(如实降级)。 */
export function parsePhpText(relFile: string, text: string): PhpParseResult {
  const symbols: PhpSymbol[] = [];
  const seen = new Set<string>();
  const open: { name: string; depth: number }[] = [];
  const push = (sym: PhpSymbol): void => {
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
    const typeM = /^(?:(?:final|abstract|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/.exec(t);
    if (typeM) {
      const kw = typeM[1]!;
      const name = typeM[2]!;
      const kind: PhpSymbol["kind"] = kw === "interface" ? "interface" : kw === "enum" ? "enum" : "class";
      push({ name, id: `${relFile}#${name}`, kind, file: relFile, line: i + 1 });
      if (depth > depthBefore && kw !== "enum") open.push({ name, depth });
      continue;
    }
    const fnM = /^(?:(?:public|private|protected|static|final|abstract|readonly)\s+)*function\s+&?\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/.exec(t);
    if (fnM) {
      const name = fnM[1]!;
      const container = open[open.length - 1]?.name;
      push({
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind: container ? "method" : "function",
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
        signature: buildSignature(`(${fnM[2] ?? ""})`, "php", {
          ...(fnM[3] ? { returnType: fnM[3].trim() } : {}),
        }),
      });
    }
  }
  return { symbols, edges: [], failures: [], source: "text" };
}
