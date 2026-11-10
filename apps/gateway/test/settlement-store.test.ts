import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSettlementEvent,
  awaitAll,
  drain,
  fork,
  race,
  readSettlementEvents,
  report,
  settlementPath,
  settlementReport,
} from "../src/settlement-store";

/** 全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。 */
const tempDirs: string[] = [];

function tmpRoot(tag = "settlement"): string {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`));
  tempDirs.push(dir);
  return dir;
}

function rawLines(root: string): string[] {
  return readFileSync(settlementPath(root), "utf8").split("\n").filter((line) => line.trim() !== "");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("settlement-store: 路径与参数", () => {
  it("settlementPath 落在 <root>/.genie/rsi/settlement.jsonl", () => {
    const root = tmpRoot();
    expect(settlementPath(root)).toBe(join(root, ".genie", "rsi", "settlement.jsonl"));
  });

  it("root 不是非空字符串 → TypeError(参数错误才 throw)", () => {
    expect(() => settlementPath("")).toThrow(TypeError);
    expect(() => readSettlementEvents(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe("settlement-store: 空态与写入", () => {
  it("文件不存在 → 空结果、零错误(不是失败)", () => {
    const root = tmpRoot();
    expect(readSettlementEvents(root)).toEqual({ events: [], badLines: [], parseErrors: 0 });
  });

  it("append 建目录 + 写后行数 +1 + 事件形状 v=1", () => {
    const root = tmpRoot();
    expect(appendSettlementEvent(root, { kind: "fork", at: 1000, payload: { index: 0 } })).toBe(true);
    expect(appendSettlementEvent(root, { kind: "drain", at: 1001 })).toBe(true);
    const lines = rawLines(root);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(first.v).toBe(1);
    expect(first.kind).toBe("fork");
    expect(first.at).toBe(1000);
    expect(first.payload).toEqual({ index: 0 });
  });

  it("taskId 写入事件的 taskId 字段(无则不出现该键)", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "await", taskId: "task-a", at: 5 });
    appendSettlementEvent(root, { kind: "drain", at: 6 });
    const { events } = readSettlementEvents(root);
    expect(events[0]?.taskId).toBe("task-a");
    expect(Object.prototype.hasOwnProperty.call(events[1] as object, "taskId")).toBe(false);
  });

  it("非法 kind → false 且不写盘", () => {
    const root = tmpRoot();
    expect(appendSettlementEvent(root, { kind: "nope" as never })).toBe(false);
    expect(readSettlementEvents(root).events).toHaveLength(0);
  });

  it("写不进去(父路径被文件占位)→ false,不 throw", () => {
    const root = tmpRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".genie"), "not-a-dir", "utf8");
    expect(() => appendSettlementEvent(root, { kind: "report" })).not.toThrow();
    expect(appendSettlementEvent(root, { kind: "report" })).toBe(false);
  });
});

describe("settlement-store: 坏行容错", () => {
  it("JSON 坏行:跳过并记 1-based 行号,其余事件照读", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "fork", taskId: "a", at: 1 });
    const path = settlementPath(root);
    writeFileSync(path, `${readFileSync(path, "utf8")}{oops not json\n`, "utf8");
    appendSettlementEvent(root, { kind: "drain", at: 2 });
    const read = readSettlementEvents(root);
    expect(read.events.map((e) => e.kind)).toEqual(["fork", "drain"]);
    expect(read.badLines).toEqual([2]);
    expect(read.parseErrors).toBe(1);
  });

  it("v !== 1 的形状坏行:计入 badLines,但不计 parseErrors", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "fork", at: 1 });
    const path = settlementPath(root);
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}${JSON.stringify({ v: 2, at: 9, kind: "fork", payload: {} })}\n`,
      "utf8",
    );
    const read = readSettlementEvents(root);
    expect(read.events).toHaveLength(1);
    expect(read.badLines).toEqual([2]);
    expect(read.parseErrors).toBe(0);
  });
});

describe("settlement-store: 包装函数落盘", () => {
  it("fork(handles) 落 fork 事件;同 id 重复 fork 幂等跳过", async () => {
    const root = tmpRoot();
    const tasks = [
      { id: "t1", run: () => 1 },
      { id: "t2", run: () => 2 },
    ];
    const first = await fork(root, tasks);
    expect(first.forked).toEqual(["t1", "t2"]);
    const again = await fork(root, first.handles);
    expect(again.forked).toEqual([]);
    expect(again.skipped).toEqual(["t1", "t2"]);
    const forkEvents = readSettlementEvents(root).events.filter((e) => e.kind === "fork");
    expect(forkEvents.map((e) => e.taskId)).toEqual(["t1", "t2"]);
    await first.drain();
  });

  it("awaitAll 落 await 事件,失败任务计入 failures", async () => {
    const root = tmpRoot();
    const { handles, drain: drainAll } = await fork(root, [
      { id: "ok", run: () => "v" },
      {
        id: "bad",
        run: () => Promise.reject(new Error("boom")),
      },
    ]);
    const result = await awaitAll(root, handles);
    expect(result.results.map((r) => r.ok)).toEqual([true, false]);
    expect(result.failures).toBe(1);
    const awaitEvents = readSettlementEvents(root).events.filter((e) => e.kind === "await");
    expect(awaitEvents.map((e) => e.taskId)).toEqual(["ok", "bad"]);
    expect(awaitEvents[0]?.payload.ok).toBe(true);
    expect(awaitEvents[1]?.payload.ok).toBe(false);
    await drainAll();
  });

  it("drain 落 drain 事件,诊断数与 runtime log 一致", async () => {
    const root = tmpRoot();
    const { handles } = await fork(root, [
      { id: "kept", run: () => 1 },
      {
        id: "rejected",
        run: () => Promise.reject(new Error("unobserved")),
      },
    ]);
    const log = await drain(root, handles);
    const drainEvent = readSettlementEvents(root).events.find((e) => e.kind === "drain");
    expect(drainEvent).toBeDefined();
    expect(drainEvent?.payload.handles).toBe(2);
    expect(drainEvent?.payload.diagnostics).toBe(log.diagnostics.length);
    expect((drainEvent?.payload.states as Record<string, string>).rejected).toBe("rejected");
    expect(settlementReport(root).diagnostics).toBe(log.diagnostics.length);
  });

  it("race 落 race 事件:winner 唯一、败者进 aborted", async () => {
    const root = tmpRoot();
    const { handles } = await fork(root, [
      { id: "fast", run: () => "fast" },
      {
        id: "slow",
        run: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve("slow"), 50);
          }),
      },
    ]);
    const result = await race(root, handles);
    expect(result.winner.id).toBe("fast");
    const raceEvent = readSettlementEvents(root).events.find((e) => e.kind === "race");
    expect(raceEvent?.taskId).toBe("fast");
    expect(raceEvent?.payload.winner).toBe("fast");
    expect(raceEvent?.payload.aborted).toEqual(expect.arrayContaining(["slow"]));
    await drain(root, handles);
  });

  it("report 落 report 事件并返回聚合(total / byKind / diagnostics)", async () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "fork", taskId: "a", at: 1 });
    appendSettlementEvent(root, { kind: "drain", at: 2, payload: { diagnostics: 2 } });
    const aggregate = await report(root);
    expect(aggregate.total).toBe(2);
    expect(aggregate.byKind.fork).toBe(1);
    expect(aggregate.byKind.drain).toBe(1);
    expect(aggregate.byKind.race).toBe(0);
    expect(aggregate.diagnostics).toBe(2);
    expect(readSettlementEvents(root).events.filter((e) => e.kind === "report")).toHaveLength(1);
  });
});

describe("settlement-store: 聚合与取样", () => {
  it("空 root 的 report:全 0、recent 空、无错误", () => {
    const root = tmpRoot();
    const aggregate = settlementReport(root);
    expect(aggregate.total).toBe(0);
    expect(aggregate.diagnostics).toBe(0);
    expect(aggregate.recent).toEqual([]);
    expect(aggregate.badLines).toEqual([]);
    expect(aggregate.parseErrors).toBe(0);
    expect(Object.values(aggregate.byKind).every((n) => n === 0)).toBe(true);
  });

  it("recent 按 at 升序取最近 limit 条(乱序写入也成立)", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "fork", at: 30 });
    appendSettlementEvent(root, { kind: "await", at: 10 });
    appendSettlementEvent(root, { kind: "drain", at: 20 });
    const aggregate = settlementReport(root, { limit: 2 });
    expect(aggregate.total).toBe(3);
    expect(aggregate.recent.map((e) => e.at)).toEqual([20, 30]);
    const all = settlementReport(root).recent.map((e) => e.at);
    expect(all).toEqual([10, 20, 30]);
  });

  it("diagnostics 汇总各事件 payload.diagnostics(数字或数组)", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "drain", at: 1, payload: { diagnostics: 1 } });
    appendSettlementEvent(root, { kind: "race", at: 2, payload: { diagnostics: [{ handleId: "x" }] } });
    appendSettlementEvent(root, { kind: "fork", at: 3, payload: { index: 0 } });
    expect(settlementReport(root).diagnostics).toBe(2);
  });

  it("坏行不影响聚合:total 只数有效事件", () => {
    const root = tmpRoot();
    appendSettlementEvent(root, { kind: "fork", at: 1 });
    const path = settlementPath(root);
    writeFileSync(path, `${readFileSync(path, "utf8")}}garbage\n`, "utf8");
    const aggregate = settlementReport(root);
    expect(aggregate.total).toBe(1);
    expect(aggregate.badLines).toEqual([2]);
    expect(aggregate.parseErrors).toBe(1);
  });
});
