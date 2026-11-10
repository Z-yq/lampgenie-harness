/**
 * 桌面壳(step-136 产品化):Electron 窗口 + gateway 生命周期。
 * 壳零业务:面板逻辑全在 gateway(panel.ts),壳只负责
 *  数据根解析 → 端口探测 → 资源自检 → 起 gateway → 探活 → loadURL → 回收/重启。
 *
 * 红线(沿用原壳):webPreferences contextIsolation+sandbox 全开、nodeIntegration 关;
 * 外链转系统浏览器;应用菜单置空。
 * 纯逻辑在 paths.js / logger.js / gateway-process.js(可脱离 electron 单测)。
 */
const { app, BrowserWindow, shell, Menu, ipcMain, desktopCapturer, session, screen, Notification, Tray, nativeImage } = require("electron");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join, dirname } = require("node:path");

const { createLogger } = require("./logger");
const { buildApplicationMenuTemplate } = require("./app-menu");
const { createNotificationController } = require("./notifications");
const { createTrayController } = require("./tray");
const { readUpdateConfig, writeUpdateConfig, createUpdateChecker, installLaunchSpec, sha256FileAsync, checkAuthenticode } = require("./update-check");
const {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  parseDeepLink,
} = require("./deep-link");
const {
  resolveDataRoot,
  resolveGatewayDir,
  ensureDataRoot,
  hasAnyCredential,
  resourceChecklist,
  fullRuntimeChecklist,
  llmRouteState,
} = require("./paths");
const {
  resolveWindowState,
  readWindowState,
  attachWindowStatePersistence,
  ZOOM_MIN_LEVEL,
  ZOOM_MAX_LEVEL,
} = require("./window-state");
const { startGateway, probeReady, findFreePort } = require("./gateway-process");

const WIN_TITLE = "Genie Harness";
const NO_CRED_TITLE = "Genie Harness — 首次使用请在面板设置页接入模型";
const DEGRADED_TITLE = "Genie Harness — 部分运行时组件缺失(功能降级)";
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1000;
const LOGS_URL = "https://genie-shell.local/open-logs";
/** 模型就绪轮询间隔(fix S137-2):首启无模型时 gateway 以 llm=off 起来,面板里配好后需自动重启。 */
const LLM_WATCH_INTERVAL_MS = 3000;

let win = null;
let logs = null;
let logsDir = null;
let dataRoot = null;
let gatewayDir = null;
let panelUrl = null;
let gatewayHandle = null;
let lastGatewayOutput = [];
let notifyController = null;
let menuInstalled = false;
let trayController = null;
let trayInstalled = false;
let trayQuitting = false;
let trayHintShown = false;
let panelReady = false;
let pendingDeepLinkRaw = null;
let updateChecker = null;
let updateIpcRegistered = false;
let lastUpdateStatus = "";
let updateNotifiedVersion = "";
let shuttingDown = false;
let stopping = false;
let restartCount = 0;
let restartTimer = null;
let llmWatchTimer = null;
let llmRestartInFlight = false;
let readyUrl = null;
let noCredentialHint = false;
/** 全量运行时缺失项(默认降级启动;非空时标题标「功能降级」)。 */
let runtimeDegraded = [];

/** 窗口标题优先级:未接模型 > 运行时降级 > 正常。 */
function windowTitle() {
  if (noCredentialHint) return NO_CRED_TITLE;
  if (runtimeDegraded.length) return DEGRADED_TITLE;
  return WIN_TITLE;
}

/**
 * 主进程崩溃兜底(最小面设计参考 ZCode 项目,致谢;本仓独立实现):壳崩了 gateway 子进程会成孤儿,
 * 用户只看到窗口消失。这里只落日志、不退出——Electron 默认扛住未捕获异常,壳还能继续服务;
 * 真不可恢复时用户可从日志定位,而不是一片静默。
 */
function installCrashGuard() {
  const write = (tag, err) => {
    const text = `[crash] ${tag}: ${(err && err.stack) || err}`;
    try { if (logs) logs.error(text); else console.error(text); } catch (e) { /* 日志面自身失败 */ }
  };
  process.on("uncaughtException", (err) => write("uncaughtException", err));
  process.on("unhandledRejection", (reason) => write("unhandledRejection", reason));
}

/* ------------------------------- 错误页 ------------------------------- */

function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 统一错误页(内联 data:text/html,不依赖网络/不白屏)。 */
function showErrorPage({ title, detail, logsDir: errorLogsDir }) {
  const dir = errorLogsDir || logsDir;
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;font-family:ui-monospace,Consolas,monospace;background:#0a0805;color:#c9a25e;padding:32px;line-height:1.55">` +
    `<h2 style="color:#e0b96a;margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>` +
    `<pre style="white-space:pre-wrap;background:#141009;border:1px solid #2c2418;border-radius:6px;padding:14px;max-height:50vh;overflow:auto">${escapeHtml(detail)}</pre>` +
    `<p style="color:#8d7f66;font-size:12px">日志目录:${escapeHtml(dir || "(未知)")}</p>` +
    `<p><a href="${LOGS_URL}" style="color:#9ad1ff">打开日志目录</a></p>` +
    `</body></html>`;
  readyUrl = null;
  if (!win) return;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function logErrorPage(title, detail) {
  if (logs) logs.error(`[error-page] ${title}: ${detail.split("\n").join(" | ")}`);
  else console.error(title, detail);
  showErrorPage({ title, detail, logsDir });
}

/* -------------------------------- 窗口 -------------------------------- */

// 无边框窗口控制:面板自绘标题卡片,只接受这四个固定动作(不暴露任意 IPC)。
ipcMain.handle("genie:window", (event, action) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return null;
  if (action === "minimize") { w.minimize(); return false; }
  if (action === "toggle-maximize") {
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  }
  if (action === "is-maximized") return w.isMaximized();
  if (action === "capture-enter") { w.setFullScreen(true); w.focus(); return true; }
  if (action === "capture-exit") { w.setFullScreen(false); w.focus(); return true; }
  if (action === "close") { w.close(); return true; }
  return null;
});

// 系统通知桥(2026-11-09):renderer 只传文案与任务标识,白名单字段、限长、去重、
// 窗口焦点抑制、click 恢复窗口都在主进程(notifications.js)完成。
ipcMain.handle("genie:notify", (_event, payload) => {
  if (!notifyController) return false;
  return notifyController.show(payload || {});
});

/**
 * 显示并聚焦主窗口(托盘点击 / 通知点击 / 第二次启动 / macOS activate 共用)。
 * 从托盘恢复时任务栏按钮要回来,最小化状态要还原。
 */
function showMainWindow() {
  if (!win || win.isDestroyed()) return;
  try { win.setSkipTaskbar(false); } catch (e) { /* 平台不支持 */ }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 最小化/关闭到托盘:窗口隐藏、任务栏收起,gateway 与任务继续跑。 */
function hideToTray(reason) {
  if (!win || win.isDestroyed() || shuttingDown) return;
  try { win.setSkipTaskbar(true); } catch (e) { /* 平台不支持 */ }
  win.hide();
  if (logs) logs.info(`[tray] window hidden (${reason}); gateway keeps running`);
  // 首次提示(Windows balloon):让新用户知道应用没退出。
  if (!trayHintShown && trayController && trayController.tray && process.platform === "win32") {
    trayHintShown = true;
    try {
      trayController.tray.displayBalloon({
        title: "Genie Harness 仍在运行",
        content: "任务在后台继续;点击托盘图标恢复窗口,右键可退出。",
        iconType: "info",
      });
    } catch (e) { /* 通知中心不可用时忽略 */ }
  }
}

/** 深链派发:解析 → 记住(面板未就绪时)→ 唤醒窗口 → 发给 renderer。 */
function dispatchDeepLink(raw) {
  if (!raw) return;
  const parsed = parseDeepLink(raw);
  if (!parsed) {
    if (logs) logs.warn(`[deeplink] invalid: ${String(raw).slice(0, 120)}`);
    return;
  }
  if (logs) logs.info(`[deeplink] ${parsed.action} ${parsed.raw.slice(0, 160)}`);
  showMainWindow();
  if (!win || win.isDestroyed() || !panelReady || win.webContents.isLoading()) {
    pendingDeepLinkRaw = parsed.raw;
    return;
  }
  try {
    win.webContents.send("genie:deep-link", parsed);
  } catch (e) {
    pendingDeepLinkRaw = parsed.raw;
  }
}

/** 面板加载完成后补发等待中的深链(冷启动 genie:// 场景)。 */
function flushPendingDeepLink() {
  if (!pendingDeepLinkRaw) return;
  const raw = pendingDeepLinkRaw;
  pendingDeepLinkRaw = null;
  const parsed = parseDeepLink(raw);
  if (!parsed) return;
  if (logs) logs.info(`[deeplink] flush ${parsed.action} ${parsed.raw.slice(0, 160)}`);
  try {
    if (win && !win.isDestroyed()) win.webContents.send("genie:deep-link", parsed);
  } catch (e) { /* 渲染进程未就绪:丢弃,不阻塞 */ }
}

function createWindow() {
  // 窗口状态(设计参考 ZCode 项目,致谢;本仓独立实现):尺寸/最大化/页面缩放,重启恢复。
  // 文件放 userData(设备级)而非数据根:换数据根/便携态不应丢窗口习惯。
  const stateFile = join(app.getPath("userData"), "window-state.json");
  const restored = resolveWindowState(readWindowState(stateFile), screen.getPrimaryDisplay().workAreaSize);
  let zoomLevel = restored.zoomLevel;
  // 截图标注(2026-10-26):面板「截图标注」依赖 getDisplayMedia;桌面壳无浏览器选择器,
  // 授权处理器自动命中主屏(浏览器侧仍走 Chrome 自带选择器)。仅本会话生效,无全局权限变更。
  try {
    // Electron 33 契约:handler 第二参是 callback(streams)(opts.videoRequest 是 34+ API——
    // 给回调函数挂属性=永远不响应,渲染端 getDisplayMedia 悬死)。异步决策必须 return Promise。
    session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
      // 双屏语义:抓鼠标所在的那块屏(微信截图习惯),display_id 与 Display.id 对齐
      let wantId = "";
      try {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        wantId = String(display.id);
      } catch (e) { /* 无鼠标信息时回退主屏 */ }
      desktopCapturer.getSources({ types: ["screen"] }).then((sources) => {
        let pick = sources.find((s) => String(s.display_id) === wantId);
        if (!pick) pick = sources[0];
        if (pick) callback({ video: pick, audio: "auto" });
      }).catch(() => { /* 拒绝后面板 toast 兜底 */ });
    });
  } catch (e) { /* 旧 Electron 无此 API:截图按钮在面板内自行提示 */ }
  win = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    minWidth: 960,
    minHeight: 640,
    title: WIN_TITLE,
    backgroundColor: "#f4f0e8",
    // 2026-10-25 用户口径:去掉 Windows 原生标题栏,应用内容直接铺成画布卡片;
    // 最小化/最大化/关闭由面板 #winControls(画布卡片)经 preload IPC 驱动。
    frame: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "titlebar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 2026-11-08 新用户实测:窗口最小化/被遮挡时 Chromium 把面板定时器节流到分钟级,
      // WS 心跳(30s)与任务进度刷新会停摆;桌面壳只有一个主窗口,保活它比省那点 CPU 更重要。
      // (浏览器内嵌的 webview guest 不在此列,仍按 Chromium 默认节流。)
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => {
    if (!win) return;
    win.show();
    win.focus();
  });

  // 恢复最大化(在 show 之前调用,避免先小窗闪一下再放大)。
  if (restored.maximized) {
    try { win.maximize(); } catch (e) { /* 无窗口管理器时忽略 */ }
  }

  // 页面缩放(Ctrl/Cmd +/-/0,含小键盘):桌面标准能力;面板画布缩放是另一层,不冲突。
  const windowState = attachWindowStatePersistence(win, {
    file: stateFile,
    getZoomLevel: () => zoomLevel,
    onError: (err) => { if (logs) logs.warn(`窗口状态落盘失败: ${(err && err.message) || err}`); },
  });
  const setZoom = (next) => {
    zoomLevel = Math.min(ZOOM_MAX_LEVEL, Math.max(ZOOM_MIN_LEVEL, next));
    try { win.webContents.setZoomLevel(zoomLevel); } catch (e) { /* 页面未就绪:did-finish-load 会再设 */ }
    windowState.persistNow();
  };

  // role-based 应用菜单(2026-11-09 设计参考 ZCode 项目(致谢) 语义):
  // 编辑/视图用标准 role(剪贴板/重载/DevTools);缩放项只展示键位、不注册 accelerator——
  // 键盘路径统一走 before-input-event + 持久化,避免同一次 Ctrl+= 被菜单和键盘各放大一级。
  const menuTemplate = buildApplicationMenuTemplate({
    platform: process.platform,
    appName: WIN_TITLE,
    onCommand: (id) => {
      if (logs) logs.info(`[menu] command ${id}`);
      if (win && !win.isDestroyed()) win.webContents.send("genie:menu-command", id);
    },
    onZoom: (kind) => {
      if (kind === "in") setZoom(zoomLevel + 1);
      else if (kind === "out") setZoom(zoomLevel - 1);
      else setZoom(0);
    },
    onHelp: (kind) => {
      // 帮助→检查更新(2026-11-09):手动检查不受自动检查间隔限制;结果经状态推送→面板 toast/横幅。
      if (kind === "update") { manualUpdateCheck(); return; }
      const dir = kind === "logs" ? logsDir : dataRoot;
      if (dir) void shell.openPath(dir);
    },
    onAbout: () => app.showAboutPanel(),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  menuInstalled = true;
  if (logs) logs.info("[menu] role-based menu installed (file/edit/view/window/help)");

  // 系统通知(2026-11-09):焦点抑制/去重/对象持有/click 恢复窗口的语义见 notifications.js。
  notifyController = createNotificationController({
    Notification,
    // 2026-11-09 实测:Windows 最小化后 BrowserWindow.isFocused() 仍可能为 true(前台身份未移交),
    // 只看 isFocused 会把「最小化等任务」当成「用户正看着」而漏通知。可见且未最小化才算出在前台。
    isWindowFocused: () => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()),
    focusWindow: showMainWindow,
    sendToRenderer: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    log: (message) => { if (logs) logs.info(message); },
  });

  // 更新检查 IPC(白名单动作;checker 在 bootstrap 里创建,handler 先注册不阻塞面板)
  registerUpdateIpc();
  // 托盘 + 关闭到托盘(2026-11-09,设计参考 ZCode 项目(致谢)):
  // 最小化/关闭都收进托盘,gateway 与任务继续跑;托盘菜单「退出」才真正结束。
  // GENIE_TRAY=0 关闭(测试/排障时保留「关闭即退出」语义);macOS 不模拟菜单栏托盘。
  const trayAllowed = process.env.GENIE_TRAY !== "0" && process.platform !== "darwin";
  if (trayAllowed) {
    trayController = createTrayController({
      Tray, Menu, nativeImage,
      platform: process.platform,
      appName: WIN_TITLE,
      onShow: showMainWindow,
      onNewTask: () => { if (win && !win.isDestroyed()) win.webContents.send("genie:menu-command", "new-task"); },
      onSettings: () => { if (win && !win.isDestroyed()) win.webContents.send("genie:menu-command", "open-settings"); },
      onLogs: () => { if (logsDir) void shell.openPath(logsDir); },
      onCheckUpdate: () => manualUpdateCheck(),
      onAbout: () => app.showAboutPanel(),
      onQuit: () => { trayQuitting = true; gracefulQuit(); },
      log: (message) => { if (logs) logs.info(message); },
    });
    trayInstalled = !!trayController;
  }
  // 只有托盘真的创建成功才启用「关闭到托盘」——否则窗口会藏起来且没有恢复入口。
  if (trayController) {
    win.on("minimize", () => { hideToTray("minimize"); });
    win.on("close", (event) => {
      if (trayQuitting || shuttingDown) return;
      event.preventDefault();
      hideToTray("close");
    });
  }
  let rendererRecoveries = 0;
  win.webContents.on("did-finish-load", () => {
    try { win.webContents.setZoomLevel(zoomLevel); } catch (e) { /* 忽略 */ }
    rendererRecoveries = 0; // 加载成功:恢复预算清零(崩溃重载不累计成死循环)
    // 只有真正的面板页(不是启动占位/错误页)才标记就绪并补发深链
    try {
      const current = win.webContents.getURL();
      if (readyUrl && current.startsWith(readyUrl)) {
        panelReady = true;
        flushPendingDeepLink();
      }
    } catch (e) { /* 忽略 */ }
    // 面板加载完成后补推一次更新状态(checkbox 可能已在面板起来前完成检查)
    if (updateChecker) sendUpdateState(updateChecker.getState());
  });
  // 渲染进程崩溃(2026-11-08):「同 URL 保持页面」策略在 renderer 已死时必须失效,
  // 否则窗口停在白屏。有限次自动重载;连续崩溃说明不是偶发,转错误页让人可诊断。
  win.webContents.on("render-process-gone", (_event, details) => {
    if (logs) logs.error(`[renderer] 进程退出 reason=${details && details.reason} exitCode=${details && details.exitCode}`);
    if (shuttingDown || !panelUrl || !win || win.isDestroyed()) return;
    rendererRecoveries += 1;
    if (rendererRecoveries > 2) {
      logErrorPage("面板进程反复崩溃", `reason=${(details && details.reason) || "unknown"} · 日志目录:${logsDir || "(未知)"}`);
      return;
    }
    setTimeout(() => {
      if (shuttingDown || !win || win.isDestroyed()) return;
      try { win.loadURL(panelUrl); } catch (e) { /* 加载失败由 did-fail-load 兜底成错误页 */ }
    }, 800);
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta)) return;
    const key = String(input.key || "");
    if (key === "=" || key === "+") { event.preventDefault(); setZoom(zoomLevel + 1); }
    else if (key === "-" || key === "_") { event.preventDefault(); setZoom(zoomLevel - 1); }
    else if (key === "0") { event.preventDefault(); setZoom(0); }
  });

  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    '<body style="margin:0;background:#0a0805;color:#c9a25e;font-family:ui-monospace,monospace;display:flex;align-items:center;justify-content:center;height:100vh">正在启动 Genie Harness…</body>',
  ));

  // 外链(浏览器视图的「新窗口」/markdown 链接)走系统浏览器,不在壳内开新窗。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (readyUrl && url.startsWith(readyUrl)) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // 同窗导航:错误页的「打开日志目录」链接 + 外链一律外抛。
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(LOGS_URL)) {
      event.preventDefault();
      if (logsDir) void shell.openPath(logsDir);
      return;
    }
    if (readyUrl && url.startsWith(readyUrl)) return;
    if (url.startsWith("data:") || url === "about:blank") return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (!url || !readyUrl || !url.startsWith(readyUrl)) return;
    logErrorPage(
      "面板加载失败",
      `gateway 面板不可达(${code} ${desc})\nURL: ${url}\n\n子进程输出(末 20 行):\n${recentText()}`,
    );
  });

  win.on("maximize", () => { if (win && !win.isDestroyed()) win.webContents.send("genie:maximized", true); });
  win.on("unmaximize", () => { if (win && !win.isDestroyed()) win.webContents.send("genie:maximized", false); });
  win.webContents.on("did-finish-load", () => { if (win && !win.isDestroyed()) win.webContents.send("genie:maximized", win.isMaximized()); });

  win.on("closed", () => {
    win = null;
  });
}

function recentText() {
  const live = gatewayHandle && gatewayHandle.recentOutput ? gatewayHandle.recentOutput() : [];
  const lines = live.length ? live : lastGatewayOutput;
  return lines.length ? lines.join("\n") : "(暂无输出)";
}

/* ------------------------------ 启动链 ------------------------------ */

async function launchGateway() {
  const port = await findFreePort();
  if (port === null) {
    logErrorPage(
      "没有可用端口",
      "7700-7720 全部被占用,无法启动内置 gateway。\n请关闭占用这些端口的程序后重试。",
    );
    return;
  }

  const checklist = resourceChecklist(gatewayDir);
  const missingRequired = checklist.filter((i) => i.required && i.missing);
  if (missingRequired.length) {
    logErrorPage(
      "安装包缺少必需资源",
      `以下资源缺失(安装可能不完整,建议重新安装):\n${missingRequired
        .map((i) => `  - ${i.name}  (${i.path})`)
        .join("\n")}\n\ngateway 目录: ${gatewayDir}`,
    );
    return;
  }
  const missingOptional = checklist.filter((i) => !i.required && i.missing);
  if (missingOptional.length && logs) {
    logs.warn(`可选资源缺失(对应功能降级): ${missingOptional.map((i) => i.name).join(", ")}`);
  }

  // 全量运行时(评分模型/Chromium/git+bash)只对打包态检查;dev 态没有 .stage 产物是正常现象。
  // 2026-11-08 实测:360 安全卫士会持续隔离 onnxruntime.dll / chrome_elf.dll 等,
  // 缺失是「功能降级」而非「安装坏了」——默认不阻断启动(标题提示降级);
  // 发布 QA 可设 GENIE_REQUIRE_FULL_RUNTIME=1 恢复严格阻断。
  if (app.isPackaged) {
    const full = fullRuntimeChecklist(process.resourcesPath);
    const missingFull = full.filter((i) => i.missing);
    if (missingFull.length) {
      const detail = missingFull.map((i) => `  - ${i.name}  (${i.path})`).join("\n");
      runtimeDegraded = missingFull.map((i) => i.name);
      if (process.env.GENIE_REQUIRE_FULL_RUNTIME === "1") {
        logErrorPage(
          "安装包缺少运行时组件",
          `以下组件缺失(严格模式 GENIE_REQUIRE_FULL_RUNTIME=1;安装可能不完整,建议重新安装):\n${detail}\n\n资源目录: ${process.resourcesPath}`,
        );
        return;
      }
      if (logs) {
        logs.warn(
          `全量运行时缺失 ${missingFull.length} 项 → 功能降级启动(可能被杀毒软件隔离;添加信任后重装可恢复):\n${detail}`,
        );
      }
      if (win && !win.isDestroyed()) win.setTitle(DEGRADED_TITLE);
    }
  }

  panelUrl = `http://127.0.0.1:${port}`;
  if (logs) logs.info(`starting gateway dir=${gatewayDir} dataRoot=${dataRoot} port=${port}`);

  const handle = startGateway({
    gatewayDir,
    dataRoot,
    port,
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    logs: logsDir,
    onExit: (info) => {
      // 先留一份最后输出:下一行会把 gatewayHandle 置空,错误页(重试耗尽)再读就只剩空数组。
      try {
        const output = handle.recentOutput ? handle.recentOutput() : [];
        if (output.length) lastGatewayOutput = output;
      } catch { /* 观测面失败不影响重启链 */ }
      if (gatewayHandle === handle) gatewayHandle = null;
      if (shuttingDown || stopping || info.stopped) return;
      if (logs) logs.error(`gateway 异常退出 code=${info.code} signal=${info.signal}`);
      scheduleRestart(`gateway 异常退出(code=${info.code} signal=${info.signal})`);
    },
  });
  gatewayHandle = handle;

  const result = await probeReady(port);
  if (shuttingDown) return;
  if (result.ok) {
    restartCount = 0;
    if (logs) logs.info(`gateway ready in ${result.ms}ms url=${panelUrl}`);
    loadPanel(panelUrl);
  } else {
    logErrorPage(
      "gateway 启动超时",
      `60 秒内未探活成功(端口 ${port},最后错误:${result.lastError || "未知"})。\n\n` +
        `子进程输出(末 20 行):\n${recentText()}\n\ngateway 日志: ${join(logsDir, "gateway.log")}`,
    );
  }
}

function loadPanel(url) {
  readyUrl = url;
  if (!win) return;
  panelReady = false;
  win.setTitle(windowTitle());
  // 2026-11-08 新用户实测:配好模型后壳为让 LLM 装配生效会重启 gateway,旧实现无条件 loadURL →
  // 用户刚填完的「模型设置」界面被整页刷掉,回到默认画布。面板本身有 WS 自动重连(含半开检测),
  // 同 URL 重启时保留当前页面即可;端口漂移/错误页/白屏才需要真正导航。
  let current = "";
  try { current = win.webContents.getURL(); } catch (e) { /* 窗口销毁中:走 loadURL 兜底 */ }
  if (current && current.startsWith(url)) {
    panelReady = true;
    flushPendingDeepLink();
    if (logs) logs.info(`[panel] 保持当前页面(WS 自动重连): ${current}`);
    return;
  }
  win.loadURL(url);
}

function scheduleRestart(reason) {
  restartCount += 1;
  if (restartCount > MAX_RESTARTS) {
    logErrorPage(
      "gateway 多次启动失败",
      `连续 ${MAX_RESTARTS} 次重启失败(${reason})。\n\n` +
        `子进程输出(末 20 行):\n${recentText()}\n\ngateway 日志: ${join(logsDir, "gateway.log")}`,
    );
    return;
  }
  if (logs) logs.warn(`gateway 将在 ${RESTART_DELAY_MS}ms 后重启(第 ${restartCount}/${MAX_RESTARTS} 次)`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (shuttingDown) return;
    void launchGateway().catch((err) => {
      logErrorPage("gateway 重启失败", String((err && err.stack) || err));
    });
  }, RESTART_DELAY_MS);
}

/**
 * 模型就绪监视(fix S137-2):gateway 的 LLM 装配只在**进程启动**时做一次。
 * 首启(数据根还没有模型配置)时它以 llm=off + executor 直连起来,任务只会 echo 回显;
 * 用户在面板里配好模型后仅落盘不生效——这里检测到「配置已就绪但当前进程是 llm=off」就自动重启一次,
 * 让用户不必手动关掉再开。
 *
 * 只重启一次(条件从 not-ready → ready 的那次跃迁);重启后若仍 off,说明配置本身有问题,
 * 不再反复重启(交给面板/日志报错,避免死循环)。
 */
function watchLlmReadiness(wasReadyAtBoot) {
  clearInterval(llmWatchTimer);
  let lastReady = wasReadyAtBoot;
  llmWatchTimer = setInterval(() => {
    if (shuttingDown || llmRestartInFlight) return;
    const state = llmRouteState(dataRoot, process.env);
    if (state.ready === lastReady) return;
    lastReady = state.ready;
    if (!state.ready) {
      if (logs) logs.info(`[llm-watch] 模型配置变为不可用(${state.reason});不再自动重启`);
      return;
    }
    if (logs) logs.info(`[llm-watch] 检测到模型配置就绪(${state.reason})→ 重启 gateway 使 LLM 装配生效`);
    llmRestartInFlight = true;
    // 复用正常重启链:停旧进程 → 重起 → 探活 → loadURL(面板会自动重连 WS)
    void (async () => {
      try {
        await stopGateway();
        restartCount = 0; // 这是配置驱动的正常重启,不吃崩溃重启预算
        await launchGateway();
      } catch (err) {
        if (logs) logs.error(`[llm-watch] 重启失败: ${(err && err.stack) || err}`);
      } finally {
        llmRestartInFlight = false;
      }
    })();
  }, LLM_WATCH_INTERVAL_MS);
  // 定时器不应阻止进程退出
  if (llmWatchTimer.unref) llmWatchTimer.unref();
}

/**
 * 启动自愈快捷方式(2026-11-09):安装段在 UAC 提权内层实例执行,实测 NSIS CreateShortCut 总是失败、
 * 子进程 PowerShell 也起不来(ps_exit=error),装完没有开始菜单/桌面入口且 AUMID 失去载体。
 * 应用以用户态运行时用 Electron 原生 shell.writeShortcutLink(COM + appUserModelId)补齐;
 * 桌面路径走 app.getPath("desktop"),尊重 360 等工具的桌面重定向。
 * 只补缺失项(用户主动删除的入口不强行重建);GENIE_NO_SHORTCUT_HEAL=1 可关闭。
 */
function ensureShortcuts() {
  if (!app.isPackaged || process.platform !== "win32") return;
  if (process.env.GENIE_NO_SHORTCUT_HEAL === "1") return;
  const target = process.execPath;
  const links = [
    join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Genie Harness.lnk"),
    join(app.getPath("desktop"), "Genie Harness.lnk"),
  ];
  for (const link of links) {
    if (existsSync(link)) continue;
    try {
      const ok = shell.writeShortcutLink(link, "create", {
        target,
        cwd: dirname(target),
        icon: target + ",0",
        description: "Genie Harness",
        appUserModelId: "com.genie.harness",
      });
      if (logs) logs.info(`[shortcut] ${ok ? "created" : "failed"}: ${link}`);
    } catch (err) {
      if (logs) logs.warn(`[shortcut] failed ${link}: ${(err && err.message) || err}`);
    }
  }
}

/**
 * genie:// 协议注册(2026-11-09):打包态在用户态写 HKCU\Software\Classes\genie,
 * 指向当前 exe;安装器也会通过 electron-builder protocols 注册,这里做自愈兜底。
 */
function ensureProtocolRegistration() {
  if (!app.isPackaged) return; // dev 不抢系统协议
  if (process.platform !== "win32" && process.platform !== "linux") return;
  try {
    const ok = app.setAsDefaultProtocolClient("genie");
    if (logs) logs.info(`[deeplink] protocol genie:// ${ok ? "registered" : "register-failed"}`);
  } catch (err) {
    if (logs) logs.warn(`[deeplink] protocol register error: ${(err && err.message) || err}`);
  }
}

/* --------------------------- 版本检查/应用内更新 --------------------------- */

function sendUpdateState(state) {
  if (win && !win.isDestroyed()) win.webContents.send("genie:update-state", state);
}

function manualUpdateCheck() {
  if (!updateChecker) {
    if (logs) logs.warn("[update] 版本检查尚未初始化(数据目录未就绪)");
    return;
  }
  void updateChecker.checkNow({ reason: "manual" }).then((result) => {
    if (!result.ok && logs) logs.warn(`[update] 手动检查失败: ${result.error}`);
  });
}

/**
 * 更新 IPC(面板只拿白名单动作,不暴露任意 IPC):
 * state / check / download / dismiss / open-page / install。
 * install 只接受「更新目录内、已下载、.exe」的文件,spawn /S 静默安装后退出壳,
 * 由安装器接管覆盖(升级健壮性见 build/installer.nsh)。
 */
function registerUpdateIpc() {
  if (updateIpcRegistered) return;
  updateIpcRegistered = true;
  ipcMain.handle("genie:update", async (_event, action, payload) => {
    const act = String(action || "");
    if (!updateChecker) return { ok: false, error: "版本检查尚未初始化" };
    const st = updateChecker.getState();
    try {
      if (act === "state") return { ok: true, state: st };
      if (act === "check") return await updateChecker.checkNow({ reason: "manual" });
      // 面板「关于 → 应用更新」保存更新源:.genie/update-config.json(env/genie.config.json 仍可覆盖/兜底)
      if (act === "configure") {
        if (!dataRoot) return { ok: false, error: "数据目录未就绪" };
        if (st.status === "downloading") return { ok: false, error: "正在下载更新,完成后再修改更新源" };
        const patch = payload && typeof payload === "object" ? payload : {};
        let config;
        try {
          config = writeUpdateConfig(dataRoot, {
            feedUrl: patch.feedUrl,
            autoCheck: patch.autoCheck,
            intervalHours: patch.intervalHours,
          });
        } catch (err) {
          return { ok: false, error: (err && err.message) || String(err) };
        }
        if (updateChecker) updateChecker.stop();
        updateChecker = null;
        lastUpdateStatus = "";
        updateNotifiedVersion = "";
        initUpdateChecker();
        sendUpdateState(updateChecker.getState());
        if (patch.checkNow === false) return { ok: true, state: updateChecker.getState(), config };
        const checked = await updateChecker.checkNow({ reason: "manual" });
        return { ok: checked.ok, ...checked, state: updateChecker.getState(), config };
      }
      if (act === "download") return await updateChecker.download();
      if (act === "dismiss") return updateChecker.dismiss();
      if (act === "open-page") {
        const url = st.pageUrl || st.downloadUrl;
        if (!url) return { ok: false, error: "更新源未提供详情地址" };
        await shell.openExternal(url);
        return { ok: true };
      }
      if (act === "install") {
        if (!dataRoot) return { ok: false, error: "数据目录未就绪" };
        const updatesDir = join(dataRoot, ".genie", "updates");
        const spec = installLaunchSpec(st.downloadedPath, process.platform, updatesDir);
        if (!spec.ok) return spec;
        if (!st.verified && logs) {
          logs.warn("[update] 更新包未提供 sha256(仅按大小校验),继续安装;建议发布方在清单补 sha256");
        }
        // 安装前二次校验(2026-11-09):下载后文件可能被替换/损坏;再算一次 sha256。
        try {
          const actual = await sha256FileAsync(spec.filePath);
          if (st.sha256 && actual !== st.sha256) {
            if (logs) logs.error("[update] 安装包哈希在下载后发生变化,拒绝安装");
            return { ok: false, error: "安装包哈希在下载后发生变化(可能被篡改),已拒绝安装" };
          }
        } catch (err) {
          return { ok: false, error: `安装包校验失败:${(err && err.message) || err}` };
        }
        // Authenticode 探测 + 清单签名状态:未签名包给出明确降级提示并要求确认。
        const auth = await checkAuthenticode(spec.filePath);
        const force = !!(payload && typeof payload === "object" && payload.force);
        if (auth.status === "HashMismatch") {
          if (logs) logs.error("[update] Authenticode 哈希不匹配,拒绝安装");
          return { ok: false, error: "安装包 Authenticode 哈希不匹配(文件可能被篡改),已拒绝安装" };
        }
        if (st.signatureStatus !== "verified" && auth.status !== "Valid" && !force) {
          if (logs) logs.warn(`[update] 安装包未通过发布者签名校验(authenticode=${auth.status} manifest=${st.signatureStatus}),等待用户确认`);
          return {
            ok: false,
            needsConfirm: true,
            authenticode: auth.status,
            message: `该更新包未通过发布者签名校验(Authenticode: ${auth.status};清单签名: ${st.signatureStatus});当前仅 sha256 校验。确认仍要安装?`,
          };
        }
        if (logs) {
          logs.info(
            `[update] 安装前校验:sha256=ok authenticode=${auth.status} manifestSignature=${st.signatureStatus}` +
              (auth.signer ? ` signer=${auth.signer}` : ""),
          );
        }
        const child = spawn(spec.filePath, spec.args, { cwd: spec.cwd, detached: true, stdio: "ignore" });
        if (logs) {
          logs.info(`[update] 安装器已启动 pid=${child.pid || "?"} args=${spec.args.join(" ")},观察 3s 是否早退`);
        }
        // 安装器启动后观察 3s 再退出应用:
        // - spawn 失败 / 提前非 0 退出(实测旧 uninstall 注册项异常时 Setup 会 exit=2 直接退)→ 留在应用里报错;
        // - 存活超过 3s 视为进入安装流程 → 退出壳,让安装器覆盖并重启。
        // 旧实现 spawn 后立刻 quit,安装器早退时用户只看到应用消失、版本没变(2026-11-09 实测)。
        const MONITOR_MS = 3000;
        const launch = await new Promise((resolve) => {
          let settled = false;
          const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
          child.once("spawn", () => setTimeout(() => finish({ ok: true }), MONITOR_MS));
          child.once("exit", (code, signal) => {
            if (code === 0) finish({ ok: true, exited: true });
            else finish({ ok: false, error: `安装器提前退出(code=${code}${signal ? " signal=" + signal : ""})` });
          });
          child.once("error", (err) => finish({ ok: false, error: (err && err.message) || String(err) }));
          setTimeout(() => finish({ ok: true }), MONITOR_MS + 2000);
        });
        try { child.unref(); } catch { /* 已退出 */ }
        if (!launch.ok) {
          if (logs) logs.error(`[update] 安装器启动失败: ${launch.error}`);
          return { ok: false, error: `安装器启动失败:${launch.error}(更新包已保留,可重试)` };
        }
        if (logs) logs.info(`[update] 启动安装包 ${spec.filePath} ${spec.args.join(" ")},应用即将退出`);
        setTimeout(() => { gracefulQuit(); }, 600);
        return { ok: true, launched: spec.filePath };
      }
      return { ok: false, error: `未知更新操作: ${act}` };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

/**
 * 版本检查初始化(2026-11-09):未配置更新源时状态 disabled、不发任何请求。
 * 自动检查首查延迟 20s(不和启动抢带宽),之后按配置间隔轮询;手动检查不受限制。
 * 发现新版本时:状态推给面板(横幅/设置页),窗口不在前台才补系统通知(焦点抑制在 notify 层)。
 */
function initUpdateChecker() {
  if (!dataRoot) return;
  const cfg = readUpdateConfig(dataRoot, process.env);
  const updatesDir = join(dataRoot, ".genie", "updates");
  updateChecker = createUpdateChecker({
    currentVersion: app.getVersion(),
    feedUrl: cfg.feedUrl,
    autoCheck: cfg.autoCheck,
    intervalMs: cfg.intervalMs,
    diff: cfg.diff,
    requireSignature: cfg.requireSignature,
    downloadDir: updatesDir,
    stateFile: join(dataRoot, ".genie", "update-state.json"),
    log: (message) => { if (logs) logs.info(message); },
    onState: (state) => {
      sendUpdateState(state);
      if (state.status !== lastUpdateStatus) {
        lastUpdateStatus = state.status;
        if (logs) {
          logs.info(
            `[update] status=${state.status} current=${state.currentVersion} latest=${state.latestVersion || "-"}` +
              (state.error ? ` error=${state.error}` : ""),
          );
        }
      }
      if (state.status === "available" && state.latestVersion && updateNotifiedVersion !== state.latestVersion) {
        updateNotifiedVersion = state.latestVersion;
        if (notifyController) {
          notifyController.show({
            title: `发现新版本 v${state.latestVersion}`,
            body: String(state.notes || "打开主窗口查看更新说明并下载。").replace(/\s+/g, " ").slice(0, 120),
            status: "update",
            taskId: `update:${state.latestVersion}`,
          });
        }
      }
    },
  });
  // 启动清理:中断残留的 .part 与旧版本安装包(默认只留最新 1 个),避免更新目录无限增长。
  try {
    const pruned = updateChecker.pruneDownloads();
    if (pruned.removed.length) {
      logs.info(`[update] 启动清理旧更新包/半成品 ${pruned.removed.length} 个`);
    }
  } catch (err) {
    logs.warn(`[update] 更新目录清理失败: ${(err && err.message) || err}`);
  }
  if (!cfg.feedUrl) {
    logs.info("[update] 未配置更新源(设置 GENIE_UPDATE_FEED_URL 或 genie.config.json update.feedUrl),版本检查关闭");
  } else {
    logs.info(
      `[update] 版本检查已启用 feed=${cfg.feedUrl} auto=${cfg.autoCheck} interval=${Math.round(cfg.intervalMs / 60000)}min`,
    );
  }
  updateChecker.start();
}

async function bootstrap() {
  const env = process.env;

  dataRoot = resolveDataRoot({
    env,
    platform: process.platform,
  });
  logsDir = join(dataRoot, "logs");
  logs = createLogger(logsDir);
  // 菜单/托盘在 createWindow(早于本函数)里已装好;此时日志器才可用,补可审计记录。
  if (menuInstalled) logs.info("[menu] role-based menu installed (file/edit/view/window/help)");
  if (trayInstalled) logs.info("[tray] created (menu=show/new-task/settings/logs/about/quit; close/minimize to tray)");
  ensureShortcuts();
  ensureProtocolRegistration();
  initUpdateChecker();
  logs.info(
    `[boot] app=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} ` +
      `platform=${process.platform} packaged=${app.isPackaged} dataRoot=${dataRoot} resources=${process.resourcesPath || "-"}`,
  );

  // dev 兼容(P1-5):GENIE_DESKTOP_URL 直连外部 gateway,不拉子进程。
  const externalUrl = env.GENIE_DESKTOP_URL;
  if (externalUrl) {
    logs.info(`[boot] GENIE_DESKTOP_URL=${externalUrl} → 直连模式,不启动内置 gateway`);
    panelUrl = externalUrl;
    loadPanel(externalUrl);
    return;
  }

  try {
    ensureDataRoot(dataRoot);
  } catch (err) {
    logErrorPage("数据目录不可写", `无法初始化 ${dataRoot}\n${(err && err.stack) || err}`);
    return;
  }

  noCredentialHint = !hasAnyCredential(dataRoot);
  if (noCredentialHint) logs.info("[boot] 未检测到模型凭证:首次使用请在面板设置页接入模型");
  if (win) win.setTitle(windowTitle());
  const llmAtBoot = llmRouteState(dataRoot, process.env);
  logs.info(`[boot] LLM 路由 ${llmAtBoot.ready ? "就绪" : "未就绪"}: ${llmAtBoot.reason}`);

  gatewayDir = resolveGatewayDir({
    env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!gatewayDir) {
    logErrorPage(
      "找不到 gateway 产物",
      "dev 态未定位到仓库根(pnpm-workspace.yaml),或打包态缺少 resources/gateway。\n" +
        "dev 态请先执行: pnpm --filter @lampgenie/gateway build",
    );
    return;
  }
  logs.info(`[boot] gatewayDir=${gatewayDir}`);

  await launchGateway();
  // 首启没配好模型时,盯着面板里「接入模型」的写入;就绪即自动重启让 LLM 装配生效。
  watchLlmReadiness(llmAtBoot.ready);
}

/* ------------------------------ 生命周期 ------------------------------ */

async function stopGateway() {
  if (!gatewayHandle || stopping) return;
  stopping = true;
  try {
    await gatewayHandle.stop();
  } catch (err) {
    if (logs) logs.warn(`stop gateway 出错: ${(err && err.message) || err}`);
  } finally {
    gatewayHandle = null;
    stopping = false;
  }
}

function gracefulQuit() {
  shuttingDown = true;
  trayQuitting = true; // 放行 close-to-tray 拦截,让窗口真正关闭
  clearTimeout(restartTimer);
  clearInterval(llmWatchTimer);
  void stopGateway().finally(() => app.quit());
}

function start() {
  installCrashGuard();
  // 冷启动深链(Windows/Linux 协议 URL 在 argv);macOS 走 open-url 事件(可能早于 ready)
  const initialDeepLink = extractDeepLinkUrlFromArgs(process.argv);
  if (initialDeepLink) pendingDeepLinkRaw = initialDeepLink;
  app.on("open-url", (event, url) => {
    event.preventDefault();
    dispatchDeepLink(url);
  });
  // Windows 任务栏/通知身份(与 electron-builder appId 一致):不设会让快捷方式分组成「Electron」,
  // 后续通知/进度条也拿不到稳定的应用身份。
  if (process.platform === "win32") {
    try { app.setAppUserModelId("com.genie.harness"); } catch (e) { /* 旧系统忽略 */ }
  }

  app.whenReady().then(() => {
    // 关于面板(帮助菜单/系统 about 语义共用)
    app.setAboutPanelOptions({
      applicationName: WIN_TITLE,
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron} · Node ${process.versions.node}`,
      copyright: "本地研究工作台 · 数据只留在本机",
    });
    createWindow();
    void bootstrap().catch((err) => {
      logErrorPage("启动失败", String((err && err.stack) || err));
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return; // macOS 保留惯例:壳可无窗存活(gateway 继续跑)
    gracefulQuit();
  });

  // before-quit 兜底:先拦住退出,等子进程收干净再真退。
  let quitAfterStop = false;
  app.on("before-quit", (event) => {
    shuttingDown = true;
    trayQuitting = true;
    clearTimeout(restartTimer);
    if (quitAfterStop || !gatewayHandle) return;
    event.preventDefault();
    quitAfterStop = true;
    void stopGateway().finally(() => app.quit());
  });

  // will-quit 再兜底(同步尽力,不阻塞)。
  app.on("will-quit", () => {
    shuttingDown = true;
    trayQuitting = true;
    if (trayController) trayController.destroy();
    if (gatewayHandle) void gatewayHandle.stop();
    if (logs) logs.info("[quit] will-quit");
  });
}

// 单实例锁(P1-1):第二实例聚焦已有窗口后退出;把它的 genie:// URL 通过 additionalData 带给首实例。
const initialDeepLinkForLock = extractDeepLinkUrlFromArgs(process.argv);
const gotLock = app.requestSingleInstanceLock(
  initialDeepLinkForLock ? { deepLinkUrl: initialDeepLinkForLock } : {},
);
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    // 已在托盘/最小化时,第二次启动应恢复并聚焦(与点击托盘图标同语义)。
    showMainWindow();
    // 深链:优先 additionalData(桌面环境可能重排 argv),再退回 argv 扫描。
    const url = extractDeepLinkUrlFromSingleInstanceData(additionalData) ||
      extractDeepLinkUrlFromArgs(argv);
    if (url) dispatchDeepLink(url);
  });
  start();
}