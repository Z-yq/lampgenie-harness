/** fixH1 白板「一眼看懂」流程图布局引擎(design 板 / 非 page 板专用):
 * 用户口径:「现在的图还是不大能看明白在干什么,因为现在的图没有大主线,不清楚入口在哪,出口在哪」。
 * 目标形态(对照理想示例图):横向从左到右流动 · 入口最左/出口最右 · 虚线圆角泳道框(编号+标题)
 * · 一条粗绿主线从入口贯穿到出口 · 节点卡(标题+实现细节副标题) · 边标签(数据格式/触发条件)
 * · 节点编号 01..N · 图例。
 *
 * 纯函数零 IO 零随机零 DOM(幂等,全部 tie-breaker 确定性),浏览器挂 BoardFlowLayout(panel.ts
 * renderBoardCanvas 调用),vitest 走 module.exports 单测。与 board-page-layout.js 互补:
 * page 板保持既有语义布局引擎不动;非 page 板有边时走本引擎。
 *
 * 产出:
 * - pos/size:LR 分层(DFS 剥离重试回边后 Kahn 最长入链),入口最左列、出口最右列;同列纵向等距;
 *   主线节点恒在基线上(整条主线横向拉直),分支上下外扩;孤立节点单独「未连接」列放最下;
 * - lanes:纵向虚线框分段(横向分段:一个阶段一段列区间),按 node.group / 阶段前缀 / kind 族分组,
 *   带编号(01..)与标题,bbox 覆盖组内节点;节点 id 带写者前缀(如 a1-card、c1-card)时泳道按写者分区,
 *   标题加前缀方括号(「[a1] 01 卡渲染」)——同名 group 多路写者各自成道,不再塌成一框;
 * - mainPath/mainEdges:入口(入度 0 中可达最多)→出口(出度 0 中距入口最远)的最长路径;
 * - entry/exit:供渲染层打「入口」「出口」角标;
 * - no:节点编号 Map(01..N,按 泳道序 → 层序 → id 稳定排序)。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(); // CJS(vitest/esbuild 转换)
  else {
    // 浏览器 script 标签挂全局;node ESM 下 this 为 undefined → self/globalThis 兜底(只挂全局不炸)
    root = root || (typeof self !== "undefined" ? self : globalThis);
    root.BoardFlowLayout = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- 尺寸常量(与 panel.ts 画布 CSS 协同;设计卡主标题+副标题+页脚) ----
  var MARGIN = 52;        // 世界外边距
  var NODE_W = 208;       // 节点卡宽
  var NODE_H = 116;       // 节点卡高(布局确定尺寸,渲染层 inline 固定同值)
  var LAYER_GAP = 56;     // 同泳道相邻列间距(箭头+边标签呼吸)
  var LANE_GAP = 46;      // 泳道切换处的额外列间距(虚线框+标题不打架)
  var ROW_GAP = 32;       // 同列节点纵向间距
  var LANE_HEAD = 42;     // 泳道框顶部标题条高(编号+标题;与节点编号角标错开)
  var LANE_PAD = 14;      // 泳道框左右内边距
  var LANE_TAIL = 12;     // 泳道框底部内边距
  var ORPHAN_GAP = 64;    // 「未连接」列与主流程的纵向间距
  var DFS_BUDGET = 24000; // 最长路径 DFS 节点预算(防指数爆炸;确定性:遍历序固定)
  // 主干换行(2026-10-25 实测「适配后主干只看到 5/7」):compact 下主干卡若全部沿同一 y 一字排开,
  // x 跨度 = (层数-1)×(卡宽+列距) → 60 节点板 7 张跨 1722px,而视口宽 1078 → 自然 k≈0.196 撞
  // CV_FIT_READABLE_MIN=0.7,一屏仍看不全。改成「按列换行」:每行最多 MAIN_WRAP_COLS 张,超出换下一行,
  // 行高 = 卡高 + MAIN_WRAP_ROW_GAP(≥48px 净行距,容得下连线与边标签),x 跨度收成 ≤4 卡 + 3 列距。
  var MAIN_WRAP_COLS = 4;
  var MAIN_WRAP_ROW_GAP = 52; // 行距(净空 ≥48px:箭头拐弯 + 边标签呼吸)
  // 宽板列换行(2026-10-25 任务 A):**非 compact** 的设计板也可能横跨 7+ 列(主路径 7 张卡一字排开
  // = 1792px),而面板 cvFitNow 有 0.7 可读下限 → 1078px 视口下右侧被裁。opts.wrap/opts.autoWrap
  // 受控开启:主路径列数 > 阈值时**按列折行**(复用 6c 主干换行思路),行内仍是 LR 左→右,行序=列序;
  // 直线分支/泳道数据原样保留(节点/边/laneOf 一个不丢)。缺省关闭 → 既有横排逐字不变。
  var WRAP_READABLE_COLS = 4; // 可读列数阈值(约 4 张卡宽 = 4×208+3×56 = 1000px)
  // 非 compact 折行的行距:额外加 LANE_TAIL(12)。泳道框顶部有 LANE_HEAD(42) 标题条、底部有
  // LANE_TAIL 内边距——行带内容间距 52 时,下一行标题条会压进上一行泳道框 2px(实测段框相叠)。
  var WRAP_LANE_ROW_GAP = MAIN_WRAP_ROW_GAP + LANE_TAIL;

  // kind 族 → 泳道标题(无 group 且无阶段前缀时的兜底分组)
  var KIND_LANE = {
    decision: "判断分支",
    llm: "模型智能", agent: "模型智能", classifier: "模型智能", retrieval: "模型智能",
    tool: "工具处理", http: "工具处理", template: "工具处理", aggregate: "工具处理",
    io: "输入输出", start: "输入输出", end: "输入输出",
    function: "函数", module: "模块", note: "备注",
    page: "页面", section: "区块", component: "组件", nav: "导航",
    "wf-script": "工作流", "wf-test": "工作流", "wf-agent": "工作流",
    "wf-condition": "工作流", "wf-parallel": "工作流", "wf-notify": "工作流",
  };

  function byId(nodes) {
    var m = new Map();
    for (var i = 0; i < nodes.length; i++) m.set(nodes[i].id, nodes[i]);
    return m;
  }

  function pad2(n) {
    var s = String(n);
    return s.length < 2 ? "0" + s : s;
  }

  /** 阶段前缀解析:「01 采集 MIC1」→ {no:1,title:"采集"} / 「02处理」→ {no:2,title:"处理"}。
   * 仅识别 1-2 位数字开头 + 可选分隔符 + 标题词(标题词到空格/常见分隔符止)。 */
  function stagePrefix(label) {
    var s = String(label || "").replace(/^\s+/, "");
    var m = /^([0-9]{1,2})[\s._\-\/、·:：]*([^\s,，;；|:：()（）\[\]【】]+)/.exec(s);
    if (!m) return null;
    var title = m[2];
    // 纯数字标题(如「01 001」)不可作为阶段名——避免把编号当语义
    if (!title || /^[0-9]+$/.test(title)) return null;
    return { no: Number(m[1]), title: title };
  }

  function layout(doc, opts) {
    // compact(2026-10-25):密度分层模式专用——面板已把非主干节点收成 +N 计数块,画布上只剩
    // 主线那几张卡。这时**不做** 7c 整框纵向让位 / 7d 碎泳道合并(它们是为「几十条泳道同时可见」
    // 服务的,会给每张主干卡分配独立的大纵向偏移:实测 60 节点板让位后主干卡跨 y 1818..3890
    // =2072px,而视口只 304px,适配 k 被读可读下限钳在 0.7,一屏仍只看得到 1 张卡)。
    // compact 下泳道框允许重叠(卡已收,重叠的虚线框不构成阅读障碍),主干按层横排。
    var compact = !!(opts && opts.compact);
    // 2026-10-26 板型画布:有 boardType 的板要放角色 chip/硬规则徽标/flow 分支，卡需要更高更宽;
    // 面板按板型传入，缺省仍是 208×116(既有板/单测逐字不变)。
    var NODE_W = Math.max(170, Math.min(320, Number(opts && opts.nodeW) || 208));
    var NODE_H = Math.max(96, Math.min(220, Number(opts && opts.nodeH) || 116));
    // 2026-10-26 refactor:现状/目标双泳道是核心语义,禁止 7b 几何合并/7d 碎条合并把两条并成一条。
    var preserveLanes = !!(opts && opts.preserveLanes);
    // 宽板列换行开关(受控):opts.wrap=true / opts.wrap=列数 / opts.autoWrap=true。
    // 是否真的折行还看主路径列数是否超过可读阈值(见 6c-w);compact 下走既有 6c,不重复折行。
    var wrapReq = !!(opts && (opts.wrap !== undefined && opts.wrap !== false ? opts.wrap : opts.autoWrap));
    var wrapColsReq = opts && typeof opts.wrap === "number" ? opts.wrap
      : (opts && opts.wrap && typeof opts.wrap === "object" && typeof opts.wrap.cols === "number" ? opts.wrap.cols : WRAP_READABLE_COLS);
    var wrapColsN = Math.max(2, Math.min(8, Math.floor(wrapColsReq) || WRAP_READABLE_COLS));
    var wrapMeta = { active: false, cols: 0, rows: 1 }; // 返回给面板:是否折行/每行几列/几行
    var wrapRowOf = new Map(); // id -> 行号(供泳道框按行拆段,保证泳道框不被拉成跨行巨框)
    var nodes = (doc && doc.nodes) || [];
    var edges = (doc && doc.edges) || [];
    var nm = byId(nodes);
    var pos = new Map();
    var size = new Map();
    var level = new Map();
    var laneOf = new Map();
    var no = new Map();
    var mainNodes = new Set();
    var mainEdges = new Set();
    var mainPath = [];
    var entry = null, exit = null;
    var mainWrapRows = 1, mainWrapCols = 0; // compact 主干换行的行数/行内列数(非 compact 恒 1/0)

    // ---- 1) 有效边(悬空端点/自环不参与分层;自环只记不排) ----
    var adj = new Map();      // from -> [to...]
    var indeg = new Map();    // 原始入度(入口判定)
    var outdeg = new Map();
    for (var ni0 = 0; ni0 < nodes.length; ni0++) {
      adj.set(nodes[ni0].id, []);
      indeg.set(nodes[ni0].id, 0);
      outdeg.set(nodes[ni0].id, 0);
    }
    var linkCount = new Map(); // 有效边数(区分孤立节点)
    for (var i = 0; i < nodes.length; i++) linkCount.set(nodes[i].id, 0);
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei];
      if (!e || !nm.has(e.from) || !nm.has(e.to) || e.from === e.to) continue;
      adj.get(e.from).push(e.to);
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
      outdeg.set(e.from, (outdeg.get(e.from) || 0) + 1);
      linkCount.set(e.from, linkCount.get(e.from) + 1);
      linkCount.set(e.to, linkCount.get(e.to) + 1);
    }
    // 邻接稳定序(DFS/tie-break 一律按 id 升序,幂等)
    for (var [aid, alist] of adj) alist.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    // 阶段卡(ph-*):五阶段流程节点天生无边——不能当「未连接」孤箱,固定「00 流程」泳道最左列。
    var isPhaseId = function (id) { return /^ph-/.test(String(id)); };
    var phaseIds = nodes.filter(function (n) { return isPhaseId(n.id); }).map(function (n) { return n.id; });
    var active = nodes.filter(function (n) { return linkCount.get(n.id) > 0 && !isPhaseId(n.id); }).map(function (n) { return n.id; });
    var isolated = nodes.filter(function (n) { return linkCount.get(n.id) === 0 && !isPhaseId(n.id); }).map(function (n) { return n.id; });

    // ---- 2) 反馈边识别(DFS 回边)+ Kahn 最长入链分层 ----
    // 重试/回退环(如「握手失败→retry++」)是真实流程的常态:按 DFS 把「指向栈上祖先」的边判为反馈边,
    // 剥离后再分层——不按枢纽猜环入口(实测断线重连板会把 forward 边误剥,主线截断在环里,出口错位)。
    // 反馈边单独记入 backEdges(渲染层画虚线灰,语义=回到前一步/重试),不参与分层与主线。
    var backEdges = new Set();
    var dfsDone = new Set(), dfsStack = new Set();
    function dfsBreak(id) {
      dfsStack.add(id);
      var outs0 = adj.get(id) || [];
      for (var oi0 = outs0.length - 1; oi0 >= 0; oi0--) {
        var to0 = outs0[oi0];
        if (dfsStack.has(to0)) {
          backEdges.add(id + ">" + to0);
          outs0.splice(oi0, 1);
        } else if (!dfsDone.has(to0)) {
          dfsBreak(to0);
        }
      }
      dfsStack.delete(id);
      dfsDone.add(id);
    }
    var activeSorted = active.slice().sort(function (a, b) { return a < b ? -1 : 1; });
    for (var ai0 = 0; ai0 < activeSorted.length; ai0++) if (!dfsDone.has(activeSorted[ai0])) dfsBreak(activeSorted[ai0]);
    // 过滤后入度(=前向边;反馈边不参与 Kahn)
    var indegL = new Map();
    for (var ai1 = 0; ai1 < active.length; ai1++) indegL.set(active[ai1], 0);
    for (var ai2 = 0; ai2 < active.length; ai2++) {
      var outsL = adj.get(active[ai2]) || [];
      for (var oi1 = 0; oi1 < outsL.length; oi1++) indegL.set(outsL[oi1], (indegL.get(outsL[oi1]) || 0) + 1);
    }
    var seen = new Set();
    for (var ai3 = 0; ai3 < active.length; ai3++) level.set(active[ai3], 0);
    var guard = active.length * 4 + 16; // 死循环保险(DAG 必然推进,理论上不触发)
    for (;;) {
      var q = [];
      for (var ai4 = 0; ai4 < active.length; ai4++) {
        var aid4 = active[ai4];
        if (!seen.has(aid4) && (indegL.get(aid4) || 0) <= 0) q.push(aid4);
      }
      if (!q.length) break;
      for (var qi = 0; qi < q.length; qi++) {
        var cur = q[qi];
        if (seen.has(cur)) continue;
        seen.add(cur);
        var outs1 = adj.get(cur) || [];
        for (var oi2 = 0; oi2 < outs1.length; oi2++) {
          var to1 = outs1[oi2];
          if (seen.has(to1)) continue;
          level.set(to1, Math.max(level.get(to1) || 0, (level.get(cur) || 0) + 1));
          indegL.set(to1, (indegL.get(to1) || 1) - 1);
        }
      }
      if (--guard <= 0) break;
    }
    for (var ai5 = 0; ai5 < active.length; ai5++) if (!level.has(active[ai5])) level.set(active[ai5], 0);

    // ---- 3) 主线:入口(入度 0 中可达最多)→ 出口(出度 0 中距入口最远)最长路径 ----
    function reachSet(start) {
      var st = [start], vis = new Set([start]);
      while (st.length) {
        var cur = st.pop();
        var oo = adj.get(cur) || [];
        for (var i2 = 0; i2 < oo.length; i2++) if (!vis.has(oo[i2])) { vis.add(oo[i2]); st.push(oo[i2]); }
      }
      return vis;
    }
    var entryPool = active.filter(function (id) { return (indegL.get(id) || 0) === 0; });
    // 全孤立(无边)时不设入口/出口(无可循主线,渲染层只画「未连接」)
    if (active.length) {
      if (!entryPool.length) {
        // 纯环降级:无入度 0 → id 最小者(规范兜底,诚实不编造入口)
        var minId = active[0];
        for (var ai4 = 1; ai4 < active.length; ai4++) if (active[ai4] < minId) minId = active[ai4];
        entryPool = [minId];
      }
      for (var ep = 0; ep < entryPool.length; ep++) {
        var cand = entryPool[ep];
        if (entry === null) { entry = cand; continue; }
        var rc = reachSet(cand).size, rcCur = reachSet(entry).size;
        if (rc > rcCur) { entry = cand; continue; }
        if (rc === rcCur) {
          var od = (adj.get(cand) || []).length, odCur = (adj.get(entry) || []).length;
          if (od > odCur || (od === odCur && cand < entry)) entry = cand;
        }
      }
    }
    var budget = DFS_BUDGET;
    function longestAny(start, vis) {
      if (budget-- <= 0) return null;
      if (vis.has(start)) return null;
      var vis2 = new Set(vis); vis2.add(start);
      var best = [start];
      var outs2 = adj.get(start) || [];
      for (var i3 = 0; i3 < outs2.length; i3++) {
        var to2 = outs2[i3];
        if (vis2.has(to2)) continue;
        var sub = longestAny(to2, vis2);
        if (sub && sub.length + 1 > best.length) best = [start].concat(sub);
      }
      return best;
    }
    if (entry !== null) {
      var reach = reachSet(entry);
      // 出口候选:可达的出度 0 节点,取层号最大;并列按 id 升序(确定性)
      var sinks = active.filter(function (id) { return (adj.get(id) || []).length === 0 && reach.has(id); });
      var chosenExit = null;
      for (var si = 0; si < sinks.length; si++) {
        if (chosenExit === null) { chosenExit = sinks[si]; continue; }
        var lvS = level.get(sinks[si]) || 0, lvE = level.get(chosenExit) || 0;
        if (lvS > lvE || (lvS === lvE && sinks[si] < chosenExit)) chosenExit = sinks[si];
      }
      var lp = longestAny(entry, new Set()) || [entry];
      var lpEnd = lp[lp.length - 1];
      // 规范:主线=入口→出口。若全局最长路径末端不是最远出口(分支/环罕见),尝试约束到出口;
      // 约束路径存在且不短于全局路径才采用(避免为凑出口截断更长主线)。
      if (chosenExit && lpEnd !== chosenExit) {
        budget = DFS_BUDGET;
        function longestTo(start, target, vis) {
          if (budget-- <= 0) return null;
          if (vis.has(start)) return null;
          if (start === target) return [start];
          var vis2 = new Set(vis); vis2.add(start);
          var best = null;
          var outs3 = adj.get(start) || [];
          for (var i4 = 0; i4 < outs3.length; i4++) {
            var to3 = outs3[i4];
            if (vis2.has(to3)) continue;
            var sub2 = longestTo(to3, target, vis2);
            if (sub2 && (!best || sub2.length + 1 > best.length)) best = [start].concat(sub2);
          }
          return best;
        }
        var lpTo = longestTo(entry, chosenExit, new Set());
        if (lpTo && lpTo.length >= lp.length) lp = lpTo;
      }
      mainPath = lp;
      for (var pi = 0; pi < mainPath.length; pi++) mainNodes.add(mainPath[pi]);
      for (var pi2 = 1; pi2 < mainPath.length; pi2++) mainEdges.add(mainPath[pi2 - 1] + ">" + mainPath[pi2]);
      exit = mainPath.length ? mainPath[mainPath.length - 1] : chosenExit;
      // 主线拉直:主路径相邻节点层号严格 +1(结构环破除后可能同层;分支不受影响)
      for (var pi3 = 1; pi3 < mainPath.length; pi3++) {
        var prevL = level.get(mainPath[pi3 - 1]) || 0;
        if ((level.get(mainPath[pi3]) || 0) <= prevL) level.set(mainPath[pi3], prevL + 1);
      }
    }

    // ---- 4) 泳道分组:①node.group ②阶段前缀(label 数字前缀聚类) ③kind 族 ----
    var laneKeyOf = new Map(); // id -> key
    var laneSeed = new Map();  // key -> {key,label,no,first,layer,ids}
    function seed(key, labelText, noNum, id, idx, writer) {
      if (!laneSeed.has(key)) laneSeed.set(key, { key: key, label: labelText, noNum: noNum, first: idx, ids: [], writer: writer || null });
      var s = laneSeed.get(key);
      s.ids.push(id);
      var lv = level.get(id) || 0;
      if (s.layer === undefined || lv < s.layer) s.layer = lv;
      if (idx < s.first) s.first = idx;
    }
    var anyGroup = false;
    for (var gi = 0; gi < nodes.length; gi++) if (nodes[gi].group && String(nodes[gi].group).trim()) { anyGroup = true; break; }
    var prefixHits = 0, prefixSet = new Set();
    for (var pi4 = 0; pi4 < nodes.length; pi4++) {
      var pfx = stagePrefix(nodes[pi4].label);
      if (pfx) { prefixHits++; prefixSet.add(pfx.no); }
    }
    var usePrefix = !anyGroup && prefixHits >= 2 && prefixSet.size >= 2;
    // 写者前缀:节点 id 形如 `a1-card`/`pqa6e-r3a1` 时,首个 `-` 前是 1~7 位字母数字(且非纯数字)= 写者命名空间。
    // 多路 agent 各自落板常复用同一 group 文案(都写「01 卡渲染」),不按写者分区时这些组会被并成一条大泳道。
    // 长度上限从 3 放宽到 7(2026-10-24 实测回归):plannerScopeOf 产出的作用域是 `p`+4 位=5 字符
    // (如 pqa6e),原 {1,3} 正则全部识别不出 → 42 节点板又并成一条 11 段拼串的大泳道。
    // ph-* 阶段卡不参与(其前缀是固定语义 ph,不是写者)。
    var writerOf = function (id) {
      var s = String(id || "");
      var m = /^([A-Za-z][A-Za-z0-9]{0,6})-/.exec(s);
      if (!m || m[1] === "ph") return null;
      return m[1];
    };
    // 泳道 key 加写者命名空间:有前缀 → g:<prefix>:<group>;无前缀 → g:<group>(向后兼容既有板)
    var laneKeyNS = function (writer, groupText) { return writer ? "g:" + writer + ":" + groupText : "g:" + groupText; };
    var laneLabelNS = function (writer, text) { return writer ? "[" + writer + "] " + text : text; };
    nodes.forEach(function (n, idx) {
      var isPh = isPhaseId(n.id);
      // 阶段卡(ph-*)无边:不能打进「未连接」孤箱,固定「00 流程」泳道(无 group 时也兜底落该泳道)
      if (linkCount.get(n.id) === 0 && !isPh) return; // 其余孤立节点走「未连接」列
      if (isPh) {
        seed("g:00 流程", "流程", 0, n.id, idx);
        laneKeyOf.set(n.id, "g:00 流程");
        return;
      }
      if (anyGroup) {
        var g = n.group && String(n.group).trim();
        var w = writerOf(n.id);
        if (g) {
          var gp = stagePrefix(g);
          var gLabel = gp ? gp.title : g;
          var gKey = laneKeyNS(w, g);
          seed(gKey, laneLabelNS(w, gLabel), gp ? gp.no : null, n.id, idx, w);
          laneKeyOf.set(n.id, gKey);
        } else {
          // group 缺省节点诚实落「其他」(不编造阶段)
          var oKey = laneKeyNS(w, "__other__");
          seed(oKey, laneLabelNS(w, "其他"), null, n.id, idx, w);
          laneKeyOf.set(n.id, oKey);
        }
      } else if (usePrefix) {
        var lp2 = stagePrefix(n.label);
        if (lp2) {
          seed("p:" + lp2.no, lp2.title, lp2.no, n.id, idx);
          laneKeyOf.set(n.id, "p:" + lp2.no);
        } else {
          seed("p:__other__", "其他", null, n.id, idx);
          laneKeyOf.set(n.id, "p:__other__");
        }
      } else {
        var kd = n.kind || "module";
        seed("k:" + kd, KIND_LANE[kd] || String(kd), null, n.id, idx);
        laneKeyOf.set(n.id, "k:" + kd);
      }
    });
    var laneList = Array.from(laneSeed.values());
    // 泳道顺序:显式编号优先(01/02/…),再按首层、首次出现、key
    laneList.sort(function (a, b) {
      var na = a.noNum === null || a.noNum === undefined ? Infinity : a.noNum;
      var nb = b.noNum === null || b.noNum === undefined ? Infinity : b.noNum;
      if (na !== nb) return na - nb;
      if ((a.layer || 0) !== (b.layer || 0)) return (a.layer || 0) - (b.layer || 0);
      if (a.first !== b.first) return a.first - b.first;
      return a.key < b.key ? -1 : 1;
    });
    var lanes = [];
    var laneNo = 0;
    for (var li = 0; li < laneList.length; li++) {
      var L = laneList[li];
      // 「00 流程」泳道(阶段卡)固定编号 00,其余泳道从 01 顺排(不留空号)
      if (L.key === "g:00 流程") { L.no = "00"; L.isPhase = true; }
      else { laneNo++; L.no = pad2(laneNo); }
      lanes.push(L);
    }

    // ---- 5) 列 x 坐标:层号 → x(泳道切换处加 LANE_GAP 分段留白) ----
    var maxLevel = 0;
    for (var ai5 = 0; ai5 < active.length; ai5++) maxLevel = Math.max(maxLevel, level.get(active[ai5]) || 0);
    // 每层归属泳道 = 该层节点数最多的泳道(并列取泳道序靠前者)——仅用于分段留白
    var laneIndexByKey = new Map();
    for (var li2 = 0; li2 < lanes.length; li2++) laneIndexByKey.set(lanes[li2].key, li2);
    var layerOwner = [];
    for (var lv0 = 0; lv0 <= maxLevel; lv0++) {
      var counts = new Map();
      for (var ai6 = 0; ai6 < active.length; ai6++) {
        var aid6 = active[ai6];
        if ((level.get(aid6) || 0) !== lv0) continue;
        var lk = laneKeyOf.get(aid6);
        counts.set(lk, (counts.get(lk) || 0) + 1);
      }
      var owner = null, ownerN = -1;
      for (var [ck, cn] of counts) {
        var ci = laneIndexByKey.get(ck);
        if (cn > ownerN || (cn === ownerN && ci < laneIndexByKey.get(owner))) { owner = ck; ownerN = cn; }
      }
      layerOwner.push(owner);
    }
    var colX = [];
    var cursor = MARGIN;
    // 阶段泳道(00 流程)占最左专用一列:主线各列整体右移一格,避免与第 0 层节点重叠
    if (phaseIds.length) cursor += NODE_W + LANE_GAP;
    for (var lv1 = 0; lv1 <= maxLevel; lv1++) {
      if (lv1 > 0 && layerOwner[lv1] !== layerOwner[lv1 - 1]) cursor += LANE_GAP;
      colX.push(cursor);
      cursor += NODE_W + LAYER_GAP;
    }

    // ---- 6) 列内纵向排布:主线节点恒在基线(整条主线横平),分支上下交替外扩 ----
    var byLevel = new Map();
    for (var ai7 = 0; ai7 < active.length; ai7++) {
      var aid7 = active[ai7];
      var lv7 = level.get(aid7) || 0;
      if (!byLevel.has(lv7)) byLevel.set(lv7, []);
      byLevel.get(lv7).push(aid7);
    }
    var maxAbove = 0;
    for (var [lvA, arrA] of byLevel) {
      var mainInA = arrA.filter(function (id) { return mainNodes.has(id); }).length;
      var aboveA = mainInA ? Math.ceil((arrA.length - mainInA) / 2) : Math.floor(arrA.length / 2);
      maxAbove = Math.max(maxAbove, aboveA);
    }
    var baseline = MARGIN + LANE_HEAD + maxAbove * (NODE_H + ROW_GAP);
    var placedY = new Map(); // id -> y(已排层,供重心排序)
    var levelKeys = Array.from(byLevel.keys()).sort(function (a, b) { return a - b; });
    for (var lk0 = 0; lk0 < levelKeys.length; lk0++) {
      var lvX = levelKeys[lk0];
      var arr = byLevel.get(lvX).slice();
      var mainId = null;
      for (var mi0 = 0; mi0 < arr.length; mi0++) if (mainNodes.has(arr[mi0])) { mainId = arr[mi0]; break; }
      var branches = arr.filter(function (id) { return id !== mainId; });
      // 重心排序:有入边/出边连到已排层的,按邻接 y 均值升序;无邻居按 id
      var bary = new Map();
      for (var bi0 = 0; bi0 < branches.length; bi0++) {
        var bid0 = branches[bi0];
        var vals = [];
        for (var ai8 = 0; ai8 < active.length; ai8++) {
          var other = active[ai8];
          if (!placedY.has(other)) continue;
          var connected = false;
          var oo2 = adj.get(other) || [];
          for (var oi2 = 0; oi2 < oo2.length; oi2++) if (oo2[oi2] === bid0) { connected = true; break; }
          if (!connected) {
            var oo3 = adj.get(bid0) || [];
            for (var oi3 = 0; oi3 < oo3.length; oi3++) if (oo3[oi3] === other) { connected = true; break; }
          }
          if (connected) vals.push(placedY.get(other));
        }
        bary.set(bid0, vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null);
      }
      branches.sort(function (a, b) {
        var ba = bary.get(a), bb = bary.get(b);
        if (ba === null && bb === null) return a < b ? -1 : 1;
        if (ba === null) return 1;
        if (bb === null) return -1;
        if (Math.abs(ba - bb) > 0.5) return ba - bb;
        return a < b ? -1 : 1;
      });
      var xl = colX[lvX];
      var rowH = NODE_H + ROW_GAP;
      if (mainId) {
        pos.set(mainId, { x: xl, y: baseline });
        size.set(mainId, { w: NODE_W, h: NODE_H });
        placedY.set(mainId, baseline);
        for (var bj = 0; bj < branches.length; bj++) {
          var dir = bj % 2 === 0 ? -1 : 1;   // 上、下、上、下……
          var mag = Math.floor(bj / 2) + 1;
          var yb = baseline + dir * mag * rowH;
          pos.set(branches[bj], { x: xl, y: yb });
          size.set(branches[bj], { w: NODE_W, h: NODE_H });
          placedY.set(branches[bj], yb);
        }
      } else {
        var baseIdx = Math.floor(arr.length / 2);
        for (var bj2 = 0; bj2 < branches.length; bj2++) {
          var off = bj2 - baseIdx;
          var yb2 = baseline + off * rowH;
          pos.set(branches[bj2], { x: xl, y: yb2 });
          size.set(branches[bj2], { w: NODE_W, h: NODE_H });
          placedY.set(branches[bj2], yb2);
        }
      }
    }

    // ---- 6c) compact 主干换行(2026-10-25 实测「适配后主干只看到 5/7」) ----
    // 非 compact 路径**逐字不变**:这段整体被 compact 守卫罩住,opts.compact 为假时零执行。
    // 做法:把「列」按 MAIN_WRAP_COLS 折成行——列 x 回到行内列序(baseX + c×(卡宽+列距)),
    // 列 y 整体随所属行平移(列内上下相对关系不动,分支卡跟着自己的列走,不散架)。
    // 行带高度**按主干卡算**(主干卡恒在基线,带高 = 卡高):这是适配 k 的关键——若按
    // 「该行所有卡(含被面板收成 +N 的分支卡)」算伸量,实测 60 节点板两行主干相距 1648px,
    // y 跨度 1764px → 适配 k 又被纵向空白压回 0.25,等于白换行。分支卡不参与行带、只随行平移,
    // 默认(密度分层)视图里它们本来就不渲染;展开泳道时可读性优先于「绝不交叠」。
    if (compact && levelKeys.length > MAIN_WRAP_COLS) {
      var wrapBaseX = phaseIds.length ? MARGIN + NODE_W + LANE_GAP : MARGIN; // 有阶段列时整体右移一格
      var wrapRows = Math.ceil(levelKeys.length / MAIN_WRAP_COLS);
      var rowAbove = [], rowBelow = [];
      for (var wr0 = 0; wr0 < wrapRows; wr0++) { rowAbove.push(0); rowBelow.push(NODE_H); }
      for (var wc0 = 0; wc0 < levelKeys.length; wc0++) {
        var wr1 = Math.floor(wc0 / MAIN_WRAP_COLS);
        var arrW0 = byLevel.get(levelKeys[wc0]) || [];
        var hasMain0 = false;
        for (var wi0 = 0; wi0 < arrW0.length; wi0++) if (mainNodes.has(arrW0[wi0])) { hasMain0 = true; break; }
        if (hasMain0) continue; // 该列有主干卡:行带只用主干卡(恒在基线,带高 = 卡高)
        // 兜底:该列没主干卡(纯分支层)→ 用该列全部卡的伸量,免得这一行把卡压出去
        for (var wi0b = 0; wi0b < arrW0.length; wi0b++) {
          var wp0 = pos.get(arrW0[wi0b]);
          if (!wp0) continue;
          var relW = wp0.y - baseline;
          if (relW < rowAbove[wr1]) rowAbove[wr1] = relW;
          if (relW + NODE_H > rowBelow[wr1]) rowBelow[wr1] = relW + NODE_H;
        }
      }
      var rowShift = [0];
      for (var wr2 = 1; wr2 < wrapRows; wr2++) {
        // 下一行带上缘 = 上一行带下缘 + 间隙(净行距 ≥ MAIN_WRAP_ROW_GAP)
        var stepW = rowBelow[wr2 - 1] - rowAbove[wr2] + MAIN_WRAP_ROW_GAP;
        rowShift.push(rowShift[wr2 - 1] + Math.max(NODE_H + MAIN_WRAP_ROW_GAP, stepW));
      }
      for (var wc1 = 0; wc1 < levelKeys.length; wc1++) {
        var wr3 = Math.floor(wc1 / MAIN_WRAP_COLS);
        var wx = wrapBaseX + (wc1 % MAIN_WRAP_COLS) * (NODE_W + LAYER_GAP);
        var arrW1 = byLevel.get(levelKeys[wc1]) || [];
        for (var wi1 = 0; wi1 < arrW1.length; wi1++) {
          var wp1 = pos.get(arrW1[wi1]);
          if (!wp1) continue;
          pos.set(arrW1[wi1], { x: wx, y: wp1.y + rowShift[wr3] });
        }
      }
      mainWrapRows = wrapRows;
      mainWrapCols = Math.min(MAIN_WRAP_COLS, levelKeys.length);
    }

    // ---- 6c-w) 非 compact 宽板列换行(2026-10-25 任务 A) ----
    // 触发条件三重:受控开启(opts.wrap/autoWrap)+ 主路径列数 > 可读阈值(默认 4)+ 非 compact。
    // 只看主路径:分支多但主线短的板(如 1→5 扇出)横排本来就读得下,不该被强扭成网格。
    // 做法与 6c 同源:列按 wrapCols 折成行,列 x 回到行内列序,列 y 随所属行整体平移
    // (列内上下相对关系不动 → 分支卡跟着自己的列走)。行带高度按**该行全部卡**算(非 compact
    // 不藏卡,必须保证跨行不压卡),行距 ≥ NODE_H+WRAP_LANE_ROW_GAP(含泳道框标题/底边余量)。
    // 与 compact 的差异:这里保留全部节点/泳道,泳道框在 7) 步按行拆段(boxes),不画跨行巨框。
    var wrapActive = false;
    if (!compact && wrapReq && levelKeys.length > wrapColsN && mainPath.length > wrapColsN) {
      var wrapBaseX = phaseIds.length ? MARGIN + NODE_W + LANE_GAP : MARGIN;
      var wrapRowsN = Math.ceil(levelKeys.length / wrapColsN);
      var wrapAbove = [], wrapBelow = [];
      for (var wra0 = 0; wra0 < wrapRowsN; wra0++) { wrapAbove.push(Infinity); wrapBelow.push(-Infinity); }
      for (var wrc0 = 0; wrc0 < levelKeys.length; wrc0++) {
        var wrr0 = Math.floor(wrc0 / wrapColsN);
        var arrCW = byLevel.get(levelKeys[wrc0]) || [];
        for (var wri0 = 0; wri0 < arrCW.length; wri0++) {
          var wpW0 = pos.get(arrCW[wri0]);
          if (!wpW0) continue;
          var relW0 = wpW0.y - baseline;
          if (relW0 < wrapAbove[wrr0]) wrapAbove[wrr0] = relW0;
          if (relW0 + NODE_H > wrapBelow[wrr0]) wrapBelow[wrr0] = relW0 + NODE_H;
        }
      }
      for (var wra1 = 0; wra1 < wrapRowsN; wra1++) {
        if (!isFinite(wrapAbove[wra1])) { wrapAbove[wra1] = 0; wrapBelow[wra1] = NODE_H; }
      }
      var wrapShift = [0];
      for (var wra2 = 1; wra2 < wrapRowsN; wra2++) {
        // 下一行带上缘 = 上一行带下缘 + 间隙;最小行距 NODE_H+64(净空 ≥64px:连线/边标签 +
        // 泳道框标题条与底边内距,保证上下两行的泳道段框不相叠)
        var stepW2 = wrapBelow[wra2 - 1] - wrapAbove[wra2] + WRAP_LANE_ROW_GAP;
        wrapShift.push(wrapShift[wra2 - 1] + Math.max(NODE_H + WRAP_LANE_ROW_GAP, stepW2));
      }
      for (var wrc1 = 0; wrc1 < levelKeys.length; wrc1++) {
        var wrr1 = Math.floor(wrc1 / wrapColsN);
        var wx1 = wrapBaseX + (wrc1 % wrapColsN) * (NODE_W + LAYER_GAP);
        var arrCW1 = byLevel.get(levelKeys[wrc1]) || [];
        for (var wri1 = 0; wri1 < arrCW1.length; wri1++) {
          var wpW1 = pos.get(arrCW1[wri1]);
          if (!wpW1) continue;
          pos.set(arrCW1[wri1], { x: wx1, y: wpW1.y + wrapShift[wrr1] });
          wrapRowOf.set(arrCW1[wri1], wrr1);
        }
      }
      wrapActive = true;
      wrapMeta = { active: true, cols: wrapColsN, rows: wrapRowsN };
    }

    // ---- 6b) 阶段卡(ph-*):「00 流程」泳道独占最左列,纵向顺排(不参与分层/主线) ----
    if (phaseIds.length) {
      // 按五阶段固定语义序(understand→close)排,缺失的阶段不受影响;未知前缀按 id 兜底
      var PHASE_ORDER = ["ph-understand", "ph-plan", "ph-implement", "ph-verify", "ph-close"];
      var phSorted = phaseIds.slice().sort(function (a, b) {
        var ia = PHASE_ORDER.indexOf(a), ib = PHASE_ORDER.indexOf(b);
        if (ia < 0) ia = PHASE_ORDER.length;
        if (ib < 0) ib = PHASE_ORDER.length;
        if (ia !== ib) return ia - ib;
        return a < b ? -1 : 1;
      });
      for (var phI = 0; phI < phSorted.length; phI++) {
        // 2026-10-21 阶段卡紧凑化:窄条形态(46px),纵向不再撑高世界(fit 后设计内容可读)
        var PH_H = 46, PH_GAP = 10;
        var phY = baseline + phI * (PH_H + PH_GAP);
        pos.set(phSorted[phI], { x: MARGIN, y: phY });
        size.set(phSorted[phI], { w: NODE_W, h: PH_H });
        level.set(phSorted[phI], -1); // 编号排序用:阶段列在所有层之前
      }
    }

    // ---- 7) 泳道框 bbox(覆盖组内节点;顶部留标题条) ----
    var colIndexOf = new Map(); // 层号 -> 列序(宽板折行时把泳道框按行拆段用)
    for (var ciw0 = 0; ciw0 < levelKeys.length; ciw0++) colIndexOf.set(levelKeys[ciw0], ciw0);
    for (var li3 = 0; li3 < lanes.length; li3++) {
      var L3 = lanes[li3];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      L3.ids.sort(function (a, b) {
        var la = level.get(a) || 0, lb = level.get(b) || 0;
        if (la !== lb) return la - lb;
        return a < b ? -1 : 1;
      });
      for (var li4 = 0; li4 < L3.ids.length; li4++) {
        var p4 = pos.get(L3.ids[li4]);
        if (!p4) continue;
        minX = Math.min(minX, p4.x); minY = Math.min(minY, p4.y);
        maxX = Math.max(maxX, p4.x + NODE_W); maxY = Math.max(maxY, p4.y + NODE_H);
      }
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = NODE_W; maxY = NODE_H; }
      L3.x = minX - LANE_PAD;
      L3.y = Math.max(MARGIN, minY - LANE_HEAD);
      L3.w = maxX - minX + LANE_PAD * 2;
      L3.h = maxY - L3.y + LANE_TAIL;
      L3.nodes = L3.ids.slice();
      // 宽板折行:一条泳道的节点可能落在多行 → 按 (行, 连续列段) 拆成多个小框,避免一个跨行巨框
      // 把别的行/别的泳道整片盖住(渲染层逐个画,数据仍在同一个 lane 对象里:key/label/no/nodes 不变)。
      if (wrapActive && !L3.isPhase) {
        var rowIds = new Map(); // row -> [id]
        for (var lbx0 = 0; lbx0 < L3.ids.length; lbx0++) {
          var lidx0 = L3.ids[lbx0];
          var rw0 = wrapRowOf.has(lidx0) ? wrapRowOf.get(lidx0) : 0;
          if (!rowIds.has(rw0)) rowIds.set(rw0, []);
          rowIds.get(rw0).push(lidx0);
        }
        var mboxes = [];
        var rowKeysW = Array.from(rowIds.keys()).sort(function (a, b) { return a - b; });
        for (var rkx = 0; rkx < rowKeysW.length; rkx++) {
          var rowIdsArr = rowIds.get(rowKeysW[rkx]);
          var colsW = [];
          for (var cwx = 0; cwx < rowIdsArr.length; cwx++) {
            var lvW = level.get(rowIdsArr[cwx]);
            var ciW = lvW === undefined ? -1 : (colIndexOf.has(lvW) ? colIndexOf.get(lvW) : -1);
            if (colsW.indexOf(ciW) < 0) colsW.push(ciW);
          }
          colsW.sort(function (a, b) { return a - b; });
          var runsW = [], runW = [];
          for (var cwx2 = 0; cwx2 < colsW.length; cwx2++) {
            if (!runW.length || colsW[cwx2] === runW[runW.length - 1] + 1) runW.push(colsW[cwx2]);
            else { runsW.push(runW); runW = [colsW[cwx2]]; }
          }
          if (runW.length) runsW.push(runW);
          for (var rwx = 0; rwx < runsW.length; rwx++) {
            var run = runsW[rwx];
            var bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
            for (var rix = 0; rix < rowIdsArr.length; rix++) {
              var ridW = rowIdsArr[rix];
              var rlvW = level.get(ridW);
              var rciW = rlvW === undefined ? -1 : (colIndexOf.has(rlvW) ? colIndexOf.get(rlvW) : -1);
              if (run.indexOf(rciW) < 0) continue;
              var rpw = pos.get(ridW);
              if (!rpw) continue;
              bMinX = Math.min(bMinX, rpw.x); bMinY = Math.min(bMinY, rpw.y);
              bMaxX = Math.max(bMaxX, rpw.x + NODE_W); bMaxY = Math.max(bMaxY, rpw.y + NODE_H);
            }
            if (!isFinite(bMinX)) continue;
            mboxes.push({
              x: bMinX - LANE_PAD,
              y: Math.max(MARGIN, bMinY - LANE_HEAD),
              w: bMaxX - bMinX + LANE_PAD * 2,
              h: bMaxY - Math.max(MARGIN, bMinY - LANE_HEAD) + LANE_TAIL,
              row: rowKeysW[rkx],
            });
          }
        }
        if (mboxes.length) {
          L3.boxes = mboxes;
          var uMinX = Infinity, uMinY = Infinity, uMaxX = -Infinity, uMaxY = -Infinity;
          for (var mbx = 0; mbx < mboxes.length; mbx++) {
            uMinX = Math.min(uMinX, mboxes[mbx].x); uMinY = Math.min(uMinY, mboxes[mbx].y);
            uMaxX = Math.max(uMaxX, mboxes[mbx].x + mboxes[mbx].w); uMaxY = Math.max(uMaxY, mboxes[mbx].y + mboxes[mbx].h);
          }
          L3.x = uMinX; L3.y = uMinY; L3.w = uMaxX - uMinX; L3.h = uMaxY - uMinY;
        }
      }
    }

    // ---- 7b) 泳道框去重叠(2026-10-19 用户实报「白板花」) ----
    // 泳道按 group/阶段分组,而列按**图依赖层**排:组内节点跨层时(桌面 exe 板 5 组各跨 2-3 列),
    // 各框 bbox 互相覆盖,画出来是一堆叠在一起的虚线框。互斥框做不到时不硬画——重叠的框合并成一条
    // (标签拼接、编号取最小),位置不动(主线仍横平),视觉回到「一条流程带」。
    // 宽板折行时泳道框按行拆段(L3.boxes):重叠判定要看**每一段**——拿整条泳道的 union 框判,
    // 会把上下两行本来互不相交的同写者泳道误判成重叠并合并(标签/编号跟着乱)。无 boxes 时退回原框。
    function laneSegsOf(L) {
      return L && L.boxes && L.boxes.length ? L.boxes : [L];
    }
    function laneOverlap(a, b) {
      var as = laneSegsOf(a), bs = laneSegsOf(b);
      for (var i = 0; i < as.length; i++) {
        for (var j = 0; j < bs.length; j++) {
          var p = as[i], q = bs[j];
          if (p.x < q.x + q.w - 0.5 && q.x < p.x + p.w - 0.5 && p.y < q.y + q.h - 0.5 && q.y < p.y + p.h - 0.5) return true;
        }
      }
      return false;
    }
    var mergedLanes = lanes.slice();
    if (!preserveLanes) for (var mpass = 0; mpass < 12; mpass++) {
      var mdid = false;
      for (var mi = 0; mi < mergedLanes.length && !mdid; mi++) {
        for (var mj = mi + 1; mj < mergedLanes.length; mj++) {
          if (!laneOverlap(mergedLanes[mi], mergedLanes[mj])) continue;
          // 写者分区优先于去重叠:两路写者的同名 group(如 a1 与 c1 都写「01 卡渲染」)各占一框,
          // 不并成一条大框(实测 30/39 节点曾因此塌进一个框);同写者或都无写者仍按几何合并。
          // 无写者(历史板/主 agent 节点)按空串算独立命名空间:此前「两方都有 writer 才拦」会让
          // 无写者框先并进有写者框并把 writer 丢掉,后续整批不同写者又能并进来(实测泳道头被拼成
          // 11 段「01复测 · [b1] 变更集采集 · [c1] 度量取证 · …」、30/39 节点塌进一个框)。
          if ((mergedLanes[mi].writer || "") !== (mergedLanes[mj].writer || "")) continue;
          var A = mergedLanes[mi], B = mergedLanes[mj];
          // 宽板折行:合并后仍要按行分段画框 → 段列表一起并(没有段的老路径零变化)
          var aSegs = A.boxes && A.boxes.length ? A.boxes.slice() : null;
          var bSegs = B.boxes && B.boxes.length ? B.boxes.slice() : null;
          var aBoxBefore = { x: A.x, y: A.y, w: A.w, h: A.h };
          var bBoxBefore = { x: B.x, y: B.y, w: B.w, h: B.h };
          var ar = Math.max(A.x + A.w, B.x + B.w), ab = Math.max(A.y + A.h, B.y + B.h);
          A.x = Math.min(A.x, B.x); A.y = Math.min(A.y, B.y);
          A.w = ar - A.x; A.h = ab - A.y;
          if (aSegs || bSegs) {
            A.boxes = (aSegs || [aBoxBefore]).concat(bSegs || [bBoxBefore]);
          }
          // 同写者合并(sameWriter):标签去掉重复的 `[prefix] ` —— 实测 42 节点板被拼成
          // 「01[pqa6e] 段对位 · [pqa6e] 段级对位 · [pqa6e] 兜底 · …」4 个同前缀,纯噪音。
          // 段数上限 3:再多就截断加「…」,泳道头一行放得下才是可读的。
          function labelPart(lab) {
            var w = A.writer || "";
            if (!w) return lab;
            return lab.split("[" + w + "] ").join("");
          }
          var merged2 = labelPart(B.label);
          if (A.label.indexOf(merged2) < 0) {
            // 先去掉上一轮截断留下的「 …」,否则每轮都会把「…」当成一段追加(实测出现「… … … …」)
            var base = A.label.replace(/\s+…$/, "");
            var parts = base === A.label || base === "" ? A.label.split(" · ") : base.split(" · ");
            if (parts.indexOf(merged2) < 0) parts.push(merged2);
            A.label = parts.length > 3 ? parts.slice(0, 3).join(" · ") + " …" : parts.join(" · ");
          }
          A.nodes = A.nodes.concat(B.nodes);
          A.ids = A.ids.concat(B.ids);
          A.mergedFrom = (A.mergedFrom || 1) + 1;
          A.merged = true;
          mergedLanes.splice(mj, 1);
          mdid = true;
          break;
        }
      }
      if (!mdid) break;
    }
    lanes = mergedLanes;
    // 宽板折行:7b 可能合并掉部分泳道 → 编号压成连续 01..N(不跳号;阶段泳道保持 00)
    if (wrapActive) {
      var wrapNo = 0;
      for (var wnl = 0; wnl < lanes.length; wnl++) {
        if (lanes[wnl].isPhase) { lanes[wnl].no = "00"; continue; }
        wrapNo++;
        lanes[wnl].no = pad2(wrapNo);
      }
    }

    // ---- 7c) 写者分区后的纵向分离(2026-10-24 实测「白板花」回归) ----
    // 7b 合并会把重叠框并成一条;一旦按写者禁止合并(不同写者永不并),原来被「合并掩盖」的重叠
    // 就变成多个虚线框直接叠画——实测 39 节点板出现 6 对框互相覆盖。这里对仍然重叠的框做
    // **整框纵向让位**:按 (x, 次序) 排,后一个与前一个重叠就把它连同框内所有节点整体下移,
    // 直到互斥。只动 y、不动 x 与层号,主线横平关系保持不变。
    // compact 模式跳过:卡片已被面板收成 +N,让位反而把仅剩的几张主干卡沿纵向拉开几千像素
    // (实测适配 k 因此永远撞 0.7 可读下限)。此时虚线框重叠不构成阅读障碍。
    var LANE_V_GAP = 26;
    if (compact || wrapActive) {
      // 只做编号/laneOf 的铺底,保证下游(编号、laneOf、孤立列)拿到完整数据
      // 宽板折行同样跳过 7c 整框纵向让位:折行后的行带已互斥,再按框让位会把下一行整体推走、破坏折行。
      for (var lc0 = 0; lc0 < lanes.length; lc0++) {
        for (var lc1 = 0; lc1 < lanes[lc0].nodes.length; lc1++) laneOf.set(lanes[lc0].nodes[lc1], lanes[lc0].key);
      }
    }
    if (!compact && !wrapActive) {
    var laneOverlapBox = function (a, b) {
      return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
    };
    var settled = [];
    var laneOrder = lanes.slice().sort(function (a, b) {
      if (Math.abs(a.x - b.x) > 0.5) return a.x - b.x;
      return a.y - b.y;
    });
    for (var ls = 0; ls < laneOrder.length; ls++) {
      var Ls = laneOrder[ls];
      if (!Ls.nodes || !Ls.nodes.length) { settled.push(Ls); continue; }
      for (var guard = 0; guard < 24; guard++) {
        var hitLane = null;
        for (var sk = 0; sk < settled.length; sk++) {
          if (laneOverlapBox(Ls, settled[sk])) { hitLane = settled[sk]; break; }
        }
        if (!hitLane) break;
        var dy = hitLane.y + hitLane.h + LANE_V_GAP - Ls.y;
        if (dy <= 0) break; // 理论上不会发生;防死循环
        Ls.y += dy;
        for (var nz = 0; nz < Ls.nodes.length; nz++) {
          var pz = pos.get(Ls.nodes[nz]);
          if (pz) pos.set(Ls.nodes[nz], { x: pz.x, y: pz.y + dy });
        }
        Ls.separated = true;
      }
      settled.push(Ls);
    }
    // 分离后按 y 重排 lanes 次序(编号 01..N 重排,读起来自上而下),阶段泳道保持 00 最前
    lanes = settled.slice().sort(function (a, b) {
      if (!!a.isPhase !== !!b.isPhase) return a.isPhase ? -1 : 1;
      if (Math.abs(a.y - b.y) > 0.5) return a.y - b.y;
      return a.x - b.x;
    });
    // 编号必须跟着重排后的次序走:7) 步的编号是按「声明序」给的,7c 让位后次序变了,
    // 不重排会出现「02 / 03 / 01 / 04」这种跳号(实测活网关 5 条泳道里 01 落在第 3 位)。
    var reNo = 0;
    for (var ln = 0; ln < lanes.length; ln++) {
      if (lanes[ln].isPhase) { lanes[ln].no = "00"; continue; }
      reNo++;
      lanes[ln].no = pad2(reNo);
    }
    for (var li5 = 0; li5 < lanes.length; li5++) {
      for (var li5b = 0; li5b < lanes[li5].nodes.length; li5b++) laneOf.set(lanes[li5].nodes[li5b], lanes[li5].key);
    }
    } // end if (!compact) —— 紧凑模式在此收口(7c 让位与重编号全部跳过)

    // ---- 7d) 碎泳道合并(2026-10-25 实测「易读性」病灶:60 节点板 21 条泳道 / 平均 2.8 节点 / 碎成条带) ----
    // 7b 只管**几何重叠**合并;不重叠的单节点小框留一堆,视觉上是「一屏 21 条虚线带」而不是「几条流程」。
    // **只在板大到一定程度才收**(lanes > LANE_FOLD_TARGET):小板上「一组只有一个节点」是正常语义,
    // 硬收会把 3 组的板并成 1 组(实测打 4 个既有用例)。
    // 收法:某泳道节点数 <= 1(碎条)时,找**同一写者**且按 (y, x) 序**相邻**的泳道,上者并入下者;
    // 收完仍超目标时,再按「合并代价最小」继续并同写者对。
    // 写者守卫必须继续生效:不同写者(含「有无写者」不同)永不合并——否则多路 agent 的板又塌成一个大框。
    // 阶段泳道(00 流程)/「未连接」列不参与(语义固定,不是碎条)。编号在 7c 重排过,这里不重排;
    // 合并后可能出现空号,由末尾 7d 收尾的编号重排统一压成连续 01..N(读起来不能跳号)。
    var FOLD_MAX_NODES = 1;   // 碎条判定:泳道节点数 <= 1 即「一条带子上只有一个卡」
    var LANE_FOLD_TARGET = 7; // 目标泳道数(不含「未连接」列):收完碎条仍超过它 → 继续按同写者合并。
                              // 7 是实测值:60 节点 6 路写者板 → 7 条流程带 + 未连接 = 8 条,一屏读完。
    var fragLane = function (L) {
      return !!L && !L.isPhase && !L.isolated && Array.isArray(L.nodes) && L.nodes.length <= FOLD_MAX_NODES;
    };
    var laneWriter = function (L) { return (L && L.writer) || ""; };
    var mergeableLane = function (L) {
      return !!L && !L.isPhase && !L.isolated && Array.isArray(L.nodes) && L.nodes.length > 0;
    };
    // 写者守卫:阶段泳道/「未连接」列不参与;同一写者(含都无写者)才允许合并,不同写者永不合并
    var sameWriterPair = function (a, b) {
      if (!a || !b || a === b) return false;
      if (!mergeableLane(a) || !mergeableLane(b)) return false;
      return laneWriter(a) === laneWriter(b);
    };
    // 超目标后的第二档合并(不是碎条,只是「带子太多」)**只对带写者前缀的泳道**生效:
    // 无前缀的 group 是老板/主 agent 的语义分组,按「都无写者」把它们并起来会把 7 个阶段并成一坨
    // (实测打既有「5 路写者 + 7 个阶段组」用例)。多路写者(有前缀)才是「同一件事碎成多条」的来源。
    var writerPairOnly = function (a, b) {
      return sameWriterPair(a, b) && laneWriter(a) !== "";
    };
    // 标签去重拼接:去掉重复的 `[prefix] `(与 7b 同口径),段数 ≤3 截断加「…」,不产生「… …」
    // 注意先**展平**:上者的标签本身可能已经是「A · B · C …」(7b 拼过),直接当一段追加会超出 3 段上限
    // (实测 21 条碎泳道收拢后出现 4 段头)。展平后逐段去重再截断。
    var mergeLabels = function (D, U) {
      var w = laneWriter(D);
      var strip = function (s) {
        var t = String(s || "").replace(/\s+…$/, "");
        if (w) t = t.split("[" + w + "] ").join("");
        return t;
      };
      var flat = (strip(D.label) + " · " + strip(U.label)).split(" · ");
      var parts = [];
      for (var fi = 0; fi < flat.length; fi++) {
        var seg = flat[fi];
        if (!seg) continue;
        if (parts.indexOf(seg) < 0) parts.push(seg);
      }
      var head = w ? "[" + w + "] " : "";
      D.label = head + (parts.length > 3 ? parts.slice(0, 3).join(" · ") + " …" : parts.join(" · "));
    };
    // 合并后按节点实位重算 bbox(与 7) 步同口径):框贴住并集节点,不留悬空虚框
    var refitLaneBox = function (L) {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var rf = 0; rf < L.nodes.length; rf++) {
        var rp0 = pos.get(L.nodes[rf]);
        if (!rp0) continue;
        minX = Math.min(minX, rp0.x); minY = Math.min(minY, rp0.y);
        maxX = Math.max(maxX, rp0.x + NODE_W); maxY = Math.max(maxY, rp0.y + NODE_H);
      }
      if (!isFinite(minX)) return;
      L.x = minX - LANE_PAD;
      L.y = Math.max(MARGIN, minY - LANE_HEAD);
      L.w = maxX - minX + LANE_PAD * 2;
      L.h = maxY - L.y + LANE_TAIL;
    };
    // 相邻度:(y 优先、x 次序)量化为标量,只用于挑「最近的同写者泳道」
    var laneDist = function (a, b) { return Math.abs(b.y - a.y) * 10000 + Math.abs(b.x - a.x); };
    var laneFolded = 0;
    var foldPasses = 0;
    // 只在**大板**上收(>= LANE_FOLD_MIN_NODES):小板的「一组一个节点」是正常语义,
    // 硬收会把 3 组的板并成 1 组(实测打 4 个既有用例)。阈值与渲染层 CV_FOLD_THRESHOLD 同口径(20):
    // 21 条单节点泳道这种量级已经碎成条带,该收;十几节点的小板不动。
    var LANE_FOLD_MIN_NODES = 20;
    // compact:已由面板收卡,泳道碎不碎都不影响阅读,且合并会重排节点 y → 跳过
    if (!compact && !wrapActive && !preserveLanes && nodes.length >= LANE_FOLD_MIN_NODES) for (;;) {
      if (++foldPasses > 48) break; // 保险:每轮至少少一条泳道,理论上远不到上限
      // 相邻序:同一写者内按「自上而下、自左而右」= (y, x);用稳定排序保证确定性
      var pool = lanes.filter(fragLane).slice().sort(function (a, b) {
        if (Math.abs(a.y - b.y) > 0.5) return a.y - b.y;
        if (Math.abs(a.x - b.x) > 0.5) return a.x - b.x;
        return a.key < b.key ? -1 : 1;
      });
      var pair = null;
      for (var fp = 0; fp < pool.length && !pair; fp++) {
        // 找该碎条在**全量泳道**里的同写者相邻泳道(碎条池里相邻不够:中间可能夹着大泳道)
        var fa = pool[fp];
        var best = null, bestD = Infinity;
        for (var ft = 0; ft < lanes.length; ft++) {
          var fb = lanes[ft];
          if (!sameWriterPair(fa, fb)) continue; // 写者守卫:不同写者绝不合并
          var d = laneDist(fa, fb);
          if (d < bestD) { bestD = d; best = fb; }
        }
        if (best) pair = [fa, best];
      }
      if (!pair && lanes.length > LANE_FOLD_TARGET) {
        // 碎条收完还超目标:同写者里挑「合并后节点数最少 → 最相邻」的一对并成一条流程带。
        // 只为过线而不看几何会造出**跨全板的巨框**:一条 7000px 高的框把所有泳道顶到下面,
        // 世界高度从 3k 涨到 31k(适配 k 直接崩)。所以优先选「并集框不新压到别人的框」的对:
        // 先试 compatible(新增 0 处重叠),找不到再退到「框面积增幅最小」的对。
        var bestA = null, bestB = null, bestCost = Infinity, bestHard = null, weakCost = Infinity;
        for (var pa = 0; pa < lanes.length; pa++) {
          for (var pb2 = pa + 1; pb2 < lanes.length; pb2++) {
            var La = lanes[pa], Lb = lanes[pb2];
            if (!writerPairOnly(La, Lb)) continue; // 写者守卫同上 + 只收有写者的泳道
            var ux = Math.min(La.x, Lb.x), uy = Math.min(La.y, Lb.y);
            var ur = Math.max(La.x + La.w, Lb.x + Lb.w), ub = Math.max(La.y + La.h, Lb.y + Lb.h);
            var uBox = { x: ux, y: uy, w: ur - ux, h: ub - uy };
            var clash = false;
            for (var ok = 0; ok < lanes.length && !clash; ok++) {
              var Lo = lanes[ok];
              if (Lo === La || Lo === Lb) continue;
              if (laneOverlapBox(uBox, Lo)) clash = true;
            }
            var cost = (La.nodes.length + Lb.nodes.length) * 1e7 + laneDist(La, Lb);
            if (!clash && cost < bestCost) { bestCost = cost; bestA = La; bestB = Lb; }
            // 兜底口径:并集框面积相对两框之和的增幅(越小越不像巨框)
            var grow = uBox.w * uBox.h / Math.max(1, La.w * La.h + Lb.w * Lb.h);
            var wcost = grow * 1e7 + cost;
            if (wcost < weakCost) { weakCost = wcost; bestHard = [La, Lb]; }
          }
        }
        if (bestA) pair = [bestA, bestB];
        else if (bestHard) pair = bestHard;
      }
      if (!pair) break;
      // 上者并入下者:留下「更靠下」的那条(读图从下一条流程继续),位置不动
      var up = pair[0], down = pair[1];
      if (down.y < up.y - 0.5) { var sw = up; up = down; down = sw; }
      var D = down, U = up;
      mergeLabels(D, U); // 标签去重拼接(段数上限 3 + 截断「…」,与 7b 同口径)
      D.nodes = D.nodes.concat(U.nodes);
      D.ids = (D.ids || []).concat(U.ids || []);
      D.mergedFrom = (D.mergedFrom || 1) + 1;
      D.merged = true;
      D.folded = true; // 渲染层据此区分「碎条合并」与 7b 几何合并(语义相同,留给诊断)
      for (var nf = 0; nf < U.nodes.length; nf++) laneOf.set(U.nodes[nf], D.key);
      // 并进来的那条**贴到留下那条的正下方**(整条流程带才紧凑):不贴的话两条相隔 2000px 的碎带
      // 并出来是个 8000px 高的空框(实测世界高度 3k → 25k,平移找节点全靠瞎滚)。只平移 U 的节点,
      // 不改 x(列/层关系不动),y 全部下面重排后再交给纵向让位做互斥。
      var uy0 = Infinity, uy1 = -Infinity, dy0 = -Infinity;
      for (var uc = 0; uc < U.nodes.length; uc++) {
        var up1 = pos.get(U.nodes[uc]);
        if (!up1) continue;
        uy0 = Math.min(uy0, up1.y); uy1 = Math.max(uy1, up1.y + NODE_H);
      }
      for (var dc = 0; dc < D.nodes.length; dc++) {
        if (U.nodes.indexOf(D.nodes[dc]) >= 0) continue;
        var dp1 = pos.get(D.nodes[dc]);
        if (dp1) dy0 = Math.max(dy0, dp1.y + NODE_H);
      }
      if (isFinite(uy0) && isFinite(dy0)) {
        var shift = dy0 + ROW_GAP - uy0;
        if (shift > 0.5) {
          for (var us = 0; us < U.nodes.length; us++) {
            var usp = pos.get(U.nodes[us]);
            if (usp) pos.set(U.nodes[us], { x: usp.x, y: usp.y + shift });
          }
        }
      }
      refitLaneBox(D); // 框跟着并集节点重算(否则留下悬空大框)
      laneFolded++;
      lanes = lanes.filter(function (L) { return L !== U; });
    }
    if (laneFolded) {
      // 合并后的框是并集(跨列),可能与别的写者框重叠 → 复跑一遍 7c 的**整框纵向让位**(只动 y),
      // 保证「泳道数降下来」不以「虚线框叠画」为代价(用户实报的「白板花」)。
      var resep = [];
      var reOrder = lanes.slice().sort(function (a, b) {
        if (Math.abs(a.x - b.x) > 0.5) return a.x - b.x;
        return a.y - b.y;
      });
      for (var rs = 0; rs < reOrder.length; rs++) {
        var RL = reOrder[rs];
        if (!RL.nodes || !RL.nodes.length) { resep.push(RL); continue; }
        for (var rg = 0; rg < 24; rg++) {
          var hitR = null;
          for (var rk = 0; rk < resep.length; rk++) {
            if (laneOverlapBox(RL, resep[rk])) { hitR = resep[rk]; break; }
          }
          if (!hitR) break;
          var rdy = hitR.y + hitR.h + LANE_V_GAP - RL.y;
          if (rdy <= 0) break; // 防死循环(理论上不触发)
          RL.y += rdy;
          for (var rz = 0; rz < RL.nodes.length; rz++) {
            var rpos = pos.get(RL.nodes[rz]);
            if (rpos) pos.set(RL.nodes[rz], { x: rpos.x, y: rpos.y + rdy });
          }
          RL.separated = true;
        }
        resep.push(RL);
      }
      lanes = resep.slice().sort(function (a, b) {
        if (!!a.isPhase !== !!b.isPhase) return a.isPhase ? -1 : 1;
        if (Math.abs(a.y - b.y) > 0.5) return a.y - b.y;
        return a.x - b.x;
      });
      // 7d 收尾:编号重排(阶段泳道仍 00,其余 01..N 连续),laneOf 按最终泳道重铺
      var reNo2 = 0;
      for (var lf = 0; lf < lanes.length; lf++) {
        if (lanes[lf].isPhase) { lanes[lf].no = "00"; continue; }
        reNo2++;
        lanes[lf].no = pad2(reNo2);
      }
      laneOf = new Map();
      for (var lf2 = 0; lf2 < lanes.length; lf2++) {
        for (var lf3 = 0; lf3 < lanes[lf2].nodes.length; lf3++) laneOf.set(lanes[lf2].nodes[lf3], lanes[lf2].key);
      }
    }

    // ---- 8) 孤立节点:「未连接」列放最下(单独一列,不编造归属) ----
    if (isolated.length) {
      var bottom = MARGIN;
      for (var pv of pos.values()) bottom = Math.max(bottom, pv.y + NODE_H);
      for (var li6 = 0; li6 < lanes.length; li6++) bottom = Math.max(bottom, lanes[li6].y + lanes[li6].h);
      var ox = MARGIN, oy = bottom + ORPHAN_GAP;
      for (var oi4 = 0; oi4 < isolated.length; oi4++) {
        pos.set(isolated[oi4], { x: ox, y: oy + oi4 * (NODE_H + ROW_GAP) });
        size.set(isolated[oi4], { w: NODE_W, h: NODE_H });
      }
      var orphanH = isolated.length * (NODE_H + ROW_GAP) - ROW_GAP;
      // 编号顺排在非阶段泳道之后(阶段泳道占 00,孤立列不能跳号成 02)
      var nonPhaseN = 0;
      for (var lpz = 0; lpz < lanes.length; lpz++) if (!lanes[lpz].isPhase) nonPhaseN++;
      lanes.push({
        key: "lane:__isolated__", label: "未连接", no: pad2(nonPhaseN + 1),
        x: ox - LANE_PAD, y: oy - LANE_HEAD, w: NODE_W + LANE_PAD * 2, h: orphanH + LANE_HEAD + LANE_TAIL,
        nodes: isolated.slice(), isolated: true,
      });
      for (var oi5 = 0; oi5 < isolated.length; oi5++) laneOf.set(isolated[oi5], "lane:__isolated__");
    }

    // ---- 8b) 空壳泳道降噪(compact 密度分层态专用)----
    // 实测病灶(60 节点真实板):compact 下 .cv-node=7 但 .cv-lane=21——面板把非主干卡全收进 +N 计数块后,
    // 18 条泳道框里空无一物,21 个虚框 vs 7 张卡(3:1)互相重叠把画面糊住,框与内容脱钩。
    // 只标记不删数据:lanes 数组必须保留(面板靠 key→label 算计数块),渲染层按 boxless 跳过画框,
    // 归属信息由计数块自己表达(计数块 title 里带「编号 泳道名 里的 N 个节点」)。
    // 判据:泳道内有主干卡 → 保留框(有卡就该有框);阶段泳道(00 流程)语义固定 → 保留框。
    if (compact) {
      for (var lbox = 0; lbox < lanes.length; lbox++) {
        var LB = lanes[lbox];
        if (LB.isPhase) continue;
        var hasMainB = false;
        for (var lbi = 0; lbi < LB.nodes.length; lbi++) if (mainNodes.has(LB.nodes[lbi])) { hasMainB = true; break; }
        if (!hasMainB) LB.boxless = true;
      }
    }

    // ---- 9) 节点编号 01..N:泳道序 → 层序 → id(孤立节点在最后一条泳道) ----
    var ord = [];
    for (var li7 = 0; li7 < lanes.length; li7++) {
      var L7 = lanes[li7];
      var ids7 = L7.nodes.slice().sort(function (a, b) {
        var la7 = level.get(a);
        var lb7 = level.get(b);
        if (la7 === undefined) la7 = Infinity;
        if (lb7 === undefined) lb7 = Infinity;
        if (la7 !== lb7) return la7 - lb7;
        return a < b ? -1 : 1;
      });
      for (var li8 = 0; li8 < ids7.length; li8++) ord.push(ids7[li8]);
    }
    for (var oi6 = 0; oi6 < ord.length; oi6++) no.set(ord[oi6], pad2(oi6 + 1));

    // ---- 10) 世界 bounds(渲染层适配视野/小地图) ----
    var bx = Infinity, by = Infinity, br = 0, bb = 0;
    for (var [bid, bp] of pos) {
      bx = Math.min(bx, bp.x); by = Math.min(by, bp.y);
      br = Math.max(br, bp.x + NODE_W); bb = Math.max(bb, bp.y + NODE_H);
    }
    for (var li9 = 0; li9 < lanes.length; li9++) {
      bx = Math.min(bx, lanes[li9].x); by = Math.min(by, lanes[li9].y);
      br = Math.max(br, lanes[li9].x + lanes[li9].w); bb = Math.max(bb, lanes[li9].y + lanes[li9].h);
    }
    if (!isFinite(bx)) { bx = 0; by = 0; br = 0; bb = 0; }

    return {
      mode: "flow",
      pos: pos, size: size,
      lanes: lanes, laneOf: laneOf,
      mainPath: mainPath, mainNodes: mainNodes, mainEdges: mainEdges,
      backEdges: backEdges,
      entry: entry, exit: exit,
      no: no, level: level,
      isolated: isolated,
      orphanCount: isolated.length,
      wrap: wrapMeta,
      bounds: { x: bx, y: by, w: br - bx, h: bb - by },
      baseline: baseline,
    };
  }

  return { layout: layout, stagePrefix: stagePrefix, KIND_LANE: KIND_LANE };
});
