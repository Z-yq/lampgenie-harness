/** 画布「改前基线」一次性取证探针(2026-11-05)。
 *  只读实测:不改 src。自起临时实例(默认 7791,不碰 7700),板副本落独立 SID。
 *  量:viewBox 宽高比 / 节点与 text 数量 / 3 个节点文本(截断判据) / cvPan.k 与字号 /
 *      「全」「适」缩放与一屏完整可见节点数 / 添加模块全链路(含 WS frame 序列) / 真事件平移对照。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_canvas_baseline.mjs
 *  输出:apps/gateway/test/ui/shots/before-*.png + before-baseline.json
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
const PORT = Number(process.env.SELF_PORT || 7791);
const SHOTS = path.join(__dirname, "shots");
const VIEWPORT = { width: 1400, height: 900 };
const BOARDS = path.join(HARNESS_ROOT, ".genie", "boards");
const SRC17 = path.join(BOARDS, "web-ng-tasksm-1793811933881", "c78b0e83-2956-4245-b080-1048c53b6a47.json");
const SRC60 = path.join(BOARDS, "web-1792774467576", "dec3a2d2-b812-4fe1-899b-c2a91365ea26.json");
const SID17 = "ui-probe-base17-" + PORT;
const SID60 = "ui-probe-base60-" + PORT;

const skip = (why) => { console.log("skipped: " + why); process.exit(0); };
let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch (e) { chromium = null; }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome " + CHROME);
if (!fs.existsSync(SRC17)) skip("无 17 节点板 " + SRC17);
if (!fs.existsSync(SRC60)) skip("无 60 节点板 " + SRC60);

fs.mkdirSync(SHOTS, { recursive: true });
const out = { at: new Date().toISOString(), metrics: {}, add: {}, pan: {}, shots: [], errors: [] };
const note = (k, v) => { out.metrics[k] = v; console.log("[metric] " + k + " = " + JSON.stringify(v)); };

function stageBoard(src, sid) {
  const taskId = path.basename(src, ".json");
  const dir = path.join(BOARDS, sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) fs.unlinkSync(path.join(dir, f));
  const doc = JSON.parse(fs.readFileSync(src, "utf-8"));
  doc.sessionId = sid;
  doc.status = "implementing";
  const file = path.join(dir, taskId + ".json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 1));
  console.log("[fixture] " + sid + " ← " + path.basename(src) + " nodes=" + (doc.nodes || []).length + " status=implementing");
  return { sid, taskId, nodes: (doc.nodes || []).length, file };
}
// 前置:打印候选源各文件节点数(挑最接近 17 的依据)
for (const f of fs.readdirSync(path.dirname(SRC17)).filter((x) => x.endsWith(".json"))) {
  try { const j = JSON.parse(fs.readFileSync(path.join(path.dirname(SRC17), f), "utf-8")); console.log("[cand] " + f + " nodes=" + ((j.nodes || []).length) + " edges=" + ((j.edges || []).length)); } catch (e) { /* 坏文件 */ }
}
const fix17 = stageBoard(SRC17, SID17);
const fix60 = stageBoard(SRC60, SID60);

const { createGatewayApp } = await import("../../src/app.ts");
const { servePanel } = await import("../../src/panel.ts");
const jd = mkdtempSync(path.join(tmpdir(), "probebase-"));
const app = createGatewayApp({ useExternalHttp: true, journalDir: jd });
servePanel(PORT, (srv) => app.attachWs(srv));
const BASE = "http://127.0.0.1:" + PORT;
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
  page.on("pageerror", (e) => out.errors.push("pageerror: " + String(e).slice(0, 200)));
  // WS 收发帧记录(时间戳 + type [+ board.save 的节点数 / diagram 回包 svg 长度])
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
          try { const m = JSON.parse(d); window.__frames.push({ t: Date.now(), type: m && m.type, nodes: m && m.doc && m.doc.nodes ? m.doc.nodes.length : undefined, svgQ: m && m.type === "board.diagram" ? 1 : undefined }); } catch (e) { /* 非 JSON */ }
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
  return { page, kids };
}

/** 一屏指标快照。 */
const snap = (page) => page.evaluate(() => {
  const svg = document.querySelector("#cvSvgHost svg");
  const vb = svg ? svg.getAttribute("viewBox") : null;
  const p = vb ? String(vb).trim().split(/[\s,]+/).map(Number) : null;
  const texts = svg ? [...svg.querySelectorAll("text")] : [];
  const arrowish = texts.filter((t) => /[｜→]/.test(t.textContent || ""));
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const known = new Set(((doc && doc.nodes) || []).map((n) => String(n.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")];
  const real = gs.filter((g) => known.has(g.getAttribute("data-node-id")));
  const host = document.getElementById("cvHost");
  const hr = host ? host.getBoundingClientRect() : null;
  let fully = 0, partial = 0;
  for (const g of real) {
    const r = g.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (hr && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5 && r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5) fully++;
    else if (hr && r.right > hr.left && r.left < hr.right && r.bottom > hr.top && r.top < hr.bottom) partial++;
  }
  // 边 label:不在任何 [data-node-id] 内、含 ｜ 或 →
  const edgeLabels = texts.filter((t) => !t.closest("[data-node-id]") && /[｜→]/.test(t.textContent || ""));
  // 节点内 text 溢出(宽度超出节点 rect)+ 截断(结尾 … / ...)
  let overflowTexts = 0, truncatedTexts = 0;
  for (const g of real) {
    const gr = g.getBoundingClientRect();
    for (const t of g.querySelectorAll("text")) {
      const raw = t.textContent || "";
      if (/(…|\.\.\.)\s*$/.test(raw)) truncatedTexts++;
      let bb = null;
      try { bb = t.getBBox(); } catch (e) { bb = null; }
      if (bb && gr.width > 2 && bb.width * (gr.width / (g.getBBox ? (g.getBBox().width || 1) : 1)) > gr.width + 4) overflowTexts++;
    }
  }
  // 字号:.cv-foot(若有)/ svg text 计算值 + getBBox 实测高度 / HTML 侧 .cv-aitem 对照
  let font = null;
  const foot = document.querySelector(".cv-foot");
  const probeText = svg ? svg.querySelector("text") : null;
  const fsEl = foot || probeText;
  if (fsEl) {
    const cs = getComputedStyle(fsEl);
    const r = fsEl.getBoundingClientRect();
    let bbH = null;
    try { const bb = fsEl.getBBox ? fsEl.getBBox() : null; bbH = bb ? Math.round(bb.height * 10) / 10 : null; } catch (e) { bbH = null; }
    font = { selector: foot ? ".cv-foot" : "svg text(无 .cv-foot)", fontSize: cs.fontSize, lineHeight: cs.lineHeight, rectH: Math.round(r.height * 10) / 10, rectW: Math.round(r.width * 10) / 10, bboxH: bbH, hasCvFoot: !!foot };
  }
  const aitem = document.querySelector(".cv-addpanel .cv-aitem");
  const world = document.getElementById("cvWorld");
  return {
    viewBox: vb,
    vbWH: p ? { w: p[2], h: p[3], ratio: Math.round((p[2] / p[3]) * 10000) / 10000 } : null,
    docNodes: doc ? doc.nodes.length : -1,
    svgDataNodeIds: gs.length,
    svgRealNodes: real.length,
    texts: texts.length,
    textsArrowish: arrowish.length,
    arrowSamples: arrowish.slice(0, 5).map((t) => (t.textContent || "").slice(0, 30)),
    edgeLabels: edgeLabels.length,
    edgeLabelSamples: edgeLabels.slice(0, 5).map((t) => (t.textContent || "").slice(0, 24)),
    nodeTextsTruncated: truncatedTexts,
    nodeTextsOverflow: overflowTexts,
    fullyVisible: fully,
    partialVisible: partial,
    hostRect: hr ? { left: Math.round(hr.left), top: Math.round(hr.top), w: Math.round(hr.width), h: Math.round(hr.height) } : null,
    zoomBounds: (() => { try { return { min: CV_MIN_ZOOM, max: CV_MAX_ZOOM }; } catch (e) { return null; } })(),
    fitLast: window.__cvFitLast || null,
    k: (typeof cvPan !== "undefined" ? Math.round(cvPan.k * 10000) / 10000 : null),
    pan: (typeof cvPan !== "undefined" ? { x: Math.round(cvPan.x * 10) / 10, y: Math.round(cvPan.y * 10) / 10 } : null),
    hostW: host ? host.clientWidth : null,
    hostH: host ? host.clientHeight : null,
    zpct: (() => { const z = document.getElementById("cvZpct"); return z ? z.textContent : null; })(),
    worldTransform: world ? world.style.transform : null,
    font,
    htmlFont: aitem ? getComputedStyle(aitem).fontSize : null,
    toasts: [...document.querySelectorAll("#toastHost .toast")].map((e) => e.textContent),
  };
});

const nodeTexts = (page, n) => page.evaluate((cnt) => {
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const nodes = (doc && doc.nodes) || [];
  const known = new Set(nodes.map((x) => String(x.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")].filter((g) => known.has(g.getAttribute("data-node-id")));
  if (!gs.length) return { picked: [], note: "svg 里无真节点" };
  const picks = [];
  for (let i = 0; i < cnt && i < gs.length; i++) {
    const idx = Math.floor(((i + 1) * 7 + 3) % gs.length);
    picks.push(gs[idx]);
  }
  return {
    total: gs.length,
    picked: picks.map((g) => {
      const id = g.getAttribute("data-node-id");
      const gr = g.getBoundingClientRect();
      let gb = null;
      try { gb = g.getBBox(); } catch (e) { gb = null; }
      const ts = [...g.querySelectorAll("text")].map((t) => {
        const raw = t.textContent || "";
        const r = t.getBoundingClientRect();
        let bb = null;
        try { bb = t.getBBox(); } catch (e) { bb = null; }
        return { s: raw, len: raw.length, truncated: /(…|\.\.\.)\s*$/.test(raw), w: Math.round(r.width), h: Math.round(r.height), bboxW: bb ? Math.round(bb.width) : null };
      });
      const docNode = nodes.find((x) => String(x.id) === id) || {};
      const maxTextW = Math.max(0, ...ts.map((t) => (t.bboxW || 0) * (gb && gb.width ? (gr.width / gb.width) : 1)));
      return { id, label: docNode.label || "", summary: (docNode.summary || "").slice(0, 40), nodeRect: { w: Math.round(gr.width), h: Math.round(gr.height) }, textOverflowPx: Math.round(maxTextW - gr.width), texts: ts };
    }),
  };
}, n);

const press = (page, id) => page.evaluate((bid) => {
  const b = document.getElementById(bid);
  if (!b) return "missing";
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
  return "dispatch";
}, id);

const nodePoint = (page) => page.evaluate(() => {
  const h = document.getElementById("cvHost");
  if (!h) return null;
  const hr = h.getBoundingClientRect();
  const known = new Set(((typeof boardDoc !== "undefined" && boardDoc && boardDoc.nodes) || []).map((n) => String(n.id)));
  for (const g of [...document.querySelectorAll("#cvSvgHost [data-node-id]")]) {
    const id = g.getAttribute("data-node-id");
    if (!known.has(id)) continue;
    const r = g.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    if (cx < hr.left + 4 || cx > hr.right - 4 || cy < hr.top + 4 || cy > hr.bottom - 4) continue;
    const el = document.elementFromPoint(cx, cy);
    const hit = el && el.closest ? el.closest("[data-node-id]") : null;
    if (!hit || hit.getAttribute("data-node-id") !== id) continue;
    return { id, x: cx, y: cy };
  }
  return null;
});

const blankPoint = (page) => page.evaluate(() => {
  const h = document.getElementById("cvHost");
  if (!h) return null;
  const hr = h.getBoundingClientRect();
  for (let y = hr.top + 30; y < hr.bottom - 20; y += 23) {
    for (let x = hr.left + 20; x < hr.right - 20; x += 37) {
      const el = document.elementFromPoint(x, y);
      if (!el || !h.contains(el)) continue;
      if (el.closest && el.closest(".bf-zoombar,.bf-minimap,.cv-addbar,.cv-addpanel,.cv-wbar,.cv-rail,.cv-lbar,.cv-ctx")) continue;
      if (el.closest && el.closest("[data-node-id]")) continue;
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
});

const shot = async (page, name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); out.shots.push(p); console.log("[shot] " + p); };
const framesSince = (page, t) => page.evaluate((tt) => ({
  sent: window.__frames.filter((f) => f.t >= tt),
  recv: window.__recv.filter((f) => f.t >= tt),
}), t);

let page = null;
try {
  const opened = await openPage(SID17);
  page = opened.page;
  console.log("[open] 17 节点板 svg children=" + opened.kids);
  note("hook.wsFramesAtOpen", await page.evaluate(() => ({ sent: window.__frames.length, recv: window.__recv.length, types: window.__frames.map((f) => f.type).slice(-6) })));

  // ---------- 2a-2d 基线快照 ----------
  const s0 = await snap(page);
  note("A.viewBox", s0.viewBox);
  note("A.viewBoxWH", s0.vbWH);
  note("B.docNodes", s0.docNodes);
  note("B.svgDataNodeIds", s0.svgDataNodeIds);
  note("B.svgRealNodes", s0.svgRealNodes);
  note("B.texts", s0.texts);
  note("B.textsWithArrowOrBar", s0.textsArrowish);
  note("B.edgeLabels", s0.edgeLabels);
  note("B.edgeLabelSamples", s0.edgeLabelSamples);
  note("B.nodeTextsTruncated", s0.nodeTextsTruncated);
  note("B.nodeTextsOverflow", s0.nodeTextsOverflow);
  note("B.arrowSamples", s0.arrowSamples);
  note("C.sample", await nodeTexts(page, 3));
  note("D.k_initial", s0.k);
  note("D.pan_initial", s0.pan);
  note("D.host", { w: s0.hostW, h: s0.hostH, rect: s0.hostRect });
  note("D.zoomBounds", s0.zoomBounds);
  note("D.font", s0.font);
  note("D.htmlFont", s0.htmlFont);
  note("D.zpct", s0.zpct);

  // ---------- 2e 「全」 ----------
  await press(page, "cvZall"); await page.waitForTimeout(600);
  const sAll = await snap(page);
  note("E.all.k", sAll.k);
  note("E.all.fullyVisible", sAll.fullyVisible);
  note("E.all.partialVisible", sAll.partialVisible);
  note("E.all.zpct", sAll.zpct);
  note("E.all.fitLast", sAll.fitLast);
  await shot(page, "before-17nodes-all.png");

  // ---------- 2f 「适」 ----------
  await press(page, "cvZfit"); await page.waitForTimeout(600);
  const sFit = await snap(page);
  note("F.fit.k", sFit.k);
  note("F.fit.fullyVisible", sFit.fullyVisible);
  note("F.fit.partialVisible", sFit.partialVisible);
  note("F.fit.worldTransform", sFit.worldTransform);
  note("F.fit.zpct", sFit.zpct);
  note("F.fit.fitLast", sFit.fitLast);
  await shot(page, "before-17nodes-fit.png");

  // ---------- 3 添加模块实测(在「适」态) ----------
  const add = { steps: {} };
  add.nodesBefore = (await snap(page)).docNodes;
  const tAdd = await page.evaluate(() => Date.now());
  await press(page, "cvAddBtn"); await page.waitForTimeout(400);
  add.steps.panel = await page.evaluate(() => {
    const p = document.getElementById("cvAddPanel");
    return { display: p ? getComputedStyle(p).display : "missing", items: document.querySelectorAll("#cvAddPanel .cv-aitem").length, inlineDisplay: p ? p.style.display : null };
  });
  note("3a.addPanel", add.steps.panel);
  await shot(page, "before-add-panel.png");
  add.firstItemKind = await page.evaluate(() => { const it = document.querySelector("#cvAddPanel .cv-aitem"); return it ? it.dataset.kind + "/" + it.textContent.trim() : null; });
  // 点第一个 cv-aitem
  add.clicked = await page.evaluate(() => {
    const it = document.querySelector("#cvAddPanel .cv-aitem");
    if (!it) return "missing";
    it.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
    return "dispatch:" + (it.dataset.kind || "");
  });
  await page.waitForTimeout(300);
  add.after300 = await snap(page);
  const f300 = await framesSince(page, tAdd);
  await page.waitForTimeout(2200);
  add.after2500 = await snap(page);
  await shot(page, "before-after-add.png");
  // 关键补充:board.diagram.result 常在 2.5s 之后才回,再看 5.5s / 9s 是否回填画布
  await page.waitForTimeout(3000);
  add.after5500 = await snap(page);
  await shot(page, "before-after-add-late.png");
  await page.waitForTimeout(3500);
  add.after9000 = await snap(page);
  const f2500 = await framesSince(page, tAdd);
  add.frames = { at300: f300, at2500: f2500 };
  add.verdict = {
    inBoardDoc: add.after300.docNodes === add.nodesBefore + 1,
    docNodes: add.nodesBefore + "→300ms:" + add.after300.docNodes + "→2500ms:" + add.after2500.docNodes,
    sentBoardSave: f2500.sent.some((f) => f.type === "board.save"),
    saveFrames: f2500.sent.filter((f) => f.type === "board.save").map((f) => ({ dt: f.t - tAdd, nodes: f.nodes })),
    gotBoardDocBack: f2500.recv.some((f) => f.type === "board.doc"),
    reSentBoardDiagram: f2500.sent.filter((f) => f.type === "board.diagram").map((f) => ({ dt: f.t - tAdd })),
    gotDiagramResult: f2500.recv.filter((f) => f.type === "board.diagram.result").map((f) => ({ dt: f.t - tAdd, ok: f.ok, svgLen: f.svgLen })),
    svgRealNodes: add.after300.svgRealNodes + "→" + add.after2500.svgRealNodes + "→5.5s:" + add.after5500.svgRealNodes + "→9s:" + add.after9000.svgRealNodes + "(before " + sFit.svgRealNodes + ")",
    appearedOnCanvas: add.after2500.svgRealNodes > sFit.svgRealNodes,
    appearedLate: add.after9000.svgRealNodes > sFit.svgRealNodes || add.after5500.svgRealNodes > sFit.svgRealNodes,
    docNodesLate: add.after2500.docNodes + "→5.5s:" + add.after5500.docNodes + "→9s:" + add.after9000.docNodes,
    textsLate: add.after2500.texts + "→5.5s:" + add.after5500.texts + "→9s:" + add.after9000.texts,
    kLate: add.after2500.k + "→5.5s:" + add.after5500.k + "→9s:" + add.after9000.k,
    toastsLate: { at5500: add.after5500.toasts, at9000: add.after9000.toasts },
    diagramsAfter: f2500.sent.filter((f) => f.type === "board.diagram").length,
    textsBeforeAfter: sFit.texts + "→" + add.after2500.texts,
    toasts: add.after2500.toasts,
    frameSeq: f2500.sent.map((f) => f.type).filter((t, i, a) => t !== "board.list" || a[i - 1] !== "board.list"),
  };
  out.add = add;
  console.log("[add] " + JSON.stringify(add.verdict));

  // ---------- 4 平移实测(page.mouse 真事件) ----------
  await press(page, "cvZfit"); await page.waitForTimeout(700);
  const panBeforeNode = await page.evaluate(() => ({ ...cvPan }));
  const np = await nodePoint(page);
  if (np) {
    await page.mouse.move(np.x, np.y);
    await page.mouse.down();
    await page.mouse.move(np.x + 60, np.y, { steps: 3 });
    await page.mouse.move(np.x + 120, np.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(350);
  }
  const panAfterNode = await page.evaluate(() => ({ ...cvPan }));
  const np2 = np ? await page.evaluate((id) => {
    const g = [...document.querySelectorAll("#cvSvgHost [data-node-id]")].find((x) => x.getAttribute("data-node-id") === id);
    if (!g) return null; const r = g.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) };
  }, np.id) : null;
  const blank = await blankPoint(page);
  const panBeforeBlank = await page.evaluate(() => ({ ...cvPan }));
  if (blank) {
    await page.mouse.move(blank.x, blank.y);
    await page.mouse.down();
    await page.mouse.move(blank.x + 60, blank.y, { steps: 3 });
    await page.mouse.move(blank.x + 120, blank.y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(350);
  }
  const panAfterBlank = await page.evaluate(() => ({ ...cvPan }));
  out.pan = {
    nodeStart: np, nodeMovedTo: np2,
    beforeNode: panBeforeNode, afterNode: panAfterNode,
    dNode: { dx: Math.round((panAfterNode.x - panBeforeNode.x) * 10) / 10, dy: Math.round((panAfterNode.y - panBeforeNode.y) * 10) / 10, dk: Math.round((panAfterNode.k - panBeforeNode.k) * 10000) / 10000 },
    blankStart: blank, beforeBlank: panBeforeBlank, afterBlank: panAfterBlank,
    dBlank: { dx: Math.round((panAfterBlank.x - panBeforeBlank.x) * 10) / 10, dy: Math.round((panAfterBlank.y - panBeforeBlank.y) * 10) / 10, dk: Math.round((panAfterBlank.k - panBeforeBlank.k) * 10000) / 10000 },
  };
  console.log("[pan] " + JSON.stringify(out.pan));

  try { await page.close(); } catch (e) { /* 忽略 */ }
  page = null;

  // ---------- 5 60 节点大板 ----------
  const big = await openPage(SID60);
  page = big.page;
  await page.waitForTimeout(600);
  await press(page, "cvZfit"); await page.waitForTimeout(900);
  const s60 = await snap(page);
  note("60.docNodes", s60.docNodes);
  note("60.fit.k", s60.k);
  note("60.fit.fullyVisible", s60.fullyVisible);
  note("60.viewBox", s60.viewBox);
  note("60.texts", s60.texts);
  note("60.fit.fitLast", s60.fitLast);
  await shot(page, "before-60nodes.png");
  await press(page, "cvZall"); await page.waitForTimeout(700);
  const s60all = await snap(page);
  note("60.all.k", s60all.k);
  note("60.all.fullyVisible", s60all.fullyVisible);
  note("60.all.fitLast", s60all.fitLast);
} catch (e) {
  out.errors.push("fatal: " + String(e && e.stack || e).slice(0, 600));
  console.log("[fatal] " + String(e && e.stack || e).slice(0, 600));
} finally {
  try { if (page) await page.close(); } catch (e) { /* 忽略 */ }
  try { await browser.close(); } catch (e) { /* 忽略 */ }
  fs.writeFileSync(path.join(SHOTS, "before-baseline.json"), JSON.stringify(out, null, 1));
  console.log("\n=== baseline json: " + path.join(SHOTS, "before-baseline.json") + " ===");
  console.log("errors: " + JSON.stringify(out.errors));
  process.exit(0);
}
