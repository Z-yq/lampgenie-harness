/** 编辑态平移取证探针。
 *  骨架抄 probe_canvas_after.mjs;自起临时实例(默认 7794,占用则 7795),**绝不碰 7700**。
 *  取证点:panel.ts 的 svg 平移分支部删掉了编辑态早退 `if (cvMode === "svg" && cvSvgNodeAt(e) && boardEditOn) return;`
 *  → 编辑态按住图元拖也应平移整图。量三项(真 page.mouse,各 +20px×6 = 120px 右移):
 *   A 非编辑态:节点中心拖 120px → cvPan 位移应 ≈120;
 *   B 编辑态(boardEditOn===true):节点中心拖 120px → 位移应 ≈120(改前为 0);
 *   C 编辑态空白处拖 120px → 位移应 ≈120;
 *   另记 B 前后 boardDoc.nodes 长度(拖动不该改结构)。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_pan_editmode.mjs
 *  输出:test/ui/shots/pan-editmode-{before,after}.png + pan-editmode.json
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

fs.mkdirSync(SHOTS, { recursive: true });
const out = { at: new Date().toISOString(), A: null, B: null, C: null, shots: [], errors: [], port: null };

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

/* ---------- 端口:7794,占用则 7795(绝不 7700) ---------- */
const app = (await import("../../src/app.ts")).createGatewayApp({ useExternalHttp: true, journalDir: mkdtempSync(path.join(tmpdir(), "probepan-")) });
const { servePanel } = await import("../../src/panel.ts");
let PORT = 0, server = null;
for (const p of [Number(process.env.SELF_PORT || 7794), 7795]) {
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
if (!PORT) skip("7794/7795 都被占用");
out.port = PORT;
const BASE = "http://127.0.0.1:" + PORT;
console.log("[port] " + PORT);

/* ---------- 临时 SID + 板副本(status=implementing) ---------- */
const SID = "ui-probe-pan-" + PORT;
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
  page.on("response", (r) => { if (r.status() >= 400) out.errors.push("http" + r.status() + ": " + r.url().replace(BASE, "")); });
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

/** 画布快照:节点数、cvPan、编辑态。 */
const snap = (page) => page.evaluate(() => {
  const doc = (typeof boardDoc !== "undefined" && boardDoc) || null;
  const known = new Set(((doc && doc.nodes) || []).map((n) => String(n.id)));
  const gs = [...document.querySelectorAll("#cvSvgHost [data-node-id]")];
  const real = gs.filter((g) => known.has(g.getAttribute("data-node-id")));
  return {
    docNodes: doc ? doc.nodes.length : -1,
    docEdges: doc ? (doc.edges || []).length : -1,
    svgNodeEls: gs.length,
    svgRealNodes: real.length,
    pan: (typeof cvPan !== "undefined" ? { x: Math.round(cvPan.x * 10) / 10, y: Math.round(cvPan.y * 10) / 10, k: Math.round(cvPan.k * 10000) / 10000 } : null),
    boardEditOn: (typeof boardEditOn !== "undefined" ? !!boardEditOn : null),
    selNode: (typeof boardSelNode !== "undefined" ? boardSelNode : null),
    toasts: [...document.querySelectorAll("#toastHost .toast")].map((e) => e.textContent).slice(-3),
  };
});

/** 找一个「真命中该节点」的可视节点中心(在视口内 + elementFromPoint 回指它)。 */
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
      if (el.closest && el.closest(".bf-zoombar,.bf-minimap,.cv-addbar,.cv-addpanel,.cv-wbar,.cv-rail,.cv-lbar,.cv-ctx,.cv-link-word,.cv-link-hint,.cv-matrix-btn,.cv-ui-mode-btn,.bf-edit-insp,.bf-edit")) continue;
      if (el.closest && el.closest("[data-node-id]")) continue;
      return { x: Math.round(x), y: Math.round(y) };
    }
  }
  return null;
});

const shot = async (page, name) => { const p = path.join(SHOTS, name); await page.screenshot({ path: p }); out.shots.push(p); console.log("[shot] " + p); };

/** 真鼠标:在 (pt) 按下,分 6 步各 +20px 右移,抬起;返回 cvPan 位移。 */
async function dragRight(page, pt, label) {
  const before = await snap(page);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(pt.x + 20 * i, pt.y);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await snap(page);
  const dx = before.pan && after.pan ? Math.round((after.pan.x - before.pan.x) * 10) / 10 : null;
  const dy = before.pan && after.pan ? Math.round((after.pan.y - before.pan.y) * 10) / 10 : null;
  console.log("[drag " + label + "] at=(" + pt.x + "," + pt.y + ") dx=" + dx + " dy=" + dy + " editOn=" + after.boardEditOn + " nodes=" + after.docNodes + " panBefore=" + JSON.stringify(before.pan) + " panAfter=" + JSON.stringify(after.pan));
  return { label, at: { x: pt.x, y: pt.y }, dx, dy, panBefore: before.pan, panAfter: after.pan, boardEditOnBefore: before.boardEditOn, boardEditOnAfter: after.boardEditOn, docNodesBefore: before.docNodes, docNodesAfter: after.docNodes, selAfter: after.selNode };
}

let page = null;
try {
  page = await openPage(SID);
  const s0 = await snap(page);
  console.log("[open] " + JSON.stringify({ docNodes: s0.docNodes, svgNodeEls: s0.svgNodeEls, svgReal: s0.svgRealNodes, pan: s0.pan, boardEditOn: s0.boardEditOn }));

  /* ================= A 非编辑态:节点中心拖 120px ================= */
  const ptA = await nodePoint(page);
  if (!ptA) throw new Error("A: 找不到可拖的节点中心");
  out.A = await dragRight(page, ptA, "A-非编辑态-节点");
  out.A.verdict = out.A.dx !== null && out.A.dx >= 100 && out.A.dx <= 140 ? "PASS" : "FAIL";
  await shot(page, "pan-editmode-A-nonedit.png");
  console.log("[A] dx=" + out.A.dx + " → " + out.A.verdict);

  /* ================= B 编辑态:节点中心拖 120px ================= */
  // 先试真按钮;点完 boardEditOn 仍 false 就 evaluate 直置
  let viaBtn = null;
  try {
    await page.click("#boardEditBtn");
    await page.waitForTimeout(1200);
    viaBtn = (await snap(page)).boardEditOn;
  } catch (e) { out.errors.push("boardEditBtn click: " + String(e).slice(0, 200)); }
  if (viaBtn !== true) {
    console.log("[B] #boardEditBtn 点后 boardEditOn=" + JSON.stringify(viaBtn) + " → evaluate 直置");
    await page.evaluate(() => { try { boardEditOn = true; boardDraft = boardDoc ? JSON.parse(JSON.stringify(boardDoc)) : null; renderBoard(); } catch (e) { /* 旧壳 */ } });
    await page.waitForTimeout(1500);
  }
  // 等 svg 重渲
  for (let i = 0; i < 12; i++) {
    const k = await page.evaluate(() => { const s = document.querySelector("#cvSvgHost svg"); return s ? s.childElementCount : 0; });
    if (k > 2) break;
    await page.waitForTimeout(500);
  }
  const sB0 = await snap(page);
  out.B = { editViaButton: viaBtn, boardEditOn: sB0.boardEditOn, docNodesBefore: sB0.docNodes, docEdgesBefore: sB0.docEdges, panBeforeShot: sB0.pan };
  console.log("[B] 编辑态就绪 boardEditOn=" + sB0.boardEditOn + " docNodes=" + sB0.docNodes);
  await shot(page, "pan-editmode-before.png");
  const ptB = await nodePoint(page);
  if (!ptB) throw new Error("B: 编辑态找不到可拖的节点中心(可能被编辑器浮层盖住)");
  const rB = await dragRight(page, ptB, "B-编辑态-节点");
  out.B.drag = rB;
  out.B.dx = rB.dx;
  out.B.dxRange = { min: 100, max: 140 };
  out.B.docNodesAfterDrag = rB.docNodesAfter;
  out.B.structureUnchanged = rB.docNodesBefore === rB.docNodesAfter;
  out.B.verdict = rB.dx !== null && rB.dx >= 100 && rB.dx <= 140 ? "PASS" : "FAIL";
  await shot(page, "pan-editmode-after.png");
  console.log("[B] dx=" + rB.dx + " nodes " + rB.docNodesBefore + "→" + rB.docNodesAfter + " → " + out.B.verdict);

  /* ================= C 对照:编辑态空白处拖 120px ================= */
  const ptC = await blankPoint(page);
  if (!ptC) throw new Error("C: 编辑态找不到空白落点");
  const rC = await dragRight(page, ptC, "C-编辑态-空白");
  out.C = { drag: rC, dx: rC.dx, boardEditOn: rC.boardEditOnAfter, verdict: rC.dx !== null && rC.dx >= 100 && rC.dx <= 140 ? "PASS" : "FAIL" };
  await shot(page, "pan-editmode-C-blank.png");
  console.log("[C] dx=" + rC.dx + " → " + out.C.verdict);

  out.summary = { "A.dx": out.A.dx, "B.dx": out.B.dx, "C.dx": out.C.dx, boardEditOnDuringB: out.B.boardEditOn, nodesBeforeB: out.B.docNodesBefore, nodesAfterB: out.B.docNodesAfter, structureUnchanged: out.B.structureUnchanged };
  console.log("[summary] " + JSON.stringify(out.summary));
} catch (e) {
  out.errors.push("fatal: " + String((e && e.stack) || e).slice(0, 800));
  console.log("[fatal] " + String((e && e.stack) || e).slice(0, 800));
} finally {
  try { if (page) await page.close(); } catch (e) { /* 忽略 */ }
  try { await browser.close(); } catch (e) { /* 忽略 */ }
  try { if (server) await server.close(); } catch (e) { /* 忽略 */ }
  fs.writeFileSync(path.join(SHOTS, "pan-editmode.json"), JSON.stringify(out, null, 1));
  console.log("\n=== json: " + path.join(SHOTS, "pan-editmode.json") + " ===");
  console.log("errors: " + JSON.stringify(out.errors.slice(0, 8)));
  process.exit(0);
}
