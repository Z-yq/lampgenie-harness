import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runTaskCloseout, type CloseoutEvent, type CloseoutJournal } from "../src/task-closeout.js";
import { RESIDUAL_CODES, residualFindings, residualVerdict } from "../src/closeout-residual.js";

const WIRING = readFileSync(new URL("../src/agent-wiring.ts", import.meta.url), "utf8");
const CLOSEOUT = readFileSync(new URL("../src/task-closeout.ts", import.meta.url), "utf8");

/** 假 journal:记录 append,读取走内存数组(纯路径,零 IO)。 */
function fakeJournal(): CloseoutJournal & { events: CloseoutEvent[] } {
  const events: CloseoutEvent[] = [];
  return {
    events,
    append(e: { kind: string; sessionId: string; payload?: unknown; idempotencyKey?: string }) {
      events.push({ kind: e.kind, sessionId: e.sessionId, payload: e.payload } as CloseoutEvent);
      return events.length;
    },
    readAll() {
      return events;
    },
    readSession() {
      return events;
    },
  };
}

const hit = { file: "src/demo.ts", line: 3, text: "demoFlag" };

describe("closeout-residual 接线(源码断言 + 纯路径探针)", () => {
  it("agent-wiring:surface 任务收尾前用 scanSurface 重扫概念(非 surface 直接返回)", () => {
    expect(WIRING).toContain("scanSurface(taskRoot, concepts)");
    expect(WIRING).toContain('scope !== "surface"');
    expect(WIRING).toContain("residual: residualFact");
    expect(WIRING).toContain("readChangeSurfaceManifest(journal, task.sessionId, task.id)");
  });

  it("agent-wiring:扫描失败显式标 SCAN_UNAVAILABLE 且不阻塞", () => {
    expect(WIRING).toContain('code: "SCAN_UNAVAILABLE"');
    expect(WIRING).toContain("不阻塞收尾");
  });

  it("task-closeout:CloseoutStep 含 residual,hardFail kind 含 residual", () => {
    expect(CLOSEOUT).toContain('"residual"');
    expect(CLOSEOUT).toContain('kind: "verify" | "citation" | "completion" | "residual"');
    expect(CLOSEOUT).toContain('has("residual") && input.changeFacts?.residual');
  });

  it("探针 A:无残留 → OK / verdict 全空", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [] });
    expect(r.code).toBe("OK");
    expect(residualVerdict({ findings: r.findings, mode: "warn" })).toEqual({ warn: false, hardFail: false, mark: "", text: "" });
  });

  it("探针 B:命中未解释 → RESIDUAL_HITS", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [], hits: [hit] });
    expect(r.code).toBe("RESIDUAL_HITS");
    expect(r.counts.hits).toBe(1);
  });

  it("探针 C:allowed/explained 命中被跳过 → OK", () => {
    const r = residualFindings({
      concept: "demoFlag",
      manifest: [],
      hits: [{ ...hit, allowed: true }, { file: "src/legacy.ts", line: 1, text: "demoFlag", explained: "兼容旧配置" }],
    });
    expect(r.code).toBe("OK");
  });

  it("探针 D:清单 target 占位 → UNRESOLVED_ENTRY", () => {
    const r = residualFindings({ concept: "demoFlag", manifest: [{ id: "e1", action: "rename", target: "待定", status: "done" }], hits: [] });
    expect(r.code).toBe("UNRESOLVED_ENTRY");
    expect(r.findings[0]).toMatchObject({ kind: "unresolved", entryId: "e1" });
  });

  it("探针 E:closeout warn 模式只挂警告,任务不 hardFail", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["residual"],
      modes: { change: "warn" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { concept: "demoFlag", manifest: [], hits: [hit], rescanAt: 1 } },
    });
    expect(res.hardFail).toBeUndefined();
    expect(res.report.residual).toMatchObject({ code: "RESIDUAL_HITS", hits: 1, unresolved: 0, warn: true, hardFail: false });
    expect(res.finalText).toContain("## 残留审计");
    expect(res.finalText).toContain("⚠ 残留");
  });

  it("探针 F:closeout hard 模式 → hardFail kind=residual 且 reason 点名条数", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["residual"],
      modes: { change: "hard" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { concept: "demoFlag", manifest: [{ id: "e1", action: "replace", target: "", status: "done" }], hits: [hit], rescanAt: 1 } },
    });
    expect(res.hardFail?.kind).toBe("residual");
    expect(res.hardFail?.reason).toContain("命中未解释 1 条");
    expect(res.hardFail?.reason).toContain("清单未收口 1 条");
    expect(res.report.residual).toMatchObject({ code: "RESIDUAL_HITS", hardFail: true });
  });

  it("探针 G:扫描失败(SCAN_UNAVAILABLE)不阻塞、不判定", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["residual"],
      modes: { change: "hard" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { code: "SCAN_UNAVAILABLE", concept: "demoFlag", manifest: [], hits: [], rescanAt: 1 } },
    });
    expect(res.hardFail).toBeUndefined();
    expect(res.report.residual).toMatchObject({ code: "SCAN_UNAVAILABLE", warn: false, hardFail: false });
    expect(res.finalText).toContain("重扫不可用");
    expect(RESIDUAL_CODES).toContain("SCAN_UNAVAILABLE");
  });

  it("旧任务(无 changeFacts.residual)零变化:不跑、不加文本、report 无 residual", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["residual"],
      modes: { change: "hard" },
    });
    expect(res.hardFail).toBeUndefined();
    expect(res.report.residual).toBeUndefined();
    expect(res.finalText).toBe("done");
  });

  it("changeAudit=off 时 residual 段不进步骤(即便 residual 事实在场)", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["m107"],
      modes: { change: "off" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { concept: "demoFlag", manifest: [], hits: [hit], rescanAt: 1 } },
    });
    expect(res.hardFail).toBeUndefined();
    expect(res.report.residual).toBeUndefined();
  });

  it("changeAudit 开启时 main 步骤列表自动含 residual(显式 steps 不含也会补)", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["m107"],
      modes: { change: "warn" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { concept: "demoFlag", manifest: [], hits: [hit], rescanAt: 1 } },
    });
    expect(res.report.residual).toMatchObject({ code: "RESIDUAL_HITS", warn: true });
    expect(journal.events.some((e) => (e.payload as { type?: string }).type === "residual.audit")).toBe(true);
  });

  it("OK 残留(干净)时 closeout 不追加任何残留文本", async () => {
    const journal = fakeJournal();
    const res = await runTaskCloseout({
      journal, sessionId: "s1", taskId: "t1", root: "/tmp", taskStartSeq: 0,
      state: "done", finalText: "done", mode: "main", steps: ["residual"],
      modes: { change: "warn" },
      changeFacts: { scope: "surface", manifest: true, auditPassed: true, verified: true, negativeAssertions: 1, residual: { concept: "demoFlag", manifest: [], hits: [], rescanAt: 1 } },
    });
    expect(res.report.residual).toMatchObject({ code: "OK", warn: false, hardFail: false });
    expect(res.finalText).toBe("done");
  });
});
