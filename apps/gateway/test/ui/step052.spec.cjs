/** UI 经验证:①变更条文件清单就地展开 + 右侧 diff 抽屉(零原生弹窗) ②模型列表逐一探活。
 * F1 动态找一条有 diffbar 的任务(快照 sha 存在即有空对比);F4 真实调用端点探活一个模型。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const consoleErrors = [];
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message().slice(0, 50)); d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Notification")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);

  // ---------- F1:页面内选一条终态任务开会话,等变更条出现(diffstat 由 openSession 自动拉) ----------
  const sids = await page.evaluate(() => {
    const out = [];
    for (const t of tasks.values()) if (t.state === "done" || t.state === "failed") out.push(t.sessionId);
    return out.slice(-8);
  });
  let found = false;
  for (const sid of sids) {
    await page.evaluate((x) => openSession(x), sid);
    await page.waitForTimeout(1800);
    if (await page.locator("#chatBody .diffbar").count()) { found = true; break; }
  }
  check("找到带变更条的任务", found, "终态会话=" + sids.length);

  if (found) {
    const bar = page.locator("#chatBody .diffbar").first();
    // 1. 点「N 个文件已更改」→ 就地展开清单,不弹窗
    await bar.locator(".files-link").click();
    await page.waitForTimeout(500);
    const rows = await page.locator("#chatBody .filelist .fl-row").count();
    check("文件清单就地展开(非弹窗)", rows > 0, "rows=" + rows);
    check("展开动作零原生弹窗", dialogs.length === 0, dialogs.join("|"));
    const firstRow = page.locator("#chatBody .filelist .fl-row").first();
    const fpath = await firstRow.getAttribute("data-file");
    // 2. 点文件行 → 右侧抽屉出现,diff 内容落地
    await firstRow.click();
    try {
      await page.locator("#dd.on").waitFor({ timeout: 8000 });
      check("右侧 diff 抽屉滑出", true);
    } catch { check("右侧 diff 抽屉滑出", false); }
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById("ddBody");
        return b && (b.textContent.indexOf("diff --git") >= 0 || b.textContent.indexOf("无法获取补丁") >= 0 || b.textContent.indexOf("(无差异") >= 0);
      }, { timeout: 15000 });
      const body = await page.locator("#ddBody").textContent();
      check("补丁内容落地(diff 文本)", body.includes("diff --git") || body.includes("(无差异") || body.includes("无法获取补丁"), body.slice(0, 60));
      const title = await page.locator("#ddTitle").textContent();
      check("抽屉标题=文件路径", title === fpath, title + " vs " + fpath);
    } catch {
      check("补丁内容落地(diff 文本)", false, (await page.locator("#ddBody").textContent() || "").slice(0, 60));
    }
    check("点击文件行高亮(.on)", (await page.locator("#chatBody .filelist .fl-row.on").count()) === 1);
    // 3. 收起:抽屉关闭
    await page.click("#ddClose");
    await page.waitForTimeout(400);
    check("抽屉可收起", (await page.locator("#dd").getAttribute("class") || "").indexOf("on") < 0);
    // 4. 再点变更条 → 清单收起
    await bar.locator(".files-link").click();
    await page.waitForTimeout(400);
    check("二次点击清单收起", (await page.locator("#chatBody .filelist").count()) === 0);
  }

  // ---------- F4:模型列表逐一探活 ----------
  await page.click("#uGear");
  await page.waitForTimeout(300);
  await page.click('.set-nitem[data-sec="model"]');
  await page.waitForTimeout(600);
  await page.click("#models-fetch");
  try {
    await page.locator("#modelList .model-row").first().waitFor({ timeout: 20000 });
    check("模型列表就绪", true, "rows=" + (await page.locator("#modelList .model-row").count()));
  } catch { check("模型列表就绪", false); }
  const probeBtn = page.locator("#modelList .model-row button[data-act=probe]").first();
  check("每行有「测」按钮", (await page.locator("#modelList .model-row button[data-act=probe]").count()) > 0);
  const mid = await page.locator("#modelList .model-row").first().getAttribute("data-id");
  await probeBtn.click();
  try {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll("#modelList .model-row");
      for (const r of rows) if (r.querySelector(".mr-ok, .mr-bad")) return true;
      return false;
    }, { timeout: 30000 });
    const chip = await page.locator("#modelList .model-row").first().locator(".mr-tag").last().textContent().catch(() => "");
    const anyChip = await page.locator("#modelList .mr-ok, #modelList .mr-bad").first().textContent();
    check("探活结果落地(可用/不可用徽标)", anyChip.length > 0, mid + " → " + anyChip.trim() + (chip ? "" : ""));
  } catch { check("探活结果落地(可用/不可用徽标)", false, "30s 未见徽标"); }
  check("全部检测按钮在位", (await page.locator("#models-probe-all").count()) === 1);

  check("全程零原生弹窗", dialogs.length === 0, dialogs.join("|"));
  check("零 console/page 错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/step052.png" });
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();