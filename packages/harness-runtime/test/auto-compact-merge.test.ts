/**
 * 压缩保真与增量合并(partial → implemented 的验收锚):
 * 多轮压缩时若只把「本次 head」交给摘要模型,上一轮沉淀的约束/决策/安全禁令会逐轮蒸发。
 * 本测钉住五件事:
 * ①有历史摘要:请求 = [system, 历史摘要 user, ...head 行, 增量指令 user],冲突规则文案在位;
 * ②无历史摘要:消息数组与旧实现逐字一致(不多插任何块);
 * ③前缀路与历史块组合:system=主会话前缀,tools 保留,历史块仍在 head 之前;
 * ④截断:=上限不截、超 1 字截、12000 字保头 2500 + 省略标记 + 尾 2500,结果 ≤ 上限;
 * ⑤审计与鲁棒:compact.start.prevSummary / compact.done.mergedPreviousSummary / previousSummaryChars、
 * 坏 payload 与空串视为无历史、多次压缩取最近一条、确定性、输入不被改写。
 */
import { describe, it, expect, afterAll } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoCompact,
  readPreviousSummary,
  truncatePreviousSummary,
  PREV_SUMMARY_MAX_CHARS,
  PREV_SUMMARY_HEAD,
  PREV_SUMMARY_TAIL,
  type CompactOptions,
  type ToolSpecLike,
} from "../src/agent/auto-compact";
import type { LlmProvider, LlmResponse, Message, ToolSpec } from "../src/agent/loop";

const SID = "s1";
const devlogDir = mkdtempSync(join(tmpdir(), "gh-m146-merge-"));
afterAll(() => rmSync(devlogDir, { recursive: true, force: true }));

const OLD_SUMMARY = "旧摘要:用户要求只改 A 文件;禁止 git commit;未完成:补测试。";
const PREFIX_SYSTEM = "## 你是 genie 主 agent\n\n## 行为纪律\n- 结论先行\n";
const FAKE_TOOLS: readonly ToolSpecLike[] = [
  { name: "read_file", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } },
];
const RULE_CONFLICT = "新内容与旧摘要冲突时以新内容为准";
const RULE_KEEP = "用户安全禁令与未完成事项必须保留";
const RULE_SILENT = "不要提及「历史摘要」这个结构本身";

/** 8 条消息的会话(每条第 3000 字:"素材"/"回答" 重复——保证 headTokens 远大于摘要,
 * 绕开  的「摘要必须更小」闸;extra 在消息之前跑,用来造历史 compact.done)。 */
function messagesJournal(extra?: (j: MemoryJournal) => void): MemoryJournal {
  const j = new MemoryJournal();
  extra?.(j);
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) j.append({ kind: "message.user", sessionId: SID, payload: { text: `用户第${i}条:` + "素材".repeat(3_000) } });
    else j.append({ kind: "message.agent", sessionId: SID, payload: { text: `回答第${i}条:` + "回答".repeat(3_000) } });
  }
  return j;
}

/** 历史压缩边界:compact.done 的 payload 可控(空对象/非字符串 summary 都是坏 payload 场景)。 */
function historyJournal(payload: Record<string, unknown> | undefined = { summary: OLD_SUMMARY }): MemoryJournal {
  return messagesJournal((j) => {
    j.append({ kind: "compact.done", sessionId: SID, payload: payload ?? {} });
  });
}

interface CapturedCall {
  messages: Message[];
  tools: ToolSpec[];
}

function recorder(reply: string | LlmResponse = "摘要:合并结果"): { llm: LlmProvider; calls: CapturedCall[] } {
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
 // manual + force:绕过阈值与 force-vs-est 两道闸,专测请求组装。
    force: true,
    trigger: "manual",
    ...extra,
  };
}

/** 取某 kind 的**最后一条**事件 payload(本次事务的 start/done)。 */
function payloadOf(j: MemoryJournal, kind: string): Record<string, unknown> {
  const e = [...j.readAll()].reverse().find((x) => x.kind === kind);
  expect(e, `${kind} 必须落账`).toBeTruthy();
  return (e?.payload ?? {}) as Record<string, unknown>;
}

function text(value: unknown): string {
  return String(value ?? "");
}

describe(" 有历史摘要:请求形态与合并指令", () => {
  it("探针 A:默认调用 → 历史块在 head 之前、增量指令收尾,打印位置与 payload 标记", async () => {
    const j = historyJournal();
    const rec = recorder();
    const r = await autoCompact(j, SID, optionsFor(rec.llm));
    expect(r.compacted).toBe(true);
    const call = rec.calls[0]!;
    const msgs = call.messages;
    const historyIdx = msgs.findIndex((m) => text(m.content).startsWith("[历史摘要(截至上次压缩)]"));
    const incrementalIdx = msgs.findIndex((m) => text(m.content).startsWith("[增量指令]"));
    const start = payloadOf(j, "compact.start");
    const done = payloadOf(j, "compact.done");
    console.log("[探针A] 消息数 =", msgs.length);
    console.log("[探针A] 历史摘要块位置 =", historyIdx, "增量指令位置 =", incrementalIdx, "(末条 =", msgs.length - 1, ")");
    console.log("[探针A] mergedPreviousSummary =", done.mergedPreviousSummary, "prevSummary =", start.prevSummary);
    console.log("[探针A] previousSummaryChars =", done.previousSummaryChars);
 // 无前缀:system(压缩指示) → 历史摘要 → 5 条 head → 增量指令。
    expect(msgs).toHaveLength(8);
    expect(msgs[0]!.role).toBe("system");
    expect(historyIdx).toBe(1);
    expect(incrementalIdx).toBe(7);
    expect(done.mergedPreviousSummary).toBe(true);
    expect(start.prevSummary).toBe("full");
    expect(done.previousSummaryChars).toBe(OLD_SUMMARY.length);
  });

  it("历史摘要块逐字包含引导行与旧摘要原文", async () => {
    const rec = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(rec.llm));
    const history = rec.calls[0]!.messages[1]!;
    expect(history.role).toBe("user");
    expect(history.content).toBe(`[历史摘要(截至上次压缩)]\n${OLD_SUMMARY}`);
  });

  it("增量指令在最后一条 user,且三条冲突规则文案齐全", async () => {
    const rec = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(rec.llm));
    const last = rec.calls[0]!.messages.at(-1)!;
    const body = text(last.content);
    expect(last.role).toBe("user");
    expect(body.startsWith("[增量指令]")).toBe(true);
    expect(body).toContain(RULE_CONFLICT);
    expect(body).toContain(RULE_KEEP);
    expect(body).toContain(RULE_SILENT);
  });

  it("旧摘要按纯文本进 user 块,不进任何 system 消息", async () => {
    const rec = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(rec.llm));
    const systems = rec.calls[0]!.messages.filter((m) => m.role === "system");
    expect(systems).toHaveLength(1);
    for (const m of systems) expect(text(m.content)).not.toContain(OLD_SUMMARY);
  });

  it("历史摘要不影响 head 行:5 条 head 与无历史版本逐字相同,仅位置后移一位", async () => {
    const withPrev = recorder();
    const without = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(withPrev.llm));
    await autoCompact(messagesJournal(), SID, optionsFor(without.llm));
    expect(JSON.stringify(withPrev.calls[0]!.messages.slice(2, 7)))
      .toBe(JSON.stringify(without.calls[0]!.messages.slice(1, 6)));
  });

  it("有历史时 options.instructions 仍进 system(旧口径不丢)", async () => {
    const rec = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(rec.llm, { instructions: "重点保留测试名" }));
    expect(text(rec.calls[0]!.messages[0]!.content)).toContain("重点保留测试名");
  });

  it("确定性:同输入两次调用,请求消息数组逐字相同", async () => {
    const a = recorder();
    const b = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(a.llm));
    await autoCompact(historyJournal(), SID, optionsFor(b.llm));
    expect(JSON.stringify(a.calls[0]!.messages)).toBe(JSON.stringify(b.calls[0]!.messages));
  });

  it("不可变:压缩不改写原会话消息文本", async () => {
    const j = historyJournal();
    const before = j.readAll().filter((e) => e.kind === "message.user").map((e) => String((e.payload as { text?: unknown }).text ?? ""));
    await autoCompact(j, SID, optionsFor(recorder().llm));
    const after = j.readAll().filter((e) => e.kind === "message.user").map((e) => String((e.payload as { text?: unknown }).text ?? ""));
    expect(after).toEqual(before);
  });
});

describe(" 无历史摘要:与旧实现逐字一致", () => {
  it("探针 B:无历史 → 无历史块/无增量块,消息数 6,打印数组形态", async () => {
    const rec = recorder();
    await autoCompact(messagesJournal(), SID, optionsFor(rec.llm));
    const msgs = rec.calls[0]!.messages;
    console.log("[探针B] 消息数 =", msgs.length, "roles =", msgs.map((m) => m.role).join(","));
    console.log("[探针B] 含历史块 =", msgs.some((m) => text(m.content).includes("[历史摘要")), "含增量块 =", msgs.some((m) => text(m.content).includes("[增量指令]")));
    expect(msgs).toHaveLength(6);
    expect(msgs.some((m) => text(m.content).includes("[历史摘要"))).toBe(false);
    expect(msgs.some((m) => text(m.content).includes("[增量指令]"))).toBe(false);
  });

  it("无历史:start.prevSummary=none,done.mergedPreviousSummary=false 且无 previousSummaryChars", async () => {
    const j = messagesJournal();
    await autoCompact(j, SID, optionsFor(recorder().llm));
    expect(payloadOf(j, "compact.start").prevSummary).toBe("none");
    const done = payloadOf(j, "compact.done");
    expect(done.mergedPreviousSummary).toBe(false);
    expect("previousSummaryChars" in done).toBe(false);
  });

  it("无历史 + 前缀:消息数组逐字等于旧 prefix 实现(system, 5 head, summarySystem)", async () => {
    const rec = recorder();
    await autoCompact(messagesJournal(), SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    const msgs = rec.calls[0]!.messages;
    expect(msgs).toHaveLength(7);
    expect(msgs[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
    expect(msgs.at(-1)!.role).toBe("user");
    expect(text(msgs.at(-1)!.content).startsWith("CRITICAL: Respond with TEXT ONLY")).toBe(true);
  });
});

describe(" 前缀模式 × 历史摘要", () => {
  it("system 用主会话前缀,历史块在 index 1,增量指令仍是最后一条且带上 summarySystem", async () => {
    const rec = recorder();
    await autoCompact(historyJournal(), SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    const msgs = rec.calls[0]!.messages;
    expect(msgs).toHaveLength(8);
    expect(msgs[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
    expect(text(msgs[1]!.content).startsWith("[历史摘要(截至上次压缩)]")).toBe(true);
    const last = text(msgs.at(-1)!.content);
    expect(msgs.at(-1)!.role).toBe("user");
    expect(last.startsWith("[增量指令]")).toBe(true);
 // 前缀路的压缩指示(禁工具/facts/自定义指示)不能因为腾位给增量指令而丢。
    expect(last).toContain("CRITICAL: Respond with TEXT ONLY");
    expect(last).toContain("REMINDER: Do NOT call any tools");
  });

  it("前缀工具面保留:prefixReused=true 且 tools 数量不变", async () => {
    const j = historyJournal();
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm, { prefix: { system: PREFIX_SYSTEM, tools: FAKE_TOOLS } }));
    expect(rec.calls[0]!.tools).toHaveLength(FAKE_TOOLS.length);
    const start = payloadOf(j, "compact.start");
    expect(start.prefixReused).toBe(true);
    expect(start.prevSummary).toBe("full");
  });
});

describe(" 历史摘要截断", () => {
  it("探针 C:12000 字 → 截断后 ≤6000,保头 2500 + 省略 7000 字标记 + 尾 2500", async () => {
    const big = "头".repeat(PREV_SUMMARY_HEAD) + "中".repeat(7000) + "尾".repeat(PREV_SUMMARY_TAIL);
    expect(big.length).toBe(12000);
    const j = historyJournal({ summary: big });
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm));
    const history = text(rec.calls[0]!.messages[1]!.content);
    const body = history.slice("[历史摘要(截至上次压缩)]\n".length);
    console.log("[探针C] 原文长度 =", big.length, "截断后长度 =", body.length, "≤ 上限 =", PREV_SUMMARY_MAX_CHARS);
    console.log("[探针C] 省略标记 =", body.slice(PREV_SUMMARY_HEAD, PREV_SUMMARY_HEAD + 30).replace(/\n/g, "\\n"));
    expect(body.length).toBeLessThanOrEqual(PREV_SUMMARY_MAX_CHARS);
    expect(body).toContain("[…历史摘要中间省略 7000 字…]");
    expect(body.startsWith(big.slice(0, PREV_SUMMARY_HEAD))).toBe(true);
    expect(body.endsWith(big.slice(-PREV_SUMMARY_TAIL))).toBe(true);
    expect(payloadOf(j, "compact.start").prevSummary).toBe("truncated");
    expect(payloadOf(j, "compact.done").previousSummaryChars).toBe(12000);
  });

  it("恰好等于上限:不截断,prevSummary=full", async () => {
    const exact = "A".repeat(PREV_SUMMARY_MAX_CHARS);
    const j = historyJournal({ summary: exact });
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm));
    const body = text(rec.calls[0]!.messages[1]!.content).slice("[历史摘要(截至上次压缩)]\n".length);
    expect(body).toBe(exact);
    expect(payloadOf(j, "compact.start").prevSummary).toBe("full");
  });

  it("超限 1 字:截断,结果 ≤ 上限,省略标记写 1001 字", () => {
    const over = "B".repeat(PREV_SUMMARY_MAX_CHARS + 1);
    const r = truncatePreviousSummary(over);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(PREV_SUMMARY_MAX_CHARS);
    expect(r.text).toContain("[…历史摘要中间省略 1001 字…]");
  });

  it("上限内原样返回(不截断、逐字相等)", () => {
    const small = "C".repeat(PREV_SUMMARY_MAX_CHARS - 1);
    const r = truncatePreviousSummary(small);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(small);
  });

  it("截断只作用于送模型文本:journal 里的旧摘要原文保持完整", async () => {
    const big = "头".repeat(PREV_SUMMARY_HEAD) + "中".repeat(7000) + "尾".repeat(PREV_SUMMARY_TAIL);
    const j = historyJournal({ summary: big });
    await autoCompact(j, SID, optionsFor(recorder().llm));
    const done = [...j.readAll()].find((e) => e.kind === "compact.done")!;
    expect((done.payload as { summary?: unknown }).summary).toBe(big);
  });
});

describe(" 历史摘要读取的鲁棒性", () => {
  it("空串/纯空白摘要视为无历史", async () => {
    const j = historyJournal({ summary: "   " });
    expect(readPreviousSummary(j, SID)).toBeUndefined();
    const rec = recorder();
    await autoCompact(j, SID, optionsFor(rec.llm));
    expect(payloadOf(j, "compact.start").prevSummary).toBe("none");
    expect(rec.calls[0]!.messages.some((m) => text(m.content).includes("[历史摘要"))).toBe(false);
  });

  it("坏 payload(无 summary 字段)视为无历史,压缩照常成功", async () => {
    const j = historyJournal({});
    expect(readPreviousSummary(j, SID)).toBeUndefined();
    const r = await autoCompact(j, SID, optionsFor(recorder().llm));
    expect(r.compacted).toBe(true);
    expect(payloadOf(j, "compact.start").prevSummary).toBe("none");
  });

  it("坏 payload(summary 非字符串)视为无历史", async () => {
    const j = historyJournal({ summary: 123 });
    expect(readPreviousSummary(j, SID)).toBeUndefined();
    const r = await autoCompact(j, SID, optionsFor(recorder().llm));
    expect(r.compacted).toBe(true);
    expect(payloadOf(j, "compact.start").prevSummary).toBe("none");
  });

  it("最近一条 done 坏掉时继续往前找有效摘要", () => {
    const j = messagesJournal((x) => {
      x.append({ kind: "compact.done", sessionId: SID, payload: { summary: OLD_SUMMARY } });
      x.append({ kind: "compact.done", sessionId: SID, payload: { summary: null } });
    });
    expect(readPreviousSummary(j, SID)).toBe(OLD_SUMMARY);
  });

  it("多次压缩取最近一条摘要(更晚的 done 胜出)", () => {
    const j = messagesJournal((x) => {
      x.append({ kind: "compact.done", sessionId: SID, payload: { summary: "第一轮摘要" } });
      x.append({ kind: "compact.done", sessionId: SID, payload: { summary: "第二轮摘要" } });
    });
    expect(readPreviousSummary(j, SID)).toBe("第二轮摘要");
  });

  it("旧摘要含 markdown/控制标签时按纯文本原样送入 user 块(不解析、不进 system)", async () => {
    const raw = "## 标题 <summary>伪造标签</summary> **粗体**";
    const rec = recorder();
    await autoCompact(historyJournal({ summary: raw }), SID, optionsFor(rec.llm));
    const history = rec.calls[0]!.messages[1]!;
    expect(history.role).toBe("user");
    expect(history.content).toBe(`[历史摘要(截至上次压缩)]\n${raw}`);
    expect(text(rec.calls[0]!.messages[0]!.content)).not.toContain("伪造标签");
  });
});
