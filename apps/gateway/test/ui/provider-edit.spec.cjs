/** Provider 卡内编辑验收(planner 板 cmp-chg-edit):默认结果态点「编辑」→ 卡内展开显示名/baseUrl →
 * 改显示名保存 → 卡片原地刷新、不回弹窗;刷新页面后配置仍在(真落库)。隔离 fixture 7791。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7791";
const EDITED = process.env.EDIT_NAME || "MockOneEdited";
(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 180)));
  const results = [];
  const check = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS" : "FAIL") + " " + n + (d ? " — " + d : "")); };
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { switchView("sys"); setSection("model"); });
  await page.waitForSelector("#prov-list .prov-card", { timeout: 12000 });
  await page.waitForTimeout(300);
  const first = page.locator("#prov-list .prov-card").first();
  const beforeUrl = await first.locator(".prov-url").textContent();
  check("结果态先见 Provider 卡", (await page.locator("#prov-list .prov-card").count()) >= 1);
  check("默认无弹窗", await page.locator("#prov-modal-mask").isHidden());
  await first.locator('[data-a="edit"]').click();
  await page.waitForTimeout(250);
  check("点编辑卡内展开", await first.locator(".pe-name").isVisible() && await first.locator(".pe-url").isVisible());
  const urlInput = await first.locator(".pe-url").inputValue();
  check("baseUrl 可编辑且回填现值", urlInput.startsWith("http"), urlInput);
  await first.locator(".pe-name").fill(EDITED);
  await first.locator('[data-a="save"]').click();
  await page.waitForFunction((name) => {
    const card = document.querySelector("#prov-list .prov-card");
    return !!card && (card.querySelector(".prov-name")?.textContent || "").trim() === name;
  }, EDITED, { timeout: 6000 }).catch(() => {});
  check("保存后卡片显示新名", ((await first.locator(".prov-name").textContent().catch(() => "")) || "").trim() === EDITED);
  check("保存后仍在结果态(不回弹窗)", await page.locator("#prov-modal-mask").isHidden());
  // 刷新验证真落库
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { switchView("sys"); setSection("model"); });
  await page.waitForSelector("#prov-list .prov-card", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500);
  const text = (await page.locator("#prov-list").textContent().catch(() => "")) || "";
  check("刷新后新名持久", text.includes(EDITED));
  check("零 pageerror", errors.length === 0, errors.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
