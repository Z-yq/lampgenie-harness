/**
 * M81 阶段遥测合同:纯逻辑(注入假时钟保证确定性)+ loop 接线(真 journal + 假 provider)。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Tool } from "../src/agent/loop";
import {
  PhaseRecorder,
  buildTurnTelemetry,
  createTelemetryClock,
  exportTelemetry,
  type ClockReading,
  type PhaseSpan,
  type SpanStatus,
} from "../src/agent/phase-telemetry";

const ORIGIN = 1_700_000_000_000;

/** 假时钟:读数由测试显式推进(createTelemetryClock 只认注入的 now)。 */
function manualClock(start = 0, origin: number = ORIGIN) {
  let t = start;
  return {
    clock: createTelemetryClock({ timeOrigin: origin, now: () => t }),
    advance: (ms: number) => { t += ms; },
    set: (v: number) => { t = v; },
  };
}

function span(name: string, startMono: number, endMono: number, status: SpanStatus = "complete"): PhaseSpan {
  return { name, startMono, endMono, durationMs: Math.max(0, endMono - startMono), status };
}

/** 只读桩 recorder:用于构造 PhaseRecorder 造不出的区间形状(重叠 / 缺阶段 / 指定时钟可信度)。 */
function stubRecorder(
  spans: PhaseSpan[],
  reading: ClockReading = { originMs: ORIGIN, mono: 0, reliable: true },
): PhaseRecorder {
  return {
    spans: () => spans.map((s) => ({ ...s })),
    calibrate: () => reading,
  } as unknown as PhaseRecorder;
}

describe("telemetry clock", () => {
  it("正常时钟:originMs/mono 读数,reliable=true", () => {
    const m = manualClock(0);
    expect(m.clock.calibrate()).toEqual({ originMs: ORIGIN, mono: 0, reliable: true });
    m.advance(12);
    expect(m.clock.now()).toBe(12);
    expect(m.clock.calibrate()).toEqual({ originMs: ORIGIN, mono: 12, reliable: true });
  });

  it("timeOrigin 缺失/0/非有限 → reliable=false", () => {
    expect(createTelemetryClock({ timeOrigin: 0, now: () => 1 }).calibrate().reliable).toBe(false);
    expect(createTelemetryClock({ timeOrigin: Number.NaN, now: () => 1 }).calibrate().reliable).toBe(false);
    expect(createTelemetryClock({ timeOrigin: -1, now: () => 1 }).calibrate().reliable).toBe(false);
    expect(createTelemetryClock({ timeOrigin: Number.POSITIVE_INFINITY, now: () => 1 }).calibrate().reliable).toBe(false);
  });

  it("now 回退或抛错 → reliable 永久 false(实例内不恢复)", () => {
    const m = manualClock(100);
    expect(m.clock.calibrate().reliable).toBe(true);
    m.set(50); // 回退
    expect(m.clock.calibrate().reliable).toBe(false);
    m.set(10_000); // 重新前进也不复活
    expect(m.clock.calibrate().reliable).toBe(false);

    const boom = createTelemetryClock({ timeOrigin: ORIGIN, now: () => { throw new Error("no clock"); } });
    expect(boom.calibrate().reliable).toBe(false);
    expect(boom.now()).toBe(0); // 不回退成负数/NaN
  });

  it("now 返回负数/非有限 → reliable=false", () => {
    expect(createTelemetryClock({ timeOrigin: ORIGIN, now: () => -1 }).calibrate().reliable).toBe(false);
    expect(createTelemetryClock({ timeOrigin: ORIGIN, now: () => Number.NaN }).calibrate().reliable).toBe(false);
  });
});

describe("PhaseRecorder", () => {
  it("嵌套 begin:旧的 unclosed + 新的 overlap;durationMs 正确;重复 end 返回 null", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    const a = rec.begin("llm");
    m.advance(10);
    const b = rec.begin("tools");
    m.advance(5);
    expect(rec.end(b)).toMatchObject({ name: "tools", startMono: 10, endMono: 15, durationMs: 5, status: "overlap" });
    expect(rec.end(a)).toBeNull(); // 已被顶掉,不再产生 span
    const spans = rec.spans();
    expect(spans.map((s) => [s.name, s.status, s.durationMs])).toEqual([
      ["llm", "unclosed", 10],
      ["tools", "overlap", 5],
    ]);
    expect(spans[0]?.originMs).toBe(ORIGIN);
  });

  it("closeAll 把 open span 收口为 interrupted,二次调用返回空", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    rec.begin("tools");
    m.advance(7);
    const closed = rec.closeAll();
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ name: "tools", status: "interrupted", durationMs: 7 });
    expect(rec.closeAll()).toEqual([]);
    expect(rec.closeAll("unclosed")).toEqual([]);
  });

  it("end 缺省 complete;未知 token 不改状态", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    const a = rec.begin("llm");
    m.advance(3);
    expect(rec.end({ id: 999, name: "ghost", startMono: 0 })).toBeNull();
    expect(rec.end(a)).toMatchObject({ status: "complete", durationMs: 3 });
    expect(rec.end(a)).toBeNull();
    expect(rec.spans()).toHaveLength(1);
  });

  it("end(token,'interrupted') 显式标记中断", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    const a = rec.begin("llm");
    m.advance(4);
    expect(rec.end(a, "interrupted")?.status).toBe("interrupted");
  });
});

describe("buildTurnTelemetry", () => {
  it("不重叠:union=sum,unattributed=total-union,quality complete", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    const t1 = rec.begin("llm");
    m.advance(100);
    rec.end(t1);
    const t2 = rec.begin("tools");
    m.advance(50);
    rec.end(t2);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 200 });
    expect(tm.spans.map((s) => s.name)).toEqual(["llm", "tools"]);
    expect(tm.unionMs).toBe(150);
    expect(tm.unattributedMs).toBe(50);
    expect(tm.quality).toBe("complete");
    expect(tm.expectedMissing).toEqual([]);
    expect(typeof tm.at).toBe("number");
  });

  it("重叠区间取并集(重叠只算一次)", () => {
    const rec = stubRecorder([span("llm", 0, 100), span("tools", 50, 150)]);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 300, now: 200 });
    expect(tm.unionMs).toBe(150); // 逐条相加会是 200
    expect(tm.unattributedMs).toBe(150);
  });

  it("时钟不可靠:quality=clock_invalid 且 unattributedMs===null(不钳零)", () => {
    const m = manualClock(0, 0); // timeOrigin=0 → 不可靠
    const rec = new PhaseRecorder(m.clock);
    const t = rec.begin("llm");
    m.advance(10);
    rec.end(t);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 100 });
    expect(tm.quality).toBe("clock_invalid");
    expect(tm.unattributedMs).toBeNull();
    expect(tm.unionMs).toBe(10); // 区间本身仍如实给出

    const stub = buildTurnTelemetry({
      recorder: stubRecorder([span("llm", 0, 10)], { originMs: 0, mono: 10, reliable: false }),
      totalMs: 100,
    });
    expect(stub.quality).toBe("clock_invalid");
    expect(stub.unattributedMs).toBeNull();
  });

  it("跨进程 origin 不一致 → 平移对齐(可信时钟不降级)", () => {
    const rec = stubRecorder([span("llm", 0, 100), { ...span("tools", 100, 150), originMs: ORIGIN - 900 }],
      { originMs: ORIGIN, mono: 150, reliable: true });
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 200, now: 150 });
    expect(tm.unionMs).toBe(150); // tools 平移 +900 后正好接在 llm 之后
    expect(tm.spans.map((s) => s.startMono)).toEqual([0, 1000]);
    expect(tm.quality).toBe("complete");
  });

  it("缺阶段 → expectedMissing 按 expectedPhases 顺序,quality missing", () => {
    const rec = stubRecorder([span("llm", 0, 10)]);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 10, now: 20 });
    expect(tm.expectedMissing).toEqual(["tools"]);
    expect(tm.quality).toBe("missing");

    const none = buildTurnTelemetry({ recorder: stubRecorder([]), totalMs: 0, now: 0, expectedPhases: ["llm", "tools"] });
    expect(none.expectedMissing).toEqual(["llm", "tools"]);
    expect(none.unionMs).toBe(0);
    expect(none.unattributedMs).toBe(0);
  });

  it("TTL 超期 → status expired + quality expired(interrupted 不被覆盖)", () => {
    const m = manualClock(0);
    const rec = new PhaseRecorder(m.clock);
    const t1 = rec.begin("llm");
    m.advance(100);
    rec.end(t1);
    const t2 = rec.begin("tools");
    m.advance(10);
    rec.end(t2);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 110, now: 10_000, ttlMs: 300 });
    expect(tm.spans.map((s) => s.status)).toEqual(["expired", "expired"]);
    expect(tm.quality).toBe("expired");

    const interruptedOnly = stubRecorder([span("llm", 0, 10, "interrupted"), span("tools", 10, 20)]);
    const keep = buildTurnTelemetry({ recorder: interruptedOnly, totalMs: 20, now: 10_000, ttlMs: 300 });
    expect(keep.spans[0]?.status).toBe("interrupted");
    expect(keep.quality).toBe("interrupted");
  });

  it("去重:同 name+区间只算一条(保留首条)", () => {
    const rec = stubRecorder([
      span("llm", 0, 10),
      { ...span("llm", 0, 10), status: "interrupted" },
      span("tools", 10, 20),
    ]);
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20 });
    expect(tm.spans).toHaveLength(2);
    expect(tm.spans[0]?.status).toBe("complete");
    expect(tm.quality).toBe("complete");
  });

  it("ttftMs 仅在 hasContent===true 且有限时保留", () => {
    const rec = stubRecorder([span("llm", 0, 10), span("tools", 10, 20)]);
    const off = buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20, ttftMs: 7, hasContent: false });
    expect("ttftMs" in off).toBe(false);
    const on = buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20, ttftMs: 7, hasContent: true });
    expect(on.ttftMs).toBe(7);
    const bad = buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20, ttftMs: Number.NaN, hasContent: true });
    expect("ttftMs" in bad).toBe(false);
  });

  it("usage 原样透传(不重算不补 0),无则省略字段", () => {
    const rec = stubRecorder([span("llm", 0, 10), span("tools", 10, 20)]);
    const usage = { inputTokens: 10, outputTokens: 5 };
    const tm = buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20, usage, at: 12_345 });
    expect(tm.usage).toBe(usage);
    expect(tm.usage?.totalTokens).toBeUndefined();
    expect(tm.at).toBe(12_345);
    expect("usage" in buildTurnTelemetry({ recorder: rec, totalMs: 20, now: 20 })).toBe(false);
  });

  it("maxSpans 超量丢最旧并记 dropped", () => {
    const spans: PhaseSpan[] = Array.from({ length: 6 }, (_v, i) => span(`p${i}`, i * 10, i * 10 + 5));
    const tm = buildTurnTelemetry({ recorder: stubRecorder(spans), totalMs: 60, now: 60, maxSpans: 2 });
    expect(tm.spans.map((s) => s.name)).toEqual(["p4", "p5"]);
    expect(tm.dropped).toBe(4);
  });
});

describe("exportTelemetry", () => {
  it("11 条 maxSpans=5 → 5 条 dropped=6 且丢最小 startMono", () => {
    const spans: PhaseSpan[] = Array.from({ length: 11 }, (_v, i) => span(`p${i}`, i * 10, i * 10 + 5));
    const out = exportTelemetry(spans, { maxSpans: 5, now: 20 });
    expect(out.spans).toHaveLength(5);
    expect(out.dropped).toBe(6);
    expect(out.expired).toBe(0);
    expect(out.spans.map((s) => s.name)).toEqual(["p6", "p7", "p8", "p9", "p10"]);
    expect(out.spans.map((s) => s.startMono)).toEqual([60, 70, 80, 90, 100]);
    expect(spans).toHaveLength(11);
  });

  it("重复 key 去重保留首条,不修改入参", () => {
    const first = span("llm", 0, 10);
    const dup: PhaseSpan = { ...span("llm", 0, 10), status: "interrupted" };
    const out = exportTelemetry([first, dup], { now: 15 });
    expect(out.spans).toHaveLength(1);
    expect(out.spans[0]?.status).toBe("complete");
    expect(first.status).toBe("complete");
    expect(dup.status).toBe("interrupted");
  });

  it("超 ttl 标 expired 并计数;接受 {spans} 批量形态", () => {
    const old = span("llm", 0, 10);
    const fresh = span("tools", 1000, 1010);
    const out = exportTelemetry({ spans: [old, fresh] }, { now: 1100, ttlMs: 200 });
    expect(out.expired).toBe(1);
    expect(out.spans.find((s) => s.name === "llm")?.status).toBe("expired");
    expect(out.spans.find((s) => s.name === "tools")?.status).toBe("complete");
    expect(old.status).toBe("complete");
    expect(out.spans.map((s) => s.startMono)).toEqual([0, 1000]);
  });
});

const getTime: Tool = {
  name: "getTime",
  description: "获取当前时间",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  async execute() { return "2026-10-10 20:00"; },
};

interface TelemetryPayload {
  what?: string;
  turn?: number;
  spans?: PhaseSpan[];
  unionMs?: number;
  unattributedMs?: number | null;
  quality?: string;
  expectedMissing?: string[];
  usage?: { totalTokens?: number };
  ttftMs?: number;
  dropped?: number;
  at?: number;
}

function telemetryEvents(journal: MemoryJournal): TelemetryPayload[] {
  return journal.readAll()
    .filter((e) => e.kind === "custom" && (e.payload as { what?: unknown }).what === "telemetry.phase")
    .map((e) => e.payload as TelemetryPayload);
}

describe("AgentLoop 接线(M81)", () => {
  it("一轮成功 → 恰 1 条 telemetry.phase,含 llm+tools span、quality complete、usage 透传", async () => {
    let round = 0;
    const llm: LlmProvider = {
      async chat() {
        round += 1;
        if (round === 1) {
          return { content: "我先查一下", toolCalls: [{ id: "call-1", name: "getTime", arguments: "{}" }] };
        }
        return { content: "时间到了", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      },
    };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "s-telemetry", system: "你是助手", llm, tools: [getTime] });
    const out = await loop.runTurn("现在几点?");
    expect(out).toContain("时间到了");

    const events = telemetryEvents(journal);
    expect(events).toHaveLength(1);
    const p = events[0]!;
    expect(p.turn).toBe(1);
    const names = (p.spans ?? []).map((s) => s.name);
    expect(names).toContain("llm");
    expect(names).toContain("tools");
    expect(p.quality).toBe("complete");
    expect(p.expectedMissing).toEqual([]);
    expect(p.usage?.totalTokens).toBe(15);
    expect(typeof p.unattributedMs).toBe("number");
    expect((p.spans ?? []).every((s) => s.status === "complete")).toBe(true);
  });

  it("llm.chat 直接抛出 → 仍落 1 条(含 interrupted),runTurn 照常上抛", async () => {
    const boom: LlmProvider = {
      async chat() { throw new Error("upstream 502"); },
    };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "s-telemetry-fail", system: "你是助手", llm: boom, tools: [getTime] });
    await expect(loop.runTurn("现在几点?")).rejects.toThrow(/upstream 502/);

    const events = telemetryEvents(journal);
    expect(events).toHaveLength(1);
    const p = events[0]!;
    expect((p.spans ?? []).map((s) => s.status)).toContain("interrupted");
    expect(p.quality).not.toBe("complete");
  });
});
