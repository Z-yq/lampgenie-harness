/** 闭环端到端( D5):真实 LLM + 生产 gateway(PANEL_BASE)——
 * 夹具项目植入 ghp_ 假凭证(blocker)→ 任务1 调 code_review 出评论卡 → 一键「全部注入」→
 * 任务2 agent 按评论修复 → 再跑 code_review → finding 消失。
 * 取证:journal(/tmp/j-s074)事件链 + 文件内容世界验证 + 截图。
 * 用法: PANEL_BASE=http://127.0.0.1:7800 node test/ui/revloop.spec.cjs */
const { chromium } = require("playwright-core");
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execSync } = require("node:child_process");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7800";
const JOURNAL = process.env.JOURNAL_FILE || "/tmp/j-s074/gateway.jsonl";
const FAKE_TOKEN = "ghp_" + "Ab3dEf9Hk2Lm5Np8Qr4St7Vx1Yz6Uw"; // 命中确定性凭证红线(非真实凭证)

function journalEvents() {
  try {
    return readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

(async () => {
  // 夹具:git 仓 + 已提交净基线 + 未提交改动(植入假凭证)
  const projDir = mkdtempSync(join(tmpdir(), "gh-revloop-"));
  writeFileSync(join(projDir, "config.ts"), "export const appName = \"demo\";\n");
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: projDir });
  writeFileSync(join(projDir, "config.ts"), "export const appName = \"demo\";\nexport const token = \"" + FAKE_TOKEN + "\";\n");

  const shotDir = join(__dirname, "../../../../tasks/-review-inject-chat/shots");
  mkdirSync(shotDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    // 权限 mode=auto(闭环无人值守:edit_file 不走面板审批)
    await page.evaluate(() => wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { permissions: { mode: "auto" } } })));
    await page.waitForTimeout(400);

    // 添加并激活夹具项目
    await page.click("#projAddBtn");
    await page.fill("#projPathInput", projDir);
    await page.click("#projAddGo");
    const prow = page.locator(".proj-row", { hasText: projDir.split("/").pop() }).first();
    await prow.waitFor({ timeout: 10000 });
    await prow.click();
    await page.waitForTimeout(500);
    check("L1 夹具项目添加并激活", true);

    // 任务1:审查(显式要求调 code_review,不改文件)
    await page.evaluate(() => switchView("chat"));
    await page.fill("#instruction", "请立即调用 code_review 工具(target 留空)审查当前项目的未提交变更,把发现列出来。不要修改任何文件。");
    await page.click("#go");
    const sid = await page.evaluate("currentSid");
    // 等 review.findings 卡出现(LLM 调工具,最长 150s)
    await page.waitForFunction(() => document.querySelectorAll(".rev-group").length >= 1, undefined, { timeout: 150000 });
    const cardText = await page.locator(".rev-group").first().textContent();
    check("L2 code_review 出评论卡", true, (cardText || "").slice(0, 60));
    check("L3 卡含 blocker 疑似凭证入库", (cardText || "").includes("疑似凭证入库"), (cardText || "").slice(0, 80));
    await page.screenshot({ path: join(shotDir, "loop-1-review-card.png") });

    // 一键「全部注入」→ modal(默认当前会话)→ 附言引导直接修(省探索轮次)→ 确认
    await page.locator(".rev-group .rev-inj-all").first().click();
    await page.locator("#revInjMask.on").waitFor({ timeout: 5000 });
    await page.fill("#revInjNote", "修复方式很直接:read_file 之后 edit_file 删除含凭证的那一行即可;不要 spawn_subagent;修复后立即运行 code_review 工具复查。");
    await page.screenshot({ path: join(shotDir, "loop-2-inject-modal.png") });
    await page.click("#revInjGo");
    await page.waitForTimeout(600);
    const toastT = await page.locator('.toast', { hasText: "已注入" }).last().textContent().catch(() => "");
    check("L4 注入回执 toast", (toastT || "").includes("已注入"), toastT || "");
    check("L5 注入目标=当前会话(未跳转)", (await page.evaluate("currentSid")) === sid);
    await page.screenshot({ path: join(shotDir, "loop-3-injected.png") });

    // 任务2(agent 按评论修复+复查):复查到达的服务端真相=journal 出现该会话第二条 review.findings
    // (轮询 journal 文件而非等 DOM:LLM 轮次时长不稳,UI 卡渲染已由 revinject/revcards 覆盖)
    let rf = [];
    for (let i = 0; i < 280; i++) {
      rf = journalEvents().filter((e) => e.kind === "review.findings" && e.sessionId === sid);
      if (rf.length >= 2) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    check("L6a 复查 review.findings 到达(journal 第二条)", rf.length >= 2, "findings 事件数=" + rf.length);
    await page.evaluate(() => refreshHist()).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(shotDir, "loop-4-after-fix.png"), fullPage: false });

    // 世界验证 1:文件里假凭证已消失
    const content = readFileSync(join(projDir, "config.ts"), "utf8");
    check("L6 agent 真修了文件(凭证消失)", !content.includes(FAKE_TOKEN), content.slice(0, 80));

    // 世界验证 2:journal 链 review.findings(含 blocker)→ review.inject → review.findings(无 blocker)
    const evs = journalEvents();
    const ri = evs.filter((e) => e.kind === "review.inject" && e.sessionId === sid);
    check("L7 journal 有 review.inject 事件", ri.length >= 1, JSON.stringify((ri[0] || {}).payload || {}).slice(0, 120));
    const last = rf[rf.length - 1];
    const lastFindings = (last && last.payload && last.payload.findings) || [];
    const stillBlocker = lastFindings.filter((f) => String(f.title || "").includes("凭证"));
    check("L9 复查后凭证 finding 消失", stillBlocker.length === 0, "复查找数=" + lastFindings.length + " 含凭证=" + stillBlocker.length);

    check("Z 控制台无错误", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } catch (e) {
    check("闭环流程", false, String(e).slice(0, 200));
    await page.screenshot({ path: join(shotDir, "loop-error.png") }).catch(() => {});
  } finally {
    await browser.close();
    rmSync(projDir, { recursive: true, force: true });
  }
  const fails = results.filter((r) => !r.ok);
  console.log("\n=== 汇总: " + (results.length - fails.length) + "/" + results.length + " PASS ===");
  process.exit(fails.length > 0 ? 1 : 0);
})();
