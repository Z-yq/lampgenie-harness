/**
 * 面板主脚本分片:script-submit(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_SUBMIT = `function submit(overrideText, projectOverride) {
 // 语音任务书锁:本会话撰写中禁止提交(输入区只读;Enter/发送按钮/命令全走这里,统一守卫)。
  if (voiceLocked(currentSid)) { toast("任务书撰写中,请稍候…(完成后自动填入输入框)"); return; }
 // overrideText(仅接受 string)=chip/typed 命令合成后的最终任务书(raw 行前缀+模板)——直提任务流,
 // 不再走 slash 分派(合成文本以 "/" 开头,再进 slashTypedSubmit 会把模板吞进 args 无限膨胀)。
 // 只认 string:$("go").onclick = submit 直挂会把 click 事件对象传进来,必须回落读输入框。
  const fromInput = typeof overrideText !== "string";
 // 项目归属(漂移修复):重发/重试必须带**原任务的 projectId**,不能用 current active——
 // 经验证重启后点「重发」把 genie 会话的任务贴到了 harness。服务端已改为 owner 优先(双保险:
 // 老会话任务被删、owner 证据缺失时,这里仍把任务送回原项目)。
  const submitProjectId = typeof projectOverride === "string" && projectOverride ? projectOverride : activeProjectId;
  const typedText = String(fromInput ? $("instruction").value : overrideText).trim();
 // 仅附件发送:正文全空但有附件时照样可发(正文用附件占位文案补齐,下游只认 text 一套变量)
  if (!typedText && !pendingAtts.length) return;
 // 连接守卫:半开 TCP 下 ws.send 抛 InvalidStateError 会被静默吞掉,消息无痕丢失——宁可显式失败
  if (!ws || ws.readyState !== 1) { toast("连接未就绪,消息未发送(等待重连)", true); return; }
 // m4 防重复:草稿首发正在等 session.model.set 回包(draftSubmitPending 在飞)→ 再点发送/Enter 一律忽略,
 // 否则会再发一条 set(撞 revision-mismatch)并可能派出两个任务。
  if (draftSubmitPending) { toast("首轮消息正在等模型切换确认,请稍候…"); return; }
 // 重试料消费:上次模型切换被拒/超时(draftModelRetry 保留),本次发送先重发 session.model.set
 // 到预设会话再派任务(选择不变;新 set 仍走 staged→pending 等回包链,拒绝依旧不派单)。
  if (!currentSid && draftModelRetry && draftModelRetry.model && !sessionModelStaged.has(draftSidOf())) {
    const r = draftModelRetry;
    pillPickModel(r.model, r.providerId || undefined);
    if (r.effort !== undefined && typeof effortV !== "undefined") effortV = r.effort; // 档位一并复原
    draftModelRetry = null;
  }
 // 发两遍防护(视频 18:08 登记):同文本 3s 内重复提交=Enter 连击/双击,忽略
 // (草稿态首提交会新建 sid,sid 比对会漏——按文本+时间窗判定即可,3s 内同文本跨会话提交不成立)
  if (typedText && typedText === lastSubmitText && Date.now() - lastSubmitAt < 3000) { toast("该消息 3 秒内已提交过(防重复)"); return; }
  if (typedText) { lastSubmitText = typedText; lastSubmitAt = Date.now(); }
 // 内置命令 typed 提交:"/goal x" "/compact 指示" 等直接执行,不入任务流。
  if (fromInput && typedText.startsWith("/") && slashTypedSubmit(typedText)) {
 // ZCode 内置命令确认行:命令在聊天窗留下执行痕迹
      chatSysLineIcon("check", typedText.slice(0, 80));
    $("instruction").value = "";
    slashClose(); // 浮窗残留修复:程序化清空不触发 input 事件,面板若开着(空态)会永留
    autoGrow();
    localStorage.removeItem("zh:draft:" + (currentSid || "__new__"));
    cmdChipFlash(typedText); // 真执行闪确认(仅 slashTypedSubmit 返回 true=确实执行了才闪)
    return;
  }
 // 草稿提交直接消费当前项目预设 sid(draftSidOf)——模型覆盖早已经 session.model.set
 // 绑定到它,提交即派单到同一会话。预设被任务占用后下次草稿自动轮换出新 sid。
  const sid = currentSid || draftSidOf();
  const wasDraft = !currentSid;
  const wasDraftPending = wasDraft && sessionModelStaged.has(sid); // 预设会话的模型 set 还在等回包 → 任务体暂存
  currentSid = sid; sessionStorage.setItem("zh:sid", sid); localStorage.setItem("zh:sid", sid); // 会话 id 持久化(修复:#go 新建会话从不写 zh:sid→刷新后 savedSid 空→白板/会话视图全空,白板数据看似"刷新即丢")
  const atts = pendingAtts.slice(0, ATT_MAX_COUNT).map((a) => ({ name: a.name, path: a.path, mime: a.mime, size: a.size }));
 // 占位文案必须在清空 pendingAtts **之前**取(要读得到 pastedText 的行数)
  const text = typedText || attsPlaceholder(pendingAtts.slice(0, ATT_MAX_COUNT));
  pendingAtts = []; attRender();
 // m4草稿首发**等 set 回包**:草稿预设会话的模型切换在飞(sessionModelStaged 命中)
 // 时先等 session.model.result,把任务体暂存成 pending(draftSubmitPending);收到 result ok 且无
 // routeError 才发 task.submit。旧实现按 draftModelPick 判定;现在 pillPickModel 在草稿态已直接发
 // session.model.set(绑定预设 sid),submit 只需识别「staged 在飞」。
 // 非草稿/覆盖已确认 → 直发 task.submit,保持原直发语义。
  if (wasDraftPending) {
    draftSubmitPending = { sid, text, atts, projectId: submitProjectId, at: Date.now(), timer: null };
    draftSubmitPending.timer = setTimeout(() => {
      if (draftSubmitPending && draftSubmitPending.sid === sid) draftModelAbort("模型切换确认超时(服务端未回包)", "");
    }, DRAFT_MODEL_ACK_TIMEOUT);
    renderModelPill(cfgView);
    switchView("chat");
    renderSendBtn(); // 等确认中:按钮保持忙碌语义,配合 draftSubmitPending 防二次派单
    toast("会话模型切换确认中,确认后再派发任务…");
    return;
  }
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: text, idempotencyKey: "web-" + text + Date.now(), ...(submitProjectId ? { projectId: submitProjectId } : {}), ...(atts.length ? { attachments: atts } : {}) }));
  finishSubmit(sid, text, atts, wasDraft);
}
/** m4/m9 共用「任务已派发后」收尾(原 submit 尾部原样搬出:pending 确认成功后走同一条,不两套清理逻辑)。
 * sameView=false(pending 期间用户已切到别的会话)→ 只记输入历史与草稿键清理,不动当前会话的输入框/渲染。 */
function finishSubmit(sid, text, atts, wasDraft, sameView) {
 // 输入历史(ZCode PromptHistoryPlugin 裁剪):去重入栈,持久化最近 50 条
  promptHist = promptHist.filter((x) => x !== text); promptHist.push(text);
  if (promptHist.length > 50) promptHist.shift();
  localStorage.setItem("zh:prompt-hist", JSON.stringify(promptHist));
  histNav = -1;
  localStorage.removeItem("zh:draft:" + sid);
  if (sameView === false) { renderSendBtn(); return; }
  localStorage.removeItem("zh:draft:__new__");
  $("instruction").value = "";
  slashClose(); // 浮窗残留修复:同上——「/xxx 已有text」空态面板开着时发送,清空后必须同步收起
  autoGrow();
  renderSendBtn(); // fixI19:提交后输入清空,按钮语义复位(忙碌→停/空闲→发)
  switchView("chat");
  if (wasDraft) {
 // 草稿首条:乐观渲染用户消息(ZCode 乐观发送;附件卡同步带上),重放数据到达后替换
    histEvents = [{ kind: "message.user", payload: { text, ...(atts && atts.length ? { attachments: atts } : {}) } }];
    stStream = null; // 新 turn:旧流式尾块退役
    renderHistory();
 // 会话身份从无到有(submit 直接改 currentSid,没经过 openSession)→ 打灰激活门,
 // 让白板/追踪/吞吐/子代理流按新 sid 走一遍 onSessionChange(归属项目/卡头状态点一并校正)。
    try { onSessionChange(sid); } catch (e) { console.warn("[panel] 新会话切换失败", e); }
  }
  render();
 // 同 sid 追加任务也要重取一遍
  refreshPanelsAfterSubmit(sid);
}
/** m4 回包确认成功 → 立即发暂存的 task.submit。先摘链再发:同一 pending 只会派单一次,
 * 重复/广播回包到达时 draftSubmitPending 已空,直接 return(连点也不会双派)。 */
function draftSubmitFire() {
  const p = draftSubmitPending;
  if (!p) return;
  draftSubmitPending = null;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  const sameView = currentSid === p.sid;
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: p.sid, instruction: p.text, idempotencyKey: "web-" + p.text + Date.now(), ...(p.projectId ? { projectId: p.projectId } : {}), ...(p.atts && p.atts.length ? { attachments: p.atts } : {}) }));
  finishSubmit(p.sid, p.text, p.atts || [], true, sameView);
}
/** m4 拒绝/超时 → **不发** task.submit:回滚 pill + 报错(带失败原因),草稿文本与所选模型(draftModelRetry)全部保留,
 * 用户再点一次发送即按同一模型重试(不会静默降级成全局模型跑一轮)。 */
function draftModelAbort(why, effModel) {
  const p = draftSubmitPending;
  if (!p) return;
  draftSubmitPending = null;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
 // 摘链前先把在飞的选择捞出来存成重试料(旧 draftModelPick=pick 语义等价迁移)。
  const pickInFlight = sessionModelStaged.get(p.sid) || null;
  sessionModelStaged.delete(p.sid);
  const sameView = currentSid === p.sid;
 // 回草稿态:该 sid 没有任务,留着只会像卡住的空会话
  if (sameView) { currentSid = null; sessionStorage.removeItem("zh:sid"); localStorage.removeItem("zh:sid"); histEvents = []; sessionStatus = null; ssSeqBySid.delete(p.sid); }
  modelPillRollback(p.sid, effModel ? String(effModel) : null);
  lastSubmitText = ""; // 解除 3s 同文本防重复:否则用户立刻重试会被「3 秒内已提交过」再挡一次
 // 重试料只在「用户还看着这次提交的会话」时回填:draftModelRetry 只对草稿态有意义,
 // 用户已切到别的会话时回填会污染当前会话的 pill 与输入框。
  if (sameView) {
    draftModelRetry = pickInFlight && pickInFlight.model
      ? { model: pickInFlight.model, ...(pickInFlight.providerId ? { providerId: pickInFlight.providerId } : {}), ...(pickInFlight.effort !== undefined ? { effort: pickInFlight.effort } : {}) }
      : null; // 选择保留:重试用同一模型
    if (!$("instruction").value) { $("instruction").value = p.text; autoGrow(); } // 草稿文本保留(用户已改成别的就不覆盖)
    saveDraft();
    renderModelPill(cfgView);
    renderSendBtn();
    render();
  }
 // (块4·4.6):pending 摘链即摘等待禁点——sameView 分支的 renderSendBtn 已覆盖,但用户
 // 已切走(非 sameView)时当前视图按钮还挂着 wait-ack 禁点,必须显式复位(否则按钮永久不可点)。
  else renderSendBtn();
  toast("会话模型未确认,任务未发送:" + String(why).slice(0, 80) + "(草稿与所选模型已保留,可直接重试)", true);
}
$("go").onclick = () => { if (inChip) { chipSubmit(); return; } submit(); };

// ---- 侧聊 = Super Agent 通道(独立会话抽屉退役)----
// 点击侧聊把消息带入指挥台命令框(#sc-input),带来源标注,用户编辑后再发送(super.turn)。
function sideToSuper(label, text) {
  const inp = document.getElementById("sc-input");
  if (!inp) { toast("Super Agent 未就绪", true); return; }
  let t = String(text || "").trim();
  if (!t) { toast("没有可带入的内容", true); return; }
  if (t.length > 400) t = t.slice(0, 400) + "…(已截断)";
  inp.value = '【上下文·' + label + '】"' + t + '" ';
  if (inp.disabled) toast("Super Agent 正在回复;回复结束后可直接编辑发送");
  inp.focus();
  try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Super Agent 指挥台 view(#view-super)。
// 左=持久聊天渲染区(journal 回放:super.history → message.user/message.agent/super.notice/
// super.relay;刷新/重启不丢,day 卷分隔),右=调度看板四区(借鉴 ref/dsh-superagent-prototype
// docs/005-panel.md「三问」看板与 src/core/stage.ts「人先行」阶段:待人工置顶、计数=清单长度、
// 健康态不占位;数据全来自既有 WS,确定性聚合零 LLM)。
// 发送/动作协议与右下角 widget(super-console.js)同源:super.turn / super.inbox /
// ask.user.answer / permission.respond / task.resume;本视图与 widget 各自独立渲染,互不依赖。
// ─────────────────────────────────────────────────────────────────────────────
const supState = {
  entries: [],      // 聊天渲染条目:{kind:"u"|"a"|"sys"|"relay"|"day", text, ts, sid?}
  waiting: false,   // 一轮进行中(禁重复发送;turn.done/error 解除)
  inbox: [],        // SuperInboxItem[](super.inbox.result)
  dismissed: [],    // 本地忽略的 inbox id(localStorage 持久)
  nodes: null,      // nodes.list.result 载荷(看板④)
  histLoaded: false // 本页生命周期内已回放过历史(避免重复追加;刷新按钮强制重放)
};
function supEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function supClip(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function supHhmm(ms) {
  const d = new Date(typeof ms === "number" && isFinite(ms) ? ms : Date.now());
  return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}
/** super 固定会话 id:"super" 持久会话;旧按天日卷(super:YYYYMMDD)只读兼容不迁移。 */
function supDayLabel() {
  return "super";
}
/** 进入指挥台 view:头部会话标注 + 历史回放(首次;super.history 带 sinceSeq=0 全量) + 看板取数(inbox/nodes)+ 立即渲染。 */
function superViewLoad() {
  const day = document.getElementById("superSidDay");
  if (day) day.textContent = supDayLabel();
  if (!supState.histLoaded) {
    supState.histLoaded = true;
    wsSafeSend(JSON.stringify({ v: 1, type: "super.history", sinceSeq: 0 }));
  }
  wsSafeSend(JSON.stringify({ v: 1, type: "super.inbox", limit: 30 }));
  wsSafeSend(JSON.stringify({ v: 1, type: "nodes.list" }));
  supRenderChat(); supRenderBoard(); supIdeSideRender();
}
/* ── super IDE 三栏:侧栏两区(任务/做梦)+ 中栏路由(superIdeMain.open)────────────
 数据同源:任务区=supState.dispatch(submittedBy=super 实时帧+历史回放派发卡同源);做梦区=rsiLast(rsi.status 回包)。
 联动:点侧栏项/聊天流派发卡「详情」→ superIdeOpen("task"|"dream", id);WS task.changed/super.dream 同帧刷新。 */
var superIdeZone = "health"; // 活动栏当前区(task|dream|health; 健康一屏为默认)
var superIdeSel = { task: "", dream: "" }; // 各区最近选中(切区不改中栏内容)
function superIdeZoneSet(z) {
  superIdeZone = z === "dream" ? "dream" : (z === "health" ? "health" : "task");
  const vs = $("view-super");
  if (vs) { vs.classList.toggle("spide-zone-task", superIdeZone === "task"); vs.classList.toggle("spide-zone-dream", superIdeZone === "dream"); vs.classList.toggle("spide-zone-health", superIdeZone === "health"); }
  const btns = document.querySelectorAll("#superIdeAct .spide-actbtn");
  for (let i = 0; i < btns.length; i++) btns[i].classList.toggle("on", String(btns[i].dataset.spidezone || "") === superIdeZone);
  supIdeSideRender();
  superHealthRender(); // 健康一屏随区渲染(数据 rsiLast;无数据走空态引导)
  if (superIdeZone === "health") superIdeOpen("health"); // 点「健」直接进健康一屏(侧栏无需先选条目)
}
/* ── 健康一屏渲染(纯前端聚合;数据=rsi.status 同一份 rsiLast)────────────────
 层级:结论层(健康度+三色计数+Top3)→ 解释层(12 体检卡一句话)→ 证据层(点卡进做梦明细)。
 健康度=100−25×bad−8×warn(下限 0);idle(未启用)不罚分;待处理=warn+bad。
 纪律:全部文本过 esc;无内联 onclick(事件委托绑一次);无数据/字段缺失一律降级不抛错。 */
function rsiHealthKind(sec) {
  if (rsiSecStatus(sec) === "ok") return "ok";
  var c = String((sec && (sec.code !== undefined ? sec.code : sec.codeText)) || "");
  if (c === "UNAVAILABLE") return "idle";
  return /ERROR|CONFLICT|FAILED|PAUSED|STORE_BAD/.test(c) ? "bad" : "warn";
}
function rsiHealthAgg(sections) {
  var secs = Array.isArray(sections) ? sections : [];
  var agg = { total: secs.length, ok: 0, warn: 0, bad: 0, idle: 0, pending: 0, score: 100, findings: [], costTokens: 0, costCny: 0, costMissing: 0, hasCost: false, lastRunAt: 0 };
  var badFindings = [], warnFindings = [], i, j, s, kind, run, cost, at, items, it, text, warning;
  for (i = 0; i < secs.length; i++) {
    s = secs[i] || {}; kind = rsiHealthKind(s);
    agg[kind] = (agg[kind] || 0) + 1;
    if (kind === "warn" || kind === "bad") {
      agg.pending++;
      warning = Array.isArray(s.warnings) && s.warnings.length ? String(s.warnings[0]) : "";
      items = Array.isArray(s.items) ? s.items : [];
      for (j = 0; j < items.length; j++) {
        it = items[j] || {};
        text = String(it.summary !== undefined && it.summary !== null && String(it.summary).trim() !== "" ? it.summary : (it.title !== undefined && it.title !== null ? it.title : "")).trim();
        if (!text) continue;
        (kind === "bad" ? badFindings : warnFindings).push({ kind: kind, mech: rsiSecId(s), title: String(it.title !== undefined && it.title !== null && String(it.title).trim() !== "" ? it.title : (s.title !== undefined ? s.title : rsiSecId(s))), text: text });
        break; // 每机制只取首条发现
      }
      if (!items.length && warning) (kind === "bad" ? badFindings : warnFindings).push({ kind: kind, mech: rsiSecId(s), title: String(s.title !== undefined ? s.title : rsiSecId(s)), text: warning });
    }
    run = rsiRunOf(s);
    if (run) {
      cost = run.cost && typeof run.cost === "object" ? run.cost : null;
      if (cost) {
        agg.hasCost = true;
        agg.costTokens += Number(cost.totalTokens) || 0;
        if (cost.amountCny === null || cost.amountCny === undefined) agg.costMissing++;
        else agg.costCny += Number(cost.amountCny) || 0;
      }
      at = run.finishedAt !== undefined && run.finishedAt !== null ? run.finishedAt : run.startedAt;
      if (typeof at === "number" && at > agg.lastRunAt) agg.lastRunAt = at;
    }
  }
  agg.score = Math.max(0, Math.min(100, 100 - 25 * agg.bad - 8 * agg.warn));
  agg.findings = badFindings.concat(warnFindings).slice(0, 3);
  return agg;
}
function rsiHealthScoreClass(agg) {
  if (agg.total > 0 && agg.ok + agg.warn + agg.bad === 0) return "idle"; // 12 区全未启用:中性灰,不装成异常
  if (agg.score >= 90) return "ok";
  return agg.score >= 70 ? "warn" : "bad";
}
function rsiHealthAgo(ts) {
  if (typeof ts !== "number" || ts <= 0) return "未运行";
  var d = Date.now() - ts;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  return Math.floor(d / 86400000) + " 天前";
}
function rsiHealthCostText(agg) {
  if (!agg.hasCost) return "近一次运行无成本记录";
  var money = agg.costMissing > 0 ? (agg.costCny > 0 ? "¥" + agg.costCny.toFixed(2) + "+单价缺失" : "单价缺失") : "¥" + agg.costCny.toFixed(2);
  return money + " · " + rsiTok(agg.costTokens) + " tokens";
}
function rsiHealthTopHtml(agg, loading) {
  if (loading) return '<div class="spide-health-top spide-health-loading">正在加载体检数据…(rsi.status)</div>';
  if (!agg.total) return '<div class="spide-health-empty">还没有体检数据——点「全量运行」让 Super 做一次全身扫描。<button class="vw-act" data-health-act="runall">全量运行</button><button class="vw-act" data-health-act="refresh" title="重新拉取 rsi.status">刷新</button></div>';
  var allIdle = agg.ok + agg.warn + agg.bad === 0; // 12 区全未启用:不显示 100 分(避免把"没数据"当成"全健康")
  var sc = rsiHealthScoreClass(agg), f = [], i, x;
  for (i = 0; i < agg.findings.length; i++) {
    x = agg.findings[i];
    f.push('<div class="spide-health-f t-' + x.kind + '"><span class="fdot"></span><span class="ft">' + esc(String(x.title)) + '</span><span class="fs" title="' + esc(String(x.text)) + '">' + esc(rsiCut(String(x.text), 60)) + '</span></div>');
  }
  if (!f.length) f.push(allIdle
    ? '<div class="spide-health-f t-idle"><span class="fdot"></span><span class="ft">全部未启用</span><span class="fs">运行任意机制后产生体检数据</span></div>'
    : '<div class="spide-health-f t-ok"><span class="fdot"></span><span class="ft">全部正常</span><span class="fs">没有需要处理的机制</span></div>');
  return '<div class="spide-health-top">' +
    '<div class="spide-health-score s-' + sc + '">' + (allIdle ? "—" : agg.score) + '<span style="font-size:12px;font-weight:500;color:var(--faint,#7d6c58)">' + (allIdle ? "未启用" : "/100") + '</span></div>' +
    '<div class="spide-health-bar"><i class="s-' + sc + '" style="width:' + (allIdle ? 0 : agg.score) + '%"></i></div>' +
    '<div class="spide-health-counts"><span class="c-ok">正常 <b>' + agg.ok + '</b></span><span class="c-warn">关注 <b>' + agg.warn + '</b></span><span class="c-bad">异常 <b>' + agg.bad + '</b></span><span class="c-idle">未启用 <b>' + agg.idle + '</b></span></div>' +
    '<div class="spide-health-dream">最近做梦 ' + esc(rsiHealthAgo(agg.lastRunAt)) + ' · ' + esc(rsiHealthCostText(agg)) + '</div>' +
    '<div class="spide-health-findings">' + f.join("") + '</div>' +
    '<div class="spide-health-pending">待处理 ' + agg.pending + ' 条</div>' +
    '<button class="vw-act" data-health-act="refresh" title="重新拉取 rsi.status">刷新</button></div>';
}
/** 体检卡结论行:优先 item.title(短结论),其次首句摘要;按句号/分号截断,避免卡片变成文件分析长文。 */
function rsiCardLead(text, max) {
  var s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
  var m = s.search(/[。；;]/);
  if (m > 0 && m <= max) s = s.slice(0, m);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
function renderMechCards(sections, loading) {
  var secs = Array.isArray(sections) ? sections : [], out = [], i, j;
  if (loading) return '<div class="spide-health-empty spide-health-loading" style="grid-column:1/-1">正在加载 12 个机制状态…</div>';
  if (!secs.length) return '<div class="spide-health-empty" style="grid-column:1/-1">暂无机制数据(点「全量运行」后自动更新)</div>';
  for (i = 0; i < secs.length; i++) {
    var s = secs[i] || {}, kind = rsiHealthKind(s), sid = rsiSecId(s) || ("sec" + i);
    var title = s.title !== undefined ? s.title : (s.name !== undefined ? s.name : sid);
    var badge = kind === "ok" ? "正常" : kind === "warn" ? "关注" : kind === "bad" ? "异常" : "未启用";
    var items = Array.isArray(s.items) ? s.items : [];
    var item0 = items[0] || {};
    var itemTitle = String(item0.title === undefined || item0.title === null ? "" : item0.title).trim();
    var itemSummary = String(item0.summary === undefined || item0.summary === null ? "" : item0.summary).trim();
    var lead = items.length ? (itemTitle !== "" ? itemTitle : rsiCardLead(itemSummary, 80)) : (Array.isArray(s.warnings) && s.warnings.length ? String(s.warnings[0]) : (kind === "idle" ? "未产生数据(运行对应 RSI 任务后自动更新)" : "暂无结果条目"));
    var sub = items.length && itemSummary !== "" && itemSummary !== itemTitle ? rsiCardLead(itemSummary, 96) : "";
    var kv = [], ms = Array.isArray(s.metrics) ? s.metrics : [];
    for (j = 0; j < ms.length && kv.length < 2; j++) {
      var m = ms[j] || {};
      if (m.label === undefined || m.label === null || m.label === "") continue;
      kv.push('<span>' + esc(String(m.label)) + ' <b>' + esc(String(m.value)) + (m.unit !== undefined && m.unit !== null ? esc(String(m.unit)) : "") + '</b></span>');
    }
    var run = rsiRunOf(s), cost = run && run.cost && typeof run.cost === "object" ? run.cost : null;
    var costLine = cost ? ((cost.amountCny === null || cost.amountCny === undefined) ? "单价缺失" : "¥" + Number(cost.amountCny).toFixed(2)) + " · " + rsiTok(cost.totalTokens) + " tokens" : "";
    out.push('<div class="spide-mcard" data-mech="' + esc(sid) + '" title="点击查看机制详情">' +
      '<div class="spide-mcard-h"><span class="mdot s-' + kind + '"></span><span class="mname">' + esc(String(title)) + '</span><span class="mlabel">' + badge + '</span></div>' +
      '<div class="spide-mcard-lead l-' + kind + '">' + esc(rsiCut(lead, 80)) + '</div>' +
      (sub ? '<div class="spide-mcard-sub">' + esc(sub) + '</div>' : '') +
      (kv.length ? '<div class="spide-mcard-kv">' + kv.join("") + '</div>' : '') +
      (costLine ? '<div class="spide-mcard-cost">' + esc(costLine) + '</div>' : '') + '</div>');
  }
  return out.join("");
}
function rsiHealthSideHtml(sections, loading) {
  if (loading) return '<div class="spide-empty">正在加载…</div>';
  var secs = Array.isArray(sections) ? sections : [], rows = [], i;
  for (i = 0; i < secs.length; i++) {
    var s = secs[i] || {}, kind = rsiHealthKind(s);
    if (kind !== "warn" && kind !== "bad") continue;
    var sid = rsiSecId(s) || ("sec" + i);
    var title = s.title !== undefined ? s.title : sid;
    rows.push('<div class="spide-item" data-health-mech="' + esc(sid) + '" title="打开机制详情"><span class="sup-badge ' + (kind === "bad" ? "failed" : "queued") + '">' + (kind === "bad" ? "异常" : "关注") + '</span><span class="sup-it">' + esc(String(title)) + '</span></div>');
    if (rows.length >= 6) break;
  }
  return rows.length ? rows.join("") : (secs.length ? '<div class="spide-empty">全部机制正常,无待处理项。</div>' : '<div class="spide-empty">暂无机制数据。</div>');
}
function superHealthRender() {
  var top = $("superHealthTop"), grid = $("superHealthGrid");
  if (!top && !grid) return; // 面板不在场:静默返回(不得抛错)
  var loaded = rsiLast !== null && rsiLast !== undefined;
  var raw = loaded && rsiLast.sections !== undefined ? rsiLast.sections : (loaded && rsiLast.data ? rsiLast.data.sections : undefined);
  var secs = Array.isArray(raw) ? raw : [];
  var err = loaded && rsiLast && rsiLast.error !== undefined && rsiLast.error !== null && String(rsiLast.error) !== "" ? String(rsiLast.error) : "";
  var loading = !loaded && !err; // 从未收到 rsi.status:加载中(不能伪装成"无数据/全正常")
  var agg = rsiHealthAgg(secs);
  if (top) top.innerHTML = err
    ? '<div class="spide-health-empty spide-health-error">RSI 状态读取失败:' + esc(rsiCut(err, 160)) + '<button class="vw-act" data-health-act="refresh">重试</button></div>'
    : rsiHealthTopHtml(agg, loading);
  if (grid) grid.innerHTML = err ? "" : renderMechCards(secs, loading);
  var cnt = $("superSbHealthCnt"); if (cnt) cnt.textContent = loading ? "…" : String(secs.length);
  var list = $("superSbHealthList"); if (list) list.innerHTML = err ? '<div class="spide-empty">读取失败,点上方重试。</div>' : rsiHealthSideHtml(secs, loading);
  var hint = $("superSbHealthHint");
  if (hint) hint.textContent = loading ? "正在读取 rsi.status…" : (err ? "读取失败;点「重试」重新拉取。" : (agg.total ? ("健康度 " + (agg.ok + agg.warn + agg.bad === 0 ? "—" : agg.score + "/100") + " · 待处理 " + agg.pending + " 条 · 点卡片看机制详情") : "还没有体检数据;点「全量运行」让 Super 做一次全身扫描。"));
 // 事件委托绑一次:体检卡/侧栏项→做梦明细;空态「全量运行」→rsiRunAllFire
  if (grid && !grid.__healthBound) {
    grid.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-mech]") : null;
      if (!el) return;
      superIdeZoneSet("dream");
      superIdeOpen("dream", String(el.getAttribute("data-mech") || ""));
    });
    grid.__healthBound = true;
  }
  if (list && !list.__healthBound) {
    list.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest("[data-health-mech]") : null;
      if (!el) return;
      superIdeZoneSet("dream");
      superIdeOpen("dream", String(el.getAttribute("data-health-mech") || ""));
    });
    list.__healthBound = true;
  }
  if (top && !top.__healthBound) {
    top.addEventListener("click", function (ev) {
      var t = ev.target;
      var run = t && t.closest ? t.closest('[data-health-act="runall"]') : null;
      if (run) { rsiRunAllFire(); return; }
      var ref = t && t.closest ? t.closest('[data-health-act="refresh"]') : null;
      if (ref) rsiStatusPull();
    });
    top.__healthBound = true;
  }
  var allBtnH = $("rsiRunAllH");
  if (allBtnH) {
    if (!allBtnH.__healthRunBound) { allBtnH.onclick = function () { rsiRunAllFire(); }; allBtnH.__healthRunBound = true; }
    var anyRunning = false, pk, rr;
    for (pk in rsiPending) if (Date.now() - rsiPending[pk] < 20000) anyRunning = true;
    for (var i = 0; i < secs.length; i++) { rr = rsiRunOf(secs[i] || {}); if (rr && String(rr.status) === "running") anyRunning = true; }
    allBtnH.disabled = loading || err !== "" || anyRunning;
  }
}
/** 任务状态 → 人话徽标(排队/运行/完成/失败)。 */
function superIdeStLabel(st) {
  const s = String(st || "?");
  if (s === "running") return "运行";
  if (s === "queued") return "排队";
  if (s === "done") return "完成";
  if (s === "failed") return "失败";
  return s;
}
/** 侧栏任务列表:supState.dispatch 按更新时间倒序(数据同源派发卡)。 */
function superIdeTaskListHtml() {
  const ids = Object.keys(supState.dispatch || {});
  if (!ids.length) return '<div class="spide-empty">还没有 super 派发的任务。在右侧对话窗说「帮我派一个任务…」,派发后会出现在这里。</div>';
  const list = ids.map((id) => supState.dispatch[id]).filter(Boolean);
  list.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const rows = [];
  for (const t of list.slice(0, 50)) {
    const id = String(t.id || "");
    const st = String(t.state || "?");
    rows.push('<div class="spide-item' + (superIdeSel.task === id ? " on" : "") + '" data-ideopen="task" data-id="' + supEsc(id) + '" title="' + supEsc(t.title || "") + ' · ' + supEsc(st) + '">' +
      '<span class="sup-badge ' + supEsc(st) + '">' + supEsc(superIdeStLabel(st)) + "</span>" +
      '<span class="sup-it">' + supEsc(supClip(String(t.title || t.instruction || "(未命名)"), 40)) + "</span></div>");
  }
  return rows.join("");
}
/** 侧栏做梦机制列表:rsiLast 一拍渲染(开关态徽标);选中=中栏做梦报告。 */
function superIdeDreamListHtml() {
  if (!rsiLast) return '<div class="spide-empty">做梦机制状态加载中(rsi.status 15s 轮询)…</div>';
  const raw = rsiLast.sections !== undefined ? rsiLast.sections : (rsiLast.data ? rsiLast.data.sections : undefined);
  const secs = Array.isArray(raw) ? raw : [];
  if (!secs.length) return '<div class="spide-empty">暂无 RSI 数据。</div>';
  const rows = [];
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i] || {};
    const id = rsiSecId(s) || ("sec" + i);
    const title = s.title !== undefined ? s.title : (s.name !== undefined ? s.name : id);
    const en = rsiOptMerge(id, rsiSecEnabled(s), rsiSecDriver(s)).en;
    const run = rsiRunOf(s), running = run && String(run.status) === "running";
    rows.push('<div class="spide-item' + (superIdeSel.dream === id ? " on" : "") + '" data-ideopen="dream" data-id="' + supEsc(id) + '" title="' + supEsc(String(title)) + '">' +
      '<span class="sup-badge ' + (running ? "running" : en ? "done" : "queued") + '">' + (running ? "运行" : en ? "启用" : "停用") + "</span>" +
      '<span class="sup-it">' + supEsc(supClip(String(title), 40)) + "</span></div>");
  }
  return rows.join("");
}
/** 侧栏整体重渲(两区列表+计数);空态兜底不抛错。 */
function supIdeSideRender() {
  const tl = $("superSbTaskList"), dl = $("superSbDreamList");
  if (tl) tl.innerHTML = superIdeTaskListHtml();
  if (dl) dl.innerHTML = superIdeDreamListHtml();
  const ids = Object.keys(supState.dispatch || {});
  const tc = $("superSbTaskCnt"); if (tc) tc.textContent = String(ids.length);
  if (rsiLast) {
    const raw = rsiLast.sections !== undefined ? rsiLast.sections : (rsiLast.data ? rsiLast.data.sections : undefined);
    const dc = $("superSbDreamCnt"); if (dc) dc.textContent = String((Array.isArray(raw) ? raw : []).length);
  }
}
/** 中栏路由:健康一屏(默认)/任务详情/做梦报告;kind=空=回欢迎态。 */
function superIdeOpen(kind, id) {
  const vs = $("view-super");
  if (!vs) return;
  vs.classList.remove("spide-open-task", "spide-open-dream", "spide-open-health");
  if (kind === "task") {
    superIdeSel.task = String(id || "");
    const box = $("superMainTask");
    if (box) box.innerHTML = superIdeTaskDocHtml(superIdeSel.task);
    vs.classList.add("spide-open-task");
  } else if (kind === "dream") {
    superIdeSel.dream = String(id || "");
    vs.classList.add("spide-open-dream");
    if (rsiLast) rsiRender(rsiLast); // 中栏做梦报告用既有渲染(rsiCards 内容同源;选中机制卡高亮由 rsiRender 后置)
  } else if (kind === "health") { // 健康一屏:聚合 rsiLast 渲染总览+网格(无数据=空态引导)
    vs.classList.add("spide-open-health");
    superHealthRender();
  } else {
    superIdeSel.task = ""; superIdeSel.dream = "";
  }
  supIdeSideRender();
}
/** 中栏任务详情:标题/状态徽标/目标 session/过程摘要+「打开会话」按钮(跳目标 session)。 */
function superIdeTaskDocHtml(id) {
  const t = (supState.dispatch || {})[String(id || "")];
  if (!t) return '<div class="spide-doc-h"><button class="spide-back" data-ideback="1">← 返回</button></div><div class="sup-empty">任务不存在或已被清理(WS 实时帧未到/重启后等 super.history 回放)。</div>';
  const st = String(t.state || "?");
  const summary = st === "done" || st === "failed" ? String(t.result || "") : String(t.title || t.instruction || "");
  return '<div class="spide-doc-h"><button class="spide-back" data-ideback="1">← 返回</button>' +
    '<span class="sup-badge ' + supEsc(st) + '">' + supEsc(superIdeStLabel(st)) + "</span>" +
    supEsc(supClip(String(t.title || t.instruction || "(未命名)"), 80)) +
    '<span class="sup-mono">' + supEsc(supHhmm(t.updatedAt)) + "</span>" +
    (t.sessionId ? '<button class="vw-act" data-supact="open" data-sid="' + supEsc(t.sessionId) + '">打开会话 ' + supEsc(t.sessionId) + "</button>" : "") +
    "</div>" +
    '<div class="sup-sec"><div class="sup-sec-h">过程摘要</div>' +
    '<div class="sup-sum">' + supEsc(supClip(summary || "(暂无摘要;任务运行中,完成后 task.changed 会同帧刷新这里)", 600)) + "</div>" +
    (t.instruction ? '<div class="sup-sec-h" style="margin-top:8px">任务书</div><div class="sup-sum">' + supEsc(supClip(String(t.instruction), 800)) + "</div>" : "") +
    "</div>";
}
/** 指挥台总入口(侧栏 act-super / widget ▦ / genie:open-super 事件共用):画布态先退经典。 */
function superOpen() {
  switchView("super"); // switchView 内已对 super 族退经典(画布安全区装不下三栏);经典态此调用为纯激活
  setTimeout(() => { const i = document.getElementById("superInput"); if (i) i.focus(); }, 60);
}
/** super.history.result → 渲染条目(journal 事件回放;kinds: message.user/message.agent/super.notice/
 * super.relay/super.dream;message.agent 的 toolCalls/tool.result 合并进条目供 supToolResOf 预扫)。 */
function supApplyHistory(events) {
  const out = [];
  let lastSid = "";
  const toolRes = []; // tool.result 事件收集(供 assistant 卡调用点即见结果)
  for (const e of (Array.isArray(events) ? events : [])) {
    const kind = String(e && (e.kind || e.type) || "");
    const sid = String(e && e.sessionId || "");
    const p = (e && e.payload) || {};
    const ts = typeof (e && e.time) === "number" ? e.time : (typeof (e && e.ts) === "number" ? e.ts : undefined);
    if (kind === "tool.result") { toolRes.push({ toolCallId: String(p.toolCallId || ""), name: String(p.name || ""), content: String(p.content || ""), durationMs: Number(p.durationMs || 0) }); continue; }
    if (sid && sid !== lastSid) { out.push({ kind: "day", text: sid, ts }); lastSid = sid; }
    if (kind === "message.user") out.push({ kind: "u", text: String(p.text || ""), ts, sid });
    else if (kind === "message.agent") out.push({ kind: "a", text: String(p.text || ""), reasoning: String(p.reasoning || ""), llmMs: Number(p.llmMs || 0), toolCalls: Array.isArray(p.toolCalls) ? p.toolCalls : null, ts, sid });
    else if (kind === "super.notice" || kind === "companion.notice") out.push({ kind: "sys", text: "[通知] " + String(p.text || ""), ts, sid });
    else if (kind === "super.relay" || kind === "companion.relay") out.push({ kind: "relay", text: String(p.text || ""), ts, sid });
    else if (kind === "super.dream") out.push({ kind: "dream", payload: p, ts, sid }); // 做梦卡回放
  }
 // 工具结果回填:挂到最后一条带 toolCalls 的 assistant 条目(全量重放先扫后用,主聊天 fixH12 同语义)
  if (toolRes.length) for (let i = out.length - 1; i >= 0; i--) if (out[i].kind === "a" && out[i].toolCalls) { out[i].toolResults = toolRes; break; }
  supState.entries = out.slice(-400); // 上限护栏:超长历史只渲染尾部(journal 全量仍在,可再刷新重放)
  supRenderChat();
}
/* supRenderChat 已上移(与派发卡/做梦卡渲染同段; 聊天窗主线)。 */
/** 看板四区(待人工 / 工作区×任务 / 活跃流 / 系统健康)——全部从已在场状态确定性聚合。 */
function supRenderBoard() {
 // ① 待你处理(人先行:ask/permission/interrupted/blocked 在前,failed 收尾——服务端已排序)
  const dismissed = supState.dismissed;
  const items = supState.inbox.filter((it) => it && it.id && dismissed.indexOf(it.id) < 0);
  const inboxEl = document.getElementById("supInbox");
  if (inboxEl) {
    inboxEl.innerHTML = items.length ? items.map(function (it) {
      const acts = Array.isArray(it.actions) && it.actions.length ? it.actions : null;
      const can = (a) => !acts || acts.indexOf(a) >= 0;
      const btns = [];
      const k = String(it.kind || "ask");
      if (k === "ask" && can("answer")) btns.push('<button class="sup-btn pri" data-supact="answer" data-id="' + supEsc(it.id) + '">回答</button>');
      if (k === "permission") {
        btns.push('<button class="sup-btn pri" data-supact="permit" data-d="allow-once" data-id="' + supEsc(it.id) + '">批准</button>');
        btns.push('<button class="sup-btn" data-supact="permit" data-d="reject" data-id="' + supEsc(it.id) + '">拒绝</button>');
      }
      if ((k === "interrupted" || k === "blocked") && can("resume")) btns.push('<button class="sup-btn pri" data-supact="resume" data-id="' + supEsc(it.id) + '">恢复</button>');
      if (it.sessionId) btns.push('<button class="sup-btn" data-supact="open" data-sid="' + supEsc(it.sessionId || "") + '">打开会话</button>');
      btns.push('<button class="sup-btn mut" data-supact="dismiss" data-id="' + supEsc(it.id) + '">忽略</button>');
      return '<div class="sup-row' + (k === "failed" ? " hot" : "") + '" data-supitem="' + supEsc(it.id) + '">' +
        '<div class="sup-row-h"><span class="sup-badge ' + supEsc(k) + '">' + supEsc(k) + '</span>' +
        '<span class="sup-it" title="' + supEsc(it.title || "") + '">' + supEsc(supClip(it.title || "(未命名)", 70)) + "</span>" +
        '<span class="sup-mono">' + supEsc(supHhmm(it.since)) + "</span></div>" +
        (it.summary ? '<div class="sup-sum">' + supEsc(supClip(it.summary, 200)) + "</div>" : "") +
        (btns.length ? '<div class="sup-acts">' + btns.join("") + "</div>" : "") + "</div>";
    }).join("") : '<div class="sup-empty">没有需要你处理的事。</div>';
  }
  const cnt = document.getElementById("supInboxCnt");
  if (cnt) cnt.textContent = items.length ? "· " + items.length : "";
 // ② 工作区 × 任务矩阵(每区最近 3 条;▶ running / ✗ failed / · 其余;点击 openSession)
  const projEl = document.getElementById("supProjects");
  if (projEl) {
    const list = Array.isArray(projects) ? projects : [];
    const rows = [];
    const byProj = (pid) => [...tasks.values()].filter((t) => (t.projectId || "__harness__") === pid)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3);
    for (const p of list) {
      const recent = byProj(p.id);
      rows.push('<div class="sup-proj-h"><span class="sup-proj-t">' + supEsc(p.label || p.id) + "</span>" +
        (p.availability && p.availability !== "available" ? '<span class="sup-badge">' + supEsc(p.availability) + "</span>" : "") +
        (p.path && /^remote:(ssh|wsl):/.test(String(p.path)) ? '<span class="sup-badge">远程</span>' : "") + "</div>");
      if (!recent.length) { rows.push('<div class="sup-empty" style="padding-left:8px">近期无任务</div>'); continue; }
      for (const t of recent) {
        const st = String(t.state || "?");
        const mark = st === "running" ? "▶" : st === "failed" ? "✗" : st === "done" ? "✓" : "·";
        rows.push('<div class="sup-row click" data-supact="open" data-sid="' + supEsc(t.sessionId || "") + '" title="' + supEsc(t.title || "") + ' · ' + supEsc(st) + '">' +
          '<div class="sup-row-h"><span class="sup-badge ' + supEsc(st) + '">' + mark + " " + supEsc(st) + "</span>" +
          '<span class="sup-it">' + supEsc(supClip(t.title || "", 60)) + "</span>" +
          '<span class="sup-mono">' + supEsc(supHhmm(t.updatedAt)) + "</span></div></div>");
      }
    }
    if (!list.length) rows.push('<div class="sup-empty">尚未打开项目:侧栏「+ 添加项目」或让我 project_add。</div>');
    projEl.innerHTML = rows.join("");
  }
 // ③ 活跃任务流(running/queued;group 相同聚类=联调组)
  const actEl = document.getElementById("supActive");
  if (actEl) {
    const active = [...tasks.values()].filter((t) => t.state === "running" || t.state === "queued")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const groups = new Map();
    for (const t of active) {
      const g = t.group ? String(t.group) : "";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const rows = [];
    for (const [g, ts] of groups) {
      if (g) rows.push('<div class="sup-proj-h"><span class="sup-proj-t">组 · ' + supEsc(g) + "(联调/同批)</span></div>");
      for (const t of ts) {
        rows.push('<div class="sup-row click" data-supact="open" data-sid="' + supEsc(t.sessionId || "") + '">' +
          '<div class="sup-row-h"><span class="sup-badge ' + supEsc(t.state) + '">' + supEsc(t.state) + "</span>" +
          '<span class="sup-it">' + supEsc(supClip(t.title || "", 60)) + "</span>" +
          (t.projectId ? '<span class="sup-mono">' + supEsc(supClip(pLabel(t.projectId), 14)) + "</span>" : "") + "</div></div>");
      }
    }
    actEl.innerHTML = rows.length ? rows.join("") : '<div class="sup-empty">没有进行中的任务。派活:直接对我说,或走各工作区会话。</div>';
    const acnt = document.getElementById("supActiveCnt");
    if (acnt) acnt.textContent = active.length ? "· " + active.length : "";
  }
 // ④ 系统健康(健康态不占位:无异常的项收成一行;借鉴 dsh-superagent「Healthy states take no extra space」)
  const healthEl = document.getElementById("supHealth");
  if (healthEl) {
    const rows = [];
    const all = [...tasks.values()];
    const running = all.filter((t) => t.state === "running").length;
    const failed24 = all.filter((t) => t.state === "failed" && Date.now() - (t.updatedAt || 0) <= 24 * 3600_000).length;
    rows.push('<div class="sup-row"><div class="sup-row-h"><span class="sup-it">任务:运行 ' + running + " · 24h 失败 " + failed24 + " · 总 " + all.length + "</span></div></div>");
    if (supState.nodes) {
      const ns = Array.isArray(supState.nodes.nodes) ? supState.nodes.nodes : [];
      const online = ns.filter((n) => n.online !== false).length;
      rows.push('<div class="sup-row"><div class="sup-row-h"><span class="sup-it">节点:' + online + "/" + ns.length + " 在线" + (ns.length ? "(" + supEsc(ns.map((n) => n.nodeId).slice(0, 4).join(", ")) + ")" : "(无登记;跨机联调需先在目标机跑 node-agent)") + "</span></div></div>");
    }
    const remotes = (Array.isArray(projects) ? projects : []).filter((p) => p.path && /^remote:(ssh|wsl):/.test(String(p.path)));
    if (remotes.length) {
      const bad = remotes.filter((p) => p.availability && p.availability !== "available");
      rows.push('<div class="sup-row"><div class="sup-row-h"><span class="sup-it">远程项目:' + remotes.length + " 个" + (bad.length ? " · " + bad.length + " 不可用(" + supEsc(bad.map((p) => p.label || p.id).join(", ")) + ")" : " · 全部可用") + "</span></div></div>");
    }
    healthEl.innerHTML = rows.join("");
  }
}
function pLabel(pid) {
  const p = (Array.isArray(projects) ? projects : []).find((x) => x.id === pid);
  return (p && (p.label || p.id)) || String(pid || "").slice(0, 12);
}
/** 发送一轮 super.turn:等待态由 turn.user 广播回显用户气泡,done 广播回填回复(error 清等待)。 */
function supSend() {
  const inp = document.getElementById("superInput");
  if (!inp || supState.waiting) return;
  const text = String(inp.value || "").trim();
  if (!text) return;
 // 显式 sessionId="super"(固定持久会话;与 server superSessionId 同源;旧缺省行为不变)
  if (!wsSafeSend(JSON.stringify({ v: 1, type: "super.turn", text, sessionId: "super" }))) { toast("连接未就绪", true); return; }
  inp.value = "";
  supState.waiting = true;
  supRenderChat();
}
/** 指挥台相关 WS 帧(super.* + super-failed error)统一入口;wsOnMessage 早退分支调用。 */
function superOnMsg(m) {
  if (m.type === "super.history.result") { supApplyHistory(m.events); return; }
  if (m.type === "super.turn.user") {
    supState.entries.push({ kind: "u", text: String(m.text || ""), ts: Date.now(), sid: supDayLabel() });
    supRenderChat();
    return;
  }
  if (m.type === "super.turn.done") {
    supState.waiting = false;
    supState.entries.push({ kind: "a", text: String(m.text || ""), ts: Date.now(), sid: String(m.sessionId || supDayLabel()) });
    supRenderChat();
    return;
  }
  if (m.type === "super.notice") {
    supState.entries.push({ kind: "sys", text: "[通知] " + String(m.text || ""), ts: Date.now() });
    supRenderChat();
    supPullInboxSoft();
    return;
  }
  if (m.type === "super.relay") {
    supState.entries.push({ kind: "relay", text: String(m.question || m.text || "") + (Array.isArray(m.options) && m.options.length ? "(选项:" + m.options.join(" / ") + ")" : ""), ts: Date.now() });
    supRenderChat();
    supPullInboxSoft();
    return;
  }
  if (m.type === "super.inbox.result") { supState.inbox = Array.isArray(m.items) ? m.items : []; supRenderBoard(); return; }
  if (m.type === "super.inbox.changed") { supPullInboxSoft(); return; }
  if (m.type === "super.dream") { // 做梦卡:机制运行开始/完成广播(journal 同帧落 super 会话;刷新可回放)
    supState.entries.push({ kind: "dream", payload: { phase: m.phase, mechanismId: m.mechanismId, runId: m.runId, taskId: m.taskId, title: m.title, cost: m.cost, summary: m.summary }, ts: Date.now() });
    if (supState.entries.length > 400) supState.entries = supState.entries.slice(-400);
    supRenderChat();
    supIdeSideRender(); // 做梦完成 → 侧栏机制列表同帧刷新(成本/最近运行由 15s rsi.status 轮询追平)
    return;
  }
}
function supPullInboxSoft() {
  if (document.body.dataset.view === "super") wsSafeSend(JSON.stringify({ v: 1, type: "super.inbox", limit: 30 }));
}
function supOnError(m) {
 // 服务端 super-failed/super-announce-failed:清等待气泡,聊天区显式报错(对齐 widget error 分支)。
  supState.waiting = false;
  supState.entries.push({ kind: "sys", text: "[出错] 调度中枢:" + supClip(String(m.message || m.code || "未知错误"), 200), ts: Date.now() });
  supRenderChat();
}
/** 看板动作(事件委托):回答/批准/恢复/打开会话/忽略;语义与 widget 同源,协议零新增。 */
function supBoardClick(ev) {
  const t = ev.target;
  const btn = t && t.closest ? t.closest("[data-supact]") : null;
  if (!btn) return;
  const act = btn.dataset.supact;
  if (act === "dismiss") {
    const id = btn.dataset.id || "";
    if (id && supState.dismissed.indexOf(id) < 0) supState.dismissed.push(id);
    try { localStorage.setItem("sup:viewDismissed", JSON.stringify(supState.dismissed.slice(-300))); } catch (_) {}
    supRenderBoard();
    return;
  }
  if (act === "open") { const sid = btn.dataset.sid || ""; if (sid) openSession(sid); return; }
  if (act === "resume") {
    const it = supState.inbox.find((x) => x.id === btn.dataset.id);
    if (it && it.taskId) { wsSafeSend(JSON.stringify({ v: 1, type: "task.resume", taskId: it.taskId })); toast("已请求恢复任务"); }
    return;
  }
  if (act === "permit") {
    const it = supState.inbox.find((x) => x.id === btn.dataset.id);
    if (it && it.requestId) {
      wsSafeSend(JSON.stringify({ v: 1, type: "permission.respond", requestId: it.requestId, decision: btn.dataset.d || "allow-once" }));
      supState.inbox = supState.inbox.filter((x) => x.id !== it.id);
      supRenderBoard();
      toast(btn.dataset.d === "reject" ? "已拒绝" : "已批准");
    }
    return;
  }
  if (act === "answer") {
 // 行内回答输入框(ask 类):回车/发送 → ask.user.answer(与 widget answerAsk 同协议)。
    const row = btn.closest("[data-supitem]");
    if (!row || row.querySelector(".sup-answer")) return;
    const wrap = document.createElement("div");
    wrap.className = "sup-answer";
    wrap.innerHTML = '<input placeholder="输入回答…" autocomplete="off" spellcheck="false"><button class="sup-btn pri" data-supact="answer-send" data-id="' + supEsc(btn.dataset.id || "") + '">发送</button>';
    row.appendChild(wrap);
    const inp = wrap.querySelector("input");
    if (inp) inp.focus();
    if (inp) inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); supAnswerSend(btn.dataset.id, inp.value); }
      if (e.key === "Escape") wrap.remove();
    });
  }
  if (act === "answer-send") {
    const row = btn.closest("[data-supitem]");
    const inp = row ? row.querySelector(".sup-answer input") : null;
    supAnswerSend(btn.dataset.id, inp ? inp.value : "");
  }
}
function supAnswerSend(id, value) {
  const it = supState.inbox.find((x) => x.id === id);
  const v = String(value || "").trim();
  if (!it || !it.requestId) { toast("该问题缺少 requestId", true); return; }
  if (!v) { toast("先输入回答", true); return; }
  if (wsSafeSend(JSON.stringify({ v: 1, type: "ask.user.answer", requestId: it.requestId, answer: v }))) {
    supState.inbox = supState.inbox.filter((x) => x.id !== id);
    supRenderBoard();
    supState.entries.push({ kind: "sys", text: "[已答复] " + supClip(v, 80), ts: Date.now() });
    supRenderChat();
  }
}
try {
  const savedDismissed = JSON.parse(localStorage.getItem("sup:viewDismissed") || "[]");
  if (Array.isArray(savedDismissed)) supState.dismissed = savedDismissed;
} catch (_) {}
document.getElementById("superSend").addEventListener("click", supSend);
document.getElementById("superInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); supSend(); }
});
document.getElementById("supSecInbox").addEventListener("click", supBoardClick);
document.getElementById("supProjects").addEventListener("click", supBoardClick);
document.getElementById("supActive").addEventListener("click", supBoardClick);
/* ── IDE 三栏交互(事件委托,零内联 onclick)─────────────────────────
 活动栏切区(superIdeZoneSet)/侧栏项与聊天流「详情→」→ superIdeOpen/中栏返回/聊天窗折叠。 */
document.getElementById("superIdeAct").addEventListener("click", (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest(".spide-actbtn") : null;
  if (btn) superIdeZoneSet(String(btn.dataset.spidezone || "task"));
});
document.getElementById("superIdeSide").addEventListener("click", (ev) => {
  const t = ev.target;
  const det = t && t.closest ? t.closest("[data-idedetail]") : null; // 侧栏内不该出现,兜底
  if (det) { superIdeOpen(String(det.dataset.idedetail || ""), String(det.dataset.id || "")); return; }
  const btn = t && t.closest ? t.closest("[data-ideopen]") : null;
  if (btn) superIdeOpen(String(btn.dataset.ideopen || ""), String(btn.dataset.id || ""));
});
document.getElementById("superIdeMain").addEventListener("click", (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest("[data-ideback]") : null;
  if (btn) { superIdeOpen("", ""); return; }
  const det = ev.target && ev.target.closest ? ev.target.closest("[data-idedetail]") : null;
  if (det) { superIdeOpen(String(det.dataset.idedetail || ""), String(det.dataset.id || "")); return; }
  const open = ev.target && ev.target.closest ? ev.target.closest('[data-supact="open"]') : null; // 任务详情「打开会话」按钮复用 supBoardClick 协议
  if (open) { const sid = open.dataset.sid || ""; if (sid) openSession(sid); return; }
});
document.getElementById("superChatBody").addEventListener("click", (ev) => {
  const det = ev.target && ev.target.closest ? ev.target.closest("[data-idedetail]") : null; // 派发卡「详情→」/做梦卡「查看报告→」
  if (det) {
    ev.stopPropagation();
    superIdeZoneSet(String(det.dataset.idedetail || "task"));
    superIdeOpen(String(det.dataset.idedetail || ""), String(det.dataset.id || ""));
  }
});
document.getElementById("superIdeChatFold").addEventListener("click", () => {
  const vs = document.getElementById("view-super");
  if (!vs) return;
  vs.classList.toggle("spide-chat-folded");
  const fb = document.getElementById("superIdeChatFold");
  if (fb) fb.textContent = vs.classList.contains("spide-chat-folded") ? "«" : "»";
});
superIdeZoneSet("health"); // 初始区=健康一屏(默认首屏;侧栏/中栏类就位)
document.getElementById("super-refresh").addEventListener("click", () => {
  supState.histLoaded = true;
  wsSafeSend(JSON.stringify({ v: 1, type: "super.history", sinceSeq: 0 }));
  wsSafeSend(JSON.stringify({ v: 1, type: "super.inbox", limit: 30 }));
  wsSafeSend(JSON.stringify({ v: 1, type: "nodes.list" }));
});
document.addEventListener("genie:open-super", () => superOpen());

// ---- 消息编辑(重编重发,append-only 语义)与任务 fork(ZCode edit/fork 的诚实裁剪) ----
function editResend(text) {
  $("instruction").value = text;
  autoGrow(); saveDraft(); renderSendBtn(); // fixI18:回填改变输入态,发送按钮语义随之刷新
  switchView("chat");
  $("instruction").focus();
}
/** r3:/fork 复用入口(ZCode session-fork 两段式):forkSessionAndSubmit(src, instruction) ——
 * 先 session.fork 继承原会话全部上下文,拿到新 id 后在新会话派指令(标题 [fork] 前缀)。
 * 无独立任务对象时(/fork [sessionId])取当前会话最近一条任务作为指令与标题来源,缺则空指令兜底。 */
function forkSessionAndSubmit(src, instruction, opt) {
  const o = opt || {};
 // 标题「[fork] 原摘要」:调用方给的标题优先(原任务标题),否则指令首行压空白取前 40 字符(task.rename 需 taskId,提交后补)
  const forkLabel = "[fork] " + String(o.title || instruction || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const listenOnce = function (match, fn) {
    const h = function (ev) {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m && match(m)) { ws.removeEventListener("message", h); fn(m); }
    };
    ws.addEventListener("message", h);
    return h;
  };
  const h1 = listenOnce(function (m) { return m.type === "session.fork.result"; }, function (m) {
    if (!m.ok || !m.sessionId) { toast("会话分叉失败:" + String(m.reason || "未知原因"), true); return; }
    const sid = m.sessionId;
    wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, instruction: instruction, idempotencyKey: o.idempotencyKey || ("fork-" + Date.now()), ...(o.projectId ? { projectId: o.projectId } : {}) }));
 // 标题覆盖(协议 task.submit 无 title 位,task.submitted 到达后 rename)
    const h2 = listenOnce(function (m2) { return m2.type === "task.submitted" && m2.task && m2.task.sessionId === sid; }, function (m2) {
      wsSafeSend(JSON.stringify({ v: 1, type: "task.rename", taskId: m2.task.id, title: forkLabel }));
    });
    setTimeout(function () { ws.removeEventListener("message", h2); }, 10000); // 兜底:提交无回包则撤监听
    openSession(sid);
  });
  setTimeout(function () { ws.removeEventListener("message", h1); }, 10000); // 兜底:分叉无回包则撤监听
  wsSafeSend(JSON.stringify({ v: 1, type: "session.fork", sessionId: src }));
}
/** /fork 命令体(r3):无参=对当前会话 fork(取该会话最近一条任务的指令重派);有参=对指定 sessionId。 */
function builtinFork(args) {
  const a = String(args || "").trim();
  const sid = a || currentSid;
  if (!sid) { toast("当前无活动会话;/fork [sessionId] 指定要分叉的会话", true); return; }
 // 该会话最近一条任务作指令与标题来源(无任务也允许 fork:空指令兜底,服务端按空 instruction 处理)
  const t = [...tasks.values()].filter((x) => x.sessionId === sid).sort((x, y) => y.updatedAt - x.updatedAt)[0];
  if (t) {
 // instruction 属正文(索引条目没有)→ 按需拉;取不到正文时以空指令 fork 兜底(标题仍可用)。
    withTaskDetail(t.id, (full) => {
 // 正文拉取失败(full=null)才提示;全程无 instruction(服务端按空指令处理)仍允许 fork。
      if (!full) { toast("任务正文加载中,请稍后再试 /fork", true); return; }
      const ins = String(full.instruction || "");
      const tt = full.title || full.instruction || t.title || "";
      forkSessionAndSubmit(sid, ins, { title: tt, idempotencyKey: "fork-" + t.id, projectId: full.projectId || t.projectId || activeProjectId });
    });
    return;
  }
  forkSessionAndSubmit(sid, "", {});
}
/** /rewind 命令体(r3):复用 F1 快照面板既有 checkpoint 流(pendingRewind + checkpoint.preview
 * → 回包弹既有确认清单 → checkpoint.rewind,panel 9438 一带;不新写确认对话框)。
 * 无参=最近一个任务;有参=指定 taskId。无任务→先刷列表再提示。 */
function builtinRewind(args) {
  const a = String(args || "").trim();
  const recent = [...tasks.values()].sort((x, y) => y.updatedAt - x.updatedAt)[0];
  const tid = a || (recent ? recent.id : "");
  if (!tid) {
    if (a) { toast("找不到任务 " + a + "(任务列表可能未同步;稍候重试或从快照面板选)", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "task.list" })); // 刷新后可见最近任务
    toast("暂无任务可回滚(已刷新任务列表;快照面板 F1 可按 sha 回滚)", true);
    return;
  }
  pendingRewind = tid; // 既有流:preview 回包 → uiConfirm → checkpoint.rewind(不新写确认对话框)
  wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.preview", taskId: tid }));
}
/** /mode 命令体(r3):切换权限模式(cfg.set permissions.mode,与 permPill 同通道热生效)。
 * 无参=toast 当前模式;无效值 toast 用法。plan 与 goal 互斥的服务端校验如实透传错误回包(不在此处理)。 */
function builtinMode(args) {
  const a = String(args || "").trim().toLowerCase();
  if (!a) { toast("当前权限模式:" + (PERM_MODES.find((x) => x.v === permModeV) || PERM_MODES[0]).label + "(用法:/mode <ask|auto|readonly|plan>)"); return; }
  if (!PERM_MODES.some((x) => x.v === a)) { toast("未知模式:" + a + "(可选:ask | auto | readonly | plan)", true); return; }
  permPriorMode = permModeV;
  permModeV = a;
  pillRender(); pillSendPerm(); // 复用 pill 通道:cfg.set 热生效 + localStorage + toast
}
function forkTask(t) {
 // fork=两段式(ZCode session-fork 语义移植,refs: ZCode):先 session.fork 让服务端把原会话
 // 全部上下文事件(剔除任务生命周期噪声)继承进新会话,拿到新 id 后再在新会话派原指令。
 // 旧行为=仅重派指令(无上下文继承)。结果经本函数自带的一次性 ws 监听接收(主 onmessage 不动)。
 // r3:实现体抽成 forkSessionAndSubmit(/fork 复用),本函数保留为任务菜单入口。
 // instruction/title 正文按需拉(task.detail.get);无正文 → toast 提示,不空派。
  withTaskDetail(t.id, (full) => {
    const ins = String((full && full.instruction) || "");
    if (!ins) { toast("任务正文加载中,请稍后再点分叉", true); return; }
    forkSessionAndSubmit(t.sessionId, ins, { title: (full && (full.title || full.instruction)) || t.title || ins, idempotencyKey: "fork-" + t.id, projectId: (full && full.projectId) || t.projectId || activeProjectId });
  });
}

// ---- 划词菜单(ZCode SelectionActionMenu 移植):选中正文→侧聊/引用入输入框 ----
document.addEventListener("mouseup", (e) => {
  setTimeout(() => {
    const sel = window.getSelection && window.getSelection();
    const txt = sel ? String(sel).trim() : "";
    const menu = $("selMenu");
    if (!menu) return;
    if (!txt || txt.length < 4 || !e.target.closest || !e.target.closest("#chatBody")) { menu.style.display = "none"; return; }
    menu.style.display = "block";
    menu.style.left = Math.min(e.clientX + 8, window.innerWidth - 180) + "px";
    menu.style.top = Math.max(8, e.clientY - 40) + "px";
    menu.dataset.txt = txt.slice(0, 400);
  }, 10);
});
document.addEventListener("click", (e) => {
  const m = $("selMenu");
  if (!m || (e.target.closest && e.target.closest("#selMenu"))) return;
  m.style.display = "none";
});

// ---- 定时自动化管理(ZCode AutomationsSection 移植) ----
let automations = [];
function ago2(ts) { if (!ts) return "未跑"; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "刚刚" : m < 60 ? m + "分前" : Math.round(m / 60) + "时前"; }
function untilStr(ts) { const m = Math.round((ts - Date.now()) / 60000); return m <= 0 ? "即将" : m + "分后"; }
function renderAutomations() {
  const host = $("autoList");
  if (!host) return;
 // scope 分栏(ZCode 全局/项目 tabs):project=scope 匹配激活项目;无 scope 视为 global。
  const scopePid = activeProjectId || "__harness__";
  const shown = automations.filter((a) => (autoScope === "global" ? (a.scope || "global") === "global" : a.scope === scopePid));
  host.innerHTML = shown.length
    ? shown.map((a) =>
        '<div class="auto-row" data-id="' + esc(a.id) + '">' +
        '<span class="a-name" title="' + esc(a.instruction) + '">' + esc(a.name) + (a.scope && a.scope !== "global" ? ' <span style="font-size:9px;color:var(--faint)">·项目</span>' : "") + '</span>' +
        '<span class="a-meta">每' + a.everyMinutes + "分 · 上次" + ago2(a.lastRunAt) + " · 下次" + untilStr(a.nextRunAt) + " · ×" + a.runCount + (a.enabled ? "" : " · 已停") + "</span>" +
        '<button data-act="run">' + ic("play") + ' 立即</button>' +
        '<button data-act="toggle" class="' + (a.enabled ? "" : "off") + '">' + (a.enabled ? "停用" : "启用") + "</button>" +
        '<button data-act="del">删</button></div>').join("")
    : '<div class="cc-empty">无自动化规则(' + (autoScope === "global" ? "全局" : "本项目") + ')——下方创建(到点作为系统任务提交)</div>';
  for (const row of host.querySelectorAll(".auto-row")) {
    for (const b of row.querySelectorAll("button")) {
      b.onclick = () => {
        const id = row.dataset.id;
        const act = b.dataset.act;
        if (act === "run") wsSafeSend(JSON.stringify({ v: 1, type: "automation.run", id }));
        else if (act === "toggle") { const a = automations.find((x) => x.id === id); wsSafeSend(JSON.stringify({ v: 1, type: "automation.update", id, enabled: !a.enabled })); }
        else if (act === "del") { uiConfirm("删除该自动化?", { tone: "danger" }).then((ok) => { if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "automation.delete", id })); }); }
      };
    }
  }
  for (const b of $("autoScope").querySelectorAll("button")) b.classList.toggle("on", b.dataset.scope === autoScope);
}
$("autoScope").querySelectorAll("button").forEach((b) => {
  b.onclick = () => { autoScope = b.dataset.scope; renderAutomations(); };
});
$("autoAdd").onclick = () => {
  const sec = $("autoSec");
  const name = sec.querySelector("input[name=name]").value.trim();
  const instruction = sec.querySelector("input[name=instruction]").value.trim();
  const every = Number(sec.querySelector("input[name=every]").value);
  if (!name || !instruction || !every) { toast("名称/指令/间隔都必填", true); return; }
 // scope 跟随当前分栏:本项目 tab 下创建=scope 激活项目;全局 tab=global。
  const scope = autoScope === "project" ? (activeProjectId || "__harness__") : undefined;
  wsSafeSend(JSON.stringify({ v: 1, type: "automation.create", name, instruction, everyMinutes: every, ...(scope ? { scope } : {}) }));
  sec.querySelector("input[name=name]").value = "";
  sec.querySelector("input[name=instruction]").value = "";
  sec.querySelector("input[name=every]").value = "";
};
// ---- 终端(本地工作区命令执行;输出走 WS 流式) ----
let termBusy = false;
function termSend(o) { if (ws.readyState === 1) wsSafeSend(JSON.stringify(Object.assign({ v: 1 }, o))); }
function termAppend(text, cls) {
  const host = $("termBody");
  const el = document.createElement("div");
  el.className = "term-line" + (cls ? " " + cls : "");
  el.textContent = String(text);
  host.appendChild(el);
  host.scrollTop = host.scrollHeight;
}
$("termInput").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const cmd = $("termInput").value.trim();
  if (!cmd) return;
  localStorage.setItem("zh:used-term", "1");
  if (termBusy) { toast("已有命令在跑(可点「中止」)", true); return; }
  $("termInput").value = "";
  termAppend("$ " + cmd, "cmd");
  termBusy = true;
  termSend({ type: "term.exec", command: cmd });
};`;
