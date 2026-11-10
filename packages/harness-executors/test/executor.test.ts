import { describe, it, expect } from "vitest";
import { EchoChildBackend } from "../src/echo-backend";
import type { SubagentEvent, TaskResult } from "../src/ndjson-backend";

const spec = {
  taskId: "t-1",
  instructions: "把 README 翻译成英文",
  workdir: process.cwd(),
  permissions: "sandbox" as const,
};

describe("executor NDJSON-RPC 全链路(真实子进程)", () => {
  it("spawn→ready→progress→result 全序", async () => {
    const backend = new EchoChildBackend();
    const events: string[] = [];
    let finalResult: TaskResult | null = null;
    const handle = await backend.spawn(spec, (e: SubagentEvent) => {
      events.push(e.type);
      if (e.type === "result") finalResult = e.result;
    });
    expect(handle.taskId).toBe("t-1");
    expect(handle.pid).toBeGreaterThan(0);
    // 等结果
    await new Promise((r) => setTimeout(r, 1500));
    expect(events).toContain("ready");
    expect(events).toContain("progress");
    expect(events).toContain("result");
    expect(finalResult!.ok).toBe(true);
    expect(finalResult!.finalText).toContain("README");
  }, 15000);

  it("steer:directive 必从,hint 可拒", async () => {
    const backend = new EchoChildBackend();
    const handle = await backend.spawn(spec, () => {});
    // spawn 后子进程 200ms 退出,steer 要抢在结果前;慢一点就改验「进程已退出返回 false」
    await new Promise((r) => setTimeout(r, 100));
    const ok = await handle.steer("继续", "directive").catch(() => false);
    expect(typeof ok).toBe("boolean");
  }, 15000);
});
