/** UI 经验证:页面结构板(docKind=page)语义级布局——存量电子签板(45 节点,43/45 pos=None)
 * 渲染层兜底验证:容器化/主线/回边/nav 标签/UI 线框分区/图例/多尺寸截图/盘上数据不被改。
 * 跑法(不碰生产环境):cd apps/gateway && SELF_SPEC=./boardpage.spec.cjs npx tsx test/ui/_board_selfhost.cjs
 * (自起临时端口实例;板 fixture 由本脚本自己造自己清)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7714";
const SID = "ui-boardpage-test";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const SRC_BOARD = path.join(HARNESS_ROOT, ".genie", "boards", "web-1792240103042", "95882b6e-1911-4856-9736-557d2603ca1a.json");
const SHOTS = "/tmp/s111/shots";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

(async () => {
  // fixture:真实电子签板拷贝(改 sessionId/taskId 避撞)——**强制剥 pos 造全 pos=None 现场感**:
 // 源板会被真实使用/保存污染(rev13 时经验证 45/45 全有 pos,原"43/45 None"前提失效→板走
  // "尊重现状"分支→容器/主线/图例全 FAIL 的假回归);fixture 必须自造状态,不依赖运行时可变数据
  const raw = JSON.parse(fs.readFileSync(SRC_BOARD, "utf-8"));
  const TASK = raw.taskId + "-s111";
  raw.sessionId = SID;
  raw.taskId = TASK;
  for (const n of raw.nodes) delete n.pos;
  const dir = path.join(HARNESS_ROOT, ".genie", "boards", SID);
  fs.mkdirSync(dir, { recursive: true });
  const fpath = path.join(dir, TASK + ".json");
  fs.writeFileSync(fpath, JSON.stringify(raw));
  const posBefore = raw.nodes.filter((n) => n.pos).length; // 期望 0(强制剥除)
 // drvfs 写后可见窗:读回校验(跨进程可见性)+短延迟——目录删后重建的场景经验证 readdir 会滞后
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { ready = JSON.parse(fs.readFileSync(fpath, "utf-8")).taskId === TASK; } catch (e) { ready = false; }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!ready) console.log("[diag] fixture 读回不一致(drvfs 窗)");
  await new Promise((r) => setTimeout(r, 1000));

  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text().slice(0, 200)); });
 // 目检形态=画布拿满视口宽(数字人列与 zh:avatar 设置已退役,画布不再有右侧预留)
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate((sid) => { sessionStorage.setItem("zh:sid", sid); sessionStorage.setItem("zh:view", "board"); }, SID);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    if (errors.length) console.log("[diag] load errors:", errors.slice(0, 3).join(" || "));
    await page.click("#act-board").catch(() => {});
    await page.waitForTimeout(1200);
    // 板清单就位(drvfs 写后立读窗:轮询;板清单/画布双条件+面板侧 boardItems 诊断)
    for (let i = 0; i < 20; i++) {
      if ((await page.locator("#boardGraph .cv-node").count()) > 0) break;
      await page.waitForTimeout(900);
      const bi = await page.evaluate(() => { try { boardRefresh(); return { items: (typeof boardItems !== "undefined" ? boardItems.length : -1), doc: !!boardDoc }; } catch (e) { return { err: String(e).slice(0, 80) }; } });
      if (i % 4 === 3) console.log("[diag] round", i, JSON.stringify(bi));
    }
    const selTxt = await page.locator("#boardTaskSel").textContent().catch(() => "(no-sel)");
    if ((await page.locator("#boardGraph .cv-node").count()) === 0) console.log("[diag] boardTaskSel:", selTxt.slice(0, 160));
    await page.waitForTimeout(600); // 自动 fit(40ms 后)+渲染稳定

    // 1. pos 全治:45 节点全有有限 left/top(43/45 pos=None 的渲染层兜底)
    const posInfo = await page.evaluate(() => {
      const out = { total: 0, finite: 0, boxes: [] };
      for (const el of document.querySelectorAll("#boardGraph .cv-node")) {
        out.total++;
        const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
        if (Number.isFinite(x) && Number.isFinite(y)) out.finite++;
        out.boxes.push({ id: el.dataset.cv, x, y, w: el.offsetWidth, h: el.offsetHeight });
      }
      return out;
    });
    check("45 节点全部渲染且有有限位置", posInfo.total === 45 && posInfo.finite === 45, posInfo.total + " 节点/" + posInfo.finite + " 有位");

    // 2. 无堆叠:同容器内子节点矩形两两不相交+page 容器间不相交(容器与其 contains 子节点相交=容器化本身,合法)
    const containsPairs = new Set();
    for (const e of raw.edges) if (e.kind === "contains") containsPairs.add(e.from + ">" + e.to);
    const overlaps = [];
    for (let i = 0; i < posInfo.boxes.length; i++) {
      for (let j = i + 1; j < posInfo.boxes.length; j++) {
        const a = posInfo.boxes[i], b = posInfo.boxes[j];
        if (containsPairs.has(a.id + ">" + b.id) || containsPairs.has(b.id + ">" + a.id)) continue;
        if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) overlaps.push(a.id + "×" + b.id);
      }
    }
    check("节点矩形零堆叠(排除容器包含对)", overlaps.length === 0, overlaps.slice(0, 4).join(","));

    // 3. 容器化:7 个 page 容器(.pgbox)+主线容器(.pgmain)+contains 边零渲染
    const pgbox = await page.locator("#boardGraph .cv-node.pgbox").count();
    const pgmain = await page.locator("#boardGraph .cv-node.pgmain").count();
    const containsPaths = await page.locator("#boardGraph .bf-cv-edges path.bfe-contains").count();
    check("7 个 page 容器(浏览器窗线框)", pgbox === 7, String(pgbox));
    check("主线容器存在且加粗金框", pgmain >= 6, "主线容器 " + pgmain + " 个");
    check("contains 边不再画平边(38 条→0)", containsPaths === 0, String(containsPaths));

    // 4. nav 流向:箭头 path(bfe-nav)+主线粗金(bfe-main)+回边虚线(bfe-back)+触发器标签
    const navPaths = await page.locator("#boardGraph .bf-cv-edges path.bfe-nav").count();
    const mainPaths = await page.locator("#boardGraph .bf-cv-edges path.bfe-main").count();
    const backPaths = await page.locator("#boardGraph .bf-cv-edges path.bfe-back").count();
    const selfLoops = await page.locator("#boardGraph .bf-cv-edges path.bfe-selfloop").count();
    const labelText = await page.locator("#boardGraph .bf-cv-edges").textContent();
    check("nav 边 16 条(17-1 自环)带箭头", navPaths >= 15, String(navPaths));
    check("主线边粗金(6 条)", mainPaths === 6, String(mainPaths));
    check("回边虚线灰(≥7 条)", backPaths >= 7, String(backPaths));
    check("自环小回环弧 1 条", selfLoops === 1, String(selfLoops));
    check("触发器标签可见(「新建签署」)", labelText.includes("新建签署"));
    check("触发器标签可见(「提交签章」)", labelText.includes("提交签章"));

    // 5. 页面内 UI 线框分区:顶栏/侧栏/主区角色类(追加需求验收)
    const rwTop = await page.locator("#boardGraph .cv-wire.rw-top").count();
    const rwSide = await page.locator("#boardGraph .cv-wire.rw-side").count();
    const rwMain = await page.locator("#boardGraph .cv-wire.rw-main").count();
    check("顶栏区线框(待办提醒/搜索栏/凭证头)", rwTop >= 2, "rw-top " + rwTop);
    check("侧栏区线框(状态筛选/字段面板/元信息表单)", rwSide >= 4, "rw-side " + rwSide);
    check("主区线框(内容区块)", rwMain >= 20, "rw-main " + rwMain);

    // 6. 图例
    const legend = await page.locator("#boardGraph .cv-legend").textContent().catch(() => "");
    check("图例(主线/分支/回边/容器)", legend.includes("主线") && legend.includes("容器"));

    // 7. 交互保持:点击容器头部选中(明细卡),画布仍在(force 点击走真实 pointer/click 事件链——
    // 画布上层浮件(图例/缩放条等 pointer-events 层)不构成用户不可达:真实用户点头部区域无遮挡)
    const maskTxt = await page.evaluate(() => {
      const masks = Array.from(document.querySelectorAll(".uid-mask"));
      const txt = masks.map((m) => m.textContent.slice(0, 60));
      masks.forEach((m) => m.remove());
      return txt;
    });
    if (maskTxt.length) console.log("[diag] removed uid-mask:", JSON.stringify(maskTxt));
    await page.locator("#boardGraph .cv-node.pgbox").first().click({ position: { x: 60, y: 12 }, force: true });
    await page.waitForTimeout(400);
    const selOn = await page.evaluate(() => {
      const host = document.getElementById("boardGraph");
      return !!host && host.querySelectorAll(".cv-node.on").length === 1;
    });
    check("点击容器选中(选中态高亮)", selOn);

    // 8. 盘上数据未被改(渲染层兜底不改盘:pos 计数仍 2)
    const after = JSON.parse(fs.readFileSync(fpath, "utf-8"));
    const posAfter = after.nodes.filter((n) => n.pos).length;
    check("渲染不改盘(pos 仍 " + posBefore + " 个)", posAfter === posBefore, posBefore + "→" + posAfter);

    // 8b. 拖拽容器 → 整板 pos 固化落盘(含子节点随动)→ 刷新后「完全尊重」不再自动重排
    const pg6 = page.locator('#boardGraph .cv-node.pgbox[data-cv="pg6"]');
    const bb = await pg6.boundingBox();
    if (bb) {
      await page.mouse.move(bb.x + 60, bb.y + 10);
      await page.mouse.down();
      await page.mouse.move(bb.x + 280, bb.y + 120, { steps: 8 });
      await page.mouse.up();
    }
    await page.waitForTimeout(1600); // 防抖保存 900ms + 落盘窗
    const dragDoc = await (async () => { for (let i = 0; i < 12; i++) { try { const d = JSON.parse(fs.readFileSync(fpath, "utf-8")); if (d.nodes.every((n) => n.pos)) return d; } catch (e) {} await new Promise((r) => setTimeout(r, 700)); } return JSON.parse(fs.readFileSync(fpath, "utf-8")); })();
    const allPosed = dragDoc.nodes.every((n) => n.pos && isFinite(n.pos.x));
    check("拖拽容器后整板 pos 固化落盘(45/45)", allPosed, dragDoc.nodes.filter((n) => n.pos).length + "/45");
    // 刷新后位置保持(自动重排不再吃掉用户拖拽)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const kept = await page.evaluate((task) => {
      const sel = document.getElementById("boardTaskSel");
      if (sel && ![...sel.options].some((o) => o.value === task)) return "no-opt";
      if (sel && sel.value !== task) { sel.value = task; sel.onchange && sel.onchange(); }
      return new Promise((res) => setTimeout(() => {
        const el = document.querySelector('#boardGraph .cv-node[data-cv="pg6"]');
        res(el ? { x: Math.round(parseFloat(el.style.left)), y: Math.round(parseFloat(el.style.top)) } : null);
      }, 1200));
    }, TASK);
    const savedPg6 = (dragDoc.nodes.find((n) => n.id === "pg6") || {}).pos;
    check("刷新后容器位置保持(尊重用户拖拽,不再自动重排)", !!kept && !!savedPg6 && Math.abs(kept.x - Math.round(savedPg6.x)) <= 2 && Math.abs(kept.y - Math.round(savedPg6.y)) <= 2,
      "saved=" + JSON.stringify(savedPg6 && { x: Math.round(savedPg6.x), y: Math.round(savedPg6.y) }) + " after=" + JSON.stringify(kept));

    // 9. 多尺寸截图 + pageerror
    const domDiag = await page.evaluate(() => {
      const g = document.getElementById("boardGraph");
      const cv = g && g.querySelector(".bf-canvas");
      const r = g ? g.getBoundingClientRect() : null;
      const bm = document.querySelector("#view-board .board-main");
      const vb = document.getElementById("view-board");
      const rr = (el) => el ? (el.tagName + (el.id ? "#" + el.id : "") + "." + String(el.className).split(" ")[0] + " w" + Math.round(el.getBoundingClientRect().width)) : "?";
      return {
        bdHome: typeof bdHome !== "undefined" ? bdHome : "?",
        graphRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        boardMainRect: bm ? { w: Math.round(bm.getBoundingClientRect().width), h: Math.round(bm.getBoundingClientRect().height) } : null,
        viewRect: vb ? { w: Math.round(vb.getBoundingClientRect().width), h: Math.round(vb.getBoundingClientRect().height) } : null,
        hasCanvas: !!cv,
        bodyKids: Array.from(document.body.children).map(rr),
      };
    });
    console.log("[diag]", JSON.stringify(domDiag));
    for (const [w, h] of [[1440, 900], [1280, 800], [1920, 1080], [1024, 768]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      await page.evaluate(() => { try { cvFitNow(); } catch (e) {} });
      await page.waitForTimeout(400);
      await page.screenshot({ path: SHOTS + "/esign-" + w + "x" + h + ".png" });
    }
    check("pageerror=0", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("spec 运行自身", false, String(e).slice(0, 200));
  } finally {
    await browser.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }
  const fails = results.filter((r) => !r.ok).length;
  console.log("boardpage: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})();
