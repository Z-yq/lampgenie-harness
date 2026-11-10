/** UI 实测(step-062 用户口径:「以子智能体目录为一级入口——点击目录条目应在目录所在层级弹出/激活该子
 * agent 独立的 tab 页」+多尺寸视觉校验)。自启跑法:
 * npx tsx test/ui/_ui_selfhost.cjs --opts test/ui/_subws.opts.cjs test/ui/subdir-tab.spec.cjs
 * 断言面:①目录条目主区域点击=开/激活工作区 tab(运行中开=实时流;已结束点=回放;重复点=激活不重复开)
 * ②tab 完整性:任务书/状态/模型/事件流/工具调用/终止按钮(运行中在场,终态退场) ③过程卡「工作区」钮
 * (消息流第二入口)同通路 ④四档视口(1440x900/1280x800/1920x1080/1024x700 窄窗)截图+每档断言
 * 无横向溢出+关键元素(抽屉/tab 条/工作区体)可见。 */
const { chromium } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "spec-sess-subtab";
const SHOTS = path.join(__dirname, "..", "..", "..", "..", "tasks", "step-062-subagent-workspace-tab", "shots");
const VIEWPORTS = [
  [1440, 900], [1280, 800], [1920, 1080], [1024, 700], // 末档=窄窗不破版校验
];

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 160) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await page.addInitScript(() => {
    localStorage.setItem("zh:g-search", "off");
    localStorage.setItem("zh:g-term", "off");
  });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  // 2026-10-21 画布分流/分身独立看板:画布形态下白板 chip=定位白板卡、目录条目=定位消息分组、
  // 会话流不渲染子代理过程卡——本规格守经典契约(浮窗/工作区 tab/会话流过程卡),先切经典布局。
  await page.waitForTimeout(600);
  await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.evaluate((s) => sessionStorage.setItem("zh:sid", s), SID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);

  // ── 1. 提交任务:派一个后台子代理(echo-child→进程内 LlmLoopBackend,真 loop 事件)──
  await page.fill("#instruction", "子代理目录一级入口实测:派勘察子代理,点目录条目开工作区");
  try { await page.click("#go", { timeout: 5000 }); } catch (e) {
    const stopMode = (await page.locator("#go.stop").count()) > 0;
    if (!stopMode) { await page.click("#go", { timeout: 8000 }); }
  }

  // 2. 目录条目出现(运行中)→ 点击条目主区域(一级入口)
  // step-101 环境硬化:窗口 10s→20s——094 同机并发负载(双 agent+重索引)下「LLM 桩→spawn→注册表
  // 广播→渲染」链超 10s 致首断言红(修前修后同红,登记在案);空载本机两跑 35/35。意图不变:
  // 运行中子代理的目录条目必须出现,只是给共享机负载留与同 spec 注册表窗(12s)同级的余量。
  await page.click("#subDirBtn");
  let entry = false;
  for (let i = 0; i < 40 && !entry; i++) { await sleep(500); entry = (await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).count()) >= 1; }
  check("目录条目出现(渲染勘察,运行中)", entry);
  if (!entry) {
    // 失败取证:spec 与 app 同进程(selfhost),直接倒 journal 里最后几条工具结果(spawn 报错全文)
    try {
      const evs = globalThis.__selfhostApp.journal.readAll().filter((e) => e.kind === "tool.result" || e.kind === "subagent.result");
      for (const ev of evs.slice(-4)) console.log("[diag] " + ev.kind + " " + String((ev.payload || {}).content || (ev.payload || {}).event || "").slice(0, 400));
    } catch (err) { console.log("[diag] journal read failed: " + err); }
    await page.screenshot({ path: "/tmp/ui-subtab-fail.png" }); await browser.close(); process.exit(1);
  }
  await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(600);

  // 3. 一级入口断言:tab 条出现/主会话恒首位不可关/该条目 tab 激活/条目 ws-open 描边
  const barOn = await page.locator("#wsTabbar.on").count();
  check("点条目=tab 条出现", barOn === 1);
  const tabLabels = await page.locator("#wsTabbar .ws-tab .wt-label").allTextContents();
  check("主会话 tab 恒第一位", tabLabels.length >= 2 && tabLabels[0] === "主会话", tabLabels.join("|"));
  const mainClosable = await page.locator('#wsTabbar .ws-tab[data-wstab=""] .wt-x').count();
  check("主会话 tab 不可关闭", mainClosable === 0);
  const activeLabel = await page.locator("#wsTabbar .ws-tab.on .wt-label").first().textContent().catch(() => "");
  check("被点条目的 tab 激活(标题=渲染勘察)", activeLabel.indexOf("渲染勘察") >= 0, activeLabel);
  const entryOpenCls = await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).first().getAttribute("class").catch(() => "");
  check("激活条目 ws-open 描边(目录内可见选中态)", String(entryOpenCls).indexOf("ws-open") >= 0, entryOpenCls);

  // 4. tab 完整性(运行中):头部任务书/模型/状态+事件流+终止按钮在场。
  const headTxt = await page.locator("#chatBody .ws-head").textContent().catch(() => "");
  check("tab 头部:任务书全文+模型行", headTxt.indexOf("在仓库内检索 demoMain") >= 0 && headTxt.indexOf("模型:") >= 0, headTxt.slice(0, 80));
  // 终止按钮依赖注册表清单(3s 轮询异步到达):等 ws-head 翻成「后台运行中」再断言(纯 journal 态=不造假按钮)。
  let regRunning = false;
  for (let i = 0; i < 24 && !regRunning; i++) {
    await sleep(500);
    const st = await page.locator("#chatBody .ws-head .sd-st").first().textContent({ timeout: 400 }).catch(() => "");
    regRunning = !!st && st.indexOf("后台运行中") >= 0;
  }
  const headTxt2 = await page.locator("#chatBody .ws-head").textContent().catch(() => "");
  check("tab 头部:注册表到位翻「后台运行中」(模型/注册表行实装)", regRunning && headTxt2.indexOf("注册表缺席") < 0, headTxt2.slice(60, 140));
  let runCancel = 0;
  for (let i = 0; i < 10 && !runCancel; i++) { await sleep(400); runCancel = await page.locator("#chatBody .ws-head [data-subcancel]").count(); }
  check("tab 头部:运行中带「终止」按钮", runCancel === 1, "count=" + runCancel);
  let sawStream = false;
  for (let i = 0; i < 24 && !sawStream; i++) { await sleep(500); sawStream = (await page.locator("#chatBody .ws-step, #chatBody .tool-card, #chatBody .task-reply").count()) >= 1; }
  check("tab 体:子代理事件流在场(step/工具/消息行)", sawStream);
  const drawerStill = await page.locator("#subDir.on").count();
  check("目录保持打开(索引可连续浏览,不被强关)", drawerStill === 1);

  // 5. 重复点击同一条目=激活不重复开 tab
  const tabsBefore = await page.evaluate("window.__mature && window.__mature.subws ? window.__mature.subws().tabs.length : -1");
  await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(400);
  const tabsAfter = await page.evaluate("window.__mature && window.__mature.subws ? window.__mature.subws().tabs.length : -1");
  check("重复点击条目:激活不重复开(tabs 数不变)", tabsBefore === 1 && tabsAfter === 1, tabsBefore + "->" + tabsAfter);

  // 6. 等子代理完成(目录终态)→ tab 头部翻绿+终止按钮退场(已结束点击可回放=本 tab 即回放)
  let doneSt = "";
  for (let i = 0; i < 30 && !doneSt; i++) {
    await sleep(500);
    const t = await page.locator("#chatBody .ws-head .sd-st").first().textContent({ timeout: 400 }).catch(() => "");
    if (t && t.indexOf("完成") >= 0) doneSt = t;
  }
  check("tab 头部:终态翻绿(完成 · 用时)", !!doneSt, doneSt);
  let cancelGone = false;
  for (let i = 0; i < 12 && !cancelGone; i++) { await sleep(500); cancelGone = (await page.locator("#chatBody .ws-head [data-subcancel]").count()) === 0; }
  check("tab 头部:终态后终止按钮退场", cancelGone);
  const repTxt = await page.locator("#chatBody").textContent();
  check("tab 体:全程事件流回放(工具调用+终稿报告)", repTxt.indexOf("子代理报告:检索完成") >= 0 && (await page.locator("#chatBody .tool-card").count()) >= 1);

  // 7. 过程卡「工作区」钮=消息流第二入口:切回主会话(零污染)→ 点卡内按钮 → tab 重新激活
  await page.locator('#wsTabbar .ws-tab[data-wstab=""]').click();
  await page.waitForTimeout(400);
  const mainBody = await page.locator("#chatBody").textContent();
  check("主会话零污染(工作区事件不双渲染)", mainBody.indexOf("ws-only-marker-9137") < 0);
  const cardBtnN = await page.locator("#chatBody details.sub-card [data-subws]").count();
  check("过程卡带「工作区」钮(消息流第二入口)", cardBtnN >= 1, "count=" + cardBtnN);
  await page.locator("#chatBody details.sub-card [data-subws]").first().click();
  await page.waitForTimeout(500);
  const reactivate = await page.evaluate("window.__mature.subws().active");
  const activeN = await page.locator("#wsTabbar .ws-tab.on").count();
  check("点过程卡钮=同 tab 激活(不新开)", String(reactivate).length > 0 && activeN === 1, "active=" + String(reactivate).slice(-10) + " onN=" + activeN);

  // ── 8. 四档视口:目录开+工作区 tab 激活形态,断言无横向溢出+关键元素可见,截图留档 ──
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate("({sw: document.documentElement.scrollWidth, iw: window.innerWidth})");
    check("视口 " + w + "x" + h + ":无横向溢出", overflow.sw <= overflow.iw + 1, "scrollWidth=" + overflow.sw + " innerWidth=" + overflow.iw);
    const el = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible().catch(() => false));
    check("视口 " + w + "x" + h + ":目录抽屉可见", await el("#subDir.on"));
    check("视口 " + w + "x" + h + ":tab 条可见(激活态)", await el("#wsTabbar.on .ws-tab.on"));
    check("视口 " + w + "x" + h + ":工作区体可见", await el("#chatBody .ws-head"));
    await page.screenshot({ path: path.join(SHOTS, "subtab-" + w + "x" + h + ".png"), fullPage: false });
  }
  console.log("[shots] " + SHOTS);

  const realErrs = consoleErrors.filter((x) => x.indexOf("Still in CONNECTING state") < 0);
  check("0 pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("subdir-tab.spec: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
