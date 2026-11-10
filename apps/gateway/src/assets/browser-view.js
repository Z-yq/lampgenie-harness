/* browser-view.js —— 面板内置浏览器视图(agent 驱动态 + 人接管态),零构建、纯浏览器端资产。
 * 形态来源:
 *  - ZCode/packages/ui/src/browser-use/UnifiedBrowserView.tsx(统一视图双态:agent 通道驱动 / 人类接管)
 *  - ZCode/packages/ui/src/browser-use/BrowserViewportToolbar.tsx(地址栏 / 前进后退刷新 / 缩放档选择)
 *  - ZCode/packages/ui/src/browser-use/ResponsiveBrowserViewport.tsx + ResponsiveBrowserResizeHandles.tsx
 *    (视口框 + 8 向拖拽把手,带符号方向因子;拖拽期间只改本地尺寸,松手才提交一次;
 *     把手可聚焦,Arrow=1px / Shift+Arrow=10px / Home=最小 / End=最大)
 *  - ZCode/packages/ui/src/browser-use/browserViewportZoom.ts(缩放语义:fit 双轴取 min 且上界 1)
 *  - ZCode/packages/ui/src/browser-use/useEmbeddedBrowserWheelChain.ts(滚轮链:Ctrl/Meta = 缩放,
 *    横向 deltaX / 内容溢出 = 滚动页面,否则不抢事件)
 *  - ZCode/packages/ui/src/browser-use/HumanBrowserView.tsx(人接管态:本机浏览器窗口操作,面板只读观察)
 *  - ZCode/packages/ui/src/embeddedBrowserHelpers.ts(URL 协议白名单 / about:blank 默认值)
 *  - ZCode/packages/ui/src/EmbeddedBrowserPaneParts.tsx(工具栏可禁用按钮 / 刷新旋转 /
 *     空态·加载态·错误态·崩溃态四态渲染 / ⋮ 更多菜单 / 元素拾取按钮)
 * 与 ref 的关键差别(如实降级,不假装):ref 里网页像素由 Electron <webview> guest 直接渲染;
 * 本仓浏览器是服务端 headless(协议见 browser.view.*),面板只能拿服务端下发的截图帧。
 * 因此这里是「截图 canvas + 覆盖层」形态:看得见、e1..eN 高亮可点、视口可拖;真正的页面交互
 * 一律回落成命令消息(browser.view.command),或人接管到本机浏览器窗口。
 * DevTools 不做:无 guest 可挂调试器,ref 的 devtools 面板在本仓没有对应物,菜单里如实缺省。
 * 对外(window.GenieBrowserView):
 *   mount(hostEl, ctx)  容器 + {send,openExternal,subscribe}
 *   unmount()           清 DOM/定时器/监听
 *   handleMessage(msg)  收 browser.view.frame / .event / .subscribed / .command.result
 *   state()             快照 {tabId,tabs,url,title,zoom,viewport,humanMode,lastSeq,
 *                             canGoBack,canGoForward,isLoading,errorMessage}
 *   __test              纯函数 {clampZoom,fitZoom,nextViewportForDrag,wheelDecision,normalizeUrl}
 */
(function () {
  "use strict";

  // 注入友好:测试用 new Function("window","document", code)(fakeWindow, fakeDoc) 执行本资产,
  // 因此只经这两个形参/全局取宿主对象,不直接摸 document 全局。
  var W = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null;
  if (!W) return;
  var D = typeof document !== "undefined" && document ? document : W.document || null;

  // ---- 常量(视口边界对齐 ZCode/packages/shared/src/browser-use/command-metadata.ts) ----
  var MIN_VIEWPORT = 200;          // 内部 clamp 口径(比产品边界宽一档,拖拽/帧回写都用它兜底)
  var MAX_VIEWPORT = 4096;
  var VP_MIN_W = 320;              // 产品边界:数字输入 min/max、把手 aria、键盘 Home/End
  var VP_MAX_W = 3840;
  var VP_MIN_H = 320;
  var VP_MAX_H = 2160;
  var MIN_ZOOM = 0.5;
  var MAX_ZOOM = 2;
  var ZOOM_STEP = 0.1;             // Ctrl+滚轮步进
  var WHEEL_THROTTLE_MS = 120;     // 滚动命令节流下限(≥120ms 一条)
  var STAGE_PAD = 8;               // .gbv-stage 内边距,覆盖层靠这个像素对齐 canvas
  var FIT_PAD = 16;                // fit 双轴留白(ref 同款 16px,合计 32)
  var KB_STEP_PX = 1;              // 把手键盘步进:Arrow=1px、Shift+Arrow=10px
  var KB_STEP_BIG = 10;
  var VP_COMMIT_DEBOUNCE_MS = 200; // 键盘调视口的提交防抖
  var NAV_POLL_DELAY_MS = 2000;    // 每次 nav 后补一发 getState 的延迟
  var PREFS_KEY = "gbv-prefs";     // localStorage 偏好键(缩放 + 视口)
  var DEFAULT_VIEWPORT = { width: 1280, height: 720 };
  var DEFAULT_URL = "about:blank";
  var STYLE_ID = "gbv-style";
  var EMPTY_TEXT = "没有打开的标签页。对 agent 说一句「用 browser 打开 <url>」即可,或在这里点「新建」。";
  var BAD_PROTOCOL_TEXT = "不支持的地址协议";

  // 缩放档:fit + 固定比例(对齐 BROWSER_VIEWPORT_ZOOM_OPTIONS 的 50/75/100/125/150/200)
  var ZOOM_OPTIONS = [
    { value: "fit", label: "适配" },
    { value: 0.5, label: "50%" },
    { value: 0.75, label: "75%" },
    { value: 1, label: "100%" },
    { value: 1.25, label: "125%" },
    { value: 1.5, label: "150%" },
    { value: 2, label: "200%" }
  ];

  // 预设视口档(各自带成对尺寸;只改宽会让档位名同高不同形,反而误导)
  var VIEWPORT_PRESETS = [
    { label: "375", width: 375, height: 812 },
    { label: "768", width: 768, height: 1024 },
    { label: "1280", width: 1280, height: 720 },
    { label: "1920", width: 1920, height: 1080 }
  ];

  var HANDLE_KEYS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  // 把手 → 带符号方向因子(形态来源: ref/.../ResponsiveBrowserResizeHandles.tsx 的
  // widthDirection/heightDirection)。-1 = 反方向拖拽该轴才变大(n/w 往外拖),0 = 不影响,
  // +1 = 正向拖拽变大。例:拖 n 往上(dy<0)→ 高度增加;拖 w 往左(dx<0)→ 宽度增加。
  var HANDLE_AXES = {
    n: { width: 0, height: -1 },
    s: { width: 0, height: 1 },
    e: { width: 1, height: 0 },
    w: { width: -1, height: 0 },
    ne: { width: 1, height: -1 },
    nw: { width: -1, height: -1 },
    se: { width: 1, height: 1 },
    sw: { width: -1, height: 1 }
  };

  // ---- 纯函数(无 DOM / 无 IO,单测口径;实现对着 ref/browserViewportZoom.ts + ResponsiveBrowserResizeHandles.tsx) ----

  function num(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function clampViewportDimension(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return MIN_VIEWPORT;
    return Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(n)));
  }

  /** 缩放比例 clamp 到 [0.5,2],保留 4 位小数避免 0.7000000000000001 这类抖动。 */
  function clampZoom(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n)) return 1;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n * 10000) / 10000));
  }

  /** fit = 双轴可用空间各减 32px 留白后取 min,上界 1(只缩不放)。
   *  形态来源: ref/.../browserViewportZoom.ts resolveBrowserViewportScale 的 Math.min(1, w, h)。
   *  图尺寸无效或可用空间 ≤0 时退化为 1;不走 clampZoom(fit 的下界语义与档位缩放不同)。 */
  function fitZoom(imageWidth, imageHeight, stageWidth, stageHeight) {
    if (!(imageWidth > 0) || !(imageHeight > 0)) return 1;
    var availW = num(stageWidth, 0) - FIT_PAD * 2;
    var availH = num(stageHeight, 0) - FIT_PAD * 2;
    if (!(availW > 0) || !(availH > 0)) return 1;
    return Math.min(1, availW / imageWidth, availH / imageHeight);
  }

  /** 8 向拖拽把手 → 新视口尺寸(整数、clamp 200..4096)。按把手取带符号因子,只改覆盖轴。 */
  function nextViewportForDrag(start, dx, dy, handle) {
    var s = start && typeof start === "object" ? start : DEFAULT_VIEWPORT;
    var baseW = num(s.width, DEFAULT_VIEWPORT.width);
    var baseH = num(s.height, DEFAULT_VIEWPORT.height);
    var axes = HANDLE_AXES[String(handle || "").toLowerCase()] || { width: 0, height: 0 };
    var moveX = num(dx, 0);
    var moveY = num(dy, 0);
    return {
      width: clampViewportDimension(baseW + axes.width * moveX),
      height: clampViewportDimension(baseH + axes.height * moveY)
    };
  }

  /** 滚轮意图判定:Ctrl/Meta = 缩放;其余一律**滚页面**。
   *  2026-11 实修:旧口径「画布不溢出容器 → pass」在默认「适配」缩放下恒成立
   *  (适配就是让画布刚好装进容器),于是用户在面板里滚轮完全没反应——这是用户
   *  「鼠标下滑没有反应」的根因。画布放大后需要看局部时,用容器滚动条/拖拽平移,
   *  不再由滚轮分流(滚轮 = 页面滚动,与真浏览器一致)。 */
  function wheelDecision(input) {
    var o = input && typeof input === "object" ? input : {};
    if (o.ctrl || o.meta) return "zoom";
    return "scroll";
  }

  /** URL 协议白名单(形态来源: ref/.../embeddedBrowserHelpers.ts ALLOWED_BROWSER_PROTOCOLS)。
   *  显式协议只放 about:blank / http: / https: / file: / data:image/*;javascript:、
   *  data:text/html 等一律返回 ""(由调用方提示「不支持的地址协议」)。
   *  无协议输入按地址栏习惯补:localhost/IP 走 http,其余走 https。 */
  function inferSchemeless(value) {
    if (/^localhost(:\d+)?([/?#]|$)/i.test(value)) return "http://" + value; // 本机开发口默认 http
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(value)) return "http://" + value;
    return "https://" + value;
  }

  function normalizeUrl(raw) {
    var value = String(raw == null ? "" : raw).trim();
    if (!value) return "";
    var match = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(value);
    if (match) {
      var head = value.slice(0, match[0].length).toLowerCase();
      var rest = value.slice(match[0].length);
      if (head === "http:" || head === "https:" || head === "file:") return value;
      if (head === "about:") return /^blank($|[/?#])/i.test(rest) ? value : "";
      if (head === "data:") return /^image\//i.test(rest) ? value : "";
      // 伪协议其实是 host:port(localhost:3000 / example.com:8080):冒号后是端口,
      // 不算显式协议(形态来源: ref hasDisallowedExplicitProtocol 的端口豁免),走补全。
      if (/^\d{1,5}($|[/?#])/.test(rest)) return inferSchemeless(value);
      return "";
    }
    return inferSchemeless(value);
  }

  /** 系统浏览器出口只放 http/https/file(形态来源: isDefaultBrowserOpenableUrl)。
   *  about:/data: 在系统浏览器里没有意义,其余协议是注入面,一律拒收。 */
  function isExternalOpenable(url) {
    var v = String(url == null ? "" : url).trim();
    return /^(https?|file):/i.test(v);
  }

  // ---- DOM 小工具 ----

  function make(tag, cls, text) {
    var node = D.createElement(tag);
    if (cls) node.className = cls;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function makeButton(cls, text, title) {
    var b = make("button", cls, text);
    b.type = "button";
    if (title) {
      b.title = title;
      b.setAttribute("aria-label", title);
    }
    return b;
  }

  function setDisplay(node, visible) {
    if (node && node.style) node.style.display = visible ? "" : "none";
  }

  function addClass(node, cls) {
    if (node && node.classList && node.classList.add) node.classList.add(cls);
  }

  function removeClass(node, cls) {
    if (node && node.classList && node.classList.remove) node.classList.remove(cls);
  }

  function closestClass(node, cls) {
    var n = node;
    var guard = 0;
    while (n && n !== D && guard < 24) {
      if (n.classList && n.classList.contains && n.classList.contains(cls)) return n;
      n = n.parentNode;
      guard += 1;
    }
    return null;
  }

  function makeImage() {
    if (D && typeof D.createElement === "function") {
      try {
        var node = D.createElement("img");
        if (node) return node;
      } catch (e) {
        // 落到 W.Image 兜底
      }
    }
    if (W && typeof W.Image === "function") {
      try {
        return new W.Image();
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  var CSS = [
    ".gbv-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;",
    'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#d7dbe0;background:#15181c}',
    ".gbv-toolbar{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;",
    "border-bottom:1px solid #2a2f36;background:#1b1f24;flex:0 0 auto}",
    ".gbv-toolbar button{height:24px;padding:0 8px;border:1px solid #33393f;border-radius:4px;",
    "background:#22272d;color:#d7dbe0;cursor:pointer;font:inherit}",
    ".gbv-toolbar button:disabled{opacity:.4;cursor:not-allowed}",
    ".gbv-toolbar button:hover:not(:disabled){background:#2c333a}",
    ".gbv-url{flex:1 1 220px;min-width:120px;height:24px;box-sizing:border-box;padding:0 8px;",
    "border:1px solid #33393f;border-radius:4px;background:#12151a;color:#e6edf3;font:inherit}",
    ".gbv-url[readonly]{opacity:.6;cursor:not-allowed}",
    ".gbv-zoom,.gbv-tabs,.gbv-presets{display:flex;align-items:center;gap:4px}",
    ".gbv-zoom button,.gbv-presets button,.gbv-tab{height:22px;padding:0 6px;font-size:11px}",
    ".gbv-zoom button.on,.gbv-presets button.on{background:#2f6fdd;border-color:#2f6fdd;color:#fff}",
    ".gbv-tabs{max-width:320px;overflow-x:auto;overflow-y:hidden}",
    ".gbv-tab{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".gbv-tab.on{background:#2f6fdd;border-color:#2f6fdd;color:#fff}",
    ".gbv-tabs-empty{font-size:11px;color:#6b737c}",
    ".gbv-badge{display:none;padding:0 6px;height:20px;line-height:20px;border-radius:3px;",
    "background:#7a4a00;color:#ffd79a;font-size:11px}",
    ".gbv-status{font-size:11px;color:#8b939c;margin-left:auto;white-space:nowrap;overflow:hidden;",
    "text-overflow:ellipsis;max-width:280px}",
    ".gbv-stage{position:relative;flex:1 1 auto;min-height:0;overflow:auto;",
    "padding:" + STAGE_PAD + "px;background:#0e1116}",
    ".gbv-canvas{display:block;background:#000;border:1px solid #2a2f36;box-sizing:content-box}",
    ".gbv-overlay{position:absolute;left:" + STAGE_PAD + "px;top:" + STAGE_PAD + "px;pointer-events:none}",
    ".gbv-hit{position:absolute;box-sizing:border-box;border:1px solid rgba(88,166,255,.85);",
    "background:rgba(88,166,255,.10);border-radius:2px;pointer-events:auto;cursor:pointer}",
    ".gbv-hit:hover{background:rgba(88,166,255,.30);box-shadow:0 0 0 1px rgba(88,166,255,.95)}",
    ".gbv-hit-ref{position:absolute;left:0;top:0;padding:0 3px;font-size:10px;line-height:14px;",
    "background:#58a6ff;color:#0b0f14;border-radius:2px 0 2px 0}",
    ".gbv-handles{position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none}",
    ".gbv-handle{position:absolute;pointer-events:auto;background:transparent}",
    ".gbv-handle-n{top:0;left:24px;right:24px;height:8px;cursor:ns-resize}",
    ".gbv-handle-s{bottom:0;left:24px;right:24px;height:8px;cursor:ns-resize}",
    ".gbv-handle-e{right:0;top:24px;bottom:24px;width:8px;cursor:ew-resize}",
    ".gbv-handle-w{left:0;top:24px;bottom:24px;width:8px;cursor:ew-resize}",
    ".gbv-handle-ne{top:0;right:0;width:20px;height:20px;cursor:nesw-resize}",
    ".gbv-handle-nw{top:0;left:0;width:20px;height:20px;cursor:nwse-resize}",
    ".gbv-handle-se{bottom:0;right:0;width:20px;height:20px;cursor:nwse-resize}",
    ".gbv-handle-sw{bottom:0;left:0;width:20px;height:20px;cursor:nesw-resize}",
    ".gbv-handle:focus{outline:1px solid #58a6ff;outline-offset:-1px}",
    ".gbv-empty{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;",
    "align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;color:#8b939c}",
    ".gbv-empty-text{margin:0;max-width:420px;line-height:1.6}",
    ".gbv-empty button{height:26px;padding:0 14px;border:1px solid #2f6fdd;border-radius:4px;",
    "background:#2f6fdd;color:#fff;cursor:pointer;font:inherit}",
    // 四态之加载态:isLoading 且尚无帧时全幅转圈(形态来源: EmbeddedBrowserPaneParts BrowserEmptyState)
    ".gbv-loading{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;",
    "align-items:center;justify-content:center;gap:10px;color:#8b939c;background:#0e1116;z-index:5}",
    ".gbv-spinner{width:26px;height:26px;border-radius:50%;border:3px solid #2a2f36;",
    "border-top-color:#58a6ff;animation:gbv-spin-rot .8s linear infinite}",
    ".gbv-loading-text{margin:0;font-size:12px}",
    // 四态之错误态/崩溃态:⚠ + 文案 + 重试/重载(形态来源: BrowserLoadErrorState / BrowserGuestFailureState)
    ".gbv-error{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;flex-direction:column;",
    "align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;background:#0e1116;z-index:6}",
    ".gbv-error-icon{font-size:26px;line-height:1;color:#e3b341}",
    ".gbv-error-text{margin:0;max-width:420px;line-height:1.6;color:#8b939c;word-break:break-all}",
    ".gbv-error button{height:26px;padding:0 14px;border:1px solid #2f6fdd;border-radius:4px;",
    "background:#2f6fdd;color:#fff;cursor:pointer;font:inherit}",
    // 刷新按钮 isLoading 旋转(形态来源: BrowserToolbar RefreshCw animate-spin)
    ".gbv-spin{display:inline-block;animation:gbv-spin-rot .8s linear infinite}",
    "@keyframes gbv-spin-rot{to{transform:rotate(360deg)}}",
    ".gbv-viewport-info{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:4px 8px;",
    "border-top:1px solid #2a2f36;background:#1b1f24;font-size:11px;color:#8b939c}",
    ".gbv-vp-text{margin-left:auto}",
    ".gbv-vp-x{color:#6b737c}",
    ".gbv-vp-input{width:62px;height:20px;box-sizing:border-box;padding:0 4px;border:1px solid #33393f;",
    "border-radius:4px;background:#12151a;color:#e6edf3;font:inherit;font-size:11px}",
    '.gbv-vp-input[aria-invalid="true"]{border-color:#c93c3c;background:#221216}',
    ".gbv-dragging{cursor:crosshair}",
    ".gbv-human-mode .gbv-stage{outline:1px dashed #7a4a00;outline-offset:-4px}",
    // 人工模式下这些按钮发的命令会被服务端拒绝/面板忽略,给个灰化反馈
    ".gbv-human-mode .gbv-zoom button,.gbv-human-mode .gbv-presets button{opacity:.45}",
    // 元素拾取态:按钮高亮 + 命中框十字光标 + 描边高亮层
    ".gbv-pick.on{background:#2f6fdd;border-color:#2f6fdd;color:#fff}",
    ".gbv-picking .gbv-hit{cursor:crosshair}",
    ".gbv-pick-hl{position:absolute;pointer-events:none;border:2px solid #f7b955;border-radius:2px;",
    "box-shadow:0 0 0 1px rgba(0,0,0,.55);z-index:2}",
    // ⋮ 更多菜单(形态来源: BrowserToolbarMoreMenu;DevTools 项不做:无 guest)
    ".gbv-menu{display:none;position:absolute;top:32px;right:8px;z-index:40;min-width:170px;padding:4px;",
    "border:1px solid #33393f;border-radius:6px;background:#1b1f24;box-shadow:0 8px 20px rgba(0,0,0,.5)}",
    ".gbv-menu.on{display:block}",
    ".gbv-menu button{display:block;width:100%;height:24px;margin:1px 0;padding:0 8px;text-align:left;",
    "border:0;border-radius:4px;background:transparent;color:#d7dbe0;cursor:pointer;font:inherit}",
    ".gbv-menu button:hover{background:#2c333a}",
    // 人类输入通道(2026-11 人机随时可用轮):文字输入框 + 输入/键位按钮 + 订阅失败一键启用
    ".gbv-type-input{flex:0 1 170px;min-width:110px;height:22px;box-sizing:border-box;padding:0 6px;",
    "border:1px solid #33393f;border-radius:4px;background:#12151a;color:#e6edf3;font:inherit;font-size:11px}",
    ".gbv-type-btn,.gbv-key{height:22px;padding:0 8px;font-size:11px}",
    ".gbv-key{min-width:42px}",
    ".gbv-tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".gbv-owner{flex:0 0 auto;font-size:9px;line-height:14px;padding:0 3px;border-radius:3px;",
    "background:#2c333a;color:#9aa4ae}",
    ".gbv-owner-agent{background:#3a2f5a;color:#c9b6ff}",
    ".gbv-enable{display:none;margin:8px auto 0;height:26px;padding:0 14px;border:1px solid #2f6fdd;",
    "border-radius:6px;background:#2f6fdd;color:#fff;font:inherit;font-size:12px;cursor:pointer}",
    // 人工模式只读化只覆盖 agent 侧动作:人类输入控件必须保持可用(不灰化/不 pointer-events:none)
    ".gbv-human-mode .gbv-type-input,.gbv-human-mode .gbv-type-btn,.gbv-human-mode .gbv-key{opacity:1}"
  ].join("");

  // ---- 实例状态 ----
  var S = {
    mounted: false,
    host: null,
    ctx: null,
    el: null,
    tabId: null,
    tabs: [],
    url: "",
    title: "",
    zoom: "fit",
    viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
    humanMode: false,
    lastSeq: -1,
    imgW: 0,
    imgH: 0,
    cssW: 0,
    cssH: 0,
    hits: [],
    drag: null,
    dragging: false,      // pointerdown..pointerup/cancel/blur 期间为真:onFrame 不得回写 viewport
    lastScrollAt: 0,
    pendingScroll: 0,
    pendingScrollX: 0,
    scrollTimer: 0,
    // 导航状态机(形态来源: embeddedBrowserHelpers.ts BrowserState)
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    errorMessage: null,
    crashed: false,       // 崩溃态 = 错误态特例:重试按钮发 navigate reload
    lastNav: null,        // {kind:"navigate"|"open", op?, url?} 最近一次用户导航,错误态重试用
    picking: false,       // 元素拾取模式
    pickBox: null,        // 拾取悬停命中的 hitRegion(反查结果)
    menuOpen: false,      // ⋮ 更多菜单
    vpCommitTimer: 0,     // 键盘调视口 200ms 防抖句柄
    stateTimer: 0,        // nav 后 getState 轮询句柄
    subFail: false,       // 订阅失败(常见原因 browser.enabled=false)→ 显示「一键启用并打开」
    typeDraft: ""         // 人类输入条当前草稿(state 里可见,便于诊断人到底打了什么)
  };

  var listeners = [];
  var dragListeners = [];
  var timers = [];

  function on(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn, opts);
    listeners.push(function () {
      try {
        target.removeEventListener(type, fn, opts);
      } catch (e) {
        // 目标可能已随 innerHTML 清空销毁,忽略
      }
    });
  }

  function onDrag(target, type, fn) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn);
    dragListeners.push(function () {
      try {
        target.removeEventListener(type, fn);
      } catch (e) {
        // 同上
      }
    });
  }

  function clearListeners() {
    for (var i = 0; i < listeners.length; i++) listeners[i]();
    listeners = [];
  }

  function clearDragListeners() {
    for (var i = 0; i < dragListeners.length; i++) dragListeners[i]();
    dragListeners = [];
  }

  function setTimer(fn, ms) {
    if (!W || typeof W.setTimeout !== "function") return 0;
    var id = W.setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function clearTimer(id) {
    if (!id) return;
    try {
      if (W && typeof W.clearTimeout === "function") W.clearTimeout(id);
    } catch (e) {
      // 忽略
    }
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) {
      try {
        if (W && typeof W.clearTimeout === "function") W.clearTimeout(timers[i]);
      } catch (e) {
        // 忽略
      }
    }
    timers = [];
    S.scrollTimer = 0;
    S.pendingScroll = 0;
    S.pendingScrollX = 0;
    S.vpCommitTimer = 0;
    S.stateTimer = 0;
  }

  function resetState() {
    S.tabId = null;
    S.tabs = [];
    S.url = "";
    S.title = "";
    S.zoom = "fit";
    S.viewport = { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height };
    S.humanMode = false;
    S.lastSeq = -1;
    S.imgW = 0;
    S.imgH = 0;
    S.cssW = 0;
    S.cssH = 0;
    S.hits = [];
    S.drag = null;
    S.dragging = false;
    S.lastScrollAt = 0;
    S.pendingScroll = 0;
    S.pendingScrollX = 0;
    S.scrollTimer = 0;
    S.canGoBack = false;
    S.canGoForward = false;
    S.isLoading = false;
    S.errorMessage = null;
    S.crashed = false;
    S.lastNav = null;
    S.picking = false;
    S.pickBox = null;
    S.menuOpen = false;
    S.vpCommitTimer = 0;
    S.stateTimer = 0;
    S.subFail = false;
    S.typeDraft = "";
  }

  // ---- 偏好持久化(缩放/视口;localStorage 任何一步都可能被宿主禁用,全部 try/catch) ----

  function loadPrefs() {
    try {
      if (!W || !W.localStorage || typeof W.localStorage.getItem !== "function") return;
      var raw = W.localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      if (!p || typeof p !== "object") return;
      if (p.zoom === "fit") S.zoom = "fit";
      else if (typeof p.zoom === "number" && isFinite(p.zoom)) S.zoom = clampZoom(p.zoom);
      if (p.viewport && typeof p.viewport === "object") {
        S.viewport = {
          width: clampViewportDimension(p.viewport.width),
          height: clampViewportDimension(p.viewport.height)
        };
      }
    } catch (e) {
      // localStorage 禁用 / JSON 损坏:静默用默认值
    }
  }

  function savePrefs() {
    if (S.humanMode) return; // 人工模式是观察态,不落偏好
    try {
      if (!W || !W.localStorage || typeof W.localStorage.setItem !== "function") return;
      W.localStorage.setItem(PREFS_KEY, JSON.stringify({ zoom: S.zoom, viewport: S.viewport }));
    } catch (e) {
      // 隐私模式 / 配额满:静默
    }
  }

  // ---- DOM 构建 ----

  function buildZoomBar() {
    var bar = make("div", "gbv-zoom");
    for (var i = 0; i < ZOOM_OPTIONS.length; i++) {
      var opt = ZOOM_OPTIONS[i];
      var b = makeButton("gbv-zoom-btn", opt.label, "缩放:" + opt.label);
      b.setAttribute("data-zoom", String(opt.value));
      b.setAttribute("aria-pressed", "false");
      bar.appendChild(b);
    }
    return bar;
  }

  function buildPresets() {
    var bar = make("div", "gbv-presets");
    for (var i = 0; i < VIEWPORT_PRESETS.length; i++) {
      var p = VIEWPORT_PRESETS[i];
      var b = makeButton("gbv-preset", p.label, "视口 " + p.width + "x" + p.height);
      b.setAttribute("data-w", String(p.width));
      b.setAttribute("data-h", String(p.height));
      bar.appendChild(b);
    }
    return bar;
  }

  function buildVpInput(kind, min, max) {
    var input = make("input", "gbv-vp-input");
    input.type = "number";
    input.setAttribute("min", String(min));
    input.setAttribute("max", String(max));
    input.setAttribute("step", "10");
    input.setAttribute("aria-label", kind === "w" ? "视口宽度(像素)" : "视口高度(像素)");
    input.setAttribute("aria-invalid", "false");
    input.value = String(kind === "w" ? S.viewport.width : S.viewport.height);
    return input;
  }

  function buildDom() {
    var el = {};
    el.root = make("div", "gbv-root");

    var toolbar = make("div", "gbv-toolbar");
    el.toolbar = toolbar;
    el.back = makeButton("gbv-back", "←", "后退");
    el.forward = makeButton("gbv-forward", "→", "前进");
    el.reload = makeButton("gbv-reload", "⟳", "刷新");
    el.urlInput = make("input", "gbv-url");
    el.urlInput.type = "text";
    el.urlInput.spellcheck = false;
    el.urlInput.placeholder = "输入网址,如 example.com";
    el.go = makeButton("gbv-go", "前往", "导航到地址栏 URL");
    // 人类输入通道(2026-11):打字 + 键位直接发到页面当前焦点元素,人不用背 ref 也能操作
    el.typeInput = make("input", "gbv-type-input");
    el.typeInput.type = "text";
    el.typeInput.spellcheck = false;
    el.typeInput.placeholder = "输入文字，回车发送";
    el.typeBtn = makeButton("gbv-type-btn", "输入", "把输入框文字发到页面当前焦点元素");
    el.keyEnter = makeButton("gbv-key", "Enter", "发送 Enter 键到页面");
    el.keyEnter.setAttribute("data-key", "Enter");
    el.keyEsc = makeButton("gbv-key", "Esc", "发送 Escape 键到页面");
    el.keyEsc.setAttribute("data-key", "Escape");
    el.keyTab = makeButton("gbv-key", "Tab", "发送 Tab 键到页面");
    el.keyTab.setAttribute("data-key", "Tab");
    el.zoomBar = buildZoomBar();
    el.tabs = make("div", "gbv-tabs");
    el.shot = makeButton("gbv-shot", "截图", "当前视口截图");
    el.shotFull = makeButton("gbv-shot-full", "全页", "整页截图");
    el.pick = makeButton("gbv-pick", "拾取", "元素拾取:点击画面元素复制其 ref,粘贴给 agent");
    el.human = makeButton("gbv-human", "人接管", "在本地浏览器窗口接管");
    el.more = makeButton("gbv-more", "⋮", "更多");
    el.menu = make("div", "gbv-menu");
    el.menuOpenExternal = makeButton("gbv-menu-item", "系统浏览器打开", "用系统浏览器打开当前页");
    el.menuCopyUrl = makeButton("gbv-menu-item", "复制当前 URL", "复制地址栏 URL 到剪贴板");
    el.menuReload = makeButton("gbv-menu-item", "重载", "让 agent 重新加载当前页");
    el.menu.appendChild(el.menuOpenExternal);
    el.menu.appendChild(el.menuCopyUrl);
    el.menu.appendChild(el.menuReload);
    el.badge = make("span", "gbv-badge", "人工模式(本地窗口)");
    el.status = make("span", "gbv-status", "无 tab");

    el.back.disabled = true;
    el.forward.disabled = true;

    toolbar.appendChild(el.back);
    toolbar.appendChild(el.forward);
    toolbar.appendChild(el.reload);
    toolbar.appendChild(el.urlInput);
    toolbar.appendChild(el.go);
    toolbar.appendChild(el.typeInput);
    toolbar.appendChild(el.typeBtn);
    toolbar.appendChild(el.keyEnter);
    toolbar.appendChild(el.keyEsc);
    toolbar.appendChild(el.keyTab);
    toolbar.appendChild(el.zoomBar);
    toolbar.appendChild(el.tabs);
    toolbar.appendChild(el.shot);
    toolbar.appendChild(el.shotFull);
    toolbar.appendChild(el.pick);
    toolbar.appendChild(el.human);
    toolbar.appendChild(el.more);
    toolbar.appendChild(el.menu);
    toolbar.appendChild(el.badge);
    toolbar.appendChild(el.status);

    el.stage = make("div", "gbv-stage");
    el.canvas = make("canvas", "gbv-canvas");
    el.overlay = make("div", "gbv-overlay");
    el.pickHl = make("div", "gbv-pick-hl");
    el.handles = make("div", "gbv-handles");
    el.handleNodes = [];
    for (var i = 0; i < HANDLE_KEYS.length; i++) {
      var key = HANDLE_KEYS[i];
      var handle = make("div", "gbv-handle gbv-handle-" + key);
      handle.setAttribute("data-handle", key);
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", "拖拽调整视口(" + key + ")");
      handle.setAttribute("aria-valuemin", String(VP_MIN_W));
      handle.setAttribute("aria-valuemax", String(VP_MAX_W));
      handle.setAttribute("aria-valuenow", String(S.viewport.width));
      handle.tabIndex = 0; // 可聚焦:键盘 Arrow/Shift+Arrow/Home/End 微调
      el.handles.appendChild(handle);
      el.handleNodes.push({ key: key, node: handle });
    }
    el.empty = make("div", "gbv-empty");
    el.emptyText = make("p", "gbv-empty-text", EMPTY_TEXT);
    el.newBtn = makeButton("gbv-new", "新建", "让 agent 新开一个标签页");
    // 订阅失败(browser.enabled=false 等)= 一键启用并打开:人不必先去设置页翻开关
    el.enable = makeButton("gbv-enable", "一键启用并打开", "开启浏览器控制并重新订阅当前 tab");
    el.empty.appendChild(el.emptyText);
    el.empty.appendChild(el.newBtn);
    el.empty.appendChild(el.enable);

    // 四态之加载态(isLoading 且无帧):转圈遮罩,默认隐藏由 setDisplay 驱动
    el.loading = make("div", "gbv-loading");
    el.spinner = make("div", "gbv-spinner");
    el.loadingText = make("p", "gbv-loading-text", "载入中…");
    el.loading.appendChild(el.spinner);
    el.loading.appendChild(el.loadingText);
    el.loading.style.display = "none";

    // 四态之错误态/崩溃态:⚠ + 文案 + 重试(崩溃时按钮文案改「重载」)
    el.error = make("div", "gbv-error");
    el.errorIcon = make("span", "gbv-error-icon", "⚠");
    el.errorText = make("p", "gbv-error-text", "");
    el.errorRetry = makeButton("gbv-error-retry", "重试", "重发最近一次导航");
    el.error.appendChild(el.errorIcon);
    el.error.appendChild(el.errorText);
    el.error.appendChild(el.errorRetry);
    el.error.style.display = "none";

    el.stage.appendChild(el.canvas);
    el.stage.appendChild(el.overlay);
    el.stage.appendChild(el.handles);
    el.stage.appendChild(el.loading);
    el.stage.appendChild(el.error);
    el.stage.appendChild(el.empty);

    el.info = make("div", "gbv-viewport-info");
    el.presets = buildPresets();
    el.wInput = buildVpInput("w", VP_MIN_W, VP_MAX_W);
    el.vpX = make("span", "gbv-vp-x", "×");
    el.hInput = buildVpInput("h", VP_MIN_H, VP_MAX_H);
    el.infoText = make("span", "gbv-vp-text", "视口 " + S.viewport.width + "x" + S.viewport.height + " · 缩放 适配");
    el.info.appendChild(el.presets);
    el.info.appendChild(el.wInput);
    el.info.appendChild(el.vpX);
    el.info.appendChild(el.hInput);
    el.info.appendChild(el.infoText);

    el.root.appendChild(toolbar);
    el.root.appendChild(el.stage);
    el.root.appendChild(el.info);
    return el;
  }

  function ensureStyles() {
    if (!D || typeof D.createElement !== "function") return;
    if (typeof D.getElementById === "function" && D.getElementById(STYLE_ID)) return;
    var style = D.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    var parent = D.head || D.body || D.documentElement;
    if (parent && typeof parent.appendChild === "function") parent.appendChild(style);
  }

  // ---- 消息发送(全部经 host 注入的 ctx.send,宿主用 wsSafeSend 发) ----

  function send(payload) {
    var ctx = S.ctx;
    if (!ctx || typeof ctx.send !== "function") return false;
    try {
      ctx.send(payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 面板 → 服务端命令。人工模式下只放行人自己发起的操作(打字/按键/坐标点击):
   *  只读化的意图是「agent 不替你动页面」,不是「人在面板里也不能动」——
   *  早先把 cua/press 也一并拦掉,人接管后连打字都发不出去(2026-11 修)。 */
  function command(action, args) {
    var a = args || {};
    var humanOp = action === "press" || (action === "cua" && (a.op === "type" || a.op === "click"));
    if (S.humanMode && !humanOp) {
      setStatus("人工模式:面板只读,命令已忽略");
      return false;
    }
    var payload = { type: "browser.view.command", action: action, args: a };
    if (S.tabId) payload.tabId = S.tabId;
    return send(payload);
  }

  function sendOpen(tabId) {
    var payload = { type: "browser.view.open" };
    if (tabId) payload.tabId = tabId;
    if (S.humanMode) {
      setStatus("人工模式:面板只读,订阅已忽略");
      return false;
    }
    return send(payload);
  }

  function openExternal(url) {
    var target = String(url || "");
 // 安全洞:系统浏览器出口只放 http/https/file(about:/data:/javascript: 一律拒收)
    if (!isExternalOpenable(target)) {
      setStatus("该地址不能在系统浏览器打开");
      return;
    }
    var ctx = S.ctx;
    if (ctx && typeof ctx.openExternal === "function") {
      try {
        ctx.openExternal(target);
        return;
      } catch (e) {
        // 宿主实现炸了也要有兜底出口
      }
    }
    if (W && typeof W.open === "function") {
      try {
        W.open(target, "_blank");
      } catch (e) {
        // 弹窗被拦:状态栏已经提示,不再追加噪音
      }
    }
  }

  // ---- 渲染 ----

  function setStatus(text) {
    if (S.el && S.el.status) S.el.status.textContent = String(text || "");
  }

  function updateAddress() {
    if (!S.el || !S.el.urlInput) return;
    // 用户正在地址栏里打字时不覆盖(帧/事件消息随时会到,抢输入框等于抢用户的手)
    if (D && D.activeElement && D.activeElement === S.el.urlInput) return;
    var value = S.url || "";
    if (S.el.urlInput.value !== value) S.el.urlInput.value = value;
  }

  function stageWidth() {
    var el = S.el;
    if (!el || !el.stage) return 0;
    var w = num(el.stage.clientWidth, 0);
    if (!w && el.stage.getBoundingClientRect) {
      try {
        w = num(el.stage.getBoundingClientRect().width, 0);
      } catch (e) {
        w = 0;
      }
    }
    return w;
  }

  function stageHeight() {
    var el = S.el;
    if (!el || !el.stage) return 0;
    var h = num(el.stage.clientHeight, 0);
    if (!h && el.stage.getBoundingClientRect) {
      try {
        h = num(el.stage.getBoundingClientRect().height, 0);
      } catch (e) {
        h = 0;
      }
    }
    return h;
  }

  /** 当前生效的缩放系数:fit 按 stage 双轴实时算,数字档直接用。 */
  function resolvedZoom() {
    if (S.zoom === "fit") return fitZoom(S.imgW, S.imgH, stageWidth(), stageHeight());
    return clampZoom(S.zoom);
  }

  function syncZoomButtons() {
    var el = S.el;
    if (!el || !el.zoomBar || !el.zoomBar.childNodes) return;
    var wanted = String(S.zoom);
    for (var i = 0; i < el.zoomBar.childNodes.length; i++) {
      var node = el.zoomBar.childNodes[i];
      if (!node || !node.getAttribute) continue;
      var isOn = node.getAttribute("data-zoom") === wanted;
      if (isOn) addClass(node, "on");
      else removeClass(node, "on");
      node.setAttribute("aria-pressed", isOn ? "true" : "false");
    }
  }

  function updateInfoText(z) {
    if (!S.el || !S.el.infoText) return;
    var scale = num(z, 0);
    if (!(scale > 0)) scale = resolvedZoom();
    var zoomText = S.zoom === "fit" ? "适配(" + Math.round(scale * 100) + "%)" : Math.round(scale * 100) + "%";
    S.el.infoText.textContent = "视口 " + S.viewport.width + "x" + S.viewport.height + " · 缩放 " + zoomText;
  }

  /** 缩放只影响面板显示(canvas 的 CSS 尺寸 + 覆盖层比例),绝不发命令改页面。 */
  function applyZoom() {
    var el = S.el;
    if (!el) return;
    if (!S.imgW || !S.imgH) {
      updateInfoText(0);
      return;
    }
    var z = resolvedZoom();
    var cssW = Math.max(1, Math.round(S.imgW * z));
    var cssH = Math.max(1, Math.round(S.imgH * z));
    S.cssW = cssW;
    S.cssH = cssH;
    if (el.canvas && el.canvas.style) {
      el.canvas.style.width = cssW + "px";
      el.canvas.style.height = cssH + "px";
    }
    renderHits();
    syncZoomButtons();
    updateInfoText(z);
  }

  function setZoom(value) {
    S.zoom = value === "fit" ? "fit" : clampZoom(value);
    applyZoom();
    savePrefs();
  }

  function hitRefAt(i) {
    var r = S.hits[i] || {};
    return String(r.ref == null ? "e" + (i + 1) : r.ref);
  }

  function renderHits() {
    var el = S.el;
    if (!el || !el.overlay) return;
    el.overlay.textContent = "";
    S.pickBox = null; // 命中区刷新,旧的反查结果作废
    if (!S.hits.length || !S.imgW) {
      updatePickHighlight();
      return;
    }
    var scale = S.cssW / S.imgW;
    for (var i = 0; i < S.hits.length; i++) {
      var r = S.hits[i] || {};
      var ref = hitRefAt(i);
      var box = make("div", "gbv-hit");
      box.setAttribute("data-ref", ref);
      box.style.left = Math.round(num(r.x, 0) * scale) + "px";
      box.style.top = Math.round(num(r.y, 0) * scale) + "px";
      box.style.width = Math.max(1, Math.round(num(r.w, 0) * scale)) + "px";
      box.style.height = Math.max(1, Math.round(num(r.h, 0) * scale)) + "px";
      box.title = ref + "(点击让 agent 点这里)";
      box.appendChild(make("span", "gbv-hit-ref", ref));
      el.overlay.appendChild(box);
    }
    updatePickHighlight();
  }

  /** chip 文案:title 优先,其次 URL 末段(去 query/hash),最后 id。 */
  function tabLabel(t, id) {
    var title = String((t && t.title) || "").trim();
    if (title) return title;
    var url = String((t && t.url) || "");
    var tail = url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
    if (tail) return tail;
    return id || "标签页";
  }

 /** owner 小徽标文案:human → [人];agent(taskId) → [agent];其余原样括起。 */
  function ownerBadgeText(owner) {
    var v = String(owner || "");
    if (!v) return "";
    if (v.indexOf("agent") === 0) return "[agent]";
    if (v === "human") return "[人]";
    return "[" + v + "]";
  }

  function renderTabs() {
    var el = S.el;
    if (!el || !el.tabs) return;
    el.tabs.textContent = "";
    if (!S.tabs.length) {
      el.tabs.appendChild(make("span", "gbv-tabs-empty", "无标签页"));
      return;
    }
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i] || {};
      var id = t.id == null ? "" : String(t.id);
      var owner = String(t.owner || "");
      var tip = String(t.url || id);
      if (owner) tip = tip + " · owner=" + owner;
      var chip = makeButton("gbv-tab", "", tip);
      chip.setAttribute("data-tab-id", id);
      if ((S.tabId && id === String(S.tabId)) || (!S.tabId && t.active)) addClass(chip, "on");
      chip.appendChild(make("span", "gbv-tab-label", tabLabel(t, id)));
      var badgeText = ownerBadgeText(owner);
      if (badgeText) {
        var badge = make("span", "gbv-owner", badgeText);
        if (owner.indexOf("agent") === 0) addClass(badge, "gbv-owner-agent");
        chip.appendChild(badge);
      }
      el.tabs.appendChild(chip);
    }
  }

  /** stage 四态渲染:空态 / 加载态(isLoading 且无帧)/ 错误态(含崩溃特例)/ 正常态。
   *  形态来源: ref/.../EmbeddedBrowserPaneParts.tsx(空态 Globe、加载 LoaderIcon、
   *  错误 TriangleAlert+重试、崩溃 guestFailure+重载)。 */
  function syncStageState() {
    var el = S.el;
    if (!el) return;
    var hasTab = !!S.tabId;
    var hasFrame = !!(S.imgW && S.imgH);
    var showError = hasTab && !!S.errorMessage;
    var showLoading = hasTab && !showError && S.isLoading && !hasFrame;
    var showFrame = hasTab && !showError && !showLoading;
    setDisplay(el.empty, !hasTab);
    setDisplay(el.error, showError);
    setDisplay(el.loading, showLoading);
    setDisplay(el.canvas, showFrame);
    setDisplay(el.overlay, showFrame);
    setDisplay(el.handles, showFrame);
    if (el.enable) el.enable.style.display = S.subFail && !hasTab ? "inline-block" : "none";
    if (showError && el.errorText) el.errorText.textContent = S.errorMessage || "";
    if (showError && el.errorRetry) el.errorRetry.textContent = S.crashed ? "重载" : "重试";
  }

  /** 后退/前进 disabled 绑 canGoBack/canGoForward;刷新 isLoading 时旋转。 */
  function syncNavButtons() {
    var el = S.el;
    if (!el) return;
    if (el.back) el.back.disabled = !S.canGoBack;
    if (el.forward) el.forward.disabled = !S.canGoForward;
    if (el.reload) {
      if (S.isLoading) addClass(el.reload, "gbv-spin");
      else removeClass(el.reload, "gbv-spin");
    }
  }

  function syncVpInputs() {
    var el = S.el;
    if (!el) return;
    var focus = D && D.activeElement ? D.activeElement : null;
    if (el.wInput && focus !== el.wInput) {
      var w = String(S.viewport.width);
      if (el.wInput.value !== w) el.wInput.value = w;
    }
    if (el.hInput && focus !== el.hInput) {
      var h = String(S.viewport.height);
      if (el.hInput.value !== h) el.hInput.value = h;
    }
  }

  /** 把手 aria-valuemin/max/now 随尺寸更新(角把手两轴都在动,aria 单值给宽度轴)。 */
  function syncHandleAria() {
    var el = S.el;
    if (!el || !el.handleNodes) return;
    for (var i = 0; i < el.handleNodes.length; i++) {
      var entry = el.handleNodes[i];
      var axes = HANDLE_AXES[entry.key] || { width: 0, height: 0 };
      var isWidth = axes.width !== 0;
      var node = entry.node;
      if (!node || !node.setAttribute) continue;
      node.setAttribute("aria-valuemin", String(isWidth ? VP_MIN_W : VP_MIN_H));
      node.setAttribute("aria-valuemax", String(isWidth ? VP_MAX_W : VP_MAX_H));
      node.setAttribute("aria-valuenow", String(isWidth ? S.viewport.width : S.viewport.height));
    }
  }

  function syncHumanVisuals() {
    var el = S.el;
    if (!el) return;
    if (S.humanMode) {
      addClass(el.root, "gbv-human-mode");
      addClass(el.toolbar, "gbv-human-mode"); // 按钮组整体进人工态(灰化/只读观感)
    } else {
      removeClass(el.root, "gbv-human-mode");
      removeClass(el.toolbar, "gbv-human-mode");
    }
    if (el.urlInput) el.urlInput.readOnly = !!S.humanMode;
    // badge 的 CSS 基础态就是 display:none:setDisplay 用 "" 只会回落到这条规则,
 // 所以这里必须显式给 inline-block,否则「人工模式」徽标永远看不见(经验证踩过)。
    if (el.badge) el.badge.style.display = S.humanMode ? "inline-block" : "none";
    if (el.human) el.human.textContent = S.humanMode ? "回到 agent 模式" : "人接管";
  }

  function clearFrame() {
    S.imgW = 0;
    S.imgH = 0;
    S.cssW = 0;
    S.cssH = 0;
    S.hits = [];
    S.pickBox = null;
    if (S.el && S.el.overlay) S.el.overlay.textContent = "";
    if (S.el && S.el.canvas) {
      try {
        S.el.canvas.width = 1;
        S.el.canvas.height = 1;
      } catch (e) {
        // canvas 尺寸设置失败不影响后续帧
      }
      if (S.el.canvas.style) {
        S.el.canvas.style.width = "";
        S.el.canvas.style.height = "";
      }
    }
    updateInfoText(0);
  }

  // ---- tabs 状态维护 ----

  function findTab(id) {
    for (var i = 0; i < S.tabs.length; i++) {
      if (S.tabs[i] && String(S.tabs[i].id) === String(id)) return S.tabs[i];
    }
    return null;
  }

  function upsertCurrentTab() {
    var id = S.tabId;
    if (!id) return;
    var found = null;
    for (var i = 0; i < S.tabs.length; i++) {
      if (S.tabs[i] && String(S.tabs[i].id) === String(id)) found = S.tabs[i];
    }
    if (!found) {
      S.tabs.push({ id: id, url: S.url || "", title: S.title || "", active: true });
    } else {
      if (S.url) found.url = S.url;
      if (S.title) found.title = S.title;
    }
    renderTabs();
  }

  function removeTab(id) {
    if (id == null) return;
    var next = [];
    for (var i = 0; i < S.tabs.length; i++) {
      if (S.tabs[i] && String(S.tabs[i].id) !== String(id)) next.push(S.tabs[i]);
    }
    S.tabs = next;
    if (String(S.tabId) === String(id)) {
      if (S.tabs.length) {
        S.tabId = S.tabs[0].id;
        S.url = S.tabs[0].url || "";
        S.title = S.tabs[0].title || "";
        S.lastSeq = -1;
        S.isLoading = true;
        S.errorMessage = null;
        S.crashed = false;
        clearFrame();
        setStatus("载入中:等待画面");
      } else {
        S.tabId = null;
        S.url = "";
        S.title = "";
        S.isLoading = false;
        S.errorMessage = null;
        S.crashed = false;
        clearFrame();
        setStatus("无 tab");
      }
      syncNavButtons();
    }
    syncStageState();
    renderTabs();
    updateAddress();
  }

  function selectTab(id) {
    if (id == null || id === "") return;
    if (String(S.tabId) === String(id)) return;
    S.tabId = id;
    var t = findTab(id);
    S.url = t && t.url ? t.url : "";
    S.title = t && t.title ? t.title : "";
    S.lastSeq = -1;
    S.isLoading = true;
    S.errorMessage = null;
    S.crashed = false;
    clearFrame();
    renderTabs();
    syncStageState();
    syncNavButtons();
    updateAddress();
    setStatus("载入中:切换标签页");
    sendOpen(id);
  }

  // ---- 导航状态轮询(后退/前进按钮的 canGoBack/canGoForward 数据源) ----

  /** 经 ctx.send 发 browser.view.command{action:"getState"};订阅成功即发、每次 nav 后 2s 补发。
   *  只读探测,不经 command() 的人工模式闸(人工模式下按钮状态仍有观察意义)。 */
  function pollNavigationState(delayMs) {
    if (!S.mounted) return;
    if (S.stateTimer) clearTimer(S.stateTimer);
    S.stateTimer = setTimer(function () {
      S.stateTimer = 0;
      if (!S.mounted || !S.tabId) return;
      var payload = { type: "browser.view.command", action: "getState", args: {}, tabId: S.tabId };
      send(payload);
    }, num(delayMs, 0));
  }

  // ---- 滚轮链(形态来源: useEmbeddedBrowserWheelChain.ts) ----

  function stageOverflowing() {
    var h = stageHeight();
    if (!(h > 0)) return false;
    return S.cssH > h + 1;
  }

  function flushScroll() {
    S.scrollTimer = 0;
    var dx = S.pendingScrollX;
    var dy = S.pendingScroll;
    S.pendingScrollX = 0;
    S.pendingScroll = 0;
    if (!dx && !dy) return;
    S.lastScrollAt = Date.now ? Date.now() : 0;
    var args = { op: "scroll" };
    if (dx) args.deltaX = Math.round(dx);
    if (dy) args.deltaY = Math.round(dy);
    command("cua", args);
  }

  /** 滚轮增量合并下发(120ms 节流):纵向 deltaY + 触控板横向 deltaX 都透传(cua 支持 deltaX)。 */
  function queueScroll(deltaX, deltaY) {
    var dx = num(deltaX, 0);
    var dy = num(deltaY, 0);
    if (!dx && !dy) return;
    var now = Date.now ? Date.now() : 0;
    var elapsed = now - S.lastScrollAt;
    if (elapsed >= WHEEL_THROTTLE_MS) {
      S.lastScrollAt = now;
      var args = { op: "scroll" };
      if (dx) args.deltaX = Math.round(dx);
      if (dy) args.deltaY = Math.round(dy);
      command("cua", args);
      return;
    }
    S.pendingScrollX += dx;
    S.pendingScroll += dy;
    if (!S.scrollTimer) S.scrollTimer = setTimer(flushScroll, WHEEL_THROTTLE_MS - elapsed);
  }

  function onWheel(ev) {
    if (!S.mounted || !S.el || !ev) return;
    if (!S.imgW) return; // 没有画面就不抢事件
    var decision = wheelDecision({
      ctrl: !!(ev.ctrlKey || ev.metaKey),
      meta: false,
      deltaX: num(ev.deltaX, 0),
      deltaY: num(ev.deltaY, 0),
      overflowing: stageOverflowing()
    });
    /* 2026-11 实修:抢到滚轮后必须 stopPropagation——画布模式外壳(canvas-shell.js)在祖先上
     * 也挂了 wheel 做「无限画布平移」,只 preventDefault 拦不住它(JS 监听照跑),面板整卡
 * 会被滚出视口(E2E 经验证 stage top 348 → -252)。两者互斥:指针在页面画布上时滚轮归页面。 */
    var handled = decision === "zoom" || decision === "scroll";
    if (handled) {
      if (typeof ev.preventDefault === "function") ev.preventDefault();
      if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    }
    if (decision === "zoom") {
      var base = resolvedZoom();
      var dir = num(ev.deltaY, 0) > 0 ? -1 : 1;
      setZoom(clampZoom(base + dir * ZOOM_STEP));
      return;
    }
    if (decision === "scroll") {
      queueScroll(num(ev.deltaX, 0), num(ev.deltaY, 0));
      return;
    }
    // pass:不 preventDefault,让外层容器自己滚(当前判定表不会产出 pass)
  }

  // ---- 视口拖拽(形态来源: ResponsiveBrowserResizeHandles.tsx) ----

  function endDrag() {
    S.dragging = false;
    if (!S.drag) return;
    S.drag = null;
    clearDragListeners();
    if (S.el) removeClass(S.el.root, "gbv-dragging");
    command("viewport_set", { width: S.viewport.width, height: S.viewport.height });
    syncVpInputs();
    syncHandleAria();
    savePrefs();
  }

  function onDragMove(ev) {
    if (!S.drag) return;
    var next = nextViewportForDrag(
      S.drag.start,
      num(ev.clientX, 0) - S.drag.x,
      num(ev.clientY, 0) - S.drag.y,
      S.drag.handle
    );
    S.viewport = next; // 拖拽期间只更新本地,松手才发一条命令
    updateInfoText(0);
    syncVpInputs();
    syncHandleAria();
  }

  function beginDrag(handleKey, ev) {
    if (!S.mounted || !S.el) return;
    if (typeof ev.button === "number" && ev.button !== 0) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    S.dragging = true; // onFrame 在此期间不得回写 viewport(否则拖拽会被服务端帧抖回来)
    S.drag = {
      handle: handleKey,
      x: num(ev.clientX, 0),
      y: num(ev.clientY, 0),
      start: { width: S.viewport.width, height: S.viewport.height }
    };
    addClass(S.el.root, "gbv-dragging");
    // 优先 pointer capture:把手甩出窗口也能续收 move/up;不支持/抛错时退回 window 级监听
    var target = ev.target || ev.srcElement;
    try {
      if (target && typeof target.setPointerCapture === "function" && ev.pointerId != null) {
        target.setPointerCapture(ev.pointerId);
      }
    } catch (e) {
      // 老浏览器/指针已释放:下面的 window 监听就是兜底路径
    }
    onDrag(W, "pointermove", onDragMove);
    onDrag(W, "pointerup", endDrag);
    onDrag(W, "pointercancel", endDrag);
  }

  /** 键盘微调:Arrow=1px、Shift+Arrow=10px、Home/End=最小/最大;即时更新本地预览,
   *  viewport_set 200ms 防抖提交一次。 */
  function onHandleKeyDown(handleKey, ev) {
    if (!ev) return;
    var axes = HANDLE_AXES[handleKey] || { width: 0, height: 0 };
    var key = String(ev.key || "");
    var step = ev.shiftKey ? KB_STEP_BIG : KB_STEP_PX;
    var next;
    if (key === "Home" || key === "End") {
      if (typeof ev.preventDefault === "function") ev.preventDefault();
      var toMin = key === "Home";
      next = { width: S.viewport.width, height: S.viewport.height };
      if (axes.width !== 0) next.width = toMin ? VP_MIN_W : VP_MAX_W;
      if (axes.height !== 0) next.height = toMin ? VP_MIN_H : VP_MAX_H;
      applyViewportPreview(next);
      return;
    }
    var dx = 0;
    var dy = 0;
    if (key === "ArrowLeft") dx = -step;
    else if (key === "ArrowRight") dx = step;
    else if (key === "ArrowUp") dy = -step;
    else if (key === "ArrowDown") dy = step;
    else return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    if (!dx && !dy) return;
    applyViewportPreview(nextViewportForDrag(S.viewport, dx, dy, handleKey));
  }

  function applyViewportPreview(next) {
    S.viewport = {
      width: clampViewportDimension(num(next && next.width, S.viewport.width)),
      height: clampViewportDimension(num(next && next.height, S.viewport.height))
    };
    updateInfoText(0);
    syncVpInputs();
    syncHandleAria();
    if (S.vpCommitTimer) clearTimer(S.vpCommitTimer);
    S.vpCommitTimer = setTimer(function () {
      S.vpCommitTimer = 0;
      if (!S.mounted) return;
      command("viewport_set", { width: S.viewport.width, height: S.viewport.height });
      savePrefs();
    }, VP_COMMIT_DEBOUNCE_MS);
  }

  // ---- 宽高数字输入 ----

  function readVpInput(input, min, max) {
    var raw = input && input.value != null ? String(input.value) : "";
    var n = parseFloat(raw);
    var ok = isFinite(n) && n >= min && n <= max;
    if (input && input.setAttribute) input.setAttribute("aria-invalid", ok ? "false" : "true");
    return ok ? Math.round(n) : null;
  }

  function commitVpInput(which) {
    var el = S.el;
    if (!el) return;
    var input = which === "h" ? el.hInput : el.wInput;
    if (!input) return;
    var min = which === "h" ? VP_MIN_H : VP_MIN_W;
    var max = which === "h" ? VP_MAX_H : VP_MAX_W;
    var n = readVpInput(input, min, max);
    if (n == null) {
      setStatus("视口" + (which === "h" ? "高" : "宽") + "需在 " + min + ".." + max + " 之间");
      return;
    }
    var prev = which === "h" ? S.viewport.height : S.viewport.width;
    if (n === prev) {
      syncVpInputs();
      return;
    }
    S.viewport = {
      width: which === "h" ? S.viewport.width : n,
      height: which === "h" ? n : S.viewport.height
    };
    updateInfoText(0);
    syncVpInputs();
    syncHandleAria();
    command("viewport_set", { width: S.viewport.width, height: S.viewport.height });
    setStatus("已请求视口 " + S.viewport.width + "x" + S.viewport.height);
    savePrefs();
  }

  // ---- 元素拾取(形态来源: BrowserToolbar 的 MousePointerClick 拾取按钮) ----

  function setPicking(flag) {
    S.picking = !!flag;
    var el = S.el;
    if (!el) return;
    if (S.picking) {
      addClass(el.root, "gbv-picking");
      if (el.pick) addClass(el.pick, "on");
      setStatus("拾取模式:点击画面元素复制其 ref");
    } else {
      removeClass(el.root, "gbv-picking");
      if (el.pick) removeClass(el.pick, "on");
      S.pickBox = null;
      setStatus(S.tabId ? "已连接" : "无 tab");
    }
    updatePickHighlight();
  }

  /** 坐标反查:把 stage 内的鼠标坐标换回截图坐标,找包含它的最小 hitRegion(最内层元素)。
   *  2026-11:无命中(或根本没有 hitRegions)时也返回换算后的 point,供 overlay 空白点击发 cua click;
   *  命中项原有字段 {ref,x,y,w,h} 形状不变,只追加 point。 */
  function hitTestAt(clientX, clientY) {
    var el = S.el;
    if (!el || !el.canvas || !S.imgW) return null;
    var rect = null;
    try {
      if (typeof el.canvas.getBoundingClientRect === "function") rect = el.canvas.getBoundingClientRect();
    } catch (e) {
      rect = null;
    }
    if (!rect) return null;
    var cssW = num(rect.width, S.cssW);
    var scale = S.imgW ? cssW / S.imgW : 0;
    if (!(scale > 0)) return null;
    var x = (num(clientX, 0) - num(rect.left, 0)) / scale;
    var y = (num(clientY, 0) - num(rect.top, 0)) / scale;
    var point = { x: x, y: y };
    var best = null;
    var bestArea = Infinity;
    for (var i = 0; i < S.hits.length; i++) {
      var r = S.hits[i] || {};
      var rx = num(r.x, 0);
      var ry = num(r.y, 0);
      var rw = num(r.w, 0);
      var rh = num(r.h, 0);
      if (x < rx || x > rx + rw || y < ry || y > ry + rh) continue;
      var area = rw * rh;
      if (area <= bestArea) {
        bestArea = area;
        best = { ref: hitRefAt(i), x: rx, y: ry, w: rw, h: rh };
      }
    }
    if (!best) return { ref: "", x: 0, y: 0, w: 0, h: 0, point: point };
    best.point = point;
    return best;
  }

  function updatePickHighlight() {
    var el = S.el;
    if (!el || !el.pickHl || !el.overlay) return;
    var box = S.picking ? S.pickBox : null;
    if (!box || !box.ref || !S.imgW) {
      if (el.pickHl.parentNode && typeof el.pickHl.parentNode.removeChild === "function") {
        el.pickHl.parentNode.removeChild(el.pickHl);
      }
      return;
    }
    var scale = S.cssW / S.imgW;
    el.pickHl.style.left = Math.round(num(box.x, 0) * scale) + "px";
    el.pickHl.style.top = Math.round(num(box.y, 0) * scale) + "px";
    el.pickHl.style.width = Math.max(1, Math.round(num(box.w, 0) * scale)) + "px";
    el.pickHl.style.height = Math.max(1, Math.round(num(box.h, 0) * scale)) + "px";
    el.overlay.appendChild(el.pickHl);
  }

  function onStageMouseMove(ev) {
    if (!S.picking || !ev) return;
    S.pickBox = hitTestAt(num(ev.clientX, 0), num(ev.clientY, 0));
    updatePickHighlight();
  }

  function onStageClick(ev) {
    if (!S.picking) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    var box = closestClass(ev && ev.target, "gbv-hit");
    var ref = "";
    if (box && box.getAttribute) ref = String(box.getAttribute("data-ref") || "");
    if (!ref && S.pickBox) ref = String(S.pickBox.ref || "");
    if (ref) copyText(ref, "已复制 " + ref + ",粘贴给 agent");
  }

  /** 写剪贴板,失败静默(权限拒绝/无剪贴板 API 都不炸);okStatus 照常提示。 */
  function copyText(text, okStatus) {
    var value = String(text == null ? "" : text);
    var nav = W && W.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
      try {
        var p = nav.clipboard.writeText(value);
        if (p && typeof p.then === "function") {
          p.then(function () {}, function () {});
        }
      } catch (e) {
        // 剪贴板权限被拒:静默
      }
    }
    if (okStatus) setStatus(okStatus);
  }

  // ---- ⋮ 更多菜单(DevTools 不做:本仓无 guest,ref 的 devtools 面板没有对应物) ----

  function toggleMenu(open) {
    var el = S.el;
    if (!el || !el.menu) return;
    S.menuOpen = arguments.length > 0 ? !!open : !S.menuOpen;
    if (S.menuOpen) addClass(el.menu, "on"); // 与选中态同一修饰类约定,不引入裸 .open 规则
    else removeClass(el.menu, "on");
  }

  function openCurrentExternal() {
    var url = S.url || "";
    if (isExternalOpenable(url)) {
      openExternal(url);
      return;
    }
    setStatus("当前页面不能在系统浏览器打开");
  }

  // ---- 人接管态(形态来源: HumanBrowserView.tsx) ----

  function setHumanMode(flag) {
    var next = !!flag;
    if (next === S.humanMode) {
      syncHumanVisuals();
      return;
    }
    S.humanMode = next;
    syncHumanVisuals();
    if (S.humanMode) {
      setStatus("人工模式:请在本机浏览器窗口操作,面板只读观察");
      var target = S.url || "";
      if (isExternalOpenable(target)) openExternal(target);
      return;
    }
    setStatus(S.tabId ? "已连接" : "无 tab");
    sendOpen(S.tabId || null); // 回到 agent 模式重新订阅,继续收帧
  }

  // ---- 用户动作 ----

  function navigateCommand(op) {
    S.lastNav = { kind: "navigate", op: op };
    S.isLoading = true;
    S.errorMessage = null;
    S.crashed = false;
    syncNavButtons();
    syncStageState();
    command("navigate", { op: op });
    setStatus("载入中(" + op + ")");
  }

  function navigateFromAddress() {
    if (!S.el || !S.el.urlInput) return;
    var raw = String(S.el.urlInput.value == null ? "" : S.el.urlInput.value);
    if (!raw.trim()) {
      setStatus("请先在地址栏输入网址");
      return;
    }
    var url = normalizeUrl(raw);
    if (!url) {
      setStatus(BAD_PROTOCOL_TEXT);
      return;
    }
    S.el.urlInput.value = url;
    S.url = url;
    S.lastSeq = -1;
    S.isLoading = true;
    S.errorMessage = null;
    S.crashed = false;
    syncNavButtons();
    if (!S.tabId) {
      // 还没有 tab:直接把 URL 交给 agent 新开,拿到 subscribed 帧后再接上
      S.lastNav = { kind: "open", url: url };
      syncStageState();
      command("open", { url: url });
      setStatus("载入中:等待 agent 新开标签页");
      return;
    }
    S.lastNav = { kind: "navigate", op: "url", url: url };
    syncStageState();
    command("navigate", { op: "url", url: url });
    setStatus("载入中:" + url);
  }

  function createTab() {
    var raw = String((S.el && S.el.urlInput && S.el.urlInput.value) || "");
    var url = raw.trim() ? normalizeUrl(raw) : "";
    if (raw.trim() && !url) {
      setStatus(BAD_PROTOCOL_TEXT);
      return;
    }
    if (!url) url = DEFAULT_URL;
    S.lastNav = { kind: "open", url: url };
    S.isLoading = true;
    S.errorMessage = null;
    S.crashed = false;
    syncNavButtons();
    syncStageState();
    command("open", { url: url });
    setStatus("载入中:等待 agent 新开标签页");
  }

  /** 错误态重试:崩溃态发 navigate reload;其余重发最近一次 navigate/open。 */
  function retryFromError() {
    var wasCrashed = S.crashed; // 先存:下面马上清标志
    S.errorMessage = null;
    S.crashed = false;
    S.isLoading = true;
    syncNavButtons();
    syncStageState();
    if (wasCrashed || !S.lastNav) {
      S.lastNav = { kind: "navigate", op: "reload" };
      command("navigate", { op: "reload" });
      setStatus("载入中(reload)");
      return;
    }
    if (S.lastNav.kind === "open" && S.lastNav.url) {
      command("open", { url: S.lastNav.url });
      setStatus("载入中:重开 " + S.lastNav.url);
      return;
    }
    if (S.lastNav.kind === "navigate" && S.lastNav.url) {
      command("navigate", { op: "url", url: S.lastNav.url });
      setStatus("载入中:" + S.lastNav.url);
      return;
    }
    command("navigate", { op: S.lastNav.op || "reload" });
    setStatus("载入中(" + (S.lastNav.op || "reload") + ")");
  }

  // ---- 人类输入通道 & tab 栏刷新(2026-11 人机随时可用轮) ----

  var ENABLE_RESUBSCRIBE_MS = 600;

  function sendTypeText() {
    var el = S.el;
    if (!el || !el.typeInput) return;
    var text = String(el.typeInput.value == null ? "" : el.typeInput.value);
    if (!text) {
      setStatus("先在输入框写要输入的文字");
      return;
    }
    S.typeDraft = text;
    if (!command("cua", { op: "type", text: text })) return;
    setStatus("已发送输入（先点页面里输入框让它获得焦点）");
    el.typeInput.value = "";
    S.typeDraft = "";
  }

  function sendKey(key) {
    var k = String(key || "");
    if (!k) return;
    if (!command("press", { key: k })) return;
    setStatus("已发送按键 " + k);
  }

  /** 订阅失败(多为 browser.enabled=false):落盘 cfg 再重订阅,人不用先去设置页翻开关。 */
  function enableBrowser() {
    var ok = send({ type: "cfg.set", patch: { browser: { enabled: true } } });
    if (!ok) {
      setStatus("开启失败:连接未就绪");
      return;
    }
    S.subFail = false;
    syncStageState();
    setStatus("已开启浏览器控制，正在打开…");
    setTimer(function () {
      if (!S.mounted) return;
      sendOpen(null); // 重订阅:服务端开 browser 后才会回 subscribed
    }, ENABLE_RESUBSCRIBE_MS);
  }

  /** 读操作,不经 command() 的人工模式闸:人工模式下 tab 栏也得能刷新/观察。 */
  function refreshTabs() {
    if (!S.mounted) return false;
    var payload = { type: "browser.view.command", action: "tabs", args: {} };
    if (S.tabId) payload.tabId = S.tabId;
    return send(payload);
  }

  /** action==="tabs" 回执:[{id,url,title,active,owner}] 是权威口径(含 owner,agent 开的 tab 也有人看得见)。 */
  function applyTabsPayload(list) {
    if (!list || typeof list.slice !== "function") return false;
    var next = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i] || {};
      next.push({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        active: !!t.active,
        owner: String(t.owner == null ? "" : t.owner)
      });
    }
    S.tabs = next;
    renderTabs();
    return true;
  }

  function onOverlayClick(ev) {
    if (S.picking) return; // 拾取模式点击走 onStageClick,不触发 agent 点击
    var box = closestClass(ev && ev.target, "gbv-hit");
    var ref = box && box.getAttribute ? box.getAttribute("data-ref") : "";
    if (ref) {
      // act 的 ref 形态本仓接受字符串或数组;字符串更稳妥
      command("act", { op: "click", ref: String(ref) });
      setStatus("已让 agent 点击 " + ref);
      return;
    }
    // 未命中 ref(人类自己 open 的页根本没有 hitRegions):空白处点击按缩放换算成页面坐标点击
    var hit = hitTestAt(num(ev && ev.clientX, 0), num(ev && ev.clientY, 0));
    if (!hit || !hit.point) return;
    var x = Math.round(hit.point.x);
    var y = Math.round(hit.point.y);
    if (!command("cua", { op: "click", x: x, y: y })) return;
    setStatus("已点击页面坐标 (" + x + ", " + y + ")");
  }

  function onTabsClick(ev) {
    var chip = closestClass(ev && ev.target, "gbv-tab");
    if (!chip || !chip.getAttribute) return;
    var id = chip.getAttribute("data-tab-id");
    if (id) selectTab(id);
  }

  function onZoomClick(ev) {
    var btn = closestClass(ev && ev.target, "gbv-zoom-btn");
    if (!btn || !btn.getAttribute) return;
    var raw = btn.getAttribute("data-zoom");
    setZoom(raw === "fit" ? "fit" : parseFloat(raw));
  }

  function onPresetsClick(ev) {
    var btn = closestClass(ev && ev.target, "gbv-preset");
    if (!btn || !btn.getAttribute) return;
    var w = clampViewportDimension(parseFloat(btn.getAttribute("data-w")));
    var h = clampViewportDimension(parseFloat(btn.getAttribute("data-h")));
    S.viewport = { width: w, height: h };
    updateInfoText(0);
    syncVpInputs();
    syncHandleAria();
    command("viewport_set", { width: w, height: h });
    setStatus("已请求视口 " + w + "x" + h);
    savePrefs();
  }

  function bindEvents() {
    var el = S.el;
    on(el.back, "click", function () {
      navigateCommand("back");
    });
    on(el.forward, "click", function () {
      navigateCommand("forward");
    });
    on(el.reload, "click", function () {
      navigateCommand("reload");
    });
    on(el.go, "click", navigateFromAddress);
    on(el.typeBtn, "click", sendTypeText);
    on(el.typeInput, "keydown", function (ev) {
      if (ev && ev.key === "Enter") {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        sendTypeText();
      }
    });
    on(el.keyEnter, "click", function () {
      sendKey("Enter");
    });
    on(el.keyEsc, "click", function () {
      sendKey("Escape");
    });
    on(el.keyTab, "click", function () {
      sendKey("Tab");
    });
    on(el.enable, "click", enableBrowser);
    on(el.urlInput, "keydown", function (ev) {
      if (!ev) return;
      if (ev.key === "Enter") {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        navigateFromAddress();
        return;
      }
      if (ev.key === "Escape") {
        if (S.el && S.el.urlInput) {
          S.el.urlInput.value = S.url || "";
          if (typeof S.el.urlInput.blur === "function") S.el.urlInput.blur();
        }
      }
    });
    on(el.wInput, "keydown", function (ev) {
      if (ev && ev.key === "Enter") {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        commitVpInput("w");
      }
    });
    on(el.wInput, "blur", function () {
      commitVpInput("w");
    });
    on(el.hInput, "keydown", function (ev) {
      if (ev && ev.key === "Enter") {
        if (typeof ev.preventDefault === "function") ev.preventDefault();
        commitVpInput("h");
      }
    });
    on(el.hInput, "blur", function () {
      commitVpInput("h");
    });
    on(el.shot, "click", function () {
      command("shot", {});
      setStatus("已请求视口截图");
    });
    on(el.shotFull, "click", function () {
      command("shot", { fullPage: true });
      setStatus("已请求全页截图");
    });
    on(el.human, "click", function () {
      setHumanMode(!S.humanMode);
    });
    on(el.pick, "click", function () {
      setPicking(!S.picking);
    });
    on(el.more, "click", function () {
      toggleMenu();
    });
    on(el.menuOpenExternal, "click", function () {
      toggleMenu(false);
      openCurrentExternal();
    });
    on(el.menuCopyUrl, "click", function () {
      toggleMenu(false);
      copyText(S.url || "", "URL 已复制");
    });
    on(el.menuReload, "click", function () {
      toggleMenu(false);
      navigateCommand("reload");
    });
    on(el.errorRetry, "click", retryFromError);
    on(el.root, "click", function (ev) {
      if (!S.menuOpen) return;
      var t = ev && ev.target;
      if (closestClass(t, "gbv-menu") || closestClass(t, "gbv-more")) return;
      toggleMenu(false);
    });
    on(el.root, "keydown", function (ev) {
      if (S.menuOpen && ev && ev.key === "Escape") toggleMenu(false);
    });
    on(el.newBtn, "click", createTab);
    on(el.stage, "wheel", onWheel, { passive: false });
    on(el.stage, "mousemove", onStageMouseMove);
    on(el.stage, "click", onStageClick);
    on(el.overlay, "click", onOverlayClick);
    on(el.tabs, "click", onTabsClick);
    on(el.zoomBar, "click", onZoomClick);
    on(el.presets, "click", onPresetsClick);
    for (var i = 0; i < el.handleNodes.length; i++) {
      (function (entry) {
        on(entry.node, "pointerdown", function (ev) {
          beginDrag(entry.key, ev);
        });
        on(entry.node, "keydown", function (ev) {
          onHandleKeyDown(entry.key, ev);
        });
      })(el.handleNodes[i]);
    }
    on(W, "resize", function () {
      applyZoom();
    });
    on(W, "blur", function () {
      // 拖拽中失焦(切窗/锁屏):立即结束并提交,防止 pointerup 丢失后把手卡在拖拽态
      endDrag();
    });
  }

  // ---- 消息处理 ----

  function onFrame(msg) {
    var seq = num(msg.seq, -1);
    var hasSeq = typeof msg.seq === "number" && isFinite(msg.seq);
    if (hasSeq && seq <= S.lastSeq) return; // 防乱序:旧帧直接丢弃
    if (msg.tabId && S.tabId && String(msg.tabId) !== String(S.tabId)) return; // 别的 tab 的帧
    if (msg.tabId) S.tabId = msg.tabId;
    if (hasSeq) S.lastSeq = seq;
    // 拖拽期不回写:服务端 viewport 帧与本地拖拽互相覆盖会来回抖,松手后才对齐
    if (!S.dragging && msg.viewport && msg.viewport.width) {
      S.viewport = {
        width: clampViewportDimension(msg.viewport.width),
        height: clampViewportDimension(msg.viewport.height == null ? S.viewport.height : msg.viewport.height)
      };
      syncVpInputs();
      syncHandleAria();
    }
    if (msg.url) S.url = String(msg.url);
    if (msg.title != null) S.title = String(msg.title);
    S.hits = msg.hitRegions && msg.hitRegions.length ? msg.hitRegions.slice() : [];
    upsertCurrentTab();
    updateAddress();
    setStatus("已连接");
    applyZoom();
    syncStageState();

    var image = makeImage();
    if (!image) return;
    image.onload = function () {
      if (!S.mounted || !S.el) return;
      var w = num(msg.width, 0);
      var h = num(msg.height, 0);
      if (!(w > 0)) w = num(image.naturalWidth, 0) || num(image.width, 0);
      if (!(h > 0)) h = num(image.naturalHeight, 0) || num(image.height, 0);
      S.imgW = Math.max(1, Math.round(w));
      S.imgH = Math.max(1, Math.round(h));
      var canvas = S.el.canvas;
      if (canvas) {
        try {
          canvas.width = S.imgW;
          canvas.height = S.imgH;
          var g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
          if (g) {
            g.clearRect(0, 0, S.imgW, S.imgH);
            g.drawImage(image, 0, 0);
          }
        } catch (e) {
          // 绘制失败:保留上一帧,不清空画面
        }
      }
      // 帧真正画出来了:错误态(解码失败/崩溃残留)解除
      S.errorMessage = null;
      S.crashed = false;
      applyZoom();
      syncStageState();
    };
    image.onerror = function () {
      // 解码失败不再静默:给出可重试的错误态,否则用户只看到上一帧或黑屏
      if (!S.mounted) return;
      S.errorMessage = "截图解码失败";
      S.crashed = false;
      syncStageState();
      setStatus("截图解码失败");
    };
    image.src = "data:image/jpeg;base64," + String(msg.imageB64 == null ? "" : msg.imageB64);
  }

  function onEvent(msg) {
    var kind = String(msg.kind || "");
    if (kind === "nav") {
      if (msg.url) S.url = String(msg.url);
      if (msg.title != null) S.title = String(msg.title);
      S.isLoading = true;
      S.errorMessage = null;
      S.crashed = false;
      upsertCurrentTab();
      updateAddress();
      syncNavButtons();
      syncStageState();
      setStatus("载入中:" + (S.url || ""));
      pollNavigationState(NAV_POLL_DELAY_MS); // 每次 nav 2s 后补一发 getState 对齐 canGoBack/Forward
      refreshTabs(); // 导航后 tab 栏的 url/title 已过期
      return;
    }
    if (kind === "load") {
      if (msg.url) S.url = String(msg.url);
      if (msg.title != null) S.title = String(msg.title);
      S.isLoading = false;
      S.errorMessage = null;
      S.crashed = false;
      upsertCurrentTab();
      updateAddress();
      syncNavButtons();
      syncStageState();
      setStatus("已连接");
      refreshTabs(); // load 后 title 才定稿,重拉一次让 chip 文案跟上
      return;
    }
    if (kind === "close") {
      if (msg.tabId) removeTab(msg.tabId);
      refreshTabs(); // 别人关的 tab 也要从栏里消失
      return;
    }
    if (kind === "crash") {
      // 崩溃态 = 错误态特例:文案固定,重试按钮发 navigate reload
      S.isLoading = false;
      S.errorMessage = "页面崩溃";
      S.crashed = true;
      syncNavButtons();
      syncStageState();
      setStatus("页面崩溃:" + (msg.message ? String(msg.message) : "浏览器进程异常"));
      return;
    }
  }

  function onSubscribed(msg) {
    var prevTabId = S.tabId;
    // tabs 列表在场时它是权威口径:tabs:[] 必须把当前 tab 清掉,
    // 否则关掉最后一个 tab 后面板会停在「有画面但服务端没有 tab」的假活状态。
    if (msg.tabs && typeof msg.tabs.slice === "function") {
      var tabs = msg.tabs.slice();
      S.tabs = [];
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i] || {};
        S.tabs.push({ id: t.id, url: t.url || "", title: t.title || "", active: !!t.active });
      }
      if (msg.tabId && findTab(msg.tabId)) S.tabId = msg.tabId;
      else if (S.tabId && findTab(S.tabId)) S.tabId = S.tabId;
      else {
        S.tabId = null;
        for (var j = 0; j < S.tabs.length; j++) {
          if (S.tabs[j].active) {
            S.tabId = S.tabs[j].id;
            break;
          }
        }
        if (!S.tabId && S.tabs.length) S.tabId = S.tabs[0].id;
      }
    } else if (msg.tabId) {
      S.tabId = msg.tabId;
    }

    if (String(prevTabId) !== String(S.tabId)) {
      S.lastSeq = -1;
      clearFrame();
    }
    var current = S.tabId ? findTab(S.tabId) : null;
    if (current) {
      S.url = current.url || S.url;
      S.title = current.title || S.title;
    } else if (!S.tabId) {
      S.url = "";
      S.title = "";
    }
    syncStageState();
    renderTabs();
    updateAddress();
    if (msg.ok === false) {
      S.subFail = true;
      syncStageState(); // 空态里给「一键启用并打开」
      setStatus("订阅失败:浏览器控制可能未开启");
      return;
    }
    S.subFail = false;
    syncStageState();
    setStatus(S.tabId ? "已连接" : "无 tab");
    if (S.tabId) pollNavigationState(0); // 订阅成功即探测一次导航态
    refreshTabs(); // tab 栏不再是「订阅那一刻的快照」
  }

  /** getState 回执:文本以 { 开头才防御式 JSON.parse,更新 canGoBack/canGoForward,失败静默。
   *  2026-11:tabs 回执渲染 chip(带 owner);open/newTab/close 成功后重拉 tab 栏。 */
  function onCommandResult(msg) {
    var action = String(msg.action || "");
    if (action === "tabs") {
      if (msg.ok === false) return;
      applyTabsPayload(msg.tabs);
      return;
    }
    if (action === "open" || action === "newTab" || action === "close") {
      if (msg.ok) refreshTabs();
      return;
    }
    if (action !== "getState") return;
    if (!msg.ok) return;
    if (S.tabId && msg.tabId != null && String(msg.tabId) !== String(S.tabId)) return; // 迟到的旧 tab 回执
    var text = typeof msg.text === "string" ? msg.text : "";
    if (text.replace(/^\s+/, "").charAt(0) !== "{") return;
    try {
      var st = JSON.parse(text);
      if (st && typeof st === "object") {
        if (typeof st.canGoBack === "boolean") S.canGoBack = st.canGoBack;
        if (typeof st.canGoForward === "boolean") S.canGoForward = st.canGoForward;
        syncNavButtons();
      }
    } catch (e) {
      // 非 JSON(错误串等):静默
    }
  }

  function handleMessage(msg) {
    if (!S.mounted) return;
    if (!msg || typeof msg !== "object") return;
    var type = String(msg.type || "");
    if (type === "browser.view.frame") {
      onFrame(msg);
      return;
    }
    if (type === "browser.view.event") {
      onEvent(msg);
      return;
    }
    if (type === "browser.view.subscribed") {
      onSubscribed(msg);
      return;
    }
    if (type === "browser.view.command.result") {
      onCommandResult(msg);
    }
  }

  // ---- 生命周期 ----

  function unmount() {
    clearDragListeners();
    clearListeners();
    clearTimers();
    var host = S.host;
    S.drag = null;
    S.dragging = false;
    if (host) {
      try {
        host.textContent = "";
        host.innerHTML = "";
      } catch (e) {
        // 宿主已失效时忽略
      }
    }
    S.mounted = false;
    S.el = null;
    S.host = null;
    S.ctx = null;
    resetState();
  }

  function mount(hostEl, ctx) {
    if (!hostEl || typeof hostEl.appendChild !== "function") return false;
    if (!D || typeof D.createElement !== "function") return false;
    unmount(); // 可重复调用:先卸旧实例,避免双份 DOM/监听
    ensureStyles();
    S.host = hostEl;
    S.ctx = ctx || {};
    S.mounted = true;
    loadPrefs(); // mount 恢复缩放/视口偏好(读失败静默用默认)
    S.el = buildDom();
    try {
      hostEl.textContent = "";
      hostEl.appendChild(S.el.root);
    } catch (e) {
      S.mounted = false;
      S.el = null;
      S.host = null;
      S.ctx = null;
      return false;
    }
    bindEvents();
    syncHumanVisuals();
    syncStageState();
    syncNavButtons();
    renderTabs();
    syncZoomButtons();
    updateAddress();
    updateInfoText(0);
    syncVpInputs();
    syncHandleAria();
    if (typeof S.ctx.subscribe === "function") {
      try {
        var off = S.ctx.subscribe(function (payload) {
          handleMessage(payload);
        });
        if (typeof off === "function") listeners.push(off);
      } catch (e) {
        // 订阅失败不阻断:宿主仍可用 handleMessage 主通道
      }
    }
    sendOpen(null); // 挂载即订阅当前 tab
    return true;
  }

  function state() {
    var tabs = [];
    for (var i = 0; i < S.tabs.length; i++) {
      var t = S.tabs[i] || {};
      tabs.push({
        id: t.id == null ? null : t.id,
        url: t.url || "",
        title: t.title || "",
        active: !!t.active,
        owner: String(t.owner == null ? "" : t.owner)
      });
    }
    return {
      tabId: S.tabId,
      tabs: tabs,
      url: S.url,
      title: S.title,
      zoom: S.zoom,
      viewport: { width: S.viewport.width, height: S.viewport.height },
      humanMode: S.humanMode,
      lastSeq: S.lastSeq,
      canGoBack: S.canGoBack,
      canGoForward: S.canGoForward,
      isLoading: S.isLoading,
      errorMessage: S.errorMessage,
      subFail: S.subFail,
      typeDraft: S.typeDraft
    };
  }

  W.GenieBrowserView = {
    mount: mount,
    unmount: unmount,
    handleMessage: handleMessage,
    state: state,
    __test: {
      clampZoom: clampZoom,
      fitZoom: fitZoom,
      nextViewportForDrag: nextViewportForDrag,
      wheelDecision: wheelDecision,
      normalizeUrl: normalizeUrl
    }
  };
})();
