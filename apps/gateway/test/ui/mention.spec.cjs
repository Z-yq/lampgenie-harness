/** UI 实测:@ 文件提及(菜单触发/过滤/键盘插入)——真实 gateway+chromium。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { EchoChildBackend } = require("@lampgenie/executors");

(async () => {
  const app = createGatewayApp({ useExternalHttp: true, executor: new EchoChildBackend() });
  servePanel(7743, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7743/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));
  await page.focus("#instruction");
  await page.keyboard.type("看一下 ");
  await page.keyboard.type("@");
  await page.waitForTimeout(500);
  const n0 = await page.locator("#mentionMenu .sc-item").count();
  check("@ 触发菜单(索引非空)", n0 > 0, n0 + " 项");

  await page.keyboard.type("package");
  await page.waitForTimeout(500);
  const items = await page.locator("#mentionMenu .sc-item .sc-desc").allTextContents();
  check("@package 过滤命中 package.json", items.some((t) => t.includes("package.json")), JSON.stringify(items.slice(0, 3)));

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const v = await page.inputValue("#instruction");
  check("Enter 插入文件引用到指令", v.startsWith("看一下 ") && /\.(json|yaml|ts|md)$|^\S+\.(json|yaml|ts|md)/.test(v.trim().split(" ")[1] || ""), v.slice(0, 50));
  check("插入后菜单关闭", !(await page.locator("#mentionMenu").isVisible()));

  // Esc 关闭路径
  await page.keyboard.type("@pa");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  check("Esc 关闭菜单", !(await page.locator("#mentionMenu").isVisible()));

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
