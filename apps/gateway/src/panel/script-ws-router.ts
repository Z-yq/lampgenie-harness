/**
 * 面板主脚本分片:script-ws-router(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_WS_ROUTER = `function wsOnMessage(e) {
  const m = JSON.parse(e.data);
  lastPong = Date.now(); // 任何入站帧都证明链路活着(pong 之外还有流式事件/广播)
 // 启动期守卫(用户报错三连):hello 可能在顶层声明(navHist/__restored 落位)前到达——
 // TDZ 异常会让 onmessage 直接抛、恢复流程全断。未就绪=缓存首帧,脚本尾部统一恢复。
 // typeof navHist 对 let-TDZ 会抛 ReferenceError,改 __navReady 标志(navHist 声明处置位)。
  if (!window.__navReady) { try { window.__pendingHello = m; } catch (_) {} return; } // 只查该标志(__restored 已随恢复流程移除;残留检查会永久丢消息, 审计实修)
  if (m.type === "stream") { onStreamEv(m); return; }
  if (m.type === "annotate.result") { if (window.__annResult) window.__annResult(m); return; } // 截图标注回执(独立脚本块)
  if (m.type === "annotate.record.result") { if (window.__annRecordResult) window.__annRecordResult(m); return; } // 录屏批注回执
 // 指挥台帧(super.*)→ #view-super(独立聊天渲染区+看板);右下角 widget 有自己的 WS,两边各取所需互不干扰。
  if (m.type === "super.history.result" || m.type === "super.turn.user" || m.type === "super.turn.done" ||
      m.type === "super.notice" || m.type === "super.relay" || m.type === "super.inbox.result" || m.type === "super.inbox.changed") { superOnMsg(m); return; }
 // 服务端 super 轮失败(error 只发发起 socket):清指挥台等待气泡并显式报错;其余 error 帧走既有通道。
  if (m.type === "error" && (m.code === "super-failed" || m.code === "super-announce-failed")) { supOnError(m); return; }
  if (m.type === "voice.draft.result") { voiceDraftResult(m); return; } // 语音任务书回执(解锁+回填/暂存)
  if (m.type === "hello") {
    (m.tasks || []).forEach((t) => mergeTaskIndex(t));
 // hello 带会话活动时间快照(独立字段,不在 TaskIndex 里)——首屏排序即按最近活动,
 // 不必等第一个 session.status.changed 帧。键值形如 { sid: ms }。
    if (m.sessionActivity && typeof m.sessionActivity === "object") {
      for (const sid of Object.keys(m.sessionActivity)) noteSessionAct(sid, m.sessionActivity[sid]);
    }
    if (m.platform) srvPlatform = String(m.platform);
 // 版本戳自愈:窗口打开后永不重载 → gateway 重建重启后仍是旧 JS(表现:点文件空白/
 // 卡在读取中)。hello 带服务端戳,与页面自身戳不符即重载;sessionStorage 记戳防重载环。
    if (m.build) {
 // 版本戳自愈:窗口打开后永不重载 → gateway 重建重启后仍是旧 JS(经验证表现:点文件
 // 标签卡在「读取 …」、编辑区空白)。三态判断:①本页无戳=页面早于本机制(必是旧版)→ 重载;
 // ②戳不符=旧版 → 重载;③相符 → 不动。sessionStorage 记服务端戳防重载环。
      var bkey = "zh:build";
      var bstale = !window.__PANEL_BUILD || String(m.build) !== String(window.__PANEL_BUILD);
      if (bstale && sessionStorage.getItem(bkey) !== String(m.build)) {
        sessionStorage.setItem(bkey, String(m.build));
        var bdirty = ideTabs.some(function (t) { return t.dirty; });
        if (bdirty) { // 有未保存改动:不抢重载,给横幅提示让用户自己挑时机
          svcBanner(true, "面板已更新(服务器 " + String(m.build) + " ≠ 本页 " + String(window.__PANEL_BUILD || "无版本戳(旧页面)") + "),当前窗口是旧版——请保存后刷新页面(F5)");
        } else {
          var bu = location.pathname + "?b=" + encodeURIComponent(String(m.build)) + location.hash;
          location.replace(bu);
          return;
        }
      }
    }
 // fixI13: 队列快照恢复(页面刷新后排队卡再现)。
    queueBySid.clear();
    for (const qi of (m.queue || [])) {
      const arr = queueBySid.get(qi.sessionId) || [];
      arr.push(qi); queueBySid.set(qi.sessionId, arr);
    }
    render();
    if (!globalThis.__helloRestored) { globalThis.__helloRestored = true; if (savedSid) openSession(savedSid); if (savedView === "ide" && dualOpen) dualToggle(true); else if (savedView && savedView !== "chat") switchView(savedView); } // 视图还原:刷新落在白板等视图时回原位(openSession 固定切 chat,会拽走白板→白板数据看起来"刷新即丢");双中心态刷新时 savedView=ide 不再拽走身份,直接重开右栏
  }
 // fixI14: 队列变更广播→更新本地队列;当前会话立即重渲(排队卡增减)。
  if (m.type === "queue.update") {
    if ((m.items || []).length) queueBySid.set(m.sessionId, m.items);
    else queueBySid.delete(m.sessionId);
    if (m.sessionId === currentSid) { renderHistory(); renderSendBtn(); }
  }
  if (m.type === "task.list") {
 // 整表替换:删除/清归档后列表收缩(合并式 set 永不删行)。
    const next = new Map(); (m.tasks || []).forEach((t) => next.set(t.id, Object.assign({}, tasks.get(t.id) || {}, t)));
 // updatedAt 单调合并(ref taskIndexRepo.ts:1321 Math.max——snapshot 的旧时间戳
 // 直接覆盖会把 applyAgentPatch 刚写的更新时间冲回旧值,新会话首 prompt 后被压回列表底部)。
 // 按 taskId 对已有值取 max;task.changed/task.submitted 的实时帧(updatedAt 新)不受影响。
    for (const t of [...next.values()]) {
      const prev = tasks.get(t.id);
      if (prev && typeof prev.updatedAt === "number" && typeof t.updatedAt === "number" && t.updatedAt < prev.updatedAt) {
 // next 里已是「prev 正文 + 新索引」的合并值,这里不能再只 spread t(会把正文键冲掉)。
        next.set(t.id, Object.assign({}, next.get(t.id) || {}, { updatedAt: Math.max(t.updatedAt, prev.updatedAt) }));
      }
    }
 // T2(视频拆解):task.list 全量广播(含他山会话)此前一律 renderChat→renderHistory
 // 全量重写 chatBody=问候区闪烁根因之一。仅当当前会话相关条目有增减/状态变化才重建聊天区。
    let touched = !currentSid;
    if (!touched) {
      const curNew = [...next.values()].filter((t) => t.sessionId === currentSid); // 用单调合并后的值判 touched(与落表值同源,防合并差异误触重渲)
      const curOld = [...tasks.values()].filter((t) => t.sessionId === currentSid);
      if (curNew.length !== curOld.length) touched = true;
      else for (const nt of curNew) { const o = tasks.get(nt.id); if (!o || o.state !== nt.state || o.updatedAt !== nt.updatedAt) { touched = true; break; } }
    }
 // currentSid 不在新表内=会话已被删(ref WorkspaceShellLayout.tsx:1157「删除会话后回
 // draft」)→ 走 newDraft 回草稿欢迎态,不停留在已删会话的旧渲染上。仅全量列表到达时判一次
 // (增量路径 task.changed 不会让会话消失),且草稿态(currentSid=null)不触发。
    const sidGone = !!currentSid && !(m.tasks || []).some((t) => t.sessionId === currentSid);
    tasks.clear(); for (const [k, v] of next) tasks.set(k, v);
 // 延到当前脚本初始化完成后再重建(supState/函数在 submit 分片,同步期可能未就位);每帧只跑一次
    try { setTimeout(function () { try { supRehydrateDispatch(); } catch (e) { /* 派发区重建失败不影响主链 */ } }, 0); } catch (e) {}
    if (viewLive("super")) { try { supRenderBoard(); } catch (e) { /* 看板重渲失败不影响主链 */ } } // 指挥台看板吃 task.list 全量
    if (sidGone) { newDraft(); return; }
    render(touched);
  }
 // 任务正文按需回包(索引瘦身后 instruction/result 不在 task.list/task.changed 里)。
  if (m.type === "task.detail.result") {
    taskDetailPending.delete(m.taskId);
    const waiters = taskDetailWaiters.get(m.taskId) || []; taskDetailWaiters.delete(m.taskId);
    if (m.task) {
      taskBodyIds.add(m.taskId);
      tasks.set(m.taskId, Object.assign({}, tasks.get(m.taskId) || {}, m.task));
      try { supOnTaskDetail(m.taskId, m.task); } catch (e) { /* Super 面板不在场/异常不影响主链 */ }
      render();
      if (m.task.sessionId === currentSid) renderHistory();
    }
    for (const cb of waiters) { try { cb(m.task || null); } catch (e) { /* 单个 waiter 抛错不影响其它 */ } }
    return;
  }
  if (m.type === "checkpoint.preview.result") {
 // 预览→确认清单→回滚(预览先行红线)
    if (!m.sha || !m.files.length) { toast("该任务无可回滚变更(无快照或无差异)", true); return; }
    const NL3 = String.fromCharCode(10);
    uiConfirm("回滚到此任务前?将恢复 " + m.files.length + " 个文件:" + NL3 + m.files.slice(0, 8).join(NL3) + (m.files.length > 8 ? NL3 + "…" : "") + NL3 + "(快照后新增的未跟踪文件保留)", { tone: "danger" }).then((ok) => {
      if (ok) wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.rewind", taskId: pendingRewind }));
    });
    return;
  }
  if (m.type === "checkpoint.list.result") { snapshots = m.snapshots || []; snapRender(); return; }
  if (m.type === "checkpoint.restore.result") {
    toast(m.ok ? "快照已恢复 " + String(m.sha || "").slice(0, 8) : "恢复失败:" + String(m.reason || "").slice(0, 80), !m.ok);
    if (m.ok) wsSafeSend(JSON.stringify({ v: 1, type: "checkpoint.list" })); // 刷新清单(成功后 sha 面板照旧)
    return;
  }
  if (m.type === "exp.distill.result") {
    toast(m.ok ? "经验沉淀完成:" + String(m.detail || "").slice(0, 70) : "沉淀失败:" + String(m.detail || "").slice(0, 80), !m.ok);
    if (m.ok) wsSafeSend(JSON.stringify({ v: 1, type: "exp.list" }));
    return;
  }
  if (m.type === "automation.list.result") { automations = m.automations || []; renderAutomations(); return; }
  if (m.type === "models.list.result") {
 // fixT7:端点拉取成功=这些模型经端点验证,并入 verifiedModels(快切菜单的未验证分组依据)
    for (const id of (m.ids || [])) verifiedModels.add(id);
    renderModelSwitch();
 // u6:目录拉取恢复 → 清掉触发器上的「模型加载失败,重试」红字态
    if (modelListFailed) { modelListFailed = false; renderModelPill(cfgView); }
 // pill 就地下拉兜底:设置页 PROVIDER 未存模型时,端点拉取的清单进同一菜单(不再有居中弹窗)。
 // 仅此分支 return——旧版此处无条件 return 曾把下方设置页 model-ids/renderModelList 处理变成死代码。
    if (modelMenuPending) {
      modelMenuPending = null;
      const off = disabledModels();
      const list = (m.ids || []).filter((x) => off.indexOf(x) < 0).slice(0, 60);
      if (!list.length) { toast("端点无模型清单(先在设置-Coding 模型页配置)", true); return; }
 // 兜底清单也走两级渲染器(同一套直展组/折叠组 + sticky footer 语义)
      modelMenuOpen(list);
      return;
    }
 // 无 pending(设置页拉取):落到下方 model-ids/renderModelList 处理
  }
  if (m.type === "ask.user") {
 // 许愿式编程:agent 需求取舍问答——问答条(选项按钮+自由输入),作答即发回。
    askPending.push(m);
    askRenderBar();
    return;
  }
  if (m.type === "workflow.question") {
    wfQuestions.push({ wfId: m.wfId, cacheKey: m.cacheKey, instructions: m.instructions, at: Date.now() });
    wfRenderQuestions();
    return;
  }
  if (m.type === "file.read.result") { if (ideRenderRead(m)) return; fvRender(m); return; } // full 回包先喂 IDE 标签(命中即止;#fileViewer 窗口语义零改)
  if (m.type === "file.write.result") { if (ideNewFileResult(m)) return; ideSaveResult(m); return; } // 新建/另存为命中先行;否则走保存链
  if (m.type === "ide.office.edit.result") { ideOfficeEditResult(m); return; } // P2:Office 文本回写回执(ok/error 都在回包里,不走 error 帧)
 // IDE 文件操作四通道回包(mkdir/remove/rename/grep;回包式 ok:false 不走 error 帧)
  if (m.type === "fs.mkdir.result" || m.type === "fs.remove.result" || m.type === "fs.rename.result" || m.type === "fs.grep.result") {
    if (ideFsResult(m)) return;
  }
  if (m.type === "error" && m.code === "file-write-denied") { ideSaveDenied(m); return; } // C:server 沙箱拒绝(无 path 可回指→找 saving 中标签保脏)
 // 第二批(VSCode 对齐):requestId 路由(git.show / lsp.diagnostics / term.session.*;后端回显 requestId 时精准分发)
  if (m && m.requestId && ideReqMap.has(m.requestId)) {
    const fn = ideReqMap.get(m.requestId);
    ideReqMap.delete(m.requestId);
    try { fn(m); } catch (e) { console.warn("[ide] requestId 回包处理失败", e); }
    return;
  }
 // 兜底:后端未回显 requestId 时按 type 识别的回包(diff 原文 / 终端)
  if (m.type === "git.show.result") { ideScmOnShow(m); return; }
  if (m.type === "term.session.open.result") { ideTermOnResult(m); return; }
  if (m.type === "term.session.read.result") { ideTermOnResult(m); return; }
 // 目录浏览结果——目录浏览器开着优先喂它;文件树缓存恒更新,视图可见即重渲
  if (m.type === "fs.list.result") {
    if (m.path === "") { if ($("dirBrowser").classList.contains("on")) dbRender(m); return; } // 锚点应答
    filesPending.delete(m.path);
    if ($("dirBrowser").classList.contains("on")) dbRender(m);
    dirCache.set(m.path, m.entries || []); // error 应答无 entries → 空数组,防渲染循环重发
    if (cfProbeHit(m)) return; // 聊天路径点击的存在性探针(命中由本层决定开/拒)
    if (viewLive("files")) filesRender();
    if (sbFt) renderSbFt(); // 侧栏文件树滑入层开着:目录数据到达即重渲
    if (ideRoot && ideExpanded && viewLive("ide")) ideTreeRender(); // IDE 树同源懒展开
    return;
  }
  if (m.type === "fs.open.result") { toast(m.ok ? "已打开(" + m.tool + ")" : "打开失败:" + (m.error || "未知"), !m.ok); return; }
  if (m.type === "files.result") {
    if (mentionOpen && mentionTrigger === "@") { mentionItems = m.files || []; mentionHot = 0; mentionRender(); }
    else if ($("cc").classList.contains("on") && $("cc-q").value.trim().startsWith("@")) {
      $("cc-list").innerHTML = (m.files || []).length
        ? m.files.map((f, i) => '<div class="cc-item' + (i === 0 ? " hot" : "") + '" data-file="' + esc(f) + '"><span class="ct">@' + esc(f) + '</span><span class="t-time">文件</span></div>').join("")
        : '<div class="cc-empty">没有匹配的文件</div>';
      for (const el of $("cc-list").querySelectorAll(".cc-item")) el.onclick = () => { $("instruction").value = ($("instruction").value + " " + el.dataset.file).trim() + " "; switchView("chat"); $("instruction").focus(); ccClose(); };
    }
    return;
  }
  if (m.type === "session.search.result") { ccSessionRender(m); return; }
  if (m.type === "permission.ask") {
 // 审批中心入队+原弹窗(高危即弹,批量面在审批视图)。
 // 存 timeoutMs(Gate 行 TTL 倒计时;60s fail-closed 与服务端同钟)。
    approvalQueue.set(m.requestId, { requestId: m.requestId, sessionId: m.sessionId, tool: m.tool, summary: m.summary, risk: m.risk || "medium", since: Date.now(), timeoutMs: m.timeoutMs || 60000 });
    if (viewLive("approvals")) renderApprovals();
    try { cvStatusRefresh(); } catch (e) { /* 状态点失败不影响审批流 */ }
    permShow(m); return;
  }
 // 关卡 Gate:决议广播(broker onSettle→server)——多端一致清理挂起行/modal,
 // 漏掉 ask 帧的标签页/别的面(指挥台)放行后,这里也能收敛(修 stale-row 点击报 UnknownAsk)。
  if (m.type === "permission.resolved") {
    approvalQueue.delete(m.requestId);
    if (permCurrent && permCurrent.requestId === m.requestId) permHide();
    if (viewLive("approvals")) renderApprovals();
    try { cvStatusRefresh(); } catch (e) { /* 忽略 */ }
    return;
  }
  if (m.type === "permission.history.result") { approvalHistory = Array.isArray(m.items) ? m.items : []; if (viewLive("approvals")) renderApprovals(); return; }
 // 节点 Fleet:注册/掉线/心跳翻转廉价广播 → 相关视图活着就重拉(负载细节在回包里)。
  if (m.type === "nodes.changed") { if (viewLive("nodes") || viewLive("super") || viewLive("sys")) wsSafeSend(JSON.stringify({ v: 1, type: "nodes.list" })); return; }
  if (m.type === "node.exec.result") {
 // 「电脑控制」真路由回执:按节点记最近一次输出(Fleet 卡内展示;旧版只 toast 名不副实)。
    nodeExecOut.set(m.nodeId, { ok: !!m.ok, output: String(m.output || m.error || ""), at: Date.now(), durationMs: m.durationMs, cmd: nodeExecOut.get(m.nodeId)?.cmd || "" });
    toast((m.ok ? "✓ " : "✗ ") + "节点 " + m.nodeId + " 执行完成(" + Math.round((m.durationMs || 0) / 100) / 10 + "s)" + (m.ok ? "" : ":" + String(m.error || "").slice(0, 60)), !m.ok);
    if (viewLive("nodes")) nodesViewRender(supState.nodes || { nodes: [] });
    return;
  }
  if (m.type === "git.status.result") { gitRenderStatus(m); ideScmOnStatus(m); try { cvStatusRefresh(); } catch (e) { /* 状态点失败不影响 Git */ } return; }
  if (m.type === "git.diff.result") { gitRenderDiff(m); return; }
  if (m.type === "git.branches.result") { gitRenderBranches(m); return; }
 // sense.review.result 已删(冗余收敛:评审走 code_review 工具)

  if (m.type === "review.store.result") { revStoreRender(m); return; }
 // 评审评论回注成功回执:toast 明确注入到了哪个会话;异会话注入自动跳转过去(最强可见反馈)。
  if (m.type === "review.inject.result") {
    const label = sidLabel(m.sessionId) || m.sessionId;
    toast("已注入 " + m.count + " 条评论 → 会话「" + label + "」(任务 …" + String(m.taskId).slice(-8) + ")");
 // n12:评论已交给 agent(服务端落任务/注入上下文)→ 「待读评论」chip 就地清零(不重拉 list,最小改动)
    if (m.taskId) {
      try { bdPendingRefresh("clear", m.taskId); } catch (e) { /* 函数未在场(旧脚本缓存)=忽略 */ }
    }
    if (m.sessionId && m.sessionId !== currentSid) openSession(m.sessionId);
    return;
  }
  if (m.type === "git.log.result") {
    $("gitDiff").innerHTML = (m.commits || []).length
      ? m.commits.map((c) => '<div class="fv-line"><span class="ln">' + esc(c.hash) + "</span><span><b>" + esc(c.subject) + "</b> <span class='d-meta'>" + esc(c.author) + " · " + esc(c.date) + "</span></span></div>").join("")
      : '<div class="cc-empty">无提交</div>';
    return;
  }
  if (m.type === "git.ok") {
    if (m.op === "commitmsg" && m.detail) { $("gitMsg").value = m.detail; $("gitAiMsg").textContent = "AI 提交信息"; toast("已生成提交信息(可改后提交)"); return; }
    if (m.op && String(m.op).startsWith("plugin-")) { toast(m.detail || ""); wsSafeSend(JSON.stringify({ v: 1, type: "plugins.list" })); wsSafeSend(JSON.stringify({ v: 1, type: "commands.list" })); return; }
    if (m.op === "archive-clear") { toast(m.detail || "已清理"); }
 // 提交/切换/推送/拉取:服务端 detail(如「已推送 master → origin」)直接回显,随后刷新状态。
    if (["commit", "checkout", "push", "pull"].includes(String(m.op))) toast(m.detail || "已完成", false);
    gitLoad(); return;
  }
  if (m.type === "profile.file.result") { ppfOnData(m); return; }
  if (m.type === "profile.get.result") { if (m.profile && (!ppId || m.profile.projectId === ppId)) ppRender(m.profile); return; }
  if (m.type === "profile.sense.result") {
 // 总路线 tab:回执复位生成按钮,渲染宗旨面
    rmBusy = false;
    const g = $("rmGen"); if (g) g.disabled = false;
    roadmapRender(m);
    return;
  }
  if (m.type === "profile.progress") {
    if (ppId === m.projectId) {
      $("ppBar").style.width = (m.progress || 0) + "%";
      $("ppPct").textContent = (m.progress || 0) + "% · " + (m.stage || "");
      $("ppState").textContent = m.state === "done" ? "完成" : m.state === "running" ? "分析中" : m.state;
      $("ppState").className = "pp-state " + m.state;
      if (m.state === "done") wsSafeSend(JSON.stringify({ v: 1, type: "profile.get", projectId: m.projectId }));
    }
    return;
  }
  if (m.type === "cfg.secret.result" && m.rid === "sshcred") {
    if (!m.ok) { $("sshCredOut").textContent = "secrets 写入失败:" + (m.error || ""); toast("SSH 凭证保存失败", true); return; }
    if (sshCredPending) wsSafeSend(JSON.stringify({ v: 1, type: "ssh.test", host: sshCredPending.host, port: sshCredPending.port, username: sshCredPending.user }));
    return;
  }
  if (m.type === "ssh.test.result" && !prConn) { // prconn(新建连接)链优先;设置台凭证区只在非对话框上下文接管
    const out = $("sshCredOut");
    if (!out) return;
    if (m.ok && sshCredPending) {
      const hp = sshCredPending;
      out.innerHTML = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span style="color:var(--bronze)">连接成功 ✓ 延迟 ' + (m.latencyMs ?? "?") + 'ms</span>' +
        '<input class="num-in" id="sshadd-path" style="width:170px;text-align:left;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px" placeholder="/home/' + hp.user + '/项目目录">' +
        '<button class="vw-act" id="sshadd-go">添加为远程项目</button></div>';
      const go = $("sshadd-go");
      if (go) go.onclick = () => {
        const rp2 = $("sshadd-path").value.trim();
        if (!rp2) { toast("先填远端目录路径", true); return; }
        wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: "remote:ssh:" + hp.host + ":" + hp.port + ":" + hp.user + ":" + rp2 }));
        toast("已添加远程项目,正在检查连接…");
      };
    } else {
      out.textContent = "连接失败:" + (m.error || "未知");
    }
    toast(m.ok ? "SSH 连接成功" : "SSH 连接失败", !m.ok);
    return;
  }
  if (m.type === "remote.ls.result") {
 // 远程文件树目录数据:落 dirCache(键=remote://<projectId>/<rel>),渲染链与本地树同源
    const rp = filesRemoteProject();
    if (rp && m.projectId === rp.id) {
      filesPending.delete("remote://" + rp.id + (m.path ? "/" + m.path : ""));
      dirCache.set("remote://" + rp.id + (m.path ? "/" + m.path : ""), m.entries || []);
      if (viewLive("files")) filesRender();
      if (sbFt) renderSbFt();
    }
    remoteLsSink && remoteLsSink(m);
    return;
  }
  if (m.type === "remote.read.result") { remoteReadSink && remoteReadSink(m); return; }
  if (m.type === "remote.deploy.result") { toast("远端环境已就绪 ✓(已自动适配 " + (m.node ?? "远端") + ")"); return; }
  if (m.type === "ssh.config.list.result") {
    prConfigEntries = m.entries || [];
    const imp = $("prConfigImport");
    if (imp) {
      imp.innerHTML = '<option value="">从 SSH config 导入</option>' + prConfigEntries.map((e) => '<option value="' + esc(e.alias) + '">' + esc(e.alias) + " (" + esc(e.host) + (e.user ? ", " + esc(e.user) : "") + ")</option>").join("");
    }
    return;
  }
  if (m.type === "ssh.key.import.result") {
    const out = $("prConnOut");
    if (!out) return;
    if (!m.ok) { out.textContent = "私钥导入失败:" + (m.error || ""); toast("私钥导入失败", true); return; }
    if (prConn && prConn.kind === "ssh") { out.textContent = "① 私钥已存 → ② 测试连接并安装工作区服务…"; wsSafeSend(JSON.stringify({ v: 1, type: "ssh.test", host: prConn.host, port: prConn.port, username: prConn.user, ensureServer: true })); }
    return;
  }
  if (m.type === "cfg.secret.result" && (m.rid === "prconn-pw" || m.rid === "prconn-key")) {
    const out = $("prConnOut");
    if (!m.ok) { if (out) out.textContent = "凭证保存失败:" + (m.error || ""); toast("凭证保存失败", true); return; }
    if (prConn && prConn.kind === "ssh") { if (out) out.textContent = "① 凭证已存 → ② 测试连接并安装工作区服务…"; wsSafeSend(JSON.stringify({ v: 1, type: "ssh.test", host: prConn.host, port: prConn.port, username: prConn.user, ensureServer: true })); }
    return;
  }
  if (m.type === "ssh.test.result" && prConn && prConn.kind === "ssh") {
 // 连接向导:连接(含装服务并验证)→ 由服务返回目录 → 选目录加项目
    const out = $("prConnOut");
    if (m.ok) {
      const home = m.home || "/home/" + prConn.user;
      if (out) out.textContent = "② 连接成功(" + (m.latencyMs ?? "?") + "ms)→ ③ 工作区服务就绪(server " + (m.server ?? "?") + ", node " + (m.node ?? "?") + ") → ④ 经服务浏览目录,选一个项目目录";
      prBrowse = { kind: "ssh", host: prConn.host, port: prConn.port, user: prConn.user, path: home, parent: null };
      prShowBrowser();
      prBrowseGo(home);
      return;
    }
    if (out) out.textContent = "② 连接失败:" + (m.error || "未知") + (m.connected ? "——主机已连通,但服务未就绪" : "——检查凭证/网络后重试");
    toast(m.connected ? "工作区服务未就绪" : "SSH 连接失败", true);
    return;
  }
  if (m.type === "wsl.list.result" && $("prWslList")) {
    const rows = (m.distros || []).map(function (d) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border-soft);border-radius:8px;margin-bottom:6px"><b style="font-size:11px;color:var(--text)">' + esc(d.name) + '</b><span style="font-size:10px;color:var(--faint)">' + esc(d.home || "") + '</span><button data-distro="' + esc(d.name) + '" style="margin-left:auto;background:var(--bronze);border:none;color:#111;border-radius:6px;font-size:11px;padding:3px 12px;cursor:pointer;font-weight:600">连接</button></div>';
    }).join("");
    $("prWslList").innerHTML = rows || '<div class="cc-empty">未发现 WSL 发行版(可先执行 wsl --install)</div>';
    for (const b of $("prWslList").querySelectorAll("button[data-distro]")) b.onclick = function () { prWslConnect(b.dataset.distro); };
    return;
  }
  if (m.type === "wsl.test.result" && prConn && prConn.kind === "wsl") {
    const out = $("prWslOut");
    if (m.ok) {
      if (out) out.textContent = "③ 连接已就绪(server " + (m.server ?? "?") + ", node " + (m.node ?? "?" ) + ") → ④ 经服务浏览目录,选一个项目目录";
      prBrowse = { kind: "wsl", distro: prConn.distro, path: m.home || "/", parent: null };
      prShowBrowser();
      prBrowseGo(prBrowse.path);
      return;
    }
    if (out) out.textContent = "连接失败:" + (m.error || "未知");
    toast(m.connected ? "工作区服务未就绪" : "WSL 连接失败", true);
    return;
  }
  if (m.type === "wsl.browse.result" && prBrowse && prBrowse.kind === "wsl") { prRenderBrowse(m); return; }
  if (m.type === "ssh.browse.result" && prBrowse && prBrowse.kind === "ssh") { prRenderBrowse(m); return; }
  if (m.type === "plugins.list.result") { mktCatalog = m.catalog || []; mktRender(); return; }
  if (m.type === "nodes.list.result") { nodesRender(m); nodesViewRender(m); supState.nodes = m; if (viewLive("super")) { try { supRenderBoard(); } catch (e) { /* 忽略 */ } } return; } // 指挥台④节点行共用此回包
  if (m.type === "subagents.list.result") { subMsgRender(); return; } // n3 融合:分身目录卡已删,残留回包只触发子agent会话流重渲(旧客户端/在途请求安全)
  if (m.type === "track.view.result") { trackRender(m); return; }
  if (m.type === "usage.view.result") { usageRender(m); return; }
  if (m.type === "browser.view.subscribed") {
 // 内置浏览器截图流订阅回执(含 browser.enabled=false 的门禁拒绝文案)
    brMount();
    if (window.GenieBrowserView) window.GenieBrowserView.handleMessage(m);
    if ($("brNote")) $("brNote").textContent = m.ok ? "已连接:tab " + (m.tabId || "(等待 agent 打开页面)") : (m.message || "连接失败");
    return;
  }
  if (m.type === "browser.view.frame" || m.type === "browser.view.event") {
    brMount();
    if (window.GenieBrowserView) window.GenieBrowserView.handleMessage(m);
    if (m.type === "browser.view.event" && m.kind === "close" && $("brNote")) $("brNote").textContent = "页面已关闭:" + (m.message || "");
    return;
  }
  if (m.type === "browser.view.command.result") {
 /* 2026-11 browser-ux-redo 修复:回执必须转发给视图资产——tabs 回执要渲染 chip/owner、
 * open/newTab/close 成功后要 refreshTabs、getState 回执要更新导航按钮。原先只写失败提示就
 * return,刚改造的 tab 栏(owner 徽标/chip 切换)在真实面板里全是死代码。 */
    brMount();
    if (window.GenieBrowserView) window.GenieBrowserView.handleMessage(m);
    if (!m.ok && $("brNote")) $("brNote").textContent = m.text;
    return;
  }
  if (m.type === "plan.approval.request") {
 // Plan 审批卡(ZCode ExitPlanMode「Review this implementation plan.」语义):
 // 批准=切回+按计划实施;反馈=steered 修订(保持 plan 模式)。事件委托按钮(转义铁律)。
    planApproval = { sessionId: m.sessionId, taskId: m.taskId, planPath: m.planPath, excerpt: String(m.planExcerpt || "") };
    if (currentSid === m.sessionId) refreshHist();
    toast("Plan 已就绪待审批(聊天流底部批准或给反馈)");
    return;
  }
  if (m.type === "goal.result") {
 // 目标回包:chip 展示+toast;active 恒显,pause 半透明,clear 隐藏。
    const chip = $("goalPill");
    if (chip) {
      if (m.goal) {
        chip.style.display = "";
        chip.style.opacity = m.state === "paused" ? "0.5" : "";
        chip.textContent = "目标:" + String(m.goal).slice(0, 18) + (String(m.goal).length > 18 ? "…" : "");
        chip.title = "会话目标(" + m.state + "):" + m.goal + "(点击设置新目标)";
        chip.onclick = () => { uiPrompt("会话目标(留空=清除):", String(m.goal || ""), { allowEmpty: true }).then((g) => { if (g === null) return; builtinGoal(String(g).trim() || "clear"); }); };
      } else { chip.style.display = "none"; }
    }
    lastGoalState = { goal: m.goal, state: m.state };
 // sync=goal.get 轮询/查询回包:只刷 chip 静默(「目标已清除」每 15s 刷屏根因=轮询回包走了动作确认 toast)。
    if (!m.sync) {
      toast(m.goal ? "目标已设置(" + m.state + "):" + String(m.goal).slice(0, 40) : "目标已清除");
 // ack 成功才派任务(审计修复:goal.set 被服务端拒绝时不留孤儿任务)
      const d = goalPendingDispatch;
      if (d && m.goal === d.goal) {
        goalPendingDispatch = null;
        currentSid = d.sid;
        wsSafeSend(JSON.stringify({
          v: 1, type: "task.submit", sessionId: d.sid,
          instruction: "【会话目标】" + d.goal,
          idempotencyKey: "goal-task-" + Date.now(),
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
          title: "目标:" + String(d.goal).slice(0, 30),
        }));
        chatSysLine("目标已设置:" + String(d.goal).slice(0, 50) + " —— 已派给 coding agent");
      }
      if (currentSid) refreshHist(); // 技能反馈闭环:服务端已落 message.user/system 行,立即拉取可见
    }
    return;
  }
 // per-session 主模型回包(白板「per-session 主模型」):modelOverride=null 表示该会话无覆盖(置 null 标记,
 // 与 undefined=未初始化区分,避免切会话反复重发 session.model.get);校正缓存后刷新 pill。
  if (m.type === "session.model.result") {
    if (m.sessionId) {
 // 新用户经验证:首开「模型设置」会先发 session.model.get,null 回包也走成功分支,
 // 页面凭空出现「已切换为跟随全局」——用户什么都没做。只有本标签真正发过 set(staged 在飞)
 // 才展示结果态;get/跨会话广播只静默校正缓存。
      const wasStaged = sessionModelStaged.has(m.sessionId);
 // n8 失败可见 + 回滚:P0 口径「不能停在新模型上」。
 // routeError / ok:false → toast 报错 + pill 回滚到 effective(服务端给出实际生效模型)或上次已确认值;
 // ok 但带 warning → 黄色轻提示(可落盘但任务执行未必使用,如 config 未注入)。
      const failed = m.ok === false || !!m.routeError;
 // m9回包是**广播**(多标签同会话都收):toast 只对「本标签该会话」或「命中本标签 pending」弹,
 // 别的标签在改别的会话时本标签不再弹失败提示(err/warn 都受约束;缓存照旧静默更新)。
      const pend = draftSubmitPending && draftSubmitPending.sid === m.sessionId ? draftSubmitPending : null;
 // 草稿预设会话的回包也判「本标签相关」(loud)——预设 sid 在本标签刚被操作过。
      const loud = m.sessionId === currentSid || !!pend || (draftSidStored() === m.sessionId && !!m.sessionId);
      if (failed) {
        sessionModelStaged.delete(m.sessionId);
 // 服务端明确「未落盘」:保留上次已确认覆盖(没有就仍是无覆盖=跟随全局),绝不留 staged 新值
        if (m.modelOverride === null || m.modelOverride === undefined) sessionModelOverride.set(m.sessionId, null);
        else sessionModelOverride.set(m.sessionId, m.modelOverride);
 // 失败回滚只能用**已落盘**的旧覆盖(m.modelOverride);m.effective 是本次尝试的模型,
 // routeError 时它仍指向不可用端点,拿它回滚会把 pill 钉在失败值上(经验证)。
        const eff = m.modelOverride && m.modelOverride.model ? String(m.modelOverride.model) : "";
        const why = m.routeError || m.message || m.code || "服务端拒绝";
        if (m.revision !== undefined) sessionModelRev.set(m.sessionId, Number(m.revision)); // 失败也记账:下次 CAS 才对得上
 // m4:pending 命中 → 走 draftModelAbort(不派单 + 回滚 + 保留草稿重试),它自带带原因的失败 toast,不重复弹
        if (pend) draftModelAbort(String(why), eff);
        else {
          if (loud) toast("会话模型切换失败:" + String(why).slice(0, 90) + (eff ? "(实际生效 " + eff + ")" : "(已回滚到上次生效值)"), true);
          modelPillRollback(m.sessionId, eff || null);
        }
 // revision-mismatch(别的标签页刚改过)→ 自动重拉真值对齐,用户重试即可成功
        modelSwitchNotice = { cls: "err", text: "切换失败:" + String(why).slice(0, 80) + (eff ? "(已回滚到 " + eff + ")" : "(已回滚)") };
        if (m.code === "revision-mismatch" && m.sessionId === currentSid) wsSafeSend(JSON.stringify({ v: 1, type: "session.model.get", sessionId: m.sessionId }));
      } else {
        sessionModelOverride.set(m.sessionId, m.modelOverride || null);
        sessionModelStaged.delete(m.sessionId);
        if (m.revision !== undefined) sessionModelRev.set(m.sessionId, Number(m.revision)); // CAS 基线
 // m7-front:effort 回包字段(file 口径 string|null)。顶层 m.effort 优先,其次 modelOverride.effort;
 // 两者都没有(旧服务端)→ 保持既有缓存形状,不写空字段(避免 pill 出现「·」尾巴)。
        const ackedEffort = m.effort !== undefined ? m.effort : (m.modelOverride && m.modelOverride.effort !== undefined ? m.modelOverride.effort : undefined);
        if (ackedEffort !== undefined && m.modelOverride && m.modelOverride.model) {
          sessionModelOverride.set(m.sessionId, { model: m.modelOverride.model, ...(m.modelOverride.providerId ? { providerId: m.modelOverride.providerId } : {}), effort: ackedEffort === null ? null : String(ackedEffort) });
        }
 // u6 成功反馈(ZCode 口径):「已从 {fromModel} 切换至 {toModel}」——fromLabel 取切换前显示值;
 // 跨标签广播/无前值(首次渲染)不弹;rollback 走失败分支,天然不弹。
        if (loud && modelSwitchFrom && m.modelOverride && m.modelOverride.model) {
          const toLabel = String(m.modelOverride.model);
          if (toLabel !== modelSwitchFrom) toast("已从 " + modelSwitchFrom + " 切换至 " + toLabel);
        }
        modelSwitchFrom = "";
        if (loud && m.warning) toast("会话模型: " + String(m.warning).slice(0, 90) + "(已落盘,但可能未生效)", "warn");
        else if (loud && m.effective && m.effective.model && m.modelOverride && m.effective.model !== m.modelOverride.model)
          toast("会话模型已生效为 " + String(m.effective.model).slice(0, 60) + "(服务端按 Registry 解析)", "warn");
        const doneModel = (m.effective && m.effective.model) || (m.modelOverride && m.modelOverride.model) || "";
        if (wasStaged) modelSwitchNotice = { cls: "ok", text: doneModel ? "已生效:" + String(doneModel) : "已切换为跟随全局" };
      }
      if (m.sessionId === currentSid || (draftSidStored() && m.sessionId === draftSidStored())) { renderModelPill(cfgView); renderModelSwitch(); }
 // m4:pending 的 set 已确认落地 → 此刻才真正派发首轮任务(摘链在前,广播/重复回包不会再派一次)
      if (pend && !failed) draftSubmitFire();
    }
    return;
  }
 // n9 会话归属回包(session.owner.get → session.owner.result;服务端另一路实现):
 // projectId=null 表示该会话无归属项目。前端一律缓存 sid→projectId,并刷新档案/看板作用域提示。
 // 防御:未知/畸形回包不炸(缺 sessionId 直接忽略),也不清已有缓存。
  if (m.type === "session.owner.result") {
    const osid = String(m.sessionId || "");
    if (!osid) return;
    sessionOwnerMap.set(osid, m.projectId === null || m.projectId === undefined ? null : String(m.projectId));
 // 归属到达:档案在等(arcOwnerPending)或当前会话已变 → 按归属项目重取档案
    if (osid === currentSid) {
      const wantPid = ownerProjectId();
      if (arcOwnerPending || (ppId && ppId !== wantPid)) { arcOwnerPending = false; openProfile(wantPid); }
      else ppOwnerNote(ppId || wantPid);
 // 看板子标签吃项目作用域:项目归属变了就重锁并重拉
      if (viewLive("dash")) { dashScopeAuto = true; dashLockScope(); dashLoad(); }
    }
    return;
  }
  if (m.type === "session.compact.status") {
 // 板 n3/n7:压缩在途/终态帧(服务端旁路上报)。started=置忙+流尾进行时行;
 // 终态=清忙/清进行时行,当前会话刷新历史;failed/skipped 各自 toast,completed 不 toast(由 result 分支给口径,防双提示)。
    if (m.phase === "started") {
      if (m.sessionId === currentSid) { compactInflight = { at: Date.now() }; renderHistory(); }
 // 手动压缩已由 builtinCompact 置忙;自动压缩也置忙(=用户能看出在跑),已在忙则不重复计时。
      if (!(m.trigger === "manual" || compactPending)) compactSetPending(true);
      return;
    }
    if (m.phase === "completed" || m.phase === "failed" || m.phase === "skipped") {
      compactInflight = null;
      compactSetPending(false);
      if (m.phase === "failed") toast("上下文压缩失败:" + (m.reason || "未知"), true);
      else if (m.phase === "skipped") toast("上下文已是最新,无需压缩");
      if (m.sessionId === "super") supCompactDone(); // Super 会话压缩终态(按钮解锁+实测刷新+历史重放)
      if (m.sessionId === currentSid) {
        refreshHist();
 // 完成=重发 trace.stats(与 result 分支同口径,刷新容量%/上下文条)
        if (m.phase === "completed" && currentSid) wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: currentSid }));
      }
      return;
    }
    return;
  }
  if (m.type === "session.compact.result") {
    if (compactPending) compactSetPending(false); // n7:清压缩中标记(成功/失败都清)
    compactInflight = null; // 板 n3:终态帧到达=进行时行退场
    if (m.compacted) {
 // 板 n3:toast 带上 tokens 水位(有则显示),让「压了多少」一眼可读
      const tk = function (n) { return (Math.round(Number(n) / 100) / 10).toFixed(1) + "k"; };
      const bins = (m.tokensBefore && m.tokensAfter)
        ? ",≈" + tk(m.tokensBefore) + " → " + tk(m.tokensAfter) + " tok"
        : "";
      toast("已压缩(摘要 " + (m.summaryChars || 0) + " 字" + bins + ")");
      if (currentSid) {
        refreshHist();
 // n7:压缩后重发 trace.stats 刷新容量%/上下文条——否则压缩效果在面板上看不见(与终态刷新同口径)。
        wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: currentSid }));
      }
    } else toast("未压缩:" + (m.reason || "未知"), true);
    if (m.sessionId === "super") supCompactDone(); // Super 会话压缩回执
    return;
  }
  if (m.type === "team.status.result") { lastTeamOrgs = m.orgs || []; lastProjectTeam = m.projectTeam || null; lastProjectTeams = m.projectTeams || null; lastTeamaiRaw = m.teamai || null; renderTeam(lastTeamOrgs, lastProjectTeam, lastProjectTeams); return; }
 // fixD5:issue 双通道回包(看板数据/通道画像)+ 变更广播刷新 + 派发/同步回执 + P2P 状态。
  if (m.type === "issue.list.result") { issueIngest(m.projectId, m.issues, m.channel); return; }
  if (m.type === "issue.changed") { issueBoardLoad(true); return; }
  if (m.type === "issue.dispatch.result") { toast(m.ok ? "已派发任务 " + String(m.taskId || "").slice(0, 8) + "(终态自动回写 issue)" : "派发失败:" + (m.reason || "未知"), !m.ok); if (m.ok) issueBoardLoad(true); return; }
  if (m.type === "issue.sync.result") { toast(m.ok ? "issue 已同步 git:" + (m.detail || "") : "同步失败:" + (m.reason || "未知"), !m.ok); return; }
  if (m.type === "team.p2p.status.result") { lastP2pStatus = m.status || null; renderP2pStrip(); return; }
 // 入站消息实时推送:此前对端消息在面板上是「静默到达」(只有手动刷新/轮询 status 才显示)。
 // 这里记入本地流水并重绘状态条;重复投递(duplicate)单独提示,便于判断对端是否在重发。
  if (m.type === "team.p2p.message") {
    const msg = m.message || {};
    lastP2pInbound = msg;
    p2pInboundLog.unshift({ from: String(msg.from || "?"), text: String(msg.text || "").slice(0, 200), at: Number(msg.at || Date.now()), duplicate: msg.duplicate === true });
    p2pInboundLog = p2pInboundLog.slice(0, 20);
    if (viewLive("issues")) renderP2pStrip();
    toast((msg.duplicate ? "重复消息已吸收:" : "收到 ") + String(msg.from || "?") + " → " + String(msg.text || "").slice(0, 40), false);
    return;
  }
  if (m.type === "team.invite.result") {
    if (m.ok && m.code) { uiAlert("邀请码(复制给对方;7 天有效;对方在登录页选「兑换邀请码」):\\n" + m.code, { title: "邀请码", ok: "已复制备用" }); try { navigator.clipboard && navigator.clipboard.writeText(m.code); } catch (e) {} }
    else toast("邀请失败:" + (m.reason || "未知"), true);
    return;
  }
  if (m.type === "permission.pending.result") {
    approvalQueue = new Map((m.asks || []).map((a) => [a.requestId, a]));
    renderApprovals(); return;
  }
  if (m.type === "wizard.gen.result") {
 // wizOutTarget 路由(节点页 wizOut / 添加项目向导 prWizOut);用完复位,防串页
    const out = $(wizOutTarget) || $("wizOut");
    out.innerHTML = '<div class="wiz-cmd">' + esc(m.command) + '<button class="wiz-copy">复制</button></div><div class="br-note">' + esc(m.note) + "</div>";
    const cp = out.querySelector(".wiz-copy");
    if (cp) cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(m.command); toast("命令已复制"); };
    wizOutTarget = "wizOut";
    return;
  }
  if (m.type === "agents.list.result") { renderAgents(m); return; }
  if (m.type === "skills.list.result") { renderSkills(m); return; }
  if (m.type === "commands.list.result") { renderCmds(m); return; }
  if (m.type === "hooks.list.result") { renderHooks(m); return; }
  if (m.type === "mcp.list.result") { renderMcp(m); return; }
  if (m.type === "memory.view.result") { renderMemory(m); return; }
  if (m.type === "term.output") {
 // 终端流式输出(服务端已按行切片;stderr 走同通道带 err 标记)。
    termAppend(m.chunk || "", m.err ? "err" : "");
    return;
  }
  if (m.type === "term.exit") {
    termBusy = false;
    termAppend("[退出码 " + String(m.code === null || m.code === undefined ? "-" : m.code) + "]" + (m.killed ? "(已中止)" : ""), "dim");
    return;
  }
  if (m.type === "error" && String(m.code || "").startsWith("term-")) { termBusy = false; termAppend("错误:" + errorText(m.code, m.message), "err"); return; }
  if (m.type === "trace.stats.result") { traceStats[m.sessionId] = m.stats; renderHistory(); return; }
  if (m.type === "session.status.result") {
 // ssc2:水位登记(下次请求带 sinceSeq)。Tolerant Reader:旧网关回包无 seq 时**不写**
 // (否则下次发 sinceSeq:undefined);只记数字。回包 sessionId 缺失时退回当前会话(旧网关不回显
 // sessionId —— 浏览器经验证抓到:缺它则水位全落 undefined 键,请求永远不带宽水位)。
 // 放在 wf 早退之前,确保所有回包都记水位。
    const ssSeq = m.status ? m.status.seq : undefined;
    const ssSid = m.sessionId || currentSid;
    if (typeof ssSeq === "number" && ssSeq >= 0 && ssSid) ssSeqBySid.set(ssSid, ssSeq);
 // 重试态摄取(batch1b):服务端 gateway 内存镜像回填的权威值(切会话不清,靠它恢复);
 // 缺省=该会话无重试态(恢复/终态已在服务端清零),不留旧值。同样按会话落键(防 undefined 键)。
    if (ssSid) apiRetryBySid[ssSid] = (m.status && m.status.apiRetry) || null;
    if (viewLive("wf") && !(currentSid && m.sessionId === currentSid)) { wfStatus = m.status; wfRenderRuns(); return; }
 // 子代理实时清单摄取(B):过程卡的状态/tail 数据源;变化才重渲(T1 幂等挡住无变化重建)
 // title/model 一并入册(子代理目录「当前模型」列与条目标题的数据源)。
    const sl = m.status && m.status.subagentList;
    if (Array.isArray(sl)) {
      let subChanged = false;
      for (const a of sl) {
        const prev = subagentLive[a.agentId];
        if (!prev || prev.status !== a.status || prev.tail !== (a.tail || "") || prev.title !== (a.title || "") || prev.model !== (a.model || "")) subChanged = true;
        subagentLive[a.agentId] = { status: String(a.status || ""), tail: String(a.tail || ""), title: String(a.title || ""), model: String(a.model || "") };
      }
      if (subChanged && currentSid && viewLive("chat")) { renderChat(); refreshHist(); renderSubDir(); } // 终态/进度变化:即时重渲+增量拉史(卡片终态文本来自 journal 的 subagent.result,不拉史会闪「历史会话」兜底);目录同步刷新
    }
 // ssc2:采纳语义——不做本地叠加。服务端 memo 累积、每次回包都是该会话**完整累积投影**
 // (无论是否带 sinceSeq),故整包采纳覆盖即可;切会话已清水位 → 首帧必全量,不带上一会话残影。
    sessionStatus = m.status; renderStatusbar(); renderSubDir(); if (canvasActive() && viewLive("subchat")) subMsgRender(); // 注册表状态/模型/tail 到达即刷新选中式消息流(左栏状态点/pane 派发卡元信息);视口外不重渲
    wfStatus = m.status; wfRenderRuns(); return;
  }
  if (m.type === "session.status.changed") {
 // 推送化订阅:服务端任务变化即拉一次,替代等 3s 轮询(轮询留作断线兜底)。
 // fixF2: debounce 150ms 再拉——服务端已 200ms 合并广播,这里再挡一层(多标签页各自回拉/直发
 // 残留),连发只落末次;会话切换后旧会话的定时器到点即自弃(再核 currentSid)。
 // 帧内 lastActivityAt = 该会话最近动作时间 → 任何人(不只是当前会话)的活动都
 // 更新侧栏排序/行时间,并只在活动时间真推进时重渲侧栏(不等下一次 task.list)。
    if (typeof m.lastActivityAt === "number") {
      const before = sessionActivity.get(m.sessionId) || 0;
      noteSessionAct(m.sessionId, m.lastActivityAt);
      if ((sessionActivity.get(m.sessionId) || 0) > before) scheduleSidebarRefresh();
    }
    if (m.sessionId && m.sessionId === currentSid) {
      clearTimeout(ssChgTid);
      ssChgTid = setTimeout(function () {
        if (ws && ws.readyState === 1 && currentSid && currentSid === m.sessionId) {
          ssSendStatus(currentSid);
        }
      }, 150);
    }
    return;
  }
  if (m.type === "subagent.cancel.result") {
 // 目录「终止」按钮回包:成功=对账注册表状态;失败(句柄缺席等)=toast 如实提示,不假做成功。
    subCancelPending.delete(m.agentId);
    if (m.ok) toast("子 agent …" + esc(String(m.agentId).slice(-8)) + " 终止指令已送达");
    else toast("终止未执行:" + (m.reason || "未知原因"), true);
    if (currentSid) ssSendStatus(currentSid);
    return;
  }
  if (m.type === "project.list.result") {
    const prevActive = activeProjectId;
 // 面向新用户:默认根项目 __harness__ 不作为可见项目;首启项目区保持空态。
 // 服务端注册表仍保留它做 workdir 回退,协议不变。
 // 定稿(ZCode WorkspacePurpose 语义):purpose="conversation"(harness 根,Agent cwd 兜底)
 // 默认不显示为项目;用户显式「添加项目」该路径后服务端置 purpose="project" → 正常显示。
 // (上一版"恒显示 harness"过校正:ZCode 无 harness/默认项目概念,UI 无项目时列表为空并引导添加。)
    projects = (m.projects || []).filter((p) => p.purpose !== "conversation");
    if (pendingAddPath && projects.some((p) => p.path === pendingAddPath)) pendingAddPath = null; // 已入列=成功
 // 定稿:active 指向 conversation 型 workspace(未显式添加的 harness)时,可见列表无此项
 // → 回落首项(ZCode:无项目时 UI 空态;有项目则激活之);显式添加后 purpose=project 进列表可激活。
    activeProjectId = projects.some((p) => p.id === m.activeProjectId)
      ? m.activeProjectId
      : (projects[0] ? projects[0].id : null);
 // active 回落的显式前端处理(ref WorkspaceSidebarItem.tsx:380 closeTab→壳层回落相邻 tab):
 // 服务端把 active 归回 __harness__ 时,若原 active 项目确被移除,则优先回落相邻项目(列表内最近的非根项目),
 // 表内无其它项目=保持服务端值(根),不留指向已删项目的死引用。
    if (prevActive && prevActive !== activeProjectId && !projectById(prevActive)) {
      const neighbor = projects.find((p) => p.id !== "__harness__") || projectById("__harness__");
      if (neighbor && neighbor.id !== activeProjectId) { activeProjectId = neighbor.id; wsSafeSend(JSON.stringify({ v: 1, type: "project.activate", projectId: neighbor.id })); }
    }
    renderProjects(); renderSidebar(); if (viewLive("files")) filesLoad(); if (viewLive("ide")) ideLoad(); if (viewLive("dash") && dashScopeAuto) { dashScope = activeProjectId || "all"; dashLoad(); }
    if (viewLive("super")) { try { supRenderBoard(); } catch (e) { /* 指挥台看板重渲失败不影响主链 */ } } // 项目/可用性变化 → 看板②④刷新
 // 首启引导卡依赖 projects(添加项目后「2 添加项目」要变已完成)——空会话没有 task 事件回来重渲,这里补一拍。
    if (!histEvents || !histEvents.length) { try { renderHistory(); } catch (e) { /* 首帧未就绪:忽略 */ } }
    return; } // 侧栏重渲:分桶归类依赖项目注册表(先 tasks 后 projects 到达时不重渲会错桶);看板开着且自动挡=跟随当前项目重拉
 // ── RSI 运行看板回包(团队「RSI」子标签):解锁 in-flight + 渲染;看不到标签也静默渲染,不抛错 ──
  if (m.type === "rsi.status.result") { rsiInflight = false; clearTimeout(rsiUnlockTimer); rsiRender(m); return; }
 // ── RSI 机制交互回包( RSI-CTRL):成功/失败都各拉一拍 rsiStatusPull 刷新(不整页重载) ──
  if (m.type === "rsi.mechanism.set.result") {
    if (m.ok === false) toast("机制设置失败:" + (m.reason ? rsiReasonText(m.reason) : "未知原因"), true);
    rsiStatusPull();
    return;
  }
  if (m.type === "rsi.mechanism.run.result") {
    if (m.ok === false) {
      if (m.id !== undefined && m.id !== null) delete rsiPending[String(m.id)]; // 发起失败:收回乐观「运行中」
      toast("运行失败:" + (m.reason ? rsiReasonText(m.reason) : "未知原因"), true);
      rsiRerender();
    } else if (m.id !== undefined && m.id !== null) {
      var runMsg = "已启动运行" + (m.taskId ? " · 任务 " + String(m.taskId) : (m.runId ? " · 运行 " + String(m.runId) : ""));
      rsiPending[String(m.id)] = Date.now();
      toast(runMsg);
    }
    rsiStatusPull();
    return;
  }
  if (m.type === "rsi.item.result") {
    if (m.ok === false) toast("条目操作失败:" + (m.reason ? rsiReasonText(m.reason) : "未知原因"), true);
    else { rsiEditKey = ""; rsiArmKey = ""; clearTimeout(rsiArmTimer); }
    rsiStatusPull();
    return;
  }
 // ── RSI 自动周期回包( RSI-SELF-DRIVE):配置/推一拍的结论即时上条,再拉一拍 status ──
  if (m.type === "rsi.scheduler.result") {
    if (m.ok === false) toast("调度设置失败:" + (m.reason ? rsiReasonText(m.reason) : "未知原因"), true);
    else if (m.action) {
      var ssAct = { started: "已派发", retried: "已重试中断运行", running: "有运行中,等待", busy: "在线繁忙,让路", "not-due": "未到点", "cycle-done": "周期完成", "cycle-budget-stop": "超预算,本周期提前收口", "cycle-empty": "无可用机制", settling: "等待运行结账", disabled: "自动周期未开启", "breaker-paused": "熔断暂停中" };
      toast("自动周期:" + (ssAct[m.action] || String(m.action)) + (m.mechanismId ? " · " + String(m.mechanismId) : ""));
    } else toast(m.breakerResumed === true ? "已恢复熔断;自动周期配置已保存" : "自动周期配置已保存");
    if (m.state) { try { rsiSchedRender(m.state); } catch (e) { /* 渲染失败等下一次轮询 */ } }
    rsiStatusPull();
    return;
  }
 // ── 运行看板回包(ref dashboard /api/sessions+/api/trends 的 WS 对应物) ──
  if (m.type === "dashboard.sessions.result") { dashSessions = m.sessions || []; dashScopeLive = m.scope || "all"; dashRender(); return; }
  if (m.type === "dashboard.trends.result") { dashTrends = m; dashRender(); return; }
  if (m.type === "dashboard.changed") { dashPushAt = Date.now();
 // 子代理工作区实时增量:journal 广播(服务端 500ms 尾沿)到达且当前会话开着工作区 tab
 // → 节流拉 session.history 增量(subagent.event 随增量进 histEvents,激活中的 tab 即时重渲)。
 // 无 tab=零额外拉取,主会话行为不变(主流增量仍由 task.changed/子代理状态变化驱动)。
    if (currentSid && ((subWsSid === currentSid && subWsTabs.size > 0) || (canvasActive() && viewLive("subchat")))) { // 子agent会话流卡在场(选中式实时消息流)同样吃增量拉取,无卡=零额外拉取不变
      if (Date.now() - subWsPullAt > 1500) { subWsPullAt = Date.now(); refreshHist(); }
      else { clearTimeout(subWsPullTimer); subWsPullTimer = setTimeout(() => { subWsPullAt = Date.now(); refreshHist(); }, 1600); } // 节流窗内的广播不丢:尾沿补拉,最后一条消息也能上屏
    }
 // n6 兜底重拉(看板数据不更新):dashboard.changed 是「journal 有新事件」的通用推送,
 // 白板/任务追踪在场时也必须跟着重拉——否则只有 board.changed 一条道(board 广播一旦缺失,面板就
 // 永远定格)。这里复用既有 boardRefresh(清单+最近板)与 trackPull(追踪卡)链路,不新造取数通道;
 // 节流 1000ms + 尾沿补拉,防高频 dashboard.changed 打成板请求风暴。编辑态(在途/防抖保存)照旧拦截:
 // 与 board.changed 分支同口径——草稿不被回灌,靠 rev 乐观锁兜底。
    if (viewLive("board") || bfOpen) {
      const boardBusy = boardEditOn || !!bdLayoutTimer || bdLayoutInflight; // 编辑态/防抖保存待发/在途笔=不重拉(保护草稿)
 // 画布新鲜度:刚落过 board.doc(<1500ms)就跳过本拍兜底(同一条板不再读盘+整板重画;
 // board.changed 到位时数据本就是新的,兜底只为「广播缺失」留一条路)。
      const pull = () => { if (Date.now() - bdDocAt < 1500) return; bdDashPullAt = Date.now(); try { if (boardTaskId) boardGet(boardTaskId); else boardRefresh(); } catch (e) { /* 板视图资产缺失=跳过 */ } };
      if (!boardBusy) {
        if (Date.now() - bdDashPullAt > 1000) pull();
        else { clearTimeout(bdDashPullTimer); bdDashPullTimer = setTimeout(() => { if (!(boardEditOn || bdLayoutTimer || bdLayoutInflight)) pull(); }, 1050); } // 节流窗内的广播不丢:尾沿补拉
      }
    }
    if (viewLive("track")) { clearTimeout(trackDashTimer); trackDashTimer = setTimeout(() => { try { trackPull(); } catch (e) { /* 追踪卡不在场=跳过 */ } }, 800); } // 追踪卡:800ms 尾沿防抖重拉(既有 trackPull)
    if (viewLive("dash")) { clearTimeout(dashReloadTimer); dashReloadTimer = setTimeout(dashLoad, 300); } // journal 有新事件:节流重拉(推模型触发+拉模型取数)
 // 轨迹看板:每次 LLM 决策=journal 一条 llm.trace → dashboard.changed 到达时,看板开着就增量拉史
 // (session.history sinceSeq),让新卡及时上屏;1.2s 节流 + 尾沿补拉,不做整会话轮询。
    if (trajBoardOn() && currentSid) {
      if (Date.now() - trajDashPullAt > 1200) { trajDashPullAt = Date.now(); try { refreshHist(); } catch (e) { /* 拉史失败由常规通道兜底 */ } }
      else { clearTimeout(trajDashPullTimer); trajDashPullTimer = setTimeout(function () { trajDashPullAt = Date.now(); try { refreshHist(); } catch (e) { /* 同上 */ } }, 1250); }
    }
    return; } // journal 有新事件:节流重拉(推模型触发+拉模型取数)
  if (m.type === "board.archive.result") { dashArchive = m.items || []; if (viewLive("dash")) dashRender(); } // C:沉淀索引→板角标;不 return——沉淀区(arcItems)在后面还有既有消费方,early-return 会把设计沉淀整区吃瞎(board.spec 实测确认)
  if (m.type === "error" && String(m.code || "").startsWith("project-")) { uiAlert(errorText(m.code, m.message), { tone: "warning", title: "项目操作失败" }); return; }
  if (m.type === "task.diffstat.result") {
 // 变更条数据:缓存后重渲染(仅当前会话;sha=null=无快照,记空防重复拉)。
    diffstats.set(m.taskId, { files: m.files || [], total: m.total || { files: 0, add: 0, del: 0 }, sha: m.sha });
    if (histEvents && currentSid) { renderHistory(); renderSidebar(); }
    return;
  }
  if (m.type === "task.filediff.result") {
    if (ddSel && m.taskId === ddSel.taskId && m.file === ddSel.file) {
      if (m.error) $("ddBody").textContent = "无法获取补丁:" + m.error;
      else if (!m.diff) $("ddBody").textContent = "(无差异:可能是重命名/未跟踪文件)";
      else ddRender(m.diff, m.truncated);
    }
    return;
  }
  if (m.type === "models.probe.result") {
    if (modelProbe[m.model] && modelProbe[m.model].pending) probeDone++;
    modelProbe[m.model] = { ok: !!m.ok, ms: Number(m.ms || 0), error: m.error || "" };
 // 单行探活也参与「全部检测」进度(按钮文案恢复)
    const probeBtn = $("models-probe-all");
    if (probeBtn && !probeQueue.length && !probeActive) probeBtn.textContent = "全部检测";
    probeActive = Math.max(0, probeActive - 1);
    renderModelList();
    probePump();
    return;
  }
  if (m.type === "stats.summary.result") {
 // usage=用量仪表盘:服务端追加字段,旧服务无此键=undefined,仪表盘分区自动隐藏。
    statsCache = { at: Date.now(), data: m.summary, usage: m.usage };
    renderStats();
    quotaRender();
    return;
  }
  if (m.type === "task.submitted" || m.type === "task.changed") {
 // submitted 带全文 Task(正文进表 + 记 taskBodyIds);changed 只带 TaskIndex(合并 + 终态补拉正文)。
    if (m.type === "task.submitted") { taskBodyIds.add(m.task.id); tasks.set(m.task.id, m.task); }
    else { mergeTaskIndex(m.task); if (["done", "failed", "cancelled"].includes(m.task.state)) ensureTaskDetail(m.task.id); }
    render();
    notifyTaskDone(m.task);
    supTrackDispatch(m); // 派发卡:submittedBy=super 的任务实时帧 → super 聊天流(排队→运行→完成)
 // 追踪卡即时回写:任务状态一变就补拉一次,不等 4s 轮询拍点——
 // 用户用户反馈「任务都完成了,追踪卡却还停在 02 规划」。在场的卡才拉,视口外零额外开销。
    try { if (viewLive("track")) trackPull(); } catch (e) { /* 追踪卡不在场/资产缺失=跳过 */ }
 // Plan 审批卡(C19② 修复):先走通用任务更新,再叠加卡片渲染(原 early-return 吞掉上方全部)
    if (planApproval && m.task.id === planApproval.taskId) renderPlanApproval();
    if (m.task.sessionId === currentSid) {
      refreshHist();
      renderSendBtn();
 // 画布新鲜度:服务端广播的任务(队列泵/其它客户端/子代理/调度)也代表新数据,
 // 会话维度面板(白板/追踪/吞吐/子代理流)必须跟着刷新;1s 节流+尾沿,防状态翻转打成请求风暴。
      panelRefreshSoon(currentSid);
      if (m.task.state === "done" || m.task.state === "failed") {
        stStream = null; // 流式尾块退役:终态后全部以 journal 渲染为准
        wsSafeSend(JSON.stringify({ v: 1, type: "trace.stats", sessionId: currentSid }));
 // 变更条:终态即拉本任务 diffstat(echo 后端无快照→空,条隐藏)。
        wsSafeSend(JSON.stringify({ v: 1, type: "task.diffstat", taskId: m.task.id }));
      }
    }
  }
 // RSI-SESSION:固定会话窗的 history 回包先分流——绝不并入主会话 histEvents(全局单例污染)
  if (m.type === "session.history.result" && m.sessionId === RSI_EV_SID) { rsiEvOnHist(m); return; }
  if (m.type === "session.history.result") {
    const evs = m.events || [];
    const maxSeq = evs.length ? Math.max(...evs.map((e) => e.seq ?? 0)) : 0;
 // 三类回包(接 beforeSeq 分页契约,判据靠字段不靠猜):
 // ①翻页=本端刚点「加载更多历史」(游标在飞 + hasMore/nextBeforeSeq 在场)→ 更早的一页,去重后前插;
 // ②增量=sinceSeq 路径(无 hasMore)→ 追加尾部(运行中任务的新事件仍走这条,逐字保留);
 // ③首屏=limit 尾页/全量重放(分页字段可有可无,游标不在飞)→ 替换整列并记游标。
    const pageShaped = m.hasMore !== undefined || m.nextBeforeSeq !== undefined;
    if (pageShaped && m.sessionId !== undefined && currentSid && m.sessionId !== currentSid) {
      histPageLoading = false; // 切会话后旧会话的迟到分页回包:丢弃(防上一会话游标串到新会话)
      return;
    }
    if (pageShaped && histPageLoading) {
 // 翻页:服务端 seq 升序返回,新页整体早于已加载内容——按 seq 去重后插到最前(保序)。
      const known = new Set((histEvents || []).map((e) => e.seq));
      const older = evs.filter((e) => e.seq === undefined || !known.has(e.seq));
      histEvents = [...older, ...(histEvents || [])];
      histHasMore = m.hasMore === true;
      histNextBeforeSeq = histHasMore ? m.nextBeforeSeq : undefined; // 没了更早的:清游标(按钮随之隐藏)
      histPageLoading = false;
 // 顶窗(fixE22)下界是 parts 索引:前插新页后旧下界会把刚拉到的更早段压成占位(点了看不到)——
 // 翻页是用户主动回溯,窗口归零让已加载内容全真实可见(下轮开会话/骨架趟重算窗口)。
      mfWinLo = 0; mfWinSk = false; mfWinShiftFrom = -1;
    } else if (!pageShaped && m.since !== undefined && m.since > 0 && histSession === m.sessionId) {
 // 增量:追加新事件(按 seq 去重),推进水位。
      const known = new Set(histEvents.map((e) => e.seq));
      for (const e of evs) if (!known.has(e.seq)) histEvents.push(e);
 // 真事件到达后,丢弃乐观渲染的无 seq 占位(防双行)。
      if (evs.some((e) => e.kind === "message.user")) histEvents = histEvents.filter((e) => e.seq !== undefined || e.kind !== "message.user");
    } else {
 // 全量重放:空结果不清乐观占位(checkpoint 慢/任务未起 journal 尚空时,防附件卡闪没)。
      const opt = (histEvents || []).filter((e) => e.seq === undefined && e.kind === "message.user");
      histEvents = evs.some((e) => e.kind === "message.user") || !opt.length ? evs : [...opt, ...evs];
      histSession = m.sessionId;
 // 首屏(limit 尾页)记分页游标;老服务端/全量重放不给 hasMore → 按钮不显示。只认当前会话的回包。
      if (m.sessionId === undefined || m.sessionId === currentSid) {
        histHasMore = m.hasMore === true;
        histNextBeforeSeq = histHasMore ? m.nextBeforeSeq : undefined;
      }
      histPageLoading = false;
    }
    if (maxSeq > histLastSeq || histSession !== m.sessionId) histLastSeq = Math.max(histLastSeq, maxSeq);
    histSession = m.sessionId;
 // 流式尾块让位:真 message.agent 覆盖终稿草稿→清草稿;真 tool.result 覆盖执行中行→逐行撤。
    if (stStream && m.sessionId === stStream.sid) {
      let covered = false;
      for (const e of evs) {
        if (e.kind === "message.agent" && e.payload && e.payload.text && stStream.done) {
          const t = String(e.payload.text);
          if (t === stStream.text || (stStream.text.length > 0 && t.slice(0, Math.min(80, stStream.text.length)) === stStream.text.slice(0, Math.min(80, stStream.text.length)))) covered = true;
        }
        if (e.kind === "tool.result" && e.payload && e.payload.toolCallId)
          stStream.tools = stStream.tools.filter((x) => x.callId !== e.payload.toolCallId);
      }
      if (covered) stStream = null;
    }
 // 子代理流式草稿让位:真 subagent.event message.agent 到达 → 该 agent 的
 // 打字机草稿删除(journal 卡接管;工具行也一并让位给合并卡,同主会话语义)。
    for (const e of evs) {
      if (e.kind === "subagent.event" && e.payload && e.payload.kind === "message.agent") {
        const sid = "subagent-" + String(e.payload.taskId || "");
        if (sid !== "subagent-" && subStreams.has(sid)) subStreams.delete(sid);
      }
    }
    renderHistory();
    subMsgSync(evs); // 画布形态分身独立看板:子代理消息增量到达 → 子agent会话流/未读同步(经典形态内空操作)
 // 轨迹看板:每次 LLM 决策=一次更新。看板开着时按 histEvents 新增的 llm.trace
 // 追加卡片(仅文件序列变化才重渲),并仅当用户已在底部才自动滚到底 —— 上滚阅读时不被抢走。
    try { trajBoardLiveSync(); } catch (e) { /* 看板不在场/渲染异常不扩散到会话增量主链 */ }
  }
  if (m.type === "sys.meta.result") { sysMeta = m.meta || {}; renderProxyKv(sysMeta); renderAboutKv(sysMeta); renderSectionDyn(); }
  if (m.type === "cfg.get.result") { cfgView = m; renderModelPill(cfgView);
    if (window.__wsCfgHook) try { window.__wsCfgHook(m); } catch (e) {}
    cfgView = m;
    renderModelScoring();
 // 双 pill 显示同步:服务端持久配置为准(多客户端不打架;localStorage 只做首屏种子)。
    const cfgPerm = m.config && m.config.permissions && m.config.permissions.mode;
    if (cfgPerm && cfgPerm !== permModeV) {
 // 首同步就分叉=服务端真值与本机上次选择不同(其他面板/浏览器 e2e 改过全局配置)——
 // 无声翻转正是「每次询问和真实值对不上」体感的来源,toast 把翻转换手说清楚。
      if (!permSynced) toast("权限模式按服务端真实值同步为「" + ((PERM_MODES.find((x) => x.v === cfgPerm) || {}).label || cfgPerm) + "」(与你本机上次选择不同;全局配置可能被其他客户端修改)", true);
      permModeV = cfgPerm; localStorage.setItem("zh:perm-mode", cfgPerm); pillRender();
    }
    if (!permSynced) { permSynced = true; pillRender(); } // 首包到达:同步中→确认态(pillRender 内摘 .sync)
    const cfgEff = m.config && m.config.coding && m.config.coding.llm
      && (m.config.coding.llm.implementationEffort !== undefined ? m.config.coding.llm.implementationEffort : m.config.coding.llm.reasoningEffort);
    if ((cfgEff || "") !== (effortV || "") && !pillTouched) { effortV = cfgEff || ""; localStorage.setItem("zh:effort", effortV); pillRender(); }
    if (provDraft === null) {
      provDraft = ((m.config && m.config.providers) ? JSON.parse(JSON.stringify(m.config.providers)) : []);
 // 主端点未入库时生成首条并立即落盘(测试连接需要服务端 config 里存在该 provider)
      const cl0 = (m.config && m.config.coding && m.config.coding.llm) || {};
      if (!provDraft.length && cl0.baseUrl) {
        provDraft.push({ id: "main", name: "Coding 端点", baseUrl: cl0.baseUrl, apiKeyEnv: cl0.apiKeyEnv, models: [] });
        sendProviders();
      }
    } else {
      provDraft = ((m.config && m.config.providers) ? JSON.parse(JSON.stringify(m.config.providers)) : provDraft);
    }
    browserCfgRender();
    const mcpCfg = m.config && m.config.browser;
    localStorage.setItem("zh:cfg-mcp", "0"); // 占位:引导的 mcp 勾选由管理面拉取决定(简化:有服务器即勾)
    renderCfg(); renderProviders(); renderModelList(); renderSectionDyn(); renderModelSwitch(); refreshSecretKeyState();
  }
  if (m.type === "cfg.secret.result") {
    const w = m.rid ? secretWaiters[m.rid] : null;
    if (w) { delete secretWaiters[m.rid]; w(m); }
  }
  if (m.type === "cfg.set.result") {
    permPendingMode = null; // ack:权限翻转落定(审计 C10/C11 在飞标记清零)
 // 工具提供商保存回执:按回包如实提示 + 重拉 cfg.get 刷新状态行/选中态。
 // 旧实现保存后不重拉配置,状态行停在旧值 —— 用户看到的就是「点了没反应」。
    const wsTouched = (m.applied || []).concat(m.needsRestart || []).some((p) => String(p).startsWith("web.search."));
    if (wsTouched || (wsSavePending && Date.now() - wsSavePending < 20000)) {
      wsSavePending = 0;
      const hot = (m.applied || []).some((p) => String(p).startsWith("web.search."));
      toast(hot ? "工具提供商配置已生效(下一次 web_search 使用)" : "工具提供商配置已写入(重启网关后生效)");
      try { wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" })); } catch (e) { console.warn("[ws-cfg] 重拉配置失败:", e && e.message); }
    }
 // 按补丁归属分徽标:llm.*→主模型,llm.maxTokens→mt,models.*→对应角色(四角色)
    const applied = m.applied || [], nr = m.needsRestart || [];
    const badgeFor = (paths) => {
      const hot = paths.filter((p) => applied.includes(p)).length;
      const cold = paths.filter((p) => nr.includes(p)).length;
      if (hot && cold) return ["部分热应用 · 其余重启生效", "sd cfg-wait"];
      if (hot) return ["已热应用", "sd cfg-ok"];
      if (cold) return ["已写入 · 重启生效", "sd cfg-wait"];
      if (!paths.length) return ["无变化", "sd"];
      return ["", ""];
    };
    const setB = (id, txt, cls) => { const el = $(id); if (!el) return; el.textContent = txt || "—"; el.className = cls || "sd"; };
    const mainPaths = ["coding.llm.model", "coding.llm.providerId", "coding.llm.baseUrl", "coding.llm.apiKeyEnv", "coding.llm.timeoutMs"];
    let b = badgeFor(applied.concat(nr).filter((p) => mainPaths.includes(p)));
 // env 占用升格(模型切换失效用户反馈):被 GENIE_LLM_* 压住的键,「重启生效」是假话——
 // 徽标直接说「env 占用,重启也不生效」,并 toast 点名要清的变量(与 pillPickModel 的热生效话术互斥场景)。
    const envOcc = (m.envOccupied || []).filter((p) => mainPaths.includes(p) || p.startsWith("audio.chat."));
    if (envOcc.length) {
      setB("role-main-badge", "已写入 · env 占用,重启也不生效(清 GENIE_LLM_* 后再启)", "sd cfg-wait");
      const vars = envOcc.map((p) => p.includes("audio") ? "GENIE_AUDIO_CHAT_*" : "GENIE_LLM_*").join(" ");
      toast("模型切换被环境变量压住(" + vars + ")——写进配置了但运行时/重启都不会用它;从网关启动环境清掉这些变量", true);
    } else if (m.routeError) {
 // 凭据不可解析/端点缺失=已写配置但没热切——旧实现只显示「已热应用」,用户要到下个任务才看见 401。
      setB("role-main-badge", "未热切 · " + String(m.routeError).slice(0, 60), "sd cfg-wait");
      toast("模型已写入但未热切:" + m.routeError, true);
    } else if (m.effective) {
 // 实际生效选择(Provider Registry 语义):把「模型 / 端点 / 协议 / 凭证来源」一次说清。
      const eff = m.effective;
      const where = eff.providerId || eff.baseUrl;
      const cred = eff.credentialSource === "secrets" ? "本机密钥"
        : eff.credentialSource === "env" ? "环境变量"
        : eff.credentialSource === "legacy-env" || eff.credentialSource === "legacy-secrets" ? "旧 GENIE_LLM_API_KEY 兜底"
        : "未解析";
      setB("role-main-badge", "已热应用 · " + eff.model + " @ " + where + " (" + eff.apiType + ")", "sd cfg-ok");
      toast("主模型已生效:" + eff.model + " @ " + where + " · " + eff.apiType + " · 凭证:" + cred + (eff.unverified ? " · 未验证模型" : ""), eff.unverified);
    } else if (b[0]) setB("role-main-badge", b[0], b[1]);
    if (m.warning) toast(m.warning, true);
    b = badgeFor(applied.concat(nr).filter((p) => p === "coding.llm.maxTokens"));
    if (b[0]) setB("cfg-mt-badge", b[0], b[1]);
    for (const role of ["subagent", "compact", "review"]) {
      b = badgeFor(applied.concat(nr).filter((p) => p.startsWith("coding.models." + role + ".")));
      if (b[0]) setB("role-" + role + "-badge", b[0], b[1]);
    }
    b = badgeFor(applied.concat(nr).filter((p) => p.startsWith("audio.chat.")));
    if (b[0]) setB($("a-chat-badge").textContent === "应用中…" ? "a-chat-badge" : "a-chat-url-badge", b[0], b[1]);
    b = badgeFor(applied.concat(nr).filter((p) => p.startsWith("audio.asr.")));
    if (b[0]) setB("a-asr-badge", b[0], b[1]);
    b = badgeFor(applied.concat(nr).filter((p) => p.startsWith("audio.tts.")));
    if (b[0]) setB("a-tts-badge", b[0], b[1]);
    b = badgeFor(applied.concat(nr).filter((p) => p.startsWith("concurrency.")));
    if (b[0]) setB("cfg-cc-badge", b[0], b[1]);
    if (applied.some((p) => p === "coding.llm.model" || p.startsWith("coding.llm."))) {
      modelSwitchNotice = { cls: "ok", text: "全局主模型已更新" + (nr.length ? "(部分需重启)" : "") };
    }
    renderModelSwitch();
    wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" }));
  }
  if (m.type === "models.list.result") {
    const dl = $("model-ids");
    dl.innerHTML = (m.ids || []).map((id) => '<option value="' + esc(id) + '"></option>').join("");
    lastModelIds = m.ids || [];
    renderModelList();
    if (m.probeOnly && m.providerId) {
 // 只读探测回包——仅报连通与可见模型数,不合并目录、不动 provDraft
      provTestState[m.providerId] = { ok: true, msg: "连接成功 · 端点可见 " + (m.ids || []).length + " 个模型(目录未改动;要并入点「拉取目录」)" };
      renderProviders();
    } else if (m.providerId && provDraft) {
      const pv = provDraft.find((x) => x.id === m.providerId);
      if (pv) {
 // 测试连接/拉取只合并新增模型,保留既有元数据(上下文/最大输出/能力标记)与自定义条目。
        const existing = pv.models || [];
        const byName = new Map(existing.map((mm) => [modelNameOf(mm), mm]));
        const merged = existing.map((mm) => byName.get(modelNameOf(mm)));
        for (const id of (m.ids || [])) if (id && !byName.has(id)) merged.push(id);
        pv.models = merged;
        provTestState[m.providerId] = { ok: true, msg: "拉取完成 · 目录已合并到 " + ((pv.models && pv.models.length) || 0) + " 个模型" };
        sendProviders(); renderProviders();
      }
    } else $("models-status").textContent = (m.ids || []).length + " 个模型(已进入模型目录)";
  }
  if (m.type === "error" && /models/.test(m.code || "")) {
    modelSwitchNotice = { cls: "err", text: "模型目录拉取失败:" + redactPaths(errorText(m.code, m.message)).slice(0, 60) };
    renderModelSwitch();
    $("models-status").textContent = "失败:" + redactPaths(errorText(m.code, m.message)).slice(0, 60);
 // pill 兜底拉取路径(modelMenuPending 在场=用户停在 chat 视图,状态行不可见)——
 // 清 pending 防陈旧,补 toast 保持 fail-visible;设置页路径走状态行不双报。
 // u6:兜底拉取失败 → 触发器位置转为红色「模型加载失败,重试」(点击重发 models.list)
    if (modelMenuPending) {
      modelMenuPending = null;
      modelListFailed = true;
      renderModelPill(cfgView);
      errToast(m, "模型列表拉取失败");
    }
    if (lastTestId) {
      provTestState[lastTestId] = { ok: false, bad: true, msg: "连接失败:" + redactPaths(errorText(m.code, m.message)).slice(0, 50) };
      renderProviders();
    }
  }
  if (m.type === "error" && /cfg/.test(m.code || "")) {
 // 工具提供商保存被拒:此前只写 role-main-badge,用户在工具提供商区看不到任何原因。
    if (/^cfg(-|\.)/.test(m.code || "") && wsSavePending) {
      wsSavePending = 0;
      toast("工具提供商配置保存失败:" + errorText(m.code, m.message).slice(0, 200), true);
      try { wsSafeSend(JSON.stringify({ v: 1, type: "cfg.get" })); } catch (e) { console.warn("[ws-cfg] 重拉配置失败:", e && e.message); }
    }
    const cb = $("role-main-badge");
    if (cb) { cb.textContent = "失败:" + errorText(m.code, m.message).slice(0, 60); cb.className = "sd"; }
 // 权限翻转被拒(cfg-set-failed,如 schema 拒绝)→ 精确回滚 pill(审计 C10/C11;permPending 区分出 perm 补丁,不误伤 effort 等)
    if (permPendingMode) {
      permPendingMode = null;
      permModeV = permPriorMode || "ask";
      localStorage.setItem("zh:perm-mode", permModeV);
      pillRender();
      errToast(m, "权限切换失败");
    }
  }
  if (m.type === "error" && /sense/.test(m.code || "")) { $("sense-status").textContent = "查询失败:" + errorText(m.code, m.message).slice(0, 80); }
  if (m.type === "exp.list.result") { expItems = m.items || []; expDisabled = m.disabled || []; renderExp(); renderSectionDyn(); }
  if (m.type === "exp.remove.result") {
 // 删除回执:刷新列表 + 提示(ok=false 多为已被并发删除)。
    if (m.ok) toast("已删除经验 " + m.category + "/" + m.name);
    else toast("删除失败:未找到 " + m.category + "/" + m.name + "(可能已被删除)", true);
    $("exp-body").style.display = "none";
    wsSafeSend(JSON.stringify({ v: 1, type: "exp.list" }));
  }
  if (m.type === "exp.view.result") {
 // teamai share 流程:pendingShare 在场=读正文是为了推团队仓,不改写经验面板。
    if (pendingShare && m.category === "coding" && m.name === pendingShare.name) {
      const body = String(m.body || "");
      if (!body) { toast("经验不存在,无法分享:" + m.name, true); pendingShare = null; return; }
      const firstLine = body.split(NL).find((l) => l.trim() && !l.startsWith("#")) || m.name;
      wsSafeSend(JSON.stringify({ v: 1, type: "teamai.push", ns: "common", name: pendingShare.name, description: firstLine.slice(0, 80), body }));
      pendingShare = null;
      toast("teamai push:正在把 " + m.name + " 推团队仓(分支+MR)…");
      return;
    }
    $("exp-body").style.display = "block";
    $("exp-body").textContent = m.body ? ("【" + m.category + " / " + m.name + "】" + NL + NL + m.body) : "(条目不存在)";
  }
  if (m.type === "teamai.push.result") {
    toast(m.ok ? "teamai push 完成:分支 " + (m.branch || "") + "(等 reviewer 合并)" : "teamai push 失败:" + (m.reason || "未知"), !m.ok);
    if (m.ok) wsSafeSend(JSON.stringify({ v: 1, type: "teamai.pull" }));
    return;
  }
  if (m.type === "error" && (String(m.code || "").startsWith("voice-") || m.code === "companion-failed")) { errToast(m, "语音失败"); return; }
  if (m.type === "board.list.result") {
    if (m.sessionId !== currentSid) return;
 // n12/n14:items 原样收编——docKind(多板按类型过滤)与 pendingComments(未处理评论 chip)都在里面,
 // 不得挑字段重建(挑字段=新字段被吃,chip/过滤永久空)。
    boardItems = m.items || [];
 // 待读评论按 taskId 归集(count 来自服务端 peek 队列;nodes 是本地已知的具体节点,重拉时保住不清)
    const prevPending = boardListPending || {};
    const nextPending = {};
    for (const it of boardItems) {
      const c = Number((it && it.pendingComments) || 0);
      if (!(c > 0)) continue;
      const old = prevPending[it.taskId];
      nextPending[it.taskId] = { count: c, nodes: old && old.nodes ? old.nodes : [] };
    }
    boardListPending = nextPending;
    boardListSkipped = Number(m.skipped || 0); // 损坏/不可读板文件数(显式降级依据)
    if (boardItems.length) boardListRetry = 0;
 // n12 「待读评论」专用的轻量清单刷新(见 bdPendingRefresh):只更新 chip/高亮,不重钉选择、不重拉板——
 // 否则 board.doc → 拉 list → 回包再 boardGet → board.doc 无限回环。
    if (boardListPendingOnly) {
      boardListPendingOnly = false;
      renderBoardPanel();
      if (viewLive("board")) renderBoard();
      return;
    }
 // G1 修复:钉选板(chip 直达/选择器选中)不在清单=板上文件已删/损坏——
 // 显式降级,绝不静默滑到别的板(此前回落 items[0],用户看到的不是她点的板,经验证 hijack 注意)。
    const pinnedMissing = boardTaskId && !boardItems.some((i) => i.taskId === boardTaskId);
 // 未指定任务=主设计板;有指定(任务卡 chip 直达)=保住选择
 // 同 session 多板:默认不再取「最新一块」——同一个 session 会先后落多块板
 // (设计板/视图配置板/基线表板),最新那块常常只有 6~9 个节点,打开就看不到主设计。
 // 改为「节点数最多的一块」,并列时取列表更靠前者(列表按新→旧,即取最新);nodeCount 缺失按 0。
    const want = pinnedMissing ? "" : (boardTaskId || cvDefaultBoardId(boardItems));
    if (pinnedMissing) {
      boardMissing = boardTaskId; // 降级渲染依据(renderBoard 读)
      boardDoc = null;
      boardOverlayB64 = null; sessionOverlayB64 = null;
      renderBoard();
    } else if (want) { boardMissing = ""; boardGet(want); }
    else {
 // drvfs 写后立读窗(九期):list 空≠无板——板视图开着时限次自动重拉(2s×3),期间保持空态渲染;
 // 但 skipped>0=文件在而读不出(确定性损坏,重拉无用)——直接降级,不等重拉窗。
 // 无板=批注回落会话级(__session__):boardTaskId 必须归零,否则旧 taskId 残留会让
 // overlayPull 拒拉会话批注、wbSave 把新笔迹写进不存在的旧板(批注串台修复之一)。
      if (boardTaskId) {
        boardTaskId = "";
        boardOverlayB64 = null; sessionOverlayB64 = null;
        wbAbortStroke();
        wbRestore();
        overlayPull(); // 上下文刚切回 __session__,补拉会话批注
      }
      boardMissing = "";
      boardDoc = null; renderBoard();
      if (!boardListSkipped && viewLive("board") && (boardListRetry || 0) < 3) {
        boardListRetry = (boardListRetry || 0) + 1;
        setTimeout(() => { if (currentSid === m.sessionId && viewLive("board")) { boardItems = []; boardRefresh(); } }, 2000);
      } else boardListRetry = 0;
    }
    renderBoardPanel(); // 浮窗板清单跟随(boardItems 就绪;浮窗未开时是 no-op)
    return;
  }
  if (m.type === "board.archive.result") {
    arcItems = m.items || [];
    arcRender();
    if (ppfLast) ppfRenderFns(ppfLast); // 函数行反查角标跟随索引(索引晚于文件数据到达时补渲)
    return;
  }
  if (m.type === "board.overlay.result") {
    if (m.sessionId !== currentSid || boardTaskId) return; // 语义板通道优先,不混淆
    sessionOverlayB64 = m.dataB64 || null;
    if (viewLive("board")) {
 // 会话切换/无批注恢复(串台修复):wbRestore 先清后画(无数据=白板);
 // 在途笔画不打断(这条只刷新会话批注缓存,不是换板上下文)。
      if (!wbDrawing) wbRestore();
    }
    return;
  }
  if (m.type === "board.diagram.result") {
 // flowkit 单张 SVG 回包(请求在 cvSvgRequest):缓存 svg + 记签名 → 重渲整块。
 // 失败(ok=false / error / 空 svg)=保持卡片累加出来的世界尺寸与空 #cvSvgHost,不崩不白屏。
    const cvSvgReqSig = cvSvgPending; // 回包认领的是哪一版请求(先取再清)
    cvSvgPending = "";
    if (m.sessionId && currentSid && m.sessionId !== currentSid) return;
    try {
      if (m.ok && m.svg) {
        cvSvgCacheHtml = String(m.svg);
        cvSvgCacheSig = cvSvgReqSig || (boardDoc ? cvSvgSig(boardDoc) : "");
        if (viewLive("board")) renderBoard();
      } else if (m.error) {
        try { toast("白板出图失败:" + String(m.error), true); } catch (e) { /* toast 失败不影响画布 */ }
      }
    } catch (e) { /* 回包畸形/宿主不在场:静默 */ }
    return;
  }
  if (m.type === "board.doc") {
 // 设计沉淀只读画布分流:拉的是沉淀板(档案灯箱),渲染进灯箱宿主,不碰会话板全局
    if (arcOpen && m.sessionId === arcSid) { arcOnDoc(m); return; }
    if (m.sessionId !== currentSid) return;
    bdDocAt = Date.now(); // :任何 board.doc 回执都刷新兜底水位(含在途/编辑态丢弃路径)
 // c2:评论写请求的成功回执(board.comment 服务端回 board.doc)——清掉在途标记,
 // 免得紧随其后的无关错误帧被误认领成「评论被拒」。
    if (bdLastCmtReq && (!m.taskId || m.taskId === boardTaskId)) bdLastCmtReq = null;
    const wasLayoutInflight = bdLayoutInflight; // 续作轮:先抓在途旗再解除
    const hadPendingLayout = !!bdLayoutTimer; // 防抖挂起=本地有尚未发往服务器的新编辑(0-900ms 危险窗)
    bdLayoutInflight = false; // 直改板保存回执(十期:在途旗解除,下一笔可发)
 // A2「在途不丢」:在途窗内又发生了结构变更(排了队)→ 本笔回执处理完(rev 已前移)再补发。
 // 用 setTimeout(0) 是为了让 rev 前移/结构收编先落地,补发笔的 baseRev 才是新的。
    if (bdSaveQueued) setTimeout(() => { try { bdSaveFlushQueued(); } catch (e) { /* 补发失败不影响回执处理 */ } }, 0);
 // 续作轮:直改板编辑未落服务器前(在途或防抖挂起),任何 board.doc 回执都可能是旧快照——
 // 整板回灌会把本地新编辑静默回滚。两类注意:①在途窗内删边被回执「复活」;②整理布局后 900ms 内
 // 迟到的刷新回执把 grid 冲回 fractional(随后的防抖保存把旧布局固化落盘)。
 // 处置=回执内容与本地现状不一致时只收编 rev/连接态/批注层,结构以本地为准;一致(=本在途笔自身回执)照常落地。
    if ((wasLayoutInflight || hadPendingLayout) && boardDoc && !boardEditOn && (!bdSentSig || bdSentStructSig(boardDoc) !== bdSentSig)) {
      bdSentSig = "";
      if (m.doc) {
        boardDoc.rev = m.doc.rev; // 只前移 rev;结构(nodes/edges/pos/summary/flow)保持本地(含未落服务器的新编辑)
        boardLinks = m.links || boardLinks;
        boardTaskId = m.taskId || boardTaskId;
        boardOverlayB64 = m.overlayB64 || boardOverlayB64;
 // 服务端合并权威字段照常收编:评论(board.comment 服务端合并)/done(评论带 done)/状态/对账回填——
 // 否则评论回显等在防抖窗内被误丢(首版经验证:浮窗评论回显 FAIL)
        const rnodes = new Map((m.doc.nodes || []).map((n) => [n.id, n]));
        for (const ln of boardDoc.nodes) {
          const rn = rnodes.get(ln.id);
          if (!rn) continue;
          if (rn.comments && rn.comments.length) ln.comments = rn.comments;
          if (rn.done) ln.done = true;
        }
        if (m.doc.status) boardDoc.status = m.doc.status;
        if (m.doc.actual_files && m.doc.actual_files.length) boardDoc.actual_files = m.doc.actual_files;
      }
      return;
    }
    bdSentSig = "";
 // 编辑态下非本人保存回执的迟到 board.doc(历史 boardGet/广播重拉)——不更新 boardDoc
 // 不重渲:保草稿基线(boardSave 的 baseRev 语义不被悄悄前移)+在填文本不被重渲冲掉
 // (B6 只挡了 board.changed,board.doc 是漏网口,boardsense spec 经验证表单被迟到回包冲掉)。
    if (boardEditOn && boardDraft && m.taskId === boardTaskId && !boardSaveInflight) {
      toast("白板有新版本(rev " + (m.doc ? m.doc.rev : "?") + ")——你在编辑中;保存时按 rev 冲突处置", true);
      return;
    }
 // 画布新鲜度:回包与本地完全一致(rev + 结构签名)时不付整板 DOM 重建——
 // agent 高频写板时每次都全量重画是画布卡顿主源之一。
    const prevDocRev = boardDoc ? boardDoc.rev : null;
    const prevDocSig = boardDoc ? cvStructSig(boardDoc) : "";
    const prevDocTask = boardTaskId || ""; // 换板(同 rev 同签名)也必须重画:任务 id 进同一性判据
    boardDoc = m.doc || null;
    boardLinks = m.links || [];
    boardTaskId = m.taskId || boardTaskId;
 // 显式请求(taskId 非空)却 doc:null = 板上文件在拉取间隙被删/损坏——挂降级标记,
 // renderBoard 据此显示「不存在或损坏」而不是「还没有设计白板」(清单空态)或静默滑到别的板。
    boardMissing = !m.doc && m.taskId ? m.taskId : (m.doc ? "" : boardMissing);
    boardOverlayB64 = m.overlayB64 || null;
    if (!boardDoc || (boardSelNode && !boardDoc.nodes.some((n) => n.id === boardSelNode))) boardSelNode = null;
    if (boardSaveInflight) {
 // 保存回执:退编辑态+重拉(拿新鲜连接三态)
      boardSaveInflight = false;
      boardEditOn = false; boardDraft = null; boardConflict = null; // 保存成功=冲突已解
      toast("白板已保存(rev " + (boardDoc ? boardDoc.rev : "?") + ")");
      if (boardDoc) boardGet(boardTaskId);
    }
 // 批注层(刷新/重登空白+串台修复):框开着立即按新语义恢复——先清后画,
 // 有服务端图换服务端,没有=白板(空白是合法态,防残留上一板笔迹);在途笔画作废(半笔
 // 不允许混进换源后的画布)。框关着不画:数据已挂在 boardOverlayB64,toggle 展开时
 // wbResize→wbRestore 补恢复(刷新后批注框默认收起,board.doc 先到的场景靠这条兜住)。
    if ($("boardSketchBox") && $("boardSketchBox").open) { wbAbortStroke(); wbRestore(); }
 // fixD5: 回执板不在当前清单(「从代码生成」「从洞察生成」等新板首达)→ 补拉清单同步选择器/浮窗板列表。
 // 旧实现只切画布不动 boardItems:新板已渲染但顶部选择器显示旧板标题、清单缺项,要手动刷新才对齐。
    if (m.taskId && boardTaskId && !boardItems.some((i) => i.taskId === m.taskId)) boardRefresh();
 // 内容未变(同一 rev 且结构签名一致)→ 跳过整板重画,只同步浮窗;变了才重画。
    const sameDoc = !!boardDoc && prevDocRev === boardDoc.rev && prevDocSig === cvStructSig(boardDoc);
    if (!sameDoc) renderBoard();
    bdDocAt = Date.now();
    renderBoardPanel(); // 五期:浮动面板实时跟随(agent 落实模块 done 勾/评论即时可见)
 // n12:评论刚落盘(board.comment 回执=board.doc)时刷新「待读评论」计数——15s 节流,轻量重拉
 // (boardListPendingOnly 置位 → 回包不重钉选择/不重拉板,故不会和本处形成 board.doc↔board.list 回环)。
 // 选「重拉一次 list」而不是「就地清零」:评论刚写进去时计数本来就该是 1+ 而不是 0,清零是相反语义。
    if (Date.now() - (bdPendingPullAt || 0) > 15000) {
      bdPendingPullAt = Date.now();
      try { bdPendingRefresh("pull"); } catch (e) { /* 旧脚本缓存=忽略 */ }
    }
    return;
  }
  if (m.type === "board.conflict") {
 // rev 乐观锁冲突(体验改造):不再直接弃草稿——草稿保留+明细区冲突条,
 // 用户自选「拉取最新放弃草稿」或「继续编辑(可先把改动复制走)」。
    boardSaveInflight = false;
    bdLayoutInflight = false; // 直改板在途旗解除(十期)
 // A2:冲突时排队的那一笔作废(它的 baseRev 已过期),别在冲突处置后再补发撞第二枪
    if (bdSaveQueued) { bdSaveQueued = false; if (bdLayoutTimer) { clearTimeout(bdLayoutTimer); bdLayoutTimer = null; } }
    if (boardEditOn && boardDraft) {
      boardConflict = { taskId: m.taskId, currentRev: m.currentRev };
      try { bdSyncDraftFromForm(); } catch (e) { /* 收编失败不阻塞冲突处置 */ } // 冲突条重渲前先收编在填表单(防未同步文本被重渲丢掉)
      toast("白板已被并发更新(当前 rev " + m.currentRev + ")——草稿已保留,明细区选处置方式", true);
      renderBoardDetail();
    } else {
 // 非编辑态(直改板落盘冲突):无草稿可保,照旧拉最新
      toast("白板已被并发更新(当前 rev " + m.currentRev + "),已刷新最新版", true);
      boardGet(m.taskId);
    }
    return;
  }
 // c2:评论写请求被服务端**整笔拒收**(board-invalid=board-store saveBoard 门禁:done 板 P0 验收证据未
 // 覆盖全会整笔拒收;另含节点不存在/评论下标越界/内容为空/板不存在)。这类 error 帧不带 sessionId/taskId,
 // 只能按「最近一笔评论写请求」认领(8s 窗;成功回执 board.doc 会清标记)。旧实现里这条错误帧落到下方
 // board-invalid 分支被当成「白板保存」提示、或干脆被后续兜底吞掉 → 用户看到编辑框收起、评论还是原文,
 // 却完全不知道被拒了。这里给可读原因,且**不**把 UI 改成已保存态(不重渲、不改文本,保持原文)。
  if (m.type === "error" && bdLastCmtReq && Date.now() - bdLastCmtReq.at < 8000
    && (m.code === "board-invalid" || m.code === "comment-text-empty" || m.code === "comment-index-out-of-range"
      || m.code === "board-node-not-found" || m.code === "board-not-found")) {
    const req = bdLastCmtReq;
    bdLastCmtReq = null;
    const raw = String(m.message || "");
    const why = /证据未覆盖|P0/.test(raw)
      ? "板已 done 且 P0 验收未覆盖全,评论未保存(先补跑验收并用 board_upsert action=evidence 回填再置 done)"
      : errorText(m.code, m.message); // 其余拒收原因照样按 code 出人话(error-text 单一出处)
    toast("评论" + (req.op === "update" ? "修改" : req.op === "delete" ? "删除" : "提交") + "被拒,未保存:" + why, true);
    return;
  }
  if (m.type === "error" && m.code === "board-invalid") {
    boardSaveInflight = false;
    errToast(m, "白板保存被拒");
    return;
  }
 // 工作流板:编译回包(编译预览+执行前奏)——脚本进明细区,错误 fail-visible 全列出
  if (m.type === "board.workflow.compile.result") {
    if (m.sessionId !== currentSid || m.taskId !== boardTaskId) return;
    const box = bdDetailHost();
    if (!box) return;
    if (m.ok) {
      wfCompilePreview = m.script || "";
      const cnt = (m.order || []).length;
      box.innerHTML = '<div class="bd-name" style="font-size:13px">编译通过(' + cnt + " 节点入序)</div>" +
        '<div class="bd-meta">harness-workflow 脚本(引擎直跑形态;「编译执行」用它)</div>' +
        '<textarea readonly rows="18" style="width:100%;margin-top:6px;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);border-radius:8px;padding:6px 8px;font-size:11px;font-family:var(--mono)">' + esc(wfCompilePreview) + "</textarea>";
      toast("编译通过:" + cnt + " 节点");
    } else {
      wfCompilePreview = "";
      box.innerHTML = '<div class="bd-name" style="font-size:13px;color:#e08a7a">编译失败(' + (m.errors || []).length + " 项)</div>" +
        (m.errors || []).map((e2) => '<div class="bd-meta" style="margin-top:4px">· ' + esc(e2) + "</div>").join("") +
        '<div class="bd-meta" style="margin-top:8px">修法:环=删一条边;缺参数=双击节点开配置抽屉;多出口=用 wf-parallel/wf-condition。</div>';
      toast("编译失败:" + (m.errors || []).length + " 项(明细区已列出)", true);
    }
    return;
  }
 // 工作流板:运行进度(节点状态实时点亮——增量切类,不整板重渲)
  if (m.type === "board.workflow.progress") {
    if (m.sessionId !== currentSid || m.taskId !== boardTaskId) return;
    const r = wfRuns[m.taskId] || (wfRuns[m.taskId] = { wfId: m.wfId, states: {}, done: false });
    r.wfId = m.wfId;
    r.states = m.states || {};
    r.done = false;
    bdWfApplyStates(r.states);
    return;
  }
 // 工作流板:运行终态(编译失败 errors / 跑完 ok+items;states 全量落 wfRuns)
  if (m.type === "board.workflow.result") {
    if (m.sessionId !== currentSid || m.taskId !== boardTaskId) return;
    const r = wfRuns[m.taskId] || (wfRuns[m.taskId] = { wfId: m.wfId, states: {}, done: false });
    r.wfId = m.wfId;
    r.done = true;
    r.ok = m.ok;
    if (m.states) r.states = m.states;
    if (m.errors) r.errors = m.errors;
    if (m.error) r.error = m.error;
    if (m.items) r.items = m.items;
    if (m.durationMs !== undefined) r.durationMs = m.durationMs;
    bdWfApplyStates(r.states);
    if (m.ok) toast("工作流跑完:" + (m.durationMs ?? "?") + "ms · " + ((m.items || []).length) + " 条成果(journal 留痕)");
    else {
      const why = (m.errors && m.errors.length) ? m.errors[0] : (m.error || "未知错误");
      toast("工作流运行失败:" + String(why).slice(0, 120), true);
    }
 // 明细区:终态摘要(选中节点则节点明细带运行态,否则板级摘要)
    if (!boardSelNode && bdDetailHost()) {
      const st = r.states || {};
      const doneN = Object.values(st).filter((x) => x.state === "done").length;
      const failN = Object.values(st).filter((x) => x.state === "failed").length;
      bdDetailHost().innerHTML = '<div class="bd-name" style="font-size:13px">' + (m.ok ? "运行完成" : "运行失败") + "</div>" +
        '<div class="bd-meta">节点 完成 ' + doneN + " / 失败 " + failN + " · 耗时 " + (m.durationMs ?? "?") + "ms · wfId " + esc(m.wfId) + "</div>" +
        ((m.errors || []).map((e2) => '<div class="bd-meta" style="color:#e08a7a">· ' + esc(e2) + "</div>").join("")) +
        ((r.items || []).slice(0, 8).map((it) => '<div class="bd-meta" style="margin-top:3px">成果:' + esc(JSON.stringify(it).slice(0, 140)) + "</div>").join("")) +
        ((r.error || m.error) ? '<div class="bd-meta" style="color:#e08a7a;margin-top:4px">' + esc(String(r.error || m.error).slice(0, 200)) + "</div>" : "");
    }
    return;
  }
 // 权限切换被服务端拒绝(plan-goal-mutex:存在 active goal)→ 回滚 pill(审计 C10:此前本地先翻不回滚,
 // UI 显示 Plan 而服务端仍 ask,分歧到下次 cfg.get 才可能被纠正;且该错误码不匹配任何内联显示,曾静默)
  if (m.type === "error" && m.code === "plan-goal-mutex") {
    permModeV = permPriorMode || "ask";
    localStorage.setItem("zh:perm-mode", permModeV);
    pillRender();
  }
 // repo wiki:列表/页/重建回执与错误内联显示(独立 code 前缀,防走通用 toast 丢上下文)
  if (m.type === "error" && /^wiki-/.test(String(m.code || ""))) {
    $("wikiRebuild").disabled = false;
    $("wikiForce").disabled = false;
    $("wikiMeta").textContent = "失败:" + errorText(m.code, m.message).slice(0, 120);
    errToast(m, "Wiki 操作失败");
    return;
  }
  if (m.type === "wiki.list.result") {
    $("wikiRebuild").disabled = false;
    $("wikiForce").disabled = false;
    const ok = wikiRenderManifest(m.manifest);
    if (ok) wikiOpenFirst();
    return;
  }
  if (m.type === "wiki.page.result") {
    if (m.pageId && m.pageId !== wikiCurrentPage) return;
    if (!m.markdown) {
      $("wikiMd").innerHTML = '<div class="cc-empty">页不存在或读取失败:' + esc(String(m.pageId || "")) + '</div>';
      return;
    }
    $("wikiPageTitle").textContent = m.page && m.page.title ? m.page.title : m.pageId;
    $("wikiPageCites").textContent = m.page && m.page.citations ? (m.page.citations.length + " 条引用(可点击回源)") : "";
    const jump = $("wikiToStructure");
    const mod = m.page && m.page.moduleName ? String(m.page.moduleName) : "";
    if (mod) { jump.style.display = ""; jump.setAttribute("data-mod", mod); jump.textContent = "在结构中查看 " + mod; }
    else { jump.style.display = "none"; jump.removeAttribute("data-mod"); }
    wikiRenderMarkdown(m.markdown);
    return;
  }
  if (m.type === "wiki.rebuild.result") {
    $("wikiRebuild").disabled = false;
    $("wikiForce").disabled = false;
    const ok = wikiRenderManifest(m.manifest);
    if (ok) { wikiCurrentPage = ""; wikiOpenFirst(); }
    toast(m.hit ? "Wiki 缓存命中:源码未变,零生成" : ("Wiki 已重建:" + m.rebuilt.length + " 页重建 / " + m.reused.length + " 页复用" + (m.llmCalls ? " · LLM " + m.llmCalls + " 次" : "")));
    return;
  }
 // 协议版本错位识别(session.owner.get 事故教训):invalid-message + zod 判别错误
 // =运行中的网关不认识该消息类型(面板新半边已生效、网关旧半边未重启)——给可操作提示而非
 // 原样转贴 zod 原文;30s 同码去重,ownerPull 类逐 sid 重发不再刷屏。
  if (m.type === "error" && String(m.code || "") === "invalid-message") {
    const msg = String(m.message || "");
    const mismatch = msg.includes("Invalid discriminator");
    const now = Date.now();
    if (!invalidMsgToastAt || now - invalidMsgToastAt > 30000) {
      invalidMsgToastAt = now;
      if (mismatch) errToast({ code: m.code, message: "面板消息类型不被当前网关支持(版本错位:重启网关后生效,期间该功能自动降级)", sessionId: m.sessionId, traceId: m.traceId });
      else errToast(m, "消息被拒");
    }
    return;
  }
 // error 兜底(审计 C9):此前 goal-invalid/goal-plan-mutex/skills-failed/exp-failed 等
 // 无专属处理器的错误被静默丢弃——用户看不到任何失败痕迹。models/cfg/sense 已有内联状态显示,排除防双报。
  if (m.type === "error" && !/^(models|cfg|sense)/.test(String(m.code || ""))) {
    goalPendingDispatch = null; // goal.set 被拒:撤销待派任务
 // 兜底展示:文案一律出自 ERR_TEXT(未登记 code 由 errorText 兜底成「未知错误(<code>):<原文>」),
 // 附带「复制诊断」(code+message+sessionId+traceId),不再在这里抄单码字符串。
    errToast(m, "操作失败");
    return;
  }
  if (m.type === "board.changed") {
    const p = m.payload || {};
    if (p.sessionId !== currentSid) return;
 // B6:编辑态且当前板被 agent/他端更新 → 不自动刷新(保护草稿),提示+rev 乐观锁兜底
 // (浮动面板照旧刷新——它渲染的是已保存版本,不碰编辑草稿)
    if (bfOpen) { if (p.taskId && p.taskId === boardTaskId) boardGet(p.taskId); else boardRefresh(); return; }
    if (boardEditOn && p.taskId === boardTaskId) { toast("白板有新版本(agent 更新了);你的草稿未保存——保存将冲突,建议先记下改动再决定", true); return; }
 // 板视图打开=即时刷新;任务卡 chip 由下一次会话重放带出(board.update 事件在 history 流里)
    if (viewLive("board")) { if (p.taskId && p.taskId === boardTaskId) boardGet(p.taskId); else boardRefresh(); return; }
 // 画布新鲜度:画布态下板卡常被滚出视口(viewLive=false),广播不能白丢——只记脏标,
 // 卡滚回视口(canvasActivateCard)时补拉一次;视口外零额外请求。
    bdViewDirty = true; bdViewDirtyAt = Date.now();
    return;
  }
  if (m.type === "sense.result") {
    const r = m.result;
    const dec = r.autoDecision ? " · auto→" + r.autoDecision.picked + "(" + r.autoDecision.reason + ")" : "";
    $("sense-status").innerHTML = "剖面:<b>" + r.mode + "</b>" + esc(dec) + " · " + r.projectState + " · 缓存:" + (r.cache.hit ? "命中" : "重建");
 // 图给人看( §9 分工):debug 调用关系图(圆心高亮/未解析虚线)> 架构图 > 页面流;
 // mermaid 缺席或渲染失败回落文字(不冒充图)
    const mer = (r.callchain && r.callchain.mermaid) || (r.architecture && r.architecture.mermaid) || (r.pageflow && r.pageflow.mermaid) || null;
    if (mer && window.mermaid) {
      mermaid.render("g1", mer).then((o) => {
        const host = $("sense-mermaid");
        host.innerHTML = (o && o.svg ? o.svg : o) + (r.callchain && r.callchain.mermaidTruncated ? '<div class="dim" style="padding-top:6px">图过大已按离圆心远近裁剪(34 节点上限),完整链见明细</div>' : "");
        if (r.callchain) bindSenseDrill(host, r.callchain.mermaidNodes || []);
        if (r.sequence && r.sequence.mermaid) {
          mermaid.render("g2", r.sequence.mermaid).then((o2) => {
            const cap = document.createElement("div");
            cap.className = "dim"; cap.style.padding = "8px 0 2px";
            cap.textContent = "静态时序(语句序≠运行序,异步边界 " + r.sequence.asyncBoundaries + " 处)";
            const box = document.createElement("div");
            box.innerHTML = (o2 && o2.svg ? o2.svg : o2);
            host.appendChild(cap); host.appendChild(box);
          }).catch(function () { /* 时序图渲染失败不吞关系图 */ });
        }
      }).catch(function () { $("sense-mermaid").textContent = mer; });
    } else {
      $("sense-mermaid").textContent = r.callchain
        ? ("圆心: " + r.callchain.center.name + " (" + r.callchain.center.file + ":" + r.callchain.center.line + ")")
        : (r.mode === "plan" ? "模块结构(静态推导): 见明细" : "(本剖面无图)");
    }
    const lines = [];
    if (r.callchain) {
      lines.push("<span class='sec'>圆心</span>");
      lines.push("  " + r.callchain.center.name + " @ " + r.callchain.center.file + ":" + r.callchain.center.line + (r.callchain.mermaidNodes ? "(关系图 " + r.callchain.mermaidNodes.length + " 节点,点节点下钻)" : ""));
      lines.push("<span class='sec'>下游</span>");
      r.callchain.downstream.slice(0, 14).forEach((x) => lines.push("  → " + (x.toName || "") + " @ " + x.file + ":" + x.line));
      lines.push("<span class='sec'>上游</span>");
      r.callchain.upstream.slice(0, 14).forEach((x) => lines.push("  ← " + (x.toName || "") + " @ " + x.file + ":" + x.line));
    }
    if (r.signatures) for (const [k, v] of Object.entries(r.signatures)) lines.push("签名 " + k + ": " + esc(JSON.stringify(v).slice(0, 160)));
    if (r.typeDefs && Object.keys(r.typeDefs).length) {
      lines.push("<span class='sec'>类型定义</span>");
      for (const [t, d] of Object.entries(r.typeDefs)) lines.push("  " + esc(t) + " → " + esc(d.file) + ":" + d.line);
    }
    if (r.references && r.references.length) {
      lines.push("<span class='sec'>全仓引用 " + (r.referenceCount ?? r.references.length) + " 处</span>");
      r.references.slice(0, 10).forEach((x) => lines.push("  " + x.file + ":" + x.line + " " + esc(String(x.text).trim().slice(0, 60))));
    }
    if (r.matches) r.matches.slice(0, 15).forEach((x) => lines.push(x.file + ":" + x.line + " " + esc(String(x.text).trim().slice(0, 60))));
    if (r.modules) r.modules.forEach((x) => lines.push("模块 " + esc(x.name) + " — " + esc(x.responsibility.slice(0, 80))));
    if (r.pageflow) r.pageflow.pages.slice(0, 10).forEach((p) => lines.push("页面 " + esc(p.route) + " (" + esc(p.file) + ")"));
    if (r.degraded) r.degraded.forEach((d) => lines.push("<span class='dim'>[降级] " + esc(d.layer) + ": " + esc(d.reason) + "</span>"));
    $("sense-detail").innerHTML = lines.join(NL);
 // 洞察产物→可编辑语义板入口(有在场产物且已进会话才亮)
    senseLastResult = r;
    const sb = $("sense-boardbar");
    if (sb) {
      const can = !!currentSid && !!((r.callchain && r.sequence) || (r.architecture && (r.architecture.nodes || []).length) || (r.pageflow && r.pageflow.pages && r.pageflow.pages.length) || (r.modules && r.modules.length));
      sb.style.display = can ? "" : "none";
    }
  }
}
let lastSubmitText = "", lastSubmitAt = 0;
`;
