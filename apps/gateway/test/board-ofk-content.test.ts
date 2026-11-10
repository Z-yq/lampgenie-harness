/**
 * board-ofk 内容层级单测:「是什么(label)→ 有什么用(summary 首句)→ 在哪(锚 chip)」。
 * 背景(17 节点真板经验证):一个节点 `<text>` 宽 933px、节点卡 790px,desc 被 flowkit 硬切且
 * 没有省略号——读者看不出摘要被截了、也看不到锚段。本文件锁三件事:
 *   1) summary 只取首句,并按 DESC_LABEL_BUDGET 显式截断(带 `…`);
 *   2) 锚段(<⟩file⟨>)与 flow 概述在任何 summary 长度下都完整保留;
 *   3) 边 label 缺失时用 kind 兜底关系词并记 warning(来源是数据,不是编造)。
 * 形态断言之外还**真喂 flowkit**(renderBoardSvg)确认无 E_ 前缀错误码、无 W101 丢行。
 */
import { describe, it, expect } from "vitest";
import type { BoardDoc } from "@lampgenie/protocol";
import { serializeBoard, firstSentence, DESC_LABEL_BUDGET, DESC_MAX } from "../src/board-ofk.js";
import { renderBoardSvg } from "../src/board-diagram.js";

type NodeIn = BoardDoc["nodes"][number];

function mkNode(id: string, label: string, extra: Partial<NodeIn> = {}): NodeIn {
  return {
    id,
    kind: "function",
    label,
    summary: "s",
    change: "keep",
    done: false,
    comments: [],
    flow: [],
    ...extra,
  } as NodeIn;
}

function mkDoc(
  nodes: NodeIn[],
  edges: Array<{ from: string; to: string; label?: string; kind?: string; virtual?: boolean }> = [],
  patch: Partial<BoardDoc> = {},
): BoardDoc {
  return {
    version: 1,
    taskId: "t-content",
    sessionId: "s-content",
    title: "内容层级板",
    boardType: "code",
    status: "draft",
    rev: 0,
    nodes,
    edges: edges.map((e) => ({ kind: "call", ...e })),
    planned_files: [],
    ...patch,
  } as unknown as BoardDoc;
}

/** 取某节点行里 desc 字段的值。 */
function descOf(ofk: string, id: string): string {
  const line = ofk.split("\n").find((l) => l.trim().startsWith(`${id} [`)) ?? "";
  return /desc: "([^"]*)"/.exec(line)?.[1] ?? "";
}

const ANCHOR = "⟨TaskSupervisor.submit @ task-manager.ts:60⟩";

describe("firstSentence(「有什么用」只取首句)", () => {
  it("按 。；;｜| 切第一个并去掉句末标点", () => {
    expect(firstSentence("把任务入队。剩下是补充说明")).toBe("把任务入队");
    expect(firstSentence("打开缓存；然后写盘")).toBe("打开缓存");
    expect(firstSentence("verify 通过;写回 journal")).toBe("verify 通过");
    expect(firstSentence("主路径｜次路径")).toBe("主路径");
    expect(firstSentence("a|b")).toBe("a");
  });

  it("无标点/空串/首字即标点 → 原样(去尾标点)或退化", () => {
    expect(firstSentence("只有一句话")).toBe("只有一句话");
    expect(firstSentence("")).toBe("");
    expect(firstSentence("   ")).toBe("");
    expect(firstSentence("结尾带句号。")).toBe("结尾带句号");
  });

  it("首句超 DESC_LABEL_BUDGET 时显式截断(带 …)", () => {
    const { ofk, warnings } = serializeBoard(mkDoc([mkNode("n1", "长", { summary: "长".repeat(100) })]));
    const desc = descOf(ofk, "n1");
    expect(desc.length).toBe(DESC_LABEL_BUDGET);
    expect(desc.endsWith("…")).toBe(true);
    expect(warnings.some((w) => w.includes("截断"))).toBe(true);
  });
});

describe("三段形态(是什么 / 有什么用 / 在哪)", () => {
  const long200 = "超".repeat(200);
  const doc = mkDoc(
    [
      mkNode("n1", "提交任务", {
        summary: "把任务入队。补充:幂等键为 taskId",
        symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
      } as Partial<NodeIn>),
      mkNode("n2", "超长摘要", { summary: long200 }),
      mkNode("n3", "短摘要", { summary: "入队" }),
    ],
    [
      { from: "n1", to: "n2", kind: "call" },
      { from: "n2", to: "n3", kind: "verify", label: "验收" },
    ],
  );
  const { ofk, warnings } = serializeBoard(doc);

  it("带锚节点:首句 + 完整锚段,补充说明被首句裁掉", () => {
    const desc = descOf(ofk, "n1");
    expect(desc).toBe(`把任务入队 · ${ANCHOR}`);
    expect(desc).not.toContain("补充");
  });

  it("200 字 summary:desc 带 … 且总长不超预算", () => {
    const desc = descOf(ofk, "n2");
    expect(desc.includes("…")).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(DESC_MAX);
    expect(warnings.some((w) => w.includes("截断"))).toBe(true);
  });

  it("5 字 summary 不被无谓截断(短摘要零改动)", () => {
    expect(descOf(ofk, "n3")).toBe("入队");
  });

  it("锚段完整:极长 summary 也从 summary 侧收,desc 以锚段结尾", () => {
    const r = serializeBoard(
      mkDoc([
        mkNode("a1", "长锚", {
          summary: long200,
          symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 },
        } as Partial<NodeIn>),
      ]),
    );
    const desc = descOf(r.ofk, "a1");
    expect(desc.endsWith(ANCHOR)).toBe(true);
    expect(desc.length).toBeLessThanOrEqual(DESC_MAX + ANCHOR.length + 3);
  });

  it("锚段极长(预算不足 DESC_SUMMARY_MIN)→ 锚段前置,summary 仍在但更短", () => {
    const r = serializeBoard(
      mkDoc([
        mkNode("a2", "长锚", {
          summary: "把任务入队并写回 journal,同时广播状态",
          symbolRef: { name: "A".repeat(72), file: "apps/gateway/src/some/deep/task-manager.ts", line: 12 },
        } as Partial<NodeIn>),
      ]),
    );
    const desc = descOf(r.ofk, "a2");
    expect(desc.startsWith("⟨")).toBe(true);
    expect(desc).toContain("⟩");
    expect(desc).toContain("把任务入队");
  });

  it("flow 概述不被 summary 挤没(summary 超长 + branch flow)", () => {
    const r = serializeBoard(
      mkDoc([
        mkNode("f1", "带流程", {
          summary: long200,
          flow: [{ type: "branch" as const, cond: "c", then: [{ type: "step" as const, text: "A" }], else: [] }],
        }),
      ]),
    );
    const desc = descOf(r.ofk, "f1");
    expect(desc).toContain("分支");
    expect(desc.length).toBeLessThanOrEqual(DESC_MAX);
  });

  it("真喂 flowkit:3 节点 doc 出图 ok,无 E_*/W101 丢行", async () => {
    const r = await renderBoardSvg(doc);
    const bad = r.diagnostics.filter((d) => d.code.startsWith("E_") || d.code === "W101");
    expect(r.ok, `诊断:${JSON.stringify(r.diagnostics)}`).toBe(true);
    expect(bad.map((d) => d.code)).toEqual([]);
    expect(r.svg.startsWith("<svg")).toBe(true);
  }, 60000);
});

describe("change 上色稳定(有无 change/未知值都不抛)", () => {
  it("add/modify/delete 上色,keep/未知/缺省不上色", () => {
    const cases: Array<[string | undefined, string]> = [
      ["add", "green"],
      ["modify", "orange"],
      ["delete", "red"],
      ["keep", ""],
      ["unknown-kind", ""],
      [undefined, ""],
    ];
    for (const [change, want] of cases) {
      const n = mkNode("c1", "着色", { summary: "x" });
      if (change === undefined) delete (n as { change?: unknown }).change;
      else (n as { change?: unknown }).change = change;
      const { ofk } = serializeBoard(mkDoc([n]));
      expect(() => ofk).not.toThrow();
      if (want) expect(ofk).toContain(`color: ${want}`);
      else expect(ofk).not.toContain("color:");
    }
  });
});

describe("边关系词(label → DSL;label 缺失用 kind 兜底并记 warning)", () => {
  const nodes = ["e1", "e2", "e3", "e4", "e5", "e6"].map((id) => mkNode(id, id));

  it("label 非空:逐字写进 DSL,不兜底", () => {
    const { ofk, warnings } = serializeBoard(mkDoc(nodes, [{ from: "e1", to: "e2", kind: "call", label: "主流程" }]));
    expect(ofk).toContain("e1 -> e2 : 主流程");
    expect(warnings.some((w) => w.includes("兜底"))).toBe(false);
  });

  it("label 空 + kind=call → `: 调用` + warning", () => {
    const { ofk, warnings } = serializeBoard(mkDoc(nodes, [{ from: "e1", to: "e2", kind: "call" }]));
    expect(ofk).toContain("e1 -> e2 : 调用");
    expect(warnings).toContain("edge e1->e2: label 缺失,已用 kind=call 兜底");
  });

  it("五种 kind 的关系词", () => {
    const { ofk, warnings } = serializeBoard(
      mkDoc(nodes, [
        { from: "e1", to: "e2", kind: "call" },
        { from: "e2", to: "e3", kind: "data" },
        { from: "e3", to: "e4", kind: "verify" },
        { from: "e4", to: "e5", kind: "nav" },
        { from: "e5", to: "e6", kind: "contains" },
      ]),
    );
    expect(ofk).toContain("e1 -> e2 : 调用");
    expect(ofk).toContain("e2 -> e3 : 数据");
    expect(ofk).toContain("e3 --> e4 : 验证");
    expect(ofk).toContain("e4 --> e5 : 跳转");
    expect(ofk).toContain("e5 -- e6 : 包含");
    expect(warnings.filter((w) => w.includes("已用 kind=")).length).toBe(5);
  });

  it("virtual 人工边同样兜底", () => {
    const { ofk, warnings } = serializeBoard(
      mkDoc(nodes, [{ from: "e1", to: "e2", kind: "call", virtual: true } as never]),
    );
    expect(ofk).toContain("e1 --> e2 : 调用");
    expect(warnings).toContain("edge e1->e2: label 缺失,已用 kind=call 兜底");
  });

  it("kind 不在兜底表 → 不编造关系词,只记一条说明", () => {
    const { ofk, warnings } = serializeBoard(mkDoc(nodes, [{ from: "e1", to: "e2", kind: "mystery" }]));
    expect(ofk).toContain("e1 -> e2");
    expect(ofk).not.toContain("e1 -> e2 :");
    expect(warnings).toContain("edge e1->e2: label 缺失且 kind=mystery 无可映射关系词");
  });

  it("兜底关系词可被 flowkit 编译(无 W101/W102)", async () => {
    const doc = mkDoc(nodes, [
      { from: "e1", to: "e2", kind: "call" },
      { from: "e2", to: "e3", kind: "contains" },
    ]);
    const r = await renderBoardSvg(doc);
    const bad = r.diagnostics.filter((d) => ["W101", "W102"].includes(d.code) || d.code.startsWith("E_"));
    expect(r.ok, `诊断:${JSON.stringify(r.diagnostics)}`).toBe(true);
    expect(bad.map((d) => d.code)).toEqual([]);
  }, 60000);
});
