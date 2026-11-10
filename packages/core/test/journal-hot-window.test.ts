/**
 * g2 journal 热窗冷卸(2026-11):生产环境 journal 39.48 万行/597MB 全量常驻堆是五次网关 OOM 的压舱物。
 * 这里锁死热窗的语义边界:
 * ①跨会话 kind(global.jsonl)全量常驻、永不淘汰;会话域事件按会话粒度驻留(整会话,不腰斩);
 * ②超限按 LRU 整会话冷卸,冷会话 readSession 按需回读磁盘 → 完整历史(含头部首条),且与
 *   readAll().filter(sid) 逐条一致;
 * ③readAll 冷会话补齐后完整且 seq 单调(不静默漏事件);
 * ④幂等键全量保留:冷会话复活后重复 append 同 key 返回同一事件、不重复入账;
 * ⑤GENIE_JOURNAL_HOT_SESSIONS=0 关闭热窗 → 行为与旧实现逐字一致(全量驻留)。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { FileJournal } from "../src/journal/journal.js";

const SESSIONS = 30;
const PER_SESSION = 50; // 1 会话头 + 48 消息/工具 + 1 幂等键事件
const HOT = 5;

/** 造 30 会话 × 50 事件(含 message.* 与会话头),写进 sessions/<sid>.jsonl + global.jsonl 布局。 */
function seedJournal(fp: string): void {
  const j = new FileJournal(fp, { writeBehind: true, sharded: true });
  for (let s = 0; s < SESSIONS; s++) {
    const sid = `s${String(s).padStart(2, "0")}`;
    const batch: Parameters<FileJournal["append"]>[0][] = [
      { kind: "session.start", sessionId: sid, payload: { header: true } } as never,
    ];
    for (let i = 1; i < PER_SESSION - 1; i++) {
      batch.push({
        kind: i % 2 === 1 ? "message.user" : "message.agent",
        sessionId: sid,
        payload: { text: `${sid}#${i}` },
      } as never);
    }
    batch.push({ kind: "message.system", sessionId: sid, payload: { note: "idem" }, idempotencyKey: `k.${sid}` } as never);
    j.appendMany(batch);
  }
  j.flush();
}

function openHot(fp: string, hotSessions?: number, hotBytes?: number): FileJournal {
  const j = new FileJournal(fp, { sharded: true, deferLoad: true, hotSessions, hotBytes });
  return j;
}

const ENV = "GENIE_JOURNAL_HOT_SESSIONS";
const BYTES_ENV = "GENIE_JOURNAL_HOT_BYTES";
afterEach(() => { delete process.env[ENV]; delete process.env[BYTES_ENV]; });

describe("journal 热窗冷卸(g2)", () => {
  it("loadChunked 后热集合只驻 N 个会话,其余整会话冷卸(引擎常驻跨会话 kind)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-basic-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      const j = openHot(fp, HOT);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotLimit).toBe(HOT);
      expect(stats.hotSessions).toBe(HOT);
      expect(stats.coldSessions).toBe(SESSIONS - HOT);
      // 驻留 = 热会话的整会话事件(每会话 PER_SESSION 条),冷会话事件不再驻留。
      expect(stats.residentEvents).toBe(HOT * PER_SESSION);
      // 水位(下一个 seq)不受冷卸影响。
      expect(j.length).toBe(SESSIONS * PER_SESSION);
      expect(stats.seqHigh).toBe(SESSIONS * PER_SESSION - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("冷会话 readSession 回读完整(含头部首条),与 readAll().filter(sid) 逐条相等", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-cold-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      const j = openHot(fp, HOT);
      await j.loadChunked();
      expect(j.hotWindowStats().coldSessions).toBeGreaterThan(0);
      // 按最后追加序,最近的 HOT 个会话是 s25..s29;更早的都是冷会话。
      const coldSid = "s00";
      const all = j.readAll();
      const sess = j.readSession(coldSid);
      expect(sess).toHaveLength(PER_SESSION);
      expect(sess[0]!.kind).toBe("session.start"); // 会话头在场(deriveMessages 需要)
      expect(sess[0]!.seq).toBe(0);
      expect(sess.map((e) => e.seq)).toEqual([...sess.map((e) => e.seq)].sort((a, b) => a - b));
      expect(sess).toEqual(all.filter((e) => e.sessionId === coldSid));
      // 增量读口径一致
      const since = sess[10]!.seq;
      expect(j.readSession(coldSid, since)).toEqual(sess.filter((e) => e.seq >= since));
      // 回读后按 LRU 提升为热:冷会话数不变(提升一个冷的 = 挤掉一个热的变成冷的)
      const after = j.hotWindowStats();
      expect(after.hotSessions).toBe(HOT);
      expect(after.coldSessions).toBe(SESSIONS - HOT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("淘汰后再次 readSession 数据一致(反复冷热往返不丢事件、不重事件)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-cycle-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      const j = openHot(fp, HOT);
      await j.loadChunked();
      const sid = "s03";
      const first = j.readSession(sid);
      const second = j.readSession(sid);
      expect(second).toEqual(first);
      expect(second.map((e) => e.seq)).toEqual(first.map((e) => e.seq));
      // 甩动热窗(读入足够多的别家会话把 s03 挤出),再回读应完全一致。
      for (let s = 0; s < SESSIONS; s++) j.readSession(`s${String(s).padStart(2, "0")}`);
      expect(j.hotWindowStats().hotSessions).toBe(HOT);
      const again = j.readSession(sid);
      expect(again).toHaveLength(PER_SESSION);
      expect(again).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等键全量保留:冷会话复活后重复 append 同 key 返回同事件、水位不涨", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-idem-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      const j = openHot(fp, HOT);
      await j.loadChunked();
      const total = SESSIONS * PER_SESSION;
      for (const sid of ["s00", "s01", "s12"]) {
        const dup = j.append({
          kind: "message.system", sessionId: sid, payload: { note: "idem" }, idempotencyKey: `k.${sid}`,
        });
        expect(dup.idempotencyKey).toBe(`k.${sid}`);
        expect(dup.sessionId).toBe(sid);
        expect(dup.payload).toEqual({ note: "idem" }); // 返回的就是原事件,不是新造的
      }
      expect(j.length).toBe(total); // 水位不涨 = 没重复入账
      expect(j.readAll()).toHaveLength(total);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readAll 冷会话补齐:完整且 seq 严格单调", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-readall-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      const j = openHot(fp, HOT);
      await j.loadChunked();
      const all = j.readAll();
      expect(all).toHaveLength(SESSIONS * PER_SESSION);
      const seqs = all.map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      // 每个会话的整段历史都在(不静默漏冷会话)
      for (let s = 0; s < SESSIONS; s++) {
        const sid = `s${String(s).padStart(2, "0")}`;
        const mine = all.filter((e) => e.sessionId === sid);
        expect(mine).toHaveLength(PER_SESSION);
        expect(mine[0]!.kind).toBe("session.start");
      }
      // sinceSeq 增量:水位之后 = []
      expect(j.readAll(j.length)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GENIE_JOURNAL_HOT_SESSIONS=0 关闭热窗:全量驻留,行为与旧测试一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-off-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      process.env[ENV] = "0";
      const j = openHot(fp); // 不传 override,走 env
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotLimit).toBe(0);
      expect(stats.hotSessions).toBe(0);
      expect(stats.coldSessions).toBe(0);
      expect(stats.residentEvents).toBe(SESSIONS * PER_SESSION);
      expect(j.length).toBe(SESSIONS * PER_SESSION);
      expect(j.readAll()).toHaveLength(SESSIONS * PER_SESSION);
      for (const sid of ["s00", "s17", "s29"]) {
        const sess = j.readSession(sid);
        expect(sess).toHaveLength(PER_SESSION);
        expect(sess).toEqual(j.readAll().filter((e) => e.sessionId === sid));
      }
      // 关窗后仍可追加(水位延续)
      expect(j.append({ kind: "message.user", sessionId: "s29", payload: { text: "x" } }).seq).toBe(SESSIONS * PER_SESSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env 覆盖热窗容量(非法值回落默认 20)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hot-env-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedJournal(fp);
      process.env[ENV] = "3";
      const j = openHot(fp);
      await j.loadChunked();
      expect(j.hotWindowStats().hotLimit).toBe(3);
      expect(j.hotWindowStats().hotSessions).toBe(3);
      expect(j.hotWindowStats().coldSessions).toBe(SESSIONS - 3);

      process.env[ENV] = "not-a-number";
      const j2 = openHot(fp);
      await j2.loadChunked();
      expect(j2.hotWindowStats().hotLimit).toBe(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 流式加载(2026-11):loadChunked 峰值内存的验 ─────────────────────────────
// 背景:旧实现先把 global+legacy+sessions/* 全量 parse 进 ParsedSource[] 再整体归并淘汰,
// 528k 事件全成活对象 → 峰值堆 851MB。流式加载改为「热会话/全局留对象、冷会话扫描即弃」。
const SESSION_DOMAIN_PER = 3; // session.start + message.user + message.agent

/** 显式设定 mtime(热文件按 mtime 选,测试必须可控;utimes 接收秒)。 */
function setMtime(path: string, ms: number): void {
  utimesSync(path, ms / 1000, ms / 1000);
}

/** 造 6 个会话:每会话 3 条会话域事件 + 1 条跨会话 kind(model.switch → global.jsonl)。 */
function seedMixed(fp: string): void {
  const j = new FileJournal(fp, { writeBehind: true, sharded: true });
  for (let s = 0; s < 6; s++) {
    const sid = `m${s}`;
    j.append({ kind: "session.start", sessionId: sid, payload: {} } as never);
    j.append({ kind: "message.user", sessionId: sid, payload: { t: 1 } } as never);
    j.append({ kind: "message.agent", sessionId: sid, payload: { t: 2 } } as never);
    j.append({ kind: "model.switch", sessionId: sid, payload: { model: "x" } } as never);
  }
  j.flush();
}

describe("journal 流式加载(g2 峰值内存)", () => {
  it("①事件驻留口径:events[] 只装 global + 热会话,冷会话不驻留但回读完整", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-stream-mix-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedMixed(fp);
      // 热文件 = mtime 最新的 2 个:m5 / m4(显式 mtime,避免同毫秒并列)
      for (let s = 0; s < 6; s++) setMtime(join(dir, "sessions", `m${s}.jsonl`), 1_700_000_000_000 + s * 1000);
      const j = openHot(fp, 2);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotSessions).toBe(2);
      expect(stats.coldSessions).toBe(4);
      // 驻留 = 热会话 3 条会话域事件 × 2 + global 的 6 条 model.switch(跨会话 kind 恒常驻)
      expect(stats.residentEvents).toBe(2 * SESSION_DOMAIN_PER + 6);
      // 水位不受冷卸载影响:6 会话 × 4 条
      expect(j.length).toBe(6 * 4);
      // 冷会话回读完整:会话头在首条,跨会话 kind 也在(常驻子集,不在磁盘域事件里)
      const cold = j.readSession("m0");
      expect(cold).toHaveLength(SESSION_DOMAIN_PER + 1);
      expect(cold[0]!.kind).toBe("session.start");
      expect(cold.map((e) => e.seq)).toEqual([...cold.map((e) => e.seq)].sort((a, b) => a - b));
      expect(cold).toEqual(j.readAll().filter((e) => e.sessionId === "m0"));
      // 全量补齐:24 条、seq 严格单调(冷会话事件按需从磁盘补,不静默漏)
      const all = j.readAll();
      expect(all).toHaveLength(6 * 4);
      for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②legacy 单文件(gateway.jsonl 分片前历史)里的冷会话 readSession 可回读", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-stream-legacy-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      // 分片前:单文件写入老会话 old-1(没有 sessions/old-1.jsonl)
      const legacy = new FileJournal(fp);
      legacy.append({ kind: "session.start", sessionId: "old-1", payload: {} } as never);
      legacy.append({ kind: "message.user", sessionId: "old-1", payload: { t: 1 } } as never);
      legacy.append({ kind: "message.agent", sessionId: "old-1", payload: { t: 2 } } as never);
      // 分片后:新会话写 sessions/*
      const sh = new FileJournal(fp, { writeBehind: true, sharded: true });
      for (const sid of ["new-1", "new-2"]) {
        sh.append({ kind: "session.start", sessionId: sid, payload: {} } as never);
        sh.append({ kind: "message.user", sessionId: sid, payload: {} } as never);
      }
      sh.flush();
      setMtime(join(dir, "sessions", "new-2.jsonl"), 1_700_000_002_000);
      setMtime(join(dir, "sessions", "new-1.jsonl"), 1_700_000_001_000);
      const j = openHot(fp, 1); // 只有 new-2 是热文件;old-1/new-1 都冷
      await j.loadChunked();
      expect(j.hotWindowStats().coldSessions).toBeGreaterThanOrEqual(2);
      expect(j.hotWindowStats().residentEvents).toBe(2); // 只有 new-2 的两条常驻
      const old = j.readSession("old-1");
      expect(old.map((e) => e.kind)).toEqual(["session.start", "message.user", "message.agent"]);
      expect(old).toEqual(j.readAll().filter((e) => e.sessionId === "old-1"));
      // legacy 里另一会话也冷,但同样可回读
      expect(j.readSession("new-1")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③热文件按 mtime 选择的边界:只驻留最新 N 个会话文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-stream-mtime-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      const j0 = new FileJournal(fp, { writeBehind: true, sharded: true });
      // 每会话事件数不同(i+2),驻留条数能反推「选了哪几个文件」
      for (let s = 0; s < 5; s++) {
        const sid = `t${s}`;
        for (let i = 0; i < s + 2; i++) {
          j0.append({ kind: i === 0 ? "session.start" : "message.user", sessionId: sid, payload: { i } } as never);
        }
      }
      j0.flush();
      // 最新 = t3(次新 t1),其余更旧
      const mtimes: Record<string, number> = { t0: 800, t1: 1_000, t2: 700, t3: 1_100, t4: 600 };
      for (const [sid, m] of Object.entries(mtimes)) setMtime(join(dir, "sessions", `${sid}.jsonl`), 1_700_000_000_000 + m * 1000);
      const j = openHot(fp, 2);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotSessions).toBe(2);
      // t3 有 5 条、t1 有 3 条 = 8;若选错(如按文件名/按 seq)不会正好是 8
      expect(stats.residentEvents).toBe(5 + 3);
      // 边界外的 t4(6 条)是冷会话:不驻留,但回读完整
      const t4 = j.readSession("t4");
      expect(t4).toHaveLength(6);
      expect(t4[0]!.kind).toBe("session.start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④readAll 冷补齐不重复解析 global.jsonl(共享缓存命中)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-stream-cache-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedMixed(fp);
      const j = openHot(fp, 1); // 5 个冷会话,每个都要回读(旧实现每个会话都会重解一次 global)
      await j.loadChunked();
      // 私有方法在原型上,spyOn 实例即可统计实际解析次数(parsedFile → parseFile)。
      const spy = vi.spyOn(j as unknown as { parseFile: (p: string) => unknown }, "parseFile");
      const all = j.readAll();
      expect(all).toHaveLength(6 * 4);
      const globalParses = spy.mock.calls.filter((c) => String(c[0]).endsWith("global.jsonl")).length;
      expect(globalParses).toBe(1); // 5 个冷会话共享一次解析(旧实现 = 5 次)
      // 会话自己的分文件仍是一次一解析(缓存只钉共享文件,不把会话肥数据钉回堆)
      const sessionParses = spy.mock.calls.filter((c) => String(c[0]).includes(`${"sessions"}`)).length;
      expect(sessionParses).toBe(5);
      spy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 热窗字节配额(2026-11):N 上限挡不住单会话巨型文件 ───────────────────────────────
// 生产环境经验证:热窗里 2 个巨型会话文件(23.5MB + 41MB)解析成事件对象 ≈138MB 堆 → 稳态 RSS 314MB。
// 字节配额语义:mtime 从新到旧累计会话文件字节直到预算用尽;单会话自身 > 预算 1/2 则整会话不纳入热集合
// (BYTES_ENV 与 afterEach 清理在文件顶部声明)

/** 造「事件数/payload 尺寸可调」的会话分文件;返回各会话真实文件字节数(按 sids 顺序)。 */
function seedSized(fp: string, specs: Array<{ sid: string; count: number; pad: number }>): Record<string, number> {
  const j = new FileJournal(fp, { writeBehind: true, sharded: true });
  for (const spec of specs) {
    const batch: Parameters<FileJournal["append"]>[0][] = [
      { kind: "session.start", sessionId: spec.sid, payload: { header: true } } as never,
    ];
    for (let i = 1; i < spec.count; i++) {
      batch.push({
        kind: i % 2 === 1 ? "message.user" : "message.agent",
        sessionId: spec.sid,
        payload: { text: "x".repeat(spec.pad) },
      } as never);
    }
    j.appendMany(batch);
  }
  j.flush();
  const sizes: Record<string, number> = {};
  for (const spec of specs) sizes[spec.sid] = statSync(join(dirname(fp), "sessions", `${spec.sid}.jsonl`)).size;
  return sizes;
}

describe("journal 热窗字节配额(g2 字节预算)", () => {
  it("①单会话超预算 1/2 → 整会话不进热集合,但 readSession/readAll 仍完整", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hotbytes-giant-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      const sizes = seedSized(fp, [
        { sid: "small-1", count: 3, pad: 10 },
        { sid: "small-2", count: 3, pad: 10 },
        { sid: "small-3", count: 3, pad: 10 },
        { sid: "giant", count: 200, pad: 1000 }, // ≈220KB,远超预算 1/2
      ]);
      // giant 最新(mtime 排序第一),但它自身超预算 1/2 → 整会话冷卸
      setMtime(join(dir, "sessions", "giant.jsonl"), 1_700_004_000_000);
      setMtime(join(dir, "sessions", "small-3.jsonl"), 1_700_003_000_000);
      setMtime(join(dir, "sessions", "small-2.jsonl"), 1_700_002_000_000);
      setMtime(join(dir, "sessions", "small-1.jsonl"), 1_700_001_000_000);
      const budget = 400_000; // 400KB:预算 1/2=200KB < giant 文件字节
      expect(sizes.giant!).toBeGreaterThan(budget / 2);
      const j = openHot(fp, 20, budget);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotLimitBytes).toBe(budget);
      expect(stats.hotSessions).toBe(3); // 三个小会话在热集合,giant 不在
      expect(stats.coldSessions).toBe(1);
      expect(stats.residentEvents).toBe(3 * 3); // giant 的 200 条不驻留
      expect(j.length).toBe(3 * 3 + 200);
      // 巨型冷会话仍可冷回读:完整会话(含头部首条)、seq 单调、与 readAll().filter 逐条一致
      const giant = j.readSession("giant");
      expect(giant).toHaveLength(200);
      expect(giant[0]!.kind).toBe("session.start");
      expect(giant.map((e) => e.seq)).toEqual([...giant.map((e) => e.seq)].sort((a, b) => a - b));
      expect(giant).toEqual(j.readAll().filter((e) => e.sessionId === "giant"));
      const all = j.readAll();
      expect(all).toHaveLength(3 * 3 + 200);
      for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBeGreaterThanOrEqual(all[i - 1]!.seq);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("②预算用尽的边界:按 mtime 从新到旧累计文件字节,用尽后更旧的会话不再纳入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hotbytes-budget-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      // 每会话字节数接近(用 payload 补齐计数差异),字节预算下「谁热」由 mtime 顺序 + 累计额度决定
      const sizes = seedSized(fp, [
        { sid: "b0", count: 20, pad: 700 },
        { sid: "b1", count: 24, pad: 560 },
        { sid: "b2", count: 30, pad: 410 },
        { sid: "b3", count: 38, pad: 290 },
      ]);
      const T = 1_700_010_000_000;
      const order = ["b3", "b2", "b1", "b0"]; // mtime 从新到旧
      order.forEach((sid, i) => setMtime(join(dir, "sessions", `${sid}.jsonl`), T + (order.length - i) * 10_000));
      const avg = (sizes.b3! + sizes.b2! + sizes.b1! + sizes.b0!) / 4;
      // 预算 = 2 个会话 + 半个会话:第三个开始额度不够 → 预算用尽,更旧的一律冷卸。
      // 同时保证预算 1/2 > 任何单会话(否则会被 1/2 规则剔掉,测不到「累计用尽」)。
      const budget = Math.floor(2 * avg + avg / 2);
      expect(budget / 2).toBeGreaterThan(Math.max(...order.map((s) => sizes[s]!)));
      const j = openHot(fp, 20, budget);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotSessions).toBe(2);
      expect(stats.coldSessions).toBe(2);
      // 热的正好是两个最新的 b3(38 条)+ b2(30 条);若选了更旧的,条数不会是 68
      expect(stats.residentEvents).toBe(38 + 30);
      // 冷掉的两个仍可完整冷回读
      for (const sid of ["b0", "b1"]) {
        const sess = j.readSession(sid);
        expect(sess[0]!.kind).toBe("session.start");
        expect(sess).toEqual(j.readAll().filter((e) => e.sessionId === sid));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("③最少 1 个热会话:全部会话都超预算 1/2 时仍留最新那个", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hotbytes-min1-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      const sizes = seedSized(fp, [
        { sid: "old-big", count: 200, pad: 1000 },
        { sid: "new-big", count: 120, pad: 1000 },
      ]);
      setMtime(join(dir, "sessions", "old-big.jsonl"), 1_700_020_000_000);
      setMtime(join(dir, "sessions", "new-big.jsonl"), 1_700_021_000_000);
      const budget = 100_000; // 100KB:两个会话都 > 预算 1/2(50KB)
      expect(Math.min(sizes["old-big"]!, sizes["new-big"]!)).toBeGreaterThan(budget / 2);
      const j = openHot(fp, 20, budget);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotSessions).toBe(1); // 下限生效:不出现空热窗
      expect(stats.coldSessions).toBe(1);
      expect(stats.residentEvents).toBe(120); // 留下的是最新的 new-big(120 条)
      expect(j.readSession("old-big")).toHaveLength(200); // 冷掉的仍完整可读
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("④GENIE_JOURNAL_HOT_BYTES=0 → 字节预算不限,只按 N 生效(旧行为)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-hotbytes-off-"));
    try {
      const fp = join(dir, "gateway.jsonl");
      seedSized(fp, [
        { sid: "n0", count: 3, pad: 10 },
        { sid: "n1", count: 3, pad: 10 },
        { sid: "n2", count: 5, pad: 10 },
        { sid: "n3-giant", count: 200, pad: 1000 }, // 会被 1/2 规则剔除的巨型会话
      ]);
      setMtime(join(dir, "sessions", "n3-giant.jsonl"), 1_700_034_000_000);
      setMtime(join(dir, "sessions", "n2.jsonl"), 1_700_033_000_000);
      setMtime(join(dir, "sessions", "n1.jsonl"), 1_700_032_000_000);
      setMtime(join(dir, "sessions", "n0.jsonl"), 1_700_031_000_000);
      // 默认预算 = 64MB
      const def = openHot(fp, 20);
      await def.loadChunked();
      expect(def.hotWindowStats().hotLimitBytes).toBe(64 * 1_048_576);
      // 显式 0:只按 N=2 取 mtime 最新的两个(n3-giant 即便巨大也算热,旧行为)
      process.env[BYTES_ENV] = "0";
      const j = openHot(fp, 2);
      await j.loadChunked();
      const stats = j.hotWindowStats();
      expect(stats.hotLimitBytes).toBe(0);
      expect(stats.hotSessions).toBe(2);
      expect(stats.coldSessions).toBe(2);
      expect(stats.residentEvents).toBe(200 + 5); // n3-giant + n2
      // 非法值 → 回落默认 64MB
      process.env[BYTES_ENV] = "abc";
      const bad = openHot(fp, 20);
      await bad.loadChunked();
      expect(bad.hotWindowStats().hotLimitBytes).toBe(64 * 1_048_576);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
