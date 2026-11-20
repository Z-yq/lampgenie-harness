/**
 * s4:指挥台附件截断/门禁提示探针(真浏览器经验证)。
 * 用法同 chat-render-p2:node --import tsx test/ui/chat-render-p2-3.spec.cjs
 * 覆盖:①supSend 合并去重后按协议 12 截断,超限 toast 明示丢弃数(不再静默);
 * ②SUP_ATT_MAX=8 单入口门禁:第 9 个附件被 toast 拒(不进场)。
 * 全程不真连 WS(toast 在 send 前发出;wsSafeSend 走桩返回 false 也不影响 toast 断言)。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

const PORT = 7729;

(async () => {
  const panel = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("WebSocket")) errors.push(m.text().slice(0, 150));
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 200) : ""));
  };

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);

 // ---- P2-3① 发送合并截断提示:8(box)+8(ref)=16 去重后 16,截断丢 4,toast 明示 ----
  const cut = await page.evaluate(() => {
 // 直接造两端数据(绕开真实上传):box 8 个 + ref 8 个(路径互不重复)
    for (let i = 0; i < 8; i++) supPendingAtts.push({ name: "b" + i, path: "/tmp/b" + i, mime: "text/plain", size: 10 });
    for (let i = 0; i < 8; i++) supRefs.push({ kind: "file", label: "r" + i, path: "/tmp/r" + i });
    document.getElementById("superInput").value = "看这批文件";
 // wsSafeSend 未连接时返 false:截断 toast 在 send 判定前已发出,send 失败 toast 另算,断言只认截断文案
    supSend();
    return Array.from(document.querySelectorAll("#toastHost .toast")).map((el) => el.textContent);
  });
  const cutToast = cut.find((t) => /已丢弃 4 个/.test(String(t)) && /最多发 12/.test(String(t)));
  check("P2-3 合并超限截断 toast 明示丢弃数", !!cutToast, JSON.stringify(cut.slice(-3)));

 // ---- P2-3② SUP_ATT_MAX=8 门禁:已有 8 个时第 9 个 toast 拒且不进场 ----
  await page.evaluate(() => {
    supPendingAtts = [];
    supAttRender();
    for (let i = 0; i < 8; i++) supPendingAtts.push({ name: "g" + i, path: "/tmp/g" + i, mime: "text/plain", size: 10 });
  });
  const gateRes = await page.evaluate(() => {
    supAttAdd(new File(["x"], "g9.txt", { type: "text/plain" }));
    return {
      count: supChatAtts().length,
      toasts: Array.from(document.querySelectorAll("#toastHost .toast")).map((el) => el.textContent),
    };
  });
  check("P2-3 第 9 个附件被拒:数量仍 8", gateRes.count === 8, "count=" + gateRes.count);
  check("P2-3 第 9 个附件 toast 提示上限", /附件最多 8 个/.test(String(gateRes.toasts.slice(-1)[0] || "")), JSON.stringify(gateRes.toasts.slice(-2)));

  check("控制台无错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-chat-render-p2-3.png" });
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  console.log("---- " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ----");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 探针崩溃 — " + String(e && e.message ? e.message : e).slice(0, 400));
  process.exit(1);
});
