/**
 * 输入条四处控件前后对照截图(隔离实例:servePanel 从 src 直起,不碰 7700)。
 * 用法:node --import tsx test/ui/composer-shot.cjs <outPrefix> [port]
 * 产出:<outPrefix>-classic-dark.png / -classic-light.png / -super-dark.png / -super-light.png
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

const PREFIX = process.argv[2] || "/tmp/composer-before";
const PORT = Number(process.argv[3] || 7729);

(async () => {
  const panel = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const errors = [];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => errors.push(theme + ": " + String(e).slice(0, 120)));
    await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.evaluate((t) => {
 // 主题口径:dark=基座(去全部主题类);light=body.light(去暗色主题类)
      document.body.classList.remove("light", "theme-glass", "theme-ink", "theme-sand", "theme-olive", "theme-plum");
      if (t === "light") document.body.classList.add("light");
      switchView("chat");
    }, theme);
    await page.waitForTimeout(250);
    const cmp = page.locator("footer .composer").first();
    await cmp.screenshot({ path: PREFIX + "-classic-" + theme + ".png" });
    await page.evaluate(() => switchView("super"));
    await page.waitForTimeout(250);
    const sup = page.locator("#superComposerBox").first();
    if (await sup.count()) await sup.screenshot({ path: PREFIX + "-super-" + theme + ".png" });
    await page.close();
  }
  await browser.close();
  panel.close();
  console.log("SHOTS DONE " + PREFIX + " errors=" + errors.length + (errors.length ? " | " + errors.slice(0, 2).join(" ; ") : ""));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL " + String(e && e.message ? e.message : e).slice(0, 300));
  process.exit(1);
});
