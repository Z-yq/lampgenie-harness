/**
 *  双界并发接线审计(源码级)。
 * 为什么读源码而不跑行为:双界的「两道界都在、且取的是同一个 min」是装配事实——
 * 行为测试能证明峰值受限,但证明不了「没有第二处自己算一遍」;这里把三处固定:
 * 1) ceiling.ts 只有一个 doubleBoundConcurrency,且 engine 走 clampRunConcurrency(★统一口径);
 * 2) RunGuard 内部排队真的是 SeatPool(不是又留了一份私有队列);
 * 3) harness-workflow 真的声明了 runtime 依赖(workspace 解析得到才不是本地假绿)。
 * 零反斜杠纪律:只用 includes 字面串。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

const SEAT_POOL = src("packages/harness-runtime/src/concurrency/seat-pool.ts");
const CEILING = src("packages/harness-runtime/src/concurrency/ceiling.ts");
const RUN_GUARD = src("packages/harness-workflow/src/run-guard.ts");
const ENGINE = src("packages/harness-workflow/src/engine.ts");
const WF_PKG = src("packages/harness-workflow/package.json");

describe("双界口径唯一(ceiling.ts)", () => {
  it("doubleBoundConcurrency 只有一处实现,内部就是 Math.min", () => {
    expect(count(CEILING, "export function doubleBoundConcurrency(")).toBe(1);
    expect(CEILING).toContain("Math.min(...finite)");
    expect(CEILING).toContain("Math.max(1, Math.floor(");
  });

  it("既有的单界函数仍在(clampRunConcurrency / deriveWorkflowConcurrencyCeiling)", () => {
    expect(CEILING).toContain("export function clampRunConcurrency(");
    expect(CEILING).toContain("export function deriveWorkflowConcurrencyCeiling(");
  });
});

describe("座位池语义落点(seat-pool.ts)", () => {
  it("五码词表与「座位=run 界」的定位注释在场", () => {
    expect(SEAT_POOL).toContain('"ACQUIRED", "PARKED", "ABORTED", "RELEASED", "INVALID"');
    expect(SEAT_POOL).toContain("座位 = run 界,不是 provider 界");
    expect(SEAT_POOL).toContain("export const SEAT_CODES");
  });

  it("acquire/release/abortAll/setCapacity/stats 全部公开", () => {
    for (const m of ["acquire(", "release(", "abortAll(", "setCapacity(", "stats("]) {
      expect(SEAT_POOL).toContain(`  ${m}`);
    }
    expect(SEAT_POOL).toContain("maxQueue");
  });
});

describe("RunGuard 内部排队换成 SeatPool(对外行为不变)", () => {
  it("从 runtime 引入 SeatPool 并用它做并发闸", () => {
    expect(RUN_GUARD).toContain('from "@lampgenie/runtime/concurrency/seat-pool"');
    expect(RUN_GUARD).toContain("new SeatPool({ capacity: this.maxConcurrent, maxQueue: 256");
    expect(RUN_GUARD).toContain("this.pool.acquire(");
    expect(RUN_GUARD).toContain("this.pool.release(");
  });

  it("旧的私有队列/inFlight 计数已消失(不是双份实现)", () => {
    expect(RUN_GUARD).not.toContain("private queue: Waiter[]");
    expect(RUN_GUARD).not.toContain("private inFlight = 0");
    expect(RUN_GUARD).not.toContain("private pump(): void");
  });

  it("stats 由座位池推导,abortAll 走池中止", () => {
    expect(RUN_GUARD).toContain("const s = this.pool.stats();");
    expect(RUN_GUARD).toContain("inFlight: s.inUse");
    expect(RUN_GUARD).toContain("queued: s.parked");
    expect(RUN_GUARD).toContain("this.pool.abortAll(why)");
  });
});

describe("engine 构造护栏走双界钳制", () => {
  it("makeGuard 用 clampRunConcurrency(请求值, deriveWorkflowConcurrencyCeiling())", () => {
    expect(ENGINE).toContain('from "@lampgenie/runtime/concurrency/ceiling"');
    expect(ENGINE).toContain("clampRunConcurrency(");
    expect(ENGINE).toContain("deriveWorkflowConcurrencyCeiling()");
    expect(ENGINE).toContain("clampRunConcurrency(this.caps.maxConcurrency ?? 8, ceiling)");
  });

  it("不再直接把 caps 值喂给 RunGuard(旧的直传行已消失)", () => {
    expect(ENGINE).not.toContain("new RunGuard({ maxConcurrent: this.caps.maxConcurrency ?? 8, maxTotal: this.maxTotal })");
    expect(ENGINE).toContain("maxTotal: this.maxTotal"); // 总预算不变
  });
});

describe("依赖声明", () => {
  it("harness-workflow 声明 @lampgenie/runtime(workspace)", () => {
    expect(WF_PKG).toContain('"@lampgenie/runtime": "workspace:*"');
  });
});
