/** UI 交互流程图面板契约(2026-10-26):
 * 资产加载/交互↔结构切换/屏卡+元素行+触点/流线层/图例/拖动微调/整理清除。
 * 面板函数从真实 HTML 提取后 new Function 执行(与 panel-board-live 同构),不启浏览器。 */
import { describe, it, expect } from "vitest";
import { servePanel } from "../src/panel.js";

const NL = String.fromCharCode(10);

function extractFn(html: string, name: string): string {
  const head = "function " + name + "(";
  const i = html.indexOf(head);
  expect(i, "未找到函数 " + name).toBeGreaterThan(0);
  let depth = 0, started = false, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

async function withPanel<T>(port: number, fn: (html: string) => T | Promise<T>): Promise<T> {
  const srv = servePanel(port, () => { /* 纯静态 */ });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    return await fn(await res.text());
  } finally {
    await srv.close();
  }
}

describe("UI 交互流程图面板接入", () => {
  it("资产/脚本/切换入口/屏卡/流线/图例都在真实面板 HTML 里", async () => {
    await withPanel(7891, async (html) => {
      expect(html).toContain('<script src="/assets/board-ui-flow-layout.js"></script>');
      expect(html).toContain("let cvUiInfo = null;");
      expect(html).toContain('id="cvUiModeBtn"');
      expect(html).toContain("BoardUiFlowLayout.layout(doc, pg");
      expect(html).toContain("cvUiHeadHtml(cvUiInfo)");
      expect(html).toContain("cvUiFlowDefs(cvUiInfo)");
      expect(html).toContain(".cv-ui-screen{");
      expect(html).toContain(".cv-ui-cap{");
      expect(html).toContain(".cv-ui-tabbar{");
      expect(html).toContain(".cv-ui-hot{");
      expect(html).toContain(".cv-ui-legend{");
      expect(html).toContain(".cv-ui-popmask{");
      expect(html).toContain(".cv-node.cv-ui-sec.cv-ui-popup");
      expect(html).toContain(".cv-node.cv-ui-pop-child");
      expect(html).toContain("cvUiPopupMaskHtml(cvUiInfo)");
      expect(html).toContain("cvUiPopupFrameHtml");
      expect(html).toContain("cvUiPopupCardHtml");
      // 资产路由真的能拿到引擎
      const a = await fetch("http://127.0.0.1:7891/assets/board-ui-flow-layout.js");
      expect(a.status).toBe(200);
      const js = await a.text();
      expect(js).toContain("BoardUiFlowLayout");
      expect(js).toContain("ui-flow");
    });
  }, 30_000);

  it("cvUiAvailable:单屏/无 nav 不切交互;≥2 屏且有 nav 才可用", async () => {
    await withPanel(7892, (html) => {
      const src = extractFn(html, "cvUiAvailable");
      const f = new Function("BoardUiFlowLayout", src + NL + "return cvUiAvailable;")(
        { layout: () => null },
      ) as (d: unknown) => boolean;
      const page = (id: string) => ({ id, kind: "page", label: id });
      expect(f({ docKind: "page", nodes: [page("p1")], edges: [] })).toBe(false);
      expect(f({ docKind: "page", nodes: [page("p1"), page("p2")], edges: [] })).toBe(false);
      const comp = (id: string, parent: string) => ({ id, kind: "component", label: id, summary: "x", _parent: parent });
      const rich = {
        docKind: "page",
        nodes: [page("p1"), page("p2"), comp("c1", "p1"), comp("c2", "p2")],
        edges: [{ from: "p1", to: "p2", kind: "nav" }, { from: "p1", to: "c1", kind: "contains" }, { from: "p2", to: "c2", kind: "contains" }],
      };
      expect(f(rich)).toBe(true);
      expect(f({ docKind: "page", nodes: [page("p1"), page("p2")], edges: [{ from: "p1", to: "p2", kind: "nav" }] })).toBe(false);
      expect(f({ docKind: "design", nodes: [page("p1"), page("p2")], edges: [{ from: "p1", to: "p2", kind: "nav" }] })).toBe(false);
      // 稀疏板(3 屏只有 1 屏有区块)不默认交互图
      const sparseNodes: unknown[] = [page("p1"), page("p2"), page("p3"), comp("c1", "p1")];
      expect(f({ docKind: "page", nodes: sparseNodes, edges: [{ from: "p1", to: "p2", kind: "nav" }, { from: "p1", to: "c1", kind: "contains" }] })).toBe(false);
    });
  }, 30_000);

  it("元素行 affordance:开关/按钮/输入/入口/普通行按 label+summary 确定性识别", async () => {
    await withPanel(7893, (html) => {
      const src = extractFn(html, "cvUiHasText") + NL + extractFn(html, "cvUiAffordance");
      const f = new Function(src + NL + "return cvUiAffordance;")() as (n: unknown) => string;
      expect(f({ label: "消息通知", summary: "开关" })).toBe("switch");
      expect(f({ label: "提交申请", summary: "按钮" })).toBe("button");
      expect(f({ label: "搜索框", summary: "输入关键词" })).toBe("input");
      expect(f({ label: "查看详情", summary: "列表项入口" })).toBe("chev");
      expect(f({ label: "状态行", summary: "只读展示" })).toBe("dot");
    });
  }, 30_000);

  it("流线呈现:元素触点/引线/标签/分组 data 属性齐全;图例按组出颜色", async () => {
    await withPanel(7894, (html) => {
      const edge = extractFn(html, "cvUiFlowEdgeInner");
      expect(edge).toContain("data-uiflow=");
      expect(edge).toContain("bfe-ui-flow");
      expect(edge).toContain("bfe-ui-leader");
      expect(edge).toContain("bfe-ui-dot");
      expect(edge).toContain("bfe-ui-label-bg");
      expect(edge).toContain("marker-end=");
      // 一条线全段同色同粗细同虚实:引线也带 width/dash,不再只靠 CSS 细虚线
      expect(edge).toContain('class="bfe-ui-leader" d="\' + f.leaderFrom + \'" stroke="\' + color + \'" stroke-width="\' + width + \'"\' + dash');
      expect(edge).toContain('class="bfe-ui-leader" d="\' + f.leaderTo + \'" stroke="\' + color + \'" stroke-width="\' + width + \'"\' + dash');
      const defs = extractFn(html, "cvUiFlowDefs");
      expect(defs).toContain("uia");
      expect(defs).toContain("uiback");
      expect(defs).toContain("uilogic");
      const legend = extractFn(html, "cvUiLegendHtml");
      expect(legend).toContain("cv-ui-lg");
      expect(legend).toContain("cv-ui-sw");
      expect(legend).toContain("g.color");
      const anchors = extractFn(html, "cvUiAnchorOverlay");
      expect(anchors).toContain("bf-cv-ui-anchors");
      expect(anchors).toContain("<polygon");
      expect(anchors).toContain("inferred");
      expect(anchors).toContain("startPoint");
      expect(anchors).toContain("endPoint");
      expect(anchors).toContain("z-index:30");
      expect(anchors).toContain("f.startPopupBoundary");
      expect(anchors).toContain("f.startPageBoundary");
      expect(anchors).toContain("f.targetPageBoundary");
      expect(anchors).toContain("info.popupCovered");
      expect(anchors).toContain("srcCovered");
      expect(anchors).toContain('f.kind === "inner"');
      // 引线 CSS 不再使用细虚线/低透明度覆盖内联样式(否则框内外两截观感不一致)
      const leaderCss = html.slice(html.indexOf(".bf-cv-edges .bfe-ui-leader{"), html.indexOf("}", html.indexOf(".bf-cv-edges .bfe-ui-leader{")) + 1);
      expect(leaderCss).not.toContain("stroke-dasharray");
      expect(leaderCss).not.toContain("stroke-width");
      expect(html).not.toContain(".bfe-ui-flow.uiback{opacity");
      expect(html).not.toContain("stroke-width:1.3px!important");
      const cap = extractFn(html, "cvUiCaptionHtml");
      expect(cap).toContain("cv-ui-no");
      expect(cap).toContain("cv-ui-main-tag");
      expect(cap).toContain("cv-ui-entry-tag");
      expect(html).toContain(".cv-node.cv-ui-row.ctl-primary{");
      expect(html).toContain(".cv-node.cv-ui-row.ctl-secondary{");
      expect(html).toContain(".cv-node.cv-ui-row.ctl-danger{");
      expect(html).toContain(".cv-node.cv-ui-row.ctl-input{");
      expect(html).toContain(".cv-node.cv-ui-sec.sec-header{");
      expect(html).toContain(".cv-ui-actionbar{");
      expect(html).toContain(".cv-node.cv-ui-fab{");
      const row = extractFn(html, "cvUiRowHtml");
      expect(row).toContain("ctl-' + esc(ctl)");
      expect(row).toContain("cv-ui-switch");
      expect(row).toContain("cv-ui-inputbox");
      expect(row).toContain("cv-ui-tabpill");
      // 网页/桌面:浏览器 chrome + 顶部 dtabs;手机才用底部 tabbar
      const screen = extractFn(html, "cvUiScreenHtml");
      expect(screen).toContain("cv-ui-dtabs");
      expect(screen).toContain("cv-ui-browser");
      expect(screen).toContain("mobile ? cvUiTabbarHtml(pm, n.id)");
    });
  }, 30_000);

  it("浮层:遮罩/窗口/内部控件分层,标题条与浮层类型可见", async () => {
    await withPanel(7896, (html) => {
      const maskSrc = extractFn(html, "cvUiPopupMaskHtml");
      const maskFn = new Function("esc", maskSrc + NL + "return cvUiPopupMaskHtml;")(
        (s: string) => String(s),
      ) as (info: unknown) => string;
      const mask = maskFn({ popupMasks: [{ pageId: "p1", x: 1, y: 2, w: 3, h: 4 }] });
      expect(mask).toContain('data-uipopmask="p1"');
      expect(mask).toContain("left:1px;top:2px;width:3px;height:4px");
      expect(html).toContain(".cv-ui-popmask{position:absolute;z-index:4");
      expect(html).toContain("cv-ui-sec.cv-ui-popup,.cv-node.cv-ui-pop-card{position:absolute;z-index:6");
      expect(html).toContain(".cv-node.cv-ui-row.cv-ui-pop-child,.cv-node.cv-ui-sec.cv-ui-pop-child{z-index:7}");
      const section = extractFn(html, "cvUiSectionHtml");
      expect(section).toContain("info.popupIds.has(n.id)");
      expect(section).toContain("info.popupHeadingIds.has(n.id)");
      expect(section).toContain("cvUiPopupFrameHtml");
      const row = extractFn(html, "cvUiRowHtml");
      expect(row).toContain("cvUiPopupCardHtml");
      const panel = extractFn(html, "cvUiPopupPanelHtml");
      expect(panel).toContain("cv-ui-pop-head");
      expect(panel).toContain("cv-ui-pop-kind");
      expect(panel).toContain("cv-ui-pop-close");
      expect(panel).toContain("data-uipop=");
    });
  }, 30_000);

  it("拖动微调:地图拖动写 localStorage;整理清空;切视图进签名", async () => {
    await withPanel(7895, (html) => {
      expect(html).toContain("cvUiSetMoved(doc, dragNode.id");
      expect(html).toContain("cvUiRelayoutMoved(doc, pos)");
      expect(html).toContain("cvUiClearMoved(t)");
      expect(html).toContain("zh:bd-uimoved:");
      expect(extractFn(html, "cvStructSig")).toContain("cvUiMode");
      // 拖动只走 localStorage,不写 boardDoc/不触发 bdSaveLayoutDebounced
      const drag = extractFn(html, "renderBoardCanvas");
      expect(drag).toContain("if (cvUiInfo) cvUiRelayoutMoved(doc, pos)");
    });
  }, 30_000);
});
