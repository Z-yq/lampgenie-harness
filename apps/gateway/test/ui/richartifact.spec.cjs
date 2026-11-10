/** 富图形交付真浏览器取证:```html 沙箱图卡 + ```svg 净化图卡 + 全屏/1:1 + 安全负向 + demo.md 对照截图。
 * 跑法(不碰生产环境 7700):cd apps/gateway && npx tsx test/ui/_ui_selfhost.cjs test/ui/richartifact.spec.cjs
 * PANEL_BASE 缺席或无 chrome 时整文件 skip。 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const BASE = process.env.PANEL_BASE;
const CHROME = "/usr/bin/google-chrome";
const REPO = path.resolve(__dirname, "../../../..");
const FIX = path.join(REPO, "tasks/-rich-artifact/fixtures");
const EVID = path.join(REPO, "tasks/-rich-artifact/evidence");

(async () => {
  if (!BASE) { console.log("SKIP richartifact: PANEL_BASE 未设置(selfhost 形态才跑)"); process.exit(0); }
  if (!fs.existsSync(CHROME)) { console.log("SKIP richartifact: 无 chrome(" + CHROME + ")"); process.exit(0); }
  fs.mkdirSync(EVID, { recursive: true });
  const results = [];
  const check = (name, ok, detail) => { results.push(ok); console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : "")); };
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const netExternal = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
  page.on("request", (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("about:") && !u.startsWith("blob:")) netExternal.push(u.slice(0, 90)); });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);

  // 收渲染产出:把 md 交给真实页面的 mdToHtml + artRenderIn,挂进一个可见宿主观测
  const render = async (mdText) => page.evaluate((md) => {
    let host = document.getElementById("__artProbe");
    if (!host) { host = document.createElement("div"); host.id = "__artProbe"; host.style.cssText = "position:fixed;left:0;top:0;width:1080px;background:#0b0806;z-index:99999;max-height:100vh;overflow:auto"; document.body.appendChild(host); }
    host.innerHTML = mdToHtml(md, "");
    artRenderIn(host);
    return true;
  }, mdText);
  const cleanup = () => page.evaluate(() => { const h = document.getElementById("__artProbe"); if (h) h.remove(); });

  // ---------- A. demo.md 两张图卡(HTML iframe + SVG)----------
  const demo = fs.readFileSync(path.join(FIX, "demo.md"), "utf8");
  await render(demo);
  await page.waitForTimeout(600);
  const a = await page.evaluate(() => {
    const html = document.querySelector("#__artProbe .md-artifact.md-html");
    const svgBox = document.querySelector("#__artProbe .md-artifact.md-svg");
    const frame = html ? html.querySelector("iframe") : null;
    const svg = svgBox ? svgBox.querySelector(".art-body svg") : null;
    const code = document.querySelectorAll("#__artProbe .code-wrap.is-code");
    return {
      htmlCount: document.querySelectorAll("#__artProbe .md-artifact.md-html").length,
      svgCount: document.querySelectorAll("#__artProbe .md-artifact.md-svg").length,
      sandbox: frame ? frame.getAttribute("sandbox") : "NOFRAME",
      iframeH: frame ? frame.getBoundingClientRect().height : 0,
      iframeW: frame ? frame.getBoundingClientRect().width : 0,
      stillPlaceholder: svgBox ? svgBox.hasAttribute("data-art-svg") : true,
      svgW: svg ? svg.getBoundingClientRect().width : 0,
      svgH: svg ? svg.getBoundingClientRect().height : 0,
      svgTextCount: svg ? svg.querySelectorAll("text").length : 0,
      codeBlocks: code.length, // 只有 demo.md 里那个 ts 块
    };
  });
  check("demo.md:html 图卡 1 个 + svg 图卡 1 个", a.htmlCount === 1 && a.svgCount === 1, "html=" + a.htmlCount + " svg=" + a.svgCount);
  check("html 图卡 sandbox=\"\"(禁脚本/表单/同源)", a.sandbox === "", "sandbox=" + JSON.stringify(a.sandbox));
  check("html height=760 生效(iframe 高 > 700)", a.iframeH > 700 && a.iframeW > 900, "h=" + Math.round(a.iframeH) + " w=" + Math.round(a.iframeW));
  check("svg 图卡完成挂载(占位标记已摘)+ 有声有色尺寸", !a.stillPlaceholder && a.svgW > 600 && a.svgH > 300, "w=" + Math.round(a.svgW) + " h=" + Math.round(a.svgH) + " placeholder=" + a.stillPlaceholder);
  check("svg 文本节点保留(标注可读)", a.svgTextCount >= 20, "text=" + a.svgTextCount);
  check("普通代码块仍走 code-wrap(仅 ts 那块)", a.codeBlocks === 1, "code=" + a.codeBlocks);

  // iframe 内排版:能读到 body 宽度/卡片数量/无横向溢出
  const frameEl = await page.$("#__artProbe .md-artifact.md-html iframe");
  const ifr = frameEl ? await frameEl.contentFrame() : null;
  let inner = { ok: false };
  if (ifr) {
    await ifr.waitForTimeout(300);
    inner = await ifr.evaluate(() => {
      const body = document.body;
      const cards = document.querySelectorAll(".card, .ghost").length;
      const badges = [...document.querySelectorAll(".badge")].map((b) => b.textContent.trim());
      const foot = document.querySelectorAll(".fc").length;
      const sc = document.querySelector(".stage");
      return { ok: true, cards: cards, badges: badges, foot: foot,
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        stageW: sc ? Math.round(sc.getBoundingClientRect().width) : 0 };
    });
  }
  check("iframe 内文档可读(cards≥8/四栏=4/两枚徽标)", inner.ok && inner.cards >= 8 && inner.foot === 4 && inner.badges.join(",").indexOf("唯一重资源") >= 0 && inner.badges.join(",").indexOf("重活用在这里") >= 0,
    JSON.stringify({ cards: inner.cards, foot: inner.foot, badges: inner.badges, stageW: inner.stageW }));
  check("iframe 内无横向溢出(scrollWidth ≤ clientWidth+2)", inner.ok && inner.scrollW <= inner.clientW + 2, "sw=" + inner.scrollW + " cw=" + inner.clientW);

  await page.locator("#__artProbe .md-artifact.md-html").screenshot({ path: path.join(EVID, "rich-artifact-arch-cards.png") }).catch(() => {});
  await page.locator("#__artProbe .md-artifact.md-svg").screenshot({ path: path.join(EVID, "rich-artifact-strategy-matrix.png") }).catch(() => {});

  // ---------- B. 全屏 / 1:1 ----------
  await page.click("#__artProbe .md-artifact.md-svg .art-full");
  await page.waitForTimeout(250);
  const fsState = await page.evaluate(() => {
    const box = document.querySelector("#__artProbe .md-artifact.md-svg");
    const r = box.getBoundingClientRect();
    const svg = box.querySelector("svg");
    return { on: box.classList.contains("art-fs"), w: Math.round(r.width), h: Math.round(r.height),
      label: box.querySelector(".art-full").textContent, svgW: svg ? Math.round(svg.getBoundingClientRect().width) : 0 };
  });
  check("全屏:覆盖视口(fixed + art-fs)+ 按钮改文案", fsState.on && fsState.w > 1200 && fsState.h > 700 && fsState.label === "退出全屏",
    "w=" + fsState.w + " h=" + fsState.h + " label=" + fsState.label);
  await page.screenshot({ path: path.join(EVID, "rich-artifact-fullscreen.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const escState = await page.evaluate(() => {
    const box = document.querySelector("#__artProbe .md-artifact.md-svg");
    return { on: box.classList.contains("art-fs"), label: box.querySelector(".art-full").textContent };
  });
  check("Esc 退出全屏并复原按钮文案", !escState.on && escState.label === "全屏", JSON.stringify(escState));
  await page.click("#__artProbe .md-artifact.md-svg .art-fit");
  await page.waitForTimeout(200);
  const fitState = await page.evaluate(() => {
    const box = document.querySelector("#__artProbe .md-artifact.md-svg");
    return { raw: box.classList.contains("art-raw"), label: box.querySelector(".art-fit").textContent };
  });
  check("1:1 切换生效(art-raw + 按钮改「适宽」)", fitState.raw && fitState.label === "适宽", JSON.stringify(fitState));
  await cleanup();

  // ---------- C. 安全负向:html 里的 script 不执行、外部资源不加载、javascript: 被拦 ----------
  const evilHtml = "<!doctype html><html><head><style>body{background:#101010;color:#eee;font:14px sans-serif}</style></head><body>" +
    "<script>parent.__artPwn=(parent.__artPwn||0)+1;document.title='PWNED'</script>" +
    '<img id="ext" src="http://example.com/x.png" onerror="parent.__artPwn=(parent.__artPwn||0)+10">' +
    '<a id="jsl" href="javascript:parent.__artPwn=(parent.__artPwn||0)+100">点我</a>' +
    "<div onclick=\"parent.__artPwn=(parent.__artPwn||0)+1000\">可点区</div>" +
    "<form action=\"http://example.com/post\"><input name=q><button>提交</button></form>" +
    "<h3>负向样本</h3></body></html>";
  await page.evaluate(() => { window.__artPwn = 0; });
  await render("```html height=400\n" + evilHtml + "\n```");
  await page.waitForTimeout(1200);
  const f2 = await page.$("#__artProbe .md-artifact.md-html iframe");
  const ifr2 = f2 ? await f2.contentFrame() : null;
  let neg = { script: "no-frame" };
  if (ifr2) {
    try { await ifr2.click("#jsl", { timeout: 1500 }); } catch (e) { /* 点击失败也算被拦 */ }
    neg = await ifr2.evaluate(() => {
      let ran = false;
      try { ran = !!window.__artPwn; } catch (e) { ran = "blocked"; } // sandbox="" → 跨源,读不到算被隔离
      return { title: document.title, scriptRan: ran, pwn: String(ran) };
    });
  }
  const parentPwn = await page.evaluate(() => ({ pwn: window.__artPwn || 0, title: document.title }));
  const extReqs = netExternal.filter((u) => u.indexOf("example.com") >= 0);
  check("negative:iframe 内 <script> 不执行(父页 __artPwn=0 且无 PWNED 标题)", parentPwn.pwn === 0 && parentPwn.title.indexOf("PWNED") < 0,
    "pwn=" + parentPwn.pwn + " title=" + JSON.stringify(parentPwn.title));
  check("negative:外部图片/CSP 阻断(default-src none → example.com 请求数 0)", extReqs.length === 0, "ext=" + JSON.stringify(extReqs.slice(0, 3)));
  await cleanup();

  // ---------- D. SVG 净化:script / onload / 外链 href / foreignObject ----------
  const evilSvg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 120" width="600" onload="parent.__svgPwn=1">' +
    '<script>parent.__svgPwn=2</script>' +
    '<foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="parent.__svgPwn=3"/></div></foreignObject>' +
    '<a xlink:href="http://example.com/"><text x="10" y="30" font-size="14" fill="#eee">外链</text></a>' +
    '<a xlink:href="javascript:parent.__svgPwn=4"><text x="10" y="60" font-size="14" fill="#eee">js</text></a>' +
    '<a xlink:href="#ok"><text x="10" y="90" font-size="14" fill="#eee">片内锚</text></a>' +
    '<image href="http://example.com/a.png" width="10" height="10"/>' +
    '<rect x="150" y="10" width="40" height="40" fill="#c98f45"/></svg>';
  await page.evaluate(() => { window.__svgPwn = 0; });
  await render("```svg\n" + evilSvg + "\n```");
  await page.waitForTimeout(700);
  const svgNeg = await page.evaluate(() => {
    const box = document.querySelector("#__artProbe .md-artifact.md-svg");
    const svg = box ? box.querySelector("svg") : null;
    if (!svg) return { mounted: false };
    const attrs = [];
    svg.querySelectorAll("*").forEach((el) => { for (const at of el.attributes) attrs.push(at.name + "=" + at.value); });
    return {
      mounted: true,
      script: svg.querySelectorAll("script").length,
      foreign: svg.querySelectorAll("foreignObject").length,
      onload: svg.hasAttribute("onload") || svg.getAttribute("onload"),
      onAttrs: attrs.filter((s) => /^on/i.test(s)).length,
      extHref: attrs.filter((s) => /^(href|xlink:href)=http/i.test(s) || /^(href|xlink:href)=javascript/i.test(s)).length,
      fragHref: attrs.filter((s) => /^(href|xlink:href)=#/i.test(s)).length,
      img: svg.querySelectorAll("image").length,
      rect: svg.querySelectorAll("rect").length,
      textCount: svg.querySelectorAll("text").length,
      pwn: window.__svgPwn || 0,
    };
  });
  check("svg 净化:script/foreignObject 被剥", svgNeg.mounted && svgNeg.script === 0 && svgNeg.foreign === 0, JSON.stringify({ s: svgNeg.script, f: svgNeg.foreign }));
  check("svg 净化:on* 属性与外链/javascript: href 全剥", svgNeg.onAttrs === 0 && !svgNeg.onload && svgNeg.extHref === 0, JSON.stringify({ on: svgNeg.onAttrs, onload: svgNeg.onload, ext: svgNeg.extHref }));
  check("svg 净化:合法内容保留(#片段锚 + 图形 + 文本)", svgNeg.fragHref >= 1 && svgNeg.rect >= 1 && svgNeg.textCount >= 3, JSON.stringify({ frag: svgNeg.fragHref, rect: svgNeg.rect, text: svgNeg.textCount }));
  check("negative:svg 脚本未执行(__svgPwn=0)", svgNeg.pwn === 0, "pwn=" + svgNeg.pwn);
  await cleanup();

  // ---------- E. 超限回落 + 解析失败回落 ----------
  const big = "x".repeat(512 * 1024 + 64);
  await render("```html\n" + big + "\n```\n\n```svg height=1\n" + big + "\n```");
  await page.waitForTimeout(300);
  const fb = await page.evaluate(() => {
    const h = document.getElementById("__artProbe");
    return { notes: h.querySelectorAll(".md-art-note").length, codes: h.querySelectorAll(".code-wrap.is-code").length,
      arts: h.querySelectorAll(".md-artifact").length, noteText: (h.querySelector(".md-art-note") || {}).textContent || "" };
  });
  check(">512KB 回落代码块 + 一行说明(两种围栏都回落)", fb.notes === 2 && fb.codes === 2 && fb.arts === 0, JSON.stringify(fb));
  await cleanup();
  await render("```svg\n<svg><rect></svg 乱码"); // 非法 XML
  await page.waitForTimeout(400);
  const bad = await page.evaluate(() => {
    const h = document.getElementById("__artProbe");
    return { note: (h.querySelector(".md-art-note") || {}).textContent || "", code: h.querySelectorAll(".md-artifact .art-body pre.code").length };
  });
  check("SVG 解析失败回落代码块 + 说明", /解析失败/.test(bad.note) && bad.code === 1, JSON.stringify(bad));
  await cleanup();

  // ---------- F. 窄屏自适应 ----------
  await page.setViewportSize({ width: 720, height: 900 });
  await render(demo);
  await page.waitForTimeout(500);
  const narrow = await page.evaluate(() => {
    const box = document.querySelector("#__artProbe .md-artifact.md-html");
    const r = box.getBoundingClientRect();
    const host = document.getElementById("__artProbe");
    return { boxW: Math.round(r.width), hostW: host.clientWidth, overflowX: host.scrollWidth > host.clientWidth + 2 };
  });
  check("窄屏(720):图卡随容器收缩、不撑出横向滚动", narrow.boxW <= narrow.hostW && !narrow.overflowX, JSON.stringify(narrow));
  await page.locator("#__artProbe").screenshot({ path: path.join(EVID, "rich-artifact-narrow.png") }).catch(() => {});
  await cleanup();
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---------- G. 聊天流真链路(setHist + renderHistory)----------
  const NL = String.fromCharCode(10);
  const conv = [
    { seq: 1, kind: "message.user", time: Date.now() - 5000, payload: { text: "画一张架构卡和一张矩阵" } },
    { seq: 2, kind: "message.agent", time: Date.now() - 3000, llmMs: 120,
      payload: { text: "架构卡:" + NL + "```html height=500" + NL + fs.readFileSync(path.join(FIX, "arch-cards.html"), "utf8") + NL + "```" + NL + "矩阵:" + NL + "```svg" + NL + fs.readFileSync(path.join(FIX, "strategy-matrix.svg"), "utf8") + NL + "```" } },
  ];
  const injected = await page.evaluate("(function(){ if(!window.__mature) return false; window.__mature.setHist(" + JSON.stringify(conv) + "); window.__mature.renderHistory(); return true; })()");
  await page.waitForTimeout(900);
  const chat = await page.evaluate(() => {
    const body = document.getElementById("chatBody");
    const html = body.querySelector(".md-artifact.md-html");
    const svg = body.querySelector(".md-artifact.md-svg svg");
    return { injected: true, html: !!html, svg: !!svg, sandbox: html ? html.querySelector("iframe").getAttribute("sandbox") : "",
      svgText: svg ? svg.querySelectorAll("text").length : 0 };
  });
  check("聊天流真渲染:html 图卡 + svg 图卡都在,iframe 沙箱生效", injected && chat.html && chat.svg && chat.sandbox === "" && chat.svgText >= 20,
    JSON.stringify(chat));
  if (chat.html) await page.locator("#chatBody .md-artifact.md-html").first().screenshot({ path: path.join(EVID, "rich-artifact-chat-html.png") }).catch(() => {});
  if (chat.svg) await page.locator("#chatBody .md-artifact.md-svg").first().screenshot({ path: path.join(EVID, "rich-artifact-chat-svg.png") }).catch(() => {});

  check("0 pageerror(全流程)", pageErrors.length === 0, pageErrors.join(" | "));
  const fails = results.filter((x) => !x).length;
  console.log("richartifact: " + (results.length - fails) + "/" + results.length);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH " + String(e).slice(0, 400)); process.exit(2); });
