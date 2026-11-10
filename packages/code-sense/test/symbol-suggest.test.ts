/**
 * 符号名容错建议单测(批次 B):suggestSymbolNames——
 * 注意:symbol INIT_DETECTOR --root py-mmdetection 与 symbol initdetect 都直接
 * 「未找到符号」断链,无大小写归一、无近似建议。修复面=精确未命中时
 * ①大小写归一命中 ②编辑距离≤2 近似(候选≤5,inCount 降序)。
 */
import { describe, it, expect } from "vitest";
import { suggestSymbolNames, type C2fIndex, type C2fNode } from "../src/callgraph/c2f";

function node(id: string, name: string, inCount: number): C2fNode {
  const file = id.split("#")[0]!;
  return { id, name, file, line: 1, kind: "regular", outCount: 0, inCount };
}

function index(names: { name: string; inCount: number }[]): C2fIndex {
  const nodes = names.map((n) => node(`a.py#${n.name}`, n.name, n.inCount));
  const byName: Record<string, string[]> = {};
  for (const n of nodes) (byName[n.name] ??= []).push(n.id);
  return {
    version: 1, root: "/x", gitHead: "", builtAt: 0, buildMs: 0,
    nodes, edges: [], byFile: {}, byName,
  };
}

describe("suggestSymbolNames(大小写归一+编辑距离≤2)", () => {
  const idx = index([
    { name: "init_detector", inCount: 7 },
    { name: "initDeteector", inCount: 3 },
    { name: "initDetectors", inCount: 1 },
    { name: "process_chat", inCount: 12 },
    { name: "unrelatedThing", inCount: 99 },
  ]);

  it("实测确认 1:INIT_DETECTOR → 大小写归一命中 init_detector", () => {
    expect(suggestSymbolNames(idx, "INIT_DETECTOR")).toContain("init_detector");
  });

  it("实测确认 2:initdetect → 编辑距离≤2 近似建议(含 init_detector)", () => {
    const s = suggestSymbolNames(idx, "initdetect");
    expect(s.length).toBeGreaterThan(0);
    expect(s).toContain("init_detector");
  });

  it("大小写命中排前于近似;组内 inCount 降序;候选≤5", () => {
    const s = suggestSymbolNames(idx, "INIT_DETECTORS");
    expect(s[0]).toBe("initDetectors"); // 大小写归一(唯一)
    expect(s).toContain("init_detector"); // 近似(d=2:去 s、补 _)
    expect(s.length).toBeLessThanOrEqual(5);
  });

  it("完全无关的名字不给建议;空名/极限入参不炸", () => {
    expect(suggestSymbolNames(idx, "zzzzzzzz")).toEqual([]);
    expect(suggestSymbolNames(idx, "")).toEqual([]);
    expect(suggestSymbolNames(idx, "x", 0)).toEqual([]);
  });

  it("同名精确命中场景不出现在建议里(建议面只服务 miss 路径,名字≠原名)", () => {
    const s = suggestSymbolNames(idx, "initdetect");
    expect(s).not.toContain("process_chat"); // 编辑距离远超 2
    expect(s).not.toContain("unrelatedThing");
  });
});
