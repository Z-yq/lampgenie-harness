import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 面板整页语法守卫:PAGE 是超大模板串,模板层吃转义/引号冲突会把整窗脚本打崩
 * (注意两例:rpt-sec-b 双引号包 class=".." 提前终结字符串 →「Unexpected identifier 'rpt'」;
 * split("\n") 被模板层转成真实换行打断字符串)。此前无任何守卫,坏 PAGE 直接上线=白屏。
 * 这里对 servePanel 下发的每个内联 <script> 块做 new Function 语法编译,一个不过即红。 */
describe("面板整页内联脚本语法守卫", () => {
  it("servePanel 下发的全部内联 <script> 块均可被 JS 引擎编译", async () => {
    const panel = servePanel(7941, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch("http://127.0.0.1:7941/");
      expect(res.status).toBe(200);
      const html = await res.text();
      const blocks = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(blocks.length, "页面应有内联脚本块").toBeGreaterThan(3);
      for (let i = 0; i < blocks.length; i++) {
        let err: string | null = null;
        try { new Function(blocks[i]); } catch (e) { err = String(e).slice(0, 160); }
        expect(err, "内联脚本块 #" + i + " 语法错误:" + (err || "")).toBeNull();
      }
    } finally {
      await panel.close();
    }
  });
});