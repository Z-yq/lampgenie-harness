/**
 * process-guards 回归:worker 进程级崩溃保活(2026-10-28 web_search 打崩 session-worker 事故)。
 *
 * 双层验证:
 * ①行为层:子进程装 guard 后抛 uncaughtException/未处理拒绝 → 进程存活 + 日志响亮;
 * ②接线层:session-worker 启动路径确实装了 guard(源码断言,防回退成只挂 unhandledRejection)。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installCrashGuards } from "../src/process-guards.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const probe = resolve(here, "fixtures/crash-guard-probe.ts");

function runProbe(timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", probe], {
      cwd: pkgRoot,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ code: -1, out: out + "\n[test] timeout" });
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, out });
    });
  });
}

describe("process-guards:崩溃保活", () => {
  it("装 guard 后抛 uncaughtException → 进程不退出,日志带 tag 与堆栈", async () => {
    const r = await runProbe();
    expect(r.out).toContain("GUARD:alive count=1");
    expect(r.out).toContain("[probe] uncaughtException 保活");
    expect(r.out).toContain("boom-uncaught");
    expect(r.code).toBe(0);
  }, 30_000);

  it("in-process:unhandledRejection 与 uncaughtException 都由 guard 接管并可 dispose", async () => {
    const lines: string[] = [];
    const startCount = process.listenerCount("uncaughtException");
    const guard = installCrashGuards({ tag: "unit", log: (l) => lines.push(l) });
    expect(process.listenerCount("uncaughtException")).toBe(startCount + 1);
    try {
      process.emit("uncaughtException", new Error("u-boom"));
      process.emit("unhandledRejection", new Error("r-boom"));
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("[unit] uncaughtException 保活");
      expect(lines[1]).toContain("[unit] unhandledRejection 保活");
      expect(guard.count()).toBe(2);
    } finally {
      guard.dispose();
    }
    // dispose 只卸监听,计数保留;后续崩溃不再被本 guard 记录
    expect(process.listenerCount("uncaughtException")).toBe(startCount);
    expect(guard.count()).toBe(2);
    expect(lines.length).toBe(2);
  });
});

describe("session-worker 接线", () => {
  it("启动路径安装 installCrashGuards(tag=session-worker)", () => {
    const src = readFileSync(resolve(pkgRoot, "src/session-worker.ts"), "utf8");
    expect(src).toContain('installCrashGuards({ tag: "session-worker" })');
    expect(src).toContain('from "./process-guards.js"');
  });
});
