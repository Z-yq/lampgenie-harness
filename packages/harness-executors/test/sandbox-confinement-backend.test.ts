/**
 * 沙箱事实接入验证:spawn 前判定、违规不启动子进程、spawn 载荷携带 facts。
 * 真子进程用 echo-child.mjs(200ms 出 result),拒绝路径靠 command 调用计数证明「没起进程」。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NdjsonChildBackend,
  type SubagentEvent,
  type TaskResult,
  type TaskSpec,
} from "../src/ndjson-backend";
import { EchoChildBackend } from "../src/echo-backend";

const here = dirname(fileURLToPath(import.meta.url));
const echoChild = join(here, "../src/echo-child.mjs");
const tmp = (): string => mkdtempSync(join(tmpdir(), "m76-conf-"));

/** 按 ndjson 全能力登记、实际跑 echo 子进程(只验沙箱门,不验子进程实现)。 */
class FullCapBackend extends NdjsonChildBackend {
  readonly kind = "ndjson";
  commandCalls = 0;
  command(_spec: TaskSpec): { cmd: string; args: string[] } {
    this.commandCalls += 1;
    return { cmd: process.execPath, args: [echoChild] };
  }
}

/** 只具备文件系统隔离 → partial,用来验 backend 侧的事实等级。 */
class PartialCapBackend extends FullCapBackend {
  protected confinementCapabilities() {
    return { fsIsolation: true, networkIsolation: false, processIsolation: false, envScrub: false };
  }
}

const mkSpec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  taskId: "m76-conf-1",
  instructions: "跑一遍夹具",
  workdir: tmp(),
  permissions: "sandbox",
  ...over,
});

interface Collected {
  events: SubagentEvent[];
  onEvent: (e: SubagentEvent) => void;
  result: Promise<TaskResult>;
}

function collect(): Collected {
  const events: SubagentEvent[] = [];
  let settle!: (r: TaskResult) => void;
  const result = new Promise<TaskResult>((resolve) => {
    settle = resolve;
  });
  const onEvent = (e: SubagentEvent): void => {
    events.push(e);
    if (e.type === "result") settle(e.result);
  };
  return { events, onEvent, result };
}

describe("ndjson backend:spawn 前评估 confinement", () => {
  it("探针 A:全能力 → level=full/enforced,子进程正常完成", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    const handle = await backend.spawn(mkSpec(), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(true);
    expect(backend.commandCalls).toBe(1);
    expect(backend.lastConfinement?.level).toBe("full");
    expect(backend.lastConfinement?.enforced).toBe(true);
    expect(backend.lastConfinement?.runner).toBe("ndjson");
    expect(handle.pid).toBeTypeOf("number");
  });

  it("spawn 载荷携带 confinement facts,且原必填字段不变", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    await backend.spawn(mkSpec({ taskId: "m76-msg" }), c.onEvent);
    await c.result;
    const msg = backend.lastSpawnMessage!;
    expect(msg.type).toBe("spawn");
    expect(msg.taskId).toBe("m76-msg");
    expect(msg.permissions).toBe("sandbox");
    expect(msg.instructions).toBe("跑一遍夹具");
    const conf = msg.confinement as { level: string; runner: string; enforced: boolean };
    expect(conf.level).toBe("full");
    expect(conf.runner).toBe("ndjson");
    expect(conf.enforced).toBe(true);
  });

  it("探针 B:缺 network/process/env → partial + 逐项 reason", async () => {
    const backend = new PartialCapBackend();
    const c = collect();
    await backend.spawn(mkSpec(), c.onEvent);
    await c.result;
    expect(backend.lastConfinement?.level).toBe("partial");
    expect(backend.lastConfinement?.enforced).toBe(false);
    const reasons = backend.lastConfinement?.reasons.join("|") ?? "";
    expect(reasons).toContain("networkIsolation");
    expect(reasons).toContain("processIsolation");
    expect(reasons).toContain("envScrub");
  });

  it("探针 G:echo 归因 none,且真子进程照常跑通(可选字段向后兼容)", async () => {
    const backend = new EchoChildBackend();
    const c = collect();
    await backend.spawn(mkSpec({ taskId: "m76-echo" }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(true);
    expect(backend.lastConfinement?.level).toBe("none");
    expect(backend.lastConfinement?.runner).toBe("echo");
    expect(backend.lastConfinement?.enforced).toBe(false);
    const conf = backend.lastSpawnMessage!.confinement as { level: string; runner: string };
    expect(conf.level).toBe("none");
    expect(conf.runner).toBe("echo");
  });

  it("echo 绝不被标成 full,并说明缺失项", async () => {
    const backend = new EchoChildBackend();
    const c = collect();
    await backend.spawn(mkSpec(), c.onEvent);
    await c.result;
    expect(backend.lastConfinement?.level).not.toBe("full");
    expect(backend.lastConfinement?.reasons.some((r) => r.includes("networkIsolation"))).toBe(true);
  });

  it("readonly + echo:放行但记「声明≠事实」原因", async () => {
    const backend = new EchoChildBackend();
    const c = collect();
    await backend.spawn(mkSpec({ permissions: "readonly" }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(true);
    expect(backend.lastConfinement?.reasons.some((r) => r.includes("readonly"))).toBe(true);
  });
});

describe("违规拒绝:不启动子进程", () => {
  it("探针 E:env 带 OPENAI_API_KEY → 拒绝且 command() 未被调用", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    const handle = await backend.spawn(mkSpec({ env: { OPENAI_API_KEY: "fake-m76" } }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("spawn-failed");
    expect(result.error?.detail).toContain("sandbox-confinement-denied");
    expect(result.error?.detail).toContain("env");
    expect(backend.commandCalls).toBe(0);
    expect(backend.lastConfinement?.denied).toContain("env");
    expect(handle.pid).toBeUndefined();
  });

  it("探针 F:instructions 含 sudo → privilege 拒绝且不起进程", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    await backend.spawn(mkSpec({ instructions: "sudo rm -rf /tmp/x" }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(false);
    expect(result.error?.detail).toContain("privilege");
    expect(backend.lastConfinement?.denied).toContain("privilege");
    expect(backend.commandCalls).toBe(0);
  });

  it("空 workdir → workdir 拒绝且不起进程", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    await backend.spawn(mkSpec({ workdir: "" }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(false);
    expect(backend.lastConfinement?.denied).toContain("workdir");
    expect(backend.commandCalls).toBe(0);
  });

  it("多违规合并进同一条拒绝(env + privilege)", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    await backend.spawn(mkSpec({ env: { MY_TOKEN: "fake-t" }, instructions: "doas id" }), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(false);
    expect(backend.lastConfinement?.denied).toEqual(["env", "privilege"]);
    expect(backend.commandCalls).toBe(0);
  });

  it("拒绝时只发一条 result 事件,句柄控制动作安全 no-op", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    const handle = await backend.spawn(mkSpec({ env: { MY_SECRET: "fake-s" } }), c.onEvent);
    await c.result;
    await handle.cancel("force");
    expect(await handle.steer("x", "hint")).toBe(false);
    await handle.respondPermission("r1", "reject");
    expect(c.events.filter((e) => e.type === "result")).toHaveLength(1);
    expect(backend.commandCalls).toBe(0);
  });

  it("backend 不消费 spec 之外的字段:合法 spec 照常起进程,载荷无 network 键", async () => {
    const backend = new FullCapBackend();
    const c = collect();
    await backend.spawn(mkSpec(), c.onEvent);
    const result = await c.result;
    expect(result.ok).toBe(true);
    expect(backend.commandCalls).toBe(1);
    expect(Object.keys(backend.lastSpawnMessage!)).not.toContain("network");
  });
});
