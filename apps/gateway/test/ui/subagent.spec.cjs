/** UI 经验证:B 子代理过程卡状态流转+实时 tail + A 工具结果渲染(喂真实转录形态)。
 * 自启跑法:npx tsx test/ui/_ui_selfhost.cjs --opts test/ui/_subagent.opts.cjs test/ui/subagent.spec.cjs */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SID = "spec-sess-ui";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 200)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 160) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 预置:固定会话(刷新后 sessionStorage 存活)+ 关闭探索分组(code_sense 走单卡路径,A 检查可达)
  await page.addInitScript(([sid]) => {
    sessionStorage.setItem("zh:sid", sid);
    localStorage.setItem("zh:g-search", "off");
    localStorage.setItem("zh:g-term", "off");
  }, [SID]);

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  // 1. 提交任务(脚本 LLM 会派一个后台子代理)
  await page.fill("#instruction", "UI 实测:派子代理调查渲染链路");
  await page.click("#go");

  // 2. 子代理过程卡出现
  let appeared = false;
  for (let i = 0; i < 40 && !appeared; i++) { await sleep(500); appeared = (await page.locator("details.sub-card").count()) > 0; }
  check("子代理过程卡出现", appeared);
  if (!appeared) { await page.screenshot({ path: "/tmp/ui-subagent-fail.png" }); await browser.close(); process.exit(1); }

  const sum = await page.locator("details.sub-card summary").first().textContent();
  check("卡头含角色与任务摘要", sum.includes("子代理 explore") && sum.includes("调查整仓渲染链路并汇总输出"), sum.slice(0, 80));

  // 3. 运行中状态 + 实时 tail(子代理 6s,轮询 3s——运行窗内必有一次 poll 带 tail)
  let sawRunning = false, sawTail = false;
  for (let i = 0; i < 20; i++) {
    const st = await page.locator("details.sub-card .sub-st").first().textContent().catch(() => "");
    if (st.indexOf("运行中") >= 0) {
      sawRunning = true;
      const open = await page.locator("details.sub-card[open]").count();
      const tail = await page.locator("details.sub-card .sub-tail").first().textContent().catch(() => "");
      if (open > 0 && tail.indexOf("[progress]") >= 0) { sawTail = true; break; }
    }
    if (st.indexOf("完成") >= 0 || st.indexOf("失败") >= 0) break;
    await sleep(500);
  }
  check("运行中状态可见(已工作计时)", sawRunning);
  check("运行中实时 tail 可见(展开态含 [progress])", sawTail);

  // 4. 流转到终态(完成)且结果文本进卡体
  let done = false, doneText = "";
  for (let i = 0; i < 50 && !done; i++) {
    await sleep(500);
    const st = await page.locator("details.sub-card .sub-st").first().textContent().catch(() => "");
    if (st.indexOf("完成") >= 0) { done = true; doneText = st; }
  }
  check("状态流转到完成", done, doneText);
  const tailAfter = await page.locator("details.sub-card .sub-tail").first().textContent().catch(() => "");
  check("终态结果文本进卡体", tailAfter.indexOf("子代理调查完成") >= 0, tailAfter.slice(0, 80));

  // 5. async JSON 回执被过程卡吸收(不再重复出「↳ 结果」卡);调用卡一并吸收
  const dupCards = await page.locator(".tool-card:not(.sub-card)", { hasText: "async_launched" }).count();
  check("async JSON 回执不重复出卡", dupCards === 0, "count=" + dupCards);
  const dupCallCards = await page.locator(".tool-card:not(.sub-card)", { hasText: "spawn_subagent" }).count();
  check("spawn_subagent 调用卡被过程卡吸收", dupCallCards === 0, "count=" + dupCallCards);

  // 6. A 喂转录:向同会话注入 code_sense 形态工具结果(协议标签残留+CR+ANSI+超长),刷新断言渲染。
  // 注入走 node 侧 __selfhostApp.journal(spec 与宿主同进程;页面内无宿主对象)。
  const NL3 = String.fromCharCode(10);
  const CR3 = String.fromCharCode(13);
  const ESC3 = String.fromCharCode(27);
  const injected = (() => {
    const app = globalThis.__selfhostApp;
    if (!app || !app.journal) return "no-app";
    const long = Array.from({ length: 260 }, (_, i) => "  → sym" + i + " @ apps/gateway/src/panel.ts:" + (100 + i)).join(NL3);
    const content = "[code_sense debug] · 项目态=MATURE" + NL3 + "圆心(定义处): renderHistory — apps/gateway/src/panel.ts:3300" + NL3 + "行中残留</tool_result>标签" + NL3 + "状态:" + ESC3 + "[31m红色" + ESC3 + "[0m 完成" + NL3 + "progress 1" + CR3 + "progress 2" + CR3 + "done" + NL3 + long;
    app.journal.append({ kind: "message.agent", sessionId: SID, payload: { text: "我用 code_sense 查了渲染链路", toolCalls: [{ id: "cs1", name: "code_sense", arguments: JSON.stringify({ query: "renderHistory", mode: "debug" }) }] } });
    app.journal.append({ kind: "tool.result", sessionId: SID, payload: { toolCallId: "cs1", name: "code_sense", content, durationMs: 12 } });
    return "ok";
  })();
  check("journal 注入成功", injected === "ok", String(injected));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const body = await page.locator("#chatBody").innerHTML();
  check("喂转录:协议标签不再可见", body.indexOf("tool_result") < 0);
  check("喂转录:ANSI 色码剥离", body.indexOf(String.fromCharCode(27)) < 0);
  check("喂转录:CR 进度行转可读换行", body.indexOf("progress 2") >= 0 && body.indexOf("progress 1" + "progress 2") < 0);
  check("喂转录:code_sense 正文渲染(单卡路径)", body.indexOf("[code_sense debug]") >= 0 && (await page.locator(".tool-card:not(.sub-card)").count()) > 0);
  const expandable = await page.locator(".tr-more summary").count();
  check("喂转录:超长输出有展开全文", expandable >= 1, "tr-more=" + expandable);
  // 展开全文原生开合(父 details 先展开,嵌套 summary 才可见可点)
  if (expandable > 0) {
    const parent = page.locator(".tool-card:has(.tr-more)").first();
    if (!(await parent.getAttribute("open"))) await parent.locator("summary").first().click();
    await page.locator(".tr-more summary").first().click();
    await page.waitForTimeout(200);
    const opened = await page.locator(".tr-more[open]").count();
    check("展开全文可开合(details 原生)", opened >= 1);
  }

  check("0 pageerror", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-subagent.png" });
  await browser.close();
  const fails = results.filter((r) => !r.ok).length;
  console.log("subagent.spec: " + (results.length - fails) + "/" + results.length);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
