/**
 * 启动期看门狗阶段租约单测(纯逻辑,时钟注入)。
 * 探针 A-F:阶段推进/回退、未超时 wait、超时重试一次、二次超时杀、CPU 兜底、
 * 证据形状与确定性、threadStackHint 取证建议。
 */
import { describe, it, expect } from "vitest";
import { STARTUP_STAGES, STARTUP_CODES, StartupLease, threadStackHint } from "../src/startup-lease.js";

interface MkOpts { timeoutMs?: number; stageTimeoutMs?: number; cpuFallbackLimit?: number; now?: () => number }

const lease = (opts: MkOpts = {}): StartupLease =>
  new StartupLease({ timeoutMs: 1000, stageTimeoutMs: 300, cpuFallbackLimit: 3, now: () => 0, ...opts });

describe("A 阶段序列", () => {
  it("A1 STARTUP_STAGES 顺序钉死", () => {
    expect(STARTUP_STAGES).toEqual(["spawn", "config", "executor", "providers", "loop-ready"]);
  });

  it("A2 STARTUP_CODES 集合钉死", () => {
    expect([...STARTUP_CODES].sort()).toEqual(["CPU_BUSY", "KILL", "NO_PROGRESS", "OK", "RETRY", "WAITING"]);
  });

  it("A3 begin 向前推进:记录 previous/enteredAt", () => {
    const l = lease();
    expect(l.begin("spawn", 0)).toMatchObject({ ok: true, code: "OK", stage: "spawn", previous: null });
    expect(l.begin("config", 10)).toMatchObject({ ok: true, stage: "config", previous: "spawn", enteredAt: 10 });
  });

  it("A4 begin 回退 → INVALID 且状态不变", () => {
    const l = lease();
    l.begin("spawn", 0);
    l.begin("executor", 10);
    const r = l.begin("config", 20);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("INVALID");
    expect(r.stage).toBe("executor");
    expect(l.evidence().stages.map((s) => s.stage)).toEqual(["spawn", "executor"]);
  });

  it("A5 begin 同阶段幂等(loop-ready 会 progress+ready 各来一次)", () => {
    const l = lease();
    l.begin("spawn", 0);
    expect(l.begin("config", 10).ok).toBe(true);
    expect(l.begin("config", 20).ok).toBe(true);
    expect(l.evidence().stages.map((s) => s.stage)).toEqual(["spawn", "config"]);
  });

  it("A6 begin 未知阶段(运行时)→ INVALID,不 throw", () => {
    const l = lease();
    l.begin("spawn", 0);
    expect(() => l.begin("bogus" as never, 5)).not.toThrow();
    expect(l.begin("bogus" as never, 5).code).toBe("INVALID");
  });
});

describe("B 未超时", () => {
  it("B1 未超时 → wait/WAITING,elapsedMs 按注入 at 计", () => {
    const l = lease();
    l.begin("spawn", 0);
    const v = l.sample({ at: 500 });
    expect(v).toMatchObject({ action: "wait", code: "WAITING", stage: "spawn", elapsedMs: 500 });
  });
});

describe("C 超时与重试", () => {
  it("C1 超时且阶段刚推进 → retry/RETRY(重武装一次)", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 10_000 });
    l.begin("spawn", 0);
    const v = l.sample({ at: 1000 });
    expect(v).toMatchObject({ action: "retry", code: "RETRY" });
    expect(l.evidence().retries).toBe(1);
  });

  it("C2 重试后再超时 → kill/NO_PROGRESS(不再重试)", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 10_000 });
    l.begin("spawn", 0);
    l.sample({ at: 1000 });
    const v = l.sample({ at: 2000 });
    expect(v).toMatchObject({ action: "kill", code: "NO_PROGRESS" });
    expect(l.evidence().retries).toBe(1);
  });

  it("C3 超时且阶段停留已久 + CPU 不忙 → kill/NO_PROGRESS", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    expect(l.sample({ cpuPercent: 12, at: 1000 })).toMatchObject({ action: "kill", code: "NO_PROGRESS" });
  });

  it("C4 超时且无 CPU 证据 → kill/NO_PROGRESS(不能因读不到 CPU 永不收割)", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    const v = l.sample({ at: 1000 });
    expect(v).toMatchObject({ action: "kill", code: "NO_PROGRESS" });
    expect(v.reason).toContain("无 CPU 证据");
  });
});

describe("D CPU 兜底", () => {
  it("D1 CPU 98% 连续 3 次(无阶段推进)→ kill/CPU_BUSY", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    expect(l.sample({ cpuPercent: 98, at: 1000 }).action).toBe("wait");
    expect(l.sample({ cpuPercent: 98, at: 2000 }).action).toBe("wait");
    expect(l.sample({ cpuPercent: 98, at: 3000 })).toMatchObject({ action: "kill", code: "CPU_BUSY" });
  });

  it("D2 CPU 高但只 2 次(未达上限)→ 继续 wait,不误杀", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    expect(l.sample({ cpuPercent: 95, at: 1000 })).toMatchObject({ action: "wait", code: "WAITING" });
    expect(l.sample({ cpuPercent: 95, at: 2000 })).toMatchObject({ action: "wait", code: "WAITING" });
    expect(l.sample({ at: 3000 })).toMatchObject({ action: "kill", code: "NO_PROGRESS" });
  });

  it("D3 阶段推进使 CPU 连续计数断链", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0, cpuFallbackLimit: 2 });
    l.begin("spawn", 0);
    expect(l.sample({ cpuPercent: 95, at: 1000 }).action).toBe("wait"); // streak=1
    l.begin("config", 1100); // 推进 → streak 清零
    expect(l.sample({ cpuPercent: 95, at: 2000 }).action).toBe("wait"); // streak=1
    expect(l.sample({ cpuPercent: 95, at: 3000 })).toMatchObject({ action: "kill", code: "CPU_BUSY" });
  });

  it("D4 自定义 cpuFallbackLimit=2 → 第 2 次 CPU 高即杀", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0, cpuFallbackLimit: 2 });
    l.begin("spawn", 0);
    expect(l.sample({ cpuPercent: 90, at: 1000 }).action).toBe("wait");
    expect(l.sample({ cpuPercent: 90, at: 2000 })).toMatchObject({ action: "kill", code: "CPU_BUSY" });
  });
});

describe("E 证据", () => {
  it("E1 loop-ready → wait/OK(即使已过总窗口)", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    l.begin("loop-ready", 5000);
    expect(l.sample({ at: 9000 })).toMatchObject({ action: "wait", code: "OK", stage: "loop-ready" });
  });

  it("E2 evidence 字段完整、阶段顺序与停留时长正确", () => {
    const l = lease();
    l.begin("spawn", 0);
    l.begin("config", 100);
    l.sample({ at: 400 });
    const ev = l.evidence();
    expect(Object.keys(ev).sort()).toEqual(["code", "cpuSamples", "lastStage", "retries", "stages"]);
    expect(ev).toMatchObject({ lastStage: "config", retries: 0, cpuSamples: 1, code: "WAITING" });
    expect(ev.stages).toEqual([
      { stage: "spawn", enteredAt: 0, elapsedMs: 400 },
      { stage: "config", enteredAt: 100, elapsedMs: 300 },
    ]);
  });

  it("E3 evidence 只含已进入阶段且 ≤5 项(有界)", () => {
    const l = lease();
    l.begin("spawn", 0);
    l.begin("config", 1);
    const ev = l.evidence();
    expect(ev.stages.length).toBe(2);
    expect(ev.stages.length).toBeLessThanOrEqual(STARTUP_STAGES.length);
  });

  it("E4 evidence 确定性:两次调用相等,序列化单行", () => {
    const l = lease();
    l.begin("spawn", 0);
    l.begin("providers", 50);
    l.sample({ at: 200 });
    const a = l.evidence();
    expect(l.evidence()).toEqual(a);
    expect(JSON.stringify(a).split("\n")).toHaveLength(1);
  });

  it("E5 evidence 不可变:改返回值不回灌内部状态", () => {
    const l = lease();
    l.begin("spawn", 0);
    l.sample({ at: 100 });
    const before = l.evidence();
    const mutated = l.evidence();
    mutated.stages[0]!.stage = "loop-ready";
    mutated.retries = 99;
    expect(l.evidence()).toEqual(before);
  });

  it("E6 retries/cpuSamples 累计正确", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 10_000 });
    l.begin("spawn", 0);
    l.sample({ at: 1000 }); // retry
    l.sample({ at: 2000 }); // kill
    const ev = l.evidence();
    expect(ev.retries).toBe(1);
    expect(ev.cpuSamples).toBe(2);
    expect(ev.code).toBe("NO_PROGRESS");
  });
});

describe("F 时钟/取证/健壮性", () => {
  it("F1 now 注入:at 缺省取注入时钟", () => {
    let t = 0;
    const l = new StartupLease({ timeoutMs: 1000, stageTimeoutMs: 0, now: () => t });
    l.begin("spawn");
    t = 200;
    expect(l.sample().elapsedMs).toBe(200);
  });

  it("F2 不合法 timeout/cpuFallbackLimit 走缺省,不 throw", () => {
    const l = new StartupLease({ timeoutMs: Number.NaN, cpuFallbackLimit: 0, stageTimeoutMs: Number.NaN });
    l.begin("spawn", 0);
    expect(l.sample({ at: 29_000 }).action).toBe("wait");
    expect(l.sample({ at: 30_000 })).toMatchObject({ action: "kill", code: "NO_PROGRESS" });
  });

  it("F3 NaN/Infinity 输入不 throw", () => {
    const l = lease({ timeoutMs: 1000, stageTimeoutMs: 0 });
    l.begin("spawn", 0);
    expect(() => l.sample({ cpuPercent: Number.NaN, at: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() => l.sample({ cpuPercent: Number.POSITIVE_INFINITY, at: 5000 })).not.toThrow();
  });

  it("F4 threadStackHint 含 /proc 与 node report 路径", () => {
    const h = threadStackHint(4321);
    expect(h.pid).toBe(4321);
    const all = [...h.commands, h.paths.procTaskStack, h.paths.procTaskStat, h.paths.nodeReport].join("\n");
    expect(all).toContain("/proc/4321/task/");
    expect(all).toContain("report.4321.");
    expect(all).toContain("--report-directory");
  });

  it("F5 threadStackHint 无 pid 时给占位且不 throw", () => {
    const h = threadStackHint(undefined);
    expect(h.pid).toBe(null);
    expect(h.paths.procTaskStack).toContain("/proc/<pid>");
    expect(h.commands.join("\n")).toContain("kill -USR2 <pid>");
  });

  it("F6 threadStackHint 确定性(同输入同输出)", () => {
    expect(threadStackHint(7)).toEqual(threadStackHint(7));
  });
});
