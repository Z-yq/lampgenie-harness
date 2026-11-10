/** board-derive-resolver 单测(perf 板 cp-c2/cp-c3 的回归锚):
 * ① 解析器必须返回 callee **符号名**(索引 e.to 是节点 id;原样返回 id 会让 R3 静默失效);
 * ② 索引 mtime+size 未变时不重复 parse,变更后下一次调用立即重载;
 * ③ 索引缺失时返回 undefined(不猜、不造边)。 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveIndex } from "@lampgenie/code-sense";
import { deriveBoardEdges } from "../src/board-derive.js";
import { makeCalleesResolver, clearDeriveIndexCache, deriveIndexStats } from "../src/board-derive-resolver.js";

let root = "";
const nodes = [
  { id: "src/a.ts#alpha", name: "alpha", file: "src/a.ts", line: 1, kind: "function" },
  { id: "src/b.ts#beta", name: "beta", file: "src/b.ts", line: 1, kind: "function" },
];
const edges = [{ from: "src/a.ts#alpha", to: "src/b.ts#beta" }];
const baseIndex = () => ({
  version: 5 as const, root, nodes: [...nodes], edges: [...edges],
  byName: { alpha: ["src/a.ts#alpha"], beta: ["src/b.ts#beta"] },
  byFile: {}, coverage: { files: 2, nodes: 2, edges: 1 },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gh-resolver-"));
  clearDeriveIndexCache();
});
afterEach(() => {
  clearDeriveIndexCache();
  rmSync(root, { recursive: true, force: true });
});

describe("makeCalleesResolver", () => {
  it("返回 callee 符号名而不是节点 id,且 R3 能据此连出 call 边", () => {
    saveIndex(root, baseIndex() as never);
    const resolver = makeCalleesResolver(root)!;
    expect(resolver("alpha")).toEqual(["beta"]);
    expect(resolver("beta")).toBeNull();

    const board = [
      { id: "A", targets: ["alpha"] },
      { id: "B", targets: ["beta"] },
    ];
    const out = deriveBoardEdges(board, [], { calleesOf: resolver });
    expect(out).toEqual([{ from: "A", to: "B", kind: "call", label: "alpha→beta", virtual: true }]);
  });

  it("索引未变时 mtime 短路(parse_calls 不增长),变更后重载且新符号可见", () => {
    saveIndex(root, baseIndex() as never);
    makeCalleesResolver(root);
    expect(deriveIndexStats(root).parseCalls).toBe(1);
    makeCalleesResolver(root);
    expect(deriveIndexStats(root).parseCalls).toBe(1); // 未变:不重新 parse

    // 加一个节点+边并落盘:size/mtime 变化 → 下一次 make 必须重载
    saveIndex(root, {
      ...baseIndex(),
      nodes: [...nodes, { id: "src/c.ts#gamma", name: "gamma", file: "src/c.ts", line: 1, kind: "function" }],
      edges: [...edges, { from: "src/a.ts#alpha", to: "src/c.ts#gamma" }],
      byName: { alpha: ["src/a.ts#alpha"], beta: ["src/b.ts#beta"], gamma: ["src/c.ts#gamma"] },
      coverage: { files: 3, nodes: 3, edges: 2 },
    } as never);
    const resolver = makeCalleesResolver(root)!;
    expect(deriveIndexStats(root).parseCalls).toBe(2);
    expect(resolver("alpha")).toEqual(["beta", "gamma"]);
  });

  it("索引缺失/损坏时返回 undefined,derive 不造 R3 边也不抛", () => {
    expect(makeCalleesResolver(root)).toBeUndefined();
    clearDeriveIndexCache();
    const board = [{ id: "A", targets: ["alpha"] }, { id: "B", targets: ["beta"] }];
    expect(deriveBoardEdges(board, [], { calleesOf: makeCalleesResolver(root) })).toEqual([]);
  });
});
