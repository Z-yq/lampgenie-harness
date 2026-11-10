/**
 * 公共收尾聚合(M5/M16/M23/M107/M169/M170)纯单元测试:
 * 六项有无数据 / na 不追加 / sub·super warn-only / 去重 / 段长 ≤1200。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCloseoutSection, runTaskCloseout } from "../src/task-closeout.js";
import { buildCompletionAudit, type CompletionItem } from "../src/completion-audit.js";

interface Ev { seq: number; kind: string; sessionId?: string; payload?: unknown }

function fakeJournal(seed: Ev[] = []) {
  const events: Ev[] = [...seed];
  const appended: { type?: string; sessionId: string }[] = [];
  const j = {
    appended,
    append(e: { kind: string; sessionId: string; payload?: unknown }) {
      const p = (e.payload ?? {}) as { type?: string };
      events.push({ seq: events.length + 1, kind: e.kind, sessionId: e.sessionId, payload: e.payload });
      appended.push({ type: p.type, sessionId: e.sessionId });
      return undefined;
    },
    readAll() { return events; },
    readSession(sid: string, since = 0) {
      return events.filter((e) => e.sessionId === sid && e.seq >= since);
    },
  };
  return j;
}

const SID = "s1";
const TID = "t1";

function writeEvent(file: string): Ev {
  return {
    seq: 1, kind: "tool.call", sessionId: SID,
    payload: { name: "write_file", arguments: JSON.stringify({ path: file, content: "x" }) },
  };
}

describe("task-closeout 纯聚合", () => {
  it("subagent:warn-only,六机制各落一次;verify stale 追加警告 + 「## 收尾审计」", async () => {
    const dir = mkdtempSync(join(tmpdir(), "closeout-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "export const a = 1;");
    const j = fakeJournal([writeEvent(file)]);
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: dir,
      taskStartSeq: 1, state: "done", finalText: "做完了",
      instruction: "调研并改代码", taskClass: "qa", mode: "subagent",
      baseline: { mode: "non-git", files: {} } as never,
    });
    expect(r.hardFail).toBeUndefined();
    expect(r.appendedEvents).toEqual(expect.arrayContaining([
      "turn.change-ledger", "guidance.metrics", "verify.ledger", "citation.audit", "completion.audit",
    ]));
    expect(r.report.changeLedger?.changed.length).toBe(1);
    expect(r.finalText).toContain("[验证账本]");
    expect(r.finalText).toContain("## 收尾审计");
  });

  it("全 na → 不追加任何文本(噪音控制)", async () => {
    const j = fakeJournal();
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: tmpdir(),
      taskStartSeq: 1, state: "done", finalText: "ok", mode: "subagent",
    });
    expect(r.finalText).toBe("ok");
    expect(r.report.completion?.items.every((i) => i.status === "na")).toBe(true);
    expect(r.appendedEvents).toEqual(expect.arrayContaining(["guidance.metrics", "verify.ledger", "completion.audit"]));
  });

  it("同一 journal+task 二次调用不重复落事件(去重)", async () => {
    const j = fakeJournal();
    const input = {
      journal: j as never, sessionId: SID, taskId: TID, root: tmpdir(),
      taskStartSeq: 1, state: "done" as const, finalText: "ok", mode: "subagent" as const,
    };
    await runTaskCloseout(input);
    const second = await runTaskCloseout(input);
    expect(second.appendedEvents).toEqual([]);
  });

  it("main hard verify:补跑仍 stale → hardFail + hard-fail 事件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "closeout-h-"));
    const file = join(dir, "b.ts");
    writeFileSync(file, "export const b = 1;");
    const j = fakeJournal([writeEvent(file)]);
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: dir,
      taskStartSeq: 1, state: "done", finalText: "ok", mode: "main",
      modes: { verify: "hard" },
      retryTurn: async () => null,
    });
    expect(r.hardFail?.kind).toBe("verify");
    expect(r.appendedEvents).toContain("verify.ledger.retry");
    expect(r.appendedEvents).toContain("verify.ledger.hard-fail");
  });

  it("main hard completion:P0 未满 → hardFail(不静默 done)", async () => {
    const j = fakeJournal();
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: tmpdir(),
      taskStartSeq: 1, state: "done", finalText: "ok", mode: "main",
      modes: { completion: "hard" },
      boardFacts: { hasBoard: true, p0Total: 2, p0Passed: 1, staleEvidence: 0, hasNegativeAccept: true },
      retryTurn: async () => null,
    });
    expect(r.hardFail?.kind).toBe("completion");
    expect(r.appendedEvents).toContain("completion.audit.hard-fail");
  });

  it("M170:声明交付物 → 追加「## 交付物」;声明后缺失 → 点名 + 警告", async () => {
    const dir = mkdtempSync(join(tmpdir(), "closeout-d-"));
    const good = join(dir, "report.md");
    writeFileSync(good, "# ok");
    const missing = join(dir, "gone.md");
    const j = fakeJournal([
      { seq: 1, kind: "custom", sessionId: SID, payload: { type: "deliverable.declared", taskId: TID, inputPath: "report.md", processPath: good, size: 4, mtimeMs: 1, at: 1 } },
      { seq: 2, kind: "custom", sessionId: SID, payload: { type: "deliverable.declared", taskId: TID, inputPath: "gone.md", processPath: missing, size: 4, mtimeMs: 1, at: 2 } },
    ]);
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: dir,
      taskStartSeq: 1, state: "done", finalText: "ok", mode: "subagent",
      steps: ["m170", "m5"],
    });
    expect(r.finalText).toContain("## 交付物");
    expect(r.finalText).toContain("缺失");
    expect(r.appendedEvents).toContain("deliverable.verified");
    expect(r.report.deliverables?.checked.filter((d) => !d.ok).length).toBe(1);
  });

  it("main warn 引用缺登记 → 追加警告,不 hardFail", async () => {
    const j = fakeJournal();
    const r = await runTaskCloseout({
      journal: j as never, sessionId: SID, taskId: TID, root: tmpdir(),
      taskStartSeq: 1, state: "done", finalText: "见 [1]", taskClass: "qa", mode: "main",
      modes: { citation: "warn" },
    });
    expect(r.hardFail).toBeUndefined();
    expect(r.finalText).toContain("[引用账本]");
    expect(r.appendedEvents).toContain("citation.audit");
  });

  it("renderCloseoutSection:只列非 na 项且总长 ≤1200", () => {
    const items: CompletionItem[] = ["board", "verify", "deliverable", "change", "citation", "change-ledger"].map((id) => ({
      id: id as CompletionItem["id"], status: "warn", label: id, detail: "x".repeat(300),
    }));
    const section = renderCloseoutSection({ passed: true, warnings: 6, fails: 0, items, rendered: "" });
    expect(section.startsWith("## 收尾审计")).toBe(true);
    expect(section.length).toBeLessThanOrEqual(1200);
    expect(renderCloseoutSection(buildCompletionAudit({}))).toBe("");
  });
});
