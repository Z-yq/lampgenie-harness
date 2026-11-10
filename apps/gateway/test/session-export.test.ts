/**
 * 会话导出(step-004 二期收口)+ 会议批量立任务(step-013 二期收口)单测。
 * 导出规格源=vendor dsh session-format v4(本地行帧实现,校验=exact-keys 复刻)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryJournal } from "@lampgenie/core";
import { journalToSessionV4, exportSessionToFile, verifySessionFile, journalEventToV4 } from "../src/session-export.js";
import { scheduleMeetingTodos } from "../src/meeting-tools.js";
import { TaskSupervisor } from "../src/task-manager.js";

describe("session-export(journal→dsh v4)", () => {
  it("对话事件映射:user/assistant/tool 三类;过程事件不进", () => {
    const u = journalEventToV4({ kind: "message.user", sessionId: "s", payload: { text: "你好" } }, 0)!;
    expect(u.type).toBe("user/message");
    expect((u.data as { content: string }).content).toBe("你好");
    expect((u.data as { source: { kind: string } }).source.kind).toBe("lampgenie-harness");
    const a = journalEventToV4({ kind: "message.agent", sessionId: "s", payload: { text: "答" } }, 1)!;
    expect(a.type).toBe("assistant/message");
    const msg = (a.data as { message: { role: string; content: { type: string; text: string }[] } }).message;
    expect(msg.role).toBe("assistant");
    expect(msg.content[0]!.text).toBe("答");
    const t = journalEventToV4({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c1", content: "ok" } }, 2)!;
    expect(t.type).toBe("tool/result");
    const tm = (t.data as { message: { id: string; source: { kind: string; callId: string } } }).message;
    expect(tm.source.callId).toBe("c1");
    expect(journalEventToV4({ kind: "step.end", sessionId: "s", payload: {} }, 3)).toBeUndefined();
  });

  it("artifact 过 exact-keys 校验;跨会话事件不混入", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "q" } });
    j.append({ kind: "message.user", sessionId: "other", payload: { text: "噪声" } });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "a" } });
    const { header, rows } = journalToSessionV4(j.readAll() as never[], "s1", "/repo");
    expect(header).toMatchObject({ type: "session", version: 4, id: "s1", isSeeded: false, delegationDepth: 0, cwd: "/repo" });
    expect(rows).toHaveLength(2);
  });

  it("落盘+读回对账闭环", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "sx", payload: { text: "问" } });
    j.append({ kind: "message.agent", sessionId: "sx", payload: { text: "复" } });
    j.append({ kind: "tool.result", sessionId: "sx", payload: { toolCallId: "t1", content: "果" } });
    const dir = join(tmpdir(), `genie-export-test-${Date.now()}`);
    try {
      const file = exportSessionToFile(j, "sx", dir, "/repo");
      expect(file.endsWith("session.v4.jsonl")).toBe(true);
      const { events } = verifySessionFile(file);
      expect(events).toBe(3);
      const lines = readFileSync(file, "utf-8").trim().split("\n");
      expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", version: 4 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("header 缺必填键即抛(不静默导出坏帧)", () => {
    expect(() => journalToSessionV4([], "")).toThrow(/id/);
  });
});

describe("meeting.schedule 批量立任务", () => {
  it("todos→任务(标题带 [会议] 前缀;≤20 截断)", () => {
    const tm = new TaskSupervisor({});
    const created = scheduleMeetingTodos(tm, [
      { content: "整理会议纪要", owner: "张三", deadline: "周五" },
      { content: "发周报" },
    ], "sess-1");
    expect(created).toHaveLength(2);
    const all = tm.list();
    expect(all[0]!.title).toBe("[会议] 整理会议纪要");
    expect(all[0]!.sessionId).toBe("sess-1");
    expect(all[0]!.instruction).toContain("负责人:张三");
    expect(all[0]!.instruction).toContain("截止:周五");
    // 21 条截到 20
    const many = scheduleMeetingTodos(tm, Array.from({ length: 25 }, (_, i) => ({ content: `任务${i}` })), "sess-2");
    expect(many).toHaveLength(20);
  });
});
