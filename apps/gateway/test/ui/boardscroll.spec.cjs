/** 白板滚轮作用域探针(自起临时实例 7790,不碰生产环境 7700)。
 * 目的:四处经验证「滚轮到底滚了谁」——画布空白 / 节点卡清单(.bd-card) / 明细区(#boardDetail) / 小地图(.bf-minimap)。
 * 每处记录三值:页面(scrollingElement/window) scrollTop、容器 scrollTop、cvPan.k。
 * 判定:画布上滚=只缩放(k 变、任何容器 scrollTop 不变);清单/明细上滚=只滚该容器(k 不变)。
 * 无 chrome/无 playwright-core/无真实板文件时打印 skipped: <reason> 并 exit 0(不谎报通过)。
 * 跑法:cd apps/gateway && npx tsx test/ui/boardscroll.spec.cjs
 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7790);
const SID = "ui-boardscroll-7790";
const SRC_SID = "web-1792774467576";
const SRC_TASK = "dec3a2d2-b812-4fe1-899b-c2a91365ea26";
const SRC_FILE = path.join(HARNESS_ROOT, ".genie", "boards", SRC_SID, SRC_TASK + ".json");
const skip = (reason) => { console.log("skipped: " + reason); process.exit(0); };

let chromium = null;
try { chromium = require("playwright-core").chromium; } catch (e) { skip("playwright-core 不可用(" + String(e && e.message).slice(0, 60) + ")"); }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome 可执行文件 " + CHROME);
if (!fs.existsSync(SRC_FILE)) skip("无真实板文件 " + SRC_FILE);

const TEST_DIR = path.join(HARNESS_ROOT, ".genie", "boards", SID);
const TEST_FILE = path.join(TEST_DIR, SRC_TASK + ".json");
const HOST_SEL = "#boardGraph #cvHost";

(async () => {
  const { createGatewayApp } = require("../../src/app.ts");
  const { servePanel } = require("../../src/panel.ts");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");

  const srcDoc = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
  const copy = JSON.parse(JSON.stringify(srcDoc));
  copy.sessionId = SID;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));

  const jd = mkdtempSync(join(tmpdir(), "uiscroll-"));
  const app = createGatewayApp({ useExternalHttp: true, journalDir: jd });
  servePanel(PORT, (srv) => app.attachWs(srv));
  const BASE = "http://127.0.0.1:" + PORT;
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(BASE + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
    if (Date.now() - t0 > 20000) throw new Error("self-host panel not ready on " + PORT);
    await new Promise((r) => setTimeout(r, 300));
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(12000);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(700);
      if (await page.locator(HOST_SEL + " .cv-node").count()) break;
      await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳无此函数 */ } });
    }

    // 明细区默认 :has(> .cc-empty) 时 display:none(空态隐藏)→ 先选一个节点让明细区真实出现,才谈得上「在明细区上滚」
    await page.evaluate(() => {
      const el = document.querySelector('#boardGraph .cv-node[data-cv="ta-tl"]') || document.querySelector("#boardGraph .cv-node");
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(600);

    const snap = () => page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const g = q("#boardGraph"), d = q("#boardDetail"), n = q("#boardNodes");
      const sc = document.scrollingElement;
      const r2 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
      return {
        k: r2(typeof cvPan !== "undefined" ? cvPan.k : null),
        graph: g ? Math.round(g.scrollTop) : null,
        detail: d ? Math.round(d.scrollTop) : null,
        nodes: n ? Math.round(n.scrollTop) : null,
        win: Math.round(window.scrollY), doc: sc ? Math.round(sc.scrollTop) : null,
        room: {
          graph: g ? Math.round(g.scrollHeight - g.clientHeight) : 0,
          detail: d ? Math.round(d.scrollHeight - d.clientHeight) : 0,
          nodes: n ? Math.round(n.scrollHeight - n.clientHeight) : 0,
        },
      };
    });
    const resetScroll = () => page.evaluate(() => {
      for (const s of ["#boardGraph", "#boardDetail", "#boardNodes"]) { const el = document.querySelector(s); if (el) el.scrollTop = 0; }
      window.scrollTo(0, 0);
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    });
    const pt = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") };
    }, sel);
    const wheelAt = async (label, p, dy) => {
      await resetScroll();
      const b = await snap();
      await page.mouse.move(p.x, p.y);
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(400);
      const a = await snap();
      const dk = Math.round((a.k - b.k) * 1000) / 1000;
      console.log("探针[" + label + "] @(" + p.x + "," + p.y + ") deltaY=" + dy +
        " k " + b.k + "→" + a.k + "(Δ" + dk + ")" +
        " | 页面 scrollTop " + (b.doc) + "→" + (a.doc) + " winY " + b.win + "→" + a.win +
        " | .board-graph " + b.graph + "→" + a.graph + "(可滚" + b.room.graph + "px)" +
        " | #boardNodes " + b.nodes + "→" + a.nodes + "(可滚" + b.room.nodes + "px)" +
        " | #boardDetail " + b.detail + "→" + a.detail + "(可滚" + b.room.detail + "px)");
      return { b, a, dk };
    };

    // ---- 探针点 ----
    const blank = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      for (let fy = 0.15; fy <= 0.92; fy += 0.08) {
        for (let fx = 0.12; fx <= 0.95; fx += 0.08) {
          const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
          const el = document.elementFromPoint(x, y);
          if (!el || !h.contains(el)) continue;
          if (el.closest(".cv-node,.cv-fold,.cv-wchip,.bf-minimap,.bf-zoombar,.cv-addbar,.cv-wbar")) continue;
          return { x, y, hit: el.tagName + "." + String(el.className).slice(0, 24) };
        }
      }
      return null;
    });
    if (!blank) throw new Error("找不到画布空白点");
    console.log("画布空白点 = (" + blank.x + "," + blank.y + ") 命中 " + blank.hit);

    const cardPt = await pt("#boardNodes .bd-card");
    const detailPt = await pt("#boardDetail");
    const miniPt = await pt(".bf-minimap");
    const shellBtns = await page.evaluate(() => ({ cards: document.querySelectorAll("#boardNodes .bd-card").length, folds: document.querySelectorAll("#boardGraph .cv-fold").length, chips: document.querySelectorAll("#boardGraph .cv-wchip").length }));
    console.log("探针对象存在性: .bd-card=" + shellBtns.cards + " .cv-fold=" + shellBtns.folds + " .cv-wchip=" + shellBtns.chips);

    // ---- A 画布空白:滚轮向上=缩放,不得滚动任何容器/页面 ----
    const A = await wheelAt("画布空白·滚轮上", blank, -120);
    check("① 画布上滚轮 = 只缩放(k 变)", A.dk !== 0, "k " + A.b.k + "→" + A.a.k);
    check("② 画布上滚轮不带动容器/页面滚动",
      A.a.graph === A.b.graph && A.a.nodes === A.b.nodes && A.a.detail === A.b.detail && A.a.doc === A.b.doc && A.a.win === A.b.win,
      "graph " + A.b.graph + "→" + A.a.graph + " nodes " + A.b.nodes + "→" + A.a.nodes + " detail " + A.b.detail + "→" + A.a.detail + " doc " + A.b.doc + "→" + A.a.doc);
    const A2 = await wheelAt("画布空白·滚轮下", blank, 120);
    check("③ 画布下滚=缩小(k 再变)且不带动滚动", A2.dk !== 0 && A2.a.doc === A2.b.doc && A2.a.graph === A2.b.graph, "k " + A2.b.k + "→" + A2.a.k);

    // ---- B 节点卡清单:只滚 #boardNodes,画布不得缩放 ----
    if (!cardPt) { check("④ .bd-card 可定位", false, "节点卡清单为空(可能未展开)"); }
    else {
      const B = await wheelAt("节点卡清单(.bd-card)", cardPt, 120);
      check("④ .bd-card 上滚轮不缩放画布(k 不变)", B.dk === 0, "k " + B.b.k + "→" + B.a.k);
      check("⑤ .bd-card 上滚轮滚动节点卡清单(#boardNodes scrollTop 变)", B.b.room.nodes <= 0 || B.a.nodes > B.b.nodes,
        "可滚=" + B.b.room.nodes + "px scrollTop " + B.b.nodes + "→" + B.a.nodes);
    }

    // ---- C 明细区:只滚 #boardDetail,画布不得缩放 ----
    if (!detailPt) { check("⑥ #boardDetail 可定位", false, "明细区缺失"); }
    else {
      const C = await wheelAt("明细区(#boardDetail)", detailPt, 120);
      check("⑥ 明细区上滚轮不缩放画布(k 不变)", C.dk === 0, "k " + C.b.k + "→" + C.a.k);
      check("⑦ 明细区上滚轮滚动明细区(#boardDetail scrollTop 变)", C.b.room.detail <= 0 || C.a.detail > C.b.detail,
        "可滚=" + C.b.room.detail + "px scrollTop " + C.b.detail + "→" + C.a.detail);
    }

    // ---- D 小地图(在画布内,如实记录行为) ----
    if (!miniPt) console.log("探针[小地图] .bf-minimap 缺失(该形态无小地图)");
    else {
      const D = await wheelAt("小地图(.bf-minimap)", miniPt, -120);
      console.log("小地图滚轮事实:k " + D.b.k + "→" + D.a.k + " doc " + D.b.doc + "→" + D.a.doc + " graph " + D.b.graph + "→" + D.a.graph);
    }

    // ---- E Ctrl+滚轮(画布)仍=缩放 ----
    await resetScroll();
    const e0 = await snap();
    await page.mouse.move(blank.x, blank.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(400);
    await page.keyboard.up("Control");
    const e1 = await snap();
    check("⑧ Ctrl+滚轮在画布上 = 缩放", Math.round((e1.k - e0.k) * 1000) / 1000 !== 0, "k " + e0.k + "→" + e1.k + " doc " + e0.doc + "→" + e1.doc);

    // ---- F 画布内工具浮层(添加模块工具箱:可滚列表 .cv-addpanel)上滚轮:只滚面板,不得缩放画布 ----
    await page.evaluate(() => {
      const b = document.getElementById("cvAddBtn");
      if (b) b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }));
    });
    await page.waitForTimeout(400);
    const panelRoom = await page.evaluate(() => {
      const p = document.getElementById("cvAddPanel");
      return p ? { room: p.scrollHeight - p.clientHeight, disp: getComputedStyle(p).display, items: p.querySelectorAll(".cv-aitem").length } : null;
    });
    console.log("添加面板: display=" + (panelRoom && panelRoom.disp) + " items=" + (panelRoom && panelRoom.items) + " 可滚=" + (panelRoom && panelRoom.room) + "px");
    const aiPt = await pt(".cv-addpanel .cv-aitem");
    if (!aiPt) console.log("探针[添加面板] .cv-aitem 不可定位(面板未开),跳过");
    else {
      const F = await wheelAt("添加模块工具箱(.cv-addpanel)", aiPt, 120);
      const panelScroll = await page.evaluate(() => { const p = document.getElementById("cvAddPanel"); return p ? p.scrollTop : null; });
      console.log("添加面板滚轮事实:k " + F.b.k + "→" + F.a.k + " 面板 scrollTop=" + panelScroll + "(面板可滚 " + (panelRoom && panelRoom.room) + "px)");
      check("⑩ 添加面板上滚轮不缩放画布(k 不变)", F.dk === 0, "k " + F.b.k + "→" + F.a.k + "(面板可滚 " + (panelRoom && panelRoom.room) + "px)");
      check("⑪ 添加面板上滚轮滚动面板自身", !panelRoom || panelRoom.room <= 0 || panelScroll > 0, "面板 scrollTop=" + panelScroll + " / 可滚 " + (panelRoom && panelRoom.room) + "px");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ---- G 回归:画布空白滚轮后,页面/容器必须仍停在原处(反复 5 次累积) ----
    await resetScroll();
    const g0 = await snap();
    for (let i = 0; i < 5; i++) { await page.mouse.move(blank.x, blank.y); await page.mouse.wheel(0, -120); await page.waitForTimeout(120); }
    await page.waitForTimeout(300);
    const g1 = await snap();
    check("⑨ 连续 5 次画布缩放后页面/容器 scrollTop 仍为 0",
      g1.doc === g0.doc && g1.graph === g0.graph && g1.nodes === g0.nodes && (g1.detail || 0) === (g0.detail || 0),
      "doc " + g0.doc + "→" + g1.doc + " graph " + g0.graph + "→" + g1.graph + " nodes " + g0.nodes + "→" + g1.nodes + " detail " + g0.detail + "→" + g1.detail + " k " + g0.k + "→" + g1.k);

    // ---- H 小窗档(.board-graph 真的可滚时):在画布上滚轮仍只缩放,不许把 .board-graph 一起滚 ----
    await page.setViewportSize({ width: 1180, height: 560 });
    await page.waitForTimeout(600);
    const compact = await snap();
    console.log("小窗档(1180x560):.board-graph 可滚=" + compact.room.graph + "px 卡=" + compact.nodes);
    const blank2 = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      for (let fy = 0.2; fy <= 0.85; fy += 0.1) for (let fx = 0.2; fx <= 0.9; fx += 0.1) {
        const x = Math.round(r.left + r.width * fx), y = Math.round(r.top + r.height * fy);
        if (y < 2 || y > window.innerHeight - 2) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || !h.contains(el)) continue;
        if (el.closest(".cv-node,.cv-fold,.cv-wchip,.bf-minimap,.bf-zoombar,.cv-addbar,.cv-wbar")) continue;
        return { x, y };
      }
      return null;
    });
    if (blank2 && compact.room.graph > 0) {
      const H = await wheelAt("小窗·画布空白", blank2, 120);
      check("⑫ 小窗档 .board-graph 可滚时:画布滚轮只缩放,不带动它", H.dk !== 0 && H.a.graph === H.b.graph, "k " + H.b.k + "→" + H.a.k + " .board-graph " + H.b.graph + "→" + H.a.graph + "(可滚" + H.b.room.graph + "px)");
    } else {
      console.log("小窗档 .board-graph 仍不可滚(可滚=" + compact.room.graph + "px)或找不到空白点 → 该项无实测条件,如实记录不判绿");
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(500);

    check("控制台零 pageerror", errs.length === 0, errs.slice(0, 2).join(" | "));
    await page.screenshot({ path: "/tmp/board-scroll.png" });
    console.log("截图=/tmp/board-scroll.png");
  } finally {
    await browser.close();
    try { await app.close(); } catch (e) { /* 已关 */ }
    rmSync(jd, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? "\nSCROLL FAIL " + fails.length + "/" + results.length : "\nSCROLL ALL PASS " + results.length + "/" + results.length);
  process.exit(0); // 探针:失败也不阻塞(结论看输出)
})().catch((e) => { console.error("SPEC CRASH", e); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (err) { /* 忽略 */ } process.exit(1); });
