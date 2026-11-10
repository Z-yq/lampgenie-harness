/**
 * 表面替换溯源契约:append/replace 判定、来源唯一与更早、shadow 全覆盖、工具字段不变性、
 * 代际对齐、apply 投影(NaN 无 IO)、人读转录、派生缓存版本、结构体检。
 * 断言以返回码为准(码是调用方真正依赖的契约面)。
 */
import { describe, expect, it } from "vitest";
import type { SurfaceEvent, SurfaceState } from "../src/agent/surface-trace";
import {
  SURFACE_CODES,
  SURFACE_FAILURE_CODES,
  applySurfaceEvent,
  currentGeneration,
  derivedCacheVersion,
  detectBrokenReplacements,
  humanTranscript,
  validateEvent,
} from "../src/agent/surface-trace";

const T0 = 1_700_000_000_000;

function ev(seq: number, over: Partial<SurfaceEvent> = {}): SurfaceEvent {
  return { seq, kind: "message", surfaceOp: "append", content: `m${seq}`, at: T0 + seq, ...over };
}

function replace(seq: number, sources: number[], over: Partial<SurfaceEvent> = {}): SurfaceEvent {
  return {
    seq,
    kind: "message",
    surfaceOp: "replace",
    sourceEventSeqs: sources,
    content: `r${seq}`,
    replaceGeneration: 0,
    at: T0 + seq,
    ...over,
  };
}

function stateOf(events: SurfaceEvent[]): SurfaceState {
  const state: SurfaceState = { events: [], appendOrigin: new Set<number>(), contentGeneration: 0 };
  for (const event of events) {
    const next = applySurfaceEvent(state, event);
    state.events = next.state.events;
    state.appendOrigin = next.state.appendOrigin;
    state.contentGeneration = next.state.contentGeneration;
    state.shadowed = next.state.shadowed;
  }
  return state;
}

describe("append", () => {
  it("append 恒通过并给出 SURFACE_APPENDED", () => {
    const result = validateEvent(ev(1), []);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_APPENDED"]);
  });

  it("append 不需 sourceEventSeqs / 代际字段", () => {
    const result = validateEvent(ev(2, { content: "hi" }), [ev(1)]);
    expect(result.ok).toBe(true);
    expect(result.codes).toContain("SURFACE_APPENDED");
  });

  it("append 的 seq 与既有事件重复 → SURFACE_INVALID", () => {
    const result = validateEvent(ev(1), [ev(1)]);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });

  it("kind 非法 → SURFACE_INVALID", () => {
    const result = validateEvent({ ...ev(9), kind: "bogus" as never }, []);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual(["SURFACE_INVALID"]);
  });
});

describe("replace 来源校验", () => {
  const existing = [ev(1), ev(2), ev(3)];

  it("replace 正常 → SURFACE_REPLACED", () => {
    const result = validateEvent(replace(4, [1, 2]), existing);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
  });

  it("缺 sourceEventSeqs → SURFACE_SOURCE_MISSING", () => {
    const result = validateEvent(replace(4, [], { sourceEventSeqs: undefined }), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_MISSING");
  });

  it("sourceEventSeqs 空数组 → SURFACE_SOURCE_MISSING", () => {
    const result = validateEvent(replace(4, []), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_MISSING");
  });

  it("引用重复 source → SURFACE_SOURCE_DUPLICATE", () => {
    const result = validateEvent(replace(4, [1, 1]), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_DUPLICATE");
  });

  it("引用未来 seq → SURFACE_SOURCE_NOT_EARLIER", () => {
    const result = validateEvent(replace(4, [1, 5]), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_NOT_EARLIER");
  });

  it("引用自身 seq 也算不更早", () => {
    const result = validateEvent(replace(4, [4], { sourceEventSeqs: [4] }), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_NOT_EARLIER");
  });

  it("引用不存在的更早 seq → SURFACE_SOURCE_MISSING", () => {
    const gapped = [ev(1), ev(3)];
    const result = validateEvent(replace(4, [1, 2]), gapped);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_MISSING");
    expect(result.codes).not.toContain("SURFACE_SOURCE_NOT_EARLIER");
  });

  it("shadowedSeqs 未被 source 全覆盖 → SURFACE_SHADOW_INCOMPLETE", () => {
    const result = validateEvent(replace(4, [1]), existing, { shadowedSeqs: [1, 2] });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SHADOW_INCOMPLETE");
  });

  it("shadowedSeqs 全覆盖时通过", () => {
    const result = validateEvent(replace(4, [1, 2]), existing, { shadowedSeqs: [1, 2] });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
  });

  it("seq 与既有事件重复 → SURFACE_INVALID", () => {
    const result = validateEvent(replace(3, [1]), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });
});

describe("工具事件字段不变性", () => {
  const call: SurfaceEvent = {
    seq: 2,
    kind: "tool_call",
    surfaceOp: "append",
    toolCallId: "c1",
    name: "read_file",
    args: { path: "a.ts" },
    at: T0 + 2,
  };

  it("tool_call replace 改 name → SURFACE_TOOL_FIELDS_MUTATED", () => {
    const next = { ...call, seq: 4, surfaceOp: "replace" as const, sourceEventSeqs: [2], content: "x", replaceGeneration: 0, name: "write_file" };
    const result = validateEvent(next, [call], { oldEvent: call });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_TOOL_FIELDS_MUTATED");
  });

  it("tool_call replace 改 toolCallId → SURFACE_TOOL_FIELDS_MUTATED", () => {
    const next = { ...call, seq: 4, surfaceOp: "replace" as const, sourceEventSeqs: [2], content: "x", replaceGeneration: 0, toolCallId: "c2" };
    const result = validateEvent(next, [call], { oldEvent: call });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_TOOL_FIELDS_MUTATED");
  });

  it("tool_call replace 改 args → SURFACE_TOOL_FIELDS_MUTATED", () => {
    const next = { ...call, seq: 4, surfaceOp: "replace" as const, sourceEventSeqs: [2], content: "x", replaceGeneration: 0, args: { path: "b.ts" } };
    const result = validateEvent(next, [call], { oldEvent: call });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_TOOL_FIELDS_MUTATED");
  });

  it("tool_result replace 只改 content 通过", () => {
    const result0: SurfaceEvent = {
      seq: 3,
      kind: "tool_result",
      surfaceOp: "append",
      toolCallId: "c1",
      content: "old body",
      at: T0 + 3,
    };
    const next: SurfaceEvent = { ...result0, seq: 4, surfaceOp: "replace", sourceEventSeqs: [3], content: "new body", replaceGeneration: 0 };
    const result = validateEvent(next, [call, result0], { oldEvent: result0 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
  });
});

describe("compact 事务", () => {
  it("compact_end 缺 compact_start → SURFACE_INVALID", () => {
    const result = validateEvent(
      { seq: 5, kind: "compact_end", surfaceOp: "replace", sourceEventSeqs: [1], replaceGeneration: 0, at: T0 },
      [ev(1)],
    );
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });

  it("compact_start 晚于 compact_end → SURFACE_INVALID", () => {
    const start: SurfaceEvent = { seq: 6, kind: "compact_start", surfaceOp: "append", at: T0 };
    const result = validateEvent(
      { seq: 5, kind: "compact_end", surfaceOp: "replace", sourceEventSeqs: [6], replaceGeneration: 0, at: T0 },
      [start, ev(1)],
    );
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });

  it("compact_start 更早时 compact_end 通过", () => {
    const start: SurfaceEvent = { seq: 1, kind: "compact_start", surfaceOp: "append", at: T0 };
    const result = validateEvent(
      { seq: 5, kind: "compact_end", surfaceOp: "replace", sourceEventSeqs: [1], replaceGeneration: 0, at: T0 },
      [start, ev(2)],
    );
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
  });

  it("有 compact_start 无 compact_end → 体检报未闭合", () => {
    const state = stateOf([{ seq: 1, kind: "compact_start", surfaceOp: "append", at: T0 }, ev(2)]);
    const broken = detectBrokenReplacements(state);
    expect(broken.ok).toBe(false);
    expect(broken.issues.some((issue) => issue.seq === 1 && issue.detail?.includes("未闭合"))).toBe(true);
  });
});

describe("代际", () => {
  const existing = [ev(1), ev(2)];

  it("replaceGeneration 落后 → SURFACE_GENERATION_STALE", () => {
    const after = stateOf([ev(1), ev(2), replace(3, [1, 2])]);
    const stale = { ...replace(4, [3]), replaceGeneration: 0 };
    const result = validateEvent(stale, after.events);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_GENERATION_STALE");
  });

  it("replaceGeneration 超前 → SURFACE_GENERATION_STALE", () => {
    const result = validateEvent(replace(3, [1], { replaceGeneration: 7 }), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_GENERATION_STALE");
  });

  it("缺 replaceGeneration → SURFACE_INVALID", () => {
    const result = validateEvent(replace(3, [1], { replaceGeneration: undefined }), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });

  it("contentGeneration ≠ replaceGeneration+1 → SURFACE_INVALID", () => {
    const result = validateEvent(replace(3, [1], { contentGeneration: 5 }), existing);
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
  });

  it("contentGeneration = replaceGeneration+1 时通过", () => {
    const result = validateEvent(replace(3, [1], { contentGeneration: 1 }), existing);
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
  });

  it("currentGeneration:空流为 0,replace 后为 1", () => {
    expect(currentGeneration([])).toBe(0);
    const after = stateOf([ev(1), replace(2, [1])]);
    expect(currentGeneration(after.events)).toBe(1);
  });
});

describe("applySurfaceEvent 投影", () => {
  it("append:入 events、进 append-origin、代际不变", () => {
    const next = applySurfaceEvent({ events: [], appendOrigin: new Set(), contentGeneration: 0 }, ev(1));
    expect(next.state.events.map((e) => e.seq)).toEqual([1]);
    expect(next.state.appendOrigin.has(1)).toBe(true);
    expect(next.state.contentGeneration).toBe(0);
    expect(next.codes).toEqual(["SURFACE_APPENDED"]);
  });

  it("replace:shadowed 收进 source、append-origin 移除、代际 +1", () => {
    const base = stateOf([ev(1), ev(2)]);
    const next = applySurfaceEvent(base, replace(3, [1, 2]));
    expect([...(next.state.shadowed ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(next.state.appendOrigin.has(1)).toBe(false);
    expect(next.state.appendOrigin.has(2)).toBe(false);
    expect(next.state.contentGeneration).toBe(1);
    expect(next.codes).toEqual(["SURFACE_REPLACED", "SURFACE_GENERATION_BUMPED"]);
  });

  it("replace 不删除被 shadow 的原事件(journal 全留)", () => {
    const base = stateOf([ev(1), ev(2)]);
    const next = applySurfaceEvent(base, replace(3, [1, 2]));
    expect(next.state.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("apply 不修改入参", () => {
    const base = stateOf([ev(1), ev(2)]);
    const eventsBefore = JSON.stringify(base.events);
    const originBefore = [...base.appendOrigin];
    const shadowedBefore = [...(base.shadowed ?? [])];
    applySurfaceEvent(base, replace(3, [1]));
    expect(JSON.stringify(base.events)).toBe(eventsBefore);
    expect([...base.appendOrigin]).toEqual(originBefore);
    expect([...(base.shadowed ?? [])]).toEqual(shadowedBefore);
    expect(base.contentGeneration).toBe(0);
  });

  it("链式两次 replace 后代际为 2", () => {
    const s1 = stateOf([ev(1), ev(2)]);
    const s2 = applySurfaceEvent(s1, replace(3, [1])).state;
    const s3 = applySurfaceEvent(s2, { ...replace(4, [3]), replaceGeneration: 1, contentGeneration: 2 });
    expect(s3.state.contentGeneration).toBe(2);
    expect(s3.state.shadowed?.has(3)).toBe(true);
    expect(currentGeneration(s3.state.events)).toBe(2);
  });
});

describe("视图与派生版本", () => {
  it("humanTranscript 只含 append-origin", () => {
    const state = stateOf([ev(1), ev(2), ev(3), replace(4, [1, 2])]);
    const transcript = humanTranscript(state);
    expect(transcript.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(transcript.codes).toContain("SURFACE_TRANSCRIPT_BUILT");
  });

  it("humanTranscript 按 seq 升序", () => {
    const state: SurfaceState = {
      events: [ev(3), ev(1), ev(2)],
      appendOrigin: new Set([1, 2, 3]),
      contentGeneration: 0,
    };
    expect(humanTranscript(state).events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("derivedCacheVersion 跟随 contentGeneration", () => {
    const s1 = stateOf([ev(1)]);
    expect(derivedCacheVersion(s1)).toBe(0);
    const s2 = applySurfaceEvent(s1, replace(2, [1])).state;
    expect(derivedCacheVersion(s2)).toBe(1);
  });

  it("空状态 / 缺 shadowed 的状态也能投影", () => {
    const state: SurfaceState = { events: [], appendOrigin: new Set(), contentGeneration: 0 };
    expect(humanTranscript(state).events).toEqual([]);
    expect(derivedCacheVersion(state)).toBe(0);
    expect(detectBrokenReplacements(state).ok).toBe(true);
  });
});

describe("detectBrokenReplacements", () => {
  it("干净的表面 → ok", () => {
    const state = stateOf([
      ev(1),
      { seq: 2, kind: "tool_call", surfaceOp: "append", toolCallId: "c1", name: "read_file", at: T0 },
      { seq: 3, kind: "tool_result", surfaceOp: "append", toolCallId: "c1", content: "ok", at: T0 },
    ]);
    const broken = detectBrokenReplacements(state);
    expect(broken.ok).toBe(true);
    expect(broken.issues).toEqual([]);
  });

  it("有 call 无 result → SURFACE_TOOL_CALL_UNPAIRED", () => {
    const state = stateOf([
      ev(1),
      { seq: 2, kind: "tool_call", surfaceOp: "append", toolCallId: "c1", name: "read_file", at: T0 },
    ]);
    const broken = detectBrokenReplacements(state);
    expect(broken.ok).toBe(false);
    expect(broken.issues.map((i) => i.code)).toContain("SURFACE_TOOL_CALL_UNPAIRED");
  });

  it("有 result 无 call → SURFACE_TOOL_RESULT_UNPAIRED", () => {
    const state = stateOf([
      ev(1),
      { seq: 2, kind: "tool_result", surfaceOp: "append", toolCallId: "c9", content: "ok", at: T0 },
    ]);
    expect(detectBrokenReplacements(state).issues.map((i) => i.code)).toContain("SURFACE_TOOL_RESULT_UNPAIRED");
  });

  it("悬空 shadow(shadowed 指向不存在的 seq)", () => {
    const state = stateOf([ev(1)]);
    const broken = detectBrokenReplacements({
      ...state,
      shadowed: new Set([...(state.shadowed ?? []), 42]),
    });
    expect(broken.ok).toBe(false);
    expect(broken.issues.some((i) => i.seq === 42)).toBe(true);
  });

  it("replace 的 source 未全进 shadowed", () => {
    const state = stateOf([ev(1), ev(2), replace(3, [1, 2])]);
    const broken = detectBrokenReplacements({ ...state, shadowed: new Set([1]) });
    expect(broken.ok).toBe(false);
    expect(broken.issues.map((i) => i.code)).toContain("SURFACE_SHADOW_INCOMPLETE");
  });
});

describe("码表", () => {
  it("SURFACE_CODES 全部以 SURFACE_ 前缀", () => {
    expect(SURFACE_CODES.every((code) => code.startsWith("SURFACE_"))).toBe(true);
  });

  it("失败码是全部码的子集", () => {
    const all: readonly string[] = SURFACE_CODES;
    expect(SURFACE_FAILURE_CODES.every((code) => all.includes(code))).toBe(true);
  });
});
