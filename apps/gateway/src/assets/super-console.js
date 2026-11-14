/* super-console.js — Super Agent 指挥台(自包含资产:零构建/零外链/零 emoji/无音频播放)
 * 契约: 
 *   出站: super.turn {text} / super.history {sinceSeq} / super.inbox {limit}
 *          voice.transcribe {audioB64,format,sampleRate} / permission.respond / ask.user.answer / task.resume / task.list
 *   入站: super.turn.user / super.turn.done / super.history.result / super.relay / super.notice
 *          super.inbox.result / super.inbox.changed / voice.transcribe.result
 * 根元素:#superConsole(固定右缘,脚本自建、被面板重渲染抹掉时自愈重挂)
 * 内层:#sc-root(指挥台本体;面板 CSS 用它做 board/cv-shell/pp-wiki-tab 退场)
 */
(function () {
  "use strict";
  if (window.__superConsoleBooted) return;
  window.__superConsoleBooted = true;

  var LS_DISMISS = "sc:dismissed";
  var LS_VOICE = "sc:voice";
  var MAX_ACTIVITY = 20;

  var state = {
    items: [],          // SuperInboxItem[]
    activity: [],       // super.notice[]
    turns: [],          // {role,text}
    tasks: [],
    history: [],
    ws: null,
    wsOpen: false,
    retry: 0,
    pendingOpen: true,
    overlay: false,
    tab: "inbox",
    asrWaiting: false,
    rec: null            // {ctx,stream,chunks}
  };

  // ---------------- utils ----------------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clip(s, n) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  }
  function hhmm(ms) {
    var d = new Date(typeof ms === "number" && isFinite(ms) ? ms : Date.now());
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  function dismissed() {
    try { var a = JSON.parse(localStorage.getItem(LS_DISMISS) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function dismiss(id) {
    var a = dismissed();
    if (a.indexOf(id) < 0) a.push(id);
    try { localStorage.setItem(LS_DISMISS, JSON.stringify(a.slice(-300))); } catch (e) { /* 私隐模式忽略 */ }
  }
  function voiceEnabled() { try { return localStorage.getItem(LS_VOICE) === "1"; } catch (e) { return false; } }
  function toast(msg, bad) {
    try {
      if (typeof window.toast === "function") { window.toast(msg, !!bad); return; }
    } catch (e) { /* 面板 toast 不可用则自绘 */ }
    var t = el("sc-toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "on" + (bad ? " bad" : "");
    clearTimeout(t.__tm);
    t.__tm = setTimeout(function () { t.className = ""; }, 2600);
  }

  // ---------------- styles ----------------
  var CSS = [
    "#superConsole{position:fixed;right:16px;bottom:calc(var(--bnav-h,44px) + 10px);z-index:60;width:min(360px,32vw);max-height:calc(100vh - 96px);", /* :经典态避让底部导航条(画布态同款);max-height 同步让位 */
    "  font-family:var(--sans,ui-sans-serif,system-ui,'PingFang SC',sans-serif);font-size:12px;color:var(--reply,#ece1d1)}",
 // 布局兼容:白板/双中心是「内容优先」形态,指挥台折叠成头部条(只留头部一行),
 // 不遮内容但仍在场;全屏 wiki 阅读态整块退场。
 // (用户点名):画布形态整块退场——画布上已有 super 卡(全功能指挥台)+托盘「指挥台
 // Super」入口+卡头状态点,右下悬浮条是重复入口,删。旧理由「整块隐藏用户看不到待处理」已由
 // 卡头状态点/托盘徽态承接,不再成立。
    "body.cv-shell #superConsole{display:none}",
    "body[data-view=board] #sc-root .sc-body,body[data-view=board] #sc-root .sc-foot," +
      "body.dual-center #sc-root .sc-body,body.dual-center #sc-root .sc-foot{display:none}",
 // 指挥台视图已有全功能右栏聊天窗(#superIdeChat),右下角悬浮 widget 会叠在它上面
 // 挡住 #superInput 的点击(经验证 elementFromPoint 命中 sc-turns)——super 视图整个 widget 退场。
    "body[data-view=super] #superConsole,body[data-view=rsi] #superConsole{display:none}",
    "body[data-view=board] #superConsole,body.dual-center #superConsole{width:auto;max-width:calc(100vw - 32px)}",
    "body[data-view=board] #sc-overlay,body.dual-center #sc-overlay{display:none}",
    "body.pp-wiki-tab #superConsole{display:none}",
    "#sc-root{display:flex;flex-direction:column;gap:0;border:1px solid var(--border-soft,rgba(201,143,69,.28));border-radius:14px;",
    "  background:var(--glass2,rgba(18,14,11,.88));backdrop-filter:blur(10px);box-shadow:0 10px 32px rgba(0,0,0,.42);overflow:hidden}",
    ".sc-head{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid var(--border-soft,rgba(201,143,69,.18));cursor:default}",
    ".sc-dot{width:7px;height:7px;border-radius:50%;background:var(--faint,#6b5b48);flex:0 0 auto}",
    ".sc-dot.ok{background:var(--bronze,#c98f45);box-shadow:0 0 8px var(--bronze-glow,rgba(201,143,69,.5))}",
    ".sc-title{font-family:var(--mono,ui-monospace,monospace);letter-spacing:1px;font-size:11px;color:var(--bronze,#c98f45);flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".sc-count{border:1px solid var(--border-soft,rgba(201,143,69,.3));background:transparent;color:var(--muted,#a08e78);",
    "  font:inherit;font-size:11px;padding:2px 8px;border-radius:999px;cursor:pointer;white-space:nowrap}",
    ".sc-count.hot{border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978);box-shadow:0 0 12px var(--bronze-glow,rgba(201,143,69,.35))}",
    ".sc-ico{width:22px;height:22px;border:1px solid var(--border-soft,rgba(201,143,69,.24));background:transparent;color:var(--muted,#a08e78);",
    "  border-radius:6px;cursor:pointer;font:inherit;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}",
    ".sc-ico:hover{border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978)}",
    ".sc-body{display:flex;flex-direction:column;min-height:0}",
    ".sc-sec{border-bottom:1px solid var(--border-soft,rgba(201,143,69,.14))}",
    ".sc-sec-h{display:flex;align-items:center;gap:6px;padding:6px 11px;color:var(--faint,#7d6c58);font-size:10px;letter-spacing:1px}",
    ".sc-list{display:flex;flex-direction:column;gap:6px;padding:0 9px 9px;max-height:36vh;overflow:auto}",
    ".sc-empty{color:var(--faint,#7d6c58);padding:2px 11px 9px;line-height:1.5}",
    ".sc-item{border:1px solid var(--border-soft,rgba(201,143,69,.22));border-radius:9px;padding:7px 9px;background:rgba(255,255,255,.02)}",
    ".sc-item.hot{border-color:var(--bronze,#c98f45)}",
    ".sc-item-h{display:flex;align-items:center;gap:6px;margin-bottom:3px}",
    ".sc-badge{font-size:10px;padding:0 6px;border-radius:5px;border:1px solid var(--border-soft,rgba(201,143,69,.34));color:var(--bronze,#c98f45)}",
    ".sc-badge.failed{color:var(--accent2,#e08a7a);border-color:rgba(224,138,122,.45)}",
    ".sc-badge.interrupted{color:var(--accent-bright,#e8b978)}",
    ".sc-it{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sc-since{color:var(--faint,#7d6c58);font-family:var(--mono,monospace);font-size:10px}",
    ".sc-sum{color:var(--muted,#a08e78);line-height:1.5;margin:2px 0 6px;word-break:break-word}",
    ".sc-acts{display:flex;gap:6px;flex-wrap:wrap}",
    ".sc-btn{border:1px solid var(--border-soft,rgba(201,143,69,.3));background:transparent;color:var(--reply,#ece1d1);",
    "  font:inherit;font-size:11px;padding:2px 9px;border-radius:6px;cursor:pointer}",
    ".sc-btn:hover{border-color:var(--bronze,#c98f45)}",
    ".sc-btn.pri{background:var(--bubble-a,rgba(201,143,69,.14));border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978)}",
    ".sc-btn.mut{color:var(--faint,#7d6c58)}",
    ".sc-answer{display:flex;gap:6px;margin-top:6px}",
    ".sc-answer input{flex:1 1 auto;min-width:0;background:rgba(0,0,0,.28);border:1px solid var(--border-soft,rgba(201,143,69,.24));",
    "  border-radius:6px;color:var(--reply,#ece1d1);font:inherit;padding:4px 7px;outline:none}",
    ".sc-answer input:focus{border-color:var(--bronze,#c98f45)}",
    ".sc-log{display:flex;flex-direction:column;gap:3px;padding:0 9px 9px;max-height:24vh;overflow:auto}",
    ".sc-logi{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--muted,#a08e78);font:inherit;",
    "  padding:2px 2px;border-radius:5px;cursor:pointer;line-height:1.5;word-break:break-word}",
    ".sc-logi:hover{background:var(--hover-bg2,rgba(255,255,255,.05));color:var(--reply,#ece1d1)}",
    ".sc-logt{color:var(--faint,#7d6c58);font-family:var(--mono,monospace);font-size:10px;margin-right:5px}",
    ".sc-turn{display:flex;flex-direction:column;gap:4px;padding:0 9px 8px;max-height:22vh;overflow:auto}",
    ".sc-bub{max-width:92%;padding:5px 8px;border-radius:8px;line-height:1.55;word-break:break-word;white-space:pre-wrap}",
    ".sc-bub.u{align-self:flex-end;background:var(--bubble-a,rgba(201,143,69,.16));border:1px solid var(--border-soft,rgba(201,143,69,.26))}",
    ".sc-bub.a{align-self:flex-start;background:rgba(255,255,255,.035);border:1px solid var(--border-soft,rgba(201,143,69,.16));color:var(--reply,#ece1d1)}",
    ".sc-bub.wait{color:var(--faint,#7d6c58)}",
    ".sc-foot{display:flex;gap:6px;align-items:center;padding:8px 9px;border-top:1px solid var(--border-soft,rgba(201,143,69,.18))}",
    "#sc-input{flex:1 1 auto;min-width:0;background:rgba(0,0,0,.3);border:1px solid var(--border-soft,rgba(201,143,69,.24));border-radius:8px;",
    "  color:var(--reply,#ece1d1);font:inherit;padding:6px 8px;outline:none}",
    "#sc-input:focus{border-color:var(--bronze,#c98f45);box-shadow:0 0 0 1px var(--accent-soft,rgba(201,143,69,.2))}",
    ".sc-mic.on{border-color:var(--accent2,#e08a7a);color:var(--accent2,#e08a7a)}",
    "#sc-toast{position:fixed;right:16px;bottom:calc(16px + 100%);max-width:320px;padding:6px 10px;border-radius:8px;font-size:11px;",
    "  background:var(--glass2,rgba(18,14,11,.92));border:1px solid var(--border-soft,rgba(201,143,69,.3));color:var(--reply,#ece1d1);",
    "  opacity:0;transform:translateY(4px);transition:.18s;pointer-events:none;z-index:61}",
    "#sc-toast.on{opacity:1;transform:none}",
    "#sc-toast.bad{border-color:rgba(224,138,122,.5);color:var(--accent2,#e08a7a)}",
    /* 全屏浮层 */
    "#sc-overlay{position:fixed;inset:0;z-index:70;background:rgba(6,4,3,.66);display:flex;align-items:center;justify-content:center;padding:32px}",
    "#sc-overlay[hidden]{display:none}",
    ".sc-ov{width:min(1000px,94vw);height:min(720px,88vh);display:flex;flex-direction:column;border-radius:16px;overflow:hidden;",
    "  border:1px solid var(--border-soft,rgba(201,143,69,.3));background:var(--glass2,#12100d);box-shadow:0 24px 64px rgba(0,0,0,.55);color:var(--reply,#ece1d1)}",
    ".sc-ov-h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border-soft,rgba(201,143,69,.2))}",
    ".sc-ov-h .sc-title{font-size:12px}",
    ".sc-tabs{display:flex;gap:6px;padding:10px 16px 0}",
    ".sc-tab{border:1px solid var(--border-soft,rgba(201,143,69,.24));background:transparent;color:var(--muted,#a08e78);font:inherit;",
    "  font-size:11px;padding:4px 12px;border-radius:999px;cursor:pointer}",
    ".sc-tab.on{border-color:var(--bronze,#c98f45);color:var(--accent-bright,#e8b978);background:var(--bubble-a,rgba(201,143,69,.14))}",
    ".sc-ov-b{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 16px 16px;display:flex;flex-direction:column;gap:8px}",
    ".sc-row{border:1px solid var(--border-soft,rgba(201,143,69,.18));border-radius:9px;padding:8px 10px;background:rgba(255,255,255,.02);cursor:pointer}",
    ".sc-row:hover{border-color:var(--bronze,#c98f45)}",
    ".sc-row-h{display:flex;align-items:center;gap:8px}",
    ".sc-mono{font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--faint,#7d6c58)}",
    ".sc-dim{color:var(--muted,#a08e78);line-height:1.55;word-break:break-word;white-space:pre-wrap}"
  ].join("\n");

  function injectCss() {
    if (el("sc-css")) return;
    var s = document.createElement("style");
    s.id = "sc-css";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------------- 渲染 ----------------
  function kindOf(it) { return String((it && it.kind) || "ask"); }
  function kindLabel(k) {
    if (k === "ask") return "待答";
    if (k === "permission") return "待批";
    if (k === "interrupted") return "中断";
    if (k === "blocked") return "中断";
    if (k === "failed") return "失败";
    return k;
  }
  function visibleItems() {
    var dis = dismissed();
    return state.items.filter(function (it) { return it && it.id && dis.indexOf(it.id) < 0; });
  }

  function pendingHtml(it) {
    var k = kindOf(it);
    var acts = Array.isArray(it.actions) && it.actions.length ? it.actions : null;
    var can = function (a) { return !acts || acts.indexOf(a) >= 0; };
    var btns = [];
    if (k === "ask" && can("answer")) btns.push('<button class="sc-btn pri" data-act="answer-open" data-id="' + esc(it.id) + '">回答</button>');
    if (k === "permission") {
      btns.push('<button class="sc-btn pri" data-act="permit" data-d="allow-once" data-id="' + esc(it.id) + '">批准</button>');
      btns.push('<button class="sc-btn" data-act="permit" data-d="reject" data-id="' + esc(it.id) + '">拒绝</button>');
    }
    if (k === "interrupted" || k === "blocked") {
      if (can("resume")) btns.push('<button class="sc-btn pri" data-act="resume" data-id="' + esc(it.id) + '">恢复</button>');
    }
    if (k === "failed") btns.push('<button class="sc-btn pri" data-act="open" data-id="' + esc(it.id) + '">打开会话</button>');
    if (k === "ask" && Array.isArray(it.options) && it.options.length) {
      it.options.forEach(function (o, i) {
        btns.push('<button class="sc-btn" data-act="answer" data-i="' + i + '" data-id="' + esc(it.id) + '">' + esc(clip(o, 18)) + "</button>");
      });
    }
    btns.push('<button class="sc-btn mut" data-act="dismiss" data-id="' + esc(it.id) + '">忽略</button>');
    return '<div class="sc-item' + (k === "failed" ? " hot" : "") + '" data-item="' + esc(it.id) + '">' +
      '<div class="sc-item-h"><span class="sc-badge ' + esc(k) + '">' + esc(kindLabel(k)) + '</span>' +
      '<span class="sc-it" title="' + esc(it.title || "") + '">' + esc(clip(it.title || "(未命名)", 60)) + '</span>' +
      '<span class="sc-since">' + esc(hhmm(it.since)) + '</span></div>' +
      (it.summary ? '<div class="sc-sum">' + esc(clip(it.summary, 200)) + "</div>" : "") +
      '<div class="sc-acts">' + btns.join("") + "</div></div>";
  }

  function activityHtml() {
    if (!state.activity.length) return '<div class="sc-empty">暂无活动。</div>';
    return state.activity.map(function (n, i) {
      return '<button class="sc-logi" data-act="open" data-ni="' + i + '"><span class="sc-logt">' + esc(hhmm(n.ts)) + "</span>" +
        esc(clip(n.text, 120)) + "</button>";
    }).join("");
  }

  function turnsHtml() {
    if (!state.turns.length) return "";
    return state.turns.slice(-6).map(function (t) {
      if (t.role === "wait") return '<div class="sc-bub a wait">' + esc(t.text) + "</div>";
      return '<div class="sc-bub ' + (t.role === "user" ? "u" : "a") + '">' + esc(clip(t.text, 600)) + "</div>";
    }).join("");
  }

  function skeleton() {
    return '<div class="sc-head">' +
      '<span class="sc-dot" id="sc-dot"></span>' +
      '<span class="sc-title">Super Agent</span>' +
      '<button class="sc-count" id="sc-count" data-act="toggle-pending" title="展开/收起待处理">待你处理 0</button>' +
      '<button class="sc-ico" data-act="open-view" title="打开指挥台面板(聊天+看板)">▦</button>' +
      '<button class="sc-ico" data-act="overlay" title="展开指挥台">⤢</button>' +
      '</div>' +
      '<div class="sc-body">' +
      '<div class="sc-sec" id="sc-pend-sec">' +
      '<div class="sc-sec-h">待处理</div>' +
      '<div class="sc-list" id="sc-pend"></div>' +
      '</div>' +
      '<div class="sc-sec">' +
      '<div class="sc-sec-h">活动 <span class="sc-mono" id="sc-act-n"></span></div>' +
      '<div class="sc-log" id="sc-log"></div>' +
      '</div>' +
      '<div class="sc-turn" id="sc-turns"></div>' +
      '</div>' +
      '<div class="sc-foot">' +
      '<input id="sc-input" placeholder="对 Super Agent 说…" autocomplete="off" spellcheck="false">' +
      '<button class="sc-ico sc-mic" id="sc-mic" data-act="mic" title="语音输入" style="display:none">◎</button>' +
      '<button class="sc-ico" data-act="send" title="发送">↵</button>' +
      '</div>' +
      '<div id="sc-toast"></div>';
  }

  function renderRoot() {
    var root = el("sc-root");
    if (!root) return;
    var items = visibleItems();
    var n = items.length;
    var cnt = el("sc-count");
    if (cnt) {
      cnt.textContent = "待你处理 " + n;
      cnt.className = "sc-count" + (n ? " hot" : "");
    }
    var dot = el("sc-dot");
    if (dot) dot.className = "sc-dot" + (state.wsOpen ? " ok" : "");
    var sec = el("sc-pend-sec");
    if (sec) sec.style.display = state.pendingOpen || n ? "" : "none";
    var pend = el("sc-pend");
    if (pend) pend.innerHTML = n ? items.map(pendingHtml).join("") : '<div class="sc-empty">没有需要你处理的事。</div>';
    var log = el("sc-log");
    if (log) log.innerHTML = activityHtml();
    var an = el("sc-act-n");
    if (an) an.textContent = state.activity.length ? "· " + state.activity.length : "";
    var tn = el("sc-turns");
    if (tn) tn.innerHTML = turnsHtml();
    var mic = el("sc-mic");
    if (mic) mic.style.display = voiceEnabled() ? "" : "none";
    if (state.overlay) renderOverlay();
  }

  // ---------------- 全屏浮层 ----------------
  function overlayHtml() {
    var tab = state.tab;
    var body = "";
    if (tab === "inbox") {
      var items = visibleItems();
      body = items.length ? items.map(function (it) {
        return pendingHtml(it).replace('class="sc-item', 'class="sc-row sc-item');
      }).join("") : '<div class="sc-empty">没有需要你处理的事。</div>';
    } else if (tab === "activity") {
      body = state.activity.length ? state.activity.map(function (n, i) {
        return '<div class="sc-row" data-act="open" data-ni="' + i + '"><div class="sc-row-h"><span class="sc-mono">' +
          esc(hhmm(n.ts)) + "</span><span class=\"sc-it\">" + esc(clip(n.text, 160)) + "</span>" +
          (n.state ? '<span class="sc-badge">' + esc(n.state) + "</span>" : "") + "</div>" +
          (n.taskId ? '<div class="sc-mono">' + esc(n.taskId) + "</div>" : "") + "</div>";
      }).join("") : '<div class="sc-empty">暂无活动。</div>';
    } else if (tab === "tasks") {
      body = state.tasks.length ? state.tasks.map(function (t) {
        var id = t.id || t.taskId || "";
        return '<div class="sc-row" data-act="open-task" data-tid="' + esc(id) + '" data-sid="' + esc(t.sessionId || "") + '">' +
          '<div class="sc-row-h"><span class="sc-badge">' + esc(t.state || "?") + '</span><span class="sc-it">' +
          esc(clip(t.title || t.brief || id, 90)) + '</span><span class="sc-mono">' + esc(hhmm(t.updatedAt || t.createdAt)) + "</span></div>" +
          '<div class="sc-mono">' + esc(id) + "</div></div>";
      }).join("") : '<div class="sc-empty">暂无任务(点上方「任务」重拉)。</div>';
    } else {
      body = state.history.length ? state.history.map(function (e) {
        var p = e && e.payload ? e.payload : {};
        var kind = (e && (e.kind || e.type)) || "event";
        var text = p.text ? String(p.text) : "";
        return '<div class="sc-row"><div class="sc-row-h"><span class="sc-mono">' + esc(kind) + '</span><span class="sc-mono">' +
          esc(e && e.ts ? hhmm(e.ts) : "") + "</span></div>" +
          (text ? '<div class="sc-dim">' + esc(clip(text, 400)) + "</div>" : "") + "</div>";
      }).join("") : '<div class="sc-empty">暂无历史。</div>';
    }
    return '<div class="sc-ov"><div class="sc-ov-h"><span class="sc-dot ok"></span><span class="sc-title">Super Agent</span>' +
      '<span class="sc-mono" style="flex:1 1 auto"></span>' +
      '<button class="sc-ico" data-act="overlay-close" title="关闭 (ESC)">×</button></div>' +
      '<div class="sc-tabs">' +
      ["inbox:待处理", "activity:活动", "tasks:任务", "sessions:会话"].map(function (x) {
        var k = x.split(":")[0];
        return '<button class="sc-tab' + (tab === k ? " on" : "") + '" data-act="tab" data-tab="' + k + '">' + x.split(":")[1] + "</button>";
      }).join("") +
      '</div><div class="sc-ov-b">' + body + "</div></div>";
  }

  function renderOverlay() {
    var ov = el("sc-overlay");
    if (!ov) return;
    ov.hidden = !state.overlay;
    if (!state.overlay) { ov.innerHTML = ""; return; }
    ov.innerHTML = overlayHtml();
  }
  function openOverlay(tab) {
    state.overlay = true;
    if (tab) state.tab = tab;
    renderOverlay();
    setTabData();
  }
  function closeOverlay() { state.overlay = false; renderOverlay(); }
  function setTabData() {
    if (!state.overlay) return;
    if (state.tab === "tasks") send({ type: "task.list" });
    if (state.tab === "sessions") send({ type: "super.history", sinceSeq: 0 });
  }

  // ---------------- WS ----------------
  function wsUrl() {
    var p = location.protocol === "https:" ? "wss:" : "ws:";
    return p + "//" + location.host;
  }
  function send(obj) {
    if (obj && obj.type !== "super.turn" && typeof obj.v === "undefined") obj.v = 1;
    try {
      if (state.ws && state.ws.readyState === 1) { state.ws.send(JSON.stringify(obj)); return true; }
    } catch (e) { /* 落到下方 */ }
    toast("指挥台连接未就绪", true);
    return false;
  }
  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    var ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { setTimeout(connect, 3000); return; }
    state.ws = ws;
    ws.onopen = function () {
      state.wsOpen = true;
      state.retry = 0;
      renderRoot();
      pullInbox();
    };
    ws.onclose = function () {
      state.wsOpen = false;
      state.ws = null;
      renderRoot();
      state.retry = Math.min(state.retry + 1, 20);
      setTimeout(connect, 3000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) { /* 忽略 */ } };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      onMsg(m);
    };
  }
  function pullInbox() {
    if (!state.wsOpen) return;
    try { state.ws.send(JSON.stringify({ v: 1, type: "super.inbox", limit: 30 })); } catch (e) { /* 忽略 */ }
  }

  // ---------------- 入站 ----------------
  function normItems(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (x) {
      return x && typeof x === "object" && x.id && typeof x.id === "string";
    }).map(function (x) {
      var it = {};
      it.id = String(x.id);
      it.kind = String(x.kind || "ask");
      it.title = String(x.title || "");
      it.summary = String(x.summary || "");
      it.since = typeof x.since === "number" ? x.since : Date.now();
      it.sessionId = x.sessionId ? String(x.sessionId) : undefined;
      it.taskId = x.taskId ? String(x.taskId) : undefined;
      it.requestId = x.requestId ? String(x.requestId) : undefined;
      it.options = Array.isArray(x.options) ? x.options.map(String) : undefined;
      it.actions = Array.isArray(x.actions) ? x.actions.map(String) : undefined;
      return it;
    });
  }
  function upsertItem(it) {
    if (!it || !it.id) return;
    var found = false;
    state.items = state.items.map(function (x) { if (x.id === it.id) { found = true; return it; } return x; });
    if (!found) state.items.unshift(it);
    renderRoot();
  }
  function pushNotice(m) {
    state.activity.unshift({ text: String(m.text || ""), taskId: m.taskId, state: m.state, ts: typeof m.ts === "number" ? m.ts : Date.now() });
    state.activity = state.activity.slice(0, MAX_ACTIVITY);
    renderRoot();
  }
  function pushTurn(role, text, sid) {
    state.turns.push({ role: role, text: String(text || ""), sid: sid });
    if (state.turns.length > 30) state.turns = state.turns.slice(-30);
    renderRoot();
    var box = el("sc-turns");
    if (box) box.scrollTop = box.scrollHeight;
  }
  function dropWait() {
    state.turns = state.turns.filter(function (t) { return t.role !== "wait"; });
  }
  function onMsg(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "super.inbox.result":
        state.items = normItems(m.items);
        renderRoot();
        break;
      case "super.inbox.changed":
        pullInbox();
        break;
      case "super.relay":
        upsertItem(normItems([{
          id: "ask-" + String(m.requestId || ""),
          kind: "ask",
          title: m.question || "有待回答的问题",
          summary: m.context || "",
          since: Date.now(),
          sessionId: m.sessionId,
          requestId: m.requestId,
          options: m.options
        }])[0]);
        break;
      case "super.notice":
        pushNotice(m);
        break;
      case "super.turn.user":
        pushTurn("user", m.text);
        break;
      case "super.turn.done":
        dropWait();
        pushTurn("agent", m.text, m.sessionId);
        break;
      case "error":
 // 错误帧必须显式消费——此前 switch 无 error 分支,super.turn 失败(LLM 未装配/
        // 上游报错)时「思考中…」等待气泡永不消失、无任何提示,用户表象=「发了没反应/不能聊天」。
        if (m.code && m.code !== "super-failed" && m.code !== "super-announce-failed") break; // 非指挥台错误不抢渲染
        dropWait();
        pushTurn("agent", "调度中枢出错:" + clip(String(m.message || m.code || "未知错误"), 160));
        toast("指挥台出错:" + clip(String(m.message || m.code || ""), 60), true);
        break;
      case "super.history.result":
        state.history = Array.isArray(m.events) ? m.events : [];
        if (state.overlay && state.tab === "sessions") renderOverlay();
        break;
      case "voice.transcribe.result":
        onAsrResult(m.text);
        break;
      case "task.list.result":
        state.tasks = Array.isArray(m.tasks) ? m.tasks : (Array.isArray(m.items) ? m.items : []);
        if (state.overlay && state.tab === "tasks") renderOverlay();
        break;
      case "task.list":
        if (Array.isArray(m.tasks)) { state.tasks = m.tasks; if (state.overlay && state.tab === "tasks") renderOverlay(); }
        break;
      default:
        break;
    }
  }

  // ---------------- 动作 ----------------
  function itemById(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }
  function openSession(sid) {
    if (!sid) { toast("没有关联会话", true); return; }
    try {
      if (typeof window.openSession === "function") { window.openSession(sid); return; }
    } catch (e) { /* 落到事件 */ }
    try {
      document.dispatchEvent(new CustomEvent("genie:open-session", { detail: { sessionId: sid } }));
    } catch (e) { /* 落到 toast */ }
    toast("切到会话 " + String(sid).slice(0, 24));
  }
  function answerAsk(id, value) {
    var it = itemById(id);
    if (!it || !it.requestId) { toast("该问题缺少 requestId", true); return; }
    if (send({ type: "ask.user.answer", requestId: it.requestId, answer: String(value) })) {
      state.items = state.items.filter(function (x) { return x.id !== id; });
      renderRoot();
    }
  }
  function answerOpen(id) {
    var box = document.querySelector('[data-item="' + id + '"]');
    if (!box) return;
    if (box.querySelector(".sc-answer")) return;
    var wrap = document.createElement("div");
    wrap.className = "sc-answer";
    wrap.innerHTML = '<input placeholder="输入回答…" autocomplete="off" spellcheck="false">' +
      '<button class="sc-btn pri" data-act="answer-send" data-id="' + esc(id) + '">发送</button>';
    box.appendChild(wrap);
    var inp = wrap.querySelector("input");
    inp.focus();
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); answerAsk(id, inp.value); }
      if (e.key === "Escape") wrap.remove();
    });
  }
  function permit(id, decision) {
    var it = itemById(id);
    if (!it || !it.requestId) { toast("该审批缺少 requestId", true); return; }
    if (send({ type: "permission.respond", requestId: it.requestId, decision: decision })) {
      state.items = state.items.filter(function (x) { return x.id !== id; });
      renderRoot();
      toast(decision === "allow-once" ? "已批准" : "已拒绝");
    }
  }
  function resumeTask(it) {
    if (!it || !it.taskId) { toast("该任务缺少 taskId", true); return; }
    if (send({ type: "task.resume", taskId: it.taskId })) toast("已请求恢复任务");
  }
  function submitTurn() {
    var inp = el("sc-input");
    if (!inp) return;
    var text = String(inp.value || "").trim();
    if (!text) return;
    if (!send({ type: "super.turn", text: text })) return;
    inp.value = "";
    pushTurn("wait", "思考中…");
  }

  // ---------------- 语音输入(默认关;无 TTS 播放) ----------------
  function onAsrResult(text) {
    if (!state.asrWaiting) return;
    state.asrWaiting = false;
    var t = String(text || "").trim();
    if (!t) { toast("没有识别到内容", true); return; }
    var inp = el("sc-input");
    if (inp) inp.value = t;
    submitTurn();
  }
  function b64FromBytes(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i += 4096) {
      bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 4096)));
    }
    return btoa(bin);
  }
  function micStart() {
    if (state.rec) { micStop(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("麦克风不可用", true); return; }
    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then(function (stream) {
        var ctx = new AC({ sampleRate: 16000 });
        var src = ctx.createMediaStreamSource(stream);
        var proc = ctx.createScriptProcessor(4096, 1, 1);
        var chunks = [];
        proc.onaudioprocess = function (e) { chunks.push(e.inputBuffer.getChannelData(0).slice()); };
        src.connect(proc);
        proc.connect(ctx.destination);
        state.rec = { ctx: ctx, stream: stream, chunks: chunks, proc: proc, src: src };
        var mic = el("sc-mic");
        if (mic) mic.classList.add("on");
        toast("录音中…再点一次结束");
      })
      .catch(function (err) { toast("麦克风不可用:" + clip(String(err), 60), true); });
  }
  function micStop() {
    var rec = state.rec;
    if (!rec) return;
    state.rec = null;
    var mic = el("sc-mic");
    if (mic) mic.classList.remove("on");
    try { rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
    try { rec.proc.disconnect(); rec.src.disconnect(); } catch (e) { /* 忽略 */ }
    Promise.resolve().then(function () { return rec.ctx.close(); }).catch(function () { /* 忽略 */ });
    var chunks = rec.chunks || [];
    if (!chunks.length) return;
    var total = chunks.reduce(function (a, c) { return a + c.length; }, 0);
    if (!total) return;
    var merged = new Float32Array(total);
    var off = 0;
    chunks.forEach(function (c) { merged.set(c, off); off += c.length; });
    var sum = 0;
    for (var i = 0; i < merged.length; i++) sum += merged[i] * merged[i];
    if (Math.sqrt(sum / merged.length) < 0.006) { toast("没有检测到声音", true); return; }
    var pcm = new Int16Array(merged.length);
    for (var j = 0; j < merged.length; j++) {
      var s = Math.max(-1, Math.min(1, merged[j]));
      pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    state.asrWaiting = true;
    send({ type: "voice.transcribe", audioB64: b64FromBytes(new Uint8Array(pcm.buffer)), format: "pcm16", sampleRate: 16000 });
    toast("转写中…");
  }

  // ---------------- 事件 ----------------
  function onClick(ev) {
    var t = ev.target;
    while (t && t !== document.body && !(t.dataset && t.dataset.act)) t = t.parentNode;
    if (!t || !t.dataset || !t.dataset.act) return;
    var act = t.dataset.act;
    var id = t.dataset.id || "";
    var it = id ? itemById(id) : null;
    if (act === "toggle-pending") { state.pendingOpen = !state.pendingOpen; renderRoot(); return; }
    if (act === "open-view") {
 // 跳转面板「指挥台」view(完整聊天渲染区+看板;widget 保留为快捷入口)。
      // 与面板同窗口直接调 switchView;拿不到(极端时序)退化为事件,面板侧有监听。
      try {
        if (typeof window.switchView === "function") { window.switchView("super"); return; }
      } catch (e) { /* 落到事件 */ }
      try { document.dispatchEvent(new CustomEvent("genie:open-super")); } catch (e2) { /* 忽略 */ }
      return;
    }
    if (act === "overlay") { openOverlay(); return; }
    if (act === "overlay-close") { closeOverlay(); return; }
    if (act === "tab") { state.tab = t.dataset.tab || "inbox"; renderOverlay(); setTabData(); return; }
    if (act === "send") { submitTurn(); return; }
    if (act === "mic") { micStart(); return; }
    if (act === "answer-open") { answerOpen(id); return; }
    if (act === "answer-send") {
      var box = t.parentNode;
      var inp = box ? box.querySelector("input") : null;
      answerAsk(id, inp ? inp.value : "");
      return;
    }
    if (act === "answer") {
      var opts = it && it.options ? it.options : [];
      var idx = Number(t.dataset.i || 0);
      answerAsk(id, opts[idx] || "");
      return;
    }
    if (act === "permit") { permit(id, t.dataset.d || "allow-once"); return; }
    if (act === "resume") { resumeTask(it); return; }
    if (act === "dismiss") { dismiss(id); renderRoot(); return; }
    if (act === "open") {
      if (typeof t.dataset.ni !== "undefined") {
        var n = state.activity[Number(t.dataset.ni)];
        if (!n) return;
        if (n.taskId) {
          try { document.dispatchEvent(new CustomEvent("genie:open-task", { detail: { taskId: n.taskId } })); } catch (e) { /* 忽略 */ }
          toast("定位任务 " + String(n.taskId).slice(0, 20));
          return;
        }
        toast(clip(n.text, 40));
        return;
      }
      if (it) openSession(it.sessionId || "");
      return;
    }
    if (act === "open-task") { openSession(t.dataset.sid || ""); return; }
  }
  function onKey(ev) {
    var inp = el("sc-input");
    if (inp && ev.target === inp && ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submitTurn(); return; }
    if (ev.key === "Escape" && state.overlay) { closeOverlay(); }
  }

  // ---------------- 挂载/自愈 ----------------
  function mount() {
    if (!document.body) return false;
    injectCss();
    if (!el("superConsole")) {
      var wrap = document.createElement("div");
      wrap.id = "superConsole";
      var inner = document.createElement("div");
      inner.id = "sc-root";
      inner.innerHTML = skeleton();
      wrap.appendChild(inner);
      document.body.appendChild(wrap);
    }
    if (!el("sc-overlay")) {
      var ov = document.createElement("div");
      ov.id = "sc-overlay";
      ov.hidden = true;
      document.body.appendChild(ov);
    }
    if (!mount.__bound) {
      mount.__bound = true;
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("click", function (ev) {
        if (state.overlay && ev.target && ev.target.id === "sc-overlay") closeOverlay();
      }, false);
    }
    renderRoot();
    return true;
  }

  function boot() {
    mount();
    connect();
    setInterval(function () { if (!el("superConsole")) mount(); }, 2000);   // 自愈:面板重渲染抹掉后重挂
    setInterval(function () { pullInbox(); }, 5000);                        // 轮询待处理(inbox.changed 为廉价触发)
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
