/**
 * 白板写者作用域分区(q1/q2/q3/q5/q7)。
 * 缺陷背景:同会话并行派 N 个 planner,全都写同一块板(.genie/boards/<sid>/<taskId>.json):
 * - 节点 id 各自从 n1 顺排 → 互相覆盖(先落的板静默消失;f2 撞车门只是把覆盖变成拒收,写者仍会互相挡路);
 * - 板名各写各的,谁最后落谁说了算;
 * - audit 只能对整板算覆盖率,并行写者分不清「我的 P0 过了几条」;
 * - 回执只说「N 条边」,不区分作者画的真实边与系统推导的虚边 → 板看着有关系,其实一条没画;
 * - label 无限长把画布节点撑成大块(细节本该进 summary)。
 * 语义(本次):
 * - q1 scope:写者构造期绑定唯一短前缀(plannerScopeOf 由 bgAgentId 派生,稳定可复现),
 *   落板时节点 id 自动加 `${scope}-`,边用同一张映射表改写 from/to;主 agent(无 scope)行为不变。
 * - q2 板名:已有非空 title 时子写者不许覆写,回执点名「板名保持」。
 * - q3 audit:给 scope 只看本写者分区的 P0;all=true 按 id 前缀分组,合计行标注「跨写者,仅参考」。
 * - q5 回执追加「边:显式 X 条 / 推导 Y 条」;显式 0 且推导 >0 时点名警告。
 * - q7 label 限长门只在 agent 写入面生效(saveBoard opts.agentWrite),且只校验本次提交里
 *   **改了 label** 的节点——存量超长 label 不被本次提交触及就不拒收。
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { boardPath, loadBoard, saveBoard } from "../src/board-store.js";
import { boardReadTool, boardUpsertTool, buildSubagentExtraTools, plannerScopeOf } from "../src/agent-wiring.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-scope-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一个写者的整板提交(裸 id,由 scope 自动加前缀)。 */
function payload(prefix: string, extra: Record<string, unknown> = {}) {
  return {
    title: `${prefix} 的板`,
    nodes: [
      { id: "n1", kind: "module" as const, label: `${prefix}一`, summary: "第一块", change: "add" as const },
      { id: "n2", kind: "module" as const, label: `${prefix}二`, summary: "第二块", change: "add" as const },
    ],
    edges: [{ from: "n1", to: "n2", kind: "call" as const, label: "调用" }],
    ...extra,
  };
}

// ---------------------------------------------------------------- q1 ----
describe("q1 写者作用域 idPrefix:同板不同写者互不覆盖", () => {
  it("两写者各带 scope 落同一块板:节点 id 各带前缀,边同步改写,谁的节点都在", async () => {
    const r = tmp();
    const a1 = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    const b1 = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "b1");
    const oa = String(await a1.execute(payload("A")));
    const ob = String(await b1.execute(payload("B")));
    expect(oa).toContain("设计白板已更新");
    expect(ob).toContain("设计白板已更新");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["a1-n1", "a1-n2", "b1-n1", "b1-n2"]);
    // 边跟着 id 改写:没有一条边指向旧裸 id(n1/n2),否则 saveBoard 会以边引用不完整拒收
    const pairs = doc.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(["a1-n1->a1-n2", "b1-n1->b1-n2"]);
  });

  it("scope 写入幂等:重复提交已带前缀的节点不会套娃成 `a1-a1-n1`", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    await tool.execute(payload("A"));
    // 第二次提交时读者已经能拿到加过前缀的 id(回执/board_read 里的形态)
    const again = String(await tool.execute({
      title: "再落一次",
      nodes: [{ id: "a1-n1", kind: "module", label: "A一", summary: "改", change: "add" }],
      edges: [],
    }));
    expect(again).toContain("设计白板已更新");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["a1-n1", "a1-n2"]);
  });

  it("主 agent(无 scope)行为完全不变:节点 id 原样落盘", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const out = String(await main.execute({
      title: "主 agent 的板",
      nodes: [
        { id: "n1", kind: "module", label: "采集", summary: "s1", change: "add" },
        { id: "n2", kind: "module", label: "解码", summary: "s2", change: "add" },
      ],
      edges: [{ from: "n1", to: "n2", kind: "call", label: "调用" }],
    }));
    expect(out).toContain("设计白板已更新");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(doc.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["n1->n2"]);
  });

  it("坏 scope 消毒:非 [a-zA-Z0-9-] 字符被剥掉,不污染节点 id", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, " x/../1 ");
    await tool.execute(payload("A"));
    const ids = loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort();
    expect(ids.every((id) => /^[a-zA-Z0-9-]+$/.test(id))).toBe(true);
    expect(ids).toHaveLength(2);
  });

  it("plannerScopeOf:稳定可复现(同身份同前缀)、不同身份不同前缀、无随机数", () => {
    const a = plannerScopeOf("agent_lq3k9xab1f2");
    expect(a).toBe(plannerScopeOf("agent_lq3k9xab1f2")); // 重复调用同值
    expect(a).toMatch(/^p[a-zA-Z0-9]{4}$/);
    expect(a).not.toBe(plannerScopeOf("agent_lq3k9xab3f7"));
    // 身份太短 → 落到确定性哈希兜底(同参同值,仍无随机)
    const short1 = plannerScopeOf("a", "t-1");
    expect(short1).toBe(plannerScopeOf("a", "t-1"));
    expect(short1).toMatch(/^p[a-zA-Z0-9]{4}$/);
  });
});

// ---------------------------------------------------------------- q2 ----
describe("q2 板名不被子写者覆写", () => {
  it("子写者改板名 → 保留已有 title 并在回执点名「板名保持」", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    await main.execute(payload("主"));
    const sub = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    const out = String(await sub.execute({ ...payload("A"), title: "子写者想改的板名" }));
    expect(out).toContain("设计白板已更新");
    expect(out).toContain("板名保持「主 的板」");
    expect(out).toContain("改板名请由主 agent 提交");
    expect(loadBoard(r, "s1", "t1")!.title).toBe("主 的板");
  });

  it("板上还没有 title(全新板)时子写者的板名照常生效", async () => {
    const r = tmp();
    const sub = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    const out = String(await sub.execute(payload("A")));
    expect(out).not.toContain("板名保持");
    expect(loadBoard(r, "s1", "t1")!.title).toBe("A 的板");
  });

  it("主 agent 改板名不受限(行为不变)", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    await main.execute(payload("主"));
    const out = String(await main.execute({ ...payload("主"), title: "主 agent 改的新板名" }));
    expect(out).not.toContain("板名保持");
    expect(loadBoard(r, "s1", "t1")!.title).toBe("主 agent 改的新板名");
  });
});

// ---------------------------------------------------------------- q3 ----
describe("q3 audit 按写者分组", () => {
  /** 一块板:两个写者的 P0 节点,a1 有通过证据、b1 无证据。 */
  async function seedTwoWriters(): Promise<string> {
    const r = tmp();
    const a1 = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    const b1 = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "b1");
    await a1.execute({
      title: "两写者的板",
      nodes: [{ id: "n1", kind: "module", label: "A的P0", summary: "s", change: "add", phase: "P0", accept: [{ cmd: "npm test" }], evidence: [{ cmd: "npm test", ok: true }] }],
      edges: [],
    });
    await b1.execute({
      title: "两写者的板",
      nodes: [{ id: "n1", kind: "module", label: "B的P0", summary: "s", change: "add", phase: "P0", accept: [{ cmd: "npm run build" }] }],
      edges: [],
    });
    return r;
  }

  it("给 scope → 只统计本写者分区(1/1),不混入别人的 P0", async () => {
    const r = await seedTwoWriters();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1").execute({ action: "audit" }));
    expect(out).toContain("本写者 a1- 分区");
    expect(out).toContain("P0 覆盖率合计 1/1");
    expect(out).not.toContain("b1-n1");
  });

  it("all=true → 按 id 前缀分组,合计行明确标注「跨写者,仅参考」", async () => {
    const r = await seedTwoWriters();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({ action: "audit", all: true }));
    expect(out).toContain("按写者分组");
    expect(out).toContain("a1- P0 1/1");
    expect(out).toContain("b1- P0 0/1");
    expect(out).toContain("合计跨写者,仅参考");
    expect(out).toContain("合计 1/2");
  });

  it("audit 仍只读:不写盘(rev 不变)", async () => {
    const r = await seedTwoWriters();
    const rev0 = loadBoard(r, "s1", "t1")!.rev;
    await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1").execute({ action: "audit", all: true });
    expect(loadBoard(r, "s1", "t1")!.rev).toBe(rev0);
  });
});

// ---------------------------------------------------------------- q5 ----
describe("q5 显式边契约回执", () => {
  it("有显式边:回执给「边:显式 N 条 / 推导 M 条」且不告警", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute(payload("A")));
    expect(out).toContain("边:显式 1 条 / 推导 0 条");
    expect(out).not.toContain("一条真实关系边都没画");
  });

  it("一条显式边都没有但系统推导出边 → 点名警告(补 edges 的补救路径在话术里)", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "全靠推导的板",
      nodes: [
        { id: "n1", kind: "module", label: "采集", summary: "s1", change: "add", group: "01 采集" },
        { id: "n2", kind: "module", label: "解码", summary: "s2", change: "add", group: "01 采集" },
      ],
      edges: [],
    }));
    expect(out).toContain("边:显式 0 条 / 推导 1 条");
    expect(out).toContain("一条真实关系边都没画");
    expect(out).toContain("code_sense");
    expect(out).toContain("from=调用方,to=被调方");
  });

  it("既无显式边也无推导边(单节点板)→ 只报数字不告警", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "单节点板",
      nodes: [{ id: "n1", kind: "module", label: "单点", summary: "s", change: "add" }],
      edges: [],
    }));
    expect(out).toContain("边:显式 0 条 / 推导 0 条");
    expect(out).not.toContain("一条真实关系边都没画");
  });
});

// ---------------------------------------------------------------- q7 ----
describe("q7 label 限长落板门(只对 agent 写入面)", () => {
  it("agent 提交超长 label → 拒收,点名前 3 个 `id「label」N 字` 并给改法", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "长 label 板",
      nodes: [
        { id: "n1", kind: "module", label: "把白板节点的标题写成一整句话这种长度", summary: "s", change: "add" },
        { id: "n2", kind: "module", label: "短", summary: "s", change: "add" },
      ],
      edges: [],
    }));
    expect(out).toContain("label 过长");
    expect(out).toContain("n1「把白板节点的标题写成一整句话这种长度」18 字");
    expect(out).toContain("label 用名词短语 ≤14 字,细节写进 summary");
    expect(loadBoard(r, "s1", "t1")).toBeNull(); // 拒收=没落盘
  });

  it("刚好 14 字放行、15 字拒收(边界)", async () => {
    const r = tmp();
    const ok = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "边界板", nodes: [{ id: "n1", kind: "module", label: "一二三四五六七八九十一二三四", summary: "s", change: "add" }], edges: [],
    }));
    expect(ok).toContain("设计白板已更新");
    const bad = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "边界板", nodes: [{ id: "n2", kind: "module", label: "一二三四五六七八九十一二三四五", summary: "s", change: "add" }], edges: [],
    }));
    expect(bad).toContain("label 过长");
    expect(bad).toContain("15 字");
  });

  it("人经 board.save 改板不受限(长 label 照常落盘)", async () => {
    const r = tmp();
    const longLabel = "人写的超长标题这句话远远超过十四个字";
    const saved = saveBoard(r, {
      version: 1 as const, taskId: "t1", sessionId: "s1", title: "人写的板", status: "draft" as const, rev: 0,
      nodes: [{ id: "n1", kind: "module" as const, label: longLabel, summary: "s", change: "add" as const }],
      edges: [], planned_files: [], updatedAt: 0,
    });
    expect(saved.ok).toBe(true);
    expect(loadBoard(r, "s1", "t1")!.nodes[0]!.label).toBe(longLabel);
  });

  it("存量超长 label 未被本次提交触及(逐字相同)→ 不拒收;改了它且仍超长 → 拒收", async () => {
    const r = tmp();
    const longLabel = "存量超长的节点标题超过十四个字了";
    // 先由「人」落一块带超长 label 的板(agentWrite 不传=不限长)
    expect(saveBoard(r, {
      version: 1 as const, taskId: "t1", sessionId: "s1", title: "旧板", status: "draft" as const, rev: 0,
      nodes: [
        { id: "old", kind: "module" as const, label: longLabel, summary: "s", change: "add" as const },
        { id: "keep", kind: "module" as const, label: "短节点", summary: "k", change: "add" as const },
      ],
      edges: [], planned_files: [], updatedAt: 0,
    }).ok).toBe(true);
    // agent 整板提交(带上了别人的节点,label 逐字未变)→ 放行
    const pass = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "旧板",
      nodes: [
        { id: "old", kind: "module", label: longLabel, summary: "s2", change: "modify" },
        { id: "keep", kind: "module", label: "短节点", summary: "k", change: "add" },
      ],
      edges: [],
    }));
    expect(pass).toContain("设计白板已更新");
    // 但**新提交**一个超长 label 的节点(板上原本没有该 id,不触发撞车门)→ label 限长门拒收
    const reject = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "旧板",
      nodes: [{ id: "brand-new", kind: "module", label: "这次新加的一个同样超长的节点标题", summary: "s3", change: "add" }],
      edges: [],
    }));
    expect(reject).toContain("label 过长");
    expect(reject).toContain("brand-new");
    // 拒收=盘上没多出这个节点(old 的超长 label 也还在,说明是被门挡的而非写坏)
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["keep", "old"]);
    expect(doc.nodes.find((n) => n.id === "old")!.label).toBe(longLabel);
  });

  it("人保留节点(gateExempt:本次没提交)→ 不因它的超长 label 拒收 agent 的整板提交", async () => {
    const r = tmp();
    const longLabel = "人工留下的超长标题这行真的太长了";
    expect(saveBoard(r, {
      version: 1 as const, taskId: "t1", sessionId: "s1", title: "旧板", status: "draft" as const, rev: 0,
      nodes: [{ id: "human-1", kind: "note" as const, label: longLabel, summary: "人写的", change: "add" as const }],
      edges: [], planned_files: [], updatedAt: 0,
    }).ok).toBe(true);
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "旧板", nodes: [{ id: "a1", kind: "module", label: "新节点", summary: "s", change: "add" }], edges: [],
    }));
    expect(out).toContain("设计白板已更新");
    const doc = loadBoard(r, "s1", "t1")!;
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["a1", "human-1"]);
  });
});

// ---------------------------------------------------- t2 planner 自报前缀 ----
describe("t2 系统派生前缀提示 + 入参 scope 优先", () => {
  it("系统派生前缀(p+4 位)首次落本板 → 回执提示可显式传 scope=a/b/c;再次落板不再提示", async () => {
    const r = tmp();
    const sys = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "pqa6e");
    const first = String(await sys.execute(payload("A")));
    expect(first).toContain("设计白板已更新");
    expect(first).toContain("pqa6e");
    expect(first).toContain("系统派生");
    expect(first).toContain("scope=a/b/c");
    // 本板已有本 scope 节点 → 不再刷提示(只提醒一次,不制造噪音)
    const second = String(await sys.execute(payload("A")));
    expect(second).toContain("设计白板已更新");
    expect(second).not.toContain("系统派生");
  });

  it("自报 scope(a1 这类有意义的短前缀)不触发「系统派生随机短码」提示", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1").execute(payload("A")));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("系统派生");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["a1-n1", "a1-n2"]);
  });

  it("入参 scope 优先于构造期兜底 scope(planner 运行时自报可覆盖系统派生)", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "pqa6e");
    const out = String(await tool.execute({ ...payload("A"), scope: "alpha" }));
    expect(out).toContain("设计白板已更新");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["alpha-n1", "alpha-n2"]);
    expect(out).not.toContain("系统派生");
  });
});

// ---------------------------------------------------- t3 同 scope 旧节点残留 ----
describe("t3 同 scope 旧节点残留提示(upsert 无删除语义)", () => {
  /** 极简提交:只给 id,label 与 id 同名(label 撞车门不误伤)。 */
  const node = (id: string) => ({ id, kind: "module" as const, label: id, summary: id, change: "add" as const });

  it("先落 n1/n2 再只提交 n3(同 scope=a1)→ 回执点出「还有 2 个你以前的节点」并给 board.save 补救路径", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    const first = String(await tool.execute({ title: "板", nodes: [node("n1"), node("n2")], edges: [] }));
    expect(first).toContain("设计白板已更新");
    expect(first).not.toContain("你以前的节点"); // 首次落板没有旧节点
    const second = String(await tool.execute({ title: "板", nodes: [node("n3")], edges: [] }));
    expect(second).toContain("设计白板已更新");
    expect(second).toContain("还有 2 个你以前的节点");
    expect(second).toContain("a1-n1");
    expect(second).toContain("a1-n2");
    expect(second).toContain("upsert 无删除语义");
    expect(second).toContain("board.save");
    // 残留是真留在盘上的(这正是要提示的原因):三个节点都在
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["a1-n1", "a1-n2", "a1-n3"]);
  });

  it("换 scope=b1 落板(板上有 a1 旧节点)→ 无该告警(b1 自己没旧节点)", async () => {
    const r = tmp();
    await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1").execute({ title: "板", nodes: [node("n1"), node("n2")], edges: [] });
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "b1").execute({ title: "板", nodes: [node("n3")], edges: [] }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("你以前的节点");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["a1-n1", "a1-n2", "b1-n3"]);
  });

  it("整板重提(旧节点全在)→ 不告警(避免每次 upsert 都刷噪音)", async () => {
    const r = tmp();
    const tool = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r, "a1");
    await tool.execute({ title: "板", nodes: [node("n1"), node("n2")], edges: [] });
    const again = String(await tool.execute({ title: "板", nodes: [node("n1"), node("n2"), node("n3")], edges: [] }));
    expect(again).toContain("设计白板已更新");
    expect(again).not.toContain("你以前的节点");
  });

  it("主 agent(无 scope)→ 永不触发该告警(无写者分区,旧行为不变)", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    await main.execute({ title: "板", nodes: [node("n1"), node("n2")], edges: [] });
    const out = String(await main.execute({ title: "板", nodes: [node("n3")], edges: [] }));
    expect(out).toContain("设计白板已更新");
    expect(out).not.toContain("你以前的节点");
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n3"]);
  });
});

// ------------------------------------------------- q4 子写者独立板 ----
// 缺陷背景(注意):planner 子代理的 scope 写入并进主 agent 的任务板——
// 主板本来只有自己的 4 个 P0 节点,两个 planner 以 scope=bp/kb 落板后 board_upsert action=audit
// 报「P0 覆盖率 4/24(17%)」,未覆盖的 20 个全是别的任务(bp-*/kb-*)的规划契约,
// 主 agent 因此永远无法宣称完成:审计跨任务计分。
// 修法:子写者(有 scope)落**独立板文件** `<taskId>-<scope>.json`,主 agent(无 scope)逐字不变。
describe("q4 子写者落独立板:不并进调用方的任务板", () => {
  /** planner 侧的真实工具面(与 spawn 装配同映射):planning + boardWrite.scope。 */
  function plannerTools(root: string, taskId: string, scope: string): { upsert: Tool; read: Tool } {
    const tools = buildSubagentExtraTools(root, [], new ExperienceStore(root), {
      journal: new MemoryJournal(), sessionId: "s1", owner: "sub-x", planning: true,
      boardWrite: { taskId, taskRoot: root, storeRoot: root, scope },
    });
    return { upsert: tools.find((t) => t.name === "board_upsert")!, read: tools.find((t) => t.name === "board_read")! };
  }

  const p0 = (id: string, label: string, done = false) => ({
    id, kind: "module" as const, label, summary: `${label} 干什么`, change: "add" as const,
    phase: "P0" as const, accept: [{ cmd: `pnpm vitest run test/${id}.test.ts` }],
    ...(done ? { evidence: [{ cmd: `pnpm vitest run test/${id}.test.ts`, ok: true }] } : {}),
  });

  it("主 agent 落 2 节点 + 子写者 scope=bp 落 2 节点 → 磁盘两个板文件、主板仍 2 节点、子板只 bp 的 2 节点", async () => {
    const r = tmp();
    // ① 主 agent(无 scope)先落自己那块板
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    const mo = String(await main.execute({
      title: "主 agent 的板",
      nodes: [p0("n1", "主板一"), p0("n2", "主板二")],
      edges: [{ from: "n1", to: "n2", kind: "call", label: "调用" }],
    }));
    expect(mo).toContain("设计白板已更新");
    // ② 子写者(planner 面)以 scope=bp 落板
    const sub = plannerTools(r, "t1", "bp");
    const so = String(await sub.upsert.execute({ title: "bp 规划板", nodes: [p0("bp-a", "bp 一"), p0("bp-b", "bp 二")], edges: [] }));
    expect(so).toContain("设计白板已更新");
    // ③ 磁盘两块板文件
    const files = readdirSync(join(r, ".genie", "boards", "s1")).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["t1-bp.json", "t1.json"]);
    expect(existsSync(boardPath(r, "s1", "t1"))).toBe(true);
    expect(existsSync(boardPath(r, "s1", "t1-bp"))).toBe(true);
    // ④ 主板仍只有主 agent 的 2 节点(子写者一个都没并进来)
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    // ⑤ 子板只有 bp 的 2 节点(id 已带本写者前缀=幂等,不套娃成 bp-bp-a)
    expect(loadBoard(r, "s1", "t1-bp")!.nodes.map((n) => n.id).sort()).toEqual(["bp-a", "bp-b"]);
    // ⑥ 回执说清落到了哪块板(别让人误以为落在主板)
    expect(so).toContain("t1-bp.json");
  });

  it("audit 缺省只看主板:P0 计数不含子写者(4/24 跨任务计分不再复现)", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    await main.execute({ title: "主板", nodes: [p0("n1", "主板一", true), p0("n2", "主板二")], edges: [] });
    for (const sc of ["bp", "kb"]) {
      const sub = plannerTools(r, "t1", sc);
      await sub.upsert.execute({ title: `${sc} 板`, nodes: [p0(`${sc}-a`, `${sc} 一`), p0(`${sc}-b`, `${sc} 二`)], edges: [] });
    }
    // 主板:2 个 P0(1 条有证据)
    const audited = String(await main.execute({ action: "audit" }));
    expect(audited).toContain("P0 覆盖率合计 1/2");
    expect(audited).not.toContain("bp-");
    expect(audited).not.toContain("kb-");
    // 显式 all:true 才跨看(子板各自 0/2)
    const all = String(await main.execute({ action: "audit", all: true }));
    expect(all).toContain("t1-bp");
    expect(all).toContain("t1-kb");
  });

  it("board_read 缺省读本写者自己的板;显式 taskId 才跨读", async () => {
    const r = tmp();
    const main = boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r);
    await main.execute({ title: "主板", nodes: [p0("n1", "主板一")], edges: [] });
    const sub = plannerTools(r, "t1", "bp");
    await sub.upsert.execute({ title: "bp 板", nodes: [p0("bp-a", "bp 一")], edges: [] });
    // 主 agent 的 board_read 缺省=主板(不见 bp 节点;boardId=任务 id 与 mainTools 装配一致)
    const mainRead = String(await boardReadTool(new MemoryJournal(), "s1", r, { boardId: "t1" }).execute({}));
    expect(mainRead).toContain("主板一");
    expect(mainRead).not.toContain("bp 一");
    // planner 的 board_read 缺省=自己的板
    const subRead = String(await sub.read.execute({}));
    expect(subRead).toContain("bp 一");
    expect(subRead).not.toContain("主板一");
    // 显式给 taskId → 跨读
    expect(String(await sub.read.execute({ taskId: "t1" }))).toContain("主板一");
  });

  it("主 agent 新任务板缺失时 fallback 旧板作参考,并明确要求直接 board_upsert", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    await boardUpsertTool(j, "s1", "t-old", r, r).execute({
      title: "旧任务板", nodes: [p0("n1", "旧板节点")], edges: [],
    });
    const txt = String(await boardReadTool(j, "s1", r, {
      boardId: "t-new",
      fallbackToSessionBoard: true,
    }).execute({}));
    expect(txt).toContain("当前任务板 t-new 还不存在");
    expect(txt).toContain("旧任务板");
    expect(txt).toContain("停止重复读板");
    expect(txt).toContain("board_upsert");
    // 子写者/未开 fallback:仍只报不存在,不偷读别人的板
    const strict = String(await boardReadTool(j, "s1", r, { boardId: "t-new" }).execute({}));
    expect(strict).toContain("还不存在");
    expect(strict).not.toContain("停止重复读板");
    expect(strict).not.toContain("旧板节点");
  });

  it("主 agent(无 scope)路径零改动:板名/节点 id/文件名都是老的 t1.json", async () => {
    const r = tmp();
    const out = String(await boardUpsertTool(new MemoryJournal(), "s1", "t1", r, r).execute({
      title: "主 agent 的板", nodes: [p0("n1", "主板一")], edges: [],
    }));
    expect(out).toContain("设计白板已更新");
    expect(readdirSync(join(r, ".genie", "boards", "s1")).filter((f) => f.endsWith(".json"))).toEqual(["t1.json"]);
    expect(loadBoard(r, "s1", "t1")!.nodes.map((n) => n.id)).toEqual(["n1"]);
  });
});

