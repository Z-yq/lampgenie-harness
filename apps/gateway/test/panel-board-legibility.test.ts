/** 白板卡片文字清晰度:字号下限 + 对比度令牌(源码契约)。
 *  背景:白板方块里原有 87 条 <10px 小字,叠加画布适配缩放(k≈0.7~0.9)后实际只有 5~7px。
 *  本契约只做源码面断言:
 *   a) 白板 CSS 区**不允许**出现 <10px 的 font-size 声明(负例可失败);
 *   b) 六套主题必须给 --bcv-lane-h-fg-strong / --bcv-lane-seg-fg 赋非默认值(浅底主题的强对比档);
 * c) type-chip / 泳道标题不得再走淡彩字面量(root 默认档与原字面量逐字相等 → 默认主题零漂移)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_CSS_SRC as PANEL_SRC } from "./panel-source.js";

const src = PANEL_SRC;

/** 白板 CSS 区 = `#view-board .vw-scope` 起 → `.cv-dot` 规则前止(与 panel-board-theme.test.ts 同锚点)。 */
function boardCss(): string {
  const a = src.indexOf("#view-board .vw-scope");
  const b = src.indexOf(".cv-dot{width:7px");
  expect(a, "白板 CSS 区起点锚点缺失").toBeGreaterThan(0);
  expect(b, "白板 CSS 区终点锚点缺失").toBeGreaterThan(a);
  return src.slice(a, b);
}

/** 取某主题的 --bcv-* 覆写块正文(覆写块以 `body.X{` + `--bcv-canvas-bg` 开头)。 */
function themeBcvBlock(sel: string): string {
  const i = src.indexOf(`  ${sel}{\n    --bcv-canvas-bg:`);
  expect(i, `${sel} 缺少 --bcv-* 覆写块`).toBeGreaterThan(0);
  // 覆写块的收尾 `}` 常与最后一条声明同行(--bcv-…}) → 取首个 `}` 即块尾
  const j = src.indexOf("}", i);
  expect(j, `${sel} 覆写块未闭合`).toBeGreaterThan(i);
  return src.slice(i, j);
}

const THEMES = ["body.light", "body.theme-sand", "body.theme-glass", "body.theme-olive", "body.theme-plum", "body.theme-ink"];

/** 判据:只认 <10 的字号(9、9.5、8.5 一律红;10/10.5/11 放行)。 */
function under10(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/font-size:([0-9]+(?:\.[0-9]+)?)px/g)) {
    if (Number(m[1]) < 10) out.push(m[0]);
  }
  return out;
}

describe("白板卡片文字清晰度:字号下限", () => {
  it("白板 CSS 区不存在 <10px 的 font-size 声明", () => {
    const css = boardCss();
    expect(css.length).toBeGreaterThan(20000);
    expect(under10(css)).toEqual([]);
  });

  it("判据自身可失败:9px / 9.5px / 8.5px 必须被识别为违例", () => {
    expect(under10(".a{font-size:9px}.b{font-size:9.5px}.c{font-size:8px}")).toEqual([
      "font-size:9px",
      "font-size:9.5px",
      "font-size:8px",
    ]);
    expect(under10(".a{font-size:10px}.b{font-size:11px}.c{font-size:10.5px}")).toEqual([]);
  });

  it("关键小字位(泳道标题/type-chip/卡脚/编号)显式 ≥10px", () => {
    const css = boardCss();
    for (const sel of [".cv-lane-h{", ".cv-lane-seg{", ".cv-type-chip{", ".cv-kind{", ".cv-no{"]) {
      expect(css.includes(sel), `规则缺失:${sel}`).toBe(true);
    }
    // 泳道标题:浅底主题下淡彩 11px 小字是 1.68:1 的主要受害者,字号与颜色都必须可读
    const laneH = css.slice(css.indexOf(".cv-lane-h{"), css.indexOf(".cv-lane-h{") + 260);
    expect(laneH).toMatch(/font-size:1[0-9](?:\.[0-9])?px/);
    expect(laneH).toContain("var(--bcv-lane-h-fg)");
  });
});

describe("白板卡片文字清晰度:对比度令牌", () => {
  it(":root 定义强对比档与徽标字色令牌(默认值=既有字面量)", () => {
    const i = src.indexOf("  :root{");
    const j = src.indexOf("  body.light{--bg:#f4eee3");
    const root = src.slice(i, j);
    for (const k of [
      "--bcv-lane-h-fg-strong",
      "--bcv-lane-seg-fg",
      "--bcv-lane-1-fg-strong",
      "--bcv-lane-6-fg-strong",
      "--bcv-chip-info-fg",
      "--bcv-chip-role-fg",
      "--bcv-chip-ok-fg",
      "--bcv-chip-info-fg",
      "--bcv-chip-metric-fg",
    ]) {
      expect(root.includes(`${k}:`), `:root 缺少 ${k}`).toBe(true);
    }
    // 默认主题零漂移:强档默认 = 原档,徽标字色默认 = 原字面量
    expect(root).toContain("--bcv-lane-h-fg-strong:var(--bcv-lane-h-fg)");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(root).toContain(`--bcv-lane-${n}-fg-strong:var(--bcv-lane-${n}-fg)`);
    }
    expect(root).toContain("--bcv-chip-role-fg:#e0c08f");
    expect(root).toContain("--bcv-chip-ok-fg:#a9e6db");
    expect(root).toContain("--bcv-chip-info-fg:#c9bda6");
    expect(root).toContain("--bcv-chip-metric-fg:#f0e3c8");
  });

  it("六套主题均覆写 --bcv-lane-h-fg-strong 与 --bcv-lane-seg-fg(且不是空值/默认 var 转指)", () => {
    for (const t of THEMES) {
      const blk = themeBcvBlock(t);
      const strong = /--bcv-lane-h-fg-strong:(#[0-9a-fA-F]{3,8})/.exec(blk);
      expect(strong, `${t} 缺少 --bcv-lane-h-fg-strong 的实色值`).not.toBeNull();
      const seg = /--bcv-lane-seg-fg:(#[0-9a-fA-F]{3,8})/.exec(blk);
      expect(seg, `${t} 缺少 --bcv-lane-seg-fg 的实色值`).not.toBeNull();
      // 分段序号与泳道标题都是小字,必须给出实色(浅底主题不得再落到 --faint 级别的 2.86:1)
      const lanes = blk.match(/--bcv-lane-[1-6]-fg-strong:(#[0-9a-fA-F]{3,8})/g) || [];
      expect(lanes.length, `${t} 强档泳道色不全`).toBe(6);
    }
  });

  it("type-chip 九色与卡内标题/编号不再写死淡彩字面量", () => {
    const css = boardCss();
    for (const cls of ["t-role", "t-ok", "t-warn", "t-bad", "t-branch", "t-before", "t-target", "t-metric"]) {
      const i = css.indexOf(`.cv-type-chip.${cls}{`);
      expect(i, `缺少规则 .cv-type-chip.${cls}`).toBeGreaterThan(0);
      expect(css.slice(i, i + 90)).toContain("var(--bcv-chip-");
    }
 // 泳道编号兜底底色:不得落到「深字压深底」(经验证 1.07:1)
    const b = css.slice(css.indexOf(".cv-lane-h b{"), css.indexOf(".cv-lane-h b{") + 260);
    expect(b).toContain("background:var(--bcv-lane-");
  });
});

/* ---- panel-board-legibility:wider-anchor ----
 * 上面 boardCss() 的终点锚点(.cv-dot)把画布后半段的图例/添加面板/浮层规则漏在判据之外;
 * 这里用宽锚点(.bf-cv-world 画布世界起点 → </style>)把所有 .cv-* 与 .bf-cv-* 规则都纳入字号下限判据。 */
function canvasCssRules(): string[] {
  const a = src.indexOf(".bf-cv-world{");
  const b = src.indexOf("</style>", a);
  expect(a, "画布世界锚点 .bf-cv-world 缺失").toBeGreaterThan(0);
  expect(b, "样式块闭合锚点 </style> 缺失").toBeGreaterThan(a);
  return src.slice(a, b).match(/\.(?:bf-)?cv-[^{}]*\{[^{}]*\}/g) || [];
}

/** 只认 <10 的 font-size;返回违例规则原文。 */
function under10Rules(rules: string[]): string[] {
  return rules.filter((r) => {
    const m = /font-size:([0-9]+(?:\.[0-9]+)?)px/.exec(r);
    return m ? Number(m[1]) < 10 : false;
  });
}

describe("白板卡片文字清晰度:宽锚点(画布世界 → </style>)", () => {
  it("图例/添加面板/浮层等 .cv-* 与 .bf-cv-* 规则同样不得出现 <10px 字号", () => {
    const rules = canvasCssRules();
    expect(rules.length, "画布世界规则数量异常(锚点失配)").toBeGreaterThan(200);
    expect(under10Rules(rules)).toEqual([]);
    // 曾经漏网的两条:.cv-legend 9px / .cv-addpanel .cv-agrp 9px(k=0.8 时只有 7.2px)
    for (const sel of [".cv-legend{", ".cv-addpanel .cv-agrp{"]) {
      const rule = rules.find((r) => r.startsWith(sel));
      expect(rule, `规则缺失:${sel}`).toBeTruthy();
      expect(rule!).toMatch(/font-size:1[0-9](?:\.[0-9])?px/);
    }
  });

  it("判据自身可失败:把真实规则改回 9px 必须被判红", () => {
    const rules = canvasCssRules();
    const sample = rules.find((r) => /font-size:1[0-9.]+px/.test(r));
    expect(sample, "找不到带 font-size 的样本规则").toBeTruthy();
    const broken = [sample!.replace(/font-size:[0-9.]+px/, "font-size:9px")];
    expect(under10Rules(broken).length).toBe(1);
    expect(under10Rules([sample!])).toEqual([]);
  });

  it("段序号走强对比档令牌(浅底主题不得再落到 --faint 级别)", () => {
    const rules = canvasCssRules();
    const seg = rules.find((r) => r.startsWith(".cv-lane-seg{"));
    expect(seg, "缺少 .cv-lane-seg 规则").toBeTruthy();
    expect(seg!).toContain("var(--bcv-lane-seg-fg-strong");
  });

  it("六套主题均给 --bcv-lane-seg-fg-strong 赋实色值(暗底默认 #9a9083 / 浅底各主题深一档)", () => {
    const root = src.slice(src.indexOf("  :root{"), src.indexOf("  body.light{--bg:#f4eee3"));
    expect(root, ":root 缺少 --bcv-lane-seg-fg-strong").toContain("--bcv-lane-seg-fg-strong:#9a9083");
    for (const t of THEMES) {
      const blk = themeBcvBlock(t);
      expect(
        /--bcv-lane-seg-fg-strong:(#[0-9a-fA-F]{3,8})/.test(blk),
        `${t} 缺少 --bcv-lane-seg-fg-strong 实色值`,
      ).toBe(true);
    }
  });
});
