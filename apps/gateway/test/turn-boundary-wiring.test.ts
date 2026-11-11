/**
 *  接线断言:server.ts 的队列泵在提交前走 injectionVerdict(边界不成立保持排队并把
 * 稳定码写进 queue.update 的可选 boundaryCode);turn.start 观察点落 freezeAdmission;
 * 旧 assertQueueBoundary 作为保守前置保留(旧行为逐字不变)。
 * 为什么用「读源码接线断言」:pumpQueue / queueBroadcast 是 startGatewayServer 内的闭包,
 * 单测拿不到实例;接线一旦漏掉(只写纯逻辑不改 server),纯逻辑测试全绿但线上行为不变。
 * 同时用真实 injectionVerdict 跑纯路径,确认探针 A/B/C/D 在 gateway 依赖口径下成立。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { injectionVerdict, openToolCalls, type BoundaryEvent } from "@lampgenie/runtime/session/turn-boundary";

const serverSrc = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

const SID = "sess-1";
const AT = 1_700_000_000_000;
const ev = (seq: number, kind: string, payload: Record<string, unknown> = {}): BoundaryEvent => ({
  seq,
  kind,
  sessionId: SID,
  time: AT + seq,
  payload,
});

/** 截取 pumpQueue 函数体(从 const pumpQueue 到同缩进的 "};")。 */
function pumpBody(src: string): string {
  const start = src.indexOf("const pumpQueue = (sessionId: string) => {");
  expect(start, "pumpQueue 定义缺失").toBeGreaterThan(-1);
  const rest = src.slice(start);
  const end = rest.indexOf("\n  };");
  return end >= 0 ? rest.slice(0, end + 6) : rest;
}

describe("server.ts 接线:队列泵边界", () => {
  it("泵在提交前用 injectionVerdict(kind=user,带队头 admittedSeq)", () => {
    const pump = pumpBody(serverSrc);
    expect(pump).toContain("injectionVerdict({");
    expect(pump).toContain('kind: "user"');
    expect(pump).toContain("admittedSeq: head.admittedSeq");
    expect(serverSrc).toContain('from "@lampgenie/runtime/session/turn-boundary"');
  });

  it("判定在 promote/submit 之前,且不 OK 时先 return(保留队列)", () => {
    const pump = pumpBody(serverSrc);
    const verdictIdx = pump.indexOf("const verdict = injectionVerdict({");
    const failIdx = pump.indexOf("if (!verdict.ok)");
    const promoteIdx = pump.indexOf("const promoted = inbox.promote(");
    const submitIdx = pump.indexOf("submitQueueItem(item)");
    expect(verdictIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeGreaterThan(verdictIdx);
    expect(promoteIdx).toBeGreaterThan(failIdx);
    expect(submitIdx).toBeGreaterThan(promoteIdx);
 // 失败分支内只广播边界码并 return,不含提交/出队
    const failBlock = pump.slice(failIdx, promoteIdx);
    expect(failBlock).toContain("return;");
    expect(failBlock).not.toContain("submitQueueItem");
    expect(failBlock).not.toContain("inbox.promote");
  });

  it("不成立时把稳定码写进 queue.update 的 boundaryCode(旧客户端忽略)", () => {
    const pump = pumpBody(serverSrc);
    expect(pump).toContain("queueBroadcast(sessionId, verdict.code)");
    expect(serverSrc).toContain("boundaryCode?: string");
    expect(serverSrc).toContain("boundaryCode ? { boundaryCode } : {}");
  });

  it("旧 assertQueueBoundary 前置保留(旧行为/既有接线断言不削弱)", () => {
    expect(serverSrc).toContain("if (!assertQueueBoundary(sessionLastEventKind(sessionId))) return;");
  });

  it("turn.start 观察点落 freezeAdmission(turn 号取自事件)", () => {
    expect(serverSrc).toContain("freezeAdmission({");
    expect(serverSrc).toContain("nextTurnAdmission(events, sid)");
    expect(serverSrc).toContain("readFrozenAdmission(events, sid)");
    expect(serverSrc).toContain('if (e.kind !== "turn.start") return;');
    expect(serverSrc).toContain("(e.payload as { turn?: unknown } | undefined)?.turn");
  });

  it("冻结落账幂等:同 turn+cutoffSeq 不重复 append", () => {
    expect(serverSrc).toContain("existing.turn === turn && existing.cutoffSeq === cutoffSeq");
  });

  it("既有幂等键与出队水位未被改写(旧行为逐字不变)", () => {
    expect(serverSrc).toContain("idempotencyKey: queueItemKey(item.sessionId, item.id)");
    expect(serverSrc).toContain("const cutoff = typeof head.admittedSeq");
  });
});

describe("纯路径:真实 injectionVerdict(gateway 依赖口径)", () => {
  it("探针 A:空账本 user → OK", () => {
    expect(injectionVerdict({ events: [], sessionId: SID, kind: "user" })).toMatchObject({ ok: true, code: "OK" });
  });

  it("探针 B:steer 无 turn.start → TURN_NOT_STARTED", () => {
    expect(injectionVerdict({ events: [], sessionId: SID, kind: "steer" })).toMatchObject({
      ok: false,
      code: "TURN_NOT_STARTED",
    });
  });

  it("探针 C:未配对 tool.call → TOOL_BATCH_OPEN", () => {
    const events = [ev(1, "turn.start", { turn: 1 }), ev(2, "tool.call", { toolCallId: "c1", name: "read_file" })];
    expect(openToolCalls(events, SID)).toEqual(new Set(["c1"]));
    expect(injectionVerdict({ events, sessionId: SID, kind: "user" })).toMatchObject({
      ok: false,
      code: "TOOL_BATCH_OPEN",
    });
  });

  it("探针 D:配对后 → OK", () => {
    const events = [
      ev(1, "turn.start", { turn: 1 }),
      ev(2, "tool.call", { toolCallId: "c1", name: "read_file" }),
      ev(3, "tool.result", { toolCallId: "c1", content: "ok", durationMs: 1 }),
    ];
    expect(injectionVerdict({ events, sessionId: SID, kind: "user" })).toMatchObject({ ok: true, code: "OK" });
  });

  it("探针 F:源码断言 pump 用 injectionVerdict(模块导出与接线同名同源)", () => {
    expect(pumpBody(serverSrc)).toContain("injectionVerdict({");
    expect(typeof injectionVerdict).toBe("function");
  });
});
