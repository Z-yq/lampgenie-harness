/**
 * 改派导入持久层:.genie/rsi/amend.json 原子写 / 读失败拒写 / 跨进程单调(diverged、closed)。
 * 每个用例用独立临时根目录,不碰仓内 .genie。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AMEND_FILE,
  AMEND_RELATIVE_DIR,
  AMEND_STORE_ERROR,
  amendPaths,
  buildFromFile,
  closeOnDisk,
  emptyAmendLedger,
  isAmendRejection,
  matchOnDisk,
  precheckFromFile,
  readAmendStore,
  reportAmendStore,
  resumeOnDisk,
  writeAmendStore,
} from "../src/amend-import-store.ts";
import {
  AMEND_BOUNDARY_MISSING,
  AMEND_DOOR_CLOSED,
  AMEND_FALLBACK_LIVE,
  AMEND_HASH_DIVERGED,
  AMEND_HIT,
  AMEND_INVALID,
  AMEND_MISS,
  AMEND_PRECHECK_OK,
  AMEND_RUN_MISSING,
  AMEND_SKIP_SETTLEMENT,
  AMEND_TARGET_DIRTY,
} from "@lampgenie/runtime/agent/amend-import";

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "amend-import-"));
  roots.push(root);
  return root;
}

function ledgerFile(root: string): string {
  return amendPaths(root).file;
}

type RawLedger = {
  v: number;
  run?: { runId: string; exists: boolean; asks: { id: string }[] };
  precheck?: { ok: boolean; codes: string[] } | null;
  cache?: { actorPrefix: Record<string, { id: string; toolCalls?: number }[]>; closed: boolean } | null;
  diverged?: string[];
  resume?: { mode: string; codes: string[] } | null;
  lastAction?: string;
  updatedAt?: number;
};

function ledger(root: string): RawLedger {
  return JSON.parse(readFileSync(ledgerFile(root), "utf8")) as RawLedger;
}

function writeRun(root: string, name: string, run: unknown): string {
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(run, null, 2), "utf8");
  return file;
}

/** 单 ask 的干净 run(completed + boundary)。 */
function cleanRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "r1",
    exists: true,
    asks: [{ id: "a1", actor: "u1", status: "completed", messageBoundary: "m1", payloadHash: "h1", toolCalls: 0 }],
    worldQueue: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("路径与坏输入", () => {
  it("路径落在 .genie/rsi/amend.json", () => {
    const paths = amendPaths("/repo");
    expect(paths.dir).toBe("/repo/.genie/rsi");
    expect(paths.file).toBe("/repo/.genie/rsi/amend.json");
    expect(AMEND_RELATIVE_DIR).toBe(".genie/rsi");
    expect(AMEND_FILE).toBe("amend.json");
  });

  it("root / 动作入参非法 → TypeError", () => {
    expect(() => amendPaths("")).toThrow(TypeError);
    expect(() => readAmendStore(" ")).toThrow(TypeError);
    const root = newRoot();
    expect(() => precheckFromFile(root, "")).toThrow(TypeError);
    expect(() => matchOnDisk(root, { actor: "", askId: "a1" })).toThrow(TypeError);
    expect(() => matchOnDisk(root, { actor: "u1", askId: "" })).toThrow(TypeError);
    expect(() => closeOnDisk(root, { worldToolCalls: Number.NaN })).toThrow(TypeError);
  });

  it("账本不存在 = 空账本且 ok,首次写自动建目录", () => {
    const root = newRoot();
    const read = readAmendStore(root);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(false);
    expect(read.ledger.diverged).toEqual([]);
    const w = writeAmendStore(root, { ...emptyAmendLedger(), lastAction: "probe" });
    expect(w.ok).toBe(true);
    expect(existsSync(ledgerFile(root))).toBe(true);
  });
});

describe("原子写与坏账本拒写", () => {
  it("写盘 JSON 可解析、带版本/时间戳,且不留临时文件", () => {
    const root = newRoot();
    const w = writeAmendStore(root, { ...emptyAmendLedger(), run: { runId: "r9", exists: true, asks: [], worldQueue: [] }, lastAction: "probe" });
    expect(w.ok).toBe(true);
    expect(w.persisted).toBe(true);
    const data = ledger(root);
    expect(data.v).toBe(1);
    expect(data.lastAction).toBe("probe");
    expect(typeof data.updatedAt).toBe("number");
    expect(data.run?.runId).toBe("r9");
    expect(readdirSync(amendPaths(root).dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("坏 JSON → AMEND_STORE_ERROR 且拒写(文件一个字节都不动)", () => {
    const root = newRoot();
    const file = ledgerFile(root);
    mkdirSync(amendPaths(root).dir, { recursive: true });
    writeFileSync(file, "{ this is not json", "utf8");
    const read = readAmendStore(root);
    expect(read.ok).toBe(false);
    expect(read.codes).toContain(AMEND_STORE_ERROR);
    const w = writeAmendStore(root, { ...emptyAmendLedger(), lastAction: "blocked" });
    expect(w.ok).toBe(false);
    expect(w.persisted).toBe(false);
    expect(w.codes).toContain(AMEND_STORE_ERROR);
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
    // 动作层同样拒写
    const root2 = newRoot();
    mkdirSync(amendPaths(root2).dir, { recursive: true });
    writeFileSync(ledgerFile(root2), "[1,2,3]", "utf8");
    const built = buildFromFile(root2, writeRun(root2, "run", cleanRun()));
    expect(built.ok).toBe(false);
    expect(built.codes).toContain(AMEND_STORE_ERROR);
    expect(readFileSync(ledgerFile(root2), "utf8")).toBe("[1,2,3]");
  });

  it("形状坏(v 不对)→ AMEND_STORE_ERROR", () => {
    const root = newRoot();
    mkdirSync(amendPaths(root).dir, { recursive: true });
    writeFileSync(ledgerFile(root), JSON.stringify({ v: 2, diverged: [] }), "utf8");
    const read = readAmendStore(root);
    expect(read.ok).toBe(false);
    expect(read.codes).toContain(AMEND_STORE_ERROR);
  });
});

describe("precheckFromFile", () => {
  it("预检通过 → 落盘 run + precheck,lastAction=precheck", () => {
    const root = newRoot();
    const r = precheckFromFile(root, writeRun(root, "run", cleanRun()));
    expect(r.ok).toBe(true);
    expect(r.codes).toContain(AMEND_PRECHECK_OK);
    expect(r.persisted).toBe(true);
    expect(r.stopped).toBe(true);
    expect(r.pending).toEqual([]);
    const data = ledger(root);
    expect(data.lastAction).toBe("precheck");
    expect(data.run?.runId).toBe("r1");
    expect(data.precheck?.ok).toBe(true);
    expect(data.precheck?.codes).toContain(AMEND_PRECHECK_OK);
  });

  it("completed ask 缺 messageBoundary → BOUNDARY_MISSING,且不动前驱(stopped=false)", () => {
    const root = newRoot();
    const run = cleanRun({ asks: [{ id: "a1", actor: "u1", status: "completed" }] });
    const r = precheckFromFile(root, writeRun(root, "run", run));
    expect(r.ok).toBe(false);
    expect(r.codes).toContain(AMEND_BOUNDARY_MISSING);
    expect(r.stopped).toBe(false);
    expect(r.detail?.["stopped"]).toBe(false);
    expect(ledger(root).precheck?.codes).toContain(AMEND_BOUNDARY_MISSING);
  });

  it("run 文件不存在 → AMEND_STORE_ERROR(不落盘)", () => {
    const root = newRoot();
    const r = precheckFromFile(root, join(root, "missing.json"));
    expect(r.ok).toBe(false);
    expect(r.codes).toContain(AMEND_STORE_ERROR);
    expect(r.persisted).toBe(false);
    expect(existsSync(ledgerFile(root))).toBe(false);
  });

  it("target.history 含外来 id + --target-session → TARGET_DIRTY", () => {
    const root = newRoot();
    const run = cleanRun({ target: { sessionId: "", seeds: [], history: ["other-1"] } });
    const r = precheckFromFile(root, writeRun(root, "run", run), { targetSessionId: "s1" });
    expect(r.ok).toBe(false);
    expect(r.codes).toContain(AMEND_TARGET_DIRTY);
    expect(r.stopped).toBe(false);
  });
});

describe("buildFromFile", () => {
  it("按最长全 completed 前缀截断:completed/running/completed → 只收第一个", () => {
    const root = newRoot();
    const run = cleanRun({
      asks: [
        { id: "a1", actor: "u1", status: "completed", messageBoundary: "m1", payloadHash: "h1" },
        { id: "a2", actor: "u1", status: "running" },
        { id: "a3", actor: "u1", status: "completed", messageBoundary: "m3", payloadHash: "h3" },
      ],
    });
    const r = buildFromFile(root, writeRun(root, "run", run));
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
    expect(r.cacheActors).toBe(1);
    expect(r.cacheAsks).toBe(1);
    const data = ledger(root);
    expect(data.lastAction).toBe("build");
    expect(data.cache?.actorPrefix["u1"]?.map((ask) => ask.id)).toEqual(["a1"]);
  });

  it("账本里没有 run → AMEND_INVALID", () => {
    const root = newRoot();
    const r = buildFromFile(root);
    expect(r.ok).toBe(false);
    expect(r.codes).toContain(AMEND_INVALID);
    expect(r.persisted).toBe(false);
  });

  it("从账本里已落盘的 run 建缓存(不传 runFile)", () => {
    const root = newRoot();
    expect(precheckFromFile(root, writeRun(root, "run", cleanRun())).persisted).toBe(true);
    const r = buildFromFile(root);
    expect(r.ok).toBe(true);
    expect(r.cacheAsks).toBe(1);
    expect(ledger(root).cache?.actorPrefix["u1"]?.[0]?.id).toBe("a1");
  });
});

describe("matchOnDisk", () => {
  it("命中 → HIT + imported 节点形态,lastAction=match", () => {
    const root = newRoot();
    buildFromFile(root, writeRun(root, "run", cleanRun()));
    const r = matchOnDisk(root, { actor: "u1", askId: "a1", payloadHash: "h1" });
    expect(r.ok).toBe(true);
    expect(r.hit).toBe(true);
    expect(r.codes).toContain(AMEND_HIT);
    expect(r.node).toMatchObject({ id: "a1", kind: "imported", actor: "u1", messageBoundary: "m1", payloadHash: "h1", toolCalls: 0 });
    expect(ledger(root).lastAction).toBe("match");
  });

  it("hash 不符 → HASH_DIVERGED 且 diverged 落盘;第二次仍 DIVERGED(不回落 HIT)", () => {
    const root = newRoot();
    buildFromFile(root, writeRun(root, "run", cleanRun()));
    const first = matchOnDisk(root, { actor: "u1", askId: "a1", payloadHash: "h-other" });
    expect(first.ok).toBe(false);
    expect(first.hit).toBe(false);
    expect(first.codes).toContain(AMEND_HASH_DIVERGED);
    expect(first.persisted).toBe(true);
    expect(ledger(root).diverged).toEqual(["a1"]);
    // 跨进程:换一个新调用(重新读账本),这次 hash 对上了也必须仍 DIVERGED
    const second = matchOnDisk(root, { actor: "u1", askId: "a1", payloadHash: "h1" });
    expect(second.ok).toBe(false);
    expect(second.hit).toBe(false);
    expect(second.codes).toEqual([AMEND_HASH_DIVERGED]);
    expect(readAmendStore(root).ledger.diverged).toEqual(["a1"]);
  });

  it("条目不在缓存里 → MISS", () => {
    const root = newRoot();
    buildFromFile(root, writeRun(root, "run", cleanRun()));
    const r = matchOnDisk(root, { actor: "u1", askId: "nope", payloadHash: "h1" });
    expect(r.ok).toBe(false);
    expect(r.hit).toBe(false);
    expect(r.codes[0]).toBe(AMEND_MISS);
  });
});

describe("closeOnDisk", () => {
  it("写过世界后:纯 ask 仍 HIT,带 toolCalls 的 → DOOR_CLOSED(落盘跨进程)", () => {
    const root = newRoot();
    const run = cleanRun({
      asks: [
        { id: "a1", actor: "u1", status: "completed", messageBoundary: "m1", payloadHash: "h1", toolCalls: 0 },
        { id: "a2", actor: "u1", status: "completed", messageBoundary: "m2", payloadHash: "h2", toolCalls: 2 },
      ],
    });
    buildFromFile(root, writeRun(root, "run", run));
    const closed = closeOnDisk(root, { worldToolCalls: 3 });
    expect(closed.ok).toBe(true);
    expect(closed.closed).toBe(true);
    expect(closed.persisted).toBe(true);
    expect(ledger(root).cache?.closed).toBe(true);
    expect(ledger(root).lastAction).toBe("close");
    const pure = matchOnDisk(root, { actor: "u1", askId: "a1", payloadHash: "h1" });
    expect(pure.hit).toBe(true);
    const dirty = matchOnDisk(root, { actor: "u1", askId: "a2", payloadHash: "h2" });
    expect(dirty.ok).toBe(false);
    expect(dirty.hit).toBe(false);
    expect(dirty.codes).toEqual([AMEND_DOOR_CLOSED]);
    // 关门是持久的:重新读账本仍是 closed
    expect(readAmendStore(root).ledger.cache?.closed).toBe(true);
  });

  it("world-calls 0 → 门不动", () => {
    const root = newRoot();
    buildFromFile(root, writeRun(root, "run", cleanRun()));
    const r = closeOnDisk(root, { worldToolCalls: 0 });
    expect(r.ok).toBe(true);
    expect(r.closed).toBe(false);
  });
});

describe("resumeOnDisk / report / 拒绝码", () => {
  it("cacheOk:false → FALLBACK_LIVE(live 降级不算失败)", () => {
    const root = newRoot();
    const r = resumeOnDisk(root, { cacheOk: false });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("live");
    expect(r.codes).toContain(AMEND_FALLBACK_LIVE);
    expect(ledger(root).resume?.mode).toBe("live");
  });

  it("cacheOk:true → cache 重放", () => {
    const root = newRoot();
    const r = resumeOnDisk(root, { cacheOk: true });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("cache");
    expect(ledger(root).resume?.mode).toBe("cache");
  });

  it("reportAmendStore 摘要数字对得上", () => {
    const root = newRoot();
    const run = cleanRun({
      asks: [
        { id: "a1", actor: "u1", status: "completed", messageBoundary: "m1", payloadHash: "h1", toolCalls: 0 },
        { id: "a2", actor: "u1", status: "running" },
        { id: "a3", actor: "u2", status: "failed" },
      ],
      worldQueue: [{ id: "w1", payloadHash: "wh1" }],
    });
    precheckFromFile(root, writeRun(root, "run", run));
    buildFromFile(root);
    matchOnDisk(root, { actor: "u1", askId: "a1", payloadHash: "h1" });
    closeOnDisk(root, { worldToolCalls: 1 });
    resumeOnDisk(root, { cacheOk: true });
    const report = reportAmendStore(root);
    expect(report.ok).toBe(true);
    expect(report.file).toBe(ledgerFile(root));
    expect(report.runId).toBe("r1");
    expect(report.asks).toEqual({ completed: 1, running: 1, failed: 1 });
    expect(report.cacheActors).toBe(1);
    expect(report.cacheAsks).toBe(1);
    expect(report.worldQueue).toBe(1);
    expect(report.closed).toBe(true);
    expect(report.diverged).toEqual([]);
    expect(report.precheckCode).toBe(AMEND_PRECHECK_OK);
    expect(report.resumeMode).toBe("cache");
  });

  it("坏账本 → report ok:false + AMEND_STORE_ERROR", () => {
    const root = newRoot();
    mkdirSync(amendPaths(root).dir, { recursive: true });
    writeFileSync(ledgerFile(root), "{oops", "utf8");
    const report = reportAmendStore(root);
    expect(report.ok).toBe(false);
    expect(report.codes).toContain(AMEND_STORE_ERROR);
    expect(report.asks).toEqual({ completed: 0, running: 0, failed: 0 });
  });

  it("isAmendRejection 只认业务拒绝码", () => {
    for (const code of [
      AMEND_HASH_DIVERGED,
      AMEND_DOOR_CLOSED,
      AMEND_RUN_MISSING,
      AMEND_BOUNDARY_MISSING,
      "AMEND_TARGET_DIRTY",
      "AMEND_SKIP_SETTLEMENT",
      AMEND_INVALID,
    ]) {
      expect(isAmendRejection(code)).toBe(true);
    }
    for (const code of [AMEND_HIT, AMEND_MISS, AMEND_PRECHECK_OK, AMEND_FALLBACK_LIVE, AMEND_STORE_ERROR, "AMEND_STORE_WRITE_MISMATCH"]) {
      expect(isAmendRejection(code)).toBe(false);
    }
  });
});
