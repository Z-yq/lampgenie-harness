import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  ANTHROPIC_CACHE_BREAKPOINT_LIMIT,
  ANTHROPIC_CACHE_BREAKPOINT_PRIORITY,
  markCacheBreakpoint,
  planCacheBreakpoints,
} from "../src/agent/provider-apitypes";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";

/**
 * Anthropic prompt cache 断点预算:纯函数计划层 + 真实请求体落位两层。
 * 纯函数层钉「打在哪、预算怎么取舍、跳过了什么」;请求体层用 node:http 真 mock server 抓
 * 真实 wire JSON,钉「断点确实落在 block 上、总数 ≤4、同一对象不重复打标」。
 */

interface RecordedReq {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

interface MockServer {
  server: Server;
  base: string;
  requests: RecordedReq[];
}

async function startMock(handler: (req: RecordedReq, res: ServerResponse) => void): Promise<MockServer> {
  const requests: RecordedReq[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { raw }; }
      const rec: RecordedReq = { url: req.url ?? "", headers: req.headers, body };
      requests.push(rec);
      handler(rec, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${addr.port}`, requests };
}

function ok(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
}

/** 请求体里的断点位置(tools 定义 / system 块 / 消息块,按 wire 顺序逐处点名)。 */
function breakpointsOf(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  const tools = body.tools as Record<string, unknown>[] | undefined;
  tools?.forEach((t, i) => { if (t.cache_control) found.push(`tools#${i}`); });
  const system = body.system as Record<string, unknown>[] | undefined;
  system?.forEach((b, i) => { if (b.cache_control) found.push(`system#${i}`); });
  const msgs = (body.messages ?? []) as { content: Record<string, unknown>[] }[];
  msgs.forEach((m, i) => m.content.forEach((b, j) => { if (b.cache_control) found.push(`msg${i}#${j}`); }));
  return found;
}

const TOOLS = [
  { name: "getTime", description: "取当前时间", parameters: { type: "object", properties: { tz: { type: "string" } } } as Record<string, unknown> },
  { name: "getDate", description: "取当前日期", parameters: { type: "object", properties: {} } as Record<string, unknown> },
];

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function chatOnce(messages: Parameters<ReturnType<typeof createOpenAiCompatProvider>["chat"]>[0], tools: typeof TOOLS = []): Promise<Record<string, unknown>> {
  const m = await startMock((_req, res) => ok(res));
  servers.push(m.server);
  const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k-ant", model: "claude-x", apiType: "anthropic" });
  await p.chat(messages, tools);
  return m.requests[0]!.body;
}

// =============================================================================
// 计划层(纯函数)
// =============================================================================
describe("planCacheBreakpoints 断点预算计划", () => {
  it("上限常量=4、优先级表固定序(system > tools > tail-2 > tail-1)", () => {
    expect(ANTHROPIC_CACHE_BREAKPOINT_LIMIT).toBe(4);
    expect([...ANTHROPIC_CACHE_BREAKPOINT_PRIORITY]).toEqual(["system", "tools", "messages-tail-2", "messages-tail-1"]);
  });

  it("候选全齐备(有 tools/system + 4 条消息)→ 4 槽全用,零跳过,index 为倒数第二/倒数第一", () => {
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 4 });
    expect(plan.slots).toEqual([
      { kind: "system" },
      { kind: "tools" },
      { kind: "message", index: 2 },
      { kind: "message", index: 3 },
    ]);
    expect(plan.used).toBe(4);
    expect(plan.skipped).toEqual([]);
  });

  it("无 tools 无 system、2 条消息 → 只有两条消息断点,空位置记 unavailable", () => {
    const plan = planCacheBreakpoints({ hasTools: false, hasSystem: false, messageCount: 2 });
    expect(plan.slots).toEqual([{ kind: "message", index: 0 }, { kind: "message", index: 1 }]);
    expect(plan.used).toBe(2);
    expect(plan.skipped).toEqual([
      { kind: "system", reason: "unavailable" },
      { kind: "tools", reason: "unavailable" },
    ]);
  });

  it("单条消息 → 无倒数第二条(记 unavailable),末条仍打标", () => {
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 1 });
    expect(plan.slots).toEqual([{ kind: "system" }, { kind: "tools" }, { kind: "message", index: 0 }]);
    expect(plan.used).toBe(3);
    expect(plan.skipped).toEqual([{ kind: "message", reason: "unavailable" }]);
  });

  it("零消息(空态)→ 只剩静态前缀两个断点,消息槽记 unavailable,不抛错", () => {
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 0 });
    expect(plan.slots).toEqual([{ kind: "system" }, { kind: "tools" }]);
    expect(plan.used).toBe(2);
    expect(plan.skipped).toEqual([
      { kind: "message", reason: "unavailable" },
      { kind: "message", reason: "unavailable" },
    ]);
  });

  it("preMarked 占用配额:已有 system+tools 标记 → 只新增两条消息断点,used 仍是 4", () => {
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 4, preMarked: ["system", "tools"] });
    expect(plan.slots).toEqual([{ kind: "message", index: 2 }, { kind: "message", index: 3 }]);
    expect(plan.used).toBe(4);
    expect(plan.skipped).toEqual([
      { kind: "system", reason: "pre-marked" },
      { kind: "tools", reason: "pre-marked" },
    ]);
  });

  it("preMarked 超出预算 → 多出的记 budget-exhausted,used 封顶 4", () => {
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 4, preMarked: ["message", "message", "message"] });
    expect(plan.used).toBe(4);
    expect(plan.slots).toEqual([{ kind: "system" }, { kind: "tools" }]);
    const exhausted = plan.skipped.filter((s) => s.reason === "budget-exhausted");
    expect(exhausted).toEqual([{ kind: "message", reason: "budget-exhausted" }]);
  });

  it("preMarked 无对应位置(无 tools 却声明)→ 空位置记 unavailable,标记本身仍占配额", () => {
    const plan = planCacheBreakpoints({ hasTools: false, hasSystem: true, messageCount: 3, preMarked: ["tools"] });
    expect(plan.slots).toEqual([{ kind: "system" }, { kind: "message", index: 1 }, { kind: "message", index: 2 }]);
    expect(plan.used).toBe(4);
    expect(plan.skipped).toEqual([
      { kind: "tools", reason: "unavailable" },
      { kind: "tools", reason: "pre-marked" },
    ]);
  });

  it("确定性:同输入两次调用结果深等,且返回数组互不共享引用", () => {
    const input = { hasTools: true, hasSystem: false, messageCount: 5, preMarked: ["message" as const] };
    const a = planCacheBreakpoints(input);
    const b = planCacheBreakpoints(input);
    expect(a).toEqual(b);
    expect(a.slots).not.toBe(b.slots);
    expect(a.skipped).not.toBe(b.skipped);
    a.slots.push({ kind: "tools" }); // 污染第一次结果,不影响第二次
    expect(planCacheBreakpoints(input)).toEqual(b);
  });

  it("不修改入参:input 对象与 preMarked 数组调用后原样", () => {
    const preMarked = ["system" as const, "tools" as const];
    const input = { hasTools: true, hasSystem: true, messageCount: 3, preMarked };
    const snapshot = JSON.stringify(input);
    planCacheBreakpoints(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(preMarked).toEqual(["system", "tools"]);
  });
});

// =============================================================================
// 打标层(单块)
// =============================================================================
describe("markCacheBreakpoint 单块打标", () => {
  it("空块/undefined → 返回 false 且不抛(空态不造字段)", () => {
    expect(markCacheBreakpoint(undefined)).toBe(false);
    expect(markCacheBreakpoint({})).toBe(true);
  });

  it("已有 cache_control 原样保留(含 ttl 扩展),不覆盖不重复打标", () => {
    const existing = { type: "ephemeral", ttl: "1h" };
    const block: Record<string, unknown> = { type: "text", text: "s", cache_control: existing };
    expect(markCacheBreakpoint(block)).toBe(false);
    expect(block.cache_control).toBe(existing); // 引用都没换
    expect(block.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

// =============================================================================
// 真实请求体(适配器 chat + mock server)
// =============================================================================
describe("toAnthropicBody 断点落位(真实请求体)", () => {
  it("system + 单条 user、无 tools → 2 个断点(system 末块 + 末条消息末块),无 tools 字段", async () => {
    const body = await chatOnce([{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }]);
    expect(breakpointsOf(body)).toEqual(["system#0", "msg0#0"]);
    expect(body.tools).toBeUndefined();
  });

  it("有 tools → 3 个断点,且只有最后一个 tool 定义带 cache_control", async () => {
    const body = await chatOnce([{ role: "system", content: "你是助手" }, { role: "user", content: "hi" }], TOOLS);
    expect(breakpointsOf(body)).toEqual(["tools#1", "system#0", "msg0#0"]);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(tools).toHaveLength(2);
  });

  it("历史够长 → 4 个断点(system/tools/倒数第二条/末条),总数等于上限", async () => {
    const body = await chatOnce([
      { role: "system", content: "你是助手" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
    ], TOOLS);
    expect(breakpointsOf(body)).toEqual(["tools#1", "system#0", "msg3#0", "msg4#0"]);
    expect(breakpointsOf(body)).toHaveLength(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
  });

  it("断点只落 block 上:没有 message 级 cache_control,且没有任何块被重复打标", async () => {
    const body = await chatOnce([
      { role: "system", content: "你是助手" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ], TOOLS);
    for (const m of body.messages as Record<string, unknown>[]) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
    const blocks: Record<string, unknown>[] = [
      ...(body.tools as Record<string, unknown>[]),
      ...(body.system as Record<string, unknown>[]),
      ...((body.messages as { content: Record<string, unknown>[] }[]).flatMap((m) => m.content)),
    ];
    const marked = blocks.filter((b) => b.cache_control !== undefined);
    expect(new Set(marked).size).toBe(marked.length); // 同一对象只出现一次
    expect(marked).toHaveLength(4);
  });

  it("稳定切分:追加一条消息后 tools/system 断点位置不变,旧末条升级为倒数第二条仍带断点", async () => {
    const base = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ];
    const first = await chatOnce(base, TOOLS);
    const second = await chatOnce([...base, { role: "assistant", content: "a2" }], TOOLS);
 // 非 system 消息 3 条(0=user q1, 1=assistant a1, 2=user q2)→ 断在 1 与 2
    expect(breakpointsOf(first)).toEqual(["tools#1", "system#0", "msg1#0", "msg2#0"]);
 // 追加一条后:tools/system 位置不动;断点整体顺着前缀末尾右移一格(旧 tail-1 变 tail-2)
    expect(breakpointsOf(second)).toEqual(["tools#1", "system#0", "msg2#0", "msg3#0"]);
    expect((second.system as Record<string, unknown>[])[0]).toEqual((first.system as Record<string, unknown>[])[0]);
    expect((second.tools as Record<string, unknown>[])[1]).toEqual((first.tools as Record<string, unknown>[])[1]);
 // 旧末条(第一条请求的 msg3)在第二次请求里正好是倒数第二条,仍带断点=跨请求命中
    const secondMsgs = second.messages as { content: Record<string, unknown>[] }[];
    expect(secondMsgs[3]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("不修改输入消息:调用后原对象无 cache_control、content 仍是字符串", async () => {
    const messages = [
      { role: "system" as const, content: "你是助手" },
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1", toolCalls: [{ id: "t1", name: "getTime", arguments: "{}" }] },
      { role: "tool" as const, content: "12:00", toolCallId: "t1" },
    ];
    const snapshot = JSON.stringify(messages);
    await chatOnce(messages, TOOLS);
    expect(JSON.stringify(messages)).toBe(snapshot);
    for (const m of messages) expect(Object.keys(m)).not.toContain("cache_control");
  });

  it("空 tools/空 system 不改字节序:单条 user → 只有消息断点,max_tokens 兜底 8192", async () => {
    const body = await chatOnce([{ role: "user", content: "hi" }]);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(body.max_tokens).toBe(8192);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
    expect(breakpointsOf(body)).toEqual(["msg0#0"]);
  });

  it("tool 结果合并后的条数才是 messageCount:多条 tool_result 合成一条 user,断点落在合并块末尾", async () => {
    const body = await chatOnce([
      { role: "user", content: "q1" },
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "getTime", arguments: "{}" },
        { id: "t2", name: "getDate", arguments: "{}" },
      ] },
      { role: "tool", content: "12:00", toolCallId: "t1" },
      { role: "tool", content: "2026-11-10", toolCallId: "t2" },
    ]);
    const msgs = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(msgs).toHaveLength(3); // user / assistant(tool_use×2) / user(tool_result×2)
    expect(breakpointsOf(body)).toEqual(["msg1#1", "msg2#1"]); // 倒数第二条=assistant 末块(第二个 tool_use);末条=合并 user 的末块
  });
});
