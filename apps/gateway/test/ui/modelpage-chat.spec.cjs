/** UI 板 mm-pill/mm-switch 端到端:会话切模型 → 真实任务回复来自新模型(mock LLM,隔离 fixture)。
 * 依赖:fixture gateway(7791,agent.sessionWorker=false)+ mock OpenAI(7801)返回 MOCK_REPLY:<model>。 */
const { chromium } = require("playwright-core");
const { readFileSync, existsSync } = require("node:fs");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7791";
const JOURNAL_ROOT = process.env.JOURNAL_ROOT || "/tmp/gh-ui-repo/.genie/journals/sessions";
(async () => {
  const sid = "ui-chat-proof-" + Date.now();
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 180)));
  const results = [];
  const check = (n, ok, d = "") => { results.push({ n, ok }); console.log((ok ? "PASS" : "FAIL") + " " + n + (d ? " — " + d : "")); };
  const agentReplies = () => {
    const f = JOURNAL_ROOT + "/" + sid + ".jsonl";
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter((j) => j && j.kind === "message.agent").map((j) => String(j.payload && j.payload.text || ""));
  };
  const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return null; };
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate((sid) => { currentSid = sid; window.__mockSid = sid; }, sid);
  const setB = await page.evaluate((sid) => new Promise((resolve) => {
    const h = (ev) => { try { const m = JSON.parse(ev.data); if (m.type === "session.model.result" && m.sessionId === sid) { ws.removeEventListener("message", h); resolve(m); } } catch (e) {} };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ v: 1, type: "session.model.set", sessionId: sid, model: "mock-b", providerId: "p1" }));
    setTimeout(() => resolve({ timeout: true }), 4000);
  }), sid);
  check("服务端切到 mock-b", setB && setB.ok === true && setB.effective && setB.effective.model === "mock-b", JSON.stringify(setB).slice(0, 220));
  await page.evaluate((sid) => { currentSid = sid; renderModelPill(cfgView); renderModelSwitch(); }, sid);
  await page.evaluate((sid) => ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: "只回复一句话：TASK_B。不要调用任何工具。", idempotencyKey: "proof-b-" + Date.now(), title: "proof b" })), sid);
  const replyB = await waitFor(() => agentReplies().find((t) => /MOCK_REPLY:mock-b/.test(t)));
  check("切换后任务回复来自 mock-b", !!replyB, replyB || JSON.stringify(agentReplies()));

  // pill 菜单路径切 mock-c(p2 折叠组 → 展开 → 点项)
  await page.evaluate(() => { switchView("chat"); renderModelPill(cfgView); });
  await page.waitForTimeout(300);
  await page.click("#modelPill");
  await page.waitForTimeout(250);
  const p2head = page.locator('.pill-menu .pm-grp[data-g="p2"] .pm-ghead');
  check("pill 菜单 p2 分组可见", await p2head.count() === 1);
  if (await p2head.count()) { await p2head.click(); await page.waitForTimeout(250); }
  const item = page.locator('.pill-menu .pm-item[data-v="mock-c"]');
  check("p2 二级有 mock-c", await item.count() === 1);
  await item.click();
  await page.waitForTimeout(600);
  const ov = await page.evaluate((sid) => sessionModelOverride.get(sid) || null, sid);
  const pill = (await page.locator("#modelPill").textContent().catch(() => "")) || "";
  check("pill 点选后服务端覆盖=mock-c", ov && ov.model === "mock-c", JSON.stringify(ov));
  check("pill 文案显示 mock-c", pill.includes("mock-c"), pill.trim());
  await page.evaluate((sid) => ws.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: "只回复一句话：TASK_C。不要调用任何工具。", idempotencyKey: "proof-c-" + Date.now(), title: "proof c" })), sid);
  const replyC = await waitFor(() => agentReplies().find((t) => /MOCK_REPLY:mock-c/.test(t)));
  check("pill 切换后任务回复来自 mock-c", !!replyC, replyC || JSON.stringify(agentReplies()));
  check("零 pageerror", errs.length === 0, errs.join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();
