/**
 * 系统托盘(能力面设计参考 ZCode 项目,致谢;本仓独立实现):
 * - 左键单击/双击 → 显示并聚焦窗口;
 * - 右键菜单 → 显示主窗口 / 新建任务 / 设置 / 打开日志目录 / 关于 / 退出;
 * - 图标内联(32×32 PNG data URL):不需要额外打包资源,Windows/Linux 均可用;
 * - 托盘命令先唤醒窗口再执行(与 ZCode 的 executeTrayCommand 语义一致),避免命令发到隐藏页看不见。
 *
 * 纯逻辑:electron 的 Tray/Menu/nativeImage 由调用方注入,可 node --test 单测。
 */
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAf0lEQVR4nGNgGIygP8XgPy0wyZaf7HelCibaEdS2GJdDBsRyvI6gl+U4HTEoHECMxg831xGFiXXE0HEAKQaTEg2jDhj6DhjwRDjgDqAkqkYdMOqAoeUAdAsoyX5D2wHUxIPPAQPeJBtQB9DTEQPaNyCpdzQgXTNsjqB755TeAAB+GdD5aISweQAAAABJRU5ErkJggg==";

function buildTrayMenuTemplate(opts = {}) {
  const appName = opts.appName || "Genie Harness";
  const run = (fn) => () => {
    try { fn && fn(); } catch (e) { /* 托盘点击异常不影响主进程 */ }
  };
  return [
    { label: "显示 " + appName, click: run(opts.onShow) },
    { type: "separator" },
    { label: "新建任务", click: run(opts.onNewTask) },
    { label: "设置", click: run(opts.onSettings) },
    { label: "检查更新", click: run(opts.onCheckUpdate) },
    { type: "separator" },
    { label: "打开日志目录", click: run(opts.onLogs) },
    { label: "关于 " + appName, click: run(opts.onAbout) },
    { type: "separator" },
    { label: "退出 " + appName, click: run(opts.onQuit) },
  ];
}

function createTrayController(options = {}) {
  const platform = options.platform || process.platform;
  // 与 ZCode 一致:仅 Windows/Linux 提供托盘(macOS 菜单栏另有惯例,不在此模拟)。
  if (platform !== "win32" && platform !== "linux") return null;
  const { Tray, Menu, nativeImage } = options;
  if (!Tray || !Menu || !nativeImage) return null;
  const log = typeof options.log === "function" ? options.log : () => undefined;
  const appName = options.appName || "Genie Harness";

  let tray;
  try {
    const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    tray = new Tray(image);
  } catch (e) {
    log(`[tray] create failed: ${(e && e.message) || e}`);
    return null;
  }

  const show = () => {
    try { options.onShow && options.onShow(); } catch (e) { /* 忽略 */ }
  };
  // 托盘命令:先唤醒窗口,再执行命令(否则命令到达的是隐藏页,用户看不到效果)
  const withShow = (fn) => () => {
    show();
    try { fn && fn(); } catch (e) { /* 忽略 */ }
  };

  try {
    tray.setToolTip(appName + " — 任务在后台继续运行");
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
      appName,
      onShow: show,
      onNewTask: withShow(options.onNewTask),
      onSettings: withShow(options.onSettings),
      onCheckUpdate: withShow(options.onCheckUpdate),
      onLogs: options.onLogs,
      onAbout: options.onAbout,
      onQuit: options.onQuit,
    })));
    tray.on("click", show);
    tray.on("double-click", show);
  } catch (e) {
    log(`[tray] setup failed: ${(e && e.message) || e}`);
  }

  log("[tray] created (menu=show/new-task/settings/check-update/logs/about/quit)");
  return {
    tray,
    iconDataUrl: TRAY_ICON_DATA_URL,
    destroy() {
      try { tray.destroy(); } catch (e) { /* 已销毁 */ }
    },
  };
}

module.exports = { buildTrayMenuTemplate, createTrayController, TRAY_ICON_DATA_URL };