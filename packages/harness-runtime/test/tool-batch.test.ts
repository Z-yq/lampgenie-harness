/**
 * 工具批次并发调度(纯逻辑):路径提取 / 重叠分段 / 提交序 / 屏障 / 合成结果 / stats /
 * 确定性 / 不可变。真实探针 A-F 对应本文件各段用例。
 */
import { describe, it, expect } from "vitest";
import {
  ABORTED_BEFORE_DISPATCH_TEXT,
  PATH_ARG_KEYS,
  batchStats,
  mergeBatchResults,
  pathsOfToolCall,
  planToolBatch,
  type BatchPlan,
  type ToolCallLike,
} from "../src/agent/tool-batch";

function mkCall(id: string, name: string, args: Record<string, unknown>): ToolCallLike {
  return { id, name, arguments: JSON.stringify(args) };
}

const safeAll = () => true;
const unsafeAll = () => false;

describe("pathsOfToolCall 路径提取", () => {
  it("读取五个固定路径键", () => {
    const call = mkCall("c1", "edit_file", {
      path: "/a.ts",
      file_path: "/b.ts",
      target_path: "/c.ts",
      old_path: "/d.ts",
      new_path: "/e.ts",
    });
    expect(pathsOfToolCall(call)).toEqual(["/a.ts", "/b.ts", "/c.ts", "/d.ts", "/e.ts"]);
  });

  it("去重并排序", () => {
    const call = mkCall("c1", "x", { path: "/z.ts", file_path: "/a.ts", new_path: "/z.ts" });
    expect(pathsOfToolCall(call)).toEqual(["/a.ts", "/z.ts"]);
  });

  it("非法 JSON 返回空数组", () => {
    expect(pathsOfToolCall({ id: "c1", name: "x", arguments: "{not json" })).toEqual([]);
  });

  it("非对象(数组/标量/null)返回空数组", () => {
    expect(pathsOfToolCall({ id: "c1", name: "x", arguments: "[1,2]" })).toEqual([]);
    expect(pathsOfToolCall({ id: "c1", name: "x", arguments: "42" })).toEqual([]);
    expect(pathsOfToolCall({ id: "c1", name: "x", arguments: "null" })).toEqual([]);
  });

  it("不猜其它字段(file/cwd/command 里的路径不算)", () => {
    const call = mkCall("c1", "x", { file: "/a.ts", cwd: "/repo", command: "rm /a.ts" });
    expect(pathsOfToolCall(call)).toEqual([]);
  });

  it("空字符串与非字符串值被忽略", () => {
    const call = mkCall("c1", "x", { path: "", file_path: 123, target_path: null });
    expect(pathsOfToolCall(call)).toEqual([]);
  });

  it("固定路径键清单是导出常量且覆盖五个键", () => {
    expect([...PATH_ARG_KEYS]).toEqual(["path", "file_path", "target_path", "old_path", "new_path"]);
  });
});

describe("planToolBatch 分段", () => {
  it("探针 A:3 个 safe 无路径调用 → 一个并行段且保持提交序", () => {
    const calls = [mkCall("a", "echo", {}), mkCall("b", "echo", {}), mkCall("c", "echo", {})];
    const plan = planToolBatch(calls, { isSafe: safeAll });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]).toEqual({ parallel: true, calls });
  });

  it("探针 B:两个写同一 path → 拆成两段且保持提交序", () => {
    const a = mkCall("a", "edit_file", { path: "/a.ts" });
    const b = mkCall("b", "edit_file", { path: "/a.ts" });
    const plan = planToolBatch([a, b], { isSafe: safeAll });
    expect(plan.segments).toEqual([
      { parallel: true, calls: [a] },
      { parallel: false, calls: [b] },
    ]);
    expect(plan.segments.flatMap((s) => s.calls.map((c) => c.id))).toEqual(["a", "b"]);
  });

  it("路径不重叠的 safe 调用留在同一并行段", () => {
    const calls = [
      mkCall("a", "read_file", { path: "/a.ts" }),
      mkCall("b", "read_file", { path: "/b.ts" }),
      mkCall("c", "edit_file", { path: "/c.ts" }),
    ];
    const plan = planToolBatch(calls, { isSafe: safeAll });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.parallel).toBe(true);
    expect(plan.segments[0]!.calls.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("第三个调用与前两个之一重叠 → 前两个并行、第三个独段", () => {
    const a = mkCall("a", "edit_file", { path: "/a.ts" });
    const b = mkCall("b", "edit_file", { path: "/b.ts" });
    const c = mkCall("c", "edit_file", { path: "/a.ts" });
    const plan = planToolBatch([a, b, c], { isSafe: safeAll });
    expect(plan.segments.map((s) => ({ p: s.parallel, ids: s.calls.map((x) => x.id) }))).toEqual([
      { p: true, ids: ["a", "b"] },
      { p: false, ids: ["c"] },
    ]);
  });

  it("探针 D:非 safe 调用作为屏障,前后 safe 调用分属两段", () => {
    const a = mkCall("a", "wiki", {});
    const b = mkCall("b", "wiki", {});
    const c = mkCall("c", "wiki", {});
    const plan = planToolBatch([a, b, c], { isSafe: (call) => call.id !== "b" });
    expect(plan.segments.map((s) => ({ p: s.parallel, ids: s.calls.map((x) => x.id) }))).toEqual([
      { p: true, ids: ["a"] },
      { p: false, ids: ["b"] },
      { p: true, ids: ["c"] },
    ]);
  });

  it("非 safe 调用自身不会与 safe 调用同段(isSafe=false 永不并行)", () => {
    const calls = [mkCall("a", "wiki", {}), mkCall("b", "wiki", {})];
    const plan = planToolBatch(calls, { isSafe: unsafeAll });
    expect(plan.segments).toEqual([
      { parallel: false, calls: [calls[0]] },
      { parallel: false, calls: [calls[1]] },
    ]);
  });

  it("探针 C:hasPathInfo 声明会碰路径但抽不到路径 → 保守独占", () => {
    const a = mkCall("a", "terminal", { command: "echo hi" });
    const b = mkCall("b", "terminal", { command: "ls" });
    const plan = planToolBatch([a, b], { isSafe: safeAll, hasPathInfo: () => true });
    expect(plan.segments).toEqual([
      { parallel: false, calls: [a] },
      { parallel: false, calls: [b] },
    ]);
  });

  it("hasPathInfo 声明且抽出路径时按真实路径判重叠", () => {
    const a = mkCall("a", "terminal", { command: "x", path: "/a.ts" });
    const b = mkCall("b", "terminal", { command: "y", path: "/b.ts" });
    const plan = planToolBatch([a, b], { isSafe: safeAll, hasPathInfo: () => true });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.parallel).toBe(true);
  });

  it("hasPathInfo 缺省时无路径 safe 调用仍并行(旧行为等价)", () => {
    const calls = [mkCall("a", "echo", {}), mkCall("b", "echo", {})];
    const plan = planToolBatch(calls, { isSafe: safeAll });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.parallel).toBe(true);
  });

  it("空 calls → segments=[]", () => {
    expect(planToolBatch([], { isSafe: safeAll })).toEqual({ segments: [] });
  });

  it("old_path/new_path 的重命名调用被识别为同路径冲突", () => {
    const a = mkCall("a", "edit_file", { new_path: "/x.ts" });
    const b = mkCall("b", "edit_file", { old_path: "/x.ts" });
    const plan = planToolBatch([a, b], { isSafe: safeAll });
    expect(plan.segments.map((s) => s.parallel)).toEqual([true, false]);
  });

  it("同一工具不同路径不冲突,仍同段并行", () => {
    const calls = [mkCall("a", "read_file", { path: "/a" }), mkCall("b", "read_file", { path: "/b" })];
    const plan = planToolBatch(calls, { isSafe: safeAll });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.calls).toHaveLength(2);
  });

  it("isSafe 抛错按不安全处理,不向外抛", () => {
    const calls = [mkCall("a", "x", {}), mkCall("b", "y", {})];
    const plan = planToolBatch(calls, {
      isSafe: () => {
        throw new Error("boom");
      },
    });
    expect(plan.segments.map((s) => s.parallel)).toEqual([false, false]);
  });

  it("hasPathInfo 抛错按未声明处理(路径不可知判定不误伤)", () => {
    const calls = [mkCall("a", "x", {}), mkCall("b", "y", {})];
    const plan = planToolBatch(calls, {
      isSafe: safeAll,
      hasPathInfo: () => {
        throw new Error("boom");
      },
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0]!.parallel).toBe(true);
  });

  it("混合序列展平后顺序与提交序完全一致", () => {
    const calls = [
      mkCall("a", "read_file", { path: "/a" }),
      mkCall("b", "wiki", {}),
      mkCall("c", "read_file", { path: "/a" }),
      mkCall("d", "read_file", { path: "/d" }),
      mkCall("e", "wiki", {}),
    ];
    const plan = planToolBatch(calls, { isSafe: (call) => call.name !== "wiki" });
    const flat = plan.segments.flatMap((s) => s.calls.map((c) => c.id));
    expect(flat).toEqual(["a", "b", "c", "d", "e"]);
 // 段边界:a 并行 / b 屏障 / c,d 新并行段(屏障之后不再与 a 跨段比较) / e 屏障
    expect(plan.segments.map((s) => s.parallel)).toEqual([true, false, true, false]);
  });

  it("不修改入参 calls 数组(不可变)", () => {
    const calls = [
      mkCall("a", "edit_file", { path: "/a.ts" }),
      mkCall("b", "edit_file", { path: "/a.ts" }),
    ];
    const snapshot = calls.map((c) => ({ ...c }));
    planToolBatch(calls, { isSafe: safeAll });
    expect(calls).toEqual(snapshot);
    expect(calls).toHaveLength(2);
  });

  it("连续同路径写:第一段并行、其后每个都独占(屏障后再起并行段)", () => {
    const calls = [
      mkCall("a", "edit_file", { path: "/a.ts" }),
      mkCall("b", "edit_file", { path: "/a.ts" }),
      mkCall("c", "edit_file", { path: "/a.ts" }),
    ];
    const plan = planToolBatch(calls, { isSafe: safeAll });
    expect(plan.segments.map((s) => ({ p: s.parallel, ids: s.calls.map((x) => x.id) }))).toEqual([
      { p: true, ids: ["a"] },
      { p: false, ids: ["b"] },
      { p: true, ids: ["c"] },
    ]);
  });

  it("同一调用参数里重复路径只计一次", () => {
    const a = mkCall("a", "edit_file", { path: "/a.ts", file_path: "/a.ts" });
    const b = mkCall("b", "edit_file", { path: "/b.ts" });
    const plan = planToolBatch([a, b], { isSafe: safeAll });
    expect(plan.segments).toHaveLength(1);
  });
});

describe("mergeBatchResults 结果归并", () => {
  it("按 calls 提交序返回,与 outcomesById 插入序无关", () => {
    const calls = [mkCall("a", "x", {}), mkCall("b", "x", {}), mkCall("c", "x", {})];
    const outcomes = new Map([
      ["c", { content: "C" }],
      ["a", { content: "A" }],
      ["b", { content: "B" }],
    ]);
    expect(mergeBatchResults(calls, outcomes).map((r) => r.content)).toEqual(["A", "B", "C"]);
  });

  it("探针 E:缺结果的调用补 ABORTED_BEFORE_DISPATCH 合成结果", () => {
    const calls = [mkCall("a", "x", {}), mkCall("b", "y", {}), mkCall("c", "z", {})];
    const merged = mergeBatchResults(calls, new Map([["a", { content: "A" }], ["c", { content: "C" }]]));
    expect(merged).toHaveLength(3);
    const synthetic = merged[1] as { call: ToolCallLike; content: string; error: { origin: string; name: string }; durationMs: number };
    expect(synthetic.call).toEqual(calls[1]);
    expect(synthetic.content).toBe(ABORTED_BEFORE_DISPATCH_TEXT);
    expect(synthetic.error.origin).toBe("aborted");
    expect(synthetic.error.name).toBe("y");
    expect(synthetic.durationMs).toBe(0);
  });

  it("全部命中时返回原对象引用,不复制不丢字段", () => {
    const calls = [mkCall("a", "x", {})];
    const outcome = { content: "A", durationMs: 7 } as { content: string };
    const merged = mergeBatchResults(calls, new Map<string, typeof outcome>([["a", outcome]]));
    expect(merged[0]).toBe(outcome);
  });

  it("支持普通对象作为 outcomesById", () => {
    const calls = [mkCall("a", "x", {}), mkCall("b", "y", {})];
    const merged = mergeBatchResults(calls, { a: { content: "A" } });
    expect(merged.map((r) => r.content)).toEqual(["A", ABORTED_BEFORE_DISPATCH_TEXT]);
  });

  it("空 calls → 空数组", () => {
    expect(mergeBatchResults([], new Map())).toEqual([]);
  });

  it("不修改 outcomesById(不可变)", () => {
    const calls = [mkCall("a", "x", {})];
    const outcomes = new Map([["a", { content: "A" }]]);
    mergeBatchResults(calls, outcomes);
    expect([...outcomes.keys()]).toEqual(["a"]);
    expect(outcomes.get("a")).toEqual({ content: "A" });
  });
});

describe("batchStats 批次统计", () => {
  const calls = [
    mkCall("a", "edit_file", { path: "/a.ts" }),
    mkCall("b", "edit_file", { path: "/b.ts" }),
    mkCall("c", "edit_file", { path: "/a.ts" }),
    mkCall("d", "wiki", {}),
  ];

  it("探针 F:段数/并行段/串行调用/最大并行度正确", () => {
    const plan = planToolBatch(calls, { isSafe: (call) => call.name !== "wiki" });
 // [a,b] 并行 → c 独占(与 a 冲突) → d 独占(非 safe)
    expect(batchStats(plan)).toEqual({ segments: 3, parallelSegments: 1, sequentialCalls: 2, maxParallel: 2 });
  });

  it("空计划 → 全零", () => {
    const plan: BatchPlan = { segments: [] };
    expect(batchStats(plan)).toEqual({ segments: 0, parallelSegments: 0, sequentialCalls: 0, maxParallel: 0 });
  });

  it("全串行计划 maxParallel=0", () => {
    const plan = planToolBatch([mkCall("a", "x", {}), mkCall("b", "y", {})], { isSafe: unsafeAll });
    expect(batchStats(plan)).toEqual({ segments: 2, parallelSegments: 0, sequentialCalls: 2, maxParallel: 0 });
  });

  it("确定性:同一输入两次规划结果深等", () => {
    const p1 = planToolBatch(calls, { isSafe: (call) => call.name !== "wiki" });
    const p2 = planToolBatch(calls, { isSafe: (call) => call.name !== "wiki" });
    expect(p1).toEqual(p2);
    expect(batchStats(p1)).toEqual(batchStats(p2));
  });
});
