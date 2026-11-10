import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/**
 * 新用户首启引导(2026-11-08 桌面实测回归)。
 * 实测事故:全新数据根下点「无可用模型」只会发一条注定失败的 models.list,弹「到设置页…」
 * 的错误 toast 却没有入口(设置入口只有底部小齿轮);空会话也没有任何引导。
 * 这里锁三面:模型 pill 的零 provider 分支、首启引导卡、空态接线。
 */
describe("新用户首启引导", () => {
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

  it("模型 pill:零 provider + 零主模型时直达设置页「模型设置」(不再空转 models.list)", async () => {
    const html = await fetchHtml(7931);
    const i = html.indexOf('$("modelPill").onclick = () => {');
    expect(i).toBeGreaterThan(0);
    const body = html.slice(i, i + 900);
    expect(body).toContain("providerCount");
    expect(body).toContain("!providerCount && !modelSwitchGlobalModel()");
    expect(body).toContain('switchView("sys")');
    expect(body).toContain('setSection("model")');
    expect(body).toContain("添加供应商");
    // 重试分支仍在(有 provider 但目录拉取失败时)
    expect(body).toContain("modelListFailed");
  });

  it("空会话渲染首启引导卡:只缺什么显示什么,含两条直达路径", async () => {
    const html = await fetchHtml(7932);
    expect(html).toContain("function firstRunCardHtml()");
    const i = html.indexOf("function firstRunCardHtml()");
    const fn = html.slice(i, html.indexOf("\n}\n", i) + 2);
    expect(fn).toContain("hasModel");
    expect(fn).toContain("hasProject");
    expect(fn).toContain('data-onboard="');
    expect(fn).toContain('"model"');
    expect(fn).toContain('"project"');
    // 已完成项不再给按钮,缺项才给
    expect(fn).toContain("if (hasModel && hasProject) return \"\"");
    // 空态接线
    expect(html).toContain("该会话暂无记录</div>\" + firstRunCardHtml()");
    // 事件委托(增量渲染不丢)
    expect(html).toContain('closest("[data-onboard]")');
    expect(html).toContain('dbOpen("")');
  });

  it("首开设置不出现「已切换为跟随全局」幽灵提示(只有本标签发过 set 才通知)", async () => {
    const html = await fetchHtml(7934);
    expect(html).toContain("const wasStaged = sessionModelStaged.has(m.sessionId)");
    expect(html).toContain("if (wasStaged) modelSwitchNotice");
  });

  it("引导卡样式随面板主题变量走(不写死颜色)", async () => {
    const html = await fetchHtml(7933);
    const i = html.indexOf(".first-run-card{");
    expect(i).toBeGreaterThan(0);
    const css = html.slice(i, i + 1600);
    expect(css).toContain("var(--border-soft)");
    expect(css).toContain("var(--glass)");
    expect(css).toContain("var(--bronze)");
    expect(css).toContain(".fr-step[disabled]");
  });
});