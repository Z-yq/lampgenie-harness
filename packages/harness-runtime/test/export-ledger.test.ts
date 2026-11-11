/**
 * 遥测导出账本专项:去重 / LRU / 超限拒绝 / redaction fail-closed / 深拷贝 / 确定性。
 * 全部纯逻辑用例——不碰网络、不碰文件、不依赖真实时钟。
 */
import { describe, it, expect } from "vitest";
import {
  EXPORT_CODES,
  ExportLedger,
  copyForExport,
  defaultExportRedactor,
  dedupeKeyOf,
  redactForExport,
} from "../src/agent/export-ledger";

const SK = "sk-" + "a".repeat(32); // 命中 core redactText 的 sk- 规则(≥16 位主体)

describe("export-ledger / 常量与键", () => {
  it("EXPORT_CODES 恰好五种且顺序固定", () => {
    expect(EXPORT_CODES).toEqual(["OK", "DUPLICATE", "TOO_LARGE", "REDACTION_FAILED", "INVALID"]);
  });

  it("dedupeKeyOf 按 format:session:seq 逐字拼接", () => {
    expect(dedupeKeyOf("s1", "otel", "span-1")).toBe("otel:s1:span-1");
    expect(dedupeKeyOf("s1", "otel", 7)).toBe("otel:s1:7");
  });

  it("dedupeKeyOf 同三元组稳定、不同维度可区分", () => {
    expect(dedupeKeyOf("s1", "otel", 3)).toBe(dedupeKeyOf("s1", "otel", 3));
    expect(dedupeKeyOf("s1", "otel", 3)).not.toBe(dedupeKeyOf("s1", "journal", 3));
    expect(dedupeKeyOf("s1", "otel", 3)).not.toBe(dedupeKeyOf("s2", "otel", 3));
  });
});

describe("export-ledger / admit 与去重", () => {
  it("首次登记 OK,admitted/keys 递增", () => {
    const l = new ExportLedger();
    const r = l.admit("k1", { a: 1 });
    expect(r).toMatchObject({ ok: true, code: "OK" });
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"));
    expect(l.stats()).toMatchObject({ admitted: 1, duplicates: 0, keys: 1 });
  });

  it("同 key 二次 → DUPLICATE,不重复登记", () => {
    const l = new ExportLedger();
    l.admit("k1", { a: 1 });
    const r = l.admit("k1", { a: 1 });
    expect(r).toMatchObject({ ok: false, code: "DUPLICATE" });
    expect(l.stats()).toMatchObject({ admitted: 1, duplicates: 1, keys: 1 });
  });

  it("重复即刷新 LRU:同 key 重放不会被优先淘汰", () => {
    const l = new ExportLedger({ maxKeys: 2 });
    l.admit("a", {});
    l.admit("b", {});
    expect(l.admit("a", {}).code).toBe("DUPLICATE"); // a 刷新为最近使用
    l.admit("c", {}); // 淘汰最旧 b
    expect(l.has("a")).toBe(true);
    expect(l.has("b")).toBe(false);
    expect(l.has("c")).toBe(true);
  });

  it("LRU 超限淘汰最旧且 stats.keys 受限", () => {
    const l = new ExportLedger({ maxKeys: 3 });
    for (const k of ["a", "b", "c", "d"]) l.admit(k, { k });
    expect(l.stats().keys).toBe(3);
    expect(l.has("a")).toBe(false);
    expect(l.has("d")).toBe(true);
  });

  it("maxKeys=0 被钳到 1(不越界)", () => {
    const l = new ExportLedger({ maxKeys: 0 });
    l.admit("a", {});
    l.admit("b", {});
    expect(l.stats().keys).toBe(1);
    expect(l.has("b")).toBe(true);
  });

  it("时钟注入只影响最近使用时间戳", () => {
    let t = 100;
    const l = new ExportLedger({ now: () => (t += 10) });
    l.admit("a", {});
    expect(l.lastTouchedAt("a")).toBe(110);
    l.admit("a", {});
    expect(l.lastTouchedAt("a")).toBe(120); // 重复刷新时间戳
  });
});

describe("export-ledger / 体积上限(拒绝不截断)", () => {
  it("超 256KiB 默认上限 → TOO_LARGE 且字节数如实上报", () => {
    const l = new ExportLedger();
    const big = { payload: "x".repeat(262_200) };
    const bytes = Buffer.byteLength(JSON.stringify(big), "utf8");
    const r = l.admit("big", big);
    expect(r).toMatchObject({ ok: false, code: "TOO_LARGE", bytes });
    expect(l.stats()).toMatchObject({ tooLarge: 1, keys: 0 });
  });

  it("超限记录不被截断:原对象长度与内容不变", () => {
    const l = new ExportLedger({ maxRecordBytes: 8 });
    const big = { payload: "y".repeat(100) };
    const before = JSON.stringify(big).length;
    expect(l.admit("big", big).code).toBe("TOO_LARGE");
    expect(JSON.stringify(big).length).toBe(before);
    expect(big.payload.length).toBe(100);
  });

  it("恰好等于上限 → OK(判据是严格大于)", () => {
    const record = { a: 1 };
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const l = new ExportLedger({ maxRecordBytes: bytes });
    expect(l.admit("edge", record)).toMatchObject({ ok: true, code: "OK", bytes });
  });

  it("超限不登记去重键:同 key 缩小后仍可入账", () => {
    const l = new ExportLedger({ maxRecordBytes: 20 });
    const big = { a: "z".repeat(100) };
    expect(l.admit("k", big).code).toBe("TOO_LARGE");
    expect(l.has("k")).toBe(false);
    expect(l.admit("k", { a: 1 }).code).toBe("OK");
  });
});

describe("export-ledger / INVALID 边界", () => {
  it("空 key → INVALID", () => {
    const l = new ExportLedger();
    expect(l.admit("", { a: 1 })).toMatchObject({ ok: false, code: "INVALID", bytes: 0 });
  });

  it("非字符串 key → INVALID", () => {
    const l = new ExportLedger();
    expect(l.admit(undefined as unknown as string, { a: 1 }).code).toBe("INVALID");
  });

  it("循环引用 → INVALID", () => {
    const l = new ExportLedger();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(l.admit("cyc", cyc).code).toBe("INVALID");
  });

  it("BigInt → INVALID", () => {
    const l = new ExportLedger();
    expect(l.admit("bigint", { n: 1n }).code).toBe("INVALID");
  });

  it("undefined / 函数 → INVALID(JSON.stringify 返回非字符串)", () => {
    const l = new ExportLedger();
    expect(l.admit("u", undefined).code).toBe("INVALID");
    expect(l.admit("f", () => 1).code).toBe("INVALID");
  });
});

describe("export-ledger / stats 与确定性", () => {
  it("初始 stats 全零", () => {
    expect(new ExportLedger().stats()).toEqual({
      admitted: 0,
      duplicates: 0,
      tooLarge: 0,
      redactionFailed: 0,
      keys: 0,
    });
  });

  it("markRedactionFailed 独立计数", () => {
    const l = new ExportLedger();
    l.markRedactionFailed();
    l.markRedactionFailed();
    expect(l.stats().redactionFailed).toBe(2);
  });

  it("确定性:同输入序列得到同 stats", () => {
    const run = () => {
      const l = new ExportLedger({ maxKeys: 2, maxRecordBytes: 10 });
      l.admit("a", {});
      l.admit("a", {});
      l.admit("b", { payload: "x".repeat(50) });
      l.admit("c", {});
      l.admit("d", {});
      l.markRedactionFailed();
      return l.stats();
    };
    expect(run()).toEqual(run());
  });
});

describe("export-ledger / redactForExport fail-closed", () => {
  it("默认脱敏覆盖 attributes.stringValue 与 name", () => {
    const record = {
      name: `tool.${SK}`,
      attributes: [{ key: "genie.toolCallId", value: { stringValue: `arg=${SK}` } }],
    };
    const r = redactForExport(record);
    expect(r.ok).toBe(true);
    const out = (r as { record: typeof record }).record;
    expect(out.name).toBe("tool.<redacted:sk>");
    expect(out.attributes[0]!.value.stringValue).toBe("arg=<redacted:sk>");
    expect(JSON.stringify(out)).not.toContain(SK);
  });

  it("默认脱敏幂等:二次运行输出不变", () => {
    const once = defaultExportRedactor({ t: `Bearer ${"b".repeat(24)}` }) as Record<string, unknown>;
    expect(defaultExportRedactor(once)).toEqual(once);
  });

  it("成功分支不改写输入记录", () => {
    const record = { name: "tool.x", attributes: [{ key: "k", value: { stringValue: SK } }] };
    const snapshot = JSON.parse(JSON.stringify(record));
    const r = redactForExport(record);
    expect(r.ok).toBe(true);
    expect(record).toEqual(snapshot);
    expect((r as { record: unknown }).record).not.toBe(record);
  });

  it("redactor 抛错 → REDACTION_FAILED,失败分支不带 record", () => {
    const r = redactForExport({ a: 1 }, () => { throw new Error("boom"); });
    expect(r).toEqual({ ok: false, code: "REDACTION_FAILED", error: "boom" });
    expect("record" in r).toBe(false);
  });

  it("redactor 抛非 Error → REDACTION_FAILED 且 error 字符串化", () => {
    const r = redactForExport({ a: 1 }, () => { throw "bad"; });
    expect(r).toMatchObject({ ok: false, code: "REDACTION_FAILED", error: "bad" });
  });

  it("redactor 返回非对象(含数组)→ REDACTION_FAILED", () => {
    expect(redactForExport({ a: 1 }, () => "text")).toMatchObject({ code: "REDACTION_FAILED" });
    expect(redactForExport({ a: 1 }, () => [1])).toMatchObject({ code: "REDACTION_FAILED" });
    expect(redactForExport({ a: 1 }, () => null)).toMatchObject({ code: "REDACTION_FAILED" });
  });

  it("redactor 返回原引用 → REDACTION_FAILED(无法证明脱敏发生过)", () => {
    expect(redactForExport({ a: 1 }, (r) => r)).toEqual({
      ok: false,
      code: "REDACTION_FAILED",
      error: "redactor-returned-original",
    });
  });

  it("输入非对象 → INVALID", () => {
    expect(redactForExport(null).code).toBe("INVALID");
    expect(redactForExport([1]).code).toBe("INVALID");
    expect(redactForExport("s").code).toBe("INVALID");
  });
});

describe("export-ledger / copyForExport 深拷贝", () => {
  it("副本与源不共享任何层级引用", () => {
    const src = { a: 1, nested: { b: [1, 2, { c: 3 }] } };
    const r = copyForExport(src);
    expect(r.ok).toBe(true);
    const copy = (r as { record: typeof src }).record;
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(copy.nested).not.toBe(src.nested);
    expect(copy.nested.b[2]).not.toBe(src.nested.b[2]);
  });

  it("改副本不污染源", () => {
    const src = { name: "tool.x", nested: { value: "sk-original" } };
    const copy = (copyForExport(src) as { record: typeof src }).record;
    copy.nested.value = "changed";
    expect(src.nested.value).toBe("sk-original");
  });

  it("不可序列化 → INVALID(不降级为浅拷贝)", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(copyForExport(cyc)).toMatchObject({ ok: false, code: "INVALID" });
    expect(copyForExport(undefined)).toMatchObject({ ok: false, code: "INVALID" });
  });
});
