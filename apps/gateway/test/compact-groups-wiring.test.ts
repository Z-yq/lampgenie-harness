/**
 *  接线验收:auto-compact 必须真的用「组对齐」选 tail,且 compact.done 真的记下
 * tailStartId / tailGroupCount / groupAligned。
 * 只定义函数不接线 = 没生效(本仓反复出现「代码在、生产路径没接」的返工),故静态锁死源码锚点;
 * 再用假 Journal 跑一次 autoCompact 真路径,证明字段不是只写在注释里。
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryJournal } from "@lampgenie/core";
import { autoCompact } from "@lampgenie/runtime/agent/auto-compact";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");

const AUTO_COMPACT_SRC = src("packages/harness-runtime/src/agent/auto-compact.ts");
const GROUPS_SRC = src("packages/harness-runtime/src/agent/compact-groups.ts");

const dirs: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "m46-wiring-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe(" 组对齐接线(源码锚点)", () => {
  it("auto-compact 引入 compact-groups 并调用 alignTailGroups(messages, opts.keepRecentMessages)", () => {
    expect(AUTO_COMPACT_SRC).toContain('from "./compact-groups"');
    expect(AUTO_COMPACT_SRC).toContain("alignTailGroups(messages, opts.keepRecentMessages)");
  });

  it("旧任意下标切片已不存在(messages.slice(-opts.keepRecentMessages))", () => {
    expect(AUTO_COMPACT_SRC).not.toContain("messages.slice(-opts.keepRecentMessages)");
  });

  it("head 用组对齐后的 tailStartIndex 切,而不是 messages.length - keep", () => {
    expect(AUTO_COMPACT_SRC).toContain("messages.slice(0, aligned.tailStartIndex)");
    expect(AUTO_COMPACT_SRC).not.toContain("messages.slice(0, Math.max(0, messages.length - opts.keepRecentMessages))");
  });

  it("写边界前做 validateTailGrouping 自检,并整组回退(retry)", () => {
    expect(AUTO_COMPACT_SRC).toContain("validateTailGrouping(aligned.tail)");
    expect(AUTO_COMPACT_SRC).toContain("alignTailGroups(messages, aligned.tail.length + 1)");
    expect(AUTO_COMPACT_SRC).toContain("resolved-by-rollback");
  });

  it("compact.done 写 tailStartId / tailGroupCount / groupAligned", () => {
    expect(AUTO_COMPACT_SRC).toContain("tailStartId: aligned.tailStartId");
    expect(AUTO_COMPACT_SRC).toContain("tailGroupCount: aligned.groupCount");
    expect(AUTO_COMPACT_SRC).toContain("groupAligned: true");
  });

  it("compact.start 观测 tailWarnings(条件展开,无告警不写键)", () => {
    expect(AUTO_COMPACT_SRC).toContain("tailWarnings.length > 0 ? { tailWarnings }");
  });

  it("compact-groups 导出三件套(messageStableId / alignTailGroups / validateTailGrouping)", () => {
    for (const name of ["messageStableId", "alignTailGroups", "validateTailGrouping"]) {
      expect(GROUPS_SRC).toContain(`export function ${name}`);
    }
  });
});

describe(" 组对齐接线(行为)", () => {
  const fakeLlm: LlmProvider = { async chat() { return { content: "摘要:接线探针" }; } };

  it("真跑 autoCompact:done payload 三字段齐全,tail 首条是 assistant(不是 tool)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "任务:接线" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "旧历史" + "冗".repeat(3000) } });
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c1", name: "terminal", arguments: "{}" }] },
    });
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c1", content: "结果" } });

    const r = await autoCompact(j, "s", {
      thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeLlm, devlogDir: tmpDir(), force: true,
    });
    expect(r.compacted).toBe(true);

    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const p = done.payload as {
      tail?: { role: string }[];
      tailStartId?: string | null;
      tailGroupCount?: number;
      groupAligned?: boolean;
    };
    expect(p.groupAligned).toBe(true);
    expect(typeof p.tailStartId).toBe("string");
    expect(p.tailStartId).toMatch(/^m\d+:assistant:[0-9a-f]{8}$/);
    expect(p.tailGroupCount).toBe(1);
    expect(p.tail?.[0]?.role).toBe("assistant");
    expect(p.tail?.some((m) => m.role === "tool")).toBe(true); // tool 回执随组一起保留
  });
});
