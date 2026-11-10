/**
 * 表面替换溯源持久层:落盘行数、重放投影一致、replace 的 shadow 投影、转录收窄、代际自增、
 * 坏来源拒收且不写盘、工具字段不变、代际过期拒收、结构体检、append-only 原行不被改写。
 * 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SurfaceEvent } from "@lampgenie/runtime/agent/surface-trace";
import {
  appendEvent,
  loadSurfaceTrace,
  replaceEvent,
  report,
  surfaceTracePath,
  transcript,
  validateIncoming,
  version,
} from "../src/surface-trace-store";

const T0 = 1_700_000_000_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "surface-trace-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function msg(seq: number, over: Partial<SurfaceEvent> = {}): SurfaceEvent {
  return { seq, kind: "message", surfaceOp: "append", content: `m${seq}`, at: T0 + seq, ...over };
}

function toolCall(seq: number, toolCallId = "c1"): SurfaceEvent {
  return {
    seq,
    kind: "tool_call",
    surfaceOp: "append",
    toolCallId,
    name: "read_file",
    args: { path: "a.ts" },
    at: T0 + seq,
  };
}

function toolResult(seq: number, toolCallId = "c1"): SurfaceEvent {
  return { seq, kind: "tool_result", surfaceOp: "append", toolCallId, content: "body", at: T0 + seq };
}

function rep(seq: number, sources: number[], over: Partial<SurfaceEvent> = {}): SurfaceEvent {
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

function ledgerLines(): number {
  try {
    return readFileSync(surfaceTracePath(root), "utf8").split("\n").filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

describe("append 落盘", () => {
  it("append 成功写一行", () => {
    const result = appendEvent(root, msg(1));
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_APPENDED"]);
    expect(ledgerLines()).toBe(1);
  });

  it("连续 3 条 append 落 3 行", () => {
    expect(appendEvent(root, msg(1)).ok).toBe(true);
    expect(appendEvent(root, toolCall(2)).ok).toBe(true);
    expect(appendEvent(root, toolResult(3)).ok).toBe(true);
    expect(ledgerLines()).toBe(3);
  });

  it("append seq 冲突被拒收且不写盘", () => {
    appendEvent(root, msg(1));
    const before = ledgerLines();
    const result = appendEvent(root, msg(1));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_INVALID");
    expect(ledgerLines()).toBe(before);
  });

  it("空文件时 version=0、transcript 为空", () => {
    expect(version(root)).toBe(0);
    expect(transcript(root).events).toEqual([]);
  });
});

describe("重放投影", () => {
  it("3 条 append 后重放得到同序事件流", () => {
    appendEvent(root, msg(1));
    appendEvent(root, toolCall(2));
    appendEvent(root, toolResult(3));
    const projection = loadSurfaceTrace(root);
    expect(projection.state.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(projection.parseErrors).toBe(0);
    expect(report(root).appendOrigin).toEqual([1, 2, 3]);
  });

  it("replace 成功后 shadowed 收进 source、contentGeneration 自增", () => {
    appendEvent(root, msg(1));
    appendEvent(root, toolCall(2));
    appendEvent(root, toolResult(3));
    const result = replaceEvent(root, rep(4, [1, 2]));
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual(["SURFACE_REPLACED"]);
    const built = report(root);
    expect(built.shadowed).toEqual([1, 2]);
    expect(built.contentGeneration).toBe(1);
    expect(version(root)).toBe(1);
  });

  it("replace 不删除原行:行数 = 事件数(含被 shadow 的)", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(2));
    replaceEvent(root, rep(3, [1, 2]));
    expect(ledgerLines()).toBe(3);
    expect(report(root).events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("transcript 收窄", () => {
  it("transcript 只留 append-origin(被 shadow 的 1,2 不出现)", () => {
    appendEvent(root, msg(1));
    appendEvent(root, toolCall(2));
    appendEvent(root, toolResult(3));
    replaceEvent(root, rep(4, [1, 2]));
    const built = transcript(root);
    expect(built.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(built.codes).toContain("SURFACE_TRANSCRIPT_BUILT");
  });
});

describe("契约拒收(不写盘)", () => {
  it("source 引用未来 seq → SURFACE_SOURCE_NOT_EARLIER,行数不变", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(2));
    const before = ledgerLines();
    const result = replaceEvent(root, rep(4, [1, 9]));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_NOT_EARLIER");
    expect(ledgerLines()).toBe(before);
  });

  it("source 重复 → SURFACE_SOURCE_DUPLICATE", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(2));
    const before = ledgerLines();
    const result = replaceEvent(root, rep(4, [1, 1]));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_DUPLICATE");
    expect(ledgerLines()).toBe(before);
  });

  it("source 缺失(不存在的更早 seq)→ SURFACE_SOURCE_MISSING", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(3));
    const before = ledgerLines();
    const result = replaceEvent(root, rep(4, [2]));
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SOURCE_MISSING");
    expect(ledgerLines()).toBe(before);
  });

  it("shadowedSeqs 未全覆盖 → SURFACE_SHADOW_INCOMPLETE", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(2));
    const before = ledgerLines();
    const result = replaceEvent(root, rep(3, [1]), { shadowedSeqs: [1, 2] });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_SHADOW_INCOMPLETE");
    expect(ledgerLines()).toBe(before);
  });

  it("tool_result replace 改 name → SURFACE_TOOL_FIELDS_MUTATED(单 source 自动带 oldEvent)", () => {
    appendEvent(root, toolCall(1));
    appendEvent(root, toolResult(2));
    const before = ledgerLines();
    const result = replaceEvent(root, {
      seq: 3,
      kind: "tool_result",
      surfaceOp: "replace",
      sourceEventSeqs: [2],
      toolCallId: "c1",
      content: "rewritten",
      name: "write_file",
      replaceGeneration: 0,
      at: T0 + 3,
    });
    expect(result.ok).toBe(false);
    expect(result.codes).toContain("SURFACE_TOOL_FIELDS_MUTATED");
    expect(ledgerLines()).toBe(before);
  });

  it("tool_result replace 只改 content 通过", () => {
    appendEvent(root, toolCall(1));
    appendEvent(root, toolResult(2));
    const result = replaceEvent(root, {
      seq: 3,
      kind: "tool_result",
      surfaceOp: "replace",
      sourceEventSeqs: [2],
      toolCallId: "c1",
      content: "rewritten",
      replaceGeneration: 0,
      at: T0 + 3,
    });
    expect(result.ok).toBe(true);
    expect(version(root)).toBe(1);
  });

  it("generation 过期 → SURFACE_GENERATION_STALE", () => {
    appendEvent(root, msg(1));
    appendEvent(root, msg(2));
    expect(replaceEvent(root, rep(3, [1, 2])).ok).toBe(true);
    const before = ledgerLines();
    const stale = replaceEvent(root, rep(4, [3], { replaceGeneration: 0 }));
    expect(stale.ok).toBe(false);
    expect(stale.codes).toContain("SURFACE_GENERATION_STALE");
    expect(ledgerLines()).toBe(before);
    expect(version(root)).toBe(1);
  });

  it("validateIncoming 只校验不写盘", () => {
    appendEvent(root, msg(1));
    const before = ledgerLines();
    expect(validateIncoming(root, msg(2)).ok).toBe(true);
    expect(ledgerLines()).toBe(before);
  });
});

describe("report 与 append-only", () => {
  it("report 检测到缺 result 的悬空配对", () => {
    appendEvent(root, msg(1));
    appendEvent(root, toolCall(2));
    const built = report(root);
    expect(built.broken.ok).toBe(false);
    expect(built.broken.issues.map((issue) => issue.code)).toContain("SURFACE_TOOL_CALL_UNPAIRED");
  });

  it("report 的派生缓存版本跟随 contentGeneration", () => {
    appendEvent(root, msg(1));
    replaceEvent(root, rep(2, [1]));
    const built = report(root);
    expect(built.derivedCacheVersion).toBe(built.contentGeneration);
    expect(built.derivedCacheVersion).toBe(1);
  });

  it("append-only:replace 不改写已有的原行", () => {
    appendEvent(root, msg(1));
    appendEvent(root, toolCall(2));
    appendEvent(root, toolResult(3));
    const before = readFileSync(surfaceTracePath(root), "utf8");
    replaceEvent(root, rep(4, [1, 2]));
    const after = readFileSync(surfaceTracePath(root), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.split("\n").filter((line) => line.trim() !== "").length).toBe(4);
  });
});
