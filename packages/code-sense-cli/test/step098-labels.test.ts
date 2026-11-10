/**
 * step-098 RC-B6 过度声明收敛(code_index 工具面):
 * formatSymbolHit 的 trunk 标签/空调用方文案=「索引内无」口径;弃边台账在场时
 * 直说「存在未解析同名调用」;entrypoints 工具描述同步收敛。
 */
import { describe, it, expect } from "vitest";
import { CODE_INDEX_TOOLS, formatSymbolHit, type RepoState } from "../src/mcp-core.js";
import { querySymbol, type C2fIndex, type C2fNode } from "@lampgenie/code-sense";

function fabricate(extra: Partial<C2fIndex> = {}): C2fIndex {
  const node: C2fNode = { id: "a.ts#f", name: "f", file: "a.ts", line: 1, kind: "trunk", outCount: 0, inCount: 0 };
  return {
    version: 1, root: "/x", gitHead: "", builtAt: 0, buildMs: 0,
    nodes: [node], edges: [], byFile: { "a.ts": ["a.ts#f"] }, byName: { f: ["a.ts#f"] },
    ...extra,
  } as C2fIndex;
}

function stateOf(index: C2fIndex): RepoState {
  return { root: "/x", name: "x", index, stale: false };
}

describe("step-098 RC-B6 工具面措辞不过度声明", () => {
  it("trunk 标签=索引内无调用方;无弃边时不直判无人调用", () => {
    const st = stateOf(fabricate());
    const h = querySymbol(st.index, "f")[0]!;
    const text = formatSymbolHit(st, h);
    expect(text).toContain("入口(trunk,索引内无调用方)");
    expect(text).toContain("被调用: 索引内无调用方");
    expect(text).not.toContain("无人调用");
  });

  it("弃边台账在场:空调用方文案直说可能存在真实调用方", () => {
    const st = stateOf(fabricate({
      dropped: { f: { count: 3, reasons: { "同名非唯一": 3 }, samples: [] } },
    }));
    const h = querySymbol(st.index, "f")[0]!;
    const text = formatSymbolHit(st, h);
    expect(text).toContain("被调用: 索引内无(存在未解析/被弃同名调用");
    expect(text).toContain("弃边与不可见");
    expect(text).toContain("3 处");
  });

  it("索引内未解析同名边在场:同样不直判(无台账的老索引形态)", () => {
    const idx = fabricate();
    idx.edges = [{ from: "b.ts#g", to: "", toName: "f", file: "b.ts", line: 7, kind: "unresolved" }];
    const st = stateOf(idx);
    const h = querySymbol(st.index, "f")[0]!;
    const text = formatSymbolHit(st, h);
    expect(text).toContain("存在未解析/被弃同名调用");
    expect(text).toContain("未解析边 1 处");
  });

  it("entrypoints 工具描述收敛(不再写无人调用)", () => {
    const t = CODE_INDEX_TOOLS.find((x) => x.name === "code_index_entrypoints")!;
    expect(t.description).toContain("索引内无调用方");
    expect(t.description).not.toContain("无人调用");
  });
});
