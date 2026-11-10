/**
 * ppt-master 产出角色装配对拍。
 * 两处契约(S 级改动,但都是「声明写对了、执行面没生效」的典型坑,必须真 spawn 验):
 *  ①白名单声明的 board_export_pptx / board_read 来自 extraTools,不在内置池里——
 *    如果 agent-wiring 不按角色挂导出工具,声明会被静默过滤,子代理永远拿不到质量门;
 *  ②planner 仍不给导出工具(分工:规划出结构,产出角色生成文件),防这次改动把口子开回 planner。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { buildSubagentExtraTools, resolveSubagentCapability } from "../src/agent-wiring.js";
import { BUILTIN_AGENT_PROFILES } from "@lampgenie/runtime/agent/agent-profiles";

const mk = () => mkdtempSync(join(tmpdir(), "pptmaster-"));

/** 按生产装配路径挂工具(与 agent-wiring spawnTool 的 deckRoleEarly 分支同形)。 */
function deckTools(dir: string, taskId = "t1") {
  const journal = new MemoryJournal();
  return buildSubagentExtraTools(dir, [], new ExperienceStore(dir), {
    journal,
    sessionId: "s1",
    owner: "sub-t",
    deckExport: { taskId, taskRoot: dir },
  });
}

describe("ppt-master 能力计划", () => {
  it("声明=declared(不是角色二分兜底),白名单含导出与读板", () => {
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "ppt-master");
    expect(cap.source).toBe("declared");
    expect(cap.toolWhitelist).toContain("board_export_pptx");
    expect(cap.toolWhitelist).toContain("read");
    expect(cap.toolWhitelist).toContain("exec");
    // 不派子代理:派发能力必须结构性缺席(否则又造出一个能自派工的层)
    expect(cap.toolWhitelist).not.toContain("spawn_subagent");
  });

  it("装配面真的挂上 board_export_pptx(声明在 extraTools 里,靠角色接线才生效)", () => {
    const dir = mk();
    const names = deckTools(dir).map((t) => t.name);
    expect(names).toContain("board_export_pptx");
    expect(names).toContain("board_read");
    expect(names).toContain("terminal");
  });

  it("export 工具真能跑(mode=export 无源稿时给出可执行指引,不是白面)", async () => {
    const dir = mk();
    const t = deckTools(dir).find((x) => x.name === "board_export_pptx")!;
    const out = String(await t.execute({ mode: "export" } as never));
    expect(out).toContain("需要 source");
    // 源稿存在但内容薄:必须被质量门点名拒导(证明挂的是真工具而非空壳)
    const src = join(dir, "docs", "review", "x.deck.md");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "docs", "review"), { recursive: true });
    writeFileSync(src, "# 汇报\n\n## 01 章\n\n### 页\n- 一条\n", "utf8");
    const out2 = String(await t.execute({ mode: "export", source: src } as never));
    expect(out2).toContain("导出被拒");
    expect(out2).not.toContain("已导出");
  });
});

describe("真 spawn:ppt-master 工具面 = 读四件 + 写两件 + exec + 认知 + 导出", () => {  it("chat 收到的工具名集与声明展开集一致(不含 mcp/派发类)", async () => {
    const dir = mk();
    const cap = resolveSubagentCapability(BUILTIN_AGENT_PROFILES, "ppt-master");
    const seen: string[] = [];
    const backend = new LlmLoopBackend({
      roots: [dir], workdir: dir, role: "ppt-master", stallTimeoutMs: 30_000,
      toolWhitelist: cap.toolWhitelist,
      extraTools: deckTools(dir),
      llm: {
        async chat(_m: unknown, tools: { name: string }[]) {
          for (const t of tools) if (!seen.includes(t.name)) seen.push(t.name);
          return { content: "done" };
        },
      } as never,
    });
    await backend.spawn({ taskId: "t", instructions: "探针任务", workdir: dir, permissions: "sandbox" }, () => {});
 // bridge 三件套恒定追加
    expect(seen.sort()).toEqual([
      "board_export_pptx", "board_read", "code_sense", "edit_file", "glob", "grep",
      "list_dir", "read_file", "run_cmd", "skill_view", "tool_call", "tool_search", "tool_view", "write_file",
    ]);
  }, 30_000);
});
