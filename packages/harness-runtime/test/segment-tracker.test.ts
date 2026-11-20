import { describe, it, expect } from "vitest";
import {
  scanSegmentClosures, collectToolEntries, collectAppliedSegmentIds, isCandidateStillReferenced,
  pickConfirmDue, SEGMENT_PLACEHOLDER_EST_CHARS,
} from "../src/agent/segment-tracker";

/**
 * 段化改造(§4.1.3):段闭合三判据 × 定价入队。
 * 闭合只记账入队(W/W′/tail/N),不当场裁;user 段锚保留;开放段不闭合;
 * seenCloses 幂等。事件形状与 loop 侧 journal.readAll 映射一致(type/seq/payload)。
 */

function toolCall(seq: number, id: string, name: string, args: Record<string, unknown>) {
  return { type: "tool.call", seq, payload: { toolCallId: id, name, arguments: args } };
}
function toolResult(seq: number, id: string, chars: number) {
  return { type: "tool.result", seq, payload: { toolCallId: id, content: "x".repeat(chars) } };
}

describe("segment-tracker(§4.1.3 段闭合)", () => {
  it("collectToolEntries:tool.call.arguments 为 JSON 字符串时也解析 path(线上 journal 形状)", () => {
    const entries = collectToolEntries([
      { type: "tool.call", seq: 1, payload: { toolCallId: "s1", name: "read_file", arguments: JSON.stringify({ path: "src/string-args.ts" }) } },
      { type: "tool.result", seq: 2, payload: { toolCallId: "s1", content: "x".repeat(3000) } },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolCallId: "s1", argsWhere: "src/string-args.ts", resultChars: 3000 });
  });

  it("collectToolEntries:call/result 配对提取,arguments 取 path 当寻址", () => {
    const entries = collectToolEntries([
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 3000),
      toolCall(3, "b", "grep", { pattern: "x" }),
      toolResult(4, "b", 100),
      toolResult(99, "ghost", 500), // 无调用配对:跳过
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ toolCallId: "a", name: "read_file", argsWhere: "src/a.ts", resultChars: 3000 });
    expect(entries[1]).toMatchObject({ toolCallId: "b", name: "grep", argsWhere: "x", resultChars: 100 });
  });

  it("turn.end 闭合:边界之前的 ≥2000 字符 tool 结果全部定价入队(W/W′/tail=0)", () => {
    const events = [
      { type: "message.user", seq: 0, payload: { text: "go" } },
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
      toolCall(3, "b", "grep", { pattern: "y" }),
      toolResult(4, "b", 1999), // <2000:不入经济账
      { type: "turn.end", seq: 5, payload: { turn: 0, reason: "completed" } },
    ];
    const scan = scanSegmentClosures(events, new Set());
    expect(scan.closed).toHaveLength(1);
    const seg = scan.closed[0]!;
    expect(seg.closeReason).toBe("turn-end");
    expect(seg.items).toHaveLength(1); // 只有 a
    const item = seg.items[0]!;
    expect(item.id).toBe("a");
    expect(item.savedTokensW).toBe(1000); // 4000/4
    expect(item.productTokensWPrime).toBe(Math.floor(SEGMENT_PLACEHOLDER_EST_CHARS / 4));
    expect(item.tailTokens).toBe(0); // turn 末攒批:tail≈0(§4.1.1 拍板)
  });

  it("task.phase 与 context.path.abandoned(type=生产形状)触发段闭合(phase-advance/path-abandoned)", () => {
    const events = [
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
 // 生产形状:task_phase 工具写 payload.type="task.phase"(不是 what="task_phase")。
      { type: "custom", seq: 3, payload: { type: "task.phase", phase: "implement" } },
      toolCall(4, "b", "read_file", { path: "src/b.ts" }),
      toolResult(5, "b", 8000),
      { type: "custom", seq: 6, payload: { type: "context.path.abandoned", reason: "wrong" } },
    ];
    const scan = scanSegmentClosures(events, new Set());
    expect(scan.closed.map((s) => s.closeReason)).toEqual(["phase-advance", "path-abandoned"]);
 // 第一段:a;第二段只含本段新增 b(每条内容只随所属段闭合降级一次,§4.1.3)
    expect(scan.closed[0]!.items.map((i) => i.id)).toEqual(["a"]);
    expect(scan.closed[1]!.items.map((i) => i.id)).toEqual(["b"]);
 // path-abandoned 已由 path-prune 主裁:段批只观察,标注 observeOnly,tracker 外层不入队。
    expect(scan.closed[1]!.items.every((i) => i.observeOnly === true)).toBe(true);
  });

  it("旧 journal 兼容:what=\"task_phase\" / what=\"context.path.abandoned\" 仍触发闭合", () => {
    const events = [
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
      { type: "custom", seq: 3, payload: { what: "task_phase", phase: "implement" } },
      toolCall(4, "b", "read_file", { path: "src/b.ts" }),
      toolResult(5, "b", 8000),
      { type: "custom", seq: 6, payload: { what: "context.path.abandoned", reason: "wrong" } },
    ];
    const scan = scanSegmentClosures(events, new Set());
    expect(scan.closed.map((s) => s.closeReason)).toEqual(["phase-advance", "path-abandoned"]);
 // 两种形状的 segmentId 归一:旧 what 与新 type 同一边界只产出一条。
    const again = scanSegmentClosures(events, new Set(["task_phase:3", "context.path.abandoned:6"]));
    expect(again.closed).toHaveLength(0);
  });

  it("逐条产物选择:摘要仅在 W>W′×r 时启用,其余回落确定性占位", () => {
    const events = [
      toolCall(1, "big", "read_file", { path: "src/big.ts" }),
      toolResult(2, "big", 40_000), // W=10000 > 800×10 → summary
      toolCall(3, "small", "read_file", { path: "src/small.ts" }),
      toolResult(4, "small", 8_000), // W=2000 < 8000 → placeholder
      { type: "turn.end", seq: 5, payload: { turn: 0 } },
    ];
    const scan = scanSegmentClosures(events, new Set(), { summaryTokensWPrime: 800, priceRatio: 10 });
    const items = scan.closed[0]!.items;
    const big = items.find((i) => i.id === "big")!;
    const small = items.find((i) => i.id === "small")!;
    expect(big.product).toBe("summary");
    expect(big.productTokensWPrime).toBe(800);
    expect(small.product).toBe("placeholder");
    expect(small.productTokensWPrime).toBe(Math.floor(SEGMENT_PLACEHOLDER_EST_CHARS / 4));
  });

  it("观察期结构检查:后续工具命中同一 where 才算仍被引用", () => {
    const events = [
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
      toolCall(5, "b", "edit_file", { path: "src/a.ts" }),
      toolResult(6, "b", 100),
      toolCall(7, "c", "read_file", { path: "src/other.ts" }),
      toolResult(8, "c", 100),
    ];
    expect(isCandidateStillReferenced({ tool: "read_file", where: "src/a.ts", resultSeq: 2 }, events)).toBe(true);
 // 后续没有命中同一 where → 可裁候选
    expect(isCandidateStillReferenced({ tool: "read_file", where: "src/never.ts", resultSeq: 2 }, events)).toBe(false);
 // 声明点之后无工具调用 → false
    expect(isCandidateStillReferenced({ tool: "read_file", where: "src/a.ts", resultSeq: 8 }, events)).toBe(false);
 // 缺 resultSeq → 不猜,false
    expect(isCandidateStillReferenced({ tool: "read_file", where: "src/a.ts" }, events)).toBe(false);
  });

  it("工具目标漂移:同段三个不同目录根 → target-drift 闭合;同根不闭合", () => {
    const drift = [
      toolCall(1, "a", "read_file", { path: "apps/gateway/src/a.ts" }),
      toolResult(2, "a", 4000),
      toolCall(3, "b", "read_file", { path: "packages/runtime/src/b.ts" }),
      toolResult(4, "b", 4000),
      toolCall(5, "c", "read_file", { path: "packages/wiki/src/c.ts" }),
      toolResult(6, "c", 4000),
    ];
    const scan = scanSegmentClosures(drift, new Set());
    expect(scan.closed.map((s) => s.closeReason)).toEqual(["target-drift"]);
    expect(scan.closed[0]!.closeSeq).toBe(5); // 漂移在第三个目标根的工具调用处
    expect(scan.closed[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
 // 同目录不同文件:不漂移
    const same = [
      toolCall(1, "a", "read_file", { path: "apps/gateway/src/a.ts" }),
      toolResult(2, "a", 4000),
      toolCall(3, "b", "read_file", { path: "apps/gateway/src/b.ts" }),
      toolResult(4, "b", 4000),
      toolCall(5, "c", "read_file", { path: "apps/gateway/src/c.ts" }),
      toolResult(6, "c", 4000),
    ];
    expect(scanSegmentClosures(same, new Set()).closed).toHaveLength(0);
  });

  it("subagent 终态 / board done / goal_progress 也触发闭合(§4.1.3 判据①②)", () => {
    const base = [
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
    ];
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "subagent.event", seq: 3, payload: { status: "completed" } }, "subagent-done"],
      [{ type: "subagent.event", seq: 3, payload: { phase: "failed" } }, "subagent-done"],
      [{ type: "subagent.event", seq: 3, payload: { kind: "turn.end", turn: 2 } }, "subagent-done"],
      [{ type: "subagent.result", seq: 3, payload: { ok: true } }, "subagent-done"],
      [{ type: "board.update", seq: 3, payload: { status: "done", nodeCount: 10 } }, "board-advance"],
      [{ type: "custom", seq: 3, payload: { type: "goal_progress", goalId: "g1" } }, "goal-advance"],
      [{ type: "custom", seq: 3, payload: { what: "goal_progress", goalId: "g1" } }, "goal-advance"],
    ];
    for (const [event, reason] of cases) {
      const scan = scanSegmentClosures([...base, event as never], new Set());
      expect(scan.closed.map((s) => s.closeReason)).toEqual([reason]);
      expect(scan.closed[0]!.items.map((i) => i.id)).toEqual(["a"]);
    }
 // 非终态 subagent / 非 done 白板不闭合。
    expect(scanSegmentClosures([...base, { type: "subagent.event", seq: 3, payload: { status: "running" } }], new Set()).closed).toHaveLength(0);
    expect(scanSegmentClosures([...base, { type: "board.update", seq: 3, payload: { status: "active" } }], new Set()).closed).toHaveLength(0);
  });

  it("collectAppliedSegmentIds 回放已应用台账:生产 type 与旧 what 都认,非法条目跳过", () => {
    const ids = collectAppliedSegmentIds([
      { type: "custom", seq: 1, payload: { what: "context.segment.applied", ids: ["a", "b"] } },
      { type: "custom", seq: 2, payload: { type: "context.segment.applied", ids: ["b", "c", 3, ""] } },
      { type: "custom", seq: 3, payload: { what: "context.segment.settle", ids: ["ghost"] } },
      { type: "message.user", seq: 4, payload: { text: "x" } },
    ]);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("焦点切换闭合:focusIdsBySeq 给的新焦点 ≠ 当前焦点才闭合,并回报 nextFocusId", () => {
    const events = [
      { type: "message.user", seq: 1, payload: { text: "t1" } },
      toolCall(2, "a", "read_file", { path: "src/a.ts" }),
      toolResult(3, "a", 3000),
      { type: "message.user", seq: 4, payload: { text: "t2" } },
    ];
    const focusIdsBySeq = new Map([[1, "f1"], [4, "f2"]]);
    const scan = scanSegmentClosures(events, new Set(), { currentFocusId: "f1", focusIdsBySeq });
    expect(scan.closed).toHaveLength(1);
    expect(scan.closed[0]!.closeReason).toBe("focus-switch");
    expect(scan.closed[0]!.items.map((i) => i.id)).toEqual(["a"]);
    expect(scan.nextFocusId).toBe("f2");
  });

  it("user 段锚不参与定价:message.user 事件不产条目(只做边界)", () => {
    const events = [
      { type: "message.user", seq: 0, payload: { text: "x".repeat(9000) } },
      { type: "turn.end", seq: 1, payload: {} },
    ];
    const scan = scanSegmentClosures(events, new Set());
    expect(scan.closed).toHaveLength(1);
    expect(scan.closed[0]!.items).toHaveLength(0); // user 消息不是 tool 结果,天然不入队;段锚保留由「只压 tool 结果」保证
  });

  it("seenCloses 幂等:同一边界二次扫描不重复产出", () => {
    const events = [
      toolCall(1, "a", "read_file", { path: "src/a.ts" }),
      toolResult(2, "a", 4000),
      { type: "turn.end", seq: 3, payload: {} },
    ];
    const first = scanSegmentClosures(events, new Set());
    const seen = new Set(first.closed.map((s) => s.segmentId));
    const second = scanSegmentClosures(events, seen);
    expect(second.closed).toHaveLength(0);
  });

  it("pickConfirmDue:只挑入队 ≥1 步的最早候选(异步滞后一步;每步 ≤1 条)", () => {
    const pending = [
      { id: "p1", tool: "read_file", where: "a", queuedAtStep: 5 },
      { id: "p2", tool: "grep", where: "b", queuedAtStep: 6 },
    ];
    expect(pickConfirmDue(pending, 6)?.id).toBe("p1"); // 6-5=1 ≥1
    expect(pickConfirmDue(pending, 5)).toBeUndefined(); // 5-5=0 <1:滞后一步
  });
});
