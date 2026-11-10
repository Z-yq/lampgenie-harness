import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** genie:// 深链面板侧消费:设置/新建任务/会话/项目/未知。 */
describe("面板深链接入", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  it("绑定 onDeepLink 并按动作路由", async () => {
    const html = await fetchHtml(7951);
    expect(html).toContain('typeof bridge.onDeepLink === "function"');
    const i = html.indexOf("bridge.onDeepLink(");
    expect(i).toBeGreaterThan(0);
    const block = html.slice(i, i + 900);
    expect(block).toContain('d.action === "settings"');
    expect(block).toContain('d.action === "new-task"');
    expect(block).toContain('d.action === "session"');
    expect(block).toContain('d.action === "project"');
    expect(block).toContain("openSession(String(d.sessionId))");
    expect(block).toContain('"project.add"');
    expect(block).toContain("已通过 genie://");
  });
});
