import { describe, it, expect } from "vitest";
import { buildTodoReminder } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";

describe("buildTodoReminder(designs/25 ZCode todo reminder)", () => {
  it("有未完成项 → 提醒含条目与更新指引", () => {
    const j = new MemoryJournal();
    j.append({ kind: "todo.updated", sessionId: "s1", payload: { items: [
      { content: "实现登录", status: "completed" },
      { content: "写单测", status: "in_progress" },
      { content: "更新文档", status: "pending" },
    ] } });
    const r = buildTodoReminder(j, "s1");
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("写单测");
    expect(r).toContain("更新文档");
    expect(r).not.toContain("实现登录"); // 已完成项不进提醒
    expect(r).toContain("todo_write");
  });

  it("无 todo/全完成/其它会话 → null(不产生空提醒)", () => {
    const j = new MemoryJournal();
    expect(buildTodoReminder(j, "s1")).toBeNull();
    j.append({ kind: "todo.updated", sessionId: "s1", payload: { items: [{ content: "x", status: "completed" }] } });
    expect(buildTodoReminder(j, "s1")).toBeNull();
    j.append({ kind: "todo.updated", sessionId: "s2", payload: { items: [{ content: "y", status: "pending" }] } });
    expect(buildTodoReminder(j, "s1")).toBeNull();
  });
});

describe("已读清单变化触发(2026-10-24 同清单不逐步复读;2026-11-05 D4 删每10步周期刷新,只认签名变化)", () => {
  it("清单不变 → 只在首次请求携带一次,后续请求零复读", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const { recordFileRead } = await import("../src/agent/read-file-state");
    const sid = "read-gate-1-" + Date.now();
    recordFileRead(sid, "a.ts");
    let n = 0;
    const carried: number[] = [];
    const llm = {
      async chat(messages: { content: unknown }[]) {
        n++;
        carried.push(messages.filter((m) => String(m.content).includes("已读文件清单")).length);
        return n < 3 ? { content: "", toolCalls: [{ id: "c" + n, name: "echo", arguments: "{}" }] } : { content: "done" };
      },
    } as never;
    const loop = new AgentLoop({ journal: new MemoryJournal(), sessionId: sid, system: "s", llm, tools: [{ name: "echo", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, async execute() { return "ok"; } } as never] });
    await loop.runTurn("go");
    expect(carried.reduce((a, b) => a + b, 0)).toBe(1); // 3 次请求仅首带,旧版(每10步刷新)会是 3
  });

  it("长会话跨周期点(≥12 步)清单不变 → 周期点零注入(D4:删 step%10 刷新路径)", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const { recordFileRead } = await import("../src/agent/read-file-state");
    const sid = "read-gate-3-" + Date.now();
    recordFileRead(sid, "a.ts");
    let n = 0;
    const carried: number[] = [];
    const llm = {
      async chat(messages: { content: unknown }[]) {
        n++;
        carried.push(messages.filter((m) => String(m.content).includes("已读文件清单")).length);
        return n < 12 ? { content: "", toolCalls: [{ id: "c" + n, name: "echo", arguments: "{}" }] } : { content: "done" };
      },
    } as never;
    const loop = new AgentLoop({ journal: new MemoryJournal(), sessionId: sid, system: "s", llm, tools: [{ name: "echo", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, async execute() { return "ok"; } } as never] });
    await loop.runTurn("go");
    expect(carried.reduce((a, b) => a + b, 0)).toBe(1); // 12 次请求(跨 step10)仅首带——旧版会在 step10 再注
  });

  it("清单变化(新读文件)→ 下一次请求再注入", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const { recordFileRead } = await import("../src/agent/read-file-state");
    const sid = "read-gate-2-" + Date.now();
    recordFileRead(sid, "a.ts");
    let n = 0;
    const carried: number[] = [];
    const llm = {
      async chat(messages: { content: unknown }[]) {
        n++;
        carried.push(messages.filter((m) => String(m.content).includes("已读文件清单")).length);
        return n < 3 ? { content: "", toolCalls: [{ id: "c" + n, name: "echo", arguments: "{}" }] } : { content: "done" };
      },
    } as never;
    const tools = [{
      name: "echo", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true,
      async execute() { if (n === 1) recordFileRead(sid, "b.ts"); return "ok"; }, // 步1 新读文件 → 步2 清单变化
    } as never];
    const loop = new AgentLoop({ journal: new MemoryJournal(), sessionId: sid, system: "s", llm, tools });
    await loop.runTurn("go");
    expect(carried.reduce((a, b) => a + b, 0)).toBe(2); // 首次 + 变化后各一次
  });
});

describe("待决审批注入语义(2026-11-05 D4 复核定性:到达性必需,非泄漏)", () => {
  it("待决期间逐步重注(ephemeral 不进历史,不重注=父丢失 requestId 无法应答)", async () => {
    const { AgentLoop } = await import("../src/agent/loop");
    const sid = "pq-gate-1-" + Date.now();
    let pending = 1;
    let n = 0;
    const carries: number[] = [];
    const llm = {
      async chat(messages: { role: string; content: unknown }[]) {
        n++;
        carries.push(messages.filter((m) => m.role === "user" && String(m.content).includes("子代理重操作审批")).length);
        if (n < 3) return { content: "", toolCalls: [{ id: "c" + n, name: "echo", arguments: "{}" }] };
        pending = 0; // 了结(下一步组装前置 0;本用例焦点=待决期间逐步可见,了结撤由 parent-ask-broker 集成测覆盖)
        return { content: "done" };
      },
    } as never;
    const loop = new AgentLoop({
      journal: new MemoryJournal(), sessionId: sid, system: "s", llm,
      tools: [{ name: "echo", description: "d", parameters: { type: "object", properties: {} }, isConcurrencySafe: () => true, async execute() { return "ok"; } } as never],
      pendingQuestions: () => pending > 0 ? "<system-reminder>[子代理重操作审批] 有 1 个待决申请需要你决策。</system-reminder>" : null,
    });
    await loop.runTurn("go");
    expect(carries).toEqual([1, 1, 1]); // 待决期间每个请求都可见(ephemeral 逐步重注=到达性);首步即注(pending 从一开始就>0)
  });
});
