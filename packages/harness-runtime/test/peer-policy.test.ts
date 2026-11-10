/**
 * #179 Peer 级访问快照(纯逻辑面)直测。
 *
 * 关注点不是「函数返回了什么形状」,而是几条硬边界:
 *   owner 恒 allow / 失败一律 fail-closed(POLICY_FAILED ≠ DENY_POLICY)/ 未知条件名不放行 /
 *   一项坏不影响批量其它项 / 快照的四种演进(applyFollow·invalidate·reload·mergeReconnect)语义。
 */
import { describe, expect, it } from "vitest";
import {
  PEER_CODES,
  PEER_POLICY_VERSION,
  PEER_CONDITIONS,
  applyFollow,
  decide,
  eventAllows,
  invalidate,
  listAllows,
  mergeReconnect,
  reloadSnapshot,
  resolvePeerPolicies,
  snapshotAllows,
  snapshotFor,
} from "../src/agent/peer-policy";
import type { PeerPolicySpec, PeerSnapshot, PolicySet, Principal } from "../src/agent/peer-policy";

const viewer: Principal = { id: "v1", kind: "viewer" };
const owner: Principal = { id: "o1", kind: "owner" };

function setOf(specs: PeerPolicySpec[], methods: string[] = ["msg.send"]): PolicySet {
  return { policies: resolvePeerPolicies(specs), methods };
}

describe("版本与码表", () => {
  it("PEER_POLICY_VERSION 为 1", () => {
    expect(PEER_POLICY_VERSION).toBe(1);
  });

  it("PEER_CODES 恰好 10 个且唯一", () => {
    expect(PEER_CODES.length).toBe(10);
    expect(new Set(PEER_CODES).size).toBe(10);
  });

  it("PEER_CODES 覆盖判定与快照两类稳定码", () => {
    expect(PEER_CODES).toContain("PEER_ALLOW");
    expect(PEER_CODES).toContain("PEER_POLICY_FAILED");
    expect(PEER_CODES).toContain("PEER_EVENT_DENIED");
    expect(PEER_CODES).toContain("PEER_RELOADED");
  });

  it("PEER_CONDITIONS 至少有 always/never/throw/method-in/arg-eq/args-truthy", () => {
    for (const name of ["always", "never", "throw", "method-in", "arg-eq", "args-truthy"]) {
      expect(typeof PEER_CONDITIONS[name]).toBe("function");
    }
  });
});

describe("decide:owner 与 kind 筛选", () => {
  it("owner 在空 policySet 下也 allow", () => {
    expect(decide({ policies: [], methods: [] }, { principal: owner, method: "msg.send" })).toMatchObject({
      principalId: "o1",
      method: "msg.send",
      allow: true,
      code: "PEER_ALLOW",
    });
  });

  it("owner 即使命中 never 策略也 allow(owner 先行短路)", () => {
    const set = setOf([{ kind: "owner", condition: "never" }]);
    expect(decide(set, { principal: owner, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("undefined policySet 下 viewer 为 DENY_NO_POLICY", () => {
    expect(decide(undefined, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_NO_POLICY");
  });

  it("member 命中自己的策略 → allow", () => {
    const set = setOf([{ kind: "member" }]);
    expect(decide(set, { principal: { id: "m1", kind: "member" }, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("viewer 命中自己的策略 → allow", () => {
    const set = setOf([{ kind: "viewer" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).allow).toBe(true);
  });

  it("relay 命中自己的策略 → allow", () => {
    const set = setOf([{ kind: "relay" }]);
    expect(decide(set, { principal: { id: "r1", kind: "relay" }, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("group 命中自己的策略 → allow", () => {
    const set = setOf([{ kind: "group" }]);
    expect(decide(set, { principal: { id: "g1", kind: "group" }, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("kind 不匹配 → DENY_NO_POLICY", () => {
    const set = setOf([{ kind: "member" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_NO_POLICY");
  });
});

describe("decide:role / binding", () => {
  it("role 相等才成为候选", () => {
    const set = setOf([{ kind: "member", role: "admin" }]);
    expect(decide(set, { principal: { id: "m1", kind: "member" }, method: "msg.send", role: "admin" }).allow).toBe(true);
  });

  it("role 不等 → DENY_NO_POLICY", () => {
    const set = setOf([{ kind: "member", role: "admin" }]);
    expect(decide(set, { principal: { id: "m1", kind: "member" }, method: "msg.send", role: "guest" }).code).toBe(
      "PEER_DENY_NO_POLICY",
    );
  });

  it("binding 字符串与 principal.id 相等才适用", () => {
    const set = setOf([{ kind: "viewer", binding: "v1" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).allow).toBe(true);
  });

  it("binding 字符串不等 → 该候选跳过 → DENY_NO_POLICY", () => {
    const set = setOf([{ kind: "viewer", binding: "v2" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_NO_POLICY");
  });

  it("binding 函数抛错 → POLICY_FAILED", () => {
    const set = setOf([
      {
        kind: "viewer",
        binding: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_POLICY_FAILED");
  });

  it("binding 函数返回 falsy 视为不适用 → DENY_NO_POLICY", () => {
    const set = setOf([{ kind: "viewer", binding: () => false }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_NO_POLICY");
  });

  it("binding 函数返回 truthy 且无 condition → allow", () => {
    const set = setOf([{ kind: "viewer", binding: (ctx) => ctx.principal.id === "v1" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).allow).toBe(true);
  });
});

describe("decide:condition 语义", () => {
  it("condition 返回 false → DENY_POLICY(不是 DENY_NO_POLICY)", () => {
    const set = setOf([{ kind: "viewer", condition: "never" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_POLICY");
  });

  it("condition 抛错 → POLICY_FAILED 且 decide 本身不 throw", () => {
    const set = setOf([{ kind: "viewer", condition: "throw" }]);
    let res: ReturnType<typeof decide> | undefined;
    expect(() => {
      res = decide(set, { principal: viewer, method: "msg.send" });
    }).not.toThrow();
    expect(res?.code).toBe("PEER_POLICY_FAILED");
    expect(res?.allow).toBe(false);
  });

  it("无 condition 的适用候选 → allow", () => {
    const set = setOf([{ kind: "viewer" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("首候选 allow 即返回,后续候选(抛错)不再执行", () => {
    let reached = false;
    const set = setOf([
      { kind: "viewer", condition: "always" },
      {
        kind: "viewer",
        condition: () => {
          reached = true;
          throw new Error("should not run");
        },
      },
    ]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_ALLOW");
    expect(reached).toBe(false);
  });

  it("两候选一真一假:结果由顺序决定(先 deny 先回)", () => {
    const denyFirst = setOf([
      { kind: "viewer", condition: "never" },
      { kind: "viewer", condition: "always" },
    ]);
    const allowFirst = setOf([
      { kind: "viewer", condition: "always" },
      { kind: "viewer", condition: "never" },
    ]);
    expect(decide(denyFirst, { principal: viewer, method: "msg.send" }).code).toBe("PEER_DENY_POLICY");
    expect(decide(allowFirst, { principal: viewer, method: "msg.send" }).code).toBe("PEER_ALLOW");
  });

  it("method-in 条件:在列表内 allow / 不在则 DENY_POLICY", () => {
    const set = setOf([{ kind: "viewer", condition: "method-in:msg.send,msg.edit" }]);
    expect(decide(set, { principal: viewer, method: "msg.edit" }).allow).toBe(true);
    expect(decide(set, { principal: viewer, method: "msg.delete" }).code).toBe("PEER_DENY_POLICY");
  });

  it("arg-eq 条件:按 String(args[key]) 比较", () => {
    const set = setOf([{ kind: "viewer", condition: "arg-eq:channel=public" }]);
    expect(decide(set, { principal: viewer, method: "msg.send", args: { channel: "public" } }).allow).toBe(true);
    expect(decide(set, { principal: viewer, method: "msg.send", args: { channel: "private" } }).code).toBe(
      "PEER_DENY_POLICY",
    );
  });

  it("args-truthy 条件:args[key] 为 truthy 才放行", () => {
    const set = setOf([{ kind: "viewer", condition: "args-truthy:safe" }]);
    expect(decide(set, { principal: viewer, method: "msg.send", args: { safe: 1 } }).allow).toBe(true);
    expect(decide(set, { principal: viewer, method: "msg.send", args: { safe: 0 } }).code).toBe("PEER_DENY_POLICY");
  });

  it("args 原样透传(同一引用)且 decide 不修改入参", () => {
    const args = { channel: "public", nested: { n: 1 } };
    let seen: unknown;
    const set = setOf([
      {
        kind: "viewer",
        condition: (ctx) => {
          seen = ctx.args;
          return true;
        },
      },
    ]);
    const input = { principal: viewer, method: "msg.send", args };
    decide(set, input);
    expect(seen).toBe(args);
    expect(input.args).toBe(args);
    expect(args).toEqual({ channel: "public", nested: { n: 1 } });
  });

  it("args 为 null / undefined 时不崩", () => {
    const set = setOf([{ kind: "viewer", condition: "arg-eq:k=v" }]);
    expect(() => decide(set, { principal: viewer, method: "msg.send", args: null })).not.toThrow();
    expect(() => decide(set, { principal: viewer, method: "msg.send", args: undefined })).not.toThrow();
    expect(decide(set, { principal: viewer, method: "msg.send", args: null }).code).toBe("PEER_DENY_POLICY");
  });

  it("未知 condition 名编译成 fail-closed(执行即抛错 → POLICY_FAILED)", () => {
    const set = setOf([{ kind: "viewer", condition: "no-such-condition:zzz" }]);
    expect(decide(set, { principal: viewer, method: "msg.send" }).code).toBe("PEER_POLICY_FAILED");
  });

  it("判定确定性:同输入两次结果完全一致", () => {
    const set = setOf([{ kind: "viewer", condition: "method-in:msg.send" }], ["msg.send", "msg.edit"]);
    const a = decide(set, { principal: viewer, method: "msg.send" });
    const b = decide(set, { principal: viewer, method: "msg.send" });
    expect(a).toEqual(b);
  });
});

describe("resolvePeerPolicies", () => {
  it("函数 condition 原样保留", () => {
    const fn = () => true;
    const [policy] = resolvePeerPolicies([{ kind: "viewer", condition: fn }]);
    expect(policy?.condition).toBe(fn);
  });

  it("跳过非法 kind / 非对象项", () => {
    const raw = [{ kind: "nobody" }, { kind: "viewer" }, null] as unknown as PeerPolicySpec[];
    expect(resolvePeerPolicies(raw).length).toBe(1);
  });
});

describe("listAllows / eventAllows", () => {
  const items = [{ method: "msg.send" }, { method: "msg.send" }, { method: "msg.edit" }];

  it("三项两 allow 一 deny,计数与 entries 对齐", () => {
    const set = setOf([{ kind: "viewer", condition: "method-in:msg.send" }]);
    const res = listAllows(set, {
      principal: viewer,
      items,
      methodOf: (item) => item.method,
    });
    expect(res.entries.map((e) => e.allow)).toEqual([true, true, false]);
    expect(res.allowed).toBe(2);
    expect(res.denied).toBe(1);
    expect(res.entries[2]).toMatchObject({ index: 2, method: "msg.edit", code: "PEER_DENY_POLICY", item: items[2] });
    expect(res.event).toEqual({ allow: false, code: "PEER_EVENT_DENIED" });
  });

  it("一项 POLICY_FAILED 不影响其它项计数", () => {
    const set = setOf([{ kind: "viewer", condition: "throw" }]);
    const res = listAllows(set, {
      principal: viewer,
      items: [{ method: "a" }, { method: "b" }],
      methodOf: (item) => item.method,
    });
    expect(res.entries.map((e) => e.code)).toEqual(["PEER_POLICY_FAILED", "PEER_POLICY_FAILED"]);
    expect(res.allowed).toBe(0);
    expect(res.denied).toBe(2);
  });

  it("eventAllows 全部 allow → PEER_EVENT_ALLOWED", () => {
    const set = setOf([{ kind: "viewer", condition: "method-in:msg.send" }]);
    const res = eventAllows(set, { principal: viewer, items, methodOf: () => "msg.send" });
    expect(res.event).toEqual({ allow: true, code: "PEER_EVENT_ALLOWED" });
    expect(res.allowed).toBe(3);
    expect(res.entries.length).toBe(3);
  });

  it("eventAllows 一项 deny → PEER_EVENT_DENIED", () => {
    const set = setOf([{ kind: "viewer", condition: "method-in:msg.send" }]);
    const res = eventAllows(set, { principal: viewer, items, methodOf: (item) => item.method });
    expect(res.event).toEqual({ allow: false, code: "PEER_EVENT_DENIED" });
    expect(res.denied).toBe(1);
  });

  it("空 items → 事件放行(allowed=denied=0)", () => {
    const res = listAllows(setOf([]), { principal: viewer, items: [], methodOf: () => "" });
    expect(res.event).toEqual({ allow: true, code: "PEER_EVENT_ALLOWED" });
    expect(res.entries).toEqual([]);
  });
});

describe("快照生命周期", () => {
  const set = setOf([{ kind: "viewer", condition: "method-in:msg.send" }], ["msg.send", "msg.edit"]);

  it("snapshotFor 覆盖 policySet.methods 全量", () => {
    const { snapshot, code } = snapshotFor(set, viewer, "2026-01-01T00:00:00.000Z");
    expect(code).toBe("PEER_SNAPSHOT");
    expect(snapshot.principalId).toBe("v1");
    expect(snapshot.baseline).toEqual({ "msg.send": true, "msg.edit": false });
    expect(snapshot.follow).toEqual([]);
  });

  it("POLICY_FAILED 的 method 不在 baseline 里(既不是 true 也不是 false)", () => {
    const bad = setOf([{ kind: "viewer", condition: "throw" }], ["msg.send"]);
    const { snapshot } = snapshotFor(bad, viewer);
    expect("msg.send" in snapshot.baseline).toBe(false);
    expect(snapshotAllows(snapshot, "msg.send")).toBe(false);
  });

  it("applyFollow 追加 follow 并同步 baseline,且不改原快照", () => {
    const { snapshot } = snapshotFor(set, viewer);
    const frozen = JSON.stringify(snapshot);
    const { snapshot: next, code } = applyFollow(snapshot, { method: "msg.edit", allow: true, at: "T1" });
    expect(code).toBe("PEER_FOLLOW_APPLIED");
    expect(next.baseline["msg.edit"]).toBe(true);
    expect(next.follow).toEqual([{ at: "T1", method: "msg.edit", allow: true }]);
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });

  it("invalidate 按当前 policySet 重算并清空 follow", () => {
    const { snapshot } = snapshotFor(set, viewer);
    const withFollow = applyFollow(snapshot, { method: "msg.edit", allow: true, at: "T1" }).snapshot;
    const changed = setOf([{ kind: "viewer", condition: "never" }], ["msg.send", "msg.edit"]);
    const { snapshot: next, code } = invalidate(withFollow, changed, "T2");
    expect(code).toBe("PEER_INVALIDATED");
    expect(next.follow).toEqual([]);
    expect(next.baseline).toEqual({ "msg.send": false, "msg.edit": false });
  });

  it("reloadSnapshot 全新 baseline、旧 follow 清空", () => {
    const { snapshot } = snapshotFor(set, viewer);
    const withFollow = applyFollow(snapshot, { method: "msg.edit", allow: true, at: "T1" }).snapshot;
    const { snapshot: next, code } = reloadSnapshot(set, viewer);
    expect(code).toBe("PEER_RELOADED");
    expect(next.follow).toEqual([]);
    expect(next.baseline).toEqual({ "msg.send": true, "msg.edit": false });
    expect(withFollow.follow.length).toBe(1);
  });

  it("mergeReconnect 保留 follow 且返回副本", () => {
    const base: PeerSnapshot = { principalId: "v1", baseline: { "msg.send": true }, follow: [] };
    const withFollow = applyFollow(base, { method: "msg.edit", allow: true, at: "T1" }).snapshot;
    const { snapshot: next, code } = mergeReconnect(withFollow);
    expect(code).toBe("PEER_SNAPSHOT");
    expect(next.follow).toEqual(withFollow.follow);
    expect(next).not.toBe(withFollow);
    next.baseline["msg.send"] = false;
    expect(withFollow.baseline["msg.send"]).toBe(true);
  });

  it("snapshotAllows 只认明确的 true", () => {
    const snapshot: PeerSnapshot = { principalId: "v1", baseline: { a: true, b: false }, follow: [] };
    expect(snapshotAllows(snapshot, "a")).toBe(true);
    expect(snapshotAllows(snapshot, "b")).toBe(false);
    expect(snapshotAllows(snapshot, "missing")).toBe(false);
  });
});
