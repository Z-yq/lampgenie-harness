/**
 * M49 压缩事务(机制矩阵 #49):
 * ①会话级锁(auto 与 manual 不并发摘要)②generation 重验(摘要期间 surface 变了不提交)
 * ③摘要缩小硬校验(不比 head 小就不写 done)④abandoned 检测(悬空 compact.start 只落一次)。
 */
import { describe, it, expect } from "vitest";
import { FileJournal, MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCompact, compactionInFlight } from "../src/agent/auto-compact";
import { deriveMessages, type LlmProvider } from "../src/agent/loop";

/** 一个超阈值的会话(20 条长消息),tail 保留 3 条。 */
function longJournal(sid = "s") {
  const j = new MemoryJournal();
  for (let i = 0; i < 20; i++) {
    j.append({ kind: "message.user", sessionId: sid, payload: { text: "很长很长的内容".repeat(50) } });
  }
  return j;
}

function optsOf(llm: LlmProvider, devlogDir: string) {
  return { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: llm, devlogDir, force: true };
}

describe("M49 ①会话级压缩锁", () => {
  it("压缩在跑时第二次调用 → compact.skipped(compaction-in-progress),摘要模型只调 1 次", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const llm: LlmProvider = { async chat() { calls += 1; await gate; return { content: "摘要:压缩了" }; } };

    const first = autoCompact(j, "s", optsOf(llm, dir));
    expect(compactionInFlight("s")).toBeTruthy(); // 第一个已占锁(同步段跑完到 await)
    const second = await autoCompact(j, "s", optsOf(llm, dir));
    expect(second.compacted).toBe(false);
    expect(String(second.reason ?? "")).toContain("compaction-in-progress");
    expect(calls).toBe(1); // 第二次没调摘要模型

    const skip = j.readAll().find((e) => e.kind === "compact.skipped")!;
    const sp = skip.payload as { reason?: string; since?: number; generation?: number };
    expect(sp.reason).toBe("compaction-in-progress");
    expect(typeof sp.since).toBe("number");
    expect(typeof sp.generation).toBe("number");

    release();
    const r1 = await first;
    expect(r1.compacted).toBe(true);
    expect(j.readAll().filter((e) => e.kind === "compact.done")).toHaveLength(1);
    expect(compactionInFlight("s")).toBeUndefined(); // 成功出口释放锁
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("M49 ②generation 重验", () => {
  it("摘要期间 append message.user → compact.failed(surface-changed),不写 done,锁释放可再压", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const before = deriveMessages(j, "s").length;
    let fired = 0;
    const racingLlm: LlmProvider = {
      async chat() {
        fired += 1;
        j.append({ kind: "message.user", sessionId: "s", payload: { text: "摘要途中新到达的消息" } });
        return { content: "摘要:压缩了" };
      },
    };
    const r = await autoCompact(j, "s", optsOf(racingLlm, dir));
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("surface-changed");

    const events = j.readAll();
    expect(events.some((e) => e.kind === "compact.done")).toBe(false);
    const fail = events.find((e) => e.kind === "compact.failed")!;
    const fp = fail.payload as { reason?: string; fromGeneration?: number; toGeneration?: number };
    expect(fp.reason).toBe("surface-changed");
    expect(fp.fromGeneration).toBeTypeOf("number");
    expect(fp.toGeneration!).toBeGreaterThan(fp.fromGeneration!);
    // 历史不变(只多了那条新消息,没有被清空/替换)
    expect(deriveMessages(j, "s").length).toBe(before + 1);
    expect(fired).toBe(1); // 只尝试一次,不自动重试
    expect(compactionInFlight("s")).toBeUndefined(); // 失败出口也释放锁

    // 锁已释放 → 后续可正常压缩
    const ok = await autoCompact(j, "s", optsOf({ async chat() { return { content: "摘要:压缩了" }; } }, dir));
    expect(ok.compacted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("M49 ③摘要缩小硬校验", () => {
  it("摘要不比 head 小 → compact.failed(summary-not-smaller),不写 done", async () => {
    const j = new MemoryJournal();
    // head 极小(17 条单字消息),摘要模型返回超长文本 → summaryTokens 必然 ≥ headTokens
    for (let i = 0; i < 20; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: "a" } });
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const huge = "很长的摘要".repeat(2_000);
    // trigger=manual:绕开「auto+force 且 est 远低于阈值」的强压守卫,专测缩小校验
    const r = await autoCompact(j, "s", { ...optsOf({ async chat() { return { content: huge }; } }, dir), trigger: "manual" });
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("不比原文小");

    const events = j.readAll();
    expect(events.some((e) => e.kind === "compact.done")).toBe(false);
    const fp = events.find((e) => e.kind === "compact.failed")!.payload as
      { reason?: string; summaryTokens?: number; headTokens?: number };
    expect(fp.reason).toBe("summary-not-smaller");
    expect(fp.summaryTokens!).toBeGreaterThanOrEqual(fp.headTokens!);
    expect(compactionInFlight("s")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("摘要确实更小 → done(带 headTokens/summaryTokens 观测字段)", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const r = await autoCompact(j, "s", optsOf({ async chat() { return { content: "摘要:压缩了" }; } }, dir));
    expect(r.compacted).toBe(true);
    const done = j.readAll().find((e) => e.kind === "compact.done")!.payload as
      { headTokens?: number; summaryTokens?: number };
    expect(done.headTokens!).toBeGreaterThan(done.summaryTokens!);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("M49 ④失败出口释放锁", () => {
  it("摘要空串:failed + 锁释放", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const r = await autoCompact(j, "s", optsOf({ async chat() { return { content: "" }; } }, dir));
    expect(r.compacted).toBe(false);
    expect(compactionInFlight("s")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("摘要模型抛异常:异常向上抛 + 锁释放", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const boom: LlmProvider = { async chat() { throw new Error("endpoint 500"); } };
    await expect(autoCompact(j, "s", optsOf(boom, dir))).rejects.toThrow("endpoint 500");
    expect(compactionInFlight("s")).toBeUndefined();
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("M49 ⑤abandoned 检测", () => {
  it("历史 compact.start 无后续 → 落一次 compact.abandoned;重复调用不重复落", async () => {
    const j = new MemoryJournal();
    const startedAt = Date.now() - 60_000;
    const start = j.append({
      kind: "compact.start",
      sessionId: "s",
      payload: { tokens: 999, threshold: 100, messages: 20, trigger: "auto", startedAt },
    });
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "压缩后新消息" } });
    // 阈值高 + 不 force:本次压缩直接跳过,但入口 abandoned 检测照样要跑
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const llm: LlmProvider = { async chat() { return { content: "不该被调用" }; } };
    const opts = { thresholdTokens: 1_000_000, keepRecentMessages: 3, compactLlm: llm, devlogDir: dir };

    const r1 = await autoCompact(j, "s", opts);
    expect(r1.compacted).toBe(false);
    const ab = j.readAll().filter((e) => e.kind === "compact.abandoned");
    expect(ab).toHaveLength(1);
    const p = ab[0]!.payload as { startSeq?: number; startedAt?: number; ageMs?: number };
    expect(p.startSeq).toBe(start.seq);
    expect(p.startedAt).toBe(startedAt);
    expect(p.ageMs!).toBeGreaterThan(30_000);
    expect(ab[0]!.idempotencyKey).toBe(`compact-abandoned:s:${start.seq}`);

    // 重复调用:同一 startSeq → 幂等键拦截,不再落第二条
    await autoCompact(j, "s", opts);
    expect(j.readAll().filter((e) => e.kind === "compact.abandoned")).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("上次 start 之后已有 done/failed → 不判 abandoned(本次 start 也不自判)", async () => {
    const j = longJournal();
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const r = await autoCompact(j, "s", optsOf({ async chat() { return { content: "摘要:压缩了" }; } }, dir));
    expect(r.compacted).toBe(true);
    // 再压一次:上次有 done,不落 abandoned;本次 start 也不被自己判成 abandoned
    const r2 = await autoCompact(j, "s", optsOf({ async chat() { return { content: "摘要:再压一次" }; } }, dir));
    expect(r2.compacted).toBe(true);
    expect(j.readAll().filter((e) => e.kind === "compact.abandoned")).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 模拟 session-worker 的 ProxyJournal(2026-11-07 修复 M49 generation 口径):
 * 种子事件保留 **全局 seq**(60 万+),本地 append 的 seq=replica.length(小整数)——两者混用。
 * 旧实现 lock.generation=compact.start.seq 后 readSession(seq+1),会把整段种子历史算成「新增」。
 */
class MixedSeqJournal {
  replica: any[] = [];
  constructor(private readonly seedSeqBase = 600_000) {}
  seed(n: number, sid = "s") {
    for (let i = 0; i < n; i++) {
      this.replica.push({
        id: `seed-${i}`,
        seq: this.seedSeqBase + i,
        time: Date.now(),
        sessionId: sid,
        kind: "message.user",
        payload: { text: "很长很长的内容".repeat(50) },
      });
    }
  }
  append(ev: any) {
    const e = { ...ev, id: `loc-${this.replica.length}`, seq: this.replica.length, time: Date.now() };
    this.replica.push(e);
    return e;
  }
  appendMany(evs: any[]) { return evs.map((e) => this.append(e)); }
  readAll() { return [...this.replica]; }
  readSession(sessionId: string, sinceSeq = 0) {
    return this.replica.filter((e) => e.sessionId === sessionId && e.seq >= sinceSeq);
  }
  subscribe() { return () => {}; }
  get length() { return this.replica.length; }
}

const asJournal = (j: MixedSeqJournal) => j as unknown as Parameters<typeof autoCompact>[0];

describe("M49 ⑥ generation 用本会话事件计数(seq 无关)", () => {
  it("ProxyJournal 混用 seq:摘要期间无新增 → 正常提交 done(不被历史全局 seq 误判)", async () => {
    const j = new MixedSeqJournal();
    j.seed(300); // 300 条 seq=600000+ 的历史事件
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const r = await autoCompact(asJournal(j), "s", optsOf({ async chat() { return { content: "摘要:压缩了" }; } }, dir));
    expect(r.compacted).toBe(true);
    expect(j.readAll().filter((e) => e.kind === "compact.done")).toHaveLength(1);
    expect(j.readAll().some((e) => e.kind === "compact.failed")).toBe(false);
    expect(compactionInFlight("s")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ProxyJournal 混用 seq:摘要期间 1 条新增 → 只报 1 条(不是 300 条历史)", async () => {
    const j = new MixedSeqJournal();
    j.seed(300);
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const llm: LlmProvider = {
      async chat() {
        j.append({ kind: "message.user", sessionId: "s", payload: { text: "摘要途中新到达的消息" } });
        return { content: "摘要:压缩了" };
      },
    };
    const r = await autoCompact(asJournal(j), "s", optsOf(llm, dir));
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("surface-changed");
    expect(String(r.reason ?? "")).toContain("新增 1 条");
    const fail = j.readAll().find((e) => e.kind === "compact.failed")!;
    const fp = fail.payload as {
      reason?: string; fromGeneration?: number; toGeneration?: number;
      changedEvents?: { seq: number; kind: string }[];
    };
    expect(fp.reason).toBe("surface-changed");
    expect(fp.changedEvents).toHaveLength(1);
    expect(fp.changedEvents![0]!.kind).toBe("message.user");
    // fromGeneration/toGeneration 是事件计数(不是 seq):只差 1
    expect(fp.toGeneration).toBe(fp.fromGeneration! + 1);
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(false);
    expect(compactionInFlight("s")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("FileJournal 正常路径:无新增 → done;有新增 → 只报 1 条", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-txn-"));
    const mk = (name: string) => {
      const j = new FileJournal(join(dir, name));
      for (let i = 0; i < 20; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: "很长很长的内容".repeat(50) } });
      return j;
    };

    const okJ = mk("a.jsonl");
    const ok = await autoCompact(okJ, "s", optsOf({ async chat() { return { content: "摘要:压缩了" }; } }, dir));
    expect(ok.compacted).toBe(true);
    expect(okJ.readAll().filter((e) => e.kind === "compact.done")).toHaveLength(1);

    const j = mk("b.jsonl");
    const racing: LlmProvider = {
      async chat() {
        j.append({ kind: "message.user", sessionId: "s", payload: { text: "途中新消息" } });
        return { content: "摘要:压缩了" };
      },
    };
    const r = await autoCompact(j, "s", optsOf(racing, dir));
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("surface-changed");
    const fail = j.readAll().find((e) => e.kind === "compact.failed")!;
    const fp = fail.payload as { fromGeneration?: number; toGeneration?: number; changedEvents?: unknown[] };
    expect(fp.changedEvents).toHaveLength(1);
    expect(fp.toGeneration).toBe(fp.fromGeneration! + 1);
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
