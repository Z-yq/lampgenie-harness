/**
 * step-139 O1 工具面(codeReviewTool)三档合流测试:
 * fast=never > deep=always > 缺省 auto(干净小变更集 → 0 次 LLM 且说明写进回执)。
 * 引擎级纯函数/集成见 packages/code-sense/test/review-policy.test.ts。
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeReviewTool } from "../src/agent-wiring.js";
import { MemoryJournal } from "@lampgenie/core";
import type { LlmProvider } from "@lampgenie/runtime/agent/loop";

function cleanSmallRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-rev-auto-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g('commit -qm "init"');
  appendFileSync(join(dir, "a.ts"), "export const b = 2;\n"); // 干净小变更
  return dir;
}

/** 凭证形态 fixture:运行时拼出(命中确定性层 CRED_RE → blocker),源码 diff 不落凭证形字面量。 */
const FAKE_KEY = ["sk-", "NOTREAL", "FIXTURE", "KEY", "0001"].join("");

function spyLlm(counter: { n: number }): LlmProvider {
  return { async chat() { counter.n++; return { content: '{"findings":[]}' }; } };
}

describe("codeReviewTool 三档(fast/deep/auto,step-139 O1)", () => {
  it("缺省 auto + 干净小变更集 → 0 次 LLM,回执显式「深审跳过(auto…)」", async () => {
    const dir = cleanSmallRepo();
    const counter = { n: 0 };
    const j = new MemoryJournal();
    const out = String(await codeReviewTool(dir, spyLlm(counter), j, "sess-auto").execute({}));
    expect(counter.n).toBe(0);
    expect(out).toContain("深审跳过(auto:确定性 0 blocker 且变更集小;需深审传 deep:true)");
    const ev = j.readAll().find((e) => e.kind === "review.findings")?.payload as { llmPolicy?: string };
    expect(ev?.llmPolicy).toBe("auto");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("deep:true 强制深审(同现场也要调 LLM)", async () => {
    const dir = cleanSmallRepo();
    const counter = { n: 0 };
    const out = String(await codeReviewTool(dir, spyLlm(counter), new MemoryJournal(), "sess-deep").execute({ deep: true }));
    expect(counter.n).toBeGreaterThan(0);
    expect(out).not.toContain("深审跳过(auto");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("fast:true=never(零 LLM,与 deep 同时在场时 fast 优先)", async () => {
    const dir = cleanSmallRepo();
    const counter = { n: 0 };
    const out = String(await codeReviewTool(dir, spyLlm(counter), new MemoryJournal(), "sess-fast").execute({ fast: true, deep: true }));
    expect(counter.n).toBe(0);
    expect(out).toContain("确定性");
    const out2 = String(await codeReviewTool(dir, spyLlm(counter), new MemoryJournal(), "sess-fast2").execute({ fast: true }));
    expect(counter.n).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("auto + 免费层有 blocker(疑似凭证)→ 照常调 LLM", async () => {
    const dir = cleanSmallRepo();
    appendFileSync(join(dir, "a.ts"), 'export const k = "' + FAKE_KEY + '";\n'); // 命中确定性层凭证红线(运行时拼接,源码不落凭证形字面量)
    const counter = { n: 0 };
    const out = String(await codeReviewTool(dir, spyLlm(counter), new MemoryJournal(), "sess-blk").execute({}));
    expect(counter.n).toBeGreaterThan(0);
    expect(out).not.toContain("深审跳过(auto");
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
