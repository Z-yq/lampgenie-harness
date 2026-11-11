import { describe, it, expect } from "vitest";
import {
  RUN_GUARD_CODES,
  FATAL_CODES,
  RunGuard,
  WorkflowRunError,
  isFatalWorkflowError,
  settleOrder,
} from "../src/run-guard";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("码表与错误类型", () => {
  it("RUN_GUARD_CODES 固定五码且 OK 为首", () => {
    expect([...RUN_GUARD_CODES]).toEqual(["OK", "CONCURRENCY_EXCEEDED", "TOTAL_EXCEEDED", "FATAL", "ABORTED"]);
  });
  it("WorkflowRunError 携带 code/fatal,缺省非 fatal", () => {
    const e = new WorkflowRunError("TOTAL_EXCEEDED", "爆预算", { fatal: true });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("WorkflowRunError");
    expect(e.code).toBe("TOTAL_EXCEEDED");
    expect(e.fatal).toBe(true);
    expect(new WorkflowRunError("ABORTED", "x").fatal).toBe(false);
  });
});

describe("并发闸 acquire/release", () => {
  it("容量内立即给 release,inFlight 同步增长", async () => {
    const g = new RunGuard({ maxConcurrent: 2, maxTotal: 10 });
    const r1 = await g.acquire();
    expect(g.stats()).toMatchObject({ inFlight: 1, queued: 0 });
    const r2 = await g.acquire();
    expect(g.stats()).toMatchObject({ inFlight: 2, queued: 0 });
    r1();
    expect(g.stats().inFlight).toBe(1);
    r2();
    expect(g.stats().inFlight).toBe(0);
  });

  it("超容量排队,FIFO 唤醒队首", async () => {
    const g = new RunGuard({ maxConcurrent: 1 });
    const order: number[] = [];
    const rel1 = await g.acquire();
    const p2 = g.acquire().then((rel) => { order.push(2); return rel; });
    const p3 = g.acquire().then((rel) => { order.push(3); return rel; });
    await sleep(0);
    expect(g.stats()).toMatchObject({ inFlight: 1, queued: 2 });
    rel1();
    const rel2 = await p2;
    await sleep(0);
    expect(order).toEqual([2]);
    expect(g.stats()).toMatchObject({ inFlight: 1, queued: 1 });
    rel2();
    const rel3 = await p3;
    expect(order).toEqual([2, 3]);
    rel3();
    expect(g.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it("峰值并发不超过 maxConcurrent(5 任务)", async () => {
    const g = new RunGuard({ maxConcurrent: 2 });
    let cur = 0;
    let peak = 0;
    const task = async () => {
      const release = await g.acquire();
      cur++;
      peak = Math.max(peak, cur);
      await sleep(5);
      cur--;
      release();
    };
    await Promise.all(Array.from({ length: 5 }, () => task()));
    expect(peak).toBe(2);
    expect(g.stats()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it("release 幂等:重复调用不会多放槽", async () => {
    const g = new RunGuard({ maxConcurrent: 1 });
    const rel1 = await g.acquire();
    const p2 = g.acquire();
    rel1();
    rel1(); // 重复 release 必须无效,否则后续会并发 2
    const rel2 = await p2;
    expect(g.stats()).toMatchObject({ inFlight: 1, queued: 0 });
    rel2();
    expect(g.stats().inFlight).toBe(0);
  });

  it("排队中 signal abort → ABORTED 且移出队列", async () => {
    const g = new RunGuard({ maxConcurrent: 1 });
    const rel = await g.acquire();
    const ac = new AbortController();
    const p = g.acquire({ signal: ac.signal });
    expect(g.stats().queued).toBe(1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    expect(g.stats()).toMatchObject({ queued: 0, inFlight: 1 });
    rel();
  });

  it("signal 已中止时 acquire 立即拒,不占并发槽", async () => {
    const g = new RunGuard({ maxConcurrent: 2 });
    const ac = new AbortController();
    ac.abort();
    await expect(g.acquire({ signal: ac.signal })).rejects.toMatchObject({ code: "ABORTED" });
    expect(g.stats().inFlight).toBe(0);
    expect(g.stats().queued).toBe(0);
  });

  it("非法 maxConcurrent 回落到缺省 8", () => {
    const g = new RunGuard({ maxConcurrent: 0 });
    expect(g.stats().maxConcurrent).toBe(8);
  });
});

describe("总派发预算 recordDispatch", () => {
  it("递增到上限后 TOTAL_EXCEEDED 且 total 不再增长", () => {
    const g = new RunGuard({ maxConcurrent: 2, maxTotal: 3 });
    expect(g.recordDispatch()).toEqual({ ok: true, code: "OK" });
    expect(g.recordDispatch()).toEqual({ ok: true, code: "OK" });
    expect(g.recordDispatch()).toEqual({ ok: true, code: "OK" });
    expect(g.recordDispatch()).toEqual({ ok: false, code: "TOTAL_EXCEEDED" });
    expect(g.recordDispatch()).toEqual({ ok: false, code: "TOTAL_EXCEEDED" });
    expect(g.stats().total).toBe(3);
  });

  it("maxTotal=0 时第一次就拒", () => {
    const g = new RunGuard({ maxTotal: 0 });
    expect(g.recordDispatch()).toEqual({ ok: false, code: "TOTAL_EXCEEDED" });
    expect(g.stats().total).toBe(0);
  });

  it("缺省上限 200", () => {
    const g = new RunGuard();
    expect(g.stats().maxTotal).toBe(200);
    for (let i = 0; i < 200; i++) expect(g.recordDispatch().ok).toBe(true);
    expect(g.recordDispatch()).toEqual({ ok: false, code: "TOTAL_EXCEEDED" });
  });
});

describe("abortAll", () => {
  it("拒绝全部排队者 ABORTED,在飞不受影响", async () => {
    const g = new RunGuard({ maxConcurrent: 1 });
    const rel1 = await g.acquire();
    const p2 = g.acquire();
    const p3 = g.acquire();
    g.abortAll("fatal");
    await expect(p2).rejects.toMatchObject({ code: "ABORTED" });
    await expect(p3).rejects.toMatchObject({ code: "ABORTED" });
    expect(g.stats()).toMatchObject({ queued: 0, inFlight: 1, aborted: true });
    rel1();
    expect(g.stats().inFlight).toBe(0);
  });

  it("abortAll 后 acquire 直接拒 ABORTED", async () => {
    const g = new RunGuard();
    g.abortAll("run-ended");
    await expect(g.acquire()).rejects.toMatchObject({ code: "ABORTED" });
    expect(g.stats().aborted).toBe(true);
  });

  it("abortInfo 记录原因与注入时间(确定性)", () => {
    const g = new RunGuard({ now: () => 1234 });
    expect(g.abortInfo()).toEqual({});
    g.abortAll("fatal");
    expect(g.abortInfo()).toEqual({ reason: "fatal", at: 1234 });
  });

  it("重复 abortAll 保留首次原因", () => {
    let t = 100;
    const g = new RunGuard({ now: () => t });
    g.abortAll("fatal");
    t = 200;
    g.abortAll("run-ended");
    expect(g.abortInfo()).toEqual({ reason: "fatal", at: 100 });
  });
});

describe("stats 快照", () => {
  it("六字段齐全且与实况一致", async () => {
    const g = new RunGuard({ maxConcurrent: 3, maxTotal: 7 });
    g.recordDispatch();
    const rel = await g.acquire();
    expect(g.stats()).toEqual({ inFlight: 1, queued: 0, total: 1, maxConcurrent: 3, maxTotal: 7, aborted: false });
    rel();
    expect(g.stats()).toEqual({ inFlight: 0, queued: 0, total: 1, maxConcurrent: 3, maxTotal: 7, aborted: false });
  });
});

describe("isFatalWorkflowError", () => {
  it("fatal:true 与 FATAL_CODES 命中均为真", () => {
    expect(isFatalWorkflowError(new WorkflowRunError("TOTAL_EXCEEDED", "x", { fatal: true }))).toBe(true);
    expect(isFatalWorkflowError(Object.assign(new Error("x"), { fatal: true }))).toBe(true);
    for (const code of FATAL_CODES) expect(isFatalWorkflowError(Object.assign(new Error(code), { code }))).toBe(true);
  });
  it("普通错误/字符串/null 为假(不误判)", () => {
    expect(isFatalWorkflowError(new Error("普通失败"))).toBe(false);
    expect(isFatalWorkflowError(new WorkflowRunError("ABORTED", "x"))).toBe(false);
    expect(isFatalWorkflowError("boom")).toBe(false);
    expect(isFatalWorkflowError(null)).toBe(false);
    expect(isFatalWorkflowError(undefined)).toBe(false);
  });
  it("FATAL_CODES 含 TOTAL_EXCEEDED / FATAL / SCRIPT_FATAL", () => {
    expect([...FATAL_CODES]).toEqual(["TOTAL_EXCEEDED", "FATAL", "SCRIPT_FATAL"]);
  });
});

describe("settleOrder", () => {
  it("全部成功 → settled=n,pending=0", async () => {
    const r = await settleOrder([Promise.resolve(1), sleep(5), Promise.resolve("x")]);
    expect(r).toEqual({ settled: 3, pending: 0 });
  });
  it("含 reject 也视作落定,函数不 reject", async () => {
    const r = await settleOrder([Promise.resolve(1), Promise.reject(new Error("bad"))]);
    expect(r).toEqual({ settled: 2, pending: 0 });
  });
  it("空数组立即返回", async () => {
    expect(await settleOrder([])).toEqual({ settled: 0, pending: 0 });
  });
  it("超时未落定者计入 pending", async () => {
    const never = new Promise<never>(() => { /* 永挂 */ });
    const r = await settleOrder([Promise.resolve(1), never], { timeoutMs: 10 });
    expect(r).toEqual({ settled: 1, pending: 1 });
  });
  it("失败的 Promise 不产生未处理拒绝(镜像吞错)", async () => {
    let rejectedSeen = false;
    const p = Promise.reject(new Error("boom"));
    p.catch(() => { rejectedSeen = true; });
    const r = await settleOrder([p]);
    expect(r.settled).toBe(1);
    await sleep(0);
    expect(rejectedSeen).toBe(true);
  });
});
