/**
 * durable inbox 纯逻辑:admit 四态 / promote 水位 / restore 过滤 / owner 归属 /
 * resume 策略 / 队列边界 / 不可变与确定性。
 * 真实探针 A-F(同 key 同载荷→DUPLICATE、同 key 异载荷→CONFLICT、promote cutoff、
 * delivered 不 restore、异常回退 unowned、resume heldBack)全部在本文件;
 * gateway 侧源码接线断言见 apps/gateway/test/durable-inbox-wiring.test.ts。
 */
import { describe, it, expect } from "vitest";
import {
  DurableInbox,
  fingerprintOf,
  assertQueueBoundary,
  resolveOwner,
  applyResumePolicy,
  UNOWNED,
  type InboxItem,
} from "../src/session/durable-inbox.ts";

const AT = 1_700_000_000_000;
const att = (name: string) => ({ name, path: `/tmp/${name}`, mime: "text/plain", size: 3 });

describe("fingerprintOf(载荷指纹)", () => {
  it("同载荷必同指纹", () => {
    expect(fingerprintOf("你好", [att("a.txt")])).toBe(fingerprintOf("你好", [att("a.txt")]));
  });

  it("指纹 = 16 位 hex", () => {
    expect(fingerprintOf("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("instruction 变化 → 指纹变化", () => {
    expect(fingerprintOf("甲")).not.toBe(fingerprintOf("乙"));
  });

  it("附件变化 → 指纹变化", () => {
    expect(fingerprintOf("甲", [att("a.txt")])).not.toBe(fingerprintOf("甲", [att("b.txt")]));
  });

  it("无附件与空附件数组同指纹(规范化)", () => {
    expect(fingerprintOf("甲")).toBe(fingerprintOf("甲", []));
  });
});

describe("admit 受理", () => {
  it("首次受理分配 admittedSeq=1", () => {
    const r = new DurableInbox().admit("s1", "消息", { at: AT });
    expect(r.ok).toBe(true);
    expect(r.code).toBe("ADMITTED");
    expect(r.admittedSeq).toBe(1);
    expect(r.item?.delivery).toBe("pending");
  });

  it("admittedSeq 跨会话全局单调", () => {
    const box = new DurableInbox();
    const a = box.admit("s1", "甲", { at: AT });
    const b = box.admit("s2", "乙", { at: AT });
    const c = box.admit("s1", "丙", { at: AT });
    expect([a.admittedSeq, b.admittedSeq, c.admittedSeq]).toEqual([1, 2, 3]);
  });

  it("sessionId 为空 → INVALID,不写入", () => {
    const box = new DurableInbox();
    const r = box.admit("  ", "消息", { at: AT });
    expect(r.code).toBe("INVALID");
    expect(r.item).toBeNull();
    expect(box.stats().total).toBe(0);
  });

  it("instruction 为空 → INVALID", () => {
    expect(new DurableInbox().admit("s1", "", { at: AT }).code).toBe("INVALID");
  });

  it("instruction 全空白 → INVALID", () => {
    expect(new DurableInbox().admit("s1", "   ", { at: AT }).code).toBe("INVALID");
  });

  it("探针 A:同 key 同载荷 → DUPLICATE,seq 不增,不产生第二条", () => {
    const box = new DurableInbox();
    const first = box.admit("s1", "消息", { idempotencyKey: "k1", at: AT });
    const again = box.admit("s1", "消息", { idempotencyKey: "k1", at: AT + 1 });
    expect(again.code).toBe("DUPLICATE");
    expect(again.ok).toBe(true);
    expect(again.admittedSeq).toBe(first.admittedSeq);
    expect(again.item?.id).toBe(first.item?.id);
    expect(box.items("s1")).toHaveLength(1);
    expect(box.stats().lastAdmittedSeq).toBe(1);
  });

  it("同 key + 同附件 → DUPLICATE", () => {
    const box = new DurableInbox();
    box.admit("s1", "带附件", { idempotencyKey: "k1", attachments: [att("a.txt")], at: AT });
    expect(box.admit("s1", "带附件", { idempotencyKey: "k1", attachments: [att("a.txt")], at: AT }).code).toBe("DUPLICATE");
  });

  it("探针 B:同 key 异载荷 → CONFLICT,不写入", () => {
    const box = new DurableInbox();
    box.admit("s1", "第一条", { idempotencyKey: "k1", at: AT });
    const r = box.admit("s1", "第二条(载荷不同)", { idempotencyKey: "k1", at: AT });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CONFLICT");
    expect(r.item).toBeNull();
    expect(r.admittedSeq).toBe(0);
    expect(box.items("s1").map((x) => x.instruction)).toEqual(["第一条"]);
  });

  it("同 key 但附件不同 → CONFLICT", () => {
    const box = new DurableInbox();
    box.admit("s1", "带附件", { idempotencyKey: "k1", attachments: [att("a.txt")], at: AT });
    expect(box.admit("s1", "带附件", { idempotencyKey: "k1", attachments: [att("b.txt")], at: AT }).code).toBe("CONFLICT");
  });

  it("无 key 每次新分配", () => {
    const box = new DurableInbox();
    const a = box.admit("s1", "同样的话", { at: AT });
    const b = box.admit("s1", "同样的话", { at: AT });
    expect([a.code, b.code]).toEqual(["ADMITTED", "ADMITTED"]);
    expect(a.item?.id).not.toBe(b.item?.id);
    expect(b.admittedSeq).toBe(2);
  });

  it("未带 owner → unowned", () => {
    const r = new DurableInbox().admit("s1", "消息", { at: AT });
    expect(r.item?.ownerId).toBe(UNOWNED);
  });

  it("显式 owner 原样保留", () => {
    const r = new DurableInbox().admit("s1", "消息", { ownerId: "user-42", at: AT });
    expect(r.item?.ownerId).toBe("user-42");
  });

  it("确定性:同操作序列 → 同 id/seq/指纹", () => {
    const run = () => {
      const box = new DurableInbox();
      const a = box.admit("s1", "甲", { idempotencyKey: "k", at: AT });
      const b = box.admit("s2", "乙", { at: AT });
      return [a.item, b.item].map((x) => [x?.id, x?.admittedSeq, x?.fingerprint]);
    };
    expect(run()).toEqual(run());
  });
});

describe("promote 放行水位", () => {
  it("不传 cutoff = 全部 pending 放行", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    box.admit("s1", "乙", { at: AT });
    const promoted = box.promote("s1", { at: AT });
    expect(promoted.map((x) => x.instruction)).toEqual(["甲", "乙"]);
    expect(promoted.every((x) => x.delivery === "delivered")).toBe(true);
  });

  it("探针 C:cutoff 只推进到边界", () => {
    const box = new DurableInbox();
    const a = box.admit("s1", "甲", { at: AT });
    box.admit("s1", "乙", { at: AT });
    const promoted = box.promote("s1", { cutoff: a.admittedSeq, at: AT });
    expect(promoted.map((x) => x.instruction)).toEqual(["甲"]);
    expect(box.items("s1").map((x) => x.delivery)).toEqual(["delivered", "pending"]);
  });

  it("promote 按 admittedSeq 升序返回并记单调 promotedSeq", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    box.admit("s2", "乙", { at: AT });
    box.admit("s1", "丙", { at: AT });
    const promoted = box.promote("s1", { at: AT });
    expect(promoted.map((x) => x.admittedSeq)).toEqual([1, 3]);
    const seqs = promoted.map((x) => x.promotedSeq ?? 0);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("重复 promote 不再返回已放行项", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    expect(box.promote("s1", { at: AT })).toHaveLength(1);
    expect(box.promote("s1", { at: AT })).toHaveLength(0);
  });

  it("空会话 promote = 空数组,不抛", () => {
    expect(new DurableInbox().promote("nobody", { at: AT })).toEqual([]);
  });

  it("promote 只作用于本会话", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    box.admit("s2", "乙", { at: AT });
    box.promote("s1", { at: AT });
    expect(box.items("s2")[0]!.delivery).toBe("pending");
  });
});

describe("promotable(纯查询)", () => {
  it("查询不改变 delivery 水位", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    expect(box.promotable("s1", 1)).toHaveLength(1);
    expect(box.promotable("s1", 1)).toHaveLength(1); // 再查一次仍可放行
    expect(box.items("s1")[0]!.delivery).toBe("pending");
  });

  it("cutoff 之外的项不在结果里", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    box.admit("s1", "乙", { at: AT });
    expect(box.promotable("s1", 1).map((x) => x.instruction)).toEqual(["甲"]);
  });
});

describe("restore(重启回放)", () => {
  const item = (over: Partial<InboxItem> = {}): InboxItem => ({
    id: "ib-x",
    sessionId: "s1",
    instruction: "恢复的消息",
    ownerId: "unowned",
    fingerprint: fingerprintOf("恢复的消息"),
    admittedSeq: 3,
    delivery: "pending",
    admittedAt: AT,
    ...over,
  });

  it("探针 D:delivered 项不被 restore", () => {
    const box = new DurableInbox();
    const kept = box.restore("s1", [item({ id: "a", delivery: "delivered" }), item({ id: "b" })]);
    expect(kept.map((x) => x.id)).toEqual(["b"]);
    expect(box.items("s1").map((x) => x.id)).toEqual(["b"]);
  });

  it("restore 后 admittedSeq 继续排队尾(max+1)", () => {
    const box = new DurableInbox();
    box.restore("s1", [item({ admittedSeq: 7 })]);
    expect(box.admit("s1", "新消息", { at: AT }).admittedSeq).toBe(8);
  });

  it("缺失/非法 admittedSeq 按恢复顺序补号", () => {
    const box = new DurableInbox();
    const kept = box.restore("s1", [
      item({ id: "a", admittedSeq: 0 }),
      item({ id: "b", admittedSeq: 0 }),
    ]);
    expect(kept.map((x) => x.admittedSeq)).toEqual([1, 2]);
  });

  it("同 id 重复恢复去重(幂等)", () => {
    const box = new DurableInbox();
    const kept = box.restore("s1", [item({ id: "a" }), item({ id: "a" })]);
    expect(kept).toHaveLength(1);
  });

  it("instruction 为空的坏项静默丢弃", () => {
    const box = new DurableInbox();
    expect(box.restore("s1", [item({ id: "a", instruction: "" })])).toHaveLength(0);
  });

  it("空数组恢复 = 清空该会话", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    box.restore("s1", []);
    expect(box.items("s1")).toHaveLength(0);
  });

  it("恢复项保持 pending 且可再次 promote", () => {
    const box = new DurableInbox();
    box.restore("s1", [item()]);
    expect(box.promote("s1", { at: AT }).map((x) => x.id)).toEqual(["ib-x"]);
  });
});

describe("resolveOwner(归属)", () => {
  it("同会话候选胜出", () => {
    expect(resolveOwner({ sessionId: "s1", candidates: [{ sessionId: "s1", ownerId: "user-1" }] })).toBe("user-1");
  });

  it("探针 E:只给其它会话候选 → 异常回退 unowned(不猜)", () => {
    expect(resolveOwner({ sessionId: "s1", candidates: [{ sessionId: "s2", ownerId: "user-2" }] })).toBe("unowned");
  });

  it("同会话候选 owner 为空 → 回退 unowned", () => {
    expect(resolveOwner({ sessionId: "s1", candidates: [{ sessionId: "s1", ownerId: "  " }] })).toBe("unowned");
  });

  it("显式 fallbackOwner 生效", () => {
    expect(resolveOwner({ sessionId: "s1", fallbackOwner: "user-9" })).toBe("user-9");
  });

  it("缺省 fallback = unowned", () => {
    expect(resolveOwner({ sessionId: "s1" })).toBe(UNOWNED);
  });

  it("确定性:同输入同输出", () => {
    const input = { sessionId: "s1", candidates: [{ sessionId: "s1", ownerId: "a" }, { sessionId: "s1", ownerId: "b" }] };
    expect(resolveOwner(input)).toBe(resolveOwner(input));
    expect(resolveOwner(input)).toBe("a");
  });
});

describe("applyResumePolicy(resume 不注入未 drain 项)", () => {
  const item = (over: Partial<InboxItem> = {}): InboxItem => ({
    id: "ib-1",
    sessionId: "s1",
    instruction: "x",
    ownerId: "unowned",
    fingerprint: fingerprintOf("x"),
    admittedSeq: 1,
    delivery: "pending",
    admittedAt: AT,
    ...over,
  });

  it("探针 F:pending 且无 promotedSeq → heldBack", () => {
    const plan = applyResumePolicy([item()]);
    expect(plan.heldBack.map((x) => x.id)).toEqual(["ib-1"]);
    expect(plan.restored).toHaveLength(0);
  });

  it("delivered → restored", () => {
    const plan = applyResumePolicy([item({ delivery: "delivered", promotedSeq: 2 })]);
    expect(plan.restored.map((x) => x.id)).toEqual(["ib-1"]);
    expect(plan.heldBack).toHaveLength(0);
  });

  it("pending 但已有 promotedSeq(=已 drain)→ restored", () => {
    const plan = applyResumePolicy([item({ promotedSeq: 5 })]);
    expect(plan.restored).toHaveLength(1);
  });

  it("空输入 → 两侧皆空", () => {
    expect(applyResumePolicy([])).toEqual({ restored: [], heldBack: [] });
  });
});

describe("assertQueueBoundary(完整 tool batch 之后才允许 promote)", () => {
  it("tool.call / tool.result / step.start → 拒绝", () => {
    for (const kind of ["tool.call", "tool.result", "step.start"]) {
      expect(assertQueueBoundary(kind), kind).toBe(false);
    }
  });

  it("任务终态/消息事件 → 放行", () => {
    for (const kind of ["task.done", "task.fail", "message.agent"]) {
      expect(assertQueueBoundary(kind), kind).toBe(true);
    }
  });

  it("无末事件 / 空串 / 非字符串 → 放行(会话空闲)", () => {
    expect(assertQueueBoundary(undefined)).toBe(true);
    expect(assertQueueBoundary(null)).toBe(true);
    expect(assertQueueBoundary("")).toBe(true);
    expect(assertQueueBoundary(42 as unknown as string)).toBe(true);
  });
});

describe("不可变与不抛", () => {
  it("admit 结果与 items 返回冻结对象", () => {
    const box = new DurableInbox();
    const r = box.admit("s1", "甲", { at: AT });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.item)).toBe(true);
    expect(Object.isFrozen(box.items("s1"))).toBe(true);
    expect(Object.isFrozen(box.promote("s1", { at: AT }))).toBe(true);
  });

  it("改返回数组不影响内部状态", () => {
    const box = new DurableInbox();
    box.admit("s1", "甲", { at: AT });
    const items = box.items("s1") as InboxItem[];
    try {
      items.push({ ...items[0]! });
    } catch {
 /* 冻结数组在严格模式下抛 TypeError,属预期 */
    }
    expect(box.items("s1")).toHaveLength(1);
  });

  it("异常输入不抛:admit 非字符串参数", () => {
    const box = new DurableInbox();
    expect(() => box.admit(undefined as unknown as string, null as unknown as string)).not.toThrow();
    expect(box.admit(undefined as unknown as string, null as unknown as string).code).toBe("INVALID");
  });
});
