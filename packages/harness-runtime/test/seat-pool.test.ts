/**
 * SeatPool()单测:座位/FIFO/abort/容量/缩容/统计/确定性。
 * 时间与信号全部注入——不靠真实时钟,断言可复现。
 */
import { describe, it, expect } from "vitest";
import { SEAT_CODES, SeatError, SeatPool } from "../src/concurrency/seat-pool";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("码表", () => {
  it("SEAT_CODES 固定五码", () => {
    expect([...SEAT_CODES]).toEqual(["ACQUIRED", "PARKED", "ABORTED", "RELEASED", "INVALID"]);
  });

  it("SeatError 带 code", () => {
    const e = new SeatError("INVALID", "满");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("INVALID");
    expect(e.name).toBe("SeatError");
  });
});

describe("探针 A:容量内立即给座,第 3 个 PARKED,release 后队首获得", () => {
  it("capacity=2:前两个立即获得,第三个排队位次=1,release 唤醒它", async () => {
    let t = 1000;
    const pool = new SeatPool({ capacity: 2, now: () => t });
    const s1 = await pool.acquire("a");
    const s2 = await pool.acquire("b");
    expect(s1.seatId).not.toBe(s2.seatId);
    expect(pool.stats()).toEqual({ capacity: 2, inUse: 2, parked: 0, totalAcquired: 2, totalParked: 0 });

    const positions: number[] = [];
    const p3 = pool.acquire("c", { onParked: (p) => positions.push(p) });
    expect(positions).toEqual([1]);
    expect(pool.stats()).toMatchObject({ inUse: 2, parked: 1, totalParked: 1 });

    t = 1042; // 排队 42ms
    const rel = pool.release(s1.seatId);
    expect(rel.released).toBe(true);
    expect(rel.granted).toMatchObject({ ownerId: "c", queuedMs: 42 });
    const s3 = await p3;
    expect(s3).toMatchObject({ ownerId: "c", queuedMs: 42 });
    expect(pool.stats()).toMatchObject({ inUse: 2, parked: 0, totalAcquired: 3 });
  });

  it("座位 id 单调且唯一", async () => {
    const pool = new SeatPool({ capacity: 3 });
    const seats = await Promise.all([pool.acquire("a"), pool.acquire("b"), pool.acquire("c")]);
    expect(new Set(seats.map((s) => s.seatId)).size).toBe(3);
  });
});

describe("FIFO 与公平", () => {
  it("capacity=1 时按入队顺序唤醒", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const first = await pool.acquire("a");
    const order: string[] = [];
    const p2 = pool.acquire("b").then((s) => { order.push(s.ownerId); return s; });
    const p3 = pool.acquire("c").then((s) => { order.push(s.ownerId); return s; });
    const p4 = pool.acquire("d").then((s) => { order.push(s.ownerId); return s; });
    await sleep(0);
    expect(pool.stats().parked).toBe(3);

    pool.release(first.seatId);
    const s2 = await p2;
    expect(order).toEqual(["b"]);
    pool.release(s2.seatId);
    const s3 = await p3;
    expect(order).toEqual(["b", "c"]);
    pool.release(s3.seatId);
    await p4;
    expect(order).toEqual(["b", "c", "d"]);
  });

  it("同 owner 不插队(重复占有者照样排到队尾)", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const seen: string[] = [];
    const p1 = pool.acquire("a").then((s) => { seen.push("a1"); return s; });
    const p2 = pool.acquire("b").then((s) => { seen.push("b"); return s; });
    const p3 = pool.acquire("a").then((s) => { seen.push("a2"); return s; });
    let cur = seat;
    for (let i = 0; i < 3; i++) {
      pool.release(cur.seatId);
      cur = await [p1, p2, p3][i]!;
    }
    expect(seen).toEqual(["a1", "b", "a2"]);
  });
});

describe("探针 B:abort 排队者", () => {
  it("signal abort → ABORTED 且移出队列,release 唤醒的是后面的人", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const ac = new AbortController();
    const pAbort = pool.acquire("b", { signal: ac.signal });
    const pNext = pool.acquire("c");
    expect(pool.stats().parked).toBe(2);
    ac.abort();
    await expect(pAbort).rejects.toMatchObject({ code: "ABORTED" });
    expect(pool.stats().parked).toBe(1);
    pool.release(seat.seatId);
    const next = await pNext;
    expect(next.ownerId).toBe("c");
  });

  it("已中止的 signal 立即拒绝,不占座也不排队", async () => {
    const pool = new SeatPool({ capacity: 2 });
    const ac = new AbortController();
    ac.abort();
    await expect(pool.acquire("a", { signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(pool.stats()).toMatchObject({ inUse: 0, parked: 0, totalParked: 0 });
  });
});

describe("探针 C:队列满 → INVALID", () => {
  it("maxQueue=2 时第 3 个排队者拒收,既有排队不受影响", async () => {
    const pool = new SeatPool({ capacity: 1, maxQueue: 2 });
    const seat = await pool.acquire("a");
    const p1 = pool.acquire("b");
    const p2 = pool.acquire("c");
    await expect(pool.acquire("d")).rejects.toMatchObject({ code: "INVALID" });
    expect(pool.stats()).toMatchObject({ inUse: 1, parked: 2 });
    pool.release(seat.seatId);
    expect((await p1).ownerId).toBe("b");
    pool.release((await p1).seatId);
    await p2;
    expect(pool.stats().parked).toBe(0); // p2 已获座;它尚未归还不影响「排队数」
  });

  it("maxQueue=0:无座位的 acquire 一律 INVALID", async () => {
    const pool = new SeatPool({ capacity: 1, maxQueue: 0 });
    const seat = await pool.acquire("a");
    await expect(pool.acquire("b")).rejects.toMatchObject({ code: "INVALID" });
    pool.release(seat.seatId);
    expect(pool.stats().inUse).toBe(0);
  });
});

describe("release 幂等与不抛", () => {
  it("未知/重复 seatId → released:false,不抛也不影响在飞", async () => {
    const pool = new SeatPool({ capacity: 2 });
    const seat = await pool.acquire("a");
    expect(pool.release("nope")).toEqual({ released: false });
    expect(pool.release(seat.seatId)).toEqual({ released: true });
    expect(pool.release(seat.seatId)).toEqual({ released: false });
    expect(pool.stats()).toMatchObject({ inUse: 0, totalAcquired: 1 });
  });
});

describe("setCapacity", () => {
  it("缩容不打断在飞,只影响后续 acquire", async () => {
    const pool = new SeatPool({ capacity: 2 });
    const s1 = await pool.acquire("a");
    const s2 = await pool.acquire("b");
    pool.setCapacity(1);
    expect(pool.stats()).toMatchObject({ capacity: 1, inUse: 2 });
    pool.release(s1.seatId);
    expect(pool.stats()).toMatchObject({ inUse: 1, parked: 0 }); // 缩容后不放新座
    const p3 = pool.acquire("c");
    await sleep(0);
    expect(pool.stats().parked).toBe(1);
    pool.release(s2.seatId);
    expect((await p3).ownerId).toBe("c");
  });

  it("扩容不主动追发座位(Promise 只由 release/abort 落定)", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const parked = pool.acquire("b");
    pool.setCapacity(3);
    await sleep(0);
    expect(pool.stats()).toMatchObject({ capacity: 3, inUse: 1, parked: 1 });
 // 队列非空时新来者仍要排队(不能插到已在等的人前面)
    const later = pool.acquire("c");
    await sleep(0);
    expect(pool.stats().parked).toBe(2);
    pool.release(seat.seatId);
    expect((await parked).ownerId).toBe("b");
    expect(pool.stats()).toMatchObject({ inUse: 2, parked: 0 }); // 扩容后一次释放补满两座
    const c = await later;
    expect(c.ownerId).toBe("c");
  });
});

describe("abortAll", () => {
  it("拒绝全部排队者,此后 acquire 一律 ABORTED,在飞照常 release", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const p1 = pool.acquire("b");
    const p2 = pool.acquire("c");
    pool.abortAll("fatal");
    await expect(p1).rejects.toMatchObject({ code: "ABORTED" });
    await expect(p2).rejects.toMatchObject({ code: "ABORTED" });
    expect(pool.stats()).toMatchObject({ inUse: 1, parked: 0 });
    await expect(pool.acquire("d")).rejects.toMatchObject({ code: "ABORTED" });
    expect(pool.release(seat.seatId).released).toBe(true);
    expect(pool.stats().inUse).toBe(0);
  });

  it("重复 abortAll 保留首次原因,未结算的排队者只被拒一次", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const p = pool.acquire("b");
    pool.abortAll("fatal");
    pool.abortAll("run-ended");
    await expect(p).rejects.toMatchObject({ code: "ABORTED", message: expect.stringContaining("fatal") });
    expect(pool.release(seat.seatId).released).toBe(true);
  });
});

describe("统计与确定性", () => {
  it("totalParked 计入已 abort 的排队者,totalAcquired 只计真正发座", async () => {
    const pool = new SeatPool({ capacity: 1 });
    const seat = await pool.acquire("a");
    const ac = new AbortController();
    const p = pool.acquire("b", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    expect(pool.stats()).toEqual({ capacity: 1, inUse: 1, parked: 0, totalAcquired: 1, totalParked: 1 });
    pool.release(seat.seatId);
  });

  it("非正/非有限容量归一到 1", async () => {
    const a = new SeatPool({ capacity: 0 });
    expect(a.stats().capacity).toBe(1);
    const b = new SeatPool({ capacity: Number.NaN });
    expect(b.stats().capacity).toBe(1);
    const c = new SeatPool({ capacity: 2.9 });
    expect(c.stats().capacity).toBe(2);
  });
});
