/**
 * 验收钩子已下线:「code review 不要自动触发,
 * 应当由 coding agent 来触发」——非 coding 任务(规划/问答)done 不再弹代码评论卡。
 * 本文件从「钩子行为测试」改为「下线回归测试」:task done 后 journal 零 review.findings。
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp, type GatewayApp } from "../src/app.js";
import { EchoChildBackend } from "@lampgenie/executors";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-hook-"));
  const g = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir });
  g("init -q"); g('config user.email t@t'); g('config user.name t');
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add ."); g('commit -qm "init"');
  return dir;
}

describe("验收钩子下线", () => {
  it("脏工作区 + 任务 done:journal 零 review.findings(自动触发已移除,不弹评论卡)", async () => {
    const dir = gitRepo();
    appendFileSync(join(dir, "a.ts"), "+console.log('dbg')\n"); // 脏工作区:旧钩子必产 findings
    let app: GatewayApp | null = null;
    try {
      app = createGatewayApp({ port: 7798, executor: new EchoChildBackend() });
      const proj = app.projects.add(dir);
      if (!proj.ok) throw new Error("项目注册失败: " + proj.reason);
      const t = app.taskManager.submit("user", "sess-hook-off", "验收钩子下线验证", { projectId: proj.project.id });
      for (let i = 0; i < 40 && app.taskManager.get(t.id)?.state !== "done"; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(app.taskManager.get(t.id)?.state).toBe("done");
      // 旧钩子是 done 后异步落 journal:给足窗口再断言零事件(防「晚到误绿」反义假阳性)
      await new Promise((r) => setTimeout(r, 2500));
      const evs = app.journal.readAll().filter((e) => e.kind === "review.findings");
      expect(evs).toHaveLength(0);
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
