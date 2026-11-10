/**
 * board_upsert action=prune(白板历史污染清理)单测。
 * 缺陷背景:upsert 刻意无删除语义(怕误删人的工作)→ planner 换 id 重画后旧节点永久残留
 * (实测某板 42 节点里 16 个是同写者自造双份,全部 done:false / evidence:[] / comments:[] 零人的痕迹)。
 * 因此提供「只删零痕迹节点」的清污动作,并加两道安全门:
 * - 候选来源只认显式 nodeIds 或 scope 前缀(无模糊匹配/无按 group 删);
 * - 每个候选都要「零痕迹」(!done && 无 evidence && 无 comments),有痕迹一律拒删并点名;
 * - 缺省 dryRun(只报不删),必须 dryRun:false + confirm:true 才真删;
 * - 真删时同步剔除 from/to 命中被删 id 的边(否则 saveBoard 的边引用完整性校验会拒收)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { loadBoard, saveBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-prune-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个零痕迹节点(prune 的默认猎物:planner 换 id 重画留下的自造双份)。 */
function node(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "module" as const, label: `节点${id}`, summary: "测试节点", change: "add" as const, ...extra };
}

/** 直接播种一块板(跳过两道门:这里要造的是污染现场,不是正常落板)。 */
function seed(root: string, nodes: unknown[], edges: unknown[] = [], tid = "t1"): void {
  const s = saveBoard(root, {
    version: 1, taskId: tid, sessionId: "s1", title: "prune 板", status: "draft", rev: 0,
    nodes, edges, planned_files: [], updatedAt: 0,
  }, { skipGates: true });
  expect(s.ok).toBe(true);
}

function tool(root: string, scope?: string) {
  return boardUpsertTool(new MemoryJournal(), "s1", "t1", root, root, scope);
}

/** 盘上现场快照:rev / 节点 id 集合 / 边数。 */
function snap(root: string, tid = "t1") {
  const doc = loadBoard(root, "s1", tid)!;
  return { rev: doc.rev, ids: doc.nodes.map((n) => n.id).sort(), edges: doc.edges.length };
}

describe("① 候选来源:nodeIds 与 scope 都没给 → 拒绝且不动盘", () => {
  it("回执点名「需要 nodeIds 或 scope」,盘上 rev 与节点数不变", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune" }));
    expect(out).toContain("需要 nodeIds 或 scope");
    expect(out).toContain("白板未改动");
    expect(snap(r)).toEqual(before);
  });
});

describe("②b 显式 nodeIds + scope:只删指定节点,不把整片 scope 清空", () => {
  it("未带前缀的 n1 命中 p1-n1,不命中 p1-n2/p1-n3", async () => {
    const r = tmp();
    seed(r, [node("p1-n1"), node("p1-n2"), node("p1-n3")]);
    const out = String(await tool(r, "p1").execute({ action: "prune", nodeIds: ["n1"] }));
    expect(out).toContain("将删除 1 个");
    expect(out).toContain("p1-n1");
    expect(out).not.toContain("p1-n2");
    expect(out).not.toContain("p1-n3");
  });
});

describe("② 安全门一:dryRun 缺省 → 只报清单不写盘", () => {
  it("缺省 dryRun 报「将删除 N 个」,盘上 rev 与节点数不变", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2"), node("n3")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1", "n2"] }));
    expect(out).toContain("将删除 2 个(全是零痕迹)");
    expect(out).toContain("n1, n2");
    expect(out).toContain("dryRun:false + confirm:true");
    expect(snap(r)).toEqual(before);
  });

  it("显式 dryRun:true 同样不写盘(只报不删)", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1"], dryRun: true, confirm: true }));
    expect(out).toContain("将删除 1 个");
    expect(snap(r)).toEqual(before);
  });
});

describe("③ 安全门二:dryRun:false 但无 confirm → 仍不删", () => {
  it("缺 confirm 只回「确认后请带 dryRun:false + confirm:true 重试」,盘上不变", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1"], dryRun: false }));
    expect(out).toContain("确认后请带 dryRun:false + confirm:true 重试");
    expect(snap(r)).toEqual(before);
  });

  it("confirm:false 也不删(必须显式 true)", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1"], dryRun: false, confirm: false }));
    expect(out).toContain("确认后请带");
    expect(snap(r)).toEqual(before);
  });
});

describe("④ 有痕迹节点一律拒删并点名(comment / evidence / done:true 三种)", () => {
  it("dryRun 下逐条点名「为何拒删」,零痕迹的仍报可删", async () => {
    const r = tmp();
    seed(r, [
      node("n1"), // 零痕迹 = 可删
      node("c1", { comments: ["这条是人留的评论"] }),
      node("e1", { evidence: [{ cmd: "pnpm test", ok: true, at: 1 }] }),
      node("d1", { done: true }),
    ]);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1", "c1", "e1", "d1"] }));
    expect(out).toContain("将删除 1 个(全是零痕迹):n1");
    expect(out).toContain("保留 3 个有人的痕迹");
    expect(out).toContain("c1「节点c1」comments 1 条");
    expect(out).toContain("e1「节点e1」evidence 1 条");
    expect(out).toContain("d1「节点d1」done=true(已落实)");
  });

  it("dryRun:false+confirm:true 下,有痕迹的三个节点盘上一个不少,只删零痕迹的那个", async () => {
    const r = tmp();
    seed(r, [
      node("n1"),
      node("c1", { comments: ["人留的评论"] }),
      node("e1", { evidence: [{ cmd: "pnpm test", ok: false, at: 1 }] }),
      node("d1", { done: true }),
    ]);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1", "c1", "e1", "d1"], dryRun: false, confirm: true }));
    expect(out).toContain("已清理 1 个零痕迹节点");
    expect(out).toContain("拒删 3 个有人的痕迹");
    expect(snap(r).ids).toEqual(["c1", "d1", "e1"]);
    const doc = loadBoard(r, "s1", "t1")!;
    // 人的痕迹逐字存活(评论/证据/done 都没被动过)
    expect(doc.nodes.find((n) => n.id === "c1")!.comments).toEqual(["人留的评论"]);
    expect(doc.nodes.find((n) => n.id === "e1")!.evidence).toHaveLength(1);
    expect(doc.nodes.find((n) => n.id === "d1")!.done).toBe(true);
  });
});

describe("⑤ 真删:零痕迹节点消失 + 指向它的边被同步剔除(saveBoard 不因悬空边拒收)", () => {
  it("删 n1 时 n1->n2 与 n3->n1 两条边一起剔除,rev 自增,回执报数与实数一致", async () => {
    const r = tmp();
    seed(
      r,
      [node("n1"), node("n2"), node("n3")],
      [
        { from: "n1", to: "n2", kind: "call" },
        { from: "n3", to: "n1", kind: "call" },
        { from: "n2", to: "n3", kind: "call" },
      ],
    );
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1"], dryRun: false, confirm: true }));
    expect(out).toContain("已清理 1 个零痕迹节点");
    expect(out).toContain("剩 2 节点/1 边");
    expect(out).toContain("同步剔除 2 条边");
    const after = snap(r);
    expect(after.ids).toEqual(["n2", "n3"]);
    expect(after.edges).toBe(1);
    expect(after.rev).toBe(before.rev + 1); // rev 自增照常
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["n2->n3"]);
  });

  it("候选覆盖全部节点(删完剩 0)→ 拒删并保持原样(板要求至少 1 个节点)", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["n1", "n2"], dryRun: false, confirm: true }));
    expect(out).toContain("剩 0 节点");
    expect(snap(r)).toEqual(before);
  });
});

describe("⑥ scope 前缀过滤:只删该前缀的零痕迹节点,别的前缀不受影响", () => {
  it("scope=a1 只清 a1- 段,a1 段里有痕迹的保留,b1- 段一个不动", async () => {
    const r = tmp();
    seed(
      r,
      [
        node("a1-n1"), // 零痕迹 → 删
        node("a1-n2", { comments: ["人留的"] }), // 有痕迹 → 保留
        node("b1-n1"), // 别的前缀 → 不动(即使零痕迹)
        node("main-n1"), // 无前缀 → 不动
      ],
      [
        { from: "a1-n1", to: "a1-n2", kind: "call" },
        { from: "b1-n1", to: "main-n1", kind: "call" },
      ],
    );
    const out = String(await tool(r).execute({ action: "prune", scope: "a1", dryRun: false, confirm: true }));
    expect(out).toContain("已清理 1 个零痕迹节点");
    expect(out).toContain("a1-n2「节点a1-n2」comments 1 条");
    expect(snap(r).ids).toEqual(["a1-n2", "b1-n1", "main-n1"]);
    const doc = loadBoard(r, "s1", "t1")!;
    // a1-n1 那条边跟着删;b1/main 的边原样在
    expect(doc.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["b1-n1->main-n1"]);
  });

  it("scope 前缀零命中 → 回「没有匹配的节点」且盘上不变", async () => {
    const r = tmp();
    seed(r, [node("n1")]);
    const before = snap(r);
    const out = String(await tool(r).execute({ action: "prune", scope: "zz" }));
    expect(out).toContain("板上没有匹配的节点");
    expect(snap(r)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 悬空边自动剔除(核心修复,2026-10):同板多写者并发落板时 planner 连续落板失败,
// 报「边引用了不存在的节点: h4 -> h5」→ 整板被拒 → 该板之后任何 scope 写者永久失败(死锁)。
// 根因:mergeBoardNodes 的 maxNodes(60) 只在尾部截断 prev-only 节点,而 boardUpsertTool 把
// 别人的边(othersEdges)原样拼回,没过滤两端节点是否还在节点集里 → 节点被截断、边还在。
// ---------------------------------------------------------------------------
describe("⑦ 节点被 maxNodes 截断 → 悬空边自动剔除且照常落板(不再整板拒收)", () => {
  it("满板(60 节点/59 链边)+ scope 写者补 5 节点 → 尾部 5 节点被截断,5 条悬空边被剔除并回报", async () => {
    const r = tmp();
    // 盘上已是满板:60 节点成链 p001->p002 … p059->p060(边引用完整性合法)
    const full = Array.from({ length: 60 }, (_, i) => node(`p${String(i + 1).padStart(3, "0")}`));
    const chain = Array.from({ length: 59 }, (_, i) => ({
      from: `p${String(i + 1).padStart(3, "0")}`,
      to: `p${String(i + 2).padStart(3, "0")}`,
      kind: "call" as const,
    }));
    seed(r, full, chain);
    const before = snap(r);
    expect(before.ids).toHaveLength(60);

    // scope 写者落 5 个自己的节点:merge 先放本次 5 个,再补 prev-only 到 60 上限 → p056..p060 被截断
    const out = String(await tool(r, "a1").execute({
      action: "upsert",
      title: "并行写者补板",
      nodes: [1, 2, 3, 4, 5].map((i) => node(`n${i}`, { label: `写者节点${i}` })),
    }));

    // ①不再报悬空边拒收(修复前这里是「边引用了不存在的节点: p055 -> p056」)
    expect(out).not.toContain("边引用了不存在的节点");
    expect(out).toContain("设计白板已更新");
    // ②回执点名剔除条数与前 3 条
    expect(out).toContain("已剔除 5 条指向不存在节点的边");
    expect(out).toContain("p055->p056, p056->p057, p057->p058…");

    // ③盘上:节点被截断(p056..p060 没了),边只剩两端都在的 54 条,且无一悬空
    const doc = loadBoard(r, "s1", "t1")!;
    const ids = doc.nodes.map((n) => n.id);
    expect(ids).toHaveLength(60);
    expect(ids.filter((id) => /^p0(5[6-9]|60)$/.test(id))).toEqual([]);
    expect(doc.nodes.filter((n) => n.id.startsWith("a1-"))).toHaveLength(5);
    expect(doc.edges).toHaveLength(54);
    for (const e of doc.edges) {
      expect(ids).toContain(e.from);
      expect(ids).toContain(e.to);
    }
    // ④板不被写死:下一次同板写者照样能落板(死锁不再复现)
    const again = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "b1").execute({
      action: "upsert",
      title: "第二个写者",
      nodes: [node("n1", { label: "第二写者" })],
    }));
    expect(again).toContain("设计白板已更新");
    const doc2 = loadBoard(r, "s1", "t1")!;
    expect(doc2.nodes.some((n) => n.id === "b1-n1")).toBe(true);
  });

  it("K=0 时回执不显示剔除话术(不制造噪音)", async () => {
    const r = tmp();
    seed(r, [node("n1"), node("n2")], [{ from: "n1", to: "n2", kind: "call" }]);
    const out = String(await tool(r, "a1").execute({
      action: "upsert", title: "小补板", nodes: [node("x1", { label: "新节点" })],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("已剔除");
  });
});

// ---------------------------------------------------------------------------
// ⑧ prune 支持 targetTaskId:清理本会话内其它历史任务的残留板(boardPath 天然按会话隔离)。
// ---------------------------------------------------------------------------
describe("⑧ prune 带 targetTaskId → 清别人的历史板,当前板不受影响", () => {
  it("对 t2 清零痕迹节点:t2 rev 增、t2 节点少一个,当前板 t1 逐字不变", async () => {
    const r = tmp();
    seed(r, [node("cur1"), node("cur2")]); // 当前任务板 t1
    seed(r, [node("old1"), node("old2", { comments: ["人留的"] })], [{ from: "old1", to: "old2", kind: "call" }], "t2");
    const t1Before = snap(r, "t1");
    const t2Before = snap(r, "t2");

    const out = String(await tool(r).execute({
      action: "prune", targetTaskId: "t2", nodeIds: ["old1", "old2"], dryRun: false, confirm: true,
    }));
    expect(out).toContain("已清理 1 个零痕迹节点");
    expect(out).toContain("拒删 1 个有人的痕迹"); // old2 有评论 → 保留
    const t2After = snap(r, "t2");
    expect(t2After.rev).toBe(t2Before.rev + 1);
    expect(t2After.ids).toEqual(["old2"]);
    expect(t2After.edges).toBe(0); // old1 的边同步剔除
    // 当前板一个字节都没动
    expect(snap(r, "t1")).toEqual(t1Before);
  });

  it("targetTaskId 指向不存在的板 → 回「目标板 … 不存在或损坏」且不写盘", async () => {
    const r = tmp();
    seed(r, [node("cur1")]);
    const t1Before = snap(r, "t1");
    const out = String(await tool(r).execute({
      action: "prune", targetTaskId: "ghost", nodeIds: ["x"], dryRun: false, confirm: true,
    }));
    expect(out).toContain("不存在或损坏");
    expect(out).toContain("白板未改动"); // 不写盘
    expect(snap(r, "t1")).toEqual(t1Before);
    expect(loadBoard(r, "s1", "ghost")).toBeNull();
  });

  it("targetTaskId 缺省 → 仍清当前任务板(旧行为不变)", async () => {
    const r = tmp();
    seed(r, [node("cur1"), node("cur2")]);
    const out = String(await tool(r).execute({ action: "prune", nodeIds: ["cur1"], dryRun: false, confirm: true }));
    expect(out).toContain("已清理 1 个零痕迹节点");
    expect(snap(r, "t1").ids).toEqual(["cur2"]);
  });
});
