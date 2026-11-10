/**
 * board-sense 转换器( D1)单测:
 * modulemap(跨模块真实调用聚合)/archmap(evidence 分级)/sequence(时序链)/pageflow(页面流)→ BoardDoc 形态;
 * 每条断言锚「边来自真实索引/推断如实标注/序与异步边界入标签」;产物过 BoardDocZ+边完整性(saveBoard 真存)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleMapBoard, archGraphBoard, sequenceBoard, pageFlowBoard, pageStructureBoard } from "../src/board-sense.js";
import { saveBoard } from "../src/board-store.js";
import type { C2fIndex } from "@lampgenie/code-sense";

let tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs = []; });

function fakeIndex(): C2fIndex {
  // 三模块:packages/core(2 文件)/packages/runtime(1 文件)/apps/gateway(1 文件);
  // 真实调用:gateway→core ×2,gateway→runtime ×1,core 内部 ×1(不出边),runtime→core ×1
  return {
    version: 1, root: "/r", gitHead: "", builtAt: 0, buildMs: 0,
    nodes: [],
    edges: [
      { from: "apps/gateway/src/server.ts#h", to: "packages/core/src/journal.ts#J.append", toName: "J.append", file: "apps/gateway/src/server.ts", line: 1, kind: "import" },
      { from: "apps/gateway/src/server.ts#h", to: "packages/core/src/task.ts#T.submit", toName: "T.submit", file: "apps/gateway/src/server.ts", line: 2, kind: "import" },
      { from: "apps/gateway/src/server.ts#h2", to: "packages/runtime/src/loop.ts#L.run", toName: "L.run", file: "apps/gateway/src/server.ts", line: 3, kind: "import" },
      { from: "packages/core/src/task.ts#T.submit", to: "packages/core/src/journal.ts#J.append", toName: "J.append", file: "packages/core/src/task.ts", line: 9, kind: "this" },
      { from: "packages/runtime/src/loop.ts#L.run", to: "packages/core/src/task.ts#T.submit", toName: "T.submit", file: "packages/runtime/src/loop.ts", line: 5, kind: "import" },
    ],
    byFile: {
      "packages/core/src/journal.ts": ["packages/core/src/journal.ts#J", "packages/core/src/journal.ts#J.append"],
      "packages/core/src/task.ts": ["packages/core/src/task.ts#T"],
      "packages/runtime/src/loop.ts": ["packages/runtime/src/loop.ts#L"],
      "apps/gateway/src/server.ts": ["apps/gateway/src/server.ts#h"],
    },
    byName: {},
  } as unknown as C2fIndex;
}

describe("board-sense 转换器", () => {
  it("modulemap:模块节点+跨模块真实调用聚合边(×N 计数与索引一致),模块内调用不出边", () => {
    const b = moduleMapBoard(fakeIndex());
    expect(b.nodes.length).toBe(3);
    const byId = new Map(b.nodes.map((n) => [n.id, n]));
    expect(byId.has("packages_core") && byId.has("apps_gateway")).toBe(true);
    const gwToCore = b.edges.find((e) => e.from === "apps_gateway" && e.to === "packages_core");
    expect(gwToCore?.label).toBe("调用×2"); // 两条真实边聚合成一条
    expect(b.edges.some((e) => e.from === e.to)).toBe(false); // 无自环
    expect(b.edges.every((e) => e.kind === "call")).toBe(true);
    // 节点带入口文件 fileRef(档案跳转)与规模计数
    const core = byId.get("packages_core")!;
    expect(core.fileRef).toBe("packages/core/src/journal.ts"); // deriveModules 入口规则:journal 非入口词→第一个源文件
    expect(core.summary).toContain("符号 3");
    // 产物过 schema+边完整性(真存一轮)
    const dir = mkdtempSync(join(tmpdir(), "bs-")); tmpDirs.push(dir);
    const r = saveBoard(dir, { version: 1, taskId: "mm1", sessionId: "s1", title: b.title, status: "draft", rev: 1, nodes: b.nodes, edges: b.edges, planned_files: b.planned_files, updatedAt: 0 });
    expect(r.ok).toBe(true);
    const disk = JSON.parse(readFileSync(join(dir, ".genie/boards/s1/mm1.json"), "utf-8"));
    expect(disk.nodes.length).toBe(3);
  });

  it("archmap:evidence 分级入边标签(inferred=推断),fileRef=evidencePath", () => {
    const g = {
      nodes: [{ id: "gw", label: "网关", evidencePath: "apps/gateway/src/server.ts" }, { id: "db", label: "存储" }],
      edges: [{ from: "gw", to: "db", label: "读写", evidence: "inferred" as const }],
    };
    const b = archGraphBoard(g as never, "总体架构:网关进存储");
    expect(b.title).toContain("网关进存储");
    expect(b.nodes[0]!.fileRef).toBe("apps/gateway/src/server.ts");
    expect(b.edges[0]!.kind).toBe("data"); // inferred 不冒充验证调用
    expect(b.edges[0]!.label).toContain("推断·");
    expect(b.edges[0]!.label).toContain("读写");
  });

  it("sequence:中心符号+去重 callee,边带步序与异步边界;静态序≠运行序入标题", () => {
    const seq = {
      steps: [
        { caller: "run", callee: "loadConfig", order: 0, asyncBoundary: "sync" as const },
        { caller: "run", callee: "fetch", order: 1, asyncBoundary: "await" as const },
        { caller: "run", callee: "fetch", order: 2, asyncBoundary: "await" as const },
        { caller: "run", callee: "setTimeout", order: 3, asyncBoundary: "timer" as const },
      ],
      mermaid: "", asyncBoundaries: 3,
    };
    const b = sequenceBoard("run", "src/app.ts", seq);
    expect(b.title).toContain("语句序≠运行序");
    expect(b.nodes.length).toBe(4); // run + 3 去重 callee
    const fetchEdge = b.edges.find((e) => e.to !== "run" && b.nodes.find((n) => n.id === e.to)?.label === "fetch");
    expect(fetchEdge?.label).toBe("第2,3步 await"); // 重复 callee 步序合并
    const center = b.nodes[0]!;
    expect(center.symbolRef?.name).toBe("run");
    expect(center.flow.length).toBe(4); // 步序进 flow(明细卡可见)
  });

  it("pageflow:页面=io 节点,trigger 入边标签,kind 映射(navigates→call/submits→verify)", () => {
    const pf = {
      pages: [
        { id: "p1", route: "/", file: "pages/Home.tsx", components: ["App"] },
        { id: "p2", route: "/settings", file: "pages/Settings.tsx", components: [] },
      ],
      edges: [{ from: "p1", to: "p2", kind: "navigates" as const, trigger: "点击[设置]按钮", evidence: { path: "pages/Home.tsx", line: 9 }, tier: "semantic" as const }],
      mermaid: "", routerDetected: true,
    };
    const b = pageFlowBoard(pf as never);
    expect(b.nodes.length).toBe(2);
    expect(b.nodes[0]!.kind).toBe("io");
    expect(b.nodes[0]!.fileRef).toBe("pages/Home.tsx");
    expect(b.edges[0]!.kind).toBe("call");
    expect(b.edges[0]!.label).toContain("点击[设置]按钮");
  });

  it("空输入安全:modulemap 空索引→空节点(调用方显式报错,不产出空板)", () => {
    const b = moduleMapBoard({ ...fakeIndex(), byFile: {}, edges: [] });
    expect(b.nodes.length).toBe(0);
    expect(b.edges.length).toBe(0);
  });
});

describe("pageStructureBoard 页面结构板转换器", () => {
  it("页面/区块/组件三类节点+contains 归属边+nav 导航边(trigger 入标签)", () => {
    const b = pageStructureBoard({
      pages: [
        { name: "签署首页", route: "/", summary: "发起签署", sections: ["文件上传区", "签署人表单"], components: ["签名板"] },
        { name: "签署详情页", route: "/sign/:id", sections: ["进度条"] },
      ],
      navs: [
        { from: "签署首页", to: "签署详情页", trigger: "点击[开始签署]" },
        { from: "签署首页", to: "不存在的页面", trigger: "幽灵跳转" }, // 规划不完整:丢弃不编造
      ],
    });
    const byKind = new Map<string, number>();
    for (const n of b.nodes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
    expect(byKind.get("page")).toBe(2);
    expect(byKind.get("section")).toBe(3);
    expect(byKind.get("component")).toBe(1);
    expect(b.edges.filter((e) => e.kind === "contains").length).toBe(4);
    const nav = b.edges.filter((e) => e.kind === "nav");
    expect(nav.length).toBe(1); // 幽灵跳转被拒收(边完整性纪律)
    expect(nav[0]!.label).toBe("点击[开始签署]");
    // 边引用完整性:全部边都挂在实际产出的节点上
    const ids = new Set(b.nodes.map((n) => n.id));
    expect(b.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    // 产物过 schema+真存(board-store 同拍)
    const dir = mkdtempSync(join(tmpdir(), "bs-page-")); tmpDirs.push(dir);
    const r = saveBoard(dir, { version: 1, taskId: "pg1", sessionId: "s1", title: b.title, status: "draft", rev: 1, docKind: "page", nodes: b.nodes, edges: b.edges, planned_files: [], updatedAt: 0 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.doc.docKind).toBe("page");
  });

  it("节点上限 60(协议同拍):大量区块被截,不产非法板", () => {
    const b = pageStructureBoard({
      pages: Array.from({ length: 16 }, (_, i) => ({
        name: "页" + i, sections: Array.from({ length: 8 }, (_, j) => "区" + i + "_" + j),
        components: Array.from({ length: 8 }, (_, j) => "件" + i + "_" + j),
      })),
    });
    expect(b.nodes.length).toBeLessThanOrEqual(60);
    expect(b.nodes.length).toBe(60); // 16 页 + 44 区块/组件截断
  });
});
