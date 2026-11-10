#!/usr/bin/env node
/**
 * 浏览器面板真实 E2E —— 2026-11 browser-ux-redo 改造验收(人机同看 / 人类输入通道 / tab 归属)。
 *
 * 复跑(必须在仓根跑,勿碰 7700 产线网关 —— 本脚本自起 7811):
 *   node --import tsx apps/gateway/test/ui/browser-ux-e2e.cjs
 * 可选环境变量:CHROME_PATH(缺省 /usr/bin/google-chrome)、E2E_GW_PORT(7811)、
 *             E2E_FIX_PORT(7813)、E2E_IDLE_WAIT_MS(62000,步骤 h 的 idle 观察窗)。
 *
 * 形态(_j4_sidebar_browser.cjs 同款):单进程内 servePanel + createGatewayApp 真网关
 * (useExternalHttp,面板与 WS 同端口)+ 一个夹具 http server + playwright-core 真 chrome 开面板页;
 * 另起一条 node 侧 WS 客户端直说 browser.view.command 协议拿权威回执(getState/snapshot/tabs)。
 * profile 固定 ephemeral —— 避免持久 profile 目录上锁污染(改造点 browser.enabled 缺省 true 不影响这里)。
 *
 * 说明(与任务书的偏差,如实记录):
 *  · idleMinutesOf() 会把浏览器配置函数返回值 Math.round 后 clamp 到 [1,240] 分钟
 *    (browser-tool.ts:420-423),所以 () => 0.001 实际等于 1 分钟;步骤 h 只能真等 ~62s。
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { chromium } = require("playwright-core");
const WebSocket = require("ws");

const ROOT = process.cwd();
const GW_PORT = Number(process.env.E2E_GW_PORT || 7811);
const FIX_PORT = Number(process.env.E2E_FIX_PORT || 7813);
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const IDLE_WAIT_MS = Number(process.env.E2E_IDLE_WAIT_MS || 62000);
const EVID = path.join(ROOT, "tasks/step-browser-ux-redo/evidence");
const FIX = "http://127.0.0.1:" + FIX_PORT;
const BASE = "http://127.0.0.1:" + GW_PORT;

let failed = 0;
let closeSharedBrowser = null;
const ok = (name, cond, detail) => {
  const mark = cond ? "✓" : "✗";
  const d = detail == null ? "" : " → " + String(typeof detail === "object" ? JSON.stringify(detail) : detail).slice(0, 900);
  if (cond) console.log(`  ${mark} ${name}`);
  else { failed++; console.error(`  ${mark} ${name}${d}`); }
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── 夹具页:输入框 + 按钮 + 结果区 + 40 段长内容(可滚) ───────── */
const FIXTURE_INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>FIXTURE</title>
<style>body{font-family:sans-serif;margin:8px;padding:0}input{font-size:14px;padding:4px;width:240px}
button{font-size:14px;padding:4px 12px;margin-left:6px}#out{margin:10px 0;font-weight:bold}</style></head>
<body>
<input id="name" placeholder="NAME">
<button id="go">SUBMIT</button>
<div id="out"></div>
${Array.from({ length: 40 }, (_, i) => `<p>row ${i + 1} · lorem ipsum dolor sit amet consectetur adipiscing elit</p>`).join("\n")}
<script>
document.getElementById("go").addEventListener("click", function () {
  var v = document.getElementById("name").value;
  document.getElementById("out").textContent = "HELLO " + v;
  document.title = "SUBMITTED:" + v;
});
</script>
</body></html>`;
const FIXTURE_B = `<!doctype html><html><head><meta charset="utf-8"><title>PAGE-B</title></head>
<body><h1>PAGE-B</h1><p>second tab</p></body></html>`;

function startFixture() {
  const srv = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/b") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(FIXTURE_B); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_INDEX);
  });
  return new Promise((resolve, reject) => {
    srv.on("error", reject);
    srv.listen(FIX_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.once("listening", () => s.close(() => resolve(true)));
  s.listen(port, "127.0.0.1");
});

/* ───────── node 侧 WS 客户端:直说面板协议,拿权威回执 ───────── */
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
          w.timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error("WS 回执超时")); }, timeoutMs || 25000);
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

/** getState 回执文本是单行 JSON(可能带 elapsedMs 后缀),防御式截取对象。 */
const parseJsonText = (text) => {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
};

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  // 清掉上次跑残留的 png,保证本次取证列表就是本次的
  for (const f of fs.readdirSync(EVID).filter((x) => x.endsWith(".png"))) fs.rmSync(path.join(EVID, f), { force: true });
  for (const p of [GW_PORT, FIX_PORT]) {
    if (!(await portFree(p))) throw new Error(`端口 ${p} 已被占用(本脚本不碰 7700;请先释放或改 E2E_*_PORT)`);
  }

  const fixture = await startFixture();

  /* ───────── 网关 + 面板(7811) ─────────
   * require(".ts") 在本仓不通(sense-index-manager.ts 顶层 await → esbuild CJS 报错),
   * 改动态 import() 走 ESM 图(仍由 `node --import tsx` 提供 TS 转译)。 */
  const { servePanel } = await import("../../src/panel.ts");
  const { createGatewayApp } = await import("../../src/app.ts");
  const { createBrowserTool, idleMinutesOf } = await import("../../src/browser-tool.ts");
  closeSharedBrowser = async () => { await createBrowserTool(ROOT, browserConfig, "agent-e2e").execute({ action: "close", scope: "all" }); };

  const cfgState = { idleMinutes: 30 };
  /* 步骤 j「一键启用」用:enabled 由一个变量驱动 + cfg.set 热更新(等价 main.ts 的 Object.assign)。
   * 门禁(server browser.view.open / browserConfig.enabled())每次现读该函数,所以改变量即热生效。 */
  let browserEnabled = true;
  const cfgSetPatches = [];
  const appCfg = { browser: { enabled: true } };
  const browserConfig = {
    enabled: () => browserEnabled,
    allowDomains: () => [],
    idleMinutes: () => cfgState.idleMinutes,
    profile: () => "ephemeral",
    profileDir: () => ".genie/browser-profile-e2e",
    headless: () => true,
  };
  let server = null;
  const srvPanel = servePanel(GW_PORT, (httpServer) => { server = httpServer; }, {});
  /* 步骤 j 需要 cfg.set 落点:opts.config 存在才有 cfg 通道(app.ts 的 cfg 面),
   * onConfigSet 是最小钩子——面板「一键启用」发 cfg.set{browser:{enabled:true}},这里翻开关(不写盘)。 */
  const app = createGatewayApp({
    port: GW_PORT,
    useExternalHttp: true,
    browserConfig,
    config: appCfg,
    onConfigSet: (patch) => {
      cfgSetPatches.push(patch);
      const pb = patch.browser;
      if (pb && typeof pb === "object" && "enabled" in pb) {
        browserEnabled = pb.enabled === true;
        /* main.ts 语义:Object.assign(config, patch) —— 整体替换 browser 子对象。
         * server 侧门禁(browserCfgOf)读的是 opts.config,所以这里必须回写,否则重订阅仍被拒。 */
        Object.assign(appCfg, { browser: { ...appCfg.browser, ...pb } });
      }
      return { applied: ["browser.enabled"], needsRestart: [] };
    },
  });
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
    return p;
  };
  const gbvState = () => page.evaluate(() => (window.GenieBrowserView ? window.GenieBrowserView.state() : null));
  const statusText = () => page.evaluate(() => { const e = document.querySelector(".gbv-status"); return e ? (e.textContent || "") : ""; });
  /** 状态行是「瞬态提示」:后续 load/nav 事件会覆盖成「已连接」,所以按窗口采样看它出现过什么。 */
  const statusSeen = async (re, ms = 2200) => {
    const seen = [];
    for (let t = 0; t <= ms; t += 100) {
      const s = await statusText();
      if (seen.indexOf(s) < 0) seen.push(s);
      if (re.test(s)) return { hit: true, seen };
      await sleep(100);
    }
    return { hit: false, seen };
  };
  const humanTabId = () => page.evaluate(() => (window.GenieBrowserView ? window.GenieBrowserView.state().tabId : null));

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#act-web", { timeout: 30000 });

    /* ═══ a. 侧栏入口 → #view-browser 可见 + .gbv-root 挂上 ═══ */
    console.log("[a] 侧栏「网页 Webview」入口");
    await page.click("#act-web");
    await page.waitForFunction(() => {
      const n = document.querySelector("#brNote");
      return n && /已连接|无 tab|订阅失败/.test(n.textContent || "");
    }, null, { timeout: 25000 }).catch(() => {});
    const viewVisible = await page.locator("#view-browser").isVisible();
    const rootThere = (await page.locator("#gbvHost .gbv-root").count()) > 0;
    ok("a #view-browser 可见", viewVisible, await page.evaluate(() => { const v = document.querySelector("#view-browser"); return v ? v.className : "missing"; }));
    ok("a #gbvHost 内出现 .gbv-root", rootThere);
    ok("a 面板 WS 与网关握手(订阅回执)", /已连接|无 tab/.test(await page.evaluate(() => (document.querySelector("#brNote") || {}).textContent || "")));
    await shot("a-entry");

    /* ═══ b. 地址栏导航到夹具页 → 出帧 ═══ */
    console.log("[b] 地址栏导航 + 首帧");
    await page.fill(".gbv-url", FIX + "/");
    await page.click(".gbv-go");
    await page.waitForFunction((u) => {
      const s = window.GenieBrowserView.state();
      return !!s.tabId && String(s.url || "").indexOf(u) === 0;
    }, FIX, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll(".gbv-hit").length > 0, null, { timeout: 20000 }).catch(() => {});
    const st0 = await gbvState();
    const gs0 = parseJsonText((await client.command("getState", {})).text);
    ok("b 面板视图状态 URL = 夹具页", String((st0 && st0.url) || "").indexOf(FIX) === 0, st0 && st0.url);
    ok("b 服务端 getState title = FIXTURE", !!gs0 && gs0.title === "FIXTURE", gs0);
    ok("b autoSnapshot 出 hitRegions(>0 个 .gbv-hit)", (await page.locator(".gbv-hit").count()) > 0, await page.locator(".gbv-hit").count());
    const tHuman = await humanTabId();
    await shot("b-navigated");

    /* 用服务端快照拿输入框/按钮的 ref(几何/顺序都靠它,不靠猜) */
    const snapText = String((await client.command("snapshot", {}, tHuman)).text || "");
    const refOf = (needle) => {
      for (const line of snapText.split("\n")) {
        if (line.indexOf(needle) < 0) continue;
        const m = /^(e\d+)\s/.exec(line);
        if (m) return m[1];
      }
      return "";
    };
    const refInput = refOf('"NAME"');
    const refButton = refOf('"SUBMIT"');
    console.log("  · refs: input=" + (refInput || "(快照未命中)") + " button=" + (refButton || "(快照未命中)"));

    /* 几何兜底:按 .gbv-hit 的 top 排序,最靠上=输入框、第二=按钮 */
    const hitBoxes = await page.evaluate(() => [...document.querySelectorAll(".gbv-hit")].map((e) => ({
      ref: e.getAttribute("data-ref"),
      top: e.getBoundingClientRect().top,
      left: e.getBoundingClientRect().left,
      w: e.getBoundingClientRect().width,
      h: e.getBoundingClientRect().height,
    })).sort((a, b) => a.top - b.top || a.left - b.left));
    const clickHit = async (ref, fallbackIdx) => {
      const sel = ref ? `.gbv-hit[data-ref="${ref}"]` : null;
      if (sel && (await page.locator(sel).count()) > 0) { await page.click(sel); return ref; }
      const b = hitBoxes[fallbackIdx];
      if (!b) return "";
      await page.click(`.gbv-hit[data-ref="${b.ref}"]`);
      return b.ref;
    };

    /* ═══ c. 人类点击画布:点覆盖输入框的 .gbv-hit ═══ */
    console.log("[c] 人类点击画布命中输入框");
    const usedRef = await clickHit(refInput, 0);
    const seenC = await statusSeen(/已让 agent 点击|已点击页面坐标/);
    ok("c 点的是输入框 hit(ref=" + usedRef + ")", !!usedRef, JSON.stringify(hitBoxes.slice(0, 3)));
    ok("c 点击后有反馈(状态行出现过点击回执)", seenC.hit, JSON.stringify(seenC.seen));
    const focusNow = String((await client.command("act", { op: "getAttribute", selector: ":focus", attribute: "id" }, tHuman)).text || "");
    ok("c 点击真的把焦点放进了 #name(服务端回读 :focus)", /name/.test(focusNow), focusNow.slice(0, 200));
    await shot("c-human-click");

    /* ═══ d. 人类输入 + 提交 ═══ */
    console.log("[d] 人类输入通道 .gbv-type-input → .gbv-type-btn → 点按钮");
    await page.fill(".gbv-type-input", "Genie");
    await page.click(".gbv-type-btn");
    const seenD = await statusSeen(/已发送输入/);
    ok("d 输入发送有反馈(状态行出现过)", seenD.hit, JSON.stringify(seenD.seen));
    const usedRefB = await clickHit(refButton, 1);
    let titleNow = "";
    for (let i = 0; i < 25; i++) {
      const gs = parseJsonText((await client.command("getState", {}, tHuman)).text);
      titleNow = (gs && gs.title) || "";
      if (/SUBMITTED/.test(titleNow)) break;
      await sleep(400);
    }
    ok("d 页面标题变为 SUBMITTED:Genie(输入真进了页面并触发了提交)", /SUBMITTED:Genie/.test(titleNow), titleNow + " / buttonRef=" + usedRefB);
    const outText = await client.command("act", { op: "innerText", selector: "#out" }, tHuman);
    ok("d #out 文本 = HELLO Genie", /HELLO Genie/.test(String(outText.text || "")), String(outText.text || "").slice(0, 300));
    await shot("d-human-type-submit");

    /* ═══ e. 滚轮滚动(2026-11 回归锁:默认「适配」缩放下滚轮也必须滚页面——用户报的 bug 是
     *     适配态下滑鼠标没反应,旧脚本先切 100% 才滚等于绕过了 bug 现场,故不再切缩放) ═══ */
    console.log("[e] 画布滚轮(默认适配缩放) → 页面 scrollY");
    const zoomNow = await page.evaluate(() => {
      const b = document.querySelector(".gbv-zoom-btn.on");
      return (b && b.getAttribute("data-zoom")) || "";
    });
    console.log("  · 当前缩放按钮 =", JSON.stringify(zoomNow));
    ok("e 前置:仍是默认适配缩放(未先切 100%)", zoomNow === "fit", zoomNow);
    const stage = await page.evaluate(() => {
      const r = document.querySelector(".gbv-stage").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.wheel(0, 600);
    await sleep(800);
    await page.mouse.wheel(0, 600);
    await sleep(1500);
    const gsE = parseJsonText((await client.command("getState", {}, tHuman)).text);
    ok("e 页面 scrollY > 0", !!gsE && Number(gsE.scrollY) > 0, gsE && { scrollY: gsE.scrollY, viewport: gsE.viewport });
    await shot("e-scrolled");

    /* ═══ f. tab 栏:第二个 tab + owner 徽标 + chip 切换 ═══ */
    console.log("[f] tab 栏 .gbv-tab / .gbv-owner / chip 切换");
    const rOpen2 = await client.command("open", { url: FIX + "/b", newTab: true }, null);
    ok("f 服务端以 human 身份新开第二页成功", rOpen2.ok === true && /已打开/.test(String(rOpen2.text || "")), String(rOpen2.text || "").slice(0, 200));
    const tabsNow = (await client.command("tabs", {}, null)).tabs || [];
    const t2 = (tabsNow.find((t) => /\/b$/.test(String(t.url || ""))) || {}).id || "";
    ok("f tabs 回执里有两个 human tab", tabsNow.filter((t) => t.owner === "human").length >= 2, JSON.stringify(tabsNow));
    // 让面板自己刷新 tab 栏:点 ⟳ 触发页面 load 事件(资产在 nav/load 后必调 refreshTabs)
    // 注意 .gbv-reload 带 gbv-spin 旋转动画,Playwright 稳定性等不到 → 直接派发 DOM click
    await page.evaluate(() => { const b = document.querySelector(".gbv-reload"); if (b) b.click(); });
    await page.waitForFunction(() => document.querySelectorAll(".gbv-tab").length >= 2, null, { timeout: 20000 }).catch(() => {});
    let stF0 = await gbvState();
    if ((await page.locator(".gbv-tab").count()) < 2) {
      console.log("  · [debug] reload 未刷新 tab 栏,S.tabs=" + JSON.stringify((stF0 && stF0.tabs) || []) +
        " tabs栏文本=" + JSON.stringify(await page.evaluate(() => (document.querySelector(".gbv-tabs") || {}).textContent || "")));
      await page.fill(".gbv-url", FIX + "/");
      await page.evaluate(() => { const b = document.querySelector(".gbv-go"); if (b) b.click(); });
      await page.waitForFunction(() => document.querySelectorAll(".gbv-tab").length >= 2, null, { timeout: 20000 }).catch(() => {});
      stF0 = await gbvState();
    }
    console.log("  · 面板 S.tabs=" + JSON.stringify((stF0 && stF0.tabs) || []));
    const chipCount = await page.locator(".gbv-tab").count();
    const ownerCount = await page.locator(".gbv-owner").count();
    const ownerText = await page.evaluate(() => [...document.querySelectorAll(".gbv-owner")].map((e) => e.textContent));
    ok("f 面板出现 ≥2 个 .gbv-tab", chipCount >= 2, chipCount);
    ok("f tab chip 带 .gbv-owner 徽标", ownerCount >= 1, JSON.stringify(ownerText));
    await shot("f-tabs");
    if (t2) {
      await page.click(`.gbv-tab[data-tab-id="${t2}"]`);
      await page.waitForFunction((id) => { const s = window.GenieBrowserView.state(); return String(s.tabId) === String(id) && /\/b$/.test(String(s.url || "")); }, t2, { timeout: 25000 })
        .catch(() => {});
      const stF = await gbvState();
      ok("f 点第二页 chip 切换成功(URL → /b, title PAGE-B)", !!stF && String(stF.tabId) === String(t2) && /\/b$/.test(String(stF.url || "")), stF && { tabId: stF.tabId, url: stF.url, title: stF.title });
      await shot("f-switched-b");
      // 切回人的第一个 tab:人视图订阅回到 t1(步骤 h 的订阅保护前提)
      await page.click(`.gbv-tab[data-tab-id="${tHuman}"]`);
      await page.waitForFunction((id) => String(window.GenieBrowserView.state().tabId) === String(id), tHuman, { timeout: 25000 }).catch(() => {});
      const stBack = await gbvState();
      ok("f 点第一个 chip 切回成功(订阅回到 " + tHuman + ")", !!stBack && String(stBack.tabId) === String(tHuman), stBack && { tabId: stBack.tabId, url: stBack.url });
      await shot("f-switched-back");
    } else {
      ok("f 第二个 tab 有 tabId", false, JSON.stringify(tabsNow));
    }

    /* ═══ g. 人机互不抢:agent 开自己的 tab,不碰人的;越权 close fail-closed ═══ */
    console.log("[g] agent 侧 owner 隔离");
    const beforeG = await gbvState();
    const agentTool = createBrowserTool(ROOT, browserConfig, "agent-e2e");
    const agentOpen = String(await agentTool.execute({ action: "open", url: FIX + "/b" }));
    ok("g agent open 成功", /已打开/.test(agentOpen), agentOpen.slice(0, 200));
    await sleep(1500);
    const afterG = await gbvState();
    const agentGs = parseJsonText(String(await agentTool.execute({ action: "getState" })));
    ok("g 人的 tab URL/标题未被抢(面板视图仍是原页)", String(afterG && afterG.url) === String(beforeG && beforeG.url) && String(afterG && afterG.tabId) === String(beforeG && beforeG.tabId),
      { before: beforeG && { tabId: beforeG.tabId, url: beforeG.url }, after: afterG && { tabId: afterG.tabId, url: afterG.url } });
    ok("g agent 读到自己 owner 的 tab", !!agentGs && agentGs.url !== String(beforeG && beforeG.url), agentGs && agentGs.url);
    const tabsG = await client.command("tabs", {}, null);
    const agentRows = ((tabsG.tabs) || []).filter((t) => String(t.owner || "").indexOf("agent") === 0);
    ok("g tabs 里 agent tab 与人 tab 分列(owner 可见)", agentRows.length >= 1, JSON.stringify((tabsG.tabs) || []));
    const tAgent = (agentGs && String(agentGs.url || "") === FIX + "/b" && agentRows.find((t) => /\/b$/.test(String(t.url || "")))) ? agentRows.find((t) => /\/b$/.test(String(t.url || ""))).id : (agentRows[0] || {}).id;
    await shot("g-isolation");

    const closeOut = String(await agentTool.execute({ action: "close", tab: tHuman }));
    ok("g agent 越权 close 人的 tab → 「拒绝关闭」", /拒绝关闭/.test(closeOut), closeOut.slice(0, 300));
    const tabsAfterClose = (await client.command("tabs", {}, null)).tabs || [];
    ok("g 人的 tab 仍在 tabs 清单里", tabsAfterClose.some((t) => t.id === tHuman), JSON.stringify(tabsAfterClose));

    /* ═══ h. 订阅保护:reapIdle 跳过人正在看的 tab ═══ */
    console.log("[h] 订阅中 taboo 不被 idle 回收(等 " + Math.round(IDLE_WAIT_MS / 1000) + "s)");
    cfgState.idleMinutes = 1;
    ok("h idleMinutes 实际生效值 = 1 分钟(clamp 下限,故只能真等)", idleMinutesOf(browserConfig) === 1, idleMinutesOf(browserConfig));
    const stH = await gbvState();
    ok("h 人视图仍订阅在 " + tHuman, String(stH && stH.tabId) === String(tHuman), stH && stH.tabId);
    await sleep(IDLE_WAIT_MS); // 期间不发任何人侧命令(人 tab 的 lastActive 要自然变旧)
    const reapOut = String(await agentTool.execute({ action: "tabs" })); // runBrowserActionCore 入口即 reapIdle
    const tabsH = (await client.command("tabs", {}, null)).tabs || [];
    ok("h 人正在看的 tab 未被回收", tabsH.some((t) => t.id === tHuman), { reapOut: reapOut.slice(0, 300), tabs: tabsH });
    ok("h 对照组:非订阅的 agent tab 已被回收(证明 reap 真跑了)", !!tAgent && !tabsH.some((t) => t.id === tAgent), { tAgent, tabs: tabsH });
    const stH2 = await gbvState();
    ok("h 面板视图仍挂在该 tab(未掉线)", String(stH2 && stH2.tabId) === String(tHuman), stH2 && stH2.tabId);
    await shot("h-subscribe-protected");

    /* ═══ i. 取证汇总 + 页面异常 ═══ */
    const shots = fs.readdirSync(EVID).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(EVID, f));
    ok("i 截图取证 ≥8 张", shots.length >= 8, shots.length);
    ok("i 面板页无 JS 异常(pageerror)", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
    console.log("[i] 截图:" + shots.map((s) => path.relative(ROOT, s)).join(", "));

    /* ═══ j. 一键启用:browser.enabled=false → 面板「一键启用并打开」→ cfg.set → 重订阅成功 ═══ */
    console.log("[j] 一键启用浏览器(.gbv-enable → cfg.set → 重订阅)");
    // j-1 清空 tab 池(enabled 仍为 true)+ 重载面板:让视图从零挂载(#gbvHost 空),
    //     「一键启用」按钮的显示条件是 browser-view.js:967 的 `S.subFail && !S.tabId` —— 有 tab 时永不可见。
    const closedAll = String(await agentTool.execute({ action: "close", scope: "all" }));
    ok("j 关闭全部 tab(为「未启用」空态铺路)", /已关闭全部/.test(closedAll), closedAll.slice(0, 200));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#act-web", { timeout: 30000 });
    // 订阅回执权威观测:包裹 handleMessage 记下每一条 browser.view.subscribed(ok/tabId)
    await page.evaluate(() => {
      window.__e2eSubs = [];
      const g = window.GenieBrowserView;
      const orig = g.handleMessage;
      g.handleMessage = (m) => {
        if (m && m.type === "browser.view.subscribed") window.__e2eSubs.push({ ok: m.ok, tabId: m.tabId == null ? null : m.tabId });
        return orig(m);
      };
    });

    // j-2 关掉浏览器:门禁(server browser.view.open)现读 browserConfig.enabled() → 拒绝
    browserEnabled = false;
    appCfg.browser.enabled = false;
    ok("j 配置已关:browserConfig.enabled() = false", browserConfig.enabled() === false);

    // j-3 面板侧:进浏览器视图 → 点「断开」退订(browser.view.close)→ 点「连接」重订阅(browser.view.open)
    await page.click("#act-web");
    await page.waitForSelector("#gbvHost .gbv-root", { timeout: 25000 });
    await page.click("#brCloseView");
    await sleep(300);
    await page.click("#brOpenView");
    await page.waitForFunction(() => (window.__e2eSubs || []).some((x) => x.ok === false), null, { timeout: 20000 }).catch(() => {});
    const subsAfterDeny = await page.evaluate(() => (window.__e2eSubs || []).slice());
    ok("j 服务端拒绝订阅:收到 browser.view.subscribed ok:false", subsAfterDeny.some((x) => x.ok === false), subsAfterDeny);
    const stDenied = await gbvState();
    const noteDenied = await page.evaluate(() => (document.querySelector("#brNote") || {}).textContent || "");
    ok("j 面板进订阅失败态(subFail=true,#brNote 显示未启用)", !!stDenied && stDenied.subFail === true && /未启用/.test(noteDenied), { subFail: stDenied && stDenied.subFail, note: noteDenied });

    // j-4 空态出现「一键启用并打开」按钮且可见(computed display ≠ none)
    const enableDisp = await page.evaluate(() => {
      const b = document.querySelector("#gbvHost .gbv-enable");
      return b ? getComputedStyle(b).display : "missing";
    });
    ok("j .gbv-enable「一键启用并打开」可见", enableDisp !== "none" && enableDisp !== "missing", enableDisp);
    await shot("j-subscribe-denied");

    // j-5 点它 → 面板发 cfg.set{browser:{enabled:true}} → 600ms 后自动重订阅
    await page.click("#gbvHost .gbv-enable");
    await sleep(1200);
    ok("j 面板发出 cfg.set{ browser:{enabled:true} }", cfgSetPatches.some((p) => !!p && !!p.browser && p.browser.enabled === true), cfgSetPatches);
    ok("j 网关侧热生效:browserConfig.enabled() = true", browserConfig.enabled() === true);
    await page.waitForFunction(() => (window.__e2eSubs || []).some((x) => x.ok === true), null, { timeout: 25000 }).catch(() => {});
    const subsAfterEnable = await page.evaluate(() => (window.__e2eSubs || []).slice());
    const stOn = await gbvState();
    const noteOn = await page.evaluate(() => (document.querySelector("#brNote") || {}).textContent || "");
    ok("j 600ms 后重订阅成功(subscribed ok:true)", subsAfterEnable.some((x) => x.ok === true), subsAfterEnable);
    ok("j 面板回到已连接态(subFail=false,不再显示未启用)", !!stOn && stOn.subFail === false && !/未启用/.test(noteOn), { subFail: stOn && stOn.subFail, note: noteOn });
    ok("j #gbvHost .gbv-root 仍挂载", (await page.locator("#gbvHost .gbv-root").count()) > 0);
    await shot("j-enable-once");
    ok("j 面板页仍无 JS 异常(pageerror)", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  } catch (e) {
    failed++;
    console.error("[e2e] CRASH " + (e && e.stack ? e.stack : e));
    await shot("zz-crash").catch(() => {});
  } finally {
    console.log(failed ? `[e2e] FAILED ${failed} 项` : "[e2e] ALL PASS");
    if (failed) process.exitCode = 1;
    try { client.close(); } catch (e) { /* ignore */ }
    await browser.close().catch(() => {});
    // 收尾:把共享浏览器池也关掉(ephemeral profile,不留痕)
    if (closeSharedBrowser) await closeSharedBrowser().catch((e) => console.error("close shared browser: " + e.message));
    try { await app.close(); } catch (e) { console.error("app.close: " + e.message); }
    await new Promise((r) => { try { srvPanel.close().then(r, r); } catch (e) { r(); } });
    await new Promise((r) => fixture.close(r));
    await sleep(300);
    process.exit(process.exitCode || 0);
  }
})().catch((e) => { console.error("E2E BOOT CRASH", e); process.exit(1); });
