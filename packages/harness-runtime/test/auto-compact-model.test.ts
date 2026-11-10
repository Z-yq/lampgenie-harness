/**
 * 压缩模型入账:compact.start / compact.done 的 payload 带 model,
 * 来源 opts.compactLlm 的 modelName ?? model,且在 compactLlm.chat() **之前**快照
 * (同 loop.ts 理由:modelName 是 getter,压缩途中热切换会读出新值)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCompact } from "../src/agent/auto-compact";

function longJournal() {
  const j = new MemoryJournal();
  for (let i = 0; i < 20; i++) {
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "很长很长的内容".repeat(50) } });
  }
  return j;
}

describe("auto-compact:压缩模型名入账", () => {
  it("compact.start / compact.done 的 model = 压缩模型,且在 chat() 前的快照值", async () => {
    const state = { model: "compact-model" };
    const compactLlm = {
      get modelName() { return state.model; },
      async chat() {
        state.model = "switched-after"; // 压缩途中热切换
        return { content: "摘要:压缩了" };
      },
    };
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", {
      thresholdTokens: 100, keepRecentMessages: 3, compactLlm, devlogDir: dir, force: true,
    });
    expect(r.compacted).toBe(true);
    const events = j.readAll();
    const start = events.find((e) => e.kind === "compact.start")?.payload as { model?: string };
    const done = events.find((e) => e.kind === "compact.done")?.payload as { model?: string };
    expect(start.model).toBe("compact-model");
    expect(done.model).toBe("compact-model");
    expect(done.model).not.toBe("switched-after");
    rmSync(dir, { recursive: true, force: true });
  });

  it("取不到模型名时不写该键(compact.start 仍在:过程事件)", async () => {
    const compactLlm = { async chat() { return { content: "摘要:压缩了" }; } };
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", {
      thresholdTokens: 100, keepRecentMessages: 3, compactLlm, devlogDir: dir, force: true,
    });
    expect(r.compacted).toBe(true);
    const events = j.readAll();
    const start = events.find((e) => e.kind === "compact.start")!.payload as Record<string, unknown>;
    const done = events.find((e) => e.kind === "compact.done")!.payload as Record<string, unknown>;
    expect("model" in start).toBe(false);
    expect("model" in done).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
