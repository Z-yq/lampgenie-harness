/**
 * 变更契约自检(「白板=变更契约图」规范的板校验面):
 * 机器可判定的硬规则在 upsert 回执与 action=audit 里确定性点名——
 * modify/delete 缺 before、变更节点缺 targets/symbolRef、flow 的 then/else/body、
 * P0 accept 缺 expect/type、页面板状态/nav 边、显式边 label、call 边与索引不符。
 * 只提示不拒收:存量板/人工板不因旧字段缺失而写不进。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { saveBoard, loadBoard } from "../src/board-store.js";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { validateChangeContract, validateCallEdges, computeP0Coverage } from "../src/board-accept.js";

let tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "gh-board-contract-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const node = (over: Record<string, unknown> = {}) => {
  const id = typeof over.id === "string" ? over.id : "n1";
  return ({
    id, kind: "module", label: `节点 ${id}`, summary: "启动链路", change: "modify",
    targets: ["apps/gateway/src/main.ts"],
    ...over,
  }) as never;
};

const problemText = (r: { issues: { problems: string[] }[] }) => r.issues.map((i) => i.problems.join("\n")).join("\n");

describe("validateChangeContract(确定性硬规则体检)", () => {
  it("modify/delete 缺 before 被点名;add/keep 不要求", () => {
    const r = validateChangeContract([
      node({ id: "m1", change: "modify" }),
      node({ id: "d1", change: "delete", before: "" }),
      node({ id: "a1", change: "add" }),
      node({ id: "k1", change: "keep" }),
      node({ id: "risk", kind: "note", label: "风险:删除可回滚", summary: "回滚验证" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.nodeId)).toEqual(["m1", "d1"]);
    expect(problemText(r)).toContain("缺 before");
  });

  it("变更节点缺 targets/symbolRef 被点名;symbolRef 可替代 targets;keep 不要求", () => {
    const r = validateChangeContract([
      node({ id: "nowhere", targets: [], before: "旧" }),
      node({ id: "withSym", targets: [], symbolRef: { name: "createGatewayApp" }, before: "旧" }),
      node({ id: "keepNode", change: "keep", targets: [] }),
    ]);
    expect(r.issues.map((i) => i.nodeId)).toEqual(["nowhere"]);
    expect(problemText(r)).toContain("缺 targets/symbolRef");
  });

  it("flow:branch 缺 cond/then·else、loop 缺 over/body、step 缺 text,嵌套也查", () => {
    const r = validateChangeContract([
      node({ before: "旧入口", flow: [
        { type: "step", text: "读配置" },
        { type: "step" },
        { type: "branch", then: [{ type: "loop", body: [{ type: "branch" }] }] },
        { type: "loop" },
        { type: "branch", cond: "需要重试?" },
      ] }),
    ]);
    expect(r.ok).toBe(false);
    const text = problemText(r);
    expect(text).toContain("flow 2 是 step 但缺 text");
    expect(text).toContain("flow 3 是 branch 但缺 cond");
    expect(text).toContain("flow 3.then.1 是 loop 但缺 over");
    expect(text).toContain("flow 3.then.1.body.1 是 branch 但缺 cond");
    expect(text).toContain("flow 3.then.1.body.1 是 branch 但 then/else 都为空");
    expect(text).toContain("flow 4 是 loop 但缺 over");
    expect(text).toContain("flow 4 是 loop 但缺 body");
    expect(text).toContain("flow 5 是 branch 但 then/else 都为空");
  });

  it("P0 accept 缺 expect/type 被点名;四类+期望齐全则通过", () => {
    const bad = validateChangeContract([node({ id: "p0", change: "add", phase: "P0", accept: [{ cmd: "pnpm test" }] })]);
    expect(problemText(bad)).toContain("缺 expect");
    expect(problemText(bad)).toContain("未标 type");
    const ok = validateChangeContract([
      node({ id: "p0", change: "add", phase: "P0", accept: [{ cmd: "pnpm test", expect: "1 passed", type: "command" }] }),
    ]);
    expect(ok.ok).toBe(true);
  });

  it("页面板:状态覆盖/交互 nav 边可判;nav 触发 label 可判;workflow/ph-/note 跳过", () => {
    const page = (over: Record<string, unknown> = {}) =>
      node({ id: "p1", kind: "page", label: "首页", summary: "页面", change: "add", targets: ["apps/web/index.html"], ...over });
    // 无状态字样 → 只画 happy path
    const noState = validateChangeContract([page()], "page");
    expect(problemText(noState)).toContain("页面板未画空态");
    // 有状态、无交互 → 不要求 nav
    expect(validateChangeContract([page({ label: "首页 空态/加载/错误" })], "page").ok).toBe(true);
    // 有交互件但无 nav 边 → UI/逻辑两张皮
    const comp = node({ id: "p2", kind: "component", label: "提交按钮", summary: "点击提交", change: "add", targets: ["apps/web/index.html"] });
    const noNav = validateChangeContract([page({ label: "首页 空态" }), comp], "page", []);
    expect(problemText(noNav)).toContain("交互节点没有 nav 边");
    // 有 nav 边且带触发 label → 通过
    const okPage = validateChangeContract([page({ label: "首页 空态" }), comp], "page", [
      { from: "p2", to: "p1", kind: "nav", label: "点击提交" },
    ]);
    expect(okPage.ok).toBe(true);
    // nav 缺 label
    const navNoLabel = validateChangeContract([page({ label: "首页 空态" }), comp], "page", [
      { from: "p2", to: "p1", kind: "nav" },
    ]);
    expect(problemText(navNoLabel)).toContain("nav 边缺触发条件 label");
    expect(validateChangeContract([node()], "workflow").ok).toBe(true);
    expect(validateChangeContract([node({ id: "ph-understand", kind: "note" })]).ok).toBe(true);
    expect(validateChangeContract([node({ kind: "note" })]).ok).toBe(true);
  });

  it("页面板状态覆盖:缺 空态/加载/错误/禁用/权限 被点名", () => {
    const page = (over: Record<string, unknown> = {}) =>
      node({ id: "p1", kind: "page", label: "首页", summary: "页面", change: "add", targets: ["apps/web/index.html"], ...over });
    const missing = "页面板未画空态";
    // ① 全缺:ok=false,点名 (board)/整板,problems 精确含完整文案
    const noState = validateChangeContract([page()], "page");
    expect(noState.ok).toBe(false);
    const issue = noState.issues.find((i) => i.nodeId === "(board)");
    expect(issue?.label).toBe("整板");
    expect(problemText(noState)).toContain(missing);
    // ② 五词逐一豁免:仅该词出现在 summary → ok=true
    for (const k of ["空态", "加载", "错误", "禁用", "权限"]) {
      expect(validateChangeContract([page({ summary: `页面 ${k}` })], "page").ok).toBe(true);
    }
    // ③ 藏词:词只在 flow step.text,label/summary 不含 → ok=true(JSON 串化递归路径)
    expect(validateChangeContract([page({ flow: [{ type: "step", text: "错误重试" }] })], "page").ok).toBe(true);
    // ④ 空板:同样点名(空 page 板也是 happy path 零覆盖)
    expect(problemText(validateChangeContract([], "page"))).toContain(missing);
    // ⑤ design 板(docKind 缺省)不触发该提示
    expect(problemText(validateChangeContract([page()], undefined))).not.toContain(missing);
  });

  it("boardType 感知:fault 链不套代码 before、research 跳过风险启发、smoke 模板免 targets", () => {
    const fault = [
      node({ id: "f1", label: "复现条件", group: "01 复现", change: "modify" }),
      node({ id: "f2", label: "观测异常点", group: "02 异常点", change: "modify" }),
      node({ id: "f3", label: "候选假设", group: "03 假设", change: "modify" }),
      node({ id: "f4", label: "根因", group: "04 根因", change: "modify" }),
      node({ id: "f5", label: "修复点", group: "05 修复", change: "modify" }),
      node({ id: "f6", label: "防复发回归", group: "06 防复发", change: "modify" }),
    ];
    const fr = validateChangeContract(fault, "design", [], { boardType: "fault" });
    expect(fr.issues.some((i) => i.problems.some((p) => p.includes("缺 before")))).toBe(false);
    expect(fr.issues.some((i) => i.problems.some((p) => p.includes("故障链缺段")))).toBe(false);
    // research 的「迁移成本」不是不可逆改动,不触发风险规则
    const rr = validateChangeContract([node({ id: "r1", label: "候选A", summary: "迁移成本 0", change: "modify" })], "design", [], { boardType: "research" });
    expect(rr.issues.some((i) => i.problems.some((p) => p.includes("不可逆改动")))).toBe(false);
    // deploy 的 pkg-smoke 是模板节点,不要求 targets/symbolRef
    const dr = validateChangeContract([node({ id: "pkg-smoke", label: "用户旅程冒烟", change: "add", targets: [] })], "design", [], { boardType: "deploy" });
    expect(dr.issues.some((i) => i.nodeId === "pkg-smoke")).toBe(false);
  });

  it("refactor 缺现状/目标泳道被点名;scale 超标与重复 label 被点名", () => {
    const noLane = validateChangeContract([
      node({ id: "r1", label: "现状入口", before: "旧", change: "keep" }),
      node({ id: "r2", label: "目标入口", before: "旧", change: "add" }),
    ], "design", [], { boardType: "refactor", scale: "M" });
    expect(noLane.issues.some((i) => i.problems.some((p) => p.includes("现状层/目标层")))).toBe(true);
    const okLane = validateChangeContract([
      node({ id: "r1", label: "现状入口", group: "01 现状", before: "旧", change: "keep" }),
      node({ id: "r2", label: "目标入口", group: "02 目标", before: "旧", change: "add" }),
    ], "design", [], { boardType: "refactor", scale: "M" });
    expect(okLane.issues.some((i) => i.problems.some((p) => p.includes("现状层/目标层")))).toBe(false);
    const big = Array.from({ length: 10 }, (_, i) => node({ id: `m${i}`, label: `节点${i}`, before: "旧" }));
    const mr = validateChangeContract(big, "design", [], { boardType: "code", scale: "M" });
    expect(mr.issues.some((i) => i.problems.some((p) => p.includes("scale=M")))).toBe(true);
    const dup = validateChangeContract([node({ id: "d1", label: "重复节点" }), node({ id: "d2", label: "重复节点" })], "design");
    expect(dup.issues.some((i) => i.problems.some((p) => p.includes("重复 label")))).toBe(true);
  });

  it("symbolRef.name 是分支描述不是真符号名会被点名", () => {
    const r = validateChangeContract([
      node({ id: "bad-sym", label: "伪符号", before: "旧", symbolRef: { name: "boardUpsertTool.execute(audit 分支)", file: "apps/gateway/src/agent-wiring.ts" } }),
    ]);
    expect(problemText(r)).toContain("不是合法符号名");
  });

  it("重构等价对拍:design/page/fault/research/refactor 五板型 issues 与重构前基线逐条一致", () => {
    const base = { kind: "module", summary: "x", targets: ["a.ts"] };
    const cases = [
      {
        name: "design",
        args: [{ nodes: [
          { id: "m1", ...base, label: "改入口", change: "modify" },
          { id: "a1", ...base, label: "新模块", change: "add", phase: "P0", accept: [{ cmd: "true" }] },
          { id: "a2", ...base, label: "新模块", change: "add" },
          { id: "risk", kind: "note", label: "风险:回滚", summary: "x", change: "keep" },
        ], edges: [{ from: "m1", to: "a1", kind: "call" }] }, undefined, {}] as const,
        expected: [
          { nodeId: "m1", label: "改入口", problems: ["modify 缺 before(原来是什么样)"] },
          { nodeId: "a1", label: "新模块", problems: ["P0 accept 1 缺 expect(期望结果/观察标准)", "P0 accept 1 未标 type(命令/浏览器/人工/负面断言)"] },
          { nodeId: "(edges)", label: "显式边", problems: ["1 条显式边缺 label(数据格式/触发条件)"] },
          { nodeId: "(board)", label: "整板", problems: ["1 组重复 label(疑似换 id 重画/两版并板;请 prune 或合并):「新模块」a1/a2"] },
        ],
      },
      {
        name: "page",
        args: [{ nodes: [
          { id: "pg", kind: "page", label: "首页", summary: "x", change: "add", targets: ["a.html"] },
          { id: "btn", kind: "component", label: "提交按钮", summary: "点击提交", change: "add", targets: ["a.html"] },
        ], edges: [] }, "page", {}] as const,
        expected: [
          { nodeId: "(board)", label: "整板", problems: ["页面板未画空态/加载中/错误/禁用/权限不足(只画 happy path)"] },
          { nodeId: "(board)", label: "整板", problems: ["交互节点没有 nav 边指向逻辑节点(UI 与逻辑两张皮)"] },
        ],
      },
      {
        name: "fault",
        args: [{ nodes: [
          { id: "f1", kind: "module", label: "复现", summary: "x", group: "01 复现", change: "keep" },
          { id: "f2", kind: "module", label: "根因", summary: "x", group: "04 根因", change: "keep" },
          { id: "f3", kind: "module", label: "修复", summary: "x", group: "05 修复", change: "keep", flow: [{ type: "branch" }] },
        ], edges: [] }, "design", { boardType: "fault" }] as const,
        expected: [
          { nodeId: "f3", label: "修复", problems: ["flow 1 是 branch 但缺 cond", "flow 1 是 branch 但 then/else 都为空(分支去向未写)"] },
          { nodeId: "(board)", label: "整板", problems: ["故障链缺段:异常/假设/防复发(价值在推理链,6 段都要有)"] },
        ],
      },
      {
        name: "research",
        args: [{ nodes: [
          { id: "r1", kind: "module", label: "候选A", summary: "x", change: "add", targets: ["a"] },
          { id: "r2", kind: "module", label: "候选A", summary: "x", change: "add", targets: ["b"] },
        ], edges: [] }, "design", { boardType: "research" }] as const,
        expected: [
          { nodeId: "(board)", label: "整板", problems: ["1 组重复 label(疑似换 id 重画/两版并板;请 prune 或合并):「候选A」r1/r2"] },
        ],
      },
      {
        name: "refactor",
        args: [{ nodes: [
          { id: "n1", kind: "module", label: "现状入口", summary: "x", before: "旧", change: "modify", targets: ["a"] },
          { id: "n2", kind: "module", label: "目标入口", summary: "x", before: "旧", change: "add", targets: ["b"] },
        ], edges: [] }, "design", { boardType: "refactor" }] as const,
        expected: [
          { nodeId: "(board)", label: "整板", problems: ["重构板缺现状层/目标层泳道(group 需含「现状」「目标」;否则双图在画布上分不开)"] },
        ],
      },
    ];
    for (const c of cases) {
      const r = validateChangeContract(c.args[0].nodes as never, c.args[1], c.args[0].edges as never, c.args[2] as never);
      expect({ name: c.name, ok: r.ok, issues: r.issues }).toEqual({ name: c.name, ok: false, issues: c.expected });
    }
  });

  it("设计板显式边缺 label 被点名;virtual 边跳过", () => {
    const a = node({ id: "a", before: "旧", symbolRef: { name: "alpha" } });
    const b = node({ id: "b", before: "旧", symbolRef: { name: "beta" } });
    const noLabel = validateChangeContract([a, b], undefined, [{ from: "a", to: "b", kind: "call" }]);
    expect(problemText(noLabel)).toContain("显式边缺 label");
    const virtual = validateChangeContract([a, b], undefined, [{ from: "a", to: "b", kind: "call", virtual: true }]);
    expect(virtual.ok).toBe(true);
  });
});

describe("validateCallEdges(call 边与索引调用关系核对)", () => {
  it("callees 不含被调方 → 点名;含/索引缺失/virtual → 跳过", () => {
    const a = node({ id: "a", before: "旧", symbolRef: { name: "alpha" } });
    const b = node({ id: "b", before: "旧", symbolRef: { name: "beta" } });
    const edges = [{ from: "a", to: "b", kind: "call" }];
    const bad = validateCallEdges([a, b], edges, () => ["gamma"]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.problems.join("")).toContain("callees 不含 beta");
    expect(validateCallEdges([a, b], edges, () => ["beta"])).toEqual([]);
    expect(validateCallEdges([a, b], [{ ...edges[0]!, virtual: true }], () => ["gamma"])).toEqual([]);
    expect(validateCallEdges([a, b], edges, undefined)).toEqual([]);
    // data/nav 边不是 call,不该被调用关系误伤
    expect(validateCallEdges([a, b], [{ ...edges[0]!, kind: "data" }], () => ["gamma"])).toEqual([]);
  });
});

describe("computeP0Coverage(ph- 阶段泳道剔除)", () => {
  it("ph- 即使被误标 phase=P0 也不计入覆盖率", () => {
    const cov = computeP0Coverage({ nodes: [
      { id: "ph-understand", phase: "P0", label: "理解任务", summary: "阶段", accept: [{ cmd: "true" }] },
      { id: "n1", phase: "P0", label: "真实落目标", summary: "代码", accept: [{ cmd: "true" }] },
    ] } as never);
    expect(cov.total).toBe(1);
    expect(cov.nodes.map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("board_upsert/audit 的契约自检回执", () => {
  it("upsert 软提示缺 before 的节点,但不拒收;补齐后不再提示", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    const tool = boardUpsertTool(j, "s1", "t1", r, r);
    const out = String(await tool.execute({
      title: "契约自检板",
      nodes: [
        { id: "n1", kind: "module", label: "改网关入口", summary: "启动链路", change: "modify", targets: ["apps/gateway/src/main.ts"] },
        { id: "n2", kind: "module", label: "新模块", summary: "新增", change: "add", targets: ["apps/gateway/src/new.ts"] },
      ],
    }));
    expect(out).toContain("设计白板已更新");
    expect(out).toContain("变更契约自检");
    expect(out).toContain("n1「改网关入口」modify 缺 before");
    expect(out).not.toContain("n2「新模块」");

    const fixed = String(await tool.execute({
      title: "契约自检板",
      nodes: [
        { id: "n1", kind: "module", label: "改网关入口", summary: "启动链路", change: "modify", before: "旧入口", targets: ["apps/gateway/src/main.ts"] },
        { id: "n2", kind: "module", label: "新模块", summary: "新增", change: "add", targets: ["apps/gateway/src/new.ts"] },
      ],
    }));
    expect(fixed).toContain("设计白板已更新");
    expect(fixed).not.toContain("变更契约自检");
  });

  it("boardType/scale 随落板持久化(2026-10-25 板型感知校验用)", async () => {
    const r = tmp();
    const j = new MemoryJournal();
    await boardUpsertTool(j, "s1", "t1", r, r).execute({
      title: "板型测试",
      boardType: "fault",
      scale: "M",
      nodes: [{ id: "f1", kind: "note", label: "复现", summary: "x", change: "keep" }],
    });
    const d = loadBoard(r, "s1", "t1");
    expect(d?.boardType).toBe("fault");
    expect(d?.scale).toBe("M");
  });

  it("audit 收口时点名缺项(只读核对,不改板)", async () => {
    const r = tmp();
    saveBoard(r, {
      version: 1, taskId: "t1", sessionId: "s1", title: "契约自检板", status: "draft", rev: 0,
      nodes: [{ id: "n1", kind: "module", label: "改网关入口", summary: "启动链路", change: "modify", targets: ["apps/gateway/src/main.ts"] }],
      edges: [], planned_files: [], updatedAt: 0,
    } as never);
    const j = new MemoryJournal();
    const out = String(await boardUpsertTool(j, "s1", "t1", r, r).execute({ action: "audit" }));
    expect(out).toContain("变更契约自检");
    expect(out).toContain("n1「改网关入口」modify 缺 before");
    expect(out).toContain("P0 落目标覆盖率");
  });
});
