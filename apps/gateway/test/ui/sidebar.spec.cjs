/** UI 实测:侧栏 workspace 逻辑深拷贝(step-059,2026-10-14 用户口径:深拷贝 ref/zcode WorkspaceSidebar)。
 *  覆盖:细轨折叠/全部展开收起/桶头语义(收起态点击=展开+激活项目草稿;展开态=仅折叠)/行内 + 与 … /
 *  收起桶 live 徽标/运行置顶排序/purpose 双分区折叠与持久化/桶拖拽排序持久化/滚动 mask/归档分页。 */
process.env.GENIE_CHECKPOINT = "off";
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "sbd-"));
  const backend = { kind: "sbd-e2e", async spawn(spec, onEvent) {
    onEvent({ type: "result", result: { ok: true, finalText: "回复:" + spec.instructions.slice(0, 8) } });
    return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
  } };
  const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  servePanel(7773, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  // step-090:合成项目在服务端无注册,project.activate 回 error→uiAlert 页内模态(原生 alert 时代由
  // playwright 默认 auto-dismiss,无感)。此处显式关闭模态复刻旧行为,防 uid-mask 拦截后续真实点击;
  // 模态可能叠层(多次 activate 各弹一枚),循环关到净(z 序:后弹者在上,取 last)。
  const dismissUid = async () => {
    let last = "";
    for (let i = 0; i < 5 && (await page.locator(".uid-mask").count()) > 0; i++) {
      const mask = page.locator(".uid-mask").last();
      last = ((await mask.locator(".uid-msg").textContent().catch(() => "")) || "").slice(0, 40);
      await mask.locator(".uid-ok").click();
      await mask.waitFor({ state: "detached", timeout: 2000 }).catch(() => {});
    }
    return last;
  };

  await page.goto("http://127.0.0.1:7773/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.evaluate(() => switchView("chat"));
  // 注入合成项目/任务(直接驱动 renderSidebar 的数据源;时间刻意让 running 的更旧,验证运行置顶)
  const projDir = join(tmpdir(), "sbspec-proj-" + Date.now());
  mkdirSync(join(projDir, "子目录"), { recursive: true });
  writeFileSync(join(projDir, "README.md"), "hello genie\n");
  writeFileSync(join(projDir, "子目录", "nested.txt"), "nested\n");
  await page.evaluate((dir) => {
    const now = Date.now();
    const mid0 = new Date(); mid0.setHours(0, 0, 0, 0); const M = mid0.getTime(); // 本地零点锚:时间桶断言不随运行时刻翻车(昨天的 36h 偏移在凌晨会变前天)
    projects.push({ id: "__harness__", label: "harness", path: dir, availability: "available" }, { id: "p1", label: "项目一", path: "/tmp/p1", availability: "available" }, { id: "p2", label: "项目二", path: dir, availability: "available" });
    const mk = (id, sid, pid, state, created, updated, extra) => tasks.set(id, { id, sessionId: sid, projectId: pid, state, createdAt: created, updatedAt: updated, title: "任务" + id, instruction: "任务" + id, ...(extra || {}) });
    mk("t1", "s1", "p1", "done", now - 1000, now - 1000);
    mk("t2", "s2", "p1", "running", now - 90000, now - 5000); // 更旧但运行中 → 必须置顶
    mk("t3", "s3", "p2", "running", now - 500, now - 500);
    mk("t4", "s4", "__harness__", "done", now - 80000, now - 80000);
    mk("t5", "s5", "__harness__", "done", M - 43200000, M - 43200000, { group: "alpha" });   // 昨天中午(零点-12h,恒昨天)
    mk("t6", "s6", "__harness__", "done", M - 216000000, M - 216000000, { group: "alpha" });   // 2.5 天前(恒 3 天前桶)
    mk("t7", "s7", "__harness__", "done", M - 734400000, M - 734400000, { group: "beta" });    // 8.5 天前(恒上周)
    mk("t8", "s8", "__harness__", "done", M - 3456000000, M - 3456000000);                      // 40 天前(恒上月)
    mk("t9", "s9", "__harness__", "done", M - 8640000000, M - 8640000000);                      // 100 天前(恒更早)
    mk("t10", "s10", "", "done", now - 700, now - 700);                                             // 无归属 → 「任 务」分区
    for (let i = 0; i < 22; i++) mk("a" + i, "sa" + i, "__harness__", "done", now - 100000 - i, now - 100000 - i, { archived: true });
    diffstats.set("t1", { total: { files: 2, add: 10, del: 3 } });
    setOrganize("project");
  }, projDir);
  await page.waitForTimeout(400);

  // 文案清扫:可见 title 与页面文本不得出现其它项目名(ZCode)
  const copy = await page.evaluate(() => ({
    titles: [...document.querySelectorAll("[title]")].filter((el) => (el.getAttribute("title") || "").includes("ZCode")).map((el) => el.getAttribute("title")),
    text: (document.body.innerText || "").includes("ZCode"),
  }));
  check("文案无其它项目名", copy.titles.length === 0 && !copy.text, JSON.stringify(copy));
  const raw = await page.content();
  check("/init 提示词与路径无外部品牌", raw.includes("lampgenie-harness's built-in /init") && !raw.includes("ZCode's built-in") && !raw.includes(".zcode/AGENTS.md"), "");

  // purpose 双分区(2026-10-14 修正口径:harness=独立项目桶进「项 目」;「任 务」=无归属/项目已移除)
  const sec = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".sb-sec[data-sec=\"tasks\"] ~ .t-row")].map((x) => x.dataset.sid);
    const sids = new Set(rows);
    return {
      projects: !!document.querySelector('.sb-sec[data-sec="projects"]'),
      tasks: !!document.querySelector('.sb-sec[data-sec="tasks"]'),
      order: purpose.order,
      tempOnly: rows.length > 0 && !rows.some((x) => ["s1", "s2", "s3", "s4"].includes(x)),
      unownedIn: sids.has("s10"),
      harnessBucket: !!document.querySelector('.t-bh[data-pid="__harness__"]'),
      harnessRow: !!document.querySelector('.t-bh[data-pid="__harness__"] ~ .t-row[data-sid="s4"]'),
    };
  });
  check("purpose 双分区(项目+任务)", sec.projects && sec.tasks && sec.order[0] === "projects", JSON.stringify(sec));
  check("harness=独立项目桶(项目区);任务区=无归属会话", sec.harnessBucket && sec.harnessRow && sec.tempOnly && sec.unownedIn, JSON.stringify(sec));

  // 运行置顶:p1 桶第一行 = s2(更旧但运行中)
  const first1 = await page.evaluate(() => {
    const bh = document.querySelector('.t-bh[data-pid="p1"]');
    return bh && bh.nextElementSibling ? bh.nextElementSibling.dataset.sid : "";
  });
  check("运行中置顶(旧 running 压新 done)", first1 === "s2", "first=" + first1);
  const ds = await page.evaluate(() => {
    const chip = document.querySelector('.t-bh[data-pid="p1"] ~ .t-row .t-ds');
    return chip ? chip.textContent.replace(/\s+/g, "") : "";
  });
  check("变更统计内联(+10/-3)", ds === "+10-3", ds);

  // 全部展开/收起:点一次全收(有 running 的 p2 收起后出 live 徽标),再点全展
  await page.click("#tt-fold");
  await page.waitForTimeout(200);
  const folded = await page.evaluate(() => ({
    btn: document.getElementById("tt-fold").textContent,
    anyOpen: [...document.querySelectorAll(".t-bh[data-bk]")].some((h) => h.getAttribute("aria-expanded") === "true"),
    live: !!document.querySelector('.t-bh[data-pid="p2"] .bh-live'),
  }));
  check("全收 + 折叠桶 live 徽标", folded.btn === "全展" && !folded.anyOpen && folded.live, JSON.stringify(folded));
  await page.click("#tt-fold");
  await page.waitForTimeout(200);
  const unfolded = await page.evaluate(() => ({
    btn: document.getElementById("tt-fold").textContent,
    allOpen: [...document.querySelectorAll(".t-bh[data-bk]")].every((h) => h.getAttribute("aria-expanded") === "true"),
  }));
  check("全展恢复", unfolded.btn === "全收" && unfolded.allOpen, JSON.stringify(unfolded));

  // 时间线桶全集(ZCode taskTimelineGroups:今天/昨天/N天前/本周/上周/本月/上月/更早)
  await page.evaluate(() => setOrganize("time"));
  await page.waitForTimeout(200);
  const tb = await page.evaluate(() => [...document.querySelectorAll("#taskList .t-bh")].map((h) => h.textContent));
  check("时间桶全集对齐", tb.some((x) => x.includes("昨天")) && tb.some((x) => x.includes("3 天前")) && tb.some((x) => x.includes("上周")) && tb.some((x) => x.includes("上月")) && !tb.some((x) => x.includes("3 天内")), JSON.stringify(tb));
  // grouped 视图吸顶组头
  await page.evaluate(() => setOrganize("group"));
  await page.waitForTimeout(200);
  const sticky = await page.evaluate(() => ({
    on: document.getElementById("taskList").classList.contains("sticky-heads"),
    heads: [...document.querySelectorAll("#taskList .t-bh")].map((h) => h.textContent.trim()).slice(0, 3),
  }));
  check("grouped 吸顶组头", sticky.on && sticky.heads.some((x) => x.includes("alpha")), JSON.stringify(sticky));
  await page.evaluate(() => setOrganize("project"));
  await page.waitForTimeout(200);

  // 桶头语义:展开态点击=仅折叠;收起态点击=展开+激活项目草稿(currentSid null)
  await page.evaluate(() => { document.querySelector('.t-bh[data-pid="p1"]').click(); });
  await page.waitForTimeout(200);
  const collapsedOnly = await page.evaluate(() => document.querySelector('.t-bh[data-pid="p1"]').getAttribute("aria-expanded") === "false");
  check("展开态桶头点击=仅折叠", collapsedOnly);
  await page.evaluate(() => { document.querySelector('.t-bh[data-pid="p1"]').click(); });
  await page.waitForTimeout(300);
  const expandOpen = await page.evaluate(() => ({ open: document.querySelector('.t-bh[data-pid="p1"]').getAttribute("aria-expanded") === "true", draft: currentSid === null }));
  check("收起态桶头点击=展开+项目草稿", expandOpen.open && expandOpen.draft, JSON.stringify(expandOpen));
  await dismissUid(); // project.activate p1(合成项目)→error→uiAlert,关闭之(下同)

  // 拖拽排序:第一个桶的把手拖到第二个桶头(pointer 事件;vertical-only 机构) → 顺序持久化。
  // 断言按序相对(桶的天然序由运行置顶排序决定,不假设具体哪个项目在前)。
  await page.evaluate(() => {
    const heads = [...document.querySelectorAll("#taskList .t-bh[data-pid]")];
    const src = heads[0], dst = heads[1];
    window.__sbPre = [src.dataset.pid, dst.dataset.pid];
    const g = src.querySelector(".bh-grip");
    const r = g.getBoundingClientRect();
    const y = dst.getBoundingClientRect().top + dst.getBoundingClientRect().height / 2;
    g.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + 3, clientY: r.top + 7 }));
  });
  await page.waitForTimeout(80); // 活动桶行收起后布局位移,落点几何必须重取(真实拖拽=连续 move)
  const dragHide = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("#taskList .t-bh[data-pid]")];
    const dst = heads.find((h) => h.dataset.pid === window.__sbPre[1]);
    const y = dst.getBoundingClientRect().top + dst.getBoundingClientRect().height / 2;
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 40, clientY: y }));
    return {
      hidden: [...document.querySelectorAll("#taskList .dragging-hide")].length > 0,
      marks: [...document.querySelectorAll("#taskList .drop-before, #taskList .drop-after")].length,
    };
  });
  check("拖拽中活动桶强制收起+落点指示", dragHide.hidden && dragHide.marks > 0, JSON.stringify(dragHide));
  await page.evaluate(() => { window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
  await page.waitForTimeout(300);
  const order = await page.evaluate(() => {
    const pre = window.__sbPre;
    const dom = [...document.querySelectorAll("#taskList .t-bh[data-pid]")].map((h) => h.dataset.pid);
    const persisted = JSON.parse(localStorage.getItem("zh:sb-project-order") || "[]");
    return { pre, dom, persisted };
  });
  check("桶拖拽排序 + 持久化", order.dom[0] === order.pre[1] && order.persisted[0] === order.pre[1] && order.persisted[1] === order.pre[0], JSON.stringify(order));

  // 行内 +:此项目新建(不跳会话)。project.activate 会让服务端把 p2 重排到最前,属预期(激活即置顶)。
  await page.evaluate(() => { document.querySelector('.t-bh[data-pid="p2"] .bh-new[data-new]').click(); });
  await page.waitForTimeout(200);
  const plus = await page.evaluate(() => currentSid === null);
  check("行内 + = 此项目新建草稿", plus);
  await dismissUid(); // project.activate p2 同上

  // 分区折叠持久化
  await page.evaluate(() => { document.querySelector('.sb-sec[data-sec="projects"]').click(); });
  await page.waitForTimeout(200);
  const secFold = await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem("zh:sb-purpose"));
    return { hidden: !document.querySelector('.t-bh[data-pid="p1"]'), persisted: v.projectsExpanded === false };
  });
  check("分区折叠 + 持久化", secFold.hidden && secFold.persisted, JSON.stringify(secFold));
  await page.evaluate(() => { document.querySelector('.sb-sec[data-sec="projects"]').click(); });
  await page.waitForTimeout(200);

  // 滚动渐隐 mask
  const mask = await page.evaluate(() => {
    const el = document.getElementById("taskList");
    el.scrollTop = 40;
    el.dispatchEvent(new Event("scroll"));
    return (el.style.maskImage || "").length > 0;
  });
  check("滚动渐隐 mask", mask);

  // 归档分页(20 条上限 + show all)
  await page.evaluate(() => { document.getElementById("tt-arch").click(); });
  await page.waitForTimeout(200);
  const arch = await page.evaluate(() => {
    const rows = document.querySelectorAll("#taskList .t-row").length;
    const toggle = document.getElementById("archToggle");
    return { rows, hasToggle: !!toggle };
  });
  check("归档 20 条上限 + 显示全部入口", arch.rows <= 22 && arch.hasToggle, JSON.stringify(arch));
  await page.evaluate(() => {
    window.__archMsgs = [];
    const orig = ws.send.bind(ws);
    ws.send = (d) => { try { const m = JSON.parse(d); if (m.type === "task.archive") window.__archMsgs.push(m); } catch (e) {} return orig(d); };
    document.querySelector("#taskList .t-row [data-unarch]").click();
  });
  await page.waitForTimeout(200);
  const unarch = await page.evaluate(() => window.__archMsgs.filter((m) => m.archived === false).length);
  check("归档行内取档(task.archive=false)", unarch > 0, String(unarch));

  // 细轨折叠
  await page.evaluate(() => { toggleSidebar(); });
  await page.waitForTimeout(300);
  const rail = await page.evaluate(() => ({
    hidden: document.body.classList.contains("sb-hidden"),
    railVisible: document.getElementById("sbRail").offsetWidth > 0,
  }));
  check("折叠细轨可见", rail.hidden && rail.railVisible, JSON.stringify(rail));
  await page.click("#sbRailToggle");
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => !document.body.classList.contains("sb-hidden"));
  check("细轨点击回展开", restored);

  // 文件树滑入层:p2 桶头「文件树」→ 树层滑入 + 目录懒加载 + 文件点击发相对路径 file.read + Esc 关闭
  // (先退出归档视图——归档态下 p2 桶不渲染;spec 装配无项目注册表,服务端读取链路以 ws 消息断言代替)
  await page.evaluate(() => { document.getElementById("tt-arch").click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.__sbMsgs = [];
    const orig = ws.send.bind(ws);
    ws.send = (d) => { try { const m = JSON.parse(d); if (m.type === "file.read" || m.type === "project.activate") window.__sbMsgs.push(m.type + ":" + (m.path || m.projectId)); } catch (e) {} return orig(d); };
  });
  await page.evaluate(() => { document.querySelector('.t-bh[data-pid="p2"] .bh-files[data-files]').click(); });
  await page.waitForTimeout(600);
  await dismissUid(); // 树层打开伴随的 project.activate error 模态;先关掉,保住下方 Esc 仅关文件树层的语义
  const ftOpen = await page.evaluate(() => ({
    open: document.getElementById("sidebar").classList.contains("ft-open"),
    title: document.getElementById("sbFtTitle").textContent,
    rows: [...document.querySelectorAll("#sbFtTree .ft-row .nm")].map((x) => x.textContent),
  }));
  check("文件树层打开(标题=项目名)", ftOpen.open && ftOpen.title.includes("项目二"), ftOpen.title);
  check("树列出根目录(README/子目录)", ftOpen.rows.some((x) => x.includes("README.md")) && ftOpen.rows.some((x) => x.includes("子目录")), JSON.stringify(ftOpen.rows));
  await page.evaluate(() => { [...document.querySelectorAll("#sbFtTree .ft-row.dir")].find((x) => x.textContent.includes("子目录")).click(); });
  await page.waitForTimeout(500);
  const nested = await page.evaluate(() => [...document.querySelectorAll("#sbFtTree .ft-row .nm")].map((x) => x.textContent).some((x) => x.includes("nested.txt")));
  check("子目录懒加载展开", nested);
  await page.evaluate(() => { [...document.querySelectorAll("#sbFtTree .ft-row.file")].find((x) => x.textContent.includes("nested.txt")).click(); });
  await page.waitForTimeout(500);
  const preview = await page.evaluate(() => ({
    viewer: document.getElementById("fileViewer").classList.contains("on"),
    msgs: window.__sbMsgs,
  }));
  check("文件点击=激活项目+相对路径 file.read", preview.viewer && preview.msgs.includes("project.activate:p2") && preview.msgs.includes("file.read:子目录/nested.txt"), JSON.stringify(preview).slice(0, 160));
  await page.evaluate(() => { document.getElementById("fvClose").click(); });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const ftClosed = await page.evaluate(() => !document.getElementById("sidebar").classList.contains("ft-open"));
  check("Esc 关闭文件树层", ftClosed);

  // 右键菜单锚定光标(openMenuAt 实测尺寸+翻转):中列=左上对齐光标;近底=翻转后底边贴光标;桶头右键=项目菜单
  await page.evaluate(() => { setOrganize("project"); });
  await page.waitForTimeout(200);
  const mid = await page.evaluate(() => {
    const row = document.querySelector('#taskList .t-row[data-sid="s1"]');
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 500 }));
    const m = document.getElementById("taskMenu");
    const r = m.getBoundingClientRect();
    const at = { left: Math.round(r.left), top: Math.round(r.top), open: m.style.display === "block" };
    m.style.display = "none";
    return at;
  });
  check("右键菜单锚定光标(中列)", mid.open && mid.left === 300 && mid.top === 500, JSON.stringify(mid));
  const nearBottom = await page.evaluate(() => {
    const row = document.querySelector('#taskList .t-row[data-sid="s1"]');
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 880 }));
    const m = document.getElementById("taskMenu");
    const r = m.getBoundingClientRect();
    const at = { top: Math.round(r.top), bottom: Math.round(r.bottom), open: m.style.display === "block" };
    m.style.display = "none";
    return at;
  });
  check("近底右键翻转(底边贴光标)", nearBottom.open && Math.abs(nearBottom.bottom - 880) <= 8 && nearBottom.top < 880, JSON.stringify(nearBottom));
  const bhCtx = await page.evaluate(() => {
    document.querySelector('.t-bh[data-pid="p1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 420 }));
    const m = document.getElementById("taskMenu");
    const r = m.getBoundingClientRect();
    const at = { open: m.style.display === "block", left: Math.round(r.left), top: Math.round(r.top), items: m.querySelectorAll(".tm-item").length, hasRemove: [...m.querySelectorAll(".tm-item")].some((x) => x.textContent.includes("移除项目")) };
    m.style.display = "none";
    return at;
  });
  check("桶头右键=项目菜单@光标(含移除)", bhCtx.open && bhCtx.left === 200 && bhCtx.top === 420 && bhCtx.items > 3 && bhCtx.hasRemove, JSON.stringify(bhCtx));

  // harness 工作区文件树:入口在「任务」分区头(该分区=harness 工作区)
  await page.evaluate(() => { document.getElementById("secFtH").click(); });
  await page.waitForTimeout(600);
  const hFt = await page.evaluate(() => ({
    open: document.getElementById("sidebar").classList.contains("ft-open"),
    title: document.getElementById("sbFtTitle").textContent,
    rows: document.querySelectorAll("#sbFtTree .ft-row").length,
  }));
  check("任务分区头文件树(harness 工作区)", hFt.open && hFt.title.includes("harness") && hFt.rows > 0, JSON.stringify(hFt));
  await dismissUid(); // harness 工作区 activate 同上
  await page.keyboard.press("Escape");

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await app.close();
  rmSync(jd, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
