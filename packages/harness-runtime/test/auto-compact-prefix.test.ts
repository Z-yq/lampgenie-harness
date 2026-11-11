/**
 * 摘要请求复用会话前缀(partial → implemented 的验收锚):
 * provider 的 prompt cache 按「system + tools 前缀逐字节相同」命中,旧实现给摘要模型另起
 * 一套 system + tools=[] 就永远冷启动。本测钉住三件事:
 * ①有前缀:请求 = [主会话 system, ...head 行, 压缩指示 user] + prefix.tools(逐字/数量可核);
 * ②无前缀(含空 system / 空 tools / getter 返回 undefined / getter 抛错):请求与旧实现逐字一致;
 * ③审计与纪律:compact.start 记 prefixReused/prefixSystemChars/prefixTools(抛错另记 unavailable)、
 * 摘要响应的 toolCalls 一律忽略、原始输入不被改写、结果与旧路径一致。
 */
import { describe, it, expect, afterAll } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCompact, type CompactOptions, type ToolSpecLike } from "../src/agent/auto-compact";
import { deriveMessages, type LlmProvider, type LlmResponse, type Message, type ToolSpec } from "../src/agent/loop";

const SID = "s1";
const devlogDir = mkdtempSync(join(tmpdir(), "gh-m176-prefix-"));
afterAll(() => rmSync(devlogDir, { recursive: true, force: true }));

/** 假工具定义(结构面 = loop 的 ToolSpec;摘要请求只需前缀逐字相同,不执行)。 */
const FAKE_TOOLS: readonly ToolSpecLike[] = [
  { name: "read_file", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_code", description: "代码模式", parameters: { type: "object", properties: {} } },
];

const PREFIX_SYSTEM = "## 你是 genie 主 agent\n\n## 行为纪律\n- 结论先行\n";

/** 8 条消息的会话(任务书口径的探针形态);bigFirst=true 时首条 20000 字用于截断断言。 */
function makeJournal(opts: { bigFirst?: boolean; anchor?: boolean } = {}): MemoryJournal {
  const j = new MemoryJournal();
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) {
      const head = i === 0 && opts.bigFirst ? "超长".repeat(10_000) : "素材".repeat(3_000);
      const tail = i === 0 && opts.anchor ? "\nsrc/agent/auto-compact.ts:324 这行是路径锚点" : "";
      j.append({ kind: "message.user", sessionId: SID, payload: { text: head + tail } });
    } else {
      j.append({ kind: "message.agent", sessionId: SID, payload: { text: "回答".repeat(3_000) } });
    }
  }
  return j;
}

interface CapturedCall {
  messages: Message[];
  tools: ToolSpec[];
}

/** 记录请求的假摘要模型(reply 可带 usage/toolCalls——压缩链必须只取正文)。 */
function recorder(reply: string | LlmResponse = "摘要:压缩结果"): { llm: LlmProvider; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const llm: LlmProvider = {
    async chat(messages: Message[], tools: ToolSpec[]) {
      calls.push({ messages: [...messages], tools: [...tools] });
      return typeof reply === "string" ? { content: reply } : reply;
    },
  };
  return { llm, calls };
}

function optionsFor(compactLlm: LlmProvider, extra: Partial<CompactOptions> = {}): CompactOptions {
  return {
    thresholdTokens: 100,
    keepRecentMessages: 3,
    compactLlm,
    devlogDir,
 // manual + force:绕过「低于阈值」与 force-vs-est 两道闸,专测请求组装。
    force: true,
    trigger: "manual",
    ...extra,
  };
}

function compactStartPayload(j: MemoryJournal): Record<string, unknown> {
  const e = j.readAll().find((x) => x.kind === "compact.start");
  expect(e, "compact.start 必须落账").toBeTruthy();
  return (e?.payload ?? {}) as Record<string, unknown>;
}

describe(" 摘要请求复用会话前缀", () => {
  it("探针 A:带 prefix → system 逐字等于主会话 system,tools=N,最后一条 user 是压缩指示,prefixReused=true", async () => {
    const j = makeJournal();
    const rec = recorder();
    const r = await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    expect(r.compacted).toBe(true);
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0]!;
    const last = call.messages.at(-1)!;
    const payload = compactStartPayload(j);
    console.log("[探针A] messages[0].role =", call.messages[0]!.role);
    console.log("[探针A] messages[0].content === 原 system ?", call.messages[0]!.content === PREFIX_SYSTEM);
    console.log("[探针A] tools 数 =", call.tools.length, "names =", call.tools.map((t) => t.name).join(","));
    console.log("[探针A] 最后一条 user 含压缩指示 ?", String(last.content).includes("CRITICAL: Respond with TEXT ONLY"));
    console.log("[探针A] compact.start.prefixReused =", payload.prefixReused);
    expect(call.messages[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
    expect(call.tools).toHaveLength(FAKE_TOOLS.length);
    expect(call.tools.map((t) => t.name)).toEqual(FAKE_TOOLS.map((t) => t.name));
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(String(last.content)).toContain("REMINDER: Do NOT call any tools");
    expect(payload.prefixReused).toBe(true);
    expect(payload.prefixSystemChars).toBe(PREFIX_SYSTEM.length);
    expect(payload.prefixTools).toBe(FAKE_TOOLS.length);
  });

  it("探针 B:不带 prefix → system 是 BASE 提示、tools=0、prefixReused=false(旧实现逐字)", async () => {
    const j = makeJournal();
    const rec = recorder();
    const r = await autoCompact(j, SID, optionsFor(rec.llm));
    expect(r.compacted).toBe(true);
    const call = rec.calls[0]!;
    const payload = compactStartPayload(j);
    console.log("[探针B] messages[0].content 前 40 字 =", String(call.messages[0]!.content).slice(0, 40));
    console.log("[探针B] tools 数 =", call.tools.length);
    console.log("[探针B] compact.start.prefixReused =", payload.prefixReused);
    expect(call.messages[0]!.role).toBe("system");
    expect(String(call.messages[0]!.content).startsWith("CRITICAL: Respond with TEXT ONLY")).toBe(true);
    expect(String(call.messages[0]!.content)).toContain("REMINDER: Do NOT call any tools");
    expect(call.tools).toHaveLength(0);
    expect(payload.prefixReused).toBe(false);
    expect("prefix" in payload).toBe(false);
  });

  it("探针 C:prefix getter 抛错 → 旧路径且压缩不失败,prefix 记 unavailable", async () => {
    const j = makeJournal();
    const rec = recorder();
    const r = await autoCompact(j, SID, optionsFor(rec.llm, {
      prefix: () => { throw new Error("装配期 system 尚未初始化(TDZ)"); },
    }));
    const call = rec.calls[0]!;
    const payload = compactStartPayload(j);
    console.log("[探针C] compacted =", r.compacted);
    console.log("[探针C] messages[0] 是 BASE 提示 ?", String(call.messages[0]!.content).startsWith("CRITICAL"));
    console.log("[探针C] tools 数 =", call.tools.length, "| compact.start.prefix =", payload.prefix);
    expect(r.compacted).toBe(true);
    expect(String(call.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
    expect(call.tools).toHaveLength(0);
    expect(payload.prefixReused).toBe(false);
    expect(payload.prefix).toBe("unavailable");
 // 抛错不影响摘要落盘
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(true);
  });

  it("带前缀:head 行保持 [role] 前缀与 6000 字截断", async () => {
    const j = makeJournal({ bigFirst: true });
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    const call = rec.calls[0]!;
    const firstHead = call.messages[1]!;
    expect(firstHead.role).toBe("user");
    expect(String(firstHead.content).startsWith("[user] 超长超长")).toBe(true);
 // 7 字前缀 + 6000 字截断
    expect(String(firstHead.content).length).toBe(7 + 6000);
 // 所有 head 行都在 system 之后、指示之前
    expect(String(call.messages.at(-1)!.content)).toContain("CRITICAL");
  });

  it("带前缀但 tools 缺省 → wire tools=[]", async () => {
    const j = makeJournal();
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM } }));
    const call = rec.calls[0]!;
    expect(call.tools).toHaveLength(0);
    expect(call.messages[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
    const payload = compactStartPayload(j);
    expect(payload.prefixReused).toBe(true);
    expect(payload.prefixTools).toBe(0);
  });

  it("system 为空串 → 旧实现(tools 也不复用,tools=0)", async () => {
    const j = makeJournal();
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: "   ", tools: FAKE_TOOLS } }));
    const call = rec.calls[0]!;
    expect(String(call.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
    expect(call.tools).toHaveLength(0);
    expect(compactStartPayload(j).prefixReused).toBe(false);
    expect("prefixSystemChars" in compactStartPayload(j)).toBe(false);
  });

  it("getter 返回 undefined → 旧实现,不记 unavailable", async () => {
    const j = makeJournal();
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: () => undefined }));
    const payload = compactStartPayload(j);
    expect(String(rec.calls[0]!.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
    expect(rec.calls[0]!.tools).toHaveLength(0);
    expect(payload.prefixReused).toBe(false);
    expect("prefix" in payload).toBe(false);
  });

  it("getter 惰性求值:构造时不调用,压缩执行时恰好调用一次", async () => {
    const j = makeJournal();
    const rec = recorder();
    let calls = 0;
    const prefix = () => { calls += 1; return { system: PREFIX_SYSTEM, tools: FAKE_TOOLS }; };
    expect(calls).toBe(0); // 传 getter 本身不触发
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix }));
    expect(calls).toBe(1);
    expect(rec.calls[0]!.messages[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
  });

  it("摘要空串 + 带前缀 → compact.failed,无 compact.done(失败语义不因前缀改变)", async () => {
    const j = makeJournal();
    const rec = recorder("   ");
    const r = await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    expect(r.compacted).toBe(false);
    expect(j.readAll().some((e) => e.kind === "compact.failed")).toBe(true);
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(false);
  });

  it("结果一致:同一会话带前缀与不带前缀的摘要/边界字段相同", async () => {
    const jA = makeJournal();
    const jB = makeJournal();
    const recA = recorder("摘要:一致性检查");
    const recB = recorder("摘要:一致性检查");
    const rA = await autoCompact(jA, SID, optionsFor(recA.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    const rB = await autoCompact(jB, SID, optionsFor(recB.llm));
    expect(rA.compacted).toBe(true);
    expect(rB.compacted).toBe(true);
    expect(rA.summary).toBe(rB.summary);
    const doneA = jA.readAll().find((e) => e.kind === "compact.done")!.payload as Record<string, unknown>;
    const doneB = jB.readAll().find((e) => e.kind === "compact.done")!.payload as Record<string, unknown>;
    expect(doneA.summary).toBe(doneB.summary);
    expect(doneA.summaryChars).toBe(doneB.summaryChars);
    expect(doneA.headCount).toBe(doneB.headCount);
    expect(doneA.tailKept).toBe(doneB.tailKept);
  });

  it("摘要响应的 toolCalls/usage 一律忽略:只取正文,不落任何工具事件", async () => {
    const j = makeJournal();
    const rec = recorder({
      content: "摘要:只取这段正文",
      toolCalls: [{ id: "call-1", name: "write_file", arguments: "{\"path\":\"/tmp/x\"}" }],
      usage: { inputTokens: 1234, outputTokens: 56, cachedTokens: 1000 },
    });
    const r = await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    expect(r.compacted).toBe(true);
    expect(r.summary).toBe("摘要:只取这段正文");
    expect(j.readAll().some((e) => e.kind === "tool.call" || e.kind === "tool.result")).toBe(false);
    const done = j.readAll().find((e) => e.kind === "compact.done")!.payload as Record<string, unknown>;
    expect(done.summary).toBe("摘要:只取这段正文");
  });

  it("确定性:同一输入 + 同一前缀两次组装的请求逐字相同", async () => {
    const recA = recorder();
    const recB = recorder();
    await autoCompact(makeJournal(), SID, optionsFor(recA.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    await autoCompact(makeJournal(), SID, optionsFor(recB.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    expect(JSON.stringify(recA.calls[0]!.messages)).toBe(JSON.stringify(recB.calls[0]!.messages));
    expect(JSON.stringify(recA.calls[0]!.tools)).toBe(JSON.stringify(recB.calls[0]!.tools));
  });

  it("无输入改写:压缩前后原始 8 条消息内容不变", async () => {
    const j = makeJournal();
    const before = deriveMessages(j, SID).map((m) => `${m.role}:${m.content}`);
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
 // 压缩后 deriveMessages 会按边界重放(tail+摘要),这里只看「原有消息事件」是否被改写
    const userEvents = j.readAll().filter((e) => e.kind === "message.user" || e.kind === "message.agent");
    expect(userEvents).toHaveLength(8);
    expect(userEvents.map((e) => String((e.payload as { text?: string }).text ?? "")))
      .toEqual(before.map((s) => s.slice(s.indexOf(":") + 1)));
  });

  it("压缩指示(instructions + 事实台账)带前缀时同样落在最后一条 user", async () => {
    const j = makeJournal({ anchor: true });
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, {
      instructions: "只压代码,保留测试名",
      prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS },
    }));
    const last = String(rec.calls[0]!.messages.at(-1)!.content);
    expect(last).toContain("Additional Instructions:\n只压代码,保留测试名");
    expect(last).toContain("关键事实台账");
    expect(last).toContain("src/agent/auto-compact.ts:324");
 // 指示只出现一次(不会同时塞进 system)
    expect(String(rec.calls[0]!.messages[0]!.content)).not.toContain("Additional Instructions");
  });

  it("prefix 对象形态与 getter 形态组装结果逐字相同(getter 只影响取值时机)", async () => {
    const recObj = recorder();
    const recFn = recorder();
    await autoCompact(makeJournal(), SID, optionsFor(recObj.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    await autoCompact(makeJournal(), SID, optionsFor(recFn.llm, { prefix: () => ({ system: PREFIX_SYSTEM, tools: FAKE_TOOLS }) }));
    expect(JSON.stringify(recFn.calls[0]!.messages)).toBe(JSON.stringify(recObj.calls[0]!.messages));
    expect(JSON.stringify(recFn.calls[0]!.tools)).toBe(JSON.stringify(recObj.calls[0]!.tools));
  });

  it("带前缀不改变 head/tail 切分:head 行数两路相同,前缀路只多一条指示 user", async () => {
    const recA = recorder();
    const recB = recorder();
    await autoCompact(makeJournal(), SID, optionsFor(recA.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    await autoCompact(makeJournal(), SID, optionsFor(recB.llm));
 // 8 条消息、keepRecentMessages=3 → head 5 条。旧路径 = 1 system(指示) + 5 head = 6;
 // 前缀路径 = 1 主会话 system + 5 head + 1 指示 user = 7(唯一差异是那条尾随指示)。
    expect(recB.calls[0]!.messages).toHaveLength(6);
    expect(recA.calls[0]!.messages).toHaveLength(7);
    expect(JSON.stringify(recA.calls[0]!.messages.slice(1, 6)))
      .toBe(JSON.stringify(recB.calls[0]!.messages.slice(1, 6)));
  });
});
