/**
 * result_read 取回旁路二次提炼。
 * 契约:result_read 是模型/用户**显式发起**的 dump 回读,其输出已被工具自身 maxChars/grep/limit 约束
 * (取回转义口必须原样)。故 loop 结果归一处对它跳过 big-intake(不产生 context.intake、不改写 content)
 * 与 spill(不落二次 dump、不加占位头);其它工具(对照组 terminal)同尺寸仍照旧进闸。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Message, type Tool } from "../src/agent/loop";
import { SPILL_MARKER_PREFIX } from "../src/agent/tool-result-spill";

const TMP: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-bypass-"));
  TMP.push(d);
  return d;
}
afterEach(() => {
  for (const d of TMP.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } }
});

/** 造带行号的 ~30k 字符文本(每行 ~70 字符),用于证明行号与原文逐字保留。 */
function numberedFixture(lines = 500): string {
  return Array.from({ length: lines }, (_, i) => {
    const n = i + 1;
    return `${n}|${String(n).padStart(4, "0")} payload-${n} lorem-ipsum-dolor-sit-amet-consectetur-adipiscing-elit`;
  }).join("\n");
}

interface ScriptStep { content?: string; toolCalls?: { id: string; name: string; arguments: string }[] }

function scriptedLlm(script: ScriptStep[]): LlmProvider & { requests: Message[][] } {
  const requests: Message[][] = [];
  let round = 0;
  return {
    requests,
    async chat(messages: Message[]) {
      requests.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      const step = script[Math.min(round, script.length - 1)]!;
      round += 1;
      return step as { content: string };
    },
  };
}

const toolOf = (name: string, run: () => string): Tool => ({
  name, description: "", parameters: {},
  async execute() { return run(); },
});

const toolResults = (journal: MemoryJournal): string[] =>
  journal.readAll()
    .filter((e) => e.kind === "tool.result")
    .map((e) => String((e.payload as { content: string }).content));

const intakes = (journal: MemoryJournal): Record<string, unknown>[] =>
  journal.readAll()
    .filter((e) => e.kind === "context.intake")
    .map((e) => e.payload as Record<string, unknown>);

/** 配 big-intake + spill 两闸的 loop(缺省预算 1.5k tok,30k 字符必过闸)。 */
function loopWithGates(opts: { journal: MemoryJournal; sid: string; llm: LlmProvider; dumpDir: string; spillDir: string; tools: Tool[] }) {
  return new AgentLoop({
    journal: opts.journal,
    sessionId: opts.sid,
    system: "sys",
    llm: opts.llm,
    tools: opts.tools,
    microcompact: { thresholdTokens: 1_000_000 },
    bigIntake: { enabled: true, dumpDir: opts.dumpDir },
    spill: { dir: opts.spillDir },
  });
}

describe("result_read 旁路二次提炼", () => {
  it("result_read 30k 带行号文本 → 历史/ journal 逐字保留,无精炼前缀、无 context.intake、不落 spill", async () => {
    const big = numberedFixture();
    expect(big.length).toBeGreaterThan(30_000);
    const journal = new MemoryJournal();
    const sid = "rr-big";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "把上次落盘的 dump 取回来核对 file:line" } });
    const dumpDir = tmpDir();
    const spillDir = tmpDir();
    const llm = scriptedLlm([
      { content: "", toolCalls: [{ id: "call_rr_big", name: "result_read", arguments: JSON.stringify({ ref: "call_prev" }) }] },
      { content: "核对完毕" },
    ]);
    const loop = loopWithGates({ journal, sid, llm, dumpDir, spillDir, tools: [toolOf("result_read", () => big)] });
    await loop.runTurn("go");

    // ① journal 的 tool.result 逐字等于工具返回(行号与原文都在)
    const results = toolResults(journal);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(big);
    expect(results[0]!.startsWith(SPILL_MARKER_PREFIX)).toBe(false);
    expect(results[0]).not.toContain(SPILL_MARKER_PREFIX);
    expect(results[0]).toContain("470|0470 payload-470"); // 行号锚点仍在(区间中点)
    // ② 模型历史里逐字保留(第二轮请求消息里能看到原文,而不是「第 1/50 段」)
    const second = llm.requests[1] ?? [];
    const texts = JSON.stringify(second);
    expect(texts).toContain("payload-500 lorem-ipsum-dolor-sit-amet");
    expect(texts).not.toContain("[工具结果已精炼:");
    // ③ 没有 context.intake(不论工具名),也没落 spill 文件
    expect(intakes(journal).length).toBe(0);
    expect(existsSync(spillDir) ? readdirSync(spillDir).length : 0).toBe(0);
  });

  it("对照:terminal 同尺寸结果仍进闸(证明不是整体关闸)", async () => {
    const big = numberedFixture();
    const journal = new MemoryJournal();
    const sid = "rr-control";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "跑个长日志命令" } });
    const dumpDir = tmpDir();
    const spillDir = tmpDir();
    const llm = scriptedLlm([
      { content: "", toolCalls: [{ id: "call_term_big", name: "terminal", arguments: "{}" }] },
      { content: "done" },
    ]);
    const loop = loopWithGates({ journal, sid, llm, dumpDir, spillDir, tools: [toolOf("terminal", () => big)] });
    await loop.runTurn("go");

    const results = toolResults(journal);
    expect(results.length).toBe(1);
    expect(results[0]).not.toBe(big); // 被提炼
    expect(results[0]!.startsWith("[工具结果已精炼:")).toBe(true);
    const got = intakes(journal);
    expect(got.length).toBe(1);
    expect(got[0]!.tool).toBe("terminal");
  });

  it("result_read 小文本 → 原样零变化(不进闸也没被 spill)", async () => {
    const small = "3|小结果\n4|第二行\n5|第三行";
    const journal = new MemoryJournal();
    const sid = "rr-small";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "取一小段" } });
    const dumpDir = tmpDir();
    const spillDir = tmpDir();
    const llm = scriptedLlm([
      { content: "", toolCalls: [{ id: "call_rr_small", name: "result_read", arguments: "{}" }] },
      { content: "ok" },
    ]);
    const loop = loopWithGates({ journal, sid, llm, dumpDir, spillDir, tools: [toolOf("result_read", () => small)] });
    await loop.runTurn("go");

    const results = toolResults(journal);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(small);
    expect(intakes(journal).length).toBe(0);
    expect(existsSync(spillDir) ? readdirSync(spillDir).length : 0).toBe(0);
  });
});
