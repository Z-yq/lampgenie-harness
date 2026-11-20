import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** :Super 指挥台两处浮层显示修复的回归门。
 * 背景:用户截图两处 BUG——①「上下文余量」浮层飘在中栏、数值与 Super pill 不同源(9% vs 35%);
 * ②模型下拉在界面缩放(settings.zoom→body.style.zoom)下右缘被视口裁切。
 * 根因:fixed 浮层的 left/bottom 会被 body zoom 再乘一次;Super pill 之前没有自己的浮层。
 * 这里锁结构:Super 自有浮层 + 同源取数 + zoom 换算 + 浮层不透明底(不允许 --window-bg,glass 主题带 alpha)。 */
describe("Super 浮层显示修复", () => {
  it("Super 上下文浮层/同源取数/zoom 校正/不透明底均在", async () => {
    const panel = servePanel(7932, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch("http://127.0.0.1:7932/");
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const marker of [
        "function supCtxNums()",          // 同源取数(pill 与浮层共用)
        "function supCtxMenuOpen()",      // Super pill 自己的余量浮层
        "function supPillFit(",           // zoom 换算定位
        "function supUiZoom()",
        "getComputedStyle(document.body).zoom",
 // pill 点击 → 打开本会话浮层(不再只 toast)
        'supCtxRequest(); supCtxMenuOpen();',
 // 模型菜单开完再按 zoom 夹紧
        "supPillFit(anchor)",
 // 浮层不透明底:--bg 在各主题都是实色,--window-bg 在 glass 主题是 rgba
        ".pill-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;\n    background:var(--bg,#141009)",
        ".pill-menu .pm-foot{position:sticky;bottom:0;z-index:2;background:var(--bg,#141009)",
      ]) {
        expect(html, "缺少标记:" + marker).toContain(marker);
      }
 // 反例:浮层底色不允许再走带 alpha 的 --window-bg
      expect(html).not.toContain(".pill-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;\n    background:var(--window-bg");
    } finally {
      await panel.close();
    }
  });
});