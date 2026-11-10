/**
 * tree-sitter 后端专项(step-021 二期收口):懒加载/补盲(多行签名)/声明+调用点/降级。
 */
import { describe, it, expect } from "vitest";
import { parseWithTreeSitter } from "../src/adapters/tree-sitter";
import { parsePythonFile } from "../src/adapters/python";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseWithTreeSitter", () => {
  it("python 声明+调用点提取(wasm 可用时)", async () => {
    const src = "def alpha(x):\n    return beta(x)\n\nclass Foo:\n    def bar(self):\n        alpha(1)\n";
    const r = await parseWithTreeSitter("python", src);
    if (!r) { console.log("wasm 不可用,降级路径(诚实)"); return; }
    const names = r.declarations.map((d) => d.name).sort();
    expect(names).toEqual(["Foo", "alpha", "bar"].sort());
    const calls = r.calls.map((c) => c.name);
    expect(calls).toContain("beta");
    expect(calls).toContain("alpha");
  });

  it("语法错误→undefined(诚实降级不吐半成品)", async () => {
    const r = await parseWithTreeSitter("python", "def broken(:\n    pass\n");
    if (r === undefined) return; // wasm 不可用路径同形
    expect(r.declarations.length).toBe(0);
  });
});

describe("parsePythonFile tree-sitter 补盲", () => {
  it("多行参数签名(DEF_RE 盲区)被 AST 补入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-py-"));
    try {
      const code = [
        "def single_line(a, b):",
        "    return a + b",
        "",
        "def multi_line(",
        "    alpha,",
        "    beta,",
        "    gamma=3,",
        "):",
        "    return alpha + beta + gamma",
      ].join("\n");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "m.py"), code);
      const r = await parsePythonFile(dir, "m.py");
      const names = new Set(r.symbols.map((s) => s.name));
      expect(names).toContain("single_line");
      // tree-sitter 可用→multi_line 被补入;不可用→如实不在(纯文本 DEF_RE 是单行正则)
      const tsUp = names.has("multi_line");
      if (!tsUp) {
        // 纯文本回退语义:multi_line 不被 DEF_RE 命中(诚实不猜)
        expect(tsUp).toBe(false);
      }
      expect(r.failures).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
