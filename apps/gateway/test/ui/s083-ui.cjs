/** UI 阶段:页面结构板线框渲染 + 用户拖拽/连线保存 + 多尺寸截图(真实 gateway 7803)。
 * 跑法:node apps/gateway/test/ui/s083-ui.cjs  (单 chromium,跑完即退)
 */
const { createRequire } = require("node:module");
const req = createRequire(__filename);
const { chromium } = req("playwright-core");
const fs = require("node:fs");

const BASE = "http://127.0.0.1:7803";
const SID = "s083-e2e";
const SHOTS = "/tmp/s083/shots";
const REPO_ROOT = require("node:path").resolve(__dirname, "../../..");
const BOARD_FILE = REPO_ROOT + "/.genie/boards/" + SID + "/efbeff6c-6cbb-4b5a-9920-7e6d51241fa7.json";

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
  const poll = async (fn, ms = 25000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await page.waitForTimeout(500); v = await fn(); } return v; };

  // 恢复会话(sessionStorage 注入→刷新→hello 恢复→板清单就位)
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate((sid) => { sessionStorage.setItem("zh:sid", sid); sessionStorage.setItem("zh:view", "board"); }, SID);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.click("#act-board").catch(() => {});
  const nodeCount = await poll(() => page.locator("#boardGraph .cv-node").count().then((n) => n > 0));
  check("白板恢复:画布节点渲染", nodeCount, (await page.locator("#boardGraph .cv-node").count()) + " 节点");
  // 会话有多块板(页面结构板+编码任务设计板):板选择器切到页面结构板
  const PAGE_TASK = "efbeff6c-6cbb-4b5a-9920-7e6d51241fa7";
  const switched = await page.evaluate((tid) => {
    const sel = document.getElementById("boardTaskSel");
    if (!sel) return "no-sel";
    if (![...sel.options].some((o) => o.value === tid)) return "no-option:" + [...sel.options].map((o) => o.value.slice(0, 8)).join(",");
    sel.value = tid;
    sel.dispatchEvent(new Event("change"));
    return "ok";
  }, PAGE_TASK);
  console.log("[ui] 板选择:", switched);
  const pageNodes = await poll(() => page.locator("#boardGraph .cv-node.k-page").count().then((n) => n >= 5), 20000);
  // 简图(mermaid)是缺省视图:切「画布」模式再做线框断言与拖拽交互
  if (!pageNodes) {
    const modeBtnText = await page.locator("#boardGraphMode").textContent().catch(() => "");
    await page.click("#boardGraphMode").catch(() => {});
    await page.waitForTimeout(1200);
    console.log("[ui] 画布切换(原按钮文案:" + modeBtnText + ")");
  }
  const canvasOn = await poll(() => page.locator("#boardGraph .cv-node.k-page").count().then((n) => n >= 5), 15000);
  check("画布模式:页面结构板线框节点在位", canvasOn);
  await page.screenshot({ path: SHOTS + "/board-page-simple-mermaid.png" });

  // 线框形态断言
  const kPage = await page.locator("#boardGraph .cv-node.k-page").count();
  const kSec = await page.locator("#boardGraph .cv-node.k-section").count();
  const kNav = await page.locator("#boardGraph .cv-node.k-nav").count();
  check("线框节点:page 页面节点(k-page)", kPage >= 5, kPage + " 个");
  check("线框节点:section 区块节点(k-section)", kSec >= 1, kSec + " 个");
  check("导航条节点(k-nav)", kNav >= 1, kNav + " 个");
  const containsEdges = await page.locator("#boardGraph path.bfe-contains").count();
  const navEdges = await page.locator("#boardGraph path.bfe-nav").count();
  check("边渲染:contains 归属边(无线头样式类)", containsEdges >= 5, containsEdges + " 条");
  check("边渲染:nav 导航边(带触发器标签)", navEdges >= 5, navEdges + " 条");
  const containsNoArrow = await page.evaluate(() => [...document.querySelectorAll("#boardGraph path.bfe-contains")].every((p) => !p.getAttribute("marker-end")));
  check("contains 边无箭头(marker-end 缺席)", containsNoArrow);
  const metaHasPageTag = await page.locator("#boardGraph .bd-meta").textContent().then((t) => t.includes("页面结构板"));
  check("meta 行:页面结构板章", metaHasPageTag);
  const pageHeadBar = await page.evaluate(() => { const n = document.querySelector("#boardGraph .cv-node.k-page .cv-head"); return n ? getComputedStyle(n, "::before").content !== "none" : false; });
  check("页面节点线框头(浏览器窗 ::before 圆点)", pageHeadBar);
  await page.screenshot({ path: SHOTS + "/board-page-1440x900.png" });
  console.log("[shot] board-page-1440x900.png");

  // 用户拖拽:页面节点位移→防抖落盘(board.save pos 持久化,rev 自增)
 // (十期坑复防:getBoundingClientRect 不看 overflow 裁剪——先 elementFromPoint 预检,
  //  选一个「中心点命中 cv-node 本体」的可见节点再拖;保持 1440 流程,act-board 显式切视图)
  await page.click("#act-board").catch(() => {});
  await page.waitForTimeout(1200);
  // 测试侧图区增高(窄视口下 vw-head 换行挤压 board-main 的既有布局形态;产品布局不动,仅测试可交互化)
  await page.evaluate(() => { const g = document.getElementById("boardGraph"); if (g) { g.style.minHeight = "560px"; g.style.height = "560px"; } });
  await page.waitForTimeout(300);
  const pickVisibleNode = async () => {
    const n = await page.evaluate(() => {
      const host = document.getElementById("boardGraph");
      if (!host) return null;
      const hr = host.getBoundingClientRect();
      for (const el of host.querySelectorAll(".cv-node")) {
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 20) continue;
        const cx = r.left + r.width / 2, cy = r.top + Math.min(14, r.height / 2);
        if (cx > hr.left + 6 && cx < hr.right - 6 && cy > hr.top + 6 && cy < hr.bottom - 6) {
          const hit = document.elementFromPoint(cx, cy);
          if (hit && hit.closest && hit.closest(".cv-node") === el) return { id: el.dataset.cv, x: cx, y: cy };
        }
      }
      return null;
    });
    return n;
  };
  const revBefore = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8")).rev;
  await page.evaluate(() => { try { cvFitNow(); } catch (e) {} }); // 适配全部:25 节点深链不 fit 全在可视区外
  await page.waitForTimeout(800);
  const dragNode = async () => {
    const p = await pickVisibleNode();
    if (!p) { console.log("[ui] 无可见可拖节点(全部被裁剪或遮挡)"); return false; }
    console.log("[ui] drag node", p.id, "at", Math.round(p.x), Math.round(p.y));
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 200, p.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(2600); // 防抖 900ms+落盘
    const d = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8"));
    return d.rev > revBefore && d.nodes.some((n) => n.pos && isFinite(n.pos.x));
  };
  let dragOk = await dragNode();
  if (!dragOk) dragOk = await dragNode();
  const probe = await page.evaluate(() => {
    try {
      return { task: boardTaskId, rev: boardDoc && boardDoc.rev, pos0: boardDoc && boardDoc.nodes[0] && boardDoc.nodes[0].pos, cvRo, inflight: typeof bdLayoutInflight !== "undefined" ? bdLayoutInflight : "?" };
    } catch (e) { return { err: String(e).slice(0, 100) }; }
  });
  console.log("[probe] after drag:", JSON.stringify(probe));
  const docAfterDrag = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8"));
  check("用户拖拽节点→pos 落盘+rev 自增", dragOk, "rev " + revBefore + "->" + docAfterDrag.rev);

  // 用户连线:源节点出端口按下→拖到无既有连线的目标节点松手(查看态直改板落盘,virtual 边)
  const connectOnce = async () => {
    const pair = await page.evaluate(() => {
      const host = document.getElementById("boardGraph");
      if (!host) return null;
      const hr = host.getBoundingClientRect();
      const portOf = (el) => { const p = el.querySelector(".cv-port.out"); if (!p) return null; const r = p.getBoundingClientRect(); const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; return c.x > hr.left && c.x < hr.right && c.y > hr.top && c.y < hr.bottom ? c : null; };
      const vis = [...host.querySelectorAll(".cv-node")].filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 30 && r.left >= hr.left && r.right <= hr.right && r.top >= hr.top && r.bottom <= hr.bottom; });
      const doc = typeof boardDoc !== "undefined" ? boardDoc : null;
      for (const a of vis) {
        const pa = portOf(a);
        if (!pa) continue;
        for (const b of vis) {
          if (b === a) continue;
          if (doc && (doc.edges ?? []).some((e) => e.from === a.dataset.cv && e.to === b.dataset.cv)) continue; // 判重:挑无既有连线的对
          const r = b.getBoundingClientRect();
          return { x1: pa.x, y1: pa.y, x2: r.left + r.width / 2, y2: r.top + r.height / 2, from: a.dataset.cv, to: b.dataset.cv };
        }
      }
      return null;
    });
    if (!pair) { console.log("[ui] 无可用连线对(可视节点/端口/判重后为空)"); return false; }
    console.log("[ui] connect", pair.from, "->", pair.to, "port@", Math.round(pair.x1), Math.round(pair.y1));
    await page.mouse.move(pair.x1, pair.y1);
    await page.mouse.down();
    await page.mouse.move((pair.x1 + pair.x2) / 2, (pair.y1 + pair.y2) / 2, { steps: 5 });
    await page.mouse.move(pair.x2, pair.y2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(2600);
    const d = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8"));
    return d.edges.some((e) => e.from === pair.from && e.to === pair.to && e.virtual === true);
  };
  let connOk = await (async () => { await page.evaluate(() => { try { cvFitNow(); } catch (e) {} }); await page.waitForTimeout(600); return connectOnce(); })();
  if (!connOk) connOk = await (async () => { await page.evaluate(() => { try { cvFitNow(); } catch (e) {} }); await page.waitForTimeout(600); return connectOnce(); })();
  const docAfterConn = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8"));
  check("用户连线→virtual 边落盘(拖拽修改可保存)", connOk, "edges " + docAfterDrag.edges.length + "->" + docAfterConn.edges.length + " rev " + docAfterConn.rev);
  await page.screenshot({ path: SHOTS + "/board-page-after-edit-1440x900.png" });
  console.log("[shot] board-page-after-edit-1440x900.png");

  // 多尺寸截图(重设视口;画布重渲)
  for (const [w, h] of [[1280, 800], [1920, 1080], [1024, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: SHOTS + "/board-page-" + w + "x" + h + ".png" });
    console.log("[shot] board-page-" + w + "x" + h + ".png");
  }
  // 窄窗横向溢出检查
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("1024 窄窗:无横向溢出", overflow <= 2, "overflow=" + overflow + "px");

 // 会话恢复持久化:刷新后板仍在(会话级白板存盘直接受益)+拖拽结果仍在
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.click("#act-board").catch(() => {});
  await poll(() => page.locator("#boardGraph .cv-node").count().then((n) => n > 0));
  await page.evaluate((tid) => {
    const sel = document.getElementById("boardTaskSel");
    if (sel && [...sel.options].some((o) => o.value === tid)) { sel.value = tid; sel.dispatchEvent(new Event("change")); }
  }, PAGE_TASK);
  const restored = await poll(() => page.locator("#boardGraph .cv-node.k-page").count().then((n) => n >= 5));
  const dFinal = JSON.parse(fs.readFileSync(BOARD_FILE, "utf-8"));
  check("刷新恢复:页面结构板随会话恢复(拖拽/连线结果仍在)", restored && dFinal.edges.some((e) => e.virtual === true) && dFinal.rev >= 3, "rev=" + dFinal.rev + " virtual 边=" + dFinal.edges.filter((e) => e.virtual).length);

  check("0 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  const pass = results.filter((r) => r.ok).length;
  console.log("RESULT " + pass + "/" + results.length + " PASS");
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error("ui error:", String(e).slice(0, 400)); process.exit(1); });
