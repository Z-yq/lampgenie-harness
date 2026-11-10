/**
 * FileJournal write-behind(2026-10-21 卡顿修复):网关开异步批量落盘。
 * ①默认模式(不开 writeBehind)语义零变化:append 后文件立即可读;
 * ②write-behind 模式:内存为权威源(readAll/readSession 立即可见),文件在微任务冲刷后完整落盘,
 *   顺序与内容逐字节一致;appendMany 合批;进程退出清队不在此测(exit 钩子)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "../src/journal/journal.js";

const tick = () => new Promise((r) => setTimeout(r, 25));

describe("FileJournal write-behind", () => {
  it("默认模式:同步落盘语义不变(append 后文件立即可读)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-sync-"));
    try {
      const fp = join(dir, "j.jsonl");
      const j = new FileJournal(fp);
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "hi" } });
      const raw = readFileSync(fp, "utf-8");
      expect(raw).toContain('"message.user"');
      expect(raw).toContain("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write-behind:内存即读,文件冲刷后逐字节一致且保序;appendMany 合批", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-async-"));
    try {
      const fp = join(dir, "j.jsonl");
      const j = new FileJournal(fp, { writeBehind: true });
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "a" } });
      j.appendMany([
        { kind: "message.agent", sessionId: "s1", payload: { text: "b" } },
        { kind: "message.agent", sessionId: "s1", payload: { text: "c" } },
      ]);
      // 权威源=内存:不等待冲刷即可读
      expect(j.readAll()).toHaveLength(3);
      expect(j.readSession("s1")).toHaveLength(3);
      // 冲刷(微任务→宏任务)
      await tick(); await tick();
      const lines = readFileSync(fp, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(3);
      const parsed = lines.map((l) => JSON.parse(l) as { seq: number; kind: string; payload: { text: string } });
      expect(parsed.map((e) => e.payload.text)).toEqual(["a", "b", "c"]);
      expect(parsed.map((e) => e.seq)).toEqual([0, 1, 2]); // 保序
      // 再写一批:队列复用
      j.append({ kind: "message.user", sessionId: "s1", payload: { text: "d" } });
      await tick(); await tick();
      expect(readFileSync(fp, "utf-8").trim().split("\n")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
