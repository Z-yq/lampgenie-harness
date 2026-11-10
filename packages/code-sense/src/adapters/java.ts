/**
 * Java structural adapter( §5 二期, 五期多语言)。
 * 括号深度栈解析(零依赖):提取 class/interface/enum/record 与方法/构造器声明
 * (签名行+行号+参数),方法体内调用边(this.x 同类归属+唯一名兜底,同 python adapter 口径)。
 * tier=structural(如实标注;tree-sitter 升级待后续,接口不变)。
 * RC-A:跨文件候选出口补齐(此前 JavaParseResult 无 crossFileCandidates,
 * 全部锚 callers R=0)——Java 是静态类型语言,类型证据直读:
 * ①字段表(类体内 `Type name =/;` 形态)+②方法参数(signature)+③局部变量(`Type name =`)/
 * 增强 for(String s : list)+④import 名单(静态调用 Cls.method( 形态)+⑤import static 裸名。
 * 接收者链 `a.b.method(` 有类型证据→同文件命中=ast 边,miss=跨文件候选(toName+receiverType),
 * merge 层按 Class.method 候选集解析;无证据不猜(宁缺勿错,precision 纪律)。
 * 同名双闸语义保持:重载组(toJson 九重载)仍诚实弃边不回退。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import { createBraceTracker, splitTopLevel } from "./braces";

export interface JavaSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}
export interface JavaParseResult {
  symbols: JavaSymbol[];
  edges: FlowEdge[];
  /** 解析失败的文件进盲区(同 python adapter)。 */
  failures: { file: string; reason: string }[];
  /** 跨文件调用候选(to="" + toName[,receiverType])——mergeStructAdapters 全图合并后
   * 按「同语言+全图唯一名(+receiverType 收窄)」解析;解析不了=丢弃,与旧版「不发射」等价。 */
  crossFileCandidates?: FlowEdge[];
}

interface OpenBlock {
  kind: "class" | "method";
  name: string;
  sym?: JavaSymbol; // method 专用
  line: number; // 声明行(1-based)
  depth: number; // 声明行处理完的深度
}

const JAVA_MODS =
  "(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|transient|volatile)\\s+)*";
const JAVA_CLASS_RE = new RegExp(`^${JAVA_MODS}(?:class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)`);
const JAVA_METHOD_RE = new RegExp(
  `^${JAVA_MODS}` +
    "(?:<[^>]+>\\s*)?" +
    "([\\w$][\\w$.<>\\[\\],\\s?]*?\\s+)?" + // 返回类型(须以空白结尾)
    "([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)\\s*" +
    "(?:throws\\s+[^{;]+)?" +
    "[;{]", // 声明终止符(单行方法 `{ body }` 的体内文本另行提取; 前此形态整体失配)
);
// 控制流/语句关键字:永不是方法声明(双保险,regex 守卫之外显式排除)
const JAVA_NON_DECL = new Set([
  "if", "for", "while", "switch", "catch", "do", "try", "else", "return", "throw", "new", "finally",
  "class", "interface", "enum", "record", "assert", "break", "continue",
]);
const JAVA_NON_CALL = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "new", "super", "this", "do",
  "System", "Integer", "String", "Long", "Boolean", "Double", "Float", "Math", "Objects", "List", "Map", "Set",
]);
// 原始类型:可作字段/局部类型(基名照记;merge 层无同名 container 自然弃,不产假边)
const JAVA_PRIMITIVES = new Set([
  "int", "long", "short", "byte", "char", "boolean", "float", "double", "void", "var",
]);
// 增强 for 头:`for (Type x : ...)`(泛型/嵌套括号前缀剥不动的复杂形态不猜)
const JAVA_FOR_EACH_RE = /for\s*\(\s*((?:final\s+)?[A-Za-z_$][\w$.]*(?:<[^=;:(]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*:/;

/** 解析单个 Java 文件(纯文本结构,无依赖)。 */
export async function parseJavaFile(root: string, relFile: string): Promise<JavaParseResult> {
  const symbols: JavaSymbol[] = [];
  const edges: FlowEdge[] = [];
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }] };
  }
  const lines = text.split("\n");
  const tracker = createBraceTracker();
  const stripped: string[] = [];
  const openBlocks: OpenBlock[] = [];
  const methodBodies: { sym: JavaSymbol; start: number; end: number; inline?: string }[] = [];
 // RC-A:类型证据(文件级)
  const importedNames = new Set<string>(); // import 末段(静态调用 Cls.method( 的类名证据)
  const classFields = new Map<string, Map<string, string>>(); // 容器类名 → 字段 → 原始类型文本
 // P1:类字段声明行(level=variable 符号导出数据源)
  const fieldDecls: { className: string; name: string; dataType: string; line: number }[] = [];

  const containerOf = (): string | undefined => {
    for (let j = openBlocks.length - 1; j >= 0; j--) {
      if (openBlocks[j]!.kind === "class") return openBlocks[j]!.name;
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const depthBefore = tracker.depth;
    const { code, depth: depthAfter } = tracker.feed(lines[i]!);
    stripped.push(code);
    // 闭块:深度落回声明时以下 → 弹栈(method 记体范围,class 只管容器)
    while (openBlocks.length && depthAfter < openBlocks[openBlocks.length - 1]!.depth) {
      const b = openBlocks.pop()!;
      if (b.kind === "method" && b.sym) {
        methodBodies.push({ sym: b.sym, start: b.line, end: i + 1 });
      }
    }
    const trimmed = code.trim();
    if (!trimmed) continue;
    // 行首注解剥掉再匹配(@Override 与声明同行的形态;纯注解行剥完为空自然失配)
    const probe = trimmed.startsWith("@") ? trimmed.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, "").trim() : trimmed;
    if (!probe) continue;

    // import 名单(RC-A 静态调用证据;wildcard 无具体名不记)
    if (depthBefore === 0) {
      const imp = /^import\s+(?:static\s+)?([\w.]+)\s*;/.exec(probe);
      if (imp) {
        const last = imp[1]!.split(".").pop()!;
        if (last && last !== "*") importedNames.add(last);
        continue;
      }
    }

    // 类/接口/枚举/记录(嵌套也收,容器=最近外层类)
    const clsM = JAVA_CLASS_RE.exec(probe);
    if (clsM) {
      const container = containerOf();
      const name = clsM[1]!;
      const sym: JavaSymbol = {
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind: "class",
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
      };
      symbols.push(sym);
      if (depthAfter > depthBefore) {
        openBlocks.push({ kind: "class", name, line: i + 1, depth: depthAfter });
      }
      continue;
    }

    // 字段声明(仅类体直下:最内层开块=class;方法体内同形态是局部变量,Pass 2 自行收集)
    const top = openBlocks[openBlocks.length - 1];
    if (top?.kind === "class") {
      const fld = recordField(probe, top.name, classFields);
 // P1( §2.2):类字段导出为 variable 符号(零边、不进 byName;
      // dataType=声明类型文本;container=类名)
      if (fld && !fieldDecls.some((x) => x.className === top.name && x.name === fld.name)) {
        fieldDecls.push({ className: top.name, name: fld.name, dataType: fld.typeText, line: i + 1 });
      }
    }

    // 方法/构造器声明(须在某个类体内;修饰符或返回类型至少其一在场,语句调用不冒充声明)
    const container = containerOf();
    if (!container) continue;
    const firstWord = probe.split(/\s/)[0]!;
    if (JAVA_NON_DECL.has(firstWord)) continue;
 // 赋值/初始化语句不冒充声明(`Field f = new F;`/`x = f` 此前被
    // JAVA_METHOD_RE 误登记成同名假方法,污染 byName 唯一名闸——裸名候选通道下即假边)
    const firstParen = probe.indexOf("(");
    const eqIdx = probe.indexOf("=");
    if (firstParen >= 0 && eqIdx >= 0 && eqIdx < firstParen) continue;
    const m = JAVA_METHOD_RE.exec(probe);
    if (m) {
      const typePart = m[1]?.trim();
      const name = m[2]!;
      const paramsRaw = m[3] ?? "";
      const isCtor = !typePart && name === container;
      if (!typePart && !isCtor) continue; // 裸调用语句不冒充声明
      const sym: JavaSymbol = {
        name,
        id: `${relFile}#${container}.${name}`,
        kind: "method",
        file: relFile,
        line: i + 1,
        container,
        signature: javaSignature(paramsRaw, typePart && !isCtor ? typePart.split(/\s+/).pop() : undefined),
      };
      symbols.push(sym);
      if (depthAfter > depthBefore) {
        openBlocks.push({ kind: "method", name, sym, line: i + 1, depth: depthAfter });
      } else {
 // 单行方法体(`public int run { return x; }` 此前整体失配):提取
        // 花括号内文本作为合成体行,Pass 2 照扫
        const tail = probe.slice(m.index + m[0].length);
        if (m[0].endsWith("{") && tail.endsWith("}") && tail.length > 1) {
          methodBodies.push({ sym, start: i, end: i + 1, inline: tail.slice(0, -1) });
        }
      }
    }
  }
 // 文件尾未闭合(语法残缺):在飞方法体按文件尾
  while (openBlocks.length) {
    const b = openBlocks.pop()!;
    if (b.kind === "method" && b.sym) methodBodies.push({ sym: b.sym, start: b.line, end: lines.length });
  }

  // —— Pass 2: 方法体内调用边(this.x 同类归属;唯一名兜底;自环跳过) ——
  const byName = new Map<string, JavaSymbol[]>();
  for (const s of symbols) {
    if (s.kind !== "method") continue;
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  const siblings = (container: string | undefined, name: string): JavaSymbol | undefined =>
    symbols.find((s) => s.kind === "method" && s.container === container && s.name === name);
  const methodOf = (typeName: string, name: string): JavaSymbol | undefined =>
    symbols.find((s) => s.kind === "method" && s.container === typeName && s.name === name);
  const fileClassNames = new Set(symbols.filter((s) => s.kind === "class").map((s) => s.name));

  const crossFileCandidates: FlowEdge[] = [];
  const candSeen = new Set<string>();
  const pushCandidate = (from: string, toName: string, line: number, receiverType?: string): void => {
    const k = `${from}|${toName}|${receiverType ?? ""}`;
    if (candSeen.has(k)) return;
    candSeen.add(k);
    crossFileCandidates.push({
      from, to: "", toName, file: relFile, line,
      tier: "structural", evidenceKind: "inferred",
      ...(receiverType ? { receiverType } : {}),
    });
  };

  for (const body of methodBodies) {
    // 方法体级类型证据:参数(来自 signature)+局部(行序赋值/增强 for)
    const localTypes = new Map<string, string>();
    for (const p of body.sym.signature?.params ?? []) {
      if (p.type) {
        const t = javaBaseType(p.type);
        if (t) localTypes.set(p.name, t);
      }
    }
    const typeOfVar = (name: string): string | undefined => {
      const local = localTypes.get(name);
      if (local) return local;
      // 隐式 this 字段引用(Java 常态 `field.method()` 无前缀):容器类字段表兜底
      if (!body.sym.container) return undefined;
      return javaBaseType(classFields.get(body.sym.container)?.get(name) ?? "");
    };
    const typeOfChain = (chain: string): string | undefined => {
      const segs = chain.split(".");
      let t = typeOfVar(segs[0]!);
      for (let k = 1; k < segs.length && t; k++) {
        const next = classFields.get(t)?.get(segs[k]!);
        t = next ? javaBaseType(next) : undefined;
      }
      return t;
    };
    const scanLines: { code: string; line: number }[] = body.inline !== undefined
      ? [{ code: body.inline, line: body.start + 1 }]
      : [];
    if (body.inline === undefined) {
      for (let i = body.start; i < body.end && i < stripped.length; i++) {
        scanLines.push({ code: stripped[i]!, line: i + 1 });
      }
    }
    for (const { code, line: lineNo } of scanLines) {
      // —— 局部类型证据先行(赋值先于调用的常态序) ——
      collectLocalTypes(code, localTypes, classFields, typeOfVar);
      // 接收者链调用(含 this/链字段/静态形态)
      for (const m of code.matchAll(/([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\.([A-Za-z_$]\w*)\s*\(/g)) {
        const chain = m[1]!;
        const method = m[2]!;
        const head = chain.split(".")[0]!;
        if (head === "this") {
          const target = siblings(body.sym.container, method);
          if (target && target.id !== body.sym.id) {
            edges.push({ from: body.sym.id, to: target.id, toName: method, file: relFile, line: lineNo, tier: "structural", evidenceKind: "ast" });
          } else if (!target && body.sym.container) {
            // 同类找不到:跨文件同类方法/父类方法——候选带容器证据(merge 层解析)
            pushCandidate(body.sym.id, method, lineNo, body.sym.container);
          }
          continue;
        }
        if (JAVA_NON_CALL.has(head)) continue; // System.out.println 等标准库接收者
        const type = typeOfChain(chain);
        if (type) {
          const target = methodOf(type, method);
          if (target && target.id !== body.sym.id) {
            edges.push({ from: body.sym.id, to: target.id, toName: method, file: relFile, line: lineNo, tier: "structural", evidenceKind: "ast" });
          } else if (!target) {
            pushCandidate(body.sym.id, method, lineNo, type);
          }
          continue; // target 即自身:自环跳过
        }
 // 无类型证据:仅静态形态 Cls.method(发候选(Cls=本文件类 ∪ import 名单;
        // 未知变量接收者不猜——宁缺勿错)
        if (chain === head && (fileClassNames.has(head) || importedNames.has(head))) {
          pushCandidate(body.sym.id, method, lineNo, head);
        }
      }
      // 全文件唯一名方法调用
      for (const m of code.matchAll(/(?<![\w.])([A-Za-z_$]\w*)\s*\(/g)) {
        const callee = m[1]!;
        if (JAVA_NON_CALL.has(callee)) continue;
        const cands = byName.get(callee) ?? [];
        if (cands.length !== 1) {
          // 同文件解析不到:发跨文件候选(同包调用无 import 是 Java 常态;import static 同通道)
          // merge 层按全图唯一名解析;解析不了=丢弃,与旧版「不发射」等价(不猜)
          if (cands.length === 0) {
            pushCandidate(body.sym.id, callee, lineNo);
          }
          continue; // 多候选/未知:不猜(诚实,同 python)
        }
        if (cands[0]!.id === body.sym.id) continue;
        edges.push({ from: body.sym.id, to: cands[0]!.id, toName: callee, file: relFile, line: lineNo, tier: "structural", evidenceKind: "ast" });
      }
    }
  }
  const seen = new Set<string>();
  const dedup = edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.toName}|${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
 // P1:类字段 → variable 符号(零边;不进 byName 由 engine merge 层纪律承担)
  for (const f of fieldDecls) {
    symbols.push({
      name: f.name,
      id: `${relFile}#${f.className}.${f.name}`,
      kind: "variable",
      file: relFile,
      line: f.line,
      container: f.className,
      dataType: f.dataType,
    });
  }
  return { symbols, edges: dedup, failures: [], crossFileCandidates };
}

/** 类型文本 → 基名:`Map<String, Foo>`→Map;`com.foo.Bar`→Bar;`Bar[]`→Bar;原始类型照记。 */
function javaBaseType(t: string): string | undefined {
  let s = t.trim();
  while (s.endsWith("[]")) s = s.slice(0, -2).trim();
  s = s.replace(/<.*>/g, "").trim(); // 泛型段剥除(嵌套通吃:文本级证据,不判型参)
  s = s.replace(/^final\s+/, "");
  const first = s.split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/.test(first)) return undefined;
  const bare = first.includes(".") ? first.slice(first.lastIndexOf(".") + 1) : first;
  return /^[A-Za-z_$][\w$]*$/.test(bare) ? bare : undefined;
}

/** 类体字段行:`private final Repo repo;` / `Map<String, Foo> cache = ...;`——修饰符可选,
 * 类型首 token 大写或原始类型;方法声明(name 后跟 `(`)天然失配。 */
/** P1:recordField 返回提取信息(name+typeText),调用方同时登记 variable 符号。 */
function recordField(probe: string, className: string, out: Map<string, Map<string, string>>): { name: string; typeText: string } | null {
  if (!/[;=]$/.test(probe) && !/[;=]\s*$/.test(probe)) return null; // 字段行以 ; 收尾或 = 续行
  if (/[{}]/.test(probe)) return null; // 数组初始化/匿名类:保守不判
  // 修饰符全剥(单条正则 * 量词;^+/g 只剥第一个——"final" 残留会破坏类型判定)
  const noMods = probe.replace(/^(?:(?:public|protected|private|static|final|transient|volatile)\s+)*/, "").trim();
 // 初始化器剥除( P1:`String host = "localhost";` 的串字面量会破坏「末 token=名字」;
  // 取 = 前段——数组初始化 `int[] a = {1,2};` 同型)
  const noInit = noMods.split("=")[0]!.trim();
  const toks = noInit.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return null;
  const name = toks[toks.length - 1]!.replace(/;$/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const typeText = toks.slice(0, -1).join(" ");
  const first = typeText.split(/[<\s]/)[0] ?? "";
  if (!/^[A-Z]/.test(first) && !JAVA_PRIMITIVES.has(first)) return null; // 类型首 token 须类型形态
  if (JAVA_NON_DECL.has(name) || JAVA_NON_CALL.has(name)) return null;
  const m = out.get(className) ?? new Map<string, string>();
  if (!m.has(name)) m.set(name, typeText); // 首写赢
  out.set(className, m);
  return { name, typeText };
}

/** 方法体内局部类型:`Type name = ...` / `final Type name = ...`;增强 for 头另行提取。 */
function collectLocalTypes(
  code: string,
  localTypes: Map<string, string>,
  fields: Map<string, Map<string, string>>,
  typeOfVar: (name: string) => string | undefined): void {
  const fe = JAVA_FOR_EACH_RE.exec(code);
  if (fe) {
    const t = javaBaseType(fe[1]!);
    if (t && !localTypes.has(fe[2]!)) localTypes.set(fe[2]!, t);
  }
  // 局部声明:`Type name =` / `final Type name =`(行内含 `{` 的匿名类初始化保守不判)
  const decl = /(?:^[ \t]*|[;{]\s*)(?:final\s+)?([A-Za-z_$][\w$]*(?:<[^=;]*?>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*=[^=]/.exec(code);
  if (decl && !localTypes.has(decl[2]!) && !/[{}]/.test(decl[1]!)) {
    const t = javaBaseType(decl[1]!);
    if (t && !JAVA_PRIMITIVES.has(t) && !JAVA_NON_CALL.has(t)) localTypes.set(decl[2]!, t);
  }
  // 选择器链拷贝:name = a.b.c(字段类型走表)
  const sel = /(?:^[ \t]*|[;{]\s*)(?:final\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$]\w*)+)\s*;?\s*$/.exec(code);
  if (sel && !localTypes.has(sel[1]!)) {
    const segs = sel[2]!.split(".");
    let t = typeOfVar(segs[0]!);
    for (let k = 1; k < segs.length && t; k++) {
      const next = fields.get(t)?.get(segs[k]!);
      t = next ? javaBaseType(next) : undefined;
    }
    if (t) localTypes.set(sel[1]!, t);
  }
}

/** Java 参数(Type name 顺序,与 Go 相反);返回类型取自声明行返回类型尾 token。 */
function javaSignature(paramsRaw: string, returnType?: string): Signature {
  const params = splitTopLevel(paramsRaw).map((p) => {
    const toks = p.split(/\s+/).filter(Boolean);
    if (toks.length >= 2) {
      // 变参 String... args:type 含 "..."
      return { name: toks[toks.length - 1]!, type: toks.slice(0, -1).join(" ").slice(0, 120) };
    }
    return { name: toks[0] ?? "_" };
  });
  return { params, ...(returnType ? { returnType: returnType.slice(0, 120) } : {}) };
}
