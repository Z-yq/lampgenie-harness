/**
 * :投影缓存版本键与恢复 floor(纯函数层)。
 * 锁五条:
 * ① PROJECTION_STATE_VERSION 是整数版本键,判定缺省值就是它;
 * ② projectionFloorOf 取**最后一条** restoreFloor 事件的 floorSeq,非法/负数/缺省=0,越界 clamp 到本批 maxSeq;
 * ③ filterFromFloor 纯且不可变:floor<=0 原样返回**同引用**,floor>0 返回新数组;
 * ④ projectionCacheVerdict 四道判定的优先级与 reason 逐字(version → floor-changed → log-shrink → restore-floor → ok),
 * 字段缺失/非法一律保守 rebuild 且不 throw;
 * ⑤ 端到端夹具:10 条事件、第 6 条为 restoreFloor=第 7 条 seq——floor 之后的投影与「直接切后缀」逐字段一致。
 */
import { describe, it, expect } from "vitest";
import {
  PROJECTION_STATE_VERSION,
  PROJECTION_FLOOR_WHAT,
  projectionFloorOf,
  filterFromFloor,
  projectionCacheVerdict,
  projectSession,
  type ProjectionFloorEventLike,
} from "../src/session/projection.js";

/** 造一条普通事件(seq 显式给,模拟 journal 全局 seq)。 */
function ev(seq: number, kind: string, payload?: unknown): ProjectionFloorEventLike {
  return { kind, payload, seq };
}

/** 造一条 restoreFloor 事件。 */
function floorEv(seq: number, floorSeq: unknown): ProjectionFloorEventLike {
  return { kind: "custom", payload: { what: PROJECTION_FLOOR_WHAT, floorSeq }, seq };
}

/** 10 条事件夹具:第 6 条(下标 5)是 restoreFloor,指向第 7 条(seq=107)之后。 */
function fixture10(): ProjectionFloorEventLike[] {
  const out: ProjectionFloorEventLike[] = [];
  for (let i = 1; i <= 10; i++) {
    const seq = 100 + i;
    if (i === 6) out.push(floorEv(seq, 107));
    else out.push(ev(seq, "message.user", { text: `m${i}` }));
  }
  return out;
}

describe("① 版本键", () => {
  it("PROJECTION_STATE_VERSION 是整数常量且本次=2", () => {
    expect(Number.isInteger(PROJECTION_STATE_VERSION)).toBe(true);
    expect(PROJECTION_STATE_VERSION).toBe(2);
  });
});

describe("② projectionFloorOf", () => {
  it("无事件 → 0", () => {
    expect(projectionFloorOf([])).toBe(0);
  });

  it("无 restoreFloor 事件 → 0", () => {
    expect(projectionFloorOf([ev(1, "message.user"), ev(2, "message.agent")])).toBe(0);
  });

  it("单条 restoreFloor → floorSeq", () => {
    expect(projectionFloorOf([ev(105, "message.user"), floorEv(110, 107)])).toBe(107);
  });

  it("单条 restoreFloor 且 floorSeq 超过本批 maxSeq → clamp 到 maxSeq", () => {
 // floor 事件自己是本批最后一条(seq=106),floorSeq=107 越过前沿 → 钳到 106。
    expect(projectionFloorOf([ev(105, "message.user"), floorEv(106, 107)])).toBe(106);
  });

  it("多条 restoreFloor 取最后一条", () => {
    const events = [floorEv(3, 5), ev(4, "message.user"), floorEv(9, 8)];
    expect(projectionFloorOf(events)).toBe(8);
  });

  it("最后一条 floorSeq 非法时覆盖前面的合法值(最后一条说了算)", () => {
    const events = [floorEv(3, 5), floorEv(9, "nope")];
    expect(projectionFloorOf(events)).toBe(0);
  });

  it("what 不是 session.restoreFloor 的 custom 事件不算", () => {
    const events = [ev(5, "custom", { what: "media.budget", floorSeq: 7 })];
    expect(projectionFloorOf(events)).toBe(0);
  });

  it("非 custom kind 同 payload 不算", () => {
    const events = [ev(5, "message.user", { what: PROJECTION_FLOOR_WHAT, floorSeq: 3 })];
    expect(projectionFloorOf(events)).toBe(0);
  });

  it("floorSeq 缺失 → 0", () => {
    expect(projectionFloorOf([ev(5, "custom", { what: PROJECTION_FLOOR_WHAT })])).toBe(0);
  });

  it("floorSeq 字符串/对象 → 0", () => {
    expect(projectionFloorOf([floorEv(5, "9")])).toBe(0);
    expect(projectionFloorOf([floorEv(5, { n: 9 })])).toBe(0);
  });

  it("floorSeq 负数 → 0", () => {
    expect(projectionFloorOf([floorEv(5, -3)])).toBe(0);
  });

  it("floorSeq NaN/Infinity → 0", () => {
    expect(projectionFloorOf([floorEv(5, Number.NaN)])).toBe(0);
    expect(projectionFloorOf([floorEv(5, Number.POSITIVE_INFINITY)])).toBe(0);
  });

  it("floorSeq 越界 → clamp 到本批最大 seq", () => {
    expect(projectionFloorOf([ev(100, "message.user"), floorEv(101, 9999)])).toBe(101);
  });

  it("确定性:同输入两次结果相同", () => {
    const events = fixture10();
    expect(projectionFloorOf(events)).toBe(projectionFloorOf(events));
  });
});

describe("③ filterFromFloor", () => {
  it("floor=0 原样返回同一引用", () => {
    const events = [ev(1, "message.user"), ev(2, "message.agent")];
    expect(filterFromFloor(events, 0)).toBe(events);
  });

  it("floor 负数/NaN 也返回同一引用", () => {
    const events = [ev(1, "message.user")];
    expect(filterFromFloor(events, -5)).toBe(events);
    expect(filterFromFloor(events, Number.NaN)).toBe(events);
  });

  it("floor>0 只留 seq>=floor", () => {
    const events = [ev(1, "a"), ev(5, "b"), ev(7, "c"), ev(9, "d")];
    const out = filterFromFloor(events, 5);
    expect(out.map((e) => e.seq)).toEqual([5, 7, 9]);
  });

  it("floor 正好等于某条 seq 时保留该条(边界闭区间)", () => {
    expect(filterFromFloor([ev(7, "a"), ev(8, "b")], 7).map((e) => e.seq)).toEqual([7, 8]);
  });

  it("不可变:入参数组长度与内容不变,返回新引用", () => {
    const events = [ev(1, "a"), ev(5, "b")];
    const out = filterFromFloor(events, 3);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 5]);
    expect(out).not.toBe(events);
  });

  it("空数组 floor>0 → 空数组", () => {
    expect(filterFromFloor([], 3)).toEqual([]);
  });

  it("无 seq 字段的事件按 0 被过滤", () => {
    const events: { seq?: number; kind: string }[] = [{ kind: "x" }, { seq: 4, kind: "y" }];
    expect(filterFromFloor(events, 1).map((e) => e.kind)).toEqual(["y"]);
  });

  it("floor 远大于前沿 → 空数组", () => {
    expect(filterFromFloor([ev(1, "a"), ev(2, "b")], 999)).toEqual([]);
  });
});

describe("④ projectionCacheVerdict", () => {
 /** 可直接复用的「全绿」输入。 */
  const OK = {
    version: PROJECTION_STATE_VERSION,
    expectedVersion: PROJECTION_STATE_VERSION,
    floor: 5,
    prevFloor: 5,
    nextCount: 10,
    prevCount: 10,
    nextWatermark: 100,
    prevWatermark: 100,
  };

  it("全绿 → ok 且不重建", () => {
    expect(projectionCacheVerdict(OK)).toEqual({ rebuild: false, reason: "ok" });
  });

  it("版本不符 → rebuild version", () => {
    expect(projectionCacheVerdict({ ...OK, version: PROJECTION_STATE_VERSION - 1 })).toEqual({ rebuild: true, reason: "version" });
  });

  it("版本缺失 → rebuild version", () => {
    expect(projectionCacheVerdict({ ...OK, version: undefined })).toEqual({ rebuild: true, reason: "version" });
  });

  it("版本非整数(1.5/NaN)→ rebuild version", () => {
    expect(projectionCacheVerdict({ ...OK, version: 1.5 }).reason).toBe("version");
    expect(projectionCacheVerdict({ ...OK, version: Number.NaN }).reason).toBe("version");
  });

  it("floor 变化 → rebuild floor-changed", () => {
    expect(projectionCacheVerdict({ ...OK, floor: 6 })).toEqual({ rebuild: true, reason: "floor-changed" });
  });

  it("floor 缺失 → rebuild floor-changed", () => {
    expect(projectionCacheVerdict({ ...OK, floor: undefined }).reason).toBe("floor-changed");
    expect(projectionCacheVerdict({ ...OK, prevFloor: undefined }).reason).toBe("floor-changed");
  });

  it("事件数收缩(10→3)→ rebuild log-shrink", () => {
    expect(projectionCacheVerdict({ ...OK, prevCount: 10, nextCount: 3 })).toEqual({ rebuild: true, reason: "log-shrink" });
  });

  it("事件数增长(10→12)→ 仍是 ok(可增量)", () => {
    expect(projectionCacheVerdict({ ...OK, nextCount: 12 })).toEqual({ rebuild: false, reason: "ok" });
  });

  it("事件数缺失 → 保守 rebuild log-shrink", () => {
    expect(projectionCacheVerdict({ ...OK, nextCount: undefined }).reason).toBe("log-shrink");
    expect(projectionCacheVerdict({ ...OK, prevCount: undefined }).reason).toBe("log-shrink");
  });

  it("水位回退(100→40)→ rebuild restore-floor", () => {
    expect(projectionCacheVerdict({ ...OK, prevWatermark: 100, nextWatermark: 40 })).toEqual({ rebuild: true, reason: "restore-floor" });
  });

  it("水位前移(100→120)→ ok", () => {
    expect(projectionCacheVerdict({ ...OK, nextWatermark: 120 })).toEqual({ rebuild: false, reason: "ok" });
  });

  it("水位缺失 → 保守 rebuild restore-floor", () => {
    expect(projectionCacheVerdict({ ...OK, nextWatermark: undefined }).reason).toBe("restore-floor");
    expect(projectionCacheVerdict({ ...OK, prevWatermark: undefined }).reason).toBe("restore-floor");
  });

  it("全字段缺失 → 保守 rebuild(version)且不 throw", () => {
    expect(() => projectionCacheVerdict()).not.toThrow();
    expect(projectionCacheVerdict()).toEqual({ rebuild: true, reason: "version" });
    expect(projectionCacheVerdict({})).toEqual({ rebuild: true, reason: "version" });
  });

  it("优先级:版本坏 + floor 变 + 收缩同时成立 → 只报 version(先判先赢)", () => {
    const v = projectionCacheVerdict({ ...OK, version: 1, floor: 9, nextCount: 1 });
    expect(v).toEqual({ rebuild: true, reason: "version" });
  });

  it("expectedVersion 可注入(测试/灰度用)", () => {
    expect(projectionCacheVerdict({ ...OK, expectedVersion: 3 }).reason).toBe("version");
    expect(projectionCacheVerdict({ ...OK, version: 3, expectedVersion: 3 }).reason).toBe("ok");
  });

  it("确定性:同输入两次结果逐字段相同", () => {
    const input = { ...OK, prevWatermark: 100, nextWatermark: 40 };
    expect(projectionCacheVerdict(input)).toEqual(projectionCacheVerdict(input));
  });
});

describe("⑤ 端到端夹具:10 条事件 + 第 6 条 restoreFloor", () => {
  it("floor 指向第 7 条 seq,过滤后剩 4 条", () => {
    const events = fixture10();
    const floor = projectionFloorOf(events);
    expect(floor).toBe(107);
    const scoped = filterFromFloor(events, floor);
    expect(scoped).toHaveLength(4);
    expect(scoped[0]!.seq).toBe(107);
  });

  it("floor 过滤后的投影与「直接切后缀」逐字段一致(确定性)", () => {
    const events = fixture10();
    const floor = projectionFloorOf(events);
    const scoped = filterFromFloor(events as never, floor);
    const tail = events.slice(6); // 下标 6 = 第 7 条
    expect(projectSession(scoped as never)).toEqual(projectSession(tail as never));
 // 且两次投影逐字段相同(纯函数确定性)
    expect(projectSession(scoped as never)).toEqual(projectSession(scoped as never));
  });

  it("投影源只剩 floor 之后:rowCount=4;floor=0 时 rowCount=9(全历史)", () => {
    const events = fixture10();
    const scoped = filterFromFloor(events as never, projectionFloorOf(events));
    expect(projectSession(scoped as never).rowCount).toBe(4);
    const all = filterFromFloor(events as never, 0);
    expect(all).toBe(events);
    expect(projectSession(all as never).rowCount).toBe(9);
  });

  it("verdict 串起来:同一日志两次全量 → ok;恢复后事件数收缩 → log-shrink", () => {
    const events = fixture10();
    const floor = projectionFloorOf(events);
    const scoped = filterFromFloor(events, floor);
    const same = projectionCacheVerdict({
      version: PROJECTION_STATE_VERSION,
      floor,
      prevFloor: floor,
      nextCount: scoped.length,
      prevCount: scoped.length,
      nextWatermark: 110,
      prevWatermark: 110,
    });
    expect(same).toEqual({ rebuild: false, reason: "ok" });
    const shrunk = projectionCacheVerdict({
      version: PROJECTION_STATE_VERSION,
      floor,
      prevFloor: floor,
      nextCount: 3,
      prevCount: scoped.length,
      nextWatermark: 110,
      prevWatermark: 110,
    });
    expect(shrunk).toEqual({ rebuild: true, reason: "log-shrink" });
  });
});
