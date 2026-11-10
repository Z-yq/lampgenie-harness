/**
 * typed/java(step-089 P1 / designs/26 §2.2):Java 逐文件 typed 提取——
 * 类字段(structural,与 adapters/java.ts recordField 同判据形态)+class/method token。
 * 与 adapters/java.ts 的关系:索引档收类字段入索引;本档补 span 面向 token 流。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBraceTracker } from "../adapters/braces";
import { readFailReason, type TypedFileResult, type TypedSymbol } from "./types";

const MODS = "(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default|transient|volatile)\\s+)*";
const CLASS_RE = new RegExp(`^${MODS}(class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)`);
const METHOD_RE = new RegExp(
  `^${MODS}(?:<[^>]+>\\s*)?` +
    "([\\w$][\\w$.<>\\[\\],\\s?]*?\\s+)?" +
    "([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)\\s*" +
    "(?:throws\\s+[^{;]+)?" +
    "[;{]",
);
const FIELD_RE = new RegExp(
  `^${MODS}` +
    "([\\w$][\\w$.<>\\[\\],\\s?]*?\\s+)" + // 类型
    "([A-Za-z_$][\\w$]*)\\s*(?:=[^;]*)?;",
);
const DENY_NAME = new Set(["if", "for", "while", "switch", "catch", "do", "try", "else", "return", "throw", "new", "finally", "class", "interface", "enum", "record", "assert", "break", "continue"]);
const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double", "void", "var"]);

export async function extractJavaTyped(root: string, relFile: string): Promise<TypedFileResult> {
  let text: string;
  try {
    text = await readFile(join(root, relFile), "utf-8");
  } catch (err) {
    return { file: relFile, language: "java", symbols: [], degraded: { reason: `读取失败: ${readFailReason(err)}` } };
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
  const classStack: { name: string; depth: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const depthBefore = tracker.depth;
    const { code, depth: depthAfter } = tracker.feed(lines[i]!);
    while (classStack.length && depthAfter < classStack[classStack.length - 1]!.depth) classStack.pop();
    let probe = code.trim();
    if (!probe) continue;
    if (probe.startsWith("@")) probe = probe.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, "").trim();
    if (!probe) continue;
    const cm = CLASS_RE.exec(probe);
    if (cm) {
      const container = classStack[classStack.length - 1]?.name;
      const name = cm[2]!;
      const kind = cm[1] === "interface" ? "interface" : cm[1] === "enum" ? "enum" : "class";
      push({
        name, kind, file: relFile, line: i + 1,
        span: { character: probe.indexOf(name), length: name.length },
        ...(container ? { container } : {}), tier: "structural",
      });
      if (depthAfter > depthBefore) classStack.push({ name, depth: depthAfter });
      continue;
    }
    const top = classStack[classStack.length - 1];
    const mm = METHOD_RE.exec(probe);
    if (mm && mm[2] && !DENY_NAME.has(mm[2])) {
      const container = top?.name;
      push({
        name: mm[2], kind: "method", file: relFile, line: i + 1,
        span: { character: probe.indexOf(mm[2]), length: mm[2].length },
        ...(container ? { container } : {}), tier: "structural",
      });
      continue;
    }
    if (top) {
      const fm = FIELD_RE.exec(probe);
      if (fm) {
        const typeText = fm[1]!.trim().replace(/\s+/g, " ");
        const first = typeText.split(/[<\s]/)[0] ?? "";
        const name = fm[2]!;
        if ((/^[A-Z]/.test(first) || PRIMITIVES.has(first)) && !DENY_NAME.has(name)) {
          push({
            name, kind: "property", dataType: typeText.slice(0, 120), file: relFile, line: i + 1,
            span: { character: probe.indexOf(name), length: name.length },
            container: top.name, tier: "structural",
          });
        }
      }
    }
  }
  return { file: relFile, language: "java", symbols };
}
