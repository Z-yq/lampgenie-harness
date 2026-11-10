/**
 * session_search 工具:三形态/只读声明/当前会话排除/自动化降权。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { sessionSearchTool } from "../src/session-search.js";

const NOW = Date.parse("2026-10-16T00:00:00Z");

function seed(): MemoryJournal {
  const j = new MemoryJournal();
  j.append({ kind: "message.user", sessionId: "current", payload: { text: "当前会话白板讨论" }, time: NOW });
  j.append({ kind: "message.user", sessionId: "past-a", payload: { text: "上次白板节点拖拽的修复记录 permission" }, time: NOW - 86_400_000 });
  j.append({ kind: "message.agent", sessionId: "past-a", payload: { text: "改 board-page-layout.js 的白板布局" }, time: NOW - 86_400_000 + 1000 });
  j.append({ kind: "message.user", sessionId: "auto-xx", payload: { text: "白板 permission 自动巡检" }, time: NOW - 86_400_000 });
  return j;
}

describe("session_search tool()", () => {
  it("ProxyJournal(worker 进程)侧走 IPC 代理到 gateway 真索引,历史会话可见", async () => {
    const { ProxyJournal, setIpcTransport, handleHostResponse } = await import("../src/session-worker-lib.js");
    setIpcTransport((msg) => {
      const m = msg as { t: string; id: number; kind: string; payload: { op: string; args: unknown; currentSessionId?: string } };
      if (m.t === "req" && m.kind === "session.search") {
        expect(m.payload.op).toBe("discover");
        expect(m.payload.currentSessionId).toBe("current");
        handleHostResponse({ id: m.id, ok: true, value: JSON.stringify({ results: [{ sessionId: "past-a", title: "历史会话" }] }) });
      }
    });
    try {
      const tool = sessionSearchTool(new ProxyJournal("current"), "current");
      const raw = (await tool.execute({ action: "discover", query: "白板" })) as string;
      const r = JSON.parse(raw) as { results: Array<{ sessionId: string }> };
      expect(r.results.some((x) => x.sessionId === "past-a")).toBe(true);
    } finally {
      setIpcTransport(null);
    }
  });

  it("声明只读/并发安全;discover 排除当前会话,includeCurrent 可包含", async () => {
    const journal = seed();
    const tool = sessionSearchTool(journal, "current");
    expect(tool.name).toBe("session_search");
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
    const raw = (await tool.execute({ action: "discover", query: "白板", limit: 10 })) as string;
    const r = JSON.parse(raw) as { results: Array<{ sessionId: string; source: string; demoted: boolean }> };
    expect(r.results.some((x) => x.sessionId === "current")).toBe(false);
    expect(r.results.some((x) => x.sessionId === "past-a")).toBe(true);
    const incl = JSON.parse((await tool.execute({ action: "discover", query: "白板", limit: 10, includeCurrent: true })) as string) as {
      results: Array<{ sessionId: string }>;
    };
    expect(incl.results.some((x) => x.sessionId === "current")).toBe(true);
    const auto = r.results.find((x) => x.sessionId === "auto-xx");
    expect(auto?.source).toBe("automation");
    expect(auto?.demoted).toBe(true);
  });

  it("discover -> scroll -> read 闭环", async () => {
    const journal = seed();
    const tool = sessionSearchTool(journal, "current");
    const d = JSON.parse((await tool.execute({ action: "discover", query: "permission", limit: 3 })) as string) as {
      results: Array<{ sessionId: string; best: { seq: number; snippet: string } }>;
    };
    expect(d.results.length).toBeGreaterThan(0);
    const top = d.results[0]!;
    expect(top.best.snippet).toContain("«permission»");
    const s = JSON.parse((await tool.execute({ action: "scroll", sessionId: top.sessionId, seq: top.best.seq, window: 1 })) as string) as {
      events: Array<{ seq: number; anchor?: boolean; text: string }>;
    };
    expect(s.events.some((e) => e.anchor && e.seq === top.best.seq)).toBe(true);
    const rd = JSON.parse((await tool.execute({ action: "read", sessionId: top.sessionId, fromSeq: 0, limit: 2 })) as string) as {
      events: unknown[];
      total: number;
      done: boolean;
    };
    expect(rd.events.length).toBeGreaterThan(0);
    expect(rd.total).toBeGreaterThanOrEqual(rd.events.length);
    expect(typeof rd.done).toBe("boolean");
  });

  it("缺 sessionId 的 scroll/read 返回可读错误而非异常", async () => {
    const tool = sessionSearchTool(seed());
    expect(((await tool.execute({ action: "scroll" })) as string)).toContain("需要 sessionId");
    expect(((await tool.execute({ action: "read" })) as string)).toContain("需要 sessionId");
  });

  it("空 query = browse 最近会话", async () => {
    const tool = sessionSearchTool(seed());
    const r = JSON.parse((await tool.execute({ action: "discover", query: "" })) as string) as {
      mode: string;
      results: unknown[];
    };
    expect(r.mode).toBe("browse");
    expect(r.results.length).toBeGreaterThan(0);
  });
});
