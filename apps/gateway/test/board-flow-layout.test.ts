/** fixH1 单测:白板「一眼看懂」流程图布局引擎(src/assets/board-flow-layout.js 纯函数)。
 * 覆盖:LR 链式主线/多入口择可达最多/出口最远/纯环降级/孤立未连接列/泳道分组(显式 group+阶段前缀)
 * /kind 族回退/节点编号稳定/幂等/同层无堆叠/主线横平/入口最左出口最右/悬空边容错。
 * 跑法:pnpm -F gateway test -- board-flow-layout --maxWorkers=1 */
import { describe, it, expect } from "vitest";
import BFL from "../src/assets/board-flow-layout.js";

type TN = { id: string; kind?: string; label?: string; group?: string };
type TE = { from: string; to: string; label?: string };
type Res = {
  pos: Map<string, { x: number; y: number }>;
  size: Map<string, { w: number; h: number }>;
  lanes: { key: string; label: string; no: string; x: number; y: number; w: number; h: number; nodes: string[]; isolated?: boolean; isPhase?: boolean; boxless?: boolean }[];
  laneOf: Map<string, string>;
  mainPath: string[];
  mainNodes: Set<string>;
  mainEdges: Set<string>;
  backEdges: Set<string>;
  entry: string | null;
  exit: string | null;
  no: Map<string, string>;
  level: Map<string, number>;
  isolated: string[];
  orphanCount: number;
  bounds: { x: number; y: number; w: number; h: number };
  baseline: number;
};
const L = (nodes: TN[], edges: TE[]) => BFL.layout({ nodes, edges }) as Res;
const N = (id: string, kind = "function", label = id, group?: string): TN =>
  ({ id, kind, label, ...(group ? { group } : {}) });
const E = (from: string, to: string, label?: string): TE => ({ from, to, ...(label ? { label } : {}) });

function rectsOf(res: Res, ids: string[]) {
  return ids.map((id) => {
    const p = res.pos.get(id)!;
    const s = res.size.get(id)!;
    return { id, x: p.x, y: p.y, r: p.x + s.w, b: p.y + s.h };
  });
}
function overlaps(rects: { id: string; x: number; y: number; r: number; b: number }[]) {
  const out: string[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) out.push(a.id + "×" + b.id);
    }
  }
  return out;
}

describe("board-flow-layout LR 流程图布局", () => {
  it("链式主线:入口最左/出口最右,主线 4 边加粗,主节点同基线(横平)", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const r = L(ids.map((id) => N(id)), [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")]);
    expect(r.entry).toBe("a");
    expect(r.exit).toBe("e");
    expect(r.mainPath).toEqual(ids);
    expect(r.mainEdges.size).toBe(4);
    expect(r.mainEdges.has("a>b")).toBe(true);
    const xs = ids.map((id) => r.pos.get(id)!.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    expect(r.pos.get("a")!.x).toBe(Math.min(...[...r.pos.values()].map((p) => p.x)));
    expect(r.pos.get("e")!.x).toBe(Math.max(...[...r.pos.values()].map((p) => p.x)));
    const ys = ids.map((id) => r.pos.get(id)!.y);
    for (const y of ys) expect(y).toBe(r.baseline); // 主线恒在基线:一眼可循
  });

  it("多入口:择可达节点最多者(不是 id 最小者)", () => {
    const r = L([N("a"), N("b"), N("c"), N("d"), N("e"), N("f")], [E("a", "c"), E("b", "c"), E("c", "d"), E("d", "e"), E("b", "f")]);
    expect(r.entry).toBe("b"); // b 可达 5 节点 > a 可达 4 节点
    expect(r.mainPath).toEqual(["b", "c", "d", "e"]);
  });

  it("出口:出度 0 中距入口最远者(近端分支不抢出口)", () => {
    const r = L([N("a"), N("b"), N("c"), N("d")], [E("a", "b"), E("b", "d"), E("a", "c")]);
    expect(r.entry).toBe("a");
    expect(r.exit).toBe("d"); // c 层 1,d 层 2
    expect(r.mainPath).toEqual(["a", "b", "d"]);
  });

  it("重试环(真实断线重连板形态):回边剥离后主线继续贯穿到出口,不截断在环里", () => {
    // n1/n2 → n3 → n5 → n4 → n6 → n7 → n8;n6→n5 是「握手失败重试」回边
    const r = L(
      [N("n1"), N("n2"), N("n3"), N("n4"), N("n5"), N("n6"), N("n7"), N("n8")],
      [E("n1", "n3"), E("n2", "n3"), E("n3", "n5"), E("n3", "n8"), E("n5", "n4"), E("n4", "n6"), E("n6", "n5"), E("n6", "n7"), E("n7", "n8")],
    );
    expect(r.entry).toBe("n1");
    expect(r.exit).toBe("n8"); // 旧启发式会把 forward 边 n4→n6 剥掉、出口错成 n4
    expect(r.mainPath).toEqual(["n1", "n3", "n5", "n4", "n6", "n7", "n8"]);
    expect(r.mainEdges.size).toBe(6);
    expect(r.backEdges.has("n6>n5")).toBe(true);
    // 回边不参与分层:n5 只等 n3 就可入列(层号严格前向)
    const lv = ["n1", "n3", "n5", "n4", "n6", "n7", "n8"].map((id) => r.level.get(id));
    for (let i = 1; i < lv.length; i++) expect(lv[i]).toBe((lv[i - 1] as number) + 1);
  });

  it("纯环降级:无入度 0 → id 最小入口,pos 全治不炸", () => {
    const r = L([N("a"), N("b"), N("c")], [E("a", "b"), E("b", "c"), E("c", "a")]);
    expect(r.entry).toBe("a");
    for (const id of ["a", "b", "c"]) {
      const p = r.pos.get(id)!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    expect(r.mainPath.length).toBeGreaterThanOrEqual(2);
    expect(r.mainEdges.size).toBe(r.mainPath.length - 1);
  });

  it("孤立节点:单独「未连接」列放最下,不编造归属", () => {
    const r = L([N("a"), N("b"), N("x"), N("y")], [E("a", "b")]);
    expect(r.orphanCount).toBe(2);
    expect(r.isolated).toEqual(["x", "y"]);
    const last = r.lanes[r.lanes.length - 1];
    expect(last.label).toBe("未连接");
    expect(last.nodes).toEqual(["x", "y"]);
    const mainBottom = Math.max(r.pos.get("a")!.y, r.pos.get("b")!.y) + r.size.get("a")!.h;
    expect(r.pos.get("x")!.y).toBeGreaterThan(mainBottom);
    expect(r.pos.get("y")!.y).toBeGreaterThan(r.pos.get("x")!.y);
    expect(r.no.get("x")).toMatch(/^\d{2}$/);
  });

  it("泳道分组:node.group 优先,编号 01/02/03 与标题(去数字前缀)就位", () => {
    const nodes = [
      N("a", "function", "采集入口", "01 采集"),
      N("b", "function", "采样落盘", "01 采集"),
      N("c", "module", "重采样", "02 处理"),
      N("d", "module", "编码", "02 处理"),
      N("e", "io", "上云", "03 输出"),
    ];
    const r = L(nodes, [E("a", "b"), E("b", "c"), E("c", "d"), E("d", "e")]);
    expect(r.lanes.length).toBe(3);
    expect(r.lanes.map((l) => l.no)).toEqual(["01", "02", "03"]);
    expect(r.lanes.map((l) => l.label)).toEqual(["采集", "处理", "输出"]);
    expect(r.lanes[0].nodes).toEqual(["a", "b"]);
    expect(r.lanes[1].nodes).toEqual(["c", "d"]);
    expect(r.lanes[2].nodes).toEqual(["e"]);
    // 泳道框覆盖组内节点
    for (const lane of r.lanes) {
      for (const id of lane.nodes) {
        const p = r.pos.get(id)!;
        expect(p.x).toBeGreaterThanOrEqual(lane.x);
        expect(p.y).toBeGreaterThanOrEqual(lane.y);
        expect(p.x + 208).toBeLessThanOrEqual(lane.x + lane.w + 0.5);
        expect(p.y + 116).toBeLessThanOrEqual(lane.y + lane.h + 0.5);
      }
    }
    // 泳道切换处列距 > 同泳道列距(分段留白,虚线框不打架)
    const gapAB = r.pos.get("c")!.x - r.pos.get("b")!.x;
    const gapInLane = r.pos.get("b")!.x - r.pos.get("a")!.x;
    expect(gapAB).toBeGreaterThan(gapInLane);
  });

  it("阶段前缀聚类(label 数字前缀,无 group 时):01/02 两段", () => {
    const nodes = [N("a", "function", "01 采集 MIC1"), N("b", "function", "01 采集 落盘"), N("c", "function", "02 处理 解码"), N("d", "function", "02 处理 编码")];
    const r = L(nodes, [E("a", "b"), E("b", "c"), E("c", "d")]);
    expect(r.lanes.length).toBe(2);
    expect(r.lanes.map((l) => l.label)).toEqual(["采集", "处理"]);
    expect(r.lanes[0].nodes).toEqual(["a", "b"]);
    expect(r.lanes[1].nodes).toEqual(["c", "d"]);
  });

  it("kind 族回退:无 group/无阶段前缀 → 按 kind 成道", () => {
    const r = L([N("a", "llm", "识别"), N("b", "tool", "解码"), N("c", "decision", "判定")], [E("a", "b"), E("b", "c")]);
    expect(r.lanes.length).toBe(3);
    expect(new Set(r.lanes.map((l) => l.label))).toEqual(new Set(["模型智能", "工具处理", "判断分支"]));
  });

  it("节点编号:01..N 唯一连续,按(泳道序,层序,id)稳定", () => {
    const nodes = [N("a", "function", "A", "02 处理"), N("b", "function", "B", "01 采集"), N("c", "function", "C", "01 采集"), N("d", "function", "D", "02 处理")];
    const r = L(nodes, [E("b", "c"), E("c", "a"), E("a", "d")]);
    const nos = [...r.no.entries()].sort((x, y) => x[1].localeCompare(y[1]));
    expect(nos.map(([id]) => id)).toEqual(["b", "c", "a", "d"]); // 采集(01)两块 → 处理(02)两块
    expect(r.no.get("b")).toBe("01");
    expect(r.no.get("d")).toBe("04");
  });

  it("同层无堆叠:分支上下外扩,同列节点等距", () => {
    const r = L(
      [N("a"), N("b"), N("c"), N("d")],
      [E("a", "b"), E("a", "c"), E("b", "d"), E("c", "d")],
    );
    const ids = ["a", "b", "c", "d"];
    expect(overlaps(rectsOf(r, ids))).toEqual([]);
    const yb = r.pos.get("b")!.y, yc = r.pos.get("c")!.y;
    expect(Math.abs(Math.abs(yb - yc) - (116 + 32))).toBeLessThan(0.5); // 上下各一行,间距=ROW_GAP
    // 层号:入口 0 → 分支 1 → 汇合 2
    expect(r.level.get("a")).toBe(0);
    expect(r.level.get("d")).toBe(2);
  });

  it("幂等:同输入两次布局逐字节一致(零随机,tie-breaker 确定)", () => {
    const nodes = [N("a", "llm", "01 采集"), N("b", "tool", "01 采集"), N("c", "decision", "02 处理"), N("d", "module", "02 处理", "02 处理")];
    const edges = [E("a", "b"), E("b", "c"), E("c", "d")];
    const r1 = L(nodes, edges), r2 = L(nodes, edges);
    for (const n of nodes) expect(r2.pos.get(n.id)).toEqual(r1.pos.get(n.id));
    expect(r2.mainPath).toEqual(r1.mainPath);
    expect(r2.no.get("d")).toBe(r1.no.get("d"));
    expect(r2.lanes.map((l) => [l.no, l.label, l.x, l.y, l.w, l.h])).toEqual(r1.lanes.map((l) => [l.no, l.label, l.x, l.y, l.w, l.h]));
  });

  it("容错:悬空边忽略、单节点板、空板不炸", () => {
    const r1 = L([N("a")], [E("a", "ghost")]);
    expect(r1.pos.get("a")).toBeDefined();
    expect(r1.mainPath).toEqual([]); // a 的唯一边悬空 → 无有效边,视为孤立(不编造主线)
    expect(r1.entry).toBe(null);
    expect(r1.orphanCount).toBe(1);
    const r2 = L([], []);
    expect(r2.lanes.length).toBe(0);
    expect(r2.entry).toBe(null);
    expect(r2.exit).toBe(null);
  });

  it("stagePrefix:编号+标题解析(空格/无空格/纯数字拒绝)", () => {
    expect(BFL.stagePrefix("01 采集")).toEqual({ no: 1, title: "采集" });
    expect(BFL.stagePrefix("02处理")).toEqual({ no: 2, title: "处理" });
    expect(BFL.stagePrefix("03 / 云端级联")).toEqual({ no: 3, title: "云端级联" });
    expect(BFL.stagePrefix("001")).toBe(null);
    expect(BFL.stagePrefix("采集")).toBe(null);
  });
});

describe("宽板列换行(2026-10-25 任务 A:非 compact 宽设计板按列折行,不破坏 LR 语义)", () => {
  // 7 列主路径 + 每列一个分支(分支是 sink,不延长主路径)→ 横排 1792px,折行后 1000px
  const MAIN = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"];
  const BR = ["br0", "br1", "br2", "br3", "br4"];
  const makeDoc = (group?: string) => {
    const nodes: TN[] = [];
    for (const id of MAIN) nodes.push(N(id, "module", "主干" + id, group));
    for (const id of BR) nodes.push(N(id, "function", "分支" + id, group));
    const edges: TE[] = [];
    for (let i = 1; i < MAIN.length; i++) edges.push(E(MAIN[i - 1]!, MAIN[i]!));
    BR.forEach((id, i) => edges.push(E(MAIN[i]!, id))); // br0..br4 挂在前 5 列(挂到 m5 会与 m6 并列最长,主线择枝不稳定)
    return { nodes, edges };
  };

  it("wrap:主路径 7 列 → 4 列折行(x 跨度收窄/行数≥2/全部节点有 pos/泳道数据不丢)", () => {
    const { nodes, edges } = makeDoc("01 全段");
    const r = BFL.layout({ nodes, edges }, { wrap: true }) as Res & { wrap: { active: boolean; cols: number; rows: number } };
    // 前提:确实是一条 7 列主路径(否则用例没验到东西)
    expect(r.mainPath).toEqual(MAIN);
    expect(r.wrap).toEqual({ active: true, cols: 4, rows: 2 });

    const NODE_W = 208;
    const xs = [...r.pos.values()].map((p) => p.x);
    const xSpan = Math.max(...xs) + NODE_W - Math.min(...xs);
    expect(xSpan).toBeLessThanOrEqual(4 * NODE_W + 3 * 56); // ≤ 4 卡 + 3 列距 = 1000
    expect(xSpan).toBeLessThan(1351); // 任务书基线:横排 x 跨度 1351px+(7 列 = 1792)

    // 主路径分两行:前 4 张一行、后 3 张下一行;行内 y 相同,行间不重叠
    const mainYs = MAIN.map((id) => r.pos.get(id)!.y);
    const rowYs = [...new Set(mainYs)].sort((a, b) => a - b);
    expect(rowYs.length).toBe(2);
    expect(mainYs.slice(0, 4)).toEqual([rowYs[0], rowYs[0], rowYs[0], rowYs[0]]);
    expect(mainYs.slice(4)).toEqual([rowYs[1], rowYs[1], rowYs[1]]);
    expect(rowYs[1]! - rowYs[0]!).toBeGreaterThanOrEqual(116 + 32); // 行距容得下连线/边标签
    // 行内仍保持 LR:同一行内 x 严格递增(不破坏 LR 语义)
    const row0 = MAIN.slice(0, 4).map((id) => r.pos.get(id)!.x);
    const row1 = MAIN.slice(4).map((id) => r.pos.get(id)!.x);
    for (let i = 1; i < row0.length; i++) expect(row0[i]!).toBeGreaterThan(row0[i - 1]!);
    for (let i = 1; i < row1.length; i++) expect(row1[i]!).toBeGreaterThan(row1[i - 1]!);
    // 下一行从左侧重新起排(列序折行)
    expect(row1[0]).toBe(row0[0]);

    // 所有节点(主干 + 分支)都有 pos/size;分支没被折行丢掉
    for (const n of nodes) {
      expect(r.pos.get(n.id), n.id + " 有 pos").toBeDefined();
      expect(r.size.get(n.id), n.id + " 有 size").toBeDefined();
      const p = r.pos.get(n.id)!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
    // 泳道数据完整:nodes 并集=全部节点,laneOf 每个节点可查
    const seen: string[] = [];
    for (const lane of r.lanes) for (const id of lane.nodes) seen.push(id);
    expect(seen.slice().sort()).toEqual(nodes.map((n) => n.id).sort());
    for (const n of nodes) expect(typeof r.laneOf.get(n.id)).toBe("string");
    // 卡与卡不重叠(折行不能压卡)
    expect(overlaps(rectsOf(r, nodes.map((n) => n.id)))).toEqual([]);
  });

  it("autoWrap 与 wrap:true 同效;同输入两次逐字节一致(确定性)", () => {
    const { nodes, edges } = makeDoc("01 全段");
    const a = BFL.layout({ nodes, edges }, { wrap: true }) as Res;
    const b = BFL.layout({ nodes, edges }, { autoWrap: true }) as Res;
    const c = BFL.layout({ nodes, edges }, { autoWrap: true }) as Res;
    for (const id of nodes.map((n) => n.id)) {
      expect(b.pos.get(id)).toEqual(a.pos.get(id));
      expect(c.pos.get(id)).toEqual(b.pos.get(id));
    }
    expect(c.mainPath).toEqual(b.mainPath);
    expect(c.lanes.map((l) => [l.no, l.label, l.x, l.y, l.w, l.h])).toEqual(b.lanes.map((l) => [l.no, l.label, l.x, l.y, l.w, l.h]));
  });

  it("泳道跨行时按行拆段:一条泳道两个框,不画跨行巨框(数据仍是一个 lane)", () => {
    const { nodes, edges } = makeDoc("01 全段");
    const r = BFL.layout({ nodes, edges }, { wrap: true }) as Res & { lanes: { boxes?: { x: number; y: number; w: number; h: number; row: number }[] }[] };
    expect(r.lanes.length).toBe(1); // 单 group → 单泳道
    const lane = r.lanes[0] as any;
    expect(Array.isArray(lane.boxes)).toBe(true);
    expect(lane.boxes.length).toBe(2); // 前 4 列一行、后 3 列一行
    expect(lane.boxes[0].row).toBe(0);
    expect(lane.boxes[1].row).toBe(1);
    // 段框不跨行:上一段的底 <= 下一段的顶(没有覆盖两行的巨框)
    for (let i = 1; i < lane.boxes.length; i++) {
      expect(lane.boxes[i].y).toBeGreaterThanOrEqual(lane.boxes[i - 1].y + lane.boxes[i - 1].h - 0.5);
    }
    const mainYs = MAIN.map((id) => r.pos.get(id)!.y);
    const rowYs = [...new Set(mainYs)].sort((a, b) => a - b);
    expect(lane.boxes[0].h).toBeLessThan(rowYs[1]! - rowYs[0]!); // 单段高度 < 行距(不跨行)
    // 每个节点至少被一个段框覆盖
    for (const n of nodes) {
      const p = r.pos.get(n.id)!;
      const hit = lane.boxes.some((bx: any) => p.x >= bx.x - 0.5 && p.x + 208 <= bx.x + bx.w + 0.5 && p.y >= bx.y - 0.5 && p.y + 116 <= bx.y + bx.h + 0.5);
      expect(hit, n.id + " 被某个段框覆盖").toBe(true);
    }
    // lane union 仍覆盖所有段(面板世界尺寸/适配用)
    for (const bx of lane.boxes) {
      expect(bx.x).toBeGreaterThanOrEqual(lane.x - 0.5);
      expect(bx.y).toBeGreaterThanOrEqual(lane.y - 0.5);
      expect(bx.x + bx.w).toBeLessThanOrEqual(lane.x + lane.w + 0.5);
      expect(bx.y + bx.h).toBeLessThanOrEqual(lane.y + lane.h + 0.5);
    }
  });

  it("不触发折行的三种情况:opts 缺省 / compact:false / 主路径未超阈值 → 逐字横排", () => {
    const { nodes, edges } = makeDoc("01 全段");
    // ① opts 缺省与 compact:false:wrap.active=false,主路径仍一条横线(既有行为逐字不变)
    for (const opts of [undefined, {}, { compact: false }] as const) {
      const r = BFL.layout({ nodes, edges }, opts as never) as Res & { wrap?: { active: boolean } };
      expect(r.wrap && r.wrap.active).toBe(false);
      const ys = MAIN.map((id) => r.pos.get(id)!.y);
      expect(new Set(ys).size).toBe(1);
      expect(ys[0]).toBe(r.baseline);
      const xs = MAIN.map((id) => r.pos.get(id)!.x);
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    }
    // ② 主路径 3 列(未超阈值):即使显式 wrap 也不折(横排本来就读得下)
    const small = ["s0", "s1", "s2"];
    const smallNodes = small.map((id) => N(id));
    const smallEdges = [E("s0", "s1"), E("s1", "s2")];
    const rs = BFL.layout({ nodes: smallNodes, edges: smallEdges }, { wrap: true }) as Res & { wrap: { active: boolean } };
    expect(rs.wrap.active).toBe(false);
    expect(new Set(small.map((id) => rs.pos.get(id)!.y)).size).toBe(1);
  });
});

describe("泳道框去重叠(2026-10-19 用户实报「白板花」)", () => {
  it("组内节点跨列 → 重叠框合并为一条,标签拼接,零重叠", () => {
    // 复刻桌面 exe 板形态:5 组,组内节点被图依赖层打散(启动组 n1@L0/n2@L2)
    const nodes = [
      N("n1", "start", "桌面壳入口", "01 启动"),
      N("n4", "module", "数据根隔离", "03 数据"),
      N("n2", "tool", "gateway 子进程", "01 启动"),
      N("n5", "module", "资源定位", "03 数据"),
      N("n3", "decision", "就绪判活", "02 联调"),
      N("n8", "function", "进程回收", "02 联调"),
    ];
    const edges = [E("n1", "n4"), E("n4", "n2"), E("n2", "n5"), E("n1", "n3"), E("n3", "n8")];
    const r = L(nodes, edges);
    function ov(a: any, b: any) { return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5; }
    for (let i = 0; i < r.lanes.length; i++) for (let j = i + 1; j < r.lanes.length; j++) expect(ov(r.lanes[i], r.lanes[j])).toBe(false);
    // 跨列组必然合并(< 原有分组数),标签保留各阶段名
    expect(r.lanes.length).toBeLessThan(3);
    const allLabels = r.lanes.map((l) => l.label).join(" · ");
    for (const want of ["启动", "联调", "数据"]) expect(allLabels).toContain(want);
    // 合并后每个泳道仍是稳定结构:节点归属齐全、框覆盖自己节点
    const seen = new Set<string>();
    for (const lane of r.lanes) {
      for (const id of lane.nodes) { seen.add(id); const p = r.pos.get(id)!; expect(p.x).toBeGreaterThanOrEqual(lane.x); expect(p.y).toBeGreaterThanOrEqual(lane.y); }
    }
    expect([...seen].sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it("列内分组(不跨列)→ 不合并,原编号与标签不变", () => {
    const nodes = [N("a", "function", "A", "01 采集"), N("b", "function", "B", "01 采集"), N("c", "function", "C", "02 处理")];
    const r = L(nodes, [E("a", "b"), E("b", "c")]);
    expect(r.lanes.length).toBe(2);
    expect(r.lanes.map((l) => l.label)).toEqual(["采集", "处理"]);
    expect(r.lanes.some((l: any) => l.merged)).toBe(false);
  });
});

describe("泳道按写者分区(q6:多路 agent 复用同一 group 文案)", () => {
  it("不同前缀的同名 group → 两条泳道(标题加 [前缀],不合并)", () => {
    // 复刻实测病灶:两路写者各自落「01 卡渲染」,不分区时 30/39 节点塌进一个框
    const nodes = [
      N("a1-entry", "function", "盲测入口", "01 卡渲染"),
      N("a1-card", "module", "卡片骨架", "01 卡渲染"),
      N("c1-perf", "tool", "性能采样", "01 卡渲染"),
      N("c1-card", "module", "卡片密度", "01 卡渲染"),
    ];
    const r = L(nodes, [E("a1-entry", "a1-card"), E("a1-card", "c1-perf"), E("c1-perf", "c1-card")]);

    const labels = r.lanes.map((l) => l.label).sort();
    expect(labels).toEqual(["[a1] 卡渲染", "[c1] 卡渲染"]);
    // 同一 group 文案被拆成两条:每路写者各占一条,不再并成一个大框
    expect(r.lanes.length).toBe(2);
    expect(r.lanes.some((l: any) => l.merged)).toBe(false);
    const byPrefix = new Map(r.lanes.map((l) => [l.label, l.nodes.slice().sort()]));
    expect(byPrefix.get("[a1] 卡渲染")).toEqual(["a1-card", "a1-entry"]);
    expect(byPrefix.get("[c1] 卡渲染")).toEqual(["c1-card", "c1-perf"]);
    // laneOf 按写者命名空间分键(渲染层 data-lane 不再撞在一起)
    expect(r.laneOf.get("a1-card")).toBe("g:a1:01 卡渲染");
    expect(r.laneOf.get("c1-card")).toBe("g:c1:01 卡渲染");
  });

  it("同前缀同名 group 仍合并成一条;无前缀节点的组名不带方括号(向后兼容)", () => {
    const nodes = [
      N("a1-card-a", "module", "卡片A", "01 卡渲染"),
      N("a1-card-b", "module", "卡片B", "01 卡渲染"),
      N("plainone", "module", "无写者", "02 输出"), // 无 `-` 前缀 = 老板形态
    ];
    const r = L(nodes, [E("a1-card-a", "a1-card-b"), E("a1-card-b", "plainone")]);

    // 同写者同 group → 一条(前缀只出现一次方括号)
    const a1 = r.lanes.filter((l) => l.label.indexOf("卡渲染") >= 0);
    expect(a1.length).toBe(1);
    expect(a1[0]!.label).toBe("[a1] 卡渲染");
    expect(a1[0]!.nodes.slice().sort()).toEqual(["a1-card-a", "a1-card-b"]);
    // 无前缀节点:key 保持 g:<group> 原样,文案不显示方括号
    const plain = r.lanes.filter((l) => l.nodes.indexOf("plainone") >= 0)[0]!;
    expect(plain.label).toBe("输出");
    expect(plain.label).not.toContain("[");
    expect(r.laneOf.get("plainone")).toBe("g:02 输出");
  });

  it("不同写者的泳道即使 bbox 相互重叠也不在「去重叠」阶段合并", () => {
    // 两路写者的组各自跨列(层 0..2 交错)→ 两个虚线框必然重叠,旧逻辑会并成一条大框
    const nodes = [
      N("a1-x", "module", "a1 首", "01 卡渲染"),
      N("c1-y", "module", "c1 首", "01 卡渲染"),
      N("a1-z", "module", "a1 尾", "01 卡渲染"),
      N("c1-w", "module", "c1 尾", "01 卡渲染"),
    ];
    const r = L(nodes, [E("a1-x", "c1-y"), E("c1-y", "a1-z"), E("a1-z", "c1-w")]);

    const card = r.lanes.filter((l) => l.label.indexOf("卡渲染") >= 0);
    expect(card.length).toBe(2); // 同 group 文案但不同写者:各留一框,不合并
    expect(card.map((l) => l.label).sort()).toEqual(["[a1] 卡渲染", "[c1] 卡渲染"]);
    expect(card.every((l) => !(l as any).merged)).toBe(true);
    // 节点归属仍完整(不因拒绝合并而丢节点)
    const seen = new Set<string>();
    for (const l of r.lanes) for (const id of l.nodes) seen.add(id);
    expect([...seen].sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it("实测规模复刻:5 路写者各自落「01 卡渲染」→ 5 条泳道,不再塌成一个框", () => {
    const prefixes = ["a1", "b1", "c1", "d1", "e1"];
    const nodes: TN[] = [];
    for (const p of prefixes) for (let i = 0; i < 3; i++) nodes.push(N(`${p}-n${i}`, "module", `${p} 步${i}`, "01 卡渲染"));
    for (let g = 1; g <= 7; g++) {
      const grp = `0${(g % 9) + 1} 阶段${g}`;
      // 无前缀 id(不带 `-`)= 老板形态,泳道 key 必须保持 g:<group>
      for (let i = 0; i < 2; i++) nodes.push(N(`grp${g}x${i}`, "module", `组${g} 步${i}`, grp));
    }
    const edges = nodes.slice(1).map((n, i) => E(nodes[i]!.id, n.id));
    const r = L(nodes, edges);

    const card = r.lanes.filter((l) => l.label.indexOf("卡渲染") >= 0);
    expect(card.length).toBe(5); // 5 路写者各一条,而不是并成 1 条
    expect(card.map((l) => l.label).sort()).toEqual(["a1", "b1", "c1", "d1", "e1"].map((p) => `[${p}] 卡渲染`));
    for (const l of card) expect(l.nodes.length).toBe(3);
    // 无前缀的组仍是老板形态:文案不带方括号(laneOf 键也保持 g:<group>)
    const plain = r.lanes.filter((l) => /阶段\d/.test(l.label));
    expect(plain.length).toBeGreaterThan(0);
    for (const l of plain) expect(l.label).not.toContain("[");
    expect(r.laneOf.get("grp1x0")).toBe("g:02 阶段1");
  });

  it("写者分区后不同写者的泳道框互不重叠(7c 纵向让位)+ 编号随让位重排", () => {
    // 实测回归:禁止跨写者合并后,原本被「合并」掩盖的重叠变成 6 对框叠画。
    const nodes = [
      N("r1", "module", "复测入口", "01 复测"),
      N("b1-a", "module", "采集", "01 采集"),
      N("c1-a", "module", "取证", "01 取证"),
      N("a1-a", "module", "卡渲染", "01 卡渲染"),
    ];
    const r = L(nodes, [E("r1", "b1-a"), E("b1-a", "c1-a"), E("c1-a", "a1-a")]);
    // 不同写者各占一框(不合并),且框之间零重叠
    expect(r.lanes.length).toBe(4);
    for (let i = 0; i < r.lanes.length; i++) {
      for (let j = i + 1; j < r.lanes.length; j++) {
        const a = r.lanes[i]!, b = r.lanes[j]!;
        const overlap = a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
        expect(overlap).toBe(false);
      }
    }
    // 标题不得被拼成「A · B · C」串
    for (const l of r.lanes) expect(l.label).not.toContain(" · ");
    // 编号随分离后次序重排:01..04 连续且按 y 自上而下
    expect(r.lanes.map((l) => l.no)).toEqual(["01", "02", "03", "04"]);
    const ys = r.lanes.map((l) => l.y);
    expect(ys).toEqual(ys.slice().sort((a, b) => a - b));
  });

  it("长前缀(系统派生的 5 字符 scope)也必须能分区(2026-10-24 实测回归)", () => {
    // 实测:plannerScopeOf 产出 `p`+4 位 = 5 字符(如 pqa6e),旧正则 {1,3} 全部识别不出
    // → 42 节点板又并成一条「01流式输入 · 度量 · 方向 · …」11 段拼串的大泳道。
    const nodes = [
      N("pqa6e-r3a1", "function", "段生成", "01 段对位"),
      N("pqa6e-r3a2", "function", "段对位", "01 段对位"),
      N("pyhan-n1", "function", "状态归并", "01 段对位"),
      N("pmuxi-r1", "function", "体感度量", "01 段对位"),
    ];
    const r = L(nodes, [E("pqa6e-r3a1", "pqa6e-r3a2"), E("pqa6e-r3a2", "pyhan-n1"), E("pyhan-n1", "pmuxi-r1")]);
    // 三路写者各一条泳道,标题带 [前缀]
    expect(r.lanes.length).toBe(3);
    expect(r.lanes.map((l) => l.label).sort()).toEqual(["[pmuxi] 段对位", "[pqa6e] 段对位", "[pyhan] 段对位"]);
    // 不得被合并成一条(拼串)
    for (const l of r.lanes) expect(l.label).not.toContain(" · ");
    expect(r.laneOf.get("pqa6e-r3a1")).toBe("g:pqa6e:01 段对位");
  });

  it("同写者多段合并:泳道头去重前缀、段数 ≤3(实测头被拼成 11 段含 4 个同前缀)", () => {
    // 实测病灶:42 节点板里同写者 pqa6e 的多个 group 被合到一条框上,
    // 头变成「01[pqa6e] 段对位 · [pqa6e] 段级对位 · [pqa6e] 兜底 · [pqa6e] 流式输入」。
    // 构造:两组各自跨列(边交叉)→ 7b 合并分支必然触发。
    const nodes = [
      N("pqa6e-a", "function", "段生成", "01 段对位"),
      N("pqa6e-b", "function", "段级", "02 段级对位"),
      N("pqa6e-c", "function", "兜底", "03 兜底"),
      N("pqa6e-d", "function", "流式", "04 流式输入"),
    ];
    const r = L(nodes, [E("pqa6e-a", "pqa6e-b"), E("pqa6e-c", "pqa6e-d"), E("pqa6e-a", "pqa6e-c"), E("pqa6e-b", "pqa6e-d")]);
    const all = r.lanes.map((l) => l.label);
    // 前提:本场景确实发生了合并(否则这条用例没验到东西)
    expect(all.some((s) => s.indexOf(" · ") >= 0)).toBe(true);
    // 同一前缀在单条泳道头最多出现一次(去重)
    for (const s of all) expect((s.match(/\[pqa6e\]/g) || []).length).toBeLessThanOrEqual(1);
    // 截断残留不叠罗汉:不出现「… …」
    for (const s of all) expect(s).not.toContain("… …");
    // 段数受限:最多 3 段(2 个分隔符)
    for (const s of all) expect((s.match(/ · /g) || []).length).toBeLessThanOrEqual(2);
  });
});

// ---- 7d 碎泳道合并(2026-10-25 白板易读性:实测 60 节点板 21 条泳道 / 平均 2.8 节点 / 碎成条带)----
describe("碎泳道合并(7d):单节点泳道按同写者收拢,不同写者绝不合并", () => {
  const laneOv = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
    a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
  const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));

  it("①同一写者的 21 条单节点碎泳道合并后 ≤8 条,且零重叠、节点一个不少", () => {
    // 病灶复刻:每个节点单独一个 group(= 每条带上只有一个卡),但都属于同一路写者 w1
    const nodes: TN[] = [];
    for (let i = 0; i < 21; i++) nodes.push(N("w1-n" + i, "function", "步骤" + i, pad2(i + 1) + " 阶段" + (i + 1)));
    const edges = nodes.slice(1).map((n, i) => E(nodes[i]!.id, n.id)); // 链式边:有位置,不进「未连接」
    const r = L(nodes, edges);

    const real = r.lanes.filter((l) => !l.isolated);
    expect(real.length).toBeGreaterThan(0);
    expect(real.length).toBeLessThanOrEqual(8); // 21 条 → ≤8 条(读图一屏能读完的流程条数)
    expect(real.length).toBeLessThan(21);       // 真的收了,不是原样留着
    // 零重叠:合并后的框必须互斥(7d 合并会放大 bbox,收完要复跑纵向让位)
    for (let i = 0; i < r.lanes.length; i++) {
      for (let j = i + 1; j < r.lanes.length; j++) expect(laneOv(r.lanes[i]!, r.lanes[j]!)).toBe(false);
    }
    // 节点一个不少、不重复:各泳道 nodes 并集 = 全部 21 个
    const seen: string[] = [];
    for (const l of r.lanes) for (const id of l.nodes) seen.push(id);
    expect(seen.slice().sort()).toEqual(nodes.map((n) => n.id).sort());
    // 编号跟着最终泳道重排:01..N 连续不跳号
    expect(r.lanes.filter((l) => !l.isolated).map((l) => l.no)).toEqual(real.map((_l, i) => pad2(i + 1)));
    // 段数/截断纪律与 7b 同口径
    for (const l of r.lanes) {
      expect(l.label).not.toContain("… …");
      expect((l.label.match(/ · /g) || []).length).toBeLessThanOrEqual(2);
    }
  });

  it("②不同写者的单节点泳道不合并(写者守卫);无前缀的「其他」也不并进有写者的框", () => {
    // 5 路写者 + 1 个无前缀节点,全部落在**同一个 group 文案**上:不按写者分区就会塌成一框
    const ids = ["a1-x", "c1-x", "d1-x", "e1-x", "f1-x", "plainnode"];
    const nodes = ids.map((id) => N(id, "module", id, "01 卡渲染"));
    const edges = ids.slice(1).map((id, i) => E(ids[i]!, id));
    const r = L(nodes, edges);

    const real = r.lanes.filter((l) => !l.isolated);
    expect(real.length).toBe(6); // 一条都不许并(7d 不能越权合并不同写者)
    // 每条泳道只含单一写者的节点(混入不同前缀即踩线)
    const wOf = (id: string) => {
      const k = id.indexOf("-");
      if (k <= 0 || k > 7) return "";
      const head = id.slice(0, k);
      return /^[A-Za-z][A-Za-z0-9]*$/.test(head) && head !== "ph" ? head : "";
    };
    for (const l of real) {
      const ws = new Set(l.nodes.map(wOf));
      expect(ws.size).toBe(1);
    }
    // 无前缀节点独占一条(writer 空串是独立命名空间)
    const plain = real.filter((l) => l.nodes.indexOf("plainnode") >= 0)[0]!;
    expect(plain.nodes).toEqual(["plainnode"]);
    // 零重叠(让位仍在生效)
    for (let i = 0; i < r.lanes.length; i++) {
      for (let j = i + 1; j < r.lanes.length; j++) expect(laneOv(r.lanes[i]!, r.lanes[j]!)).toBe(false);
    }
  });

  // ---- 主干换行(2026-10-25 实测:60 节点板主干 7 卡一字排开 x 跨 1351px / y 只占 81px,
  //      HOST 1078×457 下自然 k≈0.196 → 适配 k 撞 0.7 可读下限,一屏仍只看得到 5/7 张)----
  it("主干换行:compact 下主干每行 ≤4 张按列换行(x 跨度 ≤ 4 卡宽+3 列距,行数 ≥2,bounds 跟真实位)", () => {
    const NODE_W = 208, NODE_H = 116;
    const ORDER = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"];
    const nodes = ORDER.map((id) => N(id, "module", "主干" + id, "01 阶段"));
    const edges = ORDER.slice(1).map((id, i) => E(ORDER[i]!, id));
    const r = BFL.layout({ nodes, edges }, { compact: true }) as Res;

    // 前提:这 7 个节点确实构成主干(否则用例没验到东西)
    expect(r.mainPath).toEqual(ORDER);

    const xs = ORDER.map((id) => r.pos.get(id)!.x);
    const ys = ORDER.map((id) => r.pos.get(id)!.y);
    const xSpan = Math.max(...xs) + NODE_W - Math.min(...xs);
    // x 跨度 ≤ 4 卡宽 + 3 列距(4 × 208 + 3 × 56 = 1000);实测换行后 = 1000(换行前 1792)
    expect(xSpan).toBeLessThanOrEqual(4 * NODE_W + 3 * 56);
    expect(xSpan).toBeLessThan(1351); // 任务书基线:换行前 x 跨度 1351px(实测同构板 1792)
    // 行数 ≥ 2,且行距 ≥ 48px(行间要留得下连线与边标签)
    const rowsY = [...new Set(ys)].sort((a, b) => a - b);
    expect(rowsY.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rowsY.length; i++) expect(rowsY[i]! - rowsY[i - 1]!).toBeGreaterThanOrEqual(NODE_H + 32 - 68); // ≥ 48px 净行距
    expect(rowsY[1]! - rowsY[0]!).toBeGreaterThanOrEqual(48);
    // 每行 ≤4 张:同一行内的卡数不超过 4
    const perRow = rowsY.map((y) => ys.filter((v) => v === y).length);
    for (const n of perRow) expect(n).toBeLessThanOrEqual(4);
    expect(perRow[0]).toBe(4); // 7 张 = 4 + 3
    // bounds 跟着换行后的真实位置算(适配 k 依赖它):所有主干卡都在 bounds 内,且宽度收窄
    for (const id of ORDER) {
      const p = r.pos.get(id)!, s = r.size.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(r.bounds.x);
      expect(p.y).toBeGreaterThanOrEqual(r.bounds.y);
      expect(p.x + s.w).toBeLessThanOrEqual(r.bounds.x + r.bounds.w + 0.5);
      expect(p.y + s.h).toBeLessThanOrEqual(r.bounds.y + r.bounds.h + 0.5);
    }
    expect(r.bounds.w).toBeLessThanOrEqual(1100); // 换行前同构板 ≈ 1722+ 量级
    expect(r.bounds.h).toBeGreaterThanOrEqual(2 * NODE_H); // 真的排了两行
    // 卡与卡不重叠(换行不能压卡)
    expect(overlaps(rectsOf(r, ORDER))).toEqual([]);
  });

  it("主干换行:非 compact 路径逐字不变(主干仍是一条横线:同 y、x 严格递增)", () => {
    const ORDER = ["m0", "m1", "m2", "m3", "m4", "m5", "m6"];
    const nodes = ORDER.map((id) => N(id, "module", "主干" + id, "01 阶段"));
    const edges = ORDER.slice(1).map((id, i) => E(ORDER[i]!, id));
    // opts 缺省 / compact:false 两种都要保持横排
    for (const opts of [undefined, {}, { compact: false }] as const) {
      const r = BFL.layout({ nodes, edges }, opts as never) as Res;
      const ys = ORDER.map((id) => r.pos.get(id)!.y);
      const xs = ORDER.map((id) => r.pos.get(id)!.x);
      expect(new Set(ys).size).toBe(1);              // 全部同基线
      expect(ys[0]).toBe(r.baseline);
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!); // 一条横线
    }
  });

  it("compact:跳过 7c 纵向让位与 7d 碎泳道合并,主干纵向跨度显著收窄", () => {
    // 实测病灶:60 节点板让位后主干卡跨 y 2072px,视口只 304px,适配 k 撞 0.7 可读下限。
    // compact 给「密度分层」用:卡片已被面板收成 +N,让位/合并只会有害(把卡拉开)。
    const nodes: TN[] = [];
    for (let i = 0; i < 6; i++) nodes.push(N(`p${i}-a`, "module", `写者${i}入口`, `01 阶段${i}`));
    for (let i = 0; i < 6; i++) nodes.push(N(`p${i}-b`, "module", `写者${i}工序`, `02 阶段${i}`));
    const edges: TE[] = [];
    for (let i = 0; i < 6; i++) edges.push(E(`p${i}-a`, `p${i}-b`));
    const def = L(nodes, edges);
    const compact = BFL.layout({ nodes, edges }, { compact: true }) as Res;
    const span = (r: Res) => {
      const ys = [...r.pos.values()].map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    // 纵向跨度必须显著收窄(让位不再把泳道一排排堆下去)
    expect(span(compact)).toBeLessThan(span(def));
    // 节点位全在(收卡是面板的事,布局不能丢节点)
    expect(compact.pos.size).toBe(def.pos.size);
    // compact 不做碎泳道合并 → 泳道数不少于默认(默认会合)
    expect(compact.lanes.length).toBeGreaterThanOrEqual(def.lanes.length);
  });

  // ---- 空壳泳道降噪(2026-10-25 实测 60 节点真实板:compact 下 .cv-node=7 / .cv-lane=21) ----
  it("compact 空壳泳道:无主干卡的泳道只标 boxless 不画框,有主干卡的泳道全部保留框,数据不丢", () => {
    // 病灶:密度分层态下卡片被面板收成 +N,但 21 条虚框照画——21 框 vs 7 卡(3:1),
    // 其中 18 条泳道的成员全被收进计数块(框里空无一物),互相重叠把画面糊住、框与内容脱钩。
    const MAIN = ["ta-m0", "ta-m1", "ta-m2", "ta-m3", "ta-m4", "ta-m5", "ta-m6"];
    const GROUPS = ["01 取证", "02 归因", "03 防护"];
    const nodes: TN[] = [];
    const edges: TE[] = [];
    MAIN.forEach((id, i) => nodes.push(N(id, "module", "主干" + i, GROUPS[Math.min(2, Math.floor(i / 3))]!)));
    for (let i = 1; i < MAIN.length; i++) edges.push(E(MAIN[i - 1]!, MAIN[i]!));
    // 40 个侧支节点:6 路写者 × 若干组,每组自成一泳道且**不含主干卡**(成员全会被收进 +N)
    let sideN = 0;
    for (let w = 0; w < 6; w++) {
      for (let g = 0; g < 6; g++) {
        const id = "t" + (w + 1) + "-s" + g + "-" + w;
        nodes.push(N(id, "function", "侧支" + sideN, pad2(10 + w * 6 + g) + " 分项" + w));
        edges.push(E(MAIN[g % 3]!, id)); // 从主干中段分叉(不拉长主干路径 / 不进孤立列)
        sideN++;
      }
    }
    nodes.push(N("ph-verify", "module", "验证", undefined)); // 阶段卡(无边,固定落「00 流程」)
    expect(nodes.length).toBeGreaterThanOrEqual(40);

    const r = BFL.layout({ nodes, edges }, { compact: true }) as Res;
    expect(r.mainPath.length).toBe(MAIN.length); // 前提:这 7 张确实构成主干
    expect(r.lanes.length).toBeGreaterThan(7);   // 前提:泳道确实很碎(不碎就没这个病灶)

    const boxless = r.lanes.filter((l) => !!l.boxless);
    const boxed = r.lanes.filter((l) => !l.boxless);
    // ① 空壳泳道确实被标记出来(>0),且一条都不含主干卡
    expect(boxless.length).toBeGreaterThan(0);
    for (const l of boxless) expect(l.nodes.filter((id) => r.mainNodes.has(id))).toEqual([]);
    // ② 有主干卡的泳道 + 阶段泳道全部保留框(不能把主干框也降噪掉)
    for (const l of r.lanes) {
      if (!l.isPhase && l.nodes.some((id) => r.mainNodes.has(id))) expect(l.boxless).toBeFalsy();
      if (l.isPhase) expect(l.boxless).toBeFalsy();
    }
    // ③ 画出来的框 ≤7(21 → ≤7 的口径),且主干所在的每条泳道都在框里
    expect(boxed.length).toBeLessThanOrEqual(7);
    for (const id of MAIN) {
      const key = r.laneOf.get(id)!;
      const lane = r.lanes.find((l) => l.key === key)!;
      expect(lane.boxless).toBeFalsy();
    }
    // ④ 数据不丢:lanes 数组长度不变(面板要靠 key→label 算 +N 计数块)、每条 boxless 泳道仍带
    //    key/label/no(计数块 title「编号 泳道名 里的 N 个节点」直接用),laneOf 仍能查到归属
    expect(boxed.length + boxless.length).toBe(r.lanes.length);
    for (const l of boxless) {
      expect(typeof l.key).toBe("string");
      expect(l.key.length).toBeGreaterThan(0);
      expect(String(l.label || "").length).toBeGreaterThan(0);
      expect(l.no).toMatch(/^[0-9]+$/);
      for (const id of l.nodes) expect(r.laneOf.get(id)).toBe(l.key);
    }
    const seen: string[] = [];
    for (const l of r.lanes) for (const id of l.nodes) seen.push(id);
    expect(seen.slice().sort()).toEqual(nodes.map((n) => n.id).sort()); // 节点一个不少、不重复
    // ⑤ 非 compact 路径逐字不变:默认布局一条都不标 boxless(展开态要看全部泳道框)
    const def = L(nodes, edges);
    expect(def.lanes.every((l) => !l.boxless)).toBe(true);
  });
});

describe("板型画布选项(2026-10-26)", () => {
  it("nodeW/nodeH:按板型放大卡片,缺省仍 208×116", () => {
    const nodes = [N("a"), N("b")];
    const edges = [E("a", "b", "next")];
    const d = L(nodes, edges);
    expect(d.size.get("a")).toEqual({ w: 208, h: 116 });
    const t = BFL.layout({ nodes, edges }, { nodeW: 228, nodeH: 150 }) as Res;
    expect(t.size.get("a")).toEqual({ w: 228, h: 150 });
  });

  it("preserveLanes:refactor 现状/目标双泳道不允许被合并,重叠框纵向让位", () => {
    const nodes = [
      N("a", "function", "01 现状入口", "01 现状"),
      N("b", "function", "02 现状下游", "01 现状"),
      N("c", "function", "01 目标入口", "02 目标"),
      N("d", "function", "02 目标下游", "02 目标"),
    ];
    const edges = [E("a", "b", "现状"), E("c", "d", "目标")];
    const r = BFL.layout({ nodes, edges }, { preserveLanes: true }) as Res;
    const real = r.lanes.filter((l) => !l.isolated);
    expect(real).toHaveLength(2);
    expect(real.map((l) => l.label).sort()).toEqual(["现状", "目标"].sort());
    const boxes = real.map((l) => ({ id: l.key, x: l.x, y: l.y, r: l.x + l.w, b: l.y + l.h }));
    expect(overlaps(boxes)).toEqual([]);
  });
});
