/**
 * board.diagram 服务端 RPC 回路:5 节点板出图 / 1500ms 节流命中 / 缺板 / 缺 sid。
 * 脚手架与 board.test.ts 的 WS 回路同构(createGatewayApp 起端口 + ws 收帧 + 轮询等待)。
 */
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { saveBoard } from "../src/board-store.js";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { repoRoot } from "../src/repo-root.js";

const PORT = 7817;

/** 5 节点板(含分支流与一条边):覆盖决策节点形状与连线,足够验出 SVG 主体。 */
const fiveNodeDoc = {
  version: 1 as const,
  taskId: "dg1", sessionId: "s-dg", title: "出图 5 节点板", status: "draft" as const, rev: 0,
  nodes: [
    { id: "n1", kind: "start" as const, label: "收到 board.diagram", summary: "WS 请求入口", flow: [] },
    {
      id: "n2", kind: "function" as const, label: "loadBoard", summary: "按 taskId 读板", change: "modify" as const,
      flow: [
        { type: "step" as const, text: "缺省取会话最新板" },
        { type: "branch" as const, cond: "板存在?", then: [{ type: "step" as const, text: "继续出图" }], else: [{ type: "step" as const, text: "回 board-not-found" }] },
      ],
    },
    { id: "n3", kind: "function" as const, label: "serializeBoard", summary: "BoardDoc→OFK 文本", change: "add" as const, flow: [] },
    { id: "n4", kind: "function" as const, label: "renderBoardSvg", summary: "flowkit 编译并导出 SVG", change: "add" as const, flow: [] },
    { id: "n5", kind: "end" as const, label: "回 board.diagram.result", summary: "SVG+诊断", flow: [] },
  ],
  edges: [
    { from: "n1", to: "n2", kind: "call" as const, label: "读板" },
    { from: "n2", to: "n3", kind: "call" as const, label: "序列化" },
    { from: "n3", to: "n4", kind: "call" as const, label: "出图" },
    { from: "n4", to: "n5", kind: "call" as const, label: "回帧" },
  ],
  planned_files: ["apps/gateway/src/server.ts"],
  updatedAt: 0,
};

let app: GatewayApp | null = null;
let ws: WebSocket | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  ws?.close();
  ws = null;
  await app?.close();
  app = null;
  for (const c of cleanups.splice(0)) c();
});

/** 起 app + ws,返回收帧等待器(照 board.test.ts 的 wait 写法)。 */
async function connect(): Promise<{
  inbox: Record<string, unknown>[];
  wait: (pred: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  send: (m: Record<string, unknown>) => void;
}> {
  // companionLlm 桩:当前工作树 app.ts(他人未提交改动)把 super agent 轨缺省改成 coding 后会
  // 无条件 buildLlmFromConfig(opts.config 缺省 undefined → 读 config.coding 抛),传入桩可绕开;
  // 本测试不涉及 LLM。见报告「未完成项」。
  const llmStub = { chat: async () => ({ content: "" }) } as never;
  app = createGatewayApp({ port: PORT, executor: new EchoChildBackend(), companionLlm: llmStub });
  const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws = sock;
  const inbox: Record<string, unknown>[] = [];
  sock.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((r) => sock.on("open", r));
  const wait = (pred: (m: Record<string, unknown>) => boolean, ms = 30000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const cursor = inbox.length;
      const t = setTimeout(() => reject(new Error("等消息超时")), ms);
      const poll = setInterval(() => {
        const hit = inbox.slice(cursor).find(pred) ?? inbox.find(pred);
        if (hit) { clearTimeout(t); clearInterval(poll); resolve(hit); }
      }, 30);
    });
  return { inbox, wait, send: (m) => sock.send(JSON.stringify(m)) };
}

/** 板存 harness 根(生产语义)并登记清理。 */
function putBoard(taskId: string): string {
  const sid = "vitest-diagram-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  saveBoard(repoRoot(), { ...fiveNodeDoc, sessionId: sid, taskId });
  cleanups.push(() => rmSync(join(repoRoot(), ".genie", "boards", sid), { recursive: true, force: true }));
  return sid;
}

describe("board.diagram WS 回路", () => {
  it("5 节点板 → ok=true + svg 以 <svg 开头 + 无 W101(标点清洗)", async () => {
    const sid = putBoard("dg1");
    const { wait, send } = await connect();
    send({ v: 1, type: "board.diagram", sessionId: sid, taskId: "dg1" });
    const r = await wait((m) => m.type === "board.diagram.result");
    expect(r.ok).toBe(true);
    expect(String(r.svg).trim().startsWith("<svg")).toBe(true);
    const diags = (r.diagnostics ?? []) as { code?: string }[];
    expect(diags.some((d) => d.code === "W101")).toBe(false);
    expect(r.error).toBeUndefined();
  }, 60000);

  it("同 taskId 1500ms 内连发两次 → 第二次命中缓存(elapsedMs===0)", async () => {
    const sid = putBoard("dg2");
    const { wait, send } = await connect();
    send({ v: 1, type: "board.diagram", sessionId: sid, taskId: "dg2" });
    const first = await wait((m) => m.type === "board.diagram.result");
    expect(first.ok).toBe(true);
    send({ v: 1, type: "board.diagram", sessionId: sid, taskId: "dg2" });
    const second = await wait((m) => m.type === "board.diagram.result" && m.elapsedMs === 0);
    expect(second.elapsedMs).toBe(0);
    expect(second.svg).toBe(first.svg);
  }, 60000);

  it("不存在的 taskId → ok=false 且带 error(board-not-found,不抛)", async () => {
    const sid = putBoard("dg3-real");
    const { wait, send } = await connect();
    send({ v: 1, type: "board.diagram", sessionId: sid, taskId: "dg3-ghost" });
    const r = await wait((m) => m.type === "board.diagram.result");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("board-not-found");
  }, 60000);

  it("缺 sessionId → error 帧(与 board.get 同路径:信封校验拒收)", async () => {
    const { wait, send } = await connect();
    send({ v: 1, type: "board.diagram" });
    const e = await wait((m) => m.type === "error");
    expect(typeof e.code).toBe("string");
    expect(e.code).toBe("invalid-message");
  }, 30000);
});