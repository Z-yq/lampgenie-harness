import { describe, expect, it } from "vitest";
import { spillToolResult, SPILL_MIDBLOCK_MIN_CHARS } from "../src/agent/tool-result-spill.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const big = Array.from({ length: 1200 }, (_, i) => `line-${i} ${i % 7 === 0 ? "docker compose logs" : "plain"}`).join("\n");

describe("spill E1 中段选块(缺口#24)", () => {
  const dir = mkdtempSync(join(tmpdir(), "spill-e1-"));
  it("scorer 在场且中段≥阈值:选中块贴回,标记带行号;一次定案写死", async () => {
    const scorer = async (blocks: Array<{ index: number; text: string }>, goal: string) => {
      expect(goal).toBe("docker 排查");
      return [blocks.findIndex((b) => b.text.includes("docker compose"))];
    };
    const out = await spillToolResult({
      dir, sessionId: "s1", callId: "c1", toolName: "run_cmd", content: big,
      goal: "docker 排查", scorer,
    });
    expect(out).toContain("[工具结果已精炼:");
    expect(out).toContain("保留高相关块:行 ");
    expect(out).toContain("docker compose logs");
  });
  it("scorer 缺席:固定头尾,零行为变化(不含选块标记)", async () => {
    const out = await spillToolResult({ dir, sessionId: "s2", callId: "c2", toolName: "run_cmd", content: big });
    expect(out).toContain("[工具结果已精炼:");
    expect(out).not.toContain("保留高相关块");
  });
  it("scorer 抛错:退回固定头尾(fail-open)", async () => {
    const out = await spillToolResult({
      dir, sessionId: "s3", callId: "c3", toolName: "run_cmd", content: big,
      goal: "g", scorer: async () => { throw new Error("boom"); },
    });
    expect(out).toContain("[工具结果已精炼:");
    expect(out).not.toContain("保留高相关块");
  });
  it("中段小于阈值:不触发选块", async () => {
    const smallMid = "x".repeat(6_800); // 头4096+尾1024 后中段=1680 <2000
    expect(smallMid.length - 4096 - 1024).toBeLessThan(SPILL_MIDBLOCK_MIN_CHARS);
    const out = await spillToolResult({
      dir, sessionId: "s4", callId: "c4", toolName: "run_cmd", content: smallMid,
      goal: "g", scorer: async () => [0],
    });
    expect(out).not.toContain("保留高相关块");
  });
  it("全文已落盘可回读", async () => {
    const out = await spillToolResult({ dir, sessionId: "s5", callId: "c5", toolName: "run_cmd", content: big });
    const m = /\[工具结果已精炼:[^\]]*?([^\s]+\.txt)/.exec(out);
    expect(m).toBeTruthy();
    expect(readFileSync(m![1]!, "utf8").length).toBe(big.length);
  });
  it("清理临时目录", () => { rmSync(dir, { recursive: true, force: true }); });
});
