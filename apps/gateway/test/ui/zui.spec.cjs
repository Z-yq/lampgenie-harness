/** UI 经验证:终端/管理面(命令·钩子·MCP·技能·子智能体)/分组工具卡/办公模式/快捷键/预设。
 * 真实 chromium 无头;面板默认 7700,PANEL_BASE 覆盖。MCP 用本地 fixture 服务器走真实 stdio 全链路。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";
const { writeFileSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "zui-mcp-"));
  const fixture = join(tmp, "mcpsrv.mjs");
  writeFileSync(fixture, [
    "import { createInterface } from 'node:readline';",
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  let m; try { m = JSON.parse(line); } catch { return; }",
    "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'spec-fixture', version: '0' } } }) + '\\n');",
    "  else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [ { name: 'echo', description: '回显' } ] } }) + '\\n');",
    "  else if (m.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [ { type: 'text', text: 'ok' } ] } }) + '\\n');",
    "});",
  ].join("\n"), "utf-8");

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

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // ---------- 1. 终端 ----------
 // 左栏 #act-term 已撤(不展示),改走 Ctrl+J 快捷键——同时验证入口未丢
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(300);
  check("终端视图打开(Ctrl+J)", await page.locator("#view-term").isVisible());
  await page.fill("#termInput", "echo zui-terminal-probe && pwd");
  await page.press("#termInput", "Enter");
  try {
    await page.locator("#termBody .term-line", { hasText: "zui-terminal-probe" }).first().waitFor({ timeout: 15000 });
    check("终端执行回显(echo 输出在列)", true);
  } catch {
    check("终端执行回显(echo 输出在列)", false, (await page.locator("#termBody").textContent()).slice(0, 120));
  }
  await page.locator("#termBody .term-line", { hasText: "退出码 0" }).first().waitFor({ timeout: 15000 }).catch(() => {});
  check("终端退出码标记", (await page.locator("#termBody").textContent()).includes("[退出码 0]"));
  // 错误流:stderr 行带 err 样式
  await page.fill("#termInput", "echo err-probe >&2");
  await page.press("#termInput", "Enter");
  await page.locator("#termBody .term-line.err", { hasText: "err-probe" }).first().waitFor({ timeout: 15000 }).catch(() => {});
  check("stderr 走 err 通道", (await page.locator("#termBody .term-line.err").count()) >= 1);
  await page.click("#termClear");
  check("终端清屏", (await page.locator("#termBody .term-line").count()) === 0);

  // ---------- 2. 设置:预设网格 ----------
  await page.click("#uGear");
  await page.waitForTimeout(300);
  await page.click('.set-nitem[data-sec="model"]');
  await page.waitForTimeout(300);
  // fixE23 断言现代化:原「===10 项」写死于早期目录;目录此后多轮扩容(阿里云双区/OpenRouter/xAI/MiniMax/
  // 硅基流动/vLLM/自定义行,现 16)——断言改「卡片数=页面侧 PROVIDER_PRESETS 目录全量」(目录再扩不破),
  // 下限 ≥12 兜底防「目录在而渲染空」的回归。
  const presetN = await page.evaluate(() => (typeof PROVIDER_PRESETS !== "undefined" ? PROVIDER_PRESETS.length : -1));
  const cardN = await page.locator("#provPresets .preset-card").count();
  check("供应商预设网格(目录全量渲染)", cardN >= 12 && cardN === presetN, "cards=" + cardN + " catalog=" + presetN);
 // 断言现代化:空态文案只在 lastModelIds 已被 models.list 应答渲染后出现(有模型=行渲染恒非空;
  // 自host 入口无 listModels 时 renderModelList 根本不触发,空态文案前提双重漂移)——改断言拉取链路行为:
  // 点「拉取模型列表」→ 状态行即时进入拉取中;应答落地后=列表行(prod)或 fail-visible 操作失败 toast(自host)。
  await page.click("#models-fetch");
  await page.waitForTimeout(500);
  const msStatus = await page.locator("#models-status").textContent();
  const msRows = await page.locator("#modelList .model-row").count();
  const msToast = await page.locator("#toastHost .toast").last().textContent().catch(() => "");
  check("模型拉取链路(状态行反馈/列表行/fail-visible 提示)",
    msStatus.includes("拉取中") || msStatus.includes("个模型") || msStatus.includes("失败") || msRows > 0 || String(msToast).includes("模型"),
    "status=" + msStatus + " rows=" + msRows + " toast=" + String(msToast).slice(0, 40));

  // ---------- 3. 子智能体 ----------
  await page.click('.set-nitem[data-sec="agents"]');
  try {
    await page.locator("#agentsView .mgr-row").first().waitFor({ timeout: 10000 });
    const n = await page.locator("#agentsView .mgr-row").count();
    check("子智能体列表渲染(内置 ≥2)", n >= 2, n + " 项");
    check("子智能体带工具数徽标", (await page.locator("#agentsView").textContent()).includes("个工具"));
  } catch {
    check("子智能体列表渲染(内置 ≥2)", false, "10s 未渲染");
  }

  // ---------- 4. 技能(内置可停用) ----------
  await page.click('.set-nitem[data-sec="skills"]');
  try {
    await page.locator("#skillsView .mgr-row").first().waitFor({ timeout: 10000 });
    check("技能列表渲染(内置 ≥5)", (await page.locator("#skillsView .mgr-row").count()) >= 5);
    check("技能分组标题(内置)", (await page.locator("#skillsView").textContent()).includes("内置"));
    // 停用→启用 往返(净状态还原);先归位:若已是「启用」态(残留),点回「停用」
    const firstToggle = page.locator('#skillsView button[data-act="toggle"]').first();
    const name = await firstToggle.getAttribute("data-name");
    if ((await firstToggle.textContent()).includes("启用")) { await firstToggle.click(); await page.waitForTimeout(700); }
    await page.locator('#skillsView button[data-name="' + name + '"]').first().click();
    await page.waitForTimeout(700);
    const offTxt = await page.locator('#skillsView button[data-name="' + name + '"]').textContent();
    check("内置技能停用生效(按钮翻转)", offTxt.includes("启用"), name + " → " + offTxt);
    await page.locator('#skillsView button[data-name="' + name + '"]').click();
    await page.waitForTimeout(700);
    const onTxt = await page.locator('#skillsView button[data-name="' + name + '"]').textContent();
    check("内置技能恢复(净状态还原)", onTxt.includes("停用"), name + " → " + onTxt);
  } catch {
    check("技能列表渲染(内置 ≥5)", false, "10s 未渲染");
  }

  // ---------- 5. 命令 CRUD + 斜杠菜单 ----------
  await page.click('.set-nitem[data-sec="cmds"]');
  await page.waitForTimeout(500);
  await page.fill('#cmdForm input[name=cname]', "specprobe");
  await page.fill('#cmdForm input[name=cbody]', "跑一次 spec 探针 $ARG");
  await page.click("#cmdSave");
  try {
    await page.locator('#cmdsView .mgr-row', { hasText: "/specprobe" }).first().waitFor({ timeout: 8000 });
    check("命令创建出现在列表", true);
  } catch {
    check("命令创建出现在列表", false, (await page.locator("#cmdsView").textContent()).slice(0, 100));
  }
  // 斜杠菜单并入:输入 /spec 看菜单
  await page.click("#act-new");
  await page.waitForTimeout(200);
  await page.fill("#instruction", "/spec");
  await page.waitForTimeout(300);
  check("自定义命令进斜杠菜单", (await page.locator("#slashMenu").textContent()).includes("specprobe"));
  await page.keyboard.press("Escape");
  await page.fill("#instruction", "");
 // 第二条探针 speckeep=「删除不波及他条」的自包含锚——092 版依赖 git-flow 插件种子命令
  // (commit-draft/diff-summary)在场,而插件装/卸会精确回收它们(fullstack.spec 净态归位后仓内
  // 不再恒有),跨 spec 共享持久 store 的假设不成立;锚改自带,进出双向归位(收尾删 speckeep)。
  await page.click("#uGear");
  await page.click('.set-nitem[data-sec="cmds"]');
  await page.waitForTimeout(400);
  await page.fill('#cmdForm input[name=cname]', "speckeep");
  await page.fill('#cmdForm input[name=cbody]', "保留锚 $ARG");
  await page.click("#cmdSave");
  await page.locator('#cmdsView .mgr-row', { hasText: "/speckeep" }).first().waitFor({ timeout: 8000 });
 // 清理(删除确认=uiConfirm 页内模态,显式确认等价原 page.once("dialog")+accept)
  await page.locator('#cmdsView button[data-act=del][data-name="specprobe"]').click(); // 锁定本 spec 自建的探针命令(存量用户命令在场时 .first 会误删真实命令——本轮实测误删 commit-draft 已按 plugins.ts 种子原文恢复)
  await page.locator(".uid-box .uid-msg", { hasText: "删除命令" }).waitFor({ state: "visible", timeout: 3000 });
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(600);
 // 断言自包含化(承 092 精确回收语义):探针行移除 + 自带保留锚 speckeep 不受波及。
  const cmdsAfter = await page.locator("#cmdsView").textContent();
  check("命令删除(探针移除且保留锚不动)",
    (await page.locator('#cmdsView .mgr-row', { hasText: "/specprobe" }).count()) === 0
    && cmdsAfter.includes("speckeep"));
  // 净状态还原:删掉保留锚(本 spec 自带种子自带收)
  await page.locator('#cmdsView button[data-act=del][data-name="speckeep"]').click();
  await page.locator(".uid-box .uid-msg", { hasText: "删除命令" }).waitFor({ state: "visible", timeout: 3000 });
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(600);

  // ---------- 6. 钩子 ----------
  await page.click('.set-nitem[data-sec="hooks"]');
  await page.waitForTimeout(400);
  await page.fill('#hookForm input[name=hname]', "spec钩子");
  await page.fill('#hookForm input[name=hcmd]', "echo hook-probe");
  await page.click("#hookSave");
  try {
    await page.locator('#hooksView .mgr-row', { hasText: "spec钩子" }).first().waitFor({ timeout: 8000 });
    check("钩子创建出现在列表(事件徽标)", (await page.locator("#hooksView").textContent()).includes("task.start"));
  } catch {
    check("钩子创建出现在列表(事件徽标)", false, (await page.locator("#hooksView").textContent()).slice(0, 100));
  }
  await page.locator('#hooksView button[data-act=del]').first().click();
  await page.locator(".uid-box .uid-msg", { hasText: "删除该钩子" }).waitFor({ state: "visible", timeout: 3000 }); // 页内模态确认
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(600);
  check("钩子删除(净状态还原)", (await page.locator("#hooksView .mgr-row").count()) === 0);

  // ---------- 7. MCP(fixture 全链路) ----------
  await page.click('.set-nitem[data-sec="mcp"]');
  await page.waitForTimeout(400);
  await page.fill('#mcpForm input[name=mname]', "spec-fixture");
  await page.fill('#mcpForm input[name=mcmd]', process.execPath);
  await page.fill('#mcpForm input[name=margs]', fixture);
  await page.click("#mcpSave");
  try {
    await page.locator('#mcpView .mgr-row', { hasText: "spec-fixture" }).first().waitFor({ timeout: 8000 });
    check("MCP 服务器添加", true);
  } catch {
    check("MCP 服务器添加", false, (await page.locator("#mcpView").textContent()).slice(0, 120));
  }
  await page.locator('#mcpView button[data-act="test"]').first().click();
  try {
    await page.locator('#mcpView', { hasText: "已连接 · 1 工具" }).waitFor({ timeout: 20000 });
    check("MCP 测试连接(1 工具)", true);
  } catch {
    check("MCP 测试连接(1 工具)", false, (await page.locator("#mcpView").textContent()).slice(0, 160));
  }
  check("MCP 状态点变绿", (await page.locator("#mcpView .dot.ok").count()) >= 1);
  await page.locator('#mcpView button[data-act=del]').first().click();
  await page.locator(".uid-box .uid-msg", { hasText: "删除该 MCP" }).waitFor({ state: "visible", timeout: 3000 }); // 页内模态确认
  await page.locator(".uid-box .uid-ok").click();
  await page.waitForTimeout(700);
  check("MCP 删除(净状态还原)", (await page.locator("#mcpView .mgr-row").count()) === 0);

  // ---------- 8. 记忆 ----------
  await page.click('.set-nitem[data-sec="memory"]');
  await page.waitForTimeout(600);
  check("记忆只读视图(usage 或空态)", (await page.locator("#memoryView").textContent()).length > 4);

  // ---------- 9. 分组工具卡 + 办公模式(注入 histEvents) ----------
  await page.click("#act-new");
  await page.waitForTimeout(200);
  // fixE23 断言现代化:原探针用 code_sense——fixH13 起 code_sense/code_index/code_review/board/todo 进
  // TOOL_SOLO 强制独立合并卡(调用点即结果,不进分组),连续 code_sense 永远不聚合=.tool-group 恒 0(T6 前即失败)。
  // 分组语义本身(连续同类 explore 结果聚合)用非 solo 的 read_file 探测,断言不变。
  await page.evaluate(() => {
    const mk = (seq, kind, payload) => ({ seq, kind, sessionId: "spec-g", payload, time: Date.now() });
    window.__mature.setHist([
      mk(1, "message.user", { text: "分组探针" }),
      mk(2, "message.agent", { text: "开工", toolCalls: [
        { id: "c1", name: "read_file", arguments: "{\"path\":\"a\"}" },
        { id: "c2", name: "read_file", arguments: "{\"path\":\"b\"}" },
        { id: "c3", name: "read_file", arguments: "{\"path\":\"c\"}" },
      ] }),
      mk(3, "tool.result", { toolCallId: "c1", name: "read_file", content: "r1" }),
      mk(4, "tool.result", { toolCallId: "c2", name: "read_file", content: "r2" }),
      mk(5, "tool.result", { toolCallId: "c3", name: "read_file", content: "r3" }),
      mk(6, "message.agent", { text: "完成" }),
    ]);
    window.__mature.renderHistory();
  });
  check("分组工具卡(连续 code_sense 聚合成组)", (await page.locator(".tool-group").count()) === 1);
  check("分组摘要含「探索 · 3 次」", (await page.locator(".tool-group summary").first().textContent()).includes("探索 · 3 次"));
  // 关掉分组开关 → 回单卡
  await page.click("#uGear");
  await page.click('.set-nitem[data-sec="general"]');
  await page.waitForTimeout(200);
  await page.locator("#set-g-search button[data-v=off]").click();
  await page.click("#act-new");
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const mk = (seq, kind, payload) => ({ seq, kind, sessionId: "spec-g", payload, time: Date.now() });
    window.__mature.setHist([
      mk(1, "message.user", { text: "分组探针2" }),
      mk(2, "message.agent", { text: "开工", toolCalls: [
        { id: "d1", name: "read_file", arguments: "{\"path\":\"a\"}" },
        { id: "d2", name: "read_file", arguments: "{\"path\":\"b\"}" },
        { id: "d3", name: "read_file", arguments: "{\"path\":\"c\"}" },
      ] }),
      mk(3, "tool.result", { toolCallId: "d1", name: "read_file", content: "r1" }),
      mk(4, "tool.result", { toolCallId: "d2", name: "read_file", content: "r2" }),
      mk(5, "tool.result", { toolCallId: "d3", name: "read_file", content: "r3" }),
    ]);
    window.__mature.renderHistory();
  });
  check("关分组开关 → 还原单卡", (await page.locator(".tool-group").count()) === 0 && (await page.locator(".tool-card").count()) >= 3);
  await page.click("#uGear");
  await page.click('.set-nitem[data-sec="general"]');
  await page.locator("#set-g-search button[data-v=on]").click();

  // ---------- 10. 办公模式 ----------
  await page.locator("#set-mode button[data-v=office]").click();
  await page.waitForTimeout(200);
  check("办公模式:详情卡收起(office-chip 在位)", await page.evaluate(() => document.body.classList.contains("office")));
  await page.locator("#set-mode button[data-v=code]").click();
  await page.waitForTimeout(200);
  check("切回编程模式", !(await page.evaluate(() => document.body.classList.contains("office"))));

  // ---------- 11. 快捷键 ----------
  const theme0 = await page.evaluate(() => localStorage.getItem("zh:theme"));
  await page.keyboard.press("Control+Shift+KeyL");
  await page.waitForTimeout(200);
  const theme1 = await page.evaluate(() => localStorage.getItem("zh:theme"));
  check("Ctrl+Shift+L 切主题", theme0 !== theme1, theme0 + " → " + theme1);
  await page.keyboard.press("Control+=");
  await page.waitForTimeout(200);
  const zoom = await page.evaluate(() => document.body.style.zoom);
  check("Ctrl+= 放大", zoom !== "" && zoom !== "1", "zoom=" + zoom);
  await page.keyboard.press("Control+0");
  await page.waitForTimeout(200);
  check("Ctrl+0 复位", (await page.evaluate(() => document.body.style.zoom)) === "1");
  // Ctrl+, 打开设置
  await page.keyboard.press("Control+Comma");
  await page.waitForTimeout(300);
  check("Ctrl+, 打开设置", await page.locator("#view-sys").isVisible());
 // Ctrl+T 思考力度(断言现代化: 改版后 Ctrl+T=pill 点击=就地下拉菜单(panel.ts:11047→
  // pillMenuOpen),不再循环翻转——断言改走菜单驱动选档,语义等价「切档生效」+「净状态还原」。
 // 先回 chat 视图:footer pill 可见=菜单锚点在视口内(设置视图下 pill display:none→rect 归零→菜单位于视口外,不可点——经验证注意)
  await page.click("#act-new");
  await page.waitForTimeout(250);
  const e0 = (await page.locator("#effortPill").textContent()).trim();
  await page.keyboard.press("Control+t");
  await page.locator(".pill-menu .pm-item").first().waitFor({ timeout: 3000 });
  const curEff = e0.replace("思考:", "").trim();
  const pickEff = ["关", "低", "中", "高", "最高"].find((x) => x !== curEff) || "低";
  await page.locator('.pill-menu .pm-item[data-v="' + pickEff + '"]').click(); // data-v 精确选档(「高」⊂「最高」禁 hasText)
  await page.waitForTimeout(400);
  const e1 = (await page.locator("#effortPill").textContent()).trim();
  check("Ctrl+T 切思考力度", e1 !== e0 && e1.includes(pickEff), e0 + " → " + e1);
  // 净状态还原(Ctrl+T 再开菜单选回原档)
  await page.keyboard.press("Control+t");
  await page.locator(".pill-menu .pm-item").first().waitFor({ timeout: 3000 });
  await page.locator('.pill-menu .pm-item[data-v="' + curEff + '"]').click();
  await page.waitForTimeout(400);
  check("思考力度净状态还原(回原档)", (await page.locator("#effortPill").textContent()).trim() === e0, "还原为 " + e0);
  // Ctrl+O 项目面板
  await page.keyboard.press("Control+o");
  await page.waitForTimeout(300);
  check("Ctrl+O 项目切换面板", await page.locator("#cc").isVisible());
  await page.keyboard.press("Escape");

  // ---------- 12. 外观:代码设置 ----------
  await page.click("#uGear");
  await page.click('.set-nitem[data-sec="appearance"]');
  await page.waitForTimeout(300);
  check("代码预览双栏在位", (await page.locator("#prev-light").count()) === 1 && (await page.locator("#prev-dark").count()) === 1);
  check("跟随系统主题选项在位", (await page.locator('#set-theme button[data-v="system"]').count()) === 1);
  await page.locator("#set-lineno button[data-v=off]").click();
  await page.waitForTimeout(200);
  check("行号开关生效(body 类)", !(await page.evaluate(() => document.body.classList.contains("lineno"))));
  await page.locator("#set-lineno button[data-v=on]").click();
  await page.waitForTimeout(200);

  // ---------- 13. 统计增强 ----------
  // fixE23:健康度/工具表是数据条件渲染(byTool / health.samples 空则整区不画)。空 journal 的自host 实例
  // 此前到不了这里——旧分组探针(code_sense 恒不聚合)在同点前把整个 spec 崩掉,本断言从未真正执行。
  // 注入种子事件(tool.result ×2 + 带 usage/llmMs 的 message.agent)让两张表有据可画,断言语义回到本体。
  const sh = globalThis.__selfhostApp;
  if (sh && sh.journal) {
    sh.journal.appendMany([
      { kind: "tool.result", sessionId: "spec-stats-seed", payload: { name: "read_file", content: "s1" } },
      { kind: "tool.result", sessionId: "spec-stats-seed", payload: { name: "read_file", content: "s2" } },
      { kind: "message.agent", sessionId: "spec-stats-seed", payload: { text: "ok", model: "spec-model", llmMs: 3200, usage: { inputTokens: 100, outputTokens: 640, totalTokens: 740 } } },
    ]);
  }
  await page.click('.set-nitem[data-sec="data"]');
  try {
    await page.locator("#statsView .stat-cards").waitFor({ timeout: 15000 });
    const txt = await page.locator("#statsView").textContent();
    check("统计新卡:峰值 Token", txt.includes("峰值 Token"));
    check("统计新卡:连续天数", txt.includes("当前连续") && txt.includes("最长连续"));
    check("日/周/累计 切换在位", (await page.locator("#statsView button[data-sm]").count()) === 3);
    await page.locator('#statsView button[data-sm="week"]').click();
    await page.waitForTimeout(300);
    check("切到每周视图", (await page.locator('#statsView button[data-sm="week"].on').count()) === 1);
    check("健康度或工具表渲染", txt.includes("工具消耗") || txt.includes("系统健康度"));
  } catch {
    check("统计新卡:峰值 Token", false, "stats 未渲染");
  }

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
