/** fixD MVP spec(7858 真实浏览器):私有 gitlab 项目+假 token → 降级 RepoIssues → 新建 issue →
 * 看板卡片出现 → 拖拽 todo→doing(写回通道落盘)→ 刷新页面状态保持。0 pageerror 红线。
 * 跑法:npx tsx test/ui/_issue_selfhost.cjs(spec 由 runner 进程内加载)。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7858";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 200)));
  try {
    page.on("websocket", (w) => {
      w.on("framereceived", (f) => { const s = String(f.payload); if (s.includes("team.p2p.status") || s.includes("issue.list.result")) console.log("[ws-frame] " + s.slice(0, 130)); });
    });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    // 1. 进入团队视图 → Issue 子标签;面板可见。
    await page.click("#act-team");
    await page.waitForTimeout(300);
    await page.click("#teamTabIssues");
    await page.waitForTimeout(400);
    check("Issue 子标签进入(pane 可见)", await page.isVisible("#teamPaneIssues"));
    check("三列看板结构在", (await page.$$(".issue-col")).length === 3);

    // 2. 通道降级:gitlab URL + 假 token → 首次 list 失败 → 降级 RepoIssues(通道标签如实标注)。
    let chan = "";
    for (let i = 0; i < 20; i++) {
      chan = await page.textContent("#issueChanTag");
      if (chan && chan.includes("仓内自建")) break;
      await sleep(500);
    }
    check("自动降级 RepoIssues(通道=仓内自建)", chan.includes("仓内自建"), String(chan).slice(0, 80));
    check("降级原因可见(401/fetch failed)", chan.includes("已降级"), String(chan).slice(0, 110));

    // 3. P2P 状态条:本机成员在(tester-a;status 应答含可达性探测,轮询等待不设死线)。
    let strip = "";
    for (let i = 0; i < 20; i++) {
      strip = await page.textContent("#p2pStrip");
      if (strip && strip.includes("tester-a")) break;
      await sleep(500);
    }
    check("P2P 状态条(本机 tester-a)", strip.includes("tester-a"), String(strip).slice(0, 80));

    // 4. 新建 issue(标题/正文/指派自己)→ 看板 todo 列出现卡片。
    // 显式锁定项目下拉=临时项目(避免 activeProjectId 空时落到 harness)。
    console.log("[dbg] fp=" + await page.$eval("#issueFp", (el) => el.value) + " fpOpts=" + await page.$$eval("#issueFp option", (os) => os.map((o) => o.value.slice(0, 14)).join(",")));
    await page.selectOption("#issueFp", { index: 1 });
    await page.waitForTimeout(600);
    await page.click("#issueNewBtn");
    await page.waitForSelector(".uid-mask .uid-input");
    await page.fill(".uid-mask .uid-input", "修复登录闪退");
    await page.click(".uid-mask .uid-ok");
    await page.waitForSelector(".uid-mask .uid-input");
    await page.fill(".uid-mask .uid-input", "iOS 18 复现,冷启动必现");
    await page.click(".uid-mask .uid-ok");
    await page.waitForSelector(".uid-mask .uid-input");
    await page.fill(".uid-mask .uid-input", "tester-a");
    await page.click(".uid-mask .uid-ok");
    let cardSel = "";
    for (let i = 0; i < 20; i++) {
      const cards = await page.$$(".issue-cards[data-col=todo] .issue-card");
      if (cards.length) { cardSel = ".issue-cards[data-col=todo] .issue-card"; break; }
      await sleep(500);
    }
    check("新建 issue 卡片出现在待办列", !!cardSel);
    const cardText = cardSel ? await page.textContent(cardSel) : "";
    check("卡片内容(标题+指派)", cardText.includes("修复登录闪退") && cardText.includes("tester-a"), cardText.slice(0, 60));
    let dispatchBtn = null; // issueSelf 由 P2P 状态设置(应答含探测,轮询)
    for (let i = 0; i < 20; i++) {
      dispatchBtn = await page.$("button[data-issue-dispatch]");
      if (dispatchBtn) break;
      await sleep(500);
    }
    check("指派自己=「派任务」确认按钮在", !!dispatchBtn);

    // 5. 拖拽 todo→doing(HTML5 dnd 事件驱动真实 drop 处理器:issue.update 写回通道)。
    await page.evaluate(() => {
      const card = document.querySelector(".issue-cards[data-col=todo] .issue-card");
      const col = document.querySelector(".issue-col[data-col=doing]");
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    });
    let moved = false;
    for (let i = 0; i < 20; i++) {
      const doing = await page.$$(".issue-cards[data-col=doing] .issue-card");
      if (doing.length) { moved = true; break; }
      await sleep(500);
    }
    check("拖拽 todo→doing(卡片落入进行中列)", moved);

    // 6. 落盘断言:刷新页面(全新加载)后状态保持 doing(通道写回 .genie/issues 文件)。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-team");
    await page.click("#teamTabIssues");
    let kept = false;
    for (let i = 0; i < 20; i++) {
      const doing = await page.$$(".issue-cards[data-col=doing] .issue-card");
      if (doing.length) { kept = true; break; }
      await sleep(600);
    }
    check("刷新后 doing 状态保持(落盘+重读)", kept);

    // 7. 筛选条:项目/指派下拉有选项。
    const fpOpts = await page.$$eval("#issueFp option", (os) => os.map((o) => o.textContent));
    const faOpts = await page.$$eval("#issueFa option", (os) => os.map((o) => o.textContent));
    check("项目筛选下拉(含临时项目)", fpOpts.length >= 2, fpOpts.join(","));
    check("指派筛选下拉(含 tester-a)", faOpts.some((x) => x.includes("tester-a")), faOpts.join(","));

    check("0 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
    const failed = results.filter((r) => !r.ok).length;
    console.log("SUMMARY issue-board " + (results.length - failed) + "/" + results.length + (failed ? " FAILED" : " ALL-PASS"));
    await browser.close();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error("CRASH", e);
    console.log("SUMMARY issue-board CRASH");
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
