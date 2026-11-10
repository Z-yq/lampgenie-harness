/**
 * board-sense 控制流转换器(branches → 板 flow)单测:
 * decisionsToFlow 把 code_sense 的**扁平** DecisionPoint 点列(if/else 是并列点,分支体只靠
 * lineStart/lineEnd+depth 隐式表达)重建成 branch/loop 递归树;decisionsBoard 包成板节点。
 * fixture 按 packages/code-sense/src/sensing/decision.ts:30-49 的真实字段手写,不跑 scanDecisionFile。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionsToFlow, decisionsBoard } from "../src/board-sense.js";
import { saveBoard } from "../src/board-store.js";
import type { DecisionPoint } from "@lampgenie/code-sense/sensing/decision";
import type { BoardFlowStep } from "@lampgenie/protocol";

let tmpDirs: string[] = [];
afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs = []; });

/** 手写决策点(字段顺序/可选性对齐 decision.ts 的 DecisionPoint)。 */
function dp(p: Partial<DecisionPoint> & Pick<DecisionPoint, "kind" | "lineStart" | "lineEnd" | "depth">): DecisionPoint {
  return { literals: [], calls: [], fn: "run", ...p };
}

/** 递归数 flow 总节点数 + 嵌套容器数组最大值(协议:顶层 BoardNodeZ.flow max 40,嵌套 BoardFlowStepZ max 20)。 */
function countFlow(steps: BoardFlowStep[], nest = false): { total: number; maxNestedArr: number } {
  let total = 0;
  let maxNestedArr = nest ? steps.length : 0;
  for (const s of steps) {
    total++;
    for (const kid of [s.then, s.else, s.body]) {
      if (!kid) continue;
      const r = countFlow(kid, true);
      total += r.total;
      maxNestedArr = Math.max(maxNestedArr, r.maxNestedArr);
    }
  }
  return { total, maxNestedArr };
}

/** 收集树里所有 step 文本(branch/loop 的 cond/over 也算,便于断言归属)。 */
function texts(steps: BoardFlowStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    if (s.text) out.push(s.text);
    if (s.cond) out.push("cond:" + s.cond);
    if (s.over) out.push("over:" + s.over);
    for (const kid of [s.then, s.else, s.body]) if (kid) out.push(...texts(kid));
  }
  return out;
}

describe("decisionsToFlow:扁平决策点 → branch/loop 树", () => {
  it("① 单 if + else:两并列点合成一个 branch,then/else 都非空", () => {
    const flow = decisionsToFlow([
      dp({ kind: "if", lineStart: 1, lineEnd: 3, depth: 0, condition: "a > 0", calls: ["log"] }),
      dp({ kind: "else", lineStart: 4, lineEnd: 6, depth: 0, calls: ["warn"] }),
    ]);
    expect(flow.length).toBe(1); // else 不单独成条
    expect(flow[0]!.type).toBe("branch");
    expect(flow[0]!.cond).toBe("a > 0");
    expect(flow[0]!.then!.length).toBeGreaterThan(0);
    expect(flow[0]!.else!.length).toBeGreaterThan(0);
    expect(texts(flow[0]!.then!)).toContain("调用 log");
    expect(texts(flow[0]!.else!)).toContain("调用 warn");
  });

  it("② if / else if / else 三连:elif 嵌在上一分支的 else 里(else 再挂最终分支)", () => {
    const flow = decisionsToFlow([
      dp({ kind: "if", lineStart: 1, lineEnd: 3, depth: 0, condition: "a === 1" }),
      dp({ kind: "elif", lineStart: 4, lineEnd: 6, depth: 0, condition: "a === 2", calls: ["two"] }),
      dp({ kind: "else", lineStart: 7, lineEnd: 9, depth: 0, calls: ["other"] }),
    ]);
    expect(flow.length).toBe(1);
    const head = flow[0]!;
    expect(head.cond).toBe("a === 1");
    expect(head.else!.length).toBe(1);
    const elif = head.else![0]!;
    expect(elif.type).toBe("branch");
    expect(elif.cond).toBe("a === 2");
    expect(texts(elif.then!)).toContain("调用 two");
    expect(texts(elif.else!)).toContain("调用 other"); // 最终 else 落进 elif 的 else,不冒到外层
  });

  it("③ for-of:type=loop、over=被迭代对象、body 内是 calls 的 step", () => {
    const flow = decisionsToFlow([
      dp({ kind: "for-of", lineStart: 2, lineEnd: 6, depth: 0, loopTarget: "item", loopIterates: "items", calls: ["saveItem", "emit"] }),
    ]);
    expect(flow.length).toBe(1);
    expect(flow[0]!.type).toBe("loop");
    expect(flow[0]!.over).toBe("items");
    expect(flow[0]!.body!.some((s) => s.type === "step" && s.text === "调用 saveItem, emit")).toBe(true);
    expect(flow[0]!.then).toBeUndefined();
  });

  it("④ 嵌套 if-else:内层 if 进外层 then,外层 else 的调用不串进内层", () => {
    const flow = decisionsToFlow([
      dp({ kind: "if", lineStart: 1, lineEnd: 10, depth: 0, condition: "outer" }),
      dp({ kind: "if", lineStart: 2, lineEnd: 4, depth: 1, condition: "inner", calls: ["a"] }),
      dp({ kind: "else", lineStart: 5, lineEnd: 7, depth: 1, calls: ["b"] }),
      dp({ kind: "else", lineStart: 8, lineEnd: 10, depth: 0, calls: ["c"] }),
    ]);
    expect(flow.length).toBe(1);
    const outer = flow[0]!;
    expect(outer.cond).toBe("outer");
    const inner = outer.then!.find((s) => s.type === "branch")!;
    expect(inner.cond).toBe("inner");
    expect(texts(inner.then!)).toContain("调用 a");
    expect(texts(inner.else!)).toContain("调用 b");
    // 外层 else 只含 c;c 绝不出现在内层 else 里(不串层)
    expect(texts(outer.else!)).toContain("调用 c");
    expect(texts(inner.else!)).not.toContain("调用 c");
  });

  it("⑤ 超限保护:60 个分支 → 总步数 ≤40(+截断提示)且浅层优先", () => {
    const pts: DecisionPoint[] = [];
    for (let i = 0; i < 60; i++) {
      pts.push(dp({ kind: "if", lineStart: i * 3 + 1, lineEnd: i * 3 + 3, depth: 0, condition: `x${i} > 0`, calls: [`f${i}`] }));
    }
    const flow = decisionsToFlow(pts);
    const { total, maxNestedArr } = countFlow(flow);
    expect(flow.length).toBeLessThanOrEqual(40); // 顶层(含提示)不超协议 BoardNodeZ.flow max(40)
    expect(total).toBeLessThanOrEqual(40); // 整棵树节点数(截断提示本身也计入)
    expect(maxNestedArr).toBeLessThanOrEqual(20); // 每个嵌套容器守 BoardFlowStepZ max(20)
    const last = flow[flow.length - 1]!;
    expect(last.type).toBe("step");
    expect(last.text).toMatch(/已截断 \d+ 个深层分支/);
    // 浅层主干优先:前面的分支保留,靠后的深层被截掉
    expect(flow[0]!.cond).toBe("x0 > 0");
    expect(texts(flow)).toContain("cond:x0 > 0");
    expect(texts(flow)).not.toContain("cond:x59 > 0");
  });
});

describe("decisionsBoard:控制流板节点", () => {
  it("单函数:kind=function + 摘要真实计数 + flow 挂上;无 edges", () => {
    const points = [
      dp({ kind: "if", lineStart: 1, lineEnd: 3, depth: 0, condition: "a", calls: ["x"] }),
      dp({ kind: "else", lineStart: 4, lineEnd: 6, depth: 0 }),
      dp({ kind: "for-of", lineStart: 7, lineEnd: 9, depth: 0, loopTarget: "it", loopIterates: "list" }),
      dp({ kind: "if", lineStart: 10, lineEnd: 12, depth: 1, condition: "b" }),
    ];
    const b = decisionsBoard({ symbol: "run", points });
    expect(b.nodes.length).toBe(1);
    expect(b.edges).toEqual([]);
    const n = b.nodes[0]!;
    expect(n.kind).toBe("function");
    expect(n.label).toBe("run");
    expect(n.summary).toContain("if×3"); // if+elif+else 归 if 族(本例 if×2 + else×1)
    expect(n.summary).toContain("loop×1");
    expect(n.summary).toContain("最深 2 层"); // depth 1 → 2 层
    expect(n.symbolRef?.name).toBe("run");
    expect(n.flow.length).toBe(2); // 一个 if-branch + 一个 loop
    expect(n.flow.some((s) => s.type === "loop" && s.over === "list")).toBe(true);
  });

  it("多函数:每 fn 一个节点,节点间无边;三元降级为 step", () => {
    const points = [
      dp({ kind: "if", lineStart: 1, lineEnd: 2, depth: 0, condition: "p", fn: "alpha" }),
      dp({ kind: "ternary", lineStart: 3, lineEnd: 3, depth: 0, condition: "q ? 1 : 2", fn: "alpha" }),
      dp({ kind: "while", lineStart: 5, lineEnd: 7, depth: 0, condition: "n--", fn: "beta" }),
    ];
    const b = decisionsBoard({ points });
    expect(b.nodes.length).toBe(2);
    expect(b.edges).toEqual([]);
    const byLabel = new Map(b.nodes.map((n) => [n.id, n]));
    const alpha = b.nodes.find((n) => n.label === "alpha")!;
    const beta = b.nodes.find((n) => n.label === "beta")!;
    expect(alpha.summary).toContain("三元×1");
    expect(texts(alpha.flow)).toContain("?: 条件 q ? 1 : 2"); // 三元不画分支,降级 step
    expect(beta.flow[0]!.type).toBe("loop");
    expect(byLabel.size).toBe(2);
  });

  it("switch/case:case 归属最近 switch,标签成 step 平铺在 then 里", () => {
    const points = [
      dp({ kind: "switch", lineStart: 1, lineEnd: 12, depth: 0, condition: "mode" }),
      dp({ kind: "case", lineStart: 2, lineEnd: 4, depth: 1, condition: "\"fast\"", calls: ["fastPath"] }),
      dp({ kind: "default", lineStart: 5, lineEnd: 7, depth: 1, calls: ["slowPath"] }),
    ];
    const flow = decisionsToFlow(points);
    expect(flow.length).toBe(1);
    expect(flow[0]!.type).toBe("branch");
    expect(flow[0]!.cond).toBe('switch(mode)');
    const t = texts(flow[0]!.then!);
    expect(t).toContain('case "fast":');
    expect(t).toContain("调用 fastPath");
    expect(t).toContain("default:");
    expect(t).toContain("调用 slowPath");
  });

  it("产物过 BoardDocZ(saveBoard 真存):截断后的 flow 仍是合法协议形态", () => {
    const points: DecisionPoint[] = [];
    for (let i = 0; i < 60; i++) {
      points.push(dp({ kind: "if", lineStart: i * 2 + 1, lineEnd: i * 2 + 2, depth: 0, condition: `c${i}`, calls: [`f${i}`] }));
    }
    const b = decisionsBoard({ symbol: "big", points });
    const dir = mkdtempSync(join(tmpdir(), "bsd-")); tmpDirs.push(dir);
    const r = saveBoard(dir, {
      version: 1, taskId: "d1", sessionId: "s1", title: b.title, status: "draft", rev: 1,
      nodes: b.nodes, edges: b.edges, updatedAt: 0,
    } as unknown as Parameters<typeof saveBoard>[1]);
    expect(r.ok).toBe(true);
  });
});