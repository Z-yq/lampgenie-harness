/**
 * 面板主脚本分片:script-core(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_CORE = `if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: mmBaseTheme(), themeVariables: mmThemeVars() });
// WS 韧性:socket 降为可换槽位(let)——断线后 connectWs 换新连接,wireWs 统一挂
// 处理器;指数退避在 wsOnClose,成功重放在 wsOnOpen。此前 const 一次性连接,断开只能整页刷新。
let ws = null; // 当前 socket(重连时整体换新;全部 ws.* 引用经 let 绑定读到最新)
function connectWs() {
  try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host); } catch (e) { return; }
  wireWs();
}
connectWs();
// 十期后记:全面板安全发送——CONNECTING 期入队,开连后冲刷(七期 hello 恢复之后);
// 重连等待期(CLOSED 且重连在途)也限深入队(≤100),重连成功一并冲刷——
// 断链窗口内的发送/轮询不再无痕丢失(超限仍丢弃,submit 的守卫 toast 是超限兜底)。
var wsQueue = [];
function wsSafeSend(payload) {
  try {
    if (ws.readyState === 1) { ws.send(payload); return; }
    if (ws.readyState === 0) { wsQueue.push(payload); return; }
    if (ws.readyState === 3 && rcAttempt > 0 && wsQueue.length < 100) { wsQueue.push(payload); return; }
  } catch (e) { /* 已关闭=丢弃 */ }
}
// 重连状态:rcAttempt=已发生的断连次数(重连成功清零);RC_MAX=连续失败上限,
// 超过退回 svcWaitRestart(reload 保底)。声明在文件头部:wsSafeSend 等早期求值路径零 TDZ 风险。
let rcAttempt = 0, rcTimer = 0;
const RC_MAX = 6;

let lastPong = 0; // 最近一次 pong/入站消息时刻(半开连接检测;0=未开)
const $ = (id) => document.getElementById(id);
const NL = String.fromCharCode(10);
const tasks = new Map();
// 会话最近活动时间(sid → ms)。
// 数据源=hello.sessionActivity 首帧快照 + session.status.changed 帧的 lastActivityAt(服务端按
// 200ms per-session 合并下发)。只用于排序/展示,绝不回写进任务对象——task.updatedAt 是事实。
const sessionActivity = new Map();
function noteSessionAct(sid, at) {
  if (!sid || typeof at !== "number" || !(at > 0)) return;
  if (at > (sessionActivity.get(sid) || 0)) sessionActivity.set(sid, at);
}
/** 会话可见时间 = max(会话最近活动, 任务 updatedAt, 任务 createdAt);活动缺失时逐字回落旧键。 */
function actOf(t) {
  if (!t) return 0;
  return Math.max(sessionActivity.get(t.sessionId) || 0, t.updatedAt || 0, t.createdAt || 0);
}
// 活动帧触发的侧栏重渲合并(服务端已 200ms/1s 闸,这里再挡一层连发;单次 timer 只落末次)。
let sbActTid = 0;
function scheduleSidebarRefresh() {
  if (sbActTid) return;
  sbActTid = setTimeout(function () {
    sbActTid = 0;
 // 保留滚动位置:活动帧随时到(别的会话在干活),重渲不得把用户正在浏览的列表拽回顶部。
    const el = $("taskList");
    const st = el ? el.scrollTop : 0;
    try { renderSidebar(); } catch (e) { /* 侧栏重渲失败不影响主链 */ }
    if (el && st) el.scrollTop = st;
  }, 400);
}
// 协议瘦身:任务索引(task.list/hello/task.changed 只带 TaskIndex,无 instruction/result)。
// 正文(instruction/result/attachments…)走 task.detail.get 按需拉:taskBodyIds=已有正文的 id,
// taskDetailPending=在飞请求(防重复发),taskDetailWaiters=等正文的回调队列(id→cb[])。
// 三常量紧邻 tasks 声明(首次调用早于脚本尾);下面的函数声明可提升,零 TDZ 风险。
const taskBodyIds = new Set();
const taskDetailPending = new Set();
const taskDetailWaiters = new Map();
/** 索引合并:同 id 保留已加载的正文键(prev 打底),新索引值覆盖索引字段。 */
function mergeTaskIndex(t) {
  if (!t || !t.id) return;
  const prev = tasks.get(t.id);
  tasks.set(t.id, prev ? Object.assign({}, prev, t) : t);
}
/** 按需拉正文:已加载/在飞则跳过,否则发 task.detail.get。 */
function ensureTaskDetail(id) {
  if (!id || taskBodyIds.has(id) || taskDetailPending.has(id)) return;
  taskDetailPending.add(id);
  wsSafeSend(JSON.stringify({ v: 1, type: "task.detail.get", taskId: id }));
}
/** 要正文的回调式取用:已有→同步回调;没有→挂 waiter + 触发拉取(回包分支统一唤醒)。 */
function withTaskDetail(id, cb) {
  const t = id ? tasks.get(id) : null;
  if (!id || (t && taskBodyIds.has(id))) { cb(t); return; }
  const arr = taskDetailWaiters.get(id) || [];
  arr.push(cb);
  taskDetailWaiters.set(id, arr);
  ensureTaskDetail(id);
}
// fixI12: 会话消息排队——sessionId → 排队项[](queue.update/hello 恢复;渲染排队卡)。
const queueBySid = new Map();
let currentSid = null;      // 选中会话(null=草稿态/全部任务流)
// per-session 主模型(白板「per-session 主模型」前端半边):sid → {model,providerId}|null。
// null=服务端已确认该会话无覆盖;undefined(条目不存在)=未初始化,切会话时发 session.model.get 拉取。
const sessionModelOverride = new Map();
// n8 staged 态:sid → {model,providerId,at} 用户点了但回包未确认的选择。
// pill 显 staged 值+转轮;session.model.result 确认才写入 sessionModelOverride 落定,routeError/ok:false
// 则清 staged 并回滚显示(effective 或上次已确认值)——不再「乐观直写缓存然后停在新模型上」。
const sessionModelStaged = new Map();
/** n8 staged 兜底 TTL:回包丢失(WS 断/服务端静默)时 staged 超时丢弃,pill 回落已确认值而不是永挂「切换中」。 */
const MODEL_STAGED_TTL = 15000;
// n8 服务端 revision 记账(消费 session.model.result.revision):下次 set 带 expectedRevision 做 CAS;
// revision-mismatch(别的标签页刚改过)→ 自动重拉 session.model.get 对齐再让用户重试,不静默失败。
const sessionModelRev = new Map();
// 草稿态(无 currentSid)不再走全局 cfg.set——
// 每个项目下的新建任务有一个预设会话 id(按项目隔离、localStorage 持久化),模型/推理档位等
// 提交前的行为设置全部经 session.model.set 绑定到它;提交时直接以该 sid 派任务。全局 coding.llm
// 只能从设置页改,快切菜单永不触碰(旧 draftModelPick + cfg.set 补发机制退役)。
/** 只读:当前项目草稿预设 sid(无/已被任务占用 → "");渲染路径用,零写副作用。 */
const draftSidMem = {}; // pid → sid(localStorage 写入失败时的进程内兜底,保证 pillPickModel 与 submit 拿到同一 sid)
function draftPid() {
  try { return (typeof activeProjectId !== "undefined" && activeProjectId) ? String(activeProjectId) : "__harness__"; } catch (e) { return "__harness__"; }
}
function draftSidOccupied(sid) {
  return !!(sid && typeof tasks !== "undefined" && [...tasks.values()].some((t) => t.sessionId === sid));
}
function draftSidStored() {
  const pid = draftPid();
  let sid = "";
  try { sid = String(localStorage.getItem("zh:draft-sid:" + pid) || ""); } catch (e) { /* 存储不可用 → 落到进程内兜底 */ }
  if (!sid) sid = String(draftSidMem[pid] || "");
  if (draftSidOccupied(sid)) return ""; // 已被任务占用:不再当预设展示
  return sid;
}
/** 读写:确保预设 sid 存在并返回;已存 sid 若已有任务在身则生成新 sid(提交后预设自动轮换)。
 * 进程内幂等(draftSidMem 兜底):同一项目内反复调用拿到同一 sid,localStorage 挂了也不会
 * 「pillPickModel 的 set 与 submit 的 task.submit 各奔两个会话」。 */
function draftSidOf() {
  const cur = draftSidStored();
  if (cur) return cur;
  const pid = draftPid();
  const sid = "web-" + Date.now();
  draftSidMem[pid] = sid;
  try { localStorage.setItem("zh:draft-sid:" + pid, sid); } catch (e) { /* 存储不可用:进程内兜底已保一致性 */ }
  return sid;
}
/** m4 重试料:draftModelAbort(拒绝/超时)后保留的选择,再点发送按同一模型重发 session.model.set。 */
let draftModelRetry = null;
// m4草稿首发等 set 回包:submit 命中「草稿 + 已选模型」时只发 session.model.set,把任务体暂存成
// pending{sid,text,atts,pick,at,timer}。收到 session.model.result 且 ok 且无 routeError 才发暂存的 task.submit;
// 失败/超时一律不发(否则 set 被拒时任务已派出,用户看到「选了没用上」),草稿与选择都保留供重试。
let draftSubmitPending = null;
/** m4 pending 等回包的超时(秒级体验:超过就退回草稿可重试,不把 composer 永久锁在「等模型」)。 */
const DRAFT_MODEL_ACK_TIMEOUT = 8000;
// ---- 成熟面板状态 ----
const diffstats = new Map(); // taskId → {files,total,sha}(task.diffstat.result 缓存;变更条渲染源)
let diffOpenTask = null; // 变更条文件清单展开态( F1)
let ddSel = null;        // 右侧 diff 抽屉当前 {taskId,file}( F1)
let statsCache = null;       // stats.summary.result 缓存 {at,data}
let autoScope = "global";    // 自动化分栏过滤
// 会话标签页:打开过的 sessionId 序列(≤8),localStorage 持久化;draft 伪 tab 尾置。
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "分" + String(s % 60).padStart(2, "0") + "秒";
  return Math.floor(m / 60) + "小时" + (m % 60) + "分";
}
let histEvents = [];        // 会话重放事件(null=加载中)
let revSrcCache = {};       // review.findings 组的注入数据源(rk→{items,sid}),每次 renderHistory 重建
let histLanding = 0;        // 打开会话的落底宽窗(history 分块到达,1.2s 内每次渲染都贴底;此后交回保持语义)
// 重连保会话:reload 后恢复选中会话与视图(此前全丢回草稿态)。
// (ZCode 恢复语义对齐):会话/视图恢复从 sessionStorage 升级 localStorage——
// 关浏览器/桌面壳重开不再是草稿态(此前 sessionStorage 随标签页失效,重开回到空白)。
const savedSid = localStorage.getItem("zh:sid") || sessionStorage.getItem("zh:sid");
const savedView = localStorage.getItem("zh:view") || sessionStorage.getItem("zh:view");
let traceStats = {};        // sid -> trace.stats( B4)
let sessionStatus = null;   // 当前会话状态投影(todo/子代理/workflow; B3)
// ssc1/ssc2:session.status 增量化(治网关 OOM)。sid -> 已收到末条事件的 seq(水位)。
// 有此水位→请求带 sinceSeq 只归约新增;无→首拉全量。切会话/回草稿必须清(旧水位 + 服务端另一份
// 累积态会对不上 → 状态条显示错),见 openSession/newDraft/draftModelAbort 三处同清。
const ssSeqBySid = new Map();
/** 发一次 session.status 请求:有水位带 sinceSeq(增量),没有则不带(全量)。所有请求点统一走这里。 */
function ssSendStatus(sid) {
  if (!sid) return;
  const body = { v: 1, type: "session.status", sessionId: sid };
  const sq = ssSeqBySid.get(sid);
  if (typeof sq === "number" && sq >= 0) body.sinceSeq = sq; // 只带数字(缺失/undefined 绝不写回包)
  wsSafeSend(JSON.stringify(body));
}
// 重试态跨会话保活(batch1b):sid -> apiRetry(服务端 gateway 内存镜像回填)。切会话不清——
// 切走再回来仍能看到「重新连接中」;服务端每次 session.status.result 现读镜像,权威在服务端。
let apiRetryBySid = {};
let findQuery = "", findIdx = 0;  // 会话内查找(批A)
let promptHist = JSON.parse(localStorage.getItem("zh:prompt-hist") || "[]"); // 输入历史
let histNav = -1;           // 输入历史浏览位(-1=不在历史态)
let sysMeta = {};           // sys.meta.result
let cfgView = null;         // cfg.get.result {config,sources,projectPath}
let projState = "";         // 项目状态摘要(系统活性面板消费)
let expItems = [];
let mainView = "chat";      // chat | sense | wf | exp | sys(复刻 ZCode workspaceMainView)
let projectTab = "structure"; // 代码档案 tab:structure | files | wiki( wiki 并入档案)
let organize = localStorage.getItem("zh:sb-organize") || "project"; // project | time
let showLimit = {};         // 分页: 桶键 -> 可见条数(复刻 ZCode 每页5,+5)
const bucketCollapsed = new Set(JSON.parse(localStorage.getItem("zh:bucket-collapse") || "[]")); // 折叠桶键(持久)
let ccHot = 0;
const VIEW_NAMES = { chat: "", sense: "代码透镜 Lens", project: "代码档案 Atlas", wf: "自动化 Flows", exp: "经验库 Memo", sys: "配置台 Config", team: "团队 Crew", pipeline: "总线路", dash: "团队 · 看板", issues: "团队 · Issue", rsi: "指挥台 · 做梦", task: "指挥台 · 任务", nodes: "节点 Fleet", approvals: "关卡 Gate", board: "白板 Sketch", files: "文件树 Files", ide: "编辑器 IDE", git: "Git", term: "命令台 Shell", market: "插件市场 Market", browser: "网页 Webview", subchat: "子代理会话流", track: "追踪 Trace", traj: "轨迹 Trail", usage: "吞吐 Telemetry", super: "指挥台 Super" };
// ── 设置状态(全部真实生效+localStorage 持久化,参照 ZCode 设置页) ──
const settings = {
  theme: localStorage.getItem("zh:theme") || "dark",
  replyFs: localStorage.getItem("zh:reply-fs") || "19",
  sortBy: localStorage.getItem("zh:sort") || "updated",
  organizeDefault: localStorage.getItem("zh:sb-organize") || "project",
  reconnect: Number(localStorage.getItem("zh:reconnect") || 3),
 // ---- 通用/外观新增项 ----
  mode: localStorage.getItem("zh:mode") || "code",                 // code | office(办公模式=只留摘要)
  thinking: localStorage.getItem("zh:thinking") || "on",           // 显示思考过程
  showTodo: localStorage.getItem("zh:show-todo") || "on",          // 显示待办
  gSearch: localStorage.getItem("zh:g-search") || "on",            // 分组:读取/搜索工具
  gTerm: localStorage.getItem("zh:g-term") || "on",                // 分组:终端命令
  gChanges: localStorage.getItem("zh:g-changes") || "on",          // 分组:文件更改
  notify: localStorage.getItem("zh:notify") || ((window.genieWindow && window.genieWindow.isDesktop) ? "on" : "off"),              // 任务通知(桌面默认开:原生通知无需授权;浏览器需授权)
  sound: localStorage.getItem("zh:sound") || "on",                 // 通知声音
  autoarch: localStorage.getItem("zh:autoarch") || "off",          // 自动归档(映射 config tasks.autoArchiveDays)
  archdays: localStorage.getItem("zh:archdays") || "7",
  zoom: Number(localStorage.getItem("zh:zoom") || 1),
  codeFs: localStorage.getItem("zh:code-fs") || "12.5",
  lineno: localStorage.getItem("zh:lineno") || "on",
  codewrap: localStorage.getItem("zh:codewrap") || "on",
};
// 旧三主题(neon/crt/aurora)已下线:localStorage 残留归一到新主题,避免无主题类/按钮全不选中
const LEGACY_THEME_MAP = { neon: "sand", crt: "olive", aurora: "plum" };
if (LEGACY_THEME_MAP[settings.theme]) {
  settings.theme = LEGACY_THEME_MAP[settings.theme];
  localStorage.setItem("zh:theme", settings.theme);
}
const SETTING_KEYS = {
  theme:"theme", replyFs:"reply-fs", sortBy:"sort", organizeDefault:"sb-organize",
  mode:"mode", thinking:"thinking", showTodo:"show-todo", gSearch:"g-search", gTerm:"g-term", gChanges:"g-changes",
  notify:"notify", sound:"sound", autoarch:"autoarch", archdays:"archdays", zoom:"zoom", codeFs:"code-fs", lineno:"lineno", codewrap:"codewrap",
};
function effectiveTheme() {
  if (settings.theme === "system") {
    try { return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch (e) { return "dark"; }
  }
  return settings.theme;
}
// 主题注册表(key/名称/色板预览/明暗基座)——设置色板卡与循环切换共用单一出处
const THEMES = [
  { key: "dark", name: "鎏金夜", sw: ["#0b0806", "#c98f45", "#ece1d1"], base: "dark" },
  { key: "light", name: "暖纸", sw: ["#faf6ee", "#c98f45", "#3d3223"], base: "light" },
  { key: "sand", name: "砂陶松影", sw: ["#E3DCD2", "#CC8B65", "#013328"], base: "light" },
  { key: "glass", name: "流光玻璃", sw: ["#2c2742", "#c4b5fd", "#f0abfc"], base: "dark" },
  { key: "olive", name: "橄榄赤陶", sw: ["#CDCBD6", "#D96846", "#596235"], base: "light" },
  { key: "plum", name: "蓝调梅影", sw: ["#F2EBE5", "#9F496E", "#647295"], base: "light" },
  { key: "ink", name: "薄墨", sw: ["#ffffff", "#d43d2a", "#141414"], base: "light" },
];
const THEME_KEYS = THEMES.map((t) => t.key);
function isLightBase() { const th = THEMES.find((t) => t.key === effectiveTheme()); return th ? th.base === "light" : false; }
// :主题签名(初载空=首屏不加过渡;之后主题基座或主题类真变才挂 theme-fade)
let __lastThemeSig = "";
function applySettings() {
  document.body.classList.toggle("light", isLightBase());
 // 主题类单一在位(新主题=body.theme-<key>;dark/light 走既有 light 开关)
  for (const t of THEME_KEYS) {
    if (t !== "dark" && t !== "light") document.body.classList.toggle("theme-" + t, settings.theme === t);
  }
 // :主题真切换时挂 theme-fade 320ms 窗口,全站色彩经 transition 平滑(240ms);
 // 初载(签名空)不挂=首屏即正确主题;reduced-motion 由 CSS 大降级自动兜底。
  const themeSig = settings.theme + "|" + (isLightBase() ? "l" : "d");
  if (__lastThemeSig && __lastThemeSig !== themeSig) {
    document.body.classList.add("theme-fade");
    setTimeout(() => document.body.classList.remove("theme-fade"), 320);
  }
  __lastThemeSig = themeSig;
 // 任务B:主题(基座/主题类)真变 → mermaid 用同一份归一化变量重新 initialize;
 // 此前只有解析期一次写死 dark,浅主题下 mermaid 图恒为深色。库未到=空转(onload 用当前基座兜住)。
  try {
    if (typeof mmThemeSigApplied !== "undefined" && mmThemeSigApplied !== themeSig && typeof mmApplyTheme === "function") {
      mmThemeSigApplied = themeSig;
      mmApplyTheme();
    }
  } catch (e) { /* 主题重初始化失败不影响配色切换 */ }
  document.body.classList.toggle("office", settings.mode === "office");
  document.body.classList.toggle("lineno", settings.lineno === "on");
  document.body.classList.toggle("nowrapcode", settings.codewrap === "off");
  document.documentElement.style.setProperty("--reply-fs", settings.replyFs + "px");
  document.documentElement.style.setProperty("--code-fs", settings.codeFs + "px");
  document.body.style.zoom = String(settings.zoom || 1);
  const segs = [["set-theme", settings.theme], ["set-font", settings.replyFs],
    ["set-zoom", String(settings.zoom)], ["set-codefs", settings.codeFs], ["set-lineno", settings.lineno],
    ["set-codewrap", settings.codewrap], ["set-mode", settings.mode], ["set-thinking", settings.thinking],
    ["set-todo", settings.showTodo], ["set-g-search", settings.gSearch], ["set-g-term", settings.gTerm],
    ["set-g-changes", settings.gChanges], ["set-notify", settings.notify], ["set-sound", settings.sound],
    ["set-autoarch", settings.autoarch], ["set-archdays", settings.archdays]];
  for (const [id, val] of segs) {
    const el = $(id);
    if (!el) continue;
    for (const b of el.querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === val);
  }
 // 代码预览:标亮当前生效主题(明基座主题标浅色预览)
  const pl = $("prev-light"), pd = $("prev-dark");
  if (pl && pd) { pl.classList.toggle("on", isLightBase()); pd.classList.toggle("on", !isLightBase()); }
  const rc = $("set-reconnect");
  if (rc && document.activeElement !== rc) rc.value = String(settings.reconnect);
}
// 跟随系统主题:系统变化即时响应(仅 theme=system 时生效)。
try {
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onSys = () => { if (settings.theme === "system") applySettings(); };
    if (mq.addEventListener) mq.addEventListener("change", onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
} catch (e) { /* 无 matchMedia 环境忽略 */ }
function wireSettings() {
  const seg = (id, key, after) => { for (const b of $(id).querySelectorAll("button")) b.onclick = () => { settings[key] = b.dataset.v; localStorage.setItem("zh:" + SETTING_KEYS[key], b.dataset.v); applySettings(); if (after) after(); }; };
  seg("set-theme", "theme");
  seg("set-font", "replyFs");
  seg("set-zoom", "zoom");
  seg("set-codefs", "codeFs");
  seg("set-lineno", "lineno");
  seg("set-codewrap", "codewrap");
  seg("set-mode", "mode");
  seg("set-thinking", "thinking", () => { if (histEvents) renderHistory(); });
  seg("set-todo", "showTodo", () => renderStatusbar());
  seg("set-g-search", "gSearch", () => { if (histEvents) renderHistory(); });
  seg("set-g-term", "gTerm", () => { if (histEvents) renderHistory(); });
  seg("set-g-changes", "gChanges", () => { if (histEvents) renderHistory(); });
  seg("set-notify", "notify", () => { if (settings.notify === "on") requestNotifyPerm(); });
  seg("set-sound", "sound");
  seg("set-autoarch", "autoarch", () => pushAutoArchive());
  seg("set-archdays", "archdays", () => pushAutoArchive());
  $("set-reconnect").onchange = (e) => {
    const v = Math.min(30, Math.max(1, parseInt(e.target.value) || 3));
    settings.reconnect = v; e.target.value = String(v);
    localStorage.setItem("zh:reconnect", String(v));
  };
 // 分区导航(ZCode SettingsPage: activeSection + 落点持久化 writeLastSettingsSectionPreference)
  for (const item of $("setNav").querySelectorAll(".set-nitem")) {
    item.onclick = () => setSection(item.dataset.sec);
  }
  $("cfg-cc-apply").onclick = () => {
    const v = parseInt($("cfg-cc-max").value);
    if (!v || v < 1 || v > 64) return;
    $("cfg-cc-badge").textContent = "应用中…";
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { concurrency: { maxConcurrent: v } } }));
  };
  $("auto-open").onclick = () => switchView("wf");
  $("exp-open").onclick = () => switchView("exp");
  $("termClear").onclick = () => { $("termBody").innerHTML = ""; };
  $("termKill").onclick = () => termSend({ type: "term.cancel" });
}
// 任务最大步数(maxSteps 1000 且设置页可配)——cfg.set agent.maxSteps 热生效。
{
  const inp = $("set-maxsteps");
  if (inp) {
    inp.value = localStorage.getItem("zh:maxsteps") || "1000";
    const push = () => {
      const v = Math.max(1, Math.min(1000, Number(inp.value) || 1000));
      inp.value = String(v);
      localStorage.setItem("zh:maxsteps", String(v));
      wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { agent: { maxSteps: v } } }));
      toast("任务最大步数 → " + v + "(热生效,下个任务起用)");
    };
    $("set-maxsteps-go").onclick = push;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") push(); });
  }
}
// 自动归档映射到 config tasks.autoArchiveDays(热读;0=关)。
function pushAutoArchive() {
  const days = settings.autoarch === "on" ? Number(settings.archdays) || 7 : 0;
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { tasks: { autoArchiveDays: days } } }));
}
// 浏览器通知(任务完成/失败;权限未授予则静默)。
function requestNotifyPerm() {
  try {
    if (window.Notification && Notification.permission === "default") void Notification.requestPermission();
  } catch (e) { /* 非浏览器环境忽略 */ }
}
function fireNotify(title, body, meta) {
  try {
    if (settings.notify !== "on") return;
    const payload = {
      title: String(title),
      body: String(body).slice(0, 160),
      ...(meta && meta.taskId ? { taskId: String(meta.taskId) } : {}),
      ...(meta && meta.status ? { status: String(meta.status) } : {}),
    };
    const bridge = window.genieWindow;
    if (bridge && typeof bridge.notify === "function") {
 // 桌面壳:主进程原生通知(焦点抑制/3s 去重/点击恢复窗口;免授权)
      void bridge.notify(payload);
    } else if (window.Notification && Notification.permission === "granted") {
      new Notification(payload.title, { body: payload.body });
    } else {
      return;
    }
    if (settings.sound === "on") beep();
  } catch (e) { /* 忽略 */ }
}
// 合成提示音(WebAudio,零外部资源)。
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.32);
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 600);
  } catch (e) { /* 忽略 */ }
}
// 任务终态通知(移植 ZCode desktopNotifications 语义):
// ① 只对「本端看到 running/queued/pending → done/failed」的跃迁通知——重连重放、首屏历史里的终态不刷
// ② 当前会话且窗口有焦点 = 用户正看着,不打扰;当前会话但窗口失焦/最小化 → 系统通知
// ③ 后台会话沿用原「toast + 未读」并补系统通知
const lastTaskState = new Map();
const LAST_TASK_STATE_LIMIT = 200;
function rememberTaskState(id, state) {
  if (!id) return;
  lastTaskState.set(id, state);
  if (lastTaskState.size > LAST_TASK_STATE_LIMIT) {
    const oldest = lastTaskState.keys().next().value;
    if (oldest !== undefined) lastTaskState.delete(oldest);
  }
}
function notifyTaskDone(t) {
  if (!t || !t.id) return;
  const prev = lastTaskState.get(t.id);
  rememberTaskState(t.id, t.state);
  if (t.state !== "done" && t.state !== "failed") return;
  const transitioned = prev === "running" || prev === "queued" || prev === "pending";
  if (!transitioned) return;
  const mine = t.sessionId === currentSid;
  let focused = false;
  try { focused = document.visibilityState === "visible" && document.hasFocus(); } catch (e) { /* 忽略 */ }
  if (mine && focused) return;
  if (!mine) {
    if (t.state === "done") toast("任务完成:" + rowTitle(t).slice(0, 40));
    else toast("任务失败:" + rowTitle(t).slice(0, 40), true);
    bumpUnread(1);
  }
  fireNotify(t.state === "done" ? "任务完成" : "任务失败", rowTitle(t), { taskId: t.id, status: t.state });
}
let settingsSection = localStorage.getItem("zh:settings-section") || "general";
function setSection(sec) {
  settingsSection = sec;
  localStorage.setItem("zh:settings-section", sec);
  for (const item of $("setNav").querySelectorAll(".set-nitem")) item.classList.toggle("on", item.dataset.sec === sec);
  for (const s of document.querySelectorAll(".set-sec")) s.classList.toggle("on", s.id === "sec-" + sec);
  if (sec === "data") { statsFetch(false); localStorage.setItem("zh:used-stats", "1"); } // 懒加载(60s 缓存)
  if (sec === "model") { renderModelSwitch(); refreshSecretKeyState(); }
  if (sec === "guide") guideRender();
  if (sec === "account") { acctRender(); statsFetch(false); }
  if (sec === "remote") sendOrQueue({ v: 1, type: "nodes.list" });
  const lazy = { agents: "agents.list", skills: "skills.list", cmds: "commands.list", hooks: "hooks.list", mcp: "mcp.list", memory: "memory.view" };
  if (lazy[sec]) sendOrQueue({ v: 1, type: lazy[sec] });
  renderSectionDyn();
}
/** 隐私:路径脱敏(设置页只给产品信息,不暴露本机目录)。
 * 无正则转义坑:id 命中前缀后整段截断;公开 URL(https://)不受影响。 */
function redactPaths(s) {
  let t = String(s == null ? "" : s);
  const BS = String.fromCharCode(92);
  const marks = ["/mnt/", "/home/", "/Users/", "/root/", "/var/", "/tmp/", "C:" + BS, "D:" + BS, "E:" + BS, "F:" + BS];
  for (const mk of marks) {
    const p = t.indexOf(mk);
    if (p >= 0) t = t.slice(0, p) + "[路径已隐藏]";
  }
  return t;
}
/** 只显示目录末段名(仓库名),不暴露父目录。 */
function pathBasename(s) {
  const t = String(s == null ? "" : s);
  const parts = t.split("/").join(String.fromCharCode(92)).split(String.fromCharCode(92)).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
// ===== 上下文模型评分设置(Phase 1/2)=====
// 默认本地 150M Jev(/decide);也允许 OpenAI 兼容提炼 provider。mode=off/shadow/active。
function renderModelScoring() {
  const box = $("ms-mode");
  if (!box) return;
  const ms = (cfgView && cfgView.config && cfgView.config.context && cfgView.config.context.modelScoring) || {};
  const setVal = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(v); };
  setVal("ms-url", ms.providerUrl || "http://127.0.0.1:8105");
  setVal("ms-model", ms.model || "jev-150m");
  setVal("ms-key", ms.apiKeyEnv || "");
  setVal("ms-conf", ms.minConfidence ?? 0.9);
  setVal("ms-max", ms.maxCandidates ?? 12);
  setVal("ms-every", ms.scoreEverySteps ?? 5);
  const api = $("ms-api");
  if (api && document.activeElement !== api) api.value = ms.apiType === "openai" ? "openai" : "jev";
  const mode = ms.mode || "shadow";
  const labels = { off: "关闭", shadow: "只记录", active: "自动精简" };
  for (const b of box.querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === mode);
  $("ms-mode-badge").textContent = "当前:" + (labels[mode] || mode);
  $("ms-url-badge").textContent = ms.providerUrl ? "自定义评分服务" : "内置本地服务";
  $("ms-model-badge").textContent = (ms.apiType === "openai" ? "自定义服务" : "内置本地模型") + " · " + (ms.model || "jev-150m");
  $("ms-key-badge").textContent = ms.apiKeyEnv ? "已设 " + ms.apiKeyEnv : "无需填写";
  for (const b of box.querySelectorAll("button")) {
    b.onclick = () => {
      for (const x of box.querySelectorAll("button")) x.classList.toggle("on", x === b);
      modelScoringSave(b.dataset.v);
    };
  }
  const save = $("ms-save");
  if (save) save.onclick = () => modelScoringSave();
}
function modelScoringSave(modeOverride) {
  const box = $("ms-mode");
  if (!box) return;
  const mode = modeOverride || (box.querySelector("button.on") && box.querySelector("button.on").dataset.v) || "shadow";
  const url = ($("ms-url").value || "").trim();
  const model = ($("ms-model").value || "").trim() || "jev-150m";
  const conf = Number($("ms-conf").value);
  const maxC = Number($("ms-max").value);
  const every = Number($("ms-every").value);
  if (!url) { toast("Provider URL 不能为空", true); return; }
  if (!Number.isFinite(conf) || conf < 0 || conf > 1) { toast("置信度必须在 0–1", true); return; }
  if (!Number.isInteger(maxC) || maxC < 1 || maxC > 50) { toast("候选上限必须是 1–50 的整数", true); return; }
  if (!Number.isInteger(every) || every < 1 || every > 100) { toast("步频必须是 1–100 的整数", true); return; }
  const key = ($("ms-key").value || "").trim();
  const ms = {
    mode, providerUrl: url, model,
    apiType: $("ms-api").value === "openai" ? "openai" : "jev",
    minConfidence: conf, maxCandidates: maxC, scoreEverySteps: every,
  };
  if (key) ms.apiKeyEnv = key;
  wsSafeSend(JSON.stringify({ v: 1, type: "cfg.set", patch: { context: { modelScoring: ms } } }));
  $("ms-status").textContent = "已保存 · 新任务生效";
  const labels = { off: "关闭", shadow: "只记录", active: "自动精简" };
  $("ms-mode-badge").textContent = "当前:" + (labels[mode] || mode);
}
/** 动态分区内容(数据到达即刷新,重复调用幂等)。 */
function renderSectionDyn() {
 // 子代理与执行
  const cc = (cfgView && cfgView.config && cfgView.config.concurrency) || {};
  $("exec-kind").textContent = sysMeta.executor === "dsh" ? "dsh(分布式执行器)" : sysMeta.executor === "echo-child" ? "内置执行器(本机子进程)" : (sysMeta.executor || "未配置");
  if (document.activeElement !== $("cfg-cc-max")) $("cfg-cc-max").value = cc.maxConcurrent ?? "";
  $("cc-perowner").textContent = (cc.maxConcurrentPerOwner ?? "-") + " 个/会话";
  $("cc-system").textContent = (cc.maxConcurrentSystem ?? "-") + " 个(系统任务)";
 // 工具(真实 TOOL_HINTS,sysMeta 单一出处)
  if (Array.isArray(sysMeta.tools)) {
    $("tools-list").innerHTML = sysMeta.tools.map((t) =>
      '<div class="tool-item"><div class="tool-name">' + esc(t.name) + '</div><div class="tool-desc">' + esc(t.hint) + '</div></div>').join("");
  } else $("tools-list").innerHTML = '<div class="cc-empty">需要生产入口(LLM 未启用时工具面仍由装配决定)</div>';
 // 自动化(真实模板清单)
  const tpls = Array.isArray(sysMeta.workflowTemplates) ? sysMeta.workflowTemplates : [];
  const tplDesc = { "unit-tests": "逐个模块跑测试,失败时自动分析原因", "functional-test": "场景清单逐项执行+确定性验证", "algo-eval": "数据集逐例 judge 判分+命中率聚合" };
  $("auto-list").innerHTML = tpls.map((t) =>
    '<div class="tool-item"><div class="tool-name">' + esc(t) + '</div><div class="tool-desc">' + esc(tplDesc[t] || "workflow 模板") + '</div></div>').join("") || '<div class="cc-empty">未启用</div>';
 // 经验库(不展示内部目录,只给产品信息)
  $("exp-kv").innerHTML =
    '<span class="k">条目</span><span class="v">' + expItems.length + ' 条(active)</span>' +
    '<span class="k">存储</span><span class="v">内置经验库(本地)</span>' +
    '<span class="k">回顾机制</span><span class="v">开工时自动推荐最相关的经验</span>';
 // 数据与统计 kv
  renderSys();
 // 关于
  renderAboutKv(sysMeta);
  renderModelScoring();
}
function renderAboutKv(m) {
  const host = $("about-kv");
  if (!host) return;
  const up = m && m.startedAt ? fmtDur(Date.now() - Number(m.startedAt)) : "-";
  host.innerHTML =
    '<span class="k">面板</span><span class="v">lampgenie-harness web console</span>' +
    '<span class="k">协议</span><span class="v">v' + esc(String((m && m.protocol) ?? 1)) + '(信封强制)</span>' +
    '<span class="k">仓库</span><span class="v">' + esc(pathBasename(m && m.repoRoot) || "(本地工作区)") + '</span>' +
    '<span class="k">版本 / Node</span><span class="v">' + esc(String((m && m.version) ?? "-")) + " / " + esc(String((m && m.node) ?? "-")) + '</span>' +
    '<span class="k">已运行</span><span class="v">' + esc(up) + '</span>' +
    '<span class="k">事件日志</span><span class="v">' + esc(String((m && m.journalEvents) ?? "-")) + '</span>';
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
/**
 * 轨迹卡渲染(J1 2026-11 token 轮):journal 的 task.trajectory → 折叠「画像」卡。
 * payload 只含计数/比率/阶段/子目标(loop 侧不含任何对话正文),所以这张卡永远是短小的。
 * series=[{step,tokensSpent}] 是上层预扫的累积序列(全量重渲时天然完整),画步数/token 曲线。
 * 纯函数(只依赖 esc):面板测试可直接从 / 抽本函数求值断言,不依赖 DOM。
 */
function trajCardHtml(tp, series) {
  tp = tp || {};
  const tools = tp.tools && typeof tp.tools === "object" ? tp.tools : {};
  const names = Object.keys(tools);
 // 阶段/子目标行:有才显示(空串不出空 div——空标记=噪音,负面测试锚这条)
  const sub = [];
  if (String(tp.phase || "")) sub.push("阶段 " + String(tp.phase));
  if (String(tp.subgoal || "")) sub.push(String(tp.subgoal));
  const subH = sub.length ? '<div class="tj-sub">' + esc(sub.join(" · ")) + "</div>" : "";
 // 工具分布 top6:按最大次数归一(横条宽度=该工具次数/最高次数)
  const top = names.map(function (n) { return { n: n, c: Number(tools[n]) || 0 }; })
    .sort(function (a, b) { return b.c - a.c; }).slice(0, 6);
  const max = top.length ? top[0].c : 0;
  const bars = top.length ? '<div class="tj-bars">' + top.map(function (x) {
    const w = max > 0 ? Math.round((x.c / max) * 100) : 0;
    return '<div class="traj-bar"><span>' + esc(x.n) + '</span><i style="width:' + w + '%"></i><b>' + x.c + '</b></div>';
  }).join("") + "</div>" : "";
 // 步数/token 曲线:同一次会话的累积序列(≥2 点才画,单点无曲线信息)
  const pts = (series || []).filter(function (p) { return Number(p.step) > 0; });
  let spark = "";
  if (pts.length >= 2) {
    const maxTok = pts.reduce(function (m, p) { return Math.max(m, Number(p.tokensSpent) || 0); }, 0) || 1;
    const coords = pts.map(function (p, i) {
      const x = pts.length > 1 ? Math.round((i / (pts.length - 1)) * 256) : 0;
      const y = 40 - Math.round(((Number(p.tokensSpent) || 0) / maxTok) * 36);
      return x + "," + y;
    }).join(" ");
    spark = '<svg class="tj-spark" width="260" height="42" viewBox="0 0 260 42"><polyline points="' + coords + '"/></svg>';
  }
 // token 总量:输入/缓存/出。tp 无 usage 时回落到 tokensSpent(整段计费口径),
 // 全 0 不出空标记(空标记=噪音,与 tj-sub 同一纪律)。
 // typeof 守卫:本函数被 panel-trajectory.test.ts 抽出来 new Function("esc", …) 求值(只注入 esc),
 // 直接引用 fmtTokens 会在那条既有测试里 ReferenceError。
  const tokOf = function (n) { return typeof fmtTokens === "function" ? fmtTokens(n) : String(n); };
  const tu = tp.usage && typeof tp.usage === "object" ? tp.usage : {};
  const tIn = Number(tu.inputTokens ?? tp.inputTokens ?? tp.tokensSpent ?? 0) || 0;
  const tCache = Number(tu.cachedTokens ?? tp.cachedTokens ?? 0) || 0;
  const tOut = Number(tu.outputTokens ?? tp.outputTokens ?? 0) || 0;
  const tokH = tIn || tCache || tOut
    ? '<span class="tj-tok">入 ' + tokOf(tIn) + " · 缓存 " + tokOf(tCache) + " · 出 " + tokOf(tOut) + "</span>"
    : "";
  return '<details class="traj-line"><summary><span class="tj-tag">轨迹</span>'
    + tokH
    + '<span class="tj-open" data-traj-open="1" title="打开轨迹看板:本会话每一步的类型/耗时/token/状态">看板</span>'
    + "</summary>" + subH + bars + spark + "</details>";
}
`;
