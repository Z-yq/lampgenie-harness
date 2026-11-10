import { describe, it, expect } from "vitest";
import { createAuditLog, assertNoCredential, settleAccept } from "../../src/router/audit.js";
import { TaskSupervisor } from "../../src/task-manager.js";
import { MemoryJournal } from "@lampgenie/core";
import { createRouter } from "../../src/router/index.js";
import { DEFAULT_POLICY_CONFIG } from "../../src/router/policy.js";

describe("router audit:append-only 落账 + 无凭证断言(step-0143 sr8)", () => {
  it("append 追加 jsonl,readAll 回放,行不覆盖(append-only)", async () => {
    const lines: string[] = [];
    const log = createAuditLog("/r/.genie/router/audit.jsonl", {
      mkdirSync: () => {},
      appendFileSync: (_p, data) => { lines.push(data); },
      existsSync: () => false,
      readFileSync: () => lines.join(""),
    });
    log.append({ at: 1, triggerId: "t1", outcome: "dispatched" });
    log.append({ at: 2, triggerId: "t2", outcome: "observed" });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(log.readAll()).toHaveLength(2);
    expect(log.readAll()[1]).toMatchObject({ triggerId: "t2", outcome: "observed" });
  });

  it("无凭证断言:token/secret/apiKey 等字段拒绝写盘(throw,不落行)", async () => {
    expect(() => assertNoCredential({ verificationToken: "x" })).toThrow(/凭证/);
    expect(() => assertNoCredential({ nested: { api_key: "y" } })).toThrow(/凭证/);
    expect(() => assertNoCredential({ encryptKey: "z" })).toThrow(/凭证/);
    expect(() => assertNoCredential({ instruction: "正常内容", sessionId: "s1" })).not.toThrow();
    const lines: string[] = [];
    const log = createAuditLog("/r/.genie/router/audit.jsonl", {
      mkdirSync: () => {},
      appendFileSync: (_p, data) => { lines.push(data); },
      existsSync: () => false,
      readFileSync: () => "",
    });
    expect(() => log.append({ at: 1, triggerId: "t1", outcome: "x", credentialRef: "secret-1" })).toThrow(/凭证/);
    expect(lines).toHaveLength(0); // 未落任何行
  });

  it("accept 决策缺 intent_evidence→返回 ignore 不 throw(闸口)", async () => {
    expect(settleAccept({ decision: "accept" })).toEqual({ kind: "ignore", reason: "missing-intent-evidence" });
    expect(settleAccept({ decision: "accept", intent_evidence: null })).toEqual({ kind: "ignore", reason: "missing-intent-evidence" });
    expect(settleAccept({ decision: "ignore" })).toEqual({ kind: "ignore", reason: "decision-ignore" });
    expect(settleAccept({ decision: "accept", intent_evidence: "用户明确要求修复 README 链接" })).toEqual({ kind: "accept" });
  });

  it("router 全链路:派发+observe 均落 audit.jsonl 且无凭证字段", async () => {
    const tm = new TaskSupervisor();
    const journal = new MemoryJournal();
    const lines: string[] = [];
    const io = {
      mkdirSync: () => {},
      appendFileSync: (_p: string, data: string) => { lines.push(data); },
      existsSync: () => false,
      readFileSync: () => lines.join(""),
    } as const;
    const router = createRouter({ taskManager: tm, journal, root: "/r", io, config: { ...DEFAULT_POLICY_CONFIG } });
    const r1 = await router.submit({ source: "panel", sessionId: "s1", instruction: "写 README", idempotencyKey: "k1" });
    expect(r1.outcome?.kind).toBe("dispatched");
    const r2 = await router.submit({ source: "im", sessionId: "s2", instruction: "顺便看下" }); // inferred→observe
    expect(r2.outcome?.kind).toBe("observed");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).not.toMatch(/token|secret|credential|apikey|encryptkey/i);
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(typeof rec.triggerId).toBe("string");
      expect(typeof rec.outcome).toBe("string");
    }
    const outcomes = lines.map((l) => (JSON.parse(l) as { outcome: string }).outcome);
    expect(outcomes).toContain("dispatched");
    expect(outcomes).toContain("observed");
  });
});
