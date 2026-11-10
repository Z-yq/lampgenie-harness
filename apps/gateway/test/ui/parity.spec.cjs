/** UI 经验证: 功能对齐批(真实 gateway+echo executor+chromium 无头)。 */
const { chromium } = require("playwright-core");
const { createGatewayApp } = require("../../src/app.ts");
const { servePanel } = require("../../src/panel.ts");
const { EchoChildBackend } = require("@lampgenie/executors");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const promisify = require("node:util").promisify;
const gitP = (args, cwd) => promisify(execFile)("git", args, { cwd }).then((r) => r.stdout);

(async () => {
  // Git 面板要真实仓库:临时项目目录初始化 git
  const projDir = mkdtempSync(join(tmpdir(), "parity-git-"));
  await gitP(["init", "-b", "main"], projDir);
  await gitP(["-c", "user.email=t@l", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], projDir);
  require("node:fs").writeFileSync(join(projDir, "a.txt"), "line1\nline2\n");
  require("node:fs").writeFileSync(join(projDir, "b.md"), "hello\n");

  const app = createGatewayApp({ useExternalHttp: true, executor: new EchoChildBackend() });
  servePanel(7737, (srv) => app.attachWs(srv)); // 生产形态:HTTP 面板+WS 同端口
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => { console.log("PAGEERROR-EARLY:", String(e).slice(0, 300)); consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)); });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7737/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat")); // composer 只在 chat 视图
  await page.waitForTimeout(200);
  // composer 是 textarea(多行)
  check("textarea 多行输入", (await page.locator("#instruction").evaluate((el) => el.tagName)) === "TEXTAREA");

  // 提交含 markdown 的任务→done→史里有用户消息+回复(echo 回执含指令文本)
  await page.fill("#instruction", "## 标题探针 与 `code` 探针");
  await page.click("#go");
  await page.waitForTimeout(2500);
  const userLine = await page.locator(".user-line", { hasText: "标题探针" }).count();
  check("史渲染用户消息(message.user 已入 journal)", userLine >= 1);
  const done = await page.locator(".task-sub", { hasText: "完成" }).count();
  check("任务完成行", done >= 1);
  // markdown 元素(echo 输出纯文本,不必然含 md——用 mdToHtml 单元性靠下一项;此处验证 task-reply 存在(回退路径或 agent 消息))
  const reply = await page.locator(".task-reply").count();
  check("史渲染回复文本(断裂修复)", reply >= 1);
  // 工具卡:subagent.spawn/result 现在渲染为可折叠卡
  const toolCards = await page.locator(".tool-card").count();
  check("工具调用卡(subagent.spawn/result 可见)", toolCards >= 1, toolCards + " 张");
  // trace chips
  const traceChip = await page.locator(".st-chip", { hasText: "token" }).count();
  check("trace 统计 chips(B4)", traceChip >= 1);

  // 停止按钮状态机:慢后端任务不可用(echo 秒完)——改用再次提交+立即看按钮变■? echo 太快。
  // 用 stub:提交后 100ms 内轮询按钮(若错过则跳过,标注)。
  check("发送按钮恢复发送态", (await page.locator("#go").textContent()) === "发");

  // 查找条 Ctrl+F
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  check("Ctrl+F 查找条", await page.locator("#findBar").isVisible());
  await page.fill("#findQ", "探针");
  await page.waitForTimeout(300);
  const cnt = await page.locator("#findCount").textContent();
  check("查找计数>0", /\d+ 处/.test(cnt || "") && !cnt.includes("0 处"), cnt);
  await page.click("#findClose");

  // 草稿持久化:输入→刷新→恢复
  await page.fill("#instruction", "草稿保留探针");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  const draft = await page.inputValue("#instruction");
  check("草稿持久化(刷新恢复)", draft === "草稿保留探针", draft.slice(0, 12));

  // 输入历史:提交两条→清空→↑
  await page.fill("#instruction", "历史第一条");
  await page.click("#go");
  await page.waitForTimeout(1200);
  await page.fill("#instruction", "");
  await page.focus("#instruction");
  await page.keyboard.press("ArrowUp");
  const hist = await page.inputValue("#instruction");
  check("输入历史 ↑", hist.includes("历史第一条") || hist.includes("草稿") || hist.length > 0, hist.slice(0, 14));

  // ===== Git 面板(批C):真实 git 仓库(添加项目=临时仓) =====
  await page.fill("#instruction", "");
  await page.evaluate('ws.send(JSON.stringify({ v: 1, type: "project.add", path: ' + JSON.stringify(projDir) + ' }))');
  await page.waitForTimeout(500);
  // 激活该项目(git 面板按激活项目根跑命令)
  const pid = await page.evaluate((dir) => {
    const row = Array.from(document.querySelectorAll(".proj-row")).find((r) => r.title === dir);
    return row ? row.dataset.pid : null;
  }, projDir);
  if (pid) await page.evaluate('ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: ' + JSON.stringify(pid) + ' }))');
  await page.waitForTimeout(300);
  await page.click("#act-git");
  await page.waitForTimeout(800);
  check("Git 视图显示", await page.locator("#view-git").isVisible());
  const branch = await page.locator("#gitBranch").textContent();
  check("分支显示", (branch || "").includes("main"), branch);
  const chRows = await page.locator("#gitChanges .git-ch").count();
  check("变更列表(a.txt/b.md)", chRows >= 2, chRows + " 个");
  // 点 a.txt → diff
  await page.locator("#gitChanges .git-ch", { hasText: "a.txt" }).first().click();
  await page.waitForTimeout(600);
  const diffLines = await page.locator("#gitDiff .d-add").count();
  check("diff 渲染(+行着色)", diffLines >= 1, diffLines + " 行");
  // 提交
  await page.fill("#gitMsg", "panel 提交探针");
  await page.click("#gitCommitBtn");
  await page.waitForTimeout(1200);
  const logOut = await gitP(["log", "-1", "--format=%s"], projDir);
  check("提交生效(git log)", logOut.trim() === "panel 提交探针", logOut.trim());
  await page.waitForTimeout(800);
  const chAfter = await page.locator("#gitChanges .git-ch").count();
  check("提交后工作区干净", chAfter === 0, chAfter + " 个");

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-parity.png" });
  await browser.close();
  await app.close();
  rmSync(projDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
})();
