/**
 *  用户停止 → 不复活专项。
 * 锚定:
 * ① 取消落 journal custom `task.user_stopped`(先落标记再 abort;标记写失败只告警,不改取消结果);
 * ② WS `task.resume` 命中标记 → error code=task-stopped-by-user;
 * ③ 冷恢复:running/blocked 且会话在任务创建后有停止标记 → 收编 cancelled(非 interrupted);
 * ④ autoResumeInterrupted 不再纳入被停止过的任务。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { MemoryJournal } from "@lampgenie/core";
import type { Journal, NewEvent, JournalEvent, EventListener } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { createGatewayApp } from "../src/app.js";
import {
  appendUserStoppedMarker,
  hasUserStoppedSince,
  readUserStoppedMarkers,
  USER_STOPPED_RESUME_CODE,
  USER_STOPPED_RESUME_MESSAGE,
  USER_STOPPED_EVENT,
} from "../src/user-stop-marker.js";

function mkTask(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "t1", sessionId: "s1", instruction: "把登录页修好",
    state: "running", createdAt: now, updatedAt: now, ...over,
  } as never;
}

describe("停止标记 helpers", () => {
  it("append → 可读回(payload.type=task.user_stopped,source 缺省 cancel)", () => {
    const j = new MemoryJournal();
    expect(appendUserStoppedMarker(j, { taskId: "t1", sessionId: "s1" })).toBe(true);
    const marks = readUserStoppedMarkers(j, "s1");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.taskId).toBe("t1");
    expect(marks[0]!.source).toBe("cancel");
    const raw = j.readAll().find((e) => e.kind === "custom")!;
    expect((raw.payload as { type: string }).type).toBe(USER_STOPPED_EVENT);
  });

  it("标记写失败:只告警不改取消结果(返回 false,不抛)", () => {
    const j = new MemoryJournal();
    const boom: Journal = {
      append() { throw new Error("journal unavailable"); },
      appendMany<T>(events: NewEvent<T>[]) { return events as unknown as JournalEvent<T>[]; },
      readAll() { return j.readAll(); },
      readSession() { return []; },
      subscribe(_l: EventListener) { return () => {}; },
      get length() { return 0; },
    };
    expect(() => appendUserStoppedMarker(boom, { taskId: "t1", sessionId: "s1" })).not.toThrow();
    expect(appendUserStoppedMarker(boom, { taskId: "t1", sessionId: "s1" })).toBe(false);
  });

  it("hasUserStoppedSince:只看 at>=since(停完再提新任务不受历史标记影响)", () => {
    const j = new MemoryJournal();
    const old = Date.now() - 60_000;
    appendUserStoppedMarker(j, { taskId: "t-old", sessionId: "s1", at: old });
    expect(hasUserStoppedSince(j, { taskId: "t-old", sessionId: "s1", since: old })).toBeDefined();
    expect(hasUserStoppedSince(j, { taskId: "t-new", sessionId: "s1", since: old + 1 })).toBeUndefined();
    // 别的会话不受影响
    expect(hasUserStoppedSince(j, { taskId: "t-x", sessionId: "s2", since: 0 })).toBeUndefined();
  });
});

describe("冷恢复:用户停止过的任务收编 cancelled", () => {
  it("restore(userStopped=true) → state=cancelled,result 注明用户已停止", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2, maxConcurrentSystem: 2 });
    const collected = tm.restore([mkTask({ id: "stopped" }), mkTask({ id: "crashed" })], {
      receipt: (t) => `网关重启中断(原任务书 ${t.id})`,
      userStopped: (t) => t.id === "stopped",
    });
    const stopped = tm.get("stopped")!;
    const crashed = tm.get("crashed")!;
    expect(stopped.state).toBe("cancelled");
    expect(stopped.result).toContain("用户已停止");
    expect(crashed.state).toBe("interrupted");
    expect(crashed.result).toContain("网关重启中断");
    // 只有被收编(非原样)的进回写清单
    expect(collected.map((t) => t.id).sort()).toEqual(["crashed", "stopped"]);
  });

  it("autoResumeInterrupted(blocked) 不纳入被停止过的任务", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4, maxConcurrentPerOwner: 2, maxConcurrentSystem: 2 });
    tm.restore([mkTask({ id: "a", sessionId: "sa" }), mkTask({ id: "b", sessionId: "sb" })]);
    const resumed = tm.autoResumeInterrupted({
      windowMs: 60_000,
      buildInstruction: (t) => `续跑 ${t.id}`,
      blocked: (t) => t.sessionId === "sa",
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.sessionId).toBe("sb");
    expect(tm.get("a")!.state).toBe("interrupted"); // 未被续跑替代
  });
});

describe("接线断言(源码级,非端到端:整链需真 provider/executor)", () => {
  it("取消路径先落标记再 abort(进程内 agent-wiring + session-worker 形态 app.ts)", () => {
    const wiring = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf8");
    const wireIdx = wiring.indexOf('appendUserStoppedMarker(journal, { taskId: task.id, sessionId: task.sessionId, source: "cancel" });');
    const cancelIdx = wiring.indexOf('loop.cancel("task.cancel");');
    expect(wireIdx).toBeGreaterThan(0);
    expect(cancelIdx).toBeGreaterThan(wireIdx); // 顺序:标记在前
    // 只对有活跃 loop 的任务落标记(续跑替代 cancelled 不算用户停止)
    expect(wiring).toContain("const loop = activeLoops.get(task.id);");
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    // session-worker 形态:取消同样先落标记再通知 worker
    expect(app.indexOf('appendUserStoppedMarker(journal, { taskId: task.id, sessionId: task.sessionId, source: "cancel" });')).toBeLessThan(app.indexOf("workerHost.cancelTask(task.id);"));
    // 启动恢复:restore 收编与 autoResume 都带停止判据
    expect(app).toContain("userStopped: (t) => (userStoppedAt.get(t.sessionId) ?? -1) >= t.createdAt");
    expect(app).toContain("blocked: (t) => (userStoppedAt.get(t.sessionId) ?? -1) >= t.createdAt");
  });
});

/** WS 探针(同 builtin-commands.test.ts 口径)。 */
const ws = (port: number): Promise<import("ws").WebSocket> =>
  import("ws").then(({ WebSocket }) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((res, rej) => {
      w.once("open", () => res(w));
      w.once("error", rej);
    });
  });

function waitMsg(w: import("ws").WebSocket, type: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { w.off("message", onMsg); rej(new Error(`等待 ${type} 超时`)); }, timeoutMs);
    const onMsg = (raw: import("ws").RawData) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (m.type !== type) return;
      clearTimeout(timer);
      w.off("message", onMsg);
      res(m);
    };
    w.on("message", onMsg);
  });
}

describe("WS task.resume:命中停止标记 → task-stopped-by-user", () => {
  it("有标记拒;无标记仍可续跑(有辨别力)", async () => {
    const app = createGatewayApp({ port: 0, journalDir: undefined, llm: undefined, useExternalHttp: true });
    const { createServer } = await import("node:http");
    const server: Server = createServer();
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    app.attachWs(server);
    try {
      // ① 模拟重启收编:两个会话各一个 interrupted 任务
      app.taskManager.restore([mkTask({ id: "stopped-task", sessionId: "s-stop" }), mkTask({ id: "plain-task", sessionId: "s-plain" })]);
      // ② 只给 s-stop 落用户停止标记(任务创建之后)
      const created = app.taskManager.get("stopped-task")!.createdAt;
      appendUserStoppedMarker(app.journal, { taskId: "stopped-task", sessionId: "s-stop", at: created + 1 });

      const w = await ws(port);
      w.send(JSON.stringify({ v: 1, type: "task.resume", taskId: "stopped-task" }));
      const err = await waitMsg(w, "error");
      expect(err.code).toBe(USER_STOPPED_RESUME_CODE);
      expect(String(err.message)).toContain("用户已停止");
      expect(String(err.message)).toBe(USER_STOPPED_RESUME_MESSAGE);
      // 任务未被复活/替代
      expect(app.taskManager.get("stopped-task")!.state).toBe("interrupted");

      // 对照组:无标记的 interrupted 任务照常续跑
      w.send(JSON.stringify({ v: 1, type: "task.resume", taskId: "plain-task" }));
      const ok = await waitMsg(w, "task.resume.ok");
      expect(ok.taskId).toBe("plain-task");
      expect(app.taskManager.get("plain-task")!.state).toBe("cancelled"); // 被续跑替代
      w.close();
    } finally {
      await app.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
