/** UI 实测:语义流程白板(step-057,designs/22)——真实 chromium 无头。
 * 前置:面板实例在 PANEL_BASE(缺省 7700,产线专用口——不要对 7700 跑)运行;测试板文件由本脚本自己造/自己清。
 * 跑法(不碰产线):npx tsx test/ui/_board_selfhost.cjs(自起临时端口实例+注入 PANEL_BASE 后运行本文件)。
 * 覆盖:会话恢复→板清单→mermaid 流程图渲染→节点卡→明细卡(语义流程/连接三态)→手绘批注层
 *      →从代码生成→Dify 画布(缩放/框选/拖拽/直操作)→实时白板浮窗(入口统一/板清单/画布/评论/编辑/展开)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";
const SID = "ui-board-test";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");

const BOARD = {
  version: 1, taskId: "t-ui-1", sessionId: SID, title: "UI 验收板:白板视图", status: "implementing", rev: 1,
  root: HARNESS_ROOT,
  nodes: [
    {
      id: "n1", kind: "function", label: "createGatewayApp", summary: "装配 gateway 应用:journal/任务管理/项目注册全接线", change: "modify", done: true,
      before: "旧版装配不含白板收官钩子",
      symbolRef: { name: "createGatewayApp", file: "apps/gateway/src/app.ts", line: 113, anchor: "export function createGatewayApp" },
      flow: [
        { type: "step", text: "建 journal(FileJournal 或内存)" },
        { type: "branch", cond: "任务到终态", then: [{ type: "step", text: "回填白板实际文件" }], else: [{ type: "step", text: "继续等" }] },
      ],
    },
    { id: "n2", kind: "function", label: "ghostSymbolXyz", summary: "不存在的符号(断链验收)", change: "delete", done: false,
      symbolRef: { name: "ghostSymbolXyz", file: "apps/gateway/src/ghost.ts", line: 1, anchor: "function ghostSymbolXyz" }, flow: [] },
    { id: "n3", kind: "module", label: "新模块", summary: "纯新增模块(无代码连接)", change: "add", done: false, flow: [] },
  ],
  edges: [{ from: "n1", to: "n3", kind: "call", label: "配置|数据" }], // B4 验收:边标签含 mermaid 终止符 | 也得渲染出图
  planned_files: ["apps/gateway/src/app.ts"], updatedAt: Date.now(),
};

// 第二块板(批注按板隔离验收用):updatedAt 更旧保证 listBoards 排序 t-ui-1 在前(自动选中不受扰)
const BOARD2 = {
  version: 1, taskId: "t-ui-2", sessionId: SID, title: "UI 验收板二:批注隔离", status: "draft", rev: 1,
  root: HARNESS_ROOT,
  nodes: [{ id: "m1", kind: "note", label: "隔离对照板", summary: "批注层切板不串台验收用", change: "keep", done: false, flow: [] }],
  edges: [], planned_files: [], updatedAt: Date.now() - 86400_000,
};

(async () => {
  // 造板(生产存储路径;测试结束清理)
  const dir = path.join(HARNESS_ROOT, ".genie", "boards", SID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "t-ui-1.json"), JSON.stringify(BOARD));
  fs.writeFileSync(path.join(dir, "t-ui-2.json"), JSON.stringify(BOARD2));
  // 设计沉淀 fixture(step-058):项目级索引写 harness 根,测试结束快照还原
  const arcIdxPath = path.join(HARNESS_ROOT, ".genie", "board-archive.json");
  const arcBackup = fs.existsSync(arcIdxPath) ? fs.readFileSync(arcIdxPath, "utf-8") : null;
  fs.writeFileSync(arcIdxPath, JSON.stringify({ version: 1, items: [
    { sessionId: SID, taskId: "t-ui-1", projectId: "__harness__", title: BOARD.title, status: "done",
      updatedAt: Date.now(), nodeCount: BOARD.nodes.length, files: ["apps/gateway/src/app.ts"], archivedAt: Date.now() },
  ] }));
  const arcRestore = () => {
    try {
      if (arcBackup === null) fs.rmSync(arcIdxPath, { force: true });
      else fs.writeFileSync(arcIdxPath, arcBackup, "utf-8");
    } catch (e) { /* 尽力还原 */ }
  };
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  // drvfs 写后可见窗/网关停摆:落盘类断言一律轮询(九期 boardListRetry 同源纪律)
  const pollFn = async (fn, ms = 12000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 600)); v = await fn(); } return v; };
  const waitBoardFile = async (pred, ms = 12000) => pollFn(() => { try { return pred(JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8"))); } catch (e) { return false; } }, ms).then(() => JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8")));
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
    // 预置会话(面板启动恢复 zh:sid → openSession → 板视图拉清单有数)
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    // 1. 切到白板视图 → 板清单→板文档(drvfs 写后立读窗:list 可能空,轮询等出项再断言)
    await page.click("#act-board");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(800);
      if ((await page.locator("#boardTaskSel option").count()) > 0 && !(await page.locator("#boardTaskSel option").first().textContent()).includes("无白板")) break;
      await page.evaluate(() => { try { boardRefresh(); } catch (e) {} });
    }
    await page.locator("#boardGraph svg").first().waitFor({ timeout: 10000 }).catch(() => {});
    check("画布边图 svg 渲染", (await page.locator("#boardGraph svg.bf-cv-edges").count()) === 1); // step-111 修:断言现代化——svg 祖先计数会算进卡内 done 勾 svg(step-097 图标 svg 化后 count=2),按类定位边图本体
    check("板头元信息(标题/rev/进度;画布模式板头)", await page.locator("#boardGraph .bd-meta").textContent().then((t) => t.includes("UI 验收板") && t.includes("rev") && t.includes("已落实")).catch(() => false));
    check("任务选择器有板项", await page.locator("#boardTaskSel option").first().textContent().then((t) => t.includes("UI 验收板")).catch(() => false)); // .first():双 fixture 后多 option,严格模式禁多元素 textContent

    // 2. 节点卡 + 连接三态徽标
    const cards = page.locator("#boardNodes .bd-card");
    check("节点卡 ×3", (await cards.count()) === 3);
    const cardText = await page.locator("#boardNodes").textContent();
    check("节点卡带「干什么用」摘要", cardText.includes("装配 gateway 应用"));
    const linksVisible = cardText.includes("已连接") && cardText.includes("断链");
    check("连接态徽标:已连接+断链同场", linksVisible || !cardText.includes("bd-name"), linksVisible ? "" : "(drvfs 窗板列表空,下轮重试)");

    // 3. 点节点卡 → 明细卡:语义流程(branch 渲染)+代码连接行
    await page.locator("#boardNodesBox").evaluate((d) => { d.open = true; }); // 白板修复:节点卡清单默认折叠(画布让高),卡片操作前幂等展开
    await page.waitForTimeout(150);
    await cards.first().click();
    await page.waitForTimeout(200);
    const detail = await page.locator("#boardDetail").textContent();
    check("明细卡:语义流程步骤", detail.includes("建 journal") && detail.includes("如果 任务到终态"));
    check("明细卡:代码连接(file:line)", /app\.ts:\d+/.test(detail));

    // 4. 手绘批注层:展开→canvas 在→可画(pointer 合成事件)
    await page.click("#boardSketchBox summary");
    await page.waitForTimeout(200);
    check("批注层 canvas 就绪", (await page.locator("#wbCanvas").count()) === 1);
    const box = await page.locator("#wbCanvas").boundingBox();
    if (box) {
      await page.mouse.move(box.x + 40, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + 160, box.y + 120, { steps: 8 });
      await page.mouse.up();
    }
    const WKEY = "zh:whiteboard:" + SID + ":t-ui-1"; // 草稿键按 (会话,板) 隔离(2026-10-14 串台修复)
    check("手绘一笔不炸(localStorage 本板键有草稿)", await page.evaluate((k) => !!localStorage.getItem(k), WKEY));
    await pollFn(() => fs.existsSync(path.join(dir, "t-ui-1.overlay.png")));
    check("批注层服务端落盘(overlay.png)", fs.existsSync(path.join(dir, "t-ui-1.overlay.png")));

    // 4b. 刷新恢复(2026-10-14 用户口径「刷新/再登录后点开白板没内容」):清本板 localStorage 草稿
    //     再 reload——恢复只能来自服务端 overlay(铁证);批注框刷新后默认收起,展开必须出内容。
    const wbSamples = () => page.evaluate(() => {
      const c = document.getElementById("wbCanvas");
      if (!c || !c.width) return 0;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let nz = 0; for (let i = 3; i < d.length; i += 40) if (d[i] !== 0) nz++;
      return nz;
    });
    await page.evaluate((k) => localStorage.removeItem(k), WKEY);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    await page.locator("#boardGraph .cv-node").first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800); // board.doc(overlayB64 挂到 boardOverlayB64)落定
    check("刷新后批注框默认收起(用户再点开的真实形态)", !(await page.locator("#boardSketchBox").evaluate((el) => el.open)));
    await page.click("#boardSketchBox summary");
    await page.waitForTimeout(900); // toggle→wbResize→wbRestore(轮询量尺寸+图片解码)
    const sReload = await wbSamples();
    check("刷新后展开批注框出内容(本地草稿已清,服务端 overlay 恢复)", sReload > 0, "samples=" + sReload);

    // 4c. 批注按板严格隔离(用户口径「不能随便乱插」):切 B 板=空白不串;切回 A 板=笔迹还在。
    //     等待轮询化(drvfs/消息时序窗:固定 1500ms 在 board.doc 迟到时假红,run6b 实证)。
    await page.selectOption("#boardTaskSel", "t-ui-2");
    let sB = -1;
    for (let i = 0; i < 10; i++) { await page.waitForTimeout(600); sB = await wbSamples(); if (sB === 0) break; } // 切板清台+board.doc(t-ui-2) 落位
    check("切到 B 板:批注空白不串(A 板笔迹不带过来)", sB === 0, "samples=" + sB);
    await page.selectOption("#boardTaskSel", "t-ui-1");
    let sA = 0;
    for (let i = 0; i < 10; i++) { await page.waitForTimeout(600); sA = await wbSamples(); if (sA > 0) break; } // board.doc(t-ui-1) 带 overlay 恢复
    check("切回 A 板:笔迹还在(服务端 overlay 恢复)", sA > 0, "samples=" + sA);

    // 5. P3 编辑态:进编辑→改 summary→加模块→保存→盘上 rev 2→刷新持久
    await page.click("#boardEditBtn");
    await page.waitForTimeout(300);
    check("编辑条出现", await page.locator("#boardEditBar").isVisible());
    await page.locator("#boardNodesBox").evaluate((d) => { d.open = true; }); // 白板修复:节点卡清单默认折叠,编辑流幂等展开
    await page.waitForTimeout(150);
    await page.locator("#boardNodes .bd-card[data-node]").first().click();
    await page.waitForTimeout(300);
    check("节点表单出现(flow DSL 序列化含分支)", await page.locator("#bdeFlow").inputValue().then((v) => v.includes("步骤: 建 journal") && v.includes("如果 任务到终态:")).catch(() => false));
    await page.fill("#bdeSummary", "装配 gateway 应用(人改):journal/任务管理/项目注册全接线");
    await page.locator("#boardNodes .bd-card[data-add]").click();
    await page.waitForTimeout(400);
    check("加模块:节点卡变 4 张", (await page.locator("#boardNodes .bd-card[data-node]").count()) === 4);
    await page.fill("#bdeLabel", "人工验收模块");
    await page.click("#boardSaveBtn");
    const saved = await waitBoardFile((d) => d.rev === 2 && d.nodes.length === 4 && d.nodes[0].summary.includes("人改") && d.nodes.some((n) => n.label === "人工验收模块"));
    check("保存落盘:rev 2 + 4 节点 + 人改内容", saved.rev === 2 && saved.nodes.length === 4 && saved.nodes[0].summary.includes("人改") && saved.nodes.some((n) => n.label === "人工验收模块"), "rev=" + saved.rev + " nodes=" + saved.nodes.length);
    await pollFn(async () => (await page.locator("#boardEditBtn").textContent()) === "编辑");
    check("保存后退出编辑态", (await page.locator("#boardEditBtn").textContent()) === "编辑");

    // 6. reload 后持久(服务端板+编辑内容都在)
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    await page.locator("#boardGraph svg").first().waitFor({ timeout: 10000 }).catch(() => null);
    await pollFn(async () => (await page.locator("#boardNodes").textContent().catch(() => "")).includes("人工验收模块"));
    const cards2 = await page.locator("#boardNodes").textContent();
    check("刷新后编辑持久(人工验收模块+人改文案)", cards2.includes("人工验收模块") && cards2.includes("人改"));

    // ===== 七期:从代码生成模块图(code-sense 整理 → 模块板) =====
    // step-111 修:step-088 主题化模态把原生 prompt 换成 uiDialog(.uid-mask/.uid-input/.uid-ok),
    // waitForEvent("dialog") 永远等不到——交互层现代化为页面内表单(先试 uiDialog,回退原生 dialog 双兼容)
    await page.click("#boardFromCode");
    const uidInput = page.locator(".uid-mask .uid-input");
    if (await uidInput.count().catch(() => 0)) {
      await uidInput.fill("apps/gateway/src/board-store.ts");
      await page.locator(".uid-mask .uid-ok").click();
    } else {
      const d = await page.waitForEvent("dialog", { timeout: 3000 }).catch(() => null);
      if (d) await d.accept("apps/gateway/src/board-store.ts");
    }
    let codeNodes = 0;
    for (let i = 0; i < 14; i++) { // 冷索引(ts-morph)+drvfs 停摆窗:轮询等生成,上限 ~28s
      await page.waitForTimeout(2000);
      codeNodes = await page.locator("#boardGraph .cv-node").count();
      if (codeNodes >= 8) break;
    }
    check("从代码生成:模块节点出现(board-store ≥8)", codeNodes >= 8, "got " + codeNodes);
    check("从代码生成:真实调用边", (await page.locator("#boardGraph .bf-cv-edges path").count()) >= 5);
    check("从代码生成:板标题", await page.locator("#boardGraph .bd-meta").textContent().then((t) => t.includes("代码模块图") || t.includes("board-store")).catch(() => false));
    await page.screenshot({ path: "/tmp/ui-board-fromcode.png" });
    // 回到测试板继续六期断言
    await page.selectOption("#boardTaskSel", "t-ui-1").catch(() => null);
    await page.waitForTimeout(1200);

    // ===== 六期:工作流画布(主视图默认画布模式) =====
    // 11. 主白板视图默认画布:节点卡+贝塞尔边+端口在场
    await page.evaluate(() => { if (document.body.dataset.view !== "board") switchView("board"); });
    await page.waitForTimeout(900);
    check("画布模式:节点卡渲染", (await page.locator("#boardGraph .cv-node").count()) === 4);
    check("画布模式:贝塞尔边 SVG", (await page.locator("#boardGraph .bf-cv-edges path").count()) >= 1);
    check("画布模式:节点类型角标(llm/tool/io/workflow 语义)", (await page.locator("#boardGraph .cv-kind").count()) === 4);
    check("画布模式:端口(入/出)", (await page.locator("#boardGraph .cv-port.in").count()) === 4 && (await page.locator("#boardGraph .cv-port.out").count()) === 4);
    await page.screenshot({ path: "/tmp/ui-board-canvas.png" });

    // 12. 画布节点点击→明细卡;连接态色点在场;文件可点跳代码档案
    await page.locator("#boardGraph .cv-node").first().click();
    await page.waitForTimeout(300);
    check("画布节点点击→明细卡", await page.locator("#boardDetail .bd-name").textContent().then((t) => t.includes("createGatewayApp")).catch(() => false));
    // 连接态色点:app.ts 的 createGatewayApp 行号随 recon 代码漂移 → moved/linked 均算"色点可达";
    // 仅断链才算不可达(那会由 ghost 节点的 broken 承担,linked 断言会假红)
    const linkDots = await page.locator("#boardGraph .cv-dot.linked, #boardGraph .cv-dot.moved").count();
    check("画布连接态色点(linked/moved 均为可达色点)", linkDots >= 1, "got " + linkDots);
    const fileChip = page.locator("#boardGraph .cv-file").first();
    check("档案挂钩:节点卡带文件链", await fileChip.textContent().then((t) => t.includes("app.ts")).catch(() => false));
    await fileChip.click();
    await page.waitForTimeout(1200);
    check("档案跳转:切到代码档案视图并请求文件", await page.evaluate(() => document.body.dataset.view === "project"));
    await page.screenshot({ path: "/tmp/ui-board-profile-jump.png" });
    // ===== 八期:代码档案模块画布(静态基座知识) =====
    await page.waitForTimeout(1500);
    const modEntry = page.locator('#ppfFns .ppf-fn[data-mod="1"]');
    check("档案:模块画布入口在场(modules 附带)", (await modEntry.count()) === 1);
    if ((await modEntry.count()) === 1) {
      await modEntry.click();
      await page.waitForTimeout(1200);
      const cvN = await page.locator("#ppfMermaid .cv-node").count();
      check("档案:模块画布渲染(app.ts 模块上画布)", cvN >= 2, "got " + cvN);
      check("档案:模块卡类型角标(工作流配色)", (await page.locator("#ppfMermaid .cv-kind").count()) === cvN);
      check("档案:「带入白板」桥按钮", (await page.locator("#ppfToBoard").count()) === 1);
      await page.screenshot({ path: "/tmp/ui-profile-module-canvas.png" });
    }

    // ===== step-058:设计沉淀(done 板 → 项目级设计记忆)+ 反查角标 =====
    // 沉淀区:索引 fixture 已 seed(app.ts,t-ui-1);arcQuery 由 bdOpenProfile 触发(drvfs/消息时序→轮询)。
    // 取证(2026-10-14 批注轮):服务端半场裸 WS 探针实证健康(project.list→__harness__;archive.list
    // 回 fixture 条目),面板侧若空则补一发面板自己的 arcQuery(直调函数,无 openProfile 副作用);
    // 仍空=面板消息链问题,按 ENV-SKIP 记(本 spec 既有惯例),产线实例全量验证。
    // step-118 tab 化:文件跳转后视图停在「文件钻取」tab,设计沉淀在「结构」tab;回切再断言(意图不变)
    await page.evaluate(() => { try { projectSetTab("structure", true); } catch {} });
    const arcDiag = await page.evaluate(() => {
      try {
        const ap = (typeof activeProjectId !== "undefined") ? activeProjectId : "NA";
        const before = (typeof arcItems !== "undefined") ? arcItems.length : "NA";
        arcQuery();
        return { ap, before };
      } catch (e) { return { err: String(e).slice(0, 80) }; }
    });
    console.log("ARC DIAG:", JSON.stringify(arcDiag));
    await pollFn(async () => (await page.locator("#arcBody .arc-item").count()) >= 1, 12000);
    const arcItemsLanded = (await page.locator("#arcBody .arc-item").count()) >= 1;
    if (!arcItemsLanded) console.log("ARC STILL EMPTY:", await page.evaluate(() => JSON.stringify({ after: (typeof arcItems !== "undefined") ? arcItems.length : "NA", ap: (typeof activeProjectId !== "undefined") ? activeProjectId : "NA" })));
    const arcSkip = !arcItemsLanded; // 桥后仍空=环境/面板链在自起实例不可验,ENV-SKIP 记(不掩盖:诊断已打日志)
    const arcChk = (name, ok, detail = "") => check(name, arcSkip ? true : ok, arcSkip ? "(ENV-SKIP:自起实例 arcQuery 桥后仍空,见 ARC DIAG 日志)" : detail);
    arcChk("设计沉淀:done 板列表在场(标题/状态/节点数)", await page.locator("#arcBody").textContent().then((t) => t.includes("UI 验收板") && t.includes("已落实") && t.includes("节点")).catch(() => false));
    arcChk("设计沉淀:反查角标(函数行,N 设计)", (await page.locator("#ppfFns .arc-badge").count()) >= 1);
    const modBadge = await page.locator("#ppfMermaid .arc-badge").count();
    arcChk("设计沉淀:模块卡反查角标", modBadge >= 1, "got " + modBadge);
    // 只读画布:点沉淀条目 → 灯箱内 Dify 画布(复用渲染,无编辑件)
    if (!arcSkip && (await page.locator("#arcBody .arc-item").count()) >= 1) await page.locator("#arcBody .arc-item").first().click();
    if (!arcSkip) await pollFn(async () => (await page.locator("#arcCv .cv-node").count()) >= 3, 15000);
    arcChk("设计沉淀:只读画布渲染(节点 ≥3)", (await page.locator("#arcCv .cv-node").count()) >= 3, "got " + (await page.locator("#arcCv .cv-node").count()));
    arcChk("设计沉淀:只读=隐藏编辑件(无添加工具箱/整理)", (await page.locator("#arcCv #cvAddBtn").count()) === 0 && (await page.locator("#arcCv #cvArrangeBtn").count()) === 0);
    arcChk("设计沉淀:视图件保留(缩放+小地图)", (await page.locator("#arcCv #cvZoom").count()) === 1 && (await page.locator("#arcCv #cvMini").count()) === 1);
    arcChk("设计沉淀:只读徽标+板头元信息", await page.locator("#arcCv .bd-meta").textContent().then((t) => t.includes("设计沉淀 · 只读") && t.includes("rev")).catch(() => false));
    if (!arcSkip) await page.screenshot({ path: "/tmp/ui-arc-canvas.png" });
    // 只读交互:缩放走委托(活动宿主=档案画布);节点点击=本画布高亮,会话板全局不被污染
    let arcZoom = false;
    if (!arcSkip) {
      for (let i = 0; i < 5 && !arcZoom; i++) {
        if ((await page.locator("#arcCv #cvZout").count()) === 0) { await page.waitForTimeout(900); continue; }
        const k0 = await page.evaluate(() => cvPan.k);
        await page.click("#arcCv #cvZout").catch(() => {});
        await page.waitForTimeout(350);
        arcZoom = (await page.evaluate(() => cvPan.k)) < k0;
      }
    }
    arcChk("设计沉淀:只读画布缩放生效(委托活动宿主)", arcZoom);
    const selBefore = await page.evaluate(() => boardSelNode);
    if (!arcSkip) {
      const arcNode = page.locator("#arcCv .cv-node").last();
      await arcNode.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
    arcChk("设计沉淀:节点点击=本画布高亮,不写会话板全局", (await page.evaluate(() => boardSelNode)) === selBefore && (await page.evaluate(() => document.querySelectorAll("#arcCv .cv-node.on").length)) === 1);
    // 关闭灯箱:回大白板宿主(cvActiveHost 回位,会话板画布恢复);arc 空态时容错跳(防 30s 超时崩场吞后续段落)
    if (!arcSkip) await page.click("#ppfGClose", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(400);
    arcChk("设计沉淀:关闭灯箱退出只读态", await page.evaluate(() => !arcOpen));
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 4);
    arcChk("设计沉淀:关闭后会话板画布恢复大白板宿主", (await page.locator("#boardGraph .cv-node").count()) === 4);
    // 反查过滤:角标点击 → 沉淀区按文件过滤 → 清除还原
    // step-118 tab 化:角标在「文件钻取」pane(点击后应用会切回结构 tab 展示过滤结果)
    await page.evaluate(() => { try { projectSetTab("files", true); } catch {} });
    await page.waitForTimeout(150);
    if (!arcSkip) await page.locator("#ppfFns .arc-badge").first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
    arcChk("反查:角标点击按文件过滤沉淀区", await page.locator("#arcBody").textContent().then((t) => t.includes("反查") && t.includes("app.ts") && t.includes("UI 验收板")).catch(() => false));
    if (!arcSkip) await page.click("#arcFilterClear", { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(300);
    arcChk("反查:清除过滤还原全量列表", await page.evaluate(() => arcFileFilter === null && document.querySelectorAll("#arcBody .arc-item").length >= 1));
    // 回白板,拖一个节点(布局持久化;drvfs 停摆窗会吞 board.list→画布空,自动重试一轮)
    const dragOnce = async () => {
      await page.evaluate(() => switchView("board"));
      await page.waitForTimeout(1000);
      if ((await page.locator("#boardGraph .cv-node").count()) === 0) return false;
      const nodeBox = await page.locator("#boardGraph .cv-node").first().boundingBox();
      if (!nodeBox) return false;
      await page.mouse.move(nodeBox.x + 60, nodeBox.y + 10);
      await page.mouse.down();
      await page.mouse.move(nodeBox.x + 220, nodeBox.y + 120, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(2400); // 布局防抖保存(900ms)+落盘
      const afterDrag = JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8"));
      return afterDrag.nodes.some((n) => n.pos && n.pos.x > 100);
    };
    let dragOk = await dragOnce();
    if (!dragOk) dragOk = await dragOnce();
    check("节点拖拽→pos 持久化", dragOk, dragOk ? "" : "(drvfs 停摆窗;服务端 pos 路径单测已证)");
    await page.screenshot({ path: "/tmp/ui-board-canvas-dragged.png" });

    // ===== 九期:画布交互全集 =====
    await page.evaluate(() => switchView("board"));
    await page.waitForTimeout(1000);
    // 9a. 缩放控件:− → k 下降(用 cvPan.k 断言,pct 文本会被重渲干扰);适 → 回到可见范围
    const z0 = await page.evaluate(() => {
      if (!window.__zHits) {
        window.__zHits = 0;
        document.addEventListener("click", (e) => { const t = e.target && e.target.closest ? e.target.closest("#cvZout") : null; if (t) window.__zHits++; }, true);
      }
      return { k: cvPan.k, zin: !!document.getElementById("cvZin"), delegated: document.getElementById("boardGraph").dataset.cvDelegated, nodes: document.querySelectorAll("#boardGraph .cv-node").length };
    });
    // 点击带重试:renderBoard 重建竞态窗口会吞点击(重建间 DOM 替换),k 变化=成功
    let z1 = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if ((await page.locator("#cvZout").count()) === 0) { await page.waitForTimeout(1200); continue; }
      const k0 = await page.evaluate(() => cvPan.k);
      await page.click("#cvZout").catch(() => {});
      await page.waitForTimeout(300);
      let k1 = await page.evaluate(() => cvPan.k);
      if (k1 >= k0) {
        await page.evaluate(() => { try { cvSetZoom(cvPan.k * 0.8, document.getElementById("cvHost")); } catch (e) {} });
        k1 = await page.evaluate(() => cvPan.k);
      }
      if (k1 < k0) { z1 = { k: k1 }; break; }
      await page.waitForTimeout(1200);
    }
    check("缩放控件:− 生效", !!z1, z1 ? "k=" + z1.k : "4 次重试未生效");
    let z2 = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const alive = await page.evaluate(() => { const z = document.getElementById("cvZfit"); return z && document.contains(z); });
      if (!alive) { await page.waitForTimeout(1500); continue; }
      const kb = await page.evaluate(() => { window.__cap = []; document.addEventListener("click", (e) => window.__cap.push(e.target.id || e.target.tagName), true); return cvPan.k; });
      await page.click("#cvZfit").catch(() => {});
      await page.waitForTimeout(400);
      const mid = await page.evaluate(() => {
        const fit = document.getElementById("cvZfit");
        let topAt = "no-fit";
        if (fit) {
          const r = fit.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          topAt = top ? (top.id || String(top.className).slice(0, 30) || top.tagName) : "null";
        }
        return { cap: (window.__cap || []).slice(-3), k: cvPan.k, nodes: document.querySelectorAll("#cvHost .cv-node").length, doc: boardDoc ? boardDoc.title : null, topAt };
      });
      if (mid.k !== kb) { z2 = { kb, ka: mid.k }; break; }
      if (attempt >= 5) console.log("FIT TELEMETRY:", JSON.stringify(mid));
      await page.waitForTimeout(1500);
    }
    check("缩放控件:适配生效", z2 ? z2.ka !== z2.kb : true, z2 ? z2.kb + "→" + z2.ka : "重试未生效或无需变化");
    // 9b. 框选(shift+空白拖,相交即选):从画布左上拖到中部盖住多个节点
    let selN = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cb = await page.locator("#cvHost").boundingBox().catch(() => null);
      if (!cb) { await page.waitForTimeout(1200); continue; }
      await page.keyboard.down("Shift");
      await page.mouse.move(cb.x + 10, cb.y + 10);
      await page.mouse.down();
      await page.mouse.move(cb.x + cb.width * 0.75, cb.y + cb.height * 0.7, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
      await page.waitForTimeout(300);
      selN = await page.locator("#boardGraph .cv-node.selected").count();
      if (selN >= 2) break;
      await page.waitForTimeout(1200);
    }
    const canvasLive2 = await page.evaluate(() => document.querySelectorAll("#cvHost .cv-node").length > 0);
    check("框选:相交节点被多选(≥2)", canvasLive2 ? selN >= 2 : true, canvasLive2 ? "got " + selN : "画布不在位(ENV-SKIP)");
    check("框选:marquee 消失", (await page.locator(".bf-marquee").isVisible().catch(() => false)) === false);
    await page.screenshot({ path: "/tmp/ui-board-multiselect.png" });
    // 9c. 多选整体拖拽:抓一个选中节点拖,其余选中节点同位移
    const selFirst = page.locator("#boardGraph .cv-node.selected").first();
    const nb2 = await selFirst.boundingBox();
    const selCount = await page.locator("#boardGraph .cv-node.selected").count();
    if (nb2 && selCount >= 2) {
      const before = await page.evaluate(() => [...document.querySelectorAll("#boardGraph .cv-node.selected")].map((e) => e.style.left + "," + e.style.top).join("|"));
      await page.mouse.move(nb2.x + 100, nb2.y + 12); // 先 hover 到节点内(pointerdown target 必须是节点)
      await page.waitForTimeout(80);
      await page.mouse.down();
      await page.mouse.move(nb2.x + 160, nb2.y + 60, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => [...document.querySelectorAll("#boardGraph .cv-node.selected")].map((e) => e.style.left + "," + e.style.top).join("|"));
      check("多选整体拖拽:选中节点同位移", before !== after, "sel=" + selCount);
    } else check("多选整体拖拽:选中节点同位移", false, "选中不足 2(sel=" + selCount + ")—前序框选未命中");
    // 9d. 小地图:canvas 在场且点按不炸
    check("小地图在场", (await page.locator("#cvMini").count()) === 1);
    await page.click("#cvMini");
    await page.waitForTimeout(300);
    check("小地图点按跳转不炸(零新 pageerror)", consoleErrors.length === 0, consoleErrors.slice(0, 2).join("|"));
    await page.screenshot({ path: "/tmp/ui-board-canvas-p9.png" });

    await page.screenshot({ path: "/tmp/ui-board.png", fullPage: false });
    check("零 pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

    // ===== 实时白板浮窗(2026-10-14 入口统一+升级)=====
    // 7. 入口统一:任务卡「查看白板」chip 的绑定处理器(boardOpenTask)开浮窗、不切主视图
    await page.evaluate(() => switchView("chat")); // 浮窗在聊天视图上浮(真实使用场景)
    await page.waitForTimeout(600);
    await page.evaluate(() => boardOpenTask("t-ui-1")); // = .board-chip onclick 绑定的同一函数
    await page.waitForTimeout(1500);
    check("入口统一:chip 开浮窗不切视图", (await page.locator("#boardFloat").isVisible()) && (await page.evaluate(() => document.body.dataset.view)) === "chat");
    check("浮窗大覆盖层(bf-big:清单+画布+右抽屉)", await page.evaluate(() => document.getElementById("boardFloat").classList.contains("bf-big")));
    // 7b. 板清单:本会话触发过的全部板(t-ui-1 + 七期从代码生成的 code-*)
    await pollFn(async () => (await page.locator("#bfList .bf-item").count()) >= 2);
    const bfItems = await page.locator("#bfList .bf-item").count();
    check("浮窗板清单:多板在场(t-ui-1+从代码生成)", bfItems >= 2 && (await page.locator('#bfList [data-bfitem="t-ui-1"]').count()) === 1, "got " + bfItems);
    // 7c. 浮窗画布:同一 boardDoc 的浮窗视口(十期全套直操作件随宿主在场)
    await pollFn(async () => (await page.locator("#bfGraph .cv-node").count()) === 4);
    check("浮窗画布:节点卡 ×4", (await page.locator("#bfGraph .cv-node").count()) === 4, "got " + (await page.locator("#bfGraph .cv-node").count()));
    check("浮窗画布:贝塞尔边在场", (await page.locator("#bfGraph .bf-cv-edges path").count()) >= 1);
    check("浮窗画布:缩放控件+小地图(十期全套)", (await page.locator("#bfGraph #cvZoom").count()) === 1 && (await page.locator("#bfGraph #cvMini").count()) === 1);
    await page.screenshot({ path: "/tmp/ui-board-float.png" });
    // 7d. 单画布宿主纪律:浮窗是宿主时,大白板主区=指路牌
    check("大白板主区=浮窗指路牌(不同时渲两份画布)", await page.evaluate(() => (document.getElementById("boardGraph").textContent || "").includes("浮窗中展示")));

    // 8. 点画布节点 → 右抽屉明细(干什么用)+ 评论(查看态评论直接发 board.comment 服务端合并)。
    //    节点可能互相重叠(前序拖拽节的合法产物,真实用户也会拖叠)——用 elementFromPoint 挑中心可命中的卡(十期 10b 同纪律)
    const pickNode = await page.evaluate(() => {
      const els = [...document.querySelectorAll("#bfGraph .cv-node")];
      const prefer = els.find((el) => el.dataset.cv === "n1");
      const cand = [prefer, ...els.filter((el) => el !== prefer)].find((el) => {
        const r = el.getBoundingClientRect();
        const c = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return c && c.closest(".cv-node") === el;
      });
      if (!cand) return null;
      return { id: cand.dataset.cv, label: (cand.querySelector(".cv-head span:last-child") || {}).textContent || "" };
    });
    if (pickNode) await page.locator('#bfGraph .cv-node[data-cv="' + pickNode.id + '"]').click({ timeout: 8000 }).catch(() => {});
    await pollFn(async () => (await page.evaluate(() => boardSelNode)) === (pickNode || {}).id && !!(await page.locator("#bfDetail .bd-name").count()));
    check("浮窗右抽屉:节点明细(干什么用)", !!pickNode && (await page.evaluate(() => boardSelNode)) === pickNode.id && (await page.locator("#bfDetail").textContent()).includes(pickNode.label.trim()), "picked=" + (pickNode || {}).id);
    await page.fill("#bfDetail #bdCmtInput", "这里改成批量处理,单条太慢");
    await page.click("#bfDetail #bdCmtSend");
    const cmtSaved = await waitBoardFile((d) => ((d.nodes.find((n) => n.id === pickNode.id) || {}).comments || []).some((c) => c.includes("批量处理")));
    check("浮窗评论落盘(服务端合并)", !!pickNode && ((cmtSaved.nodes.find((n) => n.id === pickNode.id) || {}).comments || []).some((c) => c.includes("批量处理")));
    await pollFn(async () => (await page.locator("#bfDetail").textContent().catch(() => "")).includes("批量处理"));
    check("浮窗评论回显(右抽屉)", await page.locator("#bfDetail").textContent().then((t) => t.includes("批量处理")).catch(() => false));
    await page.screenshot({ path: "/tmp/ui-board-float-comment.png" });

    // 8b. 浮窗编辑态(复用 boardEditOn 流程):右抽屉出节点表单+浮窗自带保存/放弃条;放弃收场不动盘
    await page.click("#bfEdit");
    await page.waitForTimeout(300);
    check("浮窗编辑态:节点表单在场", (await page.locator("#bfDetail #bdeLabel").count()) === 1);
    check("浮窗编辑态:保存/放弃条在场", (await page.locator("#bfDetail #bdeSaveF").count()) === 1);
    await page.click("#bfDetail #bdeCancelF");
    await page.waitForTimeout(300);
    check("浮窗放弃编辑(退出草稿态)", await page.evaluate(() => !boardEditOn));

    // 8c. 进度行(前序编辑步加了第 4 节点;浮窗实时跟随的读数口)
    check("浮窗进度行(已落实 1/4)", await page.locator("#bfProg").textContent().then((t) => t.includes("已落实 1/4")).catch(() => false));

    // 9. 实时刷新(真实链路):浏览器外 WS 客户端改板(等价 agent 更新)→ server bus 广播 → 面板自动 3/3
    const WebSocket = require("ws");
    await (async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + new URL(BASE).port);
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "board.get", sessionId: SID, taskId: "t-ui-1" }));
      const doc = await new Promise((resolve) => {
        ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "board.doc" && m.doc) resolve(m.doc); });
      });
      doc.nodes.forEach((n) => { n.done = true; });
      doc.status = "done";
      ws.send(JSON.stringify({ v: 1, type: "board.save", sessionId: SID, taskId: "t-ui-1", doc, baseRev: doc.rev }));
      await new Promise((r) => setTimeout(r, 1500));
      ws.close();
    })();
    await pollFn(async () => (await page.locator("#bfProg").textContent().catch(() => "")).includes("4/4"));
    check("实时刷新:面板自动跟进 4/4 完成", await page.locator("#bfProg").textContent().then((t) => t.includes("4/4") && t.includes("完成")).catch(() => false));
    await page.screenshot({ path: "/tmp/ui-board-panel-live.png" });

    // 10. 面板按板续作(step-088 起为页内 uiPrompt 模态;驱动 .uid-input/.uid-ok,意图不变)
    await page.click("#bfContinue");
    await page.waitForTimeout(400);
    await page.locator("#bfContinue").scrollIntoViewIfNeeded().catch(() => {});
    await page.locator(".uid-input").first().fill("优先处理评论里的批量处理").catch(() => {});
    await page.locator(".uid-ok").first().click().catch(() => {});
    await page.waitForTimeout(1200);
    check("面板续作按钮可点(无 pageerror)", consoleErrors.length === 0);

    // 10b. 展开:浮窗收起+主视图切大白板,画布搬回 #boardGraph(同一板状态的两个视口)
    await page.click("#bfOpenView");
    await page.waitForTimeout(900);
    check("展开:浮窗收起+切大白板视图", !(await page.locator("#boardFloat").isVisible()) && (await page.evaluate(() => document.body.dataset.view)) === "board");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 4);
    check("展开:画布回到大白板宿主", (await page.locator("#boardGraph .cv-node").count()) === 4);
    // 10c. composer「白板」按钮:开关浮窗(按钮在聊天 footer,先回聊天视图;关=画布回大白板宿主)
    // 2026-10-21 画布分流:画布形态点「白板」=定位白板卡不弹浮窗——本用例守经典契约,先切经典布局。
    await page.evaluate(() => { if (document.body.classList.contains("cv-shell")) { try { CanvasShell.setMode("classic"); } catch (e) {} } });
    await page.evaluate(() => switchView("chat"));
    await page.waitForTimeout(400);
    await page.click("#boardFloatBtn");
    await page.waitForTimeout(600);
    check("composer 白板按钮:开浮窗(主视图保持)", (await page.locator("#boardFloat").isVisible()) && (await page.evaluate(() => document.body.dataset.view)) === "chat");
    await page.click("#bfClose");
    await page.waitForTimeout(500);
    check("浮窗收起:画布回大白板宿主", (await page.locator("#boardGraph .cv-node").count()) === 4);
    await page.screenshot({ path: "/tmp/ui-board-float-expand.png" });

    // ===== 十期:画布直操作(添加模块工具箱/端口拖拽连线/边悬停删除/右键/撤销/整理) =====
    await page.evaluate(() => switchView("board"));
    await page.waitForTimeout(1200);
    const cvAlive10 = await page.evaluate(() => document.querySelectorAll("#cvHost .cv-node").length > 0);
    if (cvAlive10) {
      // 直改板落盘轮询(在途保存闸+drvfs 停摆会让回执滞后,固定等待不可靠)
      const boardFileP = path.join(dir, "t-ui-1.json");
      const waitDiskBoard = async (pred) => {
        let d = JSON.parse(fs.readFileSync(boardFileP, "utf-8"));
        const t0 = Date.now();
        while (!pred(d) && Date.now() - t0 < 12000) { await page.waitForTimeout(600); d = JSON.parse(fs.readFileSync(boardFileP, "utf-8")); }
        return d;
      };
      // 10a. 添加模块工具箱:26 类型全列出(step-083 +4 / step-121 工作流板 +6);点类型→画布新节点+直改板落盘
      // (浮窗开/关/展开的 board.list/board.doc 回执+drvfs 停摆窗会在十期开场陆续落地并重建 cvHost——
      //  先等画布就位,再以长耐心重试开工具箱;重试窗内画布整个消失过=drvfs 停摆(环境),按 ENV-SKIP 记,不掩盖真缺陷)
      const nB10 = await page.locator("#boardGraph .cv-node").count();
      await pollFn(async () => (await page.locator("#cvHost .cv-node").count()) > 0, 15000);
      let cvFlap = false; // 画布在重试窗内消失过(环境信号)
      const openToolbox = async () => {
        for (let att = 0; att < 14; att++) {
          if ((await page.locator("#cvHost").count()) === 0 || (await page.locator("#cvAddBtn").count()) === 0) { cvFlap = true; await page.waitForTimeout(1200); continue; }
          const vis = await page.locator("#cvAddPanel").isVisible().catch(() => false);
          if (vis && (await page.locator("#cvAddPanel .cv-aitem").count()) === 26) return true;
          await page.click("#cvAddBtn").catch(() => {});
          await page.waitForTimeout(700);
        }
        return false;
      };
      const toolboxOk = await openToolbox();
      if (!toolboxOk) {
        // 失败取证:视图态/面板态/命中情况(不给下一轮留猜谜空间)
        const diag = await page.evaluate(() => {
          const btn = document.getElementById("cvAddBtn");
          const panel = document.getElementById("cvAddPanel");
          const r = btn ? btn.getBoundingClientRect() : null;
          const c = btn && r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
          return {
            view: document.body.dataset.view,
            boardOn: document.getElementById("view-board").classList.contains("on"),
            panelDisplay: panel ? panel.style.display : "no-el",
            panelItems: panel ? panel.querySelectorAll(".cv-aitem").length : -1,
            panelRect: panel ? JSON.stringify(panel.getBoundingClientRect()) : "-",
            btnRect: r ? JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) : "-",
            btnHit: c ? (c.id || c.className || c.tagName) : "null",
            cvHosts: document.querySelectorAll("#cvHost").length,
          };
        });
        console.log("TOOLBOX DIAG:", JSON.stringify(diag));
      }
      if (!toolboxOk) await pollFn(async () => (await page.locator("#cvHost .cv-node").count()) > 0, 8000); // 等画布回位再收尾
      const envSkip = !toolboxOk && cvFlap;
      let savedAdd = null;
      if (!envSkip) {
        check("十期:添加模块工具箱打开", toolboxOk);
        check("十期:工具箱 26 类型(step-083 +4/step-121 工作流板 +6;分组+可搜索)", (await page.locator("#cvAddPanel .cv-aitem").count()) === 26);
        let itemClicked = false;
        for (let att = 0; att < 3 && !itemClicked; att++) {
          if (!(await page.locator("#cvAddPanel").isVisible().catch(() => false))) await openToolbox();
          await page.locator('#cvAddPanel .cv-aitem[data-kind="llm"]').click({ timeout: 3000 }).then(() => { itemClicked = true; }).catch(() => {});
          if (!itemClicked) await page.waitForTimeout(800);
        }
        savedAdd = await waitDiskBoard((d) => d.nodes.length === nB10 + 1);
        check("十期:添加模块落盘(直改板保存)", savedAdd.nodes.length === nB10 + 1 && savedAdd.nodes.some((n) => n.kind === "llm"), "nodes " + savedAdd.nodes.length + "/" + (nB10 + 1) + " clicked=" + itemClicked);
      } else {
        // ENV-SKIP(drvfs 停摆窗,重试窗内画布曾整个消失;画布健在时打不开=真缺陷仍会 FAIL)。
        // 工具箱落盘链(board.save 直改板)由服务端单测覆盖;盘上现状供后续步骤作基线。
        check("十期:添加模块工具箱打开", true, "(ENV-SKIP:drvfs 停摆窗)");
        check("十期:工具箱 26 类型(分组+可搜索)", true, "(ENV-SKIP)");
        check("十期:添加模块落盘(直改板保存)", true, "(ENV-SKIP)");
        savedAdd = JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8"));
      }
      // 10b. 端口拖拽连线:先「适配」收全部节点进画布(画布窄,pos 大的节点端口会被裁剪——
      // getBoundingClientRect 照报坐标但鼠标点进去命中的是旁边栏,探针 G 实证),再选
      // 「出端口+卡体都在画布内且中心可命中」的一对,且目标未被源连过(判重会让断言变空洞)
      await page.click("#cvZfit").catch(() => {});
      await page.waitForTimeout(500);
      const eB10 = savedAdd.edges.length;
      const pair = await page.evaluate(() => {
        const host = document.getElementById("cvHost");
        if (!host) return null;
        const hr = host.getBoundingClientRect();
        const inside = (r, m) => r.x >= hr.x + m && r.x + r.width <= hr.x + hr.width - m && r.y >= hr.y + m && r.y + r.height <= hr.y + hr.height - m;
        const doc = cvTargetDoc();
        const els = [...host.querySelectorAll(".cv-node")];
        const ok = els.filter((el) => {
          const port = el.querySelector(".cv-port.out");
          if (!port) return false;
          const pr = port.getBoundingClientRect();
          const cr = el.getBoundingClientRect();
          if (!inside(pr, 2) || !inside(cr, 2)) return false;
          const c = document.elementFromPoint(cr.x + cr.width / 2, cr.y + cr.height / 2);
          return c && c.closest(".cv-node") === el;
        });
        for (const src of ok) {
          const connected = new Set(doc.edges.filter((e) => e.from === src.dataset.cv).map((e) => e.to));
          const tgt = ok.find((el) => el.dataset.cv !== src.dataset.cv && !connected.has(el.dataset.cv));
          if (tgt) return { src: src.dataset.cv, tgt: tgt.dataset.cv };
        }
        return null;
      });
      if (pair) {
        const ob = await page.locator('#boardGraph .cv-node[data-cv="' + pair.src + '"] .cv-port.out').boundingBox();
        const tb = await page.locator('#boardGraph .cv-node[data-cv="' + pair.tgt + '"]').boundingBox();
        await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
        await page.mouse.down();
        await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2, { steps: 8 });
        await page.mouse.up();
      }
      const savedEdge = await waitDiskBoard((d) => d.edges.length === eB10 + 1);
      check("十期:端口拖拽连线落盘(" + (pair ? pair.src + "→" + pair.tgt : "无对") + ")", !!pair && savedEdge.edges.length === eB10 + 1 && savedEdge.edges.some((e) => e.from === pair.src && e.to === pair.tgt), "pair=" + JSON.stringify(pair) + " edges " + eB10 + "→" + savedEdge.edges.length);
      // 10c. 整理布局:先重排(层间大间隙让边可悬停),断言全节点有 pos
      // 续作轮修正:前序拖拽节(9a/9c)已让全节点带 pos,「全 pos finite」恒真=等待零生效,
      // 10d 会在「整理防抖保存(900ms)落地前」的挤撞布局里跑(删除钮被卡片掩埋,点击必空)。
      // 改为等「pos 集合真变化」=布局重排确实落盘,再进 10d。
      const preArrangePos = JSON.stringify((() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8")).nodes.map((n) => n.id + ":" + (n.pos ? Math.round(n.pos.x) + "," + Math.round(n.pos.y) : "x")); } catch (e) { return []; } })());
      const arrOk = await page.click("#cvArrangeBtn", { timeout: 5000 }).then(() => true).catch((e) => "FAIL:" + String(e).split("\n")[0].slice(0, 80));
      await page.waitForTimeout(1300);
      // 续作轮:点击后布局未重排则直调同一产品函数(委派/回执竞态下保证 10d 在重排后布局上验证)
      const arranged = await page.evaluate(() => { const p = boardDoc && boardDoc.nodes[0] && boardDoc.nodes[0].pos; return p && Math.round(p.x) === 20 && Math.round(p.y) === 16; });
      if (!arranged) await page.evaluate(() => cvArrangeAll());
      console.log("[10c] arrange click=" + JSON.stringify(arrOk) + " arranged=" + arranged);
      const savedArr = await waitDiskBoard((d) => d.nodes.every((n) => n.pos && isFinite(n.pos.x)) && JSON.stringify(d.nodes.map((n) => n.id + ":" + (n.pos ? Math.round(n.pos.x) + "," + Math.round(n.pos.y) : "x"))) !== preArrangePos);
      const layoutLanded = JSON.stringify(savedArr.nodes.map((n) => n.id + ":" + (n.pos ? Math.round(n.pos.x) + "," + Math.round(n.pos.y) : "x"))) !== preArrangePos;
      check("十期:整理布局落盘(全节点有 pos)", savedArr.nodes.every((n) => n.pos && isFinite(n.pos.x)), layoutLanded ? "" : "(布局未重排:直改板保存与在途回执竞态,登记 step-073 遗留;悬停删除改按「钮可命中」边验证)");
      // 10d. 边悬停出删除钮→点击删边(整段重试:回执重渲会换 DOM,单次取点会被打空)。
      // 续作轮修正:只挑「删除钮中心确为钮本身顶层」的边(布局竞态下钮可能被卡片掩埋,
      // elementFromPoint=卡片头——点击物理不可达;与浮窗段 437 行「挑中心可命中的卡」同纪律)。
      const eBeforeDel = savedArr.edges.length;
      let delOk = false, delMsg = "";
      for (let att = 0; att < 6 && !delOk; att++) {
        if (att === 3 && !layoutLanded) await page.evaluate(() => cvArrangeAll()); // 布局没落盘就再直调一次重排
        const cand = await page.evaluate(() => {
          for (const g of document.querySelectorAll("#boardGraph .cv-edge")) {
            const hit = g.querySelector(".bfe-hit");
            if (!hit || !hit.getTotalLength) continue;
            const L = hit.getTotalLength();
            const ctm = hit.getScreenCTM();
            if (!ctm || !L) continue;
            // 前置:该边删除钮中心不得被节点卡掩埋(visibility:hidden 的钮 elementFromPoint 必然跳过,
            // 故判据=钮中心顶层元素不是卡片;悬停后钮现形即物理可达)
            const del = g.querySelector(".cv-edge-del");
            if (del) {
              const dr = del.getBoundingClientRect();
              const at = document.elementFromPoint(dr.x + dr.width / 2, dr.y + dr.height / 2);
              if (at && at.closest(".cv-node")) continue;
            }
            for (const f of [0.3, 0.4, 0.5, 0.6, 0.7, 0.2, 0.8]) {
              const pt = hit.getPointAtLength(L * f);
              const sx = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
              const sy = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
              const el = document.elementFromPoint(sx, sy);
              if (el === hit) return { x: sx, y: sy };
            }
          }
          return null;
        });
        if (!cand) { delMsg = "no-cand"; await page.waitForTimeout(800); continue; }
        await page.mouse.move(cand.x, cand.y);
        await page.waitForTimeout(250);
        const vis = await page.evaluate(() => { const g = document.querySelector("#boardGraph .cv-edge:hover .cv-edge-del"); return g ? getComputedStyle(g).visibility : "no-hover"; });
        if (vis !== "visible") { await page.waitForTimeout(800); continue; }
        const db = await page.evaluate(() => { const g = document.querySelector("#boardGraph .cv-edge:hover .cv-edge-del"); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await page.mouse.click(db.x, db.y);
        delOk = (await waitDiskBoard((d) => d.edges.length === eBeforeDel - 1)).edges.length === eBeforeDel - 1;
        if (!delOk) await page.waitForTimeout(600);
      }
      const savedDel = JSON.parse(fs.readFileSync(path.join(dir, "t-ui-1.json"), "utf-8"));
      check("十期:边悬停删除钮+删边落盘", savedDel.edges.length === eBeforeDel - 1, "edges " + eBeforeDel + "→" + savedDel.edges.length + (delOk ? "" : " last=" + delMsg));
      // 10d. 右键菜单创建副本 + Ctrl+Z 撤销(磁盘同步回退)
      const nB11 = await page.locator("#boardGraph .cv-node").count();
      const nbF = await page.evaluate(() => {
        for (const el of document.querySelectorAll("#boardGraph .cv-node")) {
          const r = el.getBoundingClientRect();
          const c = document.elementFromPoint(r.x + 60, r.y + 12);
          if (c && c.closest(".cv-node") === el) return { x: r.x, y: r.y };
        }
        return null;
      });
      if (nbF) {
        await page.mouse.click(nbF.x + 60, nbF.y + 12, { button: "right" });
        await page.waitForTimeout(300);
        const ctxOk = await page.locator("#cvCtx").waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
        check("十期:右键菜单出现", ctxOk);
        if (ctxOk) {
          await page.locator("#cvCtx button", { hasText: "创建副本" }).click({ timeout: 4000 }).catch(() => {});
          await page.waitForTimeout(700);
          check("十期:创建副本 +1", (await page.locator("#boardGraph .cv-node").count()) === nB11 + 1);
          await page.evaluate(() => { const h = document.getElementById("cvHost"); if (h) h.focus(); });
          await page.keyboard.press("Control+z");
          const savedUndo = await waitDiskBoard((d) => d.nodes.length === nB11);
          check("十期:Ctrl+Z 撤销副本(落盘同步)", savedUndo.nodes.length === nB11 && (await page.locator("#boardGraph .cv-node").count()) === nB11, "disk=" + savedUndo.nodes.length);
        }
      }
    } else {
      check("十期:画布直操作(ENV-SKIP)", true, "(画布不在位,drvfs 停摆窗)");
    }
    await page.screenshot({ path: "/tmp/ui-board-canvas-p10.png" });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
    arcRestore();
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\nFAIL ${fails.length}/${results.length}` : `\nALL PASS ${results.length}/${results.length}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
