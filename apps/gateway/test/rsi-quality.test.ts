/**
 * RSI 结果质量评估(质量契约 v2)。
 * 钉住:四件套覆盖计数、浅层观察识别、重复识别、6 条上限、空产出 100 分、评分与 issues 可读。
 */
import { describe, expect, it } from "vitest";
import { assessResultQuality, RSI_QUALITY_MAX_ITEMS } from "../src/rsi-quality.js";

function full(over: Record<string, unknown> = {}) {
  return {
    id: "x",
    title: "夜间 run 缺 11-12 导致覆盖断档",
    summary: "11-11 与 11-13 两轮 run 之间没有 11-12,该日会话永远不会被夜间整合覆盖。",
    evidence: "nightly/lampgenie-harness/2026-11-13.json:coverage.window",
    impact: "11-12 的会话欠账持续累积,方向图与缺陷基因链缺一天数据。",
    action: "把 nightly 改成按 cursor 水位回补,参考 nightly-store.ts:718。",
    ...over,
  };
}

describe("assessResultQuality", () => {
  it("空产出 = 100 分(诚实空产出,不是低质量)", () => {
    const q = assessResultQuality([]);
    expect(q.items).toBe(0);
    expect(q.score).toBe(100);
    expect(q.issues).toEqual([]);
  });

  it("四件套齐全 = 100 分", () => {
    const q = assessResultQuality([full()]);
    expect(q).toMatchObject({ items: 1, evidenced: 1, impacted: 1, actionable: 1, shallow: 0, duplicates: 0, score: 100 });
  });

  it("缺证据/影响/建议逐项扣分并点名", () => {
    const q = assessResultQuality([full({ evidence: "", impact: "", action: "" })]);
    expect(q.evidenced).toBe(0);
    expect(q.impacted).toBe(0);
    expect(q.actionable).toBe(0);
    expect(q.score).toBe(70); // 100-12-10-8
    expect(q.issues.map((x) => x.code)).toEqual(expect.arrayContaining(["MISSING_EVIDENCE", "MISSING_IMPACT", "MISSING_ACTION"]));
  });

  it("浅层流水账:缺失/只有 N 行且无影响/建议 → SHALLOW", () => {
    const q = assessResultQuality([
      { id: "a", title: "tool-pins.json 缺失", summary: "文件不存在,无法判断钉扎。" },
      { id: "b", title: "台账只有 1 行", summary: "cost.jsonl 只有 1 行,数据太少。" },
    ]);
    expect(q.shallow).toBe(2);
    expect(q.issues.filter((x) => x.code === "SHALLOW")).toHaveLength(2);
    expect(q.score).toBeLessThan(60);
  });

  it("四件套里的「缺失」不算浅层(有影响与建议就是结论)", () => {
    const q = assessResultQuality([full()]);
    expect(q.shallow).toBe(0);
  });

  it("重复:同标题归一化/同摘要前缀 → DUPLICATE", () => {
    const q = assessResultQuality([
      full({ id: "a", title: "覆盖断档", summary: "同一条摘要内容在这里重复出现两次。" }),
      full({ id: "b", title: "覆盖断档！", summary: "同一条摘要内容在这里重复出现两次。" }),
    ]);
    expect(q.duplicates).toBe(1);
    expect(q.issues.some((x) => x.code === "DUPLICATE")).toBe(true);
  });

  it("超过 6 条 → overLimit + 扣分", () => {
    const items = Array.from({ length: RSI_QUALITY_MAX_ITEMS + 1 }, (_, i) => full({
      id: `i${i}`,
      title: `发现 ${i}`,
      summary: `第 ${i} 条独立结论,描述一个不同的风险与它的后果。`,
    }));
    const q = assessResultQuality(items);
    expect(q.overLimit).toBe(true);
    expect(q.score).toBe(85);
    expect(q.issues.some((x) => x.code === "OVER_LIMIT")).toBe(true);
  });

  it("detail 里的 证据:/影响:/建议: 兼容旧格式(不强制新字段)", () => {
    const q = assessResultQuality([
      { id: "legacy", title: "旧格式结论", summary: "结论本身。", detail: "证据: foo.json:3\n影响: 决策缺数据\n建议: 补字段" },
    ]);
    expect(q).toMatchObject({ evidenced: 1, impacted: 1, actionable: 1, score: 100 });
  });
});
