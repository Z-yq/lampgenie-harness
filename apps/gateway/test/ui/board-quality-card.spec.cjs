/**
 * bq4(板质量遥测闭环)UI 经验证:任务结算卡的「规划质量」行——真实 chromium 无头。
 * 层级=浏览器 DOM 经验证(非源级断言):servePanel 独立 7716(无 WS 后端),经 window.__mature
 * 测试钩子注入带/不带 planQuality 的假 task + 假 task.done 事件,断言结算卡 DOM 出/不出「规划质量」行。
 * WebSocket 连接失败重试是环境产物,不计入错误;wsSafeSend 对无 WS 环境安全(排队/丢弃)。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const panel = servePanel(7716, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  // WebSocket 连接失败重试是环境产物(本 spec 无 WS 后端);面板引用的静态资产缺席产生的 404
  // ("Failed to load resource")与本卡渲染无关——同样不计,但记入 res404 供排障;页面 JS 错误(pageerror)仍严格。
  const res404 = [];
  page.on("response", (r) => { if (r.status() >= 400) res404.push(r.status() + " " + r.url().slice(0, 90)); });
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Failed to load resource")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7716/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);

  // 场景 A:task 带 planQuality(含 skeleton)→ 结算卡出「规划质量」行,五段指标齐
  const setup = (task) => page.evaluate((t) => {
    const sid = "bq4-spec-sid";
    window.__mature.tasks.set(t.id, Object.assign({ sessionId: sid, state: "done", instruction: "bq4 spec", result: "ok", updatedAt: Date.now(), startedAt: Date.now() - 5000 }, t));
    // 顺序:openSession 会把 histEvents 置 null 等 WS 重放(无后端→永挂「读取会话…」),
    // 故先开会话(置 currentSid),再注入假事件并渲染。
    window.__mature.openSession(sid);
    window.__mature.setHist([
      { kind: "message.user", payload: { text: "bq4 用例" } },
      { kind: "task.done", payload: { id: t.id, result: "ok" } },
    ]);
    window.__mature.renderHistory();
  }, task);

  await setup({
    id: "bq4-task-pq",
    planQuality: { boardType: "code", nodes: 24, contentNodes: 18, p0: { passed: 3, total: 4, rate: 0.75 }, anchorDensity: 0.667, skeleton: { generated: 12, survived: 9, adoptionRate: 0.75 } },
  });
  await page.waitForTimeout(300);
  let chip = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#chatBody .task-sub")];
    const row = rows.find((r) => r.textContent.includes("规划质量"));
    return row ? row.textContent.replace(/\s+/g, "") : "";
  });
  check("A1 带 planQuality → 结算卡出「规划质量」行", chip.includes("规划质量"), chip.slice(0, 80));
  check("A2 板型 code", chip.includes("code"), chip.slice(0, 80));
  check("A3 内容节点 18/24", /内容18\/24/.test(chip), chip.slice(0, 120));
  check("A4 P0 覆盖 3/4·75%", /P03\/4·75%/.test(chip), chip.slice(0, 140));
  check("A5 锚密度 67%", /锚67%/.test(chip), chip.slice(0, 140));
  check("A6 骨架采纳 75%", /骨架采纳75%/.test(chip), chip.slice(0, 140));

  // 场景 B:旧任务(无 planQuality 字段)→ 整行不渲染
  await setup({ id: "bq4-task-old" });
  await page.waitForTimeout(300);
  const oldTxt = await page.evaluate(() => [...document.querySelectorAll("#chatBody .task-sub")].map((r) => r.textContent).join("|"));
  check("B1 无 planQuality → 不出「规划质量」行", !oldTxt.includes("规划质量"), oldTxt.replace(/\s+/g, "").slice(0, 60));
  check("B2 结算卡本体仍在(完成行)", oldTxt.includes("完成"), oldTxt.slice(0, 40));

  // 场景 C:字段残缺(NaN/缺失)→ 数值降级 "-",整行仍渲染(不炸)
  await setup({ id: "bq4-task-bad", planQuality: { boardType: null, nodes: NaN, contentNodes: NaN, p0: { passed: NaN, total: NaN, rate: NaN }, anchorDensity: NaN } });
  await page.waitForTimeout(300);
  const bad = await page.evaluate(() => {
    const row = [...document.querySelectorAll("#chatBody .task-sub")].find((r) => r.textContent.includes("规划质量"));
    return row ? row.textContent.replace(/\s+/g, "") : "";
  });
  check("C1 字段 NaN → 行仍渲染", bad.includes("规划质量"), bad.slice(0, 60));
  check("C2 NaN/缺失数值降级为短横线", (bad.match(/-/g) || []).length >= 4 && !bad.includes("NaN"), bad.slice(0, 120));
  check("C3 无 skeleton → 不出骨架采纳段", !bad.includes("骨架采纳"), bad.slice(0, 120));

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") + (res404.length ? " | (静态资产 404 已忽略: " + res404.slice(0, 2).join(";") + ")" : ""));
  await page.screenshot({ path: "/tmp/ui-bq4.png" });
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
})();
