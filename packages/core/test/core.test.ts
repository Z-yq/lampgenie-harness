import { describe, it, expect } from "vitest";
import { MemoryJournal, FileJournal } from "../src/journal/journal.js";
import type { JournalEvent } from "../src/journal/types.js";
import { canTransition, transition, type Task } from "../src/task/task.js";
import { evaluatePermission, wildcardMatch } from "../src/permission/permission.js";
import { mkdtempSync, rmSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("journal", () => {
  it("内存版:追加并分配自增 seq", () => {
    const j = new MemoryJournal();
    const a = j.append({ kind: "session.start", sessionId: "s1", payload: {} });
    const b = j.append({ kind: "message.user", sessionId: "s1", payload: { text: "hi" } });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(j.length).toBe(2);
  });

  it("幂等键防重:同 key 不重复写", () => {
    const j = new MemoryJournal();
    const a = j.append({ kind: "task.enqueue", sessionId: "s1", payload: {}, idempotencyKey: "k1" });
    const b = j.append({ kind: "task.enqueue", sessionId: "s1", payload: {}, idempotencyKey: "k1" });
    expect(j.length).toBe(1);
    expect(b.seq).toBe(a.seq);
  });

  it("文件版:写入后可从磁盘重放", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-"));
    const fp = join(dir, "s1.jsonl");
    const j1 = new FileJournal(fp);
    j1.append({ kind: "session.start", sessionId: "s1", payload: {} });
    j1.append({ kind: "message.user", sessionId: "s1", payload: { text: "hello" } });

    const j2 = new FileJournal(fp);
    const events = j2.readAll();
    expect(events).toHaveLength(2);
    expect(events[1]!.payload).toEqual({ text: "hello" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("journal.appendMany(批量落盘)", () => {
  /** 计数子类:统计 persist/persistMany 调用次数(=写盘次数),直接论证「N 条一次写」。 */
  class CountingJournal extends FileJournal {
    persistCalls = 0;
    persistManyCalls = 0;
    protected override persist(event: JournalEvent): void {
      this.persistCalls++;
      super.persist(event);
    }
    protected override persistMany(events: JournalEvent[]): void {
      this.persistManyCalls++;
      super.persistMany(events);
    }
  }

  it("空数组:零写盘(不建文件、不 persist/persistMany、length 不变)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-batch-empty-"));
    const fp = join(dir, "empty.jsonl");
    const j = new CountingJournal(fp);
    const out = j.appendMany([]);
    expect(out).toEqual([]);
    expect(j.length).toBe(0);
    expect(j.persistCalls).toBe(0);
    expect(j.persistManyCalls).toBe(0);
    expect(existsSync(fp)).toBe(false); // 空批不触达 fs
    rmSync(dir, { recursive: true, force: true });
  });

  it("N 条:一次 persistMany 落盘;readAll 顺序与 seq 连续;磁盘内容为 N 行拼接", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-batch-n-"));
    const fp = join(dir, "n.jsonl");
    const j = new CountingJournal(fp);
    const out = j.appendMany([
      { kind: "task.project.clear", sessionId: "s1", payload: { id: "t1", sessionId: "s1" } },
      { kind: "task.project.clear", sessionId: "s1", payload: { id: "t2", sessionId: "s1" } },
      { kind: "task.project.clear", sessionId: "s1", payload: { id: "t3", sessionId: "s1" } },
    ]);
    expect(out).toHaveLength(3);
    expect(j.persistManyCalls).toBe(1); // N 条 = 1 次批量落盘
    expect(j.persistCalls).toBe(0); // 不走逐条 append 路径
    expect(out.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(j.readAll().map((e) => (e.payload as { id: string }).id)).toEqual(["t1", "t2", "t3"]);
    const lines = readFileSync(fp, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([0, 1, 2]);
    // 新实例重放:批量落盘内容可完整恢复。
    expect(new FileJournal(fp).readAll()).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("幂等键重复条目:批内/跨批均跳过(不落盘、不计入返回、length 不涨)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-batch-idem-"));
    const fp = join(dir, "idem.jsonl");
    const j = new CountingJournal(fp);
    const first = j.appendMany([
      { kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" },
      { kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k2" },
      { kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" }, // 批内重复
    ]);
    expect(first.map((e) => e.idempotencyKey)).toEqual(["k1", "k2"]);
    expect(j.length).toBe(2);
    // 跨批重复:全部命中→不落盘(零 persist/persistMany)。
    const beforeMany = j.persistManyCalls;
    const beforeSingle = j.persistCalls;
    const second = j.appendMany([
      { kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" },
      { kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k2" },
    ]);
    expect(second).toEqual([]);
    expect(j.length).toBe(2);
    expect(j.persistManyCalls).toBe(beforeMany);
    expect(j.persistCalls).toBe(beforeSingle);
    // 与 append 口径一致:同 key 单条追加同样跳过。
    expect(j.append({ kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" }).seq).toBe(0);
    expect(j.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("空批/纯命中批不强建目录:延后到确有写入时才触达 fs", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-batch-nodir-"));
    const fp = join(dir, "nested", "deep", "s.jsonl");
    const j = new CountingJournal(fp);
    j.appendMany([]); // 空批:不应创建 nested/deep
    expect(existsSync(join(dir, "nested"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("task 状态机", () => {
  const base: Task = {
    id: "t1", sessionId: "s1", instruction: "do x",
    state: "queued", createdAt: 0, updatedAt: 0,
  };
  it("合法迁移", () => {
    expect(canTransition("queued", "running")).toBe(true);
    const running = transition(base, "running");
    expect(running.state).toBe("running");
  });
  it("非法迁移抛错", () => {
    expect(canTransition("done", "running")).toBe(false);
    expect(() => transition({ ...base, state: "done" }, "running")).toThrow();
  });
});

describe("permission 求值", () => {
  it("默认 ask", () => {
    const r = evaluatePermission("fs.write", "/tmp/x", [], wildcardMatch);
    expect(r.action).toBe("ask");
  });
  it("命中 allow 规则", () => {
    const r = evaluatePermission(
      "fs.read", "/tmp/a.txt",
      [[{ permission: "fs.read", pattern: "/tmp/*", action: "allow" }]],
      wildcardMatch);
    expect(r.action).toBe("allow");
  });
  it("deny 优先于不命中", () => {
    const r = evaluatePermission(
      "shell.exec", "rm -rf /",
      [[{ permission: "shell.exec", pattern: "*", action: "deny" }]],
      wildcardMatch);
    expect(r.action).toBe("deny");
  });
});

describe("wildcard 匹配", () => {
  it("通配符匹配", () => {
    expect(wildcardMatch("fs.write", "fs.*")).toBe(true);
    expect(wildcardMatch("/tmp/a.txt", "/tmp/*")).toBe(true);
    expect(wildcardMatch("a", "b")).toBe(false);
  });
});

describe("journal 崩溃恢复(R1 审计 C15)", () => {
  it("半截行截断:坏行及其后内容被丢弃,好行完整重放", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-bad-"));
    const fp = join(dir, "s.jsonl");
    const j1 = new FileJournal(fp);
    j1.append({ kind: "session.start", sessionId: "s", payload: {} });
    j1.append({ kind: "message.user", sessionId: "s", payload: { text: "ok" } });
    // 模拟崩溃:尾部追加半截行 + 一行「不可信内容」
    appendFileSync(fp, '{"seq":2,"kind":"mes', "utf-8");
    appendFileSync(fp, '{"seq":3,"kind":"task.fail","sessionId":"s","payload":{}}\n', "utf-8");

    const j2 = new FileJournal(fp);
    const events = j2.readAll();
    expect(events).toHaveLength(2); // 只重放两条好行
    expect(events[1]!.payload).toEqual({ text: "ok" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("重放后续写的幂等键仍生效", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-journal-idem-"));
    const fp = join(dir, "s.jsonl");
    const j1 = new FileJournal(fp);
    j1.append({ kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" });
    const j2 = new FileJournal(fp);
    j2.append({ kind: "task.enqueue", sessionId: "s", payload: {}, idempotencyKey: "k1" });
    expect(j2.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("", () => {
  it("transition 进入 running 刷新 startedAt(「已工作」计时数据源)", () => {
    const base: Task = {
      id: "t1", sessionId: "s", instruction: "i", state: "queued", createdAt: 1, updatedAt: 1,
    };
    const run = transition(base, "running");
    expect(typeof run.startedAt).toBe("number");
    expect(run.startedAt!).toBeGreaterThan(0);
    const done = transition(run, "done", "ok");
    expect(done.startedAt).toBe(run.startedAt); // 终态保留起点(面板算用时)
  });
});
