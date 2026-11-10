/** UI 经验证:F2 always-allow(对话框三钮/总是允许写规则/二次同类自动放行)——真实 gateway+chromium。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const fs = require("node:fs");
const path = require("node:path");
const { repoRoot } = require("../../src/repo-root.ts");

(async () => {
  // 测试隔离(P-04 环境错位):仓内真实 .genie/permissions.json 可能已有 subagent:* allow——
  // 规则咨询先于面板弹窗结算,对话框永不再现。env 空集=loadRulesHot 显式隔离语义,文件断言不受影响(写路径独立)。
  process.env.GENIE_PERMISSION_RULES = "[]";
  // checkpoint 跳过:本仓工作区脏文件多+慢盘,快照耗时会顶掉 6s 对话框超时(确定性)。
  process.env.GENIE_CHECKPOINT = "off";
  const rulesFile = path.join(repoRoot(), ".genie", "permissions.json");
  const existed = fs.existsSync(rulesFile);
  const backup = existed ? fs.readFileSync(rulesFile, "utf-8") : null;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  // 假后端:每任务发一个 permission-ask(等 respondPermission 才 result),记录决策
  const decisions = [];
  const askBackend = {
    kind: "ask-ui",
    responds: decisions,
    async spawn(spec, onEvent) {
      onEvent({ type: "permission-ask", requestId: "rq-" + spec.taskId, summary: "ui-probe-cmd --dry", risk: "low" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      onEvent({ type: "result", result: { ok: true, finalText: "ok" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async (rid, d) => decisions.push(d) };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: askBackend });
  servePanel(7744, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  try {
    await page.goto("http://127.0.0.1:7744/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await page.evaluate(() => switchView("chat"));
    await page.fill("#instruction", "需要审批的活");
    await page.click("#go");
    await page.locator("#permDialog.on").waitFor({ timeout: 6000 });
    check("审批对话框出现", true);
    check("三按钮在列", (await page.locator("#permDialog .perm-btns button").count()) === 3);
 // C9 归一后的展示口径( C):落盘规则=工具级 "*",meta 文案与实落一致展示 tool[*](摘要首词形态从未真实落盘)
    check("meta 显示将写规则(归一形态 tool[*])", ((await page.locator("#permMeta").textContent()) || "").includes("subagent[*]"));
    await page.click("#permAlways");
    // 决策链回灌走 ws+动态 import+慢盘写文件——固定 600ms 在 drvfs 上不够(P-12 族),改轮询等 decisions
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) { await new Promise((r) => setTimeout(r, 250)); settled = decisions.includes("allow-once"); }
    check("对话框关闭", !(await page.locator("#permDialog").isVisible().catch(() => false)) || !(await page.locator("#permDialog.on").count()));
    check("规则文件落盘(C9 归一为工具级)", (() => { try { const cfg = JSON.parse(fs.readFileSync(rulesFile, "utf-8")); const s = cfg.subagent; return s === "allow" || (s && typeof s === "object" && s["*"] === "allow"); } catch (e) { return false; } })());
    check("本次按 allow-once 结算", settled, "decisions=" + JSON.stringify(decisions));
    // 二次同类任务:policy 会话级代答→不再弹框(轮询窗口替代固定 1200ms)
    await page.fill("#instruction", "再来一次同类");
    await page.click("#go");
    let noDialog = false;
    for (let i = 0; i < 40 && !noDialog; i++) { await new Promise((r) => setTimeout(r, 250)); noDialog = (await page.locator("#permDialog.on").count()) === 0 && (await page.locator(".task-reply").count()) > 0; }
    check("二次任务不弹框(规则自动放行)", noDialog);
    check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } finally {
    if (backup !== null) fs.writeFileSync(rulesFile, backup);
    else if (!existed && fs.existsSync(rulesFile)) fs.rmSync(rulesFile);
    await browser.close();
    await app.close();
  }
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
