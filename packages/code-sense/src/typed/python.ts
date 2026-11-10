/**
 * typed/python(step-089 P1 / designs/26 §2.2):Python 逐文件 typed 提取——
 * 注解赋值(模块/类级,structural)+字面量推断(lexical 如实)+def/class token。
 * 与 adapters/python.ts 的关系:索引档只收模块级注解变量;本档补类属性/字面量推断/span。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readFailReason, type TypedFileResult, type TypedSymbol } from "./types";

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;
const ANNOT_RE = /^(\s*)([A-Za-z_]\w*)\s*:\s*([^\n=#]+?)\s*(?:=\s*(.+))?$/;
const ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)\s*=\s*(.+)$/;

/** 行级词法状态(2026-10-21 D 修复):三引号字符串跨行跟踪。
 * 实锤现场(py-mmdetection mmdet/apis/inference.py):docstring 的 Returns 段
 * (`ConfigType: new test_pipeline`)与多行 def 签名续行(`video_len: int) -> SampleList:`)
 * 曾被 ANNOT_RE 当注解赋值收进 vars——注解解析必须跳过字符串块内与括号续行。 */
interface PyLexState { triple: string | null }

/** 单行词法扫描:产出 ①code(注释剔除、字符串原文保留——span 偏移不漂移)
 * ②delta(字符串外括号净增减——续行判定)③pureString(整行都在三引号块内)。
 * st.triple 跨行可变:开三引号未闭→置位;行内闭合→清除。 */
function scanPyLine(raw: string, st: PyLexState): { code: string; delta: number; pureString: boolean } {
  let code = "";
  let delta = 0;
  let i = 0;
  const opened = st.triple !== null;
  while (i < raw.length) {
    if (st.triple) {
      const end = raw.indexOf(st.triple, i);
      if (end < 0) return { code, delta, pureString: opened && code.trim() === "" };
      code += raw.slice(i, end + st.triple.length);
      i = end + st.triple.length;
      st.triple = null;
      continue;
    }
    const ch = raw[i]!;
    if (ch === "#") break; // 注释(字符串外):行尾丢弃
    if (ch === '"' || ch === "'") {
      const triple = raw.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const end = raw.indexOf(triple, i + 3);
        if (end >= 0) {
          code += raw.slice(i, end + 3);
          i = end + 3;
          continue;
        }
        st.triple = triple;
        i += 3;
        continue; // 行尾进三引号块(其后内容是字符串)
      }
      // 单行字符串(含转义):原文进 code(offset 稳定),内容不参与括号计数
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] === "\\") { j += 2; continue; }
        if (raw[j] === ch) break;
        j++;
      }
      const stop = Math.min(j + 1, raw.length);
      code += raw.slice(i, stop);
      i = stop;
      continue;
    }
    code += ch;
    if (ch === "(" || ch === "[" || ch === "{") delta++;
    else if (ch === ")" || ch === "]" || ch === "}") delta--;
    i++;
  }
  return { code, delta, pureString: false };
}
const DENY = new Set([
  "if", "else", "elif", "try", "except", "finally", "with", "for", "while", "def", "class",
  "return", "raise", "assert", "del", "global", "nonlocal", "import", "from", "pass",
  "break", "continue", "lambda", "yield", "and", "or", "not", "in", "is", "async", "await", "case", "match", "self", "cls",
]);

/** 字面量推断(诚实词法档:只认直接字面量形态,不追引用)。 */
export function inferLiteralType(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (/^-?\d+$/.test(t)) return "int";
  if (/^-?(\d+\.\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return "float";
  if (/^(True|False)$/.test(t)) return "bool";
  if (/^[bBrRfFuU]?["']/.test(t)) return /^[bB]["']/.test(t) ? "bytes" : "str";
  if (t.startsWith("[")) return "list";
  if (t.startsWith("{")) return t === "{}" || /:\s*\S/.test(t.slice(1, 40)) ? "dict" : "set"; // `{}`=空 dict(Python 约定)
  if (t.startsWith("(")) return "tuple";
  return undefined;
}

/** def 签名形参注解解析(F 批 --locals / G 批 tokens):`name: type` / `name: type = default` 形态。
 * 逗号切分只认括号深度 0(类型内的 `dict[str, int]` 逗号不切);每段返回 code 内 0-based 列。
 * 字符串内容已被 scanPyLine 原文保留(带引号),不干扰切分;括号不闭合(多行签名首行)→
 * 返回空——续行由「括号续行不解析」守门统一挡下(与 2026-10-21 D 同一防线,不为收形参放开)。
 * 无注解形参如实不猜(self/cls 自然跳过)。 */
function parseDefParams(code: string): { name: string; type: string; col: number }[] {
  const open = code.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return []; // 括号不闭合=多行签名首行:参数表不完整,不猜
  const inner = code.slice(open + 1, close);
  if (!inner.trim()) return [];
  const out: { name: string; type: string; col: number }[] = [];
  let d = 0;
  let start = 0;
  const parts: { text: string; at: number }[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") d--;
    else if (ch === "," && d === 0) { parts.push({ text: inner.slice(start, i), at: start }); start = i + 1; }
  }
  parts.push({ text: inner.slice(start), at: start });
  for (const part of parts) {
    const m = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*$/.exec(part.text.trim());
    if (m) out.push({ name: m[1]!, type: m[2]!.replace(/\s+/g, " ").trim(), col: open + 1 + part.at + part.text.indexOf(m[1]!) });
  }
  return out;
}

export async function extractPythonTyped(root: string, relFile: string): Promise<TypedFileResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { file: relFile, language: "python", symbols: [], degraded: { reason: `读取失败: ${readFailReason(err)}` } };
  }
  const lines = text.split("\n");
  const symbols: TypedSymbol[] = [];
  const seen = new Set<string>();
  const push = (s: TypedSymbol): void => {
    if (seen.has(s.container ? s.container + "." + s.name : s.name)) return;
    seen.add(s.container ? s.container + "." + s.name : s.name);
    symbols.push(s);
  };
  // 容器栈(class/def;token 与类属性归属)+ 词法状态(三引号/括号深度)
  const stack: { indent: number; kind: "class" | "def"; name: string }[] = [];
  const lex: PyLexState = { triple: null };
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const { code, delta, pureString } = scanPyLine(raw, lex);
    if (pureString) continue; // 整行在三引号块内(docstring 等):注解/赋值/容器判定全部跳过
    const depthAtStart = depth;
    depth = Math.max(0, depth + delta);
    if (depthAtStart > 0) continue; // 多行括号续行(def 签名/字面量跨行):形参注解不是变量声明
    const indent = code.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    // 函数体内(本行缩进深于任一 def 帧):局部变量不入 vars 清单(注解/推断两径同口径,
    // 2026-10-21 D——vars 面是文件级模块/类变量清单)
    const inDefBody = stack.some((fr) => fr.kind === "def" && fr.indent < indent);
    const clsM = CLASS_RE.exec(code);
    const defM = !clsM && DEF_RE.exec(code);
    if (clsM) {
      stack.push({ indent, kind: "class", name: clsM[2]! });
      push({ name: clsM[2]!, kind: "class", file: relFile, line: i + 1, span: { character: code.indexOf(clsM[2]!), length: clsM[2]!.length }, tier: "structural" });
      continue;
    }
    if (defM) {
      const container = [...stack].reverse().find((s) => s.kind === "class");
      const name = defM[2]!;
      push({
        name, kind: container ? "method" : "function", file: relFile, line: i + 1,
        span: { character: code.indexOf(name), length: name.length },
        ...(container ? { container: container.name } : {}), tier: "structural",
      });
      stack.push({ indent, kind: "def", name });
      // F 批 --locals:def 签名形参注解(kind=param;无注解形参如实不猜)。
      // 只在签名单行闭合时解析(括号续行由 depthAtStart 守门,parseDefParams 对不闭合返回空)。
      if (depth === 0) {
        for (const prm of parseDefParams(code)) {
          if (DENY.has(prm.name)) continue;
          const tClean = prm.type.replace(/,+$/, "").trim();
          if (!tClean || /[)->]/.test(tClean)) continue; // 返回注解碎片不入
          push({
            name: prm.name, kind: "param", dataType: tClean.slice(0, 120),
            file: relFile, line: i + 1,
            span: { character: prm.col, length: prm.name.length },
            container: name, tier: "structural",
          });
        }
      }
      continue;
    }
    // 注解赋值(模块级=variable;类体直下=property;函数体内=--locals 面,默认不入 vars 清单)
    const annot = ANNOT_RE.exec(code);
    if (annot) {
      const [, ind, name, typeText] = annot;
      // 防御:类型文本带 `)`/`->`(返回注解碎片)或裸逗号尾——词法守门外的兜底闸
      const typeClean = typeText!.replace(/\s+/g, " ").trim().replace(/,+$/, "").trim();
      const owner = classOwner(stack, ind!.length);
      const defOwner = [...stack].reverse().find((s) => s.kind === "def" && s.indent < indent);
      if (!DENY.has(name!) && typeClean && !/[)->]|,$/.test(typeClean)) {
        // 函数体内注解局部(F 批 --locals):kind=local,structural(有注解=非推断);
        // 容器=函数名。默认不入 vars(VAR_KINDS 不含 local)——varsOf(symbols,{locals:true}) 扩入。
        if (inDefBody && defOwner) {
          push({
            name: name!, kind: "local", dataType: typeClean.slice(0, 120),
            file: relFile, line: i + 1,
            span: { character: code.indexOf(name!), length: name!.length },
            container: defOwner.name, tier: "structural",
          });
          continue;
        }
        if (!inDefBody) {
          push({
            name: name!, kind: owner ? "property" : "variable",
            dataType: typeClean.slice(0, 120),
            file: relFile, line: i + 1,
            span: { character: code.indexOf(name!), length: name!.length },
            ...(owner ? { container: owner } : {}), tier: "structural",
          });
          continue;
        }
      }
    }
    // 无注解=字面量推断(仅模块级;tier=lexical 如实——推断非声明;函数体内不产——
    // 推断型局部是旧噪声源,--locals 也不收)
    const assign = ASSIGN_RE.exec(code);
    if (assign && !inDefBody && !classOwner(stack, assign[1]!.length)) {
      const name = assign[2]!;
      const owner = undefined;
      if (!DENY.has(name)) {
        const t = inferLiteralType(assign[3]!.split("#")[0] ?? "");
        if (t) {
          push({
            name, kind: "variable", dataType: t, file: relFile, line: i + 1,
            span: { character: code.indexOf(name), length: name.length },
            ...(owner ? { container: owner } : {}), tier: "lexical",
          });
        }
      }
    }
  }
  return { file: relFile, language: "python", symbols };
}

/** 缩进处的最近 class 容器(栈内缩进小于该行缩进的 class 帧;def 帧内不归属)。 */
function classOwner(stack: { indent: number; kind: "class" | "def"; name: string }[], indent: number): string | undefined {
  let owner: string | undefined;
  for (const fr of stack) {
    if (fr.indent >= indent) break;
    if (fr.kind === "def") return undefined; // 函数体内:局部变量,不归属类
    if (fr.kind === "class") owner = fr.name;
  }
  return owner;
}
