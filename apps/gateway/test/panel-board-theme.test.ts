/** 白板配色接入主题令牌(--bcv-*):源码契约。
 *  只做源码面断言(真实渲染走 Playwright 证据):
 *   a) :root 定义 ≥20 个 --bcv-* 令牌,且默认值区不含重复第二份色值定义(令牌是唯一出口);
 *   b) 六套主题(light/sand/glass/olive/plum/ink)各自覆写 --bcv-card-bg 与 --bcv-title-fg;
 *   c) 反向断言:白板 CSS 区的 .cv-node 卡片系列规则不得再直接写死暗底字面量
 *      (background:#0… / background:rgba(1x,…));且白板令牌一律 --bcv-* 前缀,
 *      不复写画布外壳 canvas-shell.js 已占用的 --cv-* 前缀。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_CSS_SRC, PANEL_SRC } from "./panel-source.js";

const src = PANEL_CSS_SRC;

/** 与源码一致的行范围定位:白板 CSS 区 = `#view-board .vw-scope` 起 → `.cv-dot` 规则前止
 *  (跳过 PROFILE_PAGE:该模板无 .cv-* 白板规则)。 */
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
  const j = src.indexOf("\n  }\n", i);
  expect(j, `${sel} 覆写块未闭合`).toBeGreaterThan(i);
  return src.slice(i, j);
}

const THEMES = ["body.light", "body.theme-sand", "body.theme-glass", "body.theme-olive", "body.theme-plum", "body.theme-ink"];

describe("白板配色接入主题令牌", () => {
  it(":root 定义成组 --bcv-* 令牌(≥20),且覆盖卡片/泳道/连线/图例/侧栏关键件", () => {
    const i = src.indexOf("  :root{");
    const j = src.indexOf("  body.light{--bg:#f4eee3");
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    const root = src.slice(i, j);
    const keys = Array.from(new Set(root.match(/--bcv-[a-z0-9-]+(?=:)/g) || []));
    expect(keys.length, keys.join(",")).toBeGreaterThanOrEqual(20);
    for (const k of [
      "--bcv-canvas-bg", "--bcv-grid-dot", "--bcv-card-bg", "--bcv-card-bd", "--bcv-card-head-bg",
      "--bcv-title-fg", "--bcv-sum-fg", "--bcv-foot-fg", "--bcv-lane-bg", "--bcv-lane-bd", "--bcv-lane-h-fg",
      "--bcv-pill-bg", "--bcv-pill-fg", "--bcv-diamond-bg", "--bcv-diamond-bd", "--bcv-code-bg", "--bcv-code-fg",
      "--bcv-edge-call", "--bcv-edge-data", "--bcv-edge-verify", "--bcv-edge-line", "--bcv-edge-label",
      "--bcv-legend-bg", "--bcv-legend-fg", "--bcv-side-bg", "--bcv-side-fg",
      "--bcv-lane-1", "--bcv-lane-2", "--bcv-lane-3", "--bcv-lane-4", "--bcv-lane-5", "--bcv-lane-6",
    ]) expect(root, k).toContain(k + ":");
  });

  it(":root 默认值=鎏金夜现状(卡底/标题字/连线/泳道底色字面量零漂移)", () => {
    const root = src.slice(src.indexOf("  :root{"), src.indexOf("  body.light{--bg:#f4eee3"));
    expect(root).toContain("--bcv-card-bg:var(--solid)");
    expect(root).toContain("--bcv-card-bd:var(--border)");
    expect(root).toContain("--bcv-title-fg:var(--text)");
    expect(root).toContain("--bcv-edge-call:#c98f45");
    expect(root).toContain("--bcv-edge-line:#8a7a5a");
    expect(root).toContain("--bcv-code-bg:rgba(17,27,42,.96)");
    expect(root).toContain("--bcv-lane-1:#c9a35e");
  });

  it("六套主题各自覆写 --bcv-card-bg 与 --bcv-title-fg(浅色系必须真改浅底深字)", () => {
    for (const sel of THEMES) {
      const blk = themeBcvBlock(sel);
      expect(blk, sel + " card-bg").toContain("--bcv-card-bg:");
      expect(blk, sel + " title-fg").toContain("--bcv-title-fg:");
      expect(blk, sel + " lane-1").toContain("--bcv-lane-1:");
    }
    // 浅底深字:light/sand/olive/plum/ink 的卡底必须是浅色(hex 亮度 > 0.6 或浅色 rgba)
    const luma = (hexv: string) => {
      const h = hexv.replace("#", "");
      const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
      const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    for (const sel of ["body.light", "body.theme-sand", "body.theme-olive", "body.theme-plum", "body.theme-ink"]) {
      const m = themeBcvBlock(sel).match(/--bcv-card-bg:([^;}]+)/);
      expect(m, sel).toBeTruthy();
      const v = String((m as RegExpMatchArray)[1]).trim();
      const ok = /^#[0-9a-f]{3,6}$/i.test(v) ? luma(v) > 0.6 : /^rgba\((2[0-9]{2}|1[6-9][0-9]),/.test(v);
      expect(ok, sel + " 卡底不是浅色: " + v).toBe(true);
    }
  });

  it("反向断言:白板 .cv-node 卡片系列不再写死暗底字面量,改吃 --bcv-* 令牌", () => {
    const board = boardCss();
    // 主题系统管辖的卡片族:基类 + 线框四形态(k-page/section/component/nav) + code 卡 + 泳道卡
    // (.cv-node.cv-ui-* 是 UI 交互地图的线框 mock 层,保持自身暗色线框谱系——见本文件末条说明)
    const nodeRules = board
      .split(String.fromCharCode(10))
      .filter((l) => /^\s*\.cv-node[{.]/.test(l) && !/\.cv-ui-/.test(l) && !/\.sec-/.test(l));
    expect(nodeRules.length).toBeGreaterThan(5);
    for (const l of nodeRules) {
      // 暗底字面量特征:background:#0.. / background:#1.. / background:rgba(1x,y,z,..) / background:rgba(2x,y,z,..)
      expect(l, "暗底字面量残留: " + l.slice(0, 90)).not.toMatch(/background:\s*(#0[0-9a-f]{2}|#1[0-9a-f]{2}|rgba\(1[0-9]?,|rgba\(2[0-9]?,)/i);
    }
    expect(board).toContain(".cv-node{position:absolute;width:216px;background:var(--bcv-card-bg);border:1px solid var(--bcv-card-bd)");
    expect(board).toContain(".cv-node .cv-head{display:flex;");
    expect(board).toContain("background:var(--bcv-card-head-bg)");
    expect(board).toContain("color:var(--cv-sub-fg)");
    expect(board).toContain("color:var(--cv-foot-fg)");
  });

  it("反向断言:白板令牌一律 --bcv-* 前缀,不复写画布外壳占用的 --cv-*", () => {
    const board = boardCss();
    expect(board).toContain("--bcv-title-fg");
    // 白板 CSS 区不得出现 --cv-g / --cv-s / --cv-tray-* (canvas-shell.js:620/627/1533) 的定义或覆写
    expect(board).not.toMatch(/--cv-(g|s)(?![a-z0-9-])/);
    expect(board).not.toContain("--cv-tray-");
    // 白板 CSS 区不再直接写死卡片/连线/泳道/图例/侧栏的主色字面量
    for (const lit of ["stroke:#c98f45", "stroke:#5b8ec9", "stroke:#5aa06a", "border-color:#c9a25e", "background:rgba(17,27,42,.96)", "background:rgba(11,18,28,.94)"]) {
      expect(board, "字面量残留: " + lit).not.toContain(lit);
    }
  });

  it("JS 侧色相读令牌:lane 色相数组与板型画像都走 var(--bcv-lane-N) 并带兜底值", () => {
    const src = PANEL_SRC; // JS 侧锚点(PG_HUES/bdC)在主脚本分片,用聚合源
    const hues = src.slice(src.indexOf("const PG_HUES = ["), src.indexOf("// w4 空壳泳道降噪"));
    expect((hues.match(/var\(--bcv-lane-[1-6],/g) || []).length).toBeGreaterThanOrEqual(15);
    expect(hues).toContain('bg: "var(--bcv-page-1-bg,rgba(20,24,32,.93))"');
    expect(src).toContain('const bdC = lane.isolated ? "var(--bcv-lane-orphan-bd,#6b5c4a)" : h.bd;');
    const asset = readFileSync(join(process.cwd(), "src", "assets", "board-type-profile.js"), "utf-8");
    expect(asset).toContain('color: "var(--bcv-lane-1, #e0b46a)", colorHex: "#e0b46a"');
    expect((asset.match(/color: "var\(--bcv-lane-[1-6], #[0-9a-f]{6}\)", colorHex: "#[0-9a-f]{6}"/g) || []).length).toBeGreaterThanOrEqual(13);
  });

  it("板型头浮层 .cv-type-head 入令牌:六套主题都覆写,浅色主题不再黑底", () => {
    for (const sel of THEMES) {
      const blk = themeBcvBlock(sel);
      for (const k of ["--bcv-thead-bg", "--bcv-thead-bd", "--bcv-thead-fg", "--bcv-thead-shadow"]) {
        expect(blk, sel + " " + k).toContain(k + ":");
      }
    }
    const css = boardCss();
    const at = css.indexOf(".cv-type-head{");
    expect(at).toBeGreaterThan(0);
    const headRule = css.slice(at, css.indexOf("}", at) + 1);
    expect(headRule).toContain("var(--bcv-thead-bg)");
    expect(headRule).not.toContain("rgba(16,12,6,.93)");
  });

  it("docs/PPT 两层板(.cv-doc-*)同批入令牌::root 与六主题覆写 doc 组,白板区零 doc 色值字面量", () => {
    const need = [
      "--bcv-doc-root-bg1", "--bcv-doc-root-bg2", "--bcv-doc-root-bd", "--bcv-doc-root-tag-fg", "--bcv-doc-root-tag-bg",
      "--bcv-doc-root-title", "--bcv-doc-root-sum", "--bcv-doc-ch-h", "--bcv-doc-ch-hb-fg", "--bcv-doc-ch-n", "--bcv-doc-ch-sum",
      "--bcv-doc-page-bg", "--bcv-doc-page-bd", "--bcv-doc-pg-h", "--bcv-doc-pg-hb", "--bcv-doc-pg-hb-bd", "--bcv-doc-pg-sum",
      "--bcv-doc-shadow", "--bcv-doc-shadow-soft",
    ];
    const root = src.slice(src.indexOf("  :root{"), src.indexOf("  body.light{--bg:#f4eee3"));
    for (const k of need) expect(root, k).toContain(k + ":");
    for (const sel of THEMES) {
      const blk = themeBcvBlock(sel);
      for (const k of need) expect(blk, sel + " " + k).toContain(k + ":");
    }
    const docLines = boardCss().split(String.fromCharCode(10)).filter((l) => l.includes(".cv-doc-"));
    expect(docLines.length).toBeGreaterThan(8);
    for (const l of docLines) expect(l, "doc 区色值字面量残留: " + l.slice(0, 80)).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
  });
});
