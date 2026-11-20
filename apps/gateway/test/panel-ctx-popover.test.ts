import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 上下文余量 popover(十一轮,参照 ZCode「上下文余量」卡):
 * 头部进度条(已用/容量/百分比,≥85% 转红)+ 构成分段(消息/工具结果/工具调用/系统提示,按字符近似
 * 且诚实标注)+ 平均缓存命中率(llm.trace usage 经验证)+ 原有明细(经验证/估算/累计)不丢。 */
describe("上下文余量 popover 结构", () => {
  it("进度条/构成分段/命中率/诚实标注/固定宽度均在", async () => {
    const panel = servePanel(7931, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch("http://127.0.0.1:7931/");
      expect(res.status).toBe(200);
      const html = await res.text();
      for (const marker of [
        "上下文余量",
        '"pill-menu cx-menu"',
        ".pill-menu.cx-menu{width:320px",
        ".pill-menu .cx-bar i.hot",
        "cx-segs",
        "构成<span class=\"cx-note\">(按字符近似,非逐段实测)</span>",
        "平均缓存命中率",
        "缓存命中 tok",
        "p.cachedTokens",
        "系统提示/技能",
      ]) {
        expect(html, "缺少标记:" + marker).toContain(marker);
      }
    } finally {
      await panel.close();
    }
  });
});