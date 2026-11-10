/**
 * 浏览器控制工具(建立; 对齐 ZCode control-browser 重写; 命令面扩写 + 视图 hub):
 * 持久 tab 会话 + 快照 ref 定位 + Playwright 操作 + cua 坐标兜底。
 * 形态对齐 ZCode browser-use:tab 是跨调用连续性边界(不再每次 launch 即弃),
 * snapshot(可交互元素清单 e1..eN + aria 树)是页面感知主通道,screenshot 只在视觉确需时用,
 * canvas/非 DOM 目标走 cua 坐标路。裁剪掉多后端(iab/extension)/录像(单进程 headless 用不上)。
 * 门禁不变:config.browser.enabled 实时生效;allowDomains 白名单(open/navigate?op=url 校验,页面内导航不拦)。
 * 纪律:fail-soft 返回错误文本;截图落 .genie/browser-shots/;idle tab 10min 回收。
 * 池与视图:browser 实例 + tab 表提到模块级共享池——面板内置浏览器视图与 agent
 * 必须同池才能「人机同看」;BrowserViewHub 是只读观察面(帧 + 事件 + 白名单命令)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { Tool } from "@lampgenie/runtime/agent/loop";
import { buildRefMap, refsStale, resolveRef, type RefEntry } from "./browser-selection.js";

export interface BrowserToolConfig {
  enabled: () => boolean;
  allowDomains: () => string[];
  /** 浏览器视图/工具面可配项(2026-11 browser-ux-redo):全部可选,缺省值见实现。 */
  idleMinutes?: () => number;
  profile?: () => "persistent" | "ephemeral";
  profileDir?: () => string;
  headless?: () => boolean;
}

function hostAllowed(url: string, allow: string[]): boolean {
  if (!allow.length) return true;
  try {
    const h = new URL(url).hostname;
    return allow.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

/* ───────── 页面内快照收集脚本(自包含,序列化进 evaluate) ─────────
 * 可交互元素:可见 + (语义控件或带交互语义的 ARIA);语义节点:h1-h6/p/li 等正文块。
 * selector 构建:id → name → data-testid → nth-of-type CSS 路径(同 ZCode「有界稳定属性」口径)。 */
const COLLECT_SNAPSHOT = String.raw`
((maxElements, includeHidden) => {
  const MAX_ELEMENTS = Math.max(1, Math.floor(Number(maxElements) || 300));
  const DOM_MAX = 80;
  const RELAX = includeHidden === true;
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const clipped = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  /* visible 口径(形态来源: ZCode browserCommandScripts.ts isHidden):opacity==="0" 视为 hidden;
   * includeHidden=true 只放宽 visibility/opacity 判定,display:none 仍排除。 */
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    const st = getComputedStyle(el);
    if (st.display === "none") return false;
    if (RELAX) return true;
    return st.visibility !== "hidden" && st.opacity !== "0" && (el.offsetWidth || el.offsetHeight || r.width);
  };
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      let seg = cur.tagName.toLowerCase();
      if (seg === "html" || seg === "body") break;
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(">");
  };
  /* xpath(形态来源: ZCode browserCommandScripts.ts :50):逐级 tag[n](同 tag 兄弟序),深度上限 12。 */
  const xpathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      const tag = cur.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) n += 1;
      }
      parts.unshift(tag + "[" + n + "]");
      cur = cur.parentElement;
    }
    return "/" + parts.join("/");
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute("aria-label") || el.getAttribute("title");
    if (aria) return aria;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const by = labelledby.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((n) => n.textContent).join(" ");
      if (by) return by;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.type === "submit" || el.type === "button") return el.value || "";
      const lab = document.querySelector('label[for="' + (el.id || "") + '"]');
      if (lab) return clipped(lab.textContent, 80);
      return el.placeholder || "";
    }
    return clipped(el.innerText || el.textContent, 80);
  };
  const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "option", "label"]);
  const roleOf = (el) => el.getAttribute("role") || (INTERACTIVE.has(el.tagName.toLowerCase()) ? el.tagName.toLowerCase() : "");
  const interactable = (el) => {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE.has(tag)) return true;
    if (el.getAttribute("role") || el.getAttribute("onclick") || el.getAttribute("contenteditable") === "true") return true;
    if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
    return false;
  };
  /* 可点容器(2026-11 真实站点解析,bilibili 视频卡片这类 div + React 合成事件):
   * 无 onclick 属性 / 无 role / 无 tabindex,唯一可靠信号是 computed cursor:pointer。
   * 约束:尺寸 >= 16x16(挡装饰性包裹层)、只收最外层可点容器(父也是 pointer 则跳过,含 CSS 继承)、
   * 巨型容器(宽或高 >= 视口 90% 且无 role 无文本)排除——否则整页只剩一个命中框。 */
  const POINTER_MIN = 16;
  const GIANT_RATIO = 0.9;
  const cursorPointer = (el) => {
    try { return getComputedStyle(el).cursor === "pointer"; } catch { return false; }
  };
  const giantContainer = (el, r) => {
    if (!(r.width >= viewport.w * GIANT_RATIO || r.height >= viewport.h * GIANT_RATIO)) return false;
    if (el.getAttribute("role")) return false;
    return !clipped(el.innerText || el.textContent, 80);
  };
  /* 返回 {ok:收不收, clickable:是否按可点容器收(role 兜底 clickable)}。 */
  const classify = (el, r) => {
    if (interactable(el)) return { ok: true, clickable: false };
    if (r.width < POINTER_MIN || r.height < POINTER_MIN) return { ok: false, clickable: false };
    if (!cursorPointer(el)) return { ok: false, clickable: false };
    const p = el.parentElement;
    /* 父也是 pointer → 当前是被包裹的内层;但巨型包裹层(本身不收)例外,否则整片卡片全被吞掉。 */
    if (p && p !== document.body && cursorPointer(p) && !giantContainer(p, p.getBoundingClientRect())) {
      return { ok: false, clickable: false };
    }
    if (giantContainer(el, r)) return { ok: false, clickable: false };
    return { ok: true, clickable: true };
  };
  /* attributes 白名单(形态来源: ZCode browserCommandScripts.ts :47,:57 attrsOf):
   * 有界稳定属性,不收 class/style/src 等高噪声字段;非空才带。 */
  const ATTR_KEYS = ["id", "name", "type", "placeholder", "title", "alt", "role", "aria-label", "data-testid", "href"];
  const attrsOf = (el) => {
    const out = {};
    for (const k of ATTR_KEYS) {
      const v = el.getAttribute(k);
      if (v != null && String(v).trim() !== "") out[k] = clipped(v, 200);
    }
    return out;
  };
  /* depth 真实计算(传层深):body=0,逐级 parentElement +1(元素级缓存防深树平方)。 */
  const depthMemo = new Map();
  const depthOf = (el) => {
    if (el === document.body) return 0;
    if (depthMemo.has(el)) return depthMemo.get(el);
    let d = 0;
    let p = el.parentElement;
    while (p && p !== document.body) { d += 1; p = p.parentElement; }
    depthMemo.set(el, d);
    return d;
  };
  const elements = [];
  const dom = [];
  const all = document.querySelectorAll("body *");
  /* parentRef 采集:元素→elements 下标(WeakMap 反查最近被选祖先;祖先进文档序必先出现)。 */
  const elIndex = typeof WeakMap === "function" ? new WeakMap() : null;
  /* 候选集(文档序):可见元素 + 包围盒 + 视口标记。 */
  const cands = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inVp = r.top < viewport.h + 80 && r.bottom > -80 && r.left < viewport.w + 80 && r.right > -80;
    cands.push({ el, r, inVp });
  }
  /* 视口优先(2026-11):先吃视口内的,再吃视口外的——视口外元素不再先占名额(MAX_ELEMENTS 截断时)。
   * 两遍各自保持文档序,元素相对顺序稳定;dom 正文节点仍按文档序单独一遍(不随这个次序变)。 */
  const ordered = [];
  for (const wantVp of [true, false]) {
    for (const c of cands) if (c.inVp === wantVp) ordered.push(c);
  }
  for (const c of ordered) {
    const el = c.el;
    const r = c.r;
    const inVp = c.inVp;
    const verdict = classify(el, r);
    if (verdict.ok && elements.length < MAX_ELEMENTS) {
      const tag = el.tagName.toLowerCase();
      const rec = {
        tag,
        /* 可点容器无原生 role:标 clickable(渲染层 role!=tag 才出现,形态自解释)。 */
        role: verdict.clickable ? "clickable" : roleOf(el),
        name: accessibleName(el),
        text: clipped(el.innerText || el.textContent, 60),
        value: clipped(el.value, 60),
        selector: cssPath(el),
        xpath: xpathOf(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          width: Math.round(r.width), height: Math.round(r.height) },
        inViewport: inVp,
      };
      const attrs = attrsOf(el);
      if (Object.keys(attrs).length) rec.attributes = attrs;
      if (el.disabled === true) rec.disabled = true;
      if ((tag === "input" && (el.type === "checkbox" || el.type === "radio") && el.checked === true) ||
          (tag === "option" && el.selected === true)) rec.checked = true;
      if (elIndex) {
        const idx = elements.length;
        elIndex.set(el, idx);
        /* 最近被选祖先的下标(层级线索;顶层省略)。 */
        let p = el.parentElement;
        while (p) {
          if (elIndex.has(p)) { rec.parentRef = elIndex.get(p); break; }
          p = p.parentElement;
        }
      }
      elements.push(rec);
    }
  }
  /* 正文语义节点:单独按文档序一遍(不随视口优先重排,保持既有渲染次序)。 */
  for (const c of cands) {
    if (dom.length >= DOM_MAX) break;
    const el = c.el;
    const tag = el.tagName.toLowerCase();
    if (elIndex && elIndex.has(el)) continue;
    if (/^(h[1-6]|p|li|blockquote|pre|code|th|td|figcaption|strong|em)$/.test(tag)) {
      const t = clipped(el.innerText || el.textContent, 120);
      if (t) dom.push({ tag, depth: depthOf(el), text: t, inViewport: c.inVp });
    }
  }
  return { elements, dom, url: location.href, title: document.title,
    truncated: elements.length >= MAX_ELEMENTS || dom.length >= DOM_MAX,
    domTruncated: dom.length >= DOM_MAX };
})`;

interface SnapElement {
  tag: string; role: string; name: string; text: string; value: string;
  selector: string; rect: { x: number; y: number; w: number; h: number; width?: number; height?: number }; inViewport: boolean;
  /** 快照新字段(形态来源: ZCode/packages/shared/src/browser-use/snapshot.ts element):disabled/checked(有才带)、xpath、attributes(白名单)、parentRef(采集层=elements 下标,渲染层替换成 e 号)。 */
  xpath?: string;
  disabled?: boolean;
  checked?: boolean;
  attributes?: Record<string, string>;
  parentRef?: number;
}
interface SnapResult {
  elements: SnapElement[];
  dom: Array<{ tag: string; depth?: number; text: string; inViewport: boolean; ref?: number }>;
  url: string; title: string; truncated: boolean;
  /** dom 节点超内部预算时置 true(形态来源: ZCode snapshot.ts domTruncated)。 */
  domTruncated?: boolean;
  /** aria 结构文本(playwright ≥1.49 ariaSnapshot;取不到则缺省,主流程不受影响)。 */
  aria?: string;
}

interface BBox { x: number; y: number; width: number; height: number }
/** locator 探针面:方法按名取用(callLoc),避免为每个 Playwright 方法写一份可写签名。 */
type LocatorProbe = Record<string, unknown>;

/* ───────── 坐标反查脚本(形态来源: ZCode/packages/desktop/src/main/browserView/browserCommandScripts.ts ELEMENT_AT_POINT_SCRIPT)
 * document.elementFromPoint(x,y) 命中元素 → {tag,role,name,text,selector,rect,attributes(白名单键)};
 * attributes 只收白名单(href/src/type/placeholder/value/id/data-testid),避免键值面失控。 */
const ELEMENT_AT_POINT = String.raw`
(x, y) => (() => {
  const el = document.elementFromPoint(x, y);
  if (!el || el.nodeType !== 1) return null;
  const clipped = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 12) {
      let seg = cur.tagName.toLowerCase();
      if (seg === "html" || seg === "body") break;
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(">");
  };
  const INTERACTIVE = new Set(["a", "button", "input", "select", "textarea", "summary", "option", "label"]);
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (!INTERACTIVE.has(tag)) return "";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "button" || ty === "submit" || ty === "reset") return "button";
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    return tag;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
    if (aria) return clipped(aria, 80);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.type === "submit" || el.type === "button") return clipped(el.value, 80);
      const lab = document.querySelector('label[for="' + (el.id || "") + '"]');
      if (lab) return clipped(lab.textContent, 80);
      return clipped(el.placeholder, 80);
    }
    return clipped(el.innerText || el.textContent, 80);
  };
  const ATTR_KEYS = ["href", "src", "type", "placeholder", "value", "id", "data-testid"];
  const attributes = {};
  for (const k of ATTR_KEYS) {
    const v = el.getAttribute ? el.getAttribute(k) : null;
    if (v != null && v !== "") attributes[k] = clipped(v, 120);
  }
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: nameOf(el),
    text: clipped(el.innerText || el.textContent, 80),
    selector: cssPath(el),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    attributes,
  };
})()`;

interface ElementInfo {
  tag: string; role: string; name: string; text: string;
  selector: string; rect: { x: number; y: number; w: number; h: number };
  attributes: Record<string, string>;
}

interface PageLike {
  goto: (u: string, o?: unknown) => Promise<unknown>;
  goBack?: (o?: unknown) => Promise<unknown>;
  goForward?: (o?: unknown) => Promise<unknown>;
  reload?: (o?: unknown) => Promise<unknown>;
  title: () => Promise<string>;
  url: () => string;
  evaluate: <T>(fn: string) => Promise<T>;
  close: () => Promise<void>;
  bringToFront?: () => Promise<void>;
  waitForLoadState: (s: string, o?: unknown) => Promise<void>;
  screenshot: (o: unknown) => Promise<Buffer>;
  locator: (sel: string) => LocatorProbe;
 /* playwright 通道(op=locator 的 getBy* 家族与 waitForURL;可选——探针页未实现时如用户反馈不支持)。 */
  getByRole?: (role: string, o?: { name?: string; exact?: boolean }) => LocatorProbe;
  getByText?: (t: string, o?: { exact?: boolean }) => LocatorProbe;
  getByLabel?: (t: string, o?: { exact?: boolean }) => LocatorProbe;
  getByPlaceholder?: (t: string, o?: { exact?: boolean }) => LocatorProbe;
  getByTestId?: (id: string) => LocatorProbe;
  getByAltText?: (t: string, o?: { exact?: boolean }) => LocatorProbe;
  getByTitle?: (t: string, o?: { exact?: boolean }) => LocatorProbe;
  waitForURL?: (u: string | RegExp, o?: unknown) => Promise<void>;
  viewportSize?: () => { width: number; height: number } | null;
  setViewportSize?: (s: { width: number; height: number }) => Promise<void>;
  waitForTimeout?: (ms: number) => Promise<void>;
  on?: (ev: string, fn: (...a: unknown[]) => void) => void;
  off?: (ev: string, fn: (...a: unknown[]) => void) => void;
  mouse: {
    click: (x: number, y: number, o?: unknown) => Promise<void>;
    move: (x: number, y: number, o?: unknown) => Promise<void>;
    down: (o?: unknown) => Promise<void>;
    up: (o?: unknown) => Promise<void>;
    wheel: (x: number, y: number) => Promise<void>;
  };
  keyboard: {
    press: (k: string) => Promise<void>;
    type: (t: string, o?: unknown) => Promise<void>;
    down: (k: string) => Promise<void>;
    up: (k: string) => Promise<void>;
  };
}

interface DialogHandle {
  accept: (o?: { promptText?: string }) => Promise<void>;
  dismiss: () => Promise<void>;
}

/** 最近一条未处理 JS 弹窗(alert/confirm/prompt/beforeunload)。形态来源: ZCode/packages/shared/src/browser-use/commands.ts(getDialog/handleDialog)。 */
interface DialogEntry { type: string; message: string; defaultValue: string; handle: DialogHandle }

interface TabEntry {
  id: string;
  page: PageLike;
  lastActive: number;
  url: string;
  title: string;
  /** 最近一次 snapshot 的 ref→selector 映射 + 快照时 URL(ref 随导航失效)。 */
  refs: Map<string, RefEntry>;
  refsUrl: string;
  /** tab 创建时的初始视口(viewport_reset 恢复用)。 */
  viewport0: { width: number; height: number };
  /** 最近一条未处理 JS 弹窗(page.on("dialog") 缓存;handleDialog 后清空)。 */
  dialog: DialogEntry | null;
  /** dialog listener 是否已挂(newTab/openInTab 双处幂等挂载,防首弹窗丢失)。 */
  dialogHooked: boolean;
  /** elementInfo 坐标反查分配的 p<N> 序号。 */
  ptSeq: number;
  /** tab 生命周期(形态来源: ZCode 跨进程请求表口径,本仓裁成单池标记):
   * active=在用(缺省);deliverable=已备妥待交付(面板/用户可看);handoff=已移交(待用户接管,listUserTabs 可见)。 */
  lifecycle: "active" | "deliverable" | "handoff";
  /** tab 归属(2026-11 browser-ux-redo):人类视图="human",agent 侧=调用方 owner(缺省 "agent")。
   * 缺省选 tab / close 越权判定都按 owner 隔离,人机互不抢。 */
  owner: string;
  /** 历史位置(host 侧自维护,getState 的 canGoForward 用):navIndex 当前位, navLen 历史条目数。 */
  navIndex: number;
  navLen: number;
  /** 最近一次快照结果(open/navigate 自动快照后供摘要复用,避免同一次操作重复拍)。 */
  lastSnap?: SnapResult;
}

interface BrowserLike {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
  contexts?: unknown[];
}

const TAB_IDLE_MS = 10 * 60_000;
/** idle 回收阈值缺省(分钟):cfg.idleMinutes 未提供时用它。 */
const DEFAULT_IDLE_MINUTES = 30;
/** 持久 profile 缺省目录(相对 root)。 */
const DEFAULT_PROFILE_DIR = ".genie/browser-profile";
/** Chrome 探测链(2026-11):CHROME_PATH 优先,其次系统常见安装点;全无=undefined(交 playwright-core 自带)。 */
const CHROME_CANDIDATES = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const CHROME_HINT = "安装 Chrome 或设置 CHROME_PATH 指向 Chrome/Chromium 可执行文件";

/** 探测链纯函数(injectable,便于单测):CHROME_PATH(显式配置优先,即使不存在也照用)→ 系统常见路径 → undefined。 */
export const resolveChromePath = (env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined => {
  const explicit = String(env.CHROME_PATH ?? "").trim();
  if (explicit) return explicit;
  for (const p of CHROME_CANDIDATES) if (exists(p)) return p;
  return undefined;
};

/** profile 目录绝对化(相对 root;绝对路径原样)。 */
const resolveProfileDir = (root: string, cfg: BrowserToolConfig): string => {
  const raw = cfg.profileDir?.() ?? DEFAULT_PROFILE_DIR;
  return isAbsolute(raw) ? raw : join(root, raw);
};

/** 启动参数的纯函数面(g):profile=persistent 走 launchPersistentContext,ephemeral 走 launch。 */
export const browserLaunchPlan = (root: string, cfg: BrowserToolConfig, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync) => ({
  mode: (cfg.profile?.() ?? "persistent") === "ephemeral" ? ("ephemeral" as const) : ("persistent" as const),
  headless: cfg.headless?.() ?? true,
  profileDir: resolveProfileDir(root, cfg),
  executablePath: resolveChromePath(env, exists),
});

/** idle 阈值(分钟)解析:cfg 优先,clamp 1..240,缺省 30。 */
export const idleMinutesOf = (cfg: BrowserToolConfig): number => {
  const n = Number(cfg.idleMinutes?.() ?? DEFAULT_IDLE_MINUTES);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 240) : DEFAULT_IDLE_MINUTES;
};

const ARIA_LIMIT = 4000;
const ACT_OPS = new Set(["click", "dblclick", "fill", "type", "press", "hover", "check", "uncheck",
  "selectOption", "waitFor", "count", "getAttribute", "innerText", "textContent", "allTextContents", "isVisible", "isEnabled"]);

/* ───────── 模块级共享浏览器池(面板视图与 agent 同池才能人机同看) ───────── */
let sharedBrowser: BrowserLike | null = null;
let sharedLaunching: Promise<void> | null = null;
let sharedTabSeq = 0;
const sharedTabs = new Map<string, TabEntry>();
let exitHooked = false;

/** 正被浏览器视图订阅的 tab(2026-11):reapIdle 跳过它们——人正看着的页不被后台回收。
 * hub bind 时加,stop/unsubscribe 时删。 */
const subscribedTabIds = new Set<string>();

/* 会话最小面(第二批之二):键=tab 所在池;本仓单池,固定 "default"。形态来源: ZCode 跨进程会话表,裁成内存元数据。 */
const SESSION_POOL = "default";
const sessionMeta = new Map<string, { name?: string; turn?: number }>();

/** 关浏览器只关一次:多个 createBrowserTool 实例共用同一池,重复注册会重复 close。 */
const hookExit = () => {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => { if (sharedBrowser) void sharedBrowser.close().catch(() => {}); });
};

/** idle 回收:超阈值无活动的 tab 关闭(跳过正被视图订阅的 tab);tab 全空时连 browser 一起关(下次再拉)。 */
const reapIdle = (cfg: BrowserToolConfig) => {
  const now = Date.now();
  const idleMs = idleMinutesOf(cfg) * 60_000;
  for (const [id, t] of sharedTabs) {
    if (subscribedTabIds.has(id)) continue;
    if (now - t.lastActive > idleMs) {
      sharedTabs.delete(id);
      void t.page.close().catch(() => {});
    }
  }
  if (!sharedTabs.size && sharedBrowser) {
    const b = sharedBrowser; sharedBrowser = null;
    void b.close().catch(() => {});
  }
};

const ensureBrowser = async (root: string, cfg: BrowserToolConfig): Promise<BrowserLike> => {
  if (sharedBrowser) return sharedBrowser;
  if (!sharedLaunching) {
    sharedLaunching = (async () => {
      const mod = (await import("playwright-core")) as unknown as {
        chromium: {
          launch: (o: unknown) => Promise<BrowserLike>;
          launchPersistentContext: (dir: string, o: unknown) => Promise<BrowserLike>;
        };
      };
      const plan = browserLaunchPlan(root, cfg);
      const launchOpts = {
        headless: plan.headless,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...(plan.executablePath ? { executablePath: plan.executablePath } : {}),
      };
      /* 持久 profile:登录态跨重启保留;启动失败(锁冲突/目录不可写)→ 回退临时 profile,如实提示。 */
      if (plan.mode === "persistent") {
        try {
          mkdirSync(plan.profileDir, { recursive: true });
          const ctx = await mod.chromium.launchPersistentContext(plan.profileDir, launchOpts);
          sharedBrowser = {
            newPage: () => ctx.newPage(),
            close: async () => { await ctx.close(); },
            contexts: [ctx],
          };
          hookExit();
          return;
        } catch (err) {
          console.warn(`[browser] 持久 profile 启动失败(${plan.profileDir}):${String(err).slice(0, 200)};回退临时 profile(登录态不保留)`);
        }
      }
      try {
        sharedBrowser = await mod.chromium.launch(launchOpts);
      } catch (err) {
        throw new Error(`浏览器启动失败:${String(err).slice(0, 200)}(${CHROME_HINT})`);
      }
      hookExit();
    })().finally(() => { sharedLaunching = null; });
  }
  await sharedLaunching;
  return sharedBrowser!;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" && isFinite(v) ? Math.round(v) : dflt;
  return Math.min(Math.max(n, lo), hi);
};

/** locator 方法统一调用点(apply 绑定接收者——裸调用丢 this 会报 _frame undefined)。 */
const callLoc = (loc: LocatorProbe, method: string, ...xs: unknown[]): Promise<unknown> => {
  const fn = loc[method];
  if (typeof fn !== "function") return Promise.reject(new Error(`locator 不支持 ${method}`));
  return (fn as (...x: unknown[]) => Promise<unknown>).apply(loc, xs);
};

/** locator 链构造(first/last/nth/filter 返回新 locator,同步):与 callLoc 同口径做存在性校验。 */
const callLocSync = (loc: LocatorProbe, method: string, ...xs: unknown[]): LocatorProbe => {
  const fn = loc[method];
  if (typeof fn !== "function") throw new Error(`locator 不支持 ${method}(chain 构造失败)`);
  return (fn as (...x: unknown[]) => LocatorProbe).apply(loc, xs);
};

/* playwright 通道常量(形态来源: ZCode/apps/zcode-cli/packages/core/src/browser-client/playwright.ts
 * 447-585 getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/getByAltText/getByTitle/first/last/nth/filter)。 */
const PW_STEP_BYS = ["role", "text", "label", "placeholder", "testid", "alt", "title"];
const PW_THEN_OPS = ["click", "fill", "type", "press", "hover", "check", "uncheck", "selectOption",
  "textContent", "innerText", "getAttribute", "isVisible", "isEnabled", "count", "screenshot"];

/** 最近活跃 tab:给了 owner 优先返回该 owner 的最近 tab,否则回落全局最近(人机互不抢的缺省选点)。 */
const mostRecentTab = (owner?: string): TabEntry | null => {
  let best: TabEntry | null = null;
  let scoped: TabEntry | null = null;
  for (const t of sharedTabs.values()) {
    if (!best || t.lastActive > best.lastActive) best = t;
    if (owner && t.owner === owner && (!scoped || t.lastActive > scoped.lastActive)) scoped = t;
  }
  return scoped ?? best;
};

/** SPA 渲染轮询(沿用 用户经验证口径):正文非空即停,最多 ~9s,仍空如用户反馈空。 */
const waitForBody = async (page: PageLike) => {
  for (let i = 0; i < 30; i++) {
    const len = Number(await page.evaluate<number>("(() => document.body ? document.body.innerText.trim().length : 0)()").catch(() => 0));
    if (len > 0) return;
    await sleep(300);
  }
};

const gotoWithLoad = async (page: PageLike, url: string, timeoutMs = 20_000) => {
  await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
};

/** 新 tab 注册(或复用 entry)并完成导航。 */
const openInTab = async (entry: TabEntry, url: string): Promise<TabEntry> => {
  hookDialogListener(entry);
  await gotoWithLoad(entry.page, url);
  await waitForBody(entry.page);
  entry.url = entry.page.url();
  entry.title = await entry.page.title().catch(() => "");
  entry.lastActive = Date.now();
  navPushed(entry);
  /* 自动快照(2026-11 browser-ux-redo):开完即填 refs/hitRegions,人类视图与 agent 都不用先手动 snapshot。 */
  await autoSnapshot(entry);
  return entry;
};

const newTab = async (root: string, cfg: BrowserToolConfig, owner: string): Promise<TabEntry> => {
  const b = await ensureBrowser(root, cfg);
  const page = await b.newPage();
  const id = "t" + ++sharedTabSeq;
  const entry: TabEntry = { id, page, lastActive: Date.now(), url: "about:blank", title: "",
    refs: new Map(), refsUrl: "",
    viewport0: viewportOf(page), dialog: null, dialogHooked: false, ptSeq: 0, lifecycle: "active",
    owner, navIndex: 0, navLen: 0 };
  sharedTabs.set(id, entry);
  /* dialog listener 必须在 page 创建即挂(getDialog 契约):否则首弹窗(page 阻塞在 dialog 上)会丢。 */
  hookDialogListener(entry);
  return entry;
};

/**
 * JS 弹窗缓存:page.on("dialog") 只缓存最近一条,不 auto-dismiss(留 handle 给 handleDialog)。
 * 幂等:entry.dialogHooked 防重复挂载(复用 tab 的 openInTab 与 newTab 双路径)。
 */
function hookDialogListener(entry: TabEntry): void {
  if (entry.dialogHooked) return;
  if (typeof entry.page.on !== "function") return;
  try {
    entry.page.on("dialog", (d: unknown) => {
      const dlg = d as { type?: () => string; message?: () => string; defaultValue?: () => string; accept?: (o?: { promptText?: string }) => Promise<void>; dismiss?: () => Promise<void> };
      entry.dialog = {
        type: String((typeof dlg.type === "function" ? dlg.type() : (dlg as { type?: string }).type) ?? "dialog"),
        message: String((typeof dlg.message === "function" ? dlg.message() : (dlg as { message?: string }).message) ?? ""),
        defaultValue: String((typeof dlg.defaultValue === "function" ? dlg.defaultValue() : (dlg as { defaultValue?: string }).defaultValue) ?? ""),
        handle: {
          accept: async (o?: { promptText?: string }) => {
            const fn = dlg.accept;
            if (typeof fn !== "function") return;
            await fn.call(dlg, o).catch(() => {});
          },
          dismiss: async () => {
            const fn = dlg.dismiss;
            if (typeof fn !== "function") return;
            await fn.call(dlg).catch(() => {});
          },
        },
      };
    });
    entry.dialogHooked = true;
  } catch { /* 探针页不支持事件:留 false,getDialog/handleDialog 如用户反馈无监听 */ }
}

/** 默认 tab = 最近活跃(owner 给了优先该 owner 的最近 tab);也可显式 tabId。找不到给可操作错误(带在场 tab 清单)。 */
const resolveTab = (tabId: unknown, owner?: string): TabEntry | null => {
  if (typeof tabId === "string" && tabId) {
    const t = sharedTabs.get(tabId);
    if (t) { t.lastActive = Date.now(); return t; }
    return null;
  }
  const best = mostRecentTab(owner);
  if (best) best.lastActive = Date.now();
  return best;
};

/** tabs 清单(详化):每行 `* t1 active <owner> <title> <url>`;`*` 前缀 + active/idle 字段双标记,
 * owner 列(2026-11 browser-ux-redo)标归属("human"/"agent" 等),人机抢 tab 时一眼可见。
 * 生命周期标记(第二批之二):deliverable/handoff 的 tab 行尾追加 `[deliverable]`/`[handoff]`(active 缺省不标)。 */
const tabsLine = (owner?: string): string => {
  const active = mostRecentTab(owner);
  const lines = Array.from(sharedTabs.values()).map((t) => {
    const isActive = active?.id === t.id;
    const mark = t.lifecycle === "deliverable" ? "  [deliverable]" : t.lifecycle === "handoff" ? "  [handoff]" : "";
    return `${isActive ? "*" : " "} ${t.id}  ${isActive ? "active" : "idle"}  ${t.owner || "agent"}  ${t.title.slice(0, 40)}  ${t.url.slice(0, 100)}${mark}`;
  });
  return lines.join("\n") || "(无在场 tab)";
};

/** 快照采集参数:maxElements=元素预算(clamp 10..300,缺省 300;真实站点首屏可交互目标远超 120);includeHidden=true 放宽 visibility/opacity 判定(display:none 仍排除)。 */
interface SnapOpts { maxElements?: number; includeHidden?: boolean }

const takeSnapshot = async (entry: TabEntry, opts?: SnapOpts): Promise<SnapResult> => {
  const maxE = clampInt(opts?.maxElements, 10, 300, 300);
  const incl = opts?.includeHidden === true;
  const snap = await entry.page.evaluate<SnapResult>(`(${COLLECT_SNAPSHOT})(${maxE}, ${incl})`);
  entry.refs = buildRefMap(snap.elements);
  entry.refsUrl = entry.page.url();
  entry.url = entry.refsUrl;
  entry.title = snap.title;
  /* aria 树(playwright ≥1.49 body.ariaSnapshot):失败静默降级,不影响主流程。 */
  try {
    const loc = entry.page.locator("body");
    const fn = loc["ariaSnapshot"];
    if (typeof fn === "function") {
      const text = String((await (fn as () => Promise<string>).call(loc)) ?? "");
      if (text.trim()) snap.aria = text.slice(0, ARIA_LIMIT);
    }
  } catch { /* 静默降级 */ }
  entry.lastSnap = snap;
  return snap;
};

/* ───────── 历史位置维护(host 侧自维护,getState.canGoForward 的依据) ─────────
 * goto/新导航 = 追加一条历史(截断 forward);back/forward 移动游标;reload 不变。 */
const navPushed = (entry: TabEntry): void => {
  entry.navIndex = Math.max(0, entry.navIndex) + 1;
  entry.navLen = entry.navIndex + 1;
};
const navBack = (entry: TabEntry): void => {
  entry.navIndex = Math.max(0, entry.navIndex - 1);
  if (entry.navLen < entry.navIndex + 1) entry.navLen = entry.navIndex + 1;
};
const navForward = (entry: TabEntry): void => {
  if (entry.navIndex < entry.navLen - 1) entry.navIndex += 1;
};

/** open/navigate 后的自动快照(2026-11 browser-ux-redo):复用 takeSnapshot 填 refs/refsUrl。
 * 节流:同 URL 且 refs 非空 → 跳过(返回 null);失败静默(不改命令返回文本,不破既有断言)。 */
const autoSnapshot = async (entry: TabEntry): Promise<SnapResult | null> => {
  try {
    const cur = entry.page.url();
    if (entry.refsUrl === cur && entry.refs.size > 0) return null;
    return await takeSnapshot(entry);
  } catch { return null; }
};

const ariaBlock = (s: SnapResult): string =>
  s.aria ? `\n--- aria 树(截断 ${s.aria.length} 字符)---\n${s.aria}` : "";

const renderSnapshot = (s: SnapResult, entry: TabEntry, maxElements = 120, withHeader = true): string => {
  /* 编号与 buildRefMap 同口径:selector 为空的元素不可定位,跳过且不占号(显示号 == ref 号)。 */
  const lines: string[] = [];
  /* 发号表:elements 下标 → e 号(dom 节点 ref 与行内 parentRef 都靠它换号)。 */
  const refOfIndex = new Map<number, string>();
  let n = 0;
  for (const el of s.elements) {
    if (!String(el.selector ?? "").trim()) continue;
    n += 1;
    if (n > maxElements) break;
    refOfIndex.set(s.elements.indexOf(el), `e${n}`);
  }
  n = 0;
  for (const el of s.elements) {
    if (!String(el.selector ?? "").trim()) continue;
    n += 1;
    if (n > maxElements) break;
    const bits = [`e${n}`, el.tag];
    if (el.role && el.role !== el.tag) bits.push(`role=${el.role}`);
    if (el.name) bits.push(`"${el.name}"`);
    if (el.value) bits.push(`val="${el.value.slice(0, 30)}"`);
    bits.push(`@${el.rect.x},${el.rect.y}`);
    if (!el.inViewport) bits.push("(视口外)");
    /* 状态位行内追加(@x,y 与 (视口外) 之后,不动既有行形态);父 ref 号 ^eN 随行尾出现。 */
    if (el.disabled === true) bits.push("[disabled]");
    if (el.checked === true) bits.push("[checked]");
    if (el.parentRef != null) {
      const pRef = refOfIndex.get(el.parentRef);
      if (pRef) bits.push(`^${pRef}`);
    }
    lines.push(bits.join(" "));
  }
  const els = lines.join("\n");
  /* dom 节点:带 ref 的(与 elements 同元素)行内追加 [ref=eN]。 */
  const dom = s.dom.slice(0, 80).map((d) => {
    const r = d.ref != null ? refOfIndex.get(d.ref) : undefined;
    return r ? `${d.tag}: ${d.text} [ref=${r}]` : `${d.tag}: ${d.text}`;
  }).join("\n");
  return (withHeader ? `[tab ${entry.id}] ${s.title} | ${s.url}` : "") +
    (s.truncated ? "\n(元素/正文超过预算已截断,可滚动后重新 snapshot)" : "") +
    (els ? `\n可交互元素(ref 定位,act 用):\n${els}` : "\n(无可交互元素)") +
    (dom ? `\n正文语义节点:\n${dom}` : "") +
    (s.domTruncated ? "\n(正文语义节点超预算已截断 domTruncated=true)" : "") +
    ariaBlock(s);
};

const bodyText = async (entry: TabEntry, max: number): Promise<string> => {
  const text = String(await entry.page.evaluate<string>("(() => document.body ? document.body.innerText : '')()") || "");
  return text.replace(/[ \t]+/g, " ").slice(0, max);
};

/** shot 出文(面板预览):路径行之外附 markdown 图片行——面板 mdToHtml 渲染 /uploads? 白名单 src;
 * 工具描述引导模型把该行原样保留进最终汇报,聊天流里即出截图预览。screenshots 复用同一格式。 */
const shotOutput = (f: string, entry: TabEntry): string => {
  const md = "![浏览器截图 " + entry.id + "](/uploads?path=" + encodeURIComponent(f) + ")";
  return `截图已存:${f}(tab ${entry.id} ${entry.title})\n${md}`;
};

const saveShot = async (root: string, entry: TabEntry, fullPage: boolean, pathHint?: string, clip?: BBox): Promise<string> => {
  const dir = join(root, ".genie", "browser-shots");
  mkdirSync(dir, { recursive: true });
  const hint = pathHint ? basename(String(pathHint)) : "";
  const name = hint ? (/\.[a-z0-9]+$/i.test(hint) ? hint : hint + ".png") : `shot-${entry.id}-${Date.now()}.png`;
  const f = join(dir, name);
  /* 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(screenshot 的 clip 区域截图,与 fullPage 互斥)。 */
  writeFileSync(f, await entry.page.screenshot(clip ? { clip } : { fullPage }));
  return shotOutput(f, entry);
};

/** clip 参数解析:{x,y,width,height}(正宽高)。非法返回 null(忽略,退回整页)。 */
const parseClip = (raw: unknown): BBox | null => {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const x = Number(c.x); const y = Number(c.y); const width = Number(c.width); const height = Number(c.height);
  if (![x, y, width, height].every((v) => isFinite(v))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
};

/** 元素截图落盘:locator.screenshot 已产出 Buffer,只做命名/写盘/markdown 行(与 saveShot 同口径)。 */
const saveShotBuf = (root: string, entry: TabEntry, buf: Buffer, pathHint?: string): string => {
  const dir = join(root, ".genie", "browser-shots");
  mkdirSync(dir, { recursive: true });
  const hint = pathHint ? basename(String(pathHint)) : "";
  const name = hint ? (/\.[a-z0-9]+$/i.test(hint) ? hint : hint + ".png") : `shot-${entry.id}-${Date.now()}.png`;
  const f = join(dir, name);
  writeFileSync(f, buf);
  return shotOutput(f, entry);
};

/* ───────── modifiers(形态来源: ZCode/packages/shared/src/browser-use/commands.ts browserKeyModifierSchema) ─────────
 * 值域固定 Alt/Control/ControlOrMeta/Meta/Shift(Playwright 原生 click/hover/press/dragTo 的 modifiers 参数);
 * 非法值丢弃不报错(命令面 fail-soft),空数组/全非法 → undefined(不传参)。 */
const MODIFIER_SET = new Set(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]);
const parseModifiers = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const mods = raw.map((v) => String(v)).filter((v) => MODIFIER_SET.has(v));
  return mods.length ? mods : undefined;
};
/** modifiers 并入 playwright options 对象(undefined 时保持原对象形态,便于探针断言透传)。 */
const withMods = (opts: Record<string, unknown>, mods: string[] | undefined): Record<string, unknown> =>
  mods ? { ...opts, modifiers: mods } : opts;

/** ref 失败说明:URL 变了(导航)→ 过期;否则查 ref 表(文案沿用旧口径,面板/日志断言依赖)。 */
const refErr = (entry: TabEntry, ref: string): string => {
  const current = entry.page.url();
  if (refsStale(entry.refsUrl, current)) {
    return `ref 已过期(页面已导航 ${entry.refsUrl} → ${current}),请重新 action=snapshot`;
  }
  const r = resolveRef(entry.refs, ref);
  return r.ok ? "" : r.error;
};

/** ref|selector 二选一取目标 selector;sSelector 优先(ref 存在时先查过期)。 */
const targetSelector = (entry: TabEntry, a: Record<string, unknown>): { ok: true; selector: string } | { ok: false; error: string } => {
  const sel = typeof a.selector === "string" ? a.selector.trim() : "";
  if (sel) return { ok: true, selector: sel };
  const ref = typeof a.ref === "string" ? a.ref.trim() : "";
  if (!ref) return { ok: false, error: "需要 selector 或 ref(来自 snapshot 的 e1..eN)" };
  const err = refErr(entry, ref);
  if (err) return { ok: false, error: err };
  const r = resolveRef(entry.refs, ref);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, selector: r.selector };
};

const centerOf = async (page: PageLike, selector: string): Promise<{ x: number; y: number }> => {
  const bb = (await callLoc(page.locator(selector), "boundingBox")) as BBox | null;
  if (!bb) throw new Error(`元素无可定位包围盒:${selector}`);
  return { x: Math.round(bb.x + bb.width / 2), y: Math.round(bb.y + bb.height / 2) };
};

const waitUntil = async (pred: () => Promise<boolean>, timeoutMs: number, interval = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await pred().catch(() => false);
    if (hit) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(interval, left));
  }
};

const isFileDragArg = (a: Record<string, unknown>): boolean => {
  for (const k of Object.keys(a)) if (/file/i.test(k)) return true;
  const specs = [a.from, a.to];
  for (const s of specs) {
    if (s && typeof s === "object" && typeof (s as Record<string, unknown>).selector === "string") {
      if (/input\s*\[\s*type\s*=\s*["']?file/i.test(String((s as Record<string, unknown>).selector))) return true;
    }
  }
  return false;
};

/** 坐标点解析:cua 旧形态 [x1,y1,...] 与 ZCode 形态 [{x,y},...] 都收。 */
const parsePath = (raw: unknown): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  if (!Array.isArray(raw)) return out;
  if (raw.every((v) => v && typeof v === "object")) {
    for (const p of raw as Array<Record<string, unknown>>) {
      const x = Number(p.x); const y = Number(p.y);
      if (isFinite(x) && isFinite(y)) out.push({ x, y });
    }
    return out;
  }
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const x = Number(raw[i]); const y = Number(raw[i + 1]);
    if (isFinite(x) && isFinite(y)) out.push({ x, y });
  }
  return out;
};

/* ───────── 结构化错误码(形态来源: ZCode/packages/shared/src/browser-use/command-metadata.ts browserErrorCodeSchema :144-154)
 * 本仓只取 6 值;cancelled/renderer_unreachable/duplicate_request_id 在单进程直连池场景不存在,不设码。
 * 第二行 `code=<k> sideEffect=<none|uncertain>` 由 classifyError 统一追加,第一行中文文本保持不变。 */
const BROWSER_ERROR_CODES: Record<string, string> = {
  backend_unavailable: "浏览器后端不可用(未启用/启动失败)",
  capability_unsupported: "命令面不支持/白名单/禁用面(下载/文件选择/domSnapshot 等)",
  ref_not_found: "ref 过期或不存在(重新 action=snapshot)",
  navigation_blocked: "域名门禁拒绝(allowDomains 白名单)",
  timeout: "等待/定位超时",
  execution_error: "其余执行错误(默认)",
};

/** 错误文本 → code 映射(优先级:命令面/禁用面 > 域名门禁 > ref > 超时 > 后端 > 兜底 execution_error)。
 * tab 定位失败(不存在/无可用)归 ref_not_found;timeout 用负向断言避开 cancelRequest 文案里的 timeoutMs。 */
const classifyError = (text: string): string => {
  if (/白名单外|禁用\/不适用|不支持|仅支持|取消不适用|未知 (action|op|cua op)|缺少/.test(text)) return "capability_unsupported";
  if (/域名不在白名单/.test(text)) return "navigation_blocked";
  if (/ref 已过期|未知 ref|ref 为空|多 ref|tab.+不存在/.test(text)) return "ref_not_found";
  if (/timeout(?!ms)|超时/i.test(text)) return "timeout";
  if (/未启用/.test(text)) return "backend_unavailable";
  return "execution_error";
};

/** 只读类命令失败可确定无副作用;其余(navigate/act/cua/drag/select/press/type/click/hover/scroll/close/open 等
 * 改页面状态的动作)失败一律 uncertain(动作可能已部分生效)。 */
const READONLY_ACTIONS = new Set(["snapshot", "getState", "tabs", "wait", "wait_for", "list", "elementInfo",
  "text", "eval", "capabilities", "getDialog", "viewport_get",
  "markDeliverable", "markHandoff", "claimTab", "listUserTabs",
  "nameSession", "turnEnded", "closeSession", "sessionInfo", "cancelRequest"]);
/** playwright 通道里会改页面状态的 then op(与 ACT_OPS 中动作类对齐);其余 then(count/textContent/…)只读。 */
const PW_MUTATING_THEN = new Set(["click", "dblclick", "fill", "type", "press", "hover", "check", "uncheck", "selectOption"]);

/** 失败副作用判定:只读类=none;playwright 按 then op 分流;其余=uncertain。 */
const sideEffectOf = (args: unknown): "none" | "uncertain" => {
  const a = (args ?? {}) as Record<string, unknown>;
  const action = String(a.action ?? "open");
  if (action === "playwright") {
    const then = (a.then && typeof a.then === "object" ? a.then : {}) as Record<string, unknown>;
    return PW_MUTATING_THEN.has(String(then.op ?? "")) ? "uncertain" : "none";
  }
  return READONLY_ACTIONS.has(action) ? "none" : "uncertain";
};

/**
 * 唯一动作执行入口:execute 与 hub.runViewCommand 共用(避免面板命令面与工具命令面漂移)。
 * fail-soft:所有错误返回 `[browser]`/`[browser 失败]` 文本,不抛。
 * 错误统一出口:第一行中文文本不变,第二行追加 `code=<k> sideEffect=<none|uncertain>`;
 * 成功回执耗时>200ms 时尾追加 ` elapsedMs=<n>`。`/^\[browser( 失败)?\]/` 判 ok 的正则不受影响。
 */
async function runBrowserAction(root: string, cfg: BrowserToolConfig, args: unknown, owner = "agent"): Promise<string> {
  const t0 = Date.now();
  const annotate = (text: string): string => {
    if (/^\[browser( 失败)?\]/.test(text)) {
      /* 第一行中文文本不变;第二行追加 code/sideEffect;原有后续行(如在场 tab 清单)保留在码行之后。 */
      const [first, ...rest] = text.split("\n");
      const line2 = `code=${classifyError(text)} sideEffect=${sideEffectOf(args)}`;
      return rest.length ? `${first}\n${line2}\n${rest.join("\n")}` : `${first}\n${line2}`;
    }
    const elapsed = Date.now() - t0;
    return elapsed > 200 ? `${text} elapsedMs=${elapsed}` : text;
  };
  if (!cfg.enabled()) return annotate("[browser] 未启用(设置-浏览器控制 打开)");
  return annotate(await runBrowserActionCore(root, cfg, args, owner));
}

async function runBrowserActionCore(root: string, cfg: BrowserToolConfig, args: unknown, owner = "agent"): Promise<string> {
  reapIdle(cfg);
  const a = (args ?? {}) as Record<string, unknown>;
  /* 面板来的 tabId 与工具面的 tab 同义(server 侧已并入 args,这里兼容直传)。 */
  if (typeof a.tab !== "string" && typeof a.tabId === "string" && a.tabId) a.tab = a.tabId;
  const action = String(a.action ?? "open");
  const num = (v: unknown, d?: number) => (typeof v === "number" && isFinite(v) ? v : d);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  try {
    /* open/text/兼容旧 click/shot 携带 url:先走导航(域名门禁在此生效)。 */
    if (action === "open" || ((action === "text" || action === "click" || action === "shot") && str(a.url))) {
      const url = str(a.url);
      if (!/^https?:\/\//.test(url)) return "[browser] 仅支持 http/https URL";
      if (!hostAllowed(url, cfg.allowDomains())) return "[browser] 域名不在白名单:" + url;
      let entry: TabEntry | null = null;
      if (!a.newTab) {
        let host = ""; try { host = new URL(url).hostname; } catch { /* 前面已校验 */ }
        for (const t of sharedTabs.values()) {
          let th = ""; try { th = new URL(t.url).hostname; } catch { /* about:blank */ }
          /* 2026-11 browser-ux-redo 修复:同域复用只在同 owner 内进行——原先跨 owner 复用会把
           * 人类正在看的 tab 直接导航走(agent open 抢人页),与 owner 隔离/close fail-closed 自相矛盾。 */
          if (th && th === host && (t.owner || "agent") === owner) { entry = t; break; }
        }
      }
      if (!entry) entry = await newTab(root, cfg, owner);
      await openInTab(entry, url);
      if (action === "open") {
        /* 自动快照已在 openInTab 里拍过(同 URL 节流),这里复用结果,不再二次拍。 */
        const snap = entry.lastSnap ?? await takeSnapshot(entry);
        const summary = snap.dom.slice(0, 12).map((x) => x.text).join(" / ").slice(0, 300);
        return `已打开 [tab ${entry.id}] ${entry.title} | ${entry.url}\n摘要:${summary || "(空)"}` +
          renderSnapshot({ ...snap, elements: snap.elements.slice(0, 25) }, entry, 25, false) +
          `\n(完整清单 action=snapshot tab=${entry.id})`;
      }
      if (action === "click") {
        const sel = str(a.selector);
        if (!sel) return "[browser] click 需要 selector(或改用 snapshot+act ref)";
        await callLoc(entry.page.locator(sel), "click", { timeout: 10_000 });
        await sleep(400);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => "");
        return `已点击 ${sel} → ${entry.title} | ${entry.url}`;
      }
      if (action === "shot") return saveShot(root, entry, a.fullPage === true);
      /* action === "text" 且带 url:导航后落正文 */
      return "标题:" + entry.title + "\n" + (await bodyText(entry, 4000) || "(空页面)");
    }

    if (action === "tabs") {
      return sharedTabs.size ? `在场 tab:\n${tabsLine(owner)}` : "(无在场 tab,先 action=open)";
    }

    /* 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(capabilities:后端能力面自描述)。 */
    if (action === "capabilities") {
      return JSON.stringify({
        支持: ["tabs", "snapshot", "act", "cua", "hover", "drag", "select", "press", "navigate", "scroll",
          "shot", "screenshots", "text", "eval", "wait", "wait_for", "getState", "elementInfo", "dialog",
          "viewport_get/set/reset", "modifiers", "newTab", "activateTab", "playwright",
          "lifecycle: markDeliverable/markHandoff/claimTab/listUserTabs/finalize/finalizeTabs",
          "session: nameSession/turnEnded/sessionInfo/closeSession"],
        不支持: { 下载: "不实现", 文件选择: "不实现(input[type=file]/fileChooser 一律拒绝)", 录制: "不实现",
          cancelRequest: "本仓无跨进程请求表,取消不适用" },
      });
    }

    /* 形态来源: ZCode/.../commands.ts(newTab:强制新开,不复用同域 tab)。 */
    if (action === "newTab") {
      const url = str(a.url) || "about:blank";
      if (url !== "about:blank") {
        if (!/^https?:\/\//.test(url)) return "[browser] 仅支持 http/https URL";
        if (!hostAllowed(url, cfg.allowDomains())) return "[browser] 域名不在白名单:" + url;
      }
      const entry = await newTab(root, cfg, owner);
      if (url !== "about:blank") await openInTab(entry, url);
      else { entry.url = "about:blank"; await autoSnapshot(entry); }
      const snap = entry.lastSnap ?? await takeSnapshot(entry);
      const summary = snap.dom.slice(0, 12).map((x) => x.text).join(" / ").slice(0, 300);
      return `已新建 [tab ${entry.id}] ${entry.title || entry.url}\n摘要:${summary || "(空)"}` +
        renderSnapshot({ ...snap, elements: snap.elements.slice(0, 25) }, entry, 25, false) +
        `\n(完整清单 action=snapshot tab=${entry.id})`;
    }

    /* 形态来源: ZCode/.../commands.ts(activateTab:更新 scope 的 selected tab)。 */
    if (action === "activateTab") {
      const id = str(a.tab);
      const t = sharedTabs.get(id);
      if (!t) return `[browser] tab「${id || "(空)"}」不存在。在场:\n${tabsLine(owner)}`;
      t.lastActive = Date.now();
      return `已激活 tab ${t.id}`;
    }

    /* ───────── tab 生命周期(第二批之二;形态来源: ZCode 跨进程交付表口径,本仓裁成单池内存标记) ─────────
     * deliverable=已备妥待交付;handoff=已移交待用户接管(listUserTabs 列它;claimTab 收回)。
     * finalize/finalizeTabs 是唯一的批量关闭口(除 close all 外),回执带关闭清单。 */
    if (action === "markDeliverable" || action === "markHandoff") {
      const t = resolveTab(a.tab, owner);
      if (!t) return `[browser] 无可用 tab${str(a.tab) ? `(「${str(a.tab)}」不存在)` : ""}。在场:\n${tabsLine(owner)}`;
      const life = action === "markDeliverable" ? "deliverable" : "handoff";
      t.lifecycle = life;
      t.lastActive = Date.now();
      return `[tab ${t.id}] ${life} · ${t.title} | ${t.url}`;
    }

    if (action === "claimTab") {
      const id = str(a.tab);
      const t = sharedTabs.get(id);
      if (!t) return `[browser] tab「${id || "(空)"}」不存在。在场:\n${tabsLine(owner)}`;
      if (t.lifecycle !== "handoff") return `[browser] tab ${t.id} 非 handoff(当前 ${t.lifecycle}),claimTab 只收回已移交 tab`;
      t.lifecycle = "active";
      t.lastActive = Date.now();
      return `[tab ${t.id}] active · ${t.title} | ${t.url}`;
    }

    if (action === "listUserTabs") {
      const rows = Array.from(sharedTabs.values()).filter((t) => t.lifecycle === "handoff");
      if (!rows.length) return "(无待接管 tab)";
      return "待接管 tab(handoff):\n" + rows.map((t) => `- ${t.id}  ${t.title.slice(0, 40)}  ${t.url.slice(0, 100)}`).join("\n");
    }

    if (action === "finalize" || action === "finalizeTabs") {
      /* keep 表:finalize=纯 tabId 列表(保留不改状态);finalizeTabs=[{tab,status}](保留并置标记)。 */
      let keepIds: string[] = [];
      const statusOf = new Map<string, "deliverable" | "handoff">();
      if (action === "finalizeTabs") {
        const rows = Array.isArray(a.keep) ? (a.keep as Array<Record<string, unknown>>) : [];
        for (const r of rows) {
          const id = str(r?.tab);
          if (!id) continue;
          keepIds.push(id);
          if (r.status === "deliverable" || r.status === "handoff") statusOf.set(id, r.status);
        }
      } else {
        keepIds = (Array.isArray(a.keep) ? a.keep : []).map((v) => str(v)).filter(Boolean);
      }
      keepIds = Array.from(new Set(keepIds));
      const closed: string[] = [];
      for (const [id, t] of Array.from(sharedTabs)) {
        if (keepIds.includes(id)) {
          const st = statusOf.get(id);
          if (st) t.lifecycle = st;
          continue;
        }
        sharedTabs.delete(id);
        void t.page.close().catch(() => {});
        closed.push(id);
      }
      if (!sharedTabs.size && sharedBrowser) { const b = sharedBrowser; sharedBrowser = null; void b.close().catch(() => {}); }
      const kept = keepIds.filter((id) => sharedTabs.has(id));
      return `已 finalize:关闭 [${closed.join(", ")}]${closed.length ? "" : "(无)"},保留 [${kept.join(", ")}]${kept.length ? "" : "(无)"}`;
    }

    /* ───────── 会话最小面(第二批之二):单池("default")会话元数据 + 跨进程请求面的如实拒绝 ───────── */
    if (action === "nameSession") {
      const name = str(a.name);
      if (!name) return "[browser] nameSession 需要 name";
      sessionMeta.set(SESSION_POOL, { ...sessionMeta.get(SESSION_POOL), name: name.slice(0, 120) });
      return `会话已命名:${sessionMeta.get(SESSION_POOL)!.name}`;
    }

    if (action === "turnEnded") {
      const cur = sessionMeta.get(SESSION_POOL) ?? {};
      const turn = (typeof cur.turn === "number" ? cur.turn : 0) + 1;
      sessionMeta.set(SESSION_POOL, { ...cur, turn });
      return `回合结束:turn=${turn}${str(a.turnId) ? `(turnId=${str(a.turnId)})` : ""}`;
    }

    if (action === "closeSession") {
      sessionMeta.delete(SESSION_POOL);
      return `会话已关闭(池 ${SESSION_POOL},元数据已清)`;
    }

    if (action === "sessionInfo") {
      const m = sessionMeta.get(SESSION_POOL) ?? {};
      return JSON.stringify({ pool: SESSION_POOL, name: m.name ?? null, turn: typeof m.turn === "number" ? m.turn : 0 });
    }

    /* 如实拒绝:本仓单进程直连池,没有 ZCode 那张跨进程请求表,取消无对象——不假装取消成功。 */
    if (action === "cancelRequest") {
      return `[browser] 本仓无跨进程请求表,取消不适用(requestId=${str(a.requestId) || "(空)"};长等待请用 timeoutMs 控制)`;
    }

    const needsTab = ["snapshot", "act", "cua", "shot", "text", "eval", "wait", "close",
      "navigate", "hover", "drag", "select", "press", "viewport_get", "viewport_set", "viewport_reset", "wait_for", "screenshots",
      "getState", "elementInfo", "getDialog", "handleDialog", "scroll", "playwright"];
    if (needsTab.includes(action)) {
      const entry = resolveTab(a.tab, owner);
      if (!entry) return `[browser] 无可用 tab${str(a.tab) ? `(「${str(a.tab)}」不存在)` : ""}。在场:\n${tabsLine(owner)}`;

      if (action === "snapshot") {
        /* maxElements=元素预算(clamp 10..300,缺省 300);includeHidden=true 放宽 visibility/opacity(display:none 仍排除)。 */
        const maxE = clampInt(a.maxElements, 10, 300, 300);
        const snap = await takeSnapshot(entry, { maxElements: maxE, includeHidden: a.includeHidden === true });
        if (a.ariaOnly === true) {
          return snap.aria ? ariaBlock(snap).replace(/^\n/, "") : "[browser] 该页面取不到 aria 树(ariaSnapshot 不可用或为空)";
        }
        return renderSnapshot(snap, entry, maxE);
      }

      /** 导航后的统一收尾:刷新 url/title,回 `[nav] <url> · <title>`。
       * 2026-11:顺带自动快照(同 URL 节流、失败静默,不改回执文本)。 */
      const afterNav = async (): Promise<string> => {
        await entry.page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
        entry.url = entry.page.url();
        entry.title = await entry.page.title().catch(() => "");
        entry.lastActive = Date.now();
        await autoSnapshot(entry);
        return `[nav] ${entry.url} · ${entry.title}`;
      };

      if (action === "navigate") {
        /* 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(navigate/back/forward/reload) */
        const op = str(a.op) || "url";
        const timeout = clampInt(a.timeoutMs, 1_000, 60_000, 20_000);
        /* 历史/重载失败(无历史条目/被拦截)也按 fail-soft:沿用当前页继续观察,不抛。 */
        const navFn = op === "back" ? entry.page.goBack : op === "forward" ? entry.page.goForward : op === "reload" ? entry.page.reload : null;
        if (op === "back" || op === "forward" || op === "reload") {
          if (typeof navFn !== "function") return `[browser] 当前页面不支持 navigate op=${op}`;
          await navFn.call(entry.page, { timeout }).catch(() => null);
          /* 历史游标(host 侧):back/forward 移动,reload 不变。 */
          if (op === "back") navBack(entry); else if (op === "forward") navForward(entry);
        } else if (op === "url") {
          const url = str(a.url);
          if (!/^https?:\/\//.test(url)) return "[browser] 仅支持 http/https URL";
          if (!hostAllowed(url, cfg.allowDomains())) return "[browser] 域名不在白名单:" + url;
          await entry.page.goto(url, { timeout, waitUntil: "domcontentloaded" });
          navPushed(entry);
        } else if (op === "stop") {
          /* 形态来源: ZCode/.../commands.ts 的 stop 语义——本仓用 window.stop() 请求终止加载。 */
          await entry.page.evaluate("window.stop()").catch(() => {});
          return "[nav] 已请求停止";
        } else return "[browser] navigate op 可用:back/forward/reload/url/stop";
        return afterNav();
      }

      if (action === "hover") {
        const t = targetSelector(entry, a);
        if (!t.ok) return "[browser] hover " + t.error;
        await callLoc(entry.page.locator(t.selector), "hover", withMods({ timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) }, parseModifiers(a.modifiers)));
        await sleep(200);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return "[hover] 完成";
      }

      if (action === "drag") {
        /* 形态来源: ZCode/.../commands.ts(drag: fromRef/toRef 或 from/to 坐标;cuaDrag: path 逐点) */
        if (isFileDragArg(a)) {
          return "[browser] 拒绝:不支持拖拽到文件输入框/携带文件(file 相关参数)。文件选择需真实人工操作,本工具不实现";
        }
        const timeout = clampInt(a.timeoutMs, 500, 30_000, 10_000);
        const mods = parseModifiers(a.modifiers);
        const pts = parsePath(a.path);
        if (pts.length >= 2) {
          const start = pts[0]!;
          const m = entry.page.mouse;
          await m.move(start.x, start.y);
          for (const k of mods ?? []) await entry.page.keyboard.down(k);
          await m.down();
          for (const p of pts.slice(1)) await m.move(p.x, p.y, { steps: 8 });
          await m.up();
          for (const k of [...(mods ?? [])].reverse()) await entry.page.keyboard.up(k);
        } else {
          const fromSpec = (a.from && typeof a.from === "object" ? a.from : {}) as Record<string, unknown>;
          const toSpec = (a.to && typeof a.to === "object" ? a.to : {}) as Record<string, unknown>;
          const fromSel = targetSelector(entry, fromSpec);
          const toSel = targetSelector(entry, toSpec);
          const fromPt = typeof fromSpec.x === "number" && typeof fromSpec.y === "number"
            ? { x: Number(fromSpec.x), y: Number(fromSpec.y) } : null;
          const toPt = typeof toSpec.x === "number" && typeof toSpec.y === "number"
            ? { x: Number(toSpec.x), y: Number(toSpec.y) } : null;
          if (!fromSel.ok && !fromPt) return "[browser] drag 需要 from(selector/ref 或 x,y):" + fromSel.error;
          if (!toSel.ok && !toPt) return "[browser] drag 需要 to(selector/ref 或 x,y):" + toSel.error;
          if (fromSel.ok && toSel.ok) {
            /* 元素→元素:locator.dragTo 原生拖拽(HTML5 drag 事件链由 Playwright 合成)。 */
            await callLoc(entry.page.locator(fromSel.selector), "dragTo", entry.page.locator(toSel.selector), withMods({ timeout }, mods));
          } else {
            const start = fromPt ?? (fromSel.ok ? await centerOf(entry.page, fromSel.selector) : null);
            const end = toPt ?? (toSel.ok ? await centerOf(entry.page, toSel.selector) : null);
            if (!start || !end) return "[browser] drag 起止点无法解析";
            const m = entry.page.mouse;
            await m.move(start.x, start.y);
            for (const k of mods ?? []) await entry.page.keyboard.down(k);
            await m.down();
            await m.move(end.x, end.y, { steps: 12 });
            await m.up();
            for (const k of [...(mods ?? [])].reverse()) await entry.page.keyboard.up(k);
          }
        }
        await sleep(200);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return "[drag] 完成";
      }

      if (action === "select") {
        const t = targetSelector(entry, a);
        if (!t.ok) return "[browser] select " + t.error;
        const raw = a.values ?? a.value;
        const values = Array.isArray(raw)
          ? raw.map((v) => String(v))
          : raw != null && String(raw) !== "" ? [String(raw)] : [];
        if (!values.length) return "[browser] select 需要 values(字符串或字符串数组)";
        const picked = await callLoc(entry.page.locator(t.selector), "selectOption", values, { timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) });
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return `[select] ${JSON.stringify(Array.isArray(picked) ? picked : values)}`;
      }

      if (action === "press") {
        const key = str(a.key) || str(a.value);
        if (!key) return "[browser] press 需要 key(如 Enter/Tab/a)";
        const mods = parseModifiers(a.modifiers);
        const t = targetSelector(entry, a);
        if (t.ok) await callLoc(entry.page.locator(t.selector), "focus", { timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) });
        else if (str(a.selector) || str(a.ref)) return "[browser] press " + t.error;
        if (mods) {
          /* 带修饰键:逐键 down → press → 逆序 up(组合键不能压成末键+bitmask)。 */
          for (const k of mods) await entry.page.keyboard.down(k);
          await entry.page.keyboard.press(key);
          for (const k of [...mods].reverse()) await entry.page.keyboard.up(k);
        } else {
          await entry.page.keyboard.press(key);
        }
        await sleep(200);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return `[press] ${key}${mods ? "+" + mods.join("+") : ""}`;
      }

      if (action === "viewport_get" || action === "viewport_set" || action === "viewport_reset") {
        if (action === "viewport_set") {
          const width = clampInt(a.width, 320, 3840, 1280);
          const height = clampInt(a.height, 320, 2160, 720);
          if (typeof entry.page.setViewportSize !== "function") return "[browser] 当前页面不支持 viewport_set";
          await entry.page.setViewportSize({ width, height });
          entry.lastActive = Date.now();
          return `视口 ${width}x${height}`;
        }
        if (action === "viewport_reset") {
          /* 形态来源: ZCode/.../commands.ts(browserViewportReset:恢复该 tab 创建时的视口)。 */
          if (typeof entry.page.setViewportSize !== "function") return "[browser] 当前页面不支持 viewport_reset";
          await entry.page.setViewportSize({ width: entry.viewport0.width, height: entry.viewport0.height });
          entry.lastActive = Date.now();
          return `视口已恢复 ${entry.viewport0.width}x${entry.viewport0.height}`;
        }
        /* viewport_get:只影响页面视口(不改浏览器窗口);null 时按浏览器窗口默认 1280x720 兜底。 */
        const vp = (typeof entry.page.viewportSize === "function" ? entry.page.viewportSize() : null) ?? { width: 1280, height: 720 };
        return `视口 ${vp.width}x${vp.height}`;
      }

      if (action === "getState") {
        /* 形态来源: ZCode/.../commands.ts(getState:页面轻量状态行,agent 便宜感知用)。
         * 2026-11 起补 canGoForward(host 侧历史游标;页面内拿不到 forward 栈深度)。 */
        const st = await entry.page.evaluate<{ url: string; title: string; canGoBack: boolean; scrollX: number; scrollY: number; viewport: { w: number; h: number } }>(
          "(() => ({ url: location.href, title: document.title, canGoBack: history.length > 1, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), viewport: { w: innerWidth, h: innerHeight } }))()");
        entry.url = st.url; entry.title = st.title; entry.lastActive = Date.now();
        const navLen = Number(entry.navLen) || 0;
        const navIndex = Number(entry.navIndex) || 0;
        return JSON.stringify({ ...st, canGoForward: navLen > 0 && navIndex < navLen - 1 });
      }

      if (action === "elementInfo") {
        /* 形态来源: ZCode/packages/desktop/src/main/browserView/browserCommandScripts.ts(ELEMENT_AT_POINT_SCRIPT:
         * elementFromPoint 坐标反查 + 复用快照 selector/role/name 构造 + p<N> ref 现分配)。 */
        const x = num(a.x); const y = num(a.y);
        if (x == null || y == null) return "[browser] elementInfo 需要 x,y(视口坐标)";
        const info = await entry.page.evaluate<ElementInfo | null>(`(${ELEMENT_AT_POINT})(${x}, ${y})`);
        if (!info || !info.selector) return `[browser] (${x},${y}) 未命中可定位元素`;
        /* selector 命中当前 refs → 复用既有 ref;否则分配 p<N> 存入 refs(refsUrl 对齐当前页防误报过期)。 */
        let ref = "";
        for (const [k, v] of entry.refs) if (v.selector === info.selector) { ref = k; break; }
        if (!ref) {
          entry.ptSeq += 1;
          ref = "p" + entry.ptSeq;
          entry.refs.set(ref, { selector: info.selector, name: info.name || undefined });
        }
        entry.lastActive = Date.now();
        return JSON.stringify({ ref, tag: info.tag, role: info.role, name: info.name, text: info.text,
          selector: info.selector, rect: info.rect, attributes: info.attributes });
      }

      if (action === "getDialog") {
        /* 形态来源: ZCode/.../commands.ts(getDialog:读当前未处理 JS 弹窗,无则 dialog=null)。 */
        entry.lastActive = Date.now();
        if (!entry.dialogHooked) return "[browser] 该 tab 未挂 dialog 监听(页面不支持事件)";
        if (!entry.dialog) return "无弹窗";
        return JSON.stringify({ type: entry.dialog.type, message: entry.dialog.message, defaultValue: entry.dialog.defaultValue });
      }

      if (action === "handleDialog") {
        /* 形态来源: ZCode/.../commands.ts(handleDialog:accept/dismiss + promptText,处理后清缓存)。 */
        const accept = a.accept === true;
        if (!entry.dialog) return "[browser] 无弹窗可处理(先 action=getDialog 确认)";
        const promptText = str(a.promptText) || undefined;
        if (accept) await entry.dialog.handle.accept(promptText != null ? { promptText } : undefined);
        else await entry.dialog.handle.dismiss();
        const done = entry.dialog;
        entry.dialog = null;
        entry.lastActive = Date.now();
        return `弹窗已${accept ? "接受" : "取消"}(${done.type}):${done.message.slice(0, 120)}`;
      }

      if (action === "scroll") {
        /* 形态来源: ZCode/.../commands.ts(scroll:元素锚点滚动到可视区)。 */
        const t = targetSelector(entry, a);
        if (!t.ok) return "[browser] scroll " + t.error;
        await callLoc(entry.page.locator(t.selector), "scrollIntoViewIfNeeded", { timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) });
        await sleep(200);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return "[scroll] 完成";
      }

      if (action === "wait_for") {
        const kind = str(a.kind) || "selector";
        const value = str(a.value);
        const timeout = clampInt(a.timeoutMs, 500, 60_000, 10_000);
        if (!value && kind !== "loadstate") return "[browser] wait_for 需要 value";
        entry.lastActive = Date.now();
        if (kind === "url") {
          const hit = await waitUntil(async () => entry.page.url().includes(value), timeout);
          if (!hit) return `[browser] wait_for 超时(kind=url value=${value} ${timeout}ms):当前 ${entry.page.url()}`;
        } else if (kind === "text") {
          const needle = JSON.stringify(value);
          const hit = await waitUntil(async () =>
            Boolean(await entry.page.evaluate<boolean>(`(() => document.body ? document.body.innerText.includes(${needle}) : false)()`)), timeout);
          if (!hit) return `[browser] wait_for 超时(kind=text value=${value} ${timeout}ms)`;
        } else if (kind === "textGone") {
          /* 形态来源: ZCode/.../commands.ts(waitFor 的 textGone):text 消失为命中,反条件轮询。 */
          const needle = JSON.stringify(value);
          const gone = await waitUntil(async () =>
            !(await entry.page.evaluate<boolean>(`(() => document.body ? document.body.innerText.includes(${needle}) : false)()`)), timeout);
          if (!gone) return `[browser] wait_for 超时(kind=textGone value=${value} ${timeout}ms):文本仍在`;
        } else if (kind === "loadstate") {
          /* 形态来源: ZCode/.../commands.ts(waitForLoadState):networkidle|domcontentloaded|load 透传。 */
          const state = value || "load";
          if (!["networkidle", "domcontentloaded", "load"].includes(state)) {
            return "[browser] wait_for loadstate 可用:networkidle/domcontentloaded/load";
          }
          await entry.page.waitForLoadState(state, { timeout }).catch((err: unknown) => {
            throw err;
          });
        } else if (kind === "selector") {
          try {
            await callLoc(entry.page.locator(value), "waitFor", { state: "visible", timeout });
          } catch (err) {
            return `[browser] wait_for 超时(kind=selector value=${value} ${timeout}ms):${String(err).slice(0, 200)}`;
          }
        } else return "[browser] wait_for kind 可用:url/text/textGone/loadstate/selector";
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => "");
        return "[wait_for] 命中";
      }

      if (action === "screenshots") {
        /* 形态来源: ZCode/.../commands.ts(screenshot fullPage) + 本仓 shot 落盘/markdown 预览口径 */
        const mode = str(a.mode) || "viewport";
        if (mode !== "viewport" && mode !== "full_page") return "[browser] screenshots mode 可用:viewport/full_page";
        const f = await saveShot(root, entry, mode === "full_page", str(a.path) || undefined);
        entry.lastActive = Date.now();
        return f;
      }

      if (action === "act") {
        const op = str(a.op);
        if (!ACT_OPS.has(op)) return `[browser] 未知 op「${op}」。可用:${Array.from(ACT_OPS).join("/")}`;
        const t = targetSelector(entry, a);
        if (!t.ok) return "[browser] act " + t.error;
        const selector = t.selector;
        const timeout = Math.min(num(a.timeoutMs, 10_000)!, 30_000);
        const loc = entry.page.locator(selector);
        const mods = withMods({ timeout }, parseModifiers(a.modifiers));
        let out = "";
        switch (op) {
          case "click": await callLoc(loc, "click", mods); break;
          case "dblclick": await callLoc(loc, "dblclick", mods); break;
          case "fill": await callLoc(loc, "fill", String(a.value ?? ""), mods); break;
          case "type": await callLoc(loc, "type", String(a.text ?? a.value ?? ""), mods); break;
          case "press": await callLoc(loc, "press", str(a.key) || str(a.value) || "Enter", mods); break;
          case "hover": await callLoc(loc, "hover", mods); break;
          case "check": await callLoc(loc, "check", mods); break;
          case "uncheck": await callLoc(loc, "uncheck", mods); break;
          case "selectOption": {
            const opt = a.label != null ? { label: String(a.label) } : a.index != null ? { index: Number(a.index) } : String(a.value ?? "");
            await callLoc(loc, "selectOption", opt, mods); break;
          }
          case "waitFor": await callLoc(loc, "waitFor", { state: str(a.value) || "visible", timeout }); break;
          case "count": out = String(await callLoc(loc, "count")); break;
          case "isVisible": out = String(await callLoc(loc, "isVisible")); break;
          case "isEnabled": out = String(await callLoc(loc, "isEnabled")); break;
          case "innerText": out = String(await callLoc(loc, "innerText", mods)); break;
          case "textContent": out = String((await callLoc(loc, "textContent", mods)) ?? ""); break;
          case "allTextContents": out = JSON.stringify(await callLoc(loc, "allTextContents", mods)); break;
          case "getAttribute": out = String((await callLoc(loc, "getAttribute", str(a.attribute), mods)) ?? "(无属性)"); break;
        }
        /* 动作后轻量观察(skill 纪律:按预期效果判断,不为观察再拍快照)。 */
        await sleep(400);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        const navigated = entry.url !== entry.refsUrl;
        return `${op} ✓ ${selector}${out ? " → " + out.slice(0, 500) : ""}\n[tab ${entry.id}] ${entry.title} | ${entry.url}` +
          (navigated ? "\n(页面已导航,ref 清单过期——继续操作前 action=snapshot)" : "");
      }

      if (action === "cua") {
        const op = str(a.op);
        const m = entry.page.mouse; const k = entry.page.keyboard;
        const x = num(a.x, 0)!; const y = num(a.y, 0)!;
        const mods = parseModifiers(a.modifiers);
        switch (op) {
          case "click": await m.click(x, y, mods ? { modifiers: mods } : undefined); break;
          case "double_click": await m.click(x, y, mods ? { clickCount: 2, modifiers: mods } : { clickCount: 2 }); break;
          case "move": await m.move(x, y); break;
          case "scroll": {
            /* 锚点滚动:给了 x/y 先移过去再滚(ZCode cuaScroll 语义;不给=当前鼠标位置)。 */
            if (a.x != null && a.y != null) await m.move(x, y);
            for (const key of mods ?? []) await k.down(key);
            await m.wheel(num(a.deltaX, 0)!, num(a.deltaY, 0)!);
            for (const key of [...(mods ?? [])].reverse()) await k.up(key);
            break;
          }
          case "drag": {
            const pts = parsePath(a.path);
            if (pts.length < 2) return "[browser] cua drag 需要 path=[x1,y1,x2,y2,...] 或 [{x,y},...]";
            const start = pts[0]!;
            await m.move(start.x, start.y);
            for (const key of mods ?? []) await k.down(key);
            await m.down();
            for (const p of pts.slice(1)) await m.move(p.x, p.y, { steps: 8 });
            await m.up();
            for (const key of [...(mods ?? [])].reverse()) await k.up(key);
            break;
          }
          case "keypress": {
            const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
            if (!keys.length) return "[browser] cua keypress 需要 keys 数组(如 [\"Control\",\"a\"])";
            for (const key of keys) await k.down(key);
            for (const key of [...keys].reverse()) await k.up(key);
            break;
          }
          case "type": await k.type(str(a.text)); break;
          default: return `[browser] 未知 cua op「${op}」。可用:click/double_click/move/scroll/drag/keypress/type`;
        }
        await sleep(400);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return `cua ${op} ✓\n[tab ${entry.id}] ${entry.title} | ${entry.url}` +
          (entry.url !== entry.refsUrl ? "\n(页面已导航,ref 清单过期——继续操作前 action=snapshot)" : "");
      }

      if (action === "shot") {
        /* 形态来源: ZCode/.../commands.ts(screenshot:ref 元素截图 / clip 区域截图,与 fullPage 互斥)。 */
        const clip = parseClip(a.clip);
        if (str(a.ref) || str(a.selector)) {
          const t = targetSelector(entry, a);
          if (!t.ok) return "[browser] shot " + t.error;
          const buf = (await callLoc(entry.page.locator(t.selector), "screenshot", { timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) })) as Buffer;
          return saveShotBuf(root, entry, buf, str(a.path) || undefined);
        }
        if (clip) return saveShot(root, entry, false, str(a.path) || undefined, clip);
        return saveShot(root, entry, a.fullPage === true);
      }

      if (action === "text") return "标题:" + entry.title + "\n" + (await bodyText(entry, 4000) || "(空页面)");

      if (action === "eval") {
        const expr = str(a.expr);
        if (!expr) return "[browser] eval 需要 expr(JS 表达式)";
        const r = await entry.page.evaluate<unknown>(expr);
        return "结果:" + JSON.stringify(r ?? null).slice(0, 2000);
      }

      if (action === "wait") {
        /* 形态来源: ZCode/.../commands.ts(playwrightWaitForTimeout:非负整数,0=让出一次 timer tick)。 */
        if (a.ms != null) {
          const ms = clampInt(a.ms, 0, 30_000, 0);
          if (typeof entry.page.waitForTimeout === "function") await entry.page.waitForTimeout(ms);
          else await sleep(ms);
          entry.lastActive = Date.now();
          return `[wait] ${ms}ms`;
        }
        const kind = str(a.kind) || "loadstate";
        const timeout = Math.min(num(a.timeoutMs, 10_000)!, 30_000);
        if (kind === "loadstate") await entry.page.waitForLoadState(str(a.value) || "domcontentloaded", { timeout });
        else if (kind === "url") {
          const target = str(a.value);
          await waitUntil(async () => entry.page.url().includes(target), timeout, 200);
        } else if (kind === "selector") {
          await callLoc(entry.page.locator(str(a.value)), "waitFor", { timeout });
        } else return "[browser] wait kind 可用:ms/loadstate/url/selector";
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => "");
        return `等待 ${kind} ✓ [tab ${entry.id}] ${entry.title} | ${entry.url}`;
      }

      if (action === "close") {
        const scope = str(a.scope);
        if (scope === "all") {
          const n = sharedTabs.size;
          for (const t of sharedTabs.values()) { subscribedTabIds.delete(t.id); void t.page.close().catch(() => {}); }
          sharedTabs.clear();
          if (sharedBrowser) { const b = sharedBrowser; sharedBrowser = null; void b.close().catch(() => {}); }
          return `已关闭全部 ${n} 个 tab`;
        }
        /* owner 隔离(2026-11 browser-ux-redo):无显式 tab 只关自己 owner 最近 tab;
         * 显式 tab 且 owner 不符 → fail-closed 返回错误文本,不关(人机互不抢)。 */
        const explicit = scope || str(a.tab);
        const id = explicit || entry.id;
        const t = sharedTabs.get(id);
        if (!t) return `[browser] tab「${id}」不存在。在场:\n${tabsLine(owner)}`;
        if (explicit && t.owner !== owner) {
          return `[browser] 拒绝关闭 tab「${id}」:owner=${t.owner || "agent"},当前 owner=${owner}(不跨 owner 关闭)`;
        }
        sharedTabs.delete(id);
        subscribedTabIds.delete(id);
        await t.page.close().catch(() => {});
        if (!sharedTabs.size && sharedBrowser) { const b = sharedBrowser; sharedBrowser = null; void b.close().catch(() => {}); }
        return `已关闭 tab ${id}`;
      }

      /* ───────── playwright 通道(直连 Playwright 原生 API 面) ─────────
       * 形态来源: ZCode/apps/zcode-cli/packages/core/src/browser-client/playwright.ts
 * (16-75,:447-585 getByRole/getByText/getByLabel/getByPlaceholder/getByTestId/first/last/nth/filter;
 * 652-676 waitForLoadState/waitForURL/evaluate)。
       * 裁剪:downloadPath/fileChooserSetFiles(安全红线:下载/文件选择)、domSnapshot(已有 action=snapshot)、
       * frameLocator(无 iframe 穿透)一律明确拒绝。不进 VIEW_COMMANDS(面板白名单不加 playwright)。 */
      if (action === "playwright") {
        const op = str(a.op);
        /* 拒绝面:形态来源 ZCode PlaywrightAPI 面(publicMembers :16-58)里本仓不设的门。 */
        if (op === "downloadPath" || op === "fileChooserSetFiles" || op === "domSnapshot" || op === "frameLocator") {
          return `[browser] 本仓禁用/不适用:${op}(下载/文件选择=安全红线;domSnapshot→action=snapshot;无 iframe 穿透)`;
        }
        if (op === "waitForLoadState") {
          /* 形态来源: :652-676 waitFor(state 透传 networkidle|domcontentloaded|load)。 */
          const state = str(a.state) || "load";
          if (!["networkidle", "domcontentloaded", "load"].includes(state)) {
            return "[browser] 不支持:waitForLoadState state 可用 networkidle/domcontentloaded/load";
          }
          await entry.page.waitForLoadState(state, { timeout: clampInt(a.timeoutMs, 500, 60_000, 10_000) });
          entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
          return `等待 ${state} ✓ [tab ${entry.id}] ${entry.title} | ${entry.url}`;
        }
        if (op === "waitForURL") {
          const target = str(a.url);
          if (!target) return "[browser] 不支持:waitForURL 需要 url(字符串/子串)";
          if (typeof entry.page.waitForURL !== "function") return "[browser] 不支持:当前页面无 waitForURL";
          await entry.page.waitForURL(target, { timeout: clampInt(a.timeoutMs, 500, 60_000, 10_000) });
          entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
          return `等待 url ✓ [tab ${entry.id}] ${entry.title} | ${entry.url}`;
        }
        if (op === "evaluate") {
          const expression = str(a.expression);
          if (!expression) return "[browser] 不支持:evaluate 需要 expression";
          const r = await entry.page.evaluate<unknown>(expression);
          return "结果:" + JSON.stringify(r ?? null).slice(0, 2000);
        }
        if (op !== "locator") return `[browser] 不支持:playwright op 可用 locator/waitForLoadState/waitForURL/evaluate`;
        /* op=locator:steps 逐级 getBy* → chain(first/last/nth/filter)→ then 动作。 */
        const steps = Array.isArray(a.steps) ? (a.steps as Array<Record<string, unknown>>) : [];
        if (!steps.length) return "[browser] 不支持:playwright locator 需要 steps 数组";
        if (steps.length > 6) return "[browser] 不支持:steps 最多 6 级";
        let loc: LocatorProbe | null = null;
        let desc = "";
        for (const s of steps) {
          const by = str(s.by);
          const value = str(s.value);
          const name = str(s.name);
          const exact = s.exact === true;
          if (!value) return `[browser] 不支持:step 需要 by(${PW_STEP_BYS.join("/")}) + value`;
          const pw = entry.page as PageLike;
          const method = by === "role" ? "getByRole" : by === "text" ? "getByText"
            : by === "label" ? "getByLabel" : by === "placeholder" ? "getByPlaceholder"
            : by === "testid" ? "getByTestId" : by === "alt" ? "getByAltText" : by === "title" ? "getByTitle" : "";
          if (!method || typeof (pw as unknown as Record<string, unknown>)[method] !== "function") {
            return `[browser] 不支持:by=${by}(可用:${PW_STEP_BYS.join("/")})或该页面未实现 ${method || "(未知)"}`;
          }
          const fn = (pw as unknown as Record<string, unknown>)[method] as (...xs: unknown[]) => LocatorProbe;
          const role = by === "role" ? (name || "") : "";
          if (by === "role" && !role) return "[browser] 不支持:by=role 需要 name 字段(role 名),value 作 name 断言";
          loc = by === "role"
            ? fn.call(pw, role, { name: value, ...(exact ? { exact: true } : {}) })
            : by === "testid"
              ? fn.call(pw, value)
              : fn.call(pw, value, exact ? { exact: true } : undefined);
          desc += (desc ? " >> " : "") + `getBy${by === "testid" ? "TestId" : by === "alt" ? "AltText" : by.charAt(0).toUpperCase() + by.slice(1)}(${by === "role" ? role + ", name=" + value : value}${exact ? ", exact" : ""})`;
        }
        const chain = Array.isArray(a.chain) ? (a.chain as Array<Record<string, unknown>>) : [];
        for (const c of chain) {
          const cop = str(c.op);
          if (cop === "first" || cop === "last") loc = callLocSync(loc!, cop);
          else if (cop === "nth") loc = callLocSync(loc!, "nth", num(c.n, 0));
          else if (cop === "filter") loc = callLocSync(loc!, "filter", { hasText: str(c.hasText) });
          else return `[browser] 不支持:chain op 可用 first/last/nth/filter`;
          desc += ` >> ${cop}${cop === "nth" ? "(" + num(c.n, 0) + ")" : cop === "filter" ? "(hasText=" + str(c.hasText) + ")" : "()"}`;
        }
        const then = (a.then && typeof a.then === "object" ? a.then : {}) as Record<string, unknown>;
        const top = str(then.op);
        if (!top) return "[browser] 不支持:playwright locator 需要 then(动作/取值 op)";
        if (top === "screenshot") {
          const buf = (await callLoc(loc!, "screenshot", { timeout: clampInt(a.timeoutMs, 500, 30_000, 10_000) })) as Buffer;
          return saveShotBuf(root, entry, buf, str(then.path) || str(a.path) || undefined);
        }
        let out = "";
        const timeout = clampInt(a.timeoutMs, 500, 30_000, 10_000);
        switch (top) {
          case "click": case "dblclick": case "hover": case "check": case "uncheck":
            await callLoc(loc!, top, { timeout }); break;
          case "fill": await callLoc(loc!, "fill", str(then.value), { timeout }); break;
          case "type": await callLoc(loc!, "type", str(then.text ?? then.value), { timeout }); break;
          case "press": await callLoc(loc!, "press", str(then.key) || "Enter", { timeout }); break;
          case "selectOption": {
            const opt = then.label != null ? { label: String(then.label) } : then.index != null ? { index: Number(then.index) } : String(then.value ?? "");
            await callLoc(loc!, "selectOption", opt, { timeout }); break;
          }
          case "textContent": out = String((await callLoc(loc!, "textContent")) ?? ""); break;
          case "innerText": out = String(await callLoc(loc!, "innerText")); break;
          case "getAttribute": out = String((await callLoc(loc!, "getAttribute", str(then.attribute))) ?? "(无属性)"); break;
          case "isVisible": out = String(await callLoc(loc!, "isVisible")); break;
          case "isEnabled": out = String(await callLoc(loc!, "isEnabled")); break;
          case "count": out = String(await callLoc(loc!, "count")); break;
          default: return `[browser] 不支持:then op 可用 ${PW_THEN_OPS.join("/")}`;
        }
        await sleep(200);
        entry.url = entry.page.url(); entry.title = await entry.page.title().catch(() => ""); entry.lastActive = Date.now();
        return `playwright ${desc} → ${top}${out ? " → " + out.slice(0, 500) : ""}\n[tab ${entry.id}] ${entry.title} | ${entry.url}`;
      }
    }

    return `[browser] 未知 action「${action}」。可用:open/tabs/newTab/activateTab/capabilities/snapshot/act/hover/drag/select/press/navigate/cua/shot/screenshots/text/eval/wait/wait_for/scroll/getState/elementInfo/getDialog/handleDialog/viewport_get/viewport_set/viewport_reset/playwright/markDeliverable/markHandoff/claimTab/listUserTabs/finalize/finalizeTabs/nameSession/turnEnded/closeSession/sessionInfo/cancelRequest/close`;
  } catch (err) {
    const msg = String(err).slice(0, 300);
    /* locator 失败的 skill 纪律:重新 snapshot 重建事实,不带旧 ref 重试。 */
    const hint = /timeout|strict|selector/i.test(msg) ? "(定位失败:重新 action=snapshot,从新清单选 ref)" : "";
    return "[browser 失败] " + msg + hint;
  }
}

/* ───────── 视图 hub(协议契约:帧 + 事件 + 白名单命令,面板人机同看) ─────────
 * 形态来源: ZCode/packages/shared/src/browser-use/commands.ts(list/tabs/browserViewportSet)
 * 与 ZCode/apps/zcode-cli/packages/core/src/browser-client/manifest.ts(Tab.viewportSize/screenshot)。 */
export interface BrowserViewFrame {
  tabId: string;
  seq: number;
  imageB64: string;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  url: string;
  title: string;
  hitRegions: Array<{ ref: string; x: number; y: number; width: number; height: number; w: number; h: number }>;
  ts: number;
}

export interface BrowserViewEvent {
  tabId: string;
  kind: "nav" | "load" | "close" | "crash";
  url?: string;
  title?: string;
  message?: string;
}

export interface BrowserViewHub {
  subscribe(tabId: string | null, sink: (m: BrowserViewFrame | BrowserViewEvent) => void): { subId: string; tabId: string };
  unsubscribe(subId: string): void;
  subscribers(): number;
  runViewCommand(action: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
  tabList(): Array<{ id: string; url: string; title: string; active: boolean; owner?: string }>;
}

const FRAME_MIN_INTERVAL_MS = 800;
const FRAME_TICK_MS = 400;
const FRAME_QUALITY = 60;
const FRAME_QUALITY_SMALL = 40;
const FRAME_MAX_BYTES = 900 * 1024;
/** 命中框上限(2026-11 真实站点):40 → 120,首屏卡片/按钮才够覆盖;取框数量另有抓取上限防 300 次 boundingBox 拖慢推流。 */
const HIT_REGION_LIMIT = 120;
const HIT_BOX_FETCH_CAP = 240;
const HIT_AREA_MAX_RATIO = 0.85;
/** 面板命令白名单(不含 eval/close:不允许面板执行任意脚本,也不允许面板替 agent 关窗口)。
 * 含 open:面板空态「新建」按钮要能起一页看 —— URL 仍走 hostAllowed 门禁,不放宽任何权限。 */
const VIEW_COMMANDS = new Set(["open", "navigate", "hover", "drag", "select", "press", "viewport_get", "viewport_set",
  "wait_for", "snapshot", "shot", "screenshots", "tabs", "text", "act", "cua", "getState"]);

let hubSingleton: BrowserViewHub | null = null;
const frameSeqByTab = new Map<string, number>();

const viewportOf = (page: PageLike): { width: number; height: number } => {
  const vp = (typeof page.viewportSize === "function" ? page.viewportSize() : null) ?? null;
  return vp ? { width: vp.width, height: vp.height } : { width: 1280, height: 720 };
};

/** hitRegions:最近一次 snapshot 的 refs → boundingBox 矩形(面板在帧上画的命中区)。
 * 2026-11 真实站点:限 120 个;裁掉视口外框(滚动后老 ref 全图乱画)与 >85% 视口的超大框(整页一个命中框);
 * 按面积升序优先小目标后再截断(卡片/按钮比整块容器更值得点)。抛错跳过。 */
const hitRegionsOf = async (entry: TabEntry): Promise<Array<{ ref: string; x: number; y: number; width: number; height: number; w: number; h: number }>> => {
  const vp = viewportOf(entry.page);
  const vpArea = Math.max(1, vp.width * vp.height);
  const boxes: Array<{ ref: string; x: number; y: number; width: number; height: number; w: number; h: number; area: number }> = [];
  let n = 0;
  for (const [ref, item] of entry.refs) {
    if (n >= HIT_BOX_FETCH_CAP) break;
    n += 1;
    try {
      const bb = (await callLoc(entry.page.locator(item.selector), "boundingBox")) as BBox | null;
      if (!bb || !(bb.width > 0) || !(bb.height > 0)) continue;
      /* 与视口不相交(滚出屏幕 / 横向溢出) → 不画。 */
      if (bb.x + bb.width <= 0 || bb.y + bb.height <= 0 || bb.x >= vp.width || bb.y >= vp.height) continue;
      const area = bb.width * bb.height;
      if (area > vpArea * HIT_AREA_MAX_RATIO) continue;
      /* 双键(width/height 主 + w/h 旧,面板旧读点不破)。 */
      boxes.push({ ref, x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height),
        w: Math.round(bb.width), h: Math.round(bb.height), area });
    } catch { /* 元素失配/已卸载:跳过 */ }
  }
  boxes.sort((a, b) => a.area - b.area);
  return boxes.slice(0, HIT_REGION_LIMIT).map(({ area: _area, ...r }) => r);
};

interface ViewSub {
  subId: string;
  tabId: string;
  sink: (m: BrowserViewFrame | BrowserViewEvent) => void;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  /** 是否已绑定到具体 tab(pending=订阅时池为空,等第一个 tab 出现再绑定)。 */
  attached: boolean;
  lastPush: number;
  lastHash: string;
  lastUrl: string;
  lastTitle: string;
  detach: () => void;
}

const createViewHub = (root: string, cfg: BrowserToolConfig): BrowserViewHub => {
  const subs = new Map<string, ViewSub>();
  let subSeq = 0;

  const stop = (sub: ViewSub) => {
    if (sub.timer) { clearInterval(sub.timer); sub.timer = null; }
    sub.detach();
    sub.detach = () => {};
    /* 退订即解除 idle 回收豁免(人不再看这一页)。 */
    if (sub.tabId) subscribedTabIds.delete(sub.tabId);
  };

  const capture = async (sub: ViewSub, force: boolean): Promise<void> => {
    if (sub.busy) return;
    /* 订阅时池为空(pending):等到第一个 tab 出现再绑定并推首帧,避免面板空视图永不自愈。 */
    if (!sub.attached) {
      const late = mostRecentTab("human");
      if (!late) return;
      bind(sub, late);
      return;
    }
    const entry = sharedTabs.get(sub.tabId);
    if (!entry) {
      stop(sub);
      sub.sink({ tabId: sub.tabId, kind: "close", message: "tab 已关闭" });
      return;
    }
    sub.busy = true;
    try {
      let buf = await entry.page.screenshot({ type: "jpeg", quality: FRAME_QUALITY });
      if (buf.length > FRAME_MAX_BYTES) buf = await entry.page.screenshot({ type: "jpeg", quality: FRAME_QUALITY_SMALL });
      const hash = createHash("sha1").update(buf).digest("hex");
      const url = entry.page.url();
      const title = entry.title;
      const now = Date.now();
      const changed = hash !== sub.lastHash || url !== sub.lastUrl || title !== sub.lastTitle;
      /* 帧节流:距上次 ≥800ms 且(内容 sha1 变 或 url/title 变)才推;首帧 force。 */
      if (!force && (!changed || now - sub.lastPush < FRAME_MIN_INTERVAL_MS)) return;
      const viewport = viewportOf(entry.page);
      const seq = (frameSeqByTab.get(entry.id) ?? 0) + 1;
      frameSeqByTab.set(entry.id, seq);
      sub.lastHash = hash;
      sub.lastUrl = url;
      sub.lastTitle = title;
      sub.lastPush = now;
      sub.sink({
        tabId: entry.id, seq, imageB64: buf.toString("base64"),
        width: viewport.width, height: viewport.height, viewport, url, title,
        hitRegions: await hitRegionsOf(entry), ts: now,
      });
    } catch (err) {
      stop(sub);
      sub.sink({ tabId: sub.tabId, kind: "close", message: String(err).slice(0, 200) });
    } finally {
      sub.busy = false;
    }
  };

  /** 把订阅绑到具体 tab:挂事件监听 + 立即推首帧 + 起定时截图。 */
  const bind = (sub: ViewSub, entry: TabEntry): void => {
    sub.attached = true;
    /* 正被视图订阅 → reapIdle 跳过(人看着的页不被后台回收)。 */
    if (sub.tabId) subscribedTabIds.delete(sub.tabId);
    sub.tabId = entry.id;
    subscribedTabIds.add(entry.id);
    const page = entry.page;
    const url = () => { try { return page.url(); } catch { return ""; } };
    const handlers: Array<[string, (...x: unknown[]) => void]> = [];
    const add = (ev: string, fn: (...x: unknown[]) => void) => {
      if (typeof page.on !== "function") return;
      try { page.on(ev, fn); handlers.push([ev, fn]); } catch { /* 不支持事件的探针页 */ }
    };
    add("framenavigated", () => sub.sink({ tabId: entry.id, kind: "nav", url: url(), title: entry.title }));
    add("load", () => sub.sink({ tabId: entry.id, kind: "load", url: url(), title: entry.title }));
    add("close", () => sub.sink({ tabId: entry.id, kind: "close", url: url() }));
    add("crash", () => sub.sink({ tabId: entry.id, kind: "crash", url: url(), message: "页面崩溃" }));
    const prevDetach = sub.detach;
    sub.detach = () => {
      prevDetach();
      for (const [ev, fn] of handlers) {
        try { page.off?.(ev, fn); } catch { /* 已关闭页面 */ }
      }
    };
    void capture(sub, true);
  };

  const subscribe = (tabId: string | null, sink: (m: BrowserViewFrame | BrowserViewEvent) => void) => {
    const subId = "sub" + ++subSeq;
    const wanted = typeof tabId === "string" && tabId ? tabId : null;
    /* 人看视图:缺省绑 human 自己最近的 tab(没被 agent 占),无 human tab 才回落全局最近。 */
    const entry = wanted ? sharedTabs.get(wanted) ?? null : mostRecentTab("human");
    const sub: ViewSub = {
      subId, tabId: entry?.id ?? wanted ?? "", sink, timer: null, busy: false, attached: false,
      lastPush: 0, lastHash: "", lastUrl: "", lastTitle: "", detach: () => {},
    };
    subs.set(subId, sub);
    /* 定时器一律先起:池为空时 capture 会在 pending 态等待第一个 tab 出现再 bind(自愈)。 */
    sub.timer = setInterval(() => { void capture(sub, false); }, FRAME_TICK_MS);
    (sub.timer as unknown as { unref?: () => void }).unref?.();
    if (!entry) {
      /* 无 tab:推一条 close 事件让面板进空态;sub 保留 pending,bind 后自动接管。 */
      sink({ tabId: sub.tabId, kind: "close", message: "无打开的 tab" });
      return { subId, tabId: sub.tabId };
    }
    bind(sub, entry);
    return { subId, tabId: entry.id };
  };

  return {
    subscribe,
    unsubscribe(subId: string) {
      const sub = subs.get(subId);
      if (!sub) return;
      stop(sub);
      subs.delete(subId);
    },
    subscribers: () => subs.size,
    async runViewCommand(action: string, args: Record<string, unknown>) {
      if (!VIEW_COMMANDS.has(action)) return { ok: false, text: `[browser] 面板命令白名单外: ${action}` };
      /* 面板=人类侧:命令一律以 owner="human" 执行,args.tabId 选 tab(与工具面 tab 同义)。 */
      const a = (args ?? {}) as Record<string, unknown>;
      const scoped = typeof a.tabId === "string" && a.tabId && typeof a.tab !== "string" ? { ...a, tab: a.tabId } : a;
      const text = await runBrowserAction(root, cfg, { ...scoped, action }, "human");
      const ok = !/^\[browser( 失败)?\]/.test(text);
      return { ok, text };
    },
    tabList() {
      const active = mostRecentTab("human");
      return Array.from(sharedTabs.values()).map((t) => ({ id: t.id, url: t.url, title: t.title, active: active?.id === t.id, owner: t.owner }));
    },
  };
};

/** hub 单例:首次调用时用传入 root/cfg 创建并缓存(面板与工具看到同一份订阅面)。 */
export function getBrowserViewHub(root: string, cfg: BrowserToolConfig): BrowserViewHub {
  if (!hubSingleton) hubSingleton = createViewHub(root, cfg);
  return hubSingleton;
}

/** 建工具实例。owner(2026-11 browser-ux-redo):该 agent 侧实例的 tab 归属——缺省 "agent";
 * 主 agent 传 taskId/sessionId、子代理传 subagentId,缺省选 tab 与 close 越权判定都按它隔离。 */
export function createBrowserTool(root: string, cfg: BrowserToolConfig, owner = "agent"): Tool {
  return {
    name: "browser",
    description: [
      "【用途】浏览器控制(持久 tab 会话 + 快照 ref 定位 + Playwright 操作 + cua 坐标兜底)。agent 与面板内置浏览器共用同一浏览器池,人机同看。",
      "【何时用】需要真实浏览器读写页面时:本地 Web 服务验收、登录态页面操作、交互后视觉确需截图。纯 HTTP 取正文用 web_fetch。",
      "【命令清单】(每个命令一行:参数 → 返回)",
      "- open{url,newTab?} → 新开或复用同域 tab,回 tabId + 页面摘要(已自动快照,ref 可直接用)",
      "- newTab{url?} → 强制新开 tab,缺省 about:blank,回新 tabId + 摘要",
      "- activateTab{tab} → 切换活跃 tab,回 `已激活 tab tN`",
      "- capabilities → 支持面/禁用面静态 JSON(下载/文件选择/录制/cancelRequest 不支持)",
      "- tabs → 在场 tab 清单(带 owner);每行 `* t1  active  <owner>  <title>  <url>`,`*` 标活跃,deliverable/handoff 行尾带 `[deliverable]`/`[handoff]`",
      "- snapshot{tab?,ariaOnly?,maxElements?,includeHidden?} → 元素 e1..eN + 正文语义节点 + aria 树(截断 4000)。maxElements clamp 10..300 默认 300;includeHidden=true 放宽 visibility/opacity(display:none 仍排除);元素带 disabled/checked/xpath/attributes,行内追加 `[disabled]`/`[checked]`,父级线索 `^eN`;ariaOnly 只回 aria 树",
      "- act{tab?,ref|selector,op,...} → click/dblclick/fill/type/press/hover/check/uncheck/selectOption/waitFor/count/getAttribute/innerText/textContent/isVisible/isEnabled(其余参数透传)",
      "- hover{selector|ref,modifiers?} → 悬停,回 `[hover] 完成`",
      "- drag{from:{selector|ref|x,y},to:{selector|ref|x,y}} 或 {path:[{x,y},...]} → 拖拽,回 `[drag] 完成`",
      "- scroll{selector|ref} → 滚入可视区,回 `[scroll] 完成`",
      "- select{selector|ref,values:string|string[]} → 下拉选择,回选中值 JSON",
      "- press{key,selector?|ref?,modifiers?} → 有目标先 focus 再按,回 `[press] <key>`",
      "- navigate{op:back|forward|reload|url|stop,url?} → 历史/跳转(门禁)/停止加载,回 `[nav] <url> · <title>`",
      "- getState{tab?} → 读 {url,title,canGoBack,canGoForward,scrollX,scrollY,viewport},回单行 JSON",
      "- elementInfo{x,y,tab?} → 坐标反查 {tag,role,name,text,selector,rect,attributes};命中当前 refs 复用 ref,否则分配 `p<N>`",
      "- getDialog{tab?} / handleDialog{accept,promptText?,tab?} → 读最近未处理 JS 弹窗或「无弹窗」;接受/取消并清缓存",
      "- viewport_get{tab?} / viewport_set{width,height,tab?} → per-tab 视口,回 `视口 WxH`(宽 320..3840/高 320..2160);viewport_reset{tab?} 恢复 open 时视口",
      "- wait{ms,tab?} → 固定等待 clamp 0..30000,回 `[wait] Nms`;wait{kind:loadstate|url|selector,value?} 条件等待",
      "- wait_for{kind:url|text|textGone|loadstate|selector,value,timeoutMs?} → 回 `[wait_for] 命中`,超时回错误文本(500..60000 默认 10000)",
      "- shot{tab?,fullPage?,ref?,clip?} / screenshots{mode:viewport|full_page,path?} → 截图落 .genie/browser-shots/(ref=元素;clip={x,y,width,height}=区域)",
      "- text{tab?,url?} → 正文全文;eval{tab?,expr} → 页面 JS 表达式结果(≤2000 字)",
      "- close{tab?,scope?} → 关 tab(scope=all 全关;无 tab 只关自己 owner 最近,越权拒绝)",
      "- cua{tab?,op,x?,y?,deltaX?,deltaY?,path?,keys?,text?,modifiers?} → 坐标路 op:click/double_click/move/scroll/drag/keypress/type",
      "- playwright{tab?,op,steps?,chain?,then?,...} → Playwright 通道:op=locator 的 steps≤6 级 `{by:role|text|label|placeholder|testid|alt|title,value,exact?,name?}` 逐级 getBy*(by=role 时 name=role 名、value 作 name 断言),chain 可 first/last/{nth,n}/{filter,hasText},then 必填 {op:click|fill|type|press|hover|check|uncheck/selectOption|textContent|innerText|getAttribute|isVisible|isEnabled|count|screenshot}(落盘);op=waitForLoadState{state?}/waitForURL{url}/evaluate{expression}。downloadPath/fileChooserSetFiles/domSnapshot/frameLocator → 拒绝",
      "- 生命周期:markDeliverable{tab}/markHandoff{tab} 置标记回 `[tab tN] <状态> · <title> | <url>`;claimTab{tab} handoff→active;listUserTabs 列 handoff;finalize{keep?:string[]} 关非 keep 回关闭/保留清单;finalizeTabs{keep:[{tab,status:deliverable|handoff}]} 保留并按表置标记",
      "- 错误码:`[browser]`/`[browser 失败]` 第二行追加 `code=<k> sideEffect=<none|uncertain>`;只读命令失败=none,改状态动作=uncertain;耗时>200ms 尾追加 ` elapsedMs=<n>`",
      "- modifiers?:string[](Alt/Control/ControlOrMeta/Meta/Shift):click/hover/drag/press/cua(scroll) 透传;cua 坐标序列用 keyboard.down/up 包裹",
      "- 会话面(单池 default):nameSession{name} 存名;turnEnded{turnId?} 回合计数+1;sessionInfo 回单行 JSON {pool,name,turn};closeSession 清元数据;cancelRequest{requestId} 如实回「本仓无跨进程请求表,取消不适用」",
      "- 兼容旧形态:{action:\"open\"|\"text\"|\"click\"|\"shot\", url, selector?, fullPage?} 视为「导航后执行」",
      "【约束】",
      "- 门禁:需启用(设置-浏览器控制)+ allowDomains 白名单(空=全放行;open/newTab(url)/navigate op=url 校验 host);未启用回 `[browser] 未启用…`",
      "- ref 随导航失效:快照后 URL 变了,旧 ref 报「已过期」要求重新 snapshot;禁止猜 selector,定位失败重拍快照",
      "- viewport_set 只改页面视口不改窗口;轮询式感知用 snapshot,不要靠截图猜结构",
      "- 截图统一落 <root>/.genie/browser-shots/;返回的 ![浏览器截图](/uploads?path=…) 行请在最终汇报原样保留,面板才渲染预览",
      "- 危险动作限制:不实现文件输入(file 参数一律拒绝);eval 只跑页面作用域;面板视图命令白名单不含 eval/open/close",
      "- 纪律:snapshot 是页面感知主通道;一次观察周期只做一个状态改变动作;act 后按预期效果判断成败。本地 HTTP(127.0.0.1)可直接用",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "open | tabs | newTab | activateTab | capabilities | snapshot | act | hover | drag | select | press | navigate | cua | shot | screenshots | text | eval | wait | wait_for | scroll | getState | elementInfo | getDialog | handleDialog | viewport_get | viewport_set | viewport_reset | playwright | markDeliverable | markHandoff | claimTab | listUserTabs | finalize | finalizeTabs | nameSession | turnEnded | closeSession | sessionInfo | cancelRequest | close" },
        url: { type: "string", description: "open/newTab/text/navigate(op=url) 的目标 URL(http/https/127.0.0.1)" },
        tab: { type: "string", description: "tabId(t1/t2..;缺省=最近活跃 tab)" },
        newTab: { type: "boolean", description: "open 时强制开新 tab(默认复用同域 tab)" },
        ref: { type: "string", description: "目标元素 ref(来自 snapshot,如 e3;也接受纯数字 3)" },
        op: { type: "string", description: "act/cua 的操作名;navigate 时为 back/forward/reload/url/stop" },
        value: { type: "string", description: "fill 内容 / selectOption 的 value / press 键名 / wait_for 的目标值" },
        values: { description: "select 的选中值(字符串或字符串数组)", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        key: { type: "string", description: "press 的键(Enter/Tab/a 等)" },
        label: { type: "string", description: "selectOption 按 label 选" },
        index: { type: "number", description: "selectOption 按 index 选" },
        attribute: { type: "string", description: "getAttribute 的属性名" },
        timeoutMs: { type: "number", description: "动作超时(默认 10s,上限 30s;wait_for 上限 60s)" },
        selector: { type: "string", description: "(兼容)CSS 选择器直点" },
        from: { type: "object", description: "drag 起点:{selector|ref} 或 {x,y}" },
        to: { type: "object", description: "drag 终点:{selector|ref} 或 {x,y}" },
        x: { type: "number", description: "cua/drag/elementInfo 坐标" },
        y: { type: "number", description: "cua/drag/elementInfo 坐标" },
        deltaX: { type: "number", description: "cua scroll 横向增量" },
        deltaY: { type: "number", description: "cua scroll 纵向增量" },
        path: {
          description: "cua/drag 坐标路:[x1,y1,x2,y2,...] 或 [{x,y},...];screenshots 时为目标文件名(仅文件名,落盘目录固定)",
          anyOf: [{ type: "array" }, { type: "string" }],
        },
        keys: { type: "array", items: { type: "string" }, description: "cua keypress 组合键序列" },
        text: { type: "string", description: "cua type 的文本" },
        expr: { type: "string", description: "eval 的页面 JS 表达式(结果 JSON 化,≤2000 字)" },
        kind: { type: "string", description: "wait 类型:loadstate|url|selector;wait_for 类型:url|text|textGone|loadstate|selector" },
        scope: { type: "string", description: "close 范围:单 tabId 或 all" },
        fullPage: { type: "boolean", description: "shot 全页截图" },
        mode: { type: "string", description: "screenshots 模式:viewport|full_page" },
        ariaOnly: { type: "boolean", description: "snapshot 只回 aria 树(省 token)" },
        maxElements: { type: "number", description: "snapshot 元素预算(clamp 10..300,默认 300;超出置 truncated)" },
        includeHidden: { type: "boolean", description: "snapshot 放宽 visibility/opacity 判定(display:none 仍排除)" },
        name: { type: "string", description: "nameSession 的会话名" },
        turnId: { type: "string", description: "turnEnded 的回合标识(仅回显)" },
        requestId: { type: "string", description: "cancelRequest 的请求 id(本仓无跨进程请求表,如实回不适用)" },
        keep: { description: "finalize:保留的 tabId 列表;finalizeTabs:[{tab,status:deliverable|handoff}]", anyOf: [{ type: "array", items: { type: "string" } }, { type: "array", items: { type: "object", properties: { tab: { type: "string" }, status: { type: "string" } }, required: ["tab"] } }] },
        width: { type: "number", description: "viewport_set 宽(320..3840)" },
        height: { type: "number", description: "viewport_set 高(320..2160)" },
        ms: { type: "number", description: "wait{ms} 的固定等待毫秒数(非负整数,clamp 0..30000)" },
        modifiers: { type: "array", items: { type: "string" }, description: "修饰键(Alt/Control/ControlOrMeta/Meta/Shift),click/hover/drag/press/cua(scroll) 支持" },
        accept: { type: "boolean", description: "handleDialog:true=接受弹窗,false=取消" },
        promptText: { type: "string", description: "handleDialog 对 prompt 填入的文本" },
        steps: { type: "array", description: "playwright op=locator 的逐级定位步骤(≤6):{by:role|text|label|placeholder|testid|alt|title, value, exact?, name?};by=role 时 name=role 名、value 作 name 断言,其余 value 直接作 matcher", items: { type: "object", properties: { by: { type: "string" }, value: { type: "string" }, name: { type: "string" }, exact: { type: "boolean" } }, required: ["by", "value"] } },
        chain: { type: "array", description: "locator 构造后的链操作:{op:first}|{op:last}|{op:nth,n}|{op:filter,hasText}", items: { type: "object" } },
        then: { type: "object", description: "locator 构造后的动作/取值:{op:click|fill|type|press|hover|check|uncheck|selectOption|textContent|innerText|getAttribute|isVisible|isEnabled|count|screenshot, value?,text?,key?,label?,index?,attribute?,path?}", properties: { op: { type: "string" } }, required: ["op"] },
        state: { type: "string", description: "playwright op=waitForLoadState 的状态:networkidle|domcontentloaded|load(缺省 load)" },
        expression: { type: "string", description: "playwright op=evaluate 的页面 JS 表达式(结果 JSON 化,≤2000 字)" },
        clip: { type: "object", description: "shot 区域截图:{x,y,width,height}(视口 CSS px,与 fullPage/ref 互斥)", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] },
      },
      required: ["action"],
    },
    execute: (args: unknown) => runBrowserAction(root, cfg, args, owner),
  };
}
