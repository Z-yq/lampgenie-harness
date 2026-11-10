/** UI 交互流程板布局引擎(2026-10-26,docKind=page 且 ≥2 屏):
 * 「多屏原型 + 元素锚点 + 彩色交互流线」——不是把页面结构图缩成小窗,而是把一次 UI 任务
 * 的「屏幕地图」和「交互跳转」画成一张能读的图。
 *
 * 纯函数零 IO 零随机(确定性排序带 id tie-breaker);浏览器挂 BoardUiFlowLayout,
 * vitest 直接 module.exports 单测。输入依赖 BoardPageLayout.layout(doc) 的结果(base):
 * base 负责页内 UI 线框尺寸/角色/主线/回边;本引擎负责:
 *  - 多屏网格(≤4 列,按 nav 分层序 + 相邻屏重心选列,减少跨行交叉);
 *  - 每屏编号/标题/职责字幕带(图形外,阅读顺序 01..N);
 *  - 跨屏交互边:页→页、元素→页、页→元素都统一解析到「真实触发元素」;
 *  - 元素锚点:把线从元素引到页边界(短引线+彩色触点),不把整页当触发源;
 *  - 正交路由:同排相邻直连、跨排走行间通道、跨多排走右侧车道,回边走下方通道;
 *  - 顶部分组图例(按目标屏配色)+ 主路径摘要;常驻导航画底部 tab 条;
 *  - 交互逻辑/未归属节点收进底部辅助带(不与屏幕混排)。
 *
 * 不改板数据:布局是渲染层视图,节点 pos 不落盘;用户拖动走面板侧 localStorage 微调。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root = root || (typeof self !== "undefined" ? self : globalThis);
    root.BoardUiFlowLayout = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 深色画布上可区分的流程色(第 1~6 组循环);主线不用颜色表达,用屏幕金框/主线徽标。
  var PALETTE = [
    { line: "#6fa8ff", fill: "rgba(111,168,255,.16)", text: "#c3dcff" },
    { line: "#7fd6a5", fill: "rgba(127,214,165,.15)", text: "#c3f0d6" },
    { line: "#f0a15e", fill: "rgba(240,161,94,.15)", text: "#f6c9a0" },
    { line: "#c99bff", fill: "rgba(201,155,255,.15)", text: "#e1ccff" },
    { line: "#f27c8d", fill: "rgba(242,124,141,.15)", text: "#f7b6c0" },
    { line: "#6fd6d6", fill: "rgba(111,214,214,.15)", text: "#bdeeee" },
  ];
  var BACK = { line: "#8b8174", fill: "rgba(139,129,116,.13)", text: "#c9c0b2" };
  var LOGIC = { line: "#5fc2b0", fill: "rgba(95,194,176,.13)", text: "#a9e6db" };
  var AUX = { line: "#c9a25e", fill: "rgba(201,162,94,.13)", text: "#e6cfa0" };

  var CAPTION_H = 58;     // 屏外字幕带(编号/标题/职责)
  var COL_GAP = 112;      // 列间距(流线+标签通道)
  var ROW_GAP = 92;       // 行间距(下一行字幕带+行间流线通道)
  var MARGIN_X = 64;
  var MARGIN_Y = 26;
  var HEAD_H = 68;        // 顶部摘要+图例带
  var MAX_COLS = 4;
  var AUX_GAP = 48;
  var AUX_W = 196;
  var AUX_H = 46;
  var AUX_X_GAP = 12;
  var AUX_Y_GAP = 12;
  var TAB_H = 28;

  function arr(x) { return Array.isArray(x) ? x : []; }
  function txt(x) { return String(x == null ? "" : x); }
  function byId(nodes) {
    var m = new Map();
    for (var i = 0; i < nodes.length; i++) m.set(nodes[i].id, nodes[i]);
    return m;
  }
  function isPage(n) { return !!(n && n.kind === "page"); }
  function isNav(n) { return !!(n && n.kind === "nav"); }
  function isComponent(n) { return !!(n && n.kind === "component"); }
  function isSection(n) { return !!(n && n.kind === "section"); }
  function isLogicKind(n) {
    return !!(n && ["function", "tool", "module", "agent", "http", "llm", "decision", "note"].indexOf(String(n.kind)) >= 0);
  }
  function popupWords(s) {
    return /(弹窗|弹层|浮层|对话框|模态|气泡|抽屉|下拉菜单|modal|dialog|toast|popover|drawer|bottom\s*sheet|action\s*sheet)/i.test(txt(s));
  }
  /** 浮层本体判定:label 优先。summary 里写「点击打开 XX 弹窗」的是触发按钮,不是弹窗本体。 */
  function isOverlay(n) {
    if (!n) return false;
    var label = txt(n.label), sum = txt(n.summary);
    if (popupWords(label)) {
      // 「打开设置弹窗按钮」/「弹窗入口」= 触发器;「确认删除弹窗」才是浮层本体
      if (/(按钮|点击|打开|触发|入口|页签)/.test(label) && !/(确认弹窗|确认框|对话框)$/.test(label)) return false;
      return true;
    }
    return n.kind === "section" && popupWords(sum);
  }
  function popupModeOf(n) {
    var t = txt(n && n.label) + " " + txt(n && n.summary);
    if (/(底部|底栏|上拉|bottom\s*sheet|action\s*sheet)/i.test(t)) return "bottom";
    if (/(右侧|右边|侧滑|drawer|抽屉)/i.test(t)) return "right";
    if (/(左侧|左边)/i.test(t)) return "left";
    if (/(下拉|气泡|popover|dropdown)/i.test(t)) return "popover";
    return "modal";
  }
  function stripNo(s) {
    var t = txt(s).trim();
    // 去掉 P1/01/1. 等阅读序前缀
    while (/^[Pp]?\d+[\s.、:：\-]*/.test(t)) t = t.replace(/^[Pp]?\d+[\s.、:：\-]*/, "");
    return t.trim();
  }
  function pageCore(s) {
    var t = stripNo(s);
    t = t.replace(/[（(][^）)]*[）)]/g, "").trim();
    t = t.replace(/(页面|页|列表|详情页|表单页|结果页)$/g, "").trim();
    return t;
  }
  function shortTitle(n) {
    var t = stripNo(n && n.label ? n.label : "");
    if (!t) t = "未命名屏";
    return t.length > 18 ? t.slice(0, 17) + "…" : t;
  }
  function quoted(s) {
    var out = [];
    var re = /[「『"“]([^」』"”]{1,24})[」』"”]/g;
    var m;
    while ((m = re.exec(txt(s))) !== null) out.push(m[1]);
    return out;
  }
  function lcsLen(a, b) {
    a = txt(a).slice(0, 120);
    b = txt(b).slice(0, 200);
    if (!a || !b) return 0;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    var i, j, best = 0;
    for (j = 0; j <= b.length; j++) prev[j] = 0;
    for (i = 1; i <= a.length; i++) {
      cur[0] = 0;
      for (j = 1; j <= b.length; j++) {
        cur[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev[j - 1] + 1 : 0;
        if (cur[j] > best) best = cur[j];
      }
      var sw = prev; prev = cur; cur = sw;
    }
    return best;
  }
  function isBackLabel(s) {
    return /(返回|回到|上一步|取消|退回|关闭|继续浏览|继续逛|再看|重新浏览)/.test(txt(s));
  }
  function lineDash(kind) {
    return kind === "back" || kind === "logic" || kind === "aux" ? "6 4" : "";
  }
  function markerOf(kind, colorIndex) {
    if (kind === "back") return "uiback";
    if (kind === "logic") return "uilogic";
    if (kind === "aux") return "uiaux";
    return "uia" + colorIndex;
  }
  function colorOf(kind, colorIndex) {
    if (kind === "back") return BACK;
    if (kind === "logic") return LOGIC;
    if (kind === "aux") return AUX;
    return PALETTE[colorIndex % PALETTE.length];
  }

  /** 多屏布局。base=BoardPageLayout.layout(doc) 的结果(必传)。opts.moved=id→{x,y} 本地微调。
   * 返回与 BoardPageLayout 同形的 pos/size/containers/roles/level/main* 等,额外带:
   * pages/flows/groups/head/auxLane/auxNodes/tabsByPage/world/summary。 */
  function layout(doc, base, opts) {
    if (!doc || !base) return null;
    var nodes = arr(doc.nodes);
    var edges = arr(doc.edges);
    var nm = byId(nodes);
    var nodeSeq = new Map();
    for (var ns0 = 0; ns0 < nodes.length; ns0++) nodeSeq.set(nodes[ns0].id, ns0);
    var pageIds = [];
    var pageOrderIdx = new Map();
    for (var i0 = 0; i0 < nodes.length; i0++) {
      if (isPage(nodes[i0])) { pageOrderIdx.set(nodes[i0].id, pageIds.length); pageIds.push(nodes[i0].id); }
    }
    if (pageIds.length < 2) return null; // 单屏不进入交互地图(保留原页面结构板)
    var pageSet = new Set(pageIds);

    // ---- 1) contains 归属 + 页内子孙 + 元素所属页 ----
    var kids = new Map();
    var parentOf = new Map();
    var pageOf = new Map();
    var depthOf = new Map();
    for (var e0 = 0; e0 < edges.length; e0++) {
      var ce = edges[e0];
      if ((ce.kind || "contains") !== "contains") continue;
      if (!nm.has(ce.from) || !nm.has(ce.to)) continue;
      if (!kids.has(ce.from)) kids.set(ce.from, []);
      kids.get(ce.from).push(ce.to);
      if (!parentOf.has(ce.to)) parentOf.set(ce.to, ce.from);
    }
    var pageDesc = new Map();
    function descendantsOf(pid) {
      var out = [];
      var seen = new Set();
      var st = (kids.get(pid) || []).slice();
      var d = 0;
      while (st.length) {
        var next = [];
        for (var si = 0; si < st.length; si++) {
          var cid = st[si];
          if (seen.has(cid)) continue;
          seen.add(cid);
          var cn = nm.get(cid);
          if (!cn) continue;
          out.push(cn);
          if (!depthOf.has(cid)) depthOf.set(cid, d + 1);
          var ck = kids.get(cid) || [];
          for (var ci = 0; ci < ck.length; ci++) next.push(ck[ci]);
        }
        st = next; d++;
      }
      return out;
    }
    var rawDesc = new Map();
    for (var p0 = 0; p0 < pageIds.length; p0++) {
      var desc = descendantsOf(pageIds[p0]);
      rawDesc.set(pageIds[p0], desc);
      for (var d0 = 0; d0 < desc.length; d0++) {
        if (!pageOf.has(desc[d0].id)) pageOf.set(desc[d0].id, pageIds[p0]);
      }
    }
    // 同一节点被两个 page contains(实测 planner 复用 id):第一个 page 拥有,后来的 page 不重复摆放
    for (var p0b = 0; p0b < pageIds.length; p0b++) {
      var pidb = pageIds[p0b];
      pageDesc.set(pidb, rawDesc.get(pidb).filter(function (n) { return pageOf.get(n.id) === pidb; }));
    }
    function pageOfNode(id) {
      if (pageSet.has(id)) return id;
      return pageOf.get(id) || null;
    }
    function descendants(pid) { return pageDesc.get(pid) || []; }

    // ---- 1.5) 浮层归属(2026-10-26 用户口径「按键弹窗怎么表达」) ----
    // 弹窗/抽屉/下拉菜单是一个独立节点(component/section,标签写明浮层形态),它的子树不再参与
    // 页内普通行布局——渲染层把它画成页内浮层,流线从触发按钮落到浮层边框,而不是落到页内某按钮。
    var baseRoles = (base && base.roles) || new Map();
    function nodeIsPopup(n) {
      if (!n || isPage(n)) return false;
      if (isOverlay(n)) return true;
      return baseRoles.get(n.id) === "overlay";
    }
    // 旧板漂移兜底:planner 常把弹窗组件只挂 nav(点击某条交易→交易详情抽屉)却漏 contains,
    // 结果浮层掉进底部辅助带、箭头指向页外。对「无 page 归属的浮层节点」按入向 nav 的源页反推归属,
    // 只在渲染层生效(不改盘上板),让它回到所属页内成为真正的浮层。
    for (var po0 = 0; po0 < nodes.length; po0++) {
      var pon = nodes[po0];
      if (!nodeIsPopup(pon) || pageOf.has(pon.id)) continue;
      for (var pe0 = 0; pe0 < edges.length; pe0++) {
        var pne = edges[pe0];
        if ((pne.kind || "") !== "nav" || pne.to !== pon.id) continue;
        var powner = pageOfNode(pne.from) || (isPage(nm.get(pne.from)) ? pne.from : null);
        if (!powner) continue;
        pageOf.set(pon.id, powner);
        if (!pageDesc.has(powner)) pageDesc.set(powner, []);
        var pownerDesc = pageDesc.get(powner);
        if (pownerDesc.indexOf(pon) < 0) pownerDesc.push(pon);
        var pownerKids = descendantsOf(pon.id);
        for (var pok = 0; pok < pownerKids.length; pok++) {
          if (!pageOf.has(pownerKids[pok].id)) {
            pageOf.set(pownerKids[pok].id, powner);
            if (pownerDesc.indexOf(pownerKids[pok]) < 0) pownerDesc.push(pownerKids[pok]);
            if (!depthOf.has(pownerKids[pok].id)) depthOf.set(pownerKids[pok].id, 1);
          }
        }
        break;
      }
    }
    var popupIds = new Set();
    for (var pu0 = 0; pu0 < nodes.length; pu0++) {
      var pun = nodes[pu0];
      if (!nodeIsPopup(pun)) continue;
      var nestedPopup = false;
      var pcur = parentOf.get(pun.id);
      var pguard = 0;
      while (pcur && pguard++ < 30) {
        var pcn = nm.get(pcur);
        if (pcn && nodeIsPopup(pcn)) { nestedPopup = true; break; }
        pcur = parentOf.get(pcur);
      }
      if (!nestedPopup) popupIds.add(pun.id);
    }
    var popupSubtree = new Set();
    var popupOf = new Map();
    var popupKids = new Map();
    var popupByPage = new Map();
    popupIds.forEach(function (pid) {
      var owner = pageOfNode(pid);
      popupSubtree.add(pid);
      var pdesc = descendantsOf(pid);
      popupKids.set(pid, pdesc.length);
      if (owner) {
        if (!popupByPage.has(owner)) popupByPage.set(owner, []);
        popupByPage.get(owner).push(pid);
      }
      for (var pdi = 0; pdi < pdesc.length; pdi++) {
        if (!owner || pageOf.get(pdesc[pdi].id) !== owner) continue;
        popupSubtree.add(pdesc[pdi].id);
        popupOf.set(pdesc[pdi].id, pid);
      }
    });
    /** 目标是 page 但 label 写「弹出：XX」的旧板:把目标归到该页的浮层节点(有且能匹配时)。 */
    function popupOnPage(pid, edgeLabel) {
      var list = popupByPage.get(pid) || [];
      if (!list.length) return null;
      var qs = quoted(edgeLabel);
      var best = null, bestScore = 0;
      for (var pi = 0; pi < list.length; pi++) {
        var plabel = txt(nm.get(list[pi]) && nm.get(list[pi]).label);
        var score = 0;
        if (plabel.length >= 2 && txt(edgeLabel).indexOf(plabel) >= 0) score += 12;
        for (var qi = 0; qi < qs.length; qi++) {
          if (qs[qi].length >= 2 && (plabel.indexOf(qs[qi]) >= 0 || qs[qi].indexOf(plabel) >= 0)) score += 8;
        }
        score += Math.min(6, lcsLen(edgeLabel, plabel));
        if (score > bestScore) { bestScore = score; best = list[pi]; }
      }
      if (best && bestScore >= 2) return best;
      return list.length === 1 ? list[0] : null;
    }
    var navIds = new Set();
    for (var nv0 = 0; nv0 < nodes.length; nv0++) if (isNav(nodes[nv0])) navIds.add(nodes[nv0].id);

    // ---- 2) 屏幕阅读序:前向 nav 图 → 入口 → 最长主路径 → 其余分支(声明序) ----
    // base 的分层在「结果页→继续浏览回首页」这类回边环上会破错边(实测主路径被反成结果页开头),
    // 所以交互地图自己算:回边按语义标签剥离,入口取可达最多,主路径用最长简单路径,分支尾随。
    var fwdAdj = new Map();
    var fwdIndeg = new Map();
    for (var pv = 0; pv < pageIds.length; pv++) { fwdAdj.set(pageIds[pv], []); fwdIndeg.set(pageIds[pv], 0); }
    for (var ev = 0; ev < edges.length; ev++) {
      var ee = edges[ev];
      if ((ee.kind || "") !== "nav") continue;
      var fsp = pageOfNode(ee.from), ftp = pageOfNode(ee.to);
      if (!fsp || !ftp || fsp === ftp) continue;
      if (navIds.has(ee.from)) continue; // tab 边不是页面流程
      if (isBackLabel(ee.label)) continue;
      if (fwdAdj.get(fsp).indexOf(ftp) < 0) {
        fwdAdj.get(fsp).push(ftp);
        fwdIndeg.set(ftp, (fwdIndeg.get(ftp) || 0) + 1);
      }
    }
    function reachCount(start) {
      var seen = new Set([start]), st = [start];
      while (st.length) {
        var cur = st.pop();
        var outs = fwdAdj.get(cur) || [];
        for (var i = 0; i < outs.length; i++) if (!seen.has(outs[i])) { seen.add(outs[i]); st.push(outs[i]); }
      }
      return seen.size;
    }
    var entries = pageIds.filter(function (id) { return (fwdIndeg.get(id) || 0) === 0; });
    if (!entries.length) {
      var minIn = Infinity;
      for (var pi0 = 0; pi0 < pageIds.length; pi0++) minIn = Math.min(minIn, fwdIndeg.get(pageIds[pi0]) || 0);
      entries = pageIds.filter(function (id) { return (fwdIndeg.get(id) || 0) === minIn; });
    }
    entries.sort(function (a, b) {
      var ra = reachCount(a), rb = reachCount(b);
      if (ra !== rb) return rb - ra;
      var oa = (fwdAdj.get(a) || []).length, ob = (fwdAdj.get(b) || []).length;
      if (oa !== ob) return ob - oa;
      return pageOrderIdx.get(a) - pageOrderIdx.get(b);
    });
    var entryId = entries[0] || pageIds[0];
    // BFS 到最远节点再回溯(多项式、环安全):不枚举全部简单路径——14+ 屏密集板会指数爆炸。
    function mainPathFrom(start) {
      var depth = new Map([[start, 0]]);
      var parent = new Map();
      var q = [start];
      var farthest = start, farDepth = 0;
      while (q.length) {
        var cur = q.shift();
        var outs = (fwdAdj.get(cur) || []).slice().sort(function (a, b) { return pageOrderIdx.get(a) - pageOrderIdx.get(b); });
        for (var i = 0; i < outs.length; i++) {
          var nxt = outs[i];
          if (depth.has(nxt)) continue;
          depth.set(nxt, (depth.get(cur) || 0) + 1);
          parent.set(nxt, cur);
          q.push(nxt);
          var d = depth.get(nxt);
          if (d > farDepth || (d === farDepth && pageOrderIdx.get(nxt) < pageOrderIdx.get(farthest))) {
            farDepth = d; farthest = nxt;
          }
        }
      }
      var path = [];
      var walk = farthest;
      while (walk !== undefined) {
        path.push(walk);
        walk = parent.get(walk);
      }
      path.reverse();
      return path;
    }
    var mainPathIds = mainPathFrom(entryId);
    var mainPageSet = new Set(mainPathIds);
    var pageSeq = mainPathIds.slice();
    var restPages = pageIds.filter(function (id) { return !mainPageSet.has(id); }).sort(function (a, b) { return pageOrderIdx.get(a) - pageOrderIdx.get(b); });
    pageSeq = pageSeq.concat(restPages);
    var pageList = pageSeq;
    var levelMap = new Map();
    for (var pl = 0; pl < pageIds.length; pl++) levelMap.set(pageIds[pl], 0);
    levelMap.set(entryId, 0);
    var qLevel = [entryId];
    var seenLevel = new Set([entryId]);
    while (qLevel.length) {
      var curL = qLevel.shift();
      var outsL = fwdAdj.get(curL) || [];
      for (var ol = 0; ol < outsL.length; ol++) {
        var nxtL = outsL[ol];
        if (seenLevel.has(nxtL)) continue; // 环安全:每页只赋一次层
        seenLevel.add(nxtL);
        levelMap.set(nxtL, (levelMap.get(curL) || 0) + 1);
        qLevel.push(nxtL);
      }
    }
    var mainPairSet = new Set();
    for (var mp = 1; mp < mainPathIds.length; mp++) mainPairSet.add(mainPathIds[mp - 1] + ">" + mainPathIds[mp]);

    // ---- 3) 常驻导航 tab(从 nav 节点→page 的 nav 边;tab 条画在屏底) ----
    var tabsByPage = new Map();
    var tabEdges = [];
    for (var e1 = 0; e1 < edges.length; e1++) {
      var te = edges[e1];
      if ((te.kind || "") !== "nav" || !navIds.has(te.from) || !pageSet.has(te.to)) continue;
      tabEdges.push(e1);
      var tnode = nm.get(te.to);
      var qs = quoted(te.label);
      var tl = qs.length ? qs[0] : "";
      if (!tl) {
        var raw = txt(te.label).replace(/^.*?(tab|页签|导航)\s*/i, "").trim();
        tl = raw || shortTitle(tnode);
      }
      if (!tabsByPage.has(te.to)) tabsByPage.set(te.to, []);
      var bucket = tabsByPage.get(te.to);
      var dup = false;
      for (var tb = 0; tb < bucket.length; tb++) if (bucket[tb].label === tl) dup = true;
      if (!dup) bucket.push({ label: tl, to: te.to, edgeIdx: e1 });
    }

    // ---- 4) 设备/屏幕尺寸(含移动端 tab 条) ----
    // 设备判定放在列数之前:网页/桌面 UI 用更宽的窗框和浏览器 chrome,不能套手机壳。
    var allText = txt(doc.title);
    for (var qd = 0; qd < pageList.length; qd++) {
      allText += " " + txt(nm.get(pageList[qd]) && nm.get(pageList[qd]).label) + " " + txt(nm.get(pageList[qd]) && nm.get(pageList[qd]).summary);
    }
    var strongMobile = /(小程序|手机|移动端|ios|android|安卓|h5|微信)/i.test(allText);
    var strongDesktop = /(桌面|desktop|网页|web|浏览器|窗口|管理台|后台|ide|编辑器)/i.test(allText);
    var mobileBoard = strongMobile || (!strongDesktop && /\bapp\b/i.test(allText));
    if (strongDesktop && !strongMobile) mobileBoard = false;
    var baseSize = base.size || new Map();
    var frameSize = new Map();
    var maxFrameW = 0;
    for (var p1 = 0; p1 < pageList.length; p1++) {
      var pid1 = pageList[p1];
      var bs = baseSize.get(pid1) || { w: 340, h: 420 };
      var tabs1 = tabsByPage.get(pid1) || [];
      // 桌面窗框最小 380 宽(内容居中);移动端最小 250。tab 条只有移动端占高,桌面 tab 进浏览器 chrome。
      var fsW = mobileBoard ? Math.max(250, bs.w) : Math.max(380, bs.w);
      var fsH = Math.max(180, bs.h) + (mobileBoard && tabs1.length ? TAB_H : 0);
      var fs = { w: fsW, h: fsH };
      frameSize.set(pid1, fs);
      if (fs.w > maxFrameW) maxFrameW = fs.w;
    }

    // ---- 5) 网格:行号按阅读序;桌面按窗宽自适应列数(540px 窗≈3 列,380px≈4 列) ----
    var maxColsByWidth = Math.max(1, Math.floor((2000 - MARGIN_X * 2 + COL_GAP) / (maxFrameW + COL_GAP)));
    var cols = Math.min(MAX_COLS, pageList.length, mobileBoard ? MAX_COLS : maxColsByWidth);
    var rows = Math.ceil(pageList.length / cols);
    var rowOf = new Map();
    var colOf = new Map();
    var rowPages = [];
    for (var r0 = 0; r0 < rows; r0++) rowPages.push([]);
    for (var q0 = 0; q0 < pageList.length; q0++) {
      var pidq = pageList[q0];
      var rq = Math.floor(q0 / cols);
      rowOf.set(pidq, rq);
      colOf.set(pidq, q0 % cols);
      rowPages[rq].push(pidq);
    }
    var pageNeighbors = new Map();
    function linkPages(a, b) {
      if (!a || !b || a === b || !pageSet.has(a) || !pageSet.has(b)) return;
      if (!pageNeighbors.has(a)) pageNeighbors.set(a, new Set());
      if (!pageNeighbors.has(b)) pageNeighbors.set(b, new Set());
      pageNeighbors.get(a).add(b);
      pageNeighbors.get(b).add(a);
    }
    for (var e2 = 0; e2 < edges.length; e2++) {
      var pe = edges[e2];
      if ((pe.kind || "") !== "nav") continue;
      linkPages(pageOfNode(pe.from), pageOfNode(pe.to));
    }
    for (var r1 = 1; r1 < rows; r1++) {
      var used = new Set();
      var group = rowPages[r1];
      for (var gi = 0; gi < group.length; gi++) {
        var pidg = group[gi];
        var neigh = pageNeighbors.get(pidg) || new Set();
        var vals = [];
        neigh.forEach(function (nid) {
          var nr = rowOf.get(nid);
          if (nr !== undefined && nr < r1) vals.push(colOf.get(nid));
        });
        var target = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : colOf.get(pidg);
        var best = -1, bestD = 1e9;
        for (var c0 = 0; c0 < cols; c0++) {
          if (used.has(c0)) continue;
          var dd = Math.abs(c0 - target);
          if (dd < bestD - 0.001) { bestD = dd; best = c0; }
          else if (Math.abs(dd - bestD) <= 0.001 && (best < 0 || c0 < best)) best = c0;
        }
        if (best < 0) best = gi % cols;
        used.add(best);
        colOf.set(pidg, best);
      }
    }

    // ---- 6) 行高/坐标 ----
    var rowHeights = [];
    for (var r2 = 0; r2 < rows; r2++) {
      var rh = 0;
      for (var ri = 0; ri < rowPages[r2].length; ri++) rh = Math.max(rh, frameSize.get(rowPages[r2][ri]).h);
      rowHeights.push(rh);
    }
    var rowY = [];
    var frameY = [];
    for (var r3 = 0; r3 < rows; r3++) {
      rowY.push(r3 === 0 ? MARGIN_Y + HEAD_H : rowY[r3 - 1] + CAPTION_H + rowHeights[r3 - 1] + ROW_GAP);
      frameY.push(rowY[r3] + CAPTION_H);
    }
    var worldW = MARGIN_X * 2 + cols * maxFrameW + (cols - 1) * COL_GAP;
    var pos = new Map();
    var size = new Map();
    var containers = new Map();
    var pageMeta = new Map();
    for (var q1 = 0; q1 < pageList.length; q1++) {
      var pid2 = pageList[q1];
      var r4 = rowOf.get(pid2);
      var c4 = colOf.get(pid2);
      var fs2 = frameSize.get(pid2);
      var cellX = MARGIN_X + c4 * (maxFrameW + COL_GAP);
      var x4 = cellX + (maxFrameW - fs2.w) / 2;
      var y4 = frameY[r4];
      pos.set(pid2, { x: x4, y: y4 });
      size.set(pid2, { w: fs2.w, h: fs2.h });
      containers.set(pid2, { x: x4, y: y4, w: fs2.w, h: fs2.h });
      pageMeta.set(pid2, {
        id: pid2, no: (q1 + 1 < 10 ? "0" : "") + (q1 + 1), row: r4, col: c4,
        x: x4, y: y4, w: fs2.w, h: fs2.h,
        caption: { x: x4, y: y4 - CAPTION_H + 6, w: fs2.w, h: CAPTION_H - 10 },
        title: nm.get(pid2) ? txt(nm.get(pid2).label) : pid2,
        summary: nm.get(pid2) ? txt(nm.get(pid2).summary) : "",
        main: mainPageSet.has(pid2),
        entry: pid2 === entryId,
        tabs: tabsByPage.get(pid2) || [],
        mobile: mobileBoard,
        kidCount: descendants(pid2).length,
        reusedCount: Math.max(0, (rawDesc.get(pid2) || []).length - descendants(pid2).length),
      });
    }
    // 页内节点:base 相对位平移到新页框;tab 条占底部,内容不缩
    for (var q2 = 0; q2 < pageList.length; q2++) {
      var pid3 = pageList[q2];
      var bp = base.pos && base.pos.get ? base.pos.get(pid3) : null;
      var np = pos.get(pid3);
      if (!bp || !np) continue;
      var bsz = baseSize.get(pid3) || { w: 0, h: 0 };
      var fsz = size.get(pid3) || { w: bsz.w, h: bsz.h };
      // 桌面窗框比内容宽:横向等比铺满(行/区块/组件宽度一起放大),不是把 246px 内容居中后留两片空白。
      var scaleX = bsz.w > 0 ? fsz.w / bsz.w : 1;
      var dy = np.y - bp.y;
      var descs = descendants(pid3);
      for (var di = 0; di < descs.length; di++) {
        var cp = base.pos && base.pos.get ? base.pos.get(descs[di].id) : null;
        var cs = baseSize.get(descs[di].id);
        if (!cp) continue;
        pos.set(descs[di].id, { x: np.x + (cp.x - bp.x) * scaleX, y: np.y + (cp.y - bp.y) });
        size.set(descs[di].id, { w: (cs ? cs.w : 150) * scaleX, h: cs ? cs.h : 30 });
      }
    }

    // ---- 6.5) 元素行加宽:base 的组件是 84px 素描小卡,交互地图里要当「UI 行」读。
    // 同组(同一 section 或同一页的行)均分可用宽度;单个组件=整行宽。只改宽/横位,不改高。
    function nearestSection(id) {
      var cur = parentOf.get(id);
      var guard = 0;
      while (cur && guard++ < 20) {
        var pn = nm.get(cur);
        if (!pn) return null;
        if (pn.kind === "section") return cur;
        cur = parentOf.get(cur);
      }
      return null;
    }
    var actionBars = [];
    for (var w0 = 0; w0 < pageList.length; w0++) {
      var wpid = pageList[w0];
      var wpagePos = pos.get(wpid), wpageSize = size.get(wpid);
      if (!wpagePos || !wpageSize) continue;
      // 浮层子树不参与页内行布局(下一步按浮层框单独排),否则弹窗字段会被排成页底一些散行。
      var wcomps = descendants(wpid).filter(function (n) { return n.kind === "component" && !popupSubtree.has(n.id); });
      var wgroups = new Map();
      for (var wc = 0; wc < wcomps.length; wc++) {
        var cn0 = wcomps[wc];
        var secId = nearestSection(cn0.id);
        var cp0 = base.pos && base.pos.get ? base.pos.get(cn0.id) : null;
        var sp0 = secId && base.pos && base.pos.get ? base.pos.get(secId) : null;
        var ss0 = secId && baseSize.get(secId);
        var inSec = !!(secId && cp0 && sp0 && ss0 &&
          cp0.x >= sp0.x - 1 && cp0.y >= sp0.y - 1 &&
          cp0.x + (baseSize.get(cn0.id) ? baseSize.get(cn0.id).w : 0) <= sp0.x + ss0.w + 1 &&
          cp0.y + (baseSize.get(cn0.id) ? baseSize.get(cn0.id).h : 0) <= sp0.y + ss0.h + 1);
        var relY = cp0 && base.pos.get(wpid) ? Math.round((cp0.y - base.pos.get(wpid).y) / 4) : 0;
        var ownerRole = secId ? (base.roles.get(secId) || "") : "";
        var bandGroup = !!secId && !inSec && (ownerRole === "top" || ownerRole === "bottom");
        var gkey = bandGroup ? "band:" + secId : (inSec ? "s:" + secId : "p:" + wpid) + "|" + relY;
        if (!wgroups.has(gkey)) wgroups.set(gkey, { secId: inSec ? secId : "", ownerSecId: secId || "", pid: wpid, band: bandGroup, list: [] });
        wgroups.get(gkey).list.push(cn0);
      }
      wgroups.forEach(function (grp) {
        var availX, availW;
        if (grp.secId) {
          var sp1 = pos.get(grp.secId), ss1 = size.get(grp.secId);
          if (!sp1 || !ss1) return;
          availX = sp1.x + 6; availW = Math.max(48, ss1.w - 12);
        } else {
          availX = wpagePos.x + 12; availW = Math.max(48, wpageSize.w - 24);
        }
        // 悬浮按钮不参与行布局:吸在页面右下角(移动端在 tab 条上)
        var normal = [];
        for (var fi = 0; fi < grp.list.length; fi++) {
          var fn = grp.list[fi];
          if (controlOf(fn) === "fab") {
            var fabSize = 44;
            pos.set(fn.id, { x: wpagePos.x + wpageSize.w - fabSize - 16, y: wpagePos.y + wpageSize.h - (mobileBoard ? TAB_H : 0) - fabSize - 18 });
            size.set(fn.id, { w: fabSize, h: fabSize });
          } else normal.push(fn);
        }
        if (!normal.length) return;
        normal.sort(function (a, b) {
          if (grp.band) return (nodeSeq.get(a.id) || 0) - (nodeSeq.get(b.id) || 0);
          var pa = pos.get(a.id) || { x: 0 }, pb = pos.get(b.id) || { x: 0 };
          if (Math.abs(pa.x - pb.x) > 1) return pa.x - pb.x;
          return a.id < b.id ? -1 : 1;
        });
        var ctlTypes = normal.map(function (n) { return controlOf(n); });
        var buttonSet = { primary: 1, secondary: 1, danger: 1, text: 1, icon: 1, tab: 1 };
        var allButtons = ctlTypes.every(function (t) { return buttonSet[t]; });
        var gap = 6;
        var ctxSec = grp.ownerSecId || grp.secId;
        var secRole = ctxSec ? (base.roles.get(ctxSec) || "main") : "";
        var secType = ctxSec ? sectionTypeOf(nm.get(ctxSec), secRole) : "content";
        // base 会把 top 区子孙摊到页级组件行;网页/桌面 header/menubar 的按钮要放回顶栏带内,
        // 否则「顶部导航/菜单栏」只剩一条标题、按钮漂到内容区。
        var band = false, bandY = 0, bandH = 0;
        if (grp.band && ctxSec) {
          var bsx = pos.get(ctxSec), bss = size.get(ctxSec);
          if (bsx && bss) {
            band = true;
            availX = bsx.x + 6;
            availW = Math.max(48, bss.w - 12);
            bandY = bsx.y + (secRole === "bottom" ? Math.max(0, (bss.h - 22) / 2) : 1);
            bandH = Math.max(18, bss.h - 2);
          }
        }
        var avgY = 0;
        for (var ay0 = 0; ay0 < normal.length; ay0++) avgY += (pos.get(normal[ay0].id) || { y: 0 }).y;
        avgY = avgY / normal.length;
        var relTop = wpageSize.h > 0 ? (avgY - wpagePos.y) / wpageSize.h : 0;
        var isActionBar = mobileBoard && (secRole === "bottom" || (!band && relTop > 0.65));
        function ctlWidth(n, ctl) {
          var len = txt(n.label).length;
          if (band && secType === "header") {
            if (ctl === "icon") return 28;
            if (ctl === "primary") return 72;
            if (ctl === "tab") return Math.min(104, Math.max(64, len * 11 + 22));
            return ctl === "text" ? 68 : 48;
          }
          if (ctl === "icon") return 30;
          if (ctl === "tab") return Math.min(188, Math.max(74, len * 11 + 22));
          if (ctl === "primary") return Math.min(168, Math.max(84, len * 7 + 26));
          return Math.min(160, Math.max(64, len * 8 + 22));
        }
        // 单个控件:按钮按类型给宽(移动端主按钮=整行 CTA);输入/卡片/toggle 占满
        if (normal.length === 1) {
          var one = normal[0], oneCtl = ctlTypes[0];
          var oneP = pos.get(one.id), oneS = size.get(one.id);
          if (oneP && oneS) {
            if (buttonSet[oneCtl]) {
              var sidebarFill = secRole === "side" && (oneCtl === "tab" || oneCtl === "toggle");
              var ow = sidebarFill || (mobileBoard && oneCtl === "primary") ? availW : ctlWidth(one, oneCtl);
              var oneRight = !mobileBoard && (secType === "dialog" || secType === "footer" || secType === "header" || relTop > 0.65);
              pos.set(one.id, { x: oneRight ? availX + availW - ow : availX, y: band ? bandY : oneP.y });
              size.set(one.id, { w: ow, h: band ? bandH : Math.max(28, oneS.h) });
              if (isActionBar) actionBars.push({ pid: grp.pid, x: wpagePos.x + 8, y: (band && secRole === "bottom" ? bandY : oneP.y) - 4, w: wpageSize.w - 16, h: 36 });
            } else {
              pos.set(one.id, { x: availX, y: oneP.y });
              size.set(one.id, { w: availW, h: oneS.h });
            }
          }
          return;
        }
        if (allButtons) {
          var widths = normal.map(function (n, i) { return ctlWidth(n, ctlTypes[i]); });
          var total = 0;
          for (var wi = 0; wi < widths.length; wi++) total += widths[wi] + (wi ? gap : 0);
          if (total > availW) {
            var slotW0 = Math.max(36, (availW - gap * (normal.length - 1)) / normal.length);
            widths = normal.map(function () { return slotW0; });
            total = slotW0 * normal.length + gap * (normal.length - 1);
          }
          var rightAlign = secType === "dialog" || secType === "footer" || relTop > 0.65;
          if ((secType === "header" || secType === "toolbar") && normal.length > 1) {
            var leftItems = [], rightItems = [];
            for (var pi2 = 0; pi2 < normal.length; pi2++) {
              var pc = ctlTypes[pi2];
              var isBrandIcon = pc === "icon" && /(品牌|logo)/i.test(txt(normal[pi2].label));
              if (pc === "text" || pc === "tab" || isBrandIcon) leftItems.push(pi2); else rightItems.push(pi2);
            }
            var lw = 0, rw = 0;
            for (var li2 = 0; li2 < leftItems.length; li2++) lw += widths[leftItems[li2]] + (li2 ? gap : 0);
            for (var ri2 = 0; ri2 < rightItems.length; ri2++) rw += widths[rightItems[ri2]] + (ri2 ? gap : 0);
            if (leftItems.length && rightItems.length && lw + rw + gap * 2 <= availW) {
              var lx = availX, rx = availX + availW - rw;
              for (var lj = 0; lj < leftItems.length; lj++) {
                var lni = leftItems[lj], lnn = normal[lni], lpp = pos.get(lnn.id), lss = size.get(lnn.id);
                if (!lpp || !lss) continue;
                pos.set(lnn.id, { x: lx, y: band ? bandY : lpp.y });
                size.set(lnn.id, { w: widths[lni], h: band ? bandH : Math.max(28, lss.h) });
                lx += widths[lni] + gap;
              }
              for (var rj = 0; rj < rightItems.length; rj++) {
                var rni = rightItems[rj], rnn = normal[rni], rpp = pos.get(rnn.id), rss = size.get(rnn.id);
                if (!rpp || !rss) continue;
                pos.set(rnn.id, { x: rx, y: band ? bandY : rpp.y });
                size.set(rnn.id, { w: widths[rni], h: band ? bandH : Math.max(28, rss.h) });
                rx += widths[rni] + gap;
              }
              if (isActionBar) actionBars.push({ pid: grp.pid, x: wpagePos.x + 8, y: avgY - 4, w: wpageSize.w - 16, h: 36 });
              return;
            }
          }
          var cx = rightAlign ? availX + availW - total : availX;
          for (var bi = 0; bi < normal.length; bi++) {
            var bn = normal[bi], bp = pos.get(bn.id), bs = size.get(bn.id);
            if (!bp || !bs) continue;
            var bw = widths[bi];
            pos.set(bn.id, { x: cx, y: band ? bandY : bp.y });
            size.set(bn.id, { w: bw, h: band ? bandH : Math.max(28, bs.h) });
            cx += bw + gap;
          }
          if (isActionBar) {
            actionBars.push({ pid: grp.pid, x: wpagePos.x + 8, y: (band && secRole === "bottom" ? bandY : avgY) - 4, w: wpageSize.w - 16, h: 36 });
          }
          return;
        }
        // 混合组(如按钮+tab+开关):保持等分横排,控件样式区分类型
        var slotW = Math.max(36, (availW - gap * (normal.length - 1)) / normal.length);
        for (var gi = 0; gi < normal.length; gi++) {
          var gid = normal[gi].id;
          var gp = pos.get(gid), gs = size.get(gid);
          if (!gp || !gs) continue;
          pos.set(gid, { x: availX + gi * (slotW + gap), y: band ? bandY : gp.y });
          size.set(gid, { w: slotW, h: band ? bandH : gs.h });
        }
      });
    }

    // ---- 6.6) 浮层布局(弹窗/底部抽屉/右侧抽屉/下拉):页内浮层,不占普通行 ----
    // 用户口径:按键弹出窗口必须有「窗口本体」可指——从触发按钮画到浮层边框;浮层内控件再连后续页面。
    var popups = [];
    var popupHeadingIds = new Set();
    var popupTriggers = new Set();
    var popupMasks = [];
    var popupById = new Map();
    var popupMaskPage = new Set();
    function popupTriggerOf(popupId, ownerPage) {
      for (var pei = 0; pei < edges.length; pei++) {
        var pe = edges[pei];
        if (!pe || (pe.kind || "call") !== "nav") continue;
        var toPopup = pe.to === popupId;
        var toPageWithPopup = pe.to === ownerPage && /(弹出|弹窗|浮层|对话框|抽屉)/.test(txt(pe.label));
        if (!toPopup && !toPageWithPopup) continue;
        var srcN = nm.get(pe.from);
        if (!srcN || srcN.id === popupId) continue;
        if (isPage(srcN)) {
          var hit = findTrigger(srcN.id, pe.label, ownerPage, popupId);
          if (hit && hit.node) {
            var hr = rectOf(hit.node.id);
            if (hr) return { id: hit.node.id, rect: hr };
          }
        } else {
          var sr = rectOf(srcN.id);
          if (sr) return { id: srcN.id, rect: sr };
        }
      }
      return null;
    }
    function popupRowsOf(popupId) {
      var rows = [];
      var buttonTypes = { primary: 1, secondary: 1, danger: 1, text: 1, icon: 1, tab: 1 };
      var pending = [];
      function flush() {
        if (!pending.length) return;
        rows.push({ type: "buttons", nodes: pending.slice(), h: 26 });
        pending = [];
      }
      function walk(id) {
        var list = kids.get(id) || [];
        for (var wi = 0; wi < list.length; wi++) {
          var cn = nm.get(list[wi]);
          if (!cn) continue;
          if (cn.kind === "section") {
            flush();
            rows.push({ type: "heading", node: cn, h: 14 });
            walk(cn.id);
          } else if (cn.kind === "page") {
            continue;
          } else if (cn.kind === "component" || cn.kind === "function") {
            var ctl = controlOf(cn);
            if (buttonTypes[ctl]) pending.push(cn);
            else {
              flush();
              rows.push({ type: "control", node: cn, ctl: ctl, h: 26 });
            }
          } else {
            walk(cn.id);
          }
        }
      }
      walk(popupId);
      flush();
      return rows;
    }
    function popupNeedH(rows, hasSummary) {
      var sum = 0;
      for (var ri = 0; ri < rows.length; ri++) sum += rows[ri].h;
      if (rows.length > 1) sum += (rows.length - 1) * 5;
      return 26 + 6 + Math.max(rows.length ? sum : (hasSummary ? 20 : 6), 6) + 6;
    }
    function rectsOverlap(a, b) {
      return !!(a && b && a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1);
    }
    function segHitsRect(a, b, r) {
      if (Math.abs(a.y - b.y) < 0.5) {
        return a.y >= r.y - 1 && a.y <= r.y + r.h + 1 && Math.max(Math.min(a.x, b.x), r.x) < Math.min(Math.max(a.x, b.x), r.x + r.w) - 1;
      }
      if (Math.abs(a.x - b.x) < 0.5) {
        return a.x >= r.x - 1 && a.x <= r.x + r.w + 1 && Math.max(Math.min(a.y, b.y), r.y) < Math.min(Math.max(a.y, b.y), r.y + r.h) - 1;
      }
      return false;
    }
    /** 页内控件从哪一侧出页面:优先保持路由需要的方向(如目标屏在右→右侧),该侧走廊被兄弟行/浮层挡住时,
     *  改走最近的空闲页边——避免「从按钮垂直向下穿过后面的列表行/开关」的长线。 */
    function pageExitSide(nodeId, pageId, preferSide) {
      var er = rectOf(nodeId), pr = rectOf(pageId);
      if (!er || !pr) return preferSide || "bottom";
      var sibs = [];
      var pdesc = descendants(pageId);
      for (var si = 0; si < pdesc.length; si++) {
        if (pdesc[si].id === nodeId || pdesc[si].kind !== "component" || popupSubtree.has(pdesc[si].id)) continue;
        var sr = rectOf(pdesc[si].id);
        if (sr) sibs.push(sr);
      }
      for (var ppi = 0; ppi < popups.length; ppi++) {
        if (popups[ppi].pageId === pageId) sibs.push(popups[ppi].rect);
      }
      function corridorClear(side) {
        var pad = 5;
        var box;
        if (side === "right") box = { x: er.x + er.w, y: er.y + er.h / 2 - pad / 2, w: Math.max(0, pr.x + pr.w - (er.x + er.w)), h: pad };
        else if (side === "left") box = { x: pr.x, y: er.y + er.h / 2 - pad / 2, w: Math.max(0, er.x - pr.x), h: pad };
        else if (side === "bottom") box = { x: er.x + er.w / 2 - pad / 2, y: er.y + er.h, w: pad, h: Math.max(0, pr.y + pr.h - (er.y + er.h)) };
        else box = { x: er.x + er.w / 2 - pad / 2, y: pr.y, w: pad, h: Math.max(0, er.y - pr.y) };
        for (var ci = 0; ci < sibs.length; ci++) if (rectsOverlap(box, sibs[ci])) return false;
        return true;
      }
      var dist = {
        right: pr.x + pr.w - (er.x + er.w),
        left: er.x - pr.x,
        bottom: pr.y + pr.h - (er.y + er.h),
        top: er.y - pr.y,
      };
      if (preferSide && dist[preferSide] >= 1 && corridorClear(preferSide)) return preferSide;
      // 目标方向被同排兄弟挡住时,先试上下出页,不要为了近而反向横穿整页(实测「编辑快捷键」向左绕)。
      var fallback = preferSide === "right" ? ["bottom", "top", "left"]
        : preferSide === "left" ? ["bottom", "top", "right"]
        : preferSide === "top" ? ["right", "left", "bottom"]
        : ["right", "left", "top"];
      for (var fi = 0; fi < fallback.length; fi++) {
        var fs = fallback[fi];
        if (dist[fs] >= 1 && corridorClear(fs)) return fs;
      }
      var sides = ["right", "left", "bottom", "top"];
      var best = "", bestScore = 1e9;
      for (var di = 0; di < sides.length; di++) {
        var side = sides[di], d = dist[side];
        if (d < 1 || !corridorClear(side)) continue;
        var score = d + (side === "top" ? 12 : 0);
        if (score < bestScore) { bestScore = score; best = side; }
      }
      if (best) return best;
      return preferSide || "bottom";
    }
    /** 浮层内控件从哪一侧出浮层:优先选不穿过兄弟控件、且路径短的边(按钮行右侧还有兄弟时不能从右侧出)。 */
    function popupExitSide(nodeId, popupId) {
      var cr = rectOf(nodeId), pr = rectOf(popupId);
      if (!cr || !pr) return "bottom";
      var sibs = [];
      var all = descendantsOf(popupId);
      for (var si = 0; si < all.length; si++) {
        if (all[si].id === nodeId) continue;
        var sr = rectOf(all[si].id);
        if (sr) sibs.push(sr);
      }
      function corridorClear(side) {
        var pad = 5;
        var box;
        if (side === "right") box = { x: cr.x + cr.w, y: cr.y + cr.h / 2 - pad / 2, w: Math.max(0, pr.x + pr.w - (cr.x + cr.w)), h: pad };
        else if (side === "left") box = { x: pr.x, y: cr.y + cr.h / 2 - pad / 2, w: Math.max(0, cr.x - pr.x), h: pad };
        else if (side === "bottom") box = { x: cr.x + cr.w / 2 - pad / 2, y: cr.y + cr.h, w: pad, h: Math.max(0, pr.y + pr.h - (cr.y + cr.h)) };
        else box = { x: cr.x + cr.w / 2 - pad / 2, y: pr.y, w: pad, h: Math.max(0, cr.y - pr.y) };
        for (var ci = 0; ci < sibs.length; ci++) if (rectsOverlap(box, sibs[ci])) return false;
        return true;
      }
      var dist = {
        right: pr.x + pr.w - (cr.x + cr.w),
        left: cr.x - pr.x,
        top: cr.y - pr.y,
        bottom: pr.y + pr.h - (cr.y + cr.h),
      };
      var best = "", bestScore = 1e9;
      var sides = ["bottom", "right", "left", "top"];
      for (var di = 0; di < sides.length; di++) {
        var side = sides[di], d = dist[side];
        if (d < 1) continue;
        if (side === "top" && d < 34) continue; // 顶部穿标题条不当作出口
        if (!corridorClear(side)) continue;
        var score = d + (side === "top" ? 12 : side === "right" || side === "left" ? 2 : 0);
        if (score < bestScore) { bestScore = score; best = side; }
      }
      if (best) return best;
      // 全被兄弟挡住时,退到距离最大的边(至少不会原地打转)。
      var fallback = "bottom", far = -1;
      for (var fi = 0; fi < sides.length; fi++) if (dist[sides[fi]] > far) { far = dist[sides[fi]]; fallback = sides[fi]; }
      return fallback;
    }
    function layoutPopup(popupId) {
      var pnode = nm.get(popupId);
      var owner = pageOfNode(popupId);
      if (!pnode || !owner) return;
      var pr = pos.get(owner), ps = size.get(owner);
      if (!pr || !ps) return;
      var ptop = pr.y + 34 + 2;
      var pbottom = pr.y + ps.h - (mobileBoard ? TAB_H : 0) - 6;
      var contentH = Math.max(70, pbottom - ptop);
      var rows = popupRowsOf(popupId);
      var needH = popupNeedH(rows, !!txt(pnode.summary));
      var mode = popupModeOf(pnode);
      var popupTrig = popupTriggerOf(popupId, owner);
      if (popupTrig) popupTriggers.add(popupTrig.id);
      var maxH = mode === "popover" ? Math.min(contentH * 0.72, 260) : contentH - 6;
      var panelW = Math.max(150, Math.min(ps.w - 16,
        mode === "bottom" ? ps.w - 20 :
        mode === "left" || mode === "right" ? Math.max(200, ps.w * (mobileBoard ? 0.78 : 0.66)) :
        mode === "popover" ? Math.max(170, ps.w * 0.72) :
        Math.max(180, ps.w * (mobileBoard ? 0.82 : 0.7))));
      var panelH = Math.max(66, Math.min(maxH, needH));
      var x, y;
      if (mode === "bottom") {
        x = pr.x + 10; y = pbottom - panelH - 4;
      } else if (mode === "right") {
        x = pr.x + ps.w - panelW - 6; y = ptop + 2; panelH = maxH;
      } else if (mode === "left") {
        x = pr.x + 6; y = ptop + 2; panelH = maxH;
      } else {
        var trg = popupTrig;
        if (mode === "popover" && trg) {
          var below = trg.rect.y + trg.rect.h + 6;
          var above = trg.rect.y - panelH - 6;
          if (below + panelH <= pbottom) {
            x = trg.rect.x; y = below;
          } else if (above >= ptop + 4) {
            x = trg.rect.x; y = above;
          } else {
            // 下拉在页底时先试左右贴边(不盖触发按钮),都放不下再压高度向上弹。
            var sideRight = pr.x + ps.w - (trg.rect.x + trg.rect.w) - 8;
            var sideLeft = trg.rect.x - pr.x - 8;
            if (sideRight >= panelW) {
              x = trg.rect.x + trg.rect.w + 8;
              y = trg.rect.y + trg.rect.h / 2 - panelH / 2;
            } else if (sideLeft >= panelW) {
              x = trg.rect.x - panelW - 8;
              y = trg.rect.y + trg.rect.h / 2 - panelH / 2;
            } else {
              panelH = Math.max(56, Math.min(panelH, trg.rect.y - 6 - (ptop + 4)));
              x = trg.rect.x;
              y = trg.rect.y - panelH - 6;
            }
          }
        } else {
          x = pr.x + (ps.w - panelW) / 2;
          y = ptop + (contentH - panelH) / 2;
        }
        x = Math.max(pr.x + 8, Math.min(pr.x + ps.w - panelW - 8, x));
        y = Math.max(ptop + 4, Math.min(pbottom - panelH - 4, y));
        // 居中弹窗尽量不盖住触发按钮:触发在上半屏时浮层下移,反之向上,保证「按钮→窗口」两截都看得见。
        var prect = { x: x, y: y, w: panelW, h: panelH };
        if (trg && rectsOverlap(prect, trg.rect)) {
          var lowY = pbottom - panelH - 4, highY = ptop + 4;
          var trMid = trg.rect.y + trg.rect.h / 2;
          y = trMid < ptop + contentH / 2 ? lowY : highY;
          y = Math.max(ptop + 4, Math.min(pbottom - panelH - 4, y));
          var moved = { x: x, y: y, w: panelW, h: panelH };
          if (rectsOverlap(moved, trg.rect)) {
            // 浮层太高,上下都盖住触发按钮:压到触发按钮上/下可用空间里,保证「按钮→窗口」起点可见。
            var aboveSpace = trg.rect.y - 6 - (ptop + 4);
            var belowSpace = (pbottom - 4) - (trg.rect.y + trg.rect.h + 6);
            panelH = Math.max(48, Math.min(panelH, Math.max(aboveSpace, belowSpace)));
            y = aboveSpace >= belowSpace ? trg.rect.y - panelH - 6 : trg.rect.y + trg.rect.h + 6;
            y = Math.max(ptop + 4, Math.min(pbottom - panelH - 4, y));
          }
        }
      }
      x = Math.max(pr.x + 6, x);
      y = Math.max(ptop + 2, y);
      if (x + panelW > pr.x + ps.w - 4) x = pr.x + ps.w - panelW - 4;
      if (y + panelH > pbottom - 2) y = pbottom - panelH - 2;
      pos.set(popupId, { x: x, y: y });
      size.set(popupId, { w: panelW, h: panelH });
      // 浮层内控件统一排成竖向行:字段占满宽,连续按钮合成一行右对齐;嵌套 section 只留小标题。
      var bodyX = x + 7, bodyW = Math.max(40, panelW - 14);
      var bodyTop = y + 26 + 6, bodyBottom = y + panelH - 6;
      var avail = Math.max(10, bodyBottom - bodyTop);
      var gap = 5;
      var totalH = 0;
      for (var rt = 0; rt < rows.length; rt++) totalH += rows[rt].h;
      if (rows.length > 1) totalH += (rows.length - 1) * gap;
      var scale = totalH > avail ? avail / totalH : 1;
      if (scale < 1) gap = Math.max(2, Math.round(gap * scale));
      var cy = bodyTop;
      for (var rr = 0; rr < rows.length; rr++) {
        var row = rows[rr];
        var rh = Math.max(12, Math.round(row.h * scale));
        if (row.type === "heading") {
          var hd = row.node;
          pos.set(hd.id, { x: bodyX, y: cy });
          size.set(hd.id, { w: bodyW, h: rh });
          popupHeadingIds.add(hd.id);
        } else if (row.type === "control") {
          pos.set(row.node.id, { x: bodyX, y: cy });
          size.set(row.node.id, { w: bodyW, h: rh });
        } else {
          var widths = [], sumW = 0;
          for (var bw = 0; bw < row.nodes.length; bw++) {
            // 中文按钮/Tab 按 11px/字留宽,避免「最近7天页签」被浮层右边裁成「最近7天页」。
            var w0 = Math.max(64, Math.min(170, txt(row.nodes[bw].label).length * 11 + 20));
            widths.push(w0); sumW += w0 + (bw ? gap : 0);
          }
          if (sumW > bodyW) {
            var sw = Math.max(36, (bodyW - gap * (row.nodes.length - 1)) / row.nodes.length);
            widths = row.nodes.map(function () { return sw; });
          }
          var bx = bodyX + bodyW;
          for (var bw2 = widths.length - 1; bw2 >= 0; bw2--) {
            var bn = row.nodes[bw2];
            bx -= widths[bw2];
            pos.set(bn.id, { x: bx, y: cy });
            size.set(bn.id, { w: widths[bw2], h: rh });
            bx -= gap;
          }
        }
        cy += rh + gap;
      }
      var ownerName = nm.get(owner) ? shortTitle(nm.get(owner)) : "";
      var pm = {
        id: popupId, pageId: owner, pageName: ownerName, mode: mode,
        rect: { x: x, y: y, w: panelW, h: panelH },
        title: shortTitle(pnode), summary: txt(pnode.summary),
        rows: rows.length, kids: popupKids.get(popupId) || 0,
        triggerId: popupTrig ? popupTrig.id : "",
      };
      popups.push(pm);
      popupById.set(popupId, pm);
      if (!popupMaskPage.has(owner)) {
        popupMaskPage.add(owner);
        popupMasks.push({ pageId: owner, x: pr.x + 2, y: pr.y + 34, w: ps.w - 4, h: Math.max(20, ps.h - 34 - (mobileBoard ? TAB_H : 0) - 2) });
      }
    }
    popupIds.forEach(function (pid) { layoutPopup(pid); });
    // 被浮层窗口几何覆盖的页内控件:它们当前不可交互,流线不再从它上面起笔(否则会穿过浮层/兄弟行),
    // 主线仍从页边到目标,浮层内的触发按钮和浮层子控件不受影响。
    var popupCovered = new Set();
    for (var pcv = 0; pcv < popups.length; pcv++) {
      var pv = popups[pcv];
      for (var pcn = 0; pcn < nodes.length; pcn++) {
        var cvn = nodes[pcn];
        if (popupSubtree.has(cvn.id) || popupTriggers.has(cvn.id)) continue;
        if (pageOf.get(cvn.id) !== pv.pageId) continue;
        var cvr = rectOf(cvn.id);
        if (!cvr) continue;
        var ccx = cvr.x + cvr.w / 2, ccy = cvr.y + cvr.h / 2;
        if (ccx >= pv.rect.x && ccx <= pv.rect.x + pv.rect.w && ccy >= pv.rect.y && ccy <= pv.rect.y + pv.rect.h) {
          popupCovered.add(cvn.id);
        }
      }
    }

    // ---- 7) 辅助带(nav / 逻辑 / 未归属):底部独立行,不和屏幕混排 ----
    var auxNodes = [];
    for (var a0 = 0; a0 < nodes.length; a0++) {
      var an = nodes[a0];
      if (isPage(an)) continue;
      if (pageOf.has(an.id)) continue; // 页内元素
      auxNodes.push(an);
    }
    var auxY = rowY[rows - 1] + CAPTION_H + rowHeights[rows - 1] + AUX_GAP;
    var auxLane = null;
    var auxPerRow = 0;
    if (auxNodes.length) {
      auxPerRow = Math.max(1, Math.floor((worldW - MARGIN_X * 2 + AUX_X_GAP) / (AUX_W + AUX_X_GAP)));
      var auxRows = Math.ceil(auxNodes.length / auxPerRow);
      auxLane = { x: MARGIN_X, y: auxY - 24, w: worldW - MARGIN_X * 2, h: 24 + auxRows * (AUX_H + AUX_Y_GAP), title: "交互逻辑 / 未归属(不在屏幕内)" };
      for (var a1 = 0; a1 < auxNodes.length; a1++) {
        var ax = MARGIN_X + (a1 % auxPerRow) * (AUX_W + AUX_X_GAP);
        var ay = auxY + Math.floor(a1 / auxPerRow) * (AUX_H + AUX_Y_GAP);
        pos.set(auxNodes[a1].id, { x: ax, y: ay });
        size.set(auxNodes[a1].id, { w: AUX_W, h: AUX_H });
      }
    }

    // ---- 9) 本地拖动微调(先只处理页/元素;页面拖动带动子孙) ----
    var moved = opts && opts.moved;
    function movedOf(id) {
      if (!moved) return null;
      var p = moved instanceof Map ? moved.get(id) : moved[id];
      return p && isFinite(p.x) && isFinite(p.y) ? p : null;
    }
    for (var q6 = 0; q6 < pageList.length; q6++) {
      var pidm = pageList[q6];
      var mp = movedOf(pidm);
      if (!mp) continue;
      var op = pos.get(pidm);
      if (!op) continue;
      var mdx = mp.x - op.x, mdy = mp.y - op.y;
      pos.set(pidm, { x: mp.x, y: mp.y });
      var mdesc = descendants(pidm);
      for (var md = 0; md < mdesc.length; md++) {
        var mdId = mdesc[md].id;
        var selfMoved = movedOf(mdId);
        if (selfMoved) { pos.set(mdId, { x: selfMoved.x, y: selfMoved.y }); continue; }
        var mdp = pos.get(mdId);
        if (mdp) pos.set(mdId, { x: mdp.x + mdx, y: mdp.y + mdy });
      }
    }
    for (var a2 = 0; a2 < auxNodes.length; a2++) {
      var mpa = movedOf(auxNodes[a2].id);
      if (mpa) pos.set(auxNodes[a2].id, { x: mpa.x, y: mpa.y });
    }
    // 页框位置变化后同步 containers/pageMeta(流线路由用)
    for (var q7 = 0; q7 < pageList.length; q7++) {
      var pidf = pageList[q7];
      var pf = pos.get(pidf);
      var sf = size.get(pidf);
      containers.set(pidf, { x: pf.x, y: pf.y, w: sf.w, h: sf.h });
      var pmf = pageMeta.get(pidf);
      pmf.x = pf.x; pmf.y = pf.y; pmf.caption.x = pf.x; pmf.caption.y = pf.y - CAPTION_H + 6;
    }

    // ---- 10) 交互边解析:页/元素统一到真实锚点 ----
    var pageMetaById = new Map();
    pageMeta.forEach(function (pm) { pageMetaById.set(pm.id, pm); });
    function rectOf(id) {
      var p = pos.get(id), s = size.get(id);
      return p && s ? { x: p.x, y: p.y, w: s.w, h: s.h, id: id } : null;
    }
    function isInteractiveElement(n) {
      return /(按钮|提交|确认|保存|添加|申请|发送|登录|授权|继续|返回|查看|入口|卡片|列表项|开关|选择|切换)/.test(txt(n && n.label) + " " + txt(n && n.summary));
    }
    function controlOf(n) {
      if (!n) return "row";
      if (n.kind === "page") return "page";
      if (n.kind === "section") return "section";
      var label = txt(n.label), sum = txt(n.summary), t = label + " " + sum;
      if (/(悬浮|浮动|\bfab\b)/i.test(t)) return "fab";
      if (/(页签|tab|分段|切换)/i.test(label)) return "tab";
      if (/(开关|toggle|已开启|已关闭|启用|停用)/i.test(t)) return "toggle";
      // 类型以 label 为主:summary 里的「字段/输入」是行为描述,不应把「提交申请按钮」误判成输入框
      if (/(输入|搜索|文本框|字段|手机号|邮箱|名称|网址|url|密钥|地址|金额|备注|数字键盘)/i.test(label) && !/按钮/.test(label)) return "input";
      if (/(下拉|选择器|筛选器|筛选|选择)/.test(label) && !/切换/.test(label)) return "select";
      if (/(勾选|复选框|同意|协议)/.test(label)) return "checkbox";
      if (/(单选|选项)/.test(label)) return "radio";
      if (/(删除|移除|清空|拒签|解绑|注销|危险)/.test(label)) return "danger";
      if (/(菜单项|导航项)/.test(label)) return "text";
      if (/(图标|icon|更多|菜单|关闭|搜索|刷新|复制|分享|收藏|心形|铃铛|头像|通知|品牌|logo)/i.test(label) && !/按钮组/.test(label)) return "icon";
      if (/(卡片|列表项|记录|订单|通知|消息)/.test(label) && !/按钮/.test(label)) return "card";
      if (/(查看.*进度|查看详情进度)/.test(label)) return "primary";
      if (/(主按钮|新建|新增|提交|确认|保存|申请|发送|登录|授权|继续|添加|创建|开始|下一步|导入|支付|购买|打开|检查)/.test(label)) return "primary";
      if (/(取消|返回|关闭|编辑|查看|重置|恢复|次要|跳过|详情|草稿|测试|上一页|下一页|导出|上传)/.test(label)) return "secondary";
      if (/(链接|了解更多|查看全部|文字|菜单项|导航项|品牌|logo)/i.test(label)) return "text";
      return "row";
    }
    function sectionTypeOf(n, role) {
      var t = txt(n && n.label) + " " + txt(n && n.summary);
      if (role === "overlay") return "dialog";
      if (role === "top") return "header";
      if (role === "bottom") return "footer";
      if (role === "side") return "sidebar";
      if (/(工具栏|操作栏|批量|筛选器)/.test(t)) return "toolbar";
      if (/(表单|输入|填写|名单|元信息)/.test(t)) return "form";
      if (/(表格|列表|记录|订单|卡片)/.test(t)) return "list";
      return "content";
    }
    function isButtonLabel(n) {
      return /(按钮|提交|确认|保存|添加|申请|发送|登录|授权|继续|查看)/.test(txt(n && n.label));
    }
    function isPrimaryActionLabel(n) {
      return /(申请|提交|确认|保存|继续|登录|授权|添加|发送|创建|开始|下一步)/.test(txt(n && n.label));
    }
    function relYOf(pid, nid) {
      var pr = rectOf(pid), nr = rectOf(nid);
      return pr && nr && pr.h > 0 ? (nr.y + nr.h / 2 - pr.y) / pr.h : 0;
    }
    function pickPrimary(pid, mode) {
      var cands = descendants(pid);
      var pool = cands.filter(function (n) { return isComponent(n); });
      if (!pool.length) pool = cands.filter(function (n) { return isSection(n); });
      var best = null, bestScore = -1;
      for (var i = 0; i < pool.length; i++) {
        var n = pool[i];
        var s = 0;
        if (isComponent(n)) s += 6;
        if (isInteractiveElement(n)) s += 3;
        if (isButtonLabel(n)) s += 5;
        if (isPrimaryActionLabel(n)) s += 4;
        if (mode === "target" && relYOf(pid, n.id) > 0.55) s += 1;
        if (s > bestScore) { bestScore = s; best = n; }
      }
      return best;
    }
    function findTrigger(pid, edgeLabel, targetPageId, targetNodeId) {
      var cands = descendants(pid);
      var targetNode = nm.get(targetPageId);
      var targetCore = targetNode ? pageCore(targetNode.label) : "";
      var qs = quoted(edgeLabel);
      var best = null, bestScore = 0;
      var order = new Map();
      for (var oi = 0; oi < cands.length; oi++) order.set(cands[oi].id, oi);
      function underTarget(id) {
        if (!targetNodeId) return false;
        var cur = id, guard = 0;
        while (cur && guard++ < 30) {
          if (cur === targetNodeId) return true;
          cur = parentOf.get(cur);
        }
        return false;
      }
      for (var ci = 0; ci < cands.length; ci++) {
        var n = cands[ci];
        if (!isSection(n) && !isComponent(n)) continue;
        // 目标本身就是浮层/组件时,不能把目标(或其子控件)反推成触发源——会画成浮层自环线。
        if (underTarget(n.id)) continue;
        var label = txt(n.label), sum = txt(n.summary), hay = label + " " + sum;
        var score = 0;
        if (label.length >= 2 && txt(edgeLabel).indexOf(label) >= 0) score += 14;
        for (var qi = 0; qi < qs.length; qi++) {
          if (qs[qi].length >= 2 && (label.indexOf(qs[qi]) >= 0 || qs[qi].indexOf(label) >= 0)) score += 10;
        }
        if (targetCore.length >= 2 && hay.indexOf(targetCore) >= 0) score += 6;
        score += Math.min(8, lcsLen(edgeLabel, label) * 2);
        score += Math.min(4, lcsLen(edgeLabel, sum));
        if (/(点击|点|选择|切换|提交|打开|进入|返回)/.test(txt(edgeLabel)) && /(点击|点|选择|切换|提交|打开|进入|返回|按钮|入口|卡片|开关)/.test(hay)) score += 1;
        if (isInteractiveElement(n)) score += 3;
        if (isButtonLabel(n)) score += 2;
        if (isComponent(n)) score += 4;
        score += Math.min(3, depthOf.get(n.id) || 0);
        if (isOverlay(n) && isOverlay(targetNode)) score += 5;
        else if (isOverlay(n) && !isOverlay(targetNode)) score -= 4;
        if (score > bestScore || (score === bestScore && score > 0 && best && (order.get(n.id) < order.get(best.id)))) {
          bestScore = score; best = n;
        }
      }
      if (bestScore >= 4) return { node: best, inferred: bestScore < 8 };
      // 旧板触发 label 与元素名对不上:落到该屏最有代表性的交互控件,并标「推断」;
      // 没有控件才退回屏级(不画大框边界箭头是硬要求)。
      var primary = pickPrimary(pid, "source");
      return primary ? { node: primary, inferred: true } : null;
    }
    function resolveEnd(id, isSource, edge, targetPageIdHint) {
      var n = nm.get(id);
      if (!n) return null;
      var pid = pageOfNode(id);
      var isPageNode = isPage(n);
      var r = rectOf(id);
      if (!r) return null;
      if (isSource && isPageNode) {
        var targetNodeHint = !isPage(nm.get(edge.to)) ? edge.to : "";
        var hit = findTrigger(id, edge.label, targetPageIdHint, targetNodeHint);
        if (hit && hit.node) {
          var hr = rectOf(hit.node.id);
          if (hr) return { id: hit.node.id, node: hit.node, pageId: id, rect: hr, element: true, isPage: false, logic: false, inferred: !!hit.inferred };
        }
      }
      // 目标为浮层节点(或 page 目标但 label 写「弹出：XX」):箭头落到浮层边框,不猜浮层里的某个按钮
      if (!isSource && popupOf.has(id)) {
        var opid = popupOf.get(id);
        var opn = nm.get(opid), opr = rectOf(opid);
        if (opn && opr) return { id: opid, node: opn, pageId: pid, rect: opr, element: false, isPage: false, logic: false, inferred: false, popup: true, popupId: opid };
      }
      if (!isSource && popupIds.has(id)) {
        return { id: id, node: n, pageId: pid, rect: r, element: false, isPage: false, logic: false, inferred: false, popup: true, popupId: id };
      }
      if (!isSource && isPageNode) {
        if (/(弹出|弹窗|浮层|对话框|抽屉)/.test(txt(edge.label))) {
          var popId = popupOnPage(id, edge.label);
          if (popId) {
            var popN = nm.get(popId), popR = rectOf(popId);
            if (popN && popR) return { id: popId, node: popN, pageId: id, rect: popR, element: false, isPage: false, logic: false, inferred: false, popup: true, popupId: popId };
          }
        }
        // 2026-10-26 用户口径:跳转到新页面的箭头只需指向新页面的大框,不再推断目标页里的按钮。
        return { id: id, node: n, pageId: id, rect: r, element: false, isPage: true, logic: false, inferred: false, pageFrame: true };
      }
      return { id: id, node: n, pageId: pid, rect: r, element: !isPageNode && !!pid, isPage: isPageNode, logic: !pid, inferred: false, fallbackPage: isPageNode };
    }

    var flows = [];
    for (var e3 = 0; e3 < edges.length; e3++) {
      var ed = edges[e3];
      var ek = ed.kind || "call";
      if (ek === "contains" || ek === "verify") continue;
      if (txt(ed.label) === "同组次序") continue;
      if (tabEdges.indexOf(e3) >= 0) continue; // tab 已由屏底导航条表达,不再画跨屏线
      var fromPageHint = isPage(nm.get(ed.to)) ? ed.to : pageOfNode(ed.to);
      var src = resolveEnd(ed.from, true, ed, fromPageHint);
      var dst = resolveEnd(ed.to, false, ed, null);
      if (!src || !dst) continue;
      // 纯 UI 板:只画 nav;ui-func 的 call/data 只在涉及逻辑节点时画(作为交互逻辑流)
      var involvesAux = src.logic || dst.logic;
      if (ek !== "nav" && !involvesAux) continue;
      if (ek === "nav" && !src.logic && !dst.logic && !src.pageId && !dst.pageId) continue;
      var sp = src.pageId, tp = dst.pageId;
      var back = false;
      if (sp && tp) {
        // 不用 base.backEdges:base 为破环会把它断的边记成回边(实测把「提交成功→结果页」误标回边),
        // 交互地图按自己的前向图层级 + 语义标签判回边。
        if (isBackLabel(ed.label)) back = true;
        var lsp = levelMap.get(sp) || 0;
        var ltp = levelMap.get(tp) || 0;
        if (ltp < lsp) back = true;
      }
      var dstPopup = !!(dst.popup || (tp && !dst.isPage && isOverlay(nm.get(tp))));
      var kind = "jump";
      if (involvesAux) kind = "logic";
      else if (dstPopup) kind = "popup";
      else if (sp && tp && sp === tp) kind = "inner";
      else if (back) kind = "back";
      var groupKey, groupLabel, targetPageNode = tp ? nm.get(tp) : null;
      if (kind === "back") groupKey = "back";
      else if (kind === "logic") groupKey = "logic";
      else if (kind === "inner") groupKey = "inner:" + sp;
      else if (kind === "popup") groupKey = "popup:" + (dst.popupId || dst.id || tp);
      else groupKey = "jump:" + tp;
      if (kind === "back") groupLabel = "返回 / 关闭";
      else if (kind === "logic") groupLabel = "交互逻辑";
      else if (kind === "inner") groupLabel = "页内交互：" + (sp ? shortTitle(nm.get(sp)) : "同屏");
      else if (kind === "popup") groupLabel = "弹出：" + shortTitle(dstPopup ? dst.node : targetPageNode);
      else groupLabel = "跳转：" + shortTitle(targetPageNode);
      var main = false;
      if (sp && tp && !dstPopup && mainPairSet.has(sp + ">" + tp)) main = true;
      flows.push({
        idx: e3, from: ed.from, to: ed.to, edgeKind: ek, label: txt(ed.label) || "交互",
        kind: kind, groupKey: groupKey, groupLabel: groupLabel, main: main,
        source: src, target: dst, sourcePage: sp, targetPage: tp,
        path: "", leaderFrom: "", leaderTo: "",
        dotFrom: null, dotTo: null, startPoint: null, endPoint: null, startBoundary: null, endBoundary: null,
        startPageBoundary: null, startPopupBoundary: null, targetPageBoundary: null, startSide: "", endSide: "",
        labelText: "", labelX: 0, labelY: 0,
        labelAnchor: "middle", colorIndex: -1, color: "", fill: "", textColor: "", dash: "",
      });
    }

    // ---- 11) 分组/配色:小图按目标屏分色(参考形态);>8 组自动退化为按交互类型分色,
    // 避免 20+ 屏板的图例/色板失控(线标签仍写每个目标屏)。
    var rawGroupKeys = new Set();
    for (var rg = 0; rg < flows.length; rg++) rawGroupKeys.add(flows[rg].groupKey);
    if (rawGroupKeys.size > 8) {
      for (var rk = 0; rk < flows.length; rk++) {
        var rkf = flows[rk];
        if (rkf.kind === "jump") { rkf.groupKey = "kind:jump"; rkf.groupLabel = "跳转"; }
        else if (rkf.kind === "popup") { rkf.groupKey = "kind:popup"; rkf.groupLabel = "弹出"; }
        else if (rkf.kind === "inner") { rkf.groupKey = "kind:inner"; rkf.groupLabel = "页内交互"; }
        else if (rkf.kind === "back") { rkf.groupKey = "back"; rkf.groupLabel = "返回 / 关闭"; }
        else { rkf.groupKey = "logic"; rkf.groupLabel = "交互逻辑"; }
      }
    }
    var groups = [];
    var groupMap = new Map();
    for (var f0 = 0; f0 < flows.length; f0++) {
      var f = flows[f0];
      if (!groupMap.has(f.groupKey)) {
        var g = { key: f.groupKey, label: f.groupLabel, kind: f.kind === "jump" || f.kind === "popup" ? f.kind : f.kind, colorIndex: -1, count: 0, color: "", fill: "", textColor: "", dash: "" };
        groupMap.set(f.groupKey, g);
        groups.push(g);
      }
      groupMap.get(f.groupKey).count++;
    }
    var pageOrder = new Map();
    for (var po = 0; po < pageList.length; po++) pageOrder.set(pageList[po], po);
    groups.sort(function (a, b) {
      function rank(g) {
        if (g.kind === "jump" || g.kind === "popup") {
          var t = g.key.indexOf(":") >= 0 ? g.key.slice(g.key.indexOf(":") + 1) : "";
          return 10 + (pageOrder.get(t) || 0);
        }
        if (g.kind === "inner") return 60;
        if (g.kind === "back") return 70;
        if (g.kind === "logic") return 80;
        return 90;
      }
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.key < b.key ? -1 : 1;
    });
    var colorSeq = 0;
    for (var g0 = 0; g0 < groups.length; g0++) {
      var gg = groups[g0];
      if (gg.kind === "back") { gg.colorIndex = -1; gg.color = BACK.line; gg.fill = BACK.fill; gg.textColor = BACK.text; gg.dash = "6 4"; }
      else if (gg.kind === "logic") { gg.colorIndex = -2; gg.color = LOGIC.line; gg.fill = LOGIC.fill; gg.textColor = LOGIC.text; gg.dash = "6 4"; }
      else if (gg.kind === "aux") { gg.colorIndex = -3; gg.color = AUX.line; gg.fill = AUX.fill; gg.textColor = AUX.text; gg.dash = "6 4"; }
      else {
        gg.colorIndex = colorSeq % PALETTE.length;
        var pal = PALETTE[gg.colorIndex];
        gg.color = pal.line; gg.fill = pal.fill; gg.textColor = pal.text; gg.dash = gg.kind === "popup" ? "2 3" : "";
        colorSeq++;
      }
    }
    for (var f1 = 0; f1 < flows.length; f1++) {
      var fg = flows[f1];
      var grp = groupMap.get(fg.groupKey);
      fg.colorIndex = grp.colorIndex;
      fg.color = grp.color; fg.fill = grp.fill; fg.textColor = grp.textColor;
      fg.dash = grp.kind === "popup" ? "2 3" : lineDash(fg.kind);
      fg.marker = markerOf(grp.kind === "jump" || grp.kind === "popup" ? "jump" : grp.kind, grp.colorIndex);
    }

    // ---- 12) 正交路由 ----
    var rowChannelY = [];
    function channelBelow(r) {
      var rr = Math.max(0, Math.min(rows - 1, r));
      return frameY[rr] + rowHeights[rr] + ROW_GAP / 2;
    }
    function channelAbove(r) {
      return rowY[Math.max(0, r)] - 22;
    }
    var laneRight = worldW - MARGIN_X / 2;
    var laneLeft = MARGIN_X / 2;
    var tracks = {};
    function trackFor(key) {
      var n = tracks[key] || 0;
      tracks[key] = n + 1;
      return ((n % 5) - 2) * 9;
    }
    function portOf(rect, side) {
      if (side === "right") return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
      if (side === "left") return { x: rect.x, y: rect.y + rect.h / 2 };
      if (side === "top") return { x: rect.x + rect.w / 2, y: rect.y };
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    }
    function pageOfRect(rect) {
      // rect.id 是元素 id 时找所属页
      var pid = pageOf.get(rect.id) || (pageSet.has(rect.id) ? rect.id : null);
      return pid ? pageMetaById.get(pid) : null;
    }
    function simplify(pts) {
      var out = [];
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
        var last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
        out.push({ x: p.x, y: p.y });
      }
      var changed = true;
      while (changed && out.length >= 3) {
        changed = false;
        for (var j = 1; j < out.length - 1; j++) {
          var a = out[j - 1], b = out[j], c = out[j + 1];
          if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
              (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) {
            out.splice(j, 1); changed = true; break;
          }
        }
      }
      return out;
    }
    function pathOf(pts) {
      if (!pts || !pts.length) return "";
      var d = "M " + Math.round(pts[0].x * 10) / 10 + " " + Math.round(pts[0].y * 10) / 10;
      for (var i = 1; i < pts.length; i++) d += " L " + Math.round(pts[i].x * 10) / 10 + " " + Math.round(pts[i].y * 10) / 10;
      return d;
    }
    function labelOf(pts, text) {
      var best = null, bestLen = -1;
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1], b = pts[i];
        var dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        var len = Math.max(dx, dy);
        if (len > bestLen) { bestLen = len; best = { a: a, b: b, horizon: dx >= dy }; }
      }
      if (!best) return { x: pts[0].x, y: pts[0].y, anchor: "middle" };
      var mx = (best.a.x + best.b.x) / 2, my = (best.a.y + best.b.y) / 2;
      var tx = txt(text);
      if (tx.length > 26) tx = tx.slice(0, 25) + "…";
      var w = Math.min(210, Math.max(42, tx.length * 6.6 + 14));
      if (best.horizon) return { x: mx, y: my - 11, anchor: "middle", w: w, text: tx };
      return { x: mx + 10, y: my, anchor: "start", w: w, text: tx };
    }
    function leaderPointOnPage(elRect, pageRect, side) {
      var ep = portOf(elRect, side);
      if (side === "right") return { x: pageRect.x + pageRect.w, y: ep.y };
      if (side === "left") return { x: pageRect.x, y: ep.y };
      if (side === "top") return { x: ep.x, y: pageRect.y };
      return { x: ep.x, y: pageRect.y + pageRect.h };
    }
    function leaderFromElement(elRect, pageRect, side) {
      var ep = portOf(elRect, side);
      var pp = leaderPointOnPage(elRect, pageRect, side);
      return { path: pathOf(simplify([{ x: ep.x, y: ep.y }, { x: pp.x, y: pp.y }])), dot: ep, pagePoint: pp };
    }
    function leaderToElement(pageRect, elRect, side) {
      var pp = leaderPointOnPage(elRect, pageRect, side);
      var ep = portOf(elRect, side);
      return { path: pathOf(simplify([{ x: pp.x, y: pp.y }, { x: ep.x, y: ep.y }])), dot: ep, pagePoint: pp };
    }
    function routeDirect(a, b, sSide, tSide, f) {
      var sp = portOf(a, sSide), tp = portOf(b, tSide);
      var midX = (sp.x + tp.x) / 2;
      var pts = sSide === "right" || sSide === "left"
        ? [{ x: sp.x, y: sp.y }, { x: midX, y: sp.y }, { x: midX, y: tp.y }, { x: tp.x, y: tp.y }]
        : [{ x: sp.x, y: sp.y }, { x: sp.x, y: (sp.y + tp.y) / 2 }, { x: tp.x, y: (sp.y + tp.y) / 2 }, { x: tp.x, y: tp.y }];
      return { start: sp, end: tp, pts: simplify(pts) };
    }
    function routeGrid(f, sp, tp, sSide, tSide) {
      var srcMeta = f.sourcePage ? pageMetaById.get(f.sourcePage) : null;
      var dstMeta = f.targetPage ? pageMetaById.get(f.targetPage) : null;
      var start = portOf(sp, sSide), end = portOf(tp, tSide);
      var pts = [{ x: start.x, y: start.y }];
      var srcRow = srcMeta ? srcMeta.row : 0;
      var dstRow = dstMeta ? dstMeta.row : srcRow;
      var track = 0;
      if (srcMeta && dstMeta) {
        var sameRow = srcRow === dstRow;
        var forwardRight = !sameRow || (dstMeta.x + dstMeta.w / 2) >= (srcMeta.x + srcMeta.w / 2);
        var adjacent = Math.abs(srcMeta.col - dstMeta.col) === 1 && sameRow;
        if (sameRow && adjacent && forwardRight && sSide === "right" && tSide === "left" && f.kind !== "back" && f.kind !== "inner") {
          var midX = (start.x + end.x) / 2 + trackFor("gap:" + Math.min(srcMeta.col, dstMeta.col));
          pts.push({ x: midX, y: start.y });
          pts.push({ x: midX, y: end.y });
          pts.push({ x: end.x, y: end.y });
          return { start: start, end: end, pts: simplify(pts) };
        }
        if (sameRow) {
          // 同排非相邻 / 同排回边:走本行下方通道
          var cb = channelBelow(srcRow) + trackFor("cb:" + srcRow);
          pts.push({ x: start.x, y: cb });
          pts.push({ x: end.x, y: cb });
          pts.push({ x: end.x, y: end.y });
          return { start: start, end: end, pts: simplify(pts) };
        }
        if (f.kind === "back" && dstRow < srcRow) {
          // 回边跨排:统一走右侧车道(不按左右交替——多条回边会围成一整个虚线框,像泳道/遮挡图)。
          var cb3 = channelBelow(srcRow) + trackFor("cb:" + srcRow);
          var lane = laneRight + trackFor("lr");
          var cbt = channelBelow(dstRow) + trackFor("cb:" + dstRow);
          pts.push({ x: start.x, y: cb3 });
          pts.push({ x: lane, y: cb3 });
          pts.push({ x: lane, y: cbt });
          pts.push({ x: end.x, y: cbt });
          pts.push({ x: end.x, y: end.y });
          return { start: start, end: end, pts: simplify(pts) };
        }
        if (!sameRow && dstRow === srcRow + 1) {
          // 相邻下一排:行间通道 → 目标屏侧方车道(不从顶部进,避免竖线穿过屏外字幕带)
          var cbn = channelBelow(srcRow) + trackFor("cb:" + srcRow);
          var laneX1 = tSide === "right" ? dstMeta.x + dstMeta.w + 18 : dstMeta.x - 18;
          pts.push({ x: start.x, y: cbn });
          pts.push({ x: laneX1, y: cbn });
          pts.push({ x: laneX1, y: end.y });
          pts.push({ x: end.x, y: end.y });
          return { start: start, end: end, pts: simplify(pts) };
        }
        if (!sameRow && dstRow > srcRow) {
          // 跨多排:本行下方 → 右侧车道 → 目标排上方 → 目标屏侧方车道(全程走行/列间空隙)
          var cb2 = channelBelow(srcRow) + trackFor("cb:" + srcRow);
          var lr = laneRight + trackFor("lr");
          var ca = channelAbove(dstRow) + trackFor("ca:" + dstRow);
          var laneX2 = tSide === "right" ? dstMeta.x + dstMeta.w + 18 : dstMeta.x - 18;
          pts.push({ x: start.x, y: cb2 });
          pts.push({ x: lr, y: cb2 });
          pts.push({ x: lr, y: ca });
          pts.push({ x: laneX2, y: ca });
          pts.push({ x: laneX2, y: end.y });
          pts.push({ x: end.x, y: end.y });
          return { start: start, end: end, pts: simplify(pts) };
        }
      }
      // 兜底:底部通道
      var cbf = channelBelow(rows - 1) + trackFor("cb:last");
      pts.push({ x: start.x, y: cbf });
      pts.push({ x: end.x, y: cbf });
      pts.push({ x: end.x, y: end.y });
      return { start: start, end: end, pts: simplify(pts) };
    }
    function routeAux(f, sp, tp) {
      var start = portOf(sp, "right"), end = portOf(tp, "left");
      var sx = sp.x + sp.w, sy = sp.y + sp.h / 2;
      var tx = tp.x, ty = tp.y + tp.h / 2;
      var midX = Math.max(sx + 32, tx - 32);
      var pts = simplify([{ x: sx, y: sy }, { x: midX, y: sy }, { x: midX, y: ty }, { x: tx, y: ty }]);
      return { start: { x: sx, y: sy }, end: { x: tx, y: ty }, pts: pts };
    }
    function routeInner(f, sp, tp) {
      var same = sp.id && tp.id && sp.id === tp.id;
      var side = same || (tp.x + tp.w / 2) >= (sp.x + sp.w / 2) ? "right" : "left";
      var s = portOf(sp, side), t = portOf(tp, side);
      var out = side === "right" ? 46 : -46;
      if (same) {
        // 同元素自环:右侧小回环(不能让贝塞尔起终点重合=零长度不可见)
        var lx = sp.x + sp.w, ly = sp.y + sp.h / 2;
        var d0 = "M " + lx + " " + ly + " C " + (lx + 34) + " " + (ly - 22) + ", " + (lx + 34) + " " + (ly + 22) + ", " + lx + " " + ly;
        return { start: { x: lx, y: ly }, end: { x: lx, y: ly }, path: d0, dotFrom: { x: lx, y: ly }, dotTo: { x: lx, y: ly }, pts: [{ x: lx, y: ly }, { x: lx + 34, y: ly }, { x: lx, y: ly }], side: side };
      }
      var d = "M " + s.x + " " + s.y + " C " + (s.x + out) + " " + s.y + ", " + (t.x + out) + " " + t.y + ", " + t.x + " " + t.y;
      return { start: s, end: t, path: d, dotFrom: s, dotTo: t, pts: [{ x: s.x, y: s.y }, { x: t.x, y: t.y }], side: side };
    }

    // 端口方向:同排相邻前向=右→左;下排=底→顶;其余(非相邻/回边)=底→底;逻辑=右→左
    for (var f2 = 0; f2 < flows.length; f2++) {
      var fl = flows[f2];
      var srcR = fl.source.rect, dstR = fl.target.rect;
      var srcMeta = fl.sourcePage ? pageMetaById.get(fl.sourcePage) : null;
      var dstMeta = fl.targetPage ? pageMetaById.get(fl.targetPage) : null;
      var srcRow = srcMeta ? srcMeta.row : 0;
      var dstRow = dstMeta ? dstMeta.row : srcRow;
      var out = null;
      if (fl.kind === "inner") {
        out = routeInner(fl, srcR, dstR);
        fl.path = out.path;
        fl.leaderFrom = ""; fl.leaderTo = "";
        fl.dotFrom = out.dotFrom; fl.dotTo = out.dotTo;
        fl.startPoint = out.start; fl.endPoint = out.end;
        fl.startSide = out.side; fl.endSide = out.side;
      } else if (fl.kind === "logic") {
        // 逻辑流:源/目标任意一端是辅助带;用简洁折线,不参与屏幕网格
        if (fl.source.element || fl.target.element) {
          if (fl.source.element) {
            var lf = leaderFromElement(srcR, pageMetaById.get(fl.sourcePage), "bottom");
            fl.leaderFrom = lf.path; fl.dotFrom = lf.dot;
            srcR = { x: lf.pagePoint.x - 1, y: lf.pagePoint.y - 1, w: 2, h: 2, id: fl.sourcePage };
          }
          if (fl.target.element) {
            var lt = leaderToElement(pageMetaById.get(fl.targetPage), dstR, "top");
            fl.leaderTo = lt.path; fl.dotTo = lt.dot;
            dstR = { x: lt.pagePoint.x - 1, y: lt.pagePoint.y - 1, w: 2, h: 2, id: fl.targetPage };
          }
        }
        out = routeAux(fl, srcR, dstR);
        fl.path = pathOf(out.pts);
      } else if (fl.kind === "popup" && fl.sourcePage && fl.sourcePage === fl.targetPage) {
        // 同页弹窗:触发控件 → 浮层边框。先试直接折线;若穿过兄弟控件(实测确认按钮→弹窗的竖线
        // 会压住列表行),改走页面内侧空隙绕行,保证线不压任何控件。
        var srcC = { x: srcR.x + srcR.w / 2, y: srcR.y + srcR.h / 2 };
        var dstC = { x: dstR.x + dstR.w / 2, y: dstR.y + dstR.h / 2 };
        var pdx = dstC.x - srcC.x, pdy = dstC.y - srcC.y;
        var psSide, ptSide, pStart, pEnd, pPts;
        // 目标侧优先选「面向触发源」的浮层边:源在上→浮层顶,源在下→浮层底,源在左/右→浮层左/右。
        // 这样底部抽屉/下拉的箭头不会从浮层中间横穿到另一侧。
        var abovePop = srcR.y + srcR.h <= dstR.y + 2;
        var belowPop = srcR.y >= dstR.y + dstR.h - 2;
        var leftPop = srcR.x + srcR.w <= dstR.x + 2;
        var rightPop = srcR.x >= dstR.x + dstR.w - 2;
        if (abovePop) {
          psSide = "bottom"; ptSide = "top";
          pStart = fl.source.element ? portOf(srcR, psSide) : portOf(srcMeta, psSide);
          pEnd = { x: Math.max(dstR.x + 8, Math.min(dstR.x + dstR.w - 8, pStart.x)), y: dstR.y };
          pPts = simplify([pStart, { x: pStart.x, y: pEnd.y }, pEnd]);
        } else if (belowPop) {
          psSide = "top"; ptSide = "bottom";
          pStart = fl.source.element ? portOf(srcR, psSide) : portOf(srcMeta, psSide);
          pEnd = { x: Math.max(dstR.x + 8, Math.min(dstR.x + dstR.w - 8, pStart.x)), y: dstR.y + dstR.h };
          pPts = simplify([pStart, { x: pStart.x, y: pEnd.y }, pEnd]);
        } else if (leftPop || rightPop) {
          psSide = leftPop ? "right" : "left"; ptSide = leftPop ? "left" : "right";
          pStart = fl.source.element ? portOf(srcR, psSide) : portOf(srcMeta, psSide);
          pEnd = { x: leftPop ? dstR.x : dstR.x + dstR.w, y: Math.max(dstR.y + 8, Math.min(dstR.y + dstR.h - 8, pStart.y)) };
          pPts = simplify([pStart, { x: pEnd.x, y: pStart.y }, pEnd]);
        } else if (Math.abs(pdx) >= Math.abs(pdy)) {
          psSide = pdx >= 0 ? "right" : "left"; ptSide = pdx >= 0 ? "left" : "right";
          pStart = fl.source.element ? portOf(srcR, psSide) : portOf(srcMeta, psSide);
          pEnd = { x: pdx >= 0 ? dstR.x : dstR.x + dstR.w, y: Math.max(dstR.y + 8, Math.min(dstR.y + dstR.h - 8, pStart.y)) };
          var pmx = (pStart.x + pEnd.x) / 2;
          pPts = simplify([pStart, { x: pmx, y: pStart.y }, { x: pmx, y: pEnd.y }, pEnd]);
        } else {
          psSide = pdy >= 0 ? "bottom" : "top"; ptSide = pdy >= 0 ? "top" : "bottom";
          pStart = fl.source.element ? portOf(srcR, psSide) : portOf(srcMeta, psSide);
          pEnd = { x: Math.max(dstR.x + 8, Math.min(dstR.x + dstR.w - 8, pStart.x)), y: pdy >= 0 ? dstR.y : dstR.y + dstR.h };
          pPts = simplify([pStart, { x: pStart.x, y: pEnd.y }, pEnd]);
        }
        var pPage = pos.get(fl.sourcePage);
        var pObstacles = descendants(fl.sourcePage).filter(function (n) {
          return n.kind === "component" && n.id !== fl.source.id && !popupSubtree.has(n.id);
        });
        var pBlocked = false;
        for (var poi = 0; poi < pObstacles.length && !pBlocked; poi++) {
          var por = rectOf(pObstacles[poi].id);
          if (!por) continue;
          for (var psi = 1; psi < pPts.length; psi++) {
            if (segHitsRect(pPts[psi - 1], pPts[psi], por)) { pBlocked = true; break; }
          }
        }
        if (pBlocked && pPage) {
          var marginSide = srcC.x < dstC.x ? "left" : "right";
          var marginX = marginSide === "left" ? pPage.x + 4 : pPage.x + pPage.w - 4;
          var popAbove = dstR.y + dstR.h <= srcR.y;
          var popBelow = dstR.y >= srcR.y + srcR.h;
          if (popAbove || popBelow) {
            var pStart2 = fl.source.element ? portOf(srcR, marginSide) : portOf(srcMeta, marginSide);
            var popY = popAbove ? dstR.y + dstR.h : dstR.y;
            var popX = Math.max(dstR.x + 8, Math.min(dstR.x + dstR.w - 8, marginX));
            pPts = simplify([pStart2, { x: marginX, y: pStart2.y }, { x: marginX, y: popY }, { x: popX, y: popY }]);
            pStart = pStart2;
            pEnd = { x: popX, y: popY };
            psSide = marginSide;
            ptSide = popAbove ? "bottom" : "top";
          }
        }
        fl.path = pathOf(pPts);
        fl.leaderFrom = ""; fl.leaderTo = "";
        fl.dotFrom = fl.source.element ? pStart : null; fl.dotTo = null;
        fl.startPoint = pStart; fl.endPoint = pEnd;
        fl.startBoundary = pStart; fl.endBoundary = pEnd;
        fl.targetPageBoundary = null;
        fl.startSide = psSide; fl.endSide = ptSide;
        out = { start: pStart, end: pEnd, pts: pPts };
      } else {
        var sSide = "bottom", tSide = "bottom";
        var srcPopupId = popupOf.get(fl.source.id);
        if (srcMeta && dstMeta) {
          var sameRow = srcMeta.row === dstMeta.row;
          var forward = sameRow ? dstMeta.x > srcMeta.x : dstMeta.row > srcMeta.row;
          var adjacent = sameRow && Math.abs(srcMeta.col - dstMeta.col) === 1;
          if (fl.kind !== "back" && sameRow && adjacent && forward) { sSide = "right"; tSide = "left"; }
          else if (fl.kind !== "back" && !sameRow && dstRow > srcRow) {
            sSide = "bottom";
            tSide = dstMeta.col >= srcMeta.col ? "left" : "right";
          } else { sSide = "bottom"; tSide = "bottom"; }
          // 同排任意距离:目标页大框从左侧(前向)或右侧(回退)进入,箭头落在框边而不是屏底。
          if (sameRow && fl.kind !== "inner") tSide = forward ? "left" : "right";
          // 页面跳转的源出口朝向目标:同排取左右、目标在下取底、在上取顶;再由 pageExitSide 避障。
          if (fl.target.pageFrame) {
            if (dstMeta.row > srcMeta.row) sSide = "bottom";
            else if (dstMeta.row < srcMeta.row) sSide = "top";
            else sSide = (dstMeta.x + dstMeta.w / 2) >= (srcMeta.x + srcMeta.w / 2) ? "right" : "left";
          }
          // 目标控件两侧都是兄弟时,选离屏边最近的一侧进——从远端进会横穿同排兄弟(实测详情页
          // 「申请领养」右侧按钮被左侧「收藏」挡住,箭头穿收藏行)。两侧都贴边时按列方向选。
          if (fl.target.element && dstMeta) {
            var gl = dstR.x - dstMeta.x;
            var gr = dstMeta.x + dstMeta.w - (dstR.x + dstR.w);
            if (gr <= 24 && gl > 24) tSide = "right";
            else if (gl <= 24 && gr > 24) tSide = "left";
            else if (gl > 24 && gr > 24) tSide = (dstR.x + dstR.w / 2) <= (dstMeta.x + dstMeta.w / 2) ? "left" : "right";
            else tSide = dstMeta.col >= srcMeta.col ? "left" : "right";
          }
          // 浮层目标:跨屏进入时从离源屏更近的一侧指向浮层边框(不按目标页内容元素的取边规则)。
          if (fl.target.popup && fl.sourcePage !== fl.targetPage) {
            tSide = (srcMeta.x + srcMeta.w / 2) <= (dstMeta.x + dstMeta.w / 2) ? "left" : "right";
          }
        }
        // 浮层里的按钮跳外页:控件先从无障碍的一侧出浮层,再从浮层边附近出页面大框(不绕屏底穿内容行)。
        var srcPopupSide = "";
        if (srcPopupId && fl.source.element) srcPopupSide = popupExitSide(fl.source.id, srcPopupId);
        if (srcPopupId && srcMeta && dstMeta) {
          sSide = (dstMeta.x + dstMeta.w / 2) >= (srcMeta.x + srcMeta.w / 2) ? "right" : "left";
        } else if (fl.source.element && srcMeta) {
          // 普通页内控件:目标方向那一侧有兄弟行挡着才换边,不无条件改走屏底(实测会竖穿开关/列表)。
          sSide = pageExitSide(fl.source.id, fl.sourcePage, sSide);
        }
        // 端点必须落在控件上:元素→页边界→路由→页边界→元素 合并成一条连续流线,
        // 起点 dotFrom/终点 dotTo 都是控件端口;页边界只作为路由拐点,不再把箭头截在框边。
        var startEl = fl.source.element ? portOf(srcR, srcPopupSide || sSide) : null;
        var endEl = fl.target.element ? portOf(dstR, tSide) : null;
        var startB = fl.source.element ? leaderPointOnPage(srcR, srcMeta, sSide) : portOf(srcMeta, sSide);
        var startPageB = startB;
        fl.startPopupBoundary = null;
        if (srcPopupId && startEl) {
          var spr = rectOf(srcPopupId);
          if (spr) {
            var ctrlSide = srcPopupSide || "bottom";
            var popB;
            if (ctrlSide === "right") popB = { x: spr.x + spr.w, y: startEl.y };
            else if (ctrlSide === "left") popB = { x: spr.x, y: startEl.y };
            else if (ctrlSide === "top") popB = { x: startEl.x, y: spr.y };
            else popB = { x: startEl.x, y: spr.y + spr.h };
            if (sSide === "right") startPageB = { x: srcMeta.x + srcMeta.w, y: popB.y };
            else if (sSide === "left") startPageB = { x: srcMeta.x, y: popB.y };
            else if (sSide === "top") startPageB = { x: popB.x, y: srcMeta.y };
            else startPageB = { x: popB.x, y: srcMeta.y + srcMeta.h };
            fl.startPopupBoundary = popB;
            startB = startPageB;
          }
        }
        // 浮层目标落在浮层边框;页面跳转目标落在目标页大框边界(用户 2026-10-26 口径)。
        var endB = fl.target.element ? leaderPointOnPage(dstR, dstMeta, tSide)
          : fl.target.popup ? portOf(dstR, tSide)
          : portOf(dstMeta, tSide);
        var sBox = { x: startB.x, y: startB.y, w: 0, h: 0, id: fl.sourcePage };
        var tBox = { x: endB.x, y: endB.y, w: 0, h: 0, id: fl.targetPage };
        // 浮层目标:记下目标页大框上的进入点,覆盖层据此补画「页边→浮层」这一段(框内主线在卡片下面)。
        fl.targetPageBoundary = fl.target.popup && dstMeta ? portOf(dstMeta, tSide) : endB;
        out = routeGrid(fl, sBox, tBox, sSide, tSide);
        fl.dotFrom = startEl; fl.dotTo = endEl;
        fl.startPoint = startEl || startB; fl.endPoint = endEl || endB;
        fl.startBoundary = fl.startPopupBoundary || startB;
        fl.startPageBoundary = startPageB;
        fl.endBoundary = endB;
        fl.startSide = srcPopupSide || sSide; fl.endSide = tSide;
        fl.leaderFrom = ""; fl.leaderTo = "";
        var fullPts = [];
        if (startEl) fullPts.push(startEl);
        if (fl.startPopupBoundary) fullPts.push(fl.startPopupBoundary);
        fullPts.push(startB);
        for (var fp0 = 0; fp0 < out.pts.length; fp0++) fullPts.push(out.pts[fp0]);
        fullPts.push(endB);
        if (endEl) fullPts.push(endEl);
        fl.path = pathOf(simplify(fullPts));
      }
      var lab = labelOf(out.pts || [{ x: out.start.x, y: out.start.y }, { x: out.end.x, y: out.end.y }], fl.label);
      fl.labelText = lab.text || fl.label;
      fl.labelX = lab.x; fl.labelY = lab.y; fl.labelAnchor = lab.anchor || "middle";
      fl.labelW = lab.w || Math.min(210, Math.max(42, fl.labelText.length * 6.6 + 14));
    }
    // 标签避让:多条流在底部通道汇合时标签会叠成黑块(实测「跳转:删除结果」压住「返回:用户列表」)。
    // 按流序做简单下移,保持文字可读;世界尺寸随后会把标签纳入,避免被裁。
    var placedLabels = [];
    for (var lbf = 0; lbf < flows.length; lbf++) {
      var lf = flows[lbf];
      if (!lf.labelText) continue;
      var lw = lf.labelW || Math.min(210, Math.max(42, lf.labelText.length * 6.6 + 14));
      var lx = lf.labelAnchor === "start" ? lf.labelX - 4 : lf.labelX - lw / 2;
      var lb = { x: lx - 2, y: lf.labelY - 11, w: lw + 4, h: 22 };
      var guardL = 0;
      function labelHit() {
        for (var li = 0; li < placedLabels.length; li++) {
          var o = placedLabels[li];
          if (lb.x < o.x + o.w && o.x < lb.x + lb.w && lb.y < o.y + o.h && o.y < lb.y + lb.h) return true;
        }
        return false;
      }
      while (labelHit() && guardL++ < 8) { lf.labelY += 16; lb.y += 16; }
      placedLabels.push({ x: lb.x, y: lb.y, w: lb.w, h: lb.h });
    }

    // ---- 13) 热区(元素被哪些流当源/目标) ----
    var hotspots = new Map();
    function hot(id, flow, dir) {
      if (!id) return;
      if (!hotspots.has(id)) hotspots.set(id, []);
      hotspots.get(id).push({ idx: flow.idx, dir: dir, color: flow.color, label: flow.label, group: flow.groupLabel, inferred: dir === "out" ? !!flow.source.inferred : !!flow.target.inferred });
    }
    for (var f3 = 0; f3 < flows.length; f3++) {
      var ff = flows[f3];
      if (ff.source.element) hot(ff.source.id, ff, "out");
      if (ff.target.element || ff.target.popup) hot(ff.target.id, ff, "in");
    }

    // ---- 14) 顶部摘要/图例 + 主路径 ----
    var mainPageIds = mainPathIds.slice();
    if (!mainPageIds.length) mainPageIds = pageList.slice(0, Math.min(3, pageList.length));
    var mainPathText = mainPageIds.map(function (id) { return shortTitle(nm.get(id)); }).join(" → ");
    if (mainPathText.length > 96) mainPathText = mainPathText.slice(0, 95) + "…";
    var jumpCount = 0, popupCount = 0;
    for (var f4 = 0; f4 < flows.length; f4++) {
      if (flows[f4].kind === "jump" || flows[f4].kind === "popup" || flows[f4].kind === "back") jumpCount++;
      if (flows[f4].kind === "popup") {
        popupCount++;
        if (flows[f4].source && flows[f4].source.element) popupTriggers.add(flows[f4].source.id);
      }
    }
    var head = {
      x: MARGIN_X, y: 12, w: worldW - MARGIN_X * 2, h: HEAD_H - 12,
      title: txt(doc.title) || "UI 交互流程",
      summary: pageList.length + " 屏 · " + jumpCount + " 条跳转" + (popupCount ? " · " + popupCount + " 个浮层" : "") + (mainPathText ? " · 主路径:" + mainPathText : ""),
    };

    // ---- 15) 世界尺寸(含辅助带/拖动溢出) ----
    var worldH = auxLane ? (auxLane.y + auxLane.h + MARGIN_Y) : (frameY[rows - 1] + rowHeights[rows - 1] + MARGIN_Y);
    var maxX = worldW, maxY = worldH;
    pos.forEach(function (p, id) {
      var s = size.get(id) || { w: 0, h: 0 };
      if (p.x + s.w + MARGIN_X / 2 > maxX) maxX = p.x + s.w + MARGIN_X / 2;
      if (p.y + s.h + MARGIN_Y > maxY) maxY = p.y + s.h + MARGIN_Y;
    });
    for (var lwx = 0; lwx < flows.length; lwx++) {
      var lwf = flows[lwx];
      if (!lwf.labelText) continue;
      var lww = lwf.labelW || Math.min(210, Math.max(42, lwf.labelText.length * 6.6 + 14));
      var lright = lwf.labelAnchor === "start" ? lwf.labelX + lww : lwf.labelX + lww / 2;
      if (lright + MARGIN_X / 2 > maxX) maxX = lright + MARGIN_X / 2;
      if (lwf.labelY + 14 + MARGIN_Y > maxY) maxY = lwf.labelY + 14 + MARGIN_Y;
    }
    worldW = Math.max(worldW, maxX);
    worldH = Math.max(worldH, maxY);

    // 角色补齐(页/辅助),供渲染层与明细共用
    var roles = new Map(base.roles || []);
    for (var p9 = 0; p9 < pageList.length; p9++) roles.set(pageList[p9], "page");
    for (var a9 = 0; a9 < auxNodes.length; a9++) if (!roles.has(auxNodes[a9].id)) roles.set(auxNodes[a9].id, "aux");
    var controls = new Map();
    var sectionTypes = new Map();
    var sectionKids = new Map();
    for (var ctl = 0; ctl < nodes.length; ctl++) {
      var cn2 = nodes[ctl];
      controls.set(cn2.id, controlOf(cn2));
      if (cn2.kind === "section") {
        sectionTypes.set(cn2.id, sectionTypeOf(cn2, roles.get(cn2.id) || "main"));
        sectionKids.set(cn2.id, descendantsOf(cn2.id).length);
      }
    }
    var outLevel = new Map(base.level || new Map());
    for (var lv0 = 0; lv0 < pageList.length; lv0++) outLevel.set(pageList[lv0], levelMap.get(pageList[lv0]) || 0);
    var outBack = new Set();
    for (var fb = 0; fb < flows.length; fb++) {
      var fbFlow = flows[fb];
      if (fbFlow.kind === "back" && fbFlow.sourcePage && fbFlow.targetPage) outBack.add(fbFlow.sourcePage + ">" + fbFlow.targetPage);
    }

    return {
      mode: "ui-flow",
      pos: pos, size: size, containers: containers,
      mainNodes: mainPageSet, mainEdges: mainPairSet,
      backEdges: outBack, selfLoops: base.selfLoops || [], crossEdges: base.crossEdges || [],
      roles: roles, level: outLevel, orphanCount: auxNodes.length,
      controls: controls, sectionTypes: sectionTypes, sectionKids: sectionKids, actionBars: actionBars,
      pages: pageList.map(function (id) { return pageMetaById.get(id); }),
      flows: flows, groups: groups, hotspots: hotspots,
      popups: popups, popupIds: popupIds, popupOf: popupOf, popupKids: popupKids,
      popupHeadingIds: popupHeadingIds, popupTriggers: popupTriggers, popupMasks: popupMasks,
      popupCovered: popupCovered,
      head: head, auxLane: auxLane, auxNodes: auxNodes, tabsByPage: tabsByPage,
      cols: cols, rows: rows, rowOf: rowOf, colOf: colOf, rowY: rowY, frameY: frameY, rowHeights: rowHeights,
      world: { w: worldW, h: worldH },
      summary: { screens: pageList.length, jumps: jumpCount, mainPath: mainPathText },
      palette: PALETTE, special: { back: BACK, logic: LOGIC, aux: AUX },
    };
  }

  return { layout: layout, PALETTE: PALETTE, special: { back: BACK, logic: LOGIC, aux: AUX } };
});
