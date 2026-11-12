/**
 * 面板主脚本分片:script-model-menu(逐字自 panel.ts PAGE 模板搬移, 拆分)。
 * 模板约束沿袭:不得出现反引号与 ${;行内换行不得写裸转义。
 */
export const PANEL_JS_MODEL_MENU = `// ----  模型快切菜单:provider 两层分组(ZCode ModelConfigSelect 语义) ----
// 真源:ZCode/packages/ui/src/ModelConfigSelect.tsx(directItems 组一级平铺 / 其它组二级 SubContent)。
// 命名推断白名单:只在名字明确属视觉族时命中(零反斜杠纪律,判断用 includes)。
const MODEL_VISION_NAME_HINTS = ["-vl", "-vision", "-omni", "glm-4v", "glm-5v", "glm-4.6v", "glm-4.1v", "gpt-4o"];
/** 视觉输入能力判定(真源优先级:条目 supportsImage===true 权威 > 名字规则推断 > 不打徽标)。
 * 返回 {vision, inferred}:inferred=true 表示「按命名推断」(条目未标注),菜单 title 要如实注明。 */
function modelVisionCapable(name, entry) {
  if (entry && entry.supportsImage === true) return { vision: true, inferred: false };
  if (entry && entry.supportsImage === false) return { vision: false, inferred: false };
  const n = String(name || "").toLowerCase();
  if (!n) return { vision: false, inferred: false };
  if (n.endsWith("-v")) return { vision: true, inferred: true };
  for (const h of MODEL_VISION_NAME_HINTS) if (n.includes(h)) return { vision: true, inferred: true };
  return { vision: false, inferred: false };
}
/** provider 归属预设(预设对话框落库的 id 即预设 id / id-2 / id-plan 形态)。 */
function presetOfProvider(p) {
  const id = String((p && p.id) || "");
  if (!id) return null;
  return PROVIDER_PRESETS.find((x) => x.id === id || id.indexOf(x.id + "-") === 0) || null;
}
/** 组徽标:只用配置能证实的维度(接入方式/本地端点/自定义渠道)——不编造账号类型(个人/Team/Free)。 */
function modelProviderBadge(p) {
  if (p && p.authMode === "token-plan") return { label: "套餐", cls: "plan" };
  const base = String((p && p.baseUrl) || "").toLowerCase();
  const pp = presetOfProvider(p);
  const isLocal = !!((pp && pp.local) || base.includes("localhost") || base.includes("127.0.0.1") || base.includes("[::1]") || base.includes("0.0.0.0"));
  if (isLocal) return { label: "本地", cls: "local" };
  const isCustom = !!((pp && pp.custom) || String((p && p.id) || "").indexOf("custom") === 0);
  if (isCustom) return { label: "自定义", cls: "custom" };
  return { label: "API", cls: "api" };
}
/** u4 列表项 = ZCode ModelConfigSelect DropdownMenuRadioItem 结构:
 * .pm-item(relative flex min-h-8 rounded-md py-1.5 pl-2 pr-8)
 * .pm-main(flex min-w-0 gap-1.5) > .pm-name(truncate) + 可选 .pm-badge(文字 pill) + .pm-vis(视觉 pill)
 * .pm-ck(absolute right-2,仅选中渲染 CheckIcon)
 * 锁定/不可用项:灰字 + cursor-not-allowed + 右侧 .pm-warn(AlertCircle + title=原因)。
 * 「未验证」按 zcode 的 badge 语义降为 .pm-badge(不再是红色错误项)。 */
function modelItemHtml(it, current) {
  const sel = it.value === current;
  const locked = !!it.locked;
  return '<div class="pm-item' + (sel ? " cur" : "") + (locked ? " locked" : "") + '" data-v="' + esc(it.value) + '"' +
    (it.providerId ? ' data-pid="' + esc(it.providerId) + '"' : "") +
    (sel ? ' data-checked="true"' : "") + (locked ? ' aria-disabled="true"' : ' tabindex="-1"') + ">" +
    '<span class="pm-main">' +
    '<span class="pm-name" title="' + esc(it.name || it.value) + '">' + esc(it.name || it.value) + "</span>" +
    (it.unverified ? '<span class="pm-unv" title="端点未确认提供该模型——选它可能 404 model_not_found">未验证</span>' : "") +
    (it.vision ? '<span class="pm-vis" title="视觉输入:' + (it.visionInferred ? "按命名推断(条目未标注 supportsImage)" : "配置已标注 supportsImage") + '">视觉</span>' : "") +
    (it.sub ? '<span class="pm-sub">' + esc(it.sub) + "</span>" : "") +
    "</span>" +
    (locked ? '<span class="pm-warn" title="' + esc(it.lockReason || "该模型当前不可选") + '">' + ic("alert-circle") + "</span>" : "") +
    (sel ? '<span class="pm-ck">' + ic("check") + "</span>" : "") +
    "</div>";
}
/** 一级/二级菜单 HTML(同一容器内原位切换:subKey 空=一级,非空=该 provider 的二级面板)。
 * u5 分区(上→下,对齐 ZCode DropdownMenuContent):① 前置项组「跟随全局」+ 分隔线;
 * ② modelGroups.map(family/账号组内联直列 + 其他组子菜单触发行);③ sticky 页脚「» 管理模型」。 */
function modelMenuHtml(groups, current, subKey) {
  const sub = subKey ? groups.find((g) => g.key === subKey) : null;
  const foot = '<div class="pm-foot sticky"><div class="pm-item" data-act="foot"><span class="pm-flip">»</span><span class="pm-name">管理模型</span></div></div>';
  if (sub) {
    return '<div class="pm-grp pm-lv2" data-g="' + esc(sub.key) + '">' +
      '<div class="pm-item pm-back" data-act="back" tabindex="0"><span class="pm-ck">' + ic("chev-right", "pm-flip") + '</span><span class="pm-name">‹ 返回</span>' +
      '<span class="pm-sub">' + esc(sub.label + (sub.labelBadge ? " · " + sub.labelBadge : "")) + "</span></div>" +
      sub.items.map((it) => modelItemHtml(it, current)).join("") + "</div>" + foot;
  }
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  let html = total > 12 ? '<input class="pm-q" placeholder="筛选模型…">' : "";
  if (!total && !groups.length) return html + '<div class="pm-empty">无可用模型</div>' + foot;
 // n8「跟随全局(清除会话覆盖)」=前置项组(leadingItems 语义)+ 分隔线;发 session.model.set{model:null}。
 // 勾选判定走 typeof 守卫:本函数会被纯函数级单测独立抽取执行(无面板上下文),不裸读 currentSid。
  const followCk = typeof sessionModelHasOverride === "function" && sessionModelHasOverride() ? "" : ic("check");
  html += '<div class="pm-grp direct pm-lead"><div class="pm-item pm-follow' + (followCk ? " cur" : "") + '" data-act="follow" tabindex="-1" title="清除本会话的模型覆盖,回到全局主模型">' +
    '<span class="pm-main"><span class="pm-name">跟随全局(清除会话覆盖)</span><span class="pm-badge">全局</span></span>' +
    (followCk ? '<span class="pm-ck">' + followCk + "</span>" : "") + "</div></div>" +
    '<hr class="pm-sep">';
  html += groups.map((g) => {
    const badge = '<span class="pm-badge ' + esc(g.labelBadgeCls || "") + '">' + esc(g.labelBadge || "") + "</span>";
    if (g.directItems) {
      return '<div class="pm-grp direct" data-g="' + esc(g.key) + '">' +
        '<div class="pm-head pm-ghead">' + esc(g.label) + " " + badge + "</div>" +
        g.items.map((it) => modelItemHtml(it, current)).join("") + "</div>";
    }
    return '<div class="pm-grp folded" data-g="' + esc(g.key) + '">' +
      '<div class="pm-item pm-ghead" data-act="group" data-g="' + esc(g.key) + '" tabindex="0">' +
      '<span class="pm-ck" title="' + esc(g.selectedHint || "") + '">' + (g.selectedHint ? ic("check") : "") + "</span>" +
      '<span class="pm-name">' + esc(g.label) + "</span>" + badge +
      '<span class="pm-badge">' + g.items.length + "</span>" +
      '<span class="pm-chev">' + ic("chev-right") + "</span></div></div>";
  }).join("");
  return html + foot;
}
/** u5 定位(ZCode DropdownMenuContent:side=top / align=start / sideOffset=2 / avoidCollisions):
 * 默认向上展开、左缘对齐触发器;上方空间不足则翻到下方;左右越界则 shift 回视口内。 */
function modelMenuFit(el) {
  const a = $("modelPill");
  if (!a) return;
  const r = a.getBoundingClientRect();
  const mw = el.offsetWidth, mh = el.offsetHeight;
  const spaceAbove = r.top - 8, spaceBelow = window.innerHeight - r.bottom - 8;
  const sideTop = mh <= spaceAbove || spaceAbove >= spaceBelow; // avoidCollisions flip
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + "px"; // align=start + shift
  if (sideTop) { el.style.bottom = Math.max(8, window.innerHeight - r.top + 2) + "px"; el.style.top = ""; } // sideOffset=2
  else { el.style.top = Math.max(8, r.bottom + 2) + "px"; el.style.bottom = ""; }
  if (mh > window.innerHeight - 80) el.style.maxHeight = Math.max(160, window.innerHeight - 100) + "px";
}
/** u6 可见项清单(键盘导航用):跳过被筛选隐藏/整组隐藏的行;组头/返回/跟随全域行也算可选项
 * (与现有 data-act 语义一致);锁定项可高亮但不可选。 */
function modelMenuVisibleItems(el) {
  const out = [];
  for (const it of el.querySelectorAll(".pm-item")) {
    if (it.style.display === "none") continue;
    const grp = it.closest(".pm-grp");
    if (grp && grp.classList.contains("off")) continue;
    out.push(it);
  }
  return out;
}
/** u6 高亮移动 + 默认高亮定位(当前模型项优先,否则第一项)。 */
function modelMenuHighlight(el, next) {
  const items = modelMenuVisibleItems(el);
  if (!items.length) return;
  for (const x of items) x.classList.remove("hot");
  let idx = items.indexOf(next);
  if (idx < 0) idx = 0;
  items[idx].classList.add("hot");
  if (items[idx].scrollIntoView) { try { items[idx].scrollIntoView({ block: "nearest" }); } catch (e) { /* 老浏览器忽略 */ } }
}
function modelMenuBind(el, groups, current, subKey) {
  const rerender = (next) => {
    el.innerHTML = modelMenuHtml(groups, current, next || "");
    modelMenuBind(el, groups, current, next || "");
    modelMenuFit(el);
  };
  for (const it of el.querySelectorAll(".pm-item")) {
    const act = it.dataset.act;
    if (act === "group") it.onclick = () => rerender(it.dataset.g);
    else if (act === "back") it.onclick = () => rerender("");
    else if (act === "follow") it.onclick = () => { pillMenuClose(); pillPickModel(null, ""); };
    else if (act === "foot") it.onclick = () => { pillMenuClose(); switchView("sys"); setSection("model"); };
    else if (it.dataset.v) it.onclick = () => {
      if (it.classList.contains("locked")) { toast(it.querySelector(".pm-warn")?.getAttribute("title") || "该模型当前不可选", true); return; }
      pillMenuClose(); pillPickModel(it.dataset.v, it.dataset.pid || "");
    };
 // hover 与键盘高亮同源:鼠标进项即把 .hot 移过去(单一 highlight 通道)
    it.onmouseenter = () => modelMenuHighlight(el, it);
  }
 // 默认高亮:当前模型项 → 否则第一项(ZCode DropdownMenu 打开即 focus 首项/选中项)
  const curItem = el.querySelector('.pm-item[data-v].cur');
  modelMenuHighlight(el, curItem || modelMenuVisibleItems(el)[0] || null);
 // u6 键盘(Radix 语义手搓等价):↑↓/Home/End 移动 hot、Enter/Space 选中、Esc 关闭+焦点还输入框、
 // 字母 typeahead 按可见项 .pm-name 首字母跳转;→ 进子菜单 / ← 返回。
  el.onkeydown = (e) => {
    const items = modelMenuVisibleItems(el);
    const hot = el.querySelector(".pm-item.hot");
    const at = items.indexOf(hot);
    const move = (n) => { if (items.length) modelMenuHighlight(el, items[(n + items.length) % items.length]); };
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (e.key === "ArrowDown") move(at < 0 ? 0 : at + 1);
      else if (e.key === "ArrowUp") move(at < 0 ? items.length - 1 : at - 1);
      else if (e.key === "Home") move(0);
      else move(items.length - 1);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); pillMenuClose(); return; }
    if (e.key === "ArrowRight") {
      if (hot && hot.dataset.act === "group") { e.preventDefault(); rerender(hot.dataset.g); }
      return;
    }
    if (e.key === "ArrowLeft") {
      if (subKey) { e.preventDefault(); rerender(""); }
      return;
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      if (!hot || hot.classList.contains("locked")) return;
      if (hot.dataset.act === "follow") { pillMenuClose(); pillPickModel(null, ""); return; }
      if (hot.dataset.act === "foot") { pillMenuClose(); switchView("sys"); setSection("model"); return; }
      if (hot.dataset.act === "group") { rerender(hot.dataset.g); return; }
      if (hot.dataset.act === "back") { rerender(""); return; }
      if (hot.dataset.v) { const v = hot.dataset.v, pid = hot.dataset.pid || ""; pillMenuClose(); pillPickModel(v, pid); }
      return;
    }
 // typeahead:单字符键 → 从当前 hot 之后循环找可见项 .pm-name 首字母命中
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ch = e.key.toLowerCase();
      if (ch === " ") return;
      const startAt = at < 0 ? 0 : at + 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[(startAt + i) % items.length];
        const nm = it.querySelector(".pm-name");
        const txt = (nm ? nm.textContent : "").trim().toLowerCase();
        if (txt && txt.indexOf(ch) === 0) { e.preventDefault(); modelMenuHighlight(el, it); return; }
      }
    }
  };
  const q = el.querySelector(".pm-q");
  if (q) {
    q.oninput = () => {
      const kw = q.value.trim().toLowerCase();
      for (const grp of el.querySelectorAll(".pm-grp")) {
        const g = groups.find((x) => x.key === grp.dataset.g);
        if (!g) continue;
        if (g.directItems || grp.classList.contains("pm-lv2")) {
 // 直展组 / 二级面板:逐个模型项过滤,无命中则整组收起(返回行不计入)
          let any = false;
          for (const it of grp.querySelectorAll(".pm-item[data-v]")) {
            const hit = !kw || String(it.dataset.v || "").toLowerCase().indexOf(kw) >= 0;
            it.style.display = hit ? "" : "none";
            if (hit) any = true;
          }
          grp.classList.toggle("off", !any);
        } else {
 // 折叠组:一级只有一行,按「组名/徽标/组内任一模型」判定——命中就保留(点进去看二级列表)
          const hit = !kw || g.label.toLowerCase().indexOf(kw) >= 0 ||
            g.items.some((it) => it.value.toLowerCase().indexOf(kw) >= 0);
          grp.classList.toggle("off", !hit);
        }
      }
      modelMenuHighlight(el, modelMenuVisibleItems(el)[0] || null); // 过滤后重置 hot 到首个可见项
    };
    setTimeout(() => q.focus(), 30);
  } else {
    el.tabIndex = -1; // 无搜索框:菜单容器接焦点(键盘导航不被 body 吞)
    setTimeout(() => { try { el.focus(); } catch (e) { /* 忽略 */ } }, 30);
  }
}
/** 端点实拉清单兜底组(配置里没有任何 provider 目录时,models.list 回包直接成一组)。 */
function endpointModelGroup(list, cur) {
  const at = list.indexOf(cur) >= 0;
  return { key: "@endpoint", label: "端点模型(已实拉验证)", labelBadge: "端点", labelBadgeCls: "plan",
    directItems: true, containsCurrent: at, selectedHint: at ? "当前主模型在此端点" : "",
    items: list.map((v) => {
      const vc = modelVisionCapable(v, null);
      return { value: v, name: v, sub: "", providerId: "", vision: vc.vision, visionInferred: vc.inferred, unverified: false };
    }) };
}
/** 模型菜单入口(替代 pillOpenMenu 的一层渲染):直展组/折叠组混排;无组→端点拉取兜底。 */
function modelMenuOpen(fallbackIds) {
  if (pillMenuEl) { pillMenuClose(); return; } // 二点=收起
  const cfg = cfgView && cfgView.config ? cfgView.config : null;
  const cur = ((cfg && cfg.coding && cfg.coding.llm) || {}).model || "";
  const groups = pillMenuModelGroups(cur);
  if (!groups.length) {
    const list = (fallbackIds || []).filter(function (x) { return !!x; });
    if (!list.length) { modelMenuPending = "model"; wsSafeSend(JSON.stringify({ v: 1, type: "models.list" })); return; } // 未配置模型→端点拉取兜底
    groups.push(endpointModelGroup(list, cur));
  }
  const el = document.createElement("div");
  el.className = "pill-menu model-menu";
 // u5 有二级(存在折叠组=provider 子菜单)时按内容宽展开,否则固定 192px(对齐 zcode 两种 DropdownMenuContent 类)
  const hasSub = groups.some((g) => !g.directItems);
  el.classList.add(hasSub ? "has-sub" : "no-sub");
  el.innerHTML = modelMenuHtml(groups, cur, "");
  document.body.appendChild(el);
  modelMenuBind(el, groups, cur, "");
  modelMenuFit(el);
  pillMenuEl = el;
}

// 候选模型聚合:来源=设置页已配置的模型(PROVIDER 列表 models;禁用项剔除),按 provider 分组。
// fixT7:verifiedModels=端点实拉(models.list 成功回包)验证过的模型集合——手填目录里未验证的
// 模型在快切菜单标注「未验证」并尾置(用户用户反馈:选了目录里的模型名→404 model_not_found,
// 因为目录是手填的、端点不一定提供)。零反斜杠纪律:判断用 includes。
const verifiedModels = new Set();
function pillMenuModelGroups(current) {
  const cfg = cfgView && cfgView.config ? cfgView.config : null;
  const off = disabledModels();
  const seen = {};
  const groups = [];
 // 角色模型(压缩/评审/子代理)也来自配置:折叠组行带 ✓ 标注「该端点承载你正在用的模型」
  const roleModels = {};
  const rm = (cfg && cfg.coding && cfg.coding.models) || {};
  for (const k of ["compact", "review", "subagent"]) if (rm[k] && rm[k].model) roleModels[rm[k].model] = k;
  for (const p of ((cfg && cfg.providers) || [])) {
    const items = [];
    for (const mm of (p.models || [])) {
      const name = typeof mm === "string" ? mm : String((mm && mm.name) || "");
      if (!name || seen[name] || off.indexOf(name) >= 0) continue;
      seen[name] = 1;
      const vc = modelVisionCapable(name, typeof mm === "string" ? null : mm);
 // fixT7 语义保留:端点未确认提供的模型标「未验证」(选它可能 404)——不拆两批组,标在项上不丢信息。
      const keyName = String(p.apiKeyEnv || "");
      const lockReason = keyName && secretKeyState[keyName] === false ? "未配置密钥 " + keyName + "(先在设置页密钥框保存)" : "";
      items.push({ value: name, name: name, sub: "", providerId: String(p.id || ""),
        vision: vc.vision, visionInferred: vc.inferred,
        locked: !!lockReason, lockReason: lockReason,
        unverified: !(verifiedModels.size === 0 || verifiedModels.has(name)) });
    }
    if (!items.length) continue;
    const hit = items.some((it) => it.value === current);
    const roleHit = items.some((it) => !!roleModels[it.value]);
    const badge = modelProviderBadge(p);
    groups.push({ key: String(p.id || p.name || "provider"), label: p.name || p.id || "provider",
      labelBadge: badge.label, labelBadgeCls: badge.cls, directItems: hit, containsCurrent: hit,
      selectedHint: hit ? "当前主模型在此端点" : (roleHit ? "含你正在用的角色模型(压缩/评审/子代理)" : ""),
      items: items });
  }
 // 含当前选中模型的 provider 置顶(一级直接展开),其余保持配置顺序(sort 稳定)
  groups.sort((a, b) => (b.containsCurrent ? 1 : 0) - (a.containsCurrent ? 1 : 0));
  if (current && !seen[current]) {
    const ce = modelEntryByName(current);
    const vc = modelVisionCapable(current, ce && ce.entry ? ce.entry : null);
    const curLock = modelKeyLockReason(current);
    groups.unshift({ key: "@current", label: "当前", labelBadge: "API", labelBadgeCls: "api",
      directItems: true, containsCurrent: true, selectedHint: "当前主模型不在任何 Provider 目录(手填)",
      items: [{ value: current, name: current, sub: "", providerId: "",
        vision: vc.vision, visionInferred: vc.inferred,
        locked: !!curLock, lockReason: curLock,
        unverified: verifiedModels.size > 0 && !verifiedModels.has(current) }] });
  }
  return groups;
}
/** n8 菜单「跟随全局」勾选判定:当前会话是否已有生效的模型覆盖。
 * 抽成纯读取函数,供 modelMenuHtml 调用(该函数会被纯函数级单测独立抽取执行,不能在体内裸读面板状态)。 */
function sessionModelHasOverride() {
 // 草稿态认当前项目预设 sid(预设会话已有覆盖 → 「跟随全局」不勾选)。
  const sid = (typeof currentSid !== "undefined" && currentSid) ? currentSid : (typeof draftSidStored === "function" ? draftSidStored() : "");
  if (!sid) return false;
  const ov = sessionModelOverride.get(sid);
  return !!(ov && ov.model);
}
/** m7-front推理档位透传:session.model.set 的 effort 字段(string|null)。
 * 取值权威=composer 的思考力度 pill(effortV;""=关→null)。后端未启用该字段时它是**可选字段**,
 * 不带也不影响既有语义(协议不做必填约束)。
 * 本函数只做透传,不新增任何模型菜单 UI(档位菜单仍在 effortPill)。 */
function sessionModelEffort() {
  return effortV ? String(effortV) : null;
}
/** n8 会话模型选择:staged 态(点了先显新值+转轮,回包确认才落定;失败回滚)。
 * v=null 语义=「跟随全局(清除会话覆盖)」→ 发 session.model.set{model:null},成功后 pill 显示全局默认。 */
function pillPickModel(v, providerId) {
  const lockReason = v ? modelKeyLockReason(v) : "";
  if (lockReason) { toast(lockReason, true); return; }
  if (v && verifiedModels.size > 0 && !verifiedModels.has(v)) toast("注意:" + v + " 未经过端点验证(手填目录)——若端点不提供该模型将 404", true);
 // u6 反馈:记录切换前的显示值(成功后 toast「已从 X 切换至 Y」用;rollback 场景不弹)
  modelSwitchFrom = modelDisplayText;
 // m9staged 有效期内**禁止重复 set**:连点会连发多条各带同一 expectedRevision,
 // 第二条必撞 revision-mismatch(第一条已把 revision +1)→ 用户看到「切换失败」但其实早切好了。
 // 同值再点=完全静默;换成别的模型才给一次黄色轻提示(不弹红,不冒充失败)。
 // 判定键统一为 targetSid(currentSid || 草稿预设 sid),草稿态连点同样被拦。
  const m9Sid = currentSid || draftSidStored();
  if (m9Sid) {
    const prev = sessionModelStaged.get(m9Sid);
    if (prev && prev.at) {
      if (Date.now() - prev.at > MODEL_STAGED_TTL) sessionModelStaged.delete(m9Sid);
      else {
        if (prev.model !== v) toast("模型切换中(等待服务端确认),请稍候再选", "warn");
        return;
      }
    }
  }
  const eff = sessionModelEffort(); // m7-front:随 set 透传的推理档位(string|null)
 // per-session 主模型:会话态→只改本会话;草稿态→绑定到当前项目的预设会话 id
 // (draftSidOf),同样走 session.model.set。全局 coding.llm 不再被快切菜单触碰(改全局只能去设置页),
 // 根治「草稿态换模型 → 其余所有 session 跟随全局一起变」的污染。
  const targetSid = currentSid || draftSidOf();
  sessionModelStaged.set(targetSid, { model: v, ...(providerId ? { providerId: providerId } : {}), effort: eff, at: Date.now() });
  const rev = sessionModelRev.get(targetSid);
  wsSafeSend(JSON.stringify({ v: 1, type: "session.model.set", sessionId: targetSid, model: v, ...(providerId ? { providerId: providerId } : {}), effort: eff, ...(rev !== undefined ? { expectedRevision: rev } : {}) }));
  draftModelRetry = null; // 新选择生效后清旧重试料
  renderModelPill(cfgView); // staged 态:显示新值 + 转轮,不改 sessionModelOverride(未确认)
  toast(v ? (currentSid ? "本会话模型 → " : "新任务模型(预设会话)→ ") + v + (providerId ? "(端点 " + providerId + ")" : "") + (eff ? "(推理档位 " + eff + ")" : "") + "(已提交,等待服务端确认…)" : "已请求跟随全局模型(等待服务端确认…)");
  setTimeout(refreshModelPill, 400);
}
/** 一层渲染已迁到 modelMenuOpen(直展组/折叠组 + 二级原位切换);入口保持同名以便既有调用点不变。 */
function pillOpenMenu() { modelMenuOpen(); }
/** u1/u2 触发器文案:providerName/ 前缀(独立 span,空间不足先隐藏)+ 模型名(truncate)。
 * u2 滚动切换用纯 CSS transition:新节点自 translateY(0.75em) 滑入,旧节点反向退出(0.2s)。
 * 状态(modelLabelKey/modelDisplayText)在菜单基建处声明,与 pillPickModel 共享。 */
function modelTriggerLabelHtml(providerName, modelName) {
  return (providerName ? '<span class="mt-provider">' + esc(providerName) + "/</span>" : "") +
    '<span class="mt-model">' + esc(modelName) + "</span>";
}
function modelTriggerPaint(providerName, modelName) {
  const text = (providerName ? providerName + "/" : "") + modelName;
  modelDisplayText = text;
  const box = document.querySelector("#modelPill .mt-roll");
  if (!box) return;
  if (modelLabelKey === text) return;
  const first = !modelLabelKey;
  modelLabelKey = text;
  const olds = [].slice.call(box.querySelectorAll(".mt-roll-in"));
  const next = document.createElement("span");
  next.className = "mt-roll-in";
  next.innerHTML = modelTriggerLabelHtml(providerName, modelName);
  if (first) { for (const o of olds) o.remove(); box.appendChild(next); return; }
  next.style.transform = "translateY(0.75em)"; next.style.opacity = "0";
  for (const o of olds) { o.classList.add("mt-out"); o.style.transform = "translateY(-0.75em)"; o.style.opacity = "0"; }
  box.appendChild(next);
  void next.offsetHeight; // 强制回流:起始位移落定后归位,transition 才会跑
  next.style.transform = "translateY(0)"; next.style.opacity = "1";
  setTimeout(function () { for (const o of olds) o.remove(); }, 240);
}
/** provider 前缀(zcode .composer-provider-prefix 语义):只有多端点时才显示——config 里仅一个
 * provider 等于内置直连,不显示前缀;空间不足由 CSS 先收(见 @media 1150px)。 */
function modelProviderPrefix(providerId, baseUrl) {
  const list = (cfgView && cfgView.config && cfgView.config.providers) || [];
  if (list.length <= 1) return "";
  let p = null;
  if (providerId) p = list.find(function (x) { return String(x.id) === String(providerId); }) || null;
  else if (baseUrl) p = list.find(function (x) { return x.baseUrl === baseUrl; }) || null;
  return p ? String(p.name || p.id || "") : "";
}
function renderModelPill(cfgView_) {
 // 语义修正:主模型=web coding 执行模型(coding.llm)。
 // chat audio 快切已迁入右侧 companion 聊天窗 widget(视频 2 后续口径),面板不再陈列。
 // per-session 主模型:当前会话有覆盖(sessionModelOverride 命中且非 null)→优先显示该 model(尾标「·会话」);
 // null=已确认无覆盖 / 未初始化 / 草稿态 → 回退全局 coding.llm.model。
 // n8 staged 态优先:有未确认选择 → 显示 staged 值 + 转轮(mt-spin 替代 chevron),回包确认才落定。
  const cfg = cfgView_ && cfgView_.config ? cfgView_.config : null;
  const cLlm = (cfg && cfg.coding && cfg.coding.llm) || {};
  const codingM = (cfg && cfg.coding && cfg.coding.llm ? cfg.coding.llm.model : null) || null;
  const pill = $("modelPill");
 // 草稿态键认当前项目预设 sid(draftSidStored;null 返回值时仍回落 "_draft" 兜底),
 // 预设会话的 staged/覆盖照常驱动 pill 显示「·会话」。
  const draftSid = draftSidStored();
  const stKey = currentSid || draftSid || "_draft";
  let staged = sessionModelStaged.get(stKey);
 // n8 兜底:WS 断/回包丢失时 staged 不能把触发器永久钉在「切换中」——超时(15s)丢弃,回落已确认值/全局。
  if (staged && staged.at && Date.now() - staged.at > MODEL_STAGED_TTL) { sessionModelStaged.delete(stKey); staged = undefined; }
  pill.classList.toggle("staged", !!staged);
  pill.classList.remove("staged-err");
 // u1 骨架图标:模型图标 PackageIcon(size-4)+ 右侧 ChevronDownIcon(size-3.5);staged 时 chevron 换转轮
  const iconEl = $("modelIcon"), chevEl = $("modelChev");
  if (iconEl && !iconEl.firstChild) iconEl.innerHTML = ic("package");
  if (chevEl) chevEl.innerHTML = staged ? '<span class="mt-spin"></span>' : ic("chev-down");
 // u6 反馈①:模型目录拉取失败 → 触发器位置显示红色「模型加载失败,重试」(点击重发 models.list)
  if (modelListFailed) {
    pill.classList.add("staged-err");
    modelTriggerPaint("", "模型加载失败,重试");
    pill.title = "模型目录拉取失败;点此重发 models.list 重试";
    return;
  }
  if (staged) {
 // m7-front:effort 不再拼进触发器可见文案(档位只留在独立档位按钮),但 title 里如实说明档位
    const sp = staged.providerId ? modelProviderPrefix(staged.providerId, "") : "";
    modelTriggerPaint(sp, staged.model || "跟随全局");
    pill.title = staged.model
      ? "已提交但服务端未确认:" + staged.model + (staged.effort ? " · " + staged.effort : "") + (staged.providerId ? "(端点 " + staged.providerId + ")" : "") + ";确认后才生效,失败会回滚并提示原因"
      : "已请求清除会话覆盖(回到全局主模型),等待服务端确认";
    return;
  }
  const ov = (currentSid || draftSid) ? sessionModelOverride.get(currentSid || draftSid) : undefined;
  if ((currentSid || draftSid) && ov && ov.model) {
 // m7-front:服务端回包里的 effort(新协议字段,string|null)在 title 落地;缺字段=旧服务端,不提档位。
    const ovEff = ov.effort ? String(ov.effort) : "";
    const op = ov.providerId ? modelProviderPrefix(ov.providerId, "") : "";
    modelTriggerPaint(op, ov.model + " ·会话");
    pill.title = "模型(仅本会话生效;未设置时用全局模型)。会话覆盖: " + ov.model + (ov.providerId ? "(端点 " + ov.providerId + ")" : "") + (ovEff ? " · " + ovEff : "") + ";点击选择";
    return;
  }
 // u6 反馈②:配置里一个模型都没有 → 灰字「无可用模型」(不显示假的「(未配)」药丸)
  const providerCount = ((cfg && cfg.providers) || []).length;
  if (!codingM && !providerCount) {
    modelTriggerPaint("", "无可用模型");
    pill.title = "尚未配置任何模型端点(设置 → Coding 模型页配置)";
    return;
  }
  modelTriggerPaint(codingM ? modelProviderPrefix(cLlm.providerId, cLlm.baseUrl) : "", codingM || "(未配)");
  pill.title = "模型 = web coding 执行模型(任务执行轨;点击直接选择,热生效)。chat audio 模型作 coding 未配置时的回退与语音转写";
}
/** n8 回包失败回滚:清 staged + 用服务端 effective(或上次已确认值/全局默认)重画,并标红一拍后恢复。
 * 语义:失败绝不能停在新模型上——pill 必须回到「实际生效」的值。 */
function modelPillRollback(sid, effectiveModel) {
  sessionModelStaged.delete(sid || "_draft");
  if (effectiveModel) sessionModelOverride.set(sid, { model: String(effectiveModel) });
  renderModelPill(cfgView);
  const pill = $("modelPill");
  pill.classList.add("staged-err");
  setTimeout(() => { const p = $("modelPill"); if (p) p.classList.remove("staged-err"); }, 1800);
}
// ---- 设置页「生效模型」区块(复用 pill 的 staged/CAS/回滚语义,不造第二套状态机) ----
let modelSwitchPick = null; // 用户在下拉里暂存的选择 {model,providerId};确认前不发 WS
let modelSwitchNotice = null; // {cls,text}:最近一次操作结果(red/warn/ok)
let secretKeyState = {}; // apiKeyEnv → 是否存在(只存布尔,不存值)
let secretRefreshAt = 0;
function modelSwitchReadOnly() { return !!(cfgView && cfgView.readOnly); }
function modelSwitchWsOpen() { return !!(typeof ws !== "undefined" && ws && ws.readyState === 1); }
function modelSwitchGlobalModel() {
  const llm = (cfgView && cfgView.config && cfgView.config.coding && cfgView.config.coding.llm) || {};
  return String(llm.model || "");
}
function modelSwitchEffective() {
  const ov = currentSid ? sessionModelOverride.get(currentSid) : null;
  return { model: String((ov && ov.model) || modelSwitchGlobalModel() || ""), override: !!(ov && ov.model), providerId: String((ov && ov.providerId) || "") };
}
function modelSwitchSecretNames() {
  const cfg = (cfgView && cfgView.config) || {};
  const names = new Set();
  for (const p of (cfg.providers || [])) if (p && p.apiKeyEnv) names.add(String(p.apiKeyEnv));
  const llm = (cfg.coding && cfg.coding.llm) || {};
  if (llm.apiKeyEnv) names.add(String(llm.apiKeyEnv));
  const rm = (cfg.coding && cfg.coding.models) || {};
  for (const k of Object.keys(rm)) if (rm[k] && rm[k].apiKeyEnv) names.add(String(rm[k].apiKeyEnv));
  return Array.from(names).slice(0, 20);
}
/** 查密钥存在性(只查名字;result 回包只含 exists)。失败保持 unknown=不锁,避免把网络问题误报成未配 key。 */
function refreshSecretKeyState(force) {
  if (!modelSwitchWsOpen() || !cfgView || typeof secretStatus !== "function") return;
  const names = modelSwitchSecretNames();
  if (!names.length) return;
  const now = Date.now();
  if (!force && now - secretRefreshAt < 15000) return;
  secretRefreshAt = now;
  secretStatus(names).then(function (r) {
    if (!r || !Array.isArray(r.items)) return;
    for (const it of r.items) if (it && it.name) secretKeyState[String(it.name)] = !!it.exists;
    renderModelSwitch();
 // pill 菜单已开:密钥状态到达后就地重渲(否则用户先开菜单看到的是「未锁」旧态)
    if (typeof pillMenuEl !== "undefined" && pillMenuEl && pillMenuEl.classList.contains("model-menu")) {
      const cur = modelSwitchGlobalModel();
      const groups = pillMenuModelGroups(cur);
      const sub = pillMenuEl.querySelector(".pm-lv2");
      const subKey = sub ? String(sub.dataset.g || "") : "";
      const q = pillMenuEl.querySelector(".pm-q");
      const qv = q ? q.value : "";
      pillMenuEl.innerHTML = modelMenuHtml(groups, cur, subKey);
      modelMenuBind(pillMenuEl, groups, cur, subKey);
      modelMenuFit(pillMenuEl);
      if (qv) {
        const q2 = pillMenuEl.querySelector(".pm-q");
        if (q2) { q2.value = qv; q2.dispatchEvent(new Event("input")); }
      }
    }
  }).catch(function () { /* 查询失败=保持未知,不误锁 */ });
}
/** 某模型的未配密钥原因;""=可切换。只看 provider 显式声明的 apiKeyEnv(local 无 key 不锁)。 */
function modelKeyLockReason(name) {
  const cfg = (cfgView && cfgView.config) || {};
  for (const p of (cfg.providers || [])) {
    if (!p || !Array.isArray(p.models)) continue;
    const hit = p.models.some(function (mm) { return (typeof mm === "string" ? mm : String((mm && mm.name) || "")) === name; });
    if (!hit) continue;
    const key = String(p.apiKeyEnv || "");
    if (key && secretKeyState[key] === false) return "未配置密钥 " + key + "(先在 Provider 密钥框保存)";
    return "";
  }
  const llm = (cfg.coding && cfg.coding.llm) || {};
  if (llm.apiKeyEnv && secretKeyState[String(llm.apiKeyEnv)] === false && llm.model === name) return "未配置密钥 " + llm.apiKeyEnv;
  return "";
}
function modelSwitchOptionsHtml(groups) {
  const lead = '<option value="">跟随全局(清除会话覆盖)</option>';
  if (!groups.length) return lead + '<option value="__none__" disabled>(暂无可选模型——先用下方服务商预设接入)</option>';
  let html = lead;
  for (const g of groups) {
    const items = (g.items || []).filter(function (it) { return it && it.value; });
    if (!items.length) continue;
    html += '<optgroup label="' + esc(g.label) + '">';
    for (const it of items) {
      const lock = !!it.locked || !!modelKeyLockReason(it.value);
      html += '<option value="' + esc(it.value) + '" data-pid="' + esc(it.providerId || "") + '"' + (lock ? ' disabled title="' + esc(it.lockReason || "未配置密钥") + '"' : '') + '>' +
        esc(it.name || it.value) + (it.unverified ? "(未验证)" : "") + (lock ? "(未配密钥)" : "") + '</option>';
    }
    html += '</optgroup>';
  }
  return html;
}
function renderModelSwitch() {
  const host = $("modelSwitch");
  if (!host) return;
  const sel = $("msw-select"), btn = $("msw-confirm"), retry = $("msw-retry"), status = $("msw-status"), curEl = $("msw-current"), scopeEl = $("msw-scope");
  if (!sel || !btn || !retry || !status || !curEl || !scopeEl) return;
  applyModelReadOnly();
  const ro = modelSwitchReadOnly(), wsOk = modelSwitchWsOpen();
  host.classList.toggle("readonly", ro);
  const eff = modelSwitchEffective();
  curEl.textContent = eff.model || (cfgView ? "(未配置)" : "(加载中…)");
  scopeEl.textContent = eff.model ? (currentSid ? (eff.override ? "本会话覆盖" : "跟随全局") : "新会话默认") : "";
  const groups = cfgView ? pillMenuModelGroups(modelSwitchGlobalModel()) : [];
  const sig = JSON.stringify(groups.map(function (g) { return [g.key, (g.items || []).map(function (it) { return [it.value, it.providerId || "", !!it.locked, !!it.unverified]; })]; }));
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = modelSwitchOptionsHtml(groups);
  }
  const staged = currentSid ? sessionModelStaged.get(currentSid) : null;
 // 未设置会话覆盖时下拉也勾当前全局模型(板 msu-dd:当前生效模型所在组直展且打勾);清除覆盖请选「跟随全局」。
  const desired = modelSwitchPick ? String(modelSwitchPick.model || "") : (staged ? String(staged.model || "") : String(eff.model || ""));
  const optExists = Array.from(sel.options).some(function (o) { return o.value === desired && !o.disabled; });
  if (optExists) sel.value = desired;
  else if (desired) { // 当前模型被禁用/不在目录:仍显示它,允许用户改选其他项
    sel.value = desired;
  }
  const noModels = !groups.length;
  let cls = "", text = "";
  if (ro) { cls = "warn"; text = "配置只读(服务端以只读模式运行):模型/Provider 编辑已禁用"; }
  else if (!wsOk) { cls = "warn"; text = "连接断开,自动重连后恢复切换"; }
  else if (staged) { cls = "warn"; text = "模型切换中(等待服务端确认)…"; }
  else if (modelListFailed) { cls = "err"; text = "模型目录拉取失败:" + (modelSwitchNotice && modelSwitchNotice.text ? modelSwitchNotice.text : "可点右侧「重试」"); }
  else if (modelSwitchNotice) { cls = modelSwitchNotice.cls || ""; text = modelSwitchNotice.text; }
  else if (!cfgView) { cls = ""; text = "加载配置…"; }
  else if (noModels) { cls = "warn"; text = "还没有可选模型:先在下方「添加供应商」接入"; }
  else if (!eff.model) { cls = "warn"; text = "尚未配置主模型:选一个模型后确认"; }
  else { cls = "ok"; text = "当前生效:" + eff.model + (eff.override ? "(本会话)" : "(全局)"); }
  status.className = "msw-status" + (cls ? " " + cls : "");
  status.innerHTML = staged ? '<span class="ms-spin"></span> ' + esc(text) : esc(text);
  retry.style.display = modelListFailed && !ro ? "" : "none";
  sel.disabled = ro || !wsOk || noModels;
  btn.disabled = ro || !wsOk || noModels || !!staged;
  btn.textContent = staged ? "切换中…" : "确认切换";
}
/** 只读配置:模型区所有编辑控件禁用 + 卡片置灰(服务端 cfg.set 也会硬拒)。 */
function applyModelReadOnly() {
  const sec = $("sec-model");
  if (!sec) return;
  const ro = modelSwitchReadOnly();
  sec.classList.toggle("cfg-readonly", ro);
  for (const el of sec.querySelectorAll("input,select,button")) {
    if (el.id === "msw-retry") continue;
    if (ro) {
      if (!el.disabled) { el.dataset.roLock = "1"; el.disabled = true; }
    } else if (el.dataset.roLock) {
      delete el.dataset.roLock;
      el.disabled = false;
    }
  }
}
function modelSwitchConfirm() {
  if (modelSwitchReadOnly()) { toast("配置只读:无法修改模型", true); return; }
  if (!modelSwitchWsOpen()) { modelSwitchNotice = { cls: "err", text: "连接断开,消息未发送(等待重连)" }; renderModelSwitch(); return; }
  if (currentSid && sessionModelStaged.has(currentSid)) { modelSwitchNotice = { cls: "warn", text: "模型切换中(等待服务端确认),请稍候" }; renderModelSwitch(); return; }
  const sel = $("msw-select");
  if (!sel) return;
  const v = String(sel.value || "");
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  const pid = opt ? String(opt.dataset.pid || "") : "";
  const eff = modelSwitchEffective();
  if (!v) {
    if (!currentSid) { modelSwitchNotice = { cls: "ok", text: "新会话本就跟随全局主模型,无需切换" }; renderModelSwitch(); return; }
    modelSwitchNotice = { cls: "warn", text: "已请求跟随全局模型,等待服务端确认…" };
  } else {
    if (!currentSid && v === eff.model && !pid) { modelSwitchNotice = { cls: "ok", text: "选择的已是全局主模型" }; renderModelSwitch(); return; }
    if (currentSid && v === eff.model && !pid) { modelSwitchNotice = { cls: "ok", text: "选择的已是当前生效模型" }; renderModelSwitch(); return; }
    if (modelKeyLockReason(v)) { modelSwitchNotice = { cls: "err", text: modelKeyLockReason(v) }; renderModelSwitch(); return; }
    modelSwitchNotice = { cls: "warn", text: "已提交 " + v + ",等待服务端确认…" };
  }
  modelSwitchPick = null;
  pillPickModel(v || null, pid);
  renderModelSwitch();
}
(function bindModelSwitch() {
  const sel = $("msw-select"), btn = $("msw-confirm"), retry = $("msw-retry");
  if (sel) sel.onchange = function () {
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    modelSwitchPick = { model: String(sel.value || ""), providerId: opt ? String(opt.dataset.pid || "") : "" };
    modelSwitchNotice = { cls: "", text: sel.value ? "已选 " + sel.value + "(尚未提交)" : "将跟随全局主模型(尚未提交)" };
    renderModelSwitch();
  };
  if (btn) btn.onclick = modelSwitchConfirm;
  if (retry) retry.onclick = function () {
    modelListFailed = false;
    modelSwitchNotice = { cls: "warn", text: "重新拉取模型目录…" };
    wsSafeSend(JSON.stringify({ v: 1, type: "models.list" }));
    renderModelSwitch();
  };
})();

$("modelPill").onclick = () => {
 // 新用户经验证:未接入任何供应商时点「无可用模型」= 发一条注定失败的 models.list,
 // 只弹「到设置页…」的错误 toast 却没有入口,新用户直接卡死(设置入口只是底部 8px 齿轮)。
 // 没有 provider 且没有主模型 → 直达设置页「模型设置」,不再空转重试。
  const providerCount = ((cfgView && cfgView.config && cfgView.config.providers) || []).length;
  if (!providerCount && !modelSwitchGlobalModel()) {
    switchView("sys");
    try { setSection("model"); } catch (e) { /* 设置页未装配时停在默认节 */ }
    toast("先在「已接入供应商」点 + 添加供应商,填 API Key 即可接入");
    return;
  }
 // u6:目录拉取失败态下,点击=重发 models.list(红字「模型加载失败,重试」可点)
  if (modelListFailed) { modelMenuPending = "model"; wsSafeSend(JSON.stringify({ v: 1, type: "models.list" })); return; }
  pillOpenMenu();
};
// 首启引导卡按钮(事件委托:renderHistory 会增量替换空态节点,直接绑会丢)
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("[data-onboard]") : null;
  if (!b) return;
  const act = b.getAttribute("data-onboard");
  if (act === "model") { switchView("sys"); try { setSection("model"); } catch (err) { /* 同上 */ } }
  else if (act === "project") { try { dbOpen(""); } catch (err) { /* 目录浏览器未装配 */ } }
  else if (act === "task") { const ta = $("instruction"); if (ta) { ta.focus(); } }
});
// 桌面壳桥(移植 ZCode 菜单/通知语义):
// - 文件→新建任务/设置:主进程角色菜单发命令,面板按现有控件执行(不造第二套入口);
// - 点系统通知:主进程已恢复窗口,这里把对应任务所在会话切出来。
(function bindDesktopShellBridge() {
  const bridge = window.genieWindow;
  if (!bridge) return;
  if (typeof bridge.onMenuCommand === "function") {
    bridge.onMenuCommand((id) => {
      try { window.__lastMenuCommand = id; } catch (e) { /* 仅诊断用 */ }
      if (id === "new-task") { const el = $("act-new"); if (el) el.click(); }
      else if (id === "open-settings") { switchView("sys"); }
    });
  }
  if (typeof bridge.onNotificationClick === "function") {
    bridge.onNotificationClick((p) => {
      const t = p && p.taskId ? tasks.get(String(p.taskId)) : null;
      if (t && t.sessionId && t.sessionId !== currentSid) openSession(t.sessionId);
    });
  }
 // genie:// 深链:设置/新建任务/会话/项目;未知动作只提示已唤起。
  if (typeof bridge.onDeepLink === "function") {
    bridge.onDeepLink((d) => {
      try { window.__lastDeepLink = d; } catch (e) { /* 仅诊断用 */ }
      if (!d || typeof d !== "object") return;
      if (d.action === "settings") { switchView("sys"); }
      else if (d.action === "new-task") { const el = $("act-new"); if (el) el.click(); }
      else if (d.action === "session" && d.sessionId) { openSession(String(d.sessionId)); }
      else if (d.action === "project" && d.path) {
        wsSafeSend(JSON.stringify({ v: 1, type: "project.add", path: String(d.path) }));
        toast("已通过 genie:// 添加项目");
      } else { toast("已通过 genie:// 唤起 Genie Harness"); }
    });
  }
})();
// 版本检查/应用内更新:主进程持有状态机(自动 6h/手动菜单/托盘),面板只渲染状态与发动作。
// 状态机在 update-check.js;这里不重复业务判断,避免「面板说能装、壳说没下载」两套真相。
(function bindUpdateBridge() {
  const bridge = window.genieWindow;
  if (!bridge || !bridge.updates) return;
 // 两个载体同一状态:经典侧栏底部横幅 + 画布模式右下浮层(新用户默认画布,侧栏被收起)。
  const targets = [
    { bar: $("updateBar"), title: $("upTitle"), sub: $("upSub"), action: $("upAction"), more: $("upMore"), later: $("upLater"), floating: false },
    { bar: $("updateFloat"), title: $("upfTitle"), sub: $("upfSub"), action: $("upfAction"), more: $("upfMore"), later: $("upfLater"), floating: true },
  ].filter((t) => t.bar && t.title && t.sub && t.action);
  if (!targets.length) return;
  const cfgBox = $("upCfg");
  const cfgState = $("upCfgState");
  const cfgInfo = $("upCfgInfo");
  const feedInput = $("upFeedUrl");
  const saveBtn = $("upSave");
  if (cfgBox) cfgBox.style.display = "block";
  let last = null;
  let lastActionText = "下载更新";
  function shortNotes(s) {
    return String(s || "").replace(/\s+/g, " ").trim().slice(0, 90);
  }
  function setVisible(t, visible) {
    if (t.floating) t.bar.classList.toggle("on", visible);
    else t.bar.style.display = visible ? "block" : "none";
  }
  function setAction(text, disabled) {
    for (const t of targets) {
      t.action.textContent = text;
      t.action.disabled = !!disabled;
    }
  }
  function render(state) {
    if (!state || typeof state !== "object") return;
    last = state;
    const status = String(state.status || "");
    const visible = (status === "available" || status === "downloading" || status === "downloaded") && !state.dismissed;
 // 设置页「关于 → 应用更新」:版本/更新源回显(输入中不覆盖,避免打字被状态推送打断)
    if (cfgState) {
      const label = status === "available" ? "有新版本 v" + String(state.latestVersion || "?")
        : status === "downloaded" ? "待安装 v" + String(state.latestVersion || "?")
        : status === "downloading" ? "下载中 " + String((state.progress && state.progress.percent) || 0) + "%"
        : status === "up-to-date" ? "已是最新 v" + String(state.currentVersion || "?")
        : status === "checking" ? "检查中…"
        : status === "disabled" ? "未配置更新源"
        : status === "error" ? "检查失败"
        : "待检查";
      cfgState.textContent = label;
    }
    if (cfgInfo) {
      const auto = state.autoCheck === false ? "关" : "开";
      const mins = Number(state.intervalMinutes) || 360;
      const every = mins >= 60 ? Math.round((mins / 60) * 10) / 10 + " 小时" : mins + " 分钟";
      const lastAt = state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : "尚未检查";
      const sig = state.signatureStatus === "verified" ? "已验证" : state.signatureStatus === "unsigned" ? "未签名" : "未知";
      cfgInfo.textContent = "当前 v" + String(state.currentVersion || "?") + " · 自动检查 " + auto + " · 每 " + every + " · 签名 " + sig + " · 上次 " + lastAt;
    }
    if (feedInput && document.activeElement !== feedInput) feedInput.value = String(state.feedUrl || "");
 // 手动检查的终态提示(自动检查不打扰;窗口有焦点时由 panel 决定是否可见)
    if (status === "checking" && state.manual) toast("正在检查更新…");
    else if (status === "up-to-date" && state.manual) toast("已是最新版本 v" + String(state.currentVersion || "?"));
    else if (status === "disabled" && state.manual) toast(String(state.reason || "未配置更新源"), true);
    else if (status === "error" && state.manual && !state.downloadedPath) toast("检查更新失败:" + String(state.error || "未知错误"), true);
    for (const t of targets) setVisible(t, visible);
    if (!visible) return;
    const ver = "v" + String(state.latestVersion || "?");
    let titleText = "";
    let subText = "";
    let actionText = "";
    let actionDisabled = false;
    let moreVisible = false;
    if (status === "available") {
      titleText = (state.mandatory ? "必须更新 " : "发现新版本 ") + ver;
      subText = state.error
        ? "上次下载失败:" + String(state.error)
        : (shortNotes(state.notes) || (state.downloadUrl ? "点击下载并安装,完成后会自动重启应用。" : "查看更新说明。"));
      actionText = state.downloadUrl ? (state.error ? "重试下载" : "下载更新") : "查看更新";
      moreVisible = !!(state.pageUrl && state.downloadUrl);
    } else if (status === "downloading") {
      const pct = state.progress && state.progress.percent != null ? state.progress.percent + "%" : "…";
      titleText = "正在下载 " + ver;
      subText = "下载进度 " + pct + ",请保持网络连接。";
      actionText = "下载中 " + pct;
      actionDisabled = true;
    } else if (status === "downloaded") {
      titleText = "可以安装 " + ver;
      subText = state.verified
        ? "安装包已下载并通过 sha256 校验;安装会自动重启应用。"
        : "安装包已下载(更新源未提供 sha256);安装会自动重启应用。";
      actionText = "安装并重启";
    }
    lastActionText = actionText;
    const sigNote = state.signatureStatus === "verified"
      ? " · 发布者签名已验证"
      : state.signatureStatus === "unsigned"
        ? " · ⚠ 更新源未签名(仅 sha256 校验)"
        : "";
    if (sigNote && subText) subText += sigNote;
    for (const t of targets) {
      t.later.style.display = state.mandatory ? "none" : "";
      t.title.textContent = titleText;
      t.sub.textContent = subText;
      t.action.textContent = actionText;
      t.action.disabled = actionDisabled;
      t.more.style.display = moreVisible ? "" : "none";
    }
  }
  function runInstall(force) {
    setAction("正在启动安装…", true);
    bridge.updates.install(force ? { force: true } : undefined).then((r) => {
      if (r && r.ok) { toast("安装器已启动,应用即将退出…"); return; }
      if (r && r.needsConfirm) {
 // 无签名包:明确降级提示,用户确认后才继续(force)
        const sure = window.confirm(String(r.message || "该更新包未通过发布者签名校验,仍要安装?"));
        if (!sure) { setAction(lastActionText, false); return; }
        runInstall(true);
        return;
      }
      setAction(lastActionText, false);
      toast("启动安装失败:" + String((r && r.error) || "未知错误"), true);
    }).catch((e) => {
      setAction(lastActionText, false);
      toast("启动安装失败:" + String(e), true);
    });
  }
  function act() {
    const state = last || {};
    const status = String(state.status || "");
    if (status === "downloaded") {
      runInstall(false);
      return;
    }
    if (status === "available" && state.downloadUrl) {
      setAction("开始下载…", true);
      bridge.updates.download().then((r) => {
        if (r && r.ok) return;
        setAction(lastActionText, false);
        toast("下载失败:" + String((r && r.error) || "未知错误"), true);
      }).catch((e) => {
        setAction(lastActionText, false);
        toast("下载失败:" + String(e), true);
      });
      return;
    }
    if (bridge.updates.openPage) bridge.updates.openPage();
  }
  for (const t of targets) {
    t.action.onclick = act;
    if (t.more) t.more.onclick = () => bridge.updates.openPage && bridge.updates.openPage();
    if (t.later) t.later.onclick = () => bridge.updates.dismiss && bridge.updates.dismiss();
  }
 // 设置页保存更新源:写 .genie/update-config.json 后壳重建 checker 并立即检查
  if (saveBtn && feedInput) {
    saveBtn.onclick = () => {
      const url = String(feedInput.value || "").trim();
      if (url && !(url.startsWith("http://") || url.startsWith("https://"))) { toast("更新源必须是 http(s) URL", true); return; }
      const old = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = "保存并检查…";
      bridge.updates.configure({ feedUrl: url, autoCheck: true, intervalHours: 6 }).then((r) => {
        saveBtn.disabled = false;
        saveBtn.textContent = old || "保存并检查";
        if (!r || !r.ok) { toast("更新源保存失败:" + String((r && r.error) || "未知错误"), true); return; }
        if (r.available) toast("已保存更新源,发现新版本 v" + String(r.latestVersion || ""));
        else if (r.state && r.state.status === "up-to-date") toast("已保存更新源,当前已是最新版本");
        else if (r.state && r.state.status === "disabled") toast("已保存;当前没有生效的更新源(留空且无兜底配置)", true);
        else if (r.state && r.state.status === "error") toast("更新源已保存,但检查失败:" + String(r.state.error || ""), true);
        else toast("更新源已保存");
      }).catch((e) => {
        saveBtn.disabled = false;
        saveBtn.textContent = old || "保存并检查";
        toast("更新源保存失败:" + String(e), true);
      });
    };
  }
  if (typeof bridge.updates.onState === "function") bridge.updates.onState(render);
  if (typeof bridge.updates.getState === "function") {
    bridge.updates.getState().then((r) => { if (r && r.ok && r.state) render(r.state); }).catch(() => undefined);
  }
 // 点更新通知:主进程已恢复窗口;这里把横幅提到眼前(状态由 getState 保证存在)
  if (typeof bridge.onNotificationClick === "function") {
    bridge.onNotificationClick((p) => {
      if (!p || p.status !== "update") return;
      if (last) render(last);
      toast("发现新版本 " + String(p.taskId || "").replace(/^update:/, ""));
    });
  }
})();`;
