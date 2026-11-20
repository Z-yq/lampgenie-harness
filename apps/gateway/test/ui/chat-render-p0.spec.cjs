/** UI 经验证: 对话渲染 P0-1..P0-5(真实 chromium 无头;ITEM=P0-x 只跑该项)。
 * 断言口径:page.evaluate 直接调页面全局渲染函数(mdToHtml/tableToTsv/... 都是面板单 <script> 顶层
 * function,注入容器后断真实 DOM/计算样式),不靠字符串包含猜行为。
 * 惯例同 slash.spec.cjs / revshots.spec.cjs:playwright-core + /usr/bin/google-chrome headless + servePanel。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");

const ITEM = String(process.env.ITEM || "").trim();
const want = (k) => !ITEM || ITEM === k;
const PORT = 7721;
const ITEMS = ["P0-1", "P0-2", "P0-3", "P0-4", "P0-5"];

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
  };
  const runItem = async (name, fn) => {
    try { await fn(); } catch (e) { check(name + " 执行异常", false, String(e).slice(0, 300)); }
  };

  const panel = servePanel(PORT, () => {});
  await new Promise((r) => setTimeout(r, 400));
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  try {
    await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);

    if (ITEM && ITEMS.indexOf(ITEM) < 0) check("ITEM 取值合法(" + ITEM + ")", false, "允许:P0-1..P0-5");

 // ---------------- P0-1 表格工具栏 ----------------
    if (want("P0-1")) await runItem("P0-1", async () => {
      const r = await page.evaluate(() => {
        const fns = [typeof mdToHtml, typeof tableToTsv, typeof tableToCsv].join(",");
        const md = ["| 名称 | 值 | 说明 |", "| --- | --- | --- |", "| a | 1 | 第一行 |", "| b | 2 | 第二行 |"].join("\n");
        const host = document.createElement("div");
        host.id = "p01host";
        host.style.width = "600px";
        host.innerHTML = mdToHtml(md, "", null);
        document.body.appendChild(host);
        const wrap = host.querySelector(".md-table-wrap");
        const table = wrap && wrap.querySelector("table.md-table");
 // CSV 转义单独一张手工表(逗号 / 引号 / 单元格内换行)
        const t2 = document.createElement("table");
        t2.innerHTML = '<tr><th>a</th><th>b</th><th>c</th></tr><tr><td>x,1</td><td>he said "hi"</td><td>l1\nl2</td></tr>';
        const out = { fns, wrap: !!wrap, table: !!table };
        out.acts = wrap ? Array.from(wrap.querySelectorAll(".md-table-tools button")).map((b) => b.getAttribute("data-tbl-act")) : [];
        out.toolsPos = wrap ? getComputedStyle(wrap).position : "";
        out.tsv = table ? tableToTsv(table) : "«no-table»";
        out.csv = table ? tableToCsv(table) : "«no-table»";
        out.csvEsc = tableToCsv(t2);
        out.tsvEsc = tableToTsv(t2);
        return out;
      });
      check("P0-1 渲染函数在场(mdToHtml/tableToTsv/tableToCsv)", r.fns === "function,function,function", r.fns);
      check("P0-1 表格外包 .md-table-wrap 且工具栏三按钮 copy/csv/xl", r.wrap && r.table && r.acts.join(",") === "copy,csv,xl", JSON.stringify(r.acts));
      const tsvRows = String(r.tsv).split("\n");
      check("P0-1 tableToTsv 3 行×3 列(内容逐格对齐)",
        tsvRows.length === 3 && tsvRows.every((l) => l.split("\t").length === 3) &&
        tsvRows[0] === "名称\t值\t说明" && tsvRows[2] === "b\t2\t第二行", JSON.stringify(r.tsv));
      check("P0-1 tableToCsv 行列与 TSV 同构", r.csv === "名称,值,说明\na,1,第一行\nb,2,第二行", JSON.stringify(r.csv));
      check("P0-1 tableToCsv 逗号/引号加引号、内部引号翻倍", r.csvEsc === 'a,b,c\n"x,1","he said ""hi""",l1 l2', JSON.stringify(r.csvEsc));
      check("P0-1 tableToTsv 去标签压空白(单元格内换行折成空格)", r.tsvEsc === 'a\tb\tc\nx,1\the said "hi"\tl1 l2', JSON.stringify(r.tsvEsc));

 // 复制按钮 → 剪贴板内容就是 TSV(桩 navigator.clipboard.capture,不碰真剪贴板)
      const clip = await page.evaluate(() => {
        let got = "";
        try { Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { got = String(t); return Promise.resolve(); } }, configurable: true }); } catch (e) { /* 已只读 */ }
        const b = document.querySelector('#p01host [data-tbl-act="copy"]');
        if (b) b.click();
        return got;
      });
      check("P0-1 点「复制表格」写入的就是 TSV", clip === r.tsv && clip.indexOf("\t") > 0, JSON.stringify(clip).slice(0, 120));

      const m1 = await page.evaluate(() => {
        const b = document.querySelector('#p01host [data-tbl-act="xl"]');
        if (b) b.click();
        const mask = document.querySelector(".uid-mask.uid-table-xl");
        return { mask: !!mask, table: !!(mask && mask.querySelector(".md-table-xl table.md-table")), heads: mask ? mask.querySelectorAll("th").length : 0 };
      });
      check("P0-1 点「展开」→ 模态出现且含完整表格", m1.mask && m1.table && m1.heads === 3, JSON.stringify(m1));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
      check("P0-1 Esc 关掉模态", (await page.locator(".uid-mask.uid-table-xl").count()) === 0);
      const closed = await page.evaluate(() => {
        const b = document.querySelector('#p01host [data-tbl-act="xl"]');
        if (b) b.click();
        const x = document.querySelector(".uid-table-xl .uid-x");
        if (x) x.click();
        return document.querySelectorAll(".uid-mask.uid-table-xl").length;
      });
      check("P0-1 关闭按钮关掉模态", closed === 0, String(closed));
    });

 // ---------------- P0-2 轮级折叠三级 ----------------
    if (want("P0-2")) await runItem("P0-2", async () => {
      const r = await page.evaluate(() => {
        try { localStorage.clear(); } catch (e) { /* 无存储 */ }
        const toolCard = (id) => '<div class="tool-card" data-det-key="tool-call:' + id + '"><summary class="tc-sum"><span class="tc-name">' + id + "</span></summary></div>";
        const think = '<div class="think-card"><summary>思考 · 7 秒</summary><div class="tk-body">…</div></div>';
        const parts = [toolCard("bash"), toolCard("read_file"), think];
        const ranges = [{ i: 0, k: "round:p02", t: "r1" }];
        roundPartsWrap(parts, ranges, () => false);
        const host = document.createElement("div");
        host.id = "p02host";
        host.innerHTML = parts.join("");
        document.body.appendChild(host);
        const g = host.querySelector("details.round-group");
        const out = { group: !!g, open: g ? g.open : null, sum: g ? String((g.querySelector(".rg-sum") || {}).textContent || "") : "" };
        out.steps = host.querySelectorAll(".round-step").length;
        out.stepsOpen = Array.from(host.querySelectorAll(".round-step")).map((d) => !!d.open);
        out.thinkInGroup = !!(g && g.querySelector(".think-card"));
        out.thinkOutside = !!host.querySelector(":scope > .think-card");
 // 第 3 级:10+ 行命令 → cmd-fold
        const cmd = Array.from({ length: 12 }, (_, i) => "cmd line " + (i + 1)).join("\n");
        const fold = trBlockPreview(cmd, "", false, { cmdFold: true, cmdKey: "p02cmd" });
        const h2 = document.createElement("div");
        h2.id = "p02cmdhost";
        h2.innerHTML = fold;
        document.body.appendChild(h2);
        const df = h2.querySelector("details.cmd-fold");
        out.fold = !!df;
        out.foldOpen = df ? df.open : null;
        out.cfMore = !!(df && df.querySelector(".cf-more"));
        out.cfLess = !!(df && df.querySelector(".cf-less"));
        out.shownLines = h2.querySelectorAll(".code-wrap .cl").length;
        return out;
      });
      check("P0-2 连续过程段收进 .round-group", r.group, JSON.stringify({ group: r.group }));
      check("P0-2 摘要「已执行 2 命令」+ 步数,默认收起", r.sum.indexOf("已执行 2 命令") >= 0 && r.sum.indexOf("3 步") >= 0 && r.open === false, JSON.stringify(r.sum));
      check("P0-2 组内 3 行 .round-step(默认收起)", r.steps === 3 && r.stepsOpen.every((x) => x === false), JSON.stringify({ steps: r.steps, open: r.stepsOpen }));
      check("P0-2 思考段进组(不留在组外)", r.thinkInGroup && !r.thinkOutside, JSON.stringify({ in: r.thinkInGroup, out: r.thinkOutside }));
      check("P0-2 12 行命令出 .cmd-fold(cf-more/cf-less 齐备)", r.fold && r.foldOpen === false && r.cfMore && r.cfLess, JSON.stringify({ fold: r.fold, open: r.foldOpen, more: r.cfMore, less: r.cfLess }));
      check("P0-2 命令折叠前只留 6 行", r.shownLines === 6, String(r.shownLines));

      const r2 = await page.evaluate(() => {
        const host = document.getElementById("p02host");
        const g = host.querySelector("details.round-group");
        const steps = Array.from(host.querySelectorAll("details.round-step"));
        const dh = document.getElementById("p02cmdhost");
        const df = dh.querySelector("details.cmd-fold");
 // 展开第 3 级 → 前两级开合原样
        df.open = true;
        df.dispatchEvent(new Event("toggle", { bubbles: true }));
        const levelAfterFold = [g.open, steps.map((d) => d.open)];
 // 展开第 2 级 → 第 1/3 级原样
        steps[0].open = true;
        steps[0].dispatchEvent(new Event("toggle", { bubbles: true }));
        const levelAfterStep = [g.open, df.open];
 // 展开第 1 级 → 子级原样
        g.open = true;
        g.dispatchEvent(new Event("toggle", { bubbles: true }));
        const levelAfterGroup = [steps[0].open, df.open];
        const out = {
          levelAfterFold: JSON.stringify(levelAfterFold),
          levelAfterStep: JSON.stringify(levelAfterStep),
          levelAfterGroup: JSON.stringify(levelAfterGroup),
          cfLessH: df.querySelector(".cf-less").offsetHeight,
          groupOpen: g.open,
          stepCount: steps.length,
        };
 // 记忆:显式展开过的组,terminal=true 仍 open;没记过的组 terminal=true 收起
        roundRemember("round:p02r", true);
        const seg2 = ['<div class="tool-card" data-det-key="tool-call:z"></div>', '<div class="think-card"><summary>思考 · 3 秒</summary></div>'];
        out.rememberOpen = /class="round-group"[^>]*\sopen/.test(roundGroupHtml(seg2.slice(), "round:p02r", true));
        out.unrememberedOpen = /class="round-group"[^>]*\sopen/.test(roundGroupHtml(seg2.slice(), "round:p02u", true));
        return out;
      });
      check("P0-2 三级开合互不影响", r2.levelAfterFold === "[false,[false,false,false]]" && r2.levelAfterStep === "[false,true]" && r2.levelAfterGroup === "[true,true]",
        JSON.stringify({ afterFold: r2.levelAfterFold, afterStep: r2.levelAfterStep, afterGroup: r2.levelAfterGroup }));
      check("P0-2 展开组后 3 行子步骤都在(组开合可读)", r2.groupOpen === true && r2.stepCount === 3, String(r2.stepCount));
      check("P0-2 点开命令折叠后「收起 ^」可见", r2.cfLessH > 0, String(r2.cfLessH));
      check("P0-2 roundRemember 过的组 terminal 仍展开,未记住的收起", r2.rememberOpen === true && r2.unrememberedOpen === false, JSON.stringify({ remembered: r2.rememberOpen, others: r2.unrememberedOpen }));
    });

 // ---------------- P0-3 完成后只留结论(轮级组收/展判定) ----------------
    if (want("P0-3")) await runItem("P0-3", async () => {
      const r = await page.evaluate(() => {
        try { localStorage.clear(); } catch (e) { /* 无存储 */ }
        const seg = ['<div class="tool-card" data-det-key="tool-call:t1"></div>', '<div class="sys-line">输出 done</div>'];
        const before = roundShouldOpen("round:p03", true);
        const htmlBefore = roundGroupHtml(seg.slice(), "round:p03", true);
        roundRemember("round:p03", true);
        const after = roundShouldOpen("round:p03", true);
        const htmlAfter = roundGroupHtml(seg.slice(), "round:p03", true);
        roundRemember("round:p03", false);
        const cleared = roundShouldOpen("round:p03", true);
        const active = roundShouldOpen("round:p03b", false);
        return { before, beforeOpen: /\sopen/.test(htmlBefore), after, afterOpen: /\sopen/.test(htmlAfter), cleared, active };
      });
      check("P0-3 terminal 且未手动展开 → 收起", r.before === false && r.beforeOpen === false, JSON.stringify({ v: r.before, html: r.beforeOpen }));
      check("P0-3 手动展开过 → 保持展开", r.after === true && r.afterOpen === true, JSON.stringify({ v: r.after, html: r.afterOpen }));
      check("P0-3 手动收起后回到收起 + 非终态默认也收起", r.cleared === false && r.active === false, JSON.stringify({ cleared: r.cleared, active: r.active }));
    });

 // ---------------- P0-4 横向滚动 / 错误行 ----------------
    if (want("P0-4")) await runItem("P0-4", async () => {
      const r = await page.evaluate(() => {
        const out = {};
 // ① 300+ 字符单行代码块:可横向滚、不折行
        const host = document.createElement("div");
        host.id = "p04host";
        host.style.width = "420px";
        document.body.appendChild(host);
        host.innerHTML = mdToHtml("```text\n" + "x".repeat(360) + "\n```", "", null);
 // 横向滚动的实际滚动容器是 .code-wrap(pre 只负责 white-space:pre 不折行)
        const pre = host.querySelector(".code-wrap pre.code");
        const scroller = host.querySelector(".code-wrap") || pre;
        out.pre = !!pre;
        if (pre && scroller) {
          const cs = getComputedStyle(pre);
          scroller.scrollLeft = 100;
          out.sw = scroller.scrollWidth;
          out.cw = scroller.clientWidth;
          out.sl = scroller.scrollLeft;
          out.slack = cs.whiteSpace;
          out.ws = cs.whiteSpace;
          out.ox = getComputedStyle(scroller).overflowX;
        }
 // ② 宽表可横向滚动
        const h2 = document.createElement("div");
        h2.id = "p04tbl";
        h2.style.width = "360px";
        document.body.appendChild(h2);
        const wide = "w".repeat(60);
        const head = "| " + Array.from({ length: 8 }, (_, i) => "h" + i).join(" | ") + " |";
        const sep = "| " + Array.from({ length: 8 }, () => "---").join(" | ") + " |";
        const row = "| " + Array.from({ length: 8 }, () => wide).join(" | ") + " |";
        h2.innerHTML = mdToHtml([head, sep, row].join("\n"), "", null);
        const w = h2.querySelector(".md-table-wrap");
        out.wrap = !!w;
        out.wrapOX = w ? getComputedStyle(w).overflowX : "";
        out.wrapScroll = w ? w.scrollWidth > w.clientWidth : false;
 // ③ 错误行判定(纯函数 6 例)
        out.err = {
          a: errLineRe("<error>boom"),
          b: errLineRe("Command timed out after 600s"),
          c: errLineRe("all good"),
          d: errLineRe("Error: nope"),
          e: errLineRe("   "),
          f: errLineRe("  <error code=1>bad"),
        };
 // ④ 错误行 computed color 与普通行不同(行走 codeLinesBlock 真实产出)
        const h3 = document.createElement("div");
        h3.id = "p04err";
        h3.innerHTML = codeLinesBlock("<error>boom\nplain ok line", "", 2, null, { kind: "term" });
        document.body.appendChild(h3);
        const bad = h3.querySelector(".cl.code-err-line");
        const good = h3.querySelectorAll(".cl")[1];
        out.errCount = h3.querySelectorAll(".cl.code-err-line").length;
        out.errColor = bad ? getComputedStyle(bad).color : "";
        out.okColor = good ? getComputedStyle(good).color : "";
 // ⑤ md 围栏代码块错误行标红( P0-4③ 补齐:renderCodeBlock 复用同一 errLineRe)
        const h4 = document.createElement("div");
        h4.id = "p04md";
        document.body.appendChild(h4);
        h4.innerHTML = mdToHtml("```bash\n<error>Command was aborted</error>\nok line\n```", "", null);
        const mdBad = h4.querySelector(".code-wrap pre.code .cl.code-err-line");
        const mdOk = h4.querySelectorAll(".code-wrap pre.code .cl")[1];
        out.mdErrCount = h4.querySelectorAll(".code-wrap pre.code .cl.code-err-line").length;
        out.mdErrColor = mdBad ? getComputedStyle(mdBad).color : "";
        out.mdOkColor = mdOk ? getComputedStyle(mdOk).color : "";
        return out;
      });
      check("P0-4 300+ 字符单行代码块 scrollWidth>clientWidth", r.pre && r.sw > r.cw, JSON.stringify({ pre: r.pre, sw: r.sw, cw: r.cw }));
      check("P0-4 scrollLeft 可写可读(真横向滚动而非裁掉)", r.sl === 100, String(r.sl));
      check("P0-4 长行不折行(white-space:pre)", String(r.ws).indexOf("pre") === 0, String(r.ws));
      check("P0-4 宽表容器可横向滚动", r.wrap && r.wrapOX !== "visible" && r.wrapScroll, JSON.stringify({ wrap: r.wrap, ox: r.wrapOX, scroll: r.wrapScroll }));
      check("P0-4 errLineRe 6 例判定正确",
        r.err.a === "code-err-line" && r.err.b === "code-err-line" && r.err.d === "code-err-line" && r.err.f === "code-err-line" && r.err.c === "" && r.err.e === "",
        JSON.stringify(r.err));
      check("P0-4 错误行只标该行且颜色不同于普通行",
        r.errCount === 1 && !!r.errColor && r.errColor !== r.okColor, JSON.stringify({ n: r.errCount, err: r.errColor, ok: r.okColor }));
      check("P0-4 md 围栏代码块错误行标红(renderCodeBlock 复用 errLineRe)",
        r.mdErrCount === 1 && !!r.mdErrColor && r.mdErrColor !== r.mdOkColor, JSON.stringify({ n: r.mdErrCount, err: r.mdErrColor, ok: r.mdOkColor }));
    });

 // ---------------- P0-5 运行态行 ----------------
    if (want("P0-5")) await runItem("P0-5", async () => {
      const v = await page.evaluate(() => ({ run: verbOf("run"), wait: verbOf("wait", "T1"), fail: verbOf("fail"), done: verbOf("done") }));
      check("P0-5 verbOf 四态文案/色类",
        v.run.t === "正在执行" && v.run.c === "v-run" && v.wait.t === "任务输出 T1 等待超时" && v.wait.c === "v-wait" &&
        v.fail.t === "失败" && v.fail.c === "v-fail" && v.done.t === "已执行" && v.done.c === "v-done",
        JSON.stringify(v));

      const s1 = await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "p05host";
        document.body.appendChild(host);
        host.innerHTML = runStatusHtml(Date.now() - 5000, "任务");
        const el = host.querySelector(".run-txt");
        return { txt: el ? el.textContent : "", lines: document.querySelectorAll("[data-run-line]").length };
      });
      const sec1 = Number((String(s1.txt).match(/分 (\d+) 秒/) || [])[1]);
      check("P0-5 运行态行含「正在执行」「工作中」「X 时 X 分 X 秒」",
        String(s1.txt).indexOf("正在执行") === 0 && String(s1.txt).indexOf("工作中") > 0 && sec1 >= 4 && s1.lines === 1,
        JSON.stringify(s1));

      await page.waitForTimeout(1300);
      const s2 = await page.evaluate(() => {
        runStatusTick();
        const els = document.querySelectorAll('[data-run-line="1"] .run-txt');
        return { txt: els[0] ? els[0].textContent : "", n: document.querySelectorAll("[data-run-line]").length };
      });
      const sec2 = Number((String(s2.txt).match(/分 (\d+) 秒/) || [])[1]);
      check("P0-5 tick 后时长前进且仍只有一行运行态行", s2.n === 1 && sec2 > sec1, JSON.stringify({ s2, sec1 }));
    });

    if (pageErrors.length && ITEM === "") check("无页面脚本错误", false, pageErrors.slice(0, 2).join(" | "));
  } finally {
    try { await browser.close(); } catch (e) { /* 忽略 */ }
    try { panel.close(); } catch (e) { /* 忽略 */ }
  }

  const failed = results.filter((x) => !x.ok);
  if (failed.length) console.log("FAILED " + failed.length + "/" + results.length);
  process.exit(failed.length ? 1 : 0);
})();