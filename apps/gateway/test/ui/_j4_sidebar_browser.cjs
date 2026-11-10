/**
 * J4 侧栏会话完整性与动态排序 —— 真实浏览器验证(自宿主临时端口,不碰 7700 生产环境网关)。
 * 形态:servePanel 起静态页 + 应用自己的 attachWs 换成最小协议桩(只发本用例需要的帧),
 * google-chrome 真跑页面,断言全在 DOM 上:
 *  ①14 个会话一个不丢:可见行数 + 各桶「显示更多(还有 N 条)」的剩余数 == 14;
 *  ②running 会话整体置顶(不被活动时间挤下去);
 *  ③「任务时间很旧、但刚刚有动作」的 sess-3 在活动帧到达后上浮到其桶首行(不再被压到分页外);
 *  ④行时间显示的是活动时间(不是任务 updatedAt):sess-3 行时间 ≠ 其任务时间的相对刻度;
 *  ⑤页面无 JS 异常(内联脚本可解析 —— 整页 SyntaxError 时 WS 都不连)。
 */
const { servePanel } = require("../../src/panel.ts");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright-core");

const PORT = Number(process.env.J4_PORT || 7761);
const T0 = Date.now() - 3 * 3600_000; // 3 小时前:所有任务时间都旧

function taskIndex(i, extra) {
  return Object.assign({
    id: "t" + i,
    sessionId: "sess-" + i,
    state: "done",
    title: "会话 " + i,
    updatedAt: T0 + i * 1000,
    createdAt: T0,
  }, extra || {});
}

(async () => {
  const tasks = [];
  for (let i = 0; i < 12; i++) tasks.push(taskIndex(i));
  tasks.push(taskIndex(99, { state: "running", updatedAt: T0 + 5, createdAt: T0 })); // running 恒置顶
  tasks.push(taskIndex(50, { updatedAt: T0 + 3, createdAt: T0 }));                  // 稍后收到活动帧

  const srv = servePanel(PORT, (httpServer) => {
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ v: 1, type: "hello", build: "j4-test", tasks }));
      // 1.2s 后让 sess-50「刚刚有动作」:任务时间仍是最旧的,但活动时间最新
      setTimeout(() => {
        try { ws.send(JSON.stringify({ v: 1, type: "session.status.changed", sessionId: "sess-50", lastActivityAt: Date.now() })); } catch (e) { /* 连接已关 */ }
      }, 1200);
    });
  }, {});
  const BASE = "http://127.0.0.1:" + PORT;

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  let failed = 0;
  const assert = (cond, msg, detail) => {
    if (cond) console.log("[j4] ok   " + msg);
    else { failed++; console.error("[j4] FAIL " + msg + (detail === undefined ? "" : " → " + detail)); }
  };
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("#taskList .t-row").length > 0, null, { timeout: 20000 });
    await page.waitForTimeout(2000); // 等活动帧到达并重渲侧栏

    const snap = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#taskList .t-row")];
      const more = [...document.querySelectorAll("#taskList .t-more")].map((e) => e.textContent || "");
      const hidden = more.reduce((a, t) => { const m = /还有 (\d+) 条/.exec(t); return a + (m ? Number(m[1]) : 0); }, 0);
      return {
        sids: rows.map((e) => e.getAttribute("data-sid")),
        times: rows.map((e) => (e.querySelector(".t-time") || {}).textContent || ""),
        more, hidden,
        total: rows.length + hidden,
      };
    });
    console.log("[j4] visible=" + snap.total + "(行 " + snap.sids.length + " + 更多 " + snap.hidden + ") head=" + JSON.stringify(snap.sids.slice(0, 4)));

    // ①完整性:没有任何会话被静默丢掉
    assert(snap.total === 14, "14 个会话全量可达(可见+显示更多剩余)", snap.total);
    assert(snap.more.length === 0 || snap.more.every((t) => /还有 \d+ 条/.test(t)), "被折叠的行都有明确「还有 N 条」提示", JSON.stringify(snap.more));

    // ②running 恒置顶
    assert(snap.sids[0] === "sess-99", "running 会话整体置顶(不被活动时间挤下去)", snap.sids[0]);

    // ③活动帧后 sess-50 上浮到该桶首行(非运行会话里最先)
    const nonLive = snap.sids.slice(snap.sids.indexOf("sess-99") + 1);
    assert(nonLive[0] === "sess-50", "最近有动作的会话排非运行组首位", JSON.stringify(nonLive.slice(0, 3)));

    // ④行时间 = 活动时间:该行时间文本应是「刚刚」/秒级,而非 3 小时前
    const i50 = snap.sids.indexOf("sess-50");
    const t50 = snap.times[i50] || "";
    assert(/刚刚|秒|1 分|分前/.test(t50), "sess-50 行时间显示最近活动时间(非任务 updatedAt)", t50);

    // ⑤无 JS 异常
    assert(errs.length === 0, "页面无 JS 异常", JSON.stringify(errs.slice(0, 3)));

    await page.screenshot({ path: ".genie/browser-shots/j4-sidebar.png" });
    if (failed) { console.error("[j4] FAILED " + failed); process.exitCode = 1; }
    else console.log("[j4] ALL PASS");
  } finally {
    await browser.close();
    await srv.close();
  }
})().catch((e) => { console.error("J4 BROWSER CRASH", e); process.exit(1); });
