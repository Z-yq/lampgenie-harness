/** UI 实测(2026-10-16 用户口径:「点击其中运行的一个智能体后,要弹出它的工作区tab页,显示它的所有动作
 * 和消息(就如vibe coding agent的工作区一样)」)。自启跑法:
 * npx tsx test/ui/_ui_selfhost.cjs --opts test/ui/_subws.opts.cjs test/ui/subws.spec.cjs
 * 断言面:①目录条目「工作区」按钮开 tab(主会话恒第一位不可关/激活态)②运行中子代理事件实时进 tab
 * (echo-child→进程内 LlmLoopBackend 真事件链,dashboard.changed→节流拉史通道)③主会话流零污染
 * (subagent.event 不双渲染——重点断言,live+历史重放两面)④tab 关闭/重开+已完成子代理从 journal 重放
 * ⑤外部后端降级(无 loop 事件=进度行时间线+诚实标注)⑥tab 跨页面刷新持久(localStorage+journal 重放)。
 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "spec-sess-subws";
const HIST = "spec-sess-subws-hist";
const WS_MARKER = "ws-only-marker-9137"; // 与 _subws.opts.cjs 约定:只允许出现在工作区事件里的标记
const HIST_MARKER = "hist-only-marker-4242";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(5000);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 160) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gotoSession = async (sid) => {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  // 2026-10-21 画布分流/分身独立看板:画布形态下白板 chip=定位白板卡、目录条目=定位消息分组、
    // 会话流不渲染子代理过程卡——本规格守经典契约(浮窗/工作区 tab/会话流过程卡),先切经典布局。
      await page.waitForTimeout(600);
      await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
    await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
    await page.evaluate((s) => sessionStorage.setItem("zh:sid", s), sid);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
  };

  await page.addInitScript(() => {
    localStorage.setItem("zh:g-search", "off");
    localStorage.setItem("zh:g-term", "off");
  });
  await gotoSession(SID);

  // ── 1. 提交任务:主 agent 派一个后台子代理(echo-child→进程内 LlmLoopBackend,真 loop 事件)──
  await page.fill("#instruction", "子代理工作区实测:派勘察子代理并回放它的动作流");
  try { await page.click("#go", { timeout: 5000 }); } catch (e) {
    await page.screenshot({ path: "/tmp/ui-subws-clickfail.png" });
    const stopMode = (await page.locator("#go.stop").count()) > 0;
    if (!stopMode) { await page.click("#go", { timeout: 8000 }); }
  }

  // 2. 子代理过程卡出现(spawn 成功)
  let card = false;
  for (let i = 0; i < 30 && !card; i++) { await sleep(500); card = (await page.locator("details.sub-card:not(.sub-wait)").count()) >= 1; }
  check("子代理过程卡出现(spawn 成功)", card);
  if (!card) { await page.screenshot({ path: "/tmp/ui-subws-fail.png" }); await browser.close(); process.exit(1); }

  // 3. 目录打开 → 点条目主区域(一级入口,step-062)开 tab;「详情」钮=下钻轻展开新挂点
  await page.click("#subDirBtn");
  let entry = false;
  for (let i = 0; i < 16 && !entry; i++) { await sleep(500); entry = (await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).count()) >= 1; }
  check("目录条目出现(渲染勘察)", entry);
  const moreN = await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator("[data-submore]").count();
  check("条目带「详情」轻展开钮(下钻新挂点)", moreN === 1, "count=" + moreN);
  await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(600);

  // 4. tab 条形态:主会话恒第一位不可关 + 子代理 tab 激活
  const barOn = await page.locator("#wsTabbar.on").count();
  check("工作区 tab 条出现", barOn === 1);
  const tabLabels = await page.locator("#wsTabbar .ws-tab .wt-label").allTextContents();
  check("主会话 tab 恒第一位", tabLabels.length >= 2 && tabLabels[0] === "主会话", tabLabels.join("|"));
  const mainClosable = await page.locator('#wsTabbar .ws-tab[data-wstab=""] .wt-x').count();
  check("主会话 tab 不可关闭", mainClosable === 0);
  const agentChipOn = await page.locator("#wsTabbar .ws-tab.on .wt-label").first().textContent().catch(() => "");
  check("子代理 tab 激活(标题=渲染勘察)", agentChipOn.indexOf("渲染勘察") >= 0, agentChipOn);
  const headTxt = await page.locator("#chatBody .ws-head").textContent().catch(() => "");
  check("工作区头部:任务书全文+模型行", headTxt.indexOf("在仓库内检索 demoMain") >= 0 && headTxt.indexOf("模型:") >= 0, headTxt.slice(0, 80));

  // 5. 运行中实时增量:子代理事件流进 tab(先于终态打开,观察事件数增长+结构化行出现)
  const n1 = await page.evaluate("window.__mature && window.__mature.subws ? window.__mature.subws().events : -1");
  let sawMarker = false, n2 = n1;
  for (let i = 0; i < 24 && !sawMarker; i++) {
    await sleep(500);
    sawMarker = (await page.locator("#chatBody", { hasText: WS_MARKER }).count()) >= 1;
    n2 = await page.evaluate("window.__mature && window.__mature.subws ? window.__mature.subws().events : -1");
  }
  check("运行中:工作区实时出现子代理动作流(标记文本入 tab)", sawMarker, "events " + n1 + "->" + n2);
  check("运行中:事件数实时增长(拉史增量通道)", n2 > n1, "events " + n1 + "->" + n2);
  const stepLines = await page.locator("#chatBody .ws-step").count();
  check("工作区结构化行(step/tool 行)在场", stepLines >= 1, "count=" + stepLines);
  await page.screenshot({ path: "/tmp/ui-subws-live.png" });

  // 6. 重点断言:切回主会话——主流零污染(subagent.event 不双渲染)
  await page.locator('#wsTabbar .ws-tab[data-wstab=""]').click();
  await page.waitForTimeout(500);
  const mainBody = await page.locator("#chatBody").textContent();
  check("主会话 tab 切回(用户消息/过程卡在)", mainBody.indexOf("子代理工作区实测") >= 0 && (await page.locator("#chatBody details.sub-card").count()) >= 1);
  check("主会话流零污染:工作区标记文本不出现在主流", mainBody.indexOf(WS_MARKER) < 0, "主流含标记=双渲染");
  const evInMain = await page.evaluate("window.__mature.subws().events");
  check("journal 里工作区事件在账(切回即重放,不丢)", evInMain > 0, "events=" + evInMain);

  // 7. 切回子代理 tab:内容从 histEvents 重放
  await page.locator("#wsTabbar .ws-tab.on, #wsTabbar .ws-tab").nth(1).click();
  await page.waitForTimeout(400);
  const againMarker = (await page.locator("#chatBody", { hasText: WS_MARKER }).count()) >= 1;
  check("切回子代理 tab:事件流重放(标记仍在)", againMarker);

  // 8. 关闭 tab:回主会话,tab 条隐藏(集合空)
  await page.locator("#wsTabbar [data-wsclose]").first().click();
  await page.waitForTimeout(400);
  const barOff = await page.locator("#wsTabbar.on").count();
  check("关闭 tab:集合空则 tab 条隐藏", barOff === 0);
  const backMain = (await page.locator("#chatBody details.sub-card").count()) >= 1;
  check("关闭后回主会话渲染", backMain);
  await page.screenshot({ path: "/tmp/ui-subws-closed.png" });

  // 9. 已完成子代理重开:从 journal 全量重放(终态+全程事件)
  let doneTxt = "";
  for (let i = 0; i < 24 && !doneTxt; i++) {
    await sleep(500);
    const st = await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator(".sd-st").textContent({ timeout: 400 }).catch(() => "");
    if (st && st.indexOf("完成") >= 0) doneTxt = st;
  }
  check("子代理完成(目录终态翻绿)", !!doneTxt, doneTxt);
  if (!subDirStillOpen(page)) await page.click("#subDirBtn");
  await page.waitForTimeout(400);
  await page.locator("#subDirBody .sd-item", { hasText: "渲染勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(600);
  const repBody = await page.locator("#chatBody").textContent();
  check("已完成重放:全程动作流(标记+终稿报告)可见", repBody.indexOf(WS_MARKER) >= 0 && repBody.indexOf("子代理报告:检索完成") >= 0);
  check("已完成重放:头部终态卡(journal subagent.result)", (await page.locator("#chatBody .ws-head .ws-final").count()) === 1);
  await page.screenshot({ path: "/tmp/ui-subws-replay.png" });

  // ── 10. 历史会话注入:外部后端降级 + 结构化重放 + 主流零污染(重放面)──
  // 注入走 Node 侧 selfhost app(服务端 journal 直写;subdir.spec 同形态),随后 reload 重放。
  const injected = (() => {
    const app = globalThis.__selfhostApp;
    if (!app || !app.journal) return "no-app";
    const H = HIST;
    app.journal.append({ kind: "message.user", sessionId: H, payload: { text: "注入历史子代理会话" } });
    // 外部后端形态:无 subagent.event(降级时间线)+注册表缺席(不可回放标注)
    app.journal.append({ kind: "subagent.spawn", sessionId: H, payload: { taskId: "tk-h1", agentId: "agent_hist_ext", instructions: "外部后端勘察任务书(全程轨迹在 output.txt)", title: "外部勘察" } });
    app.journal.append({ kind: "subagent.result", sessionId: H, payload: { taskId: "tk-h1", agentId: "agent_hist_ext", event: { type: "result", ok: true, finalText: "外部终稿:勘察完成。" } } });
    // 进程内形态:结构化 subagent.event 序列(journal 重放素材)
    app.journal.append({ kind: "subagent.spawn", sessionId: H, payload: { taskId: "tk-h2", agentId: "agent_hist_ws", instructions: "结构化勘察任务书(带 loop 事件回放)", title: "结构勘察" } });
    const t = Date.now();
    app.journal.append({ kind: "subagent.event", sessionId: H, time: t, payload: { agentId: "agent_hist_ws", kind: "step.start", turn: 1, step: 0 } });
    app.journal.append({ kind: "subagent.event", sessionId: H, time: t + 10, payload: { agentId: "agent_hist_ws", kind: "message.agent", text: "中途发现:标记物 " + HIST_MARKER + " 在 demo.ts。", llmMs: 800, turn: 1, step: 0 } });
    app.journal.append({ kind: "subagent.event", sessionId: H, time: t + 20, payload: { agentId: "agent_hist_ws", kind: "tool.call", toolCallId: "h1", name: "grep", arguments: JSON.stringify({ pattern: "demoMain" }) } });
    app.journal.append({ kind: "subagent.event", sessionId: H, time: t + 30, payload: { agentId: "agent_hist_ws", kind: "tool.result", toolCallId: "h1", name: "grep", content: "src/demo.ts:1: export function demoMain()", durationMs: 12 } });
    app.journal.append({ kind: "subagent.event", sessionId: H, time: t + 40, payload: { agentId: "agent_hist_ws", kind: "step.end", turn: 1, step: 0, reason: "completed" } });
    app.journal.append({ kind: "subagent.result", sessionId: H, payload: { taskId: "tk-h2", agentId: "agent_hist_ws", event: { type: "result", ok: true, finalText: "结构勘察终稿:一处定义两处引用。" } } });
    return "ok";
  })();
  check("journal 注入成功(历史双形态)", injected === "ok", String(injected));

  await gotoSession(HIST);
  // 主会话零污染(重放面):subagent.event 不入主流
  const histMain = await page.locator("#chatBody").textContent();
  check("历史重放:主流零污染(注入标记不在主流)", histMain.indexOf(HIST_MARKER) < 0, "主流含标记=双渲染");
  // 外部后端降级:无 loop 事件 → 进度行时间线+诚实标注
  await page.click("#subDirBtn");
  await page.waitForTimeout(400);
  await page.locator("#subDirBody .sd-item", { hasText: "外部勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(500);
  const extBody = await page.locator("#chatBody").textContent();
  check("外部后端降级:诚实标注无结构化动作流", extBody.indexOf("无结构化动作流") >= 0, extBody.slice(0, 80));
  check("外部后端降级:历史不可回放如实提示", extBody.indexOf("不可回放") >= 0);
  // 结构化重放:journal 事件序列回放 + 主渲染器复用
  await page.locator("#subDirBody .sd-item", { hasText: "结构勘察" }).locator("summary .sd-label").first().click();
  await page.waitForTimeout(500);
  const wsRepBody = await page.locator("#chatBody").textContent();
  check("结构化重放:事件流文本在(journal 重放)", wsRepBody.indexOf(HIST_MARKER) >= 0);
  check("结构化重放:工具结果卡复用主渲染器", (await page.locator("#chatBody .tool-card").count()) >= 1);
  check("结构化重放:step 行+终态卡", (await page.locator("#chatBody .ws-step").count()) >= 2 && (await page.locator("#chatBody .ws-final").count()) === 1);

  // ── 11. tab 跨页面刷新持久(localStorage 打开集 + journal 重放)──
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const barOn2 = await page.locator("#wsTabbar.on").count();
  const chips2 = await page.locator("#wsTabbar .ws-tab .wt-label").allTextContents();
  check("刷新后 tab 集合恢复(主会话+两个历史子代理)", barOn2 === 1 && chips2.length === 3, chips2.join("|"));
  const activeAfterReload = await page.evaluate("window.__mature.subws().active");
  check("刷新后激活态归位主会话", activeAfterReload === "");
  await page.locator("#wsTabbar .ws-tab").nth(2).click();
  await page.waitForTimeout(500);
  const persistMarker = (await page.locator("#chatBody", { hasText: HIST_MARKER }).count()) >= 1;
  check("刷新后点开 tab:内容从 journal 重放重建", persistMarker);
  await page.screenshot({ path: "/tmp/ui-subws-hist.png" });

  // pageerror 口径:WS 半开竞态族为登记过的环境偶发,不记失败;其余记失败。
  const realErrs = consoleErrors.filter((x) => x.indexOf("Still in CONNECTING state") < 0);
  check("0 pageerror", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("subws.spec: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });

function subDirStillOpen(page) {
  // 目录抽屉开着就不用再点开(点 #subDirBtn 会收起)
  return page.locator("#subDir.on").count().then((n) => n > 0).catch(() => false);
}
