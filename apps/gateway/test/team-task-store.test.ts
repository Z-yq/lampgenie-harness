/**
 * 团队任务 DAG 单测(journal 折叠 + CAS + 依赖 + 租约 + 熔断 + 写域警告)。
 * journal 用 MemoryJournal(与生产环境同一实现类,append/readAll/seq 语义一致)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import {
  TeamTaskError,
  TeamTaskStore,
  foldTeamTasks,
  scopesOverlap,
  type Task,
} from "../src/team-task-store.js";
import { teamTaskTool } from "../src/team-task-tool.js";

function newStore(): { journal: MemoryJournal; store: TeamTaskStore } {
  const journal = new MemoryJournal();
  return { journal, store: new TeamTaskStore(journal, { sessionId: "s-team" }) };
}

/** 断言抛出 TeamTaskError 且 code 匹配,返回该错误(便于再断言 details)。 */
function expectCode(fn: () => unknown, code: string): TeamTaskError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TeamTaskError);
    expect((err as TeamTaskError).code).toBe(code);
    return err as TeamTaskError;
  }
  throw new Error(`期望抛出 ${code},实际没有抛`);
}

describe("team-task-store · create 与依赖", () => {
  it("create:CAS expectedRevision 错误 → REVISION_CONFLICT(带 current);正确 → revision+1", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    expect(a.revision).toBe(1);
    expect(a.status).toBe("ready"); // 无依赖即就绪
    // 错误 expectedRevision → 冲突,details.current = 当前值
    const err = expectCode(() => store.claim(a.id, "w1", { expectedRevision: 99 }), "TEAM_TASK_REVISION_CONFLICT");
    expect((err.details as { current: number }).current).toBe(1);
    // 正确 expectedRevision → 通过且 revision+1
    const claimed = store.claim(a.id, "w1", { expectedRevision: 1 });
    expect(claimed.task.revision).toBe(2);
    expect(claimed.task.status).toBe("claimed");
    // 旧 revision 再写一次(读旧值再写)→ 仍然冲突,不静默覆盖
    const err2 = expectCode(() => store.heartbeat(a.id, "w1", { expectedRevision: 1 }), "TEAM_TASK_REVISION_CONFLICT");
    expect((err2.details as { current: number }).current).toBe(2);
  });

  it("create:blocker 不存在 → BLOCKER_MISSING;初始 pending 依赖未完成", () => {
    const { store } = newStore();
    expectCode(() => store.create({ title: "B", blockedBy: ["nope"] }), "TEAM_TASK_BLOCKER_MISSING");
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B", blockedBy: [a.id] });
    expect(b.status).toBe("pending");
    expect(b.revision).toBe(1);
    // 依赖未完成时 claim → NOT_READY
    expectCode(() => store.claim(b.id, "w1"), "TEAM_TASK_NOT_READY");
  });

  it("create:CYCLE — 自引与历史 A→B→A 成环都拒", () => {
    const { journal, store } = newStore();
    const a = store.create({ title: "A" });
    // 历史环(冷恢复自 journal 的手工事件):A blockedBy B、B blockedBy A
    const mk = (t: Task): void => {
      journal.append({ kind: "team.task.created" as never, sessionId: "s-team", payload: { task: t } });
    };
    const base = { writeScopes: [], attempts: 0, revision: 1, createdAt: 1, updatedAt: 1 } as const;
    mk({ id: "cyc-a", title: "cyc-a", status: "pending", blockedBy: ["cyc-b"], ...base });
    mk({ id: "cyc-b", title: "cyc-b", status: "pending", blockedBy: ["cyc-a"], ...base });
    store.reload();
    const err = expectCode(() => store.create({ title: "C", blockedBy: ["cyc-a"] }), "TEAM_TASK_CYCLE");
    expect(Array.isArray((err.details as { cycle: string[] }).cycle)).toBe(true);
    // 自引:依赖自身(不存在的那个 id)→ BLOCKER_MISSING,自引命名由 fold 图上的环覆盖
    expect(store.get(a.id)!.status).toBe("ready");
  });

  it("create:CYCLE 自引(fold 图里的 A blockedBy A)", () => {
    const { journal, store } = newStore();
    journal.append({
      kind: "team.task.created" as never,
      sessionId: "s-team",
      payload: {
        task: {
          id: "self",
          title: "self",
          status: "pending",
          blockedBy: ["self"],
          writeScopes: [],
          attempts: 0,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    store.reload();
    expectCode(() => store.create({ title: "D", blockedBy: ["self"] }), "TEAM_TASK_CYCLE");
  });

  it("create:blocker done 后依赖自动 ready(complete 传播只升一层)", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B", blockedBy: [a.id] });
    const c = store.create({ title: "C", blockedBy: [b.id] });
    expect(b.status).toBe("pending");
    expect(c.status).toBe("pending");
    store.claim(a.id, "w1");
    store.complete(a.id, { expectedRevision: 2, owner: "w1" });
    expect(store.get(b.id)!.status).toBe("ready");
    expect(store.get(c.id)!.status).toBe("pending"); // 链式:要靠 B 完成才升 C
    store.claim(b.id, "w2");
    store.complete(b.id, { owner: "w2" });
    expect(store.get(c.id)!.status).toBe("ready");
  });
});

describe("team-task-store · claim/heartbeat/reassign", () => {
  it("claim:已 claim 未过期 → ALREADY_CLAIMED;非 owner heartbeat/complete 拒", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const now = 1_000_000;
    store.claim(a.id, "w1", { now, ttlMs: 1000 });
    const err = expectCode(() => store.claim(a.id, "w2", { now: now + 10 }), "TEAM_TASK_ALREADY_CLAIMED");
    expect((err.details as { owner: string }).owner).toBe("w1");
    // 非 owner
    const hb = expectCode(() => store.heartbeat(a.id, "w2", { now: now + 10 }), "TEAM_TASK_INVALID");
    expect((hb.details as { reason: string }).reason).toBe("not-owner");
    const cp = expectCode(() => store.complete(a.id, { owner: "w2", now: now + 10 }), "TEAM_TASK_INVALID");
    expect((cp.details as { reason: string }).reason).toBe("not-owner");
    expect(store.get(a.id)!.status).toBe("claimed");
  });

  it("heartbeat:续租(claimExpiresAt 变大)+ heartbeatAt 更新", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const now = 1_000_000;
    const claimed = store.claim(a.id, "w1", { now, ttlMs: 1000 });
    expect(claimed.task.claimExpiresAt).toBe(now + 1000);
    const beat = store.heartbeat(a.id, "w1", { now: now + 500, ttlMs: 1000 });
    expect(beat.claimExpiresAt!).toBeGreaterThan(claimed.task.claimExpiresAt!);
    expect(beat.heartbeatAt).toBe(now + 500);
    expect(beat.revision).toBe(claimed.task.revision + 1);
    // 过期后心跳被拒
    const late = expectCode(() => store.heartbeat(a.id, "w1", { now: beat.claimExpiresAt! + 1 }), "TEAM_TASK_INVALID");
    expect((late.details as { reason: string }).reason).toBe("lease-expired");
  });

  it("reclaim:过期才回收,未过期不动;回收后可重新 claim", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const now = 1_000_000;
    const claimed = store.claim(a.id, "w1", { now, ttlMs: 1000 });
    const exp = claimed.task.claimExpiresAt!;
    // 未过期:不回收
    expect(store.reclaimExpired(exp - 1)).toEqual([]);
    expect(store.get(a.id)!.status).toBe("claimed");
    // 边界:claimExpiresAt < now 才回收
    expect(store.reclaimExpired(exp + 1)).toEqual([a.id]);
    const back = store.get(a.id)!;
    expect(back.status).toBe("ready");
    expect(back.owner).toBeUndefined();
    expect(back.attempts).toBe(0);
    // 过期状态下 claim 被拒(须先 reclaim)
    const b = store.create({ title: "B" });
    store.claim(b.id, "w1", { now, ttlMs: 1000 });
    const err = expectCode(() => store.claim(b.id, "w2", { now: now + 5000 }), "TEAM_TASK_NOT_READY");
    expect((err.details as { reason: string }).reason).toBe("lease-expired");
    store.reclaimExpired(now + 5001);
    expect(store.claim(b.id, "w2", { now: now + 5002 }).task.owner).toBe("w2");
  });

  it("reassign:claimed 转移 owner;未 claim 拒", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    expectCode(() => store.reassign(a.id, "w2"), "TEAM_TASK_INVALID");
    store.claim(a.id, "w1");
    const r = store.reassign(a.id, "w2", { expectedRevision: 2 });
    expect(r.owner).toBe("w2");
    expect(r.status).toBe("claimed");
  });
});

describe("team-task-store · fail 熔断", () => {
  it("fail:1/2 次回 pending(或 ready),第 3 次 blocked", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const tick = (): Task => {
      store.claim(a.id, "w1");
      return store.fail(a.id, { owner: "w1", error: "boom" });
    };
    const f1 = tick();
    expect(f1.attempts).toBe(1);
    expect(f1.status).toBe("ready"); // 依赖为空 → 就绪判定不变
    expect(f1.owner).toBeUndefined();
    const f2 = tick();
    expect(f2.attempts).toBe(2);
    expect(f2.status).toBe("ready");
    const f3 = tick();
    expect(f3.attempts).toBe(3);
    expect(f3.status).toBe("blocked"); // 熔断
    // blocked 后不可再 claim
    expectCode(() => store.claim(a.id, "w1"), "TEAM_TASK_NOT_READY");
  });
});

describe("team-task-store · delete", () => {
  it("delete:有 dependent → HAS_DEPENDENTS 且任务仍在 list", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B", blockedBy: [a.id] });
    const err = expectCode(() => store.delete(a.id), "TEAM_TASK_HAS_DEPENDENTS");
    expect((err.details as { dependents: string[] }).dependents).toEqual([b.id]);
    expect(store.list().map((t) => t.id)).toContain(a.id);
    // 先删依赖者再删被依赖者
    expect(store.delete(b.id).deleted).toBe(true);
    expect(store.delete(a.id).deleted).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("delete:CAS expectedRevision 不符 → REVISION_CONFLICT", () => {
    const { store } = newStore();
    const a = store.create({ title: "A" });
    expectCode(() => store.delete(a.id, { expectedRevision: 7 }), "TEAM_TASK_REVISION_CONFLICT");
    expect(store.list()).toHaveLength(1);
  });
});

describe("team-task-store · 写域警告", () => {
  it("写域重叠:claim 返 warnings 且不拒", () => {
    const { store } = newStore();
    const a = store.create({ title: "A", writeScopes: ["apps/gateway/src/agent-wiring.ts"] });
    const b = store.create({ title: "B", writeScopes: ["apps/gateway/src/**"] });
    const now = 1_000_000;
    const r1 = store.claim(a.id, "w1", { now });
    expect(r1.warnings).toEqual([]);
    const r2 = store.claim(b.id, "w2", { now: now + 1 });
    expect(r2.task.status).toBe("claimed"); // 不拒
    expect(r2.warnings.length).toBeGreaterThan(0);
    expect(r2.warnings[0]).toContain("写域重叠");
    // 不重叠的不告警
    const c = store.create({ title: "C", writeScopes: ["docs/**"] });
    const r3 = store.claim(c.id, "w3", { now: now + 2 });
    expect(r3.warnings).toEqual([]);
    // 边界:同段前缀算重叠,兄弟文件不算
    expect(scopesOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(scopesOverlap("src/a", "src/a/b.ts")).toBe(true);
    expect(scopesOverlap("src/a.ts", "src/a.tsx")).toBe(false);
    // 过期租约不算占用
    const r4 = store.create({ title: "D", writeScopes: ["apps/gateway/src/agent-wiring.ts"] });
    const d = store.claim(r4.id, "w4", { now: now + 400_000 });
    expect(d.warnings.length).toBe(0); // a/b 的租约(now 起 300s)到 now+400s 已过期
  });
});

describe("team-task-store · fold 冷恢复", () => {
  it("fold:created/changed 混合 → revision/status 正确;未知 kind 忽略", () => {
    const { journal, store } = newStore();
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B", blockedBy: [a.id] });
    store.claim(a.id, "w1");
    store.complete(a.id, { owner: "w1", result: "ok" });
    journal.append({ kind: "custom", sessionId: "s-team", payload: { type: "noise" } });
    journal.append({ kind: "team.task.changed" as never, sessionId: "s-team", payload: { id: "ghost", patch: { revision: 9 } } });

    const folded = foldTeamTasks(journal.readAll());
    const fa = folded.get(a.id)!;
    const fb = folded.get(b.id)!;
    expect(fa.status).toBe("done");
    expect(fa.result).toBe("ok");
    expect(fa.revision).toBe(3); // create(1) → claim(2) → complete(3)(依赖传播只动 B)
    expect(fb.status).toBe("ready");
    expect(fb.revision).toBe(2); // create(1) → 自动 ready(2)
    expect(folded.has("ghost")).toBe(false);
    // 冷恢复后的新 store 与重启前一致
    const reopened = new TeamTaskStore(journal, { sessionId: "s-team" });
    expect(reopened.list().map((t) => [t.id, t.status, t.revision])).toEqual(
      store.list().map((t) => [t.id, t.status, t.revision]),
    );
  });

  it("fold-unknown:delete 墓碑移除行,未知 kind 不抛", () => {
    const { journal, store } = newStore();
    const a = store.create({ title: "A" });
    store.delete(a.id);
    journal.append({ kind: "team.task.changed" as never, sessionId: "s-team", payload: { id: a.id, patch: { revision: 5 } } });
    const folded = foldTeamTasks(journal.readAll());
    expect(folded.size).toBe(0);
    expect(new TeamTaskStore(journal).list()).toEqual([]);
  });
});

describe("team-task-tool · 工具面", () => {
  it("team_task:create/claim/complete/list 返回 JSON,错误码原样透传", async () => {
    const journal = new MemoryJournal();
    const tool = teamTaskTool(journal, "s-team");
    expect(tool.name).toBe("team_task");
    const createA = JSON.parse(await tool.execute({ action: "create", title: "A" })) as { ok: boolean; task: Task };
    expect(createA.ok).toBe(true);
    const createB = JSON.parse(
      await tool.execute({ action: "create", title: "B", blockedBy: [createA.task.id] }),
    ) as { task: Task };
    expect(createB.task.status).toBe("pending");
    // 依赖未完成 → 错误码原样
    const notReady = JSON.parse(await tool.execute({ action: "claim", id: createB.task.id, owner: "w1" })) as {
      ok: boolean;
      code: string;
    };
    expect(notReady.ok).toBe(false);
    expect(notReady.code).toBe("TEAM_TASK_NOT_READY");
    // CAS 冲突
    const claimed = JSON.parse(
      await tool.execute({ action: "claim", id: createA.task.id, owner: "w1", expectedRevision: 1 }),
    ) as { ok: boolean; warnings: string[] };
    expect(claimed.ok).toBe(true);
    expect(claimed.warnings).toEqual([]);
    const conflict = JSON.parse(
      await tool.execute({ action: "heartbeat", id: createA.task.id, owner: "w1", expectedRevision: 1 }),
    ) as { code: string; details: { current: number } };
    expect(conflict.code).toBe("TEAM_TASK_REVISION_CONFLICT");
    expect(conflict.details.current).toBe(2);
    const done = JSON.parse(
      await tool.execute({ action: "complete", id: createA.task.id, owner: "w1", result: "x".repeat(500) }),
    ) as { ok: boolean };
    expect(done.ok).toBe(true);
    const list = JSON.parse(await tool.execute({ action: "list" })) as {
      ok: boolean;
      tasks: Record<string, unknown>[];
      count: number;
      byStatus: Record<string, number>;
    };
    expect(list.count).toBe(2);
    expect(list.byStatus).toEqual({ done: 1, ready: 1 });
    expect(list.tasks.some((t) => "result" in t)).toBe(false); // 摘要不含大字段
    // 非法 action
    const bad = JSON.parse(await tool.execute({ action: "nope" })) as { code: string };
    expect(bad.code).toBe("TEAM_TASK_INVALID");
  });
});
