import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import {
  projectSession,
  mergeProjection,
  type SessionEventLike,
  type SessionProjection,
  type ProjectionCarry,
} from "@lampgenie/runtime/session/projection";

/**
 * step-1036 session.status 增量化(治 2026-11-04 网关 OOM:11k 事件会话 × 3s 全量回拉,
 * 每次全量投影+序列化 1.4~9.2 秒、载荷 MB 级)。锁五条:
 * ① 全量 vs 多批增量合并逐字段 deepEqual(纯函数层);
 * ② 带 sinceSeq 的请求不重复归约水位那条(负面:seq=N 的 spawn 不被二次计入);
 * ③ 空增量不清空 prev(todo/workflows/compactions 不变);
 * ④ 不带 sinceSeq 仍是全量(与改造前语义等价);
 * ⑤ status.task 索引形状(无 instruction/result 键)+ status.seq 是数字。
 */

const PORT = 7715; // 避开 7700/7712/7713/7785-7799
const PORT2 = 7716; // 同文件第二条 WS 用例独立端口(close 后同端口收尾会吃掉后续消息)
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

function nextMessage(ws: WebSocket, type: string, timeout = 5000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeout);
    const poll = setInterval(() => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(inbox.splice(i, 1)[0]!);
      }
    }, 20);
  });
}

function statusOf(msg: Record<string, unknown>): Record<string, unknown> & {
  seq: number;
  task: Record<string, unknown> | null;
  todo: { items: { content: string; status: string }[]; completed: number; total: number } | null;
  subagents: { spawnCount: number; resultCount: number; running: number };
  workflows: { wfId: string; asks: number; done: boolean }[];
  compactions: { at: number; tokens?: number }[];
} {
  return msg.status as never;
}

/** 分批增量合并(模拟服务端 memo 路径:同一 carry 连续带进带出)。 */
function mergeInBatches(batches: SessionEventLike[][], all: (SessionEventLike & { sessionId: string })[] = []) {
  const carry: ProjectionCarry = { todoSeen: false, compactStart: null, wfSeen: new Set<string>() };
  let acc: SessionProjection | null = null;
  for (const batch of batches) {
    const facts = { todoSeen: false, compactStart: carry.compactStart };
    const delta = projectSession(batch, all, facts);
    acc = acc ? mergeProjection(acc, delta, { facts, outCarry: carry }) : delta;
    if (!acc) throw new Error("unreachable");
  }
  if (!acc) throw new Error("空批");
  return acc;
}

describe("projectSession 增量合并(mergeProjection)全量等价性", () => {
  const A: SessionEventLike[] = [
    { kind: "todo.updated", time: 1, payload: { items: [{ content: "步骤一", status: "completed" }, { content: "步骤二", status: "in_progress" }] } },
    { kind: "subagent.spawn", time: 2, payload: { taskId: "t1" } },
    { kind: "message.user", time: 3, payload: { text: "你好" } },
  ];
  const B: SessionEventLike[] = [
    { kind: "subagent.spawn", time: 4, payload: { taskId: "t2" } },
    { kind: "subagent.result", time: 5, payload: { taskId: "t1" } },
    { kind: "workflow.run.start", time: 6, payload: { wfId: "wf-1" } },
    { kind: "message.agent", time: 7, payload: { text: "在的" } },
    { kind: "todo.updated", time: 8, payload: { items: [{ content: "步骤一", status: "completed" }] } },
  ];
  const C: SessionEventLike[] = [
    { kind: "workflow.run.done", time: 9, payload: { wfId: "wf-1", ok: true } },
    { kind: "compact.start", time: 10, payload: { tokens: 1234 } }, // 与 compact.done 分落两批 → 跨批 carry
    { kind: "message.user", time: 11, payload: { text: "再问一句" } },
  ];
  const D: SessionEventLike[] = [
    { kind: "compact.done", time: 12, payload: { summaryChars: 80, tokensAfter: 900, trigger: "auto" } },
    { kind: "message.agent", time: 13, payload: { text: "答" } },
    { kind: "query" as string, time: 14, payload: {} }, // 非投影事件:两侧都忽略
  ];

  it("① 3 批增量合并 == 一次性全量投影(逐字段 deepEqual)", () => {
    const full = projectSession([...A, ...B, ...C, ...D]);
    const inc = mergeInBatches([A, B, [...C, ...D]]);
    expect(inc.todo).toEqual(full.todo);
    expect(inc.subagents).toEqual(full.subagents);
    expect(inc.workflows).toEqual(full.workflows);
    expect(inc.compactions).toEqual(full.compactions); // compact.start/done 跨批:at/tokens 不丢
    expect(inc.rows).toEqual(full.rows);
    expect(inc.rowCount).toBe(full.rowCount);
    expect(inc).toEqual(full);
  });

  it("①b 四批(compact.start 与 compact.done 分落两批)+ 无 todo 批保留 prev todo", () => {
    const full = projectSession([...A, ...B, ...C, ...D]);
    const inc = mergeInBatches([A, B, C, D]);
    expect(inc).toEqual(full);
    expect(inc.compactions[0]).toEqual(full.compactions[0]);
    expect(inc.compactions[0]!.tokens).toBe(1234); // 跨批带出
  });

  it("①c 单批空事件也等价(空批不改变累积态)", () => {
    const full = projectSession([...A, ...B]);
    const inc = mergeInBatches([A, [], B]);
    expect(inc).toEqual(full);
  });
});

describe("session.status 增量协议(WS)", () => {
  it("② 带 sinceSeq 不重复计水位那条(seq=N 的 spawnCount 不变)", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const sid = "s-inc-dup";
    const e1 = app.journal.append({ kind: "subagent.spawn", sessionId: sid, payload: { taskId: "t1" } });
    const ws = await connect(PORT);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    const firstRaw = await nextMessage(ws, "session.status.result");
    // 回包必须回显 sessionId:面板按它登记水位表;缺它 → 水位全落 undefined 键 → 后续请求永不带
    // sinceSeq(增量路径形同虚设)。浏览器实测抓到过,这里锁死。
    expect(firstRaw.sessionId).toBe(sid);
    const first = statusOf(firstRaw);
    expect(first.subagents.spawnCount).toBe(1);
    expect(first.seq).toBe(e1.seq);

    // 带 sinceSeq = 当前水位且无新事件 → 空增量:不得把水位那条再归约一次。
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid, sinceSeq: first.seq }));
    const second = statusOf(await nextMessage(ws, "session.status.result"));
    expect(second.subagents.spawnCount).toBe(1);
    expect(second.seq).toBe(first.seq);
    ws.close();
  });

  it("③ 空增量不清空 prev(todo/workflows/compactions 与上次相同)", async () => {
    app = createGatewayApp({ port: PORT2, executor: new EchoChildBackend() });
    const sid = "s-inc-empty";
    app.journal.append({ kind: "todo.updated", sessionId: sid, payload: { items: [{ content: "干活", status: "in_progress" }] } });
    app.journal.append({ kind: "workflow.run.start", sessionId: sid, payload: { wfId: "wf-e" } });
    app.journal.append({ kind: "compact.start", sessionId: sid, payload: { tokens: 10 } });
    app.journal.append({ kind: "compact.done", sessionId: sid, payload: { summaryChars: 5 } });
    const ws = await connect(PORT2);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    const first = statusOf(await nextMessage(ws, "session.status.result"));
    expect(first.todo?.total).toBe(1);
    expect(first.workflows.map((w) => w.wfId)).toEqual(["wf-e"]);
    expect(first.compactions.length).toBe(1);

    // 连续两次空增量:累积态必须原样返回(不是 [] / null)。
    for (let i = 0; i < 2; i++) {
      ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid, sinceSeq: first.seq }));
      const again = statusOf(await nextMessage(ws, "session.status.result"));
      expect(again.todo).toEqual(first.todo);
      expect(again.workflows).toEqual(first.workflows);
      expect(again.compactions).toEqual(first.compactions);
      expect(again.subagents).toEqual(first.subagents);
      expect(again.seq).toBe(first.seq);
    }

    // 增量有水位的推进:再落一条 spawn → seq 前移、计数 +1(证明增量批确实被归约)。
    const e2 = app.journal.append({ kind: "subagent.spawn", sessionId: sid, payload: { taskId: "t9" } });
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid, sinceSeq: first.seq }));
    const inc = statusOf(await nextMessage(ws, "session.status.result"));
    expect(inc.subagents.spawnCount).toBe(1);
    expect(inc.seq).toBe(e2.seq);
    expect(inc.workflows).toEqual(first.workflows); // wf 只在历史里,增量后不回 []
    ws.close();
  });

  it("④ 不传 sinceSeq 仍全量(等价改造前语义)", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const sid = "s-inc-full";
    app.journal.append({ kind: "subagent.spawn", sessionId: sid, payload: { taskId: "t1" } });
    app.journal.append({ kind: "subagent.spawn", sessionId: sid, payload: { taskId: "t2" } });
    app.journal.append({ kind: "subagent.result", sessionId: sid, payload: { taskId: "t1" } });
    app.journal.append({ kind: "todo.updated", sessionId: sid, payload: { items: [{ content: "a", status: "completed" }] } });
    const ws = await connect(PORT);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    const st = statusOf(await nextMessage(ws, "session.status.result"));
    // 与 projectSession 直接全量投影逐字段一致(改造前语义)。
    const expectFull = projectSession(app.journal.readSession(sid) as never);
    expect(st.subagents).toEqual(expectFull.subagents);
    expect(st.todo).toEqual(expectFull.todo);
    expect(st.workflows).toEqual(expectFull.workflows);
    expect(st.compactions).toEqual(expectFull.compactions);

    // 老客户端连发两次全量:结果稳定(幂等,不会自己翻倍)。
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    const st2 = statusOf(await nextMessage(ws, "session.status.result"));
    expect(st2.subagents).toEqual(st.subagents);
    ws.close();
  });

  it("⑤ status.task 是索引形状(无 instruction/result)+ status.seq 是数字", async () => {
    app = createGatewayApp({ port: PORT2, executor: new EchoChildBackend() });
    const sid = "s-inc-task";
    const task = app.taskManager.submit("user", sid, "带正文的任务说明");
    app.journal.append({ kind: "message.user", sessionId: sid, payload: { text: "hi" } });
    const ws = await connect(PORT2);
    await nextMessage(ws, "hello");

    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    const st = statusOf(await nextMessage(ws, "session.status.result"));
    expect(typeof st.seq).toBe("number");
    expect(st.seq).toBeGreaterThan(0);
    expect(st.task).toMatchObject({ id: task.id, sessionId: sid, title: "带正文的任务说明" });
    expect(typeof st.task!.state).toBe("string"); // 索引形状:state 在场(具体值随 executor 调度变)
    for (const k of ["instruction", "result"]) {
      expect(Object.prototype.hasOwnProperty.call(st.task, k), `status.task.${k} 泄漏`).toBe(false);
    }
    ws.close();
  });

  it("⑥ 载荷有界:大事件会话的 status 帧体积不随事件数增长(原 OOM 现场 MB 级)", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const sid = "s-inc-size";
    // 造一个「巨型会话」:3000 条 message 事件,单条正文 500 字(≈1.5MB 原文)。
    const filler = "长正文".repeat(166); // 498 字/条
    for (let i = 0; i < 3000; i++) {
      app.journal.append({ kind: i % 2 ? "message.agent" : "message.user", sessionId: sid, payload: { text: `${i}:${filler}` } });
    }
    const ws = await connect(PORT);
    await nextMessage(ws, "hello");

    const frameSizes: number[] = [];
    const seqs: number[] = [];
    ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid }));
    let msg = await nextMessage(ws, "session.status.result");
    frameSizes.push(JSON.stringify(msg).length);
    seqs.push(statusOf(msg).seq);

    // 再来 3 次增量(每次服务端只归约新事件):帧体积必须仍有界,不随 3000 条历史线性膨胀。
    for (let round = 0; round < 3; round++) {
      app.journal.append({ kind: "subagent.spawn", sessionId: sid, payload: { taskId: `z${round}` } });
      ws.send(JSON.stringify({ v: 1, type: "session.status", sessionId: sid, sinceSeq: seqs[seqs.length - 1] }));
      msg = await nextMessage(ws, "session.status.result");
      frameSizes.push(JSON.stringify(msg).length);
      seqs.push(statusOf(msg).seq);
    }
    // rows 尾部窗口 50 条 × 单行 200 字封顶 → 帧恒在百 KB 内(原文 1.5MB 不进载荷)。
    for (const size of frameSizes) expect(size).toBeLessThan(100 * 1024);
    // 原文不进帧:帧里不得出现尾部窗口之外的历史正文。
    expect(JSON.stringify(msg)).not.toContain("0:长正文");
    // 增量确实推进了水位,且累积计数正确(3 次 spawn)。
    expect(statusOf(msg).subagents.spawnCount).toBe(3);
    expect(seqs[seqs.length - 1]).toBeGreaterThan(seqs[0]!);
    ws.close();
  }, 30000);
});