/* 截图标注视口/缩放/坐标 E2E(2026-11):临时端口本地实例,不碰 7700,不依赖 LLM(不提交)。
 * 覆盖(任务书验收 1-4):
 * A fit 完整:大图(3000×1800)适应后 stage 完全落在视口内(不裁边)
 * B fit 居中:左右留白差/上下留白差 ≤2px
 * C 按钮放大 ×5 逐步保持居中(每步中心差 ≤2.5px)
 * D 缩小到下限(0.02):label ≤3%,stage 完整可见且居中(治「缩小不了」)
 * E 8× 放大下 10 CSS px 小拖框成功建卡(旧阈值 3 图像像素会吞掉;治「小框失效」)
 * F 缩小(~6%)→空格平移→框选:卡片坐标换算回 CSS 与鼠标拖拽区重合 ±4px(治「移动后失效」)
 * G overlay <rect> getBoundingClientRect 与拖拽区重合 ±4px(viewBox 修复的视觉证据)
 * H 第二轮 反向平移+框选:两卡共存,坐标仍准(连续操作稳定)
 * I 0 pageerror
 * 跑法:cd apps/gateway && node test/ui/annotate-viewport.spec.cjs
 * 依赖:playwright-core + /usr/bin/google-chrome(缺失 → SKIP,退出码 0)+ dist/gateway.mjs(先 build)。
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REPO = path.resolve(__dirname, "../../../..");
const CHROME = "/usr/bin/google-chrome";

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

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }

/** 读视口/舞台几何 + 图片尺寸(annMeta 文本)。 */
async function geo(page) {
  return page.evaluate(() => {
    const vp = document.getElementById("annViewport").getBoundingClientRect();
    const st = document.getElementById("annStage").getBoundingClientRect();
    const m = /(\d+)\s*×\s*(\d+)/.exec(document.getElementById("annMeta").textContent || "");
    return {
      vp: { l: vp.left, t: vp.top, r: vp.right, b: vp.bottom, w: vp.width, h: vp.height },
      st: { l: st.left, t: st.top, r: st.right, b: st.bottom, w: st.width, h: st.height },
      imgW: m ? Number(m[1]) : 0, imgH: m ? Number(m[2]) : 0,
      zoomLabel: document.getElementById("annZoomLabel").textContent || "",
      cards: Array.from(document.querySelectorAll("#annCards .ann-card-pos")).map((e) => e.textContent || ""),
    };
  });
}

/** 在图像 fraction (fx,fy) 处拖出 wCss×hCss 的框。返回鼠标起止 client 坐标。 */
async function dragInImage(page, fx, fy, wCss, hCss) {
  const g = await geo(page);
  const sx = g.st.l + g.st.w * fx, sy = g.st.t + g.st.h * fy;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + wCss, sy + hCss, { steps: 8 });
  await page.mouse.up();
  return { sx, sy, ex: sx + wCss, ey: sy + hCss, g };
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.log("SKIP 无 chrome(" + CHROME + ")"); process.exit(0); }
  const dist = path.join(REPO, "apps/gateway/dist/gateway.mjs");
  if (!fs.existsSync(dist)) { console.log("SKIP 缺少 " + dist + "(先跑 apps/gateway 的 build)"); process.exit(0); }

  const PORT = await freePort();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "genie-ann-vp-"));
  fs.mkdirSync(path.join(TMP, ".genie"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "genie.config.json"), "{}");
  fs.writeFileSync(path.join(TMP, ".genie", "config.json"), "{}");

  const child = spawn(process.execPath, [dist], {
    cwd: REPO,
    env: {
      ...process.env,
      GENIE_REPO_ROOT: TMP,
      GENIE_GATEWAY_PORT: String(PORT),
      GENIE_JOURNAL_DIR: path.join(TMP, ".genie", "journal"),
      GENIE_TEAM_RELAY: "off",
      GENIE_WATCHDOG_AUTOARM: "0",
      GENIE_SESSION_WORKER: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childLog = "";
  child.stdout.on("data", (d) => { childLog += d; });
  child.stderr.on("data", (d) => { childLog += d; });

  let browser;
  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch { /* 已退 */ }
    try { browser && browser.close(); } catch { /* 已关 */ }
    rmrf(TMP);
  };

  try {
    await waitHttp(PORT, 90000);
    const { chromium } = require(path.join(REPO, "apps/gateway/node_modules/playwright-core"));
    browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);

 // 合成 3000×1800 大图,直接走测试钩子打开标注编辑器
    await page.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 3000; c.height = 1800;
      const g = c.getContext("2d");
      g.fillStyle = "#181818"; g.fillRect(0, 0, 3000, 1800);
      g.fillStyle = "#3a6ea5"; g.fillRect(900, 600, 1200, 600);
      window.__annTestOpen(c.toDataURL("image/png"), { source: "file", fileName: "vp-test.png", capturedAt: new Date().toISOString() });
    });
    await page.waitForFunction(() => {
      const e = document.getElementById("annEditor");
      return e && getComputedStyle(e).display !== "none";
    }, { timeout: 20000 });
    await page.waitForTimeout(600);

 // ---- A/B:fit 完整 + 居中 ----
    let g = await geo(page);
    const insideVp = g.st.l >= g.vp.l - 1 && g.st.r <= g.vp.r + 1 && g.st.t >= g.vp.t - 1 && g.st.b <= g.vp.b + 1;
    check("A fit 后 stage 完整落在视口内(不裁边)", insideVp,
      `stage=${Math.round(g.st.w)}×${Math.round(g.st.h)}@(${Math.round(g.st.l)},${Math.round(g.st.t)}) vp=${Math.round(g.vp.w)}×${Math.round(g.vp.h)} label=${g.zoomLabel}`);
    const gapL = g.st.l - g.vp.l, gapR = g.vp.r - g.st.r, gapT = g.st.t - g.vp.t, gapB = g.vp.b - g.st.b;
    check("B fit 居中(左右差≤2 上下差≤2)", Math.abs(gapL - gapR) <= 2 && Math.abs(gapT - gapB) <= 2,
      `左右 ${gapL.toFixed(1)}/${gapR.toFixed(1)} 上下 ${gapT.toFixed(1)}/${gapB.toFixed(1)}px`);
    check("B0 fit 缩放<1(大图自适应)", g.imgW === 3000 && g.st.w < g.vp.w && g.st.h < g.vp.h, `img=${g.imgW}×${g.imgH} stage=${g.st.w.toFixed(0)}×${g.st.h.toFixed(0)}`);

 // ---- C:按钮放大 5 次,每步保持居中 ----
    let centeredOk = true, maxDrift = 0;
    for (let i = 0; i < 5; i++) {
      await page.click("#annZoomIn");
      await page.waitForTimeout(60);
      const gg = await geo(page);
      const dx = Math.abs((gg.st.l + gg.st.r) / 2 - (gg.vp.l + gg.vp.r) / 2);
      const dy = Math.abs((gg.st.t + gg.st.b) / 2 - (gg.vp.t + gg.vp.b) / 2);
      maxDrift = Math.max(maxDrift, dx, dy);
      if (dx > 2.5 || dy > 2.5) { centeredOk = false; break; }
    }
    check("C 按钮放大×5 保持居中(每步中心差≤2.5px)", centeredOk, `最大漂移 ${maxDrift.toFixed(2)}px`);

 // ---- E:8× 下 10 CSS px 小拖框(旧 3 图像像素阈值会吞) ----
    await page.click("#annFitBtn");
    await page.waitForTimeout(80);
    for (let i = 0; i < 14; i++) { await page.click("#annZoomIn"); await page.waitForTimeout(30); }
    let gz = await geo(page);
    await page.click('.ann-tool[data-amode="rect"]');
 // 8× 下 stage 大部分在视口外:直接用视口中心附近 client 坐标(保证拖拽落在 viewport 上)
    const smallX = (gz.vp.l + gz.vp.r) / 2 - 60, smallY = (gz.vp.t + gz.vp.b) / 2 - 40;
    await page.mouse.move(smallX, smallY);
    await page.mouse.down();
    await page.mouse.move(smallX + 10, smallY + 10, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const inline = await page.$("#annInlineText");
    if (inline) { await inline.fill("小框", { timeout: 5000 }); await page.keyboard.press("Enter"); }
    gz = await geo(page);
    check("E 8× 下 10px 小拖框成功建卡", gz.cards.length === 1, `label=${gz.zoomLabel} cards=${JSON.stringify(gz.cards)}`);

 // ---- D:缩小到下限(连按 − 20 次),完整可见且居中 ----
    await page.click("#annFitBtn");
    await page.waitForTimeout(80);
    for (let i = 0; i < 20; i++) { await page.click("#annZoomOut"); await page.waitForTimeout(25); }
    g = await geo(page);
    const pct = parseInt(g.zoomLabel, 10) || 100;
    const insideSmall = g.st.l >= g.vp.l - 1 && g.st.r <= g.vp.r + 1 && g.st.t >= g.vp.t - 1 && g.st.b <= g.vp.b + 1;
    const ctrSmall = Math.abs((g.st.l - g.vp.l) - (g.vp.r - g.st.r)) <= 2 && Math.abs((g.st.t - g.vp.t) - (g.vp.b - g.st.b)) <= 2;
    check("D 缩小到下限(≤3%)且 stage 完整可见", pct <= 3 && insideSmall, `label=${g.zoomLabel} stage=${g.st.w.toFixed(0)}×${g.st.h.toFixed(0)} inside=${insideSmall}`);
    check("D2 深度缩小后仍居中", ctrSmall, `label=${g.zoomLabel}`);

 // ---- F/G:缩小(~6%)→空格平移→框选,数据坐标与视觉都跟鼠标 ----
    await page.click("#annFitBtn");
    await page.waitForTimeout(80);
    for (let i = 0; i < 9; i++) { await page.click("#annZoomOut"); await page.waitForTimeout(25); }
    const gPre = await geo(page);
    const pcx = (gPre.vp.l + gPre.vp.r) / 2, pcy = (gPre.vp.t + gPre.vp.b) / 2;
    await page.keyboard.down("Space");
    await page.mouse.move(pcx, pcy);
    await page.mouse.down();
    await page.mouse.move(pcx + 90, pcy + 50, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(80);
    const d1 = await dragInImage(page, 0.3, 0.35, 80, 30);
    await page.waitForTimeout(350);
    const inline2 = await page.$("#annInlineText");
    if (inline2) { await inline2.fill("移动后框选", { timeout: 5000 }); await page.keyboard.press("Enter"); }
    const gPost = await geo(page);
    let dataOk = false, dataDetail = "无卡片";
    const m1 = /^(\d+),(\d+) · (\d+)×(\d+)/.exec(gPost.cards[gPost.cards.length - 1] || "");
    if (m1 && gPost.imgW) {
      const zx = gPost.st.w / gPost.imgW, zy = gPost.st.h / gPost.imgH;
      const px = gPost.st.l + Number(m1[1]) * zx, py = gPost.st.t + Number(m1[2]) * zy;
      const wCss = Number(m1[3]) * zx, hCss = Number(m1[4]) * zy;
      const ddx = Math.abs(px - d1.sx), ddy = Math.abs(py - d1.sy);
      const ddw = Math.abs(wCss - 80), ddh = Math.abs(hCss - 30);
      dataOk = ddx <= 4 && ddy <= 4 && ddw <= 4 && ddh <= 4;
      dataDetail = `卡片(${m1[1]},${m1[2]})·${m1[3]}×${m1[4]} → client(${px.toFixed(1)},${py.toFixed(1)}) vs 鼠标(${d1.sx.toFixed(1)},${d1.sy.toFixed(1)});宽高差 ${ddw.toFixed(1)}/${ddh.toFixed(1)}px`;
    }
    check("F 缩小+平移后框选:数据坐标=鼠标位置(±4px)", dataOk, dataDetail);
    const ov = await page.evaluate((wantX) => {
 // overlay 里有多颗 rect(含 E 轮的 1×1 微框):找左缘贴着本次拖拽起点的那颗
      const rs = Array.from(document.querySelectorAll("#annOverlay rect"));
      const hit = rs.map((r) => ({ el: r, b: r.getBoundingClientRect() }))
        .filter((x) => Math.abs(x.b.left - wantX) < 20 && x.b.width > 20)[0];
      return hit ? { l: hit.b.left, t: hit.b.top, w: hit.b.width, h: hit.b.height } : null;
    }, d1.sx);
    let visOk = false, visDetail = "无 overlay rect";
    if (ov) {
      visOk = Math.abs(ov.l - d1.sx) <= 4 && Math.abs(ov.t - d1.sy) <= 4 && Math.abs(ov.w - 80) <= 4 && Math.abs(ov.h - 30) <= 4;
      visDetail = `rect(${ov.l.toFixed(1)},${ov.t.toFixed(1)},${ov.w.toFixed(1)}×${ov.h.toFixed(1)}) vs 拖拽(${d1.sx.toFixed(1)},${d1.sy.toFixed(1)},80×30)`;
    }
    check("G overlay 框视觉与鼠标重合(viewBox 生效)", visOk, visDetail);

 // ---- H:第二轮 反向平移+再框选,两卡共存坐标仍准 ----
    await page.keyboard.down("Space");
    await page.mouse.move(pcx, pcy);
    await page.mouse.down();
    await page.mouse.move(pcx - 140, pcy - 80, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(80);
 // 第二轮拖拽取点收在图内(0.2 分位+60px,不越右缘触发 clamp)
    const d2 = await dragInImage(page, 0.2, 0.3, 60, 24);
    await page.waitForTimeout(350);
    const inline3 = await page.$("#annInlineText");
    if (inline3) { await inline3.fill("第二轮", { timeout: 5000 }); await page.keyboard.press("Enter"); }
    const gFin = await geo(page);
    let round2Ok = false, round2Detail = "卡片数=" + gFin.cards.length;
    const m2 = /^(\d+),(\d+) · (\d+)×(\d+)/.exec(gFin.cards[gFin.cards.length - 1] || "");
    if (m2 && gFin.imgW && gFin.cards.length >= 2) {
      const zx = gFin.st.w / gFin.imgW, zy = gFin.st.h / gFin.imgH;
      const px = gFin.st.l + Number(m2[1]) * zx, py = gFin.st.t + Number(m2[2]) * zy;
      round2Ok = Math.abs(px - d2.sx) <= 4 && Math.abs(py - d2.sy) <= 4 && Math.abs(Number(m2[3]) * zx - (d2.ex - d2.sx)) <= 4 && Math.abs(Number(m2[4]) * zy - (d2.ey - d2.sy)) <= 4;
      round2Detail = `卡片(${m2[1]},${m2[2]})·${m2[3]}×${m2[4]} → client(${px.toFixed(1)},${py.toFixed(1)}) vs 鼠标(${d2.sx.toFixed(1)},${d2.sy.toFixed(1)})`;
    }
    check("H 第二轮缩放平移后框选仍准(连续操作稳定)", round2Ok, round2Detail);

    check("I 0 pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

    const fail = results.filter((r) => !r.ok).length;
    console.log("\nPASS " + (results.length - fail) + "/" + results.length + (fail ? "  FAIL " + fail : ""));
    if (fail) console.log("实例日志尾:\n" + childLog.slice(-1200));
    cleanup();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.log("FAIL 异常:" + (err && err.stack ? err.stack.split("\n").slice(0, 4).join(" | ") : err));
    console.log("实例日志尾:\n" + childLog.slice(-1200));
    cleanup();
    process.exit(1);
  }
})();
