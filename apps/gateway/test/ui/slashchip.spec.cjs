/** step-095 斜杠指令 chip 占位符交互检查:输入态 chip 挂载/参数续输/Backspace 摘除/Esc 取消/UI 类即执行/
 * typed 直发保全/发送合成 raw 前缀/user message chip 渲染(模板隐藏+余文保留)/重放幂等/steer 函数/七主题取色。
 * 跑法:cd apps/gateway && SELF_PORT=7809 npx tsx test/ui/_ui_selfhost.cjs test/ui/slashchip.spec.cjs */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7809";

const REVIEW_TPL = "审查当前仓库最近的代码变更:按 正确性/风险/测试覆盖/可维护性 四维度输出 findings(有依据,不奉承)";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // WS 发送帧探针:面板→服务端的 task.submit/goal.set 原文(发送契约断言数据源)
  await ctx.addInitScript(() => {
    window.__wsSent = [];
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) { try { window.__wsSent.push(String(data)); } catch (e) {} return orig.call(this, data); };
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);

  // 1. palette 选中发送类 /review → 输入框 chip 占位(不展开模板,输入框清空待参数)
  await page.focus("#instruction");
  await page.keyboard.type("/review");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const chip1 = await page.evaluate(() => {
    const box = document.getElementById("inChip");
    const el = document.getElementById("instruction");
    return {
      visible: !!box && box.style.display !== "none" && box.textContent.replace(/\s+/g, "").indexOf("/review") === 0,
      val: el.value,
      cls: el.className,
      ph: el.placeholder,
      pad: el.style.paddingLeft,
      menu: document.getElementById("slashMenu").style.display === "none",
    };
  });
  check("D1 /review 回车→输入框 chip 占位", chip1.visible && chip1.val === "" && chip1.cls.includes("in-chip-on") && chip1.menu, JSON.stringify(chip1));
  check("D1 参数占位提示(placeholder=hint)", chip1.ph.indexOf("补充审查重点") === 0, chip1.ph);
  check("D1 首行文字为 chip 让位(padding-left)", Number.parseFloat(chip1.pad) > 20, chip1.pad);

  // 2. 参数续输 + #cmdChip 装填指示
  await page.keyboard.type("重点看auth模块");
  await page.waitForTimeout(120);
  const chip2 = await page.evaluate(() => ({
    val: document.getElementById("instruction").value,
    bar: document.getElementById("cmdChip").textContent,
    barOn: document.getElementById("cmdChip").style.display !== "none",
  }));
  check("D1 参数续输入框", chip2.val === "重点看auth模块", chip2.val);
  check("D1 装填指示徽标", chip2.barOn && chip2.bar.includes("/review") && chip2.bar.includes("已装填"), chip2.bar.slice(0, 40));

  // 3. Backspace 摘 chip 保参数(先在参数尾逐字删空,再退=摘 chip;caret 0 且参数非空=无操作)
  await page.evaluate(() => { const el = document.getElementById("instruction"); el.setSelectionRange(el.value.length, el.value.length); });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  const bs1 = await page.evaluate(() => ({ val: document.getElementById("instruction").value, chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none" }));
  check("D1 参数尾 Backspace=删字符(chip 在)", bs1.val === "重点看auth模" && bs1.chipOn, JSON.stringify(bs1));
  await page.evaluate(() => { const el = document.getElementById("instruction"); el.setSelectionRange(0, el.value.length); });
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  const bsMid = await page.evaluate(() => ({ val: document.getElementById("instruction").value, chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none" }));
  check("D1 参数全选删空=chip 仍在(空参才摘)", bsMid.val === "" && bsMid.chipOn, JSON.stringify(bsMid));
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  const bs2 = await page.evaluate(() => {
    const el = document.getElementById("instruction");
    return { val: el.value, chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none", cls: el.className, pad: el.style.paddingLeft, ph: el.placeholder.slice(0, 8) };
  });
  check("D1 参数空 Backspace=摘 chip 复位输入框", !bs2.chipOn && bs2.val === "" && !bs2.cls.includes("in-chip-on") && bs2.pad === "" && bs2.ph.indexOf("说点什么") === 0, JSON.stringify(bs2));

  // 4. Esc 取消=chip+参数全清
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  const esc1 = await page.evaluate(() => ({ val: document.getElementById("instruction").value, chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none", cls: document.getElementById("instruction").className }));
  check("D1 Esc 取消 chip 态", !esc1.chipOn && esc1.val === "" && !esc1.cls.includes("in-chip-on"), JSON.stringify(esc1));

  // 5. UI 纯动作类不进 chip(回车即执行):/newtask
  await page.fill("#instruction", "/newtask");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const ui1 = await page.evaluate(() => ({ val: document.getElementById("instruction").value, chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none" }));
  check("D1 /newtask 回车即执行(无 chip)", ui1.val === "" && !ui1.chipOn, JSON.stringify(ui1));

  // 6. chip 发送类合成 raw 前缀:/review + 参数 → task.submit instruction 首行=/review 参数,模板体跟后
  // (草稿态提交=wasDraft 乐观渲染路径,消息流立刻可见;journal 断言在浏览器关闭后做)
  await page.evaluate(() => newDraft());
  await page.waitForTimeout(300);
  await page.focus("#instruction");
  await page.keyboard.type("/review");
  await page.waitForTimeout(120);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(120);
  await page.keyboard.type("检查auth模块");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const s1 = await page.evaluate(() => {
    const frames = (window.__wsSent || []).filter((f) => f.indexOf("task.submit") >= 0);
    let inst = "";
    for (const f of frames) { try { const o = JSON.parse(f); if (o.type === "task.submit" && String(o.instruction || "").startsWith("/review")) inst = o.instruction; } catch (e) {} }
    const bubble = document.querySelector(".user-line .slash-chip");
    return {
      inst,
      firstLine: inst.split("\n")[0],
      tplFollows: inst.indexOf("\n\n" + "审查当前仓库最近的代码变更".slice(0, 6)) > 0,
      chipInFlow: !!bubble && bubble.textContent.indexOf("检查auth模块") >= 0,
      tplHidden: bubble ? bubble.textContent.indexOf("四维度") === -1 : null,
    };
  });
  check("D2 发送合成 raw 前缀(首行=/review 参数)", s1.firstLine === "/review 检查auth模块", JSON.stringify(s1).slice(0, 200));
  check("D2 模板体跟后(模型任务书)", s1.tplFollows, "");
  check("D2 消息流 chip 形态(参数在)", s1.chipInFlow, "");
  check("D2 模板体气泡内隐藏", s1.tplHidden === true, "");

  // 6b. 参数类 /goal 进 chip;输入参数 Enter=执行(goal.set 发出;server 侧 journal 落 /goal 原文=关闭后断言)
  await page.focus("#instruction");
  await page.keyboard.type("/goal");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const g1 = await page.evaluate(() => ({ chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none", txt: (document.getElementById("inChip").textContent || "").replace(/\s+/g, "") }));
  check("D2 /goal 回车进 chip", g1.chipOn && g1.txt.indexOf("/goal") === 0, JSON.stringify(g1));
  await page.keyboard.type("修好登录页闪烁");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  const g2 = await page.evaluate(() => ({
    frames: (window.__wsSent || []).filter((f) => f.indexOf("goal.set") >= 0).length,
    chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none",
    val: document.getElementById("instruction").value,
  }));
  check("D2 /goal chip 发送=goal.set 执行", g2.frames >= 1 && !g2.chipOn && g2.val === "", JSON.stringify(g2));

  // 7. typed 全量直发保全(step-056):手打 "/goal clear" Enter 直接执行(不进 chip;clear 分支无确认无派任务)
  await page.fill("#instruction", "/goal clear");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const t1 = await page.evaluate(() => ({
    frames: (window.__wsSent || []).filter((f) => f.indexOf("goal.set") >= 0).length,
    chipOn: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none",
    val: document.getElementById("instruction").value,
  }));
  check("D2 typed 全量直发不进 chip", t1.frames >= 2 && !t1.chipOn && t1.val === "", JSON.stringify(t1));

  // 7b. 收尾:取消本 spec 派起的任务(防运行中任务行「已工作 Xs」污染后续重放幂等快照)
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      for (const t of tasks.values()) if (["queued", "running"].includes(t.state)) wsSafeSend(JSON.stringify({ v: 1, type: "task.cancel", taskId: t.id }));
    });
    await page.waitForTimeout(400);
    const left = await page.evaluate(() => [...tasks.values()].filter((t) => ["queued", "running"].includes(t.state)).length);
    if (left === 0) break;
  }

  // 9. user message 渲染:历史重放 chip 形态 + 模板隐藏 + 手打余文保留 + 旧消息不坏
  const CONV = [
    { kind: "message.user", time: 1, payload: { text: "/review 检查auth\n\n" + REVIEW_TPL } },
    { kind: "message.user", time: 2, payload: { text: "/plan 输出重构方案" } },
    { kind: "message.user", time: 3, payload: { text: "/goal 修好X" } },
    { kind: "message.user", time: 4, payload: { text: "/unknowncmd 前置说明\n\n这是用户手打的多行正文\n第二行也要在" } },
    { kind: "message.user", time: 5, payload: { text: "普通消息(非命令)原样" } },
    { kind: "message.agent", time: 6, payload: { text: "回复。" } },
  ];
  await page.evaluate((c) => { window.__mature.setHist(c); window.__mature.renderHistory(); }, CONV);
  await page.waitForTimeout(250);
  const r1 = await page.evaluate((TPL) => {
    const lines = [...document.querySelectorAll(".user-line")];
    const txt = (i) => (lines[i] ? lines[i].querySelector(".txt") : null);
    const chip = (i) => { const el = txt(i); return el ? el.querySelector(".slash-chip") : null; };
    const l0 = txt(0);
    return {
      c0: chip(0) ? chip(0).textContent.replace(/\s+/g, "") : "",
      args0: chip(0) && chip(0).querySelector(".sc-args") ? chip(0).querySelector(".sc-args").textContent : "",
      body0: l0 ? l0.querySelector(".u-slash-body") : null,
      c1: chip(1) ? chip(1).textContent.replace(/\s+/g, "") : "",
      c2: chip(2) ? chip(2).textContent.replace(/\s+/g, "") : "",
      c3: chip(3) ? chip(3).textContent.replace(/\s+/g, "") : "",
      body3: txt(3) && txt(3).querySelector(".u-slash-body") ? txt(3).querySelector(".u-slash-body").textContent : "",
      plain: txt(4) ? txt(4).textContent : "",
      plainNoChip: txt(4) ? !txt(4).querySelector(".slash-chip") : false,
    };
  }, REVIEW_TPL);
  check("D3 /review 消息=chip(/review)", r1.c0.indexOf("/review") === 0, r1.c0);
  check("D3 参数在 chip 内(sc-args)", r1.args0 === "检查auth", r1.args0);
  check("D3 模板 remainder 隐藏(无 u-slash-body)", !r1.body0, "");
  check("D3 /plan chip 形态(旧形态不回退)", r1.c1.indexOf("/plan") === 0 && r1.c1.indexOf("输出重构方案") > 0, r1.c1);
  check("D3 /goal chip 形态", r1.c2.indexOf("/goal") === 0 && r1.c2.indexOf("修好X") > 0, r1.c2);
  check("D3 未识别命令 chip+余文保留(零丢失)", r1.c3.indexOf("/unknowncmd") === 0 && r1.body3.indexOf("用户手打的多行正文") >= 0 && r1.body3.indexOf("第二行也要在") >= 0, (r1.body3 || "").slice(0, 40));
  check("D3 非命令消息原样(无 chip)", r1.plainNoChip && r1.plain.indexOf("普通消息") >= 0, r1.plain);

  // 10. 重放幂等(HTML 逐字节一致;先等瞬态 skill 占位行清场,防其 900ms 翻牌/5.9s 摘除污染快照)
  for (let i = 0; i < 30 && await page.locator(".skill-inv").count() > 0; i++) await page.waitForTimeout(300);
  const h1 = await page.evaluate(() => { window.__h1snap = document.getElementById("chatBody").innerHTML; return window.__h1snap; });
  await page.evaluate((c) => { window.__mature.setHist(c); window.__mature.renderHistory(); }, CONV);
  await page.waitForTimeout(200);
  const h2 = await page.evaluate(() => document.getElementById("chatBody").innerHTML);
  const diff = await page.evaluate(() => {
    const a = window.__h1snap, b = document.getElementById("chatBody").innerHTML;
    if (a === b) return "same";
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return "@" + i + " A[" + a.slice(Math.max(0, i - 40), i + 40) + "] B[" + b.slice(Math.max(0, i - 40), i + 40) + "]";
  });
  check("D3 重放幂等", h1 === h2, "len " + h1.length + " vs " + h2.length + " " + String(diff).slice(0, 200));

  // 11. steer 共用渲染函数:命令文本→chip+模板隐藏;[steer] 前缀→原样(非命令不受影响)
  const st = await page.evaluate((TPL) => ({
    chip: userSlashHtml("/review 检查\n\n" + TPL, "").indexOf("slash-chip") >= 0 && userSlashHtml("/review 检查\n\n" + TPL, "").indexOf("四维度") === -1,
    steerPrefix: userSlashHtml("[steer] 注意 /review 不是命令开头", "").indexOf("slash-chip") === -1,
  }), REVIEW_TPL);
  check("D3 steer 行共用 chip 渲染(函数级)", st.chip && st.steerPrefix, JSON.stringify(st));

  // 12. 七主题 chip 取色(输入态 #inChip 与消息态 .slash-chip 均有非透明前景/底)
  const themes = ["dark", "light", "sand", "glass", "olive", "plum", "ink"];
  await page.evaluate((c) => { window.__mature.setHist(c); window.__mature.renderHistory(); }, CONV);
  const themeRes = [];
  for (const th of themes) {
    const row = await page.evaluate((t) => {
      const lightKeys = { light: 1, ink: 1, sand: 1, olive: 1, plum: 1 };
      document.body.className = t === "dark" ? "" : (lightKeys[t] ? "light " : "") + (t === "light" ? "" : "theme-" + t);
      const msgChip = document.querySelector(".user-line .slash-chip");
      const mcs = msgChip ? getComputedStyle(msgChip) : null;
      return { msgColor: mcs ? mcs.color : "", key: t };
    }, th);
    // 输入态 chip 挂载后取色
    await page.focus("#instruction");
    await page.evaluate(() => { document.getElementById("instruction").value = ""; });
    await page.keyboard.type("/review");
    await page.waitForTimeout(120);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
    const inChipRow = await page.evaluate(() => {
      const box = document.querySelector("#inChip .slash-chip");
      if (!box) return { color: "", bg: "" };
      const cs = getComputedStyle(box);
      return { color: cs.color, bg: cs.backgroundColor };
    });
    await page.keyboard.press("Escape");
    themeRes.push({ th, msg: row.msgColor, in: inChipRow.color });
    check("七主题 " + th + " chip 前景可读(输入态+消息态非默认黑)", row.msgColor && row.msgColor !== "rgb(0, 0, 0)" && inChipRow.color && inChipRow.color !== "rgb(0, 0, 0)", row.msgColor + " / " + inChipRow.color);
  }
  await page.evaluate(() => { document.body.className = ""; });

  // 13. 0 pageerror
  check("0 pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await page.screenshot({ path: "/tmp/s095-spec-final.png" });
  await browser.close();

  // 14. journal 契约(runner 侧直读):goal 原文回放行(server goal.set 落账=同步可信)。
  // review 的 journal message.user 由 loop.runTurn 写(需 executor 真跑)——selfhost 无 LLM 不自启,
  // 面板侧契约已由 ws 帧断言(task.submit instruction=raw 前缀合流)证明;journal 全链证据见真 LLM 闭环。
  try {
    const evs = (globalThis.__selfhostApp && globalThis.__selfhostApp.journal) ? globalThis.__selfhostApp.journal.readAll() : [];
    const goalRaw = evs.some((e) => e.kind === "message.user" && String((e.payload || {}).text || "") === "/goal 修好登录页闪烁");
    check("journal 契约:goal 原文行(可回放=chip 形态)", goalRaw, "message.user 计=" + evs.filter((e) => e.kind === "message.user").length);
    const revRaw = evs.some((e) => e.kind === "message.user" && String((e.payload || {}).text || "").startsWith("/review 检查auth模块\n"));
    const reviewOk = revRaw || evs.every((e) => e.kind !== "message.user" || !String((e.payload || {}).text || "").startsWith("/review") || String((e.payload || {}).text || "").startsWith("/review 检查auth模块\n"));
    check("journal 契约:review 若落账则必为 raw 前缀(无裸模板形态)", reviewOk, revRaw ? "loop 已写" : "selfhost 无 executor 未落账(帧断言已证面板契约)");
  } catch (e) { check("journal 契约读取", false, String(e).slice(0, 80)); }

  const fails = results.filter((r) => !r.ok).length;
  console.log("slashchip: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
