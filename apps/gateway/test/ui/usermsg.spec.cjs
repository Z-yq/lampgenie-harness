/** step-063 user 消息视觉重设计检查:气泡形态/右对齐/对比度/hover 按钮/slash-chip/markdown 不回退/重放一致/双路径同款。
 * 跑法:npx tsx test/ui/_ui_selfhost.cjs test/ui/usermsg.spec.cjs(自启临时实例,不碰产线 7700)。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const T0 = Date.parse("2026-10-14T10:00:00");

const CONV_A = [
  { kind: "message.user", time: T0, payload: { text: "帮我看一下 renderHistory 会话切换闪烁" } },
  { kind: "message.agent", time: T0 + 8000, payload: { text: "先看渲染入口:\n\n```ts\nif (histEvents === null) return;\n```\n\n幂等缓存挡住全量重写。" } },
  { kind: "message.user", time: T0 + 30000, payload: { text: "/plan 输出重构方案,分三期" } },
  { kind: "compact.done", time: T0 + 40000, payload: { summary: "前 12 轮已蒸馏" } },
  { kind: "message.user", time: T0 + 50000, payload: { text: "长文本压测:/mnt/e/workship/genie/lampgenie-harness/apps/gateway/src/panel.ts 希望换行不断章取义", attachments: [{ name: "a.png", mime: "image/png" }] } },
];
const CONV_B = [
  { kind: "message.user", time: T0, payload: { text: "另一条会话的问句,内容不同" } },
  { kind: "message.agent", time: T0 + 5000, payload: { text: "另一条回答。" } },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const inject = (conv) => page.evaluate((c) => { window.__mature.setHist(c); window.__mature.renderHistory(); }, conv);
  await inject(CONV_A);
  await page.waitForTimeout(300);

  // 1. 气泡形态在:渐变暖铜底+非零圆角(右下 4px 收角)+边框
  const bubble = await page.evaluate(() => {
    const el = document.querySelector('.user-line[data-turn]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundImage, radius: cs.borderRadius, border: cs.borderTopWidth + " " + cs.borderTopStyle, color: cs.color, fit: cs.width };
  });
  check("气泡形态(渐变底/圆角/边框)", !!bubble && bubble.bg.includes("gradient") && bubble.radius.split(" ").length >= 3 && bubble.border.startsWith("1px"), JSON.stringify(bubble && bubble.radius));

  // 2. 右对齐:气泡右缘贴近容器内容右缘(留 2px margin)
  const align = await page.evaluate(() => {
    const el = document.querySelector('.user-line[data-turn]');
    const host = document.getElementById("chatBody");
    if (!el || !host) return null;
    const gap = host.getBoundingClientRect().right - el.getBoundingClientRect().right;
    return { gap, ml: getComputedStyle(el).marginLeft };
  });
  check("右对齐(右缘贴近容器)", !!align && align.gap >= 0 && align.gap < 24, JSON.stringify(align));

  // 3. 暗底可读性:文本色为 --text 解析值(#ece1d1)而非 muted(#97836a)
  const color = await page.evaluate(() => getComputedStyle(document.querySelector('.user-line[data-turn] .txt')).color);
  check("文本对比度(color=--text 非 muted)", color === "rgb(236, 225, 209)", color);

  // 4. hover 按钮可用:悬停后 msg-acts 显形,按钮横排(宽>高,nowrap 未被压竖)
  const line = page.locator(".user-line[data-turn]").first();
  await line.hover();
  await page.waitForTimeout(250);
  const hover = await page.evaluate(() => {
    const acts = document.querySelector('.user-line[data-turn] .msg-acts');
    const btn = acts && acts.querySelector('button');
    if (!acts || !btn) return null;
    const cs = getComputedStyle(acts), bs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return { opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), text: btn.textContent, ws: bs.whiteSpace };
  });
  check("hover 侧聊/重编按钮显形且横排", !!hover && hover.opacity === "1" && hover.w > hover.h && hover.text === "侧聊", JSON.stringify(hover));
  const btn2 = await page.evaluate(() => {
    const b = document.querySelectorAll('.user-line[data-turn] .msg-acts button')[1];
    return b ? b.textContent : "";
  });
  check("重编按钮在列", btn2 === "重编", btn2);

  // 5. slash-chip 不回退(气泡内 chip 形态保留)
  const slash = await page.evaluate(() => {
    const chip = document.querySelector('.user-line .txt .slash-chip');
    return chip ? chip.textContent.trim().slice(0, 12) : "";
  });
  check("slash-chip 在气泡内保留", slash.replace(/\s+/g, "").indexOf("/plan") === 0, slash);

  // 6. assistant markdown 渲染不回退(代码围栏仍出 code-wrap)
  const md = await page.evaluate(() => !!document.querySelector(".task-reply .code-wrap"));
  check("assistant markdown/代码块不回退", md);

  // 7. 长文本在气泡内换行(overflow-wrap:anywhere,无横向溢出)
  const wrap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.user-line[data-turn]')];
    const el = rows[rows.length - 1];
    if (!el) return null;
    return { overflowX: el.scrollWidth - el.clientWidth, ow: getComputedStyle(el.querySelector(".txt")).overflowWrap };
  });
  check("长文本气泡内换行(无横向溢出)", !!wrap && wrap.overflowX <= 0 && (wrap.ow === "anywhere" || wrap.ow === "break-word"), JSON.stringify(wrap));

  // 8. 附件卡在气泡内
  const att = await page.evaluate(() => !!document.querySelector('.user-line .txt .att-card'));
  check("附件卡在气泡内", att);

  // 9. renderHistory 重放一致:同输入二次渲染 HTML 幂等
  const html1 = await page.evaluate(() => document.getElementById("chatBody").innerHTML);
  await inject(CONV_A);
  await page.waitForTimeout(200);
  const html2 = await page.evaluate(() => document.getElementById("chatBody").innerHTML);
  check("renderHistory 重放幂等一致", html1 === html2, "len " + html1.length + " vs " + html2.length);

  // 10. 会话切换一致性:A→B→A 重建后逐 user 文本一致
  await inject(CONV_B);
  await page.waitForTimeout(150);
  const bFirst = await page.evaluate(() => { const el = document.querySelector('.user-line .txt'); return el ? el.textContent : ""; });
  await inject(CONV_A);
  await page.waitForTimeout(150);
  const aBack = await page.evaluate(() => [...document.querySelectorAll('.user-line .txt')].map((e) => e.textContent.trim()));
  check("会话切换重放一致(A→B→A)", bFirst.includes("另一条会话") && aBack.length === 3 && aBack[0].includes("renderHistory 会话切换闪烁") && aBack[2].includes("长文本压测"), JSON.stringify(aBack).slice(0, 120));

  // 11. 双路径:子代理工作区 steer 行与主路径共用 .user-line 类=同款气泡(类级 parity;renderSubWorkspace 函数体不动)
  const steer = await page.evaluate(() => {
    const host = document.getElementById("chatBody");
    const d = document.createElement("div");
    d.className = "user-line";
    d.innerHTML = '<span class="who">转向</span><span class="txt">steer 转向文本</span>';
    host.appendChild(d);
    const cs = getComputedStyle(d);
    const out = { bg: cs.backgroundImage.includes("gradient"), radius: cs.borderTopLeftRadius, color: cs.color };
    d.remove();
    return out;
  });
  check("steer 路径同款气泡(类级 parity)", steer.bg && steer.radius === "12px" && steer.color === "rgb(236, 225, 209)", JSON.stringify(steer));

  // 12. 与相邻形态可分辨:sys-line/cp-divider 无气泡底(分层未被波及)
  const sep = await page.evaluate(() => {
    const sys = document.querySelector(".sys-line");
    const cp = document.querySelector(".cp-divider");
    return {
      sysBg: sys ? getComputedStyle(sys).backgroundImage : "",
      cpBg: cp ? getComputedStyle(cp).backgroundImage : "",
    };
  });
  check("sys-line/cp-divider 形态未被波及", (sep.sysBg === "none" || sep.sysBg === "") && sep.cpBg === "none", JSON.stringify(sep));

  // 13. 浅色主题嵌套不破(body.light 变量翻转后气泡仍成立)
  await page.evaluate(() => document.body.classList.add("light"));
  await page.waitForTimeout(150);
  const light = await page.evaluate(() => {
    const el = document.querySelector('.user-line[data-turn]');
    const cs = getComputedStyle(el);
    const txt = getComputedStyle(el.querySelector(".txt"));
    return { bg: cs.backgroundImage.includes("gradient"), color: txt.color };
  });
  await page.evaluate(() => document.body.classList.remove("light"));
  check("浅色主题气泡不破", light.bg && light.color === "rgb(61, 50, 35)", JSON.stringify(light));

  // 14. step-095 新增:raw 前缀合流消息=chip+参数,模板 remainder 隐藏;手打余文保留(零丢失)
  await page.evaluate((t0) => {
    const evs = window.__mature.hist().slice();
    evs.push({ kind: "message.user", time: t0 + 60000, payload: { text: "/review 检查auth\n\n审查当前仓库最近的代码变更:按 正确性/风险/测试覆盖/可维护性 四维度输出 findings(有依据,不奉承)" } });
    evs.push({ kind: "message.user", time: t0 + 61000, payload: { text: "/unsung 前置行\n\n手打正文第二行" } });
    window.__mature.setHist(evs);
    window.__mature.renderHistory();
  }, T0);
  await page.waitForTimeout(250);
  const chipNew = await page.evaluate(() => {
    const lines = [...document.querySelectorAll(".user-line")];
    const last = lines[lines.length - 2];
    const last2 = lines[lines.length - 1];
    const chip = last && last.querySelector(".slash-chip");
    const body = last && last.querySelector(".u-slash-body");
    const chip2 = last2 && last2.querySelector(".slash-chip");
    const body2 = last2 && last2.querySelector(".u-slash-body");
    return {
      chip: chip ? chip.textContent.replace(/\s+/g, "").slice(0, 14) : "",
      args: chip && chip.querySelector(".sc-args") ? chip.querySelector(".sc-args").textContent : "",
      tplHidden: !body,
      chip2: chip2 ? chip2.textContent.replace(/\s+/g, "").slice(0, 12) : "",
      keep: body2 ? body2.textContent : "",
    };
  });
  check("step-095 raw 前缀消息=chip(/review 检查auth)", chipNew.chip.indexOf("/review") === 0 && chipNew.args === "检查auth", JSON.stringify(chipNew.chip + "|" + chipNew.args));
  check("step-095 模板 remainder 隐藏", chipNew.tplHidden, "");
  check("step-095 未识别命令余文保留", chipNew.chip2.indexOf("/unsung") === 0 && chipNew.keep.indexOf("手打正文第二行") >= 0, chipNew.keep);

  check("0 pageerror", consoleErrors.length === 0, consoleErrors.join(" | "));
  const fails = results.filter((r) => !r.ok).length;
  console.log("usermsg: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
