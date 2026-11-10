/**
 * 非 git 目录降级:
 * isGitRepo 先验;读类(status/branches)回空结果+norepo 标记(面板免报错),写类回 git-norepo 跳过提示。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startGatewayServer } from "../src/server.js";
import { TaskSupervisor } from "../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import type { ProjectRegistry } from "../src/projects.js";
import { isGitRepo } from "../src/git-service.js";

describe("isGitRepo 先验", () => {
  it("仓内目录=true,普通目录=false(不抛错)", async () => {
    expect(await isGitRepo(process.cwd())).toBe(true); // apps/gateway 在 harness 仓工作树内
    const dir = mkdtempSync(join(tmpdir(), "gw-norepo-"));
    try {
      expect(await isGitRepo(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WS 面:非 git 激活项目的降级", () => {
  it("git.status/branches→空结果+norepo;git.commit→git-norepo 错误码", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-norepo-ws-"));
    try {
      const stubProjects = {
        activeId: () => "p1",
        resolveWorkdir: () => dir, // 非 git 目录
        list: () => [],
      } as unknown as ProjectRegistry;
      const port = 7898;
      const srv = startGatewayServer({ port, taskManager: new TaskSupervisor(), journal: new MemoryJournal(), projects: stubProjects });
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const inbox: Record<string, unknown>[] = [];
      ws.on("message", (r) => inbox.push(JSON.parse(r.toString()) as Record<string, unknown>));
      await new Promise((r) => ws.on("open", r));

      const send = (o: object) => ws.send(JSON.stringify({ v: 1, ...o }));
      const waitType = (t: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${t} 超时`)), 10_000);
          const p = setInterval(() => {
            const m = inbox.find((x) => x.type === t);
            if (m) { clearTimeout(timer); clearInterval(p); resolve(m); }
          }, 25);
        });

      send({ type: "git.status" });
      const st = await waitType("git.status.result");
      expect(st.norepo).toBe(true);
      expect(st.branch).toBe("");
      expect(st.changes).toEqual([]);

      send({ type: "git.branches" });
      const br = await waitType("git.branches.result");
      expect(br.norepo).toBe(true);
      expect(br.branches).toEqual([]);

      send({ type: "git.commit", message: "x" });
      const err = await waitType("error");
      expect(err.code).toBe("git-norepo");

      ws.close();
      srv.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
