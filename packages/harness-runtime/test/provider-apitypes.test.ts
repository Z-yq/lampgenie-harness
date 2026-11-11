import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createOpenAiCompatProvider } from "../src/agent/openai-provider";
import { ANTHROPIC_CACHE_BREAKPOINT_LIMIT, markCacheBreakpoint, planCacheBreakpoints } from "../src/agent/provider-apitypes";

/**
 * apiType 协议适配层端到端:node:http 真 mock server(127.0.0.1 随机端口)
 * + 真 fetch(非 mock-fetch)——协议级验证:握手凭证头/请求体 wire 形态/流式 SSE 事件序列/
 * tool 往返/usage 归一/错误归一。归一出口与 chat 模式同构(LlmResponse)。
 * wire 形态锚 opencode packages/llm/src/protocols/{anthropic-messages,openai-responses}.ts。
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

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** SSE 应答:events=[{event,data}] 逐条 event:+data: 写出;tail=额外裸文本(如 [DONE] 哨兵)。 */
function sse(res: ServerResponse, events: { event: string; data: unknown }[], opts: { split?: boolean; tail?: string } = {}): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("") + (opts.tail ?? "");
  if (opts.split) {
    // 半途切一刀:验证 SSE 解析器的跨 chunk 行缓冲
    const mid = Math.floor(text.length / 2);
    res.write(text.slice(0, mid));
    setTimeout(() => res.end(text.slice(mid)), 10);
  } else {
    res.end(text);
  }
}

const TOOLS = [{
  name: "getTime",
  description: "取当前时间",
  parameters: { type: "object", properties: { tz: { type: "string" } }, required: ["tz"] } as Record<string, unknown>,
}];

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const k of ["GENIE_LLM_DUMP_DIR"]) delete process.env[k];
});

/** 请求体里的断点位置(按计划优先级序:tools → system → 消息块),用于断言总数与位置稳定性。 */
function breakpointsOf(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  (body.tools as Record<string, unknown>[] | undefined)?.forEach((t, i) => { if (t.cache_control) found.push(`tools#${i}`); });
  (body.system as Record<string, unknown>[] | undefined)?.forEach((b, i) => { if (b.cache_control) found.push(`system#${i}`); });
  ((body.messages ?? []) as { content: Record<string, unknown>[] }[]).forEach((msg, i) => {
    msg.content.forEach((b, j) => { if (b.cache_control) found.push(`msg${i}#${j}`); });
  });
  return found;
}

// =============================================================================
// Anthropic Messages(/v1/messages)
// =============================================================================
describe("apiType=anthropic 端到端(mock server)", () => {
  it("非流式:凭证头(x-api-key+version,无 Bearer)/请求体(system 分离+image base64+input_schema+max_tokens 兜底)/text+thinking+tool_use+usage 归一", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, {
        id: "msg_1",
        content: [
          { type: "thinking", thinking: "想一下" },
          { type: "text", text: "你好" },
          { type: "tool_use", id: "toolu_1", name: "getTime", input: { tz: "utc" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 6 },
      });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k-ant", model: "claude-x", apiType: "anthropic" });
    const r = await p.chat([
      { role: "system", content: "你是助手" },
      { role: "user", content: "看图", images: ["data:image/png;base64,QUJD"] },
    ], TOOLS);
    // 凭证头:x-api-key + anthropic-version;authorization 不发
    const req = m.requests[0]!;
    expect(req.url).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("k-ant");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["authorization"]).toBeUndefined();
    expect(req.headers["content-type"]).toBe("application/json");
    // 请求体:system 用 blocks 形态(官方兼容 string,blocks 亦为官方形态;Z.ai/智谱 anthropic 兼容
 // 端点是否接受 blocks+cache_control 未验证——按 Anthropic 规范缓存字段应被忽略而非报错,登记待经验证)
    expect(req.body.system).toEqual([{ type: "text", text: "你是助手", cache_control: { type: "ephemeral" } }]);
    const msgs = req.body.messages as { role: string; content: { type: string; text?: string; source?: { type: string; media_type: string; data: string }; cache_control?: unknown }[] }[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: "看图" });
    expect(msgs[0]!.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" }, cache_control: { type: "ephemeral" } });
 // 缓存断点:对话历史前缀末尾(image 块,非首个 text 块);本请求断点 = system 末块 + tools 末条
 // + 末条消息末块 = 3(预算 4 内:消息只有 1 条,倒数第二条位置不存在)
    expect(msgs[0]!.content[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(msgs[0]!.content[0]!.cache_control).toBeUndefined();
    expect(breakpointsOf(req.body)).toEqual(["tools#0", "system#0", "msg0#1"]);
    const tools = req.body.tools as { name: string; input_schema: Record<string, unknown> }[];
    expect(tools![0]!.name).toBe("getTime");
    expect(tools![0]!.input_schema).toEqual(TOOLS[0].parameters);
    expect(req.body.max_tokens).toBe(8192);
    expect(req.body.model).toBe("claude-x");
    // 归一出口:与 chat 模式同构
    expect(r.content).toBe("你好");
    expect(r.reasoning).toBe("想一下");
    expect(r.toolCalls).toEqual([{ id: "toolu_1", name: "getTime", arguments: JSON.stringify({ tz: "utc" }) }]);
    expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 6, totalTokens: 21, cachedTokens: 4, cacheCreationTokens: 1 });
  });

  it("同一 assistant 的多个 tool_use → tool_result 必须合并进**同一条** user 消息(deepseek 严格校验 400 实测)", async () => {
 // 缺陷:旧实现每条 tool 消息各自 push 一条 user → 产生「只含部分 tool_result 的
    // user 消息」。Anthropic 协议要求同一 assistant 那批 tool_use 的 tool_result 出现在紧随其后的
    // 一条消息里;strict 端点直接 400:
    //   tool_use ids were found without tool_result blocks immediately after: call_x, call_y
    // bigmodel GLM 宽容未报错(所以这个 bug 潜伏了很久),deepseek-flash 第 2 步就炸。
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    await p.chat([
      { role: "user", content: "并行读两个文件" },
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "call_a", name: "read_file", arguments: '{"path":"a.txt"}' },
          { id: "call_b", name: "read_file", arguments: '{"path":"b.txt"}' },
        ],
      },
      { role: "tool", toolCallId: "call_a", content: "AAA" },
      { role: "tool", toolCallId: "call_b", content: "BBB" },
    ], TOOLS);
    const msgs = m.requests[0]!.body.messages as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[];
    expect(msgs).toHaveLength(3); // user / assistant(2 tool_use) / user(2 tool_result)
    expect(msgs[2]!.role).toBe("user");
    const results = msgs[2]!.content.filter((b) => b.type === "tool_result");
    expect(results.map((r) => r.tool_use_id)).toEqual(["call_a", "call_b"]);
    expect(results.map((r) => r.content)).toEqual(["AAA", "BBB"]);
  });

  it("tool 往返:assistant tool_use 块(input 对象)+tool 结果归 user tool_result 块;maxTokens 配置值透传", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic", maxTokens: 2048 });
    await p.chat([
      { role: "user", content: "几点了" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_9", name: "getTime", arguments: '{"tz":"utc"}' }] },
      { role: "tool", toolCallId: "toolu_9", content: "12:00" },
    ], TOOLS);
    const msgs = m.requests[0]!.body.messages as { role: string; content: { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; cache_control?: unknown }[] }[];
    expect(m.requests[0]!.body.max_tokens).toBe(2048);
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content[0]).toEqual({ type: "tool_use", id: "toolu_9", name: "getTime", input: { tz: "utc" }, cache_control: { type: "ephemeral" } });
    expect(msgs[2]!.role).toBe("user");
    expect(msgs[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "toolu_9", content: "12:00", cache_control: { type: "ephemeral" } });
 // 断点:3 条消息 + tools 的请求里,tail-2 落在 assistant tool_use 末块(上一轮的增量末尾,下一轮
 // 请求里仍逐字节存在、断点立刻复用),tail-1 落在末条 tool_result 块——两处都要显式带标记(契约)
    expect(msgs[1]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(msgs[2]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
 // 总数 = tools 末条 + tail-2 + tail-1 = 3(≤ 官方上限 4)
    expect(breakpointsOf(m.requests[0]!.body)).toEqual(["tools#0", "msg1#0", "msg2#0"]);
    expect(breakpointsOf(m.requests[0]!.body).length).toBeLessThanOrEqual(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
  });

  it("缓存断点:system 转 blocks 末块打标 + 无 system 时不发 system 键;请求内断点总数 ≤ 官方上限 4", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    await p.chat([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hi" },
    ], TOOLS);
    const body = m.requests[0]!.body as { system: { type: string; text: string; cache_control?: unknown }[]; messages: { content: { cache_control?: unknown }[] }[]; tools: { cache_control?: unknown }[] };
    // 多段 system 合并为一串(与 chat 分支同语义),末块断点
    expect(body.system).toEqual([{ type: "text", text: "A\n\nB", cache_control: { type: "ephemeral" } }]);
    const count = [
      ...body.system.map((b) => b.cache_control),
      ...body.messages.flatMap((msg) => msg.content.map((b) => b.cache_control)),
      ...body.tools.map((t) => t.cache_control),
    ].filter((c) => c !== undefined).length;
    expect(count).toBe(3); // system 末块 + tools 末条 + 末条消息末块(消息仅 1 条,倒数第二条位置不存在)
    expect(count).toBeLessThanOrEqual(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
 // 位置明细:静态前缀两处 + 消息末块
    expect(breakpointsOf(m.requests[0]!.body)).toEqual(["tools#0", "system#0", "msg0#0"]);
    // 无 system 消息时不发 system 键(旧行为保持)
    await p.chat([{ role: "user", content: "x" }], []);
    expect(m.requests[1]!.body.system).toBeUndefined();
  });

  it("缓存断点预算截断:消息很多 + tools + system 时总数恰好 4(不是 5+),静态前缀断点两次请求位置不变", async () => {
    const m = await startMock((_req, res) => {
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
 // 候选 > 预算:system + tools + 两条消息断点 = 4 个候选全用满,再多也只能是 4
    const head = [
      { role: "system" as const, content: "S" },
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "q2" },
      { role: "assistant" as const, content: "a2" },
      { role: "user" as const, content: "q3" },
      { role: "assistant" as const, content: "a3" },
      { role: "user" as const, content: "q4" },
    ];
    await p.chat(head, TOOLS);
 // 第二次请求只追加尾部两条(前缀逐字节不变):静态前缀上的断点必须原地不动,否则缓存永不命中
    await p.chat([...head, { role: "assistant" as const, content: "a4" }, { role: "user" as const, content: "q5" }], TOOLS);
    const first = breakpointsOf(m.requests[0]!.body);
    const second = breakpointsOf(m.requests[1]!.body);
    expect(ANTHROPIC_CACHE_BREAKPOINT_LIMIT).toBe(4);
    expect(first).toHaveLength(4); // 恰好等于预算,不是 5
    expect(second).toHaveLength(4);
 // 静态前缀位置稳定(两次逐字相同)
    expect(first.filter((x) => x.startsWith("tools#"))).toEqual(["tools#0"]);
    expect(second.filter((x) => x.startsWith("tools#"))).toEqual(["tools#0"]);
    expect(first.filter((x) => x.startsWith("system#"))).toEqual(["system#0"]);
    expect(second.filter((x) => x.startsWith("system#"))).toEqual(["system#0"]);
 // 消息侧断点跟随尾部(相对固定历史定位):7 条消息 → tail-2=msg5 / tail-1=msg6;追加两条后 → msg7 / msg8
    expect(first.filter((x) => x.startsWith("msg"))).toEqual(["msg5#0", "msg6#0"]);
    expect(second.filter((x) => x.startsWith("msg"))).toEqual(["msg7#0", "msg8#0"]);
  });

  it("缓存断点:块自带 cache_control 时原样保留(含 ttl)、不覆盖、不重复计数", () => {
 // 适配器自身不预置标记(Message.content 是字符串、wire 块由适配器生成),preMarked 只可能来自
 // 将来上游块透传——这里钉打标原语的「已有标记不覆盖」与计划层的「已有标记占配额不新增」。
    const own: Record<string, unknown> = { type: "text", text: "p", cache_control: { type: "ephemeral", ttl: "1h" } };
    expect(markCacheBreakpoint(own)).toBe(false); // 不新增打标
    expect(own.cache_control).toEqual({ type: "ephemeral", ttl: "1h" }); // 原样保留(含 ttl 扩展字段)
    expect(markCacheBreakpoint(undefined)).toBe(false); // 空块空态
    const plan = planCacheBreakpoints({ hasTools: true, hasSystem: true, messageCount: 10, preMarked: ["system"] });
    expect(plan.slots.map((s) => s.kind)).toEqual(["tools", "message", "message"]); // system 让出槽位
    expect(plan.used).toBe(4); // 3 处新打标 + 1 处已有标记 = 4,没有重复计同一处
    expect(plan.used).toBeLessThanOrEqual(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
    expect(plan.skipped.some((s) => s.kind === "system" && s.reason === "pre-marked")).toBe(true);
  });

  it("usage 兼容形态:OpenAI 形态 prompt_tokens_details.cached_tokens(适配器不重复计缓存)+ 无缓存时不下发缓存字段", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    // 兼容口径 input 已含缓存:inputTokens=100(不是 180),cachedTokens=80,无 cacheCreationTokens
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedTokens: 80 });
    const m2 = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 7, output_tokens: 2 } });
    });
    servers.push(m2.server);
    const p2 = createOpenAiCompatProvider({ baseUrl: m2.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const r2 = await p2.chat([{ role: "user", content: "x" }], []);
    expect(r2.usage).toEqual({ inputTokens: 7, outputTokens: 2, totalTokens: 9 });
  });

  it("usage 原生口径 cache_read_input_tokens=0 必须显式下发 cachedTokens:0(区分「provider 说没命中」与「provider 没报字段」)", async () => {
 // 修:旧实现 `cached > 0 ? {cachedTokens} : {}` 把两者压成同一个「无字段」,
 // 导致命中率分析无法判断冷启动首调是真未命中还是计量缺失(经验证 cold run step0/step1 都无此字段)。
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, {
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 120 },
      });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    // inputTokens = input(100) + read(0) + write(120);cachedTokens 显式为 0(不是省略)
    expect(r.usage).toEqual({ inputTokens: 220, outputTokens: 5, totalTokens: 225, cachedTokens: 0, cacheCreationTokens: 120 });
    expect("cachedTokens" in (r.usage ?? {})).toBe(true);
  });

  it("usage 兼容形态二:Responses/realtime 形态 input_tokens_details(|input_token_details).cached_tokens 也命中", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 50, output_tokens: 3, input_tokens_details: { cached_tokens: 40 } } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 3, totalTokens: 53, cachedTokens: 40 });
    const m2 = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 50, output_tokens: 3, input_token_details: { cached_tokens: 20 } } });
    });
    servers.push(m2.server);
    const p2 = createOpenAiCompatProvider({ baseUrl: m2.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const r2 = await p2.chat([{ role: "user", content: "x" }], []);
    expect(r2.usage).toEqual({ inputTokens: 50, outputTokens: 3, totalTokens: 53, cachedTokens: 20 });
  });

  it("流式:message_start 种子 usage→text/thinking/input_json_delta 累积(跨 chunk)→message_delta 终值;onDelta 逐块透出", async () => {
    const m = await startMock((req, res) => {
      void req;
      sse(res, [
        { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "思考" } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "getTime", input: {} } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"tz"' } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ':"utc"}' } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 2 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ], { split: true });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    const deltas: { text?: string; reasoning?: string }[] = [];
    const r = await p.chat([{ role: "user", content: "hi" }], TOOLS, undefined, (d) => deltas.push(d));
    expect(m.requests[0]!.body.stream).toBe(true);
    expect(deltas).toEqual([{ text: "你" }, { text: "好" }, { reasoning: "思考" }]);
    expect(r.content).toBe("你好");
    expect(r.reasoning).toBe("思考");
    expect(r.toolCalls).toEqual([{ id: "toolu_2", name: "getTime", arguments: '{"tz":"utc"}' }]);
    expect(r.usage).toEqual({ inputTokens: 14, outputTokens: 6, totalTokens: 20, cachedTokens: 4 });
  });

  it("4xx 归一:anthropic error.type 前缀出口,形态 `LLM <status>: <type>: <message>`", async () => {
    const m = await startMock((_req, res) => {
      json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "bad", model: "m", apiType: "anthropic" });
    await expect(p.chat([{ role: "user", content: "x" }], [])).rejects.toThrow("LLM 401: authentication_error: invalid x-api-key");
  });

  it("流中 error 事件转异常", async () => {
    const m = await startMock((_req, res) => {
      sse(res, [{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }]);
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "anthropic" });
    await expect(p.chat([{ role: "user", content: "x" }], [], undefined, () => {})).rejects.toThrow("LLM stream: overloaded_error: Overloaded");
  });

  it("baseUrl 归一:尾 /v1 剥除后拼 /v1/messages(官方预设形态 https://…/v1)", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, { content: [{ type: "text", text: "ok" }] });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: `${m.base}/v1`, apiKey: "k", model: "m", apiType: "anthropic" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    expect(r.content).toBe("ok");
    expect(m.requests[0]!.url).toBe("/v1/messages"); // 不是 /v1/v1/messages
  });
});

// =============================================================================
// OpenAI Responses(POST /v1/responses)
// =============================================================================
describe("apiType=responses 端到端(mock server)", () => {
  it("非流式:凭证头(Bearer,无 x-api-key)/input 数组(system+input_text+input_image)/tools 扁平/store:false/reasoning+message+function_call+usage 归一", async () => {
    const m = await startMock((req, res) => {
      void req;
      json(res, 200, {
        id: "resp_1",
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "思路" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "答案" }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "getTime", arguments: '{"tz":"utc"}' },
        ],
        usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7, total_tokens: 16 },
      });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k-oai", model: "gpt-x", apiType: "responses", maxTokens: 4096, reasoningEffort: "low" });
    const r = await p.chat([
      { role: "system", content: "你是助手" },
      { role: "user", content: "看图", images: ["data:image/png;base64,QUJD"] },
    ], TOOLS);
    const req = m.requests[0]!;
    expect(req.url).toBe("/v1/responses");
    expect(req.headers["authorization"]).toBe("Bearer k-oai");
    expect(req.headers["x-api-key"]).toBeUndefined();
    // input 数组形态
    const input = req.body.input as Record<string, unknown>[];
    expect(input[0]).toEqual({ role: "system", content: "你是助手" });
    const uc = input[1]!.content as { type: string; text?: string; image_url?: string }[];
    expect(input[1]!.role).toBe("user");
    expect(uc[0]).toEqual({ type: "input_text", text: "看图" });
    expect(uc[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,QUJD" });
    // tools 扁平 + store:false + 参数映射
    const tools = req.body.tools as { type: string; name: string; parameters: Record<string, unknown>; strict: boolean }[];
    expect(tools![0]).toMatchObject({ type: "function", name: "getTime", strict: false });
    expect(tools![0]!.parameters).toEqual(TOOLS[0].parameters);
    expect(req.body.store).toBe(false);
    expect(req.body.max_output_tokens).toBe(4096);
    expect(req.body.reasoning).toEqual({ effort: "low" });
    // 归一出口
    expect(r.content).toBe("答案");
    expect(r.reasoning).toBe("思路");
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "getTime", arguments: '{"tz":"utc"}' }]);
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 7, totalTokens: 16, cachedTokens: 3 });
  });

  it("tool 往返:assistant 文本→output_text 项;toolCalls→function_call 项;结果→function_call_output 项", async () => {
    const m = await startMock((_req, res) => {
      json(res, 200, { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 3, output_tokens: 2 } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "responses" });
    await p.chat([
      { role: "user", content: "几点了" },
      { role: "assistant", content: "我查一下", toolCalls: [{ id: "call_7", name: "getTime", arguments: '{"tz":"utc"}' }] },
      { role: "tool", toolCallId: "call_7", content: "12:00" },
    ], TOOLS);
    const input = m.requests[0]!.body.input as Record<string, unknown>[];
    expect(input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "我查一下" }] });
    expect(input[2]).toEqual({ type: "function_call", call_id: "call_7", name: "getTime", arguments: '{"tz":"utc"}' });
    expect(input[3]).toEqual({ type: "function_call_output", call_id: "call_7", output: "12:00" });
  });

  it("流式:output_text.delta/function_call_arguments.delta/output_item.done 终值覆写/response.completed usage;onDelta 透出;[DONE] 哨兵容忍", async () => {
    const m = await startMock((_req, res) => {
      sse(res, [
        { event: "response.created", data: { type: "response.created", response: { id: "resp_1" } } },
        { event: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "message", role: "assistant", id: "msg_1" } } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_1", delta: "答" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_1", delta: "案" } },
        { event: "response.reasoning_summary_text.delta", data: { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "思路" } },
        { event: "response.output_item.added", data: { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "getTime", arguments: "" } } },
        { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"tz"' } },
        { event: "response.function_call_arguments.delta", data: { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: ':"utc"}' } },
        { event: "response.output_item.done", data: { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "getTime", arguments: '{"tz":"utc"}' } } },
        { event: "response.completed", data: { type: "response.completed", response: { usage: { input_tokens: 9, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7, total_tokens: 16 } } } },
      ], { tail: "data: [DONE]\n\n" });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "responses" });
    const deltas: { text?: string; reasoning?: string }[] = [];
    const r = await p.chat([{ role: "user", content: "hi" }], TOOLS, undefined, (d) => deltas.push(d));
    expect(m.requests[0]!.body.stream).toBe(true);
    expect(deltas).toEqual([{ text: "答" }, { text: "案" }, { reasoning: "思路" }]);
    expect(r.content).toBe("答案");
    expect(r.reasoning).toBe("思路");
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "getTime", arguments: '{"tz":"utc"}' }]);
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 7, totalTokens: 16, cachedTokens: 3 });
  });

  it("4xx 归一:error.code 前缀出口,形态 `LLM <status>: <code>: <message>`", async () => {
    const m = await startMock((_req, res) => {
      json(res, 400, { error: { code: "unknown_parameter", message: "Unknown parameter: 'foo'" } });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "responses" });
    await expect(p.chat([{ role: "user", content: "x" }], [])).rejects.toThrow("LLM 400: unknown_parameter: Unknown parameter: 'foo'");
  });

  it("流中 response.failed/error 事件转异常", async () => {
    const m = await startMock((_req, res) => {
      sse(res, [{ event: "response.failed", data: { type: "response.failed", response: { error: { code: "rate_limit_exceeded", message: "Slow down" } } } }]);
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "responses" });
    await expect(p.chat([{ role: "user", content: "x" }], [], undefined, () => {})).rejects.toThrow("LLM stream: Slow down");
  });

  it("baseUrl 归一:尾 /v1 剥除后拼 /v1/responses", async () => {
    const m = await startMock((_req, res) => {
      json(res, 200, { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
    });
    servers.push(m.server);
    const p = createOpenAiCompatProvider({ baseUrl: `${m.base}/v1`, apiKey: "k", model: "m", apiType: "responses" });
    const r = await p.chat([{ role: "user", content: "x" }], []);
    expect(r.content).toBe("ok");
    expect(m.requests[0]!.url).toBe("/v1/responses");
  });
});

// =============================================================================
// chat 模式不受 apiType 适配影响(现状锚)
// =============================================================================
describe("apiType 未声明/chat=现状(端到端锚)", () => {
  it("缺省走 /v1/chat/completions + Bearer + chat 消息形态;显式 chat 同", async () => {
    const m = await startMock((_req, res) => {
      json(res, 200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    });
    servers.push(m.server);
    const p1 = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m" });
    const p2 = createOpenAiCompatProvider({ baseUrl: m.base, apiKey: "k", model: "m", apiType: "chat" });
    const r1 = await p1.chat([{ role: "user", content: "x" }], []);
    const r2 = await p2.chat([{ role: "user", content: "x" }], []);
    expect(r1.content).toBe("ok");
    expect(r2.content).toBe("ok");
    for (const req of m.requests) {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers["authorization"]).toBe("Bearer k");
      expect((req.body.messages as unknown[])[0]).toEqual({ role: "user", content: "x" });
      expect(req.body.input).toBeUndefined();
      expect(req.body.system).toBeUndefined();
    }
  });
});
