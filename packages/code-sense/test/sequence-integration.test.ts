import { describe, it, expect } from "vitest";
import { codeSense } from "../src/index";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");

describe("debug 剖面接入 sequence(修复: 孤儿能力接线)", () => {
  it("debug 查询返回聚焦符号的静态执行序(步骤+行号真实)", async () => {
    const r = await codeSense(REPO, "startNodeAgent", { mode: "debug", depth: 1 });
    expect(r.mode).toBe("debug");
    expect(r.callchain?.center.name).toBeTruthy();
    expect(r.sequence).toBeTruthy();
    expect(r.sequence!.steps.length).toBeGreaterThan(0);
    const withLine = r.sequence!.steps.filter((s: { line?: number }) => typeof s.line === "number");
    expect(withLine.length).toBeGreaterThan(0);
  }, 120_000);
});
