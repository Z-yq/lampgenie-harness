import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/**
 * 桌面能力接入契约:
 * - 系统通知走 preload 原生桥(主进程去重/焦点抑制),浏览器侧保留 HTML5 fallback;
 * - 只对 running/queued/pending → done/failed 的跃迁通知(重连重放/历史终态不刷屏);
 * - notifyTaskDone 只能有一份实现(此前两份重复声明,后者覆盖前者导致通知链路失效);
 * - 角色菜单命令与通知点击都要有面板侧消费入口。
 */
describe("面板桌面能力接入", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://${"127.0.0.1"}:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  it("fireNotify 优先走 preload 原生通知,浏览器保留 Notification fallback", async () => {
    const html = await fetchHtml(7941);
    const i = html.indexOf("function fireNotify(");
    expect(i).toBeGreaterThan(0);
    const fn = html.slice(i, i + 1200);
    expect(fn).toContain("bridge.notify(payload)");
    expect(fn).toContain("Notification.permission === \"granted\"");
    expect(fn).toContain("taskId");
    expect(fn).toContain("status");
  });

  it("桌面默认开启任务通知(浏览器仍默认 off,等授权)", async () => {
    const html = await fetchHtml(7942);
    expect(html).toContain('window.genieWindow.isDesktop) ? "on" : "off"');
  });

  it("终态跃迁守卫:只通知 running/queued/pending → done/failed", async () => {
    const html = await fetchHtml(7943);
    const i = html.indexOf("function notifyTaskDone(");
    expect(i).toBeGreaterThan(0);
    const fn = html.slice(i, i + 1400);
    expect(fn).toContain("lastTaskState");
    expect(fn).toContain('prev === "running" || prev === "queued" || prev === "pending"');
    expect(fn).toContain("document.visibilityState");
    expect(fn).toContain("fireNotify(");
    // 只允许一份实现
    expect(html.match(/function notifyTaskDone\(/g)?.length).toBe(1);
  });

  it("菜单命令/通知点击有面板侧消费:新建任务、设置、按任务切会话", async () => {
    const html = await fetchHtml(7944);
    expect(html).toContain("onMenuCommand");
    expect(html).toContain('$("act-new")');
    expect(html).toContain('switchView("sys")');
    expect(html).toContain("onNotificationClick");
    expect(html).toContain("openSession(t.sessionId)");
  });
});