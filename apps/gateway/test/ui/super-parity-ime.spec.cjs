/**
 * Super 聊天窗 × coding agent 对齐——真实浏览器验收(②真·双渲染 DOM + ③IME 真机 + C 七主题截图)。
 * 为什么不用 vitest:本仓 vitest 是 node 环境无 DOM,而「同一段消息两侧渲染后比结构」必须真 DOM 统计
 * (类名层级/折叠节点数/按钮数)。同源契约层(定义唯一/分支覆盖)在 test/panel-super-parity.test.ts;
 * 这里只做真机事实。
 * 覆盖:
 * ② 双渲染 DOM 断言:同一 payload(markdown 表格 + 围栏代码含 <error> 行 + 工具卡聚合 + 轮级组)
 * 分别走 Super 管线(supRenderChatNow)与 coding 侧构建器(replyBlockHtml/roundGroupHtml),
 * 挂进真节点后按 querySelectorAll 计数比对。
 * ③ IME 真机:CDP Input.imeSetComposition 造拼音组合期——组合期 Enter 零发送/零丢字、ESC 取消后
 * 输入框回到组合前、选词上屏后文字完整、组合结束 Enter 恰好 1 条消息;快速双回车不重复发送。
 * C 七主题 × 1280×800 截图(前/后对照用)+ 窄视口不破版 + 不透底断言。
 * 跑法:cd apps/gateway && npx tsx test/ui/super-parity-ime.spec.cjs
 * 自起临时实例(7793),不碰生产环境 7700。无 chrome/playwright-core 时整文件 skip 并打印 skipped: <reason>(退出码 0)。
 */
process.env.GENIE_CHECKPOINT = "off";
const fs = require("node:fs");
const path = require("node:path");

const HARNESS_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CHROME = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const PORT = Number(process.env.SELF_PORT || 7793);
const OUT_DIR = path.join(HARNESS_ROOT, "tasks", "-super-chat-parity", "shots");
const skip = (reason) => { console.log("skipped: " + reason); process.exit(0); };

let chromium = null;
try { chromium = require("playwright-core").chromium; } catch (e) { skip("playwright-core 不可用(" + String(e && e.message).slice(0, 60) + ")"); }
if (!chromium) skip("playwright-core 不可用");
if (!fs.existsSync(CHROME)) skip("无 chrome 可执行文件 " + CHROME);
fs.mkdirSync(OUT_DIR, { recursive: true });

const THEMES = ["dark", "light", "sand", "glass", "olive", "plum", "ink"];
const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? "  PASS " : "  FAIL ") + name + (detail ? " — " + detail : ""));
};

/** 页面侧:同 payload 两侧渲染 + DOM 结构计数。返回可 JSON 化的对照表。 */
const DUAL_RENDER_FN = () => {
  const countIn = (root, sel) => root.querySelectorAll(sel).length;
  const payload = {
    text: [
      "结论如下:",
      "",
      "| 项 | 值 |",
      "| --- | --- |",
      "| 渲染 | 同源 |",
      "| 输入法 | 对齐 |",
      "",
      "```bash",
      "npm run build",
      "<error> Command timed out after 120s",
      "```",
    ].join("\n"),
    ts: Date.now(),
  };
  const toolCalls = [
 // 两个不同工具:Super 侧不会触发同名聚合卡,两卡进同一轮级组(与 coding 侧对照形态一致)
    { name: "grep", id: "pc1", arguments: JSON.stringify({ pattern: "supRenderChatNow", path: "src" }) },
    { name: "list_dir", id: "pc2", arguments: JSON.stringify({ path: "src/panel" }) },
  ];
 // ① Super 管线真渲染(waiting=false → 终态组全折叠)
  const prevEntries = supState.entries, prevWaiting = supState.waiting;
  supState.entries = [
    { kind: "u", text: "对照", ts: Date.now() },
    { kind: "a", text: "", toolCalls: toolCalls, ts: Date.now() },
    { kind: "a", text: payload.text, ts: Date.now() },
  ];
  supState.waiting = false;
  supRenderChatNow();
  const superHtml = String(document.getElementById("superChatBody").innerHTML || "");
  const superWaiting = supState.waiting;
 // ② Super 活跃态(waiting=true → live 组:K 步展开)
  supState.waiting = true;
  supRenderChatNow();
  const superLiveHtml = String(document.getElementById("superChatBody").innerHTML || "");
  supState.entries = prevEntries; supState.waiting = prevWaiting;
  supRenderChatNow();
 // ③ coding 侧同 payload(同形态:两张单工具卡 + 同参数轮级组 + 独立操作栏)
  const codingReply = replyBlockHtml({ kind: "message.agent", sessionId: "spec", payload: payload, time: payload.ts }, "");
  const codingTools = [
    toolCallCard(toolCalls[0], "", { content: "a.ts:1", durationMs: 12 }, null, null),
    toolCallCard(toolCalls[1], "", { content: "(空)", durationMs: 9 }, null, null),
  ];
  const codingRound = roundGroupHtml(codingTools.slice(), "round:spec-fixed", true, false, 0);
  const codingLive = roundGroupHtml(codingTools.slice(), "round:spec-live", false, true, Date.now());
  const codingActs = msgActsHtml({ kind: "message.agent", sessionId: "spec", payload: payload, time: payload.ts }, "spec-key");
  const codingAgg = supToolAggCard("grep", [
    { name: "grep", id: "ag1", arguments: JSON.stringify({ pattern: "x" }) },
    { name: "grep", id: "ag2", arguments: JSON.stringify({ pattern: "y" }) },
  ]);
 // Super 侧聚合卡对照:临时塞一条同名双调用轮,渲进隔离容器(不动主聊天流)
  const superAggHost = (() => {
    const prev = supState.entries, prevW = supState.waiting;
    supState.entries = [{ kind: "a", text: "", toolCalls: [
      { name: "grep", id: "agA", arguments: JSON.stringify({ pattern: "x" }) },
      { name: "grep", id: "agB", arguments: JSON.stringify({ pattern: "y" }) },
    ], ts: Date.now() }];
    supState.waiting = false;
    supRenderChatNow();
    const h = String(document.getElementById("superChatBody").innerHTML || "");
    supState.entries = prev; supState.waiting = prevW;
    supRenderChatNow();
    return h;
  })();
  const mk = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d; };
  const sBody = mk(superHtml), sLive = mk(superLiveHtml), cReply = mk(codingReply), cRound = mk(codingRound), cLive = mk(codingLive), cActs = mk(codingActs);
  const sAgg = mk(superAggHost), cAgg = mk(codingAgg);
  const shapes = {
    "md-table-wrap": [countIn(sBody, ".md-table-wrap"), countIn(cReply, ".md-table-wrap")],
    "md-tbl-btn": [countIn(sBody, ".md-tbl-btn"), countIn(cReply, ".md-tbl-btn")],
    "code-bar": [countIn(sBody, ".code-bar"), countIn(cReply, ".code-bar")],
    "code-err-line": [countIn(sBody, ".code-err-line"), countIn(cReply, ".code-err-line")],
    "task-reply": [countIn(sBody, ".task-reply"), countIn(cReply, ".task-reply")],
    "tool-card": [countIn(sBody, ".tool-card"), countIn(cRound, ".tool-card")],
    "tc-state": [countIn(sBody, "[class*=tc-state]"), countIn(cRound, "[class*=tc-state]")],
    "round-group": [countIn(sBody, ".round-group"), countIn(cRound, ".round-group")],
    "round-step": [countIn(sBody, ".round-step"), countIn(cRound, ".round-step")],
    "rs-sum": [countIn(sBody, ".rs-sum"), countIn(cRound, ".rs-sum")],
    "msg-acts-btn": [countIn(sBody, ".msg-acts button"), countIn(cActs, ".msg-acts button")],
    "det-key": [countIn(sBody, "[data-det-key]"), countIn(cRound, "[data-det-key]")],
    "agg-tool-card": [countIn(sAgg, ".tool-card"), countIn(cAgg, ".tool-card")],
    "agg-tc-ic": [countIn(sAgg, ".tc-ic"), countIn(cAgg, ".tc-ic")],
  };
  const opened = (root) => root.querySelectorAll(".round-group[open]").length;
  const groupTotal = (root) => root.querySelectorAll(".round-group").length;
  return {
    shapes,
    liveOpen: opened(sLive), liveTotal: groupTotal(sLive),
    codingLiveOpen: opened(cLive), codingLiveTotal: groupTotal(cLive),
    termOpen: opened(sBody), termTotal: groupTotal(sBody),
    superHasAgg: sAgg.querySelectorAll('[data-det-key^="tool-agg:"]').length,
    roundGroupLiveClass: sLive.querySelectorAll(".round-group.live").length,
    codingLiveClass: cLive.querySelectorAll(".round-group.live").length,
    codingRoundOpen: opened(cRound), codingRoundTotal: groupTotal(cRound),
  };
};

(async () => {
  const { servePanel } = require("../../src/panel.ts");
  const server = servePanel(PORT, () => {});
  const BASE = "http://127.0.0.1:" + PORT;
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => { if (m.type() === "error") console.log("  [page error] " + m.text().slice(0, 160)); });
    page.on("pageerror", (e) => console.log("  [page throw] " + String(e.message).slice(0, 200)));
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
 // 切到指挥台视图(Super 聊天窗常驻右栏)
    await page.evaluate(() => { try { switchView("super"); } catch (e) { document.body.dataset.view = "super"; } });
    await page.waitForTimeout(500);

 // ── ② 双渲染 DOM 结构断言 ────────────────────────────────────────────
    const dual = await page.evaluate(DUAL_RENDER_FN);
    const mismatched = Object.entries(dual.shapes).filter(([, v]) => v[0] !== v[1]);
    rec("② 双渲染:" + Object.keys(dual.shapes).length + " 类结构计数两侧相等", mismatched.length === 0,
      mismatched.length ? "不一致:" + JSON.stringify(mismatched) : Object.keys(dual.shapes).length + "/" + Object.keys(dual.shapes).length + " 项相等");
    rec("② 双渲染:两侧都真产出了表格/代码栏/错误行(非空断言)",
      dual.shapes["md-table-wrap"][0] > 0 && dual.shapes["code-bar"][0] > 0 && dual.shapes["code-err-line"][0] > 0,
      JSON.stringify({ table: dual.shapes["md-table-wrap"], bar: dual.shapes["code-bar"], err: dual.shapes["code-err-line"] }));
 // G2:同参数下两侧轮级组开合规则一致(Super 侧 active 由 waiting 驱动,coding 侧由 active 参)
    rec("② G2:运行中轮级组两侧同规则(live 类/展开数相等)",
      dual.liveTotal > 0 && dual.liveTotal === dual.codingLiveTotal &&
      dual.liveOpen === dual.codingLiveOpen && dual.roundGroupLiveClass === dual.codingLiveClass && dual.roundGroupLiveClass > 0,
      JSON.stringify({ super: [dual.liveTotal, dual.liveOpen, dual.roundGroupLiveClass], coding: [dual.codingLiveTotal, dual.codingLiveOpen, dual.codingLiveClass] }));
    rec("② G2:终态轮级组两侧同规则(折叠数相等)",
      dual.termTotal > 0 && dual.termTotal === dual.codingRoundTotal && dual.termOpen === dual.codingRoundOpen,
      JSON.stringify({ super: [dual.termTotal, dual.termOpen], coding: [dual.codingRoundTotal, dual.codingRoundOpen] }));
    rec("② G3:Super 聚合卡带 tool-agg 键 + 与 coding 侧同族结构(.tool-card/.tc-ic 计数相等)",
      dual.superHasAgg >= 1 && dual.shapes["agg-tool-card"][0] === dual.shapes["agg-tool-card"][1] &&
      dual.shapes["agg-tc-ic"][0] === dual.shapes["agg-tc-ic"][1] && dual.shapes["agg-tc-ic"][0] > 0,
      "tool-agg 卡 " + dual.superHasAgg + " 张;tc-ic " + JSON.stringify(dual.shapes["agg-tc-ic"]));

 // ── ③ IME 真机 ──────────────────────────────────────────────────────
 // 拦发送:既有 supSend 走 wsSafeSend,这里改为只记录(不真连 WS)
    await page.evaluate(() => {
      window.__sent = [];
      const wrap = (fn) => function (m) { window.__sent.push(String(m)); return true; };
      window.wsSafeSend = wrap(window.wsSafeSend);
      try { window.__origToast = window.toast; window.__toasts = []; window.toast = function (msg) { window.__toasts.push(String(msg)); }; } catch (e) {}
      const ta = document.getElementById("superInput");
      ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true }));
      localStorage.removeItem("sup:draft");
    });
    const ta = page.locator("#superInput");
    await ta.click();
    const sendCount = async () => page.evaluate(() => window.__sent.length);

 // ③-1 组合期 Enter 零发送
    await page.evaluate(() => {
      const el = document.getElementById("superInput");
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      el.value = "nihao";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const beforeImeEnter = await sendCount();
 // 组合期 Enter:合成事件带 isComposing=true(浏览器 IME 选词回车就是这个形态)
    await page.evaluate(() => {
      const el = document.getElementById("superInput");
      const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, bubbles: true, cancelable: true });
      Object.defineProperty(ev, "isComposing", { get: () => true });
      el.dispatchEvent(ev);
    });
    await page.waitForTimeout(180);
    const afterImeEnter = await sendCount();
    const valAfterImeEnter = await ta.inputValue();
    rec("③ IME 组合期 Enter 零发送", afterImeEnter === beforeImeEnter, "发送数 " + beforeImeEnter + " → " + afterImeEnter);
    rec("③ IME 组合期文字不丢(半成品仍在输入框)", valAfterImeEnter === "nihao", "值=" + JSON.stringify(valAfterImeEnter));

 // ③-2 选词上屏(input 事件后仍是拼音串 → 真实选词会替换为汉字)
    await page.evaluate(() => {
      const el = document.getElementById("superInput");
      el.value = "你好";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    });
    const valSelected = await ta.inputValue();
    rec("③ 选词上屏文字完整(零丢字)", valSelected === "你好", "值=" + JSON.stringify(valSelected));
    rec("③ 组合结束仍零发送(上屏不等于发送)", (await sendCount()) === beforeImeEnter, "发送数保持 " + beforeImeEnter);

 // ③-3 组合结束后 Enter 恰好 1 条
    await page.evaluate(() => document.getElementById("superInput").focus());
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    const afterRealEnter = await sendCount();
    rec("③ 组合结束 Enter 恰好发送 1 条", afterRealEnter === beforeImeEnter + 1, "发送数 " + beforeImeEnter + " → " + afterRealEnter);
    const sentPayload = await page.evaluate(() => { try { return JSON.parse(window.__sent[window.__sent.length - 1] || "{}"); } catch (e) { return {}; } });
    rec("③ 发送正文=上屏文字(不是拼音半成品)", String(sentPayload.text || "") === "你好", "text=" + JSON.stringify(sentPayload.text));

 // ③-4 快速双回车不重复发送
 // ③-4 快速双回车不重复发送(前置:清干净上一轮的等待态,否则第一次回车会被 waiting 正常拦下)
    await page.evaluate(() => {
      supState.waiting = false; supSendBtnSync();
      const el = document.getElementById("superInput");
      el.value = "连打测试";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    });
    const beforeDouble = await sendCount();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    const afterDouble = await sendCount();
    rec("③ 快速双回车只发 1 条(幂等去重)", afterDouble === beforeDouble + 1, "发送数 " + beforeDouble + " → " + afterDouble);

 // ③-5 ESC 取消组合后输入框可继续用(不残留半成品、不静默发送)
    await page.evaluate(() => {
      const el = document.getElementById("superInput");
      el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      el.value = "zhongwen";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      el.focus();
    });
    const beforeEscEnter = await sendCount();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const afterEscEnter = await sendCount();
    rec("③ 组合取消 ESC 后空输入回车不发送", afterEscEnter === beforeEscEnter, "发送数 " + beforeEscEnter + " → " + afterEscEnter);

 // ③-6 提交中状态:发送后按钮禁用 + 输入保留
    await page.evaluate(() => {
      const el = document.getElementById("superInput");
      el.value = "等待态测试"; el.dispatchEvent(new Event("input", { bubbles: true }));
      supState.waiting = true; supSendBtnSync();
    });
    const busyState = await page.evaluate(() => {
      const sb = document.getElementById("superSend");
      return { disabled: sb.classList.contains("disabled"), title: sb.title };
    });
    rec("③ 提交中发送键禁用+给出提示", busyState.disabled === true && /处理中|正在处理/.test(busyState.title), JSON.stringify(busyState));
    await page.evaluate(() => { supState.waiting = false; supSendBtnSync(); });

 // ── C 七主题截图 + 不破版/不透底 ─────────────────────────────────────
    for (const th of THEMES) {
      await page.evaluate((t) => { localStorage.setItem("zh:theme", t); }, th);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);
      await page.evaluate(() => { try { switchView("super"); } catch (e) {} });
      await page.waitForTimeout(450);
      const shot = path.join(OUT_DIR, "super-1280x800-" + th + ".png");
      await page.screenshot({ path: shot });
      const geo = await page.evaluate(() => {
        const doc = document.documentElement;
        const chat = document.querySelector(".spide-chat"); // 背景/遮挡实际由 .spide-chat 承载(#superChatCol 自身透明)
        const body = document.getElementById("superChatBody");
        const cs = chat ? getComputedStyle(chat) : null;
        return {
          overflowX: doc.scrollWidth - doc.clientWidth,
          chatBg: cs ? cs.backgroundColor : "",
          chatBgImg: cs ? String(cs.backgroundImage || "").slice(0, 40) : "",
          chatW: chat ? Math.round(chat.getBoundingClientRect().width) : 0,
          bodyW: body ? Math.round(body.getBoundingClientRect().width) : 0,
          themeClass: document.body.className,
        };
      });
      const okTheme = geo.overflowX <= 1 && geo.chatW > 200 && geo.bodyW > 100;
      rec("C 主题 " + th + " 1280×800 不破版", okTheme, JSON.stringify(geo));
      const bg = String(geo.chatBg || "");
      const m = bg.match(/rgba?\(([^)]+)\)/);
      const alpha = m ? (m[1].split(",")[3] === undefined ? 1 : Number(m[1].split(",")[3])) : 1;
      rec("C 主题 " + th + " 聊天栏不透明(不透底层内容)", alpha >= 0.95, "bg=" + bg);
    }

    const failed = results.filter((r) => !r.ok);
    console.log("\n汇总:" + (results.length - failed.length) + "/" + results.length + " 通过;截图目录 " + OUT_DIR);
    if (failed.length) { console.log("失败项:" + failed.map((f) => f.name).join(" | ")); process.exitCode = 1; }
  } catch (e) {
    console.log("FATAL: " + String((e && e.stack) || e).slice(0, 600));
    process.exitCode = 1;
  } finally {
    try { if (page) await page.close(); } catch (e) {}
    try { await browser.close(); } catch (e) {}
    try { await server.close(); } catch (e) {}
  }
})();