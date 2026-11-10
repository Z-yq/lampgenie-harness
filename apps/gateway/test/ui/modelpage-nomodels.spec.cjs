/** msu-st 负向:未装配 listModels 的网关 → models-not-implemented 必须落状态行,不能滞留「拉取中…」。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7795";
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  const results = [];
  const check = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS" : "FAIL") + " " + n + (d ? " — " + d : "")); };
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  await p.evaluate(() => { switchView("sys"); setSection("model"); });
  await p.waitForTimeout(300);
  await p.click("#models-fetch");
  await p.waitForTimeout(900);
  const status = (await p.locator("#models-status").textContent()) || "";
  check("错误态显示未启用原因", /模型列表未启用|未装配模型目录服务/.test(status), status);
  check("不滞留「拉取中…」", !/拉取中/.test(status), status);
  check("零 pageerror", errs.length === 0, errs.join(" | "));
  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();
