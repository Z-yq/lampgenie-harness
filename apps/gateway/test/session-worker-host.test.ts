/**
 * 会话 worker host 协议测试(设计参考 ZCode(致谢):一会话一进程):fork 桩 worker(test/fixtures/
 * session-worker-stub.mjs)走真 IPC——ready/journal 上行(权威 seq 重分配)/task.state 回写/
 * 子代理镜像/cancel 下发/RPC 应答(journal.readSession)。
 * 真实栈(LLM)端到端不在 vitest 跑(worker 装配读真实配置);host↔worker 协议面在此钉死。
 */
import { describe, it, expect, afterEach } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryJournal } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";
import { createSessionWorkerHost, sweepOrphanSessionWorkers, type SessionWorkerHost } from "../src/session-worker-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, "fixtures", "session-worker-stub.mjs");

interface MirrorEntry { outputFile: string; status: string; sessionId: string; title?: string; model?: string; lastEventAt?: number; cancel?: () => unknown; spawnedAt?: number; deadlineAt?: number; ownerTask?: string }

function setup(mode: string, opts?: { readProcForensics?: (pid: number | undefined) => { state: string; wchan: string; dThreads: number; threads: number } | null }) {
  process.env.STUB_MODE = mode;
  const journal = new MemoryJournal();
  // 预置一条会话旧事件(rpc 场景的种子)
  journal.append({ kind: "message.user", sessionId: "s-w1", payload: { text: "seed" } });
  const tm = new TaskSupervisor();
  const mirror = new Map<string, MirrorEntry>();
  const streams: { sessionId: string; ev: unknown }[] = [];
  const host: SessionWorkerHost = createSessionWorkerHost({
    taskManager: tm,
    journal,
    mcp: undefined,
    streamSink: (sessionId, ev) => streams.push({ sessionId, ev }),
    bgAgentsMirror: mirror,
    repoRoot: mkdtempSync(join(tmpdir(), "swh-")),
    browserConfig: { enabled: () => false, allowDomains: () => [] },
    setState: (task, to, result) => tm.setState(task, to, result),
    workerEntry: STUB,
    ...(opts?.readProcForensics ? { readProcForensics: opts.readProcForensics } : {}),
  });
  return { journal, tm, mirror, streams, host };
}

afterEach(() => { delete process.env.STUB_MODE; });

describe("ProjectRegistry.restore(P0:worker 项目快照同源)", () => {
  it("快照合入(按 realpath 去重)+activeId 生效;resolveWorkdir 命中注入项目", () => {
    const reg = new ProjectRegistry("/tmp", null);
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    reg.restore([{ id: "p-x", path: dir, label: "注入项目", availability: "available", addedAt: Date.now() }], "p-x");
    expect(reg.resolveWorkdir("p-x")).toBe(dir);
    expect(reg.resolveWorkdir("p-missing")).toBe("/tmp"); // 未注册回落 harness 根(语义不变)
    expect(reg.activeId()).toBe("p-x");
    // 同 path 二次注入=去重不双入
    reg.restore([{ id: "p-x2", path: dir, label: "重复路径", availability: "available", addedAt: Date.now() }]);
    expect(reg.list().filter((x: { path: string }) => x.path === dir)).toHaveLength(1);
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms = 8000, step = 50): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await wait(step); }
  return pred();
};

describe("session-worker host 协议(stub worker 真 IPC)", () => {
  it("happy:ready→journal 上行(权威 seq 重分配)→镜像→task.state done 回写 TaskSupervisor", async () => {
    const { journal, tm, mirror, host } = setup("happy");
    const task = tm.submit("user", "s-w1", "桩任务");
    host.dispatch(task);
    expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "done")).toBe(true);
    // journal 权威落账:stub 上行事件已入(且 gateway 分配权威 seq)
    const evs = journal.readSession("s-w1");
    expect(evs.some((e) => (e.payload as { text?: string }).text === "stub-hello")).toBe(true);
    expect(evs.every((e) => typeof e.seq === "number")).toBe(true);
    // 子代理镜像入注册表(带 cancel 通道)
    expect(mirror.get("agent_stub1")?.status).toBe("running");
    expect(typeof mirror.get("agent_stub1")?.cancel).toBe("function");
    expect(await waitUntil(() => host.activeCount === 0)).toBe(true); // 终态后 run 回收(等 stub 退出)
    // ghost 防治(三轮复审 ②):stub 留下 running 镜像条目退出 → host 就地翻 failed+落死讯
    await waitUntil(() => mirror.get("agent_stub1")?.status === "failed");
    expect(mirror.get("agent_stub1")?.status).toBe("failed");
    expect(journal.readSession("s-w1").some((e) => e.kind === "subagent.result" && (e.payload as { reap?: { reason?: string } }).reap?.reason === "worker-exit")).toBe(true);
  }, 15_000);

  it("worker 退出后调用镜像 cancel 不产生 IPC uncaught(2026-10-25 大并发挂任务根因)", async () => {
    const { tm, mirror, host } = setup("happy");
    const task = tm.submit("user", "s-w1", "cancel-after-exit");
    host.dispatch(task);
    expect(await waitUntil(() => !!mirror.get("agent_stub1"))).toBe(true);
    const staleCancel = mirror.get("agent_stub1")!.cancel!;
    expect(await waitUntil(() => host.activeCount === 0)).toBe(true); // worker 已退出,IPC 已断
    const errors: unknown[] = [];
    const onErr = (e: unknown) => { errors.push(e); };
    process.on("uncaughtException", onErr);
    try { staleCancel(); await wait(150); } finally { process.off("uncaughtException", onErr); }
    // 旧实现 child.send 在断开通道上异步 emit ERR_IPC_CHANNEL_CLOSED,没有 child error 监听器=uncaught;
    // 修复后 connected 判定 + send 回调 + child error 监听三处兜底,这里必须零异常。
    expect(errors).toHaveLength(0);
  }, 15_000);

  it("rpc:worker 请求 journal.readSession → host 应答会话事件(stub 校验种子回包)", async () => {
    const { journal, tm, host } = setup("rpc");
    const task = tm.submit("user", "s-w1", "rpc 任务");
    host.dispatch(task);
    expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "done")).toBe(true);
    const evs = journal.readSession("s-w1");
    expect(evs.some((e) => (e.payload as { text?: string }).text === "rpc 回包事件数=1")).toBe(true);
  }, 15_000);

  it("终态落盘对账(2026-10-29):uplink 丢失(worker 交稿后不发 task.state 即退)→ exit 收割回读落盘按 done 记账", async () => {
    const { journal, tm, host } = setup("durable");
    const task = tm.submit("user", "s-w1", "落盘对账桩");
    host.dispatch(task);
    // 期望终态=done(来自 terminal.json),而非「会话 worker 异常退出」
    expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "done", 10_000)).toBe(true);
    const t = tm.list().find((x) => x.id === task.id)!;
    expect(String(t.result ?? "")).toContain("durable 交稿");
    expect(String(t.result ?? "")).not.toContain("异常退出");
    expect(journal.readSession("s-w1").some((e) => (e.payload as { text?: string }).text === "durable-stub-work")).toBe(true);
    expect(await waitUntil(() => host.activeCount === 0)).toBe(true);
  }, 15_000);

  it("冻结探针(2026-10-29):worker 静默超阈值 → 任务 failed(worker.freeze)+镜像子代理死讯+run 回收", async () => {
    process.env.GENIE_SESSION_WORKER_FREEZE_MS = "1200";
    process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS = "500";
    try {
      const { journal, tm, mirror, host } = setup("freeze");
      const task = tm.submit("user", "s-w1", "冻结桩");
      host.dispatch(task);
      // 静默 1.2s 阈值 + 扫描周期(5s 下限)→ 6s 内必须收割
      expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "failed", 10_000)).toBe(true);
      const t = tm.list().find((x) => x.id === task.id)!;
      expect(String(t.result ?? "")).toContain("事件循环冻结");
      // 审计事件 + 子代理死讯(reason=worker-freeze)
      expect(journal.readSession("s-w1").some((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "worker.freeze")).toBe(true);
      expect(await waitUntil(() => mirror.get("agent_stub_frz")?.status === "failed")).toBe(true);
      expect(journal.readSession("s-w1").some((e) => e.kind === "subagent.result" && (e.payload as { reap?: { reason?: string } }).reap?.reason === "worker-freeze")).toBe(true);
      expect(await waitUntil(() => host.activeCount === 0)).toBe(true);
    } finally {
      delete process.env.GENIE_SESSION_WORKER_FREEZE_MS;
      delete process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS;
    }
  }, 20_000);

  it("D 态耐心(2026-11-01):静默但主线程 D(盘等待)→ 不杀+worker.disk-wait 留痕;恢复 R 态才按法证杀", async () => {
    process.env.GENIE_SESSION_WORKER_FREEZE_MS = "1200";
    process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS = "500";
    let fakeState = "D";
    const forensics = (pid: number | undefined) => (pid ? { state: fakeState, wchan: "v9fs_req", dThreads: 1, threads: 12 } : null);
    try {
      const { journal, tm, host } = setup("freeze", { readProcForensics: forensics });
      const task = tm.submit("user", "s-w1", "盘等待桩");
      host.dispatch(task);
      await wait(5000); // 跨过 1.2s 阈值 + 两个扫描周期
      const still = tm.list().find((t) => t.id === task.id);
      expect(still?.state).toBe("running"); // D 态=盘等待可自愈,不误杀
      expect(journal.readSession("s-w1").some((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "worker.disk-wait")).toBe(true);
      // 停顿「解除后仍死」(状态翻 R=用户态卡死)→ 按法证收割
      fakeState = "R";
      expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "failed", 10_000)).toBe(true);
      const t = tm.list().find((x) => x.id === task.id)!;
      expect(String(t.result ?? "")).toContain("R 态");
      expect(String(t.result ?? "")).toContain("v9fs_req"); // wchan 进回执=死因可查
      expect(journal.readSession("s-w1").some((e) => e.kind === "custom" && (e.payload as { type?: string; forensics?: unknown }).type === "worker.freeze" && !!(e.payload as { forensics?: unknown }).forensics)).toBe(true);
    } finally {
      delete process.env.GENIE_SESSION_WORKER_FREEZE_MS;
      delete process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS;
    }
  }, 20_000);

  it("D 态耐心硬顶:持续 D 超过 diskWaitMs → 照杀(永久楔死的 9p 形态),话术点名盘 IO", async () => {
    process.env.GENIE_SESSION_WORKER_FREEZE_MS = "1000";
    process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS = "500";
    process.env.GENIE_SESSION_WORKER_DISK_WAIT_MS = "2500";
    try {
      const { journal, tm, host } = setup("freeze", { readProcForensics: () => ({ state: "D", wchan: "v9fs_rpc", dThreads: 2, threads: 12 }) });
      const task = tm.submit("user", "s-w1", "永久楔死桩");
      host.dispatch(task);
      expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "failed", 15_000)).toBe(true);
      const t = tm.list().find((x) => x.id === task.id)!;
      expect(String(t.result ?? "")).toContain("D 态");
      expect(String(t.result ?? "")).toContain("磁盘 IO");
    } finally {
      delete process.env.GENIE_SESSION_WORKER_FREEZE_MS;
      delete process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS;
      delete process.env.GENIE_SESSION_WORKER_DISK_WAIT_MS;
    }
  }, 20_000);

  it("冻结探针不误伤:心跳照发的健康 worker 超阈值仍在跑,取消正常收场", async () => {
    process.env.GENIE_SESSION_WORKER_FREEZE_MS = "1200";
    process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS = "500";
    try {
      const { tm, host } = setup("hb");
      const task = tm.submit("user", "s-w1", "心跳桩");
      host.dispatch(task);
      await wait(7000); // 跨过阈值+一个扫描周期
      expect(tm.list().find((t) => t.id === task.id)?.state).toBe("running"); // 心跳活着=不误杀
      host.cancelTask(task.id);
      expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "cancelled")).toBe(true);
    } finally {
      delete process.env.GENIE_SESSION_WORKER_FREEZE_MS;
      delete process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS;
    }
  }, 20_000);

  it("冻结探针关闭(GENIE_SESSION_WORKER_FREEZE_MS=0):静默 worker 不被收割(旧行为)", async () => {
    process.env.GENIE_SESSION_WORKER_FREEZE_MS = "0";
    try {
      const { tm, host } = setup("freeze");
      const task = tm.submit("user", "s-w1", "冻结桩-关闭");
      host.dispatch(task);
      await wait(6500);
      expect(tm.list().find((t) => t.id === task.id)?.state).toBe("running");
      host.cancelTask(task.id);
      await wait(1500);
    } finally {
      delete process.env.GENIE_SESSION_WORKER_FREEZE_MS;
      delete process.env.GENIE_SESSION_WORKER_FREEZE_SCAN_MS;
    }
  }, 20_000);

  it("孤儿 spec 清扫(四轮复审 R4-3):>2h 残留删除,新鲜保留", () => {
    process.env.STUB_MODE = "happy";
    const root = mkdtempSync(join(tmpdir(), "swh-sweep-"));
    const dir = join(root, ".genie", "session-workers");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, "stale.json");
    const fresh = join(dir, "fresh.json");
    writeFileSync(stale, "{}", "utf-8");
    writeFileSync(fresh, "{}", "utf-8");
    const oldTime = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(stale, oldTime, oldTime);
    createSessionWorkerHost({
      taskManager: new TaskSupervisor(),
      journal: new MemoryJournal(),
      streamSink: () => {},
      bgAgentsMirror: new Map(),
      repoRoot: root,
      browserConfig: { enabled: () => false, allowDomains: () => [] },
      setState: (task, to, result) => new TaskSupervisor().setState(task, to, result),
      workerEntry: STUB,
    });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    delete process.env.STUB_MODE;
  });

  it("badversion:协议版本不匹配 fail-visible(任务显式失败,不静默错译)", async () => {
    const { tm, host } = setup("badversion");
    const task = tm.submit("user", "s-w1", "版本任务");
    host.dispatch(task);
    expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "failed")).toBe(true);
    const t = tm.list().find((x) => x.id === task.id)!;
    expect(String(t.result)).toContain("协议版本不匹配");
    await waitUntil(() => host.activeCount === 0);
  }, 15_000);

  it("list(F5-3):dispatch 后清单含 pid/会话/时刻,退出即清空", async () => {
    const { tm, host } = setup("cancel"); // cancel 模式常驻,窗口稳定
    const task = tm.submit("user", "s-w1", "清单任务");
    host.dispatch(task);
    expect(await waitUntil(() => host.list().some((w) => w.taskId === task.id && typeof w.pid === "number" && w.ready))).toBe(true);
    const row = host.list().find((w) => w.taskId === task.id)!;
    expect(row.sessionId).toBe("s-w1");
    expect(row.startedAt).toBeGreaterThan(0);
    expect(row.lastEventAt).toBeGreaterThan(0);
    host.cancelTask(task.id);
    expect(await waitUntil(() => host.list().length === 0)).toBe(true);
  }, 15_000);

  it("孤儿清扫(F5-3):活父进程的标记进程不碰(保守);死 pid 的 .run.json 登记残骸清走", async () => {
    // ①保守性:父进程(本测试进程)活着的 session-worker 形进程一律不杀
    const { spawn } = await import("node:child_process");
    const marker = spawn("node", ["-e", "/* session-worker stub */ setInterval(() => {}, 1 << 30);"], { stdio: "ignore" });
    await wait(300); // /proc 就位
    const res = sweepOrphanSessionWorkers(process.pid);
    expect(res.killed).toBe(0); // ppid=测试进程(活)≠孤儿
    let alive = true;
    try { process.kill(marker.pid as number, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    try { marker.kill("SIGKILL"); } catch { /* 已退 */ }
    // ②登记残骸:死 pid 的 .run.json 在 host 创建时被清,活 pid 的保留
    const root = mkdtempSync(join(tmpdir(), "swh-run-"));
    const dir = join(root, ".genie", "session-workers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dead.run.json"), JSON.stringify({ pid: 999999999 }), "utf-8");
    writeFileSync(join(dir, "live.run.json"), JSON.stringify({ pid: process.pid }), "utf-8");
    process.env.STUB_MODE = "happy";
    createSessionWorkerHost({
      taskManager: new TaskSupervisor(), journal: new MemoryJournal(), streamSink: () => {}, bgAgentsMirror: new Map(),
      repoRoot: root, browserConfig: { enabled: () => false, allowDomains: () => [] },
      setState: (t2, to, r) => new TaskSupervisor().setState(t2, to, r), workerEntry: STUB,
    });
    expect(existsSync(join(dir, "dead.run.json"))).toBe(false);
    expect(existsSync(join(dir, "live.run.json"))).toBe(true);
    delete process.env.STUB_MODE;
  }, 15_000);

  it("跨 run 保护(五轮复审 F5-1):同会话 worker A 退出不误杀 worker B 的子代理镜像", async () => {
    // A=cancel 模式(常驻等取消,不发镜像);B=happy 模式持留 3s(发镜像 agent_stub1)。
    const { tm, mirror, host } = setup("cancel");
    const tA = tm.submit("user", "s-w1", "A 任务");
    host.dispatch(tA);
    expect(await waitUntil(() => host.activeCount === 1)).toBe(true);
    process.env.STUB_MODE = "happy";
    process.env.STUB_HOLD_MS = "3000";
    const tB = tm.submit("user", "s-w1", "B 任务");
    host.dispatch(tB);
    expect(await waitUntil(() => mirror.get("agent_stub1")?.ownerTask === tB.id)).toBe(true); // 镜像盖的是 B 的章
    host.cancelTask(tA.id); // A 退出
    expect(await waitUntil(() => host.activeCount === 1)).toBe(true);
    await wait(300);
    expect(mirror.get("agent_stub1")?.status).toBe("running"); // A 的退出没碰 B 的条目
    expect(mirror.get("agent_stub1")?.ownerTask).toBe(tB.id);
    host.cancelTask(tB.id); // B 自己退出才清自己的
    expect(await waitUntil(() => host.activeCount === 0)).toBe(true);
    expect(await waitUntil(() => mirror.get("agent_stub1")?.status === "failed")).toBe(true);
    delete process.env.STUB_HOLD_MS;
  }, 20_000);

  it("cancel:host.cancelTask 下发 → stub 回 cancelled → gateway 状态机同步", async () => {
    const { tm, host } = setup("cancel");
    const task = tm.submit("user", "s-w1", "取消任务");
    host.dispatch(task);
    await waitUntil(() => host.activeCount === 1 || tm.list().find((t) => t.id === task.id)?.state === "cancelled");
    host.cancelTask(task.id);
    expect(await waitUntil(() => tm.list().find((t) => t.id === task.id)?.state === "cancelled")).toBe(true);
    await waitUntil(() => host.activeCount === 0);
  }, 15_000);
});

/** m3(第三条路径):host 下发 spec 前按「该任务会话的模型覆盖」重算 contextWindow,
 * 覆盖不到/无元数据时回退 deps.contextWindow(启动时定值,旧行为零变化)。 */
describe("m3 contextWindow 随会话模型重算(host → spec 下发)", () => {
  it("有覆盖且模型有窗口元数据 → spec 用会话窗口;无覆盖 → 回退 deps.contextWindow", async () => {
    const root = mkdtempSync(join(tmpdir(), "swh-ctx-"));
    mkdirSync(join(root, ".genie"), { recursive: true });
    // 覆盖表:会话 s-w1 选了 bigmodel 端点的 GLM-5.3(窗口 200000)
    writeFileSync(join(root, ".genie", "session-models.json"), JSON.stringify({
      "s-w1": { model: "GLM-5.3", providerId: "bigmodel-plan", revision: 1, updatedAt: Date.now() },
    }), "utf-8");
    // 全局配置:同名模型在两个端点窗口不同(证明按会话选中的 Provider 精确取)
    writeFileSync(join(root, "genie.config.json"), JSON.stringify({
      providers: [
        {
          id: "main", name: "主端点", baseUrl: "https://aliyun.example/compatible-mode",
          apiKeyEnv: "GENIE_LLM_API_KEY",
          models: [{ name: "GLM-5.3", contextWindow: 32768 }],
        },
        {
          id: "bigmodel-plan", name: "智谱套餐", baseUrl: "https://open.bigmodel.cn/api/anthropic",
          apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", apiType: "anthropic",
          models: [{ name: "GLM-5.3", contextWindow: 200000 }],
        },
      ],
      coding: {
        llm: { providerId: "main", baseUrl: "https://aliyun.example/compatible-mode", apiKeyEnv: "GENIE_LLM_API_KEY", model: "GLM-5.3" },
      },
    }), "utf-8");
    process.env.STUB_MODE = "cancel"; // 常驻等取消:spec 文件留在盘上可读
    const tm = new TaskSupervisor();
    const host = createSessionWorkerHost({
      taskManager: tm,
      journal: new MemoryJournal(),
      streamSink: () => {},
      bgAgentsMirror: new Map(),
      repoRoot: root,
      browserConfig: { enabled: () => false, allowDomains: () => [] },
      setState: (t, to, r) => tm.setState(t, to, r),
      workerEntry: STUB,
      contextWindow: 111_111, // 启动时定值(全局 coding.llm 算出来的那个)
    });
    const spec = (taskId: string) => JSON.parse(readFileSync(join(root, ".genie", "session-workers", `${taskId}.json`), "utf-8")) as { contextWindow?: number };

    const t1 = tm.submit("user", "s-w1", "覆盖会话任务");
    host.dispatch(t1);
    const f1 = join(root, ".genie", "session-workers", `${t1.id}.json`);
    expect(await waitUntil(() => existsSync(f1))).toBe(true);
    expect(spec(t1.id).contextWindow).toBe(200000); // 会话窗口,而非启动定值/主端点窗口

    const t2 = tm.submit("user", "s-none", "无覆盖任务");
    host.dispatch(t2);
    const f2 = join(root, ".genie", "session-workers", `${t2.id}.json`);
    expect(await waitUntil(() => existsSync(f2))).toBe(true);
    expect(spec(t2.id).contextWindow).toBe(111_111); // 无覆盖 → 回退注入定值

    host.cancelTask(t1.id);
    host.cancelTask(t2.id);
    expect(await waitUntil(() => host.activeCount === 0)).toBe(true);
  }, 20_000);
});
