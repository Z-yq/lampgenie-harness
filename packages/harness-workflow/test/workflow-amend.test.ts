/**
 * 引擎 caps / amend测试:真 WorkflowEngine + MemoryJournal + 假 dispatch。
 * 覆盖:白名单/越界/整体不应用/journal 落 workflow.caps/resume 继承/在飞 ask 不被中断/零 caps 行为不变。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { WorkflowEngine, type WorkflowCaps } from "../src/engine";

const ROOT = process.cwd();
const TRIVIAL = `report({ ok: true });`;

function makeEngine(
  j: MemoryJournal,
  over: { workflowId?: string; caps?: WorkflowCaps; dispatch?: (s: string) => Promise<string> } = {},
): WorkflowEngine {
  return new WorkflowEngine({
    root: ROOT,
    journal: j,
    workflowId: over.workflowId ?? "wf-amend",
    executor: null as never,
    dispatch: over.dispatch ?? (async () => "ok"),
    ...(over.caps ? { caps: over.caps } : {}),
  });
}

const capsEvents = (j: MemoryJournal) => j.readAll().filter((e) => String(e.kind) === "workflow.caps");

describe("零 caps:与旧行为逐字一致", () => {
  it("currentCaps 为空,run 结果不含 caps 字段,不写 caps journal", async () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    expect(e.currentCaps()).toEqual({});
    const r = await e.run(TRIVIAL);
    expect(r.ok).toBe(true);
    expect("caps" in r).toBe(false); // 零配置不新增字段
    expect(capsEvents(j)).toHaveLength(0);
  });

  it("opts.caps 生效:run 结果带 caps,但初始化本身不写 journal(只有 amend 才落事件)", async () => {
    const j = new MemoryJournal();
    const e = makeEngine(j, { caps: { maxConcurrency: 4 } });
    expect(e.currentCaps()).toEqual({ maxConcurrency: 4 });
    const r = await e.run(TRIVIAL);
    expect(r.caps).toEqual({ maxConcurrency: 4 });
    expect(capsEvents(j)).toHaveLength(0);
  });
});

describe("amend 白名单与校验", () => {
  it("合法 patch → APPLIED,合并进 currentCaps,applied 只含被接受字段", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    const res = e.amend({ maxConcurrency: 6 });
    expect(res.ok).toBe(true);
    expect(res.code).toBe("APPLIED");
    expect(res.applied).toEqual({ maxConcurrency: 6 });
    expect(res.rejectedKeys).toEqual([]);
    expect(e.currentCaps().maxConcurrency).toBe(6);
    expect(e.currentCaps().amendCount).toBe(1);
    expect(typeof e.currentCaps().amendedAt).toBe("number");
  });

  it("subagentModel 受理并 trim;两次 amend 叠乘且 amendCount/amendedAt 递进", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    e.amend({ subagentModel: "  model-a  " });
    expect(e.currentCaps().subagentModel).toBe("model-a");
    const second = e.amend({ subagentModel: "model-b" });
    expect(second.code).toBe("APPLIED");
    expect(e.currentCaps().subagentModel).toBe("model-b");
    expect(e.currentCaps().amendCount).toBe(2);
  });

  it("未知字段 → INVALID_FIELD:rejectedKeys 点名,caps 不变,不写 journal", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    const before = j.readAll().length;
    const res = e.amend({ maxParallel: 8 } as never);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_FIELD");
    expect(res.rejectedKeys).toEqual(["maxParallel"]);
    expect(res.applied).toEqual({});
    expect(e.currentCaps()).toEqual({});
    expect(j.readAll().length).toBe(before);
  });

  it("引擎维护字段(amendedAt / amendCount)不接受外部 amend → INVALID_FIELD", () => {
    const e = makeEngine(new MemoryJournal());
    const res = e.amend({ amendedAt: 123, amendCount: 9 });
    expect(res.code).toBe("INVALID_FIELD");
    expect(res.rejectedKeys.sort()).toEqual(["amendCount", "amendedAt"]);
  });

  it("已知字段 + 未知字段混合 → 整体不应用(不静默丢弃未知字段)", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    const res = e.amend({ maxConcurrency: 8, subagentModel: "m", bogus: 1 } as never);
    expect(res.code).toBe("INVALID_FIELD");
    expect(res.rejectedKeys).toEqual(["bogus"]);
    expect(e.currentCaps()).toEqual({}); // 合法的 maxConcurrency 也没落地
    expect(capsEvents(j)).toHaveLength(0);
  });

  it("空 patch → INVALID_VALUE(不推进 amendCount)", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    const res = e.amend({});
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_VALUE");
    expect(e.currentCaps()).toEqual({});
    expect(capsEvents(j)).toHaveLength(0);
  });

  it("maxConcurrency 越界/非整数/错类型 → INVALID_VALUE,caps 不变", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j);
    for (const bad of [0, 33, -1, 1.5, Number.NaN, "8", null]) {
      const res = e.amend({ maxConcurrency: bad } as never);
      expect(res.code, `bad=${String(bad)}`).toBe("INVALID_VALUE");
    }
    expect(e.currentCaps()).toEqual({});
    expect(capsEvents(j)).toHaveLength(0);
  });

  it("maxConcurrency 边界值 1 与 32 均 APPLIED", () => {
    const e = makeEngine(new MemoryJournal());
    expect(e.amend({ maxConcurrency: 1 }).code).toBe("APPLIED");
    expect(e.amend({ maxConcurrency: 32 }).code).toBe("APPLIED");
    expect(e.currentCaps().maxConcurrency).toBe(32);
  });

  it("subagentModel 空 / 纯空白 / 超 128 字 → INVALID_VALUE", () => {
    const e = makeEngine(new MemoryJournal());
    for (const bad of ["", "   ", "x".repeat(129), 42]) {
      const res = e.amend({ subagentModel: bad } as never);
      expect(res.code, `bad=${String(bad).slice(0, 10)}`).toBe("INVALID_VALUE");
    }
    expect(e.currentCaps()).toEqual({});
  });
});

describe("journal 与 resume", () => {
  it("APPLIED 追加 workflow.caps:{caps, patch, at},sessionId=workflowId", () => {
    const j = new MemoryJournal();
    const e = makeEngine(j, { workflowId: "wf-j" });
    const res = e.amend({ maxConcurrency: 6 });
    expect(res.code).toBe("APPLIED");
    const evs = capsEvents(j);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.sessionId).toBe("wf-j");
    const p = evs[0]!.payload as { caps: WorkflowCaps; patch: Record<string, unknown>; at: number };
    expect(p.caps.maxConcurrency).toBe(6);
    expect(p.caps.amendCount).toBe(1);
    expect(p.patch).toEqual({ maxConcurrency: 6 });
    expect(p.at).toBe(p.caps.amendedAt);
  });

  it("resume:新引擎实例继承 journal 最后一条 caps(双 amend 取最后值)", () => {
    const j = new MemoryJournal();
    const e1 = makeEngine(j, { workflowId: "wf-resume" });
    e1.amend({ maxConcurrency: 4 });
    e1.amend({ maxConcurrency: 16, subagentModel: "model-x" });

    const e2 = makeEngine(j, { workflowId: "wf-resume" });
    expect(e2.currentCaps()).toMatchObject({ maxConcurrency: 16, subagentModel: "model-x", amendCount: 2 });
 // journal 里的 caps 优先于构造参数(热调整后的值才是权威)
    const e3 = makeEngine(j, { workflowId: "wf-resume", caps: { maxConcurrency: 2 } });
    expect(e3.currentCaps().maxConcurrency).toBe(16);
  });

  it("caps 不跨 workflowId 泄漏", () => {
    const j = new MemoryJournal();
    makeEngine(j, { workflowId: "wf-a" }).amend({ maxConcurrency: 8 });
    expect(makeEngine(j, { workflowId: "wf-b" }).currentCaps()).toEqual({});
  });

  it("resume 后 ask 缓存命中(dispatch 不重派),caps 仍是 amend 后的值", async () => {
    const j = new MemoryJournal();
    const script = `const x = await agent("a").ask("固定输入"); report({ x });`;
    let count = 0;
    const dispatch = async () => { count += 1; return "ok"; };
    const r1 = await makeEngine(j, { workflowId: "wf-r2", dispatch }).run(script);
    expect(r1.ok).toBe(true);
    expect(count).toBe(1);

    makeEngine(j, { workflowId: "wf-r2" }).amend({ maxConcurrency: 2 });
    const r2 = await makeEngine(j, { workflowId: "wf-r2", dispatch }).run(script);
    expect(count).toBe(1); // journal-first:缓存命中不重派
    expect(r2.items[0]).toEqual({ x: "ok" });
    expect(r2.caps?.maxConcurrency).toBe(2);
  });
});

describe("run 中的热调整", () => {
  it("在飞 ask 期间 amend:当前 run 不中断/不重启,结果与在飞成果保留,之后读到新值", async () => {
    const j = new MemoryJournal();
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const e = new WorkflowEngine({
      root: ROOT, journal: j, workflowId: "wf-live", executor: null as never,
      dispatch: async () => { started(); await gate; return "慢结果"; },
    });
    const runP = e.run(`const x = await agent("slow").ask("慢任务"); report({ x });`);
    await startedP; // 确定性:派发已真正开始,断言的是「在飞」状态

    const res = e.amend({ maxConcurrency: 8 });
    expect(res.code).toBe("APPLIED");
    expect(e.currentCaps().maxConcurrency).toBe(8);

    release();
    const r = await runP;
    expect(r.ok).toBe(true);
    expect(r.items[0]).toEqual({ x: "慢结果" }); // 在飞 ask 结果没丢
    expect(r.caps?.maxConcurrency).toBe(8); // 结果反映调整后的 caps
    expect(capsEvents(j)).toHaveLength(1); // 只追加事件,没有重启/清账
  });

  it("失败的 run 也带回 caps;amend 后的状态可被 resume 继承", async () => {
    const j = new MemoryJournal();
    const e = makeEngine(j, { workflowId: "wf-fail" });
    e.amend({ maxConcurrency: 2 });
    const r = await e.run(`report({ step: 1 }); throw new Error("炸了");`);
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.items).toHaveLength(1); // 已 report 成果保留
    expect(r.caps?.maxConcurrency).toBe(2);
    expect(makeEngine(j, { workflowId: "wf-fail" }).currentCaps().maxConcurrency).toBe(2);
  });
});
