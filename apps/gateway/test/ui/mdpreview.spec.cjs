/** UI 经验证:IDE Markdown 预览的图/视频/链接渲染 + 阅读密度。
 *  跑法:cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/mdpreview.spec.cjs
 *  覆盖:①md 标签默认进预览层 ②相对图重写 /ide/asset 且真解码(naturalWidth>0)
 *  ③外链图原样 ④视频产 <video> 且字节路由 200+video/mp4 ⑤相对链接 data-ide-mdlink 点击开新标签
 *  ⑥页内 #锚点 href 保留 ⑦表格外包 .md-table-wrap(宽表不压列宽)+ 单元格内边距
 *  ⑧阅读密度:行高 / 段距 / 列表缩进 / 列表项间距。 */
const { chromium } = require("playwright-core");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const BASE = process.env.PANEL_BASE || "http://127.0.0.1:7716";

(async () => {
  const projDir = mkdtempSync(join(tmpdir(), "mdprev-"));
  mkdirSync(join(projDir, "docs", "imgs"), { recursive: true });
  mkdirSync(join(projDir, "docs", "sub"), { recursive: true });
  // 真图:用 SVG(固有尺寸 320x180,浏览器按属性解码 → naturalWidth>0;比 1x1 PNG 更能看排版)
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#c98f45"/><circle cx="160" cy="90" r="60" fill="#0d0a07"/><text x="160" y="96" fill="#ece1d1" font-size="16" text-anchor="middle">shot.svg</text></svg>';
  writeFileSync(join(projDir, "docs", "imgs", "shot.svg"), SVG, "utf-8");
  writeFileSync(join(projDir, "docs", "imgs", "clip.mp4"), Buffer.alloc(256, 7)); // 扩展名决定服务端 content-type
  writeFileSync(join(projDir, "docs", "sub", "linked.md"), "# 被链接的文件\n\nLINKED-OK\n", "utf-8");
  writeFileSync(join(projDir, "docs", "README.md"), [
    "# 预览验证 README",
    "",
    "正文段落一,验证段距。",
    "",
    "## 媒体",
    "",
    "![相对图](imgs/shot.svg)",
    "",
    "![父级图](../docs/imgs/shot.svg)",
    "",
    "![外链图](https://example.com/x.png)",
    "",
    "![演示视频](imgs/clip.mp4)",
    "",
    "## 链接",
    "",
    "- [相对链接](sub/linked.md)",
    "- [页内锚点](#媒体)",
    "- [外链](https://example.com/)",
    "",
    "## 表格",
    "",
    "| 模块 | 职责 | 说明 |",
    "| --- | --- | --- |",
    "| 接入层 | 推送协议解析与鉴权 | 三段式:接入 / 鉴权 / 入队;每段都有独立的错误码与重试策略 |",
    "| 原子层 | 切帧、看画面、听转写 | 统一记忆单元输出 |",
    "| 业务层 | 事件、日报、画像 | 按授权对外 |",
    "",
  ].join("\n"), "utf-8");

  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String((e && e.message) || e).slice(0, 200)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + String(m.text()).slice(0, 200)); });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof ws !== "undefined" && ws.readyState === 1, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate((dir) => ws.send(JSON.stringify({ v: 1, type: "project.add", path: dir })), projDir);
  await page.waitForTimeout(1200);

  // 进 IDE 视图并打开 README.md(直接走生产函数,不依赖树点击)
  await page.evaluate(() => {
    const p = (typeof projects !== "undefined" ? projects : []).find((x) => x.path && x.path.indexOf("mdprev-") >= 0);
    if (p) { try { activeProjectId = p.id; } catch (e) { /* 变量可能为 const 导出 */ } }
    if (typeof setUp === "function") { /* 兼容:视图切换由下方按钮负责 */ }
    if (typeof ideLoad === "function") ideLoad();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => { if (typeof ideOpenFile === "function") ideOpenFile("docs/README.md"); });
  await page.waitForFunction(() => {
    const h = document.getElementById("ideMdHost");
    return h && h.style.display !== "none" && h.innerHTML.length > 200;
  }, null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1200); // 图片解码

  const st = await page.evaluate(() => {
    const host = document.getElementById("ideMdHost");
    const imgs = [...(host ? host.querySelectorAll("img.md-img") : [])];
    const vids = [...(host ? host.querySelectorAll("video.md-video") : [])];
    const mdlinks = [...(host ? host.querySelectorAll("a[data-ide-mdlink]") : [])];
    const anchors = [...(host ? host.querySelectorAll("a") : [])].filter((a) => (a.getAttribute("href") || "").indexOf("#") === 0);
    const wrap = host ? host.querySelector(".md-table-wrap") : null;
    const td = host ? host.querySelector("td") : null;
    const th = host ? host.querySelector("th") : null;
    const p = host ? host.querySelector("p") : null;
    const li = host ? host.querySelector("li") : null;
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      hostVisible: !!(host && host.style.display !== "none"),
      imgCount: imgs.length,
      imgSrc: imgs.map((i) => i.getAttribute("src")),
      imgLoaded: imgs.map((i) => i.naturalWidth > 0),
      vidCount: vids.length,
      vidSrc: vids.length ? vids[0].getAttribute("src") : "",
      vidControls: vids.length ? vids[0].hasAttribute("controls") : false,
      mdlinkCount: mdlinks.length,
      mdlinkHref: mdlinks.length ? mdlinks[0].getAttribute("href") : "",
      mdlinkTarget: mdlinks.length ? mdlinks[0].getAttribute("data-ide-mdlink") : "",
      anchorHref: anchors.length ? anchors[0].getAttribute("href") : "",
      wrapExists: !!wrap,
      wrapOverflowX: wrap ? getComputedStyle(wrap).overflowX : "",
      tdPad: td ? cs(td).paddingTop + " " + cs(td).paddingLeft : "",
      thWeight: th ? cs(th).fontWeight : "",
      mdLineHeight: host ? cs(host).lineHeight : "",
      mdFontSize: host ? cs(host).fontSize : "",
      pMargin: p ? cs(p).marginTop : "",
      liMargin: li ? cs(li).marginTop : "",
      ulPad: host && host.querySelector("ul") ? getComputedStyle(host.querySelector("ul")).marginLeft : "",
    };
  });

  check("①md 标签默认进预览层(#ideMdHost 可见)", st.hostVisible);
  check("②相对图重写为 /ide/asset 且真解码", st.imgCount >= 2 && st.imgSrc[0].indexOf("/ide/asset?path=") === 0 && st.imgLoaded[0] === true,
    "src=" + String(st.imgSrc[0]).slice(0, 70) + " loaded=" + st.imgLoaded[0]);
  check("③外链图原样放行", st.imgCount === 3 && String(st.imgSrc[2]).indexOf("https://example.com/x.png") === 0, "src=" + st.imgSrc[2]);
  check("④视频产 <video controls> 且走 /ide/asset", st.vidCount === 1 && st.vidControls && st.vidSrc.indexOf("/ide/asset?path=") === 0,
    "src=" + String(st.vidSrc).slice(0, 70));
  const vidHttp = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, ct: r.headers.get("content-type") || "" };
  }, st.vidSrc).catch(() => ({ status: 0, ct: "" }));
  check("④b 视频字节路由 200 + video/mp4", vidHttp.status === 200 && vidHttp.ct.indexOf("video/mp4") === 0, JSON.stringify(vidHttp));
  check("⑤相对链接按 md 目录解析并产 data-ide-mdlink", st.mdlinkCount === 1 && st.mdlinkTarget === "docs/sub/linked.md" && st.mdlinkHref.indexOf("javascript:") === 0,
    st.mdlinkHref + " → " + st.mdlinkTarget);
  check("⑥页内 #锚点 href 保留", st.anchorHref === "#媒体", st.anchorHref);
  check("⑦表格外包 .md-table-wrap + 单元格内边距 9/13", st.wrapExists && st.wrapOverflowX === "auto" && st.tdPad === "9px 13px", st.tdPad + " ov=" + st.wrapOverflowX);
  check("⑧阅读密度:行高 1.85 / 段距 12 / 列表项 6",
    Math.abs(parseFloat(st.mdLineHeight) - parseFloat(st.mdFontSize) * 1.85) < 2.5 && st.pMargin === "12px" && st.liMargin === "6px",
    "lh=" + st.mdLineHeight + " fs=" + st.mdFontSize + " p=" + st.pMargin + " li=" + st.liMargin + " ul=" + st.ulPad);

  // ⑨相对链接点击 → 开新标签(真实事件委托链路)
  const before = await page.evaluate(() => (typeof ideTabs !== "undefined" ? ideTabs.length : -1));
  await page.evaluate(() => {
    const a = document.querySelector("#ideMdHost a[data-ide-mdlink]");
    if (a) a.click();
  });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    n: typeof ideTabs !== "undefined" ? ideTabs.length : -1,
    paths: typeof ideTabs !== "undefined" ? ideTabs.map((t) => t.path) : [],
  }));
  check("⑨相对链接点击开新标签", before > 0 && after.n === before + 1 && after.paths.indexOf("docs/sub/linked.md") >= 0,
    JSON.stringify(after.paths));

  // 切回 IDE 视图并截取预览区(自查排版用)
  await page.evaluate(() => {
    const b = document.querySelector('[data-view="ide"], .bh-ide[data-ide]');
    if (b) b.click();
    if (typeof ideOpenFile === "function") ideOpenFile("docs/README.md");
  });
  await page.waitForTimeout(1500);
  const hostBox = await page.evaluate(() => {
    const h = document.getElementById("ideMdHost");
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  if (hostBox && hostBox.width > 50) {
    await page.screenshot({ path: join(process.cwd(), "mdpreview.png"), clip: hostBox }).catch(() => {});
    await page.evaluate(() => {
      const w = document.querySelector("#ideMdHost .md-table-wrap");
      if (w) w.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(process.cwd(), "mdpreview-table.png"), clip: hostBox }).catch(() => {});
  } else {
    await page.screenshot({ path: join(process.cwd(), "mdpreview.png") }).catch(() => {});
  }
  check("⑩页面无 JS 报错", errs.length === 0, errs.slice(0, 3).join(" | "));

  const fails = results.filter((r) => !r.ok).length;
  console.log("mdpreview: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
