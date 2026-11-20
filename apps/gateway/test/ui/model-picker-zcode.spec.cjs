/** UI 经验证:模型选择浮层 ZCode 复刻(两级导航+视觉规格)。
 * 断言:①主面板形态(头部厂商行/模型节✓/视觉徽标/滑块/Ctrl+T 提示/卡规格经验证)②两级导航+Esc 分层
 * ③模型切换生效(session.model.set 帧真发出,classic 会话与 Super 会话 sid 各自正确)④滑块点击生效
 * ⑤外点关闭/toggle/单实例 ⑥1280×800 与 zoom1.25 不裁切 ⑦浅/dark 截图。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/model-picker-zcode.spec.cjs */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const SHOTS = path.resolve(__dirname, "../../../../tasks/-model-picker-zcode-clone/shots");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp"); process.exit(1); }
  const Z1 = "t7-modelpicker-sid";
  app.journal.appendMany([
    { kind: "message.user", sessionId: Z1, payload: { text: "模型选择浮层实测".padEnd(50, "甲") } },
    { kind: "message.agent", sessionId: Z1, payload: { text: "助手条目".padEnd(60, "乙") } },
  ]);
  const BASE = process.env.PANEL_BASE;
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) {} });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) pageErrors.push(m.text().slice(0, 200)); });
  const sentFrames = [];
  page.on("websocket", (ws) => {
    try { ws.on("framesent", (f) => { const p = String(f.payload || ""); if (p.indexOf("session.model.set") >= 0) sentFrames.push(p); }); } catch (e) {}
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(300);
  await page.evaluate((sid) => { window.__mature.openSession(sid); }, Z1);
  await page.waitForTimeout(800);
 // 注入假配置(菜单数据源=cfg.providers[].models)
  await page.evaluate(() => {
    const base = (typeof cfgView !== "undefined" && cfgView) ? cfgView : {};
    const prev = base.config || {};
    cfgView = Object.assign({}, base, {
      config: Object.assign({}, prev, {
        providers: [
          { id: "spec-zai", name: "BigModel", baseUrl: "https://open.spec.cn/v4", models: ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.3-VL"] },
          { id: "spec-ds", name: "DeepSeek", baseUrl: "https://api.spec.ai/v1", models: ["deepseek-v4.1", "deepseek-v4.1-flash"] },
        ],
        coding: Object.assign({}, prev.coding || {}, { llm: Object.assign({}, (prev.coding || {}).llm || {}, { model: "GLM-5.3" }) }),
      }),
    });
    try { localStorage.setItem("zh:effort", "high"); } catch (e) {}
  });

  const openMenu = () => page.evaluate(() => { try { const el = document.getElementById("modelPill"); if (el) el.click(); } catch (e) {} });
  await openMenu(); await page.waitForTimeout(400);

 // ── ①主面板形态+视觉规格经验证 ──
  const vis = await page.evaluate(() => {
    const el = document.querySelector(".pill-menu.model-menu");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const head = el.querySelector(".mm-head");
    const hcs = head ? getComputedStyle(head) : null;
    const name = el.querySelector(".mm-sec-model .pm-item .pm-name");
    const ncs = name ? getComputedStyle(name) : null;
    const secHead = el.querySelector(".mm-sec-head");
    const shcs = secHead ? getComputedStyle(secHead) : null;
    const cur = el.querySelector(".pm-item.cur");
    const thumb = el.querySelector(".mm-thumb");
    const tcs = thumb ? getComputedStyle(thumb) : null;
    const segs = [...el.querySelectorAll(".mm-seg")];
    const vis0 = el.querySelector(".pm-vis");
    const kbd = el.querySelector(".mm-kbd");
    const hint = el.querySelector(".mm-sub-hint");
    return {
      w: cs.width, radius: cs.borderRadius, border: cs.borderWidth, pad: cs.padding, gap: cs.gap,
      headName: head ? head.textContent.trim().slice(0, 20) : "", headFont: hcs ? hcs.fontSize : "",
      itemFont: ncs ? ncs.fontSize : "", secHeadFont: shcs ? shcs.fontSize : "",
      hintFont: hint ? getComputedStyle(hint).fontSize : "",
      curVal: cur ? cur.getAttribute("data-v") : "", curChecked: cur ? cur.getAttribute("data-checked") : "",
      visBadge: vis0 ? getComputedStyle(vis0).borderTopWidth + " " + getComputedStyle(vis0).borderTopStyle : "",
      segN: segs.length, seg1: segs[0] ? getComputedStyle(segs[0]).backgroundColor : "", segN5: segs[4] ? getComputedStyle(segs[4]).backgroundColor : "",
      thumbW: tcs ? tcs.width : "", thumbBg: tcs ? tcs.backgroundColor : "", thumbLeft: thumb ? thumb.style.left : "",
      kbd: kbd ? kbd.textContent.trim() : "",
    };
  });
  check("① 主面板浮层在(model-menu)", !!vis, JSON.stringify(vis && { w: vis.w, radius: vis.radius }));
  if (vis) {
    check("① 卡规格:宽320/圆角12/1px描边", vis.w === "320px" && vis.radius === "12px" && vis.border === "1px", `w=${vis.w} r=${vis.radius} b=${vis.border}`);
    check("① 字号层级:条目14/头部13.5/节标题11", vis.itemFont === "14px" && vis.headFont === "13.5px" && vis.secHeadFont === "11px", `item=${vis.itemFont} head=${vis.headFont} sec=${vis.secHeadFont}`);
    check("① 头部厂商行=BigModel(当前聚焦厂商,含圆章字母)", vis.headName.indexOf("BigModel") >= 0, vis.headName);
    check("① 当前模型✓(GLM-5.3 data-checked)", vis.curVal === "GLM-5.3" && vis.curChecked === "true", vis.curVal);
    check("① 视觉徽标=描边小标签(1px solid)", vis.visBadge.indexOf("1px solid") === 0, vis.visBadge);
    check("① 滑块=5 段渐变轨道(绿→近白)", vis.segN === 5 && /9dc08b|157,\s*192|rgb/.test(vis.seg1) && vis.seg1 !== vis.segN5, `s1=${vis.seg1} s5=${vis.segN5}`);
    check("① 白圆钮 14px #fff 在当前档", vis.thumbW === "14px" && vis.thumbBg === "rgb(255, 255, 255)" && vis.thumbLeft !== "", `w=${vis.thumbW} bg=${vis.thumbBg} left=${vis.thumbLeft}`);
    check("① Ctrl+T 提示在", vis.kbd === "Ctrl+T", vis.kbd);
  }
  await page.screenshot({ path: path.join(SHOTS, "main-dark-1600.png") });

 // ── ② 两级导航 + Esc 分层 ──
  await page.evaluate(() => { const h = document.querySelector(".mm-head"); if (h) h.click(); });
  await page.waitForTimeout(250);
  const provPage = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".mm-prov")].map((r) => r.textContent.trim().slice(0, 18)),
    curCk: [...document.querySelectorAll(".mm-prov")].filter((r) => r.querySelector(".pm-ck")).map((r) => r.textContent.trim().slice(0, 12)),
    follow: !!document.querySelector(".pm-follow"),
    foot: !!document.querySelector('.pm-item[data-act="foot"]'),
  }));
  check("② 厂商页:2 厂商行+当前厂商✓+跟随全局+管理模型", provPage.rows.length === 2 && provPage.curCk.length === 1 && provPage.follow && provPage.foot, JSON.stringify(provPage));
  await page.screenshot({ path: path.join(SHOTS, "providers-dark-1600.png") });
 // 点 DeepSeek → 回主面板且聚焦切换
  await page.evaluate(() => { const r = [...document.querySelectorAll(".mm-prov")].find((x) => x.textContent.indexOf("DeepSeek") >= 0); if (r) r.click(); });
  await page.waitForTimeout(250);
  const focusChanged = await page.evaluate(() => { const h = document.querySelector(".mm-head"); const first = document.querySelector(".mm-sec-model .pm-item .pm-name"); return { head: h ? h.textContent.trim().slice(0, 12) : "", first: first ? first.textContent.trim() : "" }; });
  check("② 点厂商行→主面板聚焦切换(DeepSeek)", focusChanged.head.indexOf("DeepSeek") >= 0 && focusChanged.first === "deepseek-v4.1", JSON.stringify(focusChanged));
 // Esc 分层:主面板(subKey 非空)→回默认;再 Esc→关
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  const afterEsc1 = await page.evaluate(() => { const h = document.querySelector(".mm-head"); return h ? h.textContent.trim().slice(0, 12) : "(closed)"; });
  check("② Esc(聚焦态)→回默认聚焦 BigModel", afterEsc1.indexOf("BigModel") >= 0, afterEsc1);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  check("② Esc(主面板默认态)→关闭浮层", (await page.locator(".pill-menu.model-menu").count()) === 0);
 // 厂商页 Esc 分层
  await openMenu(); await page.waitForTimeout(300);
  await page.evaluate(() => { const h = document.querySelector(".mm-head"); if (h) h.click(); });
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  const escProv = await page.evaluate(() => ({ prov: !!document.querySelector(".mm-prov"), model: !!document.querySelector(".mm-sec-model") }));
  check("② Esc(厂商页)→退回主面板(不关层)", !escProv.prov && escProv.model, JSON.stringify(escProv));

 // ── ③ 模型切换生效(classic 会话) ──
  await page.keyboard.press("Escape"); await page.waitForTimeout(150);
  await openMenu(); await page.waitForTimeout(300);
  await page.evaluate(() => { const it = [...document.querySelectorAll(".pm-item[data-v]")].find((x) => x.getAttribute("data-v") === "GLM-5.3-Flash"); if (it) it.click(); });
  await page.waitForTimeout(400);
  const setFrames = sentFrames.map((p) => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(Boolean);
  const classicSet = setFrames.find((f) => f.type === "session.model.set" && f.model === "GLM-5.3-Flash");
  check("③ 模型切换:session.model.set 帧发出(classic sid)", !!classicSet, classicSet ? `sid=${classicSet.sessionId} model=${classicSet.model} effort=${classicSet.effort}` : "无帧");
  check("③ 切换后菜单关闭(staged)", (await page.locator(".pill-menu.model-menu").count()) === 0);

 // ── ④ 滑块点击生效 ──
  await openMenu(); await page.waitForTimeout(300);
  const effBefore = await page.evaluate(() => localStorage.getItem("zh:effort"));
  const sliderBox = await page.locator(".mm-slider").boundingBox();
  if (sliderBox) await page.mouse.click(sliderBox.x + sliderBox.width * 0.97, sliderBox.y + sliderBox.height / 2);
  await page.waitForTimeout(250);
  const effAfter = await page.evaluate(() => ({ v: localStorage.getItem("zh:effort"), now: (document.querySelector(".mm-slider") || {}).getAttribute ? document.querySelector(".mm-slider").getAttribute("aria-valuenow") : "" }));
  check("④ 滑块点击→effort 变化(高→最高档)", effBefore !== effAfter.v && !!effAfter.v, `before=${effBefore} after=${effAfter.v} aria=${effAfter.now}`);

 // ── ⑤ 生命周期:外点/toggle/单实例 ──
  await page.mouse.click(60, 420); await page.waitForTimeout(150);
  check("⑤ 外点关闭", (await page.locator(".pill-menu.model-menu").count()) === 0);
  await openMenu(); await page.waitForTimeout(120);
  await openMenu(); await page.waitForTimeout(150);
  check("⑤ 重复点击=toggle(不叠实例)", (await page.locator(".pill-menu.model-menu").count()) === 0);

 // ── Super 同源 ──
  await page.evaluate(() => { try { switchView("super"); } catch (e) {} });
  await page.waitForTimeout(600);
  const supOk = await page.evaluate(() => { try { const el = document.getElementById("supModelPill"); if (el) el.click(); return true; } catch (e) { return false; } });
  await page.waitForTimeout(400);
  const supMenu = await page.evaluate(() => !!document.querySelector(".pill-menu.model-menu .mm-head"));
  check("Super: supModelPill 打开同源菜单(model-menu)", supOk && supMenu);
  if (supMenu) {
    await page.evaluate(() => { const it = [...document.querySelectorAll(".pm-item[data-v]")].find((x) => x.getAttribute("data-v") === "GLM-5.3"); if (it) it.click(); });
    await page.waitForTimeout(400);
    const supSet = sentFrames.map((p) => { try { return JSON.parse(p); } catch (e) { return null; } }).filter(Boolean).find((f) => f.type === "session.model.set" && f.sessionId === "super");
    check("Super: session.model.set sid=super", !!supSet, supSet ? `model=${supSet.model}` : "无帧");
    await page.evaluate(() => { try { switchView("chat"); } catch (e) {} });
    await page.waitForTimeout(300);
  }

 // ── ⑥ 1280×800 与 zoom1.25 不裁切 ──
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await openMenu(); await page.waitForTimeout(300);
  const bb = await page.locator(".pill-menu.model-menu").boundingBox();
  check("⑥ 1280×800 视口内", !!bb && bb.x >= 0 && bb.y >= 0 && bb.x + bb.width <= 1280 && bb.y + bb.height <= 800, JSON.stringify(bb));
  await page.screenshot({ path: path.join(SHOTS, "main-dark-1280.png") });
  await page.keyboard.press("Escape");
 // zoom 1.25(body zoom 模拟 settings.zoom)
  await page.evaluate(() => { try { document.body.style.zoom = "1.25"; } catch (e) {} });
  await page.waitForTimeout(200);
  await openMenu(); await page.waitForTimeout(300);
  const bbz = await page.locator(".pill-menu.model-menu").boundingBox();
  check("⑥ zoom1.25 视口内(右/下不溢出)", !!bbz && bbz.x + bbz.width <= 1280 + 1 && bbz.y + bbz.height <= 800 + 1 && bbz.x >= -1, JSON.stringify(bbz));
  await page.screenshot({ path: path.join(SHOTS, "main-dark-1280-zoom125.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => { try { document.body.style.zoom = ""; } catch (e) {} });

 // ── ⑦ 浅色截图 ──
  await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
  await page.waitForTimeout(250);
  await openMenu(); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "main-light-1600.png") });
  await page.evaluate(() => { const h = document.querySelector(".mm-head"); if (h) h.click(); });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, "providers-light-1600.png") });
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });

  check("控制台无错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ====");
  console.log("shots: " + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(2); });
