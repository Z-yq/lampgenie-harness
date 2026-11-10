/**
 * C# structural adapter(legacy 待办「Rust/C#/Ruby/PHP 适配器」落地)。
 * 主路径:tree-sitter-c_sharp wasm(tree-sitter-wasms 自带;语言键 csharp → wasm 文件名
 * c_sharp 由 adapters/tree-sitter.ts 映射),tier=structural、source=tree-sitter;
 * wasm 不可用/解析异常 → 文本回退(source=text,只出符号零边,如实降级)。
 * 提取子集(诚实边界):
 * - 类型符号:class/struct/record/interface(interface 记 kind=interface)/enum(记 kind=enum);
 *   namespace 不登记(命名空间不是类型容器)。
 * - 类成员:字段/属性登记为 variable(带 dataType+container;进符号表不进 byName);
 *   方法/构造器登记 method(container=类名)。
 * - 调用边(同文件):`this.M()`/`M()`(同类无接收者调用)/`obj.M()`(字段/属性/参数/局部
 *   类型证据)/`Type.M()`(静态)/`new T()`(构造器或类节点)。链式 `this.a.b.M()` 逐段走
 *   字段/属性类型表。局部证据:`T x = new T()` / `var x = new T()` / `T x`.
 * - 跨文件候选(to=""+toName[+receiverType]):本地无目标的类型证据调用;static 形态
 *   `Other.Run()`(首字母大写且非局部变量)按 receiverType 发候选。无类型证据的小写接收者
 *   不猜(宁缺勿错)。
 * 未覆盖(登记):泛型约束/委托/LINQ 扩展方法/`?.` 条件访问、partial 类跨文件合并、
 *   局部函数(local function)独立符号、record 主构造器合成 ctor、显式接口实现名。
 * 文本回退边界(source=text):泛型方法签名/表达式体局部类型不解析,字段/属性符号不导出。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import { createBraceTracker } from "./braces";
import {
  baseType,
  buildSignature,
  childOfType,
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

export interface CsharpSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}

export interface CsharpParseResult {
  symbols: CsharpSymbol[];
  edges: FlowEdge[];
  failures: { file: string; reason: string }[];
  crossFileCandidates?: FlowEdge[];
  source: "tree-sitter" | "text";
  degraded?: string;
}

export const CSHARP_EXTS = [".cs"] as const;

const CS_TYPE_NODE_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "struct_declaration",
  "record_declaration",
  "record_struct_declaration",
  "enum_declaration",
]);
const CS_FN_NODE_TYPES = new Set(["method_declaration", "constructor_declaration", "local_function_statement"]);

interface CsharpBody {
  sym: CsharpSymbol;
  body: LangNode;
}

function mkId(relFile: string, name: string, container?: string): string {
  return `${relFile}#${container ? container + "." : ""}${name}`;
}

function typeDeclKind(node: LangNode): CsharpSymbol["kind"] {
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "enum_declaration") return "enum";
  return "class";
}

function typeDeclContainerOf(node: LangNode): string | undefined {
  const outer = nearestAncestorOf(node, CS_TYPE_NODE_TYPES);
  if (!outer) return undefined;
  const name = fieldOf(outer, "name")?.text?.trim();
  return isIdentifierText(name) ? name : undefined;
}

export async function parseCsharpFile(root: string, relFile: string): Promise<CsharpParseResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }], source: "text" };
  }
  const unit = await parseLangRoot("csharp", text);
  if (!unit || (unit.childCount === 0 && text.trim().length > 0)) {
    const fallback = parseCsharpText(relFile, text);
    if (fallback.symbols.length === 0) {
      fallback.failures.push({
        file: relFile,
        reason: unit ? "tree-sitter 解析结果为空(语法残缺),文本回退亦未发现声明" : "tree-sitter C# wasm 不可用,文本回退亦未发现声明",
      });
    }
    return { ...fallback, degraded: unit ? "tree-sitter 解析结果为空,已回退文本解析" : "tree-sitter C# wasm 不可用,已回退文本解析" };
  }
  if (!text.trim()) return { symbols: [], edges: [], failures: [], source: "tree-sitter" };

  const symbolsById = new Map<string, CsharpSymbol>();
  const add = (sym: CsharpSymbol): void => {
    if (!symbolsById.has(sym.id)) symbolsById.set(sym.id, sym);
  };
  const typeNames = new Set<string>();
  const fieldTypes = new Map<string, Map<string, string>>(); // 类名 → 字段/属性 → 类型文本
  const bodies: CsharpBody[] = [];

  // —— Pass 1a: 类型 + 字段/属性 ——
  for (const node of unit.descendantsOfType([...CS_TYPE_NODE_TYPES])) {
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
    if (!bodyNode || node.type === "enum_declaration" || node.type === "interface_declaration") continue;
    const fields = new Map<string, string>();
    for (const fd of bodyNode.descendantsOfType("field_declaration")) {
      // 嵌套类的字段归属最近类型声明(外层 body 的 descendants 也含内层字段——防双计)
      if (!isSameNode(nearestAncestorOf(fd, CS_TYPE_NODE_TYPES), node)) continue;
      if (!isWithin(fd, bodyNode) || containsError(fd)) continue;
      const vd = fd.descendantsOfType("variable_declaration")[0];
      const typeText = vd ? fieldOf(vd, "type")?.text?.trim() : undefined;
      if (!vd || !typeText) continue;
      for (const decl of vd.descendantsOfType("variable_declarator")) {
        const vname = decl.descendantsOfType("identifier")[0]?.text?.trim();
        if (!isIdentifierText(vname) || fields.has(vname)) continue;
        fields.set(vname, typeText);
        add({
          name: vname,
          id: mkId(relFile, vname, name),
          kind: "variable",
          file: relFile,
          line: lineOf(decl),
          container: name,
          dataType: typeText.slice(0, 120),
        });
      }
    }
    for (const prop of bodyNode.descendantsOfType("property_declaration")) {
      if (!isSameNode(nearestAncestorOf(prop, CS_TYPE_NODE_TYPES), node)) continue;
      if (!isWithin(prop, bodyNode) || containsError(prop)) continue;
      const pname = fieldOf(prop, "name")?.text?.trim();
      const ptype = fieldOf(prop, "type")?.text?.trim();
      if (!isIdentifierText(pname) || !ptype || fields.has(pname)) continue;
      fields.set(pname, ptype);
      add({
        name: pname,
        id: mkId(relFile, pname, name),
        kind: "variable",
        file: relFile,
        line: lineOf(prop),
        container: name,
        dataType: ptype.slice(0, 120),
      });
    }
    if (fields.size > 0) fieldTypes.set(name, fields);
  }

  // —— Pass 1b: 方法/构造器 ——
  for (const node of unit.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    const containerNode = nearestAncestorOf(node, CS_TYPE_NODE_TYPES);
    const container = containerNode ? fieldOf(containerNode, "name")?.text?.trim() : undefined;
    if (!isIdentifierText(container)) continue; // 无类型容器:局部函数/顶层语句不冒充方法
    const isCtor = node.type === "constructor_declaration";
    const sym: CsharpSymbol = {
      name,
      id: mkId(relFile, name, container),
      kind: "method",
      file: relFile,
      line: lineOf(node),
      container,
      signature: buildSignature(fieldOf(node, "parameters")?.text, "csharp", {
        ...(!isCtor && fieldOf(node, "type")?.text ? { returnType: fieldOf(node, "type")!.text.trim() } : {}),
        ...(childOfType(node, "type_parameter_list")?.text ? { generics: childOfType(node, "type_parameter_list")!.text } : {}),
      }),
    };
    add(sym);
    const body = fieldOf(node, "body");
    if (body) bodies.push({ sym, body });
  }

  // —— Pass 2: 调用边 ——
  const callables = [...symbolsById.values()].filter((s) => s.kind === "method");
  const callablesByName = new Map<string, CsharpSymbol[]>();
  for (const s of callables) callablesByName.set(s.name, [...(callablesByName.get(s.name) ?? []), s]);
  const methodsOf = (container: string, name: string): CsharpSymbol | undefined =>
    callables.find((s) => s.container === container && s.name === name);
  const classByName = (name: string): CsharpSymbol | undefined =>
    [...symbolsById.values()].find((s) => s.name === name && s.kind === "class");

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
      const t = baseType(p.type, "csharp");
      if (t) localTypes.set(p.name, t);
    }
    const containerFields = container ? fieldTypes.get(container) : undefined;
    const typeOfVar = (name: string): string | undefined => {
      const local = localTypes.get(name);
      if (local) return local;
      const ft = containerFields?.get(name);
      if (ft) return baseType(ft, "csharp");
      if (typeNames.has(name)) return name; // 静态类名形态 Util.Run
      return undefined;
    };
    const typeOfExpr = (node: LangNode): string | undefined => {
      switch (node.type) {
        case "this_expression":
          return container;
        case "identifier":
          return typeOfVar(node.text.trim());
        case "member_access_expression": {
          const expr = fieldOf(node, "expression");
          const member = fieldOf(node, "name")?.text?.trim();
          const et = expr ? typeOfExpr(expr) : undefined;
          if (!et || !member) return undefined;
          const ft = fieldTypes.get(et)?.get(member);
          return ft ? baseType(ft, "csharp") : undefined;
        }
        case "object_creation_expression":
          return baseType(fieldOf(node, "type")?.text, "csharp");
        case "parenthesized_expression": {
          const c = childrenOf(node)[0];
          return c ? typeOfExpr(c) : undefined;
        }
        case "cast_expression":
          return baseType(fieldOf(node, "type")?.text, "csharp");
        default:
          return undefined;
      }
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
      const ctor = methodsOf(typeName, typeName);
      if (ctor && ctor.id !== callerId) {
        pushEdge({ from: callerId, to: ctor.id, toName: typeName, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        return;
      }
      const cls = classByName(typeName);
      if (cls && cls.id !== callerId) {
        pushEdge({ from: callerId, to: cls.id, toName: typeName, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        return;
      }
      if (!cls) pushCandidate(callerId, typeName, line);
    };
    const emitBare = (name: string, line: number): void => {
      const sameContainer = (callablesByName.get(name) ?? []).filter((s) => s.container === container);
      if (sameContainer.length === 1) {
        if (sameContainer[0]!.id !== callerId) {
          pushEdge({ from: callerId, to: sameContainer[0]!.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        }
        return;
      }
      if (sameContainer.length > 1) return; // 重载组:不猜
      const all = callablesByName.get(name) ?? [];
      if (all.length === 1) {
        if (all[0]!.id !== callerId) {
          pushEdge({ from: callerId, to: all[0]!.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        }
        return;
      }
      if (all.length === 0) pushCandidate(callerId, name, line);
    };
    const handleFunction = (fn: LangNode, line: number): void => {
      if (fn.type === "identifier") {
        emitBare(fn.text.trim(), line);
        return;
      }
      if (fn.type === "generic_name") {
        const id = childrenOf(fn).find((c) => c.type === "identifier")?.text?.trim();
        if (isIdentifierText(id)) emitBare(id, line);
        return;
      }
      if (fn.type === "member_access_expression") {
        const name = fieldOf(fn, "name")?.text?.trim();
        const expr = fieldOf(fn, "expression");
        if (!isIdentifierText(name) || !expr) return;
        if (expr.type === "this_expression") {
          if (container) emitTyped(container, name, line);
          return;
        }
        if (expr.type === "base_expression") return; // 基类方法:跨文件解析不可判(不猜)
        const type = typeOfExpr(expr);
        if (type) {
          emitTyped(type, name, line);
          return;
        }
        // 静态类在别处:首字母大写标识符按类型形态发候选(Java fileClassNames 同族口径)
        if (expr.type === "identifier" && /^[A-Z]/.test(expr.text.trim())) {
          pushCandidate(callerId, name, line, baseType(expr.text.trim(), "csharp"));
        }
        return;
      }
      if (fn.type === "member_binding_expression") {
        const name = childrenOf(fn).find((c) => c.type === "identifier")?.text?.trim();
        if (isIdentifierText(name)) pushCandidate(callerId, name, line);
      }
    };

    // 局部类型证据(先于调用扫描;行序不影响正确性——类型声明在使用前的常态)
    for (const local of body.descendantsOfType("local_declaration_statement")) {
      if (insideNestedFunction(local, body, CS_FN_NODE_TYPES)) continue;
      if (inErrorRange(local, errRanges)) continue;
      for (const vd of local.descendantsOfType("variable_declaration")) {
        const typeText = fieldOf(vd, "type")?.text?.trim();
        if (!typeText) continue;
        const isImplicit = typeText === "var" || vd.descendantsOfType("implicit_type").length > 0;
        for (const decl of vd.descendantsOfType("variable_declarator")) {
          const vname = decl.descendantsOfType("identifier")[0]?.text?.trim();
          if (!isIdentifierText(vname) || localTypes.has(vname)) continue;
          const inferred = isImplicit
            ? (() => {
                const oc = decl.descendantsOfType("object_creation_expression")[0];
                return oc ? baseType(fieldOf(oc, "type")?.text, "csharp") : undefined;
              })()
            : baseType(typeText, "csharp");
          if (inferred) localTypes.set(vname, inferred);
        }
      }
    }
    for (const inv of body.descendantsOfType("invocation_expression")) {
      if (insideNestedFunction(inv, body, CS_FN_NODE_TYPES)) continue;
      if (inErrorRange(inv, errRanges)) continue;
      const fn = fieldOf(inv, "function");
      if (fn) handleFunction(fn, lineOf(inv));
    }
    for (const oc of body.descendantsOfType("object_creation_expression")) {
      if (insideNestedFunction(oc, body, CS_FN_NODE_TYPES)) continue;
      if (inErrorRange(oc, errRanges)) continue;
      const typeName = baseType(fieldOf(oc, "type")?.text, "csharp");
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

const CS_NON_DECL = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "using", "lock", "return", "new", "throw",
  "finally", "do", "else", "case", "default", "when", "typeof", "sizeof", "nameof", "is", "as",
]);

/** 文本回退:括号深度栈提取类型/方法/构造器/字段声明。零调用边(如实降级)。 */
export function parseCsharpText(relFile: string, text: string): CsharpParseResult {
  const symbols: CsharpSymbol[] = [];
  const seen = new Set<string>();
  const open: { name: string; kind: "type"; depth: number }[] = [];
  const push = (sym: CsharpSymbol): void => {
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
    const typeM = /^(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|new|file)\s+)*(class|interface|struct|record(?:\s+struct)?|enum)\s+([A-Za-z_]\w*)/.exec(t);
    if (typeM) {
      const kw = typeM[1]!;
      const name = typeM[2]!;
      const container = open[open.length - 1]?.name;
      const kind: CsharpSymbol["kind"] = kw === "interface" ? "interface" : kw === "enum" ? "enum" : "class";
      push({
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind,
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
      });
      if (depth > depthBefore) open.push({ name, kind: "type", depth });
      continue;
    }
    const container = open[open.length - 1]?.name;
    if (!container) continue;
    const methodM = /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly|const)\s+)*([A-Za-z_][\w.<>\[\]?,]*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:where\s+[^{]+)?(?:[{;=])/.exec(t);
    const ctorM = !methodM
      ? /^(?:(?:public|private|protected|internal|static)\s+)*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*(?:base|this)\s*\([^)]*\)\s*)?(?:[{;])/.exec(t)
      : null;
    if (methodM) {
      const returnType = methodM[1]!;
      const name = methodM[2]!;
      if (CS_NON_DECL.has(name) || CS_NON_DECL.has(returnType)) continue;
      push({
        name,
        id: `${relFile}#${container}.${name}`,
        kind: "method",
        file: relFile,
        line: i + 1,
        container,
        signature: buildSignature(`(${methodM[3] ?? ""})`, "csharp", { returnType }),
      });
      continue;
    }
    if (ctorM && ctorM[1] === container) {
      push({
        name: ctorM[1]!,
        id: `${relFile}#${container}.${ctorM[1]}`,
        kind: "method",
        file: relFile,
        line: i + 1,
        container,
        signature: buildSignature(`(${ctorM[2] ?? ""})`, "csharp"),
      });
    }
  }
  return { symbols, edges: [], failures: [], source: "text" };
}
