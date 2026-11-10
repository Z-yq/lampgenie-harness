import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryJournal } from "@lampgenie/core";
import {
  extractStateMachineFromTransitions,
  runtimeSequenceFromJournal,
  sequenceOfSymbol,
} from "../src/sequence/index";

const REPO = "/mnt/e/workship/genie/lampgenie-harness";

describe("D19 状态机:TRANSITIONS 金标准", () => {
  it("六态+全部迁移边被抽出", () => {
    const src = readFileSync(`${REPO}/packages/core/src/task/task.ts`, "utf-8");
    const sm = extractStateMachineFromTransitions(src);
    expect(sm).toBeTruthy();
    expect(sm!.states.sort()).toEqual(["blocked", "cancelled", "done", "failed", "queued", "running"]);
    // 迁移边:queued 4 条(迁移表修复后)+running 4+blocked 2=≥10
    expect(sm!.transitions.length).toBeGreaterThanOrEqual(10);
    expect(sm!.mermaid).toContain("queued --> running");
    expect(sm!.mermaid).toContain("stateDiagram-v2");
  });
});

describe("D18 静态时序:语句序+异步边界", () => {
  it("runTurn 的调用序与源码语句序一致,异步边界>0", async () => {
    const seq = await sequenceOfSymbol(REPO, ["packages/harness-runtime/src/agent/loop.ts"], "runTurn");
    expect(seq).toBeTruthy();
    expect(seq!.steps.length).toBeGreaterThan(3);
    const names = seq!.steps.map((s) => s.callee);
    const iAppend = names.findIndex((n) => n.includes("append"));
    const iChat = names.findIndex((n) => n.includes("chat"));
    expect(iAppend).toBeGreaterThanOrEqual(0);
    expect(iChat).toBeGreaterThan(iAppend); // append(user) 先于 llm.chat(语句序)
    expect(seq!.asyncBoundaries).toBeGreaterThan(0); // await 边界存在
    expect(seq!.mermaid).toContain("静态序≠运行序");
  }, 60_000);
});

describe("journal 动态序", () => {
  it("事件序→sequenceDiagram", () => {
    const j = new MemoryJournal();
    j.append({ kind: "task.enqueue", sessionId: "s", payload: {}, time: 1 });
    j.append({ kind: "tool.call", sessionId: "s", payload: {}, time: 2 });
    j.append({ kind: "tool.result", sessionId: "s", payload: {}, time: 3 });
    j.append({ kind: "task.done", sessionId: "s", payload: {}, time: 4 });
    const rt = runtimeSequenceFromJournal(j, "s");
    expect(rt.events.map((e) => e.kind)).toEqual(["task.enqueue", "tool.call", "tool.result", "task.done"]);
    expect(rt.mermaid).toContain("sequenceDiagram");
  });
});
