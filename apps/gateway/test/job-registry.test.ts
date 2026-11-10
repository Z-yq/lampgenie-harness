/**
 * M27 网关层:job registry 单例 + 结算通知去重 + 任务终态回收。
 *
 * 真跑 sh 命令;journal 用 MemoryJournal 观测 custom job.done / message.system 的投递次数。
 */
import { afterAll, describe, expect, it } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { disposeSessionJobs, getJobRegistry } from "../src/agent-wiring.js";

const registries = new Set<{ shutdown: () => Promise<number> }>();

function newJournal(): MemoryJournal {
  const journal = new MemoryJournal();
  registries.add(getJobRegistry(journal as never));
  return journal;
}

function eventsOf(journal: MemoryJournal, type: string): Record<string, unknown>[] {
  return journal
    .readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { type?: string } | undefined)?.type === type)
    .map((e) => e.payload as Record<string, unknown>);
}

function systemTexts(journal: MemoryJournal): string[] {
  return journal
    .readAll()
    .filter((e) => e.kind === "message.system")
    .map((e) => String((e.payload as { text?: string } | undefined)?.text ?? ""));
}

async function waitUntil(fn: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil 超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

afterAll(async () => {
  await Promise.allSettled([...registries].map((r) => r.shutdown()));
});

describe("job registry 网关接线", () => {
  it("同一 journal 两次 getJobRegistry 得同一实例", () => {
    const journal = newJournal();
    expect(getJobRegistry(journal as never)).toBe(getJobRegistry(journal as never));
    const other = newJournal();
    expect(getJobRegistry(other as never)).not.toBe(getJobRegistry(journal as never));
  });

  it("job.done 只落一次;wait 消费结算时不再唤醒(message.system 0 条)", async () => {
    const journal = newJournal();
    const registry = getJobRegistry(journal as never);
    const sessionId = "sess-notify-1";
    const started = registry.start(sessionId, { command: "printf done-ok", title: "notify" });
    const info = await registry.wait(sessionId, started.jobId, { timeoutMs: 10_000 });
    expect(info.status).toBe("done");
    await new Promise((r) => setTimeout(r, 200));

    const done = eventsOf(journal, "job.done").filter((e) => e.jobId === started.jobId);
    expect(done).toHaveLength(1);
    expect(done[0]!.status).toBe("done");
    expect(done[0]!.bytes).toBe(7);
    expect(systemTexts(journal).filter((t) => t.includes(started.jobId))).toHaveLength(0);
  });

  it("无 wait 消费的 job 结算 → 1 条 job.done + 1 条 message.system(不重复)", async () => {
    const journal = newJournal();
    const registry = getJobRegistry(journal as never);
    const sessionId = "sess-notify-2";
    const started = registry.start(sessionId, { command: "sleep 0.1", title: "wake" });
    await waitUntil(() => eventsOf(journal, "job.done").some((e) => e.jobId === started.jobId));
    await new Promise((r) => setTimeout(r, 300)); // 留给可能的重复投递

    expect(eventsOf(journal, "job.done").filter((e) => e.jobId === started.jobId)).toHaveLength(1);
    const wakes = systemTexts(journal).filter((t) => t.includes(started.jobId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("[后台 job done]");
  });

  it("owner 取消(disposeSession)回收主 owner 与子代理 owner 的 running job", async () => {
    const journal = newJournal();
    const registry = getJobRegistry(journal as never);
    const sessionId = "sess-dispose";
    const main = registry.start(sessionId, { command: "sleep 30" });
    const subOwner = "sub-agent-1";
    registry.bindOwner(subOwner, sessionId);
    const sub = registry.start(subOwner, { command: "sleep 30", title: "sub-job" });
    expect(registry.list(sessionId).filter((j) => j.status === "running")).toHaveLength(1);
    expect(registry.list(subOwner).filter((j) => j.status === "running")).toHaveLength(1);

    const killed = await disposeSessionJobs(journal as never, sessionId);
    expect(killed).toBe(2);
    expect(registry.list(sessionId).filter((j) => j.status === "running")).toHaveLength(0);
    expect(registry.list(subOwner).filter((j) => j.status === "running")).toHaveLength(0);
    expect(registry.list(sessionId).find((j) => j.jobId === main.jobId)!.status).toBe("killed");
    expect(registry.list(subOwner).find((j) => j.jobId === sub.jobId)!.status).toBe("killed");
    // 回收同样只投递一次结算
    await new Promise((r) => setTimeout(r, 200));
    expect(eventsOf(journal, "job.done").filter((e) => e.jobId === main.jobId)).toHaveLength(1);
    expect(eventsOf(journal, "job.done").filter((e) => e.jobId === sub.jobId)).toHaveLength(1);
    // 子代理 owner 的结算路由回父会话
    const subDone = eventsOf(journal, "job.done").find((e) => e.jobId === sub.jobId)!;
    expect(subDone.owner).toBe(subOwner);
    expect(journal.readAll().filter((e) => e.kind === "custom" && (e.payload as { jobId?: string }).jobId === sub.jobId)[0]!.sessionId).toBe(sessionId);
  });
});
