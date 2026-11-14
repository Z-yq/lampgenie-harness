/**
 * 面板主脚本分片:script-views(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_VIEWS = `function openSession(sid) {
 // fixT6 P1:切会话前先把当前输入框内容落到「旧会话」的草稿键(此时 currentSid 仍是旧值),
 // 否则切走时未 saveDraft 的输入直接丢;随后 restoreDraft 会按新 sid 读回目标会话自己的草稿。
  saveDraft();
  currentSid = sid; sessionStorage.setItem("zh:sid", sid); localStorage.setItem("zh:sid", sid);
  navPush(sid);
  resetSessionDomainUI(sid); // 会话域 UI 归零(与 newDraft 共用同一份清单):切会话→全量重载;null=加载中,先清旧内容再等重放( histEvents=null 此前被并进注释从未执行——切会话闪旧会话内容);同清该会话水位→首帧全量(旧水位+服务端另一份累积态会对不上)
 // batch1b 重试态跨会话保活:切会话**不清** apiRetryBySid,并立刻用缓存把重试条画回来
 // (上面刚清空了置顶条,resetSessionDomainUI 内已按 apiRetryBySid 缓存把重试条画回来)
  subWsRestore(sid); // 子代理工作区 tab 按会话恢复(localStorage 打开集;内容等 journal 重放),激活态归位主会话
  switchView("chat"); // 复刻 onNavigateToTask → setWorkspaceMainView("chat")
  renderHistory(); // 立即清旧会话内容,避免重放到达前闪上一个会话
  histLanding = Date.now() + 1200; // 打开会话:1.2s 落底宽窗(自动显示最后的消息
  refreshHist();
  renderSidebar();
  restoreDraft();
  voiceStashApply(); // 语音任务书:切回会话时把暂存的撰写结果填入输入框
  renderSendBtn();
 // 已终态任务补拉变更条数据(历史会话打开即有 diffstat)。
  for (const t of tasks.values()) if (t.sessionId === sid && (t.state === "done" || t.state === "failed") && !diffstats.has(t.id)) wsSafeSend(JSON.stringify({ v: 1, type: "task.diffstat", taskId: t.id }));
 // 容量分母(contextWindow)开会话即拉:ctxPill 的 % 不必等任务终态。
  wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: sid }));
  ssSendStatus(sid); // batch1b:开会话即拉一次会话状态投影,顺带从服务端重试态镜像刷新重试条(权威值;切会话不清缓存)。
 // 统一走 ssSendStatus——openSession 上面刚清 ssSeqBySid 水位 → 此处不带 sinceSeq,首拉全量。
 // per-session 主模型:目标会话未初始化(Map 无条目=undefined)→发 session.model.get 拉取覆盖;
 // 已初始化(含 null=服务端确认无覆盖)→不重发,直接用缓存刷 pill(回包 session.model.result 再校正)。
  if (sessionModelOverride.has(sid)) renderModelPill(cfgView);
  else wsSafeSend(JSON.stringify({ v: 1, type: "session.model.get", sessionId: sid }));
 // 跨会话板上下文清零已在 resetSessionDomainUI 内统一做(批注串台修复,不依赖浮窗开关)
  if (bfOpen) { boardRefresh(); renderBoard(); renderBoardPanel(); }
 // n6 画布看板跟随当前选中会话:统一出口(所有卡片按各自 session 维度重取数;
 // 此前画布卡只有首次激活拉一次数,切 session 后白板/档案/追踪全停在上一会话的数据上——用户用户反馈)。
  onSessionChange(sid);
}
/** n6 画布激活门(会话维度):键=sid|card(见 cvActKey),切会话后同一个 view 会按新 sid 重新激活。
 * 前是 Set<view> 一次性门 → 切 session 后白板/档案/追踪卡全停在上一会话数据(用户用户反馈)。
 * 声明位置前移到本段:openSession(含启动恢复)会经 onSessionChange 读写它,必须在脚本头部区已初始化(防 TDZ)。 */
const cvActivated = new Set();
// 画布数据新鲜度:看板卡不在视口时收到的 board.changed 不能白丢——记脏标,卡滚回视口时补拉一次。
let bdViewDirty = false;
let bdViewDirtyAt = 0;
// board.doc 落地水位:兜底通道(dashboard.changed)据此跳过刚到过的新鲜数据,免得同一条板每秒读盘+整板重画。
let bdDocAt = 0;
/** n6 当前画布绑定的会话(与 currentSid 同步推进;onSessionChange 维护)。 */
let cvSessionSid = "";
/** n6 选中会话变更统一出口(openSession 内调用;newDraft 草稿态也走)。
 * 职责:①让画布每张「已激活过的卡」按新 sid 重取数(cvActivated 键=sid|card,一次性门按会话维度);
 * ②登记 session→project 归属查询(session.owner.get,项目归属由服务端裁定,前端只按契约收发);
 * ③不新造 session 级 WS——全部复用既有消息(track.view/board.list/profile.get/usage.view 等)。 */
/** 会话维度视图清单(唯一真相源):这些卡的数据/状态都必须跟着选中会话走。
 * 全局设施(nodes/approvals/market/git/files/term/wf/exp/team/issues)不在此列——它们无 session 维度,
 * 卡头以 vw-scope 标注「作用域:全局」,避免用户误以为是当前会话的数据。 */
const SESSION_VIEWS = ["board", "track", "usage", "subchat"];
function onSessionChange(sid) {
  const next = String(sid || "");
  cvSessionSid = next;
  arcOwnerPending = false;
 // 代码档案 Atlas:切会话即问归属项目(通道由服务端另一路实现;回包 session.owner.result 前先暂存 pending)
  if (next) wsSafeSend(JSON.stringify({ v: 1, type: "session.owner.get", sessionId: next }));
 // 「曾经激活过的卡」= 任意会话键里出现过的 view(cvActivated 键形态 sid|view)。
  const everViews = new Set();
  for (const key of cvActivated) { const cut = String(key).lastIndexOf("|"); if (cut > 0) everViews.add(String(key).slice(cut + 1)); }
 // 会话维度视图无条件全部重载,
 // 不再只认「曾经激活过的卡」——旧实现里经典布局首进会话/openSession 之外的建会话路径(新任务提交)
 // 一张卡都不重载,板/追踪/吞吐/子代理流停在上一个会话的快照。
  for (const v of SESSION_VIEWS) everViews.add(v);
 // 全部按新会话重载:经典布局下这些卡不可见时也重载(画布切回来是热的);
 // loadViewData 内部按视图存在性守卫,不会炸。已按新会话激活过=幂等跳过。
  for (const view of everViews) {
    const key = cvActKey(next, view);
 // 画布新鲜度:白板目录按会话分片(board-store 的 boardDir(root,sid)),切会话必须重取——
 // 旧口径「曾激活过就跳过」会把上次离开该会话时的快照当成本会话数据(用户用户反馈「切 session 板不换」)。
    if (view === "board") bdViewDirty = false;
    if (cvActivated.has(key) && view !== "board") continue;
    cvActivated.add(key);
    try { loadViewData(view, next); } catch (e) { console.warn("[canvas] 切会话后重载失败", view, e); }
  }
 // 子agent会话流卡头状态点(未读/运行中/失败)按新会话重算
  try { subCardStatus(); } catch (e) { /* 状态点同步失败不影响切会话 */ }
  try { scopeBarRender(next); } catch (e) { /* 作用域条刷新失败不影响切会话 */ }
 // 看板会话档:数据是「全部」取回来的,切会话后重渲一次即按新 sid 过滤(项目档不受影响)
  try { if (viewLive("dash")) dashRender(); } catch (e) { /* 看板未加载/不可见时跳过 */ }
}
/** 卡头作用域条:把「当前会话」从静态文字变成带会话短码的动态标注,
 * 让人一眼确认这张卡的数据属于哪个会话(全局设施保持「作用域:全局」不动)。 */
function scopeBarRender(sid) {
  const s = String(sid === undefined ? currentSid : sid || "");
  const tag = s ? "作用域:当前会话 · " + s.slice(-8) : "作用域:当前会话(未选中会话=空)";
  for (const id of ["scopeBoard", "scopeTrack", "scopeUsage", "scopeSubchat"]) {
    const el = $(id);
    if (el) el.textContent = id === "scopeUsage" ? tag + "(前端过滤)" : tag;
  }
}
let panelRefreshAt = 0;
let panelRefreshTimer = 0;
/** 画布新鲜度:任务帧触发的会话维度面板刷新(1s 节流 + 尾沿补拉,复用既有刷新函数)。 */
function panelRefreshSoon(sid) {
  const s = String(sid || "");
  if (!s) return;
  const run = () => { panelRefreshAt = Date.now(); try { refreshPanelsAfterSubmit(s); } catch (e) { console.warn("[panel] 任务帧后刷新失败", e); } };
  const gap = Date.now() - panelRefreshAt;
  if (gap > 1000) { run(); return; }
  clearTimeout(panelRefreshTimer);
  panelRefreshTimer = setTimeout(run, 1001 - gap);
}
/** 新任务提交后统一刷新。
 * 与 onSessionChange 的分工:本函数不重问归属项目、不重算导航态,只做「数据重取 + 会话流重放」;
 * 会话身份从无到有(草稿首条建 sid)才额外走 onSessionChange 打灰激活门。 */
function refreshPanelsAfterSubmit(sid) {
  const s = String(sid || "");
  panelRefreshAt = Date.now(); // :本地提交同样起算节流窗,避免紧随其后的 task.submitted 立刻重复刷新
  if (!s) return;
 // 会话流:新 turn 已落 journal,立即重放(草稿态乐观占位由 finishSubmit 负责,这里补真实事件)
 // 只在「当前正看着这条会话」时重放——refreshHist 读 currentSid,跨会话提交时不该抢当前视图的历史。
  if (s === String(currentSid || "")) { try { refreshHist(); } catch (e) { console.warn("[panel] 提交后会话流刷新失败", e); } }
 // 会话维度视图逐张重取数;先清该会话的激活门,保证 loadViewData 真的跑一趟
  for (const v of SESSION_VIEWS) {
    cvActivated.delete(cvActKey(s, v));
    try { loadViewData(v, s); } catch (e) { console.warn("[panel] 提交后视图刷新失败", v, e); }
  }
 // 侧栏任务列表/看板会话卡:新任务改变了任务清单,重新拉一次
  try { renderSidebar(); } catch (e) { /* 侧栏刷新失败不影响提交流程 */ }
  if (viewLive("dash")) { try { dashLoad(); } catch (e) { /* 看板拉取失败下个周期自愈 */ } }
  try { subCardStatus(); } catch (e) { /* 状态点失败不阻塞 */ }
}
/** cvActivated 键:会话维度的一次性激活门(sid|card)。空会话=草稿态统一记 "_"。 */
function cvActKey(sid, card) { return (sid || "_") + "|" + card; }
// ---- 无限画布外壳(界面改为无限画布,模块=画布上的卡片,最左侧快速定位) ----
// 分层:switchView(路由入口)→ ①switchViewActivate(视图自身的激活/拉数逻辑,零改写)
// ②画布形态下=聚焦对应卡片(assets/canvas-shell.js);经典布局下什么都不多做。
// 卡片→视图 映射(唯一真相源, 收敛):CARD_OF_VIEW / 经典显隐清单 / 画布激活
// 三处全部由它派生。此前五份清单各自硬编码,新增 subagents/track/usage 后漏了三处,导致
// 「画布切经典全屏黑」「回画布丢焦点」——新增卡片只改这一处。
const CV_VIEW_OF_CARD = { chat: "chat", term: "term", git: "git", files: "files", ide: "ide", board: "board", project: "project", sense: "sense", wf: "wf", exp: "exp", team: "team", nodes: "nodes", approvals: "approvals", market: "market", browser: "browser", sys: "sys", subagents: "subagents", subchat: "subchat", track: "track", traj: "traj", usage: "usage", super: "super" };
// 视图→卡片映射(team 卡承载 team/dash/issues 三个子标签,共用一块卡片面板)。
const CARD_OF_VIEW = (() => {
  const m = {};
  for (const card of Object.keys(CV_VIEW_OF_CARD)) m[CV_VIEW_OF_CARD[card]] = card;
  m.tasks = "chat"; m.dash = "team"; m.issues = "team"; m.pipeline = "project"; m.rsi = "super"; // 子标签/别名( RSI-PLACE:RSI 看板=指挥台卡第二子标签;看板/Issue=team 卡)
 // n3 看板融合别名:旧布局存档/旧书签/旧键盘路径仍可能送来「分身 Agents」卡名(subagents / agents),
 // 一律回退到子agent会话流(该卡的注册态/模型/reap 能力已并入)——不白屏、不空视图。
  m.subagents = "subchat"; m.agents = "subchat";
  return m;
})();
/** n3 卡片别名(旧卡名 → 现存卡名):卡片在 CV_CARDS 里已删,旧 localStorage 布局里仍会有这些键。 */
const CV_CARD_ALIAS = { subagents: "subchat", agents: "subchat" };
/** 卡名规范化:别名回退;未知卡名原样返回(由调用方判定)。 */
function cvCardName(card) { return CV_CARD_ALIAS[card] || card; }
/** 经典布局单屏显隐的视图清单:由 CV_VIEW_OF_CARD 派生。
 * chat 没有 #view-chat(宿主是 #view-tasks),故剔除 chat 换 tasks;team 的看板子标签 #view-dash 补入。
 * applyViewChrome 只认这里——漏项的表现就是「经典布局下整屏黑」。 */
const CLASSIC_VIEWS = (() => {
  const s = new Set(Object.values(CV_VIEW_OF_CARD));
  s.delete("chat"); s.add("tasks"); s.add("dash");
  return [...s];
})();
function canvasActive() {
  try { return !!(window.CanvasShell && window.CanvasShell.isCanvas && window.CanvasShell.isCanvas()); } catch (e) { return false; }
}
/** 画布快捷键执行器:画布形态下交给画布;画布不可用或调用抛错时回落经典实现(fallback 可为 null=什么都不做)。
 * 失败留 warn 不静默——画布资产 404/旧缓存是这条路径的常见故障,静默会让「按键没反应」无从排查。 */
function cvKeyCall(fn, fallback) {
  if (canvasActive()) {
    try { fn(); return; } catch (err) { console.warn("[canvas] 快捷键执行失败,回落经典实现", err); }
  }
  if (fallback) fallback();
}
/** 连接状态下沉(二期):画布形态下顶栏 header 隐藏,定位栏顶部圆点是唯一常驻连接指示。
 * 经典布局仍由 header 的 #conn 文本负责(此函数在经典形态下什么都不做)。 */
function cvConn(ok, text) {
  if (!canvasActive()) return;
 // 双导航融合:cvRail 退役,连接点下沉到托盘品牌点(经典布局仍走 header pill-conn)。
  const sb = $("sidebar");
  if (!sb) return;
  sb.classList.toggle("cv-conn-ok", ok === true);
  sb.classList.toggle("cv-conn-bad", ok === false);
  const dot = sb.querySelector(".brand-dot");
  if (dot) dot.title = String(text || "连接中…");
}
/** 画布卡片 → 托盘按钮映射(双导航融合):托盘 act-* 按钮承担画布卡的定位/唤回/状态点。
 * 代码档案(project)与透镜(sense)共用 act-sense 入口;chat/term/files/sys 无托盘按钮;
 * 浏览器有 act-web(2026-11 人机随时可用轮:左栏「网页 Webview」恢复,托盘随之一致)。 */
const CV_TRAY_ACT = { git: "act-git", board: "act-board", team: "act-team", nodes: "act-nodes", approvals: "act-approvals",
  wf: "act-wf", exp: "act-exp", market: "act-market", subchat: "act-subchat", track: "act-track", traj: "act-traj", usage: "act-usage",
  project: "act-sense", sense: "act-sense", browser: "act-web", super: "act-super", rsi: "act-rsi" };
/** 卡片状态点同步(二期「红框条目与看板绑定」的可视化部分):
 * 把面板手里的真实状态(待审批数/Git 变更数/跑着的任务数)推到卡片头 + 托盘按钮状态点。
 * 只推有真源的项,不猜——没数据就不亮灯(宁缺勿假)。画布形态外是空操作。 */
function cvCardStatus(name, tone, text) {
  if (!canvasActive()) return;
  try { window.CanvasShell.setCardStatus(name, tone, text || ""); }
  catch (e) { console.warn("[canvas] 卡片状态同步失败", name, e); }
  const btn = CV_TRAY_ACT[name] ? $(CV_TRAY_ACT[name]) : null;
  if (btn) {
    btn.classList.toggle("cv-bad", tone === "fail" || tone === "warn");
    btn.classList.toggle("cv-warn", tone === "warn");
    if (text) btn.title = String(text);
  }
}
/** 托盘按钮灰态同步(双导航融合):画布卡片隐藏集合变化(cv-cards 事件,canvas-shell 派发)
 * → 对应托盘按钮置灰;点击灰按钮走 switchView 分流=唤回+聚焦。经典布局无画布卡,恒为空操作。 */
window.addEventListener("cv-cards", function (e) {
  const hidden = (e && e.detail && e.detail.hidden) || [];
  for (const card of Object.keys(CV_TRAY_ACT)) {
    const btn = $(CV_TRAY_ACT[card]);
    if (btn) btn.classList.toggle("cv-card-off", hidden.indexOf(card) >= 0);
  }
});
// 托盘自带最小化钮(双导航融合:cvRail 退役后托盘收起不再依赖外部入口;
// 收起形态=既有 #sbRail 细条,唤回=细轨 logo / Ctrl+B,与经典布局同源)。
(() => {
  const sb = $("sidebar");
  if (!sb) return;
  const btn = document.createElement("button");
  btn.className = "cv-tray-min";
  btn.title = "收起托盘为细条(Ctrl+B 或左缘细轨 logo 展开)";
  btn.textContent = "«";
  btn.onclick = () => toggleSidebar();
  sb.appendChild(btn);
})();
function cvStatusRefresh() {
  if (!canvasActive()) return;
 // 审批:挂起队列长度(数据源 permission.pending.result → approvalQueue)
  const ap = approvalQueue ? approvalQueue.size : 0;
  cvCardStatus("approvals", ap > 0 ? "warn" : "", ap > 0 ? ap + " 条待审批" : "");
 // Git:工作区变更文件数(数据源 git.status → gitChanges)
  const gc = Array.isArray(gitChanges) ? gitChanges.length : 0;
  cvCardStatus("git", gc > 0 ? "warn" : "", gc > 0 ? gc + " 个文件有变更" : "");
 // 对话:本会话运行中的任务数(数据源)
  let run = 0;
  try { for (const t of tasks.values()) if (t.state === "running") run++; } catch (e) { run = 0; }
  cvCardStatus("chat", run > 0 ? "run" : "", run > 0 ? run + " 个任务运行中" : "");
}
/** 视图此刻是否「活着」:经典=当前聚焦视图;画布=卡片未隐藏且未被离屏剔除。
 * 数据刷新类守卫(WS 回包是否要重渲)统一走它,替代裸 dataset.view 比较——
 * 画布形态下多张卡片同时可见,只认 dataset.view 会让除焦点卡外的可见卡不再刷新。
 * 例外:team 卡的子标签(dash 看板 / issues)共用一块卡片面板、同时只显示一个子面板,
 * 故这类子标签除「卡片在视口内」还要求它就是当前激活的子标签。 */
const CANVAS_SUBTAB = { dash: "team", issues: "team", rsi: "super" }; // 看板/Issue=team 卡子标签;RSI 看板=指挥台卡子标签( RSI-PLACE,画布态需按身份判定活跃)
/* ── 双中心布局状态机:会话流(chat)+IDE 右栏并列 ──
 * 状态源:localStorage dualCenter.open(开合)+ dualCenter.w(会话流宽 px,夹紧 360~视口-280)。
 * open=true 时 body.dual-center 类挂上,applyViewChrome 里 ide 与 chat 同 .on 常驻;.view CSS 零改动。
 * ≤1150px 视口禁用双栏(媒体查询把右栏 display:none,JS 侧 dualAllowed 同口径兜底)。 */
const DUAL_LS_OPEN = "dualCenter.open", DUAL_LS_W = "dualCenter.w", DUAL_CHAT_MIN = 360, DUAL_IDE_MIN = 280;
let dualOpen = false;
function dualAllowed() { return window.innerWidth > 1150; } // 与 CSS @media(max-width:1150px) 同口径
function dualReadLS(k, dflt) { try { const v = localStorage.getItem(k); return v == null ? dflt : v; } catch (e) { return dflt; } }
function dualWriteLS(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式:忽略 */ } }
/** 双栏开合唯一入口:改 body 类 + 刷新/挂 IDE 数据 + 状态栏提示;open=false 完全回到经典互斥。 */
function dualToggle(open) {
  const next = open === undefined ? !dualOpen : !!open;
  if (next && !dualAllowed()) { ideStatus("视口过窄(≤1150px),双中心不可用"); return; }
  dualOpen = next && dualAllowed();
  document.body.classList.toggle("dual-center", dualOpen);
  dualWriteLS(DUAL_LS_OPEN, dualOpen ? "1" : "0");
 // .on 由 applyViewChrome 统一裁决:必须重跑一次,否则右栏拿到 dual-center 类仍是 display:none
  applyViewChrome(mainView === "ide" && !dualOpen ? "chat" : (document.body.dataset.view || mainView || "chat"));
  if (dualOpen) {
    const w = Number(dualReadLS(DUAL_LS_W, "")) || 0;
    if (w >= DUAL_CHAT_MIN) document.documentElement.style.setProperty("--dual-chatw", Math.min(w, window.innerWidth - DUAL_IDE_MIN) + "px");
 // 数据补位与 Monaco 重排必须推迟到下一拍:本函数也会在解析期(刷新还原 IIFE)被调用,
 // 那时 IDE 域后续模块的 const 还没初始化,同步调用会抛 TDZ 并中断整个 IIFE(按钮/拖拽全部丢失)。
    setTimeout(() => {
      try { loadViewData("ide"); ideScmRefresh(); } catch (e) { console.warn("[dual] 右栏数据补位失败", e); }
      ideLayoutKick();
    }, 0);
  }
}
function viewLive(n) {
  if (canvasActive()) {
    try {
      if (window.CanvasShell.inView(CARD_OF_VIEW[n] || n) === true) {
        return CANVAS_SUBTAB[n] ? document.body.dataset.view === n : true;
      }
      return false;
    } catch (e) { /* 落到经典判定 */ }
  }
 // 双中心:双栏开启时右栏 IDE 与当前视图两侧都算「活着」,
 // 否则焦点在会话流时 SCM/问题/诊断的 WS 回包会被判死静默停更(症状=Git 状态永远不动)。
  if (dualOpen && document.body.classList.contains("dual-center") && n === "ide") return true;
  return document.body.dataset.view === n;
}
// 复刻 ZCode workspaceMainView 切换: 点已在位的导航按钮=停留(不弹回);active 态挂在对应按钮
// switchView("dash")=团队视图「看板」子标签的内部路由(view-team 点亮+成员面板收起)。
function switchView(name) {
 // 双中心:双栏开启时切到 ide = 开/收右栏,不动视图身份(会话流仍是当前视图);
 // 双栏收起时点 IDE 走经典互斥全屏。ideOpen 仍直连此入口,无需单独改。
  if (name === "ide" && dualOpen) { dualToggle(); return; }
 // super 族(指挥台/RSI/做梦/任务)画布态**不再退经典**——改为聚焦 super 卡并整卡缩放入画。
 // 曾一律退经典(当时卡不聚焦会留在视口外 x=5736、1fr 只剩 182px);现在 focus({zoom:true})
 // 走 fitInArea(下限 0.7,另有 LOD 出槛兜底),1400px 卡在 ~1070px 安全区也能整卡可读,且 // 「重点画布模式」要 Super 常驻画布。经典模式此分支天然跳过(行为不变)。
  switchViewActivate(name);
  if (!canvasActive()) return;
  const card = CARD_OF_VIEW[name] || name;
  if (!card) return;
  try {
    window.CanvasShell.showCard(card);
    window.CanvasShell.focus(card, { keepView: true, ...(card === "super" ? { zoom: true } : {}) });
  }
  catch (e) { console.warn("[canvas] 卡片聚焦失败", card, e); }
}
/** 导航态同步(视图名/侧栏点亮/语音键显隐):switchViewActivate 与画布焦点同步共用,避免两处漂移。 */
function lightNav(name) {
  $("viewName").textContent = VIEW_NAMES[name] || (name === "git" ? "Git" : "");
  $("act-sense").classList.toggle("on", name === "sense" || name === "project");
  $("act-git").classList.toggle("on", name === "git");
  $("act-board").classList.toggle("on", name === "board");
  $("act-wf").classList.toggle("on", name === "wf");
  $("act-exp").classList.toggle("on", name === "exp");
 // 终端/文件左栏按钮已撤:无按钮可点亮,视图仍可由快捷键/右键菜单进入,故不加守卫也不会 null 抛错——此处仅保留其余点亮
  $("act-web").classList.toggle("on", name === "browser"); // 2026-11 浏览器入口恢复:进视图即点亮
  $("act-market").classList.toggle("on", name === "market");
  $("act-team").classList.toggle("on", name === "team" || name === "dash" || name === "issues"); // 看板/Issue 看板=团队子标签,侧栏点亮团队
  $("act-nodes").classList.toggle("on", name === "nodes");
  $("act-approvals").classList.toggle("on", name === "approvals");
  $("act-track").classList.toggle("on", name === "track");
  $("act-traj").classList.toggle("on", name === "traj"); // 轨迹独立视图入口点亮
  $("act-super").classList.toggle("on", name === "super" || name === "rsi"); // /RSI-PLACE:指挥台与 RSI 看板同视图,入口同亮
  $("act-rsi").classList.toggle("on", name === "rsi"); // RSI-PLACE:RSI 看板子标签独立点亮
  $("uGear").classList.toggle("on", name === "sys");
}
function switchViewActivate(name) {
  setViewIdentity(name);
  applyViewChrome(name);
  loadViewData(name);
}
/** 视图身份切换(「当前在看哪个视图」):经典布局靠它决定哪一屏可见,也是「切回经典显示哪页」的依据。
 * 画布形态下只有焦点卡变化才改身份;卡片仅因进入视口而懒激活时不得改身份——
 * 否则身份会被改成最后进视口的那张(经验证:焦点在代码档案,切经典却回到文件视图)。 */
function setViewIdentity(name) {
  mainView = name;
  try { sessionStorage.setItem("zh:view", name); localStorage.setItem("zh:view", name); } catch (e) { /* 隐私模式:忽略 */ }
  document.body.dataset.view = name;
  lightNav(name); // 视图名/侧栏点亮/语音键——身份切换的唯一出口,防多处漂移
}
/* ── RSI 运行看板( RSI-PLACE:指挥台视图第二子标签,全局治理面)──────────────────
 只读状态面:12 分区(nightly/evidence/experiments/cost/injection/tools/changeRequests/
 cohort/negativeKb/prompts/atlas/pathology)。数据源:进标签发 rsi.status,回包 rsi.status.result
 (sections[]),15s 轮询;后端未上报时卡片区如实显示「未启用/无数据」,不抛错。
 全部 payload 文本过 esc,无内联事件(零 onclick/onload 属性,纯 addEventListener/onclick 赋值)。 */
var rsiTimer = 0, rsiInflight = false, rsiUnlockTimer = 0;
/* RSI-CTRL:交互态(全部事件委托在 #rsiCards,零内联 onclick)。
 rsiLast=最近一拍回包(rerender 只重渲染卡片区,不回整页);rsiUi[id]={en,drv} 渲染时由 payload 播种,
 本地乐观翻转让点击立即有反应(服务端回包以 payload 为准覆盖);rsiPending[id]=运行请求时刻(20s 内视作运行中);
 rsiEditKey=内联编辑中的条目("mech|item");rsiArmKey=待二次确认的删除条目(3s 窗);rsiOpen=已展开详情。 */
var rsiLast = null, rsiBound = false, rsiUi = {}, rsiOpt = {}, rsiEditKey = "", rsiArmKey = "", rsiArmTimer = 0, rsiOpen = {}, rsiOrig = {}, rsiPending = {};
function rsiStatusPull() {
  if (rsiInflight) return; // 去重:上一轮未回不重发(防断链/后端缺失时请求堆积)
  rsiInflight = true;
  wsSafeSend(JSON.stringify({ v: 1, type: "rsi.status" }));
 // 回包缺失兜底(后端尚未实现该 type 时不永久卡住轮询):12s 解锁下一次
  clearTimeout(rsiUnlockTimer);
  rsiUnlockTimer = setTimeout(function () { rsiInflight = false; }, 12000);
}
function rsiPollSync(name) {
  if (name !== "rsi" && name !== "dream" && name !== "super") { // 做梦区随 super 视图常驻(IDE 三栏);离开指挥台停表并清空句柄 + 清 in-flight
    if (rsiTimer) { clearInterval(rsiTimer); rsiTimer = 0; }
    clearTimeout(rsiUnlockTimer);
    rsiInflight = false;
    rsiEvStop();
    return;
  }
  if (rsiTimer) return; // 已在轮询:不叠加 interval(防重复定时器)
  rsiStatusPull(); rsiTimer = setInterval(rsiStatusPull, 15000); // 机制卡状态轮询(做梦视图独有;super 聊天段不跑)
  rsiEvStart(); // 固定会话窗:进入即拉一拍 rsi 会话历史,之后 2s 增量追平(rsiStream 紧凑流消费)
}
function rsiTone(t) {
  var s = String(t === undefined || t === null ? "" : t).toLowerCase();
  if (s === "ok" || s === "good" || s === "green" || s === "normal") return "ok";
  if (s === "bad" || s === "err" || s === "error" || s === "fail" || s === "red" || s === "critical") return "bad";
  return "warn";
}
function rsiSecStatus(s) { var o = s || {}; if (o.ok === true) return "ok"; if (o.ok === false) { var c = String(o.code || ""); return (c.indexOf("ERROR") >= 0 || c.indexOf("CONFLICT") >= 0) ? "bad" : "warn"; } var v = o.status; if (v === undefined || v === null || v === "") v = o.tone; if (v === undefined || v === null || v === "") v = o.state; return v; }
/** 状态三分( RSI-DASH-UX):未启用(无 store → code=UNAVAILABLE)与异常彻底分离。
 * 此前二者都算「降级」,无任何 RSI store 的全新仓被渲染成 12 区黄色告警 = 把「尚未产生数据」误报成异常。
 * ok=rsiSecStatus 判 ok;unavailable=!ok 且 code=UNAVAILABLE;error=其余 !ok。 */
function rsiStateKind(s) {
  var o = s || {};
  if (rsiSecStatus(o) === "ok") return "ok";
  var c = String(o.code !== undefined ? o.code : (o.codeText !== undefined ? o.codeText : ""));
  return c === "UNAVAILABLE" ? "unavailable" : "error";
}
/** 三分 → 视觉色调:ok 绿 / unavailable 中性灰(idle) / error 红(bad)。 */
function rsiKindTone(k) { return k === "ok" ? "ok" : (k === "unavailable" ? "idle" : "bad"); }
function rsiHms(ts) {
  var d = new Date(typeof ts === "number" ? ts : (ts ? Date.parse(String(ts)) : Date.now()));
  if (isNaN(d.getTime())) d = new Date();
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function rsiMetricsHtml(sec) {
  var ms = sec && sec.metrics, rows = [], i, x, tn, label, val;
  if (Array.isArray(ms)) {
    for (i = 0; i < ms.length && rows.length < 8; i++) { // ≤8 条自然截断
      x = ms[i] || {};
      label = x.label !== undefined ? x.label : (x.k !== undefined ? x.k : x.key);
      if (label === undefined || label === null || label === "") continue;
      val = x.value !== undefined ? x.value : (x.v !== undefined ? x.v : "-");
      tn = x.tone !== undefined ? x.tone : x.status;
      rows.push("<span>" + esc(label) + " <b" + (tn ? ' class="rsi-tone-' + rsiTone(tn) + '"' : "") + ">" +
        esc(String(val) + (x.unit ? " " + String(x.unit) : "")) + "</b></span>");
    }
  } else if (ms && typeof ms === "object") {
    var keys = Object.keys(ms);
    for (i = 0; i < keys.length && rows.length < 8; i++) {
      rows.push("<span>" + esc(keys[i]) + " <b>" + esc(String(ms[keys[i]])) + "</b></span>");
    }
  }
  return rows.length ? '<div class="rsi-kv">' + rows.join("") + "</div>" : "";
}
function rsiWarnHtml(sec) {
  var w = sec && sec.warnings;
  if (!w) return "";
  var arr = Array.isArray(w) ? w : [w], out = [], i, it, txt;
  for (i = 0; i < arr.length; i++) {
    it = arr[i];
    txt = it && typeof it === "object" ? (it.message !== undefined ? it.message : (it.msg !== undefined ? it.msg : it.text)) : it;
    if (txt === undefined || txt === null || txt === "") continue;
    out.push('<div class="rsi-warn-line">⚠ ' + esc(txt) + "</div>");
  }
  return out.join("");
}
/* ── RSI-CTRL:机制开关/驱动切换/运行 + 结果条目改删(协议 rsi.mechanism.set / rsi.mechanism.run /
 rsi.item.update / rsi.item.delete;回包三个 *.result 分支在 WS 分发处各拉一拍 rsiStatusPull 刷新,不整页重载)── */
function rsiSecId(s) {
  var o = s || {}, v = o.id !== undefined ? o.id : (o.key !== undefined ? o.key : o.name);
  return v === undefined || v === null ? "" : String(v);
}
function rsiSecEnabled(s) { return !(s && s.enabled === false); } // 缺省启用(旧后端不带该字段时按可运行展示)
function rsiSecDriver(s) { return s && s.driver === "code" ? "code" : "agent"; }
/** 条目 status(ok|warn|bad|info)→ 既有点色调名(ok/warn/bad/idle)。 */
function rsiTextTone(v) {
  var s = String(v === undefined || v === null ? "" : v).toLowerCase();
  if (s === "ok" || s === "done" || s === "green") return "ok";
  if (s === "bad" || s === "error" || s === "failed" || s === "err") return "bad";
  if (s === "warn" || s === "warning") return "warn";
  return "idle";
}
function rsiRunOf(s) { var r = s && s.run; return r && typeof r === "object" ? r : null; }
/* ── RSI-SESSION-COST:一次运行花了多少 + 分析了哪些会话 ─────────────────
 数据同源:金额/token 全来自服务端 run.cost / run.analysis(journal + 单价表算出);
 单价缺失(amountCny===null)只写「单价缺失」,**绝不显示 ¥0**。 */
function rsiTok(n) { var v = Number(n); if (!isFinite(v) || v < 0) v = 0; return v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)); }
function rsiMoney(a) { if (a === null || a === undefined) return "单价缺失"; var v = Number(a); if (!isFinite(v)) return "单价缺失"; return "¥" + (v >= 1 ? v.toFixed(2) : v.toFixed(4)); }
/** 运行头第一行:金额 · 总 token(输入/缓存/输出);缺价时补一段「缺单价段」。 */
function rsiCostHead(run) {
  var c = run && run.cost;
  if (!c || typeof c !== "object") return "";
  var text = rsiMoney(c.amountCny) + " · " + rsiTok(c.totalTokens) + " tokens(输入 " + rsiTok(c.inputTokens) + " / 缓存 " + rsiTok(c.cachedTokens) + " / 输出 " + rsiTok(c.outputTokens) + ")";
  if (c.amountCny === null && Array.isArray(c.missing) && c.missing.length > 0) text += " · 缺单价段 " + c.missing.join("/");
  var title = c.model !== undefined && c.model !== null && String(c.model) !== "" ? "模型 " + String(c.model) : "模型未上报";
  return '<span class="rsi-run-state" data-run-cost="1" title="' + esc(title) + '">' + esc(text) + "</span>";
}
/** 运行头第二行:分析 n 会话 · <项目> n / <项目> n(项目计数只按已认账会话算)。 */
function rsiAnalysisHead(run) {
  var a = run && run.analysis;
  if (!a || typeof a !== "object") return "";
  var done = Array.isArray(a.analyzed) ? a.analyzed : [], cands = Array.isArray(a.candidates) ? a.candidates : [];
  var counts = {}, order = [], i, pid, d;
  for (i = 0; i < done.length; i++) {
    d = done[i] || {};
    pid = d.projectId !== undefined && d.projectId !== null && String(d.projectId) !== "" ? String(d.projectId) : "(未绑定)";
    if (counts[pid] === undefined) { counts[pid] = 0; order.push(pid); }
    counts[pid] += 1;
  }
  var text = "分析 " + done.length + " 会话" + (done.length === 0 && cands.length > 0 ? "(候选都还没认账)" : "");
  var per = [];
  for (i = 0; i < order.length; i++) per.push(order[i] + " " + counts[order[i]]);
  if (per.length > 0) text += " · " + per.join(" / ");
  text += " · 候选 " + cands.length;
  return '<span class="rsi-run-state" data-run-analysis="1">' + esc(text) + "</span>";
}
/* ── 质量契约 v2:一次运行的结果质量(四件套覆盖/浅层/重复/上限)──────
 数据同源:服务端 run.quality(assessResultQuality 确定性计算);缺字段=旧数据不显示。
 评分高不代表结论对,只代表「主张→证据→影响→建议」结构完整、没有流水账形态。 */
function rsiQualityHead(run) {
  var q = run && run.quality;
  if (!q || typeof q !== "object") return "";
  var n = Number(q.items) || 0, score = Number(q.score);
  if (!isFinite(score)) score = 0;
  var tone = score >= 85 ? "ok" : score >= 60 ? "warn" : "bad";
  var bits = "质量 " + score + " · 证据 " + (Number(q.evidenced) || 0) + "/" + n +
    " · 影响 " + (Number(q.impacted) || 0) + " · 建议 " + (Number(q.actionable) || 0);
  if (Number(q.shallow) > 0) bits += " · 浅层 " + Number(q.shallow);
  if (Number(q.duplicates) > 0) bits += " · 重复 " + Number(q.duplicates);
  if (q.overLimit === true) bits += " · 超上限";
  var issues = Array.isArray(q.issues) ? q.issues : [];
  var tip = issues.map(function (x) { return String((x && x.note) || ""); }).filter(function (s) { return s !== ""; }).join("\\n");
  return '<span class="rsi-q rsi-q-' + tone + '" data-run-quality="1"' + (tip ? ' title="' + esc(tip) + '"' : "") + ">" + esc(bits) + "</span>";
}
/** 卡片体小块:逐行候选/已分析 sessionId 与项目(全部 esc,无内联 onclick)。 */
function rsiCostBody(run) {
  var a = run && run.analysis;
  if (!a || typeof a !== "object") return "";
  var cands = Array.isArray(a.candidates) ? a.candidates : [], done = Array.isArray(a.analyzed) ? a.analyzed : [];
  var seen = {}, rows = [], i, x, sid, pid;
  for (i = 0; i < cands.length; i++) {
    x = cands[i] || {};
    sid = x.sessionId !== undefined && x.sessionId !== null ? String(x.sessionId) : "";
    if (sid === "") continue;
    seen[sid] = 1;
    pid = x.projectId !== undefined && x.projectId !== null && String(x.projectId) !== "" ? "(" + esc(String(x.projectId)) + ")" : "(未绑定)";
    rows.push('<div class="rsi-cost-row">' + esc(sid) + " " + pid + " · 候选</div>");
  }
  for (i = 0; i < done.length; i++) {
    x = done[i] || {};
    sid = x.sessionId !== undefined && x.sessionId !== null ? String(x.sessionId) : "";
    if (sid === "") continue;
    pid = x.projectId !== undefined && x.projectId !== null && String(x.projectId) !== "" ? "(" + esc(String(x.projectId)) + ")" : "(未绑定)";
    var mark = seen[sid] ? "已分析" : "已分析(不在本次候选)";
    delete seen[sid];
    rows.push('<div class="rsi-cost-row">' + esc(sid) + " " + pid + " · " + mark + "</div>");
  }
  if (rows.length === 0) return '<div class="rsi-items" id="rsiCostLine" data-run-cost="1"><div class="rsi-run-state">本次未涉及会话</div></div>';
  return '<details class="rsi-cost" id="rsiCostLine" data-run-cost="1"><summary>候选/已分析会话 (' + rows.length + ')</summary><div class="rsi-items">' + rows.join("") + "</div></details>";
}
function rsiCut(t, n) { var s = String(t === undefined || t === null ? "" : t); return s.length > n ? s.slice(0, n) + "…" : s; }
/** 服务端稳定 reason → 人话(未知原样显示,不隐藏错误)。 */
function rsiReasonText(code) {
  var c = String(code === undefined || code === null ? "" : code);
  var map = {
    UNKNOWN_MECHANISM: "未知机制",
    MECHANISM_DISABLED: "机制已关闭,先打开开关",
    CODE_DRIVER_CLI_ONLY: "当前为代码驱动,切到 Agent 才能运行",
    RUNNING_ALREADY: "已有运行中的任务,等它结束",
    SUBMIT_FAILED: "派发失败(检查模型/网关配置)",
    ITEM_NOT_FOUND: "条目不存在(可能已删除)",
    UNKNOWN_ID: "未知 id",
  };
  return map[c] ? map[c] + "(" + c + ")" : c;
}
function rsiMechSend(id, enabled, driver) {
  var msg = { v: 1, type: "rsi.mechanism.set", id: String(id) };
  if (enabled !== undefined) msg.enabled = !!enabled;
  if (driver) msg.driver = driver === "code" ? "code" : "agent";
  wsSafeSend(JSON.stringify(msg));
}
/** 条目区:未启用=关闭说明;启用且空=引导运行;非空→逐条渲染(可改可删可展开)。 */
function rsiItemsHtml(sec, mid, enabled) {
  var arr = sec && Array.isArray(sec.items) ? sec.items : [], out = [], i, o, iid, key;
  var latestRun = sec && sec.run && sec.run.runId ? String(sec.run.runId) : "";
  var current = [], history = [];
  for (i = 0; i < arr.length; i++) {
    o = arr[i] || {};
    var rid = o.runId !== undefined && o.runId !== null ? String(o.runId) : "";
    if (latestRun !== "" && rid !== "" && rid !== latestRun) history.push(o);
    else current.push(o);
  }
  if (!enabled) out.push('<div class="rsi-empty">机制已关闭,不再自动运行</div>');
  if (!current.length) {
    if (enabled) {
      var runDone = sec && sec.run && String(sec.run.status) === "done";
      out.push('<div class="rsi-empty">' + (runDone ? "最近一次运行完成,但数据源无数据(agent 未产出条目)" : "暂无结果条目(点「运行」让 agent 产出)") + "</div>");
    }
  }
  for (i = 0; i < current.length; i++) {
    o = current[i] || {};
    iid = o.id !== undefined && o.id !== null ? String(o.id) : "";
    key = mid + "|" + iid;
    out.push(rsiItemHtml(mid, iid, o, key));
  }
  if (history.length) {
    var hrows = [];
    for (i = 0; i < history.length; i++) {
      o = history[i] || {};
      hrows.push('<div class="rsi-item rsi-hist-item rsi-tone-' + rsiTextTone(o.status) + '"><span class="rsi-dot"></span><span class="rsi-item-t">' + esc(String(o.title !== undefined && o.title !== null ? o.title : "(无标题)")) + '</span><span class="rsi-item-sum">' + esc(String(o.summary !== undefined && o.summary !== null ? o.summary : "")) + '</span></div>');
    }
    out.push('<details class="rsi-hist"><summary>历史运行结果 (' + history.length + ')</summary><div class="rsi-hist-body">' + hrows.join("") + '</div></details>');
  }
  return '<div class="rsi-items">' + out.join("") + "</div>";
}
/** 单条目:普通行(标题+状态点+单行摘要+改/删)/内联编辑表单/展开的 detail。全部服务端文本过 esc。 */
function rsiItemHtml(mid, iid, o, key) {
  var title = o.title !== undefined && o.title !== null ? String(o.title) : "(无标题)";
  var summary = o.summary !== undefined && o.summary !== null ? String(o.summary) : "";
  var detail = o.detail !== undefined && o.detail !== null ? String(o.detail) : "";
  var evidence = o.evidence !== undefined && o.evidence !== null ? String(o.evidence) : "";
  var impact = o.impact !== undefined && o.impact !== null ? String(o.impact) : "";
  var action = o.action !== undefined && o.action !== null ? String(o.action) : "";
  var tone = rsiTextTone(o.status);
  var src = o.source !== undefined && o.source !== null && o.source !== ""
    ? String(o.source) + (o.at !== undefined && o.at !== null ? " · " + rsiHms(o.at) : "") : "";
  if (rsiEditKey === key) { // 内联编辑:原值留档(保存时只发改动字段)
    rsiOrig[key] = { t: title, s: summary };
    return '<div class="rsi-item rsi-tone-' + tone + ' rsi-edit" data-item="' + esc(iid) + '" data-mech="' + esc(mid) + '">' +
      '<div class="rsi-form" data-mech="' + esc(mid) + '" data-item="' + esc(iid) + '">' +
      '<input data-f="title" value="' + esc(title) + '" placeholder="标题" />' +
      '<textarea data-f="summary" rows="2" placeholder="摘要">' + esc(summary) + "</textarea>" +
      '<div class="rsi-form-acts"><button class="rsi-item-act" data-act="save" data-id="' + esc(mid) + '" data-item="' + esc(iid) + '">保存</button>' +
      '<button class="rsi-item-act" data-act="cancel" data-id="' + esc(mid) + '" data-item="' + esc(iid) + '">取消</button></div></div></div>';
  }
  var canExp = detail.length > 0 || evidence.length > 0 || impact.length > 0 || action.length > 0;
  var exp = !!(canExp && rsiOpen[key]), arm = rsiArmKey === key;
  var qlines = "";
  if (evidence.length > 0) qlines += '<div class="rsi-q-line"><b>证据</b><span>' + esc(evidence) + "</span></div>";
  if (impact.length > 0) qlines += '<div class="rsi-q-line"><b>影响</b><span>' + esc(impact) + "</span></div>";
  if (action.length > 0) qlines += '<div class="rsi-q-line"><b>建议</b><span>' + esc(action) + "</span></div>";
  if (detail.length > 0) qlines += '<div class="rsi-q-detail">' + esc(detail) + "</div>";
  return '<div class="rsi-item rsi-tone-' + tone + (exp ? " exp" : "") + (arm ? " rsi-arm" : "") + '" data-item="' + esc(iid) + '" data-mech="' + esc(mid) + '">' +
    '<div class="rsi-item-row"><span class="rsi-dot"></span>' +
    '<span class="rsi-item-t"' + (canExp ? ' data-act="exp" data-id="' + esc(mid) + '" data-item="' + esc(iid) + '" title="点击' + (exp ? "收起" : "展开") + '证据/影响/建议"' : "") + ">" +
    esc(title) + (canExp ? '<i class="rsi-item-arrow">⌄</i>' : "") + "</span>" +
    '<span class="rsi-item-sum" title="' + esc(summary + (src ? " · " + src : "")) + '">' + esc(summary || src) + "</span>" +
    '<span class="rsi-item-acts"><button class="rsi-item-act" data-act="edit" data-id="' + esc(mid) + '" data-item="' + esc(iid) + '">改</button>' +
    '<button class="rsi-item-act" data-act="del" data-id="' + esc(mid) + '" data-item="' + esc(iid) + '">' + (arm ? "确认删" : "删") + "</button></span></div>" +
    (canExp ? '<div class="rsi-item-detail">' + qlines + (src ? ' <span class="rsi-code">' + esc(src) + "</span>" : "") + "</div>" : "") + "</div>";
}
/** 卡头右侧控件:开关(aria-pressed)/驱动 select/运行按钮(运行中=disabled + 「运行中…」)。 */
function rsiCtrlHtml(sid, enabled, drv, running) {
  return '<span class="rsi-ctrl">' +
    '<button class="rsi-sw ' + (enabled ? "on" : "off") + '" data-act="toggle" data-id="' + esc(sid) + '" aria-pressed="' + (enabled ? "true" : "false") + '">' + (enabled ? "已启用" : "已关闭") + "</button>" +
    '<select class="rsi-drv" data-id="' + esc(sid) + '" title="驱动方式">' +
    '<option value="agent"' + (drv === "agent" ? " selected" : "") + ">Agent</option>" +
    '<option value="code"' + (drv === "code" ? " selected" : "") + ">代码</option></select>" +
    '<button class="rsi-run" data-act="run" data-id="' + esc(sid) + '"' + (running ? " disabled" : "") + ">" + (running ? "运行中…" : "运行") + "</button></span>";
}
/** 事件委托(绑一次):#rsiCards 上 click/change 全接管,新增交互不产生任何内联 onclick 属性。 */
function rsiBind(box) {
  if (!box || rsiBound) return;
  box.addEventListener("click", rsiOnClick);
  box.addEventListener("change", rsiOnChange);
  rsiBound = true;
}
function rsiRerender() { if (rsiLast) rsiRender(rsiLast); supIdeSideRender(); } // 重渲染卡片区+侧栏做梦列表(用最近一拍 payload),不回整页
/** 乐观态合并:点击开关/切驱动先本地生效,payload 追上该值即丢弃覆盖(15s TTL 兜底,防服务端不生效时永久骗人)。 */
function rsiOptMerge(sid, enabled, drv) {
  var ov = rsiOpt[sid];
  if (ov) {
    if (Date.now() - ov.t > 15000) delete rsiOpt[sid];
    else {
      if (ov.en !== undefined) { if (ov.en === enabled) delete ov.en; else enabled = ov.en; }
      if (ov.drv !== undefined) { if (ov.drv === drv) delete ov.drv; else drv = ov.drv; }
      if (ov.en === undefined && ov.drv === undefined) delete rsiOpt[sid];
    }
  }
  return { en: enabled, drv: drv };
}
function rsiItemSave(el, mid, iid, key) {
  var form = el && el.closest ? el.closest(".rsi-form") : null;
  var pick = function (f) { var e = form ? form.querySelector('[data-f="' + f + '"]') : null; return e && e.value !== undefined && e.value !== null ? String(e.value) : ""; };
  var nt = pick("title"), ns = pick("summary"), o = rsiOrig[key] || {};
  var msg = { v: 1, type: "rsi.item.update", mechanismId: mid, itemId: iid }, n = 0;
  if (nt !== (o.t === undefined ? "" : o.t)) { msg.title = nt; n++; } // 只发改动字段
  if (ns !== (o.s === undefined ? "" : o.s)) { msg.summary = ns; n++; }
  rsiEditKey = "";
  if (n) wsSafeSend(JSON.stringify(msg));
  rsiRerender();
}
function rsiOnClick(ev) {
  var t = ev && ev.target ? ev.target : null;
  var el = t && t.closest ? t.closest("[data-act]") : null;
  if (!el) { if (rsiArmKey) { rsiArmKey = ""; clearTimeout(rsiArmTimer); rsiRerender(); } return; } // 点别处:删除确认复原
  var act = String(el.getAttribute("data-act") || "");
  var mid = String(el.getAttribute("data-id") || "");
  var iid = String(el.getAttribute("data-item") || "");
  var key = mid + "|" + iid;
  if (act !== "del" && rsiArmKey) { rsiArmKey = ""; clearTimeout(rsiArmTimer); } // 切到别的动作同样复原
  if (act === "toggle") {
    var st = rsiUi[mid] || {}, next = !(st.en !== false);
    st.en = next; st.drv = st.drv || "agent"; rsiUi[mid] = st;
    rsiOpt[mid] = { en: next, drv: st.drv, t: Date.now() }; // 乐观态留档:紧跟的 rerender 用 payload 播种时必须被它盖住,否则点击瞬间回弹
    rsiMechSend(mid, next, st.drv); // 乐观翻转 + 发消息;下一次 rsi.status.result 以服务端为准
    rsiRerender();
    return;
  }
  if (act === "run") {
    rsiPending[mid] = Date.now();
    wsSafeSend(JSON.stringify({ v: 1, type: "rsi.mechanism.run", id: mid }));
    rsiRerender();
    switchView("super"); // 点运行 → 回聊天段(做梦开始卡由服务端注入 super 会话,聊天流内实时可见)
    return;
  }
  if (act === "edit") { rsiEditKey = key; rsiRerender(); return; }
  if (act === "cancel") { rsiEditKey = ""; rsiRerender(); return; }
  if (act === "exp") { rsiOpen[key] = !rsiOpen[key]; rsiRerender(); return; }
  if (act === "save") { rsiItemSave(el, mid, iid, key); return; }
  if (act === "del") {
    if (rsiArmKey === key) { // 二次确认:3s 窗内再点才真删
      rsiArmKey = ""; clearTimeout(rsiArmTimer);
      wsSafeSend(JSON.stringify({ v: 1, type: "rsi.item.delete", mechanismId: mid, itemId: iid }));
      rsiRerender();
      return;
    }
    rsiArmKey = key;
    clearTimeout(rsiArmTimer);
    rsiArmTimer = setTimeout(function () { rsiArmKey = ""; rsiRerender(); }, 3000); // 超时复原「删」
    rsiRerender();
    return;
  }
}
function rsiOnChange(ev) {
  var t = ev && ev.target ? ev.target : null;
  if (!t || !t.classList || !t.classList.contains("rsi-drv")) return;
  var mid = String(t.getAttribute("data-id") || ""), drv = String(t.value === "code" ? "code" : "agent");
  var st = rsiUi[mid] || {};
  st.drv = drv; rsiUi[mid] = st;
  rsiOpt[mid] = { drv: drv, t: Date.now() }; // 同上:切驱动乐观态留档(rerender 播种时不被旧 payload 打回)
  rsiMechSend(mid, st.en !== false, drv); // 切驱动保留当前开/关
}
/* ── RSI-SELF-DRIVE:自动周期条(开关/间隔/下一拍/预算/推一拍)──────────────
 数据同源:rsi.status.scheduler(config + runtime + breaker);回包 rsi.scheduler.result
 只做 toast + 重拉(status 请求会带回最新 scheduler)。事件全部委托(零内联 onclick)。 */
function rsiSchedAgo(ts) {
  var t = Number(ts);
  if (!isFinite(t) || t <= 0) return "";
  var d = Date.now() - t, a = Math.abs(d);
  var txt = a >= 864e5 ? Math.round(a / 864e5) + " 天" : a >= 36e5 ? Math.round(a / 36e5) + " 小时" : Math.round(a / 6e4) + " 分钟";
  return d >= 0 ? txt + "前" : txt + "后";
}
function rsiSchedRender(st) {
  var bar = $("rsiSchedBar");
  if (!bar) return;
  if (!st || typeof st !== "object") { bar.style.display = "none"; return; }
  var cfg = st.config || {}, rt = st.runtime || {}, br = rt.breaker || {};
  bar.style.display = "";
  var on = cfg.enabled === true, paused = br.paused === true;
  var opts = [[60, "每 1 小时"], [360, "每 6 小时"], [720, "每 12 小时"], [1440, "每 1 天"], [2880, "每 2 天"], [10080, "每 7 天"]];
  var sel = "";
  for (var i = 0; i < opts.length; i++) sel += '<option value="' + opts[i][0] + '"' + (Number(cfg.everyMinutes) === opts[i][0] ? " selected" : "") + ">" + opts[i][1] + "</option>";
  var bits = [];
  bits.push('<span class="ss-dot' + (on ? (paused ? " warn" : " ok") : "") + '"></span>');
  bits.push("<b>自动周期</b>");
  bits.push('<button class="vw-act ss-toggle" data-ssact="toggle" title="打开后按间隔自动串行运行已启用机制(只有空闲才开新周期)">' + (on ? "已开启 · 点关闭" : "已关闭 · 点开启") + "</button>");
  bits.push('<select class="ss-int" data-ssint="1" title="周期间隔">' + sel + "</select>");
  if (paused) bits.push('<span class="ss-badge warn" title="' + esc(String(br.reason || "熔断暂停")) + '">熔断暂停' + (br.reason ? " · " + esc(String(br.reason).slice(0, 40)) : "") + "</span>");
  if (rt.cycle) {
    var cyc = rt.cycle, done = (cyc.settled || []).length, total = done + (cyc.pending || []).length;
    bits.push('<span class="ss-meta">周期 ' + esc(String(cyc.index || 1)) + " · " + done + "/" + total + " 机制</span>");
  } else if (on) {
    bits.push('<span class="ss-meta">下一拍 ' + (rt.nextRunAt ? esc(rsiSchedAgo(rt.nextRunAt)) : "尽快") + "</span>");
  }
  if (rt.lastCycle) {
    var lc = rt.lastCycle, tok = Number(lc.costTokens) || 0;
    bits.push('<span class="ss-meta">上轮 ' + (tok >= 1e6 ? (tok / 1e6).toFixed(2) + "M" : Math.round(tok / 1000) + "k") + " tok" +
      (lc.amountCny === null || lc.amountCny === undefined ? "" : " · ¥" + Number(lc.amountCny).toFixed(4)) +
      (lc.budgetExceeded ? " · 超预算" : "") +
      (Number(lc.quotaFactor) > 0 && Number(lc.quotaFactor) < 1 ? " · 降频 x" + Number(lc.quotaFactor) : "") + "</span>");
  }
  bits.push('<span class="ss-meta">预算 ' + (Number(cfg.tokenBudgetPerRun) > 0 ? Math.round(Number(cfg.tokenBudgetPerRun) / 1000) + "k/次" : "不限") +
    " · 周期 " + (Number(cfg.tokenBudgetPerCycle) > 0 ? (Number(cfg.tokenBudgetPerCycle) / 1e6).toFixed(0) + "M" : "不限") +
    " · 重试 " + (cfg.autoRetry === true ? "开(" + esc(String(cfg.maxRetriesPerRun || 0)) + ")" : "关") +
    " · ROI " + (cfg.roiGate === true ? "开" : "关") + "</span>");
  bits.push('<button class="vw-act" data-ssact="run" title="立即推一拍自动周期状态机(到点/空闲/单跑判定照旧)">推一拍</button>');
  bar.innerHTML = bits.join("");
  if (!bar.__ssBound) {
    bar.__ssBound = true;
    bar.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var act = t.closest("[data-ssact]");
      if (!act) return;
      var a = String(act.getAttribute("data-ssact") || "");
      if (a === "toggle") {
        var cur = rsiLast && rsiLast.scheduler && rsiLast.scheduler.config ? rsiLast.scheduler.config.enabled === true : false;
        act.disabled = true;
 // 回包会让 rsiSchedRender 重建按钮;若回包在重载下迟到/丢失,8s 兜底解锁(不把按钮永久锁死)。
        setTimeout(function () { try { act.disabled = false; } catch (e) {} }, 8000);
        wsSafeSend(JSON.stringify({ v: 1, type: "rsi.scheduler.set", enabled: !cur }));
      } else if (a === "run") {
        act.disabled = true;
        setTimeout(function () { try { act.disabled = false; } catch (e) {} }, 8000);
        wsSafeSend(JSON.stringify({ v: 1, type: "rsi.scheduler.run" }));
      }
    });
    bar.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute || t.getAttribute("data-ssint") !== "1") return;
      var v = Number(t.value);
      if (isFinite(v) && v > 0) wsSafeSend(JSON.stringify({ v: 1, type: "rsi.scheduler.set", everyMinutes: v }));
    });
  }
}
function rsiRender(payload) {
  var head = $("rsiHead"), box = $("rsiCards");
  if (!head || !box) return; // 面板不在场:静默返回(不得抛错)
  rsiBind(box);
 // 自动周期条:与 12 区同一拍回包(payload.scheduler);旧后端不带=隐藏,不影响既有渲染。
  rsiSchedRender(payload && (payload.scheduler || (payload.data && payload.data.scheduler)));
 // 全量运行按钮态:任一机制运行中(rsiPending 乐观或 run.status=running)禁用防重入
  var allBtn = $("rsiRunAll");
  if (allBtn) {
    var anyRunning = false;
    for (var pk in rsiPending) if (Date.now() - rsiPending[pk] < 20000) anyRunning = true;
    var raw2 = payload && payload.sections !== undefined ? payload.sections : (payload && payload.data ? payload.data.sections : undefined);
    var secs2 = Array.isArray(raw2) ? raw2 : [];
    for (var si = 0; si < secs2.length; si++) { var rr = rsiRunOf(secs2[si] || {}); if (rr && String(rr.status) === "running") anyRunning = true; }
    allBtn.disabled = anyRunning;
    var allBtnH = $("rsiRunAllH"); if (allBtnH) allBtnH.disabled = anyRunning; // 健康区同一份运行态
  }
  var m = payload || {};
  rsiLast = m;
  var raw = m.sections !== undefined ? m.sections : (m.data ? m.data.sections : undefined);
  var secs = Array.isArray(raw) ? raw : [];
  if (!secs.length) { // 空态(无数据/未启用):不抛错,也不降级成告警( RSI-DASH-UX)
    head.textContent = "RSI 运行看板 · 暂无 RSI 数据";
    box.innerHTML = '<div class="rsi-empty">暂无 RSI 数据' + (m.error ? " · " + esc(m.error) : "") + "</div>";
    superHealthRender(); // 无数据同样刷新健康一屏(空态引导,不保留旧数据)
    return;
  }
  var ok = 0, warn = 0, unavailable = 0, errors = 0, on = 0, kinds = [], merged = [], i, k;
  for (i = 0; i < secs.length; i++) {
    k = rsiHealthKind(secs[i]); kinds.push(k); // 与健康一屏同一分类(机制自报的 warn/bad 也算关注/异常)
    if (k === "ok") ok++; else if (k === "idle") unavailable++; else if (k === "warn") warn++; else errors++;
    merged.push(rsiOptMerge(rsiSecId(secs[i]), rsiSecEnabled(secs[i]), rsiSecDriver(secs[i]))); // 乐观态合并(15s TTL):点开关/切驱动后、回包未追上时以本地为准
    if (merged[i].en) on++; // 头部「已启用 x/N」与卡头开关同源(同一份合并结果)
  }
  var when = m.updatedAt !== undefined ? m.updatedAt : m.at;
  head.innerHTML = "RSI 运行看板 · 更新于 <b>" + esc(rsiHms(when)) + "</b> · 正常 " + ok + " · 关注 " + warn + " · 未启用 " + unavailable + " · 异常 " + errors + " · 已启用 " + on + "/" + secs.length;
  var cards = [];
  for (i = 0; i < secs.length; i++) {
    var s = secs[i] || {};
    var kind = kinds[i], tone = kind === "idle" ? "idle" : kind;
    var sid = rsiSecId(s) || ("sec" + i);
    var enabled = merged[i].en, drv = merged[i].drv;
    rsiUi[sid] = { en: enabled, drv: drv }; // 交互真值播种(下一次回包覆盖)
    var title = s.title !== undefined ? s.title : (s.name !== undefined ? s.name : (s.key !== undefined ? s.key : (s.id !== undefined ? s.id : "分区")));
    var code = s.code !== undefined ? s.code : s.codeText;
    var badge = kind === "ok" ? "正常" : kind === "warn" ? "关注" : (kind === "idle" ? "未启用" : "异常");
    var run = rsiRunOf(s), runStatus = run && run.status ? String(run.status) : "";
    var running = runStatus === "running";
    var runQueued = running && run && run.taskState === "queued";
    if (running) delete rsiPending[sid];
    else if (rsiPending[sid]) { // 刚点「运行」:20s 内乐观显示运行中,超时收回
      if (Date.now() - rsiPending[sid] < 20000) running = true; else delete rsiPending[sid];
    }
    var runHead = "", runBody = "";
    if (running) runHead = '<span class="rsi-run-state">' + (runQueued ? "排队中(等空闲槽)" : "运行中") + (run && run.taskId !== undefined && run.taskId !== null ? "(任务 " + esc(String(run.taskId)) + ")" : "") + "</span>";
 // RSI-SESSION-COST:成本行 + 分析行(紧贴运行态,一眼看清这次花了多少、动了哪些会话)。
    runHead += rsiCostHead(run) + rsiAnalysisHead(run);
 // RSI-SELF-DRIVE:预算超限 / 轨迹候选未认账两条质量门如实上屏(不藏)。
    if (run && run.budgetExceeded === true) runHead += '<span class="rsi-run-state rsi-run-warn">超预算' + (run.budgetTokens ? "(" + Math.round(Number(run.budgetTokens) / 1000) + "k)" : "") + "</span>";
    if (run && run.analysisMissing === true) runHead += '<span class="rsi-run-state rsi-run-warn">候选会话未认账</span>';
    runHead += rsiQualityHead(run); // 质量契约 v2(旧数据无 quality=空串)
    if (runStatus === "done" || runStatus === "failed") {
      var at = run && run.finishedAt !== undefined && run.finishedAt !== null ? run.finishedAt : (run ? run.startedAt : undefined);
      runBody = '<div class="rsi-run-state">上次运行:' + (runStatus === "done" ? "完成" : "失败") + "(" + esc(rsiHms(at)) + ")</div>";
      if (runStatus === "failed" && run && run.error !== undefined && run.error !== null && String(run.error) !== "") runBody += '<div class="rsi-run-err">' + esc(rsiCut(run.error, 160)) + "</div>";
    }
    cards.push('<div class="rsi-card rsi-tone-' + tone + (enabled ? "" : " rsi-card-off") + '" data-mech="' + esc(sid) + '"><div class="rsi-card-h"><span class="rsi-dot"></span>' +
      '<span class="rsi-card-title" title="' + esc(String(title)) + '">' + esc(title) + '</span><span class="rsi-badge rsi-badge-' + tone + '">' + badge + "</span>" + rsiCtrlHtml(sid, enabled, drv, running) + runHead + "</div>" +
      (code ? '<div class="rsi-code">' + esc(code) + "</div>" : "") +
      rsiMetricsHtml(s) +
      (kind === "idle" ? '<div class="rsi-hint">未产生数据（运行对应 RSI 任务后自动更新）</div>' : "") +
      rsiWarnHtml(s) + runBody + rsiCostBody(run) + rsiItemsHtml(s, sid, enabled) + "</div>");
  }
  box.innerHTML = cards.join("");
 // 从体检卡进入时高亮并滚到对应机制卡(结果呈现聚焦;不隐藏其它卡)
  var focusMech = String(superIdeSel.dream || "");
  if (focusMech) {
    var focusEl = null;
    for (var fx = 0; fx < box.children.length; fx++) {
      var fc = box.children[fx];
      if (fc && fc.getAttribute && fc.getAttribute("data-mech") === focusMech) { focusEl = fc; break; }
    }
    if (focusEl) {
      focusEl.classList.add("rsi-card-focus");
      try { focusEl.scrollIntoView({ block: "nearest" }); } catch (fe) { /* 老浏览器忽略 */ }
    }
  }
  supIdeSideRender(); // 侧栏做梦机制列表与卡片同源同帧刷新
  superHealthRender(); // 健康一屏与机制卡同一份 payload 同帧刷新
  supRenderResults(); // 结果流的机制行用它补「几条结果/待关注/最严重发现」
}
/* ── RSI-SESSION:固定会话窗(MECH-USER 口径)──────────────────────────────
 所有机制运行都追加到同一个会话 id "rsi";这里内嵌它的实时工作流:
 拉 session.history(sessionId="rsi") 增量,渲染 任务卡 / assistant 文本 / 工具调用+结果 / 步骤 / 授权等待。
 纪律:①只在 RSI 子标签在场时轮询(2s),离开即停;②replay 上限 600 条(完整历史去主会话看);
 ③回包在 WS 分发处按 sessionId==="rsi" 前置分流,绝不并入主会话 histEvents。 */
var RSI_EV_SID = "rsi", rsiEv = [], rsiEvMaxSeq = 0, rsiEvReady = false, rsiEvInflight = false, rsiEvTimer = 0;
function rsiEvCut(t, n) { var s = String(t === undefined || t === null ? "" : t); return s.length > n ? s.slice(0, n) + "…" : s; }
function rsiEvPull() {
  if (rsiEvInflight) return;
  rsiEvInflight = true;
  wsSafeSend(JSON.stringify(rsiEvReady
    ? { v: 1, type: "session.history", sessionId: RSI_EV_SID, sinceSeq: rsiEvMaxSeq }
    : { v: 1, type: "session.history", sessionId: RSI_EV_SID, limit: 300 }));
}
function rsiEvStart() {
  if (rsiEvTimer) return;
  rsiEvPull();
  rsiEvTimer = setInterval(rsiEvPull, 2000);
}
function rsiEvStop() {
  if (rsiEvTimer) { clearInterval(rsiEvTimer); rsiEvTimer = 0; }
  rsiEvInflight = false;
}
function rsiEvOnHist(m) {
  rsiEvInflight = false;
  var evs = Array.isArray(m.events) ? m.events : [], i, e, s, known = {};
  if (m.hasMore !== undefined) { rsiEv = evs.slice(); rsiEvReady = true; } // 首屏尾页
  else if (m.since !== undefined && m.since > 0 && rsiEvReady) { // 增量:按 seq 去重后追加
    for (i = 0; i < rsiEv.length; i++) known[rsiEv[i].seq] = 1;
    for (i = 0; i < evs.length; i++) { e = evs[i]; if (!known[e.seq]) rsiEv.push(e); }
  } else { rsiEv = evs.slice(); rsiEvReady = true; } // 全量重放
  var mx = 0;
  for (i = 0; i < rsiEv.length; i++) { s = rsiEv[i].seq; if (typeof s === "number" && s > mx) mx = s; }
  rsiEvMaxSeq = mx;
  if (rsiEv.length > 600) rsiEv = rsiEv.slice(-600); // 上限:只留最近 600 条
  rsiEvRender();
 // rsiStream 紧凑流独享回包(旧第三子标签满渲染已退役)
}
function rsiEvRender() {
  var box = $("rsiStreamBody"), meta = $("rsiStreamMeta");
  if (!box) return;
  if (!rsiEv.length) {
    if (meta) meta.textContent = "空闲";
    box.innerHTML = '<div class="rsi-empty">尚无 RSI 运行记录。点任意机制的「运行」,工作过程会在这里实时显示。</div>';
    return;
  }
  var wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  var out = [], i, e, p, k, txt;
  for (i = 0; i < rsiEv.length; i++) {
    e = rsiEv[i] || {}; p = e.payload || {}; k = String(e.kind || "");
    if (k === "message.user") {
      txt = String(p.text || "");
      out.push('<div class="rsi-ev rsi-ev-task"><b>任务</b><div class="rsi-ev-txt">' + esc(rsiEvCut(txt, 480)) + "</div></div>");
    } else if (k === "message.agent") {
      txt = String(p.text || "").trim();
      if (txt) out.push('<div class="rsi-ev rsi-ev-agent"><div class="rsi-ev-txt">' + esc(rsiEvCut(txt, 1600)) + "</div></div>");
    } else if (k === "tool.call") {
      out.push('<div class="rsi-ev rsi-ev-tool">▸ ' + esc(String(p.name || "tool")) + ' <span class="rsi-ev-args">' + esc(rsiEvCut(String(p.arguments || ""), 160)) + "</span></div>");
    } else if (k === "tool.result") {
      out.push('<div class="rsi-ev rsi-ev-res">↳ ' + esc(String(p.name || "")) + " · " + esc(rsiEvCut(String(p.content || ""), 220)) + "</div>");
    } else if (k === "step.start") {
      out.push('<div class="rsi-ev rsi-ev-step">step ' + esc(String(p.step === undefined ? "" : p.step)) + " 开始</div>");
    } else if (k === "permission.gate") {
      out.push('<div class="rsi-ev rsi-ev-warn">等待授权:' + esc(rsiEvCut(String(p.toolName || p.name || p.tool || ""), 60)) + "</div>");
    }
  }
  box.innerHTML = out.join("") || '<div class="rsi-empty">会话已建立,等待事件…</div>';
  if (meta) meta.textContent = "最近 " + rsiEv.length + " 条";
  if (wasBottom) box.scrollTop = box.scrollHeight;
}
/* ── SUPER-CHAT:rsi 会话满渲染(会话Chat 子标签)──────────────────────────
 复用方式=「薄壳调用主聊天卡片构造函数」:renderHistory 主循环(panel.ts:10923 起)与十余个全局态
 (histEvents/findQuery/mfScan 记忆化/currentSid/settings/subWsActive/turnOutcome)强耦合,全量抽取
 不可行(规划已预案此降级)。这里直接调用与主聊天同一批构造函数——replyBlockHtml(assistant markdown
 回复卡)/toolCallCard(工具调用+结果合并卡)/toolResultCard(孤儿结果卡),卡片类名 .user-line/.sys-line/
 .tool-card/.task-reply 均为主聊天全局样式 → 观感与 coding agent 主聊天一致。
 数据=rsiEv(RSI 页 2s 轮询 session.history 的同一份结果,rsiEvOnHist 双消费,600 条上限沿用)。 */
var rsiChatErr = "", rsiChatErrAt = 0; // 已退役(旧第三子标签 pane 删除);断连探针仍引用,保留空值防炸
function rsiChatNoteErr() { /* 会话Chat 退役,错误态由 superViewLoad 的 super.history 重放承担 */ }
/* ── super 聊天窗主线(superPaneChat 消息区薄壳)──────────────────────────
 渲染=主聊天同款卡片构造薄壳(参照 rsiChatRender 退役前的方式):replyBlockHtml(assistant
 markdown)/toolCallCard(工具合并卡)/toolResultCard(孤儿结果卡)/userSlashHtml(用户气泡)。
 数据=supState.entries(super.history 回放 + super.turn.user/done 广播 + super.dream 做梦卡 +
 task.changed 派发卡)。派发卡=submittedBy:"super" 的任务(排队→运行→完成+摘要,点卡 openSession)。 */
/* ── Coding Agent 结果流(中栏):任务/做梦/系统通知统一在这里,聊天窗只留人机对话 ─────────
 数据:supState.results[];task=task.changed(submittedBy=super)更新同 taskId;dream=super.dream
 按 runId 更新;notice=super.notice(历史回放重建)。行可点→任务详情/机制报告。 */
function supResultMeta(r) {
  var st = String((r && (r.state || r.phase)) || "").toLowerCase();
  if (st === "failed") return { label: "失败", cls: "failed" };
  if (st === "done" || st === "completed") return { label: "完成", cls: "done" };
  if (st === "running" || st === "start") return { label: "运行中", cls: "running" };
  if (st === "queued") return { label: "排队", cls: "queued" };
  if (st === "cancelled" || st === "canceled") return { label: "取消", cls: "queued" };
  return { label: "通知", cls: "queued" };
}
/** 通知文本 → {title,state,summary}:"[系统通知] 任务「X」已完成:正文" 拆成任务名/状态/正文。 */
function supNoticeParse(text) {
  var raw = String(text || "");
  var t = raw.replace(/^\\[系统通知\\]\\s*/, "");
  var m = t.match(/^任务「([^」]+)」已(完成|失败|取消)[:：]?\\s*([\\s\\S]*)$/);
  if (m) {
    return {
      title: rsiPlainText(m[1], 70),
      state: m[2] === "完成" ? "done" : m[2] === "失败" ? "failed" : "cancelled",
      summary: supCleanText(m[3], 140),
    };
  }
  return { title: "", state: "", summary: supCleanText(t, 140) };
}
/** 服务端文本 → 人话(去 markdown/表格/围栏 + 英文状态词),按整句截断。 */
function supCleanText(s, max) { return rsiPlainText(rsiHumanText(String(s === undefined || s === null ? "" : s)), max); }
/** 机制当前 section(结果摘要从 rsi.status 取,和机制详情同源)。 */
function supRsiSection(mechId) {
  var raw = rsiLast && rsiLast.sections !== undefined ? rsiLast.sections : (rsiLast && rsiLast.data ? rsiLast.data.sections : undefined);
  var secs = Array.isArray(raw) ? raw : [];
  for (var i = 0; i < secs.length; i++) if (rsiSecId(secs[i]) === String(mechId || "")) return secs[i];
  return null;
}
/** 做梦行的可读结果:按本次 runId 取条目(不用其它轮次冒充),条数 + 待关注数 + 最严重发现。 */
function supDreamResult(r) {
  var failed = String(r && r.phase || "") === "failed";
  var sec = r ? supRsiSection(r.mechanismId) : null;
  var items = [], i, t;
  if (sec) {
    var all = Array.isArray(sec.items) ? sec.items : [];
    var rid = r && r.runId ? String(r.runId) : "";
    if (rid) {
      for (i = 0; i < all.length; i++) {
        var it0 = all[i] || {};
        if (it0.runId === undefined || it0.runId === null || String(it0.runId) === rid) items.push(it0);
      }
    } else items = all;
  }
  var worst = rsiWorstItem(items), watch = 0;
  for (i = 0; i < items.length; i++) { t = rsiItemTone(items[i]); if (t === "warn" || t === "bad") watch++; }
  var lead = "";
  if (failed) lead = "运行失败" + (r.summary ? ":" + supCleanText(r.summary, 90) : "");
  else if (worst) lead = supCleanText(worst.title, 70) || supCleanText(worst.summary, 70);
  else if (r && r.summary) lead = supCleanText(r.summary, 100);
  else lead = "本次运行没有产出结果条目";
  var sub = "";
  if (failed) { if (items.length) sub = "中断前已产出 " + items.length + " 条结果,点开看详情"; }
  else if (worst) { var ss = supCleanText(worst.summary, 110); if (ss && ss !== lead) sub = ss; }
  return { lead: lead, sub: sub, count: items.length, watch: watch };
}
/** 结果时间:今天=HH:MM,更早=MM-DD HH:MM(避免把昨天的 14:04 看成今天)。 */
function supWhen(ts) {
  if (!ts) return "";
  var d = new Date(ts), n = new Date();
  var p = function (x) { return (x < 10 ? "0" : "") + x; };
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return p(d.getHours()) + ":" + p(d.getMinutes());
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function supDreamCardHtml(r) {
  var meta = supResultMeta(r), info = supDreamResult(r);
  var when = r.ts ? supWhen(r.ts) : "";
  var cost = r.cost && typeof r.cost === "object"
    ? " · " + (r.cost.amountCny === null || r.cost.amountCny === undefined ? "未计价" : "¥" + Number(r.cost.amountCny).toFixed(3)) + " · " + rsiTok(r.cost.totalTokens) + " tok"
    : "";
  var chip = info.count ? info.count + " 条结果" + (info.watch ? " · " + info.watch + " 条待关注" : "") : "";
  var mid = String(r.mechanismId || "");
  return '<div class="srf-card st-' + meta.cls + '"' + (mid ? ' data-idedetail="dream" data-id="' + supEsc(mid) + '"' : "") + ' title="' + supEsc((info.lead || "机制运行") + (info.sub ? " — " + info.sub : "")) + '">' +
    '<div class="srf-card-h"><span class="sup-badge ' + meta.cls + '">' + meta.label + '</span>' +
    '<span class="srf-ct">' + supEsc(supClip(String(r.title || mid || "机制"), 30)) + '</span>' +
    '<span class="srf-meta">' + supEsc(when + cost) + '</span></div>' +
    ((chip || info.lead) ? '<div class="srf-cs">' + (chip ? '<span class="srf-chip">' + supEsc(chip) + '</span>' : "") + (info.lead ? '<span class="srf-lead">' + supEsc(info.lead) + '</span>' : "") + '</div>' : "") +
    (info.sub ? '<div class="srf-cd">' + supEsc(supClip(info.sub, 110)) + '</div>' : "") + '</div>';
}
/** 时长文案:毫秒 → 分钟(向下取整);不足 1 分钟或非法值一律「刚刚」(不显示「0 分钟」)。 */
function supDurText(ms) {
  var n = Number(ms);
  if (!(n > 0)) return "刚刚";
  var m = Math.floor(n / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟";
  var h = Math.floor(m / 60), rest = m % 60;
  return h + " 小时" + (rest ? " " + rest + " 分钟" : "");
}
/** 派发任务时间文案:排队/运行=已运行(now-createdAt);终态=用时(updatedAt-createdAt)。
 * 条目自带 createdAt/updatedAt 优先;历史回放条目缺字段时回退 supState.dispatch 同 taskId(本文件内同源)。 */
function supTaskElapsedText(r) {
  var src = (supState.dispatch || {})[String((r && r.taskId) || "")] || {};
  var st = String((r && r.state) || src.state || "");
  var created = Number((r && r.createdAt) || src.createdAt || 0);
  if (!(created > 0)) return "";
  var d;
  if (st === "queued" || st === "running") {
    d = supDurText(Date.now() - created);
    return d === "刚刚" ? d : "已运行 " + d;
  }
  if (st === "done" || st === "failed" || st === "cancelled") {
    var end = Number((r && r.updatedAt) || src.updatedAt || 0);
    if (!(end > 0) || end < created) return "";
    d = supDurText(end - created);
    return d === "刚刚" ? d : "用时 " + d;
  }
  return "";
}
function supTaskCardHtml(r) {
  var meta = supResultMeta(r);
  var title = supCleanText(r.title, 60) || "任务";
  var hasNotice = r.noticeText !== undefined && r.noticeText !== null && String(r.noticeText) !== "";
  var np = hasNotice ? supNoticeParse(String(r.noticeText)) : null; // 通知正文去掉「[系统通知] 任务「…」已完成:」壳
  var summary = supCleanText(np && np.summary ? np.summary : (hasNotice ? r.noticeText : r.summary), 150);
  var terminal = r.state === "done" || r.state === "failed" || r.state === "cancelled";
  var when = terminal && r.updatedAt ? supWhen(r.updatedAt) : (r.ts ? supWhen(r.ts) : ""); // 终态显示任务完成时间,不是重建时刻
  var metaText = when + (r.projectId ? " · " + r.projectId : "");
  var dur = supTaskElapsedText(r);
  var durCls = dur.indexOf("已运行") === 0 ? "run" : "ok";
  return '<div class="srf-card st-' + meta.cls + '"' + (r.taskId ? ' data-idedetail="task" data-id="' + supEsc(r.taskId) + '"' : "") + ' title="' + supEsc(summary) + '">' +
    '<div class="srf-card-h"><span class="sup-badge ' + meta.cls + '">' + meta.label + '</span>' +
    '<span class="srf-ct">' + supEsc(supClip(title, 32)) + '</span>' +
    (dur ? '<span class="srf-dur ' + durCls + '">' + supEsc(dur) + '</span>' : "") +
    '<span class="srf-meta">' + supEsc(metaText) + '</span></div>' +
    '<div class="srf-cs"><span class="srf-chip rel">Super → Coding</span>' + (summary ? '<span class="srf-lead">' + supEsc(summary) + '</span>' : '<span class="srf-lead" style="color:var(--faint)">等待 Coding Agent 回执…</span>') + '</div></div>';
}
function supNoticeRowHtml(r) {
  var p = supNoticeParse(r.summary);
  var meta = supResultMeta({ state: p.state || r.state || "" });
  var title = p.title || supCleanText(r.title, 40) || "系统通知";
  var when = r.ts ? supWhen(r.ts) : "";
  return '<div class="srf-row"' + (r.taskId ? ' data-idedetail="task" data-id="' + supEsc(r.taskId) + '"' : "") + ' title="' + supEsc(p.summary) + '">' +
    '<span class="sup-badge ' + meta.cls + '">' + meta.label + '</span>' +
    '<span class="srf-t">' + supEsc(supClip(title, 26)) + '</span>' +
    '<span class="srf-s">' + supEsc(p.summary || "无结果摘要") + '</span>' +
    '<span class="srf-m">' + supEsc(when) + '</span></div>';
}
function supRenderResults() {
  var box = $("superResultFeed");
  if (!box) return;
  var all = supState.results || [];
  if (!all.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  var dreams = [], tasks = [], others = [], i, r;
  for (i = 0; i < all.length; i++) {
    r = all[i] || {};
    if (r.kind === "dream") dreams.push(r);
    else if (r.kind === "task") tasks.push(r);
    else others.push(r);
  }
  var byTs = function (a, b) { return (b.ts || 0) - (a.ts || 0); };
  dreams.sort(byTs); tasks.sort(byTs); others.sort(byTs);
  var html = ['<div class="srf-h"><span class="srf-ht">结果</span><span class="srf-sub">机制体检与派发任务的产出 · 点一项看详情</span></div>'];
  if (tasks.length) { // 派发任务优先:用户最关心「Super 交给了 Coding Agent 什么、回执是什么」
    html.push('<div class="srf-group"><div class="srf-gh">派发任务 <b>' + tasks.length + '</b><span>Super → Coding Agent 的执行与回执</span></div>');
    for (i = 0; i < tasks.length && i < 8; i++) html.push(supTaskCardHtml(tasks[i]));
    html.push('</div>');
  }
  if (dreams.length) {
 // 每个机制只显示最近一次运行(历史运行在机制详情里);避免同一机制多轮结果把信息流刷爆
    var seenMech = Object.create(null), dLatest = [];
    for (i = 0; i < dreams.length; i++) {
      var dmid = String(dreams[i].mechanismId || dreams[i].key || ("d" + i));
      if (!seenMech[dmid]) { seenMech[dmid] = 1; dLatest.push(dreams[i]); }
    }
    html.push('<div class="srf-group"><div class="srf-gh">机制体检 <b>' + dLatest.length + '</b><span>每个机制最近一次运行产出了什么' + (dreams.length > dLatest.length ? "(共 " + dreams.length + " 次运行)" : "") + '</span></div>');
    for (i = 0; i < dLatest.length; i++) html.push(supDreamCardHtml(dLatest[i]));
    html.push('</div>');
  }
  if (others.length) {
    var shown = Math.min(others.length, 10), rest = others.length - shown;
    html.push('<details class="srf-other"><summary>其他任务动态 <b>' + others.length + '</b><span>系统里所有任务的完成通知(不影响体检结论)</span></summary>');
    for (i = 0; i < shown; i++) html.push(supNoticeRowHtml(others[i]));
    if (rest > 0) html.push('<div class="srf-more">还有 ' + rest + ' 条更早的动态未显示(只列最近 10 条)</div>');
    html.push('</details>');
  }
  box.innerHTML = html.join("");
  box.style.display = "";
}
function pushSuperResult(entry) {
  if (!entry || !entry.kind) return;
  var key = String(entry.key || (entry.kind + ":" + (entry.taskId || entry.runId || entry.ts || Date.now())));
  entry.key = key;
  entry.ts = entry.ts || Date.now();
  var arr = supState.results || (supState.results = []);
 // 任务行出现时吸收同 taskId 的通知行(通知先到也没关系,不产生两行)
  if (entry.kind === "task" && entry.taskId) {
    var tid = String(entry.taskId);
    for (var n = 0; n < arr.length; n++) {
      if (arr[n].kind === "notice" && String(arr[n].taskId || "") === tid) {
        if (entry.noticeText === undefined) entry.noticeText = String(arr[n].summary || "");
        if (entry.noticeAt === undefined) entry.noticeAt = arr[n].noticeAt || arr[n].ts || Date.now();
        if (supState.dispatch && supState.dispatch[tid]) supState.dispatch[tid].noticeAt = entry.noticeAt;
        arr.splice(n, 1);
        break;
      }
    }
  }
  var idx = -1;
  for (var i = 0; i < arr.length; i++) if (String(arr[i].key) === key) { idx = i; break; }
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], entry);
  else arr.unshift(entry);
  if (arr.length > 60) arr.length = 60;
  supRenderResults();
}
function supSetResults(entries) {
  var list = Array.isArray(entries) ? entries : [], map = Object.create(null), out = [], i, e;
  for (i = 0; i < list.length; i++) {
    e = list[i];
    if (!e || !e.key) continue;
    if (map[e.key] !== undefined) out[map[e.key]] = Object.assign({}, out[map[e.key]], e);
    else { map[e.key] = out.length; out.push(e); }
  }
 // 通知→任务合并:同 taskId 的通知只保留正文挂到任务行;RSI 机制任务的通知由「机制体检」行代表(丢弃)。
  var taskIdx = Object.create(null), noticeIdx = Object.create(null), keep = [];
  for (i = 0; i < out.length; i++) if (out[i].kind === "task" && out[i].taskId) taskIdx[String(out[i].taskId)] = i;
  for (i = 0; i < out.length; i++) {
    e = out[i];
    if (e.kind === "notice") {
      var txt = String(e.summary || ""), tid = String(e.taskId || "");
      if (/\\[RSI\\]/.test(txt)) continue; // 机制运行有 dream 行(含成本/摘要),通知是重复的
      if (tid && taskIdx[tid] !== undefined) {
        out[taskIdx[tid]].noticeText = txt;
        out[taskIdx[tid]].noticeAt = e.ts || Date.now();
        if (e.state) out[taskIdx[tid]].state = e.state;
        if (supState.dispatch && supState.dispatch[tid]) supState.dispatch[tid].noticeAt = out[taskIdx[tid]].noticeAt;
        continue;
      }
      if (tid) { // 同一任务的多条通知:后到(时间更新)覆盖先到
        if (!supState.pendingNoticeAt) supState.pendingNoticeAt = {}; // 任务行还没重建→暂存,rehydrate merge 时补
        if (!supState.pendingNoticeAt[tid]) supState.pendingNoticeAt[tid] = e.ts || Date.now();
        if (noticeIdx[tid] !== undefined) { out[noticeIdx[tid]] = e; continue; }
        noticeIdx[tid] = keep.length;
      }
    }
    keep.push(e);
  }
  keep.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  supState.results = keep.slice(0, 60);
  supRenderResults();
}
/** 派发卡:submittedBy=super 的任务(queued/running/终态;点卡跳目标 session)。 */
function supDispatchCardHtml(t) {
  const st = String(t.state || "?");
  const mark = st === "running" ? "▶" : st === "queued" ? "… " : st === "done" ? "✓" : st === "failed" ? "✗" : "·";
  const summary = st === "done" || st === "failed" ? supClip(String(t.result || t.title || ""), 180) : supClip(String(t.title || t.instruction || ""), 90);
  return '<div class="sup-dispatch st-' + supEsc(st) + '" data-supact="open" data-sid="' + supEsc(t.sessionId || "") + '" title="' + supEsc(t.title || "") + ' · ' + supEsc(st) + '">' +
    '<div class="sup-dispatch-h"><span class="sup-badge ' + supEsc(st) + '">' + mark + " 派发 " + supEsc(st) + '</span>' +
    '<span class="sup-it">' + supEsc(supClip(String(t.title || t.instruction || "(未命名)"), 70)) + "</span>" +
    '<span class="sup-mono">' + supEsc(supHhmm(t.updatedAt)) + "</span></div>" +
    (summary ? '<div class="sup-sum">' + supEsc(summary) + "</div>" : "") +
    '<div class="sup-dispatch-f">点击打开目标会话 ' + supEsc(t.sessionId || "") +
    (t.id ? ' · <button class="sup-btn" data-idedetail="task" data-id="' + supEsc(t.id) + '">详情→</button>' : "") + "</div></div>";
}
/** 派发任务实时帧:task.changed/task.submitted 里 submittedBy=super 的任务 → 派发卡(去重按 taskId+state)。 */
function supTrackDispatch(m) {
  const t = m && m.task;
  if (!t || String(t.submittedBy || "") !== "super") return;
  const id = String(t.id || "");
  if (!id) return;
  if (!supState.dispatch) supState.dispatch = {};
  const prev = supState.dispatch[id];
  const stateNow = String(t.state || "?");
 // task.changed 只带索引:必须 merge 不能整体替换,否则会把 noticeAt / instruction / result
 // (super.notice / task.detail.result 先到)冲掉—— 真实协作测试注意。
  const merged = Object.assign({}, prev || {}, t);
  if (supState.pendingNoticeAt && supState.pendingNoticeAt[id]) { merged.noticeAt = supState.pendingNoticeAt[id]; delete supState.pendingNoticeAt[id]; }
  supState.dispatch[id] = merged;
  if (prev && String(prev.state) === stateNow) { // 同态只刷新(正文/noticeAt 已由 merge 保留)
    if (superIdeSel.task === id) { const box = $("superMainTask"); if (box) box.innerHTML = superIdeTaskDocHtml(id); }
    return;
  }
  supTaskHistPush(id, stateNow, merged.updatedAt); // 状态轨迹(任务详情时间线)
 // 索引帧只带列表字段:首次现取正文;终态必须再取一次(运行中那次没有 result)
  if (!supState.detailAsked) supState.detailAsked = {};
  const terminalNow = stateNow === "done" || stateNow === "failed" || stateNow === "cancelled";
  const asked = supState.detailAsked[id];
  if (!asked || (terminalNow && asked !== stateNow)) {
    supState.detailAsked[id] = terminalNow ? stateNow : 1;
    wsSafeSend(JSON.stringify({ v: 1, type: "task.detail.get", taskId: id }));
  }
  pushSuperResult({ kind: "task", taskId: id, title: String(merged.title || merged.instruction || "(未命名)"), state: stateNow, summary: String(merged.result || merged.title || merged.instruction || ""), sessionId: String(merged.sessionId || ""), projectId: String(merged.projectId || ""), createdAt: merged.createdAt || 0, updatedAt: merged.updatedAt || 0, ts: Date.now(), key: "task:" + id });
  supIdeSideRender(); // 侧栏任务列表同帧刷新
  supChatHeadSync(); // 聊天窗头部「派发中 N 个任务」同帧
  supRunAfterTaskChange(); // 指挥状态条:已委托/已交付(非轮次内)
  if (superIdeSel.task === id) { const box = $("superMainTask"); if (box) box.innerHTML = superIdeTaskDocHtml(id); } // 中栏详情开着=同帧重渲
}
/** 消息头:身份+时间(用户右侧,Super 左侧;系统/转接有独立署名)。 */
function supMsgHead(kind, ts) {
  var when = ts ? supHhmm(ts) : "";
  if (kind === "u") return '<div class="sup-msg-h"><span class="sup-who">你</span><span class="sup-time">' + supEsc(when) + "</span></div>";
  if (kind === "sys") return '<div class="sup-msg-h"><span class="sup-who">系统</span><span class="sup-time">' + supEsc(when) + "</span></div>";
  if (kind === "relay") return '<div class="sup-msg-h"><span class="sup-who">Coding Agent 提问 · 经 Super 转述</span><span class="sup-time">' + supEsc(when) + "</span></div>";
  return '<div class="sup-msg-h"><span class="sup-ava">S</span><span class="sup-who">Super Agent</span><span class="sup-time">' + supEsc(when) + "</span></div>";
}
/** 任务 id 前缀(8 位)→ 完整 id(派发卡/结果流同源;找不到返回空,文案降级)。 */
function supFindDispatchByPrefix(p) {
  var d = supState.dispatch || {}, pre = String(p || "");
  if (!pre) return "";
  for (var k in d) if (String(k).indexOf(pre) === 0) return String(k);
  return "";
}
/** 派发关系条:聊天里只报「Super → Coding Agent + 任务号」,结果仍在中栏。 */
function supRelMarker(c, res) {
  if (!c || String(c.name || "") !== "spawn_task") return "";
  var txt = String(res && res.content || "");
  var m = txt.match(/已派出任务\\s+([0-9a-f]{8})/i);
  var pre = m ? m[1] : "";
  var tid = supFindDispatchByPrefix(pre);
  return '<div class="sup-rel"' + (tid ? ' data-idedetail="task" data-id="' + supEsc(tid) + '"' : "") + ">" +
    '<span class="sup-rel-node">Super</span><span class="sup-rel-arrow">→</span><span class="sup-rel-node">Coding Agent</span>' +
    (pre ? '<span class="sup-rel-id">任务 ' + supEsc(pre) + "</span>" : "") +
    '<span class="sup-rel-note">' + (tid ? "点开看任务与结果 →" : "结果在中栏「派发任务」") + "</span></div>";
}
/** Super 轮次流式 live 气泡:与主聊天同款 task-reply/think-card,只更新 #supLiveStream,不整窗重渲。 */
var supStreamTimer = 0;
function supStreamSync() {
  var body = document.getElementById("superChatBody");
  if (!body) return;
  var s = supState.stream;
  var old = document.getElementById("supLiveStream");
  if (!s || (!s.text && !s.reasoning && !s.tool)) { if (old) old.remove(); return; }
  var html = "";
  if (s.reasoning) html += '<details class="think-card" open><summary>思考中…</summary><div class="th-body">' + sketchifyHtml(hl(esc(String(s.reasoning).slice(0, 4000)), "")) + "</div></details>";
  if (s.tool) html += '<div class="sys-line">调用 ' + esc(String(s.tool)) + " …</div>";
  if (s.text) html += replyBlockHtml({ kind: "message.agent", sessionId: "super", payload: { text: s.text }, time: Date.now() }, "");
  if (!html) { if (old) old.remove(); return; }
  var el = old || document.createElement("div");
  el.id = "supLiveStream"; el.className = "sup-live";
  el.innerHTML = html;
  if (!old) body.appendChild(el);
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 120) body.scrollTop = body.scrollHeight;
}
/** 流式帧(server: streamRelay.push("super", ev)):llm-begin/delta/end + tool-begin/end。 */
function supOnStream(ev) {
  var t = String(ev && ev.type || "");
  if (t === "llm-begin") { supState.stream = { text: "", reasoning: "", tool: "", at: Date.now() }; supRunPhase("研判中", "正在理解指令"); }
  else {
    var s = supState.stream || (supState.stream = { text: "", reasoning: "", tool: "", at: Date.now() });
    if (t === "llm-delta") { if (ev.text) s.text += String(ev.text); if (ev.reasoning) s.reasoning += String(ev.reasoning); }
    else if (t === "tool-begin") {
      s.tool = String(ev.name || "");
      if (supState.run && supState.run.active) {
        var steps = supState.run.steps || (supState.run.steps = []);
        steps.push({ name: String(ev.name || ""), verb: supToolVerb(ev.name), done: false });
        if (steps.length > 4) steps.shift();
      }
      supRunPhase(String(ev.name) === "spawn_task" ? "委托中" : "调度中", "正在" + supToolVerb(ev.name));
    }
    else if (t === "tool-end") {
      if (!s.tool || s.tool === String(ev.name || "")) s.tool = "";
      if (supState.run && Array.isArray(supState.run.steps)) {
        for (var si = supState.run.steps.length - 1; si >= 0; si--) {
          if (String(supState.run.steps[si].name || "") === String(ev.name || "") && !supState.run.steps[si].done) { supState.run.steps[si].done = true; break; }
        }
      }
      supRunPhaseAfter(700, "研判中", "工具完成 · 继续研判");
    }
    else if (t === "llm-end") { if (ev.text) s.text = String(ev.text); supRunPhase("研判中", "正在撰写回复"); }
  }
  if (supStreamTimer) return;
  supStreamTimer = setTimeout(function () { supStreamTimer = 0; supStreamSync(); }, 80);
}
/** 同名连续工具调用聚合卡(sys_provider×4 连通探测不再竖排刷屏)——
 * 头部=动词 ×N + 各次耗时;展开体= 起逐次全部结果(第 k 次 details,最后一次默认展开)。 */
function supToolAggCard(name, calls) {
  const verb = supToolVerb(name).replace(/^调用 /, "");
  const results = calls.map((c) => supToolResOf(c));
  const done = results.filter(Boolean).length;
  const anyErr = results.some((r) => r && toolResIsErr(name, r.content));
  const durs = results.map((r) => Number((r || {}).durationMs || 0));
  const total = durs.reduce((a, b) => a + b, 0);
  const durTxt = total > 0 ? " · " + (total >= 6000 ? fmtDur(total) : total + "ms") : "";
  const stCls = done < calls.length ? "tc-run" : anyErr ? "tc-err" : "tc-ok";
  const stTxt = done < calls.length ? "进行中 " + done + "/" + calls.length : anyErr ? "部分失败" : "全部完成";
  const detK = "tool-agg:" + name + ":" + calls.length;
  let body = "";
  for (let i = 0; i < calls.length; i++) {
    const r = results[i];
    const inner = r ? toolResultBody(name, calls[i].arguments, r.content, "", null, false) : '<div class="tr-empty">执行中,结果未返回…</div>';
    body += '<details class="tr-more' + (i === calls.length - 1 ? " agg-last" : "") + '"' + (i === calls.length - 1 ? " open" : "") + '><summary>第 ' + (i + 1) + " 次 · " + durs[i] + "ms</summary>" + inner + "</details>";
  }
  if (!body) body = '<div class="tr-empty">执行中,结果未返回…</div>';
  return '<details class="tool-card" data-det-key="' + supEsc(detK) + '"><summary>' +
    '<span class="tc-verb" title="' + supEsc(name) + ' ×' + calls.length + '">» ' + supEsc(verb) + " ×" + calls.length + "</span>" +
    '<span class="tc-args">' + supEsc(durs.join("/")) + "ms</span>" +
    '<span class="tc-state ' + stCls + '">' + stTxt + durTxt + "</span></summary>" +
    '<div class="tc-body">' + body + "</div></details>";
}
function supRenderChat() {
  const body = document.getElementById("superChatBody");
  if (!body) return;
  const html = [];
  let lastDay = "";
  const evs = supState.entries;
  for (let i = 0; i < evs.length; i++) {
    const t = evs[i];
    if (t.kind === "day") { if (t.text !== lastDay) { html.push('<div class="sup-day">' + supEsc(t.text) + "</div>"); lastDay = t.text; } continue; }
    if (t.kind === "u") {
 // 与 coding agent 主聊天同款:用户气泡(你 chip + 正文),无额外角色行
      html.push('<div class="user-line"><span class="who">你</span><span class="txt">' + userSlashHtml(String(t.text || ""), "") + "</span></div>");
    } else if (t.kind === "a") {
 // 同一轮可能有多条 assistant 事件(工具轮 + 终稿):合成一个回合,但渲染与主聊天一致(无角色头)
      const group = [t];
      while (i + 1 < evs.length && evs[i + 1] && evs[i + 1].kind === "a") { group.push(evs[i + 1]); i++; }
      for (const m of group) {
        if (m.reasoning && settings.thinking === "on" && settings.mode !== "office") { // 思考卡(主聊天同款,非 office)
          html.push('<details class="think-card"><summary>思考 · ' + Math.max(1, Math.round(Number(m.llmMs || 0) / 1000)) + 's</summary><div class="th-body">' + sketchifyHtml(hl(esc(String(m.reasoning).slice(0, 4000)), "")) + "</div></details>");
        }
        if (Array.isArray(m.toolCalls) && m.toolCalls.length) {
 // 同名连续调用聚合(≥2 张合并为一张 ×N 卡);spawn_task 不聚合(每次派发都是独立关系条)
          const runs = [];
          for (const c of m.toolCalls) {
            const nm = String((c || {}).name || "");
            const prev = runs[runs.length - 1];
            if (prev && prev.name === nm && nm !== "spawn_task") prev.calls.push(c);
            else runs.push({ name: nm, calls: [c] });
          }
          for (const run of runs) {
            if (run.calls.length > 1) { html.push(supToolAggCard(run.name, run.calls)); continue; }
            const c = run.calls[0];
            const cres = supToolResOf(c);
            html.push(toolCallCard(c, "", cres, null, null)); // 工具调用+结果合并卡(主聊天同款)
            const rel = supRelMarker(c, cres); // spawn_task → Super→Coding Agent 关系条(不搬结果)
            if (rel) html.push(rel);
          }
        }
        if (m.text) html.push(replyBlockHtml({ kind: "message.agent", sessionId: "super", payload: m, time: m.ts }, "")); // assistant markdown(主聊天同款)
      }
    } else if (t.kind === "sys") {
      const sysText = String(t.text || "");
      const sysLong = sysText.length > 160; // 长系统通知默认折叠,避免刷屏挤掉真正的对话
      html.push('<div class="sys-line' + (sysLong ? " sys-long" : "") + '"' + (sysLong ? ' title="点击展开/收起"' : "") + ">" + sketchifyHtml(esc(sysText)) + "</div>");
    }
    else if (t.kind === "relay") html.push('<div class="sup-bub sys">' + supEsc(supClip(String(t.text || ""), 400)) + '<div class="sup-mono" style="margin-top:3px">在下方直接回复,或点聊天头顶部「待你处理」;口头答复也可以直接发给我</div></div>');
  }
  if (supState.waiting) html.push('<div class="sup-wait" id="supWait">Super 正在思考…(调度轮可能含多次工具调用)</div>');
  if (!html.length) html.push('<div class="sup-empty">还没有对话。直接对我说:查任务状态、派任务、或安排一次跨项目联调。<br>派出的任务会在中栏「派发任务」跟踪,完成/失败会回执到这里和结果流。示例:<div class="sup-quick"><button data-supquick="现在系统里有哪些活跃任务?">查活跃任务</button><button data-supquick="简单汇报一下最近 12 小时的机制体检结果">今日体检</button><button data-supquick="帮我派一个任务:">派任务</button></div></div>');
  const wasBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60; // 粘底跟随(主聊天同款 60px 容差)
  body.innerHTML = html.join("");
  if (supState.revealReplyTop) {
 // 终稿定位——回复比窗高时翻到**回复开头**(结论在头上;流式期仍钉底跟随),
 // 画布卡/经典窗通用;比视口矮时维持钉底(全可见,不用跳)。
    supState.revealReplyTop = false;
    const r = body.querySelectorAll(".task-reply");
    const last = r.length ? r[r.length - 1] : null;
    if (last && last.offsetHeight > body.clientHeight - 40) body.scrollTop = last.offsetTop - 8;
    else body.scrollTop = body.scrollHeight;
  } else if (wasBottom) body.scrollTop = body.scrollHeight;
  supStreamSync(); // 整窗重渲后保留/重建流式 live 气泡
  supChatHeadSync(); // 头部状态:空闲/思考中/等你回答/派发中
  var latest = document.getElementById("superChatLatest");
  if (latest) latest.classList.toggle("on", !wasBottom && body.scrollHeight - body.clientHeight > 80);
}
/** 工具结果预扫(主聊天 fixH12 同语义):supHist 里找 toolCallId 对应结果,调用点即见结果。 */
function supToolResOf(c) {
  const cid = String((c || {}).id || "");
  if (!cid) return null;
  const evs = supState.entries;
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (!e || !Array.isArray(e.toolResults)) continue;
    for (const r of e.toolResults) if (String((r || {}).toolCallId || "") === cid) return { name: String(r.name || ""), content: String(r.content || ""), durationMs: Number(r.durationMs || 0) };
  }
  return null;
}
/** 视图外观态:经典布局的单屏显隐 + team 卡内部子标签(.on 在画布形态下不影响显示)。
 * 显隐清单由 CLASSIC_VIEWS(= CV_VIEW_OF_CARD 派生)供给,新增卡片不必再改这里。 */
function applyViewChrome(name) {
  if (arcOpen && name !== "project") arcClose(); // 设计沉淀灯箱只在档案视图存活;离开即收并恢复大白板宿主
  for (const v of CLASSIC_VIEWS) {
    const el = $("view-" + v);
    if (!el) continue; // 派生清单里可能的无宿主项(如子标签别名)不炸:跳过而非 null.classList
    let on = (name === "chat" && v === "tasks") || name === v || ((name === "dash" || name === "issues") && v === "team") || (name === "rsi" && v === "super");
 // 双中心:右栏开启时 IDE 与当前视图并列常驻(任务流在左,IDE 在右)
    if (dualOpen && v === "ide" && name === "chat") on = true;
    el.classList.toggle("on", on);
  }
  $("teamPaneMembers").style.display = name === "dash" || name === "issues" ? "none" : ""; // 成员面板与看板/Issue 面板互斥
  $("teamPaneIssues").style.display = name === "issues" ? "flex" : "none"; // fixD5:Issue 看板面板随子标签切换
  $("view-team").classList.toggle("tab-dash", name === "dash"); // 头部控件随标签切换(team-only/dash-only)
  $("view-team").classList.toggle("tab-issues", name === "issues"); // fixD5:issue-only 控件同机制
 // IDE 三栏:rsi/dream/task 别名收敛进 super 单视图(旧三段导航 superSeg* 退役)。
 // rsi 别名保留(侧栏 act-rsi/旧书签仍可达);rsiPollSync 跟随 super 视图启停(做梦区轮询不停摆)。
  if (name === "rsi" || name === "dream" || name === "task") name = "super";
  $("teamTabMembers").classList.toggle("on", name === "team");
  $("teamTabIssues").classList.toggle("on", name === "issues"); // fixD5
  $("teamTabDash").classList.toggle("on", name === "dash");
  rsiPollSync(name); // RSI 轮询随视图进出启停(非 rsi 一律 clearInterval,防后台空转)
 // wiki 并入代码档案(product decision):tab 态决定指挥台让位
  document.body.classList.toggle("pp-wiki-tab", name === "project" && projectTab === "wiki");
}
/** 视图数据拉取/渲染补位:画布形态的懒激活只走这一段(只拉数,不改身份、不动单屏显隐)。
 * n6:入参 sid=本次取数归属的会话(缺省=当前选中会话);会话相关取数一律以入参为准,
 * 不再隐式读全局 currentSid——否则切会话后重载会把「上一会话」的 id 又发出去。 */
function loadViewData(name, sid) {
  const s = sid === undefined ? currentSid : sid;
  if (name === "issues") issueBoardLoad(false); // fixD5:进入即拉(多项目 issue.list + P2P 状态)
  if (name === "dash") { dashLockScope(); dashLoad(); } // 看板子标签:进入即锁定当前项目+拉会话/趋势
  if (name === "board") { setTimeout(wbResize, 30); boardRefresh(s); overlayPull(s); } // 可见后再量尺寸(canvas 隐藏态 rect 为 0);拉板清单+会话批注
  if (name === "team") { wsSafeSend(JSON.stringify({ v: 1, type: "team.status" })); }
  if (name === "approvals") { wsSafeSend(JSON.stringify({ v: 1, type: "permission.pending" })); wsSafeSend(JSON.stringify({ v: 1, type: "permission.history", limit: 20 })); } // 挂起+最近决定一起拉
  if (name === "nodes") { wsSafeSend(JSON.stringify({ v: 1, type: "nodes.list" })); }
  if (name === "super" || name === "rsi" || name === "dream" || name === "task") superViewLoad(); // →1545:指挥台(别名 rsi/dream/task 同指;聊天回放+任务/做梦侧栏刷新)
  if (name === "subchat") subMsgRender(); // 子agent会话流卡:进入即重渲(卡可见=分组已读,未读角标清零;含原分身卡的注册态/模型/reap)
  if (name === "track") trackPull(s);
 // 轨迹视图数据全部来自 histEvents(前端已在场的会话重放事件),零额外请求;
 // 进入即重渲一次并自动展开最新决策卡;不锁 body 滚动、不改视图身份(身份由 class 显隐统一管)。
  if (name === "traj") { trajBoardInitDone = false; trajBoardRefresh(); }
 // usage.view 协议无 session 参数(服务端按 模型×会话 全量聚合,此次不改服务端):
 // 前端按当前会话过滤展示 + 卡头标注作用域,避免用户把全局数当成当前会话的账。
  if (name === "usage") { usageScopeSid = s || ""; wsSafeSend(JSON.stringify({ v: 1, type: "usage.view" })); }
  if (name === "git") gitLoad();
  if (name === "project") revStoreLoad(); // 代码档案视图打开时拉评审遗留(openProfileEntry 入口)
  if (name === "wf") wsSafeSend(JSON.stringify({ v: 1, type: "automation.list" }));
  if (name === "market") wsSafeSend(JSON.stringify({ v: 1, type: "plugins.list" }));
  if (name === "sys" && settingsSection === "guide") guideRender();
  if (name === "term") setTimeout(() => $("termInput").focus(), 30);
  if (name === "files") filesLoad();
  if (name === "ide") ideLoad();
  if (name === "project" && projectTab === "wiki") wikiLoad();
  if (name === "browser") { brMount(); brSubscribe(); } // 内置浏览器:首次进入挂载视图资产 + 自动订阅一次截图流
}
// 复刻 startNewTaskFromActiveWorkspace: activeTaskId=null → 草稿态 + 焦点 composer
function newDraft() {
  currentSid = null; sessionStorage.removeItem("zh:sid"); localStorage.removeItem("zh:sid");
 // 会话域 UI 归零:与 openSession 共用同一份清单(resetSessionDomainUI)——草稿态此前只清了
 // chatStatusbar 与几处水位,子代理流/未读、白板会话上下文、徽标(子代理/上下文/目标)、
 // 问答条、附件条、指令 chip 全残留上一会话(用户用户反馈「新建任务时所有按钮/数据显示要重置」)。
  resetSessionDomainUI("");
 // 输入区会话域件归零(草稿文本本身由 restoreDraft 按 zh:draft:* 恢复,存储语义不变)
  askRenderBar();
  pendingAtts = []; attRender();
  inChip = null; cmdChipUpdate();
  subWsRestore(""); // 草稿态无会话:工作区 tab 清空归位(主会话)
  navPush("");
  switchView("chat");
  renderChat(); renderSidebar();
  restoreDraft();
  voiceStashApply(); // 语音任务书:草稿态同样应用暂存结果(lockKey=__new__)
  renderSendBtn();
  onSessionChange(""); // n6 草稿态=无会话:画布卡按空会话作用域重取数(白板/档案回退当前项目)
  $("instruction").focus();
}
// ---- 会话标签页已删(冗余收敛):用户明确不要 tab 条(CSS 硬隐藏),
// tabOpen/tabClose/openTabs/zh:tabs 五件套写 DOM+localStorage 永不可见=纯孤儿。会话切换走侧栏任务行/openSession。
// renderTabs 已随 tabbar 五件套删除(冗余收敛)
// ---- 「已工作 X」运行计时(ZCode TimerBadge 对齐):footer 每 500ms 自更新,不触发重渲染 ----
function tickWorkTimer() {
  const el = $("workTimer");
  if (!el) return;
 // 当前会话运行中任务优先;否则任一运行中任务(全局可见性)。
  const run = [...tasks.values()].filter((t) => t.state === "running" && t.startedAt).sort((a, b) => b.startedAt - a.startedAt);
  const mine = run.find((t) => t.sessionId === currentSid) || run[0];
  if (!mine) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "";
  el.textContent = "计时 " + fmtDur(Date.now() - mine.startedAt);
}
setInterval(() => { tickWorkTimer(); ctxPillRender(); try { supCtxPillRender(); } catch (e) {} }, 500); // super 上下文 pill 同心跳
// ---- 权限模式/思考力度 pill(ZCode 输入区双下拉对齐;点击循环,cfg.set 热生效) ----
const PERM_MODES = [
  { v: "ask", label: "询问每次" },
  { v: "auto", label: "完全访问" },
  { v: "workspace", label: "工作区内" }, // 第五档:只读写当前项目,shell 仍按 ask 审批(与 auto 并列,不覆盖)
  { v: "readonly", label: "只读" },
  { v: "plan", label: "Plan" },
];
const EFFORTS = [
  { v: "", label: "思考:关", menu: "关" },
  { v: "low", label: "思考:低", menu: "低" },
  { v: "medium", label: "思考:中", menu: "中" },
  { v: "high", label: "思考:高", menu: "高" },
  { v: "xhigh", label: "思考:最高", menu: "最高" },
];
let permModeV = localStorage.getItem("zh:perm-mode") || "ask";
let permPriorMode = null; // 切模式前的原值(审计 C10:plan-goal-mutex 拒绝时回滚 pill,防 UI/服务端分歧)
let permPendingMode = null; // 在飞的权限翻转(cfg.set 已发未 ack;cfg-set-failed 时精确回滚,不误伤 effort 等其它补丁)
// 首同步标记(用户用户反馈「每次询问和真实值对不上」):cfg.get 回包前 pill 显示的是
// localStorage 种子(可能已被其他客户端改掉),渲染为半透明「同步中」态;首包到达即转实。
// 若首包值≠种子=服务端被别的面板/测试改过——toast 说明,不再无声翻转让用户以为自己的选择丢了。
let permSynced = false;
const _effSaved = localStorage.getItem("zh:effort");
let effortV = _effSaved === null ? "high" : _effSaved; // 默认高(视频 2;与 schema default 对齐,显式关仍受尊重)
let pillTouched = false; // 用户本轮已手选 effort:cfg.get 回包不再回写显示(防竞态覆盖)
/** u3 档位进度百分比(ZCode ThoughtLevelCycleControl:只算非「关闭」档;关闭/未选=0%)。 */
function effortProgress() {
  const idx = EFFORTS.findIndex((x) => x.v === (effortV || ""));
  if (idx <= 0) return 0; // 关闭档(index 0)=0%;未命中=0%(不把缺失选择投影成首档)
  const thinking = EFFORTS.filter((x) => !!x.v); // 非关闭档:低/中/高/最高
  const hit = EFFORTS[idx];
  return (thinking.indexOf(hit) + 1) / thinking.length * 100;
}
function pillRender() {
  const p = PERM_MODES.find((x) => x.v === permModeV) || PERM_MODES[0];
  const e = EFFORTS.find((x) => x.v === effortV) || EFFORTS[0];
  $("permPill").textContent = p.label;
  $("permPill").classList.toggle("on", permModeV !== "ask");
  $("permPill").classList.toggle("sync", !permSynced);
  $("permPill").title = permSynced ? "权限模式(点击选择,热生效)" : "权限模式:同步服务端真实值中…(本显示为本机上次选择,未必是当前真值)";
 // u3:档位按钮=脑图标 + 竖向进度条 + 档位文案(不再把 effort 拼进模型 pill 文案)
  const eText = $("effortText"); if (eText) eText.textContent = e.menu;
  const eFill = $("effortFill"); if (eFill) eFill.style.height = effortProgress() + "%";
  const eIcon = $("effortIcon"); if (eIcon && !eIcon.firstChild) eIcon.innerHTML = ic("brain");
  const eBtn = $("effortPill");
  if (eBtn) { eBtn.classList.toggle("on", !!effortV); eBtn.setAttribute("aria-label", "思考力度:" + e.menu); }
  renderEffortSeg();
}
/** 设置页思考力度分段器与 composer pill 同源渲染(空串=关)。 */
function renderEffortSeg() {
  const host = $("effortSeg");
  if (!host) return;
  for (const b of host.querySelectorAll("button")) b.classList.toggle("on", (b.dataset.v || "") === (effortV || ""));
  const now = $("effortNow");
  const hit = EFFORTS.find((x) => x.v === effortV) || EFFORTS[0];
  if (now) now.textContent = "当前:" + hit.menu;
}
function pillSendPerm() {
  permPendingMode = permModeV; // 在飞标记(审计 C10/C11:ack 后清;cfg-set-failed 时按它精确回滚)
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { permissions: { mode: permModeV } } }));
  localStorage.setItem("zh:perm-mode", permModeV);
  toast("权限模式 → " + (PERM_MODES.find((x) => x.v === permModeV) || PERM_MODES[0]).label + "(热生效)");
}
function pillSendEffort() {
 // O2:主实施轨 effort 由 coding.llm.implementationEffort 控制(唯一权威;
 // 旧 reasoningEffort 对主轨不再生效)——pill 必须写这个字段,否则「最高/低」变成哑控件。
 // audio.chat 仍走 reasoningEffort(语音轨有自己的 effort 语义)。空串=关(provider.update 归 undefined)。
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { coding: { llm: { implementationEffort: effortV } }, audio: { chat: { reasoningEffort: effortV } } } }));
  localStorage.setItem("zh:effort", effortV);
  toast("思考力度 → " + ((EFFORTS.find((x) => x.v === effortV) || EFFORTS[0]).label) + "(热生效;主实施轨 implementationEffort)");
}
$("permPill").onclick = () => {
 // 菜单化(视频 2:「切换模式」要对齐 ZCode 的模式下拉,不再循环点击)
  const cur = (PERM_MODES.find((x) => x.v === permModeV) || PERM_MODES[0]).label;
  pillMenuOpen($("permPill"), [{ items: PERM_MODES.map((x) => ({ value: x.label })) }], cur, (picked) => {
    const hit = PERM_MODES.find((x) => x.label === picked);
    if (!hit || hit.v === permModeV) return;
    permPriorMode = permModeV;
    permModeV = hit.v;
    pillRender(); pillSendPerm();
  });
};
$("effortPill").onclick = () => {
 // u3:档位按钮点击开档位列表(沿用 pillMenuOpen 容器机制:向上展开、side=top 对齐);
 // 单档模型(EFFORTS.length===1)渲染成非交互控件,不弹层。
  if (EFFORTS.length <= 1) return;
  const cur = (EFFORTS.find((x) => x.v === effortV) || EFFORTS[0]).menu;
  pillMenuOpen($("effortPill"), [{ items: EFFORTS.map((x) => ({ value: x.menu, sub: x.v === "" ? "请求不带参数" : "" })) }], cur, (picked) => {
    const hit = EFFORTS.find((x) => x.menu === picked);
    if (!hit || hit.v === effortV) return;
    effortV = hit.v; pillTouched = true;
    pillRender(); pillSendEffort();
  });
};
// 启动即渲染(补):此前首帧只有静态 HTML 写死的「询问每次」在裸奔(不反映 localStorage,
// 也不带同步中态)——cfg.get 回包前用户看到的就是这个假默认。现在启动即按种子渲染+sync 态。
pillRender();
// 设置页「思考力度」分段器——与 pill 同一 cfg 字段(coding.llm.reasoningEffort + audio.chat 同步)。
$("effortSeg").onclick = (e) => {
  const b = e.target && e.target.closest ? e.target.closest("button[data-v]") : null;
  if (!b) return;
  const v = b.dataset.v || "";
  if (v === effortV) return;
  effortV = v; pillTouched = true;
  pillRender(); pillSendEffort();
};
// ---- 上下文用量 pill(视频 2,对齐 ZCode 上下文容量;数据源=当前会话事件流,粗估) ----
// 口径统一:估算器与服务端同尺(chars/4);三个数字各自标注口径——
// 当前上下文=最近一次 LLM 调用经验证输入;累计消耗=历史全部调用 in+out 求和(≠当前上下文,含每轮重计);
// 字符粗估=chars/4,仅在无经验证时作参考。
function ctxStats() {
  const evs = histEvents || [];
  let users = 0, agents = 0, tools = 0, chars = 0, realIn = 0, realOut = 0, cumIn = 0, cumOut = 0;
  for (const e of evs) {
    const p = e.payload || {};
    if (e.kind === "message.user") { users++; chars += String(p.text || "").length; }
    else if (e.kind === "message.agent") {
      agents++; chars += String(p.text || "").length + String((p.toolCalls || [])).length;
 // 真实用量(数据同源):loop 在 message.agent 记的 LLM usage,inputTokens=当次实际上下文
      const u = p.usage || {};
      if (Number(u.inputTokens) > 0) {
        realIn = Number(u.inputTokens); realOut = Number(u.outputTokens || 0);
        cumIn += Number(u.inputTokens) || 0; cumOut += Number(u.outputTokens) || 0;
      }
    }
    else if (e.kind === "tool.call") { tools++; chars += String(p.arguments || "").length; }
  }
  return { users, agents, tools, chars, est: Math.round(chars / 4), realIn, realOut, cumIn, cumOut };
}
/** 上下文用量(主值 = trace.stats.contextTokens,即 LLM API usage.inputTokens 经验证;本地估算只作次级)。
 * contextTokensEst = 本地估算(「估算 Z(触发用)」);contextEstimated 仅在「压缩后无 API 值」时为真。
 * 旧会话/旧 trace 文件没有这些字段 → 返回 null,调用方逐字回退到 s.realIn 的旧形态(不出 undefined/NaN)。 */
function ctxUsageNorm(sid) {
  const st = (traceStats && sid ? traceStats[sid] : null) || {};
  const main = trajNumOrNull(st.contextTokens);
  const est = trajNumOrNull(st.contextTokensEst);
  return {
    rep: main !== null && main > 0 ? main : null,
    est: est !== null && est > 0 ? est : null,
    estimated: st.contextEstimated === true,
    sus: st.usageSuspect === true,
    anom: typeof st.usageAnomaly === "string" ? st.usageAnomaly : "",
  };
}
/** tok 速览(k/k/M 口径与 pill 既有文案一致)。 */
function ctxTok(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? (Math.round(v / 100) / 10) + "k" : v;
}
function ctxPillRender() {
  const el = $("ctxPill");
  if (!el) return;
  if (!currentSid) { el.textContent = "上下文"; return; }
  const s = ctxStats();
  const win = Number((traceStats[currentSid] || {}).contextWindow) || 0;
  const winTxt = win ? "/" + (win >= 1e6 ? (Math.round(win / 1e5) / 10) + "M" : Math.round(win / 1000) + "k") : "";
  const u = ctxUsageNorm(currentSid);
 // 主值 = API 经验证 usage(contextTokens),文案不带「(估)」;本地估算另附「,估算 Z(触发用)」作次级。
 // 完全没有经验证/估算(旧会话)→ 逐字走旧回落文案。
  const mainTok = u.rep !== null ? u.rep : u.est;
  if (mainTok !== null) {
    const pct = win ? " · " + Math.min(100, Math.round((mainTok / win) * 100)) + "%" : "";
    el.textContent = "上下文 " + (s.users + s.agents) + " 条 · " + ctxTok(mainTok) + " tok" + winTxt + pct
      + (u.rep !== null && u.est !== null ? ",估算 " + ctxTok(u.est) + "(触发用)" : "");
    return;
  }
  const tok = s.realIn ? (s.realIn >= 1000 ? (Math.round(s.realIn / 100) / 10) + "k" : s.realIn) : 0;
  const pct = win && s.realIn ? " · " + Math.min(100, Math.round((s.realIn / win) * 100)) + "%" : "";
  el.textContent = "上下文 " + (s.users + s.agents) + " 条" + (tok ? " · " + tok + winTxt + " tok" + pct : "");
}
/** 上下文 pill 菜单内容(当前上下文=估算/上报双值,上报值作副行;无归一数据时逐字等价旧文案)。 */
function ctxPillMenuHtml(s) {
  const win = Number((traceStats[currentSid] || {}).contextWindow) || 0;
  const u = ctxUsageNorm(currentSid);
  let realLine;
  if (u.rep !== null) {
    realLine = '<div class="pm-item"><span class="pm-ck">' + ic("check") + '</span><span class="pm-name">当前上下文(最近一次调用实测):<b>' + u.rep + "</b> tok"
      + (win ? " / 容量 " + win + " tok = " + Math.min(100, Math.round((u.rep / win) * 100)) + "%" : "")
      + (u.est !== null ? " · 本地估算 " + u.est + " tok(触发用)" : "")
      + (u.sus ? " · 上游 usage 异常" + (u.anom ? "(" + esc(u.anom) + ")" : "") : "") + "</span></div>";
  } else if (u.est !== null) {
    realLine = '<div class="pm-item"><span class="pm-ck">' + ic("check") + '</span><span class="pm-name">当前上下文(压缩后无 API 值,本地估算):<b>' + u.est + "</b> tok(触发用)"
      + (win ? " / 容量 " + win + " tok = " + Math.min(100, Math.round((u.est / win) * 100)) + "%" : "")
      + (u.sus ? " · 上游 usage 异常" + (u.anom ? "(" + esc(u.anom) + ")" : "") : "") + "</span></div>";
  } else {
    realLine = s.realIn
      ? '<div class="pm-item"><span class="pm-ck">' + ic("check") + '</span><span class="pm-name">当前上下文(最近一次调用实测):<b>' + s.realIn + "</b> tok" + (win ? " / 容量 " + win + " tok = " + Math.min(100, Math.round((s.realIn / win) * 100)) + "%" : "") + " · 输出 " + s.realOut + " tok</span></div>"
      : '<div class="pm-item"><span class="pm-ck">·</span><span class="pm-name">暂无实测(等本会话首次模型调用)</span></div>';
  }
  const cumLine = s.cumIn
    ? '<div class="pm-item"><span class="pm-ck">Σ</span><span class="pm-name">累计消耗(全部调用 in+out 求和,≠当前上下文,每轮历史重复计入):' + (s.cumIn + s.cumOut) + " tok</span></div>"
    : "";
  return '<div class="pm-grp"><div class="pm-head">上下文容量(消息 ' + (s.users + s.agents) + " 条 · 工具 " + s.tools + " 次)</div>" +
    realLine + cumLine +
    '<div class="pm-item"><span class="pm-ck">·</span><span class="pm-name">对话字符粗估 ' + s.chars + " ≈" + s.est + " tok(chars/4,无实测时的参考,不含系统提示)</span></div></div>";
}
$("ctxPill").onclick = () => {
  if (!currentSid) { toast("草稿态:发出首条消息后开始累计上下文"); return; }
  const s = ctxStats();
  const el = document.createElement("div");
  el.className = "pill-menu";
  el.innerHTML = ctxPillMenuHtml(s);
  document.body.appendChild(el);
  const r = $("ctxPill").getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + "px";
  el.onclick = () => el.remove();
  pillMenuEl = el;
};
// ---- 使用统计视图(ZCode UsageStatistics 对齐):卡片+趋势柱+热力图+会话表 ----
function statsFetch(force) {
  if (!force && statsCache && Date.now() - statsCache.at < 60_000) return;
  sendOrQueue({ v: 1, type: "stats.summary" });
}
let statsMode = "day"; // day | week | cum(日/周/累计,趋势图切换)
function renderStats() {
  const host = $("statsView");
  if (!host) return;
  if (!statsCache || !statsCache.data) { host.innerHTML = '<div class="cc-empty loading">加载中…</div>'; return; }
  const d = statsCache.data;
  const tt = d.totals;
  const act = d.activity || {};
  const fmtK = (n) => (n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 10000 ? (n / 1e4).toFixed(1) + "万" : String(n));
  let html = '<div class="stat-cards">' +
    '<div class="stat-card"><div class="sc-v">' + tt.tasks + '</div><div class="sc-k">任务(完成 ' + tt.tasksDone + " / 失败 " + tt.tasksFailed + ")</div></div>" +
    '<div class="stat-card"><div class="sc-v">' + fmtK(tt.tokens.total) + '</div><div class="sc-k">累计 Token(输入 ' + fmtK(tt.tokens.input) + " / 输出 " + fmtK(tt.tokens.output) + ")</div></div>" +
    '<div class="stat-card"><div class="sc-v">' + fmtK(act.peakTokens || 0) + '</div><div class="sc-k">峰值 Token(单日)</div></div>' +
    '<div class="stat-card"><div class="sc-v">' + fmtDur(tt.workMs) + '</div><div class="sc-k">累计使用时长</div></div>' +
    '<div class="stat-card"><div class="sc-v">' + (act.currentStreak || 0) + ' 天</div><div class="sc-k">当前连续</div></div>' +
    '<div class="stat-card"><div class="sc-v">' + (act.longestStreak || 0) + ' 天</div><div class="sc-k">最长连续</div></div>' +
    '<div class="stat-card"><div class="sc-v">' + tt.turns + '</div><div class="sc-k">轮次</div></div>' +
    '<div class="stat-card"><div class="sc-v">' + tt.toolCalls + '</div><div class="sc-k">工具调用</div></div>' +
    "</div>";
 // 活跃趋势(近 30 天;日/周/累计 三视图切换)
  const days = d.perDay || [];
  let series = days.map((x) => ({ label: x.day.slice(5), v: x.turns }));
  if (statsMode === "week") {
    const wk = [];
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      wk.push({ label: chunk[0].day.slice(5), v: chunk.reduce((a, b) => a + b.turns, 0) });
    }
    series = wk;
  } else if (statsMode === "cum") {
    let acc = 0;
    series = days.map((x) => { acc += x.turns; return { label: x.day.slice(5), v: acc }; });
  }
  const maxT = Math.max(1, ...series.map((x) => x.v));
  const W = 720, H = 90, bw = W / Math.max(1, series.length);
  let bars = "";
  series.forEach((x, i) => {
    const h = Math.round((x.v / maxT) * (H - 18));
    bars += '<rect x="' + (i * bw + 1) + '" y="' + (H - h - 12) + '" width="' + Math.max(1, bw - 2) + '" height="' + h + '" rx="1" fill="rgba(201,143,69,.65)"><title>' + x.label + " · " + x.v + (statsMode === "cum" ? " 累计轮" : " 轮") + "</title></rect>";
    if (i % Math.max(1, Math.floor(series.length / 6)) === 0) bars += '<text x="' + (i * bw + 1) + '" y="' + (H - 2) + '" font-size="8" fill="#6b5c4a">' + x.label + "</text>";
  });
  html += '<div class="stat-h">近 30 天活跃(轮次)' +
    '<span class="auto-scope" style="display:inline-flex;margin-left:10px">' +
    '<button data-sm="day" class="' + (statsMode === "day" ? "on" : "") + '">每日</button>' +
    '<button data-sm="week" class="' + (statsMode === "week" ? "on" : "") + '">每周</button>' +
    '<button data-sm="cum" class="' + (statsMode === "cum" ? "on" : "") + '">累计</button></span></div>';
  html += '<svg width="' + W + '" height="' + H + '" style="max-width:100%">' + bars + "</svg>";
 // 7×24 热力图
  const days2 = ["日", "一", "二", "三", "四", "五", "六"];
  const maxH = Math.max(1, ...(d.heatmap || []).flat());
  html += '<div class="stat-h">活跃热力图(周×小时)</div><div class="hm-grid">';
  for (let h2 = 0; h2 < 24; h2++) html += '<div class="hm-lab" style="text-align:right">' + h2 + "</div>";
  html += "</div>";
  for (let w = 0; w < 7; w++) {
    html += '<div class="hm-lab">周' + days2[w] + "</div>";
    for (let h2 = 0; h2 < 24; h2++) {
      const v = (d.heatmap[w] || [])[h2] || 0;
      const alpha = v === 0 ? 0.08 : 0.15 + 0.85 * (v / maxH);
      html += '<div class="hm-cell" title="周' + days2[w] + " " + h2 + "时 · " + v + ' 轮" style="background:rgba(201,143,69,' + alpha.toFixed(2) + ')"></div>';
    }
  }
  html += "</div>";
 // 系统健康度:近 N 次 LLM 调用的 decode 速度折线(outputTokens/耗时)。
  const hl = (d.health && d.health.samples) || [];
  if (hl.length) {
    const maxV = Math.max(1, ...hl.map((x) => x.tps));
    const hw = 720, hh = 70;
    const pts = hl.map((x, i) => ((i / Math.max(1, hl.length - 1)) * (hw - 20) + 10).toFixed(1) + "," + (hh - 14 - (x.tps / maxV) * (hh - 24)).toFixed(1)).join(" ");
    html += '<div class="stat-h">系统健康度 · decode 速度(近 ' + hl.length + " 次调用,均 <b>" + (d.health.avgTps || 0) + "</b> tok/s)</div>";
    html += '<svg width="' + hw + '" height="' + hh + '" style="max-width:100%"><polyline points="' + pts + '" fill="none" stroke="rgba(157,192,139,.85)" stroke-width="1.5"/></svg>';
  }
 // 会话表 top20
  html += '<div class="stat-h">会话用量 Top 20</div><table class="stats-table"><tr><th>会话</th><th>任务</th><th>轮次</th><th>LLM</th><th>工具</th><th>token</th><th>最近活跃</th></tr>';
  for (const ss of d.sessions || []) html += "<tr><td>" + esc(ss.sessionId) + "</td><td>" + ss.tasks + "</td><td>" + ss.turns + "</td><td>" + ss.llmCalls + "</td><td>" + ss.toolCalls + "</td><td>" + fmtK(ss.tokens) + "</td><td>" + (ss.lastAt ? new Date(ss.lastAt).toLocaleString() : "-") + "</td></tr>";
  html += "</table>";
 // 模型 / 工具 消耗
  if ((d.byModel || []).length) {
    html += '<div class="stat-h">模型消耗</div><table class="stats-table"><tr><th>模型</th><th>调用</th><th>token</th></tr>';
    for (const mrow of d.byModel) html += "<tr><td>" + esc(mrow.model) + "</td><td>" + mrow.calls + "</td><td>" + fmtK(mrow.tokens) + "</td></tr>";
    html += "</table>";
  }
  if ((d.byTool || []).length) {
    html += '<div class="stat-h">工具消耗(调用次数)</div><table class="stats-table"><tr><th>工具</th><th>调用</th></tr>';
    for (const trow of d.byTool.slice(0, 15)) html += "<tr><td>" + esc(trow.name) + "</td><td>" + trow.calls + "</td></tr>";
    html += "</table>";
  }
 // 用量仪表盘(refs: ZCode usage dashboard 语义移植):近 30 天逐日 token 条形+Top 任务表。
 // usage 缺键(旧服务)=整区隐藏;数据形状来自 stats.summary.result.usage(computeUsageDashboard)。
  const usage = d.usage;
  if (usage && Array.isArray(usage.days)) {
    const ud = usage.days;
    const maxTok = Math.max(1, ...ud.map((x) => (x.tokens && x.tokens.total) || 0));
    const UW = 720, UH = 90, ubw = UW / Math.max(1, ud.length);
    let ubars = "";
    ud.forEach((x, i) => {
      const tok = (x.tokens && x.tokens.total) || 0;
      const h = Math.round((tok / maxTok) * (UH - 18));
      ubars += '<rect x="' + (i * ubw + 1) + '" y="' + (UH - h - 12) + '" width="' + Math.max(1, ubw - 2) + '" height="' + h + '" rx="1" fill="rgba(157,192,139,.7)"><title>' + x.date + " · token " + tok + "(入 " + ((x.tokens && x.tokens.input) || 0) + " / 出 " + ((x.tokens && x.tokens.output) || 0) + (x.tokens && x.tokens.cached ? " / 缓存 " + x.tokens.cached : "") + ") · LLM " + x.llmCalls + " · 步骤 " + x.steps + " · 工具 " + x.toolCalls + " · 任务 起" + x.tasks.started + "/成" + x.tasks.done + "/败" + x.tasks.failed + "</title></rect>";
      if (i % Math.max(1, Math.floor(ud.length / 6)) === 0) ubars += '<text x="' + (i * ubw + 1) + '" y="' + (UH - 2) + '" font-size="8" fill="#6b5c4a">' + x.date.slice(5) + "</text>";
    });
    html += '<div class="stat-h">用量仪表盘 · 近 30 天 Token</div>';
    html += '<svg width="' + UW + '" height="' + UH + '" style="max-width:100%">' + ubars + "</svg>";
    const tops = usage.topTasks || [];
    if (tops.length) {
      const stMap = { queued: "排队", running: "运行中", blocked: "阻塞", done: "完成", failed: "失败", cancelled: "已取消" };
      html += '<div class="stat-h">Top 任务(按 token)</div><table class="stats-table"><tr><th>任务</th><th>状态</th><th>token(总/入/出)</th><th>步骤</th><th>用时</th></tr>';
      for (const tr of tops) {
        const label = tr.title || tr.instruction || String(tr.taskId || "").slice(0, 8);
        html += "<tr><td>" + esc(label) + ' <span class="aff-stats">' + esc(String(tr.sessionId || "").slice(0, 8)) + "</span></td><td>" + esc(stMap[tr.state] || tr.state || "-") + "</td><td>" + fmtK(tr.tokens.total) + " / " + fmtK(tr.tokens.input) + " / " + fmtK(tr.tokens.output) + "</td><td>" + tr.steps + "</td><td>" + (tr.durationMs ? fmtDur(tr.durationMs) : "-") + "</td></tr>";
      }
      html += "</table>";
    }
  }
  host.innerHTML = html;
  for (const b of host.querySelectorAll("button[data-sm]")) b.onclick = () => { statsMode = b.dataset.sm; renderStats(); };
}
function statsDownload(kind) {
  if (!statsCache || !statsCache.data) { toast("统计未加载", true); return; }
  let content = "", mime = "application/json", ext = "json";
  if (kind === "json") { content = JSON.stringify(statsCache.data, null, 2); }
  else {
    mime = "text/csv"; ext = "csv";
    const NL6 = String.fromCharCode(10);
    content = "day,turns,tokens" + NL6 + (statsCache.data.perDay || []).map((x) => x.day + "," + x.turns + "," + x.tokens).join(NL6) + NL6 + NL6 +
      "sessionId,tasks,turns,llmCalls,toolCalls,tokens,lastAt" + NL6 + (statsCache.data.sessions || []).map((s) => s.sessionId + "," + s.tasks + "," + s.turns + "," + s.llmCalls + "," + s.toolCalls + "," + s.tokens + "," + new Date(s.lastAt).toISOString()).join(NL6);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = "genie-stats." + ext;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
$("statsExportJson").onclick = () => statsDownload("json");
$("statsExportCsv").onclick = () => statsDownload("csv");
$("statsRefresh").onclick = () => { statsFetch(true); toast("统计刷新中…"); };
`;
