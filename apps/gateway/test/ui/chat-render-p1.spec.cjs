/**
 * P1-1..P1-8 聊天窗渲染对标经验证(真实 chromium 无头探针)。
 * 惯例照 slash.spec.cjs:node --import tsx 直跑,自带 PASS/FAIL,有 FAIL 则 exit 1。
 * 参数 ITEM=P1-1..P1-8 只跑单项(不传=全跑);样式断言一律取 computedStyle,不只查 class。
 */
const { chromium } = require("playwright-core");
const { servePanel } = require("../../src/panel.ts");
const fs = require("node:fs");
const path = require("node:path");

const ITEM = String(process.env.ITEM || "").trim();
const want = (n) => !ITEM || ITEM === n;
const PORT = 7731 + (Number((ITEM.match(/\d+/g) || ["1"]).pop()) % 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CSS_SRC = fs.readFileSync(path.join(__dirname, "..", "..", "src", "panel", "page-css.ts"), "utf8");

(async () => {
  const panel = servePanel(PORT, () => {});
  await sleep(350);
  const browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors = [];
 // 本 spec 用独立面板服务(无 WS 后端),WebSocket 重连失败是环境产物,不计入错误。
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("WebSocket")) errors.push(m.text().slice(0, 150));
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 150)));
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log((ok ? "PASS" : "FAIL") + " " + name + (detail ? " — " + detail : ""));
  };

  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await page.evaluate(() => switchView("chat"));
  await page.waitForTimeout(250);

 // ============ P1-1 侧栏悬停富浮层 ============
  if (want("P1-1")) {
    await page.evaluate(() => {
 // 造一条真项目 + 一条最近活动 40s 前的任务(bhHcInfo/bhHcProjAct 走真实数据通路)
      projects = [{ id: "p-hc", label: "demo", path: "/home/demo/projects/demo-repo", availability: "available" }];
      tasks.set("s-hc", { sessionId: "s-hc", pid: "p-hc", state: "idle", updatedAt: Date.now() - 40000 });
      const row = document.createElement("div");
      row.className = "proj-row";
      row.dataset.pid = "p-hc";
      row.textContent = "genie";
      row.style.cssText = "position:fixed;left:40px;top:120px;width:180px;height:26px;z-index:9999;background:#222;color:#fff";
      document.body.appendChild(row);
    });
    const box = await page.locator("body > .proj-row").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
 // 200ms 延时 + 淡入余量
    await page.waitForTimeout(320);
    const card = await page.evaluate(() => {
      const el = document.getElementById("bhHoverCard");
      if (!el) return { exists: false, all: document.querySelectorAll("#bhHoverCard").length };
      const cs = getComputedStyle(el);
      const q = (s) => el.querySelector(s);
      const pEl = q(".bh-hc-path");
      const r = el.getBoundingClientRect();
      return {
        exists: true,
        all: document.querySelectorAll("#bhHoverCard").length,
        on: el.classList.contains("on"),
        disp: cs.display,
        op: parseFloat(cs.opacity),
        trans: cs.transitionProperty + "/" + cs.transitionDuration,
        name: (q(".bh-hc-name") || {}).textContent || "",
        p: pEl ? pEl.textContent : "",
        pFam: pEl ? getComputedStyle(pEl).fontFamily : "",
        nFam: q(".bh-hc-name") ? getComputedStyle(q(".bh-hc-name")).fontFamily : "",
        act: (q(".bh-hc-act") || {}).textContent || "",
        rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    check("P1-1 悬停 200ms 后 #bhHoverCard 出现(.on)", card.exists && card.on && card.disp !== "none" && card.op >= 0.95, JSON.stringify({ on: card.on, op: card.op }));
    check("P1-1 浮层单例(全页仅 1 个 #bhHoverCard)", card.all === 1, "count=" + card.all);
    check("P1-1 浮层含项目名/路径/最近活动", card.name === "demo" && card.p === "/home/demo/projects/demo-repo" && /最近活动/.test(card.act) && /刚刚|分钟前/.test(card.act), JSON.stringify({ name: card.name, p: card.p, act: card.act }));
    check("P1-1 路径等宽字体(与项目名字族不同 + monospace)", /mono/i.test(card.pFam) && card.pFam !== card.nFam, card.pFam);
    check("P1-1 过渡为 CSS opacity/位移(非 display 切换)", /opacity/.test(card.trans) && !/0s\/0s/.test(card.trans), card.trans);
    check("P1-1 浮层不越视口", card.rect.l >= 0 && card.rect.t >= 0 && card.rect.r <= card.vw + 1 && card.rect.b <= card.vh + 1, JSON.stringify(card.rect));
 // 离开即隐藏(200ms 内)
    await page.mouse.move(1200, 780);
    await page.waitForTimeout(220);
    const gone = await page.evaluate(() => {
      const el = document.getElementById("bhHoverCard");
      return { on: !!el && el.classList.contains("on"), disp: el ? el.style.display : "none" };
    });
    check("P1-1 mouseout 后 200ms 内 .on 移除", !gone.on, JSON.stringify(gone));
    await page.waitForTimeout(220);
    const gone2 = await page.evaluate(() => {
      const el = document.getElementById("bhHoverCard");
      return { disp: el ? el.style.display : "none" };
    });
    check("P1-1 过渡结束后浮层 display:none", gone2.disp === "none", JSON.stringify(gone2));
 // 原生 title 兜底仍在(renderProjects 产出的真行)
    const titleKept = await page.evaluate(() => {
      renderProjects();
      const r = document.querySelector("#projList .proj-row");
      return r ? r.getAttribute("title") : "";
    });
    check("P1-1 原生 title 兜底保留", titleKept === "/home/demo/projects/demo-repo", titleKept);
  }

 // ============ P1-2 正文字距/行距/段落密度 ============
  if (want("P1-2")) {
    const src = {
      lhBodyDefs: (CSS_SRC.match(/--lh-body:/g) || []).length,
      gapBlock: /--gap-block:12px/.test(CSS_SRC),
      lsBody: /--ls-body:-\.007em/.test(CSS_SRC),
      replyP: /\.task-reply p\{margin:calc\(var\(--gap-block\) \* \.72\)/.test(CSS_SRC),
    };
    check("P1-2 源码:--lh-body 全站仅一处定义", src.lhBodyDefs === 1, "count=" + src.lhBodyDefs);
    check("P1-2 源码:--gap-block=12px / --ls-body=-.007em", src.gapBlock && src.lsBody, JSON.stringify(src));
    check("P1-2 源码:.task-reply p 段距=calc(--gap-block*0.72)", src.replyP);
    const m = await page.evaluate(() => {
      const host = document.getElementById("chatBody");
      host.innerHTML = '<div class="task-reply"><p>第一段正文内容,用来量段落密度。</p><p>第二段正文内容,用来量段间距。</p></div>';
      const ps = host.querySelectorAll(".task-reply p");
      const cs = getComputedStyle(ps[0]);
      return {
        fs: parseFloat(cs.fontSize),
        lh: parseFloat(cs.lineHeight),
        ls: cs.letterSpacing,
        mt: parseFloat(cs.marginTop),
        mb: parseFloat(cs.marginBottom),
        gap: ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom,
      };
    });
    const lhRatio = m.lh / m.fs;
    const lsEm = m.ls === "normal" ? 0 : parseFloat(m.ls) / m.fs;
    check("P1-2 .task-reply p 行高比落在 1.80~1.90", lhRatio >= 1.8 && lhRatio <= 1.9, "lh/fs=" + lhRatio.toFixed(3) + " (" + m.lh + "/" + m.fs + ")");
    check("P1-2 .task-reply p 字距为轻微收紧(-0.015em~-0.003em)", lsEm <= -0.003 && lsEm >= -0.015, "ls=" + m.ls + " → " + lsEm.toFixed(4) + "em");
    check("P1-2 段间距(上下 margin)落在 7~10px", m.mt >= 6.5 && m.mt <= 10.5 && m.mb >= 6.5 && m.mb <= 10.5, m.mt + "/" + m.mb);
    check("P1-2 相邻两段实际间隔(折叠后)落在 7~11px", m.gap >= 6.5 && m.gap <= 11, "gap=" + m.gap.toFixed(2));
  }

 // ============ P1-3 user message 气泡间距 ============
  if (want("P1-3")) {
    const u = await page.evaluate(() => {
      const host = document.getElementById("chatBody");
      host.innerHTML =
        '<div class="task-reply"><p>上一条终稿</p></div>' +
        '<div class="user-line"><span class="who" title="11:13">你</span><span class="txt"><span class="ul-body">先把所有还没实现的内容都实现后再统一测试</span></span></div>' +
        '<div class="task-reply"><p>下一条回复</p></div>';
      const ul = host.querySelector(".user-line");
      const body = host.querySelector(".ul-body");
      const cs = getComputedStyle(ul);
      const bcs = getComputedStyle(body);
      const prev = host.querySelector(".task-reply");
      const next = host.querySelectorAll(".task-reply")[1];
      const r = ul.getBoundingClientRect();
      return {
        mt: parseFloat(cs.marginTop),
        mb: parseFloat(cs.marginBottom),
        pad: cs.padding,
        radius: cs.borderTopLeftRadius + " " + cs.borderBottomRightRadius,
        w: r.width,
        contW: host.getBoundingClientRect().width,
        ulW: body.getBoundingClientRect().width,
        ulDisp: bcs.display,
        ulConv: bcs.overflowWrap,
        prevGap: r.top - prev.getBoundingClientRect().bottom,
        nextGap: next.getBoundingClientRect().top - r.bottom,
      };
    });
    check("P1-3 气泡上下 margin 生效(>0)", u.mt > 0 && u.mb > 0, u.mt + "/" + u.mb);
    check("P1-3 气泡 padding=8px 15px + 圆角生效", u.pad === "8px 15px" && parseFloat(u.radius) >= 12, u.pad + " | r=" + u.radius);
    check("P1-3 气泡宽 ≤ 容器 80%+容差(最大宽生效)", u.w > 0 && u.w <= u.contW * 0.8 + 4, "w=" + u.w.toFixed(1) + " cont=" + u.contW.toFixed(1) + " ratio=" + (u.w / u.contW).toFixed(3));
    check("P1-3 .ul-body 文本不溢出气泡(宽 ≤ 气泡宽)", u.ulW > 0 && u.ulW <= u.w + 1, u.ulW.toFixed(1) + " ≤ " + u.w.toFixed(1));
    check("P1-3 轮首/轮尾间距生效(与上文/下文均 >0)", u.prevGap > 0 && u.nextGap > 0, u.prevGap.toFixed(1) + "/" + u.nextGap.toFixed(1));
  }

 // ============ P1-4 表格状态徽标 ============
  if (want("P1-4")) {
    const t = await page.evaluate(() => {
      const host = document.getElementById("chatBody");
      const src = [
        "| 状态 | 说明 | 证据 |",
        "|---|---|---|",
        "| ✅ | 数据工具桥 | `graph.jsonl` |",
        "| 待验 | 待人工确认 | `task-a.md` |",
        "| 失败 | 长句里 ✅ 混排不算徽标 | `x.ts` |",
      ].join("\n");
      host.innerHTML = '<div class="task-reply">' + mdToHtml(src, "", {}) + "</div>";
      const badges = [...host.querySelectorAll(".md-badge")].map((b) => ({
        cls: b.className,
        txt: b.textContent,
        color: getComputedStyle(b).color,
      }));
      const cells = [...host.querySelectorAll(".md-table td")].map((td) => ({
        txt: td.textContent,
        nb: td.querySelectorAll(".md-badge").length,
      }));
      const code = host.querySelector(".md-table td code");
      return {
        badges,
        cells,
        codeTxt: code ? code.textContent : "",
        codeFam: code ? getComputedStyle(code).fontFamily : "",
        codeFs: code ? parseFloat(getComputedStyle(code).fontSize) : 0,
        replyFam: getComputedStyle(host.querySelector(".task-reply")).fontFamily,
      };
    });
    check("P1-4 三种整格状态词各出徽标(共 3 个)", t.badges.length === 3, JSON.stringify(t.badges.map((b) => b.txt)));
    check("P1-4 徽标带 st-* 语义类(ok/warn|idle/err)", t.badges.some((b) => /st-ok/.test(b.cls)) && t.badges.some((b) => /st-err/.test(b.cls)) && t.badges.some((b) => /st-(warn|idle)/.test(b.cls)), JSON.stringify(t.badges.map((b) => b.cls)));
    check("P1-4 三种徽标前景色互异", new Set(t.badges.map((b) => b.color)).size === 3, JSON.stringify(t.badges.map((b) => b.color)));
    check("P1-4 长句含 ✅ 的格子不出徽标", t.cells.some((c) => /✅/.test(c.txt) && c.nb === 0 && /长句/.test(c.txt)), JSON.stringify(t.cells));
    check("P1-4 .md-table td code 等宽字体", t.codeTxt === "graph.jsonl" && /mono/i.test(t.codeFam), t.codeFam);
  }

 // ============ P1-5 斜杠菜单视觉/键盘 ============
  if (want("P1-5")) {
    await page.evaluate(() => switchView("chat"));
    await page.click("#instruction");
    await page.keyboard.type("/");
    await page.waitForTimeout(200);
    const menu = () =>
      page.evaluate(() => {
        const box = document.getElementById("slashMenu");
        if (!box) return { vis: false };
        const items = [...box.querySelectorAll(".sc-item[data-i]")];
        const first = items[0];
        const r1 = first && first.querySelector(".sc-row1 .sc-name");
        const r2 = first && first.querySelector(".sc-row2 .sc-desc");
        return {
          vis: box.style.display !== "none",
          n: items.length,
          selIdx: items.findIndex((el) => el.classList.contains("sel")),
          name: r1 ? r1.textContent : "",
          desc: r2 ? r2.textContent : "",
          nameTop: r1 ? r1.getBoundingClientRect().top : 0,
          descTop: r2 ? r2.getBoundingClientRect().top : 0,
          nameFam: r1 ? getComputedStyle(r1).fontFamily : "",
          descColor: r2 ? getComputedStyle(r2).color : "",
          nameColor: r1 ? getComputedStyle(r1).color : "",
          selBg: first && first.classList.contains("sel") ? getComputedStyle(first).backgroundColor : "",
        };
      });
    const m0 = await menu();
    check("P1-5 输入 / 打开菜单", m0.vis === true && m0.n > 0, "n=" + m0.n);
    check("P1-5 双行结构(.sc-row1 .sc-name + .sc-row2 .sc-desc)", !!m0.name && !!m0.desc && /^\//.test(m0.name) && m0.descTop > m0.nameTop, JSON.stringify({ name: m0.name, desc: m0.desc }));
    check("P1-5 说明行与命令名视觉分级(字号/颜色不同源)", m0.descColor !== m0.nameColor, m0.nameColor + " vs " + m0.descColor);
    check("P1-5 首项 .sel 选中(高亮背景非透明)", m0.selIdx === 0, "selIdx=" + m0.selIdx + " bg=" + m0.selBg);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const m1 = await menu();
    check("P1-5 ArrowDown 移选中到第 2 项", m1.selIdx === 1, "selIdx=" + m1.selIdx);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(120);
    const m2 = await menu();
    check("P1-5 ArrowUp 回到第 1 项", m2.selIdx === 0, "selIdx=" + m2.selIdx);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("P1-5 Escape 关闭菜单", !(await page.locator("#slashMenu").isVisible()));
    await page.fill("#instruction", "/zzzz");
    await page.waitForTimeout(180);
    const empty = await page.evaluate(() => {
      const box = document.getElementById("slashMenu");
      const et = box && box.querySelector(".sc-empty-t");
      return { vis: !!box && box.style.display !== "none", txt: et ? et.textContent : "", items: box ? box.querySelectorAll(".sc-item[data-i]").length : -1 };
    });
    check("P1-5 无匹配 → 空态主提示「输入内容以搜索命令」", empty.vis && empty.txt === "输入内容以搜索命令" && empty.items === 0, JSON.stringify(empty));
    await page.keyboard.press("Escape");
  }

 // ============ P1-6 消息级文件变更摘要条 ============
  if (want("P1-6")) {
    const sum = await page.evaluate(() => {
      msgActBind(); // 生产路径在 renderHistory 内一次性挂委托;本项直注入 DOM,显式走同一入口
      ED_TURN = newEdTurn();
      edTurnAdd(JSON.stringify({ path: "a.ts", old_string: "x", new_string: "x\ny\nz" }), "edit_file"); // +3 -1
      edTurnAdd(JSON.stringify({ path: "a.ts", old_string: "q\nw", new_string: "q" }), "edit_file"); // +1 -2
      edTurnAdd(JSON.stringify({ path: "b.md", content: "1\n2\n3\n4" }), "write_file"); // +4 -0
      MSGSUM["k-sum"] = msgSumModalHtml(ED_TURN);
      MSGSUMSUB["k-sum"] = "本轮 3 次编辑";
      const perCall = { add: 3 + 1 + 4, del: 1 + 2 + 0 };
      const host = document.getElementById("chatBody");
      host.innerHTML = '<div class="task-reply"><p>终稿结论</p></div>' + msgSumBarHtml("k-sum", ED_TURN) + msgActsHtml({ time: Date.now() }, "k-sum");
      const bar = host.querySelector(".msg-sum");
      return {
        n: ED_TURN.n,
        files: ED_TURN.list.length,
        add: ED_TURN.add,
        del: ED_TURN.del,
        list: ED_TURN.list.map((i) => ({ p: i.path, a: i.add, d: i.del, c: i.calls })),
        perCall,
        barTxt: bar.textContent,
        barAdd: bar.querySelector(".ms-add").textContent,
        barDel: bar.querySelector(".ms-del").textContent,
        addColor: getComputedStyle(bar.querySelector(".ms-add")).color,
        delColor: getComputedStyle(bar.querySelector(".ms-del")).color,
        hasBtn: !!bar.querySelector('[data-msgact="sum"]'),
      };
    });
    check("P1-6 三次编辑调用聚合(文件去重=2)", sum.n === 3 && sum.files === 2, JSON.stringify(sum.list));
    check("P1-6 同文件多次编辑行数累加", sum.list.some((i) => i.p === "a.ts" && i.a === 4 && i.d === 3 && i.c === 2) && sum.list.some((i) => i.p === "b.md" && i.a === 4 && i.d === 0), JSON.stringify(sum.list));
    check("P1-6 摘要条文案「N 个文件已更改」", /2 个文件已更改/.test(sum.barTxt), sum.barTxt);
    check("P1-6 +A/-D 与逐条求和一致", Number(sum.barAdd.slice(1)) === sum.add && Number(sum.barDel.slice(1)) === sum.del && sum.add === sum.perCall.add && sum.del === sum.perCall.del, JSON.stringify({ bar: sum.barAdd + "/" + sum.barDel, agg: sum.add + "/" + sum.del, perCall: sum.perCall }));
    check("P1-6 +A 绿 / -D 红(前景色互异)", sum.addColor !== sum.delColor, sum.addColor + " vs " + sum.delColor);
    check("P1-6 摘要条带「查看改动」入口", sum.hasBtn && /查看改动/.test(sum.barTxt));
    await page.click('[data-msgact="sum"]');
    await page.waitForTimeout(250);
    const modal = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".ms-diff-row")];
      return { n: rows.length, paths: rows.map((r) => (r.querySelector(".msf-path") || {}).textContent || "") };
    });
    check("P1-6 点「查看改动」出逐文件清单(行数=去重文件数)", modal.n === 2 && modal.paths.includes("a.ts") && modal.paths.includes("b.md"), JSON.stringify(modal));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

 // ============ P1-7 消息操作栏 ============
  if (want("P1-7")) {
    const acts = await page.evaluate(() => {
      msgActBind(); // 同上:委托入口与生产同源
      const ts = new Date();
      ts.setHours(11, 13, 0, 0);
      MSGRAW["k-act"] = "# 结论\n\n统一测试通过 ✅";
      MSGQ["k-act"] = "> [" + msgHm(ts.getTime()) + "] 统一测试通过 ✅";
      const host = document.getElementById("chatBody");
      host.innerHTML = '<div class="task-reply"><p>正文</p></div>' + msgActsHtml({ time: ts.getTime() }, "k-act") + msgActsHtml({ time: Date.now() }, "k-act");
      const bars = [...host.querySelectorAll(".msg-acts")];
      return {
        n: bars.length,
        time: bars[0].querySelector(".ma-time") ? bars[0].querySelector(".ma-time").textContent : "",
        timeFam: getComputedStyle(bars[0].querySelector(".ma-time")).fontFamily,
        opacity: getComputedStyle(bars[0]).opacity,
        copyBtn: !!bars[0].querySelector('[data-msgact="copy"]'),
        quoteBtn: !!bars[0].querySelector('[data-msgact="quote"]'),
      };
    });
    check("P1-7 终稿消息恒带 .msg-acts 操作栏", acts.n === 2 && acts.copyBtn && acts.quoteBtn, JSON.stringify(acts));
    check("P1-7 .ma-time 形如 HH:MM", /^\d{2}:\d{2}$/.test(acts.time) && acts.time === "11:13", acts.time);
    check("P1-7 操作栏缺省低调(hover 才显形)", Number(acts.opacity) < 1, "opacity=" + acts.opacity);
    await page.click('[data-msgact="copy"]');
    await page.waitForTimeout(400);
    const clip = await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) {
        const v = await Promise.resolve(navigator.clipboard.readText()).catch(() => "");
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await Promise.resolve(navigator.clipboard.readText()).catch(() => "");
    });
    check("P1-7 复制内容=消息原文(markdown)", clip === "# 结论\n\n统一测试通过 ✅", JSON.stringify(clip));
    await page.click('[data-msgact="quote"]');
    await page.waitForTimeout(400);
    const q = await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) {
        const v = await Promise.resolve(navigator.clipboard.readText()).catch(() => "");
        if (v && v !== "# 结论\n\n统一测试通过 ✅") return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await Promise.resolve(navigator.clipboard.readText()).catch(() => "");
    });
    check("P1-7 引用产出「> [HH:MM] …」", /^> \[\d{2}:\d{2}\] /.test(q) && q.startsWith("> [11:13] "), JSON.stringify(q));
  }

 // ============ P1-8 任务级 sticky 状态胶囊 ============
  if (want("P1-8")) {
    const cap0 = await page.evaluate(() => {
      currentSid = "s-cap";
      tasks.set("s-cap", { sessionId: "s-cap", state: "done", title: "统一测试任务", updatedAt: Date.now() });
      histEvents = [{ kind: "message.agent", payload: { text: "统一测试 138/138 绿+tsc 0+部署完成" } }];
      const body = document.getElementById("chatBody");
      body.innerHTML = "";
      for (let i = 0; i < 80; i++) {
        const d = document.createElement("div");
        d.className = "task-reply";
        d.style.height = "120px";
        d.textContent = "内容块 " + i;
        body.appendChild(d);
      }
      const vt = document.getElementById("view-tasks");
      vt.scrollTop = 0;
      taskCapRender();
      const cap = document.getElementById("taskCap");
      const cs = cap ? getComputedStyle(cap) : null;
      return {
        exists: !!cap,
        state: cap ? cap.getAttribute("data-cap-state") : "",
        txt: cap ? cap.querySelector(".tc-txt").textContent : "",
        pos: cs ? cs.position : "",
        z: cs ? cs.zIndex : "",
        canScroll: vt.scrollHeight > vt.clientHeight * 3,
        top: cap ? cap.getBoundingClientRect().top : -1,
      };
    });
    check("P1-8 #taskCap 存在且 data-cap-state=ok", cap0.exists && cap0.state === "ok", JSON.stringify(cap0));
    check("P1-8 胶囊 sticky/absolute 定位且 z-index ≤50", (cap0.pos === "sticky" || cap0.pos === "absolute") && Number(cap0.z) <= 50, cap0.pos + " z=" + cap0.z);
    check("P1-8 终态无计时文本", !/\d+\s*(秒|分钟|小时|分)/.test(cap0.txt) && /统一测试/.test(cap0.txt), cap0.txt);
    check("P1-8 聊天区可滚动 ≥3 屏(前置)", cap0.canScroll);
    await page.evaluate(() => {
      const vt = document.getElementById("view-tasks");
      vt.scrollTop = vt.clientHeight * 3;
    });
    await page.waitForTimeout(200);
    const cap1 = await page.evaluate(() => {
      const vt = document.getElementById("view-tasks");
      const cap = document.getElementById("taskCap");
      const r = cap.getBoundingClientRect();
      const vr = vt.getBoundingClientRect();
      return { scrollTop: vt.scrollTop, top: r.top, h: r.height, inView: r.height > 0 && r.top >= vr.top - 2 && r.bottom <= vr.bottom + 2, txt: cap.querySelector(".tc-txt").textContent };
    });
    check("P1-8 滚动 3 屏后胶囊仍在视口内(sticky 生效)", cap1.scrollTop > 500 && cap1.inView, JSON.stringify(cap1));
  }

  check("控制台无错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  await browser.close();
  panel.close();
  const failed = results.filter((r) => !r.ok);
  console.log((ITEM || "ALL") + ": " + (results.length - failed.length) + "/" + results.length + " 通过");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.log("FAIL 探针崩溃 — " + String(e && e.stack ? e.stack : e).slice(0, 600));
  process.exit(1);
});