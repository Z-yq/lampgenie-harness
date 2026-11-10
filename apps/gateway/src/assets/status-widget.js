/* 会话进度小窗(ZCode ConversationStatusPanel 对应物)
 * 形态:当前会话对话视图(#view-tasks)右上角胶囊簇 + 点按展开明细卡;会话空闲自动隐藏
 * (ZCode「无活动内容不渲染」同款纪律)。
 * 自包含:自挂载、自有 WS 连接(不碰面板内部 ws/currentSid 状态,只读全局 currentSid 若可见);
 * 挂点缺失(面板改版)→ 静默不渲染,零报错。
 * 数据:WS session.status(2s 轮询)+ task.list(找无 currentSid 时的最新运行任务)。 */
(function () {
  "use strict";
  var POLL_MS = 2000;

  function boot() {
    var host = document.getElementById("view-tasks");
    if (!host) return; // 面板改版无挂点:静默降级
    var style = document.createElement("style");
    style.textContent = [
      "#sw-root{position:absolute;top:6px;right:10px;z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;font-family:inherit}",
      "#sw-bar{display:none;gap:6px;pointer-events:auto;align-items:center;flex-wrap:wrap;max-width:min(560px,62vw);justify-content:flex-end}",
      "#sw-bar.on{display:flex}",
      ".sw-pill{font-family:var(--mono,monospace);font-size:10px;letter-spacing:.4px;color:var(--bronze,#c9a25e);background:var(--glass2,rgba(30,24,16,.74));border:1px solid var(--border-soft,rgba(201,162,94,.25));border-radius:999px;padding:2px 10px;cursor:pointer;display:flex;gap:6px;align-items:center;backdrop-filter:blur(6px)}",
      ".sw-pill .icn{width:10px;height:10px;flex-shrink:0}",
      ".sw-pill:hover{border-color:var(--bronze,#c9a25e)}",
      ".sw-pill b{color:var(--text,#e8dcc6);font-weight:600}",
      ".sw-bar-track{display:inline-block;width:34px;height:3px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden}",
      ".sw-bar-track i{display:block;height:100%;background:var(--bronze,#c9a25e);transition:width .4s}",
      "#sw-card{display:none;position:absolute;top:28px;right:0;width:300px;max-height:56vh;overflow:auto;background:var(--glass2,rgba(24,19,12,.93));border:1px solid var(--border-soft,rgba(201,162,94,.3));border-radius:12px;padding:12px 14px;pointer-events:auto;backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(0,0,0,.4)}",
      "#sw-card.on{display:block}",
      "#sw-card h4{margin:8px 0 6px;font-size:9px;letter-spacing:2px;color:var(--faint,#a3937a);font-weight:600}",
      "#sw-card h4:first-child{margin-top:0}",
      ".sw-todo{display:flex;gap:7px;align-items:flex-start;font-size:11px;color:var(--text,#e8dcc6);line-height:1.5;padding:2px 0}",
      ".sw-todo .dot{width:8px;height:8px;border-radius:50%;border:1px solid var(--bronze,#c9a25e);flex:none;margin-top:4px}",
      ".sw-todo.completed{color:var(--faint,#a3937a);text-decoration:line-through}",
      ".sw-todo.completed .dot{background:var(--bronze,#c9a25e)}",
      ".sw-todo.in_progress .dot{background:var(--accent-bright,#7a5423);animation:swBreath 1.6s infinite}",
      "@keyframes swBreath{50%{box-shadow:0 0 7px var(--bronze,#c9a25e)}}",
      ".sw-kv{font-family:var(--mono,monospace);font-size:10px;color:var(--muted,#8d8272);padding:1px 0}",
      ".sw-kv b{color:var(--text,#e8dcc6)}",
      ".sw-cap{margin:4px 0 2px}",
      ".sw-cap-label{display:flex;justify-content:space-between;font-family:var(--mono,monospace);font-size:10px;color:var(--text,#e8dcc6);margin-bottom:4px}",
      ".sw-cap-label .pct{color:var(--muted,#8d8272)}",
      ".sw-cap-track{height:5px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}",
      ".sw-cap-track i{display:block;height:100%;background:var(--bronze,#c9a25e);transition:width .5s}",
      ".sw-cap-track i.hot{background:var(--red,#e08a7a)}",
      ".sw-hit{display:flex;justify-content:space-between;font-size:10px;color:var(--muted,#8d8272);margin-top:4px}",
 /* 召回·审途重设计:分组标题 + 指标瓦片 + 任务条 */
      ".sw-hd{display:flex;align-items:center;gap:8px;margin:13px 0 8px}",
      ".sw-hd:first-child{margin-top:0}",
      ".sw-hd-t{font-family:var(--mono,monospace);font-size:9px;letter-spacing:2.6px;color:var(--faint,#a3937a)}",
      ".sw-hd:after{content:'';flex:1;height:1px;background:linear-gradient(90deg,rgba(201,162,94,.26),rgba(201,162,94,0))}",
      ".sw-hd .sw-tbtn{font-size:8px;padding:1px 8px}",
      ".sw-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}",
      ".sw-tile{border:1px solid rgba(201,162,94,.18);border-radius:9px;padding:6px 8px;min-width:0;",
      "  background:linear-gradient(180deg,rgba(201,162,94,.075),rgba(201,162,94,.015))}",
      ".sw-tile .k{font-family:var(--mono,monospace);font-size:8px;letter-spacing:.9px;color:var(--faint,#a3937a);",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".sw-tile .v{font-size:15px;font-weight:600;color:var(--text,#e8dcc6);margin-top:1px;font-variant-numeric:tabular-nums;",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".sw-tile .s{font-family:var(--mono,monospace);font-size:8px;color:var(--faint,#a3937a);margin-top:1px;",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".sw-tile.run .v{color:var(--bronze,#c9a25e)}",
      ".sw-tile.hot .v{color:#e08a7a}",
      ".sw-cap2{margin:2px 0 10px}",
      ".sw-cap2-r{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--mono,monospace);font-size:9px;color:var(--faint,#a3937a)}",
      ".sw-cap2-r .v{font-size:12px;color:var(--text,#e8dcc6);font-weight:600;font-variant-numeric:tabular-nums}",
      ".sw-cap2-r .v.hot{color:#e08a7a}",
      ".sw-cap2-r.sub{margin-top:3px;font-size:8.5px}",
      ".sw-task{display:flex;align-items:flex-start;gap:8px;border:1px solid rgba(201,162,94,.18);border-radius:9px;",
      "  padding:7px 9px;background:rgba(201,162,94,.045)}",
      ".sw-task+.sw-task{margin-top:5px}",
      ".sw-task .st{font-family:var(--mono,monospace);font-size:8px;letter-spacing:.6px;padding:1px 7px;border-radius:999px;",
      "  border:1px solid var(--border-soft,rgba(201,162,94,.3));color:var(--faint,#a3937a);flex:none;margin-top:1px;white-space:nowrap}",
      ".sw-task .st.run{color:var(--bronze,#c9a25e);border-color:var(--bronze,#c9a25e)}",
      ".sw-task .st.ok{color:#9dc08b;border-color:rgba(157,192,139,.5)}",
      ".sw-task .st.fail{color:#e08a7a;border-color:rgba(224,138,122,.5)}",
      ".sw-task .tx{font-size:11px;line-height:1.45;color:var(--text,#e8dcc6);min-width:0;overflow-wrap:anywhere}",
      ".sw-sa-fold{margin-top:5px;font-size:9px;letter-spacing:.8px;color:var(--faint,#a3937a);border:1px dashed rgba(201,162,94,.25);border-radius:8px;padding:4px 9px;cursor:pointer;text-align:center}",
      ".sw-sa-fold:hover{color:var(--bronze,#c9a25e);border-color:var(--bronze,#c9a25e)}",
 /* 卡宿主形态( 召回·审途独立看板卡,与对话卡同列)——
         画布形态挂 #recap-body:静态布局常显详情卡;经典布局维持原视口悬浮。 */
      "#sw-root.in-card{position:static;align-items:stretch;pointer-events:auto;width:100%}",
      "#sw-root.in-card #sw-bar{display:none!important}",
      "#sw-root.in-card #sw-card{display:block;position:static;width:auto;max-height:none;box-shadow:none}",
    ].join("\n");
    document.head.appendChild(style);

    var root = document.createElement("div");
    root.id = "sw-root";
    root.innerHTML = '<div id="sw-bar"></div><div id="sw-card"></div>';
    var bar = root.querySelector("#sw-bar");
    var card = root.querySelector("#sw-card");
    bar.addEventListener("click", function () { card.classList.toggle("on"); });
 // 自愈挂载:面板重渲染会 innerHTML 重建 #view-tasks(经验证挂上即被抹)——
    // 观察宿主 childList,丢失立即重挂;宿主本身被换则 body 级观察兜底 + tick 内 2s 兜底。
 // 视口钉住( 视频:胶囊簇随消息滚走+滚动途中滑过内容=「置顶消失/重叠」主诉)——
    // absolute 的 top 按宿主 scrollTop 实时回写(rAF 节流),视觉等同 sticky 且不改面板布局流。
    var hostRef = null;
    var pinRaf = 0;
    function pinToViewport() {
      pinRaf = 0;
      if (!hostRef) return;
      root.style.top = (hostRef.scrollTop + 6) + "px";
    }
    function queuePin() {
      if (pinRaf) return;
      pinRaf = requestAnimationFrame(pinToViewport);
    }
    function mount() {
 // 宿主选择( 融合板):优先「任务追踪」卡的召回·审途区(sw-slot);
      // 不在场(异常/旧页面)兜底对话视图悬浮。
      var h = document.getElementById("sw-slot") || document.getElementById("view-tasks");
      if (!h) return false;
      var cardHost = h.id === "sw-slot";
      if (root.classList.contains("in-card") !== cardHost) root.classList.toggle("in-card", cardHost);
      if (h !== hostRef) { // 宿主被换(含画布↔经典切换):旧监听随旧节点销毁,重挂滚动跟随
        if (hostRef) hostRef.removeEventListener("scroll", queuePin);
        hostRef = h;
        if (!cardHost) h.addEventListener("scroll", queuePin, { passive: true });
        var cur = document.getElementById("sw-root");
        if (cur && cur.parentElement && cur.parentElement !== h) cur.parentElement.removeChild(cur); // 换宿主:先摘再挂
      }
      if (!document.getElementById("sw-root")) {
        if (!cardHost && getComputedStyle(h).position === "static") h.style.position = "relative";
        h.appendChild(root);
        if (!cardHost) queuePin();
      }
      return true;
    }
    mount();
    var remountQueued = false;
    function queueRemount() {
      if (remountQueued) return;
      remountQueued = true;
      requestAnimationFrame(function () { remountQueued = false; mount(); });
    }
    var hostObs = new MutationObserver(queueRemount);
    hostObs.observe(host, { childList: true });
    var bodyObs = new MutationObserver(queueRemount);
    bodyObs.observe(document.body, { childList: true, subtree: false, attributeFilter: ["class"] }); // class 变化=画布↔经典切换,重选宿主

    var ws = null;
    /**
     * 全量收件箱定长(P2):这里只留最近 200 条给诊断用
     * ——不设上限会让面板长连时内存随消息数线性增长(旧代码只 push 不裁剪)。
     */
    var INBOX_MAX = 200;
    var inbox = [];
    var latest = { status: null, tasks: [], trace: null };
    var tickTimer = null;
    function connect() {
      try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host); }
      catch (_) { ws = null; return; }
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (_) { return; }
        inbox.push(m); // 全量收件箱留档(定长裁剪见下)
        if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX); // 定长 200:只留最近 200 条给其它诊断用
        if (m.type === "session.status.result") latest.status = m.status;
        if (m.type === "trace.stats.result") latest.trace = m.stats;
        if (m.type === "task.list") latest.tasks = m.tasks || [];
      };
      ws.onopen = function () {
        poll();
        tickTimer = setInterval(tick, POLL_MS);
      };
      ws.onclose = function () { if (tickTimer) clearInterval(tickTimer); setTimeout(connect, 3000); };
    }
    function trackedSid() {
 // 严格跟随当前选中会话(每个 session 独立一份,草稿态隐藏)——不做「最近任务」全局回退
      try { if (typeof currentSid !== "undefined") return currentSid || null; } catch (_) { /* 面板变量不可见 */ }
      var running = latest.tasks.filter(function (t) { return t.state === "running" || t.state === "queued"; });
      return running.length ? running[0].sessionId : null; // 兜底:仅运行中任务
    }
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function poll() {
      send({ v: 1, type: "task.list" });
      var sid = trackedSid();
      if (sid) { send({ v: 1, type: "session.status", sessionId: sid }); send({ v: 1, type: "trace.stats", sessionId: sid }); }
      else { latest.status = null; latest.trace = null; } // 草稿态/无选中:清数据→render 隐藏
    }

    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    // 胶囊可见性同步到宿主 class:面板 CSS 据此给置顶状态条预留右侧空间(chips 不钻到胶囊底下)
    function syncHostClass(on) {
      try { if (hostRef) hostRef.classList.toggle("sw-active", !!on); } catch (_) { /* 宿主不可见 */ }
    }
 // token 数字单位:
    // 1e9→B / 1e6→M / 1e3→K,小于千给原数;不再用「万/亿」。
    function fmtTok(n) {
      var v = Number(n) || 0;
      if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
      if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(Math.round(v));
    }
    // 金额(元):≥1 两位小数;<1 到 1 分三位、更小四位——小额不能显示成 0.00。null=未配单价。
    function fmtYuan(a) {
      if (a === null || a === undefined) return "—";
      var v = Number(a) || 0;
      if (Math.abs(v) >= 1) return v.toFixed(2);
      if (Math.abs(v) >= 0.01) return v.toFixed(3);
      return v.toFixed(4);
    }
    function fmtS(ms) { return ms >= 10000 ? Math.round(ms / 1000) + "s" : (Math.round(ms / 100) / 10) + "s"; }
    function mmss(ms) { var s = Math.max(0, Math.floor(ms / 1000)); var m = Math.floor(s / 60); s = s % 60; return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }

    var saFoldAll = false, saFoldAllNext = false; // 子代理折叠态:next=用户意图,render 时前移(防 2s 重渲回跳)
    function render() {
 // 子代理列表折叠态:跨 2s 轮询重渲保持,「只看最近 3 条↔展开全部」
      saFoldAll = saFoldAllNext;
 // 防御( 重设计):只有轨迹、status 尚未到达时也不崩(旧代码在 hasTrace 分支
      // 已隐含要求 st 非空;卡片区新增字段引用后显式归一)。
      var st = latest.status || { task: null, todo: { completed: 0, total: 0, items: [] }, subagents: { spawnCount: 0, resultCount: 0, running: 0 }, workflows: [] };
      var tr0 = latest.trace;
      var hasTrace = tr0 && (tr0.turns > 0 || tr0.toolCalls > 0);
      var active = st && st.task && (st.task.state === "running" || st.task.state === "queued");
      var hasTodo = st && st.todo && st.todo.total > 0;
      var wfActive = st && st.workflows && st.workflows.some(function (w) { return !w.done; });
      var inCard = root.classList.contains("in-card");
      if (!active && !hasTodo && !hasTrace) {
        bar.classList.remove("on");
        if (inCard) { card.classList.add("on"); card.innerHTML = '<div style="padding:8px 2px;font-size:12px;color:var(--muted,#a3937a)">等待会话数据——选中一个会话后,上下文变量/命中率/耗时/子代理状态在此实时展示</div>'; }
        else card.classList.remove("on");
        syncHostClass(false); return;
      }
      bar.classList.add("on");
      syncHostClass(true);
      var pills = [];
 // 「计划」胶囊已撤( 追踪 Trace 里的计划全部并入 turn 树,
      // 一级 turn → 二级五阶段 → 三级阶段任务;todo 不再单独展示)。hasTodo 仍参与下方空态判定,
      // 防止「只有 todo 在跑」时整个胶囊条误隐藏。
      if (st.subagents.running > 0) pills.push('<span class="sw-pill" title="运行中子代理"><svg class="icn" viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="10" height="10" rx="1.5"/><path d="M9 19.5h10.5V9"/><path d="M14.5 19.5v-5h5.5"/></svg> <b>' + st.subagents.running + "</b></span>");
      if (wfActive) {
        var asks = st.workflows.filter(function (w) { return !w.done; }).reduce(function (a, w) { return a + w.asks; }, 0);
        pills.push('<span class="sw-pill" title="workflow 已派发"><svg class="icn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3"/><path d="M12 18.2v3"/><path d="M2.8 12h3"/><path d="M18.2 12h3"/><path d="M5.5 5.5l2.1 2.1"/><path d="M16.4 16.4l2.1 2.1"/><path d="M18.5 5.5l-2.1 2.1"/><path d="M7.6 16.4l-2.1 2.1"/></svg> <b>' + asks + "</b></span>");
      }
      var tr = latest.trace;
 // 估算标记:/compact 后 contextTokens 是按「摘要+台账+tail」估算的(压缩当下没有
 // 真实调用可测),下一次 LLM 调用才会用经验证覆盖。这里加「≈」前缀,不把估算当经验证展示。
      var cpApprox = tr && tr.contextEstimated ? "≈" : "";
      if (tr && (tr.contextTokens ?? 0) > 0 && (tr.contextWindow ?? 0) > 0) {
        var cpPct = Math.min(99, Math.round((tr.contextTokens / tr.contextWindow) * 100));
        pills.push('<span class="sw-pill" title="上下文占用 ' + cpApprox + tr.contextTokens + "/" + tr.contextWindow + (tr.contextEstimated ? "(压缩后估算,下一次调用起为实测)" : "") + '"><svg class="icn" viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="15" height="15" rx="1.5"/><path d="M4.5 12h15"/><path d="M12 4.5v15"/></svg> <b>' + cpApprox + cpPct + "%</b></span>");
      }
      if (tr && tr.tokens && tr.tokens.total > 0) {
        pills.push('<span class="sw-pill" title="token 合计(输入 ' + tr.tokens.input + " / 输出 " + tr.tokens.output + ')"><svg class="icn" viewBox="0 0 24 24"><path d="M12 4l6.5 8-6.5 8-6.5-8z"/></svg> <b>' + fmtTok(tr.tokens.total) + "</b></span>");
        if (tr.tokens.cached > 0 && tr.tokens.input > 0) {
          var hit = Math.round((tr.tokens.cached / tr.tokens.input) * 100);
          pills.push('<span class="sw-pill" title="提示缓存命中(' + tr.tokens.cached + "/" + tr.tokens.input + ')">命中 <b>' + hit + "%</b></span>");
        }
      }
      if (tr && (tr.llmMs > 0 || tr.toolMs > 0)) {
        pills.push('<span class="sw-pill" title="LLM 累计耗时(最长单次 ' + Math.round(tr.llmMsMax / 100) / 10 + 's)"><svg class="icn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.5"/></svg> llm <b>' + fmtS(tr.llmMs) + "</b></span>");
        if (tr.toolMs > 0) pills.push('<span class="sw-pill" title="工具执行累计"><svg class="icn" viewBox="0 0 24 24"><path d="M14.8 6.3a4.2 4.2 0 0 0-5.6 5L4 16.5V20h3.5l5.2-5.2a4.2 4.2 0 0 0 5-5.6l-2.9 2.9-2.9-2.9z"/></svg> <b>' + fmtS(tr.toolMs) + "</b></span>");
      }
      if (active) pills.push('<span class="sw-pill sw-clock" title="任务耗时"><svg class="icn" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2.5"/></svg> <b>' + mmss(Date.now() - st.task.createdAt) + "</b></span>");
      bar.innerHTML = pills.join("");

      var c = [];
      var tr2 = latest.trace;
 // 重设计:
      // 标题行 + 上下文主视觉 + 指标瓦片网格(2×3);「计划」列表整体撤除(已并入追踪卡的 turn 树)。
      function tile(k, v, sub, cls) {
        return '<div class="sw-tile' + (cls ? " " + cls : "") + '"><div class="k">' + esc(k) + "</div>" +
          '<div class="v">' + esc(String(v)) + "</div>" + (sub ? '<div class="s">' + esc(sub) + "</div>" : "") + "</div>";
      }
      var hasTraceData = !!(tr2 && (tr2.turns > 0 || tr2.llmCalls > 0 || tr2.toolCalls > 0 || (tr2.contextTokens ?? 0) > 0));
      if (hasTraceData) {
        c.push('<div class="sw-hd"><span class="sw-hd-t">追 踪</span></div>');
        // ① 上下文容量:主视觉(百分比 + 双色进度条 + 绝对量/缓存命中)
        var ctxN = tr2.contextTokens ?? 0;
        var ctxW = tr2.contextWindow ?? 0;
        if (ctxN > 0 && ctxW > 0) {
          var cp = Math.min(100, Math.round((ctxN / ctxW) * 100));
          var hr = tr2.tokens.input > 0 ? Math.round((tr2.tokens.cached / tr2.tokens.input) * 100) : 0;
          c.push('<div class="sw-cap2"><div class="sw-cap2-r"><span>上下文容量</span><span class="v' + (cp >= 80 ? " hot" : "") + '">' + cp + "%</span></div>" +
            '<div class="sw-cap-track"><i class="' + (cp >= 80 ? "hot" : "") + '" style="width:' + cp + '%"></i></div>' +
            '<div class="sw-cap2-r sub"><span>' + fmtTok(ctxN) + " / " + fmtTok(ctxW) + "</span><span>缓存命中 " + hr + "%</span></div></div>");
        }
        // ② 指标瓦片:turn/step、LLM 次数与耗时、工具、token 进出
        var tps = tr2.decodeTps ? Math.round(tr2.decodeTps * 10) / 10 : 0;
        c.push('<div class="sw-grid">' +
          tile("turn", tr2.turns, "step " + tr2.steps) +
          tile("LLM 调用", tr2.llmCalls, "最长 " + fmtS(tr2.llmMsMax)) +
          // 失败调用(txa5):只在有失败时多一格——零失败不占版面,也不给旧服务端添「恒 0」假信号
          (tr2.llmFailures > 0 ? tile("LLM 失败", tr2.llmFailures, "累计 " + fmtS(tr2.failedLlmMs || 0)) : "") +
          tile("LLM 累计", fmtS(tr2.llmMs), tps ? tps + " tok/s" : "") +
          tile("工具", tr2.toolCalls, "累计 " + fmtS(tr2.toolMs)) +
          tile("输入 tok", fmtTok(tr2.tokens.input), tr2.tokens.cached > 0 ? "缓存 " + fmtTok(tr2.tokens.cached) : "") +
          tile("输出 tok", fmtTok(tr2.tokens.output), "合计 " + fmtTok(tr2.tokens.total)) +
          "</div>");
 // ②b 成本:
        // 数据源=trace.stats.costModels(服务端按模型用量 × 该模型单价算的四段成本)。
        // 计费门:只有 authMode=api 的端点出金额——token-plan(套餐)已包月,再算「花了多少钱」是假账,
        // 只如实标「套餐 · 不计费」。单价缺失的段显示「未配单价」,绝不按 0 元冒充真账。
        var cms = tr2.costModels;
        if (cms && cms.length) {
          var billed = cms.filter(function (x) { return x && x.billed; });
          var plan = cms.filter(function (x) { return x && !x.billed; });
          var tk = { cr: 0, cw: 0, im: 0, ou: 0 };
          var amt = { cr: 0, cw: 0, im: 0, ou: 0 };
          var missSeg = Object.create(null);
          var anyCost = false, anyNull = false;
          billed.forEach(function (x) {
            var cst = x.cost;
            if (!cst) { anyNull = true; return; }
            anyCost = true;
            [["cr", "cacheRead"], ["cw", "cacheWrite"], ["im", "inputMiss"], ["ou", "output"]].forEach(function (s) {
              var sec = cst[s[1]];
              if (!sec) return;
              tk[s[0]] += sec.tokens || 0;
              if (sec.amount === null) { if ((sec.tokens || 0) > 0) missSeg[s[0]] = true; }
              else amt[s[0]] += sec.amount;
            });
          });
          if (anyCost) {
            var complete = !Object.keys(missSeg).length && !anyNull;
            var totalAmt = complete ? amt.cr + amt.cw + amt.im + amt.ou : null;
            c.push('<div class="sw-hd"><span class="sw-hd-t">成 本（元）</span></div>');
            c.push('<div class="sw-kv">合计 <b>' + (totalAmt === null ? "—" : "¥" + fmtYuan(totalAmt)) + "</b>" +
              (totalAmt === null ? " · 部分段未配单价" : "") + "</div>");
            [["cr", "缓存命中"], ["cw", "缓存写入"], ["im", "未命中"], ["ou", "输出"]].forEach(function (s) {
              if (s[0] === "cw" && !tk.cw) return; // 无缓存写入量(多数端点不下发)不占行
              c.push('<div class="sw-kv">' + s[1] + " <b>" + (missSeg[s[0]] ? "未配单价" : "¥" + fmtYuan(amt[s[0]])) + "</b>" +
                " · " + fmtTok(tk[s[0]]) + " tok</div>");
            });
 // 逐模型列出(2026-11 单模型也要列,
            // 否则单模型会话根本看不到模型名;多模型时各自单价算的金额也在此分清谁花的)。
            if (billed.length) {
              billed.forEach(function (x) {
                var line = x.cost && x.cost.total !== null ? "¥" + fmtYuan(x.cost.total) : (x.cost ? "部分未配单价" : "未配单价");
                c.push('<div class="sw-kv">· ' + esc(x.model) + " <b>" + line + "</b></div>");
              });
            }
          }
          if (plan.length) {
            c.push('<div class="sw-kv">套餐(token-plan)<b>不计费</b> · ' + esc(plan.map(function (x) { return x.model; }).join(" / ")) + "</div>");
          }
        }
      }
      // ③ 子代理:三瓦片(运行中非零时高亮)
      c.push('<div class="sw-hd"><span class="sw-hd-t">子 代 理</span></div>');
      c.push('<div class="sw-grid">' +
        tile("派发", st.subagents.spawnCount, "") +
        tile("完成", st.subagents.resultCount, "") +
        tile("运行中", st.subagents.running, "", st.subagents.running > 0 ? "run" : "") +
        "</div>");
 // ③b 子代理 token 消耗( 单独一窗,不并入上方主会话 token 瓦片)
      // 数据源=trace.stats.subagents(deriveTraceStats 按 agentId 聚合 subagent.event 的内层 usage)。
      var sa = tr2 && tr2.subagents;
      if (sa && sa.agents && sa.agents.length > 0) {
        var st2 = sa.totals || { input: 0, output: 0, total: 0, cached: 0, calls: 0, llmMs: 0 };
        var stHit = st2.input > 0 ? Math.round((st2.cached / st2.input) * 100) : 0;
        c.push('<div class="sw-hd"><span class="sw-hd-t">子 代 理 tok</span></div>');
        c.push('<div class="sw-grid">' +
          tile("输入 tok", fmtTok(st2.input), st2.cached > 0 ? "缓存 " + fmtTok(st2.cached) : "") +
          tile("输出 tok", fmtTok(st2.output), "合计 " + fmtTok(st2.total)) +
          tile("命中率", stHit + "%", st2.calls + " 次调用") +
          "</div>");
 // 子代理只列最近 3 条(按 lastAt 活动时间),其余折叠;点折叠条展开全部。
        var saSorted = sa.agents.slice().sort(function (x, y) { return (y.lastAt || 0) - (x.lastAt || 0); });
        var saShow = saFoldAll ? saSorted : saSorted.slice(0, 3);
        saShow.forEach(function (a) {
          if (!a) return;
          var name = a.title || a.agentId;
          if (!(a.calls > 0)) {
            // 外部后端不产生 loop 事件:如实标「无 token 数据」,不冒充 0 消耗
            c.push('<div class="sw-task"><span class="st">无数据</span><span class="tx">' + esc(name) + " · 该后端不上报 usage</span></div>");
            return;
          }
          var hit = a.input > 0 ? Math.round((a.cached / a.input) * 100) : 0;
          c.push('<div class="sw-task"><span class="st ' + (hit > 0 ? "ok" : "") + '">' + hit + "%</span>" +
            '<span class="tx">' + esc(name) + " · 入 " + fmtTok(a.input) + " / 出 " + fmtTok(a.output) +
            " · " + a.calls + " 次 · " + fmtS(a.llmMs) + "</span></div>");
        });
        if (saSorted.length > 3) {
          c.push('<div class="sw-sa-fold" data-sa-fold="' + (saFoldAll ? "less" : "more") + '">' +
            (saFoldAll ? "收起 · 只看最近 3 条" : "还有 " + (saSorted.length - 3) + " 个子代理 · 点击展开") + "</div>");
        }
      }
      // ④ 工作流(有则列,与瓦片同视觉语言)
      if (st.workflows.length) {
        c.push('<div class="sw-hd"><span class="sw-hd-t">工 作 流</span></div>');
        st.workflows.forEach(function (w) {
          c.push('<div class="sw-task"><span class="st ' + (w.done ? "ok" : "run") + '">' + (w.done ? "已结束" : "运行中") + "</span>" +
            '<span class="tx">' + esc(w.wfId) + " · 已派发 " + w.asks + "</span></div>");
        });
      }
 // ⑤ 任务区已撤( 「任务」应是最后一个数据窗口,由下方 turn 树承担——
      // 统计区再列一条 task 状态/指令会与 turn 一级节点重复)。
      card.innerHTML = c.join("");
    }
    // 子代理折叠条(事件委托,卡片每次重渲染)
    card.addEventListener("click", function (e) {
      var t = e.target;
      var fold = t && t.closest ? t.closest("[data-sa-fold]") : null;
      if (fold) { saFoldAllNext = fold.dataset.saFold === "more"; render(); }
    });

    function tick() { if (!document.getElementById("sw-root")) mount(); poll(); render(); }
    // 点击左侧会话即时切换浮窗数据(不等下个 2s 轮询)
    document.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest(".t-row")) setTimeout(tick, 200);
    }, true);
    setInterval(function () { // 秒表独立于轮询:running 时每秒刷时钟
      if (bar.classList.contains("on")) {
        var clock = bar.querySelector(".sw-clock b");
        if (clock && latest.status && latest.status.task) clock.textContent = mmss(Date.now() - latest.status.task.createdAt);
      }
    }, 1000);
    connect();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
