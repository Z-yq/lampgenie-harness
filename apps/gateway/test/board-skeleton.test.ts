/**
 * board_upsert action=skeleton(现状层骨架自动预填)单测:
 * - 纯函数 buildSkeleton/normalizeSkeletonRequest:多候选全收、零命中进 unresolved、
 *   maxNodes 截断进 truncated、边只收两端在集、kind 映射、id 幂等;
 * - 端到端(真仓真符号,禁 mock 索引行号):真仓索引 → skeleton 落盘 → 回执 snapshot 三字段 →
 *   audit ok 且 symbolIssues 空 → 逐节点 locateSymbolInText 断言锚真实。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { buildSkeleton, normalizeSkeletonRequest, SKELETON_MAX_NODES } from "../src/board-skeleton.js";
import { loadBoardAsync, locateSymbolInText } from "../src/board-store.js";
import { repoRoot } from "../src/repo-root.js";
import { loadIndex } from "@lampgenie/code-sense";
import type { C2fIndex } from "@lampgenie/code-sense";

let tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs = []; });

/** 手工合成小索引:同名重载双节点 + 孤儿候选 + 跨组边。 */
function fakeIndex(): C2fIndex {
  const nodes = [
    { id: "src/a.ts#alpha", name: "alpha", file: "src/a.ts", line: 1, kind: "regular", symKind: "function", sig: { params: [{ name: "x", type: "number" }], returnType: "void" }, inCount: 3, outCount: 5 },
    { id: "src/b.ts#alpha", name: "alpha", file: "src/b.ts", line: 10, kind: "regular", symKind: "method", inCount: 1, outCount: 1 },
    { id: "src/c.ts#gamma", name: "gamma", file: "src/c.ts", line: 20, kind: "leaf", symKind: "class", inCount: 0, outCount: 2 },
    { id: "src/d.ts#delta", name: "delta", file: "src/d.ts", line: 30, kind: "trunk", inCount: 2, outCount: 0 },
    { id: "src/e.ts#noSig", name: "noSig", file: "src/e.ts", line: 40, kind: "regular", symKind: "arrow", inCount: 0, outCount: 0 },
    { id: "src/f.ts#edgeless", name: "edgeless", file: "src/f.ts", line: 50, kind: "leaf", inCount: 0, outCount: 0 },
  ] as C2fIndex["nodes"];
  const byName: Record<string, string[]> = {};
  const byFile: Record<string, string[]> = {};
  for (const n of nodes) {
    (byName[n.name] ??= []).push(n.id);
    (byFile[n.file] ??= []).push(n.id);
  }
  return {
    version: 1, root: "/r", gitHead: "ref: refs/heads/master", headSha: "abc123", builtAt: 1770000000000, buildMs: 1,
    extractorVersion: 6,
    nodes,
    edges: [
      { from: "src/a.ts#alpha", to: "src/c.ts#gamma", toName: "gamma", file: "src/a.ts", line: 2, kind: "import" },
      { from: "src/a.ts#alpha", to: "src/d.ts#delta", toName: "delta", file: "src/a.ts", line: 3, kind: "import" },
      { from: "src/a.ts#alpha", to: "src/a.ts#alpha", toName: "alpha", file: "src/a.ts", line: 4, kind: "this" },
      { from: "src/f.ts#edgeless", to: "src/c.ts#gamma", toName: "gamma", file: "src/f.ts", line: 51, kind: "import" },
      { from: "src/a.ts#alpha", to: "src/a.ts#alpha", toName: "alpha", file: "src/a.ts", line: 2, kind: "import" },
      { from: "src/z.ts#outside", to: "src/c.ts#gamma", toName: "gamma", file: "src/z.ts", line: 1, kind: "unique" },
    ],
    byFile, byName,
  } as unknown as C2fIndex;
}

describe("board-skeleton 纯函数", () => {
  it("多候选全收 + 零命中进 unresolved + kind 映射 + id 幂等", () => {
    const r = buildSkeleton(fakeIndex(), { symbols: ["alpha", "gamma", "noSig", "noThere"] });
    expect(r.unresolved).toEqual(["noThere"]);
    const alphas = r.nodes.filter((n) => n.symbolRef.name === "alpha");
    expect(alphas.length).toBe(2); // 重名双节点全收
    expect(alphas[0]!.symbolRef.file).toBe("src/a.ts"); // in+out 更高的枢纽排前
    expect(alphas[1]!.symbolRef.file).toBe("src/b.ts");
    expect(alphas.every((n) => n.kind === "function")).toBe(true); // function/method → function
    expect(r.nodes.find((n) => n.symbolRef.name === "gamma")!.kind).toBe("module"); // class → module
    // id 幂等:同符号重复生成得同 id;id 前缀 sk- 且消毒
    const again = buildSkeleton(fakeIndex(), { symbols: ["alpha"] });
    expect(again.nodes.map((n) => n.id).every((id) => id.startsWith("sk-"))).toBe(true);
    expect(new Set(again.nodes.map((n) => n.id)).size).toBe(again.nodes.length); // 组内无重复 id
    // keep 语义 + summary 含签名/未收录
    expect(r.nodes.every((n) => n.change === "keep" && n.targets.length === 1 && n.targets[0] === n.symbolRef.file)).toBe(true);
    expect(r.nodes.find((n) => n.symbolRef.name === "alpha")!.summary).toContain("(x: number) → void");
    expect(r.nodes.find((n) => n.symbolRef.name === "noSig")!.summary).toContain("签名未收录");
  });

  it("边只收两端在集 + 同向去重 + 自环/外节点边剔除", () => {
    const r = buildSkeleton(fakeIndex(), { symbols: ["alpha", "gamma", "delta"] });
    const ids = new Set(r.nodes.map((n) => n.id));
    expect(r.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(r.edges.every((e) => e.kind === "call")).toBe(true);
    const keys = r.edges.map((e) => `${e.from}->${e.to}`);
    expect(new Set(keys).size).toBe(keys.length); // 同向去重(alpha→alpha 出现两次)
    expect(keys.some((k) => k.includes("->sk-src_a_ts_alpha-s"))).toBe(false); // 自环剔除(消毒后形态不精确,语义断言改下面)
    expect(r.edges.every((e) => e.from !== e.to)).toBe(true);
    // edgeless(在集但只有它引用别人的边)不在 symbols 里=不生成,其出边自然不在
    expect(r.nodes.some((n) => n.symbolRef.name === "edgeless")).toBe(false);
  });

  it("maxNodes 截断进 truncated;钳 ≤40;symbols 去重 ≤20", () => {
    const r = buildSkeleton(fakeIndex(), { symbols: ["alpha", "gamma", "delta", "noSig"], maxNodes: 3 });
    expect(r.nodes.length).toBe(3);
    expect(r.truncated.some((t) => t.startsWith("candidates:"))).toBe(true);
    const norm = normalizeSkeletonRequest({ symbols: Array.from({ length: 30 }, (_, i) => `s${i}`), maxNodes: 99 });
    expect(norm.ok && norm.symbols.length).toBe(20);
    expect(norm.ok && norm.truncatedSymbols.length).toBe(10);
    expect(norm.ok && norm.maxNodes).toBe(SKELETON_MAX_NODES);
    const bad = normalizeSkeletonRequest({ symbols: ["onlyOne"] });
    expect(bad.ok).toBe(false); // 有效候选 <2 → 错误态由调用方拒
  });
});

describe("board_upsert action=skeleton 端到端(真仓真符号)", () => {
  it("落盘 keep 节点/symbolRef/targets 齐;audit ok 且 symbolIssues 空;行号与磁盘实况对上", async () => {
    const rr = repoRoot();
    const index = loadIndex(rr);
    if (!index) return; // 索引缺席环境(冷 CI)跳过:本用例锚「真仓真符号」,不造假索引
    const store = mkdtempSync(join(tmpdir(), "gh-skel-"));
    tmpDirs.push(store);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "skel-e2e", rr, store);
    const out = JSON.parse(String(await tool.execute({ action: "skeleton", symbols: ["resolveBoardLinks", "mergeBoardNodes", "saveBoard"] })));
    expect(out.status).toBe("ok");
    expect(out.snapshot.builtAt).toBeTruthy();
    expect(typeof out.snapshot.gitHead).toBe("string");
    expect("extractorVersion" in out.snapshot).toBe(true);
    // 板落盘:keep 节点 + symbolRef + targets 齐
    const doc = await loadBoardAsync(store, "s1", "skel-e2e");
    expect(doc && doc.nodes.length).toBeGreaterThan(0);
    const keep = doc!.nodes.filter((n) => n.symbolRef);
    expect(keep.length).toBeGreaterThan(0);
    expect(keep.every((n) => n.change === "keep")).toBe(true);
    expect(keep.every((n) => (n.targets?.length ?? 0) > 0)).toBe(true);
    // 行号真实性(禁 mock):逐节点读磁盘文件用 locateSymbolInText 比对
    for (const n of keep) {
      const text = readFileSync(join(rr, n.symbolRef!.file!), "utf-8");
      const line = locateSymbolInText(text, { name: n.symbolRef!.name });
      expect(line).toBe(n.symbolRef!.line);
    }
    // audit(真仓板目录=store;符号核对走 taskRoot=rr 的索引):ok 且 symbolIssues 空
    const auditOut = JSON.parse(String(await boardUpsertTool(new MemoryJournal(), "s1", "skel-e2e", rr, store).execute({ action: "audit", format: "json" })));
    expect(auditOut.ok).toBe(true);
    expect(auditOut.symbolIssues).toEqual([]);
  });
});
