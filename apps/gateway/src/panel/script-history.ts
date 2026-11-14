/**
 * 面板主脚本分片:script-history(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_HISTORY = `function renderHistory() {
  if (histEvents === null) { histLastHtml = null; histLastParts = null; $("chatBody").innerHTML = '<div class="empty-line">读 取 会 话 …</div>'; return; }
 // 子代理工作区 tab 激活:chatBody 归工作区渲染(完整动作/消息流回放),主历史挂起——切回「主会话」tab 即还原。
  if (subWsActive) { renderSubWorkspace(subWsActive); return; }
  turnOutcome = new Map(); // 每次全量重放重算轮次结局归属(时间轴进度着色的数据源)
  toolTokensScan(); // tool.tokens 事件增量预扫(toolCallId→tokens,代码块语义着色数据源)
  revSrcCache = {};        // 注入数据源随重放重建(防陈旧引用)
 // 滚动位置管理:renderChat 每条 WS 更新都全量重建 innerHTML,不保存=滚动每次被打回。
 // 语义:打开会话(histLanding)→落底显示最后消息;在底部→跟随最新;已上翻→保持原位自由查看。
 // 上翻时改元素锚(视口顶首个可见块)+相对偏移——整列重建后按锚回贴,上方高度变化不再平移内容。
  const vt = $("view-tasks");
  const keepTop = vt ? vt.scrollTop : 0;
  const wasBottom = vt ? (vt.scrollHeight - vt.scrollTop - vt.clientHeight < 60) : true; // 粘底容差 60px(聊天常规:接近底部即跟随,防内容微增高脱钩)
  const anchorEl = vt && !wasBottom ? mfFirstVisible(vt) : null;
  const anchorOff = anchorEl && vt ? anchorEl.getBoundingClientRect().top - vt.getBoundingClientRect().top : 0;
  let anchorIdx = -1; // 整列重建路径的锚回退:同序号新节点(结构未变时即同一块)
  if (anchorEl) {
    const mfKids = $("chatBody").children;
    for (let i = 0; i < mfKids.length; i++) if (mfKids[i] === anchorEl) { anchorIdx = i; break; }
  }
  const q = findQuery;
  const parts = [];
 // 错误横幅+重发(ZCode ChatErrorBanner/PendingCommandRecovery 裁剪)
 // fixT6 P1:原实现把横幅 push 到 parts 首位 = 恒为消息流第 0 个元素,长会话里它在视口外几万像素处
 // (经验证 bannerTop=-83516 / 视口 48~673 / visibleInViewport=false)= 失败原因与「重发」用户根本看不到。
 // 改为遍历结束后推入流尾(紧跟最新消息),按钮绑定仍按 .err-banner 选择器查,语义不变。
 // 修复:只认「最近一次任务失败」——旧实现取最新失败任务,失败后的成功轮次不会清掉横幅,
 // 流尾会一直挂着上一轮的失败(与置顶失败 chip 同源问题)。新任务提交/成功即让位。
  const latestTask = latestTaskOf(currentSid);
  const failed = latestTask && latestTask.state === "failed" ? latestTask : undefined;
 // fixT7:失败横幅人话化(用户用户反馈:LLM 404 model_not_found 裸 JSON 且无引导)——
 // 常见错误模式转人话+「去模型管理」直达;原文保留可复制。
  const failHumanize = (raw) => {
    const s = String(raw || "");
    if (/model_not_found|Model not exist/i.test(s)) return { text: "所选模型在端点不存在(model_not_found)——模型目录里手填了端点不提供的模型名,或模型与端点错配。", mgmt: true };
    if (/LLM 401|Unauthorized|invalid.*key/i.test(s)) return { text: "端点凭证无效(401)——检查 API key 配置。", mgmt: true };
    if (/LLM 429|rate.?limit/i.test(s)) return { text: "端点限流(429)——稍后重试或换模型。", mgmt: false };
    if (/MODEL_STREAM_IDLE_TIMEOUT|aborted/i.test(s)) return { text: "模型响应中断(空闲超时)——可重发;大上下文任务建议先整理会话。", mgmt: false };
    return { text: s.slice(0, 240), mgmt: false };
  };
 // result 属正文(索引条目可能没有)→ 未加载时先触发按需拉,横幅先显「详情加载中…」。
  if (failed) ensureTaskDetail(failed.id);
  const failH = failed ? failHumanize(taskBodyIds.has(failed.id) ? String(failed.result || "") : "任务详情加载中…") : null;
  const errHtml = failed
    ? '<div class="err-banner">任务失败:' + esc(failH.text) +
      '<div class="btns"><button data-act="retry">重发</button><button data-act="copy">复制错误</button>' + (failH.mgmt ? '<button data-act="modelmgmt">去模型管理</button>' : "") + '</div></div>'
    : "";
  let turnSeq = 0; // fixE22:外提(buildTurnNav 取真渲染趟终值;骨架趟在调用点重置)
  const office = settings.mode === "office";
 // fixE23:预扫(记忆化)——见模块侧 mfScan* 说明;本块结果为纯函数于 histEvents,双趟共享。
  if (mfScanRef !== histEvents || mfScanLen !== (histEvents ? histEvents.length : -1)) {
 // subagent.result 去重集(agent 路径同一结果会有 tool.result + subagent.result 双事件)
  const toolResultTexts = new Set(histEvents.filter((e) => e.kind === "tool.result").map((e) => String((e.payload || {}).content || "").trim()));
 // 子代理过程卡预扫(B):spawn 键集/终态/转后台——卡片状态判定与去重合一处。
  const subResByAgent = new Map(); // agentId → { ok, text, time }
  const subBgByAgent = new Set();
  const subSpawnKeys = new Set();
  const subSpawnInfo = new Map(); // agentId → { title, instructions, time }(等待卡与目录的标题/任务书数据源)
  const subAbsorbedCalls = new Set(); // 已被过程卡吸收的 spawn_subagent toolCallId(调用卡去重)
 // task_output 轮询聚合预扫(刷屏治理):主 agent 等子代理时,同 agentId 的 task_output
 // 调用+结果对会在消息流铺成几十行 raw JSON——聚合成一张「等待子代理」卡:首对渲染卡,
 // 后续同 agentId 对只并入该卡(轮询次数/已工作时长/终态翻绿)。历史会话重放同语义(全量重算)。
  const pollCallAgent = new Map(); // toolCallId → agentId(task_output 调用/结果吸收判据)
  const pollByAgent = new Map(); // agentId → { count, firstTime, lastTime, lastStatus, lastTail }
 // fixH12:结果预扫——toolCallId → {content,durationMs}(统一合并卡的状态徽标/耗时/结果体数据源;
 // journal 里 tool.result 晚于 message.agent 到达,渲染是全量重放,先扫后用即得「调用点即见结果」)。
  const resByCall = new Map();
  for (const e0 of histEvents) {
    if (e0.kind !== "tool.result") continue;
    const p0 = e0.payload || {};
    const cid0 = String(p0.toolCallId || "");
    if (cid0 && !resByCall.has(cid0)) resByCall.set(cid0, { name: String(p0.name || ""), content: String(p0.content || ""), durationMs: Number(p0.durationMs || 0) });
  }
 // fixH21:本会话是否已有 review.findings 交互组(code_review 合并卡据此走紧凑体,findings 免双份)
  let hasRevFindings = false;
  for (const e0 of histEvents) if (e0.kind === "review.findings") { hasRevFindings = true; break; }
  for (const e0 of histEvents) {
    const p0 = e0.payload || {};
    if (e0.kind === "subagent.spawn") {
      subSpawnKeys.add(String(p0.agentId || "") || "s" + String(e0.seq === undefined ? "" : e0.seq));
      const aid0 = String(p0.agentId || "");
      if (aid0) subSpawnInfo.set(aid0, { title: String(p0.title || ""), instructions: String(p0.instructions || ""), time: e0.time || 0 });
    }
    else if (e0.kind === "subagent.result") {
      const aid = String(p0.agentId || "");
      if (!aid) continue; // 旧事件无 agentId:维持旧渲染路径(不与卡关联)
      if (!subResByAgent.has(aid)) subResByAgent.set(aid, { ok: !(p0.event && p0.event.ok === false), text: String((p0.event && (p0.event.finalText || p0.event.note)) || ""), time: e0.time || 0 });
    } else if (e0.kind === "subagent.backgrounded") { const aid = String(p0.agentId || ""); if (aid) subBgByAgent.add(aid); }
    else if (e0.kind === "tool.result" && p0.name === "spawn_subagent") {
 // 过程卡已承载的回执:对应 toolCall 的调用卡一并吸收(双卡=噪音)。fixH20:completed 回执同步吸收——
 // echo-child 同步跑完的 spawn,过程卡已带终态/耗时/结果文本,调用侧再出一张合并卡仍是重复。
      try { const o = JSON.parse(String(p0.content || "")); if (o && o.agentId && subSpawnKeys.has(String(o.agentId))) subAbsorbedCalls.add(String(p0.toolCallId || "")); } catch (e) { /* 非 JSON 不吸收 */ }
    }
    else if (e0.kind === "message.agent" && p0.toolCalls) {
      for (const c0 of p0.toolCalls) {
        if (c0.name !== "task_output") continue;
        let aid = ""; try { aid = String(JSON.parse(c0.arguments || "{}").agentId || ""); } catch (e) { /* 参数坏=不聚合,原卡诚实可见 */ }
        if (!aid) continue;
        pollCallAgent.set(String(c0.id || ""), aid);
        if (!pollByAgent.has(aid)) pollByAgent.set(aid, { count: 0, firstTime: e0.time || 0, lastTime: 0, lastStatus: "", lastTail: "" });
      }
    }
    else if (e0.kind === "tool.result" && p0.name === "task_output") {
      const aid = pollCallAgent.get(String(p0.toolCallId || "")) || "";
      const info = aid ? pollByAgent.get(aid) : null;
      if (!info) continue; // 孤儿结果(找不到调用)=不吸收
      info.count += 1;
      info.lastTime = e0.time || info.lastTime;
      try { const o = JSON.parse(String(p0.content || "{}")); info.lastStatus = String(o.status || ""); info.lastTail = String(o.output || "").slice(-600); } catch (e) { /* 文本结果不解析 */ }
    }
  }
  mfScanData = { toolResultTexts, subResByAgent, subBgByAgent, subSpawnKeys, subSpawnInfo, subAbsorbedCalls, pollCallAgent, pollByAgent, resByCall, hasRevFindings };
  mfScanRef = histEvents; mfScanLen = histEvents ? histEvents.length : -1;
  }
  const { toolResultTexts, subResByAgent, subBgByAgent, subSpawnKeys, subSpawnInfo, subAbsorbedCalls, pollCallAgent, pollByAgent, resByCall, hasRevFindings } = mfScanData;
 // fixE22:窗口闸门——parts.length < wLo(更老的段)以零高占位替换。两种形态:gate(s)=串已廉价生成,
 // 直接换占位;gateL(fn)=惰性——重型生成器(mdToHtml/工具卡/子代理卡)只在窗口内才调用(串形式会把
 // 实参先求值,门禁白设——首版经验证教训)。wLo=0 时恒真(小会话/查找态=完全旧路径);骨架趟=+Infinity 全占位。
  let wLo = findQuery ? 0 : mfWinLo;
  const gate = (s) => (parts.length >= wLo ? s : MSG_PH);
  const gateL = (fn) => (parts.length >= wLo ? fn() : MSG_PH);
  const buildParts = () => {
  let lastSkipShown = false; // 压缩跳过去重:同一 episode 只渲染首条「无需压缩」
  const pollEmitted = new Set(); // 渲染期:同 agentId 首对出聚合卡,后续对吸收(fixE22:随趟重建——骨架趟不得提前标记)
 // 工具分组(ZCode 分组搜索工具/终端命令/文件更改):连续同类 tool.result 聚合。
 // 分类:explore(读取/搜索类)/changes(写入/编辑类)/terminal(命令类)/""(不分组)。
  const catOf = (name) => {
    const n = String(name || "").toLowerCase();
    const has = (arr) => arr.some((k) => n.indexOf(k) >= 0);
    if (has(["write", "edit", "patch", "apply", "commit", "checkpoint"])) return "changes";
    if (has(["shell", "exec", "terminal", "command", "workflow", "run_"])) return "terminal";
    if (has(["search", "read", "sense", "skill", "experience", "list", "files"])) return "explore";
    return "";
  };
  const catOn = (cat) => cat === "explore" ? settings.gSearch === "on" : cat === "terminal" ? settings.gTerm === "on" : cat === "changes" ? settings.gChanges === "on" : false;
  const catLabel = (cat) => cat === "explore" ? "探索" : cat === "terminal" ? "终端" : cat === "changes" ? "更改" : "";
  const argsByCall = new Map(); // callId → 原始参数 JSON(toolCalls 先于 tool.result 到达;fixH13 起存原文供专属渲染解析)
  const mergedCalls = new Set(); // fixH13:已由统一合并卡承载的 toolCallId(tool.result 到达时跳过,不再二次出卡)
 // 轨迹卡曲线数据源(J1 2026-11 token 轮):步数→tokens 的累积序列,在事件循环外声明,
 // 遇 task.trajectory 事件 push {step,tokensSpent}。renderHistory 每次全量重放整段历史,
 // 所以库里已有的轨迹事件每趟都会重新灌满——不需要额外持久化,也不会跨趟残留旧点。
  const trajSeries = [];
  let grp = null;
 // ---- 调用轨迹聚合----
 // 现状:每次 LLM 调用产生「一行 trace」+「一张思考卡」两个独立块,一轮下来十几块占满消息流。
 // 改为:同一次调用的 trace 行与其思考内容合成一张 details 卡(summary 带 roles 计数 [s×3 u×1 a×1 t×2]);
 // 无思考内容时仍是原来那一行(零变化),只压一次调用也不额外成卡。
  let traceBuf = [];
  const ROLE_ABBR = { system: "s", user: "u", assistant: "a", tool: "t" };
  const traceFlush = () => {
    if (!traceBuf.length) return;
    const items = traceBuf.slice();
    traceBuf = [];
 // roles 构型:把连续相同角色压成 a×N([s→u→a→t×N])——逐条计数会得到 u×28/a×240,
 // 那是「消息条数」不是「构型」,读不出这轮对话长什么样。
    const compress = (arr) => {
      const segs = [];
      for (const r of arr || []) {
        const last = segs[segs.length - 1];
        if (last && last.r === r) last.n++;
        else segs.push({ r, n: 1 });
      }
      const shown = segs.slice(0, 6).map((x) => (x.n > 1 ? x.r + "×" + x.n : x.r));
      return shown.join("→") + (segs.length > 6 ? "→…" : "");
    };
    const withThink = items.some((it) => it.think);
    if (items.length === 1 && !withThink) { parts.push(items[0].html); return; } // 无思考=保持原来那一行
 // 多段时取最后一段构型(当前轮上下文形态),单段直接用它
    const lastShape = compress(items[items.length - 1].roles);
    parts.push(gate('<details class="trace-group"><summary>' + ic("bolt") + " 调用轨迹 " +
      (items.length > 1 ? items.length + " 段" : "1 次") + " " + esc(items[items.length - 1].head || "") +
      (lastShape ? ' <span class="tg-roles">[' + esc(lastShape) + "]</span>" : "") + "</summary>" +
      items.map((it) => it.html + (it.think || "")).join("") + "</details>"));
  };
  const flushGrp = () => {
    if (grp && grp.items.length > 1) {
 // fixT6 P2:原条目数 ≤4 即 open — 真实大会话组内条目数分布 2×52/3×4/4×1(经验证 57 组 100% 展开,
 // 占 40226px=消息流 49%),分组等于名义存在。改为默认闭合,summary 已写明「探索 · N 次」可点开。
      parts.push(gate('<details class="tool-group"><summary>' + grp.label + " · " + grp.items.length + " 次</summary>" + grp.items.join("") + "</details>"));
    } else if (grp && grp.items.length === 1) {
      parts.push(gate(grp.items[0])); // 单条不成组,还原原卡
    }
    grp = null;
  };
 // 代码块复制按钮(ZCode code-block 复制语义):委托取 .code 文本,免转义。
 // 泄漏修复:此前每次 renderHistory 都 document 挂一层——渲染百次=百个重复监听,一次性守卫。
  if (!codeCopyDelegated) {
    codeCopyDelegated = true;
    document.addEventListener("click", (e) => {
      const t = e.target && e.target.closest ? e.target.closest(".code-copy") : null;
      if (!t) return;
      const wrap = t.closest(".code-wrap");
      const pre = wrap ? wrap.querySelector("pre.code") : null;
      if (pre && navigator.clipboard) {
        navigator.clipboard.writeText(pre.textContent || "").then(() => { t.textContent = "已复制"; setTimeout(() => { t.textContent = "复制"; }, 1200); }).catch(() => {});
      }
    });
  }
 // fixT6 P2:长汇报「展开全文/收起」委托(一次性守卫,同 code-copy 语义防重复挂监听)
  if (!replyMoreDelegated) {
    replyMoreDelegated = true;
    document.addEventListener("click", (e) => {
      const b = e.target && e.target.closest ? e.target.closest(".reply-more") : null;
      if (!b) return;
      const k = b.getAttribute("data-reply-toggle") || "";
      const wrap = b.closest(".reply-wrap");
      const open = replyOpen.has(k);
      if (open) replyOpen.delete(k); else replyOpen.add(k);
      if (wrap) { wrap.classList.toggle("open", !open); }
      b.textContent = open ? "展开全文" : "收起";
    });
  }
 // fixE23:预扫已上提记忆化(见上 mfScan 块);主循环直接消费解构结果。
 // 画布形态分身独立看板(子代理消息不与 coding agent 混在一条流):
 // 会话流不渲染任何子代理来源条目——spawn 过程卡/task_output 等待卡/answer_subagent 交互与回执/
 // subagent.spawn·result 终态卡,全部改由「分身 Agents」卡的消息流区分组承载。
 // 归属判定与既有通道同源(subagent.* 事件 kind + spawn/answer/task_output 工具名),不新造判据;
 // 经典布局 cvHideSub=false,渲染零变化。
  const cvHideSub = canvasActive();
  for (const ev of histEvents) {
 // 子代理工作区专用事件:主会话流一律不渲染——本 kind 的完整回放在子代理工作区 tab,
 // 这里显式跳过(防止任何分支把它当消息/工具渲染=双渲染;预扫段只认既有 kind,天然不中)。
    if (ev.kind === "subagent.event") continue;
 // 轨迹/思考的聚合缓冲:遇到任何「正文类」事件先落盘,保证消息流顺序不乱(缓冲只跨越连续调用段)
    if (ev.kind !== "llm.trace" && ev.kind !== "message.agent") traceFlush();
    const t = ev.time ? '<span class="ev-time">' + new Date(ev.time).toLocaleTimeString() + '</span>' : "";
    if (ev.kind === "compact.done") {
      lastSkipShown = false; // 真边界:重置跳过去重(下一 episode 可再显示一条)
 // 压缩边界行(ZCode TimelineMarkerRow 对齐:全宽分隔线+居中 pill)
 // 板 n3:双文案(手动/自动,按 payload.trigger)+ pill 后「详情」展开区
 // (摘要全文 / 压缩指示 chip / tokens 水位)。收起态与旧观感一致:仍只显示前 60 字摘要 pill。
      const cpd = ev.payload || {};
      const cpFull = String(cpd.summary || "");
      const csum = cpFull.slice(0, 60);
      const cpManual = String(cpd.trigger || "") === "manual";
      const cpKTok = function (n) { return (Math.round(Number(n) / 100) / 10).toFixed(1) + "k"; };
 // tokensAfter 优先;runtime 现状落的是 tokensAfterMicrocompact(同口径压缩后水位),缺失时回落它
      const cpAfter = cpd.tokensAfter || cpd.tokensAfterMicrocompact;
      const cpToks = cpd.tokensBefore && cpAfter
        ? '<div class="cp-row"><span class="cp-tok">≈' + cpKTok(cpd.tokensBefore) + " → " + cpKTok(cpAfter) + " tok</span></div>"
        : "";
      const cpInstr = cpd.instructions
        ? '<div class="cp-row"><span class="cp-chip">压缩指示:' + esc(String(cpd.instructions).slice(0, 40)) + "</span></div>"
        : "";
 // 无摘要全文/无指示/无 tokens 水位时不出「详情」钉(避免空展开区)
      const cpMore = (cpFull || cpInstr || cpToks)
        ? '<details class="cp-more"><summary>详情</summary><div class="cp-more-body">'
          + esc(cpFull) + "</div>" + cpInstr + cpToks + "</details>"
        : "";
      flushGrp();
      parts.push(gate('<div class="cp-divider"><span class="cp-line"></span><span class="cp-pill">'
        + (cpManual ? "上下文已压缩" : "上下文已自动压缩")
        + (csum ? " · " + esc(csum) : "") + "</span>" + cpMore
        + '<span class="cp-line"></span></div>'));
      continue;
    }
    if (ev.kind === "compact.failed") {
 // 板 n3:压缩失败边界(弱红)——此前失败只在 toast 一闪,历史里彻底不可见
      const cfp = ev.payload || {};
      const cfReason = String(cfp.reason || "").slice(0, 60);
      flushGrp();
      parts.push(gate('<div class="cp-divider compact-failed"><span class="cp-line"></span><span class="cp-pill">上下文压缩失败'
        + (cfReason ? " · " + esc(cfReason) : "") + '</span><span class="cp-line"></span></div>'));
      continue;
    }
    if (ev.kind === "compact.skipped") {
 // 去重:骑线期每步一条跳过事件,连续渲染成「无需压缩」刷屏(注意 15 连)。
 // 同一压缩 episode(两次 compact.done/start 之间)只显示第一条跳过。
      if (lastSkipShown) continue;
      lastSkipShown = true;
 // 板 n3:压缩未发生(上下文已是最新/无可压缩)边界 —— 灰弱色,与真边界区分
      flushGrp();
      parts.push(gate('<div class="cp-divider compact-skipped"><span class="cp-line"></span><span class="cp-pill">上下文已是最新,无需压缩</span><span class="cp-line"></span></div>'));
      continue;
    }
    if (ev.kind === "task.trajectory") {
 // 轨迹卡(J1 2026-11 token 轮):loop 每 N 步/phase 切换旁路落一条 task.trajectory
 // (payload=步/工具类别计数/并行率/错误/重试/tokens/阶段/子目标,不含对话正文)。
 // 渲染为折叠画像卡:summary 读「走到哪」,展开给工具分布 top6 + 步数/token 曲线。
 // 曲线数据=本趟累积的 trajSeries(见上方声明;全量重渲时即完整)。
      flushGrp();
      const tj = ev.payload || {};
      trajSeries.push({ step: Number(tj.step || 0) || 0, tokensSpent: Number(tj.tokensSpent || 0) || 0 });
      parts.push(gate(trajCardHtml(tj, trajSeries.slice())));
      continue;
    }
    if (ev.kind === "tip.injected") {
 // tips 注入留痕:
 // loop 每步把 ephemeral tip 注入 LLM 请求时旁路落一条本事件(deriveMessages 不读=上下文零变化)。
 // 渲染为可折叠提示行:首行「tips · 类别 + 第 N 步 + 字符数」,展开看完整注入内容。
 // 默认折叠——code-orient/history-align 块可达数千字,不占消息流;与 sys-line 同族淡底+左描边。
      flushGrp();
      const tp = ev.payload || {};
      const tkeys = Array.isArray(tp.keys) ? tp.keys.map(function (x) { return String(x); }).filter(Boolean) : [];
      const ttext = String(tp.text || "");
      const tchars = Number(tp.chars || ttext.length) || 0;
 // 去掉包封与首行标签,展开区只显示 tip 正文(块间空行保留)。
 // 注意:本文件是模板字符串,正则里的转义斜杠会被 Page 模板吃掉导致整页语法错误——这里不用正则。
      let tbody = ttext;
      const TIP_OPEN = "<system-reminder>";
      if (tbody.indexOf(TIP_OPEN) === 0) {
 // 换行符用 fromCharCode 取:JS 转义的反斜杠加 n 会被 Page 模板层吃成真换行 → 整页语法错误
        const nl = tbody.indexOf(String.fromCharCode(10));
        tbody = nl >= 0 ? tbody.slice(nl + 1) : "";
      }
      const TIP_CLOSE = "</system-reminder>";
      if (tbody.lastIndexOf(TIP_CLOSE) === tbody.length - TIP_CLOSE.length) tbody = tbody.slice(0, tbody.length - TIP_CLOSE.length);
      parts.push(gateL(function () {
        return '<details class="tip-line"><summary>' + t
          + '<span class="tl-tag">tips</span>'
          + '<span class="tl-keys">' + esc(tkeys.length ? tkeys.join(" + ") : "注入") + '</span>'
          + '<span class="tl-meta">第 ' + Number(tp.step || 0) + ' 步 · ' + tchars + ' 字' + (tp.truncated ? " · 展示截断" : "") + '</span>'
          + '</summary><div class="tl-body">' + sketchifyHtml(esc(tbody)) + '</div></details>';
      }));
      continue;
    }
    if (ev.kind === "message.user") {
 // fixG1(用户用户反馈):display 为空串且 text 以 <system-reminder> 开头=系统注入给模型的
 // 提醒块(子代理重操作审批等)——不是用户说的话,不再冒充用户气泡。独立渲染为「子代理→主代理」
 // 交互卡(谁请求/请求什么);主代理的应答=紧随的 answer_subagent 工具卡,视觉相邻即成对话对。
      if (!ev.payload.display && String(ev.payload.text || "").startsWith("<system-reminder>")) {
 // 画布形态:子代理→主代理交互卡不进会话流(子agent会话流卡承载);经典布局保持原卡。
        if (!cvHideSub) { flushGrp(); parts.push(gateL(() => subagentBridgeHtml(String(ev.payload.text || ""), ev.time, q))); }
      } else {
      flushGrp(); turnSeq++;
      const attsHtml = (ev.payload.attachments || []).length
        ? attRowHtml(ev.payload.attachments)
        : "";
 // display=原始输入(注入块只喂模型,不进用户消息展示);老事件无该字段回落 text。
      const utext = ev.payload.display || ev.payload.text || "";
 // /095:slash 命令开头的用户消息渲染为 chip(name+参数),raw 前缀合流的模板 remainder 按注册表
 // 展开式等值隐藏(用户所说=raw,机器合成=任务书,展示分账);不识别的余文原样呈现零丢失,旧消息零影响。
 // fixE22:userSlashHtml 入 gateL 惰性——窗口外旧消息不再付 chip 解析+高亮成本。
 // fixT6 P2:用户消息时间戳以 .who 的 title 承载(气泡内不塞元信息,详情可悬浮查)
      const uTitle = ev.time ? ' title="发送时间 ' + esc(new Date(ev.time).toLocaleTimeString()) + '"' : "";
      parts.push(gateL(() => '<div class="user-line" data-turn="' + turnSeq + '"><span class="who"' + uTitle + '>你</span><span class="txt">' + userSlashHtml(String(utext), q) + attsHtml + '</span><span class="msg-acts"><button data-act="side" data-text="' + esc(utext) + '">侧聊</button><button data-act="edit" data-text="' + esc(utext) + '">重编</button></span></div>'));
      }
    }
    else if (ev.kind === "message.system") {
 // 技能执行反馈闭环(视频 T3):goal 切换/续跑等系统通知此前只在 journal 里,聊天流完全不可见
 // ——「技能用没上」的感知缺口之一。渲染为系统行。
      flushGrp();
 // 板 n3双显治理:压缩后 runtime 会追一条 "[上下文已压缩]" 系统通知,摘要已由
 // compact.done 边界行承载——这条不再重复渲染(其它系统行照旧)。
      const sysText = String((ev.payload || {}).text || "");
      if (sysText.startsWith("[上下文已压缩]")) continue;
      const st = ev.time ? '<span class="ev-time">' + new Date(ev.time).toLocaleTimeString() + '</span>' : "";
      parts.push(gate('<div class="sys-line">' + st + sketchifyHtml(esc(sysText)) + "</div>"));
    }
    else if (ev.kind === "message.agent") {
      flushGrp();
 // 思考内容(ZCode ThinkingCard 对齐):provider reasoning_content 进 journal。
 // 不再独立成卡——挂到紧邻的调用轨迹条目上(同一次调用的 trace 行 + 思考合成一张卡)。
      if (ev.payload.reasoning && settings.thinking === "on" && !office) {
        const thHtml = gateL(() => '<details class="think-card"><summary>思考 · ' + Math.max(1, Math.round(Number(ev.payload.llmMs || 0) / 1000)) + 's</summary><div class="th-body">' + sketchifyHtml(hl(esc(String(ev.payload.reasoning).slice(0, 4000)), q)) + "</div></details>");
        const lastTr = traceBuf.length ? traceBuf[traceBuf.length - 1] : null;
        if (lastTr) lastTr.think = thHtml;
        else parts.push(thHtml);
      }
      if (ev.payload.text) parts.push(gateL(() => replyBlockHtml(ev, q)));
      if (ev.payload.toolCalls) {
        for (const c of ev.payload.toolCalls) {
          if (c.name === "spawn_subagent" && subAbsorbedCalls.has(String(c.id || ""))) continue; // 过程卡已承载(B )
 // 画布形态分身独立看板:spawn/answer/task_output 的调用回显不进会话流(子agent会话流卡承载)。
          if (cvHideSub && (c.name === "spawn_subagent" || c.name === "answer_subagent")) continue;
 // task_output 轮询聚合:同 agentId 的调用对只在首对渲染一张「等待子代理」卡,
 // 后续对被吸收(卡的状态/次数/时长随 journal 增量与 3s 轮询重渲自动更新)。
          if (c.name === "task_output" && !office) {
            const aid = pollCallAgent.get(String(c.id || "")) || "";
            if (aid) {
              argsByCall.set(c.id, String(aid));
              if (!cvHideSub && !pollEmitted.has(aid)) { pollEmitted.add(aid); flushGrp(); parts.push(gateL(() => taskWaitCardHtml(aid, pollByAgent.get(aid), subResByAgent, subBgByAgent, subSpawnInfo, q))); }
              continue;
            }
          }
 // fixH13:参数摘要存原始 JSON(tgResultItem 专属渲染按工具解析;旧口径只留一句 query 类摘要)
          argsByCall.set(c.id, String(c.arguments || ""));
          const cat = catOf(c.name);
          if (office) parts.push(gate('<span class="office-chip">» ' + esc(c.name) + "</span>"));
 // fixH13:非分组工具(含 TOOL_SOLO 强制独立:code_index/code_sense/code_review/board/todo)
 // 渲染统一合并卡——图标+动词+参数摘要+状态徽标,结果体就地展开;调用与结果不再两张裸卡。
          else if (!cat || !catOn(cat) || toolSoloOf(c.name)) {
            mergedCalls.add(String(c.id || ""));
            flushGrp();
            parts.push(gateL(() => toolCallCard(c, q, resByCall.get(String(c.id || "")), toolTokensOfId(String(c.id || "")),
              { compact: String(c.name || "").toLowerCase() === "code_review" && hasRevFindings }))); // fixH21:findings 由 review.findings 交互组承载
          }
 // 分组命中:参数已入 argsByCall,等 tool.result 合并成组项。
        }
      }
    }
    else if (ev.kind === "tool.result") {
      const cat = catOf(ev.payload.name);
      const content = String(ev.payload.content || "");
 // 画布形态分身独立看板:子代理三类工具的孤儿回执(被拒 spawn/answer 回执/孤儿 task_output)
 // 也不进会话流——与调用侧过滤同口径,经典布局零变化。
      if (cvHideSub && (ev.payload.name === "spawn_subagent" || ev.payload.name === "answer_subagent" || ev.payload.name === "task_output")) continue;
 // plan-gate / 权限层拒绝(用户用户反馈「拒绝显示成绿色完成」):人话系统行带 hint,
 // 卡片侧由 toolCallCard/toolResIsErr 统一红显「被拒」。两处都改=状态不再骗人。
      const gateRej = (office ? null : gateRejectOf(content));
      if (gateRej) {
        flushGrp();
        const gn = String(ev.payload.name || "");
 // 模板层纪律:HTML 属性引号一律用单引号(双引号在 PAGE 模板里要转义,写入时极易被吃掉)
        parts.push(gate("<div class='sys-line sys-warn'>" + ic("warn") + " " + esc(gn) + " 被拒 · " +
          esc(/plan-gate/i.test(gateRej.reason) ? "plan-gate" : "工具层") + " —— " + esc(clip(gateRej.reason, 120)) +
          "<span class='dim'>(未执行;按提示补齐前置后重试)</span></div>"));
      }
 // B:spawn_subagent 的回执(agentId 在场且过程卡已承载)不再重复出卡——
 // 机械回执由过程卡的状态/tail 呈现;rejected/解析不出 agentId 的回执仍走原卡(诚实可见)。
 // fixH20:completed 回执同吸收(过程卡带终态文本,孤儿结果再出=与过程卡双份)。
      if (ev.payload.name === "spawn_subagent" && !office) {
        try {
          const o = JSON.parse(content);
          if (o && o.agentId && subSpawnKeys.has(String(o.agentId))) continue;
        } catch (e) { /* 非 JSON=普通结果照旧 */ }
      }
 // task_output 轮询结果对已被「等待子代理」聚合卡吸收(孤几结果/office 模式仍走原卡)
      if (ev.payload.name === "task_output" && !office && pollCallAgent.has(String(ev.payload.toolCallId || ""))) continue;
 // fixH13:合并卡已承载的结果不再二次出卡(调用点即结果;孤儿结果走下方原卡路径诚实可见)
      if (!office && mergedCalls.has(String(ev.payload.toolCallId || ""))) continue;
      if (office) { flushGrp(); parts.push(gate('<span class="office-chip">' + ic("sub") + ' ' + esc(content.slice(0, 60)) + "</span>")); }
      else if (cat && catOn(cat)) {
 // 组项结构化(tgResultItem:名+参数头 + 行块代码形态;截断+tr-more 展开全文)
        const item = gateL(() => tgResultItem(String(ev.payload.name || ""), argsByCall.get(ev.payload.toolCallId) || "", content, q, toolTokensOf(ev)));
        if (grp && grp.cat === cat) {
          grp.items.push(item);
        } else {
          flushGrp();
          grp = { cat, label: catLabel(cat), items: [item] };
        }
      } else { flushGrp(); parts.push(gateL(() => toolResultCard(content, q, toolTokensOf(ev), String(ev.payload.name || ""), argsByCall.get(String(ev.payload.toolCallId || "")) || "", String(ev.payload.toolCallId || ("seq" + ev.seq))))); }
    }
    else if (ev.kind === "review.findings") {
      flushGrp();
      const fs2 = (ev.payload.findings || []).slice(0, 20);
      if (fs2.length) {
 // 一键回注:findings 入缓存(点击时按 rk+序号取回完整条目),卡上加「⇒修复」/组头加「全部注入」。
        const rk = "g" + (ev.seq || ev.time || 0) + "-" + fs2.length;
        revSrcCache[rk] = {
          sid: ev.sessionId || currentSid || "",
          items: fs2.map((f) => ({ file: String(f.file || ""), line: Number(f.line || 1), severity: String(f.severity || "info"), title: String(f.title || ""), detail: String(f.detail || "").slice(0, 400), rule: f.rule ? String(f.rule) : "" })),
        };
        parts.push(gateL(() => '<details class="rev-group" open><summary class="rev-head">代码评论 ' + fs2.length + ' 条' + (ev.payload.summary ? " · " + esc(String(ev.payload.summary).slice(0, 60)) : "") +
          '<button class="rev-inj-all" data-rev="' + rk + '" title="把这 ' + fs2.length + ' 条评论注入聊天窗,交 agent 逐条修复">' + ic("inject") + ' 全部注入</button></summary>' +
          fs2.map((f, fi) => {
            const sev = String(f.severity || "info");
            return '<div class="rev-card" data-file="' + esc(f.file) + '" data-line="' + Number(f.line || 1) + '">' +
              '<span class="rev-sev ' + esc(sev) + '">' + (sev === "warning" ? ic("warn") : sev === "nit" ? ic("dot") : (sev === "critical" || sev === "high" || sev === "error" || sev === "fail") ? ic("fail") : "") + esc(sev.toUpperCase()) + "</span>" +
              '<span class="rev-loc">' + esc(f.file) + ":" + Number(f.line || 1) + "</span>" +
              '<span style="flex:1;min-width:0"><div class="rev-title">' + esc(f.title) + "</div>" +
              (f.detail ? '<div class="rev-detail">' + esc(String(f.detail).slice(0, 160)) + "</div>" : "") + "</span>" +
              '<button class="rev-inj" data-rev="' + rk + '" data-i="' + fi + '" title="把这条评论注入聊天窗,交 agent 修复">' + ic("inject") + '修复</button></div>';
          }).join("") + "</details>"));
      }
    }
    else if (ev.kind === "subagent.spawn") {
 // B子代理过程卡:取代纯参数 toolCard——状态(运行中/完成/失败/已结束)+耗时+实时 tail。
 // 身份色沿用 ZCode 内置子代理显式身份色机制(避免按名称 hash 颜色漂移)。
 // 画布形态:不进会话流(子agent会话流卡以分组头承载任务书/状态)。
      if (cvHideSub) continue;
      flushGrp(); parts.push(gateL(() => subagentCardHtml(ev, subResByAgent, subBgByAgent, q)));
    }
    else if (ev.kind === "subagent.result") {
      if (cvHideSub) continue; // 画布形态:终态文本由子agent会话流卡分组尾承载,会话流不再出卡
 // 去重(agent 路径:spawn_subagent 是工具调用,tool.result 与 subagent.result 内容相同,双卡=用户困惑)
      const sub = (ev.payload.event && (ev.payload.event.finalText || ev.payload.event.note)) || JSON.stringify(ev.payload.event || {}).slice(0, 800);
      const aid = String((ev.payload || {}).agentId || "");
      if (aid && subSpawnKeys.has(aid)) { flushGrp(); continue; } // 已由过程卡承载(卡体带终态文本)
      if (toolResultTexts.has(String(sub).trim())) { flushGrp(); continue; }
      flushGrp(); parts.push(gateL(() => office ? '<span class="office-chip">' + ic("sub") + ' 子代理返回</span>' : toolResultCard(sub, q)));
    }
    else if (ev.kind === "review.inject") {
      flushGrp();
 // 评审评论回注留痕:会话内可见「谁把哪些评论注进来交给了哪个任务」。
      const rp = ev.payload || {};
      parts.push(gate('<div class="task-sub">' + ic("inject") + ' 注入 ' + Number(rp.count || 0) + " 条评审评论(" + esc(String(rp.source || "")) + ")" +
        (rp.files && rp.files.length ? " · " + esc(rp.files.slice(0, 3).join(", ")) + (rp.files.length > 3 ? " …" : "") : "") + "</div>"));
    }
    else if (ev.kind === "board.update") {
      flushGrp();
 // 设计白板更新:轻量行内 chip,点击直达板视图对应任务的板。
      const bp = ev.payload || {};
      parts.push(gate('<div class="task-sub">' + ic("grid") + ' 设计白板' + (bp.status === "done" ? "已落实" : bp.status === "implementing" ? "更新(实施中)" : "草稿") +
        '「' + esc(String(bp.title || "").slice(0, 40)) + "」 · " + Number(bp.nodeCount || 0) + " 节点" +
        '<button class="board-chip" data-board-task="' + esc(String(bp.taskId || "")) + '">查看白板</button></div>'));
    }
    else if (ev.kind === "llm.trace") {
 // LLM 调用速览行(用户用户反馈「journal 里看不到 system/构型」)——
 // 每次调用一行:模型/轮步/耗时/token/消息构型/工具调用名;title=轨迹文件全路径,
 // 点击复制路径,system 提示词与请求/响应全文都在该文件(journal 只存指针+构型摘要)。
 // 改为进聚合缓冲(连续调用收一张可展开卡;单条自动还原原行,零丢失)。
      const tp = ev.payload || {};
      const roleArr = Array.isArray(tp.messageRoles) ? tp.messageRoles.map((r) => ROLE_ABBR[String(r)] || String(r)) : [];
      const roleFull = Array.isArray(tp.messageRoles) ? tp.messageRoles.join("→") : "";
      const roles = Array.isArray(tp.messageRoles) ? roleShape(tp.messageRoles, 6) : "";
      const tcs = Array.isArray(tp.toolCalls) ? tp.toolCalls.slice(0, 4).join(",") + (tp.toolCalls.length > 4 ? " +" + (tp.toolCalls.length - 4) : "") : "";
      const u = tp.usage || {};
      const iok = Number(u.inputTokens || 0), ook = Number(u.outputTokens || 0);
 // 命中率 = API 的 cached/input(input>0 且 cached>0 才出);suspect 只加行尾徽标,数字不变。
      const cok = Number(u.cachedTokens || 0);
      const hitTxt = iok > 0 && cok > 0 ? " · 命中 " + ((cok / iok) * 100).toFixed(1) + "%" : "";
      const susTxt = tp.usageSuspect
        ? '<span class="lt-sus" title="' + esc(String(tp.usageAnomaly || "上游 usage 与本步输入不自洽")) + '">⚠</span>' : "";
      const lineHtml = gateL(() => '<div class="task-sub llm-trace-line" data-trace-file="' + esc(String(tp.file || "")) + '" title="' + esc(String(tp.file || "") + (roleFull ? " · 消息构型 " + roleFull : "")) + '" style="cursor:pointer">' +
        '<span class="lt-main">' + ic("bolt") + " LLM t" + Number(tp.turn || 0) + "s" + Number(tp.step || 0) +
        " · " + esc(String(tp.model || "?")) + " · " + fmtDur(Number(tp.durationMs || 0)) +
        (iok || ook ? " · ↑" + iok + " ↓" + ook + hitTxt : "") +
        (roles ? ' · <span class="lt-roles" title="消息构型 ' + esc(roleFull) + '">[' + esc(roles) + "]</span>" : "") +
        (tcs ? " · 调用:" + esc(tcs) : "") + "</span>" +
        '<span class="lt-copy">复制轨迹路径</span>' + susTxt + "</div>");
      traceBuf.push({ html: lineHtml, roles: roleArr, head: "t" + Number(tp.turn || 0) + "s" + Number(tp.step || 0) });
    }
    else if (ev.kind === "task.done" || ev.kind === "task.fail" || ev.kind === "task.cancel" || (ev.kind === "task.progress" && ev.payload && ev.payload.state === "cancelled")) {
      flushGrp();
 // fixT6 P2:task.cancel 此前无渲染分支——取消的任务在聊天流里零痕迹(经验证注入 task.cancel 后既无行也无横幅),
 // 用户看到脱队的最后一条回复、不知道任务已停。与完成/失败同语义出结算行(取消归 fail 色,与侧栏状态点一致)。
 // fixG4:journal 里取消终态的实际落盘 kind=task.progress(payload.state=cancelled,app.ts 状态映射)——
 // 老的 task.cancel 分支从未被生产事件命中过;两形态都认,重启收编/用户取消都能出结算行。
      const isCancel = ev.kind === "task.cancel" || (ev.kind === "task.progress" && !!ev.payload && ev.payload.state === "cancelled");
 // 时间轴进度归属:task.done/fail 记到其前最近的用户轮(journal 事件序;跨轮迟到归后续轮,近似可接受)
      if ((ev.kind === "task.fail" || isCancel) && turnSeq > 0) turnOutcome.set(String(turnSeq), "fail");
      else if (ev.kind === "task.done" && turnSeq > 0 && !turnOutcome.has(String(turnSeq))) turnOutcome.set(String(turnSeq), "done");
 // 回复文本回退:老事件流只有 task.done 携 result(修复前的历史会话也能显示回复)。
      if (ev.kind === "task.done" && ev.payload && ev.payload.result && !histEvents.some((x) => x.kind === "message.agent")) {
        parts.push(gateL(() => '<div class="task-reply">' + mdToHtml(ev.payload.result, q) + '</div>'));
      }
      const tr = traceStats[currentSid];
      const dTask = tasks.get(String(ev.payload.id || ""));
      const durTxt = dTask && dTask.startedAt ? " · 用时 " + fmtDur(dTask.updatedAt - dTask.startedAt) : "";
 // bq4(板质量遥测闭环:结算卡显示规划质量。task.planQuality 由 agent-wiring 收尾挂上
 // (task.quality 同源),task.detail.get 带出;索引条目(task.list)无此字段=旧任务/详情未拉,整行不渲染。
      if (dTask && dTask.id && !taskBodyIds.has(dTask.id)) ensureTaskDetail(dTask.id); // 详情未到位先补拉,回包后重渲出行
      const pqChip = (() => {
        const pq = dTask && dTask.planQuality;
        if (!pq || typeof pq !== "object") return ""; // 缺省=旧任务,整行不渲染(防御性判空)
        const ok = (v) => Number.isFinite(Number(v));
        const s = (v) => (ok(v) ? String(Number(v)) : "-"); // 数值,NaN→"-"
        const pc = (v) => (ok(v) ? Math.round(Number(v) * 100) + "%" : "-"); // 0~1 比率→百分比
        const p0 = pq.p0 && typeof pq.p0 === "object" ? pq.p0 : {};
        const p0Pct = ok(p0.passed) && ok(p0.total) && Number(p0.total) > 0 ? Math.round((Number(p0.passed) / Number(p0.total)) * 100) + "%" : pc(p0.rate); // 百分比,rate 兜底
        const sk = pq.skeleton && typeof pq.skeleton === "object" ? pq.skeleton : null;
        return ' · <span class="st-chip" title="规划质量(bq4 遥测:板型/内容节点/P0 覆盖/锚密度' + (sk ? "/骨架采纳率" : "") + ');数值缺失=-">规划质量 <b>' + esc(String(pq.boardType || "-")) + "</b> · 内容<b>" + s(pq.contentNodes) + "/" + s(pq.nodes) + "</b> · P0<b>" + s(p0.passed) + "/" + s(p0.total) + "·" + p0Pct + "</b> · 锚<b>" + pc(pq.anchorDensity) + "</b>" + (sk ? " · 骨架采纳<b>" + pc(sk.adoptionRate) + "</b>" : "") + "</span>";
      })();
 // 五阶段轨迹条(体验项):结算行旁回放本会话 task.phase(理解→…→完成,带 note title)
        const phEvts = histEvents.filter((x) => x.kind === "custom" && x.payload && x.payload.type === "task.phase");
        const phStrip = phEvts.length
          ? ' · <span class="st-chip" title="' + esc(phEvts.map((x) => x.payload.phase + (x.payload.skip ? "(跳)" : "") + (x.payload.auto ? "(自动推进:板含内容节点,阶段门 auto-advanced)" : "") + (x.payload.note ? ":" + String(x.payload.note).slice(0, 40) : "")).join(" → ")) + '">阶段<b>' + phEvts.map((x) => ({ understand: "理", plan: "规", implement: "施", verify: "验", close: "完" }[x.payload.phase] || "?") + (x.payload.skip ? "跳" : x.payload.auto ? "自" : "")).join("→") + '</b></span>'
          : "";
        parts.push(gate('<div class="task-sub">' + t + (ev.kind === "task.done" ? "完成" : isCancel ? "已取消" : "失败") + ' · ' + esc((ev.payload.id || "").slice(0, 8)) + phStrip +
        (tr ? ' · <span class="st-chip" title="累计=本会话全部 LLM 调用 in+out 求和(每轮历史重复计入),≠当前上下文容量(见输入区「上下文」pill)">轮<b>' + tr.turns + '</b>·LLM<b>' + tr.llmCalls + '</b>·工具<b>' + tr.toolCalls + '</b>·累计tok<b>' + tr.tokens.total + '</b>·' + Math.round(tr.llmMs / 1000) + 's</span>' : "") + durTxt + pqChip +
 // 设计白板入口:该任务有 board.update 事件→chip 直达白板视图
        (histEvents.some((x) => x.kind === "board.update" && x.payload && x.payload.taskId === ev.payload.id)
          ? '<button class="board-chip" data-board-task="' + esc(String(ev.payload.id || "")) + '">白板</button>' : "") + '</div>'));
 // fixG4:重启收编的取消任务出「因网关重启中断」系统行+「重发」按钮(复用 err-banner 通道形态;
 // 绑定在渲染尾部动作区,data-act=resend-cancel 按任务 id 取回原任务书回填重发)。老文案「gateway 重启中断(恢复收编)」同识别。
 // 新版清算= interrupted 态(task.progress payload.state=interrupted),
 // 「续跑」直接走 task.resume 服务端幂等重提;legacy cancelled 仍走客户端回填重发。
      if (isCancel && ev.payload && /重启中断/.test(String(ev.payload.result || ""))) {
        const rid = String(ev.payload.id || "");
        parts.push(gate('<div class="err-banner">任务因网关重启中断,未跑完(会话与已完成产出仍在;可重发续跑)。<div class="btns"><button data-act="resend-cancel" data-task="' + esc(rid) + '">重发</button></div></div>'));
      }
      if (ev.kind === "task.progress" && ev.payload && ev.payload.state === "interrupted") {
        const rid = String(ev.payload.id || "");
        parts.push(gate('<div class="err-banner" style="border-color:var(--warn);color:var(--warn)">任务被网关重启打断(外因中断,非取消;回执:' + esc(String(ev.payload.result || "").slice(0, 120)) + ')。<div class="btns"><button data-act="resume-int" data-task="' + esc(rid) + '">续跑</button></div></div>'));
      }
 // fixT7:失败原因可见化+人话(用户用户反馈:LLM 404 model_not_found 裸 JSON 刷屏且无引导)。
 // task.fail.result 承载错误全文;model_not_found/401/timeout 等转人话+一键跳模型管理。
      if (ev.kind === "task.fail" && ev.payload && ev.payload.result) {
        const ferr = String(ev.payload.result);
        let human = ferr.slice(0, 160);
        let action = "";
        if (/model_not_found|Model not exist/i.test(ferr)) { human = "所选模型在端点不存在(model_not_found)——大概率是模型目录里手填了端点不提供的模型名,或模型与端点错配。"; action = '<button class="board-chip" data-act="modelmgmt">去模型管理</button>'; }
        else if (/LLM 401|invalid.*api.?key|Unauthorized/i.test(ferr)) { human = "端点凭证无效(401)——检查 API key。"; action = '<button class="board-chip" data-act="modelmgmt">去模型管理</button>'; }
        else if (/LLM 429|rate.?limit/i.test(ferr)) human = "端点限流(429)——稍后重试或换模型。";
        else if (/MODEL_STREAM_IDLE_TIMEOUT|aborted/i.test(ferr)) human = "模型响应中断(空闲超时/取消)——可重试;大上下文任务建议先整理会话。";
        parts.push(gate('<div class="task-sub" style="color:var(--red,#e08a7a)">失败原因:' + esc(human) + " " + action + "</div>"));
      }
 // 内联变更条(ZCode change bar 对齐):diffstat 缓存命中才渲染;撤销走 checkpoint.rewind。
      const ds = diffstats.get(String(ev.payload.id || ""));
      if (ds && ds.total && ds.total.files > 0) {
        const tid0 = String(ev.payload.id || "");
        parts.push(gate('<div class="diffbar" data-task="' + esc(tid0) + '"><span class="files-link" data-act="files">' + ds.total.files + ' 个文件已更改</span> <span class="da">+' + ds.total.add + '</span> <span class="dd">-' + ds.total.del + "</span>" +
          '<button data-act="undo" data-task="' + esc(tid0) + '">撤销</button></div>'));
 // 内联文件清单( F1):点击「N 个文件已更改」就地展开,点文件→右侧抽屉出补丁。
        if (diffOpenTask === tid0) {
          parts.push(gate('<div class="filelist">' + ds.files.map((f) => '<div class="fl-row' + (ddSel && ddSel.taskId === tid0 && ddSel.file === f.path ? " on" : "") + '" data-task="' + esc(tid0) + '" data-file="' + esc(f.path) + '"><span class="fl-path">' + esc(f.path) + '</span><span class="da">+' + f.add + '</span><span class="dd">-' + f.del + "</span></div>").join("") + "</div>"));
        }
      }
    }
  }
  flushGrp();
  traceFlush(); // 聚合缓冲收尾(循环内遇到非轨迹事件会先落盘;末段残留在此落地)
  if (stStream && stStream.sid === currentSid) {
    if (stStream.reasoning && settings.thinking === "on" && !office)
      parts.push('<details class="think-card think-live" open><summary>思考 · 生成中</summary><div class="th-body">' + sketchifyHtml(esc(stStream.reasoning.slice(0, 4000))) + "</div></details>");
    if (stStream.text) parts.push('<div class="task-reply">' + mdToHtml(scrubProtocolLines(stStream.text), q) + (stStream.done ? "" : '<span class="st-cursor"></span>') + "</div>");
 // fixH18(渲染官 H):流式工具行吃图标+人话动词(与结算卡同语言;name 保留在 title 里可悬浮查看)
    for (const t of stStream.tools) {
      const m = toolMetaOf(t.name);
      parts.push('<div class="st-tool' + (t.running ? " run" : "") + '"><span class="st-tool-dot"></span>' +
        (m ? '<span class="tc-ic" style="width:11px;height:11px">' + ic(m.i) + "</span>" : "") +
        "<span" + (m ? ' title="' + esc(t.name) + '"' : "") + ">" + esc(m ? m.v : t.name) + "</span>" +
        '<span class="st-tool-state">' + (t.running ? (t.note ? esc(t.note) : "执行中") : "完成 · " + (t.durationMs || 0) + "ms") + "</span></div>");
    }
  }
  const cur = [...tasks.values()].find((x) => x.sessionId === currentSid && ["queued", "running"].includes(x.state));
  if (cur) parts.push('<div class="task-sub"><span class="st ' + cur.state + '">' + cur.state + '</span> 运行中,实时刷新…' + (cur.startedAt ? ' · 已工作 ' + fmtDur(Date.now() - cur.startedAt) : "") + "</div>");
 // fixI15: 排队消息卡(队列顺序=发送顺序;每卡三按钮:立即发送/编辑/删除)。
  for (const qi of (queueBySid.get(currentSid) || [])) {
    parts.push('<div class="qm-card" data-qid="' + esc(qi.id) + '">' + ic("clock", "qm-clock") + '<div class="qm-body">'
      + '<span class="qm-tag">排队中 · 当前任务完成后自动发送</span>'
      + '<div class="qm-txt">' + esc(String(qi.instruction || "")) + "</div>"
      + '<div class="qm-acts"><button class="qm-now" data-act="now">立即发送</button><button data-act="edit">编辑</button><button data-act="del">删除</button></div>'
      + "</div></div>");
  }
 // fixQ:并发满时 TaskSupervisor 层
 // 的 queued 任务此前聊天窗零渲染——query 像是「消失/卡住」。渲染为用户消息形态的排队卡(复用
 // .qm-card 视觉);正文走 task.detail 按需拉(索引只有 40 字 title,回包后重渲全文;只在缺正文时
 // 挂 waiter,同步回调路径不触发=零重入)。与 fixI15 会话队列卡语义不同并存:那是「忙等自动发送」,
 // 这是「已接收等并发槽位」。
  for (const qt of [...tasks.values()].filter((x) => x.sessionId === currentSid && x.state === "queued")) {
    const hasBody = taskBodyIds.has(qt.id);
    const txt = hasBody ? String(qt.instruction || qt.title || "") : String(qt.title || "");
    if (!hasBody) withTaskDetail(qt.id, () => { try { renderHistory(); } catch (e) { /* 重渲失败不影响主链 */ } });
    parts.push('<div class="qm-card tq-task" data-tid="' + esc(qt.id) + '">' + ic("clock", "qm-clock") + '<div class="qm-body">'
      + '<span class="qm-tag">已接收 · 排队中(等待并发槽位,自动开始)</span>'
      + '<div class="qm-txt">' + esc(txt) + "</div>"
      + "</div></div>");
  }
 // fixT6:错误横幅落位流尾(遍历后推入,见上方 errHtml 说明)
  if (errHtml) parts.push(errHtml);
  };
 // fixE22:大会话首帧双趟——①骨架趟(全占位,毫秒级)只数出总段数;②按 n-N 定窗后真趟只生成窗口段。
 // 小会话(≤MF_EVT_BIG 事件)/查找态单趟全量(wLo=0)=完全旧路径。窗口此后只在「上翻扩展」时变化,
 // 流式追加/轮询重渲沿用同一窗口(mfPatch 增量对位,窗口段外恒占位=串相等=零 DOM 动作)。
  if (mfWinSk && Array.isArray(histEvents) && histEvents.length > MF_EVT_BIG) {
    wLo = Number.POSITIVE_INFINITY;
    turnSeq = 0; turnOutcome = new Map();
    buildParts();
    const nAll = parts.length;
    parts.length = 0;
    wLo = Math.max(0, nAll - MF_WIN_N);
    turnSeq = 0; turnOutcome = new Map();
  }
  buildParts();
  mfWinLo = wLo;
  mfWinSk = false;
 // 顶部哨兵(fixE22):上方还有更老的段——点击或滚动接近顶部自动扩展(winExtend);
 // 哨兵自身入 parts(占 DOM 第 0 位),文本含剩余段数=扩展时 mfPatch 自然替换。
  if (mfWinLo > 0) parts.unshift('<div class="win-sent" data-ws-top="1">↑ 加载更早 · 上方还有 ' + mfWinLo + ' 段(滚动到顶自动展开)</div>');
 // 历史分页入口:首屏只取了末 HIST_PAGE 条,更早事件在服务端 — 仅在 hasMore 时显示。
 // 落 parts 第 0 位(历史最上方);「加载中…」文案防止连点重入,回包后由 renderHistory 恢复/隐藏。
  if (histHasMore === true) parts.unshift('<div class="hist-more" data-hist-more="1">' + (histPageLoading ? "加载中…" : "加载更多历史") + '</div>');
 // 板 n3压缩进行时行:在途时流尾追加一条(带发起时刻),终态帧清标记后自然消失。
  if (compactInflight) {
    parts.push('<div class="sys-line compression-inflight">'
      + '<span class="ev-time">' + new Date(compactInflight.at).toLocaleTimeString() + "</span>"
      + "正在压缩上下文…</div>");
  }
 // T1 幂等(视频拆解):task.list 全量广播(含他山会话)每经 renderChat→renderHistory 都
 // 全量重写 chatBody,单帧重绘=问候区「周期性跳动」(帧差经验证 30s 抖 438 节点)。内容未变=不写。
  const html = parts.length ? parts.join("") : '<div class="empty-line">' + ic("inbox") + " 该会话暂无记录</div>" + firstRunCardHtml();
  if (html === histLastHtml) return;
  histLastHtml = html;
 // 增量写入(滚动稳定):与上一帧 parts 做公共前缀+后缀对位,只替换差异区间——
 // 未变节点身份存活(展开态/滚动参照/已出图内容全保),整列 innerHTML 重建的抖动源消除;
 // 任何异常回落整列 innerHTML 写入(退化=旧行为,不劣化)。
  const mfBody = $("chatBody");
  let mfRoots = null;
  let mfAppendOnly = false;
  const mfOld = histLastParts && histLastParts.length === mfBody.children.length ? histLastParts : null;
  if (mfOld) {
    try {
      const r = mfPatch(mfBody, mfOld, parts);
      mfRoots = r.roots;
      mfAppendOnly = r.appendedOnly;
    } catch (e) { mfRoots = null; }
  }
  if (!mfRoots) {
    mfCaptureOpenAll(mfBody); // 整列重建:先把开合态按 key 收进总账(与序号解耦)
    mfBody.innerHTML = html;
    mfRoots = [...mfBody.children];
    for (const r of mfRoots) detBindIn(r); // 重建后按总账回填 open(用户点开的卡不会自己关上)
  }
  histLastParts = parts.slice();
 // :新消息入场微动效——仅 mfPatch 纯追加路径的新根挂 .msg-in(淡入+上浮一次);
 // 全量重建(初开/回放)与替换区(流式改写)不加,防整列/连播闪烁;082 幂等早退在上,不受影响。
  if (mfAppendOnly) for (const el of mfRoots) el.classList.add("msg-in");
 // mermaid 围栏懒加载出图(改版):innerHTML 落位后 mmRenderIn 扫占位→按需注入脚本→run/降级
  for (const root of mfRoots) mmRenderIn(root);
  for (const root of mfRoots) artRenderIn(root); // html/svg 图卡挂载(与 mermaid 同钩子)
 // 子代理过程卡开合意图(B):记录用户手动开合,轮询重渲染后据此恢复(运行中缺省展开在卡 HTML 生成侧)
  for (const d of mfQA(mfRoots, "details.sub-card")) {
    const k = d.dataset.agent || "";
    d.addEventListener("toggle", () => { subCardUser.set(k, d.open); });
  }
  renderSubDir(); // 子代理目录角标常更新;抽屉开着时随 journal 增量(终态事件等)同步刷新
 // 错误横幅动作
  const retryBtn = mfQA(mfRoots, ".err-banner button[data-act=retry]")[0];
  if (retryBtn) retryBtn.onclick = () => {
 // 索引条目无 instruction → 走 withTaskDetail 按需取正文(未到位先提示,不空提交)。
    const fid = (failed && failed.id) || "";
    if (!fid) return;
    withTaskDetail(fid, (tk) => {
      if (!tk || !tk.instruction) { toast("任务详情加载中,请稍后再点重试", true); return; }
      $("instruction").value = tk.instruction; submit(undefined, tk.projectId || undefined);
    });
  };
 // fixG4:重启中断任务的「重发」——按 data-task 取回被收编任务的原任务书回填并提交(与 err-banner retry 同通道语义)。
  for (const rb of mfQA(mfRoots, '.err-banner button[data-act="resend-cancel"]')) {
    rb.onclick = () => {
 // 索引条目无正文 → 按需拉 task.detail(正文到位后回填并提交)。
      const tid = String(rb.dataset.task || "");
      if (!tid) { toast("该任务没有可重发的内容", true); return; }
      withTaskDetail(tid, (tk) => {
        const ins = String((tk && tk.instruction) || "");
        if (!ins) { toast("任务详情加载中,请稍后再点重发", true); return; }
        $("instruction").value = ins; submit(undefined, (tk && tk.projectId) || undefined);
      });
    };
  }
 // interrupted「续跑」:服务端幂等重提(resume:<原id>),不回填 composer——同会话继续。
  for (const rb of mfQA(mfRoots, '.err-banner button[data-act="resume-int"]')) {
    rb.onclick = () => {
      const tid = String(rb.dataset.task || "");
      if (!tid) return;
      wsSafeSend(JSON.stringify({ v: 1, type: "task.resume", taskId: tid }));
      toast("已发起续跑(同会话继续)");
    };
  }
 // LLM 调用速览行——点击复制轨迹文件路径(system 提示词/请求响应全文在文件里)。
  for (const tl of mfQA(mfRoots, ".llm-trace-line[data-trace-file]")) {
    tl.onclick = () => {
      const p = String(tl.dataset.traceFile || "");
      if (!p) return;
      navigator.clipboard.writeText(p).then(() => toast("轨迹文件路径已复制:" + p.slice(-60)), () => toast(p, false));
    };
  }
  const copyBtn = mfQA(mfRoots, ".err-banner button[data-act=copy]")[0];
  if (copyBtn) copyBtn.onclick = () => {
 // result 属正文,按需取;无正文时给空串兜底(不写 "undefined")。
    const fid = failed && failed.id;
    withTaskDetail(fid, (full) => { navigator.clipboard && navigator.clipboard.writeText(String((full && full.result) || "")); });
  };
 // fixT7:「去模型管理」直达(model_not_found/401 类错误的引导出口)
  const mgmtBtn = mfQA(mfRoots, ".err-banner button[data-act=modelmgmt]")[0];
  if (mgmtBtn) mgmtBtn.onclick = () => { switchView("sys"); setSection("model"); };
 // 变更条动作:文件清单=alert;撤销=确认后 checkpoint.rewind(预览先行语义由 diffstat 清单承担)。
  for (const b of mfQA(mfRoots, ".diffbar [data-act]")) {
    b.onclick = () => {
      const barEl = b.closest(".diffbar");
      const taskId = (b.dataset.task || (barEl ? barEl.dataset.task : "")) || "";
      const ds = diffstats.get(taskId);
      if (!ds) return;
      if (b.dataset.act === "files") {
 // F1:不再弹窗——就地展开文件清单(点击某文件→右侧抽屉展示补丁)。
        diffOpenTask = diffOpenTask === taskId ? null : taskId;
        renderHistory();
        return;
      }
      const NL5 = String.fromCharCode(10);
      uiConfirm("撤销此任务的全部文件更改?将恢复 " + ds.total.files + " 个文件到任务前:" + NL5 + ds.files.slice(0, 8).map((f) => f.path).join(NL5) + (ds.files.length > 8 ? NL5 + "…" : "") + NL5 + "(快照后新增的未跟踪文件保留)", { tone: "danger" }).then((okUndo) => {
        if (okUndo) { wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.rewind", taskId })); toast("回滚已下发…"); }
      });
    };
  }
 // 文件清单行点击 → 右侧 diff 抽屉( F1)。
  for (const r of mfQA(mfRoots, ".fl-row")) {
    r.onclick = () => ddOpen(r.dataset.task, r.dataset.file);
  }
 // 设计白板 chip:任务卡/白板更新行 → 直达白板视图对应任务的板。
 // 画布形态下走 boardEntryGo 分流——定位画布白板卡,不弹浮窗。
  for (const bc of mfQA(mfRoots, ".board-chip")) {
    bc.onclick = () => {
      if (bc.dataset.act === "modelmgmt") { switchView("sys"); setSection("model"); return; } // fixT7:结算行里的模型管理直达
      boardEntryGo(bc.dataset.boardTask || "");
    };
  }
  for (const b of mfQA(mfRoots, ".msg-acts button")) {
    b.onclick = () => {
      const text = b.dataset.text || "";
      if (b.dataset.act === "side") sideToSuper("主线我的消息", text);
      else editResend(text);
    };
  }
 // fixI16: 排队卡三按钮——立即发送(抢占)/编辑(回填 composer+删除原项)/删除。
  for (const b of mfQA(mfRoots, ".qm-card .qm-acts button")) {
    b.onclick = () => {
      const card = b.closest(".qm-card");
      const qid = card ? card.dataset.qid : "";
      const qi = (queueBySid.get(currentSid) || []).find((x) => x.id === qid);
      if (!qid || !qi) return;
      if (b.dataset.act === "now") { wsSafeSend(JSON.stringify({ v: 1, type: "queue.dispatch.now", sessionId: currentSid, itemId: qid })); toast("已抢占发送:停止当前任务并立即执行该消息"); }
      else if (b.dataset.act === "edit") {
        wsSafeSend(JSON.stringify({ v: 1, type: "queue.remove", sessionId: currentSid, itemId: qid }));
        $("instruction").value = String(qi.instruction || "");
        autoGrow(); saveDraft(); $("instruction").focus();
        toast("已回填到输入框,修改后重新发送");
      }
      else wsSafeSend(JSON.stringify({ v: 1, type: "queue.remove", sessionId: currentSid, itemId: qid }));
    };
  }
  buildTurnNav(turnSeq); // innerHTML 落位后构建(此前读旧 DOM,单次渲染下导航条空——顺序 bug)
 // 查找跳转
  if (q) {
    const marks = $("chatBody").querySelectorAll("mark");
    $("findCount").textContent = marks.length + " 处";
    if (marks.length && findIdx >= marks.length) findIdx = 0;
    if (marks[findIdx]) marks[findIdx].scrollIntoView({ block: "center" });
  } else $("findCount").textContent = "";
 // 滚动恢复(重构):①落底窗/贴底→跟随最新;②纯尾部追加→绝不触碰 scrollTop
 // (阅读位置与滚动手势神圣:向上翻阅后新消息只在底部追加,不拽不顶);③其余(中部/整列变化)→
 // 元素锚回贴(视口顶首个可见块的新位置-原相对偏移),上方高度增减不再平移可视内容。
 // fixE22:窗口扩展帧——上方占位换真内容,按扩展前后 scrollHeight 差回补 scrollTop(视口钉在原内容上,
 // 不钉哨兵:哨兵文本含剩余段数,扩展帧字符串必变,锚不可靠)。
  if (vt && mfWinShiftFrom >= 0) {
    vt.scrollTop = vt.scrollTop + (vt.scrollHeight - mfWinShiftFrom);
    mfWinShiftFrom = -1;
  } else
  if (vt && !q) {
    if (histLanding && Date.now() < histLanding) vt.scrollTop = vt.scrollHeight; // 落底宽窗内:每次渲染贴底(history 分块到达)
    else if (wasBottom) vt.scrollTop = vt.scrollHeight;
    else if (mfAppendOnly) { /* 纯追加:不动滚动 */ }
    else {
      const el2 = anchorEl && anchorEl.isConnected ? anchorEl : (anchorIdx >= 0 ? mfBody.children[anchorIdx] : null);
      if (el2) {
        const d = el2.getBoundingClientRect().top - vt.getBoundingClientRect().top;
        vt.scrollTop = vt.scrollTop + (d - anchorOff);
      } else vt.scrollTop = keepTop;
    }
  }
  renderPendingSkills(); // 会话路径也要重挂(审计 C5:此前只有草稿 renderChat 重挂,会话视图重建即丢占位)
}

function renderChat() {
  if (currentSid) { renderHistory(); return; }
 // 草稿态(ZCode startDraft: activeTaskId=null → 空会话+composer):中央不倒任务史,历史只活在侧栏
  histLastHtml = null; // 直写分支:缓存失效
  histLastParts = null; // 直写分支:增量对位缓存一并失效
 // (块4·4.2):时段问候档位边界 [5,9,12,14,18,23](5-9 早晨/9-12 上午/12-14 午间/14-18 下午/18-23 晚间)
 // (ref ConversationDraftEmptyState.tsx:14,26-34)——本仓原 22 点即进深夜,ref 18-23 都算「晚上」,
 // 23 点起才进深夜;文案按 ref zh-CN.ts:4221-4226 口语化风格重写六档(原「深夜/清晨/早上/…」单词式退役)。
  const _h = new Date().getHours();
  const _p = _h >= 5 && _h < 9 ? '早上好呀,新的一天开始啦' : _h >= 9 && _h < 12 ? '上午好呀,有什么想让我帮忙的吗'
    : _h >= 12 && _h < 14 ? '中午好呀,要不要先休息一下' : _h >= 14 && _h < 18 ? '下午好呀,接下来交给我吧'
    : _h >= 18 && _h < 23 ? '晚上好呀,今天辛苦啦' : '夜深啦,别忘了照顾好自己哦'; // >=23 或 <5 = 深夜档(ref 边界:23 点起)
 // (块4·4.3):「新会话」占位标题行(ref events.ts:624:标题生成前侧栏显 New session)——
 // 本仓无 LLM 标题轨,占位只出现在草稿欢迎态头部(新会话尚未首发);首发即 deriveTitle 派生真标题
 // (renderHistory 整块替换本 HTML),占位随之消失,不存在「闪 New session」窗口。保留「说点什么」副行。
  $("chatBody").innerHTML = '<div class="draft-newtitle">新 会 话</div><div class="draft-greet">' + _p + '</div><div class="empty-line">说 点 什 么</div>';
  renderPendingSkills(); // 草稿路径也要重挂
}
function render(chatTouched = true) {
  const list = [...tasks.values()];
  const count = (s) => list.filter((t) => t.state === s).length;
  $("c-running").textContent = count("running");
  $("c-queued").textContent = count("queued");
  $("c-done").textContent = count("done");
  $("c-failed").textContent = count("failed") + count("cancelled");
  const active = count("running") + count("queued");
  $("aff-bar").style.width = (list.length ? (count("done") / list.length) * 100 : 0) + "%";
  $("aff-stage").textContent = active > 0 ? "执行中 ×" + active : (list.length ? "就绪" : "空闲");
  renderSidebar();
 // fixT6:任务态变化(task.list 广播)即时刷新置顶条——否则失败 chip 要等下一次 3s session.status 轮询才亮
  renderStatusbar();
 // T2:他山任务广播(chatTouched=false)不重建聊天区——renderChat→renderHistory 全量重写是闪烁根因
  if (chatTouched) renderChat();
  renderSendBtn();
  tickWorkTimer();
  try { cvStatusRefresh(); } catch (e) { /* 状态点失败不影响渲染 */ }
}
$("expDistillBtn").onclick = () => {
  if (!currentSid) return;
  wsSafeSend(JSON.stringify({ v: 1, type: "exp.distill", sessionId: currentSid }));
  toast("沉淀中…(会话最近任务 → 经验库)");
};
// 会话状态条(B3:todo/子代理/workflow;session.status 轮询消费)
/** 会话内最近一次任务(按创建时序;同刻回退 updatedAt)。
 * 修复:失败 chip/横幅此前取「最新的失败任务」——失败后用户再发一轮并正常完成,
 * 找不到更新的失败任务,旧失败就永远命中,置顶条一直挂着「失败 · 详见流尾」(用户用户反馈)。
 * 失败提示应表达「最近一次任务失败了」,而非「历史上曾失败过」:新任务一提交即让位。 */
function latestTaskOf(sessionId) {
  let best = null;
  for (const x of tasks.values()) {
    if (!sessionId || x.sessionId !== sessionId) continue;
    if (!best) { best = x; continue; }
    const a = Number(x.createdAt || x.updatedAt || 0), b = Number(best.createdAt || best.updatedAt || 0);
    if (a >= b) best = x;
  }
  return best;
}
/** 重试条(batch1b,阈值门照设计参考 ZCode(致谢) ConversationTurnGroup:前两次重试静默不打扰)。
 * 数据源=apiRetryBySid(服务端 gateway 内存镜像经 session.status.result 回填)——切走会话再回来
 * 仍能恢复同一条,不从 1 重来也不消失。文案「重新连接中... {attempt}/{maxRetries}」+ 有 errorStatus
 * 时追加「· HTTP xxx」。attempt≤2 或字段缺失=不渲染。 */
function apiRetryChip(sid) {
  const r = sid ? apiRetryBySid[sid] : null;
  if (!r) return "";
  const attempt = Number(r.attempt) || 0;
  if (attempt <= 2) return ""; // 前两次重试静默(用户不被打扰)
  const max = Number(r.maxRetries) || 0;
  const http = Number(r.errorStatus) || 0;
  const txt = "重新连接中... " + attempt + "/" + max + (http ? " · HTTP " + http : "");
  const tip = "模型请求失败,正在自动重试(第 " + attempt + " 次" + (max ? " / 上限 " + max + " 次" : "") + "):" + String(r.error || "");
  return '<span class="st-chip st-retry" id="retryChip" title="' + esc(tip) + '">' + esc(txt) + "</span>";
}
function renderStatusbar() {
  const bar = $("chatStatusbar");
 // fixT6 P1:失败提示钉在常驻状态条(footer .aff-strip,不随消息滚动)。
 // 原置顶条(#chatTopbar)已删——它空着也占灰线、chips 一多就折行把消息顶得上下晃;
 // chips 迁 footer 后恒在视口、单行不折,失败/重试入口同样常驻。
  const failedChip = (() => {
    if (!currentSid) return "";
    const f = latestTaskOf(currentSid);
    if (!f || f.state !== "failed") return "";
 // 索引条目 result 需按需拉(task.detail.get);未到位时 tooltip 显示「加载中…
    ensureTaskDetail(f.id);
    const fRes = taskBodyIds.has(f.id) ? String(f.result || "") : "加载中…";
    return '<span class="st-chip st-err" id="errChip" title="' + esc("任务失败:" + fRes) + '">失败 <b>' + esc(String(f.id || "").slice(0, 8)) + " · 详见流尾</b></span>";
  })();
  const retryChip = apiRetryChip(currentSid); // 重试条与失败条同在置顶条(切会话恢复;无重试态=空串零变化)
  if (!currentSid || !sessionStatus) { bar.innerHTML = failedChip + retryChip; return; }
  const st = sessionStatus;
  let html = failedChip + retryChip;
  if (st.todo && settings.showTodo === "on") {
    const items = st.todo.items || [];
    html += '<span class="st-chip" id="todoChip" title="点击展开">清单 <b>' + st.todo.completed + "/" + st.todo.total + "</b></span>";
    if (todoOpen) {
      html += '<div class="todo-pop">' + items.map((it) =>
        '<div class="ti ' + (it.status === "completed" ? "done" : it.status === "in_progress" ? "cur" : "") + '"><span>' +
        (it.status === "completed" ? ic("check", "ok") : it.status === "in_progress" ? ic("arrow-right", "run-ic") : ic("dot", "mut")) + "</span><span>" + esc(it.content) + "</span></div>").join("") + "</div>";
    }
  }
  if (st.subagents && st.subagents.spawnCount > 0) html += '<span class="st-chip">子代理 <b>' + st.subagents.spawnCount + "</b>(运行 " + st.subagents.running + ")</span>";
  if (st.compactions && st.compactions.length) {
 // 板 n7:压缩计数 chip 带 title —— 最近一次压缩的时间 + 摘要字数 + tokens 水位
 // (投影 compactions 项为 {at,tokens?,summaryChars?};字段缺失则省略对应段,不写「undefined」)。
    const lc = st.compactions[st.compactions.length - 1] || {};
    const lcTk = function (n) { return (Math.round(Number(n) / 100) / 10).toFixed(1) + "k"; };
    const lcParts = [];
    if (lc.at) lcParts.push("最近 " + new Date(Number(lc.at)).toLocaleString());
    if (lc.summaryChars) lcParts.push("摘要 " + Number(lc.summaryChars) + " 字");
    if (lc.tokensBefore && lc.tokensAfter) lcParts.push("≈" + lcTk(lc.tokensBefore) + " → " + lcTk(lc.tokensAfter) + " tok");
    else if (lc.tokens) lcParts.push("≈" + lcTk(lc.tokens) + " tok");
    const lcTitle = lcParts.length ? "上下文已压缩:" + lcParts.join(" · ") : "上下文已压缩(F1 投影)";
    html += '<span class="st-chip" title="' + esc(lcTitle) + '">压缩 <b>' + st.compactions.length + "</b></span>";
  }
    for (const w of (st.workflows || [])) html += '<span class="st-chip">wf ' + esc(w.wfId.slice(0, 8)) + (w.done ? " " + ic("check", "ok") : " 问" + w.asks) + "</span>";
  bar.innerHTML = html;
  const chipEl = $("todoChip");
  if (chipEl) chipEl.onclick = () => { todoOpen = !todoOpen; renderStatusbar(); };
 // fixT6:失败 chip 点击=滚到流尾看详情(与「回到底部」同一落点;横幅仍在流尾,chip 只是常驻入口)
  const errEl = $("errChip");
  if (errEl) errEl.onclick = () => { const vt = $("view-tasks"); if (vt) vt.scrollTo({ top: vt.scrollHeight, behavior: "smooth" }); };
}
let todoOpen = false;
setInterval(() => {
  if (currentSid && viewLive("chat")) {
    ssSendStatus(currentSid);
  }
}, 3000);

// ── 子智能体目录(ZCode SubagentDirectory 对齐) ──
// 两区(运行中/已结束)+条目下钻(任务书全文/实时 tail/当前模型)。数据源双轨:
// ①journal 事件(subagent.spawn/result/backgrounded + task_output 轮询对)——全程可得,历史会话重放同源;
// ②sessionStatus.subagentList(注册表在场时)——权威实时状态/tail/title/model。
// 注册表缺席且 journal 无终态=「已结束 · 历史会话」(诚实标注,不假做运行态)。
let subDirOpen = false;
// 「终止」在飞集合(防双击/防 3s 重渲染重置按钮态;send 在下方事件委托)
const subCancelPending = new Set();
function subDirEntries() {
  const map = new Map(); // agentId → entry
  const events = Array.isArray(histEvents) ? histEvents : [];
  for (const e of events) {
    const p = e.payload || {};
    if (e.kind === "subagent.spawn") {
      const aid = String(p.agentId || "");
      if (!aid) continue;
      map.set(aid, { agentId: aid, title: String(p.title || ""), instructions: String(p.instructions || ""), time: e.time || 0, sessionId: String(e.sessionId || "") });
    } else if (e.kind === "subagent.result") {
      const aid = String(p.agentId || "");
      const en = aid ? map.get(aid) : null;
      if (!en) continue;
      en.endTime = e.time || 0;
      en.ok = !(p.event && p.event.ok === false);
      en.text = String((p.event && (p.event.finalText || p.event.note)) || "");
 // n3 融合:原分身卡独有「失败原因 reap」(watchdog/deadline/gateway-restart)——并入目录条目,
 // 与服务端 subagents.list 的 reap 字段同源(payload.reap.reason)。
      if (p.reap && p.reap.reason) en.reap = String(p.reap.reason);
    } else if (e.kind === "subagent.backgrounded") {
      const en = map.get(String(p.agentId || ""));
      if (en) en.bg = true;
    }
  }
  const sl = sessionStatus && sessionStatus.subagentList;
  if (Array.isArray(sl)) {
    for (const a of sl) {
      let en = map.get(String(a.agentId || ""));
      if (!en) { en = { agentId: String(a.agentId || ""), title: "", instructions: "", time: 0 }; map.set(en.agentId, en); }
      en.registry = true;
      en.status = String(a.status || "");
      en.tail = String(a.tail || "");
      if (a.title) en.title = String(a.title);
      en.model = String(a.model || "");
 // 并行线(G2)字段防御式摄取:deadline/heartbeatAt/stale/终止原因——有则带,无则目录照常渲染
      if (typeof a.deadline === "number") en.deadline = a.deadline;
      if (typeof a.heartbeatAt === "number") en.heartbeatAt = a.heartbeatAt;
      if (a.stale === true) en.stale = true;
      if (a.stopReason) en.stopReason = String(a.stopReason);
    }
  }
  const now = Date.now();
  for (const en of map.values()) {
    en.role = subagentRoleOf(en.instructions);
    const startAt = en.time || 0;
    if (en.endTime !== undefined) { en.cls = en.ok === false ? "fail" : "ok"; en.stTxt = en.ok === false ? "失败" : "完成"; if (startAt && en.endTime) en.durTxt = " · 用时 " + fmtDur(en.endTime - startAt); }
    else if (en.status === "completed") { en.cls = "ok"; en.stTxt = "完成"; }
    else if (en.status === "failed") { en.cls = "fail"; en.stTxt = "失败"; }
    else if (en.status === "running" || en.bg) { en.cls = "run"; en.stTxt = "后台运行中"; if (startAt) en.durTxt = " · 已工作 " + fmtDur(now - startAt); }
    else { en.cls = "end"; en.stTxt = "已结束 · 历史会话"; }
  }
  return [...map.values()];
}
function renderSubDir() {
  const btn = $("subDirBtn");
  if (!btn) return;
  const dir = subDirEntries();
  const runN = dir.filter((d) => d.cls === "run").length;
  const badge = $("subDirBadge");
  if (badge) { badge.style.display = runN > 0 ? "inline-block" : "none"; badge.textContent = String(runN); }
  btn.classList.toggle("live", runN > 0);
  renderWsTabbar(); // 工作区 tab 的状态点随目录数据(3s 轮询/终态事件)同步翻牌;空集合=整条隐藏
  if (!subDirOpen) return;
  const run = dir.filter((d) => d.cls === "run").sort((a, b) => (a.time || 0) - (b.time || 0));
  const done = dir.filter((d) => d.cls !== "run").sort((a, b) => (b.endTime || b.time || 0) - (a.endTime || a.time || 0));
  $("subDirSub").textContent = "运行 " + run.length + " · 已结束 " + done.length;
 // 3s 轮询重渲染会整表重建:开合态由 detOpen 总账按 data-det-key 兜住(renderSubDir 不再从 DOM 读 open 现值,
 // 那会在重建瞬间读到「刚被清空的空集」把用户的展开全吞掉)。
  const item = (en) => {
    let detail = "";
    if (en.model || en.registry) detail += '<div class="sd-model">模型:' + esc(en.model || "主模型") + (en.registry ? "" : " · 注册表缺席(历史会话,无实时输出)") + "</div>";
    if (en.stopReason) detail += '<div class="sd-model"><span class="sd-stale">终止:' + esc(en.stopReason) + "</span></div>";
    if (en.instructions) detail += '<div class="sd-task">' + esc(en.instructions) + "</div>";
    if (en.cls === "run" && en.tail) detail += '<div class="sd-tail">' + esc(String(en.tail).slice(-1500)) + "</div>";
    else if (en.cls !== "run") {
 // 终态文本全文:注册表 tail 的 [result ...] 行是 output.txt 全文(journal 终态事件只带 300 字摘要),
 // 有 tail 用 tail,没有退回 journal 文本;都无=历史会话如实标注。展示全量,滚动容器承接。
      const full = subResultFullText(en) || String(en.text || "");
      if (full) detail += '<div class="sd-final">' + esc(full) + "</div>";
      else detail += '<div class="sd-tail">(历史会话或服务已重启:实时过程不可回放)</div>';
    }
 // 元信息行(ZCode 条目密度对齐):deadline 倒计时/心跳——并行线字段有则显示,无则整行缺席(防御式,不炸不占位)
    const now = Date.now();
    const meta = [];
    if (en.cls === "run") {
      if (typeof en.deadline === "number") { const left = en.deadline - now; meta.push('<span class="' + (left > 0 ? "" : "sd-stale") + '">' + (left > 0 ? "剩余 " + fmtDur(left) : "已超 deadline") + "</span>"); }
      if (typeof en.heartbeatAt === "number") { const age = Math.max(0, now - en.heartbeatAt); meta.push('<span class="' + (en.stale ? "sd-stale" : "") + '">' + (en.stale ? "心跳停滞 " : "心跳 ") + fmtDur(age) + (en.stale ? "" : "前") + "</span>"); }
      else if (en.stale) meta.push('<span class="sd-stale">心跳停滞</span>');
    }
    const cancelling = subCancelPending.has(en.agentId);
 // 收敛:条目主区域=一级入口(点击开/激活工作区 tab);「工作区」按钮被整行点击吸收删除,
 // 下钻(任务书全文/模型行/tail/终止原因)降级为「详情」轻展开钮——抽屉保留快速瞄一眼能力,不切走 tab。
    const moreBtn = '<button class="sd-open" data-submore="' + esc(en.agentId) + '" title="展开查看任务详情与实时输出">详情</button>';
    const cancelBtn = en.cls === "run"
      ? '<button class="sd-cancel" data-subcancel="' + esc(en.agentId) + '" title="终止该子 agent(发送取消指令)"' + (cancelling ? " disabled" : "") + ">" + (cancelling ? "终止中…" : "终止") + "</button>"
      : "";
    return '<details class="sd-item' + (subWsActive === en.agentId ? " ws-open" : "") + '" data-agent="' + esc(en.agentId) + '" data-det-key="' + esc("subdir:" + en.agentId) + '"' +
      '><summary title="打开该子代理的工作区 tab(任务详情/实时输出流/工具调用/状态)">' +
      '<span class="sd-dot ' + esc(en.cls) + '" style="background:' + subagentRoleColor(en.role) + '"></span>' +
      '<span class="sd-role">' + esc(subagentRoleName(en.role)) + '</span><span class="sd-label">' + esc(subagentLabelOf(en.title, en.instructions) || en.agentId.slice(-10)) + "</span>" +
      '<span class="sd-st ' + esc(en.cls) + '">' + esc(en.stTxt + (en.durTxt || "")) + "</span>" + moreBtn + cancelBtn +
      (meta.length ? '<span class="sd-meta2">' + meta.join("") + "</span>" : "") +
      '</summary><div class="sd-detail">' + detail + "</div></details>";
  };
  $("subDirBody").innerHTML =
    '<div class="sd-sec"><div class="sd-sec-h">运行中 · ' + run.length + "</div>" +
    (run.length ? run.map(item).join("") : '<div class="sd-empty">暂无运行中的子 agent</div>') + "</div>" +
    '<div class="sd-sec"><div class="sd-sec-h">已结束 · ' + done.length + "</div>" +
    (done.length ? done.map(item).join("") : '<div class="sd-empty">暂无已结束的子 agent</div>') + "</div>";
}
function subDirToggle(open) {
  subDirOpen = open === undefined ? !subDirOpen : !!open;
  $("subDir").classList.toggle("on", subDirOpen);
  if (subDirOpen) {
    renderSubDir();
    if (currentSid) ssSendStatus(currentSid); // 打开即拉一次最新注册表清单
  }
}
$("subDirBtn").onclick = () => subDirToggle();
$("subDirClose").onclick = () => subDirToggle(false);
// output.txt 的 result 全文行(零正则:页面模板禁反斜杠,反斜杠双写易错——indexOf 切片同义)
function subResultFullText(en) {
  const t = String((en && en.tail) || "");
  const ri = t.indexOf("[result ");
  if (ri < 0) return "";
  const rb = t.indexOf("] ", ri);
  return rb < 0 ? t.slice(ri) : t.slice(rb + 2);
}
// 「终止」按钮通路:subagent.cancel 最小消息;服务端调注册表条目的 cancel 句柄,
// 句柄缺席=ok:false 如实提示。pending 集合声明在 renderSubDir 上方(与其余目录状态同区)。
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("[data-subcancel]") : null;
  if (!btn) return;
  e.preventDefault(); // 按钮在 summary 内:拦掉 details 开合的默认动作
  const aid = btn.getAttribute("data-subcancel");
  if (!aid || subCancelPending.has(aid)) return;
  subCancelPending.add(aid);
  btn.disabled = true; btn.textContent = "终止中…";
  wsSafeSend(JSON.stringify({ v: 1, type: "subagent.cancel", agentId: aid }));
  toast("已发送终止指令:…" + esc(aid.slice(-8)));
});

// ── 子代理工作区 tab( 「点击其中运行的一个智能体后,要弹出它的工作区tab页,
// 显示它的所有动作和消息(就如vibe coding agent的工作区一样)」; 收敛:目录抽屉=一级入口,
// 点击条目主区域即开/激活本 tab,抽屉保留「详情」轻展开;过程卡「工作区」钮为消息流侧第二入口)──
// 形态:中间工作区顶部 tab 条(#wsTabbar)=「主会话」恒第一位不可关+每个打开的子代理工作区(状态点+标题+关闭)。
// tab 内全要素:头部=标题/状态/模型/任务书全文/journal 终态(运行中+注册表在场带「终止」),体=完整事件流+工具调用。
// 数据:进程内子代理的 loop 事件已由服务端以 subagent.event 入主 journal(payload={agentId,kind,…裁剪}),
// 本工作区按 agentId 过滤回放,渲染器复用主历史全套(思考卡/消息/工具卡);运行中实时增量复用既有通道:
// journal 广播 dashboard.changed(服务端 500ms 尾沿)→ 本地 1.5s 节流拉 session.history 增量(无 tab=零额外拉取)。
// 外部后端子代理(真实 dsh/zcode)无 loop 事件——降级为 output.txt 进度行时间线,如实标注形态差异,不造假消息。
// 持久:打开的 tab 集合按会话存 localStorage(zh:subws:<sid>);重开会话/刷新页面 tab 恢复,内容从 journal 重放重建。
let subWsActive = "";        // 激活的工作区 agentId(""=主会话)
let subWsSid = "";           // tab 集合所属会话(切会话时校正)
const subWsTabs = new Map(); // agentId → true(打开集合;标题/状态渲染时从 journal+注册表现取)
const subWsLimit = new Map(); // agentId → 可见事件数(渲染上限,「加载更多」递增)
let subWsLastHtml = null;    // 工作区渲染幂等缓存(切换/增量拉更多时置 null 强制重写)
let subWsPullAt = 0;         // dashboard.changed 触发拉史的节流水位
let subWsPullTimer = null;   // 节流窗内到达的广播→尾沿补拉(丢弃改延后:最后一条消息不会因落在 1.5s 窗内而丢失)
const SUB_WS_PAGE = 240;     // 渲染上限:默认只画最近 N 条,更早折叠进「加载更多」
function subWsStoreKey(sid) { return "zh:subws:" + sid; }
function subWsPersist() {
  if (!subWsSid) return;
  try { localStorage.setItem(subWsStoreKey(subWsSid), JSON.stringify([...subWsTabs.keys()])); } catch (e) { /* 存储失败不影响功能 */ }
}
function subWsRestore(sid) {
  subWsSid = String(sid || ""); subWsActive = ""; subWsTabs.clear(); subWsLimit.clear(); subWsLastHtml = null;
  try {
    const raw = localStorage.getItem(subWsStoreKey(subWsSid));
    if (raw) for (const aid of JSON.parse(raw) || []) if (aid) subWsTabs.set(String(aid), true);
  } catch (e) { /* 坏数据=空集合 */ }
  renderWsTabbar();
}
function subWsOpen(agentId) {
  const aid = String(agentId || "");
  if (!aid) return;
  subWsTabs.set(aid, true);
  subWsActive = aid;
  subWsLastHtml = null;
  subWsPersist();
  renderWsTabbar();
  renderHistory(); // 拦截层切到工作区渲染
}
function subWsClose(agentId) {
  subWsTabs.delete(String(agentId || ""));
  if (subWsActive === String(agentId || "")) subWsActive = "";
  subWsLastHtml = null;
  subWsPersist();
  renderWsTabbar();
  renderHistory();
}
function subWsActivate(agentId) {
  const aid = String(agentId || "");
  if (subWsActive === aid) return;
  subWsActive = aid;
  subWsLastHtml = null;
  renderWsTabbar();
  renderHistory();
}
function renderWsTabbar() {
  const bar = $("wsTabbar");
  if (!bar) return;
  const stByAgent = new Map(subDirEntries().map((en) => [en.agentId, en]));
  const chip = (aid, label, cls, closable) =>
    '<span class="ws-tab' + (subWsActive === aid ? " on" : "") + '" data-wstab="' + esc(aid) + '" title="' + (closable ? "子代理工作区:完整动作/消息流" : "主会话") + '">' +
    (cls ? '<span class="wt-dot ' + esc(cls) + '"></span>' : "") +
    '<span class="wt-label">' + esc(label) + "</span>" +
    (closable ? '<button class="wt-x" data-wsclose="' + esc(aid) + '" title="关闭工作区">×</button>' : "") +
    "</span>";
  const chips = [chip("", "主会话", "", false)];
  for (const aid of subWsTabs.keys()) {
    const en = stByAgent.get(aid);
    const label = (en && (subagentLabelOf(en.title, en.instructions) || en.agentId.slice(-8))) || aid.slice(-8);
    chips.push(chip(aid, label, (en && en.cls) || "end", true));
  }
  bar.innerHTML = chips.join("");
  bar.classList.toggle("on", subWsTabs.size > 0);
}
// tab 条/关闭/加载更多:一处委托(subDir 抽屉常驻重渲,summary 内按钮同样语义)
document.addEventListener("click", (e) => {
  const x = e.target && e.target.closest ? e.target.closest("[data-wsclose]") : null;
  if (x) { e.stopPropagation(); subWsClose(x.getAttribute("data-wsclose") || ""); return; }
  const more = e.target && e.target.closest ? e.target.closest("[data-wsmore]") : null;
  if (more) { const aid = more.getAttribute("data-wsmore") || ""; subWsLimit.set(aid, (subWsLimit.get(aid) || SUB_WS_PAGE) + 480); subWsLastHtml = null; renderHistory(); return; }
  const tab = e.target && e.target.closest ? e.target.closest("[data-wstab]") : null;
  if (tab) subWsActivate(tab.getAttribute("data-wstab") || "");
});
// 目录条目一级入口:点击条目主区域(summary,非按钮)=开/激活该子代理的工作区 tab 并 toast;
// 目录保持打开(目录=连续浏览多个子 agent 的索引,逐个点开不必重开抽屉);激活条目加 ws-open 描边。
// 「详情」钮=条目内轻展开(任务书全文/模型/tail),与开 tab 互不牵动。data-subws(过程卡按钮)仍走下方委托。
document.addEventListener("click", (e) => {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest("#subDirBody .sd-item summary button")) return; // 终止/详情各有委托,按钮不触发开 tab
  const sum = e.target.closest("#subDirBody .sd-item > summary");
  if (!sum) return;
  e.preventDefault(); // 条目开合默认动作让位:主区域点击语义=开工作区(下钻走「详情」钮)
  const item = sum.closest("details.sd-item");
  const aid = (item && item.getAttribute("data-agent")) || "";
  if (!aid) return;
 // 画布形态:目录条目点击=定位分身卡消息分组(工作区 tab 渲染进 chatBody,画布下不再进入)
  if (canvasActive() && subMsgLocate(aid)) return;
  subWsOpen(aid);
  toast("已打开子代理工作区:…" + esc(aid.slice(-8)));
});
// 「详情」轻展开:阻止 summary 默认开合,手动翻转 details(展开态由 openIds 跨 3s 轮询重渲染保持)
document.addEventListener("click", (e) => {
  const m = e.target && e.target.closest ? e.target.closest("[data-submore]") : null;
  if (!m) return;
  e.preventDefault();
  const item = m.closest("details.sd-item");
  if (item) item.open = !item.open;
});
// 过程卡「工作区」钮(消息流内就地开 tab;目录条目按钮已收敛进条目行点击,本委托继续承接卡内入口):
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("[data-subws]") : null;
  if (!btn) return;
  e.preventDefault(); // 按钮在 summary 内:拦掉 details 开合的默认动作
  const aid = btn.getAttribute("data-subws") || "";
 // 画布形态分身独立看板:条目点击=定位/展开子agent会话流卡里对应的消息分组(不开工作区 tab——
 // 工作区渲染进 chatBody,会把子代理内容又带回会话流卡,与独立看板口径冲突);经典布局保持开 tab。
  if (canvasActive() && subMsgLocate(aid)) return;
  subWsOpen(aid);
  toast("已打开子代理工作区:…" + esc(aid.slice(-8)));
});
// 工作区体渲染:头部(标题/状态/模型/任务书全文/终态)+事件流(复用主渲染器)+降级时间线。
function renderSubWorkspace(agentId) {
  const aid = String(agentId || "");
  const vt = $("view-tasks");
  const keepTop = vt ? vt.scrollTop : 0;
  const wasBottom = vt ? (vt.scrollHeight - vt.scrollTop - vt.clientHeight < 60) : true; // 粘底跟随,语义同主历史
  const q = findQuery;
  const all0 = Array.isArray(histEvents) ? histEvents : [];
  const en = subDirEntries().find((x) => x.agentId === aid);
  const all = all0.filter((e) => e.kind === "subagent.event" && String((e.payload || {}).agentId || "") === aid);
  const resEv = all0.filter((e) => e.kind === "subagent.result" && String((e.payload || {}).agentId || "") === aid);
  const parts = [];
 // 头部卡:标题/状态/角色/模型/任务书全文/journal 终态
  const title = (en && (subagentLabelOf(en.title, en.instructions) || "")) || "子代理 " + aid.slice(-8);
  const lastRes = resEv.length ? (resEv[resEv.length - 1].payload || {}) : null;
  const finalTxt = lastRes && lastRes.event ? String(lastRes.event.finalText || lastRes.event.note || "") : "";
  parts.push('<div class="ws-head"><div class="ws-title"><span class="wt-dot ' + esc((en && en.cls) || "end") + '"></span><span>' + esc(title) +
    '</span><span class="sd-st ' + esc((en && en.cls) || "end") + '">' + esc(en ? (en.stTxt || "") + (en.durTxt || "") : "已结束 · 历史会话") + "</span>" +
 // tab 完整性——终止按钮进工作区头部(运行中且注册表在场才渲染),复用 data-subcancel 全局委托
 // 与 subCancelPending 防双击;历史/外部后端条目不渲染(无处可发,不造假按钮)。
    ((en && en.cls === "run" && en.registry) ? '<button class="sd-cancel" data-subcancel="' + esc(aid) + '" title="终止该子 agent(发送取消指令)"' + (subCancelPending.has(aid) ? " disabled" : "") + ">" + (subCancelPending.has(aid) ? "终止中…" : "终止") + "</button>" : "") +
    "</div>" +
    '<div class="ws-meta"><span>角色:' + esc((en && en.role) || "worker") + '</span><span>模型:' + esc((en && en.model) || "主模型") + "</span>" +
    (en && en.registry ? "" : "<span>注册表缺席(历史会话)</span>") + "<span>事件 " + all.length + " 条</span>" +
    "<span>LLM 轨迹 " + all.filter((e2) => e2.payload && e2.payload.kind === "llm.trace").length + " 次</span></div>" +
    ((en && en.instructions) ? '<div class="ws-task">' + esc(en.instructions) + "</div>" : "") +
    (finalTxt ? '<div class="ws-final">' + esc(finalTxt) + "</div>" : "") +
    "</div>");
  if (all.length === 0) {
 // 降级:无 subagent.event(外部后端子代理/早期会话)——output.txt 进度行时间线(诚实标注形态差异)
    parts.push('<div class="ws-note">本子代理无结构化动作流(外部后端或早期会话):下方为 output.txt 进度行时间线;全程动作级回放仅进程内子代理可用。</div>');
    const lines = String((en && en.tail) || "").split(String.fromCharCode(10)).filter((l) => l.trim());
    parts.push(lines.length ? '<div class="ws-timeline">' + esc(lines.join(String.fromCharCode(10))) + "</div>"
      : '<div class="empty-line">(历史会话或服务已重启:实时过程不可回放)</div>');
  } else {
    const limit = subWsLimit.get(aid) || SUB_WS_PAGE;
    const omitted = Math.max(0, all.length - limit);
    if (omitted > 0) parts.push('<div class="ws-omitted"><span>已省略最早 ' + omitted + " 条(渲染上限 " + limit + ')</span><button data-wsmore="' + esc(aid) + '">加载更早 480 条</button></div>');
 // fixH17(渲染官 H):工作区同样吃统一合并卡——subagent.event 内 tool.result 按 toolCallId 预扫,
 // message.agent 的 toolCalls 渲染时直接带上结果(图标+动词+参数摘要+状态·耗时+专属结果体);
 // 已合并的 tool.result 不再单独出「返回」行+裸结果卡(去双卡)。tool.tokens 预扫补调(主路径 renderHistory
 // 在 subWsActive 早退,工作区进来时 tokByCall 尚未建——read_file 语义着色链路对齐)。
    toolTokensScan();
    const subResByCall = new Map();
    const subArgsByCall = new Map();
    for (const e2 of (omitted > 0 ? all.slice(-limit) : all)) {
      const p2 = e2.payload || {};
      if (p2.kind === "tool.call") { const cid = String(p2.toolCallId || ""); if (cid && !subResByCall.has(cid)) subArgsByCall.set(cid, String(p2.arguments || "")); }
      else if (p2.kind === "tool.result") { const cid = String(p2.toolCallId || ""); if (cid) subResByCall.set(cid, { name: String(p2.name || ""), content: String(p2.content || ""), durationMs: Number(p2.durationMs || 0) }); }
    }
    const subMerged = new Set();
    for (const ev of omitted > 0 ? all.slice(-limit) : all) {
      const p = ev.payload || {};
      const t = ev.time ? '<span class="ev-time">' + new Date(ev.time).toLocaleTimeString() + "</span>" : "";
      if (p.kind === "message.agent") {
        if (p.reasoning && settings.thinking === "on")
          parts.push('<details class="think-card"><summary>思考 · ' + Math.max(1, Math.round(Number(p.llmMs || 0) / 1000)) + 's</summary><div class="th-body">' + hl(esc(String(p.reasoning).slice(0, 4000)), q) + "</div></details>");
        if (p.text) parts.push('<div class="task-reply">' + mdToHtml(scrubProtocolLines(String(p.text)), q) + "</div>");
 // fixH17:统一合并卡(与主历史同渲染器;结果/参数按 callId 补全,tool.call 独立事件的参数也并进来)
        for (const c of Array.isArray(p.toolCalls) ? p.toolCalls : []) {
          const cid = String(c.id || "");
          const res2 = subResByCall.get(cid) || null;
          subMerged.add(cid);
          parts.push(toolCallCard(c, q, res2, toolTokensOfId(cid)));
        }
      } else if (p.kind === "tool.result") {
        if (subMerged.has(String(p.toolCallId || ""))) continue; // fixH17:合并卡已承载
        const a2 = subArgsByCall.get(String(p.toolCallId || "")) || "";
        const res2 = { content: String(p.content || ""), durationMs: Number(p.durationMs || 0) };
        parts.push(toolCallCard({ name: String(p.name || ""), arguments: a2 }, q, res2, toolTokensOfId(String(p.toolCallId || ""))));
      } else if (p.kind === "tool.call") {
        if (subMerged.has(String(p.toolCallId || ""))) continue; // fixH17:参数已被合并卡吃下
        parts.push('<div class="ws-step">' + t + "<b>" + esc(String(p.name || "工具")) + "</b><span>调用 " + esc(String(p.arguments || "").replace(/\\s+/g, " ").slice(0, 90)) + "</span></div>");
      } else if (p.kind === "step.start" || p.kind === "step.end") {
        const label = p.kind === "step.start" ? "第 " + p.step + " 步开始(模型思考中)"
          : "第 " + p.step + " 步结束(" + String(p.reason || "") + (p.error ? " · " + String(p.error).slice(0, 120) : "") + ")";
        parts.push('<div class="ws-step">' + t + "<b>step</b><span>" + esc(label) + "</span></div>");
      } else if (p.kind === "turn.start") {
        parts.push('<div class="ws-step">' + t + "<b>turn</b><span>第 " + esc(String(p.turn || "?")) + " 轮开始</span></div>");
      } else if (p.kind === "turn.end") {
        parts.push('<div class="ws-step">' + t + "<b>turn</b><span>结束(" + esc(String(p.reason || "")) + ")</span></div>");
      } else if (p.kind === "permission.gate") {
        parts.push('<div class="ws-step">' + t + "<b>权限</b><span>" + esc(String(p.tool || "")) + " " + esc(String(p.effect || "")) + "(" + esc(String(p.by || "")) + ")</span></div>");
      } else if (p.kind === "llm.trace") {
 // 与主会话同构的轨迹速览行:模型/轮步/耗时/token/构型;点击复制轨迹文件路径
 // (system 提示词与请求/响应全文在 .genie/llm-trace/subagent-<taskId>*/call-*.json)。
        const roles2 = Array.isArray(p.messageRoles) ? roleShape(p.messageRoles, 6) : "";
        const roleFull2 = Array.isArray(p.messageRoles) ? p.messageRoles.join("→") : "";
        const tcs2 = Array.isArray(p.toolCalls) ? p.toolCalls.slice(0, 4).join(",") + (p.toolCalls.length > 4 ? " +" + (p.toolCalls.length - 4) : "") : "";
        const u2 = p.usage || {};
        const i2 = Number(u2.inputTokens || 0), o2 = Number(u2.outputTokens || 0);
 // 与主会话同口径:命中率 = API cached/input;suspect 只加行尾徽标,数字不变。
        const c2 = Number(u2.cachedTokens || 0);
        const hit2 = i2 > 0 && c2 > 0 ? " · 命中 " + ((c2 / i2) * 100).toFixed(1) + "%" : "";
        const sus2 = p.usageSuspect
          ? '<span class="lt-sus" title="' + esc(String(p.usageAnomaly || "上游 usage 与本步输入不自洽")) + '">⚠</span>' : "";
        parts.push('<div class="task-sub llm-trace-line" data-trace-file="' + esc(String(p.file || "")) + '" title="' + esc(String(p.file || "") + (roleFull2 ? " · 消息构型 " + roleFull2 : "")) + '" style="cursor:pointer">' +
          '<span class="lt-main">' + ic("bolt") + " LLM t" + Number(p.turn || 0) + "s" + Number(p.step || 0) +
          " · " + esc(String(p.model || "?")) + " · " + fmtDur(Number(p.durationMs || 0)) +
          (i2 || o2 ? " · ↑" + i2 + " ↓" + o2 + hit2 : "") +
          (roles2 ? ' · <span class="lt-roles" title="消息构型 ' + esc(roleFull2) + '">[' + esc(roles2) + "]</span>" : "") +
          (tcs2 ? " · 调用:" + esc(tcs2) : "") +
          (p.error ? ' · <span style="color:var(--red)">' + esc(String(p.error).slice(0, 80)) + "</span>" : "") +
          '</span><span class="lt-copy">复制轨迹路径</span>' + sus2 + '</div>');
      } else if (p.kind === "message.user") {
 // 首条 message.user=任务书(头部 ws-task 已全文展示,不重复渲染);
 // 只渲染 [steer] 中途转向(修复:此前任务书也被当成「转向」渲染成 400 字截断行)。
        if (String(p.text || "").indexOf("[steer]") === 0)
          parts.push('<div class="user-line"><span class="who">转向</span><span class="txt">' + userSlashHtml(String(p.text || ""), "") + "</span></div>");
      } else {
        parts.push('<div class="ws-step">' + t + "<b>" + esc(String(p.kind || "event")) + "</b><span>" + esc(JSON.stringify(p).slice(0, 160)) + "</span></div>");
      }
    }
    if (en && en.cls === "run") parts.push('<div class="task-sub"><span class="st run">running</span> 子代理运行中,实时刷新…</div>');
 // 实时流式尾块(与主会话 stStream 同渲染形态):该 agent 的活跃草稿按
 // sid(subagent-<taskId>)登记在 subStreams;真 subagent.event message.agent 到达即让位。
    const liveDraft = subAgentDraftOf(all);
    if (liveDraft) {
      if (liveDraft.reasoning && settings.thinking === "on")
        parts.push('<details class="think-card think-live" open><summary>思考 · 生成中</summary><div class="th-body">' + sketchifyHtml(esc(liveDraft.reasoning.slice(0, 4000))) + "</div></details>");
      if (liveDraft.text) parts.push('<div class="task-reply">' + mdToHtml(scrubProtocolLines(liveDraft.text), q) + (liveDraft.done ? "" : '<span class="st-cursor"></span>') + "</div>");
      for (const tw of liveDraft.tools || []) {
        const m3 = toolMetaOf(tw.name);
        parts.push('<div class="st-tool' + (tw.running ? " run" : "") + '"><span class="st-tool-dot"></span>' +
          (m3 ? '<span class="tc-ic" style="width:11px;height:11px">' + ic(m3.i) + "</span>" : "") +
          "<span" + (m3 ? ' title="' + esc(tw.name) + '"' : "") + ">" + esc(m3 ? m3.v : tw.name) + "</span>" +
          '<span class="st-tool-state">' + (tw.running ? (tw.note ? esc(tw.note) : "执行中") : "完成 · " + (tw.durationMs || 0) + "ms") + "</span></div>");
      }
    }
  }
 // 轨迹行点击复制路径(与主历史同语义;工作区直写 chatBody,绑定在工作区渲染后做)
  for (const tl of $("chatBody").querySelectorAll(".llm-trace-line[data-trace-file]")) {
    tl.onclick = () => {
      const p = String(tl.dataset.traceFile || "");
      if (!p) return;
      navigator.clipboard.writeText(p).then(() => toast("轨迹文件路径已复制:" + p.slice(-60)), () => toast(p, false));
    };
  }
  const html = parts.join("") || '<div class="empty-line">该子代理暂无记录</div>';
  if (html !== subWsLastHtml) { subWsLastHtml = html; histLastParts = null; $("chatBody").innerHTML = html; } // histLastParts 失效:工作区直写共享容器后,主历史缓存与 DOM 不再对位
 // mermaid 围栏懒加载出图(改版;与主历史同语义,见 mmRenderIn)
  mmRenderIn($("chatBody"));
  artRenderIn($("chatBody")); // 图卡挂载(与消息流同语义)
  renderSubDir(); // 工作区打开期间目录角标/状态照常跟进(journal 增量到达即刷新)
  if (vt) { if (wasBottom) vt.scrollTop = vt.scrollHeight; else vt.scrollTop = keepTop; }
}

// 会话内查找(Ctrl+F;ZCode TaskFindDialog 裁剪)
function findBarOpen() { $("findBar").style.display = "flex"; $("findQ").value = findQuery; $("findQ").focus(); }
function findBarClose() { $("findBar").style.display = "none"; findQuery = ""; findIdx = 0; renderHistory(); }
$("findQ").oninput = () => { findQuery = $("findQ").value; findIdx = 0; renderHistory(); };
$("findQ").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); findIdx++; renderHistory(); } if (e.key === "Escape") findBarClose(); };
$("findNext").onclick = () => { findIdx++; renderHistory(); };
$("findPrev").onclick = () => { findIdx = Math.max(0, findIdx - 1); renderHistory(); };
$("findClose").onclick = findBarClose;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F") && viewLive("chat")) {
    e.preventDefault(); findBarOpen();
  }
});

let histLastSeq = -1, histSession = null; // 会话增量水位
// 历史分页(接服务端 beforeSeq 契约):首屏只取末 200 条,更早的靠顶部「加载更多历史」回溯。
let histHasMore = false;        // 首屏/翻页回包说「还有更早事件」才显示按钮
let histNextBeforeSeq;          // 下一页游标(=本页最小 seq,服务端保证严格推进);hasMore=false 时清空
let histPageLoading = false;    // 翻页请求在飞(按钮文案「加载中…」,防连点重入)
const HIST_PAGE = 200;          // 历史每页条数(首屏与翻页同值)
// ---- 右侧 diff 抽屉( F1):变更条文件清单点击→单文件补丁(取代旧 alert 清单) ----
function ddOpen(taskId, file) {
  ddSel = { taskId: taskId, file: file };
  $("ddTitle").textContent = file;
  $("ddBody").textContent = "读取补丁…";
  $("dd").classList.add("on");
  wsSafeSend(JSON.stringify({ v: 1, type: "task.filediff", taskId, file }));
  renderHistory(); // 高亮选中行
}
function ddClose() { $("dd").classList.remove("on"); ddSel = null; renderHistory(); }
function ddRender(text, truncated) {
  const lines = String(text || "").split(String.fromCharCode(10));
  $("ddBody").innerHTML = lines.map((l) => {
    let cls = "dl-ctx";
    if (l.indexOf("@@") === 0) cls = "dl-hunk";
    else if (l.indexOf("+++") === 0 || l.indexOf("---") === 0 || l.indexOf("diff ") === 0 || l.indexOf("index ") === 0) cls = "dl-meta";
    else if (l.charAt(0) === "+") cls = "dl-add";
    else if (l.charAt(0) === "-") cls = "dl-del";
    return '<span class="' + cls + '">' + esc(l) + "</span>";
  }).join("") + (truncated ? '<span class="dl-meta">…(超 120KB 已截断)</span>' : "");
}
$("ddClose").onclick = ddClose;
function refreshHist() {
  if (!currentSid) return;
 // 增量:已加载过该会话且水位有效→sinceSeq 只取新增(服务端 readAll(sinceSeq) 过滤);
 // 首载/切会话→**只取末 200 条**(limit 无 sinceSeq/未给 beforeSeq = 服务端首屏尾页路径),
 // hasMore/nextBeforeSeq 由回包记录,更早的事件走顶部「加载更多历史」(loadMoreHist)。
  const inc = histEvents && histLastSeq >= 0 && histSession === currentSid;
  wsSafeSend(JSON.stringify(inc
    ? { v: 1, type: "session.history", sessionId: currentSid, sinceSeq: histLastSeq }
    : { v: 1, type: "session.history", sessionId: currentSid, limit: HIST_PAGE }));
}
/** 顶部「加载更多历史」:按游标向前翻一页(seq<beforeSeq),回包在收包处按 seq 去重前插。
 * 游标缺失/在飞/已无更早 → 不动(服务端 hasMore 只在游标严格推进时给,前端同样不臆测)。 */
function loadMoreHist() {
  if (!currentSid || histPageLoading) return;
  if (histHasMore !== true || histNextBeforeSeq === undefined) return;
  histPageLoading = true;
  wsSafeSend(JSON.stringify({ v: 1, type: "session.history", sessionId: currentSid, beforeSeq: histNextBeforeSeq, limit: HIST_PAGE }));
  renderHistory(); // 按钮切「加载中…」(parts 变了即重绘,mfPatch 只换该块)
}
/** 会话域 UI 归零(用户用户反馈「新建任务时聊天窗所有按钮/数据显示要重置」)。
 * openSession(切会话)与 newDraft(回草稿态)共用同一份清单——两处各写一份必然漂移
 * (草稿态此前漏清:子代理流/未读、白板会话上下文、子代理徽标、上下文 pill、问答条、附件条)。
 * 只清「绑定某个会话的表现层状态」;localStorage/sessionStorage 的草稿与偏好键一律不碰
 * (zh:draft:* / zh:perm-mode / zh:effort / zh:bucket-collapse 等语义保持现状)。
 * sid 传入=切到某个会话(只丢该会话水位,别的会话增量游标保留);空=回草稿态(全清)。 */
function resetSessionDomainUI(sid) {
 // ①事件流 / 状态投影 / 增量水位(切会话=null 走全量重载,草稿态=[] 无历史)
  histEvents = sid ? null : [];
  sessionStatus = null;
  if (sid) ssSeqBySid.delete(sid); else ssSeqBySid.clear();
  histLastSeq = -1; histSession = null;
  mfWinLo = 0; mfWinSk = !!sid; mfWinShiftFrom = -1;
  histHasMore = false; histNextBeforeSeq = undefined; histPageLoading = false;
 // ②流式尾块 / 子代理流式草稿 / 子消息未读(不跨会话,也不带进草稿态)
  stStream = null; subStreams.clear(); subMsgReset();
 // ③置顶状态条(清单/子代理/压缩/失败/重试 chip 全在 chatStatusbar)
  $("chatStatusbar").innerHTML = "";
 // ④白板会话上下文:旧 taskId/批注缓存/浮窗残影不带到新会话或草稿态
  boardDoc = null; boardTaskId = ""; boardSelNode = null; boardItems = [];
  boardMissing = ""; boardListSkipped = 0; boardConflict = null;
  boardOverlayB64 = null; sessionOverlayB64 = null;
  wbAbortStroke();
 // ⑤派生渲染:徽标/上下文用量/目标 chip/语音锁态按「当前有没有会话」重算
  try { renderStatusbar(); } catch (e) { /* 状态条渲染失败不影响切换 */ }
  try { renderSubDir(); } catch (e) { /* 子代理徽标渲染失败不影响切换(histEvents 已空=徽标归零) */ }
  try { ctxPillRender(); } catch (e) { /* 上下文 pill 另有 500ms 心跳兜底 */ }
  try { renderVoiceState(); } catch (e) { /* 语音锁态渲染失败不影响切换 */ }
  const gp = $("goalPill");
  if (gp && !currentSid) { gp.style.display = "none"; gp.textContent = "目标"; }
  if (!currentSid) lastGoalState = null;
}
`;
