/**
 * 成熟面板件:diffstat/stats/scope/思考链路/权限模式/startedAt 单测。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { diffstat } from "../src/git-service.js";
import { computeStatsSummary } from "../src/stats.js";
import { AutomationStore } from "../src/automations.js";
import { setPermissionMode, permissionMode } from "../src/permission-mode.js";
import { MemoryJournal } from "@lampgenie/core";
import { TaskSupervisor } from "../src/task-manager.js";

function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gwdiff-"));
  const g = (args: string) => execSync(`git ${args}`, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
  g("init -q");
  g('config user.email "t@t"'); g('config user.name "t"');
  writeFileSync(join(dir, "a.txt"), "line1" + "\n");
  g("add -A"); g("commit -qm base");
  return dir;
}

describe("diffstat(内联变更条数据源)", () => {
  it("修改文件 → numstat 汇总(未跟踪文件不计,与 checkpoint 语义对齐)", async () => {
    const dir = tmpGitRepo();
    try {
      writeFileSync(join(dir, "a.txt"), "line1" + "\nline2" + "\n"); // stash 前已改 +1
      writeFileSync(join(dir, "b.txt"), "x" + "\n"); // 未跟踪:stash/diff 都不含
      const sha = execSync("git stash create", { cwd: dir }).toString().trim();
      expect(sha.length).toBeGreaterThan(0);
      writeFileSync(join(dir, "a.txt"), "line1" + "\nline2" + "\nline3" + "\n"); // stash 后再 +1
      const st = await diffstat(dir, sha);
      expect(st.total.files).toBe(1);
      expect(st.total.add).toBe(1);
      expect(st.files[0].path).toBe("a.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("无差异 → 空(面板隐藏变更条)", async () => {
    const dir = tmpGitRepo();
    try {
      const sha = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
      const st = await diffstat(dir, sha);
      expect(st.total.files).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeStatsSummary(使用统计归约)", () => {
  it("journal 归约:轮次/token/热力图/会话表/工作时长", () => {
    const j = new MemoryJournal();
    const tm = new TaskSupervisor();
    const t0 = Date.now() - 3600_000;
    j.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 }, time: t0 } as never);
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "hi", usage: { inputTokens: 100, outputTokens: 50 } }, time: t0 + 1000 } as never);
    j.append({ kind: "tool.result", sessionId: "s1", payload: { toolCallId: "c1", name: "x", content: "" }, time: t0 + 2000 } as never);
    const task = tm.submit("user", "s1", "做点事", {});
    // submit 内部 drain 已自动 queued→running;补终态(workMs=updatedAt-startedAt)。
    const cur = tm.get(task.id)!;
    const final = cur.state === "queued" ? tm.setState(cur, "running") : cur;
    tm.setState(final, "done", "ok");
    const s = computeStatsSummary(j, tm, 30);
    expect(s.totals.turns).toBe(1);
    expect(s.totals.llmCalls).toBe(1);
    expect(s.totals.toolCalls).toBe(1);
    expect(s.totals.tokens.total).toBe(150);
    expect(s.totals.tasks).toBe(1);
    expect(s.totals.tasksDone).toBe(1);
    expect(s.totals.sessions).toBe(1);
    expect(s.totals.workMs).toBeGreaterThanOrEqual(0);
    expect(s.perDay.length).toBe(30);
    expect(s.heatmap.length).toBe(7);
    expect(s.heatmap.every((row) => row.length === 24)).toBe(true);
    expect(s.sessions[0].sessionId).toBe("s1".slice(0, 12));
  });
  it("空 journal → 全零不炸", () => {
    const s = computeStatsSummary(new MemoryJournal(), new TaskSupervisor(), 7);
    expect(s.totals.turns).toBe(0);
    expect(s.perDay.length).toBe(7);
  });
});

describe("自动化 scope(全局/项目分栏)", () => {
  it("create 带 scope 持久化;无 scope=全局语义", () => {
    const dir = mkdtempSync(join(tmpdir(), "gwauto-"));
    try {
      const store = new AutomationStore(join(dir, "automations.json"));
      const a1 = store.create({ name: "全局巡检", instruction: "巡检", everyMinutes: 30 });
      const a2 = store.create({ name: "项目健康", instruction: "健康", everyMinutes: 20, scope: "proj-1" });
      expect((a1 as { scope?: string }).scope).toBeUndefined();
      expect((a2 as { scope?: string }).scope).toBe("proj-1");
      // 重载持久化
      const store2 = new AutomationStore(join(dir, "automations.json"));
      const list = store2.list();
      expect(list.find((x) => x.name === "项目健康")?.scope).toBe("proj-1");
      expect(list.find((x) => x.name === "全局巡检")?.scope ?? "global").toBe("global");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("权限模式(输入区下拉)", () => {
  it("setPermissionMode 三态与非法回退 ask", () => {
    setPermissionMode("auto");
    expect(permissionMode()).toBe("auto");
    setPermissionMode("readonly");
    expect(permissionMode()).toBe("readonly");
    setPermissionMode("bogus");
    expect(permissionMode()).toBe("ask");
    setPermissionMode(undefined);
    expect(permissionMode()).toBe("ask");
  });
});
