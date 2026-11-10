/** UI 实测:F4 file:line citation(回复渲染引用/点击开查看器/定位行高亮/越界拒绝)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const WebSocket = require("ws");

(async () => {
  // 后端:echo 回执带 file:line 引用(echo 输出含指令文本→注入引用形态)
  const backend = {
    kind: "cite-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "问题在 apps/gateway/src/app.ts:62 附近,另见 packages/core/src/task/task.ts:28。" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend });
  servePanel(7745, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7745/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));
  await page.fill("#instruction", "帮我定位问题");
  await page.click("#go");
  await page.waitForTimeout(1200);

  const cites = await page.locator(".task-reply a.cite").count();
  check("回复渲染 file:line 引用(2 处)", cites === 2, cites + " 处");
  const first = page.locator(".task-reply a.cite").first();
  check("引用带数据属性", (await first.getAttribute("data-path")) === "apps/gateway/src/app.ts" && (await first.getAttribute("data-line")) === "62");

  await first.click();
  await page.locator("#fileViewer.on").waitFor({ timeout: 5000 });
  check("点击打开文件查看器", true);
  const pathTxt = await page.locator("#fvPath").textContent();
  check("查看器路径正确", (pathTxt || "").includes("apps/gateway/src/app.ts:62"), pathTxt);
  await page.locator("#fvBody .fv-line").first().waitFor({ timeout: 5000 });
  const hl = await page.locator("#fvBody .fv-line.hl").count();
  check("目标行高亮(62)", hl === 1, hl + " 行");
  const lnTxt = await page.locator("#fvBody .fv-line.hl .ln").textContent();
  check("高亮行号=62", lnTxt === "62", lnTxt);

  // 越界拒绝:直接发 file.read ../../../etc/passwd
  const ws = new WebSocket("ws://127.0.0.1:7745");
  const inbox = [];
  ws.on("message", (m) => inbox.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ v: 1, type: "file.read", path: "../../../etc/passwd" }));
  await new Promise((r) => setTimeout(r, 600));
  const fr = inbox.filter((m) => m.type === "file.read.result").at(-1);
  check("路径越界=missing(沙箱)", fr && fr.missing === true && fr.content === "");

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
