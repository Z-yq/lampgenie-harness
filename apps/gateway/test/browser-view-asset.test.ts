/**
 * 内置浏览器视图资产(assets/browser-view.js)契约测试。
 *
 * 三层:
 *  ①语法层:new Function 解析资产不抛错(与 test/panel-script-syntax.test.ts 同形态;
 *    资产无 TS 编译护栏,坏文件会随构建直进产线);
 *  ②导出层:注入 fake window/document 执行后 window.GenieBrowserView 五个键齐全,state() 初态正确;
 *  ③纯函数层:缩放 clamp/fit(双轴)、8 向视口拖拽换算(带符号方向因子)、滚轮意图判定
 *    (Ctrl/Meta=zoom、横向 deltaX=scroll)、URL 协议白名单(与
 *    ZCode/packages/ui/src/browser-use/{browserViewportZoom.ts,useEmbeddedBrowserWheelChain.ts,
 *    ResponsiveBrowserResizeHandles.tsx} 的语义对齐,辅助工具语义同 embeddedBrowserHelpers)。
 * 另加禁用形态扫描:import/export/<script/内联 onclick/ eval —— 资产必须是零构建的普通 <script>。
 * 说明:本仓无 jsdom,DOM 交互不在此做单测(验收走浏览器实测)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = join(here, "..", "src", "assets", "browser-view.js");
const code = readFileSync(ASSET, "utf8");

/** 只够资产初始化用的最小 document;DOM 交互面不在此覆盖。 */
function fakeDoc() {
  const node = () => ({
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    childNodes: [],
    textContent: "",
  });
  return {
    createElement: () => node(),
    getElementById: () => null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} },
    body: { appendChild() {}, style: {}, classList: { add() {}, remove() {} } },
  };
}

/** 注入 fake window/document 执行一次,拿到 window.GenieBrowserView。 */
function loadView(): Record<string, any> {
  const fakeWindow: Record<string, any> = {};
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "document", code);
  run(fakeWindow, fakeDoc());
  return fakeWindow.GenieBrowserView;
}

const view = loadView();

describe("内置浏览器视图资产:语法与导出面", () => {
  it("可被 JS 引擎解析(new Function 只编译)", () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(code)).not.toThrow();
  }, 30_000);

  it("注入的 fake window 上挂载 GenieBrowserView,五个键齐全", () => {
    expect(view).toBeTruthy();
    for (const key of ["mount", "unmount", "handleMessage", "state"]) {
      expect(typeof view[key], key).toBe("function");
    }
    expect(view.__test).toBeTruthy();
    for (const key of [
      "clampZoom",
      "fitZoom",
      "nextViewportForDrag",
      "wheelDecision",
      "normalizeUrl", // 协议白名单也挂 __test 供断言
    ]) {
      expect(typeof view.__test[key], key).toBe("function");
    }
  });

  it("state() 初态是 agent 模式 + 1280x720 + fit 缩放 + 导航四态干净", () => {
    const s = view.state();
    expect(s).toMatchObject({
      tabId: null,
      tabs: [],
      url: "",
      zoom: "fit",
      humanMode: false,
      viewport: { width: 1280, height: 720 },
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      errorMessage: null,
    });
    expect(s.lastSeq).toBe(-1);
    // 未 mount 时 unmount/handleMessage 不得抛错(宿主可能提前调用)
    expect(() => view.handleMessage(null)).not.toThrow();
    expect(() => view.unmount()).not.toThrow();
  });
});

describe("内置浏览器视图资产:__test 纯函数", () => {
  const { clampZoom, fitZoom, nextViewportForDrag, wheelDecision, normalizeUrl } = view.__test;

  it("clampZoom 收敛到 [0.5,2]", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom("0.75")).toBe(0.75); // 来自 data-zoom 字符串
    expect(clampZoom(NaN)).toBe(1); // 脏输入退化为 1,不污染 canvas 尺寸
  });

  it("fitZoom 双轴取 min、上界 1(只缩不放),分母无效退 1", () => {
    // 任务书基准例:960x600 stage 减 32px 留白 → (960-32)/1920=0.4833 胜出
    expect(fitZoom(1920, 1080, 960, 600)).toBeCloseTo(0.4833, 4);
    // 小图不放大:双轴算出来都 >1,仍取上界 1
    expect(fitZoom(400, 200, 960, 600)).toBe(1);
    // 高度轴绑定:availH=(432-32)/600=0.6667 < availW=(2000-32)/800=2.46
    expect(fitZoom(800, 600, 2000, 432)).toBeCloseTo(0.6667, 4);
    // 宽度轴绑定:availW=(632-32)/800=0.75 < availH=(1000-32)/600=1.613
    expect(fitZoom(800, 600, 632, 1000)).toBe(0.75);
    // 图尺寸无效 / 可用空间 ≤0(stage 比留白还小):退 1,不产生 0/负比例
    expect(fitZoom(0, 1080, 960, 600)).toBe(1);
    expect(fitZoom(1920, 0, 960, 600)).toBe(1);
    expect(fitZoom(1920, 1080, 32, 32)).toBe(1);
    expect(fitZoom(1920, 1080, 0, 0)).toBe(1);
    // fitZoom 的上界口径独立于 clampZoom:不走 [0.5,2] 的档位 clamp
    expect(fitZoom(100, 100, 2000, 2000)).toBe(1);
  });

  it("nextViewportForDrag 8 向带符号因子:n 上拖增高、w 左拖增宽、角双向", () => {
    const start = { width: 1280, height: 720 };
    // 任务书基准例
    expect(nextViewportForDrag(start, 0, -100, "n")).toEqual({ width: 1280, height: 820 });
    expect(nextViewportForDrag(start, -100, 0, "w")).toEqual({ width: 1380, height: 720 });
    expect(nextViewportForDrag(start, 100, -50, "ne")).toEqual({ width: 1380, height: 770 });
    // 全 8 向:边缘把手
    expect(nextViewportForDrag(start, 0, 100, "n")).toEqual({ width: 1280, height: 620 }); // n 反向:向下拖 = 变矮
    expect(nextViewportForDrag(start, 0, 100, "s")).toEqual({ width: 1280, height: 820 });
    expect(nextViewportForDrag(start, 0, -100, "s")).toEqual({ width: 1280, height: 620 });
    expect(nextViewportForDrag(start, 100, 0, "e")).toEqual({ width: 1380, height: 720 });
    expect(nextViewportForDrag(start, -100, 0, "e")).toEqual({ width: 1180, height: 720 });
    expect(nextViewportForDrag(start, 100, 0, "w")).toEqual({ width: 1180, height: 720 }); // w 反向:右拖 = 变窄
    // 角把手双向(nw/se 同向双增、ne/sw 对角互补)
    expect(nextViewportForDrag(start, -100, -50, "nw")).toEqual({ width: 1380, height: 770 });
    expect(nextViewportForDrag(start, 100, 50, "se")).toEqual({ width: 1380, height: 770 });
    expect(nextViewportForDrag(start, -100, 50, "sw")).toEqual({ width: 1380, height: 770 });
    // 反向拖角 = 对应轴双双变小
    expect(nextViewportForDrag(start, -100, -50, "se")).toEqual({ width: 1180, height: 670 });
    expect(nextViewportForDrag(start, 100, 50, "nw")).toEqual({ width: 1180, height: 670 });
    // 边界:两个方向都收敛在 [200,4096],且取整数
    expect(nextViewportForDrag(start, 9999, 9999, "se")).toEqual({ width: 4096, height: 4096 });
    expect(nextViewportForDrag(start, 0, -9999, "n")).toEqual({ width: 1280, height: 4096 }); // n 上拖到顶
    expect(nextViewportForDrag(start, 0, 9999, "n")).toEqual({ width: 1280, height: 200 }); // n 下拖到底
    expect(nextViewportForDrag({ width: 300, height: 300 }, -900, -900, "se")).toEqual({
      width: 200,
      height: 200,
    });
    // 未知把手 = 不移动任何轴
    expect(nextViewportForDrag(start, 50, 50, "zzz")).toEqual({ width: 1280, height: 720 });
    expect(nextViewportForDrag(null, 50, 50, "e")).toEqual({ width: 1330, height: 720 }); // 脏起点退默认
  });

  it("wheelDecision:Ctrl/Meta=zoom 优先,其余一律 scroll(适配态也滚页面)", () => {
    expect(wheelDecision({ ctrl: true, deltaY: 100, deltaX: 0, overflowing: false })).toBe("zoom");
    expect(wheelDecision({ meta: true, deltaY: -100, deltaX: 0, overflowing: true })).toBe("zoom");
    expect(wheelDecision({ ctrl: true, deltaX: 40, deltaY: 0, overflowing: false })).toBe("zoom"); // 缩放永远优先
    // 2026-11 实修:默认(含适配缩放「画布不溢出容器」)必须滚页面——旧口径回 pass 导致滚轮完全无反应
    expect(wheelDecision({ ctrl: false, deltaX: 0, deltaY: 100, overflowing: false })).toBe("scroll");
    expect(wheelDecision({ ctrl: false, deltaX: 0, deltaY: 100, overflowing: true })).toBe("scroll");
    // 触控板横向滑动同样交给页面滚(下发 deltaX,服务端 cua 支持)
    expect(wheelDecision({ ctrl: false, deltaX: 40, deltaY: 0, overflowing: false })).toBe("scroll");
    expect(wheelDecision({ ctrl: false, deltaX: -40, deltaY: 0, overflowing: false })).toBe("scroll");
    expect(wheelDecision({ ctrl: false, deltaX: 12, deltaY: -3, overflowing: false })).toBe("scroll");
    expect(wheelDecision(null)).toBe("scroll");
    expect(wheelDecision({})).toBe("scroll"); // deltaX 缺省按 0,不误判
  });
  it("queueScroll/flushScroll 合并 dx+dy 并节流(源码形态守卫)", () => {
    expect(code).toContain('var args = { op: "scroll" };');
    expect(code).toContain("if (dx) args.deltaX = Math.round(dx);");
    expect(code).toContain("if (dy) args.deltaY = Math.round(dy);");
    expect(code).toContain("S.pendingScrollX += dx;");
    expect(code).toContain("queueScroll(num(ev.deltaX, 0), num(ev.deltaY, 0));");
  });

  it("normalizeUrl 协议白名单:javascript:/data:text/html 等一律拒收为 \"\"", () => {
    // 显式白名单
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
    expect(normalizeUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    // 显式黑名单(安全洞收口:script URL / HTML data / 私有协议)
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
    expect(normalizeUrl("JAVASCRIPT:alert(1)")).toBe(""); // 大小写绕过也拦
    expect(normalizeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(normalizeUrl("vbscript:msgbox")).toBe("");
    expect(normalizeUrl("ftp://example.com")).toBe("");
    expect(normalizeUrl("about:config")).toBe(""); // about: 只放 blank
    expect(normalizeUrl("blob:https://x/y")).toBe("");
    // 无协议补全(地址栏习惯:localhost/IP 走 http,其余走 https)
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
    // 空值 / 脏输入
    expect(normalizeUrl("")).toBe("");
    expect(normalizeUrl(null)).toBe("");
    expect(normalizeUrl(undefined)).toBe("");
    expect(normalizeUrl("   ")).toBe("");
  });
});

describe("内置浏览器视图资产:实现接线守卫(源码形态扫描)", () => {
  it("onFrame 拖拽期不回写 viewport(S.dragging 闸门)", () => {
    expect(code).toContain("S.dragging = true");
    expect(code).toMatch(/if \(!S\.dragging && msg\.viewport && msg\.viewport\.width\)/);
    // pointerup / pointercancel / window blur 三路都要结束拖拽
    expect(code).toMatch(/onDrag\(W, "pointerup", endDrag\)/);
    expect(code).toMatch(/onDrag\(W, "pointercancel", endDrag\)/);
    expect(code).toMatch(/on\(W, "blur",[\s\S]{0,80}endDrag\(\)/);
  });

  it("系统浏览器出口只放 http/https/file", () => {
    expect(code).toContain("function isExternalOpenable");
    expect(code).toMatch(/return \/\^\(https\?\|file\):\/i\.test\(v\)/);
  });

  it("偏好持久化 gbv-prefs:try/catch 包裹且 humanMode 不写", () => {
    expect(code).toContain('"gbv-prefs"');
    expect(code).toMatch(/function savePrefs\(\)\s*\{\s*if \(S\.humanMode\) return;/);
  });

  it("把手键盘与 aria:tabIndex + aria-valuemin/max/now + 防抖提交", () => {
    expect(code).toMatch(/handle\.tabIndex = 0/);
    expect(code).toContain('handle.setAttribute("aria-valuenow"');
    expect(code).toContain("VP_COMMIT_DEBOUNCE_MS");
    expect(code).toContain('b.setAttribute("aria-pressed", "false")'); // 缩放档
  });

  it("四态与 getState 轮询的文案锚点在场", () => {
    expect(code).toContain('"页面崩溃"');
    expect(code).toContain("截图解码失败");
    expect(code).toContain("不支持的地址协议");
    expect(code).toContain('action: "getState"');
    expect(code).toContain("browser.view.command.result");
  });

  it("人类输入通道:cua type 打字 + press 键位 + 空白处 cua click 坐标点击", () => {
    expect(code).toContain("输入文字，回车发送");
    expect(code).toMatch(/command\("cua", \{ op: "type", text: text \}\)/);
    expect(code).toMatch(/command\("press", \{ key: k \}\)/);
    // Enter/Esc/Tab 三个键位按钮各自带 data-key(面板 JS 读它决定发哪个键)
    for (const k of ["Enter", "Escape", "Tab"]) {
      expect(code, k).toContain('setAttribute("data-key", "' + k + '")');
    }
    // 空白点击:未命中 ref 时按 hitTestAt 换算的页面坐标发 cua click
    expect(code).toContain("Math.round(hit.point.x)");
    expect(code).toMatch(/command\("cua", \{ op: "click", x: x, y: y \}\)/);
    expect(code).toContain("已点击页面坐标 (");
    expect(code).toContain("已发送输入（先点页面里输入框让它获得焦点）");
  });

  it("hitTestAt 无命中也返回换算坐标(point 字段),既有返回字段形状不变", () => {
    expect(code).toContain("var point = { x: x, y: y };");
    // 无命中:ref 置空 + 四元组归零,只靠 point 供点击用
    expect(code).toMatch(/return \{ ref: "", x: 0, y: 0, w: 0, h: 0, point: point \}/);
    expect(code).toContain("best.point = point;");
    // 早期「没有 hitRegions 就整体早退」必须去掉,否则人类 open 的页永远点不动
    expect(code).not.toMatch(/!el\.canvas \|\| !S\.hits\.length/);
  });

  it("tab 栏:refreshTabs 拉 tabs 回执、owner 徽标、chip 点击重订阅", () => {
    expect(code).toMatch(/action: "tabs", args: \{\}/);
    expect(code).toMatch(/applyTabsPayload\(msg\.tabs\)/);
    expect(code).toContain('"gbv-owner"');
    expect(code).toContain('return "[人]"');
    expect(code).toContain('return "[agent]"');
    // 订阅成功 / nav / load / close / open|newTab|close 回执都要重拉 tab 栏
    expect((code.match(/refreshTabs\(\)/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(code).toMatch(/action === "open" \|\| action === "newTab" \|\| action === "close"/);
    expect(code).toContain("sendOpen(id)"); // 点 chip = 重订阅该 tab
  });

  it("订阅失败一键启用:cfg.set browser.enabled 落盘 + 600ms 后重订阅", () => {
    expect(code).toContain("ENABLE_RESUBSCRIBE_MS = 600");
    expect(code).toMatch(/type: "cfg\.set", patch: \{ browser: \{ enabled: true \} \}/);
    expect(code).toContain("已开启浏览器控制，正在打开…");
    expect(code).toMatch(/if \(msg\.ok === false\) \{[\s\S]{0,120}S\.subFail = true;/);
    expect(code).toContain('makeButton("gbv-enable", "一键启用并打开"');
    expect(code).toMatch(/if \(el\.enable\) el\.enable\.style\.display = S\.subFail/);
  });

  it("人接管模式不整体只读:只 readOnly 地址栏,人类输入控件仍可用", () => {
    expect(code).toContain("el.urlInput.readOnly = !!S.humanMode");
    // 新增的人类交互控件不得被 disabled/readOnly 化
    expect(code).not.toMatch(/el\.(typeInput|typeBtn|keyEnter|keyEsc|keyTab)\.(disabled|readOnly)/);
    // 人工模式下仍放行人自己发起的操作(press / cua type / cua click),只拦 agent 侧动作
    expect(code).toMatch(/var humanOp =\s*action === "press" \|\|/);
    expect(code).toMatch(/\(action === "cua" && \(a\.op === "type" \|\| a\.op === "click"\)\)/);
  });

  it("getState 的 forward 用 canGoForward;state() 暴露 subFail/typeDraft", () => {
    expect(code).toContain("el.forward.disabled = !S.canGoForward");
    expect(code).toContain("subFail: S.subFail");
    expect(code).toContain("typeDraft: S.typeDraft");
  });
});

describe("内置浏览器视图资产:禁用形态", () => {
  it("零构建普通 script:无 import/export/<script/内联事件/eval", () => {
    expect(code).not.toMatch(/(^|[\s;{}])import\s/);
    expect(code).not.toMatch(/(^|[\s;{}])export\s/);
    expect(code.toLowerCase()).not.toContain("<script");
    expect(code.toLowerCase()).not.toContain("onclick=");
    expect(code).not.toContain("eval(");
    expect(code).toContain('"use strict"');
  });

  it("类名统一 gbv- 前缀(避免与 panel 现有 .browser/.page 撞样式)", () => {
    // DOM 自建处的类名:make("div", "<class>") / makeButton("<class>", ...);
    // CSS 里的选择器 ".gbv-xxx{...}" —— 两处都必须 gbv- 前缀。
    const fromDom = [
      ...code.matchAll(/make\(\s*"[a-z]+"\s*,\s*"([^"]+)"/g),
      ...code.matchAll(/makeButton\(\s*"([^"]+)"/g),
    ].flatMap((m) => m[1].split(/\s+/));
    expect(fromDom.length).toBeGreaterThan(20);
    for (const c of fromDom) expect(c.startsWith("gbv-"), c).toBe(true);

    // CSS 常量块(CSS = [ ... ].join("") )内的类选择器只允许 gbv-*:
    // 只切这一段,避免把 JS 里的属性访问(S.el.back / msg.seq)误当选择器。
    const cssStart = code.indexOf("var CSS = [");
    const cssEnd = code.indexOf('].join("")', cssStart);
    expect(cssStart).toBeGreaterThan(0);
    expect(cssEnd).toBeGreaterThan(cssStart);
    const css = code.slice(cssStart, cssEnd);
    const cssClasses = [...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]);
    expect(cssClasses.length).toBeGreaterThan(20);
    // `.on` 是任务书规定的选中态修饰类,但必须始终挂在 .gbv-* 选择器后面(不允许裸 `.on{...}`)
    const offenders = cssClasses.filter((c) => !c.startsWith("gbv-") && c !== "on");
    expect(offenders).toEqual([]);
    expect(cssClasses.filter((c) => c === "on").length).toBeGreaterThan(0);
    expect(css).not.toMatch(/["\s,>]\.on\b/);
  });
});
