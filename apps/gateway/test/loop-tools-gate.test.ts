/**
 * 主 loop 工具面门禁回归:「工具未配置」观测的机制形态=空 tools 时 provider 不带
 * tools 字段(纯文本对话)。本套锚定两件事:
 * 1) 主 loop 每任务开工必落 task.progress.tools 清单(journal 一手证据面,供任何质疑回查);
 * 2) 主 loop 工具面含文件六件套与派发工具(装配非空的可执行断言;空面分支是防御性 fail-visible,
 *    现装配为数组字面量不可触发,不硬造注入面)。
 * 子代理白名单错配 fail-visible 见 llm-loop-backend.test.ts。
 */
import { it, expect, beforeAll } from "vitest";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";

beforeAll(() => {
  process.env.GENIE_CHECKPOINT = "off"; // 测试提速:跳过 git stash create
  process.env.GENIE_PERM_ASK_MODE = "allow";
});

it("主 loop 开工落 tools 清单进 journal(task.progress.tools);装配含文件六件套与派发工具", async () => {
  const app: GatewayApp = createGatewayApp({
    port: 0,
    llm: { async chat() { return { content: "收到(纯文本回复,不调工具)" }; } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  try {
    app.taskManager.submit("user", "s064-gate-1", "报告你的工具面(此任务由  门禁测试驱动)");
    for (let i = 0; i < 100; i++) {
      const t = app.taskManager.list().find((x) => x.sessionId === "s064-gate-1");
      if (t && (t.state === "done" || t.state === "failed")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const t = app.taskManager.list().find((x) => x.sessionId === "s064-gate-1");
    expect(t?.state, "任务应完成").toBe("done");
    const manifest = [...app.journal.readAll()]
      .reverse()
      .find((e) => e.kind === "task.progress" && Array.isArray((e.payload as { tools?: string[] }).tools));
    expect(manifest, "tools 清单事件必须在案(请求发出前的装配快照)").toBeTruthy();
    const tools = (manifest!.payload as { tools: string[] }).tools;
    for (const required of ["spawn_subagent", "read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "todo_write", "task_output", "terminal"]) {
      expect(tools, `工具面必含 ${required}`).toContain(required);
    }
    expect((manifest!.payload as { toolCount: number }).toolCount).toBe(tools.length);
  } finally {
    await app.close();
  }
}, 30_000);
