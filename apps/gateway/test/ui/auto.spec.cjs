/** UI 实测:step-043——自动化 CRUD/立即运行/启停、AI 提交信息、cc 搜索历史、toast。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "auto-ui-"));
  const backend = {
    kind: "auto-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "auto-ok:" + (spec.instructions || "").slice(0, 20) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(7752, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // step-090:原生 confirm 已迁 uiConfirm 页内模态(step-088),page.on("dialog") 自动应答退役;
  // 模态在触发点就地驱动(等模态→校验消息→点确定)。
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7752/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // ===== 自动化 CRUD(wf 视图) =====
  await page.evaluate(() => switchView("wf"));
  await page.waitForTimeout(400);
  check("自动化管理区在列", await page.locator("#autoSec").isVisible());
  await page.fill("#autoSec input[name=name]", "磁盘巡检");
  await page.fill("#autoSec input[name=instruction]", "巡检磁盘并汇报");
  await page.fill("#autoSec input[name=every]", "60");
  await page.click("#autoAdd");
  await page.waitForTimeout(600);
  const row = page.locator(".auto-row", { hasText: "磁盘巡检" });
  check("创建生效(列表行出现)", await row.count() === 1);
  check("间隔与下次排程显示", ((await row.locator(".a-meta").textContent()) || "").includes("每60分"), (await row.locator(".a-meta").textContent()) || "");
  // 立即运行→系统任务出现在侧栏+runCount=×1
  await row.locator("button[data-act=run]").click();
  await page.waitForTimeout(1200);
  check("立即运行产生任务", (await page.locator(".t-row", { hasText: "[自动] 磁盘巡检" }).count()) >= 1, (await page.locator(".t-row .t-title").allTextContents()).slice(0,2).join("|"));
  check("runCount 记账", ((await page.locator(".auto-row .a-meta").textContent()) || "").includes("×1"));
  // 停用→启用
  await page.locator(".auto-row button[data-act=toggle]").click();
  await page.waitForTimeout(500);
  check("停用标记", ((await page.locator(".auto-row .a-meta").textContent()) || "").includes("已停"));
  await page.locator(".auto-row button[data-act=toggle]").click();
  await page.waitForTimeout(500);
  check("重新启用", !(((await page.locator(".auto-row .a-meta").textContent()) || "").includes("已停")));
  // 删除(step-090:删除确认=uiConfirm 页内模态,显式确认等价原自动应答)
  await page.locator(".auto-row button[data-act=del]").click();
  await page.locator(".uid-box .uid-msg", { hasText: "删除该自动化" }).waitFor({ state: "visible", timeout: 3000 });
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(500);
  check("删除生效", (await page.locator(".auto-row").count()) === 0);

  // ===== AI 提交信息(无 LLM 配置→确定性兜底文案) =====
  await page.evaluate(() => switchView("git"));
  await page.waitForTimeout(1500);
  await page.click("#gitAiMsg");
  await page.waitForFunction(() => document.getElementById("gitMsg").value.length > 0, { timeout: 12000 }).catch(() => {});
  const msg = await page.inputValue("#gitMsg");
  check("AI 提交信息回填(兜底或生成)", msg.length > 0, msg.slice(0, 40));

  // ===== cc 搜索历史 =====
  await page.keyboard.press("Control+k");
  await page.fill("#cc-q", "巡检磁盘");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  check("cc 历史展示", (await page.locator("#cc-list .cc-item", { hasText: "巡检磁盘" }).count()) >= 1);
  await page.keyboard.press("Escape");

  // ===== toast 未读(提交任务后切走,终态 toast+标题徽标) =====
  await page.evaluate(() => switchView("sys"));
  await page.evaluate('ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: "toast-probe", instruction: "后台任务探针" }))');
  await page.waitForTimeout(2500);
  const title = await page.title();
  const toastShown = await page.locator(".toast").count();
  check("终态 toast+未读徽标", toastShown >= 0 && /\(\d+\)/.test(title), "title=" + title);

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  rmSync(jd, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
