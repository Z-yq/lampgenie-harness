/** UI 经验证:子智能体目录(两区+条目下钻+运行角标)+ task_output 轮询聚合(刷屏治理)。
 * 自启跑法:npx tsx test/ui/_ui_selfhost.cjs --opts test/ui/_subdir.opts.cjs test/ui/subdir.spec.cjs
 * 断言面:①目录开合/两区分区/条目下钻(任务书全文/模型行)/多 title 区分 ②同 agentId 多次
 * task_output 轮询只渲染一张聚合卡(终态翻绿+聚合说明) ③历史转录注入(journal 重放)同语义
 * +注册表缺席标注「历史会话」。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "spec-sess-subdir";
const HIST = "spec-sess-subdir-hist";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(5000); // 探测循环内 locator 等待用显式短超时,防缺元素时按 30s 缺省逐轮烧(曾致整轮挂 10 分钟)
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
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 }); // 慢盘+共享负载下首屏 >5s 是常态,页面级加载显式放宽
 // 画布分流/分身独立看板:画布形态下白板 chip=定位白板卡、目录条目=定位消息分组、
  // 会话流不渲染子代理过程卡——本规格守经典契约(浮窗/工作区 tab/会话流过程卡),先切经典布局。
  await page.waitForTimeout(600);
  await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {}); // WS 半开竞态兜底:hello 前重载必踩(CONNECTING pageerror 族)
  await page.evaluate((s) => sessionStorage.setItem("zh:sid", s), SID);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);

  // ── 1. 提交任务:脚本 LLM 派两个不同 title 的后台子代理并对第一个连发两次 task_output ──
  await page.fill("#instruction", "子代理目录实测:并行派两个勘察子代理");
  try { await page.click("#go", { timeout: 5000 }); } catch (e) {
    // 点击超时:先看任务是否已发出(#go 已翻 stop 态)——盲目重发第二击会当「停止」把任务取消
    await page.screenshot({ path: "/tmp/ui-subdir-clickfail.png" });
    const stopMode = (await page.locator("#go.stop").count()) > 0;
    if (!stopMode) { await page.click("#go", { timeout: 8000 }); }
  }

  // 2. 两张 spawn 过程卡出现(不同 title 可区分)
  let twoCards = false;
  for (let i = 0; i < 40 && !twoCards; i++) { await sleep(500); twoCards = (await page.locator("details.sub-card:not(.sub-wait)").count()) >= 2; }
  check("两张子代理过程卡出现", twoCards);
  if (!twoCards) { await page.screenshot({ path: "/tmp/ui-subdir-fail.png" }); await browser.close(); process.exit(1); }

  // 3. task_output 轮询聚合:同 agentId 两次轮询只出一张「等待子代理」卡,零逐对刷屏
  let waitCards = 0;
  for (let i = 0; i < 40 && waitCards < 1; i++) { await sleep(500); waitCards = await page.locator("details.sub-card.sub-wait").count(); }
  check("task_output 轮询聚合为一张等待卡", waitCards === 1, "count=" + waitCards);
  const spam = await page.locator(".tool-card:not(.sub-card)", { hasText: "task_output" }).count();
  check("task_output 调用/结果不逐对出卡", spam === 0, "count=" + spam);
  // 轮询结果已吸收:聚合说明行在场(2 次轮询)
  let pollNote = "";
  for (let i = 0; i < 20 && !pollNote; i++) {
    await sleep(500);
    const n = await page.locator(".sub-wait .sub-polls").first().textContent({ timeout: 400 }).catch(() => "");
    if (n && n.indexOf("2") >= 0) pollNote = n;
  }
  check("聚合说明行(已聚合 2 次轮询)", pollNote.indexOf("2") >= 0, pollNote.slice(0, 60));

  // 4. 目录开合 + 两区分区
  await page.click("#subDirBtn");
  let drawerOn = false;
  for (let i = 0; i < 10 && !drawerOn; i++) { await sleep(300); drawerOn = await page.locator("#subDir.on").count() > 0; }
  check("目录抽屉打开", drawerOn);
  const secHead = await page.locator("#subDirBody .sd-sec-h").allTextContents();
  check("两区分区(运行中/已结束)", secHead.length >= 2 && secHead[0].indexOf("运行中") >= 0 && secHead[1].indexOf("已结束") >= 0, secHead.join("|"));

  // 5. 条目 = 角色+title 区分(两个不同 title)
  const labels = await page.locator("#subDirBody .sd-label").allTextContents();
  check("条目标题区分(两个不同 title)", labels.some((x) => x.indexOf("渲染链路勘察") >= 0) && labels.some((x) => x.indexOf("测试缺口清点") >= 0), labels.join("|"));

 // 6. 下钻(收敛:条目主区域=一级入口开工作区 tab;下钻改挂「详情」钮轻展开)
  const drillItem = page.locator("#subDirBody .sd-item", { hasText: "渲染链路勘察" });
  const moreBtnN = await drillItem.locator("[data-submore]").count();
  check("条目带「详情」轻展开钮(下钻新挂点)", moreBtnN === 1, "count=" + moreBtnN);
  await drillItem.locator("[data-submore]").first().click();
  await page.waitForTimeout(300);
  const detail = await page.locator("#subDirBody .sd-item[open] .sd-detail").first().textContent().catch(() => "");
  check("下钻:任务书全文可见", detail.indexOf("调查整仓渲染链路并汇总输出") >= 0, detail.slice(0, 80));
  check("下钻:当前模型行可见", detail.indexOf("模型:") >= 0, detail.slice(0, 60));

  // 7. 运行角标:A 完成后(4s)只剩 B 运行 → 角标=1
  let badge1 = "";
  for (let i = 0; i < 30 && !badge1; i++) {
    await sleep(500);
    const vis = await page.locator("#subDirBadge").isVisible().catch(() => false);
    if (!vis) continue;
    const t = await page.locator("#subDirBadge").textContent();
    if (t === "1") badge1 = t;
  }
  check("运行角标=1(A 完成后只剩 B)", badge1 === "1", "badge=" + badge1);

  // 8. A 的等待卡终态翻绿(完成 · 用时)
  let aDone = false;
  for (let i = 0; i < 20 && !aDone; i++) {
    await sleep(500);
    const st = await page.locator("details.sub-wait .sub-st").first().textContent({ timeout: 400 }).catch(() => "");
    aDone = st.indexOf("完成") >= 0 && st.indexOf("用时") >= 0;
  }
  check("等待卡终态翻绿(完成 · 用时)", aDone);

  // 9. B 完成(12s)后:目录已结束=2,角标隐藏
  let archived = 0;
  for (let i = 0; i < 40 && archived < 2; i++) {
    await sleep(600);
    const doneSec = await page.locator("#subDirBody .sd-sec").nth(1).textContent().catch(() => "");
    const m = /已结束 · (\d+)/.exec(doneSec || "");
    if (m) archived = Number(m[1]);
  }
  check("已结束区归档 2 条", archived === 2, "count=" + archived);
  const badgeGone = await page.locator("#subDirBadge").isVisible().catch(() => true);
  check("角标归零隐藏", !badgeGone);
  await page.screenshot({ path: "/tmp/ui-subdir-live.png" });

 // ── 9.5 目录深化:元信息行/deadline 倒计时/心跳/终止按钮——G2 字段防御式渲染 + 终止通路 ──
  // 同进程注入后台注册表(服务端 subagentList 透传 + subagent.cancel case 的真实通路):
  //  zz=字段齐全带 cancel 句柄;old=stale+过期 deadline;nn=零新字段(缺席不炸)且无 cancel 句柄。
  const regInjected = (() => {
    const g = globalThis;
    if (!g.__bgAgents || !(g.__bgAgents instanceof Map)) g.__bgAgents = new Map();
    const now = Date.now();
    g.__specCancelled = false;
    g.__bgAgents.set("agent_speczz", {
      outputFile: "/tmp/spec-zz-out.txt", status: "running", sessionId: SID,
      title: "防御式渲染样板", model: "spec-model-x",
      deadline: now + 5 * 60 * 1000, heartbeatAt: now - 3000, stale: false,
      cancel: () => { g.__specCancelled = true; },
    });
    g.__bgAgents.set("agent_specold", {
      outputFile: "/tmp/spec-old-out.txt", status: "running", sessionId: SID,
      title: "过期条目样板", model: "spec-model-y",
      deadline: now - 60 * 1000, heartbeatAt: now - 90 * 1000, stale: true,
    });
    g.__bgAgents.set("agent_specnn", {
      outputFile: "/tmp/spec-nn-out.txt", status: "running", sessionId: SID,
      title: "零新字段条目",
    });
    return "ok";
  })();
  check("注册表注入成功(深化样板)", regInjected === "ok", String(regInjected));
  let zzMeta = "";
  for (let i = 0; i < 16 && !zzMeta; i++) {
    await sleep(500);
    zzMeta = await page.locator("#subDirBody .sd-item", { hasText: "防御式渲染样板" }).locator(".sd-meta2").textContent({ timeout: 300 }).catch(() => "");
  }
  check("深化:deadline 倒计时+心跳元信息行(有则显示)", zzMeta.indexOf("剩余") >= 0 && zzMeta.indexOf("心跳") >= 0, zzMeta.slice(0, 60));
  const oldMeta = await page.locator("#subDirBody .sd-item", { hasText: "过期条目样板" }).locator(".sd-meta2").textContent({ timeout: 2000 }).catch(() => "");
  const oldStaleCls = await page.locator("#subDirBody .sd-item", { hasText: "过期条目样板" }).locator(".sd-meta2 .sd-stale").count();
  check("深化:stale 发黄警示+过期 deadline 文案", oldMeta.indexOf("已超 deadline") >= 0 && oldMeta.indexOf("心跳停滞") >= 0 && oldStaleCls >= 2, oldMeta.slice(0, 70));
  const nnMetaN = await page.locator("#subDirBody .sd-item", { hasText: "零新字段条目" }).locator(".sd-meta2").count();
  const nnAlive = await page.locator("#subDirBody .sd-item", { hasText: "零新字段条目" }).count();
  check("深化:G2 字段缺席不炸不占位(无元信息行)", nnAlive === 1 && nnMetaN === 0, "meta2=" + nnMetaN);

  // 终止通路:有 cancel 句柄 → 服务端调句柄(ok:true)+toast;零句柄 → ok:false 如实提示
  const zzBtn = page.locator("#subDirBody .sd-item", { hasText: "防御式渲染样板" }).locator("[data-subcancel]");
  check("深化:运行条目带终止按钮", (await zzBtn.count()) === 1, "");
  const openBefore = await page.locator("#subDirBody .sd-item[open]").count();
  await zzBtn.click();
  await page.waitForTimeout(600);
  const cancelToast = await page.locator("#toastHost .toast", { hasText: "终止指令已送达" }).count();
  check("终止通路:cancel 句柄被调(ok:true 回包+toast)", cancelToast >= 0 && globalThis.__specCancelled === true && cancelToast >= 1, "cancelled=" + globalThis.__specCancelled + " toast=" + cancelToast);
  const openAfter = await page.locator("#subDirBody .sd-item[open]").count();
  check("终止按钮不触发条目开合(preventDefault)", openAfter === openBefore, "open " + openBefore + "->" + openAfter);
  const nnBtn = page.locator("#subDirBody .sd-item", { hasText: "零新字段条目" }).locator("[data-subcancel]");
  await nnBtn.click();
  let nnToast = "";
  for (let i = 0; i < 10 && !nnToast; i++) { await sleep(400); nnToast = await page.locator("#toastHost .toast", { hasText: "终止未执行" }).textContent({ timeout: 300 }).catch(() => ""); }
  check("终止通路:句柄缺席=诚实回 ok:false(不假做成功)", nnToast.indexOf("取消通道未接入") >= 0, nnToast.slice(0, 80));

  // 展开状态跨 3s 轮询重渲染保持(目录常驻可开合;「详情」钮切换,展开态经 openIds 回放)
  await page.locator("#subDirBody .sd-item", { hasText: "防御式渲染样板" }).locator("[data-submore]").click();
  await page.waitForTimeout(3500);
  const stillOpen = await page.locator("#subDirBody .sd-item", { hasText: "防御式渲染样板" }).getAttribute("open");
  check("下钻展开态跨轮询重渲染保持", stillOpen !== null, "open=" + (stillOpen !== null));
  await page.screenshot({ path: "/tmp/ui-subdir-deep.png" });

  // ── 10. 历史转录注入(journal 重放聚合语义)+ 注册表缺席「历史会话」标注 ──
  const injected = (() => {
    const app = globalThis.__selfhostApp;
    if (!app || !app.journal) return "no-app";
    app.journal.append({ kind: "message.user", sessionId: HIST, payload: { text: "注入历史轮询转录" } });
    app.journal.append({ kind: "subagent.spawn", sessionId: HIST, payload: { taskId: "tk-hist-a", agentId: "agent_hist_a", instructions: "盘点渲染链路并给出清单", title: "历史勘察" } });
    for (let i = 0; i < 3; i++) {
      app.journal.append({ kind: "message.agent", sessionId: HIST, payload: { text: "", toolCalls: [{ id: "hp" + i, name: "task_output", arguments: JSON.stringify({ agentId: "agent_hist_a" }) }] } });
      app.journal.append({ kind: "tool.result", sessionId: HIST, payload: { toolCallId: "hp" + i, name: "task_output", content: JSON.stringify({ status: i === 2 ? "completed" : "running", outputFile: "/tmp/hist-a.txt", output: "[progress] 第 " + (i + 1) + " 轮" }) } });
    }
    app.journal.append({ kind: "subagent.result", sessionId: HIST, payload: { taskId: "tk-hist-a", agentId: "agent_hist_a", event: { type: "result", ok: true, finalText: "历史勘察完成:3 个渲染点。" } } });
    // 无终态的历史子代理(注册表缺席)= 目录「已结束 · 历史会话」标注素材
    app.journal.append({ kind: "subagent.spawn", sessionId: HIST, payload: { taskId: "tk-hist-b", agentId: "agent_hist_b", instructions: "清点测试缺口", title: "缺口清点" } });
    return "ok";
  })();
  check("journal 注入成功", injected === "ok", String(injected));
  await page.evaluate((s) => sessionStorage.setItem("zh:sid", s), HIST);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const histWaits = await page.locator("details.sub-card.sub-wait").count();
  check("历史重放:3 次轮询仍聚合一张卡", histWaits === 1, "count=" + histWaits);
  const histSpam = await page.locator(".tool-card:not(.sub-card)", { hasText: "task_output" }).count();
  check("历史重放:轮询对零逐条出卡", histSpam === 0, "count=" + histSpam);
  const histNote = await page.locator(".sub-wait .sub-polls").first().textContent({ timeout: 2000 }).catch(() => "");
  check("历史重放:聚合说明=3 次轮询", histNote.indexOf("3") >= 0, histNote.slice(0, 60));
  const histSt = await page.locator(".sub-wait .sub-st").first().textContent({ timeout: 2000 }).catch(() => "");
  check("历史重放:等待卡终态=完成", histSt.indexOf("完成") >= 0, histSt.slice(0, 40));

  await page.click("#subDirBtn");
  await page.waitForTimeout(400);
  const histLabels = await page.locator("#subDirBody .sd-label").allTextContents();
  check("历史会话:目录含两个注入条目", histLabels.some((x) => x.indexOf("历史勘察") >= 0) && histLabels.some((x) => x.indexOf("缺口清点") >= 0), histLabels.join("|"));
  const histBody = await page.locator("#subDirBody").textContent();
  check("历史会话:无终态条目标注「历史会话」", histBody.indexOf("历史会话") >= 0);
  const histBadgeVis = await page.locator("#subDirBadge").isVisible().catch(() => true);
  check("历史会话:无运行中→角标隐藏", !histBadgeVis);
  await page.screenshot({ path: "/tmp/ui-subdir-hist.png" });

  // pageerror 口径:WS 半开竞态族(Still in CONNECTING)为登记过的环境偶发,已用 readyState 等待规避,
  // 残留出现不记失败;其余 pageerror 记失败。
  const realErrs = consoleErrors.filter((x) => x.indexOf("Still in CONNECTING state") < 0);
  check("0 pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("subdir.spec: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
