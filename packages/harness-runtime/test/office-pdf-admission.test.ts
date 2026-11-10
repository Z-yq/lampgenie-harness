/**
 * Office→PDF 共享准入层(#182 纯逻辑):键推导 / 准入四分叉 / 上限与排队 / 产物校验 / 撤销 / LRU / 关停。
 * 全部直测纯函数:不碰文件系统、不读时钟(now 由用例给)。
 */
import { describe, expect, it } from "vitest";
import {
  admit,
  aliasKey,
  cacheKeyString,
  cancelReader,
  complete,
  contentKey,
  defaultLimits,
  digestOf,
  dispose,
  emptyAdmissionState,
  evictLru,
  OFFICEPDF_CANCELLED,
  OFFICEPDF_CODES,
  OFFICEPDF_DISPOSED,
  OFFICEPDF_EVICTED,
  OFFICEPDF_INVALID,
  OFFICEPDF_INVALID_OUTPUT,
  OFFICEPDF_JOINED,
  OFFICEPDF_QUEUED,
  OFFICEPDF_READY,
  OFFICEPDF_REJECTED,
  OFFICEPDF_REUSED,
  OFFICEPDF_SOURCE_CHANGED,
  OFFICEPDF_STARTED,
  OFFICEPDF_VERSION,
  parseCacheKey,
  sanitizeAdmissionState,
  summarizeAdmission,
  type AdmissionLimits,
  type AdmissionState,
  type ConvertRequest,
  type OutputFacts,
} from "../src/agent/office-pdf-admission.ts";

const T0 = 1_700_000_000_000;

function req(over: Partial<ConvertRequest> = {}): ConvertRequest {
  return {
    id: "r1",
    extension: "docx",
    converterGeneration: "lo-1",
    priority: "foreground",
    sourceVersion: "100:1",
    now: T0,
    bytes: "hello world",
    ...over,
  };
}

function goodOutput(over: Partial<OutputFacts> = {}): OutputFacts {
  return { isRegular: true, noFollow: true, size: 2048, head: "%PDF-1.4\n", lastBytes: "trailer\n%%EOF\n", ...over };
}

function limits(over: Partial<AdmissionLimits> = {}): AdmissionLimits {
  return { ...defaultLimits(), ...over };
}

/** 走一遍 admit+complete,得到一个 ready 缓存状态。 */
function readyState(bytes = "hello world", now = T0): { state: AdmissionState; key: string } {
  const started = admit(emptyAdmissionState(), req({ bytes, now }));
  const key = started.key ?? "";
  const done = complete(started.state, key, goodOutput(), { now, path: `/out/${key}.pdf` });
  return { state: done.state, key };
}

describe("键与门限(a)", () => {
  it("OFFICEPDF_VERSION 与码表顺序固定", () => {
    expect(OFFICEPDF_VERSION).toBe(1);
    expect(OFFICEPDF_CODES[0]).toBe(OFFICEPDF_INVALID);
    expect(OFFICEPDF_CODES).toContain(OFFICEPDF_SOURCE_CHANGED);
    expect(new Set(OFFICEPDF_CODES).size).toBe(OFFICEPDF_CODES.length);
  });

  it("digestOf 稳定且为 64 位 hex", () => {
    const a = digestOf("hello world");
    expect(a).toBe(digestOf("hello world"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf("hello world")).not.toBe(digestOf("hello worlds"));
  });

  it("digestOf 对 string 按 utf8 计(等价于同一批字节)", () => {
    expect(digestOf("é")).toBe(digestOf(new Uint8Array([0xc3, 0xa9])));
  });

  it("contentKey:扩展名归一为小写,generation 或 extension 变 → 不同 key", () => {
    const base = contentKey({ converterGeneration: "lo-1", extension: "DOCX", bytes: "abc" });
    expect(base.extension).toBe("docx");
    expect(cacheKeyString(base)).toBe(cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "abc" })));
    expect(cacheKeyString(contentKey({ converterGeneration: "lo-2", extension: "docx", bytes: "abc" }))).not.toBe(cacheKeyString(base));
    expect(cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "xlsx", bytes: "abc" }))).not.toBe(cacheKeyString(base));
    expect(base.sha256).toBe(digestOf("abc"));
  });

  it("contentKey 给 digest 时不再算字节", () => {
    expect(contentKey({ converterGeneration: "lo-1", extension: "docx", digest: "deadbeef" }).sha256).toBe("deadbeef");
  });

  it("cacheKeyString / parseCacheKey 往返一致", () => {
    const key = contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "abc" });
    expect(parseCacheKey(cacheKeyString(key))).toEqual(key);
    expect(parseCacheKey("bad-key")).toBeUndefined();
  });

  it("aliasKey 随源版本变化", () => {
    expect(aliasKey("10:1", "/a.docx")).toBe(aliasKey("10:1", "/a.docx"));
    expect(aliasKey("10:1", "/a.docx")).not.toBe(aliasKey("20:2", "/a.docx"));
  });

  it("defaultLimits = 8 / 256MB / 2 / 32 / 1", () => {
    expect(defaultLimits()).toEqual({
      maxReaders: 8,
      maxActiveBytes: 268_435_456,
      maxConversions: 2,
      maxQueuedMetadata: 32,
      backgroundMax: 1,
    });
  });

  it("emptyAdmissionState 为空且未关停", () => {
    const state = emptyAdmissionState();
    expect(state).toEqual({ cache: {}, inflight: {}, queue: [], aliases: {}, activeBytes: 0, conversions: 0, disposed: false, seq: 0 });
    expect(summarizeAdmission(state)).toMatchObject({ cache: 0, inflight: 0, readers: 0, queue: 0, disposed: 0 });
  });
});

describe("admit:start / reuse / join", () => {
  it("空态新 key → STARTED,占用读者/转换/字节额度", () => {
    const result = admit(emptyAdmissionState(), req({ size: 1024 }));
    expect(result.action).toBe("start");
    expect(result.codes).toEqual([OFFICEPDF_STARTED]);
    expect(result.readers).toBe(1);
    expect(result.state.conversions).toBe(1);
    expect(result.state.activeBytes).toBe(1024);
    expect(result.state.inflight[result.key ?? ""]?.readers).toEqual(["r1"]);
  });

  it("ready 命中 → REUSED,lastUsed 更新,读者不增", () => {
    const { state, key } = readyState();
    const result = admit(state, req({ id: "r2", now: T0 + 5_000 }));
    expect(result.action).toBe("reuse");
    expect(result.codes).toEqual([OFFICEPDF_REUSED]);
    expect(result.readers).toBe(0);
    expect(result.state.cache[key]?.lastUsed).toBe(T0 + 5_000);
    expect(result.state.inflight).toEqual({});
    expect(result.state.conversions).toBe(0);
  });

  it("同 key 在转 → JOINED,读者追加、conversions/activeBytes 不动", () => {
    const first = admit(emptyAdmissionState(), req({ size: 512 }));
    const second = admit(first.state, req({ id: "r2" }));
    expect(second.action).toBe("join-inflight");
    expect(second.codes).toEqual([OFFICEPDF_JOINED]);
    expect(second.readers).toBe(2);
    expect(second.state.conversions).toBe(1);
    expect(second.state.activeBytes).toBe(512);
    expect(second.state.inflight[second.key ?? ""]?.readers).toEqual(["r1", "r2"]);
  });

  it("同 id 重复 join 不重复计数", () => {
    const first = admit(emptyAdmissionState(), req());
    const second = admit(first.state, req());
    expect(second.action).toBe("join-inflight");
    expect(second.readers).toBe(1);
  });

  it("join 时前台请求把后台 inflight 提升为前台", () => {
    const bg = admit(emptyAdmissionState(), req({ priority: "background" }));
    expect(bg.action).toBe("start");
    const fg = admit(bg.state, req({ id: "r2", priority: "foreground" }));
    expect(fg.state.inflight[fg.key ?? ""]?.priority).toBe("foreground");
    // 反向:后台 join 不会把前台的降级
    const fg2 = admit(emptyAdmissionState(), req({ id: "x1", priority: "foreground" }));
    const bg2 = admit(fg2.state, req({ id: "x2", priority: "background" }));
    expect(bg2.state.inflight[bg2.key ?? ""]?.priority).toBe("foreground");
  });
});

describe("admit:alias 复用与源版本变化(b)", () => {
  it("alias 指向 ready → REUSED,不占 reader", () => {
    const started = admit(emptyAdmissionState(), req({ name: "/docs/a.docx", sourceVersion: "10:1", size: 64 }));
    const done = complete(started.state, started.key ?? "", goodOutput(), { now: T0, path: "/out/a.pdf", sourceVersion: "10:1", name: "/docs/a.docx" });
    expect(done.ok).toBe(true);
    const result = admit(done.state, req({ id: "r2", name: "/docs/a.docx", sourceVersion: "10:1" }));
    expect(result.action).toBe("reuse");
    expect(result.codes).toEqual([OFFICEPDF_REUSED]);
    expect(result.readers).toBe(0);
    expect(result.state.aliases[aliasKey("10:1", "/docs/a.docx")]).toBe(started.key);
  });

  it("alias 所指 key 在 inflight → JOINED", () => {
    const started = admit(emptyAdmissionState(), req({ name: "/docs/a.docx", sourceVersion: "10:1" }));
    // 内容不同(不同 digest)但同一 alias:仍应 join 到那次转换上
    const joined = admit(started.state, req({ id: "r2", bytes: "other bytes", name: "/docs/a.docx", sourceVersion: "10:1" }));
    expect(joined.action).toBe("join-inflight");
    expect(joined.codes).toEqual([OFFICEPDF_JOINED]);
    expect(joined.key).toBe(started.key);
    expect(joined.state.inflight[started.key ?? ""]?.readers).toEqual(["r1", "r2"]);
  });

  it("同 name 旧 alias 但源版本变了 → SOURCE_CHANGED + start,旧缓存保留", () => {
    const first = admit(emptyAdmissionState(), req({ name: "/docs/a.docx", sourceVersion: "10:1", bytes: "v1-bytes" }));
    const key1 = first.key ?? "";
    const done = complete(first.state, key1, goodOutput(), { now: T0, path: "/out/a.pdf", sourceVersion: "10:1", name: "/docs/a.docx" });
    expect(done.ok).toBe(true);
    const changed = admit(done.state, req({ id: "r2", bytes: "v2-bytes", sourceVersion: "20:2", name: "/docs/a.docx" }));
    expect(changed.action).toBe("start");
    expect(changed.codes).toContain(OFFICEPDF_SOURCE_CHANGED);
    expect(changed.key).not.toBe(key1);
    expect(changed.state.cache[key1]?.status).toBe("ready");
    expect(changed.state.aliases[aliasKey("10:1", "/docs/a.docx")]).toBe(key1);
    expect(changed.state.aliases[aliasKey("20:2", "/docs/a.docx")]).toBe(changed.key);
  });

  it("alias 指向 inflight 时源版本变化 → 不复用旧转换", () => {
    const started = admit(emptyAdmissionState(), req({ name: "/docs/a.docx", sourceVersion: "10:1" }));
    const changed = admit(started.state, req({ id: "r2", bytes: "v2", sourceVersion: "20:2", name: "/docs/a.docx" }));
    expect(changed.action).toBe("start");
    expect(changed.key).not.toBe(started.key);
    expect(changed.codes).toContain(OFFICEPDF_SOURCE_CHANGED);
    expect(changed.state.inflight[started.key ?? ""]?.readers).toEqual(["r1"]);
  });
});

describe("admit:上限与排队(e)", () => {
  it("读者达上限:前台拒绝", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1" }), limits({ maxReaders: 1 }));
    const second = admit(first.state, req({ id: "r2", bytes: "other" }), limits({ maxReaders: 1 }));
    expect(second.action).toBe("reject");
    expect(second.codes).toEqual([OFFICEPDF_REJECTED]);
    expect(second.state).toBe(first.state);
  });

  it("读者达上限:后台排队(队尾)", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1" }), limits({ maxReaders: 1 }));
    const second = admit(first.state, req({ id: "r2", bytes: "other", priority: "background" }), limits({ maxReaders: 1 }));
    expect(second.action).toBe("queued");
    expect(second.codes).toEqual([OFFICEPDF_QUEUED]);
    expect(second.state.queue.map((item) => item.id)).toEqual(["r2"]);
  });

  it("转换达上限:前台插队首", () => {
    const busy = admit(emptyAdmissionState(), req({ id: "bg", priority: "foreground" }), limits({ maxConversions: 1 }));
    expect(busy.action).toBe("start");
    const second = admit(busy.state, req({ id: "fg2", bytes: "other" }), limits({ maxConversions: 1 }));
    expect(second.action).toBe("queued");
    expect(second.state.queue[0]?.id).toBe("fg2");
    expect(second.state.conversions).toBe(1);
  });

  it("转换达上限:后台排队队尾(前台已排队时排它后面)", () => {
    const busy = admit(emptyAdmissionState(), req({ id: "r1" }), limits({ maxConversions: 1 }));
    const queuedFg = admit(busy.state, req({ id: "fg2", bytes: "b1" }), limits({ maxConversions: 1 }));
    const queuedBg = admit(queuedFg.state, req({ id: "bg2", bytes: "b2", priority: "background" }), limits({ maxConversions: 1 }));
    expect(queuedBg.state.queue.map((item) => item.id)).toEqual(["fg2", "bg2"]);
  });

  it("后台已有在跑 → 后台排队(leave-one-slot)", () => {
    const bg = admit(emptyAdmissionState(), req({ id: "b1", priority: "background" }), limits({ maxConversions: 4, backgroundMax: 1 }));
    expect(bg.action).toBe("start");
    const bg2 = admit(bg.state, req({ id: "b2", bytes: "other", priority: "background" }), limits({ maxConversions: 4, backgroundMax: 1 }));
    expect(bg2.action).toBe("queued");
    expect(bg2.codes).toEqual([OFFICEPDF_QUEUED]);
  });

  it("只剩最后一个转换槽 → 后台让位排队", () => {
    const fg = admit(emptyAdmissionState(), req({ id: "f1" }), limits({ maxConversions: 2 }));
    expect(fg.state.conversions).toBe(1);
    const bg = admit(fg.state, req({ id: "b1", bytes: "other", priority: "background" }), limits({ maxConversions: 2 }));
    expect(bg.action).toBe("queued");
  });

  it("排队不占读者/转换/字节额度", () => {
    const busy = admit(emptyAdmissionState(), req({ id: "r1", size: 100 }), limits({ maxConversions: 1 }));
    const queued = admit(busy.state, req({ id: "r2", bytes: "other", size: 100 }), limits({ maxConversions: 1 }));
    expect(queued.action).toBe("queued");
    expect(queued.state.conversions).toBe(1);
    expect(queued.state.activeBytes).toBe(100);
    expect(queued.readers).toBe(0);
    expect(summarizeAdmission(queued.state).readers).toBe(1);
  });

  it("字节额度超限 → 拒绝", () => {
    const result = admit(emptyAdmissionState(), req({ size: 20 }), limits({ maxActiveBytes: 10 }));
    expect(result.action).toBe("reject");
    expect(result.codes).toEqual([OFFICEPDF_REJECTED]);
  });

  it("排队元数据位满 → 拒绝", () => {
    const result = admit(emptyAdmissionState(), req(), limits({ maxQueuedMetadata: 0 }));
    expect(result.action).toBe("reject");
    expect(result.codes).toEqual([OFFICEPDF_REJECTED]);
  });
});

describe("admit:非法入参与关停", () => {
  it("非法请求一律 INVALID 且状态不变(同引用)", () => {
    const state = emptyAdmissionState();
    expect(admit(state, req({ id: "" })).codes).toEqual([OFFICEPDF_INVALID]);
    expect(admit(state, req({ extension: " " })).codes).toEqual([OFFICEPDF_INVALID]);
    expect(admit(state, req({ converterGeneration: "" })).codes).toEqual([OFFICEPDF_INVALID]);
    expect(admit(state, req({ priority: "urgent" as never })).codes).toEqual([OFFICEPDF_INVALID]);
    expect(admit(state, req({ now: -1 })).codes).toEqual([OFFICEPDF_INVALID]);
    expect(admit(state, req({ bytes: undefined, digest: undefined })).codes).toEqual([OFFICEPDF_INVALID]);
    const bad = admit(state, req({ bytes: undefined, digest: undefined }));
    expect(bad.state).toBe(state);
  });

  it("坏 state 形状 → INVALID 不 throw", () => {
    const result = admit({} as never, req());
    expect(result.codes).toEqual([OFFICEPDF_INVALID]);
    expect(result.action).toBe("reject");
  });

  it("dispose 之后 admit → reject + DISPOSED", () => {
    const { state } = readyState();
    const dead = dispose(state).state;
    const result = admit(dead, req({ id: "r9" }));
    expect(result.action).toBe("reject");
    expect(result.codes).toEqual([OFFICEPDF_DISPOSED]);
  });
});

describe("complete:产物校验与结算(f)", () => {
  it("合格产物 → READY,清 inflight,退额度,写 cache", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput(), { now: T0 + 1, path: "/out/x.pdf" });
    expect(done.ok).toBe(true);
    expect(done.codes).toEqual([OFFICEPDF_READY]);
    expect(done.releasedBytes).toBe(2048);
    expect(done.state.inflight).toEqual({});
    expect(done.state.conversions).toBe(0);
    expect(done.state.activeBytes).toBe(0);
    expect(done.entry?.status).toBe("ready");
    expect(done.entry).toMatchObject({ status: "ready", path: "/out/x.pdf", size: 2048, lastUsed: T0 + 1 });
  });

  it("complete 带 sourceVersion+name → 写 alias", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput(), { now: T0, sourceVersion: "10:1", name: "/docs/a.docx" });
    expect(done.state.aliases[aliasKey("10:1", "/docs/a.docx")]).toBe(started.key);
    expect(done.entry?.aliases).toEqual([aliasKey("10:1", "/docs/a.docx")]);
  });

  it("坏 head(%PDF 缺失)→ INVALID_OUTPUT,不写 ready", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput({ head: "PK\u0003\u0004" }), { now: T0 });
    expect(done.ok).toBe(false);
    expect(done.codes).toEqual([OFFICEPDF_INVALID_OUTPUT]);
    expect(done.reasons).toContain("bad-head");
    expect(done.state.cache).toEqual({});
    expect(done.state.inflight).toEqual({});
    expect(done.state.conversions).toBe(0);
    expect(done.state.activeBytes).toBe(0);
  });

  it("坏 tail(%%EOF 缺失)→ INVALID_OUTPUT", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput({ lastBytes: "%%EOX\n" }), { now: T0 });
    expect(done.codes).toEqual([OFFICEPDF_INVALID_OUTPUT]);
    expect(done.reasons).toContain("bad-tail");
  });

  it("尾空白后仍以 %%EOF 收尾即通过", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput({ lastBytes: "%%EOF\n\n  " }), { now: T0 });
    expect(done.ok).toBe(true);
  });

  it("非普通文件 / 跟随了符号链接 → INVALID_OUTPUT", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    expect(complete(started.state, started.key ?? "", goodOutput({ isRegular: false }), {}).reasons).toContain("not-regular");
    expect(complete(started.state, started.key ?? "", goodOutput({ noFollow: false }), {}).reasons).toContain("followed-symlink");
  });

  it("size 为 0 或超 maxBytes → INVALID_OUTPUT", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    expect(complete(started.state, started.key ?? "", goodOutput({ size: 0 }), {}).reasons).toContain("bad-size");
    expect(complete(started.state, started.key ?? "", goodOutput({ size: 4096 }), { maxBytes: 1000 }).reasons).toContain("too-large");
  });

  it("expectedSize 不一致 → INVALID_OUTPUT", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const done = complete(started.state, started.key ?? "", goodOutput({ size: 2048 }), { expectedSize: 1024 });
    expect(done.codes).toEqual([OFFICEPDF_INVALID_OUTPUT]);
    expect(done.reasons).toContain("expected-size-mismatch");
  });

  it("key 不在 inflight → INVALID 且状态不变", () => {
    const { state } = readyState();
    const before = JSON.stringify(state);
    const done = complete(state, "lo-1::docx::nope", goodOutput(), { now: T0 });
    expect(done.ok).toBe(false);
    expect(done.codes).toEqual([OFFICEPDF_INVALID]);
    expect(done.state).toBe(state);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("complete 之后再请求同内容 → REUSED", () => {
    const { state } = readyState();
    const again = admit(state, req({ id: "r3", now: T0 + 10 }));
    expect(again.codes).toEqual([OFFICEPDF_REUSED]);
  });

  it("失败后同内容可重新发起转换(没有留下幽灵 inflight)", () => {
    const started = admit(emptyAdmissionState(), req({ size: 2048 }));
    const failed = complete(started.state, started.key ?? "", goodOutput({ head: "junk" }), { now: T0 });
    const retry = admit(failed.state, req({ id: "r2", now: T0 + 1 }));
    expect(retry.action).toBe("start");
    expect(retry.state.conversions).toBe(1);
  });
});

describe("cancelReader(g)", () => {
  it("多读者撤一个 → 不作废,remaining>0", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1", size: 100 }));
    const joined = admit(first.state, req({ id: "r2" }));
    const cancelled = cancelReader(joined.state, { id: "r2" });
    expect(cancelled.aborted).toBe(false);
    expect(cancelled.codes).toEqual([]);
    expect(cancelled.remaining).toBe(1);
    expect(cancelled.state.inflight[joined.key ?? ""]?.readers).toEqual(["r1"]);
    expect(cancelled.state.conversions).toBe(1);
  });

  it("最后一个读者撤了 → CANCELLED、清 inflight、退额度", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1", size: 100 }));
    const joined = admit(first.state, req({ id: "r2" }));
    const one = cancelReader(joined.state, { id: "r1" });
    expect(one.aborted).toBe(false);
    const cancelled = cancelReader(one.state, { id: "r2" });
    expect(cancelled.aborted).toBe(true);
    expect(cancelled.codes).toEqual([OFFICEPDF_CANCELLED]);
    expect(cancelled.state.inflight).toEqual({});
    expect(cancelled.state.conversions).toBe(0);
    expect(cancelled.state.activeBytes).toBe(0);
    expect(cancelled.releasedBytes).toBe(100);
  });

  it("撤读者同时清掉排队登记", () => {
    const busy = admit(emptyAdmissionState(), req({ id: "r1" }), limits({ maxConversions: 1 }));
    const queued = admit(busy.state, req({ id: "r2", bytes: "other" }), limits({ maxConversions: 1 }));
    expect(queued.state.queue).toHaveLength(1);
    const cancelled = cancelReader(queued.state, { id: "r2" });
    expect(cancelled.state.queue).toEqual([]);
    expect(cancelled.queueRemoved).toBe(1);
    expect(cancelled.aborted).toBe(false);
  });

  it("给 key 只影响那个 key", () => {
    const a = admit(emptyAdmissionState(), req({ id: "a1", bytes: "A" }));
    const b = admit(a.state, req({ id: "b1", bytes: "B" }));
    expect(b.state.inflight[b.key ?? ""]).toBeDefined();
    const cancelled = cancelReader(b.state, { id: "b1", key: b.key });
    expect(cancelled.aborted).toBe(true);
    expect(cancelled.state.inflight[b.key ?? ""]).toBeUndefined();
    expect(cancelled.state.inflight[a.key ?? ""]?.readers).toEqual(["a1"]);
  });

  it("未知读者 → INVALID 且状态不变", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1" }));
    const cancelled = cancelReader(first.state, { id: "nobody" });
    expect(cancelled.codes).toEqual([OFFICEPDF_INVALID]);
    expect(cancelled.state).toBe(first.state);
  });
});

describe("evictLru(h) 与 dispose(i)", () => {
  it("按 lastUsed 升序淘汰并剔除 alias", () => {
    const a = complete(admit(emptyAdmissionState(), req({ id: "a", bytes: "A", name: "/a.docx" })).state, cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "A" })), goodOutput(), { now: T0, sourceVersion: "1:1", name: "/a.docx" });
    const keyA = cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "A" }));
    const b = complete(admit(a.state, req({ id: "b", bytes: "B", now: T0 + 100 })).state, cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "B" })), goodOutput(), { now: T0 + 100 });
    const keyB = cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "B" }));
    expect(Object.keys(b.state.cache).sort()).toEqual([keyA, keyB].sort());
    const evicted = evictLru(b.state, { maxEntries: 1, now: T0 + 200 });
    expect(evicted.codes).toEqual([OFFICEPDF_EVICTED]);
    expect(evicted.evicted).toEqual([keyA]);
    expect(evicted.state.cache[keyA]).toBeUndefined();
    expect(evicted.state.cache[keyB]).toBeDefined();
    expect(Object.values(evicted.state.aliases)).not.toContain(keyA);
  });

  it("未超上限 → 不淘汰、codes 空", () => {
    const { state } = readyState();
    const evicted = evictLru(state, { maxEntries: 5 });
    expect(evicted.codes).toEqual([]);
    expect(evicted.evicted).toEqual([]);
    expect(evicted.state).toBe(state);
  });

  it("非法 maxEntries → INVALID", () => {
    const { state } = readyState();
    expect(evictLru(state, { maxEntries: -1 }).codes).toEqual([OFFICEPDF_INVALID]);
    expect(evictLru(state, { maxEntries: Number.NaN }).codes).toEqual([OFFICEPDF_INVALID]);
  });

  it("dispose 清空在转/排队并交回读者名单", () => {
    const first = admit(emptyAdmissionState(), req({ id: "r1", size: 100 }));
    const joined = admit(first.state, req({ id: "r2" }));
    const queued = admit(joined.state, req({ id: "r3", bytes: "other" }), limits({ maxConversions: 1 }));
    expect(queued.state.queue).toHaveLength(1);
    const disposed = dispose(queued.state);
    expect(disposed.codes).toEqual([OFFICEPDF_DISPOSED]);
    expect(disposed.state.disposed).toBe(true);
    expect(disposed.state.inflight).toEqual({});
    expect(disposed.state.queue).toEqual([]);
    expect(disposed.state.conversions).toBe(0);
    expect(disposed.state.activeBytes).toBe(0);
    expect(disposed.unavailable).toEqual(["r1", "r2"]);
    expect(disposed.state.cache).toEqual(queued.state.cache);
  });

  it("坏状态上 dispose → INVALID", () => {
    expect(dispose({ bad: true } as never).codes).toEqual([OFFICEPDF_INVALID]);
  });
});

describe("不可变性与读回(j)", () => {
  it("admit 不改入参 state", () => {
    const state = emptyAdmissionState();
    const before = JSON.stringify(state);
    admit(state, req({ name: "/a.docx" }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("complete / cancel / evict 不改入参 state", () => {
    const started = admit(emptyAdmissionState(), req({ size: 100 }));
    const joined = admit(started.state, req({ id: "r2" }));
    const before = JSON.stringify(joined.state);
    complete(joined.state, joined.key ?? "", goodOutput(), { now: T0, name: "/a.docx", sourceVersion: "1:1" });
    cancelReader(joined.state, { id: "r2" });
    evictLru(joined.state, { maxEntries: 0 });
    dispose(joined.state);
    expect(JSON.stringify(joined.state)).toBe(before);
  });

  it("sanitizeAdmissionState 能恢复落盘态并点名坏条目", () => {
    const { state } = readyState();
    const restored = sanitizeAdmissionState(JSON.parse(JSON.stringify(state)));
    expect(restored.dropped).toEqual([]);
    expect(summarizeAdmission(restored.state)).toEqual(summarizeAdmission(state));
    const broken = sanitizeAdmissionState({ cache: { a: { status: "weird" }, b: { status: "ready", size: 1, aliases: [], lastUsed: 1, path: "" } }, queue: [{ id: "q1" }] });
    expect(broken.dropped).toContain("cache:a");
    expect(broken.dropped).toContain("queue");
    expect(Object.keys(broken.state.cache)).toEqual(["b"]);
  });

  it("summarizeAdmission 统计与状态一致", () => {
    const started = admit(emptyAdmissionState(), req({ size: 100, name: "/a.docx" }));
    const summary = summarizeAdmission(started.state);
    expect(summary).toMatchObject({ cache: 0, inflight: 1, readers: 1, conversions: 1, activeBytes: 100, queue: 0, aliases: 1, disposed: 0 });
  });
});
