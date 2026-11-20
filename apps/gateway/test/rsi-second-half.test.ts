/**
 * · rsi-second-half(后半句零水流修复)测试:
 * 六分项逐个 + flush 集成;夹具全部临时目录,幂等(二次 flush 不重复落盘)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  incubateFromJournal,
  linkEvidenceFromCandidates,
  recordIncrementalSavings,
  runSecondHalfFlush,
  seedPromptBookV2,
  signatureOfCommand,
} from "../src/rsi-second-half.js";
import { addEvidence, loadEvidenceGraph } from "../src/evidence-graph-store.js";
import { listCandidates } from "../src/tool-foundry-store.js";
import { listUpgrades } from "../src/tool-upgrade-store.js";
import { loadBook } from "../src/prompt-version-store.js";
import { loadCostProjection } from "../src/rsi-cost-store.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rsi-second-half-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeFile(rel: string, text: string): Promise<void> {
  const file = join(root, rel);
  return mkdir(dirname(file), { recursive: true }).then(() => fsWriteFile(file, text, "utf-8"));
}

/** journal 会话夹具:terminal send 命令 + ok 回执。 */
function sessionFile(sid: string, commands: string[], ok = true): string {
  const lines: string[] = [];
  commands.forEach((command, i) => {
    const callId = `c${i}`;
    lines.push(JSON.stringify({
      kind: "tool.call",
      sessionId: sid,
      payload: { toolCallId: callId, name: "terminal", arguments: JSON.stringify({ action: "send", command }) },
    }));
    lines.push(JSON.stringify({
      kind: "tool.result",
      sessionId: sid,
      payload: { toolCallId: callId, name: "terminal", content: JSON.stringify({ ok }) },
    }));
  });
  return lines.map((line) => `${line}\n`).join("");
}

describe("signatureOfCommand", () => {
  it("路径/文件名/数字/环境赋值归一,取前 8 token", () => {
    expect(signatureOfCommand("cd /a/b/c && PATH=/x node t.ts")).toBe("cd <path> && PATH=… node <file>");
    expect(signatureOfCommand("run 123 45.6 /a/b")).toBe("run <n> <n> <path>");
    const long = Array.from({ length: 12 }, (_, i) => `t${i}`).join(" ");
    expect(signatureOfCommand(long).split(" ")).toHaveLength(8);
  });
});

describe("linkEvidenceFromCandidates(证据边配对)", () => {
  it("候选 evidenceRefs ∩ 图内 anti-pattern(session)→ 对 fact(候选 id)落 supports 边;幂等", async () => {
    await writeFile(".genie/rsi/nightly/queue.jsonl", JSON.stringify({
      queuedAt: "2026-11-19T00:00:00.000Z",
      runId: "ngt-test",
      projectId: "p",
      date: "2026-11-19",
      candidate: { id: "cand-x", kind: "gate", ref: "unresolved-asks", reason: "r", evidenceRefs: ["s1"] },
    }) + "\n");
    addEvidence(root, {
      kind: "fact",
      statement: "测试主张(候选 cand-x)",
      source: { note: "nightly ngt 挖掘" },
      observedAt: 1,
      projectId: "p",
    });
    addEvidence(root, {
      kind: "anti-pattern",
      statement: "会话实证观察",
      source: { note: "session s1" },
      observedAt: 1,
      projectId: "p",
    });
    const now = 1_700_000_000_000;
    const first = linkEvidenceFromCandidates(root, now);
    expect(first.added).toBe(1);
    expect(first.nodes).toBe(0); // 会话 s1 已有节点,不补建
    const { graph } = loadEvidenceGraph(root);
    expect((graph.links ?? []).filter((l) => l.type === "supports")).toHaveLength(1);
    const second = linkEvidenceFromCandidates(root, now + 1000);
    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

describe("incubateFromJournal(foundry 孵化链)", () => {
  const cmd = (n: number) => `cd /repo && NODE_X=1 node /abs/path/run.ts --n ${n}`;

  async function makeSessions(count: number, ok = true): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await writeFile(`.genie/journals/sessions/s${i}.jsonl`, sessionFile(`s${i}`, [cmd(i), cmd(i), cmd(i)], ok));
    }
  }

  it("≥3 会话同签名全成功 → 注册+data 层登记+tool-upgrades 首条+基线钉扎", async () => {
    await makeSessions(3);
    const out = await incubateFromJournal(root, { journalDir: join(root, ".genie", "journals"), now: 1_700_000_000_000 });
    expect(out.observed).toBeGreaterThanOrEqual(3);
    expect(out.registered.length).toBeGreaterThanOrEqual(1);
    expect(out.dataTools.length).toBe(1);
    expect(out.upgrades).toHaveLength(1);
    const names = listUpgrades(root).upgrades.map((entry) => entry.name);
    expect(names.length).toBe(1);
    const registered = listCandidates(root, { status: "registered" });
    expect(registered.length).toBe(1);
  });
  it("negative:单会话(<minSessions=2)不得孵化注册,不落 tool-upgrades", async () => {
    await makeSessions(1);
    const out = await incubateFromJournal(root, { journalDir: join(root, ".genie", "journals"), now: 1_700_000_000_000 });
    expect(out.registered).toHaveLength(0);
    expect(out.upgrades).toHaveLength(0);
    expect(listUpgrades(root).upgrades.map((entry) => entry.name)).toHaveLength(0);
  });
  it("negative:回执全失败(成功率 0<0.8)不得注册", async () => {
    await makeSessions(3, false);
    const out = await incubateFromJournal(root, { journalDir: join(root, ".genie", "journals"), now: 1_700_000_000_000 });
    expect(out.registered).toHaveLength(0);
  });
});

describe("seedPromptBookV2(提示词版本化,行为不变)", () => {
  it("book 由不存在→两 key 各 v2 且 current=1(内置生效);二次幂等", { timeout: 60_000 }, async () => {
    const now = 1_700_000_000_000;
    const first = await seedPromptBookV2(root, { now });
    expect(first.revisions.sort()).toEqual(["system.coding", "system.coding.lite"]);
    const loaded = await loadBook(root);
    for (const key of ["system.coding", "system.coding.lite"]) {
      const history = loaded.book.keys[key];
      expect(history.revisions).toHaveLength(2);
      expect(history.current).toBe(1);
    }
    const second = await seedPromptBookV2(root, { now: now + 1000 });
    expect(second.revisions).toHaveLength(0);
    const reloaded = await loadBook(root);
    expect(reloaded.book.keys["system.coding"].revisions).toHaveLength(2);
  });
});

describe("recordIncrementalSavings(ROI 节省侧)", () => {
  it("水位×单位成本估算入账 1 条,带口径 evidenceRefs;幂等跳过", async () => {
    await writeFile(".genie/rsi/nightly/p/2026-11-19.session-stats.json", JSON.stringify({
      generatedAt: "2026-11-19T00:00:00.000Z", runId: "ngt", projectId: "p", date: "2026-11-19",
      sessions: [{ sessionId: "s1", eventsRead: 1000, eventsSkipped: 5000, tools: {}, repeatedReads: 0, unresolvedAsks: 0, failedSteps: 0, filesEdited: 0 }],
    }));
    await writeFile(".genie/rsi/cost.jsonl", JSON.stringify({
      v: 1, type: "cost", at: "2026-11-19T03:00:00.000Z", id: "c1", cycleId: "cy1",
      stage: "mining", tokens: { input: 1, output: 1, total: 600000 }, wallMs: 1,
    }) + "\n");
    const now = 1_700_000_000_000;
    const first = recordIncrementalSavings(root, { now });
    expect(first.entries).toBe(1);
    expect(first.tokensSaved).toBe(3_000_000);
    const rows = loadCostProjection(root).rows;
    const saving = rows.find((row) => (row as { type?: string }).type === "saving") as { tokensSaved?: number; evidenceRefs?: string[] } | undefined;
    expect(saving?.tokensSaved).toBe(3_000_000);
    expect(saving?.evidenceRefs?.some((ref) => ref.startsWith("method:"))).toBe(true);
    const second = recordIncrementalSavings(root, { now: now + 1000 });
    expect(second.entries).toBe(0);
  });
  it("negative:无水位真源不得写入", async () => {
    const out = recordIncrementalSavings(root, { now: 1 });
    expect(out.entries).toBe(0);
    expect(loadCostProjection(root).rows.filter((row) => (row as { type?: string }).type === "saving")).toHaveLength(0);
  });
});

describe("runSecondHalfFlush(集成)", () => {
  it("五分项一次跑通:边/foundry/决策/prompt/saving 全非零,决策引 experiment id", { timeout: 90_000 }, async () => {
    await writeFile(".genie/rsi/nightly/queue.jsonl", JSON.stringify({
      queuedAt: "2026-11-19T00:00:00.000Z", runId: "ngt", projectId: "p", date: "2026-11-19",
      candidate: { id: "cand-y", kind: "gate", ref: "unresolved-asks", reason: "r", evidenceRefs: ["s0"] },
    }) + "\n");
    addEvidence(root, { kind: "fact", statement: "主张(候选 cand-y)", source: { note: "n" }, observedAt: 1, projectId: "p" });
    addEvidence(root, { kind: "anti-pattern", statement: "观察", source: { note: "session s0" }, observedAt: 1, projectId: "p" });
    for (let i = 0; i < 3; i += 1) {
      await writeFile(`.genie/journals/sessions/s${i}.jsonl`, sessionFile(`s${i}`, [`cd /repo && node /abs/t.ts 7`, `cd /repo && node /abs/t.ts 7`]));
    }
    await writeFile(".genie/experiments/ledger.jsonl", JSON.stringify({
      type: "record", at: Date.now(), v: 1,
      experiment: {
        id: "exp-test-1", schemaVersion: 1,
        hypothesis: { claim: "c", mechanism: "m", expectedEffect: "e" },
        intervention: { surface: "tip", ref: "unresolved-asks", variant: "v" },
        canary: { scope: "session", status: "running" },
        metrics: [{ name: "unresolved-asks-rate", unit: "ratio", kind: "rate", direction: "decrease", baseline: { value: 0.5, sample: 10 }, thresholds: { minSample: 30, minEffectPct: 30 } }],
        rollbackPoint: { kind: "config", ref: "r" },
        decision: { kind: "pending" },
        createdAt: Date.now(), updatedAt: Date.now(),
      },
    }) + "\n");
    await writeFile(".genie/rsi/nightly/p/2026-11-19.session-stats.json", JSON.stringify({
      generatedAt: "2026-11-19T00:00:00.000Z", runId: "ngt", projectId: "p", date: "2026-11-19",
      sessions: [{ sessionId: "s1", eventsRead: 1000, eventsSkipped: 100, tools: {}, repeatedReads: 0, unresolvedAsks: 0, failedSteps: 0, filesEdited: 0 }],
    }));
    await writeFile(".genie/rsi/cost.jsonl", JSON.stringify({
      v: 1, type: "cost", at: "2026-11-19T03:00:00.000Z", id: "c1", cycleId: "cy1",
      stage: "mining", tokens: { input: 1, output: 1, total: 5000 }, wallMs: 1,
    }) + "\n");
    const summary = await runSecondHalfFlush(root, {});
    expect(summary.links.added).toBe(1);
    expect(summary.foundry.registered.length).toBe(1);
    expect(summary.foundry.dataTools.length).toBe(1);
    expect(summary.foundry.upgrades.length).toBe(1);
    expect(summary.promptBook.revisions.length).toBe(2);
    expect(summary.savings.entries).toBe(1);
    expect(summary.decisions.recorded).toBeGreaterThanOrEqual(2); // 实验记账+foundry+prompt 三类 ≥2
    expect(summary.pins).toBe(1);
 // 决策台账引用 experiment id(设计要求:decision 引用 experiment id)。
    const decisions = readFileSync(join(root, ".genie/rsi/decisions.jsonl"), "utf-8");
    expect(decisions).toContain("exp-test-1");
  });
  it("evidenceRef 会话不在图内 → 补会话级观察节点再落边(上游字段补齐)", async () => {
    await writeFile(".genie/rsi/nightly/queue.jsonl", JSON.stringify({
      queuedAt: "2026-11-19T00:00:00.000Z", runId: "ngt", projectId: "p", date: "2026-11-19",
      candidate: { id: "cand-z", kind: "gate", ref: "unresolved-asks", reason: "悬空提问", evidenceRefs: ["sx"] },
    }) + "\n");
    addEvidence(root, { kind: "fact", statement: "主张(候选 cand-z)", source: { note: "n" }, observedAt: 1, projectId: "p" });
    const out = linkEvidenceFromCandidates(root, 1_700_000_000_000);
    expect(out.nodes).toBe(1);
    expect(out.added).toBe(1);
    const { graph } = loadEvidenceGraph(root);
    expect((graph.links ?? []).filter((l) => l.type === "supports")).toHaveLength(1);
  });
});
