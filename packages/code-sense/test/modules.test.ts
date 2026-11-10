/**
 * 七期:代码→工作流模块整理(fileToModules/classifySymbol)。
 * 分类矩阵用合成索引(确定性);回归用 harness 真实盘上索引(在场则跑,缺则 skip——索引是构建产物)。
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadIndex, fileToModules, classifySymbol, type C2fIndex, type C2fNode } from "../src/index.js";

function node(partial: Partial<C2fNode> & { id: string; name: string; file: string }): C2fNode {
  return { line: 1, kind: "regular", outCount: 0, inCount: 0, ...partial } as C2fNode;
}

function fakeIndex(nodes: C2fNode[], edges: { from: string; to: string; line?: number }[]): C2fIndex {
  const byFile: Record<string, string[]> = {};
  const byName: Record<string, string[]> = {};
  for (const n of nodes) {
    (byFile[n.file] ??= []).push(n.id);
    (byName[n.name] ??= []).push(n.id);
  }
  return {
    version: 1, root: "/repo", gitHead: "", builtAt: 0, buildMs: 0, nodes,
    edges: edges.map((e) => ({ from: e.from, to: e.to, toName: "", file: "f.ts", line: e.line ?? 1, kind: "import" as const })),
    byFile, byName,
  };
}

describe("classifySymbol(工作流类型分类矩阵)", () => {
  it("名字词表优先,结构守门(start 要 trunk,end 要 leaf)", () => {
    expect(classifySymbol(node({ id: "a", name: "bootServer", file: "f.ts", kind: "trunk", inCount: 0 }))).toBe("start");
    expect(classifySymbol(node({ id: "b", name: "bootServer", file: "f.ts", inCount: 3 }))).not.toBe("start"); // 非入口结构
    expect(classifySymbol(node({ id: "c", name: "fetchUserApi", file: "f.ts" }))).toBe("http");
    expect(classifySymbol(node({ id: "d", name: "chatComplete", file: "f.ts" }))).toBe("llm");
    expect(classifySymbol(node({ id: "e", name: "retrieveKnowledge", file: "f.ts" }))).toBe("retrieval");
    expect(classifySymbol(node({ id: "f", name: "classifyIntent", file: "f.ts" }))).toBe("classifier");
    expect(classifySymbol(node({ id: "g", name: "mergeResults", file: "f.ts" }))).toBe("aggregate");
    expect(classifySymbol(node({ id: "h", name: "validateInput", file: "f.ts" }))).toBe("decision"); // 决策词表最高优先
    expect(classifySymbol(node({ id: "i", name: "renderMarkdown", file: "f.ts" }))).toBe("template");
    expect(classifySymbol(node({ id: "j", name: "plainWorker", file: "f.ts" }))).toBe("function");
    // 结构兜底:无名词表的 trunk=start,leaf=end
    expect(classifySymbol(node({ id: "k", name: "zzz", file: "f.ts", kind: "trunk", inCount: 0 }))).toBe("start");
    expect(classifySymbol(node({ id: "l", name: "zzz", file: "f.ts", kind: "leaf" }))).toBe("end");
  });
});

describe("fileToModules(索引→模块节点+真实调用边)", () => {
  it("节点=文件内符号;边=文件内真实调用;跨文件目标单列不造节点", () => {
    const idx = fakeIndex(
      [
        node({ id: "f.ts#main", name: "main", file: "f.ts", kind: "trunk", inCount: 0 }),
        node({ id: "f.ts#fetchApi", name: "fetchApi", file: "f.ts", inCount: 1 }),
        node({ id: "f.ts#renderOut", name: "renderOut", file: "f.ts", kind: "leaf" }),
        node({ id: "other.ts#external", name: "external", file: "other.ts" }),
      ],
      [
        { from: "f.ts#main", to: "f.ts#fetchApi", line: 5 },
        { from: "f.ts#fetchApi", to: "f.ts#renderOut", line: 9 },
        { from: "f.ts#main", to: "other.ts#external", line: 6 }, // 跨文件:进 crossFileTargets
        { from: "other.ts#external", to: "f.ts#renderOut", line: 2 }, // 外部调入:不进边表(from 不在文件)
      ],
    );
    const m = fileToModules(idx, "f.ts");
    expect(m.nodes).toHaveLength(3);
    expect(m.nodes.find((n) => n.label === "main")?.kind).toBe("start");
    expect(m.nodes.find((n) => n.label === "fetchApi")?.kind).toBe("http");
    expect(m.nodes.find((n) => n.label === "renderOut")?.kind).toBe("template"); // render 命中 template 词表
    expect(m.edges).toHaveLength(2); // 只有文件内边
    expect(m.crossFileTargets.map((c) => c.name)).toEqual(["external"]);
    // symbolRef 全部指向真实符号
    for (const n of m.nodes) expect(n.symbolRef.line).toBeGreaterThanOrEqual(1);
  });

  it("回归:harness 真实索引(在场时)——board-store 整理出真实节点与调用边", () => {
    const root = process.cwd().replace(/\/packages\/code-sense$/, "");
    const idx = loadIndex(root);
    if (!idx) return; // 索引是构建产物,缺席即 skip(vitest 无显式 skip 判据时静默过)
    const m = fileToModules(idx, "apps/gateway/src/board-store.ts");
    expect(m.nodes.length).toBeGreaterThanOrEqual(8);
    expect(m.nodes.some((n) => n.label === "saveBoard")).toBe(true);
    expect(m.edges.length).toBeGreaterThanOrEqual(5); // 真实调用边(boardDir→seg 等)
    const ids = new Set(m.nodes.map((n) => n.id));
    for (const e of m.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });
});
