/**
 * gateway.pid 生命周期:网关自己写、只清自己的、退出日志带来源指纹。
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGatewayPid, formatExitLog, gatewayPidPath, readGatewayPid, writeGatewayPid } from "../src/gateway-pid.js";

describe("gateway-pid", () => {
  it("路径锚定 <root>/.genie/gateway.pid", () => {
    expect(gatewayPidPath("/repo")).toBe(join("/repo", ".genie", "gateway.pid"));
  });

  it("写入/读取;原子替换后内容为最新 pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    try {
      const p = gatewayPidPath(dir);
      expect(writeGatewayPid(p, 111)).toBe(true);
      expect(readGatewayPid(p)).toBe(111);
      expect(writeGatewayPid(p, 222)).toBe(true);
      expect(readGatewayPid(p)).toBe(222);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("清理:内容不是自己 pid 时不动(不误删继任者)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    try {
      const p = gatewayPidPath(dir);
      writeGatewayPid(p, 555);
      expect(clearGatewayPid(p, 999)).toBe(false);
      expect(readGatewayPid(p)).toBe(555);
      expect(clearGatewayPid(p, 555)).toBe(true);
      expect(readGatewayPid(p)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("损坏/空文件读作 undefined(不把脏内容当 pid)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pid-"));
    try {
      const p = gatewayPidPath(dir);
      mkdirSync(join(dir, ".genie"), { recursive: true });
      writeFileSync(p, "not-a-pid", "utf-8");
      expect(readGatewayPid(p)).toBeUndefined();
      writeFileSync(p, "", "utf-8");
      expect(readGatewayPid(p)).toBeUndefined();
      writeFileSync(p, "-3", "utf-8");
      expect(readGatewayPid(p)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("退出日志含 reason/signal/pid/ppid/uptime/activeTasks/startedBy", () => {
    const line = formatExitLog({
      reason: "signal", signal: "SIGTERM", pid: 1234, ppid: 99, uptimeMs: 5678.4,
      activeTasks: 2, taskStates: "running:1,queued:1", startedBy: "watchdog",
    });
    expect(line).toBe("[gateway] exit reason=signal signal=SIGTERM pid=1234 ppid=99 uptimeMs=5678 activeTasks=2 taskStates=running:1,queued:1 startedBy=watchdog");
    // 取不到活跃任务时如实记 ?(不伪造 0)
    expect(formatExitLog({ reason: "exit", code: 1, activeTasks: -1 })).toContain("activeTasks=?");
    expect(formatExitLog({ reason: "exit", code: 1 })).toContain("code=1");
  });
});
