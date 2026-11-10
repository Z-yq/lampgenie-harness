/**
 * board-diagram 单测:BoardDoc → SVG 出图端到端(真跑 flowkit 编译/导出,不 mock)。
 * 覆盖任务书的 6 条断言 + 失败不抛(空板/脏 label/缺失节点)。
 */
import { describe, it, expect } from "vitest";
import type { BoardDoc } from "@lampgenie/protocol";
import { renderBoardSvg, warmupBoardDiagram } from "../src/board-diagram.js";

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
    taskId: "t-diagram",
    sessionId: "s-diagram",
    title: "出图板",
    status: "draft",
    boardType: "code",
    rev: 0,
    nodes,
    edges: edges.map((e) => ({ kind: "call", ...e })),
    planned_files: [],
  } as unknown as BoardDoc;
}

/** 5 节点:1 decision / 1 带 group / 1 带 label 的边。 */
function sampleDoc(): BoardDoc {
  return mkDoc(
    [
      mkNode("n-start", "任务开始", "start", { summary: "入口" }),
      mkNode("n-read", "读配置", "function", { summary: "解析 config.json", group: "01 采集" }),
      mkNode("n-pick", "配置合法?", "decision", { summary: "校验必填项", group: "01 采集" }),
      mkNode("n-write", "落盘结果", "function", { summary: "写 output.json" }),
      mkNode("n-note", "注意事项", "note", { summary: "失败回滚" }),
    ],
    [
      { from: "n-start", to: "n-read" },
      { from: "n-read", to: "n-pick", label: "已读到" },
      { from: "n-pick", to: "n-write", label: "是" },
      { from: "n-pick", to: "n-note", label: "否" },
    ],
  );
}

describe("renderBoardSvg", () => {
  it("出 SVG:以 <svg 开头 + 含节点 label + 无 W101 + 耗时 <3000ms", async () => {
    const r = await renderBoardSvg(sampleDoc());
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.svg.startsWith("<svg")).toBe(true);
    expect(r.svg.trimEnd().endsWith("</svg>")).toBe(true);
    for (const label of ["任务开始", "读配置", "配置合法?", "落盘结果", "注意事项"]) {
      expect(r.svg).toContain(label);
    }
    expect(r.diagnostics.some((d) => d.code === "W101")).toBe(false);
    expect(r.elapsedMs).toBeLessThan(3000);
    expect(r.elapsedMs).toBeGreaterThan(0);
  });

  it("空 nodes → ok:false + E_EMPTY,不抛错", async () => {
    let res: Awaited<ReturnType<typeof renderBoardSvg>> | undefined;
    await expect(
      (async () => {
        res = await renderBoardSvg(mkDoc([]));
      })(),
    ).resolves.toBeUndefined();
    expect(res?.ok).toBe(false);
    expect(res?.svg).toBe("");
    expect(res?.diagnostics[0]).toMatchObject({ line: 0, code: "E_EMPTY", severity: "error", message: "板上没有节点" });
  });

  it("入参 doc 为 undefined 也不抛,返回 ok:false", async () => {
    const r = await renderBoardSvg(undefined as unknown as BoardDoc);
    expect(r.ok).toBe(false);
    expect(r.svg).toBe("");
    expect(r.diagnostics[0]?.code).toBe("E_EMPTY");
  });

  it("脏 label(含 { } [ ] | : 与换行)也能出 SVG,且清洗 warnings 带出", async () => {
    const dirty = mkDoc(
      [
        mkNode("d1", "配置 {a:b}", "function", { summary: "含 | 与 [x]" }),
        mkNode("d2", "换行\n标签", "function"),
        mkNode("d3", "判定?", "decision"),
      ],
      [{ from: "d1", to: "d3", label: "真:{条件}" }],
    );
    const r = await renderBoardSvg(dirty);
    expect(r.ok).toBe(true);
    expect(r.svg.startsWith("<svg")).toBe(true);
    expect(r.svg).toContain("配置 （a；b）");
    expect(r.diagnostics.some((d) => d.code === "W101")).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "W_SANITIZE")).toBe(true);
  });

  it("theme=dark 可出图", async () => {
    const r = await renderBoardSvg(sampleDoc(), { theme: "dark" });
    expect(r.ok).toBe(true);
    expect(r.svg.startsWith("<svg")).toBe(true);
  });

  it("纯 note 单节点板也能出图(最小图)", async () => {
    const r = await renderBoardSvg(mkDoc([mkNode("only", "唯一节点", "note")]));
    expect(r.ok).toBe(true);
    expect(r.svg).toContain("唯一节点");
  });

  it("warmupBoardDiagram 幂等且不抛", async () => {
    await expect(warmupBoardDiagram()).resolves.toBeUndefined();
    await expect(warmupBoardDiagram()).resolves.toBeUndefined();
  });
});