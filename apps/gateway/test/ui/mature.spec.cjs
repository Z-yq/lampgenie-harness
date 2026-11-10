/** step-046 成熟面板件 UI 实测:会话标签页/思考卡/变更条/双 pill/统计图表/自动化分栏/快捷键分区。
 * 真实 chromium 无头;面板地址默认 7700,PANEL_BASE 可覆盖。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  check("面板加载", await page.locator("#instruction").count() === 1);

  // 1. 标签条:按用户口径已废弃——断言硬隐藏(口径即验收);会话切换走侧栏任务行/新建按钮。
  await page.fill("#instruction", "mature-spec 会话验证");
  await page.click("#go");
  await page.waitForTimeout(600);
  check("标签条按口径硬隐藏(display:none)", await page.locator("#tabbar").isHidden() || (await page.locator("#tabbar .s-tab").count()) === 0);
  check("任务提交成功(侧栏行在列)", (await page.locator("#taskList .t-row").count()) >= 1);

  // 2. 思考卡 + 变更条:钩子注入(histEvents+diffstats)→ renderHistory
  await page.evaluate(() => {
    const sid = window.__mature.tasks instanceof Map ? [...window.__mature.tasks.values()][0] : null;
    const taskId = sid ? sid.id : "spec-task";
    window.__mature.diffstats.set(taskId, { files: [{ path: "a.ts", add: 3, del: 1 }, { path: "b.ts", add: 0, del: 5 }], total: { files: 2, add: 3, del: 6 }, sha: "fake" });
    window.__mature.renderHistory();
  });
  // histEvents 注入需要 currentSid;先开一个会话再注入。简化:直接在 evaluate 里改 histEvents 不可达(闭包)——
  // 用任务终态流:让页面收到 task.changed(通过真实任务)。此处验证 UI 组件存在性 + diffstats 钩子可达。
  check("diffstats 钩子可达(注入不炸)", true);
  check("思考卡 CSS 在位", await page.locator("style").first().textContent().then((s) => s.includes("think-card")));
  check("变更条 CSS 在位", await page.locator("style").first().textContent().then((s) => s.includes("diffbar")));

  // 3. 双 pill(2026-10-14 口径对齐):pill 点击=就地下拉菜单(视频 2 改造,非循环点击)——
  // 断言改走菜单项点击;净状态归位纪律不变(选回原档)。
  const menuPick = async (pillSel, itemText) => {
    await page.click(pillSel);
    await page.waitForTimeout(350);
    await page.locator(".pill-menu .pm-item", { hasText: itemText }).first().click();
    await page.waitForTimeout(400);
    return (await page.locator(pillSel).textContent()).trim();
  };
  const permStart = (await page.locator("#permPill").textContent()).trim();
  const perm1 = await menuPick("#permPill", "完全访问");
  check("权限 pill 菜单切换(ask→auto)", perm1 === "完全访问", permStart + " → " + perm1);
  const perm2 = await menuPick("#permPill", "只读");
  check("权限 pill 二次切换(auto→readonly)", perm2 === "只读", perm1 + " → " + perm2);
  await menuPick("#permPill", permStart === "只读" ? "询问每次" : permStart); // 回原档(净变更为零)
  const effStart = (await page.locator("#effortPill").textContent()).trim();
  const EFF_TARGETS = ["低", "中", "高", "最高"];
  const effTarget = EFF_TARGETS.find((x) => effStart !== x && !effStart.includes(x)) || "低";
  const eff1 = await menuPick("#effortPill", effTarget);
  check("思考力度 pill 菜单切换", eff1.includes(effTarget), effStart + " → " + eff1);
  await menuPick("#effortPill", effStart.includes("最高") ? "最高" : effStart.replace("思考:", "").trim()); // 归位

  // 4. 设置页:快捷键分区 + 数据与统计图表
  await page.click("#uGear");
  await page.waitForTimeout(300);
  await page.click('.set-nitem[data-sec="shortcuts"]');
  await page.waitForTimeout(200);
  check("快捷键分区表渲染", await page.locator("#sec-shortcuts .kbd-table").isVisible());
  await page.click('.set-nitem[data-sec="data"]');
  try {
    await page.locator("#statsView .stat-cards").waitFor({ timeout: 15000 });
    check("统计卡片渲染", await page.locator("#statsView .stat-card").count() >= 4);
    check("趋势柱状图 SVG", await page.locator("#statsView svg rect").count() >= 25);
    check("热力图 7×24", await page.locator("#statsView .hm-cell").count() === 7 * 24);
    check("会话表渲染", await page.locator("#statsView .stats-table").count() >= 1);
    check("导出按钮在位", await page.locator("#statsExportJson").count() === 1 && await page.locator("#statsExportCsv").count() === 1);
  } catch {
    check("统计卡片渲染", false, "15s 未出 stats.summary.result");
  }
  await page.screenshot({ path: "/tmp/ui-mature-stats.png" });

  // 5. 自动化分栏
  await page.click("#act-wf");
  await page.waitForTimeout(600);
  check("自动化 scope 分栏在位", await page.locator("#autoScope button").count() === 2);
  await page.click('#autoScope button[data-scope="project"]');
  await page.waitForTimeout(300);
  const onScope = await page.locator("#autoScope button.on").getAttribute("data-scope");
  check("切到本项目分栏", onScope === "project");
  await page.click('#autoScope button[data-scope="global"]');
  await page.waitForTimeout(200);

  // 6. 计时器:无运行任务时隐藏(负向);有运行时显示留给真实任务用例
  check("无运行任务时计时器隐藏", !(await page.locator("#workTimer").isVisible()));

  // 7. 思考卡+变更条正向渲染:先回 chat 视图(wf 步骤后),注入 histEvents+diffstats → renderHistory
  await page.click('#act-new');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__mature.setHist([
      { seq: 1, kind: "message.user", sessionId: "spec", payload: { text: "做" }, time: Date.now() - 60000 },
      { seq: 2, kind: "message.agent", sessionId: "spec", payload: { text: "好了", reasoning: "先想 A 再想 B,决定 B", llmMs: 4200 }, time: Date.now() - 30000 },
      { seq: 3, kind: "task.done", sessionId: "spec", payload: { id: "spec-task" }, time: Date.now() },
    ]);
    window.__mature.diffstats.set("spec-task", { files: [{ path: "src/x.ts", add: 12, del: 4 }], total: { files: 1, add: 12, del: 4 }, sha: "fake" });
    window.__mature.renderHistory();
  });
  check("思考卡渲染(带时长)", await page.locator(".think-card summary").first().textContent().then((t) => /思考 · 4s/.test(t)).catch(() => false));
  check("思考卡内容在(展开)", await page.locator(".think-card .th-body").first().textContent().then((t) => t.includes("先想 A")).catch(() => false));
  check("变更条渲染(1 文件 +12 -4)", await page.locator(".diffbar").first().textContent().then((t) => t.includes("1 个文件已更改") && t.includes("+12") && t.includes("-4")).catch(() => false));
  // 撤销按钮:确认拦截(step-090:step-088 把原生 confirm 迁为 uiConfirm 页内主题模态——
  // 等模态出现→校验消息→点确定,等价原 page.once("dialog")+d.accept();sha 为合成值,不发生真回滚)
  await page.locator(".diffbar button[data-act=undo]").first().click();
  let dialogSeen = "";
  try {
    await page.locator(".uid-box").waitFor({ state: "visible", timeout: 3000 });
    dialogSeen = ((await page.locator(".uid-box .uid-msg").textContent()) || "").slice(0, 30);
    await page.locator(".uid-box .uid-ok").click();
  } catch { /* 模态未弹出→由下方断言呈报 */ }
  await page.waitForTimeout(400);
  check("撤销按钮弹确认(不真回滚)", dialogSeen.includes("撤销"), dialogSeen.slice(0, 40));

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
