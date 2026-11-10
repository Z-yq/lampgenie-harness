/** UI 经验证:运行看板=团队「看板」子标签(收编;每项目一块看板)——真实 chromium 无头。
 * 跑法(不碰生产环境 7700):cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/dashboard.spec.cjs
 * 覆盖:侧栏顶级入口已移除/团队子标签切换→顶卡(会话/经验库/干预)→会话表(状态灯/项目/轨道/干预/token/子代理/板角标)
 *      →详情抽屉(活动/干预/token/轮次/末条输出)→趋势区(7天vs前7天指标卡+14天柱)→每项目作用域(进入锁定当前项目/重进重锁/手动切换保持/未归属桶)
 *      →实时推送(journal 追加→dashboard.changed→自动重拉,免手动刷新)→project 残留作用域回退。 */
process.env.GENIE_CHECKPOINT = "off";
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";

(async () => {
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp(含 journal)"); process.exit(1); }
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const poll = async (fn, ms = 12000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };

  // 预置 journal 事件:两个会话(带项目 __harness__ 的活跃会话 + 无主已终态会话)+ 子代理/权限拒绝/白板/token 维度。
  const inject = () => app.journal.appendMany([
    { kind: "task.start", sessionId: "dash-a", payload: { id: "td1", state: "running", projectId: "__harness__", instruction: "看板验收会话A:重构登录模块" } },
    { kind: "message.user", sessionId: "dash-a", payload: { text: "帮我重构登录模块,注意回退路径" } },
    { kind: "tool.call", sessionId: "dash-a", payload: { name: "read", toolCallId: "c1", arguments: "{}" } },
    { kind: "message.agent", sessionId: "dash-a", payload: { text: "", llmMs: 1200, usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960 } } },
    { kind: "permission.gate", sessionId: "dash-a", payload: { tool: "bash", effect: "denied", by: "rule-denied" } },
    { kind: "subagent.spawn", sessionId: "dash-a", payload: { agentId: "a1", backend: "echo-child" } },
    { kind: "subagent.result", sessionId: "dash-a", payload: { agentId: "a1", event: { type: "result", result: { ok: true, finalText: "done" } } } },
    { kind: "board.update", sessionId: "dash-a", payload: { path: "x.json", rev: 1 } },
    { kind: "turn.end", sessionId: "dash-a", payload: { reason: "completed" } },
    { kind: "task.start", sessionId: "dash-b", payload: { id: "td2", state: "running" } },
    { kind: "message.user", sessionId: "dash-b", payload: { text: "无主会话:查一下日志" } },
    { kind: "task.done", sessionId: "dash-b", payload: { id: "td2", state: "done" } },
  ]);
  inject();

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  check("页面零 JS 异常(首屏)", errs.length === 0, errs.join("|"));

  // 收编检查:侧栏顶级「运行看板」入口已移除;switchView("dash")=团队看板子标签的内部路由
  const sidebarGone = await page.evaluate(() => ({
    actDash: !!document.getElementById("act-dash"),
    actTeam: !!document.getElementById("act-team"),
    tabBtns: [!!document.getElementById("teamTabMembers"), !!document.getElementById("teamTabDash")],
  }));
  check("侧栏顶级入口已移除(act-dash 不存在)", sidebarGone.actDash === false && sidebarGone.actTeam, JSON.stringify(sidebarGone));
  check("团队视图带 成员/看板 两子标签", sidebarGone.tabBtns[0] && sidebarGone.tabBtns[1], "");

  await page.evaluate(() => { try { switchView("dash"); } catch (e) { console.error(String(e)); } });
  await page.waitForTimeout(700);
  const viewOn = await page.evaluate(() => ({
    teamOn: document.getElementById("view-team").classList.contains("on"),
    paneOn: document.getElementById("view-dash").classList.contains("on"),
    body: document.body.dataset.view,
    name: (document.getElementById("viewName") || {}).textContent || "",
    actTeam: document.getElementById("act-team").classList.contains("on"),
    tabDash: document.getElementById("teamTabDash").classList.contains("on"),
    membersHidden: document.getElementById("teamPaneMembers").style.display === "none",
  }));
  check("看板子标签切换(团队视图点亮+面板在位+侧栏点亮团队)", viewOn.teamOn && viewOn.paneOn && viewOn.body === "dash" && viewOn.actTeam && viewOn.tabDash && viewOn.membersHidden, JSON.stringify(viewOn));
  check("视图名=团队 · 看板", viewOn.name.indexOf("团队") >= 0 && viewOn.name.indexOf("看板") >= 0, viewOn.name);

  // 每项目一块看板:进入看板即锁定当前激活项目(selfhost 默认 __harness__)→ 只见 dash-a
  const scoped = await poll(async () => {
    const r = await page.evaluate(() => ({
      scope: (document.getElementById("dashScope") || {}).value || "",
      rows: [...document.querySelectorAll("tr.dash-row")].map((x) => x.dataset.dashsid),
      cards: (document.getElementById("dash-cards") || {}).innerText || "",
    }));
    return r.scope === "__harness__" && r.rows.length > 0 ? r : null;
  });
  check("进入看板默认锁定当前项目(dashScope=__harness__)", !!scoped && scoped.scope === "__harness__", JSON.stringify(scoped && scoped.scope));
  check("项目作用域只见本项目会话(仅 dash-a)", !!scoped && scoped.rows.length === 1 && scoped.rows[0] === "dash-a", JSON.stringify(scoped && scoped.rows));
  check("项目作用域顶卡=1 会话", !!scoped && /本机会话\s*\n?\s*1(\n|$)/.test(scoped.cards.replace(/[ \u00a0]/g, "")), (scoped && scoped.cards || "").slice(0, 60).replace(/\n/g, "|"));

  // 子标签来回切换:成员面板可见性互斥;重进看板=自动挡重锁当前项目
  await page.click("#teamTabMembers");
  await page.waitForTimeout(300);
  const membersOn = await page.evaluate(() => ({
    body: document.body.dataset.view,
    membersShown: document.getElementById("teamPaneMembers").style.display !== "none",
    paneOff: !document.getElementById("view-dash").classList.contains("on"),
  }));
  check("成员子标签回切(面板互斥)", membersOn.body === "team" && membersOn.membersShown && membersOn.paneOff, JSON.stringify(membersOn));
  await page.click("#teamTabDash");
  await page.waitForTimeout(500);
  const relock = await page.evaluate(() => ({
    scope: (document.getElementById("dashScope") || {}).value || "",
    body: document.body.dataset.view,
  }));
  check("重进看板=重新锁定当前项目", relock.body === "dash" && relock.scope === "__harness__", JSON.stringify(relock));

  // 手动切到全部:两会话行(作用域切换后保持,不被自动重锁吃掉)
  await page.selectOption("#dashScope", "all");
  await page.waitForTimeout(900);
  const table = await poll(async () => {
    const n = await page.evaluate(() => document.querySelectorAll("tr.dash-row").length);
    return n === 2 ? n : null;
  });
  check("作用域=全部(两会话行)", table === 2, "rows=" + table);
  const rows = await page.evaluate(() => ({
    promptA: (document.querySelector('tr[data-dashsid="dash-a"] .dash-prompt') || {}).textContent || "",
    statusA: (document.querySelector('tr[data-dashsid="dash-a"] .dash-st-wait') || {}).textContent || "",
    endedB: !!document.querySelector('tr[data-dashsid="dash-b"] .dash-st-stop'),
    interventionA: (document.querySelector('tr[data-dashsid="dash-a"] td[title*="打断"]') || {}).textContent || "",
    tokenA: (document.querySelector('tr[data-dashsid="dash-a"] td[title*="入"]') || {}).textContent || "",
    subA: (document.querySelector('tr[data-dashsid="dash-a"] td[title*="派"]') || {}).textContent || "",
    cards: (document.getElementById("dash-cards") || {}).innerText || "",
  }));
  check("状态灯:等输入/已结束五态映射", rows.statusA === "等输入" && rows.endedB, JSON.stringify({ a: rows.statusA, b: rows.endedB }));
  check("干预列(打断+拒绝+纠正合计)", rows.interventionA.trim() === "1", "interv=" + rows.interventionA);
  check("token 列(message.agent usage 合计)", rows.tokenA.trim() === "960", "tokens=" + rows.tokenA);
  check("子代理列(C:spawn/result 计数)", rows.subA.trim().indexOf("1") === 0, "sub=" + rows.subA);
  check("顶卡随作用域变化(全部=2 会话)", /本机会话\s*\n?\s*2(\n|$)/.test(rows.cards.replace(/[ \u00a0]/g, "")), (rows.cards || "").slice(0, 60).replace(/\n/g, "|"));

  // 趋势区:指标卡+14 天柱状(纯 CSS)——趋势按所选作用域服务端重算(dashboard.trends projectId)
  const trend = await page.evaluate(() => ({
    metrics: [...document.querySelectorAll("#dash-trend .dash-card-t")].map((e) => e.textContent),
    bars: document.querySelectorAll("#dash-trend .dash-bar").length,
  }));
  check("趋势指标卡(轮次/成功率/纠正率/耗时)", ["轮次 / 会话", "成功率", "纠正率", "平均耗时"].every((t) => trend.metrics.some((m) => (m || "").indexOf(t) === 0)), JSON.stringify(trend.metrics));
  check("14 天柱状图(缺日补零)", trend.bars === 14, "bars=" + trend.bars);

  // 详情抽屉
  await page.click('tr[data-dashsid="dash-a"] [data-dashdetail]');
  await page.waitForTimeout(300);
  const drawer = await page.evaluate(() => ({
    open: document.getElementById("dashDrawer").classList.contains("open"),
    text: document.getElementById("dashDetailBody").innerText || "",
  }));
  check("详情抽屉打开", drawer.open, "");
  check("抽屉含干预/token/子代理/轮次/末条输出五区", ["干预", "Token / 耗时", "子代理 / 白板", "用户轮次", "末条 AI 输出"].every((k) => drawer.text.includes(k)), drawer.text.slice(0, 100).replace(/\n/g, " "));
  check("抽屉拒绝明细(C:权限门事件流)", drawer.text.includes("bash"), "");
  await page.evaluate(() => dashDetailClose());
  await page.waitForTimeout(200);
  check("抽屉 ESC/关闭收起", !(await page.evaluate(() => document.getElementById("dashDrawer").classList.contains("open"))), "");

  // 作用域过滤:未归属桶保留,只有 dash-b
  await page.selectOption("#dashScope", "unassigned");
  await page.waitForTimeout(900);
  const unscoped = await poll(async () => {
    const r = await page.evaluate(() => [...document.querySelectorAll("tr.dash-row")].map((x) => x.dataset.dashsid));
    return r.length === 1 && r[0] === "dash-b" ? r : null;
  });
  check("作用域=未归属(仅无主会话,桶保留)", !!unscoped, JSON.stringify(unscoped));
  await page.selectOption("#dashScope", "all");
  await page.waitForTimeout(900);

  // 实时推送:看板子标签开着追加新会话 → dashboard.changed 节流广播 → 免刷新出现
  app.journal.append({ kind: "task.start", sessionId: "dash-c", payload: { id: "td3", state: "running", projectId: "__harness__", instruction: "实时推送验收会话C" } });
  app.journal.append({ kind: "message.user", sessionId: "dash-c", payload: { text: "实时推送验收会话C:跑测试" } });
  const pushed = await poll(async () => {
    const r = await page.evaluate(() => [...document.querySelectorAll("tr.dash-row")].map((x) => x.dataset.dashsid).join(","));
    return r.indexOf("dash-c") >= 0 ? r : null;
  }, 12000);
  check("实时推送(journal 追加免刷新出现)", !!pushed, String(pushed));
  const liveDot = await page.evaluate(() => (document.getElementById("dashLiveDot") || {}).textContent || "");
  check("实时徽标(推送后=实时)", liveDot === "实时", liveDot);

  // 残留作用域回退:scope 设成不存在的项目 id → 渲染时回退全部(项目移除防呆)
  const fallback = await page.evaluate(() => {
    dashScope = "ghost-project";
    dashRender();
    return dashScope;
  });
  check("残留作用域回退全部", fallback === "all", "scope=" + fallback);

  // 文案纪律:看板自身零外部品牌字样(团队仓等其它功能区另有合法品牌字符串,不在本面板范围)
  const brand = await page.evaluate(() => {
    const v = document.getElementById("view-dash");
    return v ? (v.innerText || "").includes("teamai") || v.outerHTML.includes("teamai") : true;
  });
  check("看板面板零外部品牌字样", !brand, "");

  check("全程零页面异常", errs.length === 0, errs.join("|"));
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("DASHBOARD SPEC: " + (results.length - fails) + "/" + results.length + " PASS");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
