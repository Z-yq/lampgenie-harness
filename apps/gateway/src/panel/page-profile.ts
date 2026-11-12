/**
 * 项目档案独立窗口页(逐字自 panel.ts 搬移, 拆分)。
 */
export const PANEL_PROFILE_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>项目档案 · 架构图</title>
<style>
  :root{--bg:#060403;--text:#ece1d1;--muted:#97836a;--faint:#6b5c4a;--bronze:#c98f45;--border:rgba(200,143,69,.28);--green:#9dc08b;--red:#e08a7a}
 *{box-sizing:border-box;margin:0;padding:0}
  #tabbar{display:none !important} /* 用户明确不要会话标签条;即使 renderTabs 被恢复也硬隐藏 */
  body{background:var(--bg);color:var(--text);font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;height:100vh;display:flex;flex-direction:column;padding:14px 18px}
  .hd{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:10px}
  .t{font-size:16px}
  .st{font-size:10px;border:1px solid var(--border);border-radius:4px;padding:0 6px;color:var(--muted)}
  .st.done{color:var(--green)} .st.running{color:#d9b36c} .st.failed{color:var(--red)}
  .bar{flex:1;min-width:100px;height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,#d8a354,#a96f2b);transition:width .3s}
  .pct{font-size:10.5px;color:var(--muted);font-family:monospace;white-space:nowrap}
  .mn{display:flex;gap:14px;flex:1;min-height:0}
  .g{flex:1.6;min-width:0;overflow:hidden;position:relative;border:1px solid var(--border);border-radius:11px;background:rgba(0,0,0,.2);cursor:grab}
  .g.panning{cursor:grabbing}
  .gv{transform-origin:0 0;will-change:transform}
  .gv svg{max-width:none!important;height:auto!important}
  .gtb{position:absolute;top:8px;right:8px;display:flex;gap:4px;z-index:3}
  .gtb button{background:rgba(10,7,4,.75);border:1px solid var(--border);color:var(--muted);border-radius:7px;font-size:12px;width:26px;height:26px;cursor:pointer}
  .gtb button:hover{color:var(--bronze);border-color:var(--bronze)}
  .gtb .zs{font-size:10px;width:auto;padding:0 7px;line-height:24px}
  .g .node{cursor:pointer}
  .g .node.dim{opacity:.18}
  .g .node.hl rect,.g .node.hl polygon{stroke:#d8a354;stroke-width:2.5px}
  .sd{flex:1;min-width:260px;max-width:430px;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
  input{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;padding:6px 12px;outline:none}
  .mod{border:1px solid var(--border);border-radius:9px;padding:7px 11px;cursor:pointer;background:rgba(28,18,10,.55)}
  .mod:hover{border-color:var(--bronze)} .mod.on{border-color:var(--bronze);background:rgba(201,143,69,.1)}
  .mod .n{font-size:12px} .mod .d{font-size:10px;color:var(--faint);margin-top:2px}
  .new{font-size:9px;color:var(--green);border:1px solid rgba(157,192,139,.4);border-radius:4px;padding:0 4px;margin-left:6px}
  .det{border:1px solid var(--border);border-radius:10px;padding:10px 13px;font-size:11.5px;color:var(--muted);line-height:1.7;background:rgba(28,18,10,.55)}
  .det b{color:var(--text);font-weight:400} .det .k{font-family:monospace;font-size:10.5px;color:var(--bronze)}
  .ch{border:1px solid var(--border);border-radius:9px;padding:6px 11px;font-size:10.5px;color:var(--muted)}
  .ch .m{color:var(--bronze);font-family:monospace}
  .plan{border:1px solid rgba(157,192,139,.3);border-radius:11px;background:rgba(157,192,139,.05);padding:10px 12px;display:flex;flex-direction:column;gap:7px}
  .plan h5{font-size:11px;color:var(--green);font-weight:400;letter-spacing:1px}
  .pf{display:flex;gap:5px;flex-wrap:wrap;align-items:center}
  .pf input,.pf select{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;outline:none}
  .pf button{background:transparent;border:1px solid var(--border);color:var(--green);border-radius:7px;font-size:10.5px;padding:3px 10px;cursor:pointer}
  .pi{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted);border:1px dashed var(--border);border-radius:7px;padding:4px 9px}
  .pi b{color:var(--text);font-weight:400} .pi .x{cursor:pointer;color:var(--faint);margin-left:auto} .pi .x:hover{color:var(--red)}
  .apply{background:linear-gradient(90deg,var(--grad-a),var(--grad-b));color:var(--on-accent);border:none;border-radius:8px;font-size:11.5px;padding:5px 16px;cursor:pointer;font-weight:600}
  .git{font-size:10px;color:var(--faint);margin-top:2px}
  .h2{font-size:10px;color:var(--faint);letter-spacing:2px;margin:6px 0 2px}
  .empty{color:var(--faint);font-size:12px;padding:20px;text-align:center}
 /* 主题继承(zh:theme 与主面板同源)+ 二级变量 + 组件化(模态/镜像下拉/按钮四态/键盘可达) */
  :root{--hover-bg:rgba(255,255,255,.05);--on-accent:#0b0806;--input-bg:rgba(0,0,0,.3);--input-border:var(--border);
    --sunken:rgba(0,0,0,.18);--overlay:rgba(0,0,0,.55);--solid:#141009;--scrollbar:rgba(201,143,69,.32);
    --focus-ring:rgba(201,143,69,.65);--accent2:#e08a7a;--grad-a:#d8a354;--grad-b:#a96f2b;--brand:#e9dcc6;--warn:#d9b36c}
  body.light{--bg:#f4eee3;--text:#3d3223;--muted:#7c6c52;--faint:#a3937a;--bronze:#7a5423;--border:rgba(150,100,45,.35);
    --green:#5c8a4a;--red:#b8543f;--hover-bg:rgba(120,90,50,.07);--on-accent:#fff8ec;--input-bg:rgba(255,255,255,.72);
    --input-border:rgba(150,100,45,.28);--sunken:rgba(120,90,50,.08);--overlay:rgba(80,60,40,.35);--solid:#fffdf8;
    --scrollbar:rgba(150,100,45,.35);--focus-ring:rgba(150,100,45,.6);--accent2:#b8543f;--grad-a:#d8a354;--grad-b:#a96f2b;--brand:#6b4a1d;--warn:#a67c2e}
  body.theme-sand{--bg:#E3DCD2;--text:#013328;--muted:#4E655A;--faint:#87948B;--bronze:#CC8B65;--border:rgba(1,51,40,.28);--green:#3F6B4F;--red:#A84A3C;
    --hover-bg:rgba(1,51,40,.06);--on-accent:#FFF8F1;--input-bg:rgba(255,252,247,.76);--input-border:rgba(1,51,40,.20);--sunken:rgba(1,51,40,.06);
    --overlay:rgba(16,12,13,.35);--solid:#F6F1E9;--scrollbar:rgba(1,51,40,.28);--focus-ring:rgba(204,139,101,.68);--accent2:#013328;--grad-a:#CC8B65;--grad-b:#A96B49;--brand:#013328;--warn:#9A6A2F}
  body.theme-glass{--bg:#232030;--text:#f4f1fb;--muted:#b6b0d2;--faint:#8882ab;--bronze:#c4b5fd;--border:rgba(255,255,255,.3);--green:#86efac;--red:#fda4af;
    --hover-bg:rgba(255,255,255,.1);--on-accent:#2a2440;--input-bg:rgba(255,255,255,.09);--input-border:rgba(255,255,255,.2);--sunken:rgba(255,255,255,.06);
    --overlay:rgba(30,26,48,.5);--solid:#2c2742;--scrollbar:rgba(255,255,255,.32);--focus-ring:rgba(196,181,253,.85);--accent2:#f0abfc;--grad-a:#c4b5fd;--grad-b:#f0abfc;--brand:#e4dcff;--warn:#fde68a}
  body.theme-olive{--bg:#CDCBD6;--text:#2F3020;--muted:#5C604A;--faint:#8C8F7E;--bronze:#D96846;--border:rgba(47,48,32,.28);--green:#596235;--red:#A8402E;
    --hover-bg:rgba(47,48,32,.06);--on-accent:#FFF8F4;--input-bg:rgba(250,249,253,.76);--input-border:rgba(47,48,32,.20);--sunken:rgba(47,48,32,.06);
    --overlay:rgba(47,48,32,.35);--solid:#E3E1E9;--scrollbar:rgba(47,48,32,.28);--focus-ring:rgba(217,104,70,.68);--accent2:#596235;--grad-a:#D96846;--grad-b:#B34E30;--brand:#2F3020;--warn:#8A6A20}
  body.theme-plum{--bg:#F2EBE5;--text:#2B262D;--muted:#6B6470;--faint:#9A939C;--bronze:#9F496E;--border:rgba(43,38,45,.28);--green:#4F6B5A;--red:#A84A4A;
    --hover-bg:rgba(43,38,45,.06);--on-accent:#FFF8FA;--input-bg:rgba(255,253,250,.76);--input-border:rgba(43,38,45,.20);--sunken:rgba(43,38,45,.06);
    --overlay:rgba(43,38,45,.35);--solid:#FBF7F3;--scrollbar:rgba(43,38,45,.28);--focus-ring:rgba(159,73,110,.68);--accent2:#647295;--grad-a:#9F496E;--grad-b:#7D3755;--brand:#2B262D;--warn:#9A6A2F}
  body.theme-ink{--bg:#f6f6f4;--text:#141414;--muted:#5c5c58;--faint:#98978f;--bronze:#d43d2a;--border:rgba(17,17,17,.38);--green:#2f7d32;--red:#c62828;
    --hover-bg:rgba(17,17,17,.05);--on-accent:#ffffff;--input-bg:#ffffff;--input-border:rgba(17,17,17,.24);--sunken:#efeeea;
    --overlay:rgba(20,20,20,.42);--solid:#ffffff;--scrollbar:rgba(17,17,17,.3);--focus-ring:rgba(212,61,42,.7);--accent2:#141414;--grad-a:#d43d2a;--grad-b:#8f1f12;--brand:#141414;--warn:#b26a00}
 *{scrollbar-width:thin;scrollbar-color:var(--scrollbar) transparent}
  ::-webkit-scrollbar{width:5px}
  ::-webkit-scrollbar-thumb{background:var(--scrollbar);border-radius:3px}
  ::selection{background:var(--bronze);color:var(--on-accent)}
  button{background:var(--hover-bg);border:1px solid var(--border);color:var(--muted);border-radius:8px;transition:border-color .15s,color .15s,background .15s,transform .06s}
  button:hover{border-color:var(--bronze);color:var(--text)}
  button:active{transform:translateY(1px)}
  button:disabled{opacity:.45;cursor:not-allowed}
  :where(button,input,select,textarea,[tabindex]):focus{outline:none}
  :where(button,input,select,textarea,[tabindex]):focus-visible{outline:2px solid var(--focus-ring);outline-offset:1px}
  input,select{background:var(--input-bg)!important;border:1px solid var(--input-border)!important;color:var(--text)!important}
  .ui-sel-wrap{position:relative;display:inline-flex;max-width:100%}
  select.ui-native{position:absolute!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;margin:0!important;padding:0!important}
  .ui-sel{display:inline-flex;align-items:center;gap:6px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;min-width:72px;text-align:left}
  .ui-sel:hover{border-color:var(--bronze)}
  .ui-sel .ui-sel-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .ui-sel .ui-sel-chev{color:var(--faint);font-size:9px;display:flex;align-items:center}
  .ui-sel .ui-sel-chev .icn{width:10px;height:10px;stroke-width:2}
  .icn{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:inline-block;vertical-align:-0.15em}
  .gtb .icn{width:13px;height:13px;vertical-align:-2px}
  .ui-sel-pop{position:absolute;top:calc(100% + 4px);left:0;min-width:100%;max-height:240px;overflow-y:auto;z-index:95;background:var(--solid);border:1px solid var(--border);border-radius:9px;box-shadow:0 12px 40px var(--overlay);display:none;padding:4px}
  .ui-sel-pop.up{top:auto;bottom:calc(100% + 4px)}
  .ui-sel-pop.open{display:block}
  .ui-sel-opt{padding:4px 10px;border-radius:6px;font-size:11px;color:var(--muted);cursor:pointer;white-space:nowrap}
  .ui-sel-opt:hover,.ui-sel-opt.hot{background:var(--hover-bg);color:var(--text)}
  .ui-sel-opt[aria-selected="true"]{color:var(--bronze)}
  .uid-mask{position:fixed;inset:0;z-index:200;background:var(--overlay);display:flex;align-items:center;justify-content:center}
  .uid-box{width:min(420px,calc(100vw - 48px));background:var(--solid);border:1px solid var(--border);border-radius:14px;padding:18px 20px;box-shadow:0 24px 80px var(--overlay)}
  .uid-box h3{font-size:13px;color:var(--brand);margin-bottom:10px;font-weight:400;letter-spacing:1px}
  .uid-box .uid-msg{font-size:12px;line-height:1.8;color:var(--text);white-space:pre-wrap;background:var(--sunken);border-radius:9px;padding:10px 12px;margin-bottom:14px;max-height:50vh;overflow-y:auto}
  .uid-btns{display:flex;gap:10px;justify-content:flex-end}
  .uid-btns button{min-width:88px;padding:7px 0;font-size:12px;letter-spacing:2px}
  .uid-btns .uid-ok{border-color:var(--bronze);color:var(--on-accent);background:linear-gradient(135deg,var(--grad-a),var(--grad-b))}
  .uid-btns .uid-cancel{background:transparent;color:var(--muted)}
</style></head><body>
<div class="hd"><span class="t" id="t">项目档案</span><span class="st" id="st">连接中</span><div class="bar"><i id="bar" style="width:0%"></i></div><span class="pct" id="pct"></span></div>
<div class="mn">
  <div class="g" id="g"><div class="gv" id="gv"><div class="empty">连接 gateway…</div></div>
    <div class="gtb"><button id="zin" aria-label="放大"><svg class="icn" viewBox="0 0 24 24"><path d="M12 5.5v13"/><path d="M5.5 12h13"/></svg></button><button id="zout" aria-label="缩小"><svg class="icn" viewBox="0 0 24 24"><path d="M5.5 12h13"/></svg></button><button id="zs" class="zs">1:1</button></div>
  </div>
  <div class="sd">
    <input id="q" placeholder="搜索模块名…">
    <div id="mods" style="display:flex;flex-direction:column;gap:4px"></div>
    <div id="det"></div>
    <div class="h2">图上规划(改图→任务书→agent 执行)</div>
    <div class="plan" id="plan">
      <div class="pf"><input id="paName" placeholder="新模块名" style="width:90px"><input id="paNote" placeholder="职责" style="flex:1;min-width:90px"><button id="paGo">+ 模块</button></div>
      <div class="pf"><select id="pdSel"></select><button id="pdGo">− 移除</button><select id="pfFrom"></select><span style="color:var(--faint)">→</span><select id="pfTo"></select><button id="pfGo">+ 依赖</button></div>
      <div id="pList" style="display:flex;flex-direction:column;gap:4px"></div>
      <button class="apply" id="pApply">生成计划并执行</button>
    </div>
    <div class="h2">演进(agent 变更记录)</div>
    <div id="chs" style="display:flex;flex-direction:column;gap:4px"></div>
  </div>
</div>
<script src="/assets/mermaid.min.js"></script>
<script src="/assets/input-policy.js"></script> <!-- 独立档案页同样分区接管(图容器 #g) -->
<script>
var pid = new URLSearchParams(location.search).get("p") || "";
var data = null, sel = null;
var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
ws.onopen = function () { ws.send(JSON.stringify({ v: 1, type: "profile.get", projectId: pid })); };
ws.onmessage = function (ev) {
  var m = JSON.parse(ev.data);
  if (m.type === "profile.get.result" && m.profile) render(m.profile);
  if (m.type === "profile.progress" && m.projectId === pid) {
    bar.style.width = (m.progress || 0) + "%";
    pct.textContent = (m.progress || 0) + "% · " + (m.stage || "");
    st.textContent = m.state === "done" ? "完成" : m.state === "running" ? "分析中" : m.state;
    st.className = "st " + m.state;
    if (m.state === "done") ws.send(JSON.stringify({ v: 1, type: "profile.get", projectId: pid }));
  }
};
function esc(x) { return String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function render(d) {
  data = d; sel = null;
  t.textContent = "项目档案 · " + (d.projectId || "");
  st.textContent = d.state === "done" ? "完成" : d.state === "running" ? "分析中" : d.state;
  st.className = "st " + d.state;
  bar.style.width = (d.progress || 0) + "%";
  pct.textContent = d.state === "done" ? (d.stats ? d.stats.files + " 文件 · " + (d.modules || []).length + " 模块" : "") : (d.progress || 0) + "% · " + (d.stage || "");
  if (d.mermaid && window.mermaid) {
    mermaid.render("pg", d.mermaid).then(function (o) {
      gv.innerHTML = (o && o.svg ? o.svg : o);
      bindGraph(gv, gv.querySelector("svg"), d);
    }).catch(function () { gv.innerHTML = "<div class=empty>图渲染失败</div>"; });
  } else g.innerHTML = "<div class=empty>" + (d.state === "done" ? "无图" : "构建中…") + "</div>";
  modsRender();
  planR();
  chs.innerHTML = (d.recentChanges || []).length ? d.recentChanges.slice(0, 12).map(function (c) {
    return "<div class=ch>" + esc(String(c.title).slice(0, 60)) + (c.modules && c.modules.length ? " · <span class=m>" + esc(c.modules.join(",").slice(0, 40)) + "</span>" : "") + "<div style='color:var(--faint);font-size:9.5px;margin-top:2px'>" + new Date(c.at).toLocaleString() + "</div></div>";
  }).join("") : "<div class=empty>暂无变更记录</div>";
}
function modsRender() {
  if (!data) return;
  var q = (document.getElementById("q").value || "").toLowerCase();
  var ms = (data.modules || []).filter(function (m) { return !q || m.name.toLowerCase().indexOf(q) >= 0; });
  mods.innerHTML = ms.length ? ms.slice(0, 80).map(function (m) {
    return "<div class=mod data-m='" + esc(m.name) + "'><span class=n>" + esc(m.name) + (m.addedAt ? "<span class=new>新</span>" : "") + "</span><div class=d>" + esc(String(m.desc).slice(0, 70)) + "</div></div>";
  }).join("") : "<div class=empty>无匹配</div>";
  Array.prototype.forEach.call(mods.querySelectorAll(".mod"), function (el) {
    el.onclick = function () { detail(el.getAttribute("data-m")); };
  });
  if (sel) detail(sel);
}
function detail(name) {
  sel = name;
  var m = (data.modules || []).filter(function (x) { return x.name === name; })[0];
  if (!m) { det.innerHTML = ""; return; }
  var rvs = (data.edges || []).filter(function (e) { return e.from === name; }).map(function (e) { return e.to; });
  var by = (data.edges || []).filter(function (e) { return e.to === name; }).map(function (e) { return e.from; });
  var gh = (data.gitHistory || []).filter(function (x) { return x.module === name; })[0];
  var git = gh && gh.commits && gh.commits.length ? "<br>最近提交(" + (gh.commits30d || 0) + "/30天):" + gh.commits.slice(0, 4).map(function (c) {
    return "<div class=git>" + new Date(c.at).toLocaleDateString() + " · " + esc(c.author) + " · " + esc(String(c.subject).slice(0, 40)) + "</div>";
  }).join("") : "";
  det.innerHTML = "<div class=det><b>" + esc(name) + "</b><br>" + esc(m.desc) +
    "<br>依赖: " + (rvs.join("、") || "无") + "<br>被依赖: " + (by.join("、") || "无") + git +
    "<br>代表文件:<div class=k>" + (m.keyFiles || []).map(esc).join("<br>") + "</div></div>";
  Array.prototype.forEach.call(mods.querySelectorAll(".mod"), function (el) { el.classList.toggle("on", el.getAttribute("data-m") === name); });
}
document.getElementById("q").oninput = modsRender;
// 规划态(独立页):与主视图共用 profile.plan.* 消息
function planR() {
  if (!data) return;
  var plan = data.plan || [];
  var names = (data.modules || []).map(function (m) { return m.name; });
  var o = function (a) { return a.map(function (x) { return "<option value='" + esc(x) + "'>" + esc(x) + "</option>"; }).join(""); };
  pdSel.innerHTML = o(names);
  pfFrom.innerHTML = o(names.concat(plan.filter(function (x) { return x.kind === "add-module"; }).map(function (x) { return x.name; })));
  pfTo.innerHTML = pfFrom.innerHTML;
  var kt = { "add-module": "新增", "remove-module": "移除", "add-dep": "依赖" };
  pList.innerHTML = plan.length ? plan.map(function (x) {
    var lb = x.kind === "add-dep" ? x.from + " → " + x.to : x.name;
    return "<div class=pi><span style='color:var(--green)'>" + kt[x.kind] + "</span><b>" + esc(lb) + "</b><span class=x data-id='" + esc(x.id) + "' title='移除'>" + ic("x") + "</span></div>";
  }).join("") : "<div style='font-size:10.5px;color:var(--faint)'>暂无规划项</div>";
  Array.prototype.forEach.call(pList.querySelectorAll(".x"), function (el) {
    el.onclick = function () { ws.send(JSON.stringify({ v: 1, type: "profile.plan.remove", projectId: pid, id: el.getAttribute("data-id") })); };
  });
}
// 图交互:缩放(滚轮/按钮)+拖拽平移+节点点选(选中模块→右侧详情联动+邻接高亮,再点恢复)—— var zScale = 1, zTx = 0, zTy = 0;
function applyZ() { gv.style.transform = "translate(" + zTx + "px," + zTy + "px) scale(" + zScale + ")"; document.getElementById("zs").textContent = Math.round(zScale * 100) + "%"; }
function bindGraph(view, svg, d) {
  if (!svg) return;
  svg.style.maxWidth = "none";
 // 滚轮缩放(以鼠标为中心)
  view.addEventListener("wheel", function (e) {
    e.preventDefault();
    var rect = view.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    var ns = Math.min(8, Math.max(0.2, zScale * factor));
    var k = ns / zScale;
    zTx = mx - (mx - zTx) * k; zTy = my - (my - zTy) * k; zScale = ns;
    applyZ();
  }, { passive: false });
 // 拖拽平移(统一 pointer:位移>3px 即平移;否则放行为节点点击——节点拖拽/点选并存)
  var drag = null;
  view.addEventListener("mousedown", function (e) {
    drag = { x: e.clientX, y: e.clientY, tx: zTx, ty: zTy, moved: false };
  });
  window.addEventListener("mousemove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) * Math.abs(dx) + Math.abs(dy) * Math.abs(dy) < 9) return;
    if (!drag.moved) { drag.moved = true; view.classList.add("panning"); }
    zTx = drag.tx + dx; zTy = drag.ty + dy;
    applyZ();
  });
  window.addEventListener("mouseup", function () { drag = null; view.classList.remove("panning"); });
 // 工具条
  document.getElementById("zin").onclick = function () { zScale = Math.min(8, zScale * 1.25); applyZ(); };
  document.getElementById("zout").onclick = function () { zScale = Math.max(0.2, zScale / 1.25); applyZ(); };
  document.getElementById("zs").onclick = function () { zScale = 1; zTx = 0; zTy = 0; applyZ(); };
 // 节点点选:模块名 → 右侧详情(展开)+邻接高亮(再点恢复)
  var nodes = {};
  (d.modules || []).forEach(function (m) { nodes[m.name] = m; });
  svg.querySelectorAll(".node").forEach(function (el) {
    el.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var label = (el.querySelector("title") || {}).textContent || el.textContent || "";
      var name = (d.modules || []).find(function (m) { return label.indexOf(m.name) >= 0 || (m.name && el.textContent.indexOf(m.name) >= 0); });
      name = name ? name.name : null;
      if (!name) return;
      if (sel === name) { // 再点=收缩(恢复全亮)
        sel = null;
        svg.querySelectorAll(".node.dim").forEach(function (x) { x.classList.remove("dim"); });
        svg.querySelectorAll(".edgeThick").forEach(function (x) { x.classList.remove("edgeThick"); });
        detail(null);
        return;
      }
      sel = name;
 // 邻接计算:直接依赖双向保留,其余淡化
      var keep = new Set([name]);
      (d.edges || []).forEach(function (e) { if (e.from === name) keep.add(e.to); if (e.to === name) keep.add(e.from); });
      svg.querySelectorAll(".node").forEach(function (x) {
        var on = false;
        for (const k of keep) if (x.textContent.indexOf(k) >= 0) { on = true; break; }
        x.classList.toggle("dim", !on);
        x.classList.toggle("hl", on && x.textContent.indexOf(name) >= 0);
      });
      detail(name);
    });
  });
}
function mkItem(kind, extra) {
  var o = { id: "pl-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e4), kind: kind, createdAt: Date.now() };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  return o;
}
paGo.onclick = function () {
  var n = paName.value.trim();
  if (!n) return;
  ws.send(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: pid, item: mkItem("add-module", { name: n, note: paNote.value.trim() }) }));
  paName.value = ""; paNote.value = "";
};
pdGo.onclick = function () { if (pdSel.value) ws.send(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: pid, item: mkItem("remove-module", { name: pdSel.value, reason: "" }) })); };
pfGo.onclick = function () { if (pfFrom.value && pfTo.value && pfFrom.value !== pfTo.value) ws.send(JSON.stringify({ v: 1, type: "profile.plan.upsert", projectId: pid, item: mkItem("add-dep", { from: pfFrom.value, to: pfTo.value, note: "" }) })); };
pApply.onclick = function () {
  if (!data || !(data.plan || []).length) return;
  uiConfirm("按 " + data.plan.length + " 项规划生成任务书并派发?").then(function (ok) {
    if (ok) ws.send(JSON.stringify({ v: 1, type: "profile.plan.apply", projectId: pid }));
  });
};
// ---- 主题继承 + 主题化模态 + 原生 select 镜像接管(与主面板同语义;ES5 形态随本页) ----
try {
  var __t = localStorage.getItem("zh:theme") || "dark";
  var __legacy = { neon: "sand", crt: "olive", aurora: "plum" };
  if (__legacy[__t]) { __t = __legacy[__t]; try { localStorage.setItem("zh:theme", __t); } catch (e) {} }
  if (__t === "light") document.body.className = "light";
  else if (__t === "sand" || __t === "olive" || __t === "plum") document.body.className = "light theme-" + __t;
  else if (__t && __t !== "dark" && __t !== "system") document.body.className = "theme-" + __t;
} catch (e) {}
function uiConfirm(msg, o) {
  o = o || {};
  return new Promise(function (resolve) {
    var mask = document.createElement("div");
    mask.className = "uid-mask";
    mask.innerHTML = '<div class="uid-box" role="dialog" aria-modal="true"><h3>' + esc(o.title || "请确认") + '</h3><div class="uid-msg">' + esc(msg) + '</div><div class="uid-btns"><button class="uid-cancel">取消</button><button class="uid-ok">' + esc(o.ok || "确定") + "</button></div></div>";
    var done = function (v) { mask.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    var onKey = function (e) { if (e.key === "Escape") { e.preventDefault(); done(false); } else if (e.key === "Enter") { e.preventDefault(); done(true); } };
    document.addEventListener("keydown", onKey, true);
    mask.onclick = function (e) { if (e.target === mask) done(false); };
    mask.querySelector(".uid-ok").onclick = function () { done(true); };
    mask.querySelector(".uid-cancel").onclick = function () { done(false); };
    document.body.appendChild(mask);
    mask.querySelector(".uid-ok").focus();
  });
}
function pBeautify(sel) {
  if (!sel || sel.dataset.uiSel) return;
  sel.dataset.uiSel = "1";
  sel.classList.add("ui-native");
  var wrap = document.createElement("span");
  wrap.className = "ui-sel-wrap";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  var btn = document.createElement("button");
  btn.type = "button"; btn.className = "ui-sel"; btn.setAttribute("aria-haspopup", "listbox");
  var lab = document.createElement("span"); lab.className = "ui-sel-label";
  var chev = document.createElement("span"); chev.className = "ui-sel-chev"; chev.innerHTML = '<svg class="icn" viewBox="0 0 24 24"><path d="M5.5 9.5l6.5 6.5 6.5-6.5"/></svg>';
  btn.appendChild(lab); btn.appendChild(chev);
  var pop = document.createElement("div"); pop.className = "ui-sel-pop"; pop.setAttribute("role", "listbox");
  wrap.appendChild(btn); wrap.appendChild(pop);
  var sync = function () { var o = sel.selectedOptions && sel.selectedOptions[0]; lab.textContent = o ? (o.textContent || "").trim() : ""; };
  var close = function () { pop.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onEsc, true); };
  var onDoc = function (e) { if (!wrap.contains(e.target)) close(); };
  var onEsc = function (e) { if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); } };
  var open = function () {
    pop.innerHTML = "";
    Array.prototype.forEach.call(sel.options, function (o) {
      var d = document.createElement("div");
      d.className = "ui-sel-opt"; d.setAttribute("role", "option"); d.dataset.v = o.value;
      d.textContent = (o.textContent || "").trim();
      if (o.value === String(sel.value)) d.setAttribute("aria-selected", "true");
      d.onclick = function () { if (String(sel.value) !== d.dataset.v) { sel.value = d.dataset.v; sel.dispatchEvent(new Event("change", { bubbles: true })); } sync(); close(); };
      pop.appendChild(d);
    });
    var r = btn.getBoundingClientRect();
    pop.classList.toggle("up", r.bottom + Math.min(pop.scrollHeight || 120, 240) + 8 > window.innerHeight && r.top > 200);
    pop.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    setTimeout(function () { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onEsc, true); }, 0);
  };
  btn.onclick = function () { if (pop.classList.contains("open")) close(); else open(); };
  btn.onkeydown = function (e) {
    if (!pop.classList.contains("open")) { if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } return; }
    var its = pop.querySelectorAll(".ui-sel-opt");
    var cur = -1; Array.prototype.forEach.call(its, function (x, i) { if (x.classList.contains("hot")) cur = i; });
    if (e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(its.length - 1, cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(0, cur - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (cur >= 0) its[cur].click(); return; }
    else if (e.key === "Escape") { e.preventDefault(); close(); return; }
    else if (e.key === "Tab") { close(); return; }
    else return;
    Array.prototype.forEach.call(its, function (x, i) { x.classList.toggle("hot", i === cur); });
    if (its[cur]) its[cur].scrollIntoView({ block: "nearest" });
  };
  sel.addEventListener("change", sync);
  sync();
}
function pBeautifyAll() { Array.prototype.forEach.call(document.querySelectorAll("select"), pBeautify); }
pBeautifyAll();
new MutationObserver(function () { pBeautifyAll(); }).observe(document.documentElement, { childList: true, subtree: true });
</script></body></html>`;
