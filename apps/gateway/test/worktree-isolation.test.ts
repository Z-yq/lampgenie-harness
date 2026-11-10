/**
 * step-123 worktree 隔离验收:
 * ① 服务层:创建/列表/并行/删除保留分支/TTL 清理/非 git/上限/围栏;
 * ② 接线层:spawn_subagent({worktree:true}) 真跑子代理,验证独立工作树、主仓无改动、
 *    并行两个子代理同名文件互不干扰、结果与 journal 带 path/branch、清理命令语义。
 *
 * 不使用真实 LLM:mock LlmProvider 按任务书标记路由(主 agent 派发 / 子代理执行 run_cmd)。
 * git 操作只在本测试 mkdtemp 出来的临时仓内执行(不在 harness 仓建 worktree)。
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { WorktreeError, WorktreeService } from "../src/worktree-service.js";

// plan-gate 豁免(2026-10-21):本文件测 reaper/worktree/会话纪律基础设施,不涉及规划流程
process.env.GENIE_PLAN_GATE = "off";
// 任务终态档案会写主仓 .genie/task-archive.jsonl(污染「主仓干净」断言)——用例后清理
import { rmSync } from "node:fs";
afterAll(() => { try { rmSync(join(process.cwd(), "..", "..", ".genie", "task-archive.jsonl"), { force: true }); } catch { /* 无害 */ } });


const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "genie-wt-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "worktree-test@example.invalid");
  git(root, "config", "user.name", "Worktree Test");
  writeFileSync(join(root, "README.md"), "# fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorktreeService(step-123 服务层)", () => {
  it("创建=独立工作树(路径/分支/.git 文件),主仓干净;并行两个互不干扰", async () => {
    const repo = makeRepo();
    const svc = new WorktreeService({ maxWorktrees: 8 });
    const [a, b] = await Promise.all([
      svc.create({ cwd: repo, id: "agent_a" }),
      svc.create({ cwd: repo, id: "agent_b" }),
    ]);
    expect(a.path).toBe(join(repo, ".genie", "worktrees", "agent_a"));
    expect(a.branch).toBe("genie/agent_a");
    expect(b.path).not.toBe(a.path);
    expect(b.branch).not.toBe(a.branch);
    // 独立工作树:目录存在,`.git` 是文件(gitdir 指针),toplevel=自身
    for (const info of [a, b]) {
      expect(existsSync(info.path)).toBe(true);
      expect(readFileSync(join(info.path, ".git"), "utf-8")).toContain("gitdir:");
      expect(git(info.path, "rev-parse", "--show-toplevel").trim()).toBe(info.path);
      expect(git(repo, "branch", "--list", info.branch).trim()).toContain(info.branch);
    }
    // 并行各自写同名文件,互不覆盖
    writeFileSync(join(a.path, "shared.txt"), "A\n");
    writeFileSync(join(b.path, "shared.txt"), "B\n");
    expect(readFileSync(join(a.path, "shared.txt"), "utf-8")).toBe("A\n");
    expect(readFileSync(join(b.path, "shared.txt"), "utf-8")).toBe("B\n");
    // 主工作区无改动、无该文件
    expect(existsSync(join(repo, "shared.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect((await svc.list({ cwd: repo })).map((x) => x.id).sort()).toEqual(["agent_a", "agent_b"]);
  }, 30_000);

  it("remove=移除 worktree 且保留分支;cleanup(ttl=0)=清剩余 worktree 仍保留分支", async () => {
    const repo = makeRepo();
    const svc = new WorktreeService();
    const a = await svc.create({ cwd: repo, id: "agent_rm" });
    const b = await svc.create({ cwd: repo, id: "agent_ttl" });
    const removed = await svc.remove({ cwd: repo, id: a.id });
    expect(removed.removed).toBe(true);
    expect(removed.branchKept).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect(git(repo, "branch", "--list", a.branch).trim()).toContain(a.branch);

    const cleaned = await svc.cleanup({ cwd: repo, ttlMs: 0 });
    expect(cleaned.removed.map((x) => x.id)).toEqual([b.id]);
    expect(existsSync(b.path)).toBe(false);
    expect(git(repo, "branch", "--list", "genie/agent_ttl").trim()).toContain("genie/agent_ttl");
    expect(await svc.list({ cwd: repo })).toEqual([]);
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 30_000);

  it("非 git 仓=NOT_GIT 明确报错(不静默回退);路径围栏拒绝池外路径;上限生效", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "genie-wt-nongit-"));
    roots.push(nonGit);
    const svc = new WorktreeService();
    await expect(svc.create({ cwd: nonGit, id: "x" })).rejects.toMatchObject({ code: "NOT_GIT" });

    const repo = makeRepo();
    const limited = new WorktreeService({ maxWorktrees: 1 });
    await limited.create({ cwd: repo, id: "agent_one" });
    await expect(limited.create({ cwd: repo, id: "agent_two" })).rejects.toMatchObject({ code: "LIMIT" });

    const outside = mkdtempSync(join(tmpdir(), "genie-wt-outside-"));
    roots.push(outside);
    await expect(svc.remove({ cwd: repo, path: outside })).rejects.toBeInstanceOf(WorktreeError);
    // 名字清洗:路径穿越片段被折成安全目录名(仍在池内)
    const tricky = await svc.create({ cwd: repo, id: "../../evil" });
    expect(tricky.path.startsWith(join(repo, ".genie", "worktrees"))).toBe(true);
    expect(tricky.id).toBe("evil");
  }, 30_000);
});

describe("spawn_subagent worktree 接线(step-123)", () => {
  const envBackup = {
    rules: process.env.GENIE_PERMISSION_RULES,
    ask: process.env.GENIE_PERM_ASK_MODE,
    subAsk: process.env.GENIE_SUBAGENT_ASK,
  };
  afterEach(() => {
    if (envBackup.rules === undefined) delete process.env.GENIE_PERMISSION_RULES;
    else process.env.GENIE_PERMISSION_RULES = envBackup.rules;
    if (envBackup.ask === undefined) delete process.env.GENIE_PERM_ASK_MODE;
    else process.env.GENIE_PERM_ASK_MODE = envBackup.ask;
    if (envBackup.subAsk === undefined) delete process.env.GENIE_SUBAGENT_ASK;
    else process.env.GENIE_SUBAGENT_ASK = envBackup.subAsk;
  });

  /** mock LLM:子代理按任务书标记走 run_cmd 写文件;主 agent 首步并发派两个子代理。 */
  function makeLlm(mode: "parallel" | "background") {
    const childCalls = new Map<string, number>();
    let mainCalls = 0;
    return {
      async chat(messages: { role: string; content: string }[]) {
        const text = JSON.stringify(messages);
        // 子代理上下文由 LlmLoopBackend 构造,系统提示带固定身份行;主代理带 vibe coding 身份。
        const isChild = messages.some((m) => m.role === "system" && String(m.content).includes("独立上下文,与主 agent 不共享历史"));
        if (isChild) {
          const marker = ["TASK-A", "TASK-B"].find((m) => text.includes(m));
          if (!marker) return { content: "child-no-marker" };
          const n = (childCalls.get(marker) ?? 0) + 1;
          childCalls.set(marker, n);
          if (n === 1) {
            return {
              content: "",
              toolCalls: [{
                id: `${marker}-cmd`,
                name: "run_cmd",
                arguments: JSON.stringify({ command: `printf '${marker.slice(-1)}' > shared.txt` }),
              }],
            };
          }
          return { content: `${marker} done` };
        }
        mainCalls += 1;
        if (mainCalls === 1) {
          const spawn = (marker: string) => ({
            id: marker.toLowerCase(),
            name: "spawn_subagent",
            arguments: JSON.stringify({
              instructions: `${marker}: 在当前工作目录写 shared.txt`,
              title: marker,
              worktree: true,
              ...(mode === "background" ? { run_in_background: true } : {}),
            }),
          });
          return { content: "", toolCalls: [spawn("TASK-A"), spawn("TASK-B")] };
        }
        return { content: "both done" };
      },
    };
  }

  it("前台并行:两个子代理各自 worktree 写同名文件,主仓干净;结果/journal 带 path+branch 且分支保留", async () => {
    process.env.GENIE_PERMISSION_RULES = "[]";
    process.env.GENIE_PERM_ASK_MODE = "allow";
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    const repo = makeRepo();
    const app = createGatewayApp({
      port: 0,
      llm: makeLlm("parallel") as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    try {
      const project = app.projects.add(repo);
      expect(project.ok).toBe(true);
      if (!project.ok) throw new Error(project.reason);
      app.taskManager.submit("user", "wt-parallel", "两个子代理并行写文件", { projectId: project.project.id });
      let state = "";
      for (let i = 0; i < 150; i += 1) {
        state = app.taskManager.list().find((x) => x.sessionId === "wt-parallel")?.state ?? "";
        if (state === "done" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe("done");

      const events = app.journal.readAll().filter((e) => e.sessionId === "wt-parallel");
      const creates = events.filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "worktree.create");
      expect(creates).toHaveLength(2);
      const spawns = events.filter((e) => e.kind === "subagent.spawn");
      expect(spawns).toHaveLength(2);
      const worktrees = spawns.map((e) => (e.payload as { worktree?: { path: string; branch: string } }).worktree);
      expect(worktrees.every((w) => !!w?.path && !!w?.branch)).toBe(true);
      for (const wt of worktrees as { path: string; branch: string }[]) {
        expect(wt.path.startsWith(join(repo, ".genie", "worktrees"))).toBe(true);
        expect(wt.branch.startsWith("genie/")).toBe(true);
        expect(existsSync(wt.path)).toBe(true);
        expect(git(repo, "branch", "--list", wt.branch).trim()).toContain(wt.branch);
      }
      // 两个 worktree 各自写成功、同名文件内容不同;主工作区完全没有 shared.txt
      const contents = (worktrees as { path: string }[]).map((w) => readFileSync(join(w.path, "shared.txt"), "utf-8")).sort();
      expect(contents).toEqual(["A", "B"]);
      expect(existsSync(join(repo, "shared.txt"))).toBe(false);
      // 主工作区:无 tracked 改动、无 shared.txt、无 worktree 池泄漏到 status。
      // (未跟踪的 .genie/sense-index 是 harness 任务开工预热的既有行为,与 worktree 无关)
      // 任务终态档案写 .genie/task-archive.jsonl(断言前清,防污染「主仓干净」)
      try { rmSync(join(repo, ".genie", "task-archive.jsonl"), { force: true }); } catch { /* 无害 */ }
      const statusAll = git(repo, "status", "--porcelain", "--untracked-files=all");
      expect(statusAll).not.toContain("shared.txt");
      expect(statusAll).not.toContain(".genie/worktrees");
      expect(statusAll.split("\n").filter((l) => l && !l.includes(".genie/sense-index"))).toEqual([]);
      expect(git(repo, "diff", "--name-only").trim()).toBe("");
      // 工具结果回带 worktree 路径/分支(前台最终文本尾部)
      const spawnResults = events.filter((e) => e.kind === "tool.result" && (e.payload as { name?: string }).name === "spawn_subagent");
      expect(String((spawnResults[0]?.payload as { content?: string }).content)).toContain("[worktree]");
      expect(String((spawnResults[0]?.payload as { content?: string }).content)).toContain("genie/");

      // 验收 ④:统一清理命令移除 worktree、分支保留
      const svc = new WorktreeService();
      const removed = await svc.remove({ cwd: repo, id: (worktrees[0] as { path: string }).path.split("/").pop()! });
      expect(removed.removed).toBe(true);
      expect(removed.branchKept).toBe(true);
      expect(existsSync((worktrees[0] as { path: string }).path)).toBe(false);
      expect(git(repo, "branch", "--list", (worktrees[0] as { branch: string }).branch).trim()).toContain((worktrees[0] as { branch: string }).branch);
    } finally {
      await app.close();
    }
  }, 90_000);

  it("后台模式:返回 async_launched 带 worktree 字段;output.txt 首段含 worktree;清理后分支仍在", async () => {
    process.env.GENIE_PERMISSION_RULES = "[]";
    process.env.GENIE_PERM_ASK_MODE = "allow";
    process.env.GENIE_SUBAGENT_ASK = "allow-once";
    const repo = makeRepo();
    const app = createGatewayApp({
      port: 0,
      llm: makeLlm("background") as never,
      executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
      useExternalHttp: true,
    });
    try {
      const project = app.projects.add(repo);
      if (!project.ok) throw new Error(project.reason);
      app.taskManager.submit("user", "wt-bg", "后台子代理各写文件", { projectId: project.project.id });
      let state = "";
      for (let i = 0; i < 150; i += 1) {
        state = app.taskManager.list().find((x) => x.sessionId === "wt-bg")?.state ?? "";
        if (state === "done" || state === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(state).toBe("done");

      const events = app.journal.readAll().filter((e) => e.sessionId === "wt-bg");
      const results = events.filter((e) => e.kind === "tool.result" && (e.payload as { name?: string }).name === "spawn_subagent");
      const parsed = results.map((e) => JSON.parse(String((e.payload as { content?: string }).content)) as {
        status?: string; agentId?: string; outputFile?: string; worktree?: { path: string; branch: string };
        worktreePath?: string; worktreeBranch?: string;
      });
      expect(parsed.every((p) => p.status === "async_launched" && !!p.worktree?.path && !!p.agentId)).toBe(true);
      // 结果字段契约:worktree.path/branch 与顶层 worktreePath/worktreeBranch 同时在
      expect(parsed.every((p) => p.worktreePath === p.worktree?.path && p.worktreeBranch === p.worktree?.branch)).toBe(true);
      // 后台子代理在 spawn 返回后仍继续跑:等两个 worktree 都写完 shared.txt(≤20s)
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !parsed.every((p) => existsSync(join(p.worktree!.path, "shared.txt")))) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // 后台子代理真在独立工作树写完文件
      for (const p of parsed) {
        const out = readFileSync(join(p.worktree!.path, "shared.txt"), "utf-8");
        expect(["A", "B"]).toContain(out.trim());
        const outputText = readFileSync(p.outputFile!, "utf-8");
        expect(outputText).toContain("[worktree] path=");
      }
      expect(git(repo, "status", "--porcelain", "--untracked-files=all")).not.toContain(".genie/worktrees");
      expect(git(repo, "diff", "--name-only").trim()).toBe("");
      const svc = new WorktreeService();
      const cleanup = await svc.cleanup({ cwd: repo, ttlMs: 0 });
      expect(cleanup.removed).toHaveLength(2);
      const branches = git(repo, "branch", "--list", "genie/*");
      expect(branches.trim().split(/\n+/).filter(Boolean)).toHaveLength(2);
    } finally {
      await app.close();
    }
  }, 90_000);
});
