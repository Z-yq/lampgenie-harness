/**
 * 面板 body 骨架 + 外部脚本标签 + 引导/降级脚本(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 以 </style></head><body> 开头;反引号必须是转义的 \`(沿袭模板字面量约束)。
 */
export const PANEL_SHELL = `</style></head><body>
<div id="winDragBar" aria-hidden="true"></div>
<div id="winControls" role="toolbar" aria-label="窗口控制">
  <button type="button" data-win="min" title="最小化" aria-label="最小化"><span class="wc-ico wc-min"></span></button>
  <button type="button" data-win="max" title="最大化" aria-label="最大化"><span class="wc-ico wc-max"></span></button>
  <button type="button" data-win="close" title="关闭" aria-label="关闭"><span class="wc-ico wc-close"></span></button>
</div>
<aside id="sidebar">
  <div class="sb-brand"><span class="brand-dot"></span><span class="bn">GENIE</span><span class="bs">Harness</span></div>
  <button class="sb-mode-btn" id="cvModeBtn" type="button" title="切换到画布模式:全部视图变成卡片,可平移/缩放/自由布局 (Ctrl+Shift+C)">
    <span class="ic">▦</span><span>画布模式</span><span class="kbd">Ctrl+Shift+C</span>
  </button>
 <!-- nav-to-sidebar(用户):「新建任务/指挥台/RSI 看板」三入口从底部条迁回左侧栏顶部块。
 markup/id 逐字保留原底部条版本(panel-card-naming 守卫:tooltip/显示名同 CV_CARDS),onclick 绑定零改。 -->
  <nav class="sb-nav" id="sbNav" data-nav="sb-nav" aria-label="主导航">
    <div class="sb-act" id="act-new" title="新建任务 (Ctrl+N)">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="4"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
      新建任务<span class="sb-kbd">Ctrl N</span>
    </div>
 <!-- Super Agent 指挥台一级入口(调度本系统与全部工作区的 coding agent;跨项目/跨机联调)。
 tooltip/显示名 = CV_CARDS.super.title 同串(panel-card-naming 守卫)。 -->
    <div class="sb-act" id="act-super" title="指挥台 Super">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6"/><path d="M12 3v4.2"/><path d="M12 16.8V21"/><path d="M3 12h4.2"/><path d="M16.8 12H21"/><circle cx="12" cy="12" r="8.4" stroke-dasharray="3.2 3.2"/></svg>
      指挥台 Super
    </div>
 <!-- 2026-11-11 RSI-PLACE:RSI 看板=管理整个系统的全局治理面,与指挥台同视图(两个子标签:指挥台 / RSI 看板)。 -->
    <div class="sb-act" id="act-rsi" title="RSI 看板:管理整个系统的 RSI 机制运行状态(12 分区只读,全局治理面)">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="2.6"/></svg>
      RSI 看板
    </div>
  </nav>
  <div class="sb-sep"></div>
  <div class="sb-toolbar">
    <span class="sb-tt on" id="tt-proj">项目</span>
    <span class="sb-tt" id="tt-time">时间</span>
    <span class="sb-tt" id="tt-group" title="按自定义分组(F3,任务行右键「移入分组」)">分组</span>
    <span class="sb-tt" id="tt-arch" title="归档视图(F3)">归档</span>
    <span class="sb-tt" id="tt-sort" title="排序基准:更新/创建切换">更新</span>
    <span class="sb-tt" id="tt-fold" title="全部展开/收起(展开中分组一键收起)">全收</span>
  </div>
  <div class="sb-proj" id="projRow" title="点击 → 新建任务(草稿)">
    <svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
    <span id="projName">…</span><span class="cnt" id="projCnt"></span>
  </div>
  <div id="projList"></div>
  <div id="projAdd" style="display:none">
 <!-- 目录浏览走服务端(gateway 在 WSL,才能看到 /home 真实路径);
 浏览器侧 webkitdirectory 选择器只能拿 Windows 侧相对路径——已删,勿恢复 -->
    <div class="proj-add-quick">
      <button id="projBrowseBtn" title="浏览 WSL/本地文件系统选目录(服务端目录浏览器)">打开文件夹</button>
      <button id="projRemoteBtn" title="SSH / WSL / Docker 远程连接添加">远程连接</button>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <input id="projPathInput" placeholder="或粘贴绝对路径,如 /home/u/myapp" autocomplete="off" spellcheck="false" style="flex:1">
      <button id="projAddGo">添加</button><button id="projAddCancel">取消</button>
    </div>
  </div>
  <div class="sb-proj-add" id="projAddBtn" title="添加项目(工作区)">
    <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    <span>添加项目</span>
  </div>
  <div id="taskList"></div>
  <div class="sb-spacer"></div>
 <!-- 文件树滑入层(ZCode WorkspaceFileTree):桶头「文件树」打开;Esc/返回关闭;用户行 z-index 常驻 -->
  <div id="sbFt">
    <div class="sbft-head">
      <button class="sbft-btn" id="sbFtBack" title="返回 (Esc)">← 返回</button>
      <span class="t" id="sbFtTitle">文件树</span>
      <button class="sbft-btn" id="sbFtRefresh" title="刷新目录" style="margin-left:auto">刷新</button>
    </div>
    <div id="sbFtTree"></div>
  </div>
 <!-- 版本更新提示:桌面壳 update-check 状态驱动;浏览器内无 genieWindow.updates 时整块不出现 -->
  <div class="sb-update" id="updateBar" style="display:none" role="status" aria-live="polite">
    <div class="up-head"><span class="up-dot"></span><b id="upTitle">发现新版本</b><button class="up-close" id="upLater" type="button" title="稍后再说" aria-label="稍后再说">×</button></div>
    <div class="up-sub" id="upSub"></div>
    <div class="up-acts"><button class="up-go" id="upAction" type="button">下载更新</button><button class="up-link" id="upMore" type="button" style="display:none">更新说明</button></div>
  </div>
  <div class="sb-user">
    <div class="u-ava" id="uAva" title="配置台 Config">G</div>
    <div class="u-txt"><div class="u-name">本地工作台</div><div class="u-sub" id="uSub">gateway · 连接中</div></div>
    <div class="u-gear" id="uGear" title="配置台 Config">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><line x1="12" y1="2.5" x2="12" y2="5.5"/><line x1="12" y1="18.5" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5.5" y2="12"/><line x1="18.5" y1="12" x2="21.5" y2="12"/><line x1="5.3" y1="5.3" x2="7.4" y2="7.4"/><line x1="16.6" y1="16.6" x2="18.7" y2="18.7"/><line x1="18.7" y1="5.3" x2="16.6" y2="7.4"/><line x1="7.4" y1="16.6" x2="5.3" y2="18.7"/></svg>
    </div>
  </div>
</aside>
<!-- 底部导航条:原左栏 .sb-acts 整块搬到窗口最底部横跨整窗(§bnav-h);内部 HTML 逐字未变(panel-card-naming 守卫) -->
 <!-- nav-to-sidebar(用户):「新建任务/指挥台/RSI 看板」三入口已迁左侧栏顶部块 #sbNav;
 底部条只留其余入口,不重复保留(新建任务在折叠细轨 #sbRailNew 仍有隐藏态入口,历史功能不动)。 -->
  <div class="sb-acts">
    <div class="sb-act" id="act-search" title="搜索 (Ctrl+K)">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
      搜索<span class="sb-kbd">Ctrl K</span>
    </div>
    <div class="sb-act" id="act-git" title="Git">
      <svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><line x1="6" y1="8.4" x2="6" y2="15.6"/><path d="M18 11.4c0 3.6-4.5 4.5-9 4.8"/></svg>
      Git
    </div>
 <!-- 网页(内嵌浏览器)一级入口(2026-11 人机随时可用轮):左栏点一下即进视图,不用背 Ctrl+Alt+B。
 title/显示名取 CV_CARDS.browser.title 同串(test/panel-card-naming.test.ts 守卫),快捷键只放 sb-kbd。 -->
    <div class="sb-act" id="act-web" title="网页 Webview">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="3" y1="9" x2="21" y2="9"/><circle cx="6.4" cy="6.5" r=".8"/><circle cx="9" cy="6.5" r=".8"/><path d="M7 13h6"/><path d="M7 16h4"/></svg>
      网页 Webview<span class="sb-kbd">Ctrl Alt B</span>
    </div>
    <div class="sb-act" id="act-sense" title="代码档案 Atlas">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="11"/><line x1="11" y1="11" x2="13" y2="12"/></svg>
      代码档案 Atlas
    </div>
    <div class="sb-act" id="act-wf" title="自动化 Flows">
      <svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      自动化 Flows
    </div>
    <div class="sb-act" id="act-exp" title="经验库 Memo">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      经验库 Memo
    </div>
    <div class="sb-act" id="act-market" title="插件市场 Market">
      <svg viewBox="0 0 24 24"><path d="M3 6l3-2 3 2v12l-3-2-3 2z"/><path d="M12 4l3 2v12l-3-2-3 2V6z" transform="translate(6 0)"/><path d="M21 6v12"/></svg>
      插件市场 Market
    </div>
 <!-- 终端/文件两个左栏入口已撤(2026-10-19 不展示);浏览器入口 2026-11 恢复(见下方 act-web)。
 未展示者的能力入口仍在,勿删对应视图与路由:
 · 终端 → Ctrl+J(KEYMAP open-terminal)/ 命令中心;视图 #view-term,WS term.exec
 · 文件 → 侧栏任务/项目桶头「文件树」滑入层 #sbFt(与 #view-files 同源 dirCache)+ 项目右键「查看文件」
 · 浏览器 → 左栏「网页 Webview」(id act-web)直进 #view-browser;快捷键 Ctrl+Alt+B(KEYMAP open-browser)与设置-浏览器控制仍可用 -->
    <div class="sb-act" id="act-board" title="白板 Sketch">
      <svg viewBox="0 0 24 24"><path d="M4 20l4.5-1L20 7.5a2 2 0 0 0 0-3L19.5 4a2 2 0 0 0-3 0L5 15.5z"/><line x1="14.5" y1="6.5" x2="17.5" y2="9.5"/></svg>
      白板 Sketch
    </div>
    <div class="sb-act" id="act-team" title="团队 Crew">
      <svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.9.4 5 2.8 5 5.8"/></svg>
      团队 Crew
    </div>
 <!-- 总线路一级入口已并入代码档案「总路线」tab(2026-10-19 总路线与代码档案是同一功能) -->
 <!-- 运行看板顶级入口已收编进团队视图「看板」子标签(2026-10-16 运行看板是团队的一个子功能,每项目一块看板) -->
    <div class="sb-act" id="act-nodes" title="节点 Fleet">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="13" width="7" height="7" rx="1.5"/><line x1="14" y1="16.5" x2="21" y2="16.5"/><line x1="17.5" y1="13" x2="17.5" y2="20"/></svg>
      节点 Fleet
    </div>
    <div class="sb-act" id="act-approvals" title="关卡 Gate">
      <svg viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>
      关卡 Gate
    </div>
    <div class="sb-act" id="act-subchat" title="子代理会话流">
      <svg viewBox="0 0 24 24"><path d="M4 5.5A2 2 0 0 1 6 3.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-4 3z"/><path d="M16 8.5h2.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H16l-3 2.5v-2.5h-.5"/></svg>
      子代理会话流
    </div>
    <div class="sb-act" id="act-track" title="追踪 Trace">
      <svg viewBox="0 0 24 24"><path d="M4 6h7"/><path d="M4 12h7"/><path d="M4 18h7"/><path d="M14 6l2 2 4-4"/><path d="M14 12l2 2 4-4"/><path d="M14 18l2 2 4-4"/></svg>
      追踪 Trace
    </div>
 <!-- 轨迹从「追踪 Trace」拆成独立看板视图(逐次决策 + 事件账本 + 泳道,数据源 = histEvents)。
 与 track 职责分离:track = 召回·审途五阶段统计,traj = 逐次决策账本。显示名/tooltip 取 CV_CARDS.traj.title 同串。 -->
    <div class="sb-act" id="act-traj" title="轨迹 Trail">
      <svg viewBox="0 0 24 24"><path d="M4 19V5"/><path d="M4 19h16"/><circle cx="8" cy="16" r="1.7"/><circle cx="15" cy="9" r="1.7"/><path d="M9 15l5-5"/></svg>
      轨迹 Trail
    </div>
    <div class="sb-act" id="act-usage" title="吞吐 Telemetry">
      <svg viewBox="0 0 24 24"><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="9"/><line x1="3" y1="20" x2="21" y2="20"/></svg>
      吞吐 Telemetry
    </div>
  </div>
<div id="sbDrag"></div>
<!-- 画布模式下的更新浮层(与侧栏 #updateBar 同源状态;经典模式隐藏,避免双份入口) -->
<div class="sb-update" id="updateFloat" role="status" aria-live="polite">
  <div class="up-head"><span class="up-dot"></span><b id="upfTitle">发现新版本</b><button class="up-close" id="upfLater" type="button" title="稍后再说" aria-label="稍后再说">×</button></div>
  <div class="up-sub" id="upfSub"></div>
  <div class="up-acts"><button class="up-go" id="upfAction" type="button">下载更新</button><button class="up-link" id="upfMore" type="button" style="display:none">更新说明</button></div>
</div>
<!-- 折叠细轨(ZCode WorkspaceSidebarCollapsedRail):收起时仅剩一条轨,logo 悬停换面板图标,附隐藏态新建入口 -->
<div id="sbRail">
  <button class="rail-btn" id="sbRailToggle" title="切换侧边栏 (Ctrl+B)">
    <span class="r-a">G</span>
    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
  </button>
  <button class="rail-btn" id="sbRailNew" title="新建任务 (Ctrl+N)">
    <span class="r-a" style="font-size:15px">+</span>
    <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>
</div>
<div class="page">
  <header>
    <button class="sb-toggle" id="sbToggle" title="收起/展开侧栏 (Ctrl+B)">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
    </button>
    <div class="brand"><span class="brand-name">GENIE</span><span class="brand-sub">Harness · Live</span></div>
    <span class="view-name" id="viewName"></span>
    <div class="top-right">
      <div class="pill on" id="pill-conn"><span class="d" id="status"></span><span id="conn">连接中…</span></div>
    </div>
  </header>
  <div class="middle">
    <div class="view chat-col on" id="view-tasks">
 <!-- 子代理工作区 tab 条:主会话+每个打开的子代理工作区;空态整条隐藏(JS 渲染) -->
      <div id="wsTabbar"></div>
 <!-- 标签条已按废弃(硬隐藏 CSS 在样式区;勿再恢复) -->
      <div class="find-bar" id="findBar" style="display:none">
        <input id="findQ" placeholder="会话内查找…" autocomplete="off">
        <span class="find-count" id="findCount"></span>
        <span class="turn-nav"><button id="turnPrev" title="上一条用户消息">⇤ 轮</button><button id="turnNext" title="下一条用户消息">轮 ⇥</button></span>
        <button id="findPrev" aria-label="上一个"><svg class="icn" viewBox="0 0 24 24"><path d="M5.5 14.5l6.5-6.5 6.5 6.5"/></svg></button><button id="findNext" aria-label="下一个"><svg class="icn" viewBox="0 0 24 24"><path d="M5.5 9.5l6.5 6.5 6.5-6.5"/></svg></button><button id="findClose" aria-label="关闭查找"><svg class="icn" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg></button>
      </div>
      <div id="chatBody"><div class="empty-line">尚 无 任 务 —— 说 点 什 么</div></div>
    <button id="scrollBottom" title="回到底部" style="display:none;width:32px;height:32px;border-radius:50%;border:1px solid var(--border-soft);background:var(--glass2);color:var(--bronze);cursor:pointer;font-size:14px;align-items:center;justify-content:center"><svg class="icn" viewBox="0 0 24 24"><path d="M5.5 9.5l6.5 6.5 6.5-6.5"/></svg></button><!-- fixT6:定位/尺寸/层叠移交 CSS(sticky;z-index 同归 CSS)——内联 z-index 会压过 #scrollBottom 规则,故不留 -->
 <!-- turnNav 已迁 footer .aff-strip(2026-10-14 轮次时间轴与管线状态同条,右缘浮层退役) -->
    </div>
 <!-- 双中心布局:会话流|IDE 之间的拖拽分隔条;CSS 默认隐藏,仅 body.dual-center 显示 -->
    <div id="dualSplit" title="拖拽调会话流宽度(双击收起 IDE)"></div>
    <div class="view panel-wrap" id="view-git">
      <div class="git-bar">
        <span class="git-branch" id="gitBranch">…</span>
        <select id="gitBranchSel" title="切换分支"></select>
        <button id="gitRefresh">刷新</button>
        <button id="gitPullBtn" title="拉取 origin(当前分支;服务端 git.pull)">拉取</button>
        <button id="gitPushBtn" title="推送 origin(当前分支;首推自动 -u)">推送</button>
      </div>
      <div class="git-main">
        <div class="git-changes" id="gitChanges"></div>
        <div class="git-diff" id="gitDiff"><div class="cc-empty">点击变更文件查看 diff</div></div>
      </div>
      <div class="git-commit">
        <input id="gitMsg" placeholder="提交信息…(可勾选文件只提交选中)" autocomplete="off">
        <button id="gitCommitBtn">提交全部变更</button>
        <button id="gitLogBtn" title="提交历史">历史</button>
        <button id="gitAiMsg" title="AI 生成提交信息">AI 提交信息</button>
      </div>
      <div class="snap-sec" id="snapSec">
        <div class="snap-head"><span class="stat-h" style="margin:0">快照( · 任务级回滚点)</span>
          <button class="vw-act" id="snapLoad">拉取快照</button></div>
        <div id="snapList" style="display:flex;flex-direction:column;gap:4px;max-width:760px"></div>
      </div>
    </div>
    <div class="view panel-wrap" id="view-project" data-tab="structure">
      <div class="pp-head">
        <span class="pp-title" id="ppTitle">代码档案 Atlas</span>
        <span class="pp-state" id="ppState">静态基座知识 · 点文件看模块画布</span>
        <div class="pp-bar"><i id="ppBar" style="width:0%"></i></div>
        <span class="pp-pct" id="ppPct"></span>
        <span class="pp-owner" id="ppOwner" style="display:none"></span>
        <button class="vw-act" id="ppRebuild">重建</button>
        <button class="vw-act" id="ppPlanBtn">规划</button>
        <button class="vw-act" id="ppWindow">独立窗口</button>
      </div>
      <div class="pp-tabs" id="ppTabs">
        <button class="pp-tab on" data-ptab="structure">结构</button>
        <button class="pp-tab" data-ptab="roadmap">总路线</button>
        <button class="pp-tab" data-ptab="files">文件钻取</button>
        <button class="pp-tab" data-ptab="wiki">Wiki 文档</button>
      </div>
      <div class="pp-tabpane on" id="ppTab-structure" data-ptab="structure">
      <div class="pp-main">
        <div class="pp-graph" id="ppGraph"><div class="cc-empty">选择左侧项目的「档案」入口打开;添加项目时自动异步构建</div></div>
        <div class="pp-side">
          <div class="pp-search"><input id="ppSearch" placeholder="搜索模块名(过滤+点开看详情)…" autocomplete="off"></div>
          <div class="pp-mods" id="ppMods"></div>
          <div id="ppDetail"></div>
          <div id="ppPlan" class="plan-box" style="display:none">
            <h5>图上规划(在图上调整方案,一键生成计划并执行)</h5>
            <div class="plan-form"><input id="planAddName" placeholder="新模块名" style="width:90px"><input id="planAddNote" placeholder="职责说明" style="flex:1;min-width:100px"><button id="planAddGo">+ 新增模块</button></div>
            <div class="plan-form"><select id="planDelSel"></select><input id="planDelReason" placeholder="废弃原因(可空)" style="flex:1;min-width:100px"><button id="planDelGo">− 规划移除</button></div>
            <div class="plan-form"><select id="planDepFrom"></select><span style="color:var(--faint)">→</span><select id="planDepTo"></select><button id="planDepGo">+ 新增依赖</button></div>
            <div id="planList" style="display:flex;flex-direction:column;gap:4px"></div>
            <button class="plan-apply" id="planApply">生成计划并执行</button>
          </div>
          <div class="stat-h" style="margin:6px 0 2px">演进(agent 变更记录)</div>
          <div id="ppChanges" style="display:flex;flex-direction:column;gap:4px"></div>
          <div class="stat-h" style="margin:10px 0 2px;display:flex;align-items:center;gap:8px">评审遗留(行级回写店 · sticky 跨轮)<button class="vw-act" id="revStoreRefresh">刷新</button></div>
          <div id="revStoreBody"><div class="cc-empty">尚无评审记录(任务完成自动跑确定性层;agent 调 code_review 产生深审)</div></div>
          <div class="stat-h" style="margin:10px 0 2px;display:flex;align-items:center;gap:8px">设计沉淀(done 板 · 项目级设计记忆)<button class="vw-act" id="arcRefresh">刷新</button></div>
          <div id="arcBody"><div class="cc-empty">任务收官时,done 白板自动沉淀为项目设计记忆;点开只读回看</div></div>
        </div>
      </div>
      </div>
      <div class="pp-tabpane" id="ppTab-files" data-ptab="files">
      <div class="ppf" id="ppf">
        <div class="ppf-head">
          <span class="stat-h" style="margin:0">文件与函数</span>
          <input id="ppfSearch" placeholder="过滤文件…" autocomplete="off">
          <span class="ppf-hint" id="ppfHint">点文件 → 全部函数;点函数 → 调用关系图</span>
        </div>
        <div class="ppf-body">
          <div class="ppf-files" id="ppfFiles"><div class="cc-empty">打开档案后自动加载…</div></div>
          <div class="ppf-fns" id="ppfFns"><div class="cc-empty">选个文件</div></div>
          <div class="ppf-graphwrap" id="ppfGraphWrap" style="display:none">
            <div class="ppf-ghead"><span id="ppfGTitle">调用关系</span><button class="vw-act" id="ppfGClose" aria-label="关闭"><svg class="icn" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg></button></div>
            <div class="ppf-mermaid" id="ppfMermaid"></div>
          </div>
        </div>
      </div>
      </div>
      <div class="pp-tabpane" id="ppTab-roadmap" data-ptab="roadmap">
        <div class="rm-wrap">
          <div class="rm-purpose">
            <div class="rm-purpose-head">
              <span class="stat-h" style="margin:0">开发宗旨与主线(code-sense 项目画像 · 防偏离)</span>
              <span class="rm-meta" id="rmMeta"></span>
              <button class="vw-act" id="rmGen" title="按需生成:确定性骨架(README/包清单/框架指纹/入口/拓扑)+ LLM purpose 层,落 .genie/sense-index/profile.json">生成总路线</button>
              <button class="vw-act" id="rmRefresh" title="重新读取现有画像(不生成)">刷新</button>
            </div>
            <div id="rmBody"><div class="cc-empty loading">加载中…</div></div>
          </div>
          <div class="rm-funnel">
            <div class="rm-funnel-head">
              <span class="stat-h" style="margin:0">任务漏斗(按项目 · 原总线路视图内容)</span>
              <button class="vw-act" id="rmFunnelRefresh">刷新</button>
            </div>
            <div id="rmFunnel" style="display:flex;flex-direction:column;gap:10px"></div>
          </div>
        </div>
      </div>
      <div class="pp-tabpane" id="ppTab-wiki" data-ptab="wiki">
        <div class="wiki-bar">
          <span class="wiki-bar-meta" id="wikiMeta">加载中…</span>
          <button class="vw-act" id="wikiRebuild" disabled title="按 git sha + 输入指纹缓存重建(源码未变时零生成)">重建</button>
          <button class="vw-act" id="wikiForce" disabled title="忽略缓存全量重建(LLM 叙述页会重新生成,可能数十秒)">强制重建</button>
          <button class="vw-act" id="wikiRefresh" title="重新读取 manifest(不生成)">刷新</button>
        </div>
        <div class="wiki-body">
          <div class="wiki-nav" id="wikiNav"><div class="cc-empty loading">加载中…</div></div>
          <div class="wiki-content">
            <div class="wiki-page-head"><span class="wiki-page-title" id="wikiPageTitle"></span><button class="vw-act" id="wikiToStructure" style="display:none">在结构中查看模块</button><span class="wiki-page-cites" id="wikiPageCites"></span></div>
            <div class="wiki-md" id="wikiMd"><div class="cc-empty">选择左侧页面</div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="view panel-wrap" id="view-market">
      <div class="vw-head"><span class="vw-title">插件市场 Market</span><span class="vw-sub">内置精选 + ZCode 官方市场(安装前授权确认)· 命令/技能/子智能体/MCP 落地 · 卸载精确回收</span>
        <button class="vw-act" id="mktRefresh">刷新</button></div>
      <div id="mktGrid" class="mkt-grid"><div class="cc-empty loading">加载中…</div></div>
      <div class="stat-h" style="margin-top:16px">已安装</div>
      <div id="mktInstalled"><div class="cc-empty">无</div></div>
    </div>
    <div class="view panel-wrap" id="view-browser">
      <div class="vw-head"><span class="vw-title">浏览器 Browser</span><span class="vw-sub" title="内置浏览器:agent 驱动的 headless 页面实时截图流;e1..eN 高亮可点;人接管=本地窗口操作">agent 驱动 · 截图流 · 人接管降级</span>
        <span class="vw-acts">
          <button class="vw-act" id="brOpenView" title="订阅当前活动 tab 的截图流">连接</button>
          <button class="vw-act" id="brCloseView" title="退订截图流(节省截图开销)">断开</button>
          <button class="vw-act" id="brLegacy" title="旧形态:内嵌 iframe 快速查看(部分站点禁止内嵌)">iframe 兜底</button>
        </span>
      </div>
      <div id="gbvHost" class="gbv-host"></div>
      <iframe id="brFrame" title="web" hidden></iframe>
      <div class="br-bar" id="brLegacyBar" hidden>
        <input id="brUrl" placeholder="https://… 或 http://127.0.0.1:端口(部分站点禁止内嵌,属站点策略)" autocomplete="off" spellcheck="false">
        <button class="vw-act" id="brGo">打开</button>
        <button class="vw-act" id="brExt" title="新窗口打开(绕开内嵌限制)">新窗口</button>
      </div>
      <div class="br-note" id="brNote">内置浏览器显示 agent 的 headless 页面(截图流,≤1.25 帧/秒)。要点「连接」(或本视图首次打开自动连)。X-Frame-Options 拒绝内嵌的站点用「iframe 兜底」旁的「新窗口」或人接管。</div>
    </div>
    <div class="view panel-wrap" id="view-board">
      <div class="vw-head"><span class="vw-title">白板 Sketch</span><span class="vw-sub" title="任务态草图:一次代码改动的临时设计,随任务生灭 · agent 先画后改 · 项目静态知识看「代码档案」">任务态草图:一次代码改动的临时设计,随任务生灭 · agent 先画后改 · 项目静态知识看「代码档案」</span>
        <span class="vw-scope" id="scopeBoard" title="白板按会话归属(board.list 带 sessionId):切会话即换整本板集合">作用域:当前会话</span>
        <select id="boardTaskSel" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:8px;font-size:11px;padding:2px 6px"></select>
        <span class="vw-acts">
          <button class="vw-act" id="boardGraphMode">简图</button>
          <button class="vw-act" id="boardLayoutMode" title="布局切换:流动 LR=入口最左/出口最右+泳道分段+主线粗绿(默认);紧凑=保存位置/旧分层。页面结构板始终走自身语义布局">流动 LR</button>
          <button class="vw-act vw-fold" id="boardFromCode" title="code-sense 整理一个代码文件的符号为模块图(节点=函数,类型自动分类,边=真实调用关系)">从代码生成</button>
          <button class="vw-act vw-fold" id="boardFromSense" title="code-sense 分析产物直接生成可编辑语义板:模块依赖(全仓)/架构图(LLM)/符号时序/页面流">从洞察生成</button>
          <button class="vw-act" id="boardRefresh">刷新</button>
          <button class="vw-act" id="boardWfNew" title="新建一块 docKind=workflow 工作流板:节点=可执行步骤(wf-*),边=执行顺序/分支,编译执行把画布跑起来">新建工作流板</button>
          <button class="vw-act" id="boardWfCompile" style="display:none" title="编译预览:画布→harness-workflow 脚本(不执行);编译错误全部列出">编译脚本</button>
          <button class="vw-act" id="boardWfRun" style="display:none;border-color:var(--bronze)" title="编译并执行:节点状态实时点亮,结果回写画布">编译执行</button>
          <button class="vw-act" id="boardWfAuto" style="display:none" title="编译产物存为定时自动化(经 run_workflow 工具执行同一脚本)">存为自动化</button>
          <button class="vw-act" id="boardEditBtn">编辑</button>
          <button class="vw-act vw-fold" id="boardContinueBtn" title="把当前白板编成后续指令,发回原会话继续实施">按板续作</button>
          <span class="bd-sel-bar" id="bdSelBar"><span id="bdSelCount" title="节点卡头部复选框勾选的节点数(纯面板临时态,不写板)">已选 0 个</span><button class="vw-act" id="bdDispatchSel" disabled title="把勾选的节点整理成后续指令,发回原会话继续实施">下发选中</button></span>
          <button class="vw-act vw-fold vw-fold-md" id="boardExpMd">导出MD</button>
          <button class="vw-act vw-fold vw-fold-md" id="boardExpPng">导出PNG</button>
          <details class="vw-more" id="boardMore">
            <summary class="vw-act" title="低频操作收纳(窄视口)">更多</summary>
            <span class="vw-menu">
              <button class="vw-menu-it vw-fold" data-for="boardFromCode">从代码生成</button>
              <button class="vw-menu-it vw-fold" data-for="boardFromSense">从洞察生成</button>
              <button class="vw-menu-it vw-fold" data-for="boardContinueBtn">按板续作</button>
              <button class="vw-menu-it" data-for="boardExpMd">导出MD</button>
              <button class="vw-menu-it" data-for="boardExpPng">导出PNG</button>
            </span>
          </details>
        </span>
      </div>
      <div id="boardEditBar" style="display:none;align-items:center;gap:8px;padding:6px 0;font-size:12px;color:var(--bronze)">
        编辑中:改的是设计不是代码 · 结构改动即时预览 · 文本随保存生效
        <button class="vw-act" id="boardSaveBtn" style="border-color:var(--bronze)">保存白板</button>
        <button class="vw-act" id="boardCancelBtn">放弃</button>
      </div>
      <div class="board-main">
        <div class="board-graph" id="boardGraph"><div class="cc-empty">该会话还没有设计白板——代码改动类任务,agent 会先画设计草图再动手;历史任务点「白板」chip 直达</div></div>
        <div class="board-detail" id="boardDetail"><div class="cc-empty">点节点看「干什么用」与语义流程</div></div>
      </div>
      <details class="board-nodes-box" id="boardNodesBox" open><summary>节点卡清单(平铺卡片/编辑入口;含验收三态与证据摘要)</summary><div class="board-nodes" id="boardNodes"></div></details><!-- n1 白板可见化:默认展开(此前默认折叠,用户看不到节点卡与验收态) -->
      <details class="board-sketch" id="boardSketchBox">
        <summary>手绘批注层(跟随会话保存,刷新/换浏览器可恢复)</summary>
        <span class="wb-tools">
          <button class="wb-color on" data-c="#c98f45" style="background:#c98f45" title="青铜"></button>
          <button class="wb-color" data-c="#ece1d1" style="background:#ece1d1" title="米白"></button>
          <button class="wb-color" data-c="#9dc08b" style="background:#9dc08b" title="苔绿"></button>
          <button class="wb-color" data-c="#e08a7a" style="background:#e08a7a" title="赭红"></button>
          <button class="wb-color" data-c="erase" title="橡皮">擦</button>
          <input type="range" id="wbWidth" min="1" max="12" step="1" value="2" title="线宽">
          <button class="vw-act" id="wbClear">清空</button>
          <button class="vw-act" id="wbExport">导出PNG</button>
        </span>
        <div class="wb-wrap" id="wbWrap"><canvas id="wbCanvas"></canvas></div>
      </details>
    </div>
    <div class="view panel-wrap" id="view-term">
      <div class="vw-head"><span class="vw-title">命令台 Shell</span><span class="vw-sub" id="termCwd">工作目录 = 当前项目根</span>
        <button class="vw-act" id="termClear">清屏</button>
        <button class="vw-act" id="termKill">中止</button></div>
      <div class="term-body" id="termBody"><div class="term-line dim">$ 输入命令回车执行(Ctrl+J 从任意视图切到这里;输出上限 200KB,超时 120s)</div></div>
      <div class="term-input-row"><span class="term-prompt">$</span><input id="termInput" placeholder="command…" autocomplete="off" spellcheck="false"></div>
    </div>
    <div class="view panel-wrap" id="view-files">
      <div class="vw-head"><span class="vw-title">文件树 Files</span><span class="vw-sub" id="filesRoot">当前项目</span>
        <button class="vw-act" id="filesRefresh">刷新</button>
        <button class="vw-act" id="filesCollapse">收起全部</button></div>
      <div class="files-tree" id="filesTree"><div class="cc-empty">切换到项目后展示文件树;点击文件预览,右键更多操作</div></div>
    </div>
    <div class="view panel-wrap" id="view-ide">
      <div class="vw-head"><span class="vw-title">编辑器 IDE</span><span class="vw-sub" id="ideSub">编辑器 · Ctrl+S 保存</span>
        <div class="seg" id="ideMdSeg" style="display:none;align-self:center" title="Markdown 显示方式"><button data-md="preview">预览</button><button data-md="source">源码</button></div>
        <div class="seg" id="idePvSeg" style="display:none;align-self:center" title="HTML 文件显示方式"><button data-pv="edit">编辑</button><button data-pv="preview">预览</button></div>
        <button class="vw-act" id="ideSave" disabled title="保存激活标签(Ctrl+S)">保存</button></div>
      <div class="ide-shell" id="ideShell">
        <div class="ide-actbar" id="ideActBar" title="活动栏">
          <div class="ide-act on" data-act="tree" title="资源管理器">▤</div>
          <div class="ide-act" data-act="scm" title="源代码管理">⑂</div>
          <div class="ide-act" data-act="problems" title="问题">⚠</div>
          <div class="ide-act" data-act="outline" title="大纲">☰</div>
          <div class="ide-act" data-act="terminal" title="终端(Ctrl+\`)">▮</div>
        </div>
        <div class="ide-side" id="ideSide">
          <div class="ide-side-h"><span class="ide-side-title" id="ideTreeTitle">资源管理器</span><span class="ide-side-acts"><button class="ide-side-btn" id="ideNewFile" title="新建文件(根目录;Ctrl+Shift+N)">＋文件</button><button class="ide-side-btn" id="ideNewDir" title="新建文件夹(根目录)">＋文件夹</button><button class="ide-refresh" id="ideRefresh" title="刷新根目录">刷新</button></span></div>
          <div class="ide-find" id="ideFind">
            <div class="ide-find-h"><span>全项目搜索(Ctrl+Shift+F)</span><button class="ide-side-btn" id="ideFindClose" title="关闭搜索面板">×</button></div>
            <input type="text" id="ideFindQ" placeholder="搜索文件内容…(Enter 搜索)" autocomplete="off" spellcheck="false">
            <div class="ide-find-row"><label><input type="checkbox" id="ideFindRe"> 正则</label><label title="大小写敏感">Aa<input type="checkbox" id="ideFindCase" style="display:none"></label><span id="ideFindMeta"></span></div>
            <div class="ide-find-res" id="ideFindRes"></div>
          </div>
          <div class="ide-tree" id="ideTree"><div class="cc-empty">无活动项目</div></div>
          <div class="ide-panel" id="ideScm" style="display:none">
            <div class="ide-p-meta" id="ideScmMeta">改动列表</div>
            <div class="ide-p-list" id="ideScmList"><div class="cc-empty">加载中…</div></div>
            <textarea id="ideScmMsg" placeholder="提交信息(必填)" rows="2"></textarea>
            <button class="ide-side-btn" id="ideScmCommit">✓ 提交</button>
          </div>
          <div class="ide-panel" id="ideProblems" style="display:none">
            <div class="ide-p-meta" id="ideProbMeta">问题</div>
            <div class="ide-p-list" id="ideProbList"><div class="cc-empty">暂无诊断(打开文件 / Ctrl+S 后刷新)</div></div>
          </div>
          <div class="ide-panel" id="ideOutline" style="display:none">
            <input type="text" id="ideOutlineQ" placeholder="筛选符号…" autocomplete="off" spellcheck="false">
            <div class="ide-p-list" id="ideOutlineList"><div class="cc-empty">打开 TS/JS 文件后展示符号</div></div>
          </div>
        </div>
        <div class="ide-main">
          <div class="ide-tabs" id="ideTabs"></div>
          <div class="ide-crumb" id="ideCrumb"></div>
          <div class="ide-body" id="ideBody">
            <div class="ide-welcome" id="ideWelcome">从左侧选择文件打开<br><span style="font-size:11px">标签可多开;改动未保存关闭会确认</span></div>
          </div>
          <div class="ide-term" id="ideTerm" style="display:none">
            <div class="ide-term-h"><span>终端(Ctrl+\` 开关)</span><button class="ide-side-btn" id="ideTermClose" title="收起终端(会话保留)">×</button></div>
            <pre id="ideTermOut">$ 输出区(term.session.read 轮询;无假回显)
</pre>
            <div class="ide-term-in-row"><span>›</span><input id="ideTermIn" placeholder="command…(Enter 发送)" autocomplete="off" spellcheck="false"></div>
          </div>
        </div>
      </div>
      <div class="ide-status" id="ideStatus"><span class="st" id="ideStMain">就绪</span><span class="st spacer"></span><span class="st" id="ideStPos">Ln 1, Col 1</span><span class="st" id="ideStSel"></span><span class="st" id="ideStLang"></span><span class="st" id="ideStIndent">空格:4</span><span class="st" id="ideStEnc">UTF-8</span><span class="st" id="ideStEol">LF</span><span class="st" id="ideStDirty"></span><span class="st" id="ideStCount">0 行</span></div>
    </div>
    <div class="view panel-wrap" id="view-sense">      <div class="sense-bar">
        <span class="vw-scope" title="Lens 取数作用域:sense.query 按项目根分析(code-sense 索引按项目),与当前选中会话无关">作用域:项目级(当前项目)</span>
        <input id="sense-q" placeholder="符号名 / file.ts:行 / 意图 / 页面" autocomplete="off">
        <select id="sense-mode">
          <option value="auto">auto</option><option value="debug">debug</option>
          <option value="plan">plan</option><option value="explore">explore</option><option value="ui">ui</option>
        </select>
        <button class="go" id="sense-go">分 析</button>
      </div>
      <div class="sense-meta" id="sense-status">输入查询 — auto 按形态判定剖面</div>
      <div class="sense-meta" id="sense-boardbar" style="display:none"><button class="vw-act" id="senseToBoard">带入白板(按当前剖面产物生成可编辑语义板)</button></div>
      <div class="sense-main" id="sense-mermaid">……</div>
      <div class="sense-detail" id="sense-detail"></div>
    </div>
    <div class="view panel-wrap" id="view-wf">
      <div class="vw-head"><span class="vw-title">自动化 Flows</span><span class="vw-sub">run_workflow · 确定性编排 · 提交后由主 agent 调用</span></div>
      <div id="wfRuns" class="todo-pop" style="margin-bottom:10px"></div>
      <div class="auto-sec" id="autoSec">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <span style="font-size:12px;color:var(--bronze)">定时自动化</span>
          <div class="auto-scope" id="autoScope">
            <button data-scope="global" class="on">全局</button>
            <button data-scope="project">本项目</button>
          </div>
        </div>
        <div id="autoList"><div class="cc-empty loading">加载中…</div></div>
        <div class="auto-form">
          <input name="name" placeholder="名称" autocomplete="off">
          <input name="instruction" placeholder="指令(到点作为系统任务提交)" autocomplete="off">
          <input name="every" placeholder="间隔分钟" autocomplete="off">
          <button id="autoAdd" style="background:transparent;border:1px solid var(--border-soft);color:var(--bronze);border-radius:7px;font-size:11px;padding:4px 12px;cursor:pointer">创建</button>
        </div>
      </div>
      <div class="wf-card">
        <div class="wf-name">单元测试 · unit-tests</div>
        <div class="wf-desc">自动发现 packages/* 逐包跑测试,失败包派 agent 分析根因。无需参数。</div>
 <button class="wf-go" id="wf-unit">提 交</button>
 </div>
 <div class="wf-card">
 <div class="wf-name">功能测试 · functional-test</div>
 <div class="wf-desc">场景清单逐项执行命令 + 确定性验证。参数 = scenarios JSON 数组。</div>
 <input class="wf-args" id="wf-func-args" placeholder='[{"name":"冒烟","run":"node --version"}]'>
 <div class="wf-err" id="wf-func-err">参数必须是 JSON 数组,如 [{"name":"冒烟","run":"…"}]</div>
 <button class="wf-go" id="wf-func">提 交</button>
 </div>
 <div class="wf-card">
 <div class="wf-name">算法效果评测 · algo-eval</div>
 <div class="wf-desc">数据集逐例 judge 判分并聚合命中率。参数 = cases JSON 数组。</div>
 <input class="wf-args" id="wf-algo-args" placeholder='[{"id":"c1","input":"1+1","expect":"2"}]'>
 <div class="wf-err" id="wf-algo-err">参数必须是 JSON 数组,如 [{"id":"c1","input":"…","expect":"…"}]</div>
 <button class="wf-go" id="wf-algo">提 交</button>
 </div>
 </div>
 <div class="view panel-wrap" id="view-exp">
 <div class="vw-head"><span class="vw-title">经验库 Memo</span><span class="vw-sub">Hermes 沉淀 · 主 agent 开工自动回顾</span>
 <span class="vw-scope" title="经验库取数作用域:exp.list 按项目沉淀(与当前会话无关)">作用域:项目级</span>
 <button class="vw-act" id="exp-refresh">刷新</button></div>
 <div id="exp-list" style="display:flex;flex-direction:column;gap:2px"></div>
 <div class="exp-body" id="exp-body" style="display:none"></div>
 </div>
 <!-- 团队视图(2026-10-16 收编:运行看板=团队「看板」子标签;每项目一块看板,作用域锁定当前项目) -->
 <div class="view panel-wrap" id="view-team">
 <div class="vw-head"><span class="vw-title">团队 Crew</span>
 <span class="vw-tabs"><button class="vw-tab on" id="teamTabMembers" title="成员在线状态/活动流/团队仓资产">成员</button><button class="vw-tab" id="teamTabIssues" title="Issue 看板:待办/进行中/已完成三列拖拽;双通道(github/gitlab 原生,token 缺=仓内自建);确认后派任务">Issue</button><button class="vw-tab" id="teamTabDash" title="运行看板:会话状态灯/趋势/干预与拒绝(按项目切分)">看板</button></span>
 <span class="vw-sub team-only" id="teamSubMembers">成员在线状态+活动流(relay 不可达如实显示;多 org 并存)</span>
 <span class="vw-sub dash-only" id="dashLive">会话状态灯 · 近 7 天趋势 · 实时推送</span>
 <button class="vw-act team-only" id="team-refresh">刷新</button><button class="vw-act team-only" id="team-invite">邀请成员</button>
 <select id="dashScope" class="dash-only" title="看板作用域:进入即锁定当前项目,可切换全部/其他项目/未归属" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:8px;font-size:11px;padding:2px 6px;max-width:220px"><option value="all">全部</option></select>
 <button class="vw-act dash-only" id="dash-refresh">刷新</button></div>
 <div id="teamPaneMembers" style="display:flex;flex-direction:column;gap:10px"><div id="team-orgs" style="display:flex;flex-direction:column;gap:10px"></div></div>
 <!-- fixD5:Issue 看板面板(三列 todo/doing/done;卡片 HTML5 拖拽改状态写回通道;顶部项目/指派筛选) -->
 <div id="teamPaneIssues" style="display:none;flex-direction:column;gap:10px">
 <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
 <select id="issueFp" title="按项目筛选" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:8px;font-size:11px;padding:2px 6px;max-width:200px"><option value="all">全部项目</option></select>
 <select id="issueFa" title="按指派人筛选" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:8px;font-size:11px;padding:2px 6px;max-width:180px"><option value="all">全部指派</option></select>
 <span id="issueChanTag" style="font-size:9.5px;color:var(--faint)"></span>
 <button class="vw-act" id="issueNewBtn" title="标题/正文/指派/项目,走当前通道">+新建 issue</button>
 <button class="vw-act" id="issueSyncBtn" title="仓内自建通道:git 提交 .genie/issues 共享(原生通道无需)">同步到 git</button>
 </div>
 <div id="p2pStrip" style="display:flex;gap:10px;flex-wrap:wrap"></div>
 <div id="issueBoard" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;align-items:start">
 <div class="issue-col" data-col="todo"><div class="issue-col-h">待 办 <span id="issueCntTodo"></span></div><div class="issue-cards" data-col="todo"></div></div>
 <div class="issue-col" data-col="doing"><div class="issue-col-h">进 行 中 <span id="issueCntDoing"></span></div><div class="issue-cards" data-col="doing"></div></div>
 <div class="issue-col" data-col="done"><div class="issue-col-h">已 完 成 <span id="issueCntDone"></span></div><div class="issue-cards" data-col="done"></div></div>
 </div>
 </div>
 <!-- 看板面板(原顶级 view-dash 收编;数据源/渲染/协议不变,dashLoad/dashRender 全保留) -->
 <div id="view-dash">
 <div id="dash-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px"></div>
 <div id="dash-trend" style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px"></div>
 <div id="dash-body" style="display:flex;flex-direction:column;gap:10px"></div>
 <!-- 详情抽屉(ref session-dialog 对应物) -->
 <div id="dashDrawer"><div class="dash-d-head"><span>会话详情</span><button class="vw-act" data-dashclose="1">关闭</button></div><div id="dashDetailBody"></div></div>
 </div>
 </div>
 <!-- Super Agent 指挥台(独立 view:左=持久聊天渲染区,右=调度看板四区;右下角 widget=快捷入口)。
 看板四区借鉴 ref/dsh-superagent-prototype(docs/005-panel.md 三问看板 / src/core/stage.ts 人先行:
 待人工置顶、计数=清单长度、健康态不占位)。数据源全部既有 WS:super.history / super.inbox /
 task.list / project.list / nodes.list;聊天发送 super.turn,动作复用 ask.user.answer /
 permission.respond / task.resume 既有协议,零新后端。 -->
 <div class="view panel-wrap" id="view-super">
 <div class="vw-head"><span class="vw-title">指挥台 Super</span>
 <span class="vw-sub">IDE 三栏:左=任务/做梦功能区,中=结果呈现,右=Super 对话(可折叠);动手一律 spawn_task 派发</span>
 <span class="vw-scope" id="superScope" title="super 固定持久会话(journal 持久;刷新/重启后自动回放;旧按天日卷 super:YYYYMMDD 只读兼容)">作用域:全局 · 会话 <span class="sup-mono" id="superSidDay"></span></span>
 <button class="vw-act" id="super-refresh">刷新</button></div>
 <!-- super IDE 三栏:活动栏(56px 任务/做梦;看板 P1)+侧栏(280px 功能区列表)+中栏(结果呈现)。
 聊天窗=右缘叠层(superChatCol 子树原样迁入,DOM 不重建:保滚动位置/轮询状态);全部新 CSS 前缀 spide-* 包 #view-super。 -->
 <div id="superIdeWrap">
 <div class="spide-act" id="superIdeAct">
 <button class="spide-actbtn on" data-spidezone="task" title="任务区:super 派发的任务列表(排队/运行/完成/失败)">任</button>
 <button class="spide-actbtn" data-spidezone="inbox" id="superActInbox" title="待办区:Super 转接的提问、权限请求、中断/失败任务">办<span class="spide-badge" id="superInboxBadge"></span></button>
 <button class="spide-actbtn" data-spidezone="dream" title="做梦区:RSI 机制卡(开关/驱动/运行)+全量运行;开始/完成卡自动注入聊天流">梦</button>
 <button class="spide-actbtn" data-spidezone="health" title="健康区:12 机制体检一屏(健康度/三色计数/Top 发现;进指挥台默认页)">健</button>
 </div>
 <div class="spide-side" id="superIdeSide">
 <div class="spide-side-zone" id="superSbTask">
 <div class="spide-side-h">派发任务 <span class="sup-cnt" id="superSbTaskCnt"></span></div>
 <div class="spide-list" id="superSbTaskList"></div>
 </div>
 <!-- 待办区:提问/权限/中断/失败(此前只在隐藏的看板四区里,三栏布局下没有入口) -->
 <div class="spide-side-zone" id="superSbInbox">
 <div class="spide-side-h">待你处理 <span class="sup-cnt" id="supInboxCnt"></span></div>
 <div class="spide-empty" style="padding:2px 2px 6px">Super 转接的提问、权限请求、中断/失败任务;处理后回到任务/健康区。</div>
 <div class="spide-list" id="supInbox"></div>
 </div>
 <div class="spide-side-zone" id="superSbDream">
 <div class="spide-side-h">做梦机制 <span class="sup-cnt" id="superSbDreamCnt"></span></div>
 <div id="rsiRunAllWrap"><button class="vw-act" id="rsiRunAll" title="逐个运行全部已启用机制(startMechanismRun;运行中禁用防重入)">全量运行</button></div>
 <div class="spide-list" id="superSbDreamList"></div>
 </div>
 <!-- 健康区:侧栏=体检摘要+全量运行入口(中栏 health 一屏的引导位;默认选中) -->
 <div class="spide-side-zone" id="superSbHealth">
 <div class="spide-side-h">系统体检 <span class="sup-cnt" id="superSbHealthCnt"></span></div>
 <div id="superSbHealthHint" class="spide-empty" style="padding:2px 2px 6px">12 机制体检一屏:健康度+三色计数+Top 发现;点卡片看「医生的话」。</div>
 <div id="rsiRunAllWrapH"><button class="vw-act" id="rsiRunAllH" title="逐个运行全部已启用机制(startMechanismRun;运行中禁用防重入)">全量运行</button></div>
 <div class="spide-list" id="superSbHealthList"></div>
 </div>
 </div>
 <div class="spide-main" id="superIdeMain">
 <div class="spide-welcome" id="superMainWelcome">从左栏选一个任务或做梦机制,详情在这里呈现;<br>也可以直接在右侧对话窗对 Super Agent 说:查状态 / 派任务 / 跨项目联调。</div>
 <div class="spide-doc" id="superMainTask"></div>
 <!-- 健康一屏(默认 zone):总览卡 #superHealthTop + 12 机制体检卡网格 #superHealthGrid -->
 <div class="spide-doc" id="superMainHealth">
 <div id="superHealthTop"></div>
 <!-- Coding Agent 结果流:聊天窗只留 Super 对话,任务/做梦结果统一在中间呈现 -->
 <div id="superResultFeed" style="display:none"></div>
 <div id="superHealthGrid"></div>
 </div>
 <div class="spide-doc" id="superMainDream">
 <div id="rsiHead">RSI 机制 · 做梦</div>
 <!-- 2026-11-13 RSI-SELF-DRIVE:自动周期条(开关/间隔/下一拍/预算/推一拍;数据=rsi.status.scheduler) -->
 <div id="rsiSchedBar" class="rsi-sched" style="display:none"></div>
 <!-- 医生的话(rsiRender 后置填充;无数据时整个隐藏,不渲染空引言块) -->
 <div class="spide-brief" id="rsiBrief" style="display:none"><div class="spide-brief-h">医生的话</div><div class="spide-brief-body"></div></div>
 <div id="rsiCards"></div>
 <!-- 原始 items 折叠(rsiRender 后置填充;默认收起) -->
 <details class="spide-fold" id="rsiFold" style="display:none"><summary>原始结果条目 items</summary><div class="spide-fold-body" id="rsiFoldBody"></div></details>
 <!-- 2026-11-11 RSI-SESSION:固定会话窗(所有机制运行都追加到会话 rsi,这里内嵌它的实时工作流) -->
 <div id="rsiStream">
 <div id="rsiStreamHead">RSI 会话 · <b>rsi</b> <span id="rsiStreamMeta"></span></div>
 <div id="rsiStreamBody"><div class="rsi-empty">尚无 RSI 运行记录。点任意机制的「运行」,工作过程会在这里实时显示。</div></div>
 </div>
 </div>
 </div>
 <!-- 左栏宽度拖拽手柄(拖动改 --superSb;localStorage 持久) -->
 <div class="spide-grip" id="superSbGrip" title="拖动调整左栏宽度"></div>
 </div>
 <!-- 聊天窗(右栏,常驻不可折叠):superChatBody/superComposer/superInput/superSend 原 id 原样迁入,DOM 移动不重建 -->
 <div class="spide-chat" id="superIdeChat">
 <!-- 聊天窗宽度拖拽手柄(拖动改 --superChatW;localStorage 持久) -->
 <div class="spide-chat-grip" id="superChatGrip" title="拖动调整聊天窗宽度"></div>
 <!-- 聊天窗头部:身份 + 实时状态(空闲/思考中/等你回答/派发中)+ 回最新 -->
 <div class="spide-chat-h" id="superChatHead">
 <span class="sch-ava" aria-hidden="true">S</span>
 <div class="sch-id">
 <div class="sch-name">Super Agent<span class="sch-state" id="superChatState"></span></div>
 <div class="sch-sub" id="superChatSub">指挥台 · 空闲 · 任务与结果在中栏</div>
 </div>
 <button class="sch-latest" id="superChatLatest" title="回到最新消息">↓ 最新</button>
 </div>
 <!-- 实时指挥状态条:研判/调度/委托 阶段 + 当前动作 + 秒表(仅 Super 轮次与在途委托时出现) -->
 <div id="superRunBar" class="sup-runbar" style="display:none"></div>
 <div class="spide-chat-body" id="superChatCol">
 <div id="superChatBody"></div>
 <!-- 与 coding agent 主聊天同款 composer:textarea + 工具栏 + 圆形发送键 + 快捷指令菜单 -->
 <div id="superComposer">
 <div class="composer" id="superComposerBox">
 <textarea id="superInput" rows="1" placeholder="对 Super Agent 说…(查状态 / 派任务 / 跨项目联调)" autocomplete="off" spellcheck="false"></textarea>
 <div class="composer-bar">
 <div class="composer-plus" id="superQuickBtn" title="快捷指令(查活跃任务 / 今日体检 / 派任务)">+</div>
 <span class="mode-pill" id="superScopePill" title="Super 只做调度:动手任务派给 Coding Agent">指挥 · 调度</span>
 <span class="mode-pill" id="supCtxPill" title="Super 会话上下文用量(实测 inputTokens;点按刷新)">上下文</span>
 <span style="flex:1"></span>
 <button class="vw-act" id="supCompactBtn" title="手动压缩 Super 会话历史(与 coding /compact 同源;超阈也会自动压缩)" style="padding:2px 9px;font-size:11px">压缩</button>
 <button class="send-btn" id="superSend" title="发送 (Enter)">发</button>
 </div>
 <div id="superQuickMenu" class="sup-quick-menu" style="display:none">
 <button data-supquick="现在系统里有哪些活跃任务?">查活跃任务</button>
 <button data-supquick="简单汇报一下最近 12 小时的机制体检结果">今日体检</button>
 <button data-supquick="帮我派一个任务:">派任务</button>
 <button data-supquick="体检一下系统:运行状态、任务分布、服务商与凭证在场、生效模型">系统体检</button>
 <button data-supquick="列出全部服务商与模型目录,并说出生效模型是哪个">服务商清单</button>
 </div>
 </div>
 <div class="hint" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 2px 0"><span>Enter 发送 · Shift+Enter 换行</span><span style="margin-left:auto">任务/结果在中栏</span></div>
 </div>
 </div>
 </div>
 <!-- 看板四区 P1 收编(待办区已迁到三栏侧栏 superSbInbox;其余区保留 DOM 但隐藏) -->
 <div class="spide-board" id="superBoardCol" style="display:none" aria-hidden="true">
 <div class="sup-sec">
 <div class="sup-sec-h">工作区 × 任务</div>
 <div class="sup-list" id="supProjects"></div>
 </div>
 <div class="sup-sec">
 <div class="sup-sec-h">活跃任务流 <span class="sup-cnt" id="supActiveCnt"></span></div>
 <div class="sup-list" id="supActive"></div>
 </div>
 <div class="sup-sec">
 <div class="sup-sec-h">系统健康</div>
 <div class="sup-list" id="supHealth"></div>
 </div>
 </div>
 </div>
 <!-- 原「总线路」一级视图已并入代码档案「总路线」tab -->
 <div class="view panel-wrap" id="view-nodes">
 <div class="vw-head"><span class="vw-title">节点 Fleet</span><span class="vw-sub">注册/负载/命令下发/远程项目;接入向导在设置-远程连接</span>
 <span class="vw-scope" title="节点注册表是全局设施(nodes.list 无 session 维度),与当前选中会话无关">作用域:全局</span>
 <button class="vw-act" id="nodes-refresh">刷新</button></div>
 <div id="nodes-body" style="display:flex;flex-direction:column;gap:10px"></div>
 </div>
 <div class="view panel-wrap" id="view-approvals">
 <div class="vw-head"><span class="vw-title">关卡 Gate</span><span class="sup-cnt" id="approvalsCount"></span><span class="vw-sub">挂起权限批量处理+最近决定;超时自动拒(fail-closed 不变)</span>
 <span class="vw-scope" title="挂起权限是全局队列(permission.pending 无 session 维度),可批量放行">作用域:全局</span>
 <button class="vw-act" id="approvals-refresh">刷新</button></div>
 <div id="approvals-body" style="display:flex;flex-direction:column;gap:8px"></div>
 </div>
 <!-- n3 看板融合:「分身 Agents」独立视图已删(CV_CARDS 同步删卡)。
 原分身卡的独有能力(注册表运行态/失败原因 reap/模型/会话短码/终态文本)全部并入下面这张卡。 -->
 <!-- 子agent会话流(2026-10-21 分身消息独立一个看板,不与 coding agent 共用会话流)。
 选中式消息流:左=子代理选择器(运行中/已结束两区),右=选中者的实时消息流
 (派发卡→assistant 文本→工具合并卡→终态卡),形态对齐主 chat。画布形态专属卡:经典布局 CSS 隐藏且无入口。
 n3 融合后左栏条目额外承载:模型标签/会话短码/失败原因(reap)/终态文本展开(≤200 字)。 -->
 <div class="view panel-wrap" id="view-subchat">
 <div class="vw-head"><span class="vw-title">子代理会话流</span><span class="vw-sub">分身注册 · 消息流(左选子代理,右看它的实时消息流)</span>
 <span class="vw-scope" id="scopeSubchat" title="本卡取数作用域:只列当前选中会话派出的子代理">作用域:当前会话</span>
 <button class="vw-act" id="subchat-refresh">刷新</button></div>
 <div id="subchat-body"><div id="subchat-list"></div><div id="subchat-pane"></div></div>
 </div>
 <div class="view panel-wrap" id="view-track">
 <div class="vw-head"><span class="vw-title">追踪 Trace</span><span class="vw-sub">召回·审途统计(上)+ turn × 五阶段 × 阶段任务(下)</span>
 <span class="vw-scope" id="scopeTrack" title="本卡取数作用域:跟踪的是当前选中会话">作用域:当前会话</span>
 <button class="vw-act" id="track-refresh">刷新</button></div>
 <!-- 2026-10-21 统计区与 turn 树合成一个流式数据区——
 旧实现两区各自 overflow:auto + sw-slot max-height:44%,把卡切成上下两个独立滚动窗口。
 现在唯一滚动落在卡自身(.view overflow-y:auto),统计区只在有数据时作为头部块出现
 (#sw-slot:not(.sw-active) 整块隐藏,避免空态占位),turn 树即最后一个数据块。 -->
 <div id="sw-slot"></div>
 <div id="track-body"></div>
 </div>
 <!-- 轨迹独立视图(原 #trajBoard 全屏 overlay → 视图内常驻内容区;外层 #view-traj,内层保留 id="trajBoard")。
 三 pane 同屏切换:逐次决策(卡片)/ 事件账本(行表)/ 泳道(工具·消息·系统三轨 + turn 分隔线 + 聚合摘要)。
 唯一数据源 = histEvents(前端已在场的会话重放事件,零额外请求),取数只走 PAGE 内函数 trajBoardRefresh。 -->
 <div class="view panel-wrap" id="view-traj">
 <div class="vw-head"><span class="vw-title">轨迹 Trail</span><span class="vw-sub">逐次决策 + 事件账本 + 泳道(同一视图,数据源=本会话事件)</span>
 <span class="vw-scope" id="scopeTraj" title="本卡取数作用域:只读当前选中会话的重放事件">作用域:当前会话</span>
 <button class="vw-act" id="trajViewRefresh">刷新</button></div>
 <div id="trajBoard" class="traj-board">
 <div class="traj-board-box">
 <div class="tb-head">
 <span class="tb-title">轨迹看板</span>
 <span class="tb-sid" id="trajBoardSid"></span>
 </div>
 <div class="tb-sum" id="trajBoardSum"></div>
 <div class="tb-bar">
 <span class="tb-chip on" data-traj-pane="decisions" title="逐次 LLM 决策:一次调用一张卡,可展开看未命中输入与输出全文">逐次决策</span>
 <span class="tb-chip" data-traj-pane="ledger" title="事件账本:本会话全部事件逐行(原行表)">事件账本</span>
 <span class="tb-chip" data-traj-pane="lanes" title="泳道:工具/消息/系统三轨并排,含 turn 分隔线与聚合摘要">泳道</span>
 <span class="tb-chip on" data-traj-mode="all">全部</span>
 <span class="tb-chip" data-traj-mode="model">模型</span>
 <span class="tb-chip" data-traj-mode="tool">工具</span>
 <span class="tb-chip" data-traj-mode="error">错误</span>
 <input id="trajSearch" class="tb-search" placeholder="搜摘要/标签/工具名…" autocomplete="off" spellcheck="false">
 <span class="tb-chip" id="trajExpandAll" title="展开当前可见范围内的卡片并按其拉取全文(单次上限 30 张,避免一次拉上百个文件)">全部展开</span>
 <span class="tb-chip" id="trajCopyPath" title="复制本会话的轨迹标识(前端无 journal 绝对路径变量,复制当前会话 id)">复制轨迹路径</span>
 </div>
 <div class="tb-bar" id="trajLaneBar" style="display:none">
 <span class="tb-chip on" data-traj-lmode="sequence" title="序列:按事件先后等距排布(默认)">序列</span>
 <span class="tb-chip" data-traj-lmode="duration" title="时长:横向同序列,块内底边条表达单次耗时">时长</span>
 <span class="tb-chip" data-traj-lmode="time" title="时间:按事件 time 落位(老会话缺 time 时按 seq 兜底)">时间</span>
 </div>
 <div class="tb-body">
 <div class="tb-cards" id="trajCardsHost"></div>
 <div class="tb-table" id="trajRowsHost"></div>
 <div class="tb-insp" id="trajInsp">点一行看明细</div>
 <div class="traj-lanes" id="trajLanesHost" style="display:none"><div class="traj-lanes-box" id="trajLanesBox"></div></div>
 </div>
 <div class="traj-lane-sum" id="trajLaneSum" style="display:none"></div>
 </div>
 </div>
 </div>
 <div class="view panel-wrap" id="view-usage">
 <div class="vw-head"><span class="vw-title">吞吐 Telemetry</span><span class="vw-sub">token/调用按模型×会话聚合(journal llm.trace)</span>
 <span class="vw-scope" id="scopeUsage" title="usage.view 协议无 session 参数(服务端全量聚合):前端按当前会话过滤展示">作用域:当前会话(前端过滤)</span>
 <button class="vw-act" id="usage-refresh">刷新</button></div>
 <div id="usage-body" style="display:flex;flex-direction:column;gap:8px;overflow:auto"></div>
 </div>
 <div class="view" id="view-sys">
 <div class="set-layout">
 <nav class="set-nav" id="setNav">
 <div class="set-ngroup">基础</div>
 <div class="set-nitem on" data-sec="general">通用</div>
 <div class="set-nitem" data-sec="appearance">外观</div>
 <div class="set-nitem" data-sec="shortcuts">快捷键</div>
 <div class="set-nitem" data-sec="model">模型设置</div>
 <div class="set-nitem" data-sec="context">上下文精简</div>
 <div class="set-nitem" data-sec="audio">语音助手</div>
 <div class="set-ngroup">智能体能力</div>
 <div class="set-nitem" data-sec="agents">子智能体</div>
 <div class="set-nitem" data-sec="skills">技能</div>
 <div class="set-nitem" data-sec="cmds">命令</div>
 <div class="set-nitem" data-sec="hooks">钩子</div>
 <div class="set-nitem" data-sec="mcp">MCP 服务器</div>
 <div class="set-nitem" data-sec="memory">记忆</div>
 <div class="set-nitem" data-sec="subagent">子代理与执行</div>
 <div class="set-nitem" data-sec="tools">工具</div>
 <div class="set-nitem" data-sec="automations">自动化</div>
 <div class="set-nitem" data-sec="experience">经验库</div>
 <div class="set-nitem" data-sec="browserctl">浏览器控制</div>
 <div class="set-nitem" data-sec="account">账号与额度</div>
 <div class="set-nitem" data-sec="remote">远程连接</div>
 <div class="set-ngroup">数据与统计</div>
 <div class="set-nitem" data-sec="data">数据与统计</div>
 <div class="set-nitem" data-sec="guide">引导中心</div>
 <div class="set-nitem" data-sec="about">关于</div>
 </nav>
 <div class="set-content">
 <div class="set-sec on" id="sec-general">
 <div class="vw-head"><span class="vw-title">通用</span><span class="vw-sub">行为与显示</span></div>
 <div class="set-row"><div class="sk">界面模式</div>
 <div class="seg" id="set-mode"><button data-v="code">编程模式</button><button data-v="office">办公模式</button></div>
 <div class="sd">编程模式展示命令/输出/变更详情;办公模式只留操作摘要与结果</div></div>
 <div class="set-row"><div class="sk">显示思考过程</div>
 <div class="seg" id="set-thinking"><button data-v="on">显示</button><button data-v="off">隐藏</button></div>
 <div class="sd">模型的思考折叠卡(推理内容)</div></div>
 <div class="set-row"><div class="sk">显示待办</div>
 <div class="seg" id="set-todo"><button data-v="on">显示</button><button data-v="off">隐藏</button></div>
 <div class="sd">会话状态条的 todo 清单</div></div>
 <div class="set-row"><div class="sk">分组工具调用</div>
 <div class="seg" id="set-g-search"><button data-v="on">聚合</button><button data-v="off">展开</button></div>
 <div class="sd">连续的读取/搜索工具聚合为「探索」分组</div></div>
 <div class="set-row"><div class="sk">分组终端命令</div>
 <div class="seg" id="set-g-term"><button data-v="on">聚合</button><button data-v="off">展开</button></div>
 <div class="sd">连续的命令执行聚合为「终端」分组</div></div>
 <div class="set-row"><div class="sk">分组文件更改</div>
 <div class="seg" id="set-g-changes"><button data-v="on">聚合</button><button data-v="off">展开</button></div>
 <div class="sd">连续的写入/编辑聚合为「更改」分组</div></div>
 <div class="set-row"><div class="sk">任务通知</div>
 <div class="seg" id="set-notify"><button data-v="on">开</button><button data-v="off">关</button></div>
 <div class="sd">任务完成/失败时发系统通知(浏览器授权)</div></div>
 <div class="set-row"><div class="sk">通知声音</div>
 <div class="seg" id="set-sound"><button data-v="on">开</button><button data-v="off">关</button></div>
 <div class="sd">通知时短提示音(合成音,无外部资源)</div></div>
 <div class="set-row"><div class="sk">自动归档旧任务</div>
 <div class="seg" id="set-autoarch"><button data-v="on">开</button><button data-v="off">关</button></div>
 <div class="sd">定时把已完成的旧任务归档(热生效)</div></div>
 <div class="set-row"><div class="sk">归档保留时长</div>
 <div class="seg" id="set-archdays"><button data-v="1">1 天</button><button data-v="3">3 天</button><button data-v="7">7 天</button><button data-v="30">30 天</button></div>
 <div class="sd">任务最后更新时间早于该时长才进自动归档</div></div>
 <div class="set-row"><div class="sk">任务最大步数</div>
 <input type="number" id="set-maxsteps" min="1" max="1000" style="width:90px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);padding:4px 8px;font-size:11.5px" autocomplete="off">
 <button class="vw-act" id="set-maxsteps-go">应用</button>
 <div class="sd">单个任务最多执行的「模型→工具」轮数(1-1000;保存后对下一个任务生效)</div></div>
 <div class="set-row"><div class="sk">断线重连间隔</div>
 <input class="num-in" id="set-reconnect" type="number" min="1" max="30" step="1">
 <div class="sd">秒(1-30);断开后按此间隔自动重连</div></div>
 <div class="set-row"><div class="sk">网络代理</div>
 <div class="kv" style="grid-template-columns:130px 1fr" id="proxy-kv">
 <span class="k">HTTPS_PROXY</span><span class="v">…</span>
 </div>
 <div class="sd">只读显示服务进程当前生效的代理环境(模型/工具流量继承该环境)</div></div>
 <div class="set-row"><div class="sk">语言</div><div class="sd">zh-CN(一期)</div></div>
 </div>
 <div class="set-sec" id="sec-appearance">
 <div class="vw-head"><span class="vw-title">外观</span><span class="vw-sub">主题与显示</span></div>
 <div class="set-row"><div class="sk">界面主题</div>
 <div class="seg theme-seg" id="set-theme"><button data-v="dark" title="鎏金夜:暗色青铜,默认"><i class="sw" style="background:#0b0806;box-shadow:inset 0 0 0 1px #c98f45"></i>鎏金夜</button><button data-v="light" title="暖纸:浅色羊皮纸"><i class="sw" style="background:#faf6ee;box-shadow:inset 0 0 0 1px #c98f45"></i>暖纸</button><button data-v="sand" title="砂陶松影:暖砂底/陶土主色/松林深绿"><i class="sw" style="background:linear-gradient(135deg,#E3DCD2,#CC8B65);box-shadow:inset 0 0 0 1px #013328"></i>砂陶松影</button><button data-v="glass" title="流光玻璃:玻璃拟态,高透面板/强模糊/光晕"><i class="sw" style="background:linear-gradient(135deg,#c4b5fd,#f0abfc)"></i>流光玻璃</button><button data-v="olive" title="橄榄赤陶:灰紫底/赤陶主色/橄榄绿"><i class="sw" style="background:linear-gradient(135deg,#CDCBD6,#D96846);box-shadow:inset 0 0 0 1px #596235"></i>橄榄赤陶</button><button data-v="plum" title="蓝调梅影:奶油底/梅紫主色/板岩蓝"><i class="sw" style="background:linear-gradient(135deg,#F2EBE5,#647295);box-shadow:inset 0 0 0 1px #9F496E"></i>蓝调梅影</button><button data-v="ink" title="薄墨:极简高对比,纸白/纯黑/单一朱红"><i class="sw" style="background:#ffffff;box-shadow:inset 0 0 0 1px #141414"></i>薄墨</button><button data-v="system" title="跟随系统深浅偏好">跟随系统</button></div>
 <div class="sd">面板配色,立即生效;跟随系统监听 prefers-color-scheme</div></div>
 <div class="set-row"><div class="sk">对话字号</div>
 <div class="seg" id="set-font"><button data-v="16">紧凑</button><button data-v="19">标准</button><button data-v="22">大</button></div>
 <div class="sd">回复正文字号(px)</div></div>
 <div class="set-row"><div class="sk">代码字号</div>
 <div class="seg" id="set-codefs"><button data-v="11">小</button><button data-v="12.5">中</button><button data-v="14">大</button></div>
 <div class="sd">代码块/查看器的字号,不受对话字号影响</div></div>
 <div class="set-row"><div class="sk">显示行号</div>
 <div class="seg" id="set-lineno"><button data-v="on">显示</button><button data-v="off">隐藏</button></div>
 <div class="sd">代码块与文件查看器左侧行号</div></div>
 <div class="set-row"><div class="sk">长行自动换行</div>
 <div class="seg" id="set-codewrap"><button data-v="on">换行</button><button data-v="off">横向滚动</button></div>
 <div class="sd">代码内容过长时的排版方式</div></div>
 <div class="set-row"><div class="sk">界面缩放</div>
 <div class="seg" id="set-zoom"><button data-v="0.9">90%</button><button data-v="1">100%</button><button data-v="1.1">110%</button><button data-v="1.25">125%</button></div>
 <div class="sd">整体缩放(Ctrl + / Ctrl - / Ctrl 0)</div></div>
 <div class="set-row"><div class="sk">代码预览</div>
 <div class="codeprev-row">
 <div class="codeprev" id="prev-light"><div class="cp-head">浅色预览</div><pre class="code"><span class="cl">const theme = {</span><span class="cl"> surface: "panel",</span><span class="cl"> accent: "#c98f45",</span><span class="cl">};</span></pre></div>
 <div class="codeprev" id="prev-dark"><div class="cp-head">深色预览</div><pre class="code"><span class="cl">const theme = {</span><span class="cl"> surface: "panel",</span><span class="cl"> accent: "#c98f45",</span><span class="cl">};</span></pre></div>
 </div>
 <div class="sd">两种主题下代码块的实际渲染效果(当前生效的主题标亮)</div></div>
 </div>
 <div class="set-sec" id="sec-shortcuts">
 <div class="vw-head"><span class="vw-title">快捷键</span><span class="vw-sub">面板快捷键总览;与浏览器冲突的键提供了 Alt 备选,点击可自定义</span></div>
 <table class="kbd-table">
 <tbody id="kbdCustomRows"></tbody>
 <tbody>
 <tr><td>Ctrl Shift P</td><td>打开命令中心(备用,不可改)</td></tr>
 <tr><td>Ctrl F</td><td>会话内查找(Enter 跳转下一个)</td></tr>
 <tr><td>Ctrl T</td><td>切换思考力度(关→低→中→高;浏览器占用时用 Alt T)</td></tr>
 <tr><td>Ctrl Shift [ / ]</td><td>上一个/下一个任务(会话)</td></tr>
 <tr><td>Ctrl [ / ]</td><td>后退/前进(会话导航历史)</td></tr>
 <tr><td>Ctrl W</td><td>关闭当前会话标签(浏览器占用时用 Alt W)</td></tr>
 <tr><td>Ctrl O</td><td>打开项目切换(命令中心 · 项目列表)</td></tr>
 <tr><td>Ctrl + / Ctrl - / Ctrl 0</td><td>放大/缩小/恢复界面缩放</td></tr>
 <tr><td>F3</td><td>归档视图切换</td></tr>
 <tr><td>Esc</td><td>关闭菜单/查找条/对话框</td></tr>
 <tr><td>/</td><td>输入框开头唤起斜杠指令面板</td></tr>
 <tr><td>@ # $</td><td>文件/会话/技能三触发符提及</td></tr>
 <tr><td>↑ ↓ ↵ Esc</td><td>命令中心导航/确认/关闭</td></tr>
 <tr><td>Enter / Shift Enter</td><td>发送 / 换行</td></tr>
 </tbody>
 </table>
 <div style="margin-top:8px;display:flex;align-items:center;gap:10px">
 <button class="vw-act" id="kbdReset">恢复默认</button>
 <span class="sd">点「自定义」后按下新组合(Esc 取消);保存在浏览器本地,冲突组合自动让位</span>
 </div>
 </div>
 <div class="set-sec" id="sec-agents">
 <div class="vw-head"><span class="vw-title">子智能体</span><span class="vw-sub">内置 + 用户自定义(同名可覆盖内置)</span></div>
 <div id="agentsView"><div class="cc-empty loading">加载中…</div></div>
 </div>
 <div class="set-sec" id="sec-skills">
 <div class="vw-head"><span class="vw-title">技能</span><span class="vw-sub">内置方法论 + 用户沉淀(开工按需注入)</span></div>
 <div id="skillsView"><div class="cc-empty loading">加载中…</div></div>
 </div>
 <div class="set-sec" id="sec-cmds">
 <div class="vw-head"><span class="vw-title">命令</span><span class="vw-sub">自定义斜杠指令</span></div>
 <div id="cmdsView"><div class="cc-empty loading">加载中…</div></div>
 <div class="auto-form" id="cmdForm">
 <input name="cname" placeholder="命令名(如 deploy,斜杠后输入;小写字母/数字/-)" autocomplete="off">
 <input name="cbody" placeholder="指令模板(执行时填入输入框,可含 $ARG)" autocomplete="off">
 <button id="cmdSave">保存</button>
 </div>
 </div>
 <div class="set-sec" id="sec-hooks">
 <div class="vw-head"><span class="vw-title">钩子</span><span class="vw-sub">任务生命周期事件运行命令</span></div>
 <div id="hooksView"><div class="cc-empty loading">加载中…</div></div>
 <div class="auto-form" id="hookForm">
 <input name="hname" placeholder="名称" autocomplete="off">
 <select name="hevent" id="hookEventSel">
 <option value="task.start">task.start(任务开始)</option>
 <option value="task.done">task.done(完成)</option>
 <option value="task.fail">task.fail(失败)</option>
 <option value="task.cancel">task.cancel(取消)</option>
 </select>
 <input name="hcmd" placeholder="命令(在项目根执行,30s 超时)" autocomplete="off">
 <button id="hookSave">添加</button>
 </div>
 </div>
 <div class="set-sec" id="sec-mcp">
 <div class="vw-head"><span class="vw-title">MCP 服务器</span><span class="vw-sub">在界面中管理外部工具服务;接入后自动并入助手可用工具</span>
 <button class="vw-act" id="mcpRefresh">刷新状态</button></div>
 <div id="mcpView"><div class="cc-empty loading">加载中…</div></div>
 <div class="auto-form" id="mcpForm">
 <input name="mname" placeholder="名称(如 filesystem)" autocomplete="off">
 <input name="mcmd" placeholder="命令(如 npx)" autocomplete="off">
 <input name="margs" placeholder="参数(空格分隔,如 -y @modelcontextprotocol/server-filesystem /tmp)" autocomplete="off">
 <button id="mcpSave">添加</button>
 </div>
 </div>
 <div class="set-sec" id="sec-memory">
 <div class="vw-head"><span class="vw-title">记忆</span><span class="vw-sub">Super Agent 的跨会话记忆,此处只读查看;内容由 agent 的记忆工具维护</span></div>
 <div id="memoryView"><div class="cc-empty loading">加载中…</div></div>
 </div>
 <div class="set-sec" id="sec-model">
 <div class="vw-head"><span class="vw-title">模型设置</span><span class="vw-sub">供应商与各角色模型 · 保存后立即生效</span><span class="sd" id="cfg-path" style="margin-left:8px" title="同一配置项在多层同时存在时,靠右的覆盖靠左的:内置默认 < 用户级 < 项目级 < 环境变量"></span></div>

 <div class="set-group"><span class="gt">生效模型</span><span class="gl"></span><span class="sd">只影响当前会话;新会话跟随全局默认。切换失败自动回滚。</span></div>
 <div class="ms-switch" id="modelSwitch">
 <div class="ms-cur"><span class="sk">当前生效</span><b id="msw-current">(加载中…)</b><span class="sd" id="msw-scope"></span></div>
 <select class="cm-select" id="msw-select" aria-label="选择生效模型" disabled><option>(加载中…)</option></select>
 <button class="vw-act" id="msw-confirm" disabled>确认切换</button>
 <button class="vw-act" id="msw-retry" style="display:none">重试</button>
 <span class="ms-status" id="msw-status" role="status">加载配置…</span>
 </div>

 <div class="set-group"><span class="gt">各角色模型</span><span class="gl"></span><span class="sd">没单独配置的角色,都使用主模型</span></div>
 <div class="cm-roles">
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">主模型</span><span class="cr-sub">执行任务与对话的主力模型</span></div>
 <select class="cm-select" id="role-main"><option value="">(加载中…)</option></select>
 <div class="cr-foot"><span class="cr-hint">其他角色未设置时都回退主模型</span><span class="sd" id="role-main-badge"></span></div>
 </div>
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">子代理模型</span><span class="cr-sub">派生子任务时使用的模型</span></div>
 <select class="cm-select" id="role-subagent"><option value="">(默认使用主模型)</option></select>
 <div class="cr-foot"><span class="cr-hint">想让子任务用更快的模型时单独设置</span><span class="sd" id="role-subagent-badge"></span></div>
 </div>
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">压缩模型</span><span class="cr-sub" title="配置键 coding.models.compact">上下文压缩与导读</span></div>
 <select class="cm-select" id="role-compact"><option value="">(默认使用主模型)</option></select>
 <div class="cr-foot"><span class="cr-hint">长对话自动压缩时使用;未设置回退主模型</span><span class="sd" id="role-compact-badge"></span></div>
 </div>
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">提炼模型</span><span class="cr-sub" title="配置键 coding.models.digest">大结果与 git diff 提炼</span></div>
 <select class="cm-select" id="role-digest"><option value="">(默认回退压缩模型)</option></select>
 <div class="cr-foot"><span class="cr-hint">大结果/批量 diff 超阈值时用它提炼,不丢 hunk 与 file:line</span><span class="sd" id="role-digest-badge"></span></div>
 </div>
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">评审模型</span><span class="cr-sub" title="配置键 coding.models.review">提交后深度代码评审</span></div>
 <select class="cm-select" id="role-review"><option value="">(不配置=仅确定性层)</option></select>
 <div class="cr-foot"><span class="cr-hint">不配置则只跑确定性检查,不调用模型</span><span class="sd" id="role-review-badge"></span></div>
 </div>
 <div class="cm-role">
 <div class="cr-head"><span class="cr-name">语音任务书模型</span><span class="cr-sub" title="配置键 coding.models.voice">聊天窗 ◎ 录音 → 整理成任务书</span></div>
 <select class="cm-select" id="role-voice"><option value="">(未配置=语音任务书不可用)</option></select>
 <div class="cr-foot"><span class="cr-hint">只支持 omni 多模态模型(名字含 omni,如 qwen3.8-omni-flash);不配置则◎按钮不可用</span><span class="sd" id="role-voice-badge"></span></div>
 </div>
 </div>
 <div class="cm-effort-row">
 <div class="sk">思考力度</div>
 <div class="seg" id="effortSeg">
 <button data-v="">关</button><button data-v="low">低</button><button data-v="medium">中</button><button data-v="high">高</button><button data-v="xhigh">最高</button>
 </div>
 <span class="sd" id="effortNow">当前:高</span>
 <span class="sd">与输入框「思考」档位联动,保存即生效</span>
 </div>

 <!-- 添加供应商过程 UI:默认隐藏;结果态只呈现已接入供应商,点「添加供应商」才展开此弹窗 -->
 <div id="prov-modal-mask" hidden>
 <div class="prov-modal" role="dialog" aria-modal="true" aria-labelledby="prov-modal-title">
 <div class="prov-modal-head">
 <div><b id="prov-modal-title">添加供应商</b><span class="sd">从常用服务商一键接入,或手动填写端点</span></div>
 <button type="button" class="prov-modal-close" id="prov-modal-close" title="关闭" aria-label="关闭">×</button>
 </div>
 <div class="prov-modal-body">
 <div id="prov-preset-sec" class="prov-preset-sec">
 <div class="prov-sec-title">常用服务商 <span class="sd">点卡片,填 API Key 即可接入;端点已预填</span></div>
 <div class="preset-grid" id="provPresets"></div>
 </div>
 <details id="prov-manual-sec" class="prov-manual-sec">
 <summary id="prov-manual-toggle">手动填写(端点 / 模型)</summary>
 <div class="set-row cm-addprov"><div class="sk">添加供应商</div>
 <input class="num-in" id="prov-id" style="width:110px;text-align:left" placeholder="id 如 maas-bj">
 <input class="num-in" id="prov-name" style="width:110px;text-align:left" placeholder="显示名">
 <input class="num-in" id="prov-url" style="width:230px;text-align:left" placeholder="接口地址(OpenAI 兼容)">
 <input class="num-in" id="prov-key" style="width:130px;text-align:left" placeholder="API Key 环境变量名">
 <select class="cm-select cm-select-inline" id="prov-type" title="接口协议">
 <option value="chat">Chat(OpenAI 兼容)</option>
 <option value="responses">Responses</option>
 <option value="anthropic">Anthropic</option>
 </select>
 <button class="vw-act" id="prov-add">添加</button></div>
 <div class="cm-addmodel">
 <input class="num-in cm-adname" id="cm-new-name" style="text-align:left" placeholder="添加自定义模型(名称)" autocomplete="off">
 <select class="cm-select cm-select-inline" id="cm-new-prov" title="归属供应商"></select>
 <input class="num-in" id="cm-new-cw" placeholder="上下文" autocomplete="off">
 <input class="num-in" id="cm-new-mt" placeholder="最大输出" autocomplete="off">
 <button class="vw-act" id="cm-new-add">添加</button>
 <span class="sd" id="cm-new-status"></span>
 </div>
 </details>
 </div>
 </div>
 </div>

 <div class="set-group"><span class="gt">已接入供应商</span><span class="gl"></span><span class="sd">编辑、测试连接、拉取模型、设为默认、删除都在卡片内完成</span></div>
 <div id="prov-list"></div>
 <div class="prov-add-row"><button class="vw-act" id="prov-add-open">+ 添加供应商</button><span class="sd">从常用服务商一键接入,或手动填写端点</span></div>

 <div class="set-group"><span class="gt">模型目录</span><span class="gl"></span>
 <button class="vw-act" id="models-fetch">从端点拉取</button><span class="sd" id="models-status"></span></div>
 <details class="cm-model-dir" id="model-dir">
 <summary><span>已收录模型</span><span class="sd" id="model-dir-count"></span></summary>
 <div id="modelList" class="model-list"></div>
 </details>

 <div class="set-group"><span class="gt">03 连接测试</span><span class="gl"></span><span class="sd">Provider 卡内「测试连接」=只读探测(不合并目录);「全部检测」=逐模型真实最小调用</span>
 <button class="vw-act" id="models-probe-all" title="对列表内每个模型发一次最小调用,标记可用性(逐个真实探活)">全部检测</button><span class="sd" id="models-probe-status"></span></div>

 <details class="cm-adv" id="cfg-adv">
 <summary>高级(原始配置)</summary>
 <div class="set-row"><div class="sk">max_tokens · llm.maxTokens</div>
 <input class="num-in" id="cfg-mt" type="number" min="0" max="1000000" placeholder="(端点默认)">
 <button class="vw-act" id="cfg-mt-apply">应用</button>
 <span class="sd" id="cfg-mt-badge"></span></div>
 <div class="kv" id="cfg-kv"></div>
 </details>

 <div id="sec-websearch">
 <div class="set-group"><span class="gt">工具提供商</span><span class="gl"></span><span class="sd">联网工具(web_search 检索 / web_fetch 抓取)用哪个服务商;默认 DeepSeek,未填 Key 时自动改用内置 curl/静态抓取 + browser 渲染兜底</span></div>
 <div class="set-row"><div class="sk">搜索工具</div>
 <div class="seg" id="ws-provider">
 <button data-v="default" title="默认 DeepSeek:端点与密钥沿用已接入的 DeepSeek 供应商">默认(DeepSeek)</button>
 <button data-v="deepseek" title="显式指定 DeepSeek 搜索(Anthropic 兼容端点的服务端 web_search 工具)">DeepSeek</button>
 <button data-v="exa" title="Exa 检索 API">Exa</button>
 <button data-v="perplexity" title="Perplexity Sonar API">Perplexity</button>
 <button data-v="custom" title="自定义 OpenAI 兼容检索端点">自定义</button>
 <button data-v="off" title="关闭搜索 API:web_search 改用内置静态检索(curl 等价)+ browser">关闭(curl/browser)</button>
 </div>
 <div class="sd">默认态直接用已接入的 DeepSeek 密钥;没有密钥时不会报错,自动降级为内置静态检索(DuckDuckGo HTML),失败再指路 browser 工具。「关闭」= 强制走 curl/browser,即便配了密钥。</div></div>
 <div class="auto-form" id="wsForm">
 <input name="wkey" type="password" placeholder="API Key(可选:默认态沿用 DeepSeek 供应商的密钥)" autocomplete="off">
 <input name="wendpoint" placeholder="端点(可选,custom 必填;如 https://api.deepseek.com/anthropic)" autocomplete="off">
 <input name="wmodel" placeholder="模型(可选,perplexity/deepseek)" autocomplete="off">
 <button id="wsSave">保存</button>
 <button id="wsClear" title="清除配置(回到默认 DeepSeek,无密钥则走 curl/browser)">清除</button>
 </div>
 <div class="sd" id="wsState" style="margin-top:4px">当前:读取中…</div>
 </div>

 <datalist id="model-ids"></datalist>
 </div>
 <div class="set-sec" id="sec-context">
 <div class="vw-head"><span class="vw-title">上下文精简</span><span class="vw-sub">对话过长时,自动判断哪些内容重要、哪些可以压缩,为主模型腾空间</span></div>
 <div class="set-group"><span class="gt">工作模式</span><span class="gl"></span><span class="sd">默认用内置的本地小模型打分,无需任何配置;改动对下一个任务生效</span></div>
 <div class="set-row"><div class="sk">模式</div>
 <div class="seg" id="ms-mode">
 <button data-v="off">关闭</button><button data-v="shadow">只记录</button><button data-v="active">自动精简</button>
 </div>
 <span class="sd" id="ms-mode-badge"></span></div>
 <div class="set-row"><div class="sk">评分服务地址</div>
 <input class="num-in" id="ms-url" style="width:320px;text-align:left" placeholder="留空=内置本地服务(127.0.0.1:8105)">
 <span class="sd" id="ms-url-badge"></span></div>
 <div class="set-row"><div class="sk">模型 / 协议</div>
 <input class="num-in" id="ms-model" style="width:180px;text-align:left" placeholder="jev-150m">
 <select class="cm-select cm-select-inline" id="ms-api">
 <option value="jev">内置本地小模型(推荐)</option>
 <option value="openai">OpenAI 兼容服务(自定义)</option>
 </select>
 <span class="sd" id="ms-model-badge"></span></div>
 <div class="set-row"><div class="sk">API Key 环境变量名</div>
 <input class="num-in" id="ms-key" style="width:220px;text-align:left" placeholder="(用内置本地模型时留空)">
 <span class="sd" id="ms-key-badge"></span></div>
 <div class="set-row"><div class="sk">高级参数</div>
 <input class="num-in" id="ms-conf" type="number" min="0" max="1" step="0.05" style="width:80px" placeholder="0.9" title="置信度阈值:判断把握低于它就不动原文">
 <input class="num-in" id="ms-max" type="number" min="1" max="50" style="width:80px" placeholder="12" title="单次评分的候选条数">
 <input class="num-in" id="ms-every" type="number" min="1" max="100" style="width:80px" placeholder="5" title="每多少轮对话评分一次">
 <button class="vw-act" id="ms-save">保存</button>
 <span class="sd" id="ms-status"></span>
 <div class="sd">三个数依次是:置信度阈值(0-1) · 单批候选数 · 评分间隔(轮)</div></div>
 <div class="sd" style="max-width:900px;line-height:1.8;padding-bottom:8px">
 工作方式:内置的本地小模型(约 150MB,随本机自动启动)会阅读对话历史,给每段内容判断「重要/可压缩」。重要的原样保留;不重要的压成摘要;报错记录、你明确交代过的事、不可逆操作的结果始终保留,不会被压缩。「只记录」模式先把判断结果记下来供你查看,不动原文;「自动精简」才真正生效。
 </div>
 <details style="padding-bottom:16px"><summary class="sd">自部署细节(更换评分服务时才需要)</summary>
 <div class="sd" style="max-width:900px;line-height:1.8;padding-top:8px">
 内置服务=仓库 <code>services/model-150m</code>,网关启动时自动拉起(<code>127.0.0.1:8105</code>,POST <code>/decide</code>);首次使用先运行其 <code>setup.sh</code>(加载+预热约 1–2 分钟,网关最多等 5 分钟)。批量接口按 8 问/行分块,12 候选(24 问)自动拆 3 行;直接对上游 <code>05_serve</code> 会截断到 8 问,建议走批量服务。换 OpenAI 兼容服务时协议选「OpenAI 兼容服务(自定义)」。
 </div>
 </details>
 </div>
 <div class="set-sec" id="sec-audio">
 <div class="vw-head"><span class="vw-title">语音助手</span><span class="vw-sub" id="audio-track"></span></div>
 <div class="set-group"><span class="gt">语音输入/朗读模型</span><span class="gl"></span><span class="sd">只用于指挥台麦克风的语音转写;Super Agent 的对话大脑固定跟随 Coding 主模型,此处不再决定对话</span></div>
 <div class="set-row"><div class="sk">模型</div>
 <input class="num-in" id="a-chat-model" style="width:220px;text-align:left" autocomplete="off" list="model-ids" placeholder="(留空=跟随 Coding 模型)"><button class="vw-act" id="a-chat-apply">应用</button>
 <span class="sd" id="a-chat-badge"></span></div>
 <div class="set-row"><div class="sk">端点 baseUrl</div>
 <input class="num-in" id="a-chat-url" style="width:280px;text-align:left" placeholder="(继承主 coding 端点/留空=provider)">
 <button class="vw-act" id="a-chat-url-apply">应用</button>
 <span class="sd" id="a-chat-url-badge"></span></div>
 <div class="set-group"><span class="gt">语音识别(说话转文字)</span><span class="gl"></span><span class="sd">指挥台麦克风录音后实时转成文字;凭证与上面的语音对话模型共用</span></div>
 <div class="set-row"><div class="sk">provider / 模型</div>
 <input class="num-in" id="a-asr-prov" style="width:110px;text-align:left" placeholder="provider">
 <input class="num-in" id="a-asr-model" style="width:180px;text-align:left" placeholder="模型(如 qwen3-asr)">
 <button class="vw-act" id="a-asr-apply">应用</button>
 <span class="sd" id="a-asr-badge"></span></div>
 <div class="set-group"><span class="gt">语音合成(外部调用方)</span><span class="gl"></span><span class="sd">指挥台不做语音播放;此处配置仅服务于 voice.tts 的其它调用方</span></div>
 <div class="set-row"><div class="sk">provider / 模型 / 音色</div>
 <input class="num-in" id="a-tts-prov" style="width:90px;text-align:left" placeholder="provider">
 <input class="num-in" id="a-tts-model" style="width:150px;text-align:left" placeholder="模型">
 <input class="num-in" id="a-tts-voice" style="width:110px;text-align:left" placeholder="voice">
 <button class="vw-act" id="a-tts-apply">应用</button>
 <span class="sd" id="a-tts-badge"></span></div>
 </div>
 <div class="set-sec" id="sec-subagent">
 <div class="vw-head"><span class="vw-title">子代理与执行</span><span class="vw-sub">任务用什么方式跑、同时能跑几件</span></div>
 <div class="set-row"><div class="sk">执行方式</div>
 <div class="sd" id="exec-kind"></div></div>
 <div class="set-row"><div class="sk">全局并发</div>
 <input class="num-in" id="cfg-cc-max" type="number" min="1" max="64">
 <button class="vw-act" id="cfg-cc-apply">应用</button>
 <span class="sd" id="cfg-cc-badge"></span>
 <div class="sd">同时运行任务上限(重启生效)</div></div>
 <div class="set-row"><div class="sk">每会话并发</div><div class="sd" id="cc-perowner"></div></div>
 <div class="set-row"><div class="sk">系统任务并发</div><div class="sd" id="cc-system"></div></div>
 </div>
 <div class="set-sec" id="sec-tools">
 <div class="vw-head"><span class="vw-title">工具</span><span class="vw-sub">主 agent 在场工具面(单一出处)</span></div>
 <div id="tools-list"></div>
 </div>
 <div class="set-sec" id="sec-automations">
 <div class="vw-head"><span class="vw-title">自动化</span><span class="vw-sub">workflow 模板 · 确定性编排</span>
 <button class="vw-act" id="auto-open">打开自动化</button></div>
 <div id="auto-list"></div>
 </div>
 <div class="set-sec" id="sec-experience">
 <div class="vw-head"><span class="vw-title">经验库</span><span class="vw-sub">Hermes 沉淀 · 开工自动回顾</span>
 <button class="vw-act" id="exp-open">打开经验库</button></div>
 <div class="kv" id="exp-kv"></div>
 </div>
 <div class="set-sec" id="sec-browserctl">
 <div class="vw-head"><span class="vw-title">浏览器控制</span><span class="vw-sub">agent 无头浏览器工具(headless chromium)</span></div>
 <div class="set-row"><div class="sk">启用 browser 工具</div>
 <div class="seg" id="set-browser"><button data-v="on">开</button><button data-v="off">关</button></div>
 <div class="sd">开启后 agent 可 open/text/click/shot 网页(热生效)</div></div>
 <div class="set-row"><div class="sk">域名白名单</div>
 <input class="num-in" id="browser-domains" style="width:280px;text-align:left" placeholder="逗号分隔,如 example.com,127.0.0.1(空=全允许)">
 <button class="vw-act" id="browser-domains-apply">应用</button>
 <div class="sd">收紧 agent 可访问的域名</div></div>
 <div class="set-row"><div class="sk">面板侧</div>
 <button class="vw-act" id="browser-open-view">打开内嵌浏览器</button>
 <div class="sd">你自己看网页用(agent 工具之外)</div></div>
 </div>
 <div class="set-sec" id="sec-account">
 <div class="vw-head"><span class="vw-title">账号与额度</span><span class="vw-sub">自托管:本地身份 + 用量额度(非计费)</span></div>
 <div id="acctId"><div class="cc-empty loading">加载中…</div></div>
 <div class="quota-cards" id="quotaCards"></div>
 <div class="set-row"><div class="sk">周 token 预算</div>
 <input class="num-in" id="quota-budget" type="number" min="0" step="10000" placeholder="0=不设限">
 <button class="vw-act" id="quota-apply">应用</button>
 <div class="sd">超预算仅面板警示(自托管不硬拦;0=关闭)</div></div>
 </div>
 <div class="set-sec" id="sec-remote">
 <div class="vw-head"><span class="vw-title">远程连接</span><span class="vw-sub">把这台电脑/服务器接入为执行节点(SSH · Docker)</span></div>
 <div class="set-row"><div class="sk">主机</div>
 <input class="num-in" id="wiz-host" style="width:150px;text-align:left" placeholder="192.168.1.20">
 <input class="num-in" id="wiz-user" style="width:90px;text-align:left" placeholder="用户(root)">
 <input class="num-in" id="wiz-port" style="width:70px;text-align:left" placeholder="端口(22)">
 <input class="num-in" id="wiz-nodeid" style="width:130px;text-align:left" placeholder="节点 id(可选)">
 <button class="vw-act" id="wiz-ssh">生成 SSH 命令</button>
 <button class="vw-act" id="wiz-docker">生成 Docker 命令</button></div>
 <div id="wizOut"></div>
 <div class="stat-h">SSH 凭证(远程项目直连:remote:ssh 项目与远程文件树用)</div>
 <div class="set-row"><div class="sk">连接</div>
 <input class="num-in" id="sshcred-host" style="width:130px;text-align:left" placeholder="主机(10.0.0.5)">
 <input class="num-in" id="sshcred-user" style="width:90px;text-align:left" placeholder="用户">
 <input class="num-in" id="sshcred-port" style="width:60px;text-align:left" placeholder="22" value="22">
 <input class="num-in" id="sshcred-pass" type="password" style="width:130px;text-align:left" placeholder="密码(只入 secrets)">
 <button class="vw-act" id="sshcred-save">保存并测试</button></div>
 <div id="sshCredOut" style="font-size:11px;color:var(--faint);padding:2px 0 6px">密码加密保存在本机 .genie/secrets.json(仅本机可读,不进仓库不进日志);保存后自动做一次连接测试。</div>
 <div class="stat-h">已注册节点</div>
 <div id="nodeList"><div class="cc-empty loading">加载中…</div></div>
 <div class="stat-h">电脑控制(向在线节点发命令)</div>
 <div class="auto-form" id="nodeExecForm">
 <select id="nodeSel" style="background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px"></select>
 <input id="nodeCmd" placeholder="命令(在节点上执行)" style="flex:1;min-width:200px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 8px;outline:none">
 <button id="nodeExecGo" style="background:transparent;border:1px solid var(--border-soft);color:var(--bronze);border-radius:7px;font-size:11px;padding:4px 12px;cursor:pointer">下发</button>
 </div>
 </div>
 <div class="set-sec" id="sec-guide">
 <div class="vw-head"><span class="vw-title">引导中心</span><span class="vw-sub">上手清单(按真实状态自动勾) + 界面导览</span>
 <button class="vw-act" id="guideTour">重看导览</button></div>
 <div id="guideList"><div class="cc-empty loading">加载中…</div></div>
 </div>
 <div class="set-sec" id="sec-data">
 <div class="vw-head"><span class="vw-title">数据与统计</span><span class="vw-sub" id="sys-proj">全部会话的用量与统计汇总</span>
 <button class="exp-btn" id="statsExportJson" style="margin-left:auto">导出 JSON</button>
 <button class="exp-btn" id="statsExportCsv">导出 CSV</button>
 <button class="exp-btn" id="statsRefresh">刷新</button></div>
 <div id="statsView"><div class="cc-empty">加载中…(进入本分区时拉取)</div></div>
 <div class="kv" id="sys-kv" style="margin-top:10px"></div>
 </div>
 <div class="set-sec" id="sec-about">
 <div class="vw-head"><span class="vw-title">关于</span></div>
 <div class="kv" id="about-kv"></div>
 <!-- 应用更新:桌面壳才显示。更新源落盘 .genie/update-config.json,
 覆盖 genie.config.json 的 update.feedUrl;env 优先级最高。 -->
 <div id="upCfg" style="display:none">
 <div class="vw-head" style="margin-top:18px"><span class="vw-title">应用更新</span><span class="vw-sub" id="upCfgState">…</span></div>
 <div class="set-row" style="flex-wrap:wrap">
 <div class="sk">更新源</div>
 <input id="upFeedUrl" type="url" placeholder="https://…/update.json(留空=不启用)" autocomplete="off" spellcheck="false"
 style="flex:1;min-width:240px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);padding:5px 8px;font-size:11.5px">
 <button class="vw-act" id="upSave">保存并检查</button>
 <div class="sd" style="flex-basis:100%">桌面壳每 6 小时自动检查,也可从帮助菜单/托盘手动检查;留空则回退到 genie.config.json 的 update.feedUrl。</div>
 </div>
 <div class="set-row"><div class="sk">当前版本</div><div class="sd" id="upCfgInfo">-</div></div>
 </div>
 </div>
 </div>
 </div>
 </div>
 </div>
 <footer>
 <div class="aff-head"><span class="aff-title">PIPELINE</span><span class="aff-stage" id="aff-stage">空闲</span><!-- 沉淀入口(自聊天顶部置顶条迁至 footer,箭头所指「就绪」旁) --><button class="vw-act" id="expDistillBtn" style="display:none;margin-left:8px" title="一键沉淀:把当前会话最近任务的经验写入经验库(F5)">沉淀</button></div>
 <div class="aff-bar"><i id="aff-bar"></i></div>
 <!-- wf 待答:自会话流顶部置顶条迁来,独立一行;无待答时整块为空(empty 不占位) -->
 <div id="wfAskHost"></div>
 <div class="aff-strip">
 <div class="aff-stats"><span id="c-running">0</span> 运行 · <span id="c-queued">0</span> 排队 · <span id="c-done">0</span> 完成 · <span id="c-failed">0</span> 失败</div>
 <!-- 状态 chips(清单/子代理/压缩/wf/失败/重试): 自会话流顶部迁来,单行不折,不推消息 -->
 <div id="chatStatusbar"></div>
 <!-- 轮次时间轴(2026-10-14):#turnNav 自聊天列右缘浮层迁入 footer,与管线状态同条——刻度=轮次,点击跳转,红=含失败 -->
 <div id="turnNav" title=""></div>
 </div>
 <!-- quick-row 快捷卡已按移除(2026-10-13 视频:「没有必要」;与侧栏 经验库/自动化 入口重复) -->
 <div class="att-bar" id="attBar" style="display:none"></div>
 <!-- 2026-10-29 文件引用条:正文里的 [文件名](./路径) 引用渲染成 chip(与聊天气泡同形态;× 从正文移除) -->
 <div class="att-bar" id="fileRefBar" style="display:none"></div>
 <!-- ask_user 问答条(2026-10-19 许愿式编程):agent 需求取舍时发问,这里作答(选项按钮/自由输入) -->
 <div id="askBar" style="display:none;margin:0 0 8px;border:1px solid var(--bronze);border-radius:10px;background:var(--glass2);padding:10px 12px"></div>
 <!-- composer 容器(2026-10-13 视频 2 模型选择/模式/思考/用量全部入框,ZCode composer 对齐) -->
 <!-- #inChip=输入框指令 chip 覆盖层(绝对定位于 composer 内,chip 态渲染指令占位符) -->
 <div class="composer">
 <div id="inChip" style="display:none"></div>
 <!-- 占位符双态:空闲文案在此(静态初值);busy 态由 renderSendBtn 切「任务运行中,输入内容会排队」(ref i18n busyPlaceholder 双态) -->
 <textarea id="instruction" rows="1" placeholder="说点什么…(Enter 发送,Shift+Enter 换行;/ 打开指令;可拖文件/贴图)" autocomplete="off" spellcheck="false"></textarea>
 <div class="composer-bar">
 <!-- 命令「真执行」标识(视频):与 slashTypedSubmit 同一判定源,徽标亮=回车必然真实执行该命令,非装饰 -->
 <span id="cmdChip" class="cmd-chip" style="display:none"></span>
 <div class="composer-plus" id="attBtn" title="添加附件(图片可直接识别)或 @ 引用项目文件">+</div>
 <input type="file" id="attInput" multiple style="display:none">
 <div class="composer-plus" id="shotBtn" title="截图标注:截取屏幕 → 画框选区 → 标注意见 → 发送给任务" style="font-size:13px">✂</div>
 <div class="composer-plus" id="voiceBtn" title="语音输入:点击开始录音,再点一次结束 → AI 整理成任务书填入输入框" style="font-size:12px">◎</div>
 <span class="mode-pill" id="permPill" title="权限模式(点击选择,热生效)">询问每次</span>
 <span class="mode-pill" id="goalPill" style="display:none;cursor:pointer" title="会话目标(/goal 设置;点击查看/编辑)">目标</span>
 <span class="mode-pill" id="ctxPill" title="当前会话上下文用量(点击查看明细;粗估)">上下文</span>
 <span style="flex:1"></span>
 <span class="mode-pill" id="subDirBtn" style="cursor:pointer" title="本会话的全部子任务:运行中/已结束。点击打开详情与实时输出,可终止运行中的子任务">子代理<span id="subDirBadge" style="display:none"></span></span>
 <span class="mode-pill" id="trajBoardBtn" style="cursor:pointer" title="轨迹看板:按轮展开本会话每一步的类型/耗时/token/状态">轨迹</span>
 <span class="mode-pill" id="boardFloatBtn" style="cursor:pointer" title="任务白板(临时草图):当前代码改动任务的设计图/模块进度/评论——agent 干活时实时更新;项目静态知识看「代码档案」">白板</span>
 <span class="mode-pill" id="cvToggleBtn" style="cursor:pointer" title="切换到画布模式:全部视图变成画布上的卡片,可平移/缩放/自由布局 (Ctrl+Shift+C)">画布</span>
 <button class="model-trigger" id="modelPill" type="button" title="模型 = web coding 执行模型(任务执行轨;点击直接选择,热生效)"><span class="mt-icon" id="modelIcon"></span><span class="mt-label"><span class="mt-roll"><span class="mt-roll-in" id="modelRoll"></span></span></span><span class="mt-chev" id="modelChev"></span></button>
 <button class="thought-btn" id="effortPill" type="button" title="思考力度(点击选择,热生效):关/低/中/高/最高" aria-label="思考力度:高"><span class="tb-icon" id="effortIcon"></span><span class="tb-bar" aria-hidden="true"><span class="tb-fill" id="effortFill" style="height:75%"></span></span><span class="tb-text" id="effortText">思考:高</span></button>
 <button class="send-btn" id="go">发</button>

 </div>
 </div>
 <div id="slashMenu" style="display:none"></div>
 <div id="mentionMenu" style="display:none"></div>
 <div class="hint" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span id="workTimer" class="work-timer" style="display:none"></span><span>Enter 发送 · 输入 / 开指令面板 · idempotent</span></div>
 </footer>
</div>
<div id="taskMenu"></div>
<!-- 实时白板浮窗(2026-10-14 入口统一+升级):任务卡「白板/查看白板」chip 与 composer「白板」都开这里。
 左=本会话触发过的全部白板清单;中=Dify 风工作流画布(节点卡/贝塞尔边/缩放/框选/拖拽连线/添加模块/撤销重做全套);
 右=选中节点「干什么用」明细+评论(查看态评论直接落服务端)。与大白板视图同一板状态的两个视口。 -->
<div class="board-float bf-big" id="boardFloat" style="display:none">
 <div class="bf-head" id="bfHead">
 <span class="bf-title">实时白板</span>
 <span class="bf-prog" id="bfProg"></span>
 <span class="bf-spacer"></span>
 <button class="vw-act" id="bfEdit" title="进入编辑草稿态(节点表单/语义流程编辑,保存走 rev 乐观锁)">编辑</button>
 <button class="vw-act" id="bfContinue" title="把当前白板+你的评论整理成新指令发回会话执行">按板续作</button>
 <button class="vw-act" id="bfOpenView" title="到大白板视图(导出/批注层/从代码生成等完整工作区)">展开</button>
 <button class="bf-close" id="bfClose" title="收起">×</button>
 </div>
 <div class="bf-main">
 <aside class="bf-list" id="bfList"><div class="cc-empty loading">加载中…</div></aside>
 <div class="bf-graph" id="bfGraph"><div class="cc-empty">当前会话暂无白板——代码改动任务开工后,agent 的设计草图会实时出现在这里;左侧是本会话触发过的全部白板</div></div>
 <aside class="bf-detail" id="bfDetail"><div class="cc-empty">点画布节点看「干什么用」与语义流程,可直接写评论</div></aside>
 </div>
</div>
<div id="tourMask"><div class="tour-box"><h4 id="tourTitle"></h4><p id="tourText"></p><div class="tour-btns"><button id="tourSkip">跳过</button><button id="tourNext">下一步</button></div></div></div>
<div id="toastHost"></div>
<!-- 附件 lightbox(F6):输入区缩略图与聊天流媒体卡共用;点遮罩/Esc/关闭按钮三路关闭,关闭后焦点回来源元素 -->
<div class="att-lightbox" id="attLightbox" role="dialog" aria-modal="true" aria-hidden="true">
 <div class="att-lb-box">
 <div class="att-lb-media" id="attLbMedia"></div>
 <div class="att-lb-bar"><span class="att-lb-name" id="attLbName"></span><span class="att-lb-meta" id="attLbMeta"></span><button class="att-lb-close" id="attLbClose" type="button">关闭</button></div>
 </div>
</div>
<div id="dd"><div class="dd-head"><span id="ddTitle" class="dd-title">diff</span><button class="sd-close" id="ddClose" style="margin-left:auto">收起</button></div><div class="dd-body" id="ddBody"></div></div>
<!-- 子智能体目录(ZCode SubagentDirectory 对齐):本会话全部子 agent 两区(运行中/已结束),
 条目=状态点+角色+标题+已工作时长;点击条目下钻=任务详情与实时输出。
 数据源=session.status 3s 轮询的 subagentList(注册表在场)+journal spawn/result 事件
 (旧会话注册表缺席=降级渲染并标注「历史会话」)。 -->
<div id="subDir">
 <div class="dd-head"><span class="sd-title">子智能体目录</span><span class="sd-sub" id="subDirSub"></span><span style="flex:1"></span><button class="sd-close" id="subDirClose">收起</button></div>
 <div class="sd-body" id="subDirBody"><div class="sd-empty">加载中…</div></div>
</div>
<div id="selMenu" style="display:none"><button id="selSide">侧聊</button><button id="selQuote">引用</button></div>
<div id="fileViewer">
 <div class="fv-box">
 <div class="fv-head"><span class="fv-path" id="fvPath"></span><button class="fv-close" id="fvDrill" style="display:none" title="切换到代码档案 · 文件钻取并选中该文件">文件钻取</button><button class="fv-close" id="fvClose">关闭</button></div>
 <div class="fv-body" id="fvBody"></div>
 </div>
</div>
<!-- 评审评论一键回注——目标会话选择(评论所属/当前/新会话)+预览+附言 -->
<div id="revInjMask">
 <div class="fv-box rij-box">
 <div class="fv-head"><span class="fv-path">注入评审评论 → 聊天窗</span><button class="fv-close" id="revInjCancel"><svg class="icn" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg></button></div>
 <div class="rij-body" id="revInjBody"></div>
 </div>
</div>
<!-- 服务端目录浏览器(添加项目「打开文件夹」)——gateway 在 WSL,浏览的是真实 /home 路径 -->
<div id="dirBrowser">
 <div class="db-card">
 <div class="db-head"><span>选择文件夹</span><button class="fv-close" id="dbClose">关闭</button></div>
 <div class="db-path-row">
 <button id="dbUp" title="上级目录" aria-label="上级目录"><svg class="icn" viewBox="0 0 24 24"><path d="M5.5 14.5l6.5-6.5 6.5 6.5"/></svg></button>
 <input id="dbPath" placeholder="路径(绝对)" autocomplete="off" spellcheck="false">
 <button id="dbGo">跳转</button>
 </div>
 <div class="db-quick">
 <span class="db-anchor" data-p="__home__">主目录</span>
 <span class="db-anchor" data-p="/">根目录</span>
 <label class="db-hidden"><input type="checkbox" id="dbHidden">隐藏文件</label>
 <span id="dbErr" class="db-err"></span>
 </div>
 <div class="db-list" id="dbList"><div class="cc-empty loading">加载中…</div></div>
 <div class="db-foot"><span class="db-sel" id="dbSel"></span><button class="perm-allow" id="dbPick">选择此目录</button></div>
 </div>
</div>
<!-- 远程连接向导(SSH/WSL/Docker)——命令由服务端 wizard.gen 生成(节点注册形态) -->
<div id="projRemote">
 <div class="db-card" style="max-width:560px;width:92vw">
 <div class="db-head"><span id="prTitle">新建连接</span><span id="prSub" style="font-size:10px;color:var(--faint)"></span><button class="fv-close" id="prClose">关闭</button></div>
 <div class="pr-tabs">
 <button class="pr-tab2 on" data-kind="ssh">SSH</button>
 <button class="pr-tab2" data-kind="wsl">WSL</button>
 <button class="pr-tab2" data-kind="docker">Docker</button>
 <span style="flex:1"></span>
 <select id="prConfigImport" title="从 SSH config 导入" style="max-width:170px;background:var(--input-bg);border:1px solid var(--input-border);border-radius:7px;color:var(--text);font-size:11px;padding:4px 6px;outline:none;display:none"><option value="">从 SSH config 导入</option></select>
 </div>
 <div id="prBody"></div>
 <div class="pr-foot" style="display:flex;justify-content:flex-end;gap:8px;padding-top:10px">
 <button id="prCancel" style="background:transparent;border:1px solid var(--border-soft);color:var(--text);border-radius:7px;font-size:11px;padding:5px 14px;cursor:pointer">取消</button>
 <button id="prGo" style="background:var(--bronze);border:none;color:#111;border-radius:7px;font-size:11px;padding:5px 14px;cursor:pointer;font-weight:600;display:none">添加并连接</button>
 </div>
 </div>
</div>
<div id="permDialog">
 <div class="perm-box">
 <h3>权限请求</h3>
 <div class="perm-tool" id="permTool"></div>
 <div class="perm-sum" id="permSum"></div>
 <div class="perm-meta" id="permMeta"></div>
 <div class="perm-btns">
 <button class="perm-allow" id="permAllow">允许一次</button>
 <button class="perm-allow" id="permAlways" title="写入项目级规则,后续同类请求自动放行(F2)">总是允许</button>
 <button class="perm-deny" id="permDeny">拒绝</button>
 </div>
 </div>
</div>
<div id="cc">
 <div class="cc-box">
 <input id="cc-q" placeholder="搜索任务…(# 历史会话 · @ 文件 · > 命令)" autocomplete="off">
 <div id="cc-list"></div>
 <div class="cc-foot"><span>↑↓ 选择</span><span>↵ 打开会话</span><span>Esc 关闭</span></div>
 </div>
</div>
<!-- IDE 命令面板(Ctrl+Shift+P,仅 IDE 视图内拦截;含「转到文件」与 IDE 命令) -->
<div id="ideCmd">
 <div class="ide-cmd-box">
 <input id="ideCmdQ" placeholder="转到文件 / 执行 IDE 命令…(如 > 保存、> 新建文件、文件名)" autocomplete="off" spellcheck="false">
 <div id="ideCmdList"></div>
 <div class="ide-cmd-foot"><span>↑↓ 选择</span><span>↵ 执行</span><span>Esc 关闭</span><span id="ideCmdMeta"></span></div>
 </div>
</div>
<script src="/assets/diagram-renderer.js"></script> <!-- 自有图渲染器(零第三方依赖;纯函数解析/分层布局/SVG 绘制) -->
<script src="/assets/status-widget.js"></script>
<script src="/assets/super-console.js"></script> <!-- Super Agent 指挥台(自包含资产:待处理/活动/任务/会话) -->
<script src="/assets/board-page-layout.js"></script> <!-- 页面结构板语义布局引擎(纯函数;加载失败画布回退旧分层) -->
<script src="/assets/annotate-layout.js"></script> <!-- 截图标注组件拆移引擎(纯几何;加载失败组件模式禁用) -->
<script src="/assets/annotate-coords.js"></script> <!-- 截图标注坐标换算层(纯函数;缺失/加载失败→面板内联兜底并 console.warn,不抛) -->
<script src="/assets/ide-spectrum.js"></script> <!-- 2026-10-28 音频频谱分析件(离线 decodeAudioData+AnalyserNode;缺失/失败→媒体层仅播放,window.IdeSpectrum 不存在即降级) -->
<script src="/assets/ide-office.js"></script> <!-- 2026-10-29 Office(pptx/docx)只读预览渲染件(纯函数;缺失/失败→IDE 落降级文案,不白屏) -->
<script src="/assets/board-ui-flow-layout.js"></script> <!-- 2026-10-26 UI 交互流程板:多屏原型+元素锚点+彩色跳转流线(纯函数;加载失败回退页面结构板) -->
<script src="/assets/board-flow-layout.js"></script> <!-- fixH2 设计板流动 LR 布局引擎(入口→主线→出口;加载失败回退旧分层) -->
<script src="/assets/board-type-profile.js"></script> <!-- 2026-10-26 13 类板型画像:阶段/角色/硬规则徽标/flow 分支(纯函数;加载失败回退通用卡) -->
<script src="/assets/canvas-shell.js"></script> <!-- 2026-10-20 无限画布外壳:视图=卡片/左侧定位栏/平移缩放/布局持久化(加载失败=退回经典单视图) -->
<script>
/* 图视口引擎挂全局。资产尾部带 ESM export,经典 <script src> 会整文件 SyntaxError
 * (挂全局代码没机会执行),故用动态 import(模块上下文合法)挂 window;失败静默——
 * 面板内已有同式兜底数学(dvZoomAtPoint 回退链),引擎缺席行为不降级。
 * 挂载完成后若自有图渲染器已就绪,按当前主题基座补跑一次 configure(首次 configure
 * 在渲染器脚本加载时已执行,重复调用幂等)。 */
(function () {
  function mount(url, name) {
    try { return import(url).then(function (m) { if (m && !window[name]) window[name] = m.default || m; }).catch(function () {}); }
    catch (e) { return null; } // import 不可用(极老内核):静默,走面板兜底
  }
  mount("/assets/diagram-viewport.js", "DiagramViewport");
  if (window.OwnDiagram && typeof mmApplyTheme === "function") {
    try { mmApplyTheme(); } catch (e) { /* 补配置失败不影响首次 configure */ }
  }
})();
</script>
<script src="/assets/browser-view.js"></script> <!-- 2026-10-21 内置浏览器视图(形态来源 ZCode browser-use UnifiedBrowserView):截图面+工具栏+视口拖拽 -->
<script src="/assets/input-policy.js"></script> <!-- 网页版输入交互策略(分区:画布/侧栏接管,文本区例外) -->
<script>
/* 服务重启降级(视频 T1):注册 SW 缓存面板壳。停机窗口内刷新页面→缓存壳+探活横幅(svcWaitRestart),不再裸错误页。 */
if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("/assets/sw.js").catch(function () {}); } catch (e) {} }
</script>`;
