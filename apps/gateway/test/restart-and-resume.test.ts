/**
 * restart-and-resume 单测(2026-10-28):「重启网关后把本会话捞回来」的编排器。
 *
 * 为什么需要这个脚本:主 agent 跑在 session-worker 里(网关的子进程),重启网关 =
 * 把自己的进程树连根拔起,当前任务被标 cancelled。脚本经 setsid 脱离后按序执行
 * 停旧 → 起新 → WS 提交续跑任务 → 轮询确认,让同会话的新 worker 接着干。
 *
 * 本文件覆盖**纯函数与协议帧**(不真重启):参数校验、任务书读取、提交帧、复活判定、
 * 交接文件;负面断言覆盖「参数不全绝不碰进程」。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const script = resolve(repoRoot, "scripts/restart-and-resume.cjs");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(script) as {
  EXIT: Record<string, number>;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  validateArgs: (o: Record<string, unknown>) => string[];
  readInstruction: (o: Record<string, unknown>) => { text: string; source: string };
  buildSubmitFrame: (a: { sessionId: string; instruction: string; stamp: string }) => Record<string, unknown>;
  pickResumeTask: (tasks: unknown[], q: { sessionId: string; sinceAt: number }) => Record<string, unknown> | undefined;
  buildHandoff: (a: Record<string, unknown>) => Record<string, unknown>;
};

describe("参数解析与校验", () => {
  it("解析全部选项", () => {
    const o = mod.parseArgs([
      "--session", "web-1",
      "--instruction", "继续",
      "--port", "7700",
      "--settle-ms", "1000",
      "--wait-ms", "5000",
      "--verify-ms", "7000",
      "--dry-run",
      "--no-watchdog",
    ]);
    expect(o.session).toBe("web-1");
    expect(o.instruction).toBe("继续");
    expect(o.port).toBe(7700);
    expect(o.settleMs).toBe(1000);
    expect(o.waitMs).toBe(5000);
    expect(o.verifyMs).toBe(7000);
    expect(o.dryRun).toBe(true);
    expect(o.watchdog).toBe(false);
  });

  it("非法数值/未知参数直接抛错(不静默兜底)", () => {
    expect(() => mod.parseArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => mod.parseArgs(["--nope"])).toThrow(/未知参数/);
  });

  it("validateArgs:缺 session / 缺任务书 / 两者都给,都要报错", () => {
    expect(mod.validateArgs({ session: "", instruction: "x" })).toContain("缺少 --session");
    expect(mod.validateArgs({ session: "s" })).toEqual([expect.stringContaining("缺少 --instruction")]);
    expect(mod.validateArgs({ session: "s", instruction: "x", instructionFile: "/tmp/y" }))
      .toEqual([expect.stringContaining("只能给一个")]);
    expect(mod.validateArgs({ session: "s", instruction: "x" })).toEqual([]);
  });

  it("空白任务书不算有效", () => {
    expect(mod.validateArgs({ session: "s", instruction: "   " })).toEqual([expect.stringContaining("缺少 --instruction")]);
  });
});

describe("续跑任务书与提交帧", () => {
  it("--instruction-file 读内容并去掉首尾空白", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    try {
      const f = join(dir, "handoff.txt");
      writeFileSync(f, "\n  重启后请核对 dist 并汇报  \n\n");
      const r = mod.readInstruction({ instructionFile: f });
      expect(r.text).toBe("重启后请核对 dist 并汇报");
      expect(r.source).toBe(f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空任务书文件报错(不投递空指令任务)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    try {
      const f = join(dir, "empty.txt");
      writeFileSync(f, "   \n");
      expect(() => mod.readInstruction({ instructionFile: f })).toThrow(/为空/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("task.submit 帧:同会话 + 幂等键不带 user. 前缀(服务端会加)", () => {
    const frame = mod.buildSubmitFrame({ sessionId: "web-9", instruction: "继续干活", stamp: "123" });
    expect(frame).toMatchObject({ v: 1, type: "task.submit", sessionId: "web-9", instruction: "继续干活" });
    expect(String(frame.idempotencyKey)).toBe("restart-resume-123");
    expect(String(frame.idempotencyKey).startsWith("user.")).toBe(false);
  });
});

describe("复活判定", () => {
  const tasks = [
    { id: "old", sessionId: "web-9", createdAt: 100, state: "cancelled" },
    { id: "other", sessionId: "web-8", createdAt: 300, state: "running" },
    { id: "mine", sessionId: "web-9", createdAt: 250, state: "running" },
  ];

  it("只认同会话且创建时间不早于提交时刻的任务", () => {
    expect(mod.pickResumeTask(tasks, { sessionId: "web-9", sinceAt: 200 })).toMatchObject({ id: "mine" });
    expect(mod.pickResumeTask(tasks, { sessionId: "web-9", sinceAt: 400 })).toBeUndefined();
  });

  it("多个命中取最新;空/脏入参不抛", () => {
    const newer = [...tasks, { id: "newest", sessionId: "web-9", createdAt: 400, state: "queued" }];
    expect(mod.pickResumeTask(newer, { sessionId: "web-9", sinceAt: 200 })).toMatchObject({ id: "newest" });
    expect(mod.pickResumeTask([], { sessionId: "web-9", sinceAt: 0 })).toBeUndefined();
    expect(mod.pickResumeTask(null as unknown as unknown[], { sessionId: "web-9", sinceAt: 0 })).toBeUndefined();
  });
});

describe("交接文件", () => {
  it("记录旧 pid / 会话 / 任务书摘要", () => {
    const h = mod.buildHandoff({
      sessionId: "web-9", port: 7700, oldPid: 42,
      instruction: "x".repeat(500), source: "inline", startedAt: 111,
    });
    expect(h).toMatchObject({ sessionId: "web-9", port: 7700, oldGatewayPid: 42, instructionChars: 500, instructionSource: "inline" });
    expect(String(h.instructionHead).length).toBe(300);
  });
});

describe("负面断言:参数不全时绝不碰进程", () => {
  it("缺 --session → 退出码 1 且不产生 result 文件", () => {
    const before = readFileIfExists(join(repoRoot, ".genie/restart-resume-result.txt"));
    const r = spawnSync(process.execPath, [script, "--instruction", "x"], { encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(mod.EXIT.usage);
    expect(String(r.stderr)).toContain("缺少 --session");
    const after = readFileIfExists(join(repoRoot, ".genie/restart-resume-result.txt"));
    expect(after).toBe(before); // 没写结果文件=没走重启路径
  }, 40000);

  it("--help 输出用法、退出码 0、不触碰网关", () => {
    const r = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toContain("--session");
    expect(String(r.stdout)).toContain("setsid");
  }, 40000);

  it("--dry-run 不杀不起(退出码 0,输出含 dry-run 计划)", () => {
    const r = spawnSync(
      process.execPath,
      [script, "--session", "web-dryrun", "--instruction", "dry", "--dry-run", "--settle-ms", "1", "--no-watchdog"],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(r.status).toBe(0);
    expect(`${r.stdout}`).toContain("dry-run");
    expect(`${r.stdout}`).toContain("safe-restart");
  }, 40000);
});

function readFileIfExists(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
