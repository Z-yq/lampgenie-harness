/** UI 经验证: 缺口批(删除/清归档/短标题/cc 三 scope/划词/保会话)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");

(async () => {
 // journalDir 指临时目录,避免污染生产环境 journal
  const jd = mkdtempSync(join(tmpdir(), "-"));
  function join(a, b) { return a + "/" + b; }
  const backend = {
    kind: "-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "ok" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(7751, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
 // 原生 confirm 已迁 uiConfirm 页内模态,page.on("dialog") 自动应答退役;
  // 删除任务/清空归档两处确认在触发点就地驱动模态。
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7751/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));

  // 短标题派生:多行长指令 → 行显示首行截断
  await page.fill("#instruction", "这是一条非常长的多行指令第一行标题部分\n第二行详细内容");
  await page.click("#go");
  await page.waitForTimeout(1000);
  const row = page.locator(".t-row .t-title").first();
  const t1 = await row.textContent();
  check("短标题派生(多行→首行)", (t1 || "").includes("第一行标题部分") && !(t1 || "").includes("第二行"), (t1 || "").slice(0, 30));

  // 删除:右键→删除任务→行消失
  const before = await page.locator("#taskList .t-row").count();
  await row.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator("#taskMenu .tm-item", { hasText: "删除任务" }).click();
  await page.locator(".uid-box .uid-msg", { hasText: "彻底删除任务" }).waitFor({ state: "visible", timeout: 3000 }); // 页内模态确认
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(500);
  const after = await page.locator("#taskList .t-row").count();
  check("删除任务(行消失)", after === before - 1, before + "→" + after);

  // 归档+清空归档
  await page.fill("#instruction", "将被归档的任务");
  await page.click("#go");
  await page.waitForTimeout(900);
  const r2 = page.locator(".t-row", { hasText: "将被归档的任务" }).first();
  await r2.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator("#taskMenu .tm-item", { hasText: "归档" }).first().click();
  await page.waitForTimeout(500);
  await page.click("#tt-arch");
  await page.waitForTimeout(300);
  check("归档视图含清空钮", (await page.locator("#archClear").count()) === 1);
  await page.click("#archClear");
  await page.locator(".uid-box .uid-msg", { hasText: "清空全部" }).waitFor({ state: "visible", timeout: 3000 }); // 页内模态确认
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(900);
  const rowsAfterClear = await page.locator("#taskList .t-row").allTextContents();
  check("清空归档(归档视图空)", rowsAfterClear.length === 0, JSON.stringify(rowsAfterClear).slice(0, 60));
  await page.click("#tt-arch");

  // cc 三 scope
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await page.fill("#cc-q", ">");
  await page.waitForTimeout(300);
  const cmdCount = await page.locator("#cc-list .cc-item").count();
  check("cc >命令域", cmdCount >= 5, cmdCount + " 条");
  await page.fill("#cc-q", "@package");
  await page.waitForTimeout(700);
  const fileCount = await page.locator("#cc-list .cc-item").count();
  check("cc @文件域", fileCount >= 1, fileCount + " 条");
  await page.fill("#cc-q", "");
  await page.waitForTimeout(300);
  const ccLeft = await page.locator("#cc-list .cc-item").allTextContents();
  check("cc 默认任务域(列表与清空后一致)", ccLeft.length === rowsAfterClear.length, JSON.stringify(ccLeft).slice(0, 60));
  await page.keyboard.press("Escape");

  // 保会话:开一个会话→reload→仍选中
  await page.fill("#instruction", "保会话验证任务");
  await page.click("#go");
  await page.waitForTimeout(900);
  await page.locator(".t-row", { hasText: "保会话验证任务" }).first().click();
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const sidRestored = await page.evaluate("sessionStorage.getItem('zh:sid') !== null");
  const chatVisible = await page.locator("#chatBody").isVisible().catch(() => false);
  check("重载恢复选中会话", sidRestored && chatVisible, "sid=" + sidRestored + " view=" + (await page.evaluate("document.body.dataset.view")));

  // 划词菜单
  await page.evaluate(() => switchView("chat"));
  const span = page.locator(".user-line .txt").last();
  await span.waitFor({ timeout: 4000 });
  const bb = await span.boundingBox();
  if (bb) {
    await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width * 0.9, bb.y + bb.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const selVis = await page.locator("#selMenu").isVisible().catch(() => false);
    check("划词菜单出现", selVis);
    if (selVis) {
      await page.locator("#selQuote").click();
      const v = await page.inputValue("#instruction");
      check("引用入输入框", (v || "").length > 0, (v || "").slice(0, 20));
    }
  } else check("划词菜单出现", false, "无消息行");

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  rmSync(jd, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
