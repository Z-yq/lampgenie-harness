/** done 板拖拽守卫 行为探针(重试轮,最小改动面)。
 * 验证:①done 板拖拽不落盘 + 弹自绘确认条;②取消→位置回滚为拖拽前值(DOM/doc/盘三处);
 * ③取消不记忆(再拖还问);④允许编辑→sessionStorage 记住 + 补落盘,后续拖拽直通;
 * ⑤非 done(draft)板拖拽不弹条不误伤(旧行为保持)。
 * 跑法(不碰生产环境):cd apps/gateway && SELF_PORT=7716 SELF_SPEC=./bddoneguard.spec.cjs npx tsx test/ui/_board_selfhost.cjs
 * board fixture 自己造自己清。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "ui-bddone-test";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

const mk = (taskId, status, title, x1) => ({
  version: 1, taskId, sessionId: SID, title, status, rev: 1, root: HARNESS_ROOT, docKind: "design",
  nodes: [
    { id: "g1", kind: "function", label: "守卫节点甲", summary: "拖拽目标", change: "modify", done: true, pos: { x: x1, y: 60 }, flow: [] },
    { id: "g2", kind: "function", label: "守卫节点乙", summary: "对照组", change: "keep", done: true, pos: { x: x1, y: 260 }, flow: [] },
  ],
  edges: [], planned_files: [], updatedAt: Date.now(),
});

(async () => {
  const dir = path.join(HARNESS_ROOT, ".genie", "boards", SID);
  fs.mkdirSync(dir, { recursive: true });
  const DONE_TASK = "t-done-guard";
  const DRAFT_TASK = "t-draft-ctrl";
  const donePath = path.join(dir, DONE_TASK + ".json");
  const draftPath = path.join(dir, DRAFT_TASK + ".json");
  fs.writeFileSync(donePath, JSON.stringify(mk(DONE_TASK, "done", "守卫探针:darn 板", 120)));
  // 对照板 updatedAt 更旧 → 板清单排序 done 板在前(自动选中不受扰)
  const draftDoc = mk(DRAFT_TASK, "draft", "守卫探针:draft 对照", 120);
  draftDoc.updatedAt = Date.now() - 86400_000;
  fs.writeFileSync(draftPath, JSON.stringify(draftDoc));
  const readDisk = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch (e) { return null; } };
  const diskPos = (p, id) => { const d = readDisk(p); const n = d && d.nodes.find((x) => x.id === id); return n && n.pos ? { x: n.pos.x, y: n.pos.y } : null; };
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 200)));
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board").catch(() => {});
    // 画布就位(板清单 drvfs 写后可见窗:轮询)
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(900);
      if ((await page.locator("#boardGraph .cv-node").count()) > 0) break;
      if ((await page.locator("#boardGraphMode").count()) > 0) await page.click("#boardGraphMode").catch(() => {});
      await page.evaluate(() => { try { boardRefresh(); } catch (e) {} });
    }
    const cvN = await page.locator("#boardGraph .cv-node").count();
    check("画布就位(done 板节点卡在场)", cvN === 2, "cv-node=" + cvN);
    check("板选中=done 探针板", await page.evaluate(() => boardDoc && boardDoc.taskId) === DONE_TASK, "taskId=" + (await page.evaluate(() => boardDoc && boardDoc.taskId)));
    check("前置:板 status=done(面板已加载)", await page.evaluate(() => boardDoc && boardDoc.status) === "done");

    const dragBy = async (dx, dy) => {
      const box = await page.locator('#boardGraph .cv-node[data-cv="g1"]').boundingBox();
      if (!box) return false;
      await page.mouse.move(box.x + 60, box.y + 12);
      await page.waitForTimeout(80);
      await page.mouse.down();
      await page.mouse.move(box.x + 60 + dx, box.y + 12 + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      return true;
    };
    const barVisible = () => page.locator("#bdDoneDragPrompt").isVisible().catch(() => false);
    const domPos = () => page.evaluate(() => { const el = document.querySelector('#boardGraph .cv-node[data-cv="g1"]'); return el ? { x: parseFloat(el.style.left), y: parseFloat(el.style.top) } : null; });

    // ===== A. done 板首拖:不落盘 + 弹确认条 =====
    const p0 = diskPos(donePath, "g1");
    await dragBy(200, 140);
    const barA = await barVisible();
    check("A1 done 板拖拽弹出自绘确认条", barA);
    if (barA) {
      const txt = await page.locator("#bdDoneDragPrompt").textContent();
      check("A2 确认条文案点明完成态", txt.includes("已完成") || txt.includes("done"), txt.slice(0, 60));
      check("A3 确认条两按钮(允许编辑/取消)", (await page.locator("#bdDoneDragPrompt button").count()) === 2
        && (await page.locator("#bdDoneDragPrompt button", { hasText: "允许编辑" }).count()) === 1
        && (await page.locator("#bdDoneDragPrompt button", { hasText: "取消" }).count()) === 1);
      check("A4 确认条为风格化 toast(自绘非原生 dialog)", await page.locator("#toastHost .toast#bdDoneDragPrompt").count() === 1);
    }
    const domA = await domPos();
    check("A5 视觉上节点确已跟随拖拽(未落盘前提成立)", !!domA && p0 && Math.abs(domA.x - p0.x) > 20, "dom=" + JSON.stringify(domA) + " disk0=" + JSON.stringify(p0));
    await page.waitForTimeout(1800); // > 900ms 防抖窗
    const pA = diskPos(donePath, "g1");
    check("A6 done 板拖拽未落盘(盘上 pos 未变)", !!pA && !!p0 && Math.abs(pA.x - p0.x) < 0.5 && Math.abs(pA.y - p0.y) < 0.5, "disk=" + JSON.stringify(pA));
    await page.waitForTimeout(4500); // 常驻性:不得像普通 toast 自动消失
    check("A7 确认条常驻(不自动消失)", await barVisible());

    // ===== B. 取消 → 位置回滚 =====
    await page.locator("#bdDoneDragPrompt button", { hasText: "取消" }).click();
    await page.waitForTimeout(400);
    check("B1 取消后确认条收起", !(await barVisible()));
    const domB = await domPos();
    const docB = await page.evaluate(() => { const n = boardDoc && boardDoc.nodes.find((x) => x.id === "g1"); return n && n.pos ? { x: n.pos.x, y: n.pos.y } : null; });
    check("B2 取消:D0M 位置回滚为拖拽前值", !!domB && !!p0 && Math.abs(domB.x - p0.x) < 0.5 && Math.abs(domB.y - p0.y) < 0.5, "dom=" + JSON.stringify(domB) + " 期望=" + JSON.stringify(p0));
    check("B3 取消:doc 位置回滚(无残留)", !!docB && !!p0 && Math.abs(docB.x - p0.x) < 0.5 && Math.abs(docB.y - p0.y) < 0.5, "doc=" + JSON.stringify(docB));
    await page.waitForTimeout(1800);
    const pB = diskPos(donePath, "g1");
    check("B4 取消:盘上仍为拖拽前值", !!pB && !!p0 && Math.abs(pB.x - p0.x) < 0.5 && Math.abs(pB.y - p0.y) < 0.5, "disk=" + JSON.stringify(pB));
    check("B5 取消不写入本会话授权标记", await page.evaluate(() => !Object.keys(sessionStorage).some((k) => k.indexOf("zh:bd-done-drag:") === 0)));

    // ===== C. 再拖一次:仍询问(取消不记忆) =====
    await dragBy(180, 120);
    check("C1 取消后再次拖拽仍弹确认条(不记忆)", await barVisible());

    // ===== D. 允许编辑 → 记住 + 补落盘 =====
    await page.locator("#bdDoneDragPrompt button", { hasText: "允许编辑" }).click();
    await page.waitForTimeout(300);
    check("D1 允许后确认条收起", !(await barVisible()));
    check("D2 允许→sessionStorage 记住本会话", await page.evaluate(() => !!(boardTaskId && sessionStorage.getItem("zh:bd-done-drag:" + boardTaskId))));
    let pD = null;
    for (let i = 0; i < 20 && !(pD && p0 && Math.abs(pD.x - p0.x) > 20); i++) { await page.waitForTimeout(600); pD = diskPos(donePath, "g1"); }
    check("D3 允许→本次拖拽补落盘(盘上 pos 已变)", !!pD && !!p0 && Math.abs(pD.x - p0.x) > 20, "disk=" + JSON.stringify(pD));

    // ===== E. 已授权后拖拽直通 =====
    await dragBy(90, 70);
    check("E1 已授权后不再弹确认条", !(await barVisible()));
    const pE0 = diskPos(donePath, "g1");
    let pE = pE0;
    for (let i = 0; i < 20 && !(pE && pE0 && Math.abs(pE.x - pE0.x) > 20); i++) { await page.waitForTimeout(600); pE = diskPos(donePath, "g1"); }
    check("E2 已授权后拖拽正常落盘", !!pE && !!pE0 && Math.abs(pE.x - pE0.x) > 20, "disk " + JSON.stringify(pE0) + "→" + JSON.stringify(pE));

    // ===== F. 对照:draft 板拖拽不弹条不误伤 =====
    const selAndDragDraft = async () => {
      await page.selectOption("#boardTaskSel", DRAFT_TASK).catch(() => {});
      await page.waitForTimeout(1500);
      if ((await page.evaluate(() => boardDoc && boardDoc.taskId)) !== DRAFT_TASK) await page.evaluate((t) => { try { boardSelect(t); } catch (e) {} }, DRAFT_TASK);
      await page.waitForTimeout(1200);
      return (await page.evaluate(() => boardDoc && boardDoc.status)) === "draft";
    };
    const onDraft = await selAndDragDraft();
    if (!onDraft) {
      check("F1 draft 对照板切换成功", false, "status=" + (await page.evaluate(() => boardDoc && boardDoc.status)));
    } else {
      const d0 = diskPos(draftPath, "g1");
      await dragBy(160, 110);
      await page.waitForTimeout(300);
      check("F1 draft 板拖拽不弹确认条(守卫只认 done)", !(await barVisible()));
      let dF = d0;
      for (let i = 0; i < 20 && !(dF && d0 && Math.abs(dF.x - d0.x) > 20); i++) { await page.waitForTimeout(600); dF = diskPos(draftPath, "g1"); }
      check("F2 draft 板拖拽照旧落盘(旧行为未被误伤)", !!dF && !!d0 && Math.abs(dF.x - d0.x) > 20, "disk " + JSON.stringify(d0) + "→" + JSON.stringify(dF));
    }

    check("零 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
    await page.screenshot({ path: "/tmp/bddoneguard.png" });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? "\nFAIL " + fails.length + "/" + results.length : "\nALL PASS " + results.length + "/" + results.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });