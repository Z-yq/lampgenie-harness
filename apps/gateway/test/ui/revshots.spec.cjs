/** 多尺寸不破版回归(step-074 D6):1440x900 / 1280x800 / 1920x1080 / 窄窗 900x700。
 * 素材=7800 上真实持久会话(review.findings 卡+注入留痕)+持久夹具项目(回写店)。
 * 断言:评论组/注入钮/modal/店勾选件在各尺寸可见;无横向溢出;0 pageerror。截图落 tasks/step-074。 */
const { chromium } = require("playwright-core");
const { join } = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7800";
const SID = process.env.REV_SID || "web-1792122927994";
const PROJ = "/tmp/gh-revshots-fixture";
const SIZES = [
  { name: "1440x900", w: 1440, h: 900 },
  { name: "1280x800", w: 1280, h: 800 },
  { name: "1920x1080", w: 1920, h: 1080 },
  { name: "narrow-900x700", w: 900, h: 700 },
];

(async () => {
  const shotDir = join(__dirname, "../../../../tasks/step-074-review-inject-chat/shots");
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  let projAdded = false;

  for (const sz of SIZES) {
    const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
    const page = await browser.newPage({ viewport: { width: sz.w, height: sz.h } });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 120)));
    try {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.evaluate((sid) => sessionStorage.setItem("zh:sid", sid), SID);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1400);

      // 首次:添加夹具项目(注册表持久,后续尺寸复用)
      if (!projAdded) {
        await page.click("#projAddBtn");
        await page.fill("#projPathInput", PROJ);
        await page.click("#projAddGo");
        await page.locator(".proj-row", { hasText: "gh-revshots-fixture" }).first().waitFor({ timeout: 8000 });
        projAdded = true;
      }
      // 每个尺寸都激活夹具项目(store 查询按激活项目根;上个会话激活的可能是已删临时项目)
      await page.locator(".proj-row", { hasText: "gh-revshots-fixture" }).first().click();
      // 等激活生效(.proj-row.on)再进店视图——否则 review.store.get 带旧激活项目 id,店为空假超时
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll(".proj-row")];
        return rows.some((r) => r.classList.contains("on") && r.textContent.includes("gh-revshots-fixture"));
      }, undefined, { timeout: 10000 });

      // 聊天视图:评论卡组 + 注入钮 + 留痕 chip
      await page.waitForFunction(() => document.querySelectorAll(".rev-group").length >= 1, undefined, { timeout: 20000 });
      check(sz.name + " 评论卡渲染", true);
      check(sz.name + " 注入钮可见", (await page.locator(".rev-group .rev-inj").first().isVisible()) && (await page.locator(".rev-group .rev-inj-all").first().isVisible()));
      const chip = await page.locator("#chatBody").textContent();
      check(sz.name + " 注入留痕 chip", (chip || "").includes("注入") && (chip || "").includes("条评审评论"), "");
      await page.screenshot({ path: join(shotDir, "size-" + sz.name + "-chat.png") });

      // modal:单条注入弹层
      await page.locator(".rev-group .rev-inj").first().click();
      await page.locator("#revInjMask.on").waitFor({ timeout: 5000 });
      await page.screenshot({ path: join(shotDir, "size-" + sz.name + "-modal.png") });
      const maskBox = await page.locator("#revInjMask .rij-box").boundingBox();
      check(sz.name + " modal 在视口内", !!maskBox && maskBox.x >= 0 && maskBox.x + maskBox.width <= sz.w + 1, maskBox ? Math.round(maskBox.x) + "," + Math.round(maskBox.width) : "none");
      await page.click("#revInjCancel");

      // 回写店视图:勾选件+顶栏钮
      await page.click("#act-sense");
      await page.waitForFunction(() => {
        const t = document.querySelector("#revStoreBody") ? document.querySelector("#revStoreBody").textContent : "";
        return t.includes("开放");
      }, undefined, { timeout: 15000 });
      check(sz.name + " 店勾选件×3+单条钮×3", (await page.locator("#revStoreBody .rev-sel").count()) === 3 && (await page.locator("#revStoreBody .rev-inj-store").count()) === 3);
      await page.screenshot({ path: join(shotDir, "size-" + sz.name + "-store.png") });

      // 横向溢出检查
      const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
      check(sz.name + " 无横向溢出", overflow <= 1, "overflow=" + overflow);
      check(sz.name + " 0 pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
    } catch (e) {
      check(sz.name + " 流程", false, String(e).slice(0, 150));
      await page.screenshot({ path: join(shotDir, "size-" + sz.name + "-error.png") }).catch(() => {});
    }
    await browser.close();
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})();
