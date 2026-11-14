/** 消息流 mermaid 懒加载渲染探针:占位节点→svg 出图;坏语法→降级 <pre> 保留源文本。
 * 语义与 test/ui/mdrender.spec.cjs 同源:直接驱动真实面板页的全局渲染函数与懒加载运行时;
 * PANEL_BASE 缺席(非 selfhost 形态)或无 chrome 时整文件 skip,不误报失败。 */
const fs = require("node:fs");
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE;
const CHROME = "/usr/bin/google-chrome";

(async () => {
  if (!BASE) { console.log("SKIP panel-mermaid: PANEL_BASE 未设置(selfhost 形态才跑:npx tsx test/ui/_ui_selfhost.cjs test/ui/mdrender-mermaid.spec.cjs)"); process.exit(0); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP panel-mermaid: 无 chrome(" + CHROME + ")"); process.exit(0); }
  const results = [];
  const check = (name, ok, detail) => { results.push(ok); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 120)));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // 1. mdToHtml 占位:```mermaid 产 .md-mermaid 占位且 data-src 保留完整源文本(含换行)
  const r1 = await page.evaluate(() => {
    const NL = String.fromCharCode(10);
    const src = "graph TD" + NL + "  A --> B" + NL + "  B --> C";
    const h = mdToHtml("前文" + NL + "```mermaid" + NL + src + NL + "```" + NL + "后文", "");
    const m = /<div class="md-mermaid"[^>]*data-src="([^"]*)"/.exec(h);
    return { hasPlaceholder: /class="md-mermaid"/.test(h), dataSrc: m ? m[1] : "", srcLen: src.length, h: h.slice(0, 140) };
  });
  // data-src 是 esc 后属性值:浏览器里 .getAttribute("data-src") 才能拿到还原文本,这里断言转义形态
  const dec = await page.evaluate((s) => { const d = document.createElement("div"); d.innerHTML = '<div data-src="' + s + '"></div>'; return d.firstChild.getAttribute("data-src"); }, r1.dataSrc);
  check("占位节点+源文本保留", r1.hasPlaceholder && dec && dec.length === r1.srcLen && /A --&gt; B|A --> B/.test(dec), "srcLen=" + r1.srcLen + " decLen=" + (dec ? dec.length : -1));

  // 2. 普通 ```js 代码块与改动前一致(is-code 板 + pre.code)
  const r2 = await page.evaluate(() => mdToHtml("```js" + String.fromCharCode(10) + "let y = 2;" + String.fromCharCode(10) + "```", ""));
  check("普通 js 代码块不回归", r2.includes('data-lang="js"') && r2.includes("code-wrap is-code") && r2.includes("let y = 2;") && !r2.includes("md-mermaid"), r2.slice(0, 100));

  // 3. 未闭合 ```mermaid(mdToHtml 按未闭合围栏走尾部 renderCodeBlock,产占位不炸;无占位则字面输出也不炸)
  const r3 = await page.evaluate(() => { try { return { ok: true, h: mdToHtml("```mermaid" + String.fromCharCode(10) + "graph TD" + String.fromCharCode(10) + "  A --> B", "") }; } catch (e) { return { ok: false, err: String(e) }; } });
  check("未闭合 mermaid 围栏不炸", r3.ok, r3.ok ? (r3.h.includes("md-mermaid") ? "尾部落占位" : "字面输出") : r3.err);

  // 4. 真渲染链:setHist + renderHistory 注入含好/坏两个 mermaid 块的消息 → 懒加载出 svg;坏块降级 pre 保留源文本
  const NL4 = String.fromCharCode(10);
  const CONV = [
    { seq: 1, kind: "message.user", time: Date.now() - 6000, payload: { text: "画两个图,一个好的一个坏的" } },
    { seq: 2, kind: "message.agent", time: Date.now() - 4000, llmMs: 100,
      payload: { text: "好图:" + NL4 + "```mermaid" + NL4 + "graph TD" + NL4 + "  A[开始] --> B{判断}" + NL4 + "  B -->|是| C[结束]" + NL4 + "  B -->|否| A" + NL4 + "```" + NL4 + "坏图:" + NL4 + "```mermaid" + NL4 + "this is @@@ not [valid mermaid ((((" + NL4 + "```" + NL4 + "完毕" } },
  ];
  const injected = await page.evaluate("(function(){ if(!window.__mature) return false; window.__mature.setHist(" + JSON.stringify(CONV) + "); window.__mature.renderHistory(); return true; })()");
  check("__mature 注入", injected, "");
  // 出图:渲染器主壳已 eager <script src="/assets/diagram-renderer.js"> 就位 → run 出 svg;最多等 8s
  let svgCount = 0, badPre = "", timerShot = false, scriptInjected = false;
  for (let t = 0; t < 40 && svgCount === 0; t++) { await page.waitForTimeout(200); svgCount = await page.locator("#chatBody .md-mermaid svg").count(); }
  await page.waitForTimeout(1500); // 坏块 render/reject 降级落定
  svgCount = await page.locator("#chatBody .md-mermaid svg").count();
  badPre = await page.evaluate(() => { const els = document.querySelectorAll("#chatBody .md-mermaid pre"); return els.length ? els[0].textContent : ""; });
  scriptInjected = await page.evaluate(() => !!document.querySelector('script[src="/assets/diagram-renderer.js"]'));
  check("占位节点渲染成 svg", svgCount >= 1, "svg=" + svgCount);
  check("坏语法块降级 pre 保留源文本", /not \[valid mermaid/.test(badPre), "pre=" + badPre.slice(0, 40).replace(/\n/g, "\\n"));
  check("渲染器脚本就位(eager 主壳标签,单实例)", scriptInjected && (await page.evaluate(() => document.querySelectorAll('script[src="/assets/diagram-renderer.js"]').length)) === 1, "");

  // 5. svg 不撑破卡片(max-width 生效)
  const maxw = await page.evaluate(() => { const s = document.querySelector("#chatBody .md-mermaid svg"); return s ? getComputedStyle(s).maxWidth : ""; });
  check("svg max-width:100%", maxw === "100%", "maxWidth=" + maxw);

  check("0 pageerror(懒加载链路)", consoleErrors.length === 0, consoleErrors.join(" | "));
  const fails = results.filter((x) => !x).length;
  console.log("mdrender-mermaid: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH " + String(e).slice(0, 300)); process.exit(2); });
