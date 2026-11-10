/**
 * M24 写前持久化屏障:Journal.flushStrict(fail-closed)。
 * 契约:
 * ①FileJournal 的 write-behind 队列在 flushStrict 时逐 target 同步落盘,失败**抛 JournalFlushError**
 *   且队列保留原批(下次 flushStrict 成功才清队,事件不丢、不重复);
 * ②flush() 的 best-effort 语义不变(失败只记日志,不抛);
 * ③MemoryJournal 的 flushStrict 是 no-op(接口在场、永远成功)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal, JournalFlushError, MemoryJournal } from "../src/journal/journal.js";

/** 造一个「target 目录建不出来」的环境:sessions 这个位置被一个普通文件占住。 */
function blockedShardedJournal() {
  const dir = mkdtempSync(join(tmpdir(), "wb-strict-"));
  writeFileSync(join(dir, "sessions"), "blocker", "utf-8");
  const fp = join(dir, "j.jsonl");
  const j = new FileJournal(fp, { writeBehind: true, sharded: true });
  return { dir, fp, j, sessionFile: join(dir, "sessions", "s1.jsonl") };
}

describe("Journal.flushStrict(写前屏障)", () => {
  it("队列落盘失败:抛 JournalFlushError(含 target/bytes),队列保留;修好后续成功清队且只落一份", () => {
    const { dir, j, sessionFile } = blockedShardedJournal();
    try {
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "a" } });
      let err: unknown;
      try {
        j.flushStrict();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(JournalFlushError);
      const msg = (err as Error).message;
      expect(msg).toContain("sessions");
      expect(msg).toContain("bytes=");
      // 队列保留原批:不等待异步冲刷,修好目标后 flushStrict 一次即写出全部事件
      rmSync(join(dir, "sessions"));
      mkdirSync(join(dir, "sessions"));
      expect(() => j.flushStrict()).not.toThrow();
      const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as { payload: { text: string } }).payload.text).toBe("a");
      // 再 flush 一次:队列已空,不重复写
      j.flushStrict();
      expect(readFileSync(sessionFile, "utf-8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flush() best-effort 不变:目标不可写时不抛(仅记日志)", () => {
    const { dir, j } = blockedShardedJournal();
    try {
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "a" } });
      expect(() => j.flush()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 write-behind:无队列 → flushStrict no-op(append 已同步落盘)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-strict-sync-"));
    try {
      const fp = join(dir, "j.jsonl");
      const j = new FileJournal(fp);
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "hi" } });
      expect(() => j.flushStrict()).not.toThrow();
      expect(readFileSync(fp, "utf-8")).toContain("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MemoryJournal:flushStrict 为 no-op(永远成功)", () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s1", payload: { text: "x" } });
    expect(() => j.flushStrict()).not.toThrow();
  });
});
