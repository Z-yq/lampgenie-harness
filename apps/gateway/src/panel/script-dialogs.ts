/**
 * 面板主脚本分片:script-dialogs(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_DIALOGS = `// ----  管理面表单提交 ----
$("cmdSave").onclick = () => {
  const name = $("cmdForm").querySelector("input[name=cname]").value.trim();
  const body = $("cmdForm").querySelector("input[name=cbody]").value.trim();
  if (!name || !body) { toast("命令名与模板都必填", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "commands.upsert", name, body }));
  $("cmdForm").querySelector("input[name=cname]").value = "";
  $("cmdForm").querySelector("input[name=cbody]").value = "";
};
$("hookSave").onclick = () => {
  const name = $("hookForm").querySelector("input[name=hname]").value.trim();
  const event = $("hookEventSel").value;
  const command = $("hookForm").querySelector("input[name=hcmd]").value.trim();
  if (!name || !command) { toast("名称与命令必填", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "hooks.upsert", name, event, command }));
  $("hookForm").querySelector("input[name=hname]").value = "";
  $("hookForm").querySelector("input[name=hcmd]").value = "";
};
$("mcpSave").onclick = () => {
  const name = $("mcpForm").querySelector("input[name=mname]").value.trim();
  const command = $("mcpForm").querySelector("input[name=mcmd]").value.trim();
  const args = $("mcpForm").querySelector("input[name=margs]").value.trim();
  if (!name || !command) { toast("名称与命令必填", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "mcp.upsert", name, command, args: args ? args.split(" ") : [] }));
  $("mcpForm").querySelector("input[name=mname]").value = "";
  $("mcpForm").querySelector("input[name=mcmd]").value = "";
  $("mcpForm").querySelector("input[name=margs]").value = "";
};
$("mcpRefresh").onclick = () => sendOrQueue({ v: 1, type: "mcp.list", refresh: true });
// ---- 工具提供商设置(并入「模型设置」页;默认 DeepSeek)----
// 保存链:API Key → cfg.secret.set(写 .genie/secrets.json,值不进配置/日志);provider/endpoint/model
// → cfg.set web.search.*(热生效:工具每次查询现读配置)。Key 留空=沿用已存密钥(只改 provider)。
let wsSavePending = 0; // 工具提供商保存/清除在飞时间戳(:回包确认后再刷新状态行与提示)
function wsSearchStateRender() {
  const w = cfgView && cfgView.config && cfgView.config.web && cfgView.config.web.search ? cfgView.config.web.search : {};
 // UI 档位:default(provider 空,按 DeepSeek 解析)/ off(显式关闭走 curl·browser)/ 具体 provider
  const cur = w.disabled === true ? "off" : String(w.provider || "") || "default";
  for (const b of $("ws-provider").querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === cur);
  const keyName = w.apiKeyEnv || "DEEPSEEK_API_KEY";
  let text;
  if (cur === "off") text = "当前:已关闭搜索 API —— web_search 用内置静态检索(curl 等价),失败指路 browser";
  else if (cur === "default") text = "当前:默认 DeepSeek(密钥沿用 DEEPSEEK_API_KEY;未配置密钥时自动改用内置静态检索 + browser)";
  else text = "当前:" + cur + (w.endpoint ? " · " + w.endpoint : "") + " · 密钥(" + keyName + ",保存时可留空沿用)";
  $("wsState").textContent = text;
}
// 分段点击绑定(故障修复):此前 #ws-provider 没有任何 click 监听——点 DeepSeek/关闭
// 既不变选中态,保存时读到的永远是渲染时的旧 .on,表现为「无法设置也无法关闭」。
$("ws-provider").onclick = (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button") : null;
  if (!b || !b.dataset || b.dataset.v === undefined) return;
  for (const x of $("ws-provider").querySelectorAll("button")) x.classList.toggle("on", x === b);
  $("wsState").textContent = "已选:「" + b.textContent + "」—— 点「保存」生效";
};
$("wsSave").onclick = () => {
  const onBtn = $("ws-provider").querySelector("button.on");
  const pick = onBtn && onBtn.dataset ? String(onBtn.dataset.v || "") : "default";
  const f = $("wsForm");
  const key = f.querySelector("input[name=wkey]").value.trim();
  const endpoint = f.querySelector("input[name=wendpoint]").value.trim();
  const model = f.querySelector("input[name=wmodel]").value.trim();
  if (pick === "custom" && !endpoint) { toast("自定义 provider 需要填端点", true); return; }
 // default/off 都不写具体 provider:default 留空让运行时按 DeepSeek 解析,off 只置 disabled。
  const provider = pick === "default" || pick === "off" ? "" : pick;
  const disabled = pick === "off";
  const prevCfg = (cfgView && cfgView.config && cfgView.config.web && cfgView.config.web.search) || {};
  const keyName = pick === "default" || pick === "off" ? "DEEPSEEK_API_KEY" : (prevCfg.apiKeyEnv || "GENIE_WEB_SEARCH_KEY");
  const go = () => wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { web: { search: {
    provider, disabled, ...(pick === "default" || pick === "off" ? {} : { apiKeyEnv: keyName }),
    ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}),
  } } } }));
  wsSavePending = Date.now();
  if (key) {
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.secret.set", name: keyName, value: key, rid: "ws-key-" + Date.now() }));
    setTimeout(go, 300); // 密钥先落盘再写配置(乱序时 provider 解析缺 key 会如实降级,不致假绿)
  } else go();
 // 回包到达前不宣称已保存(旧实现无条件 toast「已保存」,服务端拒收时用户只看到假的成功)
  f.querySelector("input[name=wkey]").value = "";
  toast("已提交,等待服务端确认…");
};
// 清除 = 回到默认 DeepSeek(不带任何 provider/端点覆盖);无密钥时运行时自动走 curl/browser。
$("wsClear").onclick = () => {
  wsSavePending = Date.now();
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { web: { search: { provider: "", apiKeyEnv: "", endpoint: "", model: "", disabled: false } } } }));
  toast("已提交清除,等待服务端确认…");
};
(function () {
 // cfg.get.result 到达时刷新状态行(初次与每次保存后回包都走这里)
  const prev = window.__wsCfgHook;
  window.__wsCfgHook = function (m) { if (prev) prev(m); try { wsSearchStateRender(); } catch (e) {} };
  sendOrQueue({ v: 1, type: "cfg.get" });
})();
ws.sendWhenOpen = ws.sendWhenOpen || [];
function sendOrQueue(obj) { if (ws.readyState === 1) wsSafeSend(JSON.stringify(obj)); }

// ---- 主题化模态(alert/confirm/prompt 全替换;Promise 化;危险/警告/信息三态) ----
// 契约:uiAlert(msg[,o])→Promise<void>;uiConfirm(msg[,o])→Promise<boolean>;uiPrompt(msg[,def][,o])→Promise<string|null>(取消=null)。
// o:{title, ok, cancel, tone:"danger"|"warning"|"info", placeholder, allowEmpty, kicker};Enter=确认/Esc=取消;焦点落主按钮/输入框。
function uiDialog(opts) {
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "uid-mask";
    const tone = opts.tone || "info";
    const kicker = tone === "danger" ? "请确认 · 不可逆操作" : tone === "warning" ? "请注意" : (opts.kicker || "提示");
    mask.innerHTML =
      '<div class="uid-box ' + tone + '" role="dialog" aria-modal="true">' +
      '<div class="uid-kicker">' + esc(kicker) + "</div>" +
      (opts.title ? "<h3>" + esc(opts.title) + "</h3>" : "") +
      (opts.input ? '<input class="uid-input" placeholder="' + esc(opts.placeholder || "") + '" autocomplete="off" spellcheck="false">' : "") +
      (opts.msg ? '<div class="uid-msg">' + esc(opts.msg) + "</div>" : "") +
      '<div class="uid-btns">' +
      (opts.cancel !== null ? '<button class="uid-cancel">' + esc(opts.cancel || "取消") + "</button>" : "") +
 // danger 确认钮变体(ref confirmDialog confirmVariant:"destructive"):运行中项目移除等场景
      '<button class="uid-ok' + (opts.okClass ? " " + esc(opts.okClass) : "") + '">' + esc(opts.ok || "确定") + "</button></div></div>";
    const done = (v) => { mask.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const okBtn = mask.querySelector(".uid-ok");
    const cancelBtn = mask.querySelector(".uid-cancel");
    const inputEl = mask.querySelector(".uid-input");
    const submit = () => done(opts.input ? (inputEl.value.trim() || (opts.allowEmpty ? "" : null)) : true);
    okBtn.onclick = submit;
    if (cancelBtn) cancelBtn.onclick = () => done(opts.input ? null : false);
    mask.onclick = (e) => { if (e.target === mask && cancelBtn) done(opts.input ? null : false); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(cancelBtn ? (opts.input ? null : false) : undefined); }
      else if (e.key === "Enter") { e.preventDefault(); submit(); }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(mask);
    if (inputEl) { inputEl.value = opts.def != null ? String(opts.def) : ""; inputEl.focus(); inputEl.select(); }
    else okBtn.focus();
  });
}
function uiAlert(msg, o) { o = Object.assign({}, o || {}); o.msg = msg; o.cancel = null; return uiDialog(o).then(() => {}); }
function uiConfirm(msg, o) { o = Object.assign({}, o || {}); o.msg = msg; if (o.okClass === "danger") o.tone = o.tone || "danger"; return uiDialog(o).then((v) => v === true); } // danger 确认钮联动 danger tone(标题红点/文案分级随钮)
function uiPrompt(msg, def, o) { o = Object.assign({}, o || {}); o.msg = msg; o.input = true; o.def = def; o.tone = o.tone || "info"; return uiDialog(o); }
// ---- P0-1:富内容大视图模态(表格预览等)----
// uiDialog 只吃纯文本 msg;这里要挂已渲染好的受信 HTML(表体)。契约:uiModal(html[,o]) → { mask, close }。
// o:{kicker, title, sub, cls, onClose};点遮罩 / Esc / 右上「关闭」都关;内容区 .uid-body 自带滚动。
function uiModal(html, o) {
  const opt = o || {};
  const mask = document.createElement("div");
  mask.className = "uid-mask uid-modal-mask" + (opt.cls ? " " + opt.cls : "");
  mask.innerHTML =
    '<div class="uid-box info uid-modal' + (opt.cls ? " " + opt.cls : "") + '" role="dialog" aria-modal="true">' +
    '<div class="uid-head">' +
    '<div class="uid-kicker">' + esc(opt.kicker || "预览") + "</div>" +
    (opt.title ? "<h3>" + esc(opt.title) + "</h3>" : "") +
    (opt.sub ? '<div class="uid-sub">' + esc(opt.sub) + "</div>" : "") +
    '<button type="button" class="uid-x" title="关闭">关闭</button></div>' +
    '<div class="uid-body">' + String(html == null ? "" : html) + "</div></div>";
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const close = () => {
    if (!mask.parentNode) return;
    mask.remove();
    document.removeEventListener("keydown", onKey, true);
    if (typeof opt.onClose === "function") { try { opt.onClose(); } catch (e) { /* 忽略 */ } }
  };
  const x = mask.querySelector(".uid-x");
  if (x) x.onclick = close;
 // 只在「按下点就在遮罩上」时关,避免从表体里拖选文本、松手到遮罩外误关
  mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(mask);
  return { mask: mask, close: close };
}

// ---- 原生 select 镜像式接管(原生 select 保留为数据源;主题化按钮+弹层双向同步;键盘 ↑↓/Enter/Esc) ----
function uiSelLabel(sel) {
  const o = sel.selectedOptions && sel.selectedOptions[0];
  return o ? (o.textContent || "").trim() || "(空)" : (sel.value || "(空)");
}
function beautifySelect(sel) {
  if (!sel || sel.dataset.uiSel) return;
  sel.dataset.uiSel = "1";
  sel.classList.add("ui-native");
  const wrap = document.createElement("span");
  wrap.className = "ui-sel-wrap";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ui-sel";
  btn.setAttribute("aria-haspopup", "listbox");
  const lab = document.createElement("span");
  lab.className = "ui-sel-label";
  const chev = document.createElement("span");
  chev.className = "ui-sel-chev";
  chev.innerHTML = '<svg class="icn" viewBox="0 0 24 24"><path d="M5.5 9.5l6.5 6.5 6.5-6.5"/></svg>'; // 下拉指示改素描描绘
  btn.append(lab, chev);
  const pop = document.createElement("div");
  pop.className = "ui-sel-pop";
  pop.setAttribute("role", "listbox");
  wrap.append(btn, pop);
  const sync = () => { lab.textContent = uiSelLabel(sel); };
  let hot = -1;
  const items = () => [...pop.querySelectorAll(".ui-sel-opt")];
  const close = () => { pop.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); hot = -1; document.removeEventListener("mousedown", onDoc, true); document.removeEventListener("keydown", onEsc, true); };
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); btn.focus(); } };
  const choose = (idx) => {
    const it = items()[idx];
    if (!it) return;
    const v = it.dataset.v;
    if (String(sel.value) !== v) { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); sel.dispatchEvent(new Event("input", { bubbles: true })); }
    sync(); close(); btn.focus();
  };
  const open = () => {
    if (sel.disabled) return;
    pop.innerHTML = "";
    [...sel.options].forEach((o, i) => {
      const d = document.createElement("div");
      d.className = "ui-sel-opt" + (o.value === "" ? " none" : "");
      d.setAttribute("role", "option");
      d.dataset.v = o.value;
      d.textContent = (o.textContent || "").trim() || "(空)";
      if (o.value === String(sel.value)) d.setAttribute("aria-selected", "true");
      d.onmouseenter = () => { items().forEach((x) => x.classList.remove("hot")); d.classList.add("hot"); hot = i; };
      d.onclick = () => choose(i);
      pop.appendChild(d);
    });
 // 弹层朝向:视口下方放不下则朝上
    const r = btn.getBoundingClientRect();
    pop.classList.toggle("up", r.bottom + Math.min(pop.scrollHeight || 120, 240) + 8 > window.innerHeight && r.top > 260);
    pop.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    const cur = items().findIndex((x) => x.getAttribute("aria-selected") === "true");
    hot = cur >= 0 ? cur : 0;
    items().forEach((x, i) => x.classList.toggle("hot", i === hot));
    setTimeout(() => { document.addEventListener("mousedown", onDoc, true); document.addEventListener("keydown", onEsc, true); }, 0);
  };
  const move = (d) => {
    const its = items();
    if (!its.length) return;
    hot = d === 0 ? Math.max(0, hot) : (hot + d + its.length) % its.length;
    its.forEach((x, i) => x.classList.toggle("hot", i === hot));
    its[hot].scrollIntoView({ block: "nearest" });
  };
  btn.onclick = () => { if (pop.classList.contains("open")) close(); else open(); };
  btn.onkeydown = (e) => {
    if (!pop.classList.contains("open")) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); hot = 0; move(0); }
    else if (e.key === "End") { e.preventDefault(); hot = items().length - 1; move(0); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(hot); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") close();
  };
 // 原生侧变化(既有 JS sel.value=、spec selectOption)→ 镜像同步
  sel.addEventListener("change", sync);
  try { new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true }); } catch (e) { /* 忽略 */ }
  sync();
}
function beautifyAllSelects(root) {
  for (const s of (root || document).querySelectorAll("select")) beautifySelect(s);
}
// 动态注入的 select(dashTrackSel/bdeEdge* 等)自动接管
try {
  new MutationObserver(() => beautifyAllSelects(document)).observe(document.documentElement, { childList: true, subtree: true });
} catch (e) { /* 无 MutationObserver 环境忽略 */ }

// ---- toast+未读徽标(ZCode toast/unreadBadge 裁剪) ----
function toast(text, isErr) {
  const host = $("toastHost");
  const el = document.createElement("div");
 // n8 三档语气:true/err=红(失败)、"warn"=黄(成功但有前提/可能不生效)、缺省=常色(信息)。
 // 「轻提示」不能冒充失败:否则用户看到红色 toast 会以为会话模型没切成功。
  el.className = "toast" + (isErr === "warn" ? " warn" : isErr ? " err" : "");
 // 隐私:错误提示不回家路径(服务端原始错误统一脱敏)。
  el.textContent = isErr ? redactPaths(text) : text;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
// ---- 错误帧统一展示(Q6:code+message 上人话 + 「复制诊断」入口)----
// 文案单一出处=error-text.ts(errorText 表 + 未知码兜底「未知错误(<code>):<原文>」);
// 诊断摘要(code/message/sessionId/traceId)走 navigator.clipboard 最简实现,失败静默(不打断展示)。
function copyDiag(text) {
  try {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function () { toast("诊断已复制"); }, function () { /* 无剪贴板权限:静默 */ });
  } catch (e) { /* 静默:复制失败不影响错误可见 */ }
}
function errToast(m, prefix) {
  m = m || {};
  const sid = m.sessionId || currentSid || "";
  const trace = m.traceId || m.trace_id || "";
  const diag = errorDiagnostic(m.code, m.message, sid, trace);
  const text = (prefix ? prefix + ":" : "") + errorText(m.code, m.message);
  const host = $("toastHost");
  const el = document.createElement("div");
  el.className = "toast err";
  el.textContent = redactPaths(text);
  const btn = document.createElement("button");
  btn.className = "toast-copy";
  btn.textContent = "复制诊断";
  btn.title = diag;
  btn.onclick = function () { copyDiag(diag); };
  el.appendChild(btn);
  host.appendChild(el);
  setTimeout(function () { el.remove(); }, 8000);
  return text;
}
let unread = 0;
function bumpUnread(n) {
  unread = Math.max(0, unread + n);
  document.title = (unread > 0 ? "(" + unread + ") " : "") + "lampgenie-harness · 控制台";
}
// 任务终态通知的唯一定义在任务通知段(终态跃迁守卫 + 桌面原生通知);这里不再重复声明,
// 否则函数声明提升会让后一份覆盖前一份(修复的重复实现)。

// ---- composer 模型快切(ZCode ModelConfigSelect 裁剪;热生效 cfg.set) ----
// (ZCode 参考界面直接下拉移植):①主模型=web coding 执行模型(coding.llm,只列已配置模型)
// ②chat audio=语音轨模型(audio.chat:ASR 与 coding 未配置时的回退,独立 pill 置于右侧)③选择交互=锚点上方就地下拉,无居中弹窗。
function refreshModelPill() {
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" }));
}
// pill 就地下拉基建:分组列表+当前项勾选+筛选+底部管理入口;外点/Esc 关闭。
let pillMenuEl = null, modelMenuPending = null;
let modelListFailed = false; // u6:模型目录拉取失败态(触发器位置显示红色「模型加载失败,重试」)
let modelLabelKey = "";      // u2 上次已应用的触发器文案键(同值不重放滚动,避免每次重画都闪)
let modelDisplayText = "";   // 触发器最近一次「人读文案」(u6 toast「已从 X 切换至 Y」取切换前值)
let modelSwitchFrom = "";    // pillPickModel 记录的切换前显示值(仅成功回包后消费)
function pillMenuClose() {
  const had = !!pillMenuEl;
  const inside = had && pillMenuEl.contains(document.activeElement);
  if (pillMenuEl) { pillMenuEl.remove(); pillMenuEl = null; }
 // u6 焦点归还(zcode pickerFocus 语义):关闭时焦点还在菜单里(或掉到 body)→ 还给输入框
  if (had && (inside || document.activeElement === document.body)) { const inp = $("instruction"); if (inp) inp.focus(); }
}
document.addEventListener("mousedown", (e) => {
  if (!pillMenuEl) return;
  const t = e.target;
  if (pillMenuEl.contains(t)) return;
  if (t.closest && t.closest(".mode-pill,.model-trigger,.thought-btn")) return; // 锚点自身 click 走 toggle
  pillMenuClose();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") pillMenuClose(); });
// ---- popover 生命周期治理 ----
// 四态语义:①doc pointerdown 外点即关 ②触发器重复点击=toggle ③同族单实例(开新收旧) ④Esc 关。
// pillMenu 族(model/perm/effort/supCtx/supModel)已由上方 mousedown/Esc 兜住,不进本表;
// 本表收编静态载体浮窗(#taskMenu/#selMenu/#mentionMenu/#slashMenu)+ 动态浮层(ctxPill cx-menu)。
var POPOVER_KEYS = ["taskMenu", "selMenu", "mentionMenu", "slashMenu", "ctxPill"];
let popoverLive = {}; // key -> { close, keep, el } keep=CSS 选择器(触发器豁免,让触发器自己的 click 走 toggle)
function popoverClose(key, via) {
  const p = popoverLive[key];
  if (!p) return false;
  delete popoverLive[key];
  try { p.close(via); } catch (e) { /* 关闭失败不阻塞其它浮窗 */ }
  return true;
}
function popoverCloseAll(except) {
  for (const k of Object.keys(popoverLive)) if (k !== except) popoverClose(k, "supersede");
}
/** 剪枝:浮窗被自身关闭通道(项内 click/slashClose 等)收掉后,表里会留 stale 条目——不清会让
 * doc 级 Esc 一直 preventDefault(吞掉查找条等其它 Esc 消费者)。静态载体=display none 即 stale;
 * 动态浮层(带 el)=DOM 摘除即 stale。 */
function popoverPrune() {
  for (const k of Object.keys(popoverLive)) {
    const p = popoverLive[k];
    if (p.el && !p.el.isConnected) { delete popoverLive[k]; continue; }
    if (p.carrier && p.el && p.el.style.display === "none") { delete popoverLive[k]; continue; }
  }
}
/** 注册一个浮窗为「打开态」:close(via)=实际收起动作;keep=触发器选择器(外点豁免);
 * el=载体节点(静态 div 或动态浮层,用于剪枝);carrier=true 表示静态载体(close 只隐藏)。 */
function popoverOpen(key, close, keep, el, carrier) {
  if (POPOVER_KEYS.indexOf(key) < 0) return;
  popoverCloseAll(key); // 同类浮窗单实例:开新的收旧的(pill-menu 族由 pillMenuClose 负责,互不越界)
  popoverLive[key] = { close: close, keep: keep || "", el: el || null, carrier: !!carrier };
}
/** 静态载体(#taskMenu 等页面常驻 div)统一接入:show=true 登记(keep=触发器豁免选择器),false 注销。 */
function popoverSyncEl(key, show, keep) {
  const el = document.getElementById(key);
  if (!el) return;
  if (show) popoverOpen(key, function () { el.style.display = "none"; }, keep, el, true);
  else if (popoverLive[key]) popoverClose(key, "hide");
}
document.addEventListener("pointerdown", (e) => {
  popoverPrune();
  if (!Object.keys(popoverLive).length) return;
  const t = e.target;
  for (const k of Object.keys(popoverLive)) {
    const p = popoverLive[k];
    if (t && p.el && p.el.contains(t)) continue; // 点浮窗本体:不关(项内 click 自会走各自关闭)
    if (t && p.keep && t.closest && t.closest(p.keep)) continue; // 触发器自身:让 click 走 toggle
    popoverClose(k, "outside");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  popoverPrune();
  const ks = Object.keys(popoverLive);
  if (!ks.length) return;
  e.preventDefault(); // 浮窗在场时 Esc 只服务浮窗(不冒泡给查找条等其它 Esc 消费者)
  popoverClose(ks[ks.length - 1], "esc"); // 同帧多个浮窗(理论上不会):收最后开的
});
// ---- ask_user 问答条(许愿式编程) ----
let askPending = [];
function askRenderBar() {
  const bar = $("askBar");
  if (!bar) return;
  if (!askPending.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const q = askPending[0];
  bar.style.display = "block";
  const opts = Array.isArray(q.options) ? q.options : [];
  bar.innerHTML = '<div style="font-size:12px;color:var(--bronze);font-weight:700;margin-bottom:6px">agent 想确认一下</div>' +
    '<div style="font-size:12px;color:var(--text);margin-bottom:6px">' + esc(q.question) + "</div>" +
    (q.context ? '<div style="font-size:11px;color:var(--muted);white-space:pre-wrap;max-height:140px;overflow:auto;margin-bottom:8px">' + esc(q.context) + "</div>" : "") +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' +
    opts.map((o, i) => '<button class="ask-opt" data-i="' + i + '" style="background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:8px;font-size:11px;padding:4px 10px;cursor:pointer">' + esc(o) + "</button>").join("") +
    "</div>" +
    '<div style="display:flex;gap:6px"><input class="ask-in" placeholder="或直接输入你的决定…" style="flex:1;background:rgba(255,255,255,.04);border:1px solid var(--border-soft);color:var(--text);border-radius:8px;padding:5px 8px;font-size:11px"><button class="ask-send" style="background:transparent;border:1px solid var(--bronze);color:var(--bronze);border-radius:8px;font-size:11px;padding:4px 12px;cursor:pointer">答复</button></div>' +
    (askPending.length > 1 ? '<div style="font-size:10px;color:var(--faint);margin-top:6px">还有 ' + (askPending.length - 1) + " 个问题在排队</div>" : "");
  const send = (v) => {
    wsSafeSend(JSON.stringify({ v: 1, type: "ask.user.answer", requestId: q.requestId, answer: v }));
    askPending = askPending.filter((x) => x.requestId !== q.requestId);
    askRenderBar();
  };
  for (const b of bar.querySelectorAll(".ask-opt")) b.onclick = () => send(opts[Number(b.dataset.i)] || "");
  const inp = bar.querySelector(".ask-in");
  const sb = bar.querySelector(".ask-send");
  if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") { const v = inp.value.trim(); if (v) send(v); } };
  if (sb) sb.onclick = () => { const v = inp && inp.value.trim(); if (v) send(v); };
}
// fixG1:子代理→主代理 系统注入桥卡(重操作审批/问答提醒等)——独立消息级别,非用户气泡。
// 解析请求行([heavy-xxx] 子代理 worker 经 run_cmd 请求 [类别] 命令);零正则转义纪律。
function subagentBridgeHtml(text, time, q) {
  const NL = String.fromCharCode(10);
  const lines = text.split(NL);
  let reqs = [], title = "子代理 → 主代理";
  const ts = time ? '<span class="ev-time">' + new Date(time).toLocaleTimeString() + "</span>" : "";
  const plain = (raw, who) =>
    '<div class="sb-req">' + (who ? '<span class="sb-who">' + esc(who) + "</span>" : "") + '<span class="sb-cmd">' + hl(esc(String(raw).slice(0, 220)), q) + "</span></div>" +
    '<details class="sb-full"><summary>展开原文 · ' + String(raw).length + ' 字</summary><pre class="sb-pre">' + esc(String(raw).slice(0, 8000)) + "</pre></details>";
  try {
 // 结构化解析(动作/参数):解析不出=act/args 空,退化为纯摘要 + 原文展开,绝不抛错。
    const cut80 = (s) => { const v = String(s || "").trim(); return v.length > 80 ? v.slice(0, 80) + "…" : v; };
    const stopAt = (s, stops) => {
      let end = s.length;
      for (const st of stops) { const p = s.indexOf(st); if (p >= 0 && p < end) end = p; }
      return s.slice(0, end);
    };
    const parseReq = (raw) => {
      const one = { act: "", args: [] };
      const lb = raw.indexOf("[");
      const rb = lb >= 0 ? raw.indexOf("]", lb) : -1;
      const brk = rb > lb ? raw.slice(lb + 1, rb) : "";
      const idLike = brk && brk.indexOf("子代理") < 0 && brk.indexOf("重操作") < 0;
 // 动作:「经 X 请求执行」取 X(工具名);否则提示里点名的工具;否则方括号类别
      const via = raw.indexOf("经 ");
      if (via >= 0) {
        const rest = raw.slice(via + 2);
        const sp = rest.indexOf(" ");
        const tool = (sp > 0 ? rest.slice(0, sp) : rest).trim();
        if (tool && tool.indexOf("[") < 0) one.act = tool;
      }
      if (!one.act && raw.indexOf("answer_subagent") >= 0) one.act = "answer_subagent";
      if (!one.act && raw.indexOf("ask_user") >= 0) one.act = "ask_user";
      if (!one.act) {
        const ci = raw.indexOf("请求执行 [");
        if (ci >= 0) { const s0 = ci + 6; const e0 = raw.indexOf("]", s0); if (e0 > s0) one.act = raw.slice(s0, e0); }
      }
      if (!one.act && idLike) one.act = cut80(brk);
      const add = (k, v) => { const val = cut80(v); if (k && val) one.args.push({ k: k, v: val }); };
      if (idLike) add("申请", brk);
      const catI = raw.indexOf("请求执行 [");
      if (catI >= 0) { const s1 = catI + 6; const e1 = raw.indexOf("]", s1); if (e1 > s1) add("类别", raw.slice(s1, e1)); }
      const c1 = raw.indexOf(BT);
      const c2 = c1 >= 0 ? raw.indexOf(BT, c1 + 1) : -1;
      if (c2 > c1) add("命令", raw.slice(c1 + 1, c2));
      const tk = raw.indexOf("task=");
      if (tk >= 0) add("任务", stopAt(raw.slice(tk + 5), [")", ";", " "]));
      const pd = raw.indexOf("判重:");
      if (pd >= 0) add("判重", stopAt(raw.slice(pd + 3), [")"]));
      const nt = raw.indexOf("补充:");
      if (nt >= 0) add("补充", raw.slice(nt + 3));
      one.args = one.args.slice(0, 4); // 参数最多 4 个键
      return one;
    };
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
 // 请求行判据:方括号在行首/序号之后,且行内含「子代理/请求/申请 id」——提示语行
 // (「有 N 个待决申请…立即用 answer_subagent 应答」)不算请求,只用来定标题。
      const lb = t.indexOf("[");
      const bracketHead = t.startsWith("[") || (lb > 0 && lb <= 4 && t.indexOf("]", lb) > lb);
      const isReq = bracketHead && (t.indexOf("子代理") >= 0 || t.indexOf("请求") >= 0 || t.indexOf("heavy-") >= 0);
      if (isReq) {
        const who = t.indexOf("子代理 ") >= 0 ? t.slice(t.indexOf("子代理 ") + 4, t.indexOf("经 ") > 0 ? t.indexOf("经 ") : 40) : "";
        const parsed = parseReq(t);
        reqs.push({ raw: t, who: String(who || "子代理").slice(0, 24), act: parsed.act, args: parsed.args });
      } else if (t.indexOf("审批") >= 0) title = "子代理请求 · 重操作审批";
      else if (t.indexOf("问答") >= 0) title = "子代理请求 · 问答";
    }
    const renderOne = (r) => {
      const actH = r.act ? '<span class="sb-act">' + esc(r.act) + "</span>" : "";
      const argsH = r.args && r.args.length
        ? '<div class="sb-args">' + r.args.map((a) => "<span><span class='sb-k'>" + esc(a.k) + "</span>:" + esc(a.v) + "</span>").join("") + "</div>"
        : "";
      return '<div class="sb-reqw"><div class="sb-req"><span class="sb-who">' + esc(r.who) + "</span>" + actH +
        '<span class="sb-cmd">' + hl(esc(r.raw.slice(0, 220)), q) + "</span></div>" + argsH +
        '<details class="sb-full"><summary>展开原文 · ' + Number(r.raw.length) + ' 字</summary><pre class="sb-pre">' + esc(r.raw.slice(0, 8000)) + "</pre></details></div>";
    };
    return '<div class="sub-bridge" title="系统注入给主代理的协调消息(非用户输入);主代理的应答见下方应答工具卡">' +
      '<div class="sb-head">' + ic("sub") + " " + esc(title) + " " + ts + '<span class="sb-hint">主代理应答在下方</span></div>' +
      (reqs.length ? reqs.map(renderOne).join("") : plain(text.slice(0, 300))) + "</div>";
  } catch (e) {
 // 结构化失败 → 原渲染形态(摘要行 + 原文展开),不抛错
    return '<div class="sub-bridge" title="系统注入给主代理的协调消息(非用户输入);主代理的应答见下方应答工具卡">' +
      '<div class="sb-head">' + ic("sub") + " " + esc(title) + " " + ts + '<span class="sb-hint">主代理应答在下方</span></div>' +
      plain(text, "") + "</div>";
  }
}
/** 通用就地下拉(权限模式/档位/附件共用):与模型菜单同一套 .pill-menu/.pm-* 骨架(zcode 视觉)。
 * u4 结构对齐:项=.pm-main 包名字 + 右侧绝对定位勾;u5 定位=向上展开 side=top/align=start。 */
function pillMenuOpen(anchor, groups, current, onPick, footLabel, footGo) {
  pillMenuClose();
  const el = document.createElement("div");
  el.className = "pill-menu pill-menu-simple auto-w";
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  let html = total > 12 ? '<input class="pm-q" placeholder="筛选模型…">' : "";
  html += groups.map((g) =>
    '<div class="pm-grp">' + (g.title ? '<div class="pm-head">' + esc(g.title) + "</div>" : "") +
    g.items.map((it) =>
      '<div class="pm-item' + (it.value === current ? " cur" : "") + '" data-v="' + esc(it.value) + '" tabindex="-1">' +
      '<span class="pm-main"><span class="pm-name">' + esc(it.value) + "</span>" +
      (it.sub ? '<span class="pm-sub">' + esc(it.sub) + "</span>" : "") + "</span>" +
      (it.value === current ? '<span class="pm-ck">' + ic("check") + "</span>" : "") + "</div>").join("") + "</div>").join("");
  if (footLabel) html += '<div class="pm-foot"><div class="pm-item" data-act="foot" tabindex="-1"><span class="pm-main"><span class="pm-name">' + esc(footLabel) + "</span></span></div></div>";
  el.innerHTML = html;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.bottom = Math.max(8, window.innerHeight - r.top + 2) + "px"; // 向上展开(锚点上方,sideOffset=2)
  if (el.offsetHeight > window.innerHeight - 80) el.style.maxHeight = Math.max(160, window.innerHeight - 100) + "px";
  const q = el.querySelector(".pm-q");
  if (q) {
    q.oninput = () => {
      const s = q.value.trim().toLowerCase();
      for (const grp of el.querySelectorAll(".pm-grp")) {
        let any = false;
        for (const it of grp.querySelectorAll(".pm-item")) {
          const hit = !s || String(it.dataset.v).toLowerCase().includes(s);
          it.style.display = hit ? "" : "none";
          if (hit) any = true;
        }
        grp.classList.toggle("off", !any);
      }
    };
    setTimeout(() => q.focus(), 30);
  }
  const pick = (it) => {
    if (it.dataset.act === "foot") { pillMenuClose(); if (footGo) footGo(); return; }
    pillMenuClose(); onPick(it.dataset.v);
  };
  for (const it of el.querySelectorAll(".pm-item")) {
    it.onclick = () => pick(it);
    it.onmouseenter = () => modelMenuHighlight(el, it);
  }
  modelMenuHighlight(el, el.querySelector(".pm-item.cur") || modelMenuVisibleItems(el)[0] || null);
 // u6 同一套键盘语义(↑↓/Home/End/Enter/Space/Esc + typeahead)
  el.onkeydown = (e) => {
    const items = modelMenuVisibleItems(el);
    const at = items.indexOf(el.querySelector(".pm-item.hot"));
    const move = (n) => { if (items.length) modelMenuHighlight(el, items[(n + items.length) % items.length]); };
    if (e.key === "ArrowDown") { e.preventDefault(); move(at < 0 ? 0 : at + 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(at < 0 ? items.length - 1 : at - 1); return; }
    if (e.key === "Home") { e.preventDefault(); move(0); return; }
    if (e.key === "End") { e.preventDefault(); move(items.length - 1); return; }
    if (e.key === "Escape") { e.preventDefault(); pillMenuClose(); return; }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      const hot = el.querySelector(".pm-item.hot");
      if (hot) pick(hot);
      return;
    }
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      const startAt = at < 0 ? 0 : at + 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[(startAt + i) % items.length];
        const nm = it.querySelector(".pm-name");
        const txt = (nm ? nm.textContent : "").trim().toLowerCase();
        if (txt && txt.indexOf(ch) === 0) { e.preventDefault(); modelMenuHighlight(el, it); return; }
      }
    }
  };
  if (!q) { el.tabIndex = -1; setTimeout(() => { try { el.focus(); } catch (e) { /* 忽略 */ } }, 30); }
  pillMenuEl = el;
}
`;
