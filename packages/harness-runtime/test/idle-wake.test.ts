/**
 *  idle wake 纯逻辑单测(零 IO):
 * 覆盖 busy/no-pending/stale 判定、minIdleMs 边界、同批合并与时序、prompt 头尾/截断/上界、
 * generationOfEvent 取值、determinism 与不可变(不改入参数组)、入参非法不抛错。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BATCH,
  DEFAULT_MIN_IDLE_MS,
  WAKE_CODES,
  generationOfEvent,
  wakePrompt,
  wakeVerdict,
} from "../src/task/idle-wake.ts";
import type { IdleWakeInput, PendingNotification } from "../src/task/idle-wake.ts";
import { TaskNoticeQueue } from "../src/task/task-notification-queue.ts";

const NOW = 10_000_000;
const HEADER = "[后台单元完成] 以下后台任务已结束(可能成功/失败):";
const FOOTER = "这些通知可能对应你之前派出的工作:检查结果并继续;若无需处理,忽略本消息,不要重复已完成的工作。";

function notice(id: string, at: number, generation = 1, summary = "子代理完成"): PendingNotification {
  return { id, at, generation, kind: "subagent", summary };
}

function input(over: Partial<IdleWakeInput> = {}): IdleWakeInput {
  return {
    sessionId: "s1",
    now: NOW,
    lastTurnEndAt: NOW - 60_000,
    activeTaskCount: 0,
    pendingNotifications: [notice("a", 1)],
    currentGeneration: 1,
    ...over,
  };
}

describe("WAKE_CODES", () => {
  it("封闭五码且顺序稳定", () => {
    expect([...WAKE_CODES]).toEqual(["WAKE", "BUSY", "NO_PENDING", "STALE", "INVALID"]);
  });

  it("任何判定都返回 ok:true 的完整形状", () => {
    const v = wakeVerdict(input());
    expect(v.ok).toBe(true);
    expect(typeof v.reason).toBe("string");
    expect(Array.isArray(v.ids)).toBe(true);
  });
});

describe("BUSY:父会话忙/上一 turn 未稳定结束", () => {
  it("activeTaskCount>0 → BUSY 且不唤醒", () => {
    const v = wakeVerdict(input({ activeTaskCount: 1 }));
    expect(v.code).toBe("BUSY");
    expect(v.wake).toBe(false);
    expect(v.ids).toEqual([]);
    expect(v.prompt).toBeUndefined();
  });

  it("有通知也照样 BUSY(不打扰在跑会话)", () => {
    const v = wakeVerdict(input({ activeTaskCount: 2, pendingNotifications: [notice("a", 1), notice("b", 2)] }));
    expect(v.code).toBe("BUSY");
    expect(v.reason).toContain("2");
  });

  it("lastTurnEndAt 缺失 → BUSY(保守)", () => {
    expect(wakeVerdict(input({ lastTurnEndAt: undefined })).code).toBe("BUSY");
    expect(wakeVerdict(input({ lastTurnEndAt: null })).code).toBe("BUSY");
  });

  it("空闲时长小于缺省 1500ms → BUSY", () => {
    const v = wakeVerdict(input({ lastTurnEndAt: NOW - (DEFAULT_MIN_IDLE_MS - 1) }));
    expect(v.code).toBe("BUSY");
    expect(v.reason).toContain(String(DEFAULT_MIN_IDLE_MS - 1));
  });

  it("空闲时长恰好等于 1500ms → WAKE(边界不误判 busy)", () => {
    const v = wakeVerdict(input({ lastTurnEndAt: NOW - DEFAULT_MIN_IDLE_MS }));
    expect(v.code).toBe("WAKE");
    expect(v.wake).toBe(true);
  });

  it("自定义 minIdleMs 生效", () => {
    expect(wakeVerdict(input({ lastTurnEndAt: NOW - 5_000, minIdleMs: 10_000 })).code).toBe("BUSY");
    expect(wakeVerdict(input({ lastTurnEndAt: NOW - 5_000, minIdleMs: 1_000 })).code).toBe("WAKE");
  });
});

describe("NO_PENDING", () => {
  it("空通知数组 → NO_PENDING", () => {
    const v = wakeVerdict(input({ pendingNotifications: [] }));
    expect(v.code).toBe("NO_PENDING");
    expect(v.wake).toBe(false);
  });

  it("全部是非法项(无 id)视作没有通知", () => {
    const v = wakeVerdict(input({ pendingNotifications: [null, { at: 1 }] as unknown as PendingNotification[] }));
    expect(v.code).toBe("NO_PENDING");
  });
});

describe("STALE:旧 generation 迟到通知", () => {
  it("单条旧代 → STALE 且 ids 为空", () => {
    const v = wakeVerdict(input({ pendingNotifications: [notice("old", 1, 3)], currentGeneration: 7 }));
    expect(v.code).toBe("STALE");
    expect(v.ids).toEqual([]);
    expect(v.reason).toContain("7");
  });

  it("全部旧代 → STALE", () => {
    const v = wakeVerdict(
      input({ pendingNotifications: [notice("o1", 1, 2), notice("o2", 2, 3)], currentGeneration: 9 }),
    );
    expect(v.code).toBe("STALE");
  });

  it("新旧混合 → WAKE 且 ids 只含新代", () => {
    const v = wakeVerdict(
      input({
        pendingNotifications: [notice("old", 1, 1, "旧代结果"), notice("new", 2, 2, "新代结果")],
        currentGeneration: 2,
      }),
    );
    expect(v.code).toBe("WAKE");
    expect(v.ids).toEqual(["new"]);
    expect(v.prompt).toContain("新代结果");
    expect(v.prompt).not.toContain("旧代结果");
  });

  it("generation 缺省按 0;currentGeneration 0 时认领", () => {
    const v = wakeVerdict(
      input({ pendingNotifications: [{ id: "g0", at: 1, kind: "subagent", summary: "x" } as PendingNotification], currentGeneration: 0 }),
    );
    expect(v.code).toBe("WAKE");
    expect(v.ids).toEqual(["g0"]);
  });
});

describe("batch:同批多条合并一次唤醒", () => {
  it("两条合并进一条 prompt 且按 at 升序", () => {
    const v = wakeVerdict(
      input({ pendingNotifications: [notice("late", 20, 1, "后完成"), notice("early", 10, 1, "先完成")] }),
    );
    expect(v.code).toBe("WAKE");
    expect(v.ids).toEqual(["early", "late"]);
    const earlyIdx = v.prompt!.indexOf("- subagent: 先完成");
    const lateIdx = v.prompt!.indexOf("- subagent: 后完成");
    expect(earlyIdx).toBeGreaterThan(0);
    expect(lateIdx).toBeGreaterThan(earlyIdx);
  });

  it("缺省 maxBatch=5:7 条只取最近 5 条", () => {
    expect(DEFAULT_MAX_BATCH).toBe(5);
    const many = Array.from({ length: 7 }, (_, i) => notice(`n${i + 1}`, i + 1, 1, `第${i + 1}条`));
    const v = wakeVerdict(input({ pendingNotifications: many }));
    expect(v.ids).toEqual(["n3", "n4", "n5", "n6", "n7"]);
    expect(v.prompt).not.toContain("第1条");
  });

  it("maxBatch 可调小", () => {
    const many = [notice("a", 1), notice("b", 2), notice("c", 3)];
    const v = wakeVerdict(input({ pendingNotifications: many, maxBatch: 2 }));
    expect(v.ids).toEqual(["b", "c"]);
  });

  it("同 at 时按 id 字典序稳定排序", () => {
    const v = wakeVerdict(input({ pendingNotifications: [notice("b", 5), notice("a", 5)] }));
    expect(v.ids).toEqual(["a", "b"]);
  });
});

describe("wakePrompt", () => {
  it("头尾逐字固定", () => {
    const text = wakePrompt([notice("a", 1, 1, "完成 A")]);
    const lines = text.split("\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe("- subagent: 完成 A");
    expect(lines.at(-1)).toBe(FOOTER);
  });

  it("summary 截 160 字", () => {
    const long = "长".repeat(400);
    const text = wakePrompt([notice("a", 1, 1, long)]);
    const line = text.split("\n")[1];
    expect(line).toBe(`- subagent: ${"长".repeat(160)}`);
    expect(line.length).toBe("- subagent: ".length + 160);
  });

  it("大批量时总长 ≤1200 且保留头尾", () => {
    const many = Array.from({ length: 20 }, (_, i) => notice(`n${i}`, i, 1, "长".repeat(160)));
    const text = wakePrompt(many);
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text.startsWith(HEADER)).toBe(true);
    expect(text.endsWith(FOOTER)).toBe(true);
  });

  it("空数组返回合法头尾文本", () => {
    const text = wakePrompt([]);
    expect(text).toBe(`${HEADER}\n${FOOTER}`);
  });

  it("确定性:同输入两次逐字相同", () => {
    const list = [notice("b", 2, 1, "B"), notice("a", 1, 1, "A")];
    expect(wakePrompt(list)).toBe(wakePrompt([...list]));
  });
});

describe("generationOfEvent", () => {
  it("取 payload.generation 数字", () => {
    expect(generationOfEvent({ payload: { generation: 3 } })).toBe(3);
  });

  it("缺 payload/generation → 0", () => {
    expect(generationOfEvent({})).toBe(0);
    expect(generationOfEvent({ payload: {} })).toBe(0);
  });

  it("非数字(字符串/NaN/Infinity)→ 0", () => {
    expect(generationOfEvent({ payload: { generation: "3" } })).toBe(0);
    expect(generationOfEvent({ payload: { generation: Number.NaN } })).toBe(0);
    expect(generationOfEvent({ payload: { generation: Number.POSITIVE_INFINITY } })).toBe(0);
  });

  it("null/undefined 入参 → 0(不抛)", () => {
    expect(generationOfEvent(null)).toBe(0);
    expect(generationOfEvent(undefined)).toBe(0);
  });
});

describe("TaskNoticeQueue:branchGeneration 接入", () => {
  function makeQueue() {
    const tasks = new Map<string, Record<string, unknown>>();
    const add = (id: string, generation: number, sessionId = "s1") => {
      tasks.set(id, {
        id,
        ownerId: "o1",
        sessionId,
        createdAt: Number(id.replace(/\D/g, "")) || 1,
        notificationStatus: "pending",
        notificationGeneration: generation,
      });
    };
    const queue = new TaskNoticeQueue({
      tasks,
      snapshot: (task: Record<string, unknown>) => ({ ...task }),
      claimTtlMs: () => 60_000,
    });
    return { queue, tasks, add };
  }

  it("不传 branchGeneration → 旧行为(全部 pending 都认领)", () => {
    const { queue, add } = makeQueue();
    add("t1", 1);
    add("t2", 2);
    const claimed = queue.claim({ ownerId: "o1", sessionId: "s1", claimantId: "c1" });
    expect(claimed.map((task: { id: string }) => task.id)).toEqual(["t1", "t2"]);
  });

  it("旧代通知不被认领(claim 跳过 generation 不等项)", () => {
    const { queue, add } = makeQueue();
    add("t1", 1);
    add("t2", 2);
    const claimed = queue.claim({ ownerId: "o1", sessionId: "s1", claimantId: "c1", branchGeneration: 2 });
    expect(claimed.map((task: { id: string }) => task.id)).toEqual(["t2"]);
  });

  it("认领同代通知时记录代次", () => {
    const { queue, tasks, add } = makeQueue();
    add("t1", 3);
    queue.claim({ ownerId: "o1", sessionId: "s1", claimantId: "c1", branchGeneration: 3 });
    expect(tasks.get("t1")!.notificationClaimedGeneration).toBe(3);
  });

  it("dropStale 把旧代 pending 标 none,同代保持 pending", () => {
    const { queue, tasks, add } = makeQueue();
    add("t1", 1);
    add("t2", 2);
    const dropped = queue.dropStale(2);
    expect(dropped).toBe(1);
    expect(tasks.get("t1")!.notificationStatus).toBe("none");
    expect(tasks.get("t2")!.notificationStatus).toBe("pending");
  });
});

describe("不可变与不抛错", () => {
  it("wakeVerdict 不重排调用方数组", () => {
    const list = [notice("late", 20), notice("early", 10)];
    const snapshot = list.map((item) => item.id);
    wakeVerdict(input({ pendingNotifications: list }));
    expect(list.map((item) => item.id)).toEqual(snapshot);
  });

  it("入参非法 → INVALID 而非抛错", () => {
    expect(wakeVerdict(null as unknown as IdleWakeInput).code).toBe("INVALID");
    expect(wakeVerdict({} as IdleWakeInput).code).toBe("INVALID");
    expect(wakeVerdict({ now: NOW, activeTaskCount: 0, pendingNotifications: "x" } as unknown as IdleWakeInput).code).toBe(
      "INVALID",
    );
  });

  it("确定性:同输入两次判定完全一致", () => {
    const base = input({ pendingNotifications: [notice("a", 1), notice("b", 2)] });
    expect(wakeVerdict(base)).toEqual(wakeVerdict({ ...base }));
  });
});
