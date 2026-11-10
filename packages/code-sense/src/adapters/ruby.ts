/**
 * Ruby structural adapter(legacy 待办「Rust/C#/Ruby/PHP 适配器」落地)。
 * 主路径:tree-sitter-ruby wasm(tree-sitter-wasms 自带),tier=structural、source=tree-sitter;
 * wasm 不可用/解析异常 → 文本回退(source=text,只出符号零边,如实降级)。
 * 提取子集(诚实边界):
 * - 符号:class/module(module 也记 class 容器;Liquid 式模块方法与类共用容器语义)/method/
 *   singleton_method(`def self.x`/`def K.x`)。嵌套类/模块的类符号容器=最近外层类/模块,
 *   方法容器=最近类/模块(嵌套类的方法只用内层名,与 Java 嵌套类同口径)。
 * - 签名:位置/可选/splat/hash-splat/block 参数名(无类型标注;默认值与关键字参数名不猜)。
 * - 调用边(同文件):无接收者调用=隐式 self(容器内同名方法连边);`self.m`;常量接收者
 *   `Klass.m`(按容器收窄);实例变量/局部变量接收者按赋值证据(`x = Klass.new`)解析;
 *   `Klass.new(..).m` 链式构造识别。无类型证据的变量接收者不猜(动态语言,猜必假边)。
 * - 跨文件候选:常量接收者/有赋值类型证据的接收者/无目标的隐式 self 裸调用(带 receiverType
 *   的证据交 merge 层按同扩展名+唯一名(+容器)解析)。
 * 未覆盖(登记):动态 define_method/send/public_send、method_missing、mixin(include/extend)
 *   带来的方法归属、Struct/OpenStruct 动态字段、块/yield 内部的接收者类型、同名 instance 与
 *   singleton 方法的符号 id 冲突(先到者保留)。
 * 文本回退边界(source=text):end/缩进混杂的嵌套块可能归属偏差,零调用边。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import {
  buildSignature,
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

export interface RubySymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}

export interface RubyParseResult {
  symbols: RubySymbol[];
  edges: FlowEdge[];
  failures: { file: string; reason: string }[];
  crossFileCandidates?: FlowEdge[];
  source: "tree-sitter" | "text";
  degraded?: string;
}

export const RUBY_EXTS = [".rb"] as const;

const RB_CLASS_NODE_TYPES = new Set(["class", "module"]);
const RB_FN_NODE_TYPES = new Set(["method", "singleton_method"]);

/** Ruby 内建/DSL 裸调用:不发候选(否则每个 puts/require 都成噪声点)。 */
const RUBY_BUILTIN_CALLS = new Set([
  "puts", "print", "p", "pp", "warn", "require", "require_relative", "load", "autoload",
  "attr_reader", "attr_writer", "attr_accessor", "include", "extend", "prepend",
  "raise", "fail", "loop", "proc", "lambda", "sleep", "rand", "srand", "gets", "chomp",
  "to_s", "to_i", "to_f", "to_sym", "inspect", "nil?", "is_a?", "kind_of?", "respond_to?",
  "super", "yield", "block_given?", "catch", "throw", "sprintf", "format", "freeze",
  "new", "initialize", "call", "each", "map", "select", "reject", "reduce", "inject",
  "Array", "Hash", "String", "Integer", "Float", "Symbol", "JSON", "File", "Dir", "Time",
]);

interface RubyBody {
  sym: RubySymbol;
  body: LangNode;
}

function mkId(relFile: string, name: string, container?: string): string {
  return `${relFile}#${container ? container + "." : ""}${name}`;
}

function constantBase(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const segs = text.split("::").map((s) => s.trim()).filter(Boolean);
  const last = segs[segs.length - 1];
  return last && /^[A-Z]\w*$/.test(last) ? last : undefined;
}

function classContainerOf(node: LangNode): string | undefined {
  const outer = nearestAncestorOf(node, RB_CLASS_NODE_TYPES);
  if (!outer) return undefined;
  return constantBase(fieldOf(outer, "name")?.text);
}

export async function parseRubyFile(root: string, relFile: string): Promise<RubyParseResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }], source: "text" };
  }
  const unit = await parseLangRoot("ruby", text);
  if (!unit || (unit.childCount === 0 && text.trim().length > 0)) {
    const fallback = parseRubyText(relFile, text);
    if (fallback.symbols.length === 0) {
      fallback.failures.push({
        file: relFile,
        reason: unit ? "tree-sitter 解析结果为空(语法残缺),文本回退亦未发现声明" : "tree-sitter Ruby wasm 不可用,文本回退亦未发现声明",
      });
    }
    return { ...fallback, degraded: unit ? "tree-sitter 解析结果为空,已回退文本解析" : "tree-sitter Ruby wasm 不可用,已回退文本解析" };
  }
  if (!text.trim()) return { symbols: [], edges: [], failures: [], source: "tree-sitter" };

  const symbolsById = new Map<string, RubySymbol>();
  const add = (sym: RubySymbol): void => {
    if (!symbolsById.has(sym.id)) symbolsById.set(sym.id, sym);
  };
  const bodies: RubyBody[] = [];

  // —— Pass 1a: class/module ——
  for (const node of unit.descendantsOfType(["class", "module"])) {
    if (containsError(node)) continue;
    const name = constantBase(fieldOf(node, "name")?.text);
    if (!name) continue;
    const container = classContainerOf(node);
    add({
      name,
      id: mkId(relFile, name, container),
      kind: "class",
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
    });
  }
  // —— Pass 1b: method/singleton_method ——
  for (const node of unit.descendantsOfType(["method", "singleton_method"])) {
    if (containsError(node)) continue;
    const name = fieldOf(node, "name")?.text?.trim();
    if (!isIdentifierText(name)) continue;
    let container: string | undefined;
    if (node.type === "singleton_method") {
      const object = fieldOf(node, "object");
      container = object?.text?.trim() === "self" ? classContainerOf(node) : constantBase(object?.text);
    } else {
      container = classContainerOf(node);
    }
    const sym: RubySymbol = {
      name,
      id: mkId(relFile, name, container),
      kind: container ? "method" : "function",
      file: relFile,
      line: lineOf(node),
      ...(container ? { container } : {}),
      signature: buildSignature(fieldOf(node, "parameters")?.text, "ruby"),
    };
    add(sym);
    const body = fieldOf(node, "body");
    if (body) bodies.push({ sym, body });
  }

  // —— Pass 2: 调用边 ——
  const callables = [...symbolsById.values()].filter((s) => s.kind === "method" || s.kind === "function");
  const methodsOf = (container: string, name: string): RubySymbol | undefined =>
    callables.find((s) => s.container === container && s.name === name);
  const callablesByName = new Map<string, RubySymbol[]>();
  for (const s of callables) callablesByName.set(s.name, [...(callablesByName.get(s.name) ?? []), s]);

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
    const typeOfVar = (rawName: string): string | undefined => {
      const name = rawName.replace(/^@/, "");
      return localTypes.get(name) ?? localTypes.get(`@${name}`);
    };
    /** 赋值右值 `Klass.new` / `A::B.new` → 类型;其余不猜。 */
    const newTypeOf = (node: LangNode | undefined): string | undefined => {
      if (!node || node.type !== "call") return undefined;
      if (fieldOf(node, "method")?.text?.trim() !== "new") return undefined;
      return constantBase(fieldOf(node, "receiver")?.text);
    };
    const typeOfReceiver = (node: LangNode | undefined): string | undefined => {
      if (!node) return undefined;
      if (node.type === "constant" || node.type === "scope_resolution") return constantBase(node.text);
      if (node.type === "instance_variable" || node.type === "identifier") return typeOfVar(node.text.trim());
      if (node.type === "call") return newTypeOf(node); // Klass.new(...).m
      if (node.type === "parenthesized_statements") {
        const inner = node.descendantsOfType("call")[0];
        return newTypeOf(inner);
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
    const emitImplicitSelf = (name: string, line: number): void => {
      if (RUBY_BUILTIN_CALLS.has(name)) return;
      if (container) {
        const target = methodsOf(container, name);
        if (target) {
          if (target.id !== callerId) {
            pushEdge({ from: callerId, to: target.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
          }
          return;
        }
        // 隐性 self 无同类目标:可能是跨文件重开类/父类方法——按容器证据发候选(不猜其它类)
        pushCandidate(callerId, name, line, container);
        return;
      }
      // 顶层方法上下文:裸调用只可能是同文件顶层方法——唯一名连边,多候选/零候选不猜
      const pool = callablesByName.get(name) ?? [];
      if (pool.length === 1) {
        if (pool[0]!.id !== callerId) {
          pushEdge({ from: callerId, to: pool[0]!.id, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        }
        return;
      }
      if (pool.length === 0) pushCandidate(callerId, name, line);
    };
    const handleCall = (call: LangNode, line: number): void => {
      const name = fieldOf(call, "method")?.text?.trim();
      if (!isIdentifierText(name)) return; // 运算符/[]= 等:符号契约外
      const receiver = fieldOf(call, "receiver");
      if (!receiver) {
        emitImplicitSelf(name, line);
        return;
      }
      if (receiver.type === "self") {
        emitImplicitSelf(name, line);
        return;
      }
      const type = typeOfReceiver(receiver);
      if (type) emitTyped(type, name, line);
      // 无类型证据的变量/复杂表达式接收者:不猜(动态语言)
    };

    // 局部/实例变量类型证据(只认直接 `x = Klass.new`)
    const localNames = new Set<string>();
    for (const p of caller.signature?.params ?? []) localNames.add(p.name);
    for (const bp of body.descendantsOfType("block_parameters")) {
      for (const id of bp.descendantsOfType("identifier")) localNames.add(id.text.trim());
    }
    for (const assign of body.descendantsOfType(["assignment", "operator_assignment"])) {
      if (insideNestedFunction(assign, body, RB_FN_NODE_TYPES)) continue;
      if (inErrorRange(assign, errRanges)) continue;
      const left = fieldOf(assign, "left");
      const right = fieldOf(assign, "right");
      if (!left || !right) continue;
      if (left.type !== "identifier" && left.type !== "instance_variable") continue;
      if (left.type === "identifier") localNames.add(left.text.trim());
      const t = newTypeOf(right);
      if (!t) continue;
      const name = left.text.trim();
      const key = name.replace(/^@/, "");
      if (!localTypes.has(key)) localTypes.set(key, t);
      if (name.startsWith("@") && !localTypes.has(name)) localTypes.set(name, t);
    }
    for (const call of body.descendantsOfType("call")) {
      if (insideNestedFunction(call, body, RB_FN_NODE_TYPES)) continue;
      if (inErrorRange(call, errRanges)) continue;
      handleCall(call, lineOf(call));
    }
    // 零参数裸调用在 Ruby 语法里是 identifier(`helper` 不是 call 节点):无局部绑定的
    // 裸标识符按隐式 self 方法调用处理(参数/赋值左值/块参数/方法名位点已排除)。
    for (const idNode of body.descendantsOfType("identifier")) {
      if (insideNestedFunction(idNode, body, RB_FN_NODE_TYPES)) continue;
      if (inErrorRange(idNode, errRanges)) continue;
      const name = idNode.text.trim();
      if (!/^[A-Za-z_]\w*[?!=]?$/.test(name)) continue;
      const parent = idNode.parent;
      if (!parent) continue;
      if (parent.type === "call") continue; // 被调名/接收者由 call 分支处理
      if (parent.type.includes("parameter")) continue;
      if (parent.type === "assignment" || parent.type === "operator_assignment") {
        if (isSameNode(fieldOf(parent, "left"), idNode)) continue;
      }
      if (parent.type === "left_assignment_list" || parent.type === "right_assignment_list") continue;
      if (parent.type === "for") continue;
      if (parent.type === "method" || parent.type === "singleton_method") continue;
      if (parent.type === "class" || parent.type === "module") continue;
      if (parent.type === "scope_resolution" || parent.type === "constant") continue;
      if (parent.type === "alias") continue;
      if (localNames.has(name)) continue;
      emitImplicitSelf(name, lineOf(idNode));
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

// ============================ 文本回退(wasm 不可用) ============================

/** 文本回退:缩进栈提取 class/module/def 声明。零调用边(如实降级)。
 * Ruby 的 end 无法与 if/do 块区分,缩进栈采用「同类声明同缩进即出栈」的保守口径。 */
export function parseRubyText(relFile: string, text: string): RubyParseResult {
  const symbols: RubySymbol[] = [];
  const seen = new Set<string>();
  const stack: { kind: "class" | "module" | "def"; name: string; indent: number }[] = [];
  const push = (sym: RubySymbol): void => {
    if (seen.has(sym.id)) return;
    seen.add(sym.id);
    symbols.push(sym);
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const container = [...stack].reverse().find((s) => s.kind !== "def")?.name;
    const t = raw.trim();
    const clsM = /^(class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/.exec(t);
    if (clsM) {
      const name = clsM[2]!.split("::").pop()!;
      push({
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind: "class",
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
      });
      stack.push({ kind: clsM[1] === "module" ? "module" : "class", name, indent });
      continue;
    }
    const defM = /^def\s+(?:([A-Za-z_]\w*(?:::[A-Z]\w*)*|self)\.)?([A-Za-z_]\w*[?!=]?)/.exec(t);
    if (defM) {
      const owner = defM[1];
      const name = defM[2]!;
      const methodContainer = owner && owner !== "self" ? owner.split("::").pop() : container;
      const rest = t.slice(defM[0].length).trim();
      let paramsRaw: string | undefined;
      if (rest.startsWith("(")) {
        const close = matchingParen(rest);
        if (close >= 0) paramsRaw = rest.slice(1, close);
      } else if (rest && !rest.startsWith("#")) {
        paramsRaw = rest;
      }
      push({
        name,
        id: `${relFile}#${methodContainer ? methodContainer + "." : ""}${name}`,
        kind: methodContainer ? "method" : "function",
        file: relFile,
        line: i + 1,
        ...(methodContainer ? { container: methodContainer } : {}),
        signature: buildSignature(paramsRaw, "ruby"),
      });
      stack.push({ kind: "def", name, indent });
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
