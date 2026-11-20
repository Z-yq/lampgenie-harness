/**
 * 世界模型开工简报:纯函数单测(fixture 产物,零索引)。
 * 断言:L0 注入 / 真命中 L1≤2 / 零命中不灌 fallback / 缺产物空串 / 预算硬上限 / 确定性。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderWorldStartBrief, WORLD_START_BRIEF_MAX_BYTES } from "../src/world-start-brief.js";
import { writeWorldArtifact, writeDrillCorpus } from "@lampgenie/code-sense/world/store";

function fixture(opts: { skeleton?: string; modules?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "world-brief-"));
  const modules = opts.modules ?? ["alpha-mod", "beta-mod"];
  const skeleton = opts.skeleton ?? "# L0 骨架\n- 主线: 测试仓\n## 模块清单\n" + modules.map((m) => `- ${m}`).join("\n") + "\n";
  const pages = modules.map((m) => {
    const markdown = `# 模块 ${m}\n- 职责: 测试职责\n`;
    return { module: m, markdown, bytes: Buffer.byteLength(markdown, "utf8") };
  });
  writeWorldArtifact(root, { skeleton, pages, fp: { builtAt: 1000 }, renderMs: 1 });
  writeDrillCorpus(root, {
    version: 1,
    indexBuiltAt: 1000,
    modules: modules.map((m, i) => ({
      name: m,
      slug: m,
      dirs: [m + "/src"],
      files: ["file" + i],
      symbols: ["sym" + i],
      note: i === 0 ? "甲职责" : "乙职责",
    })),
  });
  return root;
}

describe("renderWorldStartBrief(开工一次性注入)", () => {
  it("产物缺失 → 空串(fail-soft,零变化)", () => {
    const root = mkdtempSync(join(tmpdir(), "world-brief-empty-"));
    expect(renderWorldStartBrief(root, "任何任务")).toBe("");
  });

  it("L0 全文注入 + 包装头 + 下钻指路", () => {
    const root = fixture();
    const text = renderWorldStartBrief(root, "无关任务文本");
    expect(text).toContain("世界模型骨架(开工一次性注入,稳定前缀)");
    expect(text).toContain("L0 骨架");
    expect(text).toContain("action=world");
  });

  it("真命中 L1 注入(score>0),未命中模块不灌", () => {
    const root = fixture();
    const text = renderWorldStartBrief(root, "改 alpha-mod 的逻辑");
    expect(text).toContain("模块页:alpha-mod");
    expect(text).not.toContain("模块页:beta-mod");
  });

  it("零词面命中 → 只 L0,不注入 fallback 候选页", () => {
    const root = fixture();
    const text = renderWorldStartBrief(root, "zzzqqqxxx");
    expect(text).toContain("L0 骨架");
    expect(text).not.toContain("模块页:");
  });

  it("命中多模块时 L1 ≤2 页", () => {
    const root = fixture({ modules: ["alpha-mod", "beta-mod", "gamma-mod"] });
    const text = renderWorldStartBrief(root, "alpha-mod beta-mod gamma-mod");
    const n = (text.match(/模块页:/g) ?? []).length;
    expect(n).toBeLessThanOrEqual(2);
    expect(n).toBeGreaterThan(0);
  });

  it("预算硬上限:超大 L0 截断后总字节 ≤7168", () => {
    const root = fixture({ skeleton: "# L0 骨架\n" + "x".repeat(9000) + "\n" });
    const text = renderWorldStartBrief(root, "alpha-mod");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(WORLD_START_BRIEF_MAX_BYTES);
    expect(text).toContain("超预算截断");
  });

  it("确定性:同输入两次调用逐字相同(稳定前缀)", () => {
    const root = fixture();
    const a = renderWorldStartBrief(root, "改 alpha-mod");
    const b = renderWorldStartBrief(root, "改 alpha-mod");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
