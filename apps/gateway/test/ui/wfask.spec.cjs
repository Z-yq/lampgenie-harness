/** UI 经验证:F6 workflow ask 面板直答——server 端 router.ask(与 run_workflow dispatch 同一通路)→面板问题卡→作答回传。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const app = createGatewayApp({ useExternalHttp: true, executor: { kind: "noop", spawn: async () => ({ taskId: "t", cancel: async () => {}, steer: async () => true, respondPermission: async () => {} }) } });
  servePanel(7747, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7747/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));

  const answerPromise = app.workflowAskRouter.ask("wf-test", "k-chrome", "应该先跑哪个测试?");
  await page.locator(".wf-q").first().waitFor({ timeout: 5000 });
  check("面板收到 workflow 问题卡", true);
  check("问题卡显示指令文本", ((await page.locator(".wf-q .q-txt").textContent()) || "").includes("应该先跑哪个测试"));
  await page.fill(".wf-q input", "先跑 core 的配置测试");
  await page.click(".wf-q button");
  const ans = await answerPromise;
  check("面板直答回传 router", ans === "先跑 core 的配置测试", String(ans).slice(0, 30));
  check("答后问题卡消失", (await page.locator(".wf-q").count()) === 0);
  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
