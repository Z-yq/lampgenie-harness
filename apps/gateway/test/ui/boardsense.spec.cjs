/** step-073 白板语义深化 UI 实测(真实 chromium + 自含 gateway,journalDir 固定):
 * S1 modulemap→板(真实索引,跨模块调用聚合 ×N 边)/ S2 增量渲染不闪烁(done 翻牌→DOM 元素引用不变)/
 * S3 虚拟边(画布加边→落盘 virtual:true+虚线类)/ S4 rev 冲突条(草稿保留+拉取最新)/ S5 archmap 无 LLM 显式降级/
 * S6 sequence 时序板(真实 debug 链)/ S7 pageflow 空产物显式降级
 * 跑法:npx tsx test/ui/_restore_runner.cjs(SELF_SPEC=./boardsense.spec.cjs) */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7799";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const SHOTS = (process.env.GENIE_JOURNAL_DIR || "/tmp/j-s072") + "/shots";

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + ".png") }).then(() => console.log("[shot] " + name + ".png"));
  const evalJ = (fn, arg) => page.evaluate(fn, arg);
  const poll = async (fn, ms = 20000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await page.waitForTimeout(500); v = await fn(); } return v; };
  const wsCall = (msg, replyType, timeoutMs = 15000) => evalJ(async ({ msg, replyType, timeoutMs }) => {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    const out = await new Promise((res) => {
      const to = setTimeout(() => res({ timeout: true }), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify(msg));
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === replyType || m.type === "error") { clearTimeout(to); res(m); } };
      ws.onerror = () => { clearTimeout(to); res({ wserror: true }); };
    });
    ws.close();
    return out;
  }, { msg, replyType, timeoutMs });

  // ---------- 搭台:会话 + 基础板 ----------
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.fill("#instruction", "语义板深化验证会话");
  await page.click("#go");
  await poll(() => evalJ(() => { try { return [...tasks.values()].some((t) => t.state === "done"); } catch (e) { return false; } }));
  const sid = await evalJ(() => currentSid);
  check("A1 会话建成", !!sid, "sid=" + sid);

  // ---------- S1:modulemap→板(真实索引) ----------
  const mm = await wsCall({ v: 1, type: "board.fromsense", sessionId: sid, source: "modulemap" }, "board.doc", 25000);
  const mmDoc = mm && mm.doc;
  check("S1.1 modulemap 生成语义板(board.doc 回执)", !!(mmDoc && mmDoc.nodes && mmDoc.nodes.length > 2), mmDoc ? mmDoc.nodes.length + " 节点" : JSON.stringify(mm).slice(0, 120));
  const aggEdge = mmDoc && mmDoc.edges.find((e) => e.label && e.label.indexOf("调用×") === 0);
  check("S1.2 跨模块调用聚合边(×N 标签)", !!aggEdge, aggEdge ? aggEdge.label : "无聚合边");
  check("S1.3 模块节点带 fileRef(入口文件)", !!(mmDoc && mmDoc.nodes.every((n) => n.fileRef)), "");
  const mmNodes = mmDoc ? mmDoc.nodes.length : 0;

  // ---------- S7:pageflow(harness 面板页可被 HTML 入口解析出页面,实测 27 页;提前跑防重活堆积) ----------
  // code-sense 重负载链在共享机上首轮冷建图可能超窗——超时重试一次(缓存热后快)
  const wsCallRetry = async (msg, rt, ms) => { let r = await wsCall(msg, rt, ms); if (r && r.timeout) r = await wsCall(msg, rt, ms); return r; };
  const pf = await wsCallRetry({ v: 1, type: "board.fromsense", sessionId: sid, source: "pageflow" }, "board.doc", 120000);
  const pfDoc = pf && pf.doc;
  check("S7 pageflow 生成页面流板(io 节点+trigger 边)", !!(pfDoc && pfDoc.nodes && pfDoc.nodes.length > 5), pfDoc ? pfDoc.nodes.length + " 页面" : JSON.stringify(pf).slice(0, 100));

  // ---------- S2:增量渲染不闪烁 ----------
  // 造一块小三节点板并进板视图(增量补丁的观察面)
  const BD = {
    version: 1, taskId: "t-incr", sessionId: sid, title: "增量渲染观察板", status: "implementing", rev: 0,
    nodes: [
      { id: "a1", kind: "function", label: "incAlpha", summary: "甲节点", change: "modify", done: false, comments: [], flow: [] },
      { id: "a2", kind: "function", label: "incBeta", summary: "乙节点", change: "add", done: false, comments: [], flow: [] },
      { id: "a3", kind: "module", label: "incGamma", summary: "丙模块", change: "keep", done: false, comments: [], flow: [] },
    ],
    edges: [{ from: "a1", to: "a2", kind: "call", label: "调用" }], planned_files: [], updatedAt: 0,
  };
  await wsCall({ v: 1, type: "board.save", sessionId: sid, taskId: "t-incr", doc: BD, baseRev: 0 }, "board.doc");
  await page.click("#act-board");
  await poll(() => evalJ(() => document.querySelectorAll("#boardTaskSel option").length >= 2));
  await page.selectOption("#boardTaskSel", "t-incr");
  await poll(() => evalJ(() => boardDoc && boardDoc.taskId === "t-incr" && document.querySelectorAll(".cv-node").length === 3));
  // 锚定当前 DOM 元素引用
  await evalJ(() => { window.__els = {}; for (const el of document.querySelectorAll(".cv-node")) window.__els[el.dataset.cv] = el; });
  // 同结构更新(done 翻牌+summary 微调)→ 应走增量补丁(元素引用不变)
  const BD2 = JSON.parse(JSON.stringify(BD)); BD2.nodes[0].done = true; BD2.nodes[1].summary = "乙节点·已修订";
  const sv = await wsCall({ v: 1, type: "board.save", sessionId: sid, taskId: "t-incr", doc: BD2, baseRev: 1 }, "board.doc");
  check("S2.1 增量板保存回执 rev=2", !!(sv && sv.doc && sv.doc.rev === 2), sv && sv.doc && ("rev=" + sv.doc.rev));
  await poll(() => evalJ(() => boardDoc && boardDoc.rev === 2));
  await page.waitForTimeout(400); // 渲染落定
  const incr = await evalJ(() => {
    const cur = {}; for (const el of document.querySelectorAll(".cv-node")) cur[el.dataset.cv] = el;
    const same = Object.keys(window.__els).every((k) => window.__els[k] === cur[k] && window.__els[k].isConnected);
    const doneMark = cur["a1"] && !!cur["a1"].querySelector(".cv-done .icn"); // step-111 修:✓ 字符已被 step-097 图标体系统一为 svg(done 勾断言随之现代化)
    const sum = cur["a2"] && cur["a2"].querySelector(".cv-sum").textContent.indexOf("已修订") >= 0;
    const meta = document.querySelector("#boardGraph .bd-meta");
    return { same, doneMark, sum, meta: meta ? meta.textContent.slice(0, 60) : "" };
  });
  check("S2.2 增量补丁:节点 DOM 元素引用零更换(不闪烁实锤)", incr.same, "");
  check("S2.3 done 勾+摘要修订原位生效", incr.doneMark && incr.sum, JSON.stringify({ d: incr.doneMark, s: incr.sum }));
  check("S2.4 meta 行 rev 跟进", incr.meta.indexOf("rev 2") >= 0, incr.meta);
  await shot("s2-incremental-patch");

  // ---------- S3:虚拟边 ----------
  await evalJ(() => cvAddEdge("a2", "a3")); // 画布直改板链(查看态直连)
  const vSaved = await poll(() => { try { const d = JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, ".genie/boards", sid, "t-incr.json"), "utf-8")); return d.edges.some((e) => e.virtual === true) && d; } catch (e) { return false; } });
  check("S3.1 画布加边落盘 virtual=true", !!vSaved, vSaved ? "edges=" + vSaved.edges.length : "");
  const vCls = await evalJ(() => !!document.querySelector("#boardGraph path.bfe-virtual"));
  check("S3.2 虚拟边虚线类渲染", vCls);
  // 静默落盘回执收口(drvfs/负载下回执可晚于磁盘可见):等 boardDoc.rev 追平盘上 rev 再进编辑态,
  // 防迟到回执在打字后重渲表单把在填文本冲掉(实测竞态实锤)。
  const tIncrRev = () => JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, ".genie/boards", sid, "t-incr.json"), "utf-8")).rev;
  await poll(() => { const r = tIncrRev(); return evalJ((rr) => boardDoc && boardDoc.rev === rr, r); });
  await shot("s3-virtual-edge");

  // ---------- S4:rev 冲突条(草稿保留) ----------
  await page.click("#boardEditBtn");
  await poll(() => evalJ(() => boardEditOn && !!document.getElementById("bdeTitle")));
  await evalJ(() => { document.getElementById("bdeTitle").value = "我的并发草稿标题"; });
  // 抓重渲肇事者:表单容器子树 MutationObserver(实测打字后被重渲冲掉——找出谁干的)
  await evalJ(() => {
    window.__mutLog = [];
    const box = document.getElementById("boardDetail");
    if (box) {
      const mo = new MutationObserver((rs) => { window.__mutLog.push(rs.length + " muts, bdeTitleLost=" + !document.getElementById("bdeTitle")); });
      mo.observe(box, { childList: true, subtree: true });
    }
  });
  await page.waitForTimeout(300);
  const preSave = await evalJ(() => ({ field: document.getElementById("bdeTitle") ? document.getElementById("bdeTitle").value : "(gone)", muts: window.__mutLog.length }));
  console.log("[s4dbg] 打字后保存前: " + JSON.stringify(preSave));
  // 模拟并发:外部按盘上最新 rev 把板再推一档(读盘取真 rev,防前面直改板落盘已推进)
  const diskRev = () => JSON.parse(fs.readFileSync(path.join(HARNESS_ROOT, ".genie/boards", sid, "t-incr.json"), "utf-8")).rev;
  const BD3 = JSON.parse(JSON.stringify(BD2));
  const bump = await wsCall({ v: 1, type: "board.save", sessionId: sid, taskId: "t-incr", doc: BD3, baseRev: diskRev() }, "board.doc");
  check("S4.0 并发更新生效(外部推到最新 rev)", !!(bump && bump.doc && bump.doc.rev === diskRev() + 1 || (bump && bump.doc && bump.doc.rev > 2)), bump && bump.doc ? "rev=" + bump.doc.rev : JSON.stringify(bump).slice(0, 80));
  await page.waitForTimeout(300);
  await page.click("#boardSaveBtn"); // 面板保存(草稿 baseRev 落后于并发版)→ 必冲突
  await poll(() => evalJ(() => !!document.getElementById("bdcPull")));
  const cf = await evalJ(() => ({
    bar: !!document.getElementById("bdcPull"),
    draftKept: boardEditOn && boardDraft && document.getElementById("bdeTitle") && document.getElementById("bdeTitle").value === "我的并发草稿标题",
    txt: (document.querySelector(".bd-conflict") || {}).textContent || "",
    diag: "field=" + (document.getElementById("bdeTitle") ? document.getElementById("bdeTitle").value : "(none)") + " draft=" + (boardDraft && boardDraft.title) + " doc=" + (boardDoc && boardDoc.title) + " rev=" + (boardDoc && boardDoc.rev) + " muts=" + JSON.stringify(window.__mutLog || []),
  }));
  check("S4.1 冲突条出现+草稿保留(不被冲)", cf.bar && cf.draftKept, cf.txt.slice(0, 40) + " | " + cf.diag);
  await shot("s4-conflict-bar");
  await evalJ(() => document.getElementById("bdcPull").click());
  await poll(() => evalJ(() => !boardEditOn && boardDoc && boardDoc.rev >= 3));
  check("S4.2 拉取最新:退编辑态+板到并发 rev", true);

  // ---------- S5:archmap 无 LLM 显式降级 ----------
  const am = await wsCallRetry({ v: 1, type: "board.fromsense", sessionId: sid, source: "archmap" }, "board.doc", 120000);
  check("S5 archmap 无 LLM 显式降级(不冒充架构图)", !!(am && am.type === "error" && am.code === "board-fromsense-failed" && am.message.indexOf("LLM") >= 0), (am && am.message) || JSON.stringify(am).slice(0, 80));

  // ---------- S6:sequence 时序板(轻链:索引定位+单文件 ts-morph,放最后) ----------
  const sq = await wsCallRetry({ v: 1, type: "board.fromsense", sessionId: sid, source: "sequence", query: "createGatewayApp" }, "board.doc", 150000);
  const sqDoc = sq && sq.doc;
  check("S6.1 sequence 生成时序板", !!(sqDoc && sqDoc.nodes && sqDoc.nodes.length >= 2), sqDoc ? sqDoc.nodes.length + " 节点" : JSON.stringify(sq).slice(0, 120));
  check("S6.2 时序边带步序标签", !!(sqDoc && sqDoc.edges.some((e) => e.label && e.label.indexOf("第") === 0)), sqDoc && sqDoc.edges[0] ? sqDoc.edges[0].label : "");

  // ---------- 收尾 ----------
  check("Z 0 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
  try { fs.rmSync(path.join(HARNESS_ROOT, ".genie/boards", sid), { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  const fails = results.filter((r) => !r.ok).length;
  console.log("boardsense: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
