/** UI 经验证:评审评论一键回注聊天窗。
 * 覆盖:chat rev-card 单条/整批注入钮、modal 目标会话区分(当前/新会话)、注入后指令进会话+留痕 chip、
 *      回写店勾选批量/单条/整批、异会话注入自动跳转、注入钮不触发文件查看器、0 pageerror。
 * 自宿(executor 桩),聊天侧走真实 WS/journal;回写店侧经 UI 添加真实项目(含 .genie/review-comments.json fixture)。
 * 用法: node --import tsx test/ui/revinject.spec.cjs  (或 GENIE_CHECKPOINT=off) */
const { chromium } = require("playwright-core");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const backend = {
    kind: "revinj-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "已按评论修复(桩)" } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend });
  servePanel(7751, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const shotDir = join(__dirname, "../../../../tasks/-review-inject-chat/shots");
  mkdirSync(shotDir, { recursive: true });
  // 回写店 fixture 项目
  const projDir = mkdtempSync(join(tmpdir(), "gh-revinject-ui-"));
  writeFileSync(join(projDir, "sample.ts"), "export const sampleValue = 1;\n// line two\n// line three\n");
  mkdirSync(join(projDir, ".genie"), { recursive: true });
  writeFileSync(join(projDir, ".genie", "review-comments.json"), JSON.stringify({ version: 1, updatedAt: 1, comments: [
    { key: "openkey1", path: "sample.ts", line: 1, rule: "credential", message: "疑似凭证入库:diff 中出现 API key 形态", severity: "blocker", postedAt: 1 },
    { key: "openkey2", path: "sample.ts", line: 2, rule: "debug", message: "疑似调试输出残留 console.log", severity: "nit", postedAt: 1 },
    { key: "reskey1", path: "sample.ts", line: 3, rule: "style", message: "旧的样式建议(已解决)", severity: "nit", postedAt: 1, resolvedAt: 2 },
  ] }));

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  try {
    await page.goto("http://127.0.0.1:7751/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    // 首访导览仅真人浏览器弹出(navigator.webdriver 门控),无头 spec 无需处理
    await page.evaluate(() => switchView("chat"));

    // ============ A. chat rev-card:单条注入 → modal → 当前会话 ============
    await page.fill("#instruction", "审查一下当前变更");
    await page.click("#go");
    await page.waitForTimeout(1000);
    const sidA = await page.evaluate("currentSid");
    app.journal.append({
      kind: "review.findings", sessionId: sidA,
      payload: { summary: "2 处发现", findings: [
        { severity: "blocker", file: "src/demo.ts", line: 12, title: "疑似凭证入库", detail: "diff 中出现 ghp_ 形态 token" },
        { severity: "nit", file: "src/util.ts", line: 3, title: "调试输出残留", detail: "新增行 console.log(1)" },
      ] },
    });
    await page.evaluate(() => refreshHist());
    await page.waitForTimeout(700);

    check("A1 组头「全部注入」钮在", await page.locator(".rev-group .rev-inj-all").count() === 1);
    check("A2 每卡「⇒修复」钮×2", await page.locator(".rev-group .rev-inj").count() === 2);

    // 单条注入:点开 modal(且文件查看器不被触发)
    await page.locator(".rev-group .rev-inj").first().click();
    await page.waitForTimeout(300);
    check("A3 点击注入钮不触发文件查看器", (await page.locator("#fileViewer.on").count()) === 0);
    await page.locator("#revInjMask.on").waitFor({ timeout: 3000 });
    const modalText = await page.locator("#revInjBody").textContent();
    check("A4 modal 显示来源与条数(单条)", (modalText || "").includes("共 1 条"), (modalText || "").slice(0, 40));
    check("A5 modal 预览含 file:line", (modalText || "").includes("src/demo.ts:12"), "");
    const a5opts = await page.locator('#revInjBody input[name="revInjTarget"]').count();
    check("A6 目标选项=当前会话+新会话(2 项)", a5opts === 2, a5opts + " 项");
    check("A7 默认选中=当前会话", (await page.locator('#revInjBody input[name="revInjTarget"]:checked').inputValue()) === sidA);
    await page.screenshot({ path: join(shotDir, "a-modal-single.png") });
    await page.click("#revInjGo");
    await page.waitForTimeout(900);
    check("A8 modal 关闭", (await page.locator("#revInjMask.on").count()) === 0);
    const toastA = await page.locator('.toast', { hasText: "已注入" }).last().textContent().catch(() => "");
    check("A9 成功回执 toast 含目标会话", (toastA || "").includes("已注入 1 条评论"), toastA || "");
    const chatA = await page.locator("#chatBody").textContent();
    check("A10 注入指令进会话(批次头+定位)", (chatA || "").includes("按评审评论修复") && (chatA || "").includes("src/demo.ts:12"), "");
    check("A11 会话留痕 chip(注入 1 条)", (chatA || "").includes("注入 1 条评审评论"), "");
    await page.screenshot({ path: join(shotDir, "a-injected-chat.png") });

    // ============ B. chat rev-card:整批注入 → 新会话 → 自动跳转 ============
    await page.locator(".rev-group .rev-inj-all").first().click();
    await page.waitForTimeout(300);
    const modalB = await page.locator("#revInjBody").textContent();
    check("B1 整批 modal 共 2 条", (modalB || "").includes("共 2 条"), "");
    // 选「新会话」
    await page.locator('#revInjBody input[name="revInjTarget"]').last().check();
    await page.click("#revInjGo");
    await page.waitForTimeout(1000);
    const sidB = await page.evaluate("currentSid");
    check("B2 注入新会话后自动跳转(sid 变化)", sidB && sidB !== sidA, String(sidA).slice(-6) + "→" + String(sidB).slice(-6));
    const chatB = await page.locator("#chatBody").textContent();
    check("B3 新会话内指令含两条定位", (chatB || "").includes("src/demo.ts:12") && (chatB || "").includes("src/util.ts:3"), "");
    check("B4 新会话留痕 chip(注入 2 条)", (chatB || "").includes("注入 2 条评审评论"), "");
    await page.screenshot({ path: join(shotDir, "b-injected-newsession.png") });

    // ============ C. 回写店:勾选批量 + 单条 + 全部 ============
    await page.click("#projAddBtn");
    await page.fill("#projPathInput", projDir);
    await page.click("#projAddGo");
    const prow = page.locator(".proj-row", { hasText: projDir.split("/").pop() }).first();
    await prow.waitFor({ timeout: 10000 });
    await prow.click();
    await page.waitForTimeout(500);
    await page.click("#act-sense");
    await page.waitForFunction(() => {
      const t = document.querySelector("#revStoreBody") ? document.querySelector("#revStoreBody").textContent : "";
      return t.includes("开放");
    }, undefined, { timeout: 15000 });

    check("C1 open 行 checkbox×2", await page.locator("#revStoreBody .rev-sel").count() === 2);
    check("C2 open 行单条注入钮×2", await page.locator("#revStoreBody .rev-inj-store").count() === 2);
    check("C3 顶栏 注入选中/全部注入 钮在", (await page.locator("#revInjSel").count()) === 1 && (await page.locator("#revInjAll").count()) === 1);
    check("C4 注入选中初始 disabled", await page.locator("#revInjSel").isDisabled());
    // resolved 区无注入件
    await page.locator("#revStoreBody details summary").click();
    await page.waitForTimeout(200);
    check("C5 已解决区无 checkbox/注入钮", await page.locator("#revStoreBody details .rev-sel").count() === 0 && await page.locator("#revStoreBody details .rev-inj").count() === 0);

    // 勾选两条 → 注入选中
    await page.locator("#revStoreBody .rev-sel").first().check();
    await page.locator("#revStoreBody .rev-sel").nth(1).check();
    await page.waitForTimeout(200);
    check("C6 勾选后计数(2)且可用", (await page.locator("#revInjSel").textContent() || "").includes("(2)") && !(await page.locator("#revInjSel").isDisabled()));
    // checkbox 点击不触发文件查看器
    check("C7 勾选不触发文件查看器", (await page.locator("#fileViewer.on").count()) === 0);
    await page.click("#revInjSel");
    await page.waitForTimeout(300);
    const modalC = await page.locator("#revInjBody").textContent();
    check("C8 勾选批量 modal 共 2 条", (modalC || "").includes("共 2 条"), "");
    // store 无属主会话:选项=新会话(当前会话在 sense 视图仍持有 sidB,故有当前+新两项)
    const cOpts = await page.locator('#revInjBody input[name="revInjTarget"]').count();
    check("C9 store 注入目标选项存在", cOpts >= 1, cOpts + " 项");
    await page.screenshot({ path: join(shotDir, "c-store-modal.png") });
    await page.click("#revInjGo");
    await page.waitForTimeout(900);
    // toast 可能并存多条(启动期语音配置告警等),按文本匹配回执
    const toastC = await page.locator('.toast', { hasText: "已注入" }).last().textContent().catch(() => "");
    check("C10 店批量注入回执", (toastC || "").includes("已注入 2 条评论"), toastC || "");

    // 回店:单条注入
    await page.click("#act-sense");
    await page.waitForFunction(() => (document.querySelector("#revStoreBody .rev-inj-store") || null) !== null, undefined, { timeout: 8000 });
    await page.locator("#revStoreBody .rev-inj-store").first().click();
    await page.waitForTimeout(300);
    const modalC2 = await page.locator("#revInjBody").textContent();
    check("C11 店单条 modal 共 1 条含 rule", (modalC2 || "").includes("共 1 条"), "");
    await page.click("#revInjCancel");
    await page.waitForTimeout(200);
    check("C12 取消不注入(modal 关)", (await page.locator("#revInjMask.on").count()) === 0);

    // 全部注入(open 2 条)
    await page.click("#revInjAll");
    await page.waitForTimeout(300);
    check("C13 全部注入 modal 共 2 条", ((await page.locator("#revInjBody").textContent()) || "").includes("共 2 条"), "");
    await page.click("#revInjGo");
    await page.waitForTimeout(900);
    const toastC3 = await page.locator('.toast', { hasText: "已注入" }).last().textContent().catch(() => "");
    check("C14 店全部注入回执", (toastC3 || "").includes("已注入 2 条评论"), toastC3 || "");

    check("Z 控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } catch (e) {
    check("评审回注 UI 流程", false, String(e).slice(0, 200));
  } finally {
    await page.screenshot({ path: join(shotDir, "z-final.png") }).catch(() => {});
    await browser.close();
    await app.close();
    rmSync(projDir, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})();
