/** step-997/UI 板浏览器验收:模型管理页结果态 + 添加 Provider 弹窗 + 生效模型切换 + 五态/密钥锁/回滚。
 * 目标=隔离 gateway(PANEL_BASE 默认 7791),不碰 7700 产线配置。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7791";

(async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const consoleErrors = [], dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message().slice(0, 80)); d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|Notification/.test(m.text())) consoleErrors.push(m.text().slice(0, 180)); });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERROR: " + String(e).slice(0, 180)));
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const text = async (sel) => (await page.locator(sel).textContent().catch(() => "")) || "";

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { switchView("sys"); setSection("model"); });
  await page.waitForTimeout(800);

  // 1) 四件套 + 当前值与 composer pill 同步
  check("生效模型区块可见", await page.locator("#modelSwitch").isVisible());
  for (const id of ["#msw-current", "#msw-select", "#msw-confirm", "#msw-status"]) check("四件套 " + id, await page.locator(id).count() === 1);
  const cur = await text("#msw-current");
  const pill = await text("#modelPill");
  check("当前模型行=mock-a", cur.includes("mock-a"), cur.trim());
  check("与 composer pill 同值", pill.includes("mock-a"), pill.trim());
  check("下拉默认勾当前生效模型", (await page.inputValue("#msw-select")) === "mock-a", await page.inputValue("#msw-select"));
  const groups = await page.locator("#msw-select optgroup").count();
  check("下拉按 provider 分组", groups >= 2, "optgroups=" + groups);
  const opts = await page.locator("#msw-select option").allTextContents();
  check("目录含多 provider 模型", opts.some((x) => x.includes("mock-c")) && opts.length > 10, "n=" + opts.length);
  check("下拉含「跟随全局」项", opts.some((x) => x.includes("跟随全局")), opts.slice(0, 2).join(" | "));
  check("当前模型所在组直展", (await page.locator('#msw-select optgroup[label="MockOne"] option[value="mock-a"]').count()) === 1);
  const status = await text("#msw-status");
  check("状态行显示当前生效", /当前生效:mock-a/.test(status), status.trim());

  // 2) 结果态:Provider 结果可见,过程表单收进弹窗
  const secText = await text("#sec-model");
  check("Provider 结果卡可见", (await page.locator("#prov-list .prov-card").count()) >= 1, "n=" + (await page.locator("#prov-list .prov-card").count()));
  check("添加 Provider 入口可见", await page.locator("#prov-add-open").isVisible());
  check("默认无常驻添加表单/预设墙", await page.locator("#prov-modal-mask").isHidden() && !(await page.locator("#prov-manual-sec").isVisible()));
  await page.click("#prov-add-open");
  await page.waitForTimeout(250);
  check("添加弹窗打开且预设 16 张", await page.locator("#prov-modal-mask").isVisible() && (await page.locator("#provPresets .preset-card").count()) === 16);
  await page.click("#prov-modal-close");
  await page.waitForTimeout(150);
  check("弹窗关闭回结果态", await page.locator("#prov-modal-mask").isHidden());
  check("模型区无绝对路径/secrets/journal.dir 字样", !/\/mnt\/|secrets\.json|journal\.dir/.test(secText), secText.match(/\/mnt\/|secrets\.json|journal\.dir/)?.[0] || "");

  // 3) pill 菜单:切回 chat 视图(设置页隐藏 composer)后测分组/搜索/勾选/无 key 锁
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(400);
  await page.click("#modelPill");
  await page.waitForTimeout(300);
  check("pill 菜单打开", await page.locator(".pill-menu").isVisible());
  check("搜索框在场(>12 模型)", await page.locator(".pill-menu .pm-q").isVisible());
  const curItem = await text(".pill-menu .pm-item[data-v].cur");
  check("pill 当前项勾选 mock-a", curItem.includes("mock-a"), curItem.trim());
  await page.fill(".pill-menu .pm-q", "mock-0");
  await page.waitForTimeout(200);
  const vis = await page.locator(".pill-menu .pm-item[data-v]:visible").allTextContents();
  check("搜索过滤生效", vis.length > 0 && vis.every((t) => /mock-0/.test(t)), "n=" + vis.length);
  await page.fill(".pill-menu .pm-q", "");
  await page.waitForTimeout(200);
  await page.waitForTimeout(900); // 等 secret.status 回包
  const p3head = page.locator('.pill-menu .pm-grp[data-g="p3"] .pm-ghead');
  if (await p3head.count()) { await p3head.click(); await page.waitForTimeout(250); }
  const locked = page.locator(".pill-menu .pm-item.locked");
  check("未配 key 的模型被锁定(p3 二级)", (await locked.count()) >= 1, "n=" + (await locked.count()) + " secret=" + JSON.stringify(await page.evaluate(() => secretKeyState)));
  if (await locked.count()) {
    check("锁定项带原因 title", !!(await locked.first().getAttribute("title") || await locked.first().locator(".pm-warn").getAttribute("title")));
    const before = await text("#modelPill");
    await locked.first().click();
    await page.waitForTimeout(300);
    check("锁定项点击不切换/菜单保留", (await text("#modelPill")) === before && (await page.locator(".pill-menu").count()) === 1);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.evaluate(() => { switchView("sys"); setSection("model"); });
  await page.waitForTimeout(300);

  // 4) 五态:空/加载/错误(构造页面状态,不伪造后端数据)
  await page.evaluate(() => { window.__savedCfg = JSON.parse(JSON.stringify(cfgView)); cfgView.config.providers = []; cfgView.config.coding.llm = {}; renderModelSwitch(); });
  await page.waitForTimeout(150);
  check("空态:无可选模型引导", (await text("#msw-status")).includes("还没有可选模型"), await text("#msw-status"));
  check("空态:下拉/确认禁用", (await page.locator("#msw-select").isDisabled()) && (await page.locator("#msw-confirm").isDisabled()));
  await page.evaluate(() => { cfgView = window.__savedCfg; renderModelSwitch(); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { modelListFailed = true; modelSwitchNotice = { cls: "err", text: "模拟拉取失败" }; renderModelSwitch(); });
  await page.waitForTimeout(100);
  check("错误态:红字+重试按钮", (await page.locator("#msw-status").getAttribute("class")).includes("err") && await page.locator("#msw-retry").isVisible());
  const retrySent = await page.evaluate(() => new Promise((resolve) => {
    let hit = false; const old = ws.send.bind(ws);
    ws.send = (p) => { try { if (JSON.parse(p).type === "models.list") hit = true; } catch (e) {} return old(p); };
    document.querySelector("#msw-retry").click();
    setTimeout(() => { ws.send = old; resolve(hit); }, 500);
  }));
  check("错误态重试重发 models.list", retrySent === true);
  await page.waitForTimeout(800);
  await page.evaluate(() => renderModelSwitch());
  const opts2 = await page.locator("#msw-select option").allTextContents();
  check("手填未验证模型带「未验证」标注", opts2.some((x) => /未验证/.test(x)), opts2.filter((x) => /未验证/.test(x)).slice(0, 2).join(" | "));
  await page.evaluate(() => { modelListFailed = false; modelSwitchNotice = null; cfgView = null; renderModelSwitch(); });
  await page.waitForTimeout(100);
  check("加载态:配置未到不冒充可用", (await text("#msw-status")).includes("加载配置") && await page.locator("#msw-select").isDisabled());
  await page.evaluate(() => ws.send(JSON.stringify({ v: 1, type: "cfg.get" })));
  await page.waitForTimeout(600);

  // 5) 会话级切换:确认→服务端回执→pill/设置页同步
  await page.evaluate(() => { currentSid = "ui-test-session"; sessionModelOverride.delete(currentSid); sessionModelStaged.delete(currentSid); sessionModelRev.delete(currentSid); renderModelSwitch(); });
  await page.selectOption("#msw-select", "mock-c");
  await page.waitForTimeout(100);
  check("选择先暂存(未提交)", (await text("#msw-status")).includes("尚未提交"), await text("#msw-status"));
  await page.click("#msw-confirm");
  await page.waitForTimeout(800);
  const afterPill = await text("#modelPill");
  const afterStatus = await text("#msw-status");
  const ov = await page.evaluate(() => sessionModelOverride.get("ui-test-session") || null);
  check("确认后 pill 显示新模型", afterPill.includes("mock-c"), afterPill.trim());
  check("状态行显示已生效", /已生效|已切换/.test(afterStatus), afterStatus);
  check("服务端会话覆盖=mock-c", ov && ov.model === "mock-c", JSON.stringify(ov));

  // 6) 负向:staged 有效期内双点只发一条 session.model.set
  const dup = await page.evaluate(() => {
    currentSid = "ui-test-dup"; sessionModelOverride.delete(currentSid); sessionModelStaged.delete(currentSid); sessionModelRev.delete(currentSid);
    const s = document.querySelector("#msw-select");
    s.value = "mock-b"; s.dispatchEvent(new Event("change"));
    const sent = []; const old = ws.send.bind(ws);
    ws.send = (p) => { try { const j = JSON.parse(p); if (j.type === "session.model.set") sent.push(j); } catch (e) {} return old(p); };
    modelSwitchConfirm(); modelSwitchConfirm();
    ws.send = old;
    return sent;
  });
  check("同值/换值连点只发一条 set", dup.length === 1, "sent=" + dup.length + " " + JSON.stringify(dup));
  await page.waitForTimeout(800);
  check("双点后回包落定", (await page.evaluate(() => sessionModelOverride.get("ui-test-dup")?.model)) === "mock-b");

  // 7) 负向:选一个端点缺密钥的 Provider 模型(绕过前端锁,让服务端预检失败)→ ok:false → 回滚
  await page.evaluate(() => { secretKeyState.MISSING_KEY = true; renderModelSwitch(); });
  await page.selectOption("#msw-select", "mock-locked");
  await page.click("#msw-confirm");
  await page.waitForTimeout(900);
  const failStatus = await text("#msw-status");
  const failPill = await text("#modelPill");
  const lockedOv = await page.evaluate(() => sessionModelOverride.get("ui-test-dup")?.model || null);
  check("失败回滚:状态行报错", /切换失败/.test(failStatus), failStatus);
  check("失败回滚:pill 停在上一生效值", !failPill.includes("mock-locked") && lockedOv === "mock-b", "pill=" + failPill.trim() + " ov=" + lockedOv);

  await page.evaluate(() => { ws = null; renderModelSwitch(); });
  await page.waitForTimeout(100);
  check("断连:确认禁用+重连提示", (await page.locator("#msw-confirm").isDisabled()) && /连接断开/.test(await text("#msw-status")), await text("#msw-status"));
  check("全程零原生弹窗", dialogs.length === 0, dialogs.join(" | "));
  check("零 console/page 错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await page.screenshot({ path: "/tmp/modelpage.png", fullPage: true });
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? "ALL PASS " + results.length : "FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length === 0 ? 0 : 1);
})();
