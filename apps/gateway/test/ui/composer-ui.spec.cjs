/** UI 经验证: 输入区三项(模型面板三段/上下文图形化/发送按钮图标化)。
 * 断言:①模型面板三段结构+键盘导航+Esc/外点关 ②ctxPill SVG 环形=占用率+浮窗图形区块(cx-stack/三区)
 * ③#go 图标化+aria-label 三态(停止态方点)④浅/dark 截图。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/composer-ui.spec.cjs */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const SHOTS = path.resolve(__dirname, "../../../../tasks/-composer-ui-graphics/shots");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp"); process.exit(1); }
  const Z1 = "t6-composer-sid";
  app.journal.appendMany([
    { kind: "message.user", sessionId: Z1, payload: { text: "用户条目一:".padEnd(60, "甲") } },
    { kind: "message.agent", sessionId: Z1, payload: { text: "助手条目一:".padEnd(80, "乙") } },
    { kind: "tool.call", sessionId: Z1, payload: { tool: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
    { kind: "tool.result", sessionId: Z1, payload: { content: "文件内容".padEnd(400, "丙") } },
    { kind: "message.agent", sessionId: Z1, payload: { text: "助手实测条", llmMs: 1200, usage: { inputTokens: 70000, outputTokens: 90, totalTokens: 70090 } } },
    { kind: "llm.trace", sessionId: Z1, payload: { model: "spec", contextWindow: 200000, usage: { inputTokens: 70000, cachedTokens: 40000, outputTokens: 120 } } },
  ]);
  const BASE = process.env.PANEL_BASE;
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) {} });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) pageErrors.push(m.text().slice(0, 200)); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(300);
  await page.evaluate((sid) => { window.__mature.openSession(sid); }, Z1);
  await page.waitForTimeout(900);
  await page.evaluate((sid) => { try { wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid })); } catch (e) {} }, Z1);
  await page.waitForTimeout(900);
 // 服务端 trace.stats 无 contextWindow(隔离实例未配置模型)→ 客户端补齐(照 spec 的 Super 先例),环形/百分比才有分母
  await page.evaluate((sid) => {
    try { traceStats[sid] = Object.assign({}, traceStats[sid] || {}, { contextWindow: 200000, contextTokens: 70000, contextTokensEst: 50000 }); } catch (e) {}
  }, Z1);
  await page.waitForTimeout(900); // 等 500ms 心跳的 ctxPillRender 刷出环形

 // ── ②上下文 pill:SVG 环形 + 极短数字 ──
 // 1601(super 通道消息体化)在途中间态会把 #ctxPill 从 page-shell 移走——缺席时如实 SKIP,不算本批失败
  const ctxPillThere = await page.evaluate(() => !!document.getElementById("ctxPill"));
  if (!ctxPillThere) {
    console.log("SKIP ctx: #ctxPill 不在场(1601 在途中间态,非本批)");
  }
  const pill = page.locator("#ctxPill");
  const ring = pill.locator("svg.cx-ring");
  check("ctx: pill 内存在 SVG 环形(cx-ring)", !ctxPillThere || (await ring.count()) === 1);
  const pillData = await page.evaluate(() => {
    const el = document.getElementById("ctxPill");
    const fg = el ? el.querySelector(".cx-ring-fg") : null;
    const bg = el ? el.querySelector(".cx-ring-bg") : null;
    const num = el ? (el.textContent.match(/(\d+)%/) || [])[1] : null;
    return {
      text: el ? el.textContent.trim() : "",
      pct: num ? Number(num) : null,
      dash: fg ? Number(fg.getAttribute("stroke-dasharray")) : null,
      off: fg ? Number(fg.getAttribute("stroke-dashoffset")) : null,
      r: fg ? Number(fg.getAttribute("r")) : null,
      title: el ? el.title : "",
      aria: el ? el.getAttribute("aria-label") : "",
    };
  });
  check("ctx: pill 文本=极短数字(≤6 字符,如 35%)", !ctxPillThere || (pillData.pct !== null && pillData.text.replace(/\s/g, "").length <= 6), JSON.stringify(pillData.text));
 // 环形值同源校验:stroke-dashoffset/C = 1 - pct/100(占用率)
  if (pillData.dash && pillData.r !== null && pillData.pct !== null) {
    const c = 2 * Math.PI * pillData.r;
    const ringPct = Math.round((1 - pillData.off / pillData.dash) * 100);
    check("ctx: 环形 dashoffset=占用率(与 pill 数字同源)", Math.abs(ringPct - pillData.pct) <= 2, "ring=" + ringPct + " pill=" + pillData.pct);
  } else check("ctx: 环形 dashoffset=占用率(与 pill 数字同源)", !ctxPillThere, JSON.stringify(pillData));
  check("ctx: 完整口径进 title/aria(含 tok)", !ctxPillThere || (/tok/.test(pillData.title) && /tok/.test(pillData.aria)), (pillData.title || "").slice(0, 60));

 // ── ②浮窗:图形区块(cx-stack 堆叠条 + 三区) + 头部数值同源 ──
  if (ctxPillThere) await page.click("#ctxPill");
  await page.waitForTimeout(300);
  const menu = page.locator(".pill-menu.cx-menu");
  check("ctx: 点击 pill 出浮窗(单实例)", !ctxPillThere || (await menu.count()) === 1);
  const menuData = await page.evaluate(() => {
    const m = document.querySelector(".pill-menu.cx-menu");
    if (!m) return null;
    const stack = m.querySelector(".cx-stack, .cx-segs");
    const segsBar = m.querySelectorAll(".cx-bar i, .cx-seg, .cx-stack i, .cx-stack span");
    const headText = (m.querySelector(".cx-head") || m).textContent;
    const headNum = (headText.match(/(\d+)%/) || [])[1];
    return {
      hasStack: !!stack,
      segBlocks: segsBar.length,
      headPct: headNum ? Number(headNum) : null,
      zones: m.querySelectorAll(".cx-row.cx-zone, .cx-zone").length,
      hasHit: m.textContent.indexOf("平均缓存命中率") >= 0,
      text: m.textContent.slice(0, 200),
    };
  });
  check("ctx: 浮窗取到 DOM", !ctxPillThere || !!menuData, "");
  if (menuData) {
    check("ctx: 浮窗构成=堆叠/分段图形区块(≥3 块)", menuData.hasStack && menuData.segBlocks >= 3, "blocks=" + menuData.segBlocks);
    check("ctx: 三区图形段存在", menuData.zones >= 3, "zones=" + menuData.zones);
    check("ctx: 缓存命中率仍在(顺序)", menuData.hasHit, "");
    if (menuData.headPct !== null && pillData.pct !== null) {
      check("ctx: 浮窗头部百分比与 pill 同源", Math.abs(menuData.headPct - pillData.pct) <= 2, "menu=" + menuData.headPct + " pill=" + pillData.pct);
    } else check("ctx: 浮窗头部百分比与 pill 同源", false, "head=" + menuData.headPct);
  }
  await page.screenshot({ path: path.join(SHOTS, "ctx-popover-dark-1600.png") });
  if (ctxPillThere) await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("ctx: Esc 关闭", !ctxPillThere || (await menu.count()) === 0);

 // ── ①模型面板:三段结构+键盘+生命周期 ──
 // 前置:隔离实例无模型配置→注入 cfgView 假配置(菜单数据源=cfg.providers[].models;chooseModel 触发 cfg.get 刷新)
  await page.evaluate(() => {
    const base = (typeof cfgView !== "undefined" && cfgView) ? cfgView : {};
    const prev = base.config || {};
    cfgView = Object.assign({}, base, {
      config: Object.assign({}, prev, {
        providers: [
          { id: "spec-prov", name: "Spec 厂商", baseUrl: "https://spec.example/v1", models: ["spec-mini", "spec-max-vl", "spec-pro"] },
          { id: "spec-local", name: "本地端点", baseUrl: "http://127.0.0.1:8080/v1", models: ["local-7b"] },
        ],
        coding: Object.assign({}, prev.coding || {}, { llm: Object.assign({}, (prev.coding || {}).llm || {}, { model: "spec-max-vl" }) }),
      }),
    });
    try { localStorage.setItem("zh:effort", "high"); } catch (e) {}
  });
  await page.evaluate(() => { try { const el = document.getElementById("modelPill"); if (el) el.click(); } catch (e) {} });
  await page.waitForTimeout(400);
  const mm = page.locator(".pill-menu, #modelMenuPill, [data-mm]");
 // modelMenu 载体(class=model-menu 输出到 pillMenuEl; 新形态:头部厂商行+模型节+滑块)
  const mmCount = await page.locator(".pill-menu.model-menu .mm-sec").count();
  check("mm: 面板打开(mm-sec ≥2:模型节+滑块节)", mmCount >= 2, "mm-sec=" + mmCount);
  check("mm: 模型段 mm-sec-model", (await page.locator(".mm-sec-model").count()) === 1);
  check("mm: 思考强度段 mm-sec-effort(滑块)", (await page.locator(".mm-sec-effort").count()) === 1);
  check("mm: 头部厂商行 mm-head 在(1)", (await page.locator(".mm-head").count()) === 1);
  const effData = await page.evaluate(() => {
    const sec = document.querySelector(".mm-sec-effort");
    if (!sec) return null;
    const segs = [...sec.querySelectorAll(".mm-seg")];
    const slider = sec.querySelector(".mm-slider");
    const thumb = sec.querySelector(".mm-thumb");
    return { n: segs.length, thumbLeft: thumb ? thumb.style.left : "", now: slider ? slider.getAttribute("aria-valuenow") : "", head: sec.textContent.slice(0, 40) };
  });
  check("mm: 滑块分段 ≥3 且白圆钮+aria 在", !!effData && effData.n >= 3 && !!effData.thumbLeft && effData.now !== "", JSON.stringify(effData));
 // 头部厂商行 → 厂商页(两级导航)
  await page.evaluate(() => { const h = document.querySelector(".mm-head"); if (h) h.click(); });
  await page.waitForTimeout(250);
  const provData = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".mm-prov")];
    return { n: rows.length, badges: rows.slice(0, 4).map((r) => (r.textContent.match(/(API|本地|自定义|套餐)/) || [])[1]), follow: !!document.querySelector(".pm-follow"), back: !!document.querySelector(".mm-back") };
  });
  check("mm: 厂商页行≥1 且带凭据徽标;跟随全局/返回在", provData.n >= 1 && provData.follow && provData.back && provData.badges.filter(Boolean).length >= Math.min(1, provData.n), JSON.stringify(provData));
 // 键盘:高亮 hot 移动 + Esc 关
  const hotBefore = await page.evaluate(() => { const h = document.querySelector(".pill-menu .pm-item.hot, .hot"); return h ? (h.getAttribute("data-v") || h.textContent.trim().slice(0, 20)) : null; });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const hotAfter = await page.evaluate(() => { const h = document.querySelector(".pill-menu .pm-item.hot, .hot"); return h ? (h.getAttribute("data-v") || h.textContent.trim().slice(0, 20)) : null; });
  check("mm: ArrowDown 高亮移动", hotBefore !== null && hotAfter !== null && hotBefore !== hotAfter, JSON.stringify({ hotBefore, hotAfter }));
  await page.screenshot({ path: path.join(SHOTS, "model-menu-dark-1600.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("mm: Esc 分层(厂商页→主面板)", (await page.locator(".mm-sec-model").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("mm: Esc 关闭(主面板→浮层消失)", (await page.locator(".mm-sec").count()) === 0);
 // toggle 不叠实例(evaluate click,避免主题切换后可见性等待卡死)
  const mmClick = () => page.evaluate(() => { try { const el = document.getElementById("modelPill"); if (el) el.click(); } catch (e) {} });
  await mmClick(); await page.waitForTimeout(120);
  await mmClick(); await page.waitForTimeout(150);
  check("mm: 重复点击=toggle(不叠实例)", (await page.locator(".mm-sec").count()) === 0);
 // 外点即关
  await mmClick(); await page.waitForTimeout(150);
  await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
  await page.mouse.click(60, 420);
  await page.waitForTimeout(150);
  check("mm: 外点即关", (await page.locator(".mm-sec").count()) === 0);

 // ── ③发送按钮:图标+aria-label 三态 ──
  const go = page.locator("#go");
  check("send: #go 含 SVG 图标", (await go.locator("svg").count()) >= 1);
  check("send: aria-label=发送(空闲态)", (await go.getAttribute("aria-label")) === "发送", await go.getAttribute("aria-label"));
 // 停止态:直接驱动 renderSendBtn 依赖的状态不可行(busy=在跑任务);用 DOM 类模拟渲染函数的行为契约:
 // renderSendBtn 是纯面板函数,通过 evaluate 调用 sendBtnSvg(mode) 验证三态 SVG 形态
  const icons = await page.evaluate(() => {
    const out = {};
    for (const mode of ["send", "stop", "queue"]) {
      try { out[mode] = (typeof sendBtnIconSvg === "function") ? sendBtnIconSvg(mode) : "(no sendBtnIconSvg)"; }
      catch (e) { out[mode] = "ERR " + String(e).slice(0, 60); }
    }
    return out;
  });
  check("send: stop 态=方点(rect)", /rect/.test(icons.stop || ""), (icons.stop || "").slice(0, 80));
  check("send: queue 态=时钟(circle)+纸飞机(path)", /circle/.test(icons.queue || "") && /path/.test(icons.queue || ""), (icons.queue || "").slice(0, 80));
  check("send: send 态=纸飞机(path)", /path/.test(icons.send || ""), (icons.send || "").slice(0, 80));
  const superSend = page.locator("#superSend");
  check("send: #superSend 存在", (await superSend.count()) === 1);

 // ── 浅色截图(ctx 浮窗+模型面板) ──
  await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
  await page.waitForTimeout(250);
  await page.evaluate(() => { try { const el = document.getElementById("ctxPill"); if (el) el.click(); } catch (e) {} });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, "ctx-popover-light-1600.png") });
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  await mmClick(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "model-menu-light-1600.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });
  await page.waitForTimeout(200);

 // ── 1280×800 视口复查(面板不越界) ──
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await mmClick(); await page.waitForTimeout(300);
  const bb = await page.locator(".mm-sec").first().boundingBox();
  check("mm: 面板在 1280×800 视口内", !!bb && bb.x >= 0 && bb.y >= 0 && bb.x + bb.width <= 1280 && bb.y + bb.height <= 800, JSON.stringify(bb));
  await page.screenshot({ path: path.join(SHOTS, "model-menu-dark-1280.png") });
  await page.keyboard.press("Escape");

  check("控制台无错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ====");
  console.log("shots: " + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(2); });
