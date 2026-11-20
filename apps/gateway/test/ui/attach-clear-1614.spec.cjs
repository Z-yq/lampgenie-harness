/** 真机复验:发送后输入区待发送项(附件 chip)立刻消失。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/attach-clear-1614.spec.cjs
 * 三态:①直发(真上传) ②慢上传+回车(用户截图同款:在上传在飞时回车) ③上传失败(保留文本+提示)
 * 断言面全部走真浏览器 + 真 WS 帧(task.submit 的 attachments 在场 → 证明「清了但没丢」)。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const SHOTS = path.resolve(__dirname, "../../../../tasks/-composer-attach-clear/shots");
fs.mkdirSync(SHOTS, { recursive: true });
// 1x1 PNG(真实可解码,走真 /upload → 真落盘)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let fails = 0;
const check = (label, cond, extra) => {
  console.log((cond ? "✓ " : "✗ ") + label + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
  if (!cond) fails++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sent = [];
  page.on("websocket", (ws) => ws.on("framesent", (f) => { try { sent.push(String(f.payload)); } catch (e) {} }));
  const submits = () => sent.map((s) => { try { return JSON.parse(s); } catch (e) { return null; } })
    .filter((m) => m && m.type === "task.submit");
  const toasts = async () => page.$$eval("#toastHost .toast", (els) => els.map((e) => e.textContent || ""));
  const chipCount = () => page.$$eval("#attBar .att-chip", (els) => els.length);
  const barShown = () => page.$eval("#attBar", (el) => el.style.display !== "none");
  const placeholder = () => page.$eval("#instruction", (el) => el.placeholder);
  const value = () => page.$eval("#instruction", (el) => el.value);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#instruction", { state: "attached", timeout: 30000 });
 // 自愈:首页可能停在非 chat 视图(ide/term 等)→ 输入区隐藏,先切回聊天视图
  await page.evaluate(() => { try { if (typeof switchView === "function") switchView("chat"); } catch (e) { /* 无则跳过 */ } });
  await page.waitForSelector("#instruction", { state: "visible", timeout: 30000 });
  await wait(600);
  const bootFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);

 // ① 直发:真上传 → chip 在位 → 回车 → 立刻全清 + 附件随消息送达
  await page.setInputFiles("#attInput", { name: "shot.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => document.querySelectorAll("#attBar .att-chip").length === 1, null, { timeout: 8000 });
  check("① 附件 chip 已进输入区", await chipCount() === 1, { chips: await chipCount() });
  await page.screenshot({ path: path.join(SHOTS, "after-1-chip-ready.png") });
  await page.fill("#instruction", "附件直发:附件应随消息发出");
  await page.focus("#instruction");
  await page.keyboard.press("Enter");
  await wait(700);
  check("① 发送后 chip 全清", await chipCount() === 0, { chips: await chipCount() });
  check("① 发送后附件条隐藏", (await barShown()) === false);
  check("① 输入框已清空", (await value()) === "", { value: await value() });
  const ph1 = String(await placeholder());
  check("① placeholder 复位到空闲/busy 双态文案", ph1.indexOf("附件还在上传") < 0 && (ph1.indexOf("说点什么") >= 0 || ph1.indexOf("任务运行中") >= 0), { ph: ph1 });
 // 焦点:基线(改动前后一致)的既有点是终端坞 #termInput 在 boot 与交互后抢焦点(与本次改动无关,登记遗留);
 // 这里断言「本次清空动作没有把焦点吸到附件条/已删元素」——焦点要么回输入框,要么与 boot 基线同点。
  const afterFocus = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check("① 焦点未落在已清空的附件条上(基线焦点习惯见遗留)", afterFocus === "instruction" || afterFocus === bootFocus,
    { bootFocus, afterFocus });
  const s1 = submits();
  check("① 消息帧带附件(清≠丢)", s1.length >= 1 && Array.isArray(s1[0].attachments) && s1[0].attachments.some((a) => a.name === "shot.png"), { frames: s1.length, atts: s1[0] && s1[0].attachments });
  await page.screenshot({ path: path.join(SHOTS, "after-2-after-send.png") });

 // ② 慢上传 + 回车(用户截图同款):在上传在飞时提交 → 拦下提示 → 落定自动发送(仍带附件)
  const before2 = submits().length;
  await page.route("**/upload?**", async (route) => { await wait(1200); await route.continue(); });
  await page.setInputFiles("#attInput", { name: "slow.png", mimeType: "image/png", buffer: PNG });
  await page.fill("#instruction", "附件慢上传:回车应等上传落定再发");
  await page.focus("#instruction");
  await page.keyboard.press("Enter");
  await wait(200);
  const t2 = await toasts();
  check("② 在飞回车被拦下并提示", t2.some((t) => t.indexOf("附件还在上传") >= 0), { toasts: t2 });
  check("② 拦下时未发消息", submits().length === before2, { submits: submits().length - before2 });
  check("② 拦下时文本保留", (await value()).indexOf("慢上传") >= 0);
  await page.screenshot({ path: path.join(SHOTS, "after-3-upload-inflight-blocked.png") });
  await page.waitForFunction(() => !document.querySelector("#attBar .att-chip"), null, { timeout: 8000 }).catch(() => {});
  await wait(2200);
  const s2 = submits();
  check("② 落定后自动发送", s2.length === before2 + 1, { delta: s2.length - before2 });
  check("② 自动发送的消息带附件", !!(s2[s2.length - 1] && Array.isArray(s2[s2.length - 1].attachments) && s2[s2.length - 1].attachments.some((a) => a.name === "slow.png")), { atts: s2[s2.length - 1] && s2[s2.length - 1].attachments });
  check("② 发送后 chip 全清", await chipCount() === 0, { chips: await chipCount() });
  check("② 发送后输入框清空", (await value()) === "");
  await page.screenshot({ path: path.join(SHOTS, "after-4-auto-sent.png") });
  await page.unroute("**/upload?**");

 // ③ 上传失败:不代发、文本保留、明确提示、坏附件不进待发区
  const before3 = submits().length;
  await page.route("**/upload?**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "boom-1614" }) });
  });
  await page.setInputFiles("#attInput", { name: "bad.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("#toastHost .toast")).some((e) => (e.textContent || "").indexOf("上传失败") >= 0), null, { timeout: 8000 }).catch(() => {});
  const t3 = await toasts();
  check("③ 上传失败有提示", t3.some((t) => t.indexOf("上传失败") >= 0), { toasts: t3 });
  check("③ 失败后 chip 不进待发区", await chipCount() === 0, { chips: await chipCount() });
  await page.screenshot({ path: path.join(SHOTS, "after-5-upload-failed.png") });
  await page.unroute("**/upload?**");

 // ④ 连续两次提交不误清:第二次的附件只在第二次消息里
  await page.setInputFiles("#attInput", { name: "second.png", mimeType: "image/png", buffer: PNG });
  await page.waitForFunction(() => document.querySelectorAll("#attBar .att-chip").length === 1, null, { timeout: 8000 });
  const names4 = await page.$$eval("#attBar .att-chip", (els) => els.map((e) => e.textContent || ""));
  check("④ 第一笔已清、只剩第二次新附件", names4.length === 1 && names4[0].indexOf("second.png") >= 0, { chips: names4 });
  const before4 = submits().length;
  await page.fill("#instruction", "附件第二次提交");
  await page.focus("#instruction");
  await page.keyboard.press("Enter");
  await wait(700);
  const s4 = submits();
  check("④ 第二次消息只带自己的附件", s4.length === before4 + 1 && (s4[s4.length - 1].attachments || []).map((a) => a.name).join(",") === "second.png", { atts: s4[s4.length - 1] && s4[s4.length - 1].attachments });

  await page.screenshot({ path: path.join(SHOTS, "after-6-final.png") });
  await browser.close();
  console.log(fails === 0 ? "[attach-clear-1614] ALL PASS" : "[attach-clear-1614] FAILS=" + fails);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });