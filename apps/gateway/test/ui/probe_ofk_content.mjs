/** board-ofk desc 内容层级「改前/改后」取证探针(2026-11,三段式:是什么/有什么用/在哪)。
 *  量:每节点 <text> bbox 宽 vs 节点卡宽(溢出条数)/ 带 `…` 的 desc 条数 / 边 label 条数。
 *  改前基线来源:旧口径序列化器副本(仅 summary 不取首句、clip 不补 `…`、边无 label 不兜底),
 *  与改后走**同一条 flowkit 渲染管线**,故两侧数值可直接对比。
 *  自起临时 http 端口 7793(改后)/7794(改前),不碰 7700。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_ofk_content.mjs
 *  输出:test/ui/shots/ofk-before.png / ofk-after.png / ofk-content.json
 */
process.env.GENIE_CHECKPOINT = "off";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const SHOTS = path.join(__dirname, "shots");
const SRC17 = path.join(HARNESS_ROOT, ".genie", "boards", "web-ng-tasksm-1793811933881", "c78b0e83-2956-4245-b080-1048c53b6a47.json");
const BEFORE_MOD = process.env.OFK_BEFORE_MOD || "/tmp/ofk-before.ts";

const skip = (why) => { console.log("skipped: " + why); process.exit(0); };
let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch { chromium = null; }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome " + CHROME);
if (!fs.existsSync(SRC17)) skip("无 17 节点板 " + SRC17);
if (!fs.existsSync(BEFORE_MOD)) skip("旧口径序列化器副本缺失 " + BEFORE_MOD);

fs.mkdirSync(SHOTS, { recursive: true });
const out = { at: new Date().toISOString(), board: path.basename(SRC17), src: "17 节点真板", metrics: {}, notes: [] };
const note = (k, v) => { out.metrics[k] = v; console.log("[metric] " + k + " = " + JSON.stringify(v)); };

const doc = JSON.parse(fs.readFileSync(SRC17, "utf-8"));
const { serializeBoard: serializeNew } = await import("../../src/board-ofk.ts");
const beforeMod = await import(BEFORE_MOD);
// /tmp 下的 .ts 无 package.json type:module,tsx 走 CJS 互操作 → 具名导出挂在 default 上。
const serializeOld = beforeMod.serializeBoard ?? beforeMod.default?.serializeBoard;
if (typeof serializeOld !== "function") throw new Error("旧口径序列化器载入失败: " + BEFORE_MOD);

/** 与 src/board-diagram.ts 同管线:OFK → create_diagram(ELK 布局)→ export svg。 */
async function ofkToSvg(ofkText) {
  const m = await import("@openflowkit/openflowkit-mcp/dist/generated/openflowkit-agent.js");
  const document = m.createAgentDocument("board");
  const pageId = document.pages[0].id;
  const elk = m.headlessElkLayout;
  const capabilities = {
    ...(await m.createFileCapabilities({})),
    compileWorkspace: (t, o) => m.compileWorkspace(t, elk ? { ...(o ?? {}), layout: elk } : (o ?? {})),
  };
  const created = await m.runAgentOp(m.findAgentOp("create_diagram"), { dsl: ofkText }, { document, pageId, capabilities });
  const exported = await m.runAgentOp(
    m.findAgentOp("export"),
    { format: "svg", scope: "page", theme: "light" },
    { document: created?.document ?? document, pageId, capabilities },
  );
  const svg = exported?.output?.files?.[0]?.text;
  if (typeof svg !== "string" || !svg.trim()) throw new Error("flowkit export 未返回 SVG");
  const diags = [...(created?.output?.diagnostics ?? []), ...(exported?.output?.diagnostics ?? [])];
  return { svg, diags: diags.map((d) => ({ code: String(d.code), severity: String(d.severity), message: String(d.message) })) };
}

const before = serializeOld(doc);
const after = serializeNew(doc);
out.dsl = {
  before: { desc: before.ofk.split("\n").filter((l) => l.includes("desc:")).length, edgeWithLabel: before.ofk.split("\n").filter((l) => /^\s*[^\s]+\s+(->|-->|--)\s+[^\s]+\s+:\s/.test(l)).length, warnings: before.warnings.length },
  after: { desc: after.ofk.split("\n").filter((l) => l.includes("desc:")).length, edgeWithLabel: after.ofk.split("\n").filter((l) => /^\s*[^\s]+\s+(->|-->|--)\s+[^\s]+\s+:\s/.test(l)).length, warnings: after.warnings.length },
};
const svgBefore = await ofkToSvg(before.ofk);
const svgAfter = await ofkToSvg(after.ofk);
for (const [tag, r] of [["before", svgBefore], ["after", svgAfter]]) {
  const bad = r.diags.filter((d) => d.severity === "error" || /^E_|^W101$/.test(d.code));
  out.notes.push(`${tag}: flowkit diags=${JSON.stringify(r.diags.slice(0, 6))} errorish=${bad.length}`);
}

/** 临时端口(7793/7794)各起一个静态页,只服务这一张 SVG——不碰 7700 的网关。 */
function serve(svg, port) {
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff}</style>${svg}`;
  const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

const PORTS = { before: 7794, after: 7793 };
const srvBefore = await serve(svgBefore.svg, PORTS.before);
const srvAfter = await serve(svgAfter.svg, PORTS.after);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });

/** 逐节点量:节点卡 rect 宽 vs 内部 <text> bbox 宽(同一用户坐标系,不需缩放换算)。 */
const measure = (page) => page.evaluate(() => {
  const svg = document.querySelector("svg");
  // 节点卡形状有 rect / path(ellipse、diamond 等),统一用首个形状元素 bbox 宽当卡宽。
  const shapeSel = "rect,path,ellipse,circle,polygon,polyline";
  const nodes = [...svg.querySelectorAll("g[data-node-id]")];
  const edges = [...svg.querySelectorAll("g[data-connector-id]")];
  let overflow = 0, ellipsisNodes = 0, descCount = 0, textMax = 0;
  const samples = [];
  let realNodes = 0;
  for (const g of nodes) {
    if (g.querySelector("g[data-node-id]")) continue; // 泳道/分组容器(内含节点)
    const shape = g.querySelector(shapeSel);    if (!shape) continue;
    let cb = null;
    try { cb = shape.getBBox(); } catch { cb = null; }
    if (!cb) continue;
    const cw = Math.round(cb.width);
    if (cw < 40) continue; // 泳道/分组容器
    realNodes++;
    let maxOver = 0, maxText = null, nodeTextMax = 0, nodeHasEllipsis = false, descText = null;
    for (const t of g.querySelectorAll("text")) {
      const raw = (t.textContent || "").trim();
      if (!raw) continue;
      if (raw.includes("…")) nodeHasEllipsis = true;
      let bb = null;
      try { bb = t.getBBox(); } catch { bb = null; }
      if (!bb) continue;
      nodeTextMax = Math.max(nodeTextMax, Math.round(bb.width));
      if (bb.width > textMax) textMax = Math.round(bb.width);
      const over = Math.round(bb.width - cw);
      if (over > 0 && over > maxOver) { maxOver = over; maxText = raw.slice(0, 60); }
      if (raw.length > 40 && (!descText || raw.length > descText.length)) descText = raw;
    }
    if (nodeHasEllipsis) ellipsisNodes++;
    if (descText) descCount++;
    if (maxOver > 2) {
      overflow++;
      samples.push({ id: g.getAttribute("data-node-id"), cardW: cw, textW: nodeTextMax, over: maxOver, text: maxText });
    }
  }
  const edgeTexts = edges.map((g) => (g.querySelector("text")?.textContent || "").trim()).filter(Boolean);
  return {
    nodes: realNodes,
    nodeTextOverflow: overflow,
    descTexts: descCount,
    descWithEllipsis: ellipsisNodes,
    edgeLabelTexts: edgeTexts.length,
    edgeLabelSamples: edgeTexts.slice(0, 8),
    maxTextW: textMax,
    overflowSamples: samples.slice(0, 6),
  };
});

const runSide = async (tag, port) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const m = await measure(page);
  const svgBox = await page.evaluate(() => { const r = document.querySelector("svg").getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  await page.setViewportSize({ width: Math.min(4000, Math.max(1200, svgBox.w)), height: Math.min(2400, Math.max(800, svgBox.h)) });
  await page.waitForTimeout(200);
  const shot = path.join(SHOTS, `ofk-${tag}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  out.shots = [...(out.shots || []), shot];
  await page.close();
  note(`${tag}.svgWH`, svgBox);
  for (const [k, v] of Object.entries(m)) note(`${tag}.${k}`, v);
  return m;
};

try {
  const mBefore = await runSide("before", PORTS.before);
  const mAfter = await runSide("after", PORTS.after);
  out.delta = {
    nodeTextOverflow: `${mBefore.nodeTextOverflow} → ${mAfter.nodeTextOverflow}`,
    descWithEllipsis: `${mBefore.descWithEllipsis} → ${mAfter.descWithEllipsis}`,
    edgeLabelTexts: `${mBefore.edgeLabelTexts} → ${mAfter.edgeLabelTexts}`,
    maxTextW: `${mBefore.maxTextW} → ${mAfter.maxTextW}`,
  };
  console.log("[delta] " + JSON.stringify(out.delta));
} catch (err) {
  out.errors = [String(err && err.stack || err)];
  console.error("[error] " + err);
} finally {
  await browser.close();
  srvBefore.close(); srvAfter.close();
  fs.writeFileSync(path.join(SHOTS, "ofk-content.json"), JSON.stringify(out, null, 1));
  console.log("[written] " + path.join(SHOTS, "ofk-content.json"));
}
