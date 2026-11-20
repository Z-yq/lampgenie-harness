/** UI 经验证:popover 浮窗生命周期治理。
 * 四态语义逐族断言:①outside-click 消失 ②触发器重复点击=toggle 且不叠实例(DOM 实例数=1)③同类单实例(开新收旧)④Esc 关。
 * 覆盖 5 个治理浮窗:ctxPill(重点,四态全测+同类单实例)/#taskMenu/#selMenu/#mentionMenu/#slashMenu。
 * 跑法 A(selfhost):cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/popover-lifecycle.spec.cjs
 * 跑法 B(直跑):cd apps/gateway && npx tsx test/ui/popover-lifecycle.spec.cjs(自起 servePanel,ITEM 可选单项)。
 * 惯例同 chat-render-p0.spec.cjs:playwright-core + /usr/bin/google-chrome headless;末尾 process.exit 收尾。 */
const { chromium } = require("playwright-core");

const ITEM = String(process.env.ITEM || "").trim();
const want = (k) => !ITEM || ITEM === k;
const PORT = Number(process.env.POP_PORT || 7759);
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:" + PORT;

(async () => {
  let panel = null;
  if (!process.env.PANEL_BASE) {
    const { servePanel } = require("../../src/panel.ts");
    panel = servePanel(PORT, () => { /* 本 spec 只测纯客户端浮窗行为,无需 WS 后端 */ });
  }
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
 // 面板默认启动为画布壳(zh:cv-mode 缺省→canvas,body.cv-shell 把经典视图 transform 出屏,#instruction/#ctxPill 不可点)。
 // switchView("chat") 只切 data-view 不清 cv-shell,故必须在首个文档加载前钉住 classic(script-ide-2.ts init 读档 zh:cv-mode)。
  await page.addInitScript(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) { /* 隐私模式兜底:加载后再移除 cv-shell */ } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) pageErrors.push(m.text().slice(0, 200)); });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  };
 // selfhost 真数据流下存在中途重进画布壳的路径(enter 会 mountViews 把视图搬进卡片);
 // 交互前守卫:若在画布态用 CanvasShell.toggleMode 正经退出(搬回节点),仅 remove class 会留下搬空的 DOM。
  const ensureClassic = () => page.evaluate(() => {
    try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) { /* 忽略 */ }
    const b = document.body;
    if (b && b.classList.contains("cv-shell")) {
      try { if (window.CanvasShell && window.CanvasShell.toggleMode) { CanvasShell.toggleMode(); return; } } catch (e) { /* 资产未载,落到手动摘类 */ }
      b.classList.remove("cv-shell");
    }
  });
  for (const [obj, names] of [[page, ["click", "fill", "focus"]], [page.mouse, ["click"]]]) {
    for (const n of names) {
      const orig = obj[n].bind(obj);
      obj[n] = async (...a) => { await ensureClassic(); return orig(...a); };
    }
  }
  const runItem = async (name, fn) => {
    try { await ensureClassic(); await fn(); } catch (e) { check(name + " 执行异常", false, String(e).slice(0, 300)); }
  };
  const cxCount = () => page.locator(".pill-menu.cx-menu").count();
  const blurInput = () => page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
 // outside-click 一律点专用惰性垫片:selfhost 真数据下点 (700,200) 会命中可交互元素切走视图,导致后续 #instruction/#ctxPill 不可见。
  const outsideClick = async () => {
    const pt = await page.evaluate(() => {
      let el = document.getElementById("specInertPad");
      if (!el) { el = document.createElement("div"); el.id = "specInertPad"; el.style.cssText = "position:fixed;left:240px;top:150px;width:36px;height:18px;z-index:1"; document.body.appendChild(el); }
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(pt.x, pt.y);
  };
 // selMenu 打开动作收进单次 evaluate(内部等 60ms 再读 display):selfhost 聊天流周期性重渲染会在
 // evaluate→setTimeout(10ms)→isVisible 的窗口里摘掉选区宿主,把「已开」误判成「没开」。
  const selOpen = () => page.evaluate(() => new Promise((res) => {
    const b = document.getElementById("chatBody");
    let host = document.getElementById("selHost");
    if (!host) { host = document.createElement("div"); host.id = "selHost"; host.textContent = "划词测试正文一段足够长的文字供 selection 使用"; b.appendChild(host); }
    const r = document.createRange(); r.selectNodeContents(host);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    host.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 120, clientY: 120 }));
    setTimeout(() => res(document.getElementById("selMenu").style.display), 60);
  }));

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    await page.evaluate(() => { if (document.body.classList.contains("cv-shell")) document.body.classList.remove("cv-shell"); switchView("chat"); });
    await page.waitForTimeout(200);

 // ---------------- ctxPill 上下文余量富浮层(用户点名重点:四态全测+同类单实例) ----------------
    if (want("ctx")) await runItem("ctxPill", async () => {
      await page.evaluate(() => { currentSid = "spec-sid-1"; }); // ctxPill.onclick 需要会话在位(草稿态只 toast)
 // ①打开 + 单实例
      await page.click("#ctxPill");
      await page.waitForTimeout(120);
      check("ctxPill 点击打开富浮层", (await cxCount()) === 1, "cx-menu 实例数=" + (await cxCount()));
 // ②outside-click:点浮窗外任何地方立即消失
      await outsideClick();
      await page.waitForTimeout(120);
      check("ctxPill 外点任意处立即消失", (await cxCount()) === 0, "cx-menu 实例数=" + (await cxCount()));
 // ③重复点击触发器=toggle(收起),不得叠出新实例
      await page.click("#ctxPill"); await page.waitForTimeout(80);
      await page.click("#ctxPill"); await page.waitForTimeout(80);
      check("ctxPill 二点=toggle 收起", (await cxCount()) === 0, "二次点击后实例数=" + (await cxCount()));
 // ④连点 3 次(开-收-开):DOM 实例数恒=1,不叠多实例(旧行为:每次 new div 叠一个)
      await page.click("#ctxPill"); await page.waitForTimeout(60);
      await page.click("#ctxPill"); await page.waitForTimeout(60);
      await page.click("#ctxPill"); await page.waitForTimeout(120);
      check("ctxPill 快速重复点击不叠实例(DOM 实例数=1)", (await cxCount()) === 1, "连点后实例数=" + (await cxCount()));
 // ⑤Esc 关(焦点不在输入框也成立:doc 级 keydown)
      await blurInput();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(120);
      check("ctxPill Esc 关闭", (await cxCount()) === 0, "Esc 后实例数=" + (await cxCount()));
 // ⑥同类单实例(开新收旧):taskMenu 开着时再开 ctxPill → 旧的被收掉
      await page.evaluate(() => { openTaskMenu({ id: "t1", sessionId: "s1", title: "spec任务" }, 300, 300); });
      await page.waitForTimeout(80);
      check("ctxPill 前置:taskMenu 已开", await page.locator("#taskMenu").isVisible());
      await page.click("#ctxPill");
      await page.waitForTimeout(120);
      check("ctxPill 开新的收旧的(taskMenu 被收)", (await cxCount()) === 1 && !(await page.locator("#taskMenu").isVisible()),
        "cx=" + (await cxCount()) + " taskMenu可见=" + (await page.locator("#taskMenu").isVisible()));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      await page.evaluate(() => { currentSid = null; });
    });

 // ---------------- #taskMenu 侧栏右键/操作菜单(缺口:Esc) ----------------
    if (want("task")) await runItem("taskMenu", async () => {
      await page.evaluate(() => { openTaskMenu({ id: "t1", sessionId: "s1", title: "spec任务" }, 300, 300); });
      await page.waitForTimeout(100);
      check("taskMenu openTaskMenu 打开", await page.locator("#taskMenu").isVisible());
      check("taskMenu 载体单实例(页面仅 1 个 #taskMenu)", (await page.locator("#taskMenu").count()) === 1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      check("taskMenu Esc 关闭(缺口修复)", !(await page.locator("#taskMenu").isVisible()));
      await page.evaluate(() => { openTaskMenu({ id: "t2", sessionId: "s2", title: "再来一次" }, 320, 320); });
      await page.evaluate(() => { openTaskMenu({ id: "t3", sessionId: "s3", title: "连开两次" }, 340, 340); });
      await page.waitForTimeout(100);
      check("taskMenu 重复打开不叠实例(仍是 1 个,内容刷新)", (await page.locator("#taskMenu").count()) === 1 && await page.locator("#taskMenu").isVisible());
      await outsideClick();
      await page.waitForTimeout(100);
      check("taskMenu 外点关闭(既有行为保持)", !(await page.locator("#taskMenu").isVisible()));
    });

 // ---------------- #selMenu 划词菜单(缺口:Esc) ----------------
    if (want("sel")) await runItem("selMenu", async () => {
      const d1 = await selOpen();
      check("selMenu 划词(mouseup)弹出", d1 === "block", "open 后 display=" + d1);
      await blurInput();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      check("selMenu Esc 关闭(缺口修复)", !(await page.locator("#selMenu").isVisible()));
      const d2 = await selOpen();
      check("selMenu 重开仍单实例", d2 === "block" && (await page.locator("#selMenu").count()) === 1, "重开 display=" + d2);
      await outsideClick();
      await page.waitForTimeout(100);
      check("selMenu 外点关闭(既有行为保持)", !(await page.locator("#selMenu").isVisible()));
    });

 // ---------------- #mentionMenu 提及菜单(缺口:doc 级外点 + 焦点离开输入框 Esc) ----------------
    if (want("mention")) await runItem("mentionMenu", async () => {
      await page.evaluate(() => { mentionOpen = true; mentionItems = ["package.json", "src/panel.ts"]; mentionTokenStart = 0; mentionRender(); });
      await page.waitForTimeout(80);
      check("mentionMenu 打开(注入候选)", await page.locator("#mentionMenu").isVisible());
 // 焦点离开输入框(不触发外点:程序化 blur 无 pointerdown)→ Esc 仍可关(缺口:此前 Esc 仅输入框内生效)
      await blurInput();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      check("mentionMenu 焦点离开输入框后 Esc 关闭(缺口修复)", !(await page.locator("#mentionMenu").isVisible()));
      await page.evaluate(() => { mentionOpen = true; mentionItems = ["package.json"]; mentionTokenStart = 0; mentionRender(); });
      await page.waitForTimeout(80);
      await outsideClick();
      await page.waitForTimeout(100);
      check("mentionMenu 外点任意处关闭(缺口修复:doc 级外点)", !(await page.locator("#mentionMenu").isVisible()));
      await page.evaluate(() => { mentionOpen = true; mentionItems = ["package.json"]; mentionTokenStart = 0; mentionRender(); });
      await page.waitForTimeout(80);
      await page.click("#instruction"); // 点输入框本身=继续编辑,不是外点
      await page.waitForTimeout(100);
      check("mentionMenu 点输入框不关(keep 豁免)", await page.locator("#mentionMenu").isVisible());
      await page.evaluate(() => mentionClose());
    });

 // ---------------- #slashMenu 斜杠菜单(缺口:Esc 只绑输入框) ----------------
    if (want("slash")) await runItem("slashMenu", async () => {
      await page.focus("#instruction");
      await page.keyboard.type("/");
      await page.waitForTimeout(150);
      check("slashMenu 输入 / 弹出", await page.locator("#slashMenu").isVisible());
      await blurInput(); // 焦点离开输入框 → 旧实现 Esc 失效
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
      check("slashMenu 焦点离开输入框后 Esc 关闭(缺口修复)", !(await page.locator("#slashMenu").isVisible()));
      await page.fill("#instruction", "/");
      await page.waitForTimeout(150);
      check("slashMenu 重开仍单实例", (await page.locator("#slashMenu").count()) === 1 && await page.locator("#slashMenu").isVisible());
      await outsideClick();
      await page.waitForTimeout(100);
      check("slashMenu 外点关闭(既有行为保持)", !(await page.locator("#slashMenu").isVisible()));
      await page.fill("#instruction", "/");
      await page.waitForTimeout(150);
      await page.click("#instruction");
      await page.waitForTimeout(100);
      check("slashMenu 点输入框不关(keep 豁免)", await page.locator("#slashMenu").isVisible());
      await page.fill("#instruction", "");
    });

    if (pageErrors.length && ITEM === "") check("无页面脚本错误", false, pageErrors.slice(0, 2).join(" | "));
  } finally {
    try { await browser.close(); } catch (e) { /* 忽略 */ }
    try { if (panel) panel.close(); } catch (e) { /* 忽略 */ }
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length) console.log("FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
