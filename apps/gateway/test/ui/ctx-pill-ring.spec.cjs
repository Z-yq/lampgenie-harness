/** UI 视觉校验: 上下文 pill 环形图标(三档色/对比度经验证/与 ZCode 参考图并排对比)。
 * 断言:①三档色 class 随 CX_TIERS 阈值切换(4%→safe 绿 / 75%→warn / 90%→tense)
 * ②对比度经验证:中心数字(正文色)对底 ≥4.5:1、弧色对底 ≥3:1(dark+light 双主题)
 * ③环形 SVG 尺寸 16×16、stroke-width 3、linecap round
 * ④产出:pill 特写(dark/light × 三档)+ 与 .genie/uploads/super/mwn6nctk-image.png 并排对比图。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/ctx-pill-ring.spec.cjs */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const SHOTS = path.resolve(__dirname, "../../../../tasks/-ctx-icon-zones-reconcile/shots");
const REF = path.resolve(__dirname, "../../../.genie/uploads/super/mwn6nctk-image.png");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = globalThis.__selfhostApp;
  if (!app || !app.journal) { console.error("FAIL 需要 _ui_selfhost.cjs 提供的 __selfhostApp"); process.exit(1); }
  const Z1 = "z3-ring-sid";
 // 最小 fixture:1 user + 1 agent(带经验证 usage)→ pill 有主值;contextWindow 客户端兜底
  app.journal.appendMany([
    { kind: "message.user", sessionId: Z1, payload: { text: "校验指令:".padEnd(40, "庚") } },
    { kind: "message.agent", sessionId: Z1, payload: { text: "实测条", llmMs: 900, usage: { inputTokens: 8000, outputTokens: 40, totalTokens: 8040 } } },
  ]);
  const BASE = process.env.PANEL_BASE;
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 4 });
  await page.addInitScript(() => { try { localStorage.setItem("zh:cv-mode", "classic"); } catch (e) {} });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(300);
  await page.evaluate((sid) => { window.__mature.openSession(sid); }, Z1);
  await page.waitForTimeout(900);
  await page.evaluate((sid) => { wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid })); }, Z1);
 // 先等服务端回帧(否则注入会被回帧整体覆盖,环形不渲染),再兜底 contextWindow/主值
  await page.waitForFunction(
    (sid) => { try { const s = traceStats[sid]; return !!(s && (s.contextTokens > 0 || s.contextZones || s.contextWindow)); } catch (e) { return false; } },
    Z1, { timeout: 12000 },
  ).catch(() => {});
  await page.evaluate((sid) => {
    const s = traceStats[sid] || (traceStats[sid] = {});
    if (!Number(s.contextWindow)) s.contextWindow = 200000;
    if (!Number(s.contextTokens)) s.contextTokens = 8000;
  }, Z1);
  await page.waitForTimeout(300);
  await page.evaluate(() => { try { ctxPillRender(); } catch (e) {} });
  await page.waitForTimeout(200);

 // 对比度在 node 侧计算:色值来自页面 getComputedStyle;底色来自 #ctxPill 元素截图的真实像素
 // (截图=渲染合成后的 ground truth,避免「半透明色合成到白还是黑」的 CSS 解析歧义)
  const parseCol = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1]; const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
  const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const flatOn = (c, base) => { const p = parseCol(c); const a = p[3]; return [p[0] * a + base[0] * (1 - a), p[1] * a + base[1] * (1 - a), p[2] * a + base[2] * (1 - a)]; };
  const ratioOn = (fg, bg) => { const F = flatOn(fg, [255, 255, 255]), B = parseCol(bg); const l1 = lum(F[0], F[1], F[2]), l2 = lum(B[0], B[1], B[2]); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const ratio = (fg, bg) => { const F = parseCol(fg), B = parseCol(bg); const l1 = lum(F[0], F[1], F[2]), l2 = lum(B[0], B[1], B[2]); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

  const measure = async (pct, tier) => {
    const raw = await page.evaluate(({ pct, tier }) => {
      const st = traceStats["z3-ring-sid"] || (traceStats["z3-ring-sid"] = {});
      if (!Number(st.contextWindow)) st.contextWindow = 200000;
      st.contextTokens = Math.round(200000 * pct / 100);
      try { ctxPillRender(); } catch (e) {}
      const el = document.getElementById("ctxPill");
      const svg = el.querySelector("svg.cx-ring");
      const fg = svg.querySelector("circle.cx-ring-fg");
      const bg = svg.querySelector("circle.cx-ring-bg");
      const pctEl = el.querySelector(".cx-ring-pct");
      const cs = getComputedStyle(fg);
      const csPct = getComputedStyle(pctEl);
      const csBg = getComputedStyle(bg);
      const r = Number(fg.getAttribute("r"));
      return {
        tier, pctText: pctEl.textContent,
        fgClass: fg.getAttribute("class"),
        stroke: cs.stroke, strokeWidth: cs.strokeWidth, linecap: cs.strokeLinecap,
        track: csBg.stroke, pctColor: csPct.color, pctFont: csPct.fontSize,
        w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height,
        dasharray: fg.getAttribute("stroke-dasharray"), dashoffset: fg.getAttribute("stroke-dashoffset"),
        circumference: (2 * Math.PI * r).toFixed(1),
      };
    }, { pct, tier });
 // 底色采样:元素截图(4×)在 padding 区(h/2, x=4px*4)取真实渲染合成色
    const shot = await page.locator("#ctxPill").screenshot();
    const dataUrl = "data:image/png;base64," + shot.toString("base64");
    const bgSample = await page.evaluate(async (src) => {
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = src; });
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(Math.floor(img.height / 2), Math.floor(img.height / 2), 1, 1).data; // x=h/2 落在左 padding 带
      return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
    }, dataUrl);
    return {
      ...raw,
      pillBgSample: bgSample,
      cArc: ratio(raw.stroke, raw.track).toFixed(2),
      cArcBg: ratio(raw.stroke, bgSample).toFixed(2),
      cNum: ratio(raw.pctColor, bgSample).toFixed(2),
    };
  };

  const m4 = await measure(4, "safe");
  const m75 = await measure(75, "warn");
  const m90 = await measure(90, "tense");
  const C = 2 * Math.PI * 15.5;
  const okOff = (m, pct) => Math.abs(Number(m.dashoffset) - C * (1 - pct / 100)) <= 1.5;
  check("三档色 class 切换:safe 无缀/warn/tense", m4.fgClass === "cx-ring-fg" && m75.fgClass.indexOf("warn") >= 0 && m90.fgClass.indexOf("tense") >= 0, JSON.stringify([m4.fgClass, m75.fgClass, m90.fgClass]));
  check("三档弧色互异(green→warn→red)", m4.stroke !== m75.stroke && m75.stroke !== m90.stroke, [m4.stroke, m75.stroke, m90.stroke].join(" | "));
  check("弧比例=占用率(4%/75%/90% dashoffset 各自一致)", okOff(m4, 4) && okOff(m75, 75) && okOff(m90, 90), [m4.dashoffset, m75.dashoffset, m90.dashoffset].join("/"));
  check("中心数字=4%/75%/90%", m4.pctText === "4%" && m75.pctText === "75%" && m90.pctText === "90%", [m4.pctText, m75.pctText, m90.pctText].join("/"));
  check("环形尺寸 16×16 · stroke-width 3 · linecap round", m4.w === 16 && m4.h === 16 && m4.strokeWidth === "3px" && m4.linecap === "round", m4.w + "x" + m4.h + " sw=" + m4.strokeWidth + " cap=" + m4.linecap);
 // 对比度(dark 主题):数字≥4.5:1(取三档最小)、弧对底(track)≥3:1
  const numsDark = [Number(m4.cNum), Number(m75.cNum), Number(m90.cNum)];
  const arcsDark = [Number(m4.cArc), Number(m75.cArc), Number(m90.cArc), Number(m4.cArcBg), Number(m75.cArcBg), Number(m90.cArcBg)];
  check("dark:中心数字对比度≥4.5:1(实测 " + numsDark.join("/") + ")", numsDark.every((x) => x >= 4.5), "min=" + Math.min(...numsDark));
  check("dark:弧对底对比度≥3:1(实测 弧/track " + [m4.cArc, m75.cArc, m90.cArc].join("/") + " · 弧/pill底 " + [m4.cArcBg, m75.cArcBg, m90.cArcBg].join("/") + ")", arcsDark.every((x) => x >= 3), "min=" + Math.min(...arcsDark));

 // pill 特写:dark 三档 + light safe
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });
  await page.evaluate(() => { try { ctxPillRender(); } catch (e) {} });
  await measure(4, "safe");
  await page.locator("#ctxPill").screenshot({ path: path.join(SHOTS, "pill-dark-safe.png") });
  await measure(75, "warn");
  await page.locator("#ctxPill").screenshot({ path: path.join(SHOTS, "pill-dark-warn.png") });
  await measure(90, "tense");
  await page.locator("#ctxPill").screenshot({ path: path.join(SHOTS, "pill-dark-tense.png") });
  await page.evaluate(() => { try { setTheme("light"); } catch (e) {} });
  const m4l = await measure(4, "safe-light");
  await page.locator("#ctxPill").screenshot({ path: path.join(SHOTS, "pill-light-safe.png") });
  const numsLight = [Number(m4l.cNum)];
  const arcsLight = [Number(m4l.cArc), Number(m4l.cArcBg)];
  check("light:中心数字对比度≥4.5:1(实测 " + numsLight.join("/") + ")", numsLight.every((x) => x >= 4.5), "min=" + Math.min(...numsLight));
  check("light:弧对底对比度≥3:1(实测 弧/track " + m4l.cArc + " · 弧/pill底 " + m4l.cArcBg + ")", arcsLight.every((x) => x >= 3), "min=" + Math.min(...arcsLight));
  await page.evaluate(() => { try { setTheme("dark"); } catch (e) {} });

 // 与 ZCode 参考图并排对比图(参考图 vs 本实现三档+light)
  const refData = fs.existsSync(REF) ? "data:image/png;base64," + fs.readFileSync(REF).toString("base64") : "";
  const img = (p) => "data:image/png;base64," + fs.readFileSync(path.join(SHOTS, p)).toString("base64");
  const cmp = await browser.newPage({ viewport: { width: 1180, height: 460 }, deviceScaleFactor: 2 });
  await cmp.setContent(`<body style="margin:0;background:#14161c;font-family:system-ui;color:#ddd;display:flex;align-items:center;justify-content:center;gap:18px;padding:16px;box-sizing:border-box">
    <div style="text-align:center"><div style="font-size:13px;margin-bottom:6px;color:#bbb">ZCode 参考(用户上传)</div><img src="${refData}" style="height:340px;border-radius:8px;border:1px solid #333"></div>
    <div style="text-align:center"><div style="font-size:13px;margin-bottom:6px;color:#bbb">本实现(16px 环·sw3·圆头;4× 放大截取)</div>
      <div style="display:flex;gap:10px;align-items:flex-end;background:#1d2027;padding:10px 14px;border-radius:8px;border:1px solid #333">
        <img src="${img("pill-dark-safe.png")}" style="height:84px"><img src="${img("pill-dark-warn.png")}" style="height:84px"><img src="${img("pill-dark-tense.png")}" style="height:84px"><img src="${img("pill-light-safe.png")}" style="height:84px">
      </div></div>
  </body>`, { waitUntil: "domcontentloaded" });
  await cmp.waitForTimeout(400);
  await cmp.screenshot({ path: path.join(SHOTS, "compare-zcode-ref.png") });
  await cmp.close();
  check("并排对比图已产出(compare-zcode-ref.png)", fs.existsSync(path.join(SHOTS, "compare-zcode-ref.png")), "");

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== " + (failed.length ? "FAILED " + failed.length + "/" + results.length : "ALL PASS " + results.length) + " ====");
  console.log("shots: " + SHOTS);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(2); });
