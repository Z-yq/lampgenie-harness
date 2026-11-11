/**
 * 事件级冻结路由身份。
 * 口径:身份在入站时冻结一次,后续只校验不重算——同一事件不会因为某一跳的推导漂移而拿到另一身份。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ROUTE_IDENTITY_CODES,
  ROUTE_SOURCE_KINDS,
  describeRouteIdentity,
  freezeRouteIdentity,
  identityEquals,
  routeAdmission,
  verifyRouteIdentity,
  type FreezeContext,
  type RouteIdentity,
  type RouteSourceKind,
} from "../src/router/route-identity.js";

const T0 = 1_700_000_000_000;

function ctx(over: Partial<FreezeContext> = {}): FreezeContext {
  return {
    tenantId: "t-acme",
    sourceKind: "dm",
    subjectId: "u-1",
    threadId: "th-1",
    generation: 1,
    frozenAt: T0,
    allowedTenants: ["t-acme"],
    ...over,
  };
}

/** 与实现同源的期望 key:由冻结四要素派生,不含时刻。 */
function expectedKey(tenantId: string, kind: string, subject: string, thread: string): string {
  return createHash("sha256").update(`${tenantId}|${kind}|${subject}|${thread}`).digest("hex").slice(0, 24);
}

/** 冻结成功用例(失败直接抛,让用例在这里失败而不是静默)。 */
function mustFreeze(event: unknown, c: FreezeContext): RouteIdentity {
  const r = freezeRouteIdentity(event, c);
  if (!r.ok) throw new Error(`期望冻结成功,实际 ${r.code}`);
  return r.identity;
}

describe("冻结码表", () => {
  it("七个稳定码齐全且含 OK", () => {
    expect([...ROUTE_IDENTITY_CODES].sort()).toEqual(
      ["IDENTITY_MISMATCH", "INVALID", "NO_IDENTITY", "OK", "STALE_GENERATION", "TENANT_DENIED", "UNKNOWN_SOURCE"],
    );
    expect(ROUTE_SOURCE_KINDS).toHaveLength(6);
  });
});

describe("freezeRouteIdentity:五类(六种)来源", () => {
  it.each([...ROUTE_SOURCE_KINDS])("来源 %s 可冻结且来源类别原样落快照", (kind) => {
    const id = mustFreeze({}, ctx({ sourceKind: kind }));
    expect(id.sourceKind).toBe(kind);
    expect(id.key).toMatch(/^[0-9a-f]{24}$/);
  });

  it.each(["webhook", "system"] as RouteSourceKind[])("匿名来源 %s 允许缺 subjectId", (kind) => {
    const id = mustFreeze({}, ctx({ sourceKind: kind, subjectId: undefined }));
    expect(id.subjectId).toBeUndefined();
    expect(id.sourceKind).toBe(kind);
  });

  it.each(["dm", "group", "thread", "cron"] as RouteSourceKind[])("来源 %s 缺 subjectId → NO_IDENTITY", (kind) => {
    expect(freezeRouteIdentity({}, ctx({ sourceKind: kind, subjectId: undefined }))).toEqual({
      ok: false,
      code: "NO_IDENTITY",
    });
  });

  it("空白 subjectId 等同缺失 → NO_IDENTITY", () => {
    expect(freezeRouteIdentity({}, ctx({ subjectId: "   " }))).toEqual({ ok: false, code: "NO_IDENTITY" });
  });
});

describe("freezeRouteIdentity:来源与租户守卫", () => {
  it("未知来源类别 → UNKNOWN_SOURCE", () => {
    expect(freezeRouteIdentity({}, ctx({ sourceKind: "email" }))).toEqual({ ok: false, code: "UNKNOWN_SOURCE" });
  });

  it("来源缺失 → UNKNOWN_SOURCE", () => {
    expect(freezeRouteIdentity({}, ctx({ sourceKind: "" }))).toEqual({ ok: false, code: "UNKNOWN_SOURCE" });
  });

  it("tenantId 为空 → TENANT_DENIED", () => {
    expect(freezeRouteIdentity(null, ctx({ tenantId: "  " }))).toEqual({ ok: false, code: "TENANT_DENIED" });
  });

  it("租户不在 allowedTenants → TENANT_DENIED", () => {
    expect(freezeRouteIdentity({}, ctx({ tenantId: "t-other", allowedTenants: ["t-acme"] }))).toEqual({
      ok: false,
      code: "TENANT_DENIED",
    });
  });

  it("不提供 allowedTenants → 不做租户白名单限制", () => {
    const id = mustFreeze({}, ctx({ tenantId: "t-any", allowedTenants: undefined }));
    expect(id.tenantId).toBe("t-any");
  });

  it("ctx 不是对象 → INVALID 且不抛", () => {
    expect(freezeRouteIdentity({}, null as unknown as FreezeContext)).toEqual({ ok: false, code: "INVALID" });
    expect(freezeRouteIdentity({}, "x" as unknown as FreezeContext)).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("freezeRouteIdentity:key 稳定与冻结快照", () => {
  it("key 与四要素公式一致且为 24 位十六进制", () => {
    const id = mustFreeze({}, ctx());
    expect(id.key).toBe(expectedKey("t-acme", "dm", "u-1", "th-1"));
  });

  it("同一输入两次冻结 → 同 key(确定性)", () => {
    const a = mustFreeze({ tenantId: "t-acme" }, ctx());
    const b = mustFreeze({ tenantId: "t-acme" }, ctx());
    expect(a.key).toBe(b.key);
    expect(a).toEqual(b);
    expect(identityEquals(a, b)).toBe(true);
  });

  it("换租户 → key 变化", () => {
    const a = mustFreeze({}, ctx({ tenantId: "t-acme", allowedTenants: ["t-acme", "t-beta"] }));
    const b = mustFreeze({}, ctx({ tenantId: "t-beta", allowedTenants: ["t-acme", "t-beta"] }));
    expect(a.key).not.toBe(b.key);
  });

  it("缺省 threadId 按空串参与 key,快照里不出现该字段", () => {
    const id = mustFreeze({}, ctx({ threadId: undefined }));
    expect(id.threadId).toBeUndefined();
    expect(id.key).toBe(expectedKey("t-acme", "dm", "u-1", ""));
    expect("threadId" in id).toBe(false);
  });

  it("generation 缺省 0、frozenAt 缺省 0(不读系统时钟)", () => {
    const id = mustFreeze({}, {
      tenantId: "t-acme",
      sourceKind: "dm",
      subjectId: "u-1",
    });
    expect(id.generation).toBe(0);
    expect(id.frozenAt).toBe(0);
  });

  it("冻结快照不可变:Object.isFrozen 且写入抛错", () => {
    const id = mustFreeze({}, ctx());
    expect(Object.isFrozen(id)).toBe(true);
    expect(() => { (id as { tenantId: string }).tenantId = "t-evil"; }).toThrow();
    expect(id.tenantId).toBe("t-acme");
  });

  it("事件字段可补齐 ctx 的空位", () => {
    const id = mustFreeze(
      { tenantId: "t-acme", sourceKind: "group", subjectId: "u-9", threadId: "th-9" },
      { tenantId: "", sourceKind: "" },
    );
    expect(id).toMatchObject({ tenantId: "t-acme", sourceKind: "group", subjectId: "u-9", threadId: "th-9" });
  });

  it("同一字段 ctx 优先于事件(策略口径压过自报)", () => {
    const id = mustFreeze({ subjectId: "u-evil", tenantId: "t-evil" }, ctx({ subjectId: "u-1" }));
    expect(id.subjectId).toBe("u-1");
    expect(id.tenantId).toBe("t-acme");
  });
});

describe("verifyRouteIdentity:只校验不重算", () => {
  it("正常身份 → OK 且 reasons 为空", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity(id)).toEqual({ ok: true, code: "OK", reasons: [] });
  });

  it("非对象/缺字段 → INVALID,不抛", () => {
    expect(verifyRouteIdentity(null).code).toBe("INVALID");
    expect(verifyRouteIdentity("id").code).toBe("INVALID");
    expect(verifyRouteIdentity({ ...mustFreeze({}, ctx()), key: undefined }).code).toBe("INVALID");
  });

  it("key 格式非法 → INVALID", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity({ ...id, key: "not-a-key" }).code).toBe("INVALID");
  });

  it("未知 sourceKind → INVALID", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity({ ...id, sourceKind: "email" }).code).toBe("INVALID");
  });

  it("key 被改写但格式合法 → 仍 OK(证明不重算 key)", () => {
    const id = mustFreeze({}, ctx());
    const tampered = Object.freeze({ ...id, key: "0".repeat(24) });
    expect(verifyRouteIdentity(tampered)).toEqual({ ok: true, code: "OK", reasons: [] });
  });

  it("代际不一致 → STALE_GENERATION", () => {
    const id = mustFreeze({}, ctx({ generation: 1 }));
    const v = verifyRouteIdentity(id, { currentGeneration: 2 });
    expect(v.ok).toBe(false);
    expect(v.code).toBe("STALE_GENERATION");
    expect(v.reasons[0]).toContain("generation");
  });

  it("代际一致 → OK", () => {
    expect(verifyRouteIdentity(mustFreeze({}, ctx({ generation: 3 })), { currentGeneration: 3 }).code).toBe("OK");
  });

  it.each([
    ["来源类别", { sourceKind: "group" }],
    ["主体", { subjectId: "u-2" }],
    ["线程", { threadId: "th-2" }],
    ["租户", { tenantId: "t-other" }],
  ])("事件与冻结来源不一致(%s)→ IDENTITY_MISMATCH", (_label, event) => {
    const id = mustFreeze({}, ctx());
    const v = verifyRouteIdentity(id, { event });
    expect(v.code).toBe("IDENTITY_MISMATCH");
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("事件与冻结来源一致 → OK", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity(id, {
      event: { tenantId: "t-acme", sourceKind: "dm", subjectId: "u-1", threadId: "th-1" },
    }).code).toBe("OK");
  });

  it("事件里的旧通道名(panel/im)不是来源类别,忽略不误判", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity(id, { event: { source: "im", senderId: "u-1" } }).code).toBe("OK");
  });

  it("策略版本不参与身份判定(版本变化不清空身份)", () => {
    const id = mustFreeze({}, ctx());
    expect(verifyRouteIdentity(id, { policyVersion: "another-version" }).code).toBe("OK");
  });
});

describe("routeAdmission:身份门 + gate 结果", () => {
  it("身份可用 → gate 结果原样返回(同引用)", () => {
    const id = mustFreeze({}, ctx());
    const result = { admissible: true, strength: "explicit", reason: "whatever" };
    expect(routeAdmission(id, () => result)).toBe(result);
  });

  it("身份不可用 → strength=none + route-identity:<code>", () => {
    const r = routeAdmission(null, () => ({ admissible: true }));
    expect(r).toEqual({ admissible: false, strength: "none", reason: "route-identity:INVALID" });
  });

  it("代际不一致 → 拒绝码为 STALE_GENERATION 且 gate 不被调用", () => {
    let called = false;
    const id = mustFreeze({}, ctx({ generation: 1 }));
    const r = routeAdmission(id, () => { called = true; return { admissible: true }; }, { currentGeneration: 9 });
    expect(called).toBe(false);
    expect(r).toMatchObject({ admissible: false, reason: "route-identity:STALE_GENERATION" });
  });

  it("gate 自身抛错 → 按 INVALID 拒,不向外抛", () => {
    const id = mustFreeze({}, ctx());
    const r = routeAdmission(id, () => { throw new Error("boom"); });
    expect(r).toMatchObject({ admissible: false, strength: "none", reason: "route-identity:INVALID" });
  });
});

describe("identityEquals / describeRouteIdentity", () => {
  it("同一身份 true;换主体/generation false", () => {
    const a = mustFreeze({}, ctx());
    const b = mustFreeze({}, ctx());
    expect(identityEquals(a, b)).toBe(true);
    expect(identityEquals(a, mustFreeze({}, ctx({ subjectId: "u-2" })))).toBe(false);
    expect(identityEquals(a, mustFreeze({}, ctx({ generation: 2 })))).toBe(false);
    expect(identityEquals(a, { ...a, frozenAt: T0 + 1 })).toBe(true); // frozenAt 是采集时刻,不参与语义相等
  });

  it("非法输入返回 false 不抛", () => {
    expect(identityEquals(null, null)).toBe(true);
    expect(identityEquals(null, {})).toBe(false);
    expect(identityEquals(undefined, 1)).toBe(false);
  });

  it("摘要 ≤200 字且含关键要素;非法身份给稳定字样", () => {
    const text = describeRouteIdentity(mustFreeze({}, ctx()));
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain("t-acme");
    expect(text).toContain("u-1");
    expect(text).toContain("gen=1");
    expect(describeRouteIdentity(42)).toBe("route-identity:INVALID");
  });
});
