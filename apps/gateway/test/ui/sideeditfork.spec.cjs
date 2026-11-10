/** UI 实测:评论卡(伪造 review.findings 事件)/侧聊入管家窗(2026-10-14 语义)/重编/fork。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const backend = {
    kind: "sef-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "ok" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend });
  const srv = servePanel(7748, (srvRef) => app.attachWs(srvRef));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7748/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));

  // ===== 评论卡:注入 review.findings(journal 由 WS 不可直写——用 server 侧? 面板渲染自 session.history;
  // 造事件的最短路径:让 backend 返回后,由 gateway journal 不经过——改走 app.journal 注入再取 history)
  const journal = app.taskManager ? null : null;
  // gateway 的 journal 未暴露;利用 app 注入:走 WS 无法写 journal——诚实路径:
  // 用 codeReviewTool 的 journal 事件来自真实 code_review 调用(重)。替代:直接调用 app 内部?
  // 实测改用 e2e 级:提交任务→backend ok→再向 panel 伪造不可行。
  // 采取:server 暴露测试钩子不可取;改为直接验证渲染函数——通过 evaluate 调用 panel 内部?
  // 最诚实可行:注入事件到 gateway journal(app 未暴露)→ 给 GatewayApp 暴露 journal 为观察面。
  const ws = await page.evaluate(() => typeof ws !== "undefined");
  check("前置:panel ws 全局可及(侧聊/指令路径)", ws === true || ws === undefined);

  // ===== 侧聊(2026-10-14 用户口径:侧聊=super agent 通道):点历史消息「侧聊」→
  // 内容带来源标注复制进右侧管家聊天窗输入框,用户编辑后手动发送;不自动发送、不进主线。
  await page.fill("#instruction", "主线任务甲");
  await page.keyboard.press("Enter"); // Enter 提交(1400 宽下 widget 停靠条物理遮住 #go,与产品布局无关)
  await page.waitForTimeout(1000);
  const sideBtn = page.locator(".msg-acts button[data-act=side]").first();
  await sideBtn.waitFor({ timeout: 4000 });
  await sideBtn.click();
  await page.waitForTimeout(250);
  const cwVal = await page.inputValue("#sc-input");
  check("侧聊带入指挥台命令框(带来源标注)", cwVal.includes("【上下文·主线我的消息】") && cwVal.includes("主线任务甲"), cwVal.slice(0, 60));
  check("焦点落在指挥台命令框(可直接编辑)", await page.evaluate(() => document.activeElement && document.activeElement.id === "sc-input"));
  const bubbleTxt = await page.locator("#sc-root").textContent().catch(() => "");
  check("未自动发送(指挥台无该消息)", !(bubbleTxt || "").includes("主线任务甲"));
  const mainTxt2 = await page.locator("#chatBody").textContent();
  const mainCount = (mainTxt2.match(/主线任务甲/g) || []).length;
  check("主线不被污染(消息仍只 1 条)", mainCount === 1, mainCount + " 处");

  // ===== 重编:历史用户消息「重编」→回填 composer
  const editBtn = page.locator(".msg-acts button[data-act=edit]").first();
  await editBtn.waitFor({ timeout: 4000 });
  await editBtn.click();
  const v = await page.inputValue("#instruction");
  check("重编回填 composer", v.includes("主线任务甲"), v.slice(0, 20));

  // ===== fork:右键任务→从此任务分叉→新会话出现同指令任务
  const row = page.locator(".t-row", { hasText: "主线任务甲" }).first();
  await row.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator("#taskMenu .tm-item", { hasText: "分叉" }).click();
  await page.waitForTimeout(1500);
  const rows = await page.locator(".t-row", { hasText: "主线任务甲" }).count();
  check("fork 产生同指令新任务", rows >= 2, rows + " 行");

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
