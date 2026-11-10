/**
 * fixF1(面板卡+重连风暴):journal per-session 事件索引正确性。
 * 高频读路径(session.status)从 readAll 全量扫改为 readSession 索引切片——
 * 这里锁死索引与全量口径的一致性:多会话混合 append/appendMany、sinceSeq 增量、
 * 文件版重放挂链、seq 断档降级(正确优先于二分)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal, FileJournal } from "../src/journal/journal.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("journal.readSession(per-session 索引,fixF1)", () => {
  it("多会话混合 append:切片只含本会话、顺序与 seq 与全量口径一致", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "a" } });
    j.append({ kind: "message.user", sessionId: "s2", payload: { text: "b" } });
    j.append({ kind: "todo.updated", sessionId: "s1", payload: { items: [] } });
    j.append({ kind: "subagent.spawn", sessionId: "s3", payload: {} });
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "c" } });
    const s1 = j.readSession("s1");
    expect(s1.map((e) => e.kind)).toEqual(["message.user", "todo.updated", "message.agent"]);
    expect(s1.map((e) => e.seq)).toEqual([0, 2, 4]);
    expect(j.readSession("s2").map((e) => e.seq)).toEqual([1]);
    expect(j.readSession("s3").map((e) => e.seq)).toEqual([3]);
    // 与全量口径逐条一致(引用同一对象)。
    expect(s1).toEqual(j.readAll().filter((e) => e.sessionId === "s1"));
    expect(s1[0]).toBe(j.readAll()[0]);
    // 未知会话=[](不是 undefined)。
    expect(j.readSession("nope")).toEqual([]);
  });

  it("sinceSeq 增量:边界含头(seq=sinceSeq 本身)、切片不污染索引", () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 10; i++) j.append({ kind: "message.user", sessionId: "s", payload: { i } });
    expect(j.readSession("s", 5).map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(j.readSession("s", 0)).toHaveLength(10);
    expect(j.readSession("s", 10)).toEqual([]);
    // 返回拷贝:调用方改动不影响后续读。
    const slice = j.readSession("s", 8);
    slice.length = 0;
    expect(j.readSession("s", 8)).toHaveLength(2);
  });

  it("appendMany 同样挂链(批量路径不漏索引)", () => {
    const j = new MemoryJournal();
    j.appendMany([
      { kind: "message.user", sessionId: "s1", payload: {} },
      { kind: "message.user", sessionId: "s2", payload: {} },
      { kind: "message.user", sessionId: "s1", payload: {} },
    ]);
    expect(j.readSession("s1")).toHaveLength(2);
    expect(j.readSession("s2")).toHaveLength(1);
    // 幂等命中不重复入索引。
    j.append({ kind: "task.enqueue", sessionId: "s1", payload: {}, idempotencyKey: "k" });
    j.append({ kind: "task.enqueue", sessionId: "s1", payload: {}, idempotencyKey: "k" });
    expect(j.readSession("s1")).toHaveLength(3);
  });

  it("文件版:重放后索引可用,增量与内存版同口径", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-idx-"));
    const fp = join(dir, "gw.jsonl");
    const j1 = new FileJournal(fp);
    for (let i = 0; i < 6; i++) j1.append({ kind: "message.user", sessionId: `s${i % 2}`, payload: { i } });
    const j2 = new FileJournal(fp);
    expect(j2.readSession("s0").map((e) => e.seq)).toEqual([0, 2, 4]);
    expect(j2.readSession("s1", 3).map((e) => e.seq)).toEqual([3, 5]);
    // 重放后再追加:索引延续。
    j2.append({ kind: "message.agent", sessionId: "s0", payload: {} });
    expect(j2.readSession("s0").map((e) => e.seq)).toEqual([0, 2, 4, 6]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("seq 断档(外部改动过的 journal):二分降级为线性过滤,结果仍正确", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-gap-"));
    const fp = join(dir, "gap.jsonl");
    // 手工构造断档行(seq 跳号):加载告警但继续,索引退化为过滤——结果必须与全量口径一致。
    writeFileSync(fp, [
      JSON.stringify({ seq: 0, kind: "message.user", time: 1, sessionId: "s1", payload: { i: 0 } }),
      JSON.stringify({ seq: 5, kind: "message.user", time: 2, sessionId: "s1", payload: { i: 1 } }),
      JSON.stringify({ seq: 3, kind: "message.user", time: 3, sessionId: "s1", payload: { i: 2 } }),
      JSON.stringify({ seq: 6, kind: "message.user", time: 4, sessionId: "s2", payload: { i: 3 } }),
    ].join("\n") + "\n", "utf-8");
    const j = new FileJournal(fp);
    for (const since of [0, 1, 4, 6]) {
      expect(j.readSession("s1", since)).toEqual(j.readAll().filter((e) => e.sessionId === "s1" && e.seq >= since));
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
