/* 标注「嵌套选块 + 悬停提示 + 录屏批注合成链」E2E(纯静态页,不依赖网关)。
 * 为什么不起网关:本仓此刻正做 server 分层重构,dist/gateway.mjs 不可用;
 * 本 spec 只把 src/panel 的模板正文(CSS + 标注脚本)拼成静态页,浏览器里跑真链路:
 * ① 从 src 切模板正文(断言无裸反引号/无 ${ —— 模板约束被破坏就 exit 2,不静默)
 * ② 用 __annTestOpen 注入合成图(1200×800:#222 底 + #f0f0f0 大面板 + #3b82f6 小按钮)
 * ③ 断言选块候选里「大框里的小框」都在、悬停 #annHint 显示候选
 * ④ 假 getDisplayMedia(离屏 canvas captureStream)+ 真 MediaRecorder 跑完整录屏 → 回放 → 发送
 * ⑤ 全程 0 pageerror
 * 跑法:cd apps/gateway && node test/ui/annotate-select.spec.cjs
 * 依赖:playwright-core + /usr/bin/google-chrome(缺失 → 打印 SKIP 并 exit 0)。
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "../../../..");
const CHROME = "/usr/bin/google-chrome";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

/** 从 `export const NAME = \`...\`;` 切出模板正文;约束破坏(spec 前提失效)直接 exit 2。 */
function cutTemplate(file, constName) {
  const src = fs.readFileSync(file, "utf8");
  const decl = "export const " + constName + " =";
  const at = src.indexOf(decl);
  if (at < 0) {
    console.error("模板声明缺失:" + constName + " @ " + file);
    process.exit(2);
  }
  const start = src.indexOf("`", at + decl.length);
  const end = src.lastIndexOf("`");
  if (start < 0 || end <= start) {
    console.error("模板反引号边界异常:" + constName + " @ " + file);
    process.exit(2);
  }
  const body = src.slice(start + 1, end);
  if (body.includes("`")) {
    console.error("源码模板约束被破坏:" + file + " 正文含裸反引号");
    process.exit(2);
  }
  if (body.includes("${")) {
    console.error("源码模板约束被破坏:" + file + " 正文含 ${");
    process.exit(2);
  }
  return body;
}

const IMG_W = 1200;
const IMG_H = 800;
const BTN = { x1: 300, y1: 300, x2: 420, y2: 360 };

function buildHtml() {
  const css = cutTemplate(path.join(REPO, "apps/gateway/src/panel/page-css.ts"), "PANEL_CSS");
  const js = cutTemplate(path.join(REPO, "apps/gateway/src/panel/script-annotate.ts"), "PANEL_JS_ANNOTATE");
  if (js.indexOf("<script>") < 0 || js.indexOf("__annTestOpen") < 0) {
    console.error("标注分片里缺 <script> 或验收钩子(__annTestOpen)");
    process.exit(2);
  }
 // 全局桩:标注脚本只依赖 toast/wsSafeSend/currentSid 三个全局
  const stubs = [
    "var currentSid = null;",
    "var toast = function (t, e) { (window.__toasts = window.__toasts || []).push(String(t)); if (e) (window.__toastsErr = window.__toastsErr || []).push(String(t)); };",
    "function wsSafeSend(s) { (window.__sent = window.__sent || []).push(s); }",
  ].join("\n");
  return "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>annotate-select</title>\n"
    + "<style>" + css + "</style></head><body>\n"
    + "<script>" + stubs + "</script>\n"
    + js + "\n</body></html>\n";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch { /* 还没就绪 */ }
    await sleep(100);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log("SKIP 缺浏览器 " + CHROME + "(本 spec 需要真 Chrome 跑 MediaRecorder)");
    process.exit(0);
  }
  const html = buildHtml();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "genie-ann-select-"));
  const page_file = path.join(tmpDir, "annotate-select.html");
  fs.writeFileSync(page_file, html, "utf8");

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html" || req.url === "/annotate-select.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(page_file));
      return;
    }
    res.writeHead(404); res.end("nf");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port + "/";

  const { chromium } = require(REPO + "/apps/gateway/node_modules/playwright-core");
  let browser = null;
  const pageErrors = [];
  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900"],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
 // 假取屏/假麦克风:必须在页面脚本执行前装好(getDisplayMedia 走离屏 canvas captureStream,MediaRecorder 全真)
    const initWithFakeMedia = () => {
      window.__mkScreenStream = function () {
        const cv = document.createElement("canvas");
        cv.width = 640; cv.height = 360;
        const g = cv.getContext("2d");
        let n = 0;
        setInterval(function () {
          n++;
          g.fillStyle = (n % 2) ? "#123a55" : "#552a12";
          g.fillRect(0, 0, 640, 360);
          g.fillStyle = "#ffffff";
          g.fillRect((n * 13) % 580, 40 + (n % 5) * 10, 48, 48);
          g.fillStyle = "#ffe08a";
          g.fillRect(20, 280, 200 + (n % 8) * 10, 40);
        }, 100);
        return cv.captureStream(12);
      };
      const md = navigator.mediaDevices || (navigator.mediaDevices = {});
      Object.defineProperty(md, "getDisplayMedia", {
        configurable: true, writable: true,
        value: function () { return Promise.resolve(window.__mkScreenStream()); },
      });
      Object.defineProperty(md, "getUserMedia", {
        configurable: true, writable: true,
        value: function () { return Promise.reject(new Error("test: 无麦克风设备")); },
      });
    };
    await page.addInitScript(initWithFakeMedia);
    await page.goto(base, { waitUntil: "load" });
    await page.waitForTimeout(120);

 /* ---------- S1 编辑器打开(合成图) ---------- */
    await page.evaluate(([w, h, btn]) => {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const g = cv.getContext("2d");
      g.fillStyle = "#222222"; g.fillRect(0, 0, w, h);
      g.fillStyle = "#f0f0f0"; g.fillRect(200, 120, 800, 580);
      g.fillStyle = "#3b82f6"; g.fillRect(btn.x1, btn.y1, btn.x2 - btn.x1, btn.y2 - btn.y1);
      window.__annTestOpen(cv.toDataURL("image/png"), { source: "screen" });
    }, [IMG_W, IMG_H, BTN]);
    const st1 = await until(async () => page.evaluate(() => window.__annTestState()), 3000);
    check("S1 编辑器打开(__annTestState 非空)", !!st1, st1 ? ("mode=" + st1.mode) : "3s 内无状态");

 /* ---------- S2 嵌套小框可命中 ---------- */
    const cands = (await until(async () => {
      const list = await page.evaluate(() => window.__annCandidates());
      return list && list.length ? list : null;
    }, 3000)) || [];
    const cx = (BTN.x1 + BTN.x2) / 2, cy = (BTN.y1 + BTN.y2) / 2;
    const near = (a, b) => Math.abs(a - b) <= 12;
    const B = cands.find((c) => c.x1 <= cx && cx < c.x2 && c.y1 <= cy && cy < c.y2
      && near(c.x1, BTN.x1) && near(c.y1, BTN.y1) && near(c.x2, BTN.x2) && near(c.y2, BTN.y2));
    check("S2a 候选里有小按钮框(边界误差 ≤12px)", !!B, B ? JSON.stringify(B) : ("候选 " + cands.length + " 个,无匹配"));
    const A = B ? cands.find((c) => c.x1 <= B.x1 - 20 && c.x2 >= B.x2 + 20 && c.y1 <= B.y1 - 20 && c.y2 >= B.y2 + 20) : null;
    check("S2b 同一点上外层大框也在候选里(嵌套不吞)", !!A, A ? JSON.stringify(A) : "找不到包住 B 的外框");

 /* ---------- S3 悬停提示 ---------- */
    const box = await page.evaluate(() => {
      const r = document.getElementById("annCanvas").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const sx = box.width / IMG_W, sy = box.height / IMG_H;
    await page.mouse.move(box.left + cx * sx, box.top + cy * sy, { steps: 6 });
    const hoverOk = await until(async () => {
      const s = await page.evaluate(() => window.__annTestState());
      return s && s.hover === true ? s : null;
    }, 3000);
    check("S3a 悬停命中候选(hover===true)", !!hoverOk, hoverOk ? ("candidates=" + hoverOk.candidates) : "3s 内 hover 未置位");
    const hint = await page.evaluate(() => (document.getElementById("annHint") || {}).textContent || "");
    check("S3b #annHint 显示候选文案", hint.indexOf("候选") >= 0, JSON.stringify(hint.slice(0, 60)));

 /* ---------- S4 录屏合成链 ---------- */
    await page.click("#annScreenRecBtn");
    const overlayOn = await until(async () => page.evaluate(() => {
      const el = document.getElementById("annvOverlay");
      return el && getComputedStyle(el).display !== "none";
    }), 5000);
    check("S4a 点「● 录屏批注」后 #annvOverlay 可见", !!overlayOn, overlayOn ? "" : "5s 内未显示");

    const vcv = await page.evaluate(() => {
      const r = document.getElementById("annvCanvas").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const px = (dx) => vcv.left + Math.max(20, Math.min(vcv.width - 20, dx));
    const py = (dy) => vcv.top + Math.max(20, Math.min(vcv.height - 20, dy));
    await page.mouse.move(px(60), py(60));
    await page.mouse.down();
    await page.mouse.move(px(160), py(120), { steps: 3 });
    await page.mouse.move(px(240), py(160), { steps: 3 });
    await page.mouse.move(px(300), py(200), { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(1100); // 让 MediaRecorder 收到 ≥1s 数据
    await page.click("#annvStop");
    const rec = await until(async () => {
      const r = await page.evaluate(() => window.__annTestRecord());
      return r && r.recording === false && r.bytes > 0 ? r : null;
    }, 8000);
    check("S4b 停止后录制态收敛(recording=false 且 bytes>0)", !!rec, rec ? ("bytes=" + rec.bytes) : "8s 内未收敛");
    check("S4c webm 体积 >1000 字节", !!(rec && rec.bytes > 1000), rec ? ("bytes=" + rec.bytes) : "无记录态");
    check("S4d 笔迹 strokes≥1", !!(rec && rec.strokes >= 1), rec ? ("strokes=" + rec.strokes) : "无记录态");
    check("S4e 关键帧 keyframes≥1", !!(rec && rec.keyframes >= 1), rec ? ("keyframes=" + rec.keyframes) : "无记录态");
    check("S4f 回放 URL 是 blob:", !!(rec && String(rec.preview).indexOf("blob:") === 0), rec ? String(rec.preview).slice(0, 24) : "无记录态");
    const pvVisible = await page.evaluate(() => {
      const el = document.getElementById("annVidPreview");
      return !!el && getComputedStyle(el).display !== "none";
    });
    check("S4g #annVidPreview 可见", pvVisible, pvVisible ? "" : "仍是 display:none");

    await page.click("#annSend");
    const sent = await until(async () => {
      const s = await page.evaluate(() => (window.__sent || []).slice());
      return s && s.length ? s : null;
    }, 10000);
    check("S4h 点发送后 wsSafeSend 收到载荷", !!(sent && sent.length), sent ? ("条数=" + sent.length) : "10s 内无上行");
    let payload = null;
    try { payload = sent && sent.length ? JSON.parse(sent[sent.length - 1]) : null; } catch { payload = null; }
    check("S4i type===annotate.record", !!payload && payload.type === "annotate.record", payload ? String(payload.type) : "载荷解析失败");
    check("S4j videoUrl 是 data:video/webm", !!payload && String(payload.videoUrl || "").indexOf("data:video/webm") === 0, payload ? String(payload.videoUrl || "").slice(0, 30) : "无载荷");
    check("S4k durationMs>0", !!payload && Number(payload.durationMs) > 0, payload ? ("durationMs=" + payload.durationMs) : "无载荷");
    check("S4l strokes 数组长度≥1", !!payload && Array.isArray(payload.strokes) && payload.strokes.length >= 1, payload && Array.isArray(payload.strokes) ? ("len=" + payload.strokes.length) : "无 strokes");
 // 静态页没有网关回执:手动投一条成功回执,让编辑器解锁并关闭(否则 sending 锁会挡后续用例)
    await page.evaluate(() => { if (window.__annRecordResult) window.__annRecordResult({ ok: true, refined: false }); });
    await page.waitForTimeout(200);
    const closedAfterSend = await page.evaluate(() => !window.__annTestState());
    check("S4m 回执 ok 后编辑器关闭", closedAfterSend, closedAfterSend ? "" : "编辑器仍打开");

 /* ---------- S6–S9 缩放/选框保真(整图可见 / 光标锚定 / 缩放后选框仍准) ---------- */
    const IMG2 = { w: 3000, h: 1800 }, BTN2 = { x1: 1500, y1: 900, x2: 1740, y2: 1020 };
    await page.evaluate(([w, h, b]) => {
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const g = cv.getContext("2d");
      g.fillStyle = "#1b1b1b"; g.fillRect(0, 0, w, h);
      g.fillStyle = "#f4f4f4"; g.fillRect(900, 400, 1400, 1000);
      g.fillStyle = "#c98f45"; g.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      window.__annTestOpen(cv.toDataURL("image/png"), { source: "screen" });
    }, [IMG2.w, IMG2.h, BTN2]);
    await page.waitForTimeout(500);
    const viewOf = () => page.evaluate(() => window.__annView());
    const fullyInside = (v) => !!v && v.stage.l >= -1 && v.stage.t >= -1 && v.stage.l + v.stage.w <= v.vp.w + 1 && v.stage.t + v.stage.h <= v.vp.h + 1;
    const toCss = (v, x, y) => ({ x: v.vp.l + v.stage.l + (x / v.img.w) * v.stage.w, y: v.vp.t + v.stage.t + (y / v.img.h) * v.stage.h });
    const toImg = (v, cx, cy) => ({ x: ((cx - v.vp.l - v.stage.l) / v.stage.w) * v.img.w, y: ((cy - v.vp.t - v.stage.t) / v.stage.h) * v.img.h });
    const v6 = await viewOf();
    check("S6a 大图(3000×1800)适应后整图完整可见(不裁边)", fullyInside(v6),
      v6 ? ("stage=" + Math.round(v6.stage.w) + "×" + Math.round(v6.stage.h) + " vp=" + Math.round(v6.vp.w) + "×" + Math.round(v6.vp.h) + " zoom=" + v6.zoom.toFixed(3)) : "无视图");
    check("S6b 适应后 zoom<1(大图自适应而非 1:1)", !!v6 && v6.zoom < 1, v6 ? ("zoom=" + v6.zoom.toFixed(3)) : "无视图");

    const anchorImg = { x: 1200, y: 800 };
    const p0 = v6 ? toCss(v6, anchorImg.x, anchorImg.y) : { x: 10, y: 10 };
    await page.mouse.move(p0.x, p0.y);
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -320);
    await page.waitForTimeout(260);
    const v7 = await viewOf();
    const back = v7 ? toImg(v7, p0.x, p0.y) : anchorImg;
    const drift = Math.hypot(back.x - anchorImg.x, back.y - anchorImg.y);
    check("S7 滚轮缩放以光标为锚(同点图像坐标漂移 ≤3px)", !!v7 && !!v6 && v7.zoom > v6.zoom && drift <= 3,
      v7 && v6 ? ("zoom " + v6.zoom.toFixed(3) + "→" + v7.zoom.toFixed(3) + " drift=" + drift.toFixed(2) + "px") : "无视图");

    await page.click("#annFitBtn");
    await page.waitForTimeout(200);
    for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 320); await page.waitForTimeout(50); }
    await page.waitForTimeout(220);
    const v8 = await viewOf();
    check("S8 连续缩小到底后整图仍完整可见", fullyInside(v8),
      v8 ? ("zoom=" + v8.zoom.toFixed(3) + " stage=" + Math.round(v8.stage.w) + "×" + Math.round(v8.stage.h) + " vp=" + Math.round(v8.vp.w) + "×" + Math.round(v8.vp.h)) : "无视图");

    await page.click("#annFitBtn");
    await page.waitForTimeout(150);
    const btnCenterImg = { x: (BTN2.x1 + BTN2.x2) / 2, y: (BTN2.y1 + BTN2.y2) / 2 };
    const vPre = await viewOf();
    if (vPre) {
      const pb = toCss(vPre, btnCenterImg.x, btnCenterImg.y);
      await page.mouse.move(pb.x, pb.y);
      await page.waitForTimeout(150);
      await page.mouse.click(pb.x, pb.y);
      await page.waitForTimeout(300);
    }
    const notes9 = await page.evaluate(() => window.__annNotes());
    const n0 = (notes9 || []).find((n) => n.kind === "region");
    const near12 = (a, b) => Math.abs(a - b) <= 12;
    const ok9 = !!n0 && !!n0.source && near12(n0.source.x1, BTN2.x1) && near12(n0.source.y1, BTN2.y1) && near12(n0.source.x2, BTN2.x2) && near12(n0.source.y2, BTN2.y2);
    check("S9 适应态点击选框落点正确(与图像坐标误差 ≤12px)", ok9, n0 && n0.source ? JSON.stringify(n0.source) : ("notes=" + JSON.stringify(notes9)));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);

 /* ---------- S10–S12:深缩放细选 / 换候选 / 录屏暂停(独立页面,干净 ann 状态) ---------- */
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page2.on("pageerror", (e) => pageErrors.push(String(e && e.message || e)));
    await page2.addInitScript(initWithFakeMedia);
    await page2.goto(base, { waitUntil: "load" });
    await page2.waitForTimeout(150);
    const LBL = { x1: 1500, y1: 900, x2: 1526, y2: 905 }; // 26×5 小标签:fit 采样后只剩 ~3.7px 高,过不了 6px 尺寸闸
    await page2.evaluate((b) => {
      const cv = document.createElement("canvas"); cv.width = 3000; cv.height = 1800;
      const g = cv.getContext("2d");
      g.fillStyle = "#1b1b1b"; g.fillRect(0, 0, 3000, 1800);
      g.fillStyle = "#f4f4f4"; g.fillRect(900, 400, 1400, 1000);
      g.fillStyle = "#c94f45"; g.fillRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      window.__annTestOpen(cv.toDataURL("image/png"), { source: "screen" });
    }, LBL);
    await page2.waitForTimeout(600);
    const v20 = await page2.evaluate(() => window.__annView());
    const lblCenter = { x: (LBL.x1 + LBL.x2) / 2, y: (LBL.y1 + LBL.y2) / 2 };
    const nearLbl = (c) => Math.abs((c.x1 + c.x2) / 2 - lblCenter.x) <= 16 && Math.abs((c.y1 + c.y2) / 2 - lblCenter.y) <= 10 && (c.y2 - c.y1) <= 12;
    const cands0 = await page2.evaluate(() => window.__annCandidates());
    check("S10a fit(zoom<1)时不触发细检(无 fine 候选)", !cands0.some((c) => c.fine), "zoom=" + (v20 ? v20.zoom.toFixed(3) : "?") + " 候选=" + cands0.length + " fine=" + cands0.filter((c) => c.fine).length);
    const inBounds = cands0.every((c) => c.x1 >= 0 && c.y1 >= 0 && c.x2 <= 3000 && c.y2 <= 1800 && c.x2 > c.x1 && c.y2 > c.y1);
    check("S10b 候选坐标全部落在图像内(无越界/零宽)", inBounds, "候选=" + cands0.length);
    for (let i = 0; i < 8; i++) { await page2.keyboard.press("="); await page2.waitForTimeout(60); }
    await page2.waitForTimeout(650); // 220ms 防抖 + 检测
    const v21 = await page2.evaluate(() => window.__annView());
    const cands1 = await page2.evaluate(() => window.__annCandidates());
    const fineHit = cands1.filter((c) => c.fine && nearLbl(c));
    check("S10c 放大后(zoom≥1.5)细检产出小标签候选", fineHit.length >= 1,
      "zoom=" + (v21 ? v21.zoom.toFixed(3) : "?") + " fine=" + cands1.filter((c) => c.fine).length + " hit=" + (fineHit[0] ? JSON.stringify(fineHit[0]) : "无"));

    const toCss2 = (v, x, y) => ({ x: v.vp.l + v.stage.l + (x / v.img.w) * v.stage.w, y: v.vp.t + v.stage.t + (y / v.img.h) * v.stage.h });
    const pc = v21 ? toCss2(v21, lblCenter.x, lblCenter.y) : { x: 400, y: 300 };
    await page2.mouse.move(pc.x, pc.y);
    await page2.waitForTimeout(200);
    const sA = await page2.evaluate(() => window.__annTestState());
    check("S11a 悬停小标签命中且候选数≥2", !!sA && sA.hover && sA.hoverChoices >= 2, sA ? ("pos=" + sA.hoverPos + "/" + sA.hoverChoices + " fine=" + sA.fine) : "无状态");
    await page2.keyboard.press("Tab");
    await page2.waitForTimeout(140);
    const sB = await page2.evaluate(() => window.__annTestState());
    check("S11b Tab 换到更大一级候选", !!sB && sB.hoverPos === 2, sB ? ("pos=" + sB.hoverPos + "/" + sB.hoverChoices) : "无状态");
    await page2.keyboard.down("Shift"); await page2.keyboard.press("Tab"); await page2.keyboard.up("Shift");
    await page2.waitForTimeout(140);
    const sC = await page2.evaluate(() => window.__annTestState());
    check("S11c Shift+Tab 回到最小块", !!sC && sC.hoverPos === 1, sC ? ("pos=" + sC.hoverPos) : "无状态");
    const vBef = await page2.evaluate(() => window.__annView());
    await page2.mouse.move(pc.x, pc.y);
    await page2.keyboard.down("Shift");
    await page2.mouse.wheel(0, 200);
    await page2.keyboard.up("Shift");
    await page2.waitForTimeout(180);
    const vAft = await page2.evaluate(() => window.__annView());
    const sD = await page2.evaluate(() => window.__annTestState());
    check("S11d Shift+滚轮换候选且不动缩放", !!sD && !!vBef && !!vAft && sD.hoverPos === 2 && Math.abs(vAft.zoom - vBef.zoom) < 1e-6,
      (sD ? ("pos=" + sD.hoverPos) : "无状态") + " zoom " + (vBef ? vBef.zoom.toFixed(3) : "?") + "→" + (vAft ? vAft.zoom.toFixed(3) : "?"));

    await page2.click("#annScreenRecBtn");
    const ov2 = await until(async () => page2.evaluate(() => { const el = document.getElementById("annvOverlay"); return !!el && getComputedStyle(el).display !== "none"; }), 5000);
    check("S12a 录屏启动(覆盖层可见)", !!ov2, ov2 ? "" : "5s 内未显示");
    const vcv2 = await page2.evaluate(() => { const r = document.getElementById("annvCanvas").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const cx2 = vcv2.left + vcv2.width / 2, cy2 = vcv2.top + vcv2.height / 2;
    await page2.mouse.move(cx2 - 60, cy2 - 40); await page2.mouse.down();
    await page2.mouse.move(cx2 + 60, cy2 + 40, { steps: 3 }); await page2.mouse.up();
    await page2.waitForTimeout(600);
    await page2.click("#annvPause");
    await page2.waitForTimeout(250);
    const recP = await page2.evaluate(() => window.__annTestRecord());
    check("S12b 暂停后 mr.state=paused 且 paused 为真", !!recP && recP.state === "paused" && recP.paused === true, recP ? ("state=" + recP.state + " paused=" + recP.paused) : "无记录态");
    const durA = recP ? recP.dur : 0;
    await page2.waitForTimeout(700);
    const recP2 = await page2.evaluate(() => window.__annTestRecord());
    check("S12c 暂停期计时冻结", !!recP2 && Math.abs(recP2.dur - durA) <= 60, recP2 ? ("dur " + durA + "→" + recP2.dur + "ms") : "无记录态");
    const strokesBefore = recP2 ? recP2.strokes : -1;
    await page2.mouse.move(cx2 - 40, cy2 + 10); await page2.mouse.down();
    await page2.mouse.move(cx2 + 40, cy2 - 10, { steps: 3 }); await page2.mouse.up();
    await page2.waitForTimeout(200);
    const recP3 = await page2.evaluate(() => window.__annTestRecord());
    check("S12d 暂停期笔迹不落账(时间轴不错位)", !!recP3 && recP3.strokes === strokesBefore, recP3 ? (strokesBefore + "→" + recP3.strokes) : "无记录态");
    await page2.click("#annvPause");
    await page2.waitForTimeout(500);
    const recR = await page2.evaluate(() => window.__annTestRecord());
    check("S12e 继续后恢复录制且计时继续增长", !!recR && recR.state === "recording" && recR.dur > (recP2 ? recP2.dur : 0), recR ? ("state=" + recR.state + " dur=" + recR.dur) : "无记录态");
    await page2.click("#annvStop");
    const recF = await until(async () => { const r = await page2.evaluate(() => window.__annTestRecord()); return r && r.recording === false && r.bytes > 0 ? r : null; }, 8000);
    check("S12f 暂停/继续后停止仍产出 webm", !!recF, recF ? ("bytes=" + recF.bytes) : "8s 内未收敛");
    await page2.close();

 /* ---------- S5 无 pageerror ---------- */
    check("S5 全程 0 pageerror", pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(" | ") : "0 条");
  } finally {
    try { await browser && browser.close(); } catch { /* 已关 */ }
    try { server.close(); } catch { /* 已关 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n汇总:" + (results.length - failed.length) + "/" + results.length + " PASS");
  if (failed.length) {
    console.log("失败项:" + failed.map((r) => r.name).join(", "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("spec 崩溃:" + (e && e.stack || e));
  process.exit(1);
});
