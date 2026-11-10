/* step-124 网页版输入交互策略(右键/左键/中键/浏览器快捷键/滚轮/拖放/触屏)
 *
 * 设计原则(分区,不一刀切):
 *  - 画布/白板/图表/侧栏/工具栏:接管浏览器默认(右键菜单/文本选择/原生拖拽/中键自动滚动/Ctrl+滚轮缩放/Ctrl+S/P/F);
 *  - 终端输出/代码块/markdown 正文/输入框/文本域:永远例外——保留原生选择、复制、右键菜单与中键;
 *  - 空白/装饰区:抑制右键,不碰 Ctrl+C(不设全局 user-select:none)。
 *
 * 可配开关:localStorage["zh:web-input-policy"] = "strict"(默认) | "relaxed";
 * 运行时:window.__webInputPolicy.setMode("strict"|"relaxed")。
 * 轻量右键菜单(非文本区、且该处没有应用菜单时):复制页面地址 + 严格交互开关。
 *
 * 零依赖、自包含;不依赖 panel 内联变量,不使用 toast()(自带 #ip-toast)。
 */
(function () {
  "use strict";
  if (window.__webInputPolicy) return;
  var VERSION = "124";
  var LS_KEY = "zh:web-input-policy";
  var MENU_ID = "ip-menu";
  var TOAST_ID = "ip-toast";
  var STYLE_ID = "ip-style";

  // 文本区:永远保留原生选择/复制/右键/中键。顺序无关,closest() 命中即放行。
  var TEXT_SEL = [
    "input", "textarea", "select",
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    "pre", "code", "blockquote", ".md-table",
    ".task-reply", ".user-line .txt", ".sys-line", ".think-card .th-body",
    ".tc-body", ".tr-full", ".tool-card summary", ".tool-group .tg-item",
    ".term-body", ".term-input-row",
    ".fv-body", ".git-diff", ".git-changes", "#ddBody",
    "#ideEdit", ".ide-edit", /* step-141:IDE 编辑区容器豁免(严格交互下可选中/输入;树/标签条仍属 chrome) */
    ".ide-monaco", /* step-141 C:Monaco 挂载面同属文本区(严格交互下代码可选中/复制) */
    ".wiki-md", ".wiki-page-title",
    ".board-detail", ".bd-flow", ".pp-detail", ".pp-ch",
    ".uid-msg", ".perm-sum", ".perm-meta",
  ].join(",");

  // 画布/白板/图表/手绘板:接管右键/选择/拖拽/中键/Ctrl+滚轮。仅限画布本体,不扩大到整个视图。
  var CANVAS_SEL = [
    "#boardGraph", ".board-graph",
    "#cvHost", "#cvShellHost", ".bf-canvas", ".bf-cv-world", "#bfGraph",
    "#wbWrap", "#wbCanvas",
    "#ppGraph", "#ppfMermaid", "#ppfGraphWrap",
    "#arcCv", ".md-mermaid",
    "#g", // 项目档案独立窗口页(step-049)的图容器
  ].join(",");

  // 侧栏/工具栏/头部/文件树/任务卡等 chrome 面:禁原生选择/拖拽;右键交给轻量菜单或既有应用菜单。
  var CHROME_SEL = [
    "#sidebar", "header", ".vw-head", ".chatTopbar",
    ".pp-head", ".pp-tabs", ".pp-tab",
    ".files-tree", "#sbFt", ".sbft-head",
    "#ideTree", ".ide-tabs", /* step-141:IDE 左树/顶部标签条=chrome 面(禁选中,不放开整视图) */
    ".t-row", ".t-more", ".ft-row",
    ".board-nodes", ".board-sketch > summary", ".wb-tools",
    ".bf-head", ".bf-list", ".bf-item",
    ".msg-acts", ".composer-bar",
  ].join(",");

  var mode = "strict";
  try {
    var saved = localStorage.getItem(LS_KEY);
    if (saved === "relaxed" || saved === "strict") mode = saved;
  } catch (e) { /* localStorage 不可用 → strict */ }

  function isTextTarget(t) {
    return !!(t && t.closest && t.closest(TEXT_SEL));
  }
  function isCanvasTarget(t) {
    return !!(t && t.closest && t.closest(CANVAS_SEL));
  }
  function isChromeTarget(t) {
    return !!(t && t.closest && t.closest(CHROME_SEL));
  }
  function isEditable(t) {
    return !!(t && t.closest && t.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'));
  }
  function isHoverAppSurface(t) {
    // panel 既有应用右键菜单:oncontextmenu 属性(任务行/项目行/文件树/板桶头)+ 白板画布委托。
    for (var n = t; n && n.nodeType === 1; n = n.parentElement) {
      if (typeof n.oncontextmenu === "function") return true;
    }
    return !!(t && t.closest && t.closest("#cvHost,#cvShellHost,.bf-canvas,#boardGraph,#bfGraph,#arcCv"));
  }

  // ---- 样式:只打容器;文本区 !important 恢复 ----
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    // 文本区覆盖必须压过容器上的 ID/类选择器(!important 同级时比 specificity):
    // 为每个 chrome/canvas 根生成「根 + :is(文本区)」的高特异性恢复规则(如 #sidebar 内的项目路径输入框)。
    var zoneRoots = CHROME_SEL.split(",").concat(CANVAS_SEL.split(","));
    var textRestore = ["body.ip-strict :is(" + TEXT_SEL + ")"]
      .concat(zoneRoots.map(function (r) { return "body.ip-strict " + r.trim() + " :is(" + TEXT_SEL + ")"; }))
      .join(",");
    var css = [
      "body.ip-strict " + CHROME_SEL.split(",").join(", body.ip-strict ") + ", body.ip-strict " + CANVAS_SEL.split(",").join(", body.ip-strict ") + "{user-select:none!important;-webkit-user-select:none!important}",
      "body.ip-strict " + CHROME_SEL.split(",").join(", body.ip-strict ") + ", body.ip-strict " + CANVAS_SEL.split(",").join(", body.ip-strict ") + "{-webkit-touch-callout:none!important}",
      textRestore + "{user-select:text!important;-webkit-user-select:text!important;-webkit-touch-callout:default!important}",
      "#" + MENU_ID + "{position:fixed;z-index:10000;min-width:218px;max-width:min(320px,92vw);padding:5px;background:var(--window-bg,#141009);border:1px solid var(--border,rgba(200,143,69,.28));border-radius:10px;box-shadow:0 14px 44px rgba(0,0,0,.55);font-family:-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;font-size:12.5px;color:var(--text,#ece1d1);display:none}",
      "#" + MENU_ID + ".on{display:block}",
      "#" + MENU_ID + " .ip-mi{padding:7px 11px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#ece1d1)}",
      "#" + MENU_ID + " .ip-mi:hover{background:var(--hover-bg,rgba(255,255,255,.07));color:var(--bronze,#c98f45)}",
      "#" + MENU_ID + " .ip-sep{height:1px;margin:5px 6px;background:var(--border-soft,rgba(200,143,69,.18))}",
      "#" + MENU_ID + " .ip-note{padding:5px 11px 4px;font-size:10px;line-height:1.5;color:var(--faint,#6b5c4a)}",
      "#" + MENU_ID + " .ip-mi .ip-state{float:right;margin-left:18px;color:var(--bronze,#c98f45)}",
      "#" + TOAST_ID + "{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:10001;max-width:min(520px,88vw);padding:8px 15px;border-radius:9px;background:rgba(10,7,4,.9);border:1px solid var(--border,rgba(200,143,69,.28));color:var(--text,#ece1d1);font-family:-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;font-size:12px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.5);opacity:0;transition:opacity .15s;pointer-events:none}",
      "#" + TOAST_ID + ".on{opacity:1}",
    ].join("\n");
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  var toastTimer = 0;
  function toast(msg) {
    var el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 1500);
  }

  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(function () { toast("已复制页面地址"); }, function () { fallbackCopy(s); });
    } else {
      fallbackCopy(s);
    }
  }
  function fallbackCopy(s) {
    try {
      var ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? "已复制页面地址" : "复制失败,请手动复制地址栏");
    } catch (e) { toast("复制失败,请手动复制地址栏"); }
  }

  function closeMenu() {
    var m = document.getElementById(MENU_ID);
    if (m) m.classList.remove("on");
  }
  function openMenu(x, y) {
    var m = document.getElementById(MENU_ID);
    if (!m) {
      m = document.createElement("div");
      m.id = MENU_ID;
      m.setAttribute("role", "menu");
      document.body.appendChild(m);
    }
    m.innerHTML =
      '<div class="ip-mi" data-ip-act="copy-url" role="menuitem">复制页面地址</div>' +
      '<div class="ip-sep"></div>' +
      '<div class="ip-mi" data-ip-act="toggle" role="menuitem">网页版严格交互<span class="ip-state">' + (mode === "strict" ? "开" : "关") + '</span></div>' +
      '<div class="ip-note">文本区(终端/代码块/正文/输入框)保留系统菜单与选择复制</div>';
    m.classList.add("on");
    // 先显示再夹取位置,避免菜单超出视口
    var r = m.getBoundingClientRect();
    var left = Math.min(Math.max(4, x), Math.max(4, window.innerWidth - r.width - 6));
    var top = Math.min(Math.max(4, y), Math.max(4, window.innerHeight - r.height - 6));
    m.style.left = left + "px";
    m.style.top = top + "px";
    m.onclick = function (ev) {
      var it = ev.target && ev.target.closest ? ev.target.closest("[data-ip-act]") : null;
      if (!it) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (it.dataset.ipAct === "copy-url") { copyText(location.href); closeMenu(); }
      else if (it.dataset.ipAct === "toggle") {
        var next = mode === "strict" ? "relaxed" : "strict";
        closeMenu();
        setMode(next);
        toast("网页版严格交互已" + (next === "strict" ? "开启" : "关闭"));
      }
    };
  }

  function applyMode() {
    if (!document.body) return;
    document.body.classList.toggle("ip-strict", mode === "strict");
    document.body.classList.toggle("ip-relaxed", mode !== "strict");
    if (mode !== "strict") closeMenu();
  }

  function setMode(next, persist) {
    mode = next === "relaxed" ? "relaxed" : "strict";
    if (persist !== false) {
      try { localStorage.setItem(LS_KEY, mode); } catch (e) { /* 忽略 */ }
    }
    applyMode();
  }

  // ---- 事件:严格模式下接管非文本区 ----
  function onContextMenu(e) {
    if (mode !== "strict") return;
    if (isTextTarget(e.target)) return; // 文本区:浏览器原生菜单
    e.preventDefault();
    if (isHoverAppSurface(e.target)) return; // 已有应用菜单(preventDefault 后继续冒泡给应用)
    openMenu(e.clientX, e.clientY);
  }

  function onSelectStart(e) {
    if (mode !== "strict") return;
    if (isTextTarget(e.target)) return;
    if (isCanvasTarget(e.target) || isChromeTarget(e.target)) e.preventDefault();
  }

  function onDragStart(e) {
    if (mode !== "strict") return;
    if (isTextTarget(e.target)) return; // 正文/代码/终端内拖动选中文本保留
    if (isCanvasTarget(e.target) || isChromeTarget(e.target)) e.preventDefault();
  }

  function onMouseDown(e) {
    if (mode !== "strict" || e.button !== 1) return;
    if (isTextTarget(e.target)) return; // 输入框/文本区中键粘贴保留
    e.preventDefault();
  }

  function onAuxClick(e) {
    if (mode !== "strict" || e.button !== 1) return;
    if (isTextTarget(e.target)) return;
    e.preventDefault();
  }

  function onWheel(e) {
    if (mode !== "strict" || !e.ctrlKey) return;
    if (!isCanvasTarget(e.target)) return; // 页面滚动/缩放保持
    e.preventDefault();
  }

  function onKeyDown(e) {
    if (mode !== "strict") return;
    if (isEditable(e.target)) return; // 输入框内不拦
    var mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    var k = String(e.key || "").toLowerCase();
    if (k === "s") {
      // step-141 C:#view-ide 编辑区内 Ctrl+S=应用内保存(panel 侧 capture 接管发 file.write),此处放行不拦
      if (document.body && document.body.dataset.view === "ide" && e.target && e.target.closest && e.target.closest("#ideBody")) return;
      e.preventDefault();
      toast("已阻止浏览器保存网页(Ctrl+S)");
      return;
    }
    if (k === "p" && !e.shiftKey) {
      e.preventDefault();
      toast("已阻止浏览器打印(Ctrl+P)");
      return;
    }
    if (k === "f" && !e.shiftKey) {
      // chat 视图由 panel 既有应用内查找接管;非 chat 文本区保留浏览器查找;其余抑制。
      if (document.body && document.body.dataset.view === "chat") { e.preventDefault(); return; }
      if (isTextTarget(e.target)) return;
      e.preventDefault();
      toast("当前视图无应用内查找,已阻止浏览器查找(Ctrl+F)");
    }
  }

  function onDragOver(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return;
    var hasFiles = false;
    for (var i = 0; i < types.length; i++) if (String(types[i]).toLowerCase() === "files") { hasFiles = true; break; }
    if (hasFiles) e.preventDefault(); // 外部文件:不让浏览器导航打开;应用自己的 drop 上传仍走 panel 处理器
  }

  function boot() {
    injectStyle();
    applyMode();
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("auxclick", onAuxClick, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDragOver, true);
    document.addEventListener("pointerdown", function (e) {
      var m = document.getElementById(MENU_ID);
      if (m && m.classList.contains("on") && !(e.target && m.contains(e.target))) closeMenu();
    }, true);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); }, true);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("storage", function (e) {
      if (e.key !== LS_KEY) return;
      setMode(e.newValue === "relaxed" ? "relaxed" : "strict", false);
    });
  }

  window.__webInputPolicy = {
    version: VERSION,
    storageKey: LS_KEY,
    get mode() { return mode; },
    setMode: function (next) { setMode(next, true); return mode; },
  };

  if (document.body) boot();
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
