/**
 * 参数级优选措辞契约:
 * terminal 的 commands 参数描述里「一次往返批量(优选)」一句话,把批处理采用率从 0% 拉到 67%→94%
 * (经验证见)。本测试把同款做法固化成契约:
 * 高频工具里存在「多合一/批量/复用」优选形态的参数,description 必须写清优选措辞 ——
 * 措辞出现在模型构造参数的那一刻,胜过任何跨步 tips。
 * 断言口径:措辞必须真的长在 parameters.properties.<参数>.description 上(不是工具级 description),
 * 且这些工具的参数键集合不因措辞改动而变(只加句子不新增参数)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { createFileTools } from "../src/file-tools.js";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { codeSenseTool } from "../src/sense-tool.js";

type ToolLike = { name: string; parameters?: unknown; isConcurrencySafe?(args: unknown): boolean };
const root = mkdtempSync(join(tmpdir(), "param-wording-"));
const journal = new MemoryJournal();
const fileTools = createFileTools({ root, journal, sessionId: "wording" });
const byName = new Map<string, ToolLike>(
  (fileTools as unknown as ToolLike[]).map((t) => [t.name, t]),
);

type PropSchema = { description?: string; type?: string };
function paramDesc(tool: { parameters?: unknown }, param: string): string {
  const props = (tool.parameters as { properties?: Record<string, PropSchema> }).properties ?? {};
  return props[param]?.description ?? "";
}
function paramKeys(tool: { parameters?: unknown }): string[] {
  const props = (tool.parameters as { properties?: Record<string, PropSchema> }).properties ?? {};
  return Object.keys(props).sort();
}

describe("参数级优选措辞(多处一次做完,勿逐步串行)", () => {
  it("read_file.path 写明同一步并发多条(无状态只读工具)", () => {
    const t = byName.get("read_file")!;
    const d = paramDesc(t, "path");
    expect(d).toContain("同一步并发");
    expect(d).toContain("read_file");
    expect(t.isConcurrencySafe?.({})).toBe(true);
  });

  it("grep.pattern 写明 alternation 合并多关键词 + 必要时并发", () => {
    const d = paramDesc(byName.get("grep")!, "pattern");
    expect(d).toContain("alternation");
    expect(d).toContain("preferred over");
    expect(d).toContain("并发");
  });

  it("board_upsert.nodes/edges 写明一次提交整板(upsert 无局部 patch 语义)", () => {
    const t = boardUpsertTool(journal, "wording", "task-wording", root);
    const nodesDesc = paramDesc(t, "nodes");
    const edgesDesc = paramDesc(t, "edges");
    expect(nodesDesc).toContain("一次提交");
    expect(nodesDesc).toContain("preferred over");
    expect(nodesDesc).toContain("patch");
    expect(edgesDesc).toContain("同一次提交");
  });

  it("code_sense.target 写明一次拿整表(勿逐符号循环)", () => {
    const d = paramDesc(codeSenseTool(root), "target");
    expect(d).toContain("One call, whole table");
    expect(d).toContain("preferred over");
  });

  it("工具参数键集合:read_file 因读去重新增 force,其余三工具保持不变", () => {
    // force=读去重机制(2026-11)的显式重注入开关,不是措辞改造新增的参数。
    expect(paramKeys(byName.get("read_file")!)).toEqual(["force", "limit", "offset", "path"]);
    expect(paramKeys(byName.get("grep")!)).toEqual(["-i", "glob", "head_limit", "output_mode", "path", "pattern"]);
    expect(paramKeys(codeSenseTool(root))).toEqual(["action", "level", "maxNodes", "mode", "query", "root", "target"]);
    expect(paramKeys(boardUpsertTool(journal, "wording", "task-wording", root))).toContain("nodes");
  });
});