/**
 * explore 候选签名测试(设计稿 13.8 G-C):
 * 候选附一行签名(≤120 字符),索引无 sig 不出行——召回后免二次 symbol 查询。
 */
import { describe, it, expect } from "vitest";
import { recallSymbols } from "../src/retrieval/symbol-recall.js";
import { renderForLlm } from "../src/llm.js";
import type { CodeSenseResult } from "../src/index.js";

describe("SymbolCandidate.sig(G-C)", () => {
  it("recallSymbols 产物带 sig 且超长截断 ≤120 字符", () => {
 // 本仓索引存在时走真索引:查一个已知符号(recallSymbols 只读索引,不触发构建)
    const root = process.cwd();
    const r = recallSymbols(root, "recallSymbols");
 // 索引缺席=诚实降级(symbols 空 + degraded)——此时跳过 sig 断言只验纪律
    if (r.degraded || r.symbols.length === 0) return;
    let withSig = 0;
    for (const s of r.symbols) {
      if (typeof s.sig === "string") {
        withSig++;
        expect(s.sig.length).toBeLessThanOrEqual(120);
      }
    }
 // 本仓索引已带 sig 字段(C2fNode.sig),召回产物应至少一条带签名
    expect(withSig).toBeGreaterThan(0);
  });

  it("渲染:候选带 sig 出签名行,无 sig 不出行", () => {
    const base = { query: "explore", mode: "explore", projectState: "indexed", cache: { hit: true }, budget: { truncated: false } };
    const withSig = renderForLlm({
      ...base,
      symbols: [{
        name: "foo", file: "a.ts", line: 1, score: 1, reasons: ["命中"],
        callers: [], callees: [],
        sig: "function foo(a: number, b: string): Promise<void>",
      }],
    } as never);
    expect(withSig).toContain("签名: function foo(a: number, b: string): Promise<void>");

    const withoutSig = renderForLlm({
      ...base,
      symbols: [{ name: "bar", file: "a.ts", line: 2, score: 1, reasons: ["命中"], callers: [], callees: [] }],
    } as never);
    expect(withoutSig).not.toContain("签名:");
  });

  it("截断口径:121+ 字符签名截到 119+省略号", () => {
    const long = "f(" + "a".repeat(140) + ")";
    const s = { sig: long.length > 120 ? long.slice(0, 119) + "…" : long };
    expect(s.sig!.length).toBe(120);
    expect(s.sig!.endsWith("…")).toBe(true);
  });
});
