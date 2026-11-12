import { SERVER_SRC } from "./panel-source.js";
/**
 *  接线守卫:session.status 投影 memo 的版本键与恢复 floor。
 * 两层锁:
 * ① 静态接线(fail-closed):server.ts 必须真的用上 runtime 的四个新导出;memo 类型与写入必须带
 * version/eventCount/floor;增量侧 verdict 不通过时必须落回全量(if (!incrementalApplied));
 * 并且**不落** custom{what:"projection.cache"} 事件(避免噪音);
 * ② 纯逻辑:用 server 实际会传的输入形态跑 projectionCacheVerdict,锁四类 rebuild reason 与 ok。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROJECTION_STATE_VERSION,
  projectionCacheVerdict,
  projectionFloorOf,
  filterFromFloor,
} from "@lampgenie/runtime/session/projection";

const SERVER_PATH = SERVER_SRC;
const server = readFileSync(SERVER_PATH, "utf8");

/** memo 声明块(从 `const sessionStatusMemo = new Map<string, {` 到收尾 `}>;`)。 */
function memoTypeBlock(): string {
  const start = server.indexOf("const sessionStatusMemo = new Map<string, {");
  expect(start, "缺 sessionStatusMemo 声明").toBeGreaterThan(0);
  const end = server.indexOf("}>();", start);
  expect(end, "sessionStatusMemo 声明块未闭合").toBeGreaterThan(start);
  return server.slice(start, end);
}

/** session.status 分支正文(从 `case "session.status": {` 到下一个 `case `)。 */
function statusBranch(): string {
  const start = server.indexOf('case "session.status": {');
  expect(start, "缺 session.status 分支").toBeGreaterThan(0);
  const next = server.indexOf("\n    case ", start + 10);
  expect(next, "session.status 分支未闭合").toBeGreaterThan(start);
  return server.slice(start, next);
}

describe("① 静态接线:runtime 四导出都在 server.ts 用上", () => {
  it("动态 import 解构包含 PROJECTION_STATE_VERSION/projectionFloorOf/filterFromFloor/projectionCacheVerdict", () => {
    const start = server.indexOf('await import("@lampgenie/runtime/session/projection")');
    expect(start).toBeGreaterThan(0);
 // 同一行的解构(动态 import 只有这一处带这四个名字)
    const lineStart = server.lastIndexOf("\n", start);
    const line = server.slice(lineStart, server.indexOf("\n", start));
    for (const name of ["PROJECTION_STATE_VERSION", "projectionFloorOf", "filterFromFloor", "projectionCacheVerdict"]) {
      expect(line, `import 解构缺 ${name}`).toContain(name);
    }
  });

  it("全量路径:先算 floor 再 filterFromFloor 喂投影", () => {
    const branch = statusBranch();
    const floorAt = branch.indexOf("const floor = projectionFloorOf(sessionEvents);");
    const scopedAt = branch.indexOf("const scoped = filterFromFloor(sessionEvents, floor);");
    const projectAt = branch.indexOf("projectSession(scoped as never");
    expect(floorAt).toBeGreaterThan(0);
    expect(scopedAt).toBeGreaterThan(floorAt);
    expect(projectAt).toBeGreaterThan(scopedAt);
  });

  it("增量路径:批内 restoreFloor 事件决定 nextFloor,无事件沿用 memo.floor", () => {
    const branch = statusBranch();
    expect(branch).toContain('what === "session.restoreFloor"');
    expect(branch).toContain("const nextFloor = batchHasFloor ? projectionFloorOf(deltaEvents) : state.floor;");
  });

  it("增量路径:verdict 不重建才算 applied,否则落回全量", () => {
    const branch = statusBranch();
    expect(branch).toContain("if (verdict.rebuild) {");
    expect(branch).toContain("} else if (deltaEvents.length === 0) {");
    expect(branch).toContain("incrementalApplied = true;");
    expect(branch).toContain("if (!incrementalApplied) {");
  });

  it("增量 verdict 的空增量不推水位(避免 0<watermark 误判 restore 回退)", () => {
    expect(statusBranch()).toContain("nextWatermark: deltaEvents.length === 0 ? state.watermark : maxSeqOf(deltaEvents),");
  });
});

describe("② 静态接线:memo 三字段声明与写入", () => {
  it("memo 类型声明 version/eventCount/floor:number", () => {
    const block = memoTypeBlock();
    expect(block).toContain("version: number;");
    expect(block).toContain("eventCount: number;");
    expect(block).toContain("floor: number;");
  });

  it("全量重建写 memo:version=PROJECTION_STATE_VERSION / eventCount=scoped.length / floor", () => {
    const start = server.indexOf("sessionStatusMemo.set(msg.sessionId, {");
    expect(start).toBeGreaterThan(0);
    const end = server.indexOf("});", start);
    const block = server.slice(start, end);
    expect(block).toContain("version: PROJECTION_STATE_VERSION,");
    expect(block).toContain("eventCount: scoped.length,");
    expect(block).toContain("floor,");
    expect(block).toContain("watermark,");
  });

  it("增量 merge 后同步累加 eventCount 并回写 floor", () => {
    expect(server).toContain("state.eventCount += deltaEvents.length;");
    expect(server).toContain("state.floor = nextFloor;");
  });

  it("全量命中判据同时要求 verdict 不重建(不能只看 watermark+wfKey)", () => {
    expect(server).toContain("if (state && !verdict.rebuild && state.watermark === watermark && state.wfKey === wfKey) {");
  });

  it("不新增 projection.cache 落账(任务明确不要噪音)", () => {
    expect(server).not.toContain('"projection.cache"');
    expect(server).not.toContain("projection.cache");
  });
});

describe("③ 纯逻辑:server 实际传参形态的 verdict", () => {
 /** 复用 runtime 的「全绿」基线。 */
  const OK = {
    version: PROJECTION_STATE_VERSION,
    expectedVersion: PROJECTION_STATE_VERSION,
    floor: 107,
    prevFloor: 107,
    nextCount: 12,
    prevCount: 10,
    nextWatermark: 110,
    prevWatermark: 110,
  };

  it("正常增量(事件数涨、水位涨)→ ok", () => {
    expect(projectionCacheVerdict(OK)).toEqual({ rebuild: false, reason: "ok" });
  });

  it("升级前旧 memo(version 缺失)→ version", () => {
    expect(projectionCacheVerdict({ ...OK, version: undefined })).toEqual({ rebuild: true, reason: "version" });
  });

  it("新 restoreFloor 事件改变 floor → floor-changed", () => {
    expect(projectionCacheVerdict({ ...OK, floor: 200, prevFloor: 107 })).toEqual({ rebuild: true, reason: "floor-changed" });
  });

  it("prevCount=10 / nextCount=3 → log-shrink", () => {
    expect(projectionCacheVerdict({ ...OK, prevCount: 10, nextCount: 3 })).toEqual({ rebuild: true, reason: "log-shrink" });
  });

  it("prevWatermark=100 / nextWatermark=40 → restore-floor", () => {
    expect(projectionCacheVerdict({ ...OK, prevWatermark: 100, nextWatermark: 40 })).toEqual({ rebuild: true, reason: "restore-floor" });
  });

  it("增量空批(nextCount=prevCount,水位沿用)→ ok(稳态不高频重建)", () => {
    expect(projectionCacheVerdict({ ...OK, nextCount: 10, nextWatermark: 110 })).toEqual({ rebuild: false, reason: "ok" });
  });

  it("floor 事件夹具与 memo 计数口径一致:10 条事件 floor=107 后剩 4 条", () => {
    const events = [
      { seq: 101, kind: "message.user", payload: {} },
      { seq: 102, kind: "message.user", payload: {} },
      { seq: 103, kind: "message.user", payload: {} },
      { seq: 104, kind: "message.user", payload: {} },
      { seq: 105, kind: "message.user", payload: {} },
      { seq: 106, kind: "custom", payload: { what: "session.restoreFloor", floorSeq: 107 } },
      { seq: 107, kind: "message.user", payload: {} },
      { seq: 108, kind: "message.user", payload: {} },
      { seq: 109, kind: "message.user", payload: {} },
      { seq: 110, kind: "message.user", payload: {} },
    ];
    const floor = projectionFloorOf(events);
    expect(floor).toBe(107);
    expect(filterFromFloor(events, floor)).toHaveLength(4);
 // memo 写入 eventCount=scoped.length=4;下次同日志再来 → ok
    expect(
      projectionCacheVerdict({ ...OK, floor, prevFloor: floor, nextCount: 4, prevCount: 4, nextWatermark: 110 }),
    ).toEqual({ rebuild: false, reason: "ok" });
  });
});
