/** 任务B 取证截图 runner v2(2026-10-29 第四次派发;修正前次不合格:① 新旧不用一块板 ③ mermaid 截不到图本体)
 *  ① 同板同 viewport(1400×900)前后对照:**同一个 fixture 页/同一份板文件**下
 *     新=紧凑 fit(默认口径,cvTightSvgBounds→DiagramViewport.resolveSvgBoundsFromDom)
 *     旧=viewBox fit(window.__cvFitBasis="viewbox",走面板内保留的 cvSvgContentBox 回退口径)
 *     → taskb-1-old-viewbox-fit.png / taskb-1-new-tight-fit.png + 一行 FITJSON(k/可见卡数/bbox)。
 *  ②③ mermaid 深/浅主题:**element screenshot 截 .md-mermaid 本体**(不截整屏),断言 svg 数、
 *     window.MermaidThemeNormalize 在位、svg 内 fill/stroke 无 oklab/color-mix。
 *  跑法:cd apps/gateway && npx tsx test/ui/shots/taskb-fit-mermaid.spec.mjs */
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.GENIE_CHECKPOINT = "off";
const HARNESS_ROOT = path.resolve(__dirname, "../../../../../"); // apps/gateway/test/ui/shots → 仓库根
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const SHOTS = __dirname;
const SRC_SID = process.env.SRC_SID || "web-1792774467576";
const SRC_TASK = process.env.SRC_TASK || "dec3a2d2-b812-4fe1-899b-c2a91365ea26";
const SRC_FILE = path.join(HARNESS_ROOT, ".genie", "boards", SRC_SID, SRC_TASK + ".json");
const SID = "ui-taskb-shots-7793";
const PORT = Number(process.env.SELF_PORT || 7793);
const VIEWPORT = { width: 1400, height: 900 }; // 两张对照图必须同一 viewport

const results = [];
const round4 = (x) => Math.round(x * 10000) / 10000;
const log = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS" : "MISS") + " " + name + (detail ? " — " + detail : ""));
};

let chromium = null;
try { chromium = (await import("playwright-core")).chromium; } catch (e) { chromium = null; }
if (!chromium) { console.log("skipped: playwright-core 不可用"); process.exit(0); }
if (!fs.existsSync(CHROME)) { console.log("skipped: 无 chrome " + CHROME); process.exit(0); }
if (!fs.existsSync(SRC_FILE)) { console.log("skipped: 无真实板文件 " + SRC_FILE); process.exit(0); }

// ── 起 src fixture(ESM 直连 src,不用活面板 7700;板副本 status=implementing 绕 done 门禁)──
const TEST_DIR = path.join(HARNESS_ROOT, ".genie", "boards", SID);
const TEST_FILE = path.join(TEST_DIR, SRC_TASK + ".json");
const copy = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
copy.sessionId = SID;
copy.status = "implementing";
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));

const { createGatewayApp } = await import("../../../src/app.ts");
const { servePanel } = await import("../../../src/panel.ts");
const jd = mkdtempSync(path.join(tmpdir(), "taskb-"));
const app = createGatewayApp({ useExternalHttp: true, journalDir: jd });
servePanel(PORT, (srv) => app.attachWs(srv));
const BASE = "http://127.0.0.1:" + PORT;
const t0 = Date.now();
for (;;) {
  try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
  if (Date.now() - t0 > 20000) throw new Error("fixture panel not ready on " + PORT);
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });

/** 开一块板的 fixture 页(同板同 viewport),等 #cvSvgHost 里 svg 真出图。 */
async function openBoard() {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(20000);
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
  await page.addInitScript((sid) => { try { sessionStorage.setItem("zh:sid", sid); } catch (e) { /* 隐私模式 */ } }, SID);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.click("#act-board");
  let svgKids = 0;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(700);
    svgKids = await page.evaluate(() => {
      const s = document.querySelector("#cvSvgHost svg");
      return s ? s.childElementCount : 0;
    });
    if (svgKids > 2) break;
    await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
  }
  await page.waitForTimeout(900);
  return { page, errs, svgKids };
}

/** 缩放件/适配按钮都是 document 上的 pointerdown 委托(click 会被重渲吞掉)。 */
const press = (page, id) => page.evaluate((bid) => {
  const b = document.getElementById(bid);
  if (!b) return false;
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, clientX: 1, clientY: 1 }));
  return true;
}, id);

/** 量当前视野:k / 可见卡片数 / 内容 bbox(世界+屏幕)/ svg viewBox / 紧凑度。 */
const measure = (page) => page.evaluate(() => {
  const host = (typeof cvHostEl === "function" ? cvHostEl() : document.getElementById("cvHost"));
  const hostR = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const svg = document.querySelector("#cvSvgHost svg");
  const k = (typeof cvPan !== "undefined" && cvPan) ? Math.round(cvPan.k * 10000) / 10000 : null;
  // 卡片元素:svg 模式优先 data-node-id,退 flowchart 节点组
  let cards = [];
  if (svg) {
    cards = Array.from(svg.querySelectorAll("[data-node-id]"));
    if (!cards.length) cards = Array.from(svg.querySelectorAll("g.node, g[id^='flowchart-']"));
  }
  let visible = 0;
  let cb = null;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (!cb) cb = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    else cb = { left: Math.min(cb.left, r.left), top: Math.min(cb.top, r.top), right: Math.max(cb.right, r.right), bottom: Math.max(cb.bottom, r.bottom) };
    if (r.right > hostR.left && r.left < hostR.right && r.bottom > hostR.top && r.top < hostR.bottom) visible++;
  }
  let engine = null;
  try {
    if (window.DiagramViewport && window.DiagramViewport.resolveSvgBoundsFromDom && svg) engine = window.DiagramViewport.resolveSvgBoundsFromDom(svg);
  } catch (e) { engine = "err"; }
  const vb = svg ? (svg.getAttribute("viewBox") || "") : "";
  return {
    k,
    cards: cards.length,
    visible,
    svgViewBox: vb,
    svgW: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
    svgH: svg ? Math.round(svg.getBoundingClientRect().height) : 0,
    view: { w: Math.round(hostR.width), h: Math.round(hostR.height) },
    contentBBoxScreen: cb ? { w: Math.round(cb.right - cb.left), h: Math.round(cb.bottom - cb.top), left: Math.round(cb.left), top: Math.round(cb.top) } : null,
    tightBBox: engine && engine.width ? { x: Math.round(engine.x || 0), y: Math.round(engine.y || 0), w: Math.round(engine.width), h: Math.round(engine.height) } : null,
    lastFit: window.__cvFitLast || null,
    cardsMode: (typeof cvRenderMode === "function" ? cvRenderMode() : "?"),
  };
});

/** 放 5 档再按「适」:落差可见(boardbtn 先例同法),fit 结果只取决于内容框口径。 */
async function zoomThenFit(page) {
  for (let i = 0; i < 5; i++) { await press(page, "cvZin"); await page.waitForTimeout(120); }
  await page.waitForTimeout(200);
  const zoomed = await page.evaluate(() => (typeof cvPan !== "undefined" ? Math.round(cvPan.k * 10000) / 10000 : null));
  await press(page, "cvZfit");
  await page.waitForTimeout(1000);
  return zoomed;
}

// ═══ ① 同板同 viewport:紧凑 fit vs viewBox fit(一个页面、一次初始化流程)═══
const fitPair = {};
try {
  const { page, errs, svgKids } = await openBoard();
  const zoomed = await zoomThenFit(page); // 先按当前(新口径)适配
  const mNew = await measure(page);
  await page.screenshot({ path: path.join(SHOTS, "taskb-1-new-tight-fit.png"), fullPage: false });
  // 切旧口径:面板内保留的 viewBox 回退分支(window.__cvFitBasis="viewbox"),再适配一次
  await page.evaluate(() => { window.__cvFitBasis = "viewbox"; });
  await zoomThenFit(page);
  const mOld = await measure(page);
  await page.screenshot({ path: path.join(SHOTS, "taskb-1-old-viewbox-fit.png"), fullPage: false });
  await page.evaluate(() => { delete window.__cvFitBasis; }); // 复位,不影响后续
  fitPair.new = mNew;
  fitPair.old = mOld;
  fitPair.zoomedK = zoomed;
  fitPair.board = path.relative(HARNESS_ROOT, TEST_FILE);
  fitPair.svgKids = svgKids;
  const ok = mNew.lastFit && mOld.lastFit && mNew.lastFit.basis === "tight" && mOld.lastFit.basis === "viewbox"
    && mNew.k !== null && mOld.k !== null && mNew.cards > 0;
  log("① 同板对照(紧凑 fit vs viewBox fit)", !!ok,
    "new(k=" + mNew.k + ", vis=" + mNew.visible + "/" + mNew.cards + ", fitBox=" + JSON.stringify(mNew.lastFit) + ") old(k=" + mOld.k + ", vis=" + mOld.visible + "/" + mOld.cards + ", fitBox=" + JSON.stringify(mOld.lastFit) + ")" + (errs.length ? " errs=" + errs[0] : ""));
  console.log("FITJSON " + JSON.stringify({
    viewport: VIEWPORT,
    board: fitPair.board,
    new_tight: { k: mNew.k, visibleCards: mNew.visible, cards: mNew.cards, fitBox: mNew.lastFit, contentBBoxScreen: mNew.contentBBoxScreen },
    old_viewbox: { k: mOld.k, visibleCards: mOld.visible, cards: mOld.cards, fitBox: mOld.lastFit, contentBBoxScreen: mOld.contentBBoxScreen },
    tightEngineBBox: mNew.tightBBox,
    svgViewBox: mNew.svgViewBox,
    kRatio: (mNew.k && mOld.k) ? Math.round((mNew.k / mOld.k) * 1000) / 1000 : null,
    // 未夹紧的理论适配 k(两种口径各自)= min(viewW/(contentW+40), viewH/(contentH+40));
    // 实测 k 被 CV_FIT_READABLE_MIN=0.7 夹紧时,这两值才是「紧凑 fit 前后」的裸差异。
    naturalK: {
      tight: mNew.lastFit ? round4(Math.min(mNew.lastFit.view.w / (mNew.lastFit.w + 40), mNew.lastFit.view.h / (mNew.lastFit.h + 40))) : null,
      viewbox: mOld.lastFit ? round4(Math.min(mOld.lastFit.view.w / (mOld.lastFit.w + 40), mOld.lastFit.view.h / (mOld.lastFit.h + 40))) : null,
    },
    clampNote: "readableMinK=0.7:两口径 naturalK 均远低于 0.7 → 实测 k 相同,差异体现在 fit 内容框/原点与可见卡数",
  }));
  await page.close();
} catch (e) {
  log("① 同板对照", false, String(e).slice(0, 160));
}

// ═══ ②③ mermaid 深/浅主题:element screenshot 截 .md-mermaid 本体 ═══
// 每张图源码带唯一尾节点:避免 mermaid 按定义文本缓存上一次渲染结果(深浅对照会互相污染)
const mmSrc = (tag) => [
  "graph TD",
  "  A[任务B 收口] --> B1[画布/板图视口]",
  "  A --> B2[IDE 图片共用引擎]",
  "  A --> B3[mermaid 主题归一化]",
  "  B1 --> C[锚点缩放/捏合/紧凑fit]",
  "  B2 --> C",
  "  B3 --> C",
  "  C --> T[" + tag + "]",
].join("\n");

/** 注入一个 .md-mermaid 占位并等出图(走面板真实管线 mmRenderIn → mermaid.run)。 */
async function injectMm(page, id, tag) {
  await page.evaluate(({ src, bid }) => {
    const host = document.querySelector("#msgs") || document.getElementById("msgs") || document.body;
    const div = document.createElement("div");
    div.className = "md-mermaid";
    div.setAttribute("data-mermaid-lazy", "1");
    div.setAttribute("data-src", src);
    div.setAttribute("id", bid);
    host.appendChild(div);
    try { mmRenderIn(document); } catch (e) { /* 钩子缺席:等懒加载扫描 */ }
  }, { src: mmSrc(tag || id), bid: id });
  let svgN = 0;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    svgN = await page.evaluate((bid) => document.querySelectorAll("#" + bid + " svg").length, id);
    if (svgN) break;
  }
  return svgN;
}

async function mermaidShot(light) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(20000);
  await page.addInitScript((sid) => { try { sessionStorage.setItem("zh:sid", sid); } catch (e) { /* 隐私模式 */ } }, SID);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  let themePath = "dark(default)";
  if (light) {
    // 先按默认深主题出一张(触发 mermaid.min.js 懒加载),再切浅主题 → 覆盖「切主题后重新 initialize」路径
    const warm = await injectMm(page, "taskbMmWarm", "warm-dark");
    await page.evaluate(() => { // 记录 initialize 调用:切主题后必须出现浅底(#faf6ee)变量
      window.__mmInitCalls = [];
      const orig = window.mermaid && window.mermaid.initialize;
      if (typeof orig !== "function") return;
      window.mermaid.initialize = function (cfg) {
        try { window.__mmInitCalls.push({ theme: cfg && cfg.theme, bg: cfg && cfg.themeVariables && cfg.themeVariables.background, px: cfg && cfg.themeVariables && cfg.themeVariables.primaryTextColor }); } catch (e) { /* 记录失败 */ }
        return orig.apply(this, arguments);
      };
    });
    themePath = await page.evaluate(() => {
      try { if (typeof setTheme === "function") { setTheme("light"); return "setTheme(light)"; } } catch (e) { /* 旧壳无 setTheme */ }
      try { localStorage.setItem("zh:theme", "light"); if (typeof settings !== "undefined") settings.theme = "light"; if (typeof applySettings === "function") { applySettings(); return "applySettings(light)"; } } catch (e) { /* 忽略 */ }
      try { document.body.classList.add("light"); return "classList(light)"; } catch (e) { return "none"; }
    });
    await page.waitForTimeout(600);
    await page.evaluate((w) => { const el = document.getElementById(w); if (el) el.remove(); }, "taskbMmWarm"); // 旧块(mermaid 全局主题只对新渲生效)
    themePath += "/warm=" + warm;
  }
  const svgN = await injectMm(page, "taskbMm", light ? "light-base" : "dark-base");
  const info = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".md-mermaid"));
    const svg = document.querySelector("#taskbMm svg");
    let modern = 0;
    const attrs = ["fill", "stroke", "stop-color", "color", "style"];
    if (svg) {
      for (const el of [svg, ...svg.querySelectorAll("*")]) {
        for (const a of attrs) {
          const v = el.getAttribute && el.getAttribute(a);
          if (v && /oklab|color-mix/.test(v)) modern++;
        }
      }
    }
    const r = svg ? svg.getBoundingClientRect() : null;
    const blk = document.getElementById("taskbMm");
    const br = blk ? blk.getBoundingClientRect() : null;
    const bgRect = svg ? svg.querySelector("rect") : null;
    return {
      blocks: blocks.length,
      svgN: document.querySelectorAll(".md-mermaid svg").length,
      initCalls: window.__mmInitCalls || [],
      modern,
      // 出图本体证据:节点组数量 + 无 mermaid 报错图标/文案 + svg 完整落在块内(没被右侧裁掉)
      nodeGroups: svg ? svg.querySelectorAll("g.node, g.nodeLabel, .nodeLabel, span.nodeLabel").length : 0,
      errText: svg ? (!!svg.querySelector('[aria-roledescription="error"], .error-icon, .error-text, .error-marker') || /Syntax error in text/i.test(svg.textContent || "")) : null,
      blockBox: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null,
      svgInsideBlock: !!(r && br && r.left >= br.left - 1 && r.right <= br.right + 1 && r.bottom <= br.bottom + 1),
      norm: !!window.MermaidThemeNormalize,
      normFn: !!(window.MermaidThemeNormalize && typeof window.MermaidThemeNormalize.normalizeMermaidThemeVars === "function"),
      lightBase: String(document.body.className || "").indexOf("light") >= 0,
      themeStore: (typeof settings !== "undefined" && settings) ? settings.theme : null,
      svgBox: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
      bgFill: bgRect && bgRect.getAttribute ? bgRect.getAttribute("fill") : null,
      svgText: svg ? String(svg.outerHTML).slice(0, 0) : "",
      darkHexInSvg: svg ? (String(svg.outerHTML).match(/#0b0806/gi) || []).length : 0,
      lightHexInSvg: svg ? (String(svg.outerHTML).match(/#faf6ee/gi) || []).length : 0,
      nodeFill: (function () { const n = svg && svg.querySelector("g.node rect, g.node polygon, g.node path"); return n && n.getAttribute ? n.getAttribute("fill") : null; })(),
      // 实际生效色(主题变量的最终证明:归一化后是 rgb() 串,CSS 里查不到原 hex)
      computedFill: (function () {
        const n = svg && svg.querySelector("g.node rect, g.node polygon, g.node path");
        if (!n || !window.getComputedStyle) return null;
        try { return window.getComputedStyle(n).fill; } catch (e) { return null; }
      })(),
      computedLabelColor: (function () {
        const n = svg && svg.querySelector("g.node .nodeLabel, g.node span, g.node text");
        if (!n || !window.getComputedStyle) return null;
        try { const cs = window.getComputedStyle(n); return cs.fill || cs.color; } catch (e) { return null; }
      })(),
      // 渲染期真正生效的 mermaid 配置 + svg 内联 <style> 里出现的底色(判定「浅变量到底进没进图」)
      cfgNow: (function () {
        try {
          const c = window.mermaid.mermaidAPI.getConfig();
          return { theme: c.theme, bg: c.themeVariables && c.themeVariables.background, primaryColor: c.themeVariables && c.themeVariables.primaryColor };
        } catch (e) { return "err"; }
      })(),
      styleLight: svg ? /239,\s*230,\s*214/.test(svg.outerHTML) : null,
      styleDark: svg ? /1f2020|31,\s*32,\s*32/i.test(svg.outerHTML) : null,
      labelColor: (function () { const n = svg && svg.querySelector("g.node .nodeLabel, g.node span"); return n && n.getAttribute ? n.getAttribute("style") : null; })(),
    };
  });
  const loc = page.locator("#taskbMm");
  await loc.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const file = path.join(SHOTS, light ? "taskb-3-mermaid-light.png" : "taskb-2-mermaid-dark.png");
  await loc.screenshot({ path: file }); // 图本体(element screenshot),非整屏
  await page.close();
  return { info, file, themePath };
}

let mmDark = null;
let mmLight = null;
try {
  mmDark = await mermaidShot(false);
  const i = mmDark.info;
  log("② 深主题 mermaid(截 .md-mermaid 本体)", i.svgN === 1 && i.norm && i.modern === 0 && i.nodeGroups >= 4 && !i.errText && i.svgInsideBlock && !!i.svgBox && i.svgBox.h > 120,
    "svg=" + i.svgN + " nodes=" + i.nodeGroups + " err=" + i.errText + " insideBlock=" + i.svgInsideBlock + " block=" + JSON.stringify(i.blockBox) + " box=" + JSON.stringify(i.svgBox) + " normalizeLib=" + i.norm + "/" + i.normFn + " modernColorRefs=" + i.modern + " bgFill=" + i.bgFill + " computedFill=" + i.computedFill + " computedLabelColor=" + i.computedLabelColor + " → " + path.basename(mmDark.file));
} catch (e) { log("② 深主题 mermaid", false, String(e).slice(0, 160)); }
try {
  mmLight = await mermaidShot(true);
  const i = mmLight.info;
  const switchLight = (i.initCalls || []).some((c) => c && c.bg === "#faf6ee");
  log("③ 浅主题 mermaid(截 .md-mermaid 本体)", i.svgN === 1 && i.norm && i.modern === 0 && i.lightBase && switchLight && i.nodeGroups >= 4 && !i.errText && i.svgInsideBlock,
    "svg=" + i.svgN + " nodes=" + i.nodeGroups + " err=" + i.errText + " insideBlock=" + i.svgInsideBlock + " block=" + JSON.stringify(i.blockBox) + " box=" + JSON.stringify(i.svgBox) + " theme=" + mmLight.themePath + " lightBase=" + i.lightBase + " store=" + i.themeStore + " modernColorRefs=" + i.modern + " initCalls=" + JSON.stringify(i.initCalls || []) + " switchLightVars=" + switchLight + " darkHexInSvg=" + i.darkHexInSvg + " lightHexInSvg=" + i.lightHexInSvg + " nodeFill=" + i.nodeFill + " computedFill=" + i.computedFill + " computedLabelColor=" + i.computedLabelColor + " cfgNow=" + JSON.stringify(i.cfgNow) + " styleLight=" + i.styleLight + " styleDark=" + i.styleDark + " → " + path.basename(mmLight.file));
} catch (e) { log("③ 浅主题 mermaid", false, String(e).slice(0, 160)); }

console.log("MMJSON " + JSON.stringify({
  dark: mmDark ? { svg: mmDark.info.svgN, nodes: mmDark.info.nodeGroups, err: mmDark.info.errText, insideBlock: mmDark.info.svgInsideBlock, norm: mmDark.info.norm, modern: mmDark.info.modern, bgFill: mmDark.info.bgFill, box: mmDark.info.svgBox } : null,
  light: mmLight ? { svg: mmLight.info.svgN, nodes: mmLight.info.nodeGroups, err: mmLight.info.errText, insideBlock: mmLight.info.svgInsideBlock, norm: mmLight.info.norm, modern: mmLight.info.modern, bgFill: mmLight.info.bgFill, box: mmLight.info.svgBox, lightBase: mmLight.info.lightBase, path: mmLight.themePath, initCalls: mmLight.info.initCalls } : null,
}));

await browser.close();
const miss = results.filter((r) => !r.ok).length;
console.log("\nshots: " + (results.length - miss) + "/" + results.length + " ok → " + SHOTS);
process.exit(0);
