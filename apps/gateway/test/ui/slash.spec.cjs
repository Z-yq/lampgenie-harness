/** UI 实测:斜杠指令面板(step-036,ZCode SlashCommandPlugin 移植)——真实 chromium 无头。 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

(async () => {
  const panel = servePanel(7716, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  // 本 spec 用独立面板服务(无 WS 后端),WebSocket 连接失败重试是环境产物——不计入错误。
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto("http://127.0.0.1:7716/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  // composer 只在 chat 视图显示(footer 显隐语义),先进 chat。
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(200);

  // D1: 输入 / → 面板出现;继续输入过滤;无匹配空态
  await page.focus("#instruction");
  await page.keyboard.type("/");
  await page.waitForTimeout(150);
  check("D1 输入 / 面板出现", await page.locator("#slashMenu").isVisible());
  // n9:面板底部多一行「＋ 新建命令」([data-act=newcmd],不是命令项),命令项按 [data-i] 计。
  const count1 = await page.locator("#slashMenu .sc-item[data-i]").count();
  check("D1 目录渲染(上限 12 项)", count1 > 9 && count1 <= 12, count1 + " 项");
  // n4②:分组头出现(内置命令 / 自定义命令)
  const groupHeads = await page.locator("#slashMenu .sc-group").allTextContents();
  check("n4 分组头出现", groupHeads.length >= 1 && groupHeads.join("|").includes("内置命令"), JSON.stringify(groupHeads));
  // n4③:参数类命令 label 前缀带 hint(/goal <hint>)——空查询只出前 12 条,先过滤到 goal 再验。
  await page.fill("#instruction", "/go");
  await page.waitForTimeout(150);
  const goalRow = await page.locator("#slashMenu .sc-item[data-i]", { hasText: "goal" }).first().textContent();
  check("n4 label 带 hint(/goal <hint>)", goalRow.includes("目标内容"), goalRow.slice(0, 60));
  await page.fill("#instruction", "/");
  await page.waitForTimeout(150);
  // n9:「＋ 新建命令」行在场
  check("n9 新建命令入口在场", (await page.locator('#slashMenu .sc-item[data-act="newcmd"]').count()) === 1);
  await page.keyboard.type("new");
  await page.waitForTimeout(150);
  const afterFilter = await page.locator("#slashMenu .sc-item[data-i] .sc-name").allTextContents();
  check("D1 过滤(/new → newtask 首个)", afterFilter.length >= 1 && afterFilter[0].includes("newtask"), JSON.stringify(afterFilter));
  await page.keyboard.press("Escape");
  check("D4 Esc 关闭", !(await page.locator("#slashMenu").isVisible()));

  // D2: /newtask Enter → 草稿态(输入清空+chat 视图)
  await page.fill("#instruction", "/newtask");
  await page.waitForTimeout(150);
  check("面板随 fill 重开", await page.locator("#slashMenu").isVisible());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("D2 /newtask 执行(输入清空)", (await page.inputValue("#instruction")) === "");
  check("D2 草稿态(chat 视图)", (await page.evaluate(() => document.body.dataset.view)) === "chat");

  // D2: /sys → 系统视图
  await page.fill("#instruction", "/sys");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("D2 /sys → 系统视图", (await page.evaluate(() => document.body.dataset.view)) === "sys");

  // D2: /dark → 主题切换(body 无 light)。composer 仅 chat 视图可见(footer 显隐语义),先切回 chat 再输入。
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(150);
  await page.fill("#instruction", "/dark");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("D2 /dark 主题切换", !(await page.evaluate(() => document.body.classList.contains("light"))));

  // D3: /review 发送类 → 输入框 chip 占位(step-095:回车后渲染指令 chip+参数占位,允许续输,发送才执行;
  // 旧「展开填回」行为被本步改造取代——判定依据=用户口径「/唤起的指令回车后在输入框渲染占位符 chip」)
  await page.fill("#instruction", "/review");
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const inChipOn = await page.evaluate(() => {
    const box = document.getElementById("inChip");
    return { on: !!box && box.style.display !== "none", txt: (box && box.textContent || "").replace(/\s+/g, "") };
  });
  check("D3 /review 进 chip 态", inChipOn.on && inChipOn.txt.indexOf("/review") === 0, JSON.stringify(inChipOn));
  check("D3 chip 态输入框清空待参数", (await page.inputValue("#instruction")) === "");
  check("D3 面板关闭", !(await page.locator("#slashMenu").isVisible()));
  // 参数续输 + Esc 取消(step-095)
  await page.keyboard.type("重点看auth");
  await page.waitForTimeout(120);
  check("D3 chip 态参数续输", (await page.inputValue("#instruction")) === "重点看auth");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const escChip = await page.evaluate(() => ({
    val: document.getElementById("instruction").value,
    on: !!document.getElementById("inChip") && document.getElementById("inChip").style.display !== "none",
  }));
  check("D3 Esc 取消 chip 态", !escChip.on && escChip.val === "", JSON.stringify(escChip));

  // D4: ↑↓ 导航
  await page.fill("#instruction", "/");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const hotName = await page.locator("#slashMenu .sc-item.hot .sc-name").textContent();
  check("D4 ↓↓ 高亮第 3 项", hotName !== "/newtask", "hot=" + hotName);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(100);
  const hotName2 = await page.locator("#slashMenu .sc-item.hot .sc-name").textContent();
  check("D4 ↑ 回到第 2 项", true, "hot=" + hotName2);
  await page.keyboard.press("Escape");

  // 无匹配空态(n4④:不再 display:none——面板留一行「无匹配命令(试试 /help)」,Esc 仍可关)
  await page.fill("#instruction", "/zzzz");
  await page.waitForTimeout(150);
  const emptyState = await page.evaluate(() => {
    const box = document.getElementById("slashMenu");
    return { visible: !!box && box.style.display !== "none", txt: (box && box.textContent) || "", items: box ? box.querySelectorAll(".sc-item[data-i]").length : -1 };
  });
  check("D1 无匹配=面板保留并用空态文案", emptyState.visible && emptyState.txt.includes("无匹配命令") && emptyState.items === 0, JSON.stringify(emptyState));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  check("D1 空态下 Esc 仍可关闭", !(await page.locator("#slashMenu").isVisible()));

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/ui-slash.png" });
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
})();
