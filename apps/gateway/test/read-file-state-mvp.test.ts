/**
 * 已读文件状态 MVP 测试(gateway 侧,真实 createFileTools + AgentLoop):
 * 读文件 A → 下一 step 组装消息的已读清单块含 A(端到端最小可用行为),且
 * ①真实 read_file 的登记动作生效(相对路径 + mtime 登记);
 * ②未读文件不出现;③提醒块不落 journal(ephemeral);④没读过文件时零注入(不污染首步)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type Message } from "@lampgenie/runtime/agent/loop";
import { buildReadFilesReminder, clearReadFiles, readFilesOf } from "@lampgenie/runtime/agent/read-file-state";
import { createFileTools } from "../src/file-tools.js";

const dirs: string[] = [];
const mk = () => { const d = mkdtempSync(join(tmpdir(), "readstate-")); dirs.push(d); return d; };
const sessions: string[] = [];
const sid = () => { const s = `gw-readstate-${Math.random().toString(36).slice(2)}`; sessions.push(s); return s; };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of sessions.splice(0)) clearReadFiles(s);
});

describe("MVP:读文件 A → 组装消息的已读清单含 A", () => {
  it("read_file 成功 → 注册表登记相对路径+mtime;下一 step 注入块含 A、不含未读的 B", async () => {
    const root = mk();
    writeFileSync(join(root, "a.txt"), "content-of-a", "utf-8");
    writeFileSync(join(root, "b.txt"), "content-of-b", "utf-8");
    const sessionId = sid();
    const journal = new MemoryJournal();
    const tools = createFileTools({ root, journal, sessionId });
    const seen: Message[][] = [];
    let i = 0;
    const llm = {
      async chat(messages: Message[]) {
        seen.push(messages.map((m) => ({ ...m })));
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }] };
        return { content: "done" };
      },
    };
    await new AgentLoop({ journal, sessionId, system: "s", llm, tools }).runTurn("看 a.txt");

    // ① 登记事实:路径为相对路径,相对时间=刚刚
    const entries = readFilesOf(sessionId);
    expect(entries.map((e) => e.path)).toEqual(["a.txt"]);
    expect(entries[0]!.mtimeMs).toBe(Math.floor(statSync(join(root, "a.txt")).mtimeMs)); // 归一化 mtime 与真实文件一致

    // ② 首步(未读任何文件)不注入;次步(读过 A)注入且含 A
    expect(seen[0]!.some((m) => String(m.content).includes("本会话已读文件清单"))).toBe(false);
    const second = seen[1]!.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
    expect(second).toContain("本会话已读文件清单");
    expect(second).toContain("- a.txt(刚刚)");
    expect(second).toContain("重读前先看清单:文件未变就不要整读,要细节用 offset/limit 局部读");
    expect(second).not.toContain("b.txt"); // 没读过的文件不进清单

    // ③ ephemeral:提醒块不落 journal(tool.call/tool.result 照常配对)
    const kinds = journal.readAll().map((e) => e.kind);
    expect(kinds).toContain("tool.result");
    expect(journal.readAll().some((e) => JSON.stringify(e.payload ?? {}).includes("本会话已读文件清单"))).toBe(false);
  });

  it("第二次读同一文件只留一条最新记录(清单不重复膨胀)", async () => {
    const root = mk();
    writeFileSync(join(root, "dup.txt"), "v1", "utf-8");
    const sessionId = sid();
    const journal = new MemoryJournal();
    const tools = createFileTools({ root, journal, sessionId });
    let i = 0;
    const llm = {
      async chat() {
        i++;
        if (i <= 2) return { content: "", toolCalls: [{ id: "c" + i, name: "read_file", arguments: JSON.stringify({ path: "dup.txt" }) }] };
        return { content: "done" };
      },
    };
    await new AgentLoop({ journal, sessionId, system: "s", llm, tools }).runTurn("读两次");
    const r = buildReadFilesReminder(sessionId)!;
    expect(r.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });
});