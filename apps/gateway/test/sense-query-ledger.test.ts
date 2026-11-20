/**
 * 改前链路台账:覆盖判定(file 精确/后缀容忍;符号词边界;refs 不计入)。
 */
import { describe, it, expect } from "vitest";
import { createSenseQueryLedger } from "../src/sense-query-ledger.js";

describe("createSenseQueryLedger", () => {
  it("file 动作 target==rel → 覆盖", () => {
    const l = createSenseQueryLedger();
    l.record("file", "src/a.ts");
    expect(l.coversFile("src/a.ts", "")).toBe(true);
  });
  it("file 动作后缀容忍(根收窄前缀)", () => {
    const l = createSenseQueryLedger();
    l.record("file", "src/a.ts");
    expect(l.coversFile("apps/gateway/src/a.ts", "")).toBe(true);
  });
  it("impact 符号词边界命中文件内容 → 覆盖", () => {
    const l = createSenseQueryLedger();
    l.record("impact", "gate");
    expect(l.coversFile("src/a.ts", "function gate() { return 1; }")).toBe(true);
  });
  it("子串不误判:gate 不覆盖 gatePolicy", () => {
    const l = createSenseQueryLedger();
    l.record("impact", "gate");
    expect(l.coversFile("src/a.ts", "function gatePolicy() { return 1; }")).toBe(false);
  });
  it("带点符号名(AgentLoop.runTurn)正确转义匹配", () => {
    const l = createSenseQueryLedger();
    l.record("symbol", "AgentLoop.runTurn");
    expect(l.coversFile("src/loop.ts", "await AgentLoop.runTurn(x)")).toBe(true);
    expect(l.coversFile("src/loop.ts", "AgentLoopXrunTurn")).toBe(false);
  });
  it("refs/surface 不计入符号覆盖", () => {
    const l = createSenseQueryLedger();
    l.record("refs", "gate");
    l.record("surface", "gate");
    expect(l.coversFile("src/a.ts", "function gate() {}")).toBe(false);
  });
  it("空台账 / 空 rel → 不覆盖", () => {
    const l = createSenseQueryLedger();
    expect(l.coversFile("src/a.ts", "anything")).toBe(false);
    l.record("file", "src/a.ts");
    expect(l.coversFile("", "")).toBe(false);
  });
  it("queries 留痕可查", () => {
    const l = createSenseQueryLedger();
    l.record("impact", "foo");
    l.record("", "x"); // 空 action 不入账
    expect(l.queries()).toEqual([{ action: "impact", target: "foo" }]);
  });
});
