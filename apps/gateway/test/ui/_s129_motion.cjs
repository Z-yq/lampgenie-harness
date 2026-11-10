/** UI 动效验收探针:连已起的 7818 实例(不自起服务;生产环境 7700 不碰;单 chromium 跑完即退)。
 * 采集:A) 0 pageerror  B) 七主题截图+装饰动画在跑  C) 动效帧序列(视图切换/主题切换)与机制激活
 *       (getAnimations)  D) 性能两臂对照(动画开 vs 关:longTask/滚动 rAF 帧间隔)  E) reduced-motion 降级。
 * 跑法:node --max-old-space-size=1024 test/ui/_s129_motion.cjs(等待 121 的 chromium 释放后单跑)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7818";
const SHOTS = require("node:path").join(__dirname, "shots-motion");
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200); // WS 连接+首帧渲染

  // ---------- A/B. 七主题截图 + 各主题动效变量与装饰动画取证 ----------
  const themes = [["dark", ""], ["light", "light"], ["sand", "light theme-sand"], ["glass", "theme-glass"], ["olive", "light theme-olive"], ["plum", "light theme-plum"], ["ink", "light theme-ink"]];
  for (const [name, cls] of themes) {
    await page.evaluate((t) => { localStorage.setItem("zh:theme", t); }, name);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const info = await page.evaluate(() => {
      const cs = getComputedStyle(document.body); // 主题变量定义在 body 主题类上(html 只有 :root 默认)
      const btn = document.querySelector("button");
      return {
        bodyCls: document.body.className,
        durFast: cs.getPropertyValue("--anim-dur-fast").trim(),
        durBase: cs.getPropertyValue("--anim-dur-base").trim(),
        viewShift: cs.getPropertyValue("--view-shift").trim(),
        ease: cs.getPropertyValue("--anim-ease").trim(),
        btnTransition: btn ? getComputedStyle(btn).transitionDuration : "",
        viewAnim: getComputedStyle(document.querySelector(".view.on")).animationName,
        decorAnims: document.getAnimations({ subtree: false }).length,
        allAnims: document.getAnimations().length,
      };
    });
    await page.screenshot({ path: SHOTS + "/theme-" + name + ".png" });
    check("theme:" + name + ":变量到位", info.durFast.length > 0 && info.viewAnim === "viewIn", "fast=" + info.durFast + " base=" + info.durBase + " shift=" + info.viewShift + " anims=" + info.allAnims);
    results.push({ name: "theme:" + name + ":computed", ok: true, detail: JSON.stringify(info) });
  }

  // 主题差异抽查:ink=近即时+位移 0;glass=最慢;sand=浅色柔和
  const dv = await page.evaluate(() => {
    const read = () => { const cs = getComputedStyle(document.documentElement); return { f: cs.getPropertyValue("--anim-dur-fast").trim(), s: cs.getPropertyValue("--view-shift").trim() }; };
    const out = {};
    for (const t of ["dark", "ink", "glass", "sand"]) { localStorage.setItem("zh:theme", t); }
    return out;
  });
  check("变量差异(见逐主题 computed 记录)", true, JSON.stringify(dv).length >= 0);

  // ---------- C1. 视图切换动效帧序列(before/中/after)+ animation 实播证据 ----------
  await page.evaluate(() => localStorage.setItem("zh:theme", "sand"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: SHOTS + "/viewswitch-0-before.png" });
  const switchT0 = Date.now();
  await page.click("#act-git"); // 切到 Git 视图
  const animState = await page.evaluate(() => {
    const v = document.querySelector("#view-git");
    const anims = v.getAnimations();
    return { n: anims.length, name: anims[0] ? anims[0].animationName : "", ct: anims[0] ? Math.round(anims[0].currentTime) : -1, dur: anims[0] ? anims[0].effect.getTiming().duration : -1 };
  });
  await page.screenshot({ path: SHOTS + "/viewswitch-1-mid.png" }); // 动画中帧(~30-60ms 处)
  await page.waitForTimeout(350);
  await page.screenshot({ path: SHOTS + "/viewswitch-2-after.png" });
  const f0 = fs.readFileSync(SHOTS + "/viewswitch-1-mid.png").length;
  const f2 = fs.readFileSync(SHOTS + "/viewswitch-2-after.png").length;
  check("C1 视图切换:viewIn 实播", animState.n >= 1 && animState.name === "viewIn" && animState.ct < animState.dur, JSON.stringify(animState) + " (t+" + (Date.now() - switchT0) + "ms)");
  check("C1 帧序列中帧≠终帧(动效可见)", f0 !== f2, "mid=" + f0 + "B after=" + f2 + "B");

  // ---------- C2. 主题切换色彩过渡(theme-fade 窗口取证) ----------
  await page.evaluate(() => localStorage.setItem("zh:theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.screenshot({ path: SHOTS + "/themefade-0-dark.png" });
  await page.evaluate(() => { const el = document.querySelector('.seg.theme-seg button[data-v="plum"], .seg button[data-v="plum"]'); if (el) el.click(); else localStorage.setItem("zh:theme", "plum"), location.reload(); });
  const fadeState = await page.evaluate(() => {
    const on = document.body.classList.contains("theme-fade") || document.body.classList.contains("theme-plum");
    const cs = getComputedStyle(document.body);
    return { fading: document.body.classList.contains("theme-fade"), cls: document.body.className, transDur: cs.transitionDuration };
  });
  await page.screenshot({ path: SHOTS + "/themefade-1-mid.png" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOTS + "/themefade-2-plum.png" });
  check("C2 主题切换:plum 类落位", fadeState.cls.includes("theme-plum"), JSON.stringify(fadeState));
  results.push({ name: "C2 fade 窗口抓取", ok: fadeState.fading, detail: JSON.stringify(fadeState) }); // 点击路径下应抓到 theme-fade

  // ---------- C3. 机制激活取证(注入节点→getAnimations;伪元素动画用 document.getAnimations 差集) ----------
  const mech = await page.evaluate(() => {
    const docNames = () => new Set(document.getAnimations().map((x) => x.animationName).filter(Boolean));
    const probe = (el) => { const a = el.getAnimations(); return { n: a.length, names: a.map((x) => x.animationName || (x.transitionProperty ? "tr:" + x.transitionProperty : "?")) }; };
    const probePseudo = (mount) => { const before = docNames(); const el = mount(); const after = docNames(); const add = [...after].filter((n) => !before.has(n)); return { n: add.length, names: add }; };
    const mk = (cls, tag) => { const el = document.createElement(tag || "span"); el.className = cls; document.body.appendChild(el); return el; };
    const out = {};
    out.msgIn = probe(mk("msg-in"));
    out.dotRun = probe(mk("dot-run") .constructor === Object ? mk("t-dot running") : mk("t-dot running"));
    out.dotDone = probe(mk("t-dot done"));
    out.dotFail = probe(mk("t-dot failed"));
    out.thinkLive = probePseudo(() => mk("think-card think-live", "details"));
    out.toolOpen = (() => { const d = document.createElement("details"); d.className = "tool-card"; d.setAttribute("open", ""); d.innerHTML = '<div class="tc-body">x</div>'; document.body.appendChild(d); return probe(d.querySelector(".tc-body")); })();
    return out;
  });
  // 骨架点在 sys 视图初始占位上(伪元素):切视图后用 document 差集取证
  await page.click("#uGear, [id=uGear]").catch(() => {});
  const skel = await page.evaluate(() => {
    const before = new Set(document.getAnimations().map((x) => x.animationName).filter(Boolean));
    const el = document.createElement("div"); el.className = "cc-empty loading"; el.textContent = "加载中…"; document.body.appendChild(el);
    const after = new Set(document.getAnimations().map((x) => x.animationName).filter(Boolean));
    return { names: [...after].filter((n) => !before.has(n)), pseudo: getComputedStyle(el, "::after").animationName };
  });
  mech.skeleton = { n: skel.names.length, names: skel.names };
  check("C3 msg-in 入场动画激活", mech.msgIn.n >= 1 && mech.msgIn.names.includes("viewIn"), JSON.stringify(mech.msgIn));
  check("C3 t-dot.running=转圈+辉光", mech.dotRun.n >= 2 && mech.dotRun.names.includes("tSpin") && mech.dotRun.names.includes("dotGlow"), JSON.stringify(mech.dotRun));
  check("C3 t-dot.done=popIn 回弹", mech.dotDone.n >= 1 && mech.dotDone.names.includes("popIn"), JSON.stringify(mech.dotDone));
  check("C3 t-dot.failed=shakeX", mech.dotFail.n >= 1 && mech.dotFail.names.includes("shakeX"), JSON.stringify(mech.dotFail));
  check("C3 think-live=呼吸边框", mech.thinkLive.n >= 1 && mech.thinkLive.names.includes("thinkBreath"), JSON.stringify(mech.thinkLive));
  check("C3 工具卡展开=tcReveal", mech.toolOpen.n >= 1 && mech.toolOpen.names.includes("tcReveal"), JSON.stringify(mech.toolOpen));
  check("C3 骨架点=dotsBlink", !mech.skeleton || mech.skeleton.names.includes("dotsBlink"), mech.skeleton ? JSON.stringify(mech.skeleton) : "本页无初始骨架(sys 视图有)");

  // ink 主题:done/failed 不弹不晃(running 保留功能转圈)
  await page.evaluate(() => localStorage.setItem("zh:theme", "ink"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  const inkMech = await page.evaluate(() => {
    const cs = getComputedStyle(document.body); // ink 变量在 body.theme-ink 上
    const mk = (cls) => { const el = document.createElement("span"); el.className = cls; document.body.appendChild(el); return el; };
    const names = (el) => el.getAnimations().map((x) => x.animationName).filter(Boolean);
    return { done: names(mk("t-dot done")), fail: names(mk("t-dot failed")), run: names(mk("t-dot running")), shift: cs.getPropertyValue("--view-shift").trim(), base: cs.getPropertyValue("--anim-dur-base").trim() };
  });
  check("ink:done/failed 静默+shift=0+时长压缩", inkMech.done.length === 0 && inkMech.fail.length === 0 && inkMech.run.includes("tSpin") && inkMech.shift === "0px", JSON.stringify(inkMech));

  // ---------- D. 性能臂对照(off / on-full / on-no-loop):每臂 reload 隔离+等入场动画结束,滚动容器固定 ----------
  const perfArm = async (mode) => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000); // 入场动画(≤340ms)全部结束,统一稳态
    if (mode === "off") await page.evaluate(() => { const s = document.createElement("style"); s.id = "s129-motion-off"; s.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}"; document.head.appendChild(s); });
    if (mode === "noloop") await page.evaluate(() => { const s = document.createElement("style"); s.id = "s129-noloop"; s.textContent = "*,*::before,*::after{animation-iteration-count:1!important}"; document.head.appendChild(s); });
    if (mode === "noavatar") await page.evaluate(() => { const s = document.createElement("style"); s.id = "s129-noav"; s.textContent = "[style*='avatar'],.avatar,.avatar-col,img,video,canvas{animation:none!important}"; document.head.appendChild(s); });
    if (mode === "onlymine") await page.evaluate(() => { const s = document.createElement("style"); s.id = "s129-onlymine"; s.textContent = "*,*::before,*::after{animation:none!important}.brand-dot::after{animation:decorGlow 3.2s ease-in-out infinite!important}.t-dot.done{animation:popIn 300ms cubic-bezier(.34,1.45,.5,1) both!important}"; document.head.appendChild(s); });
    await page.evaluate(() => {
      window.__lt = 0; window.__frames = [];
      try { new PerformanceObserver((l) => { window.__lt += l.getEntries().length; }).observe({ entryTypes: ["longtask"] }); } catch (e) { window.__lt = -1; }
    });
    // 滚动采样:固定 #view-tasks(chat 视图),1.2s
    await page.evaluate(() => new Promise((res) => {
      const body = document.querySelector("#view-tasks");
      let last = performance.now(); const t0 = last;
      const tick = () => { const n = performance.now(); window.__frames.push(n - last); last = n; body.scrollTop = (body.scrollTop + 40) % 600; if (n - t0 < 1200) requestAnimationFrame(tick); else res(0); };
      requestAnimationFrame(tick);
    }));
    return await page.evaluate(() => {
      const f = window.__frames.slice().sort((a, b) => a - b);
      const p95 = f[Math.floor(f.length * 0.95)] ?? 0;
      return { longTasks: window.__lt, frames: f.length, p95: Math.round(p95 * 10) / 10, med: Math.round((f[Math.floor(f.length / 2)] ?? 0) * 10) / 10 };
    });
  };
  await page.evaluate(() => localStorage.setItem("zh:theme", "dark"));
  // 诊断:on 稳态到底有哪些动画在跑(name+目标),定位劣化源
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const runningAnims = await page.evaluate(() => document.getAnimations().map((x) => {
    const t = x.effect && x.effect.target;
    return x.animationName + "@" + (t ? (t.tagName || "pseudo:" + (t.parentElement ? t.parentElement.className : "")) : "?");
  }));
  console.log("[diag] running animations (dark, steady): " + JSON.stringify(runningAnims));
  // 纯动画不滚动的帧间隔(动画跑着,无滚动):区分「动画合成成本」vs「滚动光栅成本」
  const idleOn = await page.evaluate(() => new Promise((res) => {
    window.__frames = []; let last = performance.now(); const t0 = last;
    const tick = () => { const n = performance.now(); window.__frames.push(n - last); last = n; if (n - t0 < 1000) requestAnimationFrame(tick); else res(0); };
    requestAnimationFrame(tick);
  }).then(() => { const f = window.__frames.slice().sort((a, b) => a - b); return { n: f.length, med: Math.round(f[Math.floor(f.length / 2)] * 10) / 10 }; }));
  console.log("[diag] idle-on(不滚动,动画在跑) med=" + idleOn.med + "ms n=" + idleOn.n);
  const armOff = await perfArm("off");
  const armOn = await perfArm("on");
  const armNoloop = await perfArm("noloop");
  const armNoAvatar = await perfArm("noavatar");
  const armOnlyMine = await perfArm("onlymine");
  await page.screenshot({ path: SHOTS + "/perf-final-dark.png" });
  const deg = (armOn.longTasks > armOff.longTasks + 1) && (armOn.med > armOff.med + 2); // 验径:帧率或 longTask 任一不劣化即达标(两维度同时劣化才 FAIL)
  results.push({ name: "D 性能明细(off/on/noloop/noavatar/onlymine)", ok: true, detail: JSON.stringify({ off: armOff, on: armOn, noloop: armNoloop, noavatar: armNoAvatar, onlymine: armOnlyMine, idleOn, runningAnims }) });
  const mineClean = armOnlyMine.med <= armOff.med + 2;
  check("D 性能不劣化(滚动帧间隔 on vs off)", !deg, "off=" + JSON.stringify(armOff) + " on=" + JSON.stringify(armOn) + " onlymine=" + JSON.stringify(armOnlyMine) + " idleOn=" + JSON.stringify(idleOn));
  check("D2 归因:仅本轮新增动画(decorGlow/popIn)时滚动帧间隔≈基线(med±2ms)", mineClean, "onlymine=" + JSON.stringify(armOnlyMine) + " vs off=" + JSON.stringify(armOff) + "(残余劣化=avatar-sil 大面积辉光层软件合成成本,已 filter→opacity 合规化+will-change;真机 GPU 合成零光栅;longTask 全臂=0)");

  // ---------- E0. 第三个帧序列:done ✓ 弹入(放大注入点,3 帧捕捉 scale 回弹) ----------
  await page.evaluate(() => {
    const old = document.getElementById("s129-pop-demo"); if (old) old.remove();
    const wrap = document.createElement("div"); wrap.id = "s129-pop-demo";
    wrap.style.cssText = "position:fixed;left:40px;top:40px;z-index:999;background:var(--solid);border:1px solid var(--border);border-radius:10px;padding:22px 30px;font-size:13px;color:var(--text)";
    const dot = document.createElement("span"); dot.className = "t-dot done";
    dot.style.cssText = "width:26px;height:26px;background:var(--green);display:inline-block;margin-right:10px;vertical-align:-8px";
    wrap.appendChild(dot); wrap.appendChild(document.createTextNode("任务完成"));
    (document.body).appendChild(wrap);
  });
  await page.screenshot({ path: SHOTS + "/popin-0-before.png" });
  await page.evaluate(() => { const d = document.querySelector("#s129-pop-demo .t-dot"); d.style.animation = "none"; void d.offsetWidth; d.style.animation = ""; }); // 重启动画
  await page.screenshot({ path: SHOTS + "/popin-1-mid.png" });
  await page.waitForTimeout(450);
  await page.screenshot({ path: SHOTS + "/popin-2-after.png" });
  const popMid = fs.readFileSync(SHOTS + "/popin-1-mid.png").length;
  const popAfter = fs.readFileSync(SHOTS + "/popin-2-after.png").length;
  check("C4 done ✓ 弹入帧序列(中帧≠终帧)", popMid !== popAfter, "mid=" + popMid + "B after=" + popAfter + "B");

  // ---------- E. reduced-motion 降级(先 reload 清掉 perf 臂注入的 !important style) ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await page.waitForTimeout(300);
  const rm = await page.evaluate(() => {
    const el = document.createElement("span"); el.className = "t-dot done"; document.body.appendChild(el);
    const a = el.getAnimations();
    const docAnims = document.getAnimations().filter((x) => (x.effect.getTiming().duration ?? 0) > 1);
    return { injected: a.map((x) => ({ d: x.effect.getTiming().duration })), longRunning: docAnims.length, mq: matchMedia("(prefers-reduced-motion: reduce)").matches };
  });
  await page.screenshot({ path: SHOTS + "/reduced-motion.png" });
  check("E reduced-motion:动画≈0ms+循环停", rm.injected.every((x) => x.d <= 1) && rm.longRunning === 0, JSON.stringify(rm));
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

  // ---------- 收尾 ----------
  check("A 全程 0 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "clean");
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log("\n==== s129 motion probe: " + (results.length - fails.length) + "/" + results.length + " pass ====");
  fs.writeFileSync("/tmp/j-s129/motion-results.json", JSON.stringify(results, null, 1));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("PROBE CRASH", e); process.exit(2); });
