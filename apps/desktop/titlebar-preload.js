/** 桌面壳窗口控制桥:面板无边框后,最小化/最大化/关闭走 IPC。
 * contextIsolation+sandbox 保持开启;只暴露固定方法,不暴露任意 IPC。
 * 增补:系统通知(notify)与应用菜单/通知点击订阅(onMenuCommand/onNotificationClick)。 */
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, cb) {
  const handler = (_event, payload) => {
    try {
      cb(payload == null ? {} : payload);
    } catch {
      /* 面板侧回调异常不影响壳 */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("genieWindow", {
  isDesktop: true,
  minimize: () => ipcRenderer.invoke("genie:window", "minimize"),
  toggleMaximize: () => ipcRenderer.invoke("genie:window", "toggle-maximize"),
  close: () => ipcRenderer.invoke("genie:window", "close"),
  isMaximized: () => ipcRenderer.invoke("genie:window", "is-maximized"),
  captureEnter: () => ipcRenderer.invoke("genie:window", "capture-enter"),
  captureExit: () => ipcRenderer.invoke("genie:window", "capture-exit"),
  onMaximizeChange: (cb) => {
    const handler = (_event, value) => {
      try {
        cb(!!value);
      } catch {
        /* 面板侧回调异常不影响窗口 */
      }
    };
    ipcRenderer.on("genie:maximized", handler);
    return () => ipcRenderer.removeListener("genie:maximized", handler);
  },
  // 系统通知:主进程做字段白名单/限长/去重/焦点抑制/点击恢复窗口;返回是否真正弹出。
  notify: (payload) => ipcRenderer.invoke("genie:notify", payload && typeof payload === "object" ? payload : {}),
  // 菜单命令(文件→新建任务/设置):payload 是命令 id 字符串。
  onMenuCommand: (cb) => subscribe("genie:menu-command", (id) => cb(String(id || ""))),
  // 用户点了系统通知:主进程已恢复窗口,这里回传 {taskId,status} 让面板可跳会话。
  onNotificationClick: (cb) => subscribe("genie:notification-click", cb),
  // genie:// 深链:主进程解析后回传 {raw,action,...};面板按动作切视图/会话。
  onDeepLink: (cb) => subscribe("genie:deep-link", cb),
 // 版本检查/应用内更新:主进程持有状态机,面板只发白名单动作并订阅状态。
  // 动作:state/check/download/dismiss/open-page/install;install 会静默安装并退出壳。
  updates: {
    getState: () => ipcRenderer.invoke("genie:update", "state"),
    check: () => ipcRenderer.invoke("genie:update", "check"),
    configure: (cfg) => ipcRenderer.invoke("genie:update", "configure", cfg && typeof cfg === "object" ? cfg : {}),
    download: () => ipcRenderer.invoke("genie:update", "download"),
    dismiss: () => ipcRenderer.invoke("genie:update", "dismiss"),
    openPage: () => ipcRenderer.invoke("genie:update", "open-page"),
    install: (opts) => ipcRenderer.invoke("genie:update", "install", opts && typeof opts === "object" ? opts : {}),
    onState: (cb) => subscribe("genie:update-state", cb),
  },
});