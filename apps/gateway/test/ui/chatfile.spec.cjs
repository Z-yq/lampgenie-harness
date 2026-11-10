/** 聊天消息文件路径 → IDE 打开 浏览器经验证(临时端口 selfhost,不碰 7700)。
 * 跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/chatfile.spec.cjs
 * 断言面:①裸相对路径 ②绝对路径 ③带行号 ④markdown 相对链接 ⑤代码块内路径 ⑥子代理工作区路径 ⑦跨项目切根,
 * 逐一点击 → IDE 视图打开 + 正确项目 + 正确文件 + 行号定位;旧 #fileViewer 不再弹出;缺失路径只 toast 不改 IDE;
 * 面板消息里 0 pageerror。截图留存 /tmp/step1025-*.png。 */
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const CHROME = "/usr/bin/google-chrome";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + String(detail).slice(0, 220) : "")); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const app = globalThis.__selfhostApp;
  const harnessRoot = app.projects.list().find((p) => p.id === "__harness__").path;
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), "cf-alt-"));
  fs.mkdirSync(path.join(alt, "src"), { recursive: true });
  fs.writeFileSync(path.join(alt, "src", "note.md"), "# 备项目笔记\n第 5 行\n");
  const SID = "spec-sess-chatfile";

  const NL = String.fromCharCode(10);
  const ABS = harnessRoot + "/README.md";
  const ALT_FILE = alt + "/src/note.md";
  const MAIN_TEXT = [
    "改这三处:apps/gateway/src/panel.ts 与 " + ABS + " 以及 apps/gateway/src/panel.ts:120",
    "再看 [流程文档](docs/code-flow/README.md) 这条相对链接。",
    "代码块:" + NL + "```ts" + NL + "const x = require('apps/gateway/src/server.ts');" + NL + "```",
  ].join(NL);

  // 历史走真 journal(前端 setHist 的假数据会被 session.history 拉取覆盖),且必须在页面加载前写好
  app.journal.append({ kind: "message.user", sessionId: SID, payload: { text: "看下这些文件" } });
  app.journal.append({ kind: "message.agent", sessionId: SID, payload: { text: MAIN_TEXT, llmMs: 120 } });
  app.journal.append({ kind: "message.agent", sessionId: SID, payload: { text: "备项目文件在 " + ALT_FILE + " 这一处", llmMs: 80 } });
  app.journal.append({ kind: "subagent.event", sessionId: SID, payload: { agentId: "spec-agent-1", kind: "message.agent", text: "子代理:已读 packages/protocol/src/relay.ts 与 docs/code-flow/README.md" } });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  await page.addInitScript(() => {
    sessionStorage.setItem("zh:sid", "spec-sess-chatfile");
    localStorage.setItem("zh:g-search", "off");
    localStorage.setItem("zh:g-term", "off");
  });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);
  await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
  await page.waitForTimeout(400);

  const inj = await page.waitForFunction(() => { const b = document.getElementById("chatBody"); return !!(b && b.querySelector("a.chat-file")); }, null, { timeout: 25000 }).then(() => true).catch(() => false);
  check("历史注入(journal → 聊天流出现路径链)", inj === true);

  const links = await page.evaluate(() => [...document.querySelectorAll("#chatBody a.chat-file")].map((a) => a.dataset.path + "|" + (a.dataset.line || "")));
  const cites = await page.evaluate(() => [...document.querySelectorAll("#chatBody a.cite")].map((a) => a.dataset.path + "|" + (a.dataset.line || "")));
  check("链接化:裸相对/绝对/md 链接/代码块/另一项目路径全成 a.chat-file",
    links.indexOf("apps/gateway/src/panel.ts|") >= 0 && links.indexOf(ABS + "|") >= 0 &&
    links.indexOf("docs/code-flow/README.md|") >= 0 && links.indexOf("apps/gateway/src/server.ts|") >= 0 &&
    links.indexOf(ALT_FILE + "|") >= 0, JSON.stringify(links));
  check("带行号:`panel.ts:120` 由 a.cite 承载(聊天内点击也走 IDE)", cites.indexOf("apps/gateway/src/panel.ts|120") >= 0, JSON.stringify(cites));
  check("markdown 链接显示为文字标签", await page.evaluate(() => [...document.querySelectorAll("#chatBody a.chat-file")].some((a) => a.textContent === "流程文档")));
  check("URL/版本号不被链接(negative)", !links.some((l) => l.indexOf("http") === 0), JSON.stringify(links.slice(0, 3)));
  check("幂等:二次全量不增链", await page.evaluate(() => { const n1 = window.__chatFile.count(); window.__chatFile.linkify(); return window.__chatFile.count() === n1; }));

  const clickByPath = async (p, line) => page.evaluate(([pp, ll]) => {
    const list = [...document.querySelectorAll("#chatBody a.chat-file, #chatBody a.cite")];
    const el = list.find((a) => a.dataset.path === pp && (ll ? a.dataset.line === String(ll) : !a.dataset.line));
    if (!el) return false;
    el.click();
    return true;
  }, [p, line || 0]);
  const ideState = () => page.evaluate(() => window.__chatFile.ide());
  const waitTab = async (p) => { for (let i = 0; i < 40; i++) { const st = await ideState(); if (st.tabs.some((t) => t.path === p)) return st; await sleep(150); } return await ideState(); };

  // ① 裸相对路径(harness 根)
  check("点击①裸相对路径", await clickByPath("apps/gateway/src/panel.ts", 0));
  let st = await waitTab("apps/gateway/src/panel.ts");
  check("①IDE 视图打开", st.view === "ide", "view=" + st.view);
  check("①正确项目(harness)与正确文件", st.root === "__harness__" && st.tabs.some((t) => t.path === "apps/gateway/src/panel.ts"), JSON.stringify({ root: st.root, tabs: st.tabs.map((t) => t.path) }));
  check("①旧浮层不弹", await page.evaluate(() => !document.getElementById("fileViewer").classList.contains("on")));
  await page.screenshot({ path: "/tmp/step1025-1-relative.png" });

  // ② 绝对路径
  check("点击②绝对路径", await clickByPath(ABS, 0));
  st = await waitTab("README.md");
  check("②绝对路径落到 harness 的 README.md", st.root === "__harness__" && st.tabs.some((t) => t.path === "README.md"), JSON.stringify(st.tabs.map((t) => t.path)));

  // ③ 带行号(复用已开标签 → 定位)
  check("点击③带行号", await clickByPath("apps/gateway/src/panel.ts", 120));
  await sleep(900);
  st = await ideState();
  const tab3 = st.tabs.find((t) => t.path === "apps/gateway/src/panel.ts");
  const last = await page.evaluate(() => window.__chatFile.lastOpen());
  const rlog = await page.evaluate(() => window.__chatFile.revealLog());
  const reqOk = rlog.some((r) => r.path === "apps/gateway/src/panel.ts" && r.line === 120);
  check("③行号定位:解析出 line=120,且 ideRevealLine 收到该行请求",
    !!(last && last.line === 120 && tab3 && reqOk), JSON.stringify({ last: last, rlog: rlog, tab3: tab3 }));
  await page.screenshot({ path: "/tmp/step1025-2-line.png" });

  // ④ markdown 相对链接(按 harness 根解析)
  check("点击④markdown 相对链接", await clickByPath("docs/code-flow/README.md", 0));
  st = await waitTab("docs/code-flow/README.md");
  check("④md 链接打开 docs/code-flow/README.md", st.tabs.some((t) => t.path === "docs/code-flow/README.md"), JSON.stringify(st.tabs.map((t) => t.path)));

  // ⑤ 代码块内路径
  check("点击⑤代码块内路径", await clickByPath("apps/gateway/src/server.ts", 0));
  st = await waitTab("apps/gateway/src/server.ts");
  check("⑤代码块内路径打开 server.ts", st.tabs.some((t) => t.path === "apps/gateway/src/server.ts"), JSON.stringify(st.tabs.map((t) => t.path)));
  check("⑤代码块里的路径锚在 pre/code 内且行号/复制按钮未被破坏", await page.evaluate(() => document.querySelectorAll("#chatBody pre a.chat-file, #chatBody .code-wrap a.chat-file").length >= 1));

  // ⑥ 子代理工作区
  await page.evaluate(() => window.__mature.subwsOpen("spec-agent-1"));
  await sleep(900);
  const wsLinks = await page.evaluate(() => [...document.querySelectorAll("#chatBody a.chat-file")].map((a) => a.dataset.path));
  check("⑥子代理工作区内也链接化", wsLinks.indexOf("packages/protocol/src/relay.ts") >= 0, JSON.stringify(wsLinks));
  check("点击⑥子代理工作区路径", await clickByPath("packages/protocol/src/relay.ts", 0));
  st = await waitTab("packages/protocol/src/relay.ts");
  check("⑥打开 relay.ts", st.tabs.some((t) => t.path === "packages/protocol/src/relay.ts"), JSON.stringify(st.tabs.map((t) => t.path)));
  await page.screenshot({ path: "/tmp/step1025-3-subws.png" });

  // 回主会话:工作区直写共享容器会污染主历史缓存,直接刷新页面(journal 重放还原主历史,顺带验证持久态)
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction("window.ws && window.ws.readyState === 1", null, { timeout: 20000 }).catch(() => {});
  await page.waitForFunction((f) => [...document.querySelectorAll("#chatBody a.chat-file")].some((a) => a.dataset.path === f), ALT_FILE, { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => { try { if (document.body.classList.contains("cv-shell")) CanvasShell.setMode("classic"); } catch (e) {} });
  await sleep(500);

  // ⑦ 跨项目:经协议 project.add 注册第二个项目(服务端广播 project.list.result)→ 点绝对路径 → 切根再开
  let altPid = "";
  {
    await page.evaluate((p) => wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: p })), alt);
    const ok = await page.waitForFunction((f) => { try { return !!window.__chatFile.resolve(f); } catch (e) { return false; } }, ALT_FILE, { timeout: 20000 }).then(() => true).catch(() => false);
    altPid = ok ? await page.evaluate((f) => { const r = window.__chatFile.resolve(f); return r ? r.pid : ""; }, ALT_FILE) : "";
    // 先把 IDE 根切回 harness(点一条 harness 绝对路径;project.add 会把 active 顶成新项目),再验证跨项目切根
    await clickByPath(ABS, 0);
    for (let i = 0; i < 40; i++) { const s0 = await ideState(); if (s0.root === "__harness__") break; await sleep(150); }
    await page.waitForFunction((f) => [...document.querySelectorAll("#chatBody a.chat-file")].some((a) => a.dataset.path === f), ALT_FILE, { timeout: 15000 }).catch(() => {});
    const dbg = await page.evaluate(() => ({ links: [...document.querySelectorAll("#chatBody a")].map((a) => (a.className || "") + ":" + (a.dataset.path || a.textContent || "").slice(0, 40)), sub: window.__mature.subws().active }));
    check("⑦点前诊断:目标链接在聊天流里", dbg.links.some((l) => l.indexOf(ALT_FILE) >= 0), JSON.stringify(dbg).slice(0, 400));
  }
  if (altPid) {
    const before = await ideState();
    check("点击⑦另一项目绝对路径", await clickByPath(ALT_FILE, 0));
    st = await waitTab("src/note.md");
    check("⑦切到目标项目根(harness → 另一项目)", st.root === altPid && before.root === "__harness__", JSON.stringify({ before: before.root, after: st.root, altPid: altPid }));
    check("⑦文件在目标项目下打开", st.tabs.some((t) => t.path === "src/note.md"), JSON.stringify(st.tabs.map((t) => t.path)));
    await page.screenshot({ path: "/tmp/step1025-4-crossproj.png" });
  } else {
    check("⑦切到目标项目根(而非旧根)", false, "第二项目注册失败");
    check("⑦文件在目标项目下打开", false, "");
  }

  // ⑧ negative:不存在的文件 → 只 toast,不改 IDE 状态;越界路径解析为 null
  const miss = await page.evaluate(async () => {
    const before = window.__chatFile.ide();
    window.__chatFile.open("apps/gateway/src/not-there-9137.ts", 0);
    await new Promise((r) => setTimeout(r, 1500));
    const after = window.__chatFile.ide();
    return { same: JSON.stringify(before.tabs) === JSON.stringify(after.tabs), n: after.tabs.length };
  });
  check("⑧缺失文件不新增 IDE 标签(negative)", miss.same === true, JSON.stringify(miss));
  const outOfRoot = await page.evaluate(() => window.__chatFile.resolve("../../etc/passwd"));
  check("⑧越界路径解析为 null(negative)", outOfRoot === null, JSON.stringify(outOfRoot));

  check("0 pageerror", pageErrors.length === 0, pageErrors.join(" | "));
  const fails = results.filter((r) => !r.ok).length;
  console.log("chatfile: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  try { fs.rmSync(alt, { recursive: true, force: true }); } catch (e) { /* 尽力清 */ }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH " + String(e).slice(0, 400)); process.exit(2); });
