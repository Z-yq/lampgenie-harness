/**
 * symbol 容错回退 CLI/MCP 面单测(2026-10-21 批次 B):
 * 实锤:symbol INIT_DETECTOR --root py-mmdetection 与 symbol initdetect 都直接
 * 「未找到符号」断链。修复面=①文本面「你是不是想找: …」②--json suggestions 字段;
 * dispatchTool(CLI 文本/MCP tools/call)与 runCli --json 两面同源。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeIndexMcp } from "../src/mcp-core.js";
import { runCli, type CliIo } from "../src/cli.js";
import { buildC2fIndex, saveIndex } from "@lampgenie/code-sense";

let ws = "";

async function setup(): Promise<void> {
  if (ws) return; // 幂等:多用例共享同一夹具
  ws = mkdtempSync(join(tmpdir(), "cs-suggest-"));
  writeFileSync(join(ws, "det.ts"), [
    "export function init_detector(x: number): number { return x; }",
    "export function process_chat(msg: string): string { return init_detector(msg.length) + msg; }",
    "export function unrelatedThing(): void { return; }",
    "",
  ].join("\n"));
  // ts-morph 高负载下偶发整图空解析(仓内既有已知抖动,懒图缓存注释同源):空索引重试一次
  let idx = await buildC2fIndex(ws);
  if (idx.nodes.length === 0) idx = await buildC2fIndex(ws);
  saveIndex(ws, idx);
}

afterAll(() => {
  if (ws) rmSync(ws, { recursive: true, force: true });
});

function capture(): { io: CliIo; out: () => string } {
  const o: string[] = [];
  return { io: { out: (s) => (o.push(s), undefined), err: () => undefined }, out: () => o.join("\n") };
}

describe("symbol 容错回退(文本面=dispatchTool;JSON 面=suggestions 字段)", () => {
  it("实锤 1:INIT_DETECTOR → 文本面建议 init_detector;直接给出命中", async () => {
    await setup();
    const mcp = createCodeIndexMcp(ws, { autoBuild: false });
    const r = mcp.dispatchTool("code_index_symbol", { name: "INIT_DETECTOR" });
    expect(r.isError).toBe(false);
    expect(r.content[0]!.text).toContain("未找到符号: INIT_DETECTOR");
    expect(r.content[0]!.text).toContain("你是不是想找");
    expect(r.content[0]!.text).toContain("init_detector");
  }, 60_000);

  it("实锤 2:initdetect → 近似建议(编辑距离≤2 档)", async () => {
    await setup();
    const mcp = createCodeIndexMcp(ws, { autoBuild: false });
    const r = mcp.dispatchTool("code_index_symbol", { name: "initdetect" });
    expect(r.content[0]!.text).toContain("你是不是想找");
    expect(r.content[0]!.text).toContain("init_detector");
  });

  it("--json suggestions 字段在(miss 时给,hit 时不添噪声)", async () => {
    const miss = capture();
    const missCode = await runCli(["symbol", "INIT_DETECTOR", "--root", ws, "--json", "--quiet", "--no-build"], miss.io);
    expect(missCode).toBe(1);
    const missJson = JSON.parse(miss.out());
    expect(missJson.hitCount).toBe(0);
    expect(missJson.suggestions).toContain("init_detector");

    const hit = capture();
    const hitCode = await runCli(["symbol", "init_detector", "--root", ws, "--json", "--quiet", "--no-build"], hit.io);
    expect(hitCode).toBe(0);
    const hitJson = JSON.parse(hit.out());
    expect(hitJson.hitCount).toBe(1);
    expect(hitJson.suggestions).toBeUndefined();
  }, 120_000);

  it("CLI 文本面与 dispatchTool 同源(同一句建议文案)", async () => {
    const cap = capture();
    await runCli(["symbol", "initdetect", "--root", ws, "--quiet", "--no-build", "--no-color"], cap.io);
    const mcp = createCodeIndexMcp(ws, { autoBuild: false });
    const r = mcp.dispatchTool("code_index_symbol", { name: "initdetect" });
    expect(cap.out().trim()).toBe(r.content[0]!.text.trim());
  }, 120_000);
});
