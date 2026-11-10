/**
 * 界面主题替换守卫(2026-10-20):下线 neon/crt/aurora,上线取自三张色板的
 * sand(砂陶松影)/olive(橄榄赤陶)/plum(蓝调梅影);两套页面(主面板 + /profile)都要生效。
 * 同时守卫 /profile 的内联脚本可解析(模板里的脚本改动不走 TS 编译)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

function compileScripts(html: string): number {
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  for (const code of blocks) expect(() => new Function(code)).not.toThrow();
  return blocks.length;
}

describe("主题替换(sand/olive/plum 上线,neon/crt/aurora 下线)", () => {
  it("主面板:新主题按钮/CSS/注册表在位,旧主题类绝迹,脚本可解析", async () => {
    const srv = servePanel(7891, () => { /* 无 WS */ });
    try {
      const html = await (await fetch("http://127.0.0.1:7891/")).text();
      for (const [key, name] of [["sand", "砂陶松影"], ["olive", "橄榄赤陶"], ["plum", "蓝调梅影"]]) {
        expect(html, key).toContain('data-v="' + key + '"');
        expect(html, name).toContain(name);
        expect(html, "body.theme-" + key).toContain("body.theme-" + key + "{");
        expect(html, "base light " + key).toContain('{ key: "' + key + '", name: "' + name + '"');
      }
      expect(html).not.toMatch(/body\.theme-(neon|crt|aurora)/);
      expect(html).not.toContain("霓虹夜城");
      expect(html).not.toContain("磷光终端");
      expect(html).not.toContain("极光悬冰");
      expect(html).toContain('const LEGACY_THEME_MAP = { neon: "sand", crt: "olive", aurora: "plum" }');
      expect(compileScripts(html)).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("/profile:新主题 CSS 在位、旧主题绝迹、内联脚本可解析", async () => {
    const srv = servePanel(7892, () => { /* 无 WS */ });
    try {
      const html = await (await fetch("http://127.0.0.1:7892/profile?p=__harness__")).text();
      for (const key of ["sand", "olive", "plum"]) expect(html, key).toContain("body.theme-" + key + "{");
      expect(html).not.toMatch(/body\.theme-(neon|crt|aurora)/);
      expect(compileScripts(html)).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("super-console(右下角指挥台)颜色全部走主题变量", async () => {
    const srv = servePanel(7893, () => { /* 无 WS */ });
    try {
      const js = await (await fetch("http://127.0.0.1:7893/assets/super-console.js")).text();
      expect(js).toContain(".sc-head");
      expect(js).toContain("#sc-input");
      // 用带 fallback 形态断言(CSS 变量在资产里写作 var(--x,fallback))
      for (const v of ["var(--glass2", "var(--border-soft", "var(--reply", "var(--muted", "var(--faint", "var(--bronze", "var(--accent-soft"]) {
        expect(js, v).toContain(v);
      }
      // 旧硬编码暗底/暖字不再出现(遮罩 #000 除外)
      expect(js).not.toContain("rgba(16,11,6");
      expect(js).not.toContain("rgba(24,19,12");
      expect(js).not.toContain("#cbbfa8");
      expect(js).not.toContain("#f2e7d4");
      // 数字人形态彻底退役:无视频/WHEP/音频播放
      expect(js).not.toContain("createOffer");
      expect(js).not.toContain("dh-video");
      expect(js).not.toContain("new Audio(");
      // 主面板不再有立绘/PTT 浮字
      const html = await (await fetch("http://127.0.0.1:7893/")).text();
      expect(html).not.toContain("avatar-badge");
      expect(html).not.toContain("ptt-label");
    } finally {
      await srv.close();
    }
  }, 30_000);
});
