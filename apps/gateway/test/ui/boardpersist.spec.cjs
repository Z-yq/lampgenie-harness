/** 白板会话级落盘(2026-10-14 用户口径「session 里的白板数据要跟着 session 落盘」+「刷新/再登录后点开没内容」):
 * 手绘批注无语义板时落 <sid>/__session__.overlay.png(服务端);判据=清掉 localStorage 草稿后刷新、
 * 重新展开批注框仍能恢复(证明恢复自服务端 overlay 而非浏览器草稿;批注框刷新后默认收起,
 * 恢复时机=展开,wbResize→wbRestore 补画),且跨会话隔离。真实 chromium + 真实 gateway(PANEL_BASE)。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1600 } });
  page.setDefaultTimeout(20000); // 高载环境快速失败(2026-10-14 实证:共享机高载下渲染器饥饿会把无超时协议调用挂死)
  page.on("dialog", (d) => { console.log("[bp] DIALOG:", d.type(), String(d.message()).slice(0, 80)); d.dismiss().catch(() => {}); }); // 模态弹窗=渲染器协议调用全排队,必须有人接
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const draw = () => page.evaluate(() => {
    const c = document.querySelector("#wbCanvas");
    if (!c) return "no-canvas";
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: r.left + 20, clientY: r.top + 20 }));
    for (let i = 1; i <= 6; i++) c.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: r.left + 20 + i * 15, clientY: r.top + 20 + i * 8 }));
    c.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: r.left + 110, clientY: r.top + 68 }));
    return "ok";
  });
  const pixelSamples = () => page.evaluate(() => {
    const c = document.querySelector("#wbCanvas");
    if (!c || !c.width) return 0;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let nz = 0; for (let i = 3; i < d.length; i += 40) if (d[i] !== 0) nz++;
    return nz;
  });
  // 进白板视图并展开批注框(用户真实动作序列;草稿键 2026-10-14 起按 (会话,板) 隔离)
  const openBoardAndSketch = async () => {
    await page.click("#act-board");
    await page.waitForTimeout(600);
    if (!(await page.locator("#boardSketchBox").evaluate((el) => el.open).catch(() => false))) {
      await page.click("#boardSketchBox summary");
      await page.waitForTimeout(700); // toggle→wbResize→wbRestore(量尺寸+恢复)
    }
  };
  const clearWbDrafts = () => page.evaluate(() => {
    const kill = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("zh:whiteboard")) kill.push(k); }
    kill.forEach((k) => localStorage.removeItem(k));
    return kill.length;
  });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(900);
  // 建一个全新会话(无语义板,验证 __session__ 通道)
  await page.fill("#instruction", "白板落盘验证会话");
  await page.click("#go");
  await page.waitForTimeout(2500);
  await openBoardAndSketch();
  check("画布可见", await page.locator("#wbCanvas").count() === 1);

  // 画三笔 → __session__ overlay 落服务端
  await draw(); await draw(); await draw();
  await page.waitForTimeout(600);
  const before = await pixelSamples();
  check("画后画布非空", before > 0, "samples=" + before);

  // 铁证:清掉全部浏览器草稿键(若无服务端落盘,这一步之后必丢)
  const killed = await clearWbDrafts();
  check("草稿键按 (会话,板) 隔离(本会话 __session__ 键在场)", killed >= 1, "killed=" + killed);
  console.log("[bp] step:reload-begin");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("[bp] step:reload-done");
  await page.waitForTimeout(1200);
  await openBoardAndSketch();
  console.log("[bp] step:sketch-open");
  await page.waitForTimeout(800); // board.overlay.result(__session__)迟到窗
  const after = await pixelSamples();
  check("清 localStorage 后刷新+展开批注框仍恢复(服务端落盘铁证)", after > 0, "samples=" + after);

  // 会话隔离:开第二个会话,批注框应为空(不串台)
  console.log("[bp] step:session2-begin");
  await page.click("#act-new");
  await page.waitForTimeout(400);
  await page.fill("#instruction", "白板隔离验证会话二");
  await page.click("#go");
  await page.waitForTimeout(2500);
  console.log("[bp] step:session2-created");
  await openBoardAndSketch();
  console.log("[bp] step:session2-sketch-open");
  await page.waitForTimeout(600);
  const other = await pixelSamples();
  check("会话隔离(第二会话批注框空)", other === 0, "samples=" + other);

  check("0 pageerror", errors.length === 0, errors.join(" | "));
  const fails = results.filter((r) => !r.ok).length;
  console.log("boardpersist: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
