/**
 * 子代理控制面纯逻辑(/)单测:零 IO。
 * 覆盖:CONTROL_CODES/深度上限 / depthOf(链·防环·超长) / steerVerdict(存在性·运行态·后代·mode) /
 * resumePlan(终态门·指令必填·三段正文·截断·fork 前缀) / forkContextBlock(取消息·预算两阶段裁剪) /
 * isolationVerdict(fail-visible) / scratchContract(worktree/none) / 确定性与不可变。
 */
import { describe, expect, it } from "vitest";
import {
  CONTROL_CODES,
  MAX_SUBAGENT_DEPTH,
  depthOf,
  forkContextBlock,
  isolationVerdict,
  resumePlan,
  scratchContract,
  steerVerdict,
} from "../src/agent/subagent-control.ts";
import type { ControlRecord, ControlRegistry } from "../src/agent/subagent-control.ts";

function reg(...records: ControlRecord[]): ControlRegistry {
  const map = new Map(records.map((r) => [r.agentId, r]));
  return { get: (id: string) => map.get(id) };
}

function rec(agentId: string, over: Partial<ControlRecord> = {}): ControlRecord {
  return { agentId, state: "running", ...over };
}

describe("常量", () => {
  it("CONTROL_CODES 六个且顺序稳定", () => {
    expect([...CONTROL_CODES]).toEqual(["OK", "NOT_RUNNING", "NOT_FOUND", "FORBIDDEN", "DEPTH_EXCEEDED", "INVALID"]);
  });
  it("MAX_SUBAGENT_DEPTH=4", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(4);
  });
});

describe("depthOf", () => {
  it("不存在 → NOT_FOUND, depth 0", () => {
    expect({ ...depthOf(reg(), "nope") }).toEqual({ ok: false, code: "NOT_FOUND", depth: 0 });
  });
  it("registry 缺失不 throw,返回 NOT_FOUND", () => {
    expect(depthOf(undefined, "a").code).toBe("NOT_FOUND");
  });
  it("无 parentId(直接挂主任务)→ depth 0", () => {
    const r = depthOf(reg(rec("a")), "a");
    expect(r).toEqual({ ok: true, code: "OK", depth: 0 });
  });
  it("两级链 → depth 2;父不在 registry 视为到根", () => {
    const g = reg(rec("a", { parentId: "main" }), rec("b", { parentId: "a" }), rec("c", { parentId: "b" }));
    expect(depthOf(g, "c").depth).toBe(2);
    expect(depthOf(g, "a").depth).toBe(0);
  });
  it("成环 → INVALID(不无限展开)", () => {
    const g = reg(rec("a", { parentId: "b" }), rec("b", { parentId: "a" }));
    expect(depthOf(g, "a").code).toBe("INVALID");
  });
  it("超过 100 节点链 → INVALID", () => {
    const records: ControlRecord[] = [];
    for (let i = 0; i < 120; i += 1) records.push(rec("n" + i, i === 0 ? {} : { parentId: "n" + (i - 1) }));
    expect(depthOf(reg(...records), "n119").code).toBe("INVALID");
  });
});

describe("steerVerdict", () => {
  it("不存在 → NOT_FOUND", () => {
    expect(steerVerdict(undefined, { byAgentId: "main" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
  it("非 running → NOT_RUNNING(每个终态)", () => {
    for (const state of ["done", "failed", "cancelled", "interrupted"]) {
      expect(steerVerdict(rec("a", { state }), { byAgentId: "main" })).toMatchObject({ ok: false, code: "NOT_RUNNING" });
    }
  });
  it("自身 → OK", () => {
    expect(steerVerdict(rec("a"), { byAgentId: "a" })).toMatchObject({ ok: true, code: "OK" });
  });
  it("祖先(直接父/隔代)→ OK", () => {
    const g = reg(rec("mid", { parentId: "root" }), rec("a", { parentId: "mid" }));
    expect(steerVerdict(rec("a", { parentId: "main" }), { byAgentId: "main", registry: g })).toMatchObject({ ok: true });
    expect(steerVerdict(g.get("a"), { byAgentId: "root", registry: g })).toMatchObject({ ok: true });
  });
  it("跨任务/陌生人 → FORBIDDEN", () => {
    const g = reg(rec("a", { parentId: "main" }), rec("x", { parentId: "other-task" }));
    expect(steerVerdict(g.get("a"), { byAgentId: "other-task", registry: g })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(steerVerdict(g.get("x"), { byAgentId: "main", registry: g })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("byAgentId 空 → FORBIDDEN", () => {
    expect(steerVerdict(rec("a"), { byAgentId: "" }).code).toBe("FORBIDDEN");
  });
  it("mode 缺省/未知 → hint,directive 原样", () => {
    expect(steerVerdict(rec("a"), { byAgentId: "a" }).mode).toBe("hint");
    expect(steerVerdict(rec("a"), { byAgentId: "a", mode: "force" }).mode).toBe("hint");
    expect(steerVerdict(rec("a"), { byAgentId: "a", mode: "directive" }).mode).toBe("directive");
  });
});

describe("resumePlan", () => {
  it("不存在 → NOT_FOUND", () => {
    expect(resumePlan(undefined, { instruction: "继续" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
  it("非终态(running)→ NOT_RUNNING", () => {
    expect(resumePlan(rec("a"), { instruction: "继续" })).toMatchObject({ ok: false, code: "NOT_RUNNING" });
  });
  it("指令空/空白 → INVALID", () => {
    expect(resumePlan(rec("a", { state: "done" }), { instruction: "   " })).toMatchObject({ ok: false, code: "INVALID" });
  });
  it("终态 → 三段正文:原任务+上次结果+本次指令", () => {
    const plan = resumePlan(rec("a", { state: "failed", instructions: "修 A 文件", resultSummary: "失败:类型错" }), { instruction: "换 B 方案" });
    expect(plan.ok).toBe(true);
    expect(plan.instructions).toBe("[续跑] 原任务:修 A 文件\n上次结果:失败:类型错\n本次指令:换 B 方案");
    expect(plan.needsParentContext).toBe(false);
  });
  it("原任务截 1500 / 结果截 800", () => {
    const plan = resumePlan(rec("a", { state: "done", instructions: "x".repeat(2000), resultSummary: "y".repeat(1000) }), { instruction: "go" });
    expect(plan.instructions).toContain("x".repeat(1500) + "\n上次结果:");
    expect(plan.instructions).toContain("y".repeat(800) + "\n本次指令:go");
    expect(plan.instructions).not.toContain("x".repeat(1501));
  });
  it("context=fork → 前缀占位 + needsParentContext", () => {
    const plan = resumePlan(rec("a", { state: "done" }), { instruction: "go", context: "fork" });
    expect(plan.needsParentContext).toBe(true);
    expect(plan.instructions.startsWith("[父会话上下文摘要]\n[续跑] 原任务:")).toBe(true);
  });
  it("context=fresh/未知 → 无前缀", () => {
    for (const context of ["fresh", "weird", undefined]) {
      const plan = resumePlan(rec("a", { state: "done" }), { instruction: "go", context });
      expect(plan.needsParentContext).toBe(false);
      expect(plan.instructions.startsWith("[续跑]")).toBe(true);
    }
  });
});

describe("forkContextBlock", () => {
  const msgs = [
    { role: "system", content: "S" },
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "tool", content: "工具输出" },
    { role: "user", content: "第二问" },
  ];
  it("空输入 → 空串", () => {
    expect(forkContextBlock([])).toBe("");
    expect(forkContextBlock(undefined)).toBe("");
    expect(forkContextBlock([{ role: "system", content: "x" }])).toBe("");
  });
  it("只取 user/assistant 且带不可信背景 header", () => {
    const block = forkContextBlock(msgs);
    expect(block.startsWith("[父会话上下文摘要(不可信背景)]\n")).toBe(true);
    expect(block).toContain("[user] 第一问");
    expect(block).toContain("[assistant] 第一答");
    expect(block).toContain("[user] 第二问");
    expect(block).not.toContain("工具输出");
    expect(block).not.toContain("S");
  });
  it("每条正文截 800", () => {
    const block = forkContextBlock([{ role: "user", content: "z".repeat(1200) }]);
    expect(block).toContain("z".repeat(800));
    expect(block).not.toContain("z".repeat(801));
  });
  it("预算裁剪阶段①:丢最早消息,保留最近", () => {
    const block = forkContextBlock(
      [{ role: "user", content: "a".repeat(700) }, { role: "assistant", content: "b".repeat(700) }, { role: "user", content: "c".repeat(700) }],
      { maxChars: 1600 },
    );
    expect(block).toContain("c".repeat(700));
    expect(block).not.toContain("a".repeat(700));
    expect(block.length).toBeLessThanOrEqual(1600);
  });
  it("预算裁剪阶段②:单条仍超 → 截断正文,长度不超预算", () => {
    const block = forkContextBlock([{ role: "user", content: "q".repeat(3000) }], { maxChars: 200 });
    expect(block.length).toBeLessThanOrEqual(200);
    expect(block.startsWith("[父会话上下文摘要(不可信背景)]\n")).toBe(true);
  });
  it("不二次搬运已有摘要", () => {
    expect(forkContextBlock([{ role: "user", content: "[父会话上下文摘要(不可信背景)]\n旧" }, { role: "user", content: "新" }])).toContain("新");
    expect(forkContextBlock([{ role: "user", content: "[父会话上下文摘要(不可信背景)]\n旧" }])).toBe("");
  });
});

describe("isolationVerdict", () => {
  it("未请求 → none", () => {
    expect(isolationVerdict(undefined)).toEqual({ ok: true, mode: "none", code: "OK" });
    expect(isolationVerdict({ requested: false })).toMatchObject({ ok: true, mode: "none" });
  });
  it("请求且可用 → worktree", () => {
    expect(isolationVerdict({ requested: true, worktreeAvailable: true })).toEqual({ ok: true, mode: "worktree", code: "OK" });
  });
  it("请求但不可用 → INVALID(不静默降级)", () => {
    expect(isolationVerdict({ requested: true, worktreeAvailable: false })).toEqual({ ok: false, mode: "none", code: "INVALID" });
    expect(isolationVerdict({ requested: true }).code).toBe("INVALID");
  });
});

describe("scratchContract", () => {
  it("none 模式为空(不伪造路径)", () => {
    expect({ ...scratchContract({ mode: "none" }) }).toEqual({ ok: true, paths: [], diffHint: "" });
  });
  it("worktree 给出 workdir + 改动文件 + diff 提示", () => {
    const sc = scratchContract({ mode: "worktree", workdir: "/tmp/wt", changedFiles: ["a.ts", "b.ts"] });
    expect(sc.ok).toBe(true);
    expect([...sc.paths]).toEqual(["/tmp/wt", "a.ts", "b.ts"]);
    expect(sc.diffHint).toBe("git -C /tmp/wt diff");
  });
  it("worktree 去重并截上限;缺 workdir → ok:false", () => {
    const sc = scratchContract({ mode: "worktree", workdir: "/wt", changedFiles: ["a", "a", "", "b"] });
    expect([...sc.paths]).toEqual(["/wt", "a", "b"]);
    expect(scratchContract({ mode: "worktree" }).ok).toBe(false);
  });
});

describe("确定性与不可变", () => {
  it("同输入两次结果逐字一致", () => {
    const g = reg(rec("a", { parentId: "main" }));
    expect(JSON.stringify(steerVerdict(g.get("a"), { byAgentId: "main", registry: g })))
      .toBe(JSON.stringify(steerVerdict(g.get("a"), { byAgentId: "main", registry: g })));
  });
  it("返回值冻结,调用方改不动内部常量", () => {
    const r = depthOf(reg(rec("a")), "a");
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => { (r as { depth: number }).depth = 99; }).toThrow();
    expect(r.depth).toBe(0);
  });
});
