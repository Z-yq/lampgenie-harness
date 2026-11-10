/**
 * scope 前缀 × 显式边的幂等性(缺陷复现):
 * planner 调 board_upsert 时传 scope="bp",节点 id **已自带** `bp-` 前缀(bp-space/bp-selbar…),
 * 并提交 8 条显式边(from/to 用同一批带前缀 id)。回执说「显式 8 条」,board_read 回读却只有引擎
 * 推导的 virtual 边——显式边被静默丢弃。
 *
 * 断言:合并后 edges 里这 8 条显式边都在,且 from/to 都能解析到真实存在的节点。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { loadBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-scope-edges-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const IDS = ["bp-space", "bp-marquee", "bp-selbar", "bp-actionbar", "bp-merge", "bp-save", "bp-detail", "bp-render", "bp-persist"];

/** 显式边(带 label,from/to 全是已带 `bp-` 前缀的 id)。 */
const EDGES = [
  { from: "bp-space", to: "bp-marquee", kind: "data" as const, label: "拖拽矩形 → 选框几何" },
  { from: "bp-marquee", to: "bp-selbar", kind: "data" as const, label: "选框 → 命中元素集" },
  { from: "bp-selbar", to: "bp-actionbar", kind: "nav" as const, label: "选中非空 → 浮出操作条" },
  { from: "bp-actionbar", to: "bp-merge", kind: "nav" as const, label: "点击合并 → 进入合并态" },
  { from: "bp-merge", to: "bp-save", kind: "data" as const, label: "合并结果 → 待落盘节点" },
  { from: "bp-save", to: "bp-persist", kind: "data" as const, label: "节点变更 → 白板 JSON" },
  { from: "bp-save", to: "bp-render", kind: "nav" as const, label: "落盘成功 → 重绘画布" },
  { from: "bp-render", to: "bp-detail", kind: "nav" as const, label: "点节点 → 详情面板" },
];

function payload(): Record<string, unknown> {
  return {
    title: "白板框选/合并",
    nodes: IDS.map((id, i) => ({
      id,
      kind: "component" as const,
      label: id.replace("bp-", ""),
      summary: `第 ${i + 1} 块`,
      change: "add" as const,
    })),
    edges: EDGES,
  };
}

describe("scope 重写对「id 已带该 scope 前缀」的节点/边端点幂等", () => {
  it("scope=bp + 节点 id 已带 bp- 前缀:8 条显式边全部落盘且端点可解析", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "bp");
    const out = String(await tool.execute(payload()));
    expect(out).toContain("设计白板已更新");

    const doc = loadBoard(r, "s1", "t1")!;
    // 节点没被套娃成 bp-bp-space
    expect(doc.nodes.map((n) => n.id).sort()).toEqual([...IDS].sort());
    // 8 条显式边一条不少,且 from/to 都指向真实节点
    const ids = new Set(doc.nodes.map((n) => n.id));
    const explicit = doc.edges.filter((e) => !(e as { virtual?: boolean }).virtual);
    expect(explicit.length).toBe(8);
    for (const e of EDGES) {
      const hit = explicit.find((x) => x.from === e.from && x.to === e.to);
      expect(hit, `显式边 ${e.from}->${e.to} 被丢弃`).toBeTruthy();
      expect(hit!.label).toBe(e.label);
      expect(hit!.kind).toBe(e.kind);
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    }
  });

  it("scope=bp + 节点 id 混用(部分裸 id):边端点统一改成同一套带前缀 id", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "bp");
    const out = String(await tool.execute({
      title: "混合 id 板",
      nodes: [
        { id: "bp-space", kind: "component", label: "space", summary: "s", change: "add" },
        { id: "selbar", kind: "component", label: "selbar", summary: "s", change: "add" },
        { id: "bp-render", kind: "component", label: "render", summary: "s", change: "add" },
      ],
      // 一条两端都写裸 id(space 已带前缀 / selbar 裸),一条两端都写带前缀 id
      edges: [
        { from: "space", to: "selbar", kind: "data", label: "裸写端点" },
        { from: "bp-selbar", to: "bp-render", kind: "nav", label: "前缀写端点" },
      ],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("已剔除"); // 无悬空边
    const doc = loadBoard(r, "s1", "t1")!;
    const ids = new Set(doc.nodes.map((n) => n.id));
    expect([...ids].sort()).toEqual(["bp-render", "bp-selbar", "bp-space"]);
    const explicit = doc.edges.filter((e) => !(e as { virtual?: boolean }).virtual);
    expect(explicit.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["bp-selbar->bp-render", "bp-space->bp-selbar"]);
    for (const e of explicit) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it("scope=bp 的边引用板上别的写者节点:端点不被本写者前缀污染成悬空", async () => {
    const r = tmp();
    // 主 agent 先落一块别人的节点
    await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "主板",
      nodes: [
        { id: "kb-ingest", kind: "module", label: "摄取", summary: "s", change: "add" },
        { id: "kb-index", kind: "module", label: "索引", summary: "s", change: "add" },
      ],
      edges: [{ from: "kb-ingest", to: "kb-index", kind: "data", label: "脏 doc_id" }],
    });
    const sub = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "bp");
    const out = String(await sub.execute({
      title: "子板",
      nodes: [
        { id: "bp-space", kind: "component", label: "space", summary: "s", change: "add" },
        { id: "bp-selbar", kind: "component", label: "selbar", summary: "s", change: "add" },
      ],
      // 跨写者边:本写者节点 → 别人已有节点
      edges: [{ from: "bp-selbar", to: "kb-index", kind: "data", label: "选中项 → 索引重建" }],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("已剔除");
    const doc = loadBoard(r, "s1", "t1")!;
    const explicit = doc.edges.filter((e) => !(e as { virtual?: boolean }).virtual);
    expect(explicit.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["bp-selbar->kb-index", "kb-ingest->kb-index"]);
  });

  it("主 agent(无 scope)提交已带任意前缀的 id:边原样保留(行为不变)", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await main.execute(payload()));
    expect(out).toContain("设计白板已更新");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.map((n) => n.id).sort()).toEqual([...IDS].sort());
    expect(doc.edges.filter((e) => !(e as { virtual?: boolean }).virtual).length).toBe(8);
  });
});
