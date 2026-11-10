import { describe, it, expect } from "vitest";
import { ZcodeCliBackend, OpencodeCliBackend, createCliBackend } from "../src/cli-backends";
import type { SubagentBackend, SubagentEvent, TaskResult, TaskSpec } from "../src/ndjson-backend";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fixtures", "fake-cli.mjs");

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  taskId: "cli-1",
  instructions: "把 README 翻译成英文",
  workdir: process.cwd(),
  permissions: "sandbox",
  ...over,
});

/** spawn 并等首个 result 事件(契约:结果经事件流,不轮询)。 */
async function run(backend: SubagentBackend, s: TaskSpec): Promise<{ events: SubagentEvent[]; result: TaskResult }> {
  const events: SubagentEvent[] = [];
  const result = await new Promise<TaskResult>((resolve) => {
    void backend.spawn(s, (e) => {
      events.push(e);
      if (e.type === "result") resolve(e.result);
    });
  });
  return { events, result };
}

/** 轮询等子进程消亡(process.kill(pid,0) 抛 ESRCH)。 */
async function waitPidGone(pid: number, budgetMs = 5000): Promise<boolean> {
  const dead = (): boolean => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  };
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (dead()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return dead();
}

describe("CLI 后端( §2.2 zcode-headless / opencode-run)", () => {
  it("opencode 缺省策略:指令拼进 run 参数,stdout trim 即 finalText", async () => {
    const backend = new OpencodeCliBackend({ bin: process.execPath, args: [fake, "print"] });
    expect(backend.kind).toBe("opencode-run");
    const { events, result } = await run(backend, spec());
    expect(events.some((e) => e.type === "ready")).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("把 README 翻译成英文");
  }, 15_000);

  it("zcode 缺省策略:指令经 stdin 喂入并回流", async () => {
    const backend = new ZcodeCliBackend({ bin: process.execPath, args: [fake, "stdin"] });
    expect(backend.kind).toBe("zcode-headless");
    const { result } = await run(backend, spec({ instructions: "stdin 指令正文\n第二行" }));
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("stdin 指令正文\n第二行");
  }, 15_000);

  it("buildCommand 注入完全接管(测试顶替真 CLI 的正规入口)", async () => {
    const backend = new ZcodeCliBackend({
      buildCommand: (instruction) => ({ cmd: process.execPath, args: [fake, "print", `LEN:${instruction.length}`] }),
    });
    const { result } = await run(backend, spec());
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe(`LEN:${"把 README 翻译成英文".length}`);
  }, 15_000);

  it("spawn ENOENT → spawn-failed typed 错误(fail-visible,不静默不崩宿主)", async () => {
    const backend = new ZcodeCliBackend({ bin: "definitely-not-a-real-cli-9x7" });
    const { result } = await run(backend, spec());
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("spawn-failed");
    expect(String(result.error?.detail).length).toBeGreaterThan(0);
  }, 15_000);

  it("非零退出 → backend-crash,detail 带 stderr 尾巴", async () => {
    const backend = new OpencodeCliBackend({ bin: process.execPath, args: [fake, "fail"] });
    const { result } = await run(backend, spec());
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("backend-crash");
    expect(String(result.error?.detail)).toContain("exit code 3");
    expect(String(result.error?.detail)).toContain("boom");
  }, 15_000);

  it("超时 → SIGKILL + timeout typed 错误", async () => {
    const backend = new OpencodeCliBackend({
      bin: process.execPath,
      args: [fake, "sleep", "10000"],
      timeoutMs: 300,
    });
    const { events, result } = await run(backend, spec());
    expect(events.some((e) => e.type === "ready")).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("timeout");
  }, 15_000);

  it("cancel(force) 立即杀子进程,结果=cancelled", async () => {
    const backend = new OpencodeCliBackend({ bin: process.execPath, args: [fake, "sleep", "10000"] });
    const events: SubagentEvent[] = [];
    let result: TaskResult | null = null;
    const handle = await backend.spawn(spec({ taskId: "cli-cancel" }), (e) => {
      events.push(e);
      if (e.type === "result") result = e.result;
    });
    expect(handle.pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    await handle.cancel("force");
    expect(events.some((e) => e.type === "ready")).toBe(true);
    expect(result && result.error?.kind).toBe("cancelled");
    expect(await waitPidGone(handle.pid!)).toBe(true);
  }, 15_000);

  it("cancel(graceful) 对忽略 SIGTERM 的进程升级 SIGKILL", async () => {
    const backend = new ZcodeCliBackend({ bin: process.execPath, args: [fake, "stubborn"] });
    const events: SubagentEvent[] = [];
    let result: TaskResult | null = null;
    const handle = await backend.spawn(spec({ taskId: "cli-graceful" }), (e) => {
      events.push(e);
      if (e.type === "result") result = e.result;
    });
    await new Promise((r) => setTimeout(r, 150));
    await handle.cancel("graceful");
    expect(result && result.error?.kind).toBe("cancelled");
    expect(await waitPidGone(handle.pid!)).toBe(true);
  }, 15_000);

  it("steer 恒 false(一次性 CLI 无干预语义),respondPermission 不抛", async () => {
    const backend = new OpencodeCliBackend({ bin: process.execPath, args: [fake, "sleep", "800"] });
    const handle = await backend.spawn(spec(), () => {});
    expect(await handle.steer("改方向", "directive")).toBe(false);
    await handle.respondPermission("req-1", "allow-once");
    await handle.cancel("force");
  }, 15_000);

  it("spec.env 透传子进程(凭证 env 注入位:值只进进程环境,不进指令文本)", async () => {
    const backend = new OpencodeCliBackend({
      bin: process.execPath,
      args: [fake, "envdump", "FAKE_CLI_TOKEN"],
    });
    const { result } = await run(backend, spec({ env: { FAKE_CLI_TOKEN: "tok-123" } }));
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe("tok-123");
  }, 15_000);

  it("cwdFn 覆盖工作目录;createCliBackend 工厂出正确 kind,未知 kind 显式抛", async () => {
    expect(createCliBackend("zcode").constructor.name).toBe("ZcodeCliBackend");
    expect(createCliBackend("opencode").constructor.name).toBe("OpencodeCliBackend");
    expect(() => createCliBackend("dsh" as never)).toThrow(/未知 kind/);

    const backend = createCliBackend("opencode", {
      bin: process.execPath,
      args: [fake, "print"],
      cwdFn: (s) => s.workdir,
    }) as OpencodeCliBackend;
    const { result } = await run(backend, spec());
    expect(result.ok).toBe(true);
  }, 15_000);
});
