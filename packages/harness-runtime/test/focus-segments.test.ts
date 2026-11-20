/**
 * 焦点信号数据源测试(缺口#29,件4):deriveFocusSegments / isConsumed 纯逻辑层。
 * 覆盖:user 段边界、子焦点标记(不拆段)、最后一段开放、脏事件、isConsumed 正反例。
 */
import { describe, expect, it } from "vitest";
import { deriveFocusSegments, isConsumed } from "../src/agent/focus-tracker";

describe("deriveFocusSegments:user 段边界", () => {
  it("空/非数组 → 空结果,不 throw", () => {
    expect(deriveFocusSegments([])).toEqual([]);
    expect(deriveFocusSegments(null as unknown as never[])).toEqual([]);
  });

  it("无 user 消息 → 无段", () => {
    const out = deriveFocusSegments([
      { type: "message.agent", seq: 1 },
      { type: "tool.result", seq: 2 },
    ]);
    expect(out).toEqual([]);
  });

  it("单个 user → 一段开放段(endSeq 缺省)", () => {
    const out = deriveFocusSegments([{ type: "message.user", seq: 10 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ focusId: "focus-0", startSeq: 10, origin: "user-message" });
    expect(out[0]!.endSeq).toBeUndefined();
  });

  it("两个 user → 前段在下一 user 的 seq 处闭合,后段开放", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 5 },
      { type: "tool.call", seq: 7 },
      { type: "message.user", seq: 20 },
      { type: "tool.call", seq: 22 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ startSeq: 5, endSeq: 20, origin: "user-message" });
    expect(out[1]).toMatchObject({ startSeq: 20, origin: "user-message" });
    expect(out[1]!.endSeq).toBeUndefined();
  });

  it("连续两条 user(空段)→ 两条段,前段 endSeq 不回退(startSeq 不小于 endSeq)", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 3 },
      { type: "message.user", seq: 3 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.endSeq).toBeUndefined(); // endSeq 必须大于 startSeq 才闭合
    expect(out[1]!.startSeq).toBe(3);
  });

  it("seq 缺失的脏事件按顺序递增兜底,不 throw", () => {
    const out = deriveFocusSegments([
      { type: "message.user" },
      { type: "goal_progress" },
      { type: "message.user", seq: 100 },
    ]);
    expect(out).toHaveLength(3); // user 段 2 + goal_progress 标记 1
    expect(out[0]!.startSeq).toBe(0);
    const userSegs = out.filter((x) => x.origin === "user-message");
    expect(userSegs[1]!.startSeq).toBe(100);
  });

  it("非对象/无 type 的脏元素跳过", () => {
    const out = deriveFocusSegments([
      null,
      42,
      {},
      { type: "message.user", seq: 1 },
    ] as never);
    expect(out).toHaveLength(1);
    expect(out[0]!.startSeq).toBe(1);
  });
});

describe("deriveFocusSegments:子焦点标记(只记 origin,不拆段)", () => {
  it("board_upsert 完成 → 段内追加 board-advance 标记,startSeq 与 user 段相同", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 1 },
      { type: "board_upsert", seq: 5, payload: { status: "done" } },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ startSeq: 1, origin: "board-advance" });
  });

  it("board_upsert 无 payload(status 缺省)也记标记;payload 非对象不 throw", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 1 },
      { type: "board_upsert", seq: 2 },
      { type: "board_upsert", seq: 3, payload: "not-an-object" },
    ]);
    const marks = out.filter((s) => s.origin === "board-advance");
    expect(marks).toHaveLength(2);
  });

  it("goal_progress → goal-advance 标记", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 10 },
      { type: "goal_progress", seq: 12, payload: { goal: "g1" } },
    ]);
    expect(out[1]).toMatchObject({ startSeq: 10, origin: "goal-advance" });
  });

  it("subagent spawn 与终态 → subagent-round 标记(同一 origin 可多条)", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 1 },
      { type: "subagent.spawn", seq: 2, payload: { agentId: "a1" } },
      { type: "subagent.event", seq: 3, payload: { phase: "done" } },
      { type: "subagent.event", seq: 4, payload: { phase: "running" } },
    ]);
    const marks = out.filter((s) => s.origin === "subagent-round");
    expect(marks).toHaveLength(2); // spawn + 终态;running 非终态不记
  });

  it("user 消息之前的子焦点信号不产生任何段(无当前段)", () => {
    const out = deriveFocusSegments([
      { type: "goal_progress", seq: 1 },
      { type: "board_upsert", seq: 2 },
      { type: "subagent.spawn", seq: 3 },
    ]);
    expect(out).toEqual([]);
  });

  it("子焦点标记不改变 user 段边界:下一条 user 仍正常闭合", () => {
    const out = deriveFocusSegments([
      { type: "message.user", seq: 1 },
      { type: "goal_progress", seq: 2 },
      { type: "board_upsert", seq: 3, payload: { status: "done" } },
      { type: "message.user", seq: 9 },
    ]);
    const userSegs = out.filter((s) => s.origin === "user-message");
    expect(userSegs[0]!.endSeq).toBe(9);
    expect(userSegs[1]!.startSeq).toBe(9);
  });
});

describe("isConsumed", () => {
  it("后续调用 argsText 命中 where 子串(大小写不敏感)→ true", () => {
    expect(
      isConsumed(
        { tool: "read_file", where: "packages/core/src/journal/journal.ts offset=600" },
        [
          { tool: "read_file", argsText: '{"path":"PACKAGES/CORE/src/journal/journal.ts offset=600"}' },
        ],
      ),
    ).toBe(true);
  });

  it("命中发生在 where 之前的语义上不区分——纯文本包含即 true(多调用任一命中)", () => {
    expect(
      isConsumed({ tool: "grep", where: "rsiSchedRender" }, [
        { tool: "edit_file", argsText: "别的" },
        { tool: "grep", argsText: '{"pattern":"rsiSchedRender"}' },
      ]),
    ).toBe(true);
  });

  it("后续调用无一处命中 → false", () => {
    expect(
      isConsumed({ tool: "read_file", where: "src/a.ts" }, [
        { tool: "read_file", argsText: '{"path":"src/b.ts"}' },
        { tool: "grep", argsText: '{"pattern":"x"}' },
      ]),
    ).toBe(false);
  });

  it("laterCalls 为空 / where 为空 / where 缺失 → false", () => {
    expect(isConsumed({ tool: "t", where: "x" }, [])).toBe(false);
    expect(isConsumed({ tool: "t", where: "" }, [{ tool: "t", argsText: "x" }])).toBe(false);
    expect(isConsumed({ tool: "t" }, [{ tool: "t", argsText: "x" }])).toBe(false);
  });

  it("脏条目(null/argsText 非字符串)跳过不 throw;非数组 laterCalls → false", () => {
    expect(
      isConsumed({ tool: "t", where: "x" }, [
        null,
        { tool: "t", argsText: 123 },
        { tool: "t" },
      ] as never),
    ).toBe(false);
    expect(isConsumed({ tool: "t", where: "x" }, null as unknown as never)).toBe(false);
  });

  it("where 只做空白 trim 后匹配,不含通配语义", () => {
    expect(isConsumed({ tool: "t", where: "  abc  " }, [{ tool: "t", argsText: "zzABCzz" }])).toBe(true);
    expect(isConsumed({ tool: "t", where: "a.c" }, [{ tool: "t", argsText: "abc" }])).toBe(false);
  });
});
