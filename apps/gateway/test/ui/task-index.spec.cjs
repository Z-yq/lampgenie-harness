/** UI 经验证(协议瘦身验收):WS 任务协议「索引 + 按需详情 + 增量」改造后,
 *  四个消费面不回归——真实 gateway + 真实 chromium,零桩:
 *  A 侧栏:hello/task.list/task.changed 只带 TaskIndex,但 title 必须派生到位(多行任务书取首行);
 *  B 任务头:running 帧带 startedAt / 终态帧带 updatedAt+state(增量合并,不是重拉全量);
 *  C 终态失败面(按需拉正文主战场):失败 chip tooltip 的 result、重试回填的 instruction 都只能
 *    经 task.detail.get 拿到 —— 且同一 taskId 只发一次(幂等);
 *  D 体量面:全场 task.list ≤ 3 次、无重复 task.detail.get(增量推送没有退化成轮询/全量重拉)。
 * 观测手段:goto 之前 page.addInitScript 给 WebSocket.prototype.send 打补丁,把客户端发出的每条
 * 消息登记进 window.__sent;同时包裹 HTMLTextAreaElement.value 的 setter,记录 #instruction 被
 * 程序化回填过的完整文本(window.__instrLog)——面板的重试路径「回填后立即 submit」会把输入框清空,
 * 只看点击后的 value 永远读到空串,故以「曾经回填的逐字全文」+「发出帧的 instruction 逐字全文」双证。
 * 失败任务不经执行器:直接 TaskSupervisor.inject 一条 failed 终态任务(带 result 正文),页面初始
 * hello 只拿到索引(无 result),result 必须由 task.detail.get 现取——正是 C 组要验的链路。 */
process.env.GENIE_CHECKPOINT = process.env.GENIE_CHECKPOINT || "off"; // 与 rowops 同款:本 spec 不测 checkpoint
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { EchoChildBackend } = require("@lampgenie/executors");

const PORT = Number(process.env.SELF_PORT || 7753);

(async () => {
  const RUN = "r" + Date.now().toString(36).slice(-5);
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  const app = createGatewayApp({ useExternalHttp: true, executor: new EchoChildBackend() });

  // ---- C 组素材:服务端直接造一条 failed 终态任务(不进执行器,终态/正文完全确定) ----
  const SID_FAIL = "sid-fail-" + RUN;
  const FAIL_ID = randomUUID();
  const FAIL_INSTR = "失败任务书-" + RUN + ":请重试这条任务时原样回填全部正文(任何截断都会让断言失败)——补充长文用于区分索引 title 与正文:" + "内容".repeat(30);
  const FAIL_RESULT = "失败原因全文-" + RUN;
  app.taskManager.inject({
    id: FAIL_ID,
    sessionId: SID_FAIL,
    instruction: FAIL_INSTR,
    state: "failed",
    result: FAIL_RESULT,
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    title: FAIL_INSTR.slice(0, 40),
  });

  servePanel(PORT, (srv) => app.attachWs(srv));
  // 就绪轮询(src 整图 dev 编译冷启动可达数十秒,固定等待会导航超时)
  {
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try { const r = await fetch("http://127.0.0.1:" + PORT + "/"); ready = r.ok; } catch { /* 未就绪 */ }
      if (!ready) await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) { console.error("网关 60s 未就绪"); process.exit(2); }
  }

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) pageErrors.push(m.text().slice(0, 150)); });
  // 出站消息登记 + 输入框程序化回填登记(必须在页面脚本执行前)
  await page.addInitScript(() => {
    window.__sent = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const m = JSON.parse(typeof data === "string" ? data : String(data));
        if (m && m.type) window.__sent.push({ type: m.type, taskId: m.taskId, instruction: typeof m.instruction === "string" ? m.instruction : undefined });
      } catch (e) { /* 非 JSON 帧忽略 */ }
      return origSend.apply(this, arguments);
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
      configurable: true,
      get: desc.get,
      set(v) {
        try { if (this.id === "instruction" && typeof v === "string" && v) (window.__instrLog = window.__instrLog || []).push(v); } catch (e) { /* 记录失败不影响功能 */ }
        return desc.set.call(this, v);
      },
    });
  });

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));

  // 终态谓词:按标题命中(索引化后 instruction 只在 task.submitted 带全文,title 恒在场)
  const waitTitleState = (name, ms = 30_000) => page.waitForFunction(
    (n) => { try { return [...tasks.values()].some((t) => String(t.title || "").includes(n) && (t.state === "done" || t.state === "failed")); } catch (e) { return false; } },
    name, { timeout: ms, polling: 300 },
  );
  const pollBool = async (fn, arg, ms) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 50 }); return true; } catch (e) { return false; } };

  // ================= A. 侧栏(索引标题) =================
  const A_TITLE = "侧栏标题" + RUN;
  const A_FILLER = Array.from({ length: 6 }, (_, i) => "第" + (i + 2) + "行:这是一段很长的任务书正文,验证索引帧只带 title、正文按需获取,填充 " + "冗".repeat(45)).join("\n");
  const A_INSTR = A_TITLE + "\n" + A_FILLER;
  if (A_INSTR.length <= 400) throw new Error("A 组任务书长度不足 400 字符:" + A_INSTR.length);
  await page.fill("#instruction", A_INSTR);
  await page.click("#go");
  await waitTitleState(A_TITLE);
  await page.waitForTimeout(400);

  const aRows = page.locator("#taskList .t-row", { hasText: A_TITLE });
  const aRowCount = await aRows.count();
  check("A1 侧栏行文本含派生标题", aRowCount >= 1, "len=" + A_INSTR.length + " rows=" + aRowCount);
  const aTitleAttr = aRowCount ? String((await aRows.first().getAttribute("title")) || "") : "";
  check("A2 行 title 属性非空且不含 undefined", aTitleAttr.trim().length > 0 && !aTitleAttr.includes("undefined"), aTitleAttr.slice(0, 50));
  const aBody = await page.evaluate((n) => {
    const t = [...tasks.values()].find((x) => String(x.title || "").includes(n));
    return { hasInstr: !!t && typeof t.instruction === "string", title: t && t.title, state: t && t.state };
  }, A_TITLE);
  check("A3 索引帧未冲掉正文(task.submitted 带入)", aBody.hasInstr === true, "hasInstr=" + aBody.hasInstr + " state=" + aBody.state);

  // ================= B. 任务头(运行态/终态标量) =================
  const B_TITLE = "短任务乙" + RUN;
  await page.fill("#instruction", B_TITLE);
  await page.click("#go");
  // running 帧必须带 startedAt(索引白名单里有它,否则「已工作 X」永久缺省)
  const bStarted = await pollBool((n) => {
    const t = [...tasks.values()].find((x) => String(x.title || "").includes(n));
    return !!t && typeof t.startedAt === "number";
  }, B_TITLE, 8000);
  const bSub = await pollBool(() => {
    const el = Array.from(document.querySelectorAll("#chatBody .task-sub")).find((x) => /已工作|运行中/.test(x.textContent || ""));
    return !!el;
  }, null, 8000);
  const bSubText = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#chatBody .task-sub")).find((x) => /已工作|运行中/.test(x.textContent || ""));
    return el ? String(el.textContent).trim().slice(0, 60) : "";
  });
  check("B1 运行中行(.task-sub)存在且含已工作/运行中", bSub && bStarted, "sub=" + bSub + " startedAt=" + bStarted + " txt=" + bSubText);
  await waitTitleState(B_TITLE);
  await page.waitForTimeout(400);
  const bFinal = await page.evaluate((n) => [...tasks.values()].filter((x) => String(x.title || "").includes(n)).map((x) => ({ state: x.state, updatedAt: typeof x.updatedAt, startedAt: typeof x.startedAt })), B_TITLE);
  const bOk = bFinal.length > 0 && bFinal.every((x) => x.updatedAt === "number" && ["done", "failed", "cancelled"].includes(x.state));
  check("B2 终态合并成立(updatedAt 为 number / state 为终态)", bOk, JSON.stringify(bFinal));

  // ================= C. 终态失败面(按需拉正文) =================
  await page.evaluate((sid) => openSession(sid), SID_FAIL);
  const cChip = await pollBool(() => !!document.getElementById("errChip"), null, 15_000);
  check("C1 失败 chip 出现(#errChip)", cChip, "");
  let chipTitle = "";
  {
    const deadline = Date.now() + 3000; // task.detail.result 回来后需重渲染:3s 轮询窗口
    while (Date.now() < deadline) {
      chipTitle = String((await page.locator("#errChip").getAttribute("title").catch(() => "")) || "");
      if (chipTitle.includes(FAIL_RESULT)) break;
      await page.waitForTimeout(150);
    }
  }
  check("C2 chip title 含失败原因全文(detail.result 已渲染)", chipTitle.includes(FAIL_RESULT), chipTitle.slice(0, 60));
  const detailGets = await page.evaluate((id) => (window.__sent || []).filter((m) => m.type === "task.detail.get" && m.taskId === id).length, FAIL_ID);
  check("C3 同一 taskId 的 task.detail.get 恰好 1 次(幂等)", detailGets === 1, "count=" + detailGets);

  const retryBtn = page.locator(".err-banner button[data-act=retry]").first();
  const hasRetry = (await retryBtn.count()) >= 1;
  if (hasRetry) { await retryBtn.scrollIntoViewIfNeeded().catch(() => {}); await retryBtn.click({ force: true }).catch(() => {}); }
  await page.waitForFunction((full) => (window.__instrLog || []).includes(full), FAIL_INSTR, { timeout: 5000 }).catch(() => {});
  const cFill = await page.evaluate((full) => ({
    logged: (window.__instrLog || []).includes(full),
    submitted: (window.__sent || []).some((m) => m.type === "task.submit" && m.instruction === full),
    inputNow: String((document.getElementById("instruction") || {}).value || ""),
  }), FAIL_INSTR);
  check("C4 重试回填逐字全文(withTaskDetail 拿到正文)", hasRetry && cFill.logged && cFill.submitted, "retryBtn=" + hasRetry + " logged=" + cFill.logged + " submitted=" + cFill.submitted + " inputNow=" + (cFill.inputNow ? "有值" : "空(提交后清空)"));

  // ================= D. 增量不重拉(体量面) =================
  await page.waitForTimeout(600);
  const dSent = await page.evaluate(() => window.__sent || []);
  const listCount = dSent.filter((m) => m.type === "task.list").length;
  const detailIds = dSent.filter((m) => m.type === "task.detail.get").map((m) => m.taskId);
  const dupIds = detailIds.filter((id, i) => detailIds.indexOf(id) !== i);
  check("D1 task.list 次数 ≤3(不全量重拉列表)", listCount <= 3, "count=" + listCount);
  check("D2 无重复 task.detail.get", dupIds.length === 0, "ids=" + detailIds.length + " dup=" + JSON.stringify([...new Set(dupIds)]));

  check("页面无 JS 错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

  const failures = results.filter((r) => !r.ok);
  console.log("\n==== 汇总 " + RUN + ":" + (results.length - failures.length) + "/" + results.length + " PASS ====");
  for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name);
  await browser.close();
  await app.close();
  process.exit(failures.length ? 1 : 0);
})();