/**
 * 后台复盘 fork 持久层(retro-fork-store):临时 root 上跑 tick 计数/触发/四类跳过/深度防递归、
 * 产物幂等键去重、retro-done 复位、report 聚合与坏行容错。只写 os.tmpdir(),绝不碰仓库 .genie。
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETRO_LEDGER_FILE,
  getRetroState,
  loadRetroSession,
  readRetroLedger,
  recordArtifact,
  retroPaths,
  retroReport,
  tick,
} from "../src/retro-fork-store";
import { RETRO_CODES } from "@lampgenie/runtime/agent/retrospective-fork";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-retro-fork-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 台账行(直接读文件,绕开投影)。 */
async function ledgerRows(root: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(retroPaths(root).file, "utf8");
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function seedLines(root: string, lines: string[]): Promise<void> {
  const { dir, file } = retroPaths(root);
  await mkdir(dir, { recursive: true });
  await appendFile(file, `${lines.join("\n")}\n`, "utf8");
}

/** 推到阈值:10 个 user turn。 */
async function tenUserTurns(root: string, sessionId = "s1"): Promise<void> {
  for (let i = 0; i < 10; i += 1) tick(root, { sessionId, event: "user-turn" });
}

describe("计数与触发", () => {
  it("空台账 → 零状态", async () => {
    const root = await tmpRoot();
    expect(loadRetroSession(root, "s1").state).toEqual({ userTurns: 0, toolIterations: 0, retroCount: 0, nudge: 0, depth: 0 });
  });

  it("10 个 user turn 只计不触发,state.userTurns=10", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    const last = tick(root, { sessionId: "s1", event: "user-turn" });
    expect(last.state.userTurns).toBe(11);
    const state = getRetroState(root, "s1");
    expect(state.state.userTurns).toBe(11);
    expect(state.triggers).toBe(0);
  });

  it("10 user turn + final-response → trigger,返回 forkSpec 白名单/deny/depth/nudge", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    const result = tick(root, { sessionId: "s1", event: "final-response" });
    expect(result.ok).toBe(true);
    expect(result.trigger).toBe(true);
    expect(result.codes).toEqual([RETRO_CODES.TRIGGERED, RETRO_CODES.FORK_SPEC]);
    expect(result.forkSpec).toMatchObject({
      tools: ["memory", "skill_view", "read_file", "search", "grep"],
      deny: ["write_file", "edit_file", "terminal", "run_code"],
      detached: true,
      depth: 1,
      nudge: 0,
      sessionId: "s1",
    });
    expect(result.state.depth).toBe(1);
  });

  it("触发落 trigger + fork 两行,fork 规格可回读", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    tick(root, { sessionId: "s1", event: "final-response" });
    const rows = await ledgerRows(root);
    const types = rows.map((row) => row["type"]);
    expect(types.filter((type) => type === "user-turn" || type === "event")).toHaveLength(11);
    expect(types.filter((type) => type === "trigger")).toHaveLength(1);
    expect(types.filter((type) => type === "fork")).toHaveLength(1);
    const forkRow = rows.find((row) => row["type"] === "fork");
    expect((forkRow?.["spec"] as Record<string, unknown>)["depth"]).toBe(1);
  });

  it("10 次 tool iteration + final-response → trigger", async () => {
    const root = await tmpRoot();
    for (let i = 0; i < 10; i += 1) tick(root, { sessionId: "s1", event: "tool-iteration" });
    const result = tick(root, { sessionId: "s1", event: "final-response" });
    expect(result.trigger).toBe(true);
    expect(result.forkSpec?.tools).toContain("read_file");
  });

  it("父上下文给定时 fork 规格继承 tools 交集", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    const result = tick(root, {
      sessionId: "s1",
      event: "final-response",
      parent: { systemPrompt: "sys", tools: ["memory", "read_file", "write_file"], cacheScope: "scope:x", depth: 0 },
    });
    expect(result.forkSpec?.tools).toEqual(["memory", "read_file"]);
    expect(result.forkSpec?.systemPrompt).toBe("sys");
    expect(result.forkSpec?.cacheScope).toBe("scope:x");
  });

  it("interrupt → SKIPPED_INTERRUPTED,不落 trigger", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    const result = tick(root, { sessionId: "s1", event: "interrupt" });
    expect(result.trigger).toBe(false);
    expect(result.codes).toEqual([RETRO_CODES.SKIPPED_INTERRUPTED]);
    expect((await ledgerRows(root)).filter((row) => row["type"] === "trigger")).toHaveLength(0);
  });

  it("cron → SKIPPED_CRON", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    expect(tick(root, { sessionId: "s1", event: "cron" }).codes).toEqual([RETRO_CODES.SKIPPED_CRON]);
  });

  it("nudge>0 → SKIPPED_NUDGE(并落 state 行供恢复)", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    const result = tick(root, { sessionId: "s1", event: "final-response", nudge: 1 });
    expect(result.trigger).toBe(false);
    expect(result.codes).toEqual([RETRO_CODES.SKIPPED_NUDGE]);
    expect(getRetroState(root, "s1").state.nudge).toBe(1);
  });

  it("已 fork 的子会话再次 final-response → SKIPPED_DEPTH,不产第二个 fork", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    tick(root, { sessionId: "s1", event: "final-response" });
    const again = tick(root, { sessionId: "s1", event: "final-response" });
    expect(again.codes).toEqual([RETRO_CODES.SKIPPED_DEPTH]);
    expect((await ledgerRows(root)).filter((row) => row["type"] === "fork")).toHaveLength(1);
  });

  it("非法 sessionId / event → ok=false + RETRO_INVALID,不写行", async () => {
    const root = await tmpRoot();
    const badSession = tick(root, { sessionId: " ", event: "user-turn" });
    expect(badSession.ok).toBe(false);
    expect(badSession.codes).toEqual([RETRO_CODES.INVALID]);
    const badEvent = tick(root, { sessionId: "s1", event: "nope" as unknown as "user-turn" });
    expect(badEvent.ok).toBe(false);
    expect(badEvent.codes).toEqual([RETRO_CODES.INVALID]);
    expect((await readRetroLedger(root)).totalLines).toBe(0);
  });
});

describe("产物与复位", () => {
  it("recordArtifact 写 insight 产物,幂等键 retro:s1:0", async () => {
    const root = await tmpRoot();
    const result = recordArtifact(root, { sessionId: "s1", summary: "复盘:白板应画现状", evidenceRefs: ["ev-9"] });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([RETRO_CODES.ARTIFACT]);
    expect(result.artifact).toMatchObject({
      kind: "insight",
      statement: "复盘:白板应画现状",
      associations: { session: "s1" },
      idempotencyKey: "retro:s1:0",
      evidenceRefs: ["ev-9"],
    });
    const rows = await ledgerRows(root);
    expect(rows.filter((row) => row["type"] === "artifact")).toHaveLength(1);
  });

  it("同幂等键二次写 → ARTIFACT_DUPLICATE 且台账行数不变", async () => {
    const root = await tmpRoot();
    recordArtifact(root, { sessionId: "s1", summary: "同一条洞察" });
    const before = (await ledgerRows(root)).length;
    const again = recordArtifact(root, { sessionId: "s1", summary: "同一条洞察" });
    expect(again.ok).toBe(false);
    expect(again.codes).toEqual([RETRO_CODES.ARTIFACT_DUPLICATE]);
    expect((await ledgerRows(root)).length).toBe(before);
  });

  it("空 summary → RETRO_INVALID 且不落盘", async () => {
    const root = await tmpRoot();
    const result = recordArtifact(root, { sessionId: "s1", summary: "  " });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([RETRO_CODES.INVALID]);
    expect((await readRetroLedger(root)).totalLines).toBe(0);
  });

  it("retro-done 复位计数并 retroCount+1,下一轮产物键变成 retro:s1:1", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root);
    tick(root, { sessionId: "s1", event: "final-response" });
    const done = tick(root, { sessionId: "s1", event: "retro-done" });
    expect(done.ok).toBe(true);
    expect(done.state).toMatchObject({ userTurns: 0, toolIterations: 0, retroCount: 1, depth: 1 });
    const artifact = recordArtifact(root, { sessionId: "s1", summary: "第二轮洞察" });
    expect(artifact.artifact?.idempotencyKey).toBe("retro:s1:1");
  });

  it("状态跨调用持久化:新建读取看到同样的计数", async () => {
    const root = await tmpRoot();
    tick(root, { sessionId: "s1", event: "user-turn" });
    tick(root, { sessionId: "s1", event: "tool-iteration" });
    const state = loadRetroSession(root, "s1");
    expect(state.state.userTurns).toBe(1);
    expect(state.state.toolIterations).toBe(1);
    expect(state.totalLines).toBe(2);
  });
});

describe("报告与容错", () => {
  it("report 聚合两个会话与合计", async () => {
    const root = await tmpRoot();
    await tenUserTurns(root, "s1");
    tick(root, { sessionId: "s1", event: "final-response" });
    recordArtifact(root, { sessionId: "s1", summary: "洞察一" });
    tick(root, { sessionId: "s2", event: "user-turn" });
    const report = retroReport(root, { at: 1_700_000_000_000 });
    expect(report.generatedAt).toBe("2023-11-14T22:13:20.000Z");
    expect(report.totals.sessions).toBe(2);
    expect(report.totals.triggers).toBe(1);
    expect(report.totals.forks).toBe(1);
    expect(report.totals.artifacts).toBe(1);
    const s1 = report.sessions.find((entry) => entry.sessionId === "s1");
    expect(s1).toMatchObject({ userTurns: 10, triggers: 1, forks: 1, artifacts: 1 });
    const s2 = report.sessions.find((entry) => entry.sessionId === "s2");
    expect(s2).toMatchObject({ userTurns: 1, triggers: 0 });
  });

  it("坏行只计数不炸:坏 JSON + 缺 sessionId 行被跳过,有效行仍生效", async () => {
    const root = await tmpRoot();
    await seedLines(root, [
      "{not-json",
      JSON.stringify({ v: 1, type: "event" }),
      JSON.stringify({ v: 1, type: "event", sessionId: "s1", kind: "user-turn", at: "2023-11-14T22:13:20.000Z" }),
    ]);
    const ledger = readRetroLedger(root);
    expect(ledger.badLines).toBe(2);
    expect(ledger.totalLines).toBe(3);
    expect(getRetroState(root, "s1").state.userTurns).toBe(1);
  });

  it("台账文件路径固定为 <root>/.genie/rsi/retro.jsonl", async () => {
    const root = await tmpRoot();
    expect(retroPaths(root).file).toBe(join(root, ".genie", "rsi", RETRO_LEDGER_FILE));
  });

  it("已有台账里的 trigger 行不影响计数", async () => {
    const root = await tmpRoot();
    await seedLines(root, [JSON.stringify({ v: 1, type: "trigger", sessionId: "s1", reason: "x", codes: [] })]);
    const state = getRetroState(root, "s1");
    expect(state.state.userTurns).toBe(0);
    expect(state.triggers).toBe(1);
  });
});
