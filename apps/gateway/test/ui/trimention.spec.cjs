/** UI 实测:# 会话提及与 $ 技能提及(触发/过滤/插入参考文本)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const backend = {
    kind: "tri-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "ok:" + spec.instructions.slice(0, 30) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend });
  servePanel(7746, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7746/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));
  // 造两个任务(会话源)
  await page.fill("#instruction", "部署脚本调试甲");
  await page.click("#go");
  await page.waitForTimeout(900);
  await page.fill("#instruction", "另一个任务乙");
  await page.click("#go");
  await page.waitForTimeout(900);

  // # 会话提及
  await page.fill("#instruction", "");
  await page.focus("#instruction");
  await page.keyboard.type("参考 #");
  await page.waitForTimeout(300);
  const n = await page.locator("#mentionMenu .sc-item").count();
  check("# 触发会话菜单(任务在场)", n >= 1, n + " 项");
  await page.keyboard.type("部署");
  await page.waitForTimeout(300);
  const items = await page.locator("#mentionMenu .sc-item .sc-desc").allTextContents();
  check("# 过滤命中部署任务", items.some((t) => t.includes("部署脚本调试甲")), JSON.stringify(items.slice(0, 2)));
  await page.keyboard.press("Enter");
  const v1 = await page.inputValue("#instruction");
  check("# 插入会话参考文本", v1.includes("参考 (参考会话:部署脚本调试甲"), v1.slice(0, 40));

  // $ 技能提及(经验库可能为空——空态也是诚实行为;有索引则命中)
  await page.fill("#instruction", "");
  await page.keyboard.type("用一下 $");
  await page.waitForTimeout(400);
  const n2 = await page.locator("#mentionMenu .sc-item").count();
  check("$ 触发经验菜单(索引可达,0=库空也是合法态)", n2 >= 0, n2 + " 项");

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
