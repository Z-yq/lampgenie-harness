/** 模型管理页只读态(UI 板五态之一):panelReadOnly=true → 控件禁用 + 服务端 cfg.set 硬拒。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7792";
(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  const results = [];
  const check = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS" : "FAIL") + " " + n + (d ? " — " + d : "")); };
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { switchView("sys"); setSection("model"); });
  await page.waitForTimeout(700);
  const status = (await page.locator("#msw-status").textContent().catch(() => "")) || "";
  check("只读状态行提示", status.includes("配置只读"), status.trim());
  check("下拉禁用", await page.locator("#msw-select").isDisabled());
  check("确认按钮禁用", await page.locator("#msw-confirm").isDisabled());
  check("Provider 添加入口禁用", await page.locator("#prov-add").isDisabled());
  check("Provider 弹窗入口禁用", await page.locator("#prov-add-open").isDisabled());
  // 只读点弹窗入口不应打开过程 UI(disabled 按钮不触发;DOM click 验证无副作用)
  await page.evaluate(() => { const b = document.querySelector("#prov-add-open"); if (b) b.click(); });
  await page.waitForTimeout(200);
  check("只读点添加不弹窗", await page.locator("#prov-modal-mask").isHidden());
  check("服务商预设卡置灰", (await page.locator("#sec-model").getAttribute("class") || "").includes("cfg-readonly"));
  const p3 = await page.evaluate(() => new Promise((resolve) => {
    const h = (ev) => { try { const m = JSON.parse(ev.data); if (m && m.type === "error" && /cfg-set-failed|CfgSetFailed/.test(m.code || "")) { ws.removeEventListener("message", h); resolve(m); } } catch (e) {} };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { llm: { model: "should-not-write" } } } }));
    setTimeout(() => { ws.removeEventListener("message", h); resolve(null); }, 3000);
  }));
  check("服务端 cfg.set 硬拒", !!p3 && /配置只读/.test(p3.message || ""), JSON.stringify(p3));
  check("零 pageerror", errors.length === 0, errors.join(" | "));
  await page.screenshot({ path: "/tmp/modelpage-readonly.png", fullPage: true });
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();
