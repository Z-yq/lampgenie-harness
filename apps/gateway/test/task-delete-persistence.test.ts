/**
 * 任务删除持久化(2026-10-19 用户实报「为什么这些删不掉」):
 * 根因三件——①删除只从内存 Map 移除,journal 无删除事件 → 网关重启回放 task.* 快照把删掉的任务全复活;
 * ②侧栏一行=一个会话(step-048 聚合),右键只删单条 → 该会话另 N 条照旧撑住整行;
 * ③运行中任务的后续 setState 能把已删任务塞回 Map。
 * 本文件守这三条的回归:墓碑语义 / 会话级批量删除 / journal 回放跳过已删。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { parseClientMessage } from "@lampgenie/protocol";
import { TaskSupervisor } from "../src/task-manager.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";

const NOW = Date.now();

describe("TaskSupervisor 删除墓碑", () => {
  it("delete 返回被删快照(供落 task.deleted),再次 delete 返回 undefined(幂等)", () => {
    const tm = new TaskSupervisor();
    const t = tm.submit("user", "s1", "要删的");
    const gone = tm.delete(t.id);
    expect(gone?.id).toBe(t.id);
    expect(gone?.sessionId).toBe("s1");
    expect(tm.get(t.id)).toBeUndefined();
    expect(tm.delete(t.id), "重复删除=undefined(不重复落墓碑事件)").toBeUndefined();
  });

  it("墓碑拦复活:删掉后 restore 同 id 不回填", () => {
    const tm = new TaskSupervisor();
    const task = { id: "t-del", sessionId: "s1", instruction: "x", state: "running" as const, createdAt: NOW, updatedAt: NOW };
    tm.restore([task]);
    expect(tm.get("t-del")).toBeTruthy();
    tm.delete("t-del");
    // 重启回放:同一条 running 快照再来一次
    const collected = tm.restore([task]);
    expect(collected).toEqual([]);
    expect(tm.get("t-del"), "已删任务不得被回放复活").toBeUndefined();
  });

  it("墓碑拦在跑任务的 setState 回写(删掉后执行链收尾不能塞回 Map)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 4 });
    const t = tm.submit("user", "s1", "跑着的");
    tm.delete(t.id);
    tm.setState(t, "done", "执行链收尾");
    expect(tm.get(t.id), "已删任务的终态回写不得复活它").toBeUndefined();
    expect(tm.list()).toEqual([]);
  });

  it("删掉运行中任务会补 drain:排队任务被提升(否则并发槽空着但队列卡死)", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 1, maxConcurrentPerOwner: 10 });
    const a = tm.submit("user", "s1", "跑着的");
    const b = tm.submit("user", "s2", "排队的");
    expect(a.state).toBe("running");
    expect(b.state).toBe("queued");
    tm.delete(a.id);
    expect(tm.get(b.id)!.state, "删掉 running 释放的并发槽必须立刻给排队任务").toBe("running");
  });

  it("markDeleted 预注入墓碑(启动回放先扫 task.deleted 再 restore)", () => {
    const tm = new TaskSupervisor();
    tm.markDeleted(["t-a", "t-b"]);
    tm.restore([
      { id: "t-a", sessionId: "s1", instruction: "a", state: "done", createdAt: NOW, updatedAt: NOW },
      { id: "t-b", sessionId: "s1", instruction: "b", state: "done", createdAt: NOW, updatedAt: NOW },
      { id: "t-c", sessionId: "s1", instruction: "c", state: "done", createdAt: NOW, updatedAt: NOW },
    ]);
    expect(tm.list().map((x) => x.id)).toEqual(["t-c"]);
    expect(tm.deletedIds().sort()).toEqual(["t-a", "t-b"]);
  });
});

describe("会话级批量删除(侧栏一行=一个会话)", () => {
  it("deleteSession 删该会话全部任务,不动其它会话", () => {
    const tm = new TaskSupervisor({ maxConcurrent: 10, maxConcurrentPerOwner: 10 });
    const a1 = tm.submit("user", "auto-x", "自动任务 1");
    const a2 = tm.submit("user", "auto-x", "自动任务 2");
    const a3 = tm.submit("user", "auto-x", "自动任务 3");
    const other = tm.submit("user", "s-other", "别人的任务");
    const gone = tm.deleteSession("auto-x");
    expect(gone.map((t) => t.id).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    expect(tm.list({ sessionId: "auto-x" })).toEqual([]);
    expect(tm.get(other.id), "别的会话不受波及").toBeTruthy();
    expect(tm.deleteSession("auto-x"), "空会话=空数组(幂等)").toEqual([]);
  });
});

describe("协议面:task.deleteSession 走真实 WS handler + 重启回放不复活", () => {
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
  function nextMessage(ws: WebSocket, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) { clearInterval(poll); resolve(inbox.splice(i, 1)[0]!); return; }
        if (Date.now() - t0 > timeoutMs) { clearInterval(poll); reject(new Error(`等待 ${type} 超时`)); }
      }, 20);
    });
  }

  it("协议 schema 认 task.deleteSession(union 已纳入,非法帧被拒)", () => {
    const ok = parseClientMessage(JSON.stringify({ v: 1, type: "task.deleteSession", sessionId: "auto-z" }));
    expect(ok?.type).toBe("task.deleteSession");
    // sessionId 必填:缺字段不得被静默接受
    expect(parseClientMessage(JSON.stringify({ v: 1, type: "task.deleteSession" }))).toBeNull();
  });

  it("发 task.deleteSession 帧 → 该会话任务全清;journal 落墓碑;重启后不复活", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-taskdel-ws-"));
    const P1 = 7844, P2 = 7845;
    app = createGatewayApp({ port: P1, journalDir: dir });
    const ws = await connect(P1);
    await nextMessage(ws, "hello");
    // 造数据走 taskManager 直提(同会话连续 submit 会走 fixI8 排队语义,不回 task.submitted 帧,
    // 那不是本次要测的东西);删除侧仍走真实 WS handler。
    // 聚合会话 3 条(侧栏渲染成一行)+ 另一会话 1 条做对照。
    const made = [1, 2, 3].map((i) => app!.taskManager.submit("user", "auto-z", `[自动] 任务 ${i}`).id);
    const keepId = app.taskManager.submit("user", "s-keep", "留下来的任务").id;
    expect(app.taskManager.list().length).toBe(4);

    // 真实 handler:task.deleteSession
    ws.send(JSON.stringify({ v: 1, type: "task.deleteSession", sessionId: "auto-z" }));
    const okFrame = await nextMessage(ws, "git.ok");
    expect(okFrame.op).toBe("task-delete-session");
    const list = await nextMessage(ws, "task.list");
    expect((list.tasks as { id: string }[]).map((t) => t.id)).toEqual([keepId]);
    expect(app.taskManager.list({ sessionId: "auto-z" })).toEqual([]);

    // 落盘实证:journal 里那条 task.deleted 的 taskIds 精确等于被删的 3 条(不靠子串,防弱断言)
    const dels = app.journal.readAll().filter((e) => e.kind === "task.deleted");
    expect(dels).toHaveLength(1);
    expect((dels[0]!.payload as { taskIds: string[] }).taskIds.sort()).toEqual([...made].sort());
    await app.close();
    app = null;
    // 文件里的墓碑行确实带全 3 个 id
    const raw = readFileSync(join(dir, "gateway.jsonl"), "utf-8");
    const delLine = raw.split("\n").find((l) => l.includes('"kind":"task.deleted"'))!;
    for (const id of made) expect(delLine, "墓碑行必须含该任务 id").toContain(id);
    expect(delLine).not.toContain(keepId);

    // 重启回放:被删的 3 条不复活,留下的照旧
    app = createGatewayApp({ port: P2, journalDir: dir });
    expect(app.taskManager.list().map((t) => t.id)).toEqual([keepId]);
    expect(app.taskManager.deletedIds().sort()).toEqual([...made].sort());
  }, 40_000);
});