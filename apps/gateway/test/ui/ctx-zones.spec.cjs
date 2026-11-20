/** UI 经验证: 上下文浮窗温度三区(classic ctxPill + Super supCtx 同源同形态)。
 * 断言:①两浮窗各 3 条三区行 ②三区条数合计=totalMessages(与浮窗头同帧同源)
 * ③冷+温+热 tok 严格=浮窗头总量(全量划分,不做误差容忍) ④占比和=100%、占比条宽度和≈100%
 * ⑤浮窗内不存在「对账/差额」字样(1603 对账展示已删) ⑥热区=未闭合链 12 条(1603 口径保持)
 * ⑦生命周期四态(外点即关/toggle 不叠/Esc)不回归 ⑧1280×800 不溢出 ⑨浅/dark 主题截图 4 张。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/ctx-zones.spec.cjs
 * (selfhost 真实例:journal 注入 → 服务端 computeTraceStats→deriveContextZones 真算;Super 视图复用 classic 真算结果)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const SHOTS = path.resolve(__dirname, "../../../../tasks/-ctx-zones-sum-equal/shots");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = globalThis.__selfhostApp; // node 侧(selfhost 注入桥,dashboard.spec 同款)
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp"); process.exit(1); }
  const Z1 = "z1-spec-sid";
  const msgs = [];
  for (let i = 1; i <= 5; i++) msgs.push({ kind: "message.user", sessionId: Z1, payload: { text: "用户第" + i + "条:".padEnd(40 + i * 3, "甲") } });
  for (let i = 1; i <= 5; i++) msgs.push({ kind: "message.agent", sessionId: Z1, payload: { text: "助手第" + i + "条:".padEnd(60 + i * 7, "乙") } });
 // 12 条未闭合链(prune 闭合后 agent 起手连续 tool 链——auto-compact 中途继续干活的真实形态;
 // 6 agent(带 toolCalls)+6 result 平衡,无「缺失结果」即不触发派生侧占位合成,显示恰为 12)
  const open = [];
  for (let i = 1; i <= 6; i++) open.push({ kind: "message.agent", sessionId: Z1, payload: { text: "链上助手" + i + ":".padEnd(30, "丁"), toolCalls: [{ id: "tc" + i, name: "grep" }], ...(i === 1 ? { llmMs: 1200, usage: { inputTokens: 8000, outputTokens: 90, totalTokens: 8090 } } : {}) } });
  for (let i = 1; i <= 6; i++) open.push({ kind: "tool.result", sessionId: Z1, payload: { toolCallId: "tc" + i, content: "结果" + i + ":".padEnd(50, "戊") } });
  app.journal.appendMany([
    ...msgs,
    { kind: "context.prune", sessionId: Z1, payload: { reason: "spec", compacted: 1, savedTokens: 0, policy: "reset", items: [], frozenCount: 3 } },
    ...open,
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

 // ── 真数据已在 node 侧注入(10 条消息+frozenCount=3 的 context.prune+llm.trace 经验证 8000 tok);开经典会话 ──
  await page.evaluate((sid) => { window.__mature.openSession(sid); }, Z1);
  await page.waitForTimeout(800);
 // 主动拉一帧 trace.stats(不等 2s 轮询):浮窗数据 = 服务端 deriveContextZones 真算
  await page.evaluate((sid) => { try { wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid })); } catch (e) {} }, Z1);
  const gotZones = await page.waitForFunction(
    (sid) => { try { const s = traceStats[sid]; return !!(s && s.contextZones && s.contextZones.zones && s.contextZones.totalMessages > 0); } catch (e) { return false; } },
    Z1, { timeout: 12000 },
  ).then(() => true).catch(() => false);
  check("前置:trace.stats 回包含 contextZones(服务端真算)", gotZones, gotZones ? "" : "12s 内未见 contextZones");
 // 环形断言前置:确保 contextWindow 在场(服务端缺省回 null 时客户端注入兜底,仅影响本 spec 断言)
  await page.evaluate((sid) => {
    const s = traceStats[sid] || (traceStats[sid] = {});
    if (!Number(s.contextWindow)) s.contextWindow = 200000;
  }, Z1);

  const zone = await page.evaluate((sid) => {
    const z = (traceStats[sid] || {}).contextZones || null;
    if (!z) return null;
    return { total: z.totalMessages, cold: z.zones.cold.messages, warm: z.zones.warm.messages, hot: z.zones.hot.messages, basis: z.zoneBasis, chains: z.openChains, ats: z.afterTraceStart, frozenFrom: z.frozenFrom, frozenCount: z.frozenCount };
  }, Z1);
  check("三区条数合计=totalMessages(服务端口径自洽)", !!zone && zone.cold + zone.warm + zone.hot === zone.total, JSON.stringify(zone));
  check("服务端:热区=未闭合链 12 条(非 6;任务书验收口径)", !!zone && zone.hot === 12 && zone.basis === "open-chains", JSON.stringify(zone));

 // ── classic 浮窗:打开+断言(全量划分,冷+温+热=总量严格相等) ──
  await page.evaluate(() => { try { ctxPillRender(); } catch (e) {} }); // 不等 500ms 心跳,立即按最新 traceStats 重绘环形
  const pillTxt = (await page.locator("#ctxPill").textContent().catch(() => "")) || "";
  const ringSpec = await page.evaluate(() => {
    const el = document.getElementById("ctxPill");
    const svg = el ? el.querySelector("svg.cx-ring") : null;
    const fg = svg ? svg.querySelector("circle.cx-ring-fg") : null;
    const pct = el ? el.querySelector(".cx-ring-pct") : null;
    if (!svg || !fg || !pct) return null;
    return {
      r: fg.getAttribute("r"),
      dasharray: fg.getAttribute("stroke-dasharray"),
      dashoffset: fg.getAttribute("stroke-dashoffset"),
      fgClass: fg.getAttribute("class") || "",
      pctText: pct.textContent,
      pctClass: pct.getAttribute("class") || "",
      pillTitle: el.getAttribute("title") || "",
      pillAria: el.getAttribute("aria-label") || "",
      size: (svg.getBoundingClientRect().width || 0) + "x" + (svg.getBoundingClientRect().height || 0),
    };
  });
 // 环形弧比例=占用率:fixture 主值 8000/窗口 200000=4% → dashoffset=c*(1-0.04)
  if (ringSpec) {
    const c = 2 * Math.PI * 15.5;
    const wantOff = c * (1 - 4 / 100);
    check("pill:环形存在+尺寸 16x16(与输入条图标协调)", ringSpec.size === "16x16", ringSpec.size);
    check("pill:弧比例=占用率(dashoffset 与 4% 一致,容差 1.5)", Math.abs(Number(ringSpec.dashoffset) - wantOff) <= 1.5, "off=" + ringSpec.dashoffset + " want=" + wantOff.toFixed(1));
    check("pill:中心百分比文本=4%", (ringSpec.pctText || "").indexOf("4") >= 0, ringSpec.pctText);
    check("pill:4%<70 → safe 档(无 warn/tense class)", ringSpec.fgClass.indexOf("warn") < 0 && ringSpec.fgClass.indexOf("tense") < 0, ringSpec.fgClass);
    check("pill:tooltip/aria-label 含「明细」", ringSpec.pillTitle.indexOf("明细") >= 0 && ringSpec.pillAria.indexOf("明细") >= 0, ringSpec.pillTitle.slice(0, 60));
  } else {
    check("pill:环形存在(前置)", false, "ctxPill 内未找到 svg.cx-ring——检查 trace.stats 是否带回 contextWindow");
  }
  await page.click("#ctxPill");
  await page.waitForTimeout(300);
  const menu = page.locator(".pill-menu.cx-menu");
  check("classic:点击 pill 出浮窗(单实例)", (await menu.count()) === 1);
  const cz = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".pill-menu.cx-menu .cx-row.cx-zone")];
    const head = document.querySelector(".pill-menu.cx-menu .cx-head .cx-nums");
    const bars = [...document.querySelectorAll(".pill-menu.cx-menu .cx-row.cx-zone .cx-zbar i")];
    return {
      n: rows.length,
      names: rows.map((r) => (r.querySelector(".cx-k") || {}).textContent || "").map((t) => t.trim().split(/\s+/)[0]),
      msgs: rows.map((r) => Number((r.textContent.match(/(\d+)\s*条/) || [0, 0])[1])),
      toks: rows.map((r) => Number((r.textContent.match(/(\d+)\s*tok/) || [0, 0])[1])),
      pcts: rows.map((r) => Number((r.textContent.match(/([\d.]+)\s*%/) || [0, 0])[1])),
      barW: bars.map((b) => parseFloat(b.style.width) || 0),
      head: head ? head.textContent : "",
      text: rows.map((r) => r.textContent || ""),
      zoneGrp: (document.querySelector(".pill-menu.cx-menu") || {}).textContent || "",
    };
  });
  check("classic:三区行 3 条", cz.n === 3, JSON.stringify(cz.names));
  check("classic:区名=冷区·冻结/温区·可精简/热区·未闭合链(口径)", ["冷区·冻结", "温区·可精简", "热区·未闭合链"].every((k, i) => (cz.names[i] || "").indexOf(k) >= 0), JSON.stringify(cz.names));
  check("classic:热区行=未闭合链口径(N 条 · M tok · 未闭合)", cz.n === 3 && /未闭合/.test(cz.text[2] || "") && /\d+\s*条/.test(cz.text[2] || ""), cz.text[2]);
  check("classic:三区条数合计=totalMessages", cz.n === 3 && cz.msgs.reduce((a, b) => a + b, 0) === (zone ? zone.total : -1), "rows=" + JSON.stringify(cz.msgs) + " total=" + (zone && zone.total));
  check("classic:占比条 3 根且宽>0", cz.barW.length === 3 && cz.barW.every((w) => w > 0), JSON.stringify(cz.barW));
  check("classic:浮窗头主值与 pill 同源(同一实测 8000 tok,pill 格式化为 8k 或环内 4%)", cz.head.indexOf("8000") >= 0 && (/(^|\s)(8k|8000)(\s|·|$)/.test(pillTxt) || ringSpec && (ringSpec.pctText || "").indexOf("4") >= 0), "head=" + cz.head + " pill=" + pillTxt.trim());
 // jev-150m 评分保护窗=单列小注(不占热区行)
  check("classic:jev-150m 保护窗以小注呈现(评分器窗口,非热区边界)", cz.zoneGrp.indexOf("评分保护窗") >= 0 && cz.zoneGrp.indexOf("非热区边界") >= 0, "小注检索=" + cz.zoneGrp.indexOf("评分保护窗"));
 // 全量划分:冷+温+热 严格=浮窗头总量(fixture 主值 8000);占比和=100%;无对账/差额行
  const headTok = Number((cz.head.match(/^([\d.]+)\s*\//) || [0, 0])[1]);
  const sumT = cz.toks.reduce((a, b) => a + b, 0);
  check("classic:冷+温+热 == 总量(严格相等,fixture=8000)", headTok === 8000 && sumT === headTok, "head=" + headTok + " rows=" + JSON.stringify(cz.toks) + " sum=" + sumT);
  const pctSum = Math.round(cz.pcts.reduce((a, b) => a + b, 0) * 10) / 10;
  check("classic:三区占比和=100%(±0.1)", Math.abs(pctSum - 100) <= 0.1, "pcts=" + JSON.stringify(cz.pcts) + " sum=" + pctSum);
  const barSum = Math.round(cz.barW.reduce((a, b) => a + b, 0));
  check("classic:占比条宽度和≈100%(±2)", Math.abs(barSum - 100) <= 2, "barSum=" + barSum);
  check("classic:无对账行/差额行(1603 对账展示已删)", cz.zoneGrp.indexOf("对账") < 0 && cz.zoneGrp.indexOf("差额") < 0, "对账@" + cz.zoneGrp.indexOf("对账") + " 差额@" + cz.zoneGrp.indexOf("差额"));
  await page.screenshot({ path: path.join(SHOTS, "classic-dark-1400.png") });

 // 生命周期:Esc 关 → toggle 二点不叠 → 外点即关
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("classic:Esc 关闭", (await menu.count()) === 0);
  await page.click("#ctxPill"); await page.waitForTimeout(120);
  await page.click("#ctxPill"); await page.waitForTimeout(120);
  check("classic:重复点击=toggle(不叠实例)", (await menu.count()) === 0);
  await page.click("#ctxPill"); await page.waitForTimeout(150);
  await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
  await page.mouse.click(60, 420); // 侧栏空白区(外点)
  await page.waitForTimeout(150);
  check("classic:外点即关", (await menu.count()) === 0);

 // ── Super 浮窗:同源数据(复用 classic 真算 contextZones)+ 同形态断言 ──
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
    const sz = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".pill-menu.cx-menu .cx-row.cx-zone")];
      const head = document.querySelector(".pill-menu.cx-menu .cx-head .cx-nums");
      const bars = [...document.querySelectorAll(".pill-menu.cx-menu .cx-row.cx-zone .cx-zbar i")];
      return { n: rows.length, msgs: rows.map((r) => Number((r.textContent.match(/(\d+)\s*条/) || [0, 0])[1])), toks: rows.map((r) => Number((r.textContent.match(/(\d+)\s*tok/) || [0, 0])[1])), barW: bars.map((b) => parseFloat(b.style.width) || 0), head: head ? head.textContent : "" };
    });
    check("Super:三区行 3 条(与 classic 同 helper 同形态)", sz.n === 3, "");
    check("Super:三区条数合计=totalMessages(同源)", sz.n === 3 && sz.msgs.reduce((a, b) => a + b, 0) === (zone ? zone.total : -1), JSON.stringify(sz.msgs));
    check("Super:占比条 3 根且宽>0", sz.barW.length === 3 && sz.barW.every((w) => w > 0), JSON.stringify(sz.barW));
    check("Super:浮窗头主值 1.2万 与注入同源", sz.head.indexOf("1.2万") >= 0, "head=" + sz.head);
    check("Super:冷+温+热 == 注入主值 12345(严格相等,同一 helper 归一)", sz.toks.reduce((a, b) => a + b, 0) === 12345, "rows=" + JSON.stringify(sz.toks) + " sum=" + sz.toks.reduce((a, b) => a + b, 0));
    await page.screenshot({ path: path.join(SHOTS, "super-dark-1400.png") });
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.mouse.click(60, 420);
    await page.waitForTimeout(150);
    check("Super:外点即关", (await smenu.count()) === 0);
  }

 // ── 主题与视口矩阵 ──
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);
  await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
  await page.waitForTimeout(200);
  await page.click("#ctxPill"); await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, "classic-light-1400.png") });
  const bb = await page.locator(".pill-menu.cx-menu").boundingBox();
  check("classic:浮窗在视口内(1400×900)", !!bb && bb.x >= 0 && bb.y >= 0 && bb.x + bb.width <= 1400 && bb.y + bb.height <= 900, JSON.stringify(bb));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
  await page.mouse.click(60, 420); await page.waitForTimeout(150);
  await page.click("#ctxPill"); await page.waitForTimeout(300);
  const bb2 = await page.locator(".pill-menu.cx-menu").boundingBox();
  check("classic:1280×800 不溢出", !!bb2 && bb2.x >= 0 && bb2.y >= 0 && bb2.x + bb2.width <= 1280 && bb2.y + bb2.height <= 800, JSON.stringify(bb2));
  await page.screenshot({ path: path.join(SHOTS, "classic-light-1280.png") });
  await page.keyboard.press("Escape");
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });

  check("控制台无错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ====");
  console.log("shots: " + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(2); });
