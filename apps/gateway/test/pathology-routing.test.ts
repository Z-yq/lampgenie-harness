/**
 * 形态检出 → 候选队列路由测试(§11 P1#8 干预路由消费面 v1):
 * tip 许可→tip;协调族无注入许可→gate;其余→tool;id 按 formId 稳定且同表去重;
 * evidenceRefs 带 pathology 时间戳/表单/载体。
 */
import { describe, expect, it } from "vitest";
import { pathologyRouteCandidates } from "../src/nightly-store";

const AT = Date.parse("2026-11-20T12:00:00Z");

describe("pathologyRouteCandidates", () => {
  it("三类映射:tipAllowed→tip;coordination→gate;其余→tool", () => {
    const routed = pathologyRouteCandidates(
      [
        { formId: "waste-loop", family: "execution", carriers: ["repeat-exploration"], tipAllowed: true },
        { formId: "parallel-clash", family: "coordination", carriers: ["claim-lock", "search-scope"], tipAllowed: false },
        { formId: "tool-gap", family: "capability", carriers: ["tool-foundry"], tipAllowed: false },
      ],
      AT,
    );
    expect(routed.map((c) => c.kind)).toEqual(["tip", "gate", "tool"]);
    expect(routed[0]!.id).toBe("cand-pathology-waste-loop");
    expect(routed[1]!.reason).toContain("parallel-clash");
    expect(routed[1]!.reason).toContain("claim-lock/search-scope");
    expect(routed[1]!.evidenceRefs).toContain("pathology:2026-11-20T12:00:00.000Z");
    expect(routed[1]!.evidenceRefs).toContain("carrier:claim-lock");
  });

  it("同表去重 + 空 formId 跳过", () => {
    const routed = pathologyRouteCandidates(
      [
        { formId: "parallel-clash", family: "coordination", carriers: ["claim-lock"], tipAllowed: false },
        { formId: "parallel-clash", family: "coordination", carriers: ["claim-lock"], tipAllowed: true },
        { formId: "  ", family: "x", carriers: [], tipAllowed: false },
      ],
      AT,
    );
    expect(routed.length).toBe(1);
    expect(routed[0]!.kind).toBe("gate"); // 首次出现(非 tip)为准
  });
});
