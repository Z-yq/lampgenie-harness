/**
 * stream-ticket-store 的单测:全部用 mkdtempSync 临时根,绝不碰仓库 .genie。
 * 覆盖:路径口径 / 跨调用持久化 / 非法绑定不写盘 / 消费落盘 / replay 不改写 /
 * 绑定不匹配不消费 / 过期标记落盘 / prune 幂等 / allowUrl 放行与重放 / report 视图 /
 * 坏文件折叠且写操作拒绝 / 原子写不残留 tmp。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  allowUrl,
  consume,
  issue,
  loadTickets,
  prune,
  reportTickets,
  STREAM_TICKET_STORE_CODES,
  ticketsPath,
} from "../src/stream-ticket-store.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stream-ticket-store-"));
  roots.push(root);
  return root;
}

function binding(overrides: Partial<{ ptyId: string; directory: string; workspaceId: string }> = {}) {
  return { ptyId: "pty-1", directory: "/w", workspaceId: "ws-1", ...overrides };
}

function readFileJson(root: string): { version: number; tickets: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(ticketsPath(root), "utf8"));
}

afterEach(() => {
  roots.length = 0;
});

describe("ticketsPath", () => {
  it("指向 <root>/.genie/rsi/tickets.json", () => {
    const root = tempRoot();
    expect(ticketsPath(root)).toBe(join(root, ".genie", "rsi", "tickets.json"));
  });
});

describe("issue", () => {
  it("落盘后文件存在且 JSON 可解析,再次 load 能读到(跨调用持久化)", () => {
    const root = tempRoot();
    const result = issue(root, { binding: binding(), now: 1_000, ttlMs: 60_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toBe("TICKET_ISSUED");
    expect(result.persisted).toBe(true);

    const file = readFileJson(root);
    expect(file.version).toBe(1);
    expect(Object.keys(file.tickets)).toEqual([result.ticket.id]);

    const loaded = loadTickets(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.path).toBe(ticketsPath(root));
    expect(loaded.version).toBe(1);
    const reloaded = loaded.tickets.tickets[result.ticket.id];
    expect(reloaded?.binding).toEqual(binding());
    expect(reloaded?.expiresAt).toBe(61_000);
    expect(reloaded?.consumedAt).toBeUndefined();
  });

  it("非法 binding(空串)返回 TICKET_INVALID 且不写文件", () => {
    const root = tempRoot();
    const result = issue(root, { binding: binding({ ptyId: "" }), now: 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("TICKET_INVALID");
    expect(result.persisted).toBe(false);

    const loaded = loadTickets(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Object.keys(loaded.tickets.tickets)).toHaveLength(0);
    expect(readdirSync(root)).not.toContain(".genie");
  });
});

describe("consume", () => {
  it("issue→consume 成功,consumedAt 已持久化", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const result = consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 2_000 });
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);

    const loaded = loadTickets(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.tickets.tickets[issued.ticket.id]?.consumedAt).toBe(2_000);
  });

  it("同票二次 consume → TICKET_REPLAY 且 consumedAt 不被改写", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");
    consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 2_000 });

    const before = readFileSync(ticketsPath(root), "utf8");
    const replay = consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 3_000 });
    expect(replay.code).toBe("TICKET_REPLAY");
    expect(replay.persisted).toBe(false);
    expect(readFileSync(ticketsPath(root), "utf8")).toBe(before);

    const loaded = loadTickets(root);
    if (!loaded.ok) throw new Error("load 应成功");
    expect(loaded.tickets.tickets[issued.ticket.id]?.consumedAt).toBe(2_000);
  });

  it("换 directory → TICKET_BINDING_MISMATCH,票仍未消费(随后可正确消费)", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");

    const mismatch = consume(root, {
      ticketId: issued.ticket.id,
      binding: binding({ directory: "/other" }),
      now: 2_000,
    });
    expect(mismatch.code).toBe("TICKET_BINDING_MISMATCH");
    expect(mismatch.persisted).toBe(false);

    const loaded = loadTickets(root);
    if (!loaded.ok) throw new Error("load 应成功");
    expect(loaded.tickets.tickets[issued.ticket.id]?.consumedAt).toBeUndefined();

    const ok = consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 3_000 });
    expect(ok.code).toBe("TICKET_CONSUMED");
  });

  it("ttl=1 的票 + now 推进 → TICKET_EXPIRED 且落盘 consumedAt", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000, ttlMs: 1 });
    if (!issued.ok) throw new Error("issue 应成功");

    const result = consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 1_002 });
    expect(result.code).toBe("TICKET_EXPIRED");
    expect(result.ok).toBe(false);
    expect(result.persisted).toBe(true);

    const loaded = loadTickets(root);
    if (!loaded.ok) throw new Error("load 应成功");
    expect(loaded.tickets.tickets[issued.ticket.id]?.consumedAt).toBe(1_002);
  });

  it("未知票 → TICKET_NOT_FOUND 且不写盘", () => {
    const root = tempRoot();
    const result = consume(root, { ticketId: "nope", binding: binding(), now: 1_000 });
    expect(result.code).toBe("TICKET_NOT_FOUND");
    expect(result.persisted).toBe(false);
  });
});

describe("prune", () => {
  it("清理过期未消费并返回 pruned;再 prune 幂等", () => {
    const root = tempRoot();
    const expired = issue(root, { binding: binding(), now: 1_000, ttlMs: 10 });
    if (!expired.ok) throw new Error("issue 应成功");
    const alive = issue(root, { binding: binding(), now: 5_000, ttlMs: 60_000 });
    if (!alive.ok) throw new Error("issue 应成功");

    const first = prune(root, { now: 6_000 });
    expect(first.code).toBe("TICKET_PRUNED");
    expect(first.pruned).toEqual([expired.ticket.id]);
    expect(first.persisted).toBe(true);

    const loaded = loadTickets(root);
    if (!loaded.ok) throw new Error("load 应成功");
    expect(Object.keys(loaded.tickets.tickets)).toEqual([alive.ticket.id]);

    const second = prune(root, { now: 6_000 });
    expect(second.code).toBe("TICKET_PRUNED");
    expect(second.pruned).toEqual([]);
    expect(second.persisted).toBe(false);
  });
});

describe("allowUrl", () => {
  function urlFor(ticketId: string, dir = "/w"): string {
    const params = new URLSearchParams({ ticket: ticketId, ptyId: "pty-1", directory: dir, workspaceId: "ws-1" });
    return `http://127.0.0.1:7700/pty?${params.toString()}`;
  }

  it("带 ?ticket= 放行并持久化", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");

    const result = allowUrl(root, { url: urlFor(issued.ticket.id), now: 2_000 });
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ticketId).toBe(issued.ticket.id);
    expect(result.persisted).toBe(true);

    const loaded = loadTickets(root);
    if (!loaded.ok) throw new Error("load 应成功");
    expect(loaded.tickets.tickets[issued.ticket.id]?.consumedAt).toBe(2_000);
  });

  it("无 ticket → TICKET_NO_TICKET(不写盘)", () => {
    const root = tempRoot();
    const result = allowUrl(root, { url: "http://127.0.0.1:7700/pty", now: 2_000 });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_NO_TICKET");
    expect(result.persisted).toBe(false);
  });

  it("同票重放 → TICKET_REPLAY", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");
    allowUrl(root, { url: urlFor(issued.ticket.id), now: 2_000 });

    const replay = allowUrl(root, { url: urlFor(issued.ticket.id), now: 3_000 });
    expect(replay.allowed).toBe(false);
    expect(replay.code).toBe("TICKET_REPLAY");
    expect(replay.persisted).toBe(false);
  });

  it("显式 binding 优先于 url 里的绑定上下文", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");

    const mismatch = allowUrl(root, {
      url: `http://127.0.0.1:7700/pty?ticket=${issued.ticket.id}`,
      binding: binding({ workspaceId: "ws-2" }),
      now: 2_000,
    });
    expect(mismatch.code).toBe("TICKET_BINDING_MISMATCH");

    const ok = allowUrl(root, {
      url: `http://127.0.0.1:7700/pty?ticket=${issued.ticket.id}`,
      binding: binding(),
      now: 3_000,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.code).toBe("TICKET_CONSUMED");
  });
});

describe("reportTickets", () => {
  it("计数 total/active/consumed/expired 与 state 字段", () => {
    const root = tempRoot();
    const now = Date.now();

    const active = issue(root, { binding: binding({ ptyId: "pty-active" }), now, ttlMs: 60_000 });
    if (!active.ok) throw new Error("issue 应成功");
    const consumed = issue(root, { binding: binding({ ptyId: "pty-consumed" }), now, ttlMs: 60_000 });
    if (!consumed.ok) throw new Error("issue 应成功");
    const expired = issue(root, { binding: binding({ ptyId: "pty-expired" }), now: now - 10_000, ttlMs: 1 });
    if (!expired.ok) throw new Error("issue 应成功");

    consume(root, { ticketId: consumed.ticket.id, binding: binding({ ptyId: "pty-consumed" }), now });

    const report = reportTickets(root);
    expect("tickets" in report).toBe(true);
    if (!("tickets" in report)) return;

    expect(report.version).toBe(1);
    expect(report.path).toBe(ticketsPath(root));
    expect(report.total).toBe(3);
    expect(report.active).toBe(1);
    expect(report.consumed).toBe(1);
    expect(report.expired).toBe(1);

    const stateOf = (id: string) => report.tickets.find((t) => t.id === id)?.state;
    expect(stateOf(active.ticket.id)).toBe("active");
    expect(stateOf(consumed.ticket.id)).toBe("consumed");
    expect(stateOf(expired.ticket.id)).toBe("expired");

    const activeEntry = report.tickets.find((t) => t.id === active.ticket.id);
    expect(activeEntry?.ptyId).toBe("pty-active");
    expect(activeEntry?.directory).toBe("/w");
    expect(activeEntry?.workspaceId).toBe("ws-1");
    expect(activeEntry?.consumedAt).toBeUndefined();
  });

  it("空台账 → 全 0 且 tickets 为空", () => {
    const root = tempRoot();
    const report = reportTickets(root);
    if (!("tickets" in report)) throw new Error("report 应成功");
    expect(report.total).toBe(0);
    expect(report.active).toBe(0);
    expect(report.consumed).toBe(0);
    expect(report.expired).toBe(0);
    expect(report.tickets).toEqual([]);
  });
});

describe("坏文件与原子写", () => {
  it("坏 JSON → 读失败折叠 TICKET_STORE_ERROR,写操作拒绝且不覆盖原文本", () => {
    const root = tempRoot();
    const path = ticketsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    const corrupt = "{ 这不是 JSON";
    writeFileSync(path, corrupt, "utf8");

    const loaded = loadTickets(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe("TICKET_STORE_ERROR");
    expect(loaded.reason.length).toBeGreaterThan(0);

    const issued = issue(root, { binding: binding(), now: 1_000 });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.code).toBe("TICKET_STORE_ERROR");
    expect(issued.persisted).toBe(false);

    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  it("结构不合法(version 不对)同样折叠 TICKET_STORE_ERROR", () => {
    const root = tempRoot();
    const path = ticketsPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 2, tickets: {} }), "utf8");

    const loaded = loadTickets(root);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.code).toBe("TICKET_STORE_ERROR");

    const pruned = prune(root, { now: 1_000 });
    expect(pruned.code).toBe("TICKET_STORE_ERROR");
    expect(pruned.persisted).toBe(false);
  });

  it("原子写:写后目录里不残留 .tmp- 文件", () => {
    const root = tempRoot();
    const issued = issue(root, { binding: binding(), now: 1_000 });
    if (!issued.ok) throw new Error("issue 应成功");
    consume(root, { ticketId: issued.ticket.id, binding: binding(), now: 2_000 });

    const entries = readdirSync(join(root, ".genie", "rsi"));
    expect(entries).toEqual(["tickets.json"]);
    expect(entries.filter((name) => name.includes(".tmp-"))).toHaveLength(0);
  });

  it("STREAM_TICKET_STORE_CODES 含 runtime 码 + TICKET_STORE_ERROR", () => {
    expect(STREAM_TICKET_STORE_CODES).toContain("TICKET_STORE_ERROR");
    expect(STREAM_TICKET_STORE_CODES).toContain("TICKET_ISSUED");
    expect(STREAM_TICKET_STORE_CODES).toContain("TICKET_REPLAY");
  });
});
