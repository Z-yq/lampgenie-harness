/**
 * session.fork 集成(ZCode session-fork 语义移植,refs: ZCode):
 * 新会话完整继承原会话上下文事件(消息/工具/子代理/待办/目标),任务生命周期与快照噪声不继承,
 * 末尾带分叉标记行;原会话只增不改;原会话不存在=ok:false+reason。
 * 起服方式与 ws-integration.test.ts 同款(createGatewayApp 独立端口 + inbox 收集器)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

// journal 确定性:关掉任务链旁路写入(执行前快照),fork 复制数才可精确断言。
// (终态评审钩子已下线,原 GENIE_REVIEW_HOOK=off 行随之移除。)
process.env.GENIE_CHECKPOINT = "off";

// 随机高位端口(避开 7700 常用段;本仓测试串行跑)
const PORT = 18000 + Math.floor(Math.random() * 1500);

let app: GatewayApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // 立即挂收集器:hello 等早到消息可能先于等待注册(ws-integration 同款)。
    const inbox: Record<string, unknown>[] = [];
    (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox = inbox;
    ws.on("message", (raw: Buffer) => inbox.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** 非consum等待:扫 inbox(不消费),谓词命中即返回。 */
function waitMatch(
  ws: WebSocket,
  pred: (m: Record<string, unknown>) => boolean,
  ms = 8000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待消息超时")), ms);
    const poll = setInterval(() => {
      const hit = inbox.find(pred);
      if (hit) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(hit);
      }
    }, 20);
  });
}

type Ev = { seq: number; kind: string; payload: Record<string, unknown> };

describe("session.fork(会话分叉:上下文继承)", () => {
  it("fork 继承消息/目标/子代理轨迹,任务生命周期与快照噪声不继承;源会话不动;不存在报 ok:false", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const ws = await connect(PORT);

    // ① 提交任务(echo 伪执行器):源会话产生 task.enqueue/start/done + message.user/agent + subagent.*
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "s-src", instruction: "分叉源任务", idempotencyKey: "k-fork-src" }));
    await waitMatch(
      ws,
      (m) =>
        m.type === "task.changed" &&
        (m.task as { state?: string; sessionId?: string })?.state === "done" &&
        (m.task as { sessionId?: string })?.sessionId === "s-src",
    );

    // ② 造消息(journal 直写,ws-integration 同款观察面)+ goal.set(走协议真路径)
    const journal = app.journal;
    journal.append({ kind: "message.user", sessionId: "s-src", payload: { text: "第二条用户消息" } });
    journal.append({ kind: "message.agent", sessionId: "s-src", payload: { text: "助手继承回复" } });
    journal.append({ kind: "tool.call", sessionId: "s-src", payload: { callId: "c1", name: "read_file" } });
    journal.append({ kind: "tool.result", sessionId: "s-src", payload: { toolCallId: "c1", content: "ok" } });
    journal.append({ kind: "todo.updated", sessionId: "s-src", payload: { items: [{ content: "继承待办", status: "pending" }] } });
    journal.append({ kind: "checkpoint.create", sessionId: "s-src", payload: { taskId: "t-noise", sha: null } }); // 噪声:fork 不得继承
    ws.send(JSON.stringify({ v: 1, type: "goal.set", sessionId: "s-src", goal: "把分叉继承验证做完" }));
    await waitMatch(ws, (m) => m.type === "goal.result" && m.goal === "把分叉继承验证做完");

    const srcEvents = journal.readAll().filter((e) => e.sessionId === "s-src");
    const srcMsgCount = srcEvents.filter((e) => e.kind.startsWith("message.")).length;
    const noiseKinds = new Set([
      "task.enqueue", "task.start", "task.progress", "task.done", "task.fail",
      "checkpoint.create", "checkpoint.restore",
    ]);
    const expectedCopied = srcEvents.filter((e) => !noiseKinds.has(e.kind)).length;
    expect(srcMsgCount).toBeGreaterThan(0);
    expect(expectedCopied).toBeLessThan(srcEvents.length); // 噪声确在场(否则断言失去意义)

    // ③ fork
    ws.send(JSON.stringify({ v: 1, type: "session.fork", sessionId: "s-src" }));
    const fork = await waitMatch(ws, (m) => m.type === "session.fork.result");
    expect(fork.ok).toBe(true);
    const forkId = String(fork.sessionId);
    expect(forkId).toMatch(/^fork-/);
    expect(fork.copied).toBe(expectedCopied);

    // ④ 新会话历史验证
    ws.send(JSON.stringify({ v: 1, type: "session.history", sessionId: forkId }));
    const hist = await waitMatch(ws, (m) => m.type === "session.history.result" && m.sessionId === forkId);
    const events = hist.events as Ev[];
    // 继承消息数=原会话全部消息+1 条分叉标记
    expect(events.filter((e) => e.kind.startsWith("message.")).length).toBe(srcMsgCount + 1);
    // goal.set 在场(目标随 fork 继承)
    expect(events.some((e) => e.kind === "goal.set" && e.payload.goal === "把分叉继承验证做完")).toBe(true);
    // 分叉标记行(message.system,带原会话 id)
    expect(
      events.some((e) => {
        if (e.kind !== "message.system") return false;
        const text = String(e.payload.text ?? "");
        return text.includes("[会话分叉]") && text.includes("s-src") && text.includes("以上历史为继承上下文");
      }),
    ).toBe(true);
    // 继承件真实在场(echo 往返与直写消息)
    expect(events.some((e) => e.kind === "message.agent" && e.payload.text === "助手继承回复")).toBe(true);
    expect(events.some((e) => e.kind === "tool.result")).toBe(true);
    expect(events.some((e) => e.kind === "subagent.spawn")).toBe(true);
    expect(events.some((e) => e.kind === "todo.updated")).toBe(true);
    // 噪声不继承
    expect(events.some((e) => e.kind.startsWith("task."))).toBe(false);
    expect(events.some((e) => e.kind === "checkpoint.create")).toBe(false);
    // 原 seq 顺序保持(journal 重分配后仍单调)
    for (let i = 1; i < events.length; i++) expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);

    // ⑤ 原会话只增不改:fork 后源事件数不变
    expect(journal.readAll().filter((e) => e.sessionId === "s-src").length).toBe(srcEvents.length);

    // ⑥ 原会话不存在 → ok:false + reason
    ws.send(JSON.stringify({ v: 1, type: "session.fork", sessionId: "s-nope" }));
    const miss = await waitMatch(ws, (m) => m.type === "session.fork.result" && m.ok === false);
    expect(typeof miss.reason).toBe("string");
    expect(String(miss.reason).length).toBeGreaterThan(0);

    ws.close();
  }, 20000);
});
