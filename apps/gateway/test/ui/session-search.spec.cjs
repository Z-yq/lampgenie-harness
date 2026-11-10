/**
 * step-115 面板会话搜索 UI 实测(真实 chromium 无头)。
 * 跑法(不碰产线 7700):cd apps/gateway && SELF_PORT=7717 npx tsx test/ui/_ui_selfhost.cjs test/ui/session-search.spec.cjs
 * 覆盖:Ctrl+K → # 域 → 结果(标题/时间/命中数/片段高亮/自动化降权徽标)→ 点进会话 → 多尺寸截图 → pageerror=0。
 */
process.env.GENIE_CHECKPOINT = "off";
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7717";
const SHOT_DIR = "/mnt/e/workship/genie/lampgenie-harness/tasks/step-115-session-search";

(async () => {
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp(含 journal)"); process.exit(1); }
  // 预置可检索历史:两个用户会话 + 一个自动化会话(降权),均含「白板」。
  app.journal.appendMany([
    { kind: "task.enqueue", sessionId: "search-a", payload: { id: "ts-a", instruction: "修复白板节点拖拽布局与 permission 冲突", state: "done" } },
    { kind: "message.user", sessionId: "search-a", payload: { text: "上次白板节点拖拽的布局修复记录 permission 冲突排查" } },
    { kind: "message.agent", sessionId: "search-a", payload: { text: "改 board-page-layout.js 的白板布局,并核对 permission-broker" } },
    { kind: "message.user", sessionId: "search-b", payload: { text: "会话全文检索验收:白板搜索入口与会话记忆" } },
    { kind: "message.agent", sessionId: "search-b", payload: { text: "session_search discover/scroll/read 三形态已实测" } },
    { kind: "automation.run", sessionId: "auto-search", payload: { automationId: "auto-1", trigger: "schedule" } },
    { kind: "message.user", sessionId: "auto-search", payload: { text: "白板 permission 自动巡检任务" } },
  ]);

  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const poll = async (fn, ms = 10000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 250)); v = await fn(); } return v; };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("面板加载+连接", (await page.locator("#conn").textContent()) === "已连接");

  await page.keyboard.press("Control+k");
  await page.waitForTimeout(200);
  check("Ctrl+K 打开命令中心", await page.locator("#cc.on").count() === 1);
  await page.fill("#cc-q", "#白板");
  const got = await poll(async () => (await page.locator("#cc-list .cc-sess").count()) >= 2);
  check("会话搜索结果出现(>=2)", got, "rows=" + (await page.locator("#cc-list .cc-sess").count()));
  const titles = await page.locator("#cc-list .cc-sess .ct").allTextContents();
  check("结果显示标题", titles.length >= 2 && titles.some((t) => t.includes("白板")), JSON.stringify(titles.slice(0, 3)));
  check("片段高亮 mark", (await page.locator("#cc-list .cc-sess mark").count()) > 0);
  check("自动化会话降权徽标", (await page.locator("#cc-list .cc-sess .cc-badge").allTextContents()).some((t) => t.includes("自动")), JSON.stringify(await page.locator("#cc-list .cc-sess .cc-badge").allTextContents()));
  const metas = await page.locator("#cc-list .cc-sess .cc-meta").allTextContents();
  check("结果带命中数/时间", metas.length >= 2 && metas.every((m) => m.includes("命中")), JSON.stringify(metas.slice(0, 3)));
  await page.screenshot({ path: SHOT_DIR + "/panel-search-1440.png" });

  await page.locator("#cc-list .cc-sess").first().click();
  const opened = await poll(async () => {
    const body = await page.locator("#chatBody").innerText().catch(() => "");
    return body.includes("白板");
  });
  check("点击结果进入会话(历史含命中词)", opened);
  check("命令中心已关闭", await page.locator("#cc.on").count() === 0);
  await page.screenshot({ path: SHOT_DIR + "/panel-opened-1440.png" });

  // 多尺寸:1024 / 760;每档重开命令中心搜索并截图。
  for (const [w, h] of [[1024, 700], [760, 600]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    await page.keyboard.press("Control+k");
    await page.fill("#cc-q", "#白板");
    await poll(async () => (await page.locator("#cc-list .cc-sess").count()) >= 1);
    await page.screenshot({ path: SHOT_DIR + `/panel-search-${w}.png` });
    check(`多尺寸 ${w}x${h} 结果可见`, (await page.locator("#cc-list .cc-sess").count()) >= 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  check("pageerror=0", errs.length === 0, JSON.stringify(errs));
  const failed = results.filter((r) => !r.ok);
  console.log("\n== UI SUMMARY ==");
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
