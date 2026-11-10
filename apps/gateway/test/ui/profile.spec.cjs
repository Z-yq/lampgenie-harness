/** step-049 UI 实测:项目档案管线(添加项目→异步进度→架构图→模块搜索详情→演进→独立窗口)。
 * 用临时小项目走真实链路:project.add → profile.get → 进度广播 → done 渲染。 */
const { chromium } = require("playwright-core");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  // 临时项目:三模块 + 相互 import(模块聚类与边可断言)
  const proj = mkdtempSync(join(tmpdir(), "zprof-"));
  const { execSync } = require("node:child_process");
  const g = (a) => execSync("git " + a, { cwd: proj, stdio: ["ignore", "pipe", "ignore"] });
  g("init -q"); g('config user.email t@t'); g('config user.name 测试者');
  const w = (p, c) => { mkdirSync(join(proj, p.split("/").slice(0, -1).join("/") || "."), { recursive: true }); writeFileSync(join(proj, p), c); };
  w("packages/alpha/src/a1.ts", "export const a1 = 1;\n");
  w("packages/alpha/src/a2.ts", 'import { a1 } from "./a1";\nexport const a2 = a1 + 1;\n');
  w("packages/beta/src/b1.ts", 'import { a2 } from "../../../packages/alpha/src/a2";\nexport const b1 = a2;\n');
  w("apps/front/src/main.ts", 'import { b1 } from "../../../packages/beta/src/b1";\nconsole.log(b1);\n');
  w("docs/g.md", "# g\n");
  g("add -A"); g('commit -qm "feat: 初始三模块架构"');

  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Notification")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));

  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // 1. 添加项目(侧栏入口)——添加即触发档案管线
  await page.click("#projAddBtn");
  await page.fill("#projPathInput", proj);
  await page.click("#projAddGo");
  await page.waitForTimeout(800);

  // 2. 找到新项目行的「档案」入口打开
  const label = proj.split("/").pop();
  const row = page.locator(".proj-row", { hasText: label }).first();
  check("项目已添加(行在列)", await row.count() >= 1, label);
  await row.hover();
  await row.locator(".p-prof").click();
  await page.waitForTimeout(600);
  check("档案视图打开", await page.locator("#view-project").isVisible());

  // 3. 等管线完成(进度条到 100/状态=完成;小项目秒级——step-101 窗口 15s→45s:
  // 冷索引首建在 WSL 冷缓存+同机并发负载下可超 15s(编排者登记「冷索引超时」),加长窗不减
  // 测试意图(断言仍是「管线必完成」),只消环境噪音;健康时仍秒级通过)
  let done = false;
  for (let i = 0; i < 90 && !done; i++) {
    await page.waitForTimeout(500);
    done = (await page.locator("#ppState").textContent()) === "完成";
  }
  check("管线完成(状态=完成)", done, "ppState=" + (await page.locator("#ppState").textContent()));
  const pct = await page.locator("#ppPct").textContent();
  check("完成态摘要(文件/模块/边)", /文件.*模块/.test(pct), pct.slice(0, 70));

  // 4. 架构图渲染(mermaid SVG,含 alpha/beta 模块)
  await page.locator("#ppGraph svg").first().waitFor({ timeout: 15000 }).catch(() => {});
  const graphTxt = await page.locator("#ppGraph").textContent();
  check("架构图 SVG 渲染", (await page.locator("#ppGraph svg").count()) >= 1);
  check("图含模块节点 alpha/beta/front", graphTxt.includes("alpha") && graphTxt.includes("beta") && graphTxt.includes("front"));

  // 5. 模块搜索:输入 beta → 过滤;点开详情(依赖/被依赖/代表文件)
  await page.fill("#ppSearch", "beta");
  await page.waitForTimeout(300);
  const modCount = await page.locator("#ppMods .pp-mod").count();
  check("搜索过滤(只剩 beta)", modCount === 1, modCount + " 项");
  await page.locator("#ppMods .pp-mod").first().click();
  await page.waitForTimeout(300);
  const det = await page.locator("#ppDetail").textContent();
  check("模块详情(依赖 alpha)", det.includes("依赖") && det.includes("alpha"), det.slice(0, 80));
  check("详情含代表文件", det.includes("b1.ts"));
  // 反向:点 front → 依赖 beta
  await page.fill("#ppSearch", "front");
  await page.waitForTimeout(300);
  await page.locator("#ppMods .pp-mod").first().click();
  const det2 = await page.locator("#ppDetail").textContent();
  check("front 详情(依赖 beta)", det2.includes("beta"), det2.slice(0, 60));

  // 6. 演进区(空态在列;recordChange 由任务钩子驱动,此处验证容器)
  const chg = await page.locator("#ppChanges").textContent();
  check("演进区渲染(空态或记录)", chg.length > 4, chg.slice(0, 40));

  // 7. 独立窗口页:/profile?p=<id>(新开页面真实加载)
  const pid = await row.getAttribute("data-pid");
  const p2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p2.goto(BASE + "/profile?p=" + encodeURIComponent(pid), { waitUntil: "domcontentloaded" });
  await p2.waitForTimeout(2500);
  const p2title = await p2.locator("#t").textContent();
  check("独立窗口页加载", p2title.includes("项目档案"), p2title.slice(0, 40));
  await p2.locator("#g svg").first().waitFor({ timeout: 15000 }).catch(() => {});
  check("独立页架构图渲染", (await p2.locator("#g svg").count()) >= 1);
  await p2.fill("#q", "alpha");
  await p2.waitForTimeout(300);
  check("独立页模块搜索", (await p2.locator("#mods .mod").count()) >= 1);
  await p2.close();

  // 7b. 规划态:加模块→图合并规划节点→生成任务书→任务创建+规划清空
  await page.click("#ppPlanBtn");
  await page.waitForTimeout(300);
  check("规划面板展开", await page.locator("#ppPlan").isVisible());
  await page.fill("#planAddName", "payments");
  await page.fill("#planAddNote", "支付域:下单与退款");
  await page.click("#planAddGo");
  await page.waitForTimeout(900);
  const planTxt = await page.locator("#planList").textContent();
  check("规划项在列(新增模块)", planTxt.includes("payments"), planTxt.slice(0, 50));
  // 规划移除 alpha + 新依赖 front→payments
  await page.selectOption("#planDelSel", "alpha");
  await page.click("#planDelGo");
  await page.waitForTimeout(700);
  await page.selectOption("#planDepFrom", "front");
  await page.selectOption("#planDepTo", "payments");
  await page.click("#planDepGo");
  await page.waitForTimeout(900);
  const plan2 = await page.locator("#planList").textContent();
  check("规划三项齐(增/删/依赖)", plan2.includes("payments") && plan2.includes("alpha") && plan2.includes("front"), plan2.slice(0, 70));
  const gsvg = await page.locator("#ppGraph").innerHTML();
  check("图合并规划态(规划节点/删除样式/虚线边)", gsvg.includes("payments") && (gsvg.includes("pnew") || gsvg.includes("node")), gsvg.length + "B");
  // 生成任务书并执行(step-101:088 起确认已是 uiConfirm 主题模态,page.once("dialog") 永远接不到
  // →模态残留拦截后续全部点击,本 spec 确定性红的真因;改接 .uid-mask 内 .uid-ok)
  await page.click("#planApply");
  await page.locator(".uid-mask .uid-ok").click();
  await page.waitForTimeout(1200);
  const plan3 = await page.locator("#planList").textContent();
  check("落地后规划清空", !plan3.includes("payments") || plan3.includes("暂无"), plan3.slice(0, 40));
  const chg2 = await page.locator("#ppChanges").textContent();
  check("演进记录「规划落地」", chg2.includes("规划落地"), chg2.slice(0, 60));
  // 任务列表出现 [规划] 任务
  const taskRow = await page.locator("#taskList").textContent();
  check("规划任务已派发(任务列表在列)", taskRow.includes("[规划]") || taskRow.includes("架构调整"), "");

  // 7c. git 历史×模块:alpha 模块详情含提交
  await page.fill("#ppSearch", "alpha");
  await page.waitForTimeout(300);
  await page.locator("#ppMods .pp-mod").first().click();
  await page.waitForTimeout(300);
  const detGit = await page.locator("#ppDetail").textContent();
  check("模块详情含 git 提交", detGit.includes("最近提交") && detGit.includes("初始三模块") || detGit.includes("测试者"), detGit.slice(0, 90));
  await page.fill("#ppSearch", "");

  // 8. 重建按钮(重跑管线→完成;窗同 45s,见第 3 节)
  await page.click("#ppRebuild");
  let done2 = false;
  for (let i = 0; i < 90 && !done2; i++) {
    await page.waitForTimeout(500);
    done2 = (await page.locator("#ppState").textContent()) === "完成";
  }
  check("手动重建→完成", done2);

  // 清理:移除测试项目(净状态)。step-101 两处现代化:①项目行已无 .p-del 按钮——删除迁入
  // 「…」更多菜单(openProjectMenu→移除项目,panel.ts renderProjects 在案);②确认同为 088
  // uiConfirm 主题模态,接 .uid-mask 内 .uid-ok(原生 dialog 永远等不到)。
  await row.hover();
  await row.locator(".p-more").click();
  await page.locator("#taskMenu .tm-item", { hasText: "移除项目" }).click();
  await page.locator(".uid-mask .uid-ok").click();
  await page.waitForTimeout(800);

  check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  await browser.close();
  rmSync(proj, { recursive: true, force: true });
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });
