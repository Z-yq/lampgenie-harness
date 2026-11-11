/**
 * 接线断言:server.ts 入队走 admit / CONFLICT 回 WS error code="queue-conflict" /
 * 泵 promote 前置「会话空闲 + 完整 tool batch 边界」/ queue-store 回放过滤 delivered /
 * 既有 queue.<sid>.<id> 幂等键与 FIFO 语义不被削弱。
 * 为什么用「读源码接线断言」:server.ts 的 queueApi 是 startGatewayServer 内的闭包,
 * 单测拿不到实例;而这几处一旦漏接(例如只改 inbox 不改 enqueue),纯逻辑测试全绿但线上
 * 行为不变。故本文件同时(1)读源码核对接线点存在,(2)用真实 DurableInbox / restoreQueues
 * 跑纯路径断言行为。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryJournal } from "@lampgenie/core";
import {
  DurableInbox,
  assertQueueBoundary,
  resolveOwner,
  applyResumePolicy,
  fingerprintOf,
} from "@lampgenie/runtime/session/durable-inbox";
import { restoreQueues, writeQueueSync, queueItemKey } from "../src/queue-store.js";

const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("../src/queue-store.ts", import.meta.url), "utf8");
const inboxSrc = readFileSync(
  new URL("../../../packages/harness-runtime/src/session/durable-inbox.ts", import.meta.url),
  "utf8",
);

const AT = 1_700_000_000_000;

describe("server.ts 接线:入队走 admit", () => {
  it("enqueue 调 inbox.admit 并带 idempotencyKey/ownerId", () => {
    expect(serverSrc).toContain("inbox.admit(");
    expect(serverSrc).toContain("idempotencyKey: msg.idempotencyKey");
    expect(serverSrc).toContain('ownerId: resolveOwner({ sessionId: msg.sessionId, fallbackOwner: msg.ownerId })');
  });

  it("CONFLICT 回 WS error code=\"queue-conflict\"(HTTP 409 的 WS 等价,走协议枚举)", () => {
    expect(serverSrc).toContain("code: ErrorCode.QueueConflict");
    expect(serverSrc).toContain('type: "error", code: r.code');
  });

  it("DUPLICATE 不重复入队(回执 duplicate,不 push)", () => {
    expect(serverSrc).toContain('admitted.code === "DUPLICATE"');
    expect(serverSrc).toContain("duplicate: true as const");
  });

  it("队列项带 admittedSeq/delivery/ownerId/fingerprint", () => {
    for (const field of ["admittedSeq: admitted.item.admittedSeq", "delivery: admitted.item.delivery", "fingerprint: admitted.item.fingerprint", "ownerId: admitted.item.ownerId"]) {
      expect(serverSrc, field).toContain(field);
    }
  });

  it("启动回放把快照回灌 inbox(水位不从 0 起算)", () => {
    expect(serverSrc).toContain("inbox.restore(");
    expect(serverSrc).toContain("inboxItemOf(it, i)");
  });
});

describe("server.ts 接线:promote 判定", () => {
  it("自动泵:空闲 + 完整 tool batch 边界才 promote", () => {
    expect(serverSrc).toContain("if (sessionActive(sessionId)) return;");
    expect(serverSrc).toContain("if (!assertQueueBoundary(sessionLastEventKind(sessionId))) return;");
    expect(serverSrc).toContain("const promoted = inbox.promote(");
  });

  it("promote cutoff = 队头 admittedSeq(不提前标 delivered)", () => {
    expect(serverSrc).toContain("const cutoff = typeof head.admittedSeq");
    expect(serverSrc).toContain("cutoff === undefined ? {} : { cutoff }");
  });

  it("抢占也按 seq 放行(显式意图,不再要求边界)", () => {
    expect(serverSrc).toContain("inbox.promote(msg.sessionId, seqOfItem === undefined");
  });

  it("既有 queue.<sid>.<id> 幂等键未被替换", () => {
    expect(serverSrc).toContain("idempotencyKey: queueItemKey(item.sessionId, item.id)");
  });

  it("未 promoted 的项不提交(promotedIds 判定后才 splice)", () => {
    expect(serverSrc).toContain("const promotedIds = new Set(promoted.map((p) => p.id));");
    expect(serverSrc).toContain("const idx = q.findIndex((it) => promotedIds.has(it.id));");
  });
});

describe("queue-store 接线:可选 inbox 元数据 + 回放过滤", () => {
  it("asQueueItem 透传全部 inbox 字段(白名单重建不漏字段)", () => {
    for (const key of ["ownerId", "idempotencyKey", "fingerprint", "admittedSeq", "promotedSeq", "delivery"]) {
      expect(storeSrc, key).toContain(`${key}:`);
    }
  });

  it("restoreQueues 过滤 delivery===\"delivered\"", () => {
    expect(storeSrc).toContain('it.delivery !== "delivered"');
  });

  it("写后回放:inbox 元数据逐字保留,pending 项恢复", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [
      { id: "q1", sessionId: "s1", instruction: "甲", createdAt: AT, ownerId: "user-1", admittedSeq: 4, delivery: "pending", fingerprint: fingerprintOf("甲") },
      { id: "q2", sessionId: "s1", instruction: "乙", createdAt: AT, ownerId: "user-1", admittedSeq: 5, delivery: "delivered", fingerprint: fingerprintOf("乙") },
    ]);
    const restored = restoreQueues(j);
    const items = restored.get("s1")!;
    expect(items.map((x) => x.id), "delivered 项不恢复").toEqual(["q1"]);
    expect(items[0]!.admittedSeq).toBe(4);
    expect(items[0]!.ownerId).toBe("user-1");
  });

  it("旧快照(无 inbox 字段)逐字按旧行为恢复", () => {
    const j = new MemoryJournal();
    j.append({
      kind: "queue.sync",
      sessionId: "s1",
      payload: { sessionId: "s1", items: [{ id: "old", sessionId: "s1", instruction: "旧消息", createdAt: AT }] },
    });
    const restored = restoreQueues(j);
    expect(restored.get("s1")!.map((x) => x.id)).toEqual(["old"]);
    expect(restored.get("s1")![0]!.delivery, "缺字段=按 pending 旧行为").toBeUndefined();
  });

  it("已提交项仍按 queue.<sid>.<id> 幂等键丢弃(既有语义不变)", () => {
    const j = new MemoryJournal();
    writeQueueSync(j, "s1", [{ id: "sent", sessionId: "s1", instruction: "已发", createdAt: AT }]);
    j.append({
      kind: "task.done",
      sessionId: "s1",
      payload: { id: "t1", sessionId: "s1", instruction: "已发", state: "done", createdAt: 1, updatedAt: 2, idempotencyKey: queueItemKey("s1", "sent") },
    });
    expect(restoreQueues(j).has("s1")).toBe(false);
  });
});

describe("纯路径:admit/promote/owner/resume 在 gateway 侧的可复用性", () => {
  it("同 key 同载荷 DUPLICATE / 异载荷 CONFLICT(探针 A/B)", () => {
    const box = new DurableInbox();
    expect(box.admit("s1", "甲", { idempotencyKey: "k", at: AT }).code).toBe("ADMITTED");
    expect(box.admit("s1", "甲", { idempotencyKey: "k", at: AT }).code).toBe("DUPLICATE");
    expect(box.admit("s1", "乙", { idempotencyKey: "k", at: AT }).code).toBe("CONFLICT");
    expect(box.items("s1")).toHaveLength(1);
  });

  it("promote 边界:批内事件拒绝、终态放行(探针 C/E)", () => {
    expect(assertQueueBoundary("tool.call")).toBe(false);
    expect(assertQueueBoundary("task.done")).toBe(true);
    expect(resolveOwner({ sessionId: "s1", candidates: [{ sessionId: "s2", ownerId: "x" }] })).toBe("unowned");
  });

  it("resume 不注入未 drain 项(探针 F)", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    const plan = applyResumePolicy(box.items("s1"));
    expect(plan.heldBack).toHaveLength(1);
    expect(plan.restored).toHaveLength(0);
  });
});

describe("durable-inbox 源约束(零 IO / 不 throw)", () => {
  it("不读文件、不发网络、不落盘", () => {
    expect(inboxSrc).not.toMatch(/from "node:fs"|fetch\(|writeFile|readFile/);
  });

  it("promote 的边界注释解释了 why(完整 tool batch)", () => {
    expect(inboxSrc).toContain("完整 tool batch");
    expect(inboxSrc).toContain("CONFLICT");
  });
});
