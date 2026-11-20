/**
 * trace 前缀健康信号聚合(设计稿 §4.6.2 缺口3 闭环:
 * `frozenCount` / `prefixBreak` / `budgetExceeded` 三个 context.prune 字段此前只有产出没有消费方。
 */
import { describe, it, expect } from "vitest";
import { deriveTraceStats } from "../src/agent/trace-stats";

const prune = (payload: Record<string, unknown>) => ({ kind: "context.prune", payload });

describe("trace-stats:prefixSignals", () => {
  it("无 context.prune 事件时不出现该键(旧 journal 不造数)", () => {
    const stats = deriveTraceStats([{ kind: "turn.start", payload: {} }]);
    expect(stats.prefixSignals).toBeUndefined();
  });

  it("聚合 prunes/prefixBreaks/budgetExceeded/frozenCountLast", () => {
    const stats = deriveTraceStats([
      prune({ prefixBreak: false, frozenCount: 12, budgetTokens: 9000 }),
      prune({ prefixBreak: true, frozenCount: 20 }),
      prune({ budgetExceeded: true }),
    ]);
    expect(stats.prefixSignals).toMatchObject({
      prunes: 3,
      prefixBreaks: 1,
      budgetExceeded: 1,
      frozenCountLast: 20,
    });
  });

  it("非布尔标记不计入(只认 === true,防旧字段形态污染)", () => {
    const stats = deriveTraceStats([prune({ prefixBreak: "yes", budgetExceeded: 1 })]);
    expect(stats.prefixSignals).toMatchObject({ prunes: 1, prefixBreaks: 0, budgetExceeded: 0 });
  });
});