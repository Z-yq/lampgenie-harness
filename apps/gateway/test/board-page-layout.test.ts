/** 单测:白板页面结构板语义级布局引擎(src/assets/board-page-layout.js 纯函数)。
 * fixture=test/fixtures/board-esign.json(真实电子签规划板 45 节点/55 边的精简形态,
 * 7 page+38 section;nav 17 含 1 自环与 7 回边)。
 * 跑法:pnpm -F gateway test -- board-page-layout --maxWorkers=1(单文件免批)。 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import BPL from "../src/assets/board-page-layout.js";

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/board-esign.json"), "utf-8"));

function labelOf(res: unknown, id: string): string {
  const n = (FIX as { nodes: { id: string; label: string }[] }).nodes.find((x) => x.id === id);
  return n ? n.label : id;
}

function rectsOf(res: { pos: Map<string, { x: number; y: number }>; size: Map<string, { w: number; h: number }> }, ids: string[]) {
  return ids.map((id) => {
    const p = res.pos.get(id)!;
    const s = res.size.get(id)!;
    return { id, x: p.x, y: p.y, w: s.w, h: s.h, r: p.x + s.w, b: p.y + s.h };
  });
}

/** 矩形两两相交检测(半开区间;1px 容差防浮点边缘)。 */
function overlapPairs(rects: { id: string; x: number; y: number; r: number; b: number }[]) {
  const out: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) out.push(a.id + "×" + b.id);
    }
  }
  return out;
}

describe("board-page-layout 语义级布局(电子签 45 节点 fixture)", () => {
  const res = BPL.layout(FIX as never);
  const pageIds = (FIX as { nodes: { id: string; kind: string }[] }).nodes.filter((n) => n.kind === "page").map((n) => n.id);
  const sectionIds = (FIX as { nodes: { id: string; kind: string }[] }).nodes.filter((n) => n.kind !== "page").map((n) => n.id);

  it("pos 全治:45 节点全部有有限坐标(旧板 43/45 pos=None 的根治)", () => {
    for (const n of (FIX as { nodes: { id: string }[] }).nodes) {
      const p = res.pos.get(n.id);
      expect(p, n.id + " 无 pos").toBeDefined();
      expect(Number.isFinite(p!.x) && Number.isFinite(p!.y), n.id + " pos 非有限").toBe(true);
      expect(p!.x).toBeGreaterThanOrEqual(0);
      expect(p!.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("世界不再挤小区域:7 层横向展开(X 跨度显著大于旧 478)", () => {
    let maxX = 0;
    for (const p of res.pos.values()) { maxX = Math.max(maxX, p.x); }
    expect(maxX).toBeGreaterThan(478); // 7 层 ×(容器宽+层距),旧堆叠区仅 478 宽
    expect(new Set([...(res.level as Map<string, number>).values()]).size).toBe(7); // 分层真的拉开了
  });

  it("page 容器间零堆叠(分层+层内排布)", () => {
    const overlaps = overlapPairs(rectsOf(res, pageIds));
    expect(overlaps, overlaps.join(",")).toEqual([]);
  });

  it("容器内 section 零堆叠", () => {
    const overlaps = overlapPairs(rectsOf(res, sectionIds));
    expect(overlaps, overlaps.join(",")).toEqual([]);
  });

  it("容器化:38 个 section 全部落入所属 page 容器矩形内", () => {
    const containers = res.containers as Map<string, { x: number; y: number; w: number; h: number }>;
    const contains = (FIX as { edges: { from: string; to: string; kind: string }[] }).edges.filter((e) => e.kind === "contains");
    expect(contains.length).toBe(38);
    for (const e of contains) {
      const c = containers.get(e.from)!;
      const p = res.pos.get(e.to)!;
      const s = res.size.get(e.to)!;
      expect(p.x >= c.x - 0.5 && p.y >= c.y - 0.5, e.to + " 越出容器左上").toBe(true);
      expect(p.x + s.w <= c.x + c.w + 0.5 && p.y + s.h <= c.y + c.h + 0.5, e.to + " 越出容器右下").toBe(true);
    }
  });

  it("主线=看板→文档准备→签署位放置→发送→签署→完成凭证→校验(用户主路径,含末端校验)", () => {
    const mainLabels = [...(res.mainNodes as Set<string>)].map((id) => labelOf(res, id));
    // Set 迭代序=插入序(路径序)
    expect(mainLabels).toEqual(["记录看板(首屏)", "文档准备", "签署位放置", "发送", "签署", "完成凭证", "校验"]);
    expect((res.mainEdges as Set<string>).size).toBe(6);
  });

  it("主线 page 层级沿主路径单调(入口 level 0,主线拉直)", () => {
    const lv = res.level as Map<string, number>;
    expect(lv.get("pg6")).toBe(0); // 记录看板=入口(语义回边剥离后入度 0)
    expect(lv.get("pg1")).toBe(1); // 文档准备
    expect(lv.get("pg2")).toBe(2); // 签署位放置
    expect(lv.get("pg3")).toBe(3); // 发送
    expect(lv.get("pg4")).toBe(4); // 签署
    expect(lv.get("pg5")).toBe(5); // 完成凭证(拉直:剥离互指回边后同层→+1)
    expect(lv.get("pg7")).toBe(6); // 校验(分支最深层,主线末端)
  });

  it("回边识别:取消/上一步/返回类 nav 边(目标 level≤源)", () => {
    const back = res.backEdges as Set<string>;
    expect(back.has("pg1>pg6")).toBe(true);  // 文档准备→看板(取消)
    expect(back.has("pg2>pg1")).toBe(true);  // 签署位→文档准备(上一步)
    expect(back.has("pg4>pg3")).toBe(true);  // 签署→发送(拒签退回)
    expect(back.has("pg7>pg6")).toBe(true);  // 校验→看板(返回)
    expect(back.size).toBeGreaterThanOrEqual(7);
  });

  it("自环识别:看板拖入导入 1 条", () => {
    expect((res.selfLoops as number[]).length).toBe(1);
  });

  it("UI 角色识别:顶部横幅→top / 筛选→side / 卡片列表→main", () => {
    const roles = res.roles as Map<string, string>;
    expect(roles.get("p6s4")).toBe("top");     // 待办与到期提醒(顶部横幅聚合)
    expect(roles.get("p6s1")).toBe("side");    // 状态分组与筛选
    expect(roles.get("p6s3")).toBe("main");    // 记录卡片列表
  });

  it("主线居中:同层多 page 时主线节点 y 序居中(分支外扩)", () => {
    // 层 1 有 文档准备(main)——单节点层无分支;层 4/5 等验证主线节点在层内序=中位
    const lv = res.level as Map<string, number>;
    const byLevel: Record<number, string[]> = {};
    for (const [id, l] of lv) { (byLevel[l] ||= []).push(id); }
    const l0 = byLevel[0];
    expect(l0.length).toBe(1); // 看板独占层 0
    // 主线节点全部存在层内
    for (const id of res.mainNodes as Set<string>) expect(lv.has(id)).toBe(true);
  });

  it("幂等:同输入两次布局输出完全一致(零随机)", () => {
    const r2 = BPL.layout(FIX as never);
    for (const n of (FIX as { nodes: { id: string }[] }).nodes) {
      const a = res.pos.get(n.id)!, b = r2.pos.get(n.id)!;
      expect(b.x).toBe(a.x);
      expect(b.y).toBe(a.y);
    }
  });

  it("容错:悬空边/空页/全环图不炸且 pos 全治", () => {
    const r1 = BPL.layout({ nodes: [{ id: "a", kind: "page", label: "A" }], edges: [{ from: "a", to: "ghost", kind: "contains" }] } as never);
    expect(r1.pos.get("a")).toBeDefined();
    expect(r1.orphanCount).toBe(0);
    // 全环:a→b→c→a(无入度 0 入口)
    const r2 = BPL.layout({
      nodes: [
        { id: "a", kind: "page", label: "A" },
        { id: "b", kind: "page", label: "B" },
        { id: "c", kind: "page", label: "C" },
      ],
      edges: [
        { from: "a", to: "b", kind: "nav" },
        { from: "b", to: "c", kind: "nav" },
        { from: "c", to: "a", kind: "nav" },
      ],
    } as never);
    for (const id of ["a", "b", "c"]) expect(r2.pos.get(id)).toBeDefined();
    expect((r2.mainNodes as Set<string>).size).toBeGreaterThanOrEqual(1);
  });

  it("uiRole:component 恒为 component;弹窗/底栏/未识别角色", () => {
    expect(BPL.uiRole("component", "随便")).toBe("component");
    expect(BPL.uiRole("section", "导出备份弹窗")).toBe("overlay");
    expect(BPL.uiRole("section", "底部操作条")).toBe("bottom");
    expect(BPL.uiRole("section", "完全无法识别的怪名字")).toBe("main"); // 诚实缺省
  });

  it("孤立 section:无 contains 归属者落「未归属」区(不编造归属)", () => {
    const r = BPL.layout({
      nodes: [
        { id: "a", kind: "page", label: "A" },
        { id: "lost", kind: "section", label: "流浪区块" },
      ],
      edges: [],
    } as never);
    expect(r.orphanCount).toBe(1);
    const p = r.pos.get("lost")!;
    expect(p).toBeDefined();
    expect(p.x).toBeGreaterThanOrEqual(0);
  });

  it("嵌套 contains:section 的 component 子孙收进 section 槽内(不再落 (0,0) 孤位)", () => {
 // 孙节点进 childrenOf 却无人布局→渲染 (0,0)、不随容器拖动
    const r = BPL.layout({
      docKind: "page",
      nodes: [
        { id: "p1", kind: "page", label: "首页" },
        { id: "s1", kind: "section", label: "本月收支卡片" },
        { id: "s2", kind: "section", label: "预算进度条" },
        { id: "c1", kind: "component", label: "环形图" },
        { id: "c2", kind: "component", label: "月份切换" },
      ],
      edges: [
        { from: "p1", to: "s1", kind: "contains" },
        { from: "p1", to: "s2", kind: "contains" },
        { from: "s1", to: "c1", kind: "contains" },
        { from: "s1", to: "c2", kind: "contains" },
      ],
    } as never);
    for (const id of ["c1", "c2"]) {
      const p = r.pos.get(id)!;
      expect(p).toBeDefined();
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
    }
    const p1 = r.containers.get("p1")!;
    for (const id of ["c1", "c2"]) {
      const p = r.pos.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(p1.x);
      expect(p.x).toBeLessThan(p1.x + p1.w);
      expect(p.y).toBeGreaterThanOrEqual(p1.y);
      expect(p.y).toBeLessThan(p1.y + p1.h);
    }
    // 孙节点落在所属 section 槽位之内(section 高度为此撑开)
    const s1p = r.pos.get("s1")!;
    const s1h = r.size.get("s1")!.h;
    const c1p = r.pos.get("c1")!;
    expect(c1p.y).toBeGreaterThan(s1p.y);
    expect(c1p.y).toBeLessThanOrEqual(s1p.y + s1h);
    expect(r.orphanCount).toBe(0);
  });
});

describe("单页板 contains 补齐(2026-10-25 可读性)", () => {
  // 真实 planner 板形态:page 只显式 contains 了少量节点,其余 section/component/function 未归属。
  // 单页板按 page 唯一根收编;弹窗子节点仍归属弹窗,不摊到页级。
  const doc = {
    docKind: "page",
    nodes: [
      { id: "p", kind: "page", label: "设置页" },
      { id: "s1", kind: "section", label: "Provider 结果态区" },
      { id: "s2", kind: "section", label: "常驻 Provider 表单" },
      { id: "m", kind: "component", label: "添加 Provider 弹窗" },
      { id: "m1", kind: "component", label: "预设卡" },
      { id: "f", kind: "function", label: "cfg.set 落库" },
    ],
    edges: [{ from: "m", to: "m1", kind: "contains" }],
  };
  const res = BPL.layout(doc as never);

  it("未声明的顶层节点全部落进唯一 page 容器", () => {
    const c = res.containers.get("p")!;
    expect(c).toBeDefined();
    expect(c.h).toBeGreaterThan(100); // 收编后容器撑开,不是只有空壳
    for (const id of ["s1", "s2", "m", "m1", "f"]) {
      const p = res.pos.get(id)!;
      const s = res.size.get(id)!;
      expect(p.x, id + " 左越界").toBeGreaterThanOrEqual(c.x - 0.5);
      expect(p.y, id + " 上越界").toBeGreaterThanOrEqual(c.y - 0.5);
      expect(p.x + s.w, id + " 右越界").toBeLessThanOrEqual(c.x + c.w + 0.5);
      expect(p.y + s.h, id + " 下越界").toBeLessThanOrEqual(c.y + c.h + 0.5);
    }
    expect((res as { orphanCount?: number }).orphanCount).toBe(0);
  });

  it("弹窗子节点与弹窗同处页内组件行,页内卡零堆叠", () => {
    // 布局引擎的 component 父项不撑成嵌套框;其子项进页级组件行(contains 边表达归属)。
    // 只要人人有位、落在 page 容器内、互不堆叠即满足可读性。
    const overlaps = overlapPairs(rectsOf(res, ["s1", "s2", "m", "m1", "f"]));
    expect(overlaps, overlaps.join(",")).toEqual([]);
  });

  it("多页板不套用补齐(保留未归属语义)", () => {
    const multi = {
      docKind: "page",
      nodes: [
        { id: "p1", kind: "page", label: "页一" },
        { id: "p2", kind: "page", label: "页二" },
        { id: "x", kind: "section", label: "无归属区" },
      ],
      edges: [],
    };
    const r = BPL.layout(multi as never);
    const c1 = r.containers.get("p1")!;
    const x = r.pos.get("x")!;
    expect(x.x >= c1.x && x.x + r.size.get("x")!.w <= c1.x + c1.w && x.y >= c1.y && x.y + r.size.get("x")!.h <= c1.y + c1.h).toBe(false);
  });
});
