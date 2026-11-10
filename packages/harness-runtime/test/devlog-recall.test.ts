import { describe, it, expect } from "vitest";
import { recallDevlogs, renderDevlogBlock } from "../src/agent/devlog-recall";
import { AgentLoop } from "../src/agent/loop";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DevLog 检索注入(R5-C9 修复:step-009 P5 补账)", () => {
  let dir: string | null = null;
  const cleanup = () => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; } };

  it("summary 关键词命中→注入块;无命中/空目录/坏 json 零注入不炸", () => {
    dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    writeFileSync(join(dir, "devlog-s1-1.json"), JSON.stringify({
      sessionId: "s1", compactedAt: 1, summary: "修复了 pnpm 递归测试的退出码问题:unhandled error 污染",
    }));
    writeFileSync(join(dir, "devlog-s2-2.json"), JSON.stringify({
      sessionId: "s2", summary: "面板样式调整与 mermaid 渲染",
    }));
    writeFileSync(join(dir, "bad.json"), "{broken");

    const hit = recallDevlogs(dir, "pnpm 递归测试 退出码");
    expect(hit.length).toBe(1);
    expect(hit[0]!.file).toBe("devlog-s1-1.json");
    expect(hit[0]!.score).toBeGreaterThanOrEqual(4);
    const block = renderDevlogBlock(hit);
    expect(block).toContain("## 历史 DevLog 提示");
    expect(block).toContain("pnpm 递归测试");

    expect(recallDevlogs(dir, "完全不相关的查询词组")).toEqual([]);
    expect(recallDevlogs(join(dir, "not-exist"), "pnpm")).toEqual([]);
    expect(renderDevlogBlock([])).toBe("");
    cleanup();
  });

  it("AgentLoop compactHook 每 step 前被调(R5-C9:压缩链接线进 loop)", async () => {
    const journal = new MemoryJournal();
    const calls: string[] = [];
    const loop = new AgentLoop({
      journal,
      sessionId: "ch",
      system: "s",
      llm: { async chat() { return { content: "ok", toolCalls: [] }; } },
      tools: [],
      compactHook: async (_j, sid) => { calls.push(sid); },
    });
    await loop.runTurn("hi");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toBe("ch");
  });

  it("compactHook+autoCompact 全链:超阈值触发压缩并落 DevLog", async () => {
    const journal = new MemoryJournal();
    const dir2 = mkdtempSync(join(tmpdir(), "gh-devlog2-"));
    try {
      const { autoCompact } = await import("../src/agent/auto-compact");
      // 预置超阈值会话(阈值 20 token,塞长消息)
      for (let i = 0; i < 6; i++) {
        journal.append({ kind: "message.user", sessionId: "cc", payload: { text: `长消息 ${"x".repeat(200)} ${i}` } });
      }
      const r = await autoCompact(journal, "cc", {
        thresholdTokens: 20,
        keepRecentMessages: 2,
        compactLlm: { async chat() { return { content: "摘要:会话目标 X 已完成 Y", toolCalls: [] }; } },
        devlogDir: dir2,
      });
      expect(r.compacted).toBe(true);
      expect(journal.readAll().some((e) => e.kind === "compact.done")).toBe(true);
      expect(journal.readAll().some((e) => e.kind === "message.system" && JSON.stringify(e.payload).includes("上下文已压缩"))).toBe(true);
      // DevLog 落盘且可被 recall 检索(压缩→落盘→检索注入闭环)
      const recalled = recallDevlogs(dir2, "会话目标");
      expect(recalled.length).toBe(1);
      expect(recalled[0]!.summary).toContain("会话目标");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
