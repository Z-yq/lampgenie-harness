/**
 * 指挥台会话级模型:super 轮次读 sid="super" 的覆盖(resolveTurnModel),缺省回退 deps.llm。
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { runSuperAgentTurn, superSessionId, type SuperAgentDeps } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";

const TIMEOUT = 120_000;
const soul = () => new MemoryStore(join(process.cwd(), ".genie", "soul", "memories-test"));

function base(): { d: SuperAgentDeps; hits: string[] } {
  const hits: string[] = [];
  const llm = { async chat() { hits.push("base"); return { content: "base-reply" }; } };
  const d = { taskManager: new TaskSupervisor(), projects: new ProjectRegistry(null), journal: new MemoryJournal(), llm } as unknown as SuperAgentDeps;
  return { d, hits };
}

describe("super 轮次会话级模型(2026-11-16)", () => {
  it("sid=super 有覆盖:用覆盖派生 llm,基础 llm 不被调用", async () => {
    const { d, hits } = base();
    const overrideHits: string[] = [];
    d.resolveTurnModel = (sid: string) => {
      if (sid !== superSessionId()) return undefined;
      return {
        llm: { async chat() { overrideHits.push("override"); return { content: "override-reply" }; } } as never,
        model: "deepseek-v4-pro",
        vision: true,
      };
    };
    const out = await runSuperAgentTurn(d, "只回一句话", soul());
    expect(overrideHits.length).toBeGreaterThan(0);
    expect(hits.length).toBe(0); // 未回退到全局 llm
    expect(out.text).toContain("override-reply");
  }, TIMEOUT);

  it("无覆盖:回退 deps.llm(旧行为逐字不变)", async () => {
    const { d, hits } = base();
    d.resolveTurnModel = () => undefined;
    const out = await runSuperAgentTurn(d, "只回一句话", soul());
    expect(hits.length).toBeGreaterThan(0);
    expect(out.text).toContain("base-reply");
  }, TIMEOUT);
});
