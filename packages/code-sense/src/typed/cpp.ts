/**
 * typed/cpp( P1 / §2.2):C/C++ 逐文件深提取——文件级变量(带 span)+
 * struct 字段+enum 常量+typedef,tree-sitter 档;解析不可用/零符号回退 adapters/cpp.ts 的
 * lexicalScan(regex 顶层声明,tier=lexical 如实)。分析原语(analyzeDeclarator 等)复用
 * adapters/cpp.ts 导出件(单一真相,防双胞胎实现漂移)。
 * opencv 风格补强(着色补位,全部本地于本文件,adapters 索引路径零接触):
 * ①namespace 下探:opencv `namespace cv { … }` 包裹的文件级变量/typedef 在
 * namespace_definition→declaration_list 子树内(accum.cpp 注意:620 行 13 token 的根因
 *   之一),文件级声明收集改为「顶层 + namespace 体」递归;
 * ②qualified 名字营救:function_declarator 的声明子为 qualified_identifier 时
 *   (清洁形态 `cv::accumulate`;宏吊死形态 `CV_STDCALL ippiAddWrap`——tree-sitter 解成含
 * ERROR `::` 的 qualified,accum.cpp 注意),取末段 identifier 为名字(span=该子节点),
 *   次末段非 ALLCAPS 形(宏不冒充容器)才记 container;
 * ③函数指针 typedef 营救:`typedef void(*AccFunc)(…)` 名字在括号内(adapters typedefName
 *   登记的边界),本档按文本形态 `\(\s*\*\s*(Name)\s*\)` 营救,dataType 重构 `ret (*)(params)`。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  analyzeDeclarator, childrenOf, containsError, declarationTypeText, declaratorDataType,
  DECLARATOR_TYPES, lexicalScan, stripAttributeMacros, typedefName, typedefUnderlying,
  type CppNode, type DeclaratorInfo,
} from "../adapters/cpp";
import { loadTsParser } from "../adapters/tree-sitter";
import { readFailReason, type TypedFileResult, type TypedKind, type TypedSymbol } from "./types";

/** 单文件符号上限(病态大文件防炸;截断如实)。 */
const MAX_SYMBOLS = 2000;

/** 文件级声明收集:顶层 + namespace_definition 的 declaration_list 递归
 * (嵌套 namespace 同)。只下探 namespace——class/函数体内的声明是成员/局部,不属文件级。 */
function fileLevelDeclarations(unit: CppNode): CppNode[] {
  const out: CppNode[] = [];
  const walk = (n: CppNode): void => {
    for (const c of childrenOf(n)) {
      if (c.type === "declaration") out.push(c);
      else if (c.type === "namespace_definition") {
        const body = childrenOf(c).find((x) => x.type === "declaration_list");
        if (body) walk(body);
      }
    }
  };
  walk(unit);
  return out;
}

export async function extractCppTyped(root: string, relFile: string): Promise<TypedFileResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { file: relFile, language: "c", symbols: [], degraded: { reason: `读取失败: ${readFailReason(err)}` } };
  }
  const ext = relFile.slice(relFile.lastIndexOf(".")).toLowerCase();
  const grammars = ext === ".c" ? ["c"] : ext === ".h" ? ["cpp", "c"] : ["cpp"];
  let unit: CppNode | undefined;
  const stripped = stripAttributeMacros(text) + (text.length > 0 && !text.endsWith("\n") ? "\n" : "");
  for (const g of grammars) {
    const parser = await loadTsParser(g as "c" | "cpp");
    if (!parser) continue;
    let rootNode: CppNode;
    try {
      rootNode = (parser.parse(stripped) as unknown as { rootNode: CppNode }).rootNode;
    } catch {
      continue;
    }
    if (!rootNode || rootNode.childCount === 0) continue;
    unit = rootNode;
    if (rootNode.hasError !== true) break; // 干净语法优先;.h 双语法兜底语义与 adapters/cpp.ts 一致
  }
  if (!unit) {
    // wasm 不可用/解析失败:lexical 兜底(regex 顶层声明,带 dataType,tier=lexical 如实)
    const lex = lexicalScan(relFile, text);
    return {
      file: relFile,
      language: "c",
      symbols: lex.map(toTypedFromCppSymbol),
      degraded: { reason: "tree-sitter c/cpp wasm 不可用或解析失败——词法档回退(regex 顶层声明,tier=lexical)" },
    };
  }

  const symbols: TypedSymbol[] = [];
  const push = (s: TypedSymbol): boolean => {
    if (symbols.length >= MAX_SYMBOLS) return false;
    symbols.push(s);
    return true;
  };
  const lineOf = (n: CppNode): number => n.startPosition.row + 1;
 // 整流环:多行声明里 line(外层节点起始行)与 span.character(名字节点自身列)会错配
 // (opencv 注意:`int dtype=…, wdepth=…,\n wtype=…`、`} LABLUVLUTs16 = {…}`、
  // `inline\nfloat initWideAngleProjMap(`)——push 时登记 (symbol, 节点),收尾统一校验
  // slice==name,失配则在节点行区间内按词边界重定位(首个=声明位),修不了丢 span 不造假。
  const rectPairs: { s: TypedSymbol; node: CppNode }[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const rowOfOffset = (abs: number): number => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= abs) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const srcLines = text.split("\n");
  const rectifySpans = (): void => {
    for (const { s, node } of rectPairs) {
      const sp = s.span!;
      const cur = srcLines[s.line - 1] ?? "";
      if (cur.substr(sp.character, sp.length) === s.name) continue;
      const from = rowOfOffset(node.startIndex);
      const to = rowOfOffset(node.endIndex);
      const re = new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      let fixed = false;
      for (let r = from; r <= to; r++) {
        const m = re.exec(srcLines[r]!);
        if (m) { s.line = r + 1; s.span = { character: m.index, length: s.name.length }; fixed = true; break; }
      }
      if (!fixed) delete s.span; // 修不了=丢 span(token 流不收),符号保留——不造假位置
    }
  };

  // ① 文件级变量(复用 adapters/cpp.ts fileScopeVars 的跳过语义;此处自带 span;
 // namespace 体下探——opencv `namespace cv {}` 包裹形态)
  for (const decl of fileLevelDeclarations(unit)) {
    if (symbols.length >= MAX_SYMBOLS) break;
    if (containsError(decl)) continue;
    const typeText = declarationTypeText(decl);
    if (!typeText) continue;
    for (const c of childrenOf(decl)) {
      if (!DECLARATOR_TYPES.has(c.type)) continue;
      if (c.type === "function_declarator" && childrenOf(c).some((x) => x.type === "identifier")) continue; // 原型让位
      const info: DeclaratorInfo = { pointers: 0, arrays: [], isFnPtr: false };
      analyzeDeclarator(c, info);
 // 数组名纠偏:analyzeDeclarator 递归进维度表达式,`accTab[CV_DEPTH_MAX]`
 // 的 size 标识符会覆盖真名(accum.cpp 注意);数组声明的名字=首个「[」前的 declarator 标识符。
      // 注:共享件同型行为在索引档(adapters fileScopeVars)同样存在,登记为既有边界,不在本步动。
      const arrFix = arrayVarName(c);
      if (arrFix) { info.name = arrFix.name; info.nameSpan = { character: arrFix.character, length: arrFix.name.length }; }
      if (!info.name) continue;
      const sym: TypedSymbol = {
        name: info.name,
        kind: "variable",
        dataType: declaratorDataType(typeText, info),
        file: relFile,
        line: lineOf(decl),
        ...(info.nameSpan ? { span: info.nameSpan } : {}),
        tier: "structural",
      };
      push(sym);
      if (sym.span) rectPairs.push({ s: sym, node: decl });
    }
  }

 // ② struct/union 字段 + enum 常量(容器归属;索引档不收字段——体量面, §2.4)
  for (const spType of ["struct_specifier", "union_specifier", "enum_specifier"] as const) {
    for (const sp of unit.descendantsOfType(spType)) {
      if (containsError(sp)) continue;
      const nameNode = childrenOf(sp).find((c) => c.type === "type_identifier");
      const container = nameNode?.text.trim() || "<anonymous>";
      const bodyType: TypedKind = spType === "enum_specifier" ? "enum" : "struct";
      if (symbols.length < MAX_SYMBOLS && nameNode) {
        const sym: TypedSymbol = { name: container, kind: bodyType, file: relFile, line: lineOf(sp), span: { character: nameNode.startPosition.column, length: container.length }, tier: "structural" };
        push(sym);
        rectPairs.push({ s: sym, node: sp });
      }
      if (spType === "enum_specifier") {
        // enumerator 在 enumerator_list 之下(非 specifier 直接子级)
        const enList = childrenOf(sp).find((c) => c.type === "enumerator_list");
        for (const en of enList ? childrenOf(enList).filter((c) => c.type === "enumerator") : []) {
          if (symbols.length >= MAX_SYMBOLS) break;
          const idNode = childrenOf(en).find((c) => c.type === "identifier");
          const enName = idNode?.text.trim();
          if (!enName || !/^[A-Za-z_]\w*$/.test(enName)) continue;
          const sym: TypedSymbol = {
            name: enName, kind: "enumMember", dataType: container, file: relFile, line: lineOf(en),
            ...(idNode ? { span: { character: idNode.startPosition.column, length: enName.length } } : {}),
            container, tier: "structural",
          };
          push(sym);
          if (sym.span) rectPairs.push({ s: sym, node: en });
        }
        continue;
      }
      const body = childrenOf(sp).find((c) => c.type === "field_declaration_list");
      if (!body) continue;
      for (const fd of childrenOf(body).filter((c) => c.type === "field_declaration")) {
        if (symbols.length >= MAX_SYMBOLS) break;
        if (containsError(fd)) continue;
        const isFnField = childrenOf(fd).some((c) => c.type === "function_declarator");
        if (isFnField) continue; // 方法声明归函数面,非字段
        // 类型文本=首个 declarator 形节点之前的 type 子节点
        const parts: string[] = [];
        for (const c of childrenOf(fd)) {
          if (DECLARATOR_TYPES.has(c.type)) break;
          if (c.type === "attribute_specifier") continue;
          if (["primitive_type", "type_identifier", "sized_type_specifier", "struct_specifier", "union_specifier", "enum_specifier", "type_qualifier"].includes(c.type)) {
            parts.push(c.text.replace(/\{[\s\S]*\}/, "{…}").replace(/\s+/g, " ").trim());
          }
        }
        const baseType = parts.join(" ").trim();
        if (!baseType) continue;
        for (const c of childrenOf(fd)) {
          if (!DECLARATOR_TYPES.has(c.type)) continue;
          const info: DeclaratorInfo = { pointers: 0, arrays: [], isFnPtr: false };
          analyzeDeclarator(c, info);
          const arrFix = arrayVarName(c); // 数组名纠偏(同 ① 循环,见该处注释)
          if (arrFix) { info.name = arrFix.name; info.nameSpan = { character: arrFix.character, length: arrFix.name.length }; }
          if (!info.name) continue;
          let dataType = baseType;
          if (info.pointers > 0) dataType += "*".repeat(info.pointers);
          if (info.arrays.length > 0) dataType += info.arrays.join("");
          const sym: TypedSymbol = {
            name: info.name, kind: "property",
            dataType: dataType.replace(/\s+/g, " ").trim().slice(0, 120),
            file: relFile, line: lineOf(fd),
            ...(info.nameSpan ? { span: info.nameSpan } : {}),
            container, tier: "structural",
          };
          push(sym);
          if (sym.span) rectPairs.push({ s: sym, node: fd });
        }
      }
    }
  }

 // ③ typedef(kind=type,带底层类型;函数指针形态括号内名字营救)
  for (const td of unit.descendantsOfType("type_definition")) {
    if (symbols.length >= MAX_SYMBOLS) break;
    if (containsError(td)) continue;
    const name = typedefName(td);
    if (name) {
      const underlying = typedefUnderlying(td);
      push({ name, kind: "type", ...(underlying ? { dataType: underlying } : {}), file: relFile, line: lineOf(td), tier: "structural" });
      continue;
    }
    const fnptr = typedefFnPtrRescue(td, text);
    if (fnptr) {
      const sym: TypedSymbol = { name: fnptr.name, kind: "type", dataType: fnptr.dataType, file: relFile, line: fnptr.line, ...(fnptr.span ? { span: fnptr.span } : {}), tier: "structural" };
      push(sym);
      if (sym.span) rectPairs.push({ s: sym, node: td });
    }
  }

 // ④ 函数/方法(kind=function——tokens 面供着色;零 dataType;qualified 名字营救)
  for (const fd of unit.descendantsOfType("function_definition")) {
    if (symbols.length >= MAX_SYMBOLS) break;
    const inner = findFnDeclarator(fd);
    if (!inner) continue;
    const info: DeclaratorInfo = { pointers: 0, arrays: [], isFnPtr: false };
    analyzeDeclarator(inner, info);
    const cls = ancestorClass(fd);
    if (!info.name) {
      // qualified_identifier 声明子:cv::accumulate(清洁)/ CV_STDCALL ippiXxx(宏吊死含 ERROR)
      const q = qualifiedNameRescue(inner);
      if (!q) continue;
      const container = q.container ?? cls;
      const sym: TypedSymbol = {
        name: q.name, kind: container ? "method" : "function", file: relFile, line: lineOf(fd),
        span: q.span, ...(container ? { container } : {}), tier: "structural",
      };
      push(sym);
      rectPairs.push({ s: sym, node: fd });
      continue;
    }
    const sym: TypedSymbol = {
      name: info.name, kind: cls ? "method" : "function", file: relFile, line: lineOf(fd),
      ...(info.nameSpan ? { span: info.nameSpan } : {}), ...(cls ? { container: cls } : {}), tier: "structural",
    };
    push(sym);
    if (sym.span) rectPairs.push({ s: sym, node: fd });
  }
  rectifySpans();

  if (symbols.length === 0) {
    const lex = lexicalScan(relFile, text);
    return {
      file: relFile,
      language: "c",
      symbols: lex.map(toTypedFromCppSymbol),
      degraded: { reason: "结构档 0 符号——词法档回退(regex 顶层声明,tier=lexical)" },
    };
  }
  return { file: relFile, language: "c", symbols };
}

function toTypedFromCppSymbol(s: ReturnType<typeof lexicalScan>[number]): TypedSymbol {
  return {
    name: s.name,
    kind: s.kind === "typedef" ? "type" : s.kind === "variable" ? "variable" : s.kind === "class" ? "struct" : "function",
    ...(s.dataType ? { dataType: s.dataType } : {}),
    file: s.file,
    line: s.line,
    tier: "lexical",
  };
}

/** 最外层 function_declarator(直接子级或经包装一层;与 adapters/cpp.ts 同深度语义)。 */
function findFnDeclarator(node: CppNode): CppNode | undefined {
  const WRAPPERS = new Set(["pointer_declarator", "reference_declarator", "parenthesized_declarator"]);
  for (const c of childrenOf(node)) if (c.type === "function_declarator") return c;
  for (const c of childrenOf(node)) {
    if (!WRAPPERS.has(c.type)) continue;
    for (const g of childrenOf(c)) if (g.type === "function_declarator") return g;
  }
  return undefined;
}

/** 数组声明真名定位——array_declarator 的首个「[」前 declarator 标识符
 * (analyzeDeclarator 会递归进维度表达式把 size 标识符当名,`accTab[CV_DEPTH_MAX]` 注意);
 * 非数组声明返回 undefined(调用方保持 analyzeDeclarator 结果)。 */
function arrayVarName(n: CppNode): { name: string; character: number } | undefined {
  if (n.type === "array_declarator") {
    for (const c of childrenOf(n)) {
      if (c.type === "[") break;
      if (!DECLARATOR_TYPES.has(c.type)) continue;
      if (c.type === "identifier" || c.type === "field_identifier") {
        const t = c.text.trim();
        if (/^[A-Za-z_]\w*$/.test(t)) return { name: t, character: c.startPosition.column };
        continue;
      }
      const inner = arrayVarName(c);
      if (inner) return inner;
    }
    return undefined;
  }
  for (const c of childrenOf(n)) {
    if (c.type === "identifier" || c.type === "field_identifier") continue;
    if (!DECLARATOR_TYPES.has(c.type)) continue;
    const r = arrayVarName(c);
    if (r) return r;
  }
  return undefined;
}

/** 祖先链上最近的具名 class/struct specifier(方法容器归属)。 */
function ancestorClass(node: CppNode): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === "class_specifier" || cur.type === "struct_specifier") {
      const name = childrenOf(cur).find((c) => c.type === "type_identifier");
      const t = name?.text.trim();
      return t && /^[A-Za-z_]\w*$/.test(t) ? t : undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** ②:function_declarator 声明子为 qualified_identifier 时的名字营救。
 * 覆盖两形态(accum.cpp 注意):清洁形态 `cv::accumulate`(qualified 无错)与宏吊死形态
 * `CV_STDCALL ippiAddWrap`(tree-sitter 解成含 ERROR `::` 的 qualified:children=
 * namespace_identifier(CV_STDCALL)+ERROR()+identifier(ippiAddWrap))。
 * 取末段 identifier 为名字(span=该子节点);次末段为 ALLCAPS 形(调用约定/导出宏)不记
 * container(宏不冒充类容器),否则如实记(命名空间/类限定)。 */
function qualifiedNameRescue(fd: CppNode): { name: string; container?: string; span: { character: number; length: number } } | undefined {
  const q = childrenOf(fd).find((c) => c.type === "qualified_identifier");
  if (!q) return undefined;
  const segs = childrenOf(q).filter(
    (c) => c.type === "identifier" || c.type === "namespace_identifier" || c.type === "type_identifier" || c.type === "template_type",
  );
  const last = segs[segs.length - 1];
  if (!last || last.type !== "identifier") return undefined; // 析构 ~X/operator 等契约外形态不收
  const name = last.text.trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const prevText = segs.length >= 2 ? segs[segs.length - 2]!.text.trim().split("<")[0]!.trim() : undefined;
  const container = prevText && /^[A-Za-z_]\w*$/.test(prevText) && !/^[A-Z][A-Z0-9_]+$/.test(prevText) ? prevText : undefined;
  return { name, ...(container ? { container } : {}), span: { character: last.startPosition.column, length: name.length } };
}

/** ③:函数指针 typedef 营救——`typedef void(*AccFunc)(const void*, …)` 名字在括号内
 * (adapters typedefName 登记的边界)。dataType 重构为 `ret (*)(params)`;span 由节点偏移
 * 回算原文位置(typedef 体可能多行,name 所在行单独算)。 */
function typedefFnPtrRescue(td: CppNode, text: string): { name: string; dataType: string; line: number; span?: { character: number; length: number } } | undefined {
  const raw = td.text;
  const m = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*(\([^;]*\))\s*;?\s*$/.exec(raw);
  if (!m) return undefined;
  const name = m[1]!;
  const ret = raw.slice(0, m.index).replace(/^typedef\b/, "").replace(/\s+/g, " ").trim();
  if (!ret) return undefined;
  const params = m[2]!.replace(/\s+/g, " ").trim();
  // span 回算:名字在节点文本中的偏移 → 原文绝对偏移 → 行/列
  const nameOffsetInNode = m.index + m[0].indexOf(name);
  const abs = td.startIndex + nameOffsetInNode;
  const lineStart = text.lastIndexOf("\n", abs - 1) + 1;
  const line = td.startPosition.row + 1 + (raw.slice(0, nameOffsetInNode).match(/\n/g) ?? []).length;
  return {
    name,
    dataType: `${ret} (*)${params}`.slice(0, 120),
    line,
    span: { character: abs - lineStart, length: name.length },
  };
}
