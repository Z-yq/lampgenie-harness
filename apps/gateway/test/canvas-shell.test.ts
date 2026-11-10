/**
 * 无限画布外壳(assets/canvas-shell.js)契约测试。
 *
 * 三层:
 *  ①语法层:资产可被 JS 引擎解析(node:vm 编译);
 *  ②几何层:纯函数行为(吸附/包围盒/适配/光标锚定缩放)——画布手感正确性的确定性守卫;
 *  ③接线层:面板页注入 canvas-shell + 脚本暴露 init/focus 等 API,且视图→卡片映射覆盖全部 17 视图(step-141 增 ide)。
 * 说明:本仓无 DOM 环境(无 jsdom),因此不对 DOM 交互做单测——交互验收走浏览器实测。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { servePanel } from "../src/panel.js";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = join(here, "..", "src", "assets", "canvas-shell.js");

/** 在最小沙箱里跑资产,拿到 window.CanvasShell(只取 __geom,不碰 DOM)。 */
function loadGeom() {
  const code = readFileSync(ASSET, "utf8");
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }),
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
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    CustomEvent: class {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "canvas-shell.js" });
  const api = (sandbox.window as Record<string, unknown>).CanvasShell as { __geom: Record<string, unknown> };
  return api.__geom as {
    clamp: (v: number, lo: number, hi: number) => number;
    snap: (v: number) => number;
    normRect: (r: Record<string, number>) => { x: number; y: number; w: number; h: number };
    normSavedCard?: (sc: Record<string, unknown> | null | undefined, def?: { x: number; y: number; w: number; h: number }) => { x: number; y: number; w: number; h: number };
    seedMissing?: (savedNames: Record<string, unknown> | null, defLayout: Record<string, { x: number; y: number; w: number; h: number }>, chatG: { x: number; y: number; w: number; h: number } | null) => Array<{ n: string; x: number; y: number; w: number; h: number }> | null;
    zoomAround: (v: { x: number; y: number; s: number }, px: number, py: number, f: number) => { x: number; y: number; s: number };
    boundsOf: (l: Array<{ x: number; y: number; w: number; h: number }>) => { x: number; y: number; w: number; h: number };
    fitView: (r: { x: number; y: number; w: number; h: number }, hw: number, hh: number, pad?: number) => { x: number; y: number; s: number };
    centerOn: (r: { x: number; y: number; w: number; h: number }, hw: number, hh: number, s: number) => { x: number; y: number; s: number };
    layoutFromSpecs: (s: Array<Record<string, unknown>>, startY?: number) => Record<string, { x: number; y: number; w: number; h: number }>;
    MIN_W: number;
    MIN_H: number;
    SNAP: number;
    XY_LIMIT: number;
  };
}

/** 从面板 HTML 里切出顶层函数源码(花括号配平)——与 panel-visual-layer.test.ts 同构,
 *  用来断言页面内函数的真实实现(而不是只断言字符串存在)。 */
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

describe("无限画布外壳", () => {
  it("①语法:资产可被 JS 引擎编译", () => {
    const code = readFileSync(ASSET, "utf8");
    expect(code.length).toBeGreaterThan(8000);
    expect(() => new vm.Script(code)).not.toThrow();
    expect(code).toContain("window.CanvasShell");
  });

  it("②几何:吸附/最小尺寸/包围盒/适配/光标锚定缩放", () => {
    const g = loadGeom();
    // 吸附:8px 网格(卡片拖动/缩放都走同一档)
    expect(g.SNAP).toBe(8);
    expect(g.snap(11)).toBe(8);
    expect(g.snap(13)).toBe(16);
    expect(g.snap(0)).toBe(0);
    // 最小尺寸钳制:低于下限的卡片不允许(否则内容被压成一条缝没法用)
    expect(g.MIN_W).toBe(320);
    expect(g.MIN_H).toBe(200);
    const r = g.normRect({ x: 10, y: 20, w: 100, h: 50 });
    expect(r).toEqual({ x: 10, y: 20, w: g.MIN_W, h: g.MIN_H });
    expect(g.normRect({})).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    // 包围盒:并集,不误吞负数尺寸
    const b = g.boundsOf([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: -50, w: 100, h: 100 }]);
    // y 从 -50 到 max(100, -50+100=50) = 100 → 高 150
    expect(b).toEqual({ x: 0, y: -50, w: 300, h: 150 });
    expect(g.boundsOf([])).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    // 适配:大包围盒缩到视口内并居中(pad 内缩)
    const f = g.fitView({ x: 0, y: 0, w: 1000, h: 1000 }, 800, 600, 50);
    expect(f.s).toBeCloseTo(0.5, 5); // (800-100)/1000=0.7 与 (600-100)/1000=0.5 取小
    expect(f.x).toBeCloseTo((800 - 1000 * f.s) / 2, 5);
    // 缩放钳制上限 2 倍(避免放大到像素糊)
    const f2 = g.fitView({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 10);
    expect(f2.s).toBeLessThanOrEqual(2);
    // 光标锚定缩放:缩放前后光标下的世界坐标不动(画布缩放的手感根因)
    const v0 = { x: 100, y: 50, s: 1 };
    const v1 = g.zoomAround(v0, 300, 200, 2);
    expect(v1.s).toBe(2);
    const wx = (300 - v1.x) / v1.s;
    const wy = (200 - v1.y) / v1.s;
    expect(wx).toBeCloseTo((300 - v0.x) / v0.s, 5);
    expect(wy).toBeCloseTo((200 - v0.y) / v0.s, 5);
    // 缩放钳制后仍保持锚点(幂等:到边界再缩不移动)
    const atMax = g.zoomAround({ x: 0, y: 0, s: 2 }, 100, 100, 2);
    expect(atMax.s).toBe(2);
    expect(atMax.x).toBe(0);
    // 居中:目标矩形中心落在视口中心
    const c = g.centerOn({ x: 100, y: 100, w: 400, h: 200 }, 1000, 800, 1);
    expect(c.x + (100 + 200) * c.s).toBeCloseTo(500, 5);
    expect(c.y + (100 + 100) * c.s).toBeCloseTo(400, 5);
  });

  it("②几何:显式坐标优先,缺失坐标按行流式补位(不重叠)", () => {
    const g = loadGeom();
    const out = g.layoutFromSpecs([
      { name: "a", x: 100, y: 200, w: 400, h: 300 },
      { name: "b", w: 500, h: 300 },
      { name: "c", w: 500, h: 300 },
    ]);
    expect(out.a).toEqual({ x: 100, y: 200, w: 400, h: 300 });
    // 自动补位的卡片不重叠(横向 40 间距)
    const b = out.b!, c = out.c!;
    expect(b.x + b.w).toBeLessThanOrEqual(c.x);
    expect(b.y).toBe(c.y);
  });

  it("②几何:持久化布局归一化(2026-10-21 标题压叠修复)——坏字段回默认、越界钳制、好值原样", () => {
    const g = loadGeom();
    const ns = g.normSavedCard!;
    const def = { x: 0, y: 680, w: 760, h: 440 };
    // ① JSON.stringify(NaN) 落盘成 null:必须按非法回退默认(null 会被 Number() 洗成 0)
    expect(ns({ x: null, y: null, w: null, h: null }, def)).toEqual(def);
    // ② 缺字段(undefined)= NaN 同路回退
    expect(ns({}, def)).toEqual(def);
    expect(ns(null, def)).toEqual(def);
    expect(ns(undefined, def)).toEqual(def);
    // ③ 非数值字符串回退
    expect(ns({ x: "abc", y: 10, w: 700, h: 400 }, def)).toEqual({ x: 0, y: 10, w: 700, h: 400 });
    // ④ w/h 低于最小值钳到 MIN;超大值钳上限
    expect(ns({ x: 1, y: 2, w: 10, h: 10 }, def)).toEqual({ x: 1, y: 2, w: g.MIN_W, h: g.MIN_H });
    expect(ns({ x: 1, y: 2, w: 1e9, h: 1e9 }, def).w).toBeLessThanOrEqual(100000);
    // ⑤ 坐标越界钳 ±XY_LIMIT(卡片永远拉不回的脏档拦下;正常拖拽不受影响)
    expect(ns({ x: 1e9, y: -1e9, w: 700, h: 400 }, def)).toEqual({ x: g.XY_LIMIT, y: -g.XY_LIMIT, w: 700, h: 400 });
    expect(ns({ x: 3000, y: -200, w: 700, h: 400 }, def)).toEqual({ x: 3000, y: -200, w: 700, h: 400 });
  });

  it("②几何:升级播种(2026-10-21 新卡可见性)——缺失卡紧贴 chat 右侧竖排,存档齐全/无 chat 返回 null", () => {
    const g = loadGeom();
    const sm = g.seedMissing!;
    const defLayout = { chat: { x: 0, y: 0, w: 900, h: 640 }, board: { x: 940, y: 0, w: 980, h: 680 }, subchat: { x: 5320, y: 0, w: 760, h: 900 } };
    const chatG = { x: 100, y: 50, w: 900, h: 640 };
    // ① subchat 缺席(升级新增)→ 紧贴 chat 右侧;board 在档 → 不动
    const r1 = sm({ chat: 1, board: 1 }, defLayout, chatG)!;
    expect(r1.map((c) => c.n)).toEqual(["subchat"]);
    expect(r1[0]).toEqual({ n: "subchat", x: 100 + 900 + 28, y: 50, w: 760, h: 900 });
    // ② 多卡缺失 → 同列竖排,逐卡下移 def.h+24(board h=680)
    const r2 = sm({ chat: 1 }, defLayout, chatG)!;
    expect(r2.map((c) => c.n)).toEqual(["board", "subchat"]);
    expect(r2[0].y).toBe(50);
    expect(r2[1].y).toBe(50 + 680 + 24);
    // ③ 存档齐全 / 无 chat 几何 → null(不动任何卡)
    expect(sm({ chat: 1, board: 1, subchat: 1 }, defLayout, chatG)).toBeNull();
    expect(sm({ chat: 1, board: 1 }, defLayout, null)).toBeNull();
  });

  it("③接线:面板页注入画布资产 + 桥接段覆盖 17 视图并暴露 init/focus", async () => {
    const port = 7881;
    const srv = servePanel(port, () => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // 资产加载(加载失败=退回经典布局,不是报错)
      expect(html).toContain('/assets/canvas-shell.js');
      // 路由分流层:switchView → switchViewActivate(视图逻辑零改写的落点)
      expect(html).toContain("function switchViewActivate(");
      expect(html).toContain("function canvasActive(");
      expect(html).toContain("function viewLive(");
      // 卡片规格:全部 17 个视图节点都要有卡片(缺一个=该模块在画布上消失;step-141 增 view-ide)
      for (const node of [
        "view-tasks", "view-term", "view-git", "view-files", "view-ide", "view-board", "view-project", "view-sense",
        "view-wf", "view-exp", "view-team", "view-nodes", "view-approvals", "view-market", "view-browser", "view-sys",
      ]) {
        expect(html, node + " 未挂卡片").toContain('node: "' + node + '"');
      }
      // 桥接 API
      expect(html).toContain("window.CanvasShell.init(CV_BRIDGE)");
      expect(html).toContain("function canvasAfterResize(");
      // 快捷键:形态互切 + 全卡入画
      expect(html).toContain("CanvasShell.toggleMode()");
      // 命令中心模块跳转
      expect(html).toContain("data-card=");
      // 身份/取数分层(2026-10-20 真 bug 守卫:懒激活曾用 switchViewActivate → 多卡并行进入视口会抢改
      // 「当前视图」身份,切回经典布局时显示错页)。三段职责必须是分开的函数,且懒激活只调取数。
      expect(html).toContain("function setViewIdentity(");
      expect(html).toContain("function applyViewChrome(");
      expect(html).toContain("function loadViewData(");
      const activate = extractFn(html, "canvasActivateCard");
      expect(activate, "懒激活不得改视图身份").not.toContain("switchViewActivate(");
      expect(activate, "懒激活不得直接写 dataset").not.toContain("dataset.view");
      expect(activate).toContain("loadViewData(");
      // 焦点同步是身份变更的唯一出口(桥接 onFocus → setViewIdentity)
      const bridge = html.slice(html.indexOf("const CV_BRIDGE"));
      const onFocus = bridge.slice(bridge.indexOf("onFocus(card)"), bridge.indexOf("onMode(mode)"));
      expect(onFocus).toContain("setViewIdentity(");
    } finally {
      await srv.close();
    }
  });

  it("③二期接线:屏幕 chrome 不固定(顶栏隐藏/侧栏浮动托盘;2026-10-21 双导航融合 cvRail 退役)", async () => {
    const port = 7883;
    const srv = servePanel(port, () => {});
    try {
      const asset = await (await fetch(`http://127.0.0.1:${port}/assets/canvas-shell.js`)).text();
      // 顶栏在画布形态退场;连接点下沉到托盘品牌点(面板侧 cvConn 维护)
      expect(asset).toContain("body.cv-shell header{display:none!important}");
      // cvRail 定位栏退役:样式/构建/事件全量移除,左缘留白归还画布(safeArea 左缘不再预留 58)
      expect(asset).not.toContain("#cvRail{");
      expect(asset).not.toContain('rail.id = "cvRail"');
      expect(asset).not.toContain(".cv-rail-btn");
      // 唤回职责迁托盘:卡片可见性广播(cv-cards 事件,面板监听后置灰托盘按钮)
      expect(asset).toContain("function notifyCards(");
      expect(asset).toContain('"cv-cards"');
      // 布局守卫(2026-10-21 标题压叠修复):载入归一化 + 脏值不落盘 + applyCard 非有限钳回
      expect(asset).toContain("normSavedCard(sc, defLayout[n])");
      expect(asset).toContain("function normSavedCard(");
      expect(asset.match(/Number\.isFinite/g)!.length).toBeGreaterThan(6);
      expect(asset).toContain("function setView(v)");
      // 侧栏 → 浮动托盘:位置/宽度走 CSS 变量并持久化(zh:cv-tray)
      expect(asset).toContain("body.cv-shell #sidebar{position:fixed;left:var(--cv-tray-x");
      expect(asset).toContain('zh:cv-tray');
      expect(asset).toContain("function trayApply(");
      expect(asset).toContain("function bindTray(");
      // 画布形态下视图已在卡片内,不再给固定侧栏让位
      expect(asset).toContain("body.cv-shell .page{padding-left:0!important}");
    } finally {
      await srv.close();
    }
  });

  it("③二期接线:Dify 卡片视觉 + 模块绑定 + 多选/对齐/右键菜单", async () => {
    const port = 7884;
    const srv = servePanel(port, () => {});
    try {
      const asset = await (await fetch(`http://127.0.0.1:${port}/assets/canvas-shell.js`)).text();
      // Dify 卡片视觉:图标块 + 标题/副标题两行 + 状态点 + 选中描边
      expect(asset).toContain(".cv-card-ico");
      expect(asset).toContain(".cv-card-sub");
      expect(asset).toContain(".cv-card-dot.st-run");
      expect(asset).toContain(".cv-card.on{border-color:var(--bronze)");
      expect(asset).toContain("function iconOf(");
      // 卡片状态点:面板推真实状态,画布只显示(不猜);托盘同名状态点在面板侧 cvCardStatus 维护
      expect(asset).toContain("function setCardStatus(");
      expect(asset).toContain("setCardStatus: function");
      // Dify 多选:框选矩形 / 选中态 / 对齐参考线 / 手柄模式切换
      expect(asset).toContain("#cvMarquee");
      expect(asset).toContain(".cv-card.sel");
      expect(asset).toContain(".cv-guide");
      expect(asset).toContain("function startMarquee(");
      expect(asset).toContain("function alignSnap(");
      expect(asset).toContain("function alignSelection(");
      expect(asset).toContain("ctrlMode");
      // 键盘:方向键微移 / Delete 只隐藏 / Ctrl+A 全选 / Esc 清选
      expect(asset).toContain("function bindCanvasKeys(");
      expect(asset).toContain("ArrowLeft");
      // 只认 Delete:Backspace 在焦点落在卡片上时会被误按,不再隐藏卡片
      expect(asset).toContain('e.key === "Delete"');
      expect(asset).not.toContain('e.key === "Delete" || e.key === "Backspace"');
      // 右键菜单三态(卡片/空白/多选)
      expect(asset).toContain("function ctxItemsFor(");
      expect(asset).toContain("#cvCtx");
      expect(asset).toContain("bindCtxMenu()");
      // 整组移动
      expect(asset).toContain("group");
    } finally {
      await srv.close();
    }
  });

  it("③二期接线:面板侧状态/尺寸补偿接线", async () => {
    const port = 7885;
    const srv = servePanel(port, () => {});
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      // 连接状态下沉(header 隐藏后唯一常驻连接指示)
      expect(html).toContain("function cvConn(");
      expect(html).toContain('cvConn(true, "已连接")');
      // 卡片状态点:待审批 / Git 变更 / 运行中,全部有真源
      expect(html).toContain("function cvStatusRefresh(");
      expect(html).toContain('cvCardStatus("approvals"');
      expect(html).toContain('cvCardStatus("git"');
      expect(html).toContain('cvCardStatus("chat"');
      // 画布提示出口(资产不依赖面板 toast 实现)
      expect(html).toContain("window.__cvToast");
      // header 隐藏后画布尺寸变化:已激活卡片要再量一次(规划稿风险 3)
      const resize = extractFn(html, "canvasAfterResize");
      for (const v of ['"git"', '"files"', '"approvals"', '"team"', '"exp"']) {
        expect(resize, "canvasAfterResize 缺 " + v + " 的尺寸补偿").toContain(v);
      }
    } finally {
      await srv.close();
    }
  });

  it("③接线:资产路由可取回(HTTP 200 + JS 内容)", async () => {
    const port = 7882;
    const srv = servePanel(port, () => {});
    try {
      const res = await fetch(`http://127.0.0.1:${port}/assets/canvas-shell.js`);
      expect(res.status).toBe(200);
      expect(String(res.headers.get("content-type"))).toContain("javascript");
      const body = await res.text();
      expect(body).toContain("window.CanvasShell");
      expect(() => new vm.Script(body)).not.toThrow();
    } finally {
      await srv.close();
    }
  });
});