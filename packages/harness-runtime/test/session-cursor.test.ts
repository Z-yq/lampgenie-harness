/**
 * 会话查询游标(纯逻辑,零 IO)。
 * 断言全部按 session-cursor.ts 的真实行为:规范化指纹(键序无关 / 数组保序 / undefined≡缺键)、
 * 签发字段与签名长度、解析各类坏输入、validate 四码且 STALE 先于 QUERY_MISMATCH、
 * generation 推进、reconcile 幂等去重、台账计数口径,以及脏输入不抛。
 */
import { describe, expect, it } from "vitest";

import {
  CURSOR_CODES,
  GENERATION_CAUSES,
  cursorStats,
  isStaleError,
  issueCursor,
  nextGeneration,
  parseCursor,
  queryFingerprint,
  reconcile,
  validateCursor,
} from "../src/agent/session-cursor.ts";

const HEX16 = /^[0-9a-f]{16}$/;

function issueAt(at: number, query: unknown = { text: "foo" }, generation = 1) {
  return issueCursor({ generation, query, position: { beforeSeq: 5 }, at });
}

describe("queryFingerprint 稳定指纹", () => {
  it("对象键序不影响指纹", () => {
    expect(queryFingerprint({ a: 1, b: 2 })).toBe(queryFingerprint({ b: 2, a: 1 }));
  });

  it("嵌套对象键序也不影响指纹", () => {
    const left = { text: "foo", filters: { a: 1, b: 2 } };
    const right = { filters: { b: 2, a: 1 }, text: "foo" };
    expect(queryFingerprint(left)).toBe(queryFingerprint(right));
  });

  it("数组保序,顺序不同则指纹不同", () => {
    expect(queryFingerprint({ tags: ["a", "b"] })).not.toBe(queryFingerprint({ tags: ["b", "a"] }));
  });

  it("数组等长不同值指纹不同", () => {
    expect(queryFingerprint({ ids: [1, 2, 3] })).not.toBe(queryFingerprint({ ids: [1, 2, 4] }));
  });

  it("undefined 与缺键等价", () => {
    expect(queryFingerprint({ a: 1, b: undefined })).toBe(queryFingerprint({ a: 1 }));
  });

  it("嵌套 undefined 也与缺键等价", () => {
    expect(queryFingerprint({ filters: { a: 1, b: undefined } })).toBe(
      queryFingerprint({ filters: { a: 1 } }),
    );
  });

  it("指纹是 16 位十六进制", () => {
    expect(queryFingerprint({ text: "foo" })).toMatch(HEX16);
  });

  it("数字 1 与字符串 \"1\" 指纹不同", () => {
    expect(queryFingerprint({ a: 1 })).not.toBe(queryFingerprint({ a: "1" }));
  });

  it("null 与空对象指纹不同", () => {
    expect(queryFingerprint(null)).not.toBe(queryFingerprint({}));
  });

  it("两个不同 Date 指纹不同", () => {
    expect(queryFingerprint({ since: new Date(1) })).not.toBe(queryFingerprint({ since: new Date(2) }));
  });

  it("NaN 归一为 null,不抛且稳定", () => {
    const first = queryFingerprint({ a: Number.NaN });
    expect(first).toBe(queryFingerprint({ a: Number.NaN }));
    expect(first).toBe(queryFingerprint({ a: null }));
  });

  it("环引用输入不抛,返回稳定指纹", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const fingerprint = queryFingerprint(cyclic);
    expect(fingerprint).toMatch(HEX16);
    expect(fingerprint).toBe(queryFingerprint(cyclic));
  });

  it("函数与 symbol 值不抛,并按 null 归一", () => {
    const fingerprint = queryFingerprint({ fn: () => 1, sym: Symbol("s") });
    expect(fingerprint).toMatch(HEX16);
    expect(fingerprint).toBe(queryFingerprint({ fn: null, sym: null }));
  });
});

describe("issueCursor 签发", () => {
  it("载荷字段齐全", () => {
    const envelope = issueAt(100);
    expect(envelope.payload.generation).toBe(1);
    expect(envelope.payload.issuedAt).toBe(100);
    expect(envelope.payload.nextBeforeSeq).toBe(5);
    expect(envelope.payload.queryFingerprint).toBe(queryFingerprint({ text: "foo" }));
  });

  it("签名 16 位十六进制", () => {
    expect(issueAt(100).signature).toMatch(HEX16);
  });

  it("afterSeq 落到 nextAfterSeq", () => {
    const envelope = issueCursor({ generation: 2, query: { text: "x" }, position: { afterSeq: 9 }, at: 5 });
    expect(envelope.payload.nextAfterSeq).toBe(9);
    expect(envelope.payload.nextBeforeSeq).toBeUndefined();
  });

  it("无 position 时两个 seq 字段都不出现", () => {
    const envelope = issueCursor({ generation: 1, query: { text: "x" }, at: 5 });
    expect("nextBeforeSeq" in envelope.payload).toBe(false);
    expect("nextAfterSeq" in envelope.payload).toBe(false);
  });

  it("generation 非数字回落 1", () => {
    const envelope = issueCursor({ generation: undefined, query: {}, at: 5 });
    expect(envelope.payload.generation).toBe(1);
  });

  it("generation 传字符串也回落 1", () => {
    const envelope = issueCursor({ generation: "7", query: {}, at: 5 });
    expect(envelope.payload.generation).toBe(1);
  });

  it("generation 为 0 或负数回落 1", () => {
    expect(issueCursor({ generation: 0, query: {}, at: 1 }).payload.generation).toBe(1);
    expect(issueCursor({ generation: -3, query: {}, at: 1 }).payload.generation).toBe(1);
  });

  it("同输入同 at 签名确定", () => {
    expect(issueAt(1000).signature).toBe(issueAt(1000).signature);
  });

  it("issuedAt 不同则签名不同", () => {
    expect(issueAt(1000).signature).not.toBe(issueAt(1001).signature);
  });

  it("不传 at 时 issuedAt 是当前时间戳", () => {
    const before = Date.now();
    const envelope = issueCursor({ generation: 1, query: {} });
    expect(envelope.payload.issuedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("parseCursor 解析", () => {
  it("合法信封解析出载荷与 OK", () => {
    const parsed = parseCursor(issueAt(100));
    expect(parsed.code).toBe("CURSOR_OK");
    expect(parsed.payload?.generation).toBe(1);
  });

  it("非对象输入 → INVALID", () => {
    expect(parseCursor(undefined).code).toBe("CURSOR_INVALID");
    expect(parseCursor(null).code).toBe("CURSOR_INVALID");
    expect(parseCursor("cursor").code).toBe("CURSOR_INVALID");
    expect(parseCursor([1, 2]).code).toBe("CURSOR_INVALID");
  });

  it("缺 payload → INVALID", () => {
    expect(parseCursor({ signature: "0".repeat(16) }).code).toBe("CURSOR_INVALID");
  });

  it("缺 signature → INVALID", () => {
    const envelope = issueAt(100);
    expect(parseCursor({ payload: envelope.payload }).code).toBe("CURSOR_INVALID");
  });

  it("signature 为空串 → INVALID", () => {
    const envelope = issueAt(100);
    expect(parseCursor({ payload: envelope.payload, signature: "  " }).code).toBe("CURSOR_INVALID");
  });

  it("signature 改一位 → INVALID", () => {
    const envelope = issueAt(100);
    const tampered = `${envelope.signature.slice(0, 15)}${envelope.signature.endsWith("0") ? "1" : "0"}`;
    expect(parseCursor({ payload: envelope.payload, signature: tampered }).code).toBe("CURSOR_INVALID");
  });

  it("payload 的 generation 被改 → INVALID", () => {
    const envelope = issueAt(100);
    expect(parseCursor({ payload: { ...envelope.payload, generation: 2 }, signature: envelope.signature }).code).toBe(
      "CURSOR_INVALID",
    );
  });

  it("payload 的 issueAt 类型错 → INVALID", () => {
    const envelope = issueAt(100);
    expect(parseCursor({ payload: { ...envelope.payload, issuedAt: "now" }, signature: envelope.signature }).code).toBe(
      "CURSOR_INVALID",
    );
  });

  it("nextBeforeSeq 类型错 → INVALID", () => {
    const envelope = issueAt(100);
    expect(
      parseCursor({ payload: { ...envelope.payload, nextBeforeSeq: "5" }, signature: envelope.signature }).code,
    ).toBe("CURSOR_INVALID");
  });

  it("非游标 JSON(查询体)当游标 → INVALID", () => {
    expect(parseCursor({ text: "foo", filters: { a: 1 } }).code).toBe("CURSOR_INVALID");
  });

  it("payload 不是对象 → INVALID", () => {
    expect(parseCursor({ payload: "cursor", signature: "abc" }).code).toBe("CURSOR_INVALID");
  });
});

describe("validateCursor 四码", () => {
  it("同 generation 同 query → OK", () => {
    const verdict = validateCursor(issueAt(10), { currentGeneration: 1, query: { text: "foo" } });
    expect(verdict.ok).toBe(true);
    expect(verdict.code).toBe("CURSOR_OK");
  });

  it("query 键序不同仍 OK", () => {
    const envelope = issueCursor({ generation: 1, query: { a: 1, b: 2 }, at: 1 });
    const verdict = validateCursor(envelope, { currentGeneration: 1, query: { b: 2, a: 1 } });
    expect(verdict.code).toBe("CURSOR_OK");
  });

  it("generation 不等 → STALE", () => {
    const verdict = validateCursor(issueAt(10), { currentGeneration: 2, query: { text: "foo" } });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("CURSOR_STALE");
  });

  it("generation 与 query 同时不等 → STALE(先于指纹)", () => {
    const verdict = validateCursor(issueAt(10), { currentGeneration: 3, query: { text: "bar" } });
    expect(verdict.code).toBe("CURSOR_STALE");
  });

  it("同 generation 改 query → QUERY_MISMATCH", () => {
    const verdict = validateCursor(issueAt(10), {
      currentGeneration: 1,
      query: { text: "foo", filters: { a: 2 } },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("CURSOR_QUERY_MISMATCH");
  });

  it("坏签名 → INVALID 而不是 STALE", () => {
    const envelope = issueAt(10);
    const verdict = validateCursor(
      { payload: envelope.payload, signature: "0123456789abcdef" },
      { currentGeneration: 1, query: { text: "foo" } },
    );
    expect(verdict.code).toBe("CURSOR_INVALID");
  });

  it("currentGeneration 缺失按 1 处理", () => {
    const verdict = validateCursor(issueAt(10), { currentGeneration: undefined, query: { text: "foo" } });
    expect(verdict.code).toBe("CURSOR_OK");
  });

  it("结论都带非空 detail", () => {
    const okVerdict = validateCursor(issueAt(10), { currentGeneration: 1, query: { text: "foo" } });
    const staleVerdict = validateCursor(issueAt(10), { currentGeneration: 2, query: { text: "foo" } });
    expect(okVerdict.detail.length).toBeGreaterThan(0);
    expect(staleVerdict.detail.length).toBeGreaterThan(0);
    expect(staleVerdict.detail).toContain("generation");
  });
});

describe("isStaleError 判定", () => {
  it("STALE 为真", () => {
    expect(isStaleError("CURSOR_STALE")).toBe(true);
  });

  it("其它码与脏输入为假", () => {
    expect(isStaleError("CURSOR_OK")).toBe(false);
    expect(isStaleError("CURSOR_QUERY_MISMATCH")).toBe(false);
    expect(isStaleError(undefined)).toBe(false);
    expect(isStaleError(null)).toBe(false);
    expect(isStaleError(2)).toBe(false);
  });
});

describe("nextGeneration 推进", () => {
  it("index-rebuild 加一", () => {
    expect(nextGeneration(1, "index-rebuild")).toBe(2);
  });

  it("corpus-change 加一", () => {
    expect(nextGeneration(4, "corpus-change")).toBe(5);
  });

  it("reconcile 加一", () => {
    expect(nextGeneration(2, "reconcile")).toBe(3);
  });

  it("restart 加一", () => {
    expect(nextGeneration(7, "restart")).toBe(8);
  });

  it("非数字 current 从 1 起", () => {
    expect(nextGeneration(undefined, "restart")).toBe(2);
    expect(nextGeneration("3", "reconcile")).toBe(2);
  });

  it("四类 cause 都在词汇表内", () => {
    expect(GENERATION_CAUSES.length).toBe(4);
  });
});

describe("reconcile 单事务推进", () => {
  it("空 events 不推进", () => {
    const result = reconcile([], { cursorGen: 5 });
    expect(result.generation).toBe(5);
    expect(result.applied).toEqual([]);
  });

  it("同一 cause 重复只推进一次", () => {
    const result = reconcile(["index-rebuild", "index-rebuild"], { cursorGen: 1 });
    expect(result.generation).toBe(2);
    expect(result.applied).toEqual(["index-rebuild"]);
  });

  it("多 cause 按首次出现顺序去重", () => {
    const result = reconcile(["reconcile", "index-rebuild", "reconcile"], { cursorGen: 2 });
    expect(result.applied).toEqual(["reconcile", "index-rebuild"]);
    expect(result.generation).toBe(4);
  });

  it("接受 {cause} 对象形式", () => {
    const result = reconcile([{ cause: "corpus-change" }, { cause: "corpus-change" }], { cursorGen: 1 });
    expect(result.applied).toEqual(["corpus-change"]);
    expect(result.generation).toBe(2);
  });

  it("未知 cause 与脏条目被忽略", () => {
    const result = reconcile(["bogus", null, 3, { nope: 1 }], { cursorGen: 3 });
    expect(result.applied).toEqual([]);
    expect(result.generation).toBe(3);
  });

  it("cursorGen 非数字按 1 起算", () => {
    const result = reconcile(["restart"], { cursorGen: undefined });
    expect(result.generation).toBe(2);
  });

  it("generation 恒等于 cursorGen + applied.length", () => {
    const result = reconcile(["restart", "reconcile", "restart"], { cursorGen: 10 });
    expect(result.generation).toBe(10 + result.applied.length);
  });
});

describe("cursorStats 计数口径", () => {
  it("OK / STALE / MISMATCH / INVALID 各归其位", () => {
    const good = issueAt(10);
    const stats = cursorStats([
      { envelope: good, currentGeneration: 1, query: { text: "foo" } },
      { envelope: good, currentGeneration: 2, query: { text: "foo" } },
      { envelope: good, currentGeneration: 1, query: { text: "bar" } },
      { envelope: { nope: true }, currentGeneration: 1, query: { text: "foo" } },
    ]);
    expect(stats.issued).toBe(4);
    expect(stats.stale).toBe(1);
    expect(stats.mismatch).toBe(1);
    expect(stats.invalid).toBe(1);
  });

  it("坏签名只计 invalid,不计入 mismatch", () => {
    const envelope = issueAt(10);
    const stats = cursorStats([
      { envelope: { payload: envelope.payload, signature: "ffffffffffffffff" }, currentGeneration: 2, query: {} },
    ]);
    expect(stats.invalid).toBe(1);
    expect(stats.mismatch).toBe(0);
    expect(stats.stale).toBe(0);
  });

  it("空数组全为 0", () => {
    expect(cursorStats([])).toEqual({ issued: 0, stale: 0, mismatch: 0, invalid: 0 });
  });

  it("invalid + stale + mismatch 不超过 issued", () => {
    const good = issueAt(10);
    const stats = cursorStats([
      { envelope: good, currentGeneration: 1, query: { text: "foo" } },
      { envelope: null, currentGeneration: 1, query: { text: "foo" } },
    ]);
    expect(stats.invalid + stats.stale + stats.mismatch).toBeLessThanOrEqual(stats.issued);
  });
});

describe("稳定码与脏输入", () => {
  it("码表含全部七码", () => {
    expect(new Set(CURSOR_CODES).size).toBe(7);
    expect(CURSOR_CODES).toContain("CURSOR_STALE");
    expect(CURSOR_CODES).toContain("CURSOR_STALE_REJECTED");
  });

  it("issueCursor 收空对象不抛", () => {
    const envelope = issueCursor({ generation: undefined, query: undefined });
    expect(envelope.payload.generation).toBe(1);
    expect(envelope.signature).toMatch(HEX16);
  });

  it("validateCursor 拿 undefined 信封不抛", () => {
    expect(validateCursor(undefined, { currentGeneration: Number.NaN, query: undefined }).code).toBe("CURSOR_INVALID");
  });

  it("parseCursor 拿深度嵌套脏值不抛", () => {
    const dirty = { payload: { generation: {}, nextBeforeSeq: () => 1 }, signature: 42 };
    expect(parseCursor(dirty).code).toBe("CURSOR_INVALID");
  });

  it("reconcile 拿非数组 events 不抛", () => {
    const result = reconcile([] as readonly unknown[], { cursorGen: 2 });
    expect(result.generation).toBe(2);
  });
});
