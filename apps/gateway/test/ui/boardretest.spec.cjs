/** 白板渲染真实浏览器复测(60 节点真实板 DOM 经验证 + 评论改/删 UI 手测)。
 * 数据源:真实板 .genie/boards/web-1792774467576/dec3a2d2-b812-4fe1-899b-c2a91365ea26.json
 *   **复制**到测试 SID 目录(原文件一字不动);副本仅两处必要改造并在报告里如实说明:
 *   ① sessionId 换成测试 SID —— 服务端 saveBoard 按 doc.sessionId 定位目录,不改就会写回原板目录;
 *   ② 节点 ta-tl 预置 1 条评论(真实板 comments 全空),用于改/删手测。
 * 断言的形态:① 默认画布形态(canvas-shell)量与结构 + 交互可达性事实;② 经典形态(classic)完整指标
 *   + 评论改/删真实点击(该形态下 #cvHost 唯一、明细区未被画布覆盖)。
 * 跑法:cd apps/gateway && npx tsx test/ui/boardretest.spec.cjs(自起临时实例 7797,不碰生产环境 7700)
 * 无 chrome/无 playwright-core 时整文件 skip 并打印 skipped: <reason>(退出码 0,不谎报通过)。 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7797);
const SID = "ui-boardretest-7797";
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
const CMT_NODE = "ta-tl"; // 主干节点(entry→exit 链上),改/删手测载体
const CMT_SEED = "预置评论:改删手测起点";
const NEW_TXT = "改后评论:UI 实改";

(async () => {
  const { createGatewayApp } = require("../../src/app.ts");
  const { servePanel } = require("../../src/panel.ts");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");

  const srcDoc = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
  const copy = JSON.parse(JSON.stringify(srcDoc));
  copy.sessionId = SID; // 见文件头 ①:否则评论落盘会写回原板目录
  const seedNode = (copy.nodes || []).find((n) => n.id === CMT_NODE);
  if (!seedNode) throw new Error("真实板里找不到节点 " + CMT_NODE);
  seedNode.comments = [...(seedNode.comments || []), CMT_SEED];
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));

  const jd = mkdtempSync(join(tmpdir(), "uiret-"));
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
  const metric = (name, value) => console.log("指标 " + name + "=" + value);
  const readDisk = () => {
    try { const d = JSON.parse(fs.readFileSync(TEST_FILE, "utf-8")); const n = (d.nodes || []).find((x) => x.id === CMT_NODE); return { comments: n ? (n.comments || []) : null, status: d.status, rev: d.rev }; } catch (e) { return { comments: null, status: null, rev: null }; }
  };
  const waitDisk = async (fn, ms = 8000) => { const st = Date.now(); for (;;) { const v = fn(); if (v || Date.now() - st > ms) return v; await new Promise((r) => setTimeout(r, 250)); } };
  // 当前活动画布宿主=面板画布床(#boardGraph 内的 .bf-canvas#cvHost)。
  // 历史缺陷:canvas-shell 也把自己的宿主 id 写成 cvHost(撞 id),画布形态下出现过两个 #cvHost;
  // 现 canvas-shell 改用 #cvShellHost,全页 #cvHost 恒为 1(见断言 ⓪)。
  const HOST_SEL = "#boardGraph #cvHost";

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(12000);
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);

    const openBoard = async () => {
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await page.click("#act-board");
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(700);
        if (await page.locator(HOST_SEL + " .cv-node").count()) return true;
        await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳无此函数 */ } });
      }
      return false;
    };

    // ================= 形态 A:默认画布形态(canvas-shell) =================
    await openBoard();
    // ---- 缺陷 2 的反向守卫(必须在本形态**开板瞬间**取,后续步骤会手动改 k/展开泳道) ----
    // 修法要「仅在用户没动过视野时自动适配」,首次进板必须仍然自动适配(不许一刀切关掉)。
    const openFit = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      let full = 0;
      const all = [...h.querySelectorAll(".cv-node")];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5 && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5) full++;
      }
      return { k: cvPan.k, full, n: all.length };
    });
    metric("首次进板瞬间(k / 完整可见卡)", (openFit && openFit.k) + " / " + (openFit && openFit.full) + "/" + (openFit && openFit.n));
    check("⑱ 首次进板仍自动适配(缺陷 2 的修法不得把首次适配一并关掉)",
      !!openFit && openFit.n > 0 && openFit.full === openFit.n && Math.abs(openFit.k - 1) > 1e-6,
      "k=" + (openFit && openFit.k) + " 完整可见=" + (openFit && openFit.full) + "/" + (openFit && openFit.n));
    const modeA = await page.evaluate(() => document.body.className);
    const hosts = await page.evaluate(() => [...document.querySelectorAll("#cvHost")].map((h) => {
      const b = h.getBoundingClientRect();
      return { rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(","), cls: h.className, inGraph: !!h.closest("#boardGraph"), nodes: h.querySelectorAll(".cv-node").length, active: typeof cvActiveHost !== "undefined" && cvActiveHost === h };
    }));
    metric("[canvas] body.class", modeA);
    metric("[canvas] #cvHost 个数及各自矩形(x,y,w,h)", hosts.length + " 个 :: " + hosts.map((h) => h.rect + (h.inGraph ? "(画布床)" : "(canvas-shell)") + (h.active ? "*active*" : "") + " 卡" + h.nodes).join(" | "));
    const coverA = await page.evaluate(() => {
      const d = document.getElementById("boardDetail"); if (!d) return null;
      const b = d.getBoundingClientRect();
      const e = document.elementFromPoint(b.x + b.width / 2, b.y + 40);
      return { rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(","), hit: e ? e.tagName + "." + String(e.className).slice(0, 20) + "#" + e.id : null };
    });
    metric("[canvas] 明细区矩形 / 该点 hit-test 命中元素", (coverA ? coverA.rect : null) + " / " + (coverA ? coverA.hit : null));
    // 修复后事实:全页 #cvHost 恒为 1(canvas-shell 宿主已改名 #cvShellHost,不再撞 id);
    // 选中一个节点让明细区出评论行,再用 elementFromPoint 验证评论按钮真的可点(命中 BUTTON)。
    const shellHost = await page.evaluate(() => {
      const s = document.querySelector("#cvShellHost");
      if (!s) return null;
      const b = s.getBoundingClientRect();
      return { rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(","), count: document.querySelectorAll("#cvShellHost").length };
    });
    metric("[canvas] #cvShellHost(canvas-shell 宿主)个数/矩形", (shellHost ? shellHost.count + " 个 :: " + shellHost.rect : "缺失"));
    await page.evaluate((id) => {
      const el = document.querySelector('#boardGraph .cv-node[data-cv="' + id + '"]');
      if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }, CMT_NODE);
    await page.waitForTimeout(500);
    const coverB = await page.evaluate(() => {
      const d = document.getElementById("boardDetail"); if (!d) return null;
      const b = d.getBoundingClientRect();
      const btn = d.querySelector(".bdCmtEdit");
      if (btn) btn.scrollIntoView({ block: "center", inline: "nearest" }); // 评论行可能在明细区滚动条下沿,先滚进可视区再 hit-test
      const target = btn || d;
      const r = target.getBoundingClientRect();
      const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const stack = btn ? document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 6).map((x) => x.tagName + "." + String(x.className).slice(0, 18) + "#" + x.id) : [];
      const chain = (() => { const out = []; for (let n = d; n && n.nodeType === 1 && out.length < 8; n = n.parentElement) { const rr = n.getBoundingClientRect(); out.push(n.tagName + "#" + n.id + "." + String(n.className).slice(0, 14) + "[" + [Math.round(rr.x), Math.round(rr.y), Math.round(rr.width), Math.round(rr.height)].join(",") + "]"); } return out; })();
      return {
        rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(","),
        hasBtn: !!btn,
        hit: e ? e.tagName + "." + String(e.className).slice(0, 20) + "#" + e.id : null,
        hitIsBtn: !!(e && e.closest && e.closest(".bdCmtEdit")),
        stack,
        chain,
        btnRect: btn ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",") : null,
      };
    });
    metric("[canvas] 选中节点后明细区矩形 / 评论「改」按钮中心 hit-test 命中", (coverB ? coverB.rect : null) + " / " + (coverB ? coverB.hit : null));
    metric("[canvas] 评论「改」按钮矩形 / 该点元素栈(上→下)", (coverB && coverB.btnRect) + " :: " + (coverB ? coverB.stack.join(" > ") : null));
    metric("[canvas] 明细区祖先链(自身→上)", coverB ? coverB.chain.join(" < ") : null);
    check("⓪ 画布形态下 #cvHost 唯一(===1)且明细区评论「改」按钮可点(elementFromPoint 命中 BUTTON)",
      hosts.length === 1 && !!shellHost && shellHost.count === 1 && !!coverB && coverB.hasBtn && coverB.hitIsBtn,
      "#cvHost=" + hosts.length + " #cvShellHost=" + (shellHost ? shellHost.count : 0) + " 按钮命中=" + (coverB && coverB.hit));

    // ---- 缺陷 1(P0):小地图重复 id → shell 的 #cvMini(172×112,right:10px;top:10px)压住面板
    //      自己的 #cvMini(44×26,left:10px;bottom:10px),并把左上写者 chip 条右端整片盖死。
    //      断开口径:① 每个 .cv-wchip 中心 elementFromPoint 必须命中 chip 自身(修复前右侧几个命中 canvas#cvMini);
    //      ② 全 DOM 无重复 id(修复前 id=cvMini 出现 2 次)。
    const chips = await page.evaluate(() => {
      // 复原滚动位置:上面的「评论改」hit-test 用过 scrollIntoView,会把画布滚动容器滚开,
      // 使 chip 条被滚出可视裁剪区(那是测量污染,不是遮挡缺陷)。
      window.scrollTo(0, 0);
      for (const el of document.querySelectorAll(".view,.board-graph,.bf-canvas")) { el.scrollTop = 0; el.scrollLeft = 0; }
      const bars = [...document.querySelectorAll(".cv-wchip")];
      const out = bars.map((c) => {
        const r = c.getBoundingClientRect();
        const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const stack = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).slice(0, 5)
          .map((x) => x.tagName + "." + String(x.className).slice(0, 16) + "#" + x.id);
        return {
          txt: String(c.textContent || "").trim(),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","),
          hit: e ? e.tagName + "." + String(e.className).slice(0, 16) + "#" + e.id : null,
          stack: stack.join(">"),
          self: !!(e && (e === c || c.contains(e))),
        };
      });
      return { total: bars.length, bad: out.filter((o) => !o.self), all: out.map((o) => o.txt + "@" + o.rect + "→" + o.hit + "[" + o.stack + "]") };
    });
    metric("写者 chip 个数 / 中心 hit-test 命中自身失败数", chips.total + " / " + chips.bad.length);
    metric("写者 chip 逐个(文字@矩形→命中元素)", chips.all.join(" | "));
    // 几何诊断:chip 所在画布/卡片与遮挡者(定位遮挡来源用)
    const geom = await page.evaluate(() => {
      const rc = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","); };
      const bar = document.querySelector(".cv-wbar");
      const chip = document.querySelector(".cv-wchip");
      const host = document.querySelector("#cvHost");
      const card = host && host.closest(".cv-card");
      const chipRect = chip && chip.getBoundingClientRect();
      const e = chipRect && document.elementFromPoint(chipRect.x + chipRect.width / 2, chipRect.y + chipRect.height / 2);
      const cover = e && e.closest ? e.closest(".cv-card") : null;
      return {
        body: document.body.className,
        wbar: rc(bar), chip: rc(chip), host: rc(host), card: rc(card),
        cardName: card ? card.dataset.name : null,
        cardHead: rc(card && card.querySelector(".cv-card-head")),
        coverName: cover ? cover.dataset.name : null, coverRect: rc(cover),
        coverHead: rc(cover && cover.querySelector(".cv-card-head")),
        mini: rc(document.getElementById("cvMini")),
        chipChain: (() => { const out = []; for (let n = chip; n && n.nodeType === 1 && out.length < 9; n = n.parentElement) out.push(n.tagName + "#" + n.id + "." + String(n.className).slice(0, 12) + "[" + rc(n) + "|st" + n.scrollTop + "|sy" + n.scrollLeft + "]"); return out; })().join(" < "),
        miniChain: (() => { const m = document.querySelector(".bf-minimap"); const out = []; for (let n = m; n && n.nodeType === 1 && out.length < 6; n = n.parentElement) out.push(n.tagName + "#" + n.id + "." + String(n.className).slice(0, 12) + "[" + rc(n) + "]"); return out; })().join(" < "),
        bodyOverflow: getComputedStyle(document.body).overflow + "/" + getComputedStyle(document.querySelector(".middle") || document.body).overflow,
      };
    });
    metric("几何诊断(矩形 x,y,w,h)", JSON.stringify(geom));
    check("⑬ 写者 chip 全部可点:每个 .cv-wchip 中心 elementFromPoint 命中 chip 自身(修复前右侧 chip 命中 canvas#cvMini)",
      chips.total >= 2 && chips.bad.length === 0,
      "chip=" + chips.total + " 被遮=" + chips.bad.length + (chips.bad.length ? " 首个:" + chips.bad[0].txt + "→" + chips.bad[0].hit : ""));
    const dupIds = await page.evaluate(() => {
      const cnt = new Map();
      for (const el of document.querySelectorAll("[id]")) cnt.set(el.id, (cnt.get(el.id) || 0) + 1);
      const dup = [...cnt.entries()].filter(([, n]) => n > 1).map(([id, n]) => id + "×" + n);
      return { all: cnt.size, dup };
    });
    metric("全 DOM id 总数 / 重复 id", dupIds.all + " / " + (dupIds.dup.join(",") || "无"));
    check("⑭ 全 DOM 无重复 id(修复前 cvMini 出现 2 次)", dupIds.dup.length === 0, "重复=" + (dupIds.dup.join(",") || "无"));
    // 小地图本身仍可用:面板自己的 #cvMini(44×26 常态)在场且其中心不是被别的层盖住
    const miniHit = await page.evaluate(() => {
      const m = [...document.querySelectorAll("#cvMini")].map((x) => {
        const r = x.getBoundingClientRect();
        const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { id: x.id, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(","), hit: e ? e.tagName + "#" + e.id + "." + String(e.className).slice(0, 14) : null, self: !!(e && e === x) };
      });
      return m;
    });
    metric("#cvMini 实例(矩形→中心命中)", miniHit.map((x) => x.rect + "→" + x.hit + (x.self ? "(自身)" : "")).join(" | ") || "无");
    check("⑮ 面板小地图仍可点(#cvMini 恒 1 个且中心命中自身)", miniHit.length === 1 && miniHit[0].self,
      "#cvMini=" + miniHit.length + " 命中=" + (miniHit[0] ? miniHit[0].hit : null));

    // ================= 形态 B:经典形态(classic)完整指标 + 评论改删 =================
    await page.evaluate(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) { /* 忽略 */ } });
    const okB = await openBoard();
    const modeB = await page.evaluate(() => document.body.className);
    metric("[classic] body.class", modeB);
    const docInfo = await page.evaluate(() => ({
      nodes: cvActiveDoc && cvActiveDoc.nodes ? cvActiveDoc.nodes.length : null,
      sid: (cvActiveDoc && cvActiveDoc.sessionId) || null,
      taskId: (cvActiveDoc && cvActiveDoc.taskId) || null,
      hosts: document.querySelectorAll("#cvHost").length,
    }));
    metric("[classic] 打开的板(sessionId/taskId)", docInfo.sid + "/" + docInfo.taskId);
    metric("[classic] 板上节点总数(数据源)", docInfo.nodes);
    metric("[classic] #cvHost 个数", docInfo.hosts);
    check("① 60 节点真实板经面板链路(board.list→board.get)打开并出卡", okB && docInfo.nodes === 60 && docInfo.sid === SID && docInfo.hosts === 1,
      "sid=" + docInfo.sid + " 板内节点=" + docInfo.nodes + " 渲染卡=" + (await page.locator(HOST_SEL + " .cv-node").count()));

    const struct = await page.evaluate((sel) => {
      const h = document.querySelector(sel);
      if (!h) return null;
      const q = (s) => h.querySelectorAll(s).length;
      const names = new Set();
      for (const el of h.querySelectorAll("[class]")) for (const c of el.classList) if (/lane|fold/i.test(c)) names.add(c);
      return { node: q(".cv-node"), fold: q(".cv-fold"), lane: q(".cv-lane"), laneOrphan: q(".cv-lane-orphan"), laneH: q(".cv-lane-h"), names: [...names].sort() };
    }, HOST_SEL);
    metric(".cv-node 数量", struct ? struct.node : null);
    metric(".cv-fold 数量", struct ? struct.fold : null);
    metric("泳道框类名/条数", struct ? ".cv-lane=" + struct.lane + " (其中 .cv-lane-orphan=" + struct.laneOrphan + ")" : null);
    metric("泳道头类名/条数", struct ? ".cv-lane-h=" + struct.laneH : null);
    metric("画布内命中 lane/fold 的全部类名", struct ? struct.names.join(",") : null);
    const flow = await page.evaluate(() => ({ main: cvFlowInfo && cvFlowInfo.mainNodes ? cvFlowInfo.mainNodes.size : null, lanes: cvFlowInfo && cvFlowInfo.lanes ? cvFlowInfo.lanes.length : null, foldMode: cvFoldMode }));
    metric("cvFlowInfo 主干节点数/泳道数/密度分层态", flow.main + " / " + flow.lanes + " / " + flow.foldMode);
    // w4 空壳泳道降噪:密度分层态下「成员全被收进 +N 计数块」的泳道不画框(修复前 .cv-lane=21 vs .cv-node=7)。
    // 断言口径:画出来的泳道框 ≤7,且不因此少一张主干卡/一个计数块(下面 ⑥⑦⑧ 三项守住不退化)。
    const boxlessN = await page.evaluate(() => (cvFlowInfo && cvFlowInfo.lanes ? cvFlowInfo.lanes.filter((l) => l.boxless).length : null));
    metric("boxless 泳道数(有数据不画框)", boxlessN);
    check("⑫ 密度分层态泳道框 ≤7(修复前 21 框 vs 7 卡;空壳泳道只留数据不画框)",
      !!struct && struct.lane <= 7 && struct.lane > 0 && struct.node > 0,
      ".cv-lane=" + (struct && struct.lane) + " .cv-node=" + (struct && struct.node) + " boxless=" + boxlessN + " lanes(数据)=" + (flow && flow.lanes));

    // 「适」按钮:document 级 pointerdown 委托(click 会被重渲吞掉)
    await page.evaluate(() => { cvPan.k = 1.5; cvApplyTf(); });
    const fitOk = await page.evaluate(() => {
      const b = document.getElementById("cvZfit");
      if (!b) return false;
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
      return true;
    });
    await page.waitForTimeout(400);
    metric("#cvZfit(pointerdown) 后 cvPan.k", fitOk ? await page.evaluate(() => cvPan.k) : null);

    const vis = await page.evaluate((sel) => {
      const h = document.querySelector(sel);
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      let full = 0, part = 0, out = 0;
      for (const el of h.querySelectorAll(".cv-node")) {
        const r = el.getBoundingClientRect();
        const overlap = r.bottom > hr.top && r.top < hr.bottom && r.right > hr.left && r.left < hr.right;
        const fullIn = r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5 && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5;
        if (fullIn) full++; else if (overlap) part++; else out++;
      }
      return { cw: h.clientWidth, ch: h.clientHeight, rw: Math.round(hr.width), rh: Math.round(hr.height), full, part, out, k: cvPan.k };
    }, HOST_SEL);
    metric("#cvHost clientWidth×clientHeight", vis ? vis.cw + "×" + vis.ch : null);
    metric("#cvHost 客户端矩形(w×h)", vis ? vis.rw + "×" + vis.rh : null);
    metric("适配后(k=" + (vis ? vis.k : "?") + ")完整落在 host 视口内的 .cv-node 数", vis ? vis.full : null);
    metric("部分可见(有交集但不完整)的 .cv-node 数", vis ? vis.part : null);
    metric("完全在 host 视口外的 .cv-node 数", vis ? vis.out : null);
 // w2/A:计数块(.cv-fold)可见性是「适配视野是否把计数块装进去」的验径
 // (修复前经验证 k=0.7 下 0/20 可见——计数块摆在主干右缘之外 x≈2034..2194,可见世界只到 x≈1592)。
    const foldVis = await page.evaluate((sel) => {
      const h = document.querySelector(sel);
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      let full = 0, part = 0, out = 0;
      const boxes = [];
      for (const el of h.querySelectorAll(".cv-fold")) {
        const r = el.getBoundingClientRect();
        const fullIn = r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5 && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5;
        const overlap = r.bottom > hr.top && r.top < hr.bottom && r.right > hr.left && r.left < hr.right;
        if (fullIn) full++; else if (overlap) part++; else out++;
        if (boxes.length < 4) boxes.push(Math.round(parseFloat(el.style.left)) + "," + Math.round(parseFloat(el.style.top)));
      }
      return { total: h.querySelectorAll(".cv-fold").length, full, part, out, k: cvPan.k, boxes };
    }, HOST_SEL);
    metric("[计数块 .cv-fold] 总数/完全可见/部分可见/视野外", foldVis ? foldVis.total + " / " + foldVis.full + " / " + foldVis.part + " / " + foldVis.out : null);
    metric("[计数块 .cv-fold] k=" + (foldVis ? foldVis.k : "?") + " 前 4 个世界坐标(x,y)", foldVis ? foldVis.boxes.join(" | ") : null);
    check("⑥ 适配后(k≈0.7)计数块 .cv-fold 完全可见数 > 0(修复前 0/20)", !!foldVis && foldVis.total > 0 && foldVis.full > 0,
      ".cv-fold 完全可见=" + (foldVis && foldVis.full) + "/" + (foldVis && foldVis.total) + " k=" + (foldVis && foldVis.k));

 // 主干完整可见数(任务书验径:主干 7/7 完整落在 #cvHost 视口内)。
 // 修复前经验证 5/7(1 部分 + 1 完全在视野外)——根因:主干 7 卡一字排开 x 跨 1351px,k 被
    // CV_FIT_READABLE_MIN=0.7 钳住,可见世界只到 x≈1592。主干换行后 k 不再撞下限。
    const span = await page.evaluate((sel) => {
      const h = document.querySelector(sel);
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      const fi = typeof cvFlowInfo !== "undefined" ? cvFlowInfo : null;
      let ids = fi && fi.mainNodes ? [...fi.mainNodes] : [];
      const mainDeclared = ids.length;
      if (!ids.length) ids = [...h.querySelectorAll(".cv-node")].map((e) => e.dataset.cv);
      const rs = [];
      let full = 0, part = 0, out = 0;
      for (const id of ids) {
        const el = h.querySelector('[data-cv="' + id + '"]');
        if (!el) continue;
        const r = el.getBoundingClientRect();
        rs.push({ id, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        const fullIn = r.top >= hr.top - 0.5 && r.bottom <= hr.bottom + 0.5 && r.left >= hr.left - 0.5 && r.right <= hr.right + 0.5;
        const overlap = r.bottom > hr.top && r.top < hr.bottom && r.right > hr.left && r.left < hr.right;
        if (fullIn) full++; else if (overlap) part++; else out++;
      }
      if (!rs.length) return null;
      let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const r of rs) { minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom); minX = Math.min(minX, r.left); maxX = Math.max(maxX, r.right); }
      // 行数(y 去重)= 主干是否真的换了行
      const rows = new Set(rs.map((r) => Math.round(r.top))).size;
      return { n: rs.length, mainDeclared, full, part, out, rows, k: cvPan.k, ySpan: Math.round((maxY - minY) * 10) / 10, xSpan: Math.round((maxX - minX) * 10) / 10, ids: rs.map((r) => r.id).join(",") };
    }, HOST_SEL);
    metric("主干卡数(cvFlowInfo.mainNodes 在内场者)", span ? span.n : null);
    metric("主干卡 y 最小→最大跨度(px)", span ? span.ySpan : null);
    metric("主干卡 x 跨度(px)", span ? span.xSpan : null);
    metric("主干卡行数(y 去重;换行前 =1)", span ? span.rows : null);
    metric("主干完整可见数(修复前 5/7)", span ? span.full + "/" + span.n : null);
    metric("主干部分可见 / 完全在视野外(修复前 1 / 1)", span ? span.part + " / " + span.out : null);
    metric("主干卡 id 清单", span ? span.ids : null);
    check("⑦ 主干完整可见 7/7(修复前 5/7;主干换行 + 适配 k 不再撞 0.7)", !!span && span.n === 7 && span.full === 7,
      "完整可见=" + (span && span.full) + "/" + (span && span.n) + " 部分=" + (span && span.part) + " 视野外=" + (span && span.out) +
      " 行数=" + (span && span.rows) + " x跨度=" + (span && span.xSpan) + "px y跨度=" + (span && span.ySpan) + "px");
    check("⑧ 适配 cvPan.k > 0.7(不再被 CV_FIT_READABLE_MIN 钳住;修复前恒 0.7)",
      !!span && span.k > 0.7 + 1e-6, "k=" + (span && span.k) + "(修复前 0.7,自然 k≈0.196)");
    check("⑨ 主干按列换行(cvFlowInfo 布局层):行数 ≥2", !!span && span.rows >= 2, "行数=" + (span && span.rows));

    await page.evaluate(() => { cvPan.k = 1; cvApplyTf(); });
    await page.waitForTimeout(150);
    const ell = await page.evaluate((sel) => {
      const ts = [...document.querySelectorAll(sel + " .cv-title")];
      const cut = ts.filter((t) => t.scrollWidth > t.clientWidth + 0.5);
      // 标题槽宽度 = k=1 下 .cv-title 的 clientWidth(任务书口径:修复前 71–73px,目标 ≥100px)
      const slots = ts.map((t) => t.clientWidth);
      return {
        total: ts.length, cut: cut.length, k: cvPan.k,
        minSlot: slots.length ? Math.min(...slots) : null,
        maxSlot: slots.length ? Math.max(...slots) : null,
        sample: cut.slice(0, 3).map((t) => t.textContent.trim().slice(0, 18) + "(" + t.clientWidth + "/" + t.scrollWidth + ")"),
      };
    }, HOST_SEL);
    metric("k=" + ell.k + " 时 .cv-title 被 ellipsis 截断个数/总数(修复前 5/7)", ell.cut + "/" + ell.total);
    metric("k=1 时标题槽宽度 min/max(px;修复前 71–73)", ell.minSlot + " / " + ell.maxSlot);
    metric("截断样本(可见宽/内容宽)", ell.sample.join(" ; ") || "无");
 // 修复前经验证:k=1 时主干 7 张卡里 5 张标题被截断(样本「时间线还原台 71/72」「止血开关与分批限速 73/108」
    // 「幂等键与执行台账 73/96」)。头信息分层后目标 ≤2/7。
    check("⑩ k=1 标题截断数 ≤2(修复前 5;头信息分层把徽标折到第二行)",
      !!ell && ell.cut <= 2, "截断=" + (ell && ell.cut) + "/" + (ell && ell.total) + " 标题槽 min=" + (ell && ell.minSlot) + "px");
    check("⑪ k=1 标题槽 ≥100px(修复前 71–73px)", !!ell && ell.minSlot >= 100, "标题槽 min=" + (ell && ell.minSlot) + "px / max=" + (ell && ell.maxSlot) + "px");
    check("② DOM 指标可取(cv-node>0、.cv-title 与卡片一一对应)", !!struct && struct.node > 0 && ell.total === struct.node, "cv-node=" + (struct && struct.node) + " cv-title=" + ell.total);

    // ---- 缺陷 3(P0):+N 展开后无法收起 ----
    // 根因:lane.nodes 全进 keep 后 hidden 为空 → 该泳道不再出计数块,而 toggle 本身是双向的,
    // 缺的是「反向块」这个入口。断开口径:点 +N 展开(n0 → n0+N),再点同一 data-fold 的「−N 收起」
    // 块必须回落 n0。
    const foldOpen = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return { err: "无 #cvHost" };
      const n0 = h.querySelectorAll(".cv-node").length;
      const first = h.querySelector(".cv-fold");
      if (!first) return { err: "无 .cv-fold", n0 };
      const key = first.getAttribute("data-fold");
      const txt = String(first.textContent || "").trim();
      const m = /\+(\d+)/.exec(txt);
      first.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
      return { n0, key, txt, plus: m ? Number(m[1]) : null };
    });
    await page.waitForTimeout(700);
    const afterOpen = await page.evaluate((key) => {
      const h = document.querySelector("#boardGraph #cvHost");
      const nodes = h ? h.querySelectorAll(".cv-node").length : null;
      const blocks = h ? [...h.querySelectorAll(".cv-fold")].map((b) => ({ k: b.getAttribute("data-fold"), t: String(b.textContent || "").trim() })) : [];
      const rev = blocks.filter((b) => b.k === key);
      return { nodes, total: blocks.length, rev, sample: blocks.slice(0, 3) };
    }, foldOpen && foldOpen.key);
    metric("点 +N 前 .cv-node / 所点块(文字) / 展开后 .cv-node", (foldOpen && foldOpen.n0) + " / '" + (foldOpen && foldOpen.txt) + "' / " + (afterOpen && afterOpen.nodes));
    metric("展开后该泳道留下的块(同 data-fold)/ 全部块数", JSON.stringify(afterOpen && afterOpen.rev) + " / " + (afterOpen && afterOpen.total));
    // 展开必须真的多出节点(否则后面「收起」测的是空气)
    check("⑯ 点 +N 展开:该泳道节点全出卡(.cv-node 由 n0 增到 n0+N)",
      !!foldOpen && !!foldOpen.plus && afterOpen.nodes === foldOpen.n0 + foldOpen.plus,
      "n0=" + (foldOpen && foldOpen.n0) + " +N=" + (foldOpen && foldOpen.plus) + " 展开后=" + (afterOpen && afterOpen.nodes));
    // 收起块:同一 data-fold、文案以「−」开头的反向块
    const foldClose = await page.evaluate((key) => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return { err: "无 #cvHost" };
      const rev = [...h.querySelectorAll(".cv-fold")].filter((b) => b.getAttribute("data-fold") === key && /[−-]\s*\d/.test(String(b.textContent || "")));
      if (!rev.length) {
        return {
          err: "没有可点的收起块",
          sameKey: [...h.querySelectorAll(".cv-fold")].filter((b) => b.getAttribute("data-fold") === key).map((b) => String(b.textContent || "").trim()),
        };
      }
      const el = rev[0];
      const txt = String(el.textContent || "").trim();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
      return { txt };
    }, foldOpen && foldOpen.key);
    await page.waitForTimeout(700);
    const afterClose = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      return { nodes: h ? h.querySelectorAll(".cv-node").length : null, folds: h ? h.querySelectorAll(".cv-fold").length : null };
    });
    metric("点收起块(文字)→ .cv-node / .cv-fold", "'" + (foldClose && (foldClose.txt || foldClose.err)) + "' → " + (afterClose && afterClose.nodes) + " / " + (afterClose && afterClose.folds));
    check("⑰ 展开后出现「−N 收起」反向块,点它回落原节点数(修复前该块不存在=永不收起)",
      !!(foldClose && foldClose.txt) && afterClose.nodes === (foldOpen && foldOpen.n0),
      "收起块='" + (foldClose && (foldClose.txt || foldClose.err)) + "' 同 key 块=" + JSON.stringify(foldClose && foldClose.sameKey) +
      " 回落=" + (afterClose && afterClose.nodes) + "(应=" + (foldOpen && foldOpen.n0) + ")");

    // ---- 缺陷 2(P0):保存回执抢走用户视野 ----
    // 根因:全量渲染后无条件 setTimeout(cvFitNow, 40) → 用户手动放大看细部,保存回执回来 k 静默复位。
    // 断开口径:手动放大(走 cvHost 的 wheel/缩放件处理器,与真人同路径)→ 进编辑态触发一次保存 →
    // 等回执重渲 1s → cvPan.k 必须仍是手动值(修复前被复位到自动适配 k)。
    // 反向守卫 ⑱(首次进板仍自动适配)在开板瞬间已测,见本形态开头。
    const manualK = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return null;
      // 真人路径:滚轮放大(cvHost 的 wheel 处理器)→ 再用缩放件同一函数落到 1.6
      const r = h.getBoundingClientRect();
      for (let i = 0; i < 4; i++) {
        h.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      }
      cvSetZoom(1.6, h); // == 点 #cvZin/#cvZout 走的同一个函数
      return { k: cvPan.k, nodes: h.querySelectorAll(".cv-node").length };
    });
    await page.waitForTimeout(200);
    let saveErr = "";
    try {
      await page.click("#boardEditBtn");
      await page.waitForTimeout(400);
      await page.evaluate(() => { cvSetZoom(1.6, document.querySelector("#boardGraph #cvHost")); }); // 进编辑态本身也会重渲,手动值再钉一次
      await page.click("#boardSaveBtn");
    } catch (e) { saveErr = String(e && e.message).slice(0, 120); }
    await page.waitForTimeout(1200);
    const afterSave = await page.evaluate(() => ({
      k: cvPan.k,
      toasts: [...document.querySelectorAll("#toastHost .toast")].map((t) => String(t.textContent || "").slice(0, 40)),
    }));
    metric("手动 k / 保存回执后 k", manualK && manualK.k + " / " + afterSave.k);
    metric("保存后 toast 清单", afterSave.toasts.join(" ; ") || "无");
    check("⑲ 手动放大后保存回执不得复位视野(cvPan.k 仍 ≈1.6;修复前静默复位到自动适配 k)",
      !saveErr && Math.abs(afterSave.k - 1.6) < 0.02,
      "手动 k=" + (manualK && manualK.k) + " 回执后 k=" + afterSave.k + (saveErr ? " | 异常:" + saveErr : ""));
    await page.evaluate(() => { const h = document.querySelector("#boardGraph #cvHost"); if (h) cvSetZoom(1, h); });
    await page.waitForTimeout(200);

    // ================= 评论 改 / 删(真实点击) =================
    const selNode = async () => page.evaluate((id) => {
      const el = document.querySelector('#boardGraph .cv-node[data-cv="' + id + '"]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }, CMT_NODE);
    await selNode();
    await page.waitForTimeout(400);
    const rowsBefore = await page.locator("#boardDetail .bf-cmt-row").count();
    const txtBefore = String(await page.locator("#boardDetail .bf-cmt-row .bf-cmt").first().textContent().catch(() => "")).trim();
    metric("明细区评论行数(改前)/首行文字", rowsBefore + " 行 / '" + txtBefore + "'");

    // ②-a 真实板原样(status=done,P0 证据 7/51):改评论应被服务端门禁拒收 → 磁盘与 UI 均不变
    let clickErr = "";
    try {
      await page.locator("#boardDetail .bdCmtEdit").first().click();
      await page.waitForSelector("#bdCmtEditInp", { timeout: 6000 });
      await page.fill("#bdCmtEditInp", "门禁拒收探针");
      await page.locator("#bdCmtEditSave").click();
    } catch (e) { clickErr = String(e && e.message).slice(0, 100); }
    await page.waitForTimeout(1500);
    const diskDone = readDisk();
    const uiDone = String(await page.locator("#boardDetail .bf-cmt-row .bf-cmt").first().textContent().catch(() => "")).trim();
    // C:拒收提示必须可见——采集 toastHost 中带 err 类的提示文本
    const toastsDone = await page.evaluate(() => [...document.querySelectorAll("#toastHost .toast")].map((t) => ({ cls: t.className, text: String(t.textContent || "").slice(0, 160) })));
    const rejectToast = toastsDone.filter((t) => /拒|未保存/.test(t.text) && /\berr\b/.test(t.cls)).map((t) => t.text).join(" || ");
    metric("done 板改评论后的 toast(err 类)清单", toastsDone.filter((t) => /\berr\b/.test(t.cls)).map((t) => t.text).join(" ; ") || "无");
    check("③ done 板(P0 证据 7/51)上改评论:服务端 saveBoard 门禁拒收 → UI 与磁盘均保持原文(真实断言)",
      !clickErr && diskDone.comments && diskDone.comments[0] === CMT_SEED && uiDone === CMT_SEED && diskDone.status === "done",
      "selectors #boardDetail .bdCmtEdit → #bdCmtEditInp → #bdCmtEditSave" + (clickErr ? " | 异常:" + clickErr : "") +
      " | UI='" + uiDone + "' 磁盘=" + JSON.stringify(diskDone.comments) + " status=" + diskDone.status);
    check("⑦ 拒收必须有明确提示:toast 出现「评论修改被拒,未保存:<原因>」且提到 P0/证据口径",
      !!rejectToast && /评论修改被拒/.test(rejectToast) && /P0|证据/.test(rejectToast),
      "提示文本='" + (rejectToast || "(无)") + "'");

    // ②-b 把测试副本 status 改成 implementing(真实板 done 态无法落任何评论改动),重拉板后再测改/删
    fs.writeFileSync(TEST_FILE, JSON.stringify(Object.assign({}, JSON.parse(fs.readFileSync(TEST_FILE, "utf-8")), { status: "implementing" }), null, 1));
    await page.evaluate(() => { try { boardGet(); } catch (e) { /* 忽略 */ } });
    await page.waitForTimeout(1200);
    await selNode();
    await page.waitForTimeout(400);
    const revBefore = readDisk().rev;
    let editErr = "";
    try {
      await page.locator("#boardDetail .bdCmtEdit").first().click();
      await page.waitForSelector("#bdCmtEditInp", { timeout: 6000 });
      await page.fill("#bdCmtEditInp", NEW_TXT);
      await page.locator("#bdCmtEditSave").click();
    } catch (e) { editErr = String(e && e.message).slice(0, 100); }
    const diskUpd = await waitDisk(() => { const d = readDisk(); return d.comments && d.comments[0] === NEW_TXT ? d : null; });
    await page.waitForTimeout(700);
    const uiUpd = String(await page.locator("#boardDetail .bf-cmt-row .bf-cmt").first().textContent().catch(() => "")).trim();
    const rowsUpd = await page.locator("#boardDetail .bf-cmt-row").count();
    check("④ 评论「改」:UI 显示新文字 + 磁盘 comments 内容正确且数组长度不变",
      !editErr && uiUpd === NEW_TXT && !!diskUpd && diskUpd.comments.length === 1 && diskUpd.rev > revBefore,
      "selectors #boardDetail .bdCmtEdit → #bdCmtEditInp → #bdCmtEditSave" + (editErr ? " | 异常:" + editErr : "") +
      " | UI='" + uiUpd + "' 行数=" + rowsUpd + " 磁盘=" + JSON.stringify(readDisk().comments) + " rev " + revBefore + "→" + readDisk().rev);

    let delErr = "";
    try { await page.locator("#boardDetail .bdCmtDel").first().click(); } catch (e) { delErr = String(e && e.message).slice(0, 100); }
    const diskDel = await waitDisk(() => { const d = readDisk(); return d.comments && d.comments.length === 0 ? d : null; });
    await page.waitForTimeout(700);
    const rowsDel = await page.locator("#boardDetail .bf-cmt-row").count();
    const emptyTxt = String(await page.locator("#boardDetail .bf-comments").textContent().catch(() => ""));
    check("⑤ 评论「删」:UI 少一条 + 磁盘 comments 少一条",
      !delErr && rowsDel === 0 && !!diskDel && emptyTxt.includes("还没有评论"),
      "selector #boardDetail .bdCmtDel" + (delErr ? " | 异常:" + delErr : "") + " | UI 行数=" + rowsDel + " 磁盘=" + JSON.stringify(readDisk().comments));

    check("控制台零 pageerror", errs.length === 0, errs.slice(0, 2).join(" | "));
    await page.screenshot({ path: "/tmp/board-latest.png" });
    console.log("截图=/tmp/board-latest.png");
  } finally {
    await browser.close();
    try { await app.close(); } catch (e) { /* 已关 */ }
    rmSync(jd, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? "\nFAIL " + fails.length + "/" + results.length : "\nALL PASS " + results.length + "/" + results.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (err) { /* 忽略 */ } process.exit(1); });
