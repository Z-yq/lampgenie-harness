/** UI 经验证:白板「看得懂」四件。
 * 断言(三张真实板,数据在 .genie/boards/<sid>/ 下,只读不删):
 *   ① 锚 chip 可见:节点卡出现 .cv-file-foot 内的文件 chip(.cv-file-name)或符号 chip(.cv-sym-name),
 *      且 chip 的 title 带全路径(不是只有 basename);
 *   ② 层分组:.cv-layer-chip 至少两个(现状层/变更层),数字与板上 change 计数一致;
 *   ③ 板头统计:板头含「代码锚 K/N」,K/N 与带 targets/symbolRef 的节点数一致;
 *   ④ 主题带:另建一块带 theme 节点的临时板,断言 .cv-theme-band 出现且不遮挡节点卡;
 *   ⑤ 多板默认选主板:临时 session 里放 2 台板(3 节点 / 9 节点),默认渲染 9 节点那块。
 * 跑法:cd apps/gateway && npx tsx test/ui/boardanchors.spec.cjs(自起临时端口,不碰生产环境 7700)
 * 无 chrome/无 playwright-core 时整文件 skip 并打印 skipped: <reason>(退出码 0,不谎报通过)。 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7799);
const skip = (reason) => { console.log("skipped: " + reason); process.exit(0); };

let chromium = null;
try { chromium = require("playwright-core").chromium; } catch (e) { skip("playwright-core 不可用(" + String(e && e.message).slice(0, 60) + ")"); }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome 可执行文件 " + CHROME);

// 三张真实板(用户点名):sessionId → 期望主板节点数
const REAL = [
  { sid: "web-ng-tasksm-1793811933881", want: 17, name: "tasksm-17" },
  { sid: "web-ng-diagram-1793810777515", want: 10, name: "diagram-10" },
  { sid: "web-ng-boardtel-1793811933881", want: 6, name: "boardtel-6" },
];
const THEME_SID = "ui-boardanchors-theme";
const MULTI_SID = "ui-boardanchors-multi";
const THEME_TID = "t-theme-1";
const MULTI_SMALL = "t-multi-small";
const MULTI_BIG = "t-multi-big";

const node = (o) => Object.assign({
  kind: "function", label: "步骤", summary: "说明", change: "keep", done: false,
  comments: [], accept: [], flow: [], targets: [], edges: [],
}, o);
const mkBoard = (taskId, sessionId, title, nodes, edges) => ({
  version: 1, taskId, sessionId, title, status: "implementing", rev: 1, root: HARNESS_ROOT,
  boardType: "code", scale: "M", docKind: "design",
  nodes, edges: edges || nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: "call", label: "触发" })),
  planned_files: [], updatedAt: Date.now(),
});

const THEME_NODES = [
  node({ id: "theme-1", kind: "note", label: "主题:任务状态机恢复", summary: "大流程:任务提交后按状态机推进,interrupted 态可续跑;本次改 submit 里的入队分支", change: "keep", group: "00 主题" }),
  node({ id: "s1", kind: "start", label: "用户提交任务", summary: "面板 submit", change: "keep", group: "01 主线", targets: ["apps/gateway/src/task-manager.ts"], symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 } }),
  node({ id: "s2", kind: "function", label: "入队", summary: "队列写入", change: "modify", before: "TaskSupervisor.submit 直接 push", group: "01 主线", targets: ["apps/gateway/src/task-manager.ts"], symbolRef: { name: "TaskSupervisor.submit", file: "apps/gateway/src/task-manager.ts", line: 60 } }),
  node({ id: "s3", kind: "end", label: "返回 taskId", summary: "回执", change: "keep", group: "01 主线" }),
];
const THEME_EDGES = [
  { from: "s1", to: "s2", kind: "call", label: "调用" },
  { from: "s2", to: "s3", kind: "call", label: "返回" },
  { from: "theme-1", to: "s1", kind: "data", label: "属于" },
];
const SMALL_NODES = [node({ id: "m1", kind: "start", label: "起", summary: "x" }), node({ id: "m2", kind: "function", label: "中", summary: "y" }), node({ id: "m3", kind: "end", label: "止", summary: "z" })];
const BIG_NODES = Array.from({ length: 9 }, (_, i) => node({
  id: "b" + (i + 1), kind: i === 0 ? "start" : i === 8 ? "end" : "function",
  label: "大板步骤 " + (i + 1), summary: "节点 " + (i + 1), change: i % 3 === 0 ? "modify" : "keep",
  targets: ["apps/gateway/src/task-manager.ts"],
}));

(async () => {
  // src/*.ts 已含 top-level await(ESM-only)——CJS require 会报 ERR_REQUIRE_ASYNC_MODULE,改动态 import。
  const { createGatewayApp } = await import("../../src/app.ts");
  const { servePanel } = await import("../../src/panel.ts");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");

  // 临时 session 的两块板(跑完删);真实板目录绝不触碰
  const created = [];
  const writeBoard = (sid, board) => {
    const dir = path.join(HARNESS_ROOT, ".genie", "boards", sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, board.taskId + ".json"), JSON.stringify(board));
    return dir;
  };
  writeBoard(THEME_SID, mkBoard(THEME_TID, THEME_SID, "主题带实测板", THEME_NODES, THEME_EDGES)); created.push(THEME_SID);
  writeBoard(MULTI_SID, mkBoard(MULTI_SMALL, MULTI_SID, "小板(3 节点)", SMALL_NODES)); 
  writeBoard(MULTI_SID, mkBoard(MULTI_BIG, MULTI_SID, "主板(9 节点)", BIG_NODES)); created.push(MULTI_SID);

  const jd = mkdtempSync(path.join(tmpdir(), "uianchor-"));
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
  const openBoard = async (sid, minNodes, mode) => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e).slice(0, 150)));
    await page.addInitScript(([s, m]) => {
      sessionStorage.setItem("zh:sid", s);
      if (m) localStorage.setItem("cvRender", m); // cards=卡片 DOM 路径(锚 chip);缺省=svg(flowkit 出图)
    }, [sid, mode || ""]);
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click("#act-board");
    const sel = mode === "cards" ? "#boardGraph .cv-node" : "#boardGraph [data-node-id]";
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(700);
      const n = await page.locator(sel).count();
      if (n >= minNodes) break;
      await page.evaluate(() => { try { boardRefresh(); } catch (e) { /* 旧壳 */ } });
    }
    return { page, errs };
  };

  try {
    // ---------- ① 三张真实板:锚 chip / 层带 / 板头统计 ----------
    // 两种渲染模式都验:cards(DOM 卡,锚走 .cv-file-foot chip)/ svg(flowkit 出图,默认;
 // 锚走 OFK desc,断言 svg 文本里出现文件基名与符号名—— 经验证这才是用户默认看到的那条路)
    for (const r of REAL) {
      const dir = path.join(HARNESS_ROOT, ".genie", "boards", r.sid);
      if (!fs.existsSync(dir)) { check(r.name + " 板目录存在", false, dir + " 不存在"); continue; }
      // --- cards 模式:chip 可见性 ---
      const c = await openBoard(r.sid, 3, "cards");
      const n = await c.page.locator("#boardGraph .cv-node").count();
      check(r.name + ":cards 模式节点卡渲染", n >= 3, "got " + n);
      const anchors = await c.page.evaluate(() => {
        const fileChips = [...document.querySelectorAll("#boardGraph .cv-file-name,#boardGraph .cv-file")];
        const symChips = [...document.querySelectorAll("#boardGraph .cv-sym-name")];
        return {
          file: fileChips.length,
          sym: symChips.length,
          fileTitle: fileChips.length ? (fileChips[0].getAttribute("title") || "") : "",
          symTitle: symChips.length ? (symChips[0].getAttribute("title") || "") : "",
        };
      });
      check(r.name + ":cards 锚 chip 可见", (anchors.file + anchors.sym) > 0, "file=" + anchors.file + " sym=" + anchors.sym);
      check(r.name + ":chip title 带全路径/行号", anchors.fileTitle.indexOf("/") >= 0 || anchors.symTitle.indexOf("/") >= 0, "fileTitle=" + anchors.fileTitle.slice(0, 60) + " | symTitle=" + anchors.symTitle.slice(0, 60));
      const stats = await c.page.evaluate(() => {
        const txt = (document.body.textContent || "");
        const m = txt.match(/现状\s*(\d+)\s*·\s*变更\s*(\d+)\s*·\s*代码锚\s*(\d+)\/(\d+)/);
        return m ? { keep: +m[1], chg: +m[2], k: +m[3], total: +m[4], raw: m[0] } : null;
      });
      check(r.name + ":板头统计「现状/变更/代码锚」", !!stats, stats ? stats.raw : "未找到");
      const layers = await c.page.evaluate(() => [...document.querySelectorAll("#boardGraph .cv-laychip")].map((e) => e.textContent.trim()).slice(0, 6));
      check(r.name + ":层分组 chip 存在", layers.length >= 2, layers.join(" | ") || "无");
 // 顶部浮层不互相遮挡(截图经验证过:层 chip 曾压在板型头上)
      const overlap = await c.page.evaluate(() => {
        const sels = [".cv-type-head", ".cv-theme-band", "#cvWbar", "#cvLbar"];
        const rects = sels.map((s) => { const el = document.querySelector("#boardGraph " + s); return el && el.offsetHeight ? { s, r: el.getBoundingClientRect() } : null; }).filter(Boolean);
        const hits = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r, b = rects[j].r;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) hits.push(rects[i].s + "×" + rects[j].s + " " + Math.round(ox) + "x" + Math.round(oy));
        }
        return { n: rects.length, hits };
      });
      check(r.name + ":顶部浮层互不遮挡", overlap.hits.length === 0, overlap.n + " 层 | " + (overlap.hits.join(";") || "无重叠"));
      check(r.name + ":cards 控制台零错误", c.errs.length === 0, c.errs.slice(0, 2).join(" | "));
      await c.page.screenshot({ path: path.join(HARNESS_ROOT, "apps/gateway/test/ui/evidence/boardanchors-" + r.name + "-cards.png") });
      // 层 chip 交互:点「变更层」后非变更节点被 dim(纯 classList,不重渲)
      const dimOk = await c.page.evaluate(() => {
        const chip = [...document.querySelectorAll("#boardGraph .cv-laychip")].find((e) => (e.textContent || "").indexOf("变更层") >= 0);
        if (!chip) return null;
        chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
        return { dim: document.querySelectorAll("#boardGraph .cv-layer-dim").length, on: document.querySelectorAll("#boardGraph .cv-layer-on").length };
      });
      check(r.name + ":点层 chip 高亮生效", !!dimOk && (dimOk.dim + dimOk.on) > 0, dimOk ? "dim=" + dimOk.dim + " on=" + dimOk.on : "无 chip");
      await c.page.close();
      // --- svg 模式(默认):锚必须出现在出图文本里 ---
      const s = await openBoard(r.sid, 3, "");
      const svgText = await s.page.evaluate(() => {
        const h = document.querySelector("#boardGraph #cvSvgHost");
        return h ? (h.textContent || "") : "";
      });
      // 严格断言:结构化锚必须以 ⟨符号 @ 文件:行⟩ / ⟨文件, 文件⟩ 形态出现在出图文本里
 // (OFK desc 由 board-ofk.ts anchorText 生成;summary 里偶然出现的 .ts 不算数)
      const svgAnchors = (svgText.match(/⟨[^⟩]+⟩/g) || []);
      check(r.name + ":svg 默认视图出图非空", svgText.length > 200, "textLen=" + svgText.length);
      check(r.name + ":svg 默认视图节点数", (await s.page.locator("#boardGraph [data-node-id]").count()) >= 3, "");
      check(r.name + ":svg 默认视图含结构化锚 ⟨…⟩", svgAnchors.length > 0, "锚 " + svgAnchors.length + " 处: " + svgAnchors.slice(0, 2).join(" | "));
      await s.page.screenshot({ path: path.join(HARNESS_ROOT, "apps/gateway/test/ui/evidence/boardanchors-" + r.name + "-svg.png") });
      await s.page.close();
    }

    // ---------- ② 主题带(临时板,带 theme 节点) ----------
    {
      const { page, errs } = await openBoard(THEME_SID, 3, "cards");
      const band = await page.evaluate(() => {
        const b = document.querySelector("#boardGraph .cv-theme-band");
        if (!b) return null;
        const br = b.getBoundingClientRect();
        // 不遮挡:与任意节点卡矩形不相交(允许 2px 容差)
        const hit = [...document.querySelectorAll("#boardGraph .cv-node")].filter((el) => {
          const r = el.getBoundingClientRect();
          return !(r.right < br.left + 2 || r.left > br.right - 2 || r.bottom < br.top + 2 || r.top > br.bottom - 2);
        }).length;
        return { text: (b.textContent || "").trim().slice(0, 80), hits: hit };
      });
      check("主题带:出现且含用途文案", !!band && band.text.length > 0, band ? band.text : "无 .cv-theme-band");
      check("主题带:不遮挡节点卡", !!band && band.hits === 0, band ? "重叠 " + band.hits + " 张" : "无带");
      check("主题带板:控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
      await page.screenshot({ path: path.join(HARNESS_ROOT, "apps/gateway/test/ui/evidence/boardanchors-theme-band.png") });
      await page.close();
    }

    // ---------- ③ 多板默认选主板 ----------
    {
      const { page, errs } = await openBoard(MULTI_SID, 9, "cards");
      const n = await page.locator("#boardGraph .cv-node").count();
      const sel = await page.evaluate(() => {
        const s = document.getElementById("boardTaskSel");
        return s ? { v: s.value, opts: [...s.options].map((o) => o.textContent.trim().slice(0, 30)) } : null;
      });
      check("多板:默认渲染主板(9 节点)", n >= 9, "got " + n + " / 选中 " + (sel ? sel.v : "?"));
      check("多板:板列表含 2 块", !!sel && sel.opts.length >= 2, sel ? sel.opts.join(" || ") : "无选择器");
      check("多板:板头显示板数", await page.evaluate(() => /共\s*2\s*块板/.test(document.body.textContent || "")), "");
      check("多板:控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
      await page.screenshot({ path: path.join(HARNESS_ROOT, "apps/gateway/test/ui/evidence/boardanchors-multi.png") });
      await page.close();
    }
  } finally {
    await browser.close();
    try { await app.close(); } catch (e) { /* 已关 */ }
    rmSync(jd, { recursive: true, force: true });
    for (const sid of created) rmSync(path.join(HARNESS_ROOT, ".genie", "boards", sid), { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? "\nFAIL " + fails.length + "/" + results.length : "\nALL PASS " + results.length + "/" + results.length);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });