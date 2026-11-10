/** UI 经验证: 完整版轮次导航器(条目=轮数/点击跳转/滚动高亮)。
 * 形态迁移:#turnNav 自聊天列右缘浮层迁入 footer——横向时间轴(刻度高度=问句长度),
 *  新增检查:footer 归属/横向排布/长会话溢出+当前刻度居中/失败轮红刻度。 */
process.env.GENIE_CHECKPOINT = "off"; // 测试提速(生产环境默认开)
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "tnav-"));
  const backend = {
    kind: "tnav-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "回复:" + spec.instructions.slice(0, 12) + " …… ".repeat(60) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(7757, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7757/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(() => switchView("chat"));
  check("草稿态导航条隐藏", (await page.locator("#turnNav.on").count()) === 0);

  for (const txt of ["第一轮问题探针", "第二轮问题探针", "第三轮问题探针"]) {
    await page.fill("#instruction", txt);
 // #go 在 1400x900 视口被在途 companion-widget 的 cw-audiorow 停靠层拦截
    // (未提交在途面,非本 spec 对象)——改走 Enter 提交(composer 一等路径,panel.ts onkeydown)。
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1400);
  }
  await page.waitForTimeout(1200);
  const items = await page.locator("#turnNav .tn-item").count();
  check("条目数=轮数(3)", items === 3, items + " 项");
  check("导航条可见", await page.locator("#turnNav.on").count() === 1);

  // 点击第 1 项→第一条用户消息滚到视口中带
  await page.locator("#turnNav .tn-item").first().click();
  await page.waitForTimeout(400);
  const geo = await page.evaluate(() => {
    const v = document.getElementById("view-tasks");
    const r = document.querySelector('.user-line[data-turn="1"]');
    const vb = v.getBoundingClientRect(), rb = r.getBoundingClientRect();
    return { rowTop: rb.top, viewTop: vb.top, viewH: vb.height };
  });
  check("点击跳转第 1 轮(消息进视口)", geo.rowTop >= geo.viewTop - 60 && geo.rowTop <= geo.viewTop + geo.viewH, "row=" + Math.round(geo.rowTop) + " view=" + Math.round(geo.viewTop) + "~" + Math.round(geo.viewTop + geo.viewH));

  // 当前高亮:滚到底→第 3 轮亮;滚回顶→第 1 轮亮
  const curAfterClick = await page.locator("#turnNav .tn-item.cur").first().getAttribute("data-turn");
  check("点击后当前高亮=1", curAfterClick === "1", "cur=" + curAfterClick);
  // 原子验证(同 evaluate 内:滚动+标记+读取——避免后台重渲染把 scrollTop 带跑的竞态)
  const curBottom = await page.evaluate(() => {
    const v = document.getElementById("view-tasks");
    v.scrollTop = v.scrollHeight;
    window.__tnav.mark();
    const cur = document.querySelector("#turnNav .tn-item.cur");
    return { cur: cur ? cur.dataset.turn : "无", st: v.scrollTop, sh: v.scrollHeight };
  });
  check("滚到底高亮=3(贴底覆盖)", curBottom.cur === "3", JSON.stringify(curBottom));
  const curTop = await page.evaluate(() => {
    const v = document.getElementById("view-tasks");
    v.scrollTop = 0;
    window.__tnav.mark();
    const cur = document.querySelector("#turnNav .tn-item.cur");
    return cur ? cur.dataset.turn : "无";
  });
  check("滚回顶高亮=1(span 判定)", curTop === "1", "cur=" + curTop);

  // tooltip 轮次标题
  const title = await page.locator("#turnNav .tn-item").first().getAttribute("title");
  check("条目 tooltip 含轮次文本", (title || "").includes("第一轮问题探针"), title);

  // 进度点亮(真实事件路径):echo 后端即时完成→终态经 task.changed→refreshHist→renderHistory→全亮(满条)
  await page.waitForTimeout(900);
  const litReal = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#turnNav .tn-item")];
    return { ok: items.filter((x) => x.classList.contains("ok")).length, n: items.length };
  });
  check("真实路径满条(3/3 全亮)", litReal.ok === 3 && litReal.n === 3, JSON.stringify(litReal));

 // ---- footer 融入形态 ----
  const home = await page.evaluate(() => {
    const nav = document.getElementById("turnNav");
    return { inFooter: !!nav.closest("footer"), inView: !!nav.closest("#view-tasks") };
  });
  check("导航轴归 footer(离开 view-tasks)", home.inFooter && !home.inView, JSON.stringify(home));
  const horiz = await page.evaluate(() => {
    const nav = document.getElementById("turnNav");
    const items = [...document.querySelectorAll("#turnNav .tn-item")];
    const a = items[0].getBoundingClientRect(), b = items[1].getBoundingClientRect();
    // 刻度底对齐(高度=问句长度编码,顶部不齐是设计);同底+自左向右+行形态即横向轴
    return { sameBase: Math.abs(a.bottom - b.bottom) < 2, xAsc: b.left > a.left, row: nav.offsetHeight < nav.offsetWidth };
  });
  check("横向排布(底对齐,自左向右)", horiz.sameBase && horiz.xAsc && horiz.row, JSON.stringify(horiz));

 // 长会话:150 轮溢出,滚到底后当前刻度居中(scrollLeft>0)且不拽动主视口(语义)
  await page.evaluate(() => {
    const evs = [];
    for (let i = 1; i <= 150; i++) {
      evs.push({ kind: "message.user", payload: { text: "长会话第" + i + "轮探针,补充一些文字让刻度更高一些" } });
      evs.push({ kind: "task.done", payload: { id: "t" + i, result: "回复" + i } });
    }
    window.__mature.setHist(evs);
    renderHistory();
  });
  await page.waitForTimeout(300);
  const ov = await page.evaluate(() => {
    const nav = document.getElementById("turnNav");
    const v = document.getElementById("view-tasks");
    v.scrollTop = v.scrollHeight;
    window.__tnav.mark();
    const cur = document.querySelector("#turnNav .tn-item.cur");
    return {
      overflow: nav.scrollWidth > nav.clientWidth,
      sl: nav.scrollLeft,
      curTurn: cur ? cur.dataset.turn : "无",
      viewStuck: v.scrollTop + v.clientHeight >= v.scrollHeight - 6,
    };
  });
  check("150 轮溢出+贴底当前刻度居中", ov.overflow && ov.sl > 0 && ov.curTurn === "150" && ov.viewStuck, JSON.stringify(ov));

  // 失败轮红刻度:task.fail 归属其前最近用户轮;无活动任务时另一未决轮视为已了结(亮)
  await page.evaluate(() => {
    window.__mature.setHist([
      { kind: "message.user", payload: { text: "失败轮探针" } },
      { kind: "task.fail", payload: { id: "t-fail" } },
      { kind: "message.user", payload: { text: "正常轮探针" } },
      { kind: "task.done", payload: { id: "t-ok", result: "好" } },
    ]);
    renderHistory();
  });
  await page.waitForTimeout(300);
  const failPaint = await page.evaluate(() => {
    const f = document.querySelector('#turnNav .tn-item[data-turn="1"]');
    const o = document.querySelector('#turnNav .tn-item[data-turn="2"]');
    return { fFail: f ? f.classList.contains("fail") : null, oOk: o ? o.classList.contains("ok") : null, oFail: o ? o.classList.contains("fail") : null };
  });
  check("失败轮红刻度(轮1红/轮2亮不红)", failPaint.fFail === true && failPaint.oOk === true && failPaint.oFail === false, JSON.stringify(failPaint));

  // 呼吸态与满条:会话有运行中任务且轮次未决→run;活动清零→未决轮了结→满条
  await page.evaluate(() => {
    window.__mature.setHist([
      { kind: "message.user", payload: { text: "执行中轮探针一" } },
      { kind: "message.user", payload: { text: "执行中轮探针二" } },
    ]);
    tasks.set("live-run", { id: "live-run", sessionId: currentSid, state: "running" });
    renderHistory();
  });
  await page.waitForTimeout(300);
  const runPaint = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#turnNav .tn-item")];
    return { run: items.filter((x) => x.classList.contains("run")).length, n: items.length };
  });
  check("执行中呼吸态(2/2 run)", runPaint.run === 2 && runPaint.n === 2, JSON.stringify(runPaint));
  const fullPaint = await page.evaluate(() => {
    tasks.delete("live-run");
    renderHistory();
    const items = [...document.querySelectorAll("#turnNav .tn-item")];
    return { ok: items.filter((x) => x.classList.contains("ok")).length, n: items.length };
  });
  check("就绪满条(活动清零→2/2 全亮)", fullPaint.ok === 2 && fullPaint.n === 2, JSON.stringify(fullPaint));

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  rmSync(jd, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
