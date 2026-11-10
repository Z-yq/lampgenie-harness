/**
 * C/C++ structural adapter(承 B1 缺口:两 C 仓索引「形式成功实为空」)。
 * grammar:tree-sitter-c(.c)/ tree-sitter-cpp(.cc/.cpp/.cxx/.hpp/.hh/.hxx;.h 双语法兜底取错误少者)。
 * wasm 资产:tree-sitter-wasms 0.1.13 自带 tree-sitter-c.wasm / tree-sitter-cpp.wasm(零新增依赖);
 * 装载复用 adapters/tree-sitter.ts 的 loadTsParser(与 py/go/java 同机制、同进程缓存)。
 * 提取诚实子集(边界如实,不硬凑):
 * - 函数定义 + 原型(declaration 内含 function_declarator 且无函数体)——原型如实登记为 API 面;
 *   同文件原型与定义并存时定义优先(符号 id 同形,原型让位);跨文件同名由查询侧并列呈现。
 * - 类型符号:具名且有 body 的 struct/union/enum/class specifier(kind=class;前向声明/匿名不收)。
 * - C++ 方法:类内定义(container=类名,经祖先 specifier 归属)与 Cls::method 域外定义
 *   (qualified_identifier 取末两段);ns::f 命名空间限定函数按限定名归 container(如实标注)。
 *   析构(~X)/运算符重载(operator+)名字不在标识符契约内,不收(登记边界,不猜)。
 * - 调用边:函数体内 call_expression/new_expression;裸名同文件唯一→连边(原型+定义并存→优先定义,
 *   无定义则唯一原型也可解析);Cls::m() 限定调用带 receiverType 发跨文件候选;其余未解析调用
 *   发 crossFileCandidates——跨文件解析消费 engine mergeStructAdapters 既有闸(同语言+全图唯一名
 *   (+receiverType/moduleHint)),本 adapter 不自建第二套跨文件解析。
 * 错误容忍(单一策略,无分支:subtree 无 ERROR/missing 的节点才提取):
 * - 文件干净 → 全部节点健康,行为=全量提取。
 * - 文件有 ERROR(真实 C 仓预处理器/GNU 扩展经验证高频,严格拒收会重演 0 覆盖)→ 自然降级为
 *   「健康节点」档:顶层/类内健康 function_definition/原型/类型照收,调用只从健康函数定义体内提取。
 * 经验证依据( PoC,~/sense-eval/saadk_c):错误文件 memwatch.c 顶层 63 个定义 62 个
 * 子树健康——容忍档近乎无损;而「整文件拒收」策略(经验证形态)是本轮要消灭的静默空索引。
 * (覆盖率 99%,口径与根因对照=):
 * - 属性宏 strip:ALLCAPS 标识符紧跟引入/类型关键字 → 等长空格替换(编译器 -D 等价,行号不变)。
 * 经验证根因:`CV_EXPORTS_W void inpaint(...)` 解析为 type_identifier(CV_EXPORTS_W)+ERROR(void)+健康
 *   declarator(photo.hpp 6 连),FMT_FUNC/EXPORT_VISIBILITY 同族。
 * - declarator 容错:ERROR 节点的 function_declarator 子树健康 → 照常提取符号但**不进 funcBodies
 * (不产调用边)**。经验证根因:`void cv::resize(...)`(opencv resize.cpp:3580)declarator 健康、
 * 函数体 compound_statement 含 ERROR → 整函数连坐丢弃( RC-E)。
 * - 模板类名:template<...> class DataType<...> 的类名节点是 template_type(非 type_identifier)。
 * - typedef:type_definition 提取declarator 名(普通 typedef 与 typedef struct{...} name)。
 * - lexical 档(承诺):结构档 0 符号(含 >512KB 闸命中文件)→ regex 顶层声明
 *   (函数原型/定义、extern|static|const 变量、数组、typedef),全部 tier=lexical、零边、
 *   不进 byName(engine merge 层)、不作 relink 目标、不进 entrypoints——**只进覆盖计数与符号查询,
 *   不参与 callers/callees 精度口径**。
 * - 分档 outcome(full/lexical/empty/skipped+reason):coverage=(full+lexical+empty)/磁盘源文件数;
 *   empty=解析干净但确认无声明(纯 include 聚合头/纯 #define/0 字节文件),如实计不编造符号。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import { splitTopLevel } from "./braces";
import { loadTsParser, type TsLang } from "./tree-sitter";

export interface CppSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}
export interface CppParseResult {
  symbols: CppSymbol[];
  edges: FlowEdge[];
  /** 解析失败的文件进盲区(wasm 不可用/读取失败;语法错误不进这里——见容忍策略)。 */
  failures: { file: string; reason: string }[];
  /** 本文件解析不到的调用候选(to="" + toName)——mergeStructAdapters 全图合并后按
   * 同语言+唯一名(+receiverType)解析,解析不了=移除(与「不发射」等价,不猜)。 */
  crossFileCandidates?: FlowEdge[];
 /** 分档 outcome(分层覆盖口径, §1):本文件落入 full/lexical/empty/skipped
   * 哪一档;mergeStructAdapters 聚合进 CallGraph.structOutcomes,最终落 coverage manifest。
   * 缺省(旧 adapter 无此字段)由 engine 按 symbols/failures 推断(python/go/java 同享)。 */
  outcome?: CppFileOutcome;
}
export type CppFileOutcome = { tier: "full" | "lexical" | "empty" | "skipped"; reason?: string;
 /** P0:本文件解析树含语法错误(即使分档=full)。索引落盘后 impact 据此提示
   *  「调用面可能不完整」,避免把缺边呈现成 0 调用方。 */
  errors?: boolean };

/** 本 adapter 登记的扩展名全集(engine GRAPH_STRUCT_EXT 注册点与此保持同一清单)。 */
export const CPP_EXTS = [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"];

/** web-tree-sitter 节点(本文件自有视图:带 parent,供类内方法祖先归属)。
 * P1 导出:typed/ 逐文件档复用同一节点视图。 */
export interface CppNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  childCount: number;
  child(i: number): CppNode | null;
  children: CppNode[] | (() => CppNode[]);
  parent: CppNode | null;
 /** 0.25 API:本节点或任意后代含错(单测验证:`return q +;` 的错误是属性形态,
   * 树里没有显式 ERROR 节点——健康判定必须两者都查)。 */
  hasError?: boolean;
  descendantsOfType(type: string): CppNode[];
}

export function childrenOf(n: CppNode): CppNode[] {
  const c = n.children;
  return typeof c === "function" ? c.call(n) : (c ?? []);
}

/** 节点子树内是否含错(hasError 属性档 + ERROR/missing 节点档;healthy 节点才提取)。
 * P1 导出:typed/ 逐文件档复用。 */
export function containsError(node: CppNode): boolean {
  if (node.hasError === true) return true;
  if (node.type === "ERROR" || node.type.startsWith("missing")) return true;
  return childrenOf(node).some(containsError);
}

/** P0:错误区间(只收 ERROR;missing 是零宽标记不算区间)。
 *  旧策略「函数体含一个 ERROR 就整段不产调用边」在真实 C 仓上代价过高:
 *  sa_algo_solution.c 的 1000+ 行 SA_ADK_Infer_Sync 仅签名处 3 字符 ERROR,却让整段调用面
 *  消失,impact 把 Solution_SA_MD_OT_Run 的真实调用方报成 0。现改为只剔除落在 ERROR 区间内的
 *  调用,区间外的健康调用照常成边(精度损失只限错误点本身)。 */
export interface CppErrorRange { start: number; end: number }
export function collectErrorRanges(node: CppNode, out: CppErrorRange[] = []): CppErrorRange[] {
  const stack: CppNode[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "ERROR") { out.push({ start: n.startIndex, end: n.endIndex }); continue; }
    if (n.type.startsWith("missing")) continue;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return out;
}
export function inErrorRange(node: CppNode, ranges: CppErrorRange[] | undefined): boolean {
  if (!ranges || ranges.length === 0) return false;
  for (const r of ranges) if (node.startIndex >= r.start && node.startIndex < r.end) return true;
  return false;
}

/** P0(性能回归修复):超过此字节数的源文件跳过解析,进 failures 如实登记。
 * 阈值依据:agent_alpha 经验证 cat-565.h 919KB / trust_blob.h 837KB 是 ESP32 嵌入式资源的
 * 裸像素/JIT blob 数组(19200 行十六进制字面量、零声明),tree-sitter 逐字节解析成 initializer
 * 节点,单文件 >120s; mbedtls ssl.h 265KB/ssl_tls.c 319KB 是真实可解析代码(114-519ms),
 * 取 512KB 为界——只拦 blob 形态(>500KB),真实代码全部放行。 */
export const CPP_MAX_FILE_BYTES = 512 * 1024;

/** G4( §3):属性宏 strip——ALLCAPS 标识符紧跟引入/类型关键字 → 等长空格。
 * 语义=编译器 -D(如 opencv `#define CV_EXPORTS` / windows `#define CONST const`),行号与字节
 * 偏移不变。假阳性面:全大写常量后跟引入关键字的合法 C/C++ 形态基本不存在(`MAX_SIZE =`、
 * `MODE_A,`、`INT_MAX)`、`arr[MAX]` 均不命中规则);首字符大写其余含小写的类型名(如 `MyType`)
 * 不命中;单字符模板参数 `T` 不命中(总长 ≥2)。 */
const MACRO_STRIP_KEYWORDS = new Set([
  "class", "struct", "union", "enum", "template", "typename", "inline", "static", "extern",
  "explicit", "virtual", "const", "constexpr", "mutable", "void", "char", "short", "int",
  "long", "float", "double", "signed", "unsigned", "bool", "auto", "size_t", "ssize_t",
  "wchar_t", "char16_t", "char32_t", "__inline", "__forceinline", "__cdecl", "__stdcall",
]);
const MACRO_STRIP_RE = /\b([A-Z][A-Z0-9_]{1,})(\s+)([A-Za-z_]\w*)\b/g;
/** 规则 2:类型关键字与类名之间的属性宏(`class CV_EXPORTS_API Tonemap : ...`,opencv 经验证形态)。
 * 上下文受限(仅在 class/struct 之后)——泛化的「ALLCAPS+任意标识符」会误杀 ALLCAPS typedef
 * 类型名(`MY_TYPE table[]` 是合法 C),不采纳。 */
const MACRO_STRIP_CLASS_RE = /\b(class|struct)(\s+)([A-Z][A-Z0-9_]{1,})(\s+)(?=[A-Za-z_]\w*)/g;

export function stripAttributeMacros(text: string): string {
 // 预处理器行(#define/#ifndef 头)不 strip——经验证反例:`#define OPENCV_PHOTO_LEGACY_CONSTANTS_H`
 // 的宏名后跟空行+`enum` 会命中规则 1,宏名被抹成 `#define <spaces>` → 整文件 ERROR(经验证)
  const pass1 = text.replace(MACRO_STRIP_RE, (whole, macro: string, ws: string, next: string, offset: number) => {
    if (!MACRO_STRIP_KEYWORDS.has(next)) return whole;
    if (onPreprocLine(text, offset)) return whole;
    return " ".repeat(macro.length) + ws + next;
  });
  return pass1.replace(MACRO_STRIP_CLASS_RE, (whole, kw: string, ws1: string, macro: string, ws2: string, offset: number) =>
    onPreprocLine(text, offset) ? whole : `${kw}${ws1}${" ".repeat(macro.length)}${ws2}`);
}

/** match 起点所在行的行首到 match 之间是否为预处理器行(行首首个非空白是 #)。 */
function onPreprocLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  for (let i = lineStart; i < offset; i++) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") continue;
    return ch === "#";
  }
  return false;
}

/** lexical 档( §5):regex 顶层声明提取。先单遍剥离注释/字符串字面量
 * (等长空格替换保行号),再按列 0 顶层形态匹配。只进覆盖计数与符号查询(tier=lexical),
 * 零边——不参与 callers/callees 精度口径。 */
export const LEXICAL_MAX_SYMBOLS = 2000;

/** 单遍状态机:注释/字符串内容替换为空格(保留换行),其余原样。块拼接实现(逐字符数组在
 * 1MB 上经验证 221ms,超 lexical <100ms 红线;切片拼接 O(片段数) 经验证 ~5ms)。 */
function blankCommentsAndStrings(text: string): string {
  const parts: string[] = [];
  const n = text.length;
  let i = 0;
  let runStart = 0;
  const blankSpan = (from: number, to: number): string => {
    let s = "";
    for (let k = from; k < to; k++) s += text[k] === "\n" ? "\n" : " ";
    return s;
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      if (i > runStart) parts.push(text.slice(runStart, i));
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      parts.push(blankSpan(i, j));
      i = j; runStart = j;
    } else if (c === "/" && text[i + 1] === "*") {
      if (i > runStart) parts.push(text.slice(runStart, i));
      let j = text.indexOf("*/", i + 2);
      if (j < 0) { parts.push(blankSpan(i, n)); i = n; runStart = n; break; }
      parts.push(blankSpan(i, j + 2));
      i = j + 2; runStart = i;
    } else if (c === "\"" || c === "'") {
      if (i > runStart) parts.push(text.slice(runStart, i));
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) { j++; break; }
        if (text[j] === "\n") break; // 未终止的字符串:止于行尾(保守,不让串吞全文件)
        j++;
      }
      // 引号本体保留,内容置空格(串内换行保留)
      const closed = j - 1 > i && text[j - 1] === c;
      const contentEnd = closed ? j - 1 : Math.min(j, n);
      parts.push(blankSpan(i + 1, contentEnd));
      if (closed) parts.push(c);
      i = Math.min(j, n); runStart = i;
    } else {
      i++;
    }
  }
  if (runStart < n) parts.push(text.slice(runStart));
  return parts.join("");
}

/** 行首偏移表(二查找行号,避免每命中一次全量 count)。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOf(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** 顶层声明 regex 组(在 blankCommentsAndStrings 产物上跑;^ 锚=列 0 顶层)。
 * 经验证形态:opencl 原型尾带调用约定宏(`... clXxx(...) CL_API_SUFFIX__VERSION_1_0;`)、
 * extern 函数指针(`extern CL_RUNTIME_EXPORT cl_int (CL_API_CALL*clBuildProgram)(...)`)、
 * ObjC 接口(`CV_EXPORTS @interface CvAbstractCamera : NSObject`,cap_ios.h 经验证)。 */
const LEX_FUNC_RE = /^[ \t]*[\w][^\n;{}=#]*?\b([A-Za-z_]\w*)[ \t]*\(([^;{()]*?)\)[ \t]*(?:const[ \t]*|noexcept[ \t]*)*(?:[^;\n{]*?)?(?:;|\{|$)/gm;
/** P1:变量/数组/函数指针 regex 增类型捕获——group1=声明前缀(类型文本),group2=名字。 */
const LEX_VAR_RE = /^((?:export[ \t]+)?(?:extern|static|const)[ \t]+[^\n;={}]*?)\b([A-Za-z_]\w*)[ \t]*(\[[^\]\n]*\][ \t]*)*(?:=[^\n;]*)?;/gm;
const LEX_ARRAY_RE = /^((?:static[ \t]+|const[ \t]+|extern[ \t]+|unsigned[ \t]+|signed[ \t]+)*[\w:]+[ \t*]+)([A-Za-z_]\w*)[ \t]*(\[[^\]\n]*\])[ \t]*(?:=[^\n;]*)?;/gm;
const LEX_TYPEDEF_RE = /^typedef\b[^\n;{}()]*?\b([A-Za-z_]\w*)[ \t]*;/gm;
/** extern 函数指针声明(名字在 `(*name)` 内)。 */
const LEX_FNPTR_RE = /^((?:extern|static|const)[ \t]+[^\n;={}]*?)\([ \t]*[A-Za-z_ \t]*\*[ \t]*([A-Za-z_]\w*)[ \t]*\)(\([^;{)]*\))[ \t]*[^;\n{]*?;/gm;
/** ObjC 接口(cap_ios.h 形态;@interface Name 是真实的顶层类型声明)。 */
const LEX_OBJC_RE = /^[ \t]*(?:[A-Z][A-Z0-9_]*[ \t]+)?@interface[ \t]+([A-Za-z_]\w*)/gm;

/** 词法档不作为符号名的关键字(防控制流语句被当函数:`if (x)` 形态)。 */
const LEX_NAME_DENY = new Set([
  "if", "for", "while", "switch", "return", "sizeof", "else", "do", "case", "default", "goto",
  "new", "delete", "throw", "catch", "using", "namespace", "public", "private", "protected",
  "struct", "class", "enum", "union", "typedef", "extern", "static", "const", "unsigned",
  "signed", "void", "int", "char", "long", "short", "float", "double", "bool", "template",
  "typename", "operator", "inline", "virtual", "explicit", "friend", "mutable", "typedef",
]);

/** 词法兜底提取:返回带 tier=lexical 的符号(kind=function/typedef/variable),零边。
 * P1:变量/数组/函数指针符号带 dataType(声明类型文本;存储类 extern/static 剥除)。 */
export function lexicalScan(relFile: string, text: string): CppSymbol[] {
  const blanked = blankCommentsAndStrings(text);
  const starts = lineStarts(blanked);
  const out: CppSymbol[] = [];
  const seen = new Set<string>();
  const cleanType = (s: string): string =>
    s.replace(/^(?:extern|static)\s+/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const push = (name: string, offset: number, kind: "function" | "typedef" | "variable" | "class", dataType?: string): void => {
    if (!/^[A-Za-z_]\w*$/.test(name) || LEX_NAME_DENY.has(name) || seen.has(name) || out.length >= LEXICAL_MAX_SYMBOLS) return;
    seen.add(name);
    out.push({ name, id: `${relFile}#${name}`, kind, file: relFile, line: lineOf(starts, offset), tier: "lexical", ...(dataType ? { dataType } : {}) });
  };
  for (const m of blanked.matchAll(LEX_FUNC_RE)) push(m[1]!, m.index ?? 0, "function");
  for (const m of blanked.matchAll(LEX_TYPEDEF_RE)) push(m[1]!, m.index ?? 0, "typedef");
  for (const m of blanked.matchAll(LEX_VAR_RE)) {
    const arrays = (m[3] ?? "").replace(/\s+/g, "");
    push(m[2]!, m.index ?? 0, "variable", cleanType(m[1]!) + arrays);
  }
  for (const m of blanked.matchAll(LEX_ARRAY_RE)) {
    push(m[2]!, m.index ?? 0, "variable", cleanType(m[1]!) + m[3]!.replace(/\s+/g, ""));
  }
  for (const m of blanked.matchAll(LEX_FNPTR_RE)) {
    push(m[2]!, m.index ?? 0, "variable", `${cleanType(m[1]!)}(*)${m[3]!.replace(/\s+/g, " ").trim()}`);
  }
  for (const m of blanked.matchAll(LEX_OBJC_RE)) push(m[1]!, m.index ?? 0, "class");
  // 多行初始化的顶层数组:`TYPE name[..] = {` 头(列 0),向前找首个 `};` 行终结(如 cat-565/icon
  // 形态的嵌入式资源表);跳过初始化体,防体内列 0 内容误匹配。行式扫描 O(行数)。
  const lines = blanked.split("\n");
  for (let li = 0; li < lines.length && out.length < LEXICAL_MAX_SYMBOLS; li++) {
    const m = /^((?:static[ \t]+|const[ \t]+|extern[ \t]+|unsigned[ \t]+|signed[ \t]+)*[\w:]+[ \t*]+)([A-Za-z_]\w*)[ \t]*(\[[^\]]*\])[ \t]*=[ \t]*\{[ \t]*$/.exec(lines[li]!);
    if (!m) continue;
    let end = li + 1;
    while (end < lines.length && !lines[end]!.startsWith("};")) end++;
    push(m[2]!, starts[li] ?? 0, "variable", cleanType(m[1]!) + m[3]!.replace(/\s+/g, ""));
    li = Math.max(end, li + 1);
  }
  return out;
}

/**
 * 从 function_definition/declaration 取最外层 function_declarator:
 * 直接子级,或经 pointer/reference/parenthesized 包装一层(如 `int *foo(...)` 经验证形态)。
 * 探测深度 ≤2:参数列表里的函数指针形参 function_declarator 在 ≥4 层,天然不会误中。
 */
function findFunctionDeclarator(node: CppNode): CppNode | undefined {
  const WRAPPERS = new Set(["pointer_declarator", "reference_declarator", "parenthesized_declarator"]);
  for (const c of childrenOf(node)) {
    if (c.type === "function_declarator") return c;
  }
  for (const c of childrenOf(node)) {
    if (!WRAPPERS.has(c.type)) continue;
    for (const g of childrenOf(c)) {
      if (g.type === "function_declarator") return g;
    }
  }
  return undefined;
}

/** function_declarator 的声明子(declarator 子节点)→ {name, container}。 */
function declaratorName(fd: CppNode): { name?: string; container?: string } {
  const decl = childrenOf(fd).find((c) => c.type !== "parameter_list" && c.type !== "attribute_specifier");
  if (!decl) return {};
  if (NAME_TYPES.has(decl.type)) {
    const t = decl.text.trim();
    return /^[A-Za-z_]\w*$/.test(t) ? { name: t } : {};
  }
  if (decl.type === "qualified_identifier") {
    // Cls::method / ns::Cls::method:取末两段(容器=倒数第二段,方法名=末段)
    const parts = decl.text.split("::").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
    if (parts.length >= 2) return { container: parts[parts.length - 2], name: parts[parts.length - 1] };
    if (parts.length === 1) return { name: parts[0] };
    return {};
  }
  // destructor_name(~X)/operator_name(operator+)/函数指针等:标识符契约外,不收
  return {};
}

const NAME_TYPES = new Set(["identifier", "field_identifier"]);

/** 函数/方法所在的类容器:祖先链上最近的具名 class/struct specifier(类内方法归属)。 */
function ancestorClassOf(node: CppNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "class_specifier" || cur.type === "struct_specifier") {
      const name = childrenOf(cur).find((c) => c.type === "type_identifier");
      if (name && /^[A-Za-z_]\w*$/.test(name.text.trim())) return name.text.trim();
      return undefined; // 匿名类/结构体内的函数:无容器归属,不猜
    }
    cur = cur.parent;
  }
  return undefined;
}

/** 具名且有 body 的类型 specifier → 类型符号名(前向声明/匿名不收)。
 * G2:`template<...> class DataType<...>` 的类名节点是 template_type(模板实参列表
 * 附着在名字节点上),取 `<` 前标识符;普通类仍是 type_identifier。 */
function typeNameOf(node: CppNode): string | undefined {
  const kids = childrenOf(node);
  const nameNode = kids.find((c) => c.type === "type_identifier" || c.type === "template_type");
  let name = nameNode?.text.trim() ?? "";
  if (nameNode?.type === "template_type") name = name.split("<")[0]!.trim();
  if (!name || !/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const hasBody = kids.some((c) => c.type === "field_declaration_list" || c.type === "enumerator_list");
  return hasBody ? name : undefined;
}

/** G3:type_definition 的 declarator 名——`typedef unsigned char U8;` 与
 * `typedef struct {...} sa_algo_audio_event;` 的名字都在末位 type_identifier。
 * 函数指针形态(`typedef void (*cb)(int)`)名字在括号内,标识符契约外不猜(登记边界)。 */
export function typedefName(node: CppNode): string | undefined {
  const ids = childrenOf(node).filter((c) => c.type === "type_identifier" || c.type === "identifier");
  const name = ids[ids.length - 1]?.text.trim();
  return name && /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/** P1( §2.2):typedef 的底层类型文本(名字与 typedef 关键字之间)。
 * 带 body 的 struct/union/enum 体折叠为 `{…}`(防大结构体文本进索引);截 120。 */
export function typedefUnderlying(node: CppNode): string | undefined {
  const raw = node.text.trim();
  const m = /^typedef\b([\s\S]*)\b[A-Za-z_]\w*\s*;?\s*$/.exec(raw);
  if (!m) return undefined;
  let t = m[1]!.replace(/\{[\s\S]*\}/, "{…}").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.slice(0, 120);
}

// ---- P1:结构档文件级变量提取(翻译单元顶层;零边、不进 byName——engine merge 层纪律) ----

/** 文件级变量单文件上限(防病态文件节点爆炸;截断=如实少收,不冒充全量)。 */
export const MAX_FILE_SCOPE_VARS = 500;
export const DECLARATOR_TYPES = new Set([
  "init_declarator", "pointer_declarator", "array_declarator", "identifier", "field_identifier",
  "parenthesized_declarator", "function_declarator",
]);
export const TYPE_TEXT_TYPES = new Set([
  "primitive_type", "type_identifier", "sized_type_specifier", "struct_specifier",
  "union_specifier", "enum_specifier", "type_qualifier", "storage_class_specifier",
  "macro_type_specifier", "template_type",
]);

export interface DeclaratorInfo {
  name?: string;
 /** 名字标识符 span(character=0-based 列; typed/ semantic-token 供位)。 */
  nameSpan?: { character: number; length: number };
  pointers: number;
  arrays: string[];
  isFnPtr: boolean;
  params?: string;
}

/** declarator 递归分析:名字+名字 span+指针深度+数组维度+函数指针形态(声明时类型重构的原料)。
 * P1 导出:typed/ 逐文件档复用同一分析(单一真相,防双胞胎实现漂移)。
 * 判发在「节点自身类型」(首版只查子节点:裸 identifier declarator 取不到名、
 * function_declarator 自身永不触发——handler 形态 dataType 丢函数指针尾缀,测试抓出)。 */
export function analyzeDeclarator(node: CppNode, info: DeclaratorInfo): void {
  if (node.type === "identifier" || node.type === "field_identifier") {
    const t = node.text.trim();
    if (/^[A-Za-z_]\w*$/.test(t)) {
      info.name = t;
      info.nameSpan = { character: node.startPosition.column, length: t.length };
    }
    return;
  }
  if (node.type === "pointer_declarator" || node.type === "reference_declarator") {
    info.pointers++;
  } else if (node.type === "array_declarator") {
 // 维度=「[」之后的形态(首个 identifier 是名字,不算 size——`int primes[10]` 经验证)
    let afterBracket = false;
    let size: string | undefined;
    for (const c of childrenOf(node)) {
      if (c.type === "[") { afterBracket = true; continue; }
      if (!afterBracket || c.type === "]") continue;
      if (c.type === "number_literal" || c.type === "identifier" || c.type === "binary_expression") {
        size = c.text.trim();
        break;
      }
    }
    info.arrays.push(size ? `[${size}]` : "[]");
  } else if (node.type === "function_declarator") {
    info.isFnPtr = true;
    const pl = childrenOf(node).find((x) => x.type === "parameter_list");
    if (pl) info.params = pl.text.replace(/\s+/g, " ").trim();
  }
  // init_declarator/parenthesized_declarator/包装层:自身无动作,递归内层 declarator
  // (identifier 子节点=名字,参与递归;数组 size 的 identifier 已在 array 分支按「[ 之后」定位)
  for (const c of childrenOf(node)) {
    if (DECLARATOR_TYPES.has(c.type)) {
      analyzeDeclarator(c, info);
    }
  }
}

/** 声明时类型文本重构:typeText + declarator 形态(指针/数组/函数指针;函数指针的星在括号内——
 * `void (*handler)(int)` → `void (*)(int)`)。 P1 导出:索引档与 typed/ 档共用。 */
export function declaratorDataType(typeText: string, info: DeclaratorInfo): string {
  if (info.isFnPtr) {
    const stars = "*".repeat(Math.max(0, info.pointers - 1));
    return `${typeText} (*${stars})${info.params ?? "()"}`.replace(/\s+/g, " ").trim().slice(0, 120);
  }
  let dataType = typeText;
  if (info.pointers > 0) dataType += "*".repeat(info.pointers);
  if (info.arrays.length > 0) dataType += info.arrays.join("");
  return dataType.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** 顶层声明头部的类型文本(type 节点文本拼接;attribute_specifier 噪声剥除;struct 体折叠)。
 * P1 导出:typed/ 逐文件档复用。 */
export function declarationTypeText(decl: CppNode): string {
  const parts: string[] = [];
  for (const c of childrenOf(decl)) {
    if (DECLARATOR_TYPES.has(c.type)) break;
    if (c.type === "attribute_specifier") continue;
    if (!TYPE_TEXT_TYPES.has(c.type)) continue;
    parts.push(c.text.replace(/\{[\s\S]*\}/, "{…}").replace(/\s+/g, " ").trim());
  }
  return parts.join(" ").trim();
}

/** 文件级(translation_unit 直属)declaration 的变量提取——plain/指针/数组/初始化/函数指针。
 * 函数原型(function_declarator 且 identifier 直名)让位既有原型登记,此处跳过。
 * P1 导出:typed/ 逐文件档复用。 */
export function fileScopeVars(unit: CppNode, relFile: string): CppSymbol[] {
  const out: CppSymbol[] = [];
  const seen = new Set<string>();
  const topLevel = childrenOf(unit).filter((c) => c.type === "declaration");
  for (const decl of topLevel) {
    if (out.length >= MAX_FILE_SCOPE_VARS) break;
    if (containsError(decl)) continue;
    const typeText = declarationTypeText(decl);
    if (!typeText) continue;
    for (const c of childrenOf(decl)) {
      if (!DECLARATOR_TYPES.has(c.type)) continue;
      // 顶层原型(直接函数声明)不按变量收:identifier 直名于 function_declarator 之内
      if (c.type === "function_declarator") {
        const direct = childrenOf(c).some((x) => x.type === "identifier");
        if (direct) continue; // 原型已由既有 Pass 登记
      }
      const info: DeclaratorInfo = { pointers: 0, arrays: [], isFnPtr: false };
      analyzeDeclarator(c, info);
      if (!info.name || seen.has(info.name)) continue;
      seen.add(info.name);
      const dataType = declaratorDataType(typeText, info);
      out.push({
        name: info.name,
        id: `${relFile}#${info.name}`,
        kind: "variable",
        file: relFile,
        line: decl.startPosition.row + 1,
        dataType,
      });
    }
  }
  return out;
}

/** 签名:参数表逐项取名(末位标识符;取不到=占位),返回类型=声明头剩余文本(截 120)。 */
function signatureOf(node: CppNode, fd: CppNode): Signature | undefined {
  const plist = childrenOf(fd).find((c) => c.type === "parameter_list");
  if (!plist) return undefined;
  const inner = plist.text.replace(/^\(/, "").replace(/\)$/, "");
  const params = splitTopLevel(inner)
    .filter((p) => p && p !== "void")
    .map((p) => {
      const nameM = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(p.trim());
      return { name: nameM?.[1] ?? "_", type: p.trim().slice(0, 120) || undefined };
    });
  const head = node.text.slice(0, Math.max(0, fd.startIndex - node.startIndex)).replace(/\s+/g, " ").trim();
  return { params, ...(head ? { returnType: head.slice(0, 120) } : {}) };
}

/** 解析单个 C/C++ 文件。 */
export async function parseCppFile(root: string, relFile: string): Promise<CppParseResult> {
  const fail = (reason: string, tier: "skipped" = "skipped"): CppParseResult =>
    ({ symbols: [], edges: [], failures: [{ file: relFile, reason }], outcome: { tier, reason } });
  // P0:文件大小闸——巨型数据数组头(嵌入式资源/blob)tree-sitter 逐字节解析成 initializer 节点
 // 单文件 >120s; G6:闸命中文件不再直接跳过,改走 lexical 档(regex 顶层声明,毫秒级)
  let text: string;
  let gatedBySize = false;
  try {
    const { statSync } = await import("node:fs");
    const sz = statSync(join(root, relFile)).size;
    gatedBySize = sz > CPP_MAX_FILE_BYTES;
  } catch { /* stat 失败落到 readFile 分支统一处理 */ }
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return fail(String(err));
  }
  if (gatedBySize) {
    // 超闸文件:词法兜底提取顶层声明(数组/变量/原型);0 命中=skipped 如实登记
    const lex = lexicalScan(relFile, text);
    if (lex.length > 0) return { symbols: lex, edges: [], failures: [], outcome: { tier: "lexical", reason: `文件超 ${CPP_MAX_FILE_BYTES / 1024}KB 闸,词法档提取 ${lex.length} 个顶层声明` } };
    return fail(`文件超 ${CPP_MAX_FILE_BYTES / 1024}KB 阈值(数据数组/blob 形态)且词法扫描未发现顶层声明`);
  }

 // G4:属性宏 strip(等长空格,-D 等价,行号不变)——解析前统一做,
  // 让 `CV_EXPORTS_W void inpaint(...)`/`class CV_EXPORTS_W Tonemap : public Algorithm{}` 干净入树
  let stripped = stripAttributeMacros(text);
  // 无尾换行的文件:tree-sitter 给末节点标 missing(hasError=true)——纯 #define 头会因此
 // 误入 skipped 档(经验证 version.hpp 三行 define);补一个换行属语义中性归一化
  if (stripped.length > 0 && !stripped.endsWith("\n")) stripped += "\n";
  const ext = relFile.slice(relFile.lastIndexOf(".")).toLowerCase();
 // P0:.c 也加 cpp 语法兜底——真实仓里 .c 常混 C++ 语法(经验证 saadk_6920
  // yolox.c 的 `auto dims = ...`/`bool`):C grammar 报 ERROR 后该函数整段丢边;C++ grammar
  // 零错解析可完整恢复。.h 保持 cpp→c(头文件同理,只是方向相反)。
  const grammars: TsLang[] = ext === ".c" ? ["c", "cpp"] : ext === ".h" ? ["cpp", "c"] : ["cpp"];
  // .h 双语法兜底:C 头在 cpp 语法下的误报由 c 语法救。
 // P1(性能回归修复):first-grammar 结果 childCount>0 且无根级 ERROR
  // (hasError=false)即采纳,不再兜底——ERROR 文件跑满两趟 parse 是 agent_alpha .h 桶
 // >590s 的放大器;errCount 递归全树遍历(ssl.h 经验证 92ms ≈ parse 的 80%)换成 hasError O(1) 属性。
  let unit: CppNode | undefined;
  for (const g of grammars) {
    const parser = await loadTsParser(g);
    if (!parser) continue;
    let rootNode: CppNode;
    try {
      rootNode = (parser.parse(stripped) as unknown as { rootNode: CppNode }).rootNode;
    } catch {
      continue;
    }
    if (!rootNode || rootNode.childCount === 0) {
      // 0 字节/纯空白文件:解析成功且确认无声明 → empty 如实计(不是失败)
      if (!text.trim()) return { symbols: [], edges: [], failures: [], outcome: { tier: "empty", reason: "空文件(0 声明)" } };
      continue;
    }
    // P2:hasError 属性档替代 errCount 递归——「有/无错」对语法选择已足够;
    // hasError=true 时两种语法都试完取第一个可用的(不递归精确计数)
    const hasErr = rootNode.hasError === true;
    if (!hasErr) {
      unit = rootNode;
      break;
    }
    if (unit === undefined) {
      unit = rootNode;
    }
  }
  if (!unit) {
    return fail("tree-sitter c/cpp wasm 不可用或解析失败");
  }

  // —— Pass 1: 符号收集(healthy 节点才收;同 id 定义优先于原型) ——
  const symbols = new Map<string, { sym: CppSymbol; isProto: boolean }>();
  const register = (sym: CppSymbol, isProto: boolean): void => {
    const cur = symbols.get(sym.id);
    if (!cur || (cur.isProto && !isProto)) symbols.set(sym.id, { sym, isProto });
  };
  const mkId = (name: string, container?: string): string => `${relFile}#${container ? container + "." : ""}${name}`;

  // 函数定义登记(line→node 留给 Pass 2 提调用,避免二次全树扫)
  const funcBodies = new Map<string, CppNode>(); // symbol id → function_definition 节点
  const bodyErrorRanges = new Map<string, CppErrorRange[]>(); // 仅含 ERROR 的函数体
  for (const fd of unit.descendantsOfType("function_definition")) {
    const inner = findFunctionDeclarator(fd);
    if (!inner) continue;
 // P0:不再因函数体含 ERROR 整段丢边——declarator 健康就进 funcBodies,
 // 只记录 ERROR 区间,Pass 2 逐调用剔除区间内的坏点(依据:SA_ADK_Infer_Sync 仅签名 3 字符
    // ERROR,千行函数体里的 10 个真实调用全在区间外)。
    if (containsError(fd) && containsError(inner)) continue; // declarator 亦有错(参数表坏):不猜
    const { name, container: qContainer } = declaratorName(inner);
    if (!name) continue;
    const container = qContainer ?? ancestorClassOf(fd);
    const id = mkId(name, container);
    const sig = signatureOf(fd, inner);
    register({
      name,
      id,
      kind: container ? "method" : "function",
      file: relFile,
      line: fd.startPosition.row + 1,
      ...(container ? { container } : {}),
      ...(sig ? { signature: sig } : {}),
    }, false);
    funcBodies.set(id, fd);
    if (fd.hasError === true) {
      const ranges = collectErrorRanges(fd);
      if (ranges.length > 0) bodyErrorRanges.set(id, ranges);
    }
  }
  // 原型登记(定义到场时让位;原型无函数体不进 funcBodies)。容错语义同上。
 // 类体内成员原型是 field_declaration 节点(C++ grammar, G4 经验证:CV_WRAP 方法),
  // 顶层原型是 declaration——两个节点型都收。
  for (const declType of ["declaration", "field_declaration"] as const) {
    for (const decl of unit.descendantsOfType(declType)) {
      const fdInner = findFunctionDeclarator(decl);
      if (!fdInner) continue;
      if (containsError(decl) && containsError(fdInner)) continue;
      const { name, container: qContainer } = declaratorName(fdInner);
      if (!name) continue;
      const container = qContainer ?? ancestorClassOf(decl);
      register({
        name,
        id: mkId(name, container),
        kind: container ? "method" : "function",
        file: relFile,
        line: decl.startPosition.row + 1,
        proto: true, // 跨文件消歧:定义优先(见 engine resolveStructCrossFile)
        ...(container ? { container } : {}),
      }, true);
    }
  }
  for (const t of ["struct_specifier", "union_specifier", "enum_specifier", "class_specifier"] as const) {
    for (const ts of unit.descendantsOfType(t)) {
      if (containsError(ts)) continue;
      const name = typeNameOf(ts);
      if (!name) continue;
      register({ name, id: mkId(name), kind: "class", file: relFile, line: ts.startPosition.row + 1 }, false);
    }
  }
 // G3:typedef(type_definition declarator 名;函数指针形态不猜)
 // P1:typedef 符号带 dataType(底层类型文本)
  for (const td of unit.descendantsOfType("type_definition")) {
    if (containsError(td)) continue;
    const name = typedefName(td);
    if (!name) continue;
    const underlying = typedefUnderlying(td);
    register({ name, id: mkId(name), kind: "typedef", file: relFile, line: td.startPosition.row + 1, ...(underlying ? { dataType: underlying } : {}) }, false);
  }
 // P1:文件级变量(plain/指针/数组/初始化/函数指针;零边,variable 不进 byName)
  for (const v of fileScopeVars(unit, relFile)) {
    register(v, false);
  }

  // —— Pass 2: 调用边(健康函数定义体内;同文件唯一名解析,原型让位定义) ——
  const isProtoId = new Set([...symbols.entries()].filter(([, v]) => v.isProto).map(([id]) => id));
  const localByName = new Map<string, string[]>();
  for (const [id, { sym }] of symbols) {
    const list = localByName.get(sym.name) ?? [];
    list.push(id);
    localByName.set(sym.name, list);
  }
  /** 同文件候选消歧:定义优先;剩多个=不猜(返回 undefined 且本地无候选→发跨文件候选)。 */
  const resolveLocal = (name: string): string | undefined => {
    const cands = localByName.get(name) ?? [];
    if (cands.length === 0) return undefined;
    const defs = cands.filter((id) => !isProtoId.has(id));
    const pool = defs.length > 0 ? defs : cands;
    return pool.length === 1 ? pool[0] : undefined;
  };

  const edges: FlowEdge[] = [];
  const candidates: FlowEdge[] = [];
  const candSeen = new Set<string>();
  const edgeSeen = new Set<string>();
  const pushEdge = (e: FlowEdge): void => {
    const k = `${e.from}|${e.to}|${e.toName}|${e.line}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push(e);
  };
  const pushCandidate = (callerId: string, toName: string, line: number, receiverType?: string): void => {
    const k = `${callerId}|${receiverType ? receiverType + "::" : ""}${toName}`;
    if (candSeen.has(k)) return;
    candSeen.add(k);
    candidates.push({ from: callerId, to: "", toName, file: relFile, line, tier: "structural", evidenceKind: "inferred", ...(receiverType ? { receiverType } : {}) });
  };

  for (const [callerId, { sym: caller }] of symbols) {
    if (caller.kind === "class") continue;
    const body = funcBodies.get(callerId);
    if (!body) continue; // 原型无函数体:不产调用边
    const errRanges = bodyErrorRanges.get(callerId);
    for (const call of body.descendantsOfType("call_expression")) {
      if (inErrorRange(call, errRanges)) continue; // 错误点内的调用不猜( P0)
      const head = childrenOf(call)[0];
      if (!head) continue;
      const line = call.startPosition.row + 1;
      if (head.type === "identifier") {
        // 裸名调用 malloc()/foo():同文件唯一→连边;本地无→发候选交全图唯一名闸
        const name = head.text.trim();
        if (!/^[A-Za-z_]\w*$/.test(name)) continue;
 // P1(spawn 边):pthread_create(&t, attr, fn, arg) 第 3 参 / xTaskCreate(fn, …)
        // 第 1 参——线程/任务入口的函数引用不是调用点,旧图看不见(嵌入式 launcher 链沉底同因)。
        if (name === "pthread_create" || name === "xTaskCreate") {
          const argList = childrenOf(call).find((c) => c.type === "argument_list");
          if (argList) {
            const inner = argList.text.replace(/^\(/, "").replace(/\)$/, "");
            const parts = splitTopLevel(inner, ",");
            const piece = parts[name === "pthread_create" ? 2 : 0]?.trim() ?? "";
            if (/^[A-Za-z_]\w*$/.test(piece)) {
              const to = resolveLocal(piece);
              if (to && to !== callerId) {
                pushEdge({ from: callerId, to, toName: piece, file: relFile, line, tier: "structural", evidenceKind: "ast" });
              }
            }
          }
        }
        const to = resolveLocal(name);
        if (to) {
          if (to !== callerId) pushEdge({ from: callerId, to, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        } else {
          pushCandidate(callerId, name, line);
        }
      } else if (head.type === "field_expression") {
        // 成员调用 p->release() / obj.method():取末段成员名;接收者无类型证据(登记边界),
        // 同文件唯一候选命中即连边,否则发候选交全图唯一名闸
        const members = childrenOf(head).filter((c) => c.type === "field_identifier");
        const name = members[members.length - 1]?.text.trim();
        if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
        const to = resolveLocal(name);
        if (to) {
          if (to !== callerId) pushEdge({ from: callerId, to, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        } else {
          pushCandidate(callerId, name, line);
        }
      } else if (head.type === "qualified_identifier") {
        // Cls::method():限定名即证据;同文件恰有该 Class.method 直接连边,否则带 receiverType 发候选
        const parts = head.text.split("::").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
        if (parts.length < 2) continue;
        const name = parts[parts.length - 1]!;
        const recv = parts[parts.length - 2]!;
        const localId = `${relFile}#${recv}.${name}`;
        if (symbols.has(localId) && localId !== callerId) {
          pushEdge({ from: callerId, to: localId, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
        } else {
          pushCandidate(callerId, name, line, recv);
        }
      }
    }
    for (const ne of body.descendantsOfType("new_expression")) {
      if (inErrorRange(ne, errRanges)) continue; // 错误点内的 new 不猜( P0)
      // new Cls<T>(...):取模板实参前的类型名,按类名调用(类符号在 byName)
      const tNode = childrenOf(ne)[0];
      if (!tNode) continue;
      const raw = tNode.text.split("<")[0]!.trim();
      const parts = raw.split("::").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
      const name = parts[parts.length - 1];
      if (!name) continue;
      const to = resolveLocal(name);
      if (to && to !== callerId) {
        pushEdge({ from: callerId, to, toName: name, file: relFile, line: ne.startPosition.row + 1, tier: "structural", evidenceKind: "ast" });
      }
    }
 // P1(缺口②):函数指针/回调注册赋值——`ops.fn = handler` / `p->cb = &handler`。
 // 不是 call_expression,旧提取完全看不见;策略表/回调改签名是最危险的盲区(经验证
    // saadk_c `.criteria_func = face_selection_criteria` 三面全盲)。RHS 限裸名/取址裸名,
    // 且必须解析到本文件函数符号——其余形态(变量中转/条件)不猜。
    for (const asgn of body.descendantsOfType("assignment_expression")) {
      if (inErrorRange(asgn, errRanges)) continue;
      const kids = childrenOf(asgn);
      const lhs = kids[0];
      const rhs = kids[kids.length - 1];
      if (!lhs || !rhs || lhs.type !== "field_expression") continue; // 只认成员槽位赋值(整变量=fn 太弱)
      let name = "";
      if (rhs.type === "identifier") name = rhs.text.trim();
      else if (rhs.type === "pointer_expression") {
        const inner = childrenOf(rhs).filter((c) => c.type !== "&")[0];
        if (inner && inner.type === "identifier") name = inner.text.trim();
      }
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
      const to = resolveLocal(name);
      if (to && to !== callerId) {
        pushEdge({ from: callerId, to, toName: name, file: relFile, line: asgn.startPosition.row + 1, tier: "structural", evidenceKind: "ast" });
      }
    }
  }

 // P1(缺口②续):顶层策略表初始化器——`static const ops_s g_ops = {`
  // ` .criteria_func = face_selection_criteria, };`。三种形态:initializer_pair(.field = fn)
  // / 位置式直接 identifier({ fn })/ 标量 RHS(int (*fn)(int) = handler)。RHS 认裸名与
  // &裸名,必须解析到本文件函数符号。归属=被初始化的表变量(callers 面显示「表 g_ops
  // 引用了它」);变量缺席时归 <module>。
  const fnNameOfInitItem = (item: CppNode | undefined): string => {
    if (!item) return "";
    if (item.type === "identifier") return item.text.trim();
    if (item.type === "pointer_expression") {
      const inner = childrenOf(item).filter((c) => c.type !== "&")[0];
      if (inner && inner.type === "identifier") return inner.text.trim();
    }
    return "";
  };
  const pushFnRef = (fromId: string, name: string, line: number): void => {
    if (!/^[A-Za-z_]\w*$/.test(name)) return;
    const to = resolveLocal(name);
    if (to && to !== fromId) {
      pushEdge({ from: fromId, to, toName: name, file: relFile, line, tier: "structural", evidenceKind: "ast" });
    }
  };
  for (const idc of unit.descendantsOfType("init_declarator")) {
    const declNameNode = childrenOf(idc)[0];
    const varName = declNameNode?.type === "identifier" ? declNameNode.text.trim() : "";
    const fromId = varName && symbols.has(`${relFile}#${varName}`)
      ? `${relFile}#${varName}`
      : `${relFile}#<module>`;
    const eqAt = childrenOf(idc).findIndex((c) => c.type === "=");
    const rhs = eqAt >= 0 ? childrenOf(idc).slice(eqAt + 1).find((c) => c.type === "initializer_list" || c.type === "identifier" || c.type === "pointer_expression") : undefined;
    if (rhs?.type === "initializer_list") {
      for (const item of childrenOf(rhs)) {
        if (item.type === "initializer_pair") {
          // .field = fn / .field = &fn:取 pair 的值侧(最末 identifier/pointer_expression)
          const valSide = childrenOf(item).filter((c) => c.type === "identifier" || c.type === "pointer_expression").pop();
          const name = fnNameOfInitItem(valSide);
          if (name) pushFnRef(fromId, name, item.startPosition.row + 1);
        } else if (item.type === "identifier" || item.type === "pointer_expression") {
          // 位置式:{ fn }(类型槽位按声明序对齐,静态不判哪个槽是函数指针——凡命中本文件
          // 函数名的位置式元素都连边;非函数名自然解析不到,零误伤)
          const name = fnNameOfInitItem(item);
          if (name) pushFnRef(fromId, name, item.startPosition.row + 1);
        }
      }
    } else if (rhs) {
      // 标量形态:int (*fn)(int) = handler; / = &handler;
      const name = fnNameOfInitItem(rhs);
      if (name) pushFnRef(fromId, name, rhs.startPosition.row + 1);
    }
  }

  const symbolsArr = [...symbols.values()].map((s) => s.sym);
 // 分档结算:结构档有符号=full;0 符号 → lexical 兜底(regex 顶层声明,零边);
  // 兜底仍 0 → root 干净=empty(确认无声明,纯 include 聚合头/纯 #define)/root 有错=skipped 带 reason
  if (symbolsArr.length > 0) {
 // P1:ERROR 文件的词法补集合并——ERROR 子树会吞相邻健康声明(经验证 ObjC 错误段
 // 吞掉紧随的 extern 变量, 召回回退);结构档在场时词法档只补 id 缺集(tier=lexical
    // 如实,零边、不进 byName 纪律不变),干净文件不跑词法(零开销)。
    if (unit.hasError === true) {
      const have = new Set(symbolsArr.map((x) => x.id));
      for (const lexSym of lexicalScan(relFile, text)) {
        if (!have.has(lexSym.id)) symbolsArr.push(lexSym);
      }
    }
    return { symbols: symbolsArr, edges, failures: [], outcome: { tier: "full", ...(unit.hasError === true ? { errors: true } : {}) }, crossFileCandidates: candidates };
  }
  const lex = lexicalScan(relFile, text);
  if (lex.length > 0) {
    return { symbols: lex, edges: [], failures: [], outcome: { tier: "lexical", reason: `结构档 0 符号,词法档提取 ${lex.length} 个顶层声明`, ...(unit.hasError === true ? { errors: true } : {}) } };
  }
  const reason = unit.hasError === true
    ? "解析含语法错误且词法兜底未发现顶层声明"
    : "解析成功但确认无声明(纯 include/纯宏/注释文件)";
  return { symbols: [], edges: [], failures: [], outcome: unit.hasError === true ? { tier: "skipped", reason, errors: true } : { tier: "empty", reason } };
}
