/**
 * step-035 添加项目(ZCode workspace 移植):注册表单元+WS e2e+面板冒烟。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { ProjectRegistry, HARNESS_PROJECT_ID, cleanupProjectTaskRefs } from "../src/projects.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectProfileIndex } from "../src/project-profile.js";
import { MemoryJournal } from "@lampgenie/core";
import type { QueueItem } from "@lampgenie/protocol";
import { wireExecutor } from "../src/executor-wiring.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: GatewayApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket, type: string, ms = 5000, after = 0): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const matches = inbox.filter((m) => m.type === type);
      if (matches.length > after) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(matches[after]!);
      } else if (Date.now() - t0 > ms) {
        clearTimeout(timer);
        clearInterval(poll);
        reject(new Error(`等待第 ${after + 1} 条 ${type} 超时(现${matches.length})`));
      }
    }, 20);
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), ms);
  });
}

describe("ProjectRegistry 单元", () => {
  const dir = mkdtempSync(join(tmpdir(), "projreg-"));
  const harnessRoot = join(dir, "harness");
  mkdirSync(harnessRoot);

  it("D1 校验面:绝对路径/存在/目录;harness 本体永在且幂等", () => {
    const reg = new ProjectRegistry(harnessRoot, join(dir, "p1.json"));
    expect(reg.list().map((p) => p.id)).toContain(HARNESS_PROJECT_ID);
    expect(reg.add("")).toMatchObject({ ok: false });
    expect(reg.add("relative/path")).toMatchObject({ ok: false, reason: expect.stringContaining("绝对路径") });
    expect(reg.add(join(dir, "nope"))).toMatchObject({ ok: false, reason: expect.stringContaining("不存在") });
    const file = join(dir, "afile.txt");
    writeFileSync(file, "x");
    expect(reg.add(file)).toMatchObject({ ok: false, reason: expect.stringContaining("不是目录") });
    // harness 根=幂等返回本体项目。
    const self = reg.add(harnessRoot);
    expect(self.ok && self.project.id).toBe(HARNESS_PROJECT_ID);
  });

  it("D1 去重+D3 持久化+可用性:realpath 去重;新实例重载;目录删除=unavailable", () => {
    const projDir = join(dir, "myapp");
    mkdirSync(projDir);
    const file1 = join(dir, "p2.json");
    const reg = new ProjectRegistry(harnessRoot, file1);
    const a = reg.add(projDir);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // 同目录(含 .. 变体)再次添加=幂等。
    const dup = reg.add(join(projDir, "..", "myapp"));
    expect(dup.ok && dup.project.id).toBe(a.project.id);
    reg.activate(a.project.id);
    // 新实例(重启语义):持久化重载+启动期可用性校验。
    const reg2 = new ProjectRegistry(harnessRoot, file1);
    expect(reg2.list().some((p) => p.id === a.project.id)).toBe(true);
    expect(reg2.activeId()).toBe(a.project.id);
    // 目录删除→新实例校验为 unavailable;workdir 回退 harness。
    rmSync(projDir, { recursive: true, force: true });
    const reg3 = new ProjectRegistry(harnessRoot, file1);
    const reloaded = reg3.list().find((p) => p.id === a.project.id)!;
    expect(reloaded.availability).toBe("unavailable-local-directory");
    expect(reg3.resolveWorkdir(a.project.id)).toBe(harnessRoot);
  });

  it("D4 移除:harness 本体拒删;移除后激活回退本体;解析回退", () => {
    const projDir = join(dir, "app2");
    mkdirSync(projDir);
    const reg = new ProjectRegistry(harnessRoot, join(dir, "p3.json"));
    expect(reg.remove(HARNESS_PROJECT_ID).ok).toBe(false);
    const a = reg.add(projDir);
    if (!a.ok) throw new Error("add failed");
    reg.activate(a.project.id);
    expect(reg.has(a.project.id)).toBe(true);
    expect(reg.has(HARNESS_PROJECT_ID)).toBe(true);
    expect(reg.remove(a.project.id).ok).toBe(true);
    expect(reg.has(a.project.id)).toBe(false);
    expect(reg.activeId()).toBe(HARNESS_PROJECT_ID);
    expect(reg.resolveWorkdir(a.project.id)).toBe(harnessRoot);
  });

  it("step-056 重命名:显示名持久化;空名/未知项目拒;path 不动", () => {
    const projDir = join(dir, "app3");
    mkdirSync(projDir);
    const file = join(dir, "p4.json");
    const reg = new ProjectRegistry(harnessRoot, file);
    const a = reg.add(projDir);
    if (!a.ok) throw new Error("add failed");
    expect(reg.rename(a.project.id, "  我的应用  ").ok).toBe(true);
    expect(reg.rename(a.project.id, "   ").ok).toBe(false);
    expect(reg.rename("no-such-id", "x").ok).toBe(false);
    const reloaded = new ProjectRegistry(harnessRoot, file);
    const again = reloaded.list().find((p) => p.id === a.project.id);
    expect(again?.label).toBe("我的应用");
    expect(again?.path).toBe(a.project.path);
  });
});

describe("已移除项目·关联引用清理(2026-10-14 残留根治)", () => {
  it("clearProjectRef:清指定项目引用;updatedAt 不动;不 emit(终态任务防同 kind 重复计数)", () => {
    const tm = new TaskSupervisor();
    let emitted = 0;
    tm.onChange(() => { emitted++; });
    const a = tm.submit("user", "s1", "任务a", { projectId: "p-x" });
    const b = tm.submit("user", "s2", "任务b", { projectId: "p-other" });
    tm.setState(a, "done"); // 终态后再清引用:emit 会让 journal 以 task.done 重复计数
    const emitsAfterSettle = emitted;
    const before = tm.get(a.id)!.updatedAt;
    const touched = tm.clearProjectRef("p-x");
    expect(emitted).toBe(emitsAfterSettle); // 静默变更
    expect(touched.map((t) => t.id)).toEqual([a.id]);
    expect(tm.get(a.id)!.projectId).toBeUndefined();
    expect(tm.get(a.id)!.state).toBe("done");
    expect(tm.get(a.id)!.updatedAt).toBe(before);
    expect(tm.get(b.id)!.projectId).toBe("p-other");
    expect(tm.clearProjectRef("p-x")).toHaveLength(0); // 幂等
  });

  it("cleanupProjectTaskRefs:登记清理+journal 落 task.project.clear 专用纠偏事件", () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    tm.submit("user", "sess-1", "任务1", { projectId: "dead-pid" });
    const touched = cleanupProjectTaskRefs(journal, (pid) => tm.clearProjectRef(pid), ["dead-pid"]);
    expect(touched).toHaveLength(1);
    expect(tm.list().every((t) => t.projectId === undefined)).toBe(true);
    const evs = journal.readAll().filter((e) => e.kind === "task.project.clear");
    expect(evs).toHaveLength(1);
    expect((evs[0]!.payload as { projectId?: string }).projectId).toBeUndefined();
    // 幂等键稳定:重放同任务不再重复落
    cleanupProjectTaskRefs(journal, (pid) => tm.clearProjectRef(pid), ["dead-pid"]);
    expect(journal.readAll().filter((e) => e.kind === "task.project.clear")).toHaveLength(1);
  });

  it("cleanupProjectTaskRefs 批量:两个 dead projectId 一次调用返回全部 clear 事件;重复(幂等)=0 且不新增", () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    tm.submit("user", "sess-a", "任务a", { projectId: "dead-1" });
    tm.submit("user", "sess-b", "任务b", { projectId: "dead-2" });
    const touched = cleanupProjectTaskRefs(journal, (pid) => tm.clearProjectRef(pid), ["dead-1", "dead-2"]);
    expect(touched).toHaveLength(2);
    expect(touched.map((t) => t.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
    expect(tm.list().every((t) => t.projectId === undefined)).toBe(true);
    const evs = journal.readAll().filter((e) => e.kind === "task.project.clear");
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => (e.payload as { sessionId?: string }).sessionId).sort()).toEqual(["sess-a", "sess-b"]);
    // 幂等键:task.<taskId>.project-clear(两个 pid 的两条事件各持稳定键)。
    expect(evs.map((e) => e.idempotencyKey).sort()).toEqual(
      touched.map((t) => `task.${t.id}.project-clear`).sort(),
    );
    // 幂等:重放同两个 pid → 返回 0,不新增事件。
    const again = cleanupProjectTaskRefs(journal, (pid) => tm.clearProjectRef(pid), ["dead-1", "dead-2"]);
    expect(again).toHaveLength(0);
    expect(journal.readAll().filter((e) => e.kind === "task.project.clear")).toHaveLength(2);
  });

  it("profile purge:移除项目时删除档案产物(登记+落盘);不存在=幂等", () => {
    const pdir = mkdtempSync(join(tmpdir(), "profpurge-"));
    const pid = "purge-pid-1";
    writeFileSync(join(pdir, pid + ".json"), JSON.stringify({ projectId: pid, state: "done" }), "utf-8");
    const idx = new ProjectProfileIndex(pdir, () => undefined);
    expect(idx.get(pid)).toBeTruthy();
    idx.purge(pid);
    expect(idx.get(pid)).toBeUndefined();
    expect(existsSync(join(pdir, pid + ".json"))).toBe(false);
    expect(() => idx.purge(pid)).not.toThrow(); // 幂等 no-op
    rmSync(pdir, { recursive: true, force: true });
  });

  it("WS e2e:project.remove 后任务引用被清(广播 task.list)+journal 纠偏+档案 purge", async () => {
    app = createGatewayApp({ port: 7794 });
    const ws = await connect(7794);
    await nextMessage(ws, "project.list.result");

    const projDir = mkdtempSync(join(tmpdir(), "rmref-proj-"));
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: projDir }));
    const afterAdd = await nextMessage(ws, "project.list.result", 5000, 1);
    const added = (afterAdd.projects as { id: string; path: string }[]).find((p) => p.path === projDir);
    expect(added).toBeTruthy();

    // 项目下提交任务(显式 projectId),随后移除项目。
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "rmref-sess", instruction: "项目里的任务", projectId: added!.id }));
    await nextMessage(ws, "task.submitted");
    ws.send(JSON.stringify({ v: 1, type: "project.remove", projectId: added!.id }));
    await nextMessage(ws, "project.list.result", 5000, 2);
    const tl = await nextMessage(ws, "task.list", 5000);
    const row = (tl.tasks as { sessionId: string; projectId?: string }[]).find((t) => t.sessionId === "rmref-sess");
    expect(row).toBeTruthy();
    expect(row!.projectId).toBeUndefined(); // 引用已清,侧栏落「任务」分区而非幽灵桶
    const evs = app.journal.readAll().filter((e) => e.kind === "task.project.clear");
    expect(evs.some((e) => (e.payload as { sessionId?: string }).sessionId === "rmref-sess")).toBe(true);
    rmSync(projDir, { recursive: true, force: true });
    ws.close();
  }, 15_000);

  it("启动 scrub:存量死 projectId 引用在重启后被清(会话保留;journal 纠偏;重启幂等)", async () => {
    const jd = mkdtempSync(join(tmpdir(), "projscrub-"));
    {
      const a = await openApp(jd);
      a.taskManager.submit("user", "sess-dead", "遗留任务", { projectId: "dead-pid-xyz" });
      a.taskManager.submit("user", "sess-alive", "正常任务", { projectId: HARNESS_PROJECT_ID });
      await a.close();
    }
    {
      const b = await openApp(jd);
      const dead = b.taskManager.list().filter((t) => t.sessionId === "sess-dead");
      const alive = b.taskManager.list().filter((t) => t.sessionId === "sess-alive");
      expect(dead).toHaveLength(1);
      expect(dead[0]!.projectId).toBeUndefined(); // 已移除项目引用被 scrub
      expect(alive).toHaveLength(1);
      expect(alive[0]!.projectId).toBe(HARNESS_PROJECT_ID); // 在册项目引用不动
      expect(b.journal.readAll().some((e) => e.kind === "task.project.clear" && (e.payload as { sessionId?: string }).sessionId === "sess-dead")).toBe(true);
      await b.close();
    }
    {
      // 第三次启动:纠偏已落 journal,不再产生新事件(幂等)。
      const c = await openApp(jd);
      expect(c.journal.readAll().filter((e) => e.kind === "task.project.clear")).toHaveLength(1);
      expect(c.taskManager.list().find((t) => t.sessionId === "sess-dead")!.projectId).toBeUndefined();
      await c.close();
    }
    rmSync(jd, { recursive: true, force: true });
  });
});

// 会话归属继承(2026-10-21 归属漂移根治):实锤 web-1792572143140 前 5 任务 projectId=__harness__,
// 用户期间切 active 项目后第 6 个任务突变成新项目。语义:显式 > 会话既有 owner > active。
describe("会话归属继承(切项目不改写老会话归属)", () => {
  it("同会话第一条任务定 owner:active 切到别的项目后,不带 projectId 的追问仍贴原项目", async () => {
    const backend = {
      kind: "capture",
      async spawn(_spec: unknown, onEvent: (e: unknown) => void) {
        onEvent({ type: "result", result: { ok: true, finalText: "done" } });
        return { cancel: async () => {}, respondPermission: async () => {} };
      },
    };
    app = createGatewayApp({ port: 7887, executor: backend as never });
    const ws = await connect(7887);
    await nextMessage(ws, "project.list.result"); // 第 0 条

    const dirP = mkdtempSync(join(tmpdir(), "owner-p-"));
    const dirQ = mkdtempSync(join(tmpdir(), "owner-q-"));
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: dirP }));
    const afterP = await nextMessage(ws, "project.list.result", 5000, 1);
    const projP = (afterP.projects as { id: string; path: string }[]).find((p) => p.path === dirP)!;
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: dirQ }));
    const afterQ = await nextMessage(ws, "project.list.result", 5000, 2);
    const projQ = (afterQ.projects as { id: string; path: string }[]).find((p) => p.path === dirQ)!;
    // active=P,第一条任务(不带 projectId)→ 归属取 active=P,成为该会话 owner。
    ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: projP.id }));
    await nextMessage(ws, "project.list.result", 5000, 3);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "owner-sess", instruction: "第一条" }));
    // 并发跑多个测试文件(各起 gateway+loop)时 CPU 打满,5s 内偶发回不来 → 放宽到 20s(flaky 修复,2026-10-28)
    const first = (await nextMessage(ws, "task.submitted", 20_000)).task as { id: string; projectId?: string };
    expect(first.projectId).toBe(projP.id);
    for (let i = 0; i < 50 && app.taskManager.get(first.id)?.state !== "done"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(app.taskManager.get(first.id)!.state).toBe("done"); // 会话空闲,下一条走直提(不走队列)

    // 用户切到项目 Q,再发一条不带 projectId 的追问:必须仍归 P(会话既有 owner),不能被 active 改写。
    ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: projQ.id }));
    await nextMessage(ws, "project.list.result", 5000, 4);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "owner-sess", instruction: "追问" }));
    const second = (await nextMessage(ws, "task.submitted", 20_000, 1)).task as { projectId?: string };
    expect(second.projectId, "会话归属继承:不被当刻 active 项目改写").toBe(projP.id);

    rmSync(dirP, { recursive: true, force: true });
    rmSync(dirQ, { recursive: true, force: true });
    ws.close();
  }, 90_000);

  it("队列项入队即固化 projectId:排队期间切 active,出队与重启回放都保持原项目", async () => {
    // 永挂 LLM:首条任务停 running,会话保持忙碌 → 后续 submit 走入队。
    const hangLlm = { async chat() { return new Promise<never>(() => { /* 永挂 */ }); } };
    app = createGatewayApp({ port: 7888, llm: hangLlm as never });
    const ws = await connect(7888);
    await nextMessage(ws, "project.list.result");

    const dirP = mkdtempSync(join(tmpdir(), "qfrz-p-"));
    const dirQ = mkdtempSync(join(tmpdir(), "qfrz-q-"));
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: dirP }));
    const afterP = await nextMessage(ws, "project.list.result", 5000, 1);
    const projP = (afterP.projects as { id: string; path: string }[]).find((p) => p.path === dirP)!;
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: dirQ }));
    const afterQ = await nextMessage(ws, "project.list.result", 5000, 2);
    const projQ = (afterQ.projects as { id: string; path: string }[]).find((p) => p.path === dirQ)!;
    // active=P,首条任务占住会话(owner=P)。
    ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: projP.id }));
    await nextMessage(ws, "project.list.result", 5000, 3);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "qfrz-sess", instruction: "占住会话" }));
    await nextMessage(ws, "task.submitted");
    // 切到 Q 后再入队:入队处必须已固化 P(不依赖出队当刻 active)。
    ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: projQ.id }));
    await nextMessage(ws, "project.list.result", 5000, 4);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "qfrz-sess", instruction: "排队追问" }));
    const qu = await nextMessage(ws, "queue.update");
    const item = (qu.items as QueueItem[])[0]!;
    expect(item.projectId, "入队即固化为会话 owner 项目").toBe(projP.id);

    // 出队:取消占用任务 → pumpQueue 提交该队列项 → 新任务 projectId 仍是 P(active 此刻=Q)。
    const busy = app.taskManager.list().find((t) => t.sessionId === "qfrz-sess" && t.instruction === "占住会话")!;
    ws.send(JSON.stringify({ v: 1, type: "task.cancel", taskId: busy.id }));
    let dequeued: { projectId?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      dequeued = app.taskManager.list().find((t) => t.sessionId === "qfrz-sess" && t.instruction === "排队追问");
      if (dequeued) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(dequeued?.projectId, "出队不取当刻 active(=Q),用入队固化的 P").toBe(projP.id);

    // 重放:journal 的 queue.sync 快照带着固化的 projectId(重启 restoreQueues 的数据源)。
    const snaps = app.journal.readAll().filter((e) => e.kind === "queue.sync");
    const withItem = snaps.map((e) => (e.payload as { items?: QueueItem[] }).items ?? []).find((items) => items.some((x) => x.instruction === "排队追问"));
    expect(withItem?.find((x) => x.instruction === "排队追问")?.projectId).toBe(projP.id);
    rmSync(dirP, { recursive: true, force: true });
    rmSync(dirQ, { recursive: true, force: true });
    ws.close();
  }, 30_000);
});

async function openApp(journalDir?: string): Promise<GatewayApp> {
  const a = createGatewayApp({ port: 7796, ...(journalDir ? { journalDir } : {}) });
  await new Promise((r) => setTimeout(r, 50)); // 独立监听起步
  return a;
}

describe("项目 WS e2e(连接即推+四消息+workdir 生效)", () => {
  it("D1/D2/D4:添加→列表;提交任务 workdir=项目路径;移除后回退", async () => {
    const workdirSeen: string[] = [];
    // 假后端:记录 spawn workdir,立即成功。
    const backend = {
      kind: "capture",
      async spawn(spec: { workdir: string }, onEvent: (e: unknown) => void) {
        workdirSeen.push(spec.workdir);
        onEvent({ type: "result", result: { ok: true, finalText: "done" } });
        return { cancel: async () => {}, respondPermission: async () => {} };
      },
    };
    app = createGatewayApp({ port: 7785, executor: backend as never });
    const ws = await connect(7785);

    // 连接即推项目清单(与 hello 同拍)。
    const init = await nextMessage(ws, "project.list.result");
    expect((init.projects as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(init.activeProjectId).toBe(HARNESS_PROJECT_ID);

    // 添加项目。
    const projDir = mkdtempSync(join(tmpdir(), "wse2e-proj-"));
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: projDir }));
    const afterAdd = await nextMessage(ws, "project.list.result", 5000, 1);
    const added = (afterAdd.projects as { id: string; path: string; label: string }[]).find((p) => p.path === projDir);
    expect(added).toBeTruthy();

    // 非法路径→明确报错。
    ws.send(JSON.stringify({ v: 1, type: "project.add", path: "/nonexistent/abs/path" }));
    const err = await nextMessage(ws, "error");
    expect(err.code).toBe("project-add-failed");

    // 等待 spawn 发生(轮询:pre-spawn 链 checkpoint+recall 随会话演进 >300ms,固定等待陈旧——审计 R2)
    const waitSpawn = async () => {
      const before = workdirSeen.length;
      for (let i = 0; i < 25; i++) {
        if (workdirSeen.length > before) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    // 激活→提交任务→workdir=项目路径。
    ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: added!.id }));
    await nextMessage(ws, "project.list.result", 5000, 2);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "proj-e2e", instruction: "在项目里干活" }));
    await waitSpawn();
    expect(workdirSeen.at(-1)).toBe(projDir);

    // 移除后任务 workdir 回退 harness(不中断)。
    ws.send(JSON.stringify({ v: 1, type: "project.remove", projectId: added!.id }));
    const afterRemove = await nextMessage(ws, "project.list.result", 5000, 3);
    expect((afterRemove.projects as unknown[]).find((p) => (p as { id: string }).id === added!.id)).toBeUndefined();
    // 显式带已移除 projectId 提交→回退 harness 根。
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "proj-e2e2", instruction: "再干一个", projectId: added!.id }));
    await waitSpawn();
    expect(workdirSeen.at(-1)).not.toBe(projDir);
    rmSync(projDir, { recursive: true, force: true });
    ws.close();
  }, 15_000);

  it("step-056:fs.list 目录浏览/锚点 + project.rename 广播", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "genie-fsws-")));
    mkdirSync(join(d, "sub"));
    try {
      app = createGatewayApp({ port: 7791 });
      const ws = await connect(7791);
      await nextMessage(ws, "project.list.result"); // 连接即推(第 1 条)

      // 目录列表:子目录在列;非法路径→error 应答不炸连接。
      ws.send(JSON.stringify({ v: 1, type: "fs.list", path: d }));
      const ls = await nextMessage(ws, "fs.list.result");
      expect(ls.path).toBe(d);
      expect((ls.entries as { name: string }[]).map((e) => e.name)).toContain("sub");
      ws.send(JSON.stringify({ v: 1, type: "fs.list", path: "relative/not-allowed" }));
      const err = await nextMessage(ws, "fs.list.result", 5000, 1);
      expect(String(err.error)).toContain("绝对路径");

      // 锚点应答(path="")。
      ws.send(JSON.stringify({ v: 1, type: "fs.list", path: "" }));
      const anchorsMsg = await nextMessage(ws, "fs.list.result", 5000, 2);
      expect((anchorsMsg.anchors as { home: string }).home.startsWith("/")).toBe(true);

      // 添加→重命名→广播带新名(第 2/3 条 project.list.result)。
      ws.send(JSON.stringify({ v: 1, type: "project.add", path: d }));
      const afterAdd = await nextMessage(ws, "project.list.result", 5000, 1);
      const added = (afterAdd.projects as { id: string; path: string }[]).find((p) => p.path === d);
      expect(added).toBeTruthy();
      ws.send(JSON.stringify({ v: 1, type: "project.rename", projectId: added!.id, label: "改名项目" }));
      const afterRename = await nextMessage(ws, "project.list.result", 5000, 2);
      expect((afterRename.projects as { id: string; label: string }[]).find((p) => p.id === added!.id)?.label).toBe("改名项目");
      ws.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }, 15_000);

  it("executor 接线缺省:无 projects 时 workdir=repoRoot(不回退崩)", async () => {
    const workdirSeen: string[] = [];
    const backend = {
      kind: "capture",
      async spawn(spec: { workdir: string }, onEvent: (e: unknown) => void) {
        workdirSeen.push(spec.workdir);
        onEvent({ type: "result", result: { ok: true, finalText: "done" } });
        return { cancel: async () => {}, respondPermission: async () => {} };
      },
    };
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    wireExecutor(tm, journal, backend as never); // 无 nodes/projects
    tm.submit("user", "noproj", "干活");
    // 轮询等待(同上:pre-spawn 链延迟>200ms)
    for (let i = 0; i < 25 && workdirSeen.length === 0; i++) await new Promise((r) => setTimeout(r, 200));
    expect(workdirSeen).toHaveLength(1);
    expect(workdirSeen[0]).toBeTruthy();
  });
});
