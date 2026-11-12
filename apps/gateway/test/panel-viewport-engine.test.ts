/**
 * 任务B 定向测试:diagram-viewport 引擎接进画布/图容器 + mermaid 主题归一化接线。
 * 四组:
 *  ① 捏合数学:pointer 距离→scale、中心移→pan(canvas-shell pinchToView 与面板 bindZoomPan 内联兜底同式);
 *  ② 锚点缩放不变式:光标下世界内容点屏幕位移恒为 0(canvas-shell zoomAt / dvZoomAtPoint / 引擎本体);
 *  ③ 档位与复位:zoomToScale 档位以视口中心为锚、zoomReset=1:1+平移归零、HUD 按钮组齐全;
 *  ④ 紧凑 fit 排背景:resolveSvgBounds 排除画布背景 rect/不可见祖先,cvTightSvgBounds 回退链,
 *     fit 后 scale<0.7 仍钳 0.7(FIT_MIN_S / CV_FIT_READABLE_MIN 语义);
 *  ⑤ IDE 图片查看器(任务B B2):ideImgZoomTo 锚点走引擎、档位 50/100/200、复位 ⌂、
 *     白名单与字节上限(IDE_ASSET_IMG_*)原样保留。
 * 形态:零 chrome——canvas-shell 走 vm 沙箱取 __geom 纯函数;面板函数走 extractFn(与
 * panel-canvas-fixes.test.ts 同构);引擎本体直接 import 资产 ESM 尾部导出。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { servePanel } from "../src/panel.js";
import * as DV from "../src/assets/diagram-viewport.js";
const here = dirname(fileURLToPath(import.meta.url));
const SHELL = join(here, "..", "src", "assets", "canvas-shell.js");
import { PANEL_SRC } from "./panel-source.js";

/** 最小沙箱跑 canvas-shell,取 __geom 纯函数(与 canvas-shell.test.ts 同构)。 */
function loadGeom() {
  const code = readFileSync(SHELL, "utf8");
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      head: { appendChild() {} },
      body: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "", display: "block" }),
    CustomEvent: class {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "canvas-shell.js" });
  const api = (sandbox.window as Record<string, unknown>).CanvasShell as { __geom: Record<string, unknown> };
  return api.__geom as Record<string, (...args: unknown[]) => unknown> & Record<string, unknown>;
}

/** 面板 HTML 里花括号配平切顶层函数(panel-canvas-fixes 同构)。 */
function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

/** 在 Node 里求值一段面板函数(依赖注入;面板脚本是 ES5 风格浏览器代码,顶层函数可直接 eval)。 */
function evalFn<T>(src: string, deps: Record<string, unknown>, name: string): T {
  const keys = Object.keys(deps);
  const f = new Function(...keys, src + "; return " + name + ";", )(...keys.map((k) => deps[k]));
  return f as T;
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 不需要 WS */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("任务B ① 捏合数学(pointer 距离→scale / 中心移→pan)", () => {
  it("距变→scale:距离翻倍=倍率翻倍(钳域内),初始中心下的世界点不动", () => {
    const g = loadGeom();
    const pinchToView = g.pinchToView as (v: { x: number; y: number; s: number }, d0: number, d1: number, c0x: number, c0y: number, c1x: number, c1y: number) => { x: number; y: number; s: number };
    const v0 = { x: 100, y: 50, s: 1 };
    // 双指中心不动(c0=c1),距离 200→400 → s 1→2;中心下的世界点 w=(c0-v0)/s0 应仍落在 c0
    const out = pinchToView(v0, 200, 400, 300, 200, 300, 200);
    expect(out.s).toBeCloseTo(2, 10);
    const wx = (300 - v0.x) / v0.s; // 200
    expect(out.x).toBeCloseTo(300 - wx * out.s, 10); // 300-200*2=-100
    expect(out.x).toBe(-100);
  });
  it("心移→pan:距离不变、中心平移 (40,30) → 平移量=Δc(1:1 时)", () => {
    const g = loadGeom();
    const pinchToView = g.pinchToView as (v: { x: number; y: number; s: number }, d0: number, d1: number, c0x: number, c0y: number, c1x: number, c1y: number) => { x: number; y: number; s: number };
    const out = pinchToView({ x: 0, y: 0, s: 1 }, 150, 150, 200, 100, 240, 130);
    expect(out.s).toBeCloseTo(1, 10);
    expect(out.x).toBeCloseTo(40, 10);
    expect(out.y).toBeCloseTo(30, 10);
  });
  it("钳域与 NaN 防线:距离比不炸上限、d0≤0/非有限距离原样返回", () => {
    const g = loadGeom();
    const pinchToView = g.pinchToView as (v: { x: number; y: number; s: number }, d0: number, d1: number, c0x: number, c0y: number, c1x: number, c1y: number) => { x: number; y: number; s: number };
    const zMax = (g.Z_MAX as unknown as number) ?? 2; // canvas-shell 钳域上限(Z_MAX=2,__geom 未导出时用实现常量)
    const huge = pinchToView({ x: 0, y: 0, s: 1 }, 10, 1e9, 0, 0, 0, 0);
    expect(huge.s).toBeLessThanOrEqual(zMax);
    const bad = pinchToView({ x: 5, y: 5, s: 1 }, 0, 300, 0, 0, 10, 10); // d0=0:距离噪声,原样返回
    expect(bad).toEqual({ x: 5, y: 5, s: 1 });
    const bad2 = pinchToView({ x: 5, y: 5, s: 1 }, 100, NaN, 0, 0, 10, 10);
    expect(bad2).toEqual({ x: 5, y: 5, s: 1 });
    const fin = pinchToView({ x: 0, y: 0, s: 1 }, 100, 200, 0, 0, 0, 0);
    expect(Number.isFinite(fin.x) && Number.isFinite(fin.y) && Number.isFinite(fin.s)).toBe(true);
  });
  it("面板 bindZoomPan 捏合兜底同式:引擎缺席时距离比/中心重投影数学一致(每容器闭包不串扰)", async () => {
    await withPanel(7891, (html) => {
      const body = extractFn(html, "bindZoomPan");
      // 兜底分支断言:dvLib() 空手时 pinchMove 用同式(距离比→clamp(0.25,4)、c0 世界点重投影)
      expect(body).toContain("s0 * (d / pinch.d0)");
      expect(body).toContain("Math.min(4, Math.max(0.25");
      expect(body).toContain("c1x - wx * ns");
      // 每容器一份闭包状态:pts/pinch 都在函数体内 let 声明(两实例不共享)
      expect(body).toContain("let pts = {}, pinch = null");
    });
  });
});

describe("任务B ② 锚点缩放不变式(光标下内容点屏幕位移=0)", () => {
  const t0 = { scale: 1, translateX: 40, translateY: -20 };
  const p = { x: 320, y: 180 };
  it("引擎 zoomAtPoint:任取 nextScale,光标下的图内容点屏幕落位不变", () => {
    for (const ns of [0.25, 0.6, 1, 1.7, 4, 99]) {
      const t1 = DV.zoomAtPoint(t0, p, ns);
      // 光标下的内容点:diagram = (p - t0)/s0;新倍率下其屏幕位 t1 + diagram*s1 必须仍= p
      const dx = (p.x - t0.translateX) / t0.scale;
      const dy = (p.y - t0.translateY) / t0.scale;
      expect(t1.translateX + dx * t1.scale).toBeCloseTo(p.x, 9);
      expect(t1.translateY + dy * t1.scale).toBeCloseTo(p.y, 9);
    }
  });
  it("canvas-shell zoomAt 同式(世界坐标版:wx=(px-x)/s 重投影)", () => {
    const g = loadGeom();
    const zoomAt = g.zoomAt as (v: { x: number; y: number; s: number }, px: number, py: number, ns: number) => { x: number; y: number; s: number };
    const v = { x: 40, y: -20, s: 1 };
    for (const ns of [0.25, 1, 2, 4]) {
      const o = zoomAt(v, 320, 180, ns);
      // 光标世界点 wx=(320-40)/1=280;新 view 下其屏幕位 40→x+wx*ns 应=320
      const wx = (320 - v.x) / v.s;
      expect(o.x + wx * o.s).toBeCloseTo(320, 9);
    }
  });
  it("wheel=锚点缩放:canvas-shell wheel 处理走 zoomBy(锚点)而非纯步进;面板 dvZoomAtPoint 引擎优先", async () => {
    const code = readFileSync(SHELL, "utf8");
    expect(code).toMatch(/zoomBy\(f, p\.x, p\.y\)/); // wheel 缩放带光标锚
    await withPanel(7892, (html) => {
      const body = extractFn(html, "dvZoomAtPoint");
      expect(body).toContain("lib.zoomAtPoint"); // 引擎在场优先委托
      expect(body).toContain("p.x - wx * next");  // 缺席兜底同式
    });
  });
});

describe("任务B ③ 档位(50/100/200)与复位", () => {
  it("HUD 按钮组:z50/z100/z200/vreset(⌂ 复位)/fit(适)齐全,样式走现有 #cvHud button 风格", () => {
    const code = readFileSync(SHELL, "utf8");
    expect(code).toContain('data-act="z50"');
    expect(code).toContain('data-act="z100"');
    expect(code).toContain('data-act="z200"');
    expect(code).toContain('data-act="vreset"');
    expect(code).toContain('data-act="fit"');
    expect(code).toMatch(/z50"\) zoomToScale\(0\.5\)/);
    expect(code).toMatch(/z100"\) zoomToScale\(1\)/);
    expect(code).toMatch(/z200"\) zoomToScale\(2\)/);
    expect(code).toMatch(/vreset"\) zoomReset\(\)/);
  });
  it("zoomReset=1:1 + 平移归零(zero 视口,非布局重置)", () => {
    const g = loadGeom();
    // zoomReset 内联 setView({0,0,1}):通过源码断言 + applyView 的 pct 文本联动
    const code = readFileSync(SHELL, "utf8");
    expect(code).toMatch(/function zoomReset\(\) \{ setView\(\{ x: 0, y: 0, s: 1 \}\); \}/);
    expect(g.FIT_MIN_S).toBe(0.7);
  });
  it("档位以视口中心为锚:zoomToScale 委托 zoomAt(host 中心)", () => {
    const code = readFileSync(SHELL, "utf8");
    expect(code).toMatch(/function zoomToScale\(scale\) \{\s*var h = hostRect\(\);\s*setView\(zoomAt\(S\.view, h\.w \/ 2, h\.h \/ 2, scale\)\);/);
  });
});

describe("任务B ④ 紧凑 fit 排背景(fit 后 <0.7 仍钳 0.7)", () => {
  it("引擎 resolveSvgBounds:画布背景 rect(覆盖 ≥95% + 透明描边/background 类)不计入并集", () => {
    const rootBounds = { x: 0, y: 0, width: 1000, height: 800 };
    const mkView = (over: Partial<{ className: string; stroke: string }>) => ({
      tagName: "rect", className: over.className || "", stroke: over.stroke === undefined ? "none" : over.stroke,
      display: "", visibility: "", opacity: "1", ancestorTagNames: [],
      box: { x: 0, y: 0, width: 1000, height: 800 },
    });
    // 全覆盖背景 rect:排除 → 回退 rootBounds(全空)
    const els = [mkView({})];
    const b1 = DV.resolveSvgBounds(rootBounds, els, (el) => (el as ReturnType<typeof mkView>), () => ({ x: 0, y: 0, width: 1000, height: 800 }));
    expect(b1.width).toBe(1000); // 回退 root(无可见内容)
    // 背景板 + 左上角小图形:并集=小图形,背景被排掉
    const els2 = [
      mkView({}),
      { tagName: "rect", className: "", stroke: "#fff", display: "", visibility: "", opacity: "1", ancestorTagNames: [], box: { x: 10, y: 10, width: 50, height: 30 } },
    ];
    const b2 = DV.resolveSvgBounds(rootBounds, els2, (el) => el as ReturnType<typeof mkView>, (el) => (el as { box: { x: number; y: number; width: number; height: number } }).box);
    expect(b2.x).toBe(10); expect(b2.y).toBe(10);
    expect(b2.width).toBe(50); expect(b2.height).toBe(30);
  });
  it("不可见祖先(defs/mask/clipPath)与 display:none 元素不进并集", () => {
    const rootBounds = { x: 0, y: 0, width: 500, height: 400 };
    type V = { tagName: string; className: string; stroke: string; display: string; visibility: string; opacity: string; ancestorTagNames: string[]; box: { x: number; y: number; width: number; height: number } };
    const views: V[] = [
      { tagName: "g", className: "", stroke: "", display: "", visibility: "", opacity: "1", ancestorTagNames: ["defs"], box: { x: 0, y: 0, width: 400, height: 300 } },
      { tagName: "path", className: "", stroke: "", display: "none", visibility: "", opacity: "1", ancestorTagNames: [], box: { x: 0, y: 0, width: 400, height: 300 } },
      { tagName: "circle", className: "", stroke: "", display: "", visibility: "", opacity: "1", ancestorTagNames: [], box: { x: 100, y: 80, width: 60, height: 60 } },
    ];
    const b = DV.resolveSvgBounds(rootBounds, views, (el) => el as V, (el) => (el as V).box);
    expect(b.x).toBe(100); expect(b.width).toBe(60);
  });
  it("面板 cvFitNow:引擎路径(紧凑边界)优先 + 回退 viewBox;fit<0.7 钳 CV_FIT_READABLE_MIN", async () => {
    await withPanel(7893, (html) => {
      const tight = extractFn(html, "cvTightSvgBounds");
      expect(tight).toContain("resolveSvgBoundsFromDom");   // 引擎优先
      expect(tight).toContain("cvSvgContentBox");            // 缺席回退 viewBox/声明尺寸
      const fit = extractFn(html, "cvFitNow");
      expect(fit).toContain("cvTightSvgBounds");             // 「适」走紧凑边界
      expect(PANEL_SRC).toContain("CV_FIT_READABLE_MIN = 0.7");
      expect(fit).toContain("CV_FIT_READABLE_MIN");
      // 旧 viewBox fit 双写不复存在:fit 里不再有第二处独立解析 viewBox 的路径
      expect(fit.includes("cvTightSvgBounds") && !/viewBox[^"]*getAttribute\("viewBox"\).*scale/.test(fit)).toBe(true);
    });
  });
  it("板内容等价紧凑边界:cvFitNow 遍历真实卡片 DOM(.cv-node/.cv-fold)bbox 并集", async () => {
    await withPanel(7890, (html) => {
      const fit = extractFn(html, "cvFitNow");
      expect(fit).toContain('.querySelectorAll(".cv-node,.cv-fold")');
      expect(fit).toContain("offsetWidth"); // DOM 实测而非写死 220/110
    });
  });
});

describe("任务B ⑤ IDE 图片查看器接同一引擎(B2)", () => {
  it("ideImgZoomTo:引擎优先(dvLib→zoomAtPoint),缺席兜底同式;锚点不变式成立", async () => {
    await withPanel(7895, async (html) => {
      const zoomSrc = extractFn(html, "ideImgZoomTo");
      expect(zoomSrc).toContain("dvLib()");
      expect(zoomSrc).toContain("zoomAtPoint");
      // 兜底数学(引擎缺席):dvZoomAtPoint 就地同式
      const dvSrc = extractFn(html, "dvZoomAtPoint");
      expect(dvSrc).toContain("p.x - wx * next");
      // 不变式:引擎真身(与 ② 同式)在缩放链上生效——直接用引擎函数验证锚点保持
      const t = DV.zoomAtPoint({ scale: 1, translateX: 0, translateY: 0 }, { x: 90, y: 60 }, 2.5);
      expect(t.translateX + 90 * t.scale).toBeCloseTo(90, 9);
      expect(t.translateY + 60 * t.scale).toBeCloseTo(60, 9);
    });
  });
  it("档位 50/100/200 + 复位 ⌂ 进 ideImgBar;复位=1:1+平移归零", async () => {
    await withPanel(7896, (html) => {
      expect(html).toContain('data-ide-z="z50"');
      expect(html).toContain('data-ide-z="z100"');
      expect(html).toContain('data-ide-z="z200"');
      expect(html).toContain('data-ide-z="vreset"');
      const wire = extractFn(html, "ideImgWire");
      expect(wire).toMatch(/"z50"\) ideImgZoomTo\(0\.5/);
      expect(wire).toMatch(/"z100"\) ideImgZoomTo\(1,/);
      expect(wire).toMatch(/"z200"\) ideImgZoomTo\(2,/);
      const reset = extractFn(html, "ideImgReset");
      expect(reset).toContain("ideImgPaint(1, false)");
      expect(reset).toContain("scroll.scrollLeft = 0");
      expect(reset).toContain("scroll.scrollTop = 0");
    });
  });
  it("白名单与字节上限原样保留(IDE_ASSET_IMG_EXT / IDE_ASSET_IMG_MAX_BYTES)", async () => {
    // 这两个常量在 /ide/asset 服务端路由段(不进浏览器 HTML),断言源码本身
    expect(PANEL_SRC).toContain("const IDE_ASSET_IMG_EXT = new Set");
    expect(PANEL_SRC).toContain("IDE_ASSET_IMG_MAX_BYTES = 32 * 1024 * 1024");
    expect(PANEL_SRC).toContain('"png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"');
    await withPanel(7897, (html) => {
      // 图片查看器骨架与档位 UI 仍在页面内(IDE 编辑区骨架)
      expect(html).toContain('id="ideImgBar"');
      expect(html).toContain('data-ide-z="vreset"');
    });
  });
});

describe("任务B ⑥ mermaid 主题归一化接线(B3)", () => {
  it("两个 initialize 调用点都经 mmThemeVars()(归一化优先,失败静默回退)", async () => {
    await withPanel(7898, (html) => {
      const fn = extractFn(html, "mmThemeVars");
      expect(fn).toContain("MermaidThemeNormalize");
      expect(fn).toContain("normalizeMermaidThemeVars");
      expect(fn).toContain("createCanvasColorSampler");
      expect(fn).toContain("return vars"); // 引擎缺席/抛错:回退原始值,渲染不炸
      // 两处 initialize 均喂 mmThemeVars()
      expect((html.match(/themeVariables: mmThemeVars\(\)/g) || []).length).toBeGreaterThanOrEqual(3); // 解析期首次 + 懒加载 onload + 资产挂载补跑
    });
  });
  it("浅主题缺口:applySettings 主题签名变更后走 mmApplyTheme 重新 initialize(变量按基座归一化)", async () => {
    await withPanel(7902, (html) => {
      // ① 接线:主题签名落定后必须触发 mermaid 重初始化(旧实现仅解析期一次且写死 theme:"dark")
      const i = html.indexOf("__lastThemeSig = themeSig;");
      expect(i, "applySettings 未找到主题签名落点").toBeGreaterThan(0);
      const tail = html.slice(i, i + 800);
      expect(tail).toContain('typeof mmApplyTheme === "function"');
      expect(tail).toContain("mmApplyTheme();");
      // ② 本体:initialize + themeVariables 走 mmThemeVars(归一化链路不被绕过)
      const fn = extractFn(html, "mmApplyTheme");
      expect(fn).toContain("window.mermaid.initialize");
      expect(fn).toContain("themeVariables: mmThemeVars()");
 // ④ 基座名(取证经验证):本仓 mermaid 构建只有 theme:"base" 才吃 themeVariables,
      //    "dark"/"default" 用自身默认色板 —— 浅主题下节点仍是被写死的 #1f2020 深卡。
      //    故 initialize 的 theme 必须按基座取 mmBaseTheme()(浅="base"),不能继续写死 "dark"。
      const baseFn = extractFn(html, "mmBaseTheme");
      expect(baseFn).toContain("isLightBase()");
      expect(baseFn).toContain('"base"');
      expect(fn).toContain("theme: mmBaseTheme()");
      expect(html).not.toContain('theme: "dark"'); // 四个 initialize 调用点全部改走基座函数
      // ③ 变量按当前基座取:浅主题不再是深色底(#0b0806)
      const vars = extractFn(html, "mmThemeVars");
      expect(vars).toContain("isLightBase()");
      expect(vars).toContain("#faf6ee");
    });
    // ④ 行为:同一个 mmThemeVars 在浅/深基座下产出不同底色(浅主题不再吃深色变量)
    const src = extractFn(PANEL_SRC, "mmThemeVars");
    const lightVars = evalFn<() => Record<string, string>>(src, { isLightBase: () => true, window: {} }, "mmThemeVars");
    const darkVars = evalFn<() => Record<string, string>>(src, { isLightBase: () => false, window: {} }, "mmThemeVars");
    expect(lightVars().background).toBe("#faf6ee");
    expect(darkVars().background).toBe("#0b0806");
    expect(lightVars().primaryTextColor).not.toBe(darkVars().primaryTextColor);
  });
  it("资产挂载:diagram-viewport/mermaid-theme-normalize 动态 import 挂 window + 同源路由", async () => {
    await withPanel(7899, async (html) => {
      expect(html).toContain('mount("/assets/diagram-viewport.js", "DiagramViewport")');
      expect(html).toContain('mount("/assets/mermaid-theme-normalize.js", "MermaidThemeNormalize")');
      // 路由可达(同源资产服务,panel.ts 先例照做)
      const srv2 = servePanel(7871, () => { /* 不需要 WS */ });
      try {
        const r1 = await fetch("http://127.0.0.1:7871/assets/diagram-viewport.js");
        expect(r1.status).toBe(200);
        const r2 = await fetch("http://127.0.0.1:7871/assets/mermaid-theme-normalize.js");
        expect(r2.status).toBe(200);
      } finally { await srv2.close(); }
    });
  });
});

describe("任务B ⑦ transform 卫生(无 NaN/Infinity 路径 + viewBox 双写检查)", () => {
  it("canvas-shell setView 非有限值钳回;applyView 收规 4 位小数", () => {
    const code = readFileSync(SHELL, "utf8");
    expect(code).toContain("Number.isFinite(v.x) ? v.x : 0");
    expect(code).toContain("Math.round(v.s * 10000) / 10000");
  });
  it("grep viewBox:canvas-shell 仅图标模板一处(无旧 viewBox fit 双写)", () => {
    const code = readFileSync(SHELL, "utf8");
    const hits = code.split("\n").map((l, i) => (l.includes("viewBox") ? i + 1 : 0)).filter(Boolean);
    expect(hits).toEqual([76]); // 唯一命中=ic 图标 path 的 viewBox 模板
  });
});
