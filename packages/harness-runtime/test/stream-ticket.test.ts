import { describe, expect, it } from "vitest";
import type { StreamTicket, TicketBinding, TicketStore } from "../src/agent/stream-ticket";
import {
  STREAM_TICKET_TTL_MS,
  TICKET_CODES,
  allowUrlTicket,
  consumeTicket,
  isTicketBinding,
  issueTicket,
  pruneExpired,
  stats,
} from "../src/agent/stream-ticket";

const NOW = 1_700_000_000_000;

function baseBinding(): TicketBinding {
  return { ptyId: "pty-1", directory: "/repo/a", workspaceId: "ws-1" };
}

function emptyStore(): TicketStore {
  return { tickets: {} };
}

/** 用固定 id 发一张票(默认 ttl),返回 ticket;issue 失败直接炸测试。 */
function issueAt(
  store: TicketStore,
  now: number,
  id = "t-1",
  ttlMs?: number,
  binding: TicketBinding = baseBinding(),
): StreamTicket {
  const result = issueTicket(store, {
    binding,
    now,
    idFactory: () => id,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  if (!result.ok) throw new Error(`issue 失败:${result.reason}`);
  return result.ticket;
}

/** 拼一个带票与绑定三元组的 WS url。 */
function wsUrl(ticketId: string, binding: TicketBinding = baseBinding()): string {
  const q = new URLSearchParams({
    ticket: ticketId,
    ptyId: binding.ptyId,
    directory: binding.directory,
    workspaceId: binding.workspaceId,
  });
  return `/ws?${q.toString()}`;
}

describe("常量与判别", () => {
  it("TTL 缺省 60 秒", () => {
    expect(STREAM_TICKET_TTL_MS).toBe(60_000);
  });

  it("TICKET_CODES 覆盖全部结果码且无重复", () => {
    expect([...TICKET_CODES]).toEqual([
      "TICKET_INVALID",
      "TICKET_ISSUED",
      "TICKET_CONSUMED",
      "TICKET_REPLAY",
      "TICKET_EXPIRED",
      "TICKET_NOT_FOUND",
      "TICKET_BINDING_MISMATCH",
      "TICKET_NO_TICKET",
      "TICKET_PRUNED",
    ]);
    expect(new Set(TICKET_CODES).size).toBe(TICKET_CODES.length);
  });

  it("isTicketBinding 接受三字段非空字符串", () => {
    expect(isTicketBinding(baseBinding())).toBe(true);
  });

  it("isTicketBinding 拒绝空串/缺字段/非对象", () => {
    expect(isTicketBinding({ ...baseBinding(), ptyId: "" })).toBe(false);
    expect(isTicketBinding({ ptyId: "p", directory: "/r" })).toBe(false);
    expect(isTicketBinding(null)).toBe(false);
    expect(isTicketBinding("pty-1")).toBe(false);
  });
});

describe("issueTicket", () => {
  it("注入 idFactory 时用注入的 id", () => {
    const store = emptyStore();
    const ticket = issueAt(store, NOW, "fixed-id");
    expect(ticket.id).toBe("fixed-id");
    expect(store.tickets["fixed-id"]).toEqual(ticket);
  });

  it("缺省 ttl 时 expiresAt = now + 60000", () => {
    const store = emptyStore();
    const ticket = issueAt(store, NOW, "t-ttl");
    expect(ticket.issuedAt).toBe(NOW);
    expect(ticket.expiresAt).toBe(NOW + 60_000);
  });

  it("自定义 ttl 生效", () => {
    const store = emptyStore();
    const ticket = issueAt(store, NOW, "t-ttl2", 5_000);
    expect(ticket.expiresAt).toBe(NOW + 5_000);
  });

  it("缺省 id 走 randomUUID(UUID 形态)", () => {
    const store = emptyStore();
    const result = issueTicket(store, { binding: baseBinding(), now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok || result.code !== "TICKET_ISSUED") return;
    expect(result.code).toBe("TICKET_ISSUED");
    expect(result.ticket.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(store.tickets[result.ticket.id]?.expiresAt).toBe(NOW + 60_000);
  });

  it("新发票不带 consumedAt", () => {
    const store = emptyStore();
    const ticket = issueAt(store, NOW);
    expect(ticket.consumedAt).toBeUndefined();
  });

  it("binding 字段为空串 → TICKET_INVALID 且不写 store", () => {
    const store = emptyStore();
    const result = issueTicket(store, {
      binding: { ptyId: "pty-1", directory: "", workspaceId: "ws-1" },
      now: NOW,
    });
    expect(result).toEqual({ ok: false, code: "TICKET_INVALID", reason: expect.any(String) });
    expect(store.tickets).toEqual({});
  });

  it("binding 字段为 undefined → TICKET_INVALID 且不写 store", () => {
    const store = emptyStore();
    const result = issueTicket(store, {
      binding: { ptyId: "pty-1", workspaceId: "ws-1" } as unknown as TicketBinding,
      now: NOW,
      idFactory: () => "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TICKET_INVALID");
    expect(store.tickets).toEqual({});
  });

  it("ttlMs = 0 → TICKET_INVALID 且不写 store", () => {
    const store = emptyStore();
    const result = issueTicket(store, {
      binding: baseBinding(),
      now: NOW,
      ttlMs: 0,
      idFactory: () => "t-zero",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TICKET_INVALID");
    expect(store.tickets["t-zero"]).toBeUndefined();
    expect(stats(store).total).toBe(0);
  });

  it("ttlMs 为 NaN / Infinity → TICKET_INVALID", () => {
    const store = emptyStore();
    for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = issueTicket(store, { binding: baseBinding(), now: NOW, ttlMs });
      expect(result.ok).toBe(false);
    }
    expect(store.tickets).toEqual({});
  });

  it("多票共存", () => {
    const store = emptyStore();
    issueAt(store, NOW, "a");
    issueAt(store, NOW + 10, "b");
    issueAt(store, NOW + 20, "c", 1_000);
    expect(Object.keys(store.tickets).sort()).toEqual(["a", "b", "c"]);
    expect(stats(store)).toEqual({ total: 3, active: 3, consumed: 0 });
  });
});

describe("consumeTicket", () => {
  it("成功消费:ok / CONSUMED / 置 consumedAt", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const result = consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 100 });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ticket?.consumedAt).toBe(NOW + 100);
    expect(store.tickets["t-1"]?.consumedAt).toBe(NOW + 100);
  });

  it("ticketId 原样回传(成功与失败都回传)", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    expect(
      consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW }).ticketId).toBe("t-1");
    expect(
      consumeTicket(store, { ticketId: "unknown-id", binding: baseBinding(), now: NOW }).ticketId).toBe("unknown-id");
  });

  it("同一张票二次消费 → REPLAY", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 10 });
    const again = consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 20 });
    expect(again.ok).toBe(false);
    expect(again.code).toBe("TICKET_REPLAY");
  });

  it("REPLAY 不重复置位 consumedAt", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 10 });
    consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 999 });
    expect(store.tickets["t-1"]?.consumedAt).toBe(NOW + 10);
  });

  it("未知 id → NOT_FOUND", () => {
    const store = emptyStore();
    const result = consumeTicket(store, { ticketId: "nope", binding: baseBinding(), now: NOW });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TICKET_NOT_FOUND");
    expect(result.ticket).toBeUndefined();
  });

  it("过期票 → EXPIRED 且被标记 consumedAt", () => {
    const store = emptyStore();
    issueAt(store, NOW, "t-1", 1_000);
    const result = consumeTicket(store, {
      ticketId: "t-1",
      binding: baseBinding(),
      now: NOW + 1_001,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TICKET_EXPIRED");
    expect(store.tickets["t-1"]?.consumedAt).toBe(NOW + 1_001);
  });

  it("过期票被标记后再消费 → REPLAY(不是再次 EXPIRED)", () => {
    const store = emptyStore();
    issueAt(store, NOW, "t-1", 1_000);
    consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 2_000 });
    const again = consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 3_000 });
    expect(again.code).toBe("TICKET_REPLAY");
  });

  it("now === expiresAt 不算过期", () => {
    const store = emptyStore();
    issueAt(store, NOW, "t-1", 1_000);
    const result = consumeTicket(store, {
      ticketId: "t-1",
      binding: baseBinding(),
      now: NOW + 1_000,
    });
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ok).toBe(true);
  });

  it("ptyId 不等 → BINDING_MISMATCH", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const result = consumeTicket(store, {
      ticketId: "t-1",
      binding: { ...baseBinding(), ptyId: "pty-2" },
      now: NOW,
    });
    expect(result.code).toBe("TICKET_BINDING_MISMATCH");
    expect(result.ok).toBe(false);
  });

  it("directory 不等 → BINDING_MISMATCH", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const result = consumeTicket(store, {
      ticketId: "t-1",
      binding: { ...baseBinding(), directory: "/repo/b" },
      now: NOW,
    });
    expect(result.code).toBe("TICKET_BINDING_MISMATCH");
  });

  it("workspaceId 不等 → BINDING_MISMATCH", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const result = consumeTicket(store, {
      ticketId: "t-1",
      binding: { ...baseBinding(), workspaceId: "ws-2" },
      now: NOW,
    });
    expect(result.code).toBe("TICKET_BINDING_MISMATCH");
  });

  it("BINDING_MISMATCH 不消费:随后正确 binding 仍能成功", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    consumeTicket(store, {
      ticketId: "t-1",
      binding: { ...baseBinding(), ptyId: "pty-x" },
      now: NOW + 1,
    });
    expect(store.tickets["t-1"]?.consumedAt).toBeUndefined();
    const ok = consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 2 });
    expect(ok.ok).toBe(true);
    expect(ok.code).toBe("TICKET_CONSUMED");
    expect(store.tickets["t-1"]?.consumedAt).toBe(NOW + 2);
  });
});

describe("allowUrlTicket", () => {
  it("绝对 URL 带 ticket 放行", () => {
    const store = emptyStore();
    issueAt(store, NOW, "abs");
    const url = `ws://127.0.0.1:7777${wsUrl("abs")}`;
    const result = allowUrlTicket({ url, store, now: NOW + 5 });
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ticketId).toBe("abs");
  });

  it("相对路径 /ws?ticket=x 放行", () => {
    const store = emptyStore();
    issueAt(store, NOW, "rel");
    const result = allowUrlTicket({ url: wsUrl("rel"), store, now: NOW });
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(result.ticket?.id).toBe("rel");
  });

  it("无 ticket 参数 → NO_TICKET 且不放行", () => {
    const store = emptyStore();
    issueAt(store, NOW, "x");
    const result = allowUrlTicket({ url: "/ws?ptyId=pty-1", store, now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_NO_TICKET");
    expect(store.tickets["x"]?.consumedAt).toBeUndefined();
  });

  it("空 ticket 参数 → NO_TICKET", () => {
    const store = emptyStore();
    const result = allowUrlTicket({ url: "/ws?ticket=", store, now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_NO_TICKET");
  });

  it("错 ticket → NOT_FOUND", () => {
    const store = emptyStore();
    issueAt(store, NOW, "real");
    const result = allowUrlTicket({ url: wsUrl("forged"), store, now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_NOT_FOUND");
    expect(store.tickets["real"]?.consumedAt).toBeUndefined();
  });

  it("同一 URL 二次握手 → REPLAY", () => {
    const store = emptyStore();
    issueAt(store, NOW, "once");
    const url = wsUrl("once");
    expect(allowUrlTicket({ url, store, now: NOW }).allowed).toBe(true);
    const second = allowUrlTicket({ url, store, now: NOW + 1 });
    expect(second.allowed).toBe(false);
    expect(second.code).toBe("TICKET_REPLAY");
  });

  it("非法 URL → TICKET_INVALID", () => {
    const store = emptyStore();
    const result = allowUrlTicket({ url: "http://[::1", store, now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_INVALID");
  });

  it("url 绑定参数与票不符 → BINDING_MISMATCH 且票未消费", () => {
    const store = emptyStore();
    issueAt(store, NOW, "bind");
    const url = wsUrl("bind", { ...baseBinding(), directory: "/repo/other" });
    const result = allowUrlTicket({ url, store, now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_BINDING_MISMATCH");
    expect(store.tickets["bind"]?.consumedAt).toBeUndefined();
  });

  it("url 过期票 → EXPIRED 且被标记", () => {
    const store = emptyStore();
    issueAt(store, NOW, "late", 1_000);
    const result = allowUrlTicket({ url: wsUrl("late"), store, now: NOW + 1_001 });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_EXPIRED");
    expect(store.tickets["late"]?.consumedAt).toBe(NOW + 1_001);
  });

  it("显式 binding 与票一致(url 不带上下文)→ 放行", () => {
    const store = emptyStore();
    issueAt(store, NOW, "ctx");
    const result = allowUrlTicket({ url: "/ws?ticket=ctx", store, now: NOW, binding: baseBinding() });
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("TICKET_CONSUMED");
    expect(store.tickets["ctx"]?.consumedAt).toBe(NOW);
  });

  it("显式 binding 不符时不信 URL 自报的上下文 → BINDING_MISMATCH 且不消费", () => {
    const store = emptyStore();
    issueAt(store, NOW, "ctx2");
    // URL 自称与票据一致的绑定,但真实会话在别的目录 → 必须拒
    const result = allowUrlTicket({
      url: wsUrl("ctx2"),
      store,
      now: NOW,
      binding: { ...baseBinding(), directory: "/repo/other" },
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("TICKET_BINDING_MISMATCH");
    expect(store.tickets["ctx2"]?.consumedAt).toBeUndefined();
  });
});

describe("pruneExpired", () => {
  it("删除过期未消费的票", () => {
    const store = emptyStore();
    issueAt(store, NOW, "old", 1_000);
    const result = pruneExpired(store, NOW + 2_000);
    expect(result.code).toBe("TICKET_PRUNED");
    expect(store.tickets["old"]).toBeUndefined();
  });

  it("保留仍然有效的票", () => {
    const store = emptyStore();
    issueAt(store, NOW, "fresh", 10_000);
    const result = pruneExpired(store, NOW + 2_000);
    expect(result.pruned).toEqual([]);
    expect(store.tickets["fresh"]).toBeDefined();
  });

  it("保留已消费的过期票", () => {
    const store = emptyStore();
    issueAt(store, NOW, "used", 1_000);
    consumeTicket(store, { ticketId: "used", binding: baseBinding(), now: NOW + 10 });
    const result = pruneExpired(store, NOW + 5_000);
    expect(result.pruned).toEqual([]);
    expect(store.tickets["used"]?.consumedAt).toBe(NOW + 10);
  });

  it("pruned 列表列出被删 id(未过期的不列)", () => {
    const store = emptyStore();
    issueAt(store, NOW, "a", 1_000);
    issueAt(store, NOW, "b", 1_000);
    issueAt(store, NOW, "keep", 60_000);
    const result = pruneExpired(store, NOW + 5_000);
    expect(result.pruned.sort()).toEqual(["a", "b"]);
    expect(Object.keys(store.tickets)).toEqual(["keep"]);
  });

  it("pruneExpired 幂等:同 now 第二次为空", () => {
    const store = emptyStore();
    issueAt(store, NOW, "a", 1_000);
    expect(pruneExpired(store, NOW + 5_000).pruned).toEqual(["a"]);
    expect(pruneExpired(store, NOW + 5_000).pruned).toEqual([]);
  });

  it("now === expiresAt 时不清理(闭区间有效)", () => {
    const store = emptyStore();
    issueAt(store, NOW, "edge", 1_000);
    expect(pruneExpired(store, NOW + 1_000).pruned).toEqual([]);
  });
});

describe("stats", () => {
  it("空 store 全零", () => {
    expect(stats(emptyStore())).toEqual({ total: 0, active: 0, consumed: 0 });
  });

  it("混合计数 total/active/consumed", () => {
    const store = emptyStore();
    issueAt(store, NOW, "a");
    issueAt(store, NOW, "b");
    issueAt(store, NOW, "c");
    consumeTicket(store, { ticketId: "a", binding: baseBinding(), now: NOW });
    expect(stats(store)).toEqual({ total: 3, active: 2, consumed: 1 });
  });

  it("active 不判 TTL:过期未消费仍计入 active", () => {
    const store = emptyStore();
    issueAt(store, NOW, "expired-but-untouched", 1_000);
    expect(stats(store)).toEqual({ total: 1, active: 1, consumed: 0 });
  });
});

describe("入参不被修改", () => {
  it("issue 复制 binding:事后改入参不影响已发出的票", () => {
    const store = emptyStore();
    const binding = baseBinding();
    issueAt(store, NOW, "t-copy", undefined, binding);
    binding.directory = "/repo/changed";
    expect(store.tickets["t-copy"]?.binding.directory).toBe("/repo/a");
    expect(store.tickets["t-copy"]?.binding).not.toBe(binding);
  });

  it("consume 不改写既有 ticket 对象(store 记录被替换而非原地改)", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const before = store.tickets["t-1"];
    consumeTicket(store, { ticketId: "t-1", binding: baseBinding(), now: NOW + 7 });
    expect(before?.consumedAt).toBeUndefined();
    expect(store.tickets["t-1"]).not.toBe(before);
  });

  it("consume 失败(BINDING_MISMATCH)时 store 内容完全不变", () => {
    const store = emptyStore();
    issueAt(store, NOW);
    const snapshot = JSON.stringify(store.tickets);
    consumeTicket(store, {
      ticketId: "t-1",
      binding: { ...baseBinding(), workspaceId: "ws-other" },
      now: NOW,
    });
    expect(JSON.stringify(store.tickets)).toBe(snapshot);
  });
});
