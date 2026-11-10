/**
 * role-based 应用菜单(菜单结构语义设计参考 ZCode 项目,致谢;本仓独立实现)。
 *
 * 为什么需要:壳此前 `Menu.setApplicationMenu(null)`,Ctrl+C/V/X/A/Z、Ctrl+R、F12 这些
 * 桌面用户默认期待的快捷键全靠 Chromium 兜底,且没有「关于/日志目录」等桌面入口。
 *
 * 设计约束:
 * - 编辑类用 Electron role(标准快捷键 + 系统语义);
 * - 缩放不用 role(role 直接改 webContents,绕过壳的持久化与夹取):用 accelerator 只展示
 *   (`registerAccelerator:false`),真实按键仍由 main.js 的 before-input-event 统一处理,
 *   避免同一次 Ctrl+= 被菜单和键盘各放大一级;
 * - 纯函数返回模板,不 require("electron"),可 node --test 直接测。
 */

/** 菜单命令 id(renderer 侧通过 preload onMenuCommand 消费)。 */
const MENU_COMMANDS = {
  newTask: "new-task",
  openSettings: "open-settings",
};

function buildApplicationMenuTemplate(opts = {}) {
  const platform = opts.platform || process.platform;
  const appName = opts.appName || "Genie Harness";
  const isMac = platform === "darwin";
  const command = (id) => () => {
    try { opts.onCommand && opts.onCommand(id); } catch (e) { /* 发送失败不影响菜单 */ }
  };
  const zoom = (kind) => () => {
    try { opts.onZoom && opts.onZoom(kind); } catch (e) { /* 同上 */ }
  };
  const help = (kind) => () => {
    try { opts.onHelp && opts.onHelp(kind); } catch (e) { /* 同上 */ }
  };
  const about = () => {
    try { opts.onAbout && opts.onAbout(); } catch (e) { /* 同上 */ }
  };

  const template = [
    ...(isMac
      ? [{
          label: appName,
          submenu: [
            { role: "about", label: "关于 " + appName },
            { type: "separator" },
            { role: "services", label: "服务" },
            { type: "separator" },
            { role: "hide", label: "隐藏 " + appName },
            { role: "hideOthers", label: "隐藏其他" },
            { role: "unhide", label: "全部显示" },
            { type: "separator" },
            { role: "quit", label: "退出 " + appName },
          ],
        }]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建任务", accelerator: "CmdOrCtrl+N", click: command(MENU_COMMANDS.newTask) },
        { label: "设置", accelerator: "CmdOrCtrl+,", click: command(MENU_COMMANDS.openSettings) },
        { type: "separator" },
        isMac
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        // 只展示键位,不注册快捷键(键盘路径由 main.js 统一处理并持久化缩放级别)
        { label: "放大", accelerator: "CmdOrCtrl+=", registerAccelerator: false, click: zoom("in") },
        { label: "缩小", accelerator: "CmdOrCtrl+-", registerAccelerator: false, click: zoom("out") },
        { label: "重置缩放", accelerator: "CmdOrCtrl+0", registerAccelerator: false, click: zoom("reset") },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭" },
        ...(isMac ? [{ role: "front", label: "前置全部窗口" }] : []),
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "检查更新…", click: help("update") },
        { type: "separator" },
        { label: "打开日志目录", click: help("logs") },
        { label: "打开数据目录", click: help("data") },
        { type: "separator" },
        { label: "关于 " + appName, click: about },
      ],
    },
  ];
  return template;
}

module.exports = { buildApplicationMenuTemplate, MENU_COMMANDS };