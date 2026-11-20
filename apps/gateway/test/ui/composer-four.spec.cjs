/**
 * 输入条四处控件冒烟(playwright 真浏览器;隔离 servePanel 实例,不碰 7700)。
 * 用法:ITEM=ATT|PERM|CTX|GO node --import tsx test/ui/composer-four.spec.cjs(缺省 ALL)
 * ①ATT:attBtn aria-label+svg 图标;②PERM:#permPill 缺失;③CTX:#ctxPill 缺失;
 * ④GO:发送键三态 aria+图标类名+双主题对比度(测试内现算 WCAG,不预设色值)。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

const PORT = 7728;
const ITEM = process.env.ITEM || "ALL";

(async () => {
  const panel = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) errors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 220) : ""));
  };
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);
  const want = (id) => ITEM === "ALL" || ITEM === id;

 // ============ ① ATT:+ 按钮图标化 ============
  if (want("ATT")) {
    const att = await page.evaluate(() => {
      const el = document.getElementById("attBtn");
      if (!el) return { found: false };
      const svg = el.querySelector("svg.cp-ic");
      const cs = svg ? getComputedStyle(svg) : null;
      return { found: true, aria: el.getAttribute("aria-label"), title: el.getAttribute("title"), hasSvg: !!svg, w: cs ? Math.round(parseFloat(cs.width)) : 0, stroke: cs ? cs.strokeWidth : "" };
    });
    check("ATT attBtn 存在且 aria-label=添加附件", att.found && att.aria === "添加附件", JSON.stringify(att));
    check("ATT attBtn 含 svg.cp-ic 且 16px/描边 1.8", att.hasSvg && att.w === 16 && Math.abs(parseFloat(att.stroke) - 1.8) < 0.01, JSON.stringify({ w: att.w, stroke: att.stroke }));
    const menu = await page.evaluate(() => { document.getElementById("attBtn").click(); const open = !!document.querySelector(".pill-menu"); return { open, html: (document.querySelector(".pill-menu") || {}).innerHTML || "" }; });
    check("ATT 点击仍弹既有附件菜单", menu.open && /图片|文件|引用/.test(menu.html), menu.html.slice(0, 60));
    await page.evaluate(() => { if (typeof pillMenuClose === "function") pillMenuClose(); else { const m = document.querySelector(".pill-menu"); if (m) m.remove(); } }); /* 注册表同步清,防 stale pillMenuEl 污染后续段 */
 // 悬停态真验证(Playwright 真 hover:边框 bronze、图标色提亮到 --text,与 shotBtn 同 hover 规则)
    await page.hover("#attBtn");
    await page.waitForTimeout(120);
    const hov = await page.evaluate(() => {
      const el = document.getElementById("attBtn");
      const cs = getComputedStyle(el);
      return { border: cs.borderColor, color: cs.color };
    });
    check("ATT 悬停边框 --bronze(rgb 201,143,69 档)且图标色提亮", /201,\s*143,\s*69/.test(hov.border) && hov.color !== hov.border, JSON.stringify(hov));
  }

 // ============ ② PERM:完全访问胶囊缺失 ============
  if (want("PERM")) {
    const perm = await page.evaluate(() => ({ el: document.getElementById("permPill"), txt: (document.querySelector("footer .composer") || {}).textContent || "" }));
    check("PERM #permPill 元素不存在", perm.el === null, String(perm.el));
    check("PERM composer 文本无「完全访问/询问每次」", !/完全访问|询问每次|工作区内|只读/.test(perm.txt), perm.txt.slice(0, 120));
    const chan = await page.evaluate(() => typeof permModeV === "string" && typeof pillSendPerm === "function" && PERM_MODES.some((x) => x.v === "auto"));
    check("PERM 判定通道保留(permModeV/PERM_MODES/pillSendPerm 仍可用)", chan === true);
  }

 // ============ ③ CTX:胶囊保留(返工轮:=优化非删除;锁定 pill 在场+浮窗接入) ============
  if (want("CTX")) {
    const ctx = await page.evaluate(() => {
      currentSid = "spec-ctx-1"; // 草稿态只 toast,设 sid 才走浮窗分支(与 popover-lifecycle 探针同口径)
 // 返工2:注合成数据(复刻用户截图的长值形态:14.5万tok/80%+三区 note+缓存行),否则空会话浮窗只有头部无行可测
      traceStats["spec-ctx-1"] = { contextTokens: 145827, contextWindow: 200000, contextZones: { totalMessages: 371, zones: { cold: { estTokens: 90000, st: { messages: 161 } }, warm: { estTokens: 33770, st: { messages: 210 } }, hot: { estTokens: 12000, st: { messages: 12 } } } } };
      histEvents = [
        { kind: "message.user", payload: { text: "seed 用户文本 ".repeat(120) } },
        { kind: "message.agent", payload: { text: "seed 助手回复 ".repeat(120) } },
        { kind: "tool.result", payload: { content: "x".repeat(3000) } },
        { kind: "llm.trace", payload: { usage: { cachedTokens: 120000, inputTokens: 145000 } } }
      ];
      const el = document.getElementById("ctxPill");
      el && el.click();
      const menu = document.querySelector(".pill-menu.cx-menu");
      const chain = typeof ctxPillRender === "function" && typeof ctxPillMenuHtml === "function";
      return { there: !!el, menu: !!menu, chain };
    });
    check("CTX #ctxPill 在场(返工还原)", ctx.there === true);
    check("CTX 点击开富浮窗(cx-menu)", ctx.menu === true);
    check("CTX 数据链在(ctxPillRender/ctxPillMenuHtml)", ctx.chain === true);
 // 返工2:文字渲染探针——普通行行高≤2.2×字号(竖排会变成 字数×行高);zone 行含 note 本就设计折行(≤5×);
 // 数值列一律单行(≤1.7×字号)——用户截图的竖排根因就是长值串把标签列挤成 0 宽。
    const render = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".pill-menu.cx-menu .cx-row"));
      const bad = [];
      for (const r of rows) {
        const fs = parseFloat(getComputedStyle(r).fontSize) || 12;
        const cap = r.classList.contains("cx-zone") ? 5 : 2.2;
        if (r.clientHeight > fs * cap) bad.push({ k: (r.querySelector(".cx-k") || {}).textContent || "", h: r.clientHeight, fs, zone: r.classList.contains("cx-zone") });
        const v = r.querySelector(".cx-v");
        if (v && v.clientHeight > fs * 1.7) bad.push({ v: v.textContent, h: v.clientHeight, fs });
      }
      return { rows: rows.length, bad };
    });
    check("CTX 行渲染非竖排(行高≤2.2×字号)且数值列单行", render.rows > 0 && render.bad.length === 0, JSON.stringify(render));
    if (process.env.CTXSHOT) {
      if (process.env.CTXTHEME === "light") await page.evaluate(() => { document.body.classList.add("light"); });
      await page.screenshot({ path: process.env.CTXSHOT });
    }
    await page.evaluate(() => { if (typeof pillMenuClose === "function") pillMenuClose(); else { const m = document.querySelector(".pill-menu.cx-menu"); if (m) m.remove(); } });
  }

 // ============ ②b VOICE:voiceBtn 麦克风图标(返工轮) ============
  if (want("VOICE")) {
    const v = await page.evaluate(() => {
      const el = document.getElementById("voiceBtn");
      const svg = el ? el.querySelector("svg.vp-ic") : null;
      const cs = svg ? getComputedStyle(svg) : null;
      return { there: !!el, hasSvg: !!svg, w: cs ? Math.round(parseFloat(cs.width)) : 0, stroke: cs ? cs.strokeWidth : "", aria: el ? el.getAttribute("aria-label") : "" };
    });
    check("VOICE voiceBtn 含 svg.vp-ic 且 16px/描边 1.8/aria=语音输入", v.there && v.hasSvg && v.w === 16 && Math.abs(parseFloat(v.stroke) - 1.8) < 0.01 && v.aria === "语音输入", JSON.stringify(v));
  }

 // ============ ④ GO:发送键三态+对比度 ============
  if (want("GO")) {
    const go = await page.evaluate(() => {
      const read = () => { const b = document.getElementById("go"); return { cls: b.className, aria: b.getAttribute("aria-label"), html: b.innerHTML }; };
      switchView("chat"); currentSid = null;
      document.getElementById("instruction").value = ""; renderSendBtn();
      const idleEmpty = read();
      document.getElementById("instruction").value = "说一句"; renderSendBtn();
      const idleText = read();
      currentSid = "p2s";
      tasks.set("p2t", { sessionId: "p2s", state: "running", title: "跑着的任务", createdAt: Date.now(), startedAt: Date.now() });
      document.getElementById("instruction").value = ""; renderSendBtn();
      const stop = read();
      document.getElementById("instruction").value = "再排一句"; renderSendBtn();
      const queue = read();
      tasks.delete("p2t"); currentSid = null;
      document.getElementById("instruction").value = ""; renderSendBtn();
      return { idleEmpty, idleText, stop, queue };
    });
    check("GO 空输入=disabled 禁用态+纸飞机+aria 发送", /disabled/.test(go.idleEmpty.cls) && /send-ic-plane/.test(go.idleEmpty.html) && go.idleEmpty.aria === "发送", JSON.stringify(go.idleEmpty));
    check("GO 有输入=可发送(disabled 摘除)", !/disabled/.test(go.idleText.cls) && /send-ic-plane/.test(go.idleText.html) && go.idleText.aria === "发送", JSON.stringify(go.idleText));
    check("GO 运行中空输入=stop 方点+aria 停止", /\bstop\b/.test(go.stop.cls) && /send-ic-stop/.test(go.stop.html) && go.stop.aria === "停止", JSON.stringify(go.stop));
    check("GO 运行中有输入=queue 时钟+aria 排队发送", /queue-mode/.test(go.queue.cls) && /send-ic-clockface/.test(go.queue.html) && go.queue.aria === "排队发送", JSON.stringify(go.queue));

 // Super 窗:aria 随启/禁切换
    const sup = await page.evaluate(() => {
      switchView("super");
      const si = document.getElementById("superInput"), sb = document.getElementById("superSend");
      si.value = ""; si.dispatchEvent(new Event("input"));
      const empty = { aria: sb.getAttribute("aria-label"), cls: sb.className };
      si.value = "hi"; si.dispatchEvent(new Event("input"));
      const text = { aria: sb.getAttribute("aria-label"), cls: sb.className };
      si.value = ""; si.dispatchEvent(new Event("input"));
      switchView("chat");
      return { empty, text };
    });
    check("GO superSend 空输入 aria=输入内容后再发送+disabled", sup.empty.aria === "输入内容后再发送" && /disabled/.test(sup.empty.cls), JSON.stringify(sup.empty));
    check("GO superSend 有输入 aria=发送+可点", sup.text.aria === "发送" && !/disabled/.test(sup.text.cls), JSON.stringify(sup.text));

 // 对比度:图标 fill vs 圆底(半透明背景合成到底色后再算 WCAG),dark 基座 + body.light
    const contrast = await page.evaluate(() => {
      const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ratio = (c1, c2) => { const l1 = lum(...c1), l2 = lum(...c2); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
      const parse = (s) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(String(s)); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
      const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
      const out = {};
      const snap = (theme) => {
        document.body.classList.remove("light", "theme-glass", "theme-ink", "theme-sand", "theme-olive", "theme-plum");
        if (theme === "light") document.body.classList.add("light");
        const btn = document.getElementById("go");
        const plane = btn.querySelector(".send-ic-plane");
        const btnBg = parse(getComputedStyle(btn).backgroundColor);
        const pageBg = parse(getComputedStyle(document.body).backgroundColor);
        const icon = parse(getComputedStyle(plane).fill);
        const eff = icon.a < 1 ? blend(icon, btnBg) : icon;
        const base = btnBg.a < 1 ? blend(btnBg, pageBg) : btnBg;
        return Math.round(ratio([eff.r, eff.g, eff.b], [base.r, base.g, base.b]) * 100) / 100;
      };
      out.dark = snap("dark");
      out.light = snap("light");
      document.body.classList.remove("light");
      return out;
    });
    check("GO 图标 vs 圆底对比度 dark ≥3:1", contrast.dark >= 3, "dark=" + contrast.dark);
    check("GO 图标 vs 圆底对比度 light ≥3:1", contrast.light >= 3, "light=" + contrast.light);
  }

  check("控制台无错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-composer-four.png" });
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  console.log("---- " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ----");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 探针崩溃 — " + String(e && e.message ? e.message : e).slice(0, 400));
  process.exit(1);
});
