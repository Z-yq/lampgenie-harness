/**
 * relink 作用域闸:属性调用/局部绑定不得按「全仓唯一同名」跨文件兜底。
 * 依据:全量索引 relink 把 400+ 个字符串 .trim 连到 RingBuffer.trim,整仓 flow 出现
 * code-sense→harness-terminal ×422 的假主干。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildIndexWithReuse } from "../src/incremental.js";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "relink-scope-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("relink 作用域闸", () => {
  it("x.trim() 属性调用不连到全仓唯一 RingBuffer.trim;参数 handler() 不连到同名函数", async () => {
    const root = fixture({
      "core/ring.ts": [
        "export class RingBuffer {",
        "  trim(): number { return 1; }",
        "}",
        "export function handler(x: string): string { return x; }",
        "",
      ].join("\n"),
      "app.ts": [
        "export function f(s: string): string {",
        "  return s.trim();",
        "}",
        "export function g(handler: (s: string) => string): string {",
        "  return handler(\"x\");",
        "}",
        "",
      ].join("\n"),
    });
    const out = await buildIndexWithReuse(root);
    const edges = out.index.edges.filter((e) => e.to);
    expect(edges.some((e) => e.to.endsWith("#RingBuffer.trim"))).toBe(false);
    expect(edges.some((e) => e.to.endsWith("#handler"))).toBe(false);
    // 未解析边仍如实保留(callForm 形态可见)
    const unresolved = out.index.edges.filter((e) => !e.to);
    expect(unresolved.some((e) => e.callForm === "prop")).toBe(true);
    expect(unresolved.some((e) => e.callForm === "bound")).toBe(true);
  }, 120_000);

  it("CJS 相对 require 的 import 形态保留 relink(工作区/相对路径是真边最后通道)", async () => {
    const root = fixture({
      "cjs/util.js": "function helper(){ return 1; }\nmodule.exports = { helper };\n",
      "cjs/app.js": 'const { helper } = require("./util");\nfunction f(){ return helper(); }\n',
    });
    const out = await buildIndexWithReuse(root);
    expect(out.index.edges.some((e) => e.to && e.to.endsWith("#helper"))).toBe(true);
  }, 120_000);
});
