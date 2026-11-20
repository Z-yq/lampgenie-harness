/**
 * 手机端远程控制台:GET /m?pair=<token> 返回本页。
 * 只依赖 gateway 同源 HTTP/WS,零构建链/零外链:
 * - 项目选择 + 任务列表 + 任务详情(最近消息);
 * - 给当前任务追加指令(task.submit,服务端队列串行);
 * - 新建任务、取消任务;
 * - 实时 stream 增量 + 断线指数退避重连;
 * - 所有模型/用户文本用 textContent 注入,不用 innerHTML 渲染不可信内容。
 * 模板约束(与 PAGE 一致):本文件内容进 <script>,字符串内不得出现反引号。
 */
export const MOBILE_PAGE = `<!doctype html><html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0806">
<meta name="referrer" content="no-referrer">
<title>Genie 远程控制</title>
<style>
  :root{
    --bg:#060403;--panel:#0f0b07;--card:#151009;--line:rgba(212,181,134,.18);--line2:rgba(212,181,134,.10);
    --text:#f2ecdf;--muted:#a3937a;--faint:#7e6f5b;--bronze:#c98f45;--green:#9dc08b;--red:#e08a7a;--warn:#d9b36c;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  }
 *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased;overscroll-behavior:none}
  button{font-family:inherit}
  header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px;
    background:rgba(8,5,3,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line2)}
  .brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.4px;white-space:nowrap}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--faint);box-shadow:0 0 0 2px rgba(0,0,0,.3)}
  .dot.ok{background:var(--green)} .dot.bad{background:var(--red)}
  header select{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:9px;color:var(--text);
    padding:7px 9px;font-size:13px;outline:none}
  main{min-height:calc(100vh - 54px);padding:10px 12px calc(18px + env(safe-area-inset-bottom))}
  .bar{display:flex;align-items:center;gap:8px;margin:2px 0 10px}
  .bar .grow{flex:1;min-width:0}
  .bar .title{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .btn{background:var(--card);border:1px solid var(--line);border-radius:9px;color:var(--text);padding:7px 11px;font-size:13px;cursor:pointer}
  .btn:active{transform:scale(.98)}
  .btn.pri{border-color:rgba(201,143,69,.45);color:var(--bronze)}
  .btn.danger{border-color:rgba(224,138,122,.35);color:var(--red)}
  .btn[disabled]{opacity:.45}
  .list{display:flex;flex-direction:column;gap:8px}
  .task{display:flex;flex-direction:column;gap:5px;padding:11px 12px;border:1px solid var(--line2);border-radius:12px;background:var(--card);cursor:pointer}
  .task:active{background:#1a130b}
  .task .t1{display:flex;align-items:center;gap:8px}
  .task .name{flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .task .meta{display:flex;gap:8px;color:var(--faint);font-size:11.5px}
  .chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
  .chip.running{color:var(--bronze);border-color:rgba(201,143,69,.45)}
  .chip.done{color:var(--green);border-color:rgba(157,192,139,.4)}
  .chip.failed,.chip.cancelled,.chip.interrupted{color:var(--red);border-color:rgba(224,138,122,.35)}
  .chip.queued,.chip.blocked{color:var(--warn);border-color:rgba(217,179,108,.35)}
  .empty{padding:34px 12px;text-align:center;color:var(--faint);font-size:13px}
  #detailView{position:fixed;inset:0;z-index:30;background:var(--bg);display:flex;flex-direction:column;
    padding-bottom:env(safe-area-inset-bottom)}
  #detailView[hidden]{display:none}
  #detailBar{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top)) 12px 10px;
    background:rgba(8,5,3,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line2)}
  #detailBar .title{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #msgs{flex:1;overflow-y:auto;padding:12px 12px 8px;display:flex;flex-direction:column;gap:9px;-webkit-overflow-scrolling:touch}
  .msg{max-width:88%;padding:9px 11px;border-radius:12px;white-space:pre-wrap;word-break:break-word;font-size:13.5px}
  .msg.user{align-self:flex-end;background:rgba(201,143,69,.16);border:1px solid rgba(201,143,69,.22)}
  .msg.agent{align-self:flex-start;background:var(--card);border:1px solid var(--line2)}
  .msg.note{align-self:center;background:transparent;border:1px dashed var(--line);color:var(--faint);font-size:12px;max-width:94%}
  .msg.live{border-style:dashed;border-color:rgba(201,143,69,.4)}
  .msg .who{display:block;font-size:10.5px;color:var(--faint);margin-bottom:3px}
  #composer{display:flex;align-items:flex-end;gap:8px;padding:9px 12px 12px;border-top:1px solid var(--line2);background:var(--panel)}
  #composer textarea{flex:1;min-height:40px;max-height:130px;resize:none;background:var(--card);border:1px solid var(--line);
    border-radius:11px;color:var(--text);padding:9px 11px;font-size:14px;font-family:inherit;outline:none}
  #composer button{height:40px;padding:0 15px;border-radius:11px;border:1px solid rgba(201,143,69,.45);background:rgba(201,143,69,.14);color:var(--bronze);font-size:14px}
  #composer button[disabled]{opacity:.45}
  #toast{position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%) translateY(8px);
    background:rgba(20,14,8,.96);border:1px solid var(--line);border-radius:10px;padding:8px 14px;font-size:12.5px;color:var(--text);
    opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;z-index:60;max-width:90vw;text-align:center}
  #toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #blocked{position:fixed;inset:0;z-index:80;background:var(--bg);display:none;align-items:center;justify-content:center;padding:28px;text-align:center}
  #blocked.on{display:flex}
  #blocked .box{max-width:340px}
  #blocked h2{font-size:17px;margin:0 0 8px}
  #blocked p{color:var(--muted);font-size:13px;margin:0 0 18px}
  .hint{color:var(--faint);font-size:11.5px;text-align:center;padding:14px 0 4px}
</style>
</head><body>
<header>
  <div class="brand"><span class="dot" id="connDot"></span>Genie 远程控制</div>
  <select id="projectSel" aria-label="项目"></select>
</header>
<main id="listView">
  <div class="bar">
    <div class="grow"><div class="title" id="listTitle">任务</div></div>
    <button class="btn pri" id="newBtn">＋ 新任务</button>
    <button class="btn" id="refreshBtn">刷新</button>
  </div>
  <div class="list" id="tasks"></div>
  <div class="hint">本页经一次性配对链接访问;关闭电脑端远程控制后链接失效。</div>
</main>
<section id="detailView" hidden>
  <div id="detailBar">
    <button class="btn" id="backBtn">‹ 返回</button>
    <div class="title" id="detailTitle">任务</div>
    <button class="btn danger" id="cancelBtn">停止</button>
  </div>
  <div id="msgs"></div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="发消息给 Genie…"></textarea>
    <button id="sendBtn">发送</button>
  </div>
</section>
<div id="toast"></div>
<div id="blocked"><div class="box"><h2>链接已失效</h2><p>配对链接已过期或远程控制已停止。请在电脑上重新打开「远程控制」生成新的二维码。</p></div></div>
<script>
(function(){
  "use strict";
  var TOKEN = new URLSearchParams(location.search).get("pair") || "";
  var $ = function(id){ return document.getElementById(id); };
  var state = {
    ws: null, connected: false, attempts: 0, closed: false,
    projects: [], activeProjectId: "all", tasks: [], openTask: null,
    composeNew: false, sessionId: "", events: [], live: "", liveEl: null,
    detailEvents: [], loading: false
  };
  var STORE_PROJECT = "genie.mobile.project";

  function esc(v){ return String(v == null ? "" : v); }
  function toast(text){
    var t = $("toast"); t.textContent = esc(text); t.classList.add("on");
    clearTimeout(toast._t); toast._t = setTimeout(function(){ t.classList.remove("on"); }, 2400);
  }
  function setConn(ok){
    state.connected = ok;
    var d = $("connDot"); d.classList.toggle("ok", ok); d.classList.toggle("bad", !ok);
    $("sendBtn").disabled = !ok;
  }
  function send(obj){
    if (!state.ws || state.ws.readyState !== 1) { toast("连接中…"); return false; }
    obj.v = 1;
    state.ws.send(JSON.stringify(obj));
    return true;
  }
  function wsUrl(){
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/?pair=" + encodeURIComponent(TOKEN);
  }
  function connect(){
    if (state.closed) return;
    try { state.ws = new WebSocket(wsUrl()); } catch(e){ scheduleReconnect(); return; }
    state.ws.onopen = function(){
      state.attempts = 0; setConn(true); refreshAll();
    };
    state.ws.onclose = function(ev){
      setConn(false);
      if (ev && ev.code === 4003) { state.closed = true; $("blocked").classList.add("on"); return; }
      scheduleReconnect();
    };
    state.ws.onerror = function(){ /* onclose 统一处理 */ };
    state.ws.onmessage = function(ev){
      var m; try { m = JSON.parse(String(ev.data)); } catch(e){ return; }
      handle(m);
    };
  }
  function scheduleReconnect(){
    if (state.closed) return;
    state.attempts++;
    var delay = Math.min(8000, 700 * Math.pow(1.6, Math.min(6, state.attempts)));
    setTimeout(connect, delay);
  }
  function refreshAll(){
    send({type:"project.list"});
    send({type:"task.list"});
    if (state.openTask && !state.composeNew) loadHistory(state.openTask.sessionId);
  }
  function handle(m){
    if (!m || !m.type) return;
    if (m.type === "project.list.result") {
      state.projects = Array.isArray(m.projects) ? m.projects : [];
      var saved = "";
      try { saved = localStorage.getItem(STORE_PROJECT) || ""; } catch(e){ /* 隐私模式 */ }
      var visible = state.projects.filter(function(p){ return p.availability === "available" && p.id !== "__harness__"; });
 // __harness__ 是 Agent cwd 兜底,不作为手机端项目展示;手机默认落第一个真实项目(没有则全部任务)
      var exists = saved === "all" || state.projects.some(function(p){ return p.id === saved && p.id !== "__harness__"; });
      if (!exists) saved = visible.length ? visible[0].id : "all";
      if (saved === "__harness__") saved = visible.length ? visible[0].id : "all";
      state.activeProjectId = saved || "all";
      renderProjects();
      renderTasks();
      return;
    }
    if (m.type === "task.list" && Array.isArray(m.tasks)) {
      state.tasks = m.tasks.filter(function(t){ return !t.archived; });
      renderTasks();
      if (state.openTask) {
        var hit = state.tasks.filter(function(t){ return t.id === state.openTask.id; })[0];
        if (hit) state.openTask = Object.assign({}, state.openTask, hit);
        renderDetailHead();
      }
      return;
    }
    if (m.type === "task.changed" && m.task) {
      var idx = -1;
      for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === m.task.id) { idx = i; break; }
      if (idx >= 0) state.tasks[idx] = m.task; else state.tasks.push(m.task);
      renderTasks();
      if (state.openTask && state.openTask.id === m.task.id) {
        state.openTask = Object.assign({}, state.openTask, m.task);
        renderDetailHead();
        if (m.task.state === "done" || m.task.state === "failed" || m.task.state === "cancelled") {
          send({type:"task.detail.get", taskId: m.task.id});
        }
      }
      return;
    }
    if (m.type === "task.submitted" && m.task) {
      state.tasks.push(m.task); renderTasks(); toast("任务已提交");
      return;
    }
    if (m.type === "task.detail.result") {
      if (state.openTask && state.openTask.id === m.taskId && m.task) {
        state.openTask = Object.assign({}, state.openTask, m.task);
        renderDetailHead();
        if (m.task.result) appendNotice("结果:" + m.task.result);
      }
      return;
    }
    if (m.type === "session.history.result") {
      if (!state.openTask || m.sessionId !== state.openTask.sessionId) return;
      renderHistory(Array.isArray(m.events) ? m.events : []);
      return;
    }
    if (m.type === "stream" && m.sessionId) {
      if (!state.openTask || m.sessionId !== state.openTask.sessionId) return;
      handleStream(m.ev || {});
      return;
    }
    if (m.type === "error") {
      toast(m.message || m.code || "操作失败");
      if (state.loading) { state.loading = false; $("sendBtn").disabled = !state.connected; }
      return;
    }
  }
  function renderProjects(){
    var sel = $("projectSel");
    sel.innerHTML = "";
    var all = document.createElement("option");
    all.value = "all"; all.textContent = "全部任务";
    sel.appendChild(all);
    var visible = state.projects.filter(function(p){ return p.availability === "available" && p.id !== "__harness__"; });
    if (!visible.length) visible = state.projects.filter(function(p){ return p.availability === "available"; });
    visible.forEach(function(p){
      var o = document.createElement("option");
      o.value = p.id; o.textContent = p.label || p.id;
      sel.appendChild(o);
    });
    sel.value = state.activeProjectId;
    sel.onchange = function(){
      state.activeProjectId = sel.value;
      try { localStorage.setItem(STORE_PROJECT, state.activeProjectId); } catch(e){ /* 忽略 */ }
      renderTasks();
    };
  }
  function projectLabel(id){
    var hit = state.projects.filter(function(p){ return p.id === id; })[0];
    return hit ? (hit.label || id) : "";
  }
  function renderTasks(){
    var host = $("tasks");
    host.innerHTML = "";
    var list = state.tasks.filter(function(t){
      return state.activeProjectId === "all" || t.projectId === state.activeProjectId;
    }).sort(function(a,b){ return (b.updatedAt||0) - (a.updatedAt||0); }).slice(0, 80);
    $("listTitle").textContent = state.activeProjectId === "all" ? "全部任务" : (projectLabel(state.activeProjectId) || "任务");
    if (!list.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.connected ? "还没有任务。点右上角「新任务」开始。" : "连接中…";
      host.appendChild(empty);
      return;
    }
    list.forEach(function(t){
      var row = document.createElement("div");
      row.className = "task";
      row.onclick = function(){ openTask(t); };
      var l1 = document.createElement("div"); l1.className = "t1";
      var name = document.createElement("div"); name.className = "name"; name.textContent = t.title || t.id.slice(0,8);
      var chip = document.createElement("span"); chip.className = "chip " + t.state; chip.textContent = stateLabel(t.state);
      l1.appendChild(name); l1.appendChild(chip);
      var meta = document.createElement("div"); meta.className = "meta";
      var when = document.createElement("span"); when.textContent = ago(t.updatedAt || t.createdAt);
      var proj = document.createElement("span"); proj.textContent = projectLabel(t.projectId) || "任务";
      meta.appendChild(when); meta.appendChild(proj);
      row.appendChild(l1); row.appendChild(meta);
      host.appendChild(row);
    });
  }
  function stateLabel(s){
    return ({queued:"排队",running:"执行中",blocked:"阻塞",interrupted:"已中断",done:"完成",failed:"失败",cancelled:"已停止"})[s] || s || "?";
  }
  function ago(ts){
    if (!ts) return "";
    var d = Math.max(0, Date.now() - ts);
    if (d < 60000) return Math.floor(d/1000) + "s 前";
    if (d < 3600000) return Math.floor(d/60000) + "m 前";
    if (d < 86400000) return Math.floor(d/3600000) + "h 前";
    return Math.floor(d/86400000) + "d 前";
  }
  function openTask(t){
    state.composeNew = false;
    state.openTask = t;
    state.sessionId = t.sessionId;
    state.events = [];
    state.live = ""; state.liveEl = null;
    $("detailView").hidden = false;
    $("detailTitle").textContent = t.title || t.id.slice(0,8);
    $("msgs").innerHTML = "";
    $("cancelBtn").style.display = "";
    $("input").placeholder = "继续给这个任务发指令…";
    renderDetailHead();
    loadHistory(t.sessionId);
    send({type:"task.detail.get", taskId: t.id});
    focusInput();
  }
  function openNewTask(){
    state.composeNew = true;
    state.openTask = null;
    state.sessionId = "";
    state.events = [];
    state.live = ""; state.liveEl = null;
    $("detailView").hidden = false;
    $("detailTitle").textContent = "新任务";
    $("msgs").innerHTML = "";
    $("cancelBtn").style.display = "none";
    $("input").placeholder = "描述你的任务…";
    $("input").value = "";
    var hint = document.createElement("div");
    hint.className = "msg note";
    hint.textContent = state.activeProjectId === "all" ? "将在当前激活项目下新建任务。" : ("将在 " + (projectLabel(state.activeProjectId) || "当前项目") + " 下新建任务。");
    $("msgs").appendChild(hint);
    focusInput();
  }
  function renderDetailHead(){
    var t = state.openTask;
    if (!t) return;
    var chip = document.createElement("span");
    $("detailTitle").textContent = t.title || t.id.slice(0,8);
    $("cancelBtn").style.display = (t.state === "running" || t.state === "queued" || t.state === "blocked") ? "" : "none";
    void chip;
  }
  function loadHistory(sid){
    if (!sid) return;
    send({type:"session.history", sessionId: sid, limit: 80});
  }
  function renderHistory(events){
    var host = $("msgs");
    host.innerHTML = "";
    state.events = events.slice(-120);
    if (!state.events.length) {
      var empty = document.createElement("div");
      empty.className = "msg note";
      empty.textContent = "暂无消息";
      host.appendChild(empty);
    }
    var lastAgent = "";
    state.events.forEach(function(e){
      if (!e || !e.kind) return;
      var p = e.payload || {};
      if (e.kind === "message.user" && p.text) { appendMsg("user", "我", String(p.text)); lastAgent = ""; }
      else if (e.kind === "message.agent" && p.text) { lastAgent = String(p.text); appendMsg("agent", "Genie", lastAgent); }
      else if (e.kind === "message.system" && p.text) appendNotice(String(p.text));
      else if (e.kind === "task.done" && p.result) {
 // 同一终稿已由 message.agent 渲染时不再重复一条「完成:…」(echo/普通 executor 都会双写)
        var resultText = String(p.result);
        if (resultText !== lastAgent) appendNotice("完成:" + resultText);
      }
    });
    scrollBottom();
  }
  function appendMsg(kind, who, text){
    var el = document.createElement("div");
    el.className = "msg " + kind;
    var w = document.createElement("span"); w.className = "who"; w.textContent = who;
    el.appendChild(w);
    var body = document.createElement("span"); body.textContent = text;
    el.appendChild(body);
    $("msgs").appendChild(el);
    return el;
  }
  function appendNotice(text){
    var el = document.createElement("div"); el.className = "msg note"; el.textContent = text;
    $("msgs").appendChild(el); scrollBottom();
  }
  function handleStream(ev){
    if (!ev || !ev.type) return;
    if (ev.type === "llm-begin") {
      state.live = ""; state.liveEl = appendMsg("agent live", "Genie", "…");
      return;
    }
    if (ev.type === "llm-delta") {
      state.live += String(ev.text || "");
      if (!state.liveEl) state.liveEl = appendMsg("agent live", "Genie", "");
      var body = state.liveEl.lastChild;
      if (body) body.textContent = state.live;
      scrollBottom();
      return;
    }
    if (ev.type === "llm-end") {
      var finalText = String(ev.text || state.live || "");
      if (state.liveEl) {
        state.liveEl.classList.remove("live");
        var b = state.liveEl.lastChild; if (b) b.textContent = finalText;
      } else if (finalText) appendMsg("agent", "Genie", finalText);
      state.live = ""; state.liveEl = null;
      scrollBottom();
      return;
    }
    if (ev.type === "tool-begin" && ev.name) {
      appendNotice("调用工具:" + ev.name + "…");
    }
  }
  function scrollBottom(){
    var host = $("msgs");
    host.scrollTop = host.scrollHeight;
  }
  function focusInput(){
    setTimeout(function(){ try { $("input").focus(); } catch(e){ /* 忽略 */ } }, 50);
  }
  function submitComposer(){
    var text = $("input").value.trim();
    if (!text) return;
    if (state.composeNew) {
      state.loading = true; $("sendBtn").disabled = true;
      var sid = "mobile-" + Date.now().toString(36);
      var projectId = state.activeProjectId === "all" ? undefined : state.activeProjectId;
      var ok = send({type:"task.submit", sessionId: sid, instruction: text, idempotencyKey: "mobile-" + Date.now() + "-" + Math.floor(Math.random()*1e6), ...(projectId ? {projectId} : {})});
      if (ok) {
        $("input").value = "";
        state.loading = false; $("sendBtn").disabled = !state.connected;
        toast("已提交,正在返回任务列表");
        setTimeout(function(){ closeDetail(); send({type:"task.list"}); }, 500);
      }
      return;
    }
    if (!state.openTask) return;
    var projectId2 = state.openTask.projectId;
    var ok2 = send({type:"task.submit", sessionId: state.openTask.sessionId, instruction: text, idempotencyKey: "mobile-" + Date.now() + "-" + Math.floor(Math.random()*1e6), ...(projectId2 ? {projectId: projectId2} : {})});
    if (ok2) { $("input").value = ""; toast("已发送"); }
  }
  function closeDetail(){
    $("detailView").hidden = true;
    state.openTask = null; state.composeNew = false;
    state.live = ""; state.liveEl = null;
  }
  $("newBtn").onclick = openNewTask;
  $("refreshBtn").onclick = function(){ refreshAll(); toast("已刷新"); };
  $("backBtn").onclick = closeDetail;
  $("cancelBtn").onclick = function(){
    if (!state.openTask) return;
    if (!confirm("停止这个任务?")) return;
    send({type:"task.cancel", taskId: state.openTask.id});
    toast("已请求停止");
  };
  $("sendBtn").onclick = submitComposer;
  $("input").addEventListener("input", function(){
    var el = $("input"); el.style.height = "auto"; el.style.height = Math.min(130, el.scrollHeight) + "px";
  });
  $("input").addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitComposer(); }
  });
  if (!TOKEN) {
    $("blocked").classList.add("on");
  } else {
    connect();
  }
})();
</script>
</body></html>`;