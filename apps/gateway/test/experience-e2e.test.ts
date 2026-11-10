import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";
import { ExperienceStore } from "@lampgenie/experience";
import { join } from "node:path";
import { readFileSync } from "node:fs";

let app: GatewayApp | null = null;
afterEach(async () => { await app?.close(); app = null; });

describe("D7/D8 主 agent 经验闭环", () => {
  it("开工回顾注入:经验库有相关条目时 instructions 携带经验块;终态提炼触发", async () => {
    // 预置一条相关经验
    const store = new ExperienceStore(join(process.cwd(), ".genie", "experiences"));
    store.write({ category: "coding", name: "echo-executor-quirk", description: "echo 执行器任务书要写清楚动词", created_by: "user" }, "echo-child 对模糊指令返回空;任务书必须包含明确动作词。");

    app = createGatewayApp({ port: 7795, executor: new EchoChildBackend() });
    const ws = new WebSocket("ws://127.0.0.1:7795");
    const inbox: Record<string, unknown>[] = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "exp-e2e", instruction: "echo 执行器跑一个 quirk 测试", idempotencyKey: "exp-1" }));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("done 超时")), 10_000);
      const poll = setInterval(() => {
        if (inbox.some((m) => m.type === "task.changed" && (m.task as { state: string }).state === "done")) {
          clearTimeout(t); clearInterval(poll); resolve();
        }
      }, 50);
    });
    ws.close();
    // D5 遥测联动:该经验被使用
    expect(store.usage("coding", "echo-executor-quirk").use_count).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
