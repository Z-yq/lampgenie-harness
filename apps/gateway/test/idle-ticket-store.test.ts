/**
 * 闲时算力票据持久层:.genie/rsi/idle-tickets.json 原子写 / 读失败拒写 / 业务拒绝零副作用。
 * 每个用例用独立临时根目录,不碰仓内 .genie。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimOnDisk,
  continueExpiredOnDisk,
  createTicketOnDisk,
  dispatchRoundOnDisk,
  expireOnDisk,
  getTicketOnDisk,
  IDLE_TICKET_FILE,
  IDLE_TICKET_RELATIVE_DIR,
  idleTicketPaths,
  IDLE_REJECTION_CODES,
  isIdleRejection,
  makeReadyOnDisk,
  pollOnDisk,
  readTicketStore,
  reclaimStaleOnDisk,
  reportTickets,
  settleOnDisk,
  writeTicketStore,
} from "../src/idle-ticket-store.ts";
import { emptyTicketStore, IDLE_DEFAULT_MAX_ACTIVE_MS, IDLE_DEFAULT_READY_DEADLINE_MS } from "@lampgenie/runtime/agent/idle-ticket";

const T0 = 1_700_000_000_000;
const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "idle-ticket-"));
  roots.push(root);
  return root;
}

function ledger(root: string): { v: number; tickets: Record<string, { id: string; ticketStatus: string; localStatus: string; revision: number; settledAt?: number }> } {
  return JSON.parse(readFileSync(idleTicketPaths(root).file, "utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("路径与坏输入", () => {
  it("路径落在 .genie/rsi/idle-tickets.json", () => {
    const paths = idleTicketPaths("/repo");
    expect(paths.dir).toBe("/repo/.genie/rsi");
    expect(paths.file).toBe("/repo/.genie/rsi/idle-tickets.json");
    expect(IDLE_TICKET_RELATIVE_DIR).toBe(".genie/rsi");
    expect(IDLE_TICKET_FILE).toBe("idle-tickets.json");
  });

  it("root 非法 → TypeError;now 非法 → TypeError", () => {
    expect(() => idleTicketPaths("")).toThrow(TypeError);
    expect(() => readTicketStore(" ")).toThrow(TypeError);
    const root = newRoot();
    expect(() => createTicketOnDisk(root, { sessionId: "s1", now: -5 })).toThrow(TypeError);
    expect(() => pollOnDisk(root, { now: Number.NaN })).toThrow(TypeError);
  });

  it("账本不存在 = 空账本且 ok,首次写自动建目录", () => {
    const root = newRoot();
    const read = readTicketStore(root);
    expect(read.ok).toBe(true);
    expect(read.exists).toBe(false);
    expect(read.store.tickets).toEqual({});
    // 空账本写一次也要能建目录
    expect(writeTicketStore(root, emptyTicketStore()).ok).toBe(true);
    expect(existsSync(idleTicketPaths(root).file)).toBe(true);
  });
});

describe("create:先取票再落库", () => {
  it("创建即落盘,JSON 带版本与票据", () => {
    const root = newRoot();
    const r = createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    expect(r.code).toBe("IDLE_CREATED");
    expect(r.persisted).toBe(true);
    const data = ledger(root);
    expect(data.v).toBe(1);
    expect(data.tickets["t1"]?.id).toBe("t1");
    expect(data.tickets["t1"]?.localStatus).toBe("queued");
  });

  it("原子写不留临时文件", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0 });
    const files = readdirSync(idleTicketPaths(root).dir);
    expect(files).toEqual(["idle-tickets.json"]);
  });

  it("同会话重复创建 → PENDING_EXISTS 且不写盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    const before = readFileSync(idleTicketPaths(root).file, "utf8");
    const r = createTicketOnDisk(root, { sessionId: "s1", now: T0 + 1, id: "t2" });
    expect(r.code).toBe("IDLE_PENDING_EXISTS");
    expect(r.persisted).toBe(false);
    expect(readFileSync(idleTicketPaths(root).file, "utf8")).toBe(before);
    expect(getTicketOnDisk(root, "t2").ticket).toBeUndefined();
  });

  it("额度不足 → QUOTA_EXHAUSTED 且账本文件都不建", () => {
    const root = newRoot();
    const r = createTicketOnDisk(root, { sessionId: "s1", now: T0, budgetOk: false });
    expect(r.code).toBe("IDLE_QUOTA_EXHAUSTED");
    expect(r.persisted).toBe(false);
    expect(existsSync(idleTicketPaths(root).file)).toBe(false);
  });

  it("多会话各自独立落盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    createTicketOnDisk(root, { sessionId: "s2", now: T0, id: "t2" });
    const data = ledger(root);
    expect(Object.keys(data.tickets).sort()).toEqual(["t1", "t2"]);
    expect(Object.keys(reportTickets(root, { now: T0 }).pendingBySession).sort()).toEqual(["s1", "s2"]);
  });
});

describe("状态推进全链路落盘", () => {
  it("queued → ready → active → settled(ok) 每步重读一致", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });

    const ready = makeReadyOnDisk(root, { id: "t1", now: T0 });
    expect(ready.code).toBe("IDLE_READY");
    expect(ledger(root).tickets["t1"]?.ticketStatus).toBe("ready");

    const claimed = claimOnDisk(root, { id: "t1", now: T0 + 10 });
    expect(claimed.code).toBe("IDLE_CLAIMED");
    expect(ledger(root).tickets["t1"]?.ticketStatus).toBe("active");

    const settled = settleOnDisk(root, { id: "t1", outcome: "ok", now: T0 + 20 });
    expect(settled.code).toBe("IDLE_SETTLED");
    expect(ledger(root).tickets["t1"]?.localStatus).toBe("done");
    expect(ledger(root).tickets["t1"]?.settledAt).toBe(T0 + 20);
  });

  it("queued 直接 claim → NOT_SCHEDULABLE 且账本不变", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    const before = readFileSync(idleTicketPaths(root).file, "utf8");
    const r = claimOnDisk(root, { id: "t1", now: T0 + 1 });
    expect(r.code).toBe("IDLE_NOT_SCHEDULABLE");
    expect(r.persisted).toBe(false);
    expect(readFileSync(idleTicketPaths(root).file, "utf8")).toBe(before);
  });

  it("settle 5xx 保持 active 可重试,4xx 幂等重放不再写盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0 });
    claimOnDisk(root, { id: "t1", now: T0 + 1 });

    const retry = settleOnDisk(root, { id: "t1", outcome: "5xx", now: T0 + 2 });
    expect(retry.code).toBe("IDLE_RETRY_PENDING");
    expect(ledger(root).tickets["t1"]?.ticketStatus).toBe("active");

    const ack = settleOnDisk(root, { id: "t1", outcome: "4xx", now: T0 + 3 });
    expect(ack.code).toBe("IDLE_SETTLED");
    const text = readFileSync(idleTicketPaths(root).file, "utf8");
    const replay = settleOnDisk(root, { id: "t1", outcome: "4xx", now: T0 + 4 });
    expect(replay.code).toBe("IDLE_SETTLED");
    expect(replay.detail?.["idempotent"]).toBe(true);
    expect(readFileSync(idleTicketPaths(root).file, "utf8")).toBe(text);
  });

  it("expire + continue 补号写盘,新票带 continuedFrom", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0, deadlineMs: 10 });
    expect(expireOnDisk(root, { id: "t1", now: T0 + 100 }).code).toBe("IDLE_EXPIRED");
    const cont = continueExpiredOnDisk(root, { id: "t1", now: T0 + 200, newId: "t1b" });
    expect(cont.code).toBe("IDLE_CONTINUED");
    const data = ledger(root) as unknown as { tickets: Record<string, { continuedFrom?: string }> };
    expect(data.tickets["t1b"]?.continuedFrom).toBe("t1");
  });

  it("过 deadline 的 ready 在 claim 时就地过期并落盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0, deadlineMs: 1_000 });
    const r = claimOnDisk(root, { id: "t1", now: T0 + 1_001 });
    expect(r.code).toBe("IDLE_EXPIRED");
    expect(ledger(root).tickets["t1"]?.ticketStatus).toBe("expired");
  });

  it("reclaimStale 超租期回收 → queued 且落盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0, deadlineMs: IDLE_DEFAULT_READY_DEADLINE_MS });
    claimOnDisk(root, { id: "t1", now: T0 + 1 });
    const r = reclaimStaleOnDisk(root, { now: T0 + 1 + IDLE_DEFAULT_MAX_ACTIVE_MS + 1 });
    expect(r.code).toBe("IDLE_RECLAIMED");
    expect(r.persisted).toBe(true);
    expect(ledger(root).tickets["t1"]?.ticketStatus).toBe("queued");
  });

  it("无僵尸票时 reclaim 不写盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    const r = reclaimStaleOnDisk(root, { now: T0 + 10 });
    expect(r.reclaimed).toHaveLength(0);
    expect(r.persisted).toBe(false);
  });
});

describe("只读视图:poll / dispatch / report", () => {
  it("pollOnDisk 返回间隔裁决与 pendingIds,不写盘", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    const before = readFileSync(idleTicketPaths(root).file, "utf8");
    const wait = pollOnDisk(root, { lastPollAt: T0, now: T0 + 1_000 });
    expect(wait.code).toBe("IDLE_POLL_WAIT");
    expect(wait.pendingIds).toEqual(["t1"]);
    const due = pollOnDisk(root, { lastPollAt: T0, now: T0 + 60_000 });
    expect(due.code).toBe("IDLE_POLL_DUE");
    expect(readFileSync(idleTicketPaths(root).file, "utf8")).toBe(before);
  });

  it("dispatchRoundOnDisk 有 active 时拒绝并点名", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0 });
    claimOnDisk(root, { id: "t1", now: T0 + 1 });
    const r = dispatchRoundOnDisk(root);
    expect(r.code).toBe("IDLE_DISPATCH_REJECTED");
    expect(r.blockingIds).toEqual(["t1"]);
  });

  it("dispatchRoundOnDisk 空账本放行", () => {
    const root = newRoot();
    const r = dispatchRoundOnDisk(root);
    expect(r.ok).toBe(true);
    expect(r.rejected).toBe(false);
  });

  it("reportTickets 给计数 / 僵尸 active / 路径", () => {
    const root = newRoot();
    createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    makeReadyOnDisk(root, { id: "t1", now: T0 });
    claimOnDisk(root, { id: "t1", now: T0 + 1 });
    const report = reportTickets(root, { now: T0 + 1 + IDLE_DEFAULT_MAX_ACTIVE_MS + 1 });
    expect(report.ok).toBe(true);
    expect(report.file).toBe(idleTicketPaths(root).file);
    expect(report.total).toBe(1);
    expect(report.byTicketStatus.active).toBe(1);
    expect(report.staleActive.map((t) => t.id)).toEqual(["t1"]);
    expect(report.tickets).toHaveLength(1);
  });
});

describe("坏账本:读失败拒写,坏条目不炸", () => {
  it("JSON 坏 → read ok:false,写操作拒写且原文件保留", () => {
    const root = newRoot();
    const paths = idleTicketPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.file, "{oops", "utf8");
    const read = readTicketStore(root);
    expect(read.ok).toBe(false);
    expect(read.codes).toContain("IDLE_STORE_ERROR");
    const r = createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" });
    expect(r.code).toBe("IDLE_STORE_ERROR");
    expect(r.persisted).toBe(false);
    expect(readFileSync(paths.file, "utf8")).toBe("{oops");
  });

  it("坏条目被丢弃(dropped),好票据照常可读", () => {
    const root = newRoot();
    const paths = idleTicketPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(
      paths.file,
      JSON.stringify({
        v: 1,
        tickets: {
          good: { id: "good", sessionId: "s1", localStatus: "queued", ticketStatus: "queued", createdAt: T0, updatedAt: T0, revision: 1, attempts: 0 },
          bad: { id: "bad", sessionId: "", localStatus: "queued", ticketStatus: "queued", createdAt: T0, updatedAt: T0 },
        },
        bySession: { s1: ["good", "bad"] },
      }),
      "utf8",
    );
    const report = reportTickets(root, { now: T0 });
    expect(report.ok).toBe(true);
    expect(report.tickets.map((t) => t.id)).toEqual(["good"]);
    expect(report.dropped).toEqual(["bad"]);
  });

  it("空文件视为空账本,不阻塞后续写入", () => {
    const root = newRoot();
    const paths = idleTicketPaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.file, "", "utf8");
    expect(readTicketStore(root).ok).toBe(true);
    expect(createTicketOnDisk(root, { sessionId: "s1", now: T0, id: "t1" }).persisted).toBe(true);
  });
});

describe("业务拒绝码集合", () => {
  it("五个拒绝码映射 exit 2,其它不算", () => {
    expect(IDLE_REJECTION_CODES).toHaveLength(5);
    for (const code of IDLE_REJECTION_CODES) expect(isIdleRejection(code)).toBe(true);
    expect(isIdleRejection("IDLE_CREATED")).toBe(false);
    expect(isIdleRejection("IDLE_STORE_ERROR")).toBe(false);
  });
});
