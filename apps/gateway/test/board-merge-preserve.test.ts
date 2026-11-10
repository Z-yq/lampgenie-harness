/**
 * 人改板保真合并(mergeBoardNodes)单测:
 * 缺陷背景:board_upsert 落整板时 nodes 全用 agent 入参,板上已有的人的痕迹
 * (node.comments / node.done / node.pos 拖拽位置 / 人新增节点)一次落板全丢。
 * 修法:合入 board-store.mergeBoardNodes——以 next 为主体与顺序,人的痕迹合回来。
 *
 * 用法样例:
 * ① agent upsert 后 node.comments/done/pos 保留,且 agent 改的 label 生效;
 * ② agent 未提交的人新增节点仍在板上,位置在尾部;
 * ③ next 显式 done:false 时尊重 false(不被 prev 的 true 覆盖);
 * ④ evidence 按 cmd 合并去重(next 优先,prev 独有 cmd 保留)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { mergeBoardNodes, saveBoard, loadBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-merge-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一块「人已经改过」的板:评论/已落实/拖拽位置/人新增节点/证据齐全。 */
function humanDoc() {
  return {
    version: 1 as const, taskId: "t1", sessionId: "s1", title: "人改过的板", status: "implementing" as const,
    rev: 3,
    nodes: [
      {
        id: "n1", kind: "module" as const, label: "旧标题", summary: "旧摘要", change: "modify" as const,
        done: true, comments: ["这里要加超时", "名字换掉"], pos: { x: 120, y: 40 },
        evidence: [{ cmd: "vitest run test/a.test.ts", ok: true, at: 11 }, { cmd: "手工点一遍", ok: false, at: 12 }],
      },
      { id: "n2", kind: "module" as const, label: "第二个", summary: "s2", change: "add" as const },
      { id: "human-1", kind: "note" as const, label: "人加的想法", summary: "人工追加节点", change: "add" as const, pos: { x: 300, y: 200 } },
    ],
    edges: [], planned_files: [], updatedAt: 0,
  };
}

describe("① mergeBoardNodes 直接语义(纯函数)", () => {
  it("comments/done/pos 从 prev 保留;label/summary 以 next 为准", () => {
    const prev = humanDoc().nodes;
    const next = [{ id: "n1", kind: "module", label: "新标题", summary: "新摘要", change: "modify" }];
    const r = mergeBoardNodes(prev, next);
    const n1 = r.nodes.find((n) => n.id === "n1")!;
    expect(n1.label).toBe("新标题");
    expect(n1.summary).toBe("新摘要");
    expect(n1.comments).toEqual(["这里要加超时", "名字换掉"]);
    expect(n1.done).toBe(true);
    expect(n1.pos).toEqual({ x: 120, y: 40 });
    expect(r.stats.comments).toBe(2);
    expect(r.stats.done).toBe(1);
    expect(r.stats.pos).toBe(1);
  });

  it("next 给了 comments 时以 next 为准(人的旧评论不叠加)", () => {
    const r = mergeBoardNodes(humanDoc().nodes, [
      { id: "n1", kind: "module", label: "t", summary: "s", change: "modify", comments: ["新评论"] },
    ]);
    expect(r.nodes[0]!.comments).toEqual(["新评论"]);
    expect(r.stats.comments).toBe(0);
  });

  it("没有 prev(首次落板)时 next 原样透传,无保留项", () => {
    const next = [{ id: "a", kind: "module", label: "A", summary: "sa", change: "add" }];
    const r = mergeBoardNodes(null, next);
    expect(r.nodes).toEqual(next);
    expect(r.keptIds).toEqual([]);
    expect(r.stats).toEqual({ comments: 0, done: 0, pos: 0, evidence: 0 });
  });
});

describe("② agent upsert 后人的痕迹保留(工具面 board_upsert)", () => {
  // 2026-10-24 f2 撞车门:同 id 必须同 label(同 id 改 label 判为跨写者争用同一 id,整板拒收),
  // 所以本用例的 agent 改的是 summary(而非 label),验证点(人的痕迹保留)不变。
  it("node.comments/done/pos 保留 + agent 改的 summary 生效 + 回执报保留项", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    // 先在板上做人工改动(等价 panel 的 board.save:skipGates)
    expect(saveBoard(r, humanDoc(), { skipGates: true }).ok).toBe(true);
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    // agent 落整板:只提交 n1/n2,summary 改了,不带 comments/done/pos
    const out = String(await tool.execute({
      title: "agent 重画", status: "implementing",
      nodes: [
        { id: "n1", kind: "module", label: "旧标题", summary: "新摘要", change: "modify" },
        { id: "n2", kind: "module", label: "第二个", summary: "s2 改", change: "add" },
      ],
    }));
    const d = loadBoard(r, "s1", "t1")!;
    const n1 = d.nodes.find((n) => n.id === "n1")!;
    expect(n1.summary).toBe("新摘要"); // agent 意图生效
    expect(n1.comments).toEqual(["这里要加超时", "名字换掉"]); // 人的评论没丢
    expect(n1.done).toBe(true); // 已落实没被回落成 false(agent 未表态)
    expect(n1.pos).toEqual({ x: 120, y: 40 }); // 拖拽位置没丢
    expect(out).toContain("设计白板已更新");
    expect(out).toContain("保留人工改动");
    expect(out).toMatch(/评论 2 条/);
    expect(out).toMatch(/已落实 1 个/);
    expect(out).toMatch(/人工新增节点 1 个/);
  });

  it("没有人工痕迹时回执不含「保留人工改动」句(数字全 0 不写)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await tool.execute({ title: "全新板", nodes: [{ id: "a", kind: "module", label: "A", summary: "sa", change: "add" }] }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("保留人工改动");
  });
});

describe("③ 人新增节点不被 agent 落板抹掉", () => {
  it("agent 未提交的 human-1 仍在板上,且排在尾部(保持原相对顺序)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    expect(saveBoard(r, humanDoc(), { skipGates: true }).ok).toBe(true);
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({
      title: "agent 重画",
      nodes: [
        { id: "n2", kind: "module", label: "第二个", summary: "s2 改", change: "add" },
        { id: "n1", kind: "module", label: "旧标题", summary: "s1", change: "modify" },
      ],
    });
    const d = loadBoard(r, "s1", "t1")!;
    // 先按 next 顺序,再追加 prev-only
    expect(d.nodes.map((n) => n.id)).toEqual(["n2", "n1", "human-1"]);
    const human = d.nodes.find((n) => n.id === "human-1")!;
    expect(human.label).toBe("人加的想法");
    expect(human.pos).toEqual({ x: 300, y: 200 });
  });

  it("keptIds 报告保留节点(相对顺序保持),keepPrevOnly=false 时只保留 next 声明过的", () => {
    const prev = [{ id: "a" }, { id: "h1" }, { id: "b" }, { id: "h2" }];
    const next = [{ id: "a" }, { id: "b" }];
    const r = mergeBoardNodes(prev, next);
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b", "h1", "h2"]);
    expect(r.keptIds).toEqual(["h1", "h2"]);
    expect(mergeBoardNodes(prev, next, { keepPrevOnly: false }).nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("节点总数受 maxNodes 约束时只截 prev-only,agent 提交的节点不丢", () => {
    const prev = [{ id: "a" }, { id: "h1" }, { id: "h2" }];
    const next = [{ id: "a" }, { id: "b" }];
    const r = mergeBoardNodes(prev, next, { maxNodes: 3 });
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b", "h1"]);
    expect(r.keptIds).toEqual(["h1"]);
  });
});

describe("④ done / evidence 的显式与合并语义", () => {
  it("next 显式 done:false 被尊重(不被 prev 的 true 覆盖)", () => {
    const prev = [{ id: "n1", done: true, label: "旧" }];
    const next = [{ id: "n1", done: false, label: "新" }];
    const r = mergeBoardNodes(prev, next);
    expect(r.nodes[0]!.done).toBe(false);
    expect(r.stats.done).toBe(0);
  });

  it("evidence 按 cmd 合并去重:next 优先,prev 独有 cmd 保留,顺序 next 在前", () => {
    const prev = [{
      id: "n1",
      evidence: [
        { cmd: "cmd-a", ok: true, at: 1 },
        { cmd: "cmd-b", ok: false, at: 2, note: "旧" },
      ],
    }];
    const next = [{
      id: "n1",
      evidence: [{ cmd: "cmd-b", ok: true, at: 9, output: "新跑过" }],
    }];
    const r = mergeBoardNodes(prev, next);
    const ev = r.nodes[0]!.evidence as { cmd: string; ok: boolean; output?: string; note?: string }[];
    expect(ev.map((e) => e.cmd)).toEqual(["cmd-b", "cmd-a"]);
    expect(ev[0]!.ok).toBe(true); // next 优先
    expect(ev[0]!.output).toBe("新跑过");
    expect(ev[0]!.note).toBeUndefined(); // next 真值,不掺 prev 的 note
    expect(ev[1]!.ok).toBe(true); // prev 独有 cmd 保留
    expect(r.stats.evidence).toBe(1);
  });

  it("工具面:agent 只回填一条证据,板上原有的人工证据不丢", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    expect(saveBoard(r, humanDoc(), { skipGates: true }).ok).toBe(true);
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    await tool.execute({
      title: "重画",
      nodes: [{
        id: "n1", kind: "module", label: "旧标题", summary: "新摘要", change: "modify",
        evidence: [{ cmd: "vitest run test/a.test.ts", ok: false, at: 99, output: "重跑挂了" }],
      }],
    });
    const ev = loadBoard(r, "s1", "t1")!.nodes.find((n) => n.id === "n1")!.evidence!;
    const cmds = ev.map((e) => e.cmd);
    expect(cmds).toContain("vitest run test/a.test.ts");
    expect(cmds).toContain("手工点一遍");
    expect(ev.find((e) => e.cmd === "vitest run test/a.test.ts")!.ok).toBe(false); // next 覆盖同 cmd
    expect(cmds.filter((c) => c === "vitest run test/a.test.ts")).toHaveLength(1); // 去重
  });
});

describe("⑤ 人工节点不被 agent 的验收门误伤(合并后仍可落板)", () => {
  it("人写的 P0 节点(人经 board.save,无 accept)保留后 agent 仍能落板,且不被门拒收", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const human = {
      version: 1 as const, taskId: "t1", sessionId: "s1", title: "人板", status: "draft" as const, rev: 1,
      nodes: [
        { id: "n1", kind: "module" as const, label: "A", summary: "sa", change: "add" as const },
        { id: "h-p0", kind: "note" as const, label: "人加的P0", summary: "人工节点,人写板不必带 accept", change: "add" as const, phase: "P0" as const },
      ],
      edges: [], planned_files: [], updatedAt: 0,
    };
    expect(saveBoard(r, human, { skipGates: true }).ok).toBe(true);
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      title: "agent 重画",
      nodes: [{ id: "n1", kind: "module", label: "A", summary: "sa2", change: "add" }],
    }));
    // 关键:不被「P0 缺可执行验收」拒收(人工节点在 gateExemptNodeIds 里),板确实落盘
    expect(out).toContain("设计白板已更新");
    expect(out).toContain("人工新增节点 1 个");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id)).toEqual(["n1", "h-p0"]);
  });

  it("agent 自己提交的 P0 缺 accept 仍被拒收(门没被整体放开)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({
      title: "agent 板",
      nodes: [{ id: "a-p0", kind: "note", label: "agent的P0", summary: "s", change: "add", phase: "P0" }],
    }));
    expect(out).toContain("缺 accept");
    expect(loadBoard(r, "s1", "t1")).toBeNull();
  });
});