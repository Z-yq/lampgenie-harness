/** UI 实测:step-121 工作流板(docKind=workflow)——真实 chromium 无头 + 自起实例(_boardwf_selfhost.cjs)。
 * 覆盖:A0 新建工作流板;A1 三节点流(script→test→notify)编译执行→节点状态依次点亮+journal 留痕;
 *      A2/A3 condition 真/假分支 + 配置抽屉改 cond→重编译执行生效;A4 编译错误 fail-visible(环);
 *      A7 存为自动化(automation.create 落一条);A5 多尺寸截图 + 0 pageerror。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7817";
const JDIR = process.env.WF_JOURNAL_DIR || "/tmp/j-s121";
const SID = "ui-wfboard-test";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const DIR = path.join(HARNESS_ROOT, ".genie", "boards", SID);

const now = () => Date.now();
const B1 = { // A1:三节点流
  version: 1, taskId: "wf-a1-chain", sessionId: SID, title: "A1 三节点流:准备→测试→通知", status: "draft", docKind: "workflow", rev: 1, root: HARNESS_ROOT,
  nodes: [
    { id: "n1", kind: "wf-script", label: "准备", summary: "echo 确定性命令", change: "add", done: false, comments: [], flow: [], wf: { command: "echo board-wf-setup" } },
    { id: "n2", kind: "wf-test", label: "测试门", summary: "echo 测试(退出码 0)", change: "add", done: false, comments: [], flow: [], wf: { command: "echo board-wf-test-ok" } },
    { id: "n3", kind: "wf-notify", label: "通知", summary: "流程完成通知", change: "add", done: false, comments: [], flow: [], wf: { message: "三节点流完成" } },
  ],
  edges: [{ from: "n1", to: "n2", kind: "call" }, { from: "n2", to: "n3", kind: "call" }],
  planned_files: [], updatedAt: now() - 3000,
};
const B2 = { // A2/A3:条件分支
  version: 1, taskId: "wf-a2-cond", sessionId: SID, title: "A2 条件分支:按退出码走真/假", status: "draft", docKind: "workflow", rev: 1, root: HARNESS_ROOT,
  nodes: [
    { id: "n1", kind: "wf-script", label: "准备", summary: "echo 退出码 0", change: "add", done: false, comments: [], flow: [], wf: { command: "echo cond-setup" } },
    { id: "c1", kind: "wf-condition", label: "按退出码分", summary: "code===0 走真", change: "add", done: false, comments: [], flow: [], wf: { cond: 'R["n1"].code === 0' } },
    { id: "okp", kind: "wf-notify", label: "真分支", summary: "走了真", change: "add", done: false, comments: [], flow: [], wf: { message: "走了真分支" } },
    { id: "badp", kind: "wf-notify", label: "假分支", summary: "走了假", change: "add", done: false, comments: [], flow: [], wf: { message: "走了假分支" } },
  ],
  edges: [
    { from: "n1", to: "c1", kind: "call" },
    { from: "c1", to: "okp", kind: "call", label: "真" },
    { from: "c1", to: "badp", kind: "call", label: "假" },
  ],
  planned_files: [], updatedAt: now() - 2000,
};
const B3 = { // A4:编译错误(环)
  version: 1, taskId: "wf-a4-cycle", sessionId: SID, title: "A4 编译错误:成环", status: "draft", docKind: "workflow", rev: 1, root: HARNESS_ROOT,
  nodes: [
    { id: "a", kind: "wf-script", label: "环A", summary: "echo a", change: "add", done: false, comments: [], flow: [], wf: { command: "echo a" } },
    { id: "b", kind: "wf-script", label: "环B", summary: "echo b", change: "add", done: false, comments: [], flow: [], wf: { command: "echo b" } },
  ],
  edges: [{ from: "a", to: "b", kind: "call" }, { from: "b", to: "a", kind: "call" }],
  planned_files: [], updatedAt: now() - 1000,
};

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const d of [B1, B2, B3]) fs.writeFileSync(path.join(DIR, d.taskId + ".json"), JSON.stringify(d));
  const journalFile = path.join(JDIR, "gateway.jsonl");
  const journalLines = () => { try { return fs.readFileSync(journalFile, "utf-8").split("\n").filter((l) => l.trim()); } catch (e) { return []; } };
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const pollFn = async (fn, ms = 15000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const wfBadgeOf = (page, id) => page.locator('#boardGraph .cv-node[data-cv="' + id + '"] .cv-wf-badge').textContent().catch(() => "");
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors = [];
    page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
    await page.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); }, SID);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    // 板清单就位(drvfs 写后立读窗:list 可能空,轮询+重拉——board.spec 同纪律)
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(800);
      if ((await page.locator("#boardTaskSel option").count()) >= 3) break;
      await page.evaluate(() => { try { boardRefresh(); } catch (e) {} });
    }
    check("板清单:三块工作流板在场", (await page.locator("#boardTaskSel").textContent()).includes("A1"));

    // ===== A1 三节点流:编译执行→节点状态依次点亮 done =====
    await page.selectOption("#boardTaskSel", "wf-a1-chain");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 3);
    check("A1 画布渲染:3 个 wf 节点", (await page.locator("#boardGraph .cv-node").count()) === 3);
    check("A1 工作流板件位:编译脚本/编译执行/存为自动化按钮在场", await page.locator("#boardWfCompile").isVisible() && await page.locator("#boardWfRun").isVisible() && await page.locator("#boardWfAuto").isVisible());
    check("A1 板头元信息带「工作流板」标签", await page.locator("#boardGraph .bd-meta").textContent().then((t) => t.includes("工作流板")).catch(() => false));
    await page.screenshot({ path: "/tmp/ui-wf-a1-idle.png" });
    // 编译预览(fail-visible 正向):脚本出现
    await page.click("#boardWfCompile");
    await pollFn(async () => (await page.locator("#boardDetail textarea").count()) === 1);
    const scriptTxt = await page.locator("#boardDetail textarea").inputValue().catch(() => "");
    check("A1 编译预览:引擎脚本输出(world.run/report/WFN)", scriptTxt.includes("world.run") && scriptTxt.includes("report") && scriptTxt.includes("WFN"));
    // 编译执行
    const jBefore = journalLines().length;
    await page.click("#boardWfRun");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node.wf-done").count()) === 3, 20000);
    check("A1 执行:3 节点全部点亮 done", (await page.locator("#boardGraph .cv-node.wf-done").count()) === 3);
    const bN3 = await wfBadgeOf(page, "n3");
    check("A1 通知节点角标=完成+耗时", bN3.includes("完成"), "badge=" + bN3);
    // journal 留痕:workflow.node(每节点 start/done)+run.start/run.done
    const wfNodeEvents = journalLines().slice(jBefore).filter((l) => l.includes("workflow.node") && l.includes("wf-a1-chain"));
    const wfRunEvents = journalLines().slice(jBefore).filter((l) => l.includes("workflow.run.start") && l.includes("wf-a1-chain"));
    check("A1 journal 留痕:workflow.node ≥6 + run.start", wfNodeEvents.length >= 6 && wfRunEvents.length >= 1, "node=" + wfNodeEvents.length + " run=" + wfRunEvents.length);
    await pollFn(async () => (await page.locator("#boardDetail").textContent().catch(() => "")).includes("运行完成"));
    check("A1 终态摘要(运行完成/成果)", await page.locator("#boardDetail").textContent().then((t) => t.includes("运行完成") && t.includes("三节点流完成")).catch(() => false));
    await page.screenshot({ path: "/tmp/ui-wf-a1-done.png" });

    // ===== A2 条件分支:真分支走,假分支不跑 =====
    await page.selectOption("#boardTaskSel", "wf-a2-cond");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 4);
    await page.click("#boardWfRun");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node.wf-done").count()) === 3, 20000); // n1+c1+okp
    check("A2 真分支:条件节点 done 且 detail=真", (await wfBadgeOf(page, "c1")).includes("完成"));
    const okBadge = await wfBadgeOf(page, "okp");
    const badCls = await page.locator('#boardGraph .cv-node[data-cv="badp"]').getAttribute("class").catch(() => "");
    check("A2 真分支走通/假分支零执行", okBadge.includes("完成") && !badCls.includes("wf-done"), "ok=" + okBadge + " badCls=" + badCls);
    await page.screenshot({ path: "/tmp/ui-wf-a2-true.png" });

    // ===== A3 配置抽屉:双击节点改 cond → 保存 → 重编译执行走假分支 =====
    await page.locator('#boardGraph .cv-node[data-cv="c1"]').dblclick();
    await page.waitForTimeout(600);
    check("A3 双击开配置抽屉(进编辑态+cond 表单)", await page.locator("#bdeWfCond").count() === 1 && await page.locator("#boardEditBar").isVisible().catch(() => false));
    await page.fill("#bdeWfCond", 'R["n1"].code === 9');
    await page.click("#boardSaveBtn");
    await pollFn(async () => !(await page.evaluate(() => boardEditOn)));
    const savedB2 = JSON.parse(fs.readFileSync(path.join(DIR, "wf-a2-cond.json"), "utf-8"));
    check("A3 参数落盘:cond 改为 code===9", (savedB2.nodes.find((n) => n.id === "c1") || {}).wf.cond.includes("code === 9"));
    await page.click("#boardWfRun");
    await pollFn(async () => {
      const cls = await page.locator('#boardGraph .cv-node[data-cv="badp"]').getAttribute("class").catch(() => "");
      return cls && cls.includes("wf-done");
    }, 20000);
    const badBadge = await wfBadgeOf(page, "badp");
    const okCls = await page.locator('#boardGraph .cv-node[data-cv="okp"]').getAttribute("class").catch(() => "");
    check("A3 重编译执行生效:假分支点亮/真分支本轮零执行", badBadge.includes("完成") && !okCls.includes("wf-done"), "bad=" + badBadge);
    await page.screenshot({ path: "/tmp/ui-wf-a3-false.png" });

    // ===== A4 编译错误 fail-visible:环 =====
    await page.selectOption("#boardTaskSel", "wf-a4-cycle");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 2);
    await page.click("#boardWfCompile");
    await pollFn(async () => (await page.locator("#boardDetail").textContent().catch(() => "")).includes("编译失败"));
    const errTxt = await page.locator("#boardDetail").textContent();
    check("A4 编译错误列出(成环 fail-visible)", errTxt.includes("成环") && errTxt.includes("编译失败"));
    // 编译执行也 fail-visible(run.result errors 回面板)
    await page.click("#boardWfRun");
    await pollFn(async () => (await page.locator("#boardDetail").textContent().catch(() => "")).includes("运行失败"), 10000);
    check("A4 执行入口的编译失败也可见", (await page.locator("#boardDetail").textContent()).includes("成环"));
    await page.screenshot({ path: "/tmp/ui-wf-a4-errors.png" });

    // ===== A7 存为自动化(编译产物→automation.create) =====
    await page.selectOption("#boardTaskSel", "wf-a1-chain");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 3);
    await page.click("#boardWfCompile"); // 拿编译产物
    await pollFn(async () => (await page.locator("#boardDetail textarea").count()) === 1);
    await page.click("#boardWfAuto");
    await page.waitForTimeout(400);
    await page.locator(".uid-input").last().fill("30").catch(async () => {
      const d = await page.waitForEvent("dialog", { timeout: 2000 }).catch(() => null);
      if (d) await d.accept("30");
    });
    await page.locator(".uid-ok").last().click().catch(() => {});
    await page.waitForTimeout(1200);
    // 裸 WS 客户端验证 automation 落库(instruction 内嵌脚本)
    const WebSocket = require("ws");
    const autoName = await (async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + new URL(BASE).port);
      await new Promise((r) => ws.on("open", r));
      ws.send(JSON.stringify({ v: 1, type: "automation.list" }));
      const got = await new Promise((resolve) => {
        ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); if (m.type === "automation.list.result") resolve(m.automations || []); });
        setTimeout(() => resolve([]), 3000);
      });
      ws.close();
      const it = got.find((a) => (a.name || "").includes("工作流板"));
      return it ? it.name + "|" + (it.instruction || "").slice(0, 40) : "";
    })();
    check("A7 存为自动化:instruction 内嵌编译脚本", autoName.includes("run_workflow") || autoName.includes("workflow 脚本"), autoName.slice(0, 60));

    // ===== A0 新建工作流板(按钮→board.save→画布起步节点) =====
    await page.click("#boardWfNew");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) >= 1 && (await page.evaluate(() => boardDoc && boardDoc.docKind)) === "workflow" && (await page.evaluate(() => boardDoc.taskId)).startsWith("wf-"));
    check("A0 新建工作流板:起步节点+docKind=workflow", (await page.locator("#boardGraph .cv-node").count()) >= 1);
    // 工具箱:工作流执行分组 6 类型
    await page.click("#cvAddBtn").catch(() => {});
    await page.waitForTimeout(400);
    const wfItems = await page.locator('#cvAddPanel .cv-aitem[data-kind^="wf-"]').count();
    check("A0 工具箱:wf-* 6 类型", wfItems === 6, "got " + wfItems);
    await page.screenshot({ path: "/tmp/ui-wf-a0-toolbox.png" });
    // 收尾:删掉新建板文件(防污染仓库 .genie)
    const newTaskId = await page.evaluate(() => boardDoc.taskId);
    fs.rmSync(path.join(DIR, newTaskId + ".json"), { force: true });

    // ===== A5 多尺寸截图 + 0 pageerror =====
    await page.selectOption("#boardTaskSel", "wf-a1-chain");
    await pollFn(async () => (await page.locator("#boardGraph .cv-node").count()) === 3);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/ui-wf-a5-900.png" });
    check("A5 多尺寸(900x700)渲染不炸", (await page.locator("#boardGraph .cv-node").count()) === 3);
    check("A5 零 pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\nFAIL ${fails.length}/${results.length}` : `\nALL PASS ${results.length}/${results.length}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
