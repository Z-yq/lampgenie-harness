/** super agent 轮末收尾:runSuperAgentTurn 落六机制事件并追加「## 收尾审计」。 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { runSuperAgentTurn, superSessionId } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";

describe("super 轮末收尾", () => {
  it("turn 后落 guidance.metrics/verify.ledger/completion.audit,正文含引用行与「## 收尾审计」", async () => {
    const journal = new MemoryJournal();
    const sid = superSessionId();
    // 预置一条引用登记(任务窗口外,readCitations 仍可见):让终稿 [1] 通过引用审计 → 非 na 项产生收尾段。
    journal.append({
      kind: "custom", sessionId: sid,
      payload: { type: "citation.registered", taskId: sid, n: 1, url: "https://example.com/a", quote: "示例引文", at: Date.now() },
    });
    const deps = {
      journal,
      taskManager: new TaskSupervisor(),
      projects: new ProjectRegistry(null),
      llm: { async chat() { return { content: "现状见 [1]:主仓已完成一个任务。" }; } } as never,
    };
    const soulStore = new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-closeout-test"));
    const out = await runSuperAgentTurn(deps as never, "调研一下当前现状", soulStore);

    expect(out.text).toContain("主仓已完成一个任务");
    expect(out.text).toContain("## 收尾审计");
    const evs = journal.readAll().filter((e) => e.sessionId === sid);
    const types = evs
      .filter((e) => e.kind === "custom")
      .map((e) => String((e.payload as { type?: string } | undefined)?.type ?? ""));
    expect(types).toContain("guidance.metrics");
    expect(types).toContain("verify.ledger");
    expect(types).toContain("citation.audit");
    expect(types).toContain("completion.audit");
  }, 90_000);
});
