/**
 * 任务类别 → 模型/供应商路由表(纯逻辑层)逐条锚定。
 * 机制:。
 */
import { describe, it, expect } from "vitest";
import {
  TASK_MODEL_KINDS,
  isTaskModelKind,
  resolveTaskModelRoute,
  validateRoutingTable,
  type RouteRef,
} from "../src/agent/task-model-routing.ts";

/** 深冻结(含嵌套数组/对象),用于「不可变」断言。 */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe("isTaskModelKind / TASK_MODEL_KINDS", () => {
  it("九个类别按稳定顺序导出,成员判定命中", () => {
    expect([...TASK_MODEL_KINDS]).toEqual(["main", "compact", "title", "summary", "vision", "memory", "review", "digest", "subagent"]);
    for (const k of TASK_MODEL_KINDS) expect(isTaskModelKind(k)).toBe(true);
  });

  it("非成员/非字符串一律 false", () => {
    for (const v of ["bogus", "", "Main", undefined, null, 1, {}, []]) expect(isTaskModelKind(v)).toBe(false);
  });
});

describe("resolveTaskModelRoute:base 路径(A)", () => {
  it("无表 → source base,route/chain 都是 base 的拷贝", () => {
    const base: RouteRef = { providerId: "p1", model: "m1" };
    const r = resolveTaskModelRoute({ kind: "compact", base });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("base");
    expect(r.route).toEqual({ providerId: "p1", model: "m1" });
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]).toEqual(base);
    expect(r.route).not.toBe(base);
    expect(r.chain[0]).not.toBe(base);
  });

  it("有表但该 kind 未配置 → 走 base", () => {
    const r = resolveTaskModelRoute({ kind: "title", base: { model: "m" }, table: { main: { model: "x" } } });
    expect(r.ok && r.source).toBe("base");
    expect(r.ok && r.route.model).toBe("m");
  });

  it("表项为 null → 视同未配置,走 base", () => {
    const r = resolveTaskModelRoute({ kind: "title", base: { model: "m" }, table: { title: null as unknown as RouteRef } });
    expect(r.ok && r.source).toBe("base");
  });

  it("无 base 且无表项 → INVALID", () => {
    expect(resolveTaskModelRoute({ kind: "main" })).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("resolveTaskModelRoute:表命中(B)", () => {
  it("kind 命中 → source table,route 即表项内容", () => {
    const table = { compact: { providerId: "cheap", model: "haiku", apiKeyEnv: "K" } };
    const r = resolveTaskModelRoute({ kind: "compact", base: { model: "big" }, table });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("table");
    expect(r.route).toEqual({ providerId: "cheap", model: "haiku", apiKeyEnv: "K" });
    expect(r.chain).toHaveLength(1);
  });

  it("表项空 taskClasses 数组仍是 table", () => {
    const r = resolveTaskModelRoute({ kind: "digest", table: { digest: { model: "m", taskClasses: [] } } });
    expect(r.ok && r.source).toBe("table");
  });
});

describe("resolveTaskModelRoute:taskClasses 门(C)", () => {
  const table = {
    review: { model: "rev", taskClasses: ["security", "perf"], fallbackChain: [{ model: "fb" }] },
  };

  it("taskClass 命中 → source task-class", () => {
    const r = resolveTaskModelRoute({ kind: "review", taskClass: "security", table });
    expect(r.ok && r.source).toBe("task-class");
    expect(r.ok && r.route.model).toBe("rev");
    expect(r.ok && r.chain.map((c) => c.model)).toEqual(["rev", "fb"]);
  });

  it("taskClass 不含当前 class → 回 base,且不用表项的 fallbackChain", () => {
    const r = resolveTaskModelRoute({ kind: "review", taskClass: "docs", base: { model: "base-m" }, table });
    expect(r.ok && r.source).toBe("base");
    expect(r.ok && r.route.model).toBe("base-m");
    expect(r.ok && r.chain.map((c) => c.model)).toEqual(["base-m"]);
  });

  it("缺 taskClass 也算不命中 → 回 base", () => {
    const r = resolveTaskModelRoute({ kind: "review", table });
    expect(r).toEqual({ ok: false, code: "INVALID" });
  });

  it("taskClass 非字符串(数字)不命中", () => {
    const r = resolveTaskModelRoute({ kind: "review", taskClass: 7 as unknown as string, base: { model: "b" }, table });
    expect(r.ok && r.source).toBe("base");
  });
});

describe("resolveTaskModelRoute:fallbackChain 顺序与 freeOnly(D/E)", () => {
  it("无过滤时按 [entry, ...fallback] 顺序", () => {
    const r = resolveTaskModelRoute({
      kind: "main",
      table: { main: { model: "a", fallbackChain: [{ model: "b" }, { model: "c" }] } },
    });
    expect(r.ok && r.chain.map((c) => c.model)).toEqual(["a", "b", "c"]);
    expect(r.ok && r.source).toBe("table");
  });

  it("entry 被 freeOnly 过滤后取 fallbackChain[0] 且 source fallback", () => {
    const r = resolveTaskModelRoute({
      kind: "summary",
      freeProviders: ["free1"],
      table: { summary: { providerId: "paid", freeOnly: true, fallbackChain: [{ providerId: "free1" }, { providerId: "free2" }] } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("fallback");
    expect(r.route.providerId).toBe("free1");
    expect(r.chain.map((c) => c.providerId)).toEqual(["free1", "free2"]);
  });

  it("freeOnly 且 providerId 在 freeProviders → 保留为 table", () => {
    const r = resolveTaskModelRoute({
      kind: "memory",
      freeProviders: new Set(["free1"]),
      table: { memory: { providerId: "free1", freeOnly: true, model: "fm" } },
    });
    expect(r.ok && r.source).toBe("table");
    expect(r.ok && r.route.model).toBe("fm");
  });

  it("缺 freeProviders 时 freeOnly 项被滤(freeProviders 空集)", () => {
    const r = resolveTaskModelRoute({ kind: "memory", table: { memory: { providerId: "free1", freeOnly: true } } });
    expect(r).toEqual({ ok: false, code: "INVALID" });
  });

  it("freeOnly 无 providerId 被滤", () => {
    const r = resolveTaskModelRoute({ kind: "memory", freeProviders: ["free1"], table: { memory: { model: "m", freeOnly: true } } });
    expect(r).toEqual({ ok: false, code: "INVALID" });
  });

  it("全被滤且无 base → INVALID", () => {
    const r = resolveTaskModelRoute({
      kind: "vision",
      table: { vision: { providerId: "paid", freeOnly: true, fallbackChain: [{ providerId: "paid2", freeOnly: true }] } },
    });
    expect(r).toEqual({ ok: false, code: "INVALID" });
  });

  it("全被滤但有 base → 落 base", () => {
    const r = resolveTaskModelRoute({
      kind: "vision",
      base: { model: "bm" },
      table: { vision: { providerId: "paid", freeOnly: true } },
    });
    expect(r.ok && r.source).toBe("base");
    expect(r.ok && r.route.model).toBe("bm");
  });

  it("base 自己 freeOnly 且不在免费集 → INVALID", () => {
    expect(resolveTaskModelRoute({ kind: "main", base: { providerId: "paid", freeOnly: true } })).toEqual({ ok: false, code: "INVALID" });
    const ok = resolveTaskModelRoute({ kind: "main", base: { providerId: "f" , freeOnly: true}, freeProviders: ["f"] });
    expect(ok.ok && ok.source).toBe("base");
  });

  it("fallbackChain 内非对象项被丢弃,无 model/provider 的空对象仍保留", () => {
    const r = resolveTaskModelRoute({
      kind: "main",
      table: { main: { model: "a", fallbackChain: [null as unknown as RouteRef, "x" as unknown as RouteRef, [] as unknown as RouteRef, {}] } },
    });
    expect(r.ok && r.chain).toHaveLength(2);
  });
});

describe("resolveTaskModelRoute:未知 kind 与非法表项(F)", () => {
  it("bogus kind → INVALID(即使 table 有该 key)", () => {
    expect(resolveTaskModelRoute({ kind: "bogus", table: { bogus: { model: "m" } }, base: { model: "b" } })).toEqual({ ok: false, code: "INVALID" });
  });

  it("表项是数组/字符串 → INVALID", () => {
    for (const bad of [["m"], "str", 5, true]) {
      expect(resolveTaskModelRoute({ kind: "main", table: { main: bad as unknown as RouteRef }, base: { model: "b" } })).toEqual({
        ok: false,
        code: "INVALID",
      });
    }
  });

  it("table 本身非对象 → 视作无表走 base", () => {
    const r = resolveTaskModelRoute({ kind: "main", base: { model: "b" }, table: "nope" as unknown as Record<string, RouteRef> });
    expect(r.ok && r.source).toBe("base");
  });
});

describe("resolveTaskModelRoute:确定性与不可变(G)", () => {
  const input = {
    kind: "compact",
    taskClass: "fast",
    base: { providerId: "base-p", model: "base-m" },
    table: {
      compact: { model: "small", taskClasses: ["fast"], fallbackChain: [{ model: "small2" }, { model: "small" }] },
    },
    freeProviders: ["base-p"],
  };

  it("同输入两次调用结果深相等", () => {
    expect(resolveTaskModelRoute(input)).toEqual(resolveTaskModelRoute(input));
  });

  it("deepFreeze 输入后调用不抛且输入 JSON 不变", () => {
    const frozen = deepFreeze(structuredClone(input));
    const before = JSON.stringify(frozen);
    const r = resolveTaskModelRoute(frozen);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("chain 去重:fallback 重复 entry 只留一份(保序)", () => {
    const r = resolveTaskModelRoute({
      kind: "compact",
      table: { compact: { model: "same", fallbackChain: [{ model: "same" }, { model: "other" }, { model: "same" }] } },
    });
    expect(r.ok && r.chain.map((c) => c.model)).toEqual(["same", "other"]);
  });

  it("chain 元素是新对象(浅拷贝),改返回值不影响入参", () => {
    const table = { main: { model: "a" } };
    const r = resolveTaskModelRoute({ kind: "main", table });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).not.toBe(table.main);
    expect(r.route).not.toBe(r.chain[0]);
  });

  it("极端输入不抛异常(空对象/undefined 字段)", () => {
    expect(() => resolveTaskModelRoute({ kind: "main", freeProviders: 42 as unknown as string[] })).not.toThrow();
    expect(resolveTaskModelRoute({} as unknown as { kind: string })).toEqual({ ok: false, code: "INVALID" });
  });
});

describe("validateRoutingTable", () => {
  it("undefined / 空表 → ok,无 issue", () => {
    expect(validateRoutingTable(undefined)).toEqual({ ok: true, issues: [] });
    expect(validateRoutingTable({})).toEqual({ ok: true, issues: [] });
  });

  it("合法表 → ok", () => {
    const r = validateRoutingTable({ main: { providerId: "p", model: "m", fallbackChain: [{ model: "m2" }] } });
    expect(r).toEqual({ ok: true, issues: [] });
  });

  it("未知 kind → unknown-kind", () => {
    const r = validateRoutingTable({ bogus: { model: "m" } });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => [i.code, i.kind])).toEqual([["unknown-kind", "bogus"]]);
  });

  it("无 providerId 且无 model → missing-endpoint", () => {
    const r = validateRoutingTable({ compact: { baseUrl: "http://x" } });
    expect(r.issues.map((i) => i.code)).toEqual(["missing-endpoint"]);
    expect(r.issues[0].kind).toBe("compact");
  });

  it("freeOnly 无 providerId → free-only-without-provider(同时不再报 missing-endpoint)", () => {
    const r = validateRoutingTable({ memory: { model: "m", freeOnly: true } });
    expect(r.issues.map((i) => i.code)).toEqual(["free-only-without-provider"]);
  });

  it("fallback 重复表项 → duplicate-fallback", () => {
    const r = validateRoutingTable({ main: { model: "m", fallbackChain: [{ model: "m" }] } });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(["duplicate-fallback"]);
  });

  it("knownProviders 未知名 → unknown-provider(含 fallback 项)", () => {
    const r = validateRoutingTable(
      { main: { providerId: "ok", fallbackChain: [{ providerId: "ghost" }] } },
      { knownProviders: ["ok"] },
    );
    expect(r.issues.map((i) => i.code)).toEqual(["unknown-provider"]);
    expect(r.issues[0].detail).toContain("ghost");
  });

  it("非对象表(字符串/数组/null) → 一条 invalid-entry(kind 为空)", () => {
    for (const bad of ["x", [], null as unknown]) {
      const r = validateRoutingTable(bad);
      expect(r.ok).toBe(false);
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ code: "invalid-entry", kind: "" });
    }
  });

  it("表项非对象 → invalid-entry", () => {
    const r = validateRoutingTable({ vision: ["x"] });
    expect(r.issues.map((i) => i.code)).toEqual(["invalid-entry"]);
  });

  it("issue 顺序按表的 own key 顺序稳定", () => {
    const table = { main: { model: "m", fallbackChain: [{ model: "m" }] }, bogus: { model: "x" }, memory: { freeOnly: true } };
    const a = validateRoutingTable(table).issues.map((i) => `${i.kind}:${i.code}`);
    const b = validateRoutingTable(table).issues.map((i) => `${i.kind}:${i.code}`);
    expect(a).toEqual(b);
 // memory 项既无 providerId 也无 model,missing-endpoint 与 free-only 两条各自独立报出。
    expect(a).toEqual(["main:duplicate-fallback", "bogus:unknown-kind", "memory:missing-endpoint", "memory:free-only-without-provider"]);
  });
});
