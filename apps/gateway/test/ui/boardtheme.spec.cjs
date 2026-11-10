/** 白板流程图组件主题跟随探针(自起临时实例 7794,不碰生产环境 7700)。
 * 口径:主题 = body 类切换(`body.light` + `body.theme-<key>`,与面板 setTheme 落到 DOM 的结果一致),
 * 逐套经验证流程图组件的**计算色**:.cv-node 底/边、.cv-head 标题、.cv-sum 摘要、.cv-foot 元信息、
 *   .cv-fold 计数块、.cv-lane 泳道框;并核对 kind 图标色(.cv-kind.cv-k-*)是功能色,跨主题恒等。
 * 判定:浅色基座(light/sand/olive/plum/ink)卡底与计数块底必须是浅底(相对亮度>0.5);
 *       深色基座(dark/glass)必须是深底(<0.25);标题对比度≥3:1,摘要/脚注≥2.5:1;kind 图标色恒等。
 * 无 chrome/无 playwright-core/无真实板文件时打印 skipped: <reason> 并 exit 0。
 * 跑法:cd apps/gateway && npx tsx test/ui/boardtheme.spec.cjs
 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7794);
const SID = "ui-boardtheme-7794";
const SRC_SID = "web-1792774467576";
const SRC_TASK = "dec3a2d2-b812-4fe1-899b-c2a91365ea26";
const SRC_FILE = path.join(HARNESS_ROOT, ".genie", "boards", SRC_SID, SRC_TASK + ".json");
const skip = (reason) => { console.log("skipped: " + reason); process.exit(0); };

let chromium = null;
try { chromium = require("playwright-core").chromium; } catch (e) { skip("playwright-core 不可用(" + String(e && e.message).slice(0, 60) + ")"); }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome 可执行文件 " + CHROME);
if (!fs.existsSync(SRC_FILE)) skip("无真实板文件 " + SRC_FILE);

const TEST_DIR = path.join(HARNESS_ROOT, ".genie", "boards", SID);
const TEST_FILE = path.join(TEST_DIR, SRC_TASK + ".json");
const HOST_SEL = "#boardGraph #cvHost";
const THEMES = [
  { key: "dark", base: "dark" }, { key: "light", base: "light" }, { key: "sand", base: "light" },
  { key: "glass", base: "dark" }, { key: "olive", base: "light" }, { key: "plum", base: "light" }, { key: "ink", base: "light" },
];
// 页面内量测表达式(单点真相,避免两处副本漂移)
const MEASURE_SRC = "(() => {" +
  "const parse=(s)=>{const m=String(s).match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(',').map(Number);return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};};" +
  "const over=(f,b)=>({r:f.r*f.a+b.r*(1-f.a),g:f.g*f.a+b.g*(1-f.a),b:f.b*f.a+b.b*(1-f.a),a:1});" +
  "const lum=(c)=>{const f=(v)=>{const s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};" +
  "const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);return Math.round(((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05))*100)/100;};" +
  "const rgb=(c)=>c?[Math.round(c.r),Math.round(c.g),Math.round(c.b)].join(','):null;" +
  "const bodyBg=over(parse(getComputedStyle(document.body).backgroundColor)||{r:0,g:0,b:0,a:1},{r:255,g:255,b:255,a:1});" +
  "const cv=document.querySelector('#boardGraph .bf-canvas');" +
  "const canvasBg=cv?over(parse(getComputedStyle(cv).backgroundColor),bodyBg):bodyBg;" +
  "const pick=(s)=>document.querySelector('#boardGraph '+s);" +
  "const node=pick('.cv-node'),fold=pick('.cv-fold'),lane=pick('.cv-lane'),kind=pick('.cv-kind.cv-k-tool')||pick('.cv-kind');" +
  "const nodeBg=node?over(parse(getComputedStyle(node).backgroundColor),canvasBg):null;" +
  "const foldBg=fold?over(parse(getComputedStyle(fold).backgroundColor),canvasBg):null;" +
  "const head=node&&node.querySelector('.cv-head'),sum=node&&node.querySelector('.cv-sum'),foot=node&&node.querySelector('.cv-foot');" +
  "return {bodyCls:document.body.className,nodeBg:rgb(nodeBg),nodeLum:nodeBg?Math.round(lum(nodeBg)*1000)/1000:null," +
  "nodeBd:node?getComputedStyle(node).borderTopColor:null," +
  "headFg:head?getComputedStyle(head).color:null,headRatio:head&&nodeBg?ratio(parse(getComputedStyle(head).color),nodeBg):null," +
  "sumFg:sum?getComputedStyle(sum).color:null,sumRatio:sum&&nodeBg?ratio(parse(getComputedStyle(sum).color),nodeBg):null," +
  "footFg:foot?getComputedStyle(foot).color:null,footRatio:foot&&nodeBg?ratio(parse(getComputedStyle(foot).color),nodeBg):null," +
  "foldBg:rgb(foldBg),foldLum:foldBg?Math.round(lum(foldBg)*1000)/1000:null," +
  "laneBd:lane?getComputedStyle(lane).borderTopColor:null,laneBg:lane?getComputedStyle(lane).backgroundColor:null," +
  "kindBg:kind?getComputedStyle(kind).backgroundColor:null,kindFg:kind?getComputedStyle(kind).color:null};" +
  "})()";

(async () => {
  const { createGatewayApp } = require("../../src/app.ts");
  const { servePanel } = require("../../src/panel.ts");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");

  const srcDoc = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
  const copy = JSON.parse(JSON.stringify(srcDoc));
  copy.sessionId = SID;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));

  const jd = mkdtempSync(join(tmpdir(), "uitheme-"));
  const app = createGatewayApp({ useExternalHttp: true, journalDir: jd });
  servePanel(PORT, (srv) => app.attachWs(srv));
  const BASE = "http://127.0.0.1:" + PORT;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 20000) throw new Error("self-host panel not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(12000);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(700);
      if (await page.locator(HOST_SEL + " .cv-node").count()) break;
      await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
    }
    const sample = await page.evaluate(() => ({
      nodes: document.querySelectorAll("#boardGraph .cv-node").length,
      folds: document.querySelectorAll("#boardGraph .cv-fold").length,
      lanes: document.querySelectorAll("#boardGraph .cv-lane").length,
      kinds: document.querySelectorAll("#boardGraph .cv-kind").length,
    }));
    console.log("样本量:" + JSON.stringify(sample));

    const rows = [];
    for (const th of THEMES) {
      // 主题落点与面板 setTheme/applySettings 一致:light 基座=body.light(+theme-<key>),dark 基座只加 theme-<key>
 // (逐套 applySettings 经验证有异步回填,量测只认 CSS 契约 → 直接按契约切类,再等色彩稳定)
      await page.evaluate(([k, base]) => {
        const b = document.body;
        for (const c of [...b.classList]) if (c.startsWith("theme-")) b.classList.remove(c);
        b.classList.toggle("light", base === "light");
        if (k !== "dark" && k !== "light") b.classList.add("theme-" + k);
        b.classList.remove("theme-fade");
      }, [th.key, th.base]);
      // 等计算色稳定(连续两次读数一致;防 240ms 色彩过渡中途取样)
      let prev = null, m = null;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(180);
        m = await page.evaluate(MEASURE_SRC);
        const sig = m.nodeBg + "|" + m.foldBg + "|" + m.headFg + "|" + m.sumFg;
        if (sig === prev) break;
        prev = sig;
      }
      rows.push({ th, m });
      console.log("[" + th.key + "/" + th.base + "] body='" + m.bodyCls + "' 卡底=" + m.nodeBg + "(亮度" + m.nodeLum + ") 边=" + m.nodeBd +
        " | 标题 " + m.headFg + "@" + m.headRatio + ":1 摘要 " + m.sumFg + "@" + m.sumRatio + ":1 脚注 " + m.footFg + "@" + m.footRatio + ":1" +
        " | 计数块底=" + m.foldBg + "(亮度" + m.foldLum + ") 泳道框边=" + m.laneBd + " kind 图标底=" + m.kindBg);
    }

    for (const { th, m } of rows) {
      const light = th.base === "light";
      check("[" + th.key + "] 节点卡底跟随主题(" + (light ? "浅底亮度>0.5" : "深底亮度<0.25") + ")",
        m.nodeLum != null && (light ? m.nodeLum > 0.5 : m.nodeLum < 0.25), "卡底 rgb(" + m.nodeBg + ") 亮度=" + m.nodeLum);
      check("[" + th.key + "] 计数块 .cv-fold 底跟随主题", m.foldLum != null && (light ? m.foldLum > 0.5 : m.foldLum < 0.25), "计数块底 rgb(" + m.foldBg + ") 亮度=" + m.foldLum);
      check("[" + th.key + "] 卡头标题可读(对比度≥3:1)", m.headRatio != null && m.headRatio >= 3, m.headFg + " on rgb(" + m.nodeBg + ") = " + m.headRatio + ":1");
      check("[" + th.key + "] 卡身摘要可读(对比度≥2.5:1)", m.sumRatio != null && m.sumRatio >= 2.5, m.sumFg + " on rgb(" + m.nodeBg + ") = " + m.sumRatio + ":1");
      check("[" + th.key + "] 卡脚元信息可读(对比度≥2.5:1)", m.footRatio != null && m.footRatio >= 2.5, m.footFg + " on rgb(" + m.nodeBg + ") = " + m.footRatio + ":1");
    }
    const kindSet = new Set(rows.map(({ m }) => m.kindBg + "/" + m.kindFg));
    check("kind 图标色(.cv-kind.cv-k-*)跨 7 套主题恒等(功能色保留)", kindSet.size === 1, [...kindSet].join(" | "));
    const darkRow = rows.find(({ th }) => th.key === "dark").m;
    const lightRow = rows.find(({ th }) => th.key === "light").m;
    check("卡底颜色随主题真变(dark vs light 不同;不是写死)", darkRow.nodeBg !== lightRow.nodeBg, "dark rgb(" + darkRow.nodeBg + ") vs light rgb(" + lightRow.nodeBg + ")");
    const laneSet = new Set(rows.map(({ m }) => m.laneBd + " / " + m.laneBg));
    console.log("泳道框实测色集合: " + [...laneSet].join(" | ") +
      (laneSet.size === 1 ? " ← 单一:泳道色相/底由渲染侧 CV_LANE_HUES 内联(5 色循环=阶段功能色)给出,CSS 兜底已换成变量" : ""));

    // 面板真实主题切换链路(setTheme)抽验一档:light 落地后卡底应变浅(证明不是只有手切类才生效)
    await page.evaluate(() => { try { setTheme("light"); } catch (e) { /* 见下 */ } });
    let prevS = null, viaSet = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(180);
      viaSet = await page.evaluate(MEASURE_SRC);
      const sig = viaSet.nodeBg + "|" + viaSet.headFg;
      if (sig === prevS) break;
      prevS = sig;
    }
    check("setTheme('light') 真实链路:body.light 生效且卡底转浅", /\blight\b/.test(viaSet.bodyCls) && viaSet.nodeLum > 0.5, "body='" + viaSet.bodyCls + "' 卡底 rgb(" + viaSet.nodeBg + ") 亮度=" + viaSet.nodeLum);

    check("控制台零 pageerror", errs.length === 0, errs.slice(0, 2).join(" | "));
    await page.screenshot({ path: "/tmp/board-theme.png" });
    console.log("截图=/tmp/board-theme.png");
  } finally {
    await browser.close();
    try { await app.close(); } catch (e) { /* 已关 */ }
    rmSync(jd, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? "\nTHEME FAIL " + fails.length + "/" + results.length : "\nTHEME ALL PASS " + results.length + "/" + results.length);
  process.exit(0);
})().catch((e) => { console.error("SPEC CRASH", e); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (err) { /* 忽略 */ } process.exit(1); });
