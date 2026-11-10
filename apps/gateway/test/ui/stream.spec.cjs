/** UI 经验证:流式消息展示(ZCode 模式移植)——打字光标/文本增长/工具执行中卡/终稿收尾/真事件让位。
 * 全部走页面真实渲染路径:__stPush 驱动 stream 状态机(与 ws 消息同入口),session.history.result 用 ws.onmessage 直注(真事件让位分支)。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Notification")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const stPush = (sid, ev) => page.evaluate(([s, e]) => window.__stPush(s, e), [sid, ev]);
  const inject = (m) => page.evaluate((x) => ws.onmessage({ data: JSON.stringify(x) }), m);

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

 // ---- 前置:直设会话态(不开真任务——生产环境 7700 挂真 LLM,真流式事件会与本 spec 推送互相复位)----
  await page.evaluate(() => { currentSid = "spec-stream"; histEvents = []; renderHistory(); });
  check("会话就绪(currentSid 在位)", (await page.evaluate(() => currentSid)) === "spec-stream");

  // ---- 1. llm-begin + delta:草稿块出现,文本逐块增长,光标在闪 ----
  await stPush("spec-stream", { type: "llm-begin" });
  await stPush("spec-stream", { type: "llm-delta", text: "正在" });
  await page.waitForTimeout(120);
  await stPush("spec-stream", { type: "llm-delta", text: "分析项目" });
  await page.waitForTimeout(200);
  const draftText1 = await page.locator("#chatBody .task-reply").last().textContent();
  check("流式文本增长(两块 delta 聚合)", draftText1 === "正在分析项目", "got=" + JSON.stringify(draftText1));
  check("打字光标在位(生成中)", await page.locator("#chatBody .st-cursor").count() === 1);

  // ---- 2. 思考流:reasoning delta → 思考卡(生成中) ----
  await stPush("spec-stream", { type: "llm-delta", reasoning: "先扫描目录" });
  await page.waitForTimeout(200);
  check("思考卡(生成中)在位", (await page.locator("#chatBody .think-card").last().textContent()).includes("先扫描目录"));

  // ---- 3. llm-end:终稿替换,光标消失 ----
  await stPush("spec-stream", { type: "llm-end", text: "分析完成,共 3 个模块" });
  await page.waitForTimeout(200);
  const finalText = await page.locator("#chatBody .task-reply").last().textContent();
  check("llm-end 终稿替换", finalText === "分析完成,共 3 个模块", "got=" + JSON.stringify(finalText));
  check("光标随终稿消失", await page.locator("#chatBody .st-cursor").count() === 0);

  // ---- 4. 工具执行中卡:begin→执行中(run 态) / end→完成+时长 ----
  await stPush("spec-stream", { type: "tool-begin", callId: "c1", name: "search_files" });
  await page.waitForTimeout(120);
  const toolRow1 = await page.locator("#chatBody .st-tool.run").last().textContent();
  check("工具执行中卡(run 态)", toolRow1.includes("search_files") && toolRow1.includes("执行中"), "got=" + toolRow1);
  await stPush("spec-stream", { type: "tool-end", callId: "c1", name: "search_files", durationMs: 42 });
  await page.waitForTimeout(120);
  const toolRow2 = await page.locator("#chatBody .st-tool").last().textContent();
  check("工具完成态(时长回填)", toolRow2.includes("完成") && toolRow2.includes("42ms") && (await page.locator("#chatBody .st-tool.run").count()) === 0, "got=" + toolRow2);

  // ---- 5. 真事件让位:message.agent 覆盖终稿→草稿退役;tool.result 覆盖→工具行撤 ----
  // (真实时序:loop 在 chat 返回后才 append message.agent,与 llm-end 同拍——草稿必为 done 态)
  await stPush("spec-stream", { type: "llm-begin" });
  await stPush("spec-stream", { type: "llm-delta", text: "让位测试" });
  await stPush("spec-stream", { type: "llm-end", text: "让位测试" });
  await stPush("spec-stream", { type: "tool-begin", callId: "c9", name: "read_file" });
  await page.waitForTimeout(200);
  await inject({ v: 1, type: "session.history.result", sessionId: "spec-stream", events: [
    { seq: 9001, kind: "message.agent", payload: { text: "让位测试" } },
    { seq: 9002, kind: "tool.result", payload: { toolCallId: "c9", name: "read_file", content: "ok" } },
  ] });
  await page.waitForTimeout(200);
  check("真 message.agent 到达→流式草稿退役(不双行)", (await page.locator("#chatBody .task-reply").count()) === 1, "replies=" + (await page.locator("#chatBody .task-reply").count()));
  check("真 tool.result 到达→执行中行撤除", (await page.locator("#chatBody .st-tool").count()) === 0, "rows=" + (await page.locator("#chatBody .st-tool").count()));

  // ---- 6. 会话切换清尾:切走再切回,流式尾块不残留 ----
  await stPush("spec-stream", { type: "llm-delta", text: "残留测试" });
  await page.waitForTimeout(150);
  await page.evaluate(() => newDraft());
  await page.waitForTimeout(150);
  check("切草稿(newDraft)清流式尾块", (await page.locator("#chatBody .task-reply").count()) === 0);

  check("零 console/page 错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();
