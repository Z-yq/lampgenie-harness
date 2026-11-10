/**
 * 同步权威协议持久层:落盘、拒收不写盘、四段迁移回读、订阅脏位、水位、报表、坏 JSON 容错、
 * tmp 无残留、同 root 并发串行。全部用例只写 os.tmpdir() 下的临时目录,绝不碰仓库 .genie。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accept,
  loadState,
  migrate,
  report,
  subscribe,
  syncPath,
  watermark,
} from "../src/sync-authority-store";

const T0 = 1_700_000_000_000;
const AGG = "agg-1";
const O1 = "owner-1";
const O2 = "owner-2";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-authority-store-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function event(over: Record<string, unknown> = {}) {
  return {
    aggregateId: AGG,
    seq: 1,
    ownerId: O1,
    payloadHash: "h1",
    at: T0,
    ...over,
  } as { aggregateId: string; seq: number; ownerId: string; payloadHash: string; at: number };
}

function readRaw(): string {
  return readFileSync(syncPath(root), "utf8");
}

function tmpFiles(): string[] {
  const dir = join(root, ".genie", "rsi");
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  } catch {
    return [];
  }
}

describe("accept 落盘", () => {
  it("首次 accept 建目录并落盘,回读状态一致", async () => {
    const out = await accept(root, event({ seq: 1 }));
    expect(out.code).toBe("SYNC_ACCEPTED");
    expect(out.persisted).toBe(true);
    const state = await loadState(root);
    expect(state.aggregates[AGG]?.ownerId).toBe(O1);
    expect(state.aggregates[AGG]?.watermark).toBe(1);
    expect(state.aggregates[AGG]?.events).toHaveLength(1);
    expect(readRaw()).toContain("\"v\": 1");
  });

  it("重复投递同 seq 同 hash → SYNC_NOOP 且不写盘", async () => {
    await accept(root, event({ seq: 1 }));
    const before = readRaw();
    const out = await accept(root, event({ seq: 1 }));
    expect(out.code).toBe("SYNC_NOOP");
    expect(out.persisted).toBe(false);
    expect(readRaw()).toBe(before);
  });

  it("同 seq 异 hash → CONFLICT_DIE 且文件内容不变", async () => {
    await accept(root, event({ seq: 1 }));
    const before = readRaw();
    const out = await accept(root, event({ seq: 1, payloadHash: "h-other" }));
    expect(out.code).toBe("SYNC_CONFLICT_DIE");
    expect(readRaw()).toBe(before);
    expect((await watermark(root, AGG))).toBe(1);
  });

  it("owner 不符 → DROPPED_OWNER 且水位与文件不变", async () => {
    await accept(root, event({ seq: 1 }));
    const before = readRaw();
    const out = await accept(root, event({ seq: 2, ownerId: O2 }));
    expect(out.code).toBe("SYNC_DROPPED_OWNER");
    expect(readRaw()).toBe(before);
    expect((await loadState(root)).aggregates[AGG]?.watermark).toBe(1);
  });

  it("非法事件 → SYNC_INVALID 且不产生文件", async () => {
    const out = await accept(root, event({ seq: 0 }));
    expect(out.code).toBe("SYNC_INVALID");
    expect(out.persisted).toBe(false);
    expect(() => readRaw()).toThrow();
  });

  it("多次顺序 accept 累计事件且按 seq 升序回读", async () => {
    await accept(root, event({ seq: 3 }));
    await accept(root, event({ seq: 1 }));
    await accept(root, event({ seq: 2 }));
    const state = await loadState(root);
    expect(state.aggregates[AGG]?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(state.aggregates[AGG]?.watermark).toBe(3);
  });
});

describe("migrate", () => {
  it("四段成功:owner 回读为 toOwner、phases 顺序完整、事件保留", async () => {
    await accept(root, event({ seq: 1 }));
    await accept(root, event({ seq: 2 }));
    const out = await migrate(root, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 + 5 });
    expect(out.code).toBe("SYNC_MIGRATED");
    expect(out.phases).toEqual(["flatten", "claim", "replay", "steal"]);
    expect(out.persisted).toBe(true);
    const state = await loadState(root);
    expect(state.aggregates[AGG]?.ownerId).toBe(O2);
    expect(state.aggregates[AGG]?.watermark).toBe(2);
    expect(state.aggregates[AGG]?.events).toHaveLength(2);
    expect(state.owners[O2]).toEqual({ since: T0 + 5 });
  });

  it("migrate 后旧 owner 迟到写回被丢弃(落盘态不变)", async () => {
    await accept(root, event({ seq: 1 }));
    await migrate(root, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 });
    const before = readRaw();
    const late = await accept(root, event({ seq: 2, ownerId: O1 }));
    expect(late.code).toBe("SYNC_DROPPED_OWNER");
    expect(readRaw()).toBe(before);
  });

  it("聚合不存在 → MIGRATE_FAILED 且不创建文件", async () => {
    const out = await migrate(root, { aggregateId: "missing", fromOwner: O1, toOwner: O2, at: T0 });
    expect(out.code).toBe("SYNC_MIGRATE_FAILED");
    expect(out.reason).toBe("flatten:no-aggregate");
    expect(out.persisted).toBe(false);
    expect(tmpFiles()).toEqual([]);
  });

  it("fromOwner 不符 → MIGRATE_FAILED 且文件内容不变", async () => {
    await accept(root, event({ seq: 1 }));
    const before = readRaw();
    const out = await migrate(root, { aggregateId: AGG, fromOwner: "ghost", toOwner: O2, at: T0 });
    expect(out.code).toBe("SYNC_MIGRATE_FAILED");
    expect(out.reason).toBe("flatten:not-owner");
    expect(readRaw()).toBe(before);
  });

  it("同 owner 迁移 → claim:same-owner 且不落盘", async () => {
    await accept(root, event({ seq: 1 }));
    const before = readRaw();
    const out = await migrate(root, { aggregateId: AGG, fromOwner: O1, toOwner: O1, at: T0 });
    expect(out.reason).toBe("claim:same-owner");
    expect(readRaw()).toBe(before);
  });
});

describe("subscribe / watermark / report", () => {
  it("subscribe 返回 dirtyFromSeq = max(sinceSeq, watermark+1) 与过滤后历史", async () => {
    await accept(root, event({ seq: 1 }));
    await accept(root, event({ seq: 4 }));
    const out = await subscribe(root, { aggregateId: AGG, sinceSeq: 2 });
    expect(out.code).toBe("SYNC_SUBSCRIBED");
    expect(out.subscription).toEqual({ aggregateId: AGG, dirtyFromSeq: 5 });
    expect(out.history.map((e) => e.seq)).toEqual([4]);
    expect(out.watermark).toBe(4);
  });

  it("subscribe 聚合不存在 → dirtyFromSeq=sinceSeq 且历史空", async () => {
    const out = await subscribe(root, { aggregateId: "nope", sinceSeq: 7 });
    expect(out.subscription.dirtyFromSeq).toBe(7);
    expect(out.history).toEqual([]);
    expect(out.watermark).toBe(0);
  });

  it("watermark 空状态 = 0", async () => {
    expect(await watermark(root, AGG)).toBe(0);
  });

  it("report 汇总聚合、owner 与事件总数", async () => {
    await accept(root, event({ seq: 1 }));
    await accept(root, event({ seq: 2 }));
    await accept(root, event({ aggregateId: "agg-0", seq: 1, ownerId: O2 }));
    const out = await report(root);
    expect(out.aggregates.map((a) => a.id)).toEqual(["agg-0", "agg-1"]);
    expect(out.aggregates[1]).toEqual({ id: AGG, ownerId: O1, watermark: 2, events: 2 });
    expect(out.totalEvents).toBe(3);
    expect(out.owners[O1]).toEqual({ since: T0 });
  });
});

describe("容错与原子性", () => {
  it("坏 JSON → 空状态不抛,后续 accept 可重建", async () => {
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    writeFileSync(syncPath(root), "{ 这不是 JSON", "utf8");
    expect(await watermark(root, AGG)).toBe(0);
    const rep = await report(root);
    expect(rep.aggregates).toEqual([]);
    expect(rep.totalEvents).toBe(0);
    const out = await accept(root, event({ seq: 1 }));
    expect(out.code).toBe("SYNC_ACCEPTED");
    expect((await watermark(root, AGG))).toBe(1);
  });

  it("结构不符(聚合字段坏)→ 坏聚合被丢弃,好聚合保留", async () => {
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    const body = {
      v: 1,
      aggregates: {
        ok: { aggregateId: "ok", ownerId: O1, watermark: 2, events: [event({ aggregateId: "ok", seq: 1 }), event({ aggregateId: "ok", seq: 2 })] },
        bad: { aggregateId: "bad", ownerId: "", watermark: "x", events: "nope" },
      },
      owners: { [O1]: { since: T0 }, broken: { since: "x" } },
    };
    writeFileSync(syncPath(root), JSON.stringify(body), "utf8");
    const state = await loadState(root);
    expect(Object.keys(state.aggregates)).toEqual(["ok"]);
    expect(state.aggregates.ok?.watermark).toBe(2);
    expect(Object.keys(state.owners)).toEqual([O1]);
  });

  it("空文件按空状态处理", async () => {
    mkdirSync(join(root, ".genie", "rsi"), { recursive: true });
    writeFileSync(syncPath(root), "   \n", "utf8");
    expect(await watermark(root, AGG)).toBe(0);
  });

  it("落盘后目录内无 *.tmp 残留", async () => {
    await accept(root, event({ seq: 1 }));
    await accept(root, event({ seq: 2 }));
    await migrate(root, { aggregateId: AGG, fromOwner: O1, toOwner: O2, at: T0 });
    expect(tmpFiles()).toEqual([]);
  });

  it("并发 10 次 accept 不丢更新(串行锁)", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => accept(root, event({ seq: i + 1 }))),
    );
    expect(results.every((item) => item.code === "SYNC_ACCEPTED")).toBe(true);
    const state = await loadState(root);
    expect(state.aggregates[AGG]?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(state.aggregates[AGG]?.watermark).toBe(10);
  });

  it("root 缺省非法 → 抛参数错误(唯一允许的 throw)", () => {
    expect(() => syncPath("")).toThrow();
  });

  it("写入后文件 mtime 可见且内容为合法 JSON", async () => {
    await accept(root, event({ seq: 1 }));
    const stat = statSync(syncPath(root));
    expect(stat.size).toBeGreaterThan(0);
    expect(JSON.parse(readRaw()) as { v: number }).toMatchObject({ v: 1 });
  });
});
