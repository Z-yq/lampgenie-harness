/**
 * typed/go(step-089 P1 / designs/26 §2.2):Go 逐文件 typed 提取——
 * var/const 显式类型(structural)+ `:=` 字面量推断(lexical)+struct 字段+func/type token。
 * 与 adapters/go.ts 的关系:索引档只收包级 var/const 显式类型;本档补 :=/字段/span。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBraceTracker } from "../adapters/braces";
import { readFailReason, type TypedFileResult, type TypedSymbol } from "./types";

const VAR_LINE_RE = /^(?:var|const)\s+([A-Za-z_]\w*)\s+([A-Za-z_][\w.[\]*]*)/;
const SHORT_ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)\s*:=\s*(.+)$/;
const STRUCT_RE = /^type\s+([A-Za-z_]\w*)\s+struct\s*\{/;
const FIELD_RE = /^([A-Za-z_]\w*)\s+([A-Za-z_][\w.[\]*]*(?:,\s*[A-Za-z_][\w.[\]*]*)*)\s*(?:=.*)?$/;
const TYPE_DECL_RE = /^type\s+([A-Za-z_]\w*)(?:\[[^\]]*\])?\s+/;
const FUNC_RE = /^func\s+(?:\(([^)]+)\)\s*)?([A-Za-z_]\w*)\s*\(/;

/** 字面量推断(诚实词法档)。 */
export function inferGoLiteral(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (/^-?\d+$/.test(t)) return "int";
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(t)) return "float64";
  if (/^".*"$/.test(t) || /^`.*`$/.test(t)) return "string";
  if (/^'.'$/.test(t)) return "rune";
  if (/^(true|false)$/.test(t)) return "bool";
  return undefined;
}

export async function extractGoTyped(root: string, relFile: string): Promise<TypedFileResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { file: relFile, language: "go", symbols: [], degraded: { reason: `读取失败: ${readFailReason(err)}` } };
  }
  const lines = text.split("\n");
  const tracker = createBraceTracker();
  const symbols: TypedSymbol[] = [];
  const seen = new Set<string>();
  const push = (s: TypedSymbol): void => {
    if (symbols.length >= 2000) return;
    const key = s.container ? s.container + "." + s.name : s.name;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push(s);
  };
  let inVarBlock = false;
  let inImportBlock = false;
  let structName: { name: string; depth: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const depthBefore = tracker.depth;
    const { code, depth: depthAfter } = tracker.feed(lines[i]!);
    const t = code.trim();
    if (!t) continue;
    // 闭块:struct 体结束
    if (structName && depthAfter < structName.depth) structName = undefined;
    if (inImportBlock) {
      if (/^\)\s*$/.test(t)) inImportBlock = false;
      continue;
    }
    if (inVarBlock) {
      if (/^\)\s*$/.test(t)) { inVarBlock = false; continue; }
      const m = /^([A-Za-z_]\w*)\s+([A-Za-z_][\w.[\]*,]*)\s*(?:=\s*(.+))?$/.exec(t);
      if (m && !/[(]/.test(m[2]!)) {
        push({ name: m[1]!, kind: "variable", dataType: m[2]!, file: relFile, line: i + 1, span: { character: code.indexOf(m[1]!), length: m[1]!.length }, tier: "structural" });
      }
      continue;
    }
    if (/^import\s*\($/.test(t)) { inImportBlock = true; continue; }
    if (/^(?:var|const)\s*\($/.test(t)) { inVarBlock = true; continue; }
    // struct 开块:收字段
    const sm = STRUCT_RE.exec(t);
    if (sm) {
      push({ name: sm[1]!, kind: "struct", file: relFile, line: i + 1, span: { character: t.indexOf(sm[1]!), length: sm[1]!.length }, tier: "structural" });
      if (depthAfter > depthBefore) structName = { name: sm[1]!, depth: depthAfter };
      continue;
    }
    if (structName && depthAfter >= structName.depth) {
      const fm = FIELD_RE.exec(t);
      if (fm && !["type", "struct", "interface", "func", "map", "chan"].includes(fm[1]!)) {
        const typeText = fm[2]!;
        const base = typeText.split(",")[0]!.trim();
        push({ name: fm[1]!, kind: "property", dataType: base.slice(0, 120), file: relFile, line: i + 1, span: { character: code.indexOf(fm[1]!), length: fm[1]!.length }, container: structName.name, tier: "structural" });
        continue;
      }
    }
    const vm = VAR_LINE_RE.exec(t);
    if (vm) {
      push({ name: vm[1]!, kind: "variable", dataType: vm[2]!, file: relFile, line: i + 1, span: { character: code.indexOf(vm[1]!), length: vm[1]!.length }, tier: "structural" });
      continue;
    }
    const fn = FUNC_RE.exec(t);
    if (fn) {
      const recv = fn[1]?.trim();
      const name = fn[2]!;
      const container = recv?.split(/\s+/)[1] ?? recv?.split("*")[1];
      push({
        name, kind: container ? "method" : "function", file: relFile, line: i + 1,
        span: { character: t.indexOf(name), length: name.length },
        ...(container ? { container } : {}), tier: "structural",
      });
      continue;
    }
    const td = TYPE_DECL_RE.exec(t);
    if (td) {
      push({ name: td[1]!, kind: "type", file: relFile, line: i + 1, span: { character: t.indexOf(td[1]!), length: td[1]!.length }, tier: "structural" });
      continue;
    }
    // := 短赋值字面量推断(lexical 如实;函数体内也收——typed 档面向文件阅读)
    const sa = SHORT_ASSIGN_RE.exec(code);
    if (sa) {
      const t2 = inferGoLiteral(sa[3]!.split("#")[0] ?? "");
      if (t2) {
        push({ name: sa[2]!, kind: "variable", dataType: t2, file: relFile, line: i + 1, span: { character: code.indexOf(sa[2]!), length: sa[2]!.length }, tier: "lexical" });
      }
    }
  }
  return { file: relFile, language: "go", symbols };
}
