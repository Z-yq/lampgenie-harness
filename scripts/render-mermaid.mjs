#!/usr/bin/env node
/**
 * 把 mermaid 源码渲染成 SVG/PNG(零联网:用仓内 apps/gateway/src/assets/mermaid.min.js
 * 与 gateway 依赖的 playwright-core;字体走系统 CJK)。给代码档案/评审/任务证据出图用。
 * 用法:
 *   node scripts/render-mermaid.mjs <in.mmd> <out.svg|out.png> [--width 2200] [--theme dark]
 * 说明:输出目录自动创建;渲染失败非零退出(不写半成品)。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("用法: node scripts/render-mermaid.mjs <in.mmd> <out.svg|out.png> [--width 2200]");
  process.exit(2);
}
const input = resolve(args[0]);
const output = resolve(args[1]);
const widthArg = args.indexOf("--width");
const width = widthArg >= 0 ? Number(args[widthArg + 1]) || 2200 : 2200;
if (!existsSync(input)) {
  console.error(`输入不存在: ${input}`);
  process.exit(2);
}
const ext = output.slice(output.lastIndexOf(".")).toLowerCase();
if (ext !== ".svg" && ext !== ".png") {
  console.error(`输出必须是 .svg 或 .png(收到 ${ext})`);
  process.exit(2);
}
const mermaidAsset = resolve(repoRoot, "apps/gateway/src/assets/mermaid.min.js");
if (!existsSync(mermaidAsset)) {
  console.error(`找不到 mermaid 资产: ${mermaidAsset}`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
let chromium;
try {
  const pwPath = require.resolve("playwright-core", { paths: [resolve(repoRoot, "apps/gateway")] });
  ({ chromium } = require(pwPath));
} catch (err) {
  console.error(`playwright-core 不可用: ${String(err)}`);
  process.exit(2);
}

const source = readFileSync(input, "utf-8");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#0b0806;color:#ece1d1;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif}
  #c{padding:28px;display:inline-block;background:#0b0806}
  #c svg{max-width:none!important}
</style></head><body><div id="c"></div>
<script src="${pathToFileURL(mermaidAsset).href}"></script>
<script>
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "dark",
    fontFamily: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif',
    themeVariables: {
      background: "#0b0806", primaryColor: "#1a120a", primaryTextColor: "#ece1d1",
      primaryBorderColor: "#c98f45", lineColor: "#c98f45", fontSize: "14px",
      clusterBkg: "#120d08", clusterBorder: "#6b5c4a", edgeLabelBackground: "#0b0806"
    },
    flowchart: { htmlLabels: true, curve: "basis", padding: 12, nodeSpacing: 34, rankSpacing: 52 }
  });
  window.__render = async (src) => {
    const { svg } = await mermaid.render("m" + Date.now().toString(36), src);
    document.getElementById("c").innerHTML = svg;
    const el = document.querySelector("#c svg");
    const vb = el.viewBox && el.viewBox.baseVal;
    if (vb && vb.width > 0) {
      // mermaid 缺省写 width=100%/max-width,宽图会被容器压扁;按 viewBox 钉回自然像素尺寸
      el.removeAttribute("width");
      el.removeAttribute("height");
      el.style.maxWidth = "none";
      el.style.width = vb.width + "px";
      el.style.height = vb.height + "px";
    }
    return { w: el.getBBox().width, h: el.getBBox().height };
  };
</script></body></html>`;

mkdirSync(dirname(output), { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const htmlPath = resolve(tmpdir(), `mermaid-render-${process.pid}-${Date.now()}.html`);
writeFileSync(htmlPath, html, "utf-8");
try {
  const page = await browser.newPage({ viewport: { width, height: 1400 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__render === "function", null, { timeout: 20000 });
  await page.evaluate((src) => window.__render(src), source);
  await page.waitForTimeout(300);
  if (ext === ".svg") {
    const svg = await page.$eval("#c svg", (el) => el.outerHTML);
    writeFileSync(output, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`, "utf-8");
  } else {
    const el = await page.$("#c");
    if (!el) throw new Error("渲染结果 #c 不存在");
    await el.screenshot({ path: output });
  }
  console.log(`rendered: ${output}`);
} finally {
  await browser.close();
  rmSync(htmlPath, { force: true });
}