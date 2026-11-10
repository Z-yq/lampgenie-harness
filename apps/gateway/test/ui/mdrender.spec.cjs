/** 消息渲染探针(2026-10-13 渲染修复):协议标签行中残留/ANSI 色码/有序列表/围栏-引块交错。
 * 直接驱动真实面板页的全局 mdToHtml/scrubProtocolLines——乱码与格式乱飞的两个清洗源都在页面脚本里。 */
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
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  // 1. 协议标签行中残留:此前只清洗整行形态,行中驼出的 </tool_result> 是乱码主源之一
  const r1 = await page.evaluate(() => scrubProtocolLines("结果如下</tool_result>其余内容保持"));
  check("协议标签行中剥离", !r1.includes("tool_result") && r1.includes("其余内容保持"), JSON.stringify(r1));

  // 2. 整行标签仍被过滤(原行为不回退)
  const r2 = await page.evaluate(() => scrubProtocolLines("前文\n<tool_result>整行驼出</tool_result>\n后文"));
  check("整行标签仍过滤", !r2.includes("tool_result") && r2.includes("前文") && r2.includes("后文"), JSON.stringify(r2));

  // 3. ANSI 色码清洗(乱码主源之二:run_cmd 终端输出)
  const r3 = await page.evaluate(() => scrubProtocolLines("状态:" + String.fromCharCode(27) + "[31m红色" + String.fromCharCode(27) + "[0m 完成"));
  check("ANSI 色码剥离", !r3.includes(String.fromCharCode(27)) && r3.includes("红色") && r3.includes("完成"), JSON.stringify(r3));

  // 4. 有序列表:1. 与 1、 两种形态 → <ol>/<li>
  const r4 = await page.evaluate(() => mdToHtml("1. 第一项\n2. 第二项\n3、第三项(顿号形态)"));
  check("有序列表渲染", r4.includes('<ol start="1">') && (r4.match(/<li>/g) || []).length === 3 && r4.includes("</ol>"), r4.slice(0, 160));

  // 5. 无序+有序交错:列表互斥闭合(此前交错会嵌坏)
  const r5 = await page.evaluate(() => mdToHtml("- 甲\n1. 乙\n- 丙"));
  check("无序/有序交错闭合", r5 === "<ul><li>甲</li></ul>" + '<ol start="1"><li>乙</li></ol>' + "<ul><li>丙</li></ul>", r5.slice(0, 200));

  // 6. 围栏前的引块闭合(此前 blockquote 会吞掉代码块)
  const r6 = await page.evaluate(() => mdToHtml("> 引用行\n" + "```\ncode line\n```\n后续"));
  check("引块在围栏前闭合", r6.indexOf("</blockquote>") < r6.indexOf("<pre") && r6.includes("code line"), r6.slice(0, 160));

  // 7. 表格/代码块原行为不回退
  const r7 = await page.evaluate(() => mdToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |\n" + "```\nplain\n```\n完毕"));
  check("表格+代码块不回退", r7.includes("md-table") && r7.includes("plain"), r7.slice(0, 120));

  // 渲染二期(2026-10-14):斜体/删除线/分隔线/任务列表/嵌套列表
  const r8 = await page.evaluate(() => mdToHtml("这是*强调*文字;算式 2 * 3 * 4 不变;~~废弃方案~~作废"));
  check("斜体+删除线", r8.includes("<i>强调</i>") && !r8.includes("<i> 3 <") && r8.includes("<del>废弃方案</del>"), r8.slice(0, 160));
  const r9 = await page.evaluate(() => mdToHtml("上文\n---\n下文"));
  check("分隔线", r9.includes("md-hr") && r9.includes("上文") && r9.includes("下文"), r9.slice(0, 120));
  const r10 = await page.evaluate(() => mdToHtml("- [ ] 待办事项\n- [x] 已完成项"));
  check("任务列表复选框", (r10.match(/<input type="checkbox"/g) || []).length === 2 && r10.includes("checked") && r10.includes("待办事项"), r10.slice(0, 160));
  const r11 = await page.evaluate(() => mdToHtml("- 顶一\n  - 子一\n  - 子二\n- 顶二"));
  check("嵌套列表一级", r11.includes("<li>顶一<ul><li>子一</li><li>子二</li></ul></li><li>顶二</li></ul>"), r11.slice(0, 200));

  // 渲染三期(2026-10-14 A 工具结果乱码修复):fc 返回四源——协议标签/终端控制字符/JSON 平铺/硬截断。
  // 直接驱动真实面板页的 toolResultCard/cleanToolText(与上方 mdToHtml 同层)。
  const t1 = await page.evaluate(() => toolResultCard("结果附注</tool_result>尾部正文", null));
  check("工具结果协议标签剥离", !t1.includes("tool_result") && t1.includes("尾部正文"), t1.slice(0, 120));
  const t2 = await page.evaluate(() => toolResultCard("p1" + String.fromCharCode(13) + "p2" + String.fromCharCode(13) + "done", null));
  check("工具结果 CR 转可读换行", t2.split(String.fromCharCode(10)).length >= 3 && t2.includes("p1") && t2.includes("p2"), t2.slice(0, 120));
  const t3 = await page.evaluate(() => toolResultCard(JSON.stringify({ status: "async_launched", agentId: "a1", note: "已后台启动" }), null));
  check("JSON 回执美化成代码块", t3.includes("code-lang") && (t3.match(/span class="cl"/g) || []).length >= 3, "cl=" + (t3.match(/span class="cl"/g) || []).length);
  const t4 = await page.evaluate(() => toolResultCard(Array.from({ length: 2000 }, (_, i) => "L" + i).join(String.fromCharCode(10)), null));
  check("超长输出截断+展开全文", t4.includes("tr-more") && t4.includes("展开全文"), "");
  const t5 = await page.evaluate(() => cleanToolText("x" + String.fromCharCode(27) + "[31m红" + String.fromCharCode(13) + String.fromCharCode(8) + "y"));
  check("cleanToolText=ANSI+控制字符合一清洗", !t5.includes(String.fromCharCode(27)) && !t5.includes(String.fromCharCode(13)) && !t5.includes(String.fromCharCode(8)) && t5.includes("红"), JSON.stringify(t5));

  check("0 pageerror", consoleErrors.length === 0, consoleErrors.join(" | "));
  const fails = results.filter((r) => !r.ok).length;
  console.log("mdrender: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})();
