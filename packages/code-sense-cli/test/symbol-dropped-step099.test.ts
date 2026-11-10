/**
 * (RC-096-B5)symbol 面弃边可见性:formatSymbolHit 在命中名有构建期弃边台账或
 * 索引内未解析边时追加「弃边与不可见」行;无则零行(默认输出逐字节不变)。
 * impact 面同源口径在 packages/code-sense/test/impact-step099.test.ts 锚定。
 */
import { describe, it, expect } from "vitest";
import { formatSymbolHit, type RepoState } from "../src/mcp-core";
import type { C2fIndex, SymbolQueryResult } from "@lampgenie/code-sense";

function fakeRepo(over: Partial<C2fIndex>): RepoState {
  const index: C2fIndex = {
    version: 1,
    root: "/r",
    gitHead: "",
    builtAt: 0,
    buildMs: 0,
    nodes: [
      { id: "m/a.py#has_access", name: "has_access", file: "m/a.py", line: 3, kind: "regular", outCount: 0, inCount: 0 },
    ],
    edges: [],
    byFile: { "m/a.py": ["m/a.py#has_access"] },
    byName: { has_access: ["m/a.py#has_access"] },
    ...over,
  };
  return { root: "/r", name: "demo", index, stale: false };
}

function fakeHit(): SymbolQueryResult {
  return {
    symbol: { id: "m/a.py#has_access", name: "has_access", file: "m/a.py", line: 3, kind: "regular", outCount: 0, inCount: 0 },
    callers: [],
    callees: [],
  };
}

describe(" RC-B5:symbol 面弃边行", () => {
  it("有台账:追加数量+原因行(与 impact 面同口径)", () => {
    const s = fakeRepo({
      dropped: { has_access: { count: 15, reasons: { "同名候选非唯一(收窄后仍有 3 处待选)": 15 }, samples: [{ file: "x.py", line: 1 }] } },
      droppedNames: 1,
    });
    const text = formatSymbolHit(s, fakeHit());
    expect(text).toContain("弃边与不可见");
    expect(text).toContain("同名调用候选构建期被弃 15 处");
    expect(text).toContain("同名候选非唯一");
  });

  it("有未解析边(无台账):如实报未解析计数", () => {
    const s = fakeRepo({
      edges: [
        { from: "m/b.py#f", to: "", toName: "has_access", file: "m/b.py", line: 9, kind: "unresolved" },
        { from: "m/c.py#g", to: "m/a.py#has_access", toName: "has_access", file: "m/c.py", line: 5, kind: "unique" },
      ],
    });
    const text = formatSymbolHit(s, fakeHit());
    expect(text).toContain("未解析边 1 处"); // 只计 to="" 的
    expect(text).not.toContain("同名调用候选构建期被弃");
  });

  it("无弃边无未解析:零行(默认输出不含弃边段)", () => {
    const text = formatSymbolHit(fakeRepo({}), fakeHit());
    expect(text).not.toContain("弃边与不可见");
  });
});
