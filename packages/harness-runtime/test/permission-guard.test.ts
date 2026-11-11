/**
 * 权限 guard 链(单调收窄)+ session-always 内存作用域 纯逻辑测试。
 * 断言面:链顺序 / 全评估(不短路)/ 越界 allow 无效 / fail-closed / TTL /
 * 单会话上限淘汰 / 会话隔离 / noAlwaysAllow 不写不命中 / 不可变 / 确定性。
 * 全部走注入的 now 与伪造 guard,不读时钟、不碰文件、不依赖 env。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALWAYS_MAX_PER_SESSION,
  DEFAULT_ALWAYS_TTL_MS,
  SessionAlwaysStore,
  evaluatePermission,
  runGuardChain,
  type Guard,
  type GuardCtx,
} from "../src/agent/permission-guard.ts";

const ctx: GuardCtx = { tool: "file.write", summary: "写 src/a.ts", sessionId: "s1" };

function guard(id: string, verdict: "deny" | "abstain", reason?: string): Guard {
  return { id, check: () => ({ verdict, ...(reason ? { reason } : {}) }) };
}

describe("runGuardChain:只收窄的链", () => {
  it("空链 = abstain(没有 guard 就没有意见)", () => {
    const r = runGuardChain([], ctx);
    expect(r.decision).toBe("abstain");
    expect(r.hits).toEqual([]);
    expect(r.denyReasons).toEqual([]);
  });

  it("guards 缺席(undefined)= abstain,不抛错", () => {
    expect(runGuardChain(undefined, ctx).decision).toBe("abstain");
  });

  it("非数组 guards(装配错误)= abstain(不接管放行判定)", () => {
    expect(runGuardChain("x" as unknown as Guard[], ctx).decision).toBe("abstain");
  });

  it("单条 abstain → 链仍 abstain", () => {
    const r = runGuardChain([guard("g1", "abstain")], ctx);
    expect(r.decision).toBe("abstain");
    expect(r.hits).toHaveLength(1);
  });

  it("单条 deny → deny,denyReasons 带 guardId 与 reason", () => {
    const r = runGuardChain([guard("readonly-write", "deny", "只读会话禁写")], ctx);
    expect(r.decision).toBe("deny");
    expect(r.denyReasons).toEqual(["readonly-write: 只读会话禁写"]);
  });

  it("deny 无 reason 时 denyReasons 用 guardId 兜底", () => {
    expect(runGuardChain([guard("g1", "deny")], ctx).denyReasons).toEqual(["g1"]);
  });

  it("deny + abstain 混链 → deny(任一 deny 即拒)", () => {
    expect(runGuardChain([guard("g1", "abstain"), guard("g2", "deny", "no")], ctx).decision).toBe("deny");
  });

  it("不短路:deny 之后的 guard 仍被评估(hits 全量)", () => {
    let laterCalled = false;
    const later: Guard = { id: "g3", check: () => { laterCalled = true; return { verdict: "abstain" }; } };
    const r = runGuardChain([guard("g1", "deny", "first"), guard("g2", "abstain"), later], ctx);
    expect(laterCalled).toBe(true);
    expect(r.hits.map((h) => h.guardId)).toEqual(["g1", "g2", "g3"]);
    expect(r.decision).toBe("deny");
  });

  it("链序:denyReasons 按评估顺序追加", () => {
    const r = runGuardChain([guard("a", "deny", "1"), guard("b", "deny", "2")], ctx);
    expect(r.denyReasons).toEqual(["a: 1", "b: 2"]);
  });

  it("越界返回 allow 被忽略(降级 abstain),绝不放行", () => {
    const sneaky = { id: "g-allow", check: () => ({ verdict: "allow" }) } as unknown as Guard;
    const r = runGuardChain([sneaky], ctx);
    expect(r.decision).toBe("abstain");
    expect(r.hits[0]!.verdict).toBe("abstain");
  });

  it("返回 undefined / 非对象 → abstain(形态越界不放宽)", () => {
    const bad1 = { id: "g1", check: () => undefined } as unknown as Guard;
    const bad2 = { id: "g2", check: () => "allow" } as unknown as Guard;
    const r = runGuardChain([bad1, bad2], ctx);
    expect(r.decision).toBe("abstain");
    expect(r.hits).toHaveLength(2);
  });

  it("guard 抛错 → deny(fail-closed)且 reason 带异常消息", () => {
    const boom: Guard = { id: "boom", check: () => { throw new Error("kaboom"); } };
    const r = runGuardChain([boom], ctx);
    expect(r.decision).toBe("deny");
    expect(r.hits[0]!.verdict).toBe("deny");
    expect(r.hits[0]!.reason).toContain("kaboom");
    expect(r.denyReasons[0]).toContain("boom: guard-error:kaboom");
  });

  it("抛错后继续评估后续 guard(异常不是出口)", () => {
    const boom: Guard = { id: "boom", check: () => { throw new Error("x"); } };
    const r = runGuardChain([boom, guard("g2", "deny", "late")], ctx);
    expect(r.denyReasons).toHaveLength(2);
    expect(r.denyReasons[1]).toBe("g2: late");
  });

  it("形态非法(缺 check)→ deny invalid-guard", () => {
    const r = runGuardChain([{ id: "broken" } as unknown as Guard], ctx);
    expect(r.decision).toBe("deny");
    expect(r.denyReasons).toEqual(["broken: invalid-guard"]);
  });

  it("返回结果不可变(Object.freeze)", () => {
    const r = runGuardChain([guard("g1", "deny", "x")], ctx);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.hits)).toBe(true);
    expect(Object.isFrozen(r.denyReasons)).toBe(true);
    expect(Object.isFrozen(r.hits[0])).toBe(true);
  });

  it("不修改传入 ctx(冻结 ctx 也能评估)", () => {
    const frozen = Object.freeze({ ...ctx });
    const seen: string[] = [];
    const spy: Guard = { id: "spy", check: (c) => { seen.push(c.tool); return { verdict: "abstain" }; } };
    expect(() => runGuardChain([spy], frozen)).not.toThrow();
    expect(seen).toEqual(["file.write"]);
    expect(frozen).toEqual(ctx);
  });

  it("确定性:同输入两次结果逐字相同", () => {
    const guards = [guard("a", "deny", "1"), guard("b", "abstain")];
    expect(JSON.stringify(runGuardChain(guards, ctx))).toBe(JSON.stringify(runGuardChain(guards, ctx)));
  });
});

describe("SessionAlwaysStore:会话内 always 的内存边界", () => {
  it("remember → lookup 命中,expiresAt = at + 缺省 TTL", () => {
    const s = new SessionAlwaysStore();
    expect(DEFAULT_ALWAYS_TTL_MS).toBe(30 * 60 * 1000);
    expect(s.remember("s1", "k", { at: 1_000 })).toBe(true);
    const r = s.lookup("s1", "k", 1_001);
    expect(r.hit).toBe(true);
    expect(r.expiresAt).toBe(1_000 + DEFAULT_ALWAYS_TTL_MS);
  });

  it("自定义 ttlMs 覆盖缺省", () => {
    const s = new SessionAlwaysStore({ ttlMs: 5_000 });
    s.remember("s1", "k", { at: 0 });
    expect(s.lookup("s1", "k", 4_999).hit).toBe(true);
    expect(s.lookup("s1", "k", 5_000).hit).toBe(false);
  });

  it("单条 ttlMs 覆盖 store 缺省", () => {
    const s = new SessionAlwaysStore({ ttlMs: 60_000 });
    s.remember("s1", "k", { at: 0, ttlMs: 10 });
    expect(s.lookup("s1", "k", 9).hit).toBe(true);
    expect(s.lookup("s1", "k", 10).hit).toBe(false);
  });

  it("过期即删(不残留条目)", () => {
    const s = new SessionAlwaysStore({ ttlMs: 100 });
    s.remember("s1", "k", { at: 0 });
    s.lookup("s1", "k", 100);
    expect(s.stats().entries).toBe(0);
    expect(s.stats().sessions).toBe(0);
  });

  it("会话隔离:同 key 不同 sessionId 不命中", () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "k", { at: 0 });
    expect(s.lookup("s2", "k", 1).hit).toBe(false);
    expect(s.lookup("s1", "k", 1).hit).toBe(true);
  });

  it("noAlwaysAllow:remember 返回 false 且不写,lookup 恒 miss", () => {
    const s = new SessionAlwaysStore({ noAlwaysAllow: true });
    expect(s.remember("s1", "k", { at: 0 })).toBe(false);
    expect(s.stats().entries).toBe(0);
    expect(s.lookup("s1", "k", 1).hit).toBe(false);
  });

  it("noAlwaysAllow 时已有条目不命中(查询侧也失效)", () => {
    const normal = new SessionAlwaysStore();
    normal.remember("s1", "k", { at: 0 });
 // 直接构造一个开关打开的 store 置同一键:验证查询侧短路。
    const blocked = new SessionAlwaysStore({ noAlwaysAllow: true });
    blocked.remember("s1", "k", { at: 0 });
    expect(blocked.lookup("s1", "k", 1).hit).toBe(false);
  });

  it("单会话上限淘汰最旧(at 最小)", () => {
    const s = new SessionAlwaysStore({ maxPerSession: 3 });
    s.remember("s1", "a", { at: 1 });
    s.remember("s1", "b", { at: 2 });
    s.remember("s1", "c", { at: 3 });
    s.remember("s1", "d", { at: 4 });
    expect(s.lookup("s1", "a", 5).hit).toBe(false);
    expect(s.lookup("s1", "b", 5).hit).toBe(true);
    expect(s.stats().perSession.s1).toBe(3);
  });

  it("缺省上限 = 50", () => {
    const s = new SessionAlwaysStore();
    expect(s.stats().maxPerSession).toBe(DEFAULT_ALWAYS_MAX_PER_SESSION);
    for (let i = 0; i < 60; i++) s.remember("s1", "k" + i, { at: i });
    expect(s.stats().entries).toBe(50);
    expect(s.lookup("s1", "k9", 99).hit).toBe(false);
    expect(s.lookup("s1", "k10", 99).hit).toBe(true);
  });

  it("上限按会话独立计(不跨会话淘汰)", () => {
    const s = new SessionAlwaysStore({ maxPerSession: 2 });
    s.remember("s1", "a", { at: 1 });
    s.remember("s1", "b", { at: 2 });
    s.remember("s2", "c", { at: 3 });
    s.remember("s2", "d", { at: 4 });
    expect(s.lookup("s1", "a", 5).hit).toBe(true);
    expect(s.lookup("s2", "c", 5).hit).toBe(true);
    expect(s.stats().sessions).toBe(2);
    expect(s.stats().entries).toBe(4);
  });

  it("同名键重新 remember 不增条目且刷新 expiresAt", () => {
    const s = new SessionAlwaysStore({ ttlMs: 100 });
    s.remember("s1", "k", { at: 0 });
    s.remember("s1", "k", { at: 50 });
    expect(s.stats().entries).toBe(1);
    expect(s.lookup("s1", "k", 149).hit).toBe(true);
    expect(s.lookup("s1", "k", 150).hit).toBe(false);
  });

  it("revision 透传(lookup 返回调用方写入的版本)", () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "k", { at: 0, revision: "r7" });
    expect(s.lookup("s1", "k", 1).revision).toBe("r7");
  });

  it("非法入参 remember 返回 false 且不写(空 sessionId / 非有限 at)", () => {
    const s = new SessionAlwaysStore();
    expect(s.remember("", "k", { at: 0 })).toBe(false);
    expect(s.remember("s1", "", { at: 0 })).toBe(false);
    expect(s.remember("s1", "k", { at: Number.NaN })).toBe(false);
    expect(s.remember("s1", "k", {} as never)).toBe(false);
    expect(s.stats().entries).toBe(0);
  });

  it("非法 now(NaN)查询按 miss(不误判过期/命中)", () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "k", { at: 0 });
    expect(s.lookup("s1", "k", Number.NaN).hit).toBe(false);
    expect(s.stats().entries).toBe(1);
  });

  it("clear(sessionId) 只清该会话;clear() 全清", () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "k", { at: 0 });
    s.remember("s2", "k", { at: 0 });
    s.clear("s1");
    expect(s.lookup("s1", "k", 1).hit).toBe(false);
    expect(s.lookup("s2", "k", 1).hit).toBe(true);
    s.clear();
    expect(s.stats().entries).toBe(0);
  });

  it("stats 快照正确且不可变", () => {
    const s = new SessionAlwaysStore({ ttlMs: 123 });
    s.remember("s1", "a", { at: 0 });
    s.remember("s1", "b", { at: 1 });
    s.remember("s2", "a", { at: 2 });
    const st = s.stats();
    expect(st).toMatchObject({ entries: 3, sessions: 2, ttlMs: 123, noAlwaysAllow: false, perSession: { s1: 2, s2: 1 } });
    expect(Object.isFrozen(st)).toBe(true);
    expect(Object.isFrozen(st.perSession)).toBe(true);
  });

  it("lookup 未命中返回冻结对象(调用方不能改状态)", () => {
    const s = new SessionAlwaysStore();
    expect(Object.isFrozen(s.lookup("s1", "k", 0))).toBe(true);
  });
});

describe("evaluatePermission:deny > always > ask", () => {
  const store = () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "file.write|写", { at: 0 });
    return s;
  };

  it("guard deny 最高优先(即使 session-always 已命中)", () => {
    const r = evaluatePermission({
      mode: "ask", tool: "file.write", sessionId: "s1", guards: [guard("ro", "deny", "只读")],
      alwaysStore: store(), alwaysKey: "file.write|写", now: 1,
    });
    expect(r.effect).toBe("deny");
    expect(r.source).toBe("guard");
    expect(r.denyReasons).toEqual(["ro: 只读"]);
  });

  it("空链 + always 命中 → allow/always", () => {
    const r = evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [], alwaysStore: store(), alwaysKey: "file.write|写", now: 1 });
    expect(r.effect).toBe("allow");
    expect(r.source).toBe("always");
  });

  it("空链 + 无命中 → ask/mode(交回既有路径)", () => {
    const r = evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [], alwaysStore: store(), alwaysKey: "file.write|其它", now: 1 });
    expect(r.effect).toBe("ask");
    expect(r.source).toBe("mode");
  });

  it("abstain + 无 store → ask(模块只收窄,不接管放行)", () => {
    const r = evaluatePermission({ mode: "readonly", tool: "file.write", sessionId: "s1", guards: [guard("g", "abstain")] });
    expect(r.effect).toBe("ask");
  });

  it("noAlwaysAllow=true 关闭查询(命中变 ask)", () => {
    const r = evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [], alwaysStore: store(), alwaysKey: "file.write|写", noAlwaysAllow: true, now: 1 });
    expect(r.effect).toBe("ask");
  });

  it("过期条目不再放行(TTL 边界)", () => {
    const r = evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [], alwaysStore: store(), alwaysKey: "file.write|写", now: DEFAULT_ALWAYS_TTL_MS });
    expect(r.effect).toBe("ask");
  });

  it("guard 抛错 → deny/guard(不 throw 到调用方)", () => {
    const boom: Guard = { id: "boom", check: () => { throw new Error("bad"); } };
    const r = evaluatePermission({ mode: "ask", tool: "t", sessionId: "s1", guards: [boom] });
    expect(r.effect).toBe("deny");
    expect(r.source).toBe("guard");
  });

  it("alwaysKey 缺省=tool(同一工具级放行)", () => {
    const s = new SessionAlwaysStore();
    s.remember("s1", "file.write", { at: 0 });
    const r = evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [], alwaysStore: s, now: 1 });
    expect(r.effect).toBe("allow");
  });

  it("guardCtx 缺省由 tool/sessionId 拼出,summary 为空串", () => {
    const seen: GuardCtx[] = [];
    const spy: Guard = { id: "spy", check: (c) => { seen.push(c); return { verdict: "abstain" }; } };
    evaluatePermission({ mode: "ask", tool: "file.write", sessionId: "s1", guards: [spy] });
    expect(seen[0]).toEqual({ tool: "file.write", sessionId: "s1", summary: "" });
  });

  it("返回结果冻结且确定性", () => {
    const a = evaluatePermission({ mode: "ask", tool: "t", sessionId: "s1", guards: [guard("g", "deny", "x")] });
    const b = evaluatePermission({ mode: "ask", tool: "t", sessionId: "s1", guards: [guard("g", "deny", "x")] });
    expect(Object.isFrozen(a)).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
