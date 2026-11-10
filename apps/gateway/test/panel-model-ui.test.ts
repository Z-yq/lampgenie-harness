import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

/** 模型选择 UI 对齐 ZCode(v4/composer/V4ComposerToolbar.tsx:1043 + ModelConfigSelect.tsx:481-524
 *  + chat-input-toolbar/ThoughtLevelCycleControl.tsx)的结构回归。
 *  真 UI 在 panel.ts 模板字符串内(浏览器侧,不可 import),这里用 PAGE 源码字符串断言锁关键面:
 *  触发器三段(图标/滚动文案/chevron)、档位独立控件(脑图标+进度条)、列表项 RadioItem 形态(右侧勾)、
 *  弹层骨架(向上展开/192px·288px/sticky 页脚)、键盘与失败/空态反馈、窄视口收起。
 *  断言风格照抄 panel-model-pill-groups.test.ts(servePanel + 字面 includes,不用正则)。 */
describe("模型选择 UI 对齐 ZCode 布局", () => {
  const fetchHtml = async (port: number) => {
    const panel = servePanel(port, () => {});
    try {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      return await res.text();
    } finally {
      await panel.close();
    }
  };

  /** 从面板模板里抽出顶层函数源码(嵌套闭括号均有缩进,列 0 的 "}" 即函数尾)。 */
  const sliceTopFn = (html: string, header: string) => {
    const i = html.indexOf(header);
    expect(i, "找不到函数:" + header).toBeGreaterThan(0);
    const j = html.indexOf("\n}\n", i);
    expect(j, header + " 未闭合").toBeGreaterThan(i);
    return html.slice(i, j + 2);
  };

  it("① 触发器 .model-trigger 含三段:.mt-icon/.mt-label(含 .mt-provider/.mt-model)/.mt-chev", async () => {
    const html = await fetchHtml(7901);
    // 独立 ghost 按钮(zcode Button variant=ghost h-7 rounded-lg px-2 gap-1):无边框无药丸底
    expect(html).toContain('<button class="model-trigger" id="modelPill" type="button"');
    const css = html.slice(html.indexOf(".model-trigger{"), html.indexOf(".model-trigger{" ) + 400);
    expect(css).toContain("height:28px");
    expect(css).toContain("border-radius:8px");
    expect(css).toContain("background:transparent");
    expect(css).toContain("border:none");
    // 三段 DOM:图标 size-4 / 滚动文案窗 / chevron size-3.5
    expect(html).toContain('<span class="mt-icon" id="modelIcon">');
    expect(html).toContain('<span class="mt-label"><span class="mt-roll"><span class="mt-roll-in" id="modelRoll">');
    expect(html).toContain('<span class="mt-chev" id="modelChev">');
    // 文案分段:providerName/ 独立前缀 span + 模型名 truncate
    expect(html).toContain("function modelTriggerLabelHtml(providerName, modelName)");
    expect(html).toContain('<span class="mt-provider">');
    expect(html).toContain('<span class="mt-model">');
    expect(html, "模型名必须 truncate").toContain(".model-trigger .mt-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
    // 图标=PackageIcon(16px)/chevron=ChevronDown(14px)
    expect(html).toContain(".model-trigger .mt-icon .icn{width:16px;height:16px}");
    expect(html).toContain(".model-trigger .mt-chev .icn{width:14px;height:14px}");
    expect(html).toContain('iconEl.innerHTML = ic("package")');
    expect(html).toContain('chevEl.innerHTML = staged ? \'<span class="mt-spin"></span>\' : ic("chev-down")');
    // 旧药丸样式彻底退场(不许残留 .model-pill 边框药丸)
    expect(html).not.toContain(".model-pill{border");
    expect(html).not.toContain(".model-pill{display:inline-flex");
  });

  it("② 不再有「主模型:」前缀文案(触发器只显示 provider 前缀 + 模型名)", async () => {
    const html = await fetchHtml(7902);
    // 模板层:任何地方都不该再出现该前缀(旧三态文案/set 提示均已改写)
    expect(html, "「主模型:」前缀文案必须清除").not.toContain("主模型: ");
    // renderModelPill 内改用分段渲染,不再整串 textContent 拼前缀
    const pill = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    expect(pill).not.toContain("pill.textContent =");
    expect(pill).toContain("modelTriggerPaint(");
    // staged / 会话覆盖两态都走分段渲染(provider 前缀 + 名字),而不是拼字符串
    expect(pill).toContain('modelTriggerPaint(sp, staged.model || "跟随全局")');
    expect(pill).toContain('modelTriggerPaint(op, ov.model + " ·会话")');
  });

  it("③ .mt-label 有 overflow:hidden + 0.2s 过渡(切换时上下滚动换文案)", async () => {
    const html = await fetchHtml(7903);
    // 「卷轴窗」:高度 1.3em 裁切(RollingToolbarLabel 的 h-[1.3em] overflow-hidden)
    expect(html).toContain(".model-trigger .mt-label{min-width:0;height:1.3em;overflow:hidden;");
    // 滚动位移 transition 0.2s(zcode LABEL_ROLL_TRANSITION duration 0.2 / ease [.4,0,.2,1])
    expect(html).toContain(".model-trigger .mt-roll-in{display:flex;min-width:0;align-items:center;transform:translateY(0);opacity:1;");
    expect(html).toContain("transition:transform .2s cubic-bezier(.4,0,.2,1),opacity .2s cubic-bezier(.4,0,.2,1)}");
    // 换文案=重建节点:新文案从下方 0.75em 滑入,旧节点反向退出(纯 CSS transition,不引动画库)
    const paint = sliceTopFn(html, "function modelTriggerPaint(providerName, modelName) {");
    expect(paint).toContain("translateY(0.75em)");
    expect(paint).toContain("translateY(-0.75em)");
    expect(paint).toContain('next.style.transform = "translateY(0)"');
    expect(paint).toContain("void next.offsetHeight");
    // 同值不重放滚动(防每次重画都闪)
    expect(paint).toContain("if (modelLabelKey === text) return;");
  });

  it("④ staged 时渲染 .mt-spin 转轮而非 .mt-chev;staged-err 只红字不带虚线", async () => {
    const html = await fetchHtml(7904);
    expect(html).toContain(".model-trigger .mt-spin{width:14px;height:14px;flex-shrink:0;border-radius:50%;border:1.5px solid var(--bronze);");
    expect(html).toContain("border-top-color:transparent;animation:mp-spin .8s linear infinite}");
    expect(html).toContain("@keyframes mp-spin{to{transform:rotate(360deg)}}");
    // pending → LoaderIcon 换掉 chevron(zcode: pending ? LoaderIcon animate-spin : ChevronDownIcon)
    expect(html).toContain('chevEl.innerHTML = staged ? \'<span class="mt-spin"></span>\' : ic("chev-down")');
    // staged-err 保留红字,但触发器样式块内不再有虚线药丸(zcode 无虚线;全页其他组件仍可合法用 dashed)
    expect(html).toContain(".model-trigger.staged-err{color:var(--red)}");
    const trigCss = html.slice(html.indexOf(".model-trigger{"), html.indexOf(".thought-btn{"));
    expect(trigCss.length).toBeGreaterThan(500);
    expect(trigCss, "触发器不再用虚线边框").not.toContain("dashed");
    // staged 态判定仍在(语义不回退)
    const pill = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    expect(pill).toContain('pill.classList.toggle("staged", !!staged);');
    expect(pill).toContain("MODEL_STAGED_TTL");
  });

  it("⑤ 档位独立控件 .thought-btn(脑图标 + .tb-bar/.tb-fill 进度条 + .tb-text);pill 文案不再拼 effort", async () => {
    const html = await fetchHtml(7905);
    expect(html).toContain('<button class="thought-btn" id="effortPill" type="button"');
    expect(html).toContain('<span class="tb-icon" id="effortIcon">');
    expect(html).toContain('<span class="tb-bar" aria-hidden="true"><span class="tb-fill" id="effortFill"');
    expect(html).toContain('<span class="tb-text" id="effortText">');
    // 进度条:宽 4px、自身 stretch、圆角、currentColor/10 用 rgba 表达;内层 bg-success + 300ms 回弹
    expect(html).toContain(".thought-btn .tb-bar{width:4px;align-self:stretch;margin:4px 0;border-radius:999px;background:rgba(255,255,255,.1);");
    expect(html).toContain("transition:height .3s cubic-bezier(.34,1.56,.64,1)}");
    expect(html).toContain(".thought-btn .tb-fill{width:100%;min-height:2px;border-radius:999px;background:var(--green);");
    // 脑图标 16px + 档位百分比(关闭=0%,低/中/高/最高=25/50/75/100)
    expect(html).toContain(".thought-btn .tb-icon .icn{width:16px;height:16px}");
    expect(html).toContain('eIcon.innerHTML = ic("brain")');
    expect(html).toContain("function effortProgress() {");
    expect(html).toContain("return (thinking.indexOf(hit) + 1) / thinking.length * 100;");
    expect(html).toContain('eFill.style.height = effortProgress() + "%"');
    // 档位文案 = 关闭/低/中/高/最高(EFFORTS.menu),渲染进 .tb-text
    expect(html).toContain('eText.textContent = e.menu');
    // pill 可见文案不再拼 effort:两处 modelTriggerPaint 调用都只有「前缀 + 模型名」,effort 仅进 title
    const pill = sliceTopFn(html, "function renderModelPill(cfgView_) {");
    expect(pill).toContain('modelTriggerPaint(sp, staged.model || "跟随全局")');
    expect(pill).toContain('modelTriggerPaint(op, ov.model + " ·会话")');
    const paints = pill.split("\n").filter((l) => l.indexOf("modelTriggerPaint(") >= 0).join("\n");
    expect(paints.length).toBeGreaterThan(0);
    expect(paints, "可见文案不得拼 effort").not.toContain("effort");
    expect(paints, "可见文案不得拼 effort").not.toContain("ovEff");
    // 单档模型=非交互(不弹层)
    const click = html.slice(html.indexOf('$("effortPill").onclick = () => {'), html.indexOf('$("effortPill").onclick = () => {') + 700);
    expect(click).toContain("if (EFFORTS.length <= 1) return;");
  });

  it("⑥ 列表项 .pm-ck 为 position:absolute(right:8px) 右侧勾,项本体是 RadioItem 规格", async () => {
    const html = await fetchHtml(7906);
    // 项:relative flex min-h-8 rounded-md py-1.5 pl-2 pr-8 text-ui-base
    expect(html).toContain(".pill-menu .pm-item{position:relative;display:flex;align-items:center;min-height:32px;border-radius:6px;");
    expect(html).toContain("padding:6px 32px 6px 8px;font-family:var(--sans);font-size:13.5px;");
    // 勾:绝对定位到右侧(right 8px),14px CheckIcon,pointer-events:none
    expect(html).toContain(".pill-menu .pm-ck{position:absolute;right:8px;top:50%;transform:translateY(-50%);");
    expect(html).toContain(".pill-menu .pm-ck .icn{width:14px;height:14px}");
    expect(html).toContain("pointer-events:none;color:var(--faint)}");
    // 项内 = .pm-main(flex min-w-0 gap-6px) 包名字 + badge + 视觉 pill;仅选中时渲染勾
    expect(html).toContain(".pill-menu .pm-main{display:flex;min-width:0;flex:1;align-items:center;gap:6px}");
    expect(html).toContain(".pill-menu .pm-name{min-width:0;overflow:hidden;text-overflow:ellipsis}");
    const item = sliceTopFn(html, "function modelItemHtml(it, current) {");
    expect(item).toContain('<span class="pm-main">');
    expect(item).toContain("(sel ? '<span class=\"pm-ck\">' + ic(\"check\") + \"</span>\" : \"\")");
    // 锁定项:灰字 + cursor:not-allowed + 右侧 .pm-warn(AlertCircle + title=原因)
    expect(html).toContain(".pill-menu .pm-item.locked{color:var(--muted);cursor:not-allowed}");
    expect(html).toContain(".pill-menu .pm-warn{display:inline-flex;align-items:center;flex-shrink:0;color:var(--faint)}");
    expect(item).toContain('(locked ? \'<span class="pm-warn" title="\' + esc(it.lockReason || "该模型当前不可选") + \'">\' + ic("alert-circle") + "</span>" : "")');
    // 只有名字 + 可选文字 badge + 视觉 pill:无描述/上下文窗口/价格字段
    expect(item).not.toContain("contextWindow");
    expect(item).not.toContain("价格");
  });

  it("⑦ 选中项不加背景高亮(无 .pm-item.cur{background);hover/highlight 只用 --menu-hover", async () => {
    const html = await fetchHtml(7907);
    expect(html, "选中项不得带背景高亮").not.toContain(".pm-item.cur{background");
    expect(html).toContain(".pill-menu .pm-item:hover,.pill-menu .pm-item.hot{background:var(--menu-hover,rgba(255,255,255,.06));");
    // .cur 只用于「当前值」语义标记(勾/无障碍),不落背景
    expect(html).toContain('(sel ? " cur" : "")');
    expect(html).toContain('(sel ? \' data-checked="true"\' : "")');
  });

  it("⑧ 弹层 z-index:60;无二级 192px/288px;有二级 max-width 计算 + 向上展开", async () => {
    const html = await fetchHtml(7908);
    expect(html).toContain(".pill-menu{position:fixed;z-index:60;display:flex;flex-direction:column;gap:2px;");
    expect(html).toContain("border-radius:8px;");
    expect(html).toContain("box-shadow:0 12px 32px rgba(0,0,0,.5);padding:4px;");
    // 有二级:w-max min-w-48 max-w-[calc(100vw-2rem)];无二级:w-48 max-h-72
    expect(html).toContain(".pill-menu.has-sub{min-width:192px;width:max-content;max-width:min(420px,calc(100vw - 2rem))}");
    expect(html).toContain(".pill-menu.no-sub{width:192px;min-width:192px;max-height:288px}");
    expect(html).toContain("max-height:min(360px,calc(100vh - 120px));overflow-y:auto}");
    // 入口按有无折叠组切两种宿主类
    expect(html).toContain('el.classList.add(hasSub ? "has-sub" : "no-sub")');
    // 定位:side=top / align=start / sideOffset=2 / avoidCollisions(flip+shift)
    const fit = sliceTopFn(html, "function modelMenuFit(el) {");
    expect(fit).toContain("const sideTop = mh <= spaceAbove || spaceAbove >= spaceBelow;");
    expect(fit).toContain('el.style.bottom = Math.max(8, window.innerHeight - r.top + 2) + "px";');
    expect(fit).toContain("window.innerWidth - mw - 8");
  });

  it("⑨ 前置项组「跟随全局」+ 分隔线;sticky 页脚;搜索框保留(>12 项,样式对齐)", async () => {
    const html = await fetchHtml(7909);
    const menu = sliceTopFn(html, "function modelMenuHtml(groups, current, subKey) {");
    // ① 前置项组 + 分隔线(margin:4px -4px)
    expect(menu).toContain('<div class="pm-grp direct pm-lead"><div class="pm-item pm-follow');
    expect(menu).toContain('<hr class="pm-sep">');
    expect(html).toContain(".pill-menu .pm-sep{border:0;border-top:1px solid var(--border-soft);margin:4px -4px}");
    expect(menu).toContain("跟随全局(清除会话覆盖)");
    // 形态=RadioItem 同款(右侧勾,不加背景)
    expect(menu).toContain('(followCk ? \'<span class="pm-ck">\' + followCk + "</span>" : "")');
    // ③ sticky 页脚「» 管理模型」
    expect(menu).toContain('<div class="pm-foot sticky">');
    expect(menu).toContain('<span class="pm-flip">»</span><span class="pm-name">管理模型</span>');
    expect(html).toContain(".pill-menu .pm-foot{position:sticky;bottom:0;z-index:2;");
    expect(html).toContain("border-top:1px solid var(--border-soft);padding-top:4px;");
    // 搜索框保留(比 zcode 多的一项):>12 项阈值 + 28px/6px/12.5px
    expect(menu).toContain('const total = groups.reduce((n, g) => n + g.items.length, 0);');
    expect(menu).toContain('let html = total > 12 ? \'<input class="pm-q" placeholder="筛选模型…">\' : "";');
    expect(html).toContain(".pill-menu .pm-q{width:100%;box-sizing:border-box;height:28px;");
    expect(html).toContain("border-radius:6px;");
    expect(html).toContain("font-size:12.5px;padding:0 8px;margin:0 0 4px;outline:none}");
  });

  it("⑩ 键盘:ArrowDown/ArrowUp/Home/End/Escape + Enter/Space + 字母 typeahead + →/← 子菜单", async () => {
    const html = await fetchHtml(7910);
    const bind = sliceTopFn(html, "function modelMenuBind(el, groups, current, subKey) {");
    expect(bind).toContain('if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {');
    expect(bind).toContain('if (e.key === "Escape") { e.preventDefault(); pillMenuClose(); return; }');
    expect(bind).toContain('if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {');
    expect(bind).toContain('if (e.key === "ArrowRight") {');
    expect(bind).toContain('if (e.key === "ArrowLeft") {');
    // typeahead:按可见项 .pm-name 首字母跳转
    expect(bind).toContain('const nm = it.querySelector(".pm-name");');
    expect(bind).toContain("if (txt && txt.indexOf(ch) === 0) { e.preventDefault(); modelMenuHighlight(el, it); return; }");
    // 可见项清单跳过被筛选隐藏/整组隐藏的行
    const vis = sliceTopFn(html, "function modelMenuVisibleItems(el) {");
    expect(vis).toContain('if (it.style.display === "none") continue;');
    expect(vis).toContain('if (grp && grp.classList.contains("off")) continue;');
    // 打开默认 hot = 当前模型项或第一项
    expect(bind).toContain('const curItem = el.querySelector(\'.pm-item[data-v].cur\');');
    expect(bind).toContain("modelMenuHighlight(el, curItem || modelMenuVisibleItems(el)[0] || null);");
    // Esc 关闭后焦点还给输入框(zcode pickerFocus)
    const close = sliceTopFn(html, "function pillMenuClose() {");
    expect(close).toContain('const inp = $("instruction"); if (inp) inp.focus();');
  });

  it("⑪ 窄视口:1150px 保留 + 980px 隐藏 .mt-label/.tb-text(只留图标)", async () => {
    const html = await fetchHtml(7926);
    const at1150Anchor = html.indexOf("@media (max-width:1150px){", html.indexOf(".model-trigger{max-width:180px}") - 400);
    const at1150 = html.slice(at1150Anchor, at1150Anchor + 500);
    expect(at1150).toContain(".model-trigger{max-width:180px}");
    // zcode 收窄顺序:先隐藏 providerName/ 前缀(模型名优先保留),再整段文案换图标
    expect(at1150).toContain(".model-trigger .mt-provider{display:none}");
    // 更窄:模型选择器变纯图标方形按钮(size-7=28px)/档位只留脑图标+进度条
    const at980Anchor = html.indexOf("@media (max-width:980px){", html.indexOf(".model-trigger .mt-label{display:none}") - 400);
    const at980 = html.slice(at980Anchor, at980Anchor + 500);
    expect(at980).toContain(".model-trigger .mt-label{display:none}");
    expect(at980).toContain(".model-trigger{width:28px;max-width:28px;padding:0;justify-content:center;gap:0}");
    expect(at980).toContain(".thought-btn .tb-text{display:none}");
  });

  it("⑫ 反馈:模型加载失败,重试 / 无可用模型 / toast 已从 X 切换至 Y", async () => {
    const html = await fetchHtml(7927);
    // 失败态:红字可点,点击重发 models.list
    expect(html).toContain('modelTriggerPaint("", "模型加载失败,重试")');
    expect(html).toContain('if (modelListFailed) { modelMenuPending = "model"; wsSafeSend(JSON.stringify({ v: 1, type: "models.list" })); return; }');
    expect(html).toContain("modelListFailed = true;");
    // 恢复即清红字
    expect(html).toContain("if (modelListFailed) { modelListFailed = false; renderModelPill(cfgView); }");
    // 空态:灰字「无可用模型」
    expect(html).toContain('modelTriggerPaint("", "无可用模型")');
    expect(html).toContain('<div class="pm-empty">无可用模型</div>');
    // 成功切换 toast(切换前显示值取自 modelSwitchFrom);rollback 场景不弹
    expect(html).toContain("modelSwitchFrom = modelDisplayText;");
    expect(html).toContain('toast("已从 " + modelSwitchFrom + " 切换至 " + toLabel)');
    // 弹层内没有红色错误项(pm-err 不存在)
    expect(html).not.toContain(".pm-err{");
  });
});
