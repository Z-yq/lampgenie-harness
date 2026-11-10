/**
 * board_upsert action=evidence 批量回填(2026-10-31,token 成本优化第三轮):
 * 原来一次只能回填一个节点,3 节点板要跑 3 次(每步 ~18k input token)。
 * - evidenceByNode 一次回填多节点;空数组跳过该键;
 * - negative:含不存在节点时,**其它节点的证据照落盘**,回执单独点名 ghost(不整次丢弃);
 * - 旧路径 nodeId+evidence 回执文案逐字不变(回归);
 * - schema 体量:压缩描述后 board_upsert 的 parameters 序列化 < 5200 字符。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { saveBoard, loadBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-batch-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 播两个普通节点(跳过落板门:本测只验 evidence 写路径,不验 P0 契约)。 */
function seed(root: string, ids = ["n1", "n2"], p0 = false): void {
  const s = saveBoard(root, {
    version: 1, taskId: "t1", sessionId: "s1", title: "批量回填板", status: "draft", rev: 0,
    nodes: ids.map((id) => ({
      id, kind: "module" as const, label: `节点${id}`,
      summary: `节点 ${id} 的实现细节,用于撑起渲染文本长度`,
      change: "add" as const,
      ...(p0 ? { phase: "P0" as const, targets: ["apps/gateway/src/agent-wiring.ts"], accept: [{ cmd: `run ${id}`, expect: "ok" }] } : {}),
    })),
    edges: [], planned_files: [], updatedAt: 0,
  }, { skipGates: true });
  expect(s.ok).toBe(true);
}

describe("① evidenceByNode 一次回填多节点", () => {
  it("两个节点的 evidence 都落盘,回执给「已回填 N 个节点共 M 条证据」", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence",
      evidenceByNode: {
        n1: [{ cmd: "pnpm vitest run a.test.ts", ok: true, output: "3 passed" }],
        n2: [{ cmd: "pnpm vitest run b.test.ts", ok: false, output: "1 failed" }, { cmd: "curl /health", ok: true }],
      },
    }));
    expect(out).toContain("已回填 2 个节点共 3 条证据(2 通过)");
    const doc = loadBoard(r, "s1", "t1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    expect(n1.evidence).toHaveLength(1);
    expect(n1.evidence![0]!.cmd).toBe("pnpm vitest run a.test.ts");
    expect(n1.evidence![0]!.at).toBeGreaterThan(0); // 服务端补时间
    expect(n2.evidence).toHaveLength(2);
    expect(n2.evidence!.filter((e) => e.ok)).toHaveLength(1);
    expect(doc.rev).toBe(1); // 一次调用只自增一次 rev
  });

  it("空数组的键跳过(不报错、不阻塞其它节点)", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence",
      evidenceByNode: { n1: [], n2: [{ cmd: "echo ok", ok: true }] },
    }));
    expect(out).toContain("已回填 1 个节点共 1 条证据(1 通过)");
    expect(loadBoard(r, "s1", "t1")!.nodes.find((n) => n.id === "n1")!.evidence ?? []).toHaveLength(0);
    expect(loadBoard(r, "s1", "t1")!.nodes.find((n) => n.id === "n2")!.evidence).toHaveLength(1);
  });

  it("nodeId 与 evidenceByNode 同时给:两者都处理", async () => {
    const r = tmp();
    seed(r, ["n1", "n2", "n3"]);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence", nodeId: "n3", evidence: [{ cmd: "legacy cmd", ok: true }],
      evidenceByNode: { n1: [{ cmd: "a", ok: true }] },
    }));
    expect(out).toContain("已回填 2 个节点共 2 条证据(2 通过)");
    const doc = loadBoard(r, "s1", "t1")!;
    for (const id of ["n1", "n3"]) {
      expect(doc.nodes.find((n) => n.id === id)!.evidence, id).toHaveLength(1);
    }
  });
});

describe("② negative:evidenceByNode 含不存在节点", () => {
  it("n1 证据仍落盘,回执点名 ghost;rev 只增一次", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence",
      evidenceByNode: { n1: [{ cmd: "pnpm tsc --noEmit", ok: true }], ghost: [{ cmd: "x", ok: true }] },
    }));
    expect(out).toContain("板上没有节点 ghost");
    expect(out).toContain("已回填 1 个节点共 1 条证据(1 通过)");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.find((n) => n.id === "n1")!.evidence).toHaveLength(1); // 合法回填没被丢弃
    expect(doc.rev).toBe(1);
  });

  it("全部节点都不存在 → 不写盘,点名全部", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence",
      evidenceByNode: { ghost1: [{ cmd: "x", ok: true }], ghost2: [{ cmd: "y", ok: true }] },
    }));
    expect(out).toContain("板上没有节点 ghost1、ghost2");
    expect(out).toContain("证据未落盘");
    expect(loadBoard(r, "s1", "t1")!.rev).toBe(0);
  });
});

describe("③ 旧路径回归(nodeId + evidence)", () => {
  it("回执文案与行为逐字不变", async () => {
    const r = tmp();
    seed(r, ["p0a"], true);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence", nodeId: "p0a", evidence: [{ cmd: "run p0a", ok: false, output: "1 failed" }],
    }));
    expect(out.startsWith("已回填 p0a 的 1 条证据(0 通过)。")).toBe(true);
    expect(out).toContain("P0 落目标覆盖率 0/1");
    expect(out).not.toContain("个节点共"); // 单节点不走新文案
    expect(loadBoard(r, "s1", "t1")!.nodes[0]!.evidence).toHaveLength(1);
  });

  it("单节点缺 nodeId 仍回旧提示", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    expect(String(await tool.execute({ action: "evidence" }))).toContain("需要 nodeId");
  });

  it("单节点节点不存在 → 旧点名文案(含现有 id 清单)", async () => {
    const r = tmp();
    seed(r);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({ action: "evidence", nodeId: "ghost", evidence: [{ cmd: "x", ok: true }] }));
    expect(out).toContain("板上没有节点 ghost(现有:n1, n2");
    expect(loadBoard(r, "s1", "t1")!.rev).toBe(0);
  });

  it("status 语义不变:多节点回填也走 P0 全绿门", async () => {
    const r = tmp();
    seed(r, ["p0a", "p0b"], true);
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await tool.execute({
      action: "evidence", status: "done",
      evidenceByNode: { p0a: [{ cmd: "run p0a", ok: true }] },
    }));
    expect(out).toContain("P0 未全绿(1/2)");
    expect(loadBoard(r, "s1", "t1")!.status).toBe("draft");
    const out2 = String(await tool.execute({
      action: "evidence", status: "done",
      evidenceByNode: { p0b: [{ cmd: "run p0b", ok: true }] },
    }));
    expect(out2).not.toContain("P0 未全绿");
    expect(loadBoard(r, "s1", "t1")!.status).toBe("done");
  });
});

describe("④ schema 体量(压缩冗长散文描述)", () => {
  it("board_upsert.parameters 序列化 < 5200 字符;枚举外的值整板拒收提示保留", () => {
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", tmp(), tmp());
    const s = JSON.stringify(tool.parameters);
    expect(s.length).toBeLessThan(5200);
    const P = tool.parameters.properties as Record<string, { description?: string; enum?: unknown[]; items?: { properties?: Record<string, { description?: string; enum?: unknown[] }> } }>;
    expect(P["nodes"]!.items!.properties!["kind"]!.description).toContain("枚举外的值整板拒收");
    // 结构信息零改动:枚举项数与 required 原样
    expect(P["boardType"]!.enum).toHaveLength(15);
    expect(P["status"]!.enum).toEqual(["draft", "implementing", "done"]);
    expect(P["nodes"]!.items!.properties!["kind"]!.enum).toHaveLength(20);
    expect((tool.parameters as { required?: string[] }).required).toEqual([]);
  });
});