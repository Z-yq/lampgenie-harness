/**
 * mandate-lifecycle 纯逻辑直测(零 IO):吊销幂等/必填、过期边界与不可逆、
 * resume 复验(吊销>过期>策略变更)、affectedTickets 过滤与去重排序、
 * 不可变与确定性。
 */
import { describe, expect, it } from "vitest";
import {
  MANDATE_CODES,
  affectedTickets,
  canAdmitWithMandate,
  expireMandate,
  isMandateExpired,
  revalidateForResume,
  revokeMandate,
  type MandateLike,
} from "../src/agent/mandate-lifecycle.ts";

const base = (over: Partial<MandateLike> = {}): MandateLike => ({
  id: "md-1",
  policyVersion: "v1",
  status: "active",
  issuedAt: 1_000,
  expiresAt: 10_000,
  ticketIds: ["t-1"],
  ...over,
});

describe("MANDATE_CODES / 形态", () => {
  it("六个码齐备且互不相同", () => {
    const codes = Object.values(MANDATE_CODES);
    expect(new Set(codes).size).toBe(6);
    expect(codes).toEqual(["OK", "REVOKED", "EXPIRED", "POLICY_CHANGED", "NOT_FOUND", "INVALID"]);
  });

  it("isMandateExpired:expiresAt 是含边界上界", () => {
    const m = base({ expiresAt: 5_000 });
    expect(isMandateExpired(m, 4_999)).toBe(false);
    expect(isMandateExpired(m, 5_000)).toBe(true);
    expect(isMandateExpired(m, 5_001)).toBe(true);
 // 无 expiresAt = 不过期
    expect(isMandateExpired(base({ expiresAt: undefined }), 10 ** 12)).toBe(false);
  });
});

describe("revokeMandate", () => {
  it("成功吊销:返回新对象,状态与元数据齐全", () => {
    const m = base();
    const r = revokeMandate(m, { by: "u-1", reason: "换个做法", at: 2_000 });
    expect(r.code).toBe("OK");
    expect(r.mandate).toEqual({
      ...m,
      status: "revoked",
      revokedAt: 2_000,
      revokedBy: "u-1",
      revokeReason: "换个做法",
    });
  });

  it("不可变:入参对象不被修改", () => {
    const m = base();
    const snapshot = JSON.stringify(m);
    revokeMandate(m, { by: "u-1", reason: "stop", at: 2_000 });
    expect(JSON.stringify(m)).toBe(snapshot);
    expect(m.status).toBe("active");
  });

  it("已吊销幂等:返回原对象引用 + REVOKED", () => {
    const revoked = base({ status: "revoked", revokedAt: 1, revokedBy: "a", revokeReason: "r" });
    const r = revokeMandate(revoked, { by: "u-2", reason: "again", at: 9 });
    expect(r.code).toBe("REVOKED");
    expect(r.mandate).toBe(revoked);
  });

  it("已过期不可逆:保持 expired,code=EXPIRED", () => {
    const expired = base({ status: "expired" });
    const r = revokeMandate(expired, { by: "u-1", reason: "stop", at: 2_000 });
    expect(r.code).toBe("EXPIRED");
    expect(r.mandate).toBe(expired);
  });

  it("by 缺失 → INVALID,对象不变", () => {
    const m = base();
    const r = revokeMandate(m, { reason: "stop", at: 2_000 });
    expect(r.code).toBe("INVALID");
    expect(r.mandate).toBe(m);
  });

  it("reason 缺失或空串 → INVALID", () => {
    const m = base();
    expect(revokeMandate(m, { by: "u-1", at: 2_000 }).code).toBe("INVALID");
    expect(revokeMandate(m, { by: "u-1", reason: "   ", at: 2_000 }).code).toBe("INVALID");
    expect(revokeMandate(m, { by: "  ", reason: "stop", at: 2_000 }).code).toBe("INVALID");
  });

  it("凭证缺失 → NOT_FOUND;形态非法 → INVALID", () => {
    expect(revokeMandate(undefined, { by: "u", reason: "r" }).code).toBe("NOT_FOUND");
    expect(revokeMandate(null, { by: "u", reason: "r" }).code).toBe("NOT_FOUND");
    const bad = { ...base(), status: "paused" } as unknown as MandateLike;
    expect(revokeMandate(bad, { by: "u", reason: "r" }).code).toBe("INVALID");
  });

  it("缺省吊销时刻按 0 归一化(不读系统时间)", () => {
    const r = revokeMandate(base(), { by: "u", reason: "r" });
    expect(r.mandate?.revokedAt).toBe(0);
  });
});

describe("expireMandate", () => {
  it("到期即过期:status → expired,入参不变", () => {
    const m = base({ expiresAt: 5_000 });
    const r = expireMandate(m, 6_000);
    expect(r.mandate?.status).toBe("expired");
    expect(m.status).toBe("active");
    expect(r.code).toBe("OK");
  });

  it("边界:now === expiresAt → 过期", () => {
    const r = expireMandate(base({ expiresAt: 5_000 }), 5_000);
    expect(r.mandate?.status).toBe("expired");
  });

  it("未到期 / 无 expiresAt → 原样返回", () => {
    const m = base({ expiresAt: 5_000 });
    const r = expireMandate(m, 4_999);
    expect(r.mandate).toBe(m);
    expect(r.code).toBe("OK");
    const noExpiry = base({ expiresAt: undefined });
    expect(expireMandate(noExpiry, 10 ** 12).mandate).toBe(noExpiry);
  });

  it("已 expired 幂等 → EXPIRED;已 revoked 不被改写 → REVOKED", () => {
    const expired = base({ status: "expired" });
    expect(expireMandate(expired, 10 ** 9)).toMatchObject({ mandate: expired, code: "EXPIRED" });
    const revoked = base({ status: "revoked", revokedBy: "u", revokedAt: 1, revokeReason: "r" });
    expect(expireMandate(revoked, 10 ** 9)).toMatchObject({ mandate: revoked, code: "REVOKED" });
  });

  it("缺失凭证 → NOT_FOUND", () => {
    expect(expireMandate(null, 10 ** 9).code).toBe("NOT_FOUND");
  });
});

describe("revalidateForResume / canAdmitWithMandate", () => {
  it("active + 同版本 + 未过期 → OK", () => {
    const v = revalidateForResume(base(), "v1", 9_999);
    expect(v).toEqual({ ok: true, code: "OK", reason: "ok" });
  });

  it("revoked → REVOKED(即使版本与时刻都匹配)", () => {
    const v = revalidateForResume(base({ status: "revoked" }), "v1", 1);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("REVOKED");
  });

  it("expired 状态 → EXPIRED", () => {
    const v = revalidateForResume(base({ status: "expired" }), "v1", 1);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("EXPIRED");
  });

  it("status=active 但已过 expiresAt → EXPIRED(不因状态字面 active 放行)", () => {
    const v = revalidateForResume(base({ expiresAt: 5_000 }), "v1", 5_000);
    expect(v.code).toBe("EXPIRED");
    expect(v.ok).toBe(false);
  });

  it("策略版本不一致 → POLICY_CHANGED,reason 要求重新审批", () => {
    const v = revalidateForResume(base(), "v2", 1);
    expect(v.ok).toBe(false);
    expect(v.code).toBe("POLICY_CHANGED");
    expect(v.reason).toMatch(/re-approval/);
  });

  it("吊销优先于策略变更(先报 REVOKED)", () => {
    expect(revalidateForResume(base({ status: "revoked" }), "v2", 1).code).toBe("REVOKED");
  });

  it("缺失/非法凭证 fail-closed:NOT_FOUND / INVALID", () => {
    expect(revalidateForResume(null, "v1", 1).code).toBe("NOT_FOUND");
    expect(revalidateForResume(undefined, "v1", 1).code).toBe("NOT_FOUND");
    const bad = { id: "x" } as unknown as MandateLike;
    expect(revalidateForResume(bad, "v1", 1).code).toBe("INVALID");
  });

  it("当前版本缺失无法证明有效 → INVALID", () => {
    expect(revalidateForResume(base(), "", 1).code).toBe("INVALID");
  });

  it("canAdmitWithMandate 与 revalidateForResume 同源", () => {
    const ok = canAdmitWithMandate(base(), "v1", 1);
    expect(ok).toEqual({ ok: true, code: "OK" });
    expect(canAdmitWithMandate(base(), "v2", 1)).toEqual({ ok: false, code: "POLICY_CHANGED" });
    expect(canAdmitWithMandate(base({ status: "revoked" }), "v1", 1)).toEqual({ ok: false, code: "REVOKED" });
    expect(canAdmitWithMandate(null, "v1", 1)).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("affectedTickets", () => {
  it("只点名 active 且版本不同的 mandate", () => {
    const list = [
      base({ id: "a", policyVersion: "v1", ticketIds: ["t1"] }),
      base({ id: "b", policyVersion: "v2", ticketIds: ["t2"] }), // 同版本:不受影响
      base({ id: "c", policyVersion: "v1", status: "revoked", ticketIds: ["t3"] }),
      base({ id: "d", policyVersion: "v1", status: "expired", ticketIds: ["t4"] }),
    ];
    const r = affectedTickets(list, "v2");
    expect(r).toEqual([{ mandateId: "a", policyVersion: "v1", ticketIds: ["t1"] }]);
  });

  it("ticketIds 去重并排序,mandate 按 id 排序", () => {
    const list = [
      base({ id: "m-2", ticketIds: ["t-9", "t-1", "t-9"] }),
      base({ id: "m-1", ticketIds: ["t-5"] }),
    ];
    const r = affectedTickets(list, "v9");
    expect(r.map((x) => x.mandateId)).toEqual(["m-1", "m-2"]);
    expect(r[1].ticketIds).toEqual(["t-1", "t-9"]);
  });

  it("同 id 分片合并去重,不重复通知", () => {
    const r = affectedTickets([
      base({ id: "m-1", ticketIds: ["t-1"] }),
      base({ id: "m-1", ticketIds: ["t-2", "t-1"] }),
    ], "v9");
    expect(r).toHaveLength(1);
    expect(r[0].ticketIds).toEqual(["t-1", "t-2"]);
  });

  it("空表 / 非法输入 → 空数组(不 throw)", () => {
    expect(affectedTickets([], "v2")).toEqual([]);
    expect(affectedTickets([] as MandateLike[], "")).toEqual([]);
    expect(affectedTickets([null, undefined, { id: "x" } as unknown as MandateLike], "v2")).toEqual([]);
  });

  it("确定性:同输入两次深相等,且不修改入参", () => {
    const list = [base({ id: "m-1", ticketIds: ["t-2", "t-1"] }), base({ id: "m-0", ticketIds: ["t-3"] })];
    const snapshot = JSON.stringify(list);
    const a = affectedTickets(list, "v9");
    const b = affectedTickets(list, "v9");
    expect(a).toEqual(b);
    expect(JSON.stringify(list)).toBe(snapshot);
  });
});
