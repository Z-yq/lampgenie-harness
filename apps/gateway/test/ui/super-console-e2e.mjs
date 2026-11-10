/** step-1033 E2E:Super Agent 指挥台八场景(临时端口 + createGatewayApp 进程内装配;不动 7700)。
 * 运行:cd apps/gateway && node --import tsx test/ui/super-console-e2e.mjs
 * 产出:evidence/e2e-summary.json + 截图 evidence/e2e-panel.png
 */
process.env.GENIE_CHECKPOINT = "off";
process.env.GENIE_SESSION_WORKER = "off";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { createGatewayApp } from "../../src/app.ts";
import { servePanel } from "../../src/panel.ts";
import { buildLlmFromConfig } from "../../src/factory.ts";
import { repoRoot } from "../../src/repo-root.ts";
import { loadConfig } from "@lampgenie/core";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVID = join(HERE, "../../../../tasks/step-1033-superagent-chain/evidence");
mkdirSync(EVID, { recursive: true });
const results = [];
function rec(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${name} :: ${detail}`);
}
const out = (n, o) => writeFileSync(join(EVID, n), JSON.stringify(o, null, 2));

const jd = mkdtempSync(join(tmpdir(), "s1033-"));
const backend = { kind: "s1033-e2e", async spawn(spec) { return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} }; } };
// LLM 装配:E2E 必须真调 super.turn;失败时降级为桩(报告里如实标注)
let llm;
try {
  const cfg = loadConfig({ repoRoot: repoRoot() }).config;
  llm = buildLlmFromConfig(cfg, repoRoot());
} catch (e) {
  console.error("LLM 装配失败(将降级为桩):", String(e).slice(0, 160));
}
const app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd, ...(llm ? { llm } : {}) });
const port = 7743;
const srv = servePanel(port, (s) => app.attachWs(s));
await new Promise((r) => setTimeout(r, 500));

const inbox = [];
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const waiters = [];
ws.on("message", (buf) => {
  let m; try { m = JSON.parse(String(buf)); } catch { return; }
  inbox.push(m);
  for (const w of [...waiters]) if (w.type === m.type || (w.pred && w.pred(m))) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
});
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const send = (m) => ws.send(JSON.stringify({ v: 1, ...m }));
const awaitMsg = (type, ms = 8000, pred) => new Promise((resolve, reject) => {
  const w = { type, pred, resolve };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("timeout " + type)); } }, ms);
});

export async function main() {
  // ── 场景 1:面板 DOM / 网络 ──
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const reqs = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("request", (r) => reqs.push(r.url()));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const dom = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      avatarCol: !!document.getElementById("avatarCol"),
      avatarCss: document.querySelectorAll(".avatar-col, .ptt-wrap, .avatar-sil, .avatar-badge, .ptt-label").length,
      video: document.querySelectorAll("video, #dh-video").length,
      scRoot: !!document.querySelector("#sc-root"),
      scHeadText: (q("#sc-root .sc-head") || {}).textContent || "",
      scInput: !!document.querySelector("#sc-input"),
      scItems: document.querySelectorAll("#sc-root .sc-item").length,
    };
  });
  rec("s1-a", "无立绘/视频/按住说话 DOM", dom.avatarCol === false && dom.avatarCss === 0 && dom.video === 0, JSON.stringify(dom));
  rec("s1-b", "头部 Super Agent + 待处理数 + 命令框", /Super Agent/.test(dom.scHeadText) && dom.scInput && /待你处理|待处理/.test(dom.scHeadText), "head=" + dom.scHeadText.slice(0, 90));
  rec("s1-c", "0 pageerror", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
  const badReq = reqs.filter((u) => /dh-video|whep|companion-widget|\.mp4/i.test(u));
  rec("s2-a", "网络无 dh-video/WHEP/companion-widget 请求", badReq.length === 0, `total=${reqs.length} bad=${JSON.stringify(badReq)}`);

  // ── 场景 2:文本命令 → super.turn → 回复进气泡 ──
  const doneP = awaitMsg("super.turn.done", 150000);
  send({ type: "super.turn", text: "只回四个字:指挥台就绪" });
  let turnDone = null, turnErr = null;
  try { turnDone = await doneP; } catch (e) { turnErr = String(e.message) + " | err=" + JSON.stringify(inbox.filter((m) => m.type === "error").slice(-2)); }
  rec("s2-b", "super.turn → super.turn.done(super: 会话)", !!turnDone && String(turnDone.sessionId || "").startsWith("super:"),
    turnDone ? `sessionId=${turnDone.sessionId} text=${String(turnDone.text).slice(0, 60)}` : turnErr);
  await page.waitForTimeout(1200);
  const bubbleText = await page.evaluate(() => (document.querySelector("#sc-root") || {}).textContent || "");
  rec("s2-c", "回复出现在指挥台", !!turnDone && bubbleText.includes(String(turnDone.text).slice(0, 10)), "has=" + (turnDone ? bubbleText.includes(String(turnDone.text).slice(0, 10)) : false));
  const audioPlay = await page.evaluate(() => document.querySelectorAll("#sc-root audio").length);
  rec("s2-d", "无 audio 播放元素(无口播/无 TTS)", audioPlay === 0, "audioEls=" + audioPlay);

  // ── 场景 4:super.inbox 结构化 + 待答/待批/中断/失败各一类 ──
  // 真造数据:①ask_user 挂起(走 AskUserRouter,与 agent 调 ask_user 同一入口)
  //          ②interrupted 任务(走 TaskSupervisor.restore,与网关重启收编同一内核)
  //          ③failed 任务(近 24h)
  app.askUser.online = true;
  const askP = app.askUser.ask("e2e-sess", { question: "用 A 方案还是 B 方案?", options: ["A 方案", "B 方案"], context: "e2e 待答卡验证" });
  const interruptedTask = { id: "e2e-interrupted-1", sessionId: "e2e-sess", instruction: "被重启打断的任务", state: "running", kind: "coding", createdAt: Date.now() - 60000, updatedAt: Date.now() - 50000, title: "被打断的任务" };
  app.taskManager.restore([interruptedTask]);
  const failedTask = app.taskManager.inject({ id: "e2e-failed-1", sessionId: "e2e-sess", instruction: "失败的任务", state: "running", kind: "coding", createdAt: Date.now() - 30000, updatedAt: Date.now() - 20000, title: "失败的任务" });
  app.taskManager.setState(failedTask, "failed", "e2e 造失败态");
  await new Promise((r) => setTimeout(r, 300));

  const inboxP = awaitMsg("super.inbox.result", 8000);
  send({ type: "super.inbox", limit: 30 });
  const inboxMsg = await inboxP;
  const items = inboxMsg.items || [];
  const kinds = [...new Set(items.map((i) => i.kind))];
  rec("s4-a", "super.inbox.result 聚合 ask/interrupted/failed", kinds.includes("ask") && kinds.includes("interrupted") && kinds.includes("failed"),
    `items=${items.length} kinds=${JSON.stringify(kinds)}`);
  const askItem = items.find((i) => i.kind === "ask");
  rec("s4-b", "待答项带回答动作 + requestId", !!askItem && askItem.actions.includes("answer") && !!askItem.requestId, JSON.stringify(askItem || null).slice(0, 200));
  const intItem = items.find((i) => i.kind === "interrupted");
  rec("s4-c", "中断项带恢复动作 + taskId", !!intItem && intItem.actions.includes("resume") && !!intItem.taskId, JSON.stringify(intItem || null).slice(0, 200));

  // ── 场景 5:面板待答卡出现 → 卡内回答 → ask 得到答复 ──
  await page.waitForTimeout(1500); // 指挥台 5s 轮询 + super.inbox.changed 触发
  const cardState = await page.evaluate(() => {
    const head = (document.querySelector("#sc-count") || {}).textContent || "";
    const cards = [...document.querySelectorAll("#sc-root .sc-item")].map((el) => ({
      badge: (el.querySelector(".sc-badge") || {}).textContent || "",
      title: (el.querySelector(".sc-it") || {}).textContent || "",
      acts: [...el.querySelectorAll(".sc-acts button")].map((b) => b.textContent),
    }));
    return { head, cards };
  });
  rec("s5-a", "头部待处理数 > 0 且渲染出卡片", /待你处理 [1-9]/.test(cardState.head) && cardState.cards.length > 0,
    `head=${cardState.head} cards=${JSON.stringify(cardState.cards.map((c) => c.badge))}`);
  rec("s5-b", "待答卡有回答按钮、中断卡有恢复按钮",
    cardState.cards.some((c) => c.badge === "待答" && c.acts.some((a) => /A 方案|回答/.test(a))) &&
    cardState.cards.some((c) => c.badge === "中断" && c.acts.includes("恢复")),
    JSON.stringify(cardState.cards).slice(0, 300));

  // 待答卡:点选项按钮(inbox 项带 options 时直接出选项按钮)→ ask.user.answer → ask 挂起 promise 拿到答复
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#sc-root .sc-item")].find((x) => (x.querySelector(".sc-badge") || {}).textContent === "待答");
    const b = el ? [...el.querySelectorAll(".sc-acts button")].find((x) => x.textContent.includes("A 方案")) : null;
    if (b) { b.click(); return b.textContent; }
    // 兜底:无选项时点「回答」打开输入框再填
    const hire = el ? [...el.querySelectorAll(".sc-acts button")].find((x) => x.textContent === "回答") : null;
    if (hire) { hire.click(); return "回答输入框"; }
    return null;
  });
  let answered = null;
  try { answered = await Promise.race([askP, new Promise((r) => setTimeout(() => r("TIMEOUT"), 6000))]); } catch { answered = "ERR"; }
  rec("s5-c", "卡内回答回交 ask_user(relay_answer 通道)", clicked !== null && answered === "A 方案", `clicked=${clicked} answered=${answered}`);

  // 点中断卡的「恢复」→ task.resume(指挥台自己那条 WS 发)→ 新任务产生
  const beforeResume = app.taskManager.list().length;
  const clickedResume = await page.evaluate(() => {
    const el = [...document.querySelectorAll("#sc-root .sc-item")].find((x) => (x.querySelector(".sc-badge") || {}).textContent === "中断");
    const b = el ? [...el.querySelectorAll(".sc-acts button")].find((x) => x.textContent === "恢复") : null;
    if (b) { b.click(); return b.textContent; }
    return null;
  });
  let resumeNew = null;
  for (let i = 0; i < 40 && !resumeNew; i++) {
    await new Promise((r) => setTimeout(r, 150));
    resumeNew = app.taskManager.list().find((t) => String(t.idempotencyKey || "") === "resume:e2e-interrupted-1") || null;
  }
  rec("s5-d", "中断卡「恢复」触发 task.resume 并产生续跑任务",
    clickedResume === "恢复" && !!resumeNew && app.taskManager.list().length > beforeResume,
    `clicked=${clickedResume} newTask=${resumeNew ? resumeNew.id + "/" + resumeNew.state : null}`);

  // ── 场景 4b:任务终态 → 活动流 super.notice ──
  const noticeP = awaitMsg("super.notice", 8000);
  const doneTask = app.taskManager.inject({ id: "e2e-done-1", sessionId: "e2e-sess", instruction: "完成的任务", state: "running", kind: "coding", createdAt: Date.now() - 10000, updatedAt: Date.now() - 5000, title: "完成的任务" });
  app.taskManager.setState(doneTask, "done", "e2e 完成");
  let notice = null;
  try { notice = await noticeP; } catch { notice = null; }
  rec("s4-d", "任务终态 → super.notice(活动流)", !!notice && !!notice.text, JSON.stringify(notice || null).slice(0, 160));
  await page.waitForTimeout(800);
  const logCount = await page.evaluate(() => document.querySelectorAll("#sc-root .sc-logi").length);
  rec("s4-e", "活动流渲染出条目", logCount > 0, "logItems=" + logCount);

  // ── 场景 6:历史双前缀可读 ──
  const histP = awaitMsg("super.history.result", 8000);
  send({ type: "super.history", sinceSeq: 0 });
  const hist = await histP;
  const sess = [...new Set((hist.events || []).map((e) => e.sessionId))].filter((s) => s.startsWith("super:") || s.startsWith("companion:"));
  rec("s6-a", "super.history.result 含 super: 会话", Array.isArray(hist.events) && sess.some((s) => s.startsWith("super:")), `sessions=${JSON.stringify(sess.slice(0, 4))} events=${(hist.events || []).length}`);

  // ── 场景 3:旧入站名仍受理 ──
  const legacyP = awaitMsg("super.turn.done", 150000);
  send({ type: "companion.turn", text: "回两个字:兼容" });
  let legacy = null, legacyErr = null;
  try { legacy = await legacyP; } catch (e) { legacyErr = e.message; }
  rec("s3-a", "入站 companion.turn 仍受理、出站 super.turn.done", !!legacy, legacy ? "ok" : legacyErr);

  // ── 场景 7:窄屏 / 画布 / 双中心 ──
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(600);
  const narrow = await page.evaluate(() => {
    const wrap = document.querySelector("#superConsole");
    const r = document.querySelector("#sc-root");
    const rect = r ? r.getBoundingClientRect() : null;
    const wr = wrap ? wrap.getBoundingClientRect() : null;
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wrapDisplay: wrap ? getComputedStyle(wrap).display : "absent",
      rect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), right: Math.round(rect.right) } : null,
      wrapRect: wr ? { w: Math.round(wr.width), h: Math.round(wr.height), right: Math.round(wr.right) } : null,
    };
  });
  const narrowOk = narrow.overflowX <= 1 && (
    narrow.rect ? (narrow.rect.w > 220 && narrow.rect.right <= 901) : true
  );
  rec("s7-a", "窄屏 900x700 无横向溢出、指挥台不出界(可见时)", narrowOk, JSON.stringify(narrow));
  await page.evaluate(() => document.body.classList.add("cv-shell"));
  await page.waitForTimeout(300);
  const inCv = await page.evaluate(() => {
    const r = document.querySelector("#superConsole");
    const body = document.querySelector("#sc-root .sc-body");
    return { display: r ? getComputedStyle(r).display : "absent", bodyDisplay: body ? getComputedStyle(body).display : "absent", head: !!document.querySelector("#sc-root .sc-head") };
  });
  rec("s7-b", "画布模式指挥台折叠成头部条(仍在场,不遮内容)", inCv.display !== "none" && inCv.bodyDisplay === "none" && inCv.head, JSON.stringify(inCv));
  await page.evaluate(() => { document.body.classList.remove("cv-shell"); document.body.classList.add("dual-center"); });
  await page.waitForTimeout(300);
  const inDual = await page.evaluate(() => {
    const r = document.querySelector("#superConsole");
    const body = document.querySelector("#sc-root .sc-body");
    return { display: r ? getComputedStyle(r).display : "absent", bodyDisplay: body ? getComputedStyle(body).display : "absent" };
  });
  rec("s7-c", "双中心布局指挥台折叠成头部条", inDual.display !== "none" && inDual.bodyDisplay === "none", JSON.stringify(inDual));
  await page.evaluate(() => document.body.classList.remove("dual-center"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(EVID, "e2e-panel.png") });

  // ── 场景 8:DOM 侧残留审计 ──
  const residual = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const hits = [];
    for (const w of ["数字人", "立绘", "口播", "按住说话", "WHEP", "dh-video", "companion.turn.user"]) if (html.includes(w)) hits.push(w);
    return hits;
  });
  rec("s8-a", "面板 DOM/脚本无数字人残留字样", residual.length === 0, JSON.stringify(residual));

  await browser.close();
  ws.close();
  await new Promise((r) => setTimeout(r, 200));
  try { srv.close(); } catch {}
}

await main();
const summary = { at: new Date().toISOString(), port, pass: results.filter((r) => r.ok).length, total: results.length, results };
out("e2e-summary.json", summary);
console.log(`\nSUMMARY ${summary.pass}/${summary.total}`);
process.exit(summary.pass === summary.total ? 0 : 1);
