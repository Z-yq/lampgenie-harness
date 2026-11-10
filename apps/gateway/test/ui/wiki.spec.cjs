/** step-118 repo wiki(并入代码档案)面板实测:结构/文件钻取/Wiki 三 tab、导航/正文/引用回源/
 * 模块页→结构 tab、引用→文件钻取跳转链、依赖图 mermaid、多尺寸布局、缓存命中、0 pageerror。
 * 跑法:cd apps/gateway && NODE_OPTIONS=--conditions=development npx tsx test/ui/_ui_selfhost.cjs test/ui/wiki.spec.cjs */
const { chromium } = require("playwright-core");
const { mkdirSync } = require("node:fs");
const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";
const OUT = process.env.WIKI_SHOTS || "/tmp/step118-shots";

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 180)));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !t.includes("WebSocket") && !t.includes("Notification")) errors.push(t.slice(0, 180));
  });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  // 产品口径:wiki 并入代码档案,不再有独立一级视图/侧栏入口
  check("无独立 wiki 侧栏入口", (await page.locator("#act-wiki").count()) === 0 && (await page.locator("#view-wiki").count()) === 0);
  await page.evaluate(() => openProfileEntry());
  await page.locator("#view-project.on").waitFor({ timeout: 8000 });
  const tabs = await page.locator("#ppTabs .pp-tab").count();
  // step-131:总路线并入代码档案 → 四 tab(结构/总路线/文件钻取/Wiki)
  check("代码档案四 tab(结构/总路线/文件钻取/Wiki)", tabs === 4, tabs + " 个");
  check("总路线 tab 在位", (await page.locator('#ppTabs .pp-tab[data-ptab="roadmap"]').count()) === 1);
  check("默认结构 tab", await page.locator("#ppTab-structure.on").count() === 1);

  await page.locator('#ppTabs .pp-tab[data-ptab="wiki"]').click();
  await page.locator("#ppTab-wiki.on").waitFor({ timeout: 5000 });
  check("切到 Wiki tab(结构 pane 隐藏)", (await page.locator("#ppTab-structure.on").count()) === 0);

  // 等 list 回执(按钮由 disabled 变可用),避免清单未到时误触重建
  await page.waitForFunction(() => !document.getElementById("wikiRebuild").disabled, null, { timeout: 20000 });
  let pages = await page.locator("#wikiNav .wiki-page").count();
  if (pages === 0) {
    console.log("[wiki] 无 manifest,触发重建(确定性骨架)…");
    await page.click("#wikiRebuild");
    await page.locator("#wikiNav .wiki-page").first().waitFor({ timeout: 180000 });
    pages = await page.locator("#wikiNav .wiki-page").count();
  }
  check("页导航渲染", pages >= 5, pages + " 页");
  const groups = await page.locator("#wikiNav .wiki-group").count();
  check("导航分组(概览/结构/模块/入口/依赖图)", groups >= 4, groups + " 组");
  const meta = await page.locator("#wikiMeta").textContent();
  check("wiki manifest 摘要(repo/页数/git/引用)", !!meta && meta.includes("页") && meta.includes("引用"), String(meta).slice(0, 120));

  await page.locator("#wikiMd h3").first().waitFor({ timeout: 10000 });
  const h1 = await page.locator("#wikiMd h3").first().textContent();
  check("正文渲染(概览标题)", !!h1 && h1.includes("仓库概览"), String(h1));
  const cites = await page.locator("#wikiMd a.cite").count();
  check("引用自动变可点击(≥5)", cites >= 5, cites + " 处");

  // 结构 ↔ Wiki tab 往返(内容保持可重载)
  await page.locator('#ppTabs .pp-tab[data-ptab="structure"]').click();
  check("tab 切回结构", (await page.locator("#ppTab-structure.on").count()) === 1 && (await page.locator("#ppTab-wiki.on").count()) === 0);
  await page.locator('#ppTabs .pp-tab[data-ptab="wiki"]').click();
  await page.locator("#wikiMd h3").first().waitFor({ timeout: 10000 });
  check("tab 切回 Wiki 且正文重载", (await page.locator("#ppTab-wiki.on").count()) === 1);

  // 模块页 → 结构 tab 对应模块
  const modRow = page.locator('#wikiNav .wiki-page[data-page^="modules/"]').first();
  if (await modRow.count()) {
    await modRow.click();
    await page.waitForFunction(() => { const t = document.getElementById("wikiPageTitle").textContent || ""; return t.indexOf("模块 ") === 0; }, null, { timeout: 10000 });
    const jumpVisible = await page.locator("#wikiToStructure").isVisible();
    check("模块页出现「在结构中查看」", jumpVisible, await page.locator("#wikiToStructure").textContent());
    await page.click("#wikiToStructure");
    check("模块页→结构 tab", (await page.locator("#ppTab-structure.on").count()) === 1);
    await page.locator('#ppTabs .pp-tab[data-ptab="wiki"]').click();
    await page.locator("#wikiMd h3").first().waitFor({ timeout: 10000 });
  } else {
    check("模块页存在", false);
  }

  // 引用点击回源 → 文件查看器 → 「文件钻取」跳转链
  await page.locator('#wikiNav .wiki-page[data-page="overview"]').click();
  await page.locator("#wikiMd a.cite").first().waitFor({ timeout: 10000 });
  const first = page.locator("#wikiMd a.cite").first();
  const dataPath = await first.getAttribute("data-path");
  const dataLine = await first.getAttribute("data-line");
  await first.click();
  await page.locator("#fileViewer.on").waitFor({ timeout: 5000 });
  await page.locator("#fvBody .fv-line").first().waitFor({ timeout: 5000 });
  const hl = await page.locator("#fvBody .fv-line.hl .ln").textContent();
  check("引用点击打开文件查看器并定位行", hl === dataLine, dataPath + ":" + dataLine + " → hl=" + hl);
  check("查看器露出「文件钻取」", await page.locator("#fvDrill").isVisible());
  await page.click("#fvDrill");
  check("引用→文件钻取 tab", (await page.locator("#ppTab-files.on").count()) === 1);
  await page.locator('#ppTabs .pp-tab[data-ptab="wiki"]').click();
  await page.locator("#wikiMd h3").first().waitFor({ timeout: 10000 });

  // 依赖图页:mermaid 已渲染成 svg
  const depRow = page.locator('#wikiNav .wiki-page[data-page="dependencies"]');
  if (await depRow.count()) {
    await depRow.click();
    const svgSeen = await page.locator("#wikiMd .md-mermaid svg").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check("依赖图页导航", (await page.locator("#wikiPageTitle").textContent()) === "依赖图", await page.locator("#wikiPageTitle").textContent());
    check("依赖图 mermaid 渲染", svgSeen, svgSeen ? "已出图" : "15s 未出 svg");
    const svg = await page.locator("#wikiMd .md-mermaid svg").count();
    const nodes = await page.locator("#wikiMd .md-mermaid svg .node").count();
    check("依赖图有节点", nodes >= 1, svg + " 个 svg / " + nodes + " 节点");
  } else {
    check("依赖图页存在", false, "未找到 dependencies 页");
  }

  // 多尺寸截图(档案内 wiki tab:导航/正文/图)
  for (const size of [[1440, 900], [1280, 800], [1920, 1080], [1024, 800]]) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await page.waitForTimeout(350);
    const layout = await page.evaluate(() => {
      const nav = document.getElementById("wikiNav");
      const md = document.getElementById("wikiMd");
      const view = document.getElementById("view-project");
      return {
        navW: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
        mdW: md ? Math.round(md.getBoundingClientRect().width) : 0,
        viewW: view ? Math.round(view.getBoundingClientRect().width) : 0,
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    check("布局 " + size[0] + "x" + size[1] + "(导航/正文非零宽,无横溢)", layout.navW > 100 && layout.mdW > 300 && layout.overflowX <= 2, JSON.stringify(layout));
    await page.screenshot({ path: OUT + "/wiki-in-project-" + size[0] + "x" + size[1] + ".png", fullPage: false });
  }

  // 缓存命中:连续两次 rebuild(第一发对齐当前源码,第二发必须 sha/指纹/LLM 模式命中)
  await page.evaluate(() => {
    window.__wikiLog = [];
    window.__wikiRebuildResults = [];
    const prev = ws.onmessage;
    ws.onmessage = function(ev) {
      try {
        const m = JSON.parse(ev.data);
        if (String(m.type || "").indexOf("wiki") === 0) window.__wikiLog.push({ t: Date.now(), type: m.type, pageId: m.pageId || "", hit: m.hit });
        if (m.type === "wiki.rebuild.result") window.__wikiRebuildResults.push(m);
      } catch (e) { /* ignore */ }
      if (prev) return prev.call(ws, ev);
    };
  });
  await page.evaluate(() => ws.send(JSON.stringify({ v: 1, type: "wiki.rebuild" })));
  const firstDone = await page.waitForFunction(() => (window.__wikiLog || []).filter((x) => x.type === "wiki.rebuild.result").length >= 1, null, { timeout: 120000 }).then(() => true).catch(() => false);
  await page.evaluate(() => ws.send(JSON.stringify({ v: 1, type: "wiki.rebuild" })));
  const secondDone = await page.waitForFunction(() => (window.__wikiLog || []).filter((x) => x.type === "wiki.rebuild.result").length >= 2, null, { timeout: 120000 }).then(() => true).catch(() => false);
  const hit = await page.evaluate(() => (window.__wikiRebuildResults || []).slice(-1)[0] || null);
  check("连续两次重建均有回执", firstDone && secondDone, "first=" + firstDone + " second=" + secondDone);
  check("二次重建命中缓存(hit=true/零 LLM)", !!hit && hit.hit === true && hit.llmCalls === 0, hit ? JSON.stringify({ hit: hit.hit, reason: hit.reason, llmCalls: hit.llmCalls }) : "无回执");

  check("控制台无 pageerror", errors.length === 0, errors.slice(0, 2).join(" | "));
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error("WIKI SPEC CRASH", e); process.exit(1); });
