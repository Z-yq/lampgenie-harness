/**
 * 面板内联脚本语法守卫(事故:team 任务在 panel.ts 的 PAGE 模板里写了 `join("\n")`,
 * 模板层把转义变成真换行 → 整段脚本 SyntaxError → 页面 HTML 正常但 WS 从未连上,
 * 用户看到「一直连接中」。仓规:模板内字符串换行用 String.fromCharCode(10)。
 * 扩面:src/assets/*.js(画布壳/数字人窗/白板布局等独立资产)同样无 TS 编译
 * 护栏——当日注意 canvas-shell.js 的 CSS 数组字符串未闭合,坏文件随构建直进 dist,
 * 线上画布脚本整体 SyntaxError。资产文件逐一用 new Function 解析(只编译不执行)。
 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets");

describe("面板脚本语法", () => {
  it("页面内联脚本可被 JS 解析(模板反斜杠坑守卫)", async () => {
    const port = 7869;
    const srv = servePanel(port, () => { /* 不需要 WS */ });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const html = await res.text();
      const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      const big = blocks.reduce((a, b) => (a.length >= b.length ? a : b), "");
      expect(big.length).toBeGreaterThan(10_000);
      expect(() => new Function(big)).not.toThrow();
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("src/assets/*.js 全部可被 JS 解析(资产无编译护栏,坏文件会随构建直进生产环境)", async () => {
    const files = readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(4); // 画布壳/数字人窗/白板布局/状态件/输入策略等
    for (const f of files) {
      const code = readFileSync(join(ASSETS_DIR, f), "utf8");
      try {
        expect(() => new Function(code), "assets/" + f).not.toThrow();
      } catch (e) {
 // E1:diagram-viewport.js 等 ESM 尾导出资产(尾部 export,
        // 面板侧走动态 import 挂 window,见 panel.ts 的 mount())。new Function 是经典脚本口径,
        // 对它们必然 SyntaxError——改用真模块解析器(同浏览器口径)校验,坏文件照样拦。
        if (!/^\s*(export|import)\b/m.test(code)) throw e;
        await expect(import(pathToFileURL(join(ASSETS_DIR, f)).href), "assets/" + f).resolves.toBeTruthy();
      }
    }
  }, 30_000);
});
