/**
 * Office→PDF 准入持久层:原子写 / 读回恢复 / 拒绝零副作用 / 坏账本拒写 / 假转换器全流程 / 报告。
 * 每个用例用独立临时根目录,不碰仓内 .genie。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitOnDisk,
  cancelOnDisk,
  completeOnDisk,
  disposeOnDisk,
  evictOnDisk,
  isOfficePdfRejection,
  OFFICEPDF_FILE,
  OFFICEPDF_OUT_DIRNAME,
  OFFICEPDF_REJECTION_CODES,
  OFFICEPDF_RELATIVE_DIR,
  officePdfPaths,
  readOfficePdfState,
  reportOfficePdf,
  writeOfficePdfState,
  writeStubPdf,
  type Converter,
} from "../src/office-pdf-store.ts";
import { cacheKeyString, contentKey, emptyAdmissionState, OFFICEPDF_VERSION, type ConvertRequest } from "@lampgenie/runtime/agent/office-pdf-admission";

const T0 = 1_700_000_000_000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "office-pdf-"));
  roots.push(root);
  return root;
}

function ledger(root: string): { v: number; state: { cache: Record<string, unknown>; inflight: Record<string, unknown>; queue: unknown[]; conversions: number } } {
  return JSON.parse(readFileSync(officePdfPaths(root).file, "utf8"));
}

function req(over: Partial<ConvertRequest> = {}): ConvertRequest {
  return { id: "r1", extension: "docx", converterGeneration: "lo-1", priority: "foreground", sourceVersion: "100:1", now: T0, bytes: "hello world", ...over };
}

const stubConverter: Converter = (input) => writeStubPdf(input.root, { key: input.key, digest: input.digest, extension: input.extension });

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("路径与坏参数", () => {
  it("路径落在 .genie/rsi 下", () => {
    const paths = officePdfPaths("/repo");
    expect(paths.dir).toBe("/repo/.genie/rsi");
    expect(paths.file).toBe("/repo/.genie/rsi/office-pdf.json");
    expect(paths.outDir).toBe("/repo/.genie/rsi/office-pdf-out");
    expect(OFFICEPDF_RELATIVE_DIR).toBe(".genie/rsi");
    expect(OFFICEPDF_FILE).toBe("office-pdf.json");
    expect(OFFICEPDF_OUT_DIRNAME).toBe("office-pdf-out");
    expect(OFFICEPDF_VERSION).toBe(1);
  });

  it("root 非法 → TypeError", () => {
    expect(() => officePdfPaths("")).toThrow(TypeError);
    expect(() => readOfficePdfState(" ")).toThrow(TypeError);
    expect(() => admitOnDisk("", req())).toThrow(TypeError);
    expect(() => evictOnDisk("/repo", { maxEntries: Number.NaN })).toThrow(TypeError);
  });

  it("账本不存在 → 空状态 ok(首次运行)", () => {
    const root = newRoot();
    const read = readOfficePdfState(root);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(false);
    expect(read.dropped).toEqual([]);
    expect(read.state).toEqual(emptyAdmissionState());
  });
});

describe("原子写与读回", () => {
  it("写后落盘带 v/state,且不留临时文件", () => {
    const root = newRoot();
    const state = { ...emptyAdmissionState(), conversions: 1, activeBytes: 42, seq: 3 };
    const write = writeOfficePdfState(root, state);
    expect(write.ok).toBe(true);
    expect(write.codes).toEqual([]);
    const raw = ledger(root);
    expect(raw.v).toBe(OFFICEPDF_VERSION);
    expect(raw.state.conversions).toBe(1);
    const files = readdirSync(officePdfPaths(root).dir);
    expect(files.filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("cache/inflight/queue/aliases/activeBytes/conversions 全都能读回", () => {
    const root = newRoot();
    const key = cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "hello world" }));
    const state = {
      ...emptyAdmissionState(),
      cache: { [key]: { status: "ready" as const, path: "/out/x.pdf", size: 2048, aliases: ["alias"], lastUsed: T0 } },
      inflight: { k2: { readers: ["r1", "r2"], priority: "background" as const, startedAt: T0, digest: "d", extension: "docx", size: 10 } },
      queue: [{ id: "r3", key: "k3", priority: "background" as const, now: T0 }],
      aliases: { alias: key },
      activeBytes: 10,
      conversions: 1,
      seq: 7,
    };
    expect(writeOfficePdfState(root, state).ok).toBe(true);
    const read = readOfficePdfState(root);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(true);
    expect(read.dropped).toEqual([]);
    expect(read.state.cache[key]).toMatchObject({ status: "ready", size: 2048, lastUsed: T0 });
    expect(read.state.inflight["k2"]?.readers).toEqual(["r1", "r2"]);
    expect(read.state.queue[0]?.id).toBe("r3");
    expect(read.state.aliases["alias"]).toBe(key);
    expect(read.state.activeBytes).toBe(10);
    expect(read.state.conversions).toBe(1);
  });

  it("坏账本(非 JSON)→ STORE_ERROR,写操作拒写且不动原文件", () => {
    const root = newRoot();
    const paths = officePdfPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    const garbage = "{ not json at all";
    writeFileSync(paths.file, garbage, "utf8");
    const read = readOfficePdfState(root);
    expect(read.ok).toBe(false);
    expect(read.codes).toEqual(["OFFICEPDF_STORE_ERROR"]);
    const admitted = admitOnDisk(root, req({ name: "/a.docx" }));
    expect(admitted.ok).toBe(false);
    expect(admitted.persisted).toBe(false);
    expect(admitted.codes).toContain("OFFICEPDF_STORE_ERROR");
    expect(readFileSync(paths.file, "utf8")).toBe(garbage);
  });

  it("形状坏到无法恢复的条目被点名丢弃,其余照常恢复", () => {
    const root = newRoot();
    const paths = officePdfPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    const key = cacheKeyString(contentKey({ converterGeneration: "lo-1", extension: "docx", bytes: "hi" }));
    writeFileSync(
      paths.file,
      JSON.stringify({ v: 1, state: { cache: { bad: { status: "nope" }, [key]: { status: "ready", size: 1, aliases: [], lastUsed: 1, path: "" } }, inflight: {}, queue: [], aliases: {}, activeBytes: 0, conversions: 0, disposed: false, seq: 0 } }),
      "utf8",
    );
    const read = readOfficePdfState(root);
    expect(read.ok).toBe(true);
    expect(read.dropped).toContain("cache:bad");
    expect(Object.keys(read.state.cache)).toEqual([key]);
  });
});

describe("admit:准入落盘与拒绝零副作用", () => {
  it("start → 落盘 inflight/conversions/activeBytes", () => {
    const root = newRoot();
    const result = admitOnDisk(root, req({ size: 128 }));
    expect(result.ok).toBe(true);
    expect(result.action).toBe("start");
    expect(result.codes).toEqual(["OFFICEPDF_STARTED"]);
    expect(result.persisted).toBe(true);
    const onDisk = readOfficePdfState(root).state;
    expect(onDisk.conversions).toBe(1);
    expect(onDisk.activeBytes).toBe(128);
    expect(Object.keys(onDisk.inflight)).toHaveLength(1);
  });

  it("同 digest 第二次 → JOINED 且 readers 落盘", () => {
    const root = newRoot();
    admitOnDisk(root, req({ id: "r1" }));
    const second = admitOnDisk(root, req({ id: "r2" }));
    expect(second.action).toBe("join-inflight");
    expect(second.codes).toEqual(["OFFICEPDF_JOINED"]);
    expect(second.readers).toBe(2);
    const onDisk = readOfficePdfState(root).state;
    expect(Object.values(onDisk.inflight)[0]?.readers).toEqual(["r1", "r2"]);
  });

  it("拒绝不写盘(账本文件都不产生)", () => {
    const root = newRoot();
    const result = admitOnDisk(root, req(), { limits: { maxReaders: 0, maxActiveBytes: 1024, maxConversions: 2, maxQueuedMetadata: 32, backgroundMax: 1 } });
    expect(result.action).toBe("reject");
    expect(result.codes).toEqual(["OFFICEPDF_REJECTED"]);
    expect(result.ok).toBe(false);
    expect(result.persisted).toBe(false);
    expect(existsSync(officePdfPaths(root).file)).toBe(false);
  });

  it("dispose 之后 admit → DISPOSED 拒绝", () => {
    const root = newRoot();
    expect(disposeOnDisk(root).ok).toBe(true);
    const result = admitOnDisk(root, req());
    expect(result.action).toBe("reject");
    expect(result.codes).toEqual(["OFFICEPDF_DISPOSED"]);
  });
});

describe("complete / cancel / evict 全流程(假转换器)", () => {
  it("假转换器产出真 PDF 文件 → READY,之后同内容 REUSED", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req({ size: 11 }));
    expect(started.key).toBeDefined();
    const done = completeOnDisk(root, { key: started.key ?? "", converter: stubConverter, now: T0 + 1 });
    expect(done.ok).toBe(true);
    expect(done.codes).toEqual(["OFFICEPDF_READY"]);
    expect(done.entry?.status).toBe("ready");
    const outFile = done.entry?.path ?? "";
    expect(outFile.startsWith(officePdfPaths(root).outDir)).toBe(true);
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, "utf8").startsWith("%PDF-1.4")).toBe(true);
    expect(done.summary["inflight"]).toBe(0);
    expect(done.summary["conversions"]).toBe(0);
    expect(done.summary["activeBytes"]).toBe(0);
    const again = admitOnDisk(root, req({ id: "r2", now: T0 + 5 }));
    expect(again.codes).toEqual(["OFFICEPDF_REUSED"]);
    expect(again.readers).toBe(0);
  });

  it("假转换器写出的字节被 stat 为真,size 与账本一致", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req());
    const done = completeOnDisk(root, { key: started.key ?? "", converter: stubConverter });
    const onDisk = readOfficePdfState(root).state;
    const entry = Object.values(onDisk.cache)[0];
    expect(entry?.status).toBe("ready");
    expect(entry?.size).toBe(readFileSync(entry?.path ?? "", "utf8").length);
    expect(done.ok).toBe(true);
  });

  it("坏产物(head 被覆盖)→ INVALID_OUTPUT,退额度且不入缓存", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req({ size: 11 }));
    const bad = completeOnDisk(root, { key: started.key ?? "", converter: stubConverter, head: "PK\u0003\u0004", now: T0 + 1 });
    expect(bad.ok).toBe(false);
    expect(bad.codes).toEqual(["OFFICEPDF_INVALID_OUTPUT"]);
    const onDisk = readOfficePdfState(root).state;
    expect(onDisk.cache).toEqual({});
    expect(onDisk.inflight).toEqual({});
    expect(onDisk.conversions).toBe(0);
    expect(onDisk.activeBytes).toBe(0);
    expect(isOfficePdfRejection(bad.codes[0] ?? "")).toBe(true);
  });

  it("转换器失败 → 也走 INVALID_OUTPUT 并把错误带进 reasons", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req());
    const failing: Converter = () => ({ ok: false, error: "soffice: not found" });
    const done = completeOnDisk(root, { key: started.key ?? "", converter: failing });
    expect(done.codes).toEqual(["OFFICEPDF_INVALID_OUTPUT"]);
    expect((done.detail?.["reasons"] as string[]).includes("soffice: not found")).toBe(true);
    expect(readOfficePdfState(root).state.inflight).toEqual({});
  });

  it("key 不在 inflight → INVALID 且不写盘", () => {
    const root = newRoot();
    const done = completeOnDisk(root, { key: "lo-1::docx::nope", converter: stubConverter });
    expect(done.ok).toBe(false);
    expect(done.codes).toEqual(["OFFICEPDF_INVALID"]);
    expect(existsSync(officePdfPaths(root).file)).toBe(false);
  });

  it("complete 带 name+sourceVersion → alias 落盘,可被 reuse", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req({ name: "/docs/a.docx", sourceVersion: "100:1" }));
    const done = completeOnDisk(root, { key: started.key ?? "", converter: stubConverter, sourceVersion: "100:1", name: "/docs/a.docx" });
    expect(done.ok).toBe(true);
    expect(readOfficePdfState(root).state.aliases["100:1\u0000/docs/a.docx"]).toBe(started.key);
    const reused = admitOnDisk(root, req({ id: "r2", name: "/docs/a.docx", sourceVersion: "100:1" }));
    expect(reused.codes).toEqual(["OFFICEPDF_REUSED"]);
  });

  it("源版本变化 → SOURCE_CHANGED,旧缓存保留", () => {
    const root = newRoot();
    const first = admitOnDisk(root, req({ id: "r1", bytes: "v1", name: "/docs/a.docx", sourceVersion: "5:1", size: 2 }));
    completeOnDisk(root, { key: first.key ?? "", converter: stubConverter, sourceVersion: "5:1", name: "/docs/a.docx" });
    const changed = admitOnDisk(root, req({ id: "r2", bytes: "v2-changed", name: "/docs/a.docx", sourceVersion: "9:2", size: 10 }));
    expect(changed.action).toBe("start");
    expect(changed.codes).toContain("OFFICEPDF_SOURCE_CHANGED");
    expect(isOfficePdfRejection("OFFICEPDF_SOURCE_CHANGED")).toBe(true);
    expect(Object.values(readOfficePdfState(root).state.cache).filter((entry) => entry.status === "ready")).toHaveLength(1);
  });

  it("cancel:撤一个读者不作废,撤最后一个 → CANCELLED 且退额度", () => {
    const root = newRoot();
    admitOnDisk(root, req({ id: "r1", size: 64 }));
    admitOnDisk(root, req({ id: "r2" }));
    const one = cancelOnDisk(root, { id: "r1" });
    expect(one.ok).toBe(true);
    expect(one.detail?.["aborted"]).toBe(false);
    expect(readOfficePdfState(root).state.conversions).toBe(1);
    const last = cancelOnDisk(root, { id: "r2" });
    expect(last.codes).toEqual(["OFFICEPDF_CANCELLED"]);
    expect(last.detail?.["aborted"]).toBe(true);
    const onDisk = readOfficePdfState(root).state;
    expect(onDisk.inflight).toEqual({});
    expect(onDisk.activeBytes).toBe(0);
  });

  it("evict:超上限淘汰最旧,alias 一并剔除", () => {
    const root = newRoot();
    for (const [id, bytes, now] of [["a", "A", T0], ["b", "B", T0 + 100]] as const) {
      const started = admitOnDisk(root, req({ id, bytes, size: 1, now, name: `/${id}.docx`, sourceVersion: `${now}:1` }));
      completeOnDisk(root, { key: started.key ?? "", converter: stubConverter, now: now + 1, name: `/${id}.docx`, sourceVersion: `${now}:1` });
    }
    expect(Object.keys(readOfficePdfState(root).state.cache)).toHaveLength(2);
    const evicted = evictOnDisk(root, { maxEntries: 1, now: T0 + 200 });
    expect(evicted.codes).toEqual(["OFFICEPDF_EVICTED"]);
    expect(Object.keys(readOfficePdfState(root).state.cache)).toHaveLength(1);
    expect(Object.keys(readOfficePdfState(root).state.aliases)).toHaveLength(1);
  });

  it("dispose:清 inflight/queue,交回读者名单", () => {
    const root = newRoot();
    admitOnDisk(root, req({ id: "r1" }));
    admitOnDisk(root, req({ id: "r2" }));
    const disposed = disposeOnDisk(root);
    expect(disposed.codes).toEqual(["OFFICEPDF_DISPOSED"]);
    expect(disposed.detail?.["unavailable"]).toEqual(["r1", "r2"]);
    const onDisk = readOfficePdfState(root).state;
    expect(onDisk.disposed).toBe(true);
    expect(onDisk.inflight).toEqual({});
    expect(onDisk.conversions).toBe(0);
  });
});

describe("报告与拒绝码表", () => {
  it("report 汇总 cache/inflight/queue 与摘要", () => {
    const root = newRoot();
    const started = admitOnDisk(root, req({ id: "r1", size: 11 }));
    completeOnDisk(root, { key: started.key ?? "", converter: stubConverter, now: T0 + 1 });
    admitOnDisk(root, req({ id: "r2", bytes: "second", now: T0 + 2 }));
    const report = reportOfficePdf(root);
    expect(report.ok).toBe(true);
    expect(report.file).toBe(officePdfPaths(root).file);
    expect(report.summary["cache"]).toBe(1);
    expect(report.summary["inflight"]).toBe(1);
    expect(report.cache).toHaveLength(1);
    expect(report.cache[0]?.status).toBe("ready");
    expect(report.inflight[0]?.readers).toBe(1);
  });

  it("report 对坏账本 ok=false 且带 STORE_ERROR", () => {
    const root = newRoot();
    const paths = officePdfPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.file, "[]", "utf8");
    const report = reportOfficePdf(root);
    expect(report.ok).toBe(false);
    expect(report.codes).toContain("OFFICEPDF_STORE_ERROR");
  });

  it("拒绝码表覆盖三类业务拒绝", () => {
    expect([...OFFICEPDF_REJECTION_CODES]).toEqual(["OFFICEPDF_REJECTED", "OFFICEPDF_INVALID_OUTPUT", "OFFICEPDF_SOURCE_CHANGED"]);
    expect(isOfficePdfRejection("OFFICEPDF_READY")).toBe(false);
  });

  it("空账本 report 全零", () => {
    const root = newRoot();
    const report = reportOfficePdf(root);
    expect(report.ok).toBe(true);
    expect(report.exists).toBe(false);
    expect(report.summary).toMatchObject({ cache: 0, inflight: 0, queue: 0, conversions: 0, activeBytes: 0 });
  });
});
