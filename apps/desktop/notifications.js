/**
 * 原系统通知控制器(三条硬语义设计参考 ZCode 项目,致谢;本仓独立实现):
 *   ① 窗口有焦点时不打扰(用户正看着);
 *   ② 3s 去重(重连/重复广播不刷屏),key=status:taskId;
 *   ③ 显式持有 Notification 对象到 click/close——只存在局部变量里会被 GC,点击监听丢失,
 *      出现「有通知但点了没反应」。
 * 另:click 负责 restore/show/focus 三步(最小化/隐藏时能真正回到前台),并回传 renderer 任务 id。
 *
 * 纯逻辑:Notification 构造器、窗口焦点/恢复、renderer 发送全部注入,可 node --test 单测。
 */
const DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_NOTIFICATIONS = 100;

function createNotificationController(options = {}) {
  const NotificationCtor = options.Notification;
  const isWindowFocused = typeof options.isWindowFocused === "function" ? options.isWindowFocused : () => false;
  const focusWindow = typeof options.focusWindow === "function" ? options.focusWindow : () => undefined;
  const sendToRenderer = typeof options.sendToRenderer === "function" ? options.sendToRenderer : () => undefined;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const log = typeof options.log === "function" ? options.log : () => undefined;

  const recent = new Map();
  const active = new Set();

  function prune(ts) {
    for (const [key, at] of recent) {
      if (ts - at > DEDUPE_WINDOW_MS) recent.delete(key);
    }
  }

  function show(payload = {}) {
    const title = String(payload.title == null ? "" : payload.title).trim().slice(0, 80);
    const body = String(payload.body == null ? "" : payload.body).trim().slice(0, 200);
    const taskId = payload.taskId ? String(payload.taskId) : "";
    const status = payload.status ? String(payload.status) : "";
    if (!title || !body) return false;
    if (!NotificationCtor) {
      log("[notify] skip: Notification ctor unavailable");
      return false;
    }
    if (typeof NotificationCtor.isSupported === "function" && !NotificationCtor.isSupported()) {
      log("[notify] skip: platform reports not supported");
      return false;
    }
    try {
      if (isWindowFocused()) {
        log("[notify] skip: window focused");
        return false;
      }
    } catch (e) { /* 焦点查询失败按未聚焦处理(宁可多通知一次) */ }

    const ts = now();
    prune(ts);
    const key = status + ":" + (taskId || title);
    if (recent.has(key)) {
      log("[notify] skip: duplicate within window");
      return false;
    }
    recent.set(key, ts);

    let notification;
    try {
      notification = new NotificationCtor({ title, body, silent: true });
    } catch (e) {
      log(`[notify] construct failed: ${(e && e.message) || e}`);
      return false;
    }

    // 显式持有,直到 click/close;超上限丢最旧(只影响可点击性,不影响已弹出的系统通知)
    active.add(notification);
    while (active.size > MAX_ACTIVE_NOTIFICATIONS) {
      const oldest = active.values().next().value;
      if (!oldest) break;
      active.delete(oldest);
    }

    notification.once("click", () => {
      active.delete(notification);
      try { focusWindow(); } catch (e) { /* 窗口可能已销毁 */ }
      try { sendToRenderer("genie:notification-click", { taskId, status }); } catch (e) { /* 忽略 */ }
      log(`[notify] click ${status || "info"} ${taskId || ""}`.trim());
    });
    notification.once("close", () => active.delete(notification));

    try {
      notification.show();
    } catch (e) {
      active.delete(notification);
      log(`[notify] show failed: ${(e && e.message) || e}`);
      return false;
    }
    log(`[notify] shown ${status || "info"} ${taskId || ""}`.trim());
    return true;
  }

  return {
    show,
    activeCount: () => active.size,
    reset() {
      active.clear();
      recent.clear();
    },
  };
}

module.exports = { createNotificationController, DEDUPE_WINDOW_MS, MAX_ACTIVE_NOTIFICATIONS };