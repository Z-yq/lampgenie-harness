/**
 * safe-restart-gateway.cjs:活跃任务门 + 探测失败门 + dry-run。
 * 纪律:本文件只跑「拒绝/只读探测」路径与纯函数;绝不触发真实的 stop/start(7700 在跑)。
 * 子进程用例全部带 --dry-run 或走「有活跃任务→非零退出」的分支。
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const requireCjs = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("../../../scripts/safe-restart-gateway.cjs", import.meta.url));

interface SafeRestart {
  EXIT: Record<string, number>;
  parseArgs(argv: string[]): Record<string, unknown>;
  readLockPid(p: string): number | undefined;
  activeTasksOf(tasks: unknown[]): Array<{ id: string; state: string; title: string }>;
  decideRestart(input: { probe: Record<string, unknown>; force?: boolean }): Record<string, unknown>;
  gatewaySpawnArgs(entry: string, root: string): string[];
  findGatewayPid(input: { port: number; root: string; overridePid?: number; defaultPort?: number }): { pid?: number; source: string; candidatePid?: number };
  classifyWsFrame(raw: unknown): "hello" | "frame" | "invalid";
  wsProbeExitCode(result: Record<string, unknown>): number;
  waitWsReady(input: {
    port: number;
    wsReadyMs: number;
    WebSocketImpl: unknown;
    log?: (msg: string) => void;
    retryMs?: number;
    attemptTimeoutMs?: number;
  }): Promise<{ ok: boolean; reason?: string; hello?: boolean; legacy?: boolean; waitedMs: number; attempts: number }>;
}

const safe = requireCjs(SCRIPT) as SafeRestart;

function startFakeGateway(tasks: unknown[]): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        let m: { type?: string };
        try { m = JSON.parse(String(raw)) as { type?: string }; } catch { return; }
        if (m.type === "task.list") ws.send(JSON.stringify({ v: 1, type: "task.list", tasks }));
      });
    });
    wss.once("error", reject);
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
  });
}

/** 假网关的「不回包」变体:连上但永不回 task.list → 脚本探测超时(状态未知)。 */
function startSilentGateway(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => { ws.on("message", () => { /* 故意不回包 */ }); });
    wss.once("error", reject);
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
  });
}

/** 装配完成的假网关:连上即发一帧(缺省 hello)。 */
function startHelloGateway(frame: unknown = { v: 1, type: "hello" }): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => { ws.send(JSON.stringify(frame)); });
    wss.once("error", reject);
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => {
          for (const c of wss.clients) { try { c.terminate(); } catch { /* 已关 */ } }
          wss.close(() => r());
        }),
      });
    });
  });
}

/**
 * 「端口先就绪、装配中」的网关:任何请求(含 WS upgrade)都回 HTTP 200 且不接 upgrade,
 * ws 客户端会得到 `Unexpected server response: 200`(经验证形态)。
 */
function startHttpOnlyGateway(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const srv = createServer((sock: Socket) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("error", () => { /* 客户端断开 */ });
      let buf = "";
      sock.on("data", (d) => {
        buf += String(d);
        if (!buf.includes("\r\n\r\n")) return;
        buf = "";
        sock.write("HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok");
      });
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          srv.close(() => r());
        }),
      });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 异步 spawn(不能用 spawnSync):假网关 WS server 跑在本测试进程里,spawnSync 会阻塞事件循环,
 * 子进程的 task.list 永远等不到回包 → 探测超时变成「状态未知」。
 */
function runScript(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退 */ } }, 20_000);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    child.on("error", () => { clearTimeout(timer); resolve({ status: -1, stdout, stderr }); });
  });
}

describe("safe-restart-gateway 纯函数", () => {
  it("activeTasksOf:只留非终态,标题截断", () => {
    const active = safe.activeTasksOf([
      { id: "t1", state: "running", instruction: "x".repeat(100) },
      { id: "t2", state: "done" },
      { id: "t3", state: "queued", title: "排队任务" },
      { id: "t4", state: "failed" },
      { id: "t5", state: "blocked", title: "等输入" },
      { id: "t6", state: "cancelled" },
    ]);
    expect(active.map((t) => t.id)).toEqual(["t1", "t3", "t5"]);
    expect(active[0]!.title.length).toBe(60);
  });

  it("activeTasksOf/decideRestart:interrupted 不算活跃,单列带回且不参与截断", () => {
    const interrupted = [
      { id: "i1", state: "interrupted", title: "崩了1" },
      { id: "i2", state: "interrupted" },
      { id: "i3", state: "interrupted" },
    ];
    // 0 running + 3 interrupted → 放行(不 refuse-active)
    expect(safe.activeTasksOf(interrupted)).toEqual([]);
    const d = safe.decideRestart({ probe: { ok: true, tasks: [...interrupted, { id: "d1", state: "done" }] } });
    expect(d).toMatchObject({ action: "restart", active: [] });
    expect((d.interrupted as unknown[]).length).toBe(3);
    // 1 running + 2 interrupted → 拒绝,清单只含 running
    const mixed = safe.decideRestart({ probe: { ok: true, tasks: [{ id: "r1", state: "running" }, ...interrupted] } });
    expect(mixed.action).toBe("refuse-active");
    expect((mixed.active as Array<{ id: string }>).map((t) => t.id)).toEqual(["r1"]);
    expect((mixed.interrupted as unknown[]).length).toBe(3);
  });

  it("decideRestart:活跃任务非 force 拒绝;force 放行并标记;连接拒绝=网关本就不在", () => {
    const running = { ok: true, tasks: [{ id: "a", state: "running" }] };
    expect(safe.decideRestart({ probe: running })).toMatchObject({ action: "refuse-active" });
    expect(safe.decideRestart({ probe: running, force: true })).toMatchObject({ action: "restart", forced: true });
    expect(safe.decideRestart({ probe: { ok: true, tasks: [{ id: "b", state: "done" }] } })).toMatchObject({ action: "restart", active: [] });
    expect(safe.decideRestart({ probe: { ok: false, reason: "connect", code: "ECONNREFUSED" } })).toMatchObject({ action: "restart", gatewayDown: true });
    // 探测超时 = 状态未知:不 force 必须拒绝(不静默杀)
    expect(safe.decideRestart({ probe: { ok: false, reason: "timeout" } })).toMatchObject({ action: "refuse-unknown" });
    expect(safe.decideRestart({ probe: { ok: false, reason: "timeout" }, force: true })).toMatchObject({ action: "restart", unknownProbe: true });
  });

  it("readLockPid:兼容 JSON 与旧纯数字;损坏返回 undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-"));
    try {
      const p = join(dir, "gateway.lock");
      writeFileSync(p, JSON.stringify({ pid: 4321, start: "9" }), "utf8");
      expect(safe.readLockPid(p)).toBe(4321);
      writeFileSync(p, "1234", "utf8");
      expect(safe.readLockPid(p)).toBe(1234);
      writeFileSync(p, "{oops", "utf8");
      expect(safe.readLockPid(p)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("findGatewayPid:端口属主不是网关 → candidatePid,绝不返回可杀 pid", async () => {
    // 用本测试进程起一个普通 HTTP(非 WS/非网关)端口,模拟「7700 被别的程序占了」。
    const srv = createServer((req, res) => res.end("ok"));
    await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(0, "127.0.0.1", () => resolve()); });
    try {
      const port = (srv.address() as AddressInfo).port;
      const hasSs = !spawnSync("ss", ["-tln"], { encoding: "utf8" }).error;
      if (!hasSs) return; // 无 ss 的机器走 pid 文件/pgrep 分支,本断言不适用
      const found = safe.findGatewayPid({ port, root: join(tmpdir(), "no-such-root"), defaultPort: 7700 });
      expect(found.pid).toBeUndefined();
      expect(found.source).toBe("ss-unverified");
      expect(found.candidatePid).toBe(process.pid);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("gatewaySpawnArgs:OOM 堆取证参数齐全且 entry 在最后(不被当 node 开关)", () => {
    const root = "/repo";
    const entry = join(root, "apps", "gateway", "dist", "gateway.mjs");
    const args = safe.gatewaySpawnArgs(entry, root);
    expect(args).toContain("--max-old-space-size=6144");
    expect(args).toContain("--report-on-fatalerror");
    expect(args).toContain(`--diagnostic-dir=${join(root, ".genie", "heap-reports")}`);
    expect(args[args.length - 1]).toBe(entry);
    // 所有 -- 开关必须在 entry 之前,否则 node 会把它们当脚本参数丢弃。
    const firstNonFlag = args.findIndex((a) => !a.startsWith("--"));
    expect(args.slice(firstNonFlag)).toEqual([entry]);
  });

  it("parseArgs:缺省 7700 由 config 决定(此处只校验显式参数与错误分支)", () => {
    const o = safe.parseArgs(["--port", "7812", "--force", "--dry-run", "--pid", "9", "--ws-ready-ms", "1234"]);
    expect(o.port).toBe(7812);
    expect(o.force).toBe(true);
    expect(o.dryRun).toBe(true);
    expect(o.pid).toBe(9);
    expect(o.wsReadyMs).toBe(1234);
 // 9p 缓存冷启动 journal 722495 行/314832ms,180s 不够 → 缺省 300000。
    expect((safe.parseArgs([]) as { wsReadyMs: number }).wsReadyMs).toBe(300000);
    expect(() => safe.parseArgs(["--port", "abc"])).toThrow();
    expect(() => safe.parseArgs(["--ws-ready-ms", "0"])).toThrow();
    expect(() => safe.parseArgs(["--nope"])).toThrow();
  });
});

describe("safe-restart-gateway WS 就绪探针(HTTP 200 之后)", () => {
  it("classifyWsFrame:hello / 其他合法帧 / 坏 JSON", () => {
    expect(safe.classifyWsFrame('{"v":1,"type":"hello"}')).toBe("hello");
    expect(safe.classifyWsFrame('{"v":1,"type":"error","code":"boom"}')).toBe("frame");
    expect(safe.classifyWsFrame('{"v":1,"type":"session.status.changed"}')).toBe("frame");
    expect(safe.classifyWsFrame("not json")).toBe("invalid");
    expect(safe.classifyWsFrame("[]")).toBe("invalid");
    expect(safe.classifyWsFrame("null")).toBe("invalid");
  });

  it("wsProbeExitCode:就绪 0,未就绪 5(超时 / upgrade 被 200 拒 / 空结果)", () => {
    expect(safe.wsProbeExitCode({ ok: true, hello: true })).toBe(0);
    expect(safe.wsProbeExitCode({ ok: true, legacy: true })).toBe(0);
    expect(safe.wsProbeExitCode({ ok: false, reason: "no-frame" })).toBe(safe.EXIT.startFailed);
    expect(safe.wsProbeExitCode({ ok: false, reason: "upgrade-rejected" })).toBe(safe.EXIT.startFailed);
    expect(safe.wsProbeExitCode({})).toBe(safe.EXIT.startFailed);
  });

  it("装配完成的网关(连上发 hello)→ 探针成功且识别为 hello", async () => {
    const gw = await startHelloGateway();
    try {
      const r = await safe.waitWsReady({ port: gw.port, wsReadyMs: 3000, WebSocketImpl: WebSocket, retryMs: 100, attemptTimeoutMs: 800 });
      expect(r.ok).toBe(true);
      expect(r.hello).toBe(true);
      expect(safe.wsProbeExitCode(r)).toBe(safe.EXIT.ok);
    } finally {
      await gw.close();
    }
  });

  it("老协议网关(无 hello,只回 error 帧)也视为可交互", async () => {
    const gw = await startHelloGateway({ v: 0, type: "error", code: "unknown-type" });
    try {
      const r = await safe.waitWsReady({ port: gw.port, wsReadyMs: 3000, WebSocketImpl: WebSocket, retryMs: 100, attemptTimeoutMs: 800 });
      expect(r.ok).toBe(true);
      expect(r.legacy).toBe(true);
      expect(safe.wsProbeExitCode(r)).toBe(safe.EXIT.ok);
    } finally {
      await gw.close();
    }
  });

  it("HTTP 200 但 upgrade 被拒(仍在装配)→ 短超时后未就绪,退出码 5", async () => {
    const gw = await startHttpOnlyGateway();
    try {
      const r = await safe.waitWsReady({ port: gw.port, wsReadyMs: 1200, WebSocketImpl: WebSocket, retryMs: 200, attemptTimeoutMs: 600 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("upgrade-rejected");
      expect(r.attempts).toBeGreaterThan(1); // 未就绪是「重试到超时」,不是一次失手就判死
      expect(safe.wsProbeExitCode(r)).toBe(safe.EXIT.startFailed);
    } finally {
      await gw.close();
    }
  });

  it("WS 连得上但一直不发言 → 未就绪(no-frame),退出码 5", async () => {
    const silent = await startSilentGateway();
    try {
      const r = await safe.waitWsReady({ port: silent.port, wsReadyMs: 900, WebSocketImpl: WebSocket, retryMs: 100, attemptTimeoutMs: 300 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("no-frame");
      expect(safe.wsProbeExitCode(r)).toBe(safe.EXIT.startFailed);
    } finally {
      await silent.close();
    }
  });
});

describe("safe-restart-gateway 子进程(只跑只读/拒绝路径)", () => {
  it("有活跃任务且无 --force → 退出码 2 + 打印任务清单(不杀进程)", async () => {
    const fake = await startFakeGateway([{ id: "task-live", state: "running", instruction: "正在改代码" }]);
    try {
      const r = await runScript(["--port", String(fake.port), "--timeout-ms", "3000"]);
      expect(r.status).toBe(safe.EXIT.activeTasks);
      expect(r.stderr).toContain("拒绝重启");
      expect(r.stderr).toContain("task-live");
      expect(r.stderr).toContain("正在改代码");
    } finally {
      await fake.close();
    }
  });

  it("3 条 interrupted + 0 活跃 → 放行(dry-run 0,打印历史中断记录)", async () => {
    const fake = await startFakeGateway([
      { id: "int-1", state: "interrupted", title: "旧任务1" },
      { id: "int-2", state: "interrupted", title: "旧任务2" },
      { id: "int-3", state: "interrupted", title: "旧任务3" },
    ]);
    try {
      const r = await runScript(["--port", String(fake.port), "--dry-run", "--pid", "999999999", "--timeout-ms", "3000"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("另有 3 条 interrupted 历史记录(不阻断)");
      expect(r.stdout).toContain("dry-run:将停止");
      expect(r.stderr).not.toContain("拒绝重启");
    } finally {
      await fake.close();
    }
  });

  it("1 running + 2 interrupted → 退出码 2,清单只含 running", async () => {
    const fake = await startFakeGateway([
      { id: "task-live", state: "running", title: "正在改代码" },
      { id: "int-1", state: "interrupted", title: "旧任务1" },
      { id: "int-2", state: "interrupted", title: "旧任务2" },
    ]);
    try {
      const r = await runScript(["--port", String(fake.port), "--timeout-ms", "3000"]);
      expect(r.status).toBe(safe.EXIT.activeTasks);
      expect(r.stderr).toContain("拒绝重启:1 个活跃任务");
      expect(r.stderr).toContain("task-live");
      expect(r.stderr).not.toContain("int-1");
      expect(r.stderr).not.toContain("int-2");
    } finally {
      await fake.close();
    }
  });

  it("0 任务 → 放行(不打印 interrupted)", async () => {
    const fake = await startFakeGateway([]);
    try {
      const r = await runScript(["--port", String(fake.port), "--dry-run", "--pid", "999999999", "--timeout-ms", "3000"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("dry-run:将停止");
      expect(r.stdout).not.toContain("interrupted");
    } finally {
      await fake.close();
    }
  });

  it("探测超时(状态未知)→ 退出码 3 不变", async () => {
    const silent = await startSilentGateway();
    try {
      const r = await runScript(["--port", String(silent.port), "--timeout-ms", "800"]);
      expect(r.status).toBe(safe.EXIT.unknown);
      expect(r.stderr).toContain("拒绝重启");
    } finally {
      await silent.close();
    }
  });

  it("有活跃任务 + --force --dry-run → 0,dry-run 不杀不起", async () => {
    const fake = await startFakeGateway([{ id: "task-live", state: "blocked", title: "等审批" }]);
    try {
      const r = await runScript(["--port", String(fake.port), "--force", "--dry-run", "--pid", "999999999", "--timeout-ms", "3000"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("忽略 1 个活跃任务");
      expect(r.stdout).toContain("dry-run:将停止");
    } finally {
      await fake.close();
    }
  });

  it("网关未在听(ECONNREFUSED)且 --dry-run → 0,提示直接启动", async () => {
    const port = await freePort();
    const r = await runScript(["--port", String(port), "--dry-run", "--pid", "999999999", "--timeout-ms", "1500"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("网关未在听");
  });

  it("--help 输出用法且 0(含 --ws-ready-ms)", async () => {
    const r = await runScript(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("safe-restart-gateway.cjs");
    expect(r.stdout).toContain("--ws-ready-ms");
  });
});
