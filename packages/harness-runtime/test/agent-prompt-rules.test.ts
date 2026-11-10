import { describe, it, expect } from "vitest";
import { runContractEval } from "../src/eval/contract-eval";
import { AGENT_PROMPT_RULES } from "../src/eval/agent-prompt-rules";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 仓根:harness-runtime 包在仓库的 packages/ 下。 */
const repoRoot = process.cwd().replace(/packages[/\\]harness-runtime$/, "");

describe("主 agent 提示契约(常驻规则集,step-028 D5)", () => {
  it("规则集对真文件全绿", () => {
    const violations = runContractEval(AGENT_PROMPT_RULES, repoRoot);
    expect(violations).toEqual([]);
  });

  it("变异:删掉关键纪律句即红(经真实规则+真实 glob 路径)", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-mutate-"));
    try {
      const real = readFileSync(join(repoRoot, "apps/gateway/src/agent-wiring.ts"), "utf-8");
      // split/join=replaceAll(String.replace 只换首个匹配,import 行换了调用处还在,变异会假阴性)
      const mutated = real
        .split("如实说失败,不编造成功").join("汇报结果")
        .split("skillViewTool(store, () => disabledBuiltins(repoRoot())), experienceFoldTool(store)").join("")
        .split("composeSystemPrompt").join("makePrompt");
      mkdirSync(join(dir, "apps/gateway/src"), { recursive: true });
      writeFileSync(join(dir, "apps/gateway/src/agent-wiring.ts"), mutated, "utf-8");
      const violations = runContractEval(AGENT_PROMPT_RULES, dir);
      const rules = new Set(violations.map((v) => v.rule));
      expect(rules.has("主agent纪律句")).toBe(true);
      expect(rules.has("经验工具挂载(designs/18 §3)")).toBe(true);
      expect(rules.has("系统提示组装接线")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("变异:组装器护栏缺失即红", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-mutate2-"));
    try {
      mkdirSync(join(dir, "packages/harness-runtime/src/agent"), { recursive: true });
      writeFileSync(join(dir, "packages/harness-runtime/src/agent/system-composer.ts"), "export const x = 1;", "utf-8");
      const violations = runContractEval(AGENT_PROMPT_RULES, dir);
      expect(violations.some((v) => v.rule === "组装器护栏(system-composer)")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
