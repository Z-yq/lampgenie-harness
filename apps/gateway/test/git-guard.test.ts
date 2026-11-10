/**
 * git 破坏命令守卫(g1,2026-11-05)单测。
 *
 * 背景实锤:11-05 09:18 一个子代理执行 `git stash`,把全仓 142 个未提交文件收进 stash,
 * 工作树回退成"什么都没改"的假象;既有 fenceCommand 只拦路径越界,git 破坏命令全放行。
 *
 * 三层断言:
 *  ①纯函数 `guardGitCommand`:破坏类命中(含前缀穿透 sh -c / cd / 环境赋值 / git 全局选项)、
 *    只读查询与"文本里出现 git stash 字样但不是 git 命令"不误伤;
 *  ②装配面(子代理):`buildSubagentExtraTools` 的 terminal 工具与 `LlmLoopBackend` 的 run_cmd
 *    真的把 `git stash` 拒掉(不是"函数写对但没人调用"的假验收);
 *  ③主 agent 面:命中时 journal 落一条 custom/git.audit(放行但留痕),只读命令不留痕。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import { guardGitCommand, auditGitCommand } from "../src/git-guard.js";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { buildSubagentExtraTools } from "../src/agent-wiring.js";
import { setPermissionMode } from "../src/permission-mode.js";

/** execFile 桩:记录调用次数;真被调用就抛(命令守卫写在起进程之前,被拒时零调用)。 */
const execCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (..._args: unknown[]) => {
      execCalls.n++;
      throw new Error("execFile 不应被调用(命令守卫未生效)");
    },
  };
});

let dir = "";

beforeEach(() => {
  setPermissionMode("ask"); // 非 workspace 档:证明 git 守卫与权限档无关(任何档都拦)
  execCalls.n = 0;
  dir = mkdtempSync(join(tmpdir(), "gitguard-"));
});

afterEach(() => {
  setPermissionMode("ask");
  rmSync(dir, { recursive: true, force: true });
});

describe("guardGitCommand:破坏类必拦", () => {
  it("stash / checkout / reset / clean / restore 判定 destructive", () => {
    for (const cmd of ["git stash", "git checkout -- .", "git reset --hard", "git clean -fdx", "git restore .", "git switch main", "git worktree remove ../wt"]) {
      const v = guardGitCommand(cmd);
      expect({ cmd, destructive: v?.destructive, write: v?.write }).toEqual({ cmd, destructive: true, write: true });
    }
  });

  it("前缀穿透:cd / 环境赋值 / git 全局选项 / sh -c 引号内命令", () => {
    for (const cmd of [
      "cd /x && git stash",
      "cd /x; git stash",
      "FOO=1 git stash",
      "sudo -u root git stash",
      "git -C /repo stash",
      "git --no-pager stash",
      "git -c core.pager=cat stash",
      'sh -c "git stash"',
      'bash -lc "cd /x && git stash"',
      'cmd /c "git stash"',
      "xargs git stash",
      "env -i git stash",
    ]) {
      const v = guardGitCommand(cmd);
      expect({ cmd, destructive: v?.destructive }).toEqual({ cmd, destructive: true });
    }
  });

  it("多段命令取最严:只读 + 破坏混排也判破坏", () => {
    const v = guardGitCommand("git status && git stash");
    expect(v?.destructive).toBe(true);
    expect(v?.subcommand).toBe("stash");
  });

  it("引用删除类:update-ref -d / rm / filter-branch", () => {
    expect(guardGitCommand("git update-ref -d refs/heads/x")?.destructive).toBe(true);
    expect(guardGitCommand("git rm src/a.ts")?.destructive).toBe(true);
    expect(guardGitCommand("git filter-branch --all")?.destructive).toBe(true);
  });
});

describe("guardGitCommand:不误伤(解析后子命令判定,不做裸子串匹配)", () => {
  it("文本里出现 git stash/checkout 字样但不是 git 命令 → null", () => {
    for (const cmd of ['echo git stash', "git log --grep=stash", 'grep -r "git checkout" .', "echo 'git stash'", "git log --oneline | grep stash"]) {
      expect({ cmd, v: guardGitCommand(cmd) }).toEqual({ cmd, v: null });
    }
  });

  it("只读 git 查询放行(null):status / stash list / stash show / branch -l / log / diff", () => {
    for (const cmd of [
      "git status",
      "git stash list",
      "git stash show -p",
      "git log --oneline -5",
      "git diff HEAD",
      "git rev-parse HEAD",
      "git branch -l",
      "git branch --show-current",
      "git tag -l",
      "git remote -v",
      "git config --get user.name",
      "npx vitest run test/a.test.ts",
    ]) {
      expect({ cmd, v: guardGitCommand(cmd) }).toEqual({ cmd, v: null });
    }
  });

  it("其余 git 子命令 = write(非破坏):add/commit/push/merge/rebase/tag 创建", () => {
    for (const cmd of ["git add -A", "git commit -m 'fix: a b'", "git push origin main", "git merge feat", "git rebase main", "git tag v1.0", "git pull"]) {
      const v = guardGitCommand(cmd);
      expect({ cmd, write: v?.write, destructive: v?.destructive }).toEqual({ cmd, write: true, destructive: false });
    }
  });
});

describe("装配面:子代理 shell 面硬拦", () => {
  /** 子代理 terminal 工具(生产装配路径 buildSubagentExtraTools)。 */
  function subTerminal(journal: MemoryJournal) {
    const tools = buildSubagentExtraTools(dir, [], new ExperienceStore(dir), { journal, sessionId: "probe-session", owner: "probe-owner" });
    const t = tools.find((x) => x.name === "terminal") as unknown as { execute(a: unknown): Promise<string> } | undefined;
    if (!t) throw new Error("装配面没有 terminal 工具");
    return t;
  }

  it("子代理 terminal `send git stash` → 拒(带父子职责说明),任何权限档都不放行", async () => {
    for (const mode of ["ask", "auto", "workspace"] as const) {
      setPermissionMode(mode);
      const out = await subTerminal(new MemoryJournal()).execute({ action: "send", sessionId: "nope", command: "git stash" });
      expect({ mode, blocked: out.includes("子代理禁止执行 git 写操作") && out.includes("git stash") }).toEqual({ mode, blocked: true });
    }
    setPermissionMode("ask");
  });

  it("子代理 terminal 只读命令不被 git 守卫拦(`cat /etc/hostname` 在 ask 档仍落到下游会话错误)", async () => {
    setPermissionMode("ask");
    const out = await subTerminal(new MemoryJournal()).execute({ action: "send", sessionId: "nope", command: "git status" });
    expect(out).not.toContain("子代理禁止执行 git 写操作");
  });

  it("子代理 run_cmd(走 runOne)`git stash` 被拒,execFile 零调用", async () => {
    let step = 0;
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    const llm = {
      async chat() {
        step++;
        if (step === 1) return { content: "", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "git stash" }) }] };
        return { content: "done git 守卫探针" };
      },
    } as never;
    const backend = new LlmLoopBackend({ llm, roots: [dir], workdir: dir, role: "worker", stallTimeoutMs: 30_000, onLoopEvent: (e) => { events.push(e); } });
    let done = false;
    await backend.spawn({ taskId: "gitguard", instructions: "git 守卫探针", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") done = true; });
    for (let t = 0; t < 200 && !done; t++) await new Promise((r) => setTimeout(r, 50));
    const tr = events.find((e) => e.kind === "tool.result" && e.payload.name === "run_cmd");
    const content = String(tr?.payload.content ?? "");
    expect(content).toContain("子代理禁止执行 git 写操作");
    expect(content).toContain("stash");
    expect(execCalls.n).toBe(0);
  }, 30_000);
});

describe("主 agent 面:放行但审计留痕(custom/git.audit)", () => {
  it("命中 git stash → journal 出现一条 custom/git.audit(带 cmd/subcommand/destructive)", () => {
    const journal = new MemoryJournal();
    auditGitCommand(journal, "sess-1", "git stash");
    const ev = journal.readAll().find((e) => e.kind === "custom");
    expect(ev).toBeTruthy();
    const p = ev!.payload as { type?: string; cmd?: string; subcommand?: string; destructive?: boolean; at?: number };
    expect(p.type).toBe("git.audit");
    expect(p.cmd).toBe("git stash");
    expect(p.subcommand).toBe("stash");
    expect(p.destructive).toBe(true);
    expect(typeof p.at).toBe("number");
  });

  it("只读命令 / 非 git 命令 → 不落审计(不污染 journal)", () => {
    const journal = new MemoryJournal();
    for (const cmd of ["git status", "git log --grep=stash", "pnpm test", "echo git stash"]) auditGitCommand(journal, "sess-1", cmd);
    expect(journal.readAll().filter((e) => e.kind === "custom")).toHaveLength(0);
  });

  it("非破坏 git 写(git commit)也审计,但 destructive=false", () => {
    const journal = new MemoryJournal();
    const v = auditGitCommand(journal, "sess-1", "git commit -m 'x'");
    expect(v?.write).toBe(true);
    const p = journal.readAll()[0]!.payload as { destructive?: boolean; subcommand?: string };
    expect(p.destructive).toBe(false);
    expect(p.subcommand).toBe("commit");
  });
});
