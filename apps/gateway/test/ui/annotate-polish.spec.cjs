/* 截图标注三连打磨 E2E(2026-11):临时端口本地实例,不碰 7700。
 * 覆盖:①取屏画框坐标(原生像素换算,DPR=2 + contain 取景)②标注编辑器框选坐标
 * ③录音评论(假 MediaRecorder)④提交 → 盘上四件套(png/preview/feedback/webm)
 * ⑤任务书经小模型整理(假 OpenAI 兼容端点)含五小节 + 语音转写 ⑥journal 事件 ⑦0 pageerror。
 *
 * 跑法:cd apps/gateway && node test/ui/annotate-polish.spec.cjs
 * 依赖:playwright-core + /usr/bin/google-chrome(缺失 → SKIP,退出码 0)。
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPO = path.resolve(__dirname, "../../../..");
const CHROME = "/usr/bin/google-chrome";
const KEY_ENV = "GENIE_TEST_KEY";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const REFINE_TEXT = [
  "## 用户意图",
  "把截图里标出的区域颜色改掉。",
  "",
  "## 问题清单",
  "1. 现象:颜色不对;图上位置:框选区域;用户原话:「颜色不对」",
  "2. 现象:按钮太小;图上位置:左上角;用户原话:「左上角的按钮太小了」",
  "",
  "## 期望结果",
  "界面上该区域颜色与按钮尺寸符合预期。",
  "",
  "## 优先级建议",
  "P1",
  "",
  "## 验收标准",
  "重新截图后该区域颜色正确、按钮可读。",
].join("\n");

const VOICE_TEXT = JSON.stringify({ segments: [
  { at: "0-3s", text: "左上角的按钮太小了" },
  { at: "3-6s", text: "第三个框的颜色要换成蓝色" },
] });

function startFakeLlm(port) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const isAudio = /"input_audio"/.test(body);
      const content = isAudio ? VOICE_TEXT : REFINE_TEXT;
      const payload = {
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function waitHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); resolve(true); })
        .on("error", () => {
          if (Date.now() > deadline) reject(new Error("实例未就绪(超时)")); else setTimeout(tick, 500);
        });
    };
    tick();
  });
}

function readJournalEvents(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try { out.push(...fs.readFileSync(p, "utf8").split("\n").filter(Boolean)); } catch { /* 跳过不可读分片 */ }
      }
    }
  };
  walk(dir);
  return out;
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }

(async () => {
  if (!fs.existsSync(CHROME)) { console.log("SKIP 无 chrome(" + CHROME + ")"); process.exit(0); }
  const dist = path.join(REPO, "apps/gateway/dist/gateway.mjs");
  if (!fs.existsSync(dist)) { console.log("SKIP 缺少 " + dist + "(先跑 apps/gateway 的 build)"); process.exit(0); }

  const PORT = await freePort();
  const FAKE = await freePort();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "genie-ann-e2e-"));
  fs.mkdirSync(path.join(TMP, ".genie"), { recursive: true });
  const journalDir = path.join(TMP, ".genie", "journal");
  const cfg = JSON.stringify({
    coding: {
      llm: { model: "fake-main", baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKeyEnv: KEY_ENV },
      models: { compact: { model: "fake-compact", baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKeyEnv: KEY_ENV } },
    },
    annotate: { refine: true, voiceParse: { baseUrl: `http://127.0.0.1:${FAKE}/v1`, model: "qwen3.8-omni-flash", apiKeyEnv: KEY_ENV } },
  }, null, 2);
  // 实例实际读的是 <repoRoot>/genie.config.json(启动日志「config: …/genie.config.json」),
  // 同时写 .genie/config.json 以覆盖两种布局。
  fs.writeFileSync(path.join(TMP, "genie.config.json"), cfg);
  fs.writeFileSync(path.join(TMP, ".genie", "config.json"), cfg);

  const fakeLlm = await startFakeLlm(FAKE);
  const child = spawn(process.execPath, [dist], {
    cwd: REPO,
    env: {
      ...process.env,
      GENIE_REPO_ROOT: TMP,
      GENIE_GATEWAY_PORT: String(PORT),
      GENIE_JOURNAL_DIR: journalDir,
      GENIE_TEAM_RELAY: "off",
      GENIE_WATCHDOG_AUTOARM: "0",
      GENIE_SESSION_WORKER: "off",
      [KEY_ENV]: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childLog = "";
  child.stdout.on("data", (d) => { childLog += d; });
  child.stderr.on("data", (d) => { childLog += d; });

  let browser;
  const cleanup = () => {
    try { browser && browser.close(); } catch { /* 已关 */ }
    try { child.kill("SIGKILL"); } catch { /* 已退 */ }
    try { fakeLlm.close(); } catch { /* 已关 */ }
    rmrf(TMP);
  };

  try {
    await waitHttp(PORT, 90000);
    const BASE = `http://127.0.0.1:${PORT}/`;
    const { chromium } = require(path.join(REPO, "apps/gateway/node_modules/playwright-core"));
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    // deviceScaleFactor=2:位图(device px)与 CSS 盒(css px)两套坐标系并存,正是坐标偏移的现场。
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

    await page.addInitScript(() => {
      // 合成屏幕流:原生 2000×1000,色块在原生 (1200,300)-(1500,500)
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement("canvas"); c.width = 2000; c.height = 1000;
        const g = c.getContext("2d");
        g.fillStyle = "#111111"; g.fillRect(0, 0, 2000, 1000);
        g.fillStyle = "#ff00ff"; g.fillRect(1200, 300, 300, 200);
        return c.captureStream(5);
      };
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      class FakeRecorder {
        constructor(_stream, opts) { this.mimeType = (opts && opts.mimeType) || "audio/webm;codecs=opus"; this.state = "inactive"; }
        static isTypeSupported() { return true; }
        start() { this.state = "recording"; }
        stop() {
          if (this.state !== "recording") return;
          this.state = "inactive";
          const blob = new Blob([new Uint8Array(2048)], { type: this.mimeType });
          setTimeout(() => { if (this.ondataavailable) this.ondataavailable({ data: blob }); if (this.onstop) this.onstop(); }, 0);
        }
        addEventListener() {}
        removeEventListener() {}
      }
      window.MediaRecorder = FakeRecorder;
      // 记录真实指针事件与换算层调用(用于诊断拖框落点是否被页面正确换算)
      window.__pt = [];
      window.__cti = [];
      let _C = null;
      Object.defineProperty(window, "GenieAnnotateCoords", {
        configurable: true,
        get() { return _C; },
        set(v) {
          if (v && !v.__wrapped) {
            const orig = v.clientToImage;
            v.clientToImage = function (pt, box) {
              const out = orig.call(this, pt, box);
              if (window.__cti.length < 20) window.__cti.push({ pt: [Math.round(pt.x), Math.round(pt.y)], box: {
                left: box.left, top: box.top, width: Math.round(box.width), height: Math.round(box.height),
                lw: box.layoutWidth, lh: box.layoutHeight, ox: box.offsetX, oy: box.offsetY, scale: box.scale, iw: box.imgWidth, ih: box.imgHeight }, out: [Math.round(out.x), Math.round(out.y)] });
              return out;
            };
            v.__wrapped = true;
          }
          _C = v;
        },
      });
      for (const t of ["pointerdown", "pointermove", "pointerup"]) {
        window.addEventListener(t, (e) => { if (window.__pt.length < 200) window.__pt.push([t, Math.round(e.clientX), Math.round(e.clientY)]); }, true);
      }
    });

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

    // ---- ① 取屏画框:按原生坐标算显示位置拖框 ----
    await page.click("#shotBtn");
    await page.waitForFunction(() => {
      const o = document.getElementById("capOverlay");
      return o && getComputedStyle(o).display !== "none";
    }, { timeout: 20000 });
    await page.waitForTimeout(500);

    const geo = await page.evaluate(() => {
      const c = document.getElementById("capCanvas");
      const r = c.getBoundingClientRect();
      const C = window.GenieAnnotateCoords;
      const vw = Math.max(320, window.innerWidth), vh = Math.max(240, window.innerHeight);
      // 浏览器路径(fullscreen=false)= contain 且不放大:scale=min(vw/iw, vh/ih, 1)
      const scale = C ? C.fitScale(2000, 1000, vw, vh, { cap1: true }) : Math.min(vw / 2000, vh / 1000, 1);
      const ox = (vw - 2000 * scale) / 2, oy = (vh - 1000 * scale) / 2;
      // 原生 → 显示:先到布局 CSS px(ox + x*scale),再按 rect/layout 比例
      const kx = r.width / vw, ky = r.height / vh;
      const disp = (x, y) => ({ x: r.left + (ox + x * scale) * kx, y: r.top + (oy + y * scale) * ky });
      return { hasCoords: !!C, rect: { l: r.left, t: r.top, w: r.width, h: r.height }, scale, ox, oy, kx, ky,
        a: disp(1100, 200), b: disp(1600, 600), blockA: disp(1200, 300), blockB: disp(1500, 500) };
    });
    check("① 坐标换算层已加载(window.GenieAnnotateCoords)", geo.hasCoords === true, JSON.stringify({ scale: geo.scale.toFixed(3), kx: geo.kx.toFixed(3), rect: geo.rect }));

    await page.evaluate(() => { window.__pt = []; });
    await page.mouse.move(geo.a.x, geo.a.y);
    await page.mouse.down();
    await page.mouse.move(geo.b.x, geo.b.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    // 页面自己算出的选区(图像原生像素口径)——用于区分「页面算错」与「测试期望算错」
    const diag = await page.evaluate(() => {
      const size = (document.getElementById("capSize") || {}).textContent || "";
      const sel = document.getElementById("capSel");
      const sr = sel ? sel.getBoundingClientRect() : null;
      const c = document.getElementById("capCanvas");
      const cr = c.getBoundingClientRect();
      return { size, selRect: sr ? { l: Math.round(sr.left), t: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
        canvas: { l: cr.left, t: cr.top, w: cr.width, h: cr.height }, cw: c.clientWidth, ch: c.clientHeight,
        events: window.__pt || [] };
    });
    console.log("  [诊断] 角标=" + diag.size + " canvas=" + JSON.stringify(diag.canvas) + " client=" + diag.cw + "x" + diag.ch);
    console.log("  [诊断] 期望 a=(" + geo.a.x.toFixed(0) + "," + geo.a.y.toFixed(0) + ") b=(" + geo.b.x.toFixed(0) + "," + geo.b.y.toFixed(0) + ") scale=" + geo.scale.toFixed(3) + " ox=" + geo.ox.toFixed(0) + " oy=" + geo.oy.toFixed(0));
    console.log("  [诊断] 页面收到的指针事件(" + diag.events.length + "):" + JSON.stringify(diag.events.slice(0, 3)));
    const cti = await page.evaluate(() => window.__cti || []);
    console.log("  [诊断] 换算调用(" + cti.length + "):" + JSON.stringify(cti.slice(0, 3)));
    await page.click("#capOk");
    await page.waitForFunction(() => {
      const e = document.getElementById("annEditor");
      return e && getComputedStyle(e).display !== "none";
    }, { timeout: 20000 });
    await page.waitForTimeout(600);

    const meta = await page.evaluate(() => document.getElementById("annMeta").textContent || "");
    const m = /(\d+)\s*×\s*(\d+)/.exec(meta);
    const cropW = m ? Number(m[1]) : 0, cropH = m ? Number(m[2]) : 0;
    // 原生 1100,200 → 1600,600 = 500×400;若坐标层失效(用显示 px 当原生)会得到约 350×280 量级
    check("① 裁切窗口像素=原生像素(500×400)", Math.abs(cropW - 500) <= 6 && Math.abs(cropH - 400) <= 6,
      `实测 ${cropW}×${cropH}(期望 500×400 ±6,显示 px 口径会显著偏小)`);

    // ---- ② 编辑器框选:色块在裁切图内的相对位置(100,100)-(400,300) ----
    const ed = await page.evaluate(({ cw, ch }) => {
      const stage = document.getElementById("annStage");
      const r = stage.getBoundingClientRect();
      const kx = r.width / cw, ky = r.height / ch;
      const disp = (x, y) => ({ x: r.left + x * kx, y: r.top + y * ky });
      return { a: disp(110, 110), b: disp(390, 290) };
    }, { cw: cropW, ch: cropH });
    await page.click('.ann-tool[data-amode="rect"]');
    await page.mouse.move(ed.a.x, ed.a.y);
    await page.mouse.down();
    await page.mouse.move(ed.b.x, ed.b.y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const inline = await page.$("#annInlineText");
    if (inline) { await inline.fill("颜色不对"); await page.click("#annInlineOk"); }
    else { console.log("FAIL ② 框选后未出现内联批注框"); }
    await page.waitForTimeout(300);

    // ---- ③ 录音评论(假 MediaRecorder) ----
    await page.click("#annRecBtn");
    await page.waitForTimeout(700);
    const recState = await page.evaluate(() => (document.getElementById("annRecState") || {}).textContent || "");
    await page.click("#annRecBtn");
    await page.waitForTimeout(600);
    const audioSrc = await page.evaluate(() => (document.getElementById("annRecAudio") || {}).src || "");
    check("③ 录音:计时/停止/可试听", audioSrc.startsWith("blob:"), `recState=${recState.trim()} audio=${audioSrc.slice(0, 24)}`);

    // ---- ④ 提交 ----
    await page.click("#annSend");
    await page.waitForTimeout(1200);
    const toastText = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll(".toast, #toast, .toast-box, [class*=toast]"));
      return els.map((e) => e.textContent || "").join(" | ").slice(0, 300);
    });
    const fbDir = path.join(TMP, ".genie", "feedback");
    let files = [];
    for (let i = 0; i < 30; i++) {
      try { files = fs.readdirSync(fbDir); } catch { files = []; }
      if (files.some((f) => f.endsWith(".webm"))) break;
      await page.waitForTimeout(500);
    }
    const stem = (files.find((f) => f.endsWith(".feedback.json")) || "").replace(/\.feedback\.json$/, "");
    const has4 = !!stem
      && files.includes(stem + ".png")
      && files.includes(stem + ".annotated.jpg")
      && files.includes(stem + ".webm");
    check("④ 盘上四件套(png/preview/feedback/webm)", has4, files.slice(0, 8).join(","));
    const webmSize = stem && files.includes(stem + ".webm") ? fs.statSync(path.join(fbDir, stem + ".webm")).size : 0;
    check("④ 录音文件非空", webmSize > 0, "webm=" + webmSize + "B");

    // ---- ⑤ 坐标断言:反馈 JSON 的 region 落在裁切图内色块区(100,100)-(400,300) ±25 ----
    let regionOk = false, regionDetail = "无 feedback.json";
    if (stem) {
      const fb = JSON.parse(fs.readFileSync(path.join(fbDir, stem + ".feedback.json"), "utf8"));
      const obj = (fb.objects || []).find((o) => o.kind === "region");
      if (obj && obj.source) {
        const s = obj.source;
        regionOk = s.x1 >= 75 && s.y1 >= 75 && s.x2 <= 425 && s.y2 <= 325 && s.x2 > s.x1 && s.y2 > s.y1;
        regionDetail = JSON.stringify(s) + " 期望落在 {100,100,400,300} ±25;image=" + fb.image.width + "x" + fb.image.height;
      } else regionDetail = "无 region 批注:" + JSON.stringify((fb.objects || []).map((o) => o.kind));
    }
    check("⑤ 反馈 JSON 坐标=图像像素且命中色块", regionOk, regionDetail);

    // ---- ⑥ 任务书:小模型整理(五小节)+ 语音转写 ----
    const jLines = readJournalEvents(journalDir);
    const hasVoiceEv = jLines.some((l) => l.includes("annotate.voice"));
    const hasRefineEv = jLines.some((l) => l.includes("annotate.refine"));
    check("⑥ journal 有 annotate.voice/annotate.refine", hasVoiceEv && hasRefineEv, `voice=${hasVoiceEv} refine=${hasRefineEv} lines=${jLines.length}`);
    const instructionLine = jLines.find((l) => l.includes("## 问题清单"));
    const instructionOk = !!instructionLine
      && instructionLine.includes("左上角的按钮太小了")
      && instructionLine.includes("颜色不对");
    check("⑥ 任务书含整理结构与语音转写", instructionOk, instructionLine ? instructionLine.slice(0, 180) : "journal 无「## 问题清单」");
    check("⑥ 回执提示已整理", /已 LLM 整理|已整理/.test(toastText), toastText || "(无 toast 文本)");
    check("⑦ 0 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

    const fail = results.filter((r) => !r.ok).length;
    console.log("\nPASS " + (results.length - fail) + "/" + results.length + (fail ? "  FAIL " + fail : ""));
    if (fail) console.log("实例日志尾:\n" + childLog.slice(-1500));
    cleanup();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.log("FAIL 异常:" + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
    console.log("实例日志尾:\n" + childLog.slice(-1500));
    cleanup();
    process.exit(1);
  }
})();
