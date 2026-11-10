/**
 * import_meeting 工具级单测(C8 开放事实闭合):fixture 纪要+fake LLM→抽取产物落盘。
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("import_meeting 工具", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `mtg-tool-${Date.now()}`);
  const fixture = join(dir, "minutes.md");
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("纪要→抽取 JSON(draftPath+结构化四节)", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(fixture, "# 周会纪要\n议题:发布节奏\n决议:周五上线\n待办:张三写周报\n开放问题:域名选型");
    const { meetingImportTool } = await import("../src/meeting-tools.js");
    const fakeLlm = { async chat() {
      return { content: JSON.stringify({ topics: ["发布节奏"], decisions: ["周五上线"], todos: [{ content: "写周报", owner: "张三" }], openQuestions: ["域名选型"] }) };
    } };
    const tool = meetingImportTool(fakeLlm as never);
    const out = String(await tool.execute({ path: fixture }));
    const parsed = JSON.parse(out) as { draftPath: string; extraction: { topics: string[]; todos: { content: string }[] } };
    expect(parsed.extraction.topics).toEqual(["发布节奏"]);
    expect(parsed.extraction.todos[0]!.content).toBe("写周报");
    expect(existsSync(parsed.draftPath)).toBe(true);
  });

  it("路径不存在→错误可见(不静默)", async () => {
    const { meetingImportTool } = await import("../src/meeting-tools.js");
    const tool = meetingImportTool({ async chat() { return { content: "{}" }; } } as never);
    const out = String(await tool.execute({ path: "/nonexistent/ minutes.md" }));
    expect(out.startsWith("错误:")).toBe(true);
  });
});
