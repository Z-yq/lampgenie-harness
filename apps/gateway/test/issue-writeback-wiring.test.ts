/**
 *  回写接线测试:真 RepoIssues + 临时目录 + 假 journal,探针 A-F。
 * 跑法:cd apps/gateway && NODE_OPTIONS=--conditions=development npx vitest run test/issue-writeback-wiring.test.ts
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoIssues, writeBackIssueTask, type IssueChannel, type IssueRecord } from "../src/issue-service.js";
import type { JournalEventLike, JournalLike } from "../src/issue-task-link.js";

interface FakeJournal extends JournalLike {
  events: JournalEventLike[];
}

function fakeJournal(): FakeJournal {
  const events: JournalEventLike[] = [];
  return {
    events,
    readAll: () => events.slice(),
    append: (e) => {
      const ev = { ...e, seq: events.length, time: 0 } as JournalEventLike;
      events.push(ev);
      return ev;
    },
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "m91-"));
}

function issueFileOf(root: string, n: number): string {
  return join(root, ".genie", "issues", `ISSUE-${n}.json`);
}

function readIssue(root: string, n: number): IssueRecord {
  return JSON.parse(readFileSync(issueFileOf(root, n), "utf-8")) as IssueRecord;
}

/** update 必抛错的通道(验证失败可重试且不落幂等事件)。 */
function flakyChannel(inner: RepoIssues, failUpdate: boolean): IssueChannel {
  return {
    kind: "repo",
    list: () => inner.list(),
    create: (input) => inner.create(input),
    update: async (projectId, number, patch) => {
      if (failUpdate) throw new Error("boom: update failed");
      return inner.update(projectId, number, patch);
    },
    comment: (projectId, number, author, body) => inner.comment(projectId, number, author, body),
  };
}

describe("探针 A:completed → status done + comment + 事件", () => {
  it("真 RepoIssues 落盘:状态置 done、评论含 taskId/终态、journal 落一条回写事件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "修登录" });
      await repo.update("p1", created.number, { status: "doing" });
      const journal = fakeJournal();
      const r = await writeBackIssueTask(repo, {
        projectId: "p1",
        number: created.number,
        taskId: "t-A",
        state: "completed",
        journal,
        sessionId: "s-A",
      });
      expect(r).toMatchObject({ ok: true, code: "OK", written: true });
      const rec = readIssue(root, created.number);
      expect(rec.status).toBe("done");
      expect(rec.comments.some((c) => c.body.includes("t-A") && c.body.includes("completed"))).toBe(true);
      expect(journal.events).toHaveLength(1);
      const payload = journal.events[0]!.payload as Record<string, unknown>;
      expect(payload.type).toBe("issue.task.writeback");
      expect(payload.key).toBe(`issue-writeback:t-A:${created.number}`);
      expect(payload.state).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("探针 B:同 key 第二次 → DUPLICATE 且文件未再变", () => {
  it("第二次不再写盘、不再追加事件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "边界" });
      const journal = fakeJournal();
      const input = {
        projectId: "p1",
        number: created.number,
        taskId: "t-B",
        state: "completed",
        journal,
        sessionId: "s-B",
      };
      const first = await writeBackIssueTask(repo, input);
      expect(first.code).toBe("OK");
      const before = readFileSync(issueFileOf(root, created.number), "utf-8");
      const second = await writeBackIssueTask(repo, input);
      expect(second).toMatchObject({ ok: true, code: "DUPLICATE", written: false });
      expect(readFileSync(issueFileOf(root, created.number), "utf-8")).toBe(before);
      expect(journal.events).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("探针 C:failed → status 不变 + comment", () => {
  it("状态保留 doing,追加失败评论", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "失败场景" });
      await repo.update("p1", created.number, { status: "doing" });
      const journal = fakeJournal();
      const r = await writeBackIssueTask(repo, {
        projectId: "p1",
        number: created.number,
        taskId: "t-C",
        state: "failed",
        journal,
        sessionId: "s-C",
      });
      expect(r.code).toBe("OK");
      const rec = readIssue(root, created.number);
      expect(rec.status).toBe("doing");
      expect(rec.comments).toHaveLength(1);
      expect(rec.comments[0]!.body).toContain("t-C");
      expect(rec.comments[0]!.body).toContain("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("探针 D:cancelled → 不改 status + comment", () => {
  it("状态保留,追加取消评论", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "取消场景" });
      const journal = fakeJournal();
      const r = await writeBackIssueTask(repo, {
        projectId: "p1",
        number: created.number,
        taskId: "t-D",
        state: "cancelled",
        journal,
        sessionId: "s-D",
      });
      expect(r.code).toBe("OK");
      const rec = readIssue(root, created.number);
      expect(rec.status).toBe("todo");
      expect(rec.comments[0]!.body).toContain("cancelled");
      expect(rec.comments[0]!.body).toContain("t-D");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("探针 E:无 issue → NOT_FOUND", () => {
  it("不存在的 number 不写盘、不落事件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const journal = fakeJournal();
      const r = await writeBackIssueTask(repo, {
        projectId: "p1",
        number: 999,
        taskId: "t-E",
        state: "completed",
        journal,
        sessionId: "s-E",
      });
      expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
      expect(journal.events).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("探针 F:server 源码接线", () => {
  const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf-8");

  it("终态 onChange 调 writeBackIssueTask + findIssueByTask", () => {
    expect(serverSrc).toContain("M91:Issue 终态回写");
    const idx = serverSrc.indexOf("M91:Issue 终态回写");
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 1200);
    expect(block).toContain("findIssueByTask");
    expect(block).toContain("writeBackIssueTask");
    expect(block).toContain('"completed"');
  });

  it("task.detail.get 结果含 issue 查找", () => {
    const idx = serverSrc.indexOf('case "task.detail.get"');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx, idx + 800);
    expect(block).toContain("findIssueByTask");
    expect(block).toContain("issue");
  });
});

describe("失败可重试(不落幂等事件)", () => {
  it("update 抛错 → INVALID 且 journal 空;换正常通道重试 → OK 且只有 1 条事件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "重试" });
      const journal = fakeJournal();
      const input = {
        projectId: "p1",
        number: created.number,
        taskId: "t-retry",
        state: "completed",
        journal,
        sessionId: "s-retry",
      };
      const bad = await writeBackIssueTask(flakyChannel(repo, true), input);
      expect(bad).toMatchObject({ ok: false, code: "INVALID" });
      expect(journal.events).toHaveLength(0);
      expect(readIssue(root, created.number).status).toBe("todo");
      const good = await writeBackIssueTask(repo, input);
      expect(good).toMatchObject({ ok: true, code: "OK", written: true });
      expect(journal.events).toHaveLength(1);
      expect(readIssue(root, created.number).status).toBe("done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("issue 已 done(无 journal 事件)→ plan 层 DUPLICATE,不写事件", async () => {
    const root = tmpRoot();
    try {
      const repo = new RepoIssues(root);
      const created = await repo.create({ projectId: "p1", title: "已终态" });
      await repo.update("p1", created.number, { status: "done" });
      const journal = fakeJournal();
      const r = await writeBackIssueTask(repo, {
        projectId: "p1",
        number: created.number,
        taskId: "t-done",
        state: "completed",
        journal,
        sessionId: "s-done",
      });
      expect(r).toMatchObject({ ok: true, code: "DUPLICATE", written: false });
      expect(journal.events).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
