import { describe, it, expect } from "vitest";
import { runContractEval } from "../src/eval/contract-eval";

describe("L1 契约 eval", () => {
  it("主 agent 提示词含关键纪律(防漂移)", () => {
    const violations = runContractEval([{
      name: "主agent纪律",
      target: "apps/gateway/src/agent-wiring.ts",
      mustContain: ["spawn_subagent", "主 agent"],
      mustNotContain: ["sk-proj", "sk-ant", "sk_live"], // 凭证红线(精确前缀,裸 sk- 会误伤 task-manager)
    }], process.cwd().replace(/packages\/harness-runtime$/, ""));
    expect(violations).toEqual([]);
  });
  it("变异注入:删掉关键语句即红", () => {
    // 用一个临时文件模拟破坏
    const { writeFileSync, mkdtempSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), "gh-contract-"));
    writeFileSync(join(dir, "bad.ts"), "// 没有纪律");
    const v = runContractEval([{ name: "r", target: "bad.ts", mustContain: ["必须有"] }], dir);
    expect(v.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
