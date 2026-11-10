/**
 * board_upsert schema 体量基线（防回涨）。
 *
 * **口径必须与 trace 一致**：trace 记录的是 `attachToolView()` 之后的 wire 规格（长 description
 * 会被 summarizeToolDescription 摘要）。直接取 boardUpsertTool 的原始 description 会把约 1.9k 的
 * 完整说明书算进去，得出「瘦身反而变大」的假结论（2026-10-31 实测踩过这个坑）。
 */
import { it, expect } from "vitest";
import { boardUpsertTool } from "../src/agent-wiring.js";
import { attachToolView } from "../src/tool-view.js";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 与 trace 同口径（attachToolView 摘要化后）的 board_upsert wire 体量。 */
function wireSize(): { whole: number; params: number; desc: number } {
  const root = mkdtempSync(join(tmpdir(), "gh-schema-"));
  try {
    const raw = boardUpsertTool(new MemoryJournal(), "s1", "t1", root, root);
    const [wire] = attachToolView([raw]);
    const t = wire!;
    const params = JSON.stringify(t.parameters).length;
    return {
      whole: JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length,
      params,
      desc: t.description.length,
    };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it("board_upsert wire 体量不超基线 6733（attachToolView 后，与 trace 同口径）", () => {
  const s = wireSize();
  console.log(`[schema-wire] whole=${s.whole} params=${s.params} desc=${s.desc}`);
  // 瘦身前基线（真实 trace 实测）6733；散文压缩与新增 evidenceByNode 相抵后不得增长。
  expect(s.whole, `wire ${s.whole} 不得超基线 6733`).toBeLessThanOrEqual(6733);
});

it("evidenceByNode 参数在位（批量回填能力不能因瘦身被删）", () => {
  const root = mkdtempSync(join(tmpdir(), "gh-schema2-"));
  try {
    const raw = boardUpsertTool(new MemoryJournal(), "s1", "t1", root, root);
    const props = (raw.parameters as { properties: Record<string, { type?: string; description?: string; additionalProperties?: unknown }> }).properties;
    expect(props.evidenceByNode?.type).toBe("object");
    expect(props.evidenceByNode?.additionalProperties).toBeTruthy();
    expect(props.nodeId).toBeTruthy(); // 单节点旧路径必须保留（向后兼容）
  } finally { rmSync(root, { recursive: true, force: true }); }
});