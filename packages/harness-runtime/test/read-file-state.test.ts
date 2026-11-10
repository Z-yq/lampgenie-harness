/**
 * 已读文件状态 Map 单测(designs/25「同文件读第二遍」机制层):
 * ①登记归一化(path 归一 / mtime 取整 / 同 path 覆盖 / session 隔离);
 * ②提醒块生成(空=null、path+相对时间在块内、指引句在块内、超 15 条只列最近 15 并标总数);
 * ③主链路:MVP=read_file 记录 → AgentLoop 组装消息断言清单入块(与 todo 提醒同注入点共存)。
 */
import { describe, it, expect, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type Message, type Tool } from "../src/agent/loop";
import {
  MAX_REMINDER_FILES, MAX_TRACKED_SESSIONS, RANGE_END_INF, buildReadFilesReminder, checkImageInjected, checkRepeatRead, clearReadFiles, normalizeReadMtime, normalizeReadPath, rangeCovered, readFilesOf, recordFileRead, recordImageInjected,
} from "../src/agent/read-file-state";

const used: string[] = [];
const sid = (tag: string) => { const s = `readstate-test-${tag}-${Math.random().toString(36).slice(2)}`; used.push(s); return s; };
afterEach(() => { for (const s of used.splice(0)) clearReadFiles(s); });

describe("已读文件登记(归一化 + session 隔离)", () => {
  it("path 归一(反斜杠→/、trim):同一文件的两种写法命中同一条目", () => {
    const s = sid("norm");
    recordFileRead(s, "src\\a.ts ", 1000);
    recordFileRead(s, "src/a.ts", 2000, 5);
    const all = readFilesOf(s);
    expect(all).toHaveLength(1);            // 同一文件只留一条
    expect(all[0]!.path).toBe("src/a.ts");
    expect(all[0]!.mtimeMs).toBe(2000);     // 覆盖为最新
    expect(all[0]!.readAt).toBe(5);
  });

  it("mtime 归一(取整去亚毫秒)+ 去伪值", () => {
    expect(normalizeReadMtime(1712345678901.87)).toBe(1712345678901);
    expect(normalizeReadMtime(undefined)).toBe(0);
    expect(normalizeReadMtime(Number.NaN)).toBe(0);
    expect(normalizeReadPath("  a/b.txt\\c.txt ")).toBe("a/b.txt/c.txt");
  });

  it("session 隔离:别的会话读过的文件不出现在本会话清单", () => {
    const a = sid("iso-a"); const b = sid("iso-b");
    recordFileRead(a, "x.ts", 1, 1);
    expect(readFilesOf(b)).toHaveLength(0);
    expect(buildReadFilesReminder(b)).toBeNull();
    expect(buildReadFilesReminder(a)).toContain("x.ts");
    clearReadFiles(a);
    expect(readFilesOf(a)).toHaveLength(0); // 回收后为空
  });

  it("注册表有界(LRU 上限):超 MAX_TRACKED_SESSIONS 后最久未登记的会话被淘汰", () => {
    const first = sid("lru-first");
    recordFileRead(first, "keep.ts", 1, 1);
    for (let i = 0; i < MAX_TRACKED_SESSIONS; i++) recordFileRead(sid(`lru-${i}`), `f${i}.ts`, 1, 2 + i);
    expect(readFilesOf(first)).toHaveLength(0);      // 最久未登记者被淘汰(内存有界)
    expect(buildReadFilesReminder(first)).toBeNull();
    const fresh = sid("lru-fresh");
    recordFileRead(fresh, "now.ts", 1, 99_999);
    expect(readFilesOf(fresh)).toHaveLength(1);      // 新会话照常可用
  });
});

describe("buildReadFilesReminder(注入块语义)", () => {
  it("无已读记录 → null(不产生空提醒)", () => {
    expect(buildReadFilesReminder(sid("empty"))).toBeNull();
  });

  it("有记录 → 块内含 system-reminder 标签、清单行(path+相对时间)与重读指引句", () => {
    const s = sid("block");
    const now = 1_700_000_000_000;
    recordFileRead(s, "apps/gateway/src/file-tools.ts", 1, now - 30_000);       // 刚刚
    recordFileRead(s, "packages/core/src/journal.ts", 1, now - 5 * 60_000);     // 5 分钟前
    recordFileRead(s, "packages/harness-runtime/src/agent/loop.ts", 1, now - 3 * 3600_000); // 3 小时前
    const r = buildReadFilesReminder(s, now)!;
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("</system-reminder>");
    expect(r).toContain("apps/gateway/src/file-tools.ts(刚刚)");
    expect(r).toContain("packages/core/src/journal.ts(5 分钟前)");
    expect(r).toContain("packages/harness-runtime/src/agent/loop.ts(3 小时前)");
    expect(r).toContain("重读前先看清单:文件未变就不要整读,要细节用 offset/limit 局部读");
    expect(r.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });

  it("按读取时间新→旧排序", () => {
    const s = sid("order");
    const now = 1_700_000_000_000;
    recordFileRead(s, "older.ts", 1, now - 60_000);
    recordFileRead(s, "newer.ts", 1, now - 1000);
    const lines = buildReadFilesReminder(s, now)!.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("newer.ts");
    expect(lines[1]).toContain("older.ts");
  });

  it("清单超 15 个 → 只列最近 15 个并标注总数(防提醒块膨胀)", () => {
    const s = sid("cap");
    const now = 1_700_000_000_000;
    for (let i = 0; i < 20; i++) recordFileRead(s, `f${String(i).padStart(2, "0")}.ts`, 1, now - (20 - i) * 1000);
    const r = buildReadFilesReminder(s, now)!;
    const lines = r.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(MAX_REMINDER_FILES);
    expect(lines).toHaveLength(15);
    expect(lines[0]).toContain("f19.ts");   // 最近读的排最前
    expect(r).not.toContain("f00.ts");      // 最早的 5 个被裁
    expect(r).toContain("(共 20 个,只列最近 15 个)");
  });
});

describe("主链路:AgentLoop 每步组装消息注入已读清单(与 todo 提醒同注入点)", () => {
  it("read_file 登记后,第二步组装的消息里出现已读清单块(且不落 journal)", async () => {
    const s = sid("loop");
    const journal = new MemoryJournal();
    const seen: Message[][] = [];
    const readTool: Tool = {
      name: "read_file",
      description: "stub",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute(args: unknown) {
        const a = args as { path: string };
        recordFileRead(s, a.path, 42); // 真实 read_file 的登记动作(此处桩替)
        return "     1\tcontent-of-a";
      },
    };
    let i = 0;
    const llm = {
      async chat(messages: Message[]) {
        seen.push(messages.map((m) => ({ ...m })));
        i++;
        if (i === 1) return { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }] };
        return { content: "done" };
      },
    };
    await new AgentLoop({ journal, sessionId: s, system: "s", llm, tools: [readTool], todoReminderSteps: 1 }).runTurn("做");
    // 第 1 次组装:尚无已读记录 → 不注入清单块
    expect(seen[0]!.some((m) => m.content.includes("本会话已读文件清单"))).toBe(false);
    // 第 2 次组装:已读 a.txt → 注入
    const second = seen[1]!.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    expect(second).toContain("<system-reminder>");
    expect(second).toContain("- a.txt(刚刚)");
    expect(second).toContain("重读前先看清单");
    // ephemeral:不落 journal(纯提示层事实,不是会话真相)
    expect(journal.readAll().some((e) => JSON.stringify(e.payload ?? {}).includes("本会话已读文件清单"))).toBe(false);
  });
});

describe("重复读取判定(纯函数,2026-11-07)", () => {
  it("首读无登记 → 不重复;登记后同 mtime 同段 → 重复且次数递增", () => {
    const s = sid("dup-basic");
    expect(checkRepeatRead(s, "a.ts", 1000, 1, 50)).toEqual({ duplicate: false, readCount: 0 });
    recordFileRead(s, "a.ts", 1000, 1, [{ off: 1, end: 50 }]);
    expect(checkRepeatRead(s, "a.ts", 1000, 1, 50)).toEqual({ duplicate: true, readCount: 1 });
    recordFileRead(s, "a.ts", 1000, 2, [{ off: 60, end: 80 }]);
    expect(checkRepeatRead(s, "a.ts", 1000, 60, 80)).toEqual({ duplicate: true, readCount: 2 });
    // 未覆盖段 → 不重复
    expect(checkRepeatRead(s, "a.ts", 1000, 100, 120).duplicate).toBe(false);
  });

  it("部分覆盖:请求段只要有一部分未被登记 → 不判重复(不吞正文)", () => {
    const s = sid("dup-partial");
    recordFileRead(s, "b.ts", 2000, 1, [{ off: 10, end: 20 }]);
    expect(checkRepeatRead(s, "b.ts", 2000, 15, 25).duplicate).toBe(false); // 21-25 未读
    expect(checkRepeatRead(s, "b.ts", 2000, 10, 20).duplicate).toBe(true);
    expect(checkRepeatRead(s, "b.ts", 2000, 12, 18).duplicate).toBe(true);   // 子窗口被覆盖
  });

  it("mtime 变化 → 不判重复(文件改过必须放行)", () => {
    const s = sid("dup-mtime");
    recordFileRead(s, "c.ts", 1000, 1, [{ off: 1, end: 100 }]);
    expect(checkRepeatRead(s, "c.ts", 1001, 1, 100).duplicate).toBe(false);
    // mtime 取整后相等仍判重复(亚毫秒抖动不算变化)
    expect(checkRepeatRead(s, "c.ts", 1000.87, 1, 100).duplicate).toBe(true);
  });

  it("旧数据无 ranges → 视为全文已覆盖;RANGE_END_INF 尾段只覆盖到 尾", () => {
    const s = sid("dup-legacy");
    recordFileRead(s, "d.ts", 3000); // 无行段=旧数据
    expect(checkRepeatRead(s, "d.ts", 3000, 1, 999999).duplicate).toBe(true);
    const s2 = sid("dup-inf");
    recordFileRead(s2, "e.ts", 3000, 1, [{ off: 500, end: RANGE_END_INF }]);
    expect(checkRepeatRead(s2, "e.ts", 3000, 600, RANGE_END_INF).duplicate).toBe(true);
    expect(checkRepeatRead(s2, "e.ts", 3000, 100, 200).duplicate).toBe(false); // 500 之前未读
    // rangeCovered 直测:有限段覆盖不了 INF 请求
    expect(rangeCovered([{ off: 1, end: 10 }], 1, RANGE_END_INF)).toBe(false);
    expect(rangeCovered([{ off: 1, end: RANGE_END_INF }], 1, 10)).toBe(true);
    expect(rangeCovered(undefined, 1, 1)).toBe(true); // 无 ranges=全文
  });

  it("图片台账:同 path 同 mtime 判已注入;mtime 变/clearReadFiles → 重新可注入", () => {
    const s = sid("dup-img");
    expect(checkImageInjected(s, "p.png", 1000).seen).toBe(false);
    recordImageInjected(s, "p.png", 1000);
    expect(checkImageInjected(s, "p.png", 1000).seen).toBe(true);
    expect(checkImageInjected(s, "p.png", 1001).seen).toBe(false);
    clearReadFiles(s);
    expect(checkImageInjected(s, "p.png", 1000).seen).toBe(false);
  });

  it("exactWindow=true(工具面口径):子窗口/超集不判重复,同窗口才省略", () => {
    const s = sid("dup-exact");
    recordFileRead(s, "f.ts", 5000, 1, [{ off: 10, end: 20 }]);
    expect(checkRepeatRead(s, "f.ts", 5000, 10, 20, true).duplicate).toBe(true);   // 同窗口
    expect(checkRepeatRead(s, "f.ts", 5000, 12, 18, true).duplicate).toBe(false);  // 子窗口照常注正文
    expect(checkRepeatRead(s, "f.ts", 5000, 1, 30, true).duplicate).toBe(false);   // 超集含未读段
    // 整读后请求子窗口:覆盖模式判重复,exact 模式放行(既有 file-tools 行为零漂移)
    const s2 = sid("dup-exact-full");
    recordFileRead(s2, "g.ts", 6000, 1, [{ off: 1, end: 30 }]);
    expect(checkRepeatRead(s2, "g.ts", 6000, 5, 7).duplicate).toBe(true);
    expect(checkRepeatRead(s2, "g.ts", 6000, 5, 7, true).duplicate).toBe(false);
    expect(checkRepeatRead(s2, "g.ts", 6000, 1, 30, true).duplicate).toBe(true);
  });
});