/** UI 交互流程板布局引擎单测(2026-10-26):
 * 多屏网格/元素锚点/正交流线/回边/主路径/tab/辅助带/拖动微调/确定性。
 * 纯函数零 IO;fixture 是 4 屏领养流程的微型形态,不依赖盘上板文件。 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import BPL from "../src/assets/board-page-layout.js";
import UFL from "../src/assets/board-ui-flow-layout.js";

type AnyDoc = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[]; docKind?: string; title?: string };
type Res = {
  mode: string;
  pos: Map<string, { x: number; y: number }>;
  size: Map<string, { w: number; h: number }>;
  pages: { id: string; row: number; col: number; main: boolean; entry: boolean; x: number; y: number; w: number; h: number; tabs: { label: string; to: string }[] }[];
  flows: {
    kind: string; label: string;
    source: { id: string; element: boolean; inferred?: boolean };
    target: { id: string; element: boolean; isPage?: boolean; popup?: boolean; pageFrame?: boolean; inferred?: boolean };
    sourcePage: string; targetPage: string; path: string; leaderFrom: string; leaderTo: string;
    dotFrom: { x: number; y: number } | null; dotTo: { x: number; y: number } | null;
    startPoint: { x: number; y: number } | null; endPoint: { x: number; y: number } | null;
    startBoundary: { x: number; y: number } | null; endBoundary: { x: number; y: number } | null;
    startPageBoundary: { x: number; y: number } | null; startPopupBoundary: { x: number; y: number } | null;
    targetPageBoundary: { x: number; y: number } | null; startSide: string;
    labelX: number; labelY: number; labelW?: number; labelText: string; labelAnchor?: string; color: string; dash: string;
    groupKey: string; main: boolean;
  }[];
  groups: { key: string; label: string; color: string; count: number }[];
  auxNodes: { id: string }[];
  popups: { id: string; pageId: string; mode: string; rect: { x: number; y: number; w: number; h: number }; triggerId: string; kids: number }[];
  popupIds: Set<string>;
  popupOf: Map<string, string>;
  popupTriggers: Set<string>;
  popupMasks: { pageId: string; x: number; y: number; w: number; h: number }[];
  popupCovered: Set<string>;
  head: { title: string; summary: string };
  world: { w: number; h: number };
  cols: number; rows: number;
};

const doc: AnyDoc = {
  docKind: "page",
  title: "宠物领养小程序 · UI 交互流程",
  nodes: [
    { id: "nav", kind: "nav", label: "底部 Tab", summary: "首页 / 我的" },
    { id: "p1", kind: "page", label: "首页", summary: "宠物卡片流入口" },
    { id: "s1", kind: "section", label: "列表区", summary: "卡片列表", change: "keep" },
    { id: "card", kind: "component", label: "宠物卡片", summary: "点击卡片进详情", change: "keep" },
    { id: "p2", kind: "page", label: "详情页", summary: "单只宠物详情与申请入口" },
    { id: "s2", kind: "section", label: "操作区", summary: "底部按钮", change: "keep" },
    { id: "apply", kind: "component", label: "申请领养按钮", summary: "点击进入表单", change: "keep" },
    { id: "p3", kind: "page", label: "申请表单", summary: "填写领养信息" },
    { id: "s3", kind: "section", label: "提交区", summary: "同意须知并提交", change: "keep" },
    { id: "submit", kind: "component", label: "提交按钮", summary: "点击提交成功", change: "keep" },
    { id: "draft", kind: "component", label: "草稿暂存", summary: "退出时保存草稿", change: "keep" },
    { id: "p4", kind: "page", label: "提交结果", summary: "结果回执与后续入口" },
    { id: "done", kind: "component", label: "查看进度按钮", summary: "点击看申请进度", change: "keep" },
  ],
  edges: [
    { from: "p1", to: "s1", kind: "contains" },
    { from: "s1", to: "card", kind: "contains" },
    { from: "p2", to: "s2", kind: "contains" },
    { from: "s2", to: "apply", kind: "contains" },
    { from: "p3", to: "s3", kind: "contains" },
    { from: "s3", to: "submit", kind: "contains" },
    { from: "s3", to: "draft", kind: "contains" },
    { from: "p4", to: "done", kind: "contains" },
    { from: "card", to: "p2", kind: "nav", label: "跳转：宠物详情" },
    { from: "apply", to: "p3", kind: "nav", label: "跳转：申请表单" },
    { from: "submit", to: "p4", kind: "nav", label: "跳转：提交结果" },
    { from: "done", to: "p2", kind: "nav", label: "返回：详情" },
    { from: "nav", to: "p1", kind: "nav", label: "点击 Tab「首页」" },
    { from: "nav", to: "p4", kind: "nav", label: "点击 Tab「我的」" },
  ],
};

function run(moved?: Map<string, { x: number; y: number }>): Res {
  const base = BPL.layout(doc as never) as never;
  const r = UFL.layout(doc as never, base, moved ? { moved } : {}) as Res | null;
  expect(r).not.toBeNull();
  return r as Res;
}

function overlaps(els: { id: string; x: number; y: number; w: number; h: number }[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1) out.push(a.id + "x" + b.id);
    }
  }
  return out;
}
/** 点是否落在页/浮层大框边界上(端点精度 0.6px)。 */
function onBoundary(pt: { x: number; y: number } | null, r: { x: number; y: number; w: number; h: number }): boolean {
  if (!pt) return false;
  const eps = 0.6;
  const inY = pt.y >= r.y - eps && pt.y <= r.y + r.h + eps;
  const inX = pt.x >= r.x - eps && pt.x <= r.x + r.w + eps;
  return ((Math.abs(pt.x - r.x) <= eps || Math.abs(pt.x - (r.x + r.w)) <= eps) && inY) ||
    ((Math.abs(pt.y - r.y) <= eps || Math.abs(pt.y - (r.y + r.h)) <= eps) && inX);
}
function pathEndsAt(f: { path: string; endPoint: { x: number; y: number } | null }): boolean {
  if (!f.endPoint) return false;
  const ex = Math.round(f.endPoint.x * 10) / 10, ey = Math.round(f.endPoint.y * 10) / 10;
  return f.path.endsWith("L " + ex + " " + ey);
}
/** 路径是否穿过某个控件矩形(只判正交段;用于锁「流线不压按钮/列表行」)。 */
function labelRect(f: { labelX: number; labelY: number; labelW?: number; labelText: string; labelAnchor?: string }): { x: number; y: number; w: number; h: number } {
  const lw = f.labelW || Math.min(210, Math.max(42, f.labelText.length * 6.6 + 14));
  const lx = f.labelAnchor === "start" ? f.labelX - 4 : f.labelX - lw / 2;
  return { x: lx, y: f.labelY - 11, w: lw, h: 22 };
}
function pathHitsRect(path: string, r: { x: number; y: number; w: number; h: number }): boolean {
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.abs(a.y - b.y) < 0.5 && a.y >= r.y - 1 && a.y <= r.y + r.h + 1 && Math.max(Math.min(a.x, b.x), r.x) < Math.min(Math.max(a.x, b.x), r.x + r.w) - 1) return true;
    if (Math.abs(a.x - b.x) < 0.5 && a.x >= r.x - 1 && a.x <= r.x + r.w + 1 && Math.max(Math.min(a.y, b.y), r.y) < Math.min(Math.max(a.y, b.y), r.y + r.h) - 1) return true;
  }
  return false;
}

describe("board-ui-flow-layout 多屏交互地图", () => {
  const r = run();

  it("mode/ui-flow + 4 屏单行 + 屏间零堆叠", () => {
    expect(r.mode).toBe("ui-flow");
    expect(r.cols).toBe(4);
    expect(r.rows).toBe(1);
    expect(r.pages.length).toBe(4);
    const rects = r.pages.map((p) => ({ id: p.id, x: r.pos.get(p.id)!.x, y: r.pos.get(p.id)!.y, w: r.size.get(p.id)!.w, h: r.size.get(p.id)!.h }));
    expect(overlaps(rects)).toEqual([]);
  });

  it("主路径/入口:首页→详情→表单→结果;入口屏标 entry", () => {
    expect(r.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r.pages[0].entry).toBe(true);
    expect(r.head.summary).toContain("主路径");
    expect(r.head.summary).toContain("4 屏");
  });

  it("起点落触发控件;跳新页面箭头只落目标页大框(不猜页内按钮)", () => {
    const f = r.flows.find((x) => x.label === "跳转：宠物详情")!;
    expect(f.source.id).toBe("card");
    expect(f.source.element).toBe(true);
    expect(f.dotFrom).not.toBeNull();
    expect(f.target.id).toBe("p2");
    expect(f.target.element).toBe(false);
    expect(f.target.pageFrame).toBe(true);
    expect(f.dotTo).toBeNull();
    expect(f.targetPage).toBe("p2");
    const sx = Math.round((f.dotFrom!.x) * 10) / 10, sy = Math.round((f.dotFrom!.y) * 10) / 10;
    expect(f.path.startsWith("M " + sx + " " + sy)).toBe(true);
    expect(pathEndsAt(f)).toBe(true);
    const p2 = r.pages.find((p) => p.id === "p2")!;
    expect(onBoundary(f.endPoint, p2)).toBe(true);
    expect(f.targetPageBoundary).toEqual(f.endPoint);
  });

  it("返回边:虚线/灰色/kind=back,走下方通道且带标签", () => {
    const b = r.flows.find((x) => x.label === "返回：详情")!;
    expect(b.kind).toBe("back");
    expect(b.dash).toBe("6 4");
    expect(b.path.split("L ").length).toBeGreaterThan(2);
    expect(b.labelText.length).toBeGreaterThan(0);
  });

  it("tab 条:nav 节点→page 的边不画流线;目标屏出底部 tab,导航节点进辅助带", () => {
    expect(r.pages.find((p) => p.id === "p1")!.tabs.map((t) => t.label)).toEqual(["首页"]);
    expect(r.pages.find((p) => p.id === "p4")!.tabs.map((t) => t.label)).toEqual(["我的"]);
    expect(r.flows.some((f) => f.source.id === "nav")).toBe(false);
    expect(r.auxNodes.map((n) => n.id)).toContain("nav");
  });

  it("控件类型布局:卡片占满行,主/次按钮紧凑且不重叠", () => {
    const cardW = r.size.get("card")!.w;
    expect(cardW).toBeGreaterThan(180); // 卡片/输入类占满可用宽,不再是 84px 素描卡
    const submitW = r.size.get("submit")!.w;
    const draftW = r.size.get("draft")!.w;
    // 主按钮/次按钮按类型给宽度(不是等分大条),同一 action 行右对齐且不重叠
    expect(submitW).toBeGreaterThan(70);
    expect(draftW).toBeGreaterThan(50);
    expect(submitW + draftW).toBeLessThan(226);
    const rects = [
      { id: "submit", x: r.pos.get("submit")!.x, y: r.pos.get("submit")!.y, w: submitW, h: r.size.get("submit")!.h },
      { id: "draft", x: r.pos.get("draft")!.x, y: r.pos.get("draft")!.y, w: draftW, h: r.size.get("draft")!.h },
    ];
    expect(overlaps(rects)).toEqual([]);
  });

  it("拖动微调:页面位移带动子孙;流线路由随位置重算", () => {
    const p = r.pos.get("p1")!;
    const moved = new Map([["p1", { x: p.x + 80, y: p.y + 30 }]]);
    const r2 = run(moved);
    expect(r2.pos.get("p1")!.x).toBe(p.x + 80);
    expect(r2.pos.get("card")!.x).toBe(r.pos.get("card")!.x + 80);
    expect(r2.flows[0].path).not.toBe(r.flows[0].path);
  });

  it("控件类型:卡片/图标/主按钮/次按钮/底部 CTA 行被识别", () => {
    const controls = (r as unknown as { controls: Map<string, string> }).controls;
    expect(controls.get("card")).toBe("card");
    expect(controls.get("apply")).toBe("primary");
    expect(controls.get("submit")).toBe("primary");
    expect(controls.get("draft")).toBe("secondary");
    expect(controls.get("done")).toBe("primary");
  });

  it("底部操作条:主/次按钮右对齐,生成 actionbar 背景", () => {
    const bottomDoc: AnyDoc = {
      docKind: "page",
      title: "小程序 · 底部操作条",
      nodes: [
        { id: "p1", kind: "page", label: "详情页", summary: "底部操作条" },
        { id: "s1", kind: "section", label: "底部操作条", summary: "取消 / 提交", change: "keep" },
        { id: "cancel", kind: "component", label: "取消按钮", summary: "次要", change: "keep" },
        { id: "ok", kind: "component", label: "提交申请主按钮", summary: "提交", change: "keep" },
        { id: "p2", kind: "page", label: "其他页", summary: "内容" },
        { id: "s2", kind: "section", label: "内容区", summary: "内容", change: "keep" },
      ],
      edges: [
        { from: "p1", to: "s1", kind: "contains" }, { from: "s1", to: "cancel", kind: "contains" }, { from: "s1", to: "ok", kind: "contains" },
        { from: "p2", to: "s2", kind: "contains" },
      ],
    };
    const base = BPL.layout(bottomDoc as never) as never;
    const br = UFL.layout(bottomDoc as never, base, {}) as Res & { actionBars: { pid: string }[] };
    expect(br.actionBars.map((b) => b.pid)).toContain("p1");
    const okP = br.pos.get("ok")!, cancelP = br.pos.get("cancel")!;
    expect(okP.x).toBeGreaterThan(cancelP.x); // 主按钮在次按钮右边
    expect(br.size.get("ok")!.w).toBeGreaterThan(br.size.get("cancel")!.w);
  });

  it("分组配色:小图按目标屏分色(≤8 组),每组有颜色/计数/标签", () => {
    expect(r.groups.length).toBeLessThanOrEqual(8);
    expect(r.groups.every((g) => !!g.color && g.count > 0 && !!g.label)).toBe(true);
    expect(r.groups.some((g) => g.label.indexOf("跳转：") === 0)).toBe(true);
  });

  it("确定性:同输入两次输出位置与路径完全一致", () => {
    const r2 = run();
    for (const p of r.pages) {
      expect(r2.pos.get(p.id)).toEqual(r.pos.get(p.id));
    }
    expect(r2.flows.map((f) => f.path)).toEqual(r.flows.map((f) => f.path));
  });

  it("单屏返回 null(保留页面结构板);悬空边/空图不炸", () => {
    const base = BPL.layout({ docKind: "page", nodes: [{ id: "p", kind: "page", label: "单页" }], edges: [] } as never);
    expect(UFL.layout({ docKind: "page", nodes: [{ id: "p", kind: "page", label: "单页" }], edges: [] } as never, base as never, {})).toBeNull();
    const r2 = UFL.layout({ docKind: "page", nodes: [{ id: "a", kind: "page", label: "A" }, { id: "b", kind: "page", label: "B" }], edges: [{ from: "a", to: "ghost", kind: "nav" }] } as never, BPL.layout({ docKind: "page", nodes: [{ id: "a", kind: "page", label: "A" }, { id: "b", kind: "page", label: "B" }], edges: [] } as never) as never, {}) as Res;
    expect(r2.pos.get("a")).toBeDefined();
    expect(r2.flows.length).toBe(0);
  });
});

describe("网页/桌面 UI 形态(不是手机壳)", () => {
  const deskDoc: AnyDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/board-desktop-ui.json"), "utf-8"));
  const base = BPL.layout(deskDoc as never) as never;
  const d = UFL.layout(deskDoc as never, base, {}) as Res;

  it("桌面设备:浏览器窗(非手机),窗宽≥380,4 列", () => {
    expect(d.pages.every((p) => (p as unknown as { mobile: boolean }).mobile === false)).toBe(true);
    expect(d.pages.every((p) => p.w >= 380)).toBe(true);
    expect(d.cols).toBe(4);
    expect(d.pages.every((p) => p.tabs.length > 0)).toBe(true);
  });

  it("桌面交互:起点落按钮,跳页终点落目标窗大框;tab 用桌面顶部导航", () => {
    expect(d.flows.length).toBe(4);
    for (const f of d.flows) {
      expect(f.source.element, f.label + " source").toBe(true);
      expect(f.target.element, f.label + " target").toBe(false);
      expect(f.target.pageFrame, f.label + " pageFrame").toBe(true);
      expect(f.dotFrom).not.toBeNull();
      expect(f.dotTo).toBeNull();
      const sx = Math.round(f.dotFrom!.x * 10) / 10, sy = Math.round(f.dotFrom!.y * 10) / 10;
      expect(f.path.startsWith("M " + sx + " " + sy), f.label + " start").toBe(true);
      expect(pathEndsAt(f), f.label + " end").toBe(true);
      const tp = d.pages.find((p) => p.id === f.target.id)!;
      expect(onBoundary(f.endPoint, tp), f.label + " boundary").toBe(true);
    }
    expect(d.flows.find((f) => f.label === "跳转：模型与 Provider")!.target.id).toBe("p2");
    expect(d.flows.find((f) => f.label === "跳转：快捷键")!.target.id).toBe("p3");
    const ctl = (d as unknown as { controls: Map<string, string> }).controls;
    expect(ctl.get("addprov")).toBe("primary");
    expect(ctl.get("testconn")).toBe("secondary");
    expect(ctl.get("theme")).toBe("tab");
    expect(ctl.get("startup")).toBe("toggle");
  });
});

describe("网页 UI 形态(header/sidebar/main/footer + 按钮类型)", () => {
  const webDoc: AnyDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/board-web-ui.json"), "utf-8"));
  const base = BPL.layout(webDoc as never) as never;
  const w = UFL.layout(webDoc as never, base, {}) as Res & {
    controls: Map<string, string>;
    sectionTypes: Map<string, string>;
  };
  const R = (id: string) => ({ p: w.pos.get(id)!, s: w.size.get(id)! });

  it("桌面网页:浏览器窗、3 屏、header/sidebar/main/footer 区域", () => {
    expect(w.pages.every((p) => (p as unknown as { mobile: boolean }).mobile === false)).toBe(true);
    expect(w.cols).toBe(3);
    expect(w.pages.length).toBe(3);
    expect(w.sectionTypes.get("s_header")).toBe("header");
    expect(w.sectionTypes.get("s_side")).toBe("sidebar");
    expect(w.sectionTypes.get("s_footer")).toBe("footer");
  });

  it("按钮类型:主按钮/页签/输入/次按钮/危险操作/选择器", () => {
    expect(w.controls.get("w_new")).toBe("primary");
    expect(w.controls.get("w_tab_users")).toBe("tab");
    expect(w.controls.get("w_search")).toBe("input");
    expect(w.controls.get("w_export")).toBe("secondary");
    expect(w.controls.get("w_bulkdel")).toBe("danger");
    expect(w.controls.get("e_role")).toBe("select");
    expect(w.controls.get("e_save")).toBe("primary");
    expect(w.controls.get("e_cancel")).toBe("secondary");
  });

  it("按钮落位:header 主按钮在右、页签在左;footer 操作在底栏内右对齐", () => {
    const head = R("s_header"), logo = R("w_logo"), users = R("w_tab_users"), create = R("w_new");
    expect(logo.p.y).toBeGreaterThanOrEqual(head.p.y - 1);
    expect(create.p.y).toBeGreaterThanOrEqual(head.p.y - 1);
    expect(create.p.y + create.s.h).toBeLessThanOrEqual(head.p.y + head.s.h + 1);
    expect(create.p.x).toBeGreaterThan(users.p.x);
    const foot = R("s_footer"), exp = R("w_export"), del = R("w_bulkdel"), next = R("pg_next");
    for (const x of [exp, del, next]) {
      expect(x.p.y).toBeGreaterThanOrEqual(foot.p.y - 1);
      expect(x.p.y + x.s.h).toBeLessThanOrEqual(foot.p.y + foot.s.h + 1);
    }
    expect(next.p.x).toBeGreaterThan(exp.p.x);
  });

  it("网页跨屏边:源按钮→目标页大框(终点不再猜页内按钮)", () => {
    expect(w.flows.length).toBe(3);
    for (const f of w.flows) {
      expect(f.source.element, f.label).toBe(true);
      expect(f.target.element, f.label).toBe(false);
      expect(f.target.pageFrame, f.label).toBe(true);
      expect(f.dotTo, f.label).toBeNull();
      const sx = Math.round(f.dotFrom!.x * 10) / 10, sy = Math.round(f.dotFrom!.y * 10) / 10;
      expect(f.path.startsWith("M " + sx + " " + sy), f.label).toBe(true);
      expect(pathEndsAt(f), f.label).toBe(true);
      const tp = w.pages.find((p) => p.id === f.target.id)!;
      expect(onBoundary(f.endPoint, tp), f.label + " boundary").toBe(true);
    }
    expect(w.flows.find((f) => f.label === "跳转：编辑用户")!.target.id).toBe("p_edit");
    expect(w.flows.find((f) => f.label === "跳转：用户详情")!.target.id).toBe("p_detail");
  });
});

describe("浮层(弹窗/下拉菜单)表达", () => {
  const popDoc: AnyDoc = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/board-popup-ui.json"), "utf-8"));
  const base = BPL.layout(popDoc as never) as never;
  const p = UFL.layout(popDoc as never, base, {}) as Res;

  it("弹窗/下拉独立成浮层:模态居中、下拉贴触发;触发按钮不被浮层盖住", () => {
    expect(p.popups.map((x) => x.id).sort()).toEqual(["dd", "dlg"]);
    const dlg = p.popups.find((x) => x.id === "dlg")!;
    const dd = p.popups.find((x) => x.id === "dd")!;
    expect(dlg.mode).toBe("modal");
    expect(dlg.kids).toBe(3);
    expect(dd.mode).toBe("popover");
    expect(dd.kids).toBe(2);
    for (const pop of p.popups) {
      const page = p.pages.find((x) => x.id === pop.pageId)!;
      expect(pop.rect.x).toBeGreaterThanOrEqual(page.x);
      expect(pop.rect.y).toBeGreaterThanOrEqual(page.y);
      expect(pop.rect.x + pop.rect.w).toBeLessThanOrEqual(page.x + page.w + 0.5);
      expect(pop.rect.y + pop.rect.h).toBeLessThanOrEqual(page.y + page.h + 0.5);
      const trg = p.pos.get(pop.triggerId)!;
      expect(overlaps([
        { id: "popup", x: pop.rect.x, y: pop.rect.y, w: pop.rect.w, h: pop.rect.h },
        { id: "trigger", x: trg.x, y: trg.y, w: p.size.get(pop.triggerId)!.w, h: p.size.get(pop.triggerId)!.h },
      ])).toEqual([]);
    }
    expect([...p.popupTriggers].sort()).toEqual(["filter", "trigger"]);
    expect(p.popupMasks.map((m) => m.pageId).sort()).toEqual(["p1", "p2"]);
  });

  it("流线标签互不重叠(底部通道汇合时自动下移)", () => {
    const boxes = p.flows.filter((f) => !!f.labelText).map((f, i) => ({ id: "lbl" + i, ...labelRect(f) }));
    expect(overlaps(boxes)).toEqual([]);
  });

  it("浮层内控件全部落在窗口内且互不重叠", () => {
    for (const pop of p.popups) {
      const kids = [...p.popupOf.entries()].filter(([, pid]) => pid === pop.id).map(([kid]) => kid);
      expect(kids.length).toBe(pop.kids);
      const rects = kids.map((kid) => {
        const kp = p.pos.get(kid)!, ks = p.size.get(kid)!;
        expect(kp.x, kid + " inside x").toBeGreaterThanOrEqual(pop.rect.x - 1);
        expect(kp.y, kid + " inside y").toBeGreaterThanOrEqual(pop.rect.y - 1);
        expect(kp.x + ks.w, kid + " inside right").toBeLessThanOrEqual(pop.rect.x + pop.rect.w + 1);
        expect(kp.y + ks.h, kid + " inside bottom").toBeLessThanOrEqual(pop.rect.y + pop.rect.h + 1);
        return { id: kid, x: kp.x, y: kp.y, w: ks.w, h: ks.h };
      });
      expect(overlaps(rects)).toEqual([]);
    }
  });

  it("弹出边:触发按钮→浮层边框,不从页框边起箭头;浮层组虚线", () => {
    const f = p.flows.find((x) => x.label === "弹出：确认删除弹窗")!;
    expect(f.kind).toBe("popup");
    expect(f.target.id).toBe("dlg");
    expect(f.target.popup).toBe(true);
    expect(f.target.element).toBe(false);
    expect(f.target.pageFrame).toBeUndefined();
    expect(f.dotTo).toBeNull();
    expect(f.groupKey).toBe("popup:dlg");
    expect(f.dash).toBe("2 3");
    expect(pathEndsAt(f)).toBe(true);
    const dlg = p.popups.find((x) => x.id === "dlg")!;
    expect(onBoundary(f.endPoint, dlg.rect)).toBe(true);
    expect(f.startPoint).toEqual(f.dotFrom);
    // 触发按钮→弹窗的线不走兄弟列表行(同页弹窗绕页内侧空隙)
    for (const id of ["row1", "row2", "row3"]) {
      const kp = p.pos.get(id)!, ks = p.size.get(id)!;
      expect(pathHitsRect(f.path, { x: kp.x, y: kp.y, w: ks.w, h: ks.h }), "popup flow hits " + id).toBe(false);
    }
  });

  it("浮层内按钮跳外页:控件→浮层边→源页大框→目标页大框,全程一条流线", () => {
    const f = p.flows.find((x) => x.label === "跳转：删除结果")!;
    expect(f.source.id).toBe("confirm");
    expect(f.source.element).toBe(true);
    expect(p.popupOf.get("confirm")).toBe("dlg");
    expect(f.startPopupBoundary).not.toBeNull();
    expect(f.startPageBoundary).not.toBeNull();
    expect(f.startBoundary).toEqual(f.startPopupBoundary);
    // 确认按钮右侧是「取消」:必须从按钮下方出浮层,不能横穿兄弟按钮
    expect(f.startSide).toBe("bottom");
    const dlg = p.popups.find((x) => x.id === "dlg")!;
    expect(f.startPopupBoundary!.y).toBeCloseTo(dlg.rect.y + dlg.rect.h, 1);
    expect(f.target.id).toBe("p3");
    expect(f.target.pageFrame).toBe(true);
    expect(f.target.element).toBe(false);
    expect(f.dotTo).toBeNull();
    expect(pathEndsAt(f)).toBe(true);
    const p3 = p.pages.find((x) => x.id === "p3")!;
    expect(onBoundary(f.endPoint, p3)).toBe(true);
    // 确认按钮→外页的线不能横穿右侧「取消」按钮
    const cp = p.pos.get("cancel")!, cs = p.size.get("cancel")!;
    expect(pathHitsRect(f.path, { x: cp.x, y: cp.y, w: cs.w, h: cs.h })).toBe(false);
  });

  it("普通页面跳转仍只落目标页大框;浮层内容屏不把浮层子控件当页内元素", () => {
    const f = p.flows.find((x) => x.label === "跳转：用户详情")!;
    expect(f.target.id).toBe("p2");
    expect(f.target.pageFrame).toBe(true);
    expect(f.target.element).toBe(false);
    expect(pathEndsAt(f)).toBe(true);
    const p2 = p.pages.find((x) => x.id === "p2")!;
    expect(onBoundary(f.endPoint, p2)).toBe(true);
    expect(p.popupIds.has("dlg")).toBe(true);
    expect(p.popupIds.has("dd")).toBe(true);
    expect(p.popupOf.has("txt")).toBe(true);
    expect(p.popupOf.has("status")).toBe(true);
    expect(p.popupOf.has("trigger")).toBe(false);
    // 列表行卡片被「确认删除弹窗」窗口盖住:流线不再从它上面起笔(面板会把起笔段/触点藏掉)
    expect(p.popupCovered.has("card")).toBe(true);
    expect(p.popupCovered.has("trigger")).toBe(false);
  });

  it("旧板漏 contains 的浮层:按入向 nav 源页反推归属,不再掉进底部辅助带", () => {
    const orphanDoc: AnyDoc = {
      docKind: "page",
      title: "旧板浮层归属兜底",
      nodes: [
        { id: "p1", kind: "page", label: "流水页", summary: "列表与抽屉入口" },
        { id: "s1", kind: "section", label: "交易列表", summary: "列表行", change: "keep" },
        { id: "row", kind: "component", label: "交易行", summary: "点击打开详情抽屉", change: "keep" },
        { id: "drawer", kind: "component", label: "交易详情抽屉", summary: "底部抽屉:详情/编辑/删除", change: "add" },
        { id: "p2", kind: "page", label: "其他页", summary: "内容" },
        { id: "s2", kind: "section", label: "内容区", summary: "内容", change: "keep" },
      ],
      edges: [
        { from: "p1", to: "s1", kind: "contains" },
        { from: "s1", to: "row", kind: "contains" },
        { from: "p2", to: "s2", kind: "contains" },
        { from: "p1", to: "drawer", kind: "nav", label: "点击交易行→交易详情抽屉" },
      ],
    };
    const o = UFL.layout(orphanDoc as never, BPL.layout(orphanDoc as never) as never, {}) as Res;
    const pop = o.popups.find((x) => x.id === "drawer")!;
    expect(pop).toBeDefined();
    expect(pop.pageId).toBe("p1");
    expect(pop.mode).toBe("bottom");
    expect(o.popupIds.has("drawer")).toBe(true);
    expect(o.popupOf.has("drawer")).toBe(false); // 浮层本体不在自身子树
    expect(o.auxNodes.some((n) => n.id === "drawer")).toBe(false);
    const f = o.flows.find((x) => x.kind === "popup")!;
    expect(f.target.id).toBe("drawer");
    expect(f.target.popup).toBe(true);
    expect(pathEndsAt(f)).toBe(true);
    expect(onBoundary(f.endPoint, pop.rect)).toBe(true);
  });

  it("底部抽屉形态:mode=bottom,贴页底且触发按钮可见", () => {
    const bottomDoc: AnyDoc = {
      docKind: "page",
      title: "手机 · 底部抽屉",
      nodes: [
        { id: "p1", kind: "page", label: "设置页", summary: "设置与更多操作" },
        { id: "s1", kind: "section", label: "设置列表", summary: "开关与入口", change: "keep" },
        { id: "rowa", kind: "component", label: "消息通知开关", summary: "开关", change: "keep" },
        { id: "rowb", kind: "component", label: "隐私设置入口", summary: "列表项", change: "keep" },
        { id: "rowc", kind: "component", label: "清理缓存按钮", summary: "点击清理", change: "keep" },
        { id: "more", kind: "component", label: "更多操作按钮", summary: "点击弹出底部抽屉", change: "keep" },
        { id: "sheet", kind: "section", label: "更多操作底部抽屉", summary: "底部抽屉:清理/反馈/取消", change: "keep" },
        { id: "opt1", kind: "component", label: "清理缓存操作", summary: "执行清理", change: "keep" },
        { id: "opt2", kind: "component", label: "意见反馈入口", summary: "打开反馈页", change: "keep" },
        { id: "opt3", kind: "component", label: "取消", summary: "关闭抽屉", change: "keep" },
        { id: "p2", kind: "page", label: "其他页", summary: "内容" },
        { id: "s2", kind: "section", label: "内容区", summary: "内容", change: "keep" },
      ],
      edges: [
        { from: "p1", to: "s1", kind: "contains" },
        { from: "s1", to: "rowa", kind: "contains" },
        { from: "s1", to: "rowb", kind: "contains" },
        { from: "s1", to: "rowc", kind: "contains" },
        { from: "s1", to: "more", kind: "contains" },
        { from: "p1", to: "sheet", kind: "contains" },
        { from: "sheet", to: "opt1", kind: "contains" },
        { from: "sheet", to: "opt2", kind: "contains" },
        { from: "sheet", to: "opt3", kind: "contains" },
        { from: "p2", to: "s2", kind: "contains" },
        { from: "more", to: "sheet", kind: "nav", label: "弹出：更多操作底部抽屉" },
      ],
    };
    const b = UFL.layout(bottomDoc as never, BPL.layout(bottomDoc as never) as never, {}) as Res;
    const sheet = b.popups.find((x) => x.id === "sheet")!;
    expect(sheet.mode).toBe("bottom");
    const page = b.pages.find((x) => x.id === "p1")!;
    // 底部抽屉贴页底(底部 tab 条之上),不按普通卡片排进内容流。
    expect(sheet.rect.y + sheet.rect.h).toBeGreaterThan(page.y + page.h - 60);
    expect(b.flows.find((x) => x.label === "弹出：更多操作底部抽屉")!.target.id).toBe("sheet");
  });
});
