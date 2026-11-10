/**
 * ACP 子代理后端协议级验证:
 * mock ACP adapter 顶替真实外部 agent(不装 SDK/不依赖本机 CLI),真跑 stdio 全链路。
 * 覆盖:initialize→session/new→prompt→流式 update→result;permission 往返;cancel 链;
 * 超时;协议版本不兼容;进程崩溃;未知 stopReason;adapter 缺失;env scrub。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpBackend, createAcpBackend, resolveAcpAdapter, scrubEnvironment, ACP_ADAPTERS } from "../src/acp-backend";
import type { SubagentEvent, SubagentHandle, TaskResult, TaskSpec } from "../src/ndjson-backend";

const here = dirname(fileURLToPath(import.meta.url));
const mockAdapter = join(here, "fixtures", "mock-acp-adapter.mjs");
const tmp = (): string => mkdtempSync(join(tmpdir(), "acp117-"));

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  taskId: "acp-1",
  instructions: "读一下 README 并总结",
  workdir: process.cwd(),
  permissions: "sandbox",
  ...over,
});

function backend(mode: string, over: { promptTimeoutMs?: number; permissionPolicy?: "ask" | "allow" | "reject"; env?: Record<string, string> } = {}): AcpBackend {
  return new AcpBackend({
    command: process.execPath,
    args: [mockAdapter],
    env: { MOCK_ACP_MODE: mode, ...(over.env ?? {}) },
    ...(over.promptTimeoutMs ? { promptTimeoutMs: over.promptTimeoutMs } : {}),
    ...(over.permissionPolicy ? { permissionPolicy: over.permissionPolicy } : {}),
  });
}

interface Spawned {
  handle: SubagentHandle;
  events: SubagentEvent[];
  result: Promise<TaskResult>;
}

function spawnAcp(b: AcpBackend, s: TaskSpec = spec()): Promise<Spawned> {
  const events: SubagentEvent[] = [];
  let resolveResult!: (r: TaskResult) => void;
  const result = new Promise<TaskResult>((resolve) => { resolveResult = resolve; });
  return b.spawn(s, (e) => {
    events.push(e);
    if (e.type === "result") resolveResult(e.result);
  }).then((handle) => ({ handle, events, result }));
}

async function waitFor<T>(fn: () => T | undefined, budgetMs = 4000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const hit = fn();
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor 超时");
}

describe("ACP backend()", () => {
  it("happy path:initialize→session/new→prompt→流式 update→result", async () => {
    const { handle, events, result } = await spawnAcp(backend("happy"));
    expect(events.some((e) => e.type === "ready")).toBe(true);
    expect(handle.acpSessionId).toBe("sess-mock-1");
    expect(handle.acpAdapter).toBe(process.execPath);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.finalText).toBe("第一段第二段");
    // progress 归一:thought 一次 + tool_call/tool_call_update
    const notes = events.filter((e) => e.type === "progress").map((e) => (e as { note: string }).note);
    expect(notes.some((n) => n.includes("thinking"))).toBe(true);
    expect(notes.some((n) => n.includes("tool:read:读取 README"))).toBe(true);
    expect(notes.some((n) => n.includes("[completed]"))).toBe(true);
  }, 15_000);

  it("permission:adapter 发 request_permission → harness ask → allow 回流 selected", async () => {
    const trace = join(tmp(), "trace.log");
    const { handle, events, result } = await spawnAcp(backend("permission", { env: { MOCK_ACP_TRACE: trace } }));
    const ask = await waitFor(() => events.find((e) => e.type === "permission-ask"));
    if (ask.type !== "permission-ask") throw new Error("unreachable");
    expect(ask.summary).toContain("写入文件");
    expect(ask.risk).toBe("high");
    await handle.respondPermission(ask.requestId, "allow-once");
    const r = await result;
    expect(r.ok).toBe(true);
    expect(String(r.finalText)).toContain("opt-allow");
    expect(readFileSync(trace, "utf-8")).toContain('"optionId":"opt-allow"');
  }, 15_000);

  it("permission reject:拒绝回流 reject_once option(ACP 语义:selected 拒绝项)", async () => {
    const trace = join(tmp(), "trace.log");
    const { handle, events, result } = await spawnAcp(backend("permission", { env: { MOCK_ACP_TRACE: trace } }));
    const ask = await waitFor(() => events.find((e) => e.type === "permission-ask"));
    await handle.respondPermission(ask.requestId, "reject");
    const r = await result;
    expect(r.ok).toBe(true);
    expect(String(r.finalText)).toContain("opt-reject");
    await waitFor(() => (readFileSync(trace, "utf-8").includes("opt-reject") ? true : undefined));
  }, 15_000);

  it("cancel:进行中 graceful cancel → session/cancel 发出 + 子代理落 cancelled 终态", async () => {
    const trace = join(tmp(), "trace.log");
    const { handle, events, result } = await spawnAcp(backend("slow", { env: { MOCK_ACP_TRACE: trace } }));
    await waitFor(() => events.find((e) => e.type === "progress" && (e as { note: string }).note.startsWith("acp session")));
    await handle.cancel("graceful");
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("cancelled");
    expect(String(r.finalText)).toContain("cancel-ack");
    const log = readFileSync(trace, "utf-8");
    expect(log).toContain("cancel:sess-mock-1");
  }, 15_000);

  it("force cancel:立即落 cancelled(不等 adapter 收口)", async () => {
    const { handle, events, result } = await spawnAcp(backend("slow"));
    await waitFor(() => events.find((e) => e.type === "progress" && (e as { note: string }).note.startsWith("acp session")));
    await handle.cancel("force");
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("cancelled");
  }, 15_000);

  it("parentSignal abort → 同一取消路径(父子取消链)", async () => {
    const ac = new AbortController();
    const { events, result } = await spawnAcp(backend("slow"), spec({ parentSignal: ac.signal }));
    await waitFor(() => events.find((e) => e.type === "progress" && (e as { note: string }).note.startsWith("acp session")));
    ac.abort();
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("cancelled");
  }, 15_000);

  it("timeout:回合超时 → timeout typed 错误(并发出 session/cancel)", async () => {
    const trace = join(tmp(), "trace.log");
    const { result } = await spawnAcp(backend("slow", { promptTimeoutMs: 350, env: { MOCK_ACP_TRACE: trace } }));
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("timeout");
    await waitFor(() => (readFileSync(trace, "utf-8").includes("cancel:sess-mock-1") ? true : undefined));
  }, 15_000);

  it("协议版本不兼容 → spawn-failed(fail-visible)", async () => {
    const { result } = await spawnAcp(backend("badversion"));
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("spawn-failed");
    expect(String(r.error?.detail)).toContain("协议版本不兼容");
  }, 15_000);

  it("adapter 进程崩溃 → backend-crash + stderr 尾巴", async () => {
    const { result } = await spawnAcp(backend("crash"));
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("backend-crash");
    expect(String(r.error?.detail)).toContain("deliberate crash");
  }, 15_000);

  it("未知 stopReason → backend-crash(绝不静默成功)", async () => {
    const { result } = await spawnAcp(backend("unknown-stop"));
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("backend-crash");
    expect(String(r.error?.detail)).toContain("future_thing");
  }, 15_000);

  it("adapter 不存在 → spawn-failed(不崩宿主)", async () => {
    const b = new AcpBackend({ command: "definitely-not-an-acp-adapter-9x7" });
    const { result } = await spawnAcp(b);
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("spawn-failed");
  }, 15_000);

  it("未配置 adapter → spawn-failed 且报错带内置目录", async () => {
    const prev = process.env.GENIE_ACP_ADAPTER;
    delete process.env.GENIE_ACP_ADAPTER;
    try {
      const b = new AcpBackend({});
      const { result } = await spawnAcp(b);
      const r = await result;
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe("spawn-failed");
      expect(String(r.error?.detail)).toContain("claude-code");
      expect(String(r.error?.detail)).toContain("GENIE_ACP_ADAPTER");
    } finally {
      if (prev !== undefined) process.env.GENIE_ACP_ADAPTER = prev;
    }
  }, 15_000);

  it("permissionPolicy=allow 自动选 allow_once(不经 ask 事件)", async () => {
    const { events, result } = await spawnAcp(backend("permission", { permissionPolicy: "allow" }));
    expect(events.some((e) => e.type === "permission-ask")).toBe(false);
    const r = await result;
    expect(r.ok).toBe(true);
    expect(String(r.finalText)).toContain("opt-allow");
  }, 15_000);

  it("resolveAcpAdapter:内置名 / JSON / 裸命令 / env 兜底", () => {
    expect(resolveAcpAdapter("kimi")).toEqual({ command: "kimi", args: ["acp"], label: "Kimi Code" });
    expect(resolveAcpAdapter("hermes")?.args).toEqual(["acp", "--accept-hooks"]);
    expect(resolveAcpAdapter('{"cmd":"node","args":["agent.mjs"],"label":"demo"}')).toEqual({
      command: "node", args: ["agent.mjs"], label: "demo",
    });
    expect(resolveAcpAdapter("my-agent --stdio")?.command).toBe("my-agent");
    expect(resolveAcpAdapter("my-agent --stdio")?.args).toEqual(["--stdio"]);
    expect(resolveAcpAdapter(undefined, [], {})).toBeNull();
    expect(resolveAcpAdapter(undefined, [], { GENIE_ACP_ADAPTER: "codex" })?.command).toBe("codex-acp");
    expect(resolveAcpAdapter("kimi", ["--extra"])?.args).toEqual(["acp", "--extra"]);
    expect(Object.keys(ACP_ADAPTERS)).toContain("claude-code");
  });

  it("scrubEnvironment:父凭证默认不进子进程,显式 adapterEnv opt-in", () => {
    const scrubbed = scrubEnvironment({ PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-x", SOME_TOKEN: "t", MY_SECRET: "s" });
    expect(scrubbed.PATH).toBe("/bin");
    expect(scrubbed.HOME).toBe("/home/x");
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.SOME_TOKEN).toBeUndefined();
    expect(scrubbed.MY_SECRET).toBeUndefined();
    const b = createAcpBackend({ adapter: "kimi", adapterEnv: { ANTHROPIC_API_KEY: "explicit" } });
    expect(b.kind).toBe("acp");
    expect(b.adapterHint).toBe("kimi");
  });
});
