/**
 * tree-sitter 结构解析后端(二期:接口不变,零依赖纯文本解析器保底)。
 * web-tree-sitter wasm 懒加载:wasm 资产缺失/初始化失败/语法错误 → 返回 undefined,
 * 调用方回退纯文本栈式解析(行为与旧版逐字节一致)。tier 语义不变(structural);
 * source 字段如实标注 "tree-sitter" | "text"。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

/** 起 C/C++ 同机制装载(tree-sitter-c / tree-sitter-cpp,adapters/cpp.ts 消费)。
 * senseB21:javascript 同包 wasm(tree-sitter-wasms 0.1.13 自带)——内嵌脚本索引
 * (callgraph/inline-js.ts)解析 TS 模板字符串里的 <script> JS 源用。
 * typescript 同包 wasm(sensing/decision.ts 消费)——TS 的类型注解在
 * javascript 语法下必 ERROR,决策点感知必须走 typescript 语法。
 * rust/csharp/ruby/php(adapters/rust|cs|rb|php.ts 消费;csharp 的 wasm
 * 文件名是 tree-sitter-c_sharp.wasm,装载时映射,见 TS_WASM_NAME)。 */
export type TsLang = "python" | "go" | "java" | "c" | "cpp" | "javascript" | "typescript" | "rust" | "csharp" | "ruby" | "php";

/** 语言键 → tree-sitter-wasms 资产名(缺省同名;c_sharp 是上游命名)。 */
const TS_WASM_NAME: Partial<Record<TsLang, string>> = { csharp: "c_sharp" };

export interface TsNodeInfo {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
  text: string;
  /** 函数声明的参数块原文(kind=*_definition;供结构化签名解析)。 */
  paramsText?: string;
}

interface TsParser {
  parse(input: string): { rootNode: TsTsNode };
  delete(): void;
}
interface TsTsNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  childCount: number;
  child(i: number): TsTsNode | null;
  /** 0.24+:属性 getter;旧版:方法。childrenOf 统一。 */
  children: TsTsNode[] | (() => TsTsNode[]);
  descendantsOfType(type: string | string[]): TsTsNode[];
  /** 0.25 字段寻址(Rust/C#/Ruby/PHP 调用名在 function/method 字段,不在首子)。 */
  childForFieldName?(name: string): TsTsNode | null;
  text: string;
}

/** 递归查 ERROR 节点(hasError 不可用时的兜底)。 */
function descendantsContainError(node: TsTsNode): boolean {
  if (node.type === "ERROR" || node.type.startsWith("missing")) return true;
  return childrenOf(node).some(descendantsContainError);
}

/** 版本兼容:0.24+ children 为属性,旧版为方法。 */
function childrenOf(node: TsTsNode): TsTsNode[] {
  const c = node.children;
  return typeof c === "function" ? c.call(node) : (c ?? []);
}

/** 调用点的函数标识符文本(字段优先:python/go/java 的 function;ruby 的 method;
 * 字段缺省回退首子——0.25 经验证既有语言首子即 fn 表达式)。 */
function callTarget(node: TsTsNode): string | undefined {
  const byField = node.childForFieldName?.("function")
    ?? node.childForFieldName?.("method")
    ?? node.childForFieldName?.("name"); // PHP member/scoped call 的方法名在 name 字段
  if (byField) return byField.text?.trim();
  const first = childrenOf(node)[0];
  return first?.text?.trim();
}

let parserCache: Map<TsLang, TsParser> | undefined;
/** 负缓存:装载失败(典型=bundle 形态 wasm 缺失,Emscripten abort)是确定性失败,
 * 不缓存则逐文件重试=逐文件一次进程级 abort。 */
const failedLangs = new Set<TsLang>();

/** 懒加载语言 parser(进程级缓存;任何失败=undefined,不抛)。 */
export async function loadTsParser(lang: TsLang): Promise<TsParser | undefined> {
  if (failedLangs.has(lang)) return undefined;
  if (parserCache?.has(lang)) return parserCache.get(lang);
  try {
    // web-tree-sitter 是 CJS/ESM 双发布;仓内 ESM 下 createRequire 载 cjs 入口最稳。
 // 版本配对(经验证三连):web-tree-sitter 0.25.10 ↔ tree-sitter-wasms 0.1.13 ABI 兼容;
    // 0.27 报 dylink metadata 不识别、0.22.6 CJS 打包损坏(空导出)——登记防再踩。
    // 必须走 ESM 动态 import(条件 exports .import);require 包装触发 strict-mode 自检炸。
    const wts = (await import("web-tree-sitter")) as unknown as {
      Parser: { init(locate?: (f: string) => string): Promise<void>; new (): TsParser & { setLanguage(l: unknown): void } };
      Language: { load(input: string | Uint8Array): Promise<unknown> };
    };
    if (!parserCache) parserCache = new Map();
    const Parser = wts.Parser;
    if (!(Parser as unknown as { __inited?: boolean }).__inited) {
 // 无参 init:默认 locateFile 相对包内 web-tree-sitter.wasm(经验证唯一稳路径;
      // 注入 locateFile 的三种写法在 tsx/vitest 下各炸,已登记)。
      await Parser.init();
      (Parser as unknown as { __inited?: boolean }).__inited = true;
    }
    // 语法 wasm:pnpm 布局下只能 createRequire 解析(URL 相对层级不可靠)。
    // C19① 同族修复:裸 require 在 tsx-ESM 下 undefined(vitest 注入全局 require 掩盖)。
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wasmName = TS_WASM_NAME[lang] ?? lang;
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${wasmName}.wasm`);
    const { readFileSync } = await import("node:fs");
    const language = await wts.Language.load(new Uint8Array(readFileSync(wasmPath)));
    const parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(lang, parser);
    return parser;
  } catch {
    failedLangs.add(lang);
    return undefined;
  }
}

export interface TsParseOutput {
  /** def/class(或语言等价)顶层+嵌套声明:name/startLine(1-based)/endLine/签名首行文本。 */
  declarations: TsNodeInfo[];
  /** 调用点:name + 所在行(调用边原料;跨文件解析由上层做)。 */
  calls: { name: string; line: number }[];
}

const PY_DECL_KINDS = new Set(["function_definition", "class_definition"]);
const GO_DECL_KINDS = new Set(["function_declaration", "method_declaration", "type_declaration"]);
const JAVA_DECL_KINDS = new Set(["class_declaration", "interface_declaration", "enum_declaration", "method_declaration", "constructor_declaration"]);
const TS_DECL_KINDS = new Set(["function_declaration", "method_definition", "class_declaration"]);
const RUST_DECL_KINDS = new Set(["function_item", "function_signature_item", "struct_item", "enum_item", "union_item", "trait_item", "mod_item", "type_item"]);
const CSHARP_DECL_KINDS = new Set(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration", "record_struct_declaration", "enum_declaration", "method_declaration", "constructor_declaration"]);
const RUBY_DECL_KINDS = new Set(["method", "singleton_method", "class", "module"]);
const PHP_DECL_KINDS = new Set(["function_definition", "method_declaration", "class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]);

function declKinds(lang: TsLang): Set<string> {
  return lang === "python" ? PY_DECL_KINDS
    : lang === "go" ? GO_DECL_KINDS
    : lang === "typescript" ? TS_DECL_KINDS
    : lang === "rust" ? RUST_DECL_KINDS
    : lang === "csharp" ? CSHARP_DECL_KINDS
    : lang === "ruby" ? RUBY_DECL_KINDS
    : lang === "php" ? PHP_DECL_KINDS
    : JAVA_DECL_KINDS;
}

/** 取声明名(kind 专属子节点;缺名=跳过不猜)。 */
function declName(node: TsTsNode, lang: TsLang): string | undefined {
  const kids = childrenOf(node);
  const nameNode = lang === "python"
    ? kids.find((c) => c.type === "identifier")
    : kids.find((c) => c.type === "identifier" || c.type === "name" || c.type === "type_identifier" || c.type === "constant");
  const t = nameNode?.text?.trim();
  return t && /^[\w$]+$/.test(t) ? t : undefined;
}

/** 调用点节点类型(各语法命名不同;ruby 的 call 同时覆盖属性访问)。 */
function callKinds(lang: TsLang): string | string[] {
  if (lang === "python" || lang === "ruby") return "call";
  if (lang === "php") {
    return ["function_call_expression", "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"];
  }
  if (lang === "csharp") return "invocation_expression";
  return "call_expression";
}

/** 解析源码文本(语法错误→undefined=诚实降级,不吐半成品;tree-sitter 有错误恢复,必须显式拒收)。 */
export async function parseWithTreeSitter(lang: TsLang, source: string): Promise<TsParseOutput | undefined> {
  const parser = await loadTsParser(lang);
  if (!parser) return undefined;
  let tree: { rootNode: TsTsNode; hasError?: () => boolean };
  try {
    tree = parser.parse(source);
  } catch {
    return undefined;
  }
  const root = tree.rootNode;
  if (!root || root.childCount === 0) return undefined;
  // 错误恢复(isMissing/ERROR)=语法不完整:整文件进盲区(与纯文本解析器同契约,不混吐)。
  // 0.25 API:rootNode.hasError 为属性(tree.hasError 不存在)。
  const hasError = (root as unknown as { hasError?: boolean }).hasError === true
    || (typeof tree.hasError === "function" ? tree.hasError() : false)
    || descendantsContainError(root);
  if (hasError) return undefined;
  const kinds = declKinds(lang);
  const declarations: TsNodeInfo[] = [];
  for (const d of kinds) {
    for (const node of root.descendantsOfType(d)) {
      const name = declName(node, lang);
      if (!name) continue;
      const firstLine = source.slice(node.startIndex, source.indexOf("\n", node.startIndex) === -1 ? node.endIndex : source.indexOf("\n", node.startIndex));
      const paramsNode = childrenOf(node).find((c) => c.type === "parameters");
      declarations.push({
        kind: d, name,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        text: firstLine.trim().slice(0, 200),
        ...(paramsNode ? { paramsText: paramsNode.text } : {}),
      });
    }
  }
  // 调用点:call 节点的函数标识符。
  const calls: { name: string; line: number }[] = [];
  for (const node of root.descendantsOfType(callKinds(lang))) {
    const name = callTarget(node);
    if (name && /^[\w.]+$/.test(name)) calls.push({ name: name.split(".").at(-1) ?? name, line: node.startPosition.row + 1 });
  }
  return { declarations, calls };
}

/** 便捷:读文件+解析(文件读失败=undefined,与调用方回退语义一致)。 */
export async function parseFileWithTreeSitter(lang: TsLang, root: string, relFile: string): Promise<TsParseOutput | undefined> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch {
    return undefined;
  }
  return parseWithTreeSitter(lang, text);
}
