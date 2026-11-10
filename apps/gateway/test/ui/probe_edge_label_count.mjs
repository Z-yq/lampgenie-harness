/** 真板 SVG 里边标签(label)到底渲染出几条:直接调 renderBoardSvg,数每个 label 文本在 <text> 中的出现。
 *  跑法:cd apps/gateway && node --import tsx test/ui/probe_edge_label_count.mjs [板文件路径]
 *  目的:任务诉求③要求「边关系词在 svg 边上常显」——先确认是数据层缺还是渲染层丢。 */
process.env.GENIE_CHECKPOINT = "off";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const SRC = process.argv[2] || ".genie/boards/web-ng-tasksm-1793811933881/c78b0e83-2956-4245-b080-1048c53b6a47.json";
const doc = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, SRC), "utf-8"));

const { renderBoardSvg } = await import("../../src/board-diagram.ts");
const r = await renderBoardSvg(doc, { theme: "dark" });
const svg = r.svg || "";

// <text> 内容(去标签、去实体)
const texts = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim())
  .filter((t) => t.length > 0);

const vb = (svg.match(/viewBox="([^"]+)"/) || [])[1] || "";
const [minX, minY, w, h] = String(vb).trim().split(/[\s,]+/).map(Number);

const rows = [];
for (const e of doc.edges) {
  const lab = String(e.label || "").trim();
  if (!lab) { rows.push({ edge: e.from + "->" + e.to, label: lab, hit: false, n: 0 }); continue; }
  // 精确整串命中,再退化为前 6 字前缀命中(flowkit 可能折行/加省略)
  let n = texts.filter((t) => t === lab).length;
  if (!n && lab.length > 6) n = texts.filter((t) => t.includes(lab.slice(0, 6))).length;
  rows.push({ edge: e.from + "->" + e.to, label: lab, hit: n > 0, n });
}

const hitN = rows.filter((r2) => r2.hit).length;
console.log(JSON.stringify({
  board: SRC,
  ok: r.ok,
  diags: r.diagnostics.filter((d) => d.severity === "error" || /E_|W101/.test(d.code)).map((d) => d.code + ":" + d.message).slice(0, 6),
  viewBox: vb, ratio: w && h ? +(w / h).toFixed(2) : null,
  nodes: doc.nodes.length, edges: doc.edges.length,
  dataWithLabel: doc.edges.filter((e) => String(e.label || "").trim()).length,
  renderedLabelHits: hitN,
  textCount: texts.length,
  rows,
}, null, 1));
