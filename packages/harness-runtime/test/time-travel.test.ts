/**
 * 时间旅行纯逻辑单测:计划/边界/恢复/删除/fork/remap/守卫/越界/确定性/不 throw。
 * 全部输入构造,零 IO。
 */
import { describe, it, expect } from "vitest";
import {
  snapshotPlan,
  normalizeSnapshotPath,
  boundaryOfStep,
  rewindPlan,
  forkPlan,
  rewindGuard,
  truncatePlan,
  TRUNCATABLE_MESSAGE_KINDS,
  SNAPSHOT_MAX_FILES,
  type SnapshotFile,
  type TimeTravelEvent,
} from "../src/agent/time-travel.js";

const ROOT = "/tmp/m117-root";

function ev(seq: number, kind: string, payload: Record<string, unknown> = {}, sessionId = "s1"): TimeTravelEvent {
  return { seq, kind, sessionId, payload };
}

describe("snapshotPlan(路径归一/上限/分类/纯函数)", () => {
  it("相对与绝对路径都归一为 root 内 posix 相对路径,重复项去重", () => {
    const r = snapshotPlan({
      paths: ["a.ts", "/tmp/m117-root/dir/b.ts", "a.ts", "./dir/../c.md"],
      root: ROOT,
    });
    expect(r.ok).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "dir/b.ts", "c.md"]);
    expect(r.skipped).toEqual([]);
  });

  it("越界路径(../ 与绝对外部路径)进 skipped,不进 files", () => {
    const r = snapshotPlan({ paths: ["../escape.ts", "/etc/passwd", ""], root: ROOT });
    expect(r.files).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["outside-root", "outside-root", "outside-root"]);
  });

  it("超过 maxFiles 的候选标 max-files", () => {
    const paths = Array.from({ length: SNAPSHOT_MAX_FILES + 2 }, (_, i) => `f${i}.ts`);
    const r = snapshotPlan({ paths, root: ROOT });
    expect(r.files).toHaveLength(SNAPSHOT_MAX_FILES);
    expect(r.skipped.filter((s) => s.reason === "max-files")).toHaveLength(2);
  });

  it("二进制扩展名允许快照但标 binary,文本不标", () => {
    const r = snapshotPlan({ paths: ["img/logo.png", "src/x.ts"], root: ROOT });
    expect(r.files.find((f) => f.path === "img/logo.png")?.binary).toBe(true);
    expect(r.files.find((f) => f.path === "src/x.ts")?.binary).toBeUndefined();
  });

  it("给了 sizes 时执行单文件/总字节上限", () => {
    const r = snapshotPlan({
      paths: ["big.bin", "a.bin", "b.bin"],
      root: ROOT,
      maxFileBytes: 10,
      maxTotalBytes: 15,
      sizes: { "big.bin": 11, "a.bin": 10, "b.bin": 6 },
    });
    expect(r.files.map((f) => f.path)).toEqual(["a.bin"]);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["too-large", "total-budget"]);
  });

  it("确定性:同输入两次结果逐字相同", () => {
    const input = { paths: ["a.ts", "b/c.ts", "../x"], root: ROOT };
    expect(JSON.stringify(snapshotPlan(input))).toBe(JSON.stringify(snapshotPlan(input)));
  });

  it("normalizeSnapshotPath 拒绝 root 自身与空串", () => {
    expect(normalizeSnapshotPath(ROOT, "")).toBeNull();
    expect(normalizeSnapshotPath(ROOT, "/tmp/m117-root")).toBeNull();
    expect(normalizeSnapshotPath(ROOT, "a/b.ts")).toEqual({ rel: "a/b.ts", abs: "/tmp/m117-root/a/b.ts" });
  });
});

describe("boundaryOfStep(step.start + 之后首条 message.agent)", () => {
  const events: TimeTravelEvent[] = [
    ev(1, "step.start", { turn: 1, step: 1 }),
    ev(2, "message.agent", { text: "a" }),
    ev(3, "step.start", { turn: 1, step: 2 }),
    ev(4, "message.agent", { text: "b" }),
    ev(5, "message.user", { text: "u" }),
  ];

  it("按 t1s2 精确命中 step.start 与其后首条 assistant 消息 seq", () => {
    expect(boundaryOfStep(events, "s1", { stepId: "t1s2" })).toEqual({ turn: 1, step: 2, seq: 3, assistantSeq: 4 });
  });

  it("stepId 不存在返回 null", () => {
    expect(boundaryOfStep(events, "s1", { stepId: "t9s9" })).toBeNull();
  });

  it("stepId 格式非法返回 null", () => {
    expect(boundaryOfStep(events, "s1", { stepId: "step-3" })).toBeNull();
  });

  it("无 stepId 取最后一个有 assistant 跟随的边界", () => {
    expect(boundaryOfStep(events, "s1")).toEqual({ turn: 1, step: 2, seq: 3, assistantSeq: 4 });
  });

  it("只有 step.start 没有 message.agent 的步不算边界", () => {
    const tail: TimeTravelEvent[] = [...events, ev(6, "step.start", { turn: 1, step: 3 })];
    expect(boundaryOfStep(tail, "s1")).toEqual({ turn: 1, step: 2, seq: 3, assistantSeq: 4 });
  });

  it("事件为空/会话不匹配返回 null,不 throw", () => {
    expect(boundaryOfStep([], "s1")).toBeNull();
    expect(boundaryOfStep(events, "other")).toBeNull();
  });
});

describe("rewindPlan(恢复/删除/缺 blob)", () => {
  const files: SnapshotFile[] = [
    { path: "a.ts", existed: true, sha: "s1" },
    { path: "created.ts", existed: false },
    { path: "lost.ts", existed: true },
  ];

  it("existed=true→restore,existed=false 且现在存在→delete,缺 sha→missing", () => {
    const r = rewindPlan({ snapshot: { files }, dirExists: () => true });
    expect(r.restore.map((f) => f.path)).toEqual(["a.ts"]);
    expect(r.delete).toEqual(["created.ts"]);
    expect(r.missingBlobs).toEqual(["lost.ts"]);
  });

  it("existed=false 但当前不存在 → 不删", () => {
    const r = rewindPlan({ snapshot: { files }, dirExists: () => false });
    expect(r.delete).toEqual([]);
  });

  it("入参可以是 files 数组本身,且不修改输入", () => {
    const frozen = JSON.stringify(files);
    const r = rewindPlan({ snapshot: files });
    expect(r.restore).toHaveLength(1);
    expect(JSON.stringify(files)).toBe(frozen);
  });

  it("空/异常输入返回空计划,不 throw", () => {
    expect(rewindPlan({ snapshot: null })).toEqual({ restore: [], delete: [], missingBlobs: [] });
    expect(rewindPlan({ snapshot: { files: [null as never, { path: "" } as never] } })).toEqual({ restore: [], delete: [], missingBlobs: [] });
  });
});

describe("forkPlan(截断/压缩 remap)", () => {
  const events: TimeTravelEvent[] = [
    ev(1, "message.user", { text: "u1" }),
    ev(2, "compact.done", { tail: ["m1", "m2"] }),
    ev(3, "message.agent", { text: "a1" }),
    ev(4, "message.user", { text: "u2" }),
    ev(5, "compact.done", { tail: ["m3", "m4", "m5"] }),
    ev(6, "message.agent", { text: "a2" }),
    ev(7, "message.user", { text: "u3" }, "s2"),
  ];

  it("只保留 seq<=atSeq 的本会话事件,统计 dropped", () => {
    const r = forkPlan(events, "s1", { atSeq: 4 });
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(r.dropped).toBe(2);
    expect(r.compactionRemap.keptCompactSeqs).toEqual([2]);
  });

  it("seq>atSeq 的 compact.done 被丢弃,tail 长度计入 droppedTailMessages", () => {
    const r = forkPlan(events, "s1", { atSeq: 4 });
    expect(r.compactionRemap.droppedTailMessages).toBe(3);
  });

  it("切在压缩边界前:该边界保留,tail 不丢", () => {
    const r = forkPlan(events, "s1", { atSeq: 2 });
    expect(r.compactionRemap.keptCompactSeqs).toEqual([2]);
    expect(r.compactionRemap.droppedTailMessages).toBe(3);
  });

  it("只算目标会话,别会话事件不进结果也不进 dropped", () => {
    const r = forkPlan(events, "s1", { atSeq: 100 });
    expect(r.events.every((e) => e.sessionId === "s1")).toBe(true);
    expect(r.events).toHaveLength(6);
    expect(r.dropped).toBe(0);
  });

  it("不修改输入事件数组与对象", () => {
    const before = JSON.stringify(events);
    forkPlan(events, "s1", { atSeq: 3 });
    expect(JSON.stringify(events)).toBe(before);
  });

  it("异常输入返回空计划,不 throw", () => {
    expect(forkPlan(undefined, "s1", { atSeq: 1 })).toEqual({
      events: [], dropped: 0, compactionRemap: { keptCompactSeqs: [], droppedTailMessages: 0 },
    });
    expect(forkPlan(events, "s1", { atSeq: Number.NaN }).events).toHaveLength(6);
  });
});

describe("rewindGuard(后台未收敛拒绝)", () => {
  it("无后台任务 → OK", () => {
    expect(rewindGuard({ activeSubagents: 0, workflowRunning: false })).toEqual({ ok: true, code: "OK" });
    expect(rewindGuard(undefined)).toEqual({ ok: true, code: "OK" });
  });

  it("activeSubagents>0 → BACKGROUND_BUSY", () => {
    expect(rewindGuard({ activeSubagents: 2 })).toEqual({ ok: false, code: "BACKGROUND_BUSY" });
  });

  it("workflowRunning → BACKGROUND_BUSY", () => {
    expect(rewindGuard({ activeSubagents: 0, workflowRunning: true })).toEqual({ ok: false, code: "BACKGROUND_BUSY" });
  });

  it("异常数值不误报忙(NaN 视为 0)", () => {
    expect(rewindGuard({ activeSubagents: Number.NaN }).ok).toBe(true);
  });
});

describe("truncatePlan(只删对话:边界判定/右端点/确定性)", () => {
 /** 典型会话流:1 turn.start,2 user,3 agent,4 tool.call,5 tool.result,6 agent,7 turn.start */
  const stream = (): TimeTravelEvent[] => [
    ev(1, "turn.start", { turn: 1 }),
    ev(2, "message.user", { text: "u1" }),
    ev(3, "message.agent", { text: "a1" }),
    ev(4, "tool.call", { id: "c1" }),
    ev(5, "tool.result", { id: "c1" }),
    ev(6, "message.agent", { text: "a2" }),
    ev(7, "turn.start", { turn: 2 }),
  ];

  it("消息类 kind 集合与 derive 口径一致(6 类)", () => {
    expect([...TRUNCATABLE_MESSAGE_KINDS].sort()).toEqual([
      "compact.done", "message.agent", "message.system", "message.user", "tool.call", "tool.result",
    ]);
  });

  it("INVALID:boundarySeq 为 0 / 负数 / 非有限 / 非整数", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 2.5]) {
      expect(truncatePlan(stream(), { boundarySeq: bad })).toEqual({ ok: false, boundarySeq: bad, code: "INVALID" });
    }
  });

  it("INVALID:boundarySeq 超过全流最大 seq", () => {
    expect(truncatePlan(stream(), { boundarySeq: 8 })).toEqual({ ok: false, boundarySeq: 8, code: "INVALID" });
  });

  it("INVALID:空事件流(任何正 boundary 都算超界)", () => {
    expect(truncatePlan([], { boundarySeq: 1 })).toEqual({ ok: false, boundarySeq: 1, code: "INVALID" });
  });

  it("INVALID:events 非数组(含 undefined/字符串)/ 含脏条目,不 throw", () => {
    expect(truncatePlan(undefined, { boundarySeq: 2 }).code).toBe("INVALID");
    expect(truncatePlan("nope" as unknown as TimeTravelEvent[], { boundarySeq: 2 }).code).toBe("INVALID");
    expect(() => truncatePlan([null as unknown as TimeTravelEvent, ev(1, "message.user")], { boundarySeq: 1 })).not.toThrow();
  });

  it("NO_BOUNDARY:没有消息类事件(只有观测事件)", () => {
    const only = [ev(1, "turn.start", { turn: 1 }), ev(2, "step.start", { turn: 1, step: 1 }), ev(3, "custom", { type: "x" })];
    expect(truncatePlan(only, { boundarySeq: 1 })).toEqual({ ok: false, boundarySeq: 1, code: "NO_BOUNDARY" });
    expect(truncatePlan(only, { boundarySeq: 3 })).toEqual({ ok: false, boundarySeq: 3, code: "NO_BOUNDARY" });
  });

  it("NO_BOUNDARY:boundary 等于最后一条消息 seq", () => {
    expect(truncatePlan(stream(), { boundarySeq: 6 })).toEqual({ ok: false, boundarySeq: 6, code: "NO_BOUNDARY" });
  });

  it("NO_BOUNDARY:boundary 大于最后一条消息 seq(但没超过全流最大 seq)", () => {
 // 末条消息 seq=6,尾部还有 seq=7 的 turn.start
    expect(truncatePlan(stream(), { boundarySeq: 7 })).toEqual({ ok: false, boundarySeq: 7, code: "NO_BOUNDARY" });
  });

  it("OK:truncateSeq=全流最大 seq(右端点覆盖到当前末条事件)", () => {
    expect(truncatePlan(stream(), { boundarySeq: 2 })).toEqual({ ok: true, boundarySeq: 2, truncateSeq: 7, code: "OK" });
    expect(truncatePlan(stream(), { boundarySeq: 5 })).toEqual({ ok: true, boundarySeq: 5, truncateSeq: 7, code: "OK" });
  });

  it("跨 session 消息也算:lastMsgSeq 取全流最大,不限会话", () => {
    const mixed = [ev(1, "message.user", {}, "s1"), ev(2, "message.agent", {}, "s2"), ev(3, "message.user", {}, "s1")];
    expect(truncatePlan(mixed, { boundarySeq: 1 })).toEqual({ ok: true, boundarySeq: 1, truncateSeq: 3, code: "OK" });
  });

  it("确定性:同一输入两次调用深等于", () => {
    const events = stream();
    expect(truncatePlan(events, { boundarySeq: 3 })).toEqual(truncatePlan(events, { boundarySeq: 3 }));
    expect(truncatePlan(events, { boundarySeq: 3 })).not.toBe(truncatePlan(events, { boundarySeq: 3 }));
  });

  it("不改入参(不可变)", () => {
    const events = stream();
    const before = JSON.stringify(events);
    truncatePlan(events, { boundarySeq: 2 });
    expect(JSON.stringify(events)).toBe(before);
  });
});
