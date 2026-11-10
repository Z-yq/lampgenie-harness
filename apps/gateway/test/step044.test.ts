/**
 * checkpoint 快照/预览/回滚(真实 git 仓)+自动归档清扫+经验禁用过滤。
 */
import { describe, it, expect } from "vitest";
import { checkpointCreate, checkpointPreview, checkpointRewind } from "../src/git-service.js";
import { ExperienceStore } from "@lampgenie/experience";
import { TaskSupervisor } from "../src/task-manager.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const gitP = (args: string[], cwd: string) => promisify(execFile)("git", args, { cwd }).then((r) => r.stdout);

describe("checkpoint 回滚", () => {
  it("全链:变更→快照→再改→rewind→内容恢复快照态;无变更→null", async () => {
    const root = mkdtempSync(join(tmpdir(), "ckpt-"));
    await gitP(["init", "-b", "main"], root);
    writeFileSync(join(root, "a.txt"), "v1\n");
    await gitP(["-c", "user.email=t@l", "-c", "user.name=t", "add", "-A"], root);
    await gitP(["-c", "user.email=t@l", "-c", "user.name=t", "commit", "-m", "init"], root);

    // 无变更 → null
    expect(await checkpointCreate(root)).toBeNull();

    // 变更 → 快照(a.txt=快照值)
    writeFileSync(join(root, "a.txt"), "v2-快照态\n");
    const sha = await checkpointCreate(root);
    expect(sha).toBeTruthy();

    // 再改 + 新增未跟踪
    writeFileSync(join(root, "a.txt"), "v3-被回滚\n");
    writeFileSync(join(root, "new-untracked.txt"), "保留\n");

    const files = await checkpointPreview(root, sha!);
    expect(files).toContain("a.txt");
    expect(files).not.toContain("new-untracked.txt"); // 预览对齐回滚语义(不动 untracked)

    const n = await checkpointRewind(root, sha!);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await import("node:fs")).readFileSync(join(root, "a.txt"), "utf-8")).toBe("v2-快照态\n");
    expect((await import("node:fs")).existsSync(join(root, "new-untracked.txt"))).toBe(true); // untracked 保留(登记边界)
    rmSync(root, { recursive: true, force: true });
  }, 20_000);

  it("非 git 目录→null 不炸", async () => {
    const root = mkdtempSync(join(tmpdir(), "ckpt-ng-"));
    expect(await checkpointCreate(root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("经验禁用", () => {
  it("disable→index/disabledEntries 分流→enable 恢复;recall 走 index 自动排除", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expd-"));
    const store = new ExperienceStore(join(dir, "exp"));
    await store.write({ category: "coding", name: "tip-a", description: "构建技巧", created_by: "agent" }, "内容 A");
    await store.write({ category: "coding", name: "tip-b", description: "调试技巧", created_by: "agent" }, "内容 B");
    expect(store.index()).toHaveLength(2);
    store.setStatus("coding", "tip-a", "disabled");
    expect(store.index().map((x) => x.name)).toEqual(["tip-b"]); // 注入面排除
    expect(store.disabledEntries()).toEqual([{ category: "coding", name: "tip-a" }]); // 恢复入口可见
    const { recallExperiences } = await import("@lampgenie/experience");
    const recalled = recallExperiences(store, "构建技巧怎么搞");
    expect(recalled.some((r) => r.name === "tip-a")).toBe(false); // 开工注入不召回禁用条
    store.setStatus("coding", "tip-a", "active");
    expect(store.index()).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("自动归档清扫", () => {
  it("终态+超阈值→归档;运行中/新任务/已归档不动;0 天=关", () => {
    const tm = new TaskSupervisor();
    const t1 = tm.submit("user", "s", "旧的完成了");
    tm.setState(t1, "done", "ok");
    // 回拨 updatedAt(模拟 N 天前)
    (tm as unknown as { tasks: Map<string, { updatedAt: number }> }).tasks.get(t1.id)!.updatedAt = Date.now() - 40 * 86_400_000;
    const t2 = tm.submit("user", "s", "新的完成了");
    tm.setState(t2, "done", "ok");
    const t3 = tm.submit("user", "s", "还在跑的");

    // 与 app.ts 清扫器同构的内联判定
    const sweep = (days: number) => {
      if (!days) return 0;
      const cutoff = Date.now() - days * 86_400_000;
      let n = 0;
      for (const t of tm.list()) {
        if (!t.archived && (t.state === "done" || t.state === "failed" || t.state === "cancelled") && t.updatedAt < cutoff) {
          if (tm.setArchived(t.id, true)) n++;
        }
      }
      return n;
    };
    expect(sweep(0)).toBe(0); // 关
    expect(sweep(30)).toBe(1); // 只归档旧的终态
    expect(tm.get(t1.id)?.archived).toBe(true);
    expect(tm.get(t2.id)?.archived).toBeUndefined();
    expect(tm.get(t3.id)?.archived).toBeUndefined();
  });
});
