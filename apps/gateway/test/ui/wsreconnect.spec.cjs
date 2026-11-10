/** UI 实测 step-070(R5-C6 根治):WS 断线→指数退避重连→session.history 增量重放(幂等);
 *  server kill→重启 不整页 reload(window 探针标记存活);「重连中」角标;连续失败退回 svcWaitRestart 保底。
 *  跑法(一次一个 chromium,不碰产线 7700):
 *    cd apps/gateway && GENIE_CHECKPOINT=off npx tsx test/ui/wsreconnect.spec.cjs
 *  截图组落 tasks/step-070-ws-resilience/shots/(正常/重连角标/恢复后 × 1440x900/1280x800/1920x1080 + 1024 窄窗)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const net = require("node:net");

const PORT = Number(process.env.SELF_PORT || 7768); // 7849/7797 是并发会话端口(step.md 避让清单),勿用
const SHOTS = join(__dirname, "..", "..", "..", "..", "tasks", "step-070-ws-resilience", "shots");
const timeline = []; // 重连时间线留证(D4):{t, ev}
const T0 = Date.now();
const mark = (ev) => { timeline.push({ t: Date.now() - T0, ev }); };

(async () => {
  const jd = mkdtempSync(join(tmpdir(), "s070-"));
  const backend = {
    kind: "s070-e2e",
    async spawn(spec, onEvent) {
      onEvent({ type: "result", result: { ok: true, finalText: "回复-" + (spec.taskId || "").slice(0, 6) } });
      return { taskId: spec.taskId, cancel: async () => {}, steer: async () => true, respondPermission: async () => {} };
    },
  };
  let app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
  let panel = servePanel(PORT, (srv) => app.attachWs(srv));
  await new Promise((r) => setTimeout(r, 400));
  mark("server#1 up :" + PORT);

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--no-proxy-server", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const wsState = () => page.evaluate(() => ({
    conn: String(document.getElementById("conn")?.textContent || ""),
    ready: (typeof ws !== "undefined" && ws) ? ws.readyState : -1,
    rc: typeof rcAttempt === "number" ? rcAttempt : -1,
    banner: (() => { const b = document.getElementById("svcBanner"); return b ? b.style.display + "|" + b.textContent.slice(0, 30) : "none-el"; })(),
  }));
  const waitConn = async (need, ms) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await wsState();
      if (last.conn.indexOf(need) >= 0) return true;
      await page.waitForTimeout(200);
    }
    console.log("DIAG waitConn 超时(need=" + need + "):", JSON.stringify(last));
    return false;
  };
  const startStack = async () => {
    app = createGatewayApp({ useExternalHttp: true, executor: backend, journalDir: jd });
    panel = servePanel(PORT, (srv) => app.attachWs(srv));
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch("http://127.0.0.1:" + PORT + "/"); if (r.ok) break; } catch (e) { /* 未就绪 */ }
      if (Date.now() - t0 > 15000) throw new Error("restart not ready");
      await new Promise((r) => setTimeout(r, 200));
    }
    mark("server up :" + PORT);
  };
  // panel.close 等 keep-alive HTTP 连接排干(chrome 常驻轮询连接)=可能永不回调;竞速兜底。
  // 监听套接字在 close 调用即释放,waitPortFree 把住重绑时机。
  const stopStack = async () => {
    if (panel) await Promise.race([panel.close(), new Promise((r) => setTimeout(r, 800))]);
    if (app) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 1500))]);
    panel = null; app = null;
    mark("server DOWN");
  };
  const waitPortFree = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const free = await new Promise((res) => {
        const s = net.connect(PORT, "127.0.0.1");
        s.on("connect", () => { s.destroy(); res(false); });
        s.on("error", () => res(true));
      });
      if (free) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  mkdirSync(SHOTS, { recursive: true });
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  // 场景一重连基速 8s:给断连窗口的节点侧任务留足落 journal 的时间(echo 快照秒级,负载下更慢);
  // 场景二/三前把 settings.reconnect 调回内存值(2/1,指数 2,4,8…/1,2,4…)加速重连。
  await page.evaluate(() => { localStorage.setItem("zh:reconnect", "8"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  check("首连就绪", await waitConn("已连接", 8000));
  check("已连接状态点亮", (await page.evaluate(() => String(document.getElementById("status")?.className))).indexOf("on") >= 0);

  // ===== 场景零(取证):正常态截图组(1440x900 / 1280x800 / 1920x1080)=====
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS, "normal-1440.png") });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "normal-1280.png") });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "normal-1920.png") });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(250);

  // ===== 场景一:socket 断、服务在——断连窗口内的新 journal 事件经重连增量重放补齐 =====
  await page.fill("#instruction", "断线前消息甲");
  await page.click("#go");
  await page.waitForTimeout(4000); // echo 快照秒级
  const before = await page.locator(".user-line", { hasText: "断线前消息甲" }).count();
  check("断线前消息已渲染", before === 1, before + " 条");
  await page.evaluate(() => { window.__rcProbeMark = 42; }); // reload 探针:整页刷新会丢
  const sid = await page.evaluate(() => currentSid);
  check("取得当前会话", typeof sid === "string" && sid.length > 0, String(sid).slice(0, 24));

  await page.evaluate(() => ws.close()); // 探针模式模拟断链(服务仍在)
  await new Promise((r) => setTimeout(r, 500));
  mark("场景一 close(服务在)");
  const badge1 = page.locator("#svcBanner", { hasText: "自动重连中" });
  check("断开后角标出现(重连中,可见)", await badge1.isVisible().catch(() => false));
  check("conn 文案进入重连态", (await page.evaluate(() => String(document.getElementById("conn")?.textContent || ""))).indexOf("重连中") >= 0);

  // 断连窗口:node 侧直连 gateway 向同会话提交消息乙(页面收不到广播=重连后必须靠增量补)。
  // 轮询 journal 直到 乙 的 message.user 落盘(断连窗口事件先于重连存在=重放语义可确定性断言)。
  {
    const WebSocket = require("ws");
    const c = new WebSocket("ws://127.0.0.1:" + PORT);
    await new Promise((r) => c.on("open", r));
    c.send(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: "断连窗口消息乙", idempotencyKey: "s070-gap-1" }));
    const jr = () => require("node:fs").readFileSync(join(jd, "gateway.jsonl"), "utf-8");
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const j = jr();
      if (j.indexOf("断连窗口消息乙") >= 0 && j.indexOf('"task.done"') >= 0) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const settled = jr().split("\n").filter((l) => l.indexOf("断连窗口消息乙") >= 0 && l.indexOf('"message.user"') >= 0).length;
    check("断连窗口事件已落 journal(先于重连)", settled >= 1, settled + " 条");
    c.close();
  }
  check("重连成功(conn 恢复)", await waitConn("重连成功", 30000));
  mark("场景一 reconnect ok");
  check("重连后角标撤除", (await badge1.isVisible().catch(() => false)) === false);
  check("reload 未触发(探针标记存活)", (await page.evaluate(() => window.__rcProbeMark)) === 42);
  await page.waitForTimeout(1500);
  const yi = await page.locator(".user-line", { hasText: "断连窗口消息乙" }).count();
  if (yi !== 1) { // 取证:区分「journal 没写」vs「重放没渲染」
    const jr = require("node:fs").readFileSync(join(jd, "gateway.jsonl"), "utf-8");
    const seqs = jr.split("\n").filter((l) => l.trim() && (l.indexOf("断连窗口消息乙") >= 0 || l.indexOf("断线前消息甲") >= 0))
      .map((l) => { try { const e = JSON.parse(l); return e.kind + "@" + e.seq + ":" + String((e.payload || {}).text || e.payload?.instruction || "").slice(0, 12); } catch (_) { return "?"; } });
    console.log("DIAG journal seqs:", seqs.join(" , "));
    console.log("DIAG histUser=" + await page.evaluate(() => (typeof histEvents === "object" && histEvents ? histEvents.filter((e) => e.kind === "message.user").map((e) => String((e.payload || {}).text || "")).join("|") : "null"))
      + " lastSeq=" + await page.evaluate(() => String(histLastSeq)));
  }
  check("断连窗口事件增量重放(消息乙=1,幂等)", yi === 1, yi + " 条");
  const jia = await page.locator(".user-line", { hasText: "断线前消息甲" }).count();
  check("断线前内容保留(消息甲=1)", jia === 1, jia + " 条");

  // ===== 场景二:server kill→重启——不整页刷新,自动重连+内容保留;角标窗口三档截图 =====
  await page.evaluate(() => { settings.reconnect = 2; }); // 场景二/三加速(指数 2,4,8…;localStorage 只影响下次加载)
  await page.evaluate(() => { window.__rcProbeMark = 43; });
  await stopStack();
  await waitPortFree(5000);
  const badge2 = page.locator("#svcBanner", { hasText: "自动重连中" });
  check("停机后角标再现(重连中,可见)", await badge2.isVisible().catch(() => false), "服务终止应触发 close→重连");
  check("停机后 status 熄灭", (await page.evaluate(() => String(document.getElementById("status")?.className))).indexOf("on") < 0);
  // 角标窗口截图组(指数退避进行中:2s/4s/8s 三次尝试,窗口约 10s)
  await page.screenshot({ path: join(SHOTS, "badge-1440.png") });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "badge-1280.png") });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "badge-1920.png") });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(250);
  await new Promise((r) => setTimeout(r, 2000)); // 留一拍失败重连(退避臂真实进行)
  await startStack();
  check("server 重启后自动重连", await waitConn("重连成功", 25000));
  mark("场景二 reconnect ok");
  check("reload 未触发(标记 43 存活)", (await page.evaluate(() => window.__rcProbeMark)) === 43);
  await page.waitForTimeout(1500); // 追平拍(step-070 wsOnOpen 内 1.5s/4s 增量追平)
  check("二次重连后消息甲仍=1(重放幂等)", (await page.locator(".user-line", { hasText: "断线前消息甲" }).count()) === 1);
  check("二次重连后消息乙仍=1", (await page.locator(".user-line", { hasText: "断连窗口消息乙" }).count()) === 1);
  // 恢复后截图组
  await page.screenshot({ path: join(SHOTS, "restored-1440.png") });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "restored-1280.png") });
  await page.setViewportSize({ width: 1920, height: 1080 }); await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, "restored-1920.png") });
  await page.setViewportSize({ width: 1024, height: 800 }); await page.waitForTimeout(300);
  const noBreak = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("1024 窄窗不破版(scrollWidth<=innerWidth)", noBreak);
  await page.screenshot({ path: join(SHOTS, "narrow-1024.png") });
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(250);

  // ===== 场景三:连续失败保底——rcAttempt 顶到 RC_MAX → 退回 svcWaitRestart(reload 路径) =====
  await stopStack();
  await waitPortFree(5000);
  await new Promise((r) => setTimeout(r, 400)); // 等 close→重连臂生效
  await page.evaluate(() => { clearTimeout(rcTimer); rcTimer = 0; rcAttempt = RC_MAX; wsOnClose(); }); // 直接置满失败计数并触发一次判定
  await page.waitForTimeout(300);
  const fallbackBanner = page.locator("#svcBanner", { hasText: "页面将在恢复后自动刷新" });
  check("连续失败退回 reload 保底横幅(可见)", await fallbackBanner.isVisible().catch(() => false));
  mark("场景三 fallback banner");
  await startStack(); // svcWaitRestart 探活到恢复→location.reload(保底路径真实触发)
  await page.waitForFunction(() => window.__rcProbeMark === undefined, null, { timeout: 30000 }).catch(() => {});
  check("保底路径发生了整页刷新(探针标记被清)", (await page.evaluate(() => window.__rcProbeMark)) === undefined);
  mark("场景三 reload done");
  check("刷新后页面自愈重连", await waitConn("已连接", 15000));

  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | "));
  await browser.close();
  await stopStack();
  writeFileSync(join(__dirname, "..", "..", "..", "..", "tasks", "step-070-ws-resilience", "reconnect-timeline.json"),
    JSON.stringify({ spec: "wsreconnect", port: PORT, startedAt: new Date(T0).toISOString(), timeline, results }, null, 2));
  rmSync(jd, { recursive: true, force: true });
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH:", e); process.exit(2); });
