/**
 * 会话完整导出(2026-10-19 用户口径「日志下载就应该下载完全的内容」):
 * 此前「↓ 日志」只导 journal 事件(指针+摘要)——system 提示词/消息构型/工具 schema/响应
 * 全在 .genie/llm-trace 文件里,下载拿不到。本测试钉住三层打包契约:
 * ① export.meta 头行 ② journal 逐事件原样 ③ llm.trace 指针 → llm.trace.full 全文内嵌
 * ④ subagent.spawn.taskId → subagent-<id>(+ -retry)目录下 call-*.json 全文;
 * ⑤ 缺失文件不静默(missing:true + stats.missing)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionExport, subagentTraceDirs } from "../src/session-export-full.js";

function trace(tag: string) {
  return {
    ts: 1, sessionId: "s", turn: 1, step: 0, model: "GLM-5.3-Flash", durationMs: 10,
    toolNames: ["grep"], tools: [{ name: "grep", description: "d", parameters: { type: "object" } }],
    request: { messageCount: 1, messages: [{ role: "system", content: "SYSTEM-" + tag }] },
    response: { content: "OUT-" + tag },
  };
}

describe("buildSessionExport(完整会话导出)", () => {
  it("① 头行+journal 原样+LLM 轨迹全文+子代理轨迹(主目录与 -retry)", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-export-"));
    const traceRoot = join(root, "llm-trace");
    // 主会话轨迹文件
    mkdirSync(join(traceRoot, "web-x"), { recursive: true });
    const mainTraceFile = join(traceRoot, "web-x", "call-0001-t1s0-1.json");
    writeFileSync(mainTraceFile, JSON.stringify(trace("main")));
    // 子代理轨迹(首跑 1 调 + 重派 1 调)
    const tid = "task-abc";
    mkdirSync(join(traceRoot, subagentTraceDirs(tid)[0]), { recursive: true });
    mkdirSync(join(traceRoot, subagentTraceDirs(tid)[1]), { recursive: true });
    writeFileSync(join(traceRoot, subagentTraceDirs(tid)[0], "call-0001-t1s0-1.json"), JSON.stringify(trace("sub1")));
    writeFileSync(join(traceRoot, subagentTraceDirs(tid)[1], "call-0001-t1s0-2.json"), JSON.stringify(trace("retry1")));

    const events = [
      { seq: 1, time: 100, sessionId: "web-x", kind: "task.start", payload: { instruction: "修 bug" } },
      { seq: 2, time: 200, sessionId: "web-x", kind: "llm.trace", payload: { file: mainTraceFile, model: "GLM-5.3-Flash", messageRoles: ["system"] } },
      { seq: 3, time: 300, sessionId: "web-x", kind: "subagent.spawn", payload: { taskId: tid, instructions: "调查" } },
      { seq: 4, time: 400, sessionId: "web-x", kind: "task.done", payload: { state: "done" } },
    ];
    const out = buildSessionExport({ sessionId: "web-x", events, traceRoot, now: () => 999 });
    const lines = out.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].kind).toBe("export.meta");
    expect(lines[0].sessionId).toBe("web-x");
    // journal 4 事件原样在场
    const journalKinds = lines.filter((l) => l.seq !== undefined && l.kind !== "llm.trace.full").map((l) => l.kind);
    expect(journalKinds).toEqual(["task.start", "llm.trace", "subagent.spawn", "task.done"]);
    // LLM 轨迹全文内嵌(system 与响应都在)
    const full = lines.filter((l) => l.kind === "llm.trace.full");
    expect(full).toHaveLength(1);
    expect(full[0].trace.request.messages[0].content).toBe("SYSTEM-main");
    expect(full[0].trace.response.content).toBe("OUT-main");
    // 子代理轨迹:首跑+重派都在,且带 taskId
    const sub = lines.filter((l) => l.kind === "subagent.trace.full");
    expect(sub).toHaveLength(2);
    expect(sub.every((l) => l.taskId === tid)).toBe(true);
    expect(sub.map((l) => l.trace.response.content).sort()).toEqual(["OUT-retry1", "OUT-sub1"]);
    expect(out.stats).toMatchObject({ events: 4, llmTraces: 1, subagentTraces: 2, missing: 0 });
    expect(out.stats.bytes).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("② 缺失文件不静默:指针文件被清掉 → missing:true + stats.missing 计数", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-export2-"));
    const traceRoot = join(root, "llm-trace");
    const missingFile = join(traceRoot, "web-y", "call-0001-t1s0-1.json"); // 不创建
    const events = [
      { seq: 1, time: 1, sessionId: "web-y", kind: "llm.trace", payload: { file: missingFile } },
      { seq: 2, time: 2, sessionId: "web-y", kind: "subagent.spawn", payload: { taskId: "nope-task" } },
    ];
    const out = buildSessionExport({ sessionId: "web-y", events, traceRoot, now: () => 1 });
    const lines = out.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((l) => l.kind === "llm.trace.full")!.missing).toBe(true);
    expect(out.stats.missing).toBe(1);
    expect(out.stats.llmTraces).toBe(0);
    expect(out.stats.subagentTraces).toBe(0); // 无目录=零,不算 missing
    rmSync(root, { recursive: true, force: true });
  });

  it("③ 无轨迹时也能导出(纯 journal;老会话向后兼容)", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-export3-"));
    const out = buildSessionExport({
      sessionId: "old", traceRoot: join(root, "llm-trace"), now: () => 1,
      events: [{ seq: 1, time: 1, sessionId: "old", kind: "message.user", payload: { text: "hi" } }],
    });
    const lines = out.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2); // meta + 1 事件
    expect(out.stats).toMatchObject({ events: 1, llmTraces: 0, subagentTraces: 0, missing: 0 });
    rmSync(root, { recursive: true, force: true });
  });
});

describe("子代理轨迹目录发现(2026-10-19 taskId 唯一化后)", () => {
  it("subagent-<subTaskId>-sub / -bg 后缀目录都能被导出(前缀匹配)", () => {
    const root = mkdtempSync(join(tmpdir(), "sess-export4-"));
    const traceRoot = join(root, "llm-trace");
    const subId = "75dbda13-ab12cd34"; // 新形态:父 id 前缀 + 每次派发唯一后缀
    mkdirSync(join(traceRoot, "subagent-" + subId + "-sub"), { recursive: true });
    mkdirSync(join(traceRoot, "subagent-" + subId + "-bg"), { recursive: true });
    writeFileSync(join(traceRoot, "subagent-" + subId + "-sub", "call-0001-t1s0-1.json"), JSON.stringify(trace("s1")));
    writeFileSync(join(traceRoot, "subagent-" + subId + "-bg", "call-0001-t1s0-2.json"), JSON.stringify(trace("b1")));
    const out = buildSessionExport({
      sessionId: "web-z", traceRoot, now: () => 1,
      events: [{ seq: 1, time: 1, sessionId: "web-z", kind: "subagent.spawn", payload: { taskId: subId } }],
    });
    const lines = out.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.kind === "subagent.trace.full")).toHaveLength(2);
    expect(out.stats.subagentTraces).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });
});
