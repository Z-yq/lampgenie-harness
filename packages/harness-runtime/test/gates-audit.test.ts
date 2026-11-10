/**
 * 单元面:审计日志(append/只增/hash)、凭证红线(自测已过,这里测排除面)、
 * 跑批可复现(同 seed 两跑分差=0)、门禁真实拦截(不达标→红清单;override 留审计)。
 */
import { describe, expect, it } from "vitest";
import { AuditLog, AUDIT_ACTIONS, hashDetail } from "../src/security/audit-log.js";
import { runBatch, loadCases, type BatchBackend, type BatchJudge } from "../src/eval/batch.js";
import { runGates, type GateSpec } from "../src/eval/gates.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("审计日志( §6)", () => {
  it("append 只增+明细只入 hash+可读回", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const log = new AuditLog(join(dir, "audit.jsonl"));
    expect(log.append(
      { actor: { kind: "user", device: "panel" }, action: "config.change", target: { type: "config-key", id: "llm.model" }, result: "ok", source_ip_scope: "lan" },
      { secret: "sk-should-not-appear", applied: ["llm.model"] },
    )).toBe(true);
    const events = log.read();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("config.change");
    expect(events[0]!.detail_hash).toMatch(/^sha256:[0-9a-f]{32}$/);
    // 红线:明细原文绝不在日志里。
    expect(JSON.stringify(events)).not.toContain("should-not-appear");
    // hash 可对账:同明细同 hash。
    expect(hashDetail({ secret: "sk-should-not-appear", applied: ["llm.model"] })).toBe(events[0]!.detail_hash);
    rmSync(dir, { recursive: true, force: true });
  });

  it("live 动作清单与对账脚本一致(枚举漂移即红)", () => {
 // resource.push(同步):team-relay doTeamaiPush 技能推送审计产生点(team-relay.ts)。
    expect([...AUDIT_ACTIONS]).toEqual(["config.change", "member.invite", "resource.push", "roster.merge", "eval.gate-override"]);
  });
});

describe("L3 跑批可复现( §3, D2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "batch-"));
  afterAll2(dir);

  /** 确定性 backend/judge:输出由 input+seed 决定(证机制,真 LLM 方差另测不冒充)。 */
  const backend: BatchBackend = async (input, seed) => `${input.length}-${seed}-ok`;
  const judge: BatchJudge = async (c, output) => ({ score: output.endsWith("ok") ? 80 + (c.seed % 10) : 0 });

  it("同 seed 两跑:结果逐用例相同,均值差=0", async () => {
    const casesDir = join(dir, "cases");
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(join(casesDir, "a.json"), JSON.stringify({ id: "a", version: 1, seed: 42, input: "任务甲" }));
    writeFileSync(join(casesDir, "b.json"), JSON.stringify({ id: "b", version: 1, seed: 43, input: "任务乙" }));
    const cases = loadCases(casesDir);
    expect(cases).toHaveLength(2);

    const r1 = await runBatch(cases, backend, judge, join(dir, "r1"));
    const r2 = await runBatch(cases, backend, judge, join(dir, "r2"));
    expect(r1.results.map((r) => r.score)).toEqual(r2.results.map((r) => r.score));
    expect(Math.abs(r1.mean - r2.mean)).toBe(0);
  });

  it("单用例崩不丢其余(journal-first:失败记 0 分照常汇总)", async () => {
    const badBackend: BatchBackend = async (input) => {
      if (input.includes("乙")) throw new Error("boom");
      return "ok";
    };
    const cases = [
      { id: "a", version: 1, seed: 1, input: "任务甲" },
      { id: "b", version: 1, seed: 2, input: "任务乙" },
    ];
    const r = await runBatch(cases, badBackend, judge, join(dir, "r3"));
    expect(r.results.find((x) => x.caseId === "b")?.score).toBe(0);
    expect(r.results.find((x) => x.caseId === "a")?.score).toBeGreaterThan(0);
  });
});

describe("门禁真实拦截( §4, D5)", () => {
  const spec: GateSpec = {
    name: "test-gate",
    contractRules: [],
    minMean: 70,
    minPerCase: 50,
  };

  it("不达标跑批被拦:红清单含阈值与用例,pass=false", () => {
    const batch = { runId: "r", at: 0, mean: 55, results: [
      { caseId: "a", score: 90 },
      { caseId: "b", score: 20 },
    ] };
    const out = runGates(spec, process.cwd(), batch);
    expect(out.pass).toBe(false);
    expect(out.redList.join(" ")).toContain("55");
    expect(out.redList.join(" ")).toContain("用例 b=20 < 50");
    expect(out.redList.join(" ")).toContain("阈值 70");
  });

  it("达标放行", () => {
    const batch = { runId: "r", at: 0, mean: 85, results: [{ caseId: "a", score: 85 }] };
    expect(runGates(spec, process.cwd(), batch).pass).toBe(true);
  });

  it("override 放行但留 eval.gate-override 审计痕", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const audit = new AuditLog(join(dir, "audit.jsonl"));
    const batch = { runId: "r", at: 0, mean: 10, results: [] };
    const out = runGates(spec, process.cwd(), batch, { override: { reason: "已知回退,豁免 MR!123", actor: "tester" }, audit });
    expect(out.pass).toBe(true);
    expect(out.overridden).toBe(true);
    const events = audit.read();
    expect(events[0]!.action).toBe("eval.gate-override");
    expect(events[0]!.detail_hash).toMatch(/^sha256:/);
    rmSync(dir, { recursive: true, force: true });
  });
});

function afterAll2(dir: string): void {
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
