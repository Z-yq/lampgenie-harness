/** 布局改后取证探针(2026-11-06):ELK 布局 + 一屏可读性。
 *  骨架抄 probe_canvas_baseline.mjs / probe_canvas_after.mjs;自起临时实例(7798,占用则 7799),**绝不碰 7700**。
 *  量:17 节点板与 60 节点板各 —— viewBox w/h/宽高比、「适」后 k+host+一屏完整可见节点数、「全」后 k+可见数、
 *      可见边标签数(g[data-connector-id] text 非空且未 display:none)、抽样 3 节点的文本溢出卡宽条数。
 *  改前值一律从 shots/before-baseline.json 抄,不自编。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_canvas_layout_after.mjs
 *  输出:test/ui/shots/layout-after-{17,60}-{fit,all}.png + layout-after-canvas.json
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
const SRC60 = path.join(BOARDS, "web-1792774467576", "dec3a2d2-b812-4fe1-899b-c2a91365ea26.json");
const WANT_NODES = 17;

const skip = (why) => { console.log("skipped: " + why); process.exit(0); };
let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch (e) { chromium = null; }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome " + CHROME);
if (!fs.existsSync(SRC_DIR)) skip("无源板目录 " + SRC_DIR);
if (!fs.existsSync(SRC60)) skip("无 60 节点板 " + SRC60);

/* ---------- 改前基线(只读,不重算) ---------- */
let before = {};
try { before = JSON.parse(fs.readFileSync(path.join(SHOTS, "before-baseline.json"), "utf-8")); } catch (e) { before = {}; }
const bm = before.metrics || {};

fs.mkdirSync(SHOTS, { recursive: true });
const out = { at: new Date().toISOString(), port: null, before: {}, boards: {}, shots: [], errors: [] };
const note = (k, v) => { console.log("[metric] " + k + " = " + JSON.stringify(v)); return v; };

/* ---------- 挑 17 节点源板 ---------- */
const cands = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".json")).map((f) => {
  let n = -1, edges = -1, j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(SRC_DIR, f), "utf-8")); n = (j.nodes || []).length; edges = (j.edges || []).length; } catch (e) { /* 坏文件 */ }
  return { f, n, edges, j };
}).filter((c) => c.j);
for (const c of cands) console.log("[cand] " + c.f + " nodes=" + c.n + " edges=" + c.edges);
/* 默认优先 c78b0e83-…:改前基线(before-baseline.json 的 4349×798 + s11 卡宽 790)就是这块板,
 * 换了文件则 viewBox/卡宽不可比(同为 17 节点的另两块会渲染成 1422×1123)。SRC17_FILE 可覆盖。 */
const PREF17 = process.env.SRC17_FILE || "c78b0e83-2956-4245-b080-1048c53b6a47.json";
cands.sort((a, b) => Math.abs(a.n - WANT_NODES) - Math.abs(b.n - WANT_NODES) || b.n - a.n);
const SRC17 = cands.find((c) => c.f === PREF17) || cands[0];
if (!SRC17) skip("源板目录无可读 json");
if (SRC17.f !== PREF17) console.log("[warn] 首选板 " + PREF17 + " 不在候选里,退 " + SRC17.f);
console.log("[src17] " + SRC17.f + " nodes=" + SRC17.n);
let j60 = null;
try { j60 = JSON.parse(fs.readFileSync(SRC60, "utf-8")); } catch (e) { j60 = null; }
if (!j60) skip("60 节点板不可解析");
console.log("[src60] " + path.basename(SRC60) + " nodes=" + (j60.nodes || []).length + " edges=" + (j60.edges || []).length);

/* ---------- 端口:7798,占用则 7799(绝不 7700) ---------- */
const app = (await import("../../src/app.ts")).createGatewayApp({ useExternalHttp: true, journalDir: mkdtempSync(path.join(tmpdir(), "probelayout-")) });
const { servePanel } = await import("../../src/panel.ts");
let PORT = 0, server = null;
for (const p of [Number(process.env.SELF_PORT || 7798), 7799]) {
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
if (!PORT) skip("7798/7799 都被占用");
out.port = PORT;
const BASE = "http://127.0.0.1:" + PORT;
console.log("[port] " + PORT);

/* ---------- 临时 SID + 板副本(status=implementing) ---------- */
function stageBoard(src, sid, tag) {
  const taskId = src.f.replace(/\.json$/, "");
  const dir = path.join(BOARDS, sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
  const doc = src.j;
  doc.sessionId = sid;
  doc.status = "implementing";
  fs.writeFileSync(path.join(dir, taskId + ".json"), JSON.stringify(doc, null, 1));
  console.log("[fixture] " + tag + " " + sid + " ← " + src.f + " nodes=" + src.n + " edges=" + src.edges + " status=implementing");
  return { sid, taskId, file: path.join(dir, taskId + ".json"), nodes: src.n, edges: src.edges };
}
const fix17 = stageBoard(SRC17, "ui-probe-layout17-" + PORT, "17nodes");
const fix60 = stageBoard({ f: path.basename(SRC60), n: (j60.nodes || []).length, edges: (j60.edges || []).length, j: j60 }, "ui-probe-layout60-" + PORT, "60nodes");

const t0 = Date.now();
for (;;) {
  try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
  if (Date.now() - t0 > 20000) throw new Error("panel not ready on " + PORT);
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });

async function openPage(sid) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(25000);
  page.on("pageerror", (e) => out.errors.push("pageerror: " + String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") out.errors.push("console: " + String(m.text()).slice(0, 200)); });
  await page.addInitScript((sid) => { try { sessionStorage.setItem("zh:sid", sid); } catch (e) { /* 隐私模式 */ } }, sid);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1400);
  await page.click("#act-board");
  let kids = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(700);
    kids = await page.evaluate(() => { const s = document.querySelector("#cvSvgHost svg"); return s ? s.childElementCount : 0; });
    if (kids > 2) break;
    await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
  }
  await page.waitForTimeout(1200);
  return { page, kids };
}

/** 一屏指标快照(口径与 before-baseline 探针一致)。 */
const snap = (page) => page.evaluate(() => {
  const svg = document.querySelector("#cvSvgHost svg");
  const vb = svg ? svg.getAttribute("viewBox") : null;
  const p = vb ? String(vb).trim().split(/[\s,]+/).map(Number) : null;
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const known = new Set(((doc && doc.nodes) || []).map((n) => String(n.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")];
  const real = gs.filter((g) => known.has(g.getAttribute("data-node-id")));
  const host = document.getElementById("cvHost");
  const hr = host ? host.getBoundingClientRect() : null;
  let fully = 0, partial = 0;
  const visIds = [];
  for (const g of real) {
    const r = g.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (hr && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5 && r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5) { fully++; visIds.push(g.getAttribute("data-node-id")); }
    else if (hr && r.right > hr.left && r.left < hr.right && r.bottom > hr.top && r.top < hr.bottom) partial++;
  }
  // 边标签(任务书口径):g[data-connector-id] 内 text,非空且未被 display:none/visibility/opacity 隐藏
  const connGroups = svg ? [...svg.querySelectorAll("g[data-connector-id]")] : [];
  const connTexts = connGroups.flatMap((g) => [...g.querySelectorAll("text")]).filter((t) => (t.textContent || "").trim().length > 0);
  const connVisible = connTexts.filter((t) => {
    const cs = getComputedStyle(t);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity || 1) <= 0.05) return false;
    let el = t;
    for (let i = 0; i < 6 && el; i++) { const s2 = getComputedStyle(el); if (s2.display === "none" || s2.visibility === "hidden") return false; el = el.parentElement; }
    const r = t.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const edgeLabelSamples = connVisible.slice(0, 5).map((t) => (t.textContent || "").slice(0, 24));
  const world = document.getElementById("cvWorld");
  return {
    viewBox: vb,
    vbWH: p && p.length === 4 && p[2] > 0 && p[3] > 0 ? { w: p[2], h: p[3], ratio: Math.round((p[2] / p[3]) * 10000) / 10000 } : null,
    docNodes: doc ? doc.nodes.length : -1,
    docEdges: doc ? (doc.edges || []).length : -1,
    svgRealNodes: real.length,
    fullyVisible: fully,
    partialVisible: partial,
    visibleNodeIds: visIds.slice(0, 30),
    edgeLabelGroups: connGroups.length,
    edgeLabelsTotal: connTexts.length,
    edgeLabelsVisible: connVisible.length,
    edgeLabelSamples,
    k: (typeof cvPan !== "undefined" ? Math.round(cvPan.k * 10000) / 10000 : null),
    pan: (typeof cvPan !== "undefined" ? { x: Math.round(cvPan.x * 10) / 10, y: Math.round(cvPan.y * 10) / 10 } : null),
    hostW: host ? host.clientWidth : null,
    hostH: host ? host.clientHeight : null,
    hostRect: hr ? { left: Math.round(hr.left), top: Math.round(hr.top), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
    zpct: (() => { const z = document.getElementById("cvZpct"); return z ? z.textContent : null; })(),
    worldTransform: world ? world.style.transform : null,
    fitLast: window.__cvFitLast || null,
    cvFitReadableMin: (() => { try { return CV_FIT_READABLE_MIN; } catch (e) { return null; } })(),
    zoomBounds: (() => { try { return { min: CV_MIN_ZOOM, max: CV_MAX_ZOOM }; } catch (e) { return null; } })(),
    zLow: world ? world.classList.contains("z-low") : null,
  };
});

/** 抽样 3 个节点:text bbox 宽 vs 节点 g 宽 → 溢出条数。附全量统计。 */
const nodeTexts = (page, cnt) => page.evaluate((cnt2) => {
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const nodes = (doc && doc.nodes) || [];
  const known = new Set(nodes.map((x) => String(x.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")].filter((g) => known.has(g.getAttribute("data-node-id")));
  if (!gs.length) return { picked: [], total: 0 };
  const measure = (g) => {
    const id = g.getAttribute("data-node-id");
    const gr = g.getBoundingClientRect();
    let gb = null;
    try { gb = g.getBBox(); } catch (e) { gb = null; }
    const sc = gb && gb.width ? gr.width / gb.width : 1;
    const ts = [...g.querySelectorAll("text")].map((t) => {
      const raw = t.textContent || "";
      const r = t.getBoundingClientRect();
      let bb = null;
      try { bb = t.getBBox(); } catch (e) { bb = null; }
      const wPx = bb ? Math.round(bb.width * sc) : Math.round(r.width);
      return { s: raw.slice(0, 60), len: raw.length, truncated: /(…|\.\.\.)\s*$/.test(raw), wPx };
    });
    const overflow = ts.filter((t) => t.len > 0 && t.wPx > Math.round(gr.width) + 2);
    return { id, nodeW: Math.round(gr.width), nodeH: Math.round(gr.height), maxTextW: Math.max(0, ...ts.map((t) => t.wPx)), overflowCount: overflow.length, overflowTexts: overflow.map((t) => t.s.slice(0, 24)), texts: ts };
  };
  const picks = [];
  for (let i = 0; i < cnt2 && i < gs.length; i++) {
    const idx = Math.floor(((i + 1) * 7 + 3) % gs.length);
    if (!picks.includes(gs[idx])) picks.push(gs[idx]);
  }
  const all = gs.map(measure);
  return {
    total: gs.length,
    picked: picks.map(measure),
    allOverflowNodes: all.filter((x) => x.overflowCount > 0).length,
    allOverflowSamples: all.filter((x) => x.overflowCount > 0).slice(0, 6).map((x) => x.id + "(" + x.maxTextW + ">" + x.nodeW + ")"),
  };
}, cnt);

const press = (page, id) => page.evaluate((bid) => {
  const b = document.getElementById(bid);
  if (!b) return "missing";
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
  return "dispatch";
}, id);

const shot = async (page, name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); out.shots.push(p); console.log("[shot] " + p + " " + fs.statSync(p).size + "B"); };

/** 一块板的完整取证:打开 → viewBox/边标签/抽样文本 → 「适」→ 「全」。 */
async function probeBoard(tag, fix, shotPrefix) {
  const r = { tag, fixture: { sid: fix.sid, task: fix.taskId, nodes: fix.nodes, edges: fix.edges } };
  const opened = await openPage(fix.sid);
  const page = opened.page;
  try {
    r.svgKids = opened.kids;
    const s0 = await snap(page);
    r.viewBox = { raw: s0.viewBox, ...(s0.vbWH || {}) };
    r.docNodes = s0.docNodes;
    r.docEdges = s0.docEdges;
    r.svgRealNodes = s0.svgRealNodes;
    r.cvFitReadableMin = s0.cvFitReadableMin;
    r.zoomBounds = s0.zoomBounds;
    r.host = { clientW: s0.hostW, clientH: s0.hostH, rect: s0.hostRect };
    r.kInitial = s0.k;
    r.edgeLabels = { groups: s0.edgeLabelGroups, total: s0.edgeLabelsTotal, visible: s0.edgeLabelsVisible, samples: s0.edgeLabelSamples };
    r.textSample = await nodeTexts(page, 3);
    console.log("[" + tag + "] viewBox=" + s0.viewBox + " k0=" + s0.k + " nodes=" + s0.docNodes + "/" + s0.svgRealNodes + " labels=" + s0.edgeLabelsVisible + "/" + s0.edgeLabelsTotal);

    // 「全」
    await press(page, "cvZall"); await page.waitForTimeout(800);
    const sAll = await snap(page);
    r.all = { k: sAll.k, fullyVisible: sAll.fullyVisible, partialVisible: sAll.partialVisible, visibleOf: sAll.fullyVisible + "/" + s0.docNodes, zpct: sAll.zpct, fitLast: sAll.fitLast, edgeLabelsVisible: sAll.edgeLabelsVisible, zLow: sAll.zLow, hostW: sAll.hostW, hostH: sAll.hostH };
    await shot(page, shotPrefix + "-all.png");

    // 「适」
    await press(page, "cvZfit"); await page.waitForTimeout(800);
    const sFit = await snap(page);
    r.fit = { k: sFit.k, fullyVisible: sFit.fullyVisible, partialVisible: sFit.partialVisible, visibleOf: sFit.fullyVisible + "/" + s0.docNodes, zpct: sFit.zpct, worldTransform: sFit.worldTransform, fitLast: sFit.fitLast, edgeLabelsVisible: sFit.edgeLabelsVisible, edgeLabelSamples: sFit.edgeLabelSamples, hostClientW: sFit.hostW, hostClientH: sFit.hostH, zLow: sFit.zLow, visibleNodeIds: sFit.visibleNodeIds };
    r.viewBoxAfterFit = sFit.viewBox;
    await shot(page, shotPrefix + "-fit.png");
    console.log("[" + tag + "] all k=" + r.all.k + " vis=" + r.all.visibleOf + " | fit k=" + r.fit.k + " vis=" + r.fit.visibleOf + " host=" + sFit.hostW + "x" + sFit.hostH + " labelsFit=" + r.fit.edgeLabelsVisible);
  } finally {
    try { await page.close(); } catch (e) { /* 忽略 */ }
  }
  return r;
}

try {
  out.before = {
    source: "apps/gateway/test/ui/shots/before-baseline.json",
    at: before.at || null,
    "17nodes": {
      viewBox: bm["A.viewBox"] || null,
      viewBoxWH: bm["A.viewBoxWH"] || null,
      fitK: bm["F.fit.k"] === undefined ? null : bm["F.fit.k"],
      fitVisible: bm["F.fit.fullyVisible"] === undefined ? null : bm["F.fit.fullyVisible"] + "/" + (bm["B.docNodes"] || 17),
      fitPartial: bm["F.fit.partialVisible"] === undefined ? null : bm["F.fit.partialVisible"],
      allK: bm["E.all.k"] === undefined ? null : bm["E.all.k"],
      allVisible: bm["E.all.fullyVisible"] === undefined ? null : bm["E.all.fullyVisible"] + "/" + (bm["B.docNodes"] || 17),
      edgeLabels: bm["B.edgeLabels"] === undefined ? null : bm["B.edgeLabels"],
      nodeTextsOverflow: bm["B.nodeTextsOverflow"] === undefined ? null : bm["B.nodeTextsOverflow"],
      s11: (bm["C.sample"] && bm["C.sample"].picked ? (bm["C.sample"].picked.find((x) => x.id === "s11") || null) : null),
    },
    "60nodes": {
      viewBox: bm["60.viewBox"] || null,
      fitK: bm["60.fit.k"] === undefined ? null : bm["60.fit.k"],
      fitVisible: bm["60.fit.fullyVisible"] === undefined ? null : bm["60.fit.fullyVisible"] + "/" + (bm["60.docNodes"] || 60),
      allK: bm["60.all.k"] === undefined ? null : bm["60.all.k"],
      allVisible: bm["60.all.fullyVisible"] === undefined ? null : bm["60.all.fullyVisible"] + "/" + (bm["60.docNodes"] || 60),
    },
  };
  out.boards["17nodes"] = await probeBoard("17nodes", fix17, "layout-after-17");
  out.boards["60nodes"] = await probeBoard("60nodes", fix60, "layout-after-60");

  // 一屏可读性归因:k 是否被钳
  for (const k of ["17nodes", "60nodes"]) {
    const b = out.boards[k];
    if (!b || !b.fit) continue;
    const fl = b.fit.fitLast || {};
    b.fitDiagnosis = {
      k: b.fit.k,
      readableMin: b.cvFitReadableMin,
      naturalK: fl.k !== undefined ? fl.k : null,
      clampedByReadableMin: !!(b.cvFitReadableMin !== null && b.fit.k !== null && Math.abs(b.fit.k - b.cvFitReadableMin) < 1e-6),
      contentW: fl.w !== undefined ? fl.w : null,
      viewW: fl.view ? fl.view.w : null,
      overflowPx: fl.w && fl.view ? Math.round(fl.w - fl.view.w / Math.max(1e-6, b.fit.k)) : null,
      hostClientW: b.fit.hostClientW,
      hostClientH: b.fit.hostClientH,
      note: "「适」k 被 CV_FIT_READABLE_MIN 钳住时,内容宽 k*contentW 会大于视口宽 → 一屏只能看见左边一小块",
    };
  }
} catch (e) {
  out.errors.push("fatal: " + String((e && e.stack) || e).slice(0, 900));
  console.log("[fatal] " + String((e && e.stack) || e).slice(0, 900));
} finally {
  try { await browser.close(); } catch (e) { /* 忽略 */ }
  try { if (server) await server.close(); } catch (e) { /* 忽略 */ }
  // 平铺成任务书要求的形状:{board:"17nodes", viewBox:{w,h,ratio}, before:{...}, after:{...}}
  const flat = { at: out.at, port: out.port, beforeSource: out.before.source, errors: out.errors, shots: out.shots };
  for (const k of ["17nodes", "60nodes"]) {
    const b = out.boards[k];
    if (!b) continue;
    const bf = out.before[k] || {};
    flat[k] = {
      board: k,
      viewBox: b.viewBox ? { w: b.viewBox.w, h: b.viewBox.h, ratio: b.viewBox.ratio } : null,
      docNodes: b.docNodes,
      svgRealNodes: b.svgRealNodes,
      before: { viewBox: bf.viewBox, ratio: bf.viewBoxWH ? bf.viewBoxWH.ratio : null, fitK: bf.fitK, fitVisible: bf.fitVisible, allK: bf.allK, allVisible: bf.allVisible, edgeLabels: bf.edgeLabels === undefined ? null : bf.edgeLabels },
      after: {
        ratio: b.viewBox ? b.viewBox.ratio : null,
        fitK: b.fit ? b.fit.k : null,
        fitVisible: b.fit ? b.fit.visibleOf : null,
        fitPartial: b.fit ? b.fit.partialVisible : null,
        fitZpct: b.fit ? b.fit.zpct : null,
        fitEdgeLabelsVisible: b.fit ? b.fit.edgeLabelsVisible : null,
        allK: b.all ? b.all.k : null,
        allVisible: b.all ? b.all.visibleOf : null,
        allPartial: b.all ? b.all.partialVisible : null,
        allZpct: b.all ? b.all.zpct : null,
        edgeLabelsVisible: b.edgeLabels ? b.edgeLabels.visible : null,
        edgeLabelsTotal: b.edgeLabels ? b.edgeLabels.total : null,
        textOverflowSampled3: b.textSample && b.textSample.picked ? b.textSample.picked.filter((x) => x.overflowCount > 0).length + "/" + b.textSample.picked.length : null,
        textOverflowAllNodes: b.textSample ? b.textSample.allOverflowNodes + "/" + b.textSample.total : null,
        hostClient: b.fit ? b.fit.hostClientW + "x" + b.fit.hostClientH : null,
      },
      diagnosis: b.fitDiagnosis || null,
      detail: b,
    };
  }
  flat.before17Detail = out.before["17nodes"];
  flat.before60Detail = out.before["60nodes"];
  const outFile = path.join(SHOTS, "layout-after-canvas.json");
  fs.writeFileSync(outFile, JSON.stringify(flat, null, 1));
  console.log("\n=== " + outFile + " ===");
  for (const k of ["17nodes", "60nodes"]) if (flat[k]) console.log(k + " → " + JSON.stringify({ ratio: flat[k].viewBox && flat[k].viewBox.ratio, before: flat[k].before, after: flat[k].after }));
  console.log("errors: " + JSON.stringify(out.errors.slice(0, 6)));
  process.exit(0);
}
