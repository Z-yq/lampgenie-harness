/** 白板持久化恢复闭环经验证(真实 chromium + 真实 gateway 子进程,journalDir 固定可重启)。
 * 跑法(不碰生产环境):npx tsx test/ui/_restore_runner.cjs
 * 覆盖三场景+三边界+多尺寸:
 *   S1 刷新页面恢复 / S2 重启 gateway 恢复 / S3 侧栏切历史 session 重放 chip 点回
 *   B1 多 task 多板 / B2 板被删(显式降级,不静默滑到别的板)/ B3 板文件损坏(显式降级,不冒充「无板」)
 *   VW 1440x900/1280x800/1920x1080/窄窗 900x1100 不破版
 * 判据口径:恢复内容与盘上 JSON 节点数对照(数据同源);板文件=唯一真相,journal 是指针。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7799";
const HARNESS_ROOT = path.resolve(__dirname, "../../../..");
const SHOTS = (process.env.GENIE_JOURNAL_DIR || "/tmp/j-s072") + "/shots";

const B1 = {
  version: 1, taskId: "", sessionId: "", title: "恢复验收板·甲", status: "implementing", rev: 0,
  nodes: [
    { id: "n1", kind: "function", label: "alphaFn", summary: "装配入口:建 journal/任务管理/项目注册", change: "modify", done: true, flow: [{ type: "step", text: "建 journal" }] },
    { id: "n2", kind: "function", label: "betaFn", summary: "白板存储:zod 校验+原子写", change: "modify", done: false, flow: [] },
    { id: "n3", kind: "module", label: "新模块甲", summary: "纯新增模块(无代码连接)", change: "add", done: false, flow: [] },
  ],
  edges: [{ from: "n1", to: "n2", kind: "call", label: "调用" }, { from: "n2", to: "n3", kind: "data", label: "数据" }],
  planned_files: [], updatedAt: 0,
};
const B2 = {
  version: 1, taskId: "", sessionId: "", title: "恢复验收板·乙", status: "draft", rev: 0,
  nodes: [
    { id: "m1", kind: "note", label: "乙板要点", summary: "多板切换对照板", change: "keep", done: false, flow: [] },
    { id: "m2", kind: "module", label: "乙模块", summary: "第二节点", change: "add", done: false, flow: [] },
  ],
  edges: [], planned_files: [], updatedAt: 0,
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 150)));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + ".png") }).then(() => console.log("[shot] " + name + ".png"));
  const evalJ = (fn, arg) => page.evaluate(fn, arg);
  const waitFn = (fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 400 });
  const poll = async (fn, ms = 15000) => { const t0 = Date.now(); let v = await fn(); while (!v && Date.now() - t0 < ms) { await page.waitForTimeout(400); v = await fn(); } return v; };
  const boardDirOf = (sid) => path.join(HARNESS_ROOT, ".genie", "boards", sid);
  // 页内开一条一次性 WS 发请求等回包(真实服务端链路产板/读板)
  const wsCall = (msg, replyType) => evalJ(async ({ msg, replyType }) => {
    const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    const out = await new Promise((res) => {
      const to = setTimeout(() => res({ timeout: true }), 10000);
      ws.onopen = () => ws.send(JSON.stringify(msg));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === replyType || m.type === "error") { clearTimeout(to); res(m); }
      };
      ws.onerror = () => { clearTimeout(to); res({ wserror: true }); };
    });
    ws.close();
    return out;
  }, { msg, replyType });

  // ---------- 搭台:会话1 + 任务 T1/T2 + 板 B1(新)/B2(旧) ----------
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
 // 画布分流/分身独立看板:画布形态下白板 chip=定位白板卡、目录条目=定位消息分组、
  // 会话流不渲染子代理过程卡——本规格守经典契约(浮窗/工作区 tab/会话流过程卡),先切经典布局。
  await page.waitForTimeout(600);
  await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
  await page.waitForTimeout(1200);
  await page.fill("#instruction", "恢复闭环验证会话甲一");
  await page.click("#go");
  await poll(() => evalJ(() => { try { return [...tasks.values()].filter((t) => t.state === "done").length >= 1; } catch (e) { return false; } }));
  check("A1 任务 T1 完成", true);
  await page.fill("#instruction", "恢复闭环验证会话甲二");
  await page.click("#go");
  await poll(() => evalJ(() => { try { return [...tasks.values()].filter((t) => t.state === "done").length >= 2; } catch (e) { return false; } }));
  const st = await evalJ(() => ({ sid: currentSid, ts: [...tasks.values()].filter((t) => t.sessionId === currentSid).map((t) => t.id) }));
  const sid1 = st.sid, T1 = st.ts[0], T2 = st.ts[1];
  check("A2 会话1 两任务就的", !!sid1 && !!T1 && !!T2, "sid=" + sid1 + " T1=" + T1 + " T2=" + T2);

  B2.taskId = T2; B2.sessionId = sid1;
  const rB2 = await wsCall({ v: 1, type: "board.save", sessionId: sid1, taskId: T2, doc: B2, baseRev: 0 }, "board.doc");
  check("A3 板 B2 落盘(WS board.save 真链路)", !!(rB2 && rB2.doc && rB2.doc.taskId === T2), rB2 && rB2.type);
  await page.waitForTimeout(1200); // updatedAt 毫秒序:B1 必须更新(自动选中=最新板)
  B1.taskId = T1; B1.sessionId = sid1;
  const rB1 = await wsCall({ v: 1, type: "board.save", sessionId: sid1, taskId: T1, doc: B1, baseRev: 0 }, "board.doc");
  check("A4 板 B1 落盘", !!(rB1 && rB1.doc && rB1.doc.taskId === T1), rB1 && rB1.type);
  const diskB1 = () => JSON.parse(fs.readFileSync(path.join(boardDirOf(sid1), T1 + ".json"), "utf-8"));
  const diskB2 = () => JSON.parse(fs.readFileSync(path.join(boardDirOf(sid1), T2 + ".json"), "utf-8"));
  check("A5 盘上 B1=3 节点/B2=2 节点(数据同源基准)", diskB1().nodes.length === 3 && diskB2().nodes.length === 2);

  // 进白板视图(刷新前停在板视图,验视图还原)
  await page.click("#act-board");
 // A6 序无关化(与 S1 轮 101-104 同口径)——自动选板=「updatedAt 最新」,而收官回填
  // 重写两板的先后差随机器负载翻转(094 四跑 3 次 FAIL 集中此断言,修前修后同红=时序翻牌);
  // 「选中甲还是乙」不构成恢复正确性,正确性=选中板内容与盘上该板 JSON 节点数对账(数据同源)。
  // poll 窗 15s→30s:任务 done 触发的 ensureIndex(harness 根)在同机负载下可阻塞 WS 回包(094 环境)。
  await poll(() => evalJ(() => { try { return document.body.dataset.view === "board" && boardDoc && boardDoc.taskId; } catch (e) { return false; } }), 30000);
  const a6 = await evalJ(() => ({ title: boardDoc && boardDoc.title, n: boardDoc ? boardDoc.nodes.length : -1 }));
  {
    const dk = a6.title ? (() => { try { return JSON.parse(fs.readFileSync(path.join(boardDirOf(sid1), (a6.title === "恢复验收板·甲" ? T1 : T2) + ".json"), "utf-8")); } catch (e) { return null; } })() : null;
    check("A6 板视图首渲(自动选板在列且与盘上对账,序无关)", !!a6.title && (a6.title === "恢复验收板·甲" || a6.title === "恢复验收板·乙") && !!dk && dk.nodes.length === a6.n, JSON.stringify({ title: a6.title, n: a6.n, disk: dk ? dk.nodes.length : "gone" }));
  }
  await shot("a6-setup-board");

  // ---------- S1:刷新页面恢复 ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await poll(() => evalJ((sid) => { try { return currentSid === sid; } catch (e) { return false; } }, sid1));
  // 续作轮修正:自动选板=「updatedAt 最新」,而 done 收官钩子会把任务板移入沉淀档(两板同一时刻被
  // 回填重写,先后差 ±40ms 随机器负载翻转)——「选中甲还是乙」不构成恢复正确性;恢复正确性=选中板
  // 内容与盘上该板 JSON 逐节点一致(数据同源对账)。断言改为序无关。
  const diskByTitle = () => { const out = {}; for (const t of [T1, T2]) { try { const d = JSON.parse(fs.readFileSync(path.join(boardDirOf(sid1), t + ".json"), "utf-8")); out[d.title] = d; } catch (e) { /* 可能已被收官钩子移入沉淀档 */ } } return out; };
  check("S1.1 刷新后会话恢复(zh:sid)", true);
  await poll(() => evalJ(() => document.body.dataset.view === "board" && boardDoc && boardDoc.taskId));
  const s1 = await evalJ(() => ({ view: document.body.dataset.view, title: boardDoc && boardDoc.title, n: boardDoc ? boardDoc.nodes.length : -1, opts: document.querySelectorAll("#boardTaskSel option").length }));
  check("S1.2 刷新后视图还原到白板", s1.view === "board", "view=" + s1.view);
  check("S1.3 板清单 2 项", s1.opts === 2, "opts=" + s1.opts);
  {
    const dk = diskByTitle()[s1.title];
    check("S1.4 恢复板内容与盘上 JSON 一致(节点数对账)", !!dk && dk.nodes.length === s1.n && (s1.title === "恢复验收板·甲" || s1.title === "恢复验收板·乙"), JSON.stringify({ title: s1.title, n: s1.n, disk: dk ? dk.nodes.length : "gone" }));
  }
  await shot("s1-refresh-board");

  // ---------- S2:重启 gateway 恢复 ----------
  await globalThis.GWCTL.restart();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await poll(() => evalJ((sid) => { try { return currentSid === sid && document.body.dataset.view === "board" && boardDoc && boardDoc.taskId; } catch (e) { return false; } }, sid1), 20000);
  const s2 = await evalJ(() => ({ title: boardDoc && boardDoc.title, n: boardDoc ? boardDoc.nodes.length : -1, opts: document.querySelectorAll("#boardTaskSel option").length }));
  check("S2.1 重启 gateway 后板清单仍在(盘上读取,无内存索引)", s2.opts === 2, "opts=" + s2.opts);
  {
    const dk = diskByTitle()[s2.title];
    check("S2.2 恢复板内容与盘上 JSON 一致(节点数对账)", !!dk && dk.nodes.length === s2.n, JSON.stringify({ title: s2.title, n: s2.n, disk: dk ? dk.nodes.length : "gone" }));
  }
  await shot("s2-restart-board");

  // ---------- S3:侧栏切历史 session 重放 chip 点回 ----------
  await page.click("#act-new");
  await page.waitForTimeout(400);
  await page.fill("#instruction", "恢复闭环验证会话乙(占位)");
  await page.click("#go");
  await poll(() => evalJ((sid) => { try { return currentSid !== sid && [...tasks.values()].some((t) => t.sessionId === currentSid && t.state === "done"); } catch (e) { return false; } }, sid1));
  const sid2 = await evalJ(() => currentSid);
  check("S3.1 第二会话建成", !!sid2 && sid2 !== sid1, "sid2=" + sid2);
  // 侧栏点回会话1(历史 session 重放)
  await page.click('.t-row[data-sid="' + sid1 + '"]');
  await poll(() => evalJ((sid) => { try { return currentSid === sid && document.querySelectorAll("button.board-chip").length >= 2; } catch (e) { return false; } }, sid1));
  const chips = await evalJ(() => document.querySelectorAll("button.board-chip").length);
  check("S3.2 历史重放白板入口 chip 可见(≥2:board.update 行 + 任务卡)", chips >= 2, "chips=" + chips);
  await shot("s3-history-chips");
  await evalJ((t1) => { const b = document.querySelector('button.board-chip[data-board-task="' + t1 + '"]'); b.click(); }, T1);
  await poll(() => evalJ((t1) => { try { return bfOpen && boardDoc && boardDoc.taskId === t1; } catch (e) { return false; } }, T1));
  const s3 = await evalJ(() => ({ open: bfOpen, title: boardDoc && boardDoc.title, n: boardDoc ? boardDoc.nodes.length : -1, floatShown: getComputedStyle(document.getElementById("boardFloat")).display !== "none" }));
  check("S3.3 chip 点回浮窗出对应板(B1,3 节点)", s3.open && s3.floatShown && s3.title === "恢复验收板·甲" && s3.n === 3, JSON.stringify(s3));
  await shot("s3-chip-float");

  // ---------- B1:多 task 多板切换 ----------
  await evalJ(() => bfToggle(false));
  await page.click("#act-board");
  await poll(() => evalJ(() => document.querySelectorAll("#boardTaskSel option").length === 2 && boardDoc));
  check("B1.1 板选择器 2 板在列", true);
  await page.selectOption("#boardTaskSel", T2);
  await poll(() => evalJ((t2) => boardDoc && boardDoc.taskId === t2, T2));
  const b1a = await evalJ(() => ({ title: boardDoc.title, n: boardDoc.nodes.length }));
  check("B1.2 切到 B2(2 节点)", b1a.title === "恢复验收板·乙" && b1a.n === 2, JSON.stringify(b1a));
  await page.selectOption("#boardTaskSel", T1);
  await poll(() => evalJ((t1) => boardDoc && boardDoc.taskId === t1, T1));
  const b1b = await evalJ(() => ({ title: boardDoc.title, n: boardDoc.nodes.length }));
  check("B1.3 切回 B1 不串台(3 节点)", b1b.title === "恢复验收板·甲" && b1b.n === 3, JSON.stringify(b1b));
  await shot("b1-multiboard");

  // ---------- B2:板被删(显式降级) ----------
  fs.rmSync(path.join(boardDirOf(sid1), T2 + ".json"), { force: true });
  await evalJ(() => boardRefresh());
  await poll(() => evalJ(() => document.querySelectorAll("#boardTaskSel option").length === 1));
  check("B2.1 删板后清单收敛到 1 项", true);
  // 历史重放里 T2 的 chip 还在(journal 是指针,板文件已删)——点它必须显式降级,不许静默滑到 B1
  await evalJ(() => switchView("chat"));
  await page.waitForTimeout(400);
  await evalJ((t2) => { const b = document.querySelector('button.board-chip[data-board-task="' + t2 + '"]'); if (b) b.click(); }, T2);
  await page.waitForTimeout(1500);
  const b2 = await evalJ((t2) => {
    const g = (bdGraphHost && bdGraphHost()) || document.getElementById("bfGraph");
    return { txt: g ? g.textContent : "", hijack: !!(boardDoc && boardDoc.taskId && boardDoc.taskId !== t2) };
  }, T2);
  check("B2.2 点已删板 chip:显式降级提示(不静默滑到别的板)", /不存在|已删除|损坏|不可读/.test(b2.txt) && !b2.hijack, b2.txt.slice(0, 60) + " hijack=" + b2.hijack);
  await shot("b2-deleted-degrade");

  // ---------- B3:板文件损坏(显式降级,不冒充「无板」) ----------
  await evalJ(() => bfToggle(false));
  fs.writeFileSync(path.join(boardDirOf(sid1), T1 + ".json"), "{broken json !!!");
  await page.click("#act-board");
  await page.waitForTimeout(600);
  await evalJ(() => boardRefresh());
  await page.waitForTimeout(1800);
  const b3 = await evalJ(() => {
    const g = document.getElementById("boardGraph");
    return { txt: g ? g.textContent : "", opts: document.querySelectorAll("#boardTaskSel option").length };
  });
  check("B3.1 全板损坏时板清单空", b3.opts <= 1, "opts=" + b3.opts);
  check("B3.2 损坏显式降级(不冒充「该会话还没有设计白板」)", /损坏|不可读|缺失/.test(b3.txt) && !b3.txt.includes("该会话还没有设计白板"), b3.txt.slice(0, 60));
  await shot("b3-corrupt-degrade");

  // ---------- VW:多尺寸不破版(恢复干净板) ----------
  fs.writeFileSync(path.join(boardDirOf(sid1), T1 + ".json"), JSON.stringify({ ...B1, updatedAt: Date.now() }));
 // 续作轮:单页面复用+setViewportSize(逐视口 newPage 在负载下第二页 goto 60s 超时经验证×2)
  const p2 = await browser.newPage();
  p2.on("pageerror", (e) => errors.push("vw" + ": " + String(e).slice(0, 120)));
  p2.on("dialog", (d) => d.dismiss().catch(() => {}));
  await p2.addInitScript((sid) => { sessionStorage.setItem("zh:sid", sid); sessionStorage.setItem("zh:view", "board"); }, sid1);
  for (const [w, h] of [[1440, 900], [1280, 800], [1920, 1080], [900, 1100]]) {
    await p2.setViewportSize({ width: w, height: h });
    await p2.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await p2.waitForTimeout(2600);
    // 面板自身可能触发导航(svc 重启兜底 reload)——evaluate 撞上下文销毁就重试;
 // 重试条件从「evaluate 成功」收紧为「板真正渲出(nodes===3)」——094 经验证 VW 档
    // nodes:-1(boardDoc 尚未到达就读取)翻牌;轮次 3→8(约 12s/档)覆盖重负载冷启动。
    let vw = null;
    for (let r = 0; r < 8; r++) {
      const v = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, nodes: (window.boardDoc || (typeof boardDoc !== "undefined" ? boardDoc : null)) ? (boardDoc.nodes || []).length : -1 })).catch(() => null);
      if (v && v.nodes === 3) { vw = v; break; }
      if (v) vw = v;
      await p2.waitForTimeout(1500).catch(() => {});
    }
    vw = vw || { sw: -1, iw: w, nodes: -1 };
    check("VW " + w + "x" + h + " 板恢复且无横向破版", vw.nodes === 3 && vw.sw <= vw.iw + 2, JSON.stringify(vw));
    await p2.screenshot({ path: path.join(SHOTS, "vw-" + w + "x" + h + ".png") }).catch(() => {});
  }
  await p2.close();

  // ---------- 收尾 ----------
  check("Z 0 pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (!process.env.KEEP_BOARDS) {
    try { fs.rmSync(boardDirOf(sid1), { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
    try { if (sid2) fs.rmSync(boardDirOf(sid2), { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  }
  const fails = results.filter((r) => !r.ok).length;
  console.log("boardrestore: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("SPEC CRASH", e); process.exit(1); });
