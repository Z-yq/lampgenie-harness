/** UI 经验证: 上下文浮窗删四行+三区移最底(classic ctxPill + Super supCtx 同源同形态)。
 * 断言:①浮窗组顺序=头部余量→构成→缓存命中→温度三区(三区=最末组) ②被删四行文案不再出现
 * ③三区行 3 条仍在 ④生命周期(单实例/Esc/toggle/外点即关)不回归 ⑤浅/dark 截图(classic+Super)。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/ctx-popover-trim.spec.cjs */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const SHOTS = path.resolve(__dirname, "../../../../tasks/-ctx-popover-trim/shots");
const GONE = ["明细(消息", "当前上下文(最近一次调用实测)", "累计消耗(", "对话字符粗估"];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp"); process.exit(1); }
  const Z1 = "t6-spec-sid";
  const msgs = [];
  for (let i = 1; i <= 5; i++) msgs.push({ kind: "message.user", sessionId: Z1, payload: { text: "用户第" + i + "条:".padEnd(40 + i * 3, "甲") } });
  for (let i = 1; i <= 5; i++) msgs.push({ kind: "message.agent", sessionId: Z1, payload: { text: "助手第" + i + "条:".padEnd(60 + i * 7, "乙") } });
  app.journal.appendMany([
    ...msgs,
    { kind: "context.prune", sessionId: Z1, payload: { reason: "spec", compacted: 1, savedTokens: 0, policy: "reset", items: [], frozenCount: 3 } },
    { kind: "message.agent", sessionId: Z1, payload: { text: "助手实测条", llmMs: 1200, usage: { inputTokens: 8000, outputTokens: 90, totalTokens: 8090 } } },
 // llm.trace:喂缓存命中组(usage.cachedTokens/inputTokens)
    { kind: "llm.trace", sessionId: Z1, payload: { model: "spec", usage: { inputTokens: 10000, cachedTokens: 8000, outputTokens: 120 } } },
  ]);
  const BASE = process.env.PANEL_BASE;
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) {} });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) pageErrors.push(m.text().slice(0, 200)); });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(300);
  await page.evaluate((sid) => { window.__mature.openSession(sid); }, Z1);
  await page.waitForTimeout(800);
  await page.evaluate((sid) => { try { wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid })); } catch (e) {} }, Z1);
  const gotZones = await page.waitForFunction(
    (sid) => { try { const s = traceStats[sid]; return !!(s && s.contextZones && s.contextZones.zones && s.contextZones.totalMessages > 0); } catch (e) { return false; } },
    Z1, { timeout: 12000 },
  ).then(() => true).catch(() => false);
  check("前置:trace.stats 回包含 contextZones(服务端真算)", gotZones, gotZones ? "" : "12s 内未见 contextZones");

 // ── classic 浮窗:顺序+删行+截图 ──
  await page.click("#ctxPill");
  await page.waitForTimeout(300);
  const menu = page.locator(".pill-menu.cx-menu");
  check("classic:点击 pill 出浮窗(单实例)", (await menu.count()) === 1);
  const ci = await page.evaluate(() => {
    const m = document.querySelector(".pill-menu.cx-menu");
    if (!m) return null;
    const groups = [...m.children].map((g) => ({
      head: g.classList.contains("cx-head"),
      segs: !!g.querySelector(".cx-segs"),
      hit: g.textContent.indexOf("平均缓存命中率") >= 0,
      zones: g.querySelectorAll(".cx-row.cx-zone").length,
    }));
    return { groups: groups, text: m.textContent, lastIsZone: !!(m.lastElementChild && m.lastElementChild.querySelector(".cx-row.cx-zone")) };
  });
  check("classic:取到浮窗 DOM", !!ci, "");
  if (ci) {
    const idx = {
      head: ci.groups.findIndex((g) => g.head),
      segs: ci.groups.findIndex((g) => g.segs),
      hit: ci.groups.findIndex((g) => g.hit),
      zones: ci.groups.findIndex((g) => g.zones === 3),
    };
    check("classic:顺序=余量→构成→缓存命中→三区", idx.head >= 0 && idx.head < idx.segs && idx.segs < idx.hit && idx.hit < idx.zones,
      JSON.stringify(idx));
    check("classic:三区组=浮窗最末组", ci.lastIsZone && idx.zones === ci.groups.length - 1, "zones@" + idx.zones + "/" + ci.groups.length);
    check("classic:被删四行文案零残留", GONE.every((w) => ci.text.indexOf(w) < 0), GONE.filter((w) => ci.text.indexOf(w) >= 0).join("|"));
  }
  await page.screenshot({ path: path.join(SHOTS, "classic-dark-1400.png") });

 // 生命周期:Esc → toggle → 外点
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("classic:Esc 关闭", (await menu.count()) === 0);
  await page.click("#ctxPill"); await page.waitForTimeout(120);
  await page.click("#ctxPill"); await page.waitForTimeout(120);
  check("classic:重复点击=toggle(不叠实例)", (await menu.count()) === 0);
  await page.click("#ctxPill"); await page.waitForTimeout(150);
  await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
  await page.mouse.click(60, 420);
  await page.waitForTimeout(150);
  check("classic:外点即关", (await menu.count()) === 0);

 // ── Super 浮窗:同源同形态 ──
  await page.evaluate((sid) => {
    traceStats["super"] = Object.assign({}, traceStats[sid], { contextTokens: 12345, contextWindow: 200000 });
  }, Z1);
  await page.evaluate(() => switchView("super"));
  await page.waitForTimeout(400);
  const supPillVisible = await page.locator("#supCtxPill").isVisible().catch(() => false);
  if (!supPillVisible) {
    check("Super:#supCtxPill 可见(前置)", false, "视图切换后 pill 不可见——登记冲突遗留,后续断言跳过");
  } else {
    await page.click("#supCtxPill");
    await page.waitForTimeout(300);
    const smenu = page.locator(".pill-menu.cx-menu");
    check("Super:点击 pill 出浮窗(单实例)", (await smenu.count()) === 1);
    const si = await page.evaluate(() => {
      const m = document.querySelector(".pill-menu.cx-menu");
      if (!m) return null;
      const groups = [...m.children].map((g) => ({
        head: g.classList.contains("cx-head"),
        segs: !!g.querySelector(".cx-segs"),
        hit: g.textContent.indexOf("平均缓存命中率") >= 0,
        zones: g.querySelectorAll(".cx-row.cx-zone").length,
      }));
      return { groups: groups, text: m.textContent, lastIsZone: !!(m.lastElementChild && m.lastElementChild.querySelector(".cx-row.cx-zone")) };
    });
    check("Super:取到浮窗 DOM", !!si, "");
    if (si) {
 // Super 浮窗自 起即无缓存命中率组(该组数据源=classic 会话 llm.trace),顺序=余量→构成→三区(底)
      const idx = {
        head: si.groups.findIndex((g) => g.head),
        segs: si.groups.findIndex((g) => g.segs),
        zones: si.groups.findIndex((g) => g.zones === 3),
      };
      check("Super:顺序=余量→构成→三区(无缓存组,既有形态)", idx.head >= 0 && idx.head < idx.segs && idx.segs < idx.zones,
        JSON.stringify(idx));
      check("Super:三区组=浮窗最末组", si.lastIsZone && idx.zones === si.groups.length - 1, "zones@" + idx.zones + "/" + si.groups.length);
      check("Super:被删四行文案零残留", GONE.every((w) => si.text.indexOf(w) < 0), GONE.filter((w) => si.text.indexOf(w) >= 0).join("|"));
    }
    await page.screenshot({ path: path.join(SHOTS, "super-dark-1400.png") });
    await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.mouse.click(60, 420); await page.waitForTimeout(150);
    await page.click("#supCtxPill"); await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, "super-light-1400.png") });
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.mouse.click(60, 420); await page.waitForTimeout(150);
    check("Super:外点即关", (await smenu.count()) === 0);
  }

 // ── classic 浅色截图 + 视口适配 ──
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);
  await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
  await page.waitForTimeout(200);
  await page.click("#ctxPill"); await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, "classic-light-1400.png") });
  const bb = await page.locator(".pill-menu.cx-menu").boundingBox();
  check("classic:浮窗在视口内(1400×900)", !!bb && bb.x >= 0 && bb.y >= 0 && bb.x + bb.width <= 1400 && bb.y + bb.height <= 900, JSON.stringify(bb));
  await page.keyboard.press("Escape");
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });

  check("控制台无错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ====");
  console.log("shots: " + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(2); });
