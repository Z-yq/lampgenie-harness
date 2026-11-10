/** UI 实测(step-141 子agent会话流改「选中式消息流」):左=子代理选择器,右=选中者实时消息流。
 * 自启跑法(沿用 subdir-tab/_subws 装配,不放大轮询/超时):
 * cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs --opts test/ui/_subws.opts.cjs test/ui/subchat-live.spec.cjs
 * 断言四组:
 * ① spawn 子agent→开「子agent会话流」卡→左栏出现运行中条目(状态点+标题)→点击选中→右 pane 依次见
 *    任务书派发卡(.sp-dispatch)/assistant 文本(message.agent 标记物)/工具合并卡(.tool-card)
 * ② 切换选中:点另一条目(journal 注入的合成子代理)→pane 整体切换为该 agent 的消息;点回原条目切回
 * ③ 运行中流式:新 subagent.event 注入到达→pane 增出内容且视口在底自动跟随;手动上滚后重渲不抢滚动
 * ④ 画布形态 #view-subchat 双栏(#subchat-list/#subchat-pane)可见;经典形态(body 无 .cv-shell)仍 display:none。 */
const { chromium } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "spec-sess-subchat";
const SHOTS = path.join(__dirname, "..", "..", "..", "..", "tasks", "step-141-subchat-live-message-view", "shots");
const NL = String.fromCharCode(10);

(async () => {
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp(含 journal)"); process.exit(1); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  page.setDefaultTimeout(5000);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 160) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, ms) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await sleep(500); v = await fn(); } return v; };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(600);
  // step-141 是画布形态专属卡:确保画布形态(默认 canvas;防 localStorage 残留经典态)。
  await page.evaluate(() => { try { if (!document.body.classList.contains("cv-shell")) CanvasShell.setMode("canvas"); } catch (e) {} });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.evaluate((s) => sessionStorage.setItem("zh:sid", s), SID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);

  // ── ① 提交任务:派一个后台子代理(_subws 装配:进程内真子 loop,产生 subagent.event 流)──
  await page.fill("#instruction", "子agent会话流选中式实测:派勘察子代理,左栏选择,右栏看消息流");
  try { await page.click("#go", { timeout: 5000 }); } catch (e) {
    const stopMode = (await page.locator("#go.stop").count()) > 0;
    if (!stopMode) { await page.click("#go", { timeout: 8000 }); }
  }
  // 打开「子agent会话流」卡(画布形态托盘按钮;switchView=唤回+聚焦,loadViewData 即重渲)
  await page.click("#act-subchat");
  await page.waitForTimeout(400);

  // 左栏出现运行中条目(状态点 run + 标题「渲染勘察」);journal 增量经 dashboard.changed 拉取到达
  const itemSel = '#subchat-list .sl-item[data-agent]';
  let running = await poll(async () => {
    const n = await page.locator(itemSel).count();
    if (!n) return false;
    const cls = await page.locator(itemSel + " .sd-dot").first().getAttribute("class").catch(() => "");
    const label = await page.locator(itemSel + " .sl-label").first().textContent().catch(() => "");
    return cls && cls.indexOf("run") >= 0 && label.indexOf("渲染勘察") >= 0;
  }, 20000);
  check("① 左栏出现运行中条目(run 状态点+标题)", running);
  const aidA = await page.locator(itemSel).first().getAttribute("data-agent").catch(() => "");
  check("① 条目携带 agentId(data-agent)", String(aidA).length > 0, String(aidA).slice(-10));

  // 点击选中该条目 → pane:派发卡(sp-dispatch:任务书全文)→ assistant 文本(标记物)→ 工具合并卡
  await page.locator(itemSel).first().click();
  await page.waitForTimeout(300);
  const dispatchOk = (await page.locator("#subchat-pane .sp-dispatch").count()) === 1;
  const dTxt = dispatchOk ? await page.locator("#subchat-pane .sp-dispatch").textContent() : "";
  check("① 派发卡在场+任务书全文(sp-dtask)", dispatchOk && dTxt.indexOf("在仓库内检索 demoMain") >= 0, dTxt.slice(0, 60));
  const selOn = await page.locator(itemSel + ".on").first().getAttribute("data-agent").catch(() => "");
  check("① 点击选中:左栏条目 .on 高亮=被点 agent", selOn === aidA, String(selOn).slice(-10));
  const markerOk = await poll(async () => {
    const t = await page.locator("#subchat-pane").textContent().catch(() => "");
    return t.indexOf("ws-only-marker-9137") >= 0;
  }, 20000);
  check("① pane:assistant 文本(message.agent 标记物)", markerOk);
  const toolOk = await poll(async () => (await page.locator("#subchat-pane .tool-card").count()) >= 1, 20000);
  const toolTxt = await page.locator("#subchat-pane .tool-card").first().textContent().catch(() => "");
  check("① pane:工具合并卡(tool.call+result 按 toolCallId)", toolOk && /搜索demoMain|grep|检索/.test(toolTxt), toolTxt.slice(0, 50));
  await page.screenshot({ path: path.join(SHOTS, "subchat-live-1440.png"), fullPage: false });

  // ── ② 切换选中:注入合成子代理B(journal 事件走真实 WS 增量链路)→ 左栏第二分区出现 → 点击切换 ──
  const AID_B = "subchat-syn-b-0001";
  app.journal.appendMany([
    { kind: "subagent.spawn", sessionId: SID, payload: { agentId: AID_B, title: "合成勘察B", instructions: "合成B任务书:校验选中式消息流切换。", taskId: "task-syn-b" } },
    { kind: "subagent.event", sessionId: SID, payload: { agentId: AID_B, taskId: "task-syn-b", kind: "message.agent", text: "合成B消息:切换观测样本 sub2-marker-alpha。" } },
    { kind: "subagent.result", sessionId: SID, payload: { agentId: AID_B, event: { ok: true, finalText: "合成B终态:切换样本完成。" } } },
  ]);
  const secB = await poll(async () => {
    const t = await page.locator("#subchat-list").textContent().catch(() => "");
    return t.indexOf("已结束") >= 0 && t.indexOf("合成勘察B") >= 0;
  }, 12000);
  check("② 注入后左栏出现「已结束」分区+合成条目", secB);
  await page.locator(itemSel, { hasText: "合成勘察B" }).first().click();
  await page.waitForTimeout(400);
  const paneB = await page.locator("#subchat-pane").textContent();
  const bOn = await page.locator(itemSel + ".on").first().getAttribute("data-agent").catch(() => "");
  check("② 点B条目:pane 整体切为 B 的消息(任务书+消息,不含A标记物)",
    paneB.indexOf("sub2-marker-alpha") >= 0 && paneB.indexOf("合成B任务书") >= 0 && paneB.indexOf("ws-only-marker-9137") < 0, bOn);
  check("② 选中高亮跟随到 B 条目", bOn === AID_B, bOn);
  await page.locator(itemSel, { hasText: "渲染勘察" }).first().click();
  await page.waitForTimeout(400);
  const paneA2 = await page.locator("#subchat-pane").textContent();
  check("② 点回A条目:pane 切回 A 的消息(标记物回归,B 样本退场)",
    paneA2.indexOf("ws-only-marker-9137") >= 0 && paneA2.indexOf("sub2-marker-alpha") < 0, "");

  // ── ②b 未读角标:B 未选中时注入新消息 → B 条目出现「N 新」角标;点 B 选中 → 角标清零 ──
  app.journal.appendMany([
    { kind: "subagent.event", sessionId: SID, payload: { agentId: AID_B, taskId: "task-syn-b", kind: "message.agent", text: "sub4-unread-badge 未读角标观测样本。" } },
  ]);
  const badgeOk = await poll(async () => {
    const bItem = page.locator(itemSel, { hasText: "合成勘察B" }).first();
    if (!(await bItem.locator(".sl-badge").count())) return false;
    return (await bItem.locator(".sl-badge").first().textContent()).indexOf("新") >= 0;
  }, 12000);
  check("②b 非选中 agent 新消息 → 条目出现 N 新角标", badgeOk);
  await page.locator(itemSel, { hasText: "合成勘察B" }).first().click();
  await page.waitForTimeout(400);
  const badgeGone = await page.locator(itemSel, { hasText: "合成勘察B" }).first().locator(".sl-badge").count();
  check("②b 选中该 agent 后角标清零", badgeGone === 0);
  await page.locator(itemSel, { hasText: "渲染勘察" }).first().click();
  await page.waitForTimeout(300);

  // ── ③ 流式跟随:注入长消息→pane 增出内容+自动滚底;手动上滚→再注入→不抢滚动 ──
  const longTail = Array.from({ length: 60 }, (_, i) => "sub3-follow 行" + (i + 1) + ":跟随观测样本。").join(NL);
  app.journal.appendMany([
    { kind: "subagent.event", sessionId: SID, payload: { agentId: aidA, taskId: "spec", kind: "message.agent", text: "sub3-follow-head 开始:" + NL + longTail } },
  ]);
  const grew = await poll(async () => (await page.locator("#subchat-pane").textContent()).indexOf("sub3-follow 行60") >= 0, 12000);
  check("③ 新 subagent.event 到达:pane 增出内容", grew);
  const atBottom = await page.evaluate("var p=document.getElementById('subchat-pane');p.scrollHeight-p.scrollTop-p.clientHeight");
  const scrollable = await page.evaluate("var p=document.getElementById('subchat-pane');p.scrollHeight>p.clientHeight+4");
  check("③ 视口在底自动跟随(距底<40px)", scrollable && atBottom < 40, "dist=" + atBottom + " scrollable=" + scrollable);
  await page.evaluate("document.getElementById('subchat-pane').scrollTop = 0");
  await page.waitForTimeout(200);
  app.journal.appendMany([
    { kind: "subagent.event", sessionId: SID, payload: { agentId: aidA, taskId: "spec", kind: "message.agent", text: "sub3-follow-top 上滚后到达:不应被拉回底部。" } } ,
  ]);
  const topStay = await poll(async () => (await page.locator("#subchat-pane").textContent()).indexOf("sub3-follow-top") >= 0, 12000);
  const topAfter = await page.evaluate("document.getElementById('subchat-pane').scrollTop");
  check("③ 手动上滚后重渲不抢滚动(仍停顶部)", topStay && topAfter < 40, "scrollTop=" + topAfter);

  // ── ④ 双形态:画布双栏可见;经典形态仍 CSS 隐藏(测试锁名契约)──
  const listVis = await page.locator("#subchat-list").first().isVisible().catch(() => false);
  const paneVis = await page.locator("#subchat-pane").first().isVisible().catch(() => false);
  check("④ 画布形态:左栏+右 pane 双栏可见", listVis && paneVis, "list=" + listVis + " pane=" + paneVis);
  await page.evaluate(() => { try { CanvasShell.setMode("classic"); } catch (e) {} });
  await page.waitForTimeout(500);
  const disp = await page.evaluate("getComputedStyle(document.getElementById('view-subchat')).display");
  check("④ 经典形态:#view-subchat 仍 display:none", disp === "none", disp);
  const classicHidden = await page.evaluate("getComputedStyle(document.getElementById('act-subchat')).display");
  check("④ 经典形态:#act-subchat 入口仍隐藏", classicHidden === "none", classicHidden);
  await page.evaluate(() => { try { CanvasShell.setMode("canvas"); } catch (e) {} });
  await page.waitForTimeout(300);

  const realErrs = consoleErrors.filter((x) => x.indexOf("Still in CONNECTING state") < 0);
  check("0 console error/pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("subchat-live.spec: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
