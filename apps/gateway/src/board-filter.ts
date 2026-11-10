/**
 * 白板出图前的「视图态」过滤(纯函数,无 IO):按写者前缀裁剪 + 按 group 折叠。
 * 为什么服务端做:大板(60 节点)一张 SVG 里 fitK 只有 0.147——字全部糊掉。把「只看某个写者」
 * 与「把大分组收成一个聚合节点」放到出图前,原始 BoardDoc **一律不动**(板数据是设计真相,
 * 过滤只是这次出图的视图态,和面板 cvWriterOf 那套前端过滤同口径)。
 * 本模块只做数据变换,失败/异常都不抛:入参不合法就当「没过滤」原样返回。
 */

import type { BoardDoc } from "@lampgenie/protocol";

/** 板节点/边类型从 BoardDoc 推导,避免再引第二个 protocol 类型源。 */
type BoardNode = BoardDoc["nodes"][number];
type BoardEdge = BoardDoc["edges"][number];

export interface BoardFilterOpts {
  /** 只保留这些写者前缀的节点(空数组/缺省=不按写者过滤)。 */
  writers?: string[];
  /** true 时按 group 折叠大分组。 */
  foldGroups?: boolean;
  /** 折叠阈值:组内节点数 >= 该值才折叠;缺省 5。 */
  foldMin?: number;
}

export interface BoardFilterResult {
  doc: BoardDoc;
  /** 被丢掉的节点数 + 被丢掉的边数。 */
  dropped: number;
  /** 被折叠(收进聚合节点)的节点数。 */
  folded: number;
}

const DEFAULT_FOLD_MIN = 5;
/** 聚合节点 summary 里列几个成员 label(超出补「 等」)。 */
const SUMMARY_SAMPLE = 6;

/**
 * 碎泳道合并阈值:折叠大组之后,剩余「小分组」(组非空且组内节点数 < foldMin)**组数** >= 该值
 * 才把这些小组的成员合并成一个聚合节点。
 * 为什么 >= 12:>12 条泳道 = 碎泳道(与 cards 模式历史口径「一板多任务碎泳道」一致);
 * 低于此不合并,避免把 11 泳道的小板过度压扁。经验证 60 节点真板 35 条泳道全是 1~3 节点的小组,
 * 按「组内 >= foldMin 才折」一条都折不动(folded=0),必须走这条兜底。
 */
const SMALL_GROUP_MERGE_AT = 12;
/** 碎泳道聚合节点固定 id(与 `fold-<slug>` 不撞车)与固定 group 名。 */
const SMALL_FOLD_ID = "fold-small";
const SMALL_GROUP_NAME = "其他分组";

/**
 * 碎泳道合并的两个目标上限(经验证口径,别凭感觉调):
 * 为什么要有上限:经验证 60 节点真板 35 条泳道全是 < foldMin 的碎组,无条件「全合并」会把整板
 * 压成 1 个节点、0 条边(viewBox 7261×2942 → 468×284)——那张图只说明「有 60 个节点」,
 * 结构信息全丢,对大板可读性是负收益。出图目标是「看得清结构」,不是「节点数为 1」。
 * 合并策略:按组大小升序逐个并入一个 fold-small 聚合节点,**直到任一上限达成即停**:
 *   · 剩余分组数 <= MAX_GROUPS_KEEP(8):一屏能放下的泳道数上限;
 *   · 剩余节点数 <= MIN_NODES_KEEP(8):一屏兜底可见的主干卡张数上限(与 cards 模式
 * compact 布局「一屏约 7~8 张主干卡」的经验证上界一致)。
 * 两个上限同时存在是因为泳道数决定纵向高度、节点数决定整体面积,只压一个维度仍会出糊图。
 */
const MAX_GROUPS_KEEP = 8;
const MIN_NODES_KEEP = 8;

/**
 * w1 写者前缀:id 形如 a1-card / pqa6e-r3a1 → 取首个 "-" 前 1~7 位字母数字(首字符必须是字母);
 * 不符(如 plainnode、ph-understand)→ 返回空串(算「其他」)。ph-* 是阶段卡,不是写者。
 * ⚠️ 本函数与面板 apps/gateway/src/panel.ts 的 cvWriterOf **逐字同口径**:
 *   **改一处必须改两处**(服务端出图与面板画布必须认同一个写者集合,否则「过滤后看到的」与
 *   「面板上看到的」不一致)。改这里时同步改 panel.ts:cvWriterOf,反之亦然。
 */
export function boardWriterOf(id: string): string {
  const s = String(id || "");
  const k = s.indexOf("-");
  if (k <= 0 || k > 7) return "";
  const head = s.slice(0, k);
  const isAlpha = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");
  const isAlnum = (c: string): boolean => isAlpha(c) || (c >= "0" && c <= "9");
  if (!isAlpha(head.charAt(0))) return "";
  for (let i = 1; i < head.length; i++) if (!isAlnum(head.charAt(i))) return "";
  if (head === "ph") return ""; // 阶段卡(00 流程泳道)不是写者,不算任何写者
  return head;
}

/** foldMin 归一:非法/过小走缺省 5(协议已限 2~60,这里再兜一层防直接调用)。 */
function normFoldMin(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_FOLD_MIN;
  const n = Math.floor(v);
  return n >= 2 ? n : DEFAULT_FOLD_MIN;
}

/** 组名 → ascii 安全 slug(非 [A-Za-z0-9_] 全转 "-");全转没了返回空串由调用方兜底。 */
function groupSlug(name: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) ? ch : "-";
  return out;
}

/** 折叠出的聚合节点(字段按任务契约固定;comments/flow/targets/accept 显式空数组防继承)。 */
function foldNode(groupName: string, members: BoardNode[], id: string): BoardNode {
  const labels = members.map((n) => String(n.label ?? ""));
  const sample = labels.slice(0, SUMMARY_SAMPLE).join("、");
  const summary = `折叠 ${members.length} 个节点:${sample}${labels.length > SUMMARY_SAMPLE ? " 等" : ""}`;
  // summary 上限 500 字:极端 label 长度下截断(宁可少列一个也不要出图时被 schema 拒)。
  const cut = summary.length > 500 ? summary.slice(0, 499) + "…" : summary;
  return {
    id,
    kind: "module",
    label: `${groupName} (${members.length} 个)`,
    summary: cut,
    group: groupName,
    change: "keep",
    done: false,
    comments: [],
    flow: [],
    targets: [],
    accept: [],
  } as BoardNode;
}

/**
 * 碎泳道聚合节点:把 G 个小组(N 个成员)合成一个 node(字段按任务契约固定)。
 * label 形如 `其他分组 (28 组 / 42 个)`;summary 形如 `合并 28 个小组:42 个节点:a、b、c 等`。
 */
function smallFoldNode(groupCount: number, members: BoardNode[]): BoardNode {
  const labels = members.map((n) => String(n.label ?? ""));
  const sample = labels.slice(0, SUMMARY_SAMPLE).join("、");
  const summary = `合并 ${groupCount} 个小组:${members.length} 个节点:${sample}${labels.length > SUMMARY_SAMPLE ? " 等" : ""}`;
  const cut = summary.length > 500 ? summary.slice(0, 499) + "…" : summary;
  return {
    id: SMALL_FOLD_ID,
    kind: "module",
    label: `${SMALL_GROUP_NAME} (${groupCount} 组 / ${members.length} 个)`,
    summary: cut,
    group: SMALL_GROUP_NAME,
    change: "keep",
    done: false,
    comments: [],
    flow: [],
    targets: [],
    accept: [],
  } as BoardNode;
}

/**
 * 出图前过滤:写者裁剪 → 分组折叠。不改入参(只可能新建数组/新对象)。
 * 无 opts / opts 全空 / 空板 / 实际上什么都没变 → 返回**同一个 doc 引用**,dropped=folded=0
 * (调用方据此可以零成本短路,也保证既有缓存与既有测试口径不变)。
 */
export function filterBoardDoc(doc: BoardDoc, opts?: BoardFilterOpts): BoardFilterResult {
  const noop: BoardFilterResult = { doc, dropped: 0, folded: 0 };
  if (!doc || !Array.isArray(doc.nodes) || doc.nodes.length === 0) return noop;

  const writers = Array.isArray(opts?.writers) ? opts!.writers!.filter((w) => typeof w === "string") : [];
  const foldGroups = opts?.foldGroups === true;
  const foldMin = normFoldMin(opts?.foldMin);
  if (writers.length === 0 && !foldGroups) return noop;

  const srcEdges: BoardEdge[] = Array.isArray(doc.edges) ? doc.edges : [];
  let nodes: BoardNode[] = doc.nodes;
  let edges: BoardEdge[] = srcEdges;
  let dropped = 0;

  // ---- 1) 写者过滤:节点按前缀留,边只留两端都在的(悬空边丢弃并计数)----
  if (writers.length > 0) {
    const want = new Set(writers);
    nodes = doc.nodes.filter((n) => want.has(boardWriterOf(n.id)));
    const kept = new Set(nodes.map((n) => n.id));
    edges = srcEdges.filter((e) => kept.has(e.from) && kept.has(e.to));
    dropped = doc.nodes.length - nodes.length + (srcEdges.length - edges.length);
  }

  // ---- 2) 分组折叠:组内 >= foldMin 的收成一个聚合节点 ----
  let folded = 0;
  /** 被「大组折叠」整组吃掉的组名(第 4 步碎泳道合并时要跳过它们的聚合节点,防止互相吞并)。 */
  const bigFoldedGroups = new Set<string>();
  if (foldGroups) {
    const byGroup = new Map<string, BoardNode[]>();
    for (const n of nodes) {
      const g = typeof n.group === "string" ? n.group.trim() : "";
      if (!g) continue;
      const arr = byGroup.get(g);
      if (arr) arr.push(n);
      else byGroup.set(g, [n]);
    }
    const foldable = new Map<string, { members: BoardNode[]; id: string; node: BoardNode }>();
    let idx = 0;
    for (const [g, members] of byGroup) {
      if (members.length < foldMin) continue;
      const slug = groupSlug(g);
      const id = `fold-${slug || `g${idx}`}`;
      foldable.set(g, { members, id, node: foldNode(g, members, id) });
      bigFoldedGroups.add(g);
      idx++;
    }

    if (foldable.size > 0) {
      // 聚合节点插在该组最靠前成员的原位置;组内其余成员移除。
      const idMap = new Map<string, string>(); // 原节点 id -> 新 id(折叠成员重映射到聚合 id)
      const nextNodes: BoardNode[] = [];
      const placed = new Set<string>();
      for (const n of nodes) {
        const g = typeof n.group === "string" ? n.group.trim() : "";
        const f = g ? foldable.get(g) : undefined;
        if (!f) { nextNodes.push(n); continue; }
        idMap.set(n.id, f.id);
        if (placed.has(g)) continue;
        placed.add(g);
        nextNodes.push(f.node);
        folded += f.members.length;
      }
      nodes = nextNodes;

      // ---- 3) 边重映射:端点换成新 id;自环/悬空/重复(from,to,kind,label)丢弃 ----
      const live = new Set(nodes.map((n) => n.id));
      const seen = new Set<string>();
      const nextEdges: BoardEdge[] = [];
      for (const e of edges) {
        const from = idMap.get(e.from) ?? e.from;
        const to = idMap.get(e.to) ?? e.to;
        if (from === to) continue;
        if (!live.has(from) || !live.has(to)) continue;
        const key = `${from}\u0000${to}\u0000${e.kind}\u0000${e.label ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nextEdges.push(from === e.from && to === e.to ? e : { ...e, from, to });
      }
      edges = nextEdges;
    }

    // ---- 4) 碎泳道合并(在大组折叠之后算):剩下的小分组(组非空且组内 < foldMin)组数 ≥ 12
    //         时,把这些小组的成员合并成一个 fold-small 聚合节点。
    //         但受 MIN_NODES_KEEP 骨架下限约束:按组大小升序吃,吃到剩余节点数 <= 下限即停
    //         (否则 60 节点真板会被压成 1 个节点、0 条边,结构信息全丢——见常量注释)。----
    const smallGroups = new Map<string, BoardNode[]>();
    for (const n of nodes) {
      const g = typeof n.group === "string" ? n.group.trim() : "";
      if (!g || bigFoldedGroups.has(g)) continue; // 空 group 不参与;已被大组折叠吃掉的组跳过
      const arr = smallGroups.get(g);
      if (arr) arr.push(n);
      else smallGroups.set(g, [n]);
    }
    const smallCand: Array<[string, BoardNode[]]> = [];
    for (const [g, members] of smallGroups) if (members.length < foldMin) smallCand.push([g, members]);
    // 升序:先吃掉最小的组,大一点的组尽量留成骨架(同大小按组名字典序,结果可复现)。
    smallCand.sort((a, b) => (a[1].length - b[1].length) || (a[0] < b[0] ? -1 : 1));

    if (smallCand.length >= SMALL_GROUP_MERGE_AT) {
      // 骨架下限/泳道上限:两条独立约束求一个「该吃多少组」的目标
      //   need = max(SMALL_GROUP_MERGE_AT, C + 1 - MAX_GROUPS_KEEP)
      //   · C+1-MAX_GROUPS_KEEP = 吃完后剩 (C-need) 个组 + 1 个聚合节点 <= MAX_GROUPS_KEEP 条泳道
      //   · 同时不低于「至少合并 SMALL_GROUP_MERGE_AT 个组」的合并门槛(12 组小板的语义不变)
      const budget = Math.max(0, nodes.length - MIN_NODES_KEEP);
      const need = Math.max(SMALL_GROUP_MERGE_AT, smallCand.length + 1 - MAX_GROUPS_KEEP);
      const small = new Map<string, BoardNode[]>();
      let eat = 0;
      for (const [g, members] of smallCand) {
        if (small.size >= need) break; // 泳道数已经够少了,剩下的组留成骨架
        if (eat + members.length > budget) break; // 再吃就破骨架节点下限
        small.set(g, members);
        eat += members.length;
      }
      if (small.size >= SMALL_GROUP_MERGE_AT) {
        // 成员按原 nodes 顺序收集(决定聚合节点插入位置与 summary 取样顺序)。
        const members: BoardNode[] = [];
        for (const n of nodes) {
          const g = typeof n.group === "string" ? n.group.trim() : "";
          if (g && small.has(g)) members.push(n);
        }
        const agg = smallFoldNode(small.size, members);
        const idMap = new Map<string, string>();
        for (const m of members) idMap.set(m.id, SMALL_FOLD_ID);

        const nextNodes: BoardNode[] = [];
        let placedSmall = false;
        for (const n of nodes) {
          if (idMap.has(n.id)) {
            if (!placedSmall) { placedSmall = true; nextNodes.push(agg); }
            continue;
          }
          nextNodes.push(n);
        }
        nodes = nextNodes;

        const live = new Set(nodes.map((n) => n.id));
        const seen = new Set<string>();
        const nextEdges: BoardEdge[] = [];
        for (const e of edges) {
          const from = idMap.get(e.from) ?? e.from;
          const to = idMap.get(e.to) ?? e.to;
          if (from === to) continue;
          if (!live.has(from) || !live.has(to)) continue;
          const key = `${from}\u0000${to}\u0000${e.kind}\u0000${e.label ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          nextEdges.push(from === e.from && to === e.to ? e : { ...e, from, to });
        }
        edges = nextEdges;
        folded += members.length;
      }
    }
  }

  // 什么都没变(例如 writers 覆盖全板、没有够大的组)→ 原引用短路。
  if (dropped === 0 && folded === 0) return noop;

  return { doc: { ...doc, nodes, edges }, dropped, folded };
}