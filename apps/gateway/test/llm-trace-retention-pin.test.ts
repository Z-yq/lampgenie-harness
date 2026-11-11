/**
 * 钉扎 + 证据区迁移(集成层)。
 * 为什么这样测:份数/总量清理是「删」的动作,而钉扎是它的刹车。刹车一旦失灵,后果不对称——
 * 删掉的轨迹不可恢复(RSI 挖掘原料没了、证据链断了);多留几份只是占点磁盘。所以这里用
 * 真临时目录 + 假证据集跑端到端,钉死:
 * A) 证据引用 session 不删;B) 窗口内不删;C) 窗口外无引用才删;D) 超份数/超总量时 pinned 仍不删;
 * E) 迁移路径不穿越、存在即跳过;F) 不传 shouldPin 时与旧实现逐字一致(返回结构也不变)。
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLlmTrace, type PinStats } from "../src/llm-trace-retention.js";
import { collectEvidenceSessions, migrateEvidenceTraces } from "../src/llm-trace.js";
import { migratePathFor, miningWindowStart, retentionVerdict } from "../src/trace-retention-policy.js";

const DAY = 86_400_000;
const OLD_BASE = 1_600_000_000_000; // 2020 年:一定在 7 天窗口外

/** 造 n 个轨迹文件,epochMs 从 base 递增(文件名末段即写盘时刻)。 */
function seed(root: string, session: string, n: number, base = OLD_BASE, size = 16): string[] {
  const d = join(root, session);
  mkdirSync(d, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const epoch = base + i * 1000;
    const name = `call-${String(i + 1).padStart(4, "0")}-t1s0-${epoch}.json`;
    const p = join(d, name);
    writeFileSync(p, JSON.stringify({ i, pad: "x".repeat(Math.max(0, size - 10)) }), "utf-8");
    paths.push(p);
  }
  return paths;
}

/** 与 llm-trace.ts runPrune 同形态的 pin 闭包(证据集 + 窗口)。 */
function pinClosure(now: number, windowStart: number, evidenceSessions: Set<string>) {
  return (f: { path: string; sessionId: string; epoch: number }) => {
    const v = retentionVerdict({ sessionId: f.sessionId, epoch: f.epoch, now, windowStart, evidenceSessions });
    return { pin: v.pin, reason: v.reason };
  };
}

describe("pruneLlmTrace + 证据钉扎", () => {
  it("A) 证据引用的 session → PIN_EVIDENCE,一份都不删", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-evd-"));
    try {
      seed(root, "web-evd", 10);
      const now = Date.now();
      const stats: PinStats[] = [];
      const r = await pruneLlmTrace(root, {
        keepPerSession: 2,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set(["web-evd"])),
        onPinStats: (s) => stats.push(s),
      });
      expect(r.removed).toBe(0);
      expect(r.pinned).toBe(10);
      expect(readdirSync(join(root, "web-evd")).length).toBe(10);
      expect(stats.at(-1)).toMatchObject({ pinned: 10, dropped: 0, migrated: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("B) 窗口内(缺省 7 天)→ PIN_WINDOW,超份数也不删", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-window-"));
    try {
      seed(root, "web-now", 5, Date.now() - 5000);
      const now = Date.now();
      const r = await pruneLlmTrace(root, {
        keepPerSession: 1,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set()),
      });
      expect(r.removed).toBe(0);
      expect(r.pinned).toBe(5);
      expect(readdirSync(join(root, "web-now")).length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("C) 窗口外且无引用 → 按份数 DROP", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-drop-"));
    try {
      seed(root, "web-old", 10);
      const now = Date.now();
      const r = await pruneLlmTrace(root, {
        keepPerSession: 2,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set()),
      });
      expect(r.removed).toBe(8);
      expect(r.kept).toBe(2);
      expect(r.pinned).toBe(0);
      expect(readdirSync(join(root, "web-old")).length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("D) 行数远超上限但 pinned → 一份不删(pinned 不占份数配额)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-over-"));
    try {
      seed(root, "web-evd", 300);
      const now = Date.now();
      const r = await pruneLlmTrace(root, {
        keepPerSession: 5,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set(["web-evd"])),
      });
      expect(r.removed).toBe(0);
      expect(r.pinned).toBe(300);
      expect(readdirSync(join(root, "web-evd")).length).toBe(300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("D2) 总量超限:pinned 自身超上限仍不删,只回 pinnedOverBudget + 非 pinned 先删", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-bytes-"));
    try {
      seed(root, "web-evd", 2, OLD_BASE, 600); // 2×~600B,pinned
      seed(root, "web-plain", 3, OLD_BASE + 500_000, 400); // 3×~400B,可删
      const now = Date.now();
      const stats: PinStats[] = [];
      const r = await pruneLlmTrace(root, {
        keepPerSession: 100, // 份数不参与,只看总量
        maxBytes: 1000,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set(["web-evd"])),
        onPinStats: (s) => stats.push(s),
      });
      expect(r.pinned).toBe(2);
      expect(r.removed).toBe(3); // 非 pinned 全被删
      expect(readdirSync(join(root, "web-evd")).length).toBe(2); // pinned 全在
      expect(readdirSync(join(root, "web-plain")).length).toBe(0);
      expect(stats.at(-1)?.pinnedOverBudget).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("E) 混合:证据 session 全留、窗口 session 全留、窗口外无引用按份数删", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-mixed-"));
    try {
      seed(root, "s-evd", 3);
      seed(root, "s-win", 3, Date.now() - 3000);
      seed(root, "s-old", 3);
      const now = Date.now();
      const r = await pruneLlmTrace(root, {
        keepPerSession: 1,
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set(["s-evd"])),
      });
      expect(r.pinned).toBe(6);
      expect(r.removed).toBe(2);
      expect(r.kept).toBe(7);
      expect(readdirSync(join(root, "s-evd")).length).toBe(3);
      expect(readdirSync(join(root, "s-win")).length).toBe(3);
      expect(readdirSync(join(root, "s-old")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("钉扎判定抛错 → 保守视为 pin(宁可不删,不静默删掉可能被引用的现场)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-pin-throw-"));
    try {
      seed(root, "web-a", 5);
      const r = await pruneLlmTrace(root, {
        keepPerSession: 1,
        shouldPin: () => {
          throw new Error("evidence graph broken");
        },
      });
      expect(r.removed).toBe(0);
      expect(r.pinned).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("protectPath 与 pin 共存:受保护文件不重复计数、不删", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-protect-"));
    try {
      const paths = seed(root, "web-a", 10);
      const now = Date.now();
      const r = await pruneLlmTrace(root, {
        keepPerSession: 2,
        protectPath: paths[0]!, // 最老的一份:正常必删,受保护必须留
        shouldPin: pinClosure(now, miningWindowStart({ now }), new Set()),
      });
      expect(r.removed).toBe(7);
      expect(r.kept).toBe(3);
      expect(existsSync(paths[0]!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F) 旧兼容:不传 shouldPin → 返回结构不新增键,删除数与旧口径一致", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compat-"));
    try {
      seed(root, "web-a", 250);
      const r = await pruneLlmTrace(root);
      expect(Object.keys(r).sort()).toEqual(["kept", "removed"]);
      expect(r.removed).toBe(50); // 旧实现:250 → 留默认 200
      expect(r.kept).toBe(200);
      expect(r.pinned).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("F2) 传了 shouldPin 但全部 false → 删除数与旧口径一致(pin 不改变未钉扎文件的处置)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-compat2-"));
    try {
      seed(root, "web-a", 250);
      const r = await pruneLlmTrace(root, { shouldPin: () => ({ pin: false }) });
      expect(r.removed).toBe(50);
      expect(r.kept).toBe(200);
      expect(r.pinned).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("目录不存在:仍 resolve 且返回结构与是否传 shouldPin 一致(旁路不抛)", async () => {
    const missing = join(tmpdir(), "trace-none-" + Math.random().toString(36).slice(2));
    await expect(pruneLlmTrace(missing)).resolves.toEqual({ removed: 0, kept: 0 });
    await expect(pruneLlmTrace(missing, { shouldPin: () => ({ pin: true }) })).resolves.toEqual({
      removed: 0,
      kept: 0,
      pinned: 0,
    });
  });
});

describe("migrateEvidenceTraces(证据区迁移)", () => {
  it("证据 session 的轨迹复制到 .genie/evidence/traces/<session>/<file>,原文件不动", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-mig-"));
    try {
      const traceRoot = join(root, "llm-trace");
      const evidenceRoot = join(root, "repo");
      seed(traceRoot, "web-evd", 2);
      seed(traceRoot, "web-plain", 2);
      const r = await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions: new Set(["web-evd"]) });
      expect(r.migrated).toBe(2);
      const dstDir = join(evidenceRoot, ".genie", "evidence", "traces", "web-evd");
      expect(readdirSync(dstDir).length).toBe(2);
 // 原处文件仍在(迁移=复制,不搬走)
      expect(readdirSync(join(traceRoot, "web-evd")).length).toBe(2);
 // 未引用的 session 不迁移
      expect(existsSync(join(evidenceRoot, ".genie", "evidence", "traces", "web-plain"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("已存在跳过(幂等):第二次调用 migrated=0 / skipped>0", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-mig-idem-"));
    try {
      const traceRoot = join(root, "llm-trace");
      const evidenceRoot = join(root, "repo");
      seed(traceRoot, "web-evd", 2);
      const sessions = new Set(["web-evd"]);
      await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions });
      const second = await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions });
      expect(second.migrated).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.failed).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("单文件超上限跳过(不搬也仍被 pin 在原文)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-mig-big-"));
    try {
      const traceRoot = join(root, "llm-trace");
      const evidenceRoot = join(root, "repo");
      seed(traceRoot, "web-evd", 3, OLD_BASE, 200);
      const r = await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions: new Set(["web-evd"]), maxBytes: 50 });
      expect(r.migrated).toBe(0);
      expect(r.skipped).toBe(3);
      expect(existsSync(join(evidenceRoot, ".genie", "evidence", "traces", "web-evd"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("证据集为空:零动作、不建目录、不抛", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-mig-empty-"));
    try {
      const traceRoot = join(root, "llm-trace");
      const evidenceRoot = join(root, "repo");
      seed(traceRoot, "web-evd", 2);
      const r = await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions: new Set() });
      expect(r).toEqual({ migrated: 0, skipped: 0, failed: 0 });
      expect(existsSync(join(evidenceRoot, ".genie"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("迁移目标路径由 migratePathFor 派生(与策略层同口径)", async () => {
    const root = mkdtempSync(join(tmpdir(), "trace-mig-path-"));
    try {
      const traceRoot = join(root, "llm-trace");
      const evidenceRoot = join(root, "repo");
      const paths = seed(traceRoot, "web-evd", 1);
      await migrateEvidenceTraces({ traceRoot, evidenceRoot, sessions: new Set(["web-evd"]) });
      const name = paths[0]!.split("/").pop()!;
      expect(existsSync(migratePathFor(evidenceRoot, "web-evd", name))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collectEvidenceSessions(证据图 → sessionId 集)", () => {
  it("证据图不存在 → 空集且不抛(fail-soft:只靠窗口钉扎)", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-evd-empty-"));
    try {
      expect(collectEvidenceSessions(root)).toEqual(new Set());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("坏行/空文件 → 空集不抛(投影层跳过坏行)", () => {
    const root = mkdtempSync(join(tmpdir(), "trace-evd-bad-"));
    try {
      mkdirSync(join(root, ".genie", "evidence"), { recursive: true });
      writeFileSync(join(root, ".genie", "evidence", "graph.jsonl"), "{not json}\n\n", "utf-8");
      expect(collectEvidenceSessions(root)).toEqual(new Set());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
