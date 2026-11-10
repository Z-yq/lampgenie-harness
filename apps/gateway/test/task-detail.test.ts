import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

// 开工 orient(code-sense 全量索引)在慢盘上会同步占住事件循环数秒 → task.submit 的 router 路径
// (task.submitted 在 queued/running/ticket.updated 之后才回)会贴穿 5s 等待而间歇假红。
// 与 file-tools-e2e.test.ts 同口径关闭(本测试不依赖开工意识)。
process.env.GENIE_SENSE_ORIENT = "off";

/**
 * 任务协议索引化(2026-10-29):hello / task.list / task.changed 只带 TaskIndex,
 * 正文按需 task.detail.get → task.detail.result 现取。锁四条:
 * ① hello 首包每条无 instruction/result 键;② 变更帧同样无正文但有 id/state/updatedAt/title;
 * ③ 详情往返正文逐字相等;④ 未知 id 回 task:null 且 taskId 回显(不抛、不回全量列表)。
 */

const PORT = 7712; // 未被占用的 77xx(避开 7785-7799/7700)
const PORT2 = 7713; // 同文件第二条用例独立端口:close() 后同端口的监听收尾会吃掉后续消息
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

// 等待超时:router 路径的 task.submitted 走若干异步步(queued→running→ticket.updated→submitted),
// 冷启动/慢盘下会超过 5s。放宽到 15s(失败仍是失败,只是不再贴线假红)。
function nextMessage(ws: WebSocket, type: string, timeout = 15000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  const hit = inbox.findIndex((m) => m.type === type);
  if (hit >= 0) return Promise.resolve(inbox.splice(hit, 1)[0]!);
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

/** 等某条 task.changed(按 taskId 过滤;其它任务/会话的变更帧跳过)。 */
function nextTaskChanged(ws: WebSocket, taskId: string, timeout = 8000): Promise<Record<string, unknown>> {
  const inbox = (ws as unknown as { __inbox: Record<string, unknown>[] }).__inbox;
  const match = (m: Record<string, unknown>) => m.type === "task.changed" && (m.task as { id?: string } | undefined)?.id === taskId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 task.changed(${taskId}) 超时`)), timeout);
    const poll = setInterval(() => {
      const i = inbox.findIndex(match);
      if (i >= 0) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(inbox.splice(i, 1)[0]!);
      }
    }, 20);
  });
}

const BANNED = ["instruction", "result", "error"];

describe("任务协议索引化 + 按需详情", () => {
  it("hello → 提交 → task.changed → task.detail.get 全链", async () => {
    app = createGatewayApp({ port: PORT, executor: new EchoChildBackend() });
    const ws = await connect(PORT);

    // ① hello 首包只带索引:任何一条都不得含正文/错误键。
    const hello = await nextMessage(ws, "hello");
    const helloTasks = hello.tasks as Record<string, unknown>[];
    expect(Array.isArray(helloTasks)).toBe(true);
    for (const t of helloTasks) {
      for (const k of BANNED) expect(Object.prototype.hasOwnProperty.call(t, k), `hello.tasks[].${k} 泄漏`).toBe(false);
    }
    // 首包体积门(原 OOM 现场 hello=960KB;索引化后帧长只随任务条数线性增长)。
    expect(JSON.stringify(hello).length).toBeLessThan(100 * 1024);

    // ② 提交长指令 → task.changed 帧 task 无正文但有 id/state/updatedAt/title。
    const instruction = "长任务标题行\n" + "正文细节 ".repeat(400);
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "detail-s1", instruction, idempotencyKey: "k-detail-1" }));
    const submitted = await nextMessage(ws, "task.submitted");
    const taskId = String((submitted.task as { id: string }).id);
    expect((submitted.task as { instruction: string }).instruction).toBe(instruction); // 提交回执仍是全文

    const changed = await nextTaskChanged(ws, taskId);
    const idx = changed.task as Record<string, unknown>;
    for (const k of BANNED) expect(Object.prototype.hasOwnProperty.call(idx, k), `task.changed.task.${k} 泄漏`).toBe(false);
    expect(idx.id).toBe(taskId);
    expect(typeof idx.state).toBe("string");
    expect(typeof idx.updatedAt).toBe("number");
    expect(idx.title).toBe("长任务标题行");
    // 索引帧绝不能退化成全文(机制性:帧长远小于指令长度)。
    expect(JSON.stringify(changed).length).toBeLessThan(instruction.length);

    // ③ 详情往返:instruction 与提交原文逐字相等。
    ws.send(JSON.stringify({ v: 1, type: "task.detail.get", taskId }));
    const detail = await nextMessage(ws, "task.detail.result");
    expect(detail.taskId).toBe(taskId);
    const full = detail.task as { instruction: string; id: string };
    expect(full.instruction).toBe(instruction);
    expect(full.id).toBe(taskId);

    // ④ 未知 id:task 为 null 且 taskId 回显,连接仍可用。
    ws.send(JSON.stringify({ v: 1, type: "task.detail.get", taskId: "no-such-task" }));
    const miss = await nextMessage(ws, "task.detail.result");
    expect(miss.task).toBeNull();
    expect(miss.taskId).toBe("no-such-task");

    ws.close();
  }, 30000);

  it("task.list 载荷同样是索引(无正文键)", async () => {
    app = createGatewayApp({ port: PORT2, executor: new EchoChildBackend() });
    const ws = await connect(PORT2);
    await nextMessage(ws, "hello");
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "detail-s2", instruction: "列表索引口径检查\n细节", idempotencyKey: "k-detail-2" }));
    const submitted = await nextMessage(ws, "task.submitted");
    const taskId = String((submitted.task as { id: string }).id);

    ws.send(JSON.stringify({ v: 1, type: "task.list" }));
    const list = await nextMessage(ws, "task.list");
    const rows = list.tasks as Record<string, unknown>[];
    expect(rows.some((t) => t.id === taskId)).toBe(true);
    for (const t of rows) {
      for (const k of BANNED) expect(Object.prototype.hasOwnProperty.call(t, k), `task.list.tasks[].${k} 泄漏`).toBe(false);
    }
    ws.close();
  }, 30000);
});