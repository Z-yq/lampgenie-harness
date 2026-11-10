/**
 * 出图前过滤(board-filter.ts):写者裁剪 + group 折叠。
 * 纯函数测试,不落盘、不起 WS——造一块内存里的 BoardDoc 直接调 filterBoardDoc。
 */
import { describe, it, expect } from "vitest";
import type { BoardDoc } from "@lampgenie/protocol";
import { boardWriterOf, filterBoardDoc } from "../src/board-filter.js";

type Node = BoardDoc["nodes"][number];
type Edge = BoardDoc["edges"][number];

/** 造节点(只填过滤关心的字段;其余 schema 默认值不参与本模块逻辑)。 */
function n(id: string, extra: Partial<Node> = {}): Node {
  return { id, kind: "function", label: `L-${id}`, summary: `S-${id}`, change: "modify", done: false, comments: [], flow: [], ...extra } as Node;
}

/** 造边。 */
function e(from: string, to: string, kind: Edge["kind"] = "call", label?: string): Edge {
  return label === undefined ? ({ from, to, kind } as Edge) : ({ from, to, kind, label } as Edge);
}

/** 造板。 */
function doc(nodes: Node[], edges: Edge[] = []): BoardDoc {
  return {
    version: 1, taskId: "t1", sessionId: "s1", title: "过滤测试板", status: "draft", rev: 0,
    nodes, edges, planned_files: [], updatedAt: 0,
  } as BoardDoc;
}

describe("boardWriterOf 与面板 cvWriterOf 同口径", () => {
  it("取首个 - 前 1~7 位字母数字,首字符必须字母,ph 除外", () => {
    expect(boardWriterOf("a1-card")).toBe("a1");
    expect(boardWriterOf("pqa6e-r3a1")).toBe("pqa6e");
    expect(boardWriterOf("plainnode")).toBe("");
    expect(boardWriterOf("ph-understand")).toBe("");
    expect(boardWriterOf("1a-x")).toBe("");
    expect(boardWriterOf("-x")).toBe("");
    expect(boardWriterOf("abcdefgh-x")).toBe(""); // 前缀超 7 位
    expect(boardWriterOf("")).toBe("");
  });
});

describe("写者过滤", () => {
  it("三写者板只留 a1:节点/边数正确,悬空边被丢(dropped>0)", () => {
    const d = doc(
      [n("a1-x"), n("a1-y"), n("b2-p"), n("c3-q")],
      [e("a1-x", "a1-y"), e("a1-y", "b2-p"), e("b2-p", "c3-q")],
    );
    const r = filterBoardDoc(d, { writers: ["a1"] });
    expect(r.doc.nodes.map((x) => x.id)).toEqual(["a1-x", "a1-y"]);
    expect(r.doc.edges.map((x) => `${x.from}->${x.to}`)).toEqual(["a1-x->a1-y"]);
    // 丢 2 节点 + 2 悬空边
    expect(r.dropped).toBe(4);
    expect(r.folded).toBe(0);
    expect(r.doc).not.toBe(d);
  });

  it("writers 空数组或缺省 → 返回同一对象引用、计数全 0", () => {
    const d = doc([n("a1-x"), n("b2-y")], [e("a1-x", "b2-y")]);
    for (const opts of [undefined, {}, { writers: [] }]) {
      const r = filterBoardDoc(d, opts as never);
      expect(r.doc).toBe(d);
      expect(r.dropped).toBe(0);
      expect(r.folded).toBe(0);
    }
  });
});

describe("分组折叠", () => {
  /** 一组 6 节点(group 同名)+ 组外 2 节点。 */
  function grouped(): BoardDoc {
    const members = ["a1-1", "a1-2", "a1-3", "a1-4", "a1-5", "a1-6"].map((id) => n(id, { group: "01 采集" }));
    return doc([n("b2-out1"), ...members, n("b2-out2")], [
      e("a1-1", "a1-2"), // 组内互连 → 折叠后自环,丢弃
      e("a1-3", "b2-out1"), // 组内 → 组外
      e("b2-out1", "a1-4"), // 组外 → 组内
      e("b2-out1", "b2-out2"), // 组外 → 组外(原样保留)
    ]);
  }

  it("6 节点组默认阈值 5 → 1 个 fold-* 聚合节点,label 含 (6 个),原成员消失", () => {
    const r = filterBoardDoc(grouped(), { foldGroups: true });
    const ids = r.doc.nodes.map((x) => x.id);
    expect(ids).toContain("fold-01---"); // 组名里的空格/中文按规则转 "-"
    const fold = r.doc.nodes.find((x) => x.id.startsWith("fold-"))!;
    expect(fold.label).toBe("01 采集 (6 个)");
    expect(fold.kind).toBe("module");
    expect(fold.group).toBe("01 采集");
    expect(fold.change).toBe("keep");
    expect(fold.done).toBe(false);
    expect(fold.summary).toBe("折叠 6 个节点:L-a1-1、L-a1-2、L-a1-3、L-a1-4、L-a1-5、L-a1-6");
    expect(fold.comments).toEqual([]);
    expect(fold.flow).toEqual([]);
    expect(fold.targets).toEqual([]);
    expect(fold.accept).toEqual([]);
    // 原 6 个成员全部消失,组外节点与顺序不变
    for (const id of ["a1-1", "a1-2", "a1-3", "a1-4", "a1-5", "a1-6"]) expect(ids).not.toContain(id);
    expect(ids).toEqual(["b2-out1", "fold-01---", "b2-out2"]); // 聚合节点落在该组最靠前成员的位置
    expect(r.folded).toBe(6);
  });

  it("foldMin=6 时 6 节点组仍折叠;7 节点组超出阈值才折(边界)", () => {
    const six = grouped();
    expect(filterBoardDoc(six, { foldGroups: true, foldMin: 7 }).doc).toBe(six); // 不够大 → 原引用
    expect(filterBoardDoc(six, { foldGroups: true, foldMin: 6 }).folded).toBe(6);
  });

  it("折叠后边重映射:组内→组外变 fold-xxx -> B,组内互连不产生自环", () => {
    const r = filterBoardDoc(grouped(), { foldGroups: true });
    const fid = "fold-01---";
    const pairs = r.doc.edges.map((x) => `${x.from}->${x.to}`);
    expect(pairs).toContain(`${fid}->b2-out1`);
    expect(pairs).toContain(`b2-out1->${fid}`);
    expect(pairs).toContain("b2-out1->b2-out2");
    // 组内 A1->A2 折叠成 fold->fold 自环,必须丢
    expect(r.doc.edges.some((x) => x.from === x.to)).toBe(false);
    // 悬空边:没有以已删除成员 id 为端点的边
    const ids = new Set(r.doc.nodes.map((x) => x.id));
    for (const x of r.doc.edges) {
      expect(ids.has(x.from)).toBe(true);
      expect(ids.has(x.to)).toBe(true);
    }
  });

  it("重复边(重映射后 from/to/kind/label 相同)去重", () => {
    const members = ["a1-1", "a1-2", "a1-3", "a1-4", "a1-5"].map((id) => n(id, { group: "g" }));
    const d = doc([...members, n("b2-b")], [
      e("a1-1", "b2-b", "data", "同一条"), // 折叠后与下一条完全同形
      e("a1-2", "b2-b", "data", "同一条"),
      e("a1-3", "b2-b", "data", "另一条"), // label 不同 → 保留
    ]);
    const r = filterBoardDoc(d, { foldGroups: true });
    expect(r.doc.edges.length).toBe(2);
    expect(r.doc.edges.map((x) => `${x.from}->${x.to}:${x.label}`)).toEqual(["fold-g->b2-b:同一条", "fold-g->b2-b:另一条"]);
  });
});

describe("不可变性", () => {
  it("过滤+折叠后原 doc 的 nodes/edges 长度与内容不变", () => {
    const d = doc(
      [n("b2-out1"), n("a1-1", { group: "01 采集" }), n("a1-2", { group: "01 采集" }), n("a1-3", { group: "01 采集" }),
        n("a1-4", { group: "01 采集" }), n("a1-5", { group: "01 采集" }), n("c3-z")],
      [e("a1-1", "a1-2"), e("a1-5", "b2-out1"), e("b2-out1", "c3-z")],
    );
    const before = JSON.stringify(d);
    const nodeCount = d.nodes.length;
    const edgeCount = d.edges.length;
    filterBoardDoc(d, { writers: ["a1", "b2"] });
    filterBoardDoc(d, { foldGroups: true, foldMin: 5 });
    expect(d.nodes.length).toBe(nodeCount);
    expect(d.edges.length).toBe(edgeCount);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe("碎泳道合并(小分组 ≥ SMALL_GROUP_MERGE_AT 且预算够时合成一个 fold-small)", () => {
  /** 按真板实测分布造板:5 组×3 + 15 组×2 + 15 组×1 = 35 条泳道 / 60 节点(全部 < foldMin)。 */
  function realShape(): { d: BoardDoc; ids: string[] } {
    const nodes: Node[] = [];
    const ids: string[] = [];
    const push = (id: string, g: string) => { nodes.push(n(id, { group: g })); ids.push(id); };
    for (let g = 1; g <= 5; g++) for (let i = 1; i <= 3; i++) push(`a${g}-${i}`, `泳道${g}`);
    for (let g = 6; g <= 20; g++) for (let i = 1; i <= 2; i++) push(`b${g}-${i}`, `泳道${g}`);
    for (let g = 21; g <= 35; g++) push(`c${g}-1`, `泳道${g}`);
    return { d: doc(nodes), ids };
  }

  /** 12 条 1 节点小泳道(够合并门槛 12 组)+ 1 个组外节点 = 13 节点(< MIN_NODES_KEEP + 12)。 */
  function twelveSmall(): BoardDoc {
    const nodes: Node[] = [];
    for (let g = 1; g <= 12; g++) nodes.push(n(`a1-${g}`, { group: `小${g}` }));
    return doc([...nodes, n("b2-out")], [
      e("a1-1", "b2-out"), // 小组成员 → 组外
      e("b2-out", "a1-2"), // 组外 → 小组成员
      e("a1-3", "a1-4"), // 组内互连(若合并会变自环)
      e("a1-5", "b2-out"),
    ]);
  }

  it("真实形态(35 条泳道全 < foldMin)→ 吃 28 组 / 41 个,留 8 节点骨架(7 条泳道 + 1 聚合)", () => {
    const { d } = realShape();
    expect(d.nodes.length).toBe(60);
    const r = filterBoardDoc(d, { foldGroups: true, foldMin: 5 });
    const aggs = r.doc.nodes.filter((x) => x.id.startsWith("fold-"));
    expect(aggs.length).toBe(1);
    const agg = aggs[0];
    expect(agg.id).toBe("fold-small");
    expect(agg.label).toBe("其他分组 (28 组 / 41 个)");
    expect(agg.kind).toBe("module");
    expect(agg.change).toBe("keep");
    expect(agg.group).toBe("其他分组");
    expect(agg.done).toBe(false);
    expect(agg.comments).toEqual([]);
    expect(agg.flow).toEqual([]);
    expect(agg.targets).toEqual([]);
    expect(agg.accept).toEqual([]);
    expect(agg.summary.startsWith("合并 28 个小组:41 个节点:")).toBe(true);
    expect(agg.summary.endsWith(" 等")).toBe(true); // 前 6 个 label + 等
    // 骨架保留:budget = 60-8 = 52 → 吃掉 41 个后下一组(3 个)会超;剩 7 条泳道 + 1 聚合 = 20 节点骨架
    expect(r.doc.nodes.length).toBe(20);
    expect(r.doc.nodes.length).toBeGreaterThanOrEqual(8);
    const keptGroups = new Set(
      r.doc.nodes.filter((x) => x.id !== "fold-small").map((x) => String(x.group ?? "").trim()).filter(Boolean),
    );
    expect(keptGroups.size).toBe(7);
    expect(r.folded).toBe(41);
  });

  it("大组(≥foldMin)+ 碎组混合:5 个大组各折 1 个 + 1 个 fold-small,小组合并 21 组 / 28 个", () => {
    // 5 组×5 节点(>= foldMin,走既有大组折叠)+ 14 组×2 + 14 组×1(碎组,够 12 组才合并)
    const nodes: Node[] = [];
    for (let g = 1; g <= 5; g++) for (let i = 1; i <= 5; i++) nodes.push(n(`a${g}-${i}`, { group: `大${g}` }));
    for (let g = 6; g <= 19; g++) for (let i = 1; i <= 2; i++) nodes.push(n(`b${g}-${i}`, { group: `小${g}` }));
    for (let g = 20; g <= 33; g++) nodes.push(n(`c${g}-1`, { group: `小${g}` }));
    const r = filterBoardDoc(doc(nodes), { foldGroups: true, foldMin: 5 });
    const ids = r.doc.nodes.map((x) => x.id);
    expect(ids.filter((x) => x.startsWith("fold-")).length).toBe(6); // 5 个大组 + 1 个 fold-small
    expect(ids).toContain("fold-small");
    expect(r.doc.nodes.find((x) => x.id === "fold-small")!.label).toBe("其他分组 (21 组 / 28 个)");
    expect(r.doc.nodes.length).toBe(20); // 5 个 fold-大N + fold-small + 14 条保留碎组(骨架)
    expect(r.folded).toBe(25 + 28); // 两段都计入同一个 folded 计数
  });

  it("只有 11 个小组(不足 12 组门槛)→ 不合并,返回原 doc 引用,folded=0", () => {
    const nodes: Node[] = [];
    for (let g = 1; g <= 11; g++) nodes.push(n(`a1-${g}`, { group: `小${g}` }));
    const d = doc(nodes, [e("a1-1", "a1-2")]);
    const r = filterBoardDoc(d, { foldGroups: true, foldMin: 5 });
    expect(r.doc).toBe(d);
    expect(r.folded).toBe(0);
    expect(r.dropped).toBe(0);
  });

  it("小板预算不足(需吃 12 组但只能丢 5 节点)→ 不合并,原引用,elements 不变", () => {
    // 13 节点:budget = 13-8 = 5 < 12(每组 1 个),一组都吃不下 → small.size=0 < 12 → 不合并
    const d = twelveSmall();
    expect(d.nodes.length).toBe(13);
    const r = filterBoardDoc(d, { foldGroups: true, foldMin: 5 });
    if (r.doc === d) {
      expect(r.doc).toBe(d);
    } else {
      expect(JSON.parse(JSON.stringify(r.doc))).toEqual(JSON.parse(JSON.stringify(d)));
      expect(r.doc.nodes.map((x) => x.id)).toEqual(d.nodes.map((x) => x.id));
    }
    expect(r.doc.nodes.some((x) => x.id.startsWith("fold-"))).toBe(false);
    expect(r.folded).toBe(0);
    expect(r.dropped).toBe(0);
    expect(r.doc.edges.map((x) => `${x.from}->${x.to}`)).toEqual([
      "a1-1->b2-out",
      "b2-out->a1-2",
      "a1-3->a1-4",
      "a1-5->b2-out",
    ]);
  });

  it("合并后边重映射(预算够的形态:20 组×1 + 3 组外 = 23 节点)→ 喂 13 组,跨组边指向 fold-small,自环丢弃、重复边去重", () => {
    const nodes: Node[] = [n("b2-out1"), n("b2-out2"), n("b2-out3")];
    for (let g = 1; g <= 20; g++) nodes.push(n(`a1-${g}`, { group: `小${String(g).padStart(2, "0")}` }));
    const d = doc(nodes, [
      e("a1-1", "b2-out1", "call", "出"), // 小组成员 → 组外
      e("b2-out2", "a1-2", "call", "入"), // 组外 → 小组成员
      e("a1-3", "a1-4", "call", "内"), // 组内互连 → 合并后自环,丢
      e("a1-5", "b2-out1", "call", "出"), // 与第一条重映射后同形,去重
      e("b2-out1", "b2-out2", "call", "外"), // 组外互连保留
    ]);
    const r = filterBoardDoc(d, { foldGroups: true, foldMin: 5 });
    // budget = 23-8 = 15,need = max(12, 20+1-8) = 13 → 吃掉 13 组(同大小按组名字典序),留 7 条泳道归骨架
    expect(r.folded).toBe(13);
    expect(r.doc.nodes.find((x) => x.id === "fold-small")!.label).toBe("其他分组 (13 组 / 13 个)");
    expect(r.doc.edges.map((x) => `${x.from}->${x.to}`)).toEqual([
      "fold-small->b2-out1",
      "b2-out2->fold-small",
      "b2-out1->b2-out2",
    ]);
    expect(r.doc.edges.some((x) => x.from === x.to)).toBe(false);
    const ids = new Set(r.doc.nodes.map((x) => x.id));
    for (const x of r.doc.edges) {
      expect(ids.has(x.from)).toBe(true);
      expect(ids.has(x.to)).toBe(true);
    }
    // 聚合节点插在最靠前被合并成员的位置(这里组外节点都在最前 → 排它们之后)
    expect(r.doc.nodes.map((x) => x.id).slice(0, 4)).toEqual(["b2-out1", "b2-out2", "b2-out3", "fold-small"]);
  });

  it("大组 + 碎组同板:大组折成 fold-<slug>,碎组因预算不足不合并(无 fold-small)", () => {
    // 6 个「01 采集」+ 12 个 1 节点碎组 = 18 节点;budget = 18-8 = 10 < 12 → 只折大组
    const nodes: Node[] = [];
    for (let i = 1; i <= 6; i++) nodes.push(n(`a1-${i}`, { group: "01 采集" }));
    for (let g = 1; g <= 12; g++) nodes.push(n(`b2-${g}`, { group: `碎${g}` }));
    const d = doc(nodes, [e("a1-6", "b2-3"), e("b2-4", "a1-1")]);
    const r = filterBoardDoc(d, { foldGroups: true });
    const big = "fold-01---"; // groupSlug("01 采集") = "01---"
    const ids = r.doc.nodes.map((x) => x.id);
    expect(ids).toContain(big);
    expect(ids).not.toContain("fold-small");
    expect(r.doc.nodes.find((x) => x.id === big)!.label).toBe("01 采集 (6 个)");
    expect(r.doc.nodes.length).toBe(13); // 1 个聚合 + 12 条碎组骨架
    expect(r.folded).toBe(6);
    expect(r.doc.edges.map((x) => `${x.from}->${x.to}`)).toEqual([`${big}->b2-3`, `b2-4->${big}`]);
  });
});