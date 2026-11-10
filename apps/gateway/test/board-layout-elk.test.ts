/**
 * board-layout-elk 单测:自实现 wrapping 布局(createBoardElkLayout)接进 board-diagram 后,
 * 真 flowkit 出图的 **宽高比** 必须落进目标区间(单列长链 → 接近 16:9)。
 *
 * 断言的是 viewBox 的 w/h(实测基线:改前 17 节点 5.45:1、60 节点 2.47:1)。
 * 覆盖:①17 节点 3 groups ②60 节点 6 groups ③带环图 ④带边 label ⑤布局器抛错时的回退。
 */
import { describe, it, expect } from "vitest";
import type { BoardDoc } from "@lampgenie/protocol";
import { renderBoardSvg } from "../src/board-diagram.js";
import { createBoardElkLayout, ELK_EQ_OPTIONS } from "../src/board-layout-elk.js";

type NodeIn = BoardDoc["nodes"][number];

function mkNode(id: string, label: string, kind: NodeIn["kind"], extra: Partial<NodeIn> = {}): NodeIn {
  return {
    id,
    kind,
    label,
    summary: "s",
    change: "modify",
    done: false,
    comments: [],
    flow: [],
    ...extra,
  } as NodeIn;
}

function mkDoc(nodes: NodeIn[], edges: Array<{ from: string; to: string; label?: string }> = []): BoardDoc {
  return {
    version: 1,
    taskId: "t-layout",
    sessionId: "s-layout",
    title: "布局板",
    status: "draft",
    boardType: "code",
    rev: 0,
    nodes,
    edges: edges.map((e) => ({ kind: "call", ...e })),
    planned_files: [],
  } as unknown as BoardDoc;
}

/** 链式 n 个节点 + groups 个 group(按序平均分配);返回 doc 与链。 */
function chainDoc(n: number, groups: number, labelEdges = false): BoardDoc {
  const nodes: NodeIn[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `n${i}`;
    ids.push(id);
    const g = groups > 0 ? `0${Math.floor((i * groups) / n) + 1} 阶段 ${(i * groups) / n + 1 | 0}` : undefined;
    nodes.push(
      mkNode(id, `步骤 ${i} 处理 ${i % 3 === 0 ? "数据" : "配置"}`, i === 0 ? "start" : i === n - 1 ? "end" : "function", {
        ...(g ? { group: `0${Math.floor((i * groups) / n) + 1} 阶段` } : {}),
        summary: `第 ${i} 步`,
      }),
    );
  }
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  for (let i = 0; i + 1 < n; i += 1) {
    edges.push({ from: ids[i]!, to: ids[i + 1]!, ...(labelEdges ? { label: `流转 ${i}` } : {}) });
  }
  return mkDoc(nodes, edges);
}

/** 从 SVG 里取 viewBox 的 w/h。 */
function viewBoxOf(svg: string): { w: number; h: number; ratio: number } {
  const m = /viewBox="([^"]+)"/.exec(svg);
  expect(m, "SVG 必须有 viewBox").toBeTruthy();
  const parts = m![1]!.trim().split(/[\s,]+/).map(Number);
  expect(parts.length).toBe(4);
  const w = parts[2]!;
  const h = parts[3]!;
  expect(w).toBeGreaterThan(0);
  expect(h).toBeGreaterThan(0);
  return { w, h, ratio: w / h };
}

describe("createBoardElkLayout(自实现 wrapping 布局)", () => {

  it("导出等价 ELK 参数(SEPARATE_CHILDREN + MULTI_EDGE + aspectRatio)", () => {
    expect(ELK_EQ_OPTIONS["elk.hierarchyHandling"]).toBe("SEPARATE_CHILDREN");
    expect(ELK_EQ_OPTIONS["elk.layered.wrapping.strategy"]).toBe("MULTI_EDGE");
    expect(Number(ELK_EQ_OPTIONS["elk.aspectRatio"])).toBeGreaterThan(1);
  });

  it("run 返回 {positions, sizes},位置覆盖所有节点,根尺寸 >= 内容", async () => {
    const layout = createBoardElkLayout({ aspectRatio: 1.6 });
    const out = await layout.run({
      rootId: "__root__",
      rootPadding: { top: 28, left: 28, bottom: 28, right: 28 },
      groupPadding: { top: 30, left: 22, bottom: 22, right: 22 },
      direction: "right",
      nodes: [
        { id: "a", size: { width: 200, height: 88 } },
        { id: "b", size: { width: 200, height: 88 } },
        { id: "g1", size: { width: 0, height: 0 }, minSize: { width: 180, height: 132 } },
        { id: "c", parentId: "g1", size: { width: 200, height: 88 } },
        { id: "d", parentId: "g1", size: { width: 200, height: 88 } },
      ],
      edges: [
        { id: "e1", sourceId: "a", targetId: "b" },
        { id: "e2", sourceId: "b", targetId: "c" },
        { id: "e3", sourceId: "c", targetId: "d" },
      ],
    });
    for (const id of ["a", "b", "g1", "c", "d"]) expect(out.positions[id], `${id} 有坐标`).toBeTruthy();
    expect(out.sizes.g1!.width).toBeGreaterThan(200);
    expect(out.sizes.__root__!.width).toBeGreaterThan(out.sizes.g1!.width);
  });

  it("有环图(A→B→C→A)run 不抛且坐标有限(回边反转)", async () => {
    const layout = createBoardElkLayout({});
    const out = await layout.run({
      rootId: "__root__",
      direction: "right",
      nodes: ["a", "b", "c"].map((id) => ({ id, size: { width: 200, height: 88 } })),
      edges: [
        { id: "e1", sourceId: "a", targetId: "b" },
        { id: "e2", sourceId: "b", targetId: "c" },
        { id: "e3", sourceId: "c", targetId: "a" },
      ],
    });
    for (const id of ["a", "b", "c"]) {
      expect(Number.isFinite(out.positions[id]!.x)).toBe(true);
      expect(Number.isFinite(out.positions[id]!.y)).toBe(true);
    }
  });

  it("带 label 的边撑开列间距(aspectRatio 逼成单行,宽度必须多出标签宽度)", async () => {
    // aspectRatio=20 时折行没有收益,两版都只能排单行 → 宽度差异全部来自标签占位。
    const nodes = ["a", "b", "c"].map((id) => ({ id, size: { width: 200, height: 88 } }));
    const mkEdges = (withLabel: boolean) => [
      { id: "e1", sourceId: "a", targetId: "b", ...(withLabel ? { label: { width: 140, height: 24 } } : {}) },
      { id: "e2", sourceId: "b", targetId: "c" },
    ];
    const plain = await createBoardElkLayout({ aspectRatio: 20 }).run({
      rootId: "__root__",
      direction: "right",
      nodes,
      edges: mkEdges(false),
    });
    const labeled = await createBoardElkLayout({ aspectRatio: 20 }).run({
      rootId: "__root__",
      direction: "right",
      nodes,
      edges: mkEdges(true),
    });
    expect(labeled.sizes.__root__!.width - plain.sizes.__root__!.width).toBeGreaterThanOrEqual(140);
  });
});

describe("renderBoardSvg 宽高比(真 flowkit)", () => {
  it("17 节点 + 3 groups → 1.2 ≤ ratio ≤ 2.4", async () => {
    const r = await renderBoardSvg(chainDoc(17, 3));
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    const { ratio } = viewBoxOf(r.svg);
    expect(ratio).toBeGreaterThanOrEqual(1.2);
    expect(ratio).toBeLessThanOrEqual(2.4);
  }, 30000);

  it("60 节点 + 6 groups → ratio ≤ 2.6(不劣于改前 2.47)", async () => {
    const r = await renderBoardSvg(chainDoc(60, 6));
    expect(r.ok).toBe(true);
    const { ratio } = viewBoxOf(r.svg);
    expect(ratio).toBeLessThanOrEqual(2.6);
  }, 60000);

  it("带环图(A→B→C→A)出图不抛错,ratio 在范围内", async () => {
    const doc = mkDoc(
      [mkNode("a", "采集", "function"), mkNode("b", "判定", "decision"), mkNode("c", "回写", "function")],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a" },
      ],
    );
    const r = await renderBoardSvg(doc);
    expect(r.ok).toBe(true);
    expect(r.svg).toContain("采集");
    const { ratio } = viewBoxOf(r.svg);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThanOrEqual(3);
  }, 30000);

  it("带边 label 的图不抛错,ratio 在范围内", async () => {
    const doc = chainDoc(17, 3, true);
    const r = await renderBoardSvg(doc);
    expect(r.ok).toBe(true);
    const { ratio } = viewBoxOf(r.svg);
    expect(ratio).toBeGreaterThanOrEqual(1.2);
    expect(ratio).toBeLessThanOrEqual(2.4);
  }, 30000);

  it("布局器 run 抛错 → 回退到内置布局,ok=true 且诊断含 W_LAYOUT_WRAP_FALLBACK", async () => {
    const r = await renderBoardSvg(chainDoc(6, 2), {
      layout: {
        run: () => Promise.reject(new Error("layout boom: injected")),
      },
    });
    expect(r.ok).toBe(true);
    expect(r.svg.startsWith("<svg")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "W_LAYOUT_WRAP_FALLBACK")).toBe(true);
  }, 30000);
});
