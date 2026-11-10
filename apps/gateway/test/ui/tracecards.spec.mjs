/**
 * 轨迹看板「逐次决策」E2E(step-1026):临时端口本地实例,**不碰产线 7700**。
 * 数据源:MemoryJournal 合成会话 + 3 个真实 trace 文件副本(拷进 .genie/llm-trace 下的测试目录,
 * 走真实 /api/llm-trace 路由;结束后删除)。
 * 覆盖:卡片数=trace 数 / 最新卡默认展开 / 长 tool 结果首尾可见(不截断)/ thinking 截断标记 /
 *       新决策到达自动追加一张卡 / 0 pageerror。
 * 跑法:cd apps/gateway && npx tsx test/ui/tracecards.spec.mjs(必须 .mjs:src 有 top-level await,.cjs 会被 tsx 转 CJS 报 ERR_REQUIRE_ASYNC_MODULE)
 */
process.env.GENIE_CHECKPOINT = "off";
const fs = await import("node:fs");
const path = (await import("node:path")).default;
const HERE = (await import("node:url")).fileURLToPath(new URL(".", import.meta.url));
const HARNESS_ROOT = path.resolve(HERE, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7802);
const SID = "ui-trace-1026";
const TRACE_ROOT = path.join(HARNESS_ROOT, ".genie", "llm-trace");
const TEST_DIR = path.join(TRACE_ROOT, SID);
const skip = (why) => { console.log("skipped: " + why); process.exit(0); };

let chromium = null;
try { chromium = (await import("playwright-core")).chromium; } catch (e) { skip("playwright-core 不可用"); }
if (!fs.existsSync(CHROME)) skip("无 chrome 可执行文件 " + CHROME);

const fails = [];
const check = (name, ok, ev) => { console.log("[" + (ok ? "通过" : "FAIL") + "] " + name + " — " + ev); if (!ok) fails.push(name); };

/** 从真实 trace 池取 3 个含长 tool 结果与 reasoning 的文件。 */
function pickRealTraceFiles() {
  const pool = path.join(TRACE_ROOT, "web-1793886278222");
  if (!fs.existsSync(pool)) return [];
  const files = fs.readdirSync(pool).filter((f) => f.startsWith("call-") && f.endsWith(".json"))
    .map((f) => ({ f: path.join(pool, f), size: fs.statSync(path.join(pool, f)).size }))
    .filter((x) => x.size > 200000)
    .sort((a, b) => a.f.localeCompare(b.f));
  return files.slice(0, 3).map((x) => x.f);
}

(async () => {
  const { createGatewayApp } = await import("../../src/app.ts");
  const { servePanel } = await import("../../src/panel.ts");
  const { MemoryJournal } = await import("@lampgenie/core");

  const srcs = pickRealTraceFiles();
  if (srcs.length < 3) skip("真实 trace 池不足(需要 ≥3 个 >200KB 文件)");
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const copied = srcs.map((src, i) => {
    const dst = path.join(TEST_DIR, "call-" + String(i + 1).padStart(4, "0") + "-t1s" + i + "-0.json");
    fs.copyFileSync(src, dst);
    return dst;
  });

  const journal = new MemoryJournal();
  const app = createGatewayApp({ useExternalHttp: true, journal });
  servePanel(PORT, (srv) => app.attachWs(srv));
  const BASE = "http://127.0.0.1:" + PORT;

  // 会话事件:user + 3 次 llm.trace(指向刚拷的真实全文)
  journal.append({ kind: "message.user", sessionId: SID, payload: { text: "轨迹看板逐次决策 E2E" } });
  copied.forEach((file, i) => {
    const d = JSON.parse(fs.readFileSync(file, "utf-8"));
    journal.append({
      kind: "llm.trace", sessionId: SID,
      payload: {
        file, turn: 1, step: i, model: d.model || "e2e-model", durationMs: d.durationMs || 100,
        ...(d.ttftMs !== undefined ? { ttftMs: d.ttftMs } : {}),
        ...(d.response && d.response.usage ? { usage: d.response.usage } : {}),
        messageRoles: (d.request.messages || []).map((m) => m.role),
        systemHead: String((d.request.messages || [])[0] ? d.request.messages[0].content : "").slice(0, 120),
        responseHead: String((d.response || {}).content || "").slice(0, 80),
        ...((d.response || {}).toolCalls ? { toolCalls: d.response.toolCalls.map((c) => c.name) } : {}),
      },
    });
  });
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 20000) throw new Error("self-host panel not ready on " + PORT);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.setDefaultTimeout(20000);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
    const traceReqs = [];
    page.on("request", (r) => { if (r.url().includes("/api/llm-trace")) traceReqs.push(r.url()); });
    await page.addInitScript((sid) => { localStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.click("#trajBoardBtn");
    // 首屏:卡片=3,最新卡自动展开且已拉全文
    await page.waitForTimeout(2500);
    const st1 = await page.evaluate(() => ({
      cards: document.querySelectorAll("#trajCardsHost .tb-card").length,
      heads: document.querySelectorAll("#trajCardsHost .tb-c-head").length,
      openBodies: document.querySelectorAll("#trajCardsHost .tb-card .tb-c-body").length,
      lastOpen: (() => {
        const cards = document.querySelectorAll("#trajCardsHost .tb-card");
        const last = cards[cards.length - 1];
        return last ? !!last.querySelector(".tb-c-body") : false;
      })(),
      paneOn: (document.querySelector("[data-traj-pane='decisions']") || {}).className || "",
      sum: (document.getElementById("trajBoardSum") || {}).textContent || "",
    }));
    check("卡片数=trace 数", st1.cards === 3, "cards=" + st1.cards + " heads=" + st1.heads);
    check("默认视图=逐次决策", String(st1.paneOn).includes("on"), "chip class=" + st1.paneOn);
    check("最新卡默认展开", st1.lastOpen === true, "openBodies=" + st1.openBodies);
    check("首屏只拉最新卡(+上一条),不批量拉", traceReqs.length <= 3, "trace 请求数=" + traceReqs.length);

    // 长 tool 结果:在展开的最新卡里找最长 pre,首尾都在
    const longTxt = await page.evaluate(() => {
      const pres = [...document.querySelectorAll("#trajCardsHost .tb-card .tb-c-body pre")];
      let best = "";
      for (const p of pres) if ((p.textContent || "").length > best.length) best = p.textContent || "";
      return { len: best.length, head: best.slice(0, 40), tail: best.slice(-40), bodyHtmlHasTrunc: /已截断(?!.*思考)/.test(best) };
    });
    check("长正文不截断(长度>2000)", longTxt.len > 2000, "最长 pre 长度=" + longTxt.len);
    const headVisible = await page.evaluate((h) => (document.querySelector("#trajCardsHost").textContent || "").includes(h), longTxt.head);
    const tailVisible = await page.evaluate((t) => (document.querySelector("#trajCardsHost").textContent || "").includes(t), longTxt.tail);
    check("长正文首尾都在 DOM 里", headVisible && tailVisible, "head=" + JSON.stringify(longTxt.head.slice(0, 24)) + " tail=" + JSON.stringify(longTxt.tail.slice(-24)));

    const think = await page.evaluate(() => {
      const el = document.querySelector("#trajCardsHost .tb-c-trunc");
      return el ? el.textContent : "";
    });
    check("thinking 截断标记", String(think).includes("思考已截断") && /共 \d+ 字/.test(String(think)), "文本=" + JSON.stringify(think.slice(0, 60)));

    const copyBtn = await page.evaluate(() => {
      const el = document.querySelector("#trajCardsHost [data-traj-copy]");
      return el ? el.getAttribute("data-traj-copy") : "";
    });
    check("原始 trace 文件路径可复制", String(copyBtn).includes(TEST_DIR), "path=" + String(copyBtn).slice(-60));

    // 模拟新决策:再 append 一条 llm.trace(复用第 1 个文件),等看板追加一张卡
    const d0 = JSON.parse(fs.readFileSync(copied[0], "utf-8"));
    journal.append({
      kind: "llm.trace", sessionId: SID,
      payload: { file: copied[0], turn: 1, step: 9, model: d0.model || "e2e-model", durationMs: 66,
        messageRoles: ["system"], responseHead: "新决策", toolCalls: [] },
    });
    let grew = false, cards2 = 0;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(700);
      cards2 = await page.evaluate(() => document.querySelectorAll("#trajCardsHost .tb-card").length);
      if (cards2 >= 4) { grew = true; break; }
    }
    check("新决策到达自动追加卡", grew, "cards 3→" + cards2);
    check("0 pageerror", errs.length === 0, "errs=" + JSON.stringify(errs.slice(0, 3)));
  } finally {
    await browser.close().catch(() => {});
    try { await app.close(); } catch (e) {}
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (fails.length) { console.log("FAIL 项:" + fails.join(" | ")); process.exit(1); }
  console.log("all checks passed");
  process.exit(0);
})().catch((e) => { console.log("FAIL 运行异常:" + String(e && e.stack || e).slice(0, 1200)); process.exit(1); });
