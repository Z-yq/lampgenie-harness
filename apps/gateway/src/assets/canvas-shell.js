/* canvas-shell.js —— 无限画布外壳(2026-10-20 用户口径:把 17 个视图改成画布上的卡片,
 * 卡片可自由拖动/缩放;2026-10-21 双导航融合:左侧窄定位栏 cvRail 退役,导航/唤回/状态点归侧栏托盘)。
 *
 * 设计原则(为什么是「外壳」而不是重写视图):
 *  - 全部 17 个 #view-* 保持原 DOM 与原有监听器/渲染函数不动,本文件只把它们**挪**进卡片容器
 *    (DOM 移动不销毁监听器),因此 17k 行面板逻辑零改写;经典单视图布局随时可切回。
 *  - 画布只做几何:世界坐标(px)+ 视口 transform(translate/scale),卡片在图上是 absolute 矩形。
 *  - 「可见即量尺寸」类逻辑(白板 wbResize / 终端 fit / 看板布局)通过 bridge.resized(name) 回调重算;
 *    卡片用 visibility:hidden 离屏剔除(不 display:none,保住 rect 有效,量尺寸不会变 0)。
 *  - 布局持久化 zh:cv-layout;形态开关 zh:cv-mode(canvas|classic);Ctrl+Shift+C 切换。
 *
 * 对外 API(window.CanvasShell):init/focus/fitAll/fitCard/zoomStep/zoomReset/setMode/isCanvas/
 *   inView/liveNames/showCard/hideCard/resetLayout/__geom(纯函数,单测用)
 */
(function () {
  "use strict";
  if (window.CanvasShell) return;

  var VERSION = "002";
  var LS_LAYOUT = "zh:cv-layout";
  var LS_MODE = "zh:cv-mode";
  var MIN_W = 320;
  var MIN_H = 200;
  var SNAP = 8;                 // 网格吸附(px)
  var HEAD_H = 60;              // 卡片标题栏高度(Dify 风:图标 + 标题/副标题两行;运行时以实测为准,见 headH)
  // 缩放下限:全览需要把整个画布世界装进安全区(CV_CARDS 最远卡片 x=5320+900、y=2280+760 → 6220×3040;
  // step-1535 增轨迹卡(w=900)后世界宽 6080→6220,step-141 增 IDE 卡后全高 3040;旧注释 5240×1640 是三卡落位之前的旧世界尺寸)。
  // 低倍率可读性由 LOD 负责(见 applyView);世界尺寸本身由 boundsOf(visibleRects()) 现算,此处只记录 0.1 下限的依据。
  var Z_MIN = 0.1;
  // 概览 LOD 三档滞回(2026-10-21:单阈 0.45 硬切 = 跨阈瞬间同步改全部卡片 DOM,大板卡顿;
  // 且阈值附近轻微缩放会反复穿越 → 抖动)。进入阈值低、退出阈值高 = 滞回死区,防抖。
  //   s < LOD_IN         → 进入 LOD
  //   s > LOD_OUT        → 退出 LOD
  //   LOD_IN..LOD_OUT 之间 → 保持当前态(LOD_MID 为设计意义上的中位参考值,亦是 LOD 视觉重心)
  var LOD_IN = 0.40;            // 进 LOD:低于此缩放才降级(比旧 0.45 更晚降级)
  var LOD_MID = 0.45;           // LOD 中位参考(滞回死区中值,供档位/调试口径复用)
  var LOD_OUT = 0.56;           // 出 LOD:高于此缩放才恢复正文(比旧 0.45 更早恢复)
  var Z_MAX = 2;
  var CULL_PAD = 240;           // 离屏剔除的宽容边(px,屏幕坐标)
  // 取景可读性下限:整卡入画时若按安全区能装下 ≥ 0.7,就不许取更小的倍率(900×600 实测只到 49%,
  // 内容小到看不清;按安全区重算是 ~74%)。装不下时仍按装得下的值——不为下限牺牲「全部入画」。
  var FIT_MIN_S = 0.7;
  var HEAVY = { board: 1, browser: 1, project: 1, term: 1 }; // 重件:额外绘制隔离

  /** 卡片图标(24 格 stroke 风格,与面板其余图标同构)。模块 → 图标 path,找不到用方块兜底。
   *  由内置换算而非面板传入:面板是 17k 行模板字符串,内联 SVG 的反斜杠/引号是最易炸的写法(参见
   *  test/panel-script-syntax.test.ts 记录的事故),把图标留在资产里 = 模板零风险。 */
  var ICONS = {
    chat: '<path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.5A8 8 0 0 1 12 4h1a8 8 0 0 1 8 8z"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 10l3 2.5L7 15"/><line x1="12.5" y1="15.5" x2="17" y2="15.5"/>',
    git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><line x1="6" y1="8.2" x2="6" y2="15.8"/><path d="M18 11.2c0 3.4-4.2 4.3-8.4 4.6"/>',
    files: '<path d="M4 6.5A2 2 0 0 1 6 4.5h4l2 2h6a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><line x1="8" y1="12" x2="16" y2="12"/>',
    /* IDE(step-141):窗口内代码括号对 + 底部基线(vscode 风格编辑器语汇) */
    ide: '<path d="M8.5 4.5h-3a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/><path d="M15.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/><path d="M11 12h2M9 8.5l-2.5 3.5L9 15.5M15 8.5l2.5 3.5L15 15.5"/>',
    board: '<path d="M4 20l4.5-1L20 7.5a2 2 0 0 0 0-3L19.5 4a2 2 0 0 0-3 0L5 15.5z"/><line x1="14.5" y1="6.5" x2="17.5" y2="9.5"/>',
    project: '<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="4" width="7" height="5" rx="1.5"/><rect x="8.5" y="15" width="7" height="5" rx="1.5"/><path d="M6.5 9v3.5h11V9"/><line x1="12" y1="12.5" x2="12" y2="15"/>',
    sense: '<circle cx="11" cy="11" r="6.5"/><line x1="20.5" y1="20.5" x2="16" y2="16"/><line x1="11" y1="8" x2="11" y2="11"/><line x1="11" y1="11" x2="13.5" y2="12.5"/>',
    wf: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    exp: '<rect x="3" y="3" width="7" height="7" rx="1.8"/><rect x="14" y="3" width="7" height="7" rx="1.8"/><rect x="3" y="14" width="7" height="7" rx="1.8"/><rect x="14" y="14" width="7" height="7" rx="1.8"/>',
    team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.9.4 5 2.8 5 5.8"/>',
    nodes: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="13" width="7" height="7" rx="1.5"/><line x1="14" y1="16.5" x2="21" y2="16.5"/><line x1="17.5" y1="13" x2="17.5" y2="20"/>',
    approvals: '<path d="M12 3l7 3v6c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    market: '<path d="M4 8h16l-1.2 11a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8z"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2"/>',
    browser: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.4 3.6 5.4 3.6 8.5S14.4 18.1 12 20.5C9.6 18.1 8.4 15.1 8.4 12S9.6 5.9 12 3.5z"/>',
    sys: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    /* 子代理:顶部人形 + 两条向下分叉(组织图语汇) */
    subagents: '<circle cx="12" cy="5.4" r="2.6"/><path d="M12 8v3.4"/><path d="M12 11.4c-4.4 0-6.6 1.8-6.6 4.6v1.6"/><path d="M12 11.4c4.4 0 6.6 1.8 6.6 4.6v1.6"/><circle cx="5.4" cy="19" r="1.9"/><circle cx="18.6" cy="19" r="1.9"/>',
    /* 子agent会话流:双气泡(主/子两条对话流,独立成卡) */
    subchat: '<path d="M4 5.5A2 2 0 0 1 6 3.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-4 3z"/><path d="M16 8.5h2.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H16l-3 2.5v-2.5h-.5"/>',
    /* 轨迹:层叠勾选(三条横线 + 右侧两个勾) */
    track: '<line x1="3.5" y1="6.5" x2="14" y2="6.5"/><line x1="3.5" y1="12" x2="11" y2="12"/><line x1="3.5" y1="17.5" x2="8.5" y2="17.5"/><path d="M14.8 11.4l2 2 4-4.4"/><path d="M14.8 17.2l2 2 4-4.4"/>',
    /* 用量:柱状图(三根高低竖线 + 基准横线) */
    usage: '<line x1="4" y1="20" x2="20" y2="20"/><line x1="7.5" y1="20" x2="7.5" y2="14"/><line x1="12" y1="20" x2="12" y2="7"/><line x1="16.5" y1="20" x2="16.5" y2="11"/>',
  };
  function iconOf(sp) {
    var d = ICONS[sp.name] || '<rect x="4" y="4" width="16" height="16" rx="3"/>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
  }

  // ---------- 纯几何(单测入口) ----------
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function snap(v) { return Math.round(v / SNAP) * SNAP; }
  function normRect(r) {
    return {
      x: Number.isFinite(r.x) ? r.x : 0,
      y: Number.isFinite(r.y) ? r.y : 0,
      w: clamp(Number.isFinite(r.w) ? r.w : 640, MIN_W, 100000),
      h: clamp(Number.isFinite(r.h) ? r.h : 480, MIN_H, 100000),
    };
  }
  /* ---- 存储布局归一化(2026-10-21 卡头标题压叠修复) ----
   * 实锤路径:localStorage 旧档两类脏值会把非法坐标写进 style ——
   *  ① JSON.stringify(NaN) 落盘成 null → 加载端 x:null 进 style.left="nullpx",
   *    非法声明被浏览器整条丢弃 → absolute 卡片退回静态位置,所有脏卡叠在同一静态点,
   *    卡头(标题行)文字互相压叠(用户截图实锤);
   *  ② 条目缺字段 → Math.max(MIN_W, undefined)=NaN → width:"NaNpx" 同炸。
   * 归一化:逐字段 Number.isFinite,坏字段回退默认布局 def 的同名字段;w/h 钳 [MIN,1e5];
   * x/y 钳 ±XY_LIMIT —— 世界坐标没有硬边界,上限只拦「坐标写到 1e9 卡片永远拉不回」的脏档
   * (正常画布 5240×1640,极限拖拽也远够不到 1e5)。 */
  var XY_LIMIT = 100000;
  function normSavedCard(sc, def) {
    var d = def || normRect({});
    function num(v, dflt, lo, hi) {
      // null 必须当非法:JSON.stringify(NaN) 落盘成 null,而 Number(null)=0 会把坏值洗成合法 0(w 再 clamp 到 MIN,
      // 坏坐标悄悄变成「贴 0 的合法坐标」)。null/undefined/NaN/非数值 → 回退默认布局同名字段。
      var n = v === null || v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
    }
    return {
      x: num(sc && sc.x, d.x, -XY_LIMIT, XY_LIMIT),
      y: num(sc && sc.y, d.y, -XY_LIMIT, XY_LIMIT),
      w: num(sc && sc.w, d.w, MIN_W, 100000),
      h: num(sc && sc.h, d.h, MIN_H, 100000),
    };
  }
  /** 升级播种(纯函数):savedNames 里缺席、defLayout 里在册的卡 = 本次升级新增的卡。
   *  落位紧贴 chat 卡右侧竖排(28/24 间距),避免按默认坐标落到用户视口外(x:5320 之远)
   *  造成「新卡不存在」的错觉(2026-10-21 用户实报:子agent会话流卡找不到)。
   *  无 chat 几何或无缺失卡返回 null(调用方不动任何卡;全新用户无存档也不走此路径)。 */
  function seedMissing(savedNames, defLayout, chatG) {
    if (!chatG || !defLayout) return null;
    var out = [];
    var x = chatG.x + chatG.w + 28;
    var y = chatG.y;
    for (var n in defLayout) {
      if (!Object.prototype.hasOwnProperty.call(defLayout, n)) continue;
      if (savedNames && savedNames[n]) continue;
      var d = defLayout[n];
      out.push({ n: n, x: x, y: y, w: d.w, h: d.h });
      y += d.h + 24;
    }
    return out.length ? out : null;
  }
  /** 视口内某点缩放:保持光标下的世界坐标不动。v={x,y,s} → 新 v。 */
  function zoomAround(v, px, py, factor) {
    var s2 = clamp(v.s * factor, Z_MIN, Z_MAX);
    if (s2 === v.s) return { x: v.x, y: v.y, s: v.s };
    var wx = (px - v.x) / v.s;
    var wy = (py - v.y) / v.s;
    return { x: px - wx * s2, y: py - wy * s2, s: s2 };
  }
  /** 全部卡片的并集包围盒(世界坐标)。 */
  function boundsOf(list) {
    if (!list || !list.length) return { x: 0, y: 0, w: 1, h: 1 };
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }
  /** 让 rect 适配 host 视口(留 pad),返回 {x,y,s}。 */
  function fitView(rect, hostW, hostH, pad) {
    var p = Number.isFinite(pad) ? pad : 48;
    var availW = Math.max(80, hostW - p * 2);
    var availH = Math.max(80, hostH - p * 2);
    var s = clamp(Math.min(availW / rect.w, availH / rect.h), Z_MIN, Z_MAX);
    return {
      x: (hostW - rect.w * s) / 2 - rect.x * s,
      y: (hostH - rect.h * s) / 2 - rect.y * s,
      s: s,
    };
  }
  /** 让 rect 居中并按需放大(不缩太小:不低于 minScale)。 */
  function centerOn(rect, hostW, hostH, scale) {
    var s = clamp(scale, Z_MIN, Z_MAX);
    return {
      x: hostW / 2 - (rect.x + rect.w / 2) * s,
      y: hostH / 2 - (rect.y + rect.h / 2) * s,
      s: s,
    };
  }
  /** 默认排布:spec 里带 x/y/w/h 的照用;缺的按 flow 顺序补位。 */
  function layoutFromSpecs(specs, startY) {
    var out = {}, y = Number.isFinite(startY) ? startY : 0, x = 0, rowH = 0, maxW = 2400;
    for (var i = 0; i < specs.length; i++) {
      var sp = specs[i];
      if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.y)) {
        out[sp.name] = normRect({ x: sp.x, y: sp.y, w: sp.w, h: sp.h });
        continue;
      }
      var r = normRect({ w: sp && sp.w, h: sp && sp.h });
      if (x > 0 && x + r.w > maxW) { x = 0; y += rowH + 40; rowH = 0; }
      out[sp.name] = { x: x, y: y, w: r.w, h: r.h };
      x += r.w + 40;
      rowH = Math.max(rowH, r.h);
    }
    return out;
  }

  // ---------- 状态 ----------
  var S = {
    ready: false,
    built: false,
    mode: "canvas",
    host: null, world: null, root: null, mini: null, hud: null,
    cards: {},            // name -> { el, head, body, spec, g:{x,y,w,h,z,hidden,min} }
    order: [],
    view: { x: 0, y: 0, s: 1 },
    zTop: 1,
    bridge: null,
    moves: [],            // [{node, parent, next}] 出画布时归位用
    focused: "",
    rafPending: false,
    saveTimer: 0,
    resTimer: 0,
    panning: false,
    drag: null,
    sel: [],              // Dify 风多选:被选中的卡片名(空=单选/无选)
    ctrlMode: "hand",     // hand=空白拖拽平移(Dify panOnDrag);pointer=空白拖拽框选(Dify selectionOnDrag)
    marquee: null, guideV: null, guideH: null,
  };

  function zOf() {
    var z = parseFloat(document.body.style.zoom || "1");
    return Number.isFinite(z) && z > 0 ? z : 1;
  }
  function hostRect() {
    var r = S.host.getBoundingClientRect();
    var z = zOf();
    return { left: r.left, top: r.top, w: r.width / z, h: r.height / z };
  }
  /** 屏幕客户端坐标 → host 内部的未缩放局部坐标(抵消 body zoom)。 */
  function localXY(ev) {
    var h = hostRect();
    var z = zOf();
    return { x: (ev.clientX - h.left) / z, y: (ev.clientY - h.top) / z };
  }

  // ---------- 样式 ----------
  function injectStyle() {
    if (document.getElementById("cv-style")) return;
    var css = [
      /* 画布容器(挂在 .middle 里,absolute 铺满) */
      /* 画布容器(挂在 .middle 里,absolute 铺满)。
       * 注意:这里**不能**设 z-index——一旦 cvRoot 形成层叠上下文,内部 #cvMiniShell/#cvHud 的
       * z-index 就只在 cvRoot 内比较,浮动侧栏托盘(z-index 高于 cvRoot 时)会整体压住小地图/HUD;
       * 交给 body 层统一比 z-index,各浮层按自己的数值排队。 */
      "#cvRoot{position:absolute;inset:0;overflow:hidden}",
      /* id 用 #cvShellHost(带 Shell 后缀):面板自己的画布床(.bf-canvas)已占用不带后缀的同名 id,
       * 撞 id 后这条 inset:0 全屏规则会连着把面板画布床也撑成全屏,盖住右侧明细区(评论改/删点不到)。 */
      "#cvShellHost{position:absolute;inset:0;overflow:clip;cursor:grab;background:var(--window-bg,transparent)}",
      "#cvShellHost.cv-grabbing{cursor:grabbing}",
      "#cvShellHost:before{content:\"\";position:absolute;inset:0;pointer-events:none;opacity:.5;",
      "  background-image:radial-gradient(circle at 1px 1px, var(--border-soft) 1px, transparent 0);",
      "  background-size:var(--cv-g,24px) var(--cv-g,24px);background-position:var(--cv-ox,0px) var(--cv-oy,0px)}",
      /* 文字锐利(2026-10-21 画布卡文字模糊根治):世界层**不再常驻 will-change**——
       * 常驻提升会把整块世界(含所有卡片文字)按缩放瞬间的倍率栅格化成合成层纹理,缩放停止后
       * 文字仍是那张被拉伸的旧纹理(用户实报「每个看板的字模模糊糊」)。改为只在交互进行中
       * (applyView 打 .cv-moving,静止 180ms 后移除)提升层保拖拽/缩放顺滑;静止即解除提升,
       * 浏览器按最终设备像素重绘文字 → 锐利。Windows 缩放(dpr 1.25/1.5)下的分数设备像素同理受益。 */
      "#cvWorldShell{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}",
      "#cvWorldShell.cv-moving{will-change:transform}",
      /* 卡片 */
      ".cv-card{position:absolute;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:12px;",
      "  background:var(--window-bg,rgba(10,7,5,.94));box-shadow:0 18px 48px rgba(0,0,0,.42);overflow:hidden;",
      "  contain:layout paint}",
      ".cv-card.on{border-color:var(--bronze);box-shadow:0 18px 54px rgba(0,0,0,.5),0 0 0 1px var(--bronze-glow)}",
      /* 离屏剔除:卡片离视口时只把正文藏起来(保留盒子尺寸,量尺寸逻辑不会读到 0)。
       * transition:none = 剔除是纯性能手段,不需要跟 LOD 的 .22s 过渡一起淡出/淡入。 */
      ".cv-card.off .cv-card-body{visibility:hidden;transition:none}",
      /* ---- 概览 LOD(低倍率总览):卡头与字号按 1/缩放比 反缩放,屏幕尺寸恒定可读 ----
       * 不用 transform/zoom 反向补偿(会和世界 scale 打架、且 zoom 在旧内核不支持),
       * 一律用 calc(px / var(--cv-s)) 让世界坐标下的尺寸在屏幕上回到原值。 */
      "body.cv-lod .cv-card{border-radius:calc(12px / var(--cv-s,1))}",
      /* LOD 软过渡(2026-10-21):正文/工具条/缩放手柄改为 visibility+opacity,不再 display:none,
       * 否则跨阈是硬切(display 不可过渡)。三档滞回(LOD_IN/LOD_OUT)保证不会在阈值附近来回抖。
       * 过渡写在「基础规则」而不是 body:not(.cv-lod) 反向规则上:后者特异性(0,2,1)会压过离屏剔除
       * `.cv-card.off .cv-card-body{visibility:hidden}`(0,2,0) → 离屏卡的正文又变可见,剔除失效。
       * 基础规则常在场,所以 LOD 进/出两个方向都能过渡,且不影响 .off 的即时隐藏。 */
      ".cv-card-body,.cv-card-tools,.cv-rs{transition:opacity .22s ease,visibility .22s}",
      "body.cv-lod .cv-card-body,body.cv-lod .cv-card-tools,body.cv-lod .cv-rs{visibility:hidden;opacity:0}",
      /* LOD 卡片收缩到卡头高:正文藏了以后卡片还留着 g.h(640/720)就是一大片空洞。
       * 目标 = 卡头屏幕高 58px 反算回世界高(58/s),与下面卡头规则同口径。
       * 不用 min(...,100%) 收口:允许的包含块 #cvWorldShell 是 0×0,百分比高度会解析成 0 → 卡片整张消失。
       * !important 必须有:applyCard() 给 .cv-card 写了内联 height。 */
      "body.cv-lod .cv-card{height:calc(58px / var(--cv-s,1))!important;overflow:hidden;transition:height .22s ease}",
      "body.cv-lod .cv-card-head{height:min(calc(58px / var(--cv-s,1)),100%);padding:0 calc(8px / var(--cv-s,1));",
      "  gap:calc(9px / var(--cv-s,1));cursor:pointer}",
      "body.cv-lod .cv-card-ico{width:calc(26px / var(--cv-s,1));height:calc(26px / var(--cv-s,1));",
      "  border-radius:calc(7px / var(--cv-s,1))}",
      "body.cv-lod .cv-card-ico svg{width:calc(15px / var(--cv-s,1));height:calc(15px / var(--cv-s,1))}",
      "body.cv-lod .cv-card-txt{gap:calc(1px / var(--cv-s,1))}",
      "body.cv-lod .cv-card-title{font-size:calc(12.5px / var(--cv-s,1));letter-spacing:calc(1.2px / var(--cv-s,1))}",
      "body.cv-lod .cv-card-sub{font-size:max(calc(9.5px / var(--cv-s,1)),10px);color:var(--muted)}",
      /* 2026-10-21:离屏卡跳过渲染布局(治 LOD 跨阈 87ms 长任务峰),进入视口自动恢复 */
      ".cv-card-body{content-visibility:auto;contain-intrinsic-size:auto 400px}",
      "body.cv-lod .cv-card-dot{width:calc(7px / var(--cv-s,1));height:calc(7px / var(--cv-s,1))}",
      /* ---- Dify 风卡片头:图标块 + 标题/副标题两行 + 状态点 + 工具 ---- */
      ".cv-card-head{display:flex;align-items:center;gap:9px;height:" + HEAD_H + "px;padding:0 8px 0 8px;flex-shrink:0;",
      "  background:var(--glass2);border-bottom:1px solid var(--border-soft);cursor:move;user-select:none}",
      ".cv-card.on .cv-card-head{background:var(--accent-soft)}",
      /* 图标块(Dify block-icon 的方角圆底) */
      ".cv-card-ico{width:26px;height:26px;flex-shrink:0;border-radius:7px;display:flex;align-items:center;justify-content:center;",
      "  background:var(--chip-bg);border:1px solid var(--border-soft)}",
      ".cv-card-ico svg{width:15px;height:15px;stroke:var(--muted);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}",
      ".cv-card.on .cv-card-ico{border-color:var(--bronze);background:rgba(201,143,69,.12)}",
      ".cv-card.on .cv-card-ico svg{stroke:var(--accent-bright)}",
      /* 标题/副标题两行 */
      ".cv-card-txt{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}",
      ".cv-card-title{font-family:var(--serif);font-size:12.5px;letter-spacing:1.5px;color:var(--text);",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.25}",
      ".cv-card-sub{font-size:9.5px;letter-spacing:.4px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cv-card.on .cv-card-sub{color:var(--muted)}",
      /* 状态点(忙/警告/就绪;面板可经 setCardStatus 推) */
      ".cv-card-dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex-shrink:0;margin-right:1px}",
      ".cv-card-dot.st-run{background:var(--bronze);box-shadow:0 0 8px var(--bronze-glow);animation:cvDotBreath 1.6s ease-in-out infinite}",
      ".cv-card-dot.st-warn{background:var(--warn,#d9b36c)}",
      ".cv-card-dot.st-fail{background:var(--red,#e08a7a)}",
      ".cv-card-dot.st-ok{background:var(--green,#9dc08b)}",
      "@keyframes cvDotBreath{0%,100%{opacity:.35}50%{opacity:1}}",
      ".cv-card-tag{font-size:9px;letter-spacing:1px;color:var(--faint);border:1px solid var(--border-soft);",
      "  border-radius:4px;padding:0 4px;flex-shrink:0}",
      ".cv-card-tools{margin-left:auto;display:flex;gap:2px;flex-shrink:0}",
      /* 卡头按钮/缩放手柄一律用屏幕恒定尺寸:卡片整体在世界坐标里缩放,
       * 写死 px 会在 0.5 倍时只剩 12px(点不中)、1:1 时又偏小 → 用 1/缩放比 反算。 */
      ".cv-card-tools button{width:calc(24px / var(--cv-s,1));height:calc(24px / var(--cv-s,1));border:0;",
      "  border-radius:calc(6px / var(--cv-s,1));background:transparent;color:var(--faint);",
      "  font-size:calc(12px / var(--cv-s,1));line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer}",
      ".cv-card-tools button:hover{background:var(--hover-bg2);color:var(--text)}",
      ".cv-card-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      /* 视图节点在卡片里恒可见(经典态才靠 .on 单显) */
      "body.cv-shell .cv-card-body>.view{display:flex!important;flex:1!important;min-height:0;overflow-y:auto}",
      "body.cv-shell .cv-card-body>.view{animation:none!important}",
      /* 重件卡(白板/浏览器/终端/代码档案)正文独立绘制:全览时 15 张卡同时在场,重件重绘会拖垮整个画布 */
      "body.cv-shell .cv-card.cv-heavy>.cv-card-body{contain:paint}",
      /* 正文外层不再自己滚(视图内部已是 flex 滚动容器,外层再 auto 会长内容卡出现两条竖滚条);
       * 滚轮交给 scrollableUnder(卡片内可滚区域由内层接管)。 */
      "body.cv-shell .cv-card-body{overflow:hidden}",
      "body.cv-shell .cv-card-body>.panel-wrap{padding:10px 10px 12px}",
      /* 对话卡内 composer */
      "body.cv-shell footer{display:block!important;padding:0 10px 8px 10px;flex-shrink:0}",
      "body.cv-shell .cv-card[data-name=chat] .chat-col{padding:10px 6px 10px 10px}",
      /* 画布形态下整页让位:旧浮层背景退场,右侧不留 38vw */
      "body.cv-shell .page{padding-right:8px}",
      /* ---- 屏幕 chrome 不固定(2026-10-20 二期;2026-10-21 双导航融合:cvRail 定位栏退役,
       * 导航/唤回/状态点/托盘收起全部归侧栏托盘,画布左缘留白归还给画布世界)----
       * 以下全部只在 body.cv-shell 下生效,经典布局零影响。 */
      /* ① 顶部 header 整条退场(连接点下沉到托盘品牌点,面板侧 cvConn 维护,信息不丢) */
      "body.cv-shell header{display:none!important}",
      /* ② 视图已在卡片内,不需要给固定侧栏让位 */
      "body.cv-shell .page{padding-left:0!important}",
      "body.cv-shell .middle{height:100vh}",
      /* ③ 侧栏 → 浮动导航托盘:位置/宽度走 CSS 变量(拖拽改变量,持久化到 zh:cv-tray) */
      "body.cv-shell #sidebar{position:fixed;left:var(--cv-tray-x,56px);top:var(--cv-tray-y,12px);bottom:auto;",
      "  right:auto;width:var(--cv-tray-w,264px);height:auto;max-height:calc(100vh - 24px);",
      "  border:1px solid var(--border);border-radius:12px;background:var(--window-bg,rgba(10,7,5,.94));",
      "  box-shadow:0 20px 56px rgba(0,0,0,.5);backdrop-filter:blur(10px);z-index:6;overflow:hidden}",
      "body.cv-shell #sidebar.hidden{transform:none;display:none}",
      "body.cv-shell.sb-hidden #sidebar{display:none}",
      /* 托盘内部滚动:任务列表自己滚,托盘不整块滚 */
      "body.cv-shell #sidebar #taskList{max-height:min(46vh,420px)}",
      /* ④ 托盘标题条=拖拽把手(除品牌区外,右侧留出收起钮) */
      "body.cv-shell .sb-brand{cursor:move;user-select:none}",
      "body.cv-shell .sb-brand:before{content:'';width:4px;height:14px;border-radius:2px;margin-right:-2px;",
      "  background:repeating-linear-gradient(to bottom,var(--faint) 0 2px,transparent 2px 4px);opacity:.5}",
      /* ⑤ 旧的右缘宽度拖拽柄(#sbDrag 按 --sbw 定位,浮动后位置全错)在画布形态下退役,
       *    改用托盘右缘手柄 .cv-tray-rs(改 --cv-tray-w,与位置拖拽互不抢指针) */
      "body.cv-shell #sbDrag{display:none!important}",
      ".cv-tray-rs{display:none}",
      "body.cv-shell .cv-tray-rs{display:block;position:absolute;top:8px;bottom:8px;right:0;width:5px;cursor:ew-resize;z-index:3}",
      "body.cv-shell .cv-tray-rs:hover{background:var(--accent-soft)}",
      /* ⑥ 收起态:托盘隐藏后由既有 #sbRail 细轨(44px,logo+新建)承接唤回(Ctrl+B 同源)——
       *    cvRail 退役后不再需要互斥避让;sbRail 的让位在 safeArea 里按需计算 */
      /* ⑦ 文件树滑入层仍是托盘内的 absolute;托盘改 fixed 后它仍以托盘为包含块(不铺满全屏) */
      "body.cv-shell #sbFt{border-radius:12px}",
      "body.cv-shell #view-tasks .empty-line{margin-top:24px}",
      /* 缩放手柄 */
      ".cv-rs{position:absolute;z-index:3}",
      ".cv-rs[data-dir=n]{left:8px;right:8px;top:0;height:5px;cursor:ns-resize}",
      ".cv-rs[data-dir=s]{left:8px;right:8px;bottom:0;height:5px;cursor:ns-resize}",
      ".cv-rs[data-dir=w]{top:8px;bottom:8px;left:0;width:5px;cursor:ew-resize}",
      ".cv-rs[data-dir=e]{top:8px;bottom:8px;right:0;width:5px;cursor:ew-resize}",
      ".cv-rs[data-dir=nw]{left:0;top:0;width:10px;height:10px;cursor:nwse-resize}",
      ".cv-rs[data-dir=ne]{right:0;top:0;width:10px;height:10px;cursor:nesw-resize}",
      ".cv-rs[data-dir=sw]{left:0;bottom:0;width:10px;height:10px;cursor:nesw-resize}",
      ".cv-rs[data-dir=se]{right:0;bottom:0;width:10px;height:10px;cursor:nwse-resize}",
      /* ---- Dify 风多选/辅助线(期 2):框选矩形、选中卡描边、对齐参考线 ---- */
      ".cv-card.sel{outline:2px solid var(--bronze);outline-offset:1px;border-color:var(--bronze)}",
      ".cv-card.sel .cv-card-head{background:rgba(201,143,69,.18)}",
      /* 右键菜单(卡片/空白/多选三态共用一套容器,内容随上下文换) */
      "#cvCtx{position:fixed;z-index:200;min-width:186px;max-width:min(320px,92vw);padding:5px;",
      "  background:var(--solid,#141009);border:1px solid var(--border);border-radius:10px;",
      "  box-shadow:0 14px 44px rgba(0,0,0,.55);font-size:12px;color:var(--text)}",
      "#cvCtx .cv-ctx-it{padding:6px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "#cvCtx .cv-ctx-it:hover{background:var(--hover-bg2);color:var(--accent-bright)}",
      "#cvCtx .cv-ctx-it.danger{color:var(--red,#e08a7a)}",
      "#cvCtx .cv-ctx-sep{height:1px;margin:4px 6px;background:var(--border-soft)}",
      "#cvMarquee{position:absolute;z-index:45;border:1px solid var(--bronze);background:rgba(201,143,69,.10);",
      "  pointer-events:none;display:none;border-radius:2px}",
      ".cv-guide{position:absolute;z-index:44;background:var(--accent-bright);opacity:.75;pointer-events:none;display:none}",
      ".cv-guide.v{width:1px}",
      ".cv-guide.h{height:1px}",
      /* 左侧定位栏 #cvRail —— 2026-10-21 双导航融合退役(用户口径:与浮动侧栏托盘功能重叠且并排)。
       * 导航职责归托盘:act-* 按钮画布形态=定位对应卡(switchView 分流);隐藏卡唤回=托盘按钮置灰+点击唤回
       * (面板监听 cv-cards 事件);卡片状态点/连接点迁托盘(面板侧 cvCardStatus/cvConn);
       * 托盘收起=托盘自带最小化钮 + 既有 #sbRail 细轨承接唤回。样式/构建/事件全部移除,左缘留白归还画布。 */
      /* 缩放 HUD */
      "#cvHud{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:40;display:flex;align-items:center;gap:2px;",
      "  padding:3px 6px;border:1px solid var(--border);border-radius:10px;background:var(--glass2);backdrop-filter:blur(8px)}",
      "#cvHud button{min-width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--muted);",
      "  font-size:11px;cursor:pointer;padding:0 6px}",
      "#cvHud button:hover{background:var(--hover-bg2);color:var(--text)}",
      "#cvHud button[data-act=classic]{margin-left:6px;color:var(--bronze);border:1px solid rgba(201,143,69,.4)}",
      "#cvHud .cv-pct{min-width:42px;text-align:center;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}",
      /* 小地图(外壳自己的):id 用 #cvMiniShell——面板画布床里也有一个 #cvMini(.bf-minimap,
       * 44×26 常态/148×96 hover,left:10px;bottom:10px)。撞 id 时本条 #cvMini(特异性 1,0,0)
       * 会整套劫持面板小地图的几何(right/top/width/height)→ 面板小地图实际落在画布左上角、
       * 档在写者 chip 条(top:30px)前面,点 chip 既不生效也不报错(2026-10 实测 3/6 chip 被吃)。
       * 定位挪到右下角抬高 120px:避开面板自己的 zoombar(right:10px;bottom:10px)与底部 HUD。 */
      "#cvMiniShell{position:absolute;right:10px;bottom:120px;z-index:40;width:172px;height:112px;border:1px solid var(--border);",
      "  border-radius:10px;background:rgba(0,0,0,.35);backdrop-filter:blur(6px);cursor:crosshair}",
      /* 经典回退时全部隐藏 */
      "body:not(.cv-shell) #cvRoot{display:none}",
    ].join("\n");
    var st = document.createElement("style");
    st.id = "cv-style";
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---------- DOM ----------
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function buildShell() {
    if (S.root) return;
    var middle = document.querySelector(".page .middle") || document.querySelector(".middle");
    if (!middle) throw new Error("canvas-shell: 未找到 .middle 宿主");
    middle.style.position = "relative";
    var root = el("div"); root.id = "cvRoot";
    var host = el("div"); host.id = "cvShellHost"; // 不能用面板画布床占用的同名旧 id(撞 id 会串样式,见 injectStyle 注释)
    var world = el("div"); world.id = "cvWorldShell";
    host.appendChild(world);
    root.appendChild(host);

    var hud = el("div"); hud.id = "cvHud";
    hud.innerHTML =
      '<button data-act="out" title="缩小 (Ctrl -)">−</button>' +
      '<span class="cv-pct" data-role="pct">100%</span>' +
      '<button data-act="in" title="放大 (Ctrl +)">+</button>' +
      '<button data-act="z50" title="50%">50%</button>' +
      '<button data-act="z100" title="100%">100%</button>' +
      '<button data-act="z200" title="200%">200%</button>' +
      '<button data-act="vreset" title="视口复位 (1:1 + 平移归零)">复位</button>' +
      '<button data-act="fit" title="紧凑适配全部卡片 (Ctrl 0)">适</button>' +
      '<button data-act="reset" title="重置布局">重置</button>' +
      '<button data-act="classic" title="切回经典单视图布局 (Ctrl+Shift+C)">经典</button>' +
      '<button data-act="mode-drag" data-role="ctrlmode" title="空白处拖拽行为:平移(抓手)/ 框选(箭头);Shift 也可临时框选">✥</button>';
    root.appendChild(hud);

    var mini = el("canvas"); mini.id = "cvMiniShell"; mini.width = 344; mini.height = 224;
    root.appendChild(mini);

    // Dify 风多选:框选矩形 + 对齐参考线(都挂在 host 上,屏幕坐标,不随世界缩放变形)
    var marquee = el("div"); marquee.id = "cvMarquee";
    host.appendChild(marquee);
    var gv = el("div", "cv-guide v"); gv.dataset.guide = "v";
    var gh = el("div", "cv-guide h"); gh.dataset.guide = "h";
    host.appendChild(gv); host.appendChild(gh);
    S.marquee = marquee; S.guideV = gv; S.guideH = gh;

    middle.appendChild(root);
    S.root = root; S.host = host; S.world = world; S.hud = hud; S.mini = mini;
    bindHostEvents();
    bindHudEvents();
    bindCanvasKeys();
    bindCtxMenu();
  }

  function buildCards() {
    if (S.built) return;
    var bridge = S.bridge || {};
    var specs = (bridge.specs || []).slice();
    if (!specs.length) return;
    var layout = layoutFromSpecs(specs);
    S.order = specs.map(function (s) { return s.name; });
    for (var i = 0; i < specs.length; i++) {
      var sp = specs[i];
      if (!document.getElementById(sp.node)) continue;
      var card = el("div", "cv-card" + (HEAVY[sp.name] ? " cv-heavy" : ""));
      card.dataset.name = sp.name;
      var head = el("div", "cv-card-head");
      head.innerHTML =
        '<span class="cv-card-ico">' + iconOf(sp) + "</span>" +
        '<span class="cv-card-txt"><span class="cv-card-title">' + esc(sp.title || sp.name) + "</span>" +
        '<span class="cv-card-sub">' + esc(sp.tag || "") + "</span></span>" +
        '<span class="cv-card-dot"></span>' +
        '<span class="cv-card-tools">' +
        '<button data-act="focus" title="聚焦此卡">⤢</button>' +
        '<button data-act="min" title="折叠/展开(Alt+点击=只留标题条)">—</button>' +
        '<button data-act="hide" title="隐藏(侧栏托盘同名按钮可唤回)">✕</button>' +
        "</span>";
      var body = el("div", "cv-card-body");
      card.appendChild(head);
      card.appendChild(body);
      for (var d = 0; d < 8; d++) {
        var hd = el("i", "cv-rs");
        hd.dataset.dir = ["n", "s", "w", "e", "nw", "ne", "sw", "se"][d];
        card.appendChild(hd);
      }
      S.world.appendChild(card);
      S.cards[sp.name] = {
        el: card, head: head, body: body, spec: sp,
        g: Object.assign({ z: 0, hidden: false, min: false }, layout[sp.name] || normRect({})),
      };
      bindCardEvents(sp.name);
    }
    S.built = true;
    // 标题栏高度运行时实测(HEAD_H 常量只做首帧预估):字体/主题/缩放下高度会变,
    // 折叠/小地图/离屏剔除都依赖它,钉死常量会算错。
    requestAnimationFrame(function () {
      // 用 offsetHeight(不受 transform:scale 影响)。此前读 getBoundingClientRect 会拿到
      // 「60 × 当前缩放比 × body zoom」——折叠高度/小地图/离屏剔除全都按错值算(实测 0.829 下存成 50)。
      var h = S.cards.chat && S.cards.chat.head.offsetHeight;
      if (h > 20) { HEAD_H = Math.round(h); scheduleDraw(); }
    });
  }

  /** 把视图节点搬进卡片(DOM 移动不销毁监听器,原 17k 行面板逻辑零改写)。
   *  每次进入画布都会重挂:退出画布时 unmount 会原样归位,再次进入必须重新搬入。 */
  function mountViews() {
    if (!S.built) return;
    S.moves = [];
    for (var i = 0; i < S.order.length; i++) {
      var name = S.order[i], c = S.cards[name];
      if (!c) continue;
      var node = document.getElementById(c.spec.node);
      if (!node || node.parentElement === c.body) continue;
      S.moves.push({ node: node, parent: node.parentElement, next: node.nextSibling });
      c.body.appendChild(node);
    }
    var chat = S.cards.chat;
    var footer = document.querySelector(".page > footer");
    if (chat && footer && footer.parentElement !== chat.body) {
      S.moves.push({ node: footer, parent: footer.parentElement, next: footer.nextSibling });
      chat.body.appendChild(footer);
    }
  }

  /** 视图节点原样归位(逆序恢复,保住原兄弟次序)。 */
  function unmountViews() {
    for (var i = (S.moves || []).length - 1; i >= 0; i--) {
      var m = S.moves[i];
      if (!m.parent) continue;
      if (m.next && m.next.parentElement === m.parent) m.parent.insertBefore(m.node, m.next);
      else m.parent.appendChild(m.node);
    }
    S.moves = [];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 卡片可见性广播(2026-10-21 双导航融合:cvRail 退役,隐藏卡唤回入口迁到侧栏托盘)。
   *  面板监听 cv-cards 事件,把对应托盘按钮置灰(隐藏卡=act 按钮半透明,点击走 switchView
   *  = showCard 唤回 + focus 取景,通路零新增)。 */
  function notifyCards() {
    var hidden = [];
    for (var i = 0; i < S.order.length; i++) {
      var c = S.cards[S.order[i]];
      if (c && c.g.hidden) hidden.push(S.order[i]);
    }
    try { window.dispatchEvent(new CustomEvent("cv-cards", { detail: { hidden: hidden } })); } catch (e) { /* 事件派发失败不影响画布 */ }
  }

  // ---------- 几何应用 ----------
  function applyCard(name) {
    var c = S.cards[name];
    if (!c) return;
    var g = c.g;
    // 布局守卫(2026-10-21 标题压叠修复):非有限几何钳回合法值再写 style。
    // NaN/null 落进 style.left="NaNpx" 是非法声明,浏览器整条丢弃 → 卡片退回静态位置,
    // 脏卡全叠在同一静态点。守卫后最坏也是「归 0 + 最小尺寸」,不再叠字。
    var gx = Number.isFinite(g.x) ? g.x : 0;
    var gy = Number.isFinite(g.y) ? g.y : 0;
    var gw = clamp(Number.isFinite(g.w) ? g.w : 640, MIN_W, 100000);
    var gh = clamp(Number.isFinite(g.h) ? g.h : 480, MIN_H, 100000);
    var h = g.min ? HEAD_H : gh;
    c.el.style.left = gx + "px";
    c.el.style.top = gy + "px";
    c.el.style.width = gw + "px";
    c.el.style.height = h + "px";
    c.el.style.zIndex = String(g.z || 1);
    c.el.style.display = g.hidden ? "none" : "";
    c.el.classList.toggle("min", !!g.min);
    c.body.style.display = g.min ? "none" : "";
    var btns = c.head.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) if (btns[i].dataset.act === "min") btns[i].textContent = g.min ? "+" : "—";
  }

  /** 交互态提升层管理(2026-10-21 文字模糊根治,配套 CSS #cvWorldShell.cv-moving):
   * 每次 applyView(= 视口在动)打上 .cv-moving 提升合成层;静止 180ms 后移除——
   * 解除提升触发浏览器按最终缩放重栅格化文字。同时把平移量取整、缩放值收规到 4 位小数,
   * 消掉 fit/持久化带来的亚像素与 0.30000000000000004 类脏值(亚像素偏移同样糊字)。 */
  var cvMovingTimer = 0;
  function markMoving() {
    S.world.classList.add("cv-moving");
    if (cvMovingTimer) clearTimeout(cvMovingTimer);
    cvMovingTimer = setTimeout(function () {
      cvMovingTimer = 0;
      S.world.classList.remove("cv-moving");
    }, 180);
  }

  function applyView() {
    var v = S.view;
    // 屏显取整:状态里保留精确值(数学/持久化不受影响),只把 transform 字符串收规。
    var tx = Math.round(v.x), ty = Math.round(v.y), ts = Math.round(v.s * 10000) / 10000;
    S.world.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + ts + ")";
    markMoving();
    // 防「被浏览器滚走」:世界层内容是绝对定位的超大盒子,host 若用 overflow:hidden,
    // 浏览器在「聚焦输入框/元素滚入视口」时仍会程序化设置 host.scrollTop/scrollLeft
    // (实测滚到 608px → 整个画布上移 608px,首屏对话卡跑到 y=-528 视口外)。
    // 两道保险:①CSS 用 overflow:clip(clip 不产生滚动容器);②每帧复位残留滚动量。
    if (S.host && (S.host.scrollTop || S.host.scrollLeft)) { S.host.scrollTop = 0; S.host.scrollLeft = 0; }
    var grid = 24 * v.s;
    S.host.style.setProperty("--cv-g", grid.toFixed(2) + "px");
    S.host.style.setProperty("--cv-ox", (v.x % grid).toFixed(2) + "px");
    S.host.style.setProperty("--cv-oy", (v.y % grid).toFixed(2) + "px");
    // 概览 LOD(低倍率总览):世界坐标整体缩小后,卡头/字号会一起缩到 3px 不可读。
    // 这里把倍率写进 --cv-s,低倍率时加 body.cv-lod,由 CSS 把卡头按 1/s 反缩放回屏幕尺寸,
    // 正文整段隐藏(低倍率下正文本来也读不了,留着只是刷屏)。
    var root = document.documentElement;
    root.style.setProperty("--cv-s", String(v.s));
    // 滞回判定(不再单阈硬切):非 LOD 且跌破 LOD_IN 才进;已成 LOD 且升破 LOD_OUT 才出;
    // 中间死区保持现状 → 阈值附近微调缩放不再反复穿越,也避免来回同步改全部卡片 DOM 造成卡顿。
    var isLod = document.body.classList.contains("cv-lod");
    if (!isLod && v.s < LOD_IN) document.body.classList.add("cv-lod");
    else if (isLod && v.s > LOD_OUT) document.body.classList.remove("cv-lod");
    var pct = S.hud && S.hud.querySelector('[data-role=pct]');
    if (pct) pct.textContent = Math.round(v.s * 100) + "%";
    scheduleDraw();
  }

  function applyAll() {
    for (var n in S.cards) if (Object.prototype.hasOwnProperty.call(S.cards, n)) applyCard(n);
    applyView();
    markFocus();
    saveSoon();
  }

  // ---------- 视口操作 ----------
  function setView(v) {
    // 视口守卫(2026-10-21):x/y/s 非有限值会把 NaN 写进 transform → 整条声明非法,
    // 画布停在旧帧不动(平移/缩放全部失灵)。钳回 0/1 保活。
    S.view = {
      x: Number.isFinite(v.x) ? v.x : 0,
      y: Number.isFinite(v.y) ? v.y : 0,
      s: clamp(Number.isFinite(v.s) ? v.s : 1, Z_MIN, Z_MAX),
    };
    applyView();
  }
  /** 光标锚点缩放(任务B,引擎口径):复刻 diagram-viewport.zoomAtPoint 的数学——把光标点
   *  反解为世界坐标再以新倍率重投影,光标下的世界内容点屏幕位移恒为 0。
   *  旧 zoomAround(factor 乘法)语义等价,保留为引擎封装的落点(数学不变式见 test/canvas-viewport-engine.test.ts)。 */
  function zoomAt(cur, px, py, nextScale) {
    var s = clamp(Number.isFinite(nextScale) ? nextScale : 1, Z_MIN, Z_MAX);
    var wx = (px - cur.x) / cur.s;
    var wy = (py - cur.y) / cur.s;
    return { x: px - wx * s, y: py - wy * s, s: s };
  }
  function zoomBy(factor, px, py) {
    var h = hostRect();
    var p = (Number.isFinite(px) && Number.isFinite(py)) ? { x: px, y: py } : { x: h.w / 2, y: h.h / 2 };
    setView(zoomAt(S.view, p.x, p.y, S.view.s * factor));
  }
  function zoomStep(dir) {
    // 阶梯含低倍率档(概览用途;LOD 反缩放保证低倍率下卡头仍可读)
    var steps = [0.12, 0.16, 0.2, 0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
    var cur = S.view.s, i = 0, best = Infinity;
    for (var k = 0; k < steps.length; k++) {
      var d = Math.abs(steps[k] - cur);
      if (d < best) { best = d; i = k; }
    }
    var j = clamp(i + dir, 0, steps.length - 1);
    zoomBy(steps[j] / cur);
  }
  /** 任务B:快捷档位(50%/100%/200%)+ 复位。档位缩放以视口中心为锚;复位=1:1 + 平移归零
   *  (与 HUD「重置」语义不同:那是重置布局;zoomReset 是视口复位,旧实现已存在,此处保留并加档位)。 */
  function zoomToScale(scale) {
    var h = hostRect();
    setView(zoomAt(S.view, h.w / 2, h.h / 2, scale));
  }
  /** 任务B:双指捏合数学(纯函数,单测口径)。d0/d1=两指初始/当前距离,c0/c1=初始/当前双指中心
   *  (视口局部坐标),v0=手势起始 view。距变→scale(钳 [Z_MIN,Z_MAX]),心移→平移:
   *  初始中心下的世界点 w=(c0-t0)/s0,落位 t1=c1-w*ns(与 diagram-viewport.zoomAtPoint 同式)。
   *  d0≤0 或距离非有限→原 view 原样返回(绝不产生 NaN/Infinity)。 */
  function pinchToView(v0, d0, d1, c0x, c0y, c1x, c1y) {
    // JSDoc 口径:d0≤0 或任一距离非有限 → 原 view 原样返回(手势数据不可信,绝不产生 NaN/Infinity,
    // 也不掺半套平移)。此前只把 ratio 中和成 1 仍按中心移平移,doc/impl 脱节(2026-10-29 任务B 补全)。
    if (!Number.isFinite(d0) || !(d0 > 0) || !Number.isFinite(d1)) {
      return { x: v0.x, y: v0.y, s: Number.isFinite(v0.s) ? v0.s : 1 };
    }
    var ratio = clamp(d1 / d0, 0, 100);
    var s0 = Number.isFinite(v0.s) && v0.s > 0 ? v0.s : 1;
    var ns = clamp(s0 * ratio, Z_MIN, Z_MAX);
    var wx = (c0x - v0.x) / s0;
    var wy = (c0y - v0.y) / s0;
    var x = c1x - wx * ns;
    var y = c1y - wy * ns;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ns)) return { x: v0.x, y: v0.y, s: v0.s };
    return { x: x, y: y, s: ns };
  }
  function zoomReset() { setView({ x: 0, y: 0, s: 1 }); }

  function visibleRects() {
    var out = [];
    for (var i = 0; i < S.order.length; i++) {
      var c = S.cards[S.order[i]];
      if (!c || c.g.hidden) continue;
      out.push(c.g);
    }
    return out;
  }

  /** 画布「安全区」:扣掉浮层(浮动侧栏托盘/收起细轨、小地图、HUD、「按住说话」浮钮)占的地方,
   *  否则飞行/适配后的卡片会被浮层压住——卡片内容可读性优先于"数学上居中"。
   *  口径统一:全部按「浮层实测矩形」换算到 host 局部坐标,不再写死常量
   *  (写死过一次小地图 196px,浮层一改位置就失配;小地图/说话钮位置由 CSS 决定,必须实测)。
   *  2026-10-21 双导航融合:cvRail 退役后左缘不再常驻预留 58px,留白归还画布世界;
   *  托盘收起态由 #sbRail 细轨(44px)承接,按需让位。 */
  function safeArea(h) {
    var left = 8;    // cvRail 退役:左缘只剩呼吸位
    if (document.body.classList.contains("sb-hidden")) left = Math.max(left, 54); // 收起细轨 #sbRail(44px)+10 呼吸
    var right = 14;
    var top = 14;
    var bottom = 54; // HUD(10 + 30 + 14)
    var hr = S.host.getBoundingClientRect();
    var z = zOf();
    /** 把某个固定浮层的屏幕矩形并进安全区扣除(自动判断它在哪一侧)。 */
    var reserve = function (node, pad, side) {
      if (!node || getComputedStyle(node).display === "none") return;
      var r = node.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var l = (r.left - hr.left) / z, t = (r.top - hr.top) / z;
      var rw = r.width / z, rh = r.height / z;
      if (l >= h.w || t >= h.h || l + rw <= 0 || t + rh <= 0) return;
      if (side === "right") right = Math.max(right, h.w - l + pad);
      else bottom = Math.max(bottom, h.h - t + pad);
    };
    // 右上小地图按**右侧**扣除(若按底部扣会把整个安全区高度削掉 200px,实测 chat 卡因此被挤到视口外)。
    // step-1033:右下「按住说话」已撤(语音输入改由 Super Agent 指挥台自带),不再预留。
    reserve(S.mini, 10, "right");
    // 浮动侧栏托盘(二期):它现在是拖到哪儿就在哪儿的浮层,固定扣左边距已经不对了。
    // 按托盘实际占位决定往哪一侧让:托盘在左半屏 → 加左边距;在右半屏 → 加右边距;
    // 托盘收起了(body.sb-hidden)或不在画布形态 → 不扣。
    var tray = trayEl();
    if (tray && document.body.classList.contains("cv-shell") && !document.body.classList.contains("sb-hidden")
      && getComputedStyle(tray).display !== "none") {
      var tr = tray.getBoundingClientRect();
      var tl = (tr.left - hr.left) / z, tw = tr.width / z;
      if (tw > 0 && tl + tw > 0 && tl < h.w) {
        var gap = 10;
        if (tl + tw / 2 < h.w / 2) left = Math.max(left, tl + tw + gap);
        else right = Math.max(right, h.w - tl + gap);
      }
    }
    var w = h.w - left - right;
    var hh = h.h - top - bottom;
    if (w < 320) { left = 12; right = 12; w = h.w - 24; }   // 窄屏:浮层会自适应收起,退化为常规边距
    if (hh < 240) { top = 10; bottom = 10; hh = h.h - 20; }
    return { x: left, y: top, w: w, h: hh };
  }
  /** 在安全区内适配(卡片整张入画,居中)。统一委托 fitInArea,保证与首屏/全览同一口径。 */
  function fitInSafe(rect) {
    return fitInArea(rect, safeArea(hostRect()), 0, Z_MAX);
  }
  /** 在安全区内居中(保持给定缩放)。 */
  function centerInSafe(rect, scale) {
    var h = hostRect();
    var a = safeArea(h);
    var s = clamp(scale, Z_MIN, Z_MAX);
    return {
      x: a.x + a.w / 2 - (rect.x + rect.w / 2) * s,
      y: a.y + a.h / 2 - (rect.y + rect.h / 2) * s,
      s: s,
    };
  }

  /** 统一取景:把 rect 装进安全区 area,返回 {x,y,s}。**首屏开卡 fit 与「全部入画」共用本函数**
   *  (两个入口各算一套是「改一处漏一处」的根源)。
   *  - pad:四周呼吸位(px),可用区域不足 80px 时按 80 兜底(避免 0/负值把缩放压成 0);
   *  - maxS:放大上限(单卡取景传 1,避免小卡片整卡入画被放到 1:1 以上糊掉;全览传 Z_MAX 不放大);
   *  - 可读性下限 FIT_MIN_S:按 pad 算出的 s 若被呼吸位压到 0.7 以下,而「不含呼吸位」时安全区
   *    其实装得下 0.7 → 抬到 0.7(900×600 实测只到 49%、本该 ~74%,根因就是呼吸位 + 旧的 0.5
   *    下限把值压小)。**装不下则老实按装得下的值**:绝不为下限牺牲「全部入画」。 */
  function fitInArea(rect, area, pad, maxS) {
    var p = Number.isFinite(pad) ? pad : 0;
    var cap = clamp(Number.isFinite(maxS) ? maxS : Z_MAX, Z_MIN, Z_MAX);
    var availW = Math.max(80, area.w - p * 2);
    var availH = Math.max(80, area.h - p * 2);
    var s = clamp(Math.min(availW / rect.w, availH / rect.h), Z_MIN, cap);
    var roomy = Math.min(area.w / rect.w, area.h / rect.h); // 不含呼吸位的上限(判断"能装下"用)
    if (s < FIT_MIN_S && roomy >= FIT_MIN_S) s = Math.min(FIT_MIN_S, cap);
    return {
      x: area.x + (area.w - rect.w * s) / 2 - rect.x * s,
      y: area.y + (area.h - rect.h * s) / 2 - rect.y * s,
      s: s,
    };
  }

  function fitAll() {
    var h = hostRect();
    var a = safeArea(h);
    var b = boundsOf(visibleRects());
    // 两侧各留 24px 呼吸位(否则最外列卡缘贴死安全区边界,看着像被切了一刀)
    setView(fitInArea(b, a, 24, Z_MAX));
  }

  function focus(name, opts) {
    var c = S.cards[name];
    if (!c) return;
    var o = opts || {};
    if (c.g.hidden) { c.g.hidden = false; }
    if (c.g.min) { c.g.min = false; }
    c.g.z = ++S.zTop;
    applyCard(name);
    S.focused = name;
    markFocus();
    var h = hostRect();
    var a = safeArea(h);
    var rect = { x: c.g.x, y: c.g.y, w: c.g.w, h: c.g.h };
    // 取景策略:能整张入画就整张入画(上限 1:1,避免小卡片被放大糊);否则按装得下的值。
    // 呼吸位 20px(不减时卡片右缘紧贴小地图左边线,观感像被切了一刀)。
    // 走与「全部入画」同一个 fitInArea:口径统一(safeArea + 0.7 可读性下限),不再各算一套。
    var target = S.view.s;
    var v = o.zoom ? fitInArea(rect, a, 20, 1) : centerInSafe(rect, target);
    setView(v);
    notifyCards(); // 唤回被隐藏的卡片后托盘灰态同步刷新(否则卡片回来了按钮还是灰的)
    if (S.bridge && typeof S.bridge.activate === "function") {
      try { S.bridge.activate(name); } catch (e) { console.warn("[canvas] 卡片激活失败", name, e); }
    }
    // 焦点同步(每次都要,不只是首次激活):面板侧把「当前视图」身份同步到这张卡,
    // 否则切回经典布局会显示旧视图(实测:焦点在代码档案卡,切经典却回到文件视图)。
    if (S.bridge && typeof S.bridge.onFocus === "function") {
      try { S.bridge.onFocus(name); } catch (e) { console.warn("[canvas] 焦点同步失败", name, e); }
    }
    notifyResize(name, 60);
    saveSoon();
    scheduleDraw();
  }

  function markFocus() {
    for (var n in S.cards) {
      if (!Object.prototype.hasOwnProperty.call(S.cards, n)) continue;
      S.cards[n].el.classList.toggle("on", n === S.focused);
    }
  }

  function showCard(name) {
    var c = S.cards[name]; if (!c) return;
    c.g.hidden = false; applyCard(name); notifyCards(); saveSoon();
  }
  function hideCard(name) {
    var c = S.cards[name]; if (!c) return;
    c.g.hidden = true; applyCard(name);
    if (S.focused === name) S.focused = "";
    markFocus(); notifyCards(); saveSoon(); scheduleDraw();
  }

  /** 卡片状态点(忙/告警/失败/就绪)。tone: run|warn|fail|ok|""
   *  面板把真实状态推过来(有未提交变更/待审批/运行中…),画布只负责显示,不猜数据。
   *  2026-10-21 双导航融合:托盘按钮上的同名状态点由面板侧 cvCardStatus 直接维护(卡→act 按钮映射在面板)。 */
  function setCardStatus(name, tone, text) {
    var c = S.cards[name];
    var t = tone === "run" || tone === "warn" || tone === "fail" || tone === "ok" ? tone : "";
    if (!c) return;
    var dot = c.head.querySelector(".cv-card-dot");
    if (dot) {
      dot.className = "cv-card-dot" + (t ? " st-" + t : "");
      dot.title = String(text || "");
    }
  }

  // ---------- 交互:视口 ----------
  function bindHostEvents() {
    var host = S.host;
    host.addEventListener("wheel", function (e) {
      var p = localXY(e);
      // 2026-10-29 任务B:光标锚点缩放改为引擎口径(diagram-viewport zoomAtPoint 的数学)——
      // 任何带修饰键的滚轮(Ctrl/⌘=触控板捏合手势在 Chrome 里也派发 ctrlKey wheel)=缩放,
      // 光标下的世界内容点屏幕位移恒为 0。旧实现只有 ctrlKey 才缩放,普通滚轮只能平移。
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        var d = -e.deltaY;
        if (e.deltaMode === 1) d *= 16; // 行模式→px(老鼠标驱动)
        var f = Math.exp(d * 0.0018);
        zoomBy(f, p.x, p.y);
        return;
      }
      // 卡片内部自身需要滚动的区域(可滚容器)滚轮不抢
      var sc = scrollableUnder(e.target);
      if (sc && !e.shiftKey) return;
      e.preventDefault();
      var dx = e.deltaX, dy = e.deltaY;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }
      setView({ x: S.view.x - dx, y: S.view.y - dy, s: S.view.s });
      saveSoon();
    }, { passive: false });

    // 2026-10-29 任务B:双指捏合。pointer 多点(触屏/触控板)时跟踪两指间距离与中心:
    // 距变→scale(以初始中心下的世界点为锚),心移→pan。两指落下即取消单指平移,任一指抬起结束手势
    //(单指平移逻辑不动,靠 S.panning=false 让旧 move 空转)。
    S.pts = S.pts || {};
    S.pinch = null;
    function ptsList() {
      var out = [];
      for (var k in S.pts) if (Object.prototype.hasOwnProperty.call(S.pts, k)) out.push(S.pts[k]);
      return out;
    }
    function pinchStart() {
      var p = ptsList();
      if (p.length < 2) return;
      S.panning = false;
      host.classList.remove("cv-grabbing");
      var dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (!(d > 8)) return; // 两指几乎重合:距离噪声大,不起捏合
      var hr = host.getBoundingClientRect();
      var z = zOf();
      S.pinch = {
        d0: d,
        c0x: ((p[0].x + p[1].x) / 2 - hr.left) / z,
        c0y: ((p[0].y + p[1].y) / 2 - hr.top) / z,
        v0: { x: S.view.x, y: S.view.y, s: S.view.s },
      };
    }
    function pinchMove() {
      if (!S.pinch) return;
      var p = ptsList();
      if (p.length < 2) { S.pinch = null; return; }
      var dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (!Number.isFinite(d) || !(S.pinch.d0 > 0)) return;
      var hr = host.getBoundingClientRect();
      var z = zOf();
      var c1x = ((p[0].x + p[1].x) / 2 - hr.left) / z;
      var c1y = ((p[0].y + p[1].y) / 2 - hr.top) / z;
      // 捏合数学统一走 pinchToView(纯函数,单测同口径):c0 是手势起始中心,c1 是当前中心,
      // 距离比管倍率、中心位移管平移,一次 setView 全守卫(无 NaN 路径)。
      setView(pinchToView(S.pinch.v0, S.pinch.d0, d, S.pinch.c0x, S.pinch.c0y, c1x, c1y));
    }
    var pinchMoveDoc = function (ev) {
      if (!S.pinch) return;
      if (S.pts[ev.pointerId]) {
        S.pts[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
        pinchMove();
      }
    };
    var pinchUpDoc = function (ev) {
      if (!Object.prototype.hasOwnProperty.call(S.pts, ev.pointerId)) return;
      delete S.pts[ev.pointerId];
      if (S.pinch && Object.keys(S.pts).length < 2) { S.pinch = null; saveSoon(); }
    };
    document.addEventListener("pointermove", pinchMoveDoc);
    document.addEventListener("pointerup", pinchUpDoc);
    document.addEventListener("pointercancel", pinchUpDoc);

    host.addEventListener("pointerdown", function (e) {
      var card = e.target.closest && e.target.closest(".cv-card");
      var isBg = !card || card === host;
      if (isBg && e.button === 0 && !spaceDown) {
        // 空白左键:指针模式=框选(Dify selectionOnDrag);抓手模式=平移(Dify panOnDrag)。
        // 默认抓手,保住一期已有的手感;要框选就按 HUD 的手/箭头切换或按住 Shift。
        if (S.ctrlMode === "pointer" || e.shiftKey) { startMarquee(e); return; }
        if (!e.shiftKey) { clearSel(); }
      }
      var wantPan = (isBg && e.button === 0) || e.button === 1 || (e.button === 0 && spaceDown);
      if (!wantPan) return;
      e.preventDefault();
      // 任务B:先记指;第二指落下即转捏合(单指平移让位)
      S.pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(S.pts).length >= 2) { pinchStart(); return; }
      S.panning = true;
      host.classList.add("cv-grabbing");
      var start = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y };
      var z = zOf();
      var move = function (ev) {
        if (!S.panning) return;
        setView({ x: start.vx + (ev.clientX - start.x) / z, y: start.vy + (ev.clientY - start.y) / z, s: S.view.s });
      };
      var up = function (ev) {
        S.panning = false;
        host.classList.remove("cv-grabbing");
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (ev && ev.pointerId !== undefined && Object.prototype.hasOwnProperty.call(S.pts, ev.pointerId)) {
          delete S.pts[ev.pointerId];
          if (S.pinch && Object.keys(S.pts).length < 2) { S.pinch = null; }
        }
        saveSoon();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });

    host.addEventListener("dblclick", function (e) {
      var card = e.target.closest && e.target.closest(".cv-card-head");
      if (!card) return;
      var c = card.closest(".cv-card");
      if (c && c.dataset.name) focus(c.dataset.name, { zoom: true });
    });

    window.addEventListener("resize", function () { scheduleDraw(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === " " && !isEditable(e.target)) { spaceDown = true; S.host.classList.add("cv-grabbing"); }
    }, true);
    document.addEventListener("keyup", function (e) {
      if (e.key === " ") { spaceDown = false; if (!S.panning) S.host.classList.remove("cv-grabbing"); }
    }, true);
  }
  var spaceDown = false;

  function isEditable(t) {
    return !!(t && t.closest && t.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]'));
  }
  /** 上层可滚动容器(卡片正文里的 .view/.term-body 等):命中则滚轮让给它。 */
  function scrollableUnder(t) {
    for (var n = t; n && n !== S.host; n = n.parentElement) {
      if (!n.classList) continue;
      if (n.classList.contains("cv-card-head")) return null;
      var oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 2) return n;
    }
    return null;
  }

  // ---------- Dify 风多选 / 对齐参考线 / 键盘 ----------
  // 语义(照 Dify workflow 的 selection 体验):
  //  · 指针模式下空白拖拽=框选(Shift 也可);抓手模式下空白拖拽=平移(一期手感不变)
  //  · 点卡片头=单选并聚焦;Shift+点/框选=多选
  //  · 选中多张时拖任一张=整组移动;方向键微移(1px,Shift=10px);Delete=隐藏选中(不动数据)
  //  · 拖拽时与其它卡片出现对齐线(左/右/上/下/中)就吸附并显示参考线
  function startMarquee(e) {
    e.preventDefault();
    var h = hostRect();
    var z = zOf();
    var x0 = (e.clientX - h.left) / z, y0 = (e.clientY - h.top) / z;
    var base = S.sel.slice();
    var mq = S.marquee;
    mq.style.display = "block";
    var apply = function (ev) {
      var x1 = (ev.clientX - h.left) / z, y1 = (ev.clientY - h.top) / z;
      var l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
      mq.style.left = l + "px"; mq.style.top = t + "px";
      mq.style.width = w + "px"; mq.style.height = hh + "px";
      // 屏幕矩形 → 世界矩形(部分相交即选中,与 Dify SelectionMode.Partial 一致)
      var wx0 = (l - S.view.x) / S.view.s, wy0 = (t - S.view.y) / S.view.s;
      var wx1 = (l + w - S.view.x) / S.view.s, wy1 = (t + hh - S.view.y) / S.view.s;
      var hit = base.slice();
      for (var i = 0; i < S.order.length; i++) {
        var n = S.order[i], c = S.cards[n];
        if (!c || c.g.hidden) continue;
        var rr = { x: c.g.x, y: c.g.y, w: c.g.w, h: c.g.min ? HEAD_H : c.g.h };
        var inter = !(rr.x + rr.w < wx0 || wx1 < rr.x || rr.y + rr.h < wy0 || wy1 < rr.y);
        if (inter && hit.indexOf(n) < 0) hit.push(n);
      }
      setSel(hit);
    };
    var up = function () {
      mq.style.display = "none";
      document.removeEventListener("pointermove", apply);
      document.removeEventListener("pointerup", up);
      scheduleDraw();
    };
    document.addEventListener("pointermove", apply);
    document.addEventListener("pointerup", up);
  }

  function setSel(list) {
    S.sel = list.slice();
    for (var n in S.cards) {
      if (!Object.prototype.hasOwnProperty.call(S.cards, n)) continue;
      S.cards[n].el.classList.toggle("sel", S.sel.indexOf(n) >= 0);
    }
  }
  function clearSel() { if (S.sel.length) setSel([]); }
  function toggleSel(name) {
    var i = S.sel.indexOf(name);
    if (i >= 0) { S.sel.splice(i, 1); setSel(S.sel); }
    else setSel(S.sel.concat([name]));
  }

  /** 对齐参考线:把移动中的卡片与其它卡片的边缘/中线比较,命中阈值就吸附并画线。
   *  返回吸附后的坐标 + 需要画的线(屏幕坐标)。阈值按缩放换算,缩放越小越宽容。 */
  function alignSnap(name, g) {
    var thr = 6 / S.view.s;
    var candX = [], candY = [];
    for (var i = 0; i < S.order.length; i++) {
      var n = S.order[i];
      if (n === name || S.sel.indexOf(n) >= 0) continue;
      var c = S.cards[n];
      if (!c || c.g.hidden) continue;
      candX.push(c.g.x, c.g.x + c.g.w / 2, c.g.x + c.g.w);
      candY.push(c.g.y, c.g.y + c.g.h / 2, c.g.y + c.g.h);
    }
    var mine = [g.x, g.x + g.w / 2, g.x + g.w];
    var mineY = [g.y, g.y + g.h / 2, g.y + g.h];
    var bestX = null, bestY = null;
    for (var a = 0; a < mine.length; a++) {
      for (var b = 0; b < candX.length; b++) {
        var d = candX[b] - mine[a];
        if (Math.abs(d) <= thr && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d: d, at: candX[b] };
      }
    }
    for (var a2 = 0; a2 < mineY.length; a2++) {
      for (var b2 = 0; b2 < candY.length; b2++) {
        var d2 = candY[b2] - mineY[a2];
        if (Math.abs(d2) <= thr && (!bestY || Math.abs(d2) < Math.abs(bestY.d))) bestY = { d: d2, at: candY[b2] };
      }
    }
    return { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, vx: bestX ? bestX.at : null, vy: bestY ? bestY.at : null };
  }

  function showGuides(vx, vy) {
    var h = hostRect();
    if (vx === null || vx === undefined) S.guideV.style.display = "none";
    else {
      S.guideV.style.display = "block";
      S.guideV.style.left = (vx * S.view.s + S.view.x) + "px";
      S.guideV.style.top = "0"; S.guideV.style.height = h.h + "px";
    }
    if (vy === null || vy === undefined) S.guideH.style.display = "none";
    else {
      S.guideH.style.display = "block";
      S.guideH.style.top = (vy * S.view.s + S.view.y) + "px";
      S.guideH.style.left = "0"; S.guideH.style.width = h.w + "px";
    }
  }
  function hideGuides() { S.guideV.style.display = "none"; S.guideH.style.display = "none"; }

  /** 键盘:方向键微移选中(无选中则焦点卡)、Delete/Backspace 隐藏选中、Esc 清选、Ctrl+A 全选。 */
  function bindCanvasKeys() {
    document.addEventListener("keydown", function (e) {
      if (!S.built || S.mode !== "canvas") return;
      if (isEditable(e.target)) return;
      var targets = S.sel.length ? S.sel.slice() : (S.focused ? [S.focused] : []);
      var step = e.shiftKey ? 10 : 1;
      if (e.key === "Escape" && S.sel.length) { clearSel(); return; }
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "a" && !isEditable(e.target)) {
        e.preventDefault();
        setSel(S.order.filter(function (n) { return S.cards[n] && !S.cards[n].g.hidden; }));
        return;
      }
      if (e.key === "Delete") {
        // 只认 Delete:Backspace 在"焦点在卡片上但光标不在输入框"时会被误按,直接隐藏卡片很吓人
        // (有 toast 可唤回,但没必要让它发生)。
        if (!targets.length) return;
        e.preventDefault();
        for (var i = 0; i < targets.length; i++) hideCard(targets[i]);
        clearSel();
        toast2("已隐藏 " + targets.length + " 张卡片(侧栏托盘同名按钮可唤回;数据未动)");
        return;
      }
      var dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else return;
      if (!targets.length) return;
      e.preventDefault();
      for (var j = 0; j < targets.length; j++) {
        var c = S.cards[targets[j]];
        if (!c) continue;
        c.g.x += dx; c.g.y += dy;
        applyCard(targets[j]);
      }
      scheduleDraw(); saveSoon();
    });
  }
  function toast2(text) {
    try { if (typeof window.__cvToast === "function") window.__cvToast(text); } catch (e) { console.warn("[canvas]", text); }
  }
  /** 空白拖拽语义落地(平移/框选手感切换):同步 HUD 按钮态与画布光标。
   *  模式持久化在 zh:cv-ctrlmode,进画布时按上次选择恢复。 */
  function applyCtrlMode() {
    if (!S.hud) return;
    var b = S.hud.querySelector('[data-act="mode-drag"]');
    var pointer = S.ctrlMode === "pointer";
    if (b) {
      b.textContent = pointer ? "▣" : "✥";
      b.classList.toggle("on", pointer);
      b.title = pointer ? "空白拖拽=框选多选(点此切回平移)" : "空白拖拽=平移(点此切成框选)";
    }
    if (S.host) S.host.style.cursor = pointer ? "default" : "grab";
  }

  // ---------- 右键菜单(卡片 / 空白 / 多选 三态,Dify node/panel/selection contextmenu) ----------
  var ctxEl = null;
  function ctxClose() {
    if (ctxEl && ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
    ctxEl = null;
  }
  function ctxOpen(items, x, y) {
    ctxClose();
    var m = el("div"); m.id = "cvCtx";
    m.innerHTML = items.map(function (it, i) {
      if (it === "-") return '<div class="cv-ctx-sep"></div>';
      return '<div class="cv-ctx-it' + (it.danger ? " danger" : "") + '" data-i="' + i + '">' + esc(it.label) + "</div>";
    }).join("");
    document.body.appendChild(m);
    // 先显示再夹取位置(避免菜单溢出视口)
    var r = m.getBoundingClientRect();
    m.style.left = Math.min(x, Math.max(4, window.innerWidth - r.width - 8)) + "px";
    m.style.top = Math.min(y, Math.max(4, window.innerHeight - r.height - 8)) + "px";
    m.addEventListener("click", function (e) {
      var it = e.target.closest(".cv-ctx-it");
      if (!it) return;
      e.stopPropagation();
      var item = items[Number(it.dataset.i)];
      ctxClose();
      if (item && typeof item.run === "function") { try { item.run(); } catch (err) { console.warn("[canvas] 菜单动作失败", err); } }
    });
    ctxEl = m;
  }
  /** 菜单项随上下文变化:卡片(单张)/ 多选(≥2)/ 空白。 */
  function ctxItemsFor(name) {
    if (name) {
      var c = S.cards[name];
      var multi = S.sel.length > 1 && S.sel.indexOf(name) >= 0;
      if (multi) {
        return [
          { label: "聚焦 " + S.sel.length + " 张选中卡的组", run: function () { setSel([]); } },
          { label: "隐藏选中的 " + S.sel.length + " 张卡(可唤回)", run: function () { var t = S.sel.slice(); for (var i = 0; i < t.length; i++) hideCard(t[i]); clearSel(); } },
          "-",
          { label: "对齐:左边缘", run: function () { alignSelection("left"); } },
          { label: "对齐:右边缘", run: function () { alignSelection("right"); } },
          { label: "对齐:顶边", run: function () { alignSelection("top"); } },
          { label: "对齐:底边", run: function () { alignSelection("bottom"); } },
          "-",
          { label: "取消选择", run: clearSel },
        ];
      }
      return [
        { label: "聚焦并整卡入画", run: function () { focus(name, { zoom: true }); } },
        { label: c && c.g.min ? "展开卡片" : "折叠成标题条", run: function () { if (!c) return; c.g.min = !c.g.min; applyCard(name); notifyResize(name, 40); saveSoon(); scheduleDraw(); } },
        name === "chat" ? { label: "恢复默认几何", run: function () { var l = layoutFromSpecs((S.bridge && S.bridge.specs) || []); if (l[name]) { c.g = Object.assign({ z: c.g.z, hidden: false, min: false }, l[name]); applyAll(); notifyResize(name, 60); } } }
          : { label: "恢复到默认位置", run: function () { var l = layoutFromSpecs((S.bridge && S.bridge.specs) || []); if (l[name]) { c.g.x = l[name].x; c.g.y = l[name].y; c.g.w = l[name].w; c.g.h = l[name].h; c.g.min = false; applyCard(name); notifyResize(name, 60); saveSoon(); scheduleDraw(); } } },
        { label: "复制位置(调试)", run: function () { try { navigator.clipboard.writeText(name + " " + JSON.stringify(c ? { x: c.g.x, y: c.g.y, w: c.g.w, h: c.g.h } : {})); toast2("坐标已复制"); } catch (err) { console.warn(err); } } },
        "-",
        { label: "隐藏此卡(侧栏托盘同名按钮可唤回)", danger: true, run: function () { hideCard(name); } },
      ];
    }
    return [
      { label: "全部入画", run: fitAll },
      { label: "按网格重新排布", run: resetLayout },
      "-",
      { label: "显隐模式:" + (S.ctrlMode === "pointer" ? "框选" : "平移"), run: function () { S.ctrlMode = S.ctrlMode === "pointer" ? "hand" : "pointer"; applyCtrlMode(); } },
      { label: "重置侧栏托盘位置", run: function () { trayApply({ x: 56, y: 12, w: 264 }); traySave(); } },
      { label: "唤回全部隐藏卡", run: function () { for (var i = 0; i < S.order.length; i++) showCard(S.order[i]); scheduleDraw(); } },
      "-",
      { label: "切回经典单视图布局", run: function () { setMode("classic"); } },
    ];
  }
  /** 多选对齐:以选中集合的包围盒为基准对齐(左/右/顶/底)。 */
  function alignSelection(kind) {
    if (S.sel.length < 2) return;
    var list = [];
    for (var i = 0; i < S.sel.length; i++) { var c = S.cards[S.sel[i]]; if (c) list.push(c); }
    if (list.length < 2) return;
    var left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (var j = 0; j < list.length; j++) {
      var g = list[j].g;
      left = Math.min(left, g.x); right = Math.max(right, g.x + g.w);
      top = Math.min(top, g.y); bottom = Math.max(bottom, g.y + g.h);
    }
    for (var k = 0; k < list.length; k++) {
      var gg = list[k].g;
      if (kind === "left") gg.x = left;
      else if (kind === "right") gg.x = right - gg.w;
      else if (kind === "top") gg.y = top;
      else if (kind === "bottom") gg.y = bottom - gg.h;
      applyCard(S.sel[k]);
    }
    toast2("已对齐 " + list.length + " 张卡片");
    saveSoon(); scheduleDraw();
  }
  function bindCtxMenu() {
    if (!S.host) return;
    S.host.addEventListener("contextmenu", function (e) {
      if (!document.body.classList.contains("cv-shell")) return;
      var card = e.target.closest && e.target.closest(".cv-card");
      var name = card ? card.dataset.name : "";
      e.preventDefault();
      ctxOpen(ctxItemsFor(name), e.clientX, e.clientY);
    });
    document.addEventListener("pointerdown", function (e) {
      if (ctxEl && !ctxEl.contains(e.target)) ctxClose();
    }, true);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") ctxClose();
    }, true);
    window.addEventListener("blur", ctxClose);
  }

  function bindHudEvents() {
    S.hud.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var act = b.dataset.act;
      if (act === "in") zoomStep(1);
      else if (act === "out") zoomStep(-1);
      else if (act === "z50") zoomToScale(0.5);
      else if (act === "z100") zoomToScale(1);
      else if (act === "z200") zoomToScale(2);
      else if (act === "vreset") zoomReset();
      else if (act === "fit") fitAll();
      else if (act === "reset") resetLayout();
      else if (act === "classic") setMode("classic");
      else if (act === "mode-drag") {
        // Dify 的「手 / 箭头」模式切换:空白处左键拖拽 = 平移 or 框选
        S.ctrlMode = S.ctrlMode === "pointer" ? "hand" : "pointer";
        applyCtrlMode();
        try { localStorage.setItem("zh:cv-ctrlmode", S.ctrlMode); } catch (err) { /* 隐私模式:忽略 */ }
        toast2(S.ctrlMode === "pointer" ? "框选模式:空白拖拽选择多张卡片" : "平移模式:空白拖拽移动画布");
      }
    });
    S.mini.addEventListener("pointerdown", function (e) {
      var r = S.mini.getBoundingClientRect();
      var z = zOf();
      // canvas 内部分辨率(344×224)是 CSS 尺寸(172×112)的 2 倍:点击换算是 CSS 像素,必须先拉到
      // canvas 像素再套 miniMap 的 k/off(否则差 2 倍——点右下角永远到不了最右列卡片)。
      var sx = S.mini.width / Math.max(1, r.width / z), sy = S.mini.height / Math.max(1, r.height / z);
      var px = (e.clientX - r.left) / z * sx, py = (e.clientY - r.top) / z * sy;
      var m = miniMap();
      // 小地图坐标 → 世界坐标:取该点的世界位置,把它移到视口中心(保持当前缩放)
      var wx = (px - m.offx) / m.k + m.b.x;
      var wy = (py - m.offy) / m.k + m.b.y;
      // 钳住视口:低倍率总览时 miniMap 的 b 会被视口撑大,点右下角会飞到空白世界;
      // 高倍率时点边缘又会把视口送出卡片区。按「视口整体留在卡片包围盒内」钳(点右下=视口右缘贴最右卡),
      // 而不是把中心点钳进包围盒(那样中心落在包围盒角落照样是空白)。
      // 口径统一(2026-10-21 修「小地图最右列偏 ~60px」):落点走 centerInSafe = 把该点摆到**安全区**中心,
      // 所以钳制必须用安全区的世界半宽/半高。此前 halfW 用 host 全宽算(把落点中心当成了 host 中心),
      // 右侧被小地图/说话钮让掉的那一列就变成固定偏移,最右列怎么点都差一截。
      // 一步到位:同一个 safeArea 口径 → 映射(centerInSafe)与钳制(此处的半宽半高)永远一致。
      var a = safeArea(hostRect());
      var cb = boundsOf(visibleRects());
      var halfW = Math.min((a.w / S.view.s) / 2, cb.w / 2);
      var halfH = Math.min((a.h / S.view.s) / 2, cb.h / 2);
      wx = clamp(wx, cb.x + halfW, cb.x + cb.w - halfW);
      wy = clamp(wy, cb.y + halfH, cb.y + cb.h - halfH);
      setView(centerInSafe({ x: wx, y: wy, w: 1, h: 1 }, S.view.s));
      saveSoon();
      scheduleDraw();
    });
  }

  // ---------- 交互:卡片 ----------
  function bindCardEvents(name) {
    var c = S.cards[name];
    if (!c) return;
    c.el.addEventListener("pointerdown", function (e) {
      if (c.g.z < S.zTop) { c.g.z = ++S.zTop; c.el.style.zIndex = String(c.g.z); }
      // Dify 风选择:Shift/Ctrl+点 = 加选/减选;普通点(未在多选集合内)= 收起多选、单选
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        toggleSel(name);
      } else if (S.sel.length && S.sel.indexOf(name) >= 0) {
        // 点在已选中的卡上:保留整组(供整组拖动)
      } else if (S.sel.length) {
        clearSel();
      }
      if (S.focused !== name) { S.focused = name; markFocus(); if (S.bridge && S.bridge.activate) { try { S.bridge.activate(name); } catch (e) { console.warn("[canvas] 卡片激活失败", name, e); } } }
    });
    c.head.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button")) return;
      if (e.button !== 0 || spaceDown) return;
      e.preventDefault();
      dragCard(name, "move", e);
    });
    var handles = c.el.querySelectorAll(".cv-rs");
    for (var i = 0; i < handles.length; i++) {
      handles[i].addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        dragCard(name, this.dataset.dir, e);
      });
    }
    c.head.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var act = b.dataset.act;
      if (act === "focus") focus(name, { zoom: true }); // 卡头「聚焦」与 HUD「全部入画」原先共用 data-act="fit" 撞选择器,已分开
      else if (act === "min") { c.g.min = !c.g.min; applyCard(name); notifyResize(name, 40); saveSoon(); scheduleDraw(); }
      else if (act === "hide") hideCard(name);
    });
  }

  function dragCard(name, dir, ev) {
    var c = S.cards[name];
    if (!c) return;
    var z = zOf();
    var g0 = { x: c.g.x, y: c.g.y, w: c.g.w, h: c.g.h };
    var sx = ev.clientX, sy = ev.clientY;
    var free = ev.altKey; // Alt=自由(不吸附/不出参考线)
    // Dify 风整组移动:拖的是选中集合里的一员 → 整组一起动(各自保持相对位置)
    var group = (dir === "move" && S.sel.length > 1 && S.sel.indexOf(name) >= 0) ? S.sel.slice() : [];
    var starts = {};
    for (var gi = 0; gi < group.length; gi++) {
      var gc = S.cards[group[gi]];
      if (gc) starts[group[gi]] = { x: gc.g.x, y: gc.g.y };
    }
    var move = function (e) {
      var dx = (e.clientX - sx) / z, dy = (e.clientY - sy) / z;
      if (dir === "move") {
        var nx = g0.x + dx, ny = g0.y + dy;
        if (free) {
          c.g.x = Math.round(nx); c.g.y = Math.round(ny);
          hideGuides();
        } else {
          // 先按网格吸附,再与其它卡片的边缘/中线对齐吸附(命中则画参考线)
          var base = { x: snap(nx), y: snap(ny), w: g0.w, h: g0.h };
          var a = alignSnap(name, base);
          c.g.x = base.x + a.dx;
          c.g.y = base.y + a.dy;
          showGuides(a.vx, a.vy);
        }
        if (group.length) {
          var mx = c.g.x - g0.x, my = c.g.y - g0.y;
          for (var k = 0; k < group.length; k++) {
            var gn = group[k];
            if (gn === name) continue;
            var gc2 = S.cards[gn];
            if (!gc2 || !starts[gn]) continue;
            gc2.g.x = starts[gn].x + mx; gc2.g.y = starts[gn].y + my;
            applyCard(gn);
          }
        }
      } else {
        var nw = g0.w, nh = g0.h, nx2 = g0.x, ny2 = g0.y;
        if (dir.indexOf("e") >= 0) nw = Math.max(MIN_W, g0.w + dx);
        if (dir.indexOf("s") >= 0) nh = Math.max(MIN_H, g0.h + dy);
        if (dir.indexOf("w") >= 0) { nw = Math.max(MIN_W, g0.w - dx); nx2 = g0.x + (g0.w - nw); }
        if (dir.indexOf("n") >= 0) { nh = Math.max(MIN_H, g0.h - dy); ny2 = g0.y + (g0.h - nh); }
        if (!free) {
          nw = snap(nw); nh = snap(nh); nx2 = snap(nx2); ny2 = snap(ny2);
          if (nw < MIN_W) nw = MIN_W;
          if (nh < MIN_H) nh = MIN_H;
        }
        c.g.w = nw; c.g.h = nh; c.g.x = nx2; c.g.y = ny2;
      }
      applyCard(name);
      scheduleDraw();
    };
    var up = function () {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.body.classList.remove("cv-dragging");
      hideGuides();
      applyCard(name);
      notifyResize(name, 60);
      for (var k = 0; k < group.length; k++) notifyResize(group[k], 60);
      saveSoon();
      scheduleDraw();
    };
    document.body.classList.add("cv-dragging");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ---------- 离屏剔除 + 小地图(同一 rAF) ----------
  function scheduleDraw() {
    if (S.rafPending) return;
    S.rafPending = true;
    requestAnimationFrame(function () {
      S.rafPending = false;
      cull();
      drawMini();
    });
  }

  function cull() {
    if (!S.host) return;
    var h = hostRect();
    var born = false;
    for (var n in S.cards) {
      if (!Object.prototype.hasOwnProperty.call(S.cards, n)) continue;
      var c = S.cards[n];
      if (c.g.hidden) { c.el.classList.remove("off"); continue; }
      var l = c.g.x * S.view.s + S.view.x;
      var t = c.g.y * S.view.s + S.view.y;
      var r = l + c.g.w * S.view.s;
      var b = t + (c.g.min ? HEAD_H : c.g.h) * S.view.s;
      var off = r < -CULL_PAD || l > h.w + CULL_PAD || b < -CULL_PAD || t > h.h + CULL_PAD;
      c.el.classList.toggle("off", off);
      // 懒激活:卡片第一次进入视口才跑它的激活逻辑(拉数/渲染),
      // 避免 15 张卡开场同时发 15 组 WS 请求;也保证"滑到哪块就活到哪块"。
      if (!off && !c.born) { c.born = true; born = true; queueActivate(n); }
    }
    if (born) flushActivate();
  }

  var activateQ = [], activateTimer = 0;
  function queueActivate(name) { activateQ.push(name); }
  function flushActivate() {
    if (activateTimer) return;
    activateTimer = setTimeout(function () {
      activateTimer = 0;
      var q = activateQ; activateQ = [];
      for (var i = 0; i < q.length; i++) {
        if (S.bridge && typeof S.bridge.activate === "function") {
          try { S.bridge.activate(q[i]); } catch (e) { /* 单卡激活失败不影响画布 */ }
        }
        notifyResize(q[i], 40 + i * 20);
      }
    }, 30);
  }

  /** 小地图坐标换算:返回世界包围盒 b、缩放 k、画布内偏移 offx/offy(均为 canvas 像素坐标)。
   *  卡片绘制与点击换算共用同一套(此前点击用 pad 手算,与绘制偏移相差一截 → 点哪都不准)。 */
  function miniMap() {
    var b = boundsOf(visibleRects());
    var vh = { x: -S.view.x / S.view.s, y: -S.view.y / S.view.s };
    var h = hostRect();
    vh.w = h.w / S.view.s; vh.h = h.h / S.view.s;
    b = boundsOf([{ x: b.x, y: b.y, w: b.w, h: b.h }, vh]);
    var pad = 8;
    var W = S.mini ? S.mini.width : 344, H = S.mini ? S.mini.height : 224;
    var k = Math.min((W - pad * 2) / b.w, (H - pad * 2) / b.h);
    return {
      b: b, k: k, pad: pad, W: W, H: H,
      offx: pad + (W - pad * 2 - b.w * k) / 2,
      offy: pad + (H - pad * 2 - b.h * k) / 2,
    };
  }

  function drawMini() {
    var cv = S.mini;
    if (!cv) return;
    var g = cv.getContext("2d");
    if (!g) return;
    var W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    var m = miniMap();
    var css = getComputedStyle(document.body);
    var bronze = (css.getPropertyValue("--bronze") || "#c98f45").trim();
    var faint = (css.getPropertyValue("--faint") || "#6b5c4a").trim();
    var offx = m.offx, offy = m.offy;
    for (var i = 0; i < S.order.length; i++) {
      var n = S.order[i], c = S.cards[n];
      if (!c || c.g.hidden) continue;
      var x = offx + (c.g.x - m.b.x) * m.k;
      var y = offy + (c.g.y - m.b.y) * m.k;
      var w = Math.max(2, c.g.w * m.k), hh = Math.max(2, (c.g.min ? HEAD_H : c.g.h) * m.k);
      g.fillStyle = n === S.focused ? "rgba(201,143,69,.42)" : "rgba(150,131,106,.20)";
      g.strokeStyle = n === S.focused ? bronze : faint;
      g.lineWidth = 1.5;
      g.fillRect(x, y, w, hh);
      g.strokeRect(x, y, w, hh);
    }
    // 视口框
    var hr = hostRect();
    var vx = offx + (-S.view.x / S.view.s - m.b.x) * m.k;
    var vy = offy + (-S.view.y / S.view.s - m.b.y) * m.k;
    var vw = (hr.w / S.view.s) * m.k, vhh = (hr.h / S.view.s) * m.k;
    g.strokeStyle = bronze;
    g.lineWidth = 2;
    g.strokeRect(vx, vy, vw, vhh);
  }

  // ---------- 持久化 ----------
  function saveSoon() {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 350);
  }
  function saveNow() {
    try {
      var cards = {};
      for (var n in S.cards) {
        if (!Object.prototype.hasOwnProperty.call(S.cards, n)) continue;
        var g = S.cards[n].g;
        // 脏值不落盘(2026-10-21):任一几何字段非有限 → 跳过该卡(下次载入走默认布局)。
        // 不拦会把 NaN 写成 null 档;载入端虽已归一化,但脏档长期留在 localStorage 里,
        // 复制/调试/旧版本面板读到的都是病数据(拖拽中 NaN 还会经对齐吸附传染别的卡)。
        if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.w) || !Number.isFinite(g.h)) continue;
        cards[n] = { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h), z: g.z || 0, hidden: !!g.hidden, min: !!g.min };
      }
      localStorage.setItem(LS_LAYOUT, JSON.stringify({ v: 1, view: { x: Math.round(S.view.x), y: Math.round(S.view.y), s: Number(S.view.s.toFixed(3)) }, cards: cards, focused: S.focused }));
    } catch (e) { /* 配额/隐私模式:忽略 */ }
  }
  function loadSaved() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_LAYOUT) || "null");
      if (!raw || raw.v !== 1) return null;
      return raw;
    } catch (e) { return null; }
  }
  function resetLayout() {
    try { localStorage.removeItem(LS_LAYOUT); } catch (e) {}
    var bridge = S.bridge || {};
    var layout = layoutFromSpecs(bridge.specs || []);
    S.zTop = 1;
    for (var n in S.cards) {
      if (!Object.prototype.hasOwnProperty.call(S.cards, n)) continue;
      var g = layout[n] || normRect({});
      S.cards[n].g = Object.assign({ z: 0, hidden: false, min: false }, g);
    }
    S.view = { x: 0, y: 0, s: 1 };
    S.focused = "";
    applyAll();
    notifyCards(); // 全部唤回:托盘灰态同步清掉
    // 重置后落在主对话卡(全览只给 HUD「适应」/Ctrl+Shift+F,不作为重置后的默认视野)
    if (S.cards.chat) { S.focused = "chat"; focus("chat", { zoom: true }); }
    else fitAll();
    saveSoon();
  }

  function notifyResize(name, delay) {
    clearTimeout(S.resTimer);
    S.resTimer = setTimeout(function () {
      if (S.bridge && typeof S.bridge.resized === "function") {
        try { S.bridge.resized(name); } catch (e) { /* 单个视图重算失败不影响画布 */ }
      }
      scheduleDraw();
    }, delay || 40);
  }

  // ---------- 浮动导航托盘(侧栏不再固定) ----------
  // 用户口径 2026-10-20 二期:「这些也不要固定,固定的就是快速定位」。侧栏从 fixed 全高栏
  // 变成可拖动/可调宽/可收起的浮动托盘;**画布形态专属**(所有样式带 body.cv-shell 前缀),
  // 经典布局仍是原来的固定侧栏。托盘位置走 CSS 变量,持久化到 zh:cv-tray。
  var LS_TRAY = "zh:cv-tray";
  var TRAY_MIN = 200, TRAY_MAX = 460;

  function trayEl() { return document.getElementById("sidebar"); }

  function trayApply(pos) {
    var sb = trayEl();
    if (!sb) return;
    var root = document.documentElement;
    var r = hostRect();
    var w = clamp(Number(pos.w) || 264, TRAY_MIN, TRAY_MAX);
    // 位置钳制:托盘必须留一部分在视口内(拖到屏幕外就再也抓不回来了)
    var maxX = Math.max(8, window.innerWidth - 80);
    var maxY = Math.max(8, window.innerHeight - 40);
    var x = clamp(Number.isFinite(pos.x) ? pos.x : 56, 0, maxX);
    var y = clamp(Number.isFinite(pos.y) ? pos.y : 12, 0, maxY);
    root.style.setProperty("--cv-tray-x", x + "px");
    root.style.setProperty("--cv-tray-y", y + "px");
    root.style.setProperty("--cv-tray-w", w + "px");
    void r;
    S.tray = { x: x, y: y, w: w };
  }

  function traySave() {
    try { localStorage.setItem(LS_TRAY, JSON.stringify(S.tray || { x: 56, y: 12, w: 264 })); } catch (e) { /* 隐私模式:忽略 */ }
  }

  function trayLoad() {
    var d = { x: 56, y: 12, w: 264 };
    try {
      var raw = JSON.parse(localStorage.getItem(LS_TRAY) || "null");
      if (raw && typeof raw === "object") d = { x: Number(raw.x), y: Number(raw.y), w: Number(raw.w) };
    } catch (e) { /* 用默认 */ }
    if (!Number.isFinite(d.x)) d.x = 56;
    if (!Number.isFinite(d.y)) d.y = 12;
    if (!Number.isFinite(d.w)) d.w = 264;
    return d;
  }

  /** 托盘的拖拽把手:标题条(移动)+ 右缘 5px 手柄(调宽)。
   *  独立于 #sbDrag 与 #cvRail,避免同区域多种拖拽语义互相抢指针(规划稿风险 1)。 */
  function bindTray() {
    var sb = trayEl();
    if (!sb || sb.dataset.cvTrayBound) return;
    sb.dataset.cvTrayBound = "1";
    // 调宽手柄(插入托盘内部,absolute 贴右缘)
    var rs = el("i", "cv-tray-rs");
    rs.title = "拖动调整托盘宽度";
    sb.appendChild(rs);

    var startDrag = function (e, mode) {
      if (e.button !== 0) return;
      // 经典布局不接管(下面仍保留监听,只在画布形态下生效)
      if (!document.body.classList.contains("cv-shell")) return;
      e.preventDefault();
      e.stopPropagation();
      var base = S.tray || trayLoad();
      var sx = e.clientX, sy = e.clientY;
      var z = zOf();
      var moved = false;
      var move = function (ev) {
        var dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        if (mode === "move") trayApply({ x: base.x + dx, y: base.y + dy, w: base.w });
        else trayApply({ x: base.x, y: base.y, w: base.w + dx });
      };
      var up = function () {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.body.classList.remove("cv-tray-dragging");
        if (moved) traySave();
      };
      document.body.classList.add("cv-tray-dragging");
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    };

    var brand = sb.querySelector(".sb-brand");
    if (brand) brand.addEventListener("pointerdown", function (e) { startDrag(e, "move"); });
    rs.addEventListener("pointerdown", function (e) { startDrag(e, "resize"); });
    // 窗口尺寸变化:托盘可能被推到视口外,重新钳一次
    window.addEventListener("resize", function () {
      if (S.tray) trayApply(S.tray);
    });
  }

  // ---------- 形态切换 ----------
  function enterCanvas() {
    injectStyle();
    buildShell();
    buildCards();
    var firstEnter = !S.inited;
    if (firstEnter) {
      S.inited = true;
      try { S.ctrlMode = localStorage.getItem("zh:cv-ctrlmode") === "pointer" ? "pointer" : "hand"; } catch (e) { /* 默认抓手 */ }
      var saved = loadSaved();
      if (saved) {
        // 旧持久化布局兼容:条目逐卡归一化(null/NaN/缺字段/越界 → 坏字段回默认布局同名字段)。
        // 此前 x:null 直接进 style.left="nullpx"(非法被丢)→ 脏卡全部叠在静态位置 = 卡头标题压叠。
        var defLayout = layoutFromSpecs((S.bridge && S.bridge.specs) || []);
        for (var n in saved.cards) {
          if (!Object.prototype.hasOwnProperty.call(saved.cards, n)) continue;
          var c = S.cards[n];
          if (!c) continue;
          var sc = saved.cards[n];
          var r = normSavedCard(sc, defLayout[n]);
          c.g = { x: r.x, y: r.y, w: r.w, h: r.h, z: Number(sc.z) || 0, hidden: !!sc.hidden, min: !!sc.min };
          S.zTop = Math.max(S.zTop, c.g.z || 0);
        }
        // 升级播种(2026-10-21):存档里没有的新卡若按默认坐标落位,常在用户视口外(x:5320 之远)
        // →「新卡不存在」的错觉(用户实报:子agent会话流卡找不到)。改为紧贴 chat 卡右侧竖排,
        // 用户挪走前始终可见;全新用户(无存档)不走此分支,仍用默认网格。
        var seed = seedMissing(saved.cards, defLayout, S.cards.chat && S.cards.chat.g);
        if (seed) {
          for (var si = 0; si < seed.length; si++) {
            var cc = S.cards[seed[si].n];
            if (!cc) continue;
            cc.g = { x: seed[si].x, y: seed[si].y, w: seed[si].w, h: seed[si].h, z: ++S.zTop, hidden: false, min: false };
          }
        }
        if (saved.view) S.view = { x: saved.view.x || 0, y: saved.view.y || 0, s: clamp(saved.view.s || 1, Z_MIN, Z_MAX) };
        if (saved.focused) S.focused = saved.focused;
      }
    }
    document.body.classList.add("cv-shell");
    S.mode = "canvas";
    mountViews(); // 视图节点搬进卡片(退出画布时归位)
    trayApply(S.tray || trayLoad()); // 侧栏→浮动托盘:恢复上次位置/宽度
    bindTray();                     // 拖拽把手(只在画布形态生效)
    applyCtrlMode();                // 空白拖拽语义(平移/框选)按上次选择恢复
    applyAll();
    notifyCards();                  // 托盘按钮灰态按当前隐藏集合刷新(cvRail 退役后的唤回提示)
    if (firstEnter) {
      // 首屏恒落主对话卡:用户打开面板第一眼必须有输入框(实测过「复用上次焦点卡」→ 落在代码档案区,
      // 对话卡整张在视口外 y=-547,连 composer 都看不见)。上次焦点只作为**后续**回流的残留,
      // 不作为首屏取景依据;想看别的模块走侧栏托盘/小地图/Ctrl+K。
      setTimeout(function () {
        if (!S.cards.chat) { fitAll(); return; }
        S.focused = "chat";
        focus("chat", { zoom: true });
      }, 40);
    }
    // 让每个卡片的视图按新尺寸重算(白板/终端/看板等)
    setTimeout(function () {
      for (var i = 0; i < S.order.length; i++) notifyResize(S.order[i], 30);
      if (S.bridge && S.bridge.activate && S.focused) { try { S.bridge.activate(S.focused); } catch (e) {} }
    }, 80);
    setTimeout(scheduleDraw, 120);
  }

  function exitCanvas() {
    if (!S.built) return;
    document.body.classList.remove("cv-shell");
    S.mode = "classic";
    unmountViews(); // 视图节点/footer 原样归位(逆序恢复原兄弟次序)
    try { localStorage.setItem(LS_MODE, "classic"); } catch (e) {}
  }

  function setMode(mode, opts) {
    var m = mode === "classic" ? "classic" : "canvas";
    var initial = !!(opts && opts.initial);
    try { localStorage.setItem(LS_MODE, m); } catch (e) {}
    if (m === "classic") exitCanvas();
    else enterCanvas();
    // initial=启动时按存档恢复形态:此时不该跑「切换形态」的收尾(会 toast 一句、并按 mainView
    // 再取景一次,把首屏刚摆好的对话卡顶掉 —— 实测首屏 chat 卡跑到视口外)。
    if (S.bridge && typeof S.bridge.onMode === "function") { try { S.bridge.onMode(m, initial); } catch (e) { console.warn("[canvas] onMode 回调失败", e); } }
    window.dispatchEvent(new CustomEvent("cv-mode", { detail: { mode: m, initial: initial } }));
    return m;
  }

  // ---------- 对外 API ----------
  window.CanvasShell = {
    version: VERSION,
    isCanvas: function () { return S.mode === "canvas" && document.body.classList.contains("cv-shell"); },
    mode: function () { return S.mode; },
    init: function (bridge) {
      if (!bridge || !bridge.specs) return false;
      S.bridge = bridge;
      S.ready = true;
      var saved = "canvas";
      try { saved = localStorage.getItem(LS_MODE) || "canvas"; } catch (e) {}
      setMode(saved, { initial: true });
      return true;
    },
    focus: function (name, opts) { if (!S.built) enterCanvas(); focus(name, opts); },
    fitAll: fitAll,
    fitCard: function (name) { focus(name, { zoom: true }); },
    zoomStep: zoomStep,
    zoomReset: zoomReset,
    setMode: setMode,
    toggleMode: function () { return setMode(S.mode === "canvas" ? "classic" : "canvas"); },
    showCard: function (n) { if (!S.built) enterCanvas(); showCard(n); focus(n, { zoom: true }); },
    hideCard: hideCard,
    resetLayout: resetLayout,
    /** 该视图此刻是否"活着"(画布形态下=卡片可见且在视口内;经典形态=当前聚焦视图)。 */
    inView: function (name) {
      if (!S.built || S.mode !== "canvas") return null; // null=未接管,调用方走经典判定
      var c = S.cards[name];
      if (!c) return false;
      if (c.g.hidden) return false;
      return !c.el.classList.contains("off");
    },
    liveNames: function () {
      var out = [];
      for (var i = 0; i < S.order.length; i++) if (this.inView(S.order[i]) === true) out.push(S.order[i]);
      return out;
    },
    cardRect: function (name) { var c = S.cards[name]; return c ? { x: c.g.x, y: c.g.y, w: c.g.w, h: c.g.h } : null; },
    /** 卡片状态点(忙/告警/失败/就绪):面板推真实状态,画布只显示。
     *  托盘按钮上的同名状态点在面板侧 cvCardStatus 维护(卡→act 按钮映射是面板域知识)。 */
    setCardStatus: function (name, tone, text) { if (!S.built) return; setCardStatus(name, tone, text); },
    /** 浮动托盘(侧栏)位置/宽度复位:画布形态下侧栏被拖到屏幕外时的自救出口。 */
    resetTray: function () { trayApply({ x: 56, y: 12, w: 264 }); traySave(); },
    trayRect: function () { return S.tray ? { x: S.tray.x, y: S.tray.y, w: S.tray.w } : null; },
    cards: function () { return S.order.slice(); },
    titles: function () { return S.order.map(function (n) { return { name: n, title: S.cards[n] ? S.cards[n].spec.title : n }; }); },
    /** 纯几何(单测) */
    __geom: {
      clamp: clamp, snap: snap, normRect: normRect, normSavedCard: normSavedCard, zoomAround: zoomAround, boundsOf: boundsOf,
      fitView: fitView, centerOn: centerOn, layoutFromSpecs: layoutFromSpecs, seedMissing: seedMissing,
      fitInArea: fitInArea,        // 统一取景(首屏开卡 + 全部入画共用)
      zoomAt: zoomAt,              // 任务B:光标锚点缩放(diagram-viewport.zoomAtPoint 同式,单测口径)
      zoomToScale: zoomToScale,    // 档位(50/100/200)落点
      pinchToView: pinchToView,    // 双指捏合数学(纯函数:d0/d1+中心位移→view)
      MIN_W: MIN_W, MIN_H: MIN_H, SNAP: SNAP, XY_LIMIT: XY_LIMIT,
      FIT_MIN_S: FIT_MIN_S,        // 取景可读性下限(0.7)
      LOD_IN: LOD_IN, LOD_MID: LOD_MID, LOD_OUT: LOD_OUT, // LOD 三档滞回(单测口径)
    },
  };
})();