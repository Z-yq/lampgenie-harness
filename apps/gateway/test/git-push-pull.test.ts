/**
 * 二期 git push/pull 服务面:真实 git 仓(bare 远端 + 双克隆)走 push→pull 全链,
 * WS 面走 additive 协议消息(git.push/git.pull → git.ok,作用目录=激活项目工作目录)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { parseClientMessage } from "@lampgenie/protocol";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";
import { gitCommit, gitPush, gitPull, gitLog } from "../src/git-service.js";

describe("协议:git.push / git.pull(二期 additive)", () => {
  it("schema 过/缺信封拒", () => {
    expect(parseClientMessage('{"v":1,"type":"git.push"}')?.type).toBe("git.push");
    expect(parseClientMessage('{"v":1,"type":"git.push","remote":"up","branch":"dev"}')?.type).toBe("git.push");
    expect(parseClientMessage('{"v":1,"type":"git.pull"}')?.type).toBe("git.pull");
    expect(parseClientMessage('{"type":"git.push"}')).toBeNull();
  });
});

describe("gitPush/gitPull(真实 git 仓)", () => {
  it("push→bare 有提交;他仓 push 后 pull 快进到新提交", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-pushpull-"));
    try {
      const bare = join(dir, "origin.git");
      const a = join(dir, "a");
      const b = join(dir, "b");
      execFileSync("git", ["init", "--bare", bare]);
      execFileSync("git", ["clone", bare, a]);

      // A 提交 c1 并推送(缺省=当前分支→origin)
      writeFileSync(join(a, "f.txt"), "c1");
      expect(await gitCommit(a, "c1")).toMatch(/c1/);
      const pushDetail = await gitPush(a);
      expect(pushDetail).toContain("origin");
      const bareHead = execFileSync("git", ["--git-dir", bare, "log", "-1", "--format=%s"]).toString().trim();
      expect(bareHead).toBe("c1");

      // B 拿到 c1,提交 c2 推送
      execFileSync("git", ["clone", bare, b]);
      expect(readFileSync(join(b, "f.txt"), "utf-8")).toBe("c1");
      writeFileSync(join(b, "g.txt"), "c2");
      await gitCommit(b, "c2");
      await gitPush(b);

      // A pull(缺省 upstream)快进到 c2
      const pullDetail = await gitPull(a);
      expect(pullDetail).toContain("已拉取");
      const subjects = (await gitLog(a)).map((c) => c.subject);
      expect(subjects).toContain("c1");
      expect(subjects).toContain("c2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非 git 目录显式报错(与 commit 同错误语义)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-nogit-"));
    try {
      await expect(gitPush(dir)).rejects.toThrow();
      await expect(gitPull(dir)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WS 面:git.push / git.pull 处理器", () => {
  it("消息→git.ok(op=push/pull),作用目录=激活项目工作目录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-ws-git-"));
    try {
      const bare = join(dir, "origin.git");
      const workdir = join(dir, "a");
      execFileSync("git", ["init", "--bare", bare]);
      execFileSync("git", ["clone", bare, workdir]);
      writeFileSync(join(workdir, "f.txt"), "x");
      await gitCommit(workdir, "init");

      const stubProjects = {
        activeId: () => "p1",
        resolveWorkdir: () => workdir,
        list: () => [],
      } as unknown as ProjectRegistry;
      const port = 7897;
      const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: stubProjects });
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox: { type: string; op?: string; detail?: string }[] = [];
      ws.on("message", (r) => {
        const m = JSON.parse(r.toString()) as { type: string; op?: string; detail?: string };
        inbox.push(m);
        if (process.env.GW_DEBUG) console.log("[ws-in]", JSON.stringify(m).slice(0, 160));
      });
      ws.on("error", (e) => console.log("[ws-err]", e.message));
      await new Promise((r) => ws.on("open", r));

      const waitOk = (op: string) =>
        new Promise<{ type: string; op?: string; detail?: string }>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`git.ok(${op}) 超时`)), 10_000);
          const p = setInterval(() => {
            const m = inbox.find((x) => x.type === "git.ok" && x.op === op);
            if (m) {
              clearTimeout(t);
              clearInterval(p);
              resolve(m);
            }
          }, 25);
        });

      // 先 push 等回执再 pull:服务端消息并发处理,pull 依赖 push 设好的 upstream
      ws.send(JSON.stringify({ v: 1, type: "git.push" }));
      const pushOk = await waitOk("push");
      expect(pushOk.detail).toContain("origin");
      ws.send(JSON.stringify({ v: 1, type: "git.pull" }));
      const pullOk = await waitOk("pull");
      expect(pullOk.detail).toContain("已拉取");
      ws.close();
      await srv.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
