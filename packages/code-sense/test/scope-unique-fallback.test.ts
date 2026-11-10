/**
 * 唯一名兜底的词法作用域闸(2026-10-26 整仓 flow 前置修复)。
 * 实锚:整仓模块图出现 `packages/code-sense → apps/gateway ×851` 假主干——`import { join }
 * from "node:path"` 的 join 被连到测试文件里的同名小工具;`handler(payload)` 参数被连到另一个
 * 包的 handler;`dirOf(...)` 回调参数被连到 ExperienceStore.dirOf。
 * 规则:本文件有局部绑定(import/参数/变量)时,只允许同文件声明或 import 真来源文件;自由标识符
 * 保持原唯一名兜底语义(不改变真边召回)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildC2fIndex } from "../src/callgraph/c2f";

async function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "scope-fallback-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return buildC2fIndex(dir);
}

const resolved = (idx: Awaited<ReturnType<typeof buildC2fIndex>>): string[] =>
  idx.edges.filter((e) => e.to).map((e) => `${e.from} -> ${e.to}`);

describe("唯一名兜底作用域闸", () => {
  it("外部 import 与仓内同名符号不再误连(join@node:path)", async () => {
    const idx = await build({
      "a.ts": 'import { join } from "node:path";\nexport function f(x: string){ return join(x, "y"); }\n',
      "b.ts": "export function join(a: string, b: string){ return a + b; }\n",
    });
    expect(resolved(idx)).toEqual([]);
  }, 60_000);

  it("CJS require 解构(外部包)不吸仓内同名符号(node:path join 实锚)", async () => {
    const idx = await build({
      "a.js": 'const { join } = require("node:path");\nfunction f(){ return join("a", "b"); }\n',
      "b.js": "function join(a, b){ return a + b; }\nmodule.exports = { join };\n",
    });
    expect(resolved(idx).some((e) => e.endsWith("#join"))).toBe(false);
  }, 60_000);

  it("参数/局部变量绑定不跨文件吸同名函数(handler/dirOf 实锚)", async () => {
    const idx = await build({
      "a.ts": "export function emit(set: Set<(x: string) => void>){\n  for (const handler of set) handler(\"x\");\n}\nexport function scan(dirOf: (t: string) => string){ return dirOf(\"t\"); }\n",
      "b.ts": "export function handler(x: string){ return x; }\nexport class Store { static dirOf(t: string){ return t; } }\n",
    });
    expect(resolved(idx)).toEqual([]);
  }, 60_000);

  it("真 import(同仓模块)与同文件调用照常保留", async () => {
    const idx = await build({
      "a.ts": 'import { helper } from "./b";\nexport function f(){ return helper(); }\nexport const arrow = () => 1;\nexport function sameFile(){ return arrow(); }\n',
      "b.ts": "export function helper(){ return 1; }\n",
    });
    const edges = resolved(idx);
    expect(edges.some((e) => e.startsWith("a.ts#f -> b.ts#helper"))).toBe(true);
    expect(edges.some((e) => e.startsWith("a.ts#sameFile -> a.ts#arrow"))).toBe(true);
  }, 60_000);

  it("自由标识符保持唯一名兜底(无局部绑定)", async () => {
    const idx = await build({
      "a.ts": "export function f(){ return helper(); }\n",
      "b.ts": "export function helper(){ return 1; }\n",
    });
    expect(resolved(idx).some((e) => e.startsWith("a.ts#f -> b.ts#helper"))).toBe(true);
  }, 60_000);
});
