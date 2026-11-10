/** 画布「四件事」改后取证探针。
 *  骨架抄 probe_canvas_baseline.mjs;自起临时实例(默认 7796,占用则退 7797),**绝不碰 7700**。
 *  量四项(改前值从 shots/before-baseline.json 读):
 *   a 添加模块闭环:点 #cvAddBtn → 点第一个 .cv-aitem → 300/1200/3500ms 读 #cvSvgHost [data-node-id] 数量
 *     (要求任意时刻 >0)+ toast 文本 + board.save / board.diagram 帧时间戳;
 *   b 平移:真 page.mouse 在节点中心按下拖 120px → cvPan 位移应 ≈120;空白拖 120px 对照;再点节点(不动)仍能选中;
 *   c 边标签常显:点「适」后读 k 与可见边标签数;再缩到 k=0.3 确认标签隐藏;
 *   d 连线:选中节点 → 按 L → 点另一节点 → 输入框填「验证」→ 回车,读 boardDoc.edges 末条 + board.save 帧。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_canvas_after.mjs
 *  输出:test/ui/shots/after-*.png + after-canvas-four.json
 */
process.env.GENIE_CHECKPOINT = "off";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const SHOTS = path.join(__dirname, "shots");
const VIEWPORT = { width: 1400, height: 900 };
const BOARDS = path.join(HARNESS_ROOT, ".genie", "boards");
const SRC_DIR = path.join(BOARDS, "web-ng-tasksm-1793811933881");
const WANT_NODES = 17;

const skip = (why) => { console.log("skipped: " + why); process.exit(0); };
let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch (e) { chromium = null; }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome " + CHROME);
if (!fs.existsSync(SRC_DIR)) skip("无源板目录 " + SRC_DIR);

/* ---------- 改前基线(只读) ---------- */
let before = {};
try { before = JSON.parse(fs.readFileSync(path.join(SHOTS, "before-baseline.json"), "utf-8")); } catch (e) { before = {}; }

fs.mkdirSync(SHOTS, { recursive: true });
const out = { at: new Date().toISOString(), before: {}, add: {}, pan: {}, labels: {}, link: {}, shots: [], errors: [], port: null };
const note = (k, v) => { out[k.split(".")[0]] = out[k.split(".")[0]] || {}; out[k.split(".").slice(0, 1)[0]]; console.log("[metric] " + k + " = " + JSON.stringify(v)); return v; };

/* ---------- 挑源板:节点数最接近 17 的文件 ---------- */
const cands = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".json")).map((f) => {
  let n = -1, edges = -1, j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), "utf-8")); n = (j.nodes || []).length; edges = (j.edges || []).length; } catch (e) { /* 坏文件 */ }
  return { f, n, edges, j };
}).filter((c) => c.j);
for (const c of cands) console.log("[cand] " + c.f + " nodes=" + c.n + " edges=" + c.edges);
cands.sort((a, b) => Math.abs(a.n - WANT_NODES) - Math.abs(b.n - WANT_NODES) || b.n - a.n);
const SRC = cands[0];
if (!SRC) skip("源板目录无可读 json");
console.log("[src] " + SRC.f + " nodes=" + SRC.n);

/* ---------- 端口:7796,占用则 7797(绝不 7700) ---------- */
const app = (await import("../../src/app.ts")).createGatewayApp({ useExternalHttp: true, journalDir: mkdtempSync(path.join(tmpdir(), "probeafter-")) });
const { servePanel } = await import("../../src/panel.ts");
let PORT = 0, server = null;
for (const p of [Number(process.env.SELF_PORT || 7796), 7797]) {
  if (p === 7700) continue;
  const srv = servePanel(p, (s) => app.attachWs(s));
  const t = Date.now();
  let ok = false;
  for (;;) {
    try { const r = await fetch("http://127.0.0.1:" + p + "/"); if (r.ok) { ok = true; break; } } catch (e) { /* 未就绪 */ }
    if (Date.now() - t > 15000) break;
    await new Promise((r2) => setTimeout(r2, 300));
  }
  if (ok) { PORT = p; server = srv; break; }
  console.log("[port] " + p + " 不可用");
  try { await srv.close(); } catch (e) { /* 忽略 */ }
}
if (!PORT) skip("7796/7797 都被占用");
out.port = PORT;
const BASE = "http://127.0.0.1:" + PORT;
console.log("[port] " + PORT);

/* ---------- 临时 SID + 板副本(status=implementing) ---------- */
const SID = "ui-probe-after-" + PORT;
function stageBoard(src, sid) {
  const taskId = src.f.replace(/\.json$/, "");
  const dir = path.join(BOARDS, sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
  const doc = src.j;
  doc.sessionId = sid;
  doc.status = "implementing";
  fs.writeFileSync(path.join(dir, taskId + ".json"), JSON.stringify(doc, null, 1));
  console.log("[fixture] " + sid + " ← " + src.f + " nodes=" + SRC.n + " edges=" + SRC.edges + " status=implementing");
  return { sid, taskId, file: path.join(dir, taskId + ".json") };
}
const fix = stageBoard(SRC, SID);

const t0 = Date.now();
for (;;) {
  try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
  if (Date.now() - t0 > 20000) throw new Error("panel not ready on " + PORT);
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });

async function openPage(sid) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => out.errors.push("pageerror: " + String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") out.errors.push("console: " + String(m.text()).slice(0, 200)); });
  await page.addInitScript(() => {
    const OWS = window.WebSocket;
    function patch() {
      if (window.__wsPatched) return;
      window.__wsPatched = true;
      const wrap = class extends OWS {
        constructor(...a) {
          super(...a);
          this.addEventListener("message", (ev) => {
            try { const m = JSON.parse(ev.data); window.__recv.push({ t: Date.now(), type: m && m.type, ok: m && m.ok, svgLen: m && m.svg ? String(m.svg).length : undefined, nodes: m && m.doc && m.doc.nodes ? m.doc.nodes.length : undefined }); } catch (e) { /* 非 JSON */ }
          });
        }
        send(d) {
          try { const m = JSON.parse(d); window.__frames.push({ t: Date.now(), type: m && m.type, nodes: m && m.doc && m.doc.nodes ? m.doc.nodes.length : undefined, edges: m && m.doc && m.doc.edges ? m.doc.edges.length : undefined }); } catch (e) { /* 非 JSON */ }
          return super.send(d);
        }
      };
      window.WebSocket = wrap;
      window.__frames = []; window.__recv = [];
    }
    patch();
  });
  await page.addInitScript((sid) => { try { sessionStorage.setItem("zh:sid", sid); } catch (e) { /* 隐私模式 */ } }, sid);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  await page.click("#act-board");
  let kids = 0;
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(700);
    kids = await page.evaluate(() => { const s = document.querySelector("#cvSvgHost svg"); return s ? s.childElementCount : 0; });
    if (kids > 2) break;
    await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
  }
  await page.waitForTimeout(900);
  return page;
}

/** 画布快照:节点数(含候选/真节点)、cvPan、可见边标签数、toast。 */
const snap = (page) => page.evaluate(() => {
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const known = new Set(((doc && doc.nodes) || []).map((n) => String(n.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")];
  const real = gs.filter((g) => known.has(g.getAttribute("data-node-id")));
  // 边标签口径与基线探针一致:不在任何 [data-node-id] 内、含 ｜/→ 的 text;另并上 cards 路径的 .bf-cv-edge-label
  const svg = document.querySelector("#cvSvgHost svg");
  const allTexts = svg ? [...svg.querySelectorAll("text")] : [];
  const flowLabels = allTexts.filter((t) => !(t.closest && t.closest("[data-node-id]")) && /[｜→]/.test(t.textContent || ""));
  const cardLabels = [...document.querySelectorAll("#cvSvgHost .bf-cv-edge-label, .bf-cv-world .bf-cv-edge-label")];
  // B.c 口径:flowkit 的边标签 = g[data-connector-id] 里的 text(无 class,故必须按 connector 组取)
  const connLabels = svg ? [...svg.querySelectorAll("[data-connector-id]")].flatMap((g) => [...g.querySelectorAll("text")]) : [];
  const labels = [...new Set([...flowLabels, ...cardLabels, ...connLabels])];
  const visLabels = labels.filter((l) => { const cs = getComputedStyle(l); return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity || 1) > 0.05; });
  const world = document.getElementById("cvWorld");
  const host = document.getElementById("cvSvgHost");
  return {
    docNodes: doc ? doc.nodes.length : -1,
    docEdges: doc ? (doc.edges || []).length : -1,
    svgNodeEls: gs.length,
    svgRealNodes: real.length,
    k: (typeof cvPan !== "undefined" ? Math.round(cvPan.k * 10000) / 10000 : null),
    pan: (typeof cvPan !== "undefined" ? { x: Math.round(cvPan.x * 10) / 10, y: Math.round(cvPan.y * 10) / 10 } : null),
    zLow: world ? world.classList.contains("z-low") : null,
    stale: host ? host.getAttribute("data-stale") : null,
    hostHasSvg: !!(host && host.querySelector("svg")),
    selNode: (typeof boardSelNode !== "undefined" ? boardSelNode : null),
    edgeLabelsTotal: labels.length,
    edgeLabelsVisible: visLabels.length,
    edgeLabelSamples: labels.slice(0, 4).map((l) => (l.textContent || "").slice(0, 20)),
    edgeLabelMarkup: labels.slice(0, 4).map((l) => ({
      cls: l.getAttribute("class") || "",
      parentCls: l.parentElement ? (l.parentElement.getAttribute("class") || l.parentElement.tagName) : "",
      tag: l.tagName,
      display: getComputedStyle(l).display,
    })),
    linkFrom: (typeof cvLinkFrom !== "undefined" ? cvLinkFrom : "undef"),
    boardEditOn: (typeof boardEditOn !== "undefined" ? !!boardEditOn : null),
    toasts: [...document.querySelectorAll("#toastHost .toast")].map((e) => e.textContent).slice(-4),
  };
});

const nodePoint = (page, skipIds = []) => page.evaluate((sk) => {
  const h = document.getElementById("cvHost");
  if (!h) return null;
  const hr = h.getBoundingClientRect();
  const known = new Set(((typeof boardDoc !== "undefined" && boardDoc && boardDoc.nodes) || []).map((n) => String(n.id)));
  for (const g of [...document.querySelectorAll("#cvSvgHost [data-node-id]")]) {
    const id = g.getAttribute("data-node-id");
    if (!known.has(id) || sk.includes(id)) continue;
    const r = g.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) continue;
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < hr.left + 6 || cx > hr.right - 6 || cy < hr.top + 6 || cy > hr.bottom - 6) continue;
    const el = document.elementFromPoint(cx, cy);
    const hit = el && el.closest ? el.closest("[data-node-id]") : null;
    if (!hit || hit.getAttribute("data-node-id") !== id) continue;
    return { id, x: cx, y: cy };
  }
  return null;
}, skipIds);

const blankPoint = (page) => page.evaluate(() => {
  const h = document.getElementById("cvHost");
  if (!h) return null;
  const hr = h.getBoundingClientRect();
  for (let y = hr.top + 40; y < hr.bottom - 30; y += 27) {
    for (let x = hr.left + 30; x < hr.right - 30; x += 41) {
      const el = document.elementFromPoint(x, y);
      if (!el || !h.contains(el)) continue;
      if (el.closest && el.closest(".bf-zoombar,.bf-minimap,.cv-addbar,.cv-addpanel,.cv-wbar,.cv-rail,.cv-lbar,.cv-ctx,.cv-link-word,.cv-link-hint")) continue;
      if (el.closest && el.closest("[data-node-id]")) continue;
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
});

const shot = async (page, name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); out.shots.push(p); console.log("[shot] " + p); };
const framesSince = (page, t) => page.evaluate((tt) => ({
  sent: window.__frames.filter((f) => f.t >= tt).map((f) => ({ dt: f.t - tt, type: f.type, nodes: f.nodes, edges: f.edges })),
  recv: window.__recv.filter((f) => f.t >= tt).map((f) => ({ dt: f.t - tt, type: f.type, ok: f.ok, svgLen: f.svgLen, nodes: f.nodes })),
}), t);

let page = null;
try {
  page = await openPage(SID);
  const s0 = await snap(page);
  console.log("[open] " + JSON.stringify({ docNodes: s0.docNodes, svgReal: s0.svgRealNodes, k: s0.k }));

  /* ================= a 添加模块闭环 ================= */
  const a = out.add;
  a.before = { docNodes: s0.docNodes, svgRealNodes: s0.svgRealNodes, k: s0.k, stale: s0.stale };
  a.beforeBaseline = {
    at300ms: (before.add && before.add.after300) ? { docNodes: before.add.after300.docNodes, svgNodeEls: before.add.after300.svgDataNodeIds, svgRealNodes: before.add.after300.svgRealNodes } : null,
    saveFrames: (before.add && before.add.verdict) ? before.add.verdict.saveFrames : null,
    diagramResult: (before.add && before.add.verdict) ? before.add.verdict.gotDiagramResult : null,
  };
  const tAdd = await page.evaluate(() => Date.now());
  await page.click("#cvAddBtn");
  await page.waitForTimeout(350);
  a.panel = await page.evaluate(() => { const p = document.getElementById("cvAddPanel"); return { display: p ? getComputedStyle(p).display : "missing", items: document.querySelectorAll("#cvAddPanel .cv-aitem").length }; });
  a.firstItem = await page.evaluate(() => { const it = document.querySelector("#cvAddPanel .cv-aitem"); return it ? (it.dataset.kind || "") + "/" + it.textContent.trim() : null; });
  await page.click("#cvAddPanel .cv-aitem");
  // 60ms 细粒度采样 3s:记录等图窗口里 svg 节点数是否归零 + data-stale 是否出现过
  const series = [];
  const tSample = Date.now();
  let s300 = null, s1200 = null, s3500 = null;
  for (let i = 0; i < 52; i++) {
    const s = await snap(page);
    const at = Date.now() - tSample;
    series.push({ at, svgNodeEls: s.svgNodeEls, svgRealNodes: s.svgRealNodes, docNodes: s.docNodes, stale: s.stale, hostHasSvg: s.hostHasSvg });
    if (!s300 && at >= 300) { s300 = s; await shot(page, "after-add-300ms.png"); }
    if (!s1200 && at >= 1200) { s1200 = s; }
    if (!s3500 && at >= 3500) { s3500 = s; break; }
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1200);
  const sDone = await snap(page);
  series.push({ at: Date.now() - tSample, svgNodeEls: sDone.svgNodeEls, svgRealNodes: sDone.svgRealNodes, docNodes: sDone.docNodes, stale: sDone.stale, hostHasSvg: sDone.hostHasSvg });
  await shot(page, "after-add-done.png");
  a.series = series;
  a.samples = { at300: s300, at1200: s1200, at3500: s3500, done: sDone };
  a.minSvgNodesAnyTime = Math.min(...series.map((x) => x.svgNodeEls));
  a.minRealNodesAnyTime = Math.min(...series.map((x) => x.svgRealNodes));
  a.sawStale = series.some((x) => x.stale === "1");
  a.staleSamples = series.filter((x) => x.stale === "1").length;
  a.hostHasSvgThroughout = series.every((x) => x.hostHasSvg);
  a.toastSeen = [...new Set([s300, s1200, s3500, sDone].flatMap((x) => (x && x.toasts) || []))];
  const fr = await framesSince(page, tAdd);
  a.frames = fr;
  a.saveFrame = (fr.sent || []).find((f) => f.type === "board.save") || null;
  a.diagramResult = (fr.recv || []).find((f) => f.type === "board.diagram.result" || (f.type && String(f.type).indexOf("diagram") >= 0)) || null;
  a.verdict = {
    nodesNeverZero: a.minSvgNodesAnyTime > 0,
    sawStale: a.sawStale,
    docGrewByOne: sDone.docNodes === s0.docNodes + 1,
    toastMatches: a.toastSeen.some((t) => /已添加 .*· 正在出图…/.test(t || "")),
    saveDt: a.saveFrame ? a.saveFrame.dt : null,
    diagramDt: a.diagramResult ? a.diagramResult.dt : null,
  };
  console.log("[a] " + JSON.stringify(a.verdict));

  /* ================= b 平移 ================= */
  const b = out.pan;
  const np = await nodePoint(page);
  b.nodeStart = np;
  const beforeNode = await snap(page);
  if (np) {
    await page.mouse.move(np.x, np.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(np.x + 20 * i, np.y);
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const afterNode = await snap(page);
  b.dragNode = { before: beforeNode.pan, after: afterNode.pan, dx: afterNode.pan && beforeNode.pan ? Math.round((afterNode.pan.x - beforeNode.pan.x) * 10) / 10 : null, dk: afterNode.pan && beforeNode.pan ? Math.round((afterNode.pan.k - beforeNode.pan.k) * 10000) / 10000 : null, selAfterDrag: afterNode.selNode };
  await shot(page, "after-pan-node.png");
  // 空白对照
  const bp = await blankPoint(page);
  b.blankStart = bp;
  if (bp) {
    await page.mouse.move(bp.x, bp.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(bp.x + 20 * i, bp.y);
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const afterBlank = await snap(page);
  b.dragBlank = { before: afterNode.pan, after: afterBlank.pan, dx: afterNode.pan && afterBlank.pan ? Math.round((afterBlank.pan.x - afterNode.pan.x) * 10) / 10 : null };
  // 点一下节点(不动)= 仍能选中
  const np2 = await nodePoint(page);
  if (np2) { await page.mouse.move(np2.x, np2.y); await page.mouse.down(); await page.mouse.up(); }
  await page.waitForTimeout(300);
  const afterClick = await snap(page);
  b.clickSelect = { clicked: np2 ? np2.id : null, selNode: afterClick.selNode, ok: !!(np2 && afterClick.selNode === np2.id) };
  b.beforeBaseline = before.pan ? { nodeDx: before.pan.dNode ? before.pan.dNode.dx : null, blankDx: before.pan.dBlank ? before.pan.dBlank.dx : null } : null;
  b.verdict = { nodePanOk: b.dragNode.dx !== null && Math.abs(b.dragNode.dx) >= 100, blankPanOk: b.dragBlank.dx !== null && Math.abs(b.dragBlank.dx) >= 100, clickSelectOk: b.clickSelect.ok };
  console.log("[b] " + JSON.stringify(b.verdict) + " dNode=" + b.dragNode.dx + " dBlank=" + b.dragBlank.dx);

  /* ================= c 边标签常显 ================= */
  const c = out.labels;
  await page.click("#cvZfit");
  await page.waitForTimeout(700);
  const sFit = await snap(page);
  c.fit = { k: sFit.k, zLow: sFit.zLow, edgeLabelsTotal: sFit.edgeLabelsTotal, edgeLabelsVisible: sFit.edgeLabelsVisible, toasts: sFit.toasts, edgeLabelMarkup: sFit.edgeLabelMarkup };
  await shot(page, "after-edge-labels.png");
  // 缩到 k=0.3:标签应隐藏
  await page.evaluate(() => { try { cvSetZoom(0.3); } catch (e) { /* 旧壳 */ } });
  await page.waitForTimeout(500);
  const sLow = await snap(page);
  c.zoomOut = { k: sLow.k, zLow: sLow.zLow, edgeLabelsTotal: sLow.edgeLabelsTotal, edgeLabelsVisible: sLow.edgeLabelsVisible, edgeLabelMarkup: sLow.edgeLabelMarkup };
  c.beforeBaseline = { fitK: before.metrics ? before.metrics["F.fit.k"] : null, edgeLabels: before.metrics ? before.metrics["B.edgeLabels"] : null };
  c.verdict = { labelsVisibleAtFit: sFit.edgeLabelsVisible > 0, hiddenAtLow: sLow.edgeLabelsVisible === 0, zLowAtLow: sLow.zLow };
  console.log("[c] " + JSON.stringify(c.fit) + " → " + JSON.stringify(c.zoomOut));
  await page.evaluate(() => { try { cvSetZoom(0.9); } catch (e) { /* 忽略 */ } });
  await page.waitForTimeout(300);

  /* ================= d 连线 ================= */
  const d = out.link;
  await page.click("#cvZfit"); // b/c 已把视野平移/缩放走,连线前先复位(否则目标节点不在屏内)
  await page.waitForTimeout(600);
  const fromPt = await nodePoint(page);
  const dBefore = await snap(page);
  d.from = fromPt ? fromPt.id : null;
  // 确保选中(点两下的概率兜底:第一下若把它取消选中,再点一次)
  if (fromPt) {
    for (let i = 0; i < 2; i++) {
      await page.mouse.move(fromPt.x, fromPt.y); await page.mouse.down(); await page.mouse.up();
      await page.waitForTimeout(280);
      if ((await snap(page)).selNode === fromPt.id) break;
    }
  }
  d.selAfterClick = (await snap(page)).selNode;
  await page.keyboard.press("l"); // 进连线态
  await page.waitForTimeout(250);
  d.stateAfterL = (await snap(page)).linkFrom;
  d.hintVisible = await page.evaluate(() => !!document.querySelector("#cvHost .cv-link-hint"));
  await shot(page, "after-link-menu.png");
  const toPt = await nodePoint(page, d.from ? [d.from] : []);
  d.to = toPt ? toPt.id : null;
  if (toPt) { await page.mouse.move(toPt.x, toPt.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(400); }
  d.wordBoxVisible = await page.evaluate(() => !!document.querySelector("#cvHost .cv-link-word input"));
  const tLink = await page.evaluate(() => Date.now()); // 帧窗口从「填词之前」起算(board.save 在回车瞬间就发)
  if (d.wordBoxVisible) {
    await page.fill("#cvHost .cv-link-word input", "验证");
    await page.press("#cvHost .cv-link-word input", "Enter");
  }
  await page.waitForTimeout(900);
  const dAfter = await snap(page);
  d.docEdgesBefore = dBefore.docEdges;
  d.docEdgesAfter = dAfter.docEdges;
  d.lastEdge = await page.evaluate(() => { const doc = (typeof boardDoc !== "undefined" && boardDoc) || null; const e = doc && doc.edges ? doc.edges[doc.edges.length - 1] : null; return e ? { from: e.from, to: e.to, label: e.label === undefined ? null : e.label, virtual: e.virtual } : null; });
  const frLink = await framesSince(page, tLink);
  d.frames = frLink.sent;
  d.sentBoardSave = (frLink.sent || []).some((f) => f.type === "board.save");
  // Esc 能退出连线态(再进一次后按 Esc)
  await page.evaluate(() => { try { boardSelNode = boardDoc.nodes[0] && boardDoc.nodes[0].id; cvLinkStart(boardSelNode); } catch (e) { /* 忽略 */ } });
  await page.waitForTimeout(200);
  const inLink = (await snap(page)).linkFrom;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const afterEsc = (await snap(page)).linkFrom;
  d.esc = { inLink, afterEsc, ok: !!inLink && afterEsc === null };
  d.beforeBaseline = { note: "改前 svg 视图无连线入口(.cv-port 只在卡片渲染里),cvLinkFrom/cvLinkAskWord 未定义" };
  d.verdict = {
    edgeAdded: d.docEdgesAfter === d.docEdgesBefore + 1,
    labelOk: !!(d.lastEdge && d.lastEdge.label === "验证"),
    fromToOk: !!(d.lastEdge && d.lastEdge.from === d.from && d.lastEdge.to === d.to),
    saveSent: d.sentBoardSave,
    escOk: d.esc.ok,
  };
  console.log("[d] " + JSON.stringify(d.verdict) + " edge=" + JSON.stringify(d.lastEdge));

  /* ---------- 编辑态事实核对:svgraph 节点能否拖动(预期不能) ---------- */
  out.editDrag = await page.evaluate(() => ({ note: "svg 视图节点拖拽未实现(布局由 flowkit/ELK 决定);编辑态下节点按下也不起平移(boardEditOn 早退)", boardEditOn: typeof boardEditOn !== "undefined" ? !!boardEditOn : null }));
} catch (e) {
  out.errors.push("fatal: " + String((e && e.stack) || e).slice(0, 800));
  console.log("[fatal] " + String((e && e.stack) || e).slice(0, 800));
} finally {
  try { if (page) await page.close(); } catch (e) { /* 忽略 */ }
  try { await browser.close(); } catch (e) { /* 忽略 */ }
  try { if (server) await server.close(); } catch (e) { /* 忽略 */ }
  fs.writeFileSync(path.join(SHOTS, "after-canvas-four.json"), JSON.stringify(out, null, 1));
  console.log("\n=== after json: " + path.join(SHOTS, "after-canvas-four.json") + " ===");
  console.log("errors: " + JSON.stringify(out.errors.slice(0, 6)));
  process.exit(0);
}
