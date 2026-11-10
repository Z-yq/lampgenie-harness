/**
 * Go structural adapter(designs/16 §5 二期,step-021 五期多语言)。
 * 括号深度栈解析(零依赖):提取包级 func/type/struct/interface/方法 声明
 * (签名行+行号+参数),函数体内调用边(接收者归属+唯一名兜底,同 python adapter 口径)。
 * tier=structural(如实标注;tree-sitter 升级待后续,接口不变)。
 *
 * step-084 RC-A(2026-10-16):接收者/包限定调用恢复跨文件候选——
 * ①包限定 `pkg.Func(`(pkg∈import 绑定)发候选(toName=Func);②接收者/局部变量类型证据
 * (接收者、struct 字段表、`x := &T{}`、参数类型、`x := f()` 同文件单返回值、`x := a.b`
 * 选择器链、range 元素类型)→链形态 `a.b.Method(` 逐段走字段表,同文件命中=ast 边,
 * miss=跨文件候选(to=""+toName+receiverType),merge 层按 Class.method 候选集解析。
 * 同名双闸语义保持:多候选=诚实弃边不回退(RC-F 原样;无类型证据的接收者调用不猜——
 * 宁缺勿错,precision=1.0 纪律)。
 *
 * step-102(2026-10-16,094 白名单重落地+interface/struct 注册区分):
 * ①自仓 import 前缀白名单(094 存档复用)——被测仓 go.mod `module` 前缀下的 import 绑定
 * (路径==module 或 module/ 开头)是仓内包:`pkg.T` 限定类型(字段/字面量/参数/返回值/var
 * 五通道)解析为仓内类型名 T(与本地类型同权,激活 receiverType 证据链;grpc-go 生成代码
 * `cc *grpc.ClientConn` + `c.cc.Invoke(` 实形态)。module 外部绑定(protobuf 等)照旧
 * 「外部类型不猜」;无 go.mod=白名单关闭,行为与 step-084 一致。
 * ②`type X struct {}` / `type X interface {}` 注册 typeKind 区分(schema 加性字段)——
 * 094 精度门假边归因:仓内接口 balancer.Balancer 与实现体 gracefulswitch.Balancer 撞名,
 * receiverType 窄化被「唯一命中」;engine resolveStructCrossFile 撞名闸消费 typeKind,
 * 接口名 receiverType 不再窄化到实现体方法(如实弃边+台账)。
 * 类型身份锚定=本文件 import 绑定表(绑定→完整路径),限定名归属跨文件不可改变;
 * 已知残险=多个自仓包定义同名类型时 receiverType 撞名(宁缺勿错闸仍在:多候选弃边)。
 *
 * step-108(2026-10-16,grpc-go Invoke 生成代码接收者解析,诚实边界突破):
 * 接口断言定向解析——**仅生成代码文件**(package 子句前有标准标记
 * `// Code generated ... DO NOT EDIT.`):候选 receiverType=R 且证据目录 dir 内存在
 * **唯一**编译期断言 `var _ R = (*T)(nil)`(家族形态含 `&T{}`/`T{}`/`new(T)`)时,
 * 候选改指实现体 T(grpc-go 生成代码 `cc grpc.ClientConnInterface`+clientconn.go 断言
 * 实形态;断言是编译器背书的实现声明,生成 client 的接口参数是生态契约接缝——grpc-go
 * 文档明言该接口 "is only intended to be referenced by generated code")。**手写代码不启用**:
 * 「唯一断言实现」在手写代码不蕴含「典范实现」(grpc-go mem.BufferPool 实证:5 个实现体,
 * 断言的 NopBufferPool 只是哨兵默认,逐点 may-call 不可证)。0 断言(现状)/≥2 断言(歧义)/
 * 断言在他包目录/断言仅见于 _test.go(测试替身防护,cobra completions_test 实形态)一律
 * 不改写,旧行为逐位保留。泛型/限定名接口断言不识别(边界登记);engine 撞名闸对实现体名
 * 不拦截(目录钉扎)。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Symbol, FlowEdge, Signature } from "../callgraph/engine";
import { createBraceTracker, splitTopLevel } from "./braces";

export interface GoSymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}
export interface GoParseResult {
  symbols: GoSymbol[];
  edges: FlowEdge[];
  /** 解析失败的文件进盲区(同 python adapter)。 */
  failures: { file: string; reason: string }[];
  /** 同文件解析不到的裸调用候选(to="" + toName)——Go 同包跨文件调用无需 import,
   * 由 mergeStructAdapters 全图合并后按「同语言+全图唯一名」解析(open-code-review 实证:
   * 368 个 go 文件只做同文件解析,65% 符号被误标 trunk/无人调用)。 */
  crossFileCandidates?: FlowEdge[];
  /** step-099 RC-B2:本文件 import 路径清单(原始形态,去重;含标准库——仓内/外判定归
   * 构建侧 expandGoImports 的 go.mod 锚)。impact import 通道的 Go 数据源。 */
  imports?: string[];
}

interface Recv {
  varName: string;
  typeName: string;
}
interface FuncHeader {
  recv?: Recv;
  name: string;
  paramsRaw?: string;
  returnType?: string;
}
interface OpenBlock {
  kind: "func" | "struct";
  sym?: GoSymbol; // func 专用
  name?: string; // struct 专用
  line: number; // 声明行(1-based)
  depth: number; // 声明行处理完的深度(体内行 depth>=此值)
  recv?: Recv;
}
type FuncBodyRec = { sym: GoSymbol; start: number; end: number; recv?: Recv; inline?: string };

// 语言保留字/内置函数:不算调用目标(同 python 口径的排除表)
const GO_NON_CALL = new Set([
  "if", "for", "range", "switch", "return", "go", "defer", "func", "select", "var", "const", "type",
  "len", "cap", "make", "new", "append", "panic", "recover", "close", "delete", "copy", "print", "println",
]);
// 内建类型(转换目标/类型证据终点;不产假边——merge 层无同名 container 自然弃)
const GO_BUILTIN_TYPES = new Set([
  "string", "bool", "byte", "rune", "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64",
  "complex64", "complex128", "error", "any",
]);

// step-102(094 存档复用):被测仓 go.mod module 路径缓存(root→module;""=无 go.mod/未识别=白名单关闭)
const selfModuleCache = new Map<string, string>();
async function selfModulePath(root: string): Promise<string> {
  const hit = selfModuleCache.get(root);
  if (hit !== undefined) return hit;
  let mod = "";
  try {
    const text = await readFile(join(root, "go.mod"), "utf-8");
    const m = /^\s*module\s+(\S+)\s*$/m.exec(text);
    if (m) mod = m[1]!;
  } catch {
    // 无 go.mod(非法 Go 仓/测试夹具):白名单关闭,行为与 step-084 一致
  }
  selfModuleCache.set(root, mod);
  return mod;
}

/** step-102(094 存档复用):类型文本经自仓白名单解析——剥 `*`/`[]`/`...`/泛型实例化后,
 * 若首段是 `pkg.T` 且 pkg∈自仓绑定 → T(仓内包类型,与本地类型同权);其余(含外部包限定)
 * 走 baseType(外部类型不猜纪律不变)。 */
function qualBase(t: string, selfPkgs: Map<string, string>): string | undefined {
  if (selfPkgs.size > 0) {
    let s = t.trim().replace(/^\.\.\./, "");
    while (s.startsWith("*") || s.startsWith("[]") || s.startsWith("[ ")) s = s.slice(s.startsWith("[]") ? 2 : 1).trim();
    s = s.replace(/\[[^\]]*\]\s*$/, "").trim();
    const qm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(s.split(/[\s(]/)[0] ?? "");
    if (qm && selfPkgs.has(qm[1]!)) return qm[2]!;
  }
  return baseType(t);
}

/** step-108:断言右值 → 裸实现名:`(*T)(nil)` / `&T{}` / `T{}` / `new(T)`;
 * 泛型实例化/包限定/函数值等其它形态=不识别(边界,不猜)。 */
function assertionImpl(rhs: string): string | undefined {
  const s = rhs.trim().replace(/;+\s*$/, "").trim();
  let m = /^\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(\s*nil\s*\)$/.exec(s);
  if (m) return m[1]!;
  m = /^&\s*([A-Za-z_]\w*)\s*\{\s*\}$/.exec(s);
  if (m) return m[1]!;
  m = /^new\s*\(\s*([A-Za-z_]\w*)\s*\)$/.exec(s);
  if (m) return m[1]!;
  m = /^([A-Za-z_]\w*)\s*\{\s*\}$/.exec(s);
  return m ? m[1]! : undefined;
}

/** step-108:接口断言表(root→dir→iface→Set<impl>;进程级缓存同 selfModuleCache 先例——
 * 增量索引对「断言文件变更而调用文件未变」不感知,全量 --reindex 是正确路径)。
 * 懒构建:首个带 receiverType 的未解析候选触发其证据目录一次扫描(仅该目录 *.go、
 * **排除 _test.go**——测试替身不得成为典范实现);扫描失败=空表=不改写(fail-safe)。
 * Promise 缓存防并发重复扫描。 */
const ifaceAssertCache = new Map<string, Map<string, Promise<Map<string, Set<string>>>>>();
async function scanDirAssertions(root: string, dir: string): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  let names: string[];
  try {
    names = await readdir(join(root, dir));
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith(".go") || n.endsWith("_test.go")) continue;
    let text: string;
    try {
      text = await readFile(join(root, dir, n), "utf-8");
    } catch {
      continue; // 单文件读失败=跳过(断言面欠收,fail-safe)
    }
    const tracker = createBraceTracker();
    for (const line of text.split("\n")) {
      const depthBefore = tracker.depth;
      const { code } = tracker.feed(line);
      if (depthBefore !== 0) continue; // 断言只在顶层(var 块内层行:paren 不计深度,仍 depth 0)
      const t = code.trim();
      const m = /^var\s+_\s+([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(t) ?? /^_\s+([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(t);
      if (!m) continue;
      const impl = assertionImpl(m[2]!);
      if (!impl) continue;
      const set = out.get(m[1]!) ?? new Set<string>();
      set.add(impl);
      out.set(m[1]!, set);
    }
  }
  return out;
}
/** 接口断言定向:name 在 dir 包内「有且仅有一个断言实现体」时返回实现名;否则 undefined。 */
async function assertedImpl(root: string, name: string, dir: string): Promise<string | undefined> {
  let perRoot = ifaceAssertCache.get(root);
  if (!perRoot) {
    perRoot = new Map();
    ifaceAssertCache.set(root, perRoot);
  }
  let p = perRoot.get(dir);
  if (!p) {
    p = scanDirAssertions(root, dir).catch(() => new Map<string, Set<string>>());
    perRoot.set(dir, p);
  }
  const set = (await p).get(name);
  return set && set.size === 1 ? [...set][0]! : undefined;
}

/** 解析单个 Go 文件(纯文本结构,无依赖)。 */
export async function parseGoFile(root: string, relFile: string): Promise<GoParseResult> {
  const symbols: GoSymbol[] = [];
  const edges: FlowEdge[] = [];
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }] };
  }
  const lines = text.split("\n");
  const relDir = relFile.includes("/") ? relFile.slice(0, relFile.lastIndexOf("/")) : "";
  // step-102(094 复用):自仓 module 前缀(白名单判据;无 go.mod=空=关闭)
  const modPrefix = await selfModulePath(root);
  // step-108:生成代码判定(Go 约定:标记行必须在 package 子句前的注释区)——
  // 接口断言定向只在生成代码启用(生成 client 的接口参数是生态契约接缝;手写代码不启用,
  // 「唯一断言实现」在手写代码不蕴含「典范实现」,mem.BufferPool 5 实现体实证)。
  let isGeneratedCode = false;
  for (const l of lines) {
    if (/^\s*package\s/.test(l)) break;
    if (/\/\/ Code generated .* DO NOT EDIT\.?\s*$/.test(l)) { isGeneratedCode = true; break; }
  }
  const tracker = createBraceTracker();
  const stripped: string[] = []; // 与 lines 平行:剥离字符串/注释后的代码(调 call 边复用)
  const openBlocks: OpenBlock[] = [];
  const funcBodies: FuncBodyRec[] = [];
  // step-084 RC-A:类型证据收集(文件级)
  const importBindings = new Map<string, string>(); // 绑定名(别名∨路径末段)→ 完整 import 路径
  const structFields = new Map<string, Map<string, string>>(); // 类型名 → 字段 → 完整类型文本
  const rawPkgVars: { name: string; expr?: string; typeText?: string; line: number }[] = []; // 包级 var/const(表达式 Pass 2 再解析:被调函数可能在本文件后部)
  let inImportBlock = false;
  let inVarBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const depthBefore = tracker.depth;
    const { code, depth: depthAfter } = tracker.feed(lines[i]!);
    stripped.push(code);
    const inBody = depthBefore > 0; // 起始时在某个 func 体内:只做闭块判断,不再识别声明
    if (inBody) {
      while (openBlocks.length && depthAfter < openBlocks[openBlocks.length - 1]!.depth) {
        const b = openBlocks.pop()!;
        if (b.kind === "func") funcBodies.push({ sym: b.sym!, start: b.line, end: i + 1, recv: b.recv });
      }
      // struct 块内:字段行类型登记(RC-A 选择器链/range 元素类型证据)
      const top = openBlocks[openBlocks.length - 1];
      if (top?.kind === "struct" && top.name && code.trim()) {
        recordStructField(code.trim(), top.name, structFields);
      }
      continue;
    }
    // —— 包级声明识别(剥码后匹配,字符串/注释里的关键字天然失配) ——
    const tcode = code.trim();
    // import 块(inner 行/闭合)——先于一切声明识别(块内不该有 func);
    // 路径是字符串字面量会被剥码——登记必须用原始行(lines[i])
    if (inImportBlock) {
      if (/^\)\s*$/.test(tcode)) inImportBlock = false;
      else recordImportLine(lines[i]!.trim(), importBindings);
      continue;
    }
    if (inVarBlock) {
      if (/^\)\s*$/.test(tcode)) { inVarBlock = false; continue; }
      recordVarLine(tcode, rawPkgVars, false, i + 1);
      continue;
    }
    if (!tcode) continue;
    // import 行的路径是字符串字面量会被剥码+trim 吃掉(剥码后常只剩裸 "import")——
    // 判定用 \b 词边界,路径提取用原始行
    if (/^import\s*\($/.test(tcode)) { inImportBlock = true; continue; }
    if (/^import\b/.test(tcode) && !inVarBlock && !/^import\b\s*\(/.test(tcode)) {
      recordImportLine(lines[i]!.trim().replace(/^import\s+/, ""), importBindings);
      continue;
    }
    if (/^var\s*\($/.test(tcode)) { inVarBlock = true; continue; }
    if (/^var\s+/.test(tcode)) { recordVarLine(tcode.replace(/^var\s+/, ""), rawPkgVars, true, i + 1); continue; }
    // step-089 P1:const 声明与 var 同形态(`const x T = v` / `const ( ... )`)——
    // 显式类型项入 variable 导出;`const x = v` 无类型=expr 桶(不入索引导出)
    if (/^const\s*\($/.test(tcode)) { inVarBlock = true; continue; }
    if (/^const\s+/.test(tcode)) { recordVarLine(tcode.replace(/^const\s+/, ""), rawPkgVars, true, i + 1); continue; }
    const funcM = /^func\s+/.exec(tcode);
    if (funcM) {
      const header = parseFuncHeader(tcode);
      if (header) {
        const sym: GoSymbol = {
          name: header.name,
          id: `${relFile}#${header.recv ? header.recv.typeName + "." : ""}${header.name}`,
          kind: header.recv ? "method" : "function",
          file: relFile,
          line: i + 1,
          ...(header.recv ? { container: header.recv.typeName } : {}),
          ...(header.paramsRaw !== undefined || header.returnType !== undefined
            ? { signature: goSignature(header) }
            : {}),
        };
        symbols.push(sym);
        // 净深度上抬=开了函数体(单行函数 func f() {} 上抬为零,无需记块)
        if (depthAfter > depthBefore) {
          openBlocks.push({ kind: "func", sym, line: i + 1, depth: depthAfter, recv: header.recv });
        } else {
          // 单行函数体(step-084:Go 测试高频形态 func f() { x.Stop() }):提取花括号
          // 内文本作为合成体行,Pass 2 照扫(此前整函数体不可达=调用边全丢)
          const open = tcode.indexOf("{");
          const close = tcode.lastIndexOf("}");
          if (open >= 0 && close > open + 1) {
            funcBodies.push({ sym, start: i, end: i + 1, recv: header.recv, inline: tcode.slice(open + 1, close) });
          }
        }
      }
      continue;
    }
    const typeM = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+(struct|interface)\s*\{/.exec(tcode);
    if (typeM) {
      symbols.push({
        name: typeM[1]!,
        id: `${relFile}#${typeM[1]}`,
        kind: "class",
        file: relFile,
        line: i + 1,
        // step-102:interface/struct 注册区分(engine 撞名闸消费;别名不设=未知)
        typeKind: typeM[2] === "interface" ? "interface" : "struct",
      });
      // struct 块内收集字段类型(RC-A 选择器链证据);interface 块不产字段
      if (typeM[2] === "struct" && depthAfter > depthBefore) {
        openBlocks.push({ kind: "struct", name: typeM[1], line: i + 1, depth: depthAfter });
      }
      continue; // struct/interface 块内不是函数体,深度栈自然压制体内误识别
    }
    // 类型别名/命名类型(type MyInt int / type Foo = Bar):也如实登记(kind 联合里最近为 class)
    const aliasM = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+\S/.exec(tcode);
    if (aliasM) {
      symbols.push({
        name: aliasM[1]!,
        id: `${relFile}#${aliasM[1]}`,
        kind: "class",
        file: relFile,
        line: i + 1,
      });
    }
  }
  // 文件尾未闭合(语法残缺):在飞块按文件尾收口,符号保留(诚实:行号真实)
  while (openBlocks.length) {
    const b = openBlocks.pop()!;
    if (b.kind === "func") funcBodies.push({ sym: b.sym!, start: b.line, end: lines.length, recv: b.recv });
  }

  // step-102(094 复用):自仓 import 前缀白名单——import 绑定表(Pass 1 已收齐)按 module
  // 前缀分类;仓内包:绑定→仓内相对目录(根包="");随后 struct 字段表的限定类型归一化
  const selfPkgs = new Map<string, string>();
  // step-102:证据目录钉扎(撞名闸用)——目录随证据逐项携带,不按类型名全局映射
  // (clientconn_test.go 实证:同文件裸名 *ClientConn(根包结构体)与 balancer.ClientConn
  // (他包接口)并存,名级映射会把接口目录错钉到裸名证据上误杀真边)。
  // 约定:证据类型文本为限定形态 pkg.T 且 pkg∈自仓 → 目录=selfPkgs[pkg];否则=relDir(裸名=同包)。
  const dirOfTypeText = (text: string): string => {
    let s = text.trim().replace(/^\.\.\./, "").replace(/^&/, "").trim();
    while (s.startsWith("*") || s.startsWith("[]") || s.startsWith("[ ")) s = s.slice(s.startsWith("[]") ? 2 : 1).trim();
    s = s.replace(/\[[^\]]*\]\s*$/, "").trim();
    const qm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(s.split(/[\s(]/)[0] ?? "");
    if (qm && selfPkgs.has(qm[1]!)) return selfPkgs.get(qm[1]!)!;
    return relDir;
  };
  const structFieldDirs = new Map<string, Map<string, string>>(); // 类型名 → 字段 → 证据目录(仅白名单限定项)
  if (modPrefix) {
    for (const [binding, path] of importBindings) {
      if (path === modPrefix) selfPkgs.set(binding, "");
      else if (path.startsWith(modPrefix + "/")) selfPkgs.set(binding, path.slice(modPrefix.length + 1));
    }
    if (selfPkgs.size > 0) {
      for (const [tn, fields] of structFields) {
        for (const [fld, t] of fields) {
          const q = qualBase(t, selfPkgs);
          if (q && q !== t) {
            fields.set(fld, q);
            // 归一化生效=原文本是白名单限定形态:登记证据目录
            const dm = structFieldDirs.get(tn) ?? new Map<string, string>();
            dm.set(fld, dirOfTypeText(t));
            structFieldDirs.set(tn, dm);
          }
        }
      }
    }
  }

  // —— Pass 2: 函数体内调用边(接收者方法优先;唯一名兜底;自环跳过) ——
  const funcsByName = new Map<string, GoSymbol[]>();
  const callablesByName = new Map<string, GoSymbol[]>(); // 函数+方法(返回值类型证据用)
  const typeNames = new Set<string>();
  for (const s of symbols) {
    if (s.kind === "function") funcsByName.set(s.name, [...(funcsByName.get(s.name) ?? []), s]);
    if (s.kind === "function" || s.kind === "method") {
      callablesByName.set(s.name, [...(callablesByName.get(s.name) ?? []), s]);
    }
    if (s.kind === "class") typeNames.add(s.name);
  }
  const methodsOf = (typeName: string, name: string): GoSymbol | undefined =>
    symbols.find((s) => s.kind === "method" && s.container === typeName && s.name === name);

  // 包级 var 类型解析(被调可能在本文件后部,Pass 1 后统一解)
  const fileVarTypes = new Map<string, string>();
  const fileVarTypeDirs = new Map<string, string>(); // step-102:证据目录(随 var 逐项)
  for (const v of rawPkgVars) {
    const t = v.typeText ? qualBase(v.typeText, selfPkgs) : v.expr ? exprType(v.expr, typeNames, callablesByName, selfPkgs) : undefined;
    if (t) {
      fileVarTypes.set(v.name, t);
      // 显式类型文本/字面量可定目录;表达式推断(`f()` 返回值)证据粒度不足=relDir 兜底(如实)
      fileVarTypeDirs.set(v.name, v.typeText ? dirOfTypeText(v.typeText) : dirOfTypeText(v.expr ?? ""));
    }
  }
  // step-089 P1:包级 var/const 显式类型项导出为 variable 符号(零边;engine merge 层
  // variable 不进 byName——调用解析语义不吸收变量名)。expr 推断项不入索引(typed/ 档再做)。
  {
    const seenVars = new Set<string>();
    for (const v of rawPkgVars) {
      if (!v.typeText || seenVars.has(v.name)) continue;
      seenVars.add(v.name);
      symbols.push({ name: v.name, id: `${relFile}#${v.name}`, kind: "variable", file: relFile, line: v.line, dataType: v.typeText });
    }
  }

  const crossFileCandidates: FlowEdge[] = [];
  const candSeen = new Set<string>();
  const pushCandidate = (from: string, toName: string, line: number, evidence: string): void => {
    const k = `${from}|${toName}|${evidence}`;
    if (candSeen.has(k)) return;
    candSeen.add(k);
    crossFileCandidates.push({ from, to: "", toName, file: relFile, line, tier: "structural", evidenceKind: "inferred" });
  };
  for (const body of funcBodies) {
    // 函数体级类型证据:参数(来自 signature)+局部(行序赋值)
    const localTypes = new Map<string, string>();
    const localTypeDirs = new Map<string, string>(); // step-102:证据目录(随变量逐项)
    for (const p of body.sym.signature?.params ?? []) {
      if (p.type) {
        const t = qualBase(p.type, selfPkgs);
        if (t) {
          localTypes.set(p.name, t);
          localTypeDirs.set(p.name, dirOfTypeText(p.type));
        }
      }
    }
    // step-102:证据目录解析——接收者基类型恒同包(Go 规则);局部/包级变量逐项登记;
    // 链尾段取字段声明的证据目录(字段声明在本文件:裸名=relDir,白名单限定=登记目录)。
    const typeDirOfVar = (name: string): string =>
      (body.recv && name === body.recv.varName ? relDir : undefined)
      ?? localTypeDirs.get(name) ?? fileVarTypeDirs.get(name) ?? relDir;
    const typeOfVar = (name: string): string | undefined =>
      (body.recv && name === body.recv.varName ? body.recv.typeName : undefined)
      ?? localTypes.get(name) ?? fileVarTypes.get(name);
    /** 链类型解析:a.b.c → 头段类型逐段走 structFields(嵌入/字段);返回类型名+证据目录。 */
    const typeOfChain = (chain: string): { t?: string; dir: string } => {
      const segs = chain.split(".");
      let t = typeOfVar(segs[0]!);
      let dir = typeDirOfVar(segs[0]!);
      for (let k = 1; k < segs.length && t; k++) {
        const next = structFields.get(t)?.get(segs[k]!);
        dir = next ? (structFieldDirs.get(t)?.get(segs[k]!) ?? relDir) : dir;
        t = next ? baseType(next) : undefined;
      }
      return { t, dir };
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
      // —— 局部类型证据先行(赋值先于调用的常态序;同行的调用在下轮 regex 里已能读到) ——
      collectLocalTypes(code, localTypes, localTypeDirs, typeNames, callablesByName, structFields, structFieldDirs, typeOfVar, typeDirOfVar, dirOfTypeText, selfPkgs);
      // range 元素类型:for _, h := range s.handlers → h:Handler(高频形态)
      const rng = /\bfor\s+([A-Za-z_]\w*)?(?:\s*,\s*([A-Za-z_]\w*))?\s*(?::=|=)\s*range\s+([\w.]+)/.exec(code);
      if (rng) {
        const valVar = rng[2] ?? rng[1]; // k,v 形态取 v;单值取它
        if (valVar && !localTypes.has(valVar)) {
          const rc = typeOfChain(rng[3]!);
          if (rc.t) {
            const elem = elementType(rc.t);
            if (elem) {
              localTypes.set(valVar, elem);
              localTypeDirs.set(valVar, rc.dir); // 元素类型与容器同包证据
            }
          }
        }
      }
      // 接收者/类型证据调用(链形态):a.b.Method( → 逐段解析,同文件命中=ast 边,
      // miss=跨文件候选(receiverType 证据,merge 层 Class.method 候选集解析)
      for (const m of code.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)\s*\(/g)) {
        const chain = m[1]!;
        const method = m[2]!;
        const head = chain.split(".")[0]!;
        const { t: type, dir: typeDir } = typeOfChain(chain);
        if (type) {
          const target = methodsOf(type, method);
          if (target && target.id !== body.sym.id) {
            edges.push({ from: body.sym.id, to: target.id, toName: method, file: relFile, line: lineNo, tier: "structural", evidenceKind: "ast" });
            continue;
          }
          if (!target) {
            // 同文件无此方法:发候选(接收者类型证据,宁缺勿错不回退)
            // step-108:接口断言定向(仅生成代码)——receiverType 为接口且其包内编译期断言
            // 实现唯一时,候选改指实现体(grpc-go 生成代码 `cc grpc.ClientConnInterface` +
            // `var _ ClientConnInterface = (*ClientConn)(nil)` 实形态);0/多断言/跨目录/
            // 测试替身断言/手写文件不改写。类型证据表不改写(证据保真,只作用于调用目标解析)。
            const impl = isGeneratedCode ? await assertedImpl(root, type, typeDir) : undefined;
            const effType = impl ?? type;
            const k = `${body.sym.id}|${method}|${effType}`;
            if (!candSeen.has(k)) {
              candSeen.add(k);
              // step-102:候选带证据包目录(engine 撞名闸:接口与实现体撞名时按目录判定)
              crossFileCandidates.push({ from: body.sym.id, to: "", toName: method, file: relFile, line: lineNo, tier: "structural", evidenceKind: "inferred", receiverType: effType, receiverTypeDir: typeDir });
            }
            continue;
          }
          continue; // target 即自身:自环跳过
        }
        // 无类型证据:仅当头段是 import 绑定(包限定调用 pkg.Func(,RC-A 主形态)才发候选;
        // 局部变量阴影优先于包名(Go 作用域),类型证据在则不走 import 通道
        if (chain === head && importBindings.has(head)
          && !(body.recv && head === body.recv.varName) && !localTypes.has(head) && !fileVarTypes.has(head)) {
          pushCandidate(body.sym.id, method, lineNo, `pkg:${head}`);
        }
      }
      // 包级函数唯一名调用
      for (const m of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\(/g)) {
        const callee = m[1]!;
        if (GO_NON_CALL.has(callee)) continue;
        const cands = funcsByName.get(callee) ?? [];
        if (cands.length !== 1) {
          // 同文件解析不到的裸调用(Go 同包跨文件无需 import):发跨文件候选,
          // merge 层按全图唯一名解析;解析不了=丢弃,与旧版「不发射」等价(不猜)
          if (cands.length === 0) {
            const k = `${body.sym.id}|${callee}`;
            if (!candSeen.has(k)) {
              candSeen.add(k);
              crossFileCandidates.push({ from: body.sym.id, to: "", toName: callee, file: relFile, line: lineNo, tier: "structural", evidenceKind: "inferred" });
            }
          }
          continue; // 多候选/未知:不猜(诚实,同 python)
        }
        if (cands[0]!.id === body.sym.id) continue; // 自环保留语义与 python 一致:跳过
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
  // step-099 RC-B2:import 路径清单落结果(绑定名映射的值集去重;`.` 绑定是 dot-import,
  // 其路径同样是真实 import 语义,保留)
  const importPaths = [...new Set(importBindings.values())];
  return { symbols, edges: dedup, failures: [], crossFileCandidates, ...(importPaths.length > 0 ? { imports: importPaths } : {}) };
}

/** import 行登记:`"p/x/y"` / `alias "p/x/y"` / `_ "p"` / `. "p"`(点导入不记绑定)。 */
function recordImportLine(line: string, out: Map<string, string>): void {
  const m = /^(?:([A-Za-z_]\w*)\s+)?"([^"]+)"/.exec(line.trim());
  if (!m) return;
  const path = m[2]!;
  const binding = m[1] ?? path.split("/").pop() ?? "";
  if (!binding || binding === "_") return;
  out.set(binding, path);
}

/** var 行登记(inner 形态):`x = expr` / `x Type` / `x Type = expr` / `x, y = ...`(多名列不猜)。 */
function recordVarLine(line: string, out: { name: string; expr?: string; typeText?: string; line: number }[], hasKw: boolean, lineNo: number): void {
  const s = line.trim();
  if (!hasKw && /^var\s+/.test(s)) return; // 块内不该再出现 var(防御)
  if (/^[A-Za-z_]\w*(\s*,\s*[A-Za-z_]\w*)*\s*=/.test(s)) {
    if (/,/.test(s.split("=")[0]!)) return;
    const name = s.split("=")[0]!.trim();
    out.push({ name, expr: s.slice(s.indexOf("=") + 1).trim(), line: lineNo });
    return;
  }
  // `x Type` / `x Type = expr`(裸名+类型;仅包级/var 块上下文进入)
  const m = /^([A-Za-z_]\w*)\s+([A-Za-z_][\w.[\]*,]*)\s*(?:=\s*(.+))?$/.exec(s);
  if (m && !GO_NON_CALL.has(m[2]!) && !/[(]/.test(m[2]!)) {
    out.push({ name: m[1]!, typeText: m[2]!, ...(m[3] ? { expr: m[3] } : {}), line: lineNo });
  }
}

/**
 * 函数体内局部类型证据(行序:赋值先于使用;同行调用在后续 regex 处理时已可读到)。
 * 形态:`x := &T{}` / `x := pkg.T{}` / `x = &T{}` / `x := f()`(同文件单返回值)/
 * `x := T(y)`(转换)/ `x := a.b`(选择器链字段类型)。
 * step-102(094 复用):类型文本一律经 qualBase(自仓白名单:`pkg.T`∈仓内包→T)。
 */
function collectLocalTypes(
  code: string,
  localTypes: Map<string, string>,
  localDirs: Map<string, string>,
  typeNames: Set<string>,
  callables: Map<string, GoSymbol[]>,
  fields: Map<string, Map<string, string>>,
  fieldDirs: Map<string, Map<string, string>>,
  typeOfVar: (name: string) => string | undefined,
  dirOfVar: (name: string) => string,
  dirOf: (text: string) => string,
  selfPkgs: Map<string, string>,
): void {
  const setT = (name: string, t: string, dir: string): void => {
    if (localTypes.has(name)) return;
    localTypes.set(name, t);
    localDirs.set(name, dir);
  };
  // 复合字面量:x := &T{ / x := pkg.T{ / x = T{ —— Go 语法上字面量必名类型,
  // 裸 T 无需在本文件定义(同包跨文件常态);自仓 pkg 前缀白名单剥除后按本地名对照 container
  const lit = /(?:^|[\s;{(])(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|(?<![=!<>])=)\s*&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/.exec(code);
  if (lit) {
    const t = qualBase(lit[2]!, selfPkgs);
    if (t) setT(lit[1]!, t, dirOf(lit[2]!));
  }
  // 调用/转换:x := f(...) / x := pkg.f(...) / x := T(y)
  const call = /(?:^|[\s;{(])(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|(?<![=!<>])=)\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/.exec(code);
  if (call) {
    const callee = call[3]!;
    const cands = callables.get(callee);
    if (cands?.length === 1 && cands[0]!.signature?.returnType) {
      const rt = cands[0]!.signature.returnType.trim();
      // 多返回值 (a, b):不猜取哪位
      if (rt.length > 0 && !rt.startsWith("(")) {
        const t = qualBase(rt, selfPkgs);
        if (t) setT(call[1]!, t, dirOf(rt));
      }
    } else if (!cands?.length && (typeNames.has(callee) || GO_BUILTIN_TYPES.has(callee))) {
      setT(call[1]!, callee, dirOf(callee)); // 转换形态(裸名=同包)
    }
  }
  // 多返回值解构:x, y, z := f(...)/x.f(...)——首变量↔首返回值(同文件签名可判;
  // 其余位/跨文件被调不判)。cobra `cmd, flags, err := c.Find(args); cmd.execute(flags)` 实形态
  const multi = /(?:^|[\s;{(])((?:[A-Za-z_]\w*)(?:\s*,\s*[A-Za-z_]\w*)+)\s*:?=[^=]\s*(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/.exec(code);
  if (multi) {
    const firstVar = multi[1]!.split(",")[0]!.trim();
    if (firstVar !== "_") {
      const cands2 = callables.get(multi[3]!) ?? [];
      const rt = cands2.length === 1 ? cands2[0]!.signature?.returnType?.trim() : undefined;
      if (rt && rt.startsWith("(") && rt.endsWith(")")) {
        const parts = splitTopLevel(rt.slice(1, -1));
        const t = parts.length >= 1 ? qualBase(parts[0]!, selfPkgs) : undefined;
        if (t) setT(firstVar, t, dirOf(parts[0]!));
      }
    }
  }
  // 选择器链拷贝:x := a.b(取字段类型;赋值右侧以标识符结尾,不与调用/字面量形态重叠)
  const sel = /(?:^|[\s;{])(?:var\s+)?([A-Za-z_]\w*)\s*(?::=|(?<![=!<>])=)\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*$/.exec(code);
  if (sel) {
    const segs = sel[2]!.split(".");
    let t = typeOfVar(segs[0]!);
    let dir = dirOfVar(segs[0]!); // 头段变量:逐项登记目录(调用方),字段段取声明目录
    for (let k = 1; k < segs.length && t; k++) {
      const next = fields.get(t)?.get(segs[k]!);
      dir = next ? (fieldDirs.get(t)?.get(segs[k]!) ?? dir) : dir;
      t = next ? baseType(next) : undefined;
    }
    if (t) setT(sel[1]!, t, dir);
  }
}

/** struct 字段行登记:`Name *Type` / `Name []T` / `Name map[K]V` / 嵌入 `Type`;tag 已被剥码。 */
function recordStructField(line: string, typeName: string, out: Map<string, Map<string, string>>): void {
  const toks = line.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return;
  if (toks.length === 1) {
    // 嵌入形态:字段名=类型名(嵌入提升是 Go 方法集语义)
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(toks[0]!) && !GO_NON_CALL.has(toks[0]!)) {
      const m = out.get(typeName) ?? new Map<string, string>();
      if (!m.has(toks[0]!)) m.set(toks[0]!, toks[0]!);
      out.set(typeName, m);
    }
    return;
  }
  const name = toks[0]!;
  const typeText = toks[1]!;
  if (!/^[A-Za-z_]\w*$/.test(name)) return; // `Handle(req ...)` 接口方法行等不冒充字段
  if (/^(?:struct|interface|map|chan|func)(?:\b|\()/.test(typeText)) return; // 内联匿名/函数类型字段:不判
  if (/[()]/.test(typeText)) return;
  const m = out.get(typeName) ?? new Map<string, string>();
  if (!m.has(name)) m.set(name, typeText); // 首写赢(同名字段重复登记无意义)
  out.set(typeName, m);
}

/** 类型文本 → 基名:`*T`/`[]T`/`...T`/`T[P]` → T;map/chan/func/多词=不可判(缺省);
 * 带包限定的类型(`pkg.T`)是外部类型证据(Go 同包类型引用不带限定名)——不剥前缀、
 * 不作本地类型(container 匹配会撞本地同名,假边源),如实放弃。 */
function baseType(t: string): string | undefined {
  let s = t.trim().replace(/^\.\.\./, "");
  while (s.startsWith("*") || s.startsWith("[]") || s.startsWith("[ ")) s = s.slice(s.startsWith("[]") ? 2 : 1).trim();
  s = s.replace(/\[[^\]]*\]\s*$/, "").trim(); // 泛型实例化 T[P]
  if (/^(?:map|chan|func|interface\b|struct\b)/.test(s)) return undefined;
  const first = s.split(/[\s(]/)[0] ?? "";
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(first)) return undefined;
  if (first.includes(".")) return undefined; // 外部类型(包限定):非本地证据
  return /^[A-Za-z_]\w*$/.test(first) ? first : undefined;
}

/** range/切片元素类型:`[]T`→T;`map[K]V`→V;其余不可判。 */
function elementType(t: string): string | undefined {
  const s = t.trim();
  const mapM = /^map\[[^\]]*\](.+)$/.exec(s);
  if (mapM) return baseType(mapM[1]!);
  if (s.startsWith("[]")) return baseType(s.slice(2));
  if (s.startsWith("[") ) { // 定长数组 [N]T
    const close = s.indexOf("]");
    if (close > 0) return baseType(s.slice(close + 1));
  }
  return undefined;
}

/** 表达式 → 类型(包级 var 右值):`&T{}`/`T{}` 字面量优先;`f(...)` 同文件单返回值;其余不猜。
 * step-102(094 复用):类型文本经 qualBase(自仓白名单)。 */
function exprType(
  expr: string,
  typeNames: Set<string>,
  callables: Map<string, GoSymbol[]>,
  selfPkgs: Map<string, string>,
): string | undefined {
  const s = expr.trim();
  const lit = /^&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/.exec(s);
  if (lit) return qualBase(lit[1]!, selfPkgs);
  const call = /^(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/.exec(s);
  if (call) {
    const cands = callables.get(call[2]!);
    if (cands?.length === 1 && cands[0]!.signature?.returnType) {
      const rt = cands[0]!.signature.returnType.trim();
      if (rt && !rt.startsWith("(")) return qualBase(rt, selfPkgs);
    }
    if (!cands?.length && typeNames.has(call[2]!)) return call[2]!;
  }
  return undefined;
}

/** func 头解析:接收者(方法)/泛型/参数/返回类型。多行签名→params 缺省(符号仍登记,不猜)。 */
function parseFuncHeader(code: string): FuncHeader | null {
  let s = code.replace(/^func\s+/, "").trim();
  let recv: Recv | undefined;
  if (s.startsWith("(")) {
    const close = s.indexOf(")");
    if (close < 0) return null;
    const parts = s.slice(1, close).trim().split(/\s+/).filter(Boolean);
    const typeName = (parts[parts.length - 1] ?? "").replace(/^\*/, "");
    if (!typeName) return null;
    recv = { varName: (parts[0] ?? "").replace(/^\*/, ""), typeName };
    s = s.slice(close + 1).trim();
  }
  const nameM = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\(/.exec(s);
  if (!nameM) return null;
  const name = nameM[1]!;
  const open = s.indexOf("(");
  // 平衡扫描取参数段(参数类型里可含括号,如 func(int) bool)
  let depth = 0, end = -1;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) return { name, ...(recv ? { recv } : {}) }; // 多行签名:params 不猜
  const paramsRaw = s.slice(open + 1, end);
  // 返回类型:截到函数体 `{` 之前(单行函数 func f() T { … } 的函数体不冒充返回类型)
  const returnType = s.slice(end + 1).split("{")[0]!.trim() || undefined;
  return { name, ...(recv ? { recv } : {}), paramsRaw, ...(returnType ? { returnType } : {}) };
}

/** Go 参数:(a, b int, c string) 组共享类型按单名展开——一对一取名,组尾类型只有部分可判(如实)。 */
function goSignature(header: FuncHeader): Signature {
  const params = header.paramsRaw !== undefined
    ? splitTopLevel(header.paramsRaw).map((p) => {
        const toks = p.split(/\s+/).filter(Boolean);
        if (toks.length >= 2) {
          return { name: toks[0]!.replace(/^\*/, ""), type: toks.slice(1).join(" ").slice(0, 120) };
        }
        return { name: (toks[0] ?? "_").replace(/^\*/, "") };
      })
    : [];
  return { params, ...(header.returnType ? { returnType: header.returnType.slice(0, 120) } : {}) };
}
