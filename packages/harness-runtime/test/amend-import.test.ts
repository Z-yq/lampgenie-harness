/**
 * 进程替换后导入判定纯逻辑:前置闸门 / 前缀截断 / 命中与关门 / 种子校验 / 续跑模式。
 * 全纯函数直测,不触 IO;码表顺序按自动化断言口径固定。
 */
import { describe, expect, it } from "vitest";
import {
  AMEND_BOUNDARY_MISSING,
  AMEND_CACHE_BUILT,
  AMEND_CODES,
  AMEND_DOOR_CLOSED,
  AMEND_FALLBACK_LIVE,
  AMEND_HASH_DIVERGED,
  AMEND_HIT,
  AMEND_IMPORT_VERSION,
  AMEND_INVALID,
  AMEND_MISS,
  AMEND_PRECHECK_OK,
  AMEND_RUN_MISSING,
  AMEND_SEED_ALLOWED,
  AMEND_SKIP_SETTLEMENT,
  AMEND_STOPPED,
  AMEND_TARGET_DIRTY,
  buildImportCache,
  closeOnWorldWrite,
  emptyImportCache,
  matchImport,
  precheck,
  resumeRebuild,
  seedAllowed,
  stopPredecessor,
  type AmendCode,
  type AmendResult,
  type AskRecord,
  type RunState,
  type TargetSession,
} from "../src/agent/amend-import.ts";

function ask(partial: Partial<AskRecord> & { id: string; actor: string }): AskRecord {
  return { status: "completed", messageBoundary: `b-${partial.id}`, ...partial };
}

function run(partial: Partial<RunState> = {}): RunState {
  return { runId: "r1", exists: true, asks: [], worldQueue: [], ...partial };
}

function target(partial: Partial<TargetSession> = {}): TargetSession {
  return { id: "s1", seeds: ["seed-a", "seed-b"], history: [], ...partial };
}

/** 非法入参统一走这个口子(模拟反序列化拿到的垃圾值)。 */
function junk(value: unknown): never {
  return value as never;
}

describe("码表", () => {
  it("版本号固定为 1", () => {
    expect(AMEND_IMPORT_VERSION).toBe(1);
  });

  it("14 个稳定码固定顺序且值与名相同", () => {
    expect(AMEND_CODES).toEqual([
      "AMEND_INVALID",
      "AMEND_RUN_MISSING",
      "AMEND_BOUNDARY_MISSING",
      "AMEND_TARGET_DIRTY",
      "AMEND_PRECHECK_OK",
      "AMEND_STOPPED",
      "AMEND_SKIP_SETTLEMENT",
      "AMEND_CACHE_BUILT",
      "AMEND_HIT",
      "AMEND_MISS",
      "AMEND_HASH_DIVERGED",
      "AMEND_DOOR_CLOSED",
      "AMEND_SEED_ALLOWED",
      "AMEND_FALLBACK_LIVE",
    ]);
    expect(AMEND_CODES.length).toBe(14);
    expect(new Set(AMEND_CODES).size).toBe(14);
    expect(AMEND_INVALID).toBe("AMEND_INVALID");
    expect(AMEND_HIT).toBe("AMEND_HIT");
  });

  it("14 个稳定码全部可达", () => {
    const seen = new Set<AmendCode>();
    const collect = (result: AmendResult): void => {
      for (const code of result.codes) seen.add(code);
    };
    const built = buildImportCache(run({ asks: [ask({ id: "a1", actor: "x" })] }));

    collect(precheck(junk(undefined)));
    collect(precheck(run({ exists: false })));
    collect(precheck(run({ asks: [ask({ id: "a1", actor: "x", messageBoundary: "   " })] })));
    collect(precheck(run(), { targetSession: target({ history: ["foreign-1"] }) }));
    collect(precheck(run()));
    collect(
      stopPredecessor(run({ asks: [ask({ id: "a1", actor: "x", status: "running" })] }), {
        awaitSettlement: true,
      }),
    );
    collect(stopPredecessor(run()));
    collect(built);
    collect(matchImport(built.cache, { actor: "x", askId: "a1" }));
    collect(matchImport(built.cache, { actor: "x", askId: "nope" }));
    collect(matchImport(built.cache, { actor: "x", askId: "a1", payloadHash: "changed" }));
    collect(closeOnWorldWrite(built.cache, { worldToolCalls: 1 }));
    collect(seedAllowed(null));
    collect(resumeRebuild({ cacheOk: false }));

    expect([...seen].sort()).toEqual([...AMEND_CODES].sort());
  });
});

describe("precheck", () => {
  it("run 非对象 → INVALID", () => {
    expect(precheck(junk(null))).toEqual({ ok: false, codes: [AMEND_INVALID] });
    expect(precheck(junk("run"))).toEqual({ ok: false, codes: [AMEND_INVALID] });
    expect(precheck(junk([]))).toEqual({ ok: false, codes: [AMEND_INVALID] });
  });

  it("asks 非数组 → INVALID", () => {
    const result = precheck(junk({ runId: "r1", exists: true, asks: { a: 1 }, worldQueue: [] }));
    expect(result).toEqual({ ok: false, codes: [AMEND_INVALID] });
  });

  it("run 不存在 → RUN_MISSING", () => {
    const result = precheck(run({ exists: false, asks: [ask({ id: "a1", actor: "x" })] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_RUN_MISSING]);
  });

  it("RUN_MISSING 短路优先于边界缺失", () => {
    const result = precheck(
      run({ exists: false, asks: [ask({ id: "a1", actor: "x", messageBoundary: "  " })] }),
    );
    expect(result.codes).toEqual([AMEND_RUN_MISSING]);
  });

  it("completed 缺 messageBoundary → BOUNDARY_MISSING", () => {
    const result = precheck(run({ asks: [ask({ id: "a1", actor: "x", messageBoundary: undefined })] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_BOUNDARY_MISSING]);
    expect(result.detail).toEqual({ missing: ["a1"] });
  });

  it("completed 的 boundary 为空串/纯空白 → BOUNDARY_MISSING", () => {
    const result = precheck(
      run({
        asks: [
          ask({ id: "a1", actor: "x", messageBoundary: "" }),
          ask({ id: "a2", actor: "x", messageBoundary: "  \t " }),
        ],
      }),
    );
    expect(result.codes).toEqual([AMEND_BOUNDARY_MISSING]);
    expect(result.detail).toEqual({ missing: ["a1", "a2"] });
  });

  it("running/failed 没有 boundary 不算缺失", () => {
    const result = precheck(
      run({
        asks: [
          ask({ id: "a1", actor: "x", status: "running", messageBoundary: undefined }),
          ask({ id: "a2", actor: "y", status: "failed", messageBoundary: undefined }),
        ],
      }),
    );
    expect(result).toEqual({ ok: true, codes: [AMEND_PRECHECK_OK] });
  });

  it("无 targetSession → PRECHECK_OK", () => {
    expect(precheck(run({ asks: [ask({ id: "a1", actor: "x" })] }))).toEqual({
      ok: true,
      codes: [AMEND_PRECHECK_OK],
    });
  });

  it("targetSession.history 为空 → PRECHECK_OK", () => {
    const result = precheck(run({ asks: [ask({ id: "a1", actor: "x" })] }), {
      targetSession: target({ history: [] }),
    });
    expect(result).toEqual({ ok: true, codes: [AMEND_PRECHECK_OK] });
  });

  it("targetSession.history 全为种子 → PRECHECK_OK", () => {
    const result = precheck(run(), {
      targetSession: target({ history: ["seed-a", "s1:child", "s1", "seed-b"] }),
    });
    expect(result).toEqual({ ok: true, codes: [AMEND_PRECHECK_OK] });
  });

  it("targetSession.history 含外来 id → TARGET_DIRTY", () => {
    const result = precheck(run(), {
      targetSession: target({ history: ["seed-a", "other:1"] }),
    });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_TARGET_DIRTY]);
    expect(result.detail).toEqual({ foreign: ["other:1"] });
  });

  it("判断不改入参(纯函数)", () => {
    const state = run({
      asks: [ask({ id: "a1", actor: "x", toolCalls: 2 }), ask({ id: "a2", actor: "x", status: "running" })],
      worldQueue: [{ id: "w1", payloadHash: "h1" }],
    });
    const snapshot = JSON.parse(JSON.stringify(state));
    precheck(state);
    stopPredecessor(state, { awaitSettlement: true });
    buildImportCache(state);
    expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot);
  });
});

describe("stopPredecessor", () => {
  it("run 不存在 → RUN_MISSING,未停,无 pending", () => {
    const result = stopPredecessor(run({ exists: false }), { awaitSettlement: true });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_RUN_MISSING]);
    expect(result.stopped).toBe(false);
    expect(result.pending).toEqual([]);
  });

  it("awaitSettlement 缺省 → SKIP_SETTLEMENT(零副作用)", () => {
    const state = run({
      asks: [ask({ id: "a1", actor: "x", status: "running" })],
      worldQueue: [{ id: "w1", payloadHash: "h1" }],
    });
    const before = JSON.stringify(state);
    const result = stopPredecessor(state);
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_SKIP_SETTLEMENT]);
    expect(result.stopped).toBe(false);
    expect(result.pending).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("awaitSettlement=false 也只 SKIP(不算同意)", () => {
    const result = stopPredecessor(run({ asks: [ask({ id: "a1", actor: "x", status: "running" })] }), {
      awaitSettlement: false,
    });
    expect(result.codes).toEqual([AMEND_SKIP_SETTLEMENT]);
  });

  it("awaitSettlement=true → STOPPED,pending 按 asks 顺序", () => {
    const state = run({
      asks: [
        ask({ id: "a1", actor: "x", status: "completed" }),
        ask({ id: "a2", actor: "y", status: "running" }),
        ask({ id: "a3", actor: "x", status: "failed" }),
        ask({ id: "a4", actor: "x", status: "running" }),
      ],
    });
    const result = stopPredecessor(state, { awaitSettlement: true });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([AMEND_STOPPED]);
    expect(result.stopped).toBe(true);
    expect(result.pending).toEqual(["a2", "a4"]);
  });

  it("没有 running → STOPPED 且 pending 为空", () => {
    const result = stopPredecessor(run({ asks: [ask({ id: "a1", actor: "x" })] }), {
      awaitSettlement: true,
    });
    expect(result).toEqual({ ok: true, codes: [AMEND_STOPPED], stopped: true, pending: [] });
  });
});

describe("buildImportCache", () => {
  it("run 不存在 → RUN_MISSING + 空缓存", () => {
    const result = buildImportCache(run({ exists: false, asks: [ask({ id: "a1", actor: "x" })] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_RUN_MISSING]);
    expect(result.cache).toEqual(emptyImportCache());
  });

  it("非法 run → INVALID + 空缓存", () => {
    const result = buildImportCache(junk({ runId: "r1", exists: true, asks: 0 }));
    expect(result.codes).toEqual([AMEND_INVALID]);
    expect(result.cache).toEqual(emptyImportCache());
  });

  it("全 completed → 全部收入前缀", () => {
    const result = buildImportCache(
      run({
        asks: [
          ask({ id: "a1", actor: "x", toolCalls: 0 }),
          ask({ id: "a2", actor: "x", payloadHash: "h2" }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([AMEND_CACHE_BUILT]);
    expect(result.cache.closed).toBe(false);
    expect(result.cache.actorPrefix.x?.map((ask) => ask.id)).toEqual(["a1", "a2"]);
    expect(result.cache.actorPrefix.x?.[1]).toEqual({
      id: "a2",
      actor: "x",
      status: "completed",
      messageBoundary: "b-a2",
      payloadHash: "h2",
    });
  });

  it("遇 running 截断,其后同 actor 的 completed 也不收", () => {
    const result = buildImportCache(
      run({
        asks: [
          ask({ id: "a1", actor: "x" }),
          ask({ id: "a2", actor: "x", status: "running" }),
          ask({ id: "a3", actor: "x" }),
        ],
      }),
    );
    expect(result.cache.actorPrefix.x?.map((ask) => ask.id)).toEqual(["a1"]);
  });

  it("遇 failed 截断,其后同 actor 的 completed 也不收", () => {
    const result = buildImportCache(
      run({
        asks: [
          ask({ id: "a1", actor: "x", status: "failed" }),
          ask({ id: "a2", actor: "x" }),
        ],
      }),
    );
    expect(result.cache.actorPrefix.x).toBeUndefined();
  });

  it("两 actor 前缀互相独立", () => {
    const result = buildImportCache(
      run({
        asks: [
          ask({ id: "a1", actor: "x" }),
          ask({ id: "b1", actor: "y" }),
          ask({ id: "a2", actor: "x", status: "running" }),
          ask({ id: "b2", actor: "y" }),
          ask({ id: "a3", actor: "x" }),
        ],
      }),
    );
    expect(result.cache.actorPrefix.x?.map((ask) => ask.id)).toEqual(["a1"]);
    expect(result.cache.actorPrefix.y?.map((ask) => ask.id)).toEqual(["b1", "b2"]);
  });

  it("worldQueue 深拷贝,不与现场共享引用", () => {
    const state = run({ worldQueue: [{ id: "w1", payloadHash: "h1" }] });
    const { cache } = buildImportCache(state);
    expect(cache.worldQueue).toEqual([{ id: "w1", payloadHash: "h1" }]);
    expect(cache.worldQueue).not.toBe(state.worldQueue);
    expect(cache.worldQueue[0]).not.toBe(state.worldQueue[0]);
    cache.worldQueue[0]!.id = "mutated";
    expect(state.worldQueue[0]!.id).toBe("w1");
  });

  it("asks 为空也返回 CACHE_BUILT", () => {
    const result = buildImportCache(run());
    expect(result.codes).toEqual([AMEND_CACHE_BUILT]);
    expect(result.cache.actorPrefix).toEqual({});
    expect(result.cache.worldQueue).toEqual([]);
  });
});

describe("matchImport", () => {
  function cacheOf(asks: AskRecord[], closed = false) {
    const { cache } = buildImportCache(run({ asks }));
    cache.closed = closed;
    return cache;
  }

  it("命中 → HIT,node 为 imported 节点", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", messageBoundary: "b-1", payloadHash: "h1" })]);
    const result = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h1" });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([AMEND_HIT]);
    expect(result.hit).toBe(true);
    expect(result.node).toEqual({
      id: "a1",
      kind: "imported",
      actor: "x",
      messageBoundary: "b-1",
      payloadHash: "h1",
      toolCalls: 0,
    });
  });

  it("命中保留 toolCalls 原值", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", toolCalls: 3 })]);
    const result = matchImport(cache, { actor: "x", askId: "a1" });
    expect(result.hit).toBe(true);
    expect(result.node?.toolCalls).toBe(3);
  });

  it("payloadHash 双 undefined 视为相等 → HIT", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: undefined })]);
    const result = matchImport(cache, { actor: "x", askId: "a1" });
    expect(result.codes).toEqual([AMEND_HIT]);
    expect(result.hit).toBe(true);
  });

  it("actor 内无该 askId → MISS", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x" })]);
    const result = matchImport(cache, { actor: "x", askId: "a9" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_MISS]);
    expect(result.hit).toBe(false);
    expect(result.node).toBeUndefined();
  });

  it("actor 不存在 → MISS", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x" })]);
    const result = matchImport(cache, { actor: "ghost", askId: "a1" });
    expect(result.codes).toEqual([AMEND_MISS]);
  });

  it("被截断的条目查不到 → MISS", () => {
    const cache = cacheOf([
      ask({ id: "a1", actor: "x" }),
      ask({ id: "a2", actor: "x", status: "running" }),
      ask({ id: "a3", actor: "x" }),
    ]);
    expect(matchImport(cache, { actor: "x", askId: "a3" }).codes).toEqual([AMEND_MISS]);
  });

  it("hash 不一致 → HASH_DIVERGED", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1" })]);
    const result = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h2" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_HASH_DIVERGED]);
    expect(result.hit).toBe(false);
  });

  it("条目有 hash 而调用未给 → HASH_DIVERGED(单向)", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1" })]);
    expect(matchImport(cache, { actor: "x", askId: "a1" }).codes).toEqual([AMEND_HASH_DIVERGED]);
  });

  it("HASH_DIVERGED 单调不回退(重复调用仍 DIVERGED)", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1" })]);
    const before = JSON.stringify(cache);
    const first = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h2" });
    const second = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h2" });
    const third = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h1" });
    expect(first.codes).toEqual([AMEND_HASH_DIVERGED]);
    expect(second.codes).toEqual([AMEND_HASH_DIVERGED]);
    expect(third.codes).toEqual([AMEND_HIT]);
    expect(JSON.stringify(cache)).toBe(before);
  });

  it("门关后有副作用条目即使 hash 相同也拒(DOOR_CLOSED)", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1", toolCalls: 2 })], true);
    const result = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h1" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_DOOR_CLOSED]);
    expect(result.hit).toBe(false);
  });

  it("门关后 toolCalls 0 的条目仍可命中", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1", toolCalls: 0 })], true);
    const result = matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h1" });
    expect(result.codes).toEqual([AMEND_HIT]);
    expect(result.hit).toBe(true);
  });

  it("门关判定优先于 hash 判定", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x", payloadHash: "h1", toolCalls: 1 })], true);
    expect(matchImport(cache, { actor: "x", askId: "a1", payloadHash: "h9" }).codes).toEqual([
      AMEND_DOOR_CLOSED,
    ]);
  });

  it("cache 非法 → INVALID 且不命中", () => {
    const result = matchImport(junk({ actorPrefix: null, worldQueue: [], closed: false }), {
      actor: "x",
      askId: "a1",
    });
    expect(result).toEqual({ ok: false, codes: [AMEND_INVALID], hit: false });
  });

  it("opts 非法 → INVALID 且不命中", () => {
    const cache = cacheOf([ask({ id: "a1", actor: "x" })]);
    expect(matchImport(cache, junk({ actor: 1, askId: "a1" })).codes).toEqual([AMEND_INVALID]);
    expect(matchImport(cache, junk(undefined)).codes).toEqual([AMEND_INVALID]);
  });
});

describe("closeOnWorldWrite", () => {
  it("worldToolCalls>0 → 就地关门", () => {
    const cache = emptyImportCache();
    const result = closeOnWorldWrite(cache, { worldToolCalls: 1 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([AMEND_DOOR_CLOSED]);
    expect(result.closed).toBe(true);
    expect(cache.closed).toBe(true);
  });

  it("worldToolCalls===0 → 不改状态,空码表", () => {
    const cache = emptyImportCache();
    const result = closeOnWorldWrite(cache, { worldToolCalls: 0 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([]);
    expect(result.closed).toBe(false);
    expect(cache.closed).toBe(false);
  });

  it("关门幂等:重复调用仍 DOOR_CLOSED/closed=true", () => {
    const cache = emptyImportCache();
    closeOnWorldWrite(cache, { worldToolCalls: 2 });
    const again = closeOnWorldWrite(cache, { worldToolCalls: 3 });
    expect(again.codes).toEqual([AMEND_DOOR_CLOSED]);
    expect(again.closed).toBe(true);
    expect(cache.closed).toBe(true);
  });

  it("非有限数 → INVALID,保留原 closed", () => {
    const open = emptyImportCache();
    expect(closeOnWorldWrite(open, { worldToolCalls: Number.NaN })).toEqual({
      ok: false,
      codes: [AMEND_INVALID],
      closed: false,
    });
    expect(closeOnWorldWrite(open, { worldToolCalls: Number.POSITIVE_INFINITY }).closed).toBe(false);
    expect(open.closed).toBe(false);

    const closed = { ...emptyImportCache(), closed: true };
    expect(closeOnWorldWrite(closed, { worldToolCalls: Number.NaN })).toEqual({
      ok: false,
      codes: [AMEND_INVALID],
      closed: true,
    });
    expect(closed.closed).toBe(true);
  });

  it("cache 非法 → INVALID 不 throw", () => {
    expect(closeOnWorldWrite(junk(null), { worldToolCalls: 1 })).toEqual({
      ok: false,
      codes: [AMEND_INVALID],
      closed: false,
    });
  });
});

describe("seedAllowed", () => {
  it("target 缺失 → allowed", () => {
    expect(seedAllowed(undefined)).toEqual({ ok: true, codes: [AMEND_SEED_ALLOWED], allowed: true });
    expect(seedAllowed(null)).toEqual({ ok: true, codes: [AMEND_SEED_ALLOWED], allowed: true });
  });

  it("history 为空 → allowed", () => {
    expect(seedAllowed(target({ history: [] }))).toEqual({
      ok: true,
      codes: [AMEND_SEED_ALLOWED],
      allowed: true,
    });
  });

  it("history 全为种子(seeds / target.id / `${id}:` 前缀)→ allowed", () => {
    const result = seedAllowed(target({ id: "s1", seeds: ["seed-a"], history: ["seed-a", "s1", "s1:kid"] }));
    expect(result.allowed).toBe(true);
    expect(result.codes).toEqual([AMEND_SEED_ALLOWED]);
  });

  it("history 含外来 id → TARGET_DIRTY 且不允许", () => {
    const result = seedAllowed(target({ history: ["seed-a", "foreign-1"] }));
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([AMEND_TARGET_DIRTY]);
    expect(result.allowed).toBe(false);
    expect(result.detail).toEqual({ foreign: ["foreign-1"] });
  });

  it("target.id 为空串时前缀规则不生效", () => {
    const result = seedAllowed(target({ id: "", seeds: [], history: [":kid"] }));
    expect(result.allowed).toBe(false);
    expect(result.codes).toEqual([AMEND_TARGET_DIRTY]);
  });

  it("target 非法 → INVALID 不 throw", () => {
    expect(seedAllowed(junk("s1")).codes).toEqual([AMEND_INVALID]);
    expect(seedAllowed(junk("s1")).allowed).toBe(false);
  });
});

describe("resumeRebuild", () => {
  it("cacheOk → cache 模式", () => {
    expect(resumeRebuild({ cacheOk: true })).toEqual({
      ok: true,
      codes: [AMEND_CACHE_BUILT],
      mode: "cache",
    });
  });

  it("cache 不可用 → live 回退", () => {
    expect(resumeRebuild({ cacheOk: false })).toEqual({
      ok: false,
      codes: [AMEND_FALLBACK_LIVE],
      mode: "live",
    });
  });

  it("非法入参 → INVALID 且回退 live", () => {
    expect(resumeRebuild(junk(undefined))).toEqual({
      ok: false,
      codes: [AMEND_INVALID],
      mode: "live",
    });
  });
});

describe("端到端组合", () => {
  it("预检 → 停前驱 → 建缓存 → 命中 → 关门 → 拒副作用条目", () => {
    const state = run({
      asks: [
        ask({ id: "a1", actor: "x", payloadHash: "h1", toolCalls: 0 }),
        ask({ id: "a2", actor: "x", status: "running" }),
      ],
      worldQueue: [{ id: "w1", payloadHash: "wh1" }],
    });
    expect(precheck(state).codes).toEqual([AMEND_PRECHECK_OK]);

    const stopped = stopPredecessor(state, { awaitSettlement: true });
    expect(stopped.pending).toEqual(["a2"]);

    const built = buildImportCache(state);
    expect(built.codes).toEqual([AMEND_CACHE_BUILT]);

    const hit = matchImport(built.cache, { actor: "x", askId: "a1", payloadHash: "h1" });
    expect(hit.hit).toBe(true);
    expect(hit.node?.payloadHash).toBe("h1");

    expect(matchImport(built.cache, { actor: "x", askId: "a2" }).codes).toEqual([AMEND_MISS]);
    expect(closeOnWorldWrite(built.cache, { worldToolCalls: 1 }).closed).toBe(true);
  });
});
