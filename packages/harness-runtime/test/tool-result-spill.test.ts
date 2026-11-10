/**
 * 写时定形 spill(2026-11 token 优化轮 02,对齐 dsh spill-policy):
 * 契约:超阈(8192)工具结果**进历史之前**换成「头 4096 + 单行标记 + 尾 1024 + 落盘路径 + 回读指引」,
 * 之后永不改写;认知类/回执类/read_file 排除(防 read→spill 循环);落盘失败 fail-open 返回原文。
 * 守护重点(negative):已定形文本再过一遍 microcompact 必须**逐字节不变**(前缀缓存是省钱的根)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import {
  SPILL_THRESHOLD_CHARS, SPILL_HEAD_CHARS, SPILL_TAIL_CHARS,
  SPILL_EXCLUDED_TOOLS, TOOL_SPILL_THRESHOLDS, shouldSpill, buildSpillPreview, spillToolResult, safeSegment,
} from "../src/agent/tool-result-spill";
import { microcompactMessages } from "../src/agent/microcompact";
import { AgentLoop, VISION_TOOL_SENTINEL, type LlmProvider, type LlmResponse, type Message, type Tool } from "../src/agent/loop";

const tmp = (): string => mkdtempSync(join(tmpdir(), "genie-spill-"));
const big = (n: number, tag = "x"): string => tag.repeat(n);

describe("常量与判定", () => {
  it("阈值常量与排除名单符合契约(认知类/回执类排除;read_file 改走独立高阈)", () => {
    expect(SPILL_THRESHOLD_CHARS).toBe(8192);
    expect(SPILL_HEAD_CHARS).toBe(4096);
    expect(SPILL_TAIL_CHARS).toBe(1024);
    for (const name of ["tool_view", "code_sense", "code_index", "board_read", "board_upsert", "edit_file", "write_file", "todo_write", "task_phase"]) {
      expect(SPILL_EXCLUDED_TOOLS.has(name)).toBe(true);
    }
 // read_file 移出排除名单( token 轮 04):改用独立高阈值 32000,
 // 否则单次整读大文件(经验证峰值 71,967 字符)全量进历史,每步重付。
    expect(SPILL_EXCLUDED_TOOLS.has("read_file")).toBe(false);
    expect(TOOL_SPILL_THRESHOLDS["read_file"]).toBe(32_000);
  });
});

describe("spillToolResult 写时定形", () => {
  it("小于阈值的 terminal 结果原样返回(逐字相等),且不落盘", async () => {
    const dir = tmp();
    const content = "小结果:" + big(1000);
    const out = await spillToolResult({ dir, sessionId: "s1", callId: "c1", toolName: "terminal", content });
    expect(out).toBe(content); // 逐字
    expect(existsSync(join(dir, safeSegment("s1")))).toBe(false); // 没触发就不写盘
  });

  it("超阈值的 terminal 结果:返回预览 < 8192,含落盘绝对路径与 read_file 回读指引", async () => {
    const dir = tmp();
    const content = "头" + big(20_000, "a") + "尾";
    const out = await spillToolResult({ dir, sessionId: "s1", callId: "c9", toolName: "terminal", content });
    expect(out.length).toBeLessThan(SPILL_THRESHOLD_CHARS);
    expect(out.length).toBeLessThan(content.length);
    expect(out).toContain(join(dir, safeSegment("s1"))); // 落盘路径(临时根=绝对路径)
    expect(out).toContain("c9-terminal.txt");
    expect(out).toContain("read_file"); // 回读指引
    expect(out).toContain("grep");
    expect(out).toContain(`原共 ${content.length} 字符`);
    // 头尾内容仍在(可读性:模型看得见开头与结尾)
    expect(out.startsWith("头" + "a".repeat(100))).toBe(true);
    expect(out.endsWith("尾")).toBe(true);
  });

  it("落盘文件内容 === 原全文(不丢字节)", async () => {
    const dir = tmp();
    const content = "START" + big(30_000, "b") + "END";
    const out = await spillToolResult({ dir, sessionId: "s/1: weird", callId: "call-1", toolName: "run_cmd", content });
    expect(out.length).toBeLessThan(SPILL_THRESHOLD_CHARS);
    const file = join(dir, safeSegment("s/1: weird"), `${safeSegment("call-1")}-${safeSegment("run_cmd")}.txt`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(content); // 逐字节相等
  });

  it("read-file-high-threshold: 32000 是双向边界(32,000 不 spill / 32,001 spill),且与全局 8192 相互独立", async () => {
    // 精确边界(两个方向都测,防「阈值写错一位」这类静默偏移)
    expect(shouldSpill("read_file", big(32_000))).toBe(false);
    expect(shouldSpill("read_file", big(32_001))).toBe(true);
    // 全局阈值不受影响:其它工具 8,193 就该 spill
    expect(shouldSpill("terminal", big(8_192))).toBe(false);
    expect(shouldSpill("terminal", big(8_193))).toBe(true);
  });

  it("read-file-small-untouched: 低于 32K 的 read_file 结果原文逐字节不变(无标记/无截断)", async () => {
    const dir = tmp();
    const small = big(20_000);
    const out = await spillToolResult({ dir, sessionId: "s3", callId: "c3", toolName: "read_file", content: small });
    expect(out).toBe(small);
    expect(out).not.toContain("[工具结果已精炼:");
    expect(existsSync(join(dir, safeSegment("s3")))).toBe(false); // 没触发就不写盘
  });

  it("read-file-hint: 占位提示指回**原文件**(不是 spill 副本),否则会形成 read-spill 循环", async () => {
    const dir = tmp();
    const large = big(40_000);
    const out = await spillToolResult({ dir, sessionId: "s4", callId: "c4", toolName: "read_file", content: large });
    expect(out.length).toBeLessThan(large.length);
    // 旧口径靠「把 read_file 排除在 spill 之外」防循环;新口径靠这句提示把模型指回原文件。
    expect(out).toContain("原文件");
    expect(out).toContain("offset/limit");
    // 对照:其它工具的提示不该出现「原文件」(避免提示语串味)
    const termOut = await spillToolResult({ dir, sessionId: "s4", callId: "c5", toolName: "terminal", content: large });
    expect(termOut).not.toContain("原文件");
  });

  it("read_file 走独立高阈值 32000:低于阈值原样、超过才 spill,且提示回读**原文件**", async () => {
    const dir = tmp();
    const small = big(20_000);
 // 20K < 32000:不 spill(绝大多数常规读都在这一档——经验证 p90=6,450)
    expect(shouldSpill("read_file", small)).toBe(false);
    const outSmall = await spillToolResult({ dir, sessionId: "s2", callId: "c2s", toolName: "read_file", content: small });
    expect(outSmall).toBe(small); // 逐字节原样
    // 40K > 32000:spill
    const large = big(40_000);
    expect(shouldSpill("read_file", large)).toBe(true);
    const out = await spillToolResult({ dir, sessionId: "s2", callId: "c2", toolName: "read_file", content: large });
    expect(out.length).toBeLessThan(large.length);
    // 提示语必须指回**原文件**,否则模型会去读 spill 副本 → read-spill 循环(旧口径排除它的理由)
    expect(out).toContain("原文件");
    expect(out).toContain("offset/limit");
    // 认知工具仍排除
    expect(shouldSpill("code_sense", large)).toBe(false);
    expect(shouldSpill("board_read", large)).toBe(false);
    // 非排除工具按全局 8192:20K 就该 spill(证明 read_file 的高阈是**独立**的,不是把全局抬高)
    expect(shouldSpill("terminal", small)).toBe(true);
  });

  it("落盘失败 fail-open:dir 是不可写/非法路径 → 返回原文而不抛、不丢结果", async () => {
    const root = tmp();
    // dir 指向一个**已存在的普通文件** → mkdir/write 必然失败(ENOTDIR)
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "occupied", "utf8");
    const content = "应原样返回:" + big(20_000);
    const out = await spillToolResult({ dir: filePath, sessionId: "s1", callId: "c3", toolName: "terminal", content });
    expect(out).toBe(content); // fail-open:原文逐字返回
  });

  it("预览总长恒 < 8192(即使调用方把 head/tail 配得很大)", () => {
    const content = big(40_000);
    const out = buildSpillPreview(content, { path: "/tmp/a/b.txt", headChars: 20_000, tailChars: 10_000 });
    expect(out.length).toBeLessThan(8192);
  });
});

describe("不二次改写守护(negative)", () => {
  it("已 spill 的预览再过 microcompactMessages(thresholdTokens:1,keepRecent:1)逐字节不变", () => {
    const dir = tmp();
    const dirPath = join(dir, safeSegment("s1"), "c1-terminal.txt");
    const spilled = buildSpillPreview("A".repeat(20_000), { path: dirPath });
    expect(spilled.length).toBeLessThan(8192);
    // 构造是刻意的:c1=已定形(spill 预览),c2/c3=未定形的普通结果(对照组)。keepRecent=1 时
    // 「更早的组」必被读侧清掉——若读侧不认 spill 标记,c1 也会被清成占位(断言即失败)。
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "terminal", arguments: JSON.stringify({ command: "npm test" }) }] },
      { role: "tool", toolCallId: "c1", content: spilled },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "terminal", arguments: JSON.stringify({ command: "npm run build" }) }] },
      { role: "tool", toolCallId: "c2", content: "build ok:" + "B".repeat(4_000) },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "terminal", arguments: JSON.stringify({ command: "npm run lint" }) }] },
      { role: "tool", toolCallId: "c3", content: "lint ok:" + "C".repeat(4_000) },
    ];
    const res = microcompactMessages(messages, { thresholdTokens: 1, keepRecent: 1 });
    const after = res.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(after).toBeDefined();
    // 逐字节相等(不是长度相等,不是模糊匹配)
    expect((after as { content: string }).content).toBe(spilled);
    // 也不允许留 head_tail/cleared 记录(留了就说明读侧动过它)
    expect(res.pruned.some((p) => p.toolCallId === "c1")).toBe(false);
    // 对照组:c2 确实被读侧清掉了(证明压缩器真的跑起来了,上面的「不变」不是空转)
    expect(res.pruned.some((p) => p.toolCallId === "c2")).toBe(true);
    expect((res.messages.find((m) => m.role === "tool" && m.toolCallId === "c2") as { content: string }).content)
      .not.toContain("build ok");
  });

  it("spill 标记还挡住路径①的二次 head/tail(把该工具 cap 压到 2k 也不动它)", () => {
    const spilled = buildSpillPreview("A".repeat(20_000), { path: "/tmp/a/c1-terminal.txt" });
    expect(spilled.length).toBeGreaterThan(2_000); // 预览比压小后的 cap 大 → 不挡就会被再剪一次
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "terminal", arguments: JSON.stringify({ command: "npm test" }) }] },
      { role: "tool", toolCallId: "c1", content: spilled },
    ];
    const res = microcompactMessages(messages, { toolCaps: { terminal: 2_000 } });
    const after = res.messages.find((m) => m.role === "tool") as { content: string };
    expect(after.content).toBe(spilled); // 逐字节不变
    expect(res.pruned.some((p) => p.toolCallId === "c1")).toBe(false);
  });
});

describe("loop 接入(execOne 写时定形)", () => {
  const mkTool = (name: string, output: () => string): Tool => ({
    name, description: "d", parameters: { type: "object", properties: {} },
    isConcurrencySafe: () => true,
    async execute() { return output(); },
  });

  it("配了 spill:>20k 的工具结果落 journal 前已定形(< 8192 且含 .genie/spill 路径)", async () => {
    const root = tmp();
    const spillDir = join(root, ".genie", "spill");
    const journal = new MemoryJournal();
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "big1", name: "terminal", arguments: '{"command":"npm test"}' }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "spill-loop", system: "s", llm,
      tools: [mkTool("terminal", () => "OUT:" + big(25_000))],
      spill: { dir: spillDir },
    });
    expect(await loop.runTurn("go")).toBe("done");
    const result = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string };
    expect(result.content.length).toBeLessThan(8192);
    expect(result.content).toContain(".genie/spill");
    // 落盘文件在(sessionId 子目录下)
    expect(existsSync(join(spillDir, safeSegment("spill-loop"), "big1-terminal.txt"))).toBe(true);
  });

  it("未配 spill:同一结果全量入 journal(既有行为逐字不变)", async () => {
    const journal = new MemoryJournal();
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "big1", name: "terminal", arguments: '{"command":"npm test"}' }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "no-spill", system: "s", llm,
      tools: [mkTool("terminal", () => "OUT:" + big(25_000))],
    });
    await loop.runTurn("go");
    const result = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string };
    expect(result.content.length).toBe(25_000 + 4); // 全文
  });

  it("视觉哨兵内容不参与 spill(配了 spill 也照常剥 dataUrl 进 images)", async () => {
    const dir = tmp();
    const dataUrl = "data:image/png;base64," + "Q".repeat(20_000); // 体量超阈值
    const journal = new MemoryJournal();
    let n = 0;
    const llm: LlmProvider = {
      async chat(): Promise<LlmResponse> {
        n++;
        if (n === 1) return { content: "", toolCalls: [{ id: "v1", name: "view_image", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const loop = new AgentLoop({
      journal, sessionId: "vision-spill", system: "s", llm,
      tools: [{
        name: "view_image", description: "d", parameters: { type: "object", properties: {} },
        async execute() { return VISION_TOOL_SENTINEL + JSON.stringify({ dataUrl, label: "big.png" }); },
      }],
      spill: { dir },
    });
    await loop.runTurn("看图");
    const p = journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string; images?: string[] };
    expect(p.images).toEqual([dataUrl]); // 图没被 spilled 掉
    expect(p.content).toContain("图片已注入视觉通道");
    expect(p.content.length).toBeLessThan(8192);
    expect(existsSync(join(dir, safeSegment("vision-spill")))).toBe(false); // 没落盘
  });
});
