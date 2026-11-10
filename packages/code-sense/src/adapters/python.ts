/**
 * Python structural adapter( §5。
 * 一期实现:轻量结构解析(缩进块+def/class/self 归属+import 解析),
 * tier=structural(如实标注;tree-sitter 升级已接——adapters/tree-sitter.ts,补盲不换语义,接口不变)。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { MODULE_CALLER, type Symbol, type FlowEdge, type Signature } from "../callgraph/engine";

export interface PySymbol extends Omit<Symbol, "signature"> {
  signature?: Signature;
}
export interface PyParseResult {
  symbols: PySymbol[];
  edges: FlowEdge[];
  /** 解析失败(语法异常等)的文件进盲区。 */
  failures: { file: string; reason: string }[];
  /** 跨文件调用候选(to="" + toName,名字在本文件 import 名单里)——
 * mergeStructAdapters 全图合并后按唯一名解析(python 单文件解析时跨文件目标不存在。 */
  crossFileCandidates?: FlowEdge[];
}

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;
const SELF_CALL_RE = /self\.([A-Za-z_]\w*)\s*\(/;
const PLAIN_CALL_RE = /(?<![.\w])([A-Za-z_]\w*)\s*\(/;
const IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+([\w.]+))/;
// A1:接收者形态调用 x.method( / self.attr.method(——receiver 链整体捕获
// ([\w.]+ 贪到 "(" 前),拆链后按类型证据解析
const RECEIVER_CALL_RE = /([A-Za-z_]\w*(?:\.\w+)*)\.([A-Za-z_]\w*)\s*\(/g;
// 只排内建类型/函数名(它们作接收者必是标准库语义);域方法(get/append 等在自定义类上是真边)
const RECEIVER_STOPWORDS = new Set(["print", "len", "range", "str", "int", "float", "dict", "list", "set", "super", "isinstance", "type", "repr", "enumerate", "zip", "map", "filter", "sorted", "any", "all", "sum", "min", "max"]);
// 赋值类型形态:`x = mod.Class(...)` / `x = Class(...)`——模块前缀组必须带点(否则正则回溯
// 会把类名劈成 prefix="C"+name="hatHandler" 的假匹配);可选前缀组整体含尾点
const SELF_ATTR_ASSIGN_RE = /^\s*self\.([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*(?:\.\w+)*\.)?([A-Za-z_]\w*)\s*\(/;
const LOCAL_ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*(?:\.\w+)*\.)?([A-Za-z_]\w*)\s*\(/;
// A1 补充形态(DI 风格,agent_alpha 50 处 get_component 调用的主流):
// `self.attr = param`(参数别名,类型来自构造器参数 hint)与 `self.attr = param or Class(...)`
const SELF_ATTR_ALIAS_RE = /^\s*self\.([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*(?:#.*)?$/;
const SELF_ATTR_OR_RE = /^\s*self\.([A-Za-z_]\w*)\s*=\s*[\w.]+\s+or\s+([A-Za-z_]\w*)\s*\(/;
// 工厂赋值:`NAME = [await] 前缀.调用名(` / `self.attr = [await] 前缀.调用名(`——
// 类作为实参传给(非类的)调用、结果赋给标识符(to_thread(ChatHandler,…) 实仓形态)。
// await/点前缀都要能吃(SELF_ATTR_ASSIGN/LOCAL_ASSIGN 被 await 打断、多行实参单行正则够不到——
// agent_service_async.py:2020/2194 三重形态叠加验证)。组:1=缩进 2=self.attr 名 3=裸名 4=调用名
const FACTORY_ASSIGN_RE = /^(\s*)(?:self\.([A-Za-z_]\w*)|([A-Za-z_]\w*))\s*=\s*(?:await\s+)?(?:[A-Za-z_]\w*(?:\.\w+)*\.)?([A-Za-z_]\w*)\s*\(/;
// (096 评测 process_chat 锚):属性拷贝类型证据——`x = a.b.attr` / `self.y = a.b.attr`
// (RHS 纯属性链:非调用/非下标/非元组,行尾)。接收者类型取自 attr 命名约定(snake→Camel)
// 或 RHS 头=self 时 selfAttrTypes 的真证据。组:1=self 目标名 2=局部目标名 3=RHS 属性链。
const ATTR_COPY_RE = /^\s*(?:self\.([A-Za-z_]\w*)|([A-Za-z_]\w*))\s*=\s*(?:await\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\s*(?:#.*)?$/;
// (RC-096-B4):链式构造调用的构造头 `X(...).method(` —— X 段捕获后按括号平衡找配对
// `)`,紧跟 `.name(` 即命中(单行形态;多行实参/嵌套不平衡=跳过,诚实边界)。
const CHAIN_CTOR_HEAD_RE = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g;
// P1( §2.2):模块级注解赋值 `name: Type [= value]`(索引档只收模块级;
// 类属性与函数局部归 typed/ 逐文件档)。组:1=名字 2=类型文本。
const MODULE_VAR_ANNOT_RE = /^([A-Za-z_]\w*)\s*:\s*([^\n=#]+?)\s*(?:=\s*(.+))?$/;
/** 语句/控制流关键字不收为变量(`else:`/`except E:` 等会被 `NAME: 形态` 误捕)。 */
const PY_VAR_DENY = new Set([
  "if", "else", "elif", "try", "except", "finally", "with", "for", "while", "def", "class",
  "return", "raise", "assert", "del", "global", "nonlocal", "import", "from", "pass",
  "break", "continue", "lambda", "yield", "and", "or", "not", "in", "is", "async", "await", "case", "match",
]);

/** 类型注解剥壳:Optional[X]→X;X | None→X;取首段(结构档不猜联合)。 */
function stripTypeHint(t: string): string {
  const inner = /^Optional\[(.+)\]$/.exec(t.trim())?.[1] ?? t.trim();
  const first = inner.split("|")[0]!.trim();
  return /^Optional\[$/.test(first) ? first : first.replace(/\[|\]/g, "");
}

/** 剥字符串字面量与 # 注释(工厂实参扫描前;结构档不解析转义,f-string 同剥)。 */
function stripLiteralsAndComment(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += " ";
      continue;
    }
    if (ch === "#") break;
    out += ch;
  }
  return out;
}

function parenBalance(s: string): number {
  let d = 0;
  for (const ch of s) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
  }
  return d;
}

/** (RC-096-B4):行内链式构造调用枚举——`X(...).method(` 形态逐个产出
 * {ctorChain, method};括号不平衡(多行实参)/无 `.method(` 尾=不产出(诚实边界)。
 * 构造边本身由既有 PLAIN_CALL/模块别名路径覆盖,本枚举只服务方法边发射。 */
function* chainedCtorCalls(line: string): Generator<{ ctorChain: string; method: string }> {
  for (const m of line.matchAll(CHAIN_CTOR_HEAD_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1; // `(` 的位置
    let depth = 1;
    let j = open + 1;
    while (j < line.length && depth > 0) {
      const ch = line[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    if (depth !== 0) continue; // 行内不平衡:多行实参,跳过
    const tail = /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(line.slice(j));
    if (tail) yield { ctorChain: m[1]!, method: tail[1]! };
  }
}

/** snake_case → CamelCase(属性拷贝类型证据的命名约定转换;非 snake 形态返回 undefined)。 */
function snakeToCamel(snake: string): string | undefined {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(snake)) return undefined;
  const camel = snake.split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
  return camel.length >= 4 ? camel : undefined;
}

/**
 * 工厂赋值实参段:赋值行自调用 `(` 起(正则 matchEnd 即 `(` 之后),同行括号
 * 不平衡时按行续收(深度归零停;30 行封顶防病态挂死)。逐行剥字面量/注释。
 * agent_alpha `self.chat_handler = await asyncio.to_thread(` 实参 24 行,类名在次行——封顶
 * 必须盖过真实多行调用。
 */
function collectFactoryArgText(lines: string[], matchEnd: number, startLine: number): string {
  const first = stripLiteralsAndComment(lines[startLine]!.slice(matchEnd));
  let depth = 1 + parenBalance(first); // 正则已消费调用名的 "("
  const parts = [first];
  for (let j = startLine + 1; j < lines.length && j < startLine + 30 && depth > 0; j++) {
    const l = stripLiteralsAndComment(lines[j]!);
    parts.push(l);
    depth += parenBalance(l);
  }
  return parts.join(" ");
}

/**
 * 解析单个 Python 文件(tree-sitter 优先,纯文本解析保底;接口不变)。
 * 二期:tree-sitter 可用时补纯文本正则的盲区(多行参数签名等 DEF_RE
 * 够不到的 def);wasm 缺失/初始化失败=回退纯文本,行为与旧版一致。
 */
export async function parsePythonFile(root: string, relFile: string): Promise<PyParseResult> {
  const symbols: PySymbol[] = [];
  const edges: FlowEdge[] = [];
  const failures: { file: string; reason: string }[] = [];
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { symbols: [], edges: [], failures: [{ file: relFile, reason: String(err) }] };
  }
  const lines = text.split("\n");

  // 栈式缩进追踪:当前类/函数容器
  const stack: { indent: number; kind: "class" | "def"; name: string; line: number }[] = [];
  const moduleImports = new Map<string, string[]>(); // 模块 → 导入符号(仓内解析简化)
 // A1:import 别名 → 模块路径(`import a.b as z`→z.foo 的模块级函数解析证据)
  const moduleAliases = new Map<string, string>();
 // RC-O:`from x import f as g` 别名登记(绑定名 g → 原名 f)。调用点写 g,import 名单
  // 闸必须按绑定名对照;但跨文件目标的符号名是 f——候选边 toName 若写 g,merge 层全图唯一名
  // 按 toName 查必失配(redash「导入改名调用部分丢失」初判,叠加在模块级缺口之上)。
  const aliasOriginal = new Map<string, string>();
 // A1:self.attr = SomeClass(...) 属性接收者类型(文件级,attr→类名集)
  const selfAttrTypes = new Map<string, Set<string>>();

 // A1:构造器参数类型表(符号 id → 参数名→类型)——`self.attr = param` 别名赋值的类型源
  const paramTypes = new Map<string, Map<string, string>>();

  // Pass 1: 收集 def/class 与 import
  const defRanges: { start: number; end: number; symbol: PySymbol }[] = [];
 // 本文件类名集(regex+tree-sitter 双源)——工厂实参的类证据与构造调用闸
  const classDefs = new Set<string>();
  let pendingImport: string | null = null; // 括号多行 from-import 的模块名
  const recordParamTypes = (sym: PySymbol): void => {
    if (!sym.signature) return;
    const m = new Map<string, string>();
    for (const p of sym.signature.params) {
      if (p.type) {
        const t = stripTypeHint(p.type);
        if (t && /^[A-Za-z_]\w*$/.test(t)) m.set(p.name, t);
      }
    }
    if (m.size > 0) paramTypes.set(sym.id, m);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue; // 空行不参与缩进栈(否则会把容器弹掉)
    const clsMatch = CLASS_RE.exec(line);
    const defMatch = !clsMatch && DEF_RE.exec(line);
    const indent = line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();

    if (clsMatch) {
      stack.push({ indent, kind: "class", name: clsMatch[2]!, line: i + 1 });
      classDefs.add(clsMatch[2]!);
    } else if (defMatch) {      const container = [...stack].reverse().find((s) => s.kind === "class")?.name;
      const name = defMatch[2]!;
      const paramsRaw = defMatch[3] ?? "";
      const sym: PySymbol = {
        name,
        id: `${relFile}#${container ? container + "." : ""}${name}`,
        kind: container ? "method" : "function",
        file: relFile,
        line: i + 1,
        ...(container ? { container } : {}),
        signature: pySignature(paramsRaw),
      };
      recordParamTypes(sym);
      symbols.push(sym);
      const curIndent = indent;
      defRanges.push({ start: i, end: lines.length, symbol: sym, });
      defRanges[defRanges.length - 1]!.end = findBlockEnd(lines, i, curIndent);
      stack.push({ indent, kind: "def", name, line: i + 1 });
    } else if (indent === 0 && stack.length === 0) {
 // P1( §2.2):模块级注解变量 `name: Type [= value]`——kind=variable
      // +dataType,零边(engine merge 层 variable 不进 byName)。语句/控制流关键字不收。
      const stripped = stripLiteralsAndComment(line);
      const varM = MODULE_VAR_ANNOT_RE.exec(stripped);
      const varName = varM?.[1];
      const typeText = varM?.[2]?.replace(/\s+/g, " ").trim().slice(0, 120);
      if (varName && typeText && !PY_VAR_DENY.has(varName)) {
        symbols.push({ name: varName, id: `${relFile}#${varName}`, kind: "variable", file: relFile, line: i + 1, dataType: typeText });
      }
    }
    const imp = IMPORT_RE.exec(line);
    if (imp) {
      const mod = imp[1] ?? imp[3] ?? "";
      // 绑定名取 as 后段(`from x import f as g` 的调用点写 g;取原名会在调用行匹配落空);
      // 有 as 时登记 绑定名→原名(候选 toName 回落原名,merge 层才能解析到目标符号)
      const names: string[] = [];
      for (const tok of (imp[2] ?? "").split(",")) {
        const parts = tok.trim().split(/\s+as\s+/).filter(Boolean);
        const binding = (parts.pop() ?? "").trim();
        if (!binding) continue;
        if (parts.length > 0 && /^[A-Za-z_]\w*$/.test(binding)) {
          const orig = parts[0]!.trim();
          if (/^[A-Za-z_]\w*$/.test(orig)) aliasOriginal.set(binding, orig);
        }
        names.push(binding);
      }
 // 同模块多次 import 合并(deepwiki-open rag.py 注意:__init__ 里两次 from api.config
      // import 不同的函数,后者 set 覆盖前者名单→get_embedder_type 候选闸漏判→跨文件调用丢失)
      const prev = moduleImports.get(mod) ?? [];
      moduleImports.set(mod, [...new Set([...prev, ...names])]);
 // A1:`import a.b.c[.as z]` → 绑定名(z 或末段 c)→ 模块路径(模块别名接收者证据)
      if (imp[3]) {
        const asAlias = line.match(/as\s+([A-Za-z_]\w*)/)?.[1];
        const binding = asAlias ?? mod.split(".").pop()!;
        if (binding) moduleAliases.set(binding, mod);
      }
 // 括号多行 from-import(service/app.py「from .prompt_render import (」注意:名单在
      // 后续行,单行 IMPORT_RE 只捕到 "("——跨文件候选闸因此漏掉函数内懒导入的真调用)
      if (/\(\s*$/.test(imp[2] ?? "")) {
        pendingImport = mod;
        moduleImports.set(mod, []);
      }
    } else if (pendingImport) {
      if (/^\s*\)/.test(line)) {
        pendingImport = null;
      } else {
        const list = moduleImports.get(pendingImport)!;
        for (const tok of line.split(",")) {
          const parts = tok.trim().split(/\s+as\s+/).filter(Boolean);
          const name = (parts.pop() ?? "").trim();
          if (/^[A-Za-z_]\w*$/.test(name)) {
            list.push(name);
            if (parts.length > 0) {
              const orig = parts[0]!.trim();
              if (/^[A-Za-z_]\w*$/.test(orig)) aliasOriginal.set(name, orig);
            }
          }
        }
      }
    }
  }

 // tree-sitter 补盲(二期):多行参数签名等 DEF_RE 够不到的 def,
  // 从 AST 声明补入(tier=structural 如实;pure 解析器保底语义不变)。
  try {
    const { parseFileWithTreeSitter } = await import("./tree-sitter");
    const ts = await parseFileWithTreeSitter("python", root, relFile);
    if (ts) {
      const known = new Set(symbols.map((x) => `${x.name}:${x.line}`));
      // 容器判定用 AST 行界(包含关系):c.start < d.start 且 d.end ≤ c.end,取最内层。
 // 旧版「行号<它的最近已知名」是兄弟节点误归属——经验证 _period_start(前一个 def)
      // 吃掉多行签名的 render_memory_block,符号名查不到(code_index 查空的一条真因)。
      const findContainer = (d: { startLine: number; endLine: number }): string | undefined => {
        let best: { name: string; startLine: number } | undefined;
        for (const c of ts.declarations) {
          if (c.startLine === d.startLine && c.endLine === d.endLine) continue; // 自身
          if (c.startLine < d.startLine && d.endLine <= c.endLine) {
            if (!best || c.startLine > best.startLine) best = { name: c.name, startLine: c.startLine };
          }
        }
        return best?.name;
      };
      for (const d of ts.declarations) {
        if (d.kind !== "function_definition" && d.kind !== "class_definition") continue;
        if (d.kind === "class_definition") classDefs.add(d.name); // 类名集 AST 源
        if (known.has(`${d.name}:${d.startLine}`)) continue;
        const isFn = d.kind === "function_definition";
        const container = isFn ? findContainer(d) : undefined; // 类不做嵌套容器(与正则栈语义一致)
        symbols.push({
          name: d.name,
          id: `${relFile}#${container ? container + "." : ""}${d.name}`,
          kind: isFn ? (container ? "method" : "function") : "class",
          file: relFile,
          line: d.startLine,
          ...(container ? { container } : {}),
          ...(isFn && d.paramsText ? { signature: pySignature(d.paramsText.replace(/^\(|\)$/g, "")) } : {}),
        });
        if (isFn && d.paramsText) {
          const sym2 = symbols[symbols.length - 1]!;
          recordParamTypes(sym2);
        }
      }
 // 多行签名 def 的函数体也要扫调用边(实仓注意:a1_adapter.build_evidence_pack
      // 双行签名,defRanges 只收单行 DEF_RE → 该方法「调用 0」,体内 self.x 调用边全丢)。
      // 补盲函数用 AST 行界建 range;正则命中的已有 range 不重复。
      const regexRanged = new Set(defRanges.map((r) => r.symbol));
      // 容器修复:三引号字符串的内容行(缩进 0)会把 class 从正则缩进栈弹掉,后续方法
 // 丢容器/误标 function(a1_adapter._semantic_coverage 注意)——AST 行界是权威,
      // 按「最内层包围声明」(与上方 findContainer 同规则,函数容器不跳层)修正既有符号。
      for (const d of ts.declarations) {
        if (d.kind !== "function_definition") continue;
        const sym = symbols.find((s) => s.name === d.name && s.line === d.startLine && s.file === relFile);
        if (sym) {
          const astContainer = findContainer(d);
          if (sym.container !== astContainer) {
            if (astContainer === undefined) delete sym.container;
            else sym.container = astContainer;
            sym.kind = astContainer ? "method" : "function";
            sym.id = `${relFile}#${astContainer ? astContainer + "." : ""}${sym.name}`;
          }
        }
        if (!sym || regexRanged.has(sym)) continue;
        const start0 = d.startLine - 1;
        defRanges.push({ start: start0, end: d.endLine - 1, symbol: sym });
        regexRanged.add(sym);
      }
      symbols.sort((a, b) => a.line - b.line);
    }
  } catch { /* tree-sitter 面任何异常=纯文本结果已可用,不阻塞 */ }
  // tree-sitter 不可用(返回 undefined)时,多行签名 def 仍是盲区——纯文本形态拿不到行界,
  // 按缩进盲推断会误扫,宁缺勿错(「补盲失败=回退旧行为」契约)。

  // Pass 2: 函数体内调用边(self.x 优先归属;import 名对照;唯一名兜底)
  const byName = new Map<string, PySymbol[]>();
  for (const s of symbols) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
 // import 名单(from x import a,b → {a,b}):裸调用的跨文件候选闸(——此前
  // moduleImports 收集了没消费,跨文件调用边 0/11 全漏,真 API 被误标「入口,无人调用」)
  const importedNames = new Set<string>();
  for (const names of moduleImports.values()) for (const n of names) importedNames.add(n);
 // 类证据闸:本文件 class 定义(classDefs,regex+AST 双源)或 import 名单内且
  // 首字母大写(Python 类名的结构档约定,小写不猜)。
  const isKnownClass = (n: string): boolean => classDefs.has(n) || (importedNames.has(n) && /^[A-Z]/.test(n));
  // 集合闸精化(零回退形态):旧=size===1 即取(既有形态逐字节保持);新增=多成员时已知类
  // 恰一则取该类——单行工厂赋值会同时被 LOCAL_ASSIGN 记入伪条目(`x = to_thread(ChatHandler,u)`
  // → {to_thread, ChatHandler}),取唯一已知类才放行;真冲突(两个已知类)仍不猜。
  const soleType = (set: Set<string> | undefined): string | undefined => {
    if (!set) return undefined;
    if (set.size === 1) return [...set][0];
    const known = [...set].filter(isKnownClass);
    return known.length === 1 ? known[0] : undefined;
  };
  const crossFileCandidates: FlowEdge[] = [];
  const candSeen = new Set<string>();
 // A1:函数局部接收者类型(逐 def 范围:`svc = ChatService(...)` 之后 svc.method(有证据)
  // 范围按行序扫描——regex 范围在前/AST 补盲范围追加在后的原始顺序会让后文的调用先于前文的
 // `self.attr = ...` 赋值被处理(node_executor 验证:646 行 get_component 先于 373 行赋值扫描)
  const localTypes = new Map<string, Map<string, Set<string>>>();
  defRanges.sort((a, b) => a.start - b.start);
  for (const range of defRanges) {
    for (let i = range.start + 1; i <= range.end && i < lines.length; i++) {
      const line = lines[i]!;
      if (DEF_RE.test(line) || CLASS_RE.test(line)) continue;
      // 接收者赋值类型收集(先于本行调用处理:python 赋值先于使用的常态序)
      const selfAttr = SELF_ATTR_ASSIGN_RE.exec(line);
      if (selfAttr) {
        const set2 = selfAttrTypes.get(selfAttr[1]!) ?? new Set<string>();
        set2.add(selfAttr[2]!);
        selfAttrTypes.set(selfAttr[1]!, set2);
      } else {
        // DI 别名形态:`self.attr = param`(类型=构造器参数 hint)/ `self.attr = param or Class(...)`
        const pt = paramTypes.get(range.symbol.id);
        if (pt) {
          const alias = SELF_ATTR_ALIAS_RE.exec(line);
          if (alias && pt.has(alias[2]!)) {
            const set2 = selfAttrTypes.get(alias[1]!) ?? new Set<string>();
            set2.add(pt.get(alias[2]!)!);
            selfAttrTypes.set(alias[1]!, set2);
          } else {
            const orAssign = SELF_ATTR_OR_RE.exec(line);
            if (orAssign) {
              const set2 = selfAttrTypes.get(orAssign[1]!) ?? new Set<string>();
              set2.add(orAssign[2]!);
              selfAttrTypes.set(orAssign[1]!, set2);
            }
          }
        }
      }
      const localAssign = LOCAL_ASSIGN_RE.exec(line);
      if (localAssign && !SELF_ATTR_ASSIGN_RE.test(line)) {
        const m2 = localTypes.get(range.symbol.id) ?? new Map<string, Set<string>>();
        const set2 = m2.get(localAssign[2]!) ?? new Set<string>();
        set2.add(localAssign[3]!);
        m2.set(localAssign[2]!, set2);
        localTypes.set(range.symbol.id, m2);
      }
 // 工厂赋值:`x/self.attr = [await] mod.fn(Class, …)`——类作为**裸实参**传给
      // 非类调用,结果标识符获得指向该类的类型线索(agent_alpha `self.chat_handler = await
      // asyncio.to_thread(\n ChatHandler,…)` 生产 2 处的形态;await/多行实参是既有正则的盲区)。
      // 已知类恰一才记(≥2=歧义不猜);调用名本身是已知类=构造形态(SELF_ATTR/LOCAL_ASSIGN
      // 已有语义),跳过;点前缀引用(BaseHandler._x)与紧跟 "(" 的标识符(Str(…) 等)不算裸类实参。
      const factory = FACTORY_ASSIGN_RE.exec(line);
      if (factory && !isKnownClass(factory[4]!)) {
        const argText = collectFactoryArgText(lines, factory[0].length, i);
        const bareKnown = new Set<string>();
        for (const t of argText.matchAll(/[A-Za-z_]\w*/g)) {
          const next = argText[t.index + t[0].length];
          if (next === "." || next === "(") continue;
          if (isKnownClass(t[0])) bareKnown.add(t[0]);
        }
        if (bareKnown.size === 1) {
          const cls = [...bareKnown][0]!;
          if (factory[2]) {
            const set2 = selfAttrTypes.get(factory[2]) ?? new Set<string>();
            set2.add(cls);
            selfAttrTypes.set(factory[2], set2);
          } else if (factory[3]) {
            const m2 = localTypes.get(range.symbol.id) ?? new Map<string, Set<string>>();
            const set2 = m2.get(factory[3]) ?? new Set<string>();
            set2.add(cls);
            m2.set(factory[3], set2);
            localTypes.set(range.symbol.id, m2);
          }
        }
      }
 // (096 process_chat 锚):属性拷贝类型证据——`x = a.b.attr` / `self.y = a.b.attr`
 // (chat_handler = session.chat_handler 之后 chat_handler.process_chat(跨文件召回)。
      // attr 含 `_` 才走命名约定推断(snake→Camel);merge 层「container 匹配+全图唯一」双闸
      // 吸收猜错(无匹配=候选丢弃,零假边);RHS 头=self 优先取 selfAttrTypes 真证据。
      {
        const ac = ATTR_COPY_RE.exec(line);
        if (ac) {
          const segs = ac[3]!.split(".");
          const attr = segs[segs.length - 1]!;
          let t: string | undefined;
          if (segs[0] === "self" && segs.length === 2) t = soleType(selfAttrTypes.get(segs[1]!));
          if (!t) t = snakeToCamel(attr);
          if (t) {
            if (ac[1]) {
              const set2 = selfAttrTypes.get(ac[1]!) ?? new Set<string>();
              if (!set2.has(t)) { set2.add(t); selfAttrTypes.set(ac[1]!, set2); }
            } else if (ac[2]) {
              const m2 = localTypes.get(range.symbol.id) ?? new Map<string, Set<string>>();
              const set2 = m2.get(ac[2]!) ?? new Set<string>();
              if (!set2.has(t)) { set2.add(t); m2.set(ac[2]!, set2); }
              localTypes.set(range.symbol.id, m2);
            }
          }
        }
      }
 // (RC-096-B4):链式构造调用 `X(...).method(` 的方法边(构造边既有路径已覆盖;
      // serialize_query 的 queries API 上游整族漏报根因)。X=已知类(本文件/ import 名单+
      // 首字母大写,别名回落原名),候选带 receiverType=X,merge 层双闸解析。
      for (const cc of chainedCtorCalls(line)) {
        const segs = cc.ctorChain.split(".");
        if (segs[0] === "self") continue; // self.Foo(...).m( 的属性构造器类型未知,不猜
        const clsRaw = segs[segs.length - 1]!;
        const clsName = aliasOriginal.get(clsRaw) ?? clsRaw;
        if (!isKnownClass(clsRaw) && !isKnownClass(clsName)) continue;
        let chainModuleHint: string | undefined;
        if (segs.length > 1) {
          const head = segs.slice(0, -1).join(".");
          if (moduleAliases.has(head)) chainModuleHint = (moduleAliases.get(head) ?? "").replace(/\./g, "/");
        }
        const kc = `${range.symbol.id}|chain|${cc.method}|${clsName}|${chainModuleHint ?? ""}`;
        if (candSeen.has(kc)) continue;
        candSeen.add(kc);
        crossFileCandidates.push({
          from: range.symbol.id, to: "", toName: cc.method,
          file: relFile, line: i + 1,
          tier: "structural", evidenceKind: "inferred",
          receiverType: clsName,
          ...(chainModuleHint ? { moduleHint: chainModuleHint } : {}),
        });
      }
      // self.x() → 同类方法(兄弟查找失败=跨文件同类方法,候选带 receiverType=所在类证据;
 // 属性可调用实例不在此猜——selfAttrTypes 只服务 self.attr.method(链,宁缺勿错)
      for (const m of line.matchAll(new RegExp(SELF_CALL_RE.source, "g"))) {
        const target = m[1]!;
        const sibling = symbols.find(
          (s) => s.name === target && s.container === range.symbol.container);
        edges.push({
          from: range.symbol.id,
          to: sibling?.id ?? "",
          toName: target,
          file: relFile, line: i + 1,
          tier: "structural",
          evidenceKind: sibling ? "ast" : "inferred",
          ...(sibling || !range.symbol.container ? {} : { receiverType: range.symbol.container }),
        });
      }
 // 接收者形态 obj.method( / self.attr.method( / 模块别名 mod.func( A1:此前
      // 这类调用整体不发射——PLAIN_CALL_RE 的负向环视排除点号形态,跨文件方法边 0/20 的直接根源)
      for (const m of line.matchAll(RECEIVER_CALL_RE)) {
        const chain = m[1]!;
        const method = m[2]!;
        if (chain === "self") continue; // 已由 SELF_CALL_RE 路径处理
        if (RECEIVER_STOPWORDS.has(method)) continue;
        const chainHead = chain.split(".")[0]!;
        let receiverType: string | undefined;
        let moduleHint: string | undefined;
        if (chain.startsWith("self.")) {
          const attr = chain.split(".")[1]!;
          receiverType = soleType(selfAttrTypes.get(attr));
        } else if (moduleAliases.has(chain)) {
          moduleHint = (moduleAliases.get(chain) ?? "").replace(/\./g, "/");
 // RC-O:点前缀构造 mod.Foo( → __init__ 候选(模块别名证据+已知类名;
          // 类名小写/未 import 不猜;别名 import 的类按原名发候选——目标符号名是原名)
          const clsName = aliasOriginal.get(method) ?? method;
          if (isKnownClass(method)) {
            const kc = `${range.symbol.id}|__init__|${method}|${moduleHint}`;
            if (!candSeen.has(kc)) {
              candSeen.add(kc);
              crossFileCandidates.push({
                from: range.symbol.id, to: "", toName: "__init__",
                file: relFile, line: i + 1,
                tier: "structural", evidenceKind: "inferred",
                receiverType: clsName, moduleHint,
              });
            }
          }
        } else {
          receiverType = soleType(localTypes.get(range.symbol.id)?.get(chainHead));
        }
        if (!receiverType && !moduleHint) continue; // 无类型证据:不猜(宁缺勿错)
        const k = `${range.symbol.id}|${method}|${receiverType ?? ""}|${moduleHint ?? ""}`;
        if (candSeen.has(k)) continue;
        candSeen.add(k);
        crossFileCandidates.push({
          from: range.symbol.id, to: "", toName: method,
          file: relFile, line: i + 1,
          tier: "structural", evidenceKind: "inferred",
          ...(receiverType ? { receiverType } : {}),
          ...(moduleHint ? { moduleHint } : {}),
        });
      }
 // P1(spawn 边):Process(target=fn)/Thread(target=fn)——多进程/线程启动的
      // 函数引用不是调用点,旧图看不见 launcher→worker(agent_alpha run_master 链沉底根因)。
 // 跨行形态(依据 process_manager.py:91 `Process(` 与 :92 `target=run_worker` 不同行):
 // 直接扫 target= 裸标识符(该 kwarg 语义就是可调用对象引用),不再要求同行有 Process( // 解析语义与普通调用同源(同文件唯一直连;import 名单发候选交 merge 层)。
      for (const m of line.matchAll(/\btarget\s*=\s*([A-Za-z_]\w*)\b/g)) {
        const fn = m[1]!;
        if (["print", "len", "range", "str", "int", "float", "dict", "list", "set", "self", "None", "True", "False"].includes(fn)) continue;
        const cands2 = byName.get(fn) ?? [];
        let spawnTo: string | undefined;
        if (cands2.length === 1) spawnTo = cands2[0]!.id;
        if (spawnTo && spawnTo !== range.symbol.id) {
          const ek = `${range.symbol.id}|spawn|${spawnTo}`;
          if (!candSeen.has(ek)) {
            candSeen.add(ek);
            edges.push({ from: range.symbol.id, to: spawnTo, toName: fn, file: relFile, line: i + 1, tier: "structural", evidenceKind: "ast" });
          }
        } else if (cands2.length === 0 && importedNames.has(fn)) {
          const ek = `${range.symbol.id}|spawn|${fn}`;
          if (!candSeen.has(ek)) {
            candSeen.add(ek);
            crossFileCandidates.push({ from: range.symbol.id, to: "", toName: aliasOriginal.get(fn) ?? fn, file: relFile, line: i + 1, tier: "structural", evidenceKind: "inferred" });
          }
        }
      }
      // 普通调用(排除关键字)
      for (const m of line.matchAll(new RegExp(PLAIN_CALL_RE.source, "g"))) {
        const callee = m[1]!;
        if (["print", "len", "range", "str", "int", "float", "dict", "list", "set", "super", "isinstance", "self"].includes(callee)) continue;
 // A3:构造调用 Foo( → Foo.__init__ 实例化关联。同文件(必做):直接 ast 边
        // (构造调用→类节点的既有边不动,叠加);类无 __init__(继承 object)不造。跨文件(尽力):
        // import 名单内已知类名发候选(receiverType=类名),merge 层按 Class.__init__ 候选集解析,
 // 同名多类=不解析不回退(承 接收者双闸语义)。__init__ 内 Foo(自构递归两侧都跳。
        const selfInitId = `${relFile}#${callee}.__init__`;
        if (range.symbol.id !== selfInitId) {
          if (classDefs.has(callee)) {
            if (symbols.some((s) => s.id === selfInitId)) {
              edges.push({ from: range.symbol.id, to: selfInitId, toName: "__init__", file: relFile, line: i + 1, tier: "structural", evidenceKind: "ast" });
            }
          } else if (importedNames.has(callee) && /^[A-Z]/.test(callee)) {
            const k = `${range.symbol.id}|__init__|${callee}`;
            if (!candSeen.has(k)) {
              candSeen.add(k);
 // RC-O:别名 import 的构造候选按原名发(receiverType=目标符号名)
              crossFileCandidates.push({ from: range.symbol.id, to: "", toName: "__init__", file: relFile, line: i + 1, tier: "structural", evidenceKind: "inferred", receiverType: aliasOriginal.get(callee) ?? callee });
            }
          }
        }
        const cands = byName.get(callee) ?? [];
        let toId: string | undefined;
        if (cands.length === 1) toId = cands[0]!.id;
        if (!toId) {
          // 本文件解析不到但确在 import 名单里:发跨文件候选(to="" 由 merge 层全图唯一名解析;
          // 解析不了会被丢弃,与旧版「不发射」等价)。多候选/未 import:不猜。
 // RC-O:别名 import(from x import f as g)的 toName 回落原名 f——
          // 目标符号名是 f,按绑定名 g 查全图唯一名必失配(候选被丢弃=边丢失)。
          if (cands.length === 0 && importedNames.has(callee)) {
            const k = `${range.symbol.id}|${callee}`;
            if (!candSeen.has(k)) {
              candSeen.add(k);
              crossFileCandidates.push({ from: range.symbol.id, to: "", toName: aliasOriginal.get(callee) ?? callee, file: relFile, line: i + 1, tier: "structural", evidenceKind: "inferred" });
            }
          }
          continue;
        }
        if (toId === range.symbol.id) continue; // 递归边保留但防自环重复
        edges.push({
          from: range.symbol.id, to: toId, toName: callee,
          file: relFile, line: i + 1,
          tier: "structural", evidenceKind: "ast",
        });
      }
    }
  }
 // Pass 3: 模块级调用( RC-O)。adapter 此前只扫 def 体,顶层语句/decorator 行的调用
  // 整面丢失(redash org_scoped_rule 9 个跨文件调用方里 8 个在 `@routes.route(org_scoped_rule(..))`
 // decorator 行,R=0.111 的真根因; 登记的「py 仓 <module> 边为 0 属设计边界」就此)。
  // 归属 `${relFile}#${MODULE_CALLER}` 虚调用方——与 TS 侧同形态,c2f classify 的 ghostSuffix
  // 特判保证模块级调用方不取消符号入口资格,查询/渲染侧零改动。
  // 闸与 Pass 2 同源(宁缺勿错):裸调用=同文件唯一名直连 / import 名单发候选(toName 按别名
  // 回落原名);接收者形态只在模块别名证据下发候选;类体内 def 外行(类属性初始化)按模块级处理
  // (class body 在类创建期执行)。模块级无函数体边界可依,三引号字符串内容必须显式跳过
  // (docstring「see foo() for details」不算调用——模块面字符串密度远高于 def 体,不跳会伤 P)。
  const moduleCallerId = `${relFile}#${MODULE_CALLER}`;
  const inDefBody = new Uint8Array(lines.length);
  for (const range of defRanges) {
    // start(def 行)也要标:多行签名 def 的首行(`async def execute(` 无闭括号)不匹配 DEF_RE,
 // 不标会被 Pass 3 当模块级调用行,发射 `<module>→execute` 假边(agent_alpha 三依据复现)
    for (let i = range.start; i <= range.end && i < lines.length; i++) inDefBody[i] = 1;
  }
  const inTriple = moduleTripleLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (inDefBody[i] || inTriple[i]) continue;
    const raw = lines[i]!;
    if (!raw.trim() || DEF_RE.test(raw) || CLASS_RE.test(raw)) continue;
    // import 行无调用括号(正则天然不中);decorator 行必须扫——@routes.route(org_scoped_rule(..))
    // 的调用点就在 decorator 行
    const line = stripLiteralsAndComment(raw);
    // 接收者形态:模块别名 mod.func( → 候选(moduleHint 证据;无证据接收者不猜,与 Pass 2 同闸)
    for (const m of line.matchAll(RECEIVER_CALL_RE)) {
      const chain = m[1]!;
      const method = m[2]!;
      if (RECEIVER_STOPWORDS.has(method)) continue;
      if (!moduleAliases.has(chain)) continue;
      const moduleHint = (moduleAliases.get(chain) ?? "").replace(/\./g, "/");
      const clsName = aliasOriginal.get(method) ?? method;
      if (isKnownClass(method)) {
        const kc = `${moduleCallerId}|__init__|${method}|${moduleHint}`;
        if (!candSeen.has(kc)) {
          candSeen.add(kc);
          crossFileCandidates.push({
            from: moduleCallerId, to: "", toName: "__init__",
            file: relFile, line: i + 1,
            tier: "structural", evidenceKind: "inferred",
            receiverType: clsName, moduleHint,
          });
        }
      }
      const k = `${moduleCallerId}|${method}|${moduleHint}`;
      if (candSeen.has(k)) continue;
      candSeen.add(k);
      crossFileCandidates.push({
        from: moduleCallerId, to: "", toName: method,
        file: relFile, line: i + 1,
        tier: "structural", evidenceKind: "inferred", moduleHint,
      });
    }
 // RC-B4:模块级链式构造调用(与 Pass 2 同规则;模块级接收者调用本就只走
    // 模块别名证据,链式构造的 receiverType=类名证据比别名更强,单列)
    for (const cc of chainedCtorCalls(line)) {
      const segs = cc.ctorChain.split(".");
      if (segs[0] === "self") continue;
      const clsRaw = segs[segs.length - 1]!;
      const clsName = aliasOriginal.get(clsRaw) ?? clsRaw;
      if (!isKnownClass(clsRaw) && !isKnownClass(clsName)) continue;
      let chainModuleHint: string | undefined;
      if (segs.length > 1) {
        const head = segs.slice(0, -1).join(".");
        if (moduleAliases.has(head)) chainModuleHint = (moduleAliases.get(head) ?? "").replace(/\./g, "/");
      }
      const kc = `${moduleCallerId}|chain|${cc.method}|${clsName}|${chainModuleHint ?? ""}`;
      if (candSeen.has(kc)) continue;
      candSeen.add(kc);
      crossFileCandidates.push({
        from: moduleCallerId, to: "", toName: cc.method,
        file: relFile, line: i + 1,
        tier: "structural", evidenceKind: "inferred",
        receiverType: clsName,
        ...(chainModuleHint ? { moduleHint: chainModuleHint } : {}),
      });
    }
    // 裸调用:同文件唯一名直连;import 名单发候选;已知类构造发 __init__ 候选
    for (const m of line.matchAll(new RegExp(PLAIN_CALL_RE.source, "g"))) {
      const callee = m[1]!;
      if (["print", "len", "range", "str", "int", "float", "dict", "list", "set", "super", "isinstance", "self"].includes(callee)) continue;
      const selfInitId = `${relFile}#${callee}.__init__`;
      if (classDefs.has(callee)) {
        if (symbols.some((s) => s.id === selfInitId) && !candSeen.has(`${moduleCallerId}|${selfInitId}|${i}`)) {
          candSeen.add(`${moduleCallerId}|${selfInitId}|${i}`);
          edges.push({ from: moduleCallerId, to: selfInitId, toName: "__init__", file: relFile, line: i + 1, tier: "structural", evidenceKind: "ast" });
        }
      } else if (importedNames.has(callee) && /^[A-Z]/.test(callee)) {
        const k = `${moduleCallerId}|__init__|${callee}`;
        if (!candSeen.has(k)) {
          candSeen.add(k);
          crossFileCandidates.push({ from: moduleCallerId, to: "", toName: "__init__", file: relFile, line: i + 1, tier: "structural", evidenceKind: "inferred", receiverType: aliasOriginal.get(callee) ?? callee });
        }
      }
      const cands = byName.get(callee) ?? [];
      if (cands.length === 1) {
        const toId = cands[0]!.id;
        edges.push({ from: moduleCallerId, to: toId, toName: callee, file: relFile, line: i + 1, tier: "structural", evidenceKind: "ast" });
        continue;
      }
      if (cands.length === 0 && importedNames.has(callee)) {
        const k = `${moduleCallerId}|${callee}`;
        if (!candSeen.has(k)) {
          candSeen.add(k);
          crossFileCandidates.push({ from: moduleCallerId, to: "", toName: aliasOriginal.get(callee) ?? callee, file: relFile, line: i + 1, tier: "structural", evidenceKind: "inferred" });
        }
      }
    }
  }
  // 去重(一行多次匹配)
  const seen = new Set<string>();
  const dedup = edges.filter((e) => {
    const k = `${e.from}|${e.to}|${e.toName}|${e.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { symbols, edges: dedup, failures, crossFileCandidates };
}

/** 模块级三引号字符串行位图( RC-O):行命中=该行在 """ / ''' 字符串内或开合行本身。
 * 单行引号内的 triple 样文本(s = '"""')不算开——逐字符扫描,单引号态优先。 */
function moduleTripleLines(lines: string[]): Uint8Array {
  const flags = new Uint8Array(lines.length);
  let triple: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let quote: string | null = null; // 单行引号态
    let touched = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (triple) {
        touched = true;
        if (line.startsWith(triple, j)) { j += 2; triple = null; }
        continue;
      }
      if (quote) {
        if (ch === "\\") { j++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "#" && !triple) break; // 注释余下不参与(单行引号已闭才可能是注释)
      if (ch === '"' || ch === "'") {
        const t3 = line.slice(j, j + 3);
        if (t3 === '"""' || t3 === "'''") { triple = t3; touched = true; j += 2; continue; }
        quote = ch;
      }
    }
    if (triple || touched) flags[i] = 1;
  }
  return flags;
}

function findBlockEnd(lines: string[], start: number, indent: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const cur = l.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    if (cur <= indent) return i - 1;
  }
  return lines.length - 1;
}

/** Python 参数:type hint 有则取,无则 untyped(不猜)。 */
function pySignature(paramsRaw: string): Signature {
  const params = paramsRaw.split(",").map((p) => p.trim()).filter((p) => p && p !== "self" && !p.startsWith("*"));
  return {
    params: params.map((p) => {
      const [name, type] = p.split(":").map((s) => s.trim());
      const hasHint = Boolean(type);
      return {
        name: (name ?? p).split("=")[0]!.trim(),
        ...(hasHint ? { type: type!.split("=")[0]!.trim().slice(0, 120) } : {}),
        ...(p.includes("=") ? { optional: true } : {}),
        ...(!hasHint ? {} : {}),
      };
    }),
  };
}
