/** UI 经验证:评审遗留(行级回写店)面板视图(遗留3)——
 * 预置店 fixture(1 开放 blocker + 1 已解决)→ 添加激活项目 → 切洞察 → 断言分桶渲染与行点击定位。
 * 用法: PANEL_BASE=http://127.0.0.1:77xx node revstore.spec.cjs */
const { chromium } = require("playwright-core");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const projDir = mkdtempSync(join(tmpdir(), "gh-revstore-ui-"));
  writeFileSync(join(projDir, "sample.ts"), "export const sampleValue = 1;\n// line two\n// line three\n");
  const storeDir = join(projDir, ".genie");
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, "review-comments.json"), JSON.stringify({ version: 1, updatedAt: 1, comments: [
    { key: "openkey1", path: "sample.ts", line: 1, rule: "bug", message: "加法实现写成减法,语义相反", severity: "blocker", postedAt: 1, repostCount: 2 },
    { key: "reskey1", path: "sample.ts", line: 3, rule: "style", message: "旧的样式建议(已不再复现)", severity: "nit", postedAt: 1, resolvedAt: 2 },
  ] }));
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    // 1. 添加并激活项目(激活后 store 查询才会打到项目根)
    await page.click("#projAddBtn");
    await page.fill("#projPathInput", projDir);
    await page.click("#projAddGo");
    const row = page.locator(".proj-row", { hasText: projDir.split("/").pop() }).first();
    await row.waitFor({ timeout: 10000 });
    await row.click();
    await page.waitForTimeout(600);
    check("项目添加并激活", true);

    // 2. 打开代码档案(act-sense→openProfileEntry→view-project)→ revStoreLoad 自动发
    await page.click("#act-sense");
    // 等渲染完成(WS 往返异步,不用固定 sleep)
    await page.waitForFunction(() => {
      const t = document.querySelector("#revStoreBody")?.textContent || "";
      return t.includes("开放") || t.includes("店为空");
    }, { timeout: 15000 });
    const bodyText = await page.locator("#revStoreBody").textContent();
    check("分桶统计渲染(开放 1 · 已解决 1)", (bodyText || "").includes("开放 1") && (bodyText || "").includes("已解决 1"), (bodyText || "").slice(0, 60));
    check("开放条目在列(路径:行)", (bodyText || "").includes("sample.ts:1"), "");
    check("已解决折叠区在", (bodyText || "").includes("已解决 1 条"), "");
    const badge = await page.locator("#revStoreBody .rev-sev").first().textContent();
    check("severity 徽标(BLOCKER)", (badge || "").toUpperCase().includes("BLOCKER"), badge || "");
    const repro = await page.locator("#revStoreBody .rev-detail").first().textContent().catch(() => "");
    check("复现次数显示", (repro || "").includes("2"), repro || "");

    // 3. 点开放行 → 文件查看器定位(F4 查看器复用)
    await page.locator("#revStoreBody .rev-card").first().click();
    await page.waitForTimeout(600);
    const fvOn = await page.locator("#fileViewer.on").count();
    const fvText = await page.locator("#fvBody").textContent().catch(() => "");
    check("行点击打开文件查看器", fvOn > 0 && (fvText || "").includes("sampleValue"), (fvText || "").slice(0, 40));

    check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } catch (e) {
    check("评审遗留 UI 流程", false, String(e).slice(0, 120));
  } finally {
    await browser.close();
    rmSync(projDir, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})();
