/** UI 经验证:插件市场/内嵌浏览器/账号额度/引导中心/附件/远程向导/浏览器控制设置。 */
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
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Notification") && !m.text().includes("Refused")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  // 首访导览:钩子驱动展示(自动弹出在真人浏览器生效;无头环境 webdriver 门控不弹——防拦截)
  await page.evaluate(() => window.__tour.show(0));
  await page.waitForTimeout(300);
  check("导览弹出(真人浏览器自动弹;无头由门控禁用)", await page.locator("#tourMask.on").count() === 1);
  await page.click("#tourNext");
  await page.waitForTimeout(200);
  check("导览步进(标题换页)", (await page.locator("#tourTitle").textContent()) !== "欢迎使用 lampgenie-harness");
  for (let i = 0; i < 5; i++) await page.click("#tourNext").catch(() => {});
  await page.waitForTimeout(200);
  check("导览完成收起", await page.locator("#tourMask.on").count() === 0);

  // ── 插件市场 ──
  await page.click("#act-market");
  await page.waitForTimeout(900);
  check("市场目录渲染(≥6 卡)", (await page.locator("#mktGrid .mkt-card").count()) >= 6);
 // 净状态归位:插件安装态持久在共享仓 .genie/plugins.json(跨实例)——前序跑/生产环境残留
  // 已装态会让 install 钮缺席(092 教训:spec 必须自带进出双向归位)。已装则先卸到基线再走安装链。
  const preUn = page.locator('#mktGrid .mkt-card[data-id="git-flow"] button[data-act="uninstall"]');
  if ((await preUn.count()) > 0) {
    await preUn.first().click();
    await page.locator(".uid-mask .uid-ok").click();
    await page.waitForTimeout(1500);
  }
  // 安装 git-flow → 命令真实落点(斜杠菜单出现)
  const card = page.locator('#mktGrid .mkt-card[data-id="git-flow"]').first();
  await card.locator('button[data-act="install"]').click();
  await page.waitForTimeout(1600);
  check("安装后卡片变已装(卸载按钮在)", (await card.locator('button[data-act="uninstall"]').count()) === 1);
  await page.click("#act-new");
  await page.waitForTimeout(200);
  await page.fill("#instruction", "/branch");
  await page.waitForTimeout(350);
  check("插件命令进斜杠菜单(/branch-report)", (await page.locator("#slashMenu").textContent()).includes("branch-report"));
  await page.keyboard.press("Escape");
  await page.fill("#instruction", "");
 // 卸载 → 回收(088 起确认已是 uiConfirm 主题模态,page.once("dialog") 永远接不到——
  // 改接 .uid-mask 内 .uid-ok;模态不接会残留遮罩拦截后续全部点击,本 spec 历史红的真因之一)
  await page.click("#act-market");
  await page.waitForTimeout(700);
  await page.locator('#mktGrid .mkt-card[data-id="git-flow"] button[data-act="uninstall"]').click();
  await page.locator(".uid-mask .uid-ok").click();
  await page.waitForTimeout(1500);
  check("卸载后回到可安装态", (await page.locator('#mktGrid .mkt-card[data-id="git-flow"] button[data-act="install"]').count()) === 1);

  // ── 内嵌浏览器 ──
 // 左栏 #act-browser 已撤(不展示),改走 Ctrl+Alt+B——同时验证入口未丢
  await page.keyboard.press("Control+Alt+b");
  await page.waitForTimeout(300);
  check("内嵌浏览器视图(Ctrl+Alt+B)", await page.locator("#view-browser").isVisible());
 // iframe 目标从硬编码生产环境 7700 改 BASE 注入——自host 跑法(_ui_selfhost)下打的是
 // 本 spec 自带实例,不再误打生产环境;独立直跑(PANEL_BASE 缺省 7700)行为同旧。
  await page.fill("#brUrl", BASE + "/");
  await page.click("#brGo");
  await page.waitForTimeout(1200);
  check("内嵌浏览器加载本地面板(iframe 有文档)", await page.locator("#brFrame").evaluate((f) => { try { return f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes("lampgenie-harness"); } catch (e) { return false; } }));

  // ── 设置:浏览器控制/账号/远程/引导 ──
  await page.click("#uGear");
  await page.waitForTimeout(300);
  // 浏览器控制
  await page.click('.set-nitem[data-sec="browserctl"]');
  await page.waitForTimeout(400);
  check("浏览器控制分区(开关+白名单)", (await page.locator("#set-browser button").count()) === 2 && (await page.locator("#browser-domains").count()) === 1);
  // 账号与额度
  await page.click('.set-nitem[data-sec="account"]');
  await page.waitForTimeout(900);
  const acctTxt = await page.locator("#acctId").textContent();
  check("账号身份徽标(本地/relay)", acctTxt.includes("身份"), acctTxt.slice(0, 50));
  try {
    await page.locator("#quotaCards .quota-card").first().waitFor({ timeout: 12000 });
    const qt = await page.locator("#quotaCards").textContent();
    check("额度卡(今日/本周 token)", qt.includes("今日 token") && qt.includes("本周 token"));
  } catch {
    check("额度卡(今日/本周 token)", false, "stats 未回");
  }
  // 远程连接
  await page.click('.set-nitem[data-sec="remote"]');
  await page.waitForTimeout(900);
  const nodesTxt = await page.locator("#nodeList").textContent();
  check("节点表渲染(local 至少在列或空态)", nodesTxt.length > 4, nodesTxt.slice(0, 40));
  await page.fill("#wiz-host", "192.168.1.99");
  await page.fill("#wiz-user", "op");
  await page.fill("#wiz-port", "2222");
  await page.click("#wiz-ssh");
  try {
    await page.locator("#wizOut .wiz-cmd").waitFor({ timeout: 8000 });
    const cmd = await page.locator("#wizOut .wiz-cmd").textContent();
    check("SSH 向导命令生成(含地址/节点)", cmd.includes("ssh -p 2222 op@192.168.1.99") && cmd.includes("node-agent.mjs"));
    await page.click("#wizOut .wiz-copy");
    check("一键复制按钮", true);
  } catch {
    check("SSH 向导命令生成(含地址/节点)", false, "8s 未生成");
  }
  await page.click("#wiz-docker");
  await page.waitForTimeout(800);
  check("Docker 向导命令", (await page.locator("#wizOut").textContent()).includes("docker run -d"));
  // 引导中心
  await page.click('.set-nitem[data-sec="guide"]');
  await page.waitForTimeout(500);
  const guideTxt = await page.locator("#guideList").textContent();
  check("引导清单(≥8 项,真实态勾选)", (await page.locator("#guideList .guide-item").count()) >= 8 && guideTxt.includes("连接"));
  check("引导有已完成项(连接=真)", (await page.locator("#guideList .guide-item.done").count()) >= 1);
  await page.click("#guideTour");
  await page.waitForTimeout(200);
  check("重看导览", await page.locator("#tourMask.on").count() === 1);
  await page.click("#tourSkip");

  // ── 附件链路 ──
  await page.click("#act-new");
  await page.waitForTimeout(200);
  await page.setInputFiles("#attInput", [{ name: "探针.txt", mimeType: "text/plain", buffer: Buffer.from("附件内容探针 ABC-123") }]);
  await page.waitForTimeout(1500);
  check("上传后 chips 在列", (await page.locator("#attBar .att-chip").count()) === 1);
  await page.fill("#instruction", "读取附件并复述其中编号");
  await page.click("#go");
  await page.waitForTimeout(1200);
  check("提交后附件卡渲染在消息行", (await page.locator(".user-line .att-card").first().textContent().catch(() => "")).includes("探针.txt"));

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
