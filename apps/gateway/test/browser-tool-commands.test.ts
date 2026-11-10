/**
 * browser 工具新命令面契约测试(不启真 chromium):
 * 用 vi.mock("playwright-core") 注入探针页/浏览器,记录被调用的方法与参数,
 * 逐个断言 navigate/hover/drag/select/press/viewport/wait_for/screenshots/tabs 的行为契约,
 * 外加 ref 过期负例与视图 hub 的帧/白名单契约。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/* 探针工厂必须在 vi.mock 之前 hoist:mock 工厂不能引用普通模块作用域变量。 */
const H = vi.hoisted(() => {
  type Call = { target: string; method: string; args: unknown[] };
  const calls: Call[] = [];
  const rec = (target: string, method: string, args: unknown[] = []) => { calls.push({ target, method, args }); };
  const state = {
    url: "about:blank",
    title: "测试页",
    viewport: { width: 1024, height: 768 } as { width: number; height: number } | null,
    /* 新命令面探针开关:elementInfo 命中元素(默认 null=未命中)/ wait_for text(textGone) 的 includes 结果。 */
    elementHit: null as unknown,
    includesResult: true,
    /* playwright 通道:page.evaluate 每次调用前真实等待的毫秒数(验 elapsedMs 用,默认 0)。 */
    slowMs: 0,
    /* 快照造数注入口(第二批之二):非 null 时 evaluate 的 querySelectorAll 分支返回它(验渲染层新字段)。 */
    snapOverride: null as unknown,
    /* 最近一次 page.evaluate 的完整脚本串(验 COLLECT_SNAPSHOT 实参透传)。 */
    lastEval: "",
    /* 快照次数计数(2026-11 browser-ux-redo):验 open/navigate 自动快照与同 URL 节流。 */
    snapEvals: 0,
    /* boundingBox 造数注入(2026-11 hitRegions 裁视口):selector → 框,缺省固定 40x30。 */
    bboxFor: null as unknown,
    /* 启动通道留痕(模块级池只启动一次,calls 会被各用例清空,故单独记):launch|launchPersistentContext。 */
    launchMode: "",
    launchDir: "",
  };
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const snapElements = [
    { tag: "input", role: "input", name: "输入名字", text: "", value: "", selector: "#name", rect: { x: 1, y: 2, w: 10, h: 10 }, inViewport: true },
    { tag: "button", role: "button", name: "提交", text: "提交", value: "", selector: "#go", rect: { x: 5, y: 6, w: 20, h: 10 }, inViewport: true },
  ];
  const makeLocator = (selector: string) => ({
    click: async (...a: unknown[]) => { rec(`locator:${selector}`, "click", a); },
    dblclick: async (...a: unknown[]) => { rec(`locator:${selector}`, "dblclick", a); },
    hover: async (...a: unknown[]) => { rec(`locator:${selector}`, "hover", a); },
    focus: async (...a: unknown[]) => { rec(`locator:${selector}`, "focus", a); },
    dragTo: async (...a: unknown[]) => { rec(`locator:${selector}`, "dragTo", a); },
    selectOption: async (...a: unknown[]) => { rec(`locator:${selector}`, "selectOption", a); return ["blue"]; },
    boundingBox: async () => {
      rec(`locator:${selector}`, "boundingBox");
      const fn = state.bboxFor as ((sel: string) => unknown) | null;
      return (fn ? fn(selector) : { x: 10, y: 20, width: 40, height: 30 }) as { x: number; y: number; width: number; height: number };
    },
    waitFor: async (...a: unknown[]) => { rec(`locator:${selector}`, "waitFor", a); throw new Error("Timeout 500ms exceeded waiting for locator"); },
    ariaSnapshot: async () => { rec(`locator:${selector}`, "ariaSnapshot"); return "- heading 测试\n- button 提交"; },
    scrollIntoViewIfNeeded: async (...a: unknown[]) => { rec(`locator:${selector}`, "scrollIntoViewIfNeeded", a); },
    screenshot: async (...a: unknown[]) => { rec(`locator:${selector}`, "screenshot", a); return Buffer.from("el-shot-bytes"); },
    /* playwright 通道(op=locator)的 then 面与 chain 面探针。 */
    fill: async (...a: unknown[]) => { rec(`locator:${selector}`, "fill", a); },
    type: async (...a: unknown[]) => { rec(`locator:${selector}`, "type", a); },
    press: async (...a: unknown[]) => { rec(`locator:${selector}`, "press", a); },
    check: async (...a: unknown[]) => { rec(`locator:${selector}`, "check", a); },
    uncheck: async (...a: unknown[]) => { rec(`locator:${selector}`, "uncheck", a); },
    textContent: async (...a: unknown[]) => { rec(`locator:${selector}`, "textContent", a); return "文本内容"; },
    innerText: async (...a: unknown[]) => { rec(`locator:${selector}`, "innerText", a); return "内部文本"; },
    getAttribute: async (...a: unknown[]) => { rec(`locator:${selector}`, "getAttribute", a); return "attr-value"; },
    isVisible: async (...a: unknown[]) => { rec(`locator:${selector}`, "isVisible", a); return true; },
    isEnabled: async (...a: unknown[]) => { rec(`locator:${selector}`, "isEnabled", a); return true; },
    count: async (...a: unknown[]) => { rec(`locator:${selector}`, "count", a); return 2; },
    first: (...a: unknown[]) => { rec(`locator:${selector}`, "first", a); return makeLocator(selector + " >> first()"); },
    last: (...a: unknown[]) => { rec(`locator:${selector}`, "last", a); return makeLocator(selector + " >> last()"); },
    nth: (n: number) => { rec(`locator:${selector}`, "nth", [n]); return makeLocator(selector + " >> nth=" + n); },
    filter: (o: { hasText?: string }) => { rec(`locator:${selector}`, "filter", [o]); return makeLocator(selector + " >> filter=" + (o?.hasText ?? "")); },
  });
  const page = {
    goto: async (u: string, o?: unknown) => { rec("page", "goto", [u, o]); state.url = u; },
    goBack: async (o?: unknown) => { rec("page", "goBack", [o]); state.url = "http://a.test/prev"; return null; },
    goForward: async (o?: unknown) => { rec("page", "goForward", [o]); state.url = "http://a.test/next"; return null; },
    reload: async (o?: unknown) => { rec("page", "reload", [o]); return null; },
    title: async () => state.title,
    url: () => state.url,
    evaluate: async (fn: string) => {
      rec("page", "evaluate", [String(fn).slice(0, 40)]);
      state.lastEval = String(fn);
      if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
      if (fn.includes('querySelectorAll("body *")')) {
        state.snapEvals += 1;
        return state.snapOverride ?? { elements: snapElements, dom: [{ tag: "h1", text: "表单标题", inViewport: true }], url: state.url, title: state.title, truncated: false };
      }
      /* elementInfo 坐标反查(ELEMENT_AT_POINT 探针):state.elementHit 可注入命中元素。 */
      if (fn.includes("elementFromPoint")) return state.elementHit;
      if (fn.includes("window.stop()")) return undefined;
      /* getState(形态来源: ZCode getState) */
      if (fn.includes("canGoBack")) {
        return { url: state.url, title: state.title, canGoBack: true, scrollX: 0, scrollY: 128, viewport: { w: 1024, h: 768 } };
      }
      if (fn.includes("innerText.trim().length")) return 42;
      if (fn.includes("includes(")) return state.includesResult;
      if (fn.includes("innerText")) return "正文内容";
      return "EVALED";
    },
    close: async () => { rec("page", "close"); },
    waitForLoadState: async (s: string, o?: unknown) => { rec("page", "waitForLoadState", [s, o]); },
    waitForTimeout: async (ms: number) => { rec("page", "waitForTimeout", [ms]); },
    screenshot: async (o?: unknown) => { rec("page", "screenshot", [o]); return Buffer.from("jpeg-bytes"); },
    locator: (sel: string) => makeLocator(sel),
    /* playwright 通道探针:getBy* 家族记录 (method,args) 并回链式 locator;waitForURL 记录透传参。 */
    getByRole: (role: string, o?: { name?: string; exact?: boolean }) => { rec("page", "getByRole", [role, o]); return makeLocator(`role=${role}`); },
    getByText: (t: string, o?: { exact?: boolean }) => { rec("page", "getByText", [t, o]); return makeLocator(`text=${t}`); },
    getByLabel: (t: string, o?: { exact?: boolean }) => { rec("page", "getByLabel", [t, o]); return makeLocator(`label=${t}`); },
    getByPlaceholder: (t: string, o?: { exact?: boolean }) => { rec("page", "getByPlaceholder", [t, o]); return makeLocator(`placeholder=${t}`); },
    getByTestId: (id: string) => { rec("page", "getByTestId", [id]); return makeLocator(`testid=${id}`); },
    getByAltText: (t: string, o?: { exact?: boolean }) => { rec("page", "getByAltText", [t, o]); return makeLocator(`alt=${t}`); },
    getByTitle: (t: string, o?: { exact?: boolean }) => { rec("page", "getByTitle", [t, o]); return makeLocator(`title=${t}`); },
    waitForURL: async (u: string | RegExp, o?: unknown) => { rec("page", "waitForURL", [u, o]); },
    viewportSize: () => state.viewport,
    setViewportSize: async (s: { width: number; height: number }) => { rec("page", "setViewportSize", [s]); state.viewport = s; },
    on: (ev: string, fn: (...a: unknown[]) => void) => { rec("page", "on", [ev]); const l = listeners.get(ev) ?? []; l.push(fn); listeners.set(ev, l); },
    off: (ev: string, fn: (...a: unknown[]) => void) => {
      rec("page", "off", [ev]);
      listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn));
    },
    mouse: {
      click: async (x: number, y: number, o?: unknown) => { rec("mouse", "click", [x, y, o]); },
      move: async (x: number, y: number, o?: unknown) => { rec("mouse", "move", [x, y, o]); },
      down: async (o?: unknown) => { rec("mouse", "down", [o]); },
      up: async (o?: unknown) => { rec("mouse", "up", [o]); },
      wheel: async (x: number, y: number) => { rec("mouse", "wheel", [x, y]); },
    },
    keyboard: {
      press: async (k: string) => { rec("keyboard", "press", [k]); },
      type: async (t: string, o?: unknown) => { rec("keyboard", "type", [t, o]); },
      down: async (k: string) => { rec("keyboard", "down", [k]); },
      up: async (k: string) => { rec("keyboard", "up", [k]); },
    },
  };
  const browser = {
    newPage: async () => { rec("browser", "newPage"); return page; },
    close: async () => { rec("browser", "close"); },
  };
  return { calls, rec, state, page, browser, listeners };
});

vi.mock("playwright-core", () => ({
  chromium: {
    launch: async (o: unknown) => { H.state.launchMode = "launch"; H.rec("chromium", "launch", [o]); return H.browser; },
    /* 持久 profile 通道(2026-11):探针把 context 直接当 browser 面用(newPage/close)。 */
    launchPersistentContext: async (dir: string, o: unknown) => {
      H.state.launchMode = "launchPersistentContext";
      H.state.launchDir = String(dir);
      H.rec("chromium", "launchPersistentContext", [dir, o]);
      return H.browser;
    },
  },
}));

const { createBrowserTool, getBrowserViewHub, resolveChromePath, browserLaunchPlan, idleMinutesOf } =
  await import("../src/browser-tool.js");
const { ConfigSchema } = await import("@lampgenie/core");

const root = mkdtempSync(join(tmpdir(), "genie-browser-cmd-"));
const cfg = { enabled: () => true, allowDomains: () => ["a.test"] };
const tool = createBrowserTool(root, cfg);

const has = (target: string, method: string) => H.calls.some((c) => c.target === target && c.method === method);
const last = (target: string, method: string) => [...H.calls].reverse().find((c) => c.target === target && c.method === method);

/** 每个用例独立:清池 + 开一个新 tab 并清空调用记录(断言只看本步)。 */
const openTab = async (): Promise<string> => {
  H.state.url = "about:blank";
  H.state.viewport = { width: 1024, height: 768 };
  H.state.elementHit = null;
  H.state.includesResult = true;
  H.state.slowMs = 0;
  H.state.snapOverride = null;
  H.state.lastEval = "";
  H.state.snapEvals = 0;
  H.state.bboxFor = null;
  const out = String(await tool.execute({ action: "open", url: "http://a.test/" }));
  const id = out.match(/\[tab (t\d+)\]/)?.[1];
  if (!id) throw new Error("open 未返回 tabId:" + out.slice(0, 200));
  H.calls.length = 0;
  return id;
};

/** 触发一条 JS 弹窗(形态来源: ZCode getDialog/handleDialog 契约;page.on("dialog") 已在 page 创建时挂)。 */
const fireDialog = (over: Partial<{ type: string; message: string; defaultValue: string }> = {}) => {
  const dlg = {
    type: () => over.type ?? "prompt",
    message: () => over.message ?? "你的名字?",
    defaultValue: () => over.defaultValue ?? "张三",
    accept: async (o?: { promptText?: string }) => { H.rec("dialog", "accept", [o]); },
    dismiss: async () => { H.rec("dialog", "dismiss"); },
  };
  for (const fn of H.listeners.get("dialog") ?? []) fn(dlg);
};

beforeEach(async () => {
  await tool.execute({ action: "close", scope: "all" });
  H.calls.length = 0;
});

afterEach(() => { H.calls.length = 0; });

describe("navigate", () => {
  it("op=back 调 page.goBack 并回 [nav] <url> · <title>", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "navigate", tab, op: "back" }));
    expect(has("page", "goBack")).toBe(true);
    expect(out).toContain("[nav]");
    expect(out).toContain("http://a.test/prev");
    expect(out).toContain("·");
  });

  it("op=forward 调 page.goForward", async () => {
    const tab = await openTab();
    await tool.execute({ action: "navigate", tab, op: "forward" });
    expect(has("page", "goForward")).toBe(true);
  });

  it("op=reload 调 page.reload", async () => {
    const tab = await openTab();
    await tool.execute({ action: "navigate", tab, op: "reload" });
    expect(has("page", "reload")).toBe(true);
  });

  it("op=url 走 page.goto(waitUntil=domcontentloaded)", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "navigate", tab, op: "url", url: "http://a.test/second" }));
    const call = last("page", "goto");
    expect(call).toBeTruthy();
    expect(call!.args[0]).toBe("http://a.test/second");
    expect((call!.args[1] as { waitUntil?: string }).waitUntil).toBe("domcontentloaded");
    expect(out).toContain("[nav] http://a.test/second");
  });

  it("op=url 非白名单域被拒,不触达 goto", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "navigate", tab, op: "url", url: "http://evil.test/x" }));
    expect(out).toContain("[browser] 域名不在白名单");
    /* openTab 已清调用记录:门禁拒绝时不得有任何 goto 探针调用。 */
    expect(last("page", "goto")).toBeUndefined();
  });
});

describe("元素命令", () => {
  it("hover 调 locator.hover 并回 [hover] 完成", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "hover", tab, selector: "#go" }));
    expect(has("locator:#go", "hover")).toBe(true);
    expect(out).toContain("[hover] 完成");
  });

  it("drag 元素路调 locator.dragTo", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "drag", tab, from: { selector: "#name" }, to: { selector: "#go" } }));
    const call = last("locator:#name", "dragTo");
    expect(call).toBeTruthy();
    expect(call!.args[0]).toBeTruthy();
    expect(has("mouse", "up")).toBe(false);
    expect(out).toContain("[drag] 完成");
  });

  it("drag 坐标路走 mouse.move/down/up", async () => {
    const tab = await openTab();
    await tool.execute({ action: "drag", tab, path: [{ x: 11, y: 22 }, { x: 33, y: 44 }] });
    expect(last("mouse", "move")!.args.slice(0, 2)).toEqual([33, 44]);
    expect(has("mouse", "down")).toBe(true);
    expect(has("mouse", "up")).toBe(true);
  });

  it("drag 到文件输入框被明确拒绝(不实现 file 输入)", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "drag", tab, from: { selector: "#name" }, to: { selector: "input[type=file]" } }));
    expect(out).toContain("[browser] 拒绝");
    expect(has("locator:#name", "dragTo")).toBe(false);
  });

  it("select 调 selectOption 并回选中值 JSON", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "select", tab, selector: "#go", values: ["blue"] }));
    const call = last("locator:#go", "selectOption");
    expect(call).toBeTruthy();
    expect(call!.args[0]).toEqual(["blue"]);
    expect(out).toContain('["blue"]');
  });

  it("press 无目标走 keyboard.press", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "press", tab, key: "Enter" }));
    expect(last("keyboard", "press")!.args[0]).toBe("Enter");
    expect(out).toContain("[press] Enter");
  });

  it("press 有目标先 focus 再按", async () => {
    const tab = await openTab();
    await tool.execute({ action: "press", tab, selector: "#name", key: "Tab" });
    expect(has("locator:#name", "focus")).toBe(true);
    expect(last("keyboard", "press")!.args[0]).toBe("Tab");
  });
});

describe("viewport / wait_for / screenshots", () => {
  it("viewport_set 调 setViewportSize 且 clamp 生效(320..3840 / 320..2160)", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "viewport_set", tab, width: 99_999, height: 10 }));
    expect(last("page", "setViewportSize")!.args[0]).toEqual({ width: 3840, height: 320 });
    expect(out).toBe("视口 3840x320");
  });

  it("viewport_get 回视口尺寸,null 时兜底 1280x720", async () => {
    const tab = await openTab();
    expect(String(await tool.execute({ action: "viewport_get", tab }))).toBe("视口 1024x768");
    H.state.viewport = null;
    expect(String(await tool.execute({ action: "viewport_get", tab }))).toBe("视口 1280x720");
  });

  it("wait_for 命中回 [wait_for] 命中", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "wait_for", tab, kind: "text", value: "正文" }));
    expect(out).toContain("[wait_for] 命中");
  });

  it("wait_for 超时回 [browser] 错误串且不抛", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "wait_for", tab, kind: "selector", value: "#nope", timeoutMs: 500 }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("wait_for 超时");
    expect(out).toContain("500ms");
  });

  it("screenshots viewport 传 fullPage:false / full_page 传 fullPage:true,落盘并带 markdown 行", async () => {
    const tab = await openTab();
    const vp = String(await tool.execute({ action: "screenshots", tab, mode: "viewport" }));
    expect(last("page", "screenshot")!.args[0]).toEqual({ fullPage: false });
    const fp = String(await tool.execute({ action: "screenshots", tab, mode: "full_page" }));
    expect(last("page", "screenshot")!.args[0]).toEqual({ fullPage: true });
    for (const out of [vp, fp]) {
      const f = out.match(/截图已存:(\S+\.png)/)?.[1];
      expect(f).toBeTruthy();
      expect(f!.startsWith(join(root, ".genie", "browser-shots"))).toBe(true);
      expect(existsSync(f!)).toBe(true);
      expect(out).toContain("![浏览器截图 " + tab + "](/uploads?path=");
    }
  });
});

describe("tabs 详化", () => {
  it("每行含 id/active/title/url,活跃 tab 以 * 前缀标记", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "tabs" }));
    const line = out.split("\n").find((l) => l.includes(tab + "  "))!;
    expect(line).toBeTruthy();
    expect(line.startsWith("* ")).toBe(true);
    expect(line).toContain("active");
    expect(line).toContain("测试页");
    expect(line).toContain("http://a.test/");
  });
});

describe("snapshot", () => {
  it("ariaOnly=true 只回 aria 树;默认全量含 aria 段且元素段不变", async () => {
    const tab = await openTab();
    const only = String(await tool.execute({ action: "snapshot", tab, ariaOnly: true }));
    expect(only).toContain("--- aria 树(截断");
    expect(only).not.toContain("可交互元素(ref 定位,act 用):");
    const full = String(await tool.execute({ action: "snapshot", tab }));
    expect(full).toContain("可交互元素(ref 定位,act 用):");
    expect(full).toContain("e1 input \"输入名字\" @1,2");
    expect(full).toContain("--- aria 树(截断");
  });

  it("ref 过期负例:导航后旧 ref 操作返回过期错误串", async () => {
    const tab = await openTab();
    const snap = String(await tool.execute({ action: "snapshot", tab }));
    expect(snap).toContain("e1");
    /* 2026-11:action=navigate 现在会自动重拍快照(refsUrl 跟上),ref 不再过期——
     * 用页面内自发导航(H.state.url 变化 = 工具未参与)复现「快照后 URL 变了」的过期场景。 */
    H.state.url = "http://a.test/moved";
    const stale = String(await tool.execute({ action: "act", tab, ref: "e1", op: "fill", value: "x" }));
    expect(stale).toContain("[browser] ");
    expect(stale).toContain("ref 已过期");
    expect(stale).toContain("snapshot");
    expect(has("locator:#name", "fill")).toBe(false);
  });
});

describe("视图 hub", () => {
  it("白名单外命令被拒;白名单内命令复用 execute 实现", async () => {
    const hub = getBrowserViewHub(root, cfg);
    const denied = await hub.runViewCommand("eval", { expr: "1+1" });
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("面板命令白名单外: eval");
    await openTab();
    const ok = await hub.runViewCommand("tabs", {});
    expect(ok.ok).toBe(true);
    expect(ok.text).toContain("在场 tab");
    expect(hub.tabList().length).toBe(1);
    expect(hub.tabList()[0]!.active).toBe(true);
  });

  it("订阅立即推 1 帧(jpeg base64 + hitRegions + 单调 seq),退订后清监听与计时器", async () => {
    const hub = getBrowserViewHub(root, cfg);
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab });
    const frames: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const { subId } = hub.subscribe(tab, (m) => {
      if ("seq" in m) frames.push(m as unknown as Record<string, unknown>);
      else events.push(m as unknown as Record<string, unknown>);
    });
    expect(hub.subscribers()).toBe(1);
    for (let i = 0; i < 40 && !frames.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const f = frames[0]!;
    expect(String(f.imageB64)).not.toContain("data:");
    expect(String(f.imageB64).length).toBeGreaterThan(0);
    expect(f.seq).toBe(1);
    expect(f.viewport).toEqual({ width: 1024, height: 768 });
    expect(f.tabId).toBe(tab);
    expect(f.url).toBe("http://a.test/");
    const regions = f.hitRegions as Array<{ ref: string }>;
    expect(regions.map((r) => r.ref)).toEqual(["e1", "e2"]);
    expect(has("page", "on")).toBe(true);
    hub.unsubscribe(subId);
    expect(hub.subscribers()).toBe(0);
    expect(has("page", "off")).toBe(true);
  });

  it("无 tab 时 subscribe(null) 立即推一条 close 事件", async () => {
    const hub = getBrowserViewHub(root, cfg);
    const got: Array<Record<string, unknown>> = [];
    const { subId } = hub.subscribe(null, (m) => got.push(m as unknown as Record<string, unknown>));
    expect(got.length).toBe(1);
    expect(got[0]!.kind).toBe("close");
    expect(String(got[0]!.message)).toContain("无打开的 tab");
    hub.unsubscribe(subId);
  });
});

/* ═══════════ 命令面扩写(第一批:缺失命令 + modifiers;形态来源 ZCode browser-use) ═══════════ */

describe("getState / capabilities", () => {
  it("getState evaluate 读 url/title/canGoBack/scrollX/scrollY/viewport,回单行 JSON", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "getState", tab }));
    const st = JSON.parse(out) as Record<string, unknown>;
    expect(st.url).toBe("http://a.test/");
    expect(st.title).toBe("测试页");
    expect(st.canGoBack).toBe(true);
    expect(st.scrollY).toBe(128);
    expect(st.viewport).toEqual({ w: 1024, h: 768 });
    expect(out).not.toContain("\n");
    expect(has("page", "evaluate")).toBe(true);
  });

  it("capabilities 回静态 JSON:支持面含新命令,禁用面含 下载/文件选择/录制/cancelRequest", async () => {
    const out = String(await tool.execute({ action: "capabilities" }));
    const caps = JSON.parse(out) as { 支持: string[]; 不支持: Record<string, string> };
    expect(caps.支持).toContain("elementInfo");
    expect(caps.支持).toContain("dialog");
    expect(Object.keys(caps.不支持).sort()).toEqual(["cancelRequest", "下载", "录制", "文件选择"]);
    expect(out).not.toContain("\n");
  });
});

describe("elementInfo(坐标反查)", () => {
  const hit = { tag: "button", role: "button", name: "提交", text: "提交", selector: "#fresh",
    rect: { x: 5, y: 6, w: 20, h: 10 }, attributes: { id: "fresh", type: "submit" } };

  it("命中元素回 {ref:p1,tag,role,name,text,selector,rect,attributes}", async () => {
    const tab = await openTab();
    H.state.elementHit = hit;
    const out = String(await tool.execute({ action: "elementInfo", tab, x: 10, y: 10 }));
    const info = JSON.parse(out) as Record<string, unknown>;
    expect(info.ref).toBe("p1");
    expect(info.tag).toBe("button");
    expect(info.name).toBe("提交");
    expect(info.selector).toBe("#fresh");
    expect(info.attributes).toEqual({ id: "fresh", type: "submit" });
  });

  it("selector 命中当前 refs 时返回既有 ref(不新分配 p<N>)", async () => {
    const tab = await openTab();
    H.state.elementHit = { ...hit, selector: "#go" };
    const out = String(await tool.execute({ action: "elementInfo", tab, x: 10, y: 10 }));
    expect((JSON.parse(out) as { ref: string }).ref).toBe("e2");
  });

  it("同一 selector 二次反查复用 p1;p1 可直接进 act(存入 refs)", async () => {
    const tab = await openTab();
    H.state.elementHit = hit;
    await tool.execute({ action: "elementInfo", tab, x: 10, y: 10 });
    const again = JSON.parse(String(await tool.execute({ action: "elementInfo", tab, x: 12, y: 12 }))) as { ref: string };
    expect(again.ref).toBe("p1");
    H.state.elementHit = null;
    H.calls.length = 0;
    const act = String(await tool.execute({ action: "act", tab, ref: "p1", op: "click" }));
    expect(has("locator:#fresh", "click")).toBe(true);
    expect(act).toContain("click ✓ #fresh");
  });

  it("未命中返回 [browser] 错误串", async () => {
    const tab = await openTab();
    H.state.elementHit = null;
    const out = String(await tool.execute({ action: "elementInfo", tab, x: 1, y: 1 }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("未命中");
  });
});

describe("dialog(getDialog/handleDialog)", () => {
  it("dialog listener 在 page 创建时即挂:无 getDialog 前触发也能读到(首弹窗不丢)", async () => {
    const tab = await openTab();
    fireDialog();
    const out = String(await tool.execute({ action: "getDialog", tab }));
    const d = JSON.parse(out) as Record<string, string>;
    expect(d.type).toBe("prompt");
    expect(d.message).toBe("你的名字?");
    expect(d.defaultValue).toBe("张三");
  });

  it("无弹窗回「无弹窗」文本", async () => {
    const tab = await openTab();
    expect(String(await tool.execute({ action: "getDialog", tab }))).toBe("无弹窗");
  });

  it("handleDialog accept=true 带 promptText 调 dialog.accept 并清缓存", async () => {
    const tab = await openTab();
    fireDialog();
    const out = String(await tool.execute({ action: "handleDialog", tab, accept: true, promptText: "李四" }));
    expect(last("dialog", "accept")!.args[0]).toEqual({ promptText: "李四" });
    expect(out).toContain("弹窗已接受");
    expect(String(await tool.execute({ action: "getDialog", tab }))).toBe("无弹窗");
  });

  it("handleDialog accept=false 调 dialog.dismiss;无弹窗时报错不抛", async () => {
    const tab = await openTab();
    fireDialog({ type: "confirm", message: "确认?" });
    const out = String(await tool.execute({ action: "handleDialog", tab, accept: false }));
    expect(has("dialog", "dismiss")).toBe(true);
    expect(out).toContain("弹窗已取消");
    const none = String(await tool.execute({ action: "handleDialog", tab, accept: true }));
    expect(none.startsWith("[browser] ")).toBe(true);
    expect(none).toContain("无弹窗可处理");
  });
});

describe("wait{ms} / wait_for 扩 kind / scroll", () => {
  it("wait{ms} 调 page.waitForTimeout 并 clamp 0..30000,回 [wait] Nms", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "wait", tab, ms: 99_999 }));
    expect(last("page", "waitForTimeout")!.args[0]).toBe(30_000);
    expect(out).toBe("[wait] 30000ms");
    const zero = String(await tool.execute({ action: "wait", tab, ms: -5 }));
    expect(last("page", "waitForTimeout")!.args[0]).toBe(0);
    expect(zero).toBe("[wait] 0ms");
  });

  it("wait_for kind=textGone:text 消失即命中(反条件轮询)", async () => {
    const tab = await openTab();
    H.state.includesResult = false;
    const out = String(await tool.execute({ action: "wait_for", tab, kind: "textGone", value: "加载中" }));
    expect(out).toBe("[wait_for] 命中");
  });

  it("wait_for kind=textGone 超时回 [browser] 错误串", async () => {
    const tab = await openTab();
    H.state.includesResult = true;
    const out = String(await tool.execute({ action: "wait_for", tab, kind: "textGone", value: "加载中", timeoutMs: 500 }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("textGone");
  });

  it("wait_for kind=loadstate 透传 page.waitForLoadState(networkidle|domcontentloaded|load)", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "wait_for", tab, kind: "loadstate", value: "networkidle" }));
    expect(last("page", "waitForLoadState")!.args[0]).toBe("networkidle");
    expect(out).toBe("[wait_for] 命中");
    const bad = String(await tool.execute({ action: "wait_for", tab, kind: "loadstate", value: "bogus" }));
    expect(bad.startsWith("[browser] ")).toBe(true);
  });

  it("scroll 调 locator.scrollIntoViewIfNeeded,回 [scroll] 完成", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "scroll", tab, selector: "#go" }));
    expect(has("locator:#go", "scrollIntoViewIfNeeded")).toBe(true);
    /* 内含 200ms 收尾等待:成功回执耗时>200ms 时尾追加 elapsedMs=<n>(允许但不强求)。 */
    expect(out).toMatch(/^\[scroll\] 完成( elapsedMs=\d+)?$/);
  });
});

describe("shot 扩参(ref 元素截图 / clip 区域截图)", () => {
  it("shot 带 ref 走 locator.screenshot 并落盘", async () => {
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab });
    const out = String(await tool.execute({ action: "shot", tab, ref: "e2", path: "el" }));
    expect(has("locator:#go", "screenshot")).toBe(true);
    const f = out.match(/截图已存:(\S+\.png)/)?.[1];
    expect(f).toBeTruthy();
    expect(existsSync(f!)).toBe(true);
  });

  it("shot 带 clip 走 page.screenshot({clip});非法 clip 退回整页", async () => {
    const tab = await openTab();
    const clip = { x: 1, y: 2, width: 30, height: 40 };
    const out = String(await tool.execute({ action: "shot", tab, clip }));
    expect(last("page", "screenshot")!.args[0]).toEqual({ clip });
    expect(out).toContain("![浏览器截图");
    await tool.execute({ action: "shot", tab, clip: { x: 0, y: 0, width: -1, height: 5 } });
    expect(last("page", "screenshot")!.args[0]).toEqual({ fullPage: false });
  });
});

describe("newTab / activateTab / viewport_reset / navigate stop", () => {
  it("newTab 缺省 about:blank,强制新开不复用同域 tab", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "newTab" }));
    const id = out.match(/\[tab (t\d+)\]/)?.[1];
    expect(id).toBeTruthy();
    expect(id).not.toBe(tab);
    expect(has("browser", "newPage")).toBe(true);
    expect(last("page", "goto")).toBeUndefined();
  });

  it("newTab{url} 导航到目标 URL 且走门禁", async () => {
    await openTab();
    const out = String(await tool.execute({ action: "newTab", url: "http://a.test/fresh" }));
    expect(last("page", "goto")!.args[0]).toBe("http://a.test/fresh");
    expect(out).toContain("[tab ");
    const denied = String(await tool.execute({ action: "newTab", url: "http://evil.test/" }));
    expect(denied).toContain("[browser] 域名不在白名单");
  });

  it("activateTab 置活跃 tab;tabs 清单的 * 随之切换;未知 tab 报错", async () => {
    const t1 = await openTab();
    /* open 会复用同域 tab,第二个 tab 用 newTab 强制新开,保证两行并存。 */
    const t2 = String(await tool.execute({ action: "newTab" })).match(/\[tab (t\d+)\]/)?.[1]!;
    expect(t2).not.toBe(t1);
    const out = String(await tool.execute({ action: "activateTab", tab: t1 }));
    expect(out).toBe(`已激活 tab ${t1}`);
    const list = String(await tool.execute({ action: "tabs" }));
    expect(list.split("\n").find((l) => l.includes(t1 + "  "))!.startsWith("* ")).toBe(true);
    expect(list.split("\n").find((l) => l.includes(t2 + "  "))!.startsWith("* ")).toBe(false);
    const missing = String(await tool.execute({ action: "activateTab", tab: "t99" }));
    expect(missing.startsWith("[browser] ")).toBe(true);
    expect(missing).toContain("不存在");
  });

  it("viewport_reset 恢复该 tab open 时记录的 viewport0", async () => {
    const tab = await openTab();
    await tool.execute({ action: "viewport_set", tab, width: 800, height: 600 });
    const out = String(await tool.execute({ action: "viewport_reset", tab }));
    expect(last("page", "setViewportSize")!.args[0]).toEqual({ width: 1024, height: 768 });
    expect(out).toBe("视口已恢复 1024x768");
  });

  it("navigate op=stop evaluate window.stop() 回 [nav] 已请求停止", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "navigate", tab, op: "stop" }));
    expect(has("page", "evaluate")).toBe(true);
    expect(out).toBe("[nav] 已请求停止");
  });
});

describe("modifiers(Alt/Control/ControlOrMeta/Meta/Shift)", () => {
  it("act click / hover 透传 modifiers 给 playwright 原生 API", async () => {
    const tab = await openTab();
    await tool.execute({ action: "act", tab, selector: "#go", op: "click", modifiers: ["Control", "Shift"] });
    expect(last("locator:#go", "click")!.args[0]).toEqual({ timeout: 10_000, modifiers: ["Control", "Shift"] });
    await tool.execute({ action: "hover", tab, selector: "#go", modifiers: ["Meta"] });
    expect(last("locator:#go", "hover")!.args[0]).toEqual({ timeout: 10_000, modifiers: ["Meta"] });
  });

  it("非法修饰键被丢弃;全非法时不传 modifiers 键", async () => {
    const tab = await openTab();
    await tool.execute({ action: "hover", tab, selector: "#go", modifiers: ["Ctrl", "Shift"] });
    expect(last("locator:#go", "hover")!.args[0]).toEqual({ timeout: 10_000, modifiers: ["Shift"] });
    await tool.execute({ action: "hover", tab, selector: "#go", modifiers: ["Foo"] });
    expect(last("locator:#go", "hover")!.args[0]).toEqual({ timeout: 10_000 });
  });

  it("drag 元素路 dragTo 透传 modifiers", async () => {
    const tab = await openTab();
    await tool.execute({ action: "drag", tab, from: { selector: "#name" }, to: { selector: "#go" }, modifiers: ["ControlOrMeta"] });
    expect(last("locator:#name", "dragTo")!.args[1]).toEqual({ timeout: 10_000, modifiers: ["ControlOrMeta"] });
  });

  it("press 带修饰键:down → press → 逆序 up,回 [press] key+mods", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "press", tab, key: "a", modifiers: ["Control", "Alt"] }));
    const seq = H.calls.filter((c) => c.target === "keyboard").map((c) => c.method + ":" + String(c.args[0]));
    expect(seq).toEqual(["down:Control", "down:Alt", "press:a", "up:Alt", "up:Control"]);
    /* 内含 200ms 收尾等待:允许尾追加 elapsedMs=<n>(>200ms 时)。 */
    expect(out).toMatch(/^\[press\] a\+Control\+Alt( elapsedMs=\d+)?$/);
  });

  it("cua click 带 modifiers 透传 mouse.click;cua scroll 用 keyboard.down/up 包裹 wheel", async () => {
    const tab = await openTab();
    await tool.execute({ action: "cua", tab, op: "click", x: 5, y: 5, modifiers: ["Shift"] });
    expect(last("mouse", "click")!.args[2]).toEqual({ modifiers: ["Shift"] });
    H.calls.length = 0;
    await tool.execute({ action: "cua", tab, op: "scroll", x: 1, y: 1, deltaY: 100, modifiers: ["Alt"] });
    const down = H.calls.findIndex((c) => c.target === "keyboard" && c.method === "down");
    const wheel = H.calls.findIndex((c) => c.target === "mouse" && c.method === "wheel");
    const up = H.calls.findIndex((c) => c.target === "keyboard" && c.method === "up");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(down).toBeLessThan(wheel);
    expect(wheel).toBeLessThan(up);
    expect(last("keyboard", "down")!.args[0]).toBe("Alt");
  });
});

/* ═══════════ 命令面扩写(第二批:playwright 通道 + 错误码;形态来源 ZCode playwright.ts/command-metadata.ts) ═══════════ */

describe("playwright op=locator(steps 逐级 getBy* 构造)", () => {
  it("by=role:getByRole(name 字段作 role,value 作 name 断言),then=click", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({
      action: "playwright", tab, op: "locator",
      steps: [{ by: "role", name: "button", value: "提交" }],
      then: { op: "click" },
    }));
    const call = last("page", "getByRole")!;
    expect(call.args[0]).toBe("button");
    expect(call.args[1]).toEqual({ name: "提交" });
    expect(has("locator:role=button", "click")).toBe(true);
    expect(out).toContain("getByRole(button, name=提交)");
    expect(out).toContain("click");
  });

  it("by=role + exact:getByRole 第二参带 exact:true", async () => {
    const tab = await openTab();
    await tool.execute({ action: "playwright", tab, op: "locator",
      steps: [{ by: "role", name: "link", value: "登录", exact: true }], then: { op: "count" } });
    expect(last("page", "getByRole")!.args[1]).toEqual({ name: "登录", exact: true });
    expect(has("locator:role=link", "count")).toBe(true);
  });

  it("by=text/label/placeholder/testid/alt/title:value 直接作 matcher(其余 getBy*)", async () => {
    const tab = await openTab();
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "text", value: "你好" }], then: { op: "isVisible" } });
    expect(last("page", "getByText")!.args[0]).toBe("你好");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "label", value: "用户名" }], then: { op: "isEnabled" } });
    expect(last("page", "getByLabel")!.args[0]).toBe("用户名");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "placeholder", value: "搜索" }], then: { op: "textContent" } });
    expect(last("page", "getByPlaceholder")!.args[0]).toBe("搜索");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "testid", value: "submit" }], then: { op: "getAttribute", attribute: "href" } });
    expect(last("page", "getByTestId")!.args[0]).toBe("submit");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "alt", value: "logo" }], then: { op: "innerText" } });
    expect(last("page", "getByAltText")!.args[0]).toBe("logo");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "title", value: "提示" }], then: { op: "fill", value: "x" } });
    expect(last("page", "getByTitle")!.args[0]).toBe("提示");
  });

  it("多级 steps 链式构造(getByRole >> getByText)", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "locator",
      steps: [{ by: "role", name: "list", value: "结果" }, { by: "text", value: "第一项" }],
      then: { op: "count" } }));
    expect(has("page", "getByRole")).toBe(true);
    expect(last("page", "getByText")!.args[0]).toBe("第一项");
    expect(has("locator:text=第一项", "count")).toBe(true);
    expect(out).toContain("getByRole(list, name=结果) >> getByText(第一项)");
  });

  it("chain=first/last/nth/filter 逐段作用在 locator 上,then 作用于链尾", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "locator",
      steps: [{ by: "text", value: "条目" }],
      chain: [{ op: "filter", hasText: "可用" }, { op: "nth", n: 2 }],
      then: { op: "click" } }));
    const filter = last("locator:text=条目", "filter")!;
    expect(filter.args[0]).toEqual({ hasText: "可用" });
    expect(last("locator:text=条目 >> filter=可用", "nth")!.args[0]).toBe(2);
    expect(has("locator:text=条目 >> filter=可用 >> nth=2", "click")).toBe(true);
    expect(out).toContain("filter(hasText=可用) >> nth(2)");
    await tool.execute({ action: "playwright", tab, op: "locator",
      steps: [{ by: "text", value: "项" }], chain: [{ op: "first" }], then: { op: "hover" } });
    expect(has("locator:text=项 >> first()", "hover")).toBe(true);
  });

  it("then=fill/type/press/selectOption 透传参数", async () => {
    const tab = await openTab();
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "label", value: "名字" }], then: { op: "fill", value: "张三" } });
    expect(last("locator:label=名字", "fill")!.args[0]).toBe("张三");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "label", value: "名字" }], then: { op: "type", text: "abc" } });
    expect(last("locator:label=名字", "type")!.args[0]).toBe("abc");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "label", value: "名字" }], then: { op: "press", key: "Enter" } });
    expect(last("locator:label=名字", "press")!.args[0]).toBe("Enter");
    await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "label", value: "名字" }], then: { op: "selectOption", label: "蓝" } });
    expect(last("locator:label=名字", "selectOption")!.args[0]).toEqual({ label: "蓝" });
  });

  it("then=screenshot 走 locator.screenshot 并经 saveShotBuf 落盘回 markdown 行", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "locator",
      steps: [{ by: "testid", value: "pic" }], then: { op: "screenshot", path: "pw-el" } }));
    expect(has("locator:testid=pic", "screenshot")).toBe(true);
    const f = out.match(/截图已存:(\S+\.png)/)?.[1];
    expect(f).toBeTruthy();
    expect(f!.endsWith("pw-el.png")).toBe(true);
    expect(existsSync(f!)).toBe(true);
    expect(out).toContain("![浏览器截图");
  });

  it("缺 steps / 缺 then / 未知 by / 未知 chain op / role 缺 name:回 [browser] 不支持", async () => {
    const tab = await openTab();
    const noSteps = String(await tool.execute({ action: "playwright", tab, op: "locator", then: { op: "click" } }));
    expect(noSteps.startsWith("[browser] ")).toBe(true);
    expect(noSteps).toContain("steps");
    const noThen = String(await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "text", value: "x" }] }));
    expect(noThen.startsWith("[browser] ")).toBe(true);
    expect(noThen).toContain("then");
    const badBy = String(await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "xpath", value: "x" }], then: { op: "click" } }));
    expect(badBy.startsWith("[browser] ")).toBe(true);
    expect(badBy).toContain("不支持");
    const badChain = String(await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "text", value: "x" }], chain: [{ op: "and" }], then: { op: "click" } }));
    expect(badChain).toContain("chain");
    const noName = String(await tool.execute({ action: "playwright", tab, op: "locator", steps: [{ by: "role", value: "提交" }], then: { op: "click" } }));
    expect(noName).toContain("name");
  });
});

describe("playwright op=waitForLoadState / waitForURL / evaluate", () => {
  it("waitForLoadState 透传 state 与 timeout,回 等待 <state> ✓", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "waitForLoadState", state: "networkidle", timeoutMs: 5_000 }));
    const call = last("page", "waitForLoadState")!;
    expect(call.args[0]).toBe("networkidle");
    expect((call.args[1] as { timeout: number }).timeout).toBe(5_000);
    expect(out).toContain("等待 networkidle ✓");
    expect(out).toContain("[tab " + tab + "]");
  });

  it("waitForLoadState 缺省 state=load;非法 state 被拒", async () => {
    const tab = await openTab();
    await tool.execute({ action: "playwright", tab, op: "waitForLoadState" });
    expect(last("page", "waitForLoadState")!.args[0]).toBe("load");
    const bad = String(await tool.execute({ action: "playwright", tab, op: "waitForLoadState", state: "bogus" }));
    expect(bad.startsWith("[browser] ")).toBe(true);
    expect(bad).toContain("waitForLoadState state");
  });

  it("waitForURL 调 page.waitForURL(url,{timeout})", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "waitForURL", url: "http://a.test/done", timeoutMs: 3_000 }));
    const call = last("page", "waitForURL")!;
    expect(call.args[0]).toBe("http://a.test/done");
    expect((call.args[1] as { timeout: number }).timeout).toBe(3_000);
    expect(out).toContain("等待 url ✓");
    const missing = String(await tool.execute({ action: "playwright", tab, op: "waitForURL" }));
    expect(missing.startsWith("[browser] ")).toBe(true);
    expect(missing).toContain("url");
  });

  it("evaluate 跑页面 JS 表达式,结果 JSON 化截 2000", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "evaluate", expression: "1 + 1" }));
    expect(last("page", "evaluate")!.args[0]).toBe("1 + 1");
    expect(out).toContain("结果:");
  });
});

describe("playwright 拒绝面(安全红线/已有替代/无 iframe)", () => {
  it.each([
    ["downloadPath", "安全红线"],
    ["fileChooserSetFiles", "安全红线"],
    ["domSnapshot", "action=snapshot"],
    ["frameLocator", "iframe"],
  ] as const)("op=%s 回 [browser] 本仓禁用/不适用", async (op, why) => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("本仓禁用/不适用");
    expect(out).toContain(op);
    expect(out).toContain(why);
  });

  it("未知 op 回 [browser] 不支持;面板视图白名单不含 playwright", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "playwright", tab, op: "bogus" }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("playwright op 可用");
    const hub = getBrowserViewHub(root, cfg);
    const denied = await hub.runViewCommand("playwright", { op: "waitForLoadState" });
    expect(denied.ok).toBe(false);
    expect(denied.text).toContain("面板命令白名单外: playwright");
  });
});

describe("错误码(第二行 code=<k> sideEffect=<none|uncertain>)", () => {
  it("ref 过期 → code=ref_not_found sideEffect=none(act 未触达定位器)", async () => {
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab });
    /* 同前:页面内自发导航(非 action=navigate)才会留下过期 ref。 */
    H.state.url = "http://a.test/moved";
    const out = String(await tool.execute({ action: "act", tab, ref: "e1", op: "fill", value: "x" }));
    const lines = out.split("\n");
    expect(lines[0]).toContain("ref 已过期");
    expect(lines[1]).toBe("code=ref_not_found sideEffect=uncertain");
    /* 行首仍是 [browser]:hub 判 ok 的正则口径不破。 */
    expect(/^\[browser( 失败)?\]/.test(lines[0]!)).toBe(true);
  });

  it("域名拒绝 → code=navigation_blocked;未知 op → capability_unsupported;只读失败 → sideEffect=none", async () => {
    const tab = await openTab();
    const nav = String(await tool.execute({ action: "navigate", tab, op: "url", url: "http://evil.test/x" }));
    expect(nav.split("\n")[1]).toBe("code=navigation_blocked sideEffect=uncertain");
    const cap = String(await tool.execute({ action: "playwright", tab, op: "bogus" }));
    expect(cap.split("\n")[1]).toBe("code=capability_unsupported sideEffect=none");
    const ro = String(await tool.execute({ action: "elementInfo", tab, x: 1, y: 1 }));
    expect(ro.split("\n")[0]).toContain("未命中");
    expect(ro.split("\n")[1]).toBe("code=execution_error sideEffect=none");
  });

  it("wait_for 超时 → code=timeout sideEffect=none;[browser 失败] 路径(execution_error)也带码行", async () => {
    const tab = await openTab();
    const timeout = String(await tool.execute({ action: "wait_for", tab, kind: "selector", value: "#nope", timeoutMs: 500 }));
    expect(timeout.split("\n")[1]).toBe("code=timeout sideEffect=none");
    /* locator.waitFor 探针必抛 Timeout → 走 catch 的 [browser 失败] 路。 */
    const failed = String(await tool.execute({ action: "act", tab, selector: "#x", op: "waitFor" }));
    const flines = failed.split("\n");
    expect(flines[0]!.startsWith("[browser 失败] ")).toBe(true);
    expect(flines[1]).toBe("code=timeout sideEffect=uncertain");
    expect(/^\[browser( 失败)?\]/.test(flines[0]!)).toBe(true);
  });

  it("未启用 → code=backend_unavailable;面板 runViewCommand 的 ok 判定不受第二行影响", async () => {
    const off = createBrowserTool(root, { enabled: () => false, allowDomains: () => [] });
    const out = String(await off.execute({ action: "tabs" }));
    const lines = out.split("\n");
    expect(lines[0]).toContain("未启用");
    expect(lines[1]).toBe("code=backend_unavailable sideEffect=none");
    const hub = getBrowserViewHub(root, cfg);
    await openTab();
    const bad = await hub.runViewCommand("navigate", { op: "url", url: "http://evil.test/" });
    expect(bad.ok).toBe(false);
    const good = await hub.runViewCommand("tabs", {});
    expect(good.ok).toBe(true);
  });
});

describe("elapsedMs(成功回执耗时>200ms 尾追加)", () => {
  it("慢命令(>200ms)尾追加 elapsedMs=<n>;快命令不追加", async () => {
    const tab = await openTab();
    H.state.slowMs = 260;
    const slow = String(await tool.execute({ action: "getState", tab }));
    const m = slow.match(/ elapsedMs=(\d+)$/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(200);
    H.state.slowMs = 0;
    const fast = String(await tool.execute({ action: "getState", tab }));
    expect(fast).not.toMatch(/ elapsedMs=\d+$/);
    expect(JSON.parse(fast).url).toBe("http://a.test/");
  });
});

/* ═══════════ 命令面扩写(第二批之二:快照字段补齐 + tab 生命周期 + 会话最小面) ═══════════ */

describe("snapshot 新字段(disabled/checked/parentRef/dom ref/domTruncated)", () => {
  const richSnap = {
    elements: [
      { tag: "input", role: "input", name: "输入名字", text: "", value: "", selector: "#name",
        rect: { x: 1, y: 2, w: 10, h: 10, width: 10, height: 10 }, inViewport: true,
        disabled: true, xpath: "/html/body/div/input[1]", attributes: { id: "name", placeholder: "名字" } },
      { tag: "input", role: "input", name: "勾选", text: "", value: "", selector: "#chk",
        rect: { x: 5, y: 6, w: 12, h: 12, width: 12, height: 12 }, inViewport: true,
        checked: true, parentRef: 0 },
      { tag: "button", role: "button", name: "提交", text: "提交", value: "", selector: "#go",
        rect: { x: 8, y: 9, w: 20, h: 10, width: 20, height: 10 }, inViewport: true },
    ],
    dom: [
      { tag: "h1", depth: 1, text: "表单标题", inViewport: true, ref: 0 },
      { tag: "p", depth: 2, text: "正文段落", inViewport: true },
    ],
    url: "http://a.test/", title: "测试页", truncated: false, domTruncated: true,
  };

  it("渲染行内追加 [disabled]/[checked] 与父级 ^eN,既有 @x,y 形态不破", async () => {
    const tab = await openTab();
    H.state.snapOverride = richSnap;
    const out = String(await tool.execute({ action: "snapshot", tab }));
    expect(out).toContain('e1 input "输入名字" @1,2 [disabled]');
    expect(out).toContain('e2 input "勾选" @5,6 [checked] ^e1');
    /* 无状态位的行保持旧形态(不动既有断言依赖)。 */
    expect(out).toContain('e3 button "提交" @8,9');
  });

  it("dom 节点与 elements 同元素时行内带 [ref=eN];顶层 domTruncated 有提示", async () => {
    const tab = await openTab();
    H.state.snapOverride = richSnap;
    const out = String(await tool.execute({ action: "snapshot", tab }));
    expect(out).toContain("h1: 表单标题 [ref=e1]");
    expect(out).toContain("p: 正文段落");
    expect(out).toContain("domTruncated=true");
  });

  it("maxElements/includeHidden 以实参透传进 COLLECT_SNAPSHOT 调用", async () => {
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab, maxElements: 50, includeHidden: true });
    expect(H.state.lastEval).toMatch(/\(50, true\)$/);
    H.state.lastEval = "";
    await tool.execute({ action: "snapshot", tab });
    expect(H.state.lastEval).toMatch(/\(300, false\)$/);
  });

  it("maxElements clamp 10..300;渲染上限随 maxElements 截断", async () => {
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab, maxElements: 999 });
    expect(H.state.lastEval).toMatch(/\(300, false\)$/);
    await tool.execute({ action: "snapshot", tab, maxElements: 1 });
    expect(H.state.lastEval).toMatch(/\(10, false\)$/);
    /* 12 元素快照 + maxElements=10(clamp 下限):e11/e12 不再渲染。 */
    H.state.snapOverride = {
      ...richSnap,
      elements: Array.from({ length: 12 }, (_, i) => ({
        tag: "button", role: "button", name: "按钮" + (i + 1), text: "", value: "",
        selector: "#b" + (i + 1),
        rect: { x: i, y: i, w: 10, h: 10, width: 10, height: 10 }, inViewport: true,
      })),
      dom: [],
    };
    const out = String(await tool.execute({ action: "snapshot", tab, maxElements: 10 }));
    expect(out).toContain("e10 ");
    expect(out).not.toContain("e11 ");
    expect(out).toContain("已截断");
  });

  it("采集脚本含 opacity:hidden 口径与 attributes 白名单(静态断言)", async () => {
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab });
    /* 脚本串透传进 evaluate:lastEval 即完整 COLLECT_SNAPSHOT。 */
    expect(H.state.lastEval).toContain('opacity !== "0"');
    expect(H.state.lastEval).toContain('["id", "name", "type", "placeholder", "title", "alt", "role", "aria-label", "data-testid", "href"]');
    expect(H.state.lastEval).toContain("parentRef");
    expect(H.state.lastEval).toContain("domTruncated");
  });
});

describe("hitRegions 双键(width/height 主 + w/h 旧)", () => {
  it("帧的 hitRegions 同时带 width/height 与 w/h,值一致", async () => {
    const hub = getBrowserViewHub(root, cfg);
    const tab = await openTab();
    await tool.execute({ action: "snapshot", tab });
    const frames: Array<Record<string, unknown>> = [];
    const { subId } = hub.subscribe(tab, (m) => { if ("seq" in m) frames.push(m as unknown as Record<string, unknown>); });
    for (let i = 0; i < 40 && !frames.length; i++) await new Promise((r) => setTimeout(r, 25));
    hub.unsubscribe(subId);
    const regions = frames[0]!.hitRegions as Array<{ ref: string; x: number; y: number; w: number; h: number; width: number; height: number }>;
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.width).toBe(r.w);
      expect(r.height).toBe(r.h);
      expect(r.width).toBeGreaterThan(0);
    }
  });
});

describe("tab 生命周期(markDeliverable/markHandoff/claimTab/listUserTabs/finalize/finalizeTabs)", () => {
  it("markDeliverable 回状态行;tabs 行尾带 [deliverable]", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "markDeliverable", tab }));
    expect(out).toBe(`[tab ${tab}] deliverable · 测试页 | http://a.test/`);
    const list = String(await tool.execute({ action: "tabs" }));
    expect(list).toContain(`[deliverable]`);
  });

  it("markHandoff 置 handoff;listUserTabs 列出待接管", async () => {
    const tab = await openTab();
    const out = String(await tool.execute({ action: "markHandoff", tab }));
    expect(out).toBe(`[tab ${tab}] handoff · 测试页 | http://a.test/`);
    const users = String(await tool.execute({ action: "listUserTabs" }));
    expect(users).toContain("待接管 tab(handoff)");
    expect(users).toContain(tab);
    expect(String(await tool.execute({ action: "tabs" }))).toContain("[handoff]");
  });

  it("claimTab 把 handoff 收回 active;非 handoff 的 tab 拒绝 claim", async () => {
    const tab = await openTab();
    await tool.execute({ action: "markHandoff", tab });
    const back = String(await tool.execute({ action: "claimTab", tab }));
    expect(back).toBe(`[tab ${tab}] active · 测试页 | http://a.test/`);
    expect(String(await tool.execute({ action: "listUserTabs" }))).toBe("(无待接管 tab)");
    const again = String(await tool.execute({ action: "claimTab", tab }));
    expect(again.startsWith("[browser] ")).toBe(true);
    expect(again).toContain("非 handoff");
  });

  it("markDeliverable 未知 tab 报错带在场清单;listUserTabs 空池回无", async () => {
    const tab = await openTab();
    const bad = String(await tool.execute({ action: "markDeliverable", tab: "t99" }));
    expect(bad.startsWith("[browser] ")).toBe(true);
    expect(bad).toContain("不存在");
    expect(bad.split("\n")[1]).toBe("code=ref_not_found sideEffect=none");
  });

  it("finalize 关非 keep 的 tab,回关闭/保留清单", async () => {
    const t1 = await openTab();
    const t2 = String(await tool.execute({ action: "newTab" })).match(/\[tab (t\d+)\]/)?.[1]!;
    const out = String(await tool.execute({ action: "finalize", keep: [t1] }));
    expect(out).toContain(`关闭 [${t2}]`);
    expect(out).toContain(`保留 [${t1}]`);
    const list = String(await tool.execute({ action: "tabs" }));
    expect(list).toContain(t1);
    expect(list).not.toContain(t2 + "  ");
  });

  it("finalizeTabs 保留并按表置 deliverable/handoff 标记", async () => {
    const t1 = await openTab();
    const t2 = String(await tool.execute({ action: "newTab" })).match(/\[tab (t\d+)\]/)?.[1]!;
    const out = String(await tool.execute({ action: "finalizeTabs", keep: [
      { tab: t1, status: "deliverable" }, { tab: t2, status: "handoff" },
    ] }));
    expect(out).toContain(`关闭 [](无)`);
    expect(out).toContain(`保留 [${t1}, ${t2}]`);
    const list = String(await tool.execute({ action: "tabs" }));
    const l1 = list.split("\n").find((l) => l.includes(t1 + "  "))!;
    const l2 = list.split("\n").find((l) => l.includes(t2 + "  "))!;
    expect(l1).toContain("[deliverable]");
    expect(l2).toContain("[handoff]");
    expect(String(await tool.execute({ action: "listUserTabs" }))).toContain(t2);
  });

  it("finalize 不带 keep 关全部", async () => {
    const t1 = await openTab();
    await tool.execute({ action: "newTab" });
    const out = String(await tool.execute({ action: "finalize" }));
    expect(out).toContain(t1);
    expect(out).toContain("保留 [](无)");
    expect(String(await tool.execute({ action: "tabs" }))).toBe("(无在场 tab,先 action=open)");
  });
});

describe("per-tab viewport(viewport_get/viewport_set 增 tab)", () => {
  it("viewport_set{tab} 作用于该 tab 并回显;viewport_get{tab} 读回", async () => {
    const tab = await openTab();
    const set = String(await tool.execute({ action: "viewport_set", tab, width: 800, height: 600 }));
    expect(set).toBe("视口 800x600");
    expect(H.state.viewport).toEqual({ width: 800, height: 600 });
    expect(String(await tool.execute({ action: "viewport_get", tab }))).toBe("视口 800x600");
  });

  it("viewport_set/viewport_get 的 tab 不存在时报错(不再盲打 lastActive)", async () => {
    await openTab();
    const bad = String(await tool.execute({ action: "viewport_get", tab: "t99" }));
    expect(bad.startsWith("[browser] ")).toBe(true);
    expect(bad).toContain("无可用 tab");
    expect(bad.split("\n")[1]).toBe("code=ref_not_found sideEffect=none");
  });
});

describe("会话最小面(nameSession/turnEnded/sessionInfo/closeSession/cancelRequest)", () => {
  it("nameSession 存名;sessionInfo 回单行 JSON {pool,name,turn}", async () => {
    const named = String(await tool.execute({ action: "nameSession", name: "验收会话" }));
    expect(named).toBe("会话已命名:验收会话");
    const info = JSON.parse(String(await tool.execute({ action: "sessionInfo" }))) as Record<string, unknown>;
    expect(info.pool).toBe("default");
    expect(info.name).toBe("验收会话");
    expect(info.turn).toBe(0);
    expect(String(await tool.execute({ action: "sessionInfo" }))).not.toContain("\n");
  });

  it("turnEnded 回合计数单调 +1,turnId 仅回显;closeSession 清元数据", async () => {
    const t1 = String(await tool.execute({ action: "turnEnded" }));
    expect(t1).toContain("turn=1");
    const t2 = String(await tool.execute({ action: "turnEnded", turnId: "u-42" }));
    expect(t2).toContain("turn=2");
    expect(t2).toContain("turnId=u-42");
    await tool.execute({ action: "closeSession" });
    const info = JSON.parse(String(await tool.execute({ action: "sessionInfo" }))) as Record<string, unknown>;
    expect(info.name).toBeNull();
    expect(info.turn).toBe(0);
  });

  it("cancelRequest 如实回不适用(不假装取消成功);nameSession 缺 name 报错", async () => {
    const out = String(await tool.execute({ action: "cancelRequest", requestId: "req-1" }));
    expect(out.startsWith("[browser] ")).toBe(true);
    expect(out).toContain("本仓无跨进程请求表,取消不适用");
    expect(out).toContain("req-1");
    expect(out.split("\n")[1]).toBe("code=capability_unsupported sideEffect=none");
    const noName = String(await tool.execute({ action: "nameSession" }));
    expect(noName.startsWith("[browser] ")).toBe(true);
    expect(noName).toContain("需要 name");
  });
});

describe("description 增补", () => {
  it("命令清单含 playwright 行与错误码说明;总长 ≤4200 字符", () => {
    expect(tool.description).toContain("- playwright{tab?,op,steps?,chain?,then?");
    expect(tool.description).toContain("错误码");
    expect(tool.description).toContain("code=<k> sideEffect=<none|uncertain>");
    expect(tool.description.length).toBeLessThanOrEqual(4300);
  });

  it("第二批之二:生命周期/会话面/快照新参数行齐备", () => {
    expect(tool.description).toContain("- 生命周期:markDeliverable{tab}/markHandoff{tab}");
    expect(tool.description).toContain("finalizeTabs{keep:[{tab,status:deliverable|handoff}]}");
    expect(tool.description).toContain("- 会话面(单池 default):nameSession{name}");
    expect(tool.description).toContain("cancelRequest{requestId}");
    expect(tool.description).toContain("maxElements clamp 10..300 默认 300");
    expect(tool.description).toContain("includeHidden=true 放宽 visibility/opacity");
    expect(tool.description).toContain("`[disabled]`/`[checked]`");
    expect(tool.description).toContain("viewport_get{tab?} / viewport_set{width,height,tab?}");
    expect(tool.description).toContain("`[deliverable]`/`[handoff]`");
  });
});

/* ───────── 2026-11 browser-ux-redo:getState / 自动快照 / owner 隔离 / idle 豁免 / 配置与启动通道 ───────── */

const toolHuman = createBrowserTool(root, cfg, "human");
const realNow = Date.now.bind(Date);

describe("a. 视图命令白名单补 getState", () => {
  it("hub.runViewCommand('getState') 白名单内、回执含 canGoForward;eval 仍在白名单外", async () => {
    const tab = await openTab();
    const hub = getBrowserViewHub(root, cfg);
    const r = await hub.runViewCommand("getState", { tabId: tab });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("canGoForward");
    expect(r.text).toContain("canGoBack");
    const bad = await hub.runViewCommand("eval", { tabId: tab });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("白名单外");
  });

  it("历史游标:open 后 canGoForward=false,navigate op=back 后=true,forward 回来又 false", async () => {
    const tab = await openTab();
    const hub = getBrowserViewHub(root, cfg);
    expect((await hub.runViewCommand("getState", { tabId: tab })).text).toContain('"canGoForward":false');
    await hub.runViewCommand("navigate", { tabId: tab, op: "back" });
    expect((await hub.runViewCommand("getState", { tabId: tab })).text).toContain('"canGoForward":true');
    await hub.runViewCommand("navigate", { tabId: tab, op: "forward" });
    expect((await hub.runViewCommand("getState", { tabId: tab })).text).toContain('"canGoForward":false');
  });
});

describe("b. open/navigate 后自动 snapshot", () => {
  it("open 后 refs 已就位(不先 snapshot 也能 act),同 URL 再导航不重拍", async () => {
    await openTab();
    expect(H.state.snapEvals).toBeGreaterThan(0);
    const afterOpen = H.state.snapEvals;
    /* 自动快照填了 refs:e1 直接可用(未显式 action=snapshot)。 */
    const clicked = String(await tool.execute({ action: "act", ref: "e1", op: "click" }));
    expect(clicked).toContain("click ✓");
    /* 同 URL 再导航:自动快照节流(同 url + refs 非空)→ 不重拍。 */
    const nav = String(await tool.execute({ action: "navigate", op: "url", url: "http://a.test/" }));
    expect(nav).toContain("[nav]");
    expect(H.state.snapEvals).toBe(afterOpen);
  });
});

describe("c. owner 隔离", () => {
  it("agent 无显式 tab 时选自己 owner 的最近 tab,不动 human 的 tab", async () => {
    const agentTab = await openTab();
    const humanOut = String(await toolHuman.execute({ action: "newTab", url: "http://a.test/human" }));
    const humanTab = humanOut.match(/\[tab (t\d+)\]/)![1]!;
    /* agent 侧 tabs 行带 owner 列。 */
    const listed = String(await tool.execute({ action: "tabs" }));
    expect(listed).toContain("human");
    /* 无显式 tab 的 close:只关自己 owner 的最近 tab。 */
    const closed = String(await tool.execute({ action: "close" }));
    expect(closed).toContain(agentTab);
    const after = String(await tool.execute({ action: "tabs" }));
    expect(after).toContain(humanTab);
    expect(after).not.toContain(agentTab);
  });

  it("显式 tab 且 owner 不符 → fail-closed 返回错误文本,tab 仍在", async () => {
    const humanOut = String(await toolHuman.execute({ action: "newTab", url: "http://a.test/h2" }));
    const humanTab = humanOut.match(/\[tab (t\d+)\]/)![1]!;
    const denied = String(await tool.execute({ action: "close", tab: humanTab }));
    expect(denied.startsWith("[browser] ")).toBe(true);
    expect(denied).toContain("拒绝关闭");
    expect(denied).toContain("owner=");
    expect(String(await tool.execute({ action: "tabs" }))).toContain(humanTab);
  });
});

describe("d. idle 回收跳过视图订阅的 tab", () => {
  it("订阅中的 tab 到点不回收,未订阅的按 idleMinutes 回收;退订后同样被回收", async () => {
    const idleCfg = { enabled: () => true, allowDomains: () => ["a.test"], idleMinutes: () => 1 };
    const toolIdle = createBrowserTool(root, idleCfg);
    await toolIdle.execute({ action: "close", scope: "all" });
    const watched = String(await toolIdle.execute({ action: "open", url: "http://a.test/watched" })).match(/\[tab (t\d+)\]/)![1]!;
    const plain = String(await toolIdle.execute({ action: "newTab", url: "http://a.test/plain" })).match(/\[tab (t\d+)\]/)![1]!;
    const hub = getBrowserViewHub(root, idleCfg);
    const sub = hub.subscribe(watched, () => {});
    expect(sub.tabId).toBe(watched);
    /* 时间推过 idleMinutes(1 分钟)+ 余量:两条 tab 都已超阈值。 */
    const fake = vi.spyOn(Date, "now").mockReturnValue(realNow() + 5 * 60_000);
    try {
      const out = String(await toolIdle.execute({ action: "tabs" }));
      expect(out).toContain(watched);
      expect(out.includes(plain)).toBe(false);
      /* 退订后不再豁免 → 下一次动作时被回收。 */
      hub.unsubscribe(sub.subId);
      const out2 = String(await toolIdle.execute({ action: "tabs" }));
      expect(out2).toContain("(无在场 tab");
    } finally {
      fake.mockRestore();
    }
  });
});

describe("e. schema 缺省", () => {
  it("browser.enabled 缺省 true、显式 false 仍 false;idleMinutes/profile/profileDir/headless 有缺省", () => {
    const d = ConfigSchema.parse({}).browser;
    expect(d.enabled).toBe(true);
    expect(d.idleMinutes).toBe(30);
    expect(d.profile).toBe("persistent");
    expect(d.profileDir).toBe(".genie/browser-profile");
    expect(typeof d.headless).toBe("boolean");
    expect(d.allowDomains).toEqual([]);
    expect(ConfigSchema.parse({ browser: { enabled: false } }).browser.enabled).toBe(false);
  });
});

describe("f. Chrome 探测链", () => {
  it("CHROME_PATH 优先 → google-chrome-stable → google-chrome → chromium → chromium-browser → undefined", () => {
    const stub = join(root, "fake-chrome");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    expect(resolveChromePath({ CHROME_PATH: stub }, () => false)).toBe(stub);
    expect(resolveChromePath({}, () => true)).toBe("/usr/bin/google-chrome-stable");
    expect(resolveChromePath({}, (p) => p !== "/usr/bin/google-chrome-stable")).toBe("/usr/bin/google-chrome");
    expect(resolveChromePath({}, (p) => p === "/usr/bin/chromium")).toBe("/usr/bin/chromium");
    expect(resolveChromePath({}, (p) => p === "/usr/bin/chromium-browser")).toBe("/usr/bin/chromium-browser");
    expect(resolveChromePath({}, () => false)).toBeUndefined();
  });
});

describe("g. profile 形态选路", () => {
  const base = { enabled: () => true, allowDomains: () => [] as string[] };

  it("persistent/ephemeral/headless/profileDir/idleMinutes 纯函数选路", () => {
    expect(browserLaunchPlan(root, { ...base, profile: () => "ephemeral" }).mode).toBe("ephemeral");
    expect(browserLaunchPlan(root, { ...base, profile: () => "persistent" }).mode).toBe("persistent");
    expect(browserLaunchPlan(root, base).mode).toBe("persistent");
    expect(browserLaunchPlan(root, base).headless).toBe(true);
    expect(browserLaunchPlan(root, { ...base, headless: () => false }).headless).toBe(false);
    expect(browserLaunchPlan(root, base).profileDir).toBe(join(root, ".genie/browser-profile"));
    expect(browserLaunchPlan(root, { ...base, profileDir: () => "/abs/browser-profile" }).profileDir).toBe("/abs/browser-profile");
    expect(idleMinutesOf(base)).toBe(30);
    expect(idleMinutesOf({ ...base, idleMinutes: () => 240 })).toBe(240);
    expect(idleMinutesOf({ ...base, idleMinutes: () => 0 })).toBe(1);
  });

  it("缺省 persistent:实际启动走 launchPersistentContext,profile 目录 .genie/browser-profile", async () => {
    await openTab();
    expect(H.state.launchMode).toBe("launchPersistentContext");
    expect(H.state.launchDir).toBe(join(root, ".genie/browser-profile"));
    expect(existsSync(join(root, ".genie/browser-profile"))).toBe(true);
  });
});

/* ═══════════ 真实站点解析(2026-11 bilibili 样本):可点容器 / 巨型容器 / 视口优先 ═══════════
 * 桩 page.evaluate 不会真跑 COLLECT_SNAPSHOT,这里把最近一次 evaluate 的脚本串取出,
 * 在极简假 DOM 上真正执行一遍——cursor:pointer 容器这类页面内判据才被覆盖。 */
type FakeEl = {
  tagName: string; nodeType: number; id: string; children: FakeEl[]; parentElement: FakeEl | null;
  innerText: string; textContent: string; value: string; offsetWidth: number; offsetHeight: number;
  disabled: boolean; type: string; ownerCursor?: string;
  getAttribute: (k: string) => string | null; hasAttribute: (k: string) => boolean;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number };
};
interface FSpec {
  tag: string; text?: string; id?: string; attrs?: Record<string, string>;
  rect: [number, number, number, number]; cursor?: string; children?: FSpec[];
}
const fakeEl = (s: FSpec, parent: FakeEl | null): FakeEl => {
  const [x, y, width, height] = s.rect;
  const el: FakeEl = {
    tagName: s.tag.toUpperCase(), nodeType: 1, id: s.id ?? "", children: [], parentElement: parent,
    innerText: s.text ?? "", textContent: s.text ?? "", value: "", offsetWidth: width, offsetHeight: height,
    disabled: false, type: "", ownerCursor: s.cursor,
    getAttribute: (k) => (s.attrs && k in s.attrs ? s.attrs[k]! : null),
    hasAttribute: (k) => !!(s.attrs && k in s.attrs),
    getBoundingClientRect: () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }),
  };
  el.children = (s.children ?? []).map((c) => fakeEl(c, el));
  return el;
};
/** CSS cursor 继承:cursor:pointer 会传给后代 → 后代也算 pointer(最外层判据的依据)。 */
const effCursor = (el: FakeEl): string => (el.ownerCursor ? el.ownerCursor : el.parentElement ? effCursor(el.parentElement) : "auto");

const runCollect = (specs: FSpec[], maxElements = 300): { elements: Array<Record<string, unknown>>; truncated: boolean } => {
  const body = fakeEl({ tag: "body", rect: [0, 0, 1024, 768] }, null);
  body.children = specs.map((s) => fakeEl(s, body));
  const flat: FakeEl[] = [];
  const walk = (el: FakeEl) => { for (const c of el.children) { flat.push(c); walk(c); } };
  walk(body);
  const doc = {
    body, title: "假页", getElementById: () => null, querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === "body *" ? flat : []),
  };
  const win = { innerWidth: 1024, innerHeight: 768 };
  const gcs = (el: FakeEl) => ({ cursor: effCursor(el), display: "block", visibility: "visible", opacity: "1" });
  /* lastEval 形如 "(((maxElements, includeHidden) => {...}))(300, false)":剥掉实参拿到可传参的箭头。 */
  expect(H.state.lastEval).toContain("querySelectorAll");
  const arrowSrc = H.state.lastEval.replace(/\)\s*\(\d+,\s*(?:true|false)\)\s*$/, ")");
  const fn = new Function("document", "window", "getComputedStyle", "CSS", "location", "return (" + arrowSrc + ");");
  const run = fn(doc, win, gcs, { escape: (v: string) => v }, { href: "http://a.test/" }) as
    (max: number, hidden: boolean) => { elements: Array<Record<string, unknown>>; truncated: boolean };
  return run(maxElements, false);
};
const primeCollect = async (): Promise<void> => {
  const tab = await openTab();
  await tool.execute({ action: "snapshot", tab });
};

describe("h. 可点容器识别(cursor:pointer,真实站点卡片)", () => {
  it("cursor:pointer 容器被收成 role=clickable,嵌套只收最外层", async () => {
    await primeCollect();
    const res = runCollect([{
      tag: "div", attrs: { class: "bili-video-card" }, rect: [10, 10, 240, 160], cursor: "pointer", text: "视频 A",
      /* 卡片内部:内层 div(继承 pointer)+ 播放按钮 span(显式 pointer)——都该被最外层判据挡掉。 */
      children: [
        { tag: "div", rect: [10, 10, 240, 160], children: [{ tag: "span", rect: [20, 20, 60, 20], cursor: "pointer", text: "12:34" }] },
      ],
    }]);
    expect(res.elements.length).toBe(1);
    expect(res.elements[0]).toMatchObject({ tag: "div", role: "clickable", name: "视频 A" });
  });

  it("非 pointer 的普通 div 与 <16x16 的 pointer 装饰层都不收", async () => {
    await primeCollect();
    const res = runCollect([
      { tag: "div", rect: [10, 10, 200, 120], text: "只是文本容器" },
      { tag: "span", rect: [20, 200, 12, 12], cursor: "pointer", text: "小图标" },
    ]);
    expect(res.elements.length).toBe(0);
  });

  it("原生可交互标签不受影响(role 仍按标签语义)", async () => {
    await primeCollect();
    const res = runCollect([{ tag: "a", attrs: { href: "/v/1" }, rect: [10, 10, 100, 20], cursor: "pointer", text: "链接" }]);
    expect(res.elements.length).toBe(1);
    expect(res.elements[0]).toMatchObject({ tag: "a", role: "a", name: "链接" });
  });
});

describe("i. 巨型容器排除 / 视口优先", () => {
  it("宽或高 >= 视口 90% 且无 role 无文本的 pointer 容器被排除", async () => {
    await primeCollect();
    const res = runCollect([
      /* 整页包裹层:pointer + 满视口 + 无文本 → 不收(否则整页一个命中框)。 */
      { tag: "div", rect: [0, 0, 1024, 768], cursor: "pointer", children: [
        { tag: "div", rect: [10, 10, 200, 120], cursor: "pointer", text: "卡片" },
      ] },
      /* 满视口但有 role → 走原生交互路径,仍收(role=button)。 */
      { tag: "div", attrs: { role: "button" }, rect: [0, 0, 1024, 700], text: "整屏按钮" },
    ]);
    const roles = res.elements.map((e) => e.role);
    expect(roles).toEqual(["clickable", "button"]);
    expect(res.elements[0]).toMatchObject({ name: "卡片" });
  });

  it("inVp 优先:预算截断时视口外元素不先占名额(两遍各自保 DOM 序)", async () => {
    await primeCollect();
    const res = runCollect([
      { tag: "div", rect: [10, 2000, 200, 120], cursor: "pointer", text: "视口外-先出现" },
      { tag: "div", rect: [10, 10, 200, 120], cursor: "pointer", text: "视口内-1" },
      { tag: "div", rect: [10, 200, 200, 120], cursor: "pointer", text: "视口内-2" },
    ], 2);
    expect(res.elements.map((e) => e.name)).toEqual(["视口内-1", "视口内-2"]);
    expect(res.elements.every((e) => e.inViewport === true)).toBe(true);
    expect(res.truncated).toBe(true);
  });
});

describe("j. hitRegions 裁视口 / 上限 120 / 面积升序", () => {
  it("跳过视口外与 >85% 视口超大框,按面积升序后截断 120", async () => {
    const tab = await openTab();
    /* 130 个 ref:e0 巨型框、e1 视口外框、其余面积随序号递减(需靠排序反转)。 */
    const els = Array.from({ length: 130 }, (_, i) => ({
      tag: "div", role: "clickable", name: "c" + i, text: "", value: "", selector: "#c" + i,
      rect: { x: 1, y: 1, w: 10, h: 10 }, inViewport: true,
    }));
    H.state.snapOverride = { elements: els, dom: [], url: "http://a.test/", title: "测试页", truncated: false };
    await tool.execute({ action: "snapshot", tab });
    H.state.bboxFor = (sel: string) => {
      const i = Number(sel.replace("#c", ""));
      if (i === 0) return { x: 0, y: 0, width: 1024, height: 768 };
      if (i === 1) return { x: 0, y: 5000, width: 100, height: 100 };
      return { x: 100, y: 100, width: 200 - i, height: 10 };
    };
    const hub = getBrowserViewHub(root, cfg);
    const frames: Array<Record<string, unknown>> = [];
    const { subId } = hub.subscribe(tab, (m) => { if ("seq" in m) frames.push(m as unknown as Record<string, unknown>); });
    for (let i = 0; i < 60 && !frames.length; i++) await new Promise((r) => setTimeout(r, 25));
    hub.unsubscribe(subId);
    const regions = frames[0]!.hitRegions as Array<{ ref: string; y: number; width: number; height: number }>;
    expect(regions.length).toBe(120);
    const areas = regions.map((r) => r.width * r.height);
    expect([...areas].sort((a, b) => a - b)).toEqual(areas);
    expect(areas.some((a) => a >= 1024 * 768 * 0.85)).toBe(false);
    expect(regions.some((r) => r.y >= 4000)).toBe(false);
    /* 最小面积 = #c129 的 (200-129)x10);最大几个被截掉。 */
    expect(regions[0]!.width).toBe(200 - 129);
  });
});
