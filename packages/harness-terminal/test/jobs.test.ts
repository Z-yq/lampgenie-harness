/**
 *  Job registry 测试:真跑 sh 命令(不 mock 进程)。
 * 覆盖:start/wait/read 增量、spill + 绝对 offset、kill 一次结算、owner fence、
 * 并发上限、cwd 围栏、job 工具五路 action。
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobError, JobRegistry, type JobSettledEvent } from "../src/jobs.js";
import { createJobTool } from "../src/tool.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "genie-jobs-test-"));
const registries: JobRegistry[] = [];

function makeRegistry(opts: Partial<ConstructorParameters<typeof JobRegistry>[0]> = {}) {
  const registry = new JobRegistry({
    root: tmpRoot,
    spillDir: join(tmpRoot, "spill"),
    killGraceMs: 300,
    ...opts,
  });
  registries.push(registry);
  return registry;
}

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof JobError) return (err as JobError).code;
    return `NON_JOB:${String(err)}`;
  }
  return "NO_THROW";
};

afterAll(async () => {
  await Promise.allSettled(registries.map((r) => r.shutdown()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("job registry start/wait/read", () => {
  it("start echo 后 wait 得 done/code 0,read 按绝对 offset 增量", async () => {
    const registry = makeRegistry();
    const started = registry.start("u1", { command: "printf 'hello-'; sleep 0.1; printf 'world\\n'", title: "echo" });
    expect(typeof started.jobId).toBe("string");
    expect(typeof started.pid).toBe("number");

    const listed = registry.list("u1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("running");
    expect(listed[0]!.title).toBe("echo");

    const done = await registry.wait("u1", started.jobId, { timeoutMs: 10_000 });
    expect(done.status).toBe("done");
    expect(done.code).toBe(0);
    expect(done.endedAt).toBeGreaterThan(0);

    const first = registry.read("u1", started.jobId, { offset: 0, maxBytes: 5 });
    expect(first.offset).toBe(0);
    expect(first.nextOffset).toBe(5);
    expect(first.chunk).toBe("hello");
    expect(first.spilled).toBe(false);

    const second = registry.read("u1", started.jobId, { offset: first.nextOffset, maxBytes: 100 });
    expect(second.chunk).toBe("-world\n");
    expect(second.nextOffset).toBe(done.bytes);
    expect(second.eof).toBe(true);
    expect(done.bytes).toBe(12);
  });

  it("wait 超时返回 running 快照且不杀 job", async () => {
    const registry = makeRegistry();
    const started = registry.start("u1", { command: "sleep 1" });
    const snap = await registry.wait("u1", started.jobId, { timeoutMs: 100 });
    expect(snap.status).toBe("running");
    expect(snap.endedAt).toBeUndefined();
    await registry.kill("u1", started.jobId);
  });
});

describe("job registry spill + 绝对 offset", () => {
  it("输出超内存上限后落 spill,落后 offset 返回 spilled 并从文件续读", async () => {
    const registry = makeRegistry({ bufferBytes: 1024 });
    const started = registry.start("u1", { command: "yes a | head -c 200000; echo" });
    const done = await registry.wait("u1", started.jobId, { timeoutMs: 20_000 });
    expect(done.status).toBe("done");
    expect(done.bytes).toBe(200_001);
    expect(done.spillPath).toBeTruthy();
    expect(existsSync(done.spillPath!)).toBe(true);

    const first = registry.read("u1", started.jobId, { offset: 0, maxBytes: 8192 });
    expect(first.spilled).toBe(true);
    expect(first.spillPath).toBe(done.spillPath);
    expect(first.offset).toBe(0);
    // 绝对 offset 单调:old offset 仍按旧字节位定位,不因淘汰重置。
    let offset = 0;
    let text = "";
    for (let i = 0; i < 200 && offset < done.bytes; i++) {
      const r = registry.read("u1", started.jobId, { offset, maxBytes: 8192 });
      expect(r.offset).toBe(offset);
      expect(r.nextOffset).toBeGreaterThan(offset);
      offset = r.nextOffset;
      text += r.chunk;
    }
    expect(offset).toBe(200_001);
    expect(text.length).toBe(200_001);
    expect(text.replace(/\n/g, "").replace(/a/g, "")).toBe("");
  }, 40_000);
});

describe("job registry settlement first-wins", () => {
  it("exit 与 kill 竞态只结算一次,重复 kill 返回同一快照", async () => {
    const events: JobSettledEvent[] = [];
    const registry = makeRegistry({ onSettle: (e) => events.push(e) });
    const started = registry.start("u1", { command: "sleep 0.15; echo finished" });
    await new Promise((r) => setTimeout(r, 30));
    const killed = await registry.kill("u1", started.jobId);
    expect(killed.status).toBe("killed");
    expect(killed.signal).toBeTruthy();
    const again = await registry.kill("u1", started.jobId);
    expect(again.status).toBe("killed");
    expect(again.endedAt).toBe(killed.endedAt);
    await new Promise((r) => setTimeout(r, 400)); // 留给 exit/close 事件(应被 first-wins 丢弃)
    expect(events.filter((e) => e.jobId === started.jobId)).toHaveLength(1);
    const waited = await registry.wait("u1", started.jobId);
    expect(waited.endedAt).toBe(killed.endedAt);
  });

  it("正常结束的通知只调一次(exit + close 不重复)", async () => {
    const events: JobSettledEvent[] = [];
    const registry = makeRegistry({ onSettle: (e) => events.push(e) });
    const started = registry.start("u1", { command: "true" });
    await registry.wait("u1", started.jobId, { timeoutMs: 10_000 });
    await new Promise((r) => setTimeout(r, 200));
    const mine = events.filter((e) => e.jobId === started.jobId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe("done");
    expect(mine[0]!.code).toBe(0);
  });
});

describe("job registry owner fence / limits", () => {
  it("另一 owner 的 list/read/kill 一律 JOB_FORBIDDEN,不存在 JOB_NOT_FOUND", async () => {
    const registry = makeRegistry();
    const started = registry.start("owner-a", { command: "sleep 1" });
    expect(registry.list("owner-b")).toHaveLength(0);
    expect(codeOf(() => registry.read("owner-b", started.jobId))).toBe("JOB_FORBIDDEN");
    await expect(registry.kill("owner-b", started.jobId)).rejects.toMatchObject({ code: "JOB_FORBIDDEN" });
    await expect(registry.wait("owner-b", started.jobId)).rejects.toMatchObject({ code: "JOB_FORBIDDEN" });
    expect(codeOf(() => registry.read("owner-a", "job-nope"))).toBe("JOB_NOT_FOUND");
    await registry.disposeOwner("owner-a");
  });

  it("disposeOwner 后本 owner 无 running,另一 owner 不受影响", async () => {
    const registry = makeRegistry();
    const a = registry.start("owner-a", { command: "sleep 30" });
    registry.start("owner-a", { command: "sleep 30" });
    const b = registry.start("owner-b", { command: "sleep 30" });
    const disposed = await registry.disposeOwner("owner-a");
    expect(disposed).toBe(2);
    expect(registry.list("owner-a").filter((j) => j.status === "running")).toHaveLength(0);
    expect(registry.list("owner-a").every((j) => j.status === "killed")).toBe(true);
    expect(registry.list("owner-b").find((j) => j.jobId === b.jobId)!.status).toBe("running");
    await registry.disposeOwner("owner-b");
    expect(registry.read("owner-a", a.jobId).eof).toBe(true);
  });

  it("并发上限:per-owner 第 N+1 个 → JOB_LIMIT;cwd 越界 → JOB_BAD_CWD", async () => {
    const registry = makeRegistry({ maxPerOwner: 1, maxGlobal: 5 });
    registry.start("u1", { command: "sleep 5" });
    expect(codeOf(() => registry.start("u1", { command: "sleep 5" }))).toBe("JOB_LIMIT");
    expect(codeOf(() => registry.start("u2", { command: "sleep 5", cwd: "../../.." }))).toBe("JOB_BAD_CWD");
    registry.start("u2", { command: "sleep 5", cwd: "." });
    await registry.disposeOwner("u1");
    await registry.disposeOwner("u2");
  });

  it("全局上限 → JOB_LIMIT", () => {
    const registry = makeRegistry({ maxPerOwner: 4, maxGlobal: 1 });
    registry.start("u1", { command: "sleep 5" });
    expect(codeOf(() => registry.start("u2", { command: "sleep 5" }))).toBe("JOB_LIMIT");
  });
});

describe("job 工具五路 action", () => {
  it("start/list/read/wait/kill 各返对应字段;错误以稳定码开头", async () => {
    const registry = makeRegistry();
    const tool = createJobTool({ registry, owner: "tool-owner", root: tmpRoot });

    const started = parse(await tool.execute({ action: "start", command: "printf tool-ok; sleep 0.05", title: "t" }));
    expect(started.ok).toBe(true);
    const jobId = String(started.jobId);

    const listed = parse(await tool.execute({ action: "list" }));
    expect(listed.ok).toBe(true);
    expect((listed.jobs as unknown[]).length).toBe(1);

    const waited = parse(await tool.execute({ action: "wait", jobId, timeoutMs: 10_000 }));
    expect(waited.ok).toBe(true);
    expect(waited.status).toBe("done");
    expect(waited.code).toBe(0);

    const read = parse(await tool.execute({ action: "read", jobId, offset: 0 }));
    expect(read.chunk).toBe("tool-ok");
    expect(read.nextOffset).toBe(7);
    expect(read.eof).toBe(true);

    const killed = parse(await tool.execute({ action: "kill", jobId }));
    expect(killed.ok).toBe(true);
    expect(killed.status).toBe("done"); // 已结算:返回既有快照,不重复结算

    const forbidden = parse(await tool.execute({ action: "read", jobId: "job-nope" }));
    expect(forbidden.ok).toBe(false);
    expect(String(forbidden.code)).toBe("JOB_NOT_FOUND");

    const badCwd = parse(await tool.execute({ action: "start", command: "echo x", cwd: "../../.." }));
    expect(badCwd.ok).toBe(false);
    expect(String(badCwd.code)).toBe("JOB_BAD_CWD");
  });

  it("命令围栏拒下发(fenceCommand → JOB_FORBIDDEN)", async () => {
    const registry = makeRegistry();
    const tool = createJobTool({ registry, owner: "o", root: tmpRoot, fenceCommand: (c) => (c.includes("blocked") ? "围栏拒绝" : null) });
    const blocked = parse(await tool.execute({ action: "start", command: "echo blocked" }));
    expect(blocked.ok).toBe(false);
    expect(String(blocked.code)).toBe("JOB_FORBIDDEN");
    expect(registry.list("o")).toHaveLength(0);
  });
});
