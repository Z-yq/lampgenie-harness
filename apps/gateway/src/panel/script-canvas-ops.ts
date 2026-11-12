/**
 * 面板主脚本分片:script-canvas-ops(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_CANVAS_OPS = `// ---- 九期:画布交互能力全集(零依赖手写;行为面对齐成熟工作流画布产品) ----
// 框选(shift+空白拖,相交即选=SelectionMode.Partial)/shift 点选多选/多选整体拖拽/
// 方向键微调(1px,shift=10px)/Delete 删除/
// 缩放控件(±/百分比/适配 0.25-2)/小地图(视口框+点按居中跳转)/
// 对齐吸附(±6px 贴线+辅助线,仅非编辑拖拽中)。
const CV_MIN_ZOOM = 0.25, CV_MAX_ZOOM = 2;
/** f5 适配可读下限:适配(fit)时最小缩放。再小标签就低于 8px 有效字号(经验证 22 节点板 fit 得 k=0.53
 * → 12px 标签只剩 6.4px 人眼读不了),宁可溢出让人平移,也不要「全塞进视野但全是糊字」。
 * 仅约束 cvFitNow(自动/fit 按钮);手动缩小仍可到 CV_MIN_ZOOM。 */
const CV_FIT_READABLE_MIN = 0.7;
let cvSelected = new Set();
let cvHelplines = [];
/** 边标签隐藏门槛(唯一出处, C):cvApplyTf 的 z-low 切换与 cvFitNow 的低倍率提示共用这一口径。
 * 历史:两处各写一份(cvApplyTf 0.38/0.42/0.55,cvFitNow 同值复制),一改就分叉。
 * 取值:UI 交互图 0.38(元素触点标签更密);其余板(含 code/flow)一律 0.4——「适」(k≈0.9)与常规
 * 阅读距离下边关系词常显,只有真的缩到 <40%(字已糊)才让位。 */
function cvLabelHideK() { return cvUiInfo ? 0.38 : 0.4; }
function cvApplyTf() {
  const world = cvScoped("cvWorld");
  if (world) {
    world.style.transform = "translate(" + cvPan.x + "px," + cvPan.y + "px) scale(" + cvPan.k + ")";
 // 白板修复:低缩放下边标签(9px 字)已缩成 2-4px 噪声且互相重叠,隐藏之(hover 边仍有 title)
 // C:门槛到 cvLabelHideK(默认 40%),与 cvFitNow 提示文案同源,不再各写一份。
    world.classList.toggle("z-low", cvPan.k < cvLabelHideK());
  }
  const pct = cvScoped("cvZpct");
  if (pct) pct.textContent = Math.round(cvPan.k * 100) + "%";
 // 十期:点阵网格随缩放/平移(网格是世界坐标的,必须跟着 transform 走)
  const h = cvHostEl();
  if (h) {
    const cell = (22 * cvPan.k).toFixed(2);
    h.style.backgroundSize = cell + "px " + cell + "px";
    h.style.backgroundPosition = cvPan.x + "px " + cvPan.y + "px";
  }
}
function cvSetZoom(nk, anchorHost) {
  cvViewTouched = true; // 缩放件(±/Ctrl±)是用户主动改视野 → 自动适配让位
  const old = cvPan.k;
  cvPan.k = Math.min(CV_MAX_ZOOM, Math.max(CV_MIN_ZOOM, nk));
  if (anchorHost) {
    const r = anchorHost.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    cvPan.x = mx - ((mx - cvPan.x) / old) * cvPan.k;
    cvPan.y = my - ((my - cvPan.y) / old) * cvPan.k;
  }
  cvApplyTf();
}
function cvMiniMapping(pos) {
  let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
 // svg 模式:世界框取 #cvSvgHost>svg 的 viewBox 宽高(卡片 pos 在 svg 模式下不代表真实布点)
  const sbMini = cvRenderMode() === "svg" ? cvSvgContentBox(null) : null;
  if (sbMini) { minX = 0; minY = 0; maxX = sbMini.w; maxY = sbMini.h; }
  else
  for (const [id, p] of pos) {
    const s = (cvPageInfo && cvPageInfo.size.get(id)) || (cvFlowInfo && cvFlowInfo.size.get(id)) || { w: 220, h: 110 }; // /fixH2:容器/流动卡尺寸实测进小地图
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
  }
  const pad = 10;
  const mini = cvScoped("cvMini");
  const W = mini ? mini.width : 148, H = mini ? mini.height : 96;
  const k = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
  return { minX, minY, maxX, maxY, k, pad };
}
function cvDrawMini(host, doc, pos) {
  const mini = cvScoped("cvMini");
  if (!mini) return;
  const ctx = mini.getContext("2d");
  const { minX, minY, maxX: mapMaxX, maxY: mapMaxY, k, pad } = cvMiniMapping(pos);
 // 修断裂:此前 cvDrawMini 直接引用 maxX/maxY,而它们只存在于 cvMiniMapping 的局部作用域
 // (重构遗留)→ 每次渲染 drawMini 抛 ReferenceError,小地图永不绘制,且异常沿 apply→
 // renderBoardCanvas 上抛,把画布后续绑定/状态更新一并打断。改为由 cvMiniMapping 一并返回。
  const maxX = mapMaxX, maxY = mapMaxY;
  const tx = (x) => pad + (x - minX) * k;
  const ty = (y) => pad + (y - minY) * k;
  const info = cvPageInfo || cvFlowInfo;
  ctx.clearRect(0, 0, mini.width, mini.height);
  ctx.lineWidth = 1;
 // svg 模式:没有 .cv-node 坐标可画 → 按 viewBox 画一个等比矩形占位 + 视口框(不留空白),
 // 视口框逻辑与下方共用;节点/边都跳过(doc.nodes 的 pos 与 svg 实际布点无关)。
  const svgMiniOn = cvRenderMode() === "svg" && !!cvSvgContentBox(host);
  if (svgMiniOn) {
    ctx.fillStyle = "rgba(201,143,69,.28)";
    ctx.strokeStyle = "rgba(138,122,90,.85)";
    ctx.fillRect(tx(minX), ty(minY), Math.max(4, (maxX - minX) * k), Math.max(4, (maxY - minY) * k));
    ctx.strokeRect(tx(minX), ty(minY), Math.max(4, (maxX - minX) * k), Math.max(4, (maxY - minY) * k));
  }
  if (!svgMiniOn)
  if (info && info.mode === "ui-flow") {
 // 交互地图:小地图只画真实交互流(不画 contains/tab 辅助边),颜色与主图一致
    for (const f of (info.flows || [])) {
      const a = pos.get(f.source && f.source.id), b = pos.get(f.target && f.target.id);
      if (!a || !b) continue;
      ctx.strokeStyle = (f.color || "#8a7a5a") + "cc";
      ctx.beginPath();
      ctx.moveTo(tx(a.x + 10), ty(a.y + 10));
      ctx.lineTo(tx(b.x + 10), ty(b.y + 10));
      ctx.stroke();
    }
  } else {
    for (const e of doc.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const sa = (info && info.size.get(e.from)) || { w: 220, h: 60 };
      const sb = (info && info.size.get(e.to)) || { w: 220, h: 60 };
 // fixH2:主线在小地图也亮绿一眼可循(其余青铜灰)
      ctx.strokeStyle = info && info.mainEdges && info.mainEdges.has(e.from + ">" + e.to) ? "rgba(79,191,122,.85)" : "rgba(138,122,90,.55)";
      ctx.beginPath();
      ctx.moveTo(tx(a.x + sa.w), ty(a.y + sa.h / 2));
      ctx.lineTo(tx(b.x), ty(b.y + sb.h / 2));
      ctx.stroke();
    }
  }
  for (const n of (svgMiniOn ? [] : doc.nodes)) {
    const p = pos.get(n.id);
    if (!p) continue;
    const s = (info && info.size.get(n.id)) || { w: 216, h: 60 };
    if (info && info.mode === "ui-flow") {
      const pm = (info.pages || []).find((x) => x.id === n.id);
      const isAux = (info.auxNodes || []).some((x) => x.id === n.id);
      ctx.fillStyle = pm ? (pm.main ? "#e0b46a" : "#7e8ba0") : isAux ? "#c9a25e" : "#5a5346";
    } else {
      ctx.fillStyle = n.change === "add" ? "#5aa06a" : n.change === "delete" ? "#e08a7a" : "#c98f45";
    }
    ctx.fillRect(tx(p.x), ty(p.y), Math.max(6, s.w * k), Math.max(4, s.h * k));
    if (cvSelected.has(n.id) || n.id === boardSelNode) {
      ctx.strokeStyle = "#ece1d1";
      ctx.strokeRect(tx(p.x) - 1, ty(p.y) - 1, Math.max(8, s.w * k) + 2, Math.max(6, s.h * k) + 2);
    }
  }
  const r = host.getBoundingClientRect();
  ctx.strokeStyle = "rgba(236,225,209,.7)";
  ctx.strokeRect((-cvPan.x / cvPan.k - minX) * k + pad, (-cvPan.y / cvPan.k - minY) * k + pad, r.width / cvPan.k * k, r.height / cvPan.k * k);
}
function cvFitView(host, pos) {
  let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
  for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + 220); maxY = Math.max(maxY, p.y + 110); }
  const r = host.getBoundingClientRect();
  const k = Math.min(CV_MAX_ZOOM, Math.max(CV_MIN_ZOOM, Math.min(r.width / (maxX - minX + 60), r.height / (maxY - minY + 60))));
  cvPan.k = k;
  cvPan.x = 20 - minX * k;
  cvPan.y = 20 - minY * k;
  cvApplyTf();
}
function cvSaveAllPos(pos) {
  const target = (boardEditOn && boardDraft ? boardDraft : boardDoc);
  if (!target) return;
 // 续作轮:以 DOM style 为准(增量补丁后闭包 pos 可能落后于 doc/样式——整组回滚的根治)
  const els = cvActiveHost ? cvActiveHost.querySelectorAll(".cv-node") : [];
  const byId = new Map();
  for (const el2 of els) byId.set(el2.dataset.cv, el2);
  for (const n of target.nodes) {
    const el2 = byId.get(n.id);
    const p = (el2 && el2.style.left) ? { x: parseFloat(el2.style.left) || 0, y: parseFloat(el2.style.top) || 0 } : pos.get(n.id);
    if (p) n.pos = { x: p.x, y: p.y };
  }
  if (!boardEditOn) bdSaveLayoutDebounced();
}
/** svg 模式(flowkit 单张 SVG)里「与卡片几何无关」的直操作层( flowkit 断裂修复)。
 * 背景:cvBindInteractions 在 svg 模式首行整体早退(卡片 DOM 全空,免得 el.dataset.cv 读到 null),
 * 连带把**只依赖 BoardDoc、不依赖 .cv-node/.cv-port** 的入口一起掐死——右键菜单、双击空白添加模块、
 * 键盘快捷键在默认渲染模式下点了完全没反应(经验证:面板白板区这些按钮/手势全部断裂)。
 * 这里按 svg 自己的节点命中口径(cvSvgNodeAt 读 [data-node-id])重绑三组:
 * · 右键:节点=编辑明细/复制/创建副本/删除;空白=粘贴/添加模块/适配全部(「整理布局」在 svg 下无效,置灰说明)
 * · 双击空白:在落点打开添加模块工具箱
 * · 键盘:Ctrl+Z/Y、Ctrl+C/V/D、Delete/Backspace、Esc
 * 仍属「卡片专属、待重做」(板上 P1 d6):端口拖拽连线、边悬停×删除、框选多选、吸附辅助线、方向键微调
 * —— 它们要 .cv-port/.cv-edge 的几何,svg 里没有对应锚点;Ctrl+A 全选同样只给明确提示,不假装可用。 */
function cvBindSvgOps() {
  const cvHost = cvActiveHost;
  if (!cvHost || cvRenderMode() !== "svg") return;
  if (cvRo) return; // 只读画布(设计沉淀):结构改动全禁,只留缩放/小地图
 // 键盘件要有焦点:svg 模式的画布点击不落焦点,这里点一下就把焦点收过来(不滚屏)
  cvHost.tabIndex = 0;
  cvHost.addEventListener("pointerdown", () => { try { cvHost.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ } });
  cvHost.addEventListener("contextmenu", (e) => {
    if (e.target.closest && (e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap") || e.target.closest(".cv-addbar") || e.target.closest(".cv-addpanel") || e.target.closest(".cv-wbar") || e.target.closest(".cv-rail"))) return;
    e.preventDefault();
 // 经验证:canvas-shell(canvas-shell.js bindCtxMenu)在 #boardGraph 上另有一份
 // contextmenu 监听,会**再建一个 id 完全相同的 #cvCtx**(挂在 body 上,菜单项是 .cv-ctx-it 的
 // 「全部入画/按网格重新排布/切回经典单视图布局」= 经典视图壳的菜单)。两个 #cvCtx 抢同一个 id,
 // 用户看到的就成了那张旧菜单。这里在 cvHost 冒泡阶段拦断,绝不让事件爬到 shell。
    e.stopPropagation();
    if (!cvTargetDoc()) return;
    const hit = cvSvgNodeAt(e);
    const hr = cvHost.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "cv-ctx";
    menu.id = "cvCtx";
    menu.style.left = Math.max(0, e.clientX - hr.left) + "px";
    menu.style.top = Math.max(0, e.clientY - hr.top) + "px";
    const mk = (label, fn, dis) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (dis) b.disabled = true;
      else b.onclick = () => { cvCloseCtx(); fn(); };
      menu.appendChild(b);
    };
    if (hit) {
      mk("编辑明细", () => { boardSelNode = hit; cvSvgApplySel(cvHost); renderBoardDetail(); });
      mk("连线到…", () => { boardSelNode = hit; cvSvgApplySel(cvHost); cvLinkStart(hit); }); // A5:svg 无端口,drag 连不了 → 菜单入口
      mk("复制", () => cvCopySel([hit]));
      mk("创建副本", () => { cvCopySel([hit]); cvPaste(); });
      mk("删除", () => { cvDelNodes([hit]); if (boardSelNode === hit) { boardSelNode = null; cvSvgApplySel(cvHost); } });
    } else {
      mk("粘贴", () => cvPaste(), !(cvClipboard && cvClipboard.nodes.length));
      mk("添加模块", () => cvOpenAddPanel(null));
      mk("适配全部", () => { cvViewTouched = false; cvFitNow(); });
      mk("整理布局(SVG 视图不适用)", () => { /* 占位:置灰项无行为 */ }, true);
    }
    cvHost.appendChild(menu);
  });
  cvHost.addEventListener("dblclick", (e) => {
    if (e.target.closest && (e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap") || e.target.closest(".cv-addbar") || e.target.closest(".cv-addpanel"))) return;
    if (cvSvgNodeAt(e)) return; // 节点上双击不是「空白添加」
    const r = cvHost.getBoundingClientRect();
    cvOpenAddPanel({ x: (e.clientX - r.left - cvPan.x) / cvPan.k, y: (e.clientY - r.top - cvPan.y) / cvPan.k });
  });
 // 经验证:canvas-shell(canvas-shell.js bindCanvasKeys)在 **document** 上另有 keydown:
 // Delete/Backspace 会 hideCard(「已隐藏 N 张卡片(侧栏托盘同名按钮可唤回)」)、Ctrl+A 全选卡片、
 // 方向键挪卡片。它绑在 document 上,cvHost 上的监听虽先触发,但一旦我们没有处理(如选中态为空)
 // 事件继续冒泡,用户按 Delete 删的是经典壳的卡片、不是板上节点 —— 表现就是「点了没反应/提示很奇怪」。
 // 所以在 document **捕获阶段**接管:命中我们的语义就 stopPropagation,绝不外泄给 shell。
  document.addEventListener("keydown", (e) => {
    if (!cvHost || !cvHost.isConnected) return;
    if (e.target && e.target.closest && e.target.closest("input,textarea,select,[contenteditable=true]")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toLowerCase();
    const sel = boardSelNode ? [boardSelNode] : [];
    const eat = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && k === "z" && !e.shiftKey) { eat(); cvUndo(); return; }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { eat(); cvRedo(); return; }
    if (mod && k === "a") {
      eat();
      toast("SVG 视图暂不支持全选/框选:框选与多选请切回卡片渲染(localStorage.cvRender=cards)", true);
      return;
    }
    if (mod && k === "c") { if (!sel.length) return; eat(); cvCopySel(sel); return; }
    if (mod && k === "v") { eat(); cvPaste(); return; }
    if (mod && k === "d") { if (!sel.length) return; eat(); cvCopySel(sel); cvPaste(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (!sel.length) return; // 没选中就不认,免得吞掉别处的删除语义
      eat();
      cvDelNodes(sel);
      boardSelNode = null;
      cvSvgApplySel(cvHost);
      return;
    }
 // A5:连线入口 —— 选中节点按 L 进连线态(旧口径 svg 里没有 .cv-port,无从连线)
    if (!mod && k === "l" && !e.shiftKey && !e.altKey) {
      if (!boardSelNode) return; // 没选中就不认(别吞掉输入框外的普通按键)
      eat();
      cvLinkStart(boardSelNode);
      return;
    }
    if (e.key === "Escape") {
      cvCloseCtx();
      cvLinkCancel(); // 连线态:Esc 退出(不留下悬空起点)
      cvSvgApplySel(cvHost);
    }
  }, true);
}
function cvBindInteractions(host, doc, pos, apply, drawMini) {
  const cvHost = cvActiveHost;
  ensureCvDelegation();
 // svg 模式(flowkit 单张 SVG):画布上只有一张 svg,没有卡片 DOM——
 // .cv-node/.cv-file/.cv-fold/.cv-wbar/[data-wpfx]/[data-wall]/.cv-ui-cap 全为空。
 // 这些编辑交互(节点拖拽/点击选中/连线/框选/吸附/写者过滤/折叠块)一律不绑,免得 el.dataset.cv 读到 null 抛错。
 // svg 模式的**节点点击选中 + 右侧详情卡**在 renderBoardCanvas 的 svg 交互委托里(cvSvgNodeAt),本函数不绑卡片编辑交互。
 // 平移/缩放/滚轮/缩放条(「适」「全」)/小地图不在本函数里绑:renderBoardCanvas + ensureCvDelegation 照常工作。
  if (cvRenderMode() === "svg") return;
  if (cvRo) return; // 只读画布(设计沉淀):缩放/小地图委托已就位,编辑交互(键盘/框选/连线/右键/吸附)全不绑
  const clearHelplines = () => { cvHelplines.forEach((h) => h.remove()); cvHelplines = []; };
  const showHelplines = (pairs) => {
    clearHelplines();
    const hr = cvHost.getBoundingClientRect();
    for (const [type, worldXY] of pairs) {
      const h = document.createElement("div");
      h.className = "cv-helpline " + (type === "v" ? "v" : "hh");
      if (type === "v") { h.style.left = worldXY * cvPan.k + cvPan.x + "px"; h.style.top = "0"; h.style.height = hr.height + "px"; }
      else { h.style.top = worldXY * cvPan.k + cvPan.y + "px"; h.style.left = "0"; h.style.width = hr.width + "px"; }
      cvHost.appendChild(h);
      cvHelplines.push(h);
    }
  };
 // ---- 缩放控件+小地图:事件委托绑在 document 上(九期竞态修复:
 // renderBoard 每次重建 cvHost,逐元素 onclick 会绑在被替换的旧 DOM 上——spec 100%→100% 注意;
 // 委托宿主 #boardGraph 不被重建,委托永活)。pos 由各 handler 从 boardDoc 不可达——用 DOM style 经验证。
 // 提为 ensureCvDelegation(只读画布也要缩放/小地图);cvHost 定位走 cvHostEl(活动宿主),
 // 小地图重绘走 cvActiveDoc(档案画布在场时不摸会话板全局 boardDoc)。 ----
  function ensureCvDelegation() {
    if (window.__cvDelegated) return;
    window.__cvDelegated = true;
 // pointerdown 触发(非 click):renderBoard 重建会吞掉 mouseup 后的 click——重建间
 // mousedown/up 落在不同元素,click 的 target=共同祖先 cvHost,委托 closest 落空。
 // pointerdown 在按下瞬间到达,免疫重建竞态(九期 FIT TELEMETRY 注意)。
    document.addEventListener("pointerdown", (e) => {
      const t = e.target && e.target.closest ? e.target.closest("#cvZin,#cvZout,#cvZfit,#cvZall,#cvMini,#cvAddBtn,#cvArrangeBtn,.cv-aitem") : null;
      if (!t) return;
      const cvH = cvHostEl();
      if (!cvH) return;
 // 从 DOM 读节点位置(样式是唯一真相:cvLayout 的 pos 只在闭包)
      const posNow = new Map();
      for (const el of cvH.querySelectorAll(".cv-node")) posNow.set(el.dataset.cv, { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
      if (t.id === "cvZin") cvSetZoom(cvPan.k * 1.25, cvH);
      else if (t.id === "cvZout") cvSetZoom(cvPan.k * 0.8, cvH);
      else if (t.id === "cvZfit") { cvViewTouched = false; cvFitNow(); } // 适配全部(DOM 实测节点卡 rect;十期抽公共函数);点「适」=视野归系统管,后续自动适配恢复生效
      else if (t.id === "cvZall") { cvViewTouched = true; cvFitNow(true); } // 全览:允许低于可读下限,先把整块板收进视口;标签变小可再放大
      else if (t.id === "cvAddBtn") {
        const p = document.getElementById("cvAddPanel");
        if (p && p.style.display === "block") p.style.display = "none";
        else cvOpenAddPanel(null); // null=落点取视口中心
      } else if (t.id === "cvArrangeBtn") cvArrangeAll();
      else if (t.classList && t.classList.contains("cv-aitem")) {
 // 工具箱点类型→落点添加(双击进入时用落点,按钮进入用视口中心)
        const p = document.getElementById("cvAddPanel");
        if (p) p.style.display = "none";
        let wx = 40, wy = 40;
        if (cvDropPt) { wx = cvDropPt.x; wy = cvDropPt.y; }
        else { const hr = cvH.getBoundingClientRect(); wx = (hr.width / 2 - cvPan.x) / cvPan.k; wy = (hr.height / 2 - cvPan.y) / cvPan.k; }
        cvAddNode(t.dataset.kind, wx, wy);
      } else if (t.id === "cvMini") {
        const miniMap = cvScoped("cvMini");
        if (miniMap) {
 // fixD4: 点按位置正下方有节点卡=让位给节点(不跳视口/不劫持拖拽)。同步探测(临时穿透+elementFromPoint),
 // 命中则以真实指针参数转派 pointerdown 给节点——其 handler 内 setPointerCapture(真实 pointerId) 接管
 // 后续 move/up=完整拖拽链;穿透态保持到抬起(捕获失败时 move 靠重命中兜底)。无节点=原点按跳转不变。
          let ndBeneath = null;
          const peKeep = miniMap.style.pointerEvents;
          miniMap.style.pointerEvents = "none";
          try { const h2 = document.elementFromPoint(e.clientX, e.clientY); ndBeneath = h2 && h2.closest ? h2.closest(".cv-node") : null; } catch (err) { ndBeneath = null; }
          if (ndBeneath && !cvRo) {
            let forwarded = false;
            try {
              ndBeneath.dispatchEvent(new PointerEvent("pointerdown", { pointerId: e.pointerId, pointerType: e.pointerType || "mouse", isPrimary: e.isPrimary !== false, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons, bubbles: true, cancelable: true }));
              forwarded = true;
            } catch (err2) { forwarded = false; }
            if (forwarded) {
              const restore = () => { miniMap.style.pointerEvents = peKeep; document.removeEventListener("pointerup", restore, true); document.removeEventListener("pointercancel", restore, true); };
              document.addEventListener("pointerup", restore, true);
              document.addEventListener("pointercancel", restore, true);
              return; // 已让位:本次点按不跳转(不 fallthrough 到跳转/小地图重绘)
            }
          }
          miniMap.style.pointerEvents = peKeep;
          const r = miniMap.getBoundingClientRect();
          const posNow2 = new Map();
          for (const el of cvH.querySelectorAll(".cv-node")) posNow2.set(el.dataset.cv, { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
          const { minX, minY, k, pad } = cvMiniMapping(posNow2);
          const wx = (e.clientX - r.left - pad) / k + minX, wy = (e.clientY - r.top - pad) / k + minY;
          const hr = cvH.getBoundingClientRect();
          cvViewTouched = true; // 小地图点按跳转=用户主动改视野
          cvPan.x = hr.width / 2 - wx * cvPan.k;
          cvPan.y = hr.height / 2 - wy * cvPan.k;
          cvApplyTf();
        }
      }
      if (cvActiveDoc) {
        const posNow3 = new Map();
        for (const el of cvH.querySelectorAll(".cv-node")) posNow3.set(el.dataset.cv, { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
        cvDrawMini(cvH, cvActiveDoc, posNow3);
      }
    });
  }
 // ---- 键盘:撤销/重做/复制/粘贴/副本/全选(十期)+Delete 删除(两态直操作)/方向键微调(选中集) ----
  cvHost.tabIndex = 0;
  cvHost.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input,textarea,select")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = (e.key || "").toLowerCase();
    if (mod && k === "z" && !e.shiftKey) { cvUndo(); e.preventDefault(); return; }
    if (mod && (k === "y" || (k === "z" && e.shiftKey))) { cvRedo(); e.preventDefault(); return; }
    if (mod && k === "c") { cvCopySel(cvSelected.size ? [...cvSelected] : boardSelNode ? [boardSelNode] : []); e.preventDefault(); return; }
    if (mod && k === "v") { cvPaste(); e.preventDefault(); return; }
    if (mod && k === "d") { const ids = cvSelected.size ? [...cvSelected] : boardSelNode ? [boardSelNode] : []; cvCopySel(ids); cvPaste(); e.preventDefault(); return; }
    if (mod && k === "a") { host.querySelectorAll(".cv-node").forEach((x) => { cvSelected.add(x.dataset.cv); x.classList.add("selected"); }); drawMini(); e.preventDefault(); return; }
    const hasSel = cvSelected.size > 0 || !!boardSelNode;
    if (!hasSel) return;
    const target = (boardEditOn && boardDraft ? boardDraft : boardDoc);
    if (!target) return;
    if (e.key === "Delete" || e.key === "Backspace") {
 // 十期:两态都可删——查看态直改板+防抖落盘(撤销可回),编辑态删草稿
      cvDelNodes([...new Set([...cvSelected, ...(boardSelNode ? [boardSelNode] : [])])]);
      e.preventDefault();
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    const ids = cvSelected.size ? cvSelected : new Set([boardSelNode]);
    for (const id of ids) {
      const p = pos.get(id);
      const el = host.querySelector('[data-cv="' + id + '"]');
      if (!p || !el) continue;
      p.x = Math.max(0, p.x + delta[0]); p.y = Math.max(0, p.y + delta[1]);
      el.style.left = p.x + "px"; el.style.top = p.y + "px";
      const tn = target.nodes.find((x) => x.id === id);
      if (tn) tn.pos = { x: p.x, y: p.y };
    }
    cvRedrawEdges(host, doc, pos);
    drawMini();
    if (!boardEditOn) bdSaveLayoutDebounced();
  });
 // ---- 框选(shift+空白拖,相交即选) ----
  let marquee = null;
  const marqueeEl = document.createElement("div");
  marqueeEl.className = "bf-marquee";
  marqueeEl.style.display = "none";
  cvHost.appendChild(marqueeEl);
  cvHost.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".cv-node") || e.target.closest(".cv-file") || e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap")) return;
    if (!e.shiftKey) {
 // 空白点击:清多选
      if (cvSelected.size) { cvSelected.clear(); host.querySelectorAll(".cv-node.selected").forEach((x) => x.classList.remove("selected")); drawMini(); }
      return;
    }
    const hr = cvHost.getBoundingClientRect();
    marquee = { sx: e.clientX, sy: e.clientY };
    marqueeEl.style.left = e.clientX - hr.left + "px";
    marqueeEl.style.top = e.clientY - hr.top + "px";
    marqueeEl.style.width = "0"; marqueeEl.style.height = "0";
    marqueeEl.style.display = "block";
    cvHost.classList.add("marqueeing");
    if (cvHost.setPointerCapture) { try { cvHost.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
    e.preventDefault();
  }, true);
  cvHost.addEventListener("pointermove", (e) => {
    if (!marquee) return;
    const hr = cvHost.getBoundingClientRect();
    const left = Math.min(e.clientX, marquee.sx) - hr.left, top = Math.min(e.clientY, marquee.sy) - hr.top;
    marqueeEl.style.left = left + "px"; marqueeEl.style.top = top + "px";
    marqueeEl.style.width = Math.abs(e.clientX - marquee.sx) + "px";
    marqueeEl.style.height = Math.abs(e.clientY - marquee.sy) + "px";
    const mx1 = left, my1 = top, mx2 = left + Math.abs(e.clientX - marquee.sx), my2 = top + Math.abs(e.clientY - marquee.sy);
    cvSelected.clear();
    for (const el of host.querySelectorAll(".cv-node")) {
      const r = el.getBoundingClientRect();
      const nl = r.left - hr.left, nt = r.top - hr.top;
      if (nl < mx2 && nl + r.width > mx1 && nt < my2 && nt + r.height > my1) { cvSelected.add(el.dataset.cv); el.classList.add("selected"); }
      else el.classList.remove("selected");
    }
  }, true);
  const mend = () => {
    if (!marquee) return;
    marquee = null;
    marqueeEl.style.display = "none";
    cvHost.classList.remove("marqueeing");
    drawMini();
  };
  cvHost.addEventListener("pointerup", mend);
  cvHost.addEventListener("pointerleave", mend);
 // ---- 多选整体拖拽(原单拖监听搬首节点;此处搬其余选中节点) ----
  for (const el of host.querySelectorAll(".cv-node")) {
    let last = null;
    el.addEventListener("pointerdown", (e) => {
      const id = el.dataset.cv;
      if (e.shiftKey) {
        if (cvSelected.has(id)) cvSelected.delete(id); else cvSelected.add(id);
        el.classList.toggle("selected", cvSelected.has(id));
        drawMini();
        e.stopPropagation();
      } else if (cvSelected.size && !cvSelected.has(id)) {
        cvSelected.clear();
        host.querySelectorAll(".cv-node.selected").forEach((x) => x.classList.remove("selected"));
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (cvSelected.size <= 1 || !cvSelected.has(el.dataset.cv)) { last = null; return; }
      if (e.buttons !== 1) { last = null; return; }
      if (!last) { last = { x: e.clientX, y: e.clientY }; return; }
      const dx = (e.clientX - last.x) / cvPan.k, dy = (e.clientY - last.y) / cvPan.k;
      last = { x: e.clientX, y: e.clientY };
      for (const id of cvSelected) {
        if (id === el.dataset.cv) continue;
        const p = pos.get(id);
        const el2 = host.querySelector('[data-cv="' + id + '"]');
        if (!p || !el2) continue;
        p.x = Math.max(0, p.x + dx); p.y = Math.max(0, p.y + dy);
        el2.style.left = p.x + "px"; el2.style.top = p.y + "px";
      }
      cvRedrawEdges(host, doc, pos);
      drawMini();
    });
    el.addEventListener("pointerup", () => { last = null; if (cvSelected.size) cvSaveAllPos(pos); });
  }
 // ---- 拖拽对齐吸附(±6px 贴线+辅助线;仅非编辑态拖拽中) ----
  let snapTimer = null;
  cvHost.addEventListener("pointerdown", (e) => {
    const nd = e.target.closest && e.target.closest(".cv-node");
    if (!nd || boardEditOn) return;
    const id = nd.dataset.cv;
    if (snapTimer) clearInterval(snapTimer);
    snapTimer = setInterval(() => {
      const p = pos.get(id);
      if (!p || !nd.classList.contains("dragging")) { clearInterval(snapTimer); snapTimer = null; clearHelplines(); return; }
      const lines = [];
      for (const n of doc.nodes) {
        if (n.id === id) continue;
        const q = pos.get(n.id);
        if (!q) continue;
        if (Math.abs(q.x - p.x) <= 6) lines.push(["v", q.x + 108]);
        if (Math.abs(q.y - p.y) <= 6) lines.push(["hh", q.y + 30]);
      }
      if (lines.length) showHelplines(lines.slice(0, 4)); else clearHelplines();
    }, 80);
  });
  cvHost.addEventListener("pointerup", () => { if (snapTimer) { clearInterval(snapTimer); snapTimer = null; } clearHelplines(); });
 // ---- 十期:端口拖拽连线(出端口按下→拖到目标节点松手=加连线;捕获阶段拦,防节点拖拽抢跑) ----
  const edgeSvgEl = host.querySelector(".bf-cv-edges");
  let conn = null;
  const connPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  connPath.setAttribute("class", "bfe-connect");
  const connHintClear = () => { host.querySelectorAll(".cv-node.cv-connect-hint").forEach((x) => x.classList.remove("cv-connect-hint")); };
  cvHost.addEventListener("pointerdown", (e) => {
    const port = e.target.closest && e.target.closest(".cv-port.out");
    if (!port || !edgeSvgEl) return;
    const nd = port.closest(".cv-node");
    if (!nd) return;
    conn = { from: nd.dataset.cv };
    edgeSvgEl.appendChild(connPath);
    if (port.setPointerCapture) { try { port.setPointerCapture(e.pointerId); } catch (err) { /* 已释放则忽略 */ } }
    port.onpointermove = (ev) => {
      if (!conn) return;
      const r = cvHost.getBoundingClientRect();
      const wx = (ev.clientX - r.left - cvPan.x) / cvPan.k, wy = (ev.clientY - r.top - cvPan.y) / cvPan.k;
      const p = pos.get(conn.from) || { x: 0, y: 0 };
      const x1 = p.x + 216, y1 = p.y + 30;
      const ddx = Math.max(36, (wx - x1) / 2);
      connPath.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + ddx) + " " + y1 + ", " + (wx - ddx) + " " + wy + ", " + wx + " " + wy);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tn = hit && hit.closest ? hit.closest(".cv-node") : null;
      connHintClear();
      if (tn && tn.dataset.cv !== conn.from) tn.classList.add("cv-connect-hint");
    };
    const fin = (ev) => {
      if (!conn) return;
      const from = conn.from;
      conn = null;
      connPath.remove();
      connHintClear();
      port.onpointermove = null; port.onpointerup = null; port.onpointercancel = null;
      if (!ev || ev.type === "pointercancel") return;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const tn = hit && hit.closest ? hit.closest(".cv-node") : null;
      if (tn && tn.dataset.cv && tn.dataset.cv !== from) cvAddEdge(from, tn.dataset.cv);
    };
    port.onpointerup = fin;
    port.onpointercancel = fin;
    e.stopPropagation();
    e.preventDefault();
  }, true);
 // ---- 十期:边悬停删除(×钮按下即删;捕获阶段拦,防触发平移) ----
  cvHost.addEventListener("pointerdown", (e) => {
    const del = e.target.closest && e.target.closest(".cv-edge-del");
    if (!del) return;
    e.stopPropagation();
    e.preventDefault();
    const g = del.closest(".cv-edge");
    const idx = g ? Number(g.dataset.eidx) : -1;
    const t = cvTargetDoc();
    if (!t || !(idx >= 0) || !t.edges[idx]) return;
    cvPushUndo();
    t.edges.splice(idx, 1);
    cvAfterStruct();
  }, true);
 // ---- 十期:右键菜单(节点=编辑明细/复制/创建副本/删除;空白=粘贴/整理布局/全选) ----
  cvHost.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap") || e.target.closest(".cv-addbar") || e.target.closest(".cv-addpanel")) return; // fixD4
    e.preventDefault();
    cvCloseCtx();
    const t = cvTargetDoc();
    if (!t) return;
    const nd = e.target.closest(".cv-node");
    const ids = nd ? (cvSelected.size && cvSelected.has(nd.dataset.cv) ? [...cvSelected] : [nd.dataset.cv]) : [...cvSelected];
    const hr = cvHost.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "cv-ctx";
    menu.id = "cvCtx";
    menu.style.left = Math.max(0, e.clientX - hr.left) + "px";
    menu.style.top = Math.max(0, e.clientY - hr.top) + "px";
    const mk = (label, fn, dis) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (dis) b.disabled = true;
      else b.onclick = () => { cvCloseCtx(); fn(); };
      menu.appendChild(b);
    };
    if (ids.length) {
      mk("编辑明细", () => { if (boardEditOn && boardSelNode && boardSelNode !== ids[0] && !bdSyncDraftFromForm()) return; boardSelNode = ids[0]; renderBoardDetail(); for (const x of host.querySelectorAll(".cv-node")) x.classList.toggle("on", x.dataset.cv === boardSelNode); }, !t.nodes.some((n) => n.id === ids[0])); // fixD1: 右键「编辑明细」换节点前同样收编
      mk("复制", () => cvCopySel(ids));
      mk("创建副本", () => { cvCopySel(ids); cvPaste(); });
      mk(ids.length > 1 ? "删除 " + ids.length + " 个模块" : "删除", () => cvDelNodes(ids));
    } else {
      mk("粘贴", () => cvPaste(), !(cvClipboard && cvClipboard.nodes.length));
      mk("整理布局", () => cvArrangeAll());
      mk("全选", () => { host.querySelectorAll(".cv-node").forEach((x) => { cvSelected.add(x.dataset.cv); x.classList.add("selected"); }); drawMini(); });
    }
    cvHost.appendChild(menu);
  });
 // ---- 十期:双击空白=在落点打开添加工具箱 ----
  cvHost.addEventListener("dblclick", (e) => {
    if (e.target.closest(".cv-node") || e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap") || e.target.closest(".cv-addbar") || e.target.closest(".cv-addpanel")) return; // fixD4
    const r = cvHost.getBoundingClientRect();
    cvOpenAddPanel({ x: (e.clientX - r.left - cvPan.x) / cvPan.k, y: (e.clientY - r.top - cvPan.y) / cvPan.k });
  });
 // ---- 十期:浮层全局收起(右键菜单/添加面板点外部即收;一次性注册,重建免疫) ----
  if (!window.__cvOverlaysBound) {
    window.__cvOverlaysBound = true;
    document.addEventListener("pointerdown", (e) => {
      const inCtx = e.target.closest && e.target.closest("#cvCtx");
      const ctx = document.getElementById("cvCtx");
      if (ctx && !inCtx) ctx.remove();
      const panel = document.getElementById("cvAddPanel");
      if (panel && panel.style.display === "block" && !(e.target.closest && (e.target.closest("#cvAddPanel") || e.target.closest("#cvAddBtn") || e.target.closest(".cv-aitem")))) panel.style.display = "none";
    }, true);
  }
}
// ---- 十期:画布直操作(行为面对齐成熟工作流画布产品)——端口拖拽连线/添加模块工具箱/
// 右键菜单/复制粘贴/撤销重做/整理布局;查看态直改板(与拖布局同一防抖落盘通道),编辑态改草稿。 ----
const CV_KIND_GROUPS = [
  ["流程控制", ["decision", "loop", "classifier", "aggregate"]],
  ["模型与智能", ["llm", "agent", "retrieval", "tool"]],
  ["代码与集成", ["function", "module", "http", "template"]],
  ["起止与辅助", ["start", "end", "io", "note"]],
  ["页面结构", ["page", "section", "component", "nav"]],
  ["工作流执行(docKind=workflow 板专用,可编译执行)", ["wf-script", "wf-test", "wf-agent", "wf-condition", "wf-parallel", "wf-notify"]],
];
/** A4:工具箱按板型给推荐项(置顶 + 「推荐」徽标)。旧实现 26 个类型平铺,用户不知道该点哪个
 * (code 板上「模型调用/知识检索」都排在「函数/模块」前面)。键先按 boardType、再按 docKind 兜底,都没命中=不推荐。 */
const CV_ADD_RECO = {
  code: ["function", "module", "decision"],
  test: ["function", "decision", "module"],
  perf: ["function", "module", "tool"],
  design: ["module", "component", "decision"],
  page: ["page", "section", "component"],
  research: ["decision", "note", "module"],
  composition: ["section", "module", "note"],
  docs: ["section", "note", "module"],
  workflow: ["wf-script", "wf-test", "wf-agent"],
};
function cvAddRecoKinds(doc) {
  const bt = String((doc && doc.boardType) || "").toLowerCase();
  const dk = String((doc && doc.docKind) || "").toLowerCase();
  const hit = CV_ADD_RECO[bt] || CV_ADD_RECO[dk] || [];
  return hit.filter((k) => Object.prototype.hasOwnProperty.call(CV_KIND_NAME, k));
}
let cvUndoStack = [], cvRedoStack = []; // 结构操作撤销/重做(快照上限 60;模式切换即清)
let cvClipboard = null;                 // 复制的 {nodes, edges}
let cvPasteSeq = 0;                     // 连续粘贴错位偏移
let cvDropPt = null;                    // 双击落点(世界坐标;工具箱按钮进入=null=视口中心)
function cvTargetDoc() { return boardEditOn && boardDraft ? boardDraft : boardDoc; }
function cvSnapNow() { return { edit: !!boardEditOn, doc: bdDeepCopy(cvTargetDoc()) }; }
function cvPushUndo() {
  if (!cvTargetDoc()) return;
  cvUndoStack.push(cvSnapNow());
  if (cvUndoStack.length > 60) cvUndoStack.shift();
  cvRedoStack.length = 0;
}
function cvApplySnap(s) {
  if (s.edit) { boardEditOn = true; boardDraft = s.doc; }
  else { boardEditOn = false; boardDraft = null; boardDoc = s.doc; bdSaveLayoutDebounced(); }
  boardSelNode = null;
  cvSelected.clear();
  renderBoard();
}
function cvUndo() {
  if (!cvUndoStack.length) { toast("没有可撤销的操作", true); return; }
  if (boardEditOn && boardSelNode && !bdSyncDraftFromForm()) return; // 表单非法先中止,不吞快照
  cvRedoStack.push(cvSnapNow());
  cvApplySnap(cvUndoStack.pop());
}
function cvRedo() {
  if (!cvRedoStack.length) { toast("没有可重做的操作", true); return; }
  if (boardEditOn && boardSelNode && !bdSyncDraftFromForm()) return;
  cvUndoStack.push(cvSnapNow());
  cvApplySnap(cvRedoStack.pop());
}
function cvAfterStruct() {
 // 结构变化后:重渲(编辑态渲草稿/查看态渲板)。
 // A2(经验证:点「添加模块」→ board.save 要 +1.5s,窗口内切板/刷新即丢):**结构变更立即落盘**,
 // 不再走 900ms 防抖。拖布局仍是 bdSaveLayoutDebounced(高频可丢帧),两者共用 bdLayoutInflight 闸门。
  renderBoard();
  if (!boardEditOn) bdSaveNow();
}
function cvNewNodeId(t) {
  let seq = t.nodes.length + 1;
  while (t.nodes.some((n) => n.id === "n" + seq)) seq++;
  return "n" + seq;
}
// wf-* 节点缺省参数(按类型给可用初值,编译必填项在抽屉里改)。
const WF_DEFAULTS = {
  "wf-script": { command: "ls packages", summary: "确定性命令(world.run 白名单:测试运行器/node/git 只读/ls/cat/grep/tail)" },
  "wf-test": { command: "npx vitest run packages/core/test/journal.test.ts", summary: "测试门:命令退出码非 0 即失败,后续节点不跑" },
  "wf-agent": { actor: "worker", instructions: "", summary: "子代理步骤:指令派给 agent().ask(面板可直答)" },
  "wf-condition": { cond: 'R["n1"].code === 0', summary: '条件分支(JS 表达式引用 R["<节点id>"]);两条出边 label 真/假' },
  "wf-parallel": { summary: "并发扇出:出边 ≥2 全并发(Promise.all)" },
  "wf-notify": { message: "流程完成", summary: "通知/成果登记:report({message})" },
};
function cvAddNode(kind, wx, wy) {
  if (cvRo) return; // 只读画布(设计沉淀):结构改动全禁(工具箱不渲染,此守卫兜委托层)
  const t = cvTargetDoc();
  if (!t) { toast("当前没有白板", true); return; }
  if (t.nodes.length >= 60) { toast("节点数已达上限(60)", true); return; }
  const wfDef = WF_DEFAULTS[kind];
 // wf-* 节点落到 design/page 板=类型混板(编译会拒),当场拦住
  if (wfDef && t.docKind && t.docKind !== "workflow") { toast("wf-* 可执行节点只能放「工作流板」(当前板 docKind=" + (t.docKind || "design") + ")——用「新建工作流板」开一块", true); return; }
  const baseName = CV_KIND_NAME[kind] || "新模块";
 // A4:同类型多个节点不再全叫「函数」——按已有同 kind 节点数带序号(函数 → 函数 2 → 函数 3)
  let sameKind = 0;
  for (const x of t.nodes) if (x && x.kind === (kind || "module")) sameKind++;
  const n = { id: cvNewNodeId(t), kind: kind || "module", label: sameKind ? baseName + " " + (sameKind + 1) : baseName, summary: wfDef ? wfDef.summary : "(写清这个模块干什么用)", change: "add", flow: [],
    pos: { x: Math.max(0, Math.round((wx - 108) / 10) * 10), y: Math.max(0, Math.round((wy - 40) / 10) * 10) } };
  if (wfDef) {
    n.wf = {};
    if (wfDef.command !== undefined) n.wf.command = wfDef.command;
    if (wfDef.actor !== undefined) n.wf.actor = wfDef.actor;
    if (wfDef.instructions !== undefined) n.wf.instructions = wfDef.instructions;
    if (wfDef.cond !== undefined) n.wf.cond = wfDef.cond;
    if (wfDef.message !== undefined) n.wf.message = wfDef.message;
    if (wfDef.timeoutMs !== undefined) n.wf.timeoutMs = wfDef.timeoutMs;
  }
  cvPushUndo();
  t.nodes.push(n);
  boardSelNode = n.id;
  cvSelected.clear();
 // A3(经验证:点完工具箱 2.5~3.4s 才出图,期间旧实现**零反馈** = 用户眼里「点了没反应」):
 // 立即回执「已添加 …· 正在出图…」,并保持新节点选中(右栏明细卡随 renderBoard 带出来)。
  toast("已添加 " + baseName + "「" + n.label + "」· 正在出图…");
  cvAfterStruct(); // renderBoard 会带出明细卡(boardSelNode 已指向新节点)
  try { renderBoardDetail(); } catch (err) { /* 右栏明细卡失败不影响已落的结构变更 */ }
}
// ---- A5:svg 视图的连线入口(补实现) -----------------------------
// 旧口径只有卡片模式的「出端口拖拽」(.cv-port.out),svg 单张图里没有端口节点,选中模块后无从连线。
// 两条入口:选中节点按 L / 右键「连线到…」→ 进连线态(cvLinkFrom) → 点目标模块 → 填关系词 → 落边。
// cvLinkFrom 为 null=不在连线态;命中目标后由 cvLinkAskWord 收线(Enter 落边 / Esc 取消)。
let cvLinkFrom = null;
function cvLinkHint() {
  const h = cvHostEl();
  if (!h || !h.querySelector) return;
  const tip = h.querySelector(".cv-link-hint");
  if (!cvLinkFrom) { if (tip && tip.remove) tip.remove(); if (h.classList) h.classList.remove("cv-linking"); return; }
  if (h.classList) h.classList.add("cv-linking");
  if (!tip) {
    if (typeof document === "undefined") return;
    const el = document.createElement("div");
    el.className = "cv-link-hint";
    h.appendChild(el);
  }
  const t = h.querySelector(".cv-link-hint");
  if (t) {
    const t2 = cvTargetDoc();
    const n = t2 && t2.nodes ? t2.nodes.find((x) => x && x.id === cvLinkFrom) : null;
    t.textContent = "连线:" + ((n && n.label) || cvLinkFrom) + " → 点目标模块(Esc 取消)";
  }
}
/** 进入连线态(选中节点按 L / 右键「连线到…」)。 */
function cvLinkStart(id) {
  if (cvRo) return; // 只读画布:连线全禁
  if (!id) { toast("先在画布上选中一个模块,再按 L 连线", true); return; }
  cvLinkFrom = id;
  cvLinkHint();
}
/** 退出连线态(Esc / 收线自清),并把关系词小框一起收掉。 */
function cvLinkCancel() {
  const h = cvHostEl();
  if (h && h.querySelector) {
    const w = h.querySelector(".cv-link-word");
    if (w && w.remove) w.remove();
  }
  if (!cvLinkFrom) return false;
  cvLinkFrom = null;
  cvLinkHint();
  return true;
}
/** 收线:问关系词(小输入框,Enter 落边 / Esc 取消),最终 cvAddEdge(from, to, label)。 */
function cvLinkAskWord(from, to) {
  const h = cvHostEl();
  if (!from || !to || from === to) return;
  if (!h || !h.appendChild || typeof document === "undefined") { cvAddEdge(from, to); cvLinkFrom = null; return; }
  const old = h.querySelector ? h.querySelector(".cv-link-word") : null;
  if (old && old.remove) old.remove();
  const box = document.createElement("div");
  box.className = "cv-link-word";
  const tip = document.createElement("span");
  tip.textContent = "关系词";
  const inp = document.createElement("input");
  inp.id = "cvLinkWord";
  inp.setAttribute("placeholder", "如 验证 / 调用 / 数据");
  const ok = document.createElement("button");
  ok.textContent = "连线";
  box.appendChild(tip); box.appendChild(inp); box.appendChild(ok);
  h.appendChild(box);
  const commit = () => {
    const word = String(inp.value || "").trim();
    if (box.remove) box.remove();
    cvLinkFrom = null;
    cvLinkHint();
    cvAddEdge(from, to, word); // label 走在第三次参数上,由 cvAddEdge 写进 edges[].label
  };
  const abort = () => { if (box.remove) box.remove(); cvLinkFrom = null; cvLinkHint(); };
  ok.onclick = commit;
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); abort(); }
  });
  try { inp.focus(); } catch (e) { /* 聚焦失败不影响连线 */ }
}
function cvAddEdge(from, to, label) {
  if (cvRo) return; // 只读画布:连线全禁
  const t = cvTargetDoc();
  if (!t || from === to) return;
  if (t.edges.some((x) => x.from === from && x.to === to)) { toast("两模块间已有连线", true); return; }
  if (t.edges.length >= 120) { toast("连线数已达上限", true); return; }
  cvPushUndo();
 // 工作流板:wf-condition 出边自动配分支 label(第一条=真,已有真=假)——编译要求恰两条一真一假
  let wfLabel;
  if (t.docKind === "workflow") {
    const src = t.nodes.find((n) => n.id === from);
    if (src && src.kind === "wf-condition") {
      const hasZhen = t.edges.some((x) => x.from === from && (x.label === "真" || x.label === "then"));
      const outs = t.edges.filter((x) => x.from === from).length;
      wfLabel = hasZhen ? "假" : "真";
      if (outs >= 2) { toast("wf-condition 只能有两条出边(真/假)——先删一条再加", true); cvUndoStack.pop(); return; }
    }
  }
  const rel = String(label == null ? "" : label).trim().slice(0, 24); // A5:人工连线关系词(留空=不写 label)
  const lbl = wfLabel || rel;
  t.edges.push({ from, to, kind: "call", virtual: true, ...(lbl ? { label: lbl } : {}) }); // 人工连线=虚拟边(与 agent code_index 验证边显式区分)
  cvAfterStruct();
  toast(wfLabel ? "已连线(wf-condition " + wfLabel + " 分支)" : rel ? "已连线「" + rel + "」(虚拟边:人工标注,非代码索引实证)" : "已连线(虚拟边:人工标注,非代码索引实证)");
}
function cvDelNodes(ids) {
  if (cvRo) return; // 只读画布:删除全禁
  const t = cvTargetDoc();
  if (!t || !ids || !ids.length) return;
  if (t.nodes.length - ids.length < 1) { toast("至少保留一个模块", true); return; }
  cvPushUndo();
  const s = new Set(ids);
  t.nodes = t.nodes.filter((n) => !s.has(n.id));
  t.edges = t.edges.filter((e) => !s.has(e.from) && !s.has(e.to));
  if (boardSelNode && s.has(boardSelNode)) boardSelNode = null;
  cvSelected.clear();
  cvAfterStruct();
}
function cvCopySel(ids) {
  const t = cvTargetDoc();
  if (!t || !ids || !ids.length) return;
  const nodes = t.nodes.filter((n) => ids.includes(n.id)).map((n) => bdDeepCopy(n));
  if (!nodes.length) return;
  const inSet = new Set(ids);
  cvClipboard = { nodes, edges: t.edges.filter((e) => inSet.has(e.from) && inSet.has(e.to)).map((e) => bdDeepCopy(e)) };
  toast("已复制 " + nodes.length + " 个模块");
}
function cvPaste() {
  if (cvRo) return; // 只读画布:粘贴全禁
  const t = cvTargetDoc();
  if (!t || !cvClipboard || !cvClipboard.nodes.length) return;
  if (t.nodes.length + cvClipboard.nodes.length > 60) { toast("节点数达上限,粘贴取消", true); return; }
  cvPushUndo();
  cvPasteSeq = (cvPasteSeq % 8) + 1;
  const off = 24 + cvPasteSeq * 16;
  const map = new Map();
  for (const src of cvClipboard.nodes) {
    const cp = bdDeepCopy(src);
    const nid = cvNewNodeId(t);
    map.set(src.id, nid);
    cp.id = nid;
    if (cp.pos) cp.pos = { x: Math.max(0, cp.pos.x + off), y: Math.max(0, cp.pos.y + off) };
    cp.comments = []; // 副本不带走原节点的评论
    t.nodes.push(cp);
  }
  for (const e of cvClipboard.edges || []) {
    const from = map.get(e.from), to = map.get(e.to);
    if (from && to && !t.edges.some((x) => x.from === from && x.to === to)) t.edges.push({ from, to, kind: e.kind || "call", ...(e.label ? { label: e.label } : {}) });
  }
  cvSelected.clear();
  for (const nid of map.values()) cvSelected.add(nid); // 渲染按 cvSelected 恢复选中态
  boardSelNode = null;
  cvAfterStruct();
}
function cvArrangeAll() {
  if (cvRo) return; // 只读画布:重排落盘全禁
  const t = cvTargetDoc();
  if (!t) return;
  cvPushUndo();
 // 页面结构板「整理」=语义布局整板落盘(容器化+主线+UI 线框);design 板沿旧分层
  if (t.docKind === "page" && typeof BoardPageLayout !== "undefined") {
    if (cvUiAvailable(t) && cvUiMode === "interaction") {
 // 交互地图:布局位是视图真相,「整理」= 清掉本地拖动微调回到自动网格(不写板 pos)
      cvUiClearMoved(t);
    } else {
      const laid = BoardPageLayout.layout(t);
      for (const n of t.nodes) { const p = laid.pos.get(n.id); if (p) n.pos = { x: p.x, y: p.y }; }
    }
  } else if (String(t.boardType || "") === "composition" && (t.nodes || []).some((n) => n && n.kind === "section")
    && typeof BoardTypeProfile !== "undefined" && typeof BoardTypeProfile.composeLayout === "function") {
 // 2026-11 composition 整理与渲染同口径:主题带+章节主列落盘,否则整理后是另一种排布
    const laid = BoardTypeProfile.composeLayout(t);
    for (const n of t.nodes) { const p = laid.pos.get(n.id); if (p) n.pos = { x: p.x, y: p.y }; }
    cvFlowClearMoved(t.taskId);
  } else if (cvFlowEligible(t)) {
 // fixH2:流动布局「整理」=按入口→主线→出口重新流动排布,并清掉手动微调(回到自动流动)
 // A:整理与渲染同口径(宽板折行也参与),否则用户点整理会得到另一种排布
    const laid = BoardFlowLayout.layout(t, { autoWrap: cvFlowWrapWanted(t, t), preserveLanes: t.boardType === "refactor" });
    for (const n of t.nodes) { const p = laid.pos.get(n.id); if (p) n.pos = { x: p.x, y: p.y }; }
    cvFlowClearMoved(t.taskId);
  } else {
    const laid = cvLayout({ nodes: t.nodes, edges: t.edges }, true); // force=无视旧 pos 全量重排
    for (const n of t.nodes) { const p = laid.get(n.id); if (p) n.pos = { x: p.x, y: p.y }; }
  }
  cvAfterStruct();
  cvViewTouched = false; // 「整理」=让系统重新管视野,随后的自动适配照旧生效
  setTimeout(cvFitNow, 60); // 等重渲落位后适配视野
}
function cvFitNow(forceAll) {
  const cvH = cvHostEl();
  if (!cvH) return;
 // svg 模式:内容包围盒直接取 #cvSvgHost > svg 的 viewBox 宽高(jsdom 里没有 getBBox,
 // 所以只认属性),再叠既有 +60 留白;下面 .cv-node/.cv-ui-cap/.cv-lane 三处 querySelectorAll
 // 在 svg 模式下天然返回空 → 对应分支自然跳过(代码保留,cards 路径逐字不动)。
 // 任务B:「适」改紧凑 fit——优先 diagram-viewport.resolveSvgBoundsFromDom(排除 defs/
 // mask/clipPath/画布背景 rect,只并集可见图形),空白多的 viewBox 大图不再缩成蚂蚁;引擎缺席/
 // 空结果(如 jsdom 无 getBBox)回退 viewBox 口径,行为不劣化。
  const cvFitMode = cvRenderMode();
 // 取证口径开关(默认=紧凑 fit):window.__cvFitBasis==="viewbox" 强制走 viewBox 口径
 // (即旧「适」:内容框=svg viewBox 宽高),用于「同一板/同一 viewport」下新旧口径前后对照截图;
 // 生产路径不设该开关=紧凑口径(curTightSvgBounds),行为与改动前一致。
  const cvFitOldBasis = (typeof window !== "undefined" && window.__cvFitBasis === "viewbox");
  const cvSvgB = cvFitMode === "svg" ? (cvFitOldBasis ? cvSvgContentBox(cvH) : cvTightSvgBounds(cvH)) : null;
  let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
  if (cvSvgB) { minX = cvSvgB.minX || 0; minY = cvSvgB.minY || 0; maxX = (cvSvgB.minX || 0) + cvSvgB.w + 60; maxY = (cvSvgB.minY || 0) + cvSvgB.h + 60; } // 留白口径 +60(与 cvSvgWorldSize 一致);minX/minY=紧凑内容原点(引擎路径才有)
 // w2 密度分层:计数块(.cv-fold)也是要看的东西,一并进适配视野(svg 模式该选择器为空=自动跳过)
  for (const el of cvH.querySelectorAll(".cv-node,.cv-fold")) {
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
 // 尺寸取 DOM 经验证(page 容器宽高可变,旧 220/110 估值会把大容器裁出视野)
    const w = el.offsetWidth || 220, h = el.offsetHeight || 110;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
 // svg 模式下没有任何卡片 DOM:既没 viewBox 也没卡片 → 什么都不做(不能把视图 reset 成 NaN)
  if (cvFitMode === "svg" && !cvSvgB) return;
 // cards 模式:一个节点都没有(空板/未渲染)时照旧直接返回(不改视野)
  if (cvFitMode !== "svg" && !cvH.querySelectorAll(".cv-node").length) return;
 // UI 交互地图:屏外字幕带与顶部摘要/图例也是内容,不能适配时裁掉(独立循环保留旧断言串)
  for (const el of cvH.querySelectorAll(".cv-ui-cap,.cv-ui-head")) {
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    const w = el.offsetWidth || 220, h = el.offsetHeight || 40;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
 // fixH2:泳道虚线框(标题条/内边距)一并进适配视野,不让框被裁边。
 // w2 例外:密度分层时泳道框可跨全板(经验证 60 节点板合并后单框高可达 8000px),把整框算进适配
 // 会把 k 压到 0.1 以下(等于没适配)——分层模式下只按「看得见的卡 + 计数块」适配。
  for (const el of cvH.querySelectorAll(".cv-lane")) {
    if (cvFoldMode) continue;
    const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (el.offsetWidth || 0)); maxY = Math.max(maxY, y + (el.offsetHeight || 0));
  }
 // K:图例不再是画布底部浮层,改到画布外底部占位条(.cv-rail)——#cvHost 的 rect 已自然
 // 扣掉图例高度,原先在这里按图例经验证高度预留 legendReserve 的做法必须删除,否则白压 24~50px。
  const r = cvH.getBoundingClientRect();
 // f5:适配 k 再夹一个可读下限(CV_FIT_READABLE_MIN)——宁可溢出让人平移,也不要标签缩成 6px 糊字。
 // 旧实现给底部图例浮层量高预留(legendReserve); K 把图例移到画布外
 // .cv-rail 后，画布 rect 已不含图例,这里**不再预留**(否则重复扣一遍 24~50px 白压内容)。
 // 页面板顶部有浮动板头(标题/P0 标签),页容器贴顶会压住页标题;预留顶部条高,并把放得下的
 // 内容居中(旧版左对齐贴边,右侧大片空白)。
 // J:原按板型写死 68/88/36px。经验证 UI 结构图根本没有顶部浮层(无 .cv-type-head/.cv-ui-head),
 // 却白留 68px(420px 画布的 16%)——底排卡因此挤进底部图例带。改为「有浮层才留」:浮层存在时
 // 沿用原值(经验证 cv-type-head 高 69px,要留 88),不存在只留 8px。
 // 面板是纯 JS(整段塞进浏览器 <script>),这里绝不能留 TS 泛型/类型标注——否则整段脚本语法错、
 // 面板全白(fit 也一起没了)。类型信息在 JSDoc 里表达,不影响运行。
 /** @type {HTMLElement | null} */
  const headEl = document.querySelector("#boardGraph .cv-type-head, #boardGraph .cv-ui-head");
  const hasHead = !!(headEl && (headEl.offsetHeight || 0) > 4); // 零高/隐藏的浮层不算(结构图里留的占位壳)
  const pageBoard = !!(typeof boardDoc !== "undefined" && boardDoc && boardDoc.docKind === "page");
  const typeBoard = !cvUiInfo && !!(typeof cvTypeProfileOf === "function" && cvTypeProfileOf(cvActiveDoc || (typeof boardDoc !== "undefined" ? boardDoc : null)));
  const baseReserve = cvUiInfo ? (hasHead ? 68 : 8) : typeBoard ? 88 : pageBoard ? 36 : 8;
 // 主题横幅(.cv-theme-band,浮在板头下方 44px 起、约 34px 高):在场时顶部再让一段,
 // 保证自动适配后第一排卡不出现在横幅下方被压住。无横幅的板 topReserve 逐字不变。
  const bandOn = !!(cvH.querySelector(".cv-theme-band") || (cvActiveHost && cvActiveHost.querySelector && cvActiveHost.querySelector(".cv-theme-band")));
 // 层 chip 条(.cv-lbar)也是顶部浮层,同样要让出高度——按经验证底边算,而不是再猜一个像素值。
  const lbarEl = document.querySelector("#boardGraph .cv-lbar");
  const stackBottom = lbarEl && lbarEl.offsetHeight ? (parseFloat(lbarEl.style.top || "0") || 0) + lbarEl.offsetHeight + 8 : 0;
  const topReserve = Math.max(baseReserve + (bandOn ? 40 : 0), stackBottom);
  const availH = Math.max(120, r.height - topReserve);
  const naturalK = Math.min(r.width / (maxX - minX + 40), availH / (maxY - minY + 40));
 // 全览模式(「全」按钮)允许低于可读下限,先把整块板收进视口;标签变小可再点 + 放大。
 // code 板默认保 90% 可读(16 节点/31 边在 70% 下标签会糊);宁可溢出平移,示例图的读法优先。
  const fitMinK = forceAll ? 0.06 : ((cvActiveDoc && cvActiveDoc.boardType === "code") ? 0.9 : CV_FIT_READABLE_MIN);
  cvPan.k = Math.min(CV_MAX_ZOOM, Math.max(fitMinK, naturalK));
  const contentW = (maxX - minX) * cvPan.k;
  const contentH = (maxY - minY) * cvPan.k;
  cvPan.x = contentW < r.width ? (r.width - contentW) / 2 - minX * cvPan.k : 12 - minX * cvPan.k;
  cvPan.y = contentH < availH ? topReserve + (availH - contentH) / 2 - minY * cvPan.k : topReserve - minY * cvPan.k;
  cvApplyTf();
 // 取证/回归用:把本次 fit 的口径与内容框留在 window 上(截图 runner 与调试直接读,不靠推算)。
  try {
    window.__cvFitLast = {
      basis: cvFitMode === "svg" ? (cvFitOldBasis ? "viewbox" : "tight") : "cards",
      minX: Math.round(minX), minY: Math.round(minY),
      w: Math.round(maxX - minX), h: Math.round(maxY - minY),
      k: Math.round(cvPan.k * 10000) / 10000,
      view: { w: Math.round(r.width), h: Math.round(r.height) },
    };
  } catch (e) { /* 取证字段失败不影响视图 */ }
  if (forceAll) {
    try { toast("全览 " + Math.round(cvPan.k * 100) + "%:标签暂隐,可点 + 放大;导出 PNG 可看 100% 全图"); } catch (err) { /* toast 失败不影响视图 */ }
  }
 // fixE4:自适配 k<阈值 → 边标签进 z-low 全隐(小视口开大板开板即无任何标签,用户不知标签存在)。
 // fixH2:流动板标签是数据格式/触发条件主信息,降阈到 0.42(主线/边标签优先保住)。
 // 一次性 toast(每板每会话一次,sessionStorage 键 fixE-labelhint-<taskId>);仅对确有标签的板提示,无标签板不打扰。
 // 全览模式已有自己的 toast,不再重复。
  if (!forceAll) {
  try {
    const labelHideK = cvLabelHideK(); // 与 cvApplyTf 的 z-low 同一出处(见 cvLabelHideK)
    if (cvPan.k < labelHideK) {
      const d = boardDoc || cvActiveDoc;
      if (d && d.taskId && d.edges.some((e) => e.label)) {
        const key = "fixE-labelhint-" + d.taskId;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          toast("已缩小适配画布(" + Math.round(cvPan.k * 100) + "%):连线关系词暂隐(标签在 <" + Math.round(labelHideK * 100) + "% 时隐藏),放大即可查看");
        }
      }
    }
  } catch (err) { /* sessionStorage 不可用环境静默忽略 */ }
  }
}
/** 画布底部工具条的「添加模块/整理」两钮。
 * svg 模式(flowkit 单张图)的布局由服务端 ELK 决定,panel 侧改 pos 不改图 → 「整理」点了只会静默空转,
 * 故在 svg 模式下置灰并写明原因(三态处置:修复/移除/标记 —— 这里取「标记」,功能待重做)。
 * cards 模式逐字保持旧串(既有测试按源码序断言)。 */
function cvRailAddbarHtml(mode) {
  if (mode === "svg") {
    return '<div class="cv-addbar"><button id="cvAddBtn" title="添加一个工作流模块(双击画布空白=在落点添加)">+ 添加模块</button>' +
      '<button id="cvArrangeBtn" disabled title="当前为 flowkit 布局:重排由服务端 ELK 自动完成,画布坐标不参与出图;要恢复手动排布请回退卡片渲染(localStorage.cvRender=cards)">整理</button></div>';
  }
  return '<div class="cv-addbar"><button id="cvAddBtn" title="添加一个工作流模块(双击画布空白=在落点添加)">+ 添加模块</button><button id="cvArrangeBtn" title="按调用关系自动重排全部模块">整理</button></div>';
}
function cvOpenAddPanel(pt) {
  cvDropPt = pt || null;
  const p = $("cvAddPanel");
  if (!p) return;
  p.style.display = "block";
 // A4:按当前板型把推荐类型置顶并标「推荐」(code 板=函数/模块/决策),其余分组原样跟在后面。
  const reco = (() => { try { return cvAddRecoKinds(cvTargetDoc()); } catch (e) { return []; } })();
  const itemHtml = (k) => '<div class="cv-aitem' + (reco.indexOf(k) >= 0 ? " cv-reco-on" : "") + '" data-kind="' + k + '">' +
    '<span class="cv-kind cv-k-' + k + '">' + (CV_KIND_ICON[k] || "?") + "</span>" + (CV_KIND_NAME[k] || k) +
    (reco.indexOf(k) >= 0 ? '<span class="cv-reco">推荐</span>' : "") + "</div>";
  p.innerHTML = '<input id="cvAddSearch" placeholder="搜索模块类型">';
  if (reco.length) p.innerHTML += '<div class="cv-agrp">推荐(当前板型)</div>' + reco.map(itemHtml).join("");
  for (const [grp, kinds] of CV_KIND_GROUPS) {
    const rest = kinds.filter((k) => reco.indexOf(k) < 0); // 推荐项已置顶,不在分组里重复出现
    if (!rest.length) continue;
    p.innerHTML += '<div class="cv-agrp">' + grp + "</div>" + rest.map(itemHtml).join("");
  }
  const si = $("cvAddSearch");
  if (si) si.oninput = () => {
    const q = si.value.trim().toLowerCase();
    for (const it of p.querySelectorAll(".cv-aitem")) it.style.display = !q || (CV_KIND_NAME[it.dataset.kind] || "").toLowerCase().includes(q) || it.dataset.kind.includes(q) ? "flex" : "none";
  };
}
function cvCloseCtx() { const m = $("cvCtx"); if (m) m.remove(); }
function ox_of(st, e, axis) { return axis === "x" ? st.ox + (e.clientX - st.sx) : st.oy + (e.clientY - st.sy); }
/** fixH2:边箭头 marker 定义(首渲/拖拽重绘共用;绿色=流动主线,灰色=其余)。
 * 页面结构板/旧 design 板无主色差异时只用 cvarrow,行为与旧版一致。 */
/** UI 交互地图边缘定义:每个流程组一个彩色箭头(marker id uia0..)+ 回边/逻辑/辅助专用箭头。 */
function cvUiFlowDefs(info) {
  if (!info) return "";
  let out = "<defs>";
  const pal = info.palette || [];
  for (let i = 0; i < pal.length; i++) {
    out += '<marker id="uia' + i + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="' + pal[i].line + '"/></marker>';
  }
  const sp = info.special || {};
  if (sp.back) out += '<marker id="uiback" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="' + sp.back.line + '"/></marker>';
  if (sp.logic) out += '<marker id="uilogic" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="' + sp.logic.line + '"/></marker>';
  if (sp.aux) out += '<marker id="uiaux" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="' + sp.aux.line + '"/></marker>';
  return out + "</defs>";
}
/** UI 交互地图连线段(布局引擎已算好 path/label/leader;这里只负责 SVG 呈现)。
 * 形态:元素触点(彩点)+ 短引线到屏边 + 正交流线 + 目标箭头 + 线上标签;虚线段=返回/逻辑。 */
function cvUiFlowEdgeInner(doc, info) {
  if (!info || !info.flows) return "";
  let out = "";
  for (const f of info.flows) {
    if (!f || !f.path) continue;
    const color = f.color || "#8a7a5a";
    const txtColor = f.textColor || "#e6d9bf";
    const marker = "url(#" + (f.marker || "cvarrow") + ")";
    const dash = f.dash ? ' stroke-dasharray="' + f.dash + '"' : "";
    const width = f.main ? 2.8 : 1.8;
    const title = esc((f.label || "交互") + "  [" + (f.sourcePage || f.source.id) + " → " + (f.targetPage || f.target.id) + "]");
    out += '<g class="cv-edge cv-edge-ui" data-uiflow="' + esc(f.groupKey || "") + '" data-uifrom="' + esc(f.sourcePage || "") + '" data-uito="' + esc(f.targetPage || "") + '">';
    if (f.leaderFrom) out += '<path class="bfe-ui-leader" d="' + f.leaderFrom + '" stroke="' + color + '" stroke-width="' + width + '"' + dash + '><title>触发元素:' + esc(f.label || "") + "</title></path>";
    out += '<path class="bfe-hit" d="' + f.path + '"/>';
    const arrowOnMain = !(f.target && f.target.element && f.leaderTo);
    out += '<path class="bfe-ui-flow' + (f.main ? " uimain" : "") + (f.kind === "back" ? " uiback" : "") + '" d="' + f.path + '" fill="none" stroke="' + color + '" stroke-width="' + width + '"' + dash + (arrowOnMain ? ' marker-end="' + marker + '"' : "") + "><title>" + title + "</title></path>";
    if (f.leaderTo) out += '<path class="bfe-ui-leader" d="' + f.leaderTo + '" stroke="' + color + '" stroke-width="' + width + '"' + dash + ' marker-end="' + marker + '"><title>' + title + "</title></path>";
 // 元素触点:同一元素多条流时按边号微偏移,避免后画的颜色把前面的完全盖住
    if (f.dotFrom) {
      const ox = ((f.idx % 3) - 1) * 3.5, oy = ((Math.floor(f.idx / 3) % 3) - 1) * 3.5;
      out += '<circle class="bfe-ui-dot" cx="' + (f.dotFrom.x + ox) + '" cy="' + (f.dotFrom.y + oy) + '" r="3.1" fill="' + color + '"><title>触发:' + esc(f.label || "") + "</title></circle>";
    }
    if (f.dotTo) out += '<circle class="bfe-ui-dot" cx="' + f.dotTo.x + '" cy="' + f.dotTo.y + '" r="3.1" fill="' + color + '"><title>到达:' + esc(f.label || "") + "</title></circle>";
    if (f.labelText) {
      const lw = f.labelW || Math.min(210, Math.max(42, String(f.labelText).length * 6.6 + 14));
      const lx = f.labelAnchor === "start" ? f.labelX - 4 : f.labelX - lw / 2;
      const tx = f.labelAnchor === "start" ? f.labelX : f.labelX;
      out += '<rect class="bfe-ui-label-bg" x="' + lx + '" y="' + (f.labelY - 9) + '" width="' + lw + '" height="18" rx="4" stroke="' + color + '" stroke-opacity=".55"/>' +
        '<text class="bfe-ui-label" x="' + tx + '" y="' + (f.labelY + 3) + '" fill="' + txtColor + '" text-anchor="' + (f.labelAnchor || "middle") + '">' + esc(f.labelText) + "</text>";
    }
    out += "</g>";
  }
  return out;
}
/** UI 交互地图的顶层锚点层:主连线在卡片下面(SVG 边层 z 低),箭头/触点在卡片上面,
 * 保证「起点落在触发控件、终点箭头落在目标控件/目标页大框/浮层边框」肉眼可见。
 * 框内(页内交互、同页弹窗)的整段流线也画在这里;所有段落共用同一 color/width/dash。 */
function cvUiAnchorOverlay(info, W, H) {
  if (!info || !info.flows || !info.flows.length) return "";
  let out = '<svg class="bf-cv-ui-anchors" width="' + W + '" height="' + H + '" style="position:absolute;left:0;top:0;pointer-events:none;z-index:30;overflow:visible">';
  for (const f of info.flows) {
    const sp = f.startPoint || f.dotFrom;
    const ep = f.endPoint || f.dotTo;
    const color = f.color || "#8a7a5a";
    const dash = f.dash ? ' stroke-dasharray="' + f.dash + '"' : "";
    const sw = f.main ? 2.8 : 1.8;
    const title = esc((f.label || "交互") + "  [" + (f.sourcePage || f.source.id) + " → " + (f.targetPage || f.target.id) + "]");
    const inPage = f.kind === "inner" || (f.kind === "popup" && f.sourcePage && f.sourcePage === f.targetPage);
    const srcCovered = !!(info.popupCovered && info.popupCovered.has(f.source.id));
    if (inPage && f.path && !srcCovered) out += '<path d="' + f.path + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round" stroke-linejoin="round"><title>' + title + "</title></path>";
 // 触发控件→源页边界(逻辑流直接复用布局引擎给的引线路径);被浮层窗口盖住的控件不画起笔段,
 // 否则整条竖线会压在浮层/兄弟行上——主线从页边开始,目标箭头照常。
    if (!srcCovered && f.leaderFrom) out += '<path d="' + f.leaderFrom + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round" stroke-linejoin="round"><title>触发元素:' + esc(f.label || "") + "</title></path>";
    else if (!srcCovered && !inPage && sp && f.startBoundary) {
      const dx = f.startBoundary.x - sp.x, dy = f.startBoundary.y - sp.y;
      if (Math.abs(dx) + Math.abs(dy) > 1.5) out += '<line x1="' + sp.x + '" y1="' + sp.y + '" x2="' + f.startBoundary.x + '" y2="' + f.startBoundary.y + '" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round"/>';
    }
 // 浮层内按钮跳外页:控件→浮层边框(startBoundary)已画,这里补浮层边框→源页大框。
    if (!srcCovered && !inPage && f.startPopupBoundary && f.startPageBoundary &&
      (Math.abs(f.startPopupBoundary.x - f.startPageBoundary.x) + Math.abs(f.startPopupBoundary.y - f.startPageBoundary.y) > 1.5)) {
      out += '<line x1="' + f.startPopupBoundary.x + '" y1="' + f.startPopupBoundary.y + '" x2="' + f.startPageBoundary.x + '" y2="' + f.startPageBoundary.y + '" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round"/>';
    }
 // 目标页边界→浮层边框 / 目标页边界→目标控件
    if (f.leaderTo) out += '<path d="' + f.leaderTo + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round" stroke-linejoin="round"><title>' + title + "</title></path>";
    else if (!inPage && ep && f.target && f.target.popup && f.targetPageBoundary &&
      (Math.abs(f.targetPageBoundary.x - ep.x) + Math.abs(f.targetPageBoundary.y - ep.y) > 1.5)) {
      out += '<line x1="' + f.targetPageBoundary.x + '" y1="' + f.targetPageBoundary.y + '" x2="' + ep.x + '" y2="' + ep.y + '" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round"/>';
    } else if (!inPage && ep && f.endBoundary) {
      const dx2 = f.endBoundary.x - ep.x, dy2 = f.endBoundary.y - ep.y;
      if (Math.abs(dx2) + Math.abs(dy2) > 1.5) out += '<line x1="' + f.endBoundary.x + '" y1="' + f.endBoundary.y + '" x2="' + ep.x + '" y2="' + ep.y + '" stroke="' + color + '" stroke-width="' + sw + '"' + dash + ' stroke-linecap="round"/>';
    }
    if (sp && !srcCovered) out += '<circle cx="' + sp.x + '" cy="' + sp.y + '" r="3.2" fill="' + color + '" stroke="rgba(0,0,0,.5)" stroke-width="1"><title>触发:' + esc(f.label || "") + "</title></circle>";
    if (ep) {
      const side = f.endSide || "left";
      const s6 = 6;
      let pts = "";
 // 箭头尖落在控件/页框/浮层边缘(1px 内侧),主体在外——明确指向目标但不过度盖住内容
      if (side === "right") pts = (ep.x + s6) + "," + (ep.y - 4) + " " + (ep.x - 1) + "," + ep.y + " " + (ep.x + s6) + "," + (ep.y + 4);
      else if (side === "top") pts = (ep.x - 4) + "," + (ep.y - s6) + " " + ep.x + "," + (ep.y + 1) + " " + (ep.x + 4) + "," + (ep.y - s6);
      else if (side === "bottom") pts = (ep.x - 4) + "," + (ep.y + s6) + " " + ep.x + "," + (ep.y - 1) + " " + (ep.x + 4) + "," + (ep.y + s6);
      else pts = (ep.x - s6) + "," + (ep.y - 4) + " " + (ep.x + 1) + "," + ep.y + " " + (ep.x - s6) + "," + (ep.y + 4);
      const inferred = !!(f.target && f.target.inferred);
      const dstKind = f.target && f.target.popup ? "到达浮层:" : f.target && f.target.pageFrame ? "到达页面:" : "到达:";
      out += '<polygon points="' + pts + '" fill="' + color + '"><title>' + esc((inferred ? "推断目标:" : dstKind) + (f.label || "")) + "</title></polygon>";
      if (inferred) out += '<circle cx="' + ep.x + '" cy="' + ep.y + '" r="5.2" fill="none" stroke="' + color + '" stroke-width="1" stroke-dasharray="2 2"/>';
    }
  }
  return out + "</svg>";
}
/** 工程师流程图:code flow 板连线横平竖直(示例图风格)。
 * 端口:目标在右=右中→左中;正下/正上=中下/中上;回边=绕世界底部。
 * decision 的端口必须落菱形顶点(卡片外框比菱形大 64px,落外框箭头会悬空)。
 * 返回 {d,lx,ly}:d 只含 M/L 段;标签/删除钮锚在最长的横/竖段中点。 */
function cvCodeOrthoRoute(a, b, sa, sb, kindA, kindB, bounds, ei) {
  function inner(nk, p, w, h) {
    if (nk !== "decision") return { x: p.x, y: p.y, w: w, h: h };
    const cw = Math.min(132, w - 6), ch = Math.min(132, h - 6);
    return { x: p.x + (w - cw) / 2, y: p.y + (h - ch) / 2, w: cw, h: ch };
  }
  const A = inner(kindA, a, (sa && sa.w) || 216, (sa && sa.h) || 60);
  const B = inner(kindB, b, (sb && sb.w) || 216, (sb && sb.h) || 60);
  const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
  const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
  const ar = A.x + A.w, ab = A.y + A.h, br = B.x + B.w, bb = B.y + B.h;
  const rightGap = B.x - ar, downGap = B.y - ab, upGap = A.y - bb;
  let d = "", lx = 0, ly = 0, vert = false;
  function seg(pts) {
    d = pts.map(function (p, i) { return (i ? "L " : "M ") + Math.round(p[0]) + " " + Math.round(p[1]); }).join(" ");
    let bi = 1, bl = -1;
    for (let i = 1; i < pts.length; i++) {
      const len = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
      if (len > bl) { bl = len; bi = i; }
    }
    const p0 = pts[bi - 1], p1 = pts[bi];
    lx = (p0[0] + p1[0]) / 2;
 // 横段标签放线上方;竖段标签由渲染层挪到线右侧(避免压住泳道标题)
    vert = Math.abs(p1[1] - p0[1]) > Math.abs(p1[0] - p0[0]);
    ly = (p0[1] + p1[1]) / 2 - (vert ? 0 : 12);
  }
  const nearX = Math.max(20, A.w * 0.2);
 // 1) 正下/正上且水平基本对齐:竖线直下(decision 的「否」分支最常走这里)
  if (downGap >= 0 && (rightGap < 2 || Math.abs(bcx - acx) <= nearX)) {
    if (Math.abs(bcx - acx) <= 2) seg([[acx, ab], [bcx, B.y]]);
    else {
 // 跨行时把横段放到目标泳道标题上方(组框顶部 ≈ B.y-42):不压方法名;
 // 同排多条分支按 ei 错开 10px,避免「是/否」两条横线重叠
      const my = downGap > 60 ? Math.max(ab + 8, B.y - 46 - (ei % 3) * 10) : ab + Math.max(16, Math.min(downGap / 2, 44));
      seg([[acx, ab], [acx, my], [bcx, my], [bcx, B.y]]);
    }
    return { d: d, lx: lx, ly: ly, vert: vert };
  }
  if (upGap >= 0 && (rightGap < 2 || Math.abs(bcx - acx) <= nearX)) {
    if (Math.abs(bcx - acx) <= 2) seg([[acx, A.y], [bcx, bb]]);
    else {
      const my = bb + Math.max(16, Math.min(upGap / 2, 44));
      seg([[acx, A.y], [acx, my], [bcx, my], [bcx, bb]]);
    }
    return { d: d, lx: lx, ly: ly, vert: vert };
  }
 // 2) 目标在右:右中→左中;同排=一条直线(主线因此贯穿到底),错排=列间空隙竖折
  if (rightGap >= 2) {
    const x1 = ar, x2 = B.x, y1 = acy, y2 = bcy;
    if (Math.abs(y2 - y1) <= 2) seg([[x1, y1], [x2, y2]]);
    else {
      const off = Math.min(Math.max(rightGap / 2, 22), 72);
      const mx = x1 + Math.max(6, Math.min(rightGap - 4, off)) + (ei % 2 ? 7 : 0);
      seg([[x1, y1], [mx, y1], [mx, y2], [x2, y2]]);
    }
    return { d: d, lx: lx, ly: ly, vert: vert };
  }
 // 3) 回边/目标在左:绕世界底部,不穿主图(参考图的反馈线)
  const laneY = (bounds && isFinite(bounds.y) && isFinite(bounds.h) ? bounds.y + bounds.h + 24 : Math.max(ab, bb) + 30) + (ei % 3) * 12;
  seg([[acx, ab], [acx, laneY], [bcx, laneY], [bcx, B.y]]);
  return { d: d, lx: lx, ly: ly, vert: vert };
}
function cvEdgeDefs() {
  return '<defs><marker id="cvarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a7a5a"/></marker>' +
    '<marker id="cvarrowmain" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4fbf7a"/></marker></defs>';
}
/** 十期:边 SVG 内部构造(首渲与拖拽重绘共用一份;含命中热区+悬停删除钮)。
 * data-eidx=doc.edges 真实下标(悬空边跳过渲染但下标不连续——删除按下标 splice 对齐真相)。
 * pgInfo(页面结构板布局信息)非空时——contains 不画线(容器框已表达包含)、
 * 端点按容器 size、主线边 bfe-main(粗金)、回边 bfe-back(虚线灰)、自环画容器顶小回环弧、
 * 标签放宽至 16 字(触发动作是语义主信息);pgInfo=null(design 板/资产加载失败)行为与旧版逐字节一致。
 * fixH2:pgInfo.mode=flow(流动布局)——普通边细灰(bfe-flow)、主线粗绿(bfe-main+绿箭头)、
 * 边标签 10px+浅色底+主线加粗(标签写数据格式/触发条件)。 */
function cvEdgeInner(doc, pos, pgInfo) {
  if (pgInfo && pgInfo.mode === "ui-flow") return cvUiFlowEdgeInner(doc, pgInfo);
  const isFlow = !!(pgInfo && pgInfo.mode === "flow");
 // docs 两层 PPT:contains(章→页)无线(归属由章容器表达);data(章间推进)画正交竖折线
  const isDocsDeckEdges = !!(pgInfo && pgInfo.docsDeck);
 // 工程师 flow:code 板横平竖直正交连线(其它板型保持原贝塞尔)
  const ortho = isDocsDeckEdges || !!(pgInfo && pgInfo.codeFlow && isFlow);
  const kindById = new Map(((doc && doc.nodes) || []).map((n) => [n.id, n.kind]));
  const nodePos = (id) => pos.get(id) || { x: 0, y: 0 };
  const selfSet = new Set((pgInfo && pgInfo.selfLoops) || []);
  let out = "";
  doc.edges.forEach((e, ei) => {
    if (!doc.nodes.some((n) => n.id === e.from) || !doc.nodes.some((n) => n.id === e.to)) return;
    if (pgInfo && !isFlow && (e.kind || "") === "contains" && !isDocsDeckEdges) return; // 容器语义已由容器框表达
    if (String(e.label || "") === "同组次序") return; // 系统推导边=布局辅助,不是设计关系;上画布会把页面结构画成顺序链
    const a = nodePos(e.from), b = nodePos(e.to);
    if (selfSet.has(ei)) {
 // 自环:容器顶部右侧小回环弧(「拖入自动导入」类同页动作)
      const sa0 = (pgInfo && pgInfo.size.get(e.from)) || { w: 216, h: 110 };
      const x0 = a.x + sa0.w - 46, y0 = a.y;
      const dl = "M " + x0 + " " + (y0 + 3) + " C " + (x0 + 30) + " " + (y0 - 26) + ", " + (x0 + 48) + " " + (y0 - 26) + ", " + (x0 + 10) + " " + (y0 + 3);
      out += '<g class="cv-edge" data-eidx="' + ei + '"><path class="bfe-hit" d="' + dl + '"/><path class="bfe-nav bfe-selfloop" d="' + dl + '" marker-end="url(#cvarrow)">' + (e.label ? "<title>" + esc(e.label) + "</title>" : "") + "</path>";
      if (e.label) out += '<text class="bf-cv-edge-label" x="' + (x0 - 58) + '" y="' + (y0 - 22) + '">' + esc(e.label.slice(0, 16)) + "</text>";
      out += "</g>";
      return;
    }
    const sa = (pgInfo && pgInfo.size.get(e.from)) || null;
    const sb = (pgInfo && pgInfo.size.get(e.to)) || null;
    let d = "", lx = 0, ly = 0, bx1 = 0, by1 = 0, bx2 = 0, by2 = 0, vert = false;
    if (ortho) {
      const r = cvCodeOrthoRoute(a, b, sa, sb, kindById.get(e.from), kindById.get(e.to), pgInfo.bounds, ei);
      d = r.d; lx = r.lx; ly = r.ly; vert = !!r.vert;
    } else {
      const wa = sa ? sa.w : 216, ha = sa ? sa.h : 60, hb = sb ? sb.h : 60;
      bx1 = a.x + wa; by1 = a.y + ha / 2; bx2 = b.x; by2 = b.y + hb / 2; // 端口:右中→左中
      const dx = Math.max(36, (bx2 - bx1) / 2);
      d = "M " + bx1 + " " + by1 + " C " + (bx1 + dx) + " " + by1 + ", " + (bx2 - dx) + " " + by2 + ", " + bx2 + " " + by2;
      lx = (bx1 + bx2) / 2;
      ly = (by1 + by2) / 2 - 15;
    }
    let isMain = false;
    let ecl;
    if (isFlow) {
 // fixH2 流动板:其余边细灰(去金,主线唯一亮色);主线粗绿+流动虚线动画(见 CSS)
      ecl = "bfe-flow" + (e.virtual ? " bfe-virtual" : "");
      isMain = !!(pgInfo.mainEdges && pgInfo.mainEdges.has(e.from + ">" + e.to));
      if (isMain) ecl += " bfe-main bfe-main-flow";
      else if (pgInfo.backEdges && pgInfo.backEdges.has(e.from + ">" + e.to)) ecl += " bfe-back";
    } else {
      ecl = "bfe-" + (e.kind || "call") + (e.virtual ? " bfe-virtual" : "");
      if (pgInfo) {
        const ek = e.from + ">" + e.to;
        if (pgInfo.mainEdges.has(ek)) ecl += " bfe-main";
        else if (pgInfo.backEdges && pgInfo.backEdges.has(ek)) ecl += " bfe-back";
      }
    }
    const marker = isMain ? "url(#cvarrowmain)" : "url(#cvarrow)";
    out += '<g class="cv-edge" data-eidx="' + ei + '"><path class="bfe-hit" d="' + d + '"/>' +
 // 虚拟边(人工标注)叠 bfe-virtual 虚线样式,title 如实标注「非代码索引验证」
 // contains 边无线头(包含语义),其余 kind 保留箭头
      '<path class="' + ecl + '" d="' + d + '"' + (e.kind === "contains" && !isFlow ? "" : ' marker-end="' + marker + '"') + '>' + (e.virtual ? "<title>虚拟边:人工标注,待代码索引核实</title>" : (e.label ? "<title>" + esc(e.label) + "</title>" : "")) + "</path>";
    if (e.label) {
      if (isFlow) {
 // 流动板标签:浅色底小条+主线加粗,写数据格式/触发条件;长度放宽到 20 字(超出省略号)
 // ortho 路径:横段标签在线上方;竖段标签挪到线右侧,避免压住泳道标题/方法名
        const fullTxt = String(e.label || "");
        const txt = fullTxt.length > 20 ? fullTxt.slice(0, 19) + "…" : fullTxt;
        const estW = Math.min(170, Math.max(30, txt.length * 6.6 + 10));
        const lx0 = ortho && vert ? lx + 10 : lx - estW / 2;
 // 竖段标签下移 18px:避开目标泳道标题(标题在组框顶部,竖段中点常与其同高)
        const ly0 = ortho && vert ? ly + 18 : ly;
        out += '<rect class="bf-cv-edge-label-bg' + (isMain ? " main" : "") + '" x="' + lx0 + '" y="' + (ly0 - 10) + '" width="' + estW + '" height="13" rx="3"/>' +
          '<text class="bf-cv-edge-label' + (isMain ? " bf-cv-edge-label-main" : "") + '" x="' + (lx0 + 5) + '" y="' + ly0 + '">' + esc(txt) + "</text>";
      } else {
        out += '<text class="bf-cv-edge-label" x="' + ((bx1 + bx2) / 2 - 14) + '" y="' + ((by1 + by2) / 2 - 16) + '">' + esc(e.label.slice(0, pgInfo ? 16 : 12)) + "</text>";
      }
    }
    out += '<g class="cv-edge-del" transform="translate(' + (ortho ? lx : (bx1 + bx2) / 2) + "," + (ortho ? ly + 5 : (by1 + by2) / 2 - 5) + ')"><circle r="8"/><line x1="-3.2" y1="-3.2" x2="3.2" y2="3.2"/><line x1="3.2" y1="-3.2" x2="-3.2" y2="3.2"/></g></g>';
  });
  return out;
}
function cvRedrawEdges(host, doc, pos) {
  const svg = host.querySelector(".bf-cv-edges");
  if (!svg) return;
 // 重建全部边(节点量 ≤60,直接重建最快;与首渲共用 cvEdgeInner,拖拽中删除钮/标签不掉)
 // /fixH2:布局信息取全局 page 优先、flow 次之(=本 host 最近一次 renderBoardCanvas 的引擎信息)
  svg.innerHTML = cvEdgeDefs() + cvUiFlowDefs(cvUiInfo) + cvEdgeInner(doc, pos, cvPageInfo || cvFlowInfo);
  const anchors = host.querySelector(".bf-cv-ui-anchors");
  if (anchors && cvUiInfo) anchors.outerHTML = cvUiAnchorOverlay(cvUiInfo, anchors.getAttribute("width"), anchors.getAttribute("height"));
}
let bdLayoutTimer = null;
let bdLayoutInflight = false; // 直改板保存在途(十期):回执/冲突前不再发下一笔,防 baseRev 竞态把结构改动打进 conflict 丢掉
let bdSentSig = ""; // 续作轮:在途笔发出时的结构签名(含 pos;回执落地时比对,识别「在途窗内用户又改了结构/位置」)
/** 直改板在途笔回执比对签名:cvStructSig(结构)+节点 pos(拖拽也是直改板,回执同样不得回灌)。 */
function bdSentStructSig(doc) {
  let s = cvStructSig(doc, false);
  for (const n of doc.nodes) s += (n.pos && isFinite(n.pos.x) ? Math.round(n.pos.x) + "," + Math.round(n.pos.y) : "np") + ";";
  return s;
}
/** 结构变更(增/删/连线/粘贴)立即落盘( A2)。
 * 旧实现只走 bdSaveLayoutDebounced 的 900ms 防抖 → 经验证「添加模块」到 board.save 有 1.5s 空窗,
 * 用户中途切板/刷新就把这次结构变更丢了(画布上看得见、服务器上没有)。
 * · 复用 bdLayoutInflight 闸门(防 baseRev 竞态把改动打进 conflict);
 * · **在途不丢**:置 bdSaveQueued,回执落地后由 bdSaveFlushQueued 补发一笔(不是丢弃重排);
 * · 待发防抖笔被本笔代表(clearTimeout),不重复发同内容。 */
let bdSaveQueued = false;
function bdSaveNow() {
  if (!boardDoc || cvRo) return false;
  if (bdLayoutTimer) { clearTimeout(bdLayoutTimer); bdLayoutTimer = null; }
  if (bdLayoutInflight) { bdSaveQueued = true; if (!bdLayoutTimer) bdLayoutTimer = setTimeout(bdSaveFlushQueued, 320); return false; }
  bdSaveQueued = false;
  bdLayoutInflight = true;
  bdSentSig = bdSentStructSig(boardDoc); // 记发出态:回执与本地现状不一致=在途窗内又有新编辑(见 board.doc 分支)
  const doc = JSON.parse(JSON.stringify(boardDoc));
  try { wsSafeSend(JSON.stringify({ v: 1, type: "board.save", sessionId: currentSid, taskId: boardTaskId, doc, baseRev: boardDoc.rev })); }
  catch (e) { bdLayoutInflight = false; toast("白板保存失败(网络):改动还在本地,稍后会自动重试", true); return false; }
  return true;
}
/** 在途笔回执落地后补发排队的那一笔(A2「在途不丢」)。 */
function bdSaveFlushQueued() {
  if (!bdSaveQueued) return;
  if (bdLayoutInflight) { if (!bdLayoutTimer) bdLayoutTimer = setTimeout(bdSaveFlushQueued, 320); return; }
  bdSaveQueued = false;
  if (!boardDoc || cvRo) return;
  if (!bdSaveNow()) return; // 仍发不出去:bdSaveNow 会重新排队
  toast("已保存上一处结构改动(补发)");
}
function bdSaveLayoutDebounced() {
  if (bdLayoutTimer) clearTimeout(bdLayoutTimer);
  bdLayoutTimer = setTimeout(() => {
    bdLayoutTimer = null;
    if (!boardDoc || cvRo) return; // cvRo:档案只读画布在位时禁止任何直改板落盘(防沉淀板写进会话通道)
    if (bdLayoutInflight) { bdSaveLayoutDebounced(); return; } // 上一笔在途:推迟到回执后重排
    bdLayoutInflight = true;
    bdSentSig = bdSentStructSig(boardDoc); // 记发出态:回执若与本地现状不一致=在途窗内有新编辑,回执不得回滚(见 board.doc 分支)
    const doc = JSON.parse(JSON.stringify(boardDoc));
    wsSafeSend(JSON.stringify({ v: 1, type: "board.save", sessionId: currentSid, taskId: boardTaskId, doc, baseRev: boardDoc.rev }));
 // 静默保存:回执 board.doc 会走 boardSaveInflight=false 分支正常刷新(不退编辑态——本来就不在编辑态)
  }, 900);
}
/* (重试轮,最小改动面):done 板拖拽守卫——落盘前的唯一闸门。
 * 命中条件:非编辑态 + 板 status==="done" + 本会话未授权。命中时弹一条 toast 风格自绘确认条
 * (两个按钮「允许编辑/取消」):允许→sessionStorage 记住本会话 + 补落盘;取消→位置回滚为拖拽前值。
 * 返回 true=本次已拦截(调用方不得落盘);false=放行,既有落盘行为一字不动。
 * 非 done 板/已授权态零开销直通;确认条建不出来/守卫自身异常一律退化为旧行为(不阻断落盘)。 */
let bdDoneDragPending = null; // 悬挂中的确认条回调(再次拖拽时先结算上一次:未应答=取消回滚)
function bdDoneDragPrompt(onAllow, onCancel) {
  try {
    const old = document.getElementById("bdDoneDragPrompt");
    if (old) {
      old.remove();
 // 旧条被新拖拽顶掉:上一次拖拽既未落盘也未回滚,按「取消」结算,防悬挂位移被后续落盘顺带写入
      if (bdDoneDragPending) { const p = bdDoneDragPending; bdDoneDragPending = null; try { p(); } catch (e) { /* 单点失败不炸画布 */ } }
    }
    const host = $("toastHost");
    if (!host) return false; // 建不出来=不拦截(调用方照旧落盘)
    const bar = document.createElement("div");
    bar.id = "bdDoneDragPrompt";
    bar.className = "toast";
    bar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:420px";
    const msg = document.createElement("span");
    msg.textContent = "该白板已完成(status=done):拖拽改动默认不落盘。";
    const ok = document.createElement("button");
    ok.textContent = "允许编辑";
    ok.style.cssText = "cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:3px 10px;background:var(--accent-soft);color:var(--text);font-size:12px";
    const no = document.createElement("button");
    no.textContent = "取消";
    no.style.cssText = "cursor:pointer;border:1px solid var(--border-soft);border-radius:8px;padding:3px 10px;background:transparent;color:var(--muted);font-size:12px";
    const finish = (fn) => {
      bdDoneDragPending = null;
      bar.remove();
      try { fn(); } catch (e) { /* 单点失败不炸画布 */ }
    };
    ok.onclick = () => finish(onAllow);
    no.onclick = () => finish(onCancel);
    bar.appendChild(msg); bar.appendChild(ok); bar.appendChild(no);
    host.appendChild(bar);
    bdDoneDragPending = onCancel; // 未应答时的默认结算=取消(回滚),防位移悬挂
    return true;
  } catch (e) { return false; /* 确认条建不出来:退化为不拦截(调用方照旧落盘) */ }
}
function bdDoneDragGuard(target, el, dragNode, pos, host, doc) {
  try {
    if (!target || target.status !== "done") return false;
    const key = "zh:bd-done-drag:" + (boardTaskId || target.taskId || "anon");
    let granted = false;
    try { granted = !!sessionStorage.getItem(key); } catch (e) { granted = false; /* 存储读不可用:按未授权处理(仍询问) */ }
    if (granted) return false; // 本会话已授权:同旧行为直通
 // 闪回滚(闭包捕获本次拖拽的板/宿主;确认条常驻期间用户可能切板——回调不得改「当前」板)
    const rollback = () => bdDoneDragRollback(target, el, dragNode, pos, host, doc);
    const allow = () => {
      try { sessionStorage.setItem(key, "1"); } catch (e) { /* 存储不可用=每次询问,不阻断 */ }
 // 拖拽期间用户切板/退视图=目标板已不在前台:回滚而非把位移落进别的板
      if (!bdDoneDragSameBoard(target, host)) { rollback(); toast("目标白板已切换:本次拖拽未落盘,已回滚"); return; }
      bdSaveLayoutDebounced(); // 允许编辑:把本次拖拽补落盘
      toast("已允许编辑该完成态白板(本会话不再询问)");
    };
    if (!bdDoneDragPrompt(allow, rollback)) return false; // 条建不出来:放行(旧行为)
    return true;
  } catch (e) { return false; }
}
/** 取消/悬挂结算:位置回滚为拖拽前值(容器 + contains 随动子节点),DOM 样式/pos 表/doc 三处同回。 */
function bdDoneDragRollback(target, el, dragNode, pos, host, doc) {
  try {
    const put = (elm, id, x, y) => {
      if (!isFinite(x) || !isFinite(y)) return; // 基位缺失不写脏值(防 undefined 污染 pos/doc)
      if (elm) { elm.style.left = x + "px"; elm.style.top = y + "px"; }
      pos.set(id, { x, y });
      const n = target && target.nodes && target.nodes.find((v) => v.id === id);
      if (n) n.pos = { x, y };
    };
    put(el, dragNode.id, dragNode.ox, dragNode.oy);
    if (dragNode.kids) for (const k of dragNode.kids) put(k.el, k.id, k.ox, k.oy);
    try { cvRedrawEdges(host, doc, pos); } catch (e) { /* 边重绘失败不回滚成功判定 */ }
    toast("已取消:节点位置回滚");
  } catch (e) { /* 回滚尽力而为,不炸画布 */ }
}
/** 目标板是否仍是前台当前板(拖拽/确认期间切板即失配)。 */
function bdDoneDragSameBoard(target, host) {
  try {
    return cvTargetDoc() === target && (!cvActiveHost || cvActiveHost === host || host.contains(cvActiveHost) || cvActiveHost.contains(host));
  } catch (e) { return true; }
}
// 代码档案跳转:切到代码档案视图并打开该文件(ppf 函数级视图同款消息)
function bdOpenProfile(file) {
  if (!file) return;
  const pid = ppId || activeProjectId;
  switchView("project");
  projectSetTab("files", true); // tab 化:文件钻取 pane 默认隐藏,跳转前必须切 tab(否则 #ppfFns 不可见)
  ppfCur = file;
  wsSafeSend(JSON.stringify({ v: 1, type: "profile.file", projectId: pid, file }));
  arcQuery(); // 白板画布跳档案的入口也要沉淀索引(反查角标数据源;openProfile 之外的第二入口)
  toast("已打开代码档案:" + String(file).split("/").slice(-1)[0]);
}
$("boardGraphMode").onclick = () => {
  boardCanvasMode = !boardCanvasMode;
  $("boardGraphMode").textContent = boardCanvasMode ? "简图" : "画布";
  renderBoard();
};
// fixH2:布局开关(流动 LR / 紧凑原布局)——记住 localStorage,默认流动;切换强制整板重渲
function bdLayoutModeSync() {
  const b = $("boardLayoutMode");
  if (b) b.textContent = cvFlowOn() ? "流动 LR" : "紧凑布局";
}
bdLayoutModeSync();
const bdLayoutBtn = $("boardLayoutMode");
if (bdLayoutBtn) bdLayoutBtn.onclick = () => {
  const next = cvFlowOn() ? "compact" : "flow";
  try { localStorage.setItem("zh:bd-layout", next); } catch (e) { /* 隐私模式:仅本次生效 */ }
  bdLayoutModeSync();
  const g = bdGraphHost();
  if (g) g.__cvSig = ""; // 增量锚清空:布局切换必须全量重渲(签名里也带模式,双保险)
  renderBoard();
  toast(next === "flow" ? "流动布局:入口→主线→出口横贯(拖动节点可微调,「整理」恢复自动流动)" : "紧凑布局:按保存位置/旧分层显示");
};
// 从代码生成模块图(七期):code-sense 整理文件符号→模块板(自动分类+真实调用边)
$("boardFromCode").onclick = () => {
  if (!currentSid) { toast("先进入一个会话", true); return; }
  const selNode = boardDoc && boardSelNode ? boardDoc.nodes.find((n) => n.id === boardSelNode) : null;
  const pre = (selNode && selNode.symbolRef && selNode.symbolRef.file) || "";
  uiPrompt("整理哪个代码文件为模块图?(相对路径或文件名;code-sense 会把函数按工作流类型分类并连真实调用边)", pre).then((file) => {
    if (!file || !file.trim()) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "board.fromcode", sessionId: currentSid, file: file.trim(), ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
    toast("生成中…(大文件稍候)");
  });
};
// 从洞察生成语义板:四源——模块依赖(全仓聚合)/架构图(LLM)/符号时序/页面流
$("boardFromSense").onclick = () => {
  if (!currentSid) { toast("先进入一个会话", true); return; }
  const NL0 = String.fromCharCode(10);
  uiPrompt("从哪份 code-sense 产物生成可编辑语义板?\\n1=模块依赖图(全仓模块+跨模块真实调用聚合)\\n2=架构图(LLM;未配置会显式失败)\\n3=符号静态时序(下一步输入符号名)\\n4=页面流(路由/页面跳转)", "1").then((pick) => {
    if (!pick) return;
    const srcMap = { "1": "modulemap", "2": "archmap", "3": "sequence", "4": "pageflow" };
    const source = srcMap[pick.trim()];
    if (!source) { toast("无效选择", true); return; }
    const proceed = (query) => {
      wsSafeSend(JSON.stringify({ v: 1, type: "board.fromsense", sessionId: currentSid, source, ...(query ? { query } : {}), ...(activeProjectId ? { projectId: activeProjectId } : {}) }));
      toast("生成语义板中…(时序/页面流需分析,稍候)");
    };
    if (source === "sequence") {
      const selNode = boardDoc && boardSelNode ? boardDoc.nodes.find((n) => n.id === boardSelNode) : null;
      uiPrompt("哪个符号的静态时序?(函数/方法名)", selNode ? selNode.label : "").then((q) => {
        const query = (q || "").trim();
        if (!query) return;
        proceed(query);
      });
    } else proceed("");
  });
};

// ---- P3 人参与编辑( §8):查看/编辑双态;人改板=改设计不改码 ----
let boardEditOn = false;
let boardDraft = null;      // 编辑草稿(深拷贝;结构操作即时重渲图,文本输入只写草稿防焦点丢失)
let boardOverlayB64 = null; // 服务端批注层(board.doc 下发;优先于 localStorage 草稿)
let sessionOverlayB64 = null; // 会话级批注(__session__;无语义板时笔迹跟会话走,刷新/换浏览器可恢复)
/** 拉会话级批注:开着语义板由 board.doc 通道带 overlayB64;否则拉 __session__。
 * n6:sid 缺省=当前选中会话(入参化,避免切会话重载时把旧会话的批注拉回来)。 */
function overlayPull(sid) {
  const os = sid === undefined ? currentSid : sid;
  if (!os || !ws || ws.readyState !== 1) return;
  if (boardTaskId) return;
  wsSafeSend(JSON.stringify({ v: 1, type: "board.get", sessionId: os, taskId: "__session__" }));
}
let boardSaveInflight = false; // board.save 已发等回执(回执才退编辑态)
let boardConflict = null; // rev 冲突保留草稿({taskId,currentRev};冲突条出示处置)
let boardListRetry = 0; // drvfs 假阴性窗 list 空的自动重拉计数(九期)
const BD_NL = String.fromCharCode(10);

function bdDeepCopy(doc) { return JSON.parse(JSON.stringify(doc)); }

// 语义流程 DSL(人编面):步骤: x / 如果 cond: / 否则: / 循环 x: ——嵌套=两空格缩进。
// 注意 panel 模板层吃单反斜杠:本文件内 JS 正则的反斜杠必须双写(\\s),字符串用单引号。
function bdFlowToText(steps, indent) {
  const pad = "  ".repeat(indent || 0);
  let out = [];
  for (const s of steps || []) {
    if (s.type === "branch") {
      out.push(pad + "如果 " + (s.cond || "?") + ":");
      out = out.concat(bdFlowToText(s.then || [], (indent || 0) + 1));
      if (s.else && s.else.length) { out.push(pad + "否则:"); out = out.concat(bdFlowToText(s.else, (indent || 0) + 1)); }
    } else if (s.type === "loop") {
      out.push(pad + "循环 " + (s.over || "每一项") + ":");
      out = out.concat(bdFlowToText(s.body || [], (indent || 0) + 1));
    } else {
      out.push(pad + "步骤: " + (s.text || ""));
    }
  }
  return out.join(BD_NL);
}
function bdFlowFromText(text) {
  const lines = String(text || "").split(BD_NL);
  const root = [];
  const stack = [{ indent: -1, arr: root }];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    let m = line.match(/^步骤[:：]\\s*(.+)$/);
    if (m) { top.arr.push({ type: "step", text: m[1] }); continue; }
    m = line.match(/^如果\\s+(.+?)[:：]$/);
    if (m) { const b = { type: "branch", cond: m[1], then: [], else: [] }; top.arr.push(b); stack.push({ indent, arr: b.then }); continue; }
    m = line.match(/^否则\\s*[:：]?$/);
    if (m) {
      const cur = top.arr[top.arr.length - 1];
      if (cur && cur.type === "branch") { stack.push({ indent, arr: cur.else }); continue; }
      return { error: "「否则」必须紧跟同级「如果」块之后" };
    }
    m = line.match(/^循环\\s+(.+?)[:：]$/);
    if (m) { const lp = { type: "loop", over: m[1], body: [] }; top.arr.push(lp); stack.push({ indent, arr: lp.body }); continue; }
    return { error: "无法识别的行:「" + line.slice(0, 40) + "」(合法形态:步骤:/如果 X:/否则:/循环 X:)" };
  }
  return { flow: root };
}

function boardEditToggle() {
  if (!boardDoc) { toast("当前会话没有白板可编辑", true); return; }
  boardEditOn = !boardEditOn;
  boardDraft = boardEditOn ? bdDeepCopy(boardDoc) : null;
  cvUndoStack.length = 0; cvRedoStack.length = 0; // 快照与模式绑定(编辑/查看),切换即清防跨模式错配
  renderBoard();
}
function bdDraftNode(id) { return boardDraft ? boardDraft.nodes.find((n) => n.id === id) : null; }
function bdStructChanged() { renderBoard(); } // 结构操作(增删节点/边)才重渲图;文本输入不重渲
function bdAddNode() {
  if (!boardDraft) return;
  if (boardSelNode && !bdSyncDraftFromForm()) return; // 结构操作前先收编在填表单(无效即中止,防静默丢输入)
  let seq = boardDraft.nodes.length + 1;
  while (bdDraftNode("n" + seq)) seq++;
  const n = { id: "n" + seq, kind: "module", label: "新模块", summary: "(写清这个模块干什么用)", change: "add", flow: [] };
  boardDraft.nodes.push(n);
  boardSelNode = n.id;
  bdStructChanged();
}
function bdDelNode(id) {
  if (!boardDraft) return;
  if (boardSelNode && boardSelNode !== id && !bdSyncDraftFromForm()) return;
  boardDraft.nodes = boardDraft.nodes.filter((n) => n.id !== id);
  boardDraft.edges = boardDraft.edges.filter((e) => e.from !== id && e.to !== id);
  if (boardSelNode === id) boardSelNode = null;
  bdStructChanged();
}
function bdAddEdge() {
  if (!boardDraft || boardDraft.nodes.length < 2) return;
  if (boardSelNode && !bdSyncDraftFromForm()) return;
  const from = $("bdeEdgeFrom").value, to = $("bdeEdgeTo").value;
  if (!from || !to || from === to) { toast("连线需要两个不同节点", true); return; }
  boardDraft.edges.push({ from, to, kind: $("bdeEdgeKind").value || "call", label: $("bdeEdgeLabel").value.trim(), virtual: true }); // 编辑态人工连线=虚拟边
  bdStructChanged();
}
function bdDelEdge(i) {
  if (!boardDraft) return;
  if (boardSelNode && !bdSyncDraftFromForm()) return;
  boardDraft.edges.splice(i, 1);
  bdStructChanged();
}
function bdSyncDraftFromForm() {
 // 文本/选择输入写回草稿(节点表单在场才同步;返回 false=表单值不合法,保存应中止)
  if (!boardDraft) return true;
  const n = boardSelNode ? bdDraftNode(boardSelNode) : null;
  if (n && $("bdeLabel")) {
    n.label = $("bdeLabel").value.trim() || n.label;
    n.kind = $("bdeKind").value;
    n.change = $("bdeChange").value;
    n.summary = $("bdeSummary").value.trim();
    n.before = $("bdeBefore").value.trim() || undefined;
    const sn = $("bdeSymName").value.trim();
    const sf = $("bdeSymFile").value.trim();
 // B8:名字/文件被改过 → 旧 line/anchor 指向旧符号的位置,必须丢弃(锚错位比没有更糟,三态重解析会按名找新位置)
    const prev = n.symbolRef;
    const sameSym = prev && prev.name === sn && (prev.file || "") === sf;
    n.symbolRef = sn ? { name: sn, ...(sf ? { file: sf } : {}), ...(sameSym && prev.line ? { line: prev.line } : {}), ...(sameSym && prev.anchor ? { anchor: prev.anchor } : {}) } : undefined;
    const parsed = bdFlowFromText($("bdeFlow").value);
    if (parsed.error) { toast(parsed.error, true); return false; }
    n.flow = parsed.flow;
 // 工作流板参数表单(配置抽屉在填即收编;timeout 非法静默丢=回退缺省;字段不在场=该 kind 无此参数)
    if (String(n.kind).indexOf("wf-") === 0) {
      n.wf = { ...(n.wf || {}) };
      if ($("bdeWfCommand")) n.wf.command = $("bdeWfCommand").value.trim() || undefined;
      if ($("bdeWfInstr")) n.wf.instructions = $("bdeWfInstr").value.trim() || undefined;
      if ($("bdeWfActor")) n.wf.actor = $("bdeWfActor").value.trim() || "worker";
      if ($("bdeWfCond")) n.wf.cond = $("bdeWfCond").value.trim() || undefined;
      if ($("bdeWfMsg")) n.wf.message = $("bdeWfMsg").value.trim() || undefined;
      if ($("bdeWfTimeout")) {
        const tv = Number($("bdeWfTimeout").value);
        n.wf.timeoutMs = Number.isFinite(tv) && tv >= 1000 ? Math.floor(tv) : undefined;
      }
      if (n.wf.command === undefined) delete n.wf.command;
      if (n.wf.instructions === undefined) delete n.wf.instructions;
      if (n.wf.cond === undefined) delete n.wf.cond;
      if (n.wf.message === undefined) delete n.wf.message;
      if (n.wf.timeoutMs === undefined) delete n.wf.timeoutMs;
      if (!Object.keys(n.wf).length) delete n.wf;
    }
  }
  if ($("bdeTitle")) boardDraft.title = $("bdeTitle").value.trim() || boardDraft.title;
  return true;
}
function boardSave() {
  if (!boardDraft || !boardDoc) return;
  if (!bdSyncDraftFromForm()) return;
  const badNode = boardDraft.nodes.find((n) => !String(n.summary || "").trim());
  if (badNode) { toast("节点「" + badNode.label + "」的「干什么用」为空——白板纪律:每个模块必须写清用途", true); return; }
  boardSaveInflight = true; // C4:只在真正发出后置旗(校验不通过不置,防旗标卡死)
  wsSafeSend(JSON.stringify({ v: 1, type: "board.save", sessionId: currentSid, taskId: boardTaskId, doc: boardDraft, baseRev: boardDoc.rev }));
}
function boardContinue() {
  if (!boardDoc) { toast("当前没有白板", true); return; }
  uiPrompt("按这版白板续作:补充你的调整要求(可空,直接确定=按板继续)", "", { allowEmpty: true }).then((note) => {
    if (note === null) return;
    wsSafeSend(JSON.stringify({ v: 1, type: "board.continue", sessionId: currentSid, taskId: boardTaskId, note }));
    toast("已按白板发起续作任务");
  });
}
function bdFlowToMd(steps, indent) {
  const pad = "  ".repeat(indent || 0);
  let out = [];
  for (const s of steps || []) {
    if (s.type === "branch") {
      out.push(pad + "- 如果 " + (s.cond || "?") + ":");
      out = out.concat(bdFlowToMd(s.then || [], (indent || 0) + 1));
      if (s.else && s.else.length) { out.push(pad + "- 否则:"); out = out.concat(bdFlowToMd(s.else, (indent || 0) + 1)); }
    } else if (s.type === "loop") {
      out.push(pad + "- 循环 " + (s.over || "每一项") + ":");
      out = out.concat(bdFlowToMd(s.body || [], (indent || 0) + 1));
    } else out.push(pad + "- " + (s.text || ""));
  }
  return out;
}
function boardExportMd() {
  if (!boardDoc) { toast("没有可导出的图"); return; } // :与导出 PNG 的空板反馈对齐(此前完全静默)
  const d = boardDoc;
  const L = ["# 设计白板:" + d.title, "", "状态: " + d.status + " · rev " + d.rev + " · 节点 " + d.nodes.length + " · 边 " + d.edges.length, ""];
  for (const n of d.nodes) {
    const lk = bdLinkOf(n.id);
    L.push("## " + n.label + " [" + BD_CHANGE[n.change] + "]" + (lk ? "(" + (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") + ")" : ""));
    L.push(n.summary);
    if (n.before) L.push("原来: " + n.before);
    if (n.symbolRef) L.push("代码连接: " + n.symbolRef.name + (n.symbolRef.file ? " — " + n.symbolRef.file + (lk && lk.line ? ":" + lk.line : "") : ""));
    if (n.flow && n.flow.length) { L.push("语义流程:"); L.push(...bdFlowToMd(n.flow, 0)); }
 // fixE3:节点评论进 MD 导出(节点行+其下评论列表,口径对齐服务端「按板续作」的「用户评论:」)——
 // 此前导出丢评论,板上讨论无法随文档复原;评论全文照录(≤500 字/条,协议上限)。
    if (n.comments && n.comments.length) { L.push("评论 " + n.comments.length + " 条:"); for (const c of n.comments) L.push("- " + String(c)); }
    L.push("");
  }
  if (d.edges.length) { L.push("## 关系"); for (const e of d.edges) L.push("- " + e.from + " -> " + e.to + (e.label ? "(" + e.label + ")" : "") + (e.virtual ? " [虚拟边:人工标注,待核实]" : "")); }
  if (d.actual_files) { L.push("", "## 对账", "计划: " + (d.planned_files || []).join(", "), "实际: " + d.actual_files.join(", ")); }
  const blob = new Blob([L.join(BD_NL)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "board-" + d.taskId.slice(0, 8) + ".md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/** svg 模式导出 PNG 的尺寸计划(纯函数,可单测)。
 * 尺寸优先级:viewBox 宽高(cvSvgBox 口径)> <svg width/height> 属性;都拿不到 → null(调用方回退卡片路线)。
 * 倍数:2x 常规,但**像素总量超 400 万即降 1x**——大板经验证 viewBox 7261×2942,2x = 14522×5884
 * ≈341MB RGBA,浏览器直接 OOM;这是按面积夹上限,不是写死倍数。 */
/** 取 svg 根元素上的数值属性(width/height)。**不用正则**:panel 模板串会吃掉单反斜杠(\\s/\\d 变 s/d)。 */
function svgAttrNum(s, name) {
  const txt = String(s || "");
  const i = txt.indexOf(name + "=");
  if (i < 0) return 0;
  let j = i + name.length + 1;
  const q = txt.charAt(j);
  if (q === '"' || q === "'") j++;
  let e = j;
  for (;;) {
    const ch = txt.charAt(e);
    if ((ch >= "0" && ch <= "9") || ch === ".") e++;
    else break;
  }
  const v = parseFloat(txt.slice(j, e));
  return isFinite(v) && v > 0 ? v : 0;
}
function cvSvgPngPlan(svgText) {
  const txt = String(svgText || "");
  const b = cvSvgBox(txt);
  let w = b ? b.w : 0, h = b ? b.h : 0;
  if (!(w > 0) || !(h > 0)) {
    w = svgAttrNum(txt, "width");
    h = svgAttrNum(txt, "height");
  }
  if (!(w > 0) || !(h > 0) || !isFinite(w) || !isFinite(h)) return null;
  const scale = w * h * 4 > 4000000 ? 1 : 2;
  return { w: w, h: h, scale: scale, outW: Math.round(w * scale), outH: Math.round(h * scale) };
}
/** svg 模式(flowkit 单张图)导出 PNG(修断裂)。
 * 旧链路 cvExportWorldPng 读的是 .bf-cv-edges 宽高 + .cv-node 卡片,svg 模式两者都不存在 → W/H=0 →
 * 「没有可导出的图」,导出按钮 100% 失效。这里直接序列化 #cvSvgHost > svg(内联样式由 flowkit 自带)
 * → Image → canvas → PNG。返回 true=已接管(异步出图);false=没拿到 svg/尺寸,调用方按旧路线回退。 */
function cvExportSvgPng(host) {
  let svgEl = null;
  try { svgEl = host && host.querySelector ? (host.querySelector("#cvSvgHost > svg") || host.querySelector("#cvSvgHost svg")) : null; } catch (e) { svgEl = null; }
  if (!svgEl) return false;
  let xml = "";
  try {
    const clone = svgEl.cloneNode(true);
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    xml = new XMLSerializer().serializeToString(clone);
  } catch (e) { return false; }
  const plan = cvSvgPngPlan(xml);
  if (!plan) return false;
  let bg = "rgba(0, 0, 0, 0)";
  try { bg = window.getComputedStyle(document.body).backgroundColor || bg; } catch (e) { /* 主题兜底 */ }
  if (!bg || bg === "rgba(0, 0, 0, 0)") bg = "#0b0806";
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = plan.outW; c.height = plan.outH;
      const ctx = c.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = "board-" + (boardTaskId || "doc").slice(0, 8) + ".png";
      a.click();
      toast("PNG 已导出:flowkit SVG " + plan.w + "×" + plan.h + "(" + plan.scale + "x)");
    } catch (e) { toast("导出失败:画布渲染异常", true); }
  };
  img.onerror = () => toast("导出失败:图渲染异常(flowkit SVG 无法转成图片)", true);
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  return true;
}
/** fixE1:画布模式整卡导出——克隆 .bf-cv-world(DIV 节点卡+边 SVG)进 <svg><foreignObject>,
 * 逐元素内联 computed style(主题 CSS 变量随 computed 值一并展开,导出图与当前主题一致)→
 * XMLSerializer → blob → Image → canvas → PNG。≤100 节点一次性成本可接受(41 节点板经验证亚秒级)。
 * 已知取舍:伪元素装饰不入图(仅 .k-page 卡头三点点装饰一处,纯装饰);画布点阵网格背景取平色
 * (radial 网格是交互参照,非语义内容)。快照失败退回旧连线层导出并如实 toast(诚实降级)。 */
function cvExportWorldPng(host, world) {
  const svgEdges = world.querySelector(".bf-cv-edges");
  let W = 0, H = 0;
  try {
    W = Math.round(parseFloat(svgEdges.getAttribute("width")) || 0); // 边图尺寸=世界外沿(渲染时按节点包围盒+余量构造)
    H = Math.round(parseFloat(svgEdges.getAttribute("height")) || 0);
  } catch (e) { /* 走 DOM 实测兜底 */ }
  if (!W || !H) {
    for (const el of world.querySelectorAll(".cv-node")) {
      const x = parseFloat(el.style.left) || 0, y = parseFloat(el.style.top) || 0;
      W = Math.max(W, x + (el.offsetWidth || 200) + 40);
      H = Math.max(H, y + (el.offsetHeight || 100) + 40);
    }
  }
  if (!W || !H) { toast("没有可导出的图", true); return; }
  const clone = world.cloneNode(true);
  clone.classList.remove("z-low"); // z-low 是交互态噪声治理;导出恒带边标签
  const src = [world].concat(Array.prototype.slice.call(world.querySelectorAll("*")));
  const dst = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
  for (let i = 0; i < src.length; i++) {
    try {
      const cs = window.getComputedStyle(src[i]);
      const st = dst[i].style;
      for (let j = 0; j < cs.length; j++) st.setProperty(cs[j], cs.getPropertyValue(cs[j]), cs.getPropertyPriority(cs[j]));
    } catch (e) { /* 单元素内联失败不拖垮整图 */ }
  }
 // 根:去平移/缩放(导出恒 100% 全景),锚回定尺寸宿主;z-low 期被内联的标签 display:none 强制恢复
  clone.style.position = "relative";
  clone.style.left = "auto"; clone.style.top = "auto";
  clone.style.width = W + "px"; clone.style.height = H + "px";
  clone.style.transform = "none"; clone.style.overflow = "visible";
  for (const t of clone.querySelectorAll(".bf-cv-edge-label")) t.style.display = "inline";
  let bg = "rgba(0, 0, 0, 0)";
  try { bg = window.getComputedStyle(document.body).backgroundColor || bg; } catch (e) { /* 主题兜底 #0b0806 */ }
  if (!bg || bg === "rgba(0, 0, 0, 0)") bg = "#0b0806";
  const NS = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(NS, "svg");
  root.setAttribute("xmlns", NS);
  root.setAttribute("width", String(W));
  root.setAttribute("height", String(H));
  const fo = document.createElementNS(NS, "foreignObject");
  fo.setAttribute("x", "0"); fo.setAttribute("y", "0");
  fo.setAttribute("width", String(W)); fo.setAttribute("height", String(H));
  const wrap = document.createElement("div"); // XHTML 宿主(XMLSerializer 自动补 xmlns)
  wrap.style.margin = "0"; wrap.style.padding = "0";
  wrap.style.width = W + "px"; wrap.style.height = H + "px";
  wrap.style.position = "relative"; wrap.style.overflow = "hidden";
  wrap.style.background = bg;
  wrap.appendChild(clone);
  fo.appendChild(wrap);
  root.appendChild(fo);
  const xml = new XMLSerializer().serializeToString(root);
 // fixE1 验证坑:blob: URL 的 foreignObject SVG 进 <img> 后画布必染(空 DIV 也染,Chrome 149 经验证;
 // data: URL 同一份 XML 干净可导出)——恒走 data URL(encodeURIComponent),不用 blob。
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  const nodeCount = world.querySelectorAll(".cv-node").length;
  const fallbackEdges = () => { // 旧路线(连线层)兜底:整卡快照渲染失败时至少给边图+如实告知
    const xmlE = new XMLSerializer().serializeToString(svgEdges);
    const imgE = new Image();
    imgE.onload = () => {
      const c = document.createElement("canvas");
      c.width = W * 2; c.height = H * 2;
      const ctx = c.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(imgE, 0, 0, c.width, c.height);
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = "board-" + (boardTaskId || "doc").slice(0, 8) + ".png";
      a.click();
    };
    imgE.onerror = () => toast("导出失败:图渲染异常", true);
    imgE.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xmlE);
  };
  const img = new Image();
  img.onload = () => {
    try {
      const scale = W * H > 4200000 ? 1 : 2; // 大世界降 1x(2x 画布 >16.8M 像素过重)
      const c = document.createElement("canvas");
      c.width = W * scale; c.height = H * scale;
      const ctx = c.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = "board-" + (boardTaskId || "doc").slice(0, 8) + ".png";
      a.click();
      toast("PNG 已导出:节点卡 " + nodeCount + " 张 + 连线层(" + Math.round(scale * 100) + "%)");
    } catch (e) { fallbackEdges(); toast("整卡快照失败,已退回连线层导出(节点卡缺失)", true); }
  };
  img.onerror = () => { toast("整卡快照失败,已退回连线层导出(节点卡缺失)", true); fallbackEdges(); };
  img.src = url;
}
function boardExportPng() {
 // fixE1:画布模式导出必须含节点卡——旧实现只序列化 #boardGraph 里的 svg(=连线层;节点是 DIV
 // 天生不在 svg 内),导出 PNG 只有贝塞尔边+边标签。画布模式走 cvExportWorldPng 整卡路线;
 // 简图(mermaid)模式沿旧 svg 路线(那层本就是 SVG,无 DIV 卡问题);宿主取 bdGraphHost(浮窗画布同权)。
 // 修断裂:默认渲染已是 flowkit 单张 SVG(没有 .bf-cv-world 卡片世界),先试 svg 直出;
 // 拿不到才回退旧两条路线(cards 回滚态/简图态)。
  const host = bdGraphHost();
  if (boardCanvasMode && cvExportSvgPng(host)) return;
  const world = host && host.querySelector(".bf-cv-world");
  if (world && boardCanvasMode) { cvExportWorldPng(host, world); return; }
  const svg = host && host.querySelector("svg");
  if (!svg) { toast("没有可导出的图", true); return; }
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    const scale = 2;
    c.width = (svg.viewBox.baseVal && svg.viewBox.baseVal.width ? svg.viewBox.baseVal.width : svg.clientWidth) * scale;
    c.height = (svg.viewBox.baseVal && svg.viewBox.baseVal.height ? svg.viewBox.baseVal.height : svg.clientHeight) * scale;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0b0806";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const a = document.createElement("a");
    a.href = c.toDataURL("image/png");
    a.download = "board-" + (boardTaskId || "doc").slice(0, 8) + ".png";
    a.click();
  };
  img.onerror = () => toast("导出失败:图渲染异常", true);
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
}
$("boardEditBtn").onclick = () => boardEditToggle();
// ---- 工作流板:新建 / 编译预览 / 编译执行 / 存为自动化 ----
let wfCompilePreview = ""; // 最近一次编译产物(存自动化用;编译失败清空)
/** 运行态增量上屏:对活动画布宿主的节点元素原位切类+角标(不整板重渲,进度不打断拖拽/在途交互)。 */
function bdWfApplyStates(states) {
  const host = cvHostEl();
  if (!host || !states) return;
  const all = host.querySelectorAll(".cv-node");
  for (const el of all) {
    const st = states[el.dataset.cv];
    el.classList.toggle("wf-running", !!st && st.state === "running");
    el.classList.toggle("wf-done", !!st && st.state === "done");
    el.classList.toggle("wf-failed", !!st && st.state === "failed");
 // 角标:头行内已有则更新,没有则插(与全量渲染同款 DOM)
    let badge = el.querySelector(".cv-wf-badge");
    if (st) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "cv-wf-badge";
        const head = el.querySelector(".cv-head");
        const tag = head ? head.querySelector(".bd-tag") : null;
        if (head && tag) head.insertBefore(badge, tag); else if (head) head.appendChild(badge);
      }
      badge.className = "cv-wf-badge " + st.state;
      badge.textContent = st.state === "running" ? "运行中" : st.state === "done" ? "完成" + (st.ms !== undefined ? " " + st.ms + "ms" : "") : "失败";
      badge.title = String(st.detail || "") + (st.ms !== undefined ? " " + st.ms + "ms" : "");
    } else if (badge) badge.remove();
  }
  const meta = host.querySelector(".bd-meta"); // 板头 meta 行带运行态标签(cvMetaHtml 读 wfRuns)
  if (meta && boardDoc) meta.innerHTML = cvMetaHtml(boardDoc, cvRo);
}
/** 新建工作流板:客户端拼初始板(一个 wf-script 起步节点)→board.save→boardGet。 */
function bdWfNewBoard() {
  if (!currentSid) { toast("先选择会话", true); return; }
  const taskId = "wf-" + Date.now().toString(36);
  const doc = {
    version: 1, taskId, sessionId: currentSid, title: "工作流板 " + new Date().toLocaleTimeString(), status: "draft", docKind: "workflow",
    rev: 0, nodes: [{
      id: "n1", kind: "wf-script", label: "起步命令", summary: "确定性命令(world.run 白名单:测试运行器/node/git 只读/ls/cat/grep/tail)",
      change: "add", done: false, comments: [], flow: [], wf: { command: "ls packages" },
    }], edges: [], planned_files: [], updatedAt: Date.now(),
  };
  wsSafeSend(JSON.stringify({ v: 1, type: "board.save", sessionId: currentSid, taskId, doc, baseRev: 0 }));
  boardTaskId = taskId; // 保存回执 board.doc 会带 taskId;先钉住防清单把选择滑走
  toast("工作流板已建:工具箱「工作流执行」分组加节点,双击节点配参数");
}
function bdWfCompile() {
  if (!boardDoc || boardDoc.docKind !== "workflow") { toast("当前不是工作流板", true); return; }
  if (boardEditOn) { toast("编辑态请先「保存白板」再编译(草稿未落盘)", true); return; }
  wsSafeSend(JSON.stringify({ v: 1, type: "board.workflow.compile", sessionId: currentSid, taskId: boardTaskId }));
}
function bdWfRun() {
  if (!boardDoc || boardDoc.docKind !== "workflow") { toast("当前不是工作流板", true); return; }
  if (boardEditOn) { toast("编辑态请先「保存白板」再执行(草稿未落盘)", true); return; }
  const r = wfRuns[boardTaskId];
  if (r && !r.done) { toast("该板已有运行在途,等它结束", true); return; }
 // 本地先清旧运行态(新一轮点亮从零开始)
  wfRuns[boardTaskId] = { wfId: "", states: {}, done: false };
  bdWfApplyStates({});
  toast("已发起编译执行:节点状态将实时点亮");
  wsSafeSend(JSON.stringify({ v: 1, type: "board.workflow.run", sessionId: currentSid, taskId: boardTaskId }));
}
/** 编译产物存为定时自动化(最小接:instruction 内嵌脚本,主 agent run_workflow 工具执行同一脚本)。 */
function bdWfSaveAutomation() {
  if (!boardDoc || boardDoc.docKind !== "workflow") { toast("当前不是工作流板", true); return; }
  const doCreate = (script) => {
    uiPrompt("存为自动化:间隔几分钟跑一次?", "60", {}).then((v) => {
      if (v === null) return;
      const every = Number(v);
      if (!Number.isFinite(every) || every < 1) { toast("间隔须 ≥1 分钟", true); return; }
      wsSafeSend(JSON.stringify({
        v: 1, type: "automation.create", name: "工作流板:" + boardDoc.title.slice(0, 30),
        instruction: "用 run_workflow 工具执行以下 workflow 脚本(script 参数原样传入,不要改写):\\n" + script,
        everyMinutes: Math.floor(every),
      }));
      toast("已存为自动化(自动化视图可管理)");
    });
  };
  if (wfCompilePreview) { doCreate(wfCompilePreview); return; }
 // 没有编译缓存:先拉一发编译(回包后再点一次即带上脚本)
  toast("先编译(下一次点「存为自动化」带上脚本)");
  bdWfCompile();
}
$("boardWfNew").onclick = () => bdWfNewBoard();
$("boardWfCompile").onclick = () => bdWfCompile();
$("boardWfRun").onclick = () => bdWfRun();
$("boardWfAuto").onclick = () => bdWfSaveAutomation();
$("boardSaveBtn").onclick = () => boardSave();
$("boardCancelBtn").onclick = () => { boardEditOn = false; boardDraft = null; renderBoard(); };
$("boardContinueBtn").onclick = () => boardContinue();
// 勾选派发:工具条按钮 → bdDispatchSel;首屏也刷一次计数(空集=按钮 disabled)
if ($("bdDispatchSel")) $("bdDispatchSel").onclick = () => bdDispatchSel();
bdSelRender();
$("boardExpMd").onclick = () => boardExportMd();
$("boardExpPng").onclick = () => boardExportPng();
// 使用标记(引导清单)
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") localStorage.setItem("zh:used-term", "1"); });

`;
