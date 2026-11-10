/**
 * 会话消息队列持久化(「重启即丢」根治,P3 登记)。
 *
 * 验收口径(用户任务书):
 *  - 队列变更(入队/出队/删除/发送)往 journal 写 kind="queue.sync"(payload 含 sessionId 与当期快照);
 *  - 启动回放恢复各 session 队列,以最后一条 queue.sync 为准,对应任务已在终态的项丢弃;
 *  - 端到端:入队 → 重启 gateway → hello.queue 快照仍在。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MemoryJournal } from "@lampgenie/core";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { writeQueueSync, restoreQueues, queueItemKey } from "../src/queue-store.js";
import type { QueueItem } from "@lampgenie/protocol";

const item = (id: string, sessionId = "s1", instruction = `消息 ${id}`): QueueItem => ({
  id,
  sessionId,
  instruction,
  createdAt: 1_700_000_000_000,
});

describe("queue-store 纯函数面(queue.sync 落账与回放)", () => {
  it("回放取每会话最后一条快照(快照语义,后写覆盖前写)", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [item("a")]);
    writeQueueSync(j, "s1", [item("b"), item("c")]);
    writeQueueSync(j, "s2", [item("d", "s2")]);
    const restored = restoreQueues(j);
    expect(restored.get("s1")!.map((x) => x.id)).toEqual(["b", "c"]);
    expect(restored.get("s2")!.map((x) => x.id)).toEqual(["d"]);
  });

  it("队列清空(空快照)不恢复该会话", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [item("a")]);
    writeQueueSync(j, "s1", []);
    expect(restoreQueues(j).size).toBe(0);
  });

  it("对应任务已提交/已在终态的项丢弃(幂等键前缀 queue.)", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [item("sent"), item("pending")]);
    // 出队提交产生该任务的终态事件(重启后非终态被 restore 收编,这里直接写终态)
    j.append({
      kind: "task.done",
      sessionId: "s1",
      payload: { id: "t1", sessionId: "s1", instruction: "消息 sent", state: "done", createdAt: 1, updatedAt: 2, idempotencyKey: queueItemKey("s1", "sent") },
    });
    const restored = restoreQueues(j);
    expect(restored.get("s1")!.map((x) => x.id), "已发送项不再排队(防重启二次执行)").toEqual(["pending"]);
  });

  it("幂等键带会话命名空间:跨会话同 itemId 互不误伤", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [item("1", "s1")]);
    writeQueueSync(j, "s2", [item("1", "s2")]);
    // s1 的队列项已提交;s2 的同名项必须保留
    j.append({
      kind: "task.done",
      sessionId: "s1",
      payload: { id: "t1", sessionId: "s1", instruction: "x", state: "done", createdAt: 1, updatedAt: 2, idempotencyKey: queueItemKey("s1", "1") },
    });
    const restored = restoreQueues(j);
    expect(restored.has("s1"), "s1 项已提交不再排队").toBe(false);
    expect(restored.get("s2")!.map((x) => x.id), "s2 同名项不受 s1 影响").toEqual(["1"]);
  });

  it("形状非法的项静默丢弃(不猜、不崩)", () => {
    const j = new MemoryJournal();
    j.append({ kind: "queue.sync", sessionId: "s1", payload: { sessionId: "s1", items: [{ id: "ok", sessionId: "s1", instruction: "好项", createdAt: 1 }, { id: "" }, null, "垃圾", { id: "x", sessionId: "s1" }] } });
    expect(restoreQueues(j).get("s1")!.map((x) => x.id)).toEqual(["ok"]);
  });
});

// ---- 端到端:入队 → 重启 → hello.queue ----

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
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`等待 ${type} 超时`)); }, timeoutMs);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) { clearTimeout(timer); clearInterval(poll); resolve(inbox.splice(i, 1)[0]!); }
    }, 20);
  });
}

/** 永挂 LLM:让首个任务停在 running(会话保持忙碌,后续 submit 走入队)。 */
const hangLlm = { async chat() { return new Promise<never>(() => { /* 永挂 */ }); } };

describe("会话队列持久化 e2e(重启不丢)", () => {
  let app: GatewayApp | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("入队→重启 gateway→hello.queue 快照仍在(顺序与内容保持)", { timeout: 30_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "qpersist-"));
    const SID = "qpersist-s1";
    // useExternalHttp 不传=独立监听(与 ws-integration/session-fork 同款起服方式)。
    app = createGatewayApp({ port: 7831, journalDir: dir, llm: hangLlm as never });
    const ws1 = await connect(7831);
    await nextMessage(ws1, "hello");
    // ① 首条直提:任务停 running(LLM 永挂),会话忙碌
    ws1.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: "占住会话的长任务" }));
    const first = await nextMessage(ws1, "task.submitted");
    expect((first.task as { state: string }).state).toBe("running");
    // ② 后续两条走入队
    ws1.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: "排队消息甲" }));
    await nextMessage(ws1, "queue.update");
    ws1.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: "排队消息乙" }));
    const qu = await nextMessage(ws1, "queue.update");
    expect((qu.items as QueueItem[]).map((x) => x.instruction)).toEqual(["排队消息甲", "排队消息乙"]);
    // ③ journal 落账(变更出口的唯一真相)
    const syncs = app.journal.readAll().filter((e) => e.kind === "queue.sync");
    expect(syncs.length, "每次队列变更一条 queue.sync").toBeGreaterThanOrEqual(2);
    const last = syncs.at(-1)!.payload as { sessionId: string; items: QueueItem[] };
    expect(last.sessionId).toBe(SID);
    expect(last.items.map((x) => x.instruction)).toEqual(["排队消息甲", "排队消息乙"]);
    ws1.close();
    await app.close();
    app = null;

    // ④ 重启:同 journalDir 新进程 → hello.queue 恢复
    app = createGatewayApp({ port: 7832, journalDir: dir, llm: hangLlm as never });
    const ws2 = await connect(7832);
    const hello = await nextMessage(ws2, "hello");
    const queue = (hello.queue ?? []) as QueueItem[];
    expect(queue.map((x) => x.instruction), "重启后排队消息仍在(此前为内存态=空)").toEqual(["排队消息甲", "排队消息乙"]);
    expect(queue.map((x) => x.sessionId)).toEqual([SID, SID]);
    ws2.close();
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("客户端 idempotencyKey 进 user. 命名空间:不与队列项键交叉碰撞", { timeout: 20_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "qidem-"));
    const SID = "qidem-s1";
    app = createGatewayApp({ port: 7833, journalDir: dir, llm: hangLlm as never });
    const ws = await connect(7833);
    await nextMessage(ws, "hello");
    // 首条占住会话
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: "长任务" }));
    await nextMessage(ws, "task.submitted");
    // 排队一条拿到 itemId,再用「同形键」直提(模拟客户端试图碰撞内部保留前缀)
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: SID, instruction: "排队消息" }));
    const qu = await nextMessage(ws, "queue.update");
    const itemId = (qu.items as QueueItem[])[0]!.id;
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "other-sid", instruction: "客户端自造键", idempotencyKey: queueItemKey(SID, itemId) }));
    const submitted = await nextMessage(ws, "task.submitted");
    const task = submitted.task as { id: string; idempotencyKey?: string };
    expect(task.idempotencyKey, "入账键带 user. 前缀(与内部 queue. 域隔离)").toBe(`user.${queueItemKey(SID, itemId)}`);
    // 该任务事件绝不带裸 queue.<sid>.<idem> 键 → 回放不会把它当成队列项已提交
    const keys = app.journal.readAll()
      .filter((e) => e.kind.startsWith("task."))
      .map((e) => (e.payload as { idempotencyKey?: string }).idempotencyKey)
      .filter((k): k is string => !!k);
    expect(keys).toContain(`user.${queueItemKey(SID, itemId)}`);
    expect(keys, "队列项的裸键未被客户端任务占用").not.toContain(queueItemKey(SID, itemId));
    ws.close();
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
});