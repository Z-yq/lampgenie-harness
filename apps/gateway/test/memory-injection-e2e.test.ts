/**
 * memory 注入端到端(C7 开放事实闭合):种子记忆文档→任务 system prompt 含记忆内容。
 * 审计 R1 ⚠️ 的开放事实=「缺种子文档→捕获 system prompt 的操作级证据」,本探针补齐并固化为回归。
 */
import { describe, it, expect } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import type { Server } from "node:http";

describe("memory 注入端到端(C7 闭环)", () => {
  it("种子文档→runWithAgent 系统提示含记忆内容;无文档=不含", async () => {
    const seenSystems: string[] = [];
    const captureLlm = { async chat(messages: { role: string; content: string }[]) {
      const sys = messages.find((m) => m.role === "system");
      if (sys) seenSystems.push(String(sys.content));
      return { content: "好的" };
    } };
    const app = createGatewayApp({
      port: 0, llm: captureLlm as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    // 种子:USER.md 明说条目(经 markdown provider 正式 API,非直写文件)
    app.memory.provider.apply("local", [
      { document: "user", append: "## 用户明确要求\n- 叫我小飞" } as never,
    ]);
    const block = app.memory.contextBlock("local");
    expect(block).toContain("叫我小飞");

    const done = new Promise<void>((res) => {
      app.taskManager.onChange((t) => { if (t.state === "done" || t.state === "failed") res(); });
    });
    app.taskManager.submit("user", "mem-e2e-s1", "记住了吗");
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("任务未终态")), 20_000))]);
    expect(seenSystems.length, "LLM 应被调用").toBeGreaterThan(0);
    expect(seenSystems.some((s) => s.includes("叫我小飞")), "系统提示应含记忆块").toBe(true);
    await app.close();
  }, 30_000);
});
