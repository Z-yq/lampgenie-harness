/**
 * 启动期阶段租约「接线断言」:读源码钉死 host/worker 的接线口径。
 * 纯文本断言,不 fork 进程——真实 IPC 回归在 session-worker-host.test.ts。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string): string => readFileSync(join(here, "..", "src", f), "utf-8");

describe("startup-lease 接线", () => {
  const host = src("session-worker-host.ts");
  const worker = src("session-worker.ts");
  const leaseSrc = src("startup-lease.ts");

  it("W1 host 引入 StartupLease/threadStackHint/STARTUP_STAGES", () => {
    expect(host).toContain('from "./startup-lease.js"');
    expect(host).toContain("new StartupLease(");
    expect(host).toContain("threadStackHint(run.pid)");
    expect(host).toContain("STARTUP_STAGES");
  });

  it("W2 WorkerRun 持 lease,spawn 时 begin(\"spawn\")", () => {
    expect(host).toMatch(/lease:\s*StartupLease/);
    expect(host).toMatch(/run\.lease\.begin\("spawn"/);
  });

  it("W3 收 startup.progress:lease.begin + journal 同类只落一次", () => {
    expect(host).toContain('"startup.progress"');
    expect(host).toContain("run.lease.begin(stage)");
    expect(host).toContain('type: "worker.startup.progress"');
    expect(host).toContain("startupStagesLogged");
  });

  it("W4 ready 定时器改为 lease.sample,饥饿免疫在 sample 之前", () => {
    const iStarve = host.indexOf("sinceSchedule > windowMs * 2");
    const iSample = host.indexOf("run.lease.sample(");
    expect(iStarve).toBeGreaterThan(-1);
    expect(iSample).toBeGreaterThan(iStarve);
    expect(host).toContain("cpuPercent");
  });

  it("W5 retry 落 worker.startup.retry 并重武装整窗", () => {
    expect(host).toContain('type: "worker.startup.retry"');
    expect(host).toContain("windowStartAt = tickAt");
  });

  it("W6 kill 前落 worker.startup.evidence:lease 证据 + 线程栈建议 + stderr 尾 20 行", () => {
    expect(host).toContain('type: "worker.startup.evidence"');
    expect(host).toContain("run.lease.evidence()");
    expect(host).toContain("threadStackHint(run.pid)");
    expect(host).toContain("slice(-20)");
  });

  it("W7 证据落账顺序在 failTask/reap 之前", () => {
    const iEvidence = host.indexOf('type: "worker.startup.evidence"');
    const iFail = host.indexOf("worker 启动卡在阶段");
    const iReap = host.indexOf("reap(task.id);", iEvidence);
    expect(iEvidence).toBeGreaterThan(-1);
    expect(iFail).toBeGreaterThan(iEvidence);
    expect(iReap).toBeGreaterThan(iEvidence);
  });

  it("W8 ready 到达即 begin(loop-ready) 并清掉判决定时器", () => {
    expect(host).toContain('run.lease.begin("loop-ready")');
    expect(host).toContain("clearTimeout(run.readyTimer)");
  });

  it("W9 worker main() 四阶段上报 config/executor/providers/loop-ready", () => {
    for (const stage of ["config", "executor", "providers", "loop-ready"]) {
      expect(worker).toContain(`reportStartupStage("${stage}")`);
    }
    expect(worker.match(/reportStartupStage/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(worker).toContain('t: "startup.progress"');
  });

  it("W10 ready 仍是唯一成功信号且协议未改(WorkerNotice 无新成员)", () => {
    expect(worker).toContain('notify({ t: "ready"');
    const proto = src("session-worker-protocol.ts");
    expect(proto).not.toContain("startup.progress");
  });

  it("W11 startup-lease 纯逻辑零 IO(不 import fs)", () => {
    expect(leaseSrc).not.toContain('from "node:fs"');
    expect(leaseSrc).not.toContain("readFileSync");
    expect(leaseSrc).not.toContain("process.");
  });
});
