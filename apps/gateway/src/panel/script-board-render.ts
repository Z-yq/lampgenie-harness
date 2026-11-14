/**
 * 面板主脚本分片:script-board-render(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_BOARD_RENDER = `// ==================== 看板三件套渲染(2026-10-20) ====================
const PHASE_CN = { understand: "理解", plan: "规划", implement: "实施", verify: "验收", close: "完成" };
/** n3 看板融合:原「分身 Agents」卡的卡头状态点职责并入子agent会话流卡(同一份目录数据,不另开通道)。
 * 口径:有未读子代理消息=warn(新消息);否则有运行中=run;否则最近终态失败=fail;其余不亮灯。
 * 数据只用 subDirEntries(journal + sessionStatus.subagentList 双轨),不再拉 subagents.list。 */
function subCardStatus() {
  const dir = subDirEntries();
  const runN = dir.filter((d) => d.cls === "run").length;
  const lastPast = dir.filter((d) => d.cls !== "run").sort((a, b) => (b.endTime || b.time || 0) - (a.endTime || a.time || 0))[0] || null;
  if (subMsgUnread > 0) cvCardStatus("subchat", "warn", subMsgUnread + " 条子代理新消息");
  else if (runN > 0) cvCardStatus("subchat", "run", runN + " 个子代理运行中");
  else if (lastPast && lastPast.ok === false) cvCardStatus("subchat", "fail", "最近一次子代理失败");
  else cvCardStatus("subchat", "", "");
}
// ---- 子agent会话流卡(分身消息独立一个看板,不与 coding agent 共用会话流)----
// 数据源与归属判定全部复用既有通道:journal 的 subagent.event(payload.kind=message.agent)/
// subagent.spawn/subagent.result 按 payload.agentId 归组(与子代理工作区/目录同一判据,不新造)。
// 正文渲染直接走 Chat 卡的 replyBlockHtml(同款转轮折叠/超长折叠/折行);画布形态专属卡。
let subMsgUnread = 0;             // 未读子代理消息数(卡状态点/托盘点共用;=非选中 agent 超水位消息之和)
const subMsgSeen = new Map();     // agentId → 已读水位(journal 事件 time;切会话重置)
let subSel = "";                  // 选中式消息流:选中 agentId(内存态,不持久化;切会话随 subMsgReset 重置)
let subPaneSel = "";              // 上次渲进 pane 的选中(选中切换=pane 强制落底,不粘旧滚动位)
function subMsgReset() { subMsgUnread = 0; subMsgSeen.clear(); subSel = ""; subPaneSel = ""; }
/** 历史增量到达后的同步口(session.history.result 尾部调):含子代理事件或子agent会话流卡在场才重渲,历史包不白扫。 */
function subMsgSync(evs) {
  const hasSub = Array.isArray(evs) && evs.some((e) => e && (e.kind === "subagent.event" || e.kind === "subagent.spawn" || e.kind === "subagent.result"));
  if (!hasSub && !viewLive("subchat")) return;
  subMsgRender();
}
/** 数据层(从渲染循环抽出,纯函数):subagent.spawn/event/result 按 agentId 归组——
 * evs=该 agent 全部 subagent.event(pane 消息流数据源),msgs=message.agent 文本(未读水位统计源),
 * instructions/final/finalTime=任务书/终态。归属判据与目录/工作区同源(payload.agentId),不新造。 */
function subChatGroups() {
  const all = Array.isArray(histEvents) ? histEvents : [];
  const groups = new Map(); // aid → {aid,evs,msgs,spawnTime,instructions,final,finalTime}
  const gOf = (aid) => {
    let g = groups.get(aid);
    if (!g) { g = { aid: aid, evs: [], msgs: [], spawnTime: 0, instructions: "", final: "", finalTime: 0 }; groups.set(aid, g); }
    return g;
  };
  for (const e of all) {
    const p = e.payload || {};
    if (e.kind === "subagent.spawn") {
      const aid = String(p.agentId || "");
      if (!aid) continue;
      const g = gOf(aid);
      g.spawnTime = e.time || g.spawnTime;
      if (p.instructions) g.instructions = String(p.instructions);
    } else if (e.kind === "subagent.event") {
      const aid = String(p.agentId || "");
      if (!aid) continue;
      const g = gOf(aid);
      g.evs.push(e);
      if (p.kind === "message.agent" && p.text) g.msgs.push({ time: e.time || 0, text: String(p.text) });
    } else if (e.kind === "subagent.result") {
      const aid = String(p.agentId || "");
      if (!aid) continue;
      const fin = p.event && (p.event.finalText || p.event.note);
      if (fin) { const g = gOf(aid); g.final = String(fin); g.finalTime = e.time || 0; }
    }
  }
  return groups;
}
/** 选中态默认规则:最后活动的运行中 > 最后活动者 > ""(无数据=空态)。 */
function subSelDefault(list, dirBy) {
  const lastOf = (g) => (g.msgs.length ? g.msgs[g.msgs.length - 1].time : (g.finalTime || g.spawnTime));
  let best = null;
  for (const g of list) {
    const run = !!(dirBy.get(g.aid) && dirBy.get(g.aid).cls === "run");
    if (!best) { best = g; continue; }
    const bestRun = !!(dirBy.get(best.aid) && dirBy.get(best.aid).cls === "run");
    if ((run && !bestRun) || (run === bestRun && lastOf(g) > lastOf(best))) best = g;
  }
  return best ? best.aid : "";
}
/** 子agent会话流渲染(选中式消息流):左栏=子代理选择器(运行中/已结束两区+未读角标),
 * 右 pane=选中者消息流(派发卡→assistant 文本→工具合并卡→终态卡),粘底跟随(距底<60px,套工作区模式)。
 * 选中=已读(水位 per-agent);未读总数=非选中 agent 超水位之和(cvCardStatus 同口径)。 */
function subMsgRender() {
  const host = $("subchat-body");
  if (!host) return;
  const listEl = $("subchat-list");
  const paneEl = $("subchat-pane");
  const groups = subChatGroups();
  const dirBy = new Map(subDirEntries().map((en) => [en.agentId, en]));
  const lastOf = (g) => (g.msgs.length ? g.msgs[g.msgs.length - 1].time : (g.finalTime || g.spawnTime));
  const list = [...groups.values()].filter((g) => g.evs.length || g.final || g.instructions);
  list.sort((a, b) => lastOf(b) - lastOf(a)); // 最新活动在上
 // 选中态:内存变量;选中 agent 从数据消失 → 按默认规则重置(最后活动运行中优先)
  if (!list.some((g) => g.aid === subSel)) subSel = subSelDefault(list, dirBy);
 // 未读口径:选中且卡在场 → 推水位记已读;其余分组按水位累计(左栏角标与卡状态点同源)
  const live = canvasActive() && viewLive("subchat");
  let unread = 0;
  for (const g of list) {
    if (g.aid === subSel) { if (live) subMsgSeen.set(g.aid, lastOf(g)); continue; } // 选中者在场即已读,不参与未读
    const seen = subMsgSeen.get(g.aid) || 0;
    for (const m of g.msgs) if (m.time > seen) unread++;
  }
  subMsgUnread = unread;
  if (canvasActive()) cvCardStatus("subchat", unread > 0 ? "warn" : "", unread > 0 ? unread + " 条子代理新消息" : "");
  if (!listEl || !paneEl) return; // 双栏骨架缺席(旧缓存壳):数据面照算,渲染面跳过
 // ── 左栏:两区(.sm-sec 标头)+条目 .sl-item(状态点/角色/标题/未读角标/时间;点击选中) ──
 // n3 融合:原「分身 Agents」卡独有信息并入条目——模型标签 / 会话短码 / 失败原因(reap)/
 // 终态文本(「详情」展开,截断 200 字)。数据仍取 subDirEntries+sessionStatus,不新造 session 级 WS。
  const itemHtml = (g) => {
    const en = dirBy.get(g.aid);
    const last = lastOf(g);
    const seen = subMsgSeen.get(g.aid) || 0;
    const nUn = (g.aid === subSel && live) ? 0 : g.msgs.filter((m) => m.time > seen).length;
    const label = subagentLabelOf(en && en.title, g.instructions || (en && en.instructions)) || g.aid.slice(-10);
    const sidShort = en && en.sessionId ? String(en.sessionId).slice(0, 14) : "";
    const reapTxt = en && en.reap ? String(en.reap) : (en && en.stopReason ? String(en.stopReason) : "");
    const finalTxt = String(g.final || (en && en.text) || "").slice(0, 200);
    const finalAll = String(g.final || (en && en.text) || ""); // 全文(按钮切换用;左栏窄,纯文本不铺 markdown)
    const isSel = g.aid === subSel;
    return '<div class="sl-item' + (isSel ? " on" : "") + '" data-agent="' + esc(g.aid) + '" data-last="' + Number(last || 0) + '" title="查看该子代理的消息流">' +
      '<div class="sl-main">' +
      '<span class="sd-dot ' + esc((en && en.cls) || "end") + '" style="background:' + subagentRoleColor((en && en.role) || "worker") + '"></span>' +
      '<span class="sl-role">' + esc(subagentRoleName((en && en.role) || "worker")) + "</span>" +
      '<span class="sl-label">' + esc(label) + "</span>" +
      (nUn > 0 ? '<span class="sl-badge">' + nUn + " 新</span>" : '<span class="sl-n">' + g.msgs.length + " 条" + (last ? " · " + new Date(last).toLocaleTimeString() : "") + "</span>") +
      "</div>" +
 // 元信息行:模型(注册表实际模型,缺席=主模型)· 会话短码 · 失败原因
      '<div class="sl-meta">' + esc((en && en.model) || "主模型") +
      (sidShort ? " · " + esc(sidShort) : "") +
      (reapTxt ? ' · <span class="sl-reap" title="失败/收割原因">' + esc(reapTxt) + "</span>" : "") +
      "</div>" +
 // 零反斜杠纪律:PAGE 是 TS 模板字符串,\" 会在下发前被模板层吃掉 → 浏览器端整段脚本语法错误
 // (sl-final-tx 注意)。HTML 属性一律用单引号,不写反斜杠转义。
 // 左栏窄:摘要仍 200 字纯文本;超长时追加「全文」钮 —— 点=选中该 agent,右侧 pane 顶部终态卡(markdown,上限 20000 字)
      (finalTxt ? '<details class="sl-final"' + (isSel ? " open" : "") + ' data-subfinal="' + esc(g.aid) + '"><summary>详情 · 终态' + (en && en.ok === false ? "(失败)" : "") + "</summary><div class='sl-final-tx'>" + esc(finalTxt) + "</div>" +
        (finalAll.length > 200 ? '<button class="sl-final-more" data-subfull="' + esc(g.aid) + '" title="在右侧消息流查看终态全文">全文 · ' + finalAll.length + " 字</button>" : "") +
        "</details>" : "") +
      "</div>";
  };
  if (!list.length) {
    listEl.innerHTML = '<div class="sl-empty">本会话暂无子代理</div>';
  } else {
    const runList = list.filter((g) => (dirBy.get(g.aid) || {}).cls === "run");
    const doneList = list.filter((g) => (dirBy.get(g.aid) || {}).cls !== "run");
    const lp = ['<div class="sm-sec">运行中 · ' + runList.length + "</div>"];
    for (const g of runList) lp.push(itemHtml(g));
    if (doneList.length) {
      lp.push('<div class="sm-sec">已结束 · ' + doneList.length + "</div>");
      for (const g of doneList) lp.push(itemHtml(g));
    }
    listEl.innerHTML = lp.join("");
  }
 // ── 右 pane:选中者消息流(重渲前记 wasBottom;切换选中=强制落底,不掀用户滚动) ──
  const selChanged = subSel !== subPaneSel;
  const wasBottom = paneEl.scrollHeight - paneEl.scrollTop - paneEl.clientHeight < 60; // 粘底跟随,语义同工作区/主历史
  const keepTop = paneEl.scrollTop; // 重渲前记滚动位:innerHTML 整块重建后回贴,上翻浏览不被掀
  subPaneSel = subSel;
  const pp = [];
  if (!subSel) {
    pp.push('<div class="sp-empty">从左侧选择一个子 agent<br>查看它的实时消息流(任务书/消息/工具调用/终态)</div>');
  } else {
    const g = groups.get(subSel) || { aid: subSel, evs: [], msgs: [], spawnTime: 0, instructions: "", final: "", finalTime: 0 };
    const en = dirBy.get(subSel);
    const cls = esc((en && en.cls) || "end");
    const label = subagentLabelOf(en && en.title, g.instructions || (en && en.instructions)) || ("子代理 " + subSel.slice(-8));
 // 派发卡(单张置顶):标题/状态/角色/模型 + 任务书全文
    pp.push('<div class="sp-dispatch">' +
      '<div class="sp-dh"><span class="sd-dot ' + cls + '" style="background:' + subagentRoleColor((en && en.role) || "worker") + '"></span>' +
      "<span>" + esc(label) + '</span><span class="sp-dst ' + cls + '">' + esc((en && en.stTxt) || "已结束 · 历史会话") + esc((en && en.durTxt) || "") + "</span></div>" +
      '<div class="sp-dmeta"><span>角色:' + esc((en && en.role) || "worker") + '</span><span>模型:' + esc((en && en.model) || "主模型") + "</span>" +
      "<span>消息 " + g.msgs.length + " · 事件 " + g.evs.length + "</span>" +
      (g.spawnTime ? "<span>派发 " + new Date(g.spawnTime).toLocaleTimeString() + "</span>" : "") + "</div>" +
 // 任务书走 markdown + 折叠(短任务书 ≤300 字且 ≤6 行默认 open,长任务书收起——重渲不铺满屏)
      (g.instructions ? (function () {
        const ins = String(g.instructions).slice(0, 20000); // DOM 上限:重渲(4s 轮询)不付无界成本
        const NL2 = String.fromCharCode(10);
        const insLines = ins.split(NL2);
        const head0 = (insLines.find(function (x) { return x.trim(); }) || "").trim();
        const short = ins.length <= 300 && insLines.length <= 6;
        return '<details class="sp-dtask"' + (short ? " open" : "") + ' title="任务书全文">' +
          "<summary>任务书 · " + ins.length + " 字" + (head0 ? " · " + esc(head0.slice(0, 60)) : "") + "</summary>" +
          '<div class="sp-dtask-md">' + mdToHtml(ins, "") + "</div></details>";
      })() : "") +
      "</div>");
    if (!g.evs.length) {
 // 降级:无 subagent.event(外部后端/早期会话)——诚实横幅 + output.txt tail 时间线(复用工作区降级形态)
      pp.push('<div class="sp-note">本子代理无结构化动作流(外部后端或早期会话):下方为 output.txt 进度行时间线;动作级回放仅进程内子代理可用。</div>');
      const lines = String((en && en.tail) || "").split(String.fromCharCode(10)).filter((l) => l.trim());
      pp.push(lines.length ? '<div class="ws-timeline">' + esc(lines.join(String.fromCharCode(10))) + "</div>"
        : '<div class="sp-note">(历史会话或服务已重启:实时过程不可回放)</div>');
    } else {
      const limit = subWsLimit.get(subSel) || SUB_WS_PAGE; // 分页复用工作区渲染上限/「加载更早」
      const omitted = Math.max(0, g.evs.length - limit);
      if (omitted > 0) pp.push('<div class="ws-omitted"><span>已省略最早 ' + omitted + " 条(渲染上限 " + limit + ')</span><button data-spmore="' + esc(subSel) + '">加载更早 480 条</button></div>');
      toolTokensScan(); // read_file 语义着色链路对齐(主渲染在此早退,pane 自行补扫)
      const win = omitted > 0 ? g.evs.slice(-limit) : g.evs;
      const resByCall = new Map(), argsByCall = new Map(); // fixH17 同款预扫:tool.call 参数 + tool.result 按 toolCallId
      for (const e2 of win) {
        const p2 = e2.payload || {};
        if (p2.kind === "tool.call") { const cid = String(p2.toolCallId || ""); if (cid && !argsByCall.has(cid)) argsByCall.set(cid, String(p2.arguments || "")); }
        else if (p2.kind === "tool.result") { const cid = String(p2.toolCallId || ""); if (cid) resByCall.set(cid, { name: String(p2.name || ""), content: String(p2.content || ""), durationMs: Number(p2.durationMs || 0) }); }
      }
      const merged = new Set();
      for (const ev of win) {
        const p = ev.payload || {};
        const t = ev.time ? '<span class="sm-time">' + new Date(ev.time).toLocaleTimeString() + "</span>" : "";
        if (p.kind === "message.agent") {
          if (p.reasoning && settings.thinking === "on")
            pp.push('<details class="think-card"><summary>思考 · ' + Math.max(1, Math.round(Number(p.llmMs || 0) / 1000)) + 's</summary><div class="th-body">' + sketchifyHtml(esc(String(p.reasoning).slice(0, 4000))) + "</div></details>");
          if (p.text) pp.push('<div class="sm-msg">' + t + replyBlockHtml({ payload: { text: p.text }, time: ev.time, seq: ev.seq }, "") + "</div>");
          for (const c of Array.isArray(p.toolCalls) ? p.toolCalls : []) {
            const cid = String(c.id || "");
            merged.add(cid);
            pp.push(toolCallCard(c, "", resByCall.get(cid) || null, toolTokensOfId(cid)));
          }
        } else if (p.kind === "tool.result") {
          const cid = String(p.toolCallId || "");
          if (merged.has(cid)) continue; // 已并进 message.agent 的合并卡
          pp.push(toolCallCard({ name: String(p.name || ""), arguments: argsByCall.get(cid) || "" }, "", { content: String(p.content || ""), durationMs: Number(p.durationMs || 0) }, toolTokensOfId(cid)));
        } else if (p.kind === "tool.call") {
          const cid = String(p.toolCallId || "");
          if (merged.has(cid)) continue;
          merged.add(cid);
          pp.push(toolCallCard({ name: String(p.name || ""), arguments: String(p.arguments || "") }, "", resByCall.get(cid) || null, toolTokensOfId(cid)));
        } else if (p.kind === "step.start" || p.kind === "step.end" || p.kind === "turn.start" || p.kind === "turn.end" || p.kind === "permission.gate") {
          const line = p.kind === "step.start" ? "第 " + p.step + " 步开始(模型思考中)"
            : p.kind === "step.end" ? "第 " + p.step + " 步结束(" + String(p.reason || "") + (p.error ? " · " + String(p.error).slice(0, 120) : "") + ")"
            : p.kind === "turn.start" ? "第 " + String(p.turn || "?") + " 轮开始"
            : p.kind === "turn.end" ? "轮结束(" + String(p.reason || "") + ")"
            : "权限 " + String(p.tool || "") + " " + String(p.effect || "") + "(" + String(p.by || "") + ")";
          pp.push('<div class="task-sub">' + t + esc(line) + "</div>");
        }
 // llm.trace 等其余 kind 不渲染(完整轨迹行在子代理工作区 tab)
      }
      if (en && en.cls === "run") pp.push('<div class="task-sub"><span class="st run">running</span> 子代理运行中,实时刷新…</div>');
      const liveDraft = (en && en.cls === "run") ? subAgentDraftOf(g.evs) : null; // 流式草稿(与工作区同形态)
      if (liveDraft) {
        if (liveDraft.reasoning && settings.thinking === "on")
          pp.push('<details class="think-card think-live" open><summary>思考 · 生成中</summary><div class="th-body">' + sketchifyHtml(esc(liveDraft.reasoning.slice(0, 4000))) + "</div></details>");
        if (liveDraft.text) pp.push('<div class="task-reply">' + mdToHtml(scrubProtocolLines(liveDraft.text), "") + (liveDraft.done ? "" : '<span class="st-cursor"></span>') + "</div>");
        for (const tw of liveDraft.tools || []) {
          const m3 = toolMetaOf(tw.name);
          pp.push('<div class="st-tool' + (tw.running ? " run" : "") + '"><span class="st-tool-dot"></span>' +
            (m3 ? '<span class="tc-ic" style="width:11px;height:11px">' + ic(m3.i) + "</span>" : "") +
            "<span" + (m3 ? ' title="' + esc(tw.name) + '"' : "") + ">" + esc(m3 ? m3.v : tw.name) + "</span>" +
            '<span class="st-tool-state">' + (tw.running ? (tw.note ? esc(tw.note) : "执行中") : "完成 · " + (tw.durationMs || 0) + "ms") + "</span></div>");
        }
      }
    }
    if (g.final) {
 // 终态卡:markdown 渲染(mdToHtml 自带转义,不二次 esc);长文(>600 字)套 details 折叠,
 // DOM 上限 20000 字符(防超大终态撑爆 DOM,不无限)。
      const fin = String(g.final).slice(0, 20000);
      const finMd = mdToHtml(fin, "");
      const finLong = fin.length > 600;
      pp.push('<div class="sm-final" title="终态文本">' + (finLong
        ? "<details><summary>结果 · " + fin.length + " 字(展开全文)</summary>"
        : "结果:") +
        '<div class="sm-final-md">' + finMd + "</div>" + (finLong ? "</details>" : "") + "</div>");
    }
  }
  paneEl.innerHTML = pp.join("");
  if (selChanged || wasBottom) paneEl.scrollTop = paneEl.scrollHeight; // 粘底跟随;用户上滚(距底≥60px)回贴原位不抢
  else paneEl.scrollTop = keepTop;
}
/** 目录条目/过程卡→子agent会话流定位(选中式):目标 agent 有数据 → 唤回+聚焦卡,
 * 设为选中并记已读(水位)后重渲 pane(切换选中=pane 落底);无数据返回 false(走工作区 tab 原通路)。 */
function subMsgLocate(aid) {
  const host = $("subchat-body");
  if (!host || !canvasActive()) return false;
  const g = subChatGroups().get(String(aid || ""));
  if (!g || !(g.evs.length || g.final || g.instructions)) return false; // 该子代理无消息记录:不拦截,走原通路
  try { window.CanvasShell.showCard("subchat"); window.CanvasShell.focus("subchat", { keepView: true }); }
  catch (e) { /* 聚焦失败不阻断:卡体仍渲染选中者 */ }
  subSel = String(aid || "");
  const last = g.msgs.length ? g.msgs[g.msgs.length - 1].time : (g.finalTime || g.spawnTime);
  if (last) subMsgSeen.set(subSel, last); // 定位即视为已读:先推水位再重渲,角标即时清零
  subMsgRender();
  return true;
}
// 交互钩子(事件委托):左栏条目点击=选中该子 agent(选中即清它的未读水位)→ 重渲双栏;
// 「加载更早」(data-spmore)扩 subWsLimit 后只重渲本卡(与工作区同款按钮 data-wsmore 互不干扰)。
document.addEventListener("click", (e) => {
 // 终态「全文」钮:选中该 agent(走既有通路:推已读水位+重渲 pane),pane 顶部终态卡即全文
  const full = e.target && e.target.closest ? e.target.closest("[data-subfull]") : null;
  if (full) {
    e.preventDefault();
    e.stopPropagation(); // 不触发条目选中二次重渲
    const fAid = full.getAttribute("data-subfull") || "";
    if (fAid) {
      const fg = subChatGroups().get(fAid);
      const fLast = fg && fg.msgs.length ? fg.msgs[fg.msgs.length - 1].time : (fg ? fg.finalTime : 0);
      subSel = fAid;
      if (fLast) subMsgSeen.set(fAid, fLast);
      subMsgRender();
    }
    return;
  }
  const it = e.target && e.target.closest ? e.target.closest("#subchat-list .sl-item[data-agent]") : null;
  if (it) {
    const aid = it.getAttribute("data-agent") || "";
    if (!aid) return;
    const last = Number(it.getAttribute("data-last") || 0);
    subSel = aid;
    if (last) subMsgSeen.set(aid, last); // 选中=已读
    subMsgRender();
    return;
  }
  const more = e.target && e.target.closest ? e.target.closest("[data-spmore]") : null;
  if (more) {
    const aid = more.getAttribute("data-spmore") || "";
    if (aid) { subWsLimit.set(aid, (subWsLimit.get(aid) || SUB_WS_PAGE) + 480); subMsgRender(); }
  }
});
// 运行态轮询(n3 融合后单一口径):子agent会话流卡在场时 4s 拉一次 session.status(既有 3s 轮询同通道,
// 数据源=注册表 subagentList + journal 双轨)——原分身卡的 subagents.list 取数已删,不新造 session 级 WS。
// 视口外的卡拉数无意义(viewLive 守卫);断连时静默跳过(轮询是补丁不是实时,失败不弹错)。
setInterval(() => {
  if (document.hidden) return;
  if (!viewLive("subchat")) return;
  if (!ws || ws.readyState !== 1) return;
  if (currentSid) ssSendStatus(currentSid);
  subMsgRender(); // 目录数据到达后回包再刷一次;这里先重渲保证状态点/未读即时跟随
}, 4000);
// 任务追踪的状态过滤(全部/running/done/failed),跨刷新保持;running 恒置顶再按 updatedAt 降序
let trackFilter = "all";
function trackStateCn(s) { return s === "running" ? "运行中" : s === "done" ? "完成" : s === "failed" ? "失败" : s === "queued" ? "排队" : String(s || ""); }
/** 任务追踪拉数(融合板):只取当前选中会话;草稿态=空态提示。
 * 在场 4s 活跃轮询(有数据渲染即续期;视图离场即停)。 */
let trackTimer = null;
/** 追踪卡会话选择(用户用户反馈:上面召回·审途有数据、下面却「未选中会话」)——
 * 与 status-widget 的 trackedSid 同源:优先当前选中会话;没有则回退「最近活动任务」的会话
 * (运行中优先)。两个区必须看同一会话,否则一张卡里出现两套数据/空态自相矛盾。 */
function trackSid(prefer) {
  if (typeof prefer === "string" && prefer) return prefer; // n6:切会话重载以入参为准(不隐式读全局)
  if (typeof currentSid !== "undefined" && currentSid) return currentSid;
  const all = [...tasks.values()];
  const act = all.filter((t) => ["running", "queued"].includes(t.state)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    || all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return act ? act.sessionId : "";
}
function trackPull(prefer) {
 // 轮询在本函数里就起链:结果回包(→trackRender)只是续约的一路,trackRender 那条链在
 // WS 断连/回包丢失时会静默断掉,之后卡片再也不刷新(只剩手动「刷新」按钮)。
  trackLiveTick();
  const sid = trackSid(prefer);
  if (sid) wsSafeSend(JSON.stringify({ v: 1, type: "track.view", sessionId: sid }));
  else trackRender({ tasks: [], noSession: true });
}
function trackLiveTick() {
  clearTimeout(trackTimer);
  trackTimer = setTimeout(() => {
 // 在场判定必须走 viewLive(经典=当前视图;画布=卡片在视口内)。
 // 旧实现用 elv.classList.contains("on")——画布形态下视图节点恒可见且从不挂 .on(canvas-shell
 // 用 body.cv-shell .cv-card-body>.view{display:flex!important} 覆盖显隐),于是第一次 tick 就
 // return,轮询彻底停摆:任务都跑完了追踪卡还停在首拉的旧快照。
    const elv = $("view-track");
    let live = false;
    try { live = viewLive("track"); } catch (e) { /* 视图守卫不可用=按经典判定兜底 */ live = !!(elv && elv.classList.contains("on")); }
 // 不可见时**不终止**轮询:只跳过本次拉取并续约。旧实现在这里 return,卡滚出视口/未聚焦即
 // 永久停摆,再回来也不会自愈(只能手动点刷新)——任务跑完数据仍停在旧快照的另一半原因。
    if (live) trackPull();
    trackLiveTick();
  }, 4000);
}
function trackRender(m) {
  const el = $("track-body"); if (!el) return;
 // 轮询续约必须在任何 early-return 之前:旧实现放在 noSession 分支之后,首拉无会话时
 // 轮询从未启动,之后建了任务也永不刷新(只能手动点「刷新」)。
  trackLiveTick();
  if (m.noSession) { el.innerHTML = '<div class="cc-empty">还没有会话——在对话卡提一个需求后,这里按 turn → 五阶段 → 阶段任务展开</div>'; return; }
 // 追踪 Trace = turn 树(「计划」不再独立成块,全部并入 turn 节点)。
 // 一级=turn / 二级=五阶段(恒定 5 个)/ 三级=该阶段 LLM 写的阶段任务(note)。
  const turns = Array.isArray(m.turns) ? m.turns.slice().reverse() : []; // 服务端按时间升序,卡上最新在上
  const states = m.taskStates || {};
  const PH = ["understand", "plan", "implement", "verify", "close"];
  const stateOf = (t) => String(states[t.taskId] || "");
  const turnState = (t) => {
    const st = stateOf(t);
    if (t.reasons && t.reasons.indexOf("pending") >= 0) return "queued";
    if (st) return st;
    if (t.reasons && t.reasons.indexOf("cancelled") >= 0) return "cancelled";
    return "done";
  };
  const cnt = { all: turns.length, running: 0, done: 0, failed: 0 };
  for (const t of turns) { const st = turnState(t); if (st === "running" || st === "queued") cnt.running++; else if (st === "failed") cnt.failed++; else if (st === "done") cnt.done++; }
  const chips = [["all", "全部"], ["running", "运行中"], ["done", "完成"], ["failed", "失败"]].map(([k, label]) =>
    '<button class="bd3-chip' + (trackFilter === k ? " on" : "") + '" data-trackfilter="' + k + '">' + label + " " + cnt[k] + "</button>").join("");
  const list = turns.filter((t) => {
    if (trackFilter === "all") return true;
    const st = turnState(t);
    if (trackFilter === "running") return st === "running" || st === "queued";
    return st === trackFilter;
  });
  if (!list.length) {
    el.innerHTML = '<div class="tk-hd"><span class="tk-hd-t">任 务</span></div>' +
      '<div class="bd3-chips">' + chips + "</div>" +
      '<div class="cc-empty">' + (turns.length ? "当前筛选下无 turn(点上方「全部」看全部)" : "还没有 turn——提一个需求就会出现在这里") + "</div>";
    return;
  }
  const parts = [];
 // 「任务」= 本卡最后一个数据块:一级 turn → 二级五阶段 → 三级阶段任务。
  parts.push('<div class="tk-hd"><span class="tk-hd-t">任 务</span></div>');
  parts.push('<div class="bd3-chips">' + chips + "</div>");
  list.forEach((t, ti) => {
    const st = turnState(t);
    const tone = st === "done" ? "ok" : st === "failed" ? "fail" : st === "running" ? "run" : st === "cancelled" ? "fail" : "";
    const phKeys = PH.filter((k) => k); // 恒定五阶
    const declared = phKeys.filter((k) => (t.phases || {})[k] && t.phases[k].length);
    const totalNotes = phKeys.reduce((a, k) => a + (((t.phases || {})[k] || []).length), 0);
 // 当前阶段 = 最后一个被声明的阶段(按五阶顺序推断;回退声明时以最后一个有 note 的为准)
    let curPhase = "";
    for (const k of phKeys) if ((t.phases || {})[k] && t.phases[k].length) curPhase = k;
    const atTxt = t.at ? new Date(t.at).toLocaleTimeString() : "";
 // 一级:turn(最新一个默认展开;运行中恒展开)
    const openTurn = ti === 0 || st === "running";
    const user = String(t.userText || "").replace(/\\s+/g, " ").trim();
    parts.push('<details class="tk-turn" data-tkturn="' + esc(String(t.taskId || "")) + '"' + (openTurn ? " open" : "") + ">" +
      '<summary title="' + esc(user || "(无用户文本)") + '">' +
      '<span class="bd3-dot ' + tone + '"></span>' +
      '<span class="tk-n">Turn ' + esc(String(t.no || t.turn || "·")) + "</span>" +
      '<span class="tk-user">' + esc(clip(user || "(待启动)", 90)) + "</span>" +
      (st === "cancelled" ? '<span class="tk-meta">已取消</span>' : "") +
      '<span class="tk-meta">' + (declared.length ? declared.length + "/5 阶段" : "未进入五阶段") + (totalNotes ? " · " + totalNotes + " 条" : "") + "</span>" +
      (atTxt ? '<span class="tk-meta">' + esc(atTxt) + "</span>" : "") +
      '</summary><div class="tk-body">');
 // 二级:五阶段(全部渲染,未声明的显「待」)+ 三级:阶段任务(note 多条)
    for (const k of phKeys) {
      const items = (t.phases || {})[k] || [];
      const skipped = items.length > 0 && items.every((x) => x.skipped);
      const isCur = !skipped && items.length > 0 && k === curPhase && (st === "running" || st === "queued");
      const glyph = skipped ? "跳" : items.length ? (isCur ? "▶" : "✓") : "待";
      const tone2 = skipped || !items.length ? " dim2" : isCur ? " cur" : "";
      const openPh = !skipped && items.length > 0 && (isCur || k === curPhase);
      const phIdx = String(phKeys.indexOf(k) + 1).padStart(2, "0");
      parts.push('<details class="tk-ph" data-det-key="' + esc("tkph:" + String(t.taskId || "") + ":" + k) + '"' + (openPh ? " open" : "") + ">" +
        '<summary><span class="tk-ph-i">' + phIdx + '</span><span class="bd3-ph' + tone2 + '">' + esc(PHASE_CN[k] || k) + glyph + "</span>" +
        '<span class="tk-ph-hint">' + (items.length ? items.length + " 条任务" : skipped ? "已跳过" : "未声明") + "</span></summary>");
      if (items.length) {
        parts.push('<div class="tk-notes">' + items.map((x) => '<div class="tk-note' + (x.skipped ? " tk-note-skip" : x.auto ? " tk-note-auto" : "") + '" title="' + esc(x.note || "") + '">' +
          esc(x.note ? clip(x.note, 400) : (x.skipped ? "(不涉及)" : "(无说明)")) + (x.auto ? '<span class="tk-auto-tag" title="阶段门 auto-advanced:板含内容节点,自动置 plan(B2 正常推进,非人工干预)">自动推进</span>' : "") + "</div>").join("") + "</div>");
      }
      parts.push("</details>");
    }
    parts.push("</div></details>");
  });
  el.innerHTML = parts.join("");
}
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("[data-trackfilter]") : null;
  if (!b) return;
  trackFilter = b.getAttribute("data-trackfilter") || "all";
  trackPull();
});
let usageSortKey = "tokens"; // 用量卡排序切换:表头「调用/in tok」可点
let usageLastMsg = null;
let usageScopeSid = null;       // n10 用量卡会话作用域:null=未绑定(显示全量),""=草稿态,其它=当前会话 id
let usageScopeOnly = true;      // 卡内开关:只看当前会话(默认开;协议 usage.view 无 session 参数,前端过滤)
function usageRender(m) {
  const el = $("usage-body"); if (!el) return;
  usageLastMsg = m;
  const allRows = m.rows || [];
 // n10:服务端 usage.view 按 模型×会话 全量聚合(协议无 session 入参,本次不改服务端)——
 // 前端按当前选中会话过滤展示,并在卡头写明作用域,避免把全局数误读成当前会话的账。
  const scopeSid = usageScopeSid === null ? (currentSid || "") : usageScopeSid;
  const scoped = usageScopeOnly && scopeSid ? allRows.filter((r) => String(r.sessionId || "") === scopeSid) : allRows;
  const rows = scoped.slice().sort((a, b) => (usageSortKey === "calls"
    ? Number(b.calls || 0) - Number(a.calls || 0)
    : (Number(b.input || 0) + Number(b.output || 0)) - (Number(a.input || 0) + Number(a.output || 0))));
  const scopeBar = '<div class="bd3-note usage-scope">作用域:' +
    (usageScopeOnly && scopeSid ? "当前会话 " + esc(String(scopeSid).slice(0, 18)) : "全部会话(全局)") +
    (allRows.length ? " · 全局共 " + allRows.length + " 行/当前 " + scoped.length + " 行" : "") +
    '<button class="vw-act" id="usageScopeBtn" style="margin-left:8px">' + (usageScopeOnly ? "看全部会话" : "只看当前会话") + "</button></div>";
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
 // 空态两分:读取失败(服务端 journal 读炸)与真的没数据,文案不同——旧实现都写「无用量数据」
  if (!rows.length) {
    el.innerHTML = scopeBar + (m.failed
      ? '<div class="cc-empty">用量读取失败(journal 读取异常,可点右上「刷新」重试)</div>'
      : (scoped.length !== allRows.length
        ? '<div class="cc-empty">当前会话还没有用量记录——点「看全部会话」看全局账</div>'
        : '<div class="cc-empty">还没有用量数据——发起一次 LLM 调用后这里按 模型×会话 聚合</div>'));
    bindUsageScopeBar(el);
    return;
  }
 // cache 全 0 时收起该列(多数会话不命中缓存,空列只占宽度)
  const showCache = rows.some((r) => Number(r.cacheRead || 0) > 0);
  const grid = "bd3-grid" + (showCache ? "" : " nc");
  const tot = rows.reduce((a, r) => ({ calls: a.calls + Number(r.calls || 0), input: a.input + Number(r.input || 0), output: a.output + Number(r.output || 0), cacheRead: a.cacheRead + Number(r.cacheRead || 0) }), { calls: 0, input: 0, output: 0, cacheRead: 0 });
  const at = m.updatedAt ? new Date(m.updatedAt) : null;
  const arw = (k) => (usageSortKey === k ? " ▾" : "");
  const parts = [scopeBar, '<div class="' + grid + ' bd3-hd"><span>模型</span><span>会话</span><span class="num" data-usort="calls" style="cursor:pointer" title="点击按调用数排序">调用' + arw("calls") + '</span><span class="num" data-usort="tokens" style="cursor:pointer" title="点击按 token 排序">in tok' + arw("tokens") + '</span><span class="num">out tok</span>' + (showCache ? '<span class="num">cache</span>' : "") + "</div>"];
  for (const r of rows) {
    parts.push('<div class="' + grid + ' bd3-line-row">' +
      '<span class="ell" title="' + esc(r.model) + '">' + esc(r.model) + "</span>" +
      '<span class="ell dim" title="' + esc(r.sessionId) + '">' + esc(r.sessionId) + "</span>" +
      '<span class="num">' + Number(r.calls || 0) + "</span>" +
      '<span class="num">' + fmt(Number(r.input || 0)) + "</span>" +
      '<span class="num">' + fmt(Number(r.output || 0)) + "</span>" +
      (showCache ? '<span class="num dim">' + fmt(Number(r.cacheRead || 0)) + "</span>" : "") + "</div>");
  }
  const PN = '<span class="num">', PN2 = '<span class="num dim">', SN = "</span>";
  parts.push('<div class="' + grid + ' bd3-line-row bd3-tot"><span>总计</span><span class="dim">' + rows.length + " 行" + SN +
    PN + tot.calls + SN + PN + fmt(tot.input) + SN + PN + fmt(tot.output) + SN +
    (showCache ? PN + fmt(tot.cacheRead) + SN : "") + "</div>");
  parts.push('<div class="bd3-note">按 token 降序 · 示 top40' + (at && !isNaN(at.getTime()) ? " · 截至 " + at.toLocaleTimeString() : "") + (showCache ? "" : " · cache 全 0 已收起") + "</div>");
  el.innerHTML = parts.join("");
  bindUsageScopeBar(el);
  el.querySelectorAll("[data-usort]").forEach((h) => h.addEventListener("click", () => { const k = h.getAttribute("data-usort"); if (k && k !== usageSortKey) { usageSortKey = k; usageRender(usageLastMsg); } }));
}
/** n10 用量卡作用域开关绑定(只看当前会话 ⇄ 全部会话);作用域切换只重渲,不重发请求。 */
function bindUsageScopeBar(host) {
  const b = host.querySelector("#usageScopeBtn");
  if (b) b.onclick = () => { usageScopeOnly = !usageScopeOnly; usageRender(usageLastMsg); };
}
function nodesRender(m) {
  const host = $("nodeList");
  if (!host) return;
  acctRenderNodes(m);
  const list = m.nodes || [];
  host.innerHTML = list.length
    ? list.map((n) => '<div class="mgr-row node-row"><span class="m-name">' + esc(n.nodeId) + '</span>' +
      '<span class="m-desc">' + esc((n.capabilities || []).join("/")) + " · cpu " + Math.round(n.load.cpu * 100) + "% · mem " + Math.round(n.load.mem * 100) + "% · 任务 " + n.load.runningTasks + "</span>" +
      '<span class="m-meta">' + (n.online ? "<b>在线</b>" : '<b class="off">失联</b>') + " · 心跳 " + ago2(n.lastHeartbeat) + "</span></div>").join("")
    : '<div class="cc-empty">尚无节点——用上方向导把远程机接入(本机 local 节点在 app 内置注册)</div>';
  const sel = $("nodeSel");
  const online = list.filter((n) => n.online);
  sel.innerHTML = online.length ? online.map((n) => '<option value="' + esc(n.nodeId) + '">' + esc(n.nodeId) + "</option>").join("") : '<option value="">(无在线节点)</option>';
}
let nodeTimer = null;
$("nodeExecGo").onclick = () => {
  const nodeId = $("nodeSel").value;
  const command = $("nodeCmd").value.trim();
  if (!nodeId || !command) { toast("选节点 + 填命令", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "node.exec", nodeId, command }));
  toast("已派发到 " + nodeId + "(任务列表可见)");
  $("nodeCmd").value = "";
};
// ── 引导中心 ──
const GUIDE_STEPS = [
  { k: "connect", t: "连接 gateway", d: "状态灯绿色即已连接" },
  { k: "first-task", t: "创建第一个任务", d: "在下方输入框说点什么,Enter 发送" },
  { k: "slash", t: "试试斜杠指令", d: "输入 / 打开指令面板(自定义命令在设置-命令)" },
  { k: "terminal", t: "打开终端", d: "Ctrl+J 在项目根执行命令(左栏按钮已撤,快捷键直达)" },
  { k: "market", t: "逛插件市场", d: "侧栏「插件市场」一键安装命令/技能/子智能体包" },
  { k: "mcp", t: "接一个 MCP 服务器", d: "设置-MCP 服务器,工具自动并入 agent" },
  { k: "attach", t: "带附件提问", d: "输入框 + 按钮/拖文件/贴图——图片进视觉通道" },
  { k: "stats", t: "看看使用统计", d: "设置-数据与统计:趋势/热力图/额度" },
];
function guideRender() {
  const host = $("guideList");
  if (!host) return;
  const done = {
    connect: true,
    "first-task": [...tasks.values()].length > 0,
    slash: localStorage.getItem("zh:used-slash") === "1",
    terminal: localStorage.getItem("zh:used-term") === "1",
    market: localStorage.getItem("zh:used-market") === "1",
    mcp: false,
    attach: localStorage.getItem("zh:used-attach") === "1",
    stats: localStorage.getItem("zh:used-stats") === "1",
  };
 // mcp 状态:拉 mcp.list 后回填(简化:看本地缓存标记)
  done.mcp = localStorage.getItem("zh:cfg-mcp") === "1";
  host.innerHTML = GUIDE_STEPS.map((g) => '<div class="guide-item' + (done[g.k] ? " done" : "") + '"><span class="g-ck">' + (done[g.k] ? "已" : "待") + '</span><span><div class="g-t">' + esc(g.t) + '</div><div class="g-d">' + esc(g.d) + "</div></span></div>").join("");
}
const TOUR = [
 // 文案按真实界面口径改写(旧版写「中央是对话流」——现在是无限画布,对话只是其中一张卡)
  { t: "欢迎使用 lampgenie-harness", p: "界面是无限画布:每个模块是一张卡片,可拖动/缩放;最左侧竖条是快速定位(点图标飞到对应卡)。底部输入框提交任务,Ctrl+K 随时打开命令中心。" },
  { t: "任务与项目", p: "左侧是任务与项目(经典布局);画布布局下它们在对话卡内。右键任务行有重命名/置顶/归档/分叉/回滚。点「添加项目」把其它仓库挂进来。" },
  { t: "能力入口", p: "定位栏/侧栏:Git · 代码档案 · 自动化 · 经验库 · 插件市场 · 白板 · 团队 · 节点 · 审批 · 子代理 · 任务追踪 · 用量。终端 Ctrl+J、内嵌浏览器 Ctrl+Alt+B、文件树走桶头/右键;设置(左下齿轮)里有子智能体/技能/命令/钩子/MCP/记忆/账号/远程连接。" },
  { t: "输入框三件套", p: "/ 指令 · @文件 · #会话 · $技能;+ 号或拖文件加附件(图片进视觉通道);底行可切模型/思考力度/权限模式。" },
  { t: "开始吧", p: "引导中心的清单会随你的真实使用自动打勾——设置 → 引导中心可随时回看。" },
];
let tourIdx = 0;
function tourShow(i) {
  tourIdx = i;
  if (i >= TOUR.length) { $("tourMask").classList.remove("on"); localStorage.setItem("zh:toured", "1"); return; }
  $("tourTitle").textContent = TOUR[i].t;
  $("tourText").textContent = TOUR[i].p;
  $("tourNext").textContent = i === TOUR.length - 1 ? "完成" : "下一步";
  $("tourMask").classList.add("on");
}
$("tourNext").onclick = () => tourShow(tourIdx + 1);
$("tourSkip").onclick = () => { $("tourMask").classList.remove("on"); localStorage.setItem("zh:toured", "1"); };
$("guideTour").onclick = () => tourShow(0);
// 自动导览:仅真人浏览器(无头测试 navigator.webdriver=true 不弹,防拦截 spec 交互);测试用 __tour.show 驱动。
if (!localStorage.getItem("zh:toured") && !(navigator.webdriver)) setTimeout(() => tourShow(0), 1200);
window.__tour = { show: tourShow };
// 流式消息测试钩子:spec 直推 stream 事件序列,免起真 LLM。
if (navigator.webdriver) window.__stPush = (sid, ev) => onStreamEv({ type: "stream", sessionId: sid, ev: ev });
// ── 附件(捕获→输入区真预览→发送→聊天流回看→旧会话读盘) ──
let pendingAtts = [];
// 类型白名单 + 分类型上限(客户端预检;服务端同口径二次判)。图片 8MB / 视频 50MB / 文本 8MB。
const ATT_MAX_IMG = 8 * 1024 * 1024, ATT_MAX_VID = 50 * 1024 * 1024, ATT_MAX_TXT = 8 * 1024 * 1024;
const ATT_MAX_DOC = 64 * 1024 * 1024; // 文档(pdf/office/压缩包)上限;与 doc-text.ts 的 DOC_MAX_BYTES、服务端 DOC_UPLOAD_LIMIT 同值
const ATT_MAX_COUNT = 8; // 单轮附件上限(对齐 ZCode MAX_CHAT_ATTACHMENTS)
const ATT_PASTE_TEXT_MIN_CHARS = 15 * 1024; // 长文本粘贴阈值(对齐 ZCode LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD):超过则转临时 txt 附件,正文不进输入框
// 文本/代码扩展名白名单(零反斜杠:全部 includes/indexOf 判定,不用正则字面量)
const ATT_TEXT_EXT = [".md", ".markdown", ".txt", ".log", ".json", ".jsonc", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift",
  ".yaml", ".yml", ".toml", ".ini", ".env", ".conf", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".css", ".scss", ".less", ".html", ".xml", ".vue", ".svelte", ".csv", ".tsv", ".patch", ".diff"];
const ATT_TEXT_MIME = ["application/json", "application/javascript", "application/typescript", "application/xml", "application/x-yaml", "application/yaml", "application/toml"];
const ATT_IMG_MIME = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/svg+xml"];
const ATT_VID_MIME = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-msvideo", "video/x-matroska"];
// 文档扩展名白名单:只做「能传进来」的放行,
// 能不能解析出文本由服务端 doc-text 层如实判定(老式 OLE .doc/.ppt/.xls 与 .rar/.7z 能传但可能解析不了,前端不拦)。
const ATT_DOC_EXT = [".docx", ".pptx", ".xlsx", ".pdf", ".zip", ".rtf", ".odt", ".odp", ".ods", ".epub",
  ".tar", ".gz", ".tgz", ".7z", ".rar", ".doc", ".ppt", ".xls", ".pages", ".numbers", ".key"];
const ATT_DOC_MIME = ["application/pdf", "application/zip", "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword", "application/vnd.ms-powerpoint", "application/vnd.ms-excel",
  "application/rtf", "application/epub+zip", "application/x-tar", "application/gzip",
  "application/x-7z-compressed", "application/x-rar-compressed"];
// 后缀兜底白名单(旧 journal 事件可能缺 mime;纯 path 后缀也能判出媒体类型)
const ATT_IMG_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".ico"];
const ATT_VID_EXT = [".mp4", ".webm", ".mov", ".m4v", ".ogv", ".avi", ".mkv", ".mpeg", ".mpg"];
function attExt(name) {
  const n = String(name || "").toLowerCase();
  const i = n.lastIndexOf(".");
  return i <= 0 ? "" : n.slice(i);
}
/** 附件类型判定(返回 kind:image|video|doc|text|"";""=不在白名单,调用方明确拒绝而非静默丢弃)。*/
function attKind(name, mime) {
  const m = String(mime || "").toLowerCase();
  const e = attExt(name);
  if (m.indexOf("image/") === 0) return ATT_IMG_MIME.indexOf(m) >= 0 ? "image" : "";
  if (m.indexOf("video/") === 0) return ATT_VID_MIME.indexOf(m) >= 0 ? "video" : "";
 // doc 必须排在 text 兜底之前:压缩包(application/zip)与 office 的 OOXML mime 不能被 text 吞掉
  if (ATT_DOC_MIME.indexOf(m) >= 0) return "doc";
  if (e && ATT_DOC_EXT.indexOf(e) >= 0) return "doc";
  if (m.indexOf("text/") === 0) return "text";
  if (ATT_TEXT_MIME.indexOf(m) >= 0) return "text";
 // 无 mime(旧上传/旧 journal 事件)或 mime 不可信(octet-stream)时按后缀兜底
  if (e && ATT_IMG_EXT.indexOf(e) >= 0) return "image";
  if (e && ATT_VID_EXT.indexOf(e) >= 0) return "video";
  if (e && ATT_TEXT_EXT.indexOf(e) >= 0) return "text";
  return "";
}
function attLimitOf(kind) { return kind === "video" ? ATT_MAX_VID : kind === "image" ? ATT_MAX_IMG : kind === "doc" ? ATT_MAX_DOC : ATT_MAX_TXT; }
/** 人类可读大小(附件 chip/卡与拒绝提示共用;零外部依赖)。 */
function attSize(n) {
  const b = Number(n || 0);
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}
/** 短类型标识(文本卡左侧 [MD]/[TS] 徽标;视频 [VID] 无缩略图时兜底显示)。 */
function attTag(name, mime) {
  const e = attExt(name);
  if (e) return e.slice(1, 5).toUpperCase();
  const m = String(mime || "");
  const i = m.indexOf("/");
  return i >= 0 ? m.slice(i + 1, i + 5).toUpperCase() : "FILE";
}
/** 附件媒体 src:输入区有本地 preview/objectUrl 就用;聊天流(回看,旧事件无 preview)走 /uploads?path= 读盘。
 * path=journal 里的绝对路径,浏览器读不到,必须服务端按需回读(E 路由)。 */
function attSrc(a) {
  if (a.preview) return String(a.preview);
  if (a.objectUrl) return String(a.objectUrl);
  if (!a.path) return "";
  return "/uploads?path=" + encodeURIComponent(String(a.path)) + "&name=" + encodeURIComponent(String(a.name || ""));
}
/** 移除附件:视频 objectUrl 必须 revoke(否则整会话内存只增不减);lightbox 正开着该附件时先关。 */
function attDrop(i) {
  const a = pendingAtts[i];
  if (a && a.objectUrl) { try { URL.revokeObjectURL(a.objectUrl); } catch (e) { /* 已释放 */ } }
  pendingAtts.splice(i, 1);
  attRender();
}
/** 仅附件发送时的正文占位(正文不内联,只报粘贴文本行数/文件名,和聊天流卡片一致)。 */
function attsPlaceholder(list) {
  return "见附件:" + list.map((a) => a.pastedText ? ("粘贴文本 " + a.pastedText.lines + " 行") : String(a.name || "附件")).join("、");
}
// ── F. lightbox 预览器(输入区与聊天流共用;图片 contain / 视频 controls autoplay / 文本 pre 全文) ──
let attLbSrc = null, attLbFrom = null;
function attLightboxOpen(src, kind, name, meta, from) {
  if (!src) { toast("该附件无可用预览源", true); return; }
  const box = $("attLightbox");
  if (!box) return;
 // 关掉上一个:视频先暂停,防后台继续出声
  const prev = $("attLbMedia");
  if (prev) { const pv = prev.querySelector("video"); if (pv) pv.pause(); prev.innerHTML = ""; }
  const media = kind === "video"
    ? '<video src="' + esc(src) + '" controls autoplay preload="metadata"></video>'
    : kind === "text"
      ? '<pre class="att-lb-text">读取中…</pre>'
      : '<img src="' + esc(src) + '" alt="' + esc(name || "附件") + '">';
  $("attLbMedia").innerHTML = media;
  $("attLbName").textContent = String(name || "");
  $("attLbMeta").textContent = String(meta || "") + (kind === "text" ? " · 文本" : kind === "video" ? " · 视频" : " · 图片");
  attLbSrc = src; attLbFrom = from || null;
  box.classList.add("on"); box.setAttribute("aria-hidden", "false");
  const cb = $("attLbClose"); if (cb) cb.focus();
  if (kind === "text") attLbLoadText(src);
}
/** 文本附件全文按需回读(不内联进上下文;失败只显示可见文字,不抛异常)。 */
function attLbLoadText(src) {
  const paint = (txt) => {
    if (attLbSrc !== src) return; // 竞态守卫:期间已切到别的附件 → 丢弃本次结果
    const host = $("attLbMedia");
    if (host) host.innerHTML = '<pre class="att-lb-text">' + esc(txt) + "</pre>";
  };
  const LIM = 200000;
  const done = (body) => paint(body.length > LIM ? body.slice(0, LIM) + "\\n…(已截断,共 " + body.length + " 字符)" : body);
  if (String(src).indexOf("data:") === 0) { // 输入区文本附件本地预览就是 data URL(FileReader),需解码
    try {
      const i = src.indexOf(","), head = src.slice(0, i), body = src.slice(i + 1);
      done(head.indexOf(";base64") >= 0 ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body));
    } catch (e) { paint("读取失败:" + String(e).slice(0, 120)); }
    return;
  }
  fetch(src).then((x) => {
    if (!x.ok) throw new Error("HTTP " + x.status);
    return x.text();
  }).then(done).catch((e) => paint("读取失败:" + String((e && e.message) || e).slice(0, 120)));
}
function attLightboxClose() {
  const box = $("attLightbox");
  if (!box || !box.classList.contains("on")) return;
  const media = $("attLbMedia");
  if (media) { const v = media.querySelector("video"); if (v) { v.pause(); v.removeAttribute("src"); } media.innerHTML = ""; }
  box.classList.remove("on"); box.setAttribute("aria-hidden", "true");
  attLbSrc = null;
  const src = attLbFrom; attLbFrom = null;
  if (src && src.focus) { try { src.focus(); } catch (e) { /* 来源已随渲染替换:焦点无法回,不抛错 */ } }
}
{
  const box = $("attLightbox");
  if (box) {
    box.onclick = (e) => { if (e.target === box) attLightboxClose(); }; // 点遮罩关(点媒体本体不关)
    const cb = $("attLbClose"); if (cb) cb.onclick = () => attLightboxClose();
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && box.classList.contains("on")) { e.preventDefault(); attLightboxClose(); } });
  }
}
// 媒体点击委托(一次性):输入区 chip 与聊天流媒体卡共用 data-alb="src|kind|name|meta"。
// 缩略图带 tabindex=0(键盘可达):Enter/Space 同点击打开 lightbox,关闭后焦点才回得来。
document.addEventListener("click", (e) => {
  const t = e.target && e.target.closest ? e.target.closest("[data-alb]") : null;
  if (!t) return;
 // 聊天流视频自带 controls:点它是要播放/拖进度,不夺去开 lightbox(要放大有「放大」按钮)
  if (e.target && e.target.tagName === "VIDEO" && e.target.hasAttribute("controls")) return;
  if (e.target && e.target.closest && e.target.closest(".ac-x")) return; // 移除叉不误开预览
  attAlbOpen(t);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
  const t = e.target && e.target.closest ? e.target.closest("[data-alb]") : null;
  if (!t || t.tagName === "BUTTON" || t.tagName === "VIDEO") return; // 按钮自带 click 语义不重复
  e.preventDefault();
  attAlbOpen(t);
});
function attAlbOpen(t) {
  const raw = t.getAttribute("data-alb") || "";
  const parts = raw.split("|");
  if (parts.length < 4) return;
  attLightboxOpen(parts[0], parts[1], parts[2], parts.slice(3).join("|"), t);
}
/** 聊天流附件卡(D 回看):图片真实缩略图 / 视频就地播放器 / 文本文件卡。
 * src 一律走 /uploads?path=(journal 只存绝对路径,浏览器读不到;旧事件无 preview 同样显示)。 */
function attRowHtml(list) {
  return '<div class="att-row">' + list.map((a) => {
    const kind = attKind(a.name, a.mime);
    const src = attSrc(a);
    const tag = '<span class="att-kind">' + esc(attTag(a.name, a.mime)) + "</span>";
    const meta = a.size ? '<span class="att-meta">' + attSize(a.size) + "</span>" : ""; // 旧事件无 size 时不显示假 0 B
    const alb = esc(src + "|" + kind + "|" + String(a.name || "") + "|" + attSize(a.size));
    if (kind === "image" && src) {
      return '<span class="att-card att-media-card" title="点击放大:' + esc(a.name) + '"><img class="att-cthumb" tabindex="0" role="button" aria-label="放大预览 ' + esc(a.name) + '" data-alb="' + alb + '" src="' + esc(src) + '" alt="' + esc(a.name) + '">' + tag + esc(a.name) + meta + "</span>";
    }
    if (kind === "video" && src) {
      return '<span class="att-card"><video class="att-cvid" controls preload="metadata" src="' + esc(src) + '"></video><span>' + tag + esc(a.name) + meta + '</span><button class="att-zoom" type="button" data-alb="' + alb + '">放大</button></span>';
    }
 // 文档卡:纯标签卡(扩展名徽标如 DOCX/PPTX),刻意不挂 data-alb——点开会把二进制当 utf8 渲染成乱码;内容由 agent 解析
    if (kind === "doc") {
      return '<span class="att-card att-text-card" title="文档附件:发送后由 agent 解析内容">' + tag + esc(a.name) + meta + "</span>";
    }
 // 文本卡整卡可点(lightbox 回读全文);无预览源(path 缺失)时不挂 data-alb,避免点开报错
    return src
      ? '<span class="att-card att-text-card" title="点击查看全文" data-alb="' + esc(src + "|text|" + String(a.name || "") + "|" + attSize(a.size)) + '">' + tag + esc(a.name) + meta + "</span>"
      : '<span class="att-card">' + tag + esc(a.name) + meta + "</span>";
  }).join("") + "</div>";
}/** 输入区缩略图/视频 chip;聊天流媒体卡复用同一点击语义(共同 data-alb="src|kind|name|meta")。 */
function attRender() {
  const bar = $("attBar");
  bar.style.display = pendingAtts.length ? "flex" : "none";
  bar.innerHTML = pendingAtts.map((a, i) => {
    const kind = a.kind || attKind(a.name, a.mime);
    const src = attSrc(a);
    const x = '<span class="ac-x" data-i="' + i + '" title="移除">' + ic("x") + "</span>";
    if (kind === "image") {
      return '<span class="att-chip att-media"><img class="att-thumb" tabindex="0" role="button" aria-label="放大预览 ' + esc(a.name) + '" data-alb="' + esc(src + "|image|" + a.name + "|" + attSize(a.size)) + '" src="' + esc(src) + '" alt="' + esc(a.name) + '" title="点击放大:' + esc(a.name) + '">' +
        "<span>" + esc(a.name) + '</span><span class="att-meta">' + attSize(a.size) + "</span>" + x + "</span>";
    }
    if (kind === "video") {
 // video 不设 src 属性(否则 preload=metadata 也拉全量),由脚本设 src 取首帧(见 attThumbs 绑定)
      return '<span class="att-chip att-media"><video class="att-vthumb" tabindex="0" role="button" aria-label="播放预览 ' + esc(a.name) + '" data-alb="' + esc(src + "|video|" + a.name + "|" + attSize(a.size)) + '" data-vsrc="' + esc(src) + '" preload="metadata" muted playsinline title="点击播放:' + esc(a.name) + '"></video>' +
        "<span>" + esc(a.name) + '</span><span class="att-meta">' + attSize(a.size) + "</span>" + x + "</span>";
    }
 // 文本 chip(含粘贴长文本):整 chip 可点开 lightbox 看全文;无 src 时不挂 data-alb
    const tlabel = a.pastedText ? ("粘贴文本 · " + a.pastedText.lines + " 行") : String(a.name || "");
    const ttitle = a.pastedText ? ("粘贴文本 " + a.pastedText.chars + " 字符 / " + a.pastedText.lines + " 行 · 点击查看全文") : "点击查看全文";
 // 文档 chip:纯标签卡,刻意不挂 data-alb(二进制点开是乱码);发送后由 agent 解析内容
    if (kind === "doc") {
      return '<span class="att-chip att-text" title="文档附件:发送后由 agent 解析内容"><span class="att-kind">' + esc(attTag(a.name, a.mime)) + "</span>" + esc(tlabel) +
        '<span class="att-meta">' + attSize(a.size) + "</span>" + x + "</span>";
    }
    return '<span class="att-chip att-text"' + (src ? ' title="' + esc(ttitle) + '" data-alb="' + esc(src + "|text|" + tlabel + "|" + attSize(a.size)) + '"' : "") +
      '><span class="att-kind">' + esc(attTag(a.name, a.mime)) + "</span>" + esc(tlabel) +
      '<span class="att-meta">' + attSize(a.size) + "</span>" + x + "</span>";
  }).join("");
  for (const el of bar.querySelectorAll(".att-vthumb")) if (el.dataset.vsrc) { el.preload = "metadata"; el.src = el.dataset.vsrc; }
  for (const x of bar.querySelectorAll(".ac-x")) x.onclick = () => attDrop(Number(x.dataset.i));
}
/** 剪贴板文本是不是表格(Excel/Sheets 复制同时给 text/plain + 合成 PNG:必须优先当文本,别把表格存成截图)。 */
function attClipboardTabular(text) {
  return text.indexOf("\\t") >= 0 && text.split("\\n").length >= 2;
}
/** 两位补零(临时文件名的时间戳用;不引日期库)。 */
function attPad2(n) { return n < 10 ? "0" + n : String(n); }
/** 长文本粘贴 → 落临时 txt 附件(对齐 ZCode:输入框正文不留内容,只多一个 chip;发送时只给绝对路径)。 */
function attPasteTextAsFile(text) {
  const bytes = new Blob([text]).size;
  if (bytes > ATT_MAX_TXT) {
    toast("粘贴文本 " + attSize(bytes) + " 超过文本附件上限 " + attSize(ATT_MAX_TXT) + ",未转存;请拆分为多个附件", true);
    return; // 绝不回退把正文塞进输入框(否则长文本又占满输入框/上下文)
  }
  if (pendingAtts.length >= ATT_MAX_COUNT) { toast("附件最多 " + ATT_MAX_COUNT + " 个", true); return; }
  const d = new Date();
  const name = "pasted-text-" + d.getFullYear() + attPad2(d.getMonth() + 1) + attPad2(d.getDate()) + "-" +
    attPad2(d.getHours()) + attPad2(d.getMinutes()) + attPad2(d.getSeconds()) + ".txt";
  const f = new File([text], name, { type: "text/plain" });
  attPostUpload(f, currentSid || "__draft__", { kind: "text", pastedText: { chars: text.length, lines: text.split("\\n").length } });
}
function attUpload(file) {
  const kind = attKind(file.name, file.type);
  const size = Number(file.size || 0);
  if (!kind) { toast("不支持的类型:" + file.name + "(" + (file.type || attExt(file.name) || "无扩展名") + ")——支持图片/视频/文本代码/文档(pdf、word、ppt、excel、zip 等)", true); return; }
  const lim = attLimitOf(kind);
  if (size > lim) { toast("附件超限:" + file.name + " 实际 " + attSize(size) + ",上限 " + attSize(lim) + "(" + (kind === "video" ? "视频" : kind === "image" ? "图片" : kind === "doc" ? "文档" : "文本") + ")", true); return; }
  const sid = currentSid || "__draft__";
 // 文档(pdf/office/压缩包)不走 readAsDataURL:64MB 转 base64 会炸内存,且前端没有可用预览——直接传,发送后由 agent 解析
  if (kind === "doc") { attPostUpload(file, sid, { kind: "doc" }); return; }
 // 图片读 dataURL(输入区缩略图 + lightbox 立即可见);视频走 objectUrl(本地播放器,不占 base64 内存)
  if (kind === "video") {
    let objUrl = "";
    try { objUrl = URL.createObjectURL(file); } catch (e) { objUrl = ""; }
    attPostUpload(file, sid, { kind: kind, objectUrl: objUrl });
    return;
  }
  const r = new FileReader();
  r.onload = () => attPostUpload(file, sid, { kind: kind, preview: String(r.result) });
  r.onerror = () => toast("附件读取失败:" + file.name, true);
  r.readAsDataURL(file);
}
/** 正文上传:落 .genie/uploads/<sid>/ 拿回绝对 path;path 是聊天流回看读盘的唯一凭据。 */
function attPostUpload(file, sid, extra) {
  if (pendingAtts.length >= ATT_MAX_COUNT) { toast("附件最多 " + ATT_MAX_COUNT + " 个", true); return; }
  fetch("/upload?sid=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(file.name), { method: "POST", body: file })
    .then((x) => x.json())
    .then((j) => {
      if (j.error) { if (extra && extra.objectUrl) { try { URL.revokeObjectURL(extra.objectUrl); } catch (e) { /* 已释放 */ } } toast("上传失败:" + j.error, true); return; }
      pendingAtts.push({ name: file.name, path: j.path, mime: file.type || "application/octet-stream", size: file.size, kind: extra.kind, ...(extra.preview ? { preview: extra.preview } : {}), ...(extra.objectUrl ? { objectUrl: extra.objectUrl } : {}), ...(extra.pastedText ? { pastedText: extra.pastedText } : {}) });
      attRender();
      localStorage.setItem("zh:used-attach", "1");
      toast(extra.pastedText
        ? "已转为临时文本附件:" + extra.pastedText.lines + " 行 / " + extra.pastedText.chars + " 字符"
        : "附件就绪:" + file.name + "(" + attSize(file.size) + ")");
    })
    .catch((e) => { if (extra && extra.objectUrl) { try { URL.revokeObjectURL(extra.objectUrl); } catch (e2) { /* 已释放 */ } } toast("上传失败:" + String(e).slice(0, 80), true); });
}
$("attBtn").onclick = () => {
 // 添加上下文聚合菜单(视频 2,对齐 ZCode「+」入口;此前=直接开文件选择)
  pillMenuOpen($("attBtn"), [{ items: [
    { value: "添加附件(文件/图片/文档)", sub: "图片进视觉通道;文本/代码/文档(pdf、word、ppt、excel、zip)由 agent 读取" },
    { value: "@ 引用文件(会话/文件检索)", sub: "命令中心文件域" },
    { value: "图片标注(圈点写意见→发任务)", sub: "选本地图片,框选/点选写意见后发给当前会话;截图走输入框旁 ✂" },
  ] }], "", (picked) => {
    if (picked.indexOf("添加附件") === 0) $("attInput").click();
    else if (picked.indexOf("@") === 0) { switchView("chat"); ccOpen(); $("cc-q").value = "@"; ccRender(); }
    else if (picked.indexOf("图片标注") === 0) { const inp = document.getElementById("annImportInput"); if (inp) inp.click(); }
  });
};
$("attInput").onchange = () => { for (const f of $("attInput").files) attUpload(f); $("attInput").value = ""; };
// 拖拽与粘贴(三条入口同一条 attUpload 通道;全页拖拽 + 输入框粘贴)
// 注意:面板内 issue 卡拖拽另有 10385/10389 一处 dragover/drop(不带 Files 的文件路径,互不干扰:那边只处理
// 自定义 MIME text/plain 的卡拖动,这边只在 dataTransfer.files 非空时动手)。
document.addEventListener("dragover", (e) => { if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf("Files") >= 0) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) attUpload(f);
});
$("instruction").addEventListener("paste", (e) => {
 // 长文本粘贴 → 临时 txt 附件(对齐 ZCode):先于文件项判定,e.preventDefault 只在真的要转附件时调
  const cd = e.clipboardData || {};
  let text = "";
  try { text = String(cd.getData ? (cd.getData("text/plain") || "") : ""); } catch (err) { text = ""; }
  if (text && text.length >= ATT_PASTE_TEXT_MIN_CHARS) { e.preventDefault(); attPasteTextAsFile(text); return; }
 // 表格剪贴板(Excel/Sheets)自带合成 PNG:有制表符+多行时让浏览器原生插入文本,别再当截图上传
  if (text && attClipboardTabular(text)) return;
 // 粘贴入口扩到视频(截图/复制的图片仍走 image/*;剪贴板里的视频文件同样可贴)
  const items = (e.clipboardData || {}).items || [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const ty = String(it.type || "");
    if (ty.indexOf("image/") !== 0 && ty.indexOf("video/") !== 0) continue;
    const f = it.getAsFile();
    if (f) { attUpload(f); e.preventDefault(); }
  }
});
// ── 侧栏入口 ──
$("act-market").onclick = () => { switchView("market"); wsSafeSend(JSON.stringify({ v: 1, type: "plugins.list" })); localStorage.setItem("zh:used-market", "1"); };
// act-web(2026-11 browser-ux-redo):浏览器入口恢复到左栏一眼可见(用户用户反馈「难用到爆」),
// 原 「入口只留 Ctrl+Alt+B 与设置页」的口径作废;点击绑定见 act-web 段。
$("act-web") && ($("act-web").onclick = () => switchView("browser"));
// ---- F6 白板:pointer 手绘 + 青铜四色 + 橡皮 + 线宽 + 清空/导出 + localStorage 自动保存 ----
const WB_LS = "zh:whiteboard";
let wbColor = "#c98f45";
let wbDrawing = false;
function wbCtx() { const c = $("wbCanvas"); return c ? c.getContext("2d") : null; }
function wbDpr() { return window.devicePixelRatio || 1; }
// 草稿键按 (会话, 板) 隔离(批注串台修复):全局单键会把 A 会话/A 板的笔迹带到
// B 会话/B 板;__session__ 无语义板时的会话级草稿同样各占一键。
function wbKey() { return WB_LS + ":" + (currentSid || "_") + ":" + (boardTaskId || "__session__"); }
function wbClearCanvas() { const c = $("wbCanvas"); const ctx = wbCtx(); if (c && ctx) ctx.clearRect(0, 0, c.width, c.height); }
// 在途笔画作废(切板/换会话打断):半笔归属旧板,不允许落进新板(切板竞态防写错板)。
function wbAbortStroke() {
  if (!wbDrawing) return;
  wbDrawing = false;
  const ctx = wbCtx();
  if (ctx) ctx.globalCompositeOperation = "source-over";
}
function wbResize() {
  const c = $("wbCanvas");
  if (!c) return;
 // 位图尺寸必须用「布局尺寸」(clientWidth/clientHeight)——不能用 getBoundingClientRect:
 // 后者含画布视口 transform 缩放(卡片在无限画布上被缩放时 rect 会跟着变),
 // 拿它当位图尺寸会让位图与 CSS 盒子不一致 → 笔迹被拉伸、指针坐标错位。
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  const dpr = wbDpr();
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  wbRestore();
}
function wbRestore(prefer) {
 // 批注层数据源优先级(会话级落盘):显式传入 > 服务端 overlay(当前语义板/会话批注) >
 // 本板 localStorage 离线草稿(键按 sid:taskId 隔离)。语义板在场时不回落 __session__/他板草稿(防串台)。
 // 无数据源=清空画布:空白是合法态(该板本就没有批注),残留上一板笔迹才是缺陷;先清后画,重复恢复不叠影。
  let data = prefer || null;
  if (!data && boardTaskId && boardOverlayB64) data = "data:image/png;base64," + boardOverlayB64;
  if (!data && !boardTaskId && sessionOverlayB64) data = "data:image/png;base64," + sessionOverlayB64;
  if (!data) { try { data = localStorage.getItem(wbKey()); } catch (e) { data = null; } }
  wbClearCanvas();
  if (!data) return;
  const c = $("wbCanvas");
  const img = new Image();
  img.onload = () => {
    const ctx = wbCtx();
    if (ctx && c) ctx.drawImage(img, 0, 0, c.width / wbDpr(), c.height / wbDpr());
  };
  img.src = data;
}
function wbPos(e) {
  const c = $("wbCanvas");
  const r = c.getBoundingClientRect();
 // 笔迹坐标空间=布局像素(clientWidth),而 getBoundingClientRect 含画布视口 transform 缩放:
 // 卡片被缩放时两者不等,直接相减会让笔迹整体偏移/错位。按 rect/clientWidth 的比例折算回
 // 未缩放坐标;经典布局下比例恒为 1(行为与以往完全一致)。防 0 保底走 1。
  const k = c.clientWidth ? r.width / c.clientWidth : 1;
  const s = k > 0 ? k : 1;
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}
function wbSave() {
  const c = $("wbCanvas");
  if (!c || !c.toDataURL) return;
  const dataUrl = c.toDataURL("image/png");
 // 草稿落本板键(同步写,此刻 boardTaskId 即归属;切板打断走 wbAbortStroke 不进这里)
  try { localStorage.setItem(wbKey(), dataUrl); } catch (err) { /* 存储满:静默(草稿不致命) */ }
 // 服务端批注层(会话级落盘):开着语义板→随任务;没开板→__session__(笔迹跟会话走,
 // 换浏览器/刷新不丢);localStorage 仅作离线兜底草稿。
  if (currentSid && ws && ws.readyState === 1) {
    const b64 = String(dataUrl.split(",")[1] || "");
 // C6:超协议上限(4MB 图)不进服务端——只落本地草稿,静默(防每笔都弹「批注图不合法」)
    if (b64 && b64.length < 5_600_000) {
      const t = boardTaskId || "__session__";
      if (boardTaskId) boardOverlayB64 = b64; else sessionOverlayB64 = b64;
      wsSafeSend(JSON.stringify({ v: 1, type: "board.overlay.save", sessionId: currentSid, taskId: t, dataB64: b64 }));
    }
  }
}
function wbBind() {
  const c = $("wbCanvas");
  if (!c || c.dataset.wbBound) return;
  c.dataset.wbBound = "1";
  c.addEventListener("pointerdown", (e) => {
    const ctx = wbCtx();
    if (!ctx) return;
    wbDrawing = true;
    const p = wbPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    const base = Number($("wbWidth").value) || 2;
    if (wbColor === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = base * 6;
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = base;
      ctx.strokeStyle = wbColor;
    }
    if (c.setPointerCapture) { try { c.setPointerCapture(e.pointerId); } catch (err) { /* 指针已释放则忽略 */ } }
  });
  c.addEventListener("pointermove", (e) => {
    if (!wbDrawing) return;
    const ctx = wbCtx();
    if (!ctx) return;
    const p = wbPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const end = () => {
    if (!wbDrawing) return;
    wbDrawing = false;
    const ctx = wbCtx();
    if (ctx) ctx.globalCompositeOperation = "source-over";
    wbSave();
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointerleave", end);
  c.addEventListener("pointercancel", end);
}
function wbWire() {
  for (const b of document.querySelectorAll(".wb-color")) {
    b.onclick = () => {
      wbColor = b.dataset.c || "#c98f45";
      for (const x of document.querySelectorAll(".wb-color")) x.classList.toggle("on", x === b);
    };
  }
  $("wbClear").onclick = () => {
    const c = $("wbCanvas");
    const ctx = wbCtx();
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    try { localStorage.removeItem(wbKey()); } catch (err) { /* 忽略 */ }
 // 服务端批注层同步清空(空 dataB64=删除语义);只清当前 (会话,板) 的缓存,不动他板
    if (boardTaskId) boardOverlayB64 = null; else sessionOverlayB64 = null;
    if (currentSid && ws && ws.readyState === 1) wsSafeSend(JSON.stringify({ v: 1, type: "board.overlay.save", sessionId: currentSid, taskId: boardTaskId || "__session__", dataB64: "" }));
  };
  $("wbExport").onclick = () => {
    const c = $("wbCanvas");
    if (!c || !c.toDataURL) return;
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = "whiteboard-" + Date.now() + ".png";
    a.click();
  };
  wbBind();
}
wbWire();
$("act-board").onclick = () => switchView("board");
window.addEventListener("resize", () => { if (viewLive("board")) wbResize(); });

// ---- 语义流程白板:BoardDoc 渲染=mermaid 流程图 + 节点卡 + 明细卡 ----
let boardDoc = null;      // 当前板(BoardDoc)
let boardLinks = [];      // symbolRef 三态(服务端解析)
let boardItems = [];      // 会话内板清单(选择器)
let boardTaskId = "";     // 当前选中任务的板
// 工作流板运行态:taskId → { wfId, states: {nodeId→{state,ms?,detail?}}, done, ok, error?, items?, at }
// 会话内存态(刷新丢;journal workflow.node 有全痕);切换板不清理——按 taskId 键控,回切板状态还在。
let wfRuns = {};
let boardSelNode = null;  // 明细卡节点 id
// n2 评论模式(设计板 n1+n2):画布形态下评论入口原先只藏在明细卡里(必须先点中节点),
// 打开后点任意节点/点节点卡「评 N」徽标即就地展开该节点评论框,不必先进明细卡。
let boardCommentMode = false;
// c2:最近一次评论写请求(update/delete/append)。服务端可能整笔拒收(board-store saveBoard 门禁:
// status=done 且 P0 验收证据未覆盖全),旧实现乐观 toast「已修改」+ 静默吞掉错误帧 → 用户看到编辑框消失、
// 评论还是原文,却不知道被拒了。这里记下在途请求,error 回执到达时给可读原因,并保持原文不改成已保存态。
let bdLastCmtReq = null;
let boardMissing = "";    // 钉选但盘上失踪(删/坏)的板 taskId——显式降级渲染依据,空=正常
let boardListSkipped = 0; // board.list.result 回带的损坏板文件数(区分「真无板」与「板损坏」)
// n12 未处理评论:board.list.result 的 items[].pendingComments 是「本会话内 agent 尚未读到」的
// 评论数(服务端 peek board-comments 队列,按 taskId 聚合)。存成 taskId→节点 id 集合,让画布节点卡能直接高亮
// 「哪几个节点上有没被读到的评论」;chip 只关心哪块板 >0。
let boardListPending = {};  // taskId → { count:number, nodes:string[] }(服务端只给 count,节点集合本地按 doc 回填)
// n12:board.list 的「只为刷新 pending 计数」标记——置位时回包只更新 chip/高亮,不重钉选择/不重拉板(防 doc↔list 回环)
let boardListPendingOnly = false;
let bdPendingPullAt = 0;    // n12:上一次为刷新待读计数发 board.list 的时刻(1500ms 节流)
// n14 多板搜索/过滤:查询词与类型筛选中放在模块级,重渲(board.changed/切板)不清空。
let bfListQuery = "";
let bfListKind = "";        // ""=全部,或 design/page/workflow(与 board.doc docKind 同词)
const BD_CHANGE = { add: "新增", modify: "修改", delete: "删除", keep: "涉及" };
// code flow 专用变更文案:流程卡上 keep 的语义是「复用现有函数/代码,不改」,
// 通用面板的「涉及」读不出这层意思(用户看图说「看不懂」)。BD_CHANGE 不动——bd 列表/编辑下拉仍用它。
const CV_CHG_LABEL = { add: "新增", modify: "改", delete: "删", keep: "复用" };
const BD_CHANGE_ICON = { add: "+", modify: "Δ", delete: "×", keep: "○" }; // 面板 emoji 门禁(2700-27BF 段被拦):只用 ASCII/希腊字母/几何圈
/** 板清单拉取。n6:sid 缺省=当前选中会话(入参化后,切会话重载不会又把上一会话的 id 发出去)。 */
function boardRefresh(sid) {
  const bs = sid === undefined ? currentSid : sid;
  if (!bs) { boardItems = []; boardDoc = null; boardTaskId = ""; boardOverlayB64 = null; sessionOverlayB64 = null; boardMissing = ""; boardListSkipped = 0; renderBoard(); return; } // B7:换/空会话清残留,防旧板 id 带过来
 // 启动 CONNECTING 窗守卫:刷新后启动视图还原(board)会在开连前走到这里,裸 send 抛
 // InvalidStateError 且中断启动脚本尾部(board.spec 零 pageerror 检查间歇注意)——defer 到开连重放。
  if (ws.readyState !== 1) {
    if (!boardRefresh.__queued) {
      boardRefresh.__queued = true;
      ws.addEventListener("open", () => { boardRefresh.__queued = false; boardRefresh(); }, { once: true });
    }
    return;
  }
  wsSafeSend(JSON.stringify({ v: 1, type: "board.list", sessionId: bs }));
  overlayPull(bs);
}
// 切板上下文切换(批注串台/写错板竞态修复):作废在途笔画(半笔归属旧板不落盘)、
// 丢弃旧板批注缓存(board.doc 未到前不得再画旧板)、切到新上下文后立即清台——新板数据
// 未到前画布保持空白,此窗内新笔画落的是新板的干净状态。boardGet 与 bfOpenBoard(浮窗
// chip 直达,先钉 boardTaskId 再拉)共用这一套。
function wbSwitchTask(next) {
  wbAbortStroke();
  boardOverlayB64 = null;
  sessionOverlayB64 = null;
  boardTaskId = next;
  cvViewTouched = false; // 切板=视野归系统管:下一块板首次渲染照旧自动适配
  wbRestore();
}
function boardGet(taskId) {
  if (!currentSid) return;
  const next = taskId || boardTaskId;
  if (next !== boardTaskId) wbSwitchTask(next);
  wsSafeSend(JSON.stringify({ v: 1, type: "board.get", sessionId: currentSid, ...(boardTaskId ? { taskId: boardTaskId } : {}) }));
}
function bdEscMm(s) { return String(s || "").replace(/"/g, "'").replace(/[\[\]]/g, (c) => (c === "[" ? "(" : ")")).replace(/\\n/g, " ").replace(/\\|/g, "/"); } // 反斜杠双写=模板层纪律;mermaid 边标签里 | 是终止符必须转(B4)
// A修复:边标签(管道 |...| 语法)里 ASCII 括号是非法字符——bdEscMm 把 [] 转成 
// 反而制造非法括号(「点笔记出处(书名+页码)」类标签必现 Parse error→简图碎成源码墙)。
// 边标签专用:括号/方括号全转全角(mermaid 视为普通文本),裸 | 转走(管道标签终止符)。
// 写法纪律:零正则转义(split/map/join)——panel 模板层会吃掉单反斜杠转义(经验证 \[ 下发变 [、\| 变
// 空=每字符间插 /),regex 字符类转义在本文件一律不可靠(见 bdEscMm 注释「反斜杠双写」)。
function bdEscMmEdge(s) {
  const M = { "[": "【", "]": "】", "(": "（", ")": "）", "|": "/", '"': "'" };
  return String(s || "").split("").map((c) => (M[c] !== undefined ? M[c] : c)).join("");
}
function bdLinkOf(nodeId) { return boardLinks.find((l) => l.nodeId === nodeId) || null; }
function boardMermaid(doc) {
  const L = ["flowchart TD"];
 // C1:消毒后可能撞名("n-1" 与 "n_1" 同形)——按 id 记忆化分配,撞名加序号
  const nidMap = new Map();
  const nid = (id) => {
    if (nidMap.has(id)) return nidMap.get(id);
    const base = "bd" + String(id).replace(/[^A-Za-z0-9_]/g, "_");
    let out = base;
    let k = 1;
    const used = new Set(nidMap.values());
    while (used.has(out)) out = base + "_" + k++;
    nidMap.set(id, out);
    return out;
  };
  for (const n of doc.nodes) {
    const lk = bdLinkOf(n.id);
    const broken = lk && lk.state === "broken" ? " 【断链】" : "";
    const label = BD_CHANGE_ICON[n.change] + " " + bdEscMm(n.label) + broken + "<br/>" + bdEscMm(String(n.summary || "").slice(0, 42));
    L.push("  " + nid(n.id) + (n.kind === "decision" ? '{"' + label + '"}' : '["' + label + '"]'));
  }
  for (const e of doc.edges) {
    if (!doc.nodes.some((n) => n.id === e.from) || !doc.nodes.some((n) => n.id === e.to)) continue;
 // contains 边简图也无箭头(---),nav/call/data/verify 保持 -->
    L.push("  " + nid(e.from) + (e.kind === "contains" ? " ---|" : " -->|") + bdEscMmEdge(e.label || (e.kind === "data" ? "数据" : e.kind === "verify" ? "验证" : e.kind === "nav" ? "跳转" : e.kind === "contains" ? "包含" : "调用")) + "| " + nid(e.to));
  }
  L.push("  classDef bdAdd fill:#1e3323,stroke:#5aa06a,color:#ece1d1;");
  L.push("  classDef bdModify fill:#33240f,stroke:#c98f45,color:#ece1d1;");
  L.push("  classDef bdDelete fill:#381d18,stroke:#e08a7a,color:#ece1d1;");
  L.push("  classDef bdKeep fill:#241f1a,stroke:#8a7a5a,color:#ece1d1;");
  const byChange = { add: [], modify: [], delete: [], keep: [] };
  for (const n of doc.nodes) (byChange[n.change] || byChange.modify).push(nid(n.id));
  if (byChange.add.length) L.push("  class " + byChange.add.join(",") + " bdAdd;");
  if (byChange.modify.length) L.push("  class " + byChange.modify.join(",") + " bdModify;");
  if (byChange.delete.length) L.push("  class " + byChange.delete.join(",") + " bdDelete;");
  if (byChange.keep.length) L.push("  class " + byChange.keep.join(",") + " bdKeep;");
  return L.join(String.fromCharCode(10));
}
function bdFlowHtml(steps, depth) {
  if (!steps || !steps.length) return "";
  let h = '<ul class="bd-flow"' + (depth ? ' style="margin-left:2px"' : "") + ">";
  for (const s of steps) {
    if (s.type === "branch") {
 // 空 cond 兜底:此前输出「如果 ?」= 空标签;显式写明「(条件略)」,不留悬空条件
      h += '<li><span class="fl-cond">如果 ' + esc(String(s.cond == null ? "" : String(s.cond).trim() || "(条件略)")) + "</span>";
      if (s.then && s.then.length) h += '<div class="fl-sub">' + bdFlowHtml(s.then, depth + 1) + "</div>";
      if (s.else && s.else.length) h += '<div class="fl-sub"><span class="fl-cond">否则</span>' + bdFlowHtml(s.else, depth + 1) + "</div>";
      h += "</li>";
    } else if (s.type === "loop") {
      h += '<li><span class="fl-cond">循环 ' + esc(String(s.over == null ? "" : String(s.over).trim() || "(集合略)")) + "</span>"; // 单引号外框:模板层吃 \" 转义(实测),双引号嵌套会断串
      if (s.body && s.body.length) h += '<div class="fl-sub">' + bdFlowHtml(s.body, depth + 1) + "</div>";
      h += "</li>";
    } else {
      h += "<li>" + esc(s.text || "") + "</li>";
    }
  }
  return h + "</ul>";
}
/** flow 树递归统计(白板 flow 可见性):节点卡折叠态也要能看出「有没有分支/循环」——
 * 旧版 flow 只藏在明细卡深处(必须先点中节点才看得到)。返回 {branch,loop,step,total}。 */
function bdFlowStat(steps) {
  const st = { branch: 0, loop: 0, step: 0, total: 0 };
  const walk = (arr) => {
    for (const s of arr || []) {
      if (!s) continue;
      st.total++;
      if (s.type === "branch") { st.branch++; walk(s.then); walk(s.else); }
      else if (s.type === "loop") { st.loop++; walk(s.body); }
      else st.step++;
    }
  };
  walk(steps);
  return st;
}
/** 节点卡里的语义流程摘要行:<details> 折叠态就给「分支 N / 循环 M / 步骤 K」一行,点开复用 bdFlowHtml 递归块。 */
function bdFlowSumHtml(n) {
  if (!n || !n.flow || !n.flow.length) return "";
  const st = bdFlowStat(n.flow);
  const bits = [];
  if (st.branch) bits.push("分支 " + st.branch);
  if (st.loop) bits.push("循环 " + st.loop);
  if (st.step) bits.push("步骤 " + st.step);
  return '<details class="bd-flowsum" data-flow="1" data-det-key="' + esc("flow:" + String(n.id || "")) + '"><summary title="点开看完整语义流程(条件/循环递归展开)">语义流程 ' +
    esc(bits.length ? bits.join(" / ") : st.total + " 步") + "</summary>" + bdFlowHtml(n.flow, 0) + "</details>";
}
// ---- 节点勾选派发(纯 UI 态):勾选=模块级 Set(nodeId),不落盘、不进 board.save 的 nodes,
// 只决定「派发选中」这次 board.continue 带哪些 nodeIds;切板/重绘后按 data-node 从 Set 恢复勾选。 ----
const bdSel = new Set();
/** 勾选态变化后刷新工具条「已选 N 个」与「派发选中」按钮可用性(幂等,N 不依赖 DOM 是否在位)。 */
function bdSelRender() {
  if (typeof boardDoc !== "undefined" && boardDoc) {
 // 板上已不存在的节点(被删/换板)从 Set 里摘掉,不把幽灵 id 派发出去
    const ids = new Set((boardDoc.nodes || []).map((x) => x.id));
    for (const id of Array.from(bdSel)) if (!ids.has(id)) bdSel.delete(id);
  } else if (bdSel.size) {
    bdSel.clear();
  }
  const cnt = $("bdSelCount");
  if (cnt) cnt.textContent = "已选 " + bdSel.size + " 个";
  const btn = $("bdDispatchSel");
  if (btn) btn.disabled = bdSel.size === 0;
}
/** 派发勾选节点:复用 boardContinue 的 board.continue 写法,只多带 nodeIds。成功(task.submitted)才清空勾选。 */
function bdDispatchSel() {
  if (!boardDoc) { toast("当前没有白板", true); return; }
  const ids = Array.from(bdSel);
  if (!ids.length) { toast("先勾选要派发的节点", true); return; }
  const btn = $("bdDispatchSel");
  if (btn) btn.disabled = true; // 防双击重发;失败路径由 bdSelRender 复位
  uiPrompt("派发这 " + ids.length + " 个勾选节点:补充你的要求(可空,直接确定=按节点继续)", "", { allowEmpty: true }).then((note) => {
    if (note === null) { bdSelRender(); return; }
    const sent = new Set(ids); // 快照:回执前用户又勾/取消不影响本次判定
    wsSafeSend(JSON.stringify({ v: 1, type: "board.continue", sessionId: currentSid, taskId: boardTaskId, note, nodeIds: ids }));
    toast("已派发勾选的 " + ids.length + " 个节点");
 // 成功清空:服务端接住=task.submitted 且 task.sessionId 命中(与 board.continue 同一回执通道);
 // 失败=error 帧(兜底 toast 后不留勾选),两条都撤掉监听(超时 12s 自清,防监听泄漏)。
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      ws.removeEventListener("message", onMsg);
      if (ok) { for (const id of sent) bdSel.delete(id); toast("派发成功:已按勾选节点发起续作任务"); }
      else toast("派发失败:勾选保留,可重试", true);
      bdSelRender();
      try { renderBoard(); } catch (e) { /* 板视图不在场=跳过重绘 */ }
    };
    const onMsg = (ev) => {
      let m2 = null;
      try { m2 = JSON.parse(ev.data); } catch (e) { return; }
      if (!m2) return;
      if (m2.type === "task.submitted" && m2.task && m2.task.sessionId === currentSid) { finish(true); return; }
      if (m2.type === "error") finish(false); // board-not-found/其它任何 error 帧都算失败:勾选不清空
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => { if (!done) { done = true; ws.removeEventListener("message", onMsg); bdSelRender(); } }, 12000);
  });
}
// fixD6: 编辑态离开/刷新零防护——草稿未保存时挂 beforeunload 拦一道(浏览器原生 confirm)。
// 挂/摘统一走 renderBoard 漏斗(编辑态进出必经:boardEditToggle/保存回执/放弃/冲突拉取/浮窗切板),幂等防重挂。
let bdUnloadGuardOn = false;
const bdUnloadGuard = (e) => { e.preventDefault(); e.returnValue = ""; };
function bdSyncUnloadGuard() {
  const need = !!(boardEditOn && boardDraft);
  if (need === bdUnloadGuardOn) return;
  bdUnloadGuardOn = need;
  if (need) window.addEventListener("beforeunload", bdUnloadGuard);
  else window.removeEventListener("beforeunload", bdUnloadGuard);
}
function renderBoard() {
  if (arcOpen) return; // 设计沉淀只读画布在位:不重渲会话板(cvActiveHost 让位给档案画布);arcClose 收尾时补渲
  if (!boardEditOn) boardConflict = null; // 冲突条只在编辑态存活(放弃/保存成功/切板即清)
  bdSyncUnloadGuard(); // fixD6
  bdSelRender(); // 勾选派发:重绘漏斗里先同步工具条(已选 N 个/按钮可用性;换板时清掉不存在的节点 id)
  const sel = $("boardTaskSel");
  if (sel) {
    sel.innerHTML = boardItems.length
      ? boardItems.map((i) => '<option value="' + esc(i.taskId) + '"' + (i.taskId === boardTaskId ? " selected" : "") + ">" + esc(i.title).slice(0, 40) + " · " + esc(i.status) + (i.status === "done" ? "" : " · " + i.nodeCount + "节点") + "</option>").join("")
      : '<option value="">(本会话无白板)</option>';
  }
 // 宿主泛化(浮窗升级):画布同一时刻只渲染在一个宿主(bdHome)——大白板与浮窗是同一板状态的两个视口
  const g = bdGraphHost();
  const nb = bdNodesHost(); // 浮窗宿主时为 null(节点卡清单条是大白板件,浮窗走右抽屉明细)
  const box = bdDetailHost();
  const doc = boardEditOn && boardDraft ? boardDraft : boardDoc; // 编辑态:图渲染草稿=即时预览
  const editBar = $("boardEditBar");
  if (editBar) editBar.style.display = boardEditOn && boardDraft ? "flex" : "none";
  const editBtn = $("boardEditBtn");
  if (editBtn) editBtn.textContent = boardEditOn ? "退出编辑" : "编辑";
 // 工作流板件位:编译/执行/存自动化只在 docKind=workflow 板出现(编辑草稿也可编译预览)
  const isWfBoard = !!(doc && doc.docKind === "workflow");
  for (const bid of ["boardWfCompile", "boardWfRun", "boardWfAuto"]) {
    const b = $(bid);
    if (b) b.style.display = isWfBoard ? "" : "none";
  }
  const ebF = $("bfEdit");
  if (ebF) ebF.textContent = boardEditOn ? "退出编辑" : "编辑";
  if (bdHome === "float") {
 // 大白板主区放指路牌(不同时渲染两份画布,cv* 全套按全局单 cvHost 工作);
 // 明细区一并清空——里面有旧渲染的交互件(评论输入等),留着力与浮窗同名 id 抢 $("") 全局查找
    const bg = $("boardGraph");
    if (bg) bg.innerHTML = '<div class="cc-empty">白板正在浮窗中展示——浮窗里有本会话全部白板;点 composer「白板」或浮窗「展开」回到这里</div>';
    const bd = $("boardDetail");
    if (bd) bd.innerHTML = '<div class="cc-empty">白板正在浮窗中展示——点 composer「白板」或浮窗「展开」回到这里</div>';
    if (nb) nb.innerHTML = "";
  }
  if (!g) return;
  if (!doc) {
 // 显式降级三态:钉选板失踪(删/坏)> 清单全坏 > 真无板——互不冒充(经验证:删板曾静默滑到别的板,坏板曾冒充「还没有白板」)。
    if (boardMissing) {
      g.innerHTML = '<div class="cc-empty">该白板已不存在或文件损坏(taskId ' + esc(boardMissing.slice(0, 24)) + ')——板上数据在 .genie/boards 下,可能被外部删除;从左侧清单/选择器另选一块板</div>';
      if (nb) nb.innerHTML = "";
      if (box) box.innerHTML = '<div class="cc-empty">该白板文件缺失——无可显示明细</div>';
      return;
    }
    if (!boardItems.length && boardListSkipped > 0) {
      g.innerHTML = '<div class="cc-empty">本会话有 ' + boardListSkipped + ' 块白板文件损坏或不可读,已跳过(详见服务日志;板上文件在 .genie/boards 下可人工检视);可点「刷新」重试</div>';
      if (nb) nb.innerHTML = "";
      if (box) box.innerHTML = '<div class="cc-empty">白板文件损坏——无可显示明细</div>';
      return;
    }
    g.innerHTML = '<div class="cc-empty">该会话还没有设计白板——代码改动类任务,agent 会先画设计草图再动手;任务卡上的「白板」chip 可直达对应板</div>';
    if (nb) nb.innerHTML = "";
    if (box) box.innerHTML = '<div class="cc-empty">点节点看「干什么用」与语义流程</div>';
    return;
  }
 // 计划 vs 实际对账徽标(任务 done 后回填 actual_files;编辑态不显示——草稿未落盘谈不上对账)
  let recon = "";
  if (!boardEditOn && doc.actual_files) {
    const planned = new Set(doc.planned_files || []);
    const actual = new Set(doc.actual_files || []);
    const missed = [...actual].filter((f) => !planned.has(f));
    const dropped = [...planned].filter((f) => !actual.has(f));
    recon = missed.length === 0 && dropped.length === 0
      ? ' · <span class="bd-tag lk-linked">计划=实际 ' + ic("check") + "</span>"
      : ' · <span class="bd-tag lk-moved" title="计划外触碰:' + esc(missed.join(",")) + " 计划未做:" + esc(dropped.join(",")) + '">对账:计划外 ' + missed.length + " / 未做 " + dropped.length + "</span>";
  }
  const mer = boardMermaid(doc);
  const statusTxt = boardEditOn ? "编辑中(未保存)" : doc.status === "draft" ? "设计稿" : doc.status === "implementing" ? "实施中" : "已落实";
  if (boardCanvasMode) {
 // 六期:工作流画布为主模式(节点卡+贝塞尔边+平移缩放拖拽+档案跳转);mermaid 简图保留为切换项
    renderBoardCanvas(doc);
  } else if (window.mermaid) {
    mermaid.render("bdm" + Date.now() + Math.floor(Math.random() * 1e5), mer).then((o) => {
      g.innerHTML = (o && o.svg ? o.svg : String(o)) +
        '<div class="bd-meta">「' + esc(doc.title) + "」 " + (boardEditOn ? "编辑中(未保存)" : doc.status === "draft" ? "设计稿" : doc.status === "implementing" ? "实施中" : "已落实") + " · rev " + doc.rev + " · " + doc.nodes.length + " 节点/" + bdEdgeCountText(doc) + bdCountSeg(doc) + (doc.docKind === "page" ? ' · <span class="bd-tag lk-moved">页面结构板</span>' : doc.docKind === "workflow" ? ' · <span class="bd-tag lk-linked">工作流板</span>' : "") + recon + bdP0Tags(doc) + "</div>";
    }).catch(() => { g.textContent = mer; toast("简图渲染失败,已显示源码(边标签含非法字符,已修转义;此为兜底)"); }); // :静默回退改可感知(:用户面对源码墙不知所以)
  } else {
    g.textContent = mer;
  }
 // 节点卡(点击→明细;图节点不可点=刻意,mermaid SVG 事件不可靠,卡清单是主交互)——浮窗宿主时不渲(右抽屉承担)
  if (nb) {
 // n1/A3:卡清单按泳道分组渲染(无边板也分组),节点号=声明顺序编号
    const groups = bdLaneGroups(doc);
    const noOf = new Map();
    let seq = 0;
    for (const n of doc.nodes) { seq++; noOf.set(n.id, (seq < 10 ? "0" : "") + seq); }
    const cardOf = (n) => {
      const lk = boardEditOn ? null : bdLinkOf(n.id);
      const lkTag = lk ? '<span class="bd-tag lk-' + lk.state + '">' + (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") + "</span>" : "";
      const delBtn = boardEditOn ? '<button class="bd-del" data-del="' + esc(n.id) + '" title="删除节点" style="float:right;background:none;border:none;color:var(--faint);cursor:pointer;font-size:11px">×</button>' : "";
 // 勾选派发(纯 UI 态):checked 从模块级 Set 恢复——重绘/切板后勾选态不丢(不写板)
      const selBox = '<input type="checkbox" class="bd-sel" data-sel="' + esc(n.id) + '" title="勾选后点工具条「派发选中」,只把这几个节点编成续作指令"' + (bdSel.has(n.id) ? " checked" : "") + ">";
      return '<div class="bd-card' + (n.id === boardSelNode ? " on" : "") + '" data-node="' + esc(n.id) + '">' + delBtn +
        '<span class="bd-name">' + selBox + '<span class="bd-no" title="声明顺序编号">' + noOf.get(n.id) + "</span>" + (n.done ? '<span class="bf-done">' + ic("check") + " </span>" : "") + BD_CHANGE_ICON[n.change] + " " + esc(n.label) + '<span class="bd-tag ' + n.change + '">' + BD_CHANGE[n.change] + "</span>" + (n.comments && n.comments.length ? '<span class="bd-tag lk-moved">评论 ' + n.comments.length + "</span>" : "") + lkTag + "</span>" +
        '<div class="bd-sum">' + esc(n.summary) + "</div>" + bdFlowSumHtml(n) + bdAccCardHtml(n) + "</div>";
    };
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    $("boardNodes").innerHTML = groups.map((g) =>
      '<div class="bd-grp" data-lane="' + esc(g.key) + '">' +
      '<div class="bd-grp-h"><b>' + esc(g.no) + "</b>" + esc(g.label) + "</div>" +
      g.ids.map((id) => (byId.get(id) ? cardOf(byId.get(id)) : "")).join("") + "</div>",
    ).join("") + (boardEditOn ? '<div class="bd-card" data-add="1" style="border-style:dashed;color:var(--muted)"><span class="bd-name">+ 加模块</span><div class="bd-sum">新增一个设计节点</div></div>' : "");
    for (const c of $("boardNodes").querySelectorAll(".bd-card")) {
      if (c.dataset.add) { c.onclick = () => bdAddNode(); continue; }
 // C2:点卡只换选中态+明细卡,不重渲 mermaid(图没变,重渲=每次点卡闪一次)
      c.onclick = () => {
        if (boardEditOn && boardSelNode && boardSelNode !== c.dataset.node && !bdSyncDraftFromForm()) return;
        boardSelNode = c.dataset.node;
        for (const x of $("boardNodes").querySelectorAll(".bd-card")) x.classList.toggle("on", x.dataset.node === boardSelNode);
        renderBoardDetail();
      };
    }
 // 勾选框:只改 Set + 工具条计数,不碰选中态/明细卡(点勾不等于点卡——stopPropagation 挡卡点击)
    for (const sb of $("boardNodes").querySelectorAll(".bd-sel")) {
      sb.onclick = (e) => {
        e.stopPropagation();
        if (sb.checked) bdSel.add(sb.dataset.sel); else bdSel.delete(sb.dataset.sel);
        bdSelRender();
      };
    }
    bdSelRender(); // 重绘后同步「已选 N 个」与按钮可用性(勾选态从 Set 恢复)
    for (const d of $("boardNodes").querySelectorAll(".bd-del")) {
      d.onclick = (e) => { e.stopPropagation(); bdDelNode(d.dataset.del); };
    }
  }
  if (!box) return;
  if (boardEditOn) renderBoardDetail();
  else if (boardSelNode && doc.nodes.some((n) => n.id === boardSelNode)) renderBoardDetail();
  else box.innerHTML = '<div class="cc-empty">点节点看「干什么用」与语义流程</div>';
}
/** c1 单条评论行:正文 + 「改」「删」小按钮。index 即本渲染顺序 = 服务端 node.comments 下标
 * (持久化形状不变,仍是纯字符串数组);data-node 冗余带节点 id,浮窗/大白板交替重渲后 handler 仍能定位。
 * 正文一律走 esc——评论是人写的自由文本,绝不裸插 innerHTML。 */
function bdCommentRowHtml(text, idx, nodeId) {
  const i = Number(idx);
  const nid = esc(String(nodeId == null ? "" : nodeId));
  return '<div class="bf-cmt-row" data-cmt="' + i + '">' +
    '<div class="bf-cmt">' + esc(text) + "</div>" +
    '<div class="bf-cmt-acts">' +
    '<button class="bdCmtEdit" data-idx="' + i + '" data-node="' + nid + '" title="编辑这条评论">改</button>' +
    '<button class="bdCmtDel" data-idx="' + i + '" data-node="' + nid + '" title="删除这条评论">删</button>' +
    "</div></div>";
}
/** c1 从板数据取第 idx 条评论正文(编辑框预填用;不信任 DOM 文本,取权威值)。 */
function bdCommentText(nodeId, idx) {
  const d = boardDoc;
  const n = d && d.nodes ? d.nodes.find((x) => x.id === String(nodeId || "")) : null;
  const cs = n && n.comments ? n.comments : [];
  const i = Number(idx);
  return i >= 0 && i < cs.length ? String(cs[i]) : "";
}
/** c1 评论发送**单一出处**(明细卡/画布就地浮层/编辑行共用):
 * append=追加(服务端并发安全合并)、update=按 index 改、delete=按 index 删。
 * 改/删不登记「未处理评论」(那是新待办标记);服务端回 board.doc + board.changed,面板既有回执链重渲列表。 */
function bdSendComment(o) {
  const opt = o || {};
  const nodeId = String(opt.nodeId || "");
  if (!nodeId || !boardTaskId || !currentSid) { toast("评论上下文缺失(先选中白板)", true); return false; }
  const op = opt.op || "append";
  const msg = { v: 1, type: "board.comment", sessionId: currentSid, taskId: boardTaskId, nodeId: nodeId, op: op };
  if (op === "append" || op === "update") {
    const text = String(opt.text == null ? "" : opt.text).trim();
    if (!text) { toast("评论内容为空", true); return false; }
    msg.text = text.slice(0, 500);
  }
  if (op !== "append") msg.index = Number(opt.index); // 改/删:index 必带(服务端越界回 comment-index-out-of-range)
 // n12:新评论先记「落在哪个节点」→ 该节点立刻挂 cmt-pending 高亮(权威计数随 board.doc/list 回包刷新);
 // 改/删是收拾旧评论,不算新待办,不动高亮。
  if (op === "append") { try { bdPendingNoteNode(boardTaskId, nodeId); } catch (e) { /* 旧脚本缓存=忽略 */ } }
  wsSafeSend(JSON.stringify(msg));
 // c2:记在途请求——服务端可能整笔拒收(board-store saveBoard 门禁),错误帧不带 sessionId/taskId,
 // 只能按「最近一笔评论写请求」认领(见 wsOnMessage 的 bdLastCmtReq 分支)。
  bdLastCmtReq = { op: op, nodeId: nodeId, index: op === "append" ? -1 : Number(opt.index), at: Date.now() };
 // 改/删只报「提交中」:落盘与否由服务端回执决定,不预先冒充已保存(先前「评论已修改」在拒收时是假成功)。
  toast(op === "append" ? "评论已提交" : "评论" + (op === "update" ? "修改" : "删除") + "提交中…");
  return true;
}
/** c1 就地编辑态:把该条评论行换成「input(预填原文)+ 保存/取消」,保存发 op=update。
 * host 作用域限定本次渲染宿主(浮窗宿主时全局 $ 会摸到旧渲染的同名元素)。 */
function bdOpenCommentEditor(host, nodeId, idx) {
  const i = Number(idx);
  if (!(i >= 0)) return false;
  const row = host && host.querySelector ? host.querySelector('.bf-cmt-row[data-cmt="' + i + '"]') : null;
  if (!row) return false;
  const ed = document.createElement("div");
  ed.className = "bf-cmt-edit";
  ed.innerHTML = '<input id="bdCmtEditInp" maxlength="500"><button class="vw-act" id="bdCmtEditSave">保存</button><button class="vw-act" id="bdCmtEditCancel">取消</button>';
  row.parentNode.insertBefore(ed, row.nextSibling);
  row.style.display = "none";
  const inp = ed.querySelector("#bdCmtEditInp");
  if (inp) inp.value = bdCommentText(nodeId, i);
  const closeEd = () => { ed.remove(); row.style.display = ""; };
  const save = ed.querySelector("#bdCmtEditSave");
  if (save) save.onclick = () => {
    const text = inp && inp.value.trim();
    if (!text) { toast("评论内容为空", true); return; }
    if (!bdSendComment({ op: "update", nodeId: nodeId, index: i, text: text })) return;
    closeEd(); // 服务端回执(board.doc)会带权威文本再重渲一次,这里先收编辑态
  };
  const cancel = ed.querySelector("#bdCmtEditCancel");
  if (cancel) cancel.onclick = () => { closeEd(); };
  if (inp) setTimeout(() => { try { inp.focus(); } catch (e) { /* 忽略 */ } }, 0);
  return true;
}
/** c1 给一处评论列表里的「改」「删」按钮挂处理器(明细卡与画布浮层共用;作用域=传入宿主)。 */
function bdBindCommentRows(host, nodeId) {
  if (!host || !host.querySelectorAll) return;
  const nid = String(nodeId == null ? "" : nodeId);
  for (const b of host.querySelectorAll(".bdCmtEdit")) {
    b.onclick = (e) => {
      e.stopPropagation();
      bdOpenCommentEditor(host, b.dataset.node || nid, b.dataset.idx);
    };
  }
  for (const b of host.querySelectorAll(".bdCmtDel")) {
    b.onclick = (e) => {
      e.stopPropagation();
      bdSendComment({ op: "delete", nodeId: b.dataset.node || nid, index: b.dataset.idx });
    };
  }
}
function renderBoardDetail() {
  const box = bdDetailHost(); // 浮窗宿主=右抽屉,大白板宿主=右侧明细卡
  if (!box) return;
 // 浮窗编辑态:大白板的「保存白板/放弃」条在大白板视图里,浮窗自带一条(同一保存链 boardSave)
  const editBarF = boardEditOn && boardDraft && bdHome === "float"
    ? '<div class="bf-editbar"><span>编辑中:改的是设计不是代码</span><button class="vw-act" id="bdeSaveF" style="border-color:var(--bronze)">保存白板</button><button class="vw-act" id="bdeCancelF">放弃</button></div>'
    : "";
  const bindEditBarF = () => {
    if (!editBarF) return;
    const s = box.querySelector("#bdeSaveF");
    if (s) s.onclick = () => boardSave();
    const c = box.querySelector("#bdeCancelF");
    if (c) c.onclick = () => { boardEditOn = false; boardDraft = null; renderBoard(); };
  };
 // 编辑态:选中节点=节点表单;未选中=板级表单(标题+连线编辑)
  if (boardEditOn && boardDraft) {
    const inp = 'style="width:100%;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);border-radius:8px;padding:4px 8px;font-size:12px;margin-top:4px"';
    const lab = (t) => '<div class="bd-meta" style="margin-top:8px">' + t + "</div>";
 // rev 冲突条(草稿保留):拉取最新放弃草稿 / 继续编辑(改动可自行复制走)
    const conflictBar = boardConflict
      ? '<div class="bd-conflict" style="border:1px solid #e08a7a;border-radius:8px;padding:6px 8px;font-size:11.5px;color:#e08a7a;margin-bottom:6px">草稿与并发版本冲突(当前 rev ' + boardConflict.currentRev + ')——' +
        '<button class="vw-act" id="bdcPull" style="margin-right:6px">拉取最新放弃草稿</button><button class="vw-act" id="bdcKeep">继续编辑</button></div>'
      : "";
    const bindConflictBar = () => {
      const pull = box.querySelector("#bdcPull");
      if (pull) pull.onclick = () => { const t2 = boardConflict && boardConflict.taskId; boardConflict = null; boardEditOn = false; boardDraft = null; if (t2) boardGet(t2); else renderBoard(); };
      const keep = box.querySelector("#bdcKeep");
      if (keep) keep.onclick = () => { boardConflict = null; renderBoardDetail(); };
    };
    const dn = boardSelNode ? bdDraftNode(boardSelNode) : null;
    if (!dn) {
      let h = conflictBar + '<div class="bd-name" style="font-size:13px">板级设置</div>';
      h += lab("板标题") + '<input id="bdeTitle" ' + inp + ' value="' + esc(boardDraft.title) + '">';
      h += lab("连线(调用/数据/验证)");
 // fixD7: 既有边标签可直接编辑(旧实现只能 × 删了重连——丢 virtual 标记/评论侧上下文);kind/virtual 字段不动,只改 label
      h += boardDraft.edges.map((e, i) => '<div class="bd-meta" style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">' + esc(e.from) + " → " + esc(e.to) +
        (e.virtual ? ' <span class="bd-tag lk-moved" title="虚拟边:人工标注,非代码索引实证">虚</span>' : "") +
        ' <input data-edge-label="' + i + '" style="flex:1;min-width:80px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);border-radius:6px;padding:2px 6px;font-size:11px" placeholder="边说明(可空)" value="' + esc(e.label || "") + '">' +
        ' <button class="bd-del" data-edge="' + i + '" style="background:none;border:none;color:var(--faint);cursor:pointer">×</button></div>').join("") || '<div class="bd-meta">无</div>';
      const opts = (selV) => boardDraft.nodes.map((n) => '<option value="' + esc(n.id) + '"' + (n.id === selV ? " selected" : "") + ">" + esc(n.id) + " " + esc(n.label).slice(0, 14) + "</option>").join("");
      h += '<div style="display:flex;gap:4px;margin-top:6px"><select id="bdeEdgeFrom" ' + inp + '>' + opts("") + '</select><select id="bdeEdgeTo" ' + inp + '>' + opts(boardDraft.nodes[1] ? boardDraft.nodes[1].id : "") + '</select></div>';
      h += '<div style="display:flex;gap:4px;margin-top:4px"><select id="bdeEdgeKind" ' + inp + '><option value="call">调用</option><option value="data">数据</option><option value="verify">验证</option></select><input id="bdeEdgeLabel" ' + inp + ' placeholder="边说明(可空)"></div>';
      h += '<button class="vw-act" id="bdeAddEdge" style="margin-top:6px">加连线</button>';
      h += '<div class="bd-meta" style="margin-top:10px">选中节点卡=编辑该模块;改完点上方「保存白板」一并提交。</div>';
      h += editBarF;
      box.innerHTML = h;
      bindEditBarF();
      bindConflictBar();
      $("bdeAddEdge").onclick = () => { bdSyncDraftFromForm(); bdAddEdge(); };
      for (const d of box.querySelectorAll(".bd-del")) d.onclick = () => bdDelEdge(Number(d.dataset.edge));
 // fixD7: 边标签输入直写 boardDraft.edges[i].label(即时收编,「保存白板」统一提交;不重渲=不抢输入焦点)
      for (const li of box.querySelectorAll("[data-edge-label]")) {
        li.oninput = () => { const ed = boardDraft.edges[Number(li.dataset.edgeLabel)]; if (ed) ed.label = li.value.trim(); };
      }
      return;
    }
    let h = conflictBar + '<div class="bd-name" style="font-size:13px">编辑节点 ' + esc(dn.id) + "</div>";
    h += lab("名称(函数/模块名)") + '<input id="bdeLabel" ' + inp + ' value="' + esc(dn.label) + '">';
 // 十期:类型下拉全 16 类(与协议枚举/画布色板同源分组;人可改出 agent 用的全部工作流类型)
    const kindSel = CV_KIND_GROUPS.map((g) => '<optgroup label="' + g[0] + '">' + g[1].map((k2) => '<option value="' + k2 + '"' + (dn.kind === k2 ? " selected" : "") + ">" + (CV_KIND_NAME[k2] || k2) + "</option>").join("") + "</optgroup>").join("");
    h += lab("类型 / 改动") + '<div style="display:flex;gap:4px"><select id="bdeKind" ' + inp + '>' + kindSel + "</select>" +
      '<select id="bdeChange" ' + inp + '>' + [["add", "新增"], ["modify", "修改"], ["delete", "删除"], ["keep", "仅涉及"]].map((kv) => '<option value="' + kv[0] + '"' + (dn.change === kv[0] ? " selected" : "") + ">" + kv[1] + "</option>").join("") + "</select></div>";
    h += lab("干什么用(必填,人读)") + '<textarea id="bdeSummary" ' + inp + ' rows="3">' + esc(dn.summary) + "</textarea>";
    h += lab("原来的形态(改动前是什么样;modify/delete 节点该填)") + '<input id="bdeBefore" ' + inp + ' value="' + esc(dn.before || "") + '" placeholder="可空">';
    h += lab("代码连接(符号名 / 文件,可空=新模块)") + '<input id="bdeSymName" ' + inp + ' value="' + esc(dn.symbolRef ? dn.symbolRef.name : "") + '" placeholder="如 createGatewayApp">' +
      '<input id="bdeSymFile" ' + inp + ' value="' + esc(dn.symbolRef && dn.symbolRef.file ? dn.symbolRef.file : "") + '" placeholder="如 apps/gateway/src/app.ts">';
    h += lab("语义流程(步骤: x / 如果 cond: / 否则: / 循环 x: ——嵌套用两空格缩进)") +
      '<textarea id="bdeFlow" ' + inp + ' rows="7" style="font-family:var(--mono)">' + esc(bdFlowToText(dn.flow, 0)) + "</textarea>";
 // 工作流板:类型化参数表单(配置抽屉;按 kind 渲染,双击画布节点即达)
    if (String(dn.kind).indexOf("wf-") === 0) {
      const wf = dn.wf || {};
      const num = (id, v, ph) => '<input id="' + id + '" ' + inp + ' type="number" min="1000" max="600000" step="1000" value="' + esc(String(v ?? "")) + '" placeholder="' + ph + '">';
      h += '<div class="bd-meta" style="margin-top:12px;color:var(--bronze)">节点参数(编译执行用)</div>';
      if (dn.kind === "wf-script" || dn.kind === "wf-test") {
        h += lab(dn.kind === "wf-script" ? "command(world.run 白名单命令)" : "command(测试命令;退出码非 0=失败,后续不跑)") +
          '<textarea id="bdeWfCommand" ' + inp + ' rows="2" style="font-family:var(--mono)">' + esc(wf.command || "") + "</textarea>";
        h += lab("timeoutMs(超时毫秒;缺省 120000)") + num("bdeWfTimeout", wf.timeoutMs, "120000");
      } else if (dn.kind === "wf-agent") {
        h += lab("actor(子代理名,缓存身份键)") + '<input id="bdeWfActor" ' + inp + ' value="' + esc(wf.actor || "worker") + '">';
        h += lab("instructions(派发指令,必填)") + '<textarea id="bdeWfInstr" ' + inp + ' rows="4">' + esc(wf.instructions || "") + "</textarea>";
      } else if (dn.kind === "wf-condition") {
        h += lab('cond(JS 表达式;引用 R["<节点id>"],如 R["n1"].code === 0)') +
          '<input id="bdeWfCond" ' + inp + ' style="font-family:var(--mono)" value="' + esc(wf.cond || "") + '">';
        h += '<div class="bd-meta">出边在「板级设置」加:两条出边 label 一条「真」一条「假」。</div>';
      } else if (dn.kind === "wf-notify") {
        h += lab("message(通知/成果内容,必填)") + '<textarea id="bdeWfMsg" ' + inp + ' rows="2">' + esc(wf.message || "") + "</textarea>";
      } else if (dn.kind === "wf-parallel") {
        h += '<div class="bd-meta">并发扇出无参数:本节点全部出边(≥2)同时执行,全部完成才算本节点完成。</div>';
      }
    }
    h += '<div class="bd-meta" style="margin-top:8px">改完切节点自动入草稿;「保存白板」统一提交(rev 乐观锁)。</div>';
    h += editBarF;
    box.innerHTML = h;
    bindEditBarF();
    bindConflictBar();
    return;
  }
  const n = boardDoc && boardDoc.nodes.find((x) => x.id === boardSelNode);
  if (!n) { box.innerHTML = '<div class="cc-empty">点节点看「干什么用」与语义流程</div>'; return; }
  const lk = bdLinkOf(n.id);
  let h = '<div class="bd-name" style="font-size:13px">' + (n.done ? '<span class="bf-done">' + ic("check") + " </span>" : "") + BD_CHANGE_ICON[n.change] + " " + esc(n.label) + "</div>";
  h += '<div class="bd-meta">' + (n.kind === "module" ? "模块" : n.kind === "decision" ? "决策点" : n.kind === "note" ? "备注" : n.kind === "page" ? "页面" : n.kind === "section" ? "区块" : n.kind === "component" ? "组件" : n.kind === "nav" ? "导航" : String(n.kind).indexOf("wf-") === 0 ? "工作流步骤 · " + (CV_KIND_NAME[n.kind] || n.kind) : CV_KIND_NAME[n.kind] || "函数") + // :page/section/component 落「函数」兜底是误导;未列举 kind 走画布同名表
    ' · <span class="bd-tag ' + n.change + '">' + BD_CHANGE[n.change] + "</span>" + (n.done ? ' · <span class="bf-done">已落实</span>' : "") + "</div>";
 // 工作流板:查看态参数回显 + 运行态(双击节点可进编辑改参数)
  if (String(n.kind).indexOf("wf-") === 0) {
    const wf = n.wf || {};
    const wfCfg = n.kind === "wf-script" || n.kind === "wf-test"
      ? "command: " + (wf.command || "(未配置)")
      : n.kind === "wf-agent" ? "actor: " + (wf.actor || "worker") + " · 指令: " + (wf.instructions ? String(wf.instructions).slice(0, 120) : "(未配置)")
      : n.kind === "wf-condition" ? "cond: " + (wf.cond || "(未配置)")
      : n.kind === "wf-notify" ? "message: " + (wf.message || "(未配置)")
      : "并发扇出(无参数)";
    h += '<div class="bd-meta" style="margin-top:6px">参数:<span style="color:var(--muted);font-family:var(--mono)">' + esc(wfCfg) + (wf.timeoutMs ? " · timeout " + wf.timeoutMs + "ms" : "") + "</span>" +
      ' · <span style="color:var(--bronze);cursor:pointer" id="bdWfEditHint" title="进入编辑改参数">双击画布节点可改</span></div>';
    const st = boardTaskId && wfRuns[boardTaskId] && wfRuns[boardTaskId].states ? wfRuns[boardTaskId].states[n.id] : null;
    if (st) h += '<div class="bd-meta" style="margin-top:4px">运行态:<span class="cv-wf-badge ' + st.state + '">' + (st.state === "running" ? "运行中" : st.state === "done" ? "完成" : "失败") + "</span>" + (st.ms !== undefined ? " · " + st.ms + "ms" : "") + (st.detail ? " · " + esc(st.detail) : "") + "</div>";
  }
  h += '<div style="font-size:12px;color:var(--text);margin-top:8px;line-height:1.6">' + esc(n.summary) + "</div>";
  if (n.before) h += '<div class="bd-meta" style="margin-top:6px">原来:<span style="color:var(--muted)">' + esc(n.before) + "</span> → " + BD_CHANGE[n.change] + "</div>";
  if (n.symbolRef) {
    h += '<div class="bd-meta" style="margin-top:8px">代码连接:' + esc(n.symbolRef.name) +
      (n.symbolRef.file ? " · " + esc(n.symbolRef.file) + (lk && lk.line ? ":" + lk.line : n.symbolRef.line ? ":" + n.symbolRef.line : "") : "");
    if (lk) h += ' <span class="bd-tag lk-' + lk.state + '">' + (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") + "</span>" + (lk.note ? '<div class="bd-meta">' + esc(lk.note) + "</div>" : "");
    h += "</div>";
  } else {
    h += '<div class="bd-meta" style="margin-top:8px">新模块(无既有代码连接)</div>';
  }
 // 纯文件链(模块/页面/架构节点)——明细卡展示入口文件,可点跳档案
  if (!n.symbolRef && n.fileRef) {
    h += '<div class="bd-meta" style="margin-top:8px">入口文件:<span class="cv-file" data-cvfile="' + esc(n.fileRef) + '" style="cursor:pointer;text-decoration:underline">' + esc(n.fileRef) + "</span></div>";
  }
  if (n.flow && n.flow.length) {
    h += '<div class="bd-meta" style="margin-top:10px;color:var(--bronze)">语义流程</div>' + bdFlowHtml(n.flow, 0);
  }
 // n2 白板可见化:验收契约逐条(command/expect/三态徽标)+ 证据输出摘要(明细卡是「白板在干什么活」的主面)
  h += bdAccDetailHtml(n);
 // n10 关系段:验收证据之后、评论区之前——出边/入边/孤立节点 + 推导徽标
  h += bdRelHtml(boardDoc, n.id);
 // 评论区(五期):查看态直接评论,服务端追加免冲突;「按板续作」带进指令
 // c1(编辑/删除):每条评论带「改」「删」——index 即本渲染顺序(与服务端 node.comments 同序)
  const cs = n.comments || [];
  h += '<div class="bd-meta" style="margin-top:10px;color:var(--bronze)">用户评论</div><div class="bf-comments">' +
    (cs.length ? cs.map((c, ci) => bdCommentRowHtml(c, ci, n.id)).join("") : '<div class="bd-meta">还没有评论</div>') +
    '<div class="bf-cmt-input"><input id="bdCmtInput" placeholder="写评论(按板续作会带给 agent)" maxlength="500"><button class="vw-act" id="bdCmtSend">评论</button></div></div>';
  box.innerHTML = h;
 // 入口文件链( fileRef):明细卡内可点跳代码档案(与画布 cv-file 同链)
  for (const fl2 of box.querySelectorAll(".cv-file")) {
    fl2.onclick = (e) => { e.stopPropagation(); bdOpenProfile(fl2.dataset.cvfile); };
  }
 // c1:逐条「改」「删」绑定(作用域同为本渲染的 box,理由同下)
  bdBindCommentRows(box, n.id);
 // 评论区发送(作用域取本渲染的元素,不用 $ 全局查——浮窗宿主时大白板侧可能还有旧渲染同名 id)
  const sendBtn = box.querySelector("#bdCmtSend");
  const cmtInp = box.querySelector("#bdCmtInput");
  if (sendBtn) sendBtn.onclick = () => {
    const text = cmtInp && cmtInp.value.trim();
    if (!bdSendComment({ op: "append", text: text, nodeId: n.id })) return;
    if (cmtInp) cmtInp.value = "";
  };
}
$("boardRefresh").onclick = () => boardRefresh();
// 「更多」溢出菜单——菜单项转调原按钮(监听器/ID 单一出处,不重复绑定);点外面/选中后收起
const bMore = $("boardMore");
if (bMore) {
  bMore.addEventListener("click", (e) => {
    const t = e.target.closest("[data-for]");
    if (!t) return;
    bMore.open = false;
    const orig = document.getElementById(t.getAttribute("data-for"));
    if (orig) orig.click();
  });
  document.addEventListener("click", (e) => { if (bMore.open && !bMore.contains(e.target)) bMore.open = false; });
}
$("boardTaskSel").onchange = (e) => {
 // C5:编辑中切板=静默丢草稿——拦住并复位选择器
  if (boardEditOn) { e.target.value = boardTaskId; toast("编辑中:先「保存白板」或「放弃」,再切换白板", true); return; }
  boardSelNode = null;
  boardGet(e.target.value);
};
$("boardSketchBox").addEventListener("toggle", (e) => {
 // 展开=批注层恢复时机(刷新/重登空白修复):wbResize 内部走 wbRestore——
 // 有服务端 overlay/本板草稿则画出,没有则清台(空白=该板确无批注,不是丢失)。
 // 慢盘/慢布局下 30ms 内 rect 可能还是 0(wbResize 静默早退),轮询几次直到量到尺寸。
  if (!e.target.open) return;
  let n = 0;
  const tick = () => {
    const c = $("wbCanvas");
 // 用 clientWidth(布局尺寸),不用 getBoundingClientRect(含画布视口缩放,画布形态下恒 >0 但位图尺寸会错)
    const w = c ? c.clientWidth : 0;
    wbResize();
    if (!w && n++ < 6) setTimeout(tick, 80);
  };
  setTimeout(tick, 30);
});
// 任务卡白板 chip:会话重放里点「白板」直达该任务的板(入口统一 :开实时白板浮窗,不再切主视图)
function boardOpenTask(taskId) {
 // C5:编辑中跳另一块板=草稿丢失,先确认
  if (boardEditOn && taskId !== boardTaskId) {
    uiConfirm("放弃当前未保存的白板编辑?", { tone: "warning", ok: "放弃编辑" }).then((ok) => {
      if (!ok) return;
      boardEditOn = false; boardDraft = null; boardSelNode = null;
      bfOpenBoard(taskId);
    });
    return;
  }
  boardEditOn = false; boardDraft = null;
  boardSelNode = null;
  bfOpenBoard(taskId);
}
/** 白板入口画布分流(画布形态下点「白板」不要弹浮窗,直接定位画布上的白板卡):
 * 画布形态 → 钉住目标板(与浮窗入口同一套 wbSwitchTask 防护)+ 拉板 + CanvasShell.focus("board")
 * 平移取景到白板卡(卡内大白板视图与浮窗同一板状态,数据链零改动);经典布局 → 原 boardOpenTask
 * 浮窗行为不变(含 C5 编辑确认链)。编辑中切板回退原入口走确认,不静默丢草稿。
 * CanvasShell 资产不可用/聚焦异常时同样回退,入口永不失灵。 */
function boardEntryGo(taskId) {
  const id = String(taskId || "");
  const cv = window.CanvasShell;
  const inCanvas = !!(cv && cv.isCanvas && cv.isCanvas());
  if (inCanvas && !(boardEditOn && id && id !== boardTaskId)) {
    try {
      boardEditOn = false; boardDraft = null; boardSelNode = null; // 与 boardOpenTask 同口径:入口点击=离开编辑态
      if (id && id !== boardTaskId) wbSwitchTask(id);
      if (id) boardGet(id); else boardRefresh();
      cv.focus("board", { zoom: true });
      return;
    } catch (err) { console.warn("[canvas] 白板卡定位失败,回退浮窗", err); }
  }
  boardOpenTask(id);
}

// ---- 实时白板浮窗(入口统一+升级):composer「白板」与任务卡「白板/查看白板」chip 都开这里;
// 左=会话全部板清单,中=Dify 风画布(复用十期全套:直改板/连线/撤销…),右=节点明细+评论。
// 状态机:浮窗与大白板是同一全局板状态(boardDoc/boardTaskId/boardEditOn)的两个视口——
// 画布同一时刻只渲染在一个宿主(bdHome),保存链(bdSaveLayoutDebounced/boardSave)与撤销栈零改动生效。 ----
let bfOpen = false;
let bdHome = "board";     // 当前画布宿主:"board"=大白板视图 | "float"=浮窗
let bfFitPending = false; // 打开浮窗/切板后自适应一次(记旗,board.doc 落位后执行)
function bdGraphHost() { return bdHome === "float" ? $("bfGraph") : $("boardGraph"); }
function bdDetailHost() { return bdHome === "float" ? $("bfDetail") : $("boardDetail"); }
function bdNodesHost() { return bdHome === "float" ? null : $("boardNodes"); } // 节点卡清单条是大白板件,浮窗用右抽屉明细
function bfOpenBoard(taskId) {
 // 统一入口:开浮窗并选中指定板(chip 带 taskId 时先钉住选择——board.list.result 按 boardTaskId 保持)。
 // 钉选走 wbSwitchTask(与 boardGet 同一套切板防护:作废在途笔画/丢旧板批注缓存/清台),不能裸写 boardTaskId。
  if (taskId && taskId !== boardTaskId) wbSwitchTask(taskId);
  if (bfOpen) { // 浮窗已开:直接拉这块板
    bfFitPending = true;
    if (taskId) boardGet(taskId); else boardRefresh();
    renderBoardPanel();
  } else bfToggle(true); // 开浮窗(内部 boardRefresh+renderBoard)
}
function bfToggle(force) {
  const next = force !== undefined ? force : !bfOpen;
  if (next === bfOpen) return;
  bfOpen = next;
  $("boardFloat").style.display = bfOpen ? "flex" : "none";
  if (bfOpen) {
    bdHome = "float";
    bfFitPending = true;
    boardRefresh(); // 开即拉清单+最新板(此后 board.changed 广播驱动实时刷新)
    renderBoard();  // 立即把当前板画进浮窗(若有)
    renderBoardPanel();
  } else {
    bdHome = "board";
 // 清掉浮窗侧的画布与明细——cvHost/cvAddPanel/cvMini 等是全局单 id,残骸留着会跟主视图同名 id
 // 抢 getElementById(经验证:工具箱开面板被隐藏残骸的重复 id 搞乱)。浮窗再开时 renderBoard 会重画。
    const bfG = $("bfGraph");
    if (bfG) bfG.innerHTML = '<div class="cc-empty">当前会话暂无白板——代码改动任务开工后,agent 的设计草图会实时出现在这里;左侧是本会话触发过的全部白板</div>';
    const bfD = $("bfDetail");
    if (bfD) bfD.innerHTML = '<div class="cc-empty">点画布节点看「干什么用」与语义流程,可直接写评论</div>';
    const bfL = $("bfList");
    if (bfL) bfL.innerHTML = '<div class="cc-empty loading">加载中…</div>';
    renderBoard(); // 画布搬回大白板宿主(浮窗关闭后主区恢复为宿主)
  }
}
function bfDoneCount(doc) { return doc ? doc.nodes.filter((n) => n.done).length : 0; }
function renderBoardPanel() {
 // 浮窗轻量面:进度行+编辑钮文案+板清单(画布/明细由 renderBoard/renderBoardDetail 按宿主渲染)
  if (!bfOpen) return;
  const prog = $("bfProg");
  if (prog) prog.textContent = boardDoc ? boardDoc.title.slice(0, 18) + (bdPlanOnly(boardDoc) ? " · 规划 · " + boardDoc.nodes.length + " 节点" : " · 已落实 " + bfDoneCount(boardDoc) + "/" + boardDoc.nodes.length) + (boardDoc.status === "done" ? " · 完成" : boardDoc.status === "draft" ? " · 设计稿" : " · 实施中") : "";
  const eb = $("bfEdit");
  if (eb) eb.textContent = boardEditOn ? "退出编辑" : "编辑";
  renderBfList();
  if (bfFitPending) { bfFitPending = false; setTimeout(() => { if (bfOpen && $("cvHost")) cvFitNow(); }, 80); }
}
/** n14 多板按 title/taskId 子串过滤(纯函数,可单测):大小写不敏感;查询为空=全过。 */
function bfListMatch(it, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;
  return String((it && it.title) || "").toLowerCase().indexOf(s) >= 0 || String((it && it.taskId) || "").toLowerCase().indexOf(s) >= 0;
}
/** n14 类型过滤(纯函数,可单测):缺 docKind 的板按 design 处理(存量板没有该字段)。 */
function bfKindMatch(it, kind) {
  const k = String(kind || "");
  if (!k) return true;
  const dk = String((it && it.docKind) || "design");
  return dk === k;
}
/** n14 板清单过滤结果(查询 + 类型两道;顺序保持服务端返回顺序=最新在前)。 */
function bfListFiltered(items, q, kind) {
  const list = Array.isArray(items) ? items : [];
  return list.filter((it) => bfListMatch(it, q) && bfKindMatch(it, kind));
}
function renderBfList() {
  const el = $("bfList");
  if (!el || !bfOpen) return;
  if (!boardItems.length) { el.innerHTML = '<div class="cc-empty">本会话暂无白板——代码改动任务开工后出现在这里</div>'; return; }
 // n14:搜索框 + 类型过滤(状态在模块级 bfListQuery/bfListKind,重渲不清空;oninput 即时重渲)
  const shown = bfListFiltered(boardItems, bfListQuery, bfListKind);
  const head = '<div class="bf-search">' +
    '<input id="bfListSearch" placeholder="搜索板(标题/任务id)" value="' + esc(bfListQuery) + '">' +
    '<select id="bfListKind">' +
    [["", "全部"], ["design", "设计"], ["page", "页面"], ["workflow", "工作流"]]
      .map((kv) => '<option value="' + kv[0] + '"' + (bfListKind === kv[0] ? " selected" : "") + ">" + kv[1] + "</option>").join("") +
    "</select></div>";
  const empty = '<div class="cc-empty">没有匹配的板(' + boardItems.length + " 块里 0 块命中)</div>";
  el.innerHTML = head + (shown.length ? shown.map((i) => {
    const stTxt = i.status === "done" ? "已落实" : i.status === "draft" ? "设计稿" : "实施中";
    const stCls = i.status === "done" ? "lk-linked" : i.status === "draft" ? "keep" : "modify";
    const pend = bdPendingOf(i.taskId);
    const pChip = pend ? '<span class="bd-tag lk-moved" title="这些评论 agent 还没读到;下一轮任务会带上">待读 ' + pend.count + "</span>" : "";
    return '<div class="bf-item' + (i.taskId === boardTaskId ? " on" : "") + '" data-bfitem="' + esc(i.taskId) + '" title="' + esc(i.title) + '">' +
      '<div class="bf-item-t">' + esc(i.title) + "</div>" +
      '<div class="bf-item-m"><span class="bd-tag ' + stCls + '">' + stTxt + "</span><span>" + i.nodeCount + " 节点</span>" + pChip + "</div></div>";
  }).join("") : empty);
  const si = el.querySelector("#bfListSearch");
  if (si) si.oninput = () => { bfListQuery = si.value; renderBfList(); };
  const ks = el.querySelector("#bfListKind");
  if (ks) ks.onchange = () => { bfListKind = ks.value; renderBfList(); };
  for (const it of el.querySelectorAll("[data-bfitem]")) {
    it.onclick = () => {
      if (it.dataset.bfitem === boardTaskId) return;
 // C5:编辑中切板=静默丢草稿——拦住
      if (boardEditOn) {
        uiConfirm("放弃当前未保存的白板编辑?", { tone: "warning", ok: "放弃编辑" }).then((ok) => {
          if (!ok) return;
          boardEditOn = false; boardDraft = null; boardSelNode = null;
          bfFitPending = true;
          boardGet(it.dataset.bfitem);
        });
        return;
      }
      boardEditOn = false; boardDraft = null;
      boardSelNode = null;
      bfFitPending = true;
      boardGet(it.dataset.bfitem);
    };
  }
}
$("boardFloatBtn").onclick = () => boardEntryGo(""); // 画布形态=定位白板卡,经典=浮窗(分流)
// 画布形态显式切换按钮(composer 栏常驻):与 Ctrl+Shift+C 同源,都走 CanvasShell.toggleMode;
// 资产未加载(404/被 SW 缓存坏)时不静默,toast 提示并留 console.warn 排障线索(与快捷键同口径)。
$("cvToggleBtn").onclick = () => {
  try { CanvasShell.toggleMode(); }
  catch (err) { console.warn("[canvas] 形态切换失败(资产未加载?)", err); toast("画布资产不可用,已留在经典布局", true); }
};
// 侧栏常驻入口(两种形态都在):按钮比 composer 里的小药丸显眼;点击=toggle,与药丸/HUD「经典」同语义,
// 画布形态下点它回经典,不再需要先找 HUD。
$("cvModeBtn").onclick = () => {
  try { CanvasShell.toggleMode(); }
  catch (err) { console.warn("[canvas] 形态切换失败(资产未加载?)", err); toast("画布资产不可用,已留在经典布局", true); }
};
// 形态联动:cv-mode 事件(canvas-shell.js setMode 派发)→ 同步 composer 药丸 + 侧栏常驻入口的文案/图标/提示,
// 让「当前在哪个形态、点一下会去哪」一眼可见(侧栏按钮两形态都在,所以两态文案必须都写)。
window.addEventListener("cv-mode", function (e) {
  const d = (e && e.detail) || {};
  const inCanvas = d.mode === "canvas";
  const titleOn = "切回经典单视图布局 (Ctrl+Shift+C)";
  const titleOff = "切换到画布模式:全部视图变成画布上的卡片,可平移/缩放/自由布局 (Ctrl+Shift+C)";
  const btn = $("cvToggleBtn");
  if (btn) {
    btn.textContent = inCanvas ? "经典模式" : "画布模式";
    btn.classList.toggle("on", inCanvas);
    btn.title = inCanvas ? titleOn : titleOff;
  }
  const sbtn = $("cvModeBtn");
  if (sbtn && sbtn.children.length >= 2) { // children[0]=.ic 图标,children[1]=文案,children[2]=.kbd 保持不动
    sbtn.children[0].textContent = inCanvas ? "▣" : "▦";
    sbtn.children[1].textContent = inCanvas ? "经典模式" : "画布模式";
    sbtn.title = inCanvas ? titleOn : titleOff;
  }
});
$("bfClose").onclick = () => bfToggle(false);
$("bfEdit").onclick = () => boardEditToggle();
$("bfOpenView").onclick = () => { bfToggle(false); switchView("board"); };
$("bfContinue").onclick = () => boardContinue();
/** n1 白板画布卡一级操作条接线:把 bdCardActionsHtml 注入 board 卡卡头(.cv-card-tools 之前),
 * 并绑三个一级动作。画布外壳是独立资产(src/assets/canvas-shell.js,任务书禁改),卡头由它建,
 * 故面板侧按「幂等注入」接管:进画布/卡重建/重渲时都可安全重复调用(已存在则只刷新按钮态)。
 * 点击行为全部复用既有入口,零新协议:
 * 编辑 → boardEditToggle(进入编辑态并 focus 白板卡,草稿/乐观锁 rev/放弃全走原链)
 * 评论 → boardCommentToggle(本任务新增的纯 UI 状态:点任意节点直出该节点评论框)
 * 按板续作 → boardContinue(与视图头 #boardContinueBtn / 浮窗 #bfContinue 同一动作) */
function bdCanvasCardActions() {
  try {
    const card = document.querySelector('.cv-card[data-name="board"]');
    if (!card) return false;
    const head = card.querySelector(".cv-card-head");
    if (!head) return false;
    let acts = head.querySelector(".cv-card-acts");
    if (!acts && typeof bdCardActionsHtml === "function") {
      const tools = head.querySelector(".cv-card-tools");
      const html = bdCardActionsHtml();
      if (tools && tools.insertAdjacentHTML) tools.insertAdjacentHTML("beforebegin", html);
      else head.insertAdjacentHTML("beforeend", html);
      acts = head.querySelector(".cv-card-acts");
    }
    if (!acts) return false;
 // n12:待读评论 chip 幂等就地更新——操作条已存在时上面那段注入分支不走,而 chip 的显隐/计数会随
 // board.list.result 变(评论刚落盘=出现,agent 读过=消失),所以每次调用都按当前状态同步一份。
    {
      const want = bdPendingChipHtml();
      const has = acts.querySelector("#bdCardPending");
      if (has) has.remove(); // 先移除再按当前状态插(计数变化/清零都覆盖,幂等)
      if (want) acts.insertAdjacentHTML("beforeend", want);
    }
    const ed = acts.querySelector("#bdCardEdit");
    if (ed) ed.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      boardEditToggle(); // 单一入口:与视图头「编辑」/浮窗「编辑」同一函数(内部 renderBoard 重渲)
      try { window.CanvasShell.focus("board", { zoom: true }); } catch (err) { /* 聚焦失败不影响编辑态 */ }
      bdCanvasCardActions(); // 重渲后按钮态刷新(卡未重建时不丢绑定)
    };
    const cm = acts.querySelector("#bdCardComment");
    if (cm) cm.onclick = (e) => {
      if (e && e.stopPropagation) e.stopPropagation();
      boardCommentToggle();
      try { window.CanvasShell.focus("board", { zoom: true }); } catch (err) { /* 忽略 */ }
    };
    const ct = acts.querySelector("#bdCardContinue");
    if (ct) ct.onclick = (e) => { if (e && e.stopPropagation) e.stopPropagation(); boardContinue(); };
 // 按钮态回显:编辑中/评论模式开=高亮 on(用户一眼看出当前处在什么态)
    if (ed) { ed.textContent = boardEditOn ? "退出编辑" : "编辑"; ed.classList.toggle("on", !!boardEditOn); }
    if (cm) cm.classList.toggle("on", !!boardCommentMode);
    return true;
  } catch (err) { console.warn("[canvas] 白板卡操作条接线失败", err); return false; }
}
// 卡头就位/重建时机:进画布(cv-mode),隐藏集合刷新(cv-cards)都补一次;卡已存在时幂等(只刷按钮态)。
// 首次注入推迟到脚本尾部执行完毕(本段之后才声明 boardEditOn 等 let,立即调用会撞 TDZ;
// 且画布卡由独立资产在建卡后才存在)。
window.addEventListener("cv-mode", () => setTimeout(bdCanvasCardActions, 30));
window.addEventListener("cv-cards", () => setTimeout(bdCanvasCardActions, 30));
setTimeout(bdCanvasCardActions, 0);

// 拖拽(标题栏)
(function () {
  const el = $("boardFloat"), head = $("bfHead");
  let dragging = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = el.getBoundingClientRect();
    dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    if (head.setPointerCapture) { try { head.setPointerCapture(e.pointerId); } catch (err) { /* 已释放则忽略 */ } }
  });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = Math.max(0, e.clientX - dragging.dx) + "px";
    el.style.top = Math.max(0, e.clientY - dragging.dy) + "px";
    el.style.right = "auto"; el.style.bottom = "auto";
  });
  const end = () => { dragging = null; };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointerleave", end);
})();

`;
