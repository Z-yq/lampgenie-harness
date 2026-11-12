/**
 * 面板主脚本分片:script-commands(逐字自 panel.ts PAGE 模板搬移, 拆分;含转义反引号 \\` 原样保留)。
 * 模板约束沿袭:除转义反引号外不得出现裸反引号与 ${。
 */
export const PANEL_JS_COMMANDS = `// ---- 跳轮导航(,ZCode TurnNavigator 简化:跳用户消息) ----
// 完整版轮次导航器(ZCode ConversationTurnNavigator 裁剪):
// 条目=用户消息轮次;点击滚动定位;滚动反向驱动当前轮高亮。
// #turnNav 自右缘浮层迁入 footer——横向时间轴形态(刻度高度=问句长度),
// 进度三态:金=当前轮,亮=该轮任务完成,呼吸=执行中未决,红=该轮含失败(归属由 renderHistory 按 journal 事件序算)。
let turnOutcome = new Map(); // 轮次号(字符串)→"done"|"fail";fail 优先(同轮后到失败覆盖已完成)
function sessionActiveCount() { // 当前会话运行/排队任务数(时间轴呼吸态数据源;footer 计数是全局口径,勿混)
  let n = 0;
  for (const t of tasks.values()) if (t.sessionId === currentSid && (t.state === "running" || t.state === "queued")) n++;
  return n;
}
function buildTurnNav(totalTurns) {
  const nav = $("turnNav");
  const rows = [...$("chatBody").querySelectorAll(".user-line[data-turn]")];
  const show = !!currentSid && rows.length >= 1 && viewLive("chat");
  nav.classList.toggle("on", show);
  if (!show) { nav.innerHTML = ""; return; }
  if (nav.children.length !== rows.length) {
    nav.innerHTML = rows.map((r, i) => {
 // F4 缩略条→横向刻度:首 ~10 字预览,高度随文本长度(8-24px 夹紧,走 --h 变量让 hover/cur 可覆盖);全文进 title 悬浮。
      const txtEl = r.querySelector(".txt");
      const txt = (txtEl ? txtEl.textContent : (r.textContent || "").replace(/^你/, "")) || "";
      const head = txt.trim().slice(0, 10);
      const h = Math.max(8, Math.min(24, Math.round(8 + head.length * 1.6)));
      return '<div class="tn-item" data-turn="' + r.dataset.turn + '" data-prev="' + esc(head) + '" style="--h:' + h + 'px" title="第 ' + (i + 1) + " 轮:" + esc(txt.trim().slice(0, 26)) + '"></div>';
    }).join("");
    for (const el of nav.querySelectorAll(".tn-item")) {
      el.onclick = () => {
        const row = $("chatBody").querySelector('.user-line[data-turn="' + el.dataset.turn + '"]');
        if (row) { row.scrollIntoView({ block: "center" }); markTurn(el.dataset.turn); }
      };
    }
  }
 // 进度着色独立于重建:任务事件实时到达(task.changed→refreshHist→renderHistory)时同轮数也要刷。
 // 满条语义:会话无活动任务(就绪/空闲)时未决轮视为已了结→整条全亮。
  const activeN = sessionActiveCount();
  for (const el of nav.querySelectorAll(".tn-item")) {
    const st = turnOutcome.get(String(el.dataset.turn));
    el.classList.toggle("fail", st === "fail");
    el.classList.toggle("ok", st === "done" || (st === undefined && activeN === 0));
    el.classList.toggle("run", st === undefined && activeN > 0);
  }
  markTurn(null); // 依据当前滚动定位高亮
}
function markTurn(turnNo) {
  const nav = $("turnNav");
  const rows = [...$("chatBody").querySelectorAll(".user-line[data-turn]")];
  if (!rows.length) return;
  let cur = turnNo;
  if (cur === null || cur === undefined) {
    const view = $("view-tasks");
    const box = view.getBoundingClientRect();
    const center = box.top + box.height * 0.5;
 // 贴底=看最新一轮的回复(ZCode 语义:当前 turn=正在浏览的轮次末尾)。
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 6;
    if (atBottom) cur = rows[rows.length - 1].dataset.turn;
    else {
      cur = rows[0].dataset.turn;
      for (const r of rows) { if (r.getBoundingClientRect().top <= center) cur = r.dataset.turn; else break; }
    }
  }
  for (const el of nav.querySelectorAll(".tn-item")) {
    el.classList.toggle("cur", el.dataset.turn === String(cur));
  }
  const curEl = nav.querySelector(".tn-item.cur");
 // 高亮滚动只动 nav 自身,不用 scrollIntoView——nav 无溢出时会冒泡到 #view-tasks,
 // 每次渲染把会话视口拽回导航项位置(「锁定在最开始」的最终真凶,rAF+400ms 轮询反复触发)。
 // 横向轴形态:同理只动 scrollLeft,把当前刻度滚进轴视口中部。
  if (curEl) nav.scrollLeft = Math.max(0, curEl.offsetLeft - nav.clientWidth / 2);
}
// 滚动驱动高亮(rAF 节流)+400ms 兜底轮询(确定性优先)
let tnRaf = 0;
$("view-tasks").addEventListener("scroll", () => {
  if (tnRaf) return;
  tnRaf = requestAnimationFrame(() => { tnRaf = 0; markTurn(null); });
});
setInterval(() => { if (viewLive("chat") && currentSid) markTurn(null); }, 400);
// fixE22:顶窗扩展——上翻接近顶部(或点哨兵)时窗口下界下移 MF_WIN_STEP 段,占位换真内容;
// 扩展帧的滚动回补由 renderHistory 写入段按 mfWinShiftFrom 差值处理(视口钉原内容,无跳变)。
function winExtend() {
  if (!mfWinLo || subWsActive || !currentSid) return;
  const vt = $("view-tasks");
  mfWinLo = Math.max(0, mfWinLo - MF_WIN_STEP);
  if (mfWinLo === 0) mfWinLo = -1; // 哨兵值:本次扩展后即达会话头(渲染时 parts 不会再有更老段,哨兵消失;下帧自然回 0)
  mfWinShiftFrom = vt ? vt.scrollHeight : -1;
  renderHistory();
  if (mfWinLo < 0) mfWinLo = 0;
}
let winSentDelegated = false; // 哨兵点击委托一次性守卫(同 code-copy 语义)
if (!winSentDelegated) {
  winSentDelegated = true;
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest(".win-sent") : null;
    if (t) winExtend();
  });
}
// 历史分页按钮点击:一次性文档委托——按钮随 mfPatch 局部换节点,委托绑定不会随重建丢失。
let histMoreDelegated = false;
if (!histMoreDelegated) {
  histMoreDelegated = true;
  document.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest(".hist-more") : null;
    if (t) loadMoreHist();
  });
}
let winExtRaf = 0; // 滚动自动扩展(rAF 节流;距顶 480px 内且上方还有段才触发)
$("view-tasks").addEventListener("scroll", () => {
  if (winExtRaf || !mfWinLo) return;
  winExtRaf = requestAnimationFrame(() => {
    winExtRaf = 0;
    const vt = $("view-tasks");
    if (mfWinLo && vt && vt.scrollTop < 480) winExtend();
  });
});
window.__tnav = { mark: () => markTurn(null) }; // 测试钩子(原子验证滚动→高亮;事件路径由点击/回顶用例覆盖)
window.__mature = { // 测试钩子:spec 注入 diffstats/histEvents 后重渲染,验证变更条/思考卡/标签页。
  diffstats, tasks,
  renderHistory: () => renderHistory(),
  openSession: (sid) => openSession(sid),
  state: () => ({ currentSid, openTabs: [], tabCount: 0 }), // tabbar 五件套已删(冗余收敛)
  hist: () => histEvents,
  setHist: (evs) => { histEvents = evs; },
 // 子代理工作区:spec 断言激活态/打开集/事件入流量(渲染断言仍走 DOM)
  subws: () => ({ active: subWsActive, tabs: [...subWsTabs.keys()], sid: subWsSid,
    events: (Array.isArray(histEvents) ? histEvents : []).filter((e) => e.kind === "subagent.event").length }),
  subwsOpen: (aid) => subWsOpen(aid),
};

function jumpTurn(dir) {
  const rows = [...$("chatBody").querySelectorAll(".user-line")];
  if (!rows.length) return;
  const cur = rows.findIndex((r) => r.getBoundingClientRect().top >= 0);
  const idx = cur < 0 ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (cur < 0 ? rows.length : cur) + dir));
  rows[idx].scrollIntoView({ block: "center" });
}
$("turnPrev").onclick = () => jumpTurn(-1);
$("turnNext").onclick = () => jumpTurn(1);

// ---- F6 workflow ask 面板应答(问题广播→直答/超时引擎自回退) ----
let wfQuestions = []; // {wfId, cacheKey, instructions, at}
function wfRenderQuestions() {
 // 过期隐藏(服务端超时后不再有意义)
  wfQuestions = wfQuestions.filter((q) => Date.now() - q.at < 120000);
  const host = viewLive("wf") ? $("wfRuns") : $("wfAskHost");
  if (!host) return;
  const boxId = "wfQBox";
  let box = $(boxId);
  if (!wfQuestions.length) { if (box) box.remove(); return; } // 无待答=不留空壳(否则 :empty 隐藏失效、底栏白占位)
  if (!box) { box = document.createElement("div"); box.id = boxId; }
  if (box.parentElement !== host) host.appendChild(box);
  box.innerHTML = wfQuestions.map((q, i) =>
    '<div class="wf-q" data-i="' + i + '"><div class="q-txt">wf ' + esc(q.wfId.slice(0, 10)) + ' 等待面板作答:' + esc(q.instructions.slice(0, 120)) + '</div>' +
    '<div class="q-row"><input placeholder="直接回答(回车提交;超时自动走子 agent)"><button>提交</button></div></div>').join("");
  for (const el of box.querySelectorAll(".wf-q")) {
    const q = wfQuestions[Number(el.dataset.i)];
    const input = el.querySelector("input");
    const send = () => {
      const v = input.value.trim();
      if (!v || !q) return;
      wsSafeSend(JSON.stringify({ v: 1, type: "workflow.answer", cacheKey: q.cacheKey, value: v }));
      wfQuestions = wfQuestions.filter((x) => x !== q);
      wfRenderQuestions();
    };
    el.querySelector("button").onclick = send;
    input.onkeydown = (e) => { if (e.key === "Enter") send(); };
  }
}
setInterval(wfRenderQuestions, 5000);

// ---- 批D:wf 运行状态+子代理目录(session.status 复用;最近活动会话) ----
let wfStatus = null;
function wfRenderRuns() {
  if (!viewLive("wf")) return;
  const box = $("wfRuns");
  if (!wfStatus) { box.innerHTML = ""; return; }
  const st = wfStatus;
  let html = "";
  const runs = st.workflows || [];
  if (runs.length) {
    html += "<div><b>workflow runs</b></div>";
    for (const w of runs) html += '<div class="ti"><span>' + (w.done ? ic("check", "ok") : ic("clock", "mut")) + "</span><span>" + esc(w.wfId.slice(0, 16)) + (w.done ? " 完成" : " 等待回答 ×" + w.asks) + "</span></div>";
  }
  if (st.subagents && st.subagents.spawnCount > 0) {
    html += "<div><b>子代理</b>(目录:spawn " + st.subagents.spawnCount + " · 运行 " + st.subagents.running + " · 完成 " + st.subagents.resultCount + ")</div>";
  }
  if (st.todo) html += "<div><b>当前任务计划</b> " + st.todo.completed + "/" + st.todo.total + " 完成</div>";
  box.innerHTML = html || "";
}
setInterval(() => {
  if (!viewLive("wf")) return;
 // 最近活动会话(优先运行中)
  const act = [...tasks.values()].filter((t) => ["running", "queued"].includes(t.state)).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    || [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (act) ssSendStatus(act.sessionId);
}, 3000);

// ---- Git 面板(批C) ----
let gitChanges = [], gitCurrentFile = "";
function gitLoad() {
  if (!viewLive("git")) return;
  wsSafeSend(JSON.stringify({ v: 1, type: "git.status" }));
  wsSafeSend(JSON.stringify({ v: 1, type: "git.branches" }));
}
function gitRenderStatus(m) {
  $("gitBranch").textContent = m.norepo ? "⎇ 非 git 仓库" : "⎇ " + (m.branch || "(无分支)");
  gitChanges = m.changes || [];
  $("gitChanges").innerHTML = gitChanges.length
    ? gitChanges.map((c, i) =>
        '<div class="git-ch" data-i="' + i + '">' +
        '<input type="checkbox" class="git-pick" data-i="' + i + '" title="勾选后只提交选中文件">' +
        (c.staged ? '<span class="g-staged">●</span>' : '<span class="g-label">○</span>') +
        '<span>' + esc(c.file) + '</span><span class="g-label">' + esc(c.label) + '</span></div>').join("")
    : '<div class="cc-empty">工作区干净</div>';
  for (const el of $("gitChanges").querySelectorAll(".git-ch")) {
    el.onclick = () => {
      for (const x of $("gitChanges").querySelectorAll(".git-ch")) x.classList.remove("on");
      el.classList.add("on");
      gitCurrentFile = gitChanges[Number(el.dataset.i)].file;
      wsSafeSend(JSON.stringify({ v: 1, type: "git.diff", file: gitCurrentFile }));
    };
  }
 // 勾选不触发 diff(选择集与查看流分离);勾选集变化即更新提交按钮语义。
  for (const box of $("gitChanges").querySelectorAll(".git-pick")) {
    box.onclick = (ev) => { ev.stopPropagation(); gitCommitLabel(); };
    box.onchange = () => gitCommitLabel();
  }
  gitCommitLabel();
}
// 勾选文件提交:有勾选=只提交选中(服务端 git.commit files 参数),无勾选=全部(add -A)。
function gitPickedFiles() {
  return [...$("gitChanges").querySelectorAll(".git-pick")].filter((b) => b.checked).map((b) => gitChanges[Number(b.dataset.i)].file);
}
function gitCommitLabel() {
  const btn = $("gitCommitBtn");
  if (!btn) return;
  const n = gitPickedFiles().length;
  btn.textContent = n > 0 ? "提交选中(" + n + ")" : "提交全部变更";
}
function gitRenderDiff(m) {
 // diff 上色:+/-行/hunk 头/元信息(ZCode LightweightDiffPreview 裁剪)
  const lines = String(m.patch || "").split(String.fromCharCode(10));
  $("gitDiff").innerHTML = lines.map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "d-add"
      : l.startsWith("-") && !l.startsWith("---") ? "d-del"
      : l.startsWith("@@") ? "d-hunk"
      : l.startsWith("diff") || l.startsWith("index") || l.startsWith("---") || l.startsWith("+++") ? "d-meta" : "";
    return '<div class="' + cls + '">' + esc(l) + "</div>";
  }).join("") || '<div class="cc-empty">无差异</div>';
}
function gitRenderBranches(m) {
  const sel = $("gitBranchSel");
  sel.innerHTML = '<option value="">切换分支…</option>' +
    [m.current].concat(m.branches || []).filter(Boolean).map((b) => '<option value="' + esc(b) + '">' + esc(b) + (b === m.current ? " (当前)" : "") + "</option>").join("");
}
$("act-git").onclick = () => switchView("git");
$("act-web").onclick = () => switchView("browser"); // 左栏「网页 Webview」:点一下即进 #view-browser
$("gitRefresh").onclick = gitLoad;
$("gitBranchSel").onchange = () => {
  const b = $("gitBranchSel").value;
  if (b) { wsSafeSend(JSON.stringify({ v: 1, type: "git.checkout", branch: b })); $("gitBranchSel").value = ""; }
};
$("gitAiMsg").onclick = () => {
  wsSafeSend(JSON.stringify({ v: 1, type: "git.commitmsg" }));
  $("gitAiMsg").textContent = "生成中…";
};
$("gitLogBtn").onclick = () => {
  wsSafeSend(JSON.stringify({ v: 1, type: "git.log", limit: 50 }));
  $("gitDiff").innerHTML = '<div class="cc-empty">提交历史加载中…</div>';
};
$("gitCommitBtn").onclick = () => {
  const msg = $("gitMsg").value.trim();
  if (!msg) { uiAlert("请填写提交信息", { tone: "warning" }); return; }
  const picked = gitPickedFiles();
  wsSafeSend(JSON.stringify({ v: 1, type: "git.commit", message: msg, ...(picked.length ? { files: picked } : {}) }));
  $("gitMsg").value = "";
  toast(picked.length ? "提交选中 " + picked.length + " 个文件…" : "提交全部变更…");
};
$("gitPullBtn").onclick = () => {
  wsSafeSend(JSON.stringify({ v: 1, type: "git.pull" }));
  toast("拉取 origin(当前分支)…");
};
$("gitPushBtn").onclick = () => {
  wsSafeSend(JSON.stringify({ v: 1, type: "git.push" }));
  toast("推送 origin(当前分支)…");
};
// ---- F1 多快照浏览:checkpoint.list → 清单(时间+任务+sha 短)→ 预览/恢复 ----
let snapshots = [];
function snapRender() {
  const host = $("snapList");
  if (!host) return;
  if (!snapshots.length) { host.innerHTML = '<div class="cc-empty">暂无快照——任务提交时自动创建(git checkpoint)</div>'; return; }
  host.innerHTML = snapshots.slice(0, 40).map((s, i) =>
    '<div class="mgr-row"><span class="m-name" style="font-size:10.5px">' + esc(String(s.sha || "").slice(0, 8)) + '</span>' +
    '<span class="m-desc" title="' + esc(String(s.taskId)) + '">任务 ' + esc(String(s.taskId).slice(0, 14)) + (s.sessionId ? " · 会话 " + esc(String(s.sessionId).slice(0, 20)) : "") + '</span>' +
    '<span class="m-meta">' + new Date(Number(s.at) || 0).toLocaleString() + '</span>' +
    '<button data-i="' + i + '" data-act="preview" title="查看该快照将恢复的文件清单(checkpoint.preview)">预览</button>' +
    '<button data-i="' + i + '" data-act="restore">恢复</button></div>').join("");
  for (const b of host.querySelectorAll("button[data-act]")) {
    b.onclick = () => {
      const s = snapshots[Number(b.dataset.i)];
      if (!s) return;
      if (b.dataset.act === "preview") {
 // 预览走既有 checkpoint.preview 流(回包弹确认清单,可顺带回滚该任务)
        pendingRewind = s.taskId;
        wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.preview", taskId: s.taskId }));
      } else {
 // 原生 confirm → uiConfirm(恢复快照;确认后才发 restore)
        uiConfirm("恢复快照 " + String(s.sha || "").slice(0, 8) + "?工作区将回到该任务前(快照后新增的未跟踪文件保留)", { tone: "danger" }).then((ok2) => {
          if (ok2) wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.restore", sha: String(s.sha || "") }));
        });
      }
    };
  }
}
$("snapLoad").onclick = () => {
  $("snapList").innerHTML = '<div class="cc-empty">拉取中…</div>';
  wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.list" }));
};
setInterval(gitLoad, 8000);
// 心跳+假死检测:每 30s ping;75s 内零入站帧=半开 TCP(send 本地成功对端收不到)——主动断开触发重连,
// 否则「已连接」陈旧绿字常驻、发送无痕丢失(视频「111 无响应」根因之一)。
setInterval(() => {
  if (!ws || ws.readyState !== 1) return; // ws 降为可换槽位,构造失败(null)时跳过防 TypeError 空转
  wsSafeSend(JSON.stringify({ v: 1, type: "ping" }));
  if (lastPong && Date.now() - lastPong > 75_000) {
    $("conn").textContent = "连接假死 · 重连中…";
    cvConn(false, "连接假死 · 重连中");
    try { ws.close(); } catch { /* already closing */ }
  }
}, 30000);
gitLoad();

// ---- n3 命令模板展开(ZCode contracts/src/commands 语义移植)----
// splitCmdArgs:按空白切分参数,但尊重 "双引号/单引号" 与反斜杠转义(ZCode splitCustomCommandArguments 同构)。
// cmdExpand:$ARGUMENTS→全量 args;$1..$N→位置参数(缺=空串);模板里**没有任何**占位符而 args 非空
// → 返回 tpl + 空行 + "User arguments:" + args;args 为空 → 模板原样。
// 零反斜杠纪律:本文件是模板字面量,反斜杠会被模板层吃掉——用 String.fromCharCode(92) 拼出。
const CMD_BS = String.fromCharCode(92); // 反斜杠字符本身(不能在源码里直写)
function splitCmdArgs(s) {
  const src = String(s == null ? "" : s);
  const out = [];
  let cur = "";
  let quote = "";
  let escaping = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (escaping) { cur += ch; escaping = false; continue; }
    if (ch === CMD_BS) { escaping = true; continue; }
    if (quote) { if (ch === quote) quote = ""; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === " " || ch === String.fromCharCode(9) || ch === String.fromCharCode(10)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (escaping) cur += CMD_BS; // 尾随裸反斜杠原样保留(不吞字符)
  if (cur) out.push(cur);
  return out;
}
function cmdExpand(tpl, args) {
  const a = String(args == null ? "" : args).trim();
  const positional = splitCmdArgs(a);
  let body = String(tpl == null ? "" : tpl);
  let used = body.indexOf("$ARGUMENTS") >= 0;
  body = body.split("$ARGUMENTS").join(a);
 // $1..$N:不用正则(模板层会吃掉 \\d 转义),手写扫描 $ + 连续数字
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch !== "$") { out += ch; continue; }
    let j = i + 1, num = "";
    while (j < body.length) {
      const d = body.charAt(j);
      if (d < "0" || d > "9") break;
      num += d; j++;
    }
    if (!num) { out += ch; continue; }
    used = true;
    out += positional[Number(num) - 1] || "";
    i = j - 1;
  }
  body = out;
  if (a && !used) body = body.trimEnd() + String.fromCharCode(10) + String.fromCharCode(10) + "User arguments:" + String.fromCharCode(10) + a;
  return body;
}
/** 历史回填(↑)的 args 尾带旧模板:剥离后再合成,防 round-trip 膨胀(既有语义,n3 沿用并扩到展开式)。
 * tails 传候选尾串(原文模板、空参展开式),命中最长者剥一次。 */
function cmdStripTail(args, tails) {
  let a = String(args == null ? "" : args);
  let cut = 0;
  for (const t of (tails || [])) {
    const s = String(t == null ? "" : t);
    if (s && a.endsWith(s) && s.length > cut) cut = s.length;
  }
  if (cut) a = a.slice(0, a.length - cut).trim();
  return a;
}
/** 面板/typed 共用模板展开:custom 走 ZCode 全量语义;内置 send 模板无占位符时保持原样
 * (首行 raw 已带 args,不重复追加 User arguments 段——这是与 ZCode custom 命令的唯一差异点)。 */
function cmdTemplateOf(c, args) {
  if (!c) return "";
  if (c.kind === "send") {
    const raw2 = c.expand ? String(c.expand(args) || "") : "";
    return raw2.indexOf("$ARGUMENTS") >= 0 || raw2.indexOf("$1") >= 0 ? cmdExpand(raw2, args) : raw2;
  }
  return cmdExpand(String(c.body || ""), args);
}

// ---- 斜杠指令(ZCode SlashCommandPlugin/AppSlashCommand 语义移植) ----
// 两类:ui=选中即执行 UI 行为(不发送,ZCode AppSlashCommand);send=展开填回输入待确认(ZCode 插入 mention 再发送)。
const SLASH_COMMANDS = [
  { value: "newtask", desc: "新建任务(草稿)", kw: ["新建", "new", "draft", "任务"], kind: "ui", run: () => newDraft() },
  { value: "sense", desc: "代码档案(架构图/模块/演进;原代码洞察合一)", kw: ["洞察", "档案", "代码", "分析", "debug", "graph", "架构"], kind: "ui", run: () => openProfileEntry() },
  { value: "review", desc: "提交代码审查任务(四维度 findings)", kw: ["审查", "代码审查", "review", "codereview"], kind: "send", hint: "补充审查重点(可空),Enter 发送…", expand: () => "审查当前仓库最近的代码变更:按 正确性/风险/测试覆盖/可维护性 四维度输出 findings(有依据,不奉承)" },
  { value: "test", desc: "提交标准化测试任务(workflow 编排)", kw: ["测试", "单测", "unit", "workflow"], kind: "send", hint: "补充测试范围(可空),Enter 发送…", expand: () => "用 workflow 引擎跑标准化测试(unit-tests 模板,对核心模块生成并执行单测,报告结果)" },
  { value: "wf", desc: "自动化工作流", kw: ["自动化", "workflow", "编排"], kind: "ui", run: () => switchView("wf") },
  { value: "exp", desc: "经验库(Hermes 沉淀)", kw: ["经验", "沉淀", "experience"], kind: "ui", run: () => switchView("exp") },
  { value: "addproject", desc: "添加项目(本地路径)", kw: ["项目", "添加", "project", "workspace"], kind: "ui", run: () => { switchView("chat"); $("projAddBtn").onclick && $("projAddBtn").onclick(); $("projPathInput").focus(); } },
  { value: "sys", desc: "系统设置", kw: ["设置", "系统", "settings", "config"], kind: "ui", run: () => switchView("sys") },
  { value: "search", desc: "搜索任务(命令中心)", kw: ["搜索", "查找", "find", "任务"], kind: "ui", run: () => ccOpen() },
  { value: "side", desc: "侧聊 Super Agent(焦点移到指挥台命令框)", kw: ["侧聊", "侧边", "side", "super", "指挥台"], kind: "ui", run: () => { const i = document.getElementById("sc-input"); if (i && !i.disabled) i.focus(); else toast("Super Agent 指挥台未就绪", true); } },
  { value: "light", desc: "切换浅色主题(暖纸)", kw: ["浅色", "主题", "theme", "亮"], kind: "ui", run: () => setTheme("light") },
  { value: "dark", desc: "切换深色主题(鎏金夜,默认)", kw: ["深色", "主题", "theme", "暗"], kind: "ui", run: () => setTheme("dark") },
 // 新主题直达(/theme 无参=循环下一套)
  { value: "theme", desc: "循环切换主题(鎏金夜/暖纸/砂陶松影/流光玻璃/橄榄赤陶/蓝调梅影/薄墨/跟随系统)", kw: ["主题", "theme", "换肤", "皮肤"], kind: "ui", run: () => cycleTheme() },
  { value: "theme-sand", desc: "主题 → 砂陶松影(暖砂/陶土/松绿)", kw: ["砂陶", "松影", "陶土", "sand", "松林"], kind: "ui", run: () => setTheme("sand") },
  { value: "theme-glass", desc: "主题 → 流光玻璃(玻璃拟态)", kw: ["玻璃", "glass", "毛玻璃"], kind: "ui", run: () => setTheme("glass") },
  { value: "theme-olive", desc: "主题 → 橄榄赤陶(灰紫/赤陶/橄榄)", kw: ["橄榄", "赤陶", "olive", "陶土"], kind: "ui", run: () => setTheme("olive") },
  { value: "theme-plum", desc: "主题 → 蓝调梅影(奶油/梅紫/板岩蓝)", kw: ["蓝调", "梅影", "梅紫", "plum", "紫"], kind: "ui", run: () => setTheme("plum") },
  { value: "theme-ink", desc: "主题 → 薄墨(极简高对比)", kw: ["薄墨", "墨", "极简", "ink"], kind: "ui", run: () => setTheme("ink") },
 // ---- ZCode 内置命令对齐(语义照搬 zcode-slash-command-help,参数走 typed 提交) ----
 // hint=chip 态参数占位提示;goal/workflow/compact/init/plan/team 为参数类(回车进 chip,发送才执行)。
  { value: "goal", desc: "查看/设置会话目标(/goal <目标>|clear|pause|resume)", kw: ["目标", "goal", "objective"], kind: "ui", hint: "目标内容(或 clear / pause / replace <新目标>)…", run: () => builtinGoal("") },
  { value: "workflow", desc: "设计并启动工作流(/workflow <要完成的事>;无参开自动化视图)", kw: ["工作流", "workflow", "编排", "动态"], kind: "ui", hint: "要完成的事(空=打开自动化视图)…", run: () => builtinWorkflow("") },
  { value: "compact", desc: "压缩当前会话(/compact [摘要指示])", kw: ["压缩", "compact", "上下文", "摘要"], kind: "ui", hint: "压缩指示(可空)…", run: () => builtinCompact("") },
  { value: "init", desc: "创建/更新工作区 AGENTS.md(/init [补充说明])", kw: ["init", "agents", "初始化", "说明"], kind: "ui", hint: "补充说明(可空)…", run: () => builtinInit("") },
  { value: "plan", desc: "切换 Plan 规划模式(/plan [顺带派的任务])", kw: ["plan", "规划", "模式", "mode"], kind: "ui", hint: "顺带要派的任务(空=仅切 Plan 模式)…", run: () => builtinPlan("") },
 // teamai-cli /teamai 语义映射( members/sync/share→harness 等价面;doctor 无对应不硬造)
  { value: "team", desc: "团队(/team [invite <名>|sync|share [心得>|status])", kw: ["团队", "team", "成员", "invite", "同步"], kind: "ui", hint: "invite <名> | sync | share [名] | status…", run: () => builtinTeam("") },
 // ---- n8:补齐 ZCode 缺失内置命令语义(help/skill/model/new/resume)----
 // help:取「最简单的实现」=toast 一段简短帮助文本(全量列表面板需另造渲染通道,收益低);
 // 文案只列分组与常用入口,完整目录仍由 / 面板给出。
  { value: "help", desc: "帮助:列出命令分组与常用入口", kw: ["帮助", "help", "用法", "usage", "?"], kind: "ui", run: () => builtinHelp("") },
 // new:等价 newtask(清空当前输入开新草稿);ZCode 里 /new 的 clear 别名语义同源。
  { value: "new", desc: "新建会话草稿(等价 newtask/clear)", kw: ["新建", "new", "clear", "草稿", "会话"], kind: "ui", run: () => newDraft() },
 // 参数类(进 chip 态,发送才执行):skill/model/resume —— 参数语义见各 builtin 函数注释。
  { value: "skill", desc: "读取技能全文并按其执行(/skill <名> [补充要求])", kw: ["技能", "skill", "方法论", "读取"], kind: "ui", hint: "技能名 [补充要求]…", run: () => builtinSkillCmd("") },
  { value: "model", desc: "查看/切换本会话模型(/model [模型名])", kw: ["模型", "model", "切换", "llm"], kind: "ui", hint: "[模型名](空=打开模型菜单)…", run: () => builtinModelCmd("") },
  { value: "resume", desc: "恢复会话(/resume [sessionId];空=打开会话列表)", kw: ["恢复", "会话", "resume", "列表", "继续"], kind: "ui", hint: "[sessionId](空=会话列表)…", run: () => builtinResumeCmd("") },
 // ---- n9:teamai 注册(此前只有 typed 分支,面板里搜不到)----
  { value: "teamai", desc: "团队仓资产(/teamai [status|pull|skill <名>|learning|share <经验>])", kw: ["团队", "teamai", "资产", "同步", "skill", "分享"], kind: "ui", hint: "[share|list] 或 status / pull / skill <名>…", run: () => builtinTeamai("") },
 // ---- r3:补 ZCode 缺失内置(rewind/fork/mode;全部复用既有通道,实现见 builtinRewind/Fork/Mode)----
  { value: "rewind", desc: "回滚工作区到此任务前(/rewind [taskId];复用快照预览+确认流)", kw: ["回滚", "快照", "撤销", "rewind", "checkpoint"], kind: "ui", hint: "[taskId](空=最近一个任务)…", run: () => builtinRewind("") },
  { value: "fork", desc: "分叉会话并重派指令(/fork [sessionId];继承原会话上下文)", kw: ["分叉", "会话", "复制", "fork", "branch"], kind: "ui", hint: "[sessionId](空=当前会话)…", run: () => builtinFork("") },
  { value: "mode", desc: "查看/切换权限模式(/mode <ask|auto|readonly|plan>)", kw: ["权限", "模式", "只读", "mode", "permission"], kind: "ui", hint: "ask|auto|readonly|plan(空=查看当前)…", run: () => builtinMode("") },
];
function setTheme(t) {
  settings.theme = t;
  localStorage.setItem("zh:theme", t);
  applySettings();
}
// ---- 斜杠指令 chip 占位符(输入态) ----
// 分类:send/custom=模板合流类,goal/workflow/compact/init/plan/team=参数类 → 回车进 chip 态(发送才执行);
// 其余 ui 纯动作 → 回车即执行(不进 chip, D2 语义保住)。typed 全量 "/cmd args" 直发不受影响。
const CHIP_PARAM_NAMES = ["goal", "workflow", "compact", "init", "plan", "team", "skill", "model", "resume", "teamai", "rewind", "fork", "mode"];
function slashChipKind(c) {
  if (!c) return null;
  if (c.kind === "send" || c.kind === "custom") return "send";
  if (c.kind === "ui" && CHIP_PARAM_NAMES.indexOf(String(c.value || "").toLowerCase()) >= 0) return "param";
  return null;
}
let inChip = null; // {name, kind:"send"|"param", hint, expand?, body?}
let inChipHint = ""; // chip 激活前的原生 placeholder(主题化 placeholder,恢复用)
function chipMount(c, kind, args, doFocus) {
  const el = $("instruction");
  if (!inChipHint) inChipHint = el.placeholder;
  inChip = { name: c.value, kind, hint: c.hint || "", expand: c.expand || null, body: c.body || null };
  el.value = args || "";
  el.placeholder = inChip.hint || "输入参数(可空)…";
  el.classList.add("in-chip-on");
  chipPaint();
  saveDraft();
  if (doFocus !== false) el.focus();
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
  cmdChipUpdate();
}
function chipPaint() {
  const box = $("inChip");
  const el = $("instruction");
  if (!box || !el) return;
  if (!inChip) { box.style.display = "none"; box.innerHTML = ""; el.style.paddingLeft = ""; return; }
  box.innerHTML = '<span class="slash-chip in-chip"><span class="sc-icon">/</span> ' + esc(inChip.name) +
    (inChip.kind === "send" ? ' <span class="sc-args">' + (inChip.expand ? "模板合流" : "自定义") + "</span>" : "") + "</span>";
  box.style.display = "flex";
  el.style.paddingLeft = (Math.ceil(box.getBoundingClientRect().width) + 8) + "px";
}
function chipUnmount(keepArgs) {
  const el = $("instruction");
  inChip = null;
  el.classList.remove("in-chip-on");
  el.placeholder = inChipHint || el.placeholder;
  if (!keepArgs) el.value = "";
  chipPaint();
  saveDraft();
  cmdChipUpdate();
  renderSendBtn(); // 占位符从 chip hint 复位回空闲/busy 双态(inChipHint 快照里可能是旧 busy 文案)
}
function chipSubmit() {
  const c = inChip;
  if (!c) return;
  const args = $("instruction").value.trim();
  const raw = "/" + c.name + (args ? " " + args : "");
  markSkillPending(c.name, args); // 与 typed 同源占位
  chipUnmount(false);
  localStorage.removeItem("zh:draft:" + (currentSid || "__new__"));
  if (currentSid) localStorage.removeItem("zh:draft:" + currentSid);
  if (c.kind === "param") {
    if (c.name === "goal") builtinGoal(args);
    else if (c.name === "workflow") builtinWorkflow(args);
    else if (c.name === "compact") builtinCompact(args);
    else if (c.name === "init") builtinInit(args);
    else if (c.name === "plan") builtinPlan(args);
    else if (c.name === "team") builtinTeam(args);
    else if (c.name === "skill") builtinSkillCmd(args);
    else if (c.name === "model") builtinModelCmd(args);
    else if (c.name === "resume") builtinResumeCmd(args);
    else if (c.name === "teamai") builtinTeamai(args);
    else if (c.name === "rewind") builtinRewind(args); // r3:参数类三连(fork/mode 同批)
    else if (c.name === "fork") builtinFork(args);
    else if (c.name === "mode") builtinMode(args);
  } else {
 // send/custom:raw 行前缀合流( journal 契约:首行=用户所说的 raw 形态,渲染层成 chip;
 // 模板体跟后=模型任务书,展示层隐藏)。override 直提,防 slash 分派递归吞模板进 args。
 // n3:模板体走 cmdExpand 语义(custom 全量 $ARGUMENTS/$N/User arguments;send 无占位符时原样)。
    const tpl = c.kind === "send" ? (cmdTemplateOf(c, args) || (c.expand ? c.expand() : "")) : cmdExpand(String(c.body || ""), args);
    submit(raw + (tpl ? NL + NL + tpl : "")); // 跨线修复:模板吃反斜杠转义,fromCharCode 形态(NL=页面全局)
  }
  chatSysLineIcon("check", raw.slice(0, 80));
  cmdChipFlash(raw);
}
// ---- ZCode 内置命令处理(参数来自 typed 提交 /cmd args) ----
function goalSid() { return currentSid || "__new__"; }
function chatSysLine(text, cls) {
  const body = $("chatBody");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", '<div class="' + (cls || "sys-line") + '">' + sketchifyHtml(esc(text)) + "</div>");
  body.scrollTop = body.scrollHeight;
}
// 带图标系统行(chrome 语义符号→素描描绘;文本照旧转义)
function chatSysLineIcon(icon, text, cls) {
  const body = $("chatBody");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", '<div class="' + (cls || "sys-line") + '">' + ic(icon, "ok") + " " + sketchifyHtml(esc(text)) + "</div>");
  body.scrollTop = body.scrollHeight;
}
function builtinGoal(args) {
  const a = String(args || "").trim();
  const sid = goalSid();
  if (!a) {
    wsSafeSend(JSON.stringify({ v: 1, type: "goal.get", sessionId: sid }));
    return;
  }
  const low = a.toLowerCase();
  if (low === "clear") {
    if (!currentSid) { toast("当前无活动会话,无目标可清除", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "goal.set", sessionId: currentSid, goal: null, state: "active" }));
    chatSysLine("目标已清除");
    return;
  }
  if (low === "pause") {
    if (!currentSid) { toast("当前无活动会话,无目标可暂停", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "goal.set", sessionId: currentSid, goal: null, state: "paused" }));
    chatSysLine("目标已暂停");
    return;
  }
  if (low === "resume") { toast("resume:请用 /goal <目标> 重设(resume 语义=目标重新生效)"); return; }
 // 会话先钉死(审计修复 C1:此前草稿态 goal.set 落 "__new__" 幻影会话,任务却派 web-goal-*,
 // 两会话错位 → agent 系统提示的 goal 注入永远查不到)。set/replace 同一目标值。
  const goalText = low.startsWith("replace ") ? a.slice(8).trim() : a;
  if (!goalText) { toast("用法:/goal <目标> 或 /goal replace <新目标>", true); return; }
  if (low.startsWith("replace ") && !currentSid) { toast("replace 需在活动会话内使用", true); return; }
 // plain set:检查覆盖(确认后继续走 goalDispatch)
  const needOverwriteCheck = !low.startsWith("replace ") && lastGoalState && lastGoalState.goal;
  const goalDispatch = () => {
  const taskSid = currentSid || ("web-goal-" + Date.now());
  currentSid = taskSid;
  goalPendingDispatch = { sid: taskSid, goal: goalText };
  wsSafeSend(JSON.stringify({ v: 1, type: "goal.set", sessionId: taskSid, goal: goalText, state: "active" }));
 // 任务派发延迟到 goal.result ack(goal.result 处理器内;被 goal-invalid/goal-plan-mutex 拒绝时不留孤儿任务)
  chatSysLine("目标设置中:" + goalText.slice(0, 50) + "…");
  switchView("chat");
  };
  if (needOverwriteCheck) {
    uiConfirm("A goal already exists. Confirm replacement to overwrite it?\\n\\n当前:" + lastGoalState.goal, { tone: "warning", ok: "覆盖" }).then((ok) => { if (ok) goalDispatch(); });
  } else goalDispatch();
}
// workflow 任务书模板提取(纯函数;面板 raw 行前缀合流后,渲染层据此隐藏模板 remainder)。
function workflowBody(a) {
  return [
    "Use the workflow engine to design and launch a dynamic workflow for this request:",
    "",
    a,
    "",
    "Decide the subagent topology before writing any code: how many subagents (spawn_subagent), which of them share a context, what result each one returns. Then compose the workflow and call the run_workflow tool to execute it. (run_workflow 的 ask 会经面板应答——执行前用户会确认;未经确认不要先斩后奏。)",
  ].join(String.fromCharCode(10));
}
function builtinWorkflow(args) {
  const a = String(args || "").trim();
  if (!a) { switchView("wf"); return; }
 // ZCode 语义:agent 轮设计工作流→确认后执行。harness 对应=派任务 instruct agent 走 run_workflow
 //(工具的 ask 闸门经 workflowAskRouter 面板应答=「先确认后执行」同语义)。
  const sid = currentSid || ("web-" + Date.now());
  currentSid = sid;
 // 逐字移植(ZCode builtin-workflow-command.ts 命令体;CreateWorkflow→run_workflow 适配)
 // raw 行前缀合流——首行 "/workflow <a>"=用户所说形态(journal 渲染成 chip),模板体跟后。
  const instruction = "/workflow " + a + NL + NL + workflowBody(a); // 跨线修复同上
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, idempotencyKey: "wf-" + Date.now(), ...(activeProjectId ? { projectId: activeProjectId } : {}), instruction, title: "[工作流] " + a.slice(0, 30) }));
  switchView("chat");
  toast("工作流任务已提交(run_workflow 的 ask 在面板应答=先确认后执行)");
}
// n7 手动压缩可见性:压缩是在途异步操作(服务端可能跑数秒),此前只有一句 toast,
// 用户容易以为点了没反应。置 compactPending:发送按钮 disabled + aria-busy,收到
// session.compact.result 或 20s 超时清除(超时也如实 toast,不装作还在跑)。
function compactSetPending(on, note) {
  compactPending = on;
  if (compactPendingTimer) { clearTimeout(compactPendingTimer); compactPendingTimer = null; }
  const go = $("go");
  if (go) {
    go.setAttribute("aria-busy", on ? "true" : "false");
    go.classList.toggle("compact-wait", on);
    if (on) {
      go.setAttribute("disabled", "disabled");
      go.title = "正在压缩上下文…";
    } else {
      go.removeAttribute("disabled");
      renderSendBtn(); // 复位按钮文案/标题(game 状态机唯一出口)
    }
  }
  if (on) {
    compactPendingTimer = setTimeout(() => {
      compactPendingTimer = null;
      if (!compactPending) return;
      compactSetPending(false);
      toast("压缩仍在进行(已等 20 秒):可继续等待或用 /compact 重试" + (note ? "(" + note + ")" : ""), true);
    }, 20000);
  }
}
function builtinCompact(args) {
  if (!currentSid) { toast("当前无活动会话", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "session.compact", sessionId: currentSid, ...(args ? { instructions: args } : {}) }));
  compactSetPending(true);
  toast("正在压缩上下文…" + (args ? "(指示:" + args.slice(0, 30) + ")" : ""));
}
// init 任务书模板提取(纯函数;渲染层据此隐藏 raw 前缀合流后的模板 remainder)。
function initBody(notes) {
  const additional = notes ? (String.fromCharCode(10) + String.fromCharCode(10) + "Additional user instructions supplied with /init:" + String.fromCharCode(10) + "\`\`\`text" + String.fromCharCode(10) + notes + String.fromCharCode(10) + "\`\`\`" + String.fromCharCode(10)) : "";
  return [
    "You are running lampgenie-harness's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future lampgenie-harness agents.",
    "",
    "Target:",
    "- Workspace directory: your current working directory (the active project root).",
    "- Instruction file: AGENTS.md at the workspace root.",
    "- Existing hidden instruction candidates: .genie/AGENTS.md and .agents/AGENTS.md in the workspace.",
    "- File name must be exactly AGENTS.md.",
    "- This command targets the current workspace only. Do not write ~/.genie/AGENTS.md.",
    additional,
    "Process:",
    "1. First check whether .genie/AGENTS.md or .agents/AGENTS.md exists in the workspace. If either exists, tell the user they already have an instructions file, mention the path found, and stop without creating a new AGENTS.md.",
    "2. Inspect the repository before writing. Prefer read-only tools and safe commands such as ls, find, git status, and package-manager script inspection.",
    "3. If AGENTS.md already exists, read it first and update it with edits instead of replacing it wholesale.",
    "4. If AGENTS.md does not exist, create it at the workspace root.",
    "5. Keep the file practical and short enough for future agents to read quickly.",
    "6. Include only project-specific facts future agents would otherwise miss.",
    "7. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join(String.fromCharCode(10));
}
function builtinInit(args) {
  const sid = currentSid || ("web-" + Date.now());
  currentSid = sid;
  const notes = String(args || "").trim();
 // 逐字移植(ZCode builtin-prompt-command.ts buildInitAgentsPrompt;路径语义原样保留)
 // raw 行前缀合流——首行 "/init [notes]"=用户所说形态(journal 渲染成 chip),模板体跟后。
  const instruction = "/init" + (notes ? " " + notes : "") + NL + NL + initBody(notes); // 跨线修复同上
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, idempotencyKey: "init-" + Date.now(), ...(activeProjectId ? { projectId: activeProjectId } : {}), instruction, title: "[init] AGENTS.md" }));
  switchView("chat");
  toast("AGENTS.md 初始化任务已提交");
}
function builtinPlan(args) {
  const a = String(args || "").trim();
 // 切 plan 模式(经 cfg.set 热生效,与 permPill 同通道)
  permPriorMode = permModeV;
  permModeV = "plan";
  pillRender(); pillSendPerm();
  if (!a) { toast("已切换 Plan 规划模式(只读+规划提示;再点权限 pill 可切回)"); return; }
 // ZCode:「切 Plan 模式并可选带任务」——带上任务一起派
 // instruction=raw 形态("/plan <a>"),journal 渲染成 chip;模型侧多一个命令前缀 token,语义无损。
  const sid = currentSid || ("web-" + Date.now());
  currentSid = sid;
  wsSafeSend(JSON.stringify({ v: 1, type: "task.submit", sessionId: sid, idempotencyKey: "plan-" + Date.now(), ...(activeProjectId ? { projectId: activeProjectId } : {}), instruction: "/plan " + a, title: "[plan] " + a.slice(0, 30) }));
  switchView("chat");
  toast("Plan 模式已生效,任务已派(只读+规划提示)");
}
// /team(teamai-cli /teamai 语义映射:无参=团队视图;子命令映射 harness 等价面。
function builtinTeam(args) {
  const a = String(args || "").trim();
  const sp2 = a.indexOf(" ");
  const sub = (sp2 === -1 ? a : a.slice(0, sp2)).toLowerCase();
  const rest = sp2 === -1 ? "" : a.slice(sp2 + 1).trim();
  if (!sub || sub === "status") {
    switchView("team");
    wsSafeSend(JSON.stringify({ v: 1, type: "team.status" }));
    return;
  }
  if (sub === "invite") {
    if (!rest) { toast("用法:/team invite <显示名>", true); return; }
    switchView("team");
    wsSafeSend(JSON.stringify({ v: 1, type: "team.status" }));
    setTimeout(() => teamInviteFlow(lastTeamOrgs[0] ? lastTeamOrgs[0].url : "", rest), 300);
    return;
  }
  if (sub === "sync") {
 // teamai push/pull 同步 → harness git.push+git.pull(激活项目, 已接)
    wsSafeSend(JSON.stringify({ v: 1, type: "git.push" }));
    wsSafeSend(JSON.stringify({ v: 1, type: "git.pull" }));
    switchView("git");
    toast("已发起 push+pull(激活项目;结果看 git.ok)");
    return;
  }
  if (sub === "learning") {
    const t = lastTeamaiDigest();
    const ls = (t && t.learnings) || [];
    if (!rest) { toast("团队 learnings " + ls.length + " 篇:" + ls.map((l, i) => i + "=" + (l.title || l.path).slice(0, 24)).join(";"), false); return; }
    const l = ls[Number(rest)] || ls.find((x) => (x.title || "").includes(rest) || x.path.includes(rest));
    if (!l) { toast("learning 未找到:" + rest, true); return; }
    uiAlert(String(l.body || "").slice(0, 6000), { title: "【" + (l.title || l.path) + "】" + (l.author ? " · " + l.author + " · " + (l.date || "") : "") });
    return;
  }
  if (sub === "share") {
 // teamai share(会话所学沉淀回团队)→ harness exp.distill(F5 经验沉淀)
    if (!currentSid) { toast("当前无活动会话", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "exp.distill", sessionId: currentSid, ...(inviteProjects() ? { projectId: inviteProjects()[0] } : {}) }));
    toast("正在把本会话所学沉淀进经验库" + (rest ? "(侧重:" + rest.slice(0, 30) + ")" : "") + (inviteProjects() ? "(项目:" + inviteProjects()[0] + ")" : ""));
    return;
  }
  toast("用法:/team [invite <名>|sync|share [心得]|status]", true);
}
// ---- teamai 兼容:团队仓资产的状态/拉取/查看/分享 ----
function builtinTeamai(args) {
  const a = String(args || "").trim();
  const sp2 = a.indexOf(" ");
  const sub = (sp2 === -1 ? a : a.slice(0, sp2)).toLowerCase();
  const rest = sp2 === -1 ? "" : a.slice(sp2 + 1).trim();
  switchView("team");
  wsSafeSend(JSON.stringify({ v: 1, type: "team.status" }));
  if (!sub || sub === "status") {
    const t = lastProjectTeam || null;
    toast("teamai:团队仓资产已刷新(团队页可见规则/技能/环境/Hooks)");
    return;
  }
  if (sub === "pull") {
    wsSafeSend(JSON.stringify({ v: 1, type: "teamai.pull" }));
    toast("teamai pull:已触发团队仓重拉(结果看团队页)");
    return;
  }
  if (sub === "skill") {
    if (!rest) { toast("用法:/teamai skill <技能名>", true); return; }
    const t = lastTeamaiDigest();
    const sk = ((t && t.skills) || []).find((x) => x.name === rest || x.ns + "/" + x.name === rest);
    if (!sk) { toast("团队技能未找到:" + rest + "(团队页看索引)", true); return; }
    uiAlert(String(sk.body || "").slice(0, 6000), { title: "【teamai/skills/" + sk.name + "】" });
    return;
  }
  if (sub === "learning") {
    const t = lastTeamaiDigest();
    const ls = (t && t.learnings) || [];
    if (!rest) { toast("团队 learnings " + ls.length + " 篇:" + ls.map((l, i) => i + "=" + (l.title || l.path).slice(0, 24)).join(";"), false); return; }
    const l = ls[Number(rest)] || ls.find((x) => (x.title || "").includes(rest) || x.path.includes(rest));
    if (!l) { toast("learning 未找到:" + rest, true); return; }
    uiAlert(String(l.body || "").slice(0, 6000), { title: "【" + (l.title || l.path) + "】" + (l.author ? " · " + l.author + " · " + (l.date || "") : "") });
    return;
  }
  if (sub === "share") {
    if (!rest) { toast("用法:/teamai share <经验名>(经验库 coding/ops 等条目以 teamai skill 形态推团队仓)", true); return; }
    wsSafeSend(JSON.stringify({ v: 1, type: "exp.view", category: "coding", name: rest }));
    pendingShare = { name: rest };
    toast("正在读取经验 " + rest + " …");
    return;
  }
  toast("用法:/teamai [pull|skill <名>|learning [序号|关键词]|share <经验名>|status]", true);
}
// ---- n8:补齐 ZCode 缺失内置命令(help/skill/model/new/resume)----
/** /help:取「最简单实现」=toast 一段简短帮助(全量列表面板需再搭一条渲染通道,收益低于噪声;
 * 完整目录本身就在 / 面板里,命令中心 >命令 也能全量检索)。 */
function builtinHelp(args) {
  const q0 = String(args || "").trim().toLowerCase();
 // 零反斜杠纪律:模板层会吃掉正则里的 \/ —— 前导斜杠用 slice 剥,不写正则。
  let q = q0;
  while (q.charAt(0) === "/") q = q.slice(1);
  if (q) {
 // 带参=精确定位一条命令的用法(ZCode /help [命令名] 语义)。
    const c = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === q);
    if (c) { toast("/" + c.value + (c.hint ? " " + c.hint : "") + " — " + c.desc); return; }
    const cu = customCommands.find((x) => x.name.toLowerCase() === q);
    if (cu) { toast("/" + cu.name + " — 自定义命令(模板见设置 → 命令)"); return; }
    toast("没有这个命令:" + q + "(输入 / 打开面板;Ctrl Shift P 命令中心可全量检索)", true);
    return;
  }
  toast("命令:内置 " + SLASH_COMMANDS.length + " 条 + 自定义 " + customCommands.length + " 条 | 输入 / 打开面板 | 参数类命令回车装填 chip,发送才执行 | /help <命令名> 查用法");
}
/** /skill:面板侧没有 skill_view 单发通道(服务端只有技能目录+按需注入),故实现为**拼一条任务消息**:
 * 「读取技能 <name> 全文并按其执行。」(+ 用户补充要求)——降级实现,注释在此写清原因。 */
function builtinSkillCmd(args) {
  const a = String(args || "").trim();
  if (!a) { toast("用法:/skill <技能名> [补充要求](技能名见 设置 → 技能 或 $ 提及列表)", true); return; }
  const parts = splitCmdArgs(a);
  const name = parts[0] || "";
  if (!name) { toast("用法:/skill <技能名> [补充要求]", true); return; }
  const rest = a.slice(name.length).trim();
  switchView("chat");
  submit("读取技能 " + name + " 全文并按其执行。" + (rest ? " " + rest : ""));
}
/** /model:无参=打开既有模型弹层(modelMenuOpen / pillOpenMenu 同一入口);有参=走既有 per-session
 * session.model.set 通道(pillPickModel),服务端回包 session.model.result 后 pill 才落定。 */
function builtinModelCmd(args) {
  const a = String(args || "").trim();
  if (!a) { pillOpenMenu(); return; }
  const name = splitCmdArgs(a)[0] || a;
  const hit = modelCatalogEntries().find((e) => e.name === name);
  if (!hit) {
    toast("模型目录里没有 " + name + "(发送 /model 打开菜单;或先到设置 → Coding 模型 添加)", "warn");
    return;
  }
  pillPickModel(hit.name, hit.provider ? String(hit.provider.id || "") : "");
}
/** /resume:无参=打开会话列表(面板无独立会话列表视图;命令中心的「#会话」作用域就是会话列表,直接用它);
 * 有参=按 sessionId/前缀打开该会话(openSession:历史重放/模型/白板上下文全走既有入口)。 */
function builtinResumeCmd(args) {
  const a = String(args || "").trim();
  if (!a) {
    ccOpen();
    $("cc-q").value = "#";
    ccRender(); // 「#」作用域=会话搜索列表(# 后留空=最近会话)
    return;
  }
  const sid = splitCmdArgs(a)[0] || a;
  const exact = tasks.size ? [...tasks.values()].find((t) => t.sessionId === sid) : null;
  if (exact && exact.sessionId) { openSession(exact.sessionId); return; }
  if (sid.startsWith("web-") || sid.startsWith("cli-") || sid.length >= 8) { openSession(sid); return; }
 // 短关键词:交给会话搜索(命令中心 #作用域按前缀/关键词搜),命中用户点行进入。
  ccOpen();
  $("cc-q").value = "#" + sid;
  ccRender();
}
// typed 提交分发:submit 里 "/cmd args" 形态优先命中内置/自定义命令(ZCode 直接提交命令语义)。
// ---- 技能/命令占位(ZCode optimistic command overlay 拉模型适配):
// 命令上行即占位(「执行中…」),完成转「完成」,数秒后退场;renderHistory 重建时重挂,不丢。
let pendingSkills = [];
function skillInvHtml(ps) {
  return '<div class="skill-inv" data-inv="' + ps.id + '"><span class="si-k">/' + esc(ps.name) + "</span>" +
    (ps.args ? '<span class="si-a">' + esc(ps.args) + "</span>" : "") +
    '<span class="si-st' + (ps.done ? " done" : "") + '">' + (ps.done ? "完成" : "执行中…") + "</span></div>";
}
function markSkillPending(name, args) {
  const ps = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, args: args || "", done: false };
  pendingSkills.push(ps);
  const body = $("chatBody");
  if (body) {
    body.insertAdjacentHTML("beforeend", skillInvHtml(ps));
    body.scrollTop = body.scrollHeight;
  }
  setTimeout(() => {
    ps.done = true;
    const row = body && body.querySelector('[data-inv="' + ps.id + '"]');
    if (row) { const st = row.querySelector(".si-st"); if (st) { st.textContent = "完成"; st.classList.add("done"); } }
    setTimeout(() => {
      pendingSkills = pendingSkills.filter((x) => x.id !== ps.id);
      const rr = body && body.querySelector('[data-inv="' + ps.id + '"]');
      if (rr) rr.remove();
    }, 5000);
  }, 900);
}
function renderPendingSkills() {
  const body = $("chatBody");
  if (!body || pendingSkills.length === 0) return;
  for (const ps of pendingSkills) body.insertAdjacentHTML("beforeend", skillInvHtml(ps));
  body.scrollTop = body.scrollHeight;
}

// ---- 回底圆钮(ZCode 回底按钮对齐) ----
{
  const vt = document.getElementById("view-tasks");
  const btn = document.getElementById("scrollBottom");
  if (vt && btn) {
    vt.addEventListener("scroll", () => {
      const far = vt.scrollHeight - vt.scrollTop - vt.clientHeight > 200;
      btn.style.display = far ? "flex" : "none";
      btn.classList.toggle("on", far);
    });
    btn.onclick = () => { vt.scrollTo({ top: vt.scrollHeight, behavior: "smooth" }); };
  }
}
function slashTypedSubmit(text) {
  if (!text.startsWith("/")) return false;
  const sp = text.indexOf(" ");
  const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
  const args = sp === -1 ? "" : text.slice(sp + 1).trim();
  const c = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === name);
  const customEarly = customCommands.find((x) => x.name.toLowerCase() === name);
  if (c || customEarly) markSkillPending(name, args); // 技能占位：所有会执行的命令统一登记（专属分支在前，须先登记）
  if (c && c.value === "goal") { builtinGoal(args); return true; }
  if (c && c.value === "workflow") { builtinWorkflow(args); return true; }
  if (c && c.value === "compact") { builtinCompact(args); return true; }
  if (c && c.value === "init") { builtinInit(args); return true; }
  if (c && c.value === "plan") { builtinPlan(args); return true; }
  if (c && c.value === "team") { builtinTeam(args); return true; }
  if (c && c.value === "teamai") { builtinTeamai(args); return true; }
 // n8:参数类命令 typed 直发(带参回车=真执行,与 chip 态同源)
  if (c && c.value === "skill") { builtinSkillCmd(args); return true; }
  if (c && c.value === "model") { builtinModelCmd(args); return true; }
  if (c && c.value === "resume") { builtinResumeCmd(args); return true; }
  if (c && c.value === "help") { builtinHelp(args); return true; }
  if (c && c.value === "rewind") { builtinRewind(args); return true; } // r3:typed 直发同源
  if (c && c.value === "fork") { builtinFork(args); return true; }
  if (c && c.value === "mode") { builtinMode(args); return true; }
 // 自定义命令 typed 直发(raw 行前缀合流,首行=用户所说形态,渲染层成 chip;占位已由上方统一登记)
  const custom = customCommands.find((x) => x.name.toLowerCase() === name);
  if (custom) {
    const body2 = String(custom.body || "");
 // n3:模板展开走 ZCode 语义($ARGUMENTS/$1..$N/无占位符追加 User arguments 段),
 // 替换原先「args 拼尾」的裸拼接。防膨胀:先剥历史回填(↑)带回来的旧模板(原文或展开式)再展开。
    const a0 = cmdStripTail(args, [body2, cmdExpand(body2, "")]);
    const expanded = cmdExpand(body2, a0);
    submit("/" + custom.name + (a0 ? " " + a0 : "") + (expanded ? NL + NL + expanded : "")); // 跨线修复同上
    return true;
  }
 // 内置命令 typed 全量执行(视频四诉「技能没有被用上」):此前 /sense /exp /sys 等在 typed 提交里
 // 不命中→整段文本被当普通消息发给 agent,技能从未执行。对齐 ZCode:typed 命令回车=真实执行。
  if (c) {
    markSkillPending(name, args); // 技能占位
    $("instruction").value = "";
    localStorage.removeItem("zh:draft:" + (currentSid || "__new__"));
    if (currentSid) localStorage.removeItem("zh:draft:" + currentSid);
    if (c.kind === "ui") { c.run(); return true; }
 // 发送类=raw 行前缀合流(首行 /cmd args,模板体跟后=模型任务书),override 直提防递归。
 // 历史回填(↑)的 args 尾带旧模板:剥离后再合成,防 round-trip 膨胀。
    if (c.kind === "send") {
      const ex = c.expand ? c.expand() : "";
 // n3:模板展开走 cmdExpand 语义(有 $ARGUMENTS/$N 占位符才替换;无占位符时 send 模板原样,
 // 与 custom 命令不同——首行 raw 已带 args,不再追加 User arguments 段,避免同一句话出现两遍)。
      const a2 = cmdStripTail(args, [ex, cmdExpand(ex, "")]);
      const body3 = cmdTemplateOf(c, a2) || ex;
      submit("/" + c.value + (a2 ? " " + a2 : "") + (body3 ? NL + NL + body3 : "")); // 跨线修复同上
      return true;
    }
  }
  return false;
}
// ---- 命令「真执行」标识(视频):与 slashTypedSubmit 同一判定源——徽标亮=回车必然真实执行。----
function slashTypedMatch(text) {
  if (!text.startsWith("/")) return null;
  const sp = text.indexOf(" ");
  const name = (sp === -1 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
  if (!name) return null;
  const typed = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === name);
  if (typed) return { value: typed.value, desc: typed.desc, kind: typed.kind };
  const custom = customCommands.find((x) => x.name.toLowerCase() === name);
  if (custom) return { value: custom.name, desc: "自定义命令(模板直发)", kind: "custom" };
  return null;
}
function cmdChipUpdate() {
  const chip = $("cmdChip");
  if (!chip || chip.dataset.done === "1") return;
 // chip 态=装填指示(参数输入中,Enter 发送/Backspace 摘除/Esc 取消)。
  if (inChip) {
    chip.style.display = "";
    chip.className = "cmd-chip";
    chip.innerHTML = "<b>/" + esc(inChip.name) + "</b> 已装填 · 输入参数后 Enter 发送 · Backspace 移除 · Esc 取消";
    chip.title = "指令已装填为占位 chip;发送后按 /" + inChip.name + " 语义执行";
    return;
  }
  const m = slashTypedMatch($("instruction").value.trim());
  if (!m) { chip.style.display = "none"; return; }
  chip.style.display = "";
  chip.className = "cmd-chip";
  chip.innerHTML = "<b>/" + esc(m.value) + "</b> " + esc(String(m.desc || "").slice(0, 30)) + " · 回车执行";
  chip.title = "该输入将与提交分发同源真实执行 /" + m.value;
}
function cmdChipFlash(text) {
  const chip = $("cmdChip");
  if (!chip) return;
  const m = slashTypedMatch(text);
  chip.dataset.done = "1";
  chip.style.display = "";
  chip.className = "cmd-chip done";
  chip.innerHTML = ic("check", "ok") + " 已执行 <b>/" + esc(m ? m.value : text.slice(1, 14)) + "</b>";
  setTimeout(() => { delete chip.dataset.done; chip.style.display = "none"; }, 1800);
}
// ---- 服务重启降级(视频 T1):停机窗口内探活等待+横幅,恢复后自动刷新;不再盲 reload 撞裸错误页。----
function svcBanner(show, text) {
  let b = $("svcBanner");
  if (!b) { b = document.createElement("div"); b.id = "svcBanner"; document.body.appendChild(b); }
 // 续作轮修复:样式表 #svcBanner{display:none} 是初始隐藏,show 分支置 "" 会回落到
 // 样式表的 none=角标永不可见(起潜伏;重连角标 验收时按 isVisible 经验证抓出)。
  if (show) { b.textContent = text || ""; b.style.display = "block"; } else b.style.display = "none";
}
function svcWaitRestart() {
  svcBanner(true, "服务重启中 · 页面将在恢复后自动刷新(当前为本地缓存壳)");
  const probe = () => {
    fetch("/favicon.ico", { cache: "no-store" })
      .then((r) => { if (r.ok) location.reload(); else setTimeout(probe, 1500); })
      .catch(() => setTimeout(probe, 1500));
  };
  setTimeout(probe, Math.max(1500, settings.reconnect * 1000));
}
let slashOpen = false, slashItems = [], slashHot = 0;
// ---- n4:面板过滤=ZCode 模糊评分(lib/promptInputTriggers.ts scorePromptInputSuggestion) ----
// 每条命令取「最小分」:value 前缀命中 0(最优);否则 value 子串命中 200+位置代价;
// description 命中 +250、keywords 命中 +450(值域与 ZCode 逐档对齐,便于对照阅读)。
// 丢弃:旧实现的「needle.includes(kw)」对称匹配(反向包含=噪声源,输 "n" 会命中所有短 kw 命令)。
const SLASH_RENDER_LIMIT = 12; // ZCode 面板默认 12 行(旧实现硬编码 slice(0, 9))
const SLASH_EMPTY_TEXT = "无匹配命令(试试 /help)";
function slashScore(text, q) {
  const t = String(text == null ? "" : text).trim().toLowerCase();
  if (!t) return null;
  if (!q) return 0;
  if (t.indexOf(q) === 0) return 0;            // 前缀命中=最优
  const at = t.indexOf(q);
  if (at >= 0) return 200 + at;                // 子串命中=位置代价
  return null;
}
function slashItemScore(c, q) {
  if (!q) return 0;
  let best = Infinity;
  const v = slashScore(c.value, q);
  if (v !== null) best = Math.min(best, v);
  const d = slashScore(c.desc, q);
  if (d !== null) best = Math.min(best, d + 250);
  for (const k of (c.kw || [])) {
    const ks = slashScore(k, q);
    if (ks !== null) best = Math.min(best, ks + 450);
  }
  return Number.isFinite(best) ? best : null;
}
function slashFilter(q) {
 // 不用正则:PAGE 是模板字面量,正则转义会被模板层再吃一层(slice 等价零转义)。
  const t = q.startsWith("/") ? q.slice(1) : q;
 // 查询只取首个空格前的命令名段——「/goal 修白板」打到参数时面板不再闪「无匹配命令」
 // (旧实现整串当查询,带参数即空态;参数语义由 slashTypedSubmit/slashExec 承接,不过滤面板)。
  const sp0 = t.indexOf(" ");
  const needle = (sp0 === -1 ? t : t.slice(0, sp0)).trim().toLowerCase();
 // 自定义命令并入目录(n9:group=custom;用户资产=面板最上一组)。
  const custom = customCommands.map((c, i) => ({ value: c.name, desc: "自定义:" + String(c.body || "").split(String.fromCharCode(10))[0].slice(0, 40), kw: [], kind: "custom", body: c.body, group: "custom", idx: i }));
  const builtin = SLASH_COMMANDS.map((c, i) => Object.assign({}, c, { group: "builtin", idx: i }));
  const all = custom.concat(builtin);
  const scored = [];
  for (const c of all) {
    const s = slashItemScore(c, needle);
    if (s !== null) scored.push({ c, s });
  }
 // 分组排序:**与 ZCode 的差异点**——ZCode 是 commands/skills/subagents,commands 在最前;
 // 我们的 custom 是用户自己写的命令,置顶更合理(先自己的、后内置),故 groupRank: custom=0 / builtin=1。
 // 组内按分数升序,同分按注册表原序(sort 稳定 + idx 兜底)。
  const rank = (g) => (g === "custom" ? 0 : 1);
  scored.sort((a, b) => (rank(a.c.group) - rank(b.c.group)) || (a.s - b.s) || (a.c.idx - b.c.idx));
  return scored.slice(0, SLASH_RENDER_LIMIT).map((x) => x.c);
}
/** n9:面板底部「＋ 新建命令」→ 设置页命令分区并聚焦名称输入框。 */
function slashNewCommand() {
  slashClose();
  switchView("sys");
  setSection("cmds");
  setTimeout(() => {
    const form = $("cmdForm");
    const input = form ? form.querySelector("input[name=cname]") : null;
    if (input) input.focus();
  }, 60);
}
function slashRender() {
  const box = $("slashMenu");
  if (!box) return;
  if (!slashOpen) { box.style.display = "none"; box.innerHTML = ""; return; }
 // n4④:空结果不再 display:none——保留面板(Esc 仍可关),给一行占位文案 + 新建入口。
  let html = "";
  let lastGroup = "";
  for (let i = 0; i < slashItems.length; i++) {
    const c = slashItems[i];
    const gLabel = c.group === "custom" ? "自定义命令" : "内置命令";
    if (gLabel !== lastGroup) { html += '<div class="sc-group">' + gLabel + "</div>"; lastGroup = gLabel; }
 // n4③:label 前缀带 hint(ZCode slashCommandHelpers:inputHint?.trim || /name 的同精神;
 // 差异=我们保留 /name 再跟 <hint>,因为面板同时要能一眼看出命令名);
    const h = String(c.hint || c.inputHint || "").trim();
    html += '<div class="sc-item' + (i === slashHot ? " hot" : "") + '" data-i="' + i + '">' +
      '<span class="sc-name">/' + esc(c.value) + (h ? ' <span class="sc-hint">' + esc(h.length > 30 ? h.slice(0, 30) + "…" : h) + "</span>" : "") + "</span>" +
      '<span class="sc-desc">' + esc(c.desc) + '</span>' +
      '<span class="sc-kind">' + (slashChipKind(c) === "param" ? "参数" : c.kind === "ui" ? "执行" : "发送") + '</span></div>';
  }
  if (!slashItems.length) html += '<div class="sc-empty">' + SLASH_EMPTY_TEXT + "</div>";
  html += '<div class="sc-item sc-newcmd" data-act="newcmd"><span class="sc-name">＋ 新建命令</span><span class="sc-kind">设置</span></div>';
  box.style.display = "";
  box.innerHTML = html;
  for (const el of box.querySelectorAll(".sc-item[data-i]")) {
    el.onclick = () => slashExec(Number(el.dataset.i));
    el.onmouseenter = () => { slashHot = Number(el.dataset.i); slashRender(); };
  }
  const nw = box.querySelector('.sc-item[data-act="newcmd"]');
  if (nw) nw.onclick = () => slashNewCommand();
}
function slashExec(i) {
  const c = slashItems[i];
  if (!c) return;
  slashClose();
  localStorage.setItem("zh:used-slash", "1");
 // 已有正文时选命令:首空格后的文本带进 chip 参数/保留在输入框,不再整体清空(数据丢失修复)。
 // 「/goal rest」→ rest 进 chip 参数;裸 "/cmd" → rest 为空串,行为与旧版一致。
  const v0 = $("instruction").value;
  const sp3 = v0.indexOf(" ");
  const rest = sp3 === -1 ? "" : v0.slice(sp3 + 1).trim();
 // 发送类/自定义/参数类 → 输入框 chip 占位(允许续输参数,发送才执行);ui 纯动作保持回车即执行。
  const ck = slashChipKind(c);
  if (ck) { $("instruction").value = ""; chipMount(c, ck, rest); return; }
  if (c.kind === "ui") {
    $("instruction").value = rest; // 纯动作不消费正文:保留 rest(裸 /cmd 时为空串=旧版清空行为)
 // 指令文本已消费:同步清草稿镜像,防 newDraft→restoreDraft 把指令灌回输入框(slash D2 修复)。
    localStorage.removeItem("zh:draft:" + (currentSid || "__new__"));
    if (currentSid) localStorage.removeItem("zh:draft:" + currentSid);
    saveDraft();
    c.run();
  } else {
 // 发送类:展开模板填回输入,待用户补参/确认(ZCode 插入 mention 不直接发送的同语义)。
 // (后此分支仅剩未知 kind 兜底;send/custom 已在上方进 chip 态。)
    $("instruction").value = (c.expand ? c.expand() : String(c.body || "")) + (rest ? NL + NL + rest : "");
    $("instruction").focus();
  }
}
function slashClose() { slashOpen = false; slashItems = []; slashHot = 0; slashRender(); }
function slashUpdate() {
  const v = $("instruction").value;
  if (v.startsWith("/")) {
    slashOpen = true;
    slashItems = slashFilter(v);
    if (slashHot >= slashItems.length) slashHot = Math.max(0, slashItems.length - 1);
    slashRender();
  } else slashClose();
}
// 浮窗逃逸:输入框外任何按下(点聊天流/侧栏/其他面板)都收起面板——此前只有 Esc 和
// 编辑正文两条关闭通道,「已有 text 从头打 / 没匹配上」的空态面板点别处永远去不掉。
// 面板自身(#slashMenu,含条目 click 与新建入口)与输入框本身除外:按下收起会让 click 落空。
document.addEventListener("pointerdown", (e) => {
  if (!slashOpen) return;
  const t = e.target;
  if (t && t.closest && (t.closest("#slashMenu") || t.closest("#instruction"))) return;
  slashClose();
});
function autoGrow() {
  const el = $("instruction");
  el.style.height = "auto";
  el.style.height = Math.min(160, el.scrollHeight) + "px";
}
function draftKey() { return "zh:draft:" + (currentSid || "__new__"); }
function saveDraft() {
 // 双写:会话键+草稿镜像(__new__)——重载丢失会话上下文时草稿文本仍存活(ZCode workspace transfer 裁剪)。
 // chip 态存逻辑形态 "/cmd args"(重载后 restoreDraft 恢复 chip;恢复不出=raw 文本,typed 路径仍可执行)。
  const v = inChip ? "/" + inChip.name + (($("instruction").value) ? " " + $("instruction").value : "") : $("instruction").value;
  localStorage.setItem(draftKey(), v);
  if (currentSid) localStorage.setItem("zh:draft:__new__", v);
}
function restoreDraft() {
 // fixT6 P1:草稿串台修复——原实现 recoverDraft 无条件回落读 __new__ 镜像,导致「草稿态输入的文本」
 // 在切到任意无草稿的会话后原样冒进输入框(经验证:空态输入 DRAFT_A → openSession → 输入框仍是 DRAFT_A)。
 // 镜像只服务于「无会话的草稿态」;会话态只认自己的键,查无则清空(不把别处的草稿搬过来)。
  const v = currentSid
    ? (localStorage.getItem(draftKey()) || "")
    : (localStorage.getItem(draftKey()) || localStorage.getItem("zh:draft:__new__") || "");
  $("instruction").value = v; autoGrow();
  try { fileRefRender(); } catch (e) { /* 引用条刷新失败不影响草稿恢复 */ }
 // chip 逻辑态草稿恢复(仅内置注册表名;自定义命令名恢复为 raw 文本,typed 路径仍等价执行)。
  if (v.startsWith("/") && v.indexOf(NL) === -1) { // 跨线修复同上
    const sp2 = v.indexOf(" ");
    const nm = (sp2 === -1 ? v.slice(1) : v.slice(1, sp2)).toLowerCase();
    const c = SLASH_COMMANDS.find((x) => x.value.toLowerCase() === nm);
    const ck = c && slashChipKind(c);
    if (ck) chipMount(c, ck, sp2 === -1 ? "" : v.slice(sp2 + 1), false); // 启动恢复不抢焦点
  }
}
function activeTaskOf(sid) { return [...tasks.values()].find((x) => x.sessionId === sid && ["queued", "running"].includes(x.state)) || null; }
// 会话切换/打开即拉目标 chip;无会话=隐藏。
setInterval(() => { if (ws.readyState === 1 && currentSid) wsSafeSend(JSON.stringify({ v: 1, type: "goal.get", sessionId: currentSid })); }, 15000);
// 会话 steerability(ZCode types.ts:661 语义投影):queued=已派单但尚无在跑 turn,
// = ref 的 no_active_turn/turn_not_steerable 场景——没有「可转向的 turn」,按钮不得进
// busy 态(不显示停/排),回落纯发送;输入照常提交,服务端在 session 忙碌时自动入队(输入口不消失)。
function steerableTaskOf(sid) {
  const cur = sid ? activeTaskOf(sid) : null;
  return cur && cur.state === "running" ? cur : null; // queued → 无可转向任务
}
/* 语音任务书状态(声明前置:renderSendBtn 全程会调 renderVoiceState,
 let/const 在脚本求值期有 TDZ,这里必须用 var + 立即赋值,防 boot 早期调用炸面板)。 */
var voiceRec = null;                    // 录音态:{mr,chunks,mime,stream,startedAt,timer,seconds,sid}
var voiceDraftBySid = new Map();        // lockKey(sid) -> true:撰写中(输入锁,按会话绑定)
var voiceStash = new Map();             // lockKey(sid) -> 任务书文本(结果到达时会话不在前台)
var voiceDraftTimer = null;             // 撰写回执兜底闹钟(掉线丢帧时解锁,防会话永久锁死)
function renderSendBtn() {
 // 发送按钮状态机:fixI17——忙碌且有输入文本→「排」(排队发送,不打断当前任务);
 // 忙碌且输入空→「停」(取消);空闲→「发」。旧「忙碌一律停」会让想发消息的用户误取消在跑任务。
 // 「停/排」busy 态只对确有在跑 turn(running)的会话生效。
  const cur = currentSid ? activeTaskOf(currentSid) : activeTaskOf("__none__");
  const busy = !!(currentSid ? steerableTaskOf(currentSid) : steerableTaskOf("__none__"));
  const hasText = !!$("instruction").value.trim();
  const stop = busy && !hasText;
  const queue = busy && hasText;
  $("go").textContent = stop ? "停" : queue ? "排" : "发";
  $("go").classList.toggle("stop", stop);
  $("go").classList.toggle("queue-mode", queue);
  $("go").title = stop ? "停止当前任务" : queue ? "排队发送:等当前任务完成后自动发送(不打断);排队中的消息可立即发送/编辑/删除" : "发送(Enter)";
 // 占位符双态(ref i18n zh-CN.ts:85-86:busyPlaceholder「输入内容会排队」/placeholder 空闲文案):
 // 会话有任何在办任务(activeTaskOf=queued/running)即 busy 态;chip 态占位符由 chipMount/chipUnmount
 // 自管(inChipHint 快照),不在此切。紧凑字面量形态=placeholder= 可被源码面 grep/测试锁定。
  const el = $("instruction");
 // 紧凑字面量形态(=无空格)是刻意的:源码面 placeholder= 正则/结构测试可锁定双态文案。
  if (!inChip) { if (!cur) el.placeholder="说点什么…(Enter 发送,Shift+Enter 换行;/ 打开指令;可拖文件/贴图)"; else el.placeholder="任务运行中,输入内容会排队(不打断;等当前任务完成后自动发送)"; }
  const cmp = document.querySelector(".composer");
  if (cmp) cmp.classList.toggle("busy", !!cur); // busy 视觉态=有在办任务(ref:busy 期间输入不禁用、转入排队语义)
 // (块4·4.6):draftSubmitPending 在飞=显式等待态——发送按钮禁点(disabled+aria-busy+
 // wait-ack 呼吸点)防重复点击(ref useDraftSessionPrewarm.ts:33 创建在飞等待语义);set 被拒/超时走
 // draftModelAbort → 其尾部 renderSendBtn 走本块摘禁点,恢复可点。submit 入口本就有 pending 防重
 // (m4),这里是视觉/可达性层(A11y)双保险。compact 等待态与它互斥:compactPending=true 时由
 // compactSetPending 持有 disabled,本块不抢(只看 draftSubmitPending)。
  const ackWait = !!draftSubmitPending;
  const go = $("go");
  if (go) {
    go.classList.toggle("wait-ack", ackWait);
    go.setAttribute("aria-busy", ackWait ? "true" : (compactPending ? "true" : "false"));
    if (ackWait && !compactPending) { go.setAttribute("disabled", "disabled"); go.title = "首轮消息正在等模型切换确认,确认后自动派发…"; }
    else if (!compactPending && go.hasAttribute("disabled") && !go.classList.contains("compact-wait")) go.removeAttribute("disabled");
  }
  renderVoiceState(); // 语音任务书三态(空闲/录音中/撰写锁)与发送按钮同源刷新
}
$("go").onclick = () => {
 // 停止分支同 renderSendBtn 口径——只对确有在跑 turn(running)的任务发 cancel;
 // queued(无可转向任务)时按钮已回落「发」,点击不得暗中取消排队任务(ref no_active_turn:输入口不转向不打断)。
  const cur = currentSid ? steerableTaskOf(currentSid) : null;
  if (cur && !$("instruction").value.trim()) { wsSafeSend(JSON.stringify({ v: 1, type: "task.cancel", taskId: cur.id })); return; } // fixI17:仅无文本时=停止意图
  if (inChip) { chipSubmit(); return; } // chip 态点发=执行指令逻辑(与 Enter 同义)
  submit();
};
`;
