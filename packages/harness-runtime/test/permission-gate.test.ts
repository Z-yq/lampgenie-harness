import { describe, it, expect } from "vitest";
import { AgentLoop, type Tool } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import type { PermissionRule } from "@lampgenie/core";

const tool: Tool = {
  name: "danger",
  description: "被闸工具",
  parameters: { type: "object", properties: {} },
  async execute() { return "executed"; },
};

function llm(script: string[], toolCalls?: { id: string; name: string; arguments: string }[]) {
  let i = 0;
  return {
    async chat() {
      const r = script[Math.min(i++, script.length - 1)!];
      return { content: r, ...(toolCalls && i === 1 ? { toolCalls } : {}) };
    },
  };
}

describe("loop 权限闸门( F2)", () => {
  it("deny:工具不执行,journal 落 permission.gate{effect:denied,by:rule}", async () => {
    const journal = new MemoryJournal();
    const rules: PermissionRule[] = [{ permission: "danger", pattern: "*", action: "deny" }];
    const loop = new AgentLoop({
      journal, sessionId: "pg1", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules },
    });
    const out = await loop.runTurn("做事");
    const gates = journal.readAll().filter((e) => e.kind === "permission.gate");
    expect(gates).toHaveLength(1);
    expect((gates[0]!.payload as { effect: string; by: string }).effect).toBe("denied");
    expect((gates[0]!.payload as { effect: string; by: string }).by).toBe("rule");
    expect(journal.readAll().some((e) => e.kind === "tool.result" && JSON.stringify(e.payload).includes("被权限规则拒绝"))).toBe(true);
    expect(out).toContain("收到");
  });

  it("ask:缺省 fail-closed 拒绝;askMode=allow 放行且落 allowed 事件", async () => {
    const j1 = new MemoryJournal();
    const rules: PermissionRule[] = [{ permission: "danger", pattern: "*", action: "ask" }];
    await new AgentLoop({
      journal: j1, sessionId: "pg2", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules },
    }).runTurn("做");
    expect(((j1.readAll().find((e) => e.kind === "permission.gate"))?.payload as { effect: string }).effect).toBe("denied");
    expect(((j1.readAll().find((e) => e.kind === "permission.gate"))?.payload as { by: string }).by).toBe("ask-default");

    const j2 = new MemoryJournal();
    await new AgentLoop({
      journal: j2, sessionId: "pg3", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules, askMode: "allow" },
    }).runTurn("做");
    const g = j2.readAll().find((e) => e.kind === "permission.gate")?.payload as { effect: string };
    expect(g.effect).toBe("allowed");
    expect(j2.readAll().some((e) => e.kind === "tool.result" && (e.payload as { content: string }).content === "executed")).toBe(true);
  });

  it("无规则:不设闸——零 permission.gate 事件,工具直通(行为不回退)", async () => {
    const journal = new MemoryJournal();
    await new AgentLoop({
      journal, sessionId: "pg4", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool],
    }).runTurn("做");
    expect(journal.readAll().filter((e) => e.kind === "permission.gate")).toHaveLength(0);
    expect(journal.readAll().some((e) => e.kind === "tool.result" && (e.payload as { content: string }).content === "executed")).toBe(true);
  });

  it("onAsk 审批链:放行→执行+by=ask-approved;拒绝→拦+审批文案;回调异常=拒绝(fail-closed)", async () => {
    const rules: PermissionRule[] = [{ permission: "danger", pattern: "*", action: "ask" }];
    // 放行
    const j1 = new MemoryJournal();
    await new AgentLoop({
      journal: j1, sessionId: "pg5", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules, onAsk: async () => true },
    }).runTurn("做");
    const g1 = (j1.readAll().find((e) => e.kind === "permission.gate"))?.payload as { effect: string; by: string };
    expect(g1.effect).toBe("allowed");
    expect(g1.by).toBe("ask-approved");
    expect(j1.readAll().some((e) => e.kind === "tool.result" && (e.payload as { content: string }).content === "executed")).toBe(true);
    // 拒绝
    const j2 = new MemoryJournal();
    const out2 = await new AgentLoop({
      journal: j2, sessionId: "pg6", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules, onAsk: async () => false },
    }).runTurn("做");
    const g2 = (j2.readAll().find((e) => e.kind === "permission.gate"))?.payload as { effect: string; by: string };
    expect(g2.effect).toBe("denied");
    expect(g2.by).toBe("ask-rejected");
    expect(out2).toContain("收到");
    expect(j2.readAll().some((e) => e.kind === "tool.result" && String((e.payload as { content: string }).content).includes("被权限审批拒绝"))).toBe(true);
    // 回调异常=拒绝(fail-closed,不因审批链故障放宽)
    const j3 = new MemoryJournal();
    await new AgentLoop({
      journal: j3, sessionId: "pg7", system: "s",
      llm: llm(["调工具", "收到"], [{ id: "c1", name: "danger", arguments: "{}" }]),
      tools: [tool], permission: { rules, onAsk: async () => { throw new Error("broker down"); } },
    }).runTurn("做");
    const g3 = (j3.readAll().find((e) => e.kind === "permission.gate"))?.payload as { effect: string };
    expect(g3.effect).toBe("denied");
  });

  it("task_output→subagent 类别名(权限传递):规则按 subagent 写时收割工具同闸放行", async () => {
    const journal = new MemoryJournal();
    const harvest: Tool = { ...tool, name: "task_output" };
    const rules: PermissionRule[] = [{ permission: "subagent", pattern: "*", action: "allow" }];
    await new AgentLoop({
      journal, sessionId: "pg8", system: "s",
      llm: llm(["收割", "收到"], [{ id: "c1", name: "task_output", arguments: "{}" }]),
      tools: [harvest], permission: { rules },
    }).runTurn("做");
    expect(journal.readAll().some((e) => e.kind === "tool.result" && (e.payload as { content: string }).content === "executed")).toBe(true);
  });
});
