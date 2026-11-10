/**
 * 「偶发 git-failed」回归:面板 toast 只显示
 * `Error: Command failed: git status --porcelain -b`(code=git-failed, stderr 为空)。
 * 经验证根因(见 board 证据):
 * ①本仓 490 个变更时单次 `git status --porcelain -b` 已 5.7~11.8s,而 runGit 统一
 *   timeout=15s;
 * ②面板 gitLoad / IDE SCM 角标 / 多会话各自触发 status,并发 4/8 份经验证总耗时
 *   10.7s/12.9s,单个请求越过 15s → execFile SIGTERM;
 * ③超时被 kill 时 Node 的 error 只有一句 `Command failed: <cmd>`,stderr 为空,
 *   server 又原样回帧 → 面板只看到这句无信息量原文;
 * ④排除项:index.lock 存在时 git status 仍 exit=0(只读命令不因锁失败),
 *   故本用例的锁场景验证的是"只读命令补 --no-optional-locks 后仍正确"而非修锁。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitErrorText,
  gitStatus,
  gitSubcommand,
  isReadOnlyGitCommand,
  isTransientGitError,
  prepareGitArgs,
} from "../src/git-service.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "genie-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "1\n");
  run(["add", "a.txt"]);
  run(["commit", "-qm", "init"]);
  return dir;
}

/** wc -l 输出是 "  3 file",只取首字段。 */
function countLines(file: string): number {
  const out = execFileSync("wc", ["-l", file], { encoding: "utf8" }).trim();
  return Number(out.split(/\s+/)[0]);
}

/** 假 git 脚本:先记录一次调用,再执行 body。 */
function makeFakeGit(dir: string, name: string, body: string): { bin: string; counter: string } {
  const counter = join(dir, "..", `${name}-count-${Date.now()}.txt`);
  const bin = join(dir, "..", `${name}-${Date.now()}.sh`);
  writeFileSync(bin, `#!/bin/sh\necho x >> ${counter}\n${body}\n`, { mode: 0o755 });
  return { bin, counter };
}

describe("git 参数形态(纯函数)", () => {
  it("gitSubcommand 跳过 -c/--git-dir 的值,取真实子命令", () => {
    expect(gitSubcommand(["status", "--porcelain", "-b"])).toBe("status");
    expect(gitSubcommand(["-c", "user.email=a", "commit", "-m", "x"])).toBe("commit");
    expect(gitSubcommand(["--git-dir", "/x/.git", "log"])).toBe("log");
    expect(gitSubcommand([])).toBe("");
  });

  it("只读子命令补 --no-optional-locks(全局标志在子命令前),写命令原样", () => {
    expect(isReadOnlyGitCommand(["status", "--porcelain"])).toBe(true);
    expect(prepareGitArgs(["status", "--porcelain", "-b"])).toEqual(["--no-optional-locks", "status", "--porcelain", "-b"]);
    expect(isReadOnlyGitCommand(["commit", "-m", "x"])).toBe(false);
    expect(prepareGitArgs(["commit", "-m", "x"])).toEqual(["commit", "-m", "x"]);
    // -c 形态的写命令也不能误加
    expect(prepareGitArgs(["-c", "user.email=a", "commit", "-m", "x"])).toEqual(["-c", "user.email=a", "commit", "-m", "x"]);
  });
});

describe("gitErrorText:失败文本可判读", () => {
  it("超时(SIGTERM)→ 明说超时秒数,且不再是裸 Command failed", () => {
    const err = Object.assign(new Error("Command failed: git status --porcelain -b\n"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "",
    });
    const text = gitErrorText(["status", "--porcelain", "-b"], err, 60_000);
    expect(text).toContain("git status 超时");
    expect(text).toContain(">60s");
    expect(text).not.toContain("Command failed");
  });

  it("stderr 有内容 → 取首行(锁争用等真实原因得以暴露)", () => {
    const err = Object.assign(new Error("Command failed: git status"), {
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\n",
    });
    expect(gitErrorText(["status"], err, 60_000)).toContain("Unable to create");
  });

  it("无 stderr 且非超时 → 仍给可读句子,不带 Command failed", () => {
    const text = gitErrorText(["branch"], new Error("Command failed: git branch"), 30_000);
    expect(text).toContain("git branch 失败");
    expect(text).not.toContain("Command failed");
  });

  it("isTransientGitError 只认锁争用类", () => {
    expect(isTransientGitError({ stderr: "fatal: Unable to create '/r/.git/index.lock': File exists." })).toBe(true);
    expect(isTransientGitError({ stderr: "Another git process seems to be running" })).toBe(true);
    expect(isTransientGitError({ stderr: "fatal: not a git repository" })).toBe(false);
  });
});

describe("真仓行为", () => {
  it("index.lock 被外部占用时 gitStatus 仍成功(--no-optional-locks 不抢锁)", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "b.txt"), "2\n");
      writeFileSync(join(dir, ".git", "index.lock"), "");
      const st = await gitStatus(dir);
      expect(st.changes.map((c) => c.file)).toContain("b.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一 cwd 并发 status 合并成一次 git 执行(单飞)", async () => {
    const dir = makeRepo();
    const { bin, counter } = makeFakeGit(dir, "fakegit", 'exec git "$@"');
    const prev = process.env.GENIE_GIT_BIN;
    process.env.GENIE_GIT_BIN = bin;
    try {
      writeFileSync(join(dir, "c.txt"), "3\n");
      const results = await Promise.all([gitStatus(dir), gitStatus(dir), gitStatus(dir)]);
      expect(results[0]!.changes.map((c) => c.file)).toContain("c.txt");
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      expect(countLines(counter)).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.GENIE_GIT_BIN;
      else process.env.GENIE_GIT_BIN = prev;
      rmSync(bin, { force: true });
      rmSync(counter, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("超时收缩为 300ms + 慢 git → 报「超时」而非 Command failed(超时不重试)", async () => {
    const dir = makeRepo();
    const { bin, counter } = makeFakeGit(dir, "slowgit", 'sleep 2\nexec git "$@"');
    const prevBin = process.env.GENIE_GIT_BIN;
    const prevTimeout = process.env.GENIE_GIT_TIMEOUT_MS;
    process.env.GENIE_GIT_BIN = bin;
    process.env.GENIE_GIT_TIMEOUT_MS = "300";
    try {
      await expect(gitStatus(dir)).rejects.toThrow(/git status 超时/);
      expect(countLines(counter)).toBe(1); // 超时不重试,避免面板干等 2 倍超时
    } finally {
      if (prevBin === undefined) delete process.env.GENIE_GIT_BIN;
      else process.env.GENIE_GIT_BIN = prevBin;
      if (prevTimeout === undefined) delete process.env.GENIE_GIT_TIMEOUT_MS;
      else process.env.GENIE_GIT_TIMEOUT_MS = prevTimeout;
      rmSync(bin, { force: true });
      rmSync(counter, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("锁争用退避重试一次(首次 index.lock 失败 → 第二次成功)", async () => {
    const dir = makeRepo();
    // 首次输出锁错误退出 128;之后转发真 git
    const { bin, counter } = makeFakeGit(
      dir,
      "lockgit",
      `if [ ! -f "${dir}/../genie-retried-${process.pid}" ]; then
  touch "${dir}/../genie-retried-${process.pid}"
  echo "fatal: Unable to create '${dir}/.git/index.lock': File exists." >&2
  exit 128
fi
exec git "$@"`,
    );
    const prevBin = process.env.GENIE_GIT_BIN;
    process.env.GENIE_GIT_BIN = bin;
    try {
      writeFileSync(join(dir, "d.txt"), "4\n");
      const st = await gitStatus(dir);
      expect(st.changes.map((c) => c.file)).toContain("d.txt");
      expect(countLines(counter)).toBe(2);
    } finally {
      if (prevBin === undefined) delete process.env.GENIE_GIT_BIN;
      else process.env.GENIE_GIT_BIN = prevBin;
      rmSync(bin, { force: true });
      rmSync(counter, { force: true });
      rmSync(join(dir, "..", `genie-retried-${process.pid}`), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("负面断言:错误文本不出现裸「Command failed: git status --porcelain -b」", async () => {
    const dir = makeRepo();
    // 损坏 index → git status 非零退出且 stderr 有真实原因;最终文本必须是可判读句子
    writeFileSync(join(dir, ".git", "index"), "garbage-not-an-index");
    try {
      let message = "";
      try {
        await gitStatus(dir);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toMatch(/^Command failed:/);
      expect(message).not.toContain("Command failed");
      expect(message).toContain("git status");
      expect(message.length).toBeGreaterThan("git status 失败:".length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
