/** UI 经验证(状态机 interrupted 一键续跑):
 *  真实 gateway(子进程 .mjs,注入 interrupted/done/cancelled 素材)+ 真实 chromium,零桩:
 *  A interrupted 任务卡出现「续跑」按钮(侧栏 t-row 行内动作);
 *  B 点击→ws 发 task.resume 帧→服务端幂等重提→新任务回 queued→running→done(Echo);
 *    原 interrupted 任务转 cancelled(被续跑替代);双击二次 resume 返回同一新任务(不双跑);
 *  C 负面:done / 普通 cancelled 任务卡不得出现续跑按钮。
 *  跑法:cd apps/gateway && npx tsx test/ui/task-resume.spec.cjs
 *  chrome 缺席整文件 skip(与 slash.spec 同口径)。 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright-core");

const PORT = Number(process.env.SELF_PORT || 7757);
(async () => {
  if (!fs.existsSync("/usr/bin/google-chrome")) { console.log("SKIP: /usr/bin/google-chrome 不存在"); process.exit(0); }
  const RUN = "r" + Date.now().toString(36).slice(-5);
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  // ---- 网关子进程(.mjs ESM 链;detached 独立进程组,收尾按组杀) ----
  let ready = null;
  const gw = spawn(process.execPath, ["--import", "tsx", "--conditions=development", path.join(__dirname, "_task-resume_server.mjs")], {
    env: { ...process.env, SELF_PORT: String(PORT), RESUME_RUN: RUN, GENIE_JOURNAL_DIR: "/tmp/j-task-resume-" + RUN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const gwErr = [];
  gw.stderr.on("data", (d) => { gwErr.push(String(d).slice(0, 200)); process.stderr.write("[gw!] " + d); });
  {
    const deadline = Date.now() + 90_000;
    let buf = "";
    const onOut = (d) => {
      buf += String(d);
      const m = buf.match(/READY (\{.*\})/);
      if (m) ready = JSON.parse(m[1]);
    };
    gw.stdout.on("data", onOut);
    while (Date.now() < deadline && !ready) await new Promise((r) => setTimeout(r, 300));
    if (!ready) { console.error("网关 90s 未 READY(在途 sense TLA 崩溃?):", gwErr.slice(0, 2).join("\n")); try { process.kill(-gw.pid, "SIGKILL"); } catch { /* 已退 */ } process.exit(2); }
    let http = false;
    while (Date.now() < deadline && !http) {
      try { const r = await fetch("http://127.0.0.1:" + PORT + "/"); http = r.ok; } catch { /* 未就绪 */ }
      if (!http) await new Promise((r) => setTimeout(r, 500));
    }
    if (!http) { console.error("panel http 未就绪"); try { process.kill(-gw.pid, "SIGKILL"); } catch { /* 已退 */ } process.exit(2); }
  }
  const { sid: SID, int: INT_ID, done: DONE_ID, cancel: CANCEL_ID } = ready;

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 150)));
  await page.addInitScript(() => {
    window.__sent = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { const m = JSON.parse(typeof data === "string" ? data : String(data)); if (m && m.type) window.__sent.push({ type: m.type, taskId: m.taskId }); } catch (e) { /* 非 JSON 忽略 */ }
      return origSend.apply(this, arguments);
    };
  });
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate(() => switchView("chat"));

  // A:interrupted 行到位 + 续跑按钮在场
  await page.waitForFunction((sid) => { try { return [...tasks.values()].some((t) => t.sessionId === sid && t.state === "interrupted"); } catch (e) { return false; } }, SID, { timeout: 20_000, polling: 300 });
  const intBtnCount = await page.locator(`#taskList [data-resume="${INT_ID}"]`).count();
  check("A interrupted 任务卡出现「续跑」按钮", intBtnCount >= 1, "count=" + intBtnCount);

  // C 负面:done/普通 cancelled 无续跑按钮
  const doneBtn = await page.locator(`#taskList [data-resume="${DONE_ID}"]`).count();
  const cancelBtn = await page.locator(`#taskList [data-resume="${CANCEL_ID}"]`).count();
  check("C done/普通 cancelled 卡无续跑按钮", doneBtn === 0 && cancelBtn === 0, `done=${doneBtn} cancel=${cancelBtn}`);

  // B:点击续跑;立刻二次点击(双击幂等竞争)
  await page.evaluate((tid) => { const b = document.querySelector(`#taskList [data-resume="${tid}"]`); if (!b) throw new Error("按钮不在 DOM"); b.click(); }, INT_ID);
  await page.waitForTimeout(300);
  await page.evaluate((tid) => { const b = document.querySelector(`#taskList [data-resume="${tid}"]`); if (b) b.click(); }, INT_ID);
  await page.waitForTimeout(500);
  const resumeFrames = await page.evaluate(() => window.__sent.filter((m) => m.type === "task.resume"));
  check("B1 ws 发出 task.resume 帧(带原任务 id)", resumeFrames.length >= 1 && resumeFrames[0].taskId === INT_ID, "frames=" + resumeFrames.length);

  // B2/B3:续跑新任务恰 1 个,入列运行
  await page.waitForFunction((sid) => { try { return [...tasks.values()].some((t) => t.sessionId === sid && String(t.title || "").startsWith("续跑:")); } catch (e) { return false; } }, SID, { timeout: 30_000, polling: 300 });
  const st = await page.evaluate((sid) => [...tasks.values()].filter((t) => t.sessionId === sid && String(t.title || "").startsWith("续跑:")).map((t) => ({ id: t.id, state: t.state })), SID);
  check("B2 续跑新任务入列(queued/running/done)", st.length >= 1 && st.every((t) => ["queued", "running", "done"].includes(t.state)), JSON.stringify(st));
  check("B3 不双跑:续跑新任务恰 1 个", st.length === 1, "count=" + st.length);

  // B4:原 interrupted 任务转 cancelled(被续跑替代)
  const orig = await page.evaluate((tid) => { const t = tasks.get(tid); return t ? { state: t.state, result: String(t.result || "") } : null; }, INT_ID);
  check("B4 原 interrupted 任务转 cancelled(被续跑替代)", !!orig && orig.state === "cancelled" && orig.result.includes("已续跑"), JSON.stringify(orig));

  // B5:新任务到终态 done(Echo)
  await page.waitForFunction((sid) => { try { return [...tasks.values()].some((t) => t.sessionId === sid && String(t.title || "").startsWith("续跑:") && t.state === "done"); } catch (e) { return false; } }, SID, { timeout: 30_000, polling: 400 });
  check("B5 续跑任务完成(done)", true);

  check("零页面错误", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  await browser.close();
  try { process.kill(-gw.pid, "SIGKILL"); } catch { /* 已退 */ }
  const fails = results.filter((r) => !r.ok).length;
  console.log(fails === 0 ? "\nALL PASS (" + results.length + ")" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("SPEC CRASH:", e); process.exit(2); });
