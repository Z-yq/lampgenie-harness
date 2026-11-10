/**
 * fixF2/F3(2026-10-19 面板卡+重连风暴)单测:
 * ①wsSendPolicy——safeSend 背压丢行策略(纯函数):超 2MB 丢 stream llm-delta(打字机帧可丢,
 *   终稿由 journal 承接),状态/任务类必发+限速告警。
 * ②session.status.changed 广播 per-session 200ms 合并(前沿立即+尾沿补发,异会话不互并)。
 */
import { describe, it, expect } from "vitest";
import { startGatewayServer, wsSendPolicy } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ServerMessage } from "@lampgenie/protocol";
import WebSocket from "ws";

const MB = 1024 * 1024;

describe("wsSendPolicy(fixF3 背压丢行策略)", () => {
  const delta = { v: 1, type: "stream", sessionId: "s", ev: { type: "llm-delta", text: "x" } };
  const taskMsg = { v: 1, type: "task.changed", task: { id: "t" } };

  it("水位内(≤2MB):一律正常必发", () => {
    expect(wsSendPolicy(0, delta, 1_000, 0)).toBe("send");
    expect(wsSendPolicy(2 * MB, taskMsg, 1_000, 0)).toBe("send");
    expect(wsSendPolicy(2 * MB, delta, 1_000, 0)).toBe("send");
  });

  it("超水位:llm-delta 丢弃(可丢类)", () => {
    expect(wsSendPolicy(2 * MB + 1, delta, 1_000, 0)).toBe("drop");
    expect(wsSendPolicy(9 * MB, delta, 1_000, 99_999)).toBe("drop"); // 与告警时刻无关,恒丢
  });

  it("超水位:状态/任务类必发——首个告警,5s 内后续静默必发,再往后恢复告警", () => {
    expect(wsSendPolicy(3 * MB, taskMsg, 10_000, 0)).toBe("send-warn");
    expect(wsSendPolicy(3 * MB, taskMsg, 12_000, 10_000)).toBe("send"); // 2s<5s:必发不刷日志
    expect(wsSendPolicy(3 * MB, taskMsg, 16_000, 10_000)).toBe("send-warn"); // 6s≥5s:再告警
  });

  it("超水位:stream 非 delta 帧(llm-begin/end、tool-*)必发(控制帧保序,丢了流就断)", () => {
    for (const ev of [{ type: "llm-begin" }, { type: "llm-end", text: "t" }, { type: "tool-begin", callId: "c", name: "n" }]) {
      expect(wsSendPolicy(3 * MB, { v: 1, type: "stream", sessionId: "s", ev }, 10_000, 0)).toBe("send-warn");
    }
  });
});

describe("session.status.changed 广播合并(fixF2,per-session 200ms 窗)", () => {
  it("同会话风暴→前沿 1 帧+尾沿 1 帧;异会话首帧立即、不互并", async () => {
    const port = 7869;
    const tm = new TaskSupervisor();
    const srv = startGatewayServer({ port, taskManager: tm, journal: new MemoryJournal() });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const frames: { sessionId?: string }[] = [];
      ws.on("message", (r) => {
        const m = JSON.parse(r.toString()) as { type?: string; sessionId?: string };
        if (m.type === "session.status.changed") frames.push(m);
      });
      await new Promise((r) => ws.on("open", r));
      await new Promise((r) => setTimeout(r, 60)); // 让 hello/project.list 等连接期消息过掉
      const emit = (sid: string) => srv.broadcast({ v: 1, type: "session.status.changed", sessionId: sid } as ServerMessage);
      emit("s1"); // 前沿:立即 1 帧
      await new Promise((r) => setTimeout(r, 30));
      emit("s1");
      emit("s1"); // 窗内风暴:合并,不立即发
      emit("s2"); // 异会话:自己的前沿立即发
      await new Promise((r) => setTimeout(r, 330)); // 等 s1 尾沿(≤200ms)+余量
      expect(frames.filter((f) => f.sessionId === "s1").length).toBe(2); // 前沿+尾沿,3 连发合并成 2 帧
      expect(frames.filter((f) => f.sessionId === "s2").length).toBe(1); // 异会话不受 s1 窗影响
      ws.close();
    } finally {
      await srv.close();
    }
  });
});
