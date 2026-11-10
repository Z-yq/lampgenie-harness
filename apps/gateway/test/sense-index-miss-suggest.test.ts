/**
 * code_sense miss 建议器(a2,2026-11-03 命中率三修)。
 *
 * 契约:
 *  - miss 文本必须仍以「未找到符号」开头(sense-tool.ts 扇出过滤、agent-wiring.ts 依赖 startsWith 前缀);
 *  - 索引为空的分支逐字保持原文案(建议器只对非空索引生效);
 *  - 唯一近似命中 = 自动改查并带注记行;≥2 个候选 = 建议清单;路径形态 miss = 附纠偏行。
 * 索引为手工构造的最小 C2fIndex(按 c2f.ts 实际形状 nodes/byName/byFile)。
 */
import { describe, it, expect } from "vitest";
import { formatQuery } from "../src/sense-index-manager.js";
import type { C2fIndex, C2fNode } from "@lampgenie/code-sense";

function mkNode(partial: Partial<C2fNode> & { id: string; name: string; file: string; line: number }): C2fNode {
  return { kind: "regular", outCount: 0, inCount: 0, ...partial };
}

function mkIndex(nodes: C2fNode[]): C2fIndex {
  const index = {
    version: 1,
    root: "/tmp/fake-root",
    gitHead: "test",
    builtAt: 0,
    buildMs: 0,
    nodes,
    edges: [],
    byFile: {} as Record<string, string[]>,
    byName: {} as Record<string, string[]>,
  };
  for (const n of nodes) {
    (index.byFile[n.file] ??= []).push(n.id);
    (index.byName[n.name] ??= []).push(n.id);
  }
  return index as C2fIndex;
}

describe("formatQuery miss 建议器(a2)", () => {
  it("① 唯一 camelCase 近似命中 → 自动改查:注记行 + 符号详情", () => {
    const index = mkIndex([
      mkNode({ id: "src/engine.ts#WorkflowEngine.run", name: "WorkflowEngine.run", file: "src/engine.ts", line: 42, inCount: 3, outCount: 1 }),
      mkNode({ id: "src/engine.ts#WorkflowEngine.stop", name: "WorkflowEngine.stop", file: "src/engine.ts", line: 60, inCount: 1 }),
    ]);
    const out = formatQuery(index, "symbol", "runWorkflow");
    expect(out).toContain("未找到符号: runWorkflow,已按索引内唯一近似命中(自动改查 WorkflowEngine.run):");
    expect(out).toContain("WorkflowEngine.run [常规] — src/engine.ts:42"); // 符号详情行
    expect(out.startsWith("未找到符号: runWorkflow")).toBe(true); // 前缀契约不被破坏
  });

  it("② 多候选 → 首行仍是「未找到符号: X」+ 建议清单行(startsWith 契约)", () => {
    const index = mkIndex([
      mkNode({ id: "src/a.ts#WorkflowEngine.run", name: "WorkflowEngine.run", file: "src/a.ts", line: 10, inCount: 2 }),
      mkNode({ id: "src/b.ts#runWorkflowHelper", name: "runWorkflowHelper", file: "src/b.ts", line: 20, inCount: 0 }),
    ]);
    const out = formatQuery(index, "symbol", "runWorkflow");
    expect(out.startsWith("未找到符号: runWorkflow")).toBe(true);
    expect(out).toContain("(试试索引内近似符号: WorkflowEngine.run, runWorkflowHelper——symbol/impact 按精确名重查)");
    expect(out).not.toContain("已按索引内唯一近似命中");
  });

  it("③ 精确命中 → 正常符号详情,无任何注记", () => {
    const index = mkIndex([
      mkNode({ id: "src/a.ts#probeFn", name: "probeFn", file: "src/a.ts", line: 5, inCount: 1 }),
    ]);
    const out = formatQuery(index, "symbol", "probeFn");
    expect(out).toContain("probeFn [常规] — src/a.ts:5");
    expect(out).not.toContain("未找到符号");
    expect(out).not.toContain("近似");
  });

  it("④ 路径形态 miss(无候选)→ miss 行 + 纠偏行指向 action=file", () => {
    const index = mkIndex([
      mkNode({ id: "src/other.ts#Helper.parse", name: "Helper.parse", file: "src/other.ts", line: 1, inCount: 1 }),
    ]);
    const out = formatQuery(index, "symbol", "src/engine.ts");
    expect(out).toBe(
      '未找到符号: src/engine.ts\n(target 是路径形态:改用 action=file target="src/engine.ts" 查符号表)',
    );
  });

  it("⑤ 空索引 → 与现文案逐字一致(建议逻辑不接管空索引分支)", () => {
    const index = mkIndex([]);
    expect(formatQuery(index, "symbol", "runWorkflow")).toBe(
      "未找到符号: runWorkflow(索引为空——语言未被索引覆盖或索引残缺,已触发后台重建)",
    );
    expect(formatQuery(index, "impact", "runWorkflow")).toBe(
      "未找到符号: runWorkflow(索引为空——语言未被索引覆盖或索引残缺,已触发后台重建)",
    );
  });
});
