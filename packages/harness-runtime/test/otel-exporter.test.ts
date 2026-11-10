/**
 * OTLP/HTTP JSON 导出器专项(遗留:OTel/远端上报)。
 * 锚定:opt-in 装配、span 区间闭合、批量外送、fail-soft。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { createOtelExporter, otelExporterFromEnv } from "../src/agent/otel-exporter";

describe("otel-exporter", () => {
  it("未配端点:env 装配返回 undefined(零开销)", () => {
    expect(otelExporterFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("journal 事件→span 区间闭合,flush 外送 OTLP JSON", async () => {
    const bodies: unknown[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: (async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }) as typeof fetch,
      now: (() => { let t = 1000; return () => (t += 10); })(),
    });
    const journal = new MemoryJournal();
    const detach = exporter.attach(journal);
    journal.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 } });
    journal.append({ kind: "step.start", sessionId: "s1", payload: { turn: 1, step: 0 } });
    journal.append({ kind: "message.agent", sessionId: "s1", payload: { text: "x", turn: 1, step: 0, llmMs: 120, ttftMs: 40, usage: { inputTokens: 10, outputTokens: 20 } } });
    journal.append({ kind: "step.end", sessionId: "s1", payload: { turn: 1, step: 0, reason: "completed" } });
    journal.append({ kind: "turn.end", sessionId: "s1", payload: { turn: 1, reason: "completed" } });
    detach();
    await exporter.flush();
    expect(bodies).toHaveLength(1);
    const span = (bodies[0] as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string }[]; startTimeUnixNano: string; endTimeUnixNano: string }[] }[] }[] });
    const names = span.resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name);
    expect(names).toContain("agent.turn");
    expect(names).toContain("agent.step");
    expect(names).toContain("llm.chat");
    const llm = span.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === "llm.chat")!;
    const keys = llm.attributes.map((a) => a.key);
    expect(keys).toContain("genie.ttftMs");
    // start < end(llmMs=120 → 120000ns 差)
    expect(BigInt(llm.endTimeUnixNano) - BigInt(llm.startTimeUnixNano)).toBe(120n * 1000000n);
    expect(exporter.stats().spans).toBe(3); // turn+step+llm 三个 span 全部外送成功
    exporter.stop();
  });

  it("端点不可达:fail-soft 计 failures,不抛", async () => {
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: (async () => { throw new Error("conn refused"); }) as typeof fetch,
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "turn.start", sessionId: "s1", payload: { turn: 1 } });
    await exporter.flush();
    expect(exporter.stats().failures).toBeGreaterThan(0);
    expect(exporter.stats().pending).toBeGreaterThan(0); // 留待下轮
    exporter.stop();
  });

  it("工具错误:span status code=2", async () => {
    const bodies: unknown[] = [];
    const exporter = createOtelExporter({
      endpoint: "http://otel.test/v1/traces",
      fetchImpl: (async (_u, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    const journal = new MemoryJournal();
    exporter.attach(journal);
    journal.append({ kind: "tool.call", sessionId: "s1", payload: { toolCallId: "t1", name: "run_cmd", arguments: "{}" } });
    journal.append({ kind: "tool.result", sessionId: "s1", payload: { toolCallId: "t1", name: "run_cmd", content: "错误:boom", durationMs: 5 } });
    await exporter.flush();
    const spans = (bodies[0] as { resourceSpans: { scopeSpans: { spans: { name: string; status: { code: number } }[] }[] }[] }).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.find((s) => s.name === "tool.run_cmd")!.status.code).toBe(2);
    exporter.stop();
  });
});
