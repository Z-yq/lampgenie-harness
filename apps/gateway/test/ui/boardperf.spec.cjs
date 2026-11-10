/** step-073 P4 大板性能实测(真实 chromium;数据表产物,不编造):
 * 60 节点/120 边(协议上限档)+ 200 节点/380 边(渲染函数直驱超上限档)两档:
 * 首渲 ms / 增量补丁 ms / 节点拖拽帧率(rAF 实测) / 边重绘 ms。
 * 跑法:npx tsx test/ui/_restore_runner.cjs(SELF_SPEC=./boardperf.spec.cjs) */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7799";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const SHOTS = (process.env.GENIE_JOURNAL_DIR || "/tmp/j-s072") + "/shots";

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const evalJ = (fn, arg) => page.evaluate(fn, arg);
  const poll = async (fn, ms = 15000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await page.waitForTimeout(400); v = await fn(); } return v; };
  const wsCall = (msg, replyType) => evalJ(async ({ msg, replyType }) => {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    const out = await new Promise((res) => {
      const to = setTimeout(() => res({ timeout: true }), 20000);
      ws.onopen = () => ws.send(JSON.stringify(msg));
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === replyType || m.type === "error") { clearTimeout(to); res(m); } };
    });
    ws.close();
    return out;
  }, { msg, replyType });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.fill("#instruction", "大板性能实测会话");
  await page.click("#go");
  await poll(() => evalJ(() => { try { return [...tasks.values()].some((t) => t.state === "done"); } catch (e) { return false; } }));
  const sid = await evalJ(() => currentSid);

  // 60 节点/120 边合成板(协议上限档)
  const mkBoard = (n, e) => {
    const nodes = [];
    for (let i = 0; i < n; i++) nodes.push({ id: "p" + i, kind: i % 7 === 0 ? "module" : "function", label: "perfNode" + i, summary: "性能实测节点 " + i + ":验证渲染与交互成本", change: i % 4 === 0 ? "add" : "modify", done: i % 3 === 0, comments: i % 5 === 0 ? ["评论" + i] : [], flow: [] });
    const edges = [];
    for (let i = 0; i < e; i++) edges.push({ from: "p" + (i % n), to: "p" + ((i * 7 + 3) % n), kind: i % 3 === 0 ? "data" : "call", label: "e" + i });
    // 滤自环(边完整性)
    return { nodes, edges: edges.filter((x) => x.from !== x.to).slice(0, 120) };
  };
  const b60 = mkBoard(60, 120);
  const doc60 = { version: 1, taskId: "t-perf", sessionId: sid, title: "性能实测板·60节点", status: "implementing", rev: 0, nodes: b60.nodes, edges: b60.edges, planned_files: [], updatedAt: 0 };
  await wsCall({ v: 1, type: "board.save", sessionId: sid, taskId: "t-perf", doc: doc60, baseRev: 0 }, "board.doc");
  await page.click("#act-board");
  await poll(() => evalJ(() => boardDoc && boardDoc.taskId === "t-perf" && document.querySelectorAll(".cv-node").length === 60));

  // M1:整板重建冷渲(清签名强制全量)
  const m1 = await evalJ(() => {
    const g = document.getElementById("boardGraph");
    g.__cvSig = null;
    const t0 = performance.now();
    renderBoardCanvas(boardDoc);
    return Math.round((performance.now() - t0) * 100) / 100;
  });
  check("M1 60节点/120边 首渲(整板重建) < 500ms", m1 < 500, m1 + "ms");

  // M2:同结构增量补丁(翻 10 个 done + 改 5 个 summary)
  const m2 = await evalJ(() => {
    const d = JSON.parse(JSON.stringify(boardDoc));
    for (let i = 0; i < 10; i++) d.nodes[i].done = !d.nodes[i].done;
    for (let i = 0; i < 5; i++) d.nodes[i].summary = "修订后的摘要 " + i;
    const t0 = performance.now();
    renderBoardCanvas(d);
    return Math.round((performance.now() - t0) * 100) / 100;
  });
  check("M2 60节点 增量补丁 < 50ms(丝滑实锤)", m2 < 50, m2 + "ms");

  // M3:拖拽帧率(真实 pointer 事件 + rAF 计数 1s)
  const m3 = await evalJ(async () => {
    const el = document.querySelector('.cv-node[data-cv="p10"]');
    if (!el) return { fps: 0, err: "no node" };
    const r = el.getBoundingClientRect();
    const sx = r.left + 30, sy = r.top + 20;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 9, clientX: sx, clientY: sy }));
    let frames = 0;
    const t0 = performance.now();
    const count = () => { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(count); };
    requestAnimationFrame(count);
    for (let i = 1; i <= 30; i++) {
      el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 9, clientX: sx + i * 7, clientY: sy + i * 4 }));
      await new Promise((r2) => setTimeout(r2, 16));
    }
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9, clientX: sx + 210, clientY: sy + 120 }));
    const elapsed = performance.now() - t0;
    return { fps: Math.round(frames * 1000 / elapsed), frames, elapsed: Math.round(elapsed) };
  });
  check("M3 60节点 拖拽帧率 ≥ 30fps", m3.fps >= 30, m3.fps + "fps(" + m3.frames + " 帧/" + m3.elapsed + "ms)");

  // M4:200 节点/380 边 直驱(超协议上限档,渲染层压力)
  const m4 = await evalJ(() => {
    const nodes = [], edges = [];
    for (let i = 0; i < 200; i++) nodes.push({ id: "q" + i, kind: "function", label: "bigNode" + i, summary: "超上限档节点 " + i, change: "keep", done: i % 2 === 0, comments: [], flow: [] });
    for (let i = 0; i < 380; i++) { const a = "q" + (i % 200), b = "q" + ((i * 11 + 5) % 200); if (a !== b) edges.push({ from: a, to: b, kind: "call", label: "x" + i }); }
    const big = { taskId: "t-big", sessionId: "x", title: "200节点压力板", status: "draft", rev: 1, nodes, edges: edges.slice(0, 380), planned_files: [], updatedAt: 0 };
    const g = document.getElementById("boardGraph");
    g.__cvSig = null;
    const t0 = performance.now();
    renderBoardCanvas(big);
    const cold = Math.round((performance.now() - t0) * 100) / 100;
    for (let i = 0; i < 20; i++) big.nodes[i].done = !big.nodes[i].done;
    const t1 = performance.now();
    renderBoardCanvas(big); // 同结构→补丁
    const patch = Math.round((performance.now() - t1) * 100) / 100;
    return { cold, patch };
  });
  check("M4.1 200节点/380边 首渲 < 2000ms", m4.cold < 2000, m4.cold + "ms");
  check("M4.2 200节点 增量补丁 < 120ms", m4.patch < 120, m4.patch + "ms");
  await page.screenshot({ path: SHOTS + "/perf-200nodes.png" });
  console.log("[shot] perf-200nodes.png");

  // 恢复 60 节点板渲染(不污染后续)
  await evalJ(() => { const g = document.getElementById("boardGraph"); g.__cvSig = null; renderBoardCanvas(boardDoc); });

  check("Z 0 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
  try { fs.rmSync(path.join(HARNESS_ROOT, ".genie/boards", sid), { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  const fails = results.filter((r) => !r.ok).length;
  console.log("boardperf: " + (results.length - fails) + "/" + results.length);
  console.log("PERF_TABLE " + JSON.stringify({ n60: { coldMs: m1, patchMs: m2, dragFps: m3.fps }, n200: { coldMs: m4.cold, patchMs: m4.patch } }));
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
