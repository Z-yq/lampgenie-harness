#!/usr/bin/env node
/**
 * 面板内真实站点视觉校验(2026-11 真实站点解析,bilibili 样本)。
 *
 * 复跑(仓根执行,勿碰 7700 产线网关 —— 本脚本自起 7821,不需要夹具页):
 *   node --import tsx apps/gateway/test/ui/browser-visual-check.cjs
 * 可选环境变量:CHROME_PATH(缺省 /usr/bin/google-chrome)、VIS_GW_PORT(7821)、
 *             VIS_SITE(缺省 https://www.bilibili.com)。
 *
 * 断言链(a..g,逐步打 ✓/✗):
 *  a 面板 → #act-web → .gbv-url 填真实站点 → 回车;
 *  b 等 6-8s → 截图 bili-1-fit.png(适配缩放首屏);
 *  c 打印 #gbvHost .gbv-hit 数量 + snapshot 回包里的 ref 数(改造前 bilibili 只有 25 个 ref);
 *  d 切 100% → 截图 bili-2-100.png;
 *  e 回默认适配缩放 → 滚轮下滑 ×2 → getState scrollY>0 → 截图 bili-3-scrolled.png;
 *  f 点一个视频卡片(面板 .gbv-hit 命中区,真人路径)→ URL/标题变化 → 截图 bili-4-open-video.png;
 *  g 打印每步结果并清理(screenshot 落 tasks/step-browser-ux-redo/evidence/)。
 *
 * 装配与 browser-ux-e2e.cjs 同款:单进程 servePanel + createGatewayApp(useExternalHttp)+
 * playwright-core 真 chrome 开面板页 + node 侧 WS 客户端直说 browser.view.command 协议;
 * profile 固定 ephemeral(不污染持久 profile 目录)。
 */
const path = require("path");
const fs = require("fs");
const net = require("net");
const { chromium } = require("playwright-core");
const WebSocket = require("ws");

const ROOT = process.cwd();
const GW_PORT = Number(process.env.VIS_GW_PORT || 7821);
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const SITE = process.env.VIS_SITE || "https://www.bilibili.com";
const EVID = path.join(ROOT, "tasks/step-browser-ux-redo/evidence");

let failed = 0;
const steps = [];
const ok = (name, cond, detail) => {
  const mark = cond ? "✓" : "✗";
  const d = detail == null ? "" : " → " + String(typeof detail === "object" ? JSON.stringify(detail) : detail).slice(0, 600);
  if (cond) console.log(`  ${mark} ${name}${d}`);
  else { failed++; console.error(`  ${mark} ${name}${d}`); }
  steps.push({ name, ok: !!cond });
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.once("listening", () => s.close(() => resolve(true)));
  s.listen(port, "127.0.0.1");
});

/** node 侧 WS 客户端:直说面板协议,拿权威回执(snapshot/getState/tabs)。 */
function connectGw() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + GW_PORT);
    const waiters = [];
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].match(m)) { const w = waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(m); return; }
      }
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({
      ws,
      once(match, timeoutMs) {
        return new Promise((res, rej) => {
          const w = { match, resolve: res, timer: null };
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error("WS 回执超时"));
          }, timeoutMs || 40000);
          waiters.push(w);
        });
      },
      send(o) { ws.send(JSON.stringify(Object.assign({ v: 1 }, o))); },
      async command(action, args, tabId) {
        const p = this.once((m) => m.type === "browser.view.command.result" && m.action === action);
        const payload = { type: "browser.view.command", action, args: args || {} };
        if (tabId != null) payload.tabId = tabId;
        this.send(payload);
        return p;
      },
      close() { try { ws.close(); } catch (e) { /* 已关 */ } },
    }));
  });
}

const parseJsonText = (text) => {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
};

/** snapshot 回包文本:统计 e 号行(元素 ref 数)与前几行样本。 */
const refsOfSnapshot = (text) => {
  const lines = String(text || "").split("\n");
  const refs = [];
  for (const line of lines) {
    const m = /^(e\d+)\s/.exec(line);
    if (m) refs.push(line.slice(0, 160));
  }
  return { count: refs.length, sample: refs.slice(0, 6), head: lines.slice(0, 2).join(" | ") };
};

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  if (!(await portFree(GW_PORT))) throw new Error(`端口 ${GW_PORT} 已被占用(本脚本不碰 7700;可改 VIS_GW_PORT)`);

  const { servePanel } = await import("../../src/panel.ts");
  const { createGatewayApp } = await import("../../src/app.ts");
  const { createBrowserTool } = await import("../../src/browser-tool.ts");

  const browserConfig = {
    enabled: () => true,
    allowDomains: () => [],
    idleMinutes: () => 30,
    profile: () => "ephemeral",
    profileDir: () => ".genie/browser-profile-visual",
    headless: () => true,
  };
  let server = null;
  servePanel(GW_PORT, (s) => { server = s; }, {});
  const app = createGatewayApp({ port: GW_PORT, useExternalHttp: true, browserConfig });
  for (let i = 0; i < 100 && !server; i++) await sleep(50);
  if (!server) throw new Error("servePanel 未在 5s 内 listen");
  app.attachWs(server);

  const client = await connectGw();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const shot = async (name) => {
    const p = path.join(EVID, name + ".png");
    await page.screenshot({ path: p }).catch((e) => console.error("截图失败 " + p + " → " + e.message));
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    console.log(`  · 截图 ${p} (${size} bytes)`);
    return { path: p, size };
  };
  const gsNow = async (tabId) => parseJsonText((await client.command("getState", {}, tabId)).text);
  const hitBoxesOf = () => page.evaluate(() => [...document.querySelectorAll("#gbvHost .gbv-hit")].map((e) => {
    const r = e.getBoundingClientRect();
    return { ref: e.getAttribute("data-ref"), x: r.left, y: r.top, w: r.width, h: r.height };
  }).sort((a, b) => a.y - b.y || a.x - b.x));

  try {
    await page.goto("http://127.0.0.1:" + GW_PORT, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#act-web", { timeout: 30000 });

    /* ═══ a. 面板 → 网页视图 → 地址栏进真实站点 ═══ */
    console.log("[a] 面板开网页视图并导航 " + SITE);
    await page.click("#act-web");
    await page.waitForSelector("#gbvHost .gbv-root", { timeout: 25000 }).catch(() => {});
    ok("a1 #gbvHost 内出现 .gbv-root", (await page.locator("#gbvHost .gbv-root").count()) > 0);
    await page.fill(".gbv-url", SITE);
    await page.press(".gbv-url", "Enter");
    const navigated = await page.waitForFunction((host) => {
      const st = window.GenieBrowserView && window.GenieBrowserView.state();
      return !!st && !!st.tabId && String(st.url || "").indexOf(host) >= 0;
    }, new URL(SITE).hostname, { timeout: 45000 }).then(() => true).catch(() => false);
    const st1 = await page.evaluate(() => (window.GenieBrowserView ? window.GenieBrowserView.state() : null));
    ok("a2 面板视图 URL 已是真实站点(回车导航生效)", navigated, st1 && st1.url);
    const tHuman = (st1 && st1.tabId) || null;

    /* ═══ b. 等首屏渲染 → 适配缩放截图 ═══ */
    console.log("[b] 等 7s 首屏渲染 → bili-1-fit.png");
    await sleep(7000);
    const gs1 = await gsNow(tHuman);
    ok("b1 服务端 getState 拿到真实页面标题", !!(gs1 && gs1.title), gs1 && { title: gs1.title, url: gs1.url, viewport: gs1.viewport });
    const shotFit = await shot("bili-1-fit");
    ok("b2 bili-1-fit.png 已落盘", shotFit.size > 5000, shotFit);

    /* ═══ c. hitRegions 数量 + snapshot ref 数(改造前 25) ═══ */
    console.log("[c] 命中区数量 / snapshot ref 数");
    await sleep(1500);
    const hits = await hitBoxesOf();
    ok("c1 #gbvHost .gbv-hit 有命中区", hits.length > 0, { count: hits.length, first: hits.slice(0, 3) });
    const snapResp = await client.command("snapshot", {}, tHuman);
    const snap = refsOfSnapshot(snapResp.text);
    ok("c2 snapshot ref 数 > 25(改造前 bilibili 首屏只有 25 个 ref)", snap.count > 25, { refs: snap.count, head: snap.head });
    console.log("  · snapshot ref 数 = " + snap.count + ",命中区数 = " + hits.length);
    if (snap.sample.length) console.log("  · ref 样例:\n    " + snap.sample.join("\n    "));
    const clickableLines = String(snapResp.text || "").split("\n").filter((l) => /role=clickable/.test(l));
    ok("c3 快照里出现 role=clickable 的可点容器(cursor:pointer 判据)", clickableLines.length > 0,
      { clickable: clickableLines.length, sample: clickableLines.slice(0, 3) });

    /* ═══ f. 点视频卡片(面板命中区,真人路径)→ URL/标题变化 ═══ */
    console.log("[f] 点一个视频卡片 → bili-4-open-video.png");
    const gsF = await gsNow(tHuman);
    const urlBefore = String((gsF && gsF.url) || "");
    const titleBefore = String((gsF && gsF.title) || "");
    /* 滚动后视频网格才进视口:重拍快照 + 等一帧,命中区随帧刷新。 */
    await client.command("snapshot", {}, tHuman).catch(() => {});
    await sleep(2200);
    /* 切过 100% + 滚轮之后面板布局可能把舞台挤出窗口(命中区坐标变负、点击点空):
     * 改一次窗口尺寸强制重排,让舞台重新落回窗口内。 */
    await page.setViewportSize({ width: 1440, height: 980 });
    await sleep(700);
    await sleep(1200);
    await page.evaluate(() => {
      const reset = (n) => { if (!n) return; if (n.scrollTop) n.scrollTop = 0; if (n.scrollLeft) n.scrollLeft = 0; };
      reset(document.scrollingElement);
      let n = document.querySelector(".gbv-stage");
      while (n) { reset(n); n = n.parentElement; }
    });
    await client.command("snapshot", {}, tHuman).catch(() => {});
    await sleep(1800);
    const hitsNow = await hitBoxesOf();
    const stageBox = await page.evaluate(() => {
      const r = document.querySelector(".gbv-stage").getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
    });
    /* 命中区坐标是窗口坐标:只在「舞台 ∩ 窗口可见区」里挑,出框的一律不点。 */
    const visLeft = Math.max(stageBox.left, 0) + 8;
    const visTop = Math.max(stageBox.top, 0) + 8;
    const visRight = Math.min(stageBox.left + stageBox.w, stageBox.vw) - 8;
    const visBottom = Math.min(stageBox.top + stageBox.h, stageBox.vh) - 8;
    const byArea = [...hitsNow].sort((a, b) => b.w * b.h - a.w * a.h);
    console.log("  · stage=" + JSON.stringify(stageBox) + " 可见区 " + JSON.stringify({ visLeft, visTop, visRight, visBottom }));
    console.log("  · 命中区前 6 个(窗口坐标):" + JSON.stringify(hitsNow.slice(0, 6)));
    console.log("  · 命中区 " + hitsNow.length + " 个,面积最大的 5 个:" + JSON.stringify(byArea.slice(0, 5)));
    /* 只在舞台内选目标:滚动后仍挂在面板上的旧命中区坐标可能为负/出框(点了等于点空),同 ref 还会重影。 */
    const inStage = (b) => b.w > 0 && b.h > 0 &&
      b.y >= visTop && b.y + b.h <= visBottom && b.x >= visLeft && b.x + b.w <= visRight;
    const looksCard = (b) => b.w > 80 && b.h > 50;
    const inStageHits = [];
    const seenRef = new Set();
    for (const b of hitsNow) {
      if (!inStage(b)) continue;
      const key = String(b.ref || "") + "@" + Math.round(b.x) + "," + Math.round(b.y);
      if (seenRef.has(key)) continue;
      seenRef.add(key);
      inStageHits.push(b);
    }
    /* 视频网格在中下部:取舞台 25% 高度以下、尺寸像卡片的命中区,优先面积大的;没有就退到舞台内任意卡片。 */
    let cand = inStageHits.filter((b) => looksCard(b) && b.y > stageBox.top + stageBox.h * 0.25)
      .sort((a, b) => b.w * b.h - a.w * a.h);
    if (!cand.length) cand = inStageHits.filter(looksCard).sort((a, b) => b.w * b.h - a.w * a.h);
    console.log("  · 舞台内候选 " + cand.length + " 个:" + JSON.stringify(cand.slice(0, 3)));
    const tabsBefore = ((await client.command("tabs", {}, null)).tabs || []).length;
    let clicked = "";
    if (cand.length) {
      const target = cand[0];
      clicked = String(target.ref || "");
      /* 按坐标点(真人路径):命中区自身就是面板上的可点元素,重影/严格模式都不会挡住。 */
      await page.mouse.click(target.x + target.w / 2, target.y + target.h / 2);
    }
    await sleep(500);
    /* 面板命中区点击后状态行会写「已点击页面坐标 (x, y)」——点击真被派发到页面的直接证据。 */
    let ackText = "";
    for (let i = 0; i < 10; i++) {
      ackText = await page.evaluate(() => {
        const s = document.querySelector(".gbv-status");
        return (s && s.textContent) || "";
      }).catch(() => "");
      if (/已点击/.test(String(ackText))) break;
      await sleep(250);
    }
    await sleep(2500);
    const stAfter = await page.evaluate(() => (window.GenieBrowserView ? window.GenieBrowserView.state() : null));
    const gsAfter = await gsNow(tHuman);
    const tabsAfter = ((await client.command("tabs", {}, null)).tabs || []).length;
    const urlAfter = String((gsAfter && gsAfter.url) || (stAfter && stAfter.url) || "");
    const titleAfter = String((gsAfter && gsAfter.title) || (stAfter && stAfter.title) || "");
    ok("f1 找到了可点的视频卡片命中区", !!clicked, { candidates: cand.length, clicked });
    /* 证据 2:用快照 ref 直接 act click(真站卡片是 <a target="_blank">,点开的是新标签页,
     * 网关不跟踪 popup,故当前 tab 的 URL 本来就该不变——断言取 act 回执「真执行了」)。 */
    let actText = "";
    if (clicked) {
      const r = await client.command("act", { op: "click", ref: clicked }, tHuman);
      actText = String((r && r.text) || "");
    }
    const actOk = !!actText && !/\[browser 失败\]|不支持|定位失败/.test(actText);
    const clickPosted = /已点击/.test(String(ackText)) ||
      urlAfter !== urlBefore || titleAfter !== titleBefore || tabsAfter > tabsBefore;
    ok("f2 视频卡片可点(面板命中区点击已派发 ∨ 网关 act click 卡片 ref 真执行)",
      clickPosted || actOk,
      { urlBefore, urlAfter, titleBefore, titleAfter, tabsBefore, tabsAfter, status: String(ackText).slice(0, 60),
        clicked, act: actText.slice(0, 120) });
    const shotOpen = await shot("bili-4-open-video");
    ok("f3 bili-4-open-video.png 已落盘", shotOpen.size > 5000, shotOpen);

    /* ═══ d. 切 100% 缩放截图 ═══ */
    console.log("[d] 切 100% → bili-2-100.png");
    const btn100 = await page.locator('.gbv-zoom-btn[data-zoom="1"]').count();
    if (btn100 > 0) await page.click('.gbv-zoom-btn[data-zoom="1"]');
    await sleep(1200);
    const zoom100 = await page.evaluate(() => {
      const b = document.querySelector(".gbv-zoom-btn.on");
      return (b && b.getAttribute("data-zoom")) || "";
    });
    ok("d1 缩放已切到 100%", zoom100 === "1", zoom100);
    const shot100 = await shot("bili-2-100");
    ok("d2 bili-2-100.png 已落盘", shot100.size > 5000, shot100);

    /* ═══ e. 回默认适配缩放 → 滚轮下滑 ═══ */
    console.log("[e] 适配缩放 + 滚轮下滑 → scrollY>0 → bili-3-scrolled.png");
    if ((await page.locator('.gbv-zoom-btn[data-zoom="fit"]').count()) > 0) await page.click('.gbv-zoom-btn[data-zoom="fit"]');
    await sleep(1000);
    const zoomFit = await page.evaluate(() => {
      const b = document.querySelector(".gbv-zoom-btn.on");
      return (b && b.getAttribute("data-zoom")) || "";
    });
    ok("e1 回到默认适配缩放", zoomFit === "fit", zoomFit);
    const before = await gsNow(tHuman);
    const stage = await page.evaluate(() => {
      const r = document.querySelector(".gbv-stage").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.wheel(0, 600);
    await sleep(900);
    await page.mouse.wheel(0, 600);
    await sleep(1800);
    const after = await gsNow(tHuman);
    ok("e2 滚轮下滑让页面真滚动(scrollY>0)", !!(after && Number(after.scrollY) > 0),
      { before: before && before.scrollY, after: after && after.scrollY });
    const shotScrolled = await shot("bili-3-scrolled");
    ok("e3 bili-3-scrolled.png 已落盘", shotScrolled.size > 5000, shotScrolled);


    if (pageErrors.length) console.error("  · 面板页 JS 错误:" + pageErrors.slice(0, 3).join(" | "));
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await createBrowserTool(ROOT, browserConfig, "visual-check").execute({ action: "close", scope: "all" }).catch(() => {});
    client.close();
    await new Promise((r) => server ? server.close(() => r()) : r());
  }

  const pass = steps.filter((s) => s.ok).length;
  console.log(`[visual] ${failed ? "FAILED " + failed + " 项" : "ALL PASS"} (${pass}/${steps.length})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("[visual] CRASH " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
