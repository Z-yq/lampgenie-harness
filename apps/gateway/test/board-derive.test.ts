/**
 * 白板「关系自动推导引擎」(board-derive.ts)单测。
 * 每条断言锚一条规则的可证事实:R0 显式边原样优先 / R2 同组次序 nav /
 * R3 符号调用仅在 resolver 给答案时连边 / R4 验收子串命中 verify /
 * R5 自环与板外 id 不入推导 / 上限 120 且按 R0>R3>R4>R2 截断。
 */
import { describe, it, expect } from "vitest";
import { deriveBoardEdges } from "../src/board-derive.js";
import type { DerivedEdge } from "../src/board-derive.js";

type Node = Parameters<typeof deriveBoardEdges>[0][number];
type Explicit = Parameters<typeof deriveBoardEdges>[1][number];

const pairSet = (edges: DerivedEdge[]) => edges.map((e) => `${e.from}|${e.to}`);
const hasPair = (edges: DerivedEdge[], from: string, to: string) =>
  edges.some((e) => e.from === from && e.to === to);

describe("deriveBoardEdges:R0 显式边", () => {
  it("显式边原样保留在最前,且推导不为同一 from→to 再补边", () => {
    // A、B 同组相邻(R2 本会补 A→B nav),但显式已有 A→B data 边 → 只留显式那条
    const nodes: Node[] = [
      { id: "A", label: "采集", group: "01 采集" },
      { id: "B", label: "清洗", group: "01 采集" },
    ];
    const explicit: Explicit[] = [{ from: "A", to: "B", kind: "data", label: "写入" }];
    const edges = deriveBoardEdges(nodes, explicit);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ from: "A", to: "B", kind: "data", label: "写入" });
    // 不改 kind/label、不补 virtual
    expect(edges[0]!.kind).toBe("data");
    expect(edges[0]!.label).toBe("写入");
    expect(edges[0]!.virtual).toBeUndefined();
    expect(pairSet(edges)).toEqual(["A|B"]);
  });

  it("显式边排在最前(即使后面还有可推导边),缺省 kind 按协议记 call", () => {
    const nodes: Node[] = [
      { id: "A", group: "G" },
      { id: "B", group: "G" },
      { id: "C", group: "G" },
    ];
    const explicit: Explicit[] = [{ from: "C", to: "A", label: "回边" }];
    const edges = deriveBoardEdges(nodes, explicit);

    expect(edges[0]).toEqual({ from: "C", to: "A", kind: "call", label: "回边" });
    // 同组 G 的相邻对:A→B、B→C 照推;C→A 已被显式边占用,不重复
    expect(edges.slice(1).map((e) => `${e.from}|${e.to}|${e.kind}|${e.virtual}`)).toEqual(["A|B|nav|true", "B|C|nav|true"]);
  });
});

describe("deriveBoardEdges:R2 同组次序", () => {
  it("同组相邻两节点补 nav(声明序),跨组与无组不连", () => {
    const nodes: Node[] = [
      { id: "a1", group: "01 采集" },
      { id: "a2", group: "01 采集" },
      { id: "a3", group: "01 采集" },
      { id: "b1", group: "02 处理" },
      { id: "b2", group: "02 处理" },
      { id: "loose" }, // 无组=不参与次序推导
    ];
    const edges = deriveBoardEdges(nodes, []);

    expect(pairSet(edges)).toEqual(["a1|a2", "a2|a3", "b1|b2"]);
    for (const e of edges) {
      expect(e.kind).toBe("nav");
      expect(e.label).toBe("同组次序");
      expect(e.virtual).toBe(true);
    }
    // 跨组/跨组尾首、无组节点都不连
    expect(hasPair(edges, "a3", "b1")).toBe(false);
    expect(hasPair(edges, "b2", "loose")).toBe(false);
    expect(hasPair(edges, "a1", "a3")).toBe(false);
  });
});

describe("deriveBoardEdges:R3 符号调用", () => {
  it("calleesOf(sA) 含 sB → A→B call 边,标 virtual 并带 sA→sB 标签", () => {
    const nodes: Node[] = [
      { id: "api", targets: ["apps/gateway/src/routes.ts#handleBoardDerive"] },
      { id: "engine", targets: ["apps/gateway/src/board-derive.ts#deriveBoardEdges"] },
      { id: "other", targets: ["apps/gateway/src/panel.ts#renderPanel"] },
    ];
    const calls: Record<string, string[]> = {
      "apps/gateway/src/routes.ts#handleBoardDerive": ["apps/gateway/src/board-derive.ts#deriveBoardEdges"],
    };
    const edges = deriveBoardEdges(nodes, [], {
      calleesOf: (s) => (s in calls ? calls[s]! : null),
    });

    const call = edges.filter((e) => e.kind === "call");
    expect(call).toHaveLength(1);
    expect(call[0]).toEqual({
      from: "api",
      to: "engine",
      kind: "call",
      label: "apps/gateway/src/routes.ts#handleBoardDerive→apps/gateway/src/board-derive.ts#deriveBoardEdges",
      virtual: true,
    });
    expect(hasPair(edges, "api", "other")).toBe(false);
  });

  it.each([
    ["返回 null", (): string[] | null => null],
    ["返回空数组", (): string[] | null => []],
    ["抛错", (): string[] | null => { throw new Error("index 不可用"); }],
  ])("resolver %s → 不造 call 边(不猜)", (_name, impl) => {
    const nodes: Node[] = [
      { id: "A", targets: ["src/a.ts#fa"] },
      { id: "B", targets: ["src/b.ts#fb"] },
    ];
    const edges = deriveBoardEdges(nodes, [], { calleesOf: impl as () => string[] | null });
    expect(edges.filter((e) => e.kind === "call")).toEqual([]);
    expect(hasPair(edges, "A", "B")).toBe(false);
  });

  it("未提供 ctx(无 resolver)→ 整条 R3 不产生边", () => {
    const nodes: Node[] = [
      { id: "A", targets: ["src/a.ts#fa"] },
      { id: "B", targets: ["src/b.ts#fb"] },
    ];
    expect(deriveBoardEdges(nodes, [])).toEqual([]);
    expect(deriveBoardEdges(nodes, [], {})).toEqual([]);
  });
});

describe("deriveBoardEdges:R4 验收关系", () => {
  it("accept.cmd 文本含 B 的 targets 条目(≥6 字符)→ verify 边;短条目与自证跳过", () => {
    const nodes: Node[] = [
      { id: "gate", phase: "P0", accept: [{ cmd: "cd apps/gateway && npx vitest run test/board-derive.test.ts" }] },
      { id: "engine", targets: ["test/board-derive.test.ts"] },
      { id: "noisy", targets: ["index.ts"] }, // 短条目(<6 字符)不参与,避免噪音
    ];
    const edges = deriveBoardEdges(nodes, []);

    expect(pairSet(edges)).toEqual(["gate|engine"]);
    expect(edges[0]).toEqual({ from: "gate", to: "engine", kind: "verify", label: "验收 engine 的产物", virtual: true });
    expect(hasPair(edges, "gate", "noisy")).toBe(false);
    // 自证(accept 文本含自己的 targets)不自连
    const self: Node[] = [{ id: "solo", accept: [{ cmd: "npx vitest run test/solo.test.ts" }], targets: ["test/solo.test.ts"] }];
    expect(deriveBoardEdges(self, [])).toEqual([]);
  });

  it("同一 target 被两个节点引用(共享路径不唯一)→ 不造 verify 边", () => {
 // 经验证病灶:apps/gateway/src/panel.ts 这类文件被多个节点共同改,任何 accept 命中它都会连出一串跨组假边
    const shared = "apps/gateway/src/panel.ts";
    const nodes: Node[] = [
      { id: "gate", accept: [{ cmd: "npx vitest run " + shared }] },
      { id: "b1-card", targets: [shared] },
      { id: "b2-density", targets: [shared] },
    ];
    const edges = deriveBoardEdges(nodes, []);

    expect(edges.filter((e) => e.kind === "verify")).toEqual([]);
    expect(hasPair(edges, "gate", "b1-card")).toBe(false);
    expect(hasPair(edges, "gate", "b2-density")).toBe(false);
    // 唯一引用(只被 1 个节点引用)仍照旧成边——去假边不误伤真边
    const uniq = deriveBoardEdges(
      [
        { id: "gate", accept: [{ cmd: "npx vitest run test/only-one.test.ts" }] },
        { id: "b1-card", targets: ["test/only-one.test.ts"] },
        { id: "b2-density", targets: ["test/other-thing.test.ts"] },
      ],
      [],
    );
    expect(pairSet(uniq)).toEqual(["gate|b1-card"]);
  });

  it("同一 A 同时命中两个不同组 B → 只保留同组(同 id 前缀)那条;前缀都不同则全不生成", () => {
    // A(a1-blind) 的同一段 cmd 命中 a1-card 与 c1-card 两个不同组的产物
    const t1 = "apps/gateway/src/board-derive.ts:140";
    const t2 = "apps/gateway/src/board-layout.ts:300";
    const nodes: Node[] = [
      { id: "a1-blind", accept: [{ cmd: "npx vitest run " + t1 + " " + t2 }] },
      { id: "a1-card", targets: [t1] },
      { id: "c1-card", targets: [t2] },
    ];
    const edges = deriveBoardEdges(nodes, []);

    expect(pairSet(edges)).toEqual(["a1-blind|a1-card"]);
    expect(edges[0]).toEqual({ from: "a1-blind", to: "a1-card", kind: "verify", label: "验收 a1-card 的产物", virtual: true });
    expect(hasPair(edges, "a1-blind", "c1-card")).toBe(false);

    // 前缀一个都对不上(跨 3 组)→ 这批边全部不生成(宁缺不猜)
    const crossed = deriveBoardEdges(
      [
        { id: "x9-blind", accept: [{ cmd: "npx vitest run " + t1 + " " + t2 }] },
        { id: "a1-card", targets: [t1] },
        { id: "c1-card", targets: [t2] },
      ],
      [],
    );
    expect(crossed.filter((e) => e.kind === "verify")).toEqual([]);
  });
});

describe("deriveBoardEdges:R5 自环与板外 id", () => {
  it("自环不入推导;板外 id 不出现在任何推导边里(显式边按 R0 原样保留)", () => {
    const nodes: Node[] = [
      { id: "A", group: "G", targets: ["src/a.ts#fa"] },
      { id: "A", group: "G" }, // 重复 id 相邻 → 本会形成 A→A,须被跳过
      { id: "B", group: "G", targets: ["src/b.ts#fb"] },
    ];
    const explicit: Explicit[] = [
      { from: "ghost", to: "A", kind: "call", label: "板外节点" },
      { from: "A", to: "A", kind: "nav", label: "显式自环" },
    ];
    const edges = deriveBoardEdges(nodes, explicit, { calleesOf: (s) => (s === "src/a.ts#fa" ? ["src/b.ts#fb"] : null) });
    const ids = new Set(["A", "B"]);

    // 显式边如实保留(R0:是事实,不改不删)
    expect(edges.slice(0, 2)).toEqual([
      { from: "ghost", to: "A", kind: "call", label: "板外节点" },
      { from: "A", to: "A", kind: "nav", label: "显式自环" },
    ]);
    // 推导边(带 virtual)只引用板上真实节点,且不含自环
    const derived = edges.filter((e) => e.virtual === true);
    expect(derived.length).toBeGreaterThan(0);
    for (const e of derived) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
    // 同一 from→to 不重复
    expect(new Set(pairSet(edges)).size).toBe(edges.length);
  });
});

describe("deriveBoardEdges:上限与截断优先级", () => {
  it("总数 ≤ 120,超出按 R0 > R3 > R4 > R2 截断(R2 先出局)", () => {
    const helpers: Node[] = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}` }));
    const callNodes: Node[] = [
      { id: "caller", targets: ["src/x.ts#fx"] },
      { id: "callee", targets: ["src/y.ts#fy"] },
    ];
    const verifyNodes: Node[] = [
      { id: "checker", accept: [{ cmd: "npx vitest run test/verify-target.test.ts" }] },
      { id: "artifact", targets: ["test/verify-target.test.ts"] },
    ];
    const navNodes: Node[] = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, group: "G" }));
    const nodes = [...helpers, ...callNodes, ...verifyNodes, ...navNodes];

    // 118 条显式边(helper 之间的不同有序对)
    const explicit: Explicit[] = [];
    for (let i = 0; i < 20 && explicit.length < 118; i++) {
      for (let j = 0; j < 20 && explicit.length < 118; j++) {
        if (i !== j) explicit.push({ from: `h${i}`, to: `h${j}`, kind: "data", label: `e${explicit.length}` });
      }
    }
    expect(explicit).toHaveLength(118);

    const edges = deriveBoardEdges(nodes, explicit, { calleesOf: (s) => (s === "src/x.ts#fx" ? ["src/y.ts#fy"] : null) });

    expect(edges.length).toBe(120);
    expect(edges.slice(0, 118)).toEqual(explicit.map((e) => ({ from: e.from, to: e.to, kind: "data", label: e.label })));
    expect(hasPair(edges, "caller", "callee")).toBe(true); // R3 优先于 R4/R2
    expect(hasPair(edges, "checker", "artifact")).toBe(true); // R4 优先于 R2
    expect(edges.filter((e) => e.kind === "nav")).toEqual([]); // R2 被截断
  });

  it("单规则超量(130 节点同组 → 129 条候选 nav)仍截到 120", () => {
    const nodes: Node[] = Array.from({ length: 130 }, (_, i) => ({ id: `n${i}`, group: "G" }));
    const edges = deriveBoardEdges(nodes, []);
    expect(edges).toHaveLength(120);
    expect(edges.every((e) => e.kind === "nav" && e.virtual === true)).toBe(true);
    expect(new Set(pairSet(edges)).size).toBe(120);
  });
});

describe("deriveBoardEdges:纯函数", () => {
  it("不改入参、多次调用结果稳定", () => {
    const nodes: Node[] = [
      { id: "A", group: "G", targets: ["src/a.ts#fa"] },
      { id: "B", group: "G", targets: ["src/b.ts#fb"], accept: [{ cmd: "npx vitest run src/a.ts#fa" }] },
    ];
    const explicit: Explicit[] = [{ from: "B", to: "A", kind: "verify", label: "已有" }];
    const snapshot = JSON.stringify({ nodes, explicit });
    const first = deriveBoardEdges(nodes, explicit, { calleesOf: (s) => (s === "src/a.ts#fa" ? ["src/b.ts#fb"] : null) });
    const second = deriveBoardEdges(nodes, explicit, { calleesOf: (s) => (s === "src/a.ts#fa" ? ["src/b.ts#fb"] : null) });

    expect(JSON.stringify({ nodes, explicit })).toBe(snapshot);
    expect(second).toEqual(first);
  });

  it("空板/空入参返回空数组", () => {
    expect(deriveBoardEdges([], [])).toEqual([]);
    expect(deriveBoardEdges([{ id: "solo" }], [])).toEqual([]);
  });
});
