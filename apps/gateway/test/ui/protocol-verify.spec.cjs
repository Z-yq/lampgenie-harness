/** 真实浏览器面板验收(step-1036:任务协议索引化 + session.status 增量化改造后的三面回归)。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs --opts ./test/ui/_protocol-verify.opts.cjs test/ui/protocol-verify.spec.cjs
 * 纯界面操作取证(不读服务端实现判行为);必检四组:
 *  ① 侧栏会话/任务行标题非空、非 "undefined"、非空串(= TaskIndex.title 生效);
 *  ② 打开会话后任务头/状态条文本非空且无 undefined/NaN,chip 不出现 undefined;
 *  ③ 终态(done/failed)结果文本区有内容(不是空白/undefined)= task.detail.get 按需拉正文生效;
 *  ④ console 无 session.status 相关报错。
 * 附加诊断(非任务书必检,如实记录):本页发出的 session.status 是否带 sinceSeq(= 增量化握手),
 * 以及回包 session.status.result 是否带 sessionId(水位键的依赖)。
 * 证据截图落 tasks/step-1036-session-status-incremental/evidence/(EV_DIR 可覆盖)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7721";
const SID = "proto-verify-sess";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const EV_DIR = process.env.EV_DIR || path.join(HARNESS_ROOT, "tasks/step-1036-session-status-incremental/evidence");
const FINAL = "协议验收终态:本任务以失败收尾,正文由 task.detail.get 按需取回。";
const TASK_TITLE = "协议验收:索引化标题面";

(async () => {
  fs.mkdirSync(EV_DIR, { recursive: true });
  const app = globalThis.__selfhostApp;
  if (!app) { console.error("SPEC CRASH: __selfhostApp 缺席(必须经 _ui_selfhost.cjs 跑)"); process.exit(1); }
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  // WS 双向留痕:出站记 type/sinceSeq/sessionId;入站记 type 与是否带 sessionId(诊断用)。
  await page.addInitScript(() => {
    window.__wsSent = []; window.__wsRecv = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(data); if (m && m.type) window.__wsSent.push({ type: m.type, sinceSeq: m.sinceSeq, sessionId: m.sessionId }); } catch (e) { /* 非 JSON */ }
      return send.call(this, data);
    };
    const add = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (ev, fn, ...rest) {
      if (ev === "message") {
        const wrap = function (e) {
          try {
            const m = JSON.parse(e.data);
            if (m && m.type === "session.status.result") {
              const tk = m.status && m.status.task;
              // 索引化取证:状态帧里的 task 只应是索引(无 instruction/result 全文)
              window.__wsRecv.push({
                type: m.type, hasSessionId: typeof m.sessionId === "string", seq: m.status && m.status.seq,
                taskKeys: tk ? Object.keys(tk) : null,
                taskHasFullText: !!(tk && (tk.result || tk.instruction)),
              });
            }
          } catch (err) { /* 非 JSON */ }
          return fn.apply(this, arguments);
        };
        return add.call(this, ev, wrap, ...rest);
      }
      return add.call(this, ev, fn, ...rest);
    };
    // 面板用 ws.onmessage = fn(属性赋值),不经过 addEventListener——包一层属性 setter 才能留痕。
    const recvPush = (data) => {
      try {
        const m = JSON.parse(data);
        if (m && m.type === "session.status.result") {
          const tk = m.status && m.status.task;
          window.__wsRecv.push({
            type: m.type, hasSessionId: typeof m.sessionId === "string", seq: m.status && m.status.seq,
            taskKeys: tk ? Object.keys(tk) : null,
            taskHasFullText: !!(tk && (tk.result || tk.instruction)),
          });
        }
      } catch (err) { /* 非 JSON */ }
    };
    const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true, enumerable: true,
      get() { return d && d.get ? d.get.call(this) : this.__onmsg; },
      set(fn) {
        const wrapped = typeof fn === "function" ? function (e) { try { recvPush(e && e.data); } catch (x) { /* 留痕失败不影响面板 */ } return fn.apply(this, arguments); } : fn;
        this.__onmsg = fn;
        if (d && d.set) d.set.call(this, wrapped); else this.__onmsgWrapped = wrapped;
      },
    });
  });
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 300) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (file) => { await page.screenshot({ path: path.join(EV_DIR, file) }); console.log("[shot] " + file); };
  const poll = async (fn, ms = 15000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await sleep(400); v = await fn(); } return v; };

  await page.addInitScript(() => { try { localStorage.setItem("zh:g-search", "off"); localStorage.setItem("zh:g-term", "off"); } catch (e) {} });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 20000 }).catch(() => {});
  await sleep(800);

  // ── 数据源:会话事件走 journal 注入;任务走 app.taskManager.submit(真 TaskSupervisor 派生标题路径)──
  app.journal.append({ kind: "message.user", sessionId: SID, payload: { text: "协议验收:请核对索引化改造后的三面渲染" } });
  app.journal.append({ kind: "todo.updated", sessionId: SID, payload: { items: [
    { content: "核对侧栏标题", status: "completed" }, { content: "核对状态条 chip", status: "in_progress" },
  ] } });
  app.journal.append({ kind: "message.agent", sessionId: SID, payload: { text: "开始核对索引化改造三面。" } });
  const task = app.taskManager.submit("user", SID, TASK_TITLE + "(任务书正文,不进列表帧)");
  const taskId = task.id;
  const terminal = await poll(() => { const t = app.taskManager.get(taskId); return t && (t.state === "done" || t.state === "failed") ? t : null; }, 20000);
  check("前置:任务进终态(failed)", !!terminal && terminal.state === "failed", "state=" + (terminal && terminal.state) + " taskId=" + taskId);

  // ── 面① 侧栏:任务行出现且标题非空/非 undefined(取 TaskIndex.title)──
  await page.evaluate(() => { newDraft(); });
  await page.waitForTimeout(600);
  const row = await poll(async () => page.evaluate((sid) => {
    const el = document.querySelector('.t-row[data-sid="' + sid + '"] .t-title');
    return el ? { text: el.textContent, title: el.parentElement.getAttribute("title") } : null;
  }, SID).catch(() => null));
  const sideTitle = row ? String(row.text || "") : "";
  check("①侧栏任务行存在", !!row, row ? JSON.stringify(row) : "未渲染出 .t-row[data-sid=" + SID + "]");
  check("①侧栏标题非空/非 undefined/非空串", sideTitle.trim().length > 0 && sideTitle.trim() !== "undefined" && sideTitle.trim() !== "null", "实际标题=" + JSON.stringify(sideTitle));
  await shot("protocol-01-sidebar.png");
  await page.locator('.t-row[data-sid="' + SID + '"]').first().screenshot({ path: path.join(EV_DIR, "protocol-01b-sidebar-row.png") }).then(() => console.log("[shot] protocol-01b-sidebar-row.png")).catch(() => {});

  // ── 打开该会话(真实点击侧栏行)──
  await page.evaluate((sid) => { const r = document.querySelector('.t-row[data-sid="' + sid + '"]'); if (r) r.click(); }, SID);
  const opened = await poll(async () => page.evaluate(() => !!histEvents && histEvents.length >= 3));
  check("前置:会话打开并回放事件", !!opened);

  // ── 面② 任务头/状态条:文本非空、无 undefined/NaN,chip 有内容且无 undefined ──
  const barOf = () => page.evaluate(() => {
    const el = document.getElementById("chatStatusbar");
    const t = el ? (el.innerText || "") : "";
    return { text: t.replace(/\s+/g, " ").trim(), chips: [...(el ? el.querySelectorAll(".st-chip") : [])].map((x) => x.textContent.replace(/\s+/g, " ").trim()) };
  });
  const bar = await poll(async () => { const v = await barOf(); return v.chips.some((c) => /清单/.test(c)) ? v : null; }, 25000) || await barOf();
  check("②状态条 chip 非空", bar.chips.length > 0, "chips=" + JSON.stringify(bar.chips));
  check("②状态条 chip 无 undefined", !bar.chips.some((c) => /undefined/.test(c)), "chips=" + JSON.stringify(bar.chips));
  check("②状态条文本无 undefined/NaN", !/undefined|NaN/.test(bar.text), "barText=" + JSON.stringify(bar.text));
  const head = await page.evaluate(() => ({
    tab: (document.querySelector("#wsTabbar") || {}).innerText || "",
    bar: (document.getElementById("chatStatusbar") || {}).innerText || "",
  }));
  const headText = (head.tab + " " + head.bar).replace(/\s+/g, " ").trim();
  check("②任务头呈现任务态(失败 + 任务id前8)", /失败/.test(headText) && headText.indexOf(taskId.slice(0, 8)) >= 0, "head=" + JSON.stringify(headText.slice(0, 160)));
  check("②任务头文本非空且无 undefined/NaN", headText.length > 0 && !/undefined|NaN/.test(headText), JSON.stringify(headText.slice(0, 160)));
  await shot("protocol-02-statusbar.png");
  await page.locator("#chatStatusbar").first().screenshot({ path: path.join(EV_DIR, "protocol-02b-statusbar.png") }).then(() => console.log("[shot] protocol-02b-statusbar.png")).catch(() => {});

  // ── 面③ 终态结果:滚到流尾,失败横幅 == task.detail.get 按需拉回的正文 ──
  await page.evaluate(() => { const vt = document.getElementById("view-tasks"); if (vt) vt.scrollTop = vt.scrollHeight; });
  const banner = await poll(async () => page.evaluate(() => {
    const b = document.querySelector(".err-banner");
    return b ? (b.innerText || "") : "";
  }));
  const bannerText = String(banner || "").replace(/\s+/g, " ").trim();
  check("③终态结果区非空(不是空白)", bannerText.length > 0, "banner=" + JSON.stringify(bannerText.slice(0, 200)));
  check("③终态结果非 undefined", bannerText.length > 0 && !/undefined|NaN/.test(bannerText), "banner=" + JSON.stringify(bannerText.slice(0, 200)));
  check("③正文经 task.detail.get 到位", bannerText.indexOf(FINAL.slice(0, 12)) >= 0, "banner=" + JSON.stringify(bannerText.slice(0, 200)));
  await shot("protocol-03-terminal.png");
  await page.locator(".err-banner").first().screenshot({ path: path.join(EV_DIR, "protocol-03b-terminal-banner.png") }).then(() => console.log("[shot] protocol-03b-terminal-banner.png")).catch(() => {});

  // ── 附加诊断:增量化握手(session.status 请求是否带 sinceSeq)+ 回包是否带 sessionId ──
  await sleep(3500); // 跨过一次 3s 轮询,保证「首拉之后」的请求也留痕
  const sent = await page.evaluate(() => (window.__wsSent || []).filter((m) => m.type === "session.status"));
  const recv = await page.evaluate(() => (window.__wsRecv || []));
  const ssProbe = await page.evaluate(() => {
    const out = {};
    try { out.ssSeqBySid = [...ssSeqBySid.entries()].map(([k, v]) => [String(k), v]); } catch (e) { out.ssSeqBySid = "ERR:" + e.message; }
    try { out.statusSeq = sessionStatus && sessionStatus.seq; } catch (e) { out.statusSeq = "ERR:" + e.message; }
    return out;
  });
  console.log("[diag] 出站 session.status=" + JSON.stringify(sent));
  console.log("[diag] 入站 session.status.result 共 " + recv.length + " 条,示例=" + JSON.stringify(recv.slice(0, 2)));
  console.log("[diag] 面板水位表=" + JSON.stringify(ssProbe));
  const withSeq = sent.filter((m) => typeof m.sinceSeq === "number");
  check("[诊断] 面板发出过带 sinceSeq 的 session.status(增量化握手)", withSeq.length > 0, "带 sinceSeq=" + withSeq.length + " / 共 " + sent.length);
  check("[诊断] 状态帧 task 为索引(无 instruction/result 全文)",
    recv.length > 0 && recv.some((r) => Array.isArray(r.taskKeys)) && !recv.some((r) => r.taskHasFullText),
    "taskKeys=" + JSON.stringify(recv[0] && recv[0].taskKeys) + " 带全文=" + recv.filter((r) => r.taskHasFullText).length);

  // ── 面④ console 报错 ──
  const ssErrors = consoleErrors.filter((e) => /session\.status/.test(e));
  check("④console 无 session.status 相关报错", ssErrors.length === 0, ssErrors.slice(0, 2).join(" | ") || "(0 条)");
  console.log("[console] 全部报错 " + consoleErrors.length + " 条:" + JSON.stringify(consoleErrors.slice(0, 4)));

  const required = results.filter((r) => !r.name.startsWith("[诊断]"));
  const fails = required.filter((r) => !r.ok);
  console.log("\n必检 " + (fails.length ? "FAIL " + fails.length : "ALL PASS") + " " + (required.length - fails.length) + "/" + required.length);
  console.log("[evidence] " + EV_DIR);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });