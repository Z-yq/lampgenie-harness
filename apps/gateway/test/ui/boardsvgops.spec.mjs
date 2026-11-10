/** 白板 svg(flowkit)交互与导出逐按钮实测(2026-11-05 flowkit 断裂修复验证)。
 *  自起临时实例(默认 7795,不碰 7700),板副本落独立 SID(status=implementing 绕 done 写门禁)。
 *  判定三档:可用 / 不可用(明确置灰+说明或有提示) / 静默失败。
 *  覆盖:#cvArrangeBtn(svg 置灰+说明)、#cvAddBtn、双击空白、右键节点菜单+删除+Ctrl+Z、
 *        右键空白菜单(整理布局置灰)、Ctrl+A(明确提示)、点选+Delete、#boardExpPng(svg 直出 PNG)、
 *        cards 回滚对照。
 *  跑法:cd apps/gateway && node --import tsx test/ui/boardsvgops.spec.mjs
 *  无 chrome / 无 playwright-core / 无真实板 → 打印 skipped 并 exit 0。
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
const PORT = Number(process.env.SELF_PORT || 7795);
const SID = "ui-svgops-7795";
const SRC_SID = process.env.SRC_SID || "web-1792774467576";
const SRC_TASK = process.env.SRC_TASK || "4cb406c2-beb4-4be0-8d61-0c7a542083c9";
const SRC_FILE = path.join(HARNESS_ROOT, ".genie", "boards", SRC_SID, SRC_TASK + ".json");
const SHOTS = path.join(__dirname, "shots");
const VIEWPORT = { width: 1400, height: 900 };
const skip = (why) => { console.log("skipped: " + why); process.exit(0); };

let chromium = null;
try { ({ chromium } = await import("playwright-core")); } catch (e) { chromium = null; }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome " + CHROME);
if (!fs.existsSync(SRC_FILE)) skip("无真实板文件 " + SRC_FILE);

const TEST_DIR = path.join(HARNESS_ROOT, ".genie", "boards", SID);
const TEST_FILE = path.join(TEST_DIR, SRC_TASK + ".json");
const copy = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
copy.sessionId = SID;
copy.status = "implementing";
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));
fs.mkdirSync(SHOTS, { recursive: true });

const { createGatewayApp } = await import("../../src/app.ts");
const { servePanel } = await import("../../src/panel.ts");
const jd = mkdtempSync(path.join(tmpdir(), "svgops-"));
const app = createGatewayApp({ useExternalHttp: true, journalDir: jd });
servePanel(PORT, (srv) => app.attachWs(srv));
const BASE = "http://127.0.0.1:" + PORT;
const t0 = Date.now();
for (;;) {
  try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
  if (Date.now() - t0 > 20000) throw new Error("fixture panel not ready on " + PORT);
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
const rows = [];
const log = (ctrl, verdict, ev) => { rows.push({ ctrl, verdict, ev }); console.log("[" + verdict + "] " + ctrl + " — " + ev); };
const errs = [];

async function openPage() {
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  await page.addInitScript(() => {
    window.__pngProbe = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try { if (String(this.download || "").endsWith(".png")) window.__pngProbe.push(String(this.href || "")); } catch (e) { /* 忽略 */ }
      return orig.apply(this, arguments);
    };
  });
  await page.addInitScript((sid) => { try { sessionStorage.setItem("zh:sid", sid); } catch (e) { /* 隐私模式 */ } }, SID);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.click("#act-board");
  let kids = 0;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(700);
    kids = await page.evaluate(() => { const s = document.querySelector("#cvSvgHost svg"); return s ? s.childElementCount : 0; });
    if (kids > 2) break;
    await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
  }
  await page.waitForTimeout(800);
  return { page, kids };
}

const st = (page) => page.evaluate(() => ({
  nodes: boardDoc && boardDoc.nodes ? boardDoc.nodes.length : -1,
  cards: document.querySelectorAll("#boardGraph .cv-node").length,
  svgNodes: document.querySelectorAll("#cvSvgHost [data-node-id]").length,
  sel: typeof boardSelNode !== "undefined" ? boardSelNode : null,
  toasts: [...document.querySelectorAll("#toastHost .toast")].map((e) => e.textContent),
  ctxItems: [...document.querySelectorAll("#cvCtx button")].map((b) => b.textContent + (b.disabled ? "(灰)" : "")),
  addPanel: (() => { const p = document.getElementById("cvAddPanel"); return p ? getComputedStyle(p).display : "none"; })(),
  arrange: (() => { const b = document.getElementById("cvArrangeBtn"); return b ? { disabled: !!b.disabled, title: b.getAttribute("title") || "" } : null; })(),
  png: window.__pngProbe ? window.__pngProbe.slice() : [],
}));
const clearToast = (page) => page.evaluate(() => { const h = document.getElementById("toastHost"); if (h) h.innerHTML = ""; });
const press = (page, id) => page.evaluate((bid) => {
  const b = document.getElementById(bid);
  if (!b) return "missing";
  b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
  return "dispatch";
}, id);

/** 视口内真节点落点:只认 boardDoc.nodes 里的 id(flowkit 的 `g[data-node-id]` 还含泳道/分组 id)。 */
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

/** 视口内空白落点:命中 #cvHost 但不在任何 [data-node-id] 里(flowkit 的泳道框/分组也算非空白)。 */
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

let page = null;
try {
  ({ page } = await openPage());
  const s0 = await st(page);
  log("前置:flowkit svg 出图", s0.svgNodes > 2 && s0.cards === 0 ? "可用" : "静默失败", "#cvSvgHost [data-node-id]=" + s0.svgNodes + " 卡片DOM=" + s0.cards);
  await page.screenshot({ path: path.join(SHOTS, "svgops-0-board.png") });

  // 1 整理钮:svg 模式置灰 + 说明
  await clearToast(page); await press(page, "cvArrangeBtn"); await page.waitForTimeout(400);
  const s1 = await st(page);
  log("#cvArrangeBtn(整理)", s1.arrange && s1.arrange.disabled && /flowkit|ELK/.test(s1.arrange.title) ? "不可用(明确置灰+说明)" : "静默失败",
    "disabled=" + (s1.arrange && s1.arrange.disabled) + " title='" + String(s1.arrange && s1.arrange.title).slice(0, 40) + "…' 点击 toast=" + JSON.stringify(s1.toasts));

  // 2 添加模块按钮
  await clearToast(page); await press(page, "cvAddBtn"); await page.waitForTimeout(400);
  const s2 = await st(page);
  log("#cvAddBtn(添加模块)", s2.addPanel === "block" ? "可用" : "静默失败", "cvAddPanel display=" + s2.addPanel);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const p = document.getElementById("cvAddPanel"); if (p) p.style.display = "none"; });

  // 3 双击空白 → 工具箱
  await press(page, "cvZfit"); await page.waitForTimeout(700);
  const blank = await blankPoint(page);
  if (blank) {
    await page.mouse.dblclick(blank.x, blank.y); await page.waitForTimeout(450);
    const s3 = await st(page);
    log("双击空白(在落点添加模块)", s3.addPanel === "block" ? "可用" : "静默失败", "落点(" + blank.x + "," + blank.y + ") display=" + s3.addPanel);
    await page.screenshot({ path: path.join(SHOTS, "svgops-1-addpanel.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { const p = document.getElementById("cvAddPanel"); if (p) p.style.display = "none"; });
  } else log("双击空白(在落点添加模块)", "不可用", "无空白落点,无实测条件");

  // 4 右键节点 → 菜单 + 删除 + Ctrl+Z
  const np = await nodePoint(page);
  if (np) {
    await page.mouse.click(np.x, np.y, { button: "right" }); await page.waitForTimeout(350);
    const s4 = await st(page);
    const want = ["编辑明细", "复制", "创建副本", "删除"];
    log("右键节点(菜单)", want.every((t) => s4.ctxItems.some((x) => x.startsWith(t))) ? "可用" : "静默失败", "节点 " + np.id + " 菜单项=" + JSON.stringify(s4.ctxItems));
    await page.screenshot({ path: path.join(SHOTS, "svgops-2-ctx-node.png") });
    const before = s4.nodes;
    await page.evaluate(() => { const b = [...document.querySelectorAll("#cvCtx button")].find((x) => x.textContent === "删除"); if (b) b.click(); });
    await page.waitForTimeout(900);
    const s5 = await st(page);
    log("右键菜单「删除」", s5.nodes === before - 1 ? "可用" : "静默失败", "节点 " + before + "→" + s5.nodes);
    await page.evaluate(() => { const h = document.getElementById("cvHost"); if (h) h.focus(); });
    await page.keyboard.press("Control+z"); await page.waitForTimeout(900);
    const s6 = await st(page);
    log("Ctrl+Z(撤销删除)", s6.nodes === before ? "可用" : "静默失败", "节点 " + s5.nodes + "→" + s6.nodes);
  } else log("右键节点(菜单)", "不可用", "svg 里没有可命中的真节点,无实测条件");

  // 5 右键空白 → 菜单(整理布局必须置灰)
  await press(page, "cvZfit"); await page.waitForTimeout(600);
  const blank2 = await blankPoint(page);
  if (blank2) {
    await page.mouse.click(blank2.x, blank2.y, { button: "right" }); await page.waitForTimeout(350);
    const s7 = await st(page);
    const hit = ["粘贴", "添加模块", "适配全部"].filter((t) => s7.ctxItems.some((x) => x.startsWith(t)));
    const greyed = s7.ctxItems.some((x) => x.includes("整理布局") && x.includes("(灰)"));
    log("右键空白(菜单)", hit.length === 3 && greyed ? "可用" : "静默失败", "菜单项=" + JSON.stringify(s7.ctxItems));
    await page.screenshot({ path: path.join(SHOTS, "svgops-3-ctx-blank.png") });
    await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  } else log("右键空白(菜单)", "不可用", "无空白落点");

  // 6 Ctrl+A:给明确提示
  await page.evaluate(() => { const h = document.getElementById("cvHost"); if (h) h.focus(); });
  await clearToast(page);
  await page.keyboard.press("Control+a"); await page.waitForTimeout(350);
  const s8 = await st(page);
  log("Ctrl+A(全选)", s8.toasts.some((t) => /全选|框选/.test(t)) ? "不可用(有明确提示)" : "静默失败", "toast=" + JSON.stringify(s8.toasts));

  // 7 点选节点 + Delete
  const np2 = await nodePoint(page);
  if (np2) {
    await page.mouse.click(np2.x, np2.y); await page.waitForTimeout(400);
    const selNow = (await st(page)).sel;
    await clearToast(page);
    await page.keyboard.press("Delete"); await page.waitForTimeout(900);
    const s9 = await st(page);
    log("点选 + Delete 键", selNow && s9.nodes === s0.nodes - 1 ? "可用" : "静默失败", "选中=" + selNow + " 节点 " + s0.nodes + "→" + s9.nodes + " toast=" + JSON.stringify(s9.toasts));
    await page.keyboard.press("Control+z"); await page.waitForTimeout(800);
  } else log("点选 + Delete 键", "不可用", "无可命中节点");

  // 8 导出 PNG:重开一页拿干净状态(svg 直出)
  await page.close();
  const fresh = await openPage();
  page = fresh.page;
  await clearToast(page);
  await page.evaluate(() => { const b = document.getElementById("boardExpPng"); if (b) b.click(); });
  await page.waitForTimeout(2500);
  const s10 = await st(page);
  const pngOk = s10.png.length > 0 && /^data:image\/png/.test(String(s10.png[0]));
  log("#boardExpPng(导出 PNG)", pngOk && !s10.toasts.some((t) => /没有可导出|失败/.test(t)) ? "可用" : "静默失败",
    "下载次数=" + s10.png.length + " 长度=" + String(s10.png[0] || "").length + " toast=" + JSON.stringify(s10.toasts) + " 卡片DOM=" + s10.cards);

  // 9 cards 回滚对照
  await page.evaluate(() => { try { localStorage.setItem("cvRender", "cards"); } catch (e) { /* 忽略 */ } });
  await page.evaluate(() => { try { renderBoard(); } catch (e) { /* 忽略 */ } });
  await page.waitForTimeout(1500);
  const sc = await st(page);
  log("cards 回滚对照", sc.cards > 0 && sc.arrange && sc.arrange.disabled === false ? "可用" : "静默失败", "可见卡=" + sc.cards + " 整理钮 disabled=" + (sc.arrange && sc.arrange.disabled));
  await page.screenshot({ path: path.join(SHOTS, "svgops-4-cards.png") });

  if (errs.length) log("页面异常", "静默失败", errs.join(" | ").slice(0, 300));
} finally {
  try { if (page) await page.close(); } catch (e) { /* 忽略 */ }
  await browser.close();
  fs.writeFileSync(path.join(SHOTS, "svgops-matrix.json"), JSON.stringify(rows, null, 1));
  const silent = rows.filter((r) => r.verdict === "静默失败");
  console.log("\n=== 汇总: " + rows.length + " 项,静默失败 " + silent.length + " 项 ===");
  process.exit(silent.length ? 1 : 0);
}