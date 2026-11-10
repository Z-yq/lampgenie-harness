const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const SID = "probe-del-" + Date.now();
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const dir = path.join(HARNESS_ROOT, ".genie/boards", SID);
const BOARD = { version: 1, taskId: "tp", sessionId: SID, title: "探针板", status: "implementing", rev: 1, root: HARNESS_ROOT,
  nodes: [
    { id: "n1", kind: "function", label: "A", summary: "装配", change: "modify", flow: [], pos: { x: 40, y: 60 } },
    { id: "n2", kind: "function", label: "B", summary: "断链", change: "delete", flow: [], pos: { x: 320, y: 60 } }],
  edges: [{ from: "n1", to: "n2", kind: "call" }], planned_files: [], updatedAt: Date.now() };
fs.mkdirSync(dir, { recursive: true });
const bf = path.join(dir, "tp.json");
fs.writeFileSync(bf, JSON.stringify(BOARD));
(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
  await page.addInitScript(([sid]) => { sessionStorage.setItem("zh:sid", sid); }, [SID]);
  await page.goto("http://127.0.0.1:7700/", { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 15; i++) { await page.waitForTimeout(1000); if (await page.evaluate(() => document.body.innerText.includes("已连接"))) break; }
  await page.evaluate(() => switchView("board"));
  await page.waitForTimeout(2000);
  // 选中探针板
  await page.selectOption("#boardTaskSel", "tp").catch((e) => console.log("sel err", String(e).slice(0, 80)));
  await page.waitForTimeout(1500);
  const st0 = await page.evaluate(() => ({ edges: cvTargetDoc().edges.length, ro: typeof cvRo !== "undefined" ? cvRo : "?", nodes: cvTargetDoc().nodes.length }));
  console.log("st0:", JSON.stringify(st0));
  // hover 边中点
  const eb = await page.locator("#boardGraph .cv-edge").first().boundingBox();
  console.log("edgeBox:", JSON.stringify(eb));
  // 找 del 把手坐标(模拟 spec:走 :hover + getBoundingClientRect)
  await page.mouse.move(eb.x + eb.width * 0.5, eb.y + eb.height * 0.5);
  await page.waitForTimeout(300);
  const hov = await page.evaluate(() => { const g = document.querySelector("#boardGraph .cv-edge:hover .cv-edge-del"); return g ? getComputedStyle(g).visibility : "no-hover"; });
  console.log("hover:", hov);
  if (hov === "visible") {
    const db = await page.evaluate(() => { const g = document.querySelector("#boardGraph .cv-edge:hover .cv-edge-del"); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    // 点击前在 document 捕获层装记录器
    await page.evaluate(() => { window.__pd = []; document.addEventListener("pointerdown", (e) => window.__pd.push((e.target.className && e.target.className.baseVal !== undefined ? e.target.className.baseVal : e.target.className) + ""), true); });
    await page.mouse.click(db.x, db.y);
    await page.waitForTimeout(400);
    const st1 = await page.evaluate(() => ({ pd: window.__pd, edges: cvTargetDoc().edges.length, domEdges: document.querySelectorAll("#boardGraph .cv-edge").length }));
    console.log("afterClick:", JSON.stringify(st1));
  }
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error("ERR", String(e).slice(0, 250)); process.exit(1); });
