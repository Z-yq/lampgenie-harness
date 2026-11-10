/** UI 经验证:主模型/chat audio 就地下拉(ZCode 参考形态)——分组列表/筛选/当前勾选/外点·Esc 关闭/零弹窗。
 * 选定动作点「当前项」(同值 no-op cfg.set),不改变生产环境配置。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const consoleErrors = [];
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message().slice(0, 60)); d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Notification")) consoleErrors.push(m.text().slice(0, 150)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // ---- 0. 两 pill 就位且语义正确 ----
  const mp = await page.locator("#modelPill").textContent();
  const ap = await page.locator("#audioPill").textContent();
  check("主模型 pill = web coding 模型(coding.llm)", mp.includes("主模型:") && mp.includes("deepseek-v4.1-flash"), mp.trim());
  check("chat audio pill 独立在右侧", ap.includes("chat audio:") && ap.includes("qwen-audio-3.1-realtime-plus"), ap.trim());

  // ---- 1. 点主模型:锚点上方就地下拉(不弹窗) ----
  await page.click("#modelPill");
  await page.waitForTimeout(250);
  check("下拉就地出现(.pill-menu)", await page.locator(".pill-menu").isVisible());
  const nItems = await page.locator(".pill-menu .pm-item").count();
  check("列表项充足(已配置模型)", nItems > 20, "items=" + nItems);
  check("筛选框在场(>12 项)", await page.locator(".pill-menu .pm-q").isVisible());
  const curTxt = await page.locator(".pill-menu .pm-item.cur").first().textContent();
  check("当前项勾选", curTxt.includes("deepseek-v4.1-flash"), curTxt.trim());
  const groups = await page.locator(".pill-menu .pm-head").count();
  check("按 provider 分组", groups >= 1, "groups=" + groups);
  // 菜单在锚点上方(向上展开)
  const mr = await page.locator(".pill-menu").boundingBox();
  const pr = await page.locator("#modelPill").boundingBox();
  check("向上展开(菜单底 ≤ pill 顶)", mr && pr && mr.y + mr.height <= pr.y + 4, "menuBottom=" + (mr && mr.y + mr.height) + " pillTop=" + (pr && pr.y));

  // ---- 2. 筛选生效 ----
  await page.fill(".pill-menu .pm-q", "deep");
  await page.waitForTimeout(150);
  const visible = await page.locator(".pill-menu .pm-grp .pm-item:visible").allTextContents();
  check("筛选后仅命中项", visible.length > 0 && visible.every((t) => t.toLowerCase().includes("deep")), "n=" + visible.length + " 例:" + visible.slice(0, 3).join(","));
  await page.fill(".pill-menu .pm-q", "");
  await page.waitForTimeout(100);

  // ---- 3. Esc 关闭 ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("Esc 关闭下拉", (await page.locator(".pill-menu").count()) === 0);

  // ---- 4. 选定动作(点当前项,同值 no-op)+ 关闭 ----
  await page.click("#modelPill");
  await page.waitForTimeout(200);
  await page.click(".pill-menu .pm-item.cur");
  await page.waitForTimeout(500);
  check("点选后菜单关闭", (await page.locator(".pill-menu").count()) === 0);
  const toastTxt = await page.locator("#toastHost .toast").last().textContent().catch(() => "");
  check("切换 toast 反馈", toastTxt.includes("deepseek-v4.1-flash"), (toastTxt || "").trim());
  const mp2 = await page.locator("#modelPill").textContent();
  check("pill 值保持(同值切换)", mp2.includes("deepseek-v4.1-flash"));

  // ---- 5. chat audio pill 同款下拉 + 外点关闭 ----
  await page.click("#audioPill");
  await page.waitForTimeout(250);
  check("chat audio 下拉出现", await page.locator(".pill-menu").isVisible());
  const acur = await page.locator(".pill-menu .pm-item.cur").first().textContent();
  check("chat audio 当前项勾选", acur.includes("qwen-audio-3.1-realtime-plus"), acur.trim());
  await page.mouse.click(400, 300); // 外部点击
  await page.waitForTimeout(200);
  check("外部点击关闭", (await page.locator(".pill-menu").count()) === 0);

  // ---- 5b. 设置页拉取路径复活(旧无条件 return 死代码修复):models.list 落到 model-ids/renderModelList ----
  await page.evaluate(() => ws.send(JSON.stringify({ v: 1, type: "models.list" })));
  await page.waitForTimeout(3000);
  const idsN = await page.evaluate(() => (typeof lastModelIds !== "undefined" && lastModelIds ? lastModelIds.length : -1));
  check("设置页拉取路径恢复(model-ids 填充)", idsN > 0, "ids=" + idsN);

  // ---- 6. 零弹窗(全流程无 prompt/confirm/alert) ----
  check("全程零原生弹窗", dialogs.length === 0, dialogs.join(" | "));
  check("零 console/page 错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/modelmenu.png" });
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();