/** diagram-viewport 引擎资产单测(src/assets/diagram-viewport.js,移植自 ZCode)。
 * 覆盖:光标锚点缩放数学(锚点内容屏幕位移=0)/scale 夹取 0.25~4/fit 装箱留边距/
 * resolveSvgBounds 注入 stub getBBox 的排除规则(defs/mask/clipPath/背景 rect/display:none)。
 * 跑法:cd apps/gateway && npx vitest run test/diagram-viewport.test.ts */
import { describe, expect, it } from "vitest";
import {
  clampScale,
  fitToViewport,
  isCanvasBackgroundRect,
  mergeBounds,
  pan,
  zoomAtPoint,
  resolveSvgBounds,
  computePreviewSvgLayout,
  invertMatrix,
  mapBoxByMatrix,
  multiplyMatrix,
  MIN_DIAGRAM_SCALE,
  MAX_DIAGRAM_SCALE,
} from "../src/assets/diagram-viewport.js";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

describe("diagram-viewport zoomAtPoint(锚点数学)", () => {
  it("scale=2 时光标点 p 对应的内容点屏幕位移=0(±1e-9)", () => {
    const t0 = { scale: 1, translateX: 40, translateY: -25 };
    const p = { x: 313.7, y: 208.4 };
    const t1 = zoomAtPoint(t0, p, 2);
    // p 在旧变换下的内容坐标,经新变换投影回屏幕应仍等于 p。
    const contentX = (p.x - t0.translateX) / t0.scale;
    const contentY = (p.y - t0.translateY) / t0.scale;
    expect(near(p.x - (contentX * t1.scale + t1.translateX), 0)).toBe(true);
    expect(near(p.y - (contentY * t1.scale + t1.translateY), 0)).toBe(true);
    expect(t1.scale).toBe(2);
  });

  it("任意变换/光标组合下锚点内容屏幕位移恒为 0(±1e-9)", () => {
    const cases: Array<{ scale: number; translateX: number; translateY: number }> = [
      { scale: 0.5, translateX: -120, translateY: 90 },
      { scale: 3.25, translateX: 800, translateY: -400 },
      { scale: 1, translateX: 0, translateY: 0 },
    ];
    for (const t0 of cases) {
      for (const nextScale of [0.25, 0.8, 1, 2.5, 4]) {
        const p = { x: 137.3, y: 91.9 };
        const t1 = zoomAtPoint(t0, p, nextScale);
        const sx = ((p.x - t0.translateX) / t0.scale) * t1.scale + t1.translateX;
        const sy = ((p.y - t0.translateY) / t0.scale) * t1.scale + t1.translateY;
        expect(Math.abs(sx - p.x) <= 1e-9).toBe(true);
        expect(Math.abs(sy - p.y) <= 1e-9).toBe(true);
      }
    }
  });

  it("nextScale 经 clampDiagramScale 夹取后再计算(传 99 → 4)", () => {
    const t1 = zoomAtPoint({ scale: 1, translateX: 0, translateY: 0 }, { x: 50, y: 50 }, 99);
    expect(t1.scale).toBe(MAX_DIAGRAM_SCALE);
  });
});

describe("diagram-viewport clampScale(0.25~4)", () => {
  it("低于下限夹到 0.25,高于上限夹到 4", () => {
    expect(clampScale(0.01)).toBe(MIN_DIAGRAM_SCALE);
    expect(clampScale(-3)).toBe(MIN_DIAGRAM_SCALE);
    expect(clampScale(9)).toBe(MAX_DIAGRAM_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.25)).toBe(0.25);
    expect(clampScale(4)).toBe(4);
  });
  it("非有限值兜底 1(NaN/Infinity/-Infinity)", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampScale(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe("diagram-viewport pan / fitToViewport", () => {
  it("pan 把 delta 叠加到 translate", () => {
    const t1 = pan({ scale: 2, translateX: 10, translateY: -5 }, { x: -30, y: 12 });
    expect(t1).toEqual({ scale: 2, translateX: -20, translateY: 7 });
  });

  it("fit 产物使 bounds 恰好装进 viewport 且留 padding 边距", () => {
    const viewport = { viewportWidth: 800, viewportHeight: 600 };
    const bounds = { diagramWidth: 400, diagramHeight: 300, diagramX: 0, diagramY: 0 };
    const padding = 40;
    const fit = fitToViewport({ ...bounds, ...viewport, padding });
    // 宽高比取小者:可用区 720x520,400x300 → scale=min(1.8,1.733..)=1.7333
    const expectedScale = Math.min((800 - 80) / 400, (600 - 80) / 300);
    expect(fit.scale).toBeCloseTo(expectedScale, 12);
    // 装箱后投影尺寸 ≤ 可用区,且四边至少 padding。
    const w = 400 * fit.scale;
    const h = 300 * fit.scale;
    expect(w).toBeLessThanOrEqual(800 - padding * 2 + 1e-9);
    expect(h).toBeLessThanOrEqual(600 - padding * 2 + 1e-9);
    // 居中:左右留白相等。
    expect(near(fit.translateX, (800 - w) / 2)).toBe(true);
    expect(near(fit.translateY, (600 - h) / 2)).toBe(true);
    // 内容点 (0,0) 与 (400,300) 投影落在 [padding, viewport-padding]。
    const tl = { x: fit.translateX, y: fit.translateY };
    const br = { x: 400 * fit.scale + fit.translateX, y: 300 * fit.scale + fit.translateY };
    expect(tl.x).toBeGreaterThanOrEqual(padding - 1e-9);
    expect(tl.y).toBeGreaterThanOrEqual(padding - 1e-9);
    expect(br.x).toBeLessThanOrEqual(800 - padding + 1e-9);
    expect(br.y).toBeLessThanOrEqual(600 - padding + 1e-9);
  });

  it("fit 尊重 bounds 原点偏移(x/y 非零)并夹取 scale 上限", () => {
    const fit = fitToViewport({
      diagramX: 100,
      diagramY: 50,
      diagramWidth: 10,
      diagramHeight: 10,
      viewportWidth: 800,
      viewportHeight: 600,
      padding: 0,
    });
    expect(fit.scale).toBe(MAX_DIAGRAM_SCALE); // 80/10=8 超上限被夹
    // 原语义:整个图 box(diagramX..diagramX+10)投影后居中——box 中心落在 viewport 中心。
    const cx = (100 + 10 / 2) * fit.scale + fit.translateX;
    const cy = (50 + 10 / 2) * fit.scale + fit.translateY;
    expect(near(cx, 800 / 2)).toBe(true);
    expect(near(cy, 600 / 2)).toBe(true);
  });

  it("非法尺寸退化为恒等变换", () => {
    expect(
      fitToViewport({ diagramWidth: 0, diagramHeight: 10, viewportWidth: 100, viewportHeight: 100 }),
    ).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  });
});

/* ── resolveSvgBounds:注入 stub getBBox 的排除规则 ────────────────────── */

type El = { tag: string; box: { x: number; y: number; width: number; height: number } };
type View = {
  tagName: string;
  className: string;
  stroke?: string;
  display?: string;
  visibility?: string;
  opacity?: string;
  ancestors?: string[];
};

const view = (v: View): View => ({ ...v, className: v.className ?? "" });
const rootBounds = { width: 1000, height: 800, x: 0, y: 0 };

describe("diagram-viewport resolveSvgBounds(excludes)", () => {
  it("excludes defs/mask/clipPath 祖先元素:不计入并集,真实图形计入", () => {
    const els: El[] = [
      // defs 内的图形(渐变定义常用 rect/path)——排除。
      { tag: "rect", box: { x: -500, y: -500, width: 5000, height: 5000 } },
      { tag: "path", box: { x: -900, y: 0, width: 100, height: 50 } },
      // mask/clipPath 内——排除。
      { tag: "circle", box: { x: 0, y: 700, width: 60, height: 60 } },
      // 真实可见图形——计入。
      { tag: "rect", box: { x: 100, y: 80, width: 200, height: 120 } },
      { tag: "text", box: { x: 400, y: 300, width: 80, height: 20 } },
    ];
    const views: Record<number, View> = {
      0: view({ tagName: "rect", className: "", ancestors: ["defs", "g"] }),
      1: view({ tagName: "path", className: "", ancestors: ["defs"] }),
      2: view({ tagName: "circle", className: "", ancestors: ["g", "mask"] }),
      3: view({ tagName: "rect", className: "node", ancestors: ["g"] }),
      4: view({ tagName: "text", className: "label", ancestors: ["g"] }),
    };
    const bounds = resolveSvgBounds(
      rootBounds,
      els,
      (el: El) => views[els.indexOf(el)] as never,
      (el: El) => el.box,
    );
    // 并集 = (100,80,200x120) ∪ (400,300,80x20) = x:100..480, y:80..320。
    expect(bounds).toEqual({ x: 100, y: 80, width: 380, height: 240 });
  });

  it("excludes 覆盖根画布的背景 rect 与 display:none / visibility:hidden / opacity:0 元素", () => {
    const els: El[] = [
      // 背景 rect:覆盖根画布 ≥95% 且 stroke 透明 → 排除。
      { tag: "rect", box: { x: 0, y: 0, width: 1000, height: 800 } },
      // 背景另一形态:位置差≤1 且覆盖≥95%,class 含 background → 排除。
      { tag: "rect", box: { x: 0, y: 1, width: 990, height: 790 } },
      // display:none → 排除。
      { tag: "rect", box: { x: 0, y: 0, width: 400, height: 400 } },
      // visibility:hidden → 排除。
      { tag: "circle", box: { x: 10, y: 10, width: 100, height: 100 } },
      // opacity:0 → 排除。
      { tag: "path", box: { x: 20, y: 20, width: 110, height: 110 } },
      // 退化 bbox(宽或高 ≤0)→ 排除。
      { tag: "rect", box: { x: 30, y: 30, width: 0, height: 50 } },
      // 真实图形——计入。
      { tag: "rect", box: { x: 200, y: 150, width: 300, height: 100 } },
    ];
    const views: Record<number, View> = {
      0: view({ tagName: "rect", className: "", stroke: "none" }),
      1: view({ tagName: "rect", className: "background-canvas", stroke: "#333" }),
      2: view({ tagName: "rect", className: "", display: "none" }),
      3: view({ tagName: "circle", className: "", visibility: "hidden" }),
      4: view({ tagName: "path", className: "", opacity: "0" }),
      5: view({ tagName: "rect", className: "" }),
      6: view({ tagName: "rect", className: "", stroke: "#000" }),
    };
    const bounds = resolveSvgBounds(
      rootBounds,
      els,
      (el: El) => views[els.indexOf(el)] as never,
      (el: El) => el.box,
    );
    expect(bounds).toEqual({ x: 200, y: 150, width: 300, height: 100 });
  });

  it("全被排除时回退 rootBounds;普通 rect 不被误判为背景", () => {
    const els: El[] = [{ tag: "rect", box: { x: 0, y: 0, width: 1000, height: 800 } }];
    const views: Record<number, View> = {
      0: view({ tagName: "rect", className: "", stroke: "#000" }), // 有描边 → 不是背景
    };
    const keep = resolveSvgBounds(
      rootBounds,
      els,
      (el: El) => views[els.indexOf(el)] as never,
      (el: El) => el.box,
    );
    expect(keep).toEqual({ x: 0, y: 0, width: 1000, height: 800 });

    const none: El[] = [
      { tag: "rect", box: { x: 0, y: 0, width: 1000, height: 800 } }, // 背景
    ];
    const views2: Record<number, View> = {
      0: view({ tagName: "rect", className: "background", stroke: "#000" }),
    };
    const fallback = resolveSvgBounds(
      rootBounds,
      none,
      (el: El) => views2[none.indexOf(el)] as never,
      (el: El) => el.box,
    );
    expect(fallback).toEqual({ height: 800, width: 1000, x: 0, y: 0 });
  });

  it("getBBox 抛错时跳过该元素继续求并集(原文件语义)", () => {
    const els: El[] = [
      { tag: "path", box: { x: 0, y: 0, width: 10, height: 10 } }, // 抛错
      { tag: "rect", box: { x: 50, y: 60, width: 20, height: 30 } }, // 正常
    ];
    const views: Record<number, View> = {
      0: view({ tagName: "path", className: "" }),
      1: view({ tagName: "rect", className: "" }),
    };
    const bounds = resolveSvgBounds(
      rootBounds,
      els,
      (el: El) => views[els.indexOf(el)] as never,
      (el: El) => {
        if (el.tag === "path") throw new Error("layout not ready");
        return el.box;
      },
    );
    expect(bounds).toEqual({ x: 50, y: 60, width: 20, height: 30 });
  });

  it("非图形标签(如 linearGradient/marker 自身)不进入候选集", () => {
    const els: El[] = [{ tag: "rect", box: { x: 10, y: 10, width: 100, height: 50 } }];
    const views: Record<number, View> = {
      0: view({ tagName: "lineargradient", className: "" }), // 小写化后不在图形集
    };
    const bounds = resolveSvgBounds(
      rootBounds,
      els,
      (el: El) => views[els.indexOf(el)] as never,
      (el: El) => el.box,
    );
    expect(bounds).toEqual({ height: 800, width: 1000, x: 0, y: 0 }); // 全排除 → 回退
  });
});

describe("diagram-viewport 辅助导出", () => {
  it("isCanvasBackgroundRect:位置差≤1/覆盖≥95%/透明描边或 background class", () => {
    expect(
      isCanvasBackgroundRect(
        { tagName: "rect", className: "", stroke: "none" } as never,
        { x: 0, y: 1, width: 960, height: 800 },
        rootBounds,
      ),
    ).toBe(true);
    expect(
      isCanvasBackgroundRect(
        { tagName: "rect", className: "bg", stroke: "#000" } as never,
        { x: 5, y: 5, width: 100, height: 100 },
        rootBounds,
      ),
    ).toBe(false); // 不覆盖根
    expect(
      isCanvasBackgroundRect(
        { tagName: "circle", className: "", stroke: "none" } as never,
        { x: 0, y: 0, width: 1000, height: 800 },
        rootBounds,
      ),
    ).toBe(false); // 非 rect
  });

  it("mergeBounds:并集矩形", () => {
    expect(mergeBounds({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: 30,
      height: 15,
    });
    expect(mergeBounds(null, { x: 1, y: 2, width: 3, height: 4 })).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
  });

  it("computePreviewSvgLayout:有效 rootBounds 产出父容器与 SVG 对齐尺寸", () => {
    expect(computePreviewSvgLayout({ width: 480, height: 360, x: 0, y: 0 })).toEqual({
      applicable: true,
      contentWidth: 480,
      contentHeight: 360,
      svgWidth: "100%",
      svgHeight: "100%",
      svgMaxWidth: "none",
    });
    expect(computePreviewSvgLayout({ width: 0, height: 0 })).toMatchObject({ applicable: false });
  });
});

/** 2026-11-05 任务B 回归:getBBox 是元素**局部**坐标,必须经 inverse(rootCTM)×elCTM
 * 映射回 root user space 再并集,否则多组 translate 的局部框混坐标系 → 紧凑 fit 的
 * bbox 比 viewBox 还大(实测 minX≈-430、可见卡 9/100 反而少于 viewBox 口径的 12/100)。 */
describe("diagram-viewport 坐标系映射(局部 bbox → root user space)", () => {
  const translate = (x: number, y: number) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

  it("invertMatrix:单位阵求逆恒等,退化矩阵返回 null", () => {
    expect(invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toMatchObject({ a: 1, d: 1, e: 0, f: 0 });
    const inv = invertMatrix({ a: 2, b: 0, c: 0, d: 4, e: 10, f: 20 })!;
    for (const [got, want] of [
      [inv.a, 0.5],
      [inv.b, 0],
      [inv.c, 0],
      [inv.d, 0.25],
      [inv.e, -5],
      [inv.f, -5],
    ]) {
      expect(near(got, want)).toBe(true);
    }
    expect(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 2 })).toBeNull();
  });

  it("multiplyMatrix 先应用 m2 再应用 m1;mapBoxByMatrix 保 AABB 语义", () => {
    // translate(-10,-5) 再 translate(100,50)
    const m = multiplyMatrix(translate(100, 50), translate(-10, -5));
    expect(m).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 90, f: 45 });
    expect(mapBoxByMatrix({ x: 0, y: 0, width: 10, height: 10 }, m)).toEqual({ x: 90, y: 45, width: 10, height: 10 });
    // 旋转 90°:宽高互换(轴对齐外接矩形)
    const rot = mapBoxByMatrix({ x: 0, y: 0, width: 10, height: 4 }, { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 });
    expect(near(rot.width, 4)).toBe(true);
    expect(near(rot.height, 10)).toBe(true);
  });

  it("回归:两组 translate 的局部框不混坐标系(修复前 minX≈-430,修复后落在 root user space 内)", () => {
    // 实测板:viewBox="136 56 7261 2942";节点组局部 bbox 均为 x=-430(组内 text 的局部坐标)。
    const rootInv = invertMatrix(translate(136, 56))!; // root svg 自身 transform
    const groups = [
      { ctm: translate(726, 136), local: { x: -430, y: 0, width: 1200, height: 96 } }, // → root x=160(实测引擎 minX)
      { ctm: translate(6566, 136), local: { x: -430, y: 0, width: 1200, height: 96 } }, // → root x=6000
    ];
    // 修复前口径:直接并集局部框 → 左边缘越出 viewBox 左边(viewBox.x=136),与 witness minX=-431 同现象
    const rawUnion = groups.reduce(
      (acc, g) => mergeBounds(acc, g.local),
      null as null | { x: number; y: number; width: number; height: number },
    )!;
    expect(rawUnion.x).toBe(-430);
    expect(rawUnion.x).toBeLessThan(136); // 混坐标系 → bbox 比 viewBox 更宽
    // 修复后口径:先映射到 root user space 再并集
    const mappedUnion = groups
      .map((g) => mapBoxByMatrix(g.local, multiplyMatrix(rootInv, g.ctm)))
      .reduce((acc, box) => mergeBounds(acc, box), null as null | { x: number; y: number; width: number; height: number })!;
    expect(near(mappedUnion.x, 160)).toBe(true);
    expect(near(mappedUnion.width, 1200 + 6000 - 160 + 160 - 160)).toBe(true); // 160..7200
    expect(mappedUnion.x).toBeGreaterThanOrEqual(136); // 不再越出 viewBox 左边
    expect(mappedUnion.width).toBeLessThan(7261);
  });
});
