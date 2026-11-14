#!/usr/bin/env node
/**
 * 把 mermaid 语法的图源渲染成 SVG/PNG(零联网:自有 diagram-renderer.js 出 SVG,
 * PNG 走 gateway 依赖的 playwright-core 截图;字体走系统 CJK)。给代码档案/评审/任务证据出图用。
 * 用法:
 *   node scripts/render-diagram.mjs <in.mmd> <out.svg|out.png> [--width 2200] [--theme dark]
 * 说明:输出目录自动创建;渲染失败非零退出(不写半成品)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("用法: node scripts/render-diagram.mjs <in.mmd> <out.svg|out.png> [--width 2200] [--theme dark]");
  process.exit(2);
}
const input = resolve(args[0]);
const output = resolve(args[1]);
const widthArg = args.indexOf("--width");
const width = widthArg >= 0 ? Number(args[widthArg + 1]) || 2200 : 2200;
const themeArg = args.indexOf("--theme");
const theme = themeArg >= 0 && ["light", "dark"].includes(args[themeArg + 1]) ? args[themeArg + 1] : "dark";
if (!existsSync(input)) {
  console.error(`输入不存在: ${input}`);
  process.exit(2);
}
const ext = output.slice(output.lastIndexOf(".")).toLowerCase();
if (ext !== ".svg" && ext !== ".png") {
  console.error(`输出必须是 .svg 或 .png(收到 ${ext})`);
  process.exit(2);
}
const rendererAsset = resolve(repoRoot, "apps/gateway/src/assets/diagram-renderer.js");
if (!existsSync(rendererAsset)) {
  console.error(`找不到渲染器资产: ${rendererAsset}`);
  process.exit(2);
}

const source = readFileSync(input, "utf-8");

// 自有渲染器是纯函数 UMD:同进程装载出 OwnDiagram,出 SVG 无浏览器必要。
// 装载路径双兜底:globalThis 已挂(ESM 装载走 root 分支)直接用;否则 createRequire 走 CJS 分支。
const require = createRequire(import.meta.url);
if (!globalThis.OwnDiagram) require(rendererAsset);
const OwnDiagram = globalThis.OwnDiagram;
if (!OwnDiagram || typeof OwnDiagram._renderSvg !== "function") {
  console.error("渲染器装载失败(UMD 两分支都未挂出 OwnDiagram)");
  process.exit(2);
}
OwnDiagram.configure({ theme });

let svg;
try {
  svg = OwnDiagram._renderSvg(source);
} catch (err) {
  console.error(`渲染失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (ext === ".svg") {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, svg, "utf-8");
  console.log(`SVG 已写出: ${output}`);
  process.exit(0);
}

// PNG:playwright 截图(SVG 天然矢量,按 viewBox 固有尺寸 2x 采样)
let chromium;
try {
  const pwPath = require.resolve("playwright-core", { paths: [resolve(repoRoot, "apps/gateway")] });
  ({ chromium } = require(pwPath));
} catch (err) {
  console.error(`playwright-core 不可用: ${String(err)}`);
  process.exit(2);
}

const vm = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
if (!vm) {
  console.error("SVG 缺 viewBox,无法定尺寸");
  process.exit(1);
}
const vw = Math.ceil(Number(vm[1])), vh = Math.ceil(Number(vm[2]));
const pal = theme === "light" ? "#faf6ee" : "#0b0806";
const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${pal}">
<div id="host" style="width:${Math.min(vw, width)}px">${svg.replace(/width="\d+" height="\d+"/, `width="100%"`)}</div>
<style>svg{display:block} text{font-family:'PingFang SC','Microsoft YaHei',sans-serif}</style></body>`;

const { execFileSync } = await import("node:child_process");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const chrome = process.env.CHROME_PATH || "";
const tmp = mkdtempSync(join(tmpdir(), "dgrender-"));
try {
  const htmlPath = join(tmp, "d.html");
  const pngPath = output;
  writeFileSync(htmlPath, html, "utf-8");
  const launchOpts = chrome ? { executablePath: chrome } : {};
  const browser = await chromium.launch({ ...launchOpts, args: ["--no-sandbox", "--force-color-profile=srgb"] });
  try {
    const page = await browser.newPage({ viewport: { width: Math.min(vw, width), height: vh + 20 }, deviceScaleFactor: 2 });
    await page.goto("file://" + htmlPath, { waitUntil: "load" });
    await page.waitForTimeout(120); // 字体稳定窗
    const host = await page.$("#host");
    await host.screenshot({ path: pngPath });
    console.log(`PNG 已写出: ${pngPath}(viewBox ${vw}x${vh},2x)`);
  } finally {
    await browser.close();
  }
} catch (err) {
  console.error(`PNG 截图失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
process.exit(0);
