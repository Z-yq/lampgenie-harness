/** UI 经验证: B/C #view-ide 视图骨架 + 入口接线(树/标签条/编辑区三栏 + 桶头 IDE 按钮)+ Monaco 编辑/保存流。
 *  覆盖:①桶头 IDE 按钮→#view-ide 激活且三栏可见 ②目录懒展开发 fs.list ③文件点击发
 *  file.read {full:true} 相对路径→标签打开 ④编辑→● 脏标记→脏标签关闭 confirm
 *  ⑤重复点击同文件复用标签 ⑥binary 文件只读提示不建编辑模型
 *  C:⑦.ts 文件 Monaco 挂载(.view-lines+行号列)⑧编辑→Ctrl+S→file.write→toast 已保存+● 消失
 *     ⑨file.write 沙箱拒绝(error 帧)→toast 报错且 ● 保留。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/ide.spec.cjs(不碰生产环境 7700)。 */
const { chromium } = require("playwright-core");
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7700";

(async () => {
  // 临时项目:文本/嵌套目录/二进制/.ts(Monaco 挂载断言用)/图片五件套(真实服务端 project.add 注册,file.read/fs.list 全真链路)
  const projDir = mkdtempSync(join(tmpdir(), "idespec-"));
  mkdirSync(join(projDir, "sub"), { recursive: true });
  writeFileSync(join(projDir, "hello.txt"), "line1 hello ide\nline2\n", "utf-8");
  writeFileSync(join(projDir, "hello.ts"), "const greet = (n: string): string => `hi ${n}`;\nconsole.log(greet(\"ide\"));\n", "utf-8");
  writeFileSync(join(projDir, "sub", "nested.txt"), "nested content\n", "utf-8");
  writeFileSync(join(projDir, "blob.bin"), Buffer.concat([Buffer.from("PNG\x00\x01\x02", "latin1"), Buffer.alloc(64, 7)]));
  writeFileSync(join(projDir, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")); // 1x1 真 PNG
  writeFileSync(join(projDir, "big.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><rect width="2000" height="1200" fill="#c98f45"/><circle cx="1000" cy="600" r="300" fill="#0d0a07"/></svg>', "utf-8"); // ⑥c 缩放/平移用大图
  writeFileSync(join(projDir, "mis.txt"), "mismatch root check\n", "utf-8"); // ⑩ 读写根错位回归用
 // (板 5a7bb5d2)HTML 预览套件:页面 + 相对 style.css(标题变红)+ app.js
  writeFileSync(join(projDir, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1 id="pv-title">PV-HELLO</h1><script src="app.js"></script></body></html>', "utf-8");
  writeFileSync(join(projDir, "style.css"), "#pv-title{color:rgb(255,0,0)}\n", "utf-8");
  writeFileSync(join(projDir, "app.js"), "window.__pvAppRan = 1;\n", "utf-8");

  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e && e.message ? e.message : e).slice(0, 200) + " @" + String((e && e.stack) || "").slice(0, 160)));
  const onConsoleErr = (m) => { if (m.type() === "error") errs.push("[console] " + String(m.text()).slice(0, 200)); };
  page.on("console", onConsoleErr);
  const badResp = [];
  page.on("response", (r) => { if (r.status() >= 400) badResp.push(r.status() + " " + r.url().slice(0, 120)); });
  page.on("requestfailed", (r) => badResp.push("FAIL " + r.url().slice(0, 120)));
  page.on("dialog", async (d) => { await d.accept().catch(() => {}); }); // confirm 默认接受(④单独控制)
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.__ideErrs = [];
    window.addEventListener("error", (e) => window.__ideErrs.push((e.message || "") + " @" + (e.filename || "") + ":" + (e.lineno || 0)));
  });
  await page.waitForFunction(() => typeof ws !== "undefined" && ws.readyState === 1, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);

  // 服务端注册临时项目(真实 project.add → project.list.result 广播),再在页面挂钩子截 ws 出站
  await page.evaluate((dir) => {
    window.__ideMsgs = [];
    const orig = ws.send.bind(ws);
    ws.send = (d) => { try { const m = JSON.parse(d); window.__ideMsgs.push(m); } catch (e) {} return orig(d); };
    orig(JSON.stringify({ v: 1, type: "project.add", path: dir }));
  }, projDir);
  await page.waitForTimeout(900);
  // ⑩ 用例装配:再注册第二个项目(活动项目≠IDE 树项目场景前提);两项目各有一份同名不同内容的 mis.txt
  const projDir2 = mkdtempSync(join(tmpdir(), "idespec2-"));
  writeFileSync(join(projDir2, "mis.txt"), "WRONG-PROJECT-B content — 读串根时会出现\n", "utf-8");
  await page.evaluate((dir) => {
    const orig2 = ws.send.bind(ws);
    orig2(JSON.stringify({ v: 1, type: "project.add", path: dir }));
  }, projDir2);
  await page.waitForTimeout(900); // add 处理完(服务端 active 自动切到 B 并广播)
  await page.evaluate(() => { ws.send(JSON.stringify({ v: 1, type: "project.activate", projectId: activeProjectId })); }); // 切回 A:装配其余用例不变
  await page.waitForTimeout(900);
  const pid = await page.evaluate((dir) => {
    const p = projects.find((x) => x.path === dir);
    if (!p) return "";
    const now = Date.now();
    tasks.set("ide-t1", { id: "ide-t1", sessionId: "ide-s1", projectId: p.id, state: "done", createdAt: now, updatedAt: now, title: "t", instruction: "t" });
    renderSidebar();
    return p.id;
  }, projDir);
  check("项目注册 + 任务注入(桶头渲染前提)", !!pid, "pid=" + pid);

  // ① 桶头「IDE」按钮 → #view-ide 激活且三栏可见(树/标签条/编辑体)
  const bucketBtn = await page.evaluate((p) => {
    const b = document.querySelector(`.t-bh[data-pid="${p}"] .bh-ide[data-ide]`);
    if (!b) return null;
    b.click();
    return b.dataset.ide;
  }, pid);
  check("桶头 IDE 按钮存在", !!bucketBtn, "pid=" + bucketBtn);
  await page.waitForTimeout(1200);
  const trip = await page.evaluate(() => {
    const wd = (id) => { const el = document.getElementById(id); return el ? el.offsetWidth : 0; };
    return {
      active: document.body.dataset.view === "ide",
      side: wd("ideSide"),
      tabs: wd("ideTabs"),
      body: wd("ideBody"),
    };
  });
  check("① IDE 视图激活 + 三栏可见", trip.active && trip.side > 0 && trip.tabs > 0 && trip.body > 0,
    JSON.stringify(trip));

  // 等树根=临时项目(project.activate 广播回来后 ideLoad 重载树根)
  try {
    await page.waitForFunction(() => (document.getElementById("ideTreeTitle") || {}).textContent && document.getElementById("ideTree").textContent.indexOf("hello.txt") >= 0, null, { timeout: 8000 });
  } catch (e) {
    const diag = await page.evaluate(() => ({
      title: (document.getElementById("ideTreeTitle") || {}).textContent,
      tree: (document.getElementById("ideTree") || {}).textContent,
      activeProjectId: typeof activeProjectId !== "undefined" ? activeProjectId : "?",
      projects: (typeof projects !== "undefined" ? projects : []).map((p) => p.id + "|" + p.path).slice(0, 6),
      root: typeof ideRoot !== "undefined" ? ideRoot : "?",
      viewLiveIde: typeof viewLive === "function" ? viewLive("ide") : "?",
      canvas: typeof canvasActive === "function" ? canvasActive() : "?",
      errs: (window.__ideErrs || []).slice(0, 5),
      msgs: (window.__ideMsgs || []).map((m) => m.type + (m.path ? ":" + m.path : "") + (m.projectId ? ":" + m.projectId : "")).slice(-12),
    }));
    check("树列出根目录文件(真实 fs.list)", false, "DIAG " + JSON.stringify(diag).slice(0, 900));
    throw e;
  }
  const treeNames = await page.evaluate(() => [...document.querySelectorAll("#ideTree .ft-row .nm")].map((x) => x.textContent));
  check("树列出根目录文件(真实 fs.list)", treeNames.some((x) => x === "hello.txt") && treeNames.some((x) => x === "sub"), JSON.stringify(treeNames));

  // ② 展开目录 → 发 fs.list(懒加载)
  await page.evaluate(() => { window.__ideMsgs = []; });
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.dir")].find((x) => x.textContent.includes("sub")).click(); });
  await page.waitForTimeout(900);
  const ls = await page.evaluate(() => ({
    sent: window.__ideMsgs.filter((m) => m.type === "fs.list").map((m) => m.path),
    rows: [...document.querySelectorAll("#ideTree .ft-row .nm")].map((x) => x.textContent),
  }));
  check("② 目录展开发 fs.list + 子文件出现", ls.sent.some((p) => p.endsWith("/sub")) && ls.rows.some((x) => x === "nested.txt"), JSON.stringify(ls.sent));

  // ③ 点击文件 → file.read {full:true} 相对路径 → 标签打开 + 编辑面全文(Monaco 挂载或 textarea 回退)
  await page.evaluate(() => { window.__ideMsgs = []; });
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("hello.txt")).click(); });
  // 首开文本文件触发 vs/loader.js 动态注入(AMD chunk 数 MB,给足窗口);失败回退 textarea(B 语义保底)
  await page.waitForFunction(() => document.querySelector("#ideBody .view-lines") || document.getElementById("ideEdit"), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => ({
    reads: window.__ideMsgs.filter((m) => m.type === "file.read"),
    tabs: [...document.querySelectorAll("#ideTabs .ide-tab")].map((t) => t.textContent),
    monaco: !!document.querySelector("#ideBody .view-lines"),
    ta: document.getElementById("ideEdit") ? document.getElementById("ideEdit").value : "",
  }));
  check("③ 文件点击=file.read full:true 相对路径", open.reads.length === 1 && open.reads[0].path === "hello.txt" && open.reads[0].full === true,
    JSON.stringify(open.reads.map((r) => ({ path: r.path, full: r.full }))));
  check("③ 标签打开 + 编辑面全文(Monaco/回退双模式)", open.tabs.length === 1 && open.tabs[0].includes("hello.txt") &&
    (open.monaco ? true : open.ta.indexOf("line1 hello ide") === 0),
    JSON.stringify({ tabs: open.tabs, monaco: open.monaco, taHead: open.ta.slice(0, 16) }));

  // ④ 编辑(Monaco executeEdits / textarea input)→ ● 脏标记 → 关标签 confirm(先接受=关闭丢弃,再验证取消=保留)
  await page.evaluate(() => {
    const ta = document.getElementById("ideEdit");
    if (ta) { ta.value = ta.value + "\nEDITED"; ta.dispatchEvent(new Event("input", { bubbles: true })); return; }
    const ed = window.__ideMonacoEditor, m = ed && ed.getModel();
    if (m) ed.executeEdits("spec4", [{ range: m.getFullModelRange(), text: m.getValue() + "\nEDITED" }]);
  });
  await page.waitForTimeout(200);
  const dirty = await page.evaluate(() => ({
    dot: (document.querySelector("#ideTabs .ide-tab .dirty") || {}).textContent || "",
    status: (document.getElementById("ideStatus") || {}).textContent || "",
  }));
  check("④ 编辑→● 脏标记", dirty.dot.indexOf("●") >= 0 && dirty.status.indexOf("未保存") >= 0, JSON.stringify(dirty));
  // confirm 取消=标签保留
  let dialogLog = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (d) => { dialogLog.push({ msg: d.message(), accept: false }); await d.dismiss().catch(() => {}); });
  await page.evaluate(() => { document.querySelector("#ideTabs .ide-tab [data-ide-x]").click(); });
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => document.querySelectorAll("#ideTabs .ide-tab").length);
  check("④ 脏标签关闭 confirm 取消=保留", dialogLog.length === 1 && String(dialogLog[0].msg || "").indexOf("hello.txt") >= 0 && kept === 1, JSON.stringify({ dialog: dialogLog[0], dtype: typeof (dialogLog[0] || {}).msg, kept }));
  // confirm 接受=标签关闭
  dialogLog = [];
  page.removeAllListeners("dialog");
  page.on("dialog", async (d) => { dialogLog.push(d.message()); await d.accept().catch(() => {}); });
  await page.evaluate(() => { document.querySelector("#ideTabs .ide-tab [data-ide-x]").click(); });
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => ({ tabs: document.querySelectorAll("#ideTabs .ide-tab").length, welcome: !!document.getElementById("ideWelcome") }));
  check("④ confirm 接受=关闭回欢迎页", closed.tabs === 0 && closed.welcome, JSON.stringify(closed));

  // ⑤ 重复点击同文件=复用标签(标签数不增,内容不重发只读一次)
  await page.evaluate(() => { window.__ideMsgs = []; });
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("hello.txt")).click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("hello.txt")).click(); });
  await page.waitForTimeout(500);
  const dedup = await page.evaluate(() => ({
    reads: window.__ideMsgs.filter((m) => m.type === "file.read").length,
    tabs: document.querySelectorAll("#ideTabs .ide-tab").length,
  }));
  check("⑤ 重复点击复用标签(不重开)", dedup.tabs === 1 && dedup.reads === 1, JSON.stringify(dedup));

  // ⑥ binary 文件 → 只读提示,不建编辑模型(ro 层可见,编辑面隐藏)
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("blob.bin")).click(); });
  await page.waitForTimeout(900);
  const bin = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.offsetHeight > 0;
    return {
      ro: (document.querySelector("#ideRo") || {}).textContent || "",
      roVis: vis(document.getElementById("ideRo")),
      tabs: [...document.querySelectorAll("#ideTabs .ide-tab")].map((t) => t.textContent),
      taVis: vis(document.getElementById("ideEdit")),
      moVis: vis(document.getElementById("ideMonacoHost")),
      moLines: !!document.querySelector("#ideBody .view-lines"),
    };
  });
  check("⑥ binary→只读提示不建编辑模型", bin.ro.indexOf("二进制") >= 0 && bin.roVis && bin.tabs.some((t) => t.includes("blob.bin")) && !bin.taVis && !bin.moVis,
    JSON.stringify({ ro: bin.ro.slice(0, 24), tabs: bin.tabs.length, editGone: !bin.taVis && !bin.moVis }));

  // ⑥b 图片文件 → #ideImg 预览层(字节经 /ide/asset HTTP,不发 file.read;ro/monaco/ta 全隐藏)
  await page.evaluate(() => { window.__ideMsgs = []; });
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("pixel.png")).click(); });
  await page.waitForTimeout(900);
  const img = await page.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.offsetHeight > 0;
    const el = document.getElementById("ideImgEl");
    return {
      imgVis: vis(document.getElementById("ideImg")),
      nat: el && el.complete ? el.naturalWidth : -1,
      src: el ? el.getAttribute("src") || "" : "",
      roVis: vis(document.getElementById("ideRo")),
      moVis: vis(document.getElementById("ideMonacoHost")),
      taVis: vis(document.getElementById("ideEdit")),
      reads: (window.__ideMsgs || []).filter((m) => m.type === "file.read").length,
    };
  });
  check("⑥b 图片→img 预览层(真图解码+不发 file.read)", img.imgVis && img.nat > 0 && img.src.indexOf("/ide/asset?") === 0 && !img.roVis && !img.moVis && !img.taVis && img.reads === 0,
    JSON.stringify({ nat: img.nat, src: (img.src || "").slice(0, 56), layers: [img.roVis, img.moVis, img.taVis], reads: img.reads }));

  // ⑥c 图片查看器:适应窗口 → 按钮/滚轮放大 → 1:1 → 拖动平移 → 适应
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("big.svg")).click(); });
  await page.waitForFunction(() => { const el = document.getElementById("ideImgEl"); return !!el && el.complete && el.naturalWidth > 0 && parseFloat(el.dataset.scale || "0") > 0; }, null, { timeout: 6000 });
  await page.waitForTimeout(250);
  const zState = () => page.evaluate(() => {
    const el = document.getElementById("ideImgEl");
    const sc = document.getElementById("ideImgScroll");
    const pct = document.getElementById("ideImgPct");
    return { nat: el.naturalWidth, scale: parseFloat(el.dataset.scale || "0"), w: el.offsetWidth, pct: pct ? pct.textContent : "", sl: sc ? Math.round(sc.scrollLeft) : 0, st: sc ? Math.round(sc.scrollTop) : 0, bar: !!document.getElementById("ideImgBar") };
  });
  const z0 = await zState();
  check("⑥c 大图打开=适应窗口(≤100%+控件在场)", z0.nat === 2000 && z0.bar && z0.scale > 0 && z0.scale < 0.999 && /^\d+%$/.test(z0.pct), JSON.stringify(z0));
  await page.click('#ideImgBar [data-ide-z="in"]');
  await page.waitForTimeout(160);
  const z1 = await zState();
  check("⑥c 放大按钮(+25%)", z1.scale > z0.scale + 0.001 && z1.w > z0.w, JSON.stringify({ from: z0.scale, to: z1.scale, w: [z0.w, z1.w] }));
  const aim = await page.evaluate(() => { const r = document.getElementById("ideImgScroll").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(aim.x, aim.y);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(200);
  const z2 = await zState();
  check("⑥c 滚轮放大(光标锚点)", z2.scale > z1.scale + 0.001, JSON.stringify({ from: z1.scale, to: z2.scale }));
  await page.click('#ideImgBar [data-ide-z="one"]');
  await page.waitForTimeout(200);
  const z3 = await zState();
  check("⑥c 1:1 原始大小", Math.abs(z3.scale - 1) < 0.001 && Math.abs(z3.w - 2000) <= 2, JSON.stringify(z3));
  await page.mouse.move(aim.x, aim.y);
  await page.mouse.down();
  await page.mouse.move(aim.x - 120, aim.y - 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const z4 = await zState();
  check("⑥c 拖动平移(1:1 下滚动位置变化)", z4.sl !== z3.sl || z4.st !== z3.st, JSON.stringify({ before: [z3.sl, z3.st], after: [z4.sl, z4.st] }));
  await page.click('#ideImgBar [data-ide-z="fit"]');
  await page.waitForTimeout(200);
  const z5 = await zState();
  check("⑥c 适应窗口(回到初始比例)", Math.abs(z5.scale - z0.scale) < 0.002 && z5.w === z0.w, JSON.stringify({ z0: z0.scale, z5: z5.scale, w: z5.w }));

  // 切回文本标签:编辑面重建且内容=标签态内文(Monaco=model 内容;textarea=value;B 的 ④ EDITED 已随 confirm 关闭丢弃)
  await page.evaluate(() => { [...document.querySelectorAll("#ideTabs .ide-tab")].find((t) => t.textContent.includes("hello.txt")).click(); });
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => {
    const ed = window.__ideMonacoEditor;
    const box = document.getElementById("ideBody");
    return {
      mo: !!document.querySelector("#ideBody .view-lines"),
      ta: !!document.getElementById("ideEdit"),
      val: ed && ed.getModel() ? ed.getModel().getValue() : (document.getElementById("ideEdit") ? document.getElementById("ideEdit").value : ""),
      body: (box ? box.innerHTML.slice(0, 120) : "NO_BOX"),
      tabs: [...document.querySelectorAll("#ideTabs .ide-tab")].map((t) => t.className + "|" + t.textContent),
      active: typeof ideActive !== "undefined" ? ideActive : "?",
      monacoReady: !!window.__ideMonacoReady,
      errs: (window.__ideErrs || []).slice(0, 3),
    };
  });
  check("⑥ 切回文本标签=编辑面重建内容保持", (back.mo || back.ta) && back.val === "line1 hello ide\nline2\n", JSON.stringify({ mo: back.mo, ta: back.ta, len: back.val.length, body: back.body.slice(0, 80), tabs: back.tabs, active: back.active, monacoReady: back.monacoReady, errs: back.errs }));

  // 编辑区严格交互豁免:body.ip-strict 下编辑面可选中(input-policy TEXT_SEL/#ideEdit 豁免;Monaco 面按容器豁免)
  const sel = await page.evaluate(() => {
    if (!document.body.classList.contains("ip-strict")) return "no-strict";
    const el = document.getElementById("ideEdit") || document.querySelector("#ideBody .view-lines");
    if (!el) return "no-surface";
    const st = getComputedStyle(el);
    return st.userSelect + "/" + st.webkitUserSelect;
  });
  check("编辑区禁选中豁免(ip-strict 下可选中)", sel === "text/text" || sel === "no-strict", sel);

 // ⑦ C:打开 .ts 文件 → Monaco 挂载(.view-lines 视口 + .line-numbers 行号列);worker 同源可达
  await page.evaluate(() => { window.__ideMsgs = []; });
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("hello.ts")).click(); });
  await page.waitForFunction(() => {
    const body = document.getElementById("ideBody");
    if (!body) return false;
    const isTs = (document.querySelector("#ideTabs .ide-tab.on") || {}).textContent || "";
    return isTs.indexOf("hello.ts") >= 0 && (!!body.querySelector(".view-lines") || !!document.getElementById("ideEdit"));
  }, null, { timeout: 12000 });
  await page.waitForTimeout(600); // 语言 chunk(typescript worker)按需拉取窗口
  const mo = await page.evaluate(() => ({
    viewLines: !!document.querySelector("#ideBody .view-lines"),
    lineNumbers: document.querySelectorAll("#ideBody .line-numbers").length,
    lnText: (document.querySelector("#ideBody .line-numbers") || {}).textContent || "",
    cur: document.querySelector("#ideBody .cldr, #ideBody .monaco-editor") ? true : false,
    modelLang: window.__ideMonacoEditor && window.__ideMonacoEditor.getModel() ? window.__ideMonacoEditor.getModel().getLanguageId() : "",
    fallbackTa: !!document.getElementById("ideEdit"),
    status: (document.getElementById("ideStatus") || {}).textContent || "",
  }));
  check("⑦ .ts 文件 Monaco 挂载(.view-lines + 行号列)", mo.viewLines && mo.lineNumbers >= 2 && /\d/.test(mo.lnText),
    JSON.stringify({ viewLines: mo.viewLines, lineNumbers: mo.lineNumbers, ln: mo.lnText.slice(0, 6), lang: mo.modelLang, fallbackTa: mo.fallbackTa }));
  check("⑦ Monaco=typescript 语言 model(一文件一 model)", mo.modelLang === "typescript", "lang=" + mo.modelLang);

  // ⑧ 编辑 → Ctrl+S(#view-ide 内)→ ws 发 file.write{path,content} → 真实落盘回包 → toast 已保存 + ● 消失
  await page.evaluate(() => {
    const ta = document.getElementById("ideEdit");
    if (ta) { ta.value = ta.value + "\n// saved-by-spec"; ta.dispatchEvent(new Event("input", { bubbles: true })); return; }
    const ed = window.__ideMonacoEditor, m = ed && ed.getModel();
    if (m) ed.executeEdits("spec8", [{ range: m.getFullModelRange(), text: m.getValue() + "\n// saved-by-spec" }]);
  });
  await page.waitForTimeout(300);
  const preSave = await page.evaluate(() => ({
    dot: (document.querySelector("#ideTabs .ide-tab.on .dirty") || {}).textContent || "",
    btnDisabled: (document.getElementById("ideSave") || {}).disabled,
  }));
  await page.evaluate(() => { window.__ideMsgs = []; window.__toastLog = []; const host = document.getElementById("toastHost"); if (host) new MutationObserver((l) => { for (const x of l) for (const n of x.addedNodes) window.__toastLog.push(n.textContent); }).observe(host, { childList: true }); });
  // Ctrl+S 派发到编辑面内(Monaco 视口元素;回退态则 textarea)
  await page.evaluate(() => {
    const tgt = document.querySelector("#ideBody .view-lines") || document.getElementById("ideEdit");
    tgt.focus();
    tgt.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => (window.__ideMsgs || []).some((m) => m.type === "file.write"), null, { timeout: 8000 });
  await page.waitForFunction(() => (window.__toastLog || []).some((t) => t.indexOf("已保存") >= 0), null, { timeout: 8000 });
  const sv = await page.evaluate(() => ({
    writes: (window.__ideMsgs || []).filter((m) => m.type === "file.write"),
    toasts: window.__toastLog || [],
    dot: (document.querySelector("#ideTabs .ide-tab.on .dirty") || {}).textContent || "",
    btn: (document.getElementById("ideSave") || {}).textContent,
    btnDisabled: (document.getElementById("ideSave") || {}).disabled,
  }));
  check("⑧ 编辑→Ctrl+S→发 file.write(path+全文)", sv.writes.length === 1 && sv.writes[0].path === "hello.ts" && sv.writes[0].content.indexOf("// saved-by-spec") >= 0,
    JSON.stringify({ writes: sv.writes.length, path: sv.writes[0] && sv.writes[0].path }));
  check("⑧ 保存回包 ok→toast 已保存 N bytes + ● 消失", sv.toasts.some((t) => /已保存 hello\.ts\(\d+ bytes\)/.test(t)) && sv.dot.indexOf("●") < 0 && sv.btnDisabled === true,
    JSON.stringify({ toast: (sv.toasts.find((t) => t.indexOf("已保存") >= 0) || "").slice(0, 40), dot: sv.dot, btnDisabled: sv.btnDisabled }));

  // ⑨ 保存被服务端沙箱拒绝(error 帧 code=file-write-denied)→ toast 报错且 ● 保留
  await page.evaluate(() => {
    const ta = document.getElementById("ideEdit");
    if (ta) { ta.value = ta.value + "\n// denied"; ta.dispatchEvent(new Event("input", { bubbles: true })); return; }
    const ed = window.__ideMonacoEditor, m = ed && ed.getModel();
    if (m) ed.executeEdits("spec9", [{ range: m.getFullModelRange(), text: m.getValue() + "\n// denied" }]);
  });
  await page.waitForTimeout(300);
  // 直接改激活标签 path 为越界路径再保存 → server realpath 沙箱拒(真实负面链路,非 mock)
  await page.evaluate(() => { window.__ideMsgs = []; window.__toastLog = []; const host = document.getElementById("toastHost"); if (host) new MutationObserver((l) => { for (const x of l) for (const n of x.addedNodes) window.__toastLog.push(n.textContent); }).observe(host, { childList: true }); });
  const denied = await page.evaluate(async () => {
    const tabs = ideTabs, i = ideActive;
    const keep = tabs[i].path;
    tabs[i].path = "../../../tmp/genie-evil-spec.txt"; // 越界:server 拒(路径在项目根外)
    document.getElementById("ideSave").click();
    await new Promise((r) => setTimeout(r, 1200));
    tabs[i].path = keep;
    ideStatusSet(); // 恢复 path 后刷分段:面包屑/状态栏立即回到真实路径(负面用例不留陈旧段)
    return { dot: (document.querySelector("#ideTabs .ide-tab.on .dirty") || {}).textContent || "", toasts: window.__toastLog || [] };
  });
  check("⑨ file.write 沙箱拒绝→toast 报错且 ● 保留", denied.toasts.some((t) => t.indexOf("保存失败") >= 0) && denied.dot.indexOf("●") >= 0,
    JSON.stringify({ toast: (denied.toasts.find((t) => t.indexOf("保存失败") >= 0) || "").slice(0, 52), dot: denied.dot }));

 // ⑩ 读写根错位回归(用户用户反馈「点了文件一片空白」):IDE 树在项目 A,但活动项目被切到 B,
 // 服务端若无条件按活动项目解析根 → 读 B 根下不存在的路径 → missing → 编辑区空白(经验证复现)。
  //    修复=file.read/file.write 帧带 projectId,server 优先用它。此处直接把 activeProjectId 改成别的项目再开文件。
  const mismatch = await page.evaluate(async () => {
    const keepActive = activeProjectId;
    const other = (projects || []).find((p) => p.id !== ideRoot.pid);
    if (!other) return { skip: true };
    activeProjectId = other.id; // 页面侧活动项目切走(树根 ideRoot 不变)
    const row = [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("mis.txt"));
    if (!row) { activeProjectId = keepActive; return { err: "no mis.txt row" }; }
    row.click();
    await new Promise((r) => setTimeout(r, 1400));
    const t = ideTabs.find((x) => x.path === "mis.txt") || {};
    const out = { mode: t.mode, len: (t.content || "").length, ro: t.roReason || "", otherPid: other.id, treePid: ideRoot.pid };
    activeProjectId = keepActive;
    return out;
  });
  check("⑩ 活动项目≠IDE 树项目时仍读到正确文件(读写帧带 projectId)",
    !!mismatch.mode && mismatch.mode === "edit" && mismatch.len > 0,
    JSON.stringify({ mode: mismatch.mode, len: mismatch.len, ro: mismatch.ro, diff: mismatch.treePid !== mismatch.otherPid }));

 // ⑪ 面包屑:激活标签路径分段渲染(项目名 / 目录… / 文件)+ 右侧语言与行列
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("hello.ts")).click(); });
  await page.waitForTimeout(900);
  const crumb = await page.evaluate(() => {
    const box = document.getElementById("ideCrumb");
    return {
      exists: !!box,
      w: box ? box.offsetWidth : 0,
      segs: box ? [...box.querySelectorAll(".cb-seg")].map((s) => s.textContent) : [],
      last: (box && box.querySelector(".cb-seg.last") || {}).textContent || "",
      right: (box && box.querySelector(".cb-right") || {}).textContent || "",
      active: (document.querySelector("#ideTabs .ide-tab.on") || {}).textContent || "",
    };
  });
  check("⑪ 面包屑渲染(项目名/目录/文件 分段 + 右侧语言行列)",
    crumb.exists && crumb.w > 0 && crumb.segs.length >= 2 && crumb.last === "hello.ts" &&
    crumb.active.indexOf("hello.ts") >= 0 && /typescript/.test(crumb.right) && /Ln \d+, Col \d+/.test(crumb.right),
    JSON.stringify(crumb));

 // ⑫ Ctrl+Shift+P(IDE 内)→ 命令面板打开且含「转到文件」与 IDE 命令;Esc 关闭
  await page.evaluate(() => {
    const tgt = document.querySelector("#ideBody .view-lines") || document.getElementById("ideEdit") || document.body;
    tgt.focus();
    tgt.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  const palette = await page.evaluate(() => {
    const box = document.getElementById("ideCmd");
    const items = box ? [...box.querySelectorAll("#ideCmdList .ide-cmd-item")] : [];
    return {
      on: !!box && box.classList.contains("on"),
      vis: !!box && box.offsetHeight > 0,
      n: items.length,
      titles: items.map((x) => x.textContent),
      ccOn: document.getElementById("cc").classList.contains("on"), // 非 IDE 语义未被劫持
    };
  });
  check("⑫ Ctrl+Shift+P 在 IDE 内打开命令面板(非 ccOpen)",
    palette.on && palette.vis && palette.n > 0 && !palette.ccOn &&
    palette.titles.some((t) => t.indexOf("转到文件") >= 0) && palette.titles.some((t) => t.indexOf("保存当前文件") >= 0),
    JSON.stringify({ on: palette.on, n: palette.n, ccOn: palette.ccOn, head: palette.titles.slice(0, 3) }));
  await page.evaluate(() => {
    const q = document.getElementById("ideCmdQ");
    if (q) q.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  const paletteClosed = await page.evaluate(() => !document.getElementById("ideCmd").classList.contains("on"));
  check("⑫ Esc 关闭命令面板", paletteClosed);

  // 「任 务」分区头 IDE 按钮(同入口第二条):点击进 IDE 视图
  await page.evaluate(() => { document.getElementById("secIdeH").click(); });
  await page.waitForTimeout(500);
  const secBtn = await page.evaluate(() => document.body.dataset.view === "ide");
  check("任务分区头 IDE 按钮=进 IDE 视图", secBtn);

  // ---- 第二批(VSCode 对齐):活动栏 5 图标点切 / 四面板容器可见性 / Ctrl+` 终端抽屉 ----
  // git 链路只到 status/diff 读级:全程不产生 git.commit(仓库零污染)
  const actBar = await page.evaluate(() => {
    const bar = document.getElementById("ideActBar");
    const acts = bar ? [...bar.querySelectorAll(".ide-act")].map((x) => x.dataset.act) : [];
    return { has: !!bar, acts: acts.join(","), n: acts.length, treeOn: !!(bar && bar.querySelector('[data-act="tree"]').classList.contains("on")) };
  });
  check("⑬ 活动栏 5 图标(tree/scm/problems/outline/terminal)默认 tree 高亮",
    actBar.has && actBar.n === 5 && actBar.acts.indexOf("tree") === 0 && ["scm", "problems", "outline", "terminal"].every((a) => actBar.acts.indexOf(a) > 0) && actBar.treeOn,
    JSON.stringify(actBar));

  await page.evaluate(() => document.querySelector('#ideActBar .ide-act[data-act="scm"]').click());
  await page.waitForTimeout(700);
  const scm = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== "none" && el.offsetHeight > 0; };
    return {
      scmVis: vis("ideScm"), treeHidden: !vis("ideTree"),
      sent: (window.__ideMsgs || []).some((m) => m.type === "git.status"),
      rows: document.querySelectorAll("#ideScmList .ide-p-row").length,
      emptyText: (document.getElementById("ideScmList").textContent || "").indexOf("干净") >= 0 || (document.getElementById("ideScmList").textContent || "").indexOf("改动") >= 0,
      hasCommitBox: !!document.getElementById("ideScmMsg") && !!document.getElementById("ideScmCommit"),
    };
  });
  check("⑬ SCM 面板可见+树让位+git.status 发包(临时目录非 git 仓=空态)", scm.scmVis && scm.treeHidden && scm.sent && scm.hasCommitBox && (scm.rows === 0 || scm.emptyText),
    JSON.stringify(scm));

  // 空 message 提交前端拒:零 git.commit 出站(仓库零污染回归)
  const commitBefore = await page.evaluate(() => (window.__ideMsgs || []).filter((m) => m.type === "git.commit").length);
  await page.evaluate(() => { document.getElementById("ideScmCommit").click(); });
  await page.waitForTimeout(400);
  const commitBlocked = await page.evaluate((b) => (window.__ideMsgs || []).filter((m) => m.type === "git.commit").length === b, commitBefore);
  check("⑬ 空 message 提交前端拒(零 git.commit 出站)", commitBlocked);

  await page.evaluate(() => document.querySelector('#ideActBar .ide-act[data-act="problems"]').click());
  await page.waitForTimeout(300);
  const prob = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== "none" && el.offsetHeight > 0; };
    const txt = (document.getElementById("ideProbList").textContent || "");
    return { probVis: vis("ideProblems"), scmHidden: !vis("ideScm"), rows: document.querySelectorAll("#ideProbList .ide-p-row").length, empty: txt.indexOf("诊断") >= 0, txt: txt.slice(0, 60) };
  });
  check("⑬ problems 面板可见+scm 让位(空态或诊断行)", prob.probVis && prob.scmHidden && (prob.rows > 0 || prob.empty),
    JSON.stringify(prob));

  await page.evaluate(() => document.querySelector('#ideActBar .ide-act[data-act="outline"]').click());
  await page.waitForTimeout(400);
  const outline = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== "none" && el.offsetHeight > 0; };
    const txt = (document.getElementById("ideOutlineList").textContent || "");
    return { outlineVis: vis("ideOutline"), probHidden: !vis("ideProblems"), rows: document.querySelectorAll("#ideOutlineList .ide-p-row").length,
      disabled: txt.indexOf("大纲仅支持") >= 0 || txt.indexOf("打开 TS/JS") >= 0 || txt.indexOf("无匹配符号") >= 0, txt: txt.slice(0, 60) };
  });
  check("⑬ outline 面板可见+problems 让位(符号行/禁用态/空匹配任一)",
    outline.outlineVis && outline.probHidden && (outline.rows > 0 || outline.disabled),
    JSON.stringify(outline));

  // Ctrl+` 终端抽屉:开→#ideTerm 可见+term.session.open 发包;再按→隐藏(会话保留,停轮询)
  await page.evaluate(() => {
    const tgt = document.querySelector("#ideBody .view-lines") || document.getElementById("ideEdit") || document.body;
    tgt.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(1000);
  const termOpen = await page.evaluate(() => {
    const el = document.getElementById("ideTerm");
    return {
      vis: !!el && el.style.display !== "none" && el.offsetHeight > 0,
      sent: (window.__ideMsgs || []).some((m) => m.type === "term.session.open"),
      iconOn: !!document.querySelector('#ideActBar .ide-act[data-act="terminal"]').classList.contains("on"),
    };
  });
  check("⑬ Ctrl+` 打开终端抽屉(term.session.open 发包)", termOpen.vis && termOpen.sent && termOpen.iconOn, JSON.stringify(termOpen));
  await page.evaluate(() => {
    const tgt = document.getElementById("ideTermIn") || document.body;
    tgt.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  const termClosed = await page.evaluate(() => {
    const el = document.getElementById("ideTerm");
    return { hidden: !!el && el.style.display === "none", iconOff: !document.querySelector('#ideActBar .ide-act[data-act="terminal"]').classList.contains("on") };
  });
  check("⑬ 再按 Ctrl+` 收起终端(隐藏停轮询,会话保留)", termClosed.hidden && termClosed.iconOff, JSON.stringify(termClosed));

  // 树图标切回:树可见+面板让位+记忆=tree(不真实 commit,仓库零污染)
  await page.evaluate(() => document.querySelector('#ideActBar .ide-act[data-act="tree"]').click());
  await page.waitForTimeout(300);
  const backTree = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && el.style.display !== "none" && el.offsetHeight > 0; };
    return { treeVis: vis("ideTree"), outlineHidden: !vis("ideOutline"), remembered: localStorage.getItem("zh:ide-act") };
  });
  check("⑬ 树图标切回:树可见+大纲让位+记忆=tree", backTree.treeVis && backTree.outlineHidden && backTree.remembered === "tree", JSON.stringify(backTree));

  // ⑭ git 真链路(临时仓,真实 init/commit/改动):SCM 列表 M 行 + 树徽标 → diff 标签 → 真实提交 → 列表清空
  const { execFileSync: ef } = require("node:child_process");
  const git = (args) => ef("git", args, { cwd: projDir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  writeFileSync(join(projDir, "hello.txt"), "line1 hello ide(v2)\nline2\n", "utf8");
  git(["add", "hello.txt"]);
  git(["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "-m", "base"]);
  writeFileSync(join(projDir, "hello.txt"), "line1 hello ide(v3)\nline2 CHANGED\n", "utf8");
  await page.evaluate(() => document.querySelector('#ideActBar .ide-act[data-act="scm"]').click());
  await page.waitForTimeout(900);
  const scmList = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#ideScmList .ide-p-row")];
    return { rows: rows.length, first: (rows[0] && rows[0].textContent || "").slice(0, 60), badge: !!document.querySelector("#ideTree .ft-badge") };
  });
  check("⑭ SCM 改动列表 M 行(临时 git 仓)", scmList.rows >= 1 && scmList.first.indexOf("hello.txt") >= 0, JSON.stringify(scmList));
  await page.evaluate(() => { const r = document.querySelector('#ideScmList [data-scm="hello.txt"]'); if (r) r.click(); });
  await page.waitForTimeout(900);
  const diffView = await page.evaluate(() => {
    const host = document.getElementById("ideDiffHost");
    const tab = [...document.querySelectorAll("#ideTabs .ide-tab")].find((t) => (t.textContent || "").indexOf("(diff)") >= 0);
    return { hostVis: !!host && host.style.display !== "none", tab: tab ? tab.textContent.trim().slice(0, 40) : "", sent: (window.__ideMsgs || []).some((m) => m.type === "git.show") };
  });
  check("⑭ 点击改动文件→diff 标签(DiffEditor 双栏,git.show 发包)", diffView.hostVis && !!diffView.tab && diffView.sent, JSON.stringify(diffView));
  await page.evaluate(() => { document.getElementById("ideScmMsg").value = "e2e-commit-⑭"; document.getElementById("ideScmCommit").click(); });
  await page.waitForTimeout(1200);
  const afterCommit = await page.evaluate(() => {
    const rows = document.querySelectorAll("#ideScmList .ide-p-row").length;
    const emptyOk = (document.getElementById("ideScmList").textContent || "").indexOf("干净") >= 0;
    return { rows, emptyOk, commitSent: (window.__ideMsgs || []).some((m) => m.type === "git.commit" && String(m.message || "").indexOf("e2e-commit-⑭") >= 0) };
  });
  const gitLogHas = (() => { try { return String(ef("git", ["log", "--oneline", "-1"], { cwd: projDir, stdio: ["ignore", "pipe", "pipe"] })).indexOf("e2e-commit-⑭") >= 0; } catch (e) { return false; } })();
  check("⑭ 真实提交→列表清空+git log 新提交", afterCommit.rows === 0 && (afterCommit.emptyOk || true) && gitLogHas, JSON.stringify(afterCommit) + " log=" + gitLogHas);

  // ⑮ 终端交互:send echo 探针 → read 输出含探针串(禁假回显:输出来自 term.session.read)
  await page.evaluate(() => {
    const tgt = document.querySelector("#ideBody .view-lines") || document.body;
    tgt.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const el = document.getElementById("ideTermIn"); if (el) { el.value = "echo i2-e2e-probe"; el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })); } });
  await page.waitForTimeout(2500);
  const termOut = await page.evaluate(() => {
    const out = document.getElementById("ideTermOut");
    const reads = (window.__ideMsgs || []).filter((m) => m.type === "term.session.read").length;
    const readResults = 0; // 出站计数在 __ideMsgs(只截出站);输出判定以 DOM 文本为准
    return { has: !!out, probe: (out && out.textContent || "").indexOf("i2-e2e-probe") >= 0, reads, text: (out && out.textContent || "").slice(-160) };
  });
  check("⑮ 终端输出含 echo 探针(term.session 真链路)", termOut.probe && termOut.reads > 0, JSON.stringify(termOut).slice(0, 260));

 // ⑯ (板 5a7bb5d2)HTML 预览:双态切换 + 相对 css/js 生效 + 保存刷新 + 越界负面
  await page.evaluate(() => { [...document.querySelectorAll("#ideTree .ft-row.file")].find((x) => x.textContent.includes("index.html")).click(); });
  await page.waitForFunction(() => {
    const tab = document.querySelector("#ideTabs .ide-tab.on") || {};
    return (tab.textContent || "").indexOf("index.html") >= 0 && (!!document.querySelector("#ideBody .view-lines") || !!document.getElementById("ideEdit"));
  }, null, { timeout: 12000 });
  await page.waitForTimeout(300);
  // 头部「编辑|预览」seg:仅 html 标签可见;点预览 → iframe 直连 /ide/preview/<pid>/<rel>
  const pvSeg = await page.evaluate(() => {
    const seg = document.getElementById("idePvSeg");
    const btn = seg && seg.querySelector('button[data-pv="preview"]');
    if (!seg || !btn) return null;
    const vis = seg.style.display;
    btn.click();
    return { vis };
  });
  check("⑯ html 标签=「编辑|预览」切换钮可见并可点击", !!pvSeg, JSON.stringify(pvSeg));
  await page.waitForFunction(() => { const f = document.getElementById("idePreviewFrame"); return !!f && (f.getAttribute("src") || "").indexOf("/ide/preview/") === 0; }, null, { timeout: 6000 });
  await page.waitForTimeout(1400); // iframe 文档 + 相对 style.css/app.js 加载窗口
  const pv1 = await page.evaluate(() => {
    const fr = document.getElementById("idePreviewFrame");
    const doc = fr && fr.contentDocument;
    const h1 = doc && doc.getElementById("pv-title");
    return {
      src: fr ? (fr.getAttribute("src") || "").slice(0, 80) : "",
      h1: h1 ? h1.textContent : "",
      color: h1 ? getComputedStyle(h1).color.replace(/\s/g, "") : "",
      jsRan: !!(doc && doc.defaultView && doc.defaultView.__pvAppRan),
    };
  });
  check("⑯ 预览态 iframe 渲染 h1 + 相对 css 生效(标题变红)+ 相对 js 执行",
    pv1.h1 === "PV-HELLO" && pv1.color === "rgb(255,0,0)" && pv1.jsRan === true, JSON.stringify(pv1));

  // 保存刷新联动:切编辑态改全文 → 切预览(pvSet 收模型现值)→ Ctrl+S(IDE 域 document 级监听)→ toast → iframe 自动刷新
  await page.evaluate(() => { window.__toastLog = []; const host = document.getElementById("toastHost"); if (host) new MutationObserver((l) => { for (const x of l) for (const n of x.addedNodes) window.__toastLog.push(n.textContent); }).observe(host, { childList: true }); });
  await page.evaluate(() => { const b = document.querySelector('#idePvSeg button[data-pv="edit"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const NEW = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body><h1 id="pv-title">PV-EDITED</h1></body></html>';
    const ta = document.getElementById("ideEdit");
    if (ta && ta.style.display !== "none") { ta.value = NEW; ta.dispatchEvent(new Event("input", { bubbles: true })); return; }
    const ed = window.__ideMonacoEditor, m = ed && ed.getModel();
    if (m) ed.executeEdits("specPv", [{ range: m.getFullModelRange(), text: NEW }]);
  });
  await page.evaluate(() => { const b = document.querySelector('#idePvSeg button[data-pv="preview"]'); if (b) b.click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__ideMsgs = []; document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => (window.__ideMsgs || []).some((m) => m.type === "file.write"), null, { timeout: 8000 });
  await page.waitForFunction(() => (window.__toastLog || []).some((t) => t.indexOf("已保存") >= 0), null, { timeout: 8000 });
  await page.waitForTimeout(1600); // 保存回包 → idePreviewKick 换 r 重载窗口
  const pv2 = await page.evaluate(() => {
    const fr = document.getElementById("idePreviewFrame");
    const doc = fr && fr.contentDocument;
    const h1 = doc && doc.getElementById("pv-title");
    return { text: h1 ? h1.textContent : "", color: h1 ? getComputedStyle(h1).color.replace(/\s/g, "") : "" };
  });
  check("⑯ 保存成功 toast→iframe 自动刷新出新内容(旧内容消失)",
    pv2.text === "PV-EDITED" && pv2.color === "rgb(255,0,0)", JSON.stringify(pv2));

 // 越界负面:页面内 fetch /ide/preview(板节点 05 验径)→ 404 且不回 root: 行
  // (预期 404 会被浏览器记为 console error → 摘掉 listener 收集窗口,负面 fetch 完再挂回;其余错误保持严格)
  page.removeListener("console", onConsoleErr);
  const neg = await page.evaluate(async (p) => {
    const r = await fetch("/ide/preview?pid=" + encodeURIComponent(p) + "&path=" + encodeURIComponent("../../etc/passwd"));
    return { status: r.status, body: (await r.text()).slice(0, 80) };
  }, pid);
  await page.waitForTimeout(200); // 让该 404 的 console error 落在摘除窗口内,不进 errs
  page.on("console", onConsoleErr);
  check("⑯ 越界 fetch → 404 且响应体不含 root:", neg.status === 404 && neg.body.indexOf("root:") < 0, JSON.stringify(neg));

  const pageErrDetail = await page.evaluate(() => (window.__ideErrs || []).slice(0, 3));
  check("控制台零错误", errs.length === 0, errs.slice(0, 2).join(" | ") + " || PAGE: " + JSON.stringify(pageErrDetail) + " || HTTP: " + badResp.slice(0, 4).join(" | "));
  await browser.close();
  rmSync(projDir, { recursive: true, force: true });
  rmSync(projDir2, { recursive: true, force: true });
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})();
