/** UI 经验证:F3 任务行操作(右键菜单/重命名/置顶/归档)——真实 gateway+chromium。
 * 现代化(三处陈旧前提,意图全保):
 * ① 起侧栏「会话唯一聚合」(一栏=一个 session,标题取最新任务,panel.ts renderSidebar
 *   注释在案)——同会话两任务只渲染一行,本 spec 改为两任务分两会话(#act-new),各行独立可操作;
 * ② 起 confirm/prompt 全部主题模态化(uiConfirm/uiPrompt),page.on("dialog") 永远接不到
 *   ——改接 .uid-mask 内 .uid-input/.uid-ok;
 * ③ 终态等待从「#go 按钮文案」升级为 tasks map 状态谓词——按钮初始态即「发」,waitForFunction
 * 在任务注册前就空过( probe-rowops2 验证),真终态依赖=task.changed→tasks map。 */
process.env.GENIE_CHECKPOINT = process.env.GENIE_CHECKPOINT || "off"; // 与 _restore_server 同款:行操作不测 checkpoint,防大仓 stash create 拖慢任务流(登记)
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { EchoChildBackend } = require("@lampgenie/executors");

const PORT = Number(process.env.SELF_PORT || 7742);

(async () => {
  const app = createGatewayApp({ useExternalHttp: true, executor: new EchoChildBackend() });
  servePanel(PORT, (srv) => app.attachWs(srv));
 // 就绪轮询(dev 条件下 src 整图编译冷启动可达数十秒,固定 400ms 会导航超时——审计 R2 验证)
  {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try { const r = await fetch("http://127.0.0.1:" + PORT + "/"); ready = r.ok; } catch { /* 未就绪 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) { console.error("网关 60s 未就绪"); process.exit(2); }
  }
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  const RUN = "r" + Date.now().toString(36).slice(-5);
  page.on("dialog", (d) => d.dismiss().catch(() => {})); // 安全网:088 后不应再有原生弹窗;防意外挂起
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));

  // 终态谓词:tasks map 内该指令的任务到 done/failed(终态依赖的直接语义,不经按钮文案中转)
  const waitTaskDone = (name, ms = 30_000) => page.waitForFunction(
    (n) => { try { return [...tasks.values()].some((t) => (t.instruction || "").indexOf(n) >= 0 && (t.state === "done" || t.state === "failed")); } catch (e) { return false; } },
    name, { timeout: ms, polling: 300 },
  );
  const submitTask = async (name) => {
    await page.fill("#instruction", name);
    await page.click("#go");
    await waitTaskDone(name);
    await page.waitForTimeout(300); // 渲染落定(renderSidebar 由 task.changed 驱动,终态广播后即渲)
  };

 // 两个任务分两个会话(会话聚合前提:同会话只一行)
  const NAME1 = "第一个任务甲" + RUN;
  const NAME2 = "第二个任务乙" + RUN;
  await submitTask(NAME1);
  await page.click("#act-new"); // 新会话
  await page.waitForTimeout(400);
  await submitTask(NAME2);

  const row = page.locator(".t-row", { hasText: NAME1 }).first();
  check("任务行在列(会话甲)", await row.count() >= 1);
  check("任务行在列(会话乙)", await page.locator(".t-row", { hasText: NAME2 }).count() >= 1);

  // 右键菜单出现
  await row.click({ button: "right" });
  await page.waitForTimeout(250);
  check("右键菜单出现", await page.locator("#taskMenu").isVisible());
 // 菜单七项( F3 增「移入分组…」):计数+关键项双断言(纯计数会随功能演进陈旧)
  {
    const menuCount = await page.locator("#taskMenu .tm-item").count();
    const hasGroup = await page.locator("#taskMenu .tm-item", { hasText: "移入分组" }).count();
    check("菜单含七项(重命名/置顶/分组/归档/分叉/删除/回滚)", menuCount === 7 && hasGroup === 1, "count=" + menuCount);
  }

  // 重命名(uiPrompt 主题模态:填 .uid-input 点 .uid-ok;088 后原生 prompt 不存在)
  await page.locator("#taskMenu .tm-item", { hasText: "重命名" }).click();
  await page.locator(".uid-mask .uid-input").waitFor({ timeout: 5000 });
  await page.fill(".uid-mask .uid-input", "新标题甲" + RUN);
  await page.locator(".uid-mask .uid-ok").click();
  await page.waitForTimeout(700);
  check("重命名生效(行显示新标题)", await page.locator(".t-row", { hasText: "新标题甲" + RUN }).count() >= 1);

  // 置顶:右键第二个任务→置顶→置顶区出现
  const row2 = page.locator(".t-row", { hasText: NAME2 }).first();
  await row2.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator("#taskMenu .tm-item", { hasText: "置顶" }).click();
  await page.waitForTimeout(700);
  check("置顶区出现(顶字徽标)", await page.locator(".t-bucket", { hasText: "置顶" }).count() >= 1);
  check("置顶行入区", await page.locator(".t-row", { hasText: NAME2 }).count() >= 1);

  // 归档:右键"新标题甲"→归档→默认列表消失
  const rowR = page.locator(".t-row", { hasText: "新标题甲" + RUN }).first();
  await rowR.click({ button: "right" });
  await page.waitForTimeout(200);
  await page.locator("#taskMenu .tm-item", { hasText: "归档" }).first().click();
  await page.waitForTimeout(700);
  check("归档后默认列表隐藏", (await page.locator(".t-row", { hasText: "新标题甲" + RUN }).count()) === 0);

  // 归档视图:切"归档"→只在归档里
  await page.click("#tt-arch");
  await page.waitForTimeout(400);
  check("归档视图显示归档任务", await page.locator(".t-row", { hasText: "新标题甲" + RUN }).count() >= 1);
  check("归档视图不含未归档", (await page.locator(".t-row", { hasText: NAME2 }).count()) === 0);
  await page.click("#tt-arch");
  await page.waitForTimeout(300);

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
