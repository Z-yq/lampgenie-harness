/**
 * step-139 O1 深审策略闸测试:
 * ① decideDeepReview 纯函数三档(never/always/auto × 干净小变更/有 blocker/大 diff);
 * ② codeReview 引擎集成:auto 且干净小 diff → 0 次 LLM、summary 显式「深审跳过(auto…)」;
 *    有 blocker → 调 LLM;不传 policy(旧行为)= always 照常深审。
 * 背景(step-137 实测):深审跑满 8 分钟时间盒且零新增 findings(确定性层已 6→3 无 blocker)。
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeReview, type ReviewLlm } from "../src/review/index";
import { decideDeepReview, AUTO_DEEP_MAX_LINES, AUTO_DEEP_MAX_FILES } from "../src/review/policy";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-rev-pol-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g("config user.email t@t"); g("config user.name t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g('commit -qm "init"');
  return dir;
}

/** 计数 LLM(恒返回可解析的空 findings,不触发重试)。 */
function countingLlm(): { llm: ReviewLlm; calls: () => number } {
  let n = 0;
  return { calls: () => n, llm: { async chat() { n++; return { content: '{"findings":[]}' }; } } };
}

describe("decideDeepReview 纯函数(step-139 O1)", () => {
  it("never=恒不跑(fast 复跑);always=恒跑(deep 强制)", () => {
    const nv = decideDeepReview("never", { files: 1, totalLines: 10, blocking: 0 });
    expect(nv.run).toBe(false);
    expect(nv.note).toContain("policy=never");
    const al = decideDeepReview("always", { files: 99, totalLines: 99999, blocking: 5 });
    expect(al.run).toBe(true);
    expect(al.note).toContain("policy=always");
  });

  it("auto:干净且小(files ≤ 20 且 lines ≤ 1200)→ 跳过,note 含「需深审传 deep:true」", () => {
    const d = decideDeepReview("auto", { files: 3, totalLines: 1200, blocking: 0 });
    expect(d.run).toBe(false);
    expect(d.note).toContain("深审跳过(auto:确定性 0 blocker 且变更集小;需深审传 deep:true)");
    expect(AUTO_DEEP_MAX_LINES).toBe(1200);
    expect(AUTO_DEEP_MAX_FILES).toBe(20);
  });

  it("auto:有 blocker → 照常深审(note 说明原因)", () => {
    const d = decideDeepReview("auto", { files: 1, totalLines: 5, blocking: 1 });
    expect(d.run).toBe(true);
    expect(d.note).toContain("1 条 blocker");
  });

  it("auto:干净但大 diff(行数或文件数超门)→ 照常深审", () => {
    expect(decideDeepReview("auto", { files: 3, totalLines: 1201, blocking: 0 }).run).toBe(true);
    expect(decideDeepReview("auto", { files: 21, totalLines: 10, blocking: 0 }).run).toBe(true);
  });
});

describe("codeReview 引擎 llmPolicy 集成(step-139 O1)", () => {
  it("auto + 干净小 diff → 0 次 LLM,summary 显式「深审跳过(auto…)」", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n"); // 干净小变更
    const spy = countingLlm();
    const r = await codeReview(dir, { llm: spy.llm, llmPolicy: "auto" });
    expect(spy.calls()).toBe(0);
    expect(r.summary).toContain("深审跳过(auto:确定性 0 blocker 且变更集小;需深审传 deep:true)");
    // 免费层可能仍有非 blocker findings(本 fixture 出 1 条「孤独逻辑」warning 反模式)——auto 门只看 blocker。
    expect(r.findings.filter((f) => f.severity === "blocker")).toHaveLength(0);
    expect(r.findings.length).toBe(r.deterministic.length + r.antipatterns.length); // 全部来自免费层,深审零贡献
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("auto + 免费层有 blocker(疑似凭证)→ LLM 被调用", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), 'export const k = "sk-' + "NOTREALFIXTUREKEY0002" + '";\n'); // 运行时拼接的假凭证形态(命中确定性层 CRED_RE),源码不落凭证形字面量
    const spy = countingLlm();
    const r = await codeReview(dir, { llm: spy.llm, llmPolicy: "auto" });
    expect(spy.calls()).toBeGreaterThan(0); // 照常深审
    expect(r.deterministic.length).toBeGreaterThan(0); // blocker 来自确定性层
    expect(r.summary).not.toContain("深审跳过(auto");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("不传 policy(旧调用方)= always:干净小 diff 也照常深审(零回归)", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    const spy = countingLlm();
    const r = await codeReview(dir, { llm: spy.llm });
    expect(spy.calls()).toBeGreaterThan(0);
    expect(r.rounds?.length).toBeGreaterThan(0);
    expect(r.summary).toContain("LLM 深审");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("never=fast 复跑语义:有 LLM 也不调,summary 标 policy=never", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "export const b = 2;\n");
    const spy = countingLlm();
    const r = await codeReview(dir, { llm: spy.llm, llmPolicy: "never" });
    expect(spy.calls()).toBe(0);
    expect(r.summary).toContain("policy=never");
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
