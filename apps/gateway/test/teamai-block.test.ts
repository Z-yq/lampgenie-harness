import { describe, it, expect } from "vitest";
import { renderTeamaiBlock } from "../src/agent-wiring.js";

const digest = {
  meta: { team: "神眸精灵系统" },
  culture: "使命:把事做对。",
  rules: [
    { name: "security", enforced: true, body: "禁密钥入库。" },
    { name: "style", enforced: false, body: "风格指南。" },
  ],
  skills: [{ ns: "common", name: "debug", description: "调试工作流", contributors: ["yujitai"], body: "..." }],
  docs: ["guide/a.md"],
  envVars: [], secretKeys: [], hooks: [], mcpRaw: "", modelsRaw: "", agentsRaw: [], pulledAt: 1,
};

describe("renderTeamaiBlock(designs/24 系统提示注入)", () => {
  it("enforced 规则全文+culture+松规则/技能索引;渐进披露提示 skill_view", () => {
    const block = renderTeamaiBlock(digest);
    expect(block).toContain("# 团队资产(teamai · 神眸精灵系统)");
    expect(block).toContain("禁密钥入库。");
    expect(block).toContain("使命:把事做对。");
    expect(block).toContain("- rules/style");
    expect(block).toContain("- debug: 调试工作流");
    expect(block).toContain('skill_view(category="teamai"');
    expect(block).not.toContain("风格指南。"); // 松规则只进索引,不进全文
  });

  it("null/空 digest = 空串(不产生孤儿节)", () => {
    expect(renderTeamaiBlock(null)).toBe("");
    expect(renderTeamaiBlock({ meta: {}, rules: [], skills: [] })).toBe("");
  });

  it("12KB 预算封顶", () => {
    const big = { ...digest, rules: [{ name: "big", enforced: true, body: "x".repeat(40_000) }] };
    expect(renderTeamaiBlock(big).length).toBeLessThanOrEqual(12_000);
  });
});
