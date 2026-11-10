/** UI 经验证:代码评论卡(review.findings→行级卡→点击 F4 查看器定位)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const backend = {
    kind: "rev-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "审查完成" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend });
  servePanel(7750, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7750/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));
  await page.fill("#instruction", "审查一下");
  await page.click("#go");
  await page.waitForTimeout(1200);
  const sid = await page.evaluate("currentSid");
  // 注入 findings(与 codeReviewTool 的 journal.append 同构)
  app.journal.append({
    kind: "review.findings", sessionId: sid,
    payload: { summary: "3 处发现", findings: [
      { severity: "P0", file: "apps/gateway/src/app.ts", line: 62, title: "缺空值防护", detail: "opts.x 未判空即取属性" },
      { severity: "P1", file: "packages/core/src/task/task.ts", line: 28, title: "类型偏宽", detail: "any 收敛不足" },
    ] },
  });
  await page.evaluate(() => refreshHist());
  await page.waitForTimeout(600);

  check("评论组头(2 条)", await page.locator(".rev-group .rev-head", { hasText: "2 条" }).count() === 1);
  const cards = await page.locator(".rev-card").count();
  check("两张行级卡", cards === 2, cards + " 张");
  const sev = await page.locator(".rev-card .rev-sev").first().textContent();
  check("P0 徽标红档", sev === "P0", sev);
  const loc = await page.locator(".rev-card .rev-loc").first().textContent();
  check("定位文本 file:line", loc === "apps/gateway/src/app.ts:62", loc);

  await page.locator(".rev-card").first().click();
  await page.locator("#fileViewer.on").waitFor({ timeout: 5000 });
  const p2 = await page.locator("#fvPath").textContent();
  check("点击卡→F4 查看器", (p2 || "").includes("app.ts:62"), p2);
  await page.locator("#fvBody .fv-line.hl").first().waitFor({ timeout: 5000 });
  const ln = await page.locator("#fvBody .fv-line.hl .ln").textContent();
  check("定位行高亮=62", ln === "62", ln);

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
