/** UI 实测:项目级代码洞察端到端(审计 R1-C15b 补)——
 * 面板添加项目→激活→洞察查询,证明查询走的是项目根而非 harness 根。
 * 用法: PANEL_BASE=http://127.0.0.1:77xx node sensproj.spec.cjs */
const { chromium } = require("playwright-core");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const projDir = mkdtempSync(join(tmpdir(), "gh-sensproj-ui-"));
  writeFileSync(join(projDir, "soloUi.ts"), "export function soloSenseUiFn(): number {\n  return 42;\n}\n");
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

    // 1. 添加项目(设置/项目区入口按 id 直开输入框)
    await page.click("#projAddBtn");
    await page.fill("#projPathInput", projDir);
    await page.click("#projAddGo");
    const row = page.locator(".proj-row", { hasText: projDir.split("/").pop() }).first();
    await row.waitFor({ timeout: 10000 });
    check("项目添加并出现在清单", true);

    // 2. 激活(点行)
    await row.click();
    await page.waitForTimeout(600);
    const onRow = await page.locator(".proj-row.on").first().textContent().catch(() => "");
    check("项目已激活(金线)", (onRow || "").includes(projDir.split("/").pop()), (onRow || "").slice(0, 40));

    // 3. 切洞察并查询项目内符号
    await page.click("#act-sense");
    await page.waitForTimeout(300);
    await page.fill("#sense-q", "soloSenseUiFn");
    await page.selectOption("#sense-mode", "debug");
    await page.click("#sense-go");
    await page.locator("#sense-mermaid svg").first().waitFor({ timeout: 120000 });
    const detail = await page.locator("#sense-detail").textContent();
    check("查询走项目根(命中 soloUi.ts)", detail.includes("soloUi.ts") && detail.includes("soloSenseUiFn"), detail.slice(0, 80));
    check("控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } catch (e) {
    check("项目级洞察 UI 流程", false, String(e).slice(0, 120));
  } finally {
    await browser.close();
    rmSync(projDir, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})();
