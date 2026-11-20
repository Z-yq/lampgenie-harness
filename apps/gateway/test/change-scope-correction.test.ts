/**
 * :变更意图分类的可更正路径——纯逻辑单测。
 * 覆盖:取值规整 / 双向更正 / 不可变 / 非法(invalid 不 throw)/ 事件结构稳定 /
 * journal 读取(跳过坏事件、取最后一条、会话隔离)/ 纪律提示 / 确定性。
 */
import { describe, expect, it } from "vitest";
import {
  CHANGE_SCOPE_CORRECTION_TYPE,
  CHANGE_SCOPE_KINDS,
  applyChangeScopeCorrection,
  changeScopeCorrectionEvent,
  disciplineHintFor,
  normalizeChangeScopeCorrection,
  normalizeChangeScopeKind,
  readChangeScopeCorrection,
  type ChangeScopeCorrection,
} from "../src/change-scope-correction.js";

const correction = (over: Partial<ChangeScopeCorrection> = {}): ChangeScopeCorrection => ({
  scope: "normal",
  by: "agent",
  reason: "只改了单点文案",
  at: 1_700_000_000_000,
  ...over,
});

const ev = (payload: Record<string, unknown>, sessionId = "s1", kind: string | undefined = "custom") => ({
  kind,
  sessionId,
  payload,
});

describe("CHANGE_SCOPE_KINDS / normalizeChangeScopeKind", () => {
  it("取值只有 surface 与 normal", () => {
    expect([...CHANGE_SCOPE_KINDS]).toEqual(["surface", "normal"]);
  });

  it("合法值原样返回,其余一律 null(不做大小写/别名宽松)", () => {
    expect(normalizeChangeScopeKind("surface")).toBe("surface");
    expect(normalizeChangeScopeKind("normal")).toBe("normal");
    for (const bad of ["Surface", "surf", "", " ", null, undefined, 1, {}, []]) {
      expect(normalizeChangeScopeKind(bad)).toBeNull();
    }
  });
});

describe("applyChangeScopeCorrection", () => {
  it("surface → normal:覆盖 scope、清空 matched、标记来源", () => {
    const base = { scope: "surface" as const, matched: ["替换", "统一"] };
    const r = applyChangeScopeCorrection(base, correction());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope).toBe("normal");
    expect(r.matched).toEqual([]);
    expect(r.source).toBe("corrected");
    expect(r.correctedBy).toBe("agent");
    expect(r.correctedReason).toBe("只改了单点文案");
    expect(r.correctedAt).toBe(1_700_000_000_000);
  });

  it("normal → surface 同样可更正(双向)", () => {
    const r = applyChangeScopeCorrection(
      { scope: "normal", matched: [] },
      correction({ scope: "surface", reason: "其实是换代" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toBe("surface");
  });

  it("不改 base(不可变)", () => {
    const base = { scope: "surface" as const, matched: ["替换"] };
    const snapshot = JSON.stringify(base);
    applyChangeScopeCorrection(base, correction());
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("确定性:同入参两次结果深相等", () => {
    const base = { scope: "surface" as const, matched: ["迁移"] };
    expect(applyChangeScopeCorrection(base, correction())).toEqual(applyChangeScopeCorrection(base, correction()));
  });

  it("by 为空 → INVALID(不 throw)", () => {
    expect(applyChangeScopeCorrection({ scope: "surface", matched: [] }, correction({ by: "   " }))).toEqual({ ok: false, code: "INVALID" });
  });

  it("reason 为空 → INVALID", () => {
    expect(applyChangeScopeCorrection({ scope: "surface", matched: [] }, correction({ reason: "" }))).toEqual({ ok: false, code: "INVALID" });
  });

  it("scope 非法 / 结构坏 / at 非数字 → INVALID", () => {
    const base = { scope: "surface" as const, matched: [] };
    expect(applyChangeScopeCorrection(base, { ...correction(), scope: "SurFace" })).toEqual({ ok: false, code: "INVALID" });
    expect(applyChangeScopeCorrection(base, null)).toEqual({ ok: false, code: "INVALID" });
    expect(applyChangeScopeCorrection(base, "normal")).toEqual({ ok: false, code: "INVALID" });
    expect(applyChangeScopeCorrection(base, { ...correction(), at: Number.NaN })).toEqual({ ok: false, code: "INVALID" });
    expect(applyChangeScopeCorrection(base, [correction()])).toEqual({ ok: false, code: "INVALID" });
  });

  it("reason 超过 300 字 → INVALID", () => {
    const r = applyChangeScopeCorrection({ scope: "normal", matched: [] }, correction({ reason: "长".repeat(301) }));
    expect(r).toEqual({ ok: false, code: "INVALID" });
    expect(applyChangeScopeCorrection({ scope: "normal", matched: [] }, correction({ reason: "长".repeat(300) })).ok).toBe(true);
  });
});

describe("normalizeChangeScopeCorrection", () => {
  it("合法对象规整并 trim", () => {
    expect(normalizeChangeScopeCorrection({ scope: "surface", by: " agent ", reason: " 换实现 ", at: 5 })).toEqual({
      scope: "surface", by: "agent", reason: "换实现", at: 5,
    });
  });

  it("结构坏的一律 null", () => {
    for (const bad of [null, undefined, [], "x", 3, { scope: "normal" }, { scope: "normal", by: "a", reason: "b" }]) {
      expect(normalizeChangeScopeCorrection(bad)).toBeNull();
    }
  });
});

describe("changeScopeCorrectionEvent", () => {
  it("稳定 custom 形状(type/scope/by/reason/at)", () => {
    const e = changeScopeCorrectionEvent(correction({ scope: "surface" }));
    expect(e).toEqual({
      type: CHANGE_SCOPE_CORRECTION_TYPE,
      scope: "surface",
      by: "agent",
      reason: "只改了单点文案",
      at: 1_700_000_000_000,
    });
    expect(CHANGE_SCOPE_CORRECTION_TYPE).toBe("change.scope.correction");
  });

  it("确定性:两次同形", () => {
    expect(changeScopeCorrectionEvent(correction())).toEqual(changeScopeCorrectionEvent(correction()));
  });
});

describe("readChangeScopeCorrection", () => {
  it("无事件 / 空数组 → null", () => {
    expect(readChangeScopeCorrection([], "s1")).toBeNull();
  });

  it("读到合法更正", () => {
    const payload = changeScopeCorrectionEvent(correction());
    expect(readChangeScopeCorrection([ev(payload)], "s1")).toEqual(correction());
  });

  it("重复更正取最后一条", () => {
    const first = changeScopeCorrectionEvent(correction({ scope: "surface", at: 1 }));
    const second = changeScopeCorrectionEvent(correction({ scope: "normal", at: 2 }));
    expect(readChangeScopeCorrection([ev(first), ev(second)], "s1")?.scope).toBe("normal");
    expect(readChangeScopeCorrection([ev(second), ev(first)], "s1")?.scope).toBe("surface");
  });

  it("结构坏的事件跳过,不抛也不中断扫描", () => {
    const good = changeScopeCorrectionEvent(correction());
    const bads = [
      { kind: "custom", sessionId: "s1", payload: { type: CHANGE_SCOPE_CORRECTION_TYPE, scope: "weird", by: "a", reason: "b", at: 1 } },
      { kind: "custom", sessionId: "s1", payload: { type: CHANGE_SCOPE_CORRECTION_TYPE } },
      { kind: "custom", sessionId: "s1", payload: { type: "change.exempt", scope: "normal", by: "a", reason: "b", at: 1 } },
      { kind: "custom", sessionId: "s1", payload: null },
      { kind: "custom", sessionId: "s1", payload: "oops" },
      null as unknown as { kind: string; sessionId: string; payload: Record<string, unknown> },
    ];
    expect(readChangeScopeCorrection([...bads, ev(good)], "s1")).toEqual(correction());
  });

  it("会话隔离:别的会话的更正不算;缺 sessionId 的测试字面量可读", () => {
    const e = changeScopeCorrectionEvent(correction());
    expect(readChangeScopeCorrection([ev(e, "s2")], "s1")).toBeNull();
    expect(readChangeScopeCorrection([{ payload: e }], "s1")).toEqual(correction());
  });

  it("非 custom kind 跳过", () => {
    const e = changeScopeCorrectionEvent(correction());
    expect(readChangeScopeCorrection([{ kind: "message.system", sessionId: "s1", payload: e }], "s1")).toBeNull();
  });

  it("读取结果是新对象(不与事件共享引用)", () => {
    const payload = changeScopeCorrectionEvent(correction());
    const got = readChangeScopeCorrection([ev(payload)], "s1");
    expect(got).not.toBe(payload);
  });
});

describe("disciplineHintFor", () => {
  it("surface → normal:降级提示", () => {
    expect(disciplineHintFor("normal", "surface")).toBe("已降级为普通变更：不再要求全链路盘点，但仍需收尾审计标记");
  });

  it("normal → surface:升级提示指向 scan", () => {
    const hint = disciplineHintFor("surface", "normal");
    expect(hint).toBe("已升级为全链路变更：先 change_surface scan 再改");
    expect(hint).toContain("change_surface scan");
  });

  it("无变化/缺省 previous → 空串", () => {
    expect(disciplineHintFor("surface", "surface")).toBe("");
    expect(disciplineHintFor("normal", "normal")).toBe("");
    expect(disciplineHintFor("normal")).toBe("");
    expect(disciplineHintFor("surface", undefined)).toBe("");
  });
});
