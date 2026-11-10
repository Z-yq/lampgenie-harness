/**
 * J4(2026-11-05 用户口径「排序要按 session 有动作更新时间」):会话最近活动时间索引契约。
 * ①白名单口径:用户可见动作刷新,流式噪声(llm.trace/step.*\/tool.tokens/sense.*)不刷新;
 * ②单调:旧事件不覆盖新时间;无 sessionId 的事件忽略;
 * ③启动回放保留(seed 与运行期 noteEvent 同源);
 * ④hello 带 sessionActivity 快照;session.status.changed 帧带 lastActivityAt(复用 200ms 合并,不新增帧类型)。
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { MemoryJournal } from "@lampgenie/core";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { NodeRegistry } from "../src/nodes.js";
import { SessionActivityIndex, isSessionActivityKind, SESSION_ACTIVITY_KINDS } from "../src/session-activity.js";

describe("会话活动索引(J4)", () => {
  it("①白名单:消息/工具/任务/白板算活动,流式噪声不算", () => {
    for (const k of ["message.user", "message.agent", "tool.call", "tool.result", "task.start", "board.update", "subagent.result", "plan.saved"]) {
      expect(isSessionActivityKind(k), k).toBe(true);
    }
    for (const k of ["llm.trace", "tool.tokens", "step.start", "step.end", "turn.start", "turn.end", "sense.preheat", "sense.orient", "permission.gate", "task.deleted"]) {
      expect(isSessionActivityKind(k), k).toBe(false);
    }
    expect(SESSION_ACTIVITY_KINDS.size).toBeGreaterThan(10);
  });

  it("②单调写入 + 无 sessionId / 非白名单忽略", () => {
    const idx = new SessionActivityIndex();
    expect(idx.note("a", 1000)).toBe(1000);
    expect(idx.note("a", 500)).toBe(1000);           // 旧时间不回退
    expect(idx.note("a", 2000)).toBe(2000);
    expect(idx.get("a")).toBe(2000);
    expect(idx.note(undefined, 5000)).toBeUndefined(); // 无会话归属
    expect(idx.get("ghost")).toBeUndefined();
    // 非白名单 kind 通过 noteEvent 不记
    expect(idx.noteEvent({ kind: "llm.trace", sessionId: "a", time: 9000 })).toBeUndefined();
    expect(idx.get("a")).toBe(2000);
  });

  it("③seed 回放:多会话各取最后一条白名单事件时间", () => {
    const idx = new SessionActivityIndex();
    const n = idx.seed([
      { kind: "message.user", sessionId: "s1", time: 100 },
      { kind: "step.start", sessionId: "s1", time: 5000 },       // 噪声不推进
      { kind: "tool.result", sessionId: "s1", time: 300 },
      { kind: "message.agent", sessionId: "s2", time: 400 },
      { kind: "task.done", sessionId: "s2", time: 250 },
    ]);
    expect(n).toBe(2);
    expect(idx.get("s1")).toBe(300);
    expect(idx.get("s2")).toBe(400);
    expect(idx.snapshot()).toEqual({ s1: 300, s2: 400 });
  });

  it("⑤forget:会话删除/归档清空后不残留(同 sid 复用不继承旧活动时间)", () => {
    const idx = new SessionActivityIndex();
    idx.note("gone", 5000);
    idx.note("keep", 6000);
    expect(idx.size()).toBe(2);
    idx.forget("gone");
    expect(idx.get("gone")).toBeUndefined();
    expect(idx.get("keep")).toBe(6000);
    idx.forget(undefined); // 空 sid 不抛
    expect(idx.size()).toBe(1);
  });

  it("④网关装配:hello 带 sessionActivity;活动事件触发 session.status.changed(带 lastActivityAt)", async () => {
    const port = 7891;
    const journal = new MemoryJournal();
    journal.append({ kind: "message.user", sessionId: "s-act", payload: { text: "hi" } });
    const idx = new SessionActivityIndex();
    idx.seed(journal.readAll());
    const tm = new TaskSupervisor();
    tm.submit("user", "s-act", "有任务但很久没更新"); // Task.updatedAt=now,不参与本断言
    const srv = startGatewayServer({ port, taskManager: tm, journal, nodes: new NodeRegistry(), sessionActivity: idx });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (r) => frames.push(JSON.parse(r.toString())));

    const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("hello 超时")), 5000);
      ws.on("message", (r) => {
        const m = JSON.parse(r.toString());
        if (m.type === "hello") { clearTimeout(t); resolve(m); }
      });
    });
    // ①首帧快照:历史活动时间随 hello 下发
    expect((hello.sessionActivity as Record<string, number>)["s-act"]).toBeTypeOf("number");

    // ②运行期活动 → status 帧带 lastActivityAt
    const before = Date.now();
    journal.append({ kind: "tool.call", sessionId: "s-act", payload: { name: "read_file" } });
    const chg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("session.status.changed 超时")), 5000);
      ws.on("message", (r) => {
        const m = JSON.parse(r.toString());
        if (m.type === "session.status.changed" && m.sessionId === "s-act") { clearTimeout(t); resolve(m); }
      });
    });
    expect(chg.lastActivityAt as number).toBeGreaterThanOrEqual(before - 1);
    expect(frames.some((f) => f.type === "session.activity")).toBe(false); // 不新增帧类型

    ws.close();
    await srv.close();
  }, 20_000);
});
