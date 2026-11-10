/**
 * W3 搬运件行为测试:不 mock 被测对象,直接驱搬运版 TaskSupervisor/SessionLog。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSupervisor } from "../src/task/task-manager";
import { SessionLog } from "../src/session/journal/session-journal";

describe("搬运版 TaskSupervisor(qwen task-manager)", () => {
  it("submissionKey 幂等:同 key 不重复建任务", () => {
    const tm = new TaskSupervisor();
    const a = tm.create({ objective: "做A", ownerId: "u1", sessionId: "s1", submissionKey: "k1" });
    const b = tm.create({ objective: "做A", ownerId: "u1", sessionId: "s1", submissionKey: "k1" });
    expect(a.id).toBe(b.id);
  });
  it("laneLimit 串行:同 laneKey 第二个不并发启动", async () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10 });
    let ran = 0;
    const blocker = new Promise(() => {}); // 永不 resolve,占位模拟长任务
    const runner = () => { ran++; return blocker; };
    const t1 = tm.create({ objective: "A", ownerId: "u1", sessionId: "s1", laneKey: "proj-x", runner });
    const t2 = tm.create({ objective: "B", ownerId: "u1", sessionId: "s1", laneKey: "proj-x", runner });
    await new Promise((r) => setImmediate(r)); // runner 在 microtask 里启动
    expect(ran).toBe(1); // lane 串行:只跑了 t1
    expect(t1.id).not.toBe(t2.id);
  });
});

describe("搬运版 SessionLog(qwen session-journal)", () => {
  it("JSONL 落盘且可回读", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-sj-"));
    const fp = join(dir, "s1.jsonl");
    const j = new SessionLog({ filePath: fp, sessionId: "s1" });
    await j.append({ type: "user/message", text: "hello" }); // append 是写队列,返回 promise
    await j.flush();
    expect(existsSync(fp)).toBe(true);
    const content = readFileSync(fp, "utf-8");
    expect(content).toContain("hello");
    rmSync(dir, { recursive: true, force: true });
  });
});
