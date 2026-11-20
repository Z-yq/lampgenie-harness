/**
 * super agent 只读探索权 + 停止二次询问。
 * 锁三件事:
 * ① 工具面只有只读四件(read_file/glob/grep/list_dir),写类/命令类根本不在表里——
 * 「能看不能干」在工具层不可达,不靠模型自觉;
 * ② 只读工具真能读当前仓(围栏根=repoRoot,与 coding 轨同一 fencePath);
 * ③ 提示词写清「可读不可写」与「一句话结论+指向看板、不主动征询要不要列出」。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileJournal } from "@lampgenie/core";
import { MemoryStore } from "@lampgenie/runtime/agent/soul-memory";
import { buildSuperAgentTools, buildSuperAgentSystem, type SuperAgentDeps } from "../src/super-agent.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { ProjectRegistry } from "../src/projects.js";

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
  }
});

function deps(): SuperAgentDeps {
  return {
    journal: new FileJournal(join(tmpDir("sup-ro-j-"), "gateway.jsonl"), { writeBehind: true, sharded: true }),
    taskManager: new TaskSupervisor(),
    projects: new ProjectRegistry(null),
    llm: { async chat() { return { content: "" }; } },
  };
}

function toolMap(): Map<string, ReturnType<typeof buildSuperAgentTools>[number]> {
  const soul = new MemoryStore(join(tmpDir("sup-ro-s-"), "mem"));
  return new Map(buildSuperAgentTools(deps(), soul).map((t) => [t.name, t]));
}

describe("super agent 只读探索工具面(2026-11-16)", () => {
  it("工具面:只读四件在场,写类/命令类缺席", () => {
    const names = new Set(toolMap().keys());
    for (const n of ["read_file", "glob", "grep", "list_dir"]) expect(names.has(n), `${n} 必须在场`).toBe(true);
    for (const n of ["write_file", "edit_file", "bash", "run_cmd", "terminal", "exec"]) {
      expect(names.has(n), `${n} 不得出现在 super 工具面`).toBe(false);
    }
  });

  it("只读声明:四件 isReadOnly()===true", () => {
    const tools = toolMap();
    for (const n of ["read_file", "glob", "grep", "list_dir"]) {
      expect(tools.get(n)!.isReadOnly?.(), `${n} 必须声明只读`).toBe(true);
    }
  });

  it("真实执行:read_file/glob/grep 能读当前仓(repoRoot 围栏)", async () => {
    const tools = toolMap();
    const read = String(await tools.get("read_file")!.execute({ path: "package.json", limit: 5 }));
    expect(read, "read_file 返回带行号正文").toMatch(/^\s+1\t/);
 // 收窄到小目录:glob 无 "/" 的模式按 ** 语义整树走,在 9p 大仓上会超时
    const glob = String(await tools.get("glob")!.execute({ pattern: "package.json", path: "packages/protocol" }));
    expect(glob).toContain("package.json");
    const grep = String(await tools.get("grep")!.execute({ pattern: "lampgenie-harness", path: "package.json" }));
    expect(grep).toContain("package.json:");
  }, 60_000);

  it("提示词:可读不可写 + 一句话结论指向看板 + 不追问要不要列出", () => {
    const system = buildSuperAgentSystem(deps(), new MemoryStore(join(tmpDir("sup-ro-p-"), "mem")));
    expect(system).toContain("可读不可写");
    expect(system).toContain("read_file/glob/grep/list_dir");
    expect(system).toContain("不要为一个「看一眼」的问题开任务线");
    expect(system).toContain("没有 write_file/edit_file/bash");
    expect(system).toContain("一句话结论 + 指向看板/任务条目");
    expect(system).toContain("不主动征询「要不要列出");
    expect(system).toContain("只有用户明确说「展开/列出来/贴出来/看细节」才展开");
  });
});
