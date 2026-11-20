/**
 * P2 聊天渲染对标的 chromium 探针(真浏览器经验证)。
 * 用法:ITEM=P2-1|P2-2 node --import tsx test/ui/chat-render-p2.spec.cjs(缺省 ALL=全跑)。
 * 惯例照 chat-render-p1.spec.cjs / slash.spec.cjs:playwright-core + 系统 chrome headless + servePanel。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

const PORT = 7727;
const ITEM = process.env.ITEM || "ALL";

(async () => {
  const panel = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("WebSocket")) errors.push(m.text().slice(0, 150));
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 200) : ""));
  };

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);
  const want = (id) => ITEM === "ALL" || ITEM === id;

 // ============ P2-1 顶栏「新建任务」入口 ============
  if (want("P2-1")) {
    const dom = await page.evaluate(() => {
      const b = document.getElementById("tbNewTask");
      if (!b) return { found: false };
      const cs = getComputedStyle(b);
      const hd = b.closest("header");
      const hdInfo = hd ? { inline: hd.getAttribute("style"), hidden: hd.hasAttribute("hidden"), cs: getComputedStyle(hd).display, rules: [...document.styleSheets].length } : null;
      const chain = [];
      let n = b;
      while (n && n.nodeType === 1 && chain.length < 6) {
        const s2 = getComputedStyle(n);
        chain.push((n.id || n.className || n.tagName) + ":d=" + s2.display + ",w=" + Math.round(n.getBoundingClientRect().width));
        n = n.parentElement;
      }
      return { found: true, view: document.body.dataset.view, title: b.getAttribute("title"), kbd: b.getAttribute("data-kbd"), wired: !!b.__newTaskWired, text: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), chain: chain, visible: cs.display !== "none" && b.getBoundingClientRect().width > 0, hd: hdInfo };
    });
    check("P2-1 #tbNewTask 存在且可见", dom.found && dom.visible, JSON.stringify({ chain: dom.chain, hd: dom.hd }).slice(0, 320));
    check("P2-1 title 含 Ctrl+N", /Ctrl\+N/.test(String(dom.title || "")) && dom.kbd === "ctrl+n", "title=" + dom.title + " data-kbd=" + dom.kbd);
    check("P2-1 点击已接线(newTaskTopbarWire)", dom.wired === true);
 // 造一个可观测的「非草稿」现场:切到 sys 视图 + 选中会话 + 输入框有残留文本。
    const before = await page.evaluate(() => {
      switchView("sys");
      currentSid = "p2s";
      document.getElementById("instruction").value = "残留草稿";
      return { view: document.body.dataset.view, sid: currentSid, val: document.getElementById("instruction").value, draft: document.body.dataset.draft || "" };
    });
    const bb = await page.locator("#tbNewTask").boundingBox();
    if (bb && bb.width > 0) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    else await page.$eval("#tbNewTask", (el) => el.click());
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      view: document.body.dataset.view, sid: currentSid, val: document.getElementById("instruction").value, draft: document.body.dataset.draft || "",
    }));
    check("P2-1 点击真实触发 newDraft(视图回到 chat)", after.view === "chat" && before.view !== after.view, before.view + "→" + after.view);
    check("P2-1 点击真实触发 newDraft(会话退出+输入清空)", after.sid === null && after.val === "", JSON.stringify({ sid: after.sid, val: after.val }));
  }

 // ============ P2-2 指挥台状态点/附件计数/发送键 stop 态 ============
  if (want("P2-2")) {
    const dot = await page.evaluate(() => {
      const seen = [];
      const read = (label) => {
        const el = document.getElementById("supModelDot");
        const cs = getComputedStyle(el);
        return { label, state: el.getAttribute("data-state"), cls: el.className, bg: cs.backgroundColor, w: parseFloat(cs.width), h: parseFloat(cs.height), radius: cs.borderTopLeftRadius };
      };
 // ok = 模型名能在配置端点目录里解析到 → 造最小 cfgView
      cfgView = { config: { providers: [{ id: "pA", models: ["m-ok"] }] } };
      supModelDotRender({ model: "m-ok" });
      seen.push(read("ok"));
      supModelDotRender({ model: "m-unregistered" });
      seen.push(read("warn"));
      supModelDotRender({});
      seen.push(read("err"));
      return seen;
    });
    const states = dot.map((d) => d.state);
    check("P2-2 #supModelDot 三态可取(ok/warn/err)", states[0] === "ok" && states[1] === "warn" && states[2] === "err", JSON.stringify(states));
    const bgs = dot.map((d) => d.bg);
    check("P2-2 三态底色互异(computedStyle 非透明)", new Set(bgs).size === 3 && bgs.every((c) => c && c !== "rgba(0, 0, 0, 0)"), JSON.stringify(bgs));
    check("P2-2 圆点几何生效(圆点非方块)", dot.every((d) => d.w > 0 && d.w === d.h && parseFloat(d.radius) >= d.w / 2 - 0.5), JSON.stringify(dot.map((d) => d.w + "x" + d.h + " r=" + d.radius)));
    check("P2-2 状态类同步到 class(sup-dot + 状态)", dot.every((d) => new RegExp("sup-dot\\s+" + d.state).test(d.cls)), JSON.stringify(dot.map((d) => d.cls)));

    const att = await page.evaluate(() => {
      const read = () => {
        const el = document.getElementById("supAttCount");
        return { txt: el.textContent, cnt: el.getAttribute("data-count"), display: getComputedStyle(el).display };
      };
      supAttCountRender(3);
      const three = read();
      supAttCountRender(0);
      const zero = read();
      supAttCountRender(2);
      return { three, zero, two: read() };
    });
    check("P2-2 #supAttCount 计数 3 可见", att.three.txt === "3" && att.three.cnt === "3" && att.three.display !== "none", JSON.stringify(att.three));
    check("P2-2 #supAttCount 归零后隐藏", att.zero.txt === "0" && att.zero.display === "none", JSON.stringify(att.zero));

    const go = await page.evaluate(() => {
      switchView("chat");
      currentSid = "p2s";
      tasks.set("p2t", { sessionId: "p2s", state: "running", title: "跑着的任务", createdAt: Date.now(), startedAt: Date.now() });
      document.getElementById("instruction").value = "";
      renderSendBtn();
      const read = () => {
        const b = document.getElementById("go");
        return { cls: b.className, aria: b.getAttribute("aria-label"), html: b.innerHTML, title: b.getAttribute("title") };
      };
      const running = read();
 // 有输入时不抢停(排队态):确保 stop 只在「忙碌且空输入」出现
      document.getElementById("instruction").value = "再说一句";
      renderSendBtn();
      const queued = read();
      tasks.delete("p2t");
      currentSid = null;
      document.getElementById("instruction").value = "";
      renderSendBtn();
      const idle = read();
      return { running, queued, idle };
    });
 //  三态已改 SVG(纸飞机=发/方点=停/时钟+纸飞机=排),
 // 断言改图标语义(send-ic-stop / send-ic-clockface / send-ic-plane)+ class+aria,不再断言文字。
    check("P2-2 任务活跃且空输入 → #go.stop(方点图标)", /\bstop\b/.test(go.running.cls) && /send-ic-stop/.test(go.running.html) && go.running.aria === "停止", JSON.stringify({ cls: go.running.cls, aria: go.running.aria }));
    check("P2-2 有输入时不进 stop(改排队,时钟图标)", !/\bstop\b/.test(go.queued.cls) && /queue-mode/.test(go.queued.cls) && /send-ic-clockface/.test(go.queued.html) && go.queued.aria === "排队发送", JSON.stringify({ cls: go.queued.cls, aria: go.queued.aria }));
    check("P2-2 空闲态回发送(纸飞机)且无 stop", !/\bstop\b/.test(go.idle.cls) && /send-ic-plane/.test(go.idle.html) && go.idle.aria === "发送", JSON.stringify({ cls: go.idle.cls, aria: go.idle.aria }));
  }

  check("控制台无错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-chat-render-p2.png" });
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  console.log("---- " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ----");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 探针崩溃 — " + String(e && e.message ? e.message : e).slice(0, 400));
  process.exit(1);
});