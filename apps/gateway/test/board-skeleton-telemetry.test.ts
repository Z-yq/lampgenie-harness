/**
 * board.skeleton 遥测事件(bq2,2026-11-05 板质量遥测闭环):
 * - normalize 被拒(单符号)不落事件;索引缺失早退不落事件;
 * - ok 路径:board.update 之后落 board.skeleton(status/landed/dropped 四桶/elidedRate/snapshot);
 * - rejected 路径(核验后 0 节点):落 status=rejected,landed 空、elidedRate=1。
 * stub 手段:saveIndex 把合成索引写进 tmp 根 .genie/sense-index/<sha>/index.json(loadIndex 原样读回);
 * ok 路径源文件在 tmp 根真实落盘。rejected 实测形态:幽灵文件使锚走 moved→复验失败进 movedUnresolved。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { saveIndex } from "@lampgenie/code-sense";
import type { C2fIndex } from "@lampgenie/code-sense";

let tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs = []; });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-skel-tel-"));
  tmpDirs.push(d);
  return d;
}

function fakeIndex(root: string, filesExist: boolean): C2fIndex {
  const nodes = [
    { id: "src/a.ts#alpha", name: "alpha", file: filesExist ? "src/a.ts" : "src/ghost-a.ts", line: 1, kind: "regular", symKind: "function", sig: { params: [{ name: "x", type: "number" }], returnType: "void" }, inCount: 1, outCount: 1 },
    { id: "src/c.ts#gamma", name: "gamma", file: filesExist ? "src/c.ts" : "src/ghost.ts", line: 1, kind: "leaf", symKind: "function", sig: { params: [], returnType: "void" }, inCount: 0, outCount: 0 },
  ] as C2fIndex["nodes"];
  const byName: Record<string, string[]> = {};
  const byFile: Record<string, string[]> = {};
  for (const n of nodes) {
    (byName[n.name] ??= []).push(n.id);
    (byFile[n.file] ??= []).push(n.id);
  }
  return {
    version: 1, root, gitHead: "ref: refs/heads/main", headSha: "abc123def", builtAt: 1770000000000, buildMs: 1,
    extractorVersion: 6, nodes,
    edges: [{ from: "src/a.ts#alpha", to: "src/c.ts#gamma", toName: "gamma", file: "src/a.ts", line: 2, kind: "import" }],
    byFile, byName,
  } as unknown as C2fIndex;
}

describe("board.skeleton 遥测事件", () => {
  it("normalize 被拒(单符号)不落 board.skeleton 事件", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "skeleton", symbols: ["onlyOne"] }));
    expect(out).toContain("被拒");
    expect(j.readAll().some((e) => e.kind === "board.skeleton")).toBe(false);
  });

  it("索引缺失早退不落 board.skeleton 事件", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "skeleton", symbols: ["alpha", "gamma"] }));
    expect(out).toContain("索引缺失");
    expect(j.readAll().some((e) => e.kind === "board.skeleton")).toBe(false);
  });

  it("ok 路径:board.update 之后落 board.skeleton,字段齐(landed/dropped/elidedRate/snapshot)", async () => {
    const r = tmp();
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src/a.ts"), "export function alpha(x: number): void {}\n");
    writeFileSync(join(r, "src/c.ts"), "export function gamma(): void {}\n");
    saveIndex(r, fakeIndex(r, true));
    const j = new MemoryJournal();
    const out = JSON.parse(String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "skeleton", symbols: ["alpha", "gamma"] })));
    expect(out.status).toBe("ok");
    const evs = j.readAll().filter((e) => e.kind === "board.skeleton");
    expect(evs.length).toBe(1);
    const p = evs[0]!.payload as Record<string, unknown>;
    expect(p.taskId).toBe("t1");
    expect(p.boardId).toBe("t1");
    expect(p.status).toBe("ok");
    expect(p.generated).toBe(2);
    expect((p.landed as string[]).length).toBe(2);
    expect((p.landed as string[]).every((id) => id.startsWith("sk-"))).toBe(true);
    expect(p.landedCount).toBe(2);
    expect(p.dropped).toEqual({ broken: 0, movedUnresolved: 0, targetMissing: 0, targetOutside: 0, nodesDropped: 0 });
    expect(p.elidedRate).toBe(0);
    expect(p.truncated).toBe(0);
    expect(p.unresolved).toBe(0);
    const snap = p.snapshot as Record<string, unknown>;
    expect(snap.builtAt).toBe(new Date(1770000000000).toISOString());
    expect(snap.gitHead).toBe("abc123def");
    const kinds = j.readAll().map((e) => e.kind);
    expect(kinds.indexOf("board.update")).toBeLessThan(kinds.indexOf("board.skeleton"));
  });

  it("rejected 路径(索引指向不存在的文件→核验后 0 节点):落 status=rejected,landed 空、elidedRate=1", async () => {
    const r = tmp();
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src/a.ts"), "export function alpha(x: number): void {}\n");
    saveIndex(r, fakeIndex(r, false));
    const j = new MemoryJournal();
    const out = JSON.parse(String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "skeleton", symbols: ["alpha", "gamma"] })));
    expect(out.status).toBe("rejected");
    const evs = j.readAll().filter((e) => e.kind === "board.skeleton");
    expect(evs.length).toBe(1);
    const p = evs[0]!.payload as Record<string, unknown>;
    expect(p.status).toBe("rejected");
    expect(p.generated).toBe(2);
    expect(p.landed).toEqual([]);
    expect(p.landedCount).toBe(0);
    expect(p.dropped).toEqual({ broken: 0, movedUnresolved: 2, targetMissing: 0, targetOutside: 0, nodesDropped: 2 });
    expect(p.elidedRate).toBe(1);
    expect(j.readAll().some((e) => e.kind === "board.update")).toBe(false);
  });
});
