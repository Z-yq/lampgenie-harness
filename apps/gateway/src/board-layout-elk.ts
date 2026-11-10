/**
 * 白板布局:自实现的「分层 + 折行(wrapping layered)」布局,契约与 flowkit 的
 * `headlessElkLayout` 完全一致 —— `{ run(graph, signal) } → { positions, sizes }`。
 * 为什么自己写(2026-11 经验证):
 * - `@openflowkit/openflowkit-mcp` 的 `headlessElkLayout` 是个**对象** `{ run }`,内部把 ELK 选项写死
 *   (`elk.algorithm=layered` / `elk.edgeRouting=ORTHOGONAL` / `hierarchyHandling=INCLUDE_CHILDREN` /
 *   `spacing.nodeNode=48` / `nodeNodeBetweenLayers=64` / `considerModelOrder=NODES_AND_EDGES` /
 *   `randomSeed=1337`),**没有 wrapping、没有 aspectRatio** → 长链板排成单列长条
 *   (17 节点 viewBox 4349×798 = 5.45:1,缩放后不可读)。
 * - 该包把 ELK 引擎(elkjs)bundle 进 `dist/generated/openflowkit-agent.js` 后**没有导出**,
 *   工程里也没有独立 elkjs 依赖,因此拿不到可注入 layoutOptions 的实例。
 *   本模块按同一套语义自实现,等价参数见 `ELK_EQ_OPTIONS`:
 *   layered + SEPARATE_CHILDREN + wrapping MULTI_EDGE + aspectRatio。
 * 与 ELK 对齐的三个关键点:
 * 1. **回边反转**:有环图先用 DFS 找出回边,反转后再算层(等价 ELK 内部 cycle breaking),
 *    否则最长路径分层不收敛。
 * 2. **边标签占位**:带 label 的边在两列之间撑开标签尺寸(label 尺寸来自 graph,不自己猜),
 *    否则带 label 的板节点会挤在一起。
 * 3. **跨组边提升 + 每作用域独立排布**(等价 hierarchyHandling=SEPARATE_CHILDREN):
 *    组的孙节点之间的边提升到「组」这一级决定组的相对次序,组内部再各自折行。
 * 目标宽高比是**全局**约束:组本身的折行会把组撑成不同长宽比,只按局部 1.6 折行会得到粗粒度结果,
 * 所以外层对「内层折行目标」做一次小候选搜索(见 INNER_ASPECT_CANDIDATES),取整体宽高比最贴近的一张。
 * 坐标约定与 flowkit 消费者一致:**位置相对父容器**,容器尺寸含 padding。
 */

/** ELK 等价参数(诊断/文档引用用;本模块按此语义自实现)。 */
export const ELK_EQ_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.hierarchyHandling": "SEPARATE_CHILDREN",
  "elk.layered.wrapping.strategy": "MULTI_EDGE",
  "elk.aspectRatio": "1.6",
  "elk.spacing.nodeNode": "48",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
} as const;

export interface BoardLayoutRect {
  width: number;
  height: number;
}

export interface BoardLayoutPadding {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface BoardLayoutNodeIn {
  id: string;
  parentId?: string;
  size?: { width?: number; height?: number };
  minSize?: { width?: number; height?: number };
  direction?: string;
}

export interface BoardLayoutEdgeIn {
  id: string;
  sourceId: string;
  targetId: string;
  /** 标签占位尺寸(flowkit 已量好);有 label 就在列间距里撑出这段空间。 */
  label?: { width?: number; height?: number };
}

export interface BoardLayoutGraphIn {
  rootId?: string;
  rootPadding?: Partial<BoardLayoutPadding>;
  groupPadding?: Partial<BoardLayoutPadding>;
  direction?: string;
  nodes?: BoardLayoutNodeIn[];
  edges?: BoardLayoutEdgeIn[];
}

export interface BoardLayoutResult {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, BoardLayoutRect>;
}

export interface BoardElkLayoutOptions {
  /** 目标宽高比(w/h),默认 1.6(接近 16:9)。 */
  aspectRatio?: number;
  /** 主流向:right(横向,默认;缺省取 graph.direction)/ down(纵向)。 */
  direction?: "right" | "down";
}

export interface BoardElkLayout {
  run(graph: BoardLayoutGraphIn, signal?: AbortSignal): Promise<BoardLayoutResult>;
}

const NODE_GAP = 48;
const LAYER_GAP = 64;
const BAND_GAP = 88;
const DEFAULT_LEAF: BoardLayoutRect = { width: 200, height: 88 };
const DEFAULT_GROUP_MIN: BoardLayoutRect = { width: 180, height: 132 };

/** 内层(组)折行的候选目标宽高比:组被撑成不同的长宽比,整体宽高比会随之变化。 */
const INNER_ASPECT_CANDIDATES = [0.8, 1.0, 1.25, 1.6, 2.0, 2.6, 3.4, 4.4];

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pad4(p: Partial<BoardLayoutPadding> | undefined, fallback: number): BoardLayoutPadding {
  return {
    top: num(p?.top, fallback),
    left: num(p?.left, fallback),
    bottom: num(p?.bottom, fallback),
    right: num(p?.right, fallback),
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Layout cancelled", "AbortError");
}

/** 一列(折行前的「层」,或层被拆细后的一段)。 */
interface Column {
  items: string[];
  rank: number;
}

interface BandPlan {
  bandCount: number;
  /** 每列所属 band 序号。 */
  assign: number[];
  /** 每个 band 沿主流向的长度。 */
  main: number[];
  /** 每个 band 沿交叉轴的长度。 */
  cross: number[];
}

/**
 * 建立 layout 对象。
 * @param opts aspectRatio 目标宽高比(默认 1.6);direction 主流向(默认取 graph.direction)
 */
export function createBoardElkLayout(opts: BoardElkLayoutOptions = {}): BoardElkLayout {
  const aspectRatio = num(opts.aspectRatio, 1.6);
  const forced = opts.direction === "down" || opts.direction === "right" ? opts.direction : undefined;

  return {
    async run(graph, signal) {
      checkAbort(signal);
      return layoutGraph(graph ?? { nodes: [] }, aspectRatio, forced, signal);
    },
  };
}

function layoutGraph(
  graph: BoardLayoutGraphIn,
  aspectRatio: number,
  forcedDirection: "right" | "down" | undefined,
  signal?: AbortSignal): BoardLayoutResult {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((n) => n && typeof n.id === "string") : [];
  if (nodes.length === 0) return { positions: {}, sizes: {} };
  const rootId = typeof graph.rootId === "string" && graph.rootId ? graph.rootId : "__root__";
  const byId = new Map<string, BoardLayoutNodeIn>();
  for (const n of nodes) byId.set(n.id, n);

  const vertical = (forcedDirection ?? (graph.direction === "down" ? "down" : "right")) === "down";
  const mainOf = (r: BoardLayoutRect): number => (vertical ? r.height : r.width);
  const crossOf = (r: BoardLayoutRect): number => (vertical ? r.width : r.height);

  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    const p = typeof n.parentId === "string" && n.parentId ? n.parentId : rootId;
    const arr = childrenOf.get(p);
    if (arr) arr.push(n.id);
    else childrenOf.set(p, [n.id]);
  }

  const edges: BoardLayoutEdgeIn[] = (Array.isArray(graph.edges) ? graph.edges : []).filter(
    (e) =>
      e &&
      typeof e.sourceId === "string" &&
      typeof e.targetId === "string" &&
      byId.has(e.sourceId) &&
      byId.has(e.targetId),
  );

  const rootPad = pad4(graph.rootPadding, 28);
  const groupPad = pad4(graph.groupPadding, 22);

  const parentOf = (id: string): string => {
    const n = byId.get(id);
    return n && typeof n.parentId === "string" && n.parentId ? n.parentId : rootId;
  };

  /** 节点在 scopeId 作用域里的代表条目:直接子节点返回自身,更深的上溯到最近的直接子节点。 */
  const ownerAtScope = (nodeId: string, scopeId: string): string | null => {
    let cur: string | undefined = nodeId;
    for (let guard = 0; guard < 256; guard += 1) {
      if (!cur || cur === scopeId) return null;
      if (!byId.has(cur)) return null;
      const p = parentOf(cur);
      if (p === scopeId) return cur;
      cur = p;
    }
    return null;
  };

  /** DFS 找回边(有环图必须先反转,否则分层不收敛)。 */
  const findBackEdges = (pairs: Array<{ id: string; from: string; to: string }>): Set<string> => {
    const out = new Map<string, Array<{ id: string; to: string }>>();
    for (const e of pairs) {
      const arr = out.get(e.from);
      if (arr) arr.push({ id: e.id, to: e.to });
      else out.set(e.from, [{ id: e.id, to: e.to }]);
    }
    const back = new Set<string>();
    const state = new Map<string, 1 | 2>();
    const visit = (id: string): void => {
      state.set(id, 1);
      for (const e of out.get(id) ?? []) {
        const st = state.get(e.to);
        if (st === 1) back.add(e.id);
        else if (!st) visit(e.to);
      }
      state.set(id, 2);
    };
    for (const e of pairs) if (!state.get(e.from)) visit(e.from);
    return back;
  };

  /** 折行规划:把列贪心分 band,给出每列归属与每 band 的主轴/交叉轴长度。 */
  const planBands = (colMain: number[], colCross: number[], gapAfter: number[], bandCount: number): BandPlan => {
    const totalMain = colMain.reduce((s, v) => s + v, 0) + gapAfter.reduce((s, v) => s + v, 0);
    const target = totalMain / bandCount;
    const assign: number[] = [];
    const main: number[] = new Array(bandCount).fill(0);
    const cross: number[] = new Array(bandCount).fill(0);
    let band = 0;
    let used = 0;
    for (let i = 0; i < colMain.length; i += 1) {
      const gap = i === 0 ? 0 : gapAfter[i - 1]!;
      const need = colMain[i]! + (used > 0 ? gap : 0);
      if (band < bandCount - 1 && used > 0 && used + need > target * 1.06) {
        band += 1;
        used = 0;
      }
      main[band] = main[band]! + (used > 0 ? gap : 0) + colMain[i]!;
      used += (used > 0 ? gap : 0) + colMain[i]!;
      cross[band] = Math.max(cross[band]!, colCross[i]!);
      assign.push(band);
    }
    return { bandCount, assign, main, cross };
  };

  /** 跑一遍完整布局:根用 aspectRatio,容器内部用 innerAspect。 */
  const runOnce = (innerAspect: number): BoardLayoutResult => {
    const positions: Record<string, { x: number; y: number }> = {};
    const sizes: Record<string, BoardLayoutRect> = {};

    const layoutScope = (scopeId: string, pad: BoardLayoutPadding, selfAspect: number, inner: number): BoardLayoutRect => {
      checkAbort(signal);
      const itemIds = [...(childrenOf.get(scopeId) ?? [])];
      const minSize = byId.get(scopeId)?.minSize;
      if (itemIds.length === 0) {
        return {
          width: Math.round(Math.max(num(minSize?.width, DEFAULT_GROUP_MIN.width), pad.left + pad.right)),
          height: Math.round(Math.max(num(minSize?.height, DEFAULT_GROUP_MIN.height), pad.top + pad.bottom)),
        };
      }

      // 1. 容器先递归(子作用域自成一块 = SEPARATE_CHILDREN)。
      const itemSize = new Map<string, BoardLayoutRect>();
      for (const id of itemIds) {
        const kids = childrenOf.get(id) ?? [];
        if (kids.length) itemSize.set(id, layoutScope(id, groupPad, inner, inner));
        else {
          const n = byId.get(id);
          itemSize.set(id, {
            width: num(n?.size?.width, DEFAULT_LEAF.width),
            height: num(n?.size?.height, DEFAULT_LEAF.height),
          });
        }
      }

      // 2. 本作用域参与分层的边(跨组连线提升到组;组内自环不参与分层)。
      const rankPairs: Array<{ id: string; from: string; to: string }> = [];
      for (const e of edges) {
        const a = ownerAtScope(e.sourceId, scopeId);
        const b = ownerAtScope(e.targetId, scopeId);
        if (!a || !b || a === b) continue;
        rankPairs.push({ id: e.id, from: a, to: b });
      }
      const back = findBackEdges(rankPairs);

      // 3. 最长路径分层(回边反转后视为 DAG)。
      const rank = new Map<string, number>();
      for (const id of itemIds) rank.set(id, 0);
      const dag = rankPairs.filter((e) => !back.has(e.id));
      for (let round = 0; round <= itemIds.length; round += 1) {
        let changed = false;
        for (const e of dag) {
          const next = (rank.get(e.from) ?? 0) + 1;
          if (next > (rank.get(e.to) ?? 0)) {
            rank.set(e.to, next);
            changed = true;
          }
        }
        if (!changed) break;
      }

      // 4. 分列 + 层内按前驱重心稳定排序。
      const maxRank = itemIds.reduce((m, id) => Math.max(m, rank.get(id) ?? 0), 0);
      const columns: Column[] = [];
      for (let r = 0; r <= maxRank; r += 1) {
        const items = itemIds.filter((id) => (rank.get(id) ?? 0) === r);
        if (items.length) columns.push({ items, rank: r });
      }
      const preds = new Map<string, string[]>();
      for (const e of rankPairs) {
        const arr = preds.get(e.to);
        if (arr) arr.push(e.from);
        else preds.set(e.to, [e.from]);
      }
      const orderInColumn = new Map<string, number>();
      const barycenter = (id: string): number => {
        const ps = preds.get(id) ?? [];
        if (!ps.length) return orderInColumn.get(id) ?? 0;
        return ps.reduce((s, p) => s + (orderInColumn.get(p) ?? 0), 0) / ps.length;
      };
      for (let pass = 0; pass < 2; pass += 1) {
        for (const col of columns) {
          col.items.sort(
            (a, b) => barycenter(a) - barycenter(b) || (orderInColumn.get(a) ?? 0) - (orderInColumn.get(b) ?? 0),
          );
          col.items.forEach((id, i) => orderInColumn.set(id, i));
        }
      }

      // 5. 过高的单列拆细(否则「一层里塞满所有组」会变成一根竖条,折行无从下手)。
      const split: Column[] = [];
      for (const col of columns) {
        const crossSum =
          col.items.reduce((s, id) => s + crossOf(itemSize.get(id)!), 0) + NODE_GAP * (col.items.length - 1);
        const biggest = col.items.reduce((m, id) => Math.max(m, crossOf(itemSize.get(id)!)), 1);
        const chunkCount = Math.max(1, Math.min(col.items.length, Math.ceil(crossSum / (biggest * 1.6))));
        if (chunkCount <= 1) {
          split.push(col);
          continue;
        }
        const per = Math.ceil(col.items.length / chunkCount);
        for (let i = 0; i < col.items.length; i += per) split.push({ items: col.items.slice(i, i + per), rank: col.rank });
      }

      // 6. 列尺寸 + 列间距(带 label 的边撑开标签尺寸)。
      const labelExtra = new Map<number, number>();
      for (const e of edges) {
        const a = ownerAtScope(e.sourceId, scopeId);
        const b = ownerAtScope(e.targetId, scopeId);
        if (!a || !b || a === b || !e.label) continue;
        const need = vertical ? num(e.label.height, 0) : num(e.label.width, 0);
        if (need <= 0) continue;
        const r = rank.get(a) ?? 0;
        labelExtra.set(r, Math.max(labelExtra.get(r) ?? 0, need));
      }
      const colMain = split.map((col) => col.items.reduce((m, id) => Math.max(m, mainOf(itemSize.get(id)!)), 0));
      const colCross = split.map(
        (col) => col.items.reduce((s, id) => s + crossOf(itemSize.get(id)!), 0) + NODE_GAP * (col.items.length - 1),
      );
      const gapAfter = split.map((col, i) => (i === split.length - 1 ? 0 : LAYER_GAP + (labelExtra.get(col.rank) ?? 0)));

      // 7. 折行:枚举 band 数,取宽高比最贴近目标(MULTI_EDGE wrapping 的语义)。
      let best = planBands(colMain, colCross, gapAfter, 1);
      let bestScore = Number.POSITIVE_INFINITY;
      for (let b = 1; b <= split.length; b += 1) {
        const plan = planBands(colMain, colCross, gapAfter, b);
        const mainLen = Math.max(...plan.main);
        const crossLen = plan.cross.reduce((s, v) => s + v, 0) + BAND_GAP * (b - 1);
        const w = vertical ? crossLen : mainLen;
        const h = vertical ? mainLen : crossLen;
        if (!(w > 0) || !(h > 0)) continue;
        const score = Math.abs(Math.log(w / h / selfAspect));
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = plan;
        }
      }

      // 8. 落坐标(相对本作用域原点,含 padding 偏移)。
      const mainStart = vertical ? pad.top : pad.left;
      const crossStart = vertical ? pad.left : pad.top;
      const bandCrossStart: number[] = [];
      let accCross = 0;
      for (let b = 0; b < best.bandCount; b += 1) {
        bandCrossStart.push(accCross);
        accCross += best.cross[b]! + (b < best.bandCount - 1 ? BAND_GAP : 0);
      }
      const mainCursor = new Array<number>(best.bandCount).fill(mainStart);
      split.forEach((col, i) => {
        const b = best.assign[i]!;
        let cCursor = 0;
        for (const id of col.items) {
          const sz = itemSize.get(id)!;
          const mainPos = mainCursor[b]!;
          const crossPos = crossStart + bandCrossStart[b]! + cCursor;
          positions[id] = vertical
            ? { x: Math.round(crossPos), y: Math.round(mainPos) }
            : { x: Math.round(mainPos), y: Math.round(crossPos) };
          sizes[id] = { width: Math.round(sz.width), height: Math.round(sz.height) };
          cCursor += crossOf(sz) + NODE_GAP;
        }
        mainCursor[b] = mainCursor[b]! + colMain[i]! + gapAfter[i]!;
      });

      const contentMain = Math.max(...best.main);
      const contentCross = best.cross.reduce((s, v) => s + v, 0) + BAND_GAP * (best.bandCount - 1);
      const outer = vertical
        ? { width: pad.left + contentCross + pad.right, height: pad.top + contentMain + pad.bottom }
        : { width: pad.left + contentMain + pad.right, height: pad.top + contentCross + pad.bottom };
      return {
        width: Math.max(Math.round(outer.width), Math.round(num(minSize?.width, 0))),
        height: Math.max(Math.round(outer.height), Math.round(num(minSize?.height, 0))),
      };
    };

    sizes[rootId] = layoutScope(rootId, rootPad, aspectRatio, innerAspect);
    return { positions, sizes };
  };

  // 全局目标:枚举内层折行目标,选整体宽高比最贴近 aspectRatio 的一版。
  const candidates = [...new Set([...INNER_ASPECT_CANDIDATES, aspectRatio])].sort((a, b) => a - b);
  let best: BoardLayoutResult | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const inner of candidates) {
    checkAbort(signal);
    const result = runOnce(inner);
    const root = result.sizes[rootId];
    const ratio = root && root.height > 0 ? root.width / root.height : 0;
    if (!(ratio > 0)) {
      if (!best) best = result;
      continue;
    }
    const score = Math.abs(Math.log(ratio / aspectRatio));
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = result;
    }
  }
  return best ?? runOnce(aspectRatio);
}
