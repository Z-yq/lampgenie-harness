import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * 摘要前缀复用的「装配面」验收:
 * ①源码级接线锚——compact-hook 必须真的把 prefix 透传给 autoCompact,agent-wiring 必须在
 * makeCompactHook 处传 getter(且 getter 引用的是主 loop 真正发出的 system / 工具面);
 * 只定义选项不传=没接线,这类「代码在、生产路径没接」的返工本仓反复出现过,故静态锁死。
 * ②行为级三态——注入前缀 → 摘要请求首条 system 与 tools 数等于注入值;不注入 → 旧路径;
 * getter 抛错 → 压缩照常成功并留 unavailable 审计。
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryJournal } from "@lampgenie/core";
import { ExperienceStore } from "@lampgenie/experience";
import type { LlmProvider, Message, ToolSpec } from "@lampgenie/runtime/agent/loop";
import { makeCompactHook } from "../src/compact-hook.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const src = (rel: string): string => readFileSync(`${ROOT}${rel}`, "utf-8");

const HOOK_SRC = src("apps/gateway/src/compact-hook.ts");
const WIRING_SRC = AGENT_WIRING_SRC;
const AUTO_COMPACT_SRC = src("packages/harness-runtime/src/agent/auto-compact.ts");

const tmp = mkdtempSync(join(tmpdir(), "m176-prefix-wiring-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PREFIX_SYSTEM = "## 你是一个主 agent\n\n## 行为纪律\n- 结论先行\n";
const PREFIX_TOOLS = [
  { name: "read_file", description: "读取文件", parameters: { type: "object" } },
  { name: "run_code", description: "代码模式", parameters: { type: "object" } },
  { name: "spawn_subagent", description: "派发子代理", parameters: { type: "object" } },
];

/** 12 条消息 + 经验证 usage 超显式阈值:让钩子真的走到 autoCompact(与 compact-hook.test 同形态)。 */
function bigJournal(): MemoryJournal {
  const j = new MemoryJournal();
  j.append({ kind: "message.user", sessionId: "s1", payload: { text: "任务:调查 compact 前缀复用。" } });
  j.append({ kind: "message.user", sessionId: "s1", payload: { text: "素材".repeat(30_000) } });
  for (let i = 0; i < 10; i++) {
    j.append({ kind: "message.agent", sessionId: "s1", payload: { text: "步骤".repeat(1_000), usage: { inputTokens: 30_000 } } });
  }
  return j;
}

function recorder(): { llm: LlmProvider; calls: { messages: Message[]; tools: ToolSpec[] }[] } {
  const calls: { messages: Message[]; tools: ToolSpec[] }[] = [];
  const llm: LlmProvider = {
    async chat(messages: Message[], tools: ToolSpec[]) {
      calls.push({ messages: [...messages], tools: [...tools] });
      return { content: "摘要:压缩前缀接线验证" };
    },
  };
  return { llm, calls };
}

function hookOf(compactLlm: LlmProvider, extra: Record<string, unknown> = {}) {
  return makeCompactHook({
    explicitThreshold: 24_000,
    compactLlm,
    expLlm: { async chat() { return { content: "" }; } },
    devlogDir: tmp,
    taskId: "t1",
    fallbackInstruction: "",
    store: new ExperienceStore(join(tmp, `exp-${Math.random().toString(36).slice(2)}`)),
    repoRoot: tmp,
    ...extra,
  } as Parameters<typeof makeCompactHook>[0]);
}

function compactStartPayload(j: MemoryJournal): Record<string, unknown> {
  const e = j.readAll().find((x) => x.kind === "compact.start");
  expect(e, "compact.start 必须落账").toBeTruthy();
  return (e?.payload ?? {}) as Record<string, unknown>;
}

describe(" 装配面:源码级接线锚", () => {
  it("compact-hook 声明 prefix 并在 autoCompact 调用里透传", () => {
    expect(HOOK_SRC).toContain('prefix?: CompactOptions["prefix"]');
    expect(HOOK_SRC).toContain("...(o.prefix ? { prefix: o.prefix } : {})");
    expect(HOOK_SRC).toContain("type CompactOptions");
  });

  it("agent-wiring 在 makeCompactHook 处传 getter,引用主 loop 的 system 与工具面", () => {
    expect(WIRING_SRC).toContain("prefix: () => ({ system: systemWithMemory, tools: surfacePlan.tools })");
 // getter 必须是函数形态:装配 hook 时 system/tools 尚未定义,直接传值会拿到 undefined。
    expect(WIRING_SRC).toContain("prefix: () =>");
  });

  it("auto-compact 侧有审计字段与旧路径锚(无前缀=prefixReused:false)", () => {
    expect(AUTO_COMPACT_SRC).toContain("prefixReused: prefixSystem !== undefined");
    expect(AUTO_COMPACT_SRC).toContain('prefix: "unavailable"');
    expect(AUTO_COMPACT_SRC).toContain("prefixSystemChars");
    expect(AUTO_COMPACT_SRC).toContain("prefixTools");
  });
});

describe(" 装配面:行为三态", () => {
  it("注入 prefix getter → 摘要请求首条 system/工具数 = 注入值,compact.start.prefixReused=true", async () => {
    const j = bigJournal();
    const rec = recorder();
    const hook = hookOf(rec.llm, { prefix: () => ({ system: PREFIX_SYSTEM, tools: PREFIX_TOOLS }) });
    await hook(j, "s1");
    const call = rec.calls[0]!;
    expect(call, "摘要模型必须被调用").toBeTruthy();
    expect(call.messages[0]).toEqual({ role: "system", content: PREFIX_SYSTEM });
    expect(call.tools.map((t) => t.name)).toEqual(PREFIX_TOOLS.map((t) => t.name));
    expect(String(call.messages.at(-1)!.content)).toContain("CRITICAL: Respond with TEXT ONLY");
    const payload = compactStartPayload(j);
    expect(payload.prefixReused).toBe(true);
    expect(payload.prefixSystemChars).toBe(PREFIX_SYSTEM.length);
    expect(payload.prefixTools).toBe(PREFIX_TOOLS.length);
  });

  it("不注入 prefix → 旧路径(tools=0,prefixReused=false)", async () => {
    const j = bigJournal();
    const rec = recorder();
    await hookOf(rec.llm)(j, "s1");
    const call = rec.calls[0]!;
    expect(String(call.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
    expect(call.tools).toHaveLength(0);
    const payload = compactStartPayload(j);
    expect(payload.prefixReused).toBe(false);
    expect("prefix" in payload).toBe(false);
  });

  it("prefix getter 抛错(TDZ 形态)→ 压缩照常成功,compact.start.prefix=unavailable", async () => {
    const j = bigJournal();
    const rec = recorder();
    const hook = hookOf(rec.llm, {
      prefix: () => { throw new ReferenceError("Cannot access 'systemWithMemory' before initialization"); },
    });
    await hook(j, "s1");
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(true);
    const payload = compactStartPayload(j);
    expect(payload.prefixReused).toBe(false);
    expect(payload.prefix).toBe("unavailable");
 // 请求走旧实现
    expect(rec.calls[0]!.tools).toHaveLength(0);
    expect(String(rec.calls[0]!.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
  });

  it("prefix getter 惰性:装配 hook 不取值,压缩执行时才取值", async () => {
    let reads = 0;
    const rec = recorder();
    const hook = hookOf(rec.llm, { prefix: () => { reads += 1; return { system: PREFIX_SYSTEM, tools: PREFIX_TOOLS }; } });
    expect(reads).toBe(0);
    await hook(bigJournal(), "s1");
    expect(reads).toBe(1);
  });

  it("prefix getter 返回空 system → 旧路径(工具面也不复用)", async () => {
    const j = bigJournal();
    const rec = recorder();
    await hookOf(rec.llm, { prefix: () => ({ system: "", tools: PREFIX_TOOLS }) })(j, "s1");
    expect(String(rec.calls[0]!.messages[0]!.content).startsWith("CRITICAL")).toBe(true);
    expect(rec.calls[0]!.tools).toHaveLength(0);
    expect(compactStartPayload(j).prefixReused).toBe(false);
  });
});
