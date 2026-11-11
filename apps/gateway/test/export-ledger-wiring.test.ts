/**
 *  遥测导出闸门的「装配面」验收(网关侧):
 * ①源码级锚——flush 必须真的调用 copyForExport → redactForExport → ledger.admit 三道闸,
 * 统计出口必须带 dropped*;/spans.splice(0, batch.length) 的旧直送必须消失。
 * 只定义选项不调用=没接线,这类「代码在、生产路径没接」的返工本仓反复出现过。
 * ②行为级——真 exporter + 假 fetch:凭证在出站 payload 里已脱敏;同 spanId 重复只发一次;
 * redactor 抛错 / 超限时一条都不外送(fail-closed),计数进 stats。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryJournal } from "@lampgenie/core";
import { createOtelExporter } from "@lampgenie/runtime/agent/otel-exporter";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");

const EXPORTER_SRC = src("packages/harness-runtime/src/agent/otel-exporter.ts");
const LEDGER_SRC = src("packages/harness-runtime/src/agent/export-ledger.ts");

const SK = "sk-" + "a".repeat(32); // 命中 redactText 的 sk- 规则

type Body = {
  resourceSpans: {
    scopeSpans: {
      spans: { name: string; spanId: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
    }[];
  }[];
};

function fakeFetch(bodies: Body[]): typeof fetch {
  return (async (_u: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

function spansOf(body: Body) {
  return body.resourceSpans[0]!.scopeSpans[0]!.spans;
}

describe("export-ledger-wiring / 源码接线锚", () => {
  it("账本模块导出五项公开面(码表/键/账本/脱敏/拷贝)", () => {
    for (const anchor of [
      "export const EXPORT_CODES",
      "export function dedupeKeyOf",
      "export class ExportLedger",
      "export function redactForExport",
      "export function copyForExport",
    ]) {
      expect(LEDGER_SRC).toContain(anchor);
    }
  });

  it("flush 逐条过闸:构造账本并调用 copy→redact→admit", () => {
    for (const anchor of [
      "new ExportLedger(",
      "copyForExport(",
      "redactForExport(",
      "ledger.admit(dedupeKeyOf(",
      "let outbox: Span[]",
    ]) {
      expect(EXPORTER_SRC).toContain(anchor);
    }
  });

  it("三处丢弃分支都计数,旧直送出队已移除", () => {
    expect(EXPORTER_SRC).toContain("droppedTooLarge += 1");
    expect(EXPORTER_SRC).toContain("droppedDuplicate += 1");
    expect(EXPORTER_SRC).toContain("droppedRedaction += 1");
    expect(EXPORTER_SRC).not.toContain("spans.splice(0, batch.length)");
    expect(EXPORTER_SRC).toContain("outbox = outbox.slice(batch.length)");
  });

  it("stats 保留旧字段并新增三个 dropped 计数", () => {
    for (const field of [
      "spans: exported",
      "failures,",
      "pending: spans.length + outbox.length",
      "droppedRedaction,",
      "droppedTooLarge,",
      "droppedDuplicate,",
    ]) {
      expect(EXPORTER_SRC).toContain(field);
    }
  });
});

describe("export-ledger-wiring / 真 exporter 行为", () => {
  it("含凭证的 span:出站值已脱敏,不含原文", async () => {
    const bodies: Body[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: fakeFetch(bodies),
      now: (() => { let t = 1000; return () => (t += 10); })(),
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: SK, name: "curl" } });
    journal.append({ kind: "tool.result", sessionId: "s1", payload: { toolCallId: SK, content: "ok" } });
    await exporter.flush();
    exporter.stop();

    expect(bodies).toHaveLength(1);
    const span = spansOf(bodies[0]!).find((s) => s.name === "tool.curl")!;
    const idAttr = span.attributes.find((a) => a.key === "genie.toolCallId")!;
    expect(String(idAttr.value.stringValue)).toBe("<redacted:sk>");
    expect(JSON.stringify(bodies[0])).not.toContain(SK);
    expect(exporter.stats().spans).toBe(1);
  });

  it("同 spanId 第二次 → DUPLICATE 丢弃,只发一次", async () => {
    const bodies: Body[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: fakeFetch(bodies),
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "t1", name: "run_cmd" } });
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "t1", name: "run_cmd" } });
    await exporter.flush();
    exporter.stop();

    expect(spansOf(bodies[0]!).filter((s) => s.name === "tool.run_cmd")).toHaveLength(1);
    const stats = exporter.stats();
    expect(stats.spans).toBe(1);
    expect(stats.droppedDuplicate).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("跨 flush 重复:第二次 flush 不再外送同 spanId", async () => {
    const bodies: Body[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: fakeFetch(bodies),
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "t9", name: "grep" } });
    await exporter.flush();
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "t9", name: "grep" } });
    await exporter.flush();
    exporter.stop();

    expect(bodies).toHaveLength(1);
    expect(exporter.stats().droppedDuplicate).toBe(1);
  });

  it("redactor 抛错:该条丢弃,一条都不外送(fail-closed)", async () => {
    const bodies: Body[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: fakeFetch(bodies),
      redactor: () => { throw new Error("redact boom"); },
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 } });
    journal.append({ kind: "turn.end", sessionId: "s1", payload: { turn: 1, reason: "completed" } });
    await exporter.flush();
    exporter.stop();

    expect(bodies).toHaveLength(0); // 绝不回退原记录外送
    const stats = exporter.stats();
    expect(stats.droppedRedaction).toBe(1);
    expect(stats.spans).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.failures).toBe(0); // 不是发送失败,是闸门拒收
  });

  it("超限:maxRecordBytes 极小 → TOO_LARGE 丢弃且不截断外送", async () => {
    const bodies: Body[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: fakeFetch(bodies),
      maxRecordBytes: 8,
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "big", name: "read_file" } });
    await exporter.flush();
    exporter.stop();

    expect(bodies).toHaveLength(0);
    const stats = exporter.stats();
    expect(stats.droppedTooLarge).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.spans).toBe(0);
  });
});
