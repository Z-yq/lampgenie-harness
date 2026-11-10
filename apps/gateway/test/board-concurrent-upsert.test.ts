/**
 * 白板并发落盘缺陷回归(f1/f2:
 * 缺陷背景:同一会话并行派 3 个 planner,每个都拿到 boardWrite.taskId=父任务 id → 三者写同一份
 * .genie/boards/<sid>/<taskId>.json;各自节点 id 都从 n1 顺排 → mergeBoardNodes 按 id 合并时
 * 后写者整块替换前者,先落的整块板静默消失(经验证 A 的板内容 0 处命中)。
 * 修法:
 * - f1 board-store.withBoardLock:按 boardPath 进程内串行化 read-modify-write(前一个失败不阻塞后一个);
 * - f2 跨写者 id 撞车硬拒:同 id 但 label 不同 → 整板拒收并点名,不落盘。
 * 用例:
 * ① 三路并发各写唯一前缀 → 最终板节点并集齐全,无吞板;
 * ② 同 id 不同 label → 返回含「id 撞车」,盘上内容未被改动(rev/nodes/原文与写前一致);
 * ③ 同 id 同 label 的正常更新仍然成功(不被撞车门误伤);
 * ④ 串行化不阻塞:前一个写入抛错后,后一个写入仍成功(且确实按序执行)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { boardPath, loadBoard, saveBoard, withBoardLock } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-concurrent-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一块预置板:单个 n1 节点(跨写者撞车用例的「前一个写者」产物)。 */
function seededBoard(label: string) {
  return {
    version: 1 as const, taskId: "t1", sessionId: "s1", title: "前一个写者的板", status: "draft" as const, rev: 5,
    nodes: [{ id: "n1", kind: "module" as const, label, summary: "sa", change: "add" as const }],
    edges: [], planned_files: [], updatedAt: 0,
  };
}

/** 一个写者的整板提交(节点 id 带自己的唯一前缀)。 */
function payload(prefix: string) {
  return {
    title: `${prefix} 的板`,
    nodes: [
      { id: `${prefix}1`, kind: "module" as const, label: `${prefix} 模块一`, summary: "第一块", change: "add" as const },
      { id: `${prefix}2`, kind: "module" as const, label: `${prefix} 模块二`, summary: "第二块", change: "add" as const },
    ],
    edges: [{ from: `${prefix}1`, to: `${prefix}2`, kind: "call" }],
  };
}

describe("① 三路并发 upsert(各写唯一前缀)不吞板", () => {
  it("最终板节点 = 三组并集,三组 id 全在", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const outs = await Promise.all([
      tool.execute(payload("a1-")),
      tool.execute(payload("b1-")),
      tool.execute(payload("c1-")),
    ]);
    // 三次都成功(没有一次被撞车门/落板门误拒)
    for (const o of outs) expect(String(o)).toContain("设计白板已更新");
    const doc = loadBoard(r, "s1", "t1")!;
    const ids = doc.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["a1-1", "a1-2", "b1-1", "b1-2", "c1-1", "c1-2"]));
    expect(ids).toHaveLength(6); // 无覆盖、无重复
    expect(doc.rev).toBe(3); // 三次写入各 +1(证明三次都真落了盘)
  });
});

describe("② 跨写者 id 撞车(label 不同)→ 硬拒且不落盘", () => {
  it("返回含「id 撞车」+ 撞车 id 明细,盘上 rev/nodes 与原文均未变", async () => {
    const r = tmp();
    expect(saveBoard(r, seededBoard("旧标题"), { skipGates: true }).ok).toBe(true);
    const before = loadBoard(r, "s1", "t1")!;
    const rawBefore = readFileSync(boardPath(r, "s1", "t1"), "utf-8");
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "另一个写者的板",
      nodes: [{ id: "n1", kind: "module", label: "新标题", summary: "sb", change: "modify" }],
    }));
    expect(out).toContain("id 撞车");
    expect(out).toContain("n1");
    expect(out).toContain("旧标题");
    expect(out).toContain("新标题");
    expect(out).toContain("唯一前缀"); // 补救话术在
    // 不落盘:rev/节点/文件原文都与写前一致
    const after = loadBoard(r, "s1", "t1")!;
    expect(after.rev).toBe(before.rev);
    expect(after.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(after.nodes[0]!.label).toBe("旧标题");
    expect(readFileSync(boardPath(r, "s1", "t1"), "utf-8")).toBe(rawBefore);
  });
});

describe("③ 同 id 同 label 的正常更新不被误伤", () => {
  it("同 id 同 label 改 summary 仍落盘成功", async () => {
    const r = tmp();
    expect(saveBoard(r, seededBoard("同名节点"), { skipGates: true }).ok).toBe(true);
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "改摘要",
      nodes: [{ id: "n1", kind: "module", label: "同名节点", summary: "新摘要", change: "modify" }],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("id 撞车");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.rev).toBe(6); // 5 + 1
    expect(doc.nodes[0]!.summary).toBe("新摘要");
  });

  it("全新 id(板上没有)照常可新增", async () => {
    const r = tmp();
    expect(saveBoard(r, seededBoard("旧标题"), { skipGates: true }).ok).toBe(true);
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "加节点",
      nodes: [{ id: "b1-new", kind: "module", label: "全新节点", summary: "s", change: "add" }],
    }));
    expect(out).toContain("设计白板已更新");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id)).toEqual(["b1-new", "n1"]);
  });
});

describe("④ 串行化不阻塞:前一个抛错后一个仍成功", () => {
  it("排队的第二个任务在前一个拒绝后照常执行,且按序", async () => {
    const r = tmp();
    const order: string[] = [];
    const p1 = withBoardLock(r, "s1", "t1", async () => {
      order.push("first-start");
      await new Promise((res) => setTimeout(res, 10));
      throw new Error("boom");
    });
    const p2 = withBoardLock(r, "s1", "t1", () => {
      order.push("second");
      return 42;
    });
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe(42);
    expect(order).toEqual(["first-start", "second"]); // 第二个排在前一个之后,没有并行穿透
  });

  it("工具面:前一次落板抛错(坏输入)后,同一块板的下一次 upsert 仍成功", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const bad = String(await tool.execute({ title: "缺 nodes" }));
    expect(bad).toContain("需要 title 与非空 nodes");
    const good = String(await tool.execute(payload("a1-")));
    expect(good).toContain("设计白板已更新");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id)).toEqual(["a1-1", "a1-2"]);
  });
});
