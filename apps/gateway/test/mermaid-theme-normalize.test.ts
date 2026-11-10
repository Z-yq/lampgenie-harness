/** mermaid 主题色归一化单测(src/assets/mermaid-theme-normalize.js,移植自 ZCode)。
 * 覆盖:注入采样器把 oklab/color-mix 归一化为 rgb(...) 串 /输出无 oklab、color-mix 残留
 * /rgb、hex 原样透传 /对象与串两种输入 /采样器缺席时的兜底。
 * 跑法:cd apps/gateway && npx vitest run test/mermaid-theme-normalize.test.ts */
import { describe, expect, it } from "vitest";
import {
  normalizeMermaidThemeVars,
  normalizeCssColor,
  CANVAS_SENTINEL_COLOR,
} from "../src/assets/mermaid-theme-normalize.js";

/** 把颜色字符串解析为 {r,g,b,a} 的最小采样器实现(测试内自洽,不依赖真 canvas)。 */
function makeStubSampler(map: Record<string, [number, number, number, number]>) {
  return (color: string): { r: number; g: number; b: number; a: number } | null => {
    const hit = map[color.trim()];
    if (!hit) return null;
    return { r: hit[0], g: hit[1], b: hit[2], a: hit[3] };
  };
}

describe("mermaid-theme-normalize normalizeMermaidThemeVars", () => {
  it("oklab(58% 0.12 44 / 0.5) 与 color-mix(...) 经注入采样器归一化为 rgb(...) 串", () => {
    const sampler = makeStubSampler({
      "oklab(58% 0.12 44 / 0.5)": [214, 102, 61, 0.5],
      "color-mix(in oklab, #34d399, #000 32%)": [35, 162, 127, 1],
    });
    const out = normalizeMermaidThemeVars(
      {
        primaryColor: "oklab(58% 0.12 44 / 0.5)",
        secondaryColor: "color-mix(in oklab, #34d399, #000 32%)",
      },
      { sampler },
    ) as Record<string, string>;

    expect(out.primaryColor).toBe("rgba(214, 102, 61, 0.5)"); // α<1 → rgba
    expect(out.secondaryColor).toBe("rgb(35, 162, 127)"); // α≥1 → rgb
    // 输出不含现代 CSS 颜色残留。
    expect(JSON.stringify(out)).not.toContain("oklab");
    expect(JSON.stringify(out)).not.toContain("color-mix");
  });

  it("输出不含 oklab / color-mix 残留(整表扫描)", () => {
    const sampler = makeStubSampler({
      "oklab(70% 0.1 200)": [90, 160, 220, 1],
      "color-mix(in oklab, #fff, #000 50%)": [128, 128, 128, 1],
    });
    const out = normalizeMermaidThemeVars(
      ["oklab(70% 0.1 200)", "color-mix(in oklab, #fff, #000 50%)", "#ffffff"],
      { sampler },
    ) as string[];
    for (const value of out) {
      expect(value).not.toMatch(/oklab|color-mix/i);
    }
    expect(out[0]).toBe("rgb(90, 160, 220)");
    expect(out[1]).toBe("rgb(128, 128, 128)");
  });

  it("已是 rgb/hex 的值原样透传(不经过采样器)", () => {
    let sampled = 0;
    const sampler = () => {
      sampled += 1;
      return { r: 0, g: 0, b: 0, a: 1 };
    };
    const out = normalizeMermaidThemeVars(
      {
        background: "#18181b",
        primaryColor: "rgb(52, 211, 153)",
        secondaryColor: "rgba(52, 211, 153, 0.5)",
        lineColor: "#34d399",
      },
      { sampler },
    ) as Record<string, string>;

    expect(out).toEqual({
      background: "#18181b",
      primaryColor: "rgb(52, 211, 153)",
      secondaryColor: "rgba(52, 211, 153, 0.5)",
      lineColor: "#34d399",
    });
    expect(sampled).toBe(0); // 传统格式短路,不走 canvas 采样
  });

  it("采样器缺席/采样失败时回退 fallback,不抛错", () => {
    expect(normalizeMermaidThemeVars({ primaryColor: "oklab(58% 0.12 44)" })).toEqual({
      primaryColor: "oklab(58% 0.12 44)",
    });
    const nullSampler = () => null;
    const out = normalizeMermaidThemeVars(
      { primaryColor: "color-mix(in oklab, #fff, #000 50%)" },
      { sampler: nullSampler, fallback: "#000000" },
    ) as Record<string, string>;
    expect(out.primaryColor).toBe("#000000");
  });

  it("串输入:返回归一化后的串;空串/空对象安全", () => {
    const sampler = makeStubSampler({ "oklab(100% 0 0 / 1)": [255, 255, 255, 1] });
    expect(normalizeMermaidThemeVars("oklab(100% 0 0 / 1)", { sampler })).toBe("rgb(255, 255, 255)");
    expect(normalizeMermaidThemeVars("", { sampler })).toBe("");
    expect(normalizeMermaidThemeVars(null as never, { sampler })).toBe(null as never);
  });

  it("normalizeCssColor:采样器直接可用;哨兵色语义(返回 null 表示不支持)", () => {
    const sampler = makeStubSampler({ "oklab(50% 0.2 20)": [255, 60, 40, 1] });
    expect(normalizeCssColor("oklab(50% 0.2 20)", { sampler })).toBe("rgb(255, 60, 40)");
    expect(normalizeCssColor("#ffffff", { sampler })).toBe("#ffffff");
    expect(CANVAS_SENTINEL_COLOR).toBe("#010203"); // 与原文件哨兵一致
  });
});
