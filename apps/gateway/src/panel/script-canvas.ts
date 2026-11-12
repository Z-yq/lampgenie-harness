/**
 * 面板主脚本分片:script-canvas(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_CANVAS = `// ---- 六期:工作流画布(零依赖)——主白板视图「画布」模式 ----
// 形态对齐主流工作流画布:节点卡(类型角标+标题+摘要+连接态点+文件)/左右端口/贝塞尔连线/
// 点阵画布/平移缩放/节点拖拽(存 pos)。边数据来自 agent 按 code_index 真实调用关系提交。
let boardCanvasMode = true; // 默认画布;false=mermaid 简图
// 七期:工作流全类型集(icon=短字签;零依赖纪律下用字签+类型色板)
const CV_KIND_ICON = { llm: "AI", tool: "工", io: "IO", decision: "判", function: "函", module: "块", note: "注", start: "起", end: "终", http: "HTTP", template: "版", aggregate: "聚", loop: "环", retrieval: "检", classifier: "类", agent: "代理", page: "页", section: "区", component: "件", nav: "航", "wf-script": "sh", "wf-test": "测", "wf-agent": "代", "wf-condition": "if", "wf-parallel": "∥", "wf-notify": "报" };
const CV_KIND_NAME = { llm: "模型调用", tool: "工具", io: "输入/输出", decision: "判断分支", function: "函数", module: "模块", note: "备注", start: "开始", end: "结束/输出", http: "HTTP 请求", template: "模板转换", aggregate: "变量聚合", loop: "循环/迭代", retrieval: "知识检索", classifier: "问题分类", agent: "Agent", page: "页面", section: "区块", component: "组件", nav: "导航条", "wf-script": "脚本命令", "wf-test": "测试门", "wf-agent": "子代理", "wf-condition": "条件分支", "wf-parallel": "并发扇出", "wf-notify": "通知/成果" };
let cvPan = { x: 30, y: 20, k: 1 };
// 画布宿主泛化(大白板/浮窗/档案只读三宿主,谁最后渲染谁在位):
// cvActiveHost/cvActiveDoc=最近一次 renderBoardCanvas 的 cvHost 与板(委托层与视图函数经它定位,
// 不再全局 getElementById 摸 id——档案只读画布在场时同 id 元素有俩,裸查会摸错);
// cvRo=只读旗(档案沉淀画布):编辑监听不绑、直改板落盘全禁。非只读渲染即自动复位。
let cvActiveHost = null;
let cvActiveDoc = null;
let cvRo = false;
// 页面结构板语义布局信息(最近一次 renderBoardCanvas 的 page 板):null=非 page 板(旧路径)。
// 资产 board-page-layout.js 加载失败时恒为 null → 全部渲染/边/拖拽走旧行为,零回退风险。
let cvPageInfo = null;
// fixH2 设计板「一眼看懂」流程图布局信息(最近一次 renderBoardCanvas 的 非 page 有边板):null=旧路径。
// 资产 board-flow-layout.js 加载失败/紧凑模式 → null → 回退 cvLayout 旧行为,零回退风险。
let cvFlowInfo = null;
// UI 交互流程板(docKind=page 且 ≥2 屏):多屏原型地图 + 元素锚点 + 彩色跳转流线。
// cvUiInfo=当前交互地图布局信息(mode=ui-flow;为空=页面结构板/加载失败);cvUiMode=用户视图选择
// (interaction=交互地图,structure=原页面结构板);cvUiTask=当前选择归属的板(切板回默认交互)。
// 拖动是视图微调:位置存 localStorage(不写 boardDoc,避免旧板 pos 把新网格打散);「整理」清空。
let cvUiInfo = null;
let cvUiMode = "interaction";
let cvUiTask = "";
let cvUiMovedCache = null;
const CV_UI_CAP_H = 58;
const CV_UI_CAP_PAD = 6;
function cvUiAvailable(doc) {
  if (!doc || doc.docKind !== "page") return false;
  if (typeof BoardUiFlowLayout === "undefined") return false;
  const pages = (doc.nodes || []).filter((n) => n && n.kind === "page");
  if (pages.length < 2) return false;
  if (!(doc.edges || []).some((e) => e && e.kind === "nav")) return false;
 // 稀疏板不默认交互图:22 屏规划板只有 5 屏有区块时,画成 22 张大空屏比结构板更难读。
 // 内容屏比例 ≥40% 才进入多屏原型;否则保留原页面结构板(仍可看层级)。
  const pids = new Set(pages.map((p) => String(p.id)));
  const kidCount = new Map();
  for (const e of (doc.edges || [])) {
    if (!e || e.kind !== "contains" || !pids.has(String(e.from))) continue;
    kidCount.set(String(e.from), (kidCount.get(String(e.from)) || 0) + 1);
  }
  let contentPages = 0;
  for (const p of pages) if ((kidCount.get(String(p.id)) || 0) > 0) contentPages++;
  return contentPages >= Math.max(1, Math.ceil(pages.length * 0.4));
}
function cvUiMovedKey(taskId) { return "zh:bd-uimoved:" + String(taskId || "anon"); }
function cvUiMovedOf(doc) {
  const tid = doc && doc.taskId ? doc.taskId : "";
  if (cvUiMovedCache && cvUiMovedCache.taskId === tid) return cvUiMovedCache.map;
  const map = new Map();
  try {
    const raw = localStorage.getItem(cvUiMovedKey(tid));
    if (raw) {
      const o = JSON.parse(raw);
      for (const k of Object.keys(o || {})) {
        const p = o[k];
        if (p && isFinite(p.x) && isFinite(p.y)) map.set(k, { x: Number(p.x), y: Number(p.y) });
      }
    }
  } catch (e) { /* 存储不可用=无微调,不阻断渲染 */ }
  cvUiMovedCache = { taskId: tid, map };
  return map;
}
function cvUiSetMoved(doc, id, x, y) {
  if (!doc || !doc.taskId || !id || !isFinite(x) || !isFinite(y)) return;
  const map = cvUiMovedOf(doc);
  map.set(String(id), { x: Number(x), y: Number(y) });
  const o = {};
  for (const [k, v] of map) o[k] = v;
  try { localStorage.setItem(cvUiMovedKey(doc.taskId), JSON.stringify(o)); } catch (e) { /* 忽略 */ }
}
function cvUiClearMoved(doc) {
  if (!doc || !doc.taskId) return;
  try { localStorage.removeItem(cvUiMovedKey(doc.taskId)); } catch (e) { /* 忽略 */ }
  cvUiMovedCache = { taskId: doc.taskId, map: new Map() };
}
/** 拖动中的交互地图重排:把当前 DOM 位置当微调输入,只重算流线路由(卡片位置已经跟手)。
 * 纯函数引擎调用,量级 ≤60 节点;不写板、不重建卡片。 */
function cvUiRelayoutMoved(doc, pos) {
  if (!cvUiInfo || typeof BoardUiFlowLayout === "undefined" || typeof BoardPageLayout === "undefined") return;
  const moved = new Map();
  for (const [id, p] of pos) moved.set(id, { x: p.x, y: p.y });
  try {
    const base = BoardPageLayout.layout(doc);
    const ui = BoardUiFlowLayout.layout(doc, base, { moved });
    if (ui) { cvUiInfo = ui; cvPageInfo = ui; }
  } catch (e) { /* 拖动中重排失败=保留上一帧边,不阻断拖拽 */ }
}
function cvUiHasText(s, words) {
  const t = String(s == null ? "" : s);
  for (const w of words) if (t.indexOf(w) >= 0) return true;
  return false;
}
function cvUiAffordance(n) {
  const t = String(n && n.label || "") + " " + String(n && n.summary || "");
  if (cvUiHasText(t, ["开关", "toggle", "Toggle", "已开启", "已关闭"])) return "switch";
  if (cvUiHasText(t, ["输入", "搜索框", "填写", "文本框", "placeholder"])) return "input";
  if (cvUiHasText(t, ["按钮", "提交", "确认", "保存", "添加", "申请", "发送", "登录", "授权"])) return "button";
  if (cvUiHasText(t, ["入口", "跳转", "查看", "进入", "选择", "卡片", "列表项", "查看"])) return "chev";
  return "dot";
}
function cvUiRoute(n) {
  const s = String(n && n.summary || "");
  const i = s.indexOf("路由");
  let u = i >= 0 ? s.slice(i + 2).trim() : "";
  if (u) u = u.split(" ")[0];
  if (!u) u = String(n && n.label || "").slice(0, 18);
  return u;
}
function cvUiCaptionHtml(n, pm, info) {
  if (!pm || !pm.caption) return "";
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  return '<div class="cv-ui-cap" data-uicap="' + esc(n.id) + '" style="left:' + pm.caption.x + "px;top:" + pm.caption.y + "px;width:" + pm.caption.w + "px;height:" + pm.caption.h + 'px">' +
    '<div class="cv-ui-cap-row"><span class="cv-ui-no">' + esc(pm.no) + "</span>" +
    '<span class="cv-ui-cap-tt" title="' + esc(pm.title) + '">' + (n.done ? '<span class="cv-done bf-done">' + ic("check") + " </span>" : "") + esc(pm.title) + "</span>" +
    (pm.main ? '<span class="cv-ui-main-tag">主线</span>' : "") +
    (pm.entry ? '<span class="cv-ui-entry-tag">入口</span>' : "") +
    (cmtN ? '<span class="cv-ui-cap-cmt">评 ' + cmtN + "</span>" : "") + "</div>" +
    '<div class="cv-ui-cap-sum" title="' + esc(pm.summary) + '">' + esc(pm.summary) + "</div></div>";
}
function cvUiTabbarHtml(pm, pageId) {
  const tabs = pm && pm.tabs ? pm.tabs : [];
  if (!tabs.length) return "";
  return '<div class="cv-ui-tabbar">' + tabs.map((t) =>
    '<span class="cv-ui-tab' + (t.to === pageId ? " on" : "") + '" title="' + esc(t.label) + '">' + esc(t.label) + "</span>").join("") + "</div>";
}
function cvUiScreenHtml(n, pm, selCls) {
  const info = cvUiInfo;
  if (!info || !pm) return "";
  const sz = info.size.get(n.id) || { w: 250, h: 300 };
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  const mobile = !!pm.mobile;
  const tabs = pm.tabs || [];
  const dtabs = !mobile && tabs.length
    ? '<span class="cv-ui-dtabs">' + tabs.map((t) => '<span class="cv-ui-dtab' + (t.to === n.id ? " on" : "") + '">' + esc(t.label) + "</span>").join("") + "</span>"
    : "";
  const chrome = mobile
    ? '<div class="cv-ui-status"><span>9:41</span><span class="cv-ui-status-r">● ● ●</span></div>' +
      '<div class="cv-ui-nav"><span class="cv-ui-back">‹</span><span class="cv-ui-navtt">' + esc(String(n.label || "").slice(0, 18)) + "</span><span class='cv-ui-more'>⋯</span></div>"
    : '<div class="cv-ui-browser"><span class="cv-ui-dots"><i></i><i></i><i></i></span><span class="cv-ui-url">' + esc(cvUiRoute(n)) + "</span>" + dtabs + "</div>";
  const bars = (info.actionBars || []).filter((b) => b.pid === n.id).map((b) =>
    '<div class="cv-ui-actionbar" style="left:' + (b.x - pm.x) + "px;top:" + (b.y - pm.y) + "px;width:" + b.w + "px;height:" + b.h + 'px"></div>').join("");
  return cvUiCaptionHtml(n, pm, info) +
    '<div class="cv-node cv-ui-screen' + (pm.main ? " ui-main" : "") + (mobile ? " ui-mobile" : " ui-desktop") + selCls + '" data-cv="' + esc(n.id) + '" data-uipage="' + esc(n.id) + '" style="left:' + pm.x + "px;top:" + pm.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px">' +
    '<div class="cv-ui-chrome">' + chrome +
    (cmtN ? '<span class="bd-tag cv-cmts" title="' + cmtN + ' 条评论">评 ' + cmtN + "</span>" : '<span class="bd-tag cv-cmts" style="display:none">评 0</span>') +
    "</div>" + bars +
    (pm.kidCount === 0 ? '<div class="cv-ui-empty">' + (pm.reusedCount ? "该屏仅复用其他屏元素" : "该屏未声明独立区块") + "</div>" : "") +
    (mobile ? cvUiTabbarHtml(pm, n.id) : "") + "</div>";
}
/** 浮层窗口本体(弹窗/抽屉/下拉):标题条 + 浮层类型徽标 + 关闭钮;内部控件是同级绝对定位卡片。 */
function cvUiPopupPanelHtml(n, selCls, baseCls) {
  const info = cvUiInfo;
  if (!info) return "";
  const sz = info.size.get(n.id) || { w: 200, h: 90 };
  const p = info.pos.get(n.id) || { x: 0, y: 0 };
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  const pm = (info.popups || []).find((x) => x.id === n.id) || null;
  const kindText = pm ? (pm.mode === "bottom" ? "底部抽屉" : pm.mode === "right" || pm.mode === "left" ? "侧边抽屉" : pm.mode === "popover" ? "下拉菜单" : "弹窗") : "弹窗";
  const kids = (info.popupKids && info.popupKids.get(n.id)) || 0;
  const done = n.done ? '<span class="cv-done bf-done">' + ic("check") + " </span>" : "";
  return '<div class="' + baseCls + selCls + '" data-cv="' + esc(n.id) + '" data-uipop="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px" title="' + esc(String(n.label || "") + " · " + String(n.summary || "")) + '">' +
    '<div class="cv-ui-pop-head"><span class="cv-ui-pop-tt">' + done + esc(String(n.label || "浮层").slice(0, 24)) + "</span>" +
    '<span class="cv-ui-pop-kind">' + esc(kindText) + "</span>" +
    (cmtN ? '<span class="bd-tag cv-cmts" style="flex-shrink:0;font-size:8px">评 ' + cmtN + "</span>" : "") +
    '<span class="cv-ui-pop-close" title="关闭浮层">×</span></div>' +
    (kids ? "" : '<div class="cv-ui-pop-body">' + esc(String(n.summary || "浮层内容").slice(0, 80)) + "</div>") +
    "</div>";
}
function cvUiPopupFrameHtml(n, selCls, extraCls) {
  return cvUiPopupPanelHtml(n, selCls + (extraCls || ""), "cv-node cv-ui-sec cv-ui-popup");
}
function cvUiPopupCardHtml(n, selCls) {
  return cvUiPopupPanelHtml(n, selCls, "cv-node cv-ui-pop-card");
}
/** 页内浮层遮罩(世界层,位于普通卡片之上、浮层窗口之下)。 */
function cvUiPopupMaskHtml(info) {
  if (!info || !info.popupMasks || !info.popupMasks.length) return "";
  return info.popupMasks.map((m) =>
    '<div class="cv-ui-popmask" data-uipopmask="' + esc(m.pageId) + '" style="left:' + m.x + "px;top:" + m.y + "px;width:" + m.w + "px;height:" + m.h + 'px"></div>').join("");
}
function cvUiSectionHtml(n, selCls) {
  const info = cvUiInfo;
  if (!info) return "";
  if (info.popupIds && info.popupIds.has(n.id)) {
    return cvUiPopupFrameHtml(n, selCls, info.popupTriggers && info.popupTriggers.has(n.id) ? " cv-ui-pop-trigger" : "");
  }
  if (info.popupHeadingIds && info.popupHeadingIds.has(n.id)) {
    const hp = info.pos.get(n.id) || { x: 0, y: 0 }, hs = info.size.get(n.id) || { w: 120, h: 14 };
    return '<div class="cv-node cv-ui-sec cv-ui-pop-heading cv-ui-pop-child' + selCls + '" data-cv="' + esc(n.id) + '" style="left:' + hp.x + "px;top:" + hp.y + "px;width:" + hs.w + "px;height:" + hs.h + 'px">' +
      '<span class="cv-ui-sec-h">' + esc(String(n.label || "").slice(0, 24)) + "</span></div>";
  }
  const sz = info.size.get(n.id) || { w: 180, h: 46 };
  const p = info.pos.get(n.id) || { x: 0, y: 0 };
  const role = info.roles.get(n.id) || "main";
  const secType = (info.sectionTypes && info.sectionTypes.get(n.id)) || "";
  const secKids = (info.sectionKids && info.sectionKids.get(n.id)) || 0;
  const hideSecTitle = (secType === "header" || secType === "toolbar" || secType === "footer") && secKids > 0;
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  const sub = String(n.summary || "");
  const secHots = (info.hotspots.get(n.id) || []).slice(0, 3).map((h) =>
    '<i class="cv-ui-hot' + (h.inferred ? " inferred" : "") + '" style="background:' + h.color + '" title="' + esc((h.inferred ? "推断" : "") + (h.dir === "out" ? "触发:" : "到达:") + h.label) + '"></i>').join("");
  const popCls = (info.popupOf && info.popupOf.has(n.id) ? " cv-ui-pop-child" : "") +
    (info.popupTriggers && info.popupTriggers.has(n.id) ? " cv-ui-pop-trigger" : "");
  return '<div class="cv-node cv-ui-sec role-' + esc(role) + ' sec-' + esc(secType) + popCls + selCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px" title="' + esc(sub) + '">' +
    (!hideSecTitle && secType === "header" ? '<span class="cv-ui-logo">◉</span>' : !hideSecTitle && secType === "sidebar" ? '<span class="cv-ui-rail"></span>' : "") +
    (hideSecTitle ? "" : '<span class="cv-ui-sec-h">' + (n.done ? '<span class="cv-done bf-done">' + ic("check") + " </span>" : "") + esc(String(n.label || "").slice(0, 30)) + secHots + "</span>") +
    (sz.h >= 44 && sub ? '<span class="cv-ui-sec-s">' + esc(sub.slice(0, 42)) + "</span>" : "") +
    (cmtN ? '<span class="bd-tag cv-cmts">评 ' + cmtN + "</span>" : '<span class="bd-tag cv-cmts" style="display:none">评 0</span>') +
    "</div>";
}
function cvUiIconGlyph(n) {
  const t = String(n.label || "") + " " + String(n.summary || "");
  if (/(品牌|logo)/i.test(t)) return "◈";
  if (/(收藏|心形)/.test(t)) return "♥";
  if (/(更多|菜单)/.test(t)) return "⋯";
  if (/(设置|配置)/.test(t)) return "⚙";
  if (/(搜索)/.test(t)) return "⌕";
  if (/(刷新)/.test(t)) return "⟳";
  if (/(分享)/.test(t)) return "↗";
  if (/(关闭|取消)/.test(t)) return "×";
  if (/(通知|铃铛|提醒)/.test(t)) return "◉";
  if (/(头像)/.test(t)) return "◉";
  return "⋯";
}
function cvUiRowHtml(n, selCls) {
  const info = cvUiInfo;
  if (!info) return "";
  if (info.popupIds && info.popupIds.has(n.id)) return cvUiPopupCardHtml(n, selCls);
  const ctl = (info.controls && info.controls.get(n.id)) || "row";
  const popCls = (info.popupOf && info.popupOf.has(n.id) ? " cv-ui-pop-child" : "") +
    (info.popupTriggers && info.popupTriggers.has(n.id) ? " cv-ui-pop-trigger" : "");
  if (ctl === "fab") {
    const sz = info.size.get(n.id) || { w: 44, h: 44 };
    const p = info.pos.get(n.id) || { x: 0, y: 0 };
    const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
    return '<div class="cv-node cv-ui-fab' + popCls + selCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px" title="' + esc(String(n.label || "") + " · " + String(n.summary || "")) + '"><span>+</span>' +
      (cmtN ? '<span class="bd-tag cv-cmts">' + cmtN + "</span>" : '<span class="bd-tag cv-cmts" style="display:none">0</span>') + "</div>";
  }
  const sz = info.size.get(n.id) || { w: 120, h: 28 };
  const p = info.pos.get(n.id) || { x: 0, y: 0 };
  const role = info.roles.get(n.id) || "main";
  const hots = info.hotspots.get(n.id) || [];
  const hotHtml = hots.slice(0, 4).map((h) =>
    '<i class="cv-ui-hot' + (h.inferred ? " inferred" : "") + '" style="background:' + h.color + '" title="' + esc((h.inferred ? "推断" : "") + (h.dir === "out" ? "触发:" : "到达:") + h.label + " · " + h.group) + '"></i>').join("");
  const done = n.done ? '<span class="cv-done bf-done">' + ic("check") + " </span>" : "";
  const label = esc(String(n.label || ""));
  const labelText = String(n.label || "");
  const allText = labelText + " " + String(n.summary || "");
  let inner = "", tail = "";
  if (ctl === "primary" || ctl === "secondary" || ctl === "danger" || ctl === "text") {
    inner = '<span class="cv-ui-row-lb">' + done + label + "</span>";
  } else if (ctl === "icon") {
    inner = '<span class="cv-ui-icon-glyph" title="' + label + '">' + esc(cvUiIconGlyph(n)) + "</span>";
  } else if (ctl === "toggle") {
    const off = /(已关闭|关闭|禁用|停用|未开启|未启用)/.test(allText) && !/(已开启|启用)/.test(allText);
    inner = '<span class="cv-ui-row-lb">' + done + label + "</span>";
    tail = '<span class="cv-ui-switch' + (off ? " off" : "") + '"><i></i></span>';
  } else if (ctl === "input") {
    const ph = labelText.replace("搜索框", "").replace("输入", "").replace("文本框", "").trim() || labelText || "请输入";
    const ico = /搜索/.test(labelText) ? '<span class="cv-ui-inpico">⌕</span>' : "";
    inner = '<span class="cv-ui-inputbox">' + ico + "<em>" + esc(ph.slice(0, 22)) + "</em></span>";
  } else if (ctl === "select") {
    inner = '<span class="cv-ui-row-lb">' + done + label + "</span>";
    tail = '<span class="cv-ui-chev">⌄</span>';
  } else if (ctl === "checkbox") {
    const on = /(勾选|同意|选中|默认)/.test(allText) && !/(未勾选|不同意|未选)/.test(allText);
    inner = "<span class='cv-ui-checkbox" + (on ? " on" : "") + "'>" + (on ? "✓" : "") + "</span><span class='cv-ui-row-lb'>" + done + label + "</span>";
  } else if (ctl === "radio") {
    const on = /(选中|默认|当前)/.test(allText) && !/(未选|不选)/.test(allText);
    inner = "<span class='cv-ui-radio" + (on ? " on" : "") + "'></span><span class='cv-ui-row-lb'>" + done + label + "</span>";
  } else if (ctl === "tab") {
    const on = /(当前|选中|默认|active)/.test(allText);
    inner = '<span class="cv-ui-tabpill' + (on ? " on" : "") + '">' + label + "</span>";
  } else if (ctl === "card") {
    inner = '<span class="cv-ui-row-lb">' + done + label + "</span>";
    tail = '<span class="cv-ui-chev">›</span>';
  } else {
    const aff = cvUiAffordance(n);
    const affHtml = aff === "switch" ? '<span class="cv-ui-switch"><i></i></span>'
      : aff === "button" ? '<span class="cv-ui-btn">›</span>'
      : aff === "input" ? '<span class="cv-ui-inp">输入</span>'
      : aff === "chev" ? '<span class="cv-ui-chev">›</span>'
      : '<span class="cv-ui-dotv"></span>';
    inner = '<span class="cv-ui-row-lb">' + done + label + "</span>";
    tail = affHtml;
  }
  const fn = String(n.kind || "") === "function" ? " cv-ui-row-fn" : "";
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  return '<div class="cv-node cv-ui-row ctl-' + esc(ctl) + ' role-' + esc(role) + fn + popCls + selCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px" title="' + esc(String(n.label || "") + " · " + String(n.summary || "")) + '">' +
    (fn ? '<span class="cv-ui-fn">函</span>' : "") + inner + hotHtml + tail +
    (cmtN ? '<span class="bd-tag cv-cmts">评 ' + cmtN + "</span>" : '<span class="bd-tag cv-cmts" style="display:none">评 0</span>') +
    "</div>";
}
function cvUiAuxHtml(n, selCls) {
  const info = cvUiInfo;
  if (!info) return "";
  const sz = info.size.get(n.id) || { w: 196, h: 46 };
  const p = info.pos.get(n.id) || { x: 0, y: 0 };
  const cmtN = n.comments && n.comments.length ? n.comments.length : 0;
  return '<div class="cv-node cv-ui-aux k-' + esc(String(n.kind || "")) + selCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px" title="' + esc(String(n.summary || "")) + '">' +
    '<span class="cv-ui-aux-k">' + esc(CV_KIND_ICON[n.kind] || "?") + "</span>" +
    '<span class="cv-ui-aux-b"><b>' + esc(String(n.label || "").slice(0, 20)) + "</b><em>" + esc(String(n.summary || "").slice(0, 34)) + "</em></span>" +
    (cmtN ? '<span class="bd-tag cv-cmts">评 ' + cmtN + "</span>" : '<span class="bd-tag cv-cmts" style="display:none">评 0</span>') +
    "</div>";
}
function cvUiCardRank(n) {
  if (!n) return 9;
  if (n.kind === "page") return 0;
  if (n.kind === "section") return 1;
  if (cvUiInfo && cvUiInfo.auxNodes && cvUiInfo.auxNodes.some((x) => x.id === n.id)) return 3;
  return 2;
}
function cvUiLegendHtml(info) {
  if (!info || !info.groups || !info.groups.length) return "";
  const items = info.groups.slice(0, 10).map((g) => {
    const dash = !!g.dash;
    const sw = dash
      ? 'background:transparent;border-top:2px dashed ' + g.color + ";height:0;"
      : "background:" + g.color + ";";
    return '<span class="cv-ui-lg" title="' + esc(g.label + " · " + g.count + " 条") + '"><i class="cv-ui-sw" style="' + sw + '"></i><span>' + esc(g.label) + '</span><b>' + g.count + "</b></span>";
  }).join("");
  return items;
}
function cvUiHeadHtml(info) {
  if (!info || !info.head) return "";
  const h = info.head;
  return '<div class="cv-ui-head" style="left:' + h.x + "px;top:" + h.y + "px;width:" + h.w + "px;height:" + h.h + 'px">' +
    '<div class="cv-ui-head-l"><div class="cv-ui-head-tt" title="' + esc(h.title) + '">' + esc(h.title) + '</div><div class="cv-ui-head-sum">' + esc(h.summary) + "</div></div>" +
    '<div class="cv-ui-legend">' + cvUiLegendHtml(info) + "</div></div>";
}
// 白板「易读性」w1/w2(经验证 60 节点板:适配 k=0.70 只能完整看到 2/60 节点,31/60 标题被
// ellipsis、52/60 摘要被裁、泳道 21 条平均 2.8 节点——病灶是「一个画布塞 10 个任务」而不是卡片本身)。
// w1 写者过滤:节点 id 前缀(a1-/pqa6e-…)分组 chip,点选只**渲染**该写者节点(不动 boardDoc);
// 过滤后布局按子集重算(BoardFlowLayout.layout(子集)),否则隐藏节点留出的空白把画面撑散。
// w2 密度分层:节点数 > CV_FOLD_THRESHOLD 且未过滤时,只画主线卡(entry→exit),其余按泳道汇总成
// 一个 .cv-fold 计数块(+N),点它展开该泳道(展开集合 cvFoldOpen)。
let cvWriterOn = null;        // null=全选(不过滤);否则 Set<string> 可见写者前缀("" = 无前缀的「其他」)
let cvFoldGroups = false;     // svg 模式按 group 折叠大分组(≥5 节点),减少图面节点数(视图态,不动板数据)
let cvWriterAll = [];         // 最近一次渲染统计的写者清单 [{pfx,n}](chip 条数据源)
let cvFoldOpen = new Set();   // 已展开的泳道 key(w2 点 +N 展开的那几条)
let cvFoldMode = false;       // 本次渲染是否处于密度分层(cvFitNow 据此不把跨板泳道框算进适配)
// 「白板看得懂」层高亮(纯 UI 态,不写板):"" = 不很高亮; "keep"/"chg" = 只高亮该层
// (另一层加 .cv-layer-dim 降透明)。切板/重渲复位在 renderBoardCanvas 里做,不污染别的板。
let cvLayerOn = "";
let cvLayerTask = "";         // 层高亮归属的板(切板自动清)
// B:research 板「决策矩阵」表格视图(纯 UI 态,不写板/不改 schema)。
// cvMatrixOn=当前是否显示表格(仅 boardType=research);cvMatrixTask=当前表格态归属的板,
// 切板自动回画布(不同板的表格没有延续意义);cvMatrixSel=表格内选中的单元格(节点+维度)。
let cvMatrixOn = false;
let cvMatrixTask = "";
let cvMatrixSel = null;
const CV_FOLD_THRESHOLD = 20; // 密度分层阈值:节点数 > 20 才收卡(小板全画,别平白藏东西)
// 视野归属(P0:「保存回执抢走用户视野」):全量渲染后那条自动 cvFitNow 原先无条件执行
// ——用户放大到 160% 看细部,只要发生一次保存回执(agent 回写/编辑保存/广播刷新都会走全量重渲),
// 视野就被静默复位到自动适配值,零提示。这里记「用户已手动操作过视野」,自动适配仅在未被手动动过时执行;
// 切板 / 点「适」/ 点「整理」都算「重新归系统管」→ 复位为 false(首次进板自动适配因此完整保留)。
let cvViewTouched = false;
// fixH2 布局开关(白板工具栏):默认流动 LR;localStorage zh:bd-layout=compact 时走「紧凑/原布局」。
// 只影响非 page 板;page 板永远走 BoardPageLayout(既有行为不动)。
function cvFlowOn() {
  try { return localStorage.getItem("zh:bd-layout") !== "compact"; } catch (e) { return true; }
}
/** 流动布局是否启用(单一口径,渲染/签名/「整理」三处共用):
 * ① 有边 → 流动 LR 流程图;
 * ② 无边但含阶段卡(ph-*,task_phase 的「00 流程」泳道节点)→ 同样走流动引擎——
 * 旧口径要求 edges.length>0,纯阶段板(只有 5 张阶段卡)整板不走流动布局,阶段卡被旧分层
 * 当孤箱摆一堆,「00 流程」泳道永远不出现(用户用户反馈)。 */
function cvFlowEligible(doc) {
  if (!doc || typeof BoardFlowLayout === "undefined" || !cvFlowOn()) return false;
  if (doc.docKind === "page") return false; // page 板永远走 BoardPageLayout
  if (doc.edges && doc.edges.length > 0) return true;
  return (doc.nodes || []).some((n) => /^ph-/.test(String(n.id)));
}
/** 宽设计板列换行开关(任务 A,面板侧裁决):
 * 引擎只会「受控」折行——这里决定把哪些板交给 autoWrap(引擎再按主路径列数 > 4 二次裁决):
 * · 只对非 page、节点 ≥6 的板开(小板横排本来读得下);
 * · refactor 板**不折**:现状/目标双泳道并排是它的核心语义,折成网格会破坏对照关系;
 * · research 板照常折(canvas 仍可用;决策矩阵视图是另一条腿,见 researchMatrixRows)。
 * 不改板数据:折行只是渲染层布局,节点 pos 不落盘(流动引擎位本来就是唯一真相)。 */
function cvFlowWrapWanted(doc, fdoc) {
  const d = doc || {};
  const nodes = (fdoc && fdoc.nodes) || (d.nodes || []);
  if (d.docKind === "page") return false;
  if (d.boardType === "refactor") return false;
  return nodes.length >= 6;
}
// fixH2 流动模式下的手动微调:用户拖过的节点记在 localStorage(按板隔离);未拖过的节点恒走引擎位,
// 存量旧板(旧分层 pos 已固化)也能立即看到新流程布局。「整理」清空微调回到自动流动。
function cvFlowMovedKey(taskId) { return "zh:bd-flow-moved:" + (taskId || "anon"); }
function cvFlowMoved(taskId) {
  try {
    const a = JSON.parse(localStorage.getItem(cvFlowMovedKey(taskId)) || "[]");
    return new Set(Array.isArray(a) ? a : []);
  } catch (e) { return new Set(); }
}
function cvFlowMarkMoved(id) {
  const t = boardDoc || cvActiveDoc;
  if (!t || !t.taskId) return;
  try {
    const s = cvFlowMoved(t.taskId);
    s.add(id);
    localStorage.setItem(cvFlowMovedKey(t.taskId), JSON.stringify([...s]));
  } catch (e) { /* 隐私模式 localStorage 不可用:本次拖拽仍生效,仅不跨刷新记忆 */ }
}
function cvFlowClearMoved(taskId) {
  try { localStorage.removeItem(cvFlowMovedKey(taskId)); } catch (e) { /* 忽略 */ }
}
/** w1 写者前缀:id 形如 a1-card / pqa6e-r3a1 → 取首个 "-" 前 1~7 位字母数字(首字符必须是字母);
 * 不符(如 plainnode、ph-understand)→ 返回空串(渲染成「其他」)。ph-* 是阶段卡,不是写者。
 * 模板层纪律:PAGE 是 TS 模板字符串,注释里的反引号会提前闭合它(经验证 tsc TS1005)——本注释零反引号。 */
function cvWriterOf(id) {
  const s = String(id || "");
  const k = s.indexOf("-");
  if (k <= 0 || k > 7) return "";
  const head = s.slice(0, k);
  const isAlpha = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
  const isAlnum = (c) => isAlpha(c) || (c >= "0" && c <= "9");
  if (!isAlpha(head.charAt(0))) return "";
  for (let i = 1; i < head.length; i++) if (!isAlnum(head.charAt(i))) return "";
  if (head === "ph") return ""; // 阶段卡(00 流程泳道)不是写者,不进 chip
  return head;
}
/** w1 chip 清单:按节点数降序(并列按前缀字典序),无前缀的「其他」("")永远最后。 */
function cvWriterChips(nodes) {
  const cnt = new Map();
  for (const n of (Array.isArray(nodes) ? nodes : [])) {
    const p = cvWriterOf(n && n.id);
    cnt.set(p, (cnt.get(p) || 0) + 1);
  }
  const out = [...cnt.entries()].map(([pfx, n]) => ({ pfx, n }));
  out.sort((a, b) => (a.pfx === "" ? 1 : b.pfx === "" ? -1 : (b.n - a.n) || (a.pfx < b.pfx ? -1 : 1)));
  return out;
}
function cvWriterLabel(pfx) { return pfx ? pfx : "其他"; }
/** w1 过滤子集:只留可见写者的节点 + **两端都可见**的边(悬空边不画,也不进布局)。
 * 只影响渲染——boardDoc 一律不动(过滤是视图态,不是板数据)。 */
function cvWriterFilterDoc(doc, on) {
  const sel = on || null;
  if (!sel || !sel.size) return doc;
  const nodes = (doc.nodes || []).filter((n) => sel.has(cvWriterOf(n && n.id)));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = (doc.edges || []).filter((e) => e && keep.has(e.from) && keep.has(e.to));
  return { taskId: doc.taskId, docKind: doc.docKind, status: doc.status, title: doc.title, nodes, edges };
}
/** 按 group 统计组大小(组名 trim 非空才算;返回 [大组数(≥5 节点), 小组数])。
 * 大组阈值 5 = 服务端 foldMin 缺省口径。cvGroupCount / cvFoldAvailable 都从这里取,不各写一遍。 */
function cvGroupSplit(doc) {
  const cnt = new Map();
  for (const n of ((doc && doc.nodes) || [])) {
    const g = String((n && n.group) || "").trim();
    if (!g) continue;
    cnt.set(g, (cnt.get(g) || 0) + 1);
  }
  let big = 0, small = 0;
  for (const v of cnt.values()) { if (v >= 5) big++; else small++; }
  return [big, small];
}
/** 大分组数(≥5 节点的组),用于「折叠分组 (N)」chip 的计数。 */
function cvGroupCount(doc) { return cvGroupSplit(doc)[0]; }
/** 与服务端 board-filter.ts 的 SMALL_GROUP_MERGE_AT 同值(面板内联脚本不能 import,只能各写一份,
 * **改一处必须改两处**)。 */
var SMALL_GROUP_MERGE_AT_UI = 12;
/** 折叠可用性(与服务端 board-filter.ts 同口径):大分组 >= 1 组 **或** 小分组(组非空且 < foldMin)
 * 组数 >= 12(碎泳道兜底)。只数大分组会让 35 条碎泳道的真板永远看不到折叠入口(经验证)。 */
function cvFoldAvailable(doc) {
  const s = cvGroupSplit(doc);
  return s[0] >= 1 || s[1] >= SMALL_GROUP_MERGE_AT_UI;
}
function cvHostEl() { return cvActiveHost && cvActiveHost.isConnected ? cvActiveHost : document.getElementById("cvHost"); }
function cvScoped(id) { const h = cvHostEl(); return (h && h.querySelector("#" + id)) || document.getElementById(id); }
// ---- 白板渲染模式:flowkit 单张 SVG(默认) / 逐节点 DOM 卡片(回退) ----
// 服务端能力在 src/board-diagram.ts(renderBoardSvg);面板在浏览器里不能直接调它,走 WS:
// 请求 {type:"board.diagram", sessionId, taskId, theme} → 回包 {type:"board.diagram.result", ok, svg, ...}
// 单点回滚开关:localStorage.cvRender = "cards" 即回老「逐节点 DOM 卡片」路径(其余一律 svg)。
let cvSvgCacheSig = "";   // cvSvgCacheHtml 对应的签名(taskId+rev+模式)
let cvSvgCacheHtml = "";  // 最近一次拿到的 svg 文本(空串=还没回来)
let cvSvgPending = "";    // 在途请求签名(同签名不重复发,防请求风暴)
function cvRenderMode() { try { return localStorage.getItem("cvRender") === "cards" ? "cards" : "svg"; } catch (e) { return "svg"; } }
/** svg 模式的节点命中:从事件目标向上找最近的 [data-node-id](flowkit 出的 <g data-node-id=板节点 id>,逐字一致)。
 * 纯 DOM 遍历、不用 closest(兼容无 closest 的桩);非 svg 模式/找不到 → 空串。 */
function cvSvgNodeAt(ev) {
  try {
    if (cvRenderMode() !== "svg") return "";
 // 修断裂:flowkit 出的 <g data-node-id> 不止承载板节点——泳道/分组/矩阵单元格
 // 也带同名属性(经验证 svg 里除 f1..f8 还有 01/02/06/dsl-xxx 等分组 id)。旧实现只认属性存在,
 // 于是右键分组背景得到「编辑明细/删除」、点了对不存在的 id 操作 = 静默失败;双击分组也算命中节点,
 // 空白双击开不了工具箱。这里必须再校验该 id 真是板上的节点。
    const doc = (typeof cvTargetDoc === "function" ? cvTargetDoc() : null) || null;
    const known = doc && Array.isArray(doc.nodes) ? new Set(doc.nodes.map((n) => n && String(n.id))) : null;
    let n = ev && ev.target;
    while (n && n !== document) {
      if (n.getAttribute) {
        const id = n.getAttribute("data-node-id");
        if (id && (!known || known.has(String(id)))) return String(id);
      }
      n = n.parentElement;
    }
    return "";
  } catch (e) { return ""; }
}
/** 把全局选中态(boardSelNode)回放到 svg 里的节点 <g> 上:就地 classList.toggle,不重渲整板/不重置视野。 */
function cvSvgApplySel(root) {
  try {
    const host = root || cvHostEl();
    const svgRoot = host && host.querySelector ? (host.querySelector("#cvSvgHost > svg") || host.querySelector("#cvSvgHost svg") || host) : null;
    if (!svgRoot || !svgRoot.querySelectorAll) return;
    const els = svgRoot.querySelectorAll("[data-node-id]");
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el || !el.classList) continue;
      el.classList.toggle("cv-svg-on", !!boardSelNode && el.getAttribute("data-node-id") === boardSelNode);
    }
  } catch (e) { /* 高亮失败不影响画布 */ }
}
/** 本次出图要用的视图态过滤(与服务端 board-filter.ts 同口径);写者/折叠都没启用 → null(=不过滤)。 */
function cvSvgFilterOf() {
  const on = typeof cvWriterOn === "undefined" ? null : cvWriterOn;
  const fold = typeof cvFoldGroups === "undefined" ? false : !!cvFoldGroups;
  const writers = on ? [...on].sort() : [];
  if (!writers.length && !fold) return null;
  return { writers: writers, foldGroups: fold };
}
/** svg 模式的增量签名:只由 doc.rev(+板 id)与渲染模式组成——卡片 DOM 那套结构签名与 svg 无关。
 * 过滤态也进签名:同一 rev 的「全量图」与「只看 a1 的图」是两张不同的图,不区分就会钉死旧图。
 * 无过滤时签名逐字不变(taskId|rev|模式),既有缓存/测试口径不受影响。 */
function cvSvgSig(doc) {
  const base = (doc && doc.taskId ? doc.taskId : "") + "|" + (doc && doc.rev != null ? doc.rev : "") + "|" + cvRenderMode();
  const flt = cvSvgFilterOf();
  if (!flt) return base;
  return base + "|w:" + flt.writers.join(",") + "|f:" + (flt.foldGroups ? "1" : "0");
}
/** "minX minY w h" → {minX,minY,w,h};畸形/非正宽高返回 null(调用方必须能回退)。 */
function cvVbParse(s) {
  try {
    const p = String(s == null ? "" : s).replace(/,/g, " ").trim().split(" ").filter((x) => x.length > 0);
    if (p.length !== 4) return null;
    const v = p.map((x) => parseFloat(x));
    for (const n of v) if (!isFinite(n)) return null;
    if (!(v[2] > 0) || !(v[3] > 0)) return null;
    return { minX: v[0], minY: v[1], w: v[2], h: v[3] };
  } catch (e) { return null; }
}
/** 从 svg 文本里取 viewBox 属性值再解析(无 viewBox/畸形=null)。零正则:引号配对扫描。 */
function cvSvgBox(svg) {
  try {
    const s = String(svg == null ? "" : svg);
    const i = s.indexOf("viewBox=");
    if (i < 0) return null;
    let j = i + 8;
    const q = s.charAt(j);
    const close = q === '"' || q === "'" ? q : '"';
    if (q === '"' || q === "'") j++;
    let e = j;
    while (e < s.length && s.charAt(e) !== close) e++;
    return cvVbParse(s.slice(j, e));
  } catch (e) { return null; }
}
/** svg 模式的世界尺寸:viewBox 宽高 + 60 留白(与 cards 路径既有 +60 口径一致,keep)。 */
function cvSvgWorldSize(svg) { const b = cvSvgBox(svg); return b ? { w: b.w + 60, h: b.h + 60 } : null; }
/** 画布内 svg 的内容框:优先 viewBox,缺失退 width/height 属性;都没有=null(小地图/适配都不画)。 */
function cvSvgContentBox(host) {
  const h = host || cvHostEl();
  if (!h || !h.querySelector) return null;
  const el = h.querySelector("#cvSvgHost > svg") || h.querySelector("#cvSvgHost svg");
  if (!el || !el.getAttribute) return null;
  const b = cvVbParse(el.getAttribute("viewBox"));
  if (b) return { w: b.w, h: b.h };
  const w = parseFloat(el.getAttribute("width")) || 0, hh = parseFloat(el.getAttribute("height")) || 0;
  return w > 0 && hh > 0 ? { w: w, h: hh } : null;
}
/** 任务B:紧凑内容边界(svg 模式「适」用)。优先 diagram-viewport.resolveSvgBoundsFromDom
 * (排除 defs/mask/clipPath/画布背景 rect,只并集可见图形——空白多的图不再按 viewBox 缩成蚂蚁);
 * 引擎缺席/异常/空结果回退 cvSvgContentBox(viewBox/声明尺寸),行为不劣化。
 * 返回 {w,h,minX,minY}(minX/minY 是内容原点,fit 居中要用;回退链没有就 0)。 */
function cvTightSvgBounds(host) {
  const h = host || cvHostEl();
  if (!h || !h.querySelector) return null;
  const el = h.querySelector("#cvSvgHost > svg") || h.querySelector("#cvSvgHost svg");
  if (!el) return cvSvgContentBox(h);
  try {
    const lib = (typeof window !== "undefined" && window.DiagramViewport) || null;
    if (lib && typeof lib.resolveSvgBoundsFromDom === "function") {
      const b = lib.resolveSvgBoundsFromDom(el);
      if (b && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width > 0 && b.height > 0) {
        return { w: b.width, h: b.height, minX: b.x || 0, minY: b.y || 0 };
      }
    }
  } catch (err) { /* 引擎炸了走回退链,fit 不能因此断 */ }
  const fb = cvSvgContentBox(h);
  return fb ? { w: fb.w, h: fb.h, minX: 0, minY: 0 } : null;
}
/** svg 增量决策:keep=签名未变且 svg 已缓存(不重注入/不碰视野);inject=内容变了整块重注入;wait=svg 还没回来。 */
function cvSvgPatchPlan(sig, prevSig, cached) {
  if (!cached) return "wait";
  return prevSig === sig ? "keep" : "inject";
}
/** svg 模式的增量落地(真实行为,可单测):返 true=本帧已处理完毕(不必再全量拼串)。
 * · keep → DOM 里已是这一版 svg:不重注入、不动 cvPan/cvPan.k(既有 P0「保存回执抢走用户视野」不许复活)
 * · inject→ 内容变了:只整块重注入 #cvSvgHost,视野原样保留
 * · wait → svg 还没回来:返 false 让调用方发请求(先按空壳全量拼一次,不白屏) */
function cvSvgTryPatch(host, doc, pos, sig) {
  const h = host || cvHostEl();
  if (!h || !h.querySelector) return false;
  const svgNow = cvSvgCacheSig === sig ? cvSvgCacheHtml : "";
  const old = h.querySelector("#cvSvgHost");
  const domSig = old && old.getAttribute ? (old.getAttribute("data-sig") || "") : "";
  const plan = cvSvgPatchPlan(sig, domSig, !!svgNow);
  if (plan === "keep") return true;
  if (plan === "inject" && old && h.querySelector(".bf-cv-world")) {
    old.innerHTML = svgNow;
    try { old.setAttribute("data-sig", sig); } catch (e) { /* 忽略 */ }
    try { if (old.removeAttribute) old.removeAttribute("data-stale"); } catch (e) { /* 忽略 */ } // 新图到位:抹掉「等图」标记
    cvSvgApplySel(old); // 重注入后把选中态回放到新 svg(否则选中高亮随重注入丢失)
    if (typeof cvDrawMini === "function") { try { cvDrawMini(h, doc, pos); } catch (e2) { /* 小地图失败不影响视图 */ } }
    return true;
  }
  return false;
}
/** 画布世界内容拼串(纯函数,便于契约测试直接跑):cards=老「泳道+边+卡片」三块逐字不动;svg=单张 SVG 主机。 */
function cvWorldBodyHtml(mode, p) {
  if (mode === "cards") return p.laneHtml + p.edgeSvg + p.popupMask + p.cards + p.anchors + p.fold;
 // data-sig 只承诺「DOM 里真装着的那一版 svg」:空壳帧(回包未到,svg 为空串)一律不写,
 // 否则回包后 cvSvgPatchPlan(now, domSig, true) 读到 domSig===now 恒判 keep → 注入分支永不可达
 // (经验证 bug:回包 2496 字节 svg 到了,DOM 里 #cvSvgHost 恒 100 字节空壳、#cvWorld svg=0)。
  const sigAttr = p.svg ? ' data-sig="' + esc(p.sig) + '"' : "";
 // A1:上一版 svg 在等新图期间继续挂着(data-stale="1" 降透明度),不再把画布清空;
 // data-sig 写的仍是**DOM 里真装着的那一版**(旧 sig),回包后 cvSvgPatchPlan 照样判 inject。
  const staleAttr = p.stale ? ' data-stale="1"' : "";
  return p.popupMask + '<div class="cv-svg-host" id="cvSvgHost" title="点节点看详情,空白拖拽平移,滚轮缩放"' + sigAttr + staleAttr + ">" + p.svg + "</div>" + p.anchors + p.fold;
}
/** 请服务端 flowkit 出图(同签名在途不重复发)。过滤态(写者子集/折叠分组)随请求带给服务端。 */
function cvSvgRequest(doc) {
  const sig = cvSvgSig(doc);
  if (cvSvgPending === sig) return;
  cvSvgPending = sig;
  try {
    const light = !!(document.body && String(document.body.className || "").indexOf("light") >= 0);
    const flt = cvSvgFilterOf();
    const body = { v: 1, type: "board.diagram", sessionId: currentSid, taskId: (doc && doc.taskId) || boardTaskId || "", theme: light ? "light" : "dark" };
    if (flt) body.filter = flt; // 无过滤时请求体不带 filter 字段(保持既有请求形态)
    wsSafeSend(JSON.stringify(body));
  } catch (e) { cvSvgPending = ""; }
}
// 分层自动布局(dagre-lite):按边求最长路径分层,层内竖排;有 pos 的节点尊重 pos(拖拽过的不再自动排);force=全量重排(「整理」)
function cvLayout(doc, force) {
  const W = 240, H = 130;
  const pos = new Map();
  const auto = [];
  for (const n of doc.nodes) {
    if (!force && n.pos && isFinite(n.pos.x) && isFinite(n.pos.y)) pos.set(n.id, { x: n.pos.x, y: n.pos.y });
    else auto.push(n.id);
  }
  if (auto.length) {
    const out = new Map(), indeg = new Map();
    for (const id of auto) { out.set(id, []); indeg.set(id, 0); }
    for (const e of doc.edges) {
      if (out.has(e.from) && indeg.has(e.to)) { out.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }
    }
 // Kahn 分层:level = 最长入链
    const level = new Map(auto.map((id) => [id, 0]));
    let q = auto.filter((id) => (indeg.get(id) || 0) === 0);
    const seen = new Set();
    while (q.length) {
      const nxt = [];
      for (const id of q) {
        if (seen.has(id)) continue;
        seen.add(id);
        for (const to of out.get(id) || []) {
          level.set(to, Math.max(level.get(to) || 0, (level.get(id) || 0) + 1));
          indeg.set(to, (indeg.get(to) || 1) - 1);
          if ((indeg.get(to) || 0) <= 0) nxt.push(to);
        }
      }
      q = nxt;
    }
 // 环兜底:未到达的排 0 层
    for (const id of auto) if (!seen.has(id)) level.set(id, 0);
    const byLevel = new Map();
    for (const id of auto) { const l = level.get(id) || 0; if (!byLevel.has(l)) byLevel.set(l, []); byLevel.get(l).push(id); }
    for (const [l, ids] of byLevel) ids.forEach((id, i) => pos.set(id, { x: 20 + l * W, y: 16 + i * H }));
  }
  return pos;
}
/** D2 增量渲染三件套:
 * cvStructSig=结构签名(节点 id/kind/label/change/代码连接键 + 边 from>to>kind>label>virtual + ro/编辑态)——
 * 签名不变说明结构没变,只可能是 done/摘要/评论/连接态/位置/rev 变 → 原位补丁,零 DOM 重建零闪烁;
 * cvMetaHtml=板头 meta 行(全量渲染与补丁共用同一实现,消灭双实现);
 * cvPatchCanvas=原位补丁(逐节点按 id 更新文本/类/位置+边几何重绘+meta 行+小地图),任一节点找不到回 false 走全量。 */
/** n1 签名用的验收/证据指纹:accept 条数+cmd 摘要 + evidence 条数与 ok 数(空=「0」,不膨胀签名)。 */
function cvAccSig(n) {
  const accs = n && Array.isArray(n.accept) ? n.accept : [];
  const evs = n && Array.isArray(n.evidence) ? n.evidence : [];
  if (!accs.length && !evs.length) return "0";
  let okN = 0;
  for (const e of evs) if (e && e.ok === true) okN++;
  return "a" + accs.length + ":" + accs.map((a) => String((a && a.cmd) || "").slice(0, 24)).join("|") + "/e" + evs.length + ":" + okN;
}
/** n1 画布白板卡一级操作条(board 卡卡头:此前白板卡卡头只有 聚焦/折叠/隐藏 三个通用件,
 * 「编辑/评论」退到视图头(vw-head,#boardEditBtn)与浮窗头(#bfEdit)的次级位置 —— 进了画布形态用户
 * 找不到入口。这里在卡头给一排一级按钮,点击行为全部复用既有入口(boardEditToggle / 评论模式 / 按板续作),
 * 零新协议、零新状态机。第三个按钮「按板续作」仅在既有 boardContinueBtn 存在时给出(复用同名动作)。 */
function bdCardActionsHtml() {
  return '<span class="cv-card-acts">' +
    '<button class="vw-act" id="bdCardEdit" data-act="board-edit" title="编辑这块白板(同一保存链:草稿/乐观锁 rev/放弃)">编辑</button>' +
    '<button class="vw-act" id="bdCardComment" data-act="board-comment" title="评论模式:开/关后点任意节点直写该节点评论">评论</button>' +
    (typeof boardContinue === "function" ? '<button class="vw-act" id="bdCardContinue" data-act="board-continue" title="把当前白板编成后续指令,发回原会话继续实施">按板续作</button>' : "") +
    bdPendingChipHtml() +
    "</span>";
}
/** n12 待读评论 chip(纯函数,可单测):当前板在 board.list.result 里带 pendingComments > 0 才出。
 * 语义=「这些评论 agent 还没读到」(服务端 peek 的 pending 队列),不是「评论总数」——后者看节点徽标「评 N」。 */
function bdPendingChipHtml(taskId) {
  const tid = taskId === undefined ? boardTaskId : taskId;
  const p = bdPendingOf(tid);
  const c = p ? p.count : 0;
  if (!(c > 0)) return "";
  return '<span class="bd-tag lk-moved" id="bdCardPending" data-act="board-pending" title="这些评论 agent 还没读到;下一轮任务会带上">待读评论 ' + c + "</span>";
}
/** taskId → { count, nodes }(无待读=null)。 */
function bdPendingOf(taskId) {
  const p = boardListPending || {};
  const it = taskId ? p[taskId] : null;
  return it && it.count > 0 ? it : null;
}
/** 无钉选时的默认板:节点数最多的一块(nodeCount),并列取列表更靠前者(最新)。
 * 纯函数,不改钉选/降级语义(pinnedMissing 分支在外面逐字不动)。空清单返回 ""。 */
function cvDefaultBoardId(items) {
  const list = Array.isArray(items) ? items : [];
  let best = null, bestN = -1;
  for (const it of list) {
    if (!it || !it.taskId) continue;
    const n = Number(it.nodeCount);
    const cnt = isFinite(n) ? n : 0;
    if (cnt > bestN) { best = it; bestN = cnt; } // 严格大于 → 并列保留更靠前(更新)的那块
  }
  return best ? best.taskId : "";
}
/** 该节点上是否有「agent 还没读到」的评论(n12 节点高亮依据)。 */
function bdNodePending(taskId, nodeId) {
  const p = bdPendingOf(taskId);
  return !!(p && p.nodes && p.nodes.indexOf(String(nodeId || "")) >= 0);
}
/** n12 本地登记「刚发出的评论落在哪个节点」:服务端 board.list.result 只给 taskId 级计数(protocol 无节点级),
 * 所以节点高亮用本地事实——用户刚在哪个节点发的评论,就高亮哪个;权威计数仍以 board.list 回包为准。 */
function bdPendingNoteNode(taskId, nodeId) {
  const tid = taskId || boardTaskId;
  const nid = String(nodeId || "");
  if (!tid || !nid) return;
  const cur = (boardListPending && boardListPending[tid]) || { count: 0, nodes: [] };
  const nodes = cur.nodes ? cur.nodes.slice() : [];
  if (nodes.indexOf(nid) < 0) nodes.push(nid);
  boardListPending[tid] = { count: Math.max(cur.count || 0, nodes.length), nodes };
}
/** n12 待读评论状态就地更新:review.inject 回执(agent 已读)= 直接清零;board.doc 回包(评论刚落盘)=
 * 只重拉一次 board.list 的计数(轻量:boardListPendingOnly 置位时不重钉选择/不重拉板,故无回环)。
 * 选这两个最小改动点,不引入新协议。 */
function bdPendingRefresh(mode, taskId) {
  const tid = taskId || boardTaskId;
  if (mode === "clear") {
    if (!tid || !boardListPending || !boardListPending[tid]) return;
    delete boardListPending[tid];
  } else {
    if (!currentSid || ws.readyState !== 1) return;
    boardListPendingOnly = true;
    wsSafeSend(JSON.stringify({ v: 1, type: "board.list", sessionId: currentSid }));
    return; // 回包自己会重渲 chip/高亮
  }
  try { bdCanvasCardActions(); } catch (e) { /* 卡头不在场=无操作 */ } // 卡头 chip 文案刷新(幂等注入)
  if (viewLive("board")) renderBoard();
  renderBoardPanel();
}
/** n2 评论模式开关(纯 UI 态,不进板数据/不进协议):打开=画布节点点击直出评论框,同时把评论区拉到视野(明细卡)。 */
function boardCommentToggle(force) {
  const next = force === undefined ? !boardCommentMode : !!force;
  if (next === boardCommentMode) return boardCommentMode;
  boardCommentMode = next;
  if (boardCommentMode) toast("评论模式:点任意节点直接写评论");
  renderBoard(); // 重渲带出节点高亮/按钮态(sig 已含评论模式位)
  try { bdCanvasCardActions(); } catch (e) { /* 卡头不在场(经典布局)=无操作 */ } // 卡头按钮 on 态回显
  return boardCommentMode;
}
/** n2 判定(纯函数,可单测):这次点击是否应当「就地开该节点的评论框」——
 * 评论模式开 + 非只读画布 + 点到的是节点(或节点内任意子元素,但排除代码档案链接)。
 * 抽成纯函数是为了让「进入评论模式后点节点直接开框」这条行为可被测试直接执行,而不必启浏览器。 */
function bdCommentHit(mode, ro, nodeId, inFile) {
  if (ro || inFile) return false; // 只读画布/点在代码档案链接上:不开评论框(那是跳转动作)
  if (!mode) return false;
  return !!String(nodeId || "");
}
/** n2 就地评论框(画布节点侧):复用既有 board.comment 协议与既有 #bdCmtInput/#bdCmtSend 标记,
 * 放在节点卡内部浮层里(不新开明细卡)。nodeId 由调用方给出(与明细卡同口径:boardDoc 的节点 id)。 */
function bdOpenNodeComment(nodeId, host, el) {
  const id = String(nodeId || "");
  const d = boardDoc;
  const n = d && d.nodes ? d.nodes.find((x) => x.id === id) : null;
  if (!n) { toast("该节点不在当前板内", true); return false; }
  const box = el || (host && host.querySelector ? host.querySelector('.cv-node[data-cv="' + cssEsc(id) + '"]') : null);
  if (!box) return false;
  for (const old of (host || document).querySelectorAll(".cv-ncmt")) old.remove(); // 单活:同一时刻只开一个
  const cs = n.comments || [];
  const wrap = document.createElement("div");
  wrap.className = "cv-ncmt";
 // c1:每条评论后跟「改」「删」小按钮(与明细卡同一行结构与同一处理器)
  wrap.innerHTML = '<div class="cv-ncmt-h">评论 · ' + esc(String(n.label || id)) + "</div>" +
    (cs.length ? cs.map((c, ci) => bdCommentRowHtml(c, ci, n.id)).join("") : '<div class="bd-meta">还没有评论</div>') +
    '<div class="bf-cmt-input"><input id="bdCmtInput" placeholder="写评论(按板续作会带给 agent)" maxlength="500"><button class="vw-act" id="bdCmtSend">评论</button><button class="vw-act" id="bdCmtClose">收起</button></div>';
  box.appendChild(wrap);
  bdBindCommentRows(wrap, n.id); // c1:改/删(作用域=本浮层,不摸全局)
 // 发送:与明细卡完全同一条协议(board.comment),作用域取本浮层(浮窗宿主时全局 $ 会摸到旧渲染)
  const inp = wrap.querySelector("#bdCmtInput");
  const send = wrap.querySelector("#bdCmtSend");
  if (send) send.onclick = () => {
    const text = inp && inp.value.trim();
 // c1:统一走 bdSendComment(append 分支含「先挂 cmt-pending 高亮」与 toast)
    if (!bdSendComment({ op: "append", text: text, nodeId: n.id })) return;
    wrap.remove();
  };
  const cl = wrap.querySelector("#bdCmtClose");
  if (cl) cl.onclick = () => wrap.remove();
  if (inp) setTimeout(() => { try { inp.focus(); } catch (e) { /* 忽略 */ } }, 0);
  return true;
}
/** 属性选择器转义(cssEsc 资产可能未加载):节点 id 由 agent 写,可能含引号/反斜杠。
 * 模板层纪律:此处不得出现字面反斜杠(会被吃成非法正则),斜杠/引号一律走 charCode 取。 */
function cssEsc(s) {
  const BS = String.fromCharCode(92), Q = String.fromCharCode(34);
  let out = "";
  for (const ch of String(s == null ? "" : s)) out += (ch === BS || ch === Q) ? BS + ch : ch;
  return out;
}
/** n1/A3 无边板泳道回退:design 板零边(或只剩零散节点)时不再落旧分层孤箱堆——
 * 按 node.group(缺省按 kind 族)成泳道,泳道左→右排,纵向顺排,编号按声明顺序 01..N。
 * 产出与 BoardFlowLayout 同形(mode=flow),渲染层泳道框/编号角标/图例零改动复用。 */
function bdLaneEligible(doc) {
  if (!doc || doc.docKind === "page" || !cvFlowOn()) return false; // 紧凑模式=尊重保存位置(旧分层)
  if (typeof BoardFlowLayout === "undefined") return false;
  return !cvFlowEligible(doc); // 有边/有阶段卡 → 走引擎;无边 → 本函数泳道回退
}
function bdFallbackLanes(doc) {
  const typed = !!cvTypeProfileOf(doc);
  const W = typed ? 228 : 208, H = typed ? 150 : 116, PAD = 14, HEAD = 42, TAIL = 12, ROW = 26, GAP = 40, MARGIN = 46;
  const groups = bdLaneGroups(doc);
  const pos = new Map(), size = new Map(), no = new Map(), laneOf = new Map(), lanes = [];
  let x = MARGIN, seq = 0;
  for (const g of groups) {
    g.ids.forEach((id, i) => {
      pos.set(id, { x: x + PAD, y: MARGIN + HEAD + i * (H + ROW) });
      size.set(id, { w: W, h: H });
      seq++;
      no.set(id, (seq < 10 ? "0" : "") + seq);
      laneOf.set(id, g.key);
    });
    const laneH = HEAD + g.ids.length * (H + ROW) - ROW + TAIL;
    const laneW = W + PAD * 2;
    lanes.push({ key: g.key, label: g.label, no: g.no, x: x, y: MARGIN, w: laneW, h: laneH, nodes: g.ids.slice() });
    x += laneW + GAP;
  }
  return {
    mode: "flow", pos: pos, size: size, lanes: lanes, laneOf: laneOf, no: no,
    mainNodes: new Set(), mainEdges: new Set(), backEdges: new Set(),
    mainPath: [], entry: null, exit: null, isolated: [], orphanCount: 0,
    bounds: { x: MARGIN, y: MARGIN, w: Math.max(0, x - MARGIN), h: 0 },
  };
}
function cvStructSig(doc, ro) {
 // fixH2:布局模式/是否走流动引擎进签名——切换「流动/紧凑」强制全量重渲(增量补丁不换布局);
 // group 是泳道分组依据,进签名(agent 补 group 后泳道框立即更新,不等结构变化)。
 // n1 白板可见化:accept(C0=无/P0/P1/P2)与 evidence(条数+通过数)进签名——
 // 证据回填后三态徽标/板头覆盖率必须立刻刷新,否则增量补丁把「未验证」永久钉在卡上。
 // 白板可见化:accept/evidence 进签名(证据回填后覆盖率/三态徽标必须立即刷新)。
 // 布局模式进签名:F=流动引擎/L=无边板泳道回退/C=旧分层(切换必须全量重渲,增量补丁不换布局)。
  const flowTag = cvFlowEligible(doc) ? "F" : bdLaneEligible(doc) ? "L" : "C";
 // w1/w2 视图态也进签名:写者过滤/泳道展开改变的是「画哪些节点 + 按哪个子集重排布局」,
 // 结构本身没变 → 不进签名就会被增量补丁当成同结构而**过滤不生效**(点了 chip 画面不动)。
  const wTag = (cvWriterOn ? "W" + [...cvWriterOn].sort().join(",") : "") + (cvFoldOpen.size ? "O" + [...cvFoldOpen].sort().join(",") : "");
 // B:boardType 进签名——design↔research 切换会增删「矩阵」入口,补丁路径必须走全量重建
 // UI 交互地图视图/标题进签名:切换交互↔结构、板标题/屏职责变化必须全量重建
 // (增量补丁只改卡片文本,不会换布局/换顶部图例)。
  let s = doc.taskId + "|" + (doc.docKind === "page" ? "P" : "") + (cvUiInfo ? "U" + cvUiMode : "u" + cvUiMode) + "|" + doc.title + "|" + flowTag + (ro ? "r" : "") + (boardEditOn ? "e" : "") + (boardCommentMode ? "m" : "") + "|" + (doc.boardType || "") + "|" + (doc.scale || "") + "|";
 // n2 评论徽标计数进签名:评论数变化必须走全量重建(增量补丁只改 .cv-cmts 文案不改处理器绑定,
 // 而「评 N」徽标现在是评论入口——徽标从隐藏变可见时必须有可点的 DOM 与处理器)。
 // 板型条:flow/before/targets 进签名——否则 agent 补分支/改前/目标后面板增量补丁不刷新节点条。
  for (const n of doc.nodes) s += n.id + "," + n.kind + "," + n.label + "," + n.change + "," + (n.group || "") + "," + (cvUiInfo ? (n.summary || "") : "") + "," + (n.symbolRef ? n.symbolRef.name : "") + "," + ((n.symbolRef && n.symbolRef.file) || n.fileRef || "") + "," + cvAccSig(n) + "," + (n.comments && n.comments.length ? n.comments.length : 0) + "," + JSON.stringify(n.flow || []) + "," + (n.before || "") + "," + ((n.targets || []).join("|")) + "," + JSON.stringify(n.accept || []) + ";";
  s += "#";
  for (const e of doc.edges) s += e.from + ">" + e.to + "," + e.kind + "," + (e.label || "") + (e.virtual ? ",v" : "") + ";";
 // 板级 P0 覆盖(节点 phase 变更/新增 P0 也要重渲板头)
  s += "@" + bdP0Stats(doc).passed + "/" + bdP0Stats(doc).total + "/" + bdP0Stats(doc).evidence;
  s += "%" + wTag;
  return s;
}
/** fixE5:纯规划板判定(docKind=page + status=draft + 全部节点 done=false)——server 侧已修
 * sha=null 不再误翻 done,这类板保持 draft;板头节点级「已落实 0/N」计数对纯规划板是实施语义噪音
 * (规划板节点是页面/区块,不存在「落实」进度)。仅显示层切换,不改协议不改板数据。 */
function bdPlanOnly(doc) {
  return !!(doc && doc.docKind === "page" && doc.status === "draft" && doc.nodes.length > 0 && doc.nodes.every((n) => !n.done));
}
/** fixE5:板头计数段——纯规划板显「规划 · N 节点」,其余(design/工作流/部分落实/done 板)保持「已落实 X/N」。 */
function bdCountSeg(doc) {
  return bdPlanOnly(doc)
    ? ' · <span class="bd-tag lk-moved" title="纯规划板:尚未开始实施">规划 · ' + doc.nodes.length + " 节点</span>"
    : " · 已落实 " + doc.nodes.filter((n) => n.done).length + "/" + doc.nodes.length;
}
/** 板头边计数:把系统推导的「同组次序」从显式边里拆出来(画布不画它们,旧口径 33 边会让人
 * 以为有 33 条设计关系)。显式 + 推导两个数都给出,和 board_upsert 回执口径一致。 */
function bdEdgeCountText(doc) {
  const derived = doc.edges.filter((e) => String(e.label || "") === "同组次序").length;
  const explicit = doc.edges.length - derived;
  return explicit + " 边" + (derived > 0 ? " + " + derived + " 推导" : "");
}
/** n1 白板执行期可见化:accept/evidence 三态判定(只读 BoardDoc 字段,语义对齐 board-accept.ts:
 * 通过=该条 cmd 有 ok=true 证据;未通过=有证据但无 ok=true;未验证=该 cmd 无任何证据)。
 * 前端独立实现而非 import 服务端模块:PAGE 是浏览器侧字符串模板,gateway 模块进不来。 */
function bdAccState(n, cmd) {
  const evs = n && Array.isArray(n.evidence) ? n.evidence : [];
  let hits = 0, okHit = false;
  for (const e of evs) { if (!e || e.cmd !== cmd) continue; hits++; if (e.ok === true) okHit = true; }
  if (okHit) return "pass";
  return hits ? "fail" : "none";
}
function bdAccStateCn(st) { return st === "pass" ? "通过" : st === "fail" ? "未通过" : "未验证"; }
function bdAccStateCls(st) { return st === "pass" ? "lk-linked" : st === "fail" ? "lk-broken" : "lk-moved"; }
/** 节点验收三态计数(accept 条目按 cmd 原文匹配证据,与 board-accept 同口径)。 */
function bdAccStats(n) {
  const accs = n && Array.isArray(n.accept) ? n.accept.filter((a) => a && typeof a.cmd === "string" && a.cmd.trim()) : [];
  const st = { total: accs.length, pass: 0, fail: 0, none: 0 };
  for (const a of accs) {
    const s = bdAccState(n, a.cmd);
    if (s === "pass") st.pass++; else if (s === "fail") st.fail++; else st.none++;
  }
  return st;
}
/** 板级 P0 覆盖:total=P0 节点数,passed=accept 全部通过的 P0 节点数,evidence=有 ok=true 证据的 accept 条数,
 * failed=未通过的 P0 节点数。无 P0 节点时 total=0(不显示门,纯探索板不受罚)。 */
function bdP0Stats(doc) {
  const nodes = (doc && Array.isArray(doc.nodes) ? doc.nodes : []).filter((n) => n && n.phase === "P0");
  let passed = 0, evidence = 0;
  for (const n of nodes) {
    const st = bdAccStats(n);
    evidence += st.pass;
    if (st.total > 0 && st.pass === st.total) passed++;
  }
  return { total: nodes.length, passed: passed, evidence: evidence, failed: nodes.length - passed };
}
/** 板头 P0/证据徽标:覆盖率<100% 醒目(赭红),100% 全绿;已 done 板再加「验收全绿」徽标。 */
function bdP0Tags(doc) {
  if (!doc) return "";
  const st = bdP0Stats(doc);
  if (!st.total) return "";
  const pct = Math.round((st.passed / st.total) * 100);
  const full = st.passed === st.total;
  let out = ' · <span class="bd-tag bd-p0' + (full ? " full" : " short") + '" title="P0 落目标覆盖率(全部 accept 有 ok=true 证据才算通过)">P0 ' +
    st.passed + "/" + st.total + "(" + pct + "%)</span>" +
    ' · <span class="bd-tag ' + (st.evidence > 0 ? "lk-linked" : "lk-moved") + '" title="已有 ok=true 证据的验收条数">证据 ' + st.evidence + "</span>";
  if (st.failed > 0) out += ' · <span class="bd-tag lk-broken" title="还没跑通验收的 P0 节点数">未通过 ' + st.failed + "</span>";
  if (full && doc.status === "done") out += ' · <span class="bd-tag bd-p0 full" title="已落实且 P0 验收全部通过">验收全绿 ' + ic("check") + "</span>";
  return out;
}
/** n2 节点卡紧凑验收行:画布卡只放三态计数(逐条明细在明细卡/节点卡清单)。 */
function bdAccInline(n) {
  const st = bdAccStats(n);
  if (!st.total) return "";
  const tone = st.pass === st.total ? "lk-linked" : st.fail ? "lk-broken" : "lk-moved";
 // f4 卡片头信息预算:文案「验收 x/y」→「验 x/y」(节点卡头宽 208px,徽标每省 2 字≈12px 全给标题);
 // 完整语义保留在 title。本函数同时用于主白板画布与档案「设计沉淀」只读画布(ppfModuleCanvas),两处同收益。
  return '<span class="bd-tag cv-acc ' + tone + '" title="验收 ' + st.total + " 条:通过 " + st.pass + " / 未通过 " + st.fail + " / 未验证 " + st.none + '">验 ' + st.pass + "/" + st.total + "</span>"; // cvAccSig 同源
}
/** n2 节点卡清单里的验收行:逐条 accept(cmd + expect + 三态徽标)+ 证据输出摘要(≤200 字,details 展开)。 */
function bdAccCardHtml(n) {
  const accs = n && Array.isArray(n.accept) ? n.accept.filter((a) => a && typeof a.cmd === "string" && a.cmd.trim()) : [];
  if (!accs.length) return "";
  const evs = n && Array.isArray(n.evidence) ? n.evidence : [];
  let h = '<div class="bd-acc-list">';
  for (const a of accs) {
    const st = bdAccState(n, a.cmd);
    const hit = evs.filter((e) => e && e.cmd === a.cmd);
    const out = hit.length ? String(hit[hit.length - 1].output || "") : "";
    const flat = out.split(String.fromCharCode(10)).join(" ").trim();
    h += '<div class="bd-acc-row"><span class="bd-tag ' + bdAccStateCls(st) + ' bd-acc-st">' + bdAccStateCn(st) + "</span>" +
      '<div class="bd-acc-cmd" title="' + esc(a.cmd) + '">' + esc(a.cmd) + "</div>" +
      (a.expect ? '<div class="bd-acc-exp">期望:' + esc(a.expect) + "</div>" : "") +
      (flat ? (flat.length > 200
        ? '<details class="bd-ev" data-det-key="' + esc("bdev:" + String(n.id || "") + ":" + a.cmd) + '"><summary>证据 ' + (hit[hit.length - 1].ok ? "ok" : "fail") + " · 输出 200/" + flat.length + ' 字</summary><div class="bd-ev-full">' + esc(flat) + "</div></details>"
        : '<div class="bd-acc-out">证据 ' + (hit[hit.length - 1].ok ? "ok" : "fail") + ":" + esc(flat) + "</div>")
        : "") +
      "</div>";
  }
  h += "</div>";
  return h;
}
/** n1/A3:节点卡清单泳道分组——有 group 按 group,否则按 kind 族兜底;编号按声明顺序(01..N)。
 * 复用画布泳道 CSS(.bd-grp 沿用 .cv-lane 的观感:左侧色条+编号+标题)。 */
function bdLaneGroups(doc) {
  const nodes = (doc && Array.isArray(doc.nodes)) ? doc.nodes : [];
  const groups = [];
  const byKey = new Map();
  for (const n of nodes) {
    const gk = String(n.group || "").trim() || ("kind:" + String(n.kind || "module"));
    let g = byKey.get(gk);
    if (!g) { g = { key: gk, label: gk.indexOf("kind:") === 0 ? (CV_KIND_NAME[String(n.kind)] || String(n.kind || "module")) : gk, ids: [] }; byKey.set(gk, g); groups.push(g); }
    g.ids.push(n.id);
  }
  groups.forEach((g, i) => { g.no = (i + 1 < 10 ? "0" : "") + (i + 1); });
  return groups;
}
/** n2 明细卡:accept 逐条(command + expect + 三态徽标)+ evidence 输出摘要(≤200 字,details 展开全文)。 */
function bdAccDetailHtml(n) {
  const accs = n && Array.isArray(n.accept) ? n.accept.filter((a) => a && typeof a.cmd === "string" && a.cmd.trim()) : [];
  const evs = n && Array.isArray(n.evidence) ? n.evidence : [];
  if (!accs.length && !evs.length) return "";
  let h = '<div class="bd-meta" style="margin-top:10px;color:var(--bronze)">验收契约(accept)<span class="bd-tag ' + (n.phase === "P0" ? "lk-broken" : "lk-moved") + '">' + esc(n.phase || "未标 P 级") + "</span></div>";
  if (!accs.length) h += '<div class="bd-meta">该节点未绑定验收(phase=P0 必须有 accept)</div>';
  for (const a of accs) {
    const st = bdAccState(n, a.cmd);
    const hit = evs.filter((e) => e && e.cmd === a.cmd);
    h += '<div class="bd-acc-row">' +
      '<span class="bd-tag ' + bdAccStateCls(st) + ' bd-acc-st">' + bdAccStateCn(st) + "</span>" +
      '<div class="bd-acc-cmd" title="' + esc(a.cmd) + '">' + esc(a.cmd) + "</div>" +
      (a.expect ? '<div class="bd-acc-exp">期望:' + esc(a.expect) + "</div>" : "") +
      (a.note ? '<div class="bd-acc-note">' + esc(a.note) + "</div>" : "");
    if (hit.length) {
 // 模板层纪律:PAGE 是 TS 模板字符串,反斜杠正则会下发即碎——零转义写法(换行→空格 + 连续空格折叠)
      const out = String(hit[hit.length - 1].output || "").split(String.fromCharCode(10)).join(" ").replace(/  +/g, " ").trim();
      if (out) {
        h += '<div class="bd-acc-out">' + (out.length > 200
          ? '<details class="bd-ev" data-det-key="' + esc("bdev:" + String(n.id || "") + ":" + a.cmd) + '"><summary>证据输出摘要(200/' + out.length + ' 字,点开看全文)</summary><div class="bd-ev-full">' + esc(out) + "</div></details>"
          : "证据输出:" + esc(out)) + "</div>";
      }
    }
    h += "</div>";
  }
 // 未对应任何 accept 的证据(agent 先回填后补 accept):照实列出,不静默丢
  const orphan = evs.filter((e) => e && !accs.some((a) => a.cmd === e.cmd));
  if (orphan.length) {
    h += '<div class="bd-meta" style="margin-top:6px">未绑定验收的证据 ' + orphan.length + " 条</div>";
    for (const e of orphan) h += '<div class="bd-acc-row"><span class="bd-tag ' + (e.ok ? "lk-linked" : "lk-broken") + '">' + (e.ok ? "ok" : "fail") + '</span><div class="bd-acc-cmd">' + esc(String(e.cmd || "")) + "</div></div>";
  }
  return h;
}
/** n10 明细卡「关系」段:选中节点此前只看到自己的 summary/流程/验收,看不到它在板上的连线——
 *。这里把 doc.edges 按 from(出边)/to(入边)两向列出来,每条给
 * 目标节点名(kind 中文名)+ 边 label 小字 + virtual 边的「推导」徽标;孤立节点明说(有用信息,不隐藏)。
 * 注意:边的关系类型(call/data/verify/nav/contains)与节点 kind(CV_KIND_NAME)是两套词表,不许混用。 */
const BD_REL_KIND_NAME = { call: "调用", data: "数据流", verify: "验收", nav: "次序", contains: "包含" };
function bdRelKindCn(k) { return BD_REL_KIND_NAME[k] || String(k || "") || "关联"; }
/** 纯函数(可单测):(doc, nodeId) → 关系段 HTML。找不到目标节点时回退显示 id(板数据自洽性不做静默吞)。 */
function bdRelHtml(doc, nodeId) {
  const d = doc || {};
  const id = String(nodeId || "");
  const nodes = Array.isArray(d.nodes) ? d.nodes : [];
  const edges = Array.isArray(d.edges) ? d.edges.filter((e) => e && typeof e === "object") : [];
  const labelOf = (nid) => { const t = nodes.find((x) => x && x.id === nid); return String((t && (t.label || t.id)) || nid); };
  const outs = edges.filter((e) => e.from === id);
  const ins = edges.filter((e) => e.to === id);
  const row = (e, dir) => '<div class="bd-rel-row">' +
    '<span class="bd-rel-arrow">' + (dir === "out" ? "→" : "←") + "</span>" +
    '<span class="bd-rel-t">' + esc(labelOf(dir === "out" ? e.to : e.from)) + "</span>" +
    '<span class="bd-rel-k">' + esc(bdRelKindCn(e.kind)) + "</span>" +
    (e.label ? '<span class="bd-rel-l">' + esc(String(e.label)) + "</span>" : "") +
    (e.virtual === true ? '<span class="bd-tag lk-moved bd-rel-v" title="自动推导待核实">推导</span>' : "") +
    "</div>";
  let h = '<div class="bd-meta" style="margin-top:10px;color:var(--bronze)">关系 · 出 ' + outs.length + " / 入 " + ins.length + "</div>";
  if (!outs.length && !ins.length) return h + '<div class="bd-meta">孤立节点(无连线)</div>';
  if (outs.length) h += '<div class="bd-rel-row"><span class="bd-rel-k">出边 ' + outs.length + "</span></div>" + outs.map((e) => row(e, "out")).join("");
  if (ins.length) h += '<div class="bd-rel-row"><span class="bd-rel-k">入边 ' + ins.length + "</span></div>" + ins.map((e) => row(e, "in")).join("");
  return h;
}
/** 板型画像(纯函数资产加载失败=null,旧渲染零回退风险)。 */
function cvTypeProfileOf(doc) {
  try { return typeof BoardTypeProfile !== "undefined" ? BoardTypeProfile.profileOf(doc) : null; } catch (e) { return null; }
}
/** 非 page 板顶部「板型画像」浮层:类型/规模/阶段覆盖/硬规则缺口。 */
function cvTypeHeadHtml(doc, info) {
  const p = cvTypeProfileOf(doc);
  if (!p) return "";
  let s = null;
  try { s = BoardTypeProfile.summaryOf(doc, info); } catch (e) { return ""; }
  if (!s) return "";
  const stages = (s.stages || []).map((st) =>
    '<span class="cv-type-stage' + (st.missing ? " missing" : "") + '" title="' + esc(st.hint || "") + '">' +
    '<b style="color:' + (st.missing ? "var(--bcv-wire-foot-fg,#8f8068)" : p.color) + '">' + st.count + "</b>" + esc(st.label) + (st.missing ? " 缺" : "") + "</span>").join("");
  const warns = [];
  if (s.scaleMissing) warns.push("规模未标");
  if (s.noBefore) warns.push(s.noBefore + " 节点缺改前");
  if (s.p0Bad) warns.push(s.p0Bad + " P0 验收缺项");
  if (s.verifyType && s.p0 && !s.p0Negative) warns.push("缺负面断言");
  if (s.unlabeledEdges) warns.push(s.unlabeledEdges + " 边缺 label");
  if (s.missing && s.missing.length) warns.push("缺 " + s.missing.length + " 段");
  const meta = [s.nodes + " 节点", s.edges + " 边", s.p0 ? "P0 " + s.p0 : "", s.branches ? "分支 " + s.branches : "", s.evidenceNodes ? "证据节点 " + s.evidenceNodes : ""].filter(Boolean).join(" · ");
  return '<div class="cv-type-head" data-btype="' + esc(s.boardType) + '" title="' + esc(p.edgeHint || "") + '">' +
    '<div class="cv-type-head-row"><span class="cv-type-badge" style="color:' + p.color + ';border-color:' + (p.colorHex || "#c9a25e") + '55">' +
    esc(p.icon + " " + p.label) + '</span><span class="cv-type-scale' + (s.scaleMissing ? " warn" : "") + '">' + esc(s.scale || "规模未标") + "</span>" +
    '<span class="cv-type-meta">' + esc(meta) + "</span>" +
    (warns.length ? '<span class="cv-type-warn" title="' + esc(warns.join("；")) + '">' + esc(warns.join(" · ")) + "</span>" : "") +
    '</div><div class="cv-type-stages">' + stages + "</div>" +
    '<div class="cv-type-rule" title="' + esc(p.edgeHint || "") + '">' + esc(p.rule) + "</div></div>";
}
/** 节点卡内的板型条:角色 chip + 硬规则徽标 + flow 关键步骤/if-else。 */
function cvTypeNodeHtml(n, doc, info) {
  const p = cvTypeProfileOf(doc);
  if (!p) return "";
  let badges = [], lines = [];
  try {
    badges = BoardTypeProfile.badgesOf(n, p, doc, (doc && doc.edges) || []);
    lines = BoardTypeProfile.flowLines(n, 2);
  } catch (e) { return ""; }
  const chips = (badges || []).map((b) =>
    '<span class="cv-type-chip t-' + esc(b.tone || "info") + '" title="' + esc(b.title || b.text) + '">' + esc(b.text) + "</span>").join("");
  const flow = (lines || []).length
    ? '<div class="cv-type-flow" title="' + esc(lines.join(" · ")) + '">' + esc(lines.join(" · ").slice(0, 72)) + "</div>"
    : "";
  if (!chips && !flow) return "";
  return (chips ? '<div class="cv-type-line">' + chips + "</div>" : "") + flow;
}
/** 工程师图形态:code 板节点按 C4 语义显示 [类型: 技术] + 职责。
 * summary 可用「[Component: TypeScript] 职责」显式声明;没写则按 kind 推断。
 * 零正则转义纪律:本文件在 PAGE 模板里,避免反斜杠转义被模板层吃掉。 */
function cvC4Info(n) {
  const raw = String((n && n.summary) || "");
  let type = "", tech = "", desc = raw;
  if (raw.charAt(0) === "[") {
    const close = raw.indexOf("]");
    if (close > 1) {
      const head = raw.slice(1, close);
      const colon = head.indexOf(":");
      if (colon >= 0) { type = head.slice(0, colon).trim(); tech = head.slice(colon + 1).trim(); }
      else type = head.trim();
      desc = raw.slice(close + 1).trim() || raw;
    }
  }
  const kind = String((n && n.kind) || "");
  if (!type) {
    const map = { module: "Container", function: "Component", tool: "External System", http: "External System", agent: "Person", io: "Store", decision: "Decision", start: "Start", end: "End", note: "Note", llm: "LLM", template: "Component", aggregate: "Aggregate", loop: "Loop", retrieval: "Store", classifier: "Decision" };
    type = map[kind] || "Component";
  }
  if (!tech) {
    const t = String(((n && n.targets) || []).join(" ")) + " " + raw + " " + String((n && n.before) || "");
    if (t.indexOf(".ts") >= 0 || t.indexOf("TypeScript") >= 0) tech = "TypeScript";
    else if (t.indexOf(".json") >= 0 || t.indexOf("JSON") >= 0) tech = "JSON";
    else if (t.indexOf("WebSocket") >= 0 || t.indexOf("WS ") >= 0 || t.indexOf(" ws@") >= 0) tech = "WebSocket";
    else if (t.indexOf(".md") >= 0) tech = "Markdown";
    else if (t.indexOf(".js") >= 0 || t.indexOf(".cjs") >= 0 || t.indexOf(".mjs") >= 0) tech = "JavaScript";
  }
  return { type: type || "Component", tech: tech || "", desc: desc || raw };
}
function cvC4Html(n) {
  const c = cvC4Info(n);
  const glyph = n && n.kind === "decision" ? "◇" : n && n.kind === "start" ? "▶" : n && n.kind === "end" ? "■" : n && n.kind === "agent" ? "●" : n && n.kind === "io" ? "▤" : n && n.kind === "tool" || n && n.kind === "http" ? "◈" : "▣";
  return '<div class="cv-c4-kind" title="C4: ' + esc(c.type) + (c.tech ? " / " + esc(c.tech) : "") + '">' +
    '<span class="cv-c4-glyph">' + glyph + '</span><span class="cv-c4-type">' + esc(c.type) + "</span>" +
    (c.tech ? '<span class="cv-c4-tech">' + esc(c.tech) + "</span>" : "") + "</div>";
}
/** code flow 代码框:把 flow 步骤按行渲染(示例图的伪代码块)。
 * 只取前 4 行、每行 58 字;branch 只展开 if(cond) + then 首行,else 详情交给菱形与边标签。 */
function cvCodeLines(n) {
  const out = [];
  const push = (s) => { if (out.length < 4 && s) out.push(String(s).slice(0, 58)); };
  const flow = Array.isArray(n && n.flow) ? n.flow : [];
  for (const st of flow) {
    if (out.length >= 4) break;
    if (!st) continue;
    if (st.type === "branch") {
      push("if (" + String(st.cond || "?") + ") {");
      const thenT = (Array.isArray(st.then) ? st.then : []).map((x) => x && x.text).filter(Boolean);
      if (thenT.length) push("  " + thenT[0]);
      push("} else { … }");
    } else if (st.type === "loop") {
      push("for (" + String(st.over || "?") + ") { … }");
    } else if (st.text) push(st.text);
  }
  return out;
}
/** code flow 卡片正文:C4 类型行 + 代码级步骤;没有 flow 时退回 summary 一行。 */
function cvCodeFlowBodyHtml(n, c4) {
 // 带 before 的卡多一行「现状」(见 cvBeforeHtml),代码行显示从 4 降到 3,
 // 代码框总高与卡高 176 都不变——before 不挤掉 flow 行,只是换一行的体积(cvCodeLines 的 4 行上限不动)。
  const lines = cvCodeLines(n).slice(0, cvBeforeHtml(n) ? 3 : 4);
  const c4h = c4 ? cvC4Html(n) : "";
  if (!lines.length) {
    const desc = String(c4 ? c4.desc : n.summary || "");
    return c4h + '<div class="cv-sum" title="' + esc(desc) + '">' + esc(desc.slice(0, 96)) + "</div>";
  }
  return c4h + '<div class="cv-code-lines" title="' + esc(lines.join(" / ")) + '">' +
    lines.map((s) => '<div class="cv-cl">' + esc(s) + "</div>").join("") + "</div>";
}
/** code 板「想画流程图」判定(与 assets/board-type-profile.js 的 codeFlowWanted 同口径,
 * 两处必须一起改):①有 start/end(planner 明确画流程) ②有 decision 节点 ③步骤节点里 ≥50% 带 flow 行。
 * 变更契约板(基线容器+变更卡,flow 全空)三条都不满足 → 布局/画像行为逐字不变。
 * perf 板复用同一口径(性能优化板有 start/end/decision/带 flow 的步骤 → 同样进 code flow 布局与画像)。 */
function cvCodeFlowWanted(nodes) {
  const ns = Array.isArray(nodes) ? nodes.filter((n) => !!n) : [];
  if (!ns.length) return false;
  if (ns.some((n) => n.kind === "start" || n.kind === "end")) return true;
  if (ns.some((n) => n.kind === "decision")) return true;
  const steps = ns.filter((n) => n.kind !== "start" && n.kind !== "end" && n.kind !== "decision");
  if (!steps.length) return false;
  const withFlow = steps.filter((n) => Array.isArray(n.flow) && n.flow.length > 0).length;
  return withFlow * 2 >= steps.length;
}
/** 仓库关系上屏:targets 里的文件路径压成可读短名(末尾两段),太长省略中间。 */
function cvFileNameOf(t) {
  var s = String(t == null ? "" : t);
  var BS = String.fromCharCode(92);
  if (s.indexOf(BS) >= 0) s = s.split(BS).join("/");
  while (s.indexOf("./") === 0) s = s.slice(2);
  while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.slice(0, -1);
  if (!s) return "";
  const segs = s.split("/").filter((x) => !!x);
  const short = segs.length >= 2 ? segs[segs.length - 2] + "/" + segs[segs.length - 1] : (segs[0] || "");
  if (short.length <= 34) return short;
  return short.slice(0, 12) + "…" + short.slice(-21);
}
/** modify/delete 节点在 code flow 卡上
 * 多出的一行「现状:<before>」——「改这里」而不是「计划」。只渲 1 行、≤48 字,超长省略;
 * keep/add 不显示(没有「现状」),无 before 返回空串。零正则转义:空白折叠走逐字符判断。 */
function cvBeforeHtml(n) {
  const chg = String(n && n.change ? n.change : "");
  if (chg !== "modify" && chg !== "delete") return "";
  const raw = String(n && n.before ? n.before : "");
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 10 || c === 13 || c === 9 || c === 32) { if (s.length && s.charAt(s.length - 1) !== " ") s += " "; }
    else s += raw.charAt(i);
  }
  s = s.trim();
  if (!s) return "";
  const cut = s.length > 48 ? s.slice(0, 47) + "…" : s;
  return '<div class="cv-before" title="现状:' + esc(s) + '">现状:' + esc(cut) + "</div>";
}
/** code flow 卡脚「与已有仓库代码的关系」:targets 文件名 + 变更徽标。
 * 只出 2 个(176 高卡脚只有一行),余量给 +N;没有 targets 返回空串(调用方退回原有卡脚)。 */
function cvFileFootHtml(n) {
  const ts = (Array.isArray(n && n.targets) ? n.targets : []).map((x) => String(x == null ? "" : x).trim()).filter((x) => !!x);
 // 「看得懂」:只有 targets 文件名时读不出「改哪个符号、哪一行」——把结构化锚 symbolRef
 // 也渲成 chip(name@basename:line)。targets 最多 2 个、symbolRef 最多 1 个,余量沿用 .cv-file-more。
  const sr = n && n.symbolRef && (n.symbolRef.name || n.symbolRef.file) ? n.symbolRef : null;
  if (!ts.length && !sr) return "";
  const shown = ts.slice(0, 2);
 // 可读性:两个文件名之间给可见分隔符(+ flex gap),原来两 chip 只有 5px 缝,经验证读成「a.tsb.ts」
  const tChips = shown.map((t) => '<span class="cv-file-name" data-cvfile="' + esc(t) + '" title="' + esc(cvTargetTitle(t, n)) + '">' + esc(cvFileNameOf(t)) + "</span>").join('<i class="cv-file-sep">·</i>');
  let symChip = "";
  if (sr) {
    const nm = String(sr.name || "").trim();
    const fl = String(sr.file || "").trim();
    const ln = sr.line != null && sr.line !== "" ? ":" + sr.line : "";
    const base = fl ? cvFileBaseOf(fl) : "";
    symChip = '<span class="cv-sym-name" data-cvsym="' + esc(nm) + '" title="' + esc((fl || "?") + ln + (nm ? " · " + nm : "")) + '">' +
      esc((nm || base) + (base ? "@" + base : "") + ln) + "</span>";
  }
  return '<div class="cv-file-foot" title="' + esc(ts.map((t) => cvTargetTitle(t, n)).join(" · ") || (sr ? String(sr.file || "") + (sr.line != null ? ":" + sr.line : "") + (sr.name ? " · " + sr.name : "") : "")) + '">' +
    tChips + (tChips && symChip ? '<i class="cv-file-sep">·</i>' : "") + symChip +
    (ts.length > shown.length ? '<em class="cv-file-more">+' + (ts.length - shown.length) + "</em>" : "") +
    cvChangeBadge(n, "cv-chg") + "</div>";
}
/** targets 条目的悬浮全文:带 # 符号的如实给「路径#符号」(不编造行号);与 symbolRef
 * 同文件时补「:行号」;两者都不适用就只给原路径。 */
function cvTargetTitle(t, n) {
  const raw = String(t == null ? "" : t).trim();
  if (raw.indexOf("#") >= 0) return raw;
  const sr = n && n.symbolRef ? n.symbolRef : null;
  if (sr && sr.file && String(sr.file).trim() === raw && sr.line != null && sr.line !== "") return raw + ":" + sr.line;
  return raw;
}
/** 路径 → 末段文件名(symbolRef chip 的 basename 位;cvFileNameOf 给的是末两段,chip 里要短)。 */
function cvFileBaseOf(t) {
  const s = String(t == null ? "" : t);
  const segs = s.split("/").filter((x) => !!x);
  return segs.length ? segs[segs.length - 1] : "";
}
/** code flow 卡上的变更徽标文案:用 CV_CHG_LABEL(keep=复用),不用面板通用的「涉及」。
 * 只被 code flow 用(卡脚 .cv-file-foot / start-end 药丸 / decision 菱形),无其它调用方。
 * 续:药丸/菱形代表流程控制点(触发/判断/出口),change=keep 的「复用」挂上去是纯噪音
 * (经验证 start 药丸顶着「复用」,读者以为触发点被改动);这两处只在 add/modify/delete 时出徽标。 */
function cvChangeBadge(n, extra, ctrlOnly) {
  const k = n && n.change && CV_CHG_LABEL[n.change] ? n.change : "";
  if (!k) return "";
  if (ctrlOnly && k === "keep") return "";
  return '<span class="bd-tag ' + k + (extra ? " " + extra : "") + '" title="变更:' + esc(CV_CHG_LABEL[k]) + '">' + esc(CV_CHG_LABEL[k]) + "</span>";
}
/** 验收/测试/风险/回滚不进主架构图:放右侧栏,主图只留工程师要看的架构与数据流。 */
function cvCodeSide(n) {
  const s = String((n && n.label) || "") + " " + String((n && n.group) || "") + " " + String((n && n.summary) || "");
  return ["根因", "影响面", "影响", "验收", "冒烟", "负面", "回归", "测试", "风险", "回滚", "accept", "smoke", "test", "risk", "rollback"].some((k) => s.indexOf(k) >= 0);
}
/** 测试文件卡=关联测试锚点,不是控制流:targets/symbolRef.file/fileRef 任一路径落在
 * test|tests|__tests__ 目录或 *.test/*.spec.* 上,且本卡没有真实函数调用形(flow 空、或 flow 行
 * 都不是「裸调用标题」如 runSuite(name))=画的是「这条测试覆盖什么」而不是控制流本身 → 剥到右侧栏。
 * 断言式行(expect(a).toBe(1)/assert.ok(x))仍算锚点:那是测试自身口吻,不是被测函数的控制流。
 * 只承认 function/module/io/tool(流程三态与 note/aggregate 另有规则);路径归一走字符比较,
 * 不用正则转义(本文件是模板字面量,反斜杠层层转义易错)。 */
function cvCodeFlowTestAnchor(n) {
  if (!n) return false;
  const k = n.kind;
  if (k !== "function" && k !== "module" && k !== "io" && k !== "tool") return false;
  const BS = String.fromCharCode(92);
  const norm = (t) => {
    let s = String(t == null ? "" : t);
    if (s.indexOf(BS) >= 0) s = s.split(BS).join("/");
    while (s.indexOf("./") === 0) s = s.slice(2);
    return s;
  };
  const isTestPath = (t) => {
    const s = norm(t);
    if (!s) return false;
    const segs = s.split("/").filter(Boolean);
    for (let i = 0; i < segs.length - 1; i++) {
      const g = segs[i];
      if (g === "test" || g === "tests" || g === "__tests__") return true;
    }
    const base = segs.length ? segs[segs.length - 1] : "";
    for (const ext of [".test.js", ".test.jsx", ".test.ts", ".test.tsx", ".test.mjs", ".test.cjs", ".test.mts", ".test.cts",
      ".spec.js", ".spec.jsx", ".spec.ts", ".spec.tsx", ".spec.mjs", ".spec.cjs", ".spec.mts", ".spec.cts"]) {
      if (base.length > ext.length && base.slice(base.length - ext.length) === ext) return true;
    }
    return false;
  };
  const paths = [];
  if (Array.isArray(n.targets)) for (const t of n.targets) paths.push(t);
  if (n.symbolRef && n.symbolRef.file) paths.push(n.symbolRef.file);
  if (n.fileRef) paths.push(n.fileRef);
  if (!paths.some(isTestPath)) return false;
  const flow = Array.isArray(n.flow) ? n.flow : [];
  const ASSERT_HEAD = ["expect", "assert", "describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll", "vi", "jest"];
  for (const st of flow) {
    if (!st) continue;
    const txt = String(st.text || "") + " " + String(st.cond || "") + " " + String(st.over || "");
    const i = txt.indexOf("(");
    if (i < 0) continue; // 无调用形 → 仍是锚点
 // 取调用名:前一段标识符(允许 a.b 成员访问只看最后一段)
    let j = i - 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(txt.charAt(j))) j--;
    const name = txt.slice(j + 1, i);
    if (!name) continue;
    if (ASSERT_HEAD.indexOf(name) >= 0) continue; // 断言/套件口吻,不是被测逻辑
    return false; // 真实函数调用形 → 画的是被测逻辑本身,留在主图
  }
  return true;
}
/** flow 板的侧栏判定要更窄:start/end/decision 永远是流程节点(「安装回滚」end 不能被
 * 「回滚」字面剥离,否则 decision 的否分支会整条消失);只有 note/aggregate/io 且带侧栏词才剥离。
 * 增:测试文件锚点(function/module/io/tool + 测试路径 + 无调用形 flow)也剥到侧栏。 */
function cvCodeFlowSide(n) {
  if (!n) return false;
  const k = n.kind;
  if (k === "start" || k === "end" || k === "decision") return false;
  if (cvCodeFlowTestAnchor(n)) return true;
  if (k !== "note" && k !== "aggregate" && k !== "io") return false;
  const s = String(n.label || "") + " " + String(n.group || "") + " " + String(n.summary || "");
  return ["根因", "影响面", "影响", "验收", "冒烟", "负面", "回归", "测试", "风险", "回滚", "accept", "smoke", "test", "risk", "rollback"].some((x) => s.indexOf(x) >= 0);
}
function cvCodeSideHtml(nodes) {
  const card = (n) => {
    const c = cvC4Info(n);
    const acc = (n.accept || []).slice(0, 3).map((a) => '<span class="cside-ac">' + esc(a.type || "accept") + "</span>").join("");
    return '<div class="cv-code-side-card"><div class="cv-code-side-h"><b>' + esc(n.label) + "</b><span>" + esc(c.type) +
      (n.phase ? " · " + esc(n.phase) : "") + '</span></div><p>' + esc(c.desc.slice(0, 150)) + "</p>" +
      (acc ? '<div class="cv-code-side-acc">' + acc + "<i>" + (n.accept || []).length + " 条验收</i></div>" : "") + "</div>";
  };
  const groups = [{ label: "根因判定", items: [] }, { label: "现状细节", items: [] }, { label: "验收 / 风险 / 测试", items: [] }];
  for (const n of nodes || []) {
    if (/根因/.test(String(n.label || ""))) groups[0].items.push(n);
    else if (cvCodeSide(n)) groups[2].items.push(n);
    else groups[1].items.push(n);
  }
  const body = groups.filter((g) => g.items.length).map((g) =>
    '<div class="cv-code-side-sec"><div class="cv-code-side-sec-h">' + g.label + " <b>" + g.items.length + "</b></div>" +
    g.items.map(card).join("") + "</div>").join("");
  return '<details class="cv-code-side"><summary class="cv-code-side-title">侧栏明细 <b>' +
    nodes.length + '</b><span>根因 / 现状 / 验收</span></summary>' + body + "</details>";
}
/** 「白板看得懂」层/锚统计(纯函数,可单测):
 * 口径(与产品口径一致,全在渲染层算,不读盘上任何字段):
 * · 排除 ph-*(阶段卡)与 __cv_current(现状基线合成节点)——它们是渲染层产物,不是板上的设计节点;
 * · 现状 N = change==="keep" 或 change 缺失;变更 M = change ∈ {add,modify,delete};
 * · 代码锚 K/N = targets 非空 或 symbolRef 存在的节点 / 总节点。 */
function cvLayerStats(doc) {
  const ns = ((doc && Array.isArray(doc.nodes)) ? doc.nodes : []).filter((n) => n && !/^ph-/.test(String(n.id)) && String(n.id) !== "__cv_current");
  let keepN = 0, chgN = 0, anchorN = 0;
  for (const n of ns) {
    const c = String(n.change == null ? "" : n.change);
    if (c === "add" || c === "modify" || c === "delete") chgN++;
    else if (c === "keep" || c === "") keepN++;
    const hasT = Array.isArray(n.targets) && n.targets.length > 0;
    const hasS = !!(n.symbolRef && (n.symbolRef.name || n.symbolRef.file));
    if (hasT || hasS) anchorN++;
  }
  return { keep: keepN, chg: chgN, anchor: anchorN, total: ns.length };
}
/** 层判定只在 code/test/perf/refactor 板出(其它板型「现状/变更」两组标签会被误读)。 */
function cvLayerAvail(doc) {
  const t = String(doc && doc.boardType ? doc.boardType : "");
  return t === "code" || t === "test" || t === "perf" || t === "refactor";
}
/** 节点属于哪一层:"chg"=变更层(change∈{add,modify,delete}),其余算现状层。 */
function cvLayerOf(n) {
  const c = String(n && n.change != null ? n.change : "");
  return c === "add" || c === "modify" || c === "delete" ? "chg" : "keep";
}
/** 主题节点判定(id 以 theme 开头不区分大小写,或 group 含「主题」)。
 * 只用于 code 系板(渲染层把主题渲染成横贯板首的横幅),不改板上任何数据。 */
function cvThemeNodeOf(n) {
  if (!n) return false;
  const id = String(n.id || "");
  if (/^theme/i.test(id)) return true;
  return String(n.group || "").indexOf("主题") >= 0;
}
/** 主题横幅(横贯板首):浮在画布顶部,不占布局位、不参与连线、不进适配包围盒 ——
 * label + summary(2 行截断);板上没有主题节点时返回空串(旧板不破)。 */
function cvThemeBandHtml(doc) {
  const ns = ((doc && Array.isArray(doc.nodes)) ? doc.nodes : []).filter((n) => n && cvThemeNodeOf(n));
  if (!ns.length) return "";
  const n = ns[0];
  const more = ns.length > 1 ? " · 另 " + (ns.length - 1) + " 个主题节点" : "";
  const sum = String(n.summary || "");
  return '<div class="cv-theme-band" id="cvThemeBand" title="' + esc("主题(" + n.id + ")" + (sum ? " · " + sum : "")) + '">' +
    '<b>' + (n.done ? ic("check") + " " : "") + esc(String(n.label || "主题")) + "</b>" +
    (sum ? "<span>" + esc(sum) + "</span>" : "") + (more ? "<span>" + esc(more) + "</span>" : "") + "</div>";
}
/** 板头统计段「现状 N · 变更 M · 代码锚 K/N」(给 title 解释三项含义)。 */
function cvLayerMetaHtml(doc) {
  const st = cvLayerStats(doc);
  if (!st.total) return "";
  return ' · <span class="bd-tag cv-laystat" title="现状 N=没被改动的设计节点;变更 M=新增/修改/删除的节点;代码锚 K/N=带结构化代码锚(targets 文件或 symbolRef 符号+行号)的节点 / 板上设计节点总数(不含阶段卡与现状基线合成节点)">现状 ' + st.keep +
    " · 变更 " + st.chg + " · 代码锚 " + st.anchor + "/" + st.total + "</span>";
}
/** 层高亮的 DOM 落地(纯 classList,不重渲):cards 模式按 data-cv 找节点卡,svg 模式按 data-node-id 找 <g>。
 * 节点属于哪一层由当前 cvActiveDoc 的数据算(与渲染时同一个 cvLayerOf 口径)。 */
function cvLayerPaint() {
  const h = cvHostEl();
  const doc = cvActiveDoc;
  if (!h || !doc) return;
  const on = cvLayerAvail(doc) && cvLayerOn ? cvLayerOn : "";
  const byId = new Map();
  for (const n of (doc.nodes || [])) if (n) byId.set(String(n.id), n);
  const paint = (el, id) => {
    if (!el || !el.classList) return;
    const n = byId.get(String(id || ""));
    const hit = !!on && n && cvLayerOf(n) === on;
    const miss = !!on && n && cvLayerOf(n) !== on;
    el.classList.toggle("cv-layer-on", hit);
    el.classList.toggle("cv-layer-dim", miss);
  };
  for (const el of h.querySelectorAll(".cv-node[data-cv]")) paint(el, el.getAttribute("data-cv"));
  for (const el of h.querySelectorAll("#cvSvgHost [data-node-id]")) paint(el, el.getAttribute("data-node-id"));
}
/** 画布左上层 chip(点击=只高亮该层;再点取消)。仅 code/test/perf/refactor 板出。 */
function cvLayerChipsHtml(doc) {
  if (!cvLayerAvail(doc)) return "";
  const st = cvLayerStats(doc);
  if (!st.total) return "";
  const chip = (k, label, n) => '<span class="cv-wchip cv-laychip' + (cvLayerOn === k ? " on" : "") + '" data-cvlay="' + k + '" title="' + (cvLayerOn === k ? "再点一次取消高亮,显示全部" : "只高亮" + label + "(" + n + " 个节点);再点一次取消") + '">' + label + " " + n + "</span>";
  return chip("keep", "现状层", st.keep) + chip("chg", "变更层", st.chg);
}
function cvMetaHtml(doc, ro) {
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
  const kindTag = doc.docKind === "workflow" ? ' · <span class="bd-tag lk-linked">工作流板</span>' : doc.docKind === "page" ? ' · <span class="bd-tag lk-moved">页面结构板</span>' : "";
  const wfRun = wfRuns[doc.taskId];
  const runTag = doc.docKind === "workflow" && wfRun
    ? ' · <span class="bd-tag ' + (wfRun.done ? (wfRun.ok ? "lk-linked" : "lk-broken") : "lk-moved") + '">' + (wfRun.done ? (wfRun.ok ? "上次运行完成" : "上次运行失败") : "运行中") + (wfRun.states ? " " + Object.keys(wfRun.states).length + " 节点" : "") + "</span>"
    : "";
  return "「" + esc(doc.title) + "」 " + (boardEditOn ? "编辑中(未保存)" : doc.status === "draft" ? "设计稿" : doc.status === "implementing" ? "实施中" : "已落实") + " · rev " + doc.rev + " · " + doc.nodes.length + " 节点/" + bdEdgeCountText(doc) + bdCountSeg(doc) + kindTag + recon + runTag + bdP0Tags(doc) + cvLayerMetaHtml(doc) + (boardItems.length >= 2 ? ' · <span class="bd-tag" title="本会话共有 ' + boardItems.length + ' 块白板;选择器里可切换">共 ' + boardItems.length + " 块板</span>" : "") + (ro ? ' · <span class="bd-tag lk-linked">设计沉淀 · 只读</span>' : "");
}
/** 板型头 + 主题横幅 + 写者条 + 层 chip 的纵向堆叠(经验证遮挡修复)。
 * 四者都是画布内的绝对定位浮层,高度随板型/内容变化(板型头 40~70px、主题横幅 30~40px、写者条 26px),
 * 写死像素必然在某些板上互相压住(经验证 tasksm 板层 chip 压住板型头)。做法:按 DOM 顺序从 baseTop 起
 * 逐条「量实际高 → 下一条 = 上一条底 + 6px」;display:none 的跳过。纯后置调整,不改任何布局/连线。 */
function cvStackTopBars(host) {
  if (!host) return;
  const bars = [host.querySelector(".cv-type-head"), host.querySelector(".cv-theme-band"), host.querySelector("#cvWbar"), host.querySelector("#cvLbar")].filter((el) => !!el);
  let top = 8;
  for (const el of bars) {
    const h = el.offsetHeight || 0;
    if (!h) continue; // 隐藏/零高:不占位,也不推进游标
    el.style.top = top + "px";
    top += h + 6;
  }
}
function cvPatchCanvas(host, doc, pos, ro, roLinks) {
  const world = host.querySelector(".bf-cv-world");
  const cvH = host.querySelector("#cvHost") || host.querySelector(".bf-canvas");
  if (!world || !cvH) return false;
  try {
 // 节点元素按 data-cv 全等匹配(dataset 通道,不拼选择器——agent 板节点 id 可含选择器特殊字符)
    const els = world.querySelectorAll(".cv-node");
    const byId = new Map();
    for (const el of els) byId.set(el.dataset.cv, el);
    for (const n of doc.nodes) {
      const el = byId.get(n.id);
      if (!el) return false;
      const p = pos.get(n.id);
      if (p) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; }
      if (cvUiInfo && n.kind === "page") {
        const cap = world.querySelector('.cv-ui-cap[data-uicap="' + cssEsc(n.id) + '"]');
        if (cap && p) { cap.style.left = p.x + "px"; cap.style.top = (p.y - CV_UI_CAP_H + CV_UI_CAP_PAD) + "px"; }
        const capDone = cap && cap.querySelector(".cv-done");
        if (capDone) capDone.innerHTML = n.done ? ic("check") + " " : "";
      }
      const dn = el.querySelector(".cv-done");
      if (dn) dn.innerHTML = n.done ? ic("check") + " " : "";
      const sm = el.querySelector(".cv-sum");
      if (sm) sm.textContent = String(n.summary || "").slice(0, 64);
      const lk = ro ? ((roLinks || []).find((l) => l.nodeId === n.id) || null) : (boardEditOn ? null : bdLinkOf(n.id));
      const dot = el.querySelector(".cv-dot");
      if (dot) { dot.className = "cv-dot " + (lk ? lk.state : "none"); dot.title = lk ? (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") : "无代码连接"; }
      const fc = el.querySelector(".cv-file");
      if (fc) {
        const fp = (n.symbolRef && n.symbolRef.file) || n.fileRef || "";
        fc.textContent = String(fp).split("/").slice(-1)[0] + (lk && lk.line ? ":" + lk.line : "");
      }
      const cm = el.querySelector(".cv-cmts");
      if (cm) { const cnt = n.comments && n.comments.length || 0; cm.textContent = "评 " + cnt; cm.style.display = cnt ? "" : "none"; }
 // n1:验收三态徽标原位更新(结构签名已含 accept/evidence,这里只兜住同签名内的文案更新)
      const accEl = el.querySelector(".cv-acc");
      if (accEl) {
        const as = bdAccStats(n);
        if (!as.total) accEl.style.display = "none";
        else {
          accEl.style.display = "";
          accEl.className = "bd-tag cv-acc " + (as.pass === as.total ? "lk-linked" : as.fail ? "lk-broken" : "lk-moved");
          accEl.textContent = "验 " + as.pass + "/" + as.total; // f4:与 bdAccInline 同文案(卡片头信息预算)
          accEl.title = "验收 " + as.total + " 条:通过 " + as.pass + " / 未通过 " + as.fail + " / 未验证 " + as.none;
        }
      }
    }
  } catch (e) { return false; }
  cvRedrawEdges(host, doc, pos); // 边几何(位置可能变);与拖拽同链
  const meta = cvH.querySelector(".bd-meta");
  if (meta) meta.innerHTML = cvMetaHtml(doc, ro);
  if (typeof cvDrawMini === "function") cvDrawMini(host, doc, pos);
  return true;
}
// ---- B:research 板「决策矩阵」视图(纯函数 + 表格渲染,零协议/零板数据改动) ----
// 数据来源只读现有 BoardDoc:
// · 候选 = label 以「候选」开头 / group 含「候选」/ flow 步骤里带 ≥2 个维度前缀的节点(旧板兜底);
// · 维度 = 固定五维(成本/风险/可维护性/可测试性/证据),单元格文本优先取 flow 步骤「成本:…」式前缀,
// 其次取 summary 分号段(「成本0;风险…;证据…」是 research 板的既有写法);
// · 矩阵/结论节点(mx-matrix、kind=decision、label「结论」)只作表头注脚,不参与候选行。
// 无候选/无维度文本 → ok:false 或 hint 文案,渲染层给提示,不抛错、不改盘上数据。
const BD_MX_DIMS = [
  { key: "cost", label: "成本", aliases: ["成本", "代价"] },
  { key: "risk", label: "风险", aliases: ["风险", "隐患"] },
  { key: "maint", label: "可维护性", aliases: ["可维护性", "可维护", "维护"] },
  { key: "test", label: "可测试性", aliases: ["可测试性", "可测性", "测试性", "可测"] },
  { key: "evidence", label: "证据", aliases: ["证据", "依据"] },
];
/** 去前导分隔符(冒号/破折号/空格等)。模板层纪律:不用反斜杠正则(会被模板吃掉)。 */
function bdMxStripLead(t) {
 // 模板层纪律:内联脚本里的制表/换行转义会被 PAGE 模板吃掉成真字符 → 用 charCode 拼
  const seps = " " + String.fromCharCode(9, 10, 13) + ":：-—=·、|";
  let i = 0;
  while (i < t.length && seps.indexOf(t.charAt(i)) >= 0) i++;
  return t.slice(i);
}
/** 按任一字符切段(替代 split 正则;空段丢弃)。 */
function bdMxSplitAny(s, chars) {
  const out = [];
  let cur = "";
  for (const ch of String(s == null ? "" : s)) {
    if (chars.indexOf(ch) >= 0) { if (cur.trim()) out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** flow 递归展平为文本串(branch/loop 的 then/else/body 都算)。 */
function bdMxFlowTexts(flow, out) {
  const list = flow || [];
  for (const st of list) {
    if (st && typeof st.text === "string" && st.text.trim()) out.push(st.text);
    for (const kid of [st && st.then, st && st.else, st && st.body]) if (kid && kid.length) bdMxFlowTexts(kid, out);
  }
  return out;
}
/** 一句文本 → {key, text}(前缀命中维度别名且余下有内容才算;否则 null)。 */
function bdMxCellOf(text) {
  const t = String(text == null ? "" : text).trim();
  for (const d of BD_MX_DIMS) {
    for (const a of d.aliases) {
      if (t.slice(0, a.length) === a) {
        const rest = bdMxStripLead(t.slice(a.length)).trim();
        if (rest) return { key: d.key, text: rest };
      }
    }
  }
  return null;
}
/** research 板决策矩阵数据(纯函数,可单测):候选行 × 五维 + 结论/矩阵注脚。 */
function researchMatrixRows(doc) {
  const nodes = (doc && doc.nodes) || [];
 /** 维度权重(硬规则:权重可见、可复算):文本里「成本 30%」「风险:25%」都认。 */
  const weightsOf = (text) => {
    const out = {};
    const t = String(text || "");
    for (const d of BD_MX_DIMS) {
      for (const a of d.aliases) {
        let from = 0;
        for (;;) {
          const i = t.indexOf(a, from);
          if (i < 0) break;
          const tail = t.slice(i + a.length, i + a.length + 18);
          const m = /(?:权重)?[^0-9%]*(\\d+(?:\\.\\d+)?)\\s*%/.exec(tail);
          if (m) { out[d.key] = Number(m[1]); break; }
          from = i + a.length;
        }
        if (out[d.key] != null) break;
      }
    }
    return out;
  };
 /** 证据可信度:单元格写 [高]/[中]/[低] 或「置信:高」。 */
  const confidenceOf = (text) => {
    const t = String(text || "");
    const m = /\\[(高|中|低)\\]/.exec(t) || /[（(【](高|中|低)[）)】]/.exec(t) || /置信(?:度)?\\s*[:：]\\s*(高|中|低)/.exec(t);
    return m ? m[1] : "";
  };
  const isCand = (n) => {
    if (!n || !n.id) return false;
    const id = String(n.id);
    const label = String(n.label || "");
    const group = String(n.group || "");
    if (id === "mx-matrix" || id === "mx-verdict") return false;
    if (id.indexOf("mx-") === 0 && label.indexOf("候选") < 0) return false;
    if (label.indexOf("决策矩阵") >= 0) return false;
    if (label.indexOf("候选") === 0) return true;
    if (group.indexOf("候选") >= 0) return true;
 // 兜底(旧板没写「候选」):flow 里带 ≥2 个维度前缀
    let hits = 0;
    for (const t of bdMxFlowTexts(n.flow || [], [])) if (bdMxCellOf(t)) hits++;
    return hits >= 2;
  };
  const rows = [];
  let filled = 0;
  for (const n of nodes) {
    if (!isCand(n)) continue;
    const cells = {};
 // ① flow 优先(结构化步骤,证据更精确);② summary 分号段兜底(research 板常见一行摘要)
    for (const t of bdMxFlowTexts(n.flow || [], [])) {
      const hit = bdMxCellOf(t);
      if (hit && !cells[hit.key]) cells[hit.key] = { text: hit.text, source: "flow", confidence: confidenceOf(hit.text) };
    }
    for (const seg of bdMxSplitAny(n.summary || "", ";；|")) {
      const hit = bdMxCellOf(seg);
      if (hit && !cells[hit.key]) cells[hit.key] = { text: hit.text, source: "summary", confidence: confidenceOf(hit.text) };
    }
    let cellCount = 0;
    for (const d of BD_MX_DIMS) if (cells[d.key]) cellCount++;
    filled += cellCount;
    rows.push({ id: String(n.id), label: String(n.label || n.id), summary: String(n.summary || ""), cells, cellCount });
  }
  let matrix = null, conclusion = null;
  for (const n of nodes) {
    if (!n || !n.id) continue;
    const id = String(n.id), label = String(n.label || "");
    if (!matrix && (id.indexOf("mx-matrix") === 0 || label.indexOf("决策矩阵") >= 0)) matrix = { id, label, summary: String(n.summary || ""), flow: n.flow || [] };
    if (!conclusion && (n.kind === "decision" || label.indexOf("结论") === 0 || id.indexOf("mx-verdict") === 0)) conclusion = { id, label, summary: String(n.summary || "") };
  }
  const weightText = matrix
    ? [matrix.label, matrix.summary].concat(bdMxFlowTexts(matrix.flow || [], [])).join(" ")
    : "";
  const weights = weightsOf(weightText);
  const weightsKnown = Object.keys(weights).length;
  const hint = !rows.length
    ? "未识别到候选节点——把候选写成 label 以「候选」开头(或 group 含「候选」),并在 flow 步骤里写「成本:…」「风险:…」即可自动成表。当前仍可返回画布查看原板。"
    : (filled === 0 ? "候选节点没有可识别的维度文本——在 flow 步骤里写「成本:…」「风险:…」「可维护性:…」「可测试性:…」「证据:…」即可自动成表。当前仍可返回画布查看原板。" : "");
  return {
    ok: rows.length > 0,
    candidates: rows,
    dims: BD_MX_DIMS.map((d) => ({ key: d.key, label: d.label, weight: weights[d.key] || null })),
    weightsKnown: weightsKnown,
    matrix: matrix,
    conclusion: conclusion,
    filled: filled,
    hint: hint,
  };
}
/** research 矩阵表格视图(替换画布渲染;只在 boardType=research 且用户点了「矩阵」时进入)。
 * 单元格点选=选中节点(boardSelNode)+右栏明细同步;底部条显示该格全文(证据文本不截断)。 */
function renderResearchMatrix(host, doc, info, ro) {
  const sel = cvMatrixSel;
  const rowsHtml = info.candidates.map((row) => {
    const rowOn = sel && sel.nodeId === row.id ? " on" : "";
    return '<tr data-mx-row="' + esc(row.id) + '" class="' + (rowOn ? "on" : "") + '">' +
      '<td class="bd-mx-cand" data-mx-node="' + esc(row.id) + '"><div class="bd-mx-name">' + esc(row.label) + "</div>" +
      (row.summary ? '<div class="bd-mx-sum">' + esc(row.summary) + "</div>" : "") +
      '<div class="bd-mx-meta" title="点选后在右侧明细查看节点全文">' + row.cellCount + "/" + info.dims.length + " 维</div></td>" +
      info.dims.map((d) => {
        const c = row.cells[d.key];
        const on = sel && sel.nodeId === row.id && sel.dim === d.key ? " on" : "";
        if (!c) return '<td class="bd-mx-cell empty unknown' + on + '" data-mx-node="' + esc(row.id) + '" data-mx-dim="' + esc(d.key) + '" title="该候选没有「' + esc(d.label) + '」证据:显式标未知,禁止留空">未知</td>';
        return '<td class="bd-mx-cell has' + on + '" data-mx-node="' + esc(row.id) + '" data-mx-dim="' + esc(d.key) + '" title="' + esc(c.text) + '">' +
          esc(c.text) + (c.confidence ? '<span class="bd-mx-conf c-' + esc(c.confidence) + '">' + esc(c.confidence) + "</span>" : "") +
          '<span class="bd-mx-src">' + (c.source === "flow" ? "流程" : "摘要") + "</span></td>";
      }).join("") + "</tr>";
  }).join("");
  const head = '<tr><th>候选</th>' + info.dims.map((d) =>
    "<th>" + esc(d.label) + (d.weight != null ? '<span class="bd-mx-weight">' + esc(String(d.weight)) + "%</span>" : "") + "</th>").join("") + "</tr>";
  const concl = info.conclusion
    ? '<div class="bd-mx-concl"><b>结论</b> ' + esc(info.conclusion.label) + (info.conclusion.summary ? " · " + esc(info.conclusion.summary) : "") +
      ' <button class="vw-act" data-mx-node="' + esc(info.conclusion.id) + '" style="margin-left:6px">看节点</button></div>'
    : "";
  const matrixNote = info.matrix ? '<div class="bd-mx-note">矩阵节点:' + esc(info.matrix.label) + (info.matrix.summary ? " · " + esc(info.matrix.summary) : "") + "</div>" : "";
  const weightNote = info.weightsKnown > 0
    ? '<div class="bd-mx-note">维度权重:' + info.dims.filter((d) => d.weight != null).map((d) => esc(d.label) + " " + esc(String(d.weight)) + "%").join(" · ") + " · 加权分可按这些权重复算</div>"
    : '<div class="bd-mx-hint">未标维度权重:在矩阵节点写「成本30% / 风险30% / 可维护性20% / 可测试性10% / 证据10%」即可复算加权分</div>';
  const body = info.ok
    ? '<div class="bd-mx-scroll"><table class="bd-matrix"><thead>' + head + "</thead><tbody>" + rowsHtml + "</tbody></table></div>" +
      concl + weightNote + matrixNote + (info.hint ? '<div class="bd-mx-hint">' + esc(info.hint) + "</div>" : "")
    : '<div class="bd-mx-empty">' + esc(info.hint || "没有可展示的候选/维度") + "</div>";
  host.innerHTML = '<div class="bf-canvas bd-matrix-host" id="cvHost">' +
    '<div class="bd-matrix-bar"><button class="vw-act" id="cvMxBack" title="回到画布视图">&#8592; 画布</button>' +
    '<span class="bd-matrix-title">决策矩阵:候选 × 维度</span><span class="bd-matrix-sub">' +
    esc(info.candidates.length + " 候选 / " + info.candidates.reduce((a, r) => a + r.cellCount, 0) + " 格有内容 · " + String(doc.boardType || "research") + " · " + (doc.scale ? "规模 " + doc.scale : "规模未标")) + "</span></div>" +
    '<div class="bd-mx-sel" id="bdMxSel">点单元格查看节点与证据全文' + (ro ? "(只读)" : "") + "</div>" + body + "</div>";
  const cvHost = host.querySelector("#cvHost");
  cvActiveHost = cvHost;
  host.__cvSig = "mx|" + doc.taskId + "|" + doc.rev + "|" + (ro ? "r" : "") + "|" + (sel ? sel.nodeId + "|" + sel.dim : "");
  if (!cvHost) return;
  const showSel = (nid, dim) => {
    const row = info.candidates.filter((r) => r.id === nid)[0];
    const strip = cvHost.querySelector("#bdMxSel");
    if (!strip) return;
    if (!row) { strip.textContent = "点单元格查看节点与证据全文"; return; }
    const d = info.dims.filter((x) => x.key === dim)[0];
    const c = dim ? row.cells[dim] : null;
    strip.innerHTML = "<b>" + esc(row.label) + "</b>" + (d ? " · " + esc(d.label) : "") + " · " +
      esc(c ? c.text : (row.summary || "无单元格文本")) + (c ? '<span class="bd-mx-src">' + (c.source === "flow" ? "流程" : "摘要") + "</span>" : "");
  };
  if (sel) showSel(sel.nodeId, sel.dim);
  cvHost.addEventListener("click", (e) => {
    const back = e.target.closest ? e.target.closest("#cvMxBack") : null;
    if (back) { cvMatrixOn = false; cvMatrixSel = null; renderBoard(); return; }
    const cell = e.target.closest ? e.target.closest("[data-mx-node]") : null;
    if (!cell) return;
    const nid = cell.getAttribute("data-mx-node");
    const dim = cell.getAttribute("data-mx-dim") || "";
    cvMatrixSel = { nodeId: nid, dim };
    for (const el of cvHost.querySelectorAll("[data-mx-node]")) {
      const isOn = el.getAttribute("data-mx-node") === nid && (el.getAttribute("data-mx-dim") || "") === dim;
      el.classList.toggle("on", !!isOn);
    }
    for (const tr of cvHost.querySelectorAll("tr[data-mx-row]")) tr.classList.toggle("on", tr.getAttribute("data-mx-row") === nid);
    showSel(nid, dim);
 // 只读画布(档案沉淀)不碰会话板全局选中/明细;表格内高亮与底部全文仍生效
    if (!ro) {
      boardSelNode = nid;
      try { renderBoardDetail(); } catch (err) { /* 明细宿主不在场=不影响表格 */ }
    }
    try { host.__cvSig = "mx|" + doc.taskId + "|" + doc.rev + "|" + (ro ? "r" : "") + "|" + nid + "|" + dim; } catch (err2) { /* 忽略 */ }
  });
}

/** 画布渲染(泛化宿主:doc=板;opts={host, readonly, links}——
 * 缺省 host=bdGraphHost(大白板/浮窗由 bdHome 决定);readonly=true 供档案「设计沉淀」只读画布:
 * 不渲添加工具箱、不绑编辑交互、拖拽与直改板落盘全禁;links 传入服务端解析的连接三态(只读时不用 boardLinks 全局)。 */
function renderBoardCanvas(doc, opts) {
  const ro = !!(opts && opts.readonly);
  cvRo = ro;
  cvActiveDoc = doc;
  const host = (opts && opts.host) || bdGraphHost(); // 宿主泛化:大白板 #boardGraph / 浮窗 #bfGraph / 档案沉淀灯箱自备宿主
  if (!host) return;
  const roLinks = (opts && opts.links) || null;
 // 页面结构板(docKind=page)语义布局:容器化+层次流向+主线+页面内 UI 线框。
 // pos 尊重规则:全部节点有 pos(=用户拖拽/整理落盘后)→ 完全尊重现行为;否则(部分/全无)
 // → BoardPageLayout 语义布局(渲染层兜底,不写盘——存量旧板自动受益,不改盘上数据)。
  cvPageInfo = null;
  cvFlowInfo = null;
  cvUiInfo = null;
  cvFoldMode = false;
 // UI 交互流程视图:切板回默认「交互」;结构视图保留原页面结构板。
  if (cvUiTask !== doc.taskId) { cvUiTask = doc.taskId; cvUiMode = "interaction"; cvUiMovedCache = null; }
 // 层高亮是「这块板上的临时看法」——切板即复位(不把 A 板的只看变更带到 B 板)
  if (cvLayerTask !== doc.taskId) { cvLayerTask = doc.taskId; cvLayerOn = ""; }
  const uiAvail = cvUiAvailable(doc);
  const uiOn = uiAvail && cvUiMode === "interaction";
 // B:research 板「矩阵」表格视图(纯 UI 态):切板自动回画布;只对 boardType=research 生效。
 // 早退分支不做布局(fit/泳道/边全不需要),表格容器进 cvActiveHost 保证后续交互/明细定位不摸错宿主。
  if (cvMatrixTask !== doc.taskId) {
    cvMatrixTask = doc.taskId; cvMatrixSel = null;
 // 调研/选型板默认直接给「候选×维度」矩阵(有可识别候选时);无候选回画布看原板。
    const mxProbe = (doc.boardType === "research" || doc.boardType === "matrix") ? researchMatrixRows(doc) : null;
    cvMatrixOn = !!(mxProbe && mxProbe.ok);
  }
  if ((doc.boardType === "research" || doc.boardType === "matrix") && cvMatrixOn) {
    renderResearchMatrix(host, doc, researchMatrixRows(doc), ro);
    return;
  }
  const mxBoard = doc.boardType === "research" || doc.boardType === "matrix"; // research/matrix 板右上给「矩阵」表切换
  let cvRenderDoc = doc;   // w1/w2 后的「实际要渲染的节点/边」(过滤子集 → 再按密度收卡);boardDoc 永不动
  let cvFoldHtml = "";     // w2 密度分层的 +N 计数块(每个有隐藏节点的泳道一个)
  cvWriterAll = cvWriterChips(doc.nodes || []);
 // 板内容变了:已选写者里已消失的键要摘掉,全选态回收成 null(否则过滤键永挂不复位)
  if (cvWriterOn) {
    const alive = new Set(cvWriterAll.map((c) => c.pfx));
    for (const p of [...cvWriterOn]) if (!alive.has(p)) cvWriterOn.delete(p);
    if (!cvWriterOn.size || cvWriterOn.size === alive.size) cvWriterOn = null;
  }
 // 折叠态同构清理:新板没有可折叠内容(既无大组也无碎泳道)时回收(否则开关挂着但服务端折不了任何东西)
  if (cvFoldGroups && !cvFoldAvailable(doc)) cvFoldGroups = false;
  const isPageDoc = doc.docKind === "page" && typeof BoardPageLayout !== "undefined";
 // docs 两层 PPT(先大骨架→骨架再丰富成页):
 // docs 板有「章(section)contains→页(page)」结构时,用 BoardPageLayout 的容器语义渲染——
 // 章=容器卡(章节序号+断言标题),页=章内小卡;章间 data 推进边画主线。非 docs 板不受影响。
  const docChapterEdges = String(doc.boardType || "") === "docs"
    ? (doc.edges || []).filter((e) => e && e.kind === "contains")
    : [];
  const isDocsDeck = !isPageDoc && String(doc.boardType || "") === "docs"
    && docChapterEdges.length > 0
    && (doc.nodes || []).some((n) => n && n.kind === "section")
    && (doc.nodes || []).some((n) => n && n.kind === "page");
 // 2026-11 composition(作业思路板)专用布局:主题带 + 章节主列 + 属性卡区——
 // 通用 flow LR 会把主题/受众/结构与章节混排,读不出「主题→章节顺序→章间关系」。
 // 进门条件:boardType=composition 且存在 section 节点(无 section 的 composition 板走原路径不动);
 // 产出与 BoardFlowLayout 同形(mode=flow),渲染层泳道框/编号/主线高亮/边标签零改动复用。
  const isComposeDoc = !isPageDoc && !isDocsDeck && String(doc.boardType || "") === "composition"
    && (doc.nodes || []).some((n) => n && n.kind === "section")
    && typeof BoardTypeProfile !== "undefined" && typeof BoardTypeProfile.composeLayout === "function";
 // 测试类型接入 code flow:测试任务与 code 同形态(纯 code flow,
 // 被测链路逐函数展开)。test 板带 start/end 时复用 code 板的工程师 flow 渲染
 // (药丸/菱形/正交线/代码框/方法分组);test 契约板(无 start/end)渲染不变。
 // perf 板纳入 code flow(用户:「性能优化的 flow 还差点意思」):perf 与 code/test 同列——
 // 板型进工程师 flow 渲染白名单 = cvBoardType === "code" || cvBoardType === "test" || cvBoardType === "perf";
 // 进门条件各自保持:code 恒进(自带变更契约分支)、test 仍要 start/end(逐字不变)、
 // perf 要么有 start/end/decision 要么 ≥50% 步骤带 flow 行(与 cvCodeFlowWanted 同口径)才进,
 // 旧 perf 三卡板(无流程语义)渲染逐字不变。
  const cvBoardType = String(doc.boardType || "");
  const wantTestFlow = cvBoardType === "test" && (doc.nodes || []).some((n) => n && (n.kind === "start" || n.kind === "end"));
  const wantPerfFlow = cvBoardType === "perf" && cvCodeFlowWanted(doc.nodes || []);
  const cvCodeInfo = (cvBoardType === "code" || cvBoardType === "test" || cvBoardType === "perf")
    && (cvBoardType === "code" || wantTestFlow || wantPerfFlow) && !isPageDoc;
  let cvCodeSideNodes = [];
  let pos;
  if (isDocsDeck) {
 // docs 两层 PPT:复用 BoardPageLayout 的容器布局(章=容器,页=章内卡),
 // 章间 data 边不被引擎参与(引擎只看 contains 与 page 间 nav),data 线由渲染层画。
    const pg = BoardPageLayout.layout(doc);
    cvPageInfo = pg;
 // docs deck 边线口径:data(章间推进)=正交,data 主线金框沿用 pgInfo.mainEdges;contains 不画线
    pg.docsDeck = true;
    pg.codeFlow = true;
    const allPosed = doc.nodes.every((n) => n.pos && isFinite(n.pos.x) && isFinite(n.pos.y));
    pos = allPosed ? new Map(doc.nodes.map((n) => [n.id, { x: n.pos.x, y: n.pos.y }])) : pg.pos;
  } else if (isComposeDoc) {
 // composition 作业思路板:主题带置顶 + 章节主列(序号→边拓扑→声明序)+ 属性卡区(受众/结构/杂项)。
 // 引擎位为唯一真相(与 cvFlowEligible 路同口径):用户拖过的节点按 localStorage 微调覆盖。
 // 章间 data 边不重算——label 里的承接/递进/并列/对照/因果交给渲染层既有边标签;
 // mainEdges=章间 data 边集合 → 主线高亮(bfe-main 粗绿)零成本复用。
    const cfl = BoardTypeProfile.composeLayout(cvWriterFilterDoc(doc, cvWriterOn));
    cfl.compose = true; // 渲染层识别位(图例专用文案;不改布局消费逻辑)
    cvFlowInfo = cfl;
    cvRenderDoc = cvWriterFilterDoc(doc, cvWriterOn);
    pos = new Map(cfl.pos);
    const movedC = cvFlowMoved(doc.taskId);
    if (movedC.size) {
      for (const n of (cvRenderDoc.nodes || [])) {
        if (movedC.has(n.id) && n.pos && isFinite(n.pos.x) && isFinite(n.pos.y)) pos.set(n.id, { x: n.pos.x, y: n.pos.y });
      }
    }
  } else if (isPageDoc) {
 // 修复:布局引擎恒跑——size/roles/mainline/containers 是渲染层刚需(线框/金框/图例),
 // 旧实现 allPosed 时 cvPageInfo=null → 用户拖过一次(整板 pos 固化)后页面板永久退化成普通卡片。
 // 引擎纯函数幂等零副作用,多跑一次只为元数据;位置:全部有 pos=尊重用户拖拽,否则用引擎语义位。
    const pg = BoardPageLayout.layout(doc);
    if (uiOn && typeof BoardUiFlowLayout !== "undefined") {
 // 交互地图:布局位是唯一真相(不读盘上 pos——旧页面板的整板 pos 会把新网格打散);
 // 用户拖动走 localStorage 微调(传给引擎,页面拖动带动子孙)。
      const ui = BoardUiFlowLayout.layout(doc, pg, { moved: cvUiMovedOf(doc) });
      if (ui) { cvUiInfo = ui; cvPageInfo = ui; pos = ui.pos; }
      else { cvPageInfo = pg; pos = pg.pos; }
    } else {
      cvPageInfo = pg;
      const allPosed = doc.nodes.every((n) => n.pos && isFinite(n.pos.x) && isFinite(n.pos.y));
      pos = allPosed ? new Map(doc.nodes.map((n) => [n.id, { x: n.pos.x, y: n.pos.y }])) : pg.pos;
    }
  } else if (cvFlowEligible(doc)) {
 // fixH2 流动 LR 布局:入口最左/出口最右 + 泳道分段 + 主线突出。引擎位为唯一真相(存量板旧分层
 // pos 不钉死布局,新形态即时生效);用户在本模式拖过的节点按 localStorage 微调覆盖,「整理」清空。
 // w1:写者过滤后的**子集**重算布局(拿全量布局再藏节点会留一片空地,「过滤后重排」才是可读的);
 // w2:过滤态下不做密度收卡(用户已经在精确看某一路),阈值只在未过滤时生效。
    const fdoc0 = cvWriterFilterDoc(doc, cvWriterOn);
 // code 板可读性:
 // - flow 板(有 start/end):主图直接是 start→steps→decision→end 的流程图;
 // - 变更契约板:主图 = 一个「现状基线」Container + 变更节点;现状细节/根因/验收/风险进右侧栏。
 // 放宽:planner 想画逻辑的 code 板不一定落 start/end。三种都算「想画流程图」:
 // ①有 start/end(原有口径) ②有 decision 节点 ③步骤节点里 ≥50% 带 flow 行(代码级步骤)。
 // 只有这样,正交连线/代码框/药丸菱形才会出现(否则一张 模块+decision 的板完全退化成普通卡)。
    const cvCodeFlowMode = !!cvCodeInfo && cvCodeFlowWanted(fdoc0.nodes);
    let mainNodes, fdoc;
    if (cvCodeFlowMode) {
      mainNodes = fdoc0.nodes.filter((n) => !cvCodeFlowSide(n));
      const ids = new Set(mainNodes.map((n) => n.id));
      cvCodeSideNodes = fdoc0.nodes.filter((n) => !ids.has(n.id));
      fdoc = Object.assign({}, fdoc0, { nodes: mainNodes, edges: (fdoc0.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to)) });
    } else {
      const changeNodes = fdoc0.nodes.filter((n) => ["add", "modify", "delete"].includes(n.change) && !cvCodeSide(n));
      const changeIds = new Set(changeNodes.map((n) => n.id));
      const baseline = {
        id: "__cv_current", kind: "module", label: "现状链路(基线)", group: "01 现状层", change: "keep", done: false, comments: [],
        summary: "[Container: TypeScript] 插件市场 → 安装写盘 → 前端刷新 → 斜杠候选;细节见右侧栏", targets: [], accept: [], flow: [],
      };
      cvCodeSideNodes = cvCodeInfo ? fdoc0.nodes.filter((n) => !changeIds.has(n.id)) : [];
      mainNodes = cvCodeInfo && changeNodes.length ? [baseline].concat(changeNodes) : fdoc0.nodes;
      const syntheticEdges = cvCodeInfo && changeNodes.length
        ? changeNodes.map((n) => ({ from: "__cv_current", to: n.id, kind: "data", label: "→ " + String(n.label || "").slice(0, 16) }))
        : [];
      const changeEdges = (fdoc0.edges || []).filter((e) => changeIds.has(e.from) && changeIds.has(e.to));
      fdoc = cvCodeInfo && changeNodes.length
        ? Object.assign({}, fdoc0, { nodes: mainNodes, edges: syntheticEdges.concat(changeEdges) })
        : fdoc0;
    }
 // 密度分层模式用 compact 布局:非主干卡会被收成 +N,此时若仍做 7c 整框纵向让位,
 // 仅剩的几张主干卡会被沿纵向拉开几千 px(经验证 y 跨 2072px),适配 k 永远撞 0.7 可读下限。
 // compact 下跳过让位与碎泳道合并,主干按层横排;非分层路径(小/中等板)行为逐字不变。
    const foldPreview = !cvWriterOn && fdoc.nodes.length > CV_FOLD_THRESHOLD;
 // A:宽设计板受控列换行(引擎再按主路径列数 > 4 裁决);refactor 双泳道不强扭
 // 板型画布:code 板主图卡更大(工程师图),其它板型沿用 228/150。
    const tprof = cvTypeProfileOf(doc);
    const typedHasFlow = !!(tprof && (fdoc.nodes || []).some((n) => Array.isArray(n.flow) && n.flow.length));
    const fl = BoardFlowLayout.layout(fdoc, {
      compact: foldPreview,
      autoWrap: cvCodeInfo ? false : cvFlowWrapWanted(doc, fdoc),
 // code 板 3 列折行:一个方法组≈一行,260px 卡 ×3 列在 1680 视口内可按 1:1 读
      wrap: cvCodeInfo ? 3 : undefined,
      nodeW: tprof ? (cvCodeInfo ? 260 : 228) : undefined,
 // code flow 卡里要放 3~4 行代码级步骤(示例图的代码框),比变更契约卡再高 14px
      nodeH: tprof ? (cvCodeInfo ? (cvCodeFlowMode ? 176 : (typedHasFlow ? 162 : 150)) : (typedHasFlow ? 150 : 136)) : undefined,
 // code flow 的方法分组必须一色一框:禁止 7b/7d 把相邻小组并成一条(经验证标题拼成
 // 「registerPluginSkillsslashCandidates」,方法边界丢失)
      preserveLanes: doc.boardType === "refactor" || cvCodeFlowMode,
    });
    if (cvCodeFlowMode) {
 // start/end 画小药丸(220×64),在 176 高的布局槽里居中:端口中心不变,主线仍是一条直线
      for (const n of fdoc.nodes) {
        if (n.kind !== "start" && n.kind !== "end") continue;
        const p0 = fl.pos.get(n.id), sz0 = fl.size.get(n.id);
        if (!p0 || !sz0) continue;
        const w0 = Math.min(220, sz0.w), h0 = 64;
        fl.pos.set(n.id, { x: p0.x + (sz0.w - w0) / 2, y: p0.y + (sz0.h - h0) / 2 });
        fl.size.set(n.id, { w: w0, h: h0 });
      }
    }
 // 渲染层正交连线开关(只 code flow 生效;其它板型/契约板保持原路径)
    fl.codeFlow = !!cvCodeFlowMode;
    cvFlowInfo = fl;
    cvRenderDoc = fdoc;
    pos = new Map(fl.pos);
    if (!cvWriterOn && fdoc.nodes.length > CV_FOLD_THRESHOLD) {
 // 密度分层:完整卡只给主线(entry→exit)+ 阶段卡 + 用户展开过的泳道;其余按泳道汇总成 +N 块。
      const lanes = fl.lanes || [];
      const keep = new Set(fl.mainNodes || []);
      for (const lane of lanes) {
        if (lane.isPhase || cvFoldOpen.has(lane.key)) for (const id of lane.nodes) keep.add(id);
      }
 // 缺陷修复(P0:「+N 展开后无法收起」):toggle 逻辑本来就是双向的
 // (cvFoldOpen 有则删/无则加),唯一入口却是 +N 块——泳道一旦展开,它的节点全进 keep,
 // hidden 变空 → 该泳道不再出块 → 用户再也点不到收起,只能刷新页面重来。
 // 修法:已展开的泳道也出一个反向块(dir:"close",文案「−N 收起」,data-fold 用**同一个** lane.key),
 // 复用既有 toggle 直接生效;正/反向块同属 folded 一个数组 → 下面的网格坐标天然不重叠。
      const folded = [];
      for (const lane of lanes) {
        const hidden = lane.nodes.filter((id) => !keep.has(id));
        if (!hidden.length) {
          if (cvFoldOpen.has(lane.key)) folded.push({ key: lane.key, n: lane.nodes.length, no: lane.no, label: lane.label, dir: "close" });
          continue;
        }
        folded.push({ key: lane.key, n: hidden.length, no: lane.no, label: lane.label, dir: "open" });
      }
      if (folded.length) {
        cvFoldMode = true;
        const keptNodes = fdoc.nodes.filter((n) => keep.has(n.id));
        const keptIds = new Set(keptNodes.map((n) => n.id));
        cvRenderDoc = { taskId: fdoc.taskId, docKind: fdoc.docKind, status: fdoc.status, title: fdoc.title, nodes: keptNodes, edges: fdoc.edges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)) };
 // 被收起的节点从 pos 里摘掉:世界尺寸/小地图/边几何都只看真正画出来的东西
        for (const n of fdoc.nodes) if (!keptIds.has(n.id)) pos.delete(n.id);
        cvFoldHtml = (function () {
 // 计数块摆放:摆在**主干卡下方成网格**——横向从主干最小 x 起,每行 8 个,列距 160px;
 // 纵向从主干最大 y + 40 起,行距 40px。
 // 历史教训(两次经验证):①固定 y=40 + 主干 y≈1426 → 1300px 空白把适配 k 压到下限;
 // ②改「主干右缘 +260、与主干同高」→ 60 节点板主干 x 跨到 1982,计数块落在 x=2034..2194,
 // 而 k=0.7 的可见世界只到 x≈1592 → 20 个计数块**全部**在视野外(经验证可见 0/20)。
 // 摆到主干正下方:只往下多出几行 40px,横向不越过主干右缘,适配框不被推宽。
          let minX = Infinity;
          let maxY = 0;
          for (const n of keptNodes) {
            const p = pos.get(n.id);
            if (!p) continue;
            const sz = (cvFlowInfo && cvFlowInfo.size && cvFlowInfo.size.get(n.id)) || { w: 216, h: 110 };
            minX = Math.min(minX, p.x);
            maxY = Math.max(maxY, p.y + (sz.h || 0));
          }
          if (!isFinite(minX)) minX = 40;
          if (!maxY) maxY = 40;
          const foldY0 = maxY + 40;
          return folded.map((f, i) => {
 // 正/反向块同索引同网格:一格一块,坐标天然不重叠(反向块是同一泳道展开后替换掉 +N 位置)。
 // 反向态用 data-fold-dir 属性承载,不再加修饰 class:class 精确串 "cv-fold" 是既有测试
 // (panel-board-live ③)与选择器口径,别为一个修饰态把它拆成两条串。
            const fx = minX + (i % 8) * 160;
            const fy = foldY0 + Math.floor(i / 8) * 40;
            const close = f.dir === "close";
            return '<div class="cv-fold" ' + (close ? 'data-fold-dir="close" ' : "") + 'data-fold="' + esc(f.key) + '" style="left:' + fx + "px;top:" + fy + 'px" title="' +
              (close ? "收起「" + esc(f.no + " " + f.label) + "」(" + f.n + " 个节点回到计数块)" : "展开「" + esc(f.no + " " + f.label) + "」里的 " + f.n + " 个节点") + '">' +
              (close ? "<b>−" + f.n + "</b>" : "<b>+" + f.n + "</b>") + "<span>" + esc(String(f.label || "").slice(0, 12)) + "</span></div>";
          }).join("");
        })();
      }
    }
    const moved = cvFlowMoved(doc.taskId);
    if (moved.size) {
      for (const n of (cvRenderDoc.nodes || [])) {
        if (moved.has(n.id) && n.pos && isFinite(n.pos.x) && isFinite(n.pos.y)) pos.set(n.id, { x: n.pos.x, y: n.pos.y });
      }
    }
  } else if (bdLaneEligible(doc)) {
 // n1/A3 无边板泳道回退:零边设计板不再退回旧分层孤箱堆——按 group/kind 成泳道,
 // 声明顺序编号 01..N,泳道框/编号角标/图例全部复用流动渲染件(用户用户反馈「无边板看不出结构」)。
    cvFlowInfo = bdFallbackLanes(doc);
    pos = new Map(cvFlowInfo.pos);
  } else {
    pos = cvLayout(doc);
  }
 // 关系图例开关:设计板/流动板有边时才显示(page 板有自己的语义图例)
  const relLegend = !cvPageInfo && Array.isArray(cvRenderDoc.edges) && cvRenderDoc.edges.length > 0;
 // flowkit 单张 SVG:svg 模式下卡片 DOM 不存在,结构签名与「逐节点补丁」都不适用。
 // 增量口径只认「svg 内容是否变了」:签名(doc.rev + 模式)未变且 svg 已缓存 → 直接 return(不重注入、
 // 不碰 cvPan——「保存回执抢走用户视野」是既有 P0,这里绝不调 cvApplyTf/cvFitNow 重置视野)。
  const cvMode = cvRenderMode();
  const cvSvgSigNow = cvSvgSig(doc);
  if (cvMode === "svg") {
    const svgNow = cvSvgCacheSig === cvSvgSigNow ? cvSvgCacheHtml : "";
    const svgHostOld = host.querySelector("#cvSvgHost");
    const domSig = svgHostOld && svgHostOld.getAttribute ? (svgHostOld.getAttribute("data-sig") || "") : "";
    const plan = cvSvgPatchPlan(cvSvgSigNow, domSig, !!svgNow);
    if (plan === "keep") { host.__cvSig = cvSvgSigNow; return; } // DOM 里已是这一版 svg:不重注入、不碰任何视图状态
    if (plan === "inject" && svgHostOld && host.querySelector(".bf-cv-world")) {
 // 内容变了:只整块重注入 #cvSvgHost,视野(cvPan/cvPan.k)原样保留——
 // 绝不调 cvApplyTf/cvFitNow(既有 P0「保存回执抢走用户视野」不能再复活)。
      svgHostOld.innerHTML = svgNow;
      try { svgHostOld.setAttribute("data-sig", cvSvgSigNow); } catch (e) { /* 忽略 */ }
      try { if (svgHostOld.removeAttribute) svgHostOld.removeAttribute("data-stale"); } catch (e) { /* 忽略 */ } // 新图到位:抹掉「等图」标记
      host.__cvSig = cvSvgSigNow;
      if (typeof cvDrawMini === "function") { try { cvDrawMini(host, doc, pos); } catch (e2) { /* 小地图失败不影响视图 */ } }
      return;
    }
    if (!svgNow) cvSvgRequest(doc); // 等回包:board.diagram.result 到达后重渲整块
  }
 // D2 增量渲染:结构签名(节点 id/kind/label/change/代码连接+边集+ro/编辑态)不变 → 原位补丁
 // (done 勾/摘要/评论徽标/连接点/位置/meta 行/边几何),不再整板 innerHTML 重建——agent 连续
 // board_upsert 时用户看到的是丝滑增量更新,不是整板闪烁重绘;DOM 引用/交互绑定/在途 hover 全保留。
  const sig = cvStructSig(doc, ro);
  if (cvMode === "cards" && host.__cvSig === sig && host.querySelector(".bf-cv-world")) {
    if (cvPatchCanvas(host, doc, pos, ro, roLinks)) return;
  }
  const cvFocusKeep = !!(document.activeElement && host.contains(document.activeElement)); // fixD2: innerHTML 重建吃焦点(连续 Ctrl+Z/Y 第二次失灵的根因)——先记 cvHost 是否持焦,重建后恢复
 // 世界尺寸(含所有节点;page/flow 板用引擎 size,纯旧分层板沿旧估值)
  const cvSizeOf = (id) => (cvPageInfo && cvPageInfo.size.get(id)) || (cvFlowInfo && cvFlowInfo.size.get(id)) || { w: 216, h: 110 };
  let maxX = 0, maxY = 0;
  if (cvPageInfo || cvFlowInfo) {
    for (const [id, p] of pos) { const s = cvSizeOf(id); maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h); }
 // fixH2:泳道虚线框可能比节点包围盒大(顶部标题条/左右内边距)——世界尺寸必须吃进去,否则框被裁
    if (cvFlowInfo) for (const lane of cvFlowInfo.lanes) { maxX = Math.max(maxX, lane.x + lane.w); maxY = Math.max(maxY, lane.y + lane.h); }
 // UI 交互地图:顶部摘要/图例/辅助带/右侧车道都在世界内,按引擎世界尺寸兜底
    if (cvUiInfo) { maxX = Math.max(maxX, cvUiInfo.world.w - 40); maxY = Math.max(maxY, cvUiInfo.world.h - 60); }
  } else {
    for (const p of pos.values()) { maxX = Math.max(maxX, p.x + 200); maxY = Math.max(maxY, p.y + 120); }
  }
 // svg 模式世界尺寸:直接用回包 SVG 的 viewBox 宽高 + 60 留白(既有口径),不再累加卡片包围盒。
 // 解析失败(+60 兜底也不需要)/svg 还没回来 → 保持上面的 cards 累加结果(=回退,不崩)。
  const cvSvgBoxNow = cvMode === "svg" ? cvSvgWorldSize(cvSvgCacheSig === cvSvgSigNow ? cvSvgCacheHtml : "") : null;
  if (cvSvgBoxNow) { maxX = cvSvgBoxNow.w; maxY = cvSvgBoxNow.h; }
  let edgeSvg = '<svg class="bf-cv-edges" width="' + Math.max(maxX + 60, 600) + '" height="' + Math.max(maxY + 60, 400) + '">';
  edgeSvg += cvEdgeInner(cvRenderDoc, pos, cvPageInfo || cvFlowInfo);
  edgeSvg += cvEdgeDefs() + cvUiFlowDefs(cvUiInfo) + '</svg>';
  const nodePos = (id) => pos.get(id) || { x: 0, y: 0 }; // 节点卡定位仍需(十期重构后保留此局部量)
 // 分区底色:page 容器按板内序 5 色循环(暗调色相区分,主线容器另加金框)
  const PG_HUES = [  // 色相走 --bcv-lane-N / --bcv-page-N-bg 令牌(var 兜底=原写死值):浅色主题自动转浅板
 // 白板修复:首色相弃金(#c9a25e 与主线金 #e0b46a 视觉撞色,评审"金框不突出"根因)→石板灰蓝;
 // 全表无金色系后,亮金=主线专属语义,对比度由色彩唯一性保证
    { bd: "var(--bcv-lane-2,#7e8ba0)", bg: "var(--bcv-page-1-bg,rgba(20,24,32,.93))", tint: "var(--bcv-lane-2-bg,rgba(126,139,160,.08))" },
    { bd: "var(--bcv-lane-3,#5a9a7a)", bg: "var(--bcv-page-2-bg,rgba(14,32,24,.93))", tint: "var(--bcv-lane-3-bg,rgba(90,154,122,.08))" },
    { bd: "var(--bcv-lane-5,#6172a8)", bg: "var(--bcv-page-3-bg,rgba(16,24,42,.93))", tint: "var(--bcv-lane-5-bg,rgba(97,114,168,.09))" },
    { bd: "var(--bcv-lane-4,#9a6fa8)", bg: "var(--bcv-page-4-bg,rgba(34,20,38,.93))", tint: "var(--bcv-lane-4-bg,rgba(154,111,168,.08))" },
    { bd: "var(--bcv-lane-1,#b0705a)", bg: "var(--bcv-page-5-bg,rgba(40,22,16,.93))", tint: "var(--bcv-lane-1-bg,rgba(176,112,90,.08))" },
  ];
  const pgOrder = cvPageInfo ? Array.from((cvPageInfo.containers || new Map()).keys()) : [];
  const hueOf = (id) => PG_HUES[Math.max(0, pgOrder.indexOf(id)) % PG_HUES.length] || PG_HUES[0];
 // docs 章号:此前取 PG_HUES[i].tag(该字段在色相表里根本不存在)→ 章号渲染成字面量 "undefined",
 // 且浅底主题下是 #fffdf8 白字压浅卡(1.08:1)。改为按章(section)在板内的声明序取两位序号 01/02…;
 // 只影响 docs 章卡头那个 <b>,默认主题其余色相/布局逐字不变。
  const cvDocSecIds = (isDocsDeck && Array.isArray(doc.nodes) ? doc.nodes : []).filter((x) => x && x.kind === "section").map((x) => x.id);
  const cvDocChNo = (id) => {
    const i = cvDocSecIds.indexOf(id);
    return i >= 0 ? ("0" + (i + 1)).slice(-2) : "";
  };
 // fixH2 泳道框色相(流动板):纵向虚线圆角框分段,5 色循环区分阶段;未连接列固定灰。
  const CV_LANE_HUES = [
    { bd: "var(--bcv-lane-2,#6f9ac4)", bg: "var(--bcv-lane-2-bg,rgba(96,140,190,.06))", tag: "var(--bcv-lane-2-fg-strong,var(--bcv-lane-2-fg,#a8c8e8))" },
    { bd: "var(--bcv-lane-3,#5a9a7a)", bg: "var(--bcv-lane-3-bg,rgba(90,154,122,.055))", tag: "var(--bcv-lane-3-fg-strong,var(--bcv-lane-3-fg,#9ad2ae))" },
    { bd: "var(--bcv-lane-5,#9a7fc0)", bg: "var(--bcv-lane-5-bg,rgba(150,120,200,.055))", tag: "var(--bcv-lane-5-fg-strong,var(--bcv-lane-5-fg,#c8aee8))" },
    { bd: "var(--bcv-lane-1,#b08a5a)", bg: "var(--bcv-lane-1-bg,rgba(180,140,90,.05))", tag: "var(--bcv-lane-1-fg-strong,var(--bcv-lane-1-fg,#e0c08f))" },
    { bd: "var(--bcv-lane-6,#5aa8b8)", bg: "var(--bcv-lane-6-bg,rgba(80,170,190,.05))", tag: "var(--bcv-lane-6-fg-strong,var(--bcv-lane-6-fg,#96d8e4))" },
  ];
 // code flow 方法/阶段分组:示例图的实色分区(黄/蓝/绿/粉/紫),不是虚线泳道
  const CV_CODE_LANE_HUES = [
    { bd: "var(--bcv-lane-1,#c9a35e)", bg: "var(--bcv-lane-1-bg,rgba(201,163,94,.10))", tag: "var(--bcv-lane-1-fg-strong,var(--bcv-lane-1-fg,#f0d39a))" },
    { bd: "var(--bcv-lane-2,#5b8ec9)", bg: "var(--bcv-lane-2-bg,rgba(91,142,201,.10))", tag: "var(--bcv-lane-2-fg-strong,var(--bcv-lane-2-fg,#b8d4ff))" },
    { bd: "var(--bcv-lane-3,#5a9a7a)", bg: "var(--bcv-lane-3-bg,rgba(90,154,122,.10))", tag: "var(--bcv-lane-3-fg-strong,var(--bcv-lane-3-fg,#b8e6cd))" },
    { bd: "var(--bcv-lane-4,#b06a8a)", bg: "var(--bcv-lane-4-bg,rgba(176,106,138,.10))", tag: "var(--bcv-lane-4-fg-strong,var(--bcv-lane-4-fg,#f0bfd0))" },
    { bd: "var(--bcv-lane-5,#8a6fc0)", bg: "var(--bcv-lane-5-bg,rgba(138,111,192,.10))", tag: "var(--bcv-lane-5-fg-strong,var(--bcv-lane-5-fg,#d8c2f0))" },
  ];
 // w4 空壳泳道降噪:compact(密度分层)下布局把「成员全被收进 +N 计数块」的泳道标 boxless,
 // 这里跳过画框——21 框 vs 7 卡(3:1)的空壳虚框互相重叠糊画面,归属信息已由计数块表达
 // (计数块 title=「编号 泳道名 里的 N 个节点」)。lanes 数组不删数据(计数块要靠 key→label 算)。
  const codeLane = !!(cvFlowInfo && cvFlowInfo.codeFlow);
 // 单写者板不显示 [writer] 前缀(planner 独立板经验证标题变成「[pdhay] 面板刷新时机」,纯噪声)
  const onlyWriter = cvWriterAll.length === 1 && cvWriterAll[0].pfx ? cvWriterAll[0].pfx : "";
  const laneLabelOf = (label) => {
    const s = String(label || "");
    if (!onlyWriter) return s;
    const pre = "[" + onlyWriter + "]";
    return s.indexOf(pre) === 0 ? s.slice(pre.length).trim() : s;
  };
  const laneHtml = cvFlowInfo ? cvFlowInfo.lanes.filter((lane) => !lane.boxless).map((lane, i) => {
    const h = (codeLane ? CV_CODE_LANE_HUES : CV_LANE_HUES)[i % (codeLane ? CV_CODE_LANE_HUES.length : CV_LANE_HUES.length)];
    const bdC = lane.isolated ? "var(--bcv-lane-orphan-bd,#6b5c4a)" : h.bd;
    const bgC = lane.isolated ? "var(--bcv-lane-orphan-bg,rgba(90,83,70,.05))" : h.bg;
    const tagC = lane.isolated ? "var(--bcv-lane-h-fg,#c4b494)" : h.tag;
 // A:宽板折行时一条泳道可能按行拆成多段(boxes)——逐段画框,段头都带编号/标题,
 // 读图时每行都知道「这行属于哪条泳道」;无 boxes 的既有路径逐字不变。
    const segs = lane.boxes && lane.boxes.length ? lane.boxes : [lane];
    return segs.map((sg, si) => '<div class="cv-lane' + (codeLane ? " cv-code-lane" : "") + (lane.isolated ? " cv-lane-orphan" : "") + '" data-lane="' + esc(lane.key) + '"' +
      (segs.length > 1 ? ' data-lane-seg="' + si + '"' : "") +
      ' style="left:' + sg.x + "px;top:" + sg.y + "px;width:" + sg.w + "px;height:" + sg.h + "px;border-color:" + bdC + ";background:" + bgC + '">' +
      '<span class="cv-lane-h" style="color:' + tagC + '"><b style="background:' + bdC + '">' + esc(lane.no) + "</b>" + esc(laneLabelOf(lane.label)) + (segs.length > 1 ? '<em class="cv-lane-seg">第 ' + (si + 1) + "/" + segs.length + " 段</em>" : "") + "</span></div>").join("");
  }).join("") : "";
 // w1/w2:只画 cvRenderDoc 的节点(写者过滤子集 / 密度分层后的可见集);文件级元信息仍取全量 doc。
 // UI 交互地图按层排序:屏卡(0) → 区块(1) → 元素行(2) → 辅助带(3);否则区块/行会被后画的屏卡盖住。
  const cardNodes = cvUiInfo ? cvRenderDoc.nodes.slice().sort((a, b) => cvUiCardRank(a) - cvUiCardRank(b)) : cvRenderDoc.nodes;
  const cards = cardNodes.map((n) => {
    const lk = ro ? ((roLinks || []).find((l) => l.nodeId === n.id) || null) : (boardEditOn ? null : bdLinkOf(n.id));
    const lkCls = lk ? lk.state : "none";
    const p = nodePos(n.id);
    const c4 = cvCodeInfo ? cvC4Info(n) : null;
    const codeCls = c4 ? " cv-code-node" : "";
 // n12:该节点上有 agent 还没读到的评论 → cmt-pending 高亮(数据源 boardListPending,只读画布不挂)
    const selCls = (ro ? "" : (cvSelected.has(n.id) ? " selected" : (n.id === boardSelNode ? " on" : ""))) + (boardCommentMode && !ro ? " cmt-on" : "") + (!ro && bdNodePending(doc.taskId, n.id) ? " cmt-pending" : "");
 // 层高亮:只在该层板型(code/test/perf/refactor)且点过层 chip 时生效——
 // 命中的层加 .cv-layer-on,另一层加 .cv-layer-dim(opacity .35);两卡都不改任何布局量。
    const layCls = cvLayerAvail(doc) && cvLayerOn ? (cvLayerOf(n) === cvLayerOn ? " cv-layer-on" : " cv-layer-dim") : "";
    if (cvUiInfo) {
 // ---- UI 交互地图:屏卡(字幕带+手机/浏览器 chrome+tab 条)/区块/元素行/辅助带 ----
      if (n.kind === "page") {
        const pm = cvUiInfo.pages.find((x) => x.id === n.id) || null;
        if (pm) return cvUiScreenHtml(n, pm, selCls + layCls);
      }
      if (cvUiInfo.auxNodes.some((x) => x.id === n.id)) return cvUiAuxHtml(n, selCls + layCls);
      if (n.kind === "section") return cvUiSectionHtml(n, selCls + layCls);
      return cvUiRowHtml(n, selCls + layCls); // component / function 等页内交互元素
    }
    if (isDocsDeck && (n.kind === "page" || n.kind === "section" || n.kind === "aggregate")) {
 // ---- docs 两层 PPT 渲染:aggregate=结论根(全宽横幅),section=章容器卡
 // (章号+断言标题+页数),page=章内页卡(页断言标题+要点)。线由 cvEdgeInner(data/contains)。 ----
      const sz = cvSizeOf(n.id);
      const hue = hueOf(n.id);
      const cmtN = (n.comments && n.comments.length) || 0;
      if (n.kind === "aggregate") {
        return '<div class="cv-node k-module cv-doc-root' + selCls + layCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px">' +
          '<div class="cv-doc-root-tag">总评</div><div class="cv-doc-root-title" title="' + esc(n.label) + '">' + esc(n.label) + "</div>" +
          (n.summary ? '<div class="cv-doc-root-sum" title="' + esc(String(n.summary).slice(0, 200)) + '">' + esc(String(n.summary).slice(0, 90)) + "</div>" : "") + "</div>";
      }
      if (n.kind === "section") {
        const kids = (doc.edges || []).filter((e) => e.kind === "contains" && e.from === n.id).length;
        return '<div class="cv-node cv-doc-chapter' + selCls + layCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px;background:' + hue.bg + ';border-color:' + hue.bd + '">' +
          '<div class="cv-doc-ch-h"><b>' + esc(cvDocChNo(n.id)) + "</b><span>" + esc(n.label) + '</span><em class="cv-doc-ch-n">' + kids + ' 页</em></div>' +
          (n.summary ? '<div class="cv-doc-ch-sum" title="' + esc(String(n.summary).slice(0, 200)) + '">' + esc(String(n.summary).slice(0, 110)) + "</div>" : "") +
          '<span class="bd-tag lk-moved cv-cmts"' + (cmtN ? "" : ' style="display:none"') + ">评 " + cmtN + "</span></div>";
      }
 // page(章内页卡):页断言标题 + 要点;序号按章内声明序
      const sibs = (doc.edges || []).filter((e) => e.kind === "contains" && (doc.nodes || []).some((nn) => nn.id === e.from && nn.kind === "section"));
      const idx = sibs.findIndex((e) => e.to === n.id);
      const pNo = idx >= 0 ? "P" + (idx + 1) : "";
      return '<div class="cv-node cv-doc-page' + selCls + layCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px">' +
        '<div class="cv-doc-pg-h"><b>' + pNo + "</b>" + esc(n.label) + "</div>" +
        (n.summary ? '<div class="cv-doc-pg-sum" title="' + esc(String(n.summary).slice(0, 220)) + '">' + esc(String(n.summary).slice(0, 120)) + "</div>" : "") +
        "</div>";
    }
    if (cvPageInfo && (n.kind === "page" || n.kind === "section" || n.kind === "component")) {
 // ---- 页面结构板线框渲染:page=浏览器窗容器(三点头+地址条+分区底色+主线金框);
 // section/component=容器内线框小卡(role 类定质感:顶栏横条/侧栏/主区/底栏/浮层/未归属) ----
      const sz = cvSizeOf(n.id);
      const hue = hueOf(n.id);
      const role = cvPageInfo.roles.get(n.id) || "";
      const isMain = cvPageInfo.mainNodes.has(n.id);
      if (n.kind === "page") {
 // fixE残留:模板层吃单反斜杠,正则 \s 下发即碎(路由提取静默失效)——改 indexOf+切词(零正则)
        const smStr = String(n.summary || "");
        const rIdx = smStr.indexOf("路由");
        let url = "";
        if (rIdx >= 0) url = smStr.slice(rIdx + 2).trim().split(" ")[0] || "";
        if (!url) url = (n.label || "").slice(0, 16);
 // 主线容器边框恒金(inline 分区色会让位——主线视觉对比是「给人看」的核心,不能被色相轮换淹没)
        const bdColor = isMain ? "#e0b46a" : hue.bd;
 // fixE2:pgbox(页面容器)标题行补评论徽标(恒渲染+0 条隐藏,与普通卡同款——cvPatchCanvas 增量路径按 .cv-cmts 原位更新计数)
        const cmtN = (n.comments && n.comments.length) || 0;
        return '<div class="cv-node k-page pgbox' + (isMain ? " pgmain" : "") + selCls + layCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px;background:' + hue.bg + ';border-color:' + bdColor + '">' +
          '<div class="cv-pgbar"><span class="cv-dots"><i></i><i></i><i></i></span><span class="cv-url" title="' + esc(String(n.summary || "").slice(0, 120)) + '">' + esc(url) + "</span>" + (isMain ? '<span class="cv-pgmain-tag">主线</span>' : "") + "</div>" +
          '<div class="cv-pgtitle" title="' + esc(n.label) + '">' + (n.done ? '<span class="bf-done">' + ic("check") + " </span>" : "") + esc(n.label) +
          '<span class="bd-tag lk-moved cv-cmts" title="' + cmtN + ' 条评论"' + (cmtN ? ' style="margin-left:6px;vertical-align:1px"' : ' style="display:none"') + ">评 " + cmtN + "</span></div>" +
          '<span class="cv-port in"></span><span class="cv-port out"></span></div>';
      }
      const kindTag = n.kind === "component" ? "组件" : "区块";
 // fixE2:线框卡(section/component)补评论徽标——此前只有普通卡分支有 .cv-cmts,线框卡带评论不可见(服务端落盘回显全对,纯渲染层缺失)
      const wCmtN = (n.comments && n.comments.length) || 0;
      return '<div class="cv-node cv-wire rw-' + (role || "main") + selCls + layCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + sz.w + "px;height:" + sz.h + 'px;border-color:' + hue.bd + '">' +
        '<div class="cv-wire-tt" style="background:' + hue.tint + '"></div>' +
        '<span class="cv-wire-label" title="' + esc(kindTag + ":" + n.label + (n.summary ? " · " + String(n.summary).slice(0, 80) : "")) + '">' + (n.done ? '<span class="bf-done">' + ic("check") + " </span>" : "") + esc(n.label) + "</span>" +
        '<span class="bd-tag lk-moved cv-cmts" style="flex-shrink:0;font-size:9px;' + (wCmtN ? "" : "display:none;") + '">评 ' + wCmtN + "</span>" +
        '<span class="cv-dot ' + lkCls + '" title="' + (lk ? (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") : "无代码连接") + '"></span></div>';
    }
    const f = n.symbolRef && n.symbolRef.file ? String(n.symbolRef.file).split("/").slice(-1)[0] : "";
 // 工作流板运行态类+角标(全量渲染路径;增量路径走 bdWfApplyStates 原位切类)
    const wfRun = boardTaskId && wfRuns[boardTaskId];
    const wfSt = wfRun && wfRun.states ? wfRun.states[n.id] : null;
    const wfCls = wfSt ? " wf-" + wfSt.state : "";
    const wfBadge = wfSt ? '<span class="cv-wf-badge ' + wfSt.state + '" title="' + esc((wfSt.detail || "") + (wfSt.ms !== undefined ? " " + wfSt.ms + "ms" : "")) + '">' + (wfSt.state === "running" ? "运行中" : wfSt.state === "done" ? "完成" + (wfSt.ms !== undefined ? " " + wfSt.ms + "ms" : "") : "失败") + "</span>" : "";
 // fixH2 流动布局节点元信息:编号(01..N)/主线/入口/出口身份/引擎确定尺寸(与边端口几何一致)
    const fMeta = cvFlowInfo ? {
      no: cvFlowInfo.no.get(n.id) || "",
      main: cvFlowInfo.mainNodes.has(n.id),
      entry: cvFlowInfo.entry === n.id,
      exit: cvFlowInfo.exit === n.id,
      sz: cvFlowInfo.size.get(n.id),
    } : null;
    const fCls = fMeta ? ((fMeta.main ? " cv-flow-main" : "") + (fMeta.entry ? " cv-node-entry" : "") + (fMeta.exit ? " cv-node-exit" : "")) : "";
    const fStyle = fMeta && fMeta.sz ? ";width:" + fMeta.sz.w + "px;height:" + fMeta.sz.h + "px" : "";
    const fBadges = fMeta
      ? '<span class="cv-no" title="节点编号">' + esc(fMeta.no) + "</span>" +
        (fMeta.entry ? '<span class="cv-entry-badge" title="入口:流程起点">入口</span>' : "") +
        (fMeta.exit ? '<span class="cv-exit-badge" title="出口:流程终点">出口</span>' : "")
      : "";
 // 阶段卡(ph-*,task_phase 推的「00 流程」泳道节点):不是工作流模块,不参与主线/编号/端口语义。
 // 语义从标签/摘要里读(agent-wiring 写的是「规划◀」/「验收(不涉及)」/summary=不涉及:note):
 // ◀=当前阶段(强调色描边)、不涉及(skip)=整卡降透明。
    const isPh = /^ph-/.test(String(n.id));
    const phCur = isPh && String(n.label || "").indexOf("◀") >= 0;
    const phSkip = isPh && (String(n.label || "").indexOf("(不涉及)") >= 0 || String(n.summary || "").indexOf("不涉及") === 0);
    const phCls = isPh ? " cv-ph" + (phCur ? " cv-ph-cur" : "") + (phSkip ? " cv-ph-skip" : "") : "";
 // 工程师流程图形态:start/end 药丸、decision 菱形。flow 板由 planner 用 start/decision/end 触发。
 // 药丸/菱形补 change 徽标(绝对定位,不参与胶囊/菱形的列布局预算 → 220×64 与 132×132 不撑破)。
    const chgPill = cvChangeBadge(n, "cv-chg", true);
    if (cvCodeInfo && (n.kind === "start" || n.kind === "end")) {
      return '<div class="cv-node k-' + esc(n.kind) + ' cv-code-node cv-code-pill' + selCls + layCls + '" data-cv="' + esc(n.id) +
        '" title="' + esc(String(n.label || "") + " · " + String(n.summary || "")) + '" style="left:' + p.x + "px;top:" + p.y + "px" + fStyle + '">' +
        chgPill + '<span class="cv-pill-label">' + esc(n.label) + "</span><small>" + esc(String(n.summary || "").slice(0, 58)) + "</small></div>";
    }
    if (cvCodeInfo && n.kind === "decision") {
      var diaFlow = Array.isArray(n.flow) ? n.flow : [];
      var diaBranch = null, diaStep = null;
      for (var di = 0; di < diaFlow.length; di++) {
        if (!diaBranch && diaFlow[di] && diaFlow[di].type === "branch") diaBranch = diaFlow[di];
        if (!diaStep && diaFlow[di] && diaFlow[di].type === "step") diaStep = diaFlow[di];
      }
      var diaCond = (diaBranch && diaBranch.cond) || (diaStep && diaStep.text) || String(n.summary || "");
      return '<div class="cv-node k-decision cv-code-node cv-decision-diamond' + selCls + layCls + '" data-cv="' + esc(n.id) +
        '" title="' + esc(String(n.label || "") + " · " + String(n.summary || "")) + '" style="left:' + p.x + "px;top:" + p.y + "px" + fStyle + '">' +
        chgPill + '<div class="cv-dia"></div><div class="cv-dia-txt"><b>' + esc(n.label) + "</b><span>" + esc(String(diaCond).slice(0, 70)) + "</span></div></div>";
    }
    return '<div class="cv-node k-' + esc(n.kind) + codeCls + selCls + layCls + wfCls + fCls + phCls + '" data-cv="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px" + fStyle + '">' +
      (isPh ? "" : fBadges) +
      (isPh ? "" : '<span class="cv-port in"></span><span class="cv-port out"></span>') +
      '<div class="cv-head"><span class="cv-kind cv-k-' + esc(n.kind) + '" title="' + esc(CV_KIND_NAME[n.kind] || n.kind) + '">' + (CV_KIND_ICON[n.kind] || "?") + "</span>" +
      '<span class="cv-title" title="' + esc(n.label) + '"><span class="cv-done bf-done">' + (n.done ? ic("check") + " " : "") + "</span>" + esc(n.label) + "</span>" +
      wfBadge +
      bdAccInline(n) +
 // code flow 卡头不再重复渲 change(同一信息已在卡脚 .cv-file-foot / 药丸 / 菱形徽标上),
 // 省出的标题槽给 .cv-title;通用卡(非 code flow)逐字不变。字面串保留(测试按源码序断言)。
      (isPh || (cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow) ? "" : '<span class="bd-tag ' + n.change + '">' + BD_CHANGE[n.change] + "</span>") + "</div>" +
      (cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow
        ? cvCodeFlowBodyHtml(n, c4)
        : ((c4 ? cvC4Html(n) : "") +
          '<div class="cv-sum" title="' + esc(String(c4 ? c4.desc : n.summary || "")) + '">' + esc(String(c4 ? c4.desc : n.summary || "").slice(0, c4 ? 96 : 64)) + "</div>" +
          cvTypeNodeHtml(n, doc, cvFlowInfo))) +
 // 逻辑层口径:modify/delete 卡在代码框下方补一行「现状:<before>」(keep/add 不出)
      (cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow ? cvBeforeHtml(n) : "") +
 // 仓库关系上屏(code flow 卡):targets 文件名 + 变更徽标,贴在正文与页脚之间的一行
      (cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow ? cvFileFootHtml(n) : "") +
 // 阶段卡(ph-*)不是工作流模块:页脚不挂代码连接点/「新模块」/评论徽标(无意义噪音),只留摘要
      (isPh ? "" : (n.id === "__cv_current"
        ? '<div class="cv-foot"><span class="cv-code-baseline-tag">现状基线 · 细节见右侧栏</span></div>'
        : '<div class="cv-foot"><span class="cv-dot ' + lkCls + '" title="' + (lk ? (lk.state === "linked" ? "已连接" : lk.state === "moved" ? "漂移" : "断链") : "无代码连接") + '"></span>' +
          (n.symbolRef && n.symbolRef.file ? '<span class="cv-file" data-cvfile="' + esc(n.symbolRef.file) + '" title="' + esc("打开代码档案 · " + n.symbolRef.file + (n.symbolRef.line != null ? ":" + n.symbolRef.line : "") + (n.symbolRef.name ? " · " + n.symbolRef.name : "")) + '">' + esc(f) + (() => { const ln = lk && lk.line ? lk.line : n.symbolRef.line; return ln != null && ln !== "" ? ":" + ln : ""; })() + "</span>" : (n.fileRef ? '<span class="cv-file" data-cvfile="' + esc(n.fileRef) + '" title="打开代码档案">' + esc(String(n.fileRef).split("/").slice(-1)[0]) + "</span>"
 // 续:卡脚已出 targets 文件名(code flow 的 .cv-file-foot)时,底栏再说「新模块」
 // 会与「改/复用某个已存在文件」直接矛盾(经验证截图里同一张卡既有 src/panel.ts 又写新模块)。
            : ((cvCodeInfo && cvFlowInfo && cvFlowInfo.codeFlow && Array.isArray(n.targets) && n.targets.length)
              ? '<span class="cv-file" data-cvfile="' + esc(String(n.targets[0])) + '" title="打开代码档案">' + esc(String(String(n.targets[0]).split("#")[0]).split("/").slice(-1)[0]) + "</span>"
              : "<span>新模块</span>"))) +
          '<span class="bd-tag lk-moved cv-cmts"' + (n.comments && n.comments.length ? "" : ' style="display:none"') + ">评 " + (n.comments ? n.comments.length : 0) + "</span></div>")) + "</div>";
  }).join("");
 // w1 写者 chip 条(画布左上浮动;≥2 个写者才出现——单写者板上是纯噪音,page 板不适用):
 // 默认全选,点一下=切换该写者(多选);过滤态给出「只看 a1/b1 · 共 12/60 节点」+「显示全部」。
 // svg 模式若板上有可折叠分组(≥5 节点的大组,或 ≥12 条碎泳道),即使单写者也给条:
 // 至少能点「折叠分组」减少图面节点(只数大组会让 35 条碎泳道的真板永远没入口)。
  const cvFoldAvail = cvRenderMode() === "svg" && cvFoldAvailable(doc);
  let wbarHtml = "";
  if (!cvPageInfo && (cvWriterAll.length >= 2 || cvFoldAvail)) {
    const onSet = cvWriterOn;
    const chips = cvWriterAll.map((c) => {
      const on = !onSet || onSet.has(c.pfx);
      return '<span class="cv-wchip' + (on ? " on" : "") + '" data-wpfx="' + esc(c.pfx) + '" title="' +
        (on ? "点一下隐藏 " + cvWriterLabel(c.pfx) : "点一下只看 " + cvWriterLabel(c.pfx)) + '">' + esc(cvWriterLabel(c.pfx)) + " (" + c.n + ")</span>";
    }).join("");
    const foldChip = cvFoldAvail
      ? '<span class="cv-wchip' + (cvFoldGroups ? " on" : "") + '" data-cvfold="1" title="把 ≥5 个节点的分组折成一个汇总节点;碎泳道(≥12 条 1~4 节点小组)合并成一个「其他分组」节点">折叠分组 (' + cvGroupCount(doc) + (cvGroupCount(doc) ? "" : " 大组") + ')</span>'
      : "";
    const hint = onSet
      ? '<span class="cv-whint">只看 ' + esc([...onSet].sort().map(cvWriterLabel).join("/")) + " · 共 " + cvRenderDoc.nodes.length + "/" + doc.nodes.length + ' 节点</span>' +
        '<span class="cv-wall" data-wall="1" title="清除写者过滤,显示全部节点">显示全部</span>'
      : "";
    wbarHtml = '<div class="cv-wbar" id="cvWbar" style="' + (cvTypeProfileOf(doc) ? "top:100px;z-index:6;max-width:calc(100% - 24px)" : "") + '">' + chips + foldChip + hint + "</div>";
  }
 // 「看得懂」层 chip(现状层 N / 变更层 M):与写者 chip 条紧邻一行(不塞进 .cv-wbar,
 // 那条有自己的「≥2 写者才出」条件);点击=只高亮该层(见 cvLayerPaint),再点取消。
 // 只在 code/test/perf/refactor 板出——其它板型的「现状/变更」两组标签会被误读。
  const layChips = cvPageInfo || cvUiInfo ? "" : cvLayerChipsHtml(doc);
  let lbarHtml = "";
  if (layChips && !ro) {
 // 修经验证遮挡:原先按写者条/板头写死 30/58/100/128px 推断,截图里层 chip 直接压在板型头
 // (.cv-type-head,高约 69px)与主题横幅(.cv-theme-band,top 44 起约 34px)上。改为**先按 0 定位渲染**,
 // 由 cvStackTopBars 在渲染尾部量经验证矩形后逐条下推(见 renderBoardCanvas 末尾调用)。
    lbarHtml = '<div class="cv-wbar cv-lbar" id="cvLbar" style="top:0px;z-index:8">' + layChips + "</div>";
  }
 // K:图例/工具条不再覆盖画布内容——统一放画布外的底部占位条 #cvRail(.cv-rail)。
 // 原理:#cvHost 在 .board-graph / .bf-graph 的 flex 列里 flex:1,占位条占高后画布自然收缩,
 // 卡片永不被图例条压住(cvFitNow 也因此不必再 legendReserve 重复预留);只读画布(R/O)无工具条。
  const cvRailLegends =
    (cvPageInfo && !cvUiInfo ? '<div class="cv-legend" title="语义图例"><span class="lg-main"></span>主线(用户主路径)<span class="lg-branch"></span>分支跳转<span class="lg-back"></span>返回/上一步<span class="lg-box"></span>页面容器(内为 UI 线框)<span class="lg-tag">边标签=触发动作</span></div>' : "") +
 // fixH2 流动板图例:主线/分支/入口/出口/泳道 + 边标签语义
 // 2026-11 composition 作业思路板图例:章间关系词(承接/递进/并列/对照/因果)是图的语义主信息,
 // 受众/结构收属性卡区——通用 flow 文案(数据格式/触发条件)在这里是误导,换专用条。
    (cvFlowInfo && !cvCodeInfo && cvFlowInfo.compose ? '<div class="cv-legend cv-legend-flow" title="作业思路板图例"><span class="lg-main"></span>章节主线(入口→出口)<span class="lg-branch"></span>章间关系边<span class="lg-entry"></span>开篇<span class="lg-exit"></span>收尾<span class="lg-lane"></span>主题带/章节/属性卡区<span class="lg-tag">边标签=章间关系(承接/递进/并列/对照/因果)· 属性卡=受众/结构</span></div>' : "") +
    (cvFlowInfo && !cvCodeInfo && !cvFlowInfo.compose ? '<div class="cv-legend cv-legend-flow" title="图例"><span class="lg-main"></span>主线(入口→出口)<span class="lg-branch"></span>分支/其他<span class="lg-entry"></span>入口<span class="lg-exit"></span>出口<span class="lg-lane"></span>泳道(阶段分组)<span class="lg-tag">边标签=数据格式/触发条件</span>' +
      (cvFlowInfo.wrap && cvFlowInfo.wrap.active ? '<span class="lg-wrap" title="主路径超过 4 列:按 4 列折行,行内仍是左→右;点「全」可全览">宽板折行 ' + cvFlowInfo.wrap.cols + " 列×" + cvFlowInfo.wrap.rows + " 行</span>" : "") + "</div>" : "") +
 // 工程师图形态(code):C4 元素类型 + 关系线型;code 板只出这一条图例,避免多条图例叠底。
    (cvCodeInfo ? '<div class="cv-legend cv-legend-code" title="C4/数据流图例">' +
      '<span class="lg-c4 c4-person"></span>Person<span class="lg-c4 c4-system"></span>System<span class="lg-c4 c4-container"></span>Container<span class="lg-c4 c4-component"></span>Component<span class="lg-c4 c4-store"></span>Store<span class="lg-c4 c4-decision"></span>Decision<span class="lg-ccall"></span>call<span class="lg-cdata"></span>data<span class="lg-cverify"></span>verify<span class="lg-tag">边标签=动作 [协议/数据]</span></div>' : "") +
 // 关系图例:设计板在有边时给出
 // 「按关系类型分色 + 虚线=自动推导待核实」说明,让人知道连线含义而不只是看到一堆线。
    (relLegend && !cvCodeInfo ? '<div class="cv-legend" title="关系图例"><span class="lg-call"></span>调用<span class="lg-data"></span>数据流<span class="lg-verify"></span>验收<span class="lg-nav"></span>次序/导航<span class="lg-virtual"></span>推导边(待核实)<span class="lg-tag">点节点看来源</span></div>' : "");
  const cvRailHtml = !cvRailLegends && ro ? "" : '<div class="cv-rail" id="cvRail">' + cvRailLegends +
    (ro ? "" : cvRailAddbarHtml(cvMode)) + "</div>";
 // flowkit 单张 SVG(默认)/ 逐节点卡片(回滚)双路拼串:
 // · svg 模式:laneHtml + edgeSvg + cards 三块整体换成 #cvSvgHost 里的那张 SVG(回包前为空壳);
 // 浮层/图例(cvUiHeadHtml/cvUiPopupMaskHtml/cvUiAnchorOverlay/cvFoldHtml/cvTypeHeadHtml)保持原样。
 // · cards 模式:与改造前逐字相同(localStorage.cvRender="cards" 单点回滚)。
 // P0 修复(经验证:回包到了但画布空):①此前此处拼的是**又一个** #cvSvgHost 外壳,而
 // cvWorldBodyHtml 已经用 p.svg 包了一层主机 → DOM 里出现两层同名 #cvSvgHost(外层空壳套内层),
 // querySelector("#cvSvgHost") 拿到外层,"#cvSvgHost > svg" 永远落空;此处改为只传**裸 svg 文本**。
 // ②更致命的是 data-sig:空壳帧(回包未到)也把 data-sig 写成**当前** sig,回包后
 // cvSvgPatchPlan(now, domSig, true) 读到 domSig===now → 恒判 "keep" → 注入分支永不可达(经验证
 // innerHTML 恒 100 字节空壳、#cvWorld svg=0)。data-sig 的语义必须是「DOM 里真装着的那一版」:
 // 只有内容真在(zip 命中且非空)才写 sig,否则留空 → 决策走 wait/inject。
  const cvSvgHasNow = cvMode === "svg" && cvSvgCacheSig === cvSvgSigNow && !!cvSvgCacheHtml;
  const cvSvgBodyHtml = cvMode === "svg" ? (cvSvgHasNow ? cvSvgCacheHtml : "") : "";
 // A1(经验证:点「添加模块」后 2.5~3.4s 窗口 #cvSvgHost [data-node-id]=0、画布全空 = 用户眼里
 // 「点了没反应」):新图的 rev 一到,缓存签名就对不上 → 旧实现把 body 置空 = 白屏。改为**继续显示上一版 svg**,
 // 只打 data-stale="1"(CSS 降透明度)表示「还在出图」;data-sig 与 body 用同一版(旧 sig),故
 // cvSvgPatchPlan 仍判 inject,回包后 cvSvgTryPatch 整块换图并抹掉 data-stale。
  const cvSvgStale = cvMode === "svg" && !cvSvgHasNow && !!cvSvgCacheHtml;
  const cvSvgBodyOut = cvSvgStale ? cvSvgCacheHtml : cvSvgBodyHtml;
  const cvSvgBodySig = cvSvgStale ? cvSvgCacheSig : cvSvgSigNow;
  host.innerHTML = '<div class="bf-canvas" id="cvHost"><div class="bf-cv-world' + (cvFlowInfo ? " cv-flow-world" : "") + (cvCodeInfo ? " cv-code-world" : "") + (cvUiInfo ? " cv-ui-world" : "") + (cvFlowInfo && cvFlowInfo.wrap && cvFlowInfo.wrap.active ? " cv-flow-wrap" : "") + '" id="cvWorld">' + cvUiHeadHtml(cvUiInfo) + cvWorldBodyHtml(cvMode, { laneHtml: laneHtml, edgeSvg: edgeSvg, popupMask: cvUiPopupMaskHtml(cvUiInfo), cards: cards, anchors: cvUiAnchorOverlay(cvUiInfo, Math.max(maxX + 60, 600), Math.max(maxY + 60, 400)), fold: cvFoldHtml, svg: cvSvgBodyOut, sig: cvSvgBodySig, stale: cvSvgStale }) + "</div>" + cvTypeHeadHtml(doc, cvFlowInfo) + (cvCodeInfo && cvCodeSideNodes.length ? cvCodeSideHtml(cvCodeSideNodes) : "") +
 // 十期:画布直操作件——「添加模块/整理」按钮已挪到画布外底部占位条(cvRailHtml, K:原为右上浮层压卡);
 // 工具箱面板 .cv-addpanel 仍留在 cvHost 内(绝对定位在画布上,点击落点/关闭判定都按画布坐标)。
    (ro ? "" : '<div class="cv-addpanel" id="cvAddPanel" style="display:none"></div>') +
 // 九期:缩放控件(±/百分比/适配)+小地图(只读画布保留=视图交互,非编辑件)
    '<div class="bf-zoombar" id="cvZoom"><button id="cvZin" title="放大">+</button><span class="bf-zpct" id="cvZpct">100%</span><button id="cvZout" title="缩小">−</button><button id="cvZfit" title="适配全部" style="font-size:10px">适</button><button id="cvZall" title="全览:缩到能看全整块板(标签可能变小,可再放大)" style="font-size:10px">全</button></div>' +
    '<canvas class="bf-minimap" id="cvMini" width="148" height="96" title="小地图(点按跳转;盖住节点时点按=操作节点)"></canvas>' +
 // K:四条图例(页面/流/代码/关系)已全部挪到画布外的底部占位条(cvRailHtml),
 // 不再作为画布底部绝对定位浮层盖住卡片;画布高度由 .cv-rail 自然扣减。
    "<div class='bd-meta bd-meta-canvas'>" + cvMetaHtml(doc, ro) + "</div>" +
 // 主题横幅:横贯板首,浮在画布顶部(绝对定位 + pointer-events:none)、不占 flow 布局位、
 // 不参与连线/小地图;板上无主题节点时返回空串(旧板逐字不变)。cvFitNow 会为它多预留顶部高度,
 // 所以首帧适配后卡片不会落到横幅下面(经验证口径:code 板 topReserve 88px 已含该条)。
    (cvCodeInfo ? cvThemeBandHtml(doc) : "") +
    (mxBoard && !ro ? '<button class="cv-matrix-btn" id="cvMatrixBtn" title="research 板:切换到「候选 × 维度」决策矩阵表格(点单元格看节点/证据全文)">矩阵</button>' : "") +
    (uiAvail && !ro ? '<button class="cv-ui-mode-btn" id="cvUiModeBtn" title="' + (uiOn ? "切回页面结构板(容器/区块层级视图)" : "切到交互流程图(多屏原型+元素级跳转+彩色流线)") + '">' + (uiOn ? "结构" : "交互") + "</button>" : "") +
    wbarHtml + lbarHtml + "</div>" + cvRailHtml;
  host.__cvSig = cvMode === "svg" ? cvSvgSigNow : sig; // 增量渲染锚:svg 模式=rev+模式;cards 模式=结构签名
  cvSvgApplySel(host.querySelector("#cvSvgHost")); // 首帧就把选中态回放到 svg 上(boardSelNode 可能来自上一版)
 // 层高亮首帧:cards 路径已在 layCls 里带类;svg 路径的 <g> 不是 .cv-node,这里补一次。
  try { cvLayerPaint(); } catch (e) { /* 高亮失败不影响画布 */ }
 // 顶部浮层纵向堆叠(板型头/主题横幅/写者条/层 chip 经验证高度后逐条下推,防互相压住)
  try { cvStackTopBars(host); } catch (e) { /* 堆叠失败不影响画布 */ }
 // 注:cvSvgCacheSig 由 board.diagram.result 分发处回填(只有真拿到某 rev 的 svg 才算缓存),此处不改。
  const mxBtnEl = host.querySelector("#cvMatrixBtn"); // B:research 板矩阵切换(全量重建后重绑;补丁路径沿用旧 handler)
  if (mxBtnEl) mxBtnEl.onclick = () => { cvMatrixOn = true; cvMatrixSel = null; renderBoard(); };
  const uiModeBtnEl = host.querySelector("#cvUiModeBtn");
  if (uiModeBtnEl) uiModeBtnEl.onclick = () => { cvUiMode = cvUiMode === "interaction" ? "structure" : "interaction"; cvViewTouched = false; renderBoard(); };
 // /fixH2 大板缩放适配:page 板容器化世界宽(45 节点≈7 层横贯)/流动板 12 节点横贯,
 // 全量渲染后自动适配视野,不让用户面对一片空白自己找图(增量补丁路径不 fit,不打断用户 pan/zoom)
 // 仅在「用户还没手动动过视野」时自动适配——否则保存回执/agent 回写的全量重渲
 // 会把用户正在看的细部(如 k=1.6)静默复位到适配值,零提示且连低倍率 toast 都不触发。
 // J:门槛从 8 降到 4——7 节点的 contract/design 类板同样走布局引擎(世界高 500+px),
 // 不 fit 就停在 k=1,经验证 5/7 张卡有大半落到 420px 画布可视区外(隐藏 31%),且底排被图例压住。
  if ((cvPageInfo || cvFlowInfo) && doc.nodes.length >= 4 && !cvViewTouched) setTimeout(() => { try { cvFitNow(); } catch (e) { /* 忽略 */ } }, 40);
  cvActiveHost = host.querySelector("#cvHost"); // 全局单活:后续 cvHostEl/cvScoped 都定位到这里(档案画布在场时裸 getElementById 会摸错)
  const apply = () => {
    cvApplyTf(); // 世界变换+缩放百分比+点阵网格随缩放/平移(十期)
    drawMini(); // 平移/缩放同步小地图视口框
  };
  function drawMini() { if (typeof cvDrawMini === "function") cvDrawMini(host, doc, pos); }
  apply();
  cvApplyTf(); // 九期竞态修复:重建 DOM 后 zpct 回初始文本——同步真实 k(否则显示 100% 假象)
 // 画布平移(空白处)+缩放
  const cvHost = cvActiveHost;
  let panning = null;
 // B(经验证:真鼠标在节点中心拖 120px → cvPan 位移 0,用户以为「画布拖不动」):
 // 默认**任何位置**(含节点/边/分组)左键拖动 = 平移整张图;节点「点选」不在 pointerdown 里做,
 // 挪到 pointerup 且位移 <4px 才结算为点击。节点自己接管只在编辑态(boardEditOn)。
 // 必须在平移监听**之前**注册(同元素监听按注册序触发)。
  let cvSvgDown = null; // 按下时命中的节点(供 pointerup 判「这是点击不是平移」)
  if (cvMode === "svg") cvHost.addEventListener("pointerdown", (e) => {
    if (ro) return; // 只读画布(设计沉淀):boardSelNode/renderBoardDetail 是会话板全局,不能被档案画布摸
    const id = cvSvgNodeAt(e);
    if (cvLinkFrom) {
 // 连线态(A5):点目标节点=收线;不 start 平移、不改选中
      if (!id) return;
      e.preventDefault();
      if (id !== cvLinkFrom) cvLinkAskWord(cvLinkFrom, id);
      return;
    }
 // 不 preventDefault / 不 stopPropagation:节点上也照常走下面的平移分支
    cvSvgDown = id ? { id: id, sx: e.clientX, sy: e.clientY } : null;
  });
  cvHost.addEventListener("pointerdown", (e) => {
 // B:默认拖动=平移整图。svg 视图**没有**节点拖拽实现(坐标由服务端布局决定,
 // 前端拖了也存不住),所以编辑态也照常平移 —— 旧口径编辑态早退会造出一块
 // 「既不平移、也拖不动节点」的死区(用户报「鼠标滑到图内就移动不了整张图」的残留一半)。
    if (cvMode === "svg" && cvLinkFrom) return; // 连线态:点目标=收线,不起平移
    if (e.target.closest(".cv-node") || e.target.closest(".cv-file")) return;
 // 十期:浮层可交互件不启平移——setPointerCapture 会把后续 pointer 事件拽到 cvHost,
 // 浮层按钮的 click 事件就此蒸发(右键菜单项经验证点不动)
    if (e.target.closest(".cv-ctx") || e.target.closest(".cv-addpanel") || e.target.closest(".cv-addbar") || e.target.closest(".cv-link-word") || e.target.closest(".bf-zoombar") || e.target.closest(".bf-minimap") || e.target.closest(".cv-matrix-btn") || e.target.closest(".cv-ui-mode-btn")) return;
 // w1/w2:写者 chip 条与 +N 计数块是交互件(setPointerCapture 会吞掉它们的 click,且不该起平移)
    if (e.target.closest(".cv-wbar") || e.target.closest(".cv-fold")) return;
    if (e.shiftKey) return; // shift+空白=框选(marquee 监听处理),不平移
    panning = { sx: e.clientX, sy: e.clientY, ox: cvPan.x, oy: cvPan.y };
    cvHost.classList.add("panning");
    if (cvHost.setPointerCapture) { try { cvHost.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
  });
  cvHost.addEventListener("pointermove", (e) => {
    if (!panning) return;
    cvViewTouched = true; // 真平移=用户动过视野(此后自动适配不得覆盖)
    cvPan.x = ox_of(panning, e, "x"); cvPan.y = ox_of(panning, e, "y");
    apply();
  });
  const pend = (e) => {
    panning = null; cvHost.classList.remove("panning");
 // B:节点点选在 pointerup 结算——位移 <4px 才算「点击」,否则这一下就是平移过。
 // 注:平移分支 setPointerCapture(cvHost) 会把 pointerup 的 target 重定向到 cvHost,
 // 所以这里**只能**按按下时记录的命中 id + 位移判定,不能再拿 e.target 反查节点。
    const d = cvSvgDown; cvSvgDown = null;
    if (!d || !e || e.type !== "pointerup") return;
    if (Math.abs((e.clientX || 0) - d.sx) + Math.abs((e.clientY || 0) - d.sy) >= 4) return;
    boardSelNode = (boardSelNode === d.id) ? null : d.id; // 再点一次取消选中
    cvSvgApplySel(cvHost);
    try { renderBoardDetail(); } catch (err) { /* 明细卡失败不影响选中 */ }
  };
  cvHost.addEventListener("pointerup", pend);
  cvHost.addEventListener("pointerleave", pend);
 // w1/w2 交互(委托在 cvHost 上,重建后随新 DOM 重新绑定):
 // · 写者 chip → 切换可见写者集合(全选态=null;选中集合变了就按子集重排布局)
 // · 「显示全部」→ 清过滤; · .cv-fold → 展开该泳道(展开集合 cvFoldOpen)后重渲染
  cvHost.addEventListener("pointerdown", (e) => {
    const tg = e.target && e.target.closest ? e.target.closest("[data-wpfx],[data-wall],[data-fold],[data-cvfold],[data-cvlay]") : null;
    if (!tg) return;
    e.preventDefault();
    e.stopPropagation();
    if (tg.hasAttribute("data-cvlay")) {
 // 层 chip:只高亮该层(再点同一个=取消)。纯 DOM 切类,不重排布局/不重算连线——零布局风险。
      const k = tg.getAttribute("data-cvlay") || "";
      cvLayerOn = cvLayerOn === k ? "" : k;
      for (const el of cvHost.querySelectorAll("[data-cvlay]")) el.classList.toggle("on", el.getAttribute("data-cvlay") === cvLayerOn);
      cvLayerPaint();
      return;
    }
    if (tg.hasAttribute("data-cvfold")) {
      cvFoldGroups = !cvFoldGroups; // 折叠分组:让服务端出图时把大分组收成汇总节点
    } else if (tg.hasAttribute("data-wall")) {
      cvWriterOn = null;
    } else if (tg.hasAttribute("data-wpfx")) {
      const pfx = tg.getAttribute("data-wpfx") || "";
      const all = cvWriterAll.map((c) => c.pfx);
      const cur = cvWriterOn ? new Set(cvWriterOn) : new Set(all);
      if (cur.has(pfx)) cur.delete(pfx); else cur.add(pfx);
 // 全选/全不选都回收成 null(=不过滤):空集合没有「看哪些」的语义,别把板画成空白
      cvWriterOn = (!cur.size || cur.size === all.length) ? null : cur;
    } else {
      const k = tg.getAttribute("data-fold") || "";
      if (cvFoldOpen.has(k)) cvFoldOpen.delete(k); else cvFoldOpen.add(k);
    }
    renderBoardCanvas(doc, opts); // 重渲染(过滤/展开后按新子集重排布局)
  });
  cvHost.addEventListener("wheel", (e) => {
 // 滚轮作用域分流(用户用户反馈:画布滚轮把容器/浮层一起滚):
 // · 画布内自带可滚浮层(添加模块工具箱 .cv-addpanel{max-height:308px;overflow-y:auto},及任何
 // overflow-y:auto/scroll 且真的溢出的子层)上滚轮=滚它自己的列表,交给浏览器默认行为
 // (既不缩放也不拦默认滚动)——与 canvas-shell 的 scrollableUnder 同一口径。
 // · 其余区域(节点/泳道/空白)=缩放画布,preventDefault+stopPropagation:不许页面/祖先容器
 // (.board-graph{overflow:auto}、body)跟着滚,也不给外层 wheel 监听(旧 SVG 图视图)二次处理。
 // 清单(#boardNodes)/明细(#boardDetail)在 cvHost 之外,天然只滚自己(探针经验证见 boardscroll.spec)。
    const scrollHost = (() => {
      for (let n = e.target; n && n !== cvHost; n = n.parentElement) {
        if (!n.classList) continue;
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 2) return n;
      }
      return null;
    })();
    if (scrollHost) return;
    e.preventDefault();
    e.stopPropagation();
    cvViewTouched = true; // 用户手动缩放:此后自动适配不得再覆盖视野
    const factor = e.deltaY < 0 ? 1.08 : 0.93;
    const nk = Math.min(2, Math.max(0.35, cvPan.k * factor));
 // 缩放锚点=鼠标位置(世界坐标不动)
    const r = cvHost.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    cvPan.x = mx - ((mx - cvPan.x) / cvPan.k) * nk;
    cvPan.y = my - ((my - cvPan.y) / cvPan.k) * nk;
    cvPan.k = nk;
    apply();
  }, { passive: false });
 // 节点点击(选中→明细卡)与拖拽(存 pos);只读画布:拖拽禁用,点击=本画布内高亮(不碰会话板全局)
  for (const el of host.querySelectorAll(".cv-node")) {
    let dragNode = null;
    el.addEventListener("pointerdown", (e) => {
      if (ro || e.target.closest(".cv-file")) return;
      const p = pos.get(el.dataset.cv) || { x: 0, y: 0 };
 // 续作轮:基位取 doc 现值(增量补丁路径不重建卡片,闭包 pos 可能落后于 doc——拖拽起跳跳回旧位的根治)
      const curDoc = boardEditOn && boardDraft ? boardDraft : boardDoc;
      const curNode = curDoc && curDoc.nodes.find((x) => x.id === el.dataset.cv);
 // 交互地图不读盘上 pos(旧页面板固化位会把新网格打散),基位取当前引擎位
      const p0 = (cvUiInfo ? p : (curNode && curNode.pos && isFinite(curNode.pos.x)) ? curNode.pos : p);
      dragNode = { sx: e.clientX, sy: e.clientY, ox: p0.x, oy: p0.y, id: el.dataset.cv, moved: false };
      el.classList.add("dragging");
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => {
      if (!dragNode) return;
      if (!dragNode.moved) {
        dragNode.moved = true;
 // 容器拖拽收集 contains 子节点原位(容器与内容一体,整体平移)。
 // 用户用户反馈修复:①弃 cvPageInfo 全局量做条件——整板 pos 固化后它为 null,
 // 第二次拖拽起子节点全不跟随(用户 repro 的根因);②直接子→contains 传递闭包
 // (section 下的 component 漏收);③基位取 doc 现值优先(闭包 pos 增量补丁后可能落后,同 dragNode p0 纪律)。
 // 节点定位走 dataset 全扫(不拼选择器——agent 板节点 id 可含选择器特殊字符,同 cvPatchCanvas 纪律)
        if (doc.docKind === "page") {
          const kidIds = new Set();
          const frontier = [dragNode.id];
          while (frontier.length) {
            const curId = frontier.pop();
            for (const ed of doc.edges) {
              if (ed.kind !== "contains" || ed.from !== curId || kidIds.has(ed.to) || ed.to === dragNode.id) continue;
              kidIds.add(ed.to); frontier.push(ed.to);
            }
          }
          if (kidIds.size) {
            const all = host.querySelectorAll(".cv-node");
            dragNode.kids = [];
            for (const kid of kidIds) {
              const kn = doc.nodes.find((x) => x.id === kid); // 闭包 doc=本画布渲染文档(编辑态=草稿);curDoc 是 pointerdown 作用域量,此处引用=ReferenceError(插桩实测确认)
              const kp = (cvUiInfo ? pos.get(kid) : (kn && kn.pos && isFinite(kn.pos.x)) ? kn.pos : pos.get(kid));
              let kel = null;
              for (const x of all) if (x.dataset.cv === kid) { kel = x; break; }
              if (kp && kel) dragNode.kids.push({ id: kid, ox: kp.x, oy: kp.y, el: kel });
            }
          }
        }
      }
      dragNode.moved = true;
      const nx = Math.max(0, dragNode.ox + (e.clientX - dragNode.sx) / cvPan.k);
      const ny = Math.max(0, dragNode.oy + (e.clientY - dragNode.sy) / cvPan.k);
      el.style.left = nx + "px"; el.style.top = ny + "px";
      pos.set(dragNode.id, { x: nx, y: ny });
      if (cvUiInfo && el.classList.contains("cv-ui-screen")) {
        const cap = host.querySelector('.cv-ui-cap[data-uicap="' + cssEsc(dragNode.id) + '"]');
        if (cap) { cap.style.left = nx + "px"; cap.style.top = (ny - CV_UI_CAP_H + CV_UI_CAP_PAD) + "px"; }
      }
      if (dragNode.kids) {
        for (const k of dragNode.kids) {
          const kx = Math.max(0, k.ox + (nx - dragNode.ox)), ky = Math.max(0, k.oy + (ny - dragNode.oy));
          k.el.style.left = kx + "px"; k.el.style.top = ky + "px";
          pos.set(k.id, { x: kx, y: ky });
        }
      }
 // 边实时跟随(重建边 SVG 内 path d 的成本可接受:节点拖动节流重建);后台 UI 地图要重算流线路由
      if (cvUiInfo) cvUiRelayoutMoved(doc, pos);
      cvRedrawEdges(host, doc, pos);
    });
    const up = () => {
      if (dragNode) {
 // 续作轮:未移动(纯选中点击)不写 pos 不落盘——增量补丁后渲染闭包 pos 已不可靠,
 // 旧实现无条件把闭包位写回 doc:整理布局后每点一次卡片就被回滚一节点、防抖保存再把回滚落盘
 // (注意:整理布局落盘后,悬停删除的打空点击全部打在卡片上=逐节点回滚)。
        if (dragNode.moved) {
 // UI 交互地图:拖动只是视图微调,位置写 localStorage(不写 boardDoc/不进撤销/不触发落盘),
 // 「整理」清空回自动网格;页面拖动带动子孙的当前位置一并记下。
          if (cvUiInfo) {
            const cp0 = pos.get(dragNode.id);
            if (cp0) cvUiSetMoved(doc, dragNode.id, cp0.x, cp0.y);
            if (dragNode.kids) {
              for (const k of dragNode.kids) {
                const kp0 = pos.get(k.id);
                if (kp0) cvUiSetMoved(doc, k.id, kp0.x, kp0.y);
              }
            }
            cvUiRelayoutMoved(doc, pos);
            dragNode = null;
            el.classList.remove("dragging");
            return;
          }
          const target = (boardEditOn && boardDraft ? boardDraft : boardDoc);
          const tn = target && target.nodes.find((x) => x.id === dragNode.id);
 // 提交以 DOM style 为准(样式是唯一真相,与九期委托同纪律);闭包 pos 仅作兜底
          const fx = parseFloat(el.style.left), fy = parseFloat(el.style.top);
          const cp = (isFinite(fx) && isFinite(fy)) ? { x: fx, y: fy } : pos.get(dragNode.id);
          if (tn && cp) {
 // fixD3: 拖拽落位进撤销栈(先快照再改位,与结构操作同栈同语义)——旧实现拖动后 Ctrl+Z 报「没有可撤销的操作」,与增删节点口径不一致。
 // 位置没变(拖出去又拖回)不压栈,防污染撤销历史;随动子节点/页面板 pos 补全在本快照之后改,同一份快照已覆盖。
            if (!tn.pos || Math.abs(tn.pos.x - cp.x) > 0.5 || Math.abs(tn.pos.y - cp.y) > 0.5) cvPushUndo();
            tn.pos = { x: cp.x, y: cp.y };
 // fixH2:流动模式下手动拖过的节点记微调(重渲/刷新后保留用户手排;「整理」清空回自动流动)
            if (cvFlowInfo) cvFlowMarkMoved(dragNode.id);
          }
 // 修复:随动子节点的落盘——bdSaveLayoutDebounced 只序列化 boardDoc(不读 DOM),
 // 旧实现只写容器自身 pos,子节点 doc 位不更新→保存后刷新子节点弹回原位(视觉跟随了但持久化丢)
          if (dragNode.kids && target) {
            for (const k of dragNode.kids) {
              const kx = parseFloat(k.el.style.left), ky = parseFloat(k.el.style.top);
              const kn = target.nodes.find((x) => x.id === k.id);
              if (kn && isFinite(kx) && isFinite(ky)) kn.pos = { x: kx, y: ky };
            }
          }
 // page 板整板 pos 补全落盘——语义布局位(渲染层兜底)与容器子节点随动一并固化,
 // 「用户动过之后」全部节点有 pos,刷新后走「完全尊重」分支不再自动重排(旧板仍不改盘)
          if (target && target.docKind === "page") {
            for (const n of target.nodes) {
              if (n.pos && isFinite(n.pos.x) && isFinite(n.pos.y)) continue;
              const pn = pos.get(n.id);
              if (pn) n.pos = { x: pn.x, y: pn.y };
            }
          }
 // (重试轮,最小改动):done 板拖拽守卫——落盘前的唯一闸门。
 // 拦截时返回 true:本次不落盘,由确认条决定「允许编辑(补落盘)」或「取消(位置回滚)」。
          if (!boardEditOn && !bdDoneDragGuard(target, el, dragNode, pos, host, doc)) bdSaveLayoutDebounced();
        }
        dragNode = null;
      }
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerup", (e) => { up(); });
    el.addEventListener("pointerleave", () => { if (dragNode) up(); });
    el.addEventListener("click", (e) => {
      if (e.target.closest(".cv-file")) return;
      if (ro) {
 // 只读(设计沉淀):仅本画布内高亮——boardSelNode/renderBoardDetail 是会话板全局,不能被档案画布摸
        const wasOn = el.classList.contains("on");
        for (const x of host.querySelectorAll(".cv-node")) x.classList.remove("on");
        if (!wasOn) el.classList.add("on");
        return;
      }
 // n2 评论模式:点节点=直接就地在卡内开该节点评论框(不必先进明细卡);
 // 徽标点击另有一路(#bdCmtBadge 事件),这里兜住「点卡片任意处」的同语义。
      if (bdCommentHit(boardCommentMode, ro, el.dataset.cv, false) && !e.target.closest(".cv-ncmt")) {
        if (bdOpenNodeComment(el.dataset.cv, host, el)) { renderBoardDetail(); return; }
      }
 // fixD1: 编辑态切换选中节点前先收编在填表单(与 bd-card 清单同纪律)——旧实现直接换选中,表单改动静默丢(B 官:切节点=丢改动)
      if (boardEditOn && boardSelNode && boardSelNode !== el.dataset.cv && !bdSyncDraftFromForm()) return;
      boardSelNode = el.dataset.cv;
      renderBoardDetail();
      for (const x of host.querySelectorAll(".cv-node")) x.classList.toggle("on", x.dataset.cv === boardSelNode);
    });
 // n2 评论徽标点击:直接开该节点评论框(旧实现徽标只是计数文本,点击落到节点=进明细卡再找评论框)
    for (const cb of el.querySelectorAll(".cv-cmts")) {
      cb.onclick = (e) => {
        e.stopPropagation();
        if (ro) return;
        if (boardEditOn && boardSelNode && boardSelNode !== el.dataset.cv && !bdSyncDraftFromForm()) return;
        boardSelNode = el.dataset.cv;
        bdOpenNodeComment(el.dataset.cv, host, el);
        renderBoardDetail(); // 明细卡同步选中态(评论框仍在卡内,不要求用户去右栏)
        for (const x of host.querySelectorAll(".cv-node")) x.classList.toggle("on", x.dataset.cv === boardSelNode);
      };
    }
 // 工作流板:双击节点=开配置抽屉(未编辑先入编辑态——复用草稿/保存/冲突链),选中并出类型化参数表单
    el.addEventListener("dblclick", (e) => {
      if (ro || e.target.closest(".cv-file")) return;
      const d = boardDoc || doc;
      if (!d || d.docKind !== "workflow") return;
      if (boardEditOn && boardSelNode && boardSelNode !== el.dataset.cv && !bdSyncDraftFromForm()) return; // fixD1: 配置抽屉换节点前收编在填表单
      boardSelNode = el.dataset.cv;
      if (!boardEditOn) boardEditToggle(); // 进入编辑态(内部 renderBoard 重渲,选中态由 selCls 承载)
      else {
        renderBoardDetail();
        for (const x of host.querySelectorAll(".cv-node")) x.classList.toggle("on", x.dataset.cv === boardSelNode);
      }
      toast("配置抽屉已开:改参数后「保存白板」,再「编译执行」");
    });
  }
 // 代码档案跳转(六期C:file:line 可点)
  for (const fl of host.querySelectorAll(".cv-file")) {
    fl.onclick = (e) => { e.stopPropagation(); bdOpenProfile(fl.dataset.cvfile); };
  }
  cvBindInteractions(host, doc, pos, apply, drawMini);
  cvBindSvgOps(host, doc); // flowkit 单张 SVG 模式:卡片交互层整块早退,这里补「与卡片几何无关」的直操作
 // fixD2: 重建后恢复焦点(Ctrl+Z/Ctrl+Y 等键盘件绑在 cvHost 上,失焦=第二次快捷键失灵;preventScroll 防跳滚)
  if (cvFocusKeep && cvActiveHost) { try { cvActiveHost.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ } }
  drawMini();
}
`;
