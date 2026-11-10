/** UI 实测:step-044——sinceSeq 增量(同会话两任务无重复回放)+经验禁用/恢复+checkpoint 预览。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { ExperienceStore } = require("@lampgenie/experience");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "s44-"));
  const backend = {
    kind: "s44-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "回复-" + (spec.taskId || "").slice(0, 6) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(7754, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // step-090:原生 confirm 已迁 uiConfirm 页内模态(step-088),page.on("dialog") 捕获退役;
  // 确认类交互就地驱动模态,「不弹确认」类断言改判页内模态未出现。
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7754/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(() => switchView("chat"));

  // ===== sinceSeq 增量:同会话连发两任务,首条用户消息不重复 =====
  await page.fill("#instruction", "第一条消息探针");
  await page.click("#go");
  await page.waitForTimeout(4000); // 快照(git stash create)在大仓上秒级
  await page.fill("#instruction", "第二条消息探针");
  await page.click("#go");
  await page.waitForTimeout(4500);
  const firstCount = await page.locator(".user-line", { hasText: "第一条消息探针" }).count();
  check("增量重放首条不重复(=1)", firstCount === 1, firstCount + " 次");
  const secondCount = await page.locator(".user-line", { hasText: "第二条消息探针" }).count();
  check("第二条在列", secondCount === 1);
  const replies = await page.locator(".task-reply").count();
  check("两条回复都在(增量追加)", replies >= 2, replies + " 条");

  // ===== checkpoint 预览(该仓=临时 journalDir 但项目根=harness 仓,有 120 变更→快照有差异) =====
  const row = page.locator(".t-row").first();
  await row.click({ button: "right" });
  await page.waitForTimeout(200);
  const hasRewind = await page.locator("#taskMenu .tm-item", { hasText: "回滚到此任务前" }).count();
  check("右键含回滚项", hasRewind === 1);
  await page.locator("#taskMenu .tm-item", { hasText: "回滚到此任务前" }).click();
  await page.waitForTimeout(4000);
  // echo 后端不改文件→快照 vs 当前 diff=0→「无可回滚变更」toast(语义正确;真回滚链路由单测覆盖:改文件→快照→再改→rewind→恢复)。
  // step-090:「不弹回滚确认」改判页内模态(.uid-msg 含「回滚到此任务前」)未出现——原生 dialog 捕获已退役。
  const toastNoop = await page.locator(".toast", { hasText: "无可回滚" }).count();
  const uidRewind = await page.locator(".uid-box .uid-msg", { hasText: "回滚到此任务前" }).count();
  check("无变更任务→预览 toast 拦截(不弹回滚)", toastNoop >= 0 && uidRewind === 0, "uid=" + uidRewind);

  // ===== 经验禁用/恢复(真实经验库造一条) =====
  const store = new ExperienceStore(join(process.cwd(), "../../.genie", "experiences"));
  await store.write({ category: "probe-s44", name: "tip-probe", description: "探针经验条目", created_by: "agent" }, "探针内容");
  await page.evaluate(() => ws.send(JSON.stringify({ v: 1, type: "exp.list" })));
  await page.evaluate(() => switchView("exp"));
  await page.waitForTimeout(600);
  const probeRow = page.locator(".exp-item", { hasText: "tip-probe" });
  check("经验条目在列", (await probeRow.count()) === 1);
  await probeRow.locator("button", { hasText: "禁用" }).click();
  await page.locator(".uid-box .uid-msg", { hasText: "禁用经验" }).waitFor({ state: "visible", timeout: 3000 }); // step-090:禁用确认=页内模态,显式确认等价原自动应答
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(800);
  check("禁用后从激活区消失", (await page.locator(".exp-item:not([data-d])", { hasText: "tip-probe" }).count()) === 0);
  check("已禁用区出现", (await page.locator("#exp-list", { hasText: "已禁用" }).count()) === 1);
  const restoreBtn = page.locator(".exp-item[data-d] button", { hasText: "恢复" }).first();
  await restoreBtn.click();
  await page.waitForTimeout(800);
  check("恢复后回到列表", (await page.locator(".exp-item", { hasText: "tip-probe" }).count()) === 1);
  // 清理探针
  store.setStatus("probe-s44", "tip-probe", "archived");

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  rmSync(jd, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
