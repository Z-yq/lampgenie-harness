/** 白板语义级布局引擎(页面结构板 docKind=page 专用):
 * 「白板的定位是面向给人看的,让人能理解 coding agent 的计划,并且是语义级的流程」。
 * 纯函数零 IO 零随机(幂等,确定性排序带 id tie-breaker);零 DOM 依赖——浏览器挂
 * BoardPageLayout(panel.ts 画布渲染层调用),vitest 走 module.exports 单测。
 * 设计与角色判定规则全量登记在。
 * 产出:
 * - 容器化:page=浏览器窗容器(分区底色),contains 的 section/component 收进容器内 UI 线框布局;
 * - 层次流向:page 间按 nav 边 Kahn 最长入链分层(入口最左,同层对齐);
 * - 主线突出:从主入口(可达最多)的最长路径=用户主路径,mainNodes/mainEdges 供渲染层加粗;
 * - pos 全治:全部节点(含孤立/无 contains 归属者)都有确定位置,无 None 无堆叠。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(); // CJS(vitest/esbuild 转换)
  else {
    // 浏览器 script 标签挂全局;node ESM 下 this 为 undefined → self/globalThis 兜底(只挂全局不炸)
    root = root || (typeof self !== "undefined" ? self : globalThis);
    root.BoardPageLayout = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- 常量(与 panel.ts 画布 CSS 协同;容器内线框规格) ----
  var MARGIN = 40;          // 世界外边距
  var LAYER_GAP = 48;       // page 层间距(给 nav 边+触发器标签留白)
  var ROW_GAP = 44;         // 同层 page 上下间距
  var PAD = 14;             // page 容器内边距
  var HEAD_H = 34;          // page 容器浏览器窗头部(三点头+地址栏)高
  var TOP_H = 24;           // 顶栏/横条区每项高
  var TOP_GAP = 7;
  var SIDE_W = 132;         // 侧栏列宽
  var SIDE_H = 46;          // 侧栏每项高
  var SIDE_GAP = 8;
  var MAIN_H = 56;          // 主区每项高
  var MAIN_GAP = 9;
  var MAIN_MIN_W = 150;     // 主区最小宽
  var BOTTOM_H = 24;        // 底栏每项高
  var BOTTOM_GAP = 7;
  var OVER_W = 118, OVER_H = 38, OVER_GAP = 10; // 浮层(弹窗类)
  var COMP_W = 84, COMP_H = 28, COMP_GAP = 8;   // 组件级素描小卡
  var ORPHAN_TAG_H = 30;    // 「未归属」区标注条高
  var CONT_MIN_W = 246;     // page 容器最小宽
  var PAGE_ROW_W = 1750;    // 蛇形单行世界宽预算(4 列×~370;超出折行,书页动线保全览可读)

  /** section/component 的 UI 布局角色(label 关键词确定性识别;识别不了→main,诚实不乱猜)。
   * 规则表与 step.md D2 一致;顺序=top → side → bottom → overlay → main(缺省)。
   * 词表在电子签真实板上校准:面板/表单/名单/模板=侧栏族(字段面板/元信息表单/签署人名单),
   * 搜索/提醒/凭证头=顶栏族;覆盖不到的落 main 堆叠(诚实)。 */
  function uiRole(kind, label, boardType) {
    if (kind === "component") return "component";
 // docs 两层 PPT:章容器(kind=section)内的子项是「页」——全部进 main 竖排槽
    // (页卡尺寸由 layoutInside 按 boardType=docs 放大);不走 UI 线框 role 词表,
 // 经验证「密码/登录」等页名词被 side/overlay 词表误判,页卡被塞进 46px 侧栏槽摘要全裁。
    if (boardType === "docs" && kind === "page") return "main";
    var s = String(label || "").toLowerCase();
    if (/(顶栏|顶部|头部|导航栏|标题栏|页签|横幅|提醒|搜索|步骤条|面包屑|凭证头|页头|菜单栏|菜单条|工具栏|工具条|命令栏|tab|header|navbar|banner)/.test(s)) return "top";
    if (/(侧栏|侧边|菜单|筛选|分类|目录|面板|表单|名单|模板|设置导航|侧边导航|导航树|sidebar|aside)/.test(s)) return "side";
    if (/(底栏|底部|操作条|footer|状态栏|操作栏)/.test(s)) return "bottom";
    if (/(弹窗|浮层|对话框|确认框|modal|dialog|toast|遮罩)/.test(s)) return "overlay";
    return "main";
  }

  function byId(nodes) {
    var m = new Map();
    for (var i = 0; i < nodes.length; i++) m.set(nodes[i].id, nodes[i]);
    return m;
  }

  /**
   * 语义级布局。
   * @param {{nodes:Array, edges:Array}} doc BoardDoc(只需 nodes/edges)
   * @returns {{pos:Map, size:Map, mainNodes:Set, mainEdges:Set, backEdges:Set,
   *            selfLoops:Array<number>, roles:Map, level:Map, containers:Map}}
   *   pos=id→{x,y} 绝对坐标;size=id→{w,h};containers=pageId→{x,y,w,h,sections:role 分组明细}
   */
  function layout(doc) {
    var nodes = (doc && doc.nodes) || [];
    var boardType = String((doc && doc.boardType) || "");
    var edges = (doc && doc.edges) || [];
    var nm = byId(nodes);
    var pos = new Map();
    var size = new Map();
    var roles = new Map();
    var level = new Map();
    var containers = new Map();

    // ---- 1) contains 归属(悬空目标忽略;一子多父取首个,其余当孤立——诚实落「未归属」) ----
    var claimed = new Set();
    var childrenOf = new Map(); // pageId -> [node...](保序)
    var orphanEdgeSeen = new Set();
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei];
      if ((e.kind || "contains") !== "contains") continue;
      var par = nm.get(e.from), kid = nm.get(e.to);
      if (!par || !kid || claimed.has(kid.id)) continue;
      claimed.add(kid.id);
      if (!childrenOf.has(par.id)) childrenOf.set(par.id, []);
      childrenOf.get(par.id).push(kid);
    }
    // page = 有孩子的 contains 源,或显式 kind=page
 // docs deck:boardType=docs 且存在「section contains→page」时,章(section)也是容器
    // ——「章→页」两层与「页→区块」一层在布局上同构(容器=contains 源),nav 分层把章当页间节点排。
    var docDeck = boardType === "docs" && edges.some(function (e) {
      if ((e.kind || "") !== "contains") return false;
      var f = nm.get(e.from), t = nm.get(e.to);
      return !!(f && t && f.kind === "section" && t.kind === "page");
    });
    var containerKinds = docDeck ? { page: 1, section: 1 } : { page: 1 };
    var pageIds = [];
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      if (containerKinds[n.kind]) pageIds.push(n.id);
    }
    var isPage = new Set(pageIds);

 // ---- 1.5) 单页板 contains 补齐( 可读性)----
 // planner 常只给 page 画少量 contains(经验证 17 节点页面板只连了 2 个),其余 section/component
    // 被当成「未归属」排到页外,弹窗子节点甚至落 (0,0)。单页板里 page 是唯一根,未声明归属的
    // 顶层节点按页内节点布局(只影响渲染,不写盘/不改边);多页板保留「未归属」语义,避免乱认父。
    if (doc && doc.docKind === "page" && pageIds.length === 1) {
      var solePage = pageIds[0];
      var pageKids = childrenOf.get(solePage) || [];
      childrenOf.set(solePage, pageKids);
      for (var ui = 0; ui < nodes.length; ui++) {
        var un = nodes[ui];
        if (un.id === solePage || un.kind === "page" || claimed.has(un.id)) continue;
        claimed.add(un.id);
        pageKids.push(un);
      }
    }

    // ---- 2) nav DAG 分层(仅 page 间 nav;自环/非 page 端点的边不参与) ----
    var navAdj = new Map();   // from -> [{to, idx}]
    var indeg = new Map();
    for (var p = 0; p < pageIds.length; p++) { navAdj.set(pageIds[p], []); indeg.set(pageIds[p], 0); }
    var navEdges = [];        // {from,to,idx,back}(page↔page;back=回边候选)
    var backEdges = new Set();  // "from>to"(语义候选 ∪ 结构破环)
    var selfLoops = [];       // edges 下标
    var crossEdges = [];      // 非 page↔page 的 nav(容器内/跨容器子节点,渲染层自定)
    // 语义回边候选:触发器文本含「返回/上一步/取消/退回」=产品语义上的回流,先剥离再分层
 // (电子签验证:看板入度 4 全来自回边,不剥离则无入度 0 入口,Kahn 整体不推进=全 0 层)。
    var BACK_RE = /(返回|回到|上一步|下一步前|取消|退回|返回工作台)/;
    for (var ei2 = 0; ei2 < edges.length; ei2++) {
      var e2 = edges[ei2];
      if ((e2.kind || "") !== "nav") continue;
      var f = nm.get(e2.from), t = nm.get(e2.to);
      if (!f || !t) continue;
      if (f.id === t.id) { selfLoops.push(ei2); continue; }
      if (isPage.has(f.id) && isPage.has(t.id)) {
        var isBack = BACK_RE.test(String(e2.label || ""));
        if (isBack) backEdges.add(f.id + ">" + t.id);
        navEdges.push({ from: f.id, to: t.id, idx: ei2, back: isBack });
      } else {
        crossEdges.push(ei2);
      }
    }
    // 前向边(非回边候选)入邻接表参与分层
    for (var ne0 = 0; ne0 < navEdges.length; ne0++) {
      if (navEdges[ne0].back) continue;
      navAdj.get(navEdges[ne0].from).push({ to: navEdges[ne0].to, idx: navEdges[ne0].idx });
      indeg.set(navEdges[ne0].to, (indeg.get(navEdges[ne0].to) || 0) + 1);
    }
    // Kahn 最长入链 + 结构环迭代破除:剥离语义回边后仍可能有环(如「立即校验」与「查看凭证原件」
    // 互指)。推进停滞时选「outdeg−indeg 最大」的未到达节点(并列取出度大者、id 升序稳定),
    // 把「未到达→它」的入边从邻接表删除记结构回边(入口语义=入口皆多的枢纽),继续推进。
    var indegRemain = new Map(indeg);
    for (var p2 = 0; p2 < pageIds.length; p2++) level.set(pageIds[p2], 0);
    var seen = new Set();
    for (;;) {
      var q = [];
      for (var p2b = 0; p2b < pageIds.length; p2b++) {
        var pid0 = pageIds[p2b];
        if (!seen.has(pid0) && (indegRemain.get(pid0) || 0) <= 0) q.push(pid0);
      }
      if (!q.length) {
        var rest = pageIds.filter(function (id) { return !seen.has(id); });
        if (!rest.length) break;
        rest.sort(function (a, b) {
          var sa = (navAdj.get(a) || []).length - (indegRemain.get(a) || 0);
          var sb = (navAdj.get(b) || []).length - (indegRemain.get(b) || 0);
          if (sa !== sb) return sb - sa;
          var oa = (navAdj.get(a) || []).length, ob = (navAdj.get(b) || []).length;
          if (oa !== ob) return ob - oa;
          return a < b ? -1 : 1;
        });
        var pick = rest[0];
        // 未到达→pick 的入边=结构回边,移出邻接表
        for (var rne = 0; rne < navEdges.length; rne++) {
          var rE = navEdges[rne];
          if (rE.back || rE.to !== pick || seen.has(rE.from)) continue;
          var adjF = navAdj.get(rE.from) || [];
          for (var ai = 0; ai < adjF.length; ai++) {
            if (adjF[ai].to === pick) { adjF.splice(ai, 1); break; }
          }
          backEdges.add(rE.from + ">" + pick);
        }
        indegRemain.set(pick, 0);
        q = [pick];
      }
      while (q.length) {
        var nxt = [];
        for (var qi = 0; qi < q.length; qi++) {
          var id = q[qi];
          if (seen.has(id)) continue;
          seen.add(id);
          var outs = navAdj.get(id) || [];
          for (var oi = 0; oi < outs.length; oi++) {
            var to = outs[oi].to;
            if (seen.has(to)) continue;
            level.set(to, Math.max(level.get(to) || 0, (level.get(id) || 0) + 1));
            indegRemain.set(to, (indegRemain.get(to) || 1) - 1);
            if ((indegRemain.get(to) || 0) <= 0) nxt.push(to);
          }
        }
        q = nxt;
      }
      var allSeen = true;
      for (var p2c = 0; p2c < pageIds.length; p2c++) if (!seen.has(pageIds[p2c])) { allSeen = false; break; }
      if (allSeen) break;
    }
    for (var p3 = 0; p3 < pageIds.length; p3++) if (!seen.has(pageIds[p3])) level.set(pageIds[p3], 0);

    // ---- 3) 主线:主入口(入度 0 且可达最多,并列取出度、id 序)出发的最长前向路径(DFS) ----
    function reachCount(start) {
      var st = [start], vis = new Set([start]);
      while (st.length) {
        var cur = st.pop();
        var out2 = navAdj.get(cur) || [];
        for (var i = 0; i < out2.length; i++) if (!vis.has(out2[i].to)) { vis.add(out2[i].to); st.push(out2[i].to); }
      }
      return vis.size;
    }
    var entries = pageIds.filter(function (id) { return (indegRemain.get(id) || 0) === 0; });
    if (!entries.length) {
      var minL = Infinity;
      for (var p4 = 0; p4 < pageIds.length; p4++) minL = Math.min(minL, level.get(pageIds[p4]) || 0);
      entries = pageIds.filter(function (id) { return (level.get(id) || 0) === minL; });
    }
    var mainEntry = null;
    for (var en = 0; en < entries.length; en++) {
      var id2 = entries[en];
      if (mainEntry === null) { mainEntry = id2; continue; }
      var rc = reachCount(id2), rcCur = reachCount(mainEntry);
      var od = (navAdj.get(id2) || []).length, odCur = (navAdj.get(mainEntry) || []).length;
      if (rc > rcCur || (rc === rcCur && (od > odCur || (od === odCur && id2 < mainEntry)))) mainEntry = id2;
    }
    var mainNodes = new Set();
    var mainEdges = new Set();
    var mainPath = [];
    if (mainEntry !== null) {
      // page ≤16 且出度小:vis 全量携带的 DFS 最长前向路径直接可行(不做 memo——环图上 memo 可能
      // 拼出含重复节点的「最长路径」,诚实起见每条路径以 vis 保证节点唯一)
      function longest(id3, vis) {
        if (vis.has(id3)) return { len: 0, path: [] };
        var best = { len: 1, path: [id3] };
        var vis2 = new Set(vis); vis2.add(id3);
        var outs3 = (navAdj.get(id3) || []).slice().sort(function (a, b) { return a.to < b.to ? -1 : 1; }); // 稳定 tie-break
        for (var i2 = 0; i2 < outs3.length; i2++) {
          if (vis2.has(outs3[i2].to)) continue;
          var sub = longest(outs3[i2].to, vis2);
          if (1 + sub.len > best.len) best = { len: 1 + sub.len, path: [id3].concat(sub.path) };
        }
        return best;
      }
      var lp = longest(mainEntry, new Set());
      mainPath = lp.path;
      for (var pi = 0; pi < lp.path.length; pi++) mainNodes.add(lp.path[pi]);
      for (var pi2 = 1; pi2 < lp.path.length; pi2++) mainEdges.add(lp.path[pi2 - 1] + ">" + lp.path[pi2]);
      // 主线拉直:主线节点层级沿路径严格 +1(剥离残余互指边后相邻主线节点可能同层,拉直保证
      // 主线横向直贯,分支不受影响)
      for (var pi3 = 1; pi3 < mainPath.length; pi3++) {
        var prevL = level.get(mainPath[pi3 - 1]) || 0;
        if ((level.get(mainPath[pi3]) || 0) <= prevL) level.set(mainPath[pi3], prevL + 1);
      }
    }

    // ---- 4) 容器内 UI 线框布局(角色分区;返回容器尺寸) ----
    function layoutInside(pageId, kids) {
 // 单页大板(桌面设置页形态)加宽:经验证 17 节点单页板 319px 宽导致状态卡 label 全被截断、
      // 页右大片空白。宽页给 side/main/component 更多横向预算,字与卡的比例回到可读区间。
      var widePage = pageIds.length === 1 && nodes.length >= 8;
      var sideW = widePage ? 180 : SIDE_W;
      var mainMinW = widePage ? 320 : MAIN_MIN_W;
      // 8-10 节点的页面板:组件卡用 132px,「密钥对话框(页中弹窗)」这类 10-11 字标签不再截断;
      // 11+ 节点的大页面板仍用 118px,保证组件一行四张、页面不因换行变高。
      var compW = widePage ? (nodes.length >= 11 ? 118 : 132) : COMP_W;
      var contMinW = widePage ? 540 : CONT_MIN_W;
      var groups = { top: [], side: [], main: [], bottom: [], overlay: [], component: [] };
      // docs deck:页卡用大尺寸(标题+4 行摘要),页槽高按内容撑;章容器最小宽同步放大
      var docDeck = boardType === "docs";
      if (docDeck) { mainMinW = Math.max(mainMinW, 300); contMinW = Math.max(contMinW, 360); }
      for (var k = 0; k < kids.length; k++) {
        var r = uiRole(kids[k].kind, kids[k].label, boardType);
        roles.set(kids[k].id, r);
        (groups[r] || groups.main).push(kids[k]);
      }
 // ---- 嵌套收编:section 的 contains 子孙(传递闭包)收进其槽位——
      // 此前孙节点进 childrenOf 却无人给位,渲染落 (0,0) 且不随容器拖动(拖拽闭包已在渲染层修,布局侧在此补齐)。
      // main/side 槽内撑高排布;top/bottom/overlay 父项的子孙降级并入 page 级组件行(保证人人有位)。
      var nestedOf = new Map(); // kidId -> [子孙节点...]
      var flattenDesc = function (rootId) {
        var out = [], st = (childrenOf.get(rootId) || []).slice();
        while (st.length) {
          var cur = st.shift();
          out.push(cur);
          var deeper = childrenOf.get(cur.id) || [];
          for (var d1 = 0; d1 < deeper.length; d1++) st.push(deeper[d1]);
        }
        return out;
      };
      var nestedRows = function (kidId, slotW) {
        var arr = nestedOf.get(kidId) || [];
        if (!arr.length) return { rows: 0, perRow: 1 };
        var perRow = Math.max(1, Math.floor(slotW / (compW + COMP_GAP)));
        return { rows: Math.ceil(arr.length / perRow), perRow: perRow };
      };
      var absorbNonFlow = function (arr) {
        for (var a1 = 0; a1 < arr.length; a1++) {
          var desc = flattenDesc(arr[a1].id);
          if (desc.length) {
            for (var a2 = 0; a2 < desc.length; a2++) {
              roles.set(desc[a2].id, "component");
              groups.component.push(desc[a2]);
            }
          }
        }
      };
      absorbNonFlow(groups.top); absorbNonFlow(groups.bottom); absorbNonFlow(groups.overlay); absorbNonFlow(groups.component);
      for (var nk = 0; nk < groups.side.length; nk++) nestedOf.set(groups.side[nk].id, flattenDesc(groups.side[nk].id));
      for (var nk2 = 0; nk2 < groups.main.length; nk2++) nestedOf.set(groups.main[nk2].id, flattenDesc(groups.main[nk2].id));
      var nestedSlotH = function (kidId, baseH, slotW, gapIn) {
        var nr = nestedRows(kidId, slotW);
        return baseH + (nr.rows ? 6 + nr.rows * (COMP_H + gapIn) : 0);
      };
      var hasSide = groups.side.length > 0;
      var mainW = Math.max(mainMinW, hasSide ? mainMinW : 190);
      var innerW = Math.max(contMinW - PAD * 2, (hasSide ? sideW + MAIN_GAP + mainW : mainW));
      var y = HEAD_H + 10;
      // 顶区:全宽横条堆叠(浏览器 tab/横幅形态)
      var topSlots = [];
      for (var t = 0; t < groups.top.length; t++) {
        size.set(groups.top[t].id, { w: innerW, h: TOP_H });
        topSlots.push({ id: groups.top[t].id, x: 0, y: y });
        y += TOP_H + TOP_GAP;
      }
      // 主体:左 side 竖列 + 右 main 竖列
      var bodyTop = y;
      var sideH = 0;
      var sideItemH = []; // 嵌套撑高后的每项高度
      for (var s = 0; s < groups.side.length; s++) {
        var sh1 = nestedSlotH(groups.side[s].id, SIDE_H, sideW, 4);
        sideItemH.push(sh1);
        size.set(groups.side[s].id, { w: sideW, h: sh1 });
        sideH += sh1 + (s > 0 ? SIDE_GAP : 0);
      }
      var mainH = 0;
      var mainX = hasSide ? sideW + MAIN_GAP : 0;
      var mainSlotW = hasSide ? innerW - mainX : innerW;
      var mainItemH = [];
      // docs deck 页卡:标题一行 + summary 4 行(约 58px),不是 UI 线框的 56px 单行
      var mainBaseH = docDeck ? 66 : MAIN_H;
      for (var m = 0; m < groups.main.length; m++) {
        var mh1 = nestedSlotH(groups.main[m].id, mainBaseH, mainSlotW, COMP_GAP);
        mainItemH.push(mh1);
        size.set(groups.main[m].id, { w: mainSlotW, h: mh1 });
        mainH += mh1 + (m > 0 ? MAIN_GAP : 0);
      }
      // 组件级:main 之后一行横排
      var compH = 0;
      if (groups.component.length) {
        var perRow = Math.max(1, Math.floor(innerW / (compW + COMP_GAP)));
        for (var c = 0; c < groups.component.length; c++) {
          size.set(groups.component[c].id, { w: compW, h: COMP_H });
        }
        compH = Math.ceil(groups.component.length / perRow) * (COMP_H + COMP_GAP);
      }
      // 组件行是整行宽,必须落在左右两列的**较高者**之下;旧实现按 mainH 放,
 // 侧栏比主列高时会与侧栏底部嵌套卡片重叠(UI 板「五态/连接测试探活」经验证叠卡)。
      var compTop = Math.max(sideH, mainH);
      var bodyH = compTop + (groups.component.length ? MAIN_GAP + compH : 0);
      // 局部坐标(相对容器左上;绝对化在总装步做)
      var yy = bodyTop;
      var sideSlots = [];
      for (var s2 = 0; s2 < groups.side.length; s2++) {
        var sidKid = groups.side[s2];
        sideSlots.push({ id: sidKid.id, x: 0, y: yy });
        // 嵌套孙槽位:section 槽内竖排(列窄,单列堆叠)
        var sdesc = nestedOf.get(sidKid.id) || [];
        for (var sd = 0; sd < sdesc.length; sd++) {
          size.set(sdesc[sd].id, { w: compW, h: COMP_H });
          sideSlots.push({ id: sdesc[sd].id, x: 0, y: yy + SIDE_H + 6 + sd * (COMP_H + 4) });
        }
        yy += sideItemH[s2] + SIDE_GAP;
      }
      var mainSlots = [];
      var my = bodyTop;
      for (var m2 = 0; m2 < groups.main.length; m2++) {
        var mainKid = groups.main[m2];
        mainSlots.push({ id: mainKid.id, x: mainX, y: my });
        // 嵌套孙槽位:section 槽内横排(按槽宽折行)
        var mdesc = nestedOf.get(mainKid.id) || [];
        var mnr = nestedRows(mainKid.id, mainSlotW);
        for (var md = 0; md < mdesc.length; md++) {
          size.set(mdesc[md].id, { w: compW, h: COMP_H });
          mainSlots.push({
            id: mdesc[md].id,
            x: mainX + (md % mnr.perRow) * (compW + COMP_GAP),
            y: my + MAIN_H + 6 + Math.floor(md / mnr.perRow) * (COMP_H + COMP_GAP),
          });
        }
        my += mainItemH[m2] + MAIN_GAP;
      }
      var cy = bodyTop + compTop + (groups.component.length ? MAIN_GAP : 0);
      var compSlots = [];
      for (var c2 = 0; c2 < groups.component.length; c2++) {
        var rowIdx = c2 % perRow;
        compSlots.push({ id: groups.component[c2].id, x: rowIdx * (compW + COMP_GAP), y: cy + Math.floor(c2 / perRow) * (COMP_H + COMP_GAP) });
      }
      // 底区
      var y3 = bodyTop + bodyH + BOTTOM_GAP;
      var bottomSlots = [];
      for (var b = 0; b < groups.bottom.length; b++) {
        size.set(groups.bottom[b].id, { w: innerW, h: BOTTOM_H });
        bottomSlots.push({ id: groups.bottom[b].id, x: 0, y: y3 });
        y3 += BOTTOM_H + BOTTOM_GAP;
      }
      var contentBottom = Math.max(y3 - BOTTOM_GAP, bodyTop + bodyH, bodyTop);
      // 浮层:右上悬浮,不占流
      var overlaySlots = [];
      var oy = HEAD_H + 12;
      for (var o = 0; o < groups.overlay.length; o++) {
        size.set(groups.overlay[o].id, { w: OVER_W, h: OVER_H });
        overlaySlots.push({ id: groups.overlay[o].id, x: innerW - OVER_W, y: oy });
        oy += OVER_H + OVER_GAP;
      }
      var contW = Math.max(contMinW, innerW + PAD * 2);
      var contH = Math.max(HEAD_H + 60, contentBottom + PAD);
      return {
        w: contW, h: contH,
        slots: topSlots.concat(sideSlots, mainSlots, compSlots, bottomSlots, overlaySlots).map(function (sl) {
          return { id: sl.id, x: sl.x + PAD, y: sl.y };
        }),
      };
    }

    var inner = new Map(); // pageId -> layoutInside 结果
    var maxPageW = CONT_MIN_W, maxPageH = 120;
    for (var p5 = 0; p5 < pageIds.length; p5++) {
      var kids2 = childrenOf.get(pageIds[p5]) || [];
      var inside = layoutInside(pageIds[p5], kids2);
      inner.set(pageIds[p5], inside);
      // docs deck:章容器尺寸=自身 maxPageW/H 口径;**章不参与「层间同高」与绝对定位占位**,
      // 章=容器只承载页(见下:章的 pos/size 直接由 layoutInside 结果给出,不进蛇形网格)。
      if (!docDeck || nodes.find(function (nn) { return nn.id === pageIds[p5]; }).kind !== "section") {
        maxPageW = Math.max(maxPageW, inside.w);
        maxPageH = Math.max(maxPageH, inside.h);
      }
    }

    // ---- 5) 层内排布(主线居中,分支按 barycenter 上下外扩)+ 蛇形换行 + 总装 ----
 // 蛇形:层×层宽超过单行预算(PAGE_ROW_W)自动折行(书页动线)——7 层电子签经验证单行排
    // 世界宽 2300+,1440 视口 fit 后容器缩到 ~90px 完全不可读;折行使世界宽≈行预算,全览可读
    var byLevel = new Map();
    for (var p6 = 0; p6 < pageIds.length; p6++) {
      var lv = level.get(pageIds[p6]) || 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(pageIds[p6]);
    }
    var lvs = Array.from(byLevel.keys()).sort(function (a, b) { return a - b; });
    var colsPerRow = Math.max(1, Math.floor((PAGE_ROW_W - MARGIN * 2) / (maxPageW + LAYER_GAP)));
    var rowGapBig = maxPageH + 90; // 折行行距(给跨行 nav 边留通道)
    var yOrder = new Map(); // pageId -> 层内序
    for (var li = 0; li < lvs.length; li++) {
      var arr = byLevel.get(lvs[li]).slice().sort(function (a, b) { return a < b ? -1 : 1; });
      var mains = arr.filter(function (id) { return mainNodes.has(id); });
      var branches = arr.filter(function (id) { return !mainNodes.has(id); });
      // barycenter:分支按相邻层已定 y 序的平均排;首层/无邻居按 id 序
      var centerOf = new Map();
      function neighborOrder(pid) {
        var vals = [];
        var outs4 = navAdj.get(pid) || []; // 前向邻接(回边已剥离,不参与重心)
        for (var i3 = 0; i3 < outs4.length; i3++) {
          var o = yOrder.get(outs4[i3].to);
          if (o !== undefined) vals.push(o);
        }
        // 入向(仅前向边)
        for (var j = 0; j < navEdges.length; j++) {
          if (navEdges[j].back || navEdges[j].to !== pid) continue;
          var o2 = yOrder.get(navEdges[j].from);
          if (o2 !== undefined) vals.push(o2);
        }
        return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      }
      var self = this; // eslint 占位
      for (var bi = 0; bi < branches.length; bi++) {
        var c2 = neighborOrder(branches[bi]);
        if (c2 === null) c2 = branches.indexOf(branches[bi]);
        centerOf.set(branches[bi], c2);
      }
      branches.sort(function (a, b) {
        var ca = centerOf.get(a), cb = centerOf.get(b);
        return (ca === cb) ? (a < b ? -1 : 1) : ca - cb;
      });
      // 主线节点放中位序(居中),分支上下外扩
      var ordered = [];
      var mid = Math.floor(branches.length / 2);
      for (var k2 = 0; k2 < branches.length; k2++) {
        if (k2 === mid && mains.length) ordered.push(mains[0]);
        ordered.push(branches[k2]);
      }
      if (mains.length && ordered.indexOf(mains[0]) < 0) ordered.push(mains[0]);
      for (var m3 = 1; m3 < mains.length; m3++) ordered.push(mains[m3]); // 多主线节点(理论少见)尾随
      for (var oi2 = 0; oi2 < ordered.length; oi2++) yOrder.set(ordered[oi2], oi2);
    }
    // page 容器绝对坐标(蛇形:row=floor(level/colsPerRow),col=level%colsPerRow)
    // docs deck:章(section 容器)不进蛇形网格——章沿 data 主线横排一行,页挂在各自章下;
    // 章的槽位(页卡)仍由 layoutInside 给出,随章原点平移。
    var isSectionContainer = function (id) {
      if (!docDeck) return false;
      var nn = nodes.find(function (x) { return x.id === id; });
      return !!nn && nn.kind === "section";
    };
    var chapIds = docDeck ? pageIds.filter(isSectionContainer) : [];
    var chapX = new Map();
    if (docDeck && chapIds.length) {
      // 章横排:按 level(=章在 data 链上的层)升序、同层按 yOrder;结论根等非容器在章行上方单独排
      chapIds.slice().sort(function (a, b) {
        var la = level.get(a) || 0, lb = level.get(b) || 0;
        if (la !== lb) return la - lb;
        var ya = yOrder.get(a) || 0, yb = yOrder.get(b) || 0;
        if (ya !== yb) return ya - yb;
        return a < b ? -1 : 1;
      }).forEach(function (cid, ci) {
        chapX.set(cid, MARGIN + ci * (maxPageW + LAYER_GAP * 2));
      });
    }
 // docs deck( 两层 PPT):每章一列——章头卡在列顶,页卡在章头下纵向堆叠;
    // 章×章沿 data 主线横排(章序=章在 data 链上的层)。结论根/其它非容器节点横排在章行上方。
    if (docDeck && chapIds.length) {
      var pagesOfChap = new Map(); // chapId -> [page...]
      for (var dce = 0; dce < edges.length; dce++) {
        var dcE = edges[dce];
        if ((dcE.kind || "") !== "contains") continue;
        var dcF = nm.get(dcE.from), dcT = nm.get(dcE.to);
        if (dcF && dcT && dcF.kind === "section" && dcT.kind === "page") {
          if (!pagesOfChap.has(dcF.id)) pagesOfChap.set(dcF.id, []);
          pagesOfChap.get(dcF.id).push(dcT.id);
        }
      }
      var chapColX = new Map();
 // 章序:优先沿章间 data 边拓扑推进(=planner 的汇报顺序),
      // 其次 label 数字前缀(01/02/…),最后 id——不能用 nav 分层(page 板语义,docs 章无 nav)。
      var chapOrder = (function () {
        var chapSet = new Set(chapIds);
        var dataAdj = new Map(); // from -> [to](章间 data)
        var indeg = new Map();
        for (var ci3 = 0; ci3 < chapIds.length; ci3++) { dataAdj.set(chapIds[ci3], []); indeg.set(chapIds[ci3], 0); }
        for (var de = 0; de < edges.length; de++) {
          var dE = edges[de];
          if ((dE.kind || "") !== "data") continue;
          if (!chapSet.has(dE.from) || !chapSet.has(dE.to)) continue;
          dataAdj.get(dE.from).push(dE.to);
          indeg.set(dE.to, (indeg.get(dE.to) || 0) + 1);
        }
        var labelNo = function (id) {
          var nn = nodes.find(function (x) { return x.id === id; });
          var mm2 = /^(\d{1,2})/.exec(String((nn && nn.label) || ""));
          return mm2 ? Number(mm2[1]) : 99;
        };
        var q = chapIds.filter(function (id) { return (indeg.get(id) || 0) === 0; })
          .sort(function (a, b) { return labelNo(a) - labelNo(b) || (a < b ? -1 : 1); });
        var order = [];
        while (q.length) {
          q.sort(function (a, b) { return labelNo(a) - labelNo(b) || (a < b ? -1 : 1); });
          var cur = q.shift();
          order.push(cur);
          var outs5 = dataAdj.get(cur) || [];
          for (var oe = 0; oe < outs5.length; oe++) {
            indeg.set(outs5[oe], (indeg.get(outs5[oe]) || 0) - 1);
            if ((indeg.get(outs5[oe]) || 0) <= 0 && order.indexOf(outs5[oe]) < 0) q.push(outs5[oe]);
          }
        }
        for (var rest2 = 0; rest2 < chapIds.length; rest2++) {
          if (order.indexOf(chapIds[rest2]) < 0) order.push(chapIds[rest2]);
        }
        return order;
      })();
      chapOrder.forEach(function (cid, ci) { chapColX.set(cid, MARGIN + ci * (maxPageW + LAYER_GAP)); });
      var maxColH = 0;
      var claimedByChap = new Set();
      // 结论根(aggregate)横排在章行上方:结论先行的视觉;非 aggregate 无归属节点仍落底部未归属区
      var topY = MARGIN;
      var rootNodes = nodes.filter(function (nn) { return nn.kind === "aggregate"; });
      var ROOT_H = 96;
      if (rootNodes.length) {
        for (var ri2 = 0; ri2 < rootNodes.length; ri2++) {
          size.set(rootNodes[ri2].id, { w: Math.max(300, Math.min(maxPageW, 640)), h: ROOT_H });
          pos.set(rootNodes[ri2].id, { x: MARGIN, y: topY + ri2 * (ROOT_H + 12) });
        }
        topY = MARGIN + rootNodes.length * (ROOT_H + 12) + 24;
      }
      for (var ci2 = 0; ci2 < chapIds.length; ci2++) {
        var cid2 = chapIds[ci2];
        var cIns = inner.get(cid2);
        var cx = chapColX.get(cid2);
        var cy = topY;
        size.set(cid2, { w: cIns.w, h: cIns.h });
        pos.set(cid2, { x: cx, y: cy });
        containers.set(cid2, { x: cx, y: cy, w: cIns.w, h: cIns.h });
        var colBottom = cy + cIns.h;
        var kids3 = pagesOfChap.get(cid2) || [];
        for (var ki = 0; ki < kids3.length; ki++) {
          var kIns = inner.get(kids3[ki]);
          var kY = colBottom + 14;
          size.set(kids3[ki], { w: kIns.w, h: kIns.h });
          pos.set(kids3[ki], { x: cx, y: kY });
          claimedByChap.add(kids3[ki]);
          colBottom = kY + kIns.h + 12;
        }
        maxColH = Math.max(maxColH, colBottom);
      }
      // 非容器非页节点(aggregate 结论根等):已在上方 top 条排过(rootNodes);其余按页区尾排
      for (var p7 = 0; p7 < pageIds.length; p7++) {
        var pid2 = pageIds[p7];
        if (chapColX.has(pid2) || claimedByChap.has(pid2)) continue;
        if (rootNodes.some(function (rn) { return rn.id === pid2; })) continue; // root 已排
        var ins = inner.get(pid2);
        size.set(pid2, { w: ins.w, h: ins.h });
        var lv2 = level.get(pid2) || 0;
        var ord = yOrder.get(pid2) || 0;
        var row = Math.floor(lv2 / colsPerRow);
        var col = lv2 % colsPerRow;
        pos.set(pid2, { x: MARGIN + col * (maxPageW + LAYER_GAP), y: MARGIN + row * rowGapBig + ord * (maxPageH + ROW_GAP) + maxColH });
      }
    } else {
      for (var p7 = 0; p7 < pageIds.length; p7++) {
        var pid2 = pageIds[p7];
        var ins = inner.get(pid2);
        size.set(pid2, { w: ins.w, h: ins.h });
        var lv2 = level.get(pid2) || 0;
        var ord = yOrder.get(pid2) || 0;
        var row = Math.floor(lv2 / colsPerRow);
        var col = lv2 % colsPerRow;
        var x = MARGIN + col * (maxPageW + LAYER_GAP);
        var y = MARGIN + row * rowGapBig + ord * (maxPageH + ROW_GAP);
        pos.set(pid2, { x: x, y: y });
        containers.set(pid2, { x: x, y: y, w: ins.w, h: ins.h });
        for (var sl = 0; sl < ins.slots.length; sl++) {
          pos.set(ins.slots[sl].id, { x: x + ins.slots[sl].x, y: y + ins.slots[sl].y });
        }
      }
    }
    // ---- 6) 孤立节点(无 contains 归属的非 page):底部「未归属」区(诚实呈现,不编造归属) ----
    // docs deck:aggregate 结论根已在章行上方排过(pos 已 set),不算孤立
    var orphans = [];
    for (var n2 = 0; n2 < nodes.length; n2++) {
      if (claimed.has(nodes[n2].id) || isPage.has(nodes[n2].id)) continue;
      if (docDeck && nodes[n2].kind === "aggregate" && pos.has(nodes[n2].id)) continue;
      orphans.push(nodes[n2]);
    }
    if (orphans.length) {
      var maxLayerBottom = MARGIN, maxWorldX = MARGIN;
      for (var p8 = 0; p8 < pageIds.length; p8++) {
        var ct = containers.get(pageIds[p8]);
        if (!ct) continue;
        maxLayerBottom = Math.max(maxLayerBottom, ct.y + ct.h);
        maxWorldX = Math.max(maxWorldX, ct.x + ct.w);
      }
 // 修复(note 类小卡整片压在页卡上):旧口径只扫 pageIds 的容器 rect。docs deck 的页卡
 // (pg1..pgN)不是容器、堆在章头容器**下方**,其底沿远低于章底(经验证章底 239 vs 页底 467)
      // → 未归属带 y 落到 289,正好横插进页卡带,note 小卡把 P1/P2 的标题+摘要盖住(docs 三主题各 10 对重叠)。
      // 改为「所有已定位节点(pos+size)的外接框」:未归属带恒在最深内容之下,任何板型都不再压卡。
      pos.forEach(function (p, id) {
        var sz2 = size.get(id);
        if (!sz2) return;
        maxLayerBottom = Math.max(maxLayerBottom, p.y + sz2.h);
        maxWorldX = Math.max(maxWorldX, p.x + sz2.w);
      });
      var oy2 = maxLayerBottom + ORPHAN_TAG_H + 20;
      // 槽宽按「实际会渲染出来的卡宽」给(.cv-node 基础宽 216px;旧值 COMP_W*2=168 比卡窄 48px,
      // 相邻两槽间距 COMP_GAP=8 → 每对邻卡水平互压 40px,落地 manifest 又被算进重叠)。
 // 槽高按内容给:带 summary 的 note 经验证 119px(标题+摘要),无 summary 的 ~54px。
      var ORPH_W = 216, ORPH_H_SUM = 119, ORPH_H_MIN = 54;
      var orphH = function (nn) { return nn && String(nn.summary || "").trim() ? ORPH_H_SUM : ORPH_H_MIN; };
      var maxOrphH = ORPH_H_MIN;
      for (var oh = 0; oh < orphans.length; oh++) maxOrphH = Math.max(maxOrphH, orphH(orphans[oh]));
      var per = Math.max(1, Math.floor((maxWorldX - MARGIN + COMP_GAP) / (ORPH_W + COMP_GAP)));
      for (var o3 = 0; o3 < orphans.length; o3++) {
        roles.set(orphans[o3].id, "orphan");
        size.set(orphans[o3].id, { w: ORPH_W, h: orphH(orphans[o3]) });
        pos.set(orphans[o3].id, {
          x: MARGIN + (o3 % per) * (ORPH_W + COMP_GAP),
          y: oy2 + Math.floor(o3 / per) * (maxOrphH + COMP_GAP),
        });
      }
    }
    return {
      pos: pos, size: size,
      mainNodes: mainNodes, mainEdges: mainEdges,
      backEdges: backEdges, selfLoops: selfLoops,
      crossEdges: crossEdges,
      roles: roles, level: level, containers: containers,
      orphanCount: orphans.length,
    };
  }

  return { layout: layout, uiRole: uiRole };
});
