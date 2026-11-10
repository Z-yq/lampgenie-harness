/** 白板画布控件逐个点测(自起临时实例 7792,不碰生产环境 7700)。
 * 判定三档:可用 / 不可用(点了有明确提示或明确禁用) / 静默失败(点了没反应且零提示)。
 * 覆盖:#cvZin #cvZout #cvZfit #cvZpct(只读) #cvAddBtn(+.cv-aitem 各项) #cvArrangeBtn
 *       每个 .cv-wchip + 「显示全部」(.cv-wall)、每个 .cv-fold、
 *       卡片单击/双击/拖拽、明细区评论 改/删/新增、编辑模式开关(#boardEditBtn)。
 * 数据源:真实板(**副本**)复制到测试 SID 目录(原文件一字不动),副本两处必要改造并如实说明:
 *   ① sessionId 换测试 SID(否则评论/布局落盘写回原板目录);② status done→implementing
 *   (原板 done 且 P0 未覆盖全会被 board-store 门禁拒写,评论改删测不到 UI 链路)。
 * 无 chrome/无 playwright-core/无真实板文件时打印 skipped: <reason> 并 exit 0。
 * 跑法:cd apps/gateway && npx tsx test/ui/boardbtn.spec.cjs
 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7792);
const SID = "ui-boardbtn-7792";
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
const CMT_NODE = "ta-tl";
const CMT_SEED = "预置评论:改删手测起点";

(async () => {
  const { createGatewayApp } = require("../../src/app.ts");
  const { servePanel } = require("../../src/panel.ts");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");

  const srcDoc = JSON.parse(fs.readFileSync(SRC_FILE, "utf-8"));
  const copy = JSON.parse(JSON.stringify(srcDoc));
  copy.sessionId = SID;
  copy.status = "implementing"; // 见文件头 ②
  const seedNode = (copy.nodes || []).find((n) => n.id === CMT_NODE);
  if (!seedNode) skip("真实板无节点 " + CMT_NODE);
  seedNode.comments = [...(seedNode.comments || []), CMT_SEED];
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, JSON.stringify(copy, null, 1));

  const jd = mkdtempSync(join(tmpdir(), "uibtn-"));
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
  const rows = [];
  const log = (ctrl, verdict, ev) => { rows.push({ ctrl, verdict, ev }); console.log("[" + verdict + "] " + ctrl + " — " + ev); };
  const readDisk = () => { try { return JSON.parse(fs.readFileSync(TEST_FILE, "utf-8")); } catch (e) { return null; } };

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
      await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
    }

    // 统一读数:文档节点数取 boardDoc(与 DOM 可见卡数分开——密度分层会折叠卡片)
    const st = () => page.evaluate(() => ({
      k: Math.round(cvPan.k * 10000) / 10000,
      cards: document.querySelectorAll("#boardGraph .cv-node").length,
      docNodes: boardDoc && boardDoc.nodes ? boardDoc.nodes.length : null,
      folds: document.querySelectorAll("#boardGraph .cv-fold").length,
      toasts: [...document.querySelectorAll("#toastHost .toast")].map((e) => e.textContent),
      pct: (document.getElementById("cvZpct") || {}).textContent || "",
      sel: typeof boardSelNode !== "undefined" ? boardSelNode : null,
      editOn: typeof boardEditOn !== "undefined" ? boardEditOn : null,
    }));
    const clearToast = () => page.evaluate(() => { const h = document.getElementById("toastHost"); if (h) h.innerHTML = ""; });
    const clickAt = async (sel, nth = 0) => {
      const loc = page.locator(sel).nth(nth);
      try { await loc.click({ timeout: 4000 }); return "real-click"; }
      catch (e) {
        const r = await page.evaluate(([s, n]) => {
          const el = document.querySelectorAll(s)[n];
          if (!el) return "missing";
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
          return "dispatch";
        }, [sel, nth]);
        return "real-click-fail→" + r;
      }
    };
    const verdictOf = (reacted, toasts) => (reacted ? "可用" : toasts && toasts.length ? "不可用(有提示)" : "静默失败");

    // ===== 缩放四键(先累计放大到 k≈1.09,「适」才有可见落差) =====
    await clearToast(); let a = await st(); await clickAt("#cvZin"); await page.waitForTimeout(250);
    await clickAt("#cvZin"); await page.waitForTimeout(300); let b = await st();
    log("#cvZin(放大)×2", b.k > a.k ? "可用" : verdictOf(false, b.toasts), "k " + a.k + "→" + b.k);
    a = await st(); await clickAt("#cvZout"); await page.waitForTimeout(300); b = await st();
    log("#cvZout(缩小)", b.k < a.k ? "可用" : verdictOf(false, b.toasts), "k " + a.k + "→" + b.k);
    await clearToast(); a = await st(); await clickAt("#cvZfit"); await page.waitForTimeout(600); b = await st();
    log("#cvZfit(适配全部)", Math.abs(b.k - a.k) > 1e-6 ? "可用" : verdictOf(false, b.toasts), "k " + a.k + "→" + b.k + " toast=" + JSON.stringify(b.toasts) + "(落差=适配后重新框满可见卡)");
    const pctOk = await page.evaluate(() => { const t = document.getElementById("cvZpct"); return t ? { txt: t.textContent, want: Math.round(cvPan.k * 100) + "%" } : null; });
    await clearToast(); await clickAt("#cvZpct"); await page.waitForTimeout(200);
    log("#cvZpct(百分比)", pctOk && pctOk.txt === pctOk.want ? "可用(只读显示,与 cvPan.k 同步)" : "不可用", "文本='" + (pctOk && pctOk.txt) + "' 期望='" + (pctOk && pctOk.want) + "' 点击无行为属预期(span 只读)");

    // ===== #cvAddBtn + .cv-aitem 各项 =====
    await clearToast(); await clickAt("#cvAddBtn"); await page.waitForTimeout(350);
    const panel = await page.evaluate(() => {
      const p = document.getElementById("cvAddPanel");
      return p ? { disp: getComputedStyle(p).display, items: p.querySelectorAll(".cv-aitem").length } : null;
    });
    log("#cvAddBtn(打开添加面板)", panel && panel.disp === "block" && panel.items > 0 ? "可用" : "静默失败", "面板 display=" + (panel && panel.disp) + " .cv-aitem=" + (panel && panel.items) + " 项");
    if (panel && panel.items) {
      const kinds = await page.evaluate(() => [...document.querySelectorAll("#cvAddPanel .cv-aitem")].map((e) => e.dataset.kind));
      console.log("添加面板各项(共 " + kinds.length + "): " + (await page.evaluate(() => [...document.querySelectorAll("#cvAddPanel .cv-aitem")].map((e) => e.dataset.kind + "=" + e.textContent.trim()).join(" | "))));
      const per = [];
      for (const kind of kinds) {
        await clearToast();
        const reopened = await page.evaluate(() => { const p = document.getElementById("cvAddPanel"); return p && getComputedStyle(p).display === "block"; });
        if (!reopened) { await clickAt("#cvAddBtn"); await page.waitForTimeout(250); }
        const before = await st();
        const how = await page.evaluate((k) => {
          const el = [...document.querySelectorAll("#cvAddPanel .cv-aitem")].find((e) => e.dataset.kind === k);
          if (!el) return "missing";
          el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons: 1 }));
          return "dispatch";
        }, kind);
        await page.waitForTimeout(500);
        const after = await st();
        const grew = after.docNodes > before.docNodes;
        per.push(kind + (grew ? "✓(+1 节点)" : (after.toasts.length ? "△有提示'" + after.toasts[0].slice(0, 28) + "'" : "✗静默")));
        if (grew) { // 撤销该项,避免 60 上限/后续计数污染(Ctrl+Z 需 cvHost 持焦)
          await page.evaluate(() => { const h = document.querySelector("#boardGraph #cvHost"); if (h) h.focus(); });
          await page.keyboard.press("Control+z");
          await page.waitForTimeout(400);
        }
      }
      const bad = per.filter((s) => s.includes("✗"));
      log(".cv-aitem 各项(" + kinds.length + " 项)", bad.length ? "有静默失败项" : "可用", per.join(" | ") + " | 点击方式=panel 内 pointerdown 委派 | 之后节点数=" + (await st()).docNodes);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    }

    // ===== #cvArrangeBtn(先把一个可见节点拖歪,「整理」才会产生可见落差) =====
    const dragTarget = await page.evaluate(() => {
      const h = document.querySelector("#boardGraph #cvHost");
      if (!h) return null;
      const hr = h.getBoundingClientRect();
      for (const el of document.querySelectorAll("#boardGraph .cv-node")) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 30) continue;
        if (r.left < hr.left + 20 || r.top < hr.top + 20 || r.right > hr.right - 20 || r.bottom > hr.bottom - 20) continue;
        return { id: el.dataset.cv, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 12), left: el.style.left, top: el.style.top };
      }
      return null;
    });
    if (dragTarget) {
      await clearToast();
      const rev0 = (readDisk() || {}).rev;
      await page.mouse.move(dragTarget.x, dragTarget.y);
      await page.mouse.down();
      for (let s = 1; s <= 8; s++) { await page.mouse.move(dragTarget.x + s * 18, dragTarget.y + s * 12); await page.waitForTimeout(50); }
      await page.mouse.up();
      await page.waitForTimeout(1200);
      const after = await page.evaluate((id) => { const el = document.querySelector('#boardGraph .cv-node[data-cv="' + id + '"]'); return el ? { left: el.style.left, top: el.style.top } : null; }, dragTarget.id);
      const rev1 = (readDisk() || {}).rev;
      const moved = after && (after.left !== dragTarget.left || after.top !== dragTarget.top);
      log("画布节点卡拖拽(" + dragTarget.id + ")", moved ? "可用" : "静默失败", "left/top " + dragTarget.left + "," + dragTarget.top + " → " + (after && after.left + "," + after.top) + " 磁盘 rev " + rev0 + "→" + rev1);

      await clearToast();
      const pos0 = await page.evaluate(() => [...document.querySelectorAll("#boardGraph .cv-node")].map((e) => e.dataset.cv + "@" + e.style.left + "," + e.style.top).join(";"));
      await clickAt("#cvArrangeBtn"); await page.waitForTimeout(900);
      const pos1 = await page.evaluate(() => [...document.querySelectorAll("#boardGraph .cv-node")].map((e) => e.dataset.cv + "@" + e.style.left + "," + e.style.top).join(";"));
      const t1 = (await st()).toasts;
      log("#cvArrangeBtn(整理)", pos1 !== pos0 ? "可用" : verdictOf(false, t1), "拖歪后点整理:位置串变化=" + (pos1 !== pos0) + " toast=" + JSON.stringify(t1) + "(无 toast 属现状:整理成功不提示)");
    } else log("画布节点卡拖拽 / #cvArrangeBtn", "不可用", "画布内无完整可见节点卡,拖拽无实测条件");

    // ===== .cv-wchip ×N + 「显示全部」 =====
    const total = (await st()).cards;
    const chipN = await page.locator("#boardGraph .cv-wchip").count();
    const chipLog = [];
    for (let i = 0; i < chipN; i++) {
      await clearToast();
      const txt = (await page.locator("#boardGraph .cv-wchip").nth(i).textContent().catch(() => "")).trim();
      const before = await st();
      await clickAt("#boardGraph .cv-wchip", i);
      await page.waitForTimeout(500);
      const after = await st();
      const on = await page.evaluate((n) => { const e = document.querySelectorAll("#boardGraph .cv-wchip")[n]; return e ? e.classList.contains("on") : null; }, i);
      const wallNow = await page.locator("#boardGraph .cv-wall").count();
      chipLog.push("chip[" + i + "]'" + txt + "'" + (after.cards !== before.cards || after.toasts.length ? "✓" : "✗") + " 可见卡 " + before.cards + "→" + after.cards + " on=" + on + "「显示全部」在场=" + wallNow);
      // 还原:「显示全部」在场就点它(顺带测该控件),否则再点一次该 chip
      if (wallNow) { await clickAt("#boardGraph .cv-wall"); await page.waitForTimeout(450); }
      else { await clickAt("#boardGraph .cv-wchip", i); await page.waitForTimeout(450); }
    }
    log(".cv-wchip ×" + chipN + " 逐个(过滤开关)", chipLog.some((s) => s.includes("✗")) ? "有静默失败项" : "可用", chipLog.join(" | "));
    // 「显示全部」单测:先点一个 chip 造出过滤态(该控件只在过滤态渲染)
    await page.evaluate(() => { const c = document.querySelector("#boardGraph .cv-wchip"); if (c) c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true })); });
    await page.waitForTimeout(450);
    const wallCount = await page.locator("#boardGraph .cv-wall").count();
    const filteredCards = (await st()).cards;
    await clearToast();
    if (wallCount) {
      await clickAt("#boardGraph .cv-wall"); await page.waitForTimeout(600);
      const allCards = (await st()).cards;
      log("「显示全部」(.cv-wall)", allCards !== filteredCards ? "可用" : verdictOf(false, (await st()).toasts), "过滤态可见卡=" + filteredCards + " → 显示全部后=" + allCards + "(全量基线 " + total + ")");
    } else log("「显示全部」(.cv-wall)", "不可用", "过滤态下仍未渲染 .cv-wall(该控件缺失)");

    // ===== .cv-fold 逐个(展开/收起都算有反应) =====
    const foldN0 = await page.locator("#boardGraph .cv-fold").count();
    const foldLog = [];
    for (let i = 0; i < Math.min(foldN0, 6); i++) {
      await clearToast();
      const before = await st();
      const fTxt = (await page.locator("#boardGraph .cv-fold").nth(0).textContent().catch(() => "")).trim();
      await clickAt("#boardGraph .cv-fold", 0);
      await page.waitForTimeout(600);
      const after = await st();
      const reacted = after.cards !== before.cards || after.folds !== before.folds || after.toasts.length > 0;
      foldLog.push("fold'" + fTxt.slice(0, 16) + "'" + (reacted ? "✓" : "✗") + " 可见卡 " + before.cards + "→" + after.cards + " fold 数 " + before.folds + "→" + after.folds);
      if (!reacted) break;
    }
    log(".cv-fold ×" + foldN0 + "(点前 6 次)", foldLog.some((s) => s.includes("✗")) ? "有静默失败项" : "可用", foldLog.join(" | ") || "(样本无 .cv-fold)");

    // ===== 卡片单击 / 双击 =====
    await clearToast();
    const cardSel = '#boardNodes .bd-card[data-node="' + CMT_NODE + '"]';
    const hasCard = await page.locator(cardSel).count();
    if (hasCard) {
      await page.evaluate((s) => { const c = document.querySelector(s); if (c) c.scrollIntoView({ block: "center" }); }, cardSel);
      await page.waitForTimeout(200);
      await clickAt(cardSel);
      await page.waitForTimeout(500);
      const one = await page.evaluate(() => ({
        on: [...document.querySelectorAll("#boardNodes .bd-card.on")].map((e) => e.dataset.node),
        detail: (document.getElementById("boardDetail") || {}).innerText || "",
        sel: typeof boardSelNode !== "undefined" ? boardSelNode : null,
      }));
      log(".bd-card 单击(" + CMT_NODE + ")", one.on.includes(CMT_NODE) && one.sel === CMT_NODE && one.detail.length > 20 ? "可用" : "静默失败",
        ".on=" + JSON.stringify(one.on) + " boardSelNode=" + one.sel + " 明细首行='" + (one.detail.split("\n")[0] || "").slice(0, 36) + "'");
      await clearToast();
      const b2 = await st();
      // 双击语义核对:白板卡清单未绑 dblclick(单击已是全部交互),但双击=两次 click 应仍落到「选中」——
      // 先把选中态挪到别的卡,再双击目标卡,看它是否被选上(有反应=可用;无反应才算静默失败)
      const otherCard = await page.evaluate((id) => {
        const c = [...document.querySelectorAll("#boardNodes .bd-card[data-node]")].find((e) => e.dataset.node !== id);
        return c ? c.dataset.node : null;
      }, CMT_NODE);
      if (otherCard) { await clickAt('#boardNodes .bd-card[data-node="' + otherCard + '"]'); await page.waitForTimeout(400); }
      const b3 = await st();
      try { await page.locator(cardSel).dblclick({ timeout: 4000 }); } catch (e) { /* 不可点则跳过 */ }
      await page.waitForTimeout(600);
      const a2 = await st();
      const dblReact = a2.sel === CMT_NODE && b3.sel !== CMT_NODE;
      log(".bd-card 双击", dblReact ? "可用(双击=两次 click,选中态落到该卡;无独立双击语义)" : verdictOf(false, a2.toasts),
        "先把选中移到 '" + otherCard + "'(" + b3.sel + ")→双击 " + CMT_NODE + " 后 boardSelNode=" + a2.sel + " 卡数 " + b2.cards + "→" + a2.cards + " toast=" + JSON.stringify(a2.toasts));
    } else log(".bd-card 单击/双击", "不可用", "节点卡清单无 " + CMT_NODE);

    // ===== 节点卡清单尺寸(任务 3 验收:max-height 260px、标题不截断、验收三态可读) =====
    const cardBox = await page.evaluate(() => {
      const box = document.getElementById("boardNodes");
      const card = document.querySelector("#boardNodes .bd-card[data-node]");
      if (!box || !card) return null;
      const cs = getComputedStyle(box), cc = getComputedStyle(card);
      const name = card.querySelector(".bd-name");
      const sum = card.querySelector(".bd-sum");
      const acc = card.querySelector(".bd-acc-row");
      const ncs = name ? getComputedStyle(name) : null;
      const acs = acc ? getComputedStyle(acc) : null;
      return {
        maxH: cs.maxHeight, clientH: box.clientHeight, scrollH: box.scrollHeight,
        cardPad: cc.paddingTop + " " + cc.paddingRight, cardW: Math.round(card.getBoundingClientRect().width),
        nameFs: ncs ? ncs.fontSize : null, nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : null,
        sumFs: sum ? getComputedStyle(sum).fontSize : null,
        accFs: acs ? acs.fontSize : null, accRows: card.querySelectorAll(".bd-acc-row").length,
        titleSample: name ? name.textContent.trim().slice(0, 26) : "",
      };
    });
    if (cardBox) {
      console.log("节点卡清单尺寸: max-height=" + cardBox.maxH + " clientH=" + cardBox.clientH + " scrollH=" + cardBox.scrollH +
        " | 卡内边距=" + cardBox.cardPad + " 卡宽=" + cardBox.cardW + "px | .bd-name " + cardBox.nameFs + "(截断=" + cardBox.nameClipped + ") .bd-sum " +
        cardBox.sumFs + " .bd-acc-row " + cardBox.accFs + "(" + cardBox.accRows + " 行)");
      log("节点卡清单尺寸(任务 3)",
        cardBox.maxH === "260px" && cardBox.scrollH > cardBox.clientH ? "可用(max-height 260px 生效且清单内部滚动)" : "不可用",
        "max-height " + cardBox.maxH + " 实际可视高 " + cardBox.clientH + "px(内容 " + cardBox.scrollH + "px→内部滚动) 卡内边距 " + cardBox.cardPad +
        " .bd-name " + cardBox.nameFs + " 标题截断=" + cardBox.nameClipped + " .bd-sum " + cardBox.sumFs + " 验收行 " + cardBox.accFs + "/" + cardBox.accRows + " 行");
    } else log("节点卡清单尺寸(任务 3)", "不可用", "#boardNodes/.bd-card 缺失");

    // ===== 明细区评论 改 / 删 / 新增 =====
    await page.evaluate((id) => { const el = document.querySelector('#boardGraph .cv-node[data-cv="' + id + '"]'); if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); }, CMT_NODE);
    await page.waitForTimeout(700);
    const cmtRows0 = await page.locator("#boardDetail .bf-cmt-row").count();
    console.log("明细区(选中 " + CMT_NODE + ")评论行数=" + cmtRows0);
    // 改
    await clearToast(); let editOk = false, editEv = "";
    try {
      await page.locator("#boardDetail .bdCmtEdit").first().click({ timeout: 5000 });
      await page.waitForSelector("#bdCmtEditInp", { timeout: 5000 });
      await page.fill("#bdCmtEditInp", "改后评论:按钮点测");
      await page.locator("#bdCmtEditSave").click();
      await page.waitForTimeout(1600);
      const uiTxt = (await page.locator("#boardDetail .bf-cmt-row .bf-cmt").first().textContent().catch(() => "")).trim();
      const nd = ((readDisk() || {}).nodes || []).find((x) => x.id === CMT_NODE) || {};
      editOk = uiTxt === "改后评论:按钮点测" && (nd.comments || [])[0] === "改后评论:按钮点测";
      editEv = "UI='" + uiTxt + "' 磁盘=" + JSON.stringify(nd.comments);
    } catch (e) { editEv = "异常 " + String(e && e.message).slice(0, 80); }
    log("明细区评论「改」(.bdCmtEdit→#bdCmtEditSave)", verdictOf(editOk, (await st()).toasts), editEv + " toast=" + JSON.stringify((await st()).toasts.slice(0, 1)));
    // 删
    await clearToast(); let delOk = false, delEv = "";
    try {
      await page.locator("#boardDetail .bdCmtDel").first().click({ timeout: 5000 });
      await page.waitForTimeout(1600);
      const rows2 = await page.locator("#boardDetail .bf-cmt-row").count();
      const nd = ((readDisk() || {}).nodes || []).find((x) => x.id === CMT_NODE) || {};
      delOk = rows2 === cmtRows0 - 1 && (nd.comments || []).length === 0;
      delEv = "行数 " + cmtRows0 + "→" + rows2 + " 磁盘=" + JSON.stringify(nd.comments);
    } catch (e) { delEv = "异常 " + String(e && e.message).slice(0, 80); }
    log("明细区评论「删」(.bdCmtDel)", verdictOf(delOk, (await st()).toasts), delEv);
    // 新增
    await clearToast(); let addOk = false, addEv = "";
    try {
      const hasInp = await page.locator("#boardDetail #bdCmtInput").count();
      if (!hasInp) addEv = "明细区无 #bdCmtInput";
      else {
        await page.fill("#boardDetail #bdCmtInput", "新增评论:按钮点测");
        await page.locator("#boardDetail #bdCmtSend").click();
        await page.waitForTimeout(1600);
        const rows3 = await page.locator("#boardDetail .bf-cmt-row").count();
        const nd = ((readDisk() || {}).nodes || []).find((x) => x.id === CMT_NODE) || {};
        addOk = rows3 >= 1 && (nd.comments || []).includes("新增评论:按钮点测");
        addEv = "行数=" + rows3 + " 磁盘=" + JSON.stringify(nd.comments) + " toast=" + JSON.stringify((await st()).toasts.slice(0, 2));
      }
    } catch (e) { addEv = "异常 " + String(e && e.message).slice(0, 80); }
    log("明细区评论「新增」(#bdCmtInput→#bdCmtSend)", verdictOf(addOk, (await st()).toasts), addEv);

    // ===== 编辑模式开关 =====
    await clearToast();
    const e0 = await page.evaluate(() => ({ bar: getComputedStyle(document.getElementById("boardEditBar")).display, on: boardEditOn, addCard: document.querySelectorAll("#boardNodes .bd-card[data-add]").length }));
    await clickAt("#boardEditBtn"); await page.waitForTimeout(800);
    const e1 = await page.evaluate(() => ({ bar: getComputedStyle(document.getElementById("boardEditBar")).display, on: boardEditOn, addCard: document.querySelectorAll("#boardNodes .bd-card[data-add]").length, btn: document.getElementById("boardEditBtn").textContent }));
    const tE = (await st()).toasts;
    log("#boardEditBtn(编辑模式开)", e1.on !== e0.on && e1.bar !== "none" ? "可用" : verdictOf(false, tE), "boardEditOn " + e0.on + "→" + e1.on + " 编辑条 display " + e0.bar + "→" + e1.bar + " 「+加模块」卡 " + e0.addCard + "→" + e1.addCard + " 按钮='" + e1.btn + "'");
    await clearToast();
    await clickAt("#boardEditBtn"); await page.waitForTimeout(700);
    const e2 = await page.evaluate(() => ({ bar: getComputedStyle(document.getElementById("boardEditBar")).display, on: boardEditOn }));
    log("#boardEditBtn(编辑模式关)", e2.on === false && e2.bar === "none" ? "可用" : "静默失败", "boardEditOn " + e1.on + "→" + e2.on + " 编辑条 display " + e1.bar + "→" + e2.bar);

    console.log("控制台 pageerror " + errs.length + " 条" + (errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""));
    await page.screenshot({ path: "/tmp/board-btn.png" });
    console.log("截图=/tmp/board-btn.png");
  } finally {
    await browser.close();
    try { await app.close(); } catch (e) { /* 已关 */ }
    rmSync(jd, { recursive: true, force: true });
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  const bad = rows.filter((r) => r.verdict.indexOf("静默失败") >= 0);
  console.log("\n汇总: 共 " + rows.length + " 项;静默失败 " + bad.length + " 项" + (bad.length ? ": " + bad.map((r) => r.ctrl).join(", ") : ""));
  process.exit(0);
})().catch((e) => { console.error("SPEC CRASH", e); try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (err) { /* 忽略 */ } process.exit(1); });
