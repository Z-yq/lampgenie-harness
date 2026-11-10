import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryJournal } from "@lampgenie/core";
import {
  bigResultEnabledFromEnv,
  shouldIntake,
  intakeLevel,
  splitChunks,
  selectChunks,
  deterministicSelection,
  renderChunks,
  chunkLabel,
  assembleIntake,
  intakeToolResult,
  readToolDump,
  dumpPathOf,
  detectDiffText,
  compressDiffForDigest,
  diffStats,
  diffStatsBlock,
  diffPrompt,
  BIG_RESULT_MIN_TOKENS,
  type BigIntakeConfig,
} from "../src/agent/big-intake";
import { estimateTokensOfText } from "../src/agent/microcompact";
import { AgentLoop, type LlmProvider, type Message, type Tool } from "../src/agent/loop";

const TMP: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "big-intake-"));
  TMP.push(d);
  return d;
}
afterEach(() => {
  for (const d of TMP.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } }
});

/** 造 n 行文本,每行 ~40 字符(≈10 tok),行内容带行号便于对齐断言。 */
function linesFixture(n: number, makeLine = (i: number) => `第${i}行 content-payload-${i} lorem ipsum dolor`): string {
  return Array.from({ length: n }, (_, i) => makeLine(i + 1)).join("\n");
}

function cfg(over: Partial<BigIntakeConfig> = {}): BigIntakeConfig {
  return { enabled: true, ...over };
}

describe("大结果闸门:单价闸(两个条件同时成立才触发)", () => {
  it("单价闸:小结果直通(est < 4000 tok 无论预算多小都不触发)", () => {
    const small = "x".repeat(4_000); // 1000 tok
    expect(estimateTokensOfText(small)).toBeLessThan(BIG_RESULT_MIN_TOKENS);
    expect(shouldIntake(small, 0, cfg())).toBe(false);
    expect(shouldIntake(small, 1, cfg())).toBe(false);
  });

  it("单价闸:est > 预算但 < 4000 tok 也不触发(绝对下限保护)", () => {
    // token 口径改为 cl100k 真分词,值随之更新:重复 "x" 在 BPE 下约 8 字符 1 token(旧系数 4 字符 1 token)。
    const mid = "x".repeat(24_000); // 3000 tok
    expect(estimateTokensOfText(mid)).toBe(3_000);
    expect(shouldIntake(mid, 100, cfg())).toBe(false);
  });

  it("单价闸边界:3999 不触发 / 4000 且超预算触发 / 4001 触发", () => {
    // token 口径改为 cl100k 真分词,值随之更新:长度按真分词器实测取(编码按 4000 字符分块,
    // 边界附近非严格线性,故不能用 chars/4 换算)。
    const e3999 = "x".repeat(31_992); // 3999 tok
    const e4000 = "x".repeat(31_996); // 4000 tok
    const e4001 = "x".repeat(32_004); // 4001 tok
    expect(estimateTokensOfText(e3999)).toBe(3_999);
    expect(shouldIntake(e3999, 100, cfg())).toBe(false);
    expect(estimateTokensOfText(e4000)).toBe(4_000);
    expect(shouldIntake(e4000, 100, cfg())).toBe(true);
    expect(shouldIntake(e4001, 100, cfg())).toBe(true);
    // 严格大于预算:est 恰好等于预算不算「超」
    expect(shouldIntake(e4000, 4_000, cfg())).toBe(false);
  });

  it("单价闸:enabled:false 一律直通(等同于没装闸)", () => {
    const big = "x".repeat(200_000);
    expect(shouldIntake(big, 100, cfg({ enabled: false }))).toBe(false);
  });

  it("off 直通:GENIE_BIG_RESULT=off 折算成 enabled:false;缺省/on 为开", () => {
    expect(bigResultEnabledFromEnv({ GENIE_BIG_RESULT: "off" })).toBe(false);
    expect(bigResultEnabledFromEnv({ GENIE_BIG_RESULT: "0" })).toBe(false);
    expect(bigResultEnabledFromEnv({ GENIE_BIG_RESULT: "false" })).toBe(false);
    expect(bigResultEnabledFromEnv({})).toBe(true);
    expect(bigResultEnabledFromEnv({ GENIE_BIG_RESULT: "on" })).toBe(true);
  });
});

describe("大结果闸门:量级分流", () => {
  it("量级分流:≤ 摘要线走选块,> 摘要线走选块+摘要", () => {
    expect(intakeLevel(5_000, cfg())).toBe("chunk-select");
    expect(intakeLevel(12_000, cfg())).toBe("chunk-select");
    expect(intakeLevel(12_001, cfg())).toBe("digest");
    expect(intakeLevel(50_000, cfg())).toBe("digest");
    expect(intakeLevel(50_000, cfg({ digestLineTokens: 100_000 }))).toBe("chunk-select");
  });
});

describe("大结果闸门:chunk 切分(行号保真)", () => {
  it("chunk 选块:块边界永不切断行,startLine/endLine 是原文 1-based 行号且首尾相接", () => {
    const text = linesFixture(300);
    const chunks = splitChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(300);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBe(chunks[i - 1]!.endLine + 1);
    }
    // 逐块文本 == 原文对应行区间(拼接后逐字节等于原文)
    const rebuilt = chunks.map((c) => c.text).join("\n");
    expect(rebuilt).toBe(text);
  });

  it("chunk 选块:块目标按 tokens 控制;单行超长时行内分段(part/partCount/char 区间)且可逐字节拼回", () => {
    const line = "y".repeat(20_000);
    const text = `短行\n${line}\n短行2`;
    const chunks = splitChunks(text, 100);
    const huge = chunks.filter((c) => c.startLine === 2);
    expect(huge.length).toBeGreaterThan(1); // 不再「独占一块不拆行」
    expect(huge[0]!.part).toBe(1);
    expect(huge[0]!.partCount).toBe(huge.length);
    expect(huge.every((c) => c.endLine === 2)).toBe(true);
    // 按原文 charStart/charEnd 拼接逐字节等于该行
    expect(huge.map((c) => text.slice(c.charStart, c.charEnd)).join("")).toBe(line);
    expect(huge.every((c) => c.tokens <= 200)).toBe(true);
    // 普通多行行为不变:整行块 tokens 仍受控
    expect(splitChunks(linesFixture(60), 300).every((c) => c.tokens <= 300 || c.part !== undefined)).toBe(true);
  });

  it("chunk 选块:空内容/单行内容不崩", () => {
    expect(splitChunks("")).toHaveLength(1);
    expect(splitChunks("单行")[0]!.startLine).toBe(1);
  });
});

describe("大结果闸门:选块(8105 / 兜底 / 预算裁剪)", () => {
  /** 造一个有明确「高相关块」的脚手架:goal 词只在第 5 块出现。 */
  function rankedFixture(): { text: string; goal: string } {
    const marker = "只在这一块出现的唯一关键词ZEBRA";
    const text = Array.from({ length: 400 }, (_, i) => (i >= 190 && i < 200 ? `${i + 1} ${marker}` : `${i + 1} filler line body`)).join("\n");
    return { text, goal: `查 ZEBRA 在哪` };
  }

  it("chunk 选块:头尾保底(无论预算多紧,首块与末块都在 kept 里)", async () => {
    const { text, goal } = rankedFixture();
    const chunks = splitChunks(text, 200);
    const r = await selectChunks({ chunks, goal, budgetTokens: 300, config: cfg() });
    expect(r.kept).toContain(0);
    expect(r.kept).toContain(chunks.length - 1);
    expect(r.keptChars).toBeLessThanOrEqual(Math.max(2_000, 300 * 4) + chunks[0]!.text.length);
  });

  it("8105 不可用(未配 scorer)→ 确定性兜底:goal 词命中块入选,scorer 标记为 deterministic", async () => {
    const { text, goal } = rankedFixture();
    const chunks = splitChunks(text, 200);
    const r = await selectChunks({ chunks, goal, budgetTokens: 5_000, config: cfg() });
    expect(r.scorer).toBe("deterministic");
    const hit = chunks.find((c) => c.text.includes("ZEBRA"))!;
    expect(r.kept).toContain(hit.index);
  });

  it("8105 选块 + 复用 scorer:高相关块入选,scorer 带 providerUrl(注入 mock fetch)", async () => {
    const { text, goal } = rankedFixture();
    const chunks = splitChunks(text, 200);
    const target = chunks.find((c) => c.text.includes("ZEBRA"))!;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions?: Record<string, unknown> };
      const ids = Object.keys(body.questions ?? {}).filter((k) => k.startsWith("call_")).map((k) => k.slice(5));
      const answers: Record<string, unknown> = {};
      for (const id of ids) {
        const keep = Number(id.replace("chunk", "")) === target.index;
        answers[`call_${id}`] = { label: "true", confidence: 0.95 };
        answers[`result_${id}`] = { label: keep ? "true" : "false", confidence: 0.95 };
      }
      return new Response(JSON.stringify(answers), { status: 200 });
    }) as typeof fetch;
    const r = await selectChunks({
      chunks, goal, budgetTokens: 5_000,
      config: cfg({ scorer: { mode: "active", providerUrl: "http://127.0.0.1:8105", fetchImpl, minCandidates: 0, minTotalChars: 0 } }),
    });
    expect(r.scorer).toContain("8105");
    expect(r.kept).toContain(target.index);
    expect(r.kept).toContain(0);
    expect(r.kept).toContain(chunks.length - 1);
  });

  it("8105 超时/报错 → 走确定性兜底且不抛错(绝不阻塞工具返回)", async () => {
    const { text, goal } = rankedFixture();
    const chunks = splitChunks(text, 200);
    const fetchImpl = (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8105"); }) as unknown as typeof fetch;
    const r = await selectChunks({
      chunks, goal, budgetTokens: 5_000,
      config: cfg({ scorer: { mode: "active", providerUrl: "http://127.0.0.1:8105", fetchImpl, minCandidates: 0, minTotalChars: 0 } }),
    });
    expect(r.scorer).toBe("deterministic");
    expect(r.error).toBeTruthy();
    expect(r.kept.length).toBeGreaterThan(0);
  });

  it("相关但放不下 → 进 dropped,不静默消失", async () => {
    const { text, goal } = rankedFixture();
    const chunks = splitChunks(text, 200);
    const r = await selectChunks({ chunks, goal, budgetTokens: 300, config: cfg() });
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.droppedChars).toBeGreaterThan(0);
    const all = new Set([...r.kept, ...r.dropped]);
    expect(all.size).toBe(chunks.length); // 每块必有归属
  });

  it("确定性兜底:选择顺序:首块 → 末块 → grep 命中行块 → 日志错误块", () => {
    const text = [linesFixture(40), "src/a.ts:42:hit", linesFixture(40), "ERROR something failed", linesFixture(20)].join("\n");
    const chunks = splitChunks(text, 100);
    const order = deterministicSelection(chunks, "");
    expect(order[0]).toBe(0);
    expect(order[1]).toBe(chunks.length - 1);
    const hitIdx = chunks.findIndex((c) => c.text.includes("src/a.ts:42:hit"));
    expect(order).toContain(hitIdx);
  });

  it("renderChunks 逐块带原文行号", () => {
    const chunks = splitChunks(linesFixture(20), 100);
    const out = renderChunks(chunks, [0, 1]);
    expect(out).toContain(`【行 ${chunks[0]!.startLine}-${chunks[0]!.endLine}】`);
    expect(out).toContain(`【行 ${chunks[1]!.startLine}-${chunks[1]!.endLine}】`);
  });
});

describe("大结果闸门:摘要(四段 / 无小模型不硬造)", () => {
  it("四段摘要:digest 轨被调用时正文替换为摘要,policy=digest", async () => {
    const dir = tmpDir();
    const content = linesFixture(2_000); // ≈ 20k tok > 摘要线
    let prompt = "";
    const out = await intakeToolResult({
      content, callId: "call_00_digest", toolName: "terminal", goal: "找异常", budgetTokens: 1_500,
      config: cfg({
        dumpDir: dir,
        digest: async (p) => { prompt = p; return "## 关键结论\n- 有异常\n## 精确锚点\n- src/a.ts:42\n## 异常与风险\n- 无\n## 下一步建议\n- 看 42 行"; },
      }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("digest");
    expect(out!.content).toContain("## 关键结论");
    expect(out!.content).toContain("## 精确锚点");
    expect(out!.content).toContain("## 异常与风险");
    expect(out!.content).toContain("## 下一步建议");
    expect(out!.content).toContain("src/a.ts:42"); // 锚点原样透传
    expect(prompt).toContain("任务目标:找异常");
    expect(out!.meta.digestChars).toBeGreaterThan(0);
  });

  it("无小模型:policy 不是 digest,正文只有选块(不硬造摘要段)", async () => {
    const dir = tmpDir();
    const content = linesFixture(2_000);
    const out = await intakeToolResult({
      content, callId: "call_00_nodigest", toolName: "terminal", goal: "找异常", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("chunk-select");
    expect(out!.content).not.toContain("## 精确锚点");
    expect(out!.meta.digestChars).toBe(0);
  });

  it("小模型抛错 → 保留选块拼装,不抛给调用方", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: linesFixture(2_000), callId: "call_00_diefail", toolName: "terminal", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async () => { throw new Error("小模型 500"); } }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("chunk-select");
    expect(out!.content).toContain("全文已落盘:");
  });
});

describe("大结果闸门:落盘 + 拼装 + 回读", () => {
  it("落盘回读:dump 逐字节等于原文,tool.result 含「全文已落盘:<path>(N 行/M tok)」与筛掉清单", async () => {
    const dir = tmpDir();
    const content = linesFixture(1_500);
    const out = await intakeToolResult({
      content, callId: "call_00_dump", toolName: "grep", goal: "查关键行", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    const dumpPath = out!.meta.dumpPath!;
    expect(existsSync(dumpPath)).toBe(true);
    expect(readFileSync(dumpPath, "utf8")).toBe(content); // 行号对齐原文 = 逐字节相等
    expect(out!.content).toContain(`全文已落盘:${dumpPath}`);
    expect(out!.content).toContain("1,500 行".replace(",", "") || "1500 行");
    expect(out!.content).toContain("用 result_read 取回");
    expect(out!.content).toContain("筛掉清单:");
    expect(out!.meta.chars).toBe(content.length);
  });

  it("拼装总长必须 < 8000 字符(否则读侧 microcompact 会当超大结果再剪一次)", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: linesFixture(5_000), callId: "call_00_len", toolName: "terminal", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    expect(out!.content.length).toBeLessThan(8_000);
    expect(out!.content.includes("[工具结果已精炼:")).toBe(true); // 与读侧占位判定同字面
  });

  it("dump 写失败 → 摘要照给 + 标注「全文未能落盘,请重跑缩小范围」,不抛错", async () => {
    const badRoot = join(tmpDir(), "not-a-dir");
    writeFileSync(badRoot, "i am a file, not a dir"); // mkdir 必然失败
    const out = await intakeToolResult({
      content: linesFixture(1_500), callId: "call_00_bad", toolName: "terminal", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: join(badRoot, "sub") }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.dumpPath).toBeUndefined();
    expect(out!.meta.dumpError).toBeTruthy();
    expect(out!.content).toContain("全文未能落盘,请重跑缩小范围");
    expect(out!.content.length).toBeGreaterThan(0); // 结果没被吞
  });

  it("未触发(小结果)时返回 undefined,调用方保持原文", async () => {
    const out = await intakeToolResult({
      content: "小结果", callId: "c", toolName: "terminal", goal: "g", budgetTokens: 1_500, config: cfg({ dumpDir: tmpDir() }),
    });
    expect(out).toBeUndefined();
  });

  it("result_read:offset/limit 行段 + grep 关键词,行号沿用原文", async () => {
    const dir = tmpDir();
    // 2000 行(~10k tok)才越过 4000 tok 的绝对下限;目标行放中段。
    const content = linesFixture(2_000, (i) => (i === 1_000 ? "1000 命中目标ZEBRA 行" : `第${i}行 body filler text`));
    const path = dumpPathOf(dir, "call_00_read", "grep");
    const out = await intakeToolResult({
      content, callId: "call_00_read", toolName: "grep", goal: "ZEBRA", budgetTokens: 1_500, config: cfg({ dumpDir: dir }),
    });
    expect(out!.meta.dumpPath).toBe(path);
    const seg = readToolDump({ ref: "call_00_read", offset: 999, limit: 3 }, { dumpDir: dir });
    expect(seg.ok).toBe(true);
    if (seg.ok) {
      expect(seg.text).toContain("999|第999行 body filler text");
      expect(seg.text).toContain("1000|1000 命中目标ZEBRA 行");
      expect(seg.text).toContain("1001|第1001行 body filler text");
    }
    const hit = readToolDump({ ref: "call_00_read", grep: "ZEBRA" }, { dumpDir: dir });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.text).toContain("1000|1000 命中目标ZEBRA 行");
    // ref 给绝对路径也可
    const byPath = readToolDump({ ref: path, limit: 2 }, {});
    expect(byPath.ok).toBe(true);
  });

  it("result_read 错态:ref 为空 / dump 不存在都返回 ok:false 而不抛", () => {
    expect(readToolDump({ ref: "" }, {}).ok).toBe(false);
    expect(readToolDump({ ref: "call_not_exist" }, { dumpDir: tmpDir() }).ok).toBe(false);
  });
});

describe("大结果闸门:loop 级接线(落 journal 的是摘要版,growth 落在预算内)", () => {
  it("大 grep 夹具 → tool.result 是摘要版 + 含 dump 指针;context.intake 字段齐;result_read 取回原文", async () => {
    const dir = tmpDir();
    const journal = new MemoryJournal();
    const sid = "s-intake";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "查一下这些行里的关键命中" } });
    const big = linesFixture(6_000, (i) => (i === 3_000 ? "3000 关键命中ZEBRA" : `第${i}行 filler`));
    let call = 0;
    const llm: LlmProvider = {
      async chat() {
        call += 1;
        if (call === 1) {
          return { content: "", toolCalls: [{ id: "call_00_big", name: "grep", arguments: JSON.stringify({ pattern: "ZEBRA" }) }] };
        }
        return { content: "done" };
      },
    };
    const tool: Tool = {
      name: "grep", description: "", parameters: {},
      async execute() { return big; },
    };
    const loop = new AgentLoop({
      journal, sessionId: sid, system: "sys", llm, tools: [tool],
      microcompact: { thresholdTokens: 1_000_000 },
      bigIntake: cfg({ dumpDir: dir }),
    });
    await loop.runTurn("go");
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(results.length).toBe(1);
    const content = String((results[0]!.payload as { content: string }).content);
    expect(content).toContain("[工具结果已精炼:");
    expect(content).toContain("全文已落盘:");
    expect(content).toContain("用 result_read 取回");
    expect(content.length).toBeLessThan(big.length);
    // context.intake 落账,字段齐全
    const intakes = journal.readAll().filter((e) => e.kind === "context.intake");
    expect(intakes.length).toBe(1);
    const p = intakes[0]!.payload as Record<string, unknown>;
    for (const key of ["tool", "chars", "chunks", "keptChunks", "keptChars", "digestChars", "policy", "scorer", "durationMs", "droppedChunks", "droppedChars"]) {
      expect(p[key], `context.intake 缺字段 ${key}`).toBeDefined();
    }
    expect(p.tool).toBe("grep");
    expect(Number(p.chars)).toBe(big.length);
    expect(Number(p.chunks)).toBeGreaterThan(1);
    expect(typeof p.dumpPath).toBe("string");
    // result_read 能按行段取回 dump 原文
    const seg = readToolDump({ ref: "call_00_big", offset: 2_999, limit: 3 }, { dumpDir: dir });
    expect(seg.ok).toBe(true);
    if (seg.ok) expect(seg.text).toContain("3000|3000 关键命中ZEBRA");
  });

  it("GENIE_BIG_RESULT=off(装配折算 enabled:false)→ 原文逐字节直通,不写 dump、不落 context.intake", async () => {
    const dir = tmpDir();
    const journal = new MemoryJournal();
    const sid = "s-intake-off";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "q" } });
    const big = linesFixture(6_000);
    let call = 0;
    const llm: LlmProvider = {
      async chat() {
        call += 1;
        if (call === 1) return { content: "", toolCalls: [{ id: "call_00_off", name: "grep", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const tool: Tool = { name: "grep", description: "", parameters: {}, async execute() { return big; } };
    const loop = new AgentLoop({
      journal, sessionId: sid, system: "sys", llm, tools: [tool],
      microcompact: { thresholdTokens: 1_000_000 },
      // 与装配侧同口径:env=off 折算成 enabled:false
      bigIntake: cfg({ enabled: bigResultEnabledFromEnv({ GENIE_BIG_RESULT: "off" }), dumpDir: dir }),
    });
    await loop.runTurn("go");
    const content = String((journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string }).content);
    expect(content).toBe(big); // 逐字节
    expect(journal.readAll().some((e) => e.kind === "context.intake")).toBe(false);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0); // 不落盘
  });

  it("未配置 bigIntake → tool.result 原文直落(既有行为逐字不变)", async () => {
    const journal = new MemoryJournal();
    const sid = "s-intake-none";
    journal.append({ kind: "message.user", sessionId: sid, payload: { text: "q" } });
    const big = linesFixture(3_000);
    let call = 0;
    const llm: LlmProvider = {
      async chat() {
        call += 1;
        if (call === 1) return { content: "", toolCalls: [{ id: "c0", name: "grep", arguments: "{}" }] };
        return { content: "done" };
      },
    };
    const tool: Tool = { name: "grep", description: "", parameters: {}, async execute() { return big; } };
    const loop = new AgentLoop({ journal, sessionId: sid, system: "sys", llm, tools: [tool] });
    await loop.runTurn("go");
    const content = String((journal.readAll().find((e) => e.kind === "tool.result")!.payload as { content: string }).content);
    expect(content).toBe(big);
    expect(journal.readAll().some((e) => e.kind === "context.intake")).toBe(false);
  });
});

describe("大结果闸门:装配面(assembleIntake 纯函数)", () => {
  it("dumpPath 缺席时指针文案改为「全文未能落盘」;dropped 为空写「无」", () => {
    const chunks = splitChunks(linesFixture(10), 100);
    const res = assembleIntake({
      body: "body", policy: "chunk-select", totalChars: 100, totalTokens: 10, totalLines: 10,
      keptChunks: chunks.length, totalChunks: chunks.length, dropped: [], chunks, droppedChars: 0,
      dumpError: "EACCES",
    });
    expect(res.text).toContain("全文未能落盘,请重跑缩小范围(EACCES)");
    expect(res.text).toContain("筛掉清单:无");
    expect(res.truncatedChars).toBe(0);
    expect(res.bodyChars).toBe(4);
  });

  it("content 为空的调用不触发闸门", async () => {
    expect(await intakeToolResult({ content: "", callId: "c", toolName: "t", goal: "g", budgetTokens: 1, config: cfg() })).toBeUndefined();
  });
});

/** 39k 级单行 JSON:字符串里带真实换行 → 序列化后是转义 `\n` 两个字符,整条仍是 1 行。 */
function bigJsonLine(): string {
  const items = Array.from({ length: 390 }, (_, i) => ({
    id: i,
    name: `item-${i}-` + "x".repeat(40),
    note: `第一行内容${i}\n第二行内容${i}\n第三行`,
  }));
  return JSON.stringify({ items });
}

describe("大结果闸门:超长单行(行内分段 + 账目诚实 + truncate + chars 取回)", () => {
  it("39k 单行 JSON → 行内分段:partCount 正确、charStart/charEnd 逐字节拼回、标签唯一、每块 tokens 受控", () => {
    const json = bigJsonLine();
    expect(json.length).toBeGreaterThan(35_000);
    expect(json.includes("\n")).toBe(false); // 单行(换行是转义两字符)
    const chunks = splitChunks(json, 300);
    expect(chunks.length).toBeGreaterThan(1);
    const partCount = chunks[0]!.partCount;
    expect(partCount).toBe(chunks.length);
    chunks.forEach((c, i) => {
      expect(c.startLine).toBe(1);
      expect(c.endLine).toBe(1);
      expect(c.part).toBe(i + 1);
      expect(c.partCount).toBe(partCount);
      expect(c.tokens).toBeLessThanOrEqual(600); // 2×target 内
    });
    // 按原文 charStart/charEnd 拼接逐字节等于原文该行
    expect(chunks.map((c) => json.slice(c.charStart, c.charEnd)).join("")).toBe(json);
    // 标签唯一且是「行内分段」形态
    const labels = chunks.map((c) => chunkLabel(c));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toContain("第 1/");
    expect(labels[0]).toContain("段(字符 ");
  });

  it("selectChunks(budgetTokens=300):保留首段/末段,keptChars 受预算约束", async () => {
    const json = bigJsonLine();
    const chunks = splitChunks(json, 300);
    const r = await selectChunks({ chunks, goal: "item", budgetTokens: 300, config: cfg() });
    expect(r.kept).toContain(0);
    expect(r.kept).toContain(chunks.length - 1);
    const budgetChars = Math.max(2_000, 300 * 4);
    expect(r.keptChars).toBeLessThanOrEqual(budgetChars + chunks[0]!.text.length + chunks[chunks.length - 1]!.text.length);
  });

  it("intakeToolResult:39k 单行 → content≤6000、truncatedChars>0、keptChars=实际 body 长度、header 明说截断量", async () => {
    const dir = tmpDir();
    const json = bigJsonLine();
    const out = await intakeToolResult({
      content: json, callId: "call_00_bigline", toolName: "terminal", goal: "item 390", budgetTokens: 2_000,
      config: cfg({ dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("chunk-select");
    expect(out!.meta.chunks).toBeGreaterThan(1);
    expect(out!.content.length).toBeLessThanOrEqual(6_000);
    expect(out!.meta.truncatedChars).toBeGreaterThan(0);
    const bodyStart = out!.content.indexOf("\n") + 1;
    const bodyEnd = out!.content.indexOf("\n全文已落盘:");
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = out!.content.slice(bodyStart, bodyEnd);
    const marker = "…(选块正文按上限截断)";
    expect(out!.meta.keptChars).toBe(body.endsWith(marker) ? body.length - marker.length : body.length);
    expect(out!.content).toContain(`另 ${out!.meta.truncatedChars} 字符按上限截断`);
    expect(out!.content).toContain("result_read chars=");
    // dump 逐字节等于原文
    expect(readFileSync(out!.meta.dumpPath!, "utf8")).toBe(json);
  });

  it("无可切边界单行(minTokens 调低 + 超预算)→ policy=truncate,header 不假称选块", async () => {
    const dir = tmpDir();
    const content = "z".repeat(500); // ≈250 tok;非 JSON、250 ≤ 2×150 → 切不动
    const out = await intakeToolResult({
      content, callId: "call_00_trunc", toolName: "terminal", goal: "g", budgetTokens: 100,
      config: cfg({ dumpDir: dir, minTokens: 100 }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("truncate");
    expect(out!.meta.chunks).toBe(1);
    expect(out!.content).toContain("大结果闸门 truncate");
    expect(out!.content).toContain("未切块");
    expect(out!.content).toContain("全文已落盘:");
    expect(out!.content).not.toContain("保留 1 块]\n"); // 头部有附加说明,不是裸的 chunk-select 形态
  });

  it("assembleIntake:policy=truncate 且正文超 6000 → 截断量记账 + header/筛掉清单双处显式", () => {
    const json = bigJsonLine();
    const chunks = splitChunks(json, 300);
    const res = assembleIntake({
      body: json, policy: "truncate", totalChars: json.length, totalTokens: 9_000, totalLines: 1,
      keptChunks: 1, totalChunks: 1, dropped: [], chunks, droppedChars: 0, dumpPath: "/tmp/x.txt",
    });
    expect(res.truncatedChars).toBeGreaterThan(0);
    expect(res.text.length).toBeLessThanOrEqual(6_000);
    expect(res.bodyChars).toBe(json.length - res.truncatedChars);
    expect(res.text).toContain("未切块");
    expect(res.text).toContain(`另 ${res.truncatedChars} 字符按上限截断`);
    expect(res.text).toContain("result_read chars=");
  });

  it("result_read chars=\"1000-2000\":按 1-based 字符窗口精确取回原文区间;与 offset 互斥", async () => {
    const dir = tmpDir();
    const json = bigJsonLine();
    const out = await intakeToolResult({
      content: json, callId: "call_00_chars", toolName: "terminal", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    const seg = readToolDump({ ref: "call_00_chars", chars: "1000-2000" }, { dumpDir: dir });
    expect(seg.ok).toBe(true);
    if (seg.ok) {
      expect(seg.text).toBe(`字符 1000-2000(共 ${json.length} 字符)\n${json.slice(999, 2_000)}`);
    }
    const conflict = readToolDump({ ref: "call_00_chars", chars: "1-10", offset: 2 }, { dumpDir: dir });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("互斥");
    const bad = readToolDump({ ref: "call_00_chars", chars: "10" }, { dumpDir: dir });
    expect(bad.ok).toBe(false);
  });
});

/** 造一份结构合法的 git diff:每文件 index/---/+++ + n 个 hunk(hunk 正文里带 `src/a.ts:12` 型锚点)。 */
function diffFixture(paths: readonly string[], hunksPerFile = 2): string {
  const out: string[] = [];
  paths.forEach((p, i) => {
    out.push(`diff --git a/${p} b/${p}`);
    out.push("index 1234567..89abcde 100644");
    out.push(`--- a/${p}`);
    out.push(`+++ b/${p}`);
    for (let h = 1; h <= hunksPerFile; h++) {
      out.push(`@@ -${h * 20},6 +${h * 20},7 @@`);
      out.push("   context before");
      out.push("-  const oldValue = 1;");
      out.push(`+  const newValue = ${h}; // 改动 ${p}`);
      out.push(`+  const hit = resolveRef("src/a.ts:${12 + h}");`);
      out.push(`   context file${i} hunk${h} payload-payload-payload`);
      out.push("   tail context");
    }
  });
  return out.join("\n");
}

describe("大结果闸门:git diff 专用提炼轨", () => {
  it("JSON 包裹的 39k diff:解包识别 → digest 轨(prompt 含 diff 头/全部路径/file:line 锚点)", async () => {
    const dir = tmpDir();
    const files = ["src/a.ts", "src/order/service.ts", "docs/readme.md"];
    const patch = diffFixture(files, 3);
    // 压缩单行 JSON + 换行转义:diff 只以 `\n` 转义形式存在于 string leaf 里
    const json = JSON.stringify({ tool: "git diff", stdout: patch.split("\n"), padding: "n".repeat(37_000) });
    expect(json.split("\n").length).toBe(1);
    expect(json.length).toBeGreaterThan(38_000);
    let prompt = "";
    const out = await intakeToolResult({
      content: json, callId: "call_00_diff_json", toolName: "git_diff", goal: "看这次改动", budgetTokens: 1_500,
      config: cfg({
        dumpDir: dir,
        digest: async (p) => { prompt = p; return "## 改了哪些文件\n- src/a.ts +3/-1"; },
      }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("digest");
    expect(out!.meta.digestKind).toBe("diff");
    expect(out!.meta.digestInputChars).toBeGreaterThan(0);
    expect(prompt).toContain("diff --git a/"); // 送的是解包后的 diff,不是 JSON 原文
    for (const f of files) expect(prompt).toContain(f);
    expect(prompt).toContain("## 改了哪些文件");
    expect(prompt).toContain("## 每个文件的关键改动");
    expect(prompt).toMatch(/src\/a\.ts:\d+/); // file:line 锚点在输入里逐字可照抄
  });

  it("diff 低于摘要线(≈6k tok)仍走 digest:命中即提炼,不按 tokens 分流", async () => {
    const dir = tmpDir();
    const content = diffFixture(Array.from({ length: 10 }, (_, i) => `src/mod${i + 1}.ts`), 8);
    let called = 0;
    const out = await intakeToolResult({
      content, callId: "call_00_diff_small", toolName: "git_diff", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async () => { called += 1; return "## 风险\n- 无"; } }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.tokens).toBeGreaterThan(BIG_RESULT_MIN_TOKENS);
    expect(out!.meta.tokens).toBeLessThan(12_000);
    expect(intakeLevel(out!.meta.tokens, cfg())).toBe("chunk-select"); // 按量级本应只选块
    expect(called).toBe(1);
    expect(out!.meta.policy).toBe("digest");
    expect(out!.meta.digestKind).toBe("diff");
  });

  it("超 24k 字符 diff:送入输入保全部文件头行,被跳过的 hunk 显式标注", async () => {
    const dir = tmpDir();
    const files = Array.from({ length: 8 }, (_, i) => `src/big${i + 1}.ts`);
    const content = diffFixture(files, 20);
    expect(content.length).toBeGreaterThan(24_000);
    let prompt = "";
    const out = await intakeToolResult({
      content, callId: "call_00_diff_big", toolName: "git_diff", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async (p) => { prompt = p; return "## 风险\n- 无"; } }),
    });
    expect(out!.meta.policy).toBe("digest");
    for (const f of files) expect(prompt).toContain(`diff --git a/${f} b/${f}`);
    expect(prompt).toContain("跳过");
    expect(out!.meta.digestInputChars).toBeLessThan(content.length); // 确实压缩过
    expect(prompt.length).toBeLessThan(30_000);
  });

  it("config.digestTimeoutMs 原样透传给 digest(20s 默认值对真实模型 50s+ 是必杀)", async () => {
    const dir = tmpDir();
    let seen = -1;
    const out = await intakeToolResult({
      content: diffFixture(["src/a.ts"], 2), callId: "call_00_diff_timeout",
      toolName: "git_diff", goal: "g", budgetTokens: 100,
      config: cfg({
        minTokens: 100, dumpDir: dir, digestTimeoutMs: 120_000,
        digest: async (_p, opts) => { seen = opts.timeoutMs; return "## 改了哪些文件\n- src/a.ts"; },
      }),
    });
    expect(seen).toBe(120_000);
    expect(out!.meta.policy).toBe("digest");
    expect(out!.meta.digestError).toBeUndefined(); // 成功时不得出现
  });

  it("diff + 提炼抛错 → policy=fallback、meta.digestError 带原因、header 含「回退选块(原因:」", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: diffFixture(["src/a.ts", "src/b.ts"], 3), callId: "call_00_diff_fail",
      toolName: "git_diff", goal: "g", budgetTokens: 100,
      config: cfg({ minTokens: 100, dumpDir: dir, digest: async () => { throw new Error("模型 500"); } }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("fallback");
    expect(out!.meta.digestKind).toBe("diff");
    expect(out!.meta.digestError).toContain("模型 500");
    expect(out!.content).toContain("大结果闸门 fallback");
    expect(out!.content).toContain("回退选块(原因:");
    expect(out!.content).toContain("模型 500");
  });

  it("diff + 空摘要 → policy=fallback、digestError=empty、header 带原因", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: diffFixture(["src/a.ts", "src/b.ts"], 3), callId: "call_00_diff_empty",
      toolName: "git_diff", goal: "g", budgetTokens: 100,
      config: cfg({ minTokens: 100, dumpDir: dir, digest: async () => "   \n" }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("fallback");
    expect(out!.meta.digestError).toBe("empty");
    expect(out!.content).toContain("回退选块(原因:empty)");
  });

  it("generic 轨提炼抛错 → meta 记原因、header 不强加回退文案", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: linesFixture(3000), callId: "call_00_generic_fail",
      toolName: "terminal", goal: "g", budgetTokens: 2_000,
      config: cfg({ dumpDir: dir, digest: async () => { throw new Error("小模型超时"); } }),
    });
    expect(out).toBeTruthy();
    expect(intakeLevel(out!.meta.tokens, cfg())).toBe("digest");
    expect(out!.meta.digestKind).toBe("generic");
    expect(out!.meta.digestError).toContain("小模型超时");
    expect(out!.content).not.toContain("回退选块");
  });

  it("diff 无提炼模型 → 退回选块,header 显式「未提炼」", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: diffFixture(["src/a.ts", "src/b.ts"], 3), callId: "call_00_diff_nodigest",
      toolName: "git_diff", goal: "g", budgetTokens: 100,
      config: cfg({ minTokens: 100, dumpDir: dir }),
    });
    expect(out).toBeTruthy();
    expect(out!.meta.policy).toBe("chunk-select");
    expect(out!.meta.digestKind).toBe("diff");
    expect(out!.meta.digestInputChars).toBe(0);
    expect(out!.content).toContain("未提炼");
  });

  it("非 diff 大文本:digestKind=generic;level=chunk-select 时提炼函数一次都不调", async () => {
    const dir = tmpDir();
    const content = linesFixture(600); // ≈6k tok:过触发线但低于摘要线
    let called = 0;
    const out = await intakeToolResult({
      content, callId: "call_00_generic", toolName: "terminal", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async () => { called += 1; return "## 关键结论\n- 无"; } }),
    });
    expect(out).toBeTruthy();
    expect(intakeLevel(out!.meta.tokens, cfg())).toBe("chunk-select");
    expect(out!.meta.policy).toBe("chunk-select");
    expect(out!.meta.digestKind).toBe("generic");
    expect(out!.meta.digestInputChars).toBe(0);
    expect(called).toBe(0);
  });

  it("detectDiffText:纯文本/JSON 包裹命中;无 hunk 不命中;JSON 解析失败按直接文本判", () => {
    const plain = diffFixture(["src/a.ts", "src/b.ts"], 2);
    const r1 = detectDiffText(plain);
    expect(r1).toBeTruthy();
    expect(r1!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r1!.text).toBe(plain);

    const wrapped = JSON.stringify({ stdout: plain.split("\n") });
    expect(wrapped.split("\n").length).toBe(1);
    const r2 = detectDiffText(wrapped);
    expect(r2).toBeTruthy();
    expect(r2!.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r2!.text).toContain("diff --git a/src/a.ts b/src/a.ts"); // 解包文本,不是 JSON 原文

    // 以 `{` 开头但 JSON 解析失败 → 按直接文本判(内容自身带文件头 + hunk)
    const brokenJson = `{"stdout": 未闭合\n${plain}}`;
    const r3 = detectDiffText(brokenJson);
    expect(r3).toBeTruthy();
    expect(r3!.files).toContain("src/a.ts");

    // 只有文件头没有 hunk → 不是 diff
    expect(detectDiffText("diff --git a/x b/x\n--- a/x\n+++ b/x\n")).toBeUndefined();
    expect(detectDiffText("普通文本,没有任何 diff 结构")).toBeUndefined();
  });

  it("compressDiffForDigest:预算再紧也保全部 diff 头行,跳过处显式标注且保持原文件顺序", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i + 1}.ts`);
    const diff = diffFixture(files, 20);
    const squeezed = compressDiffForDigest(diff, 2_000);
    expect(squeezed.length).toBeLessThanOrEqual(2_000);
    for (const f of files) expect(squeezed).toContain(`diff --git a/${f} b/${f}`);
    expect(squeezed).toContain("跳过");
    const order = files.map((f) => squeezed.indexOf(`diff --git a/${f} b/${f}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  /** 2 文件 / 3 hunk:`---`/`+++` 文件头不得计入增删行。 */
  function diffStatsFixture(): string {
    return [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1111111..2222222 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-old line",
      "+new line 1",
      "+new line 2",
      "@@ -20,2 +21,3 @@",
      "-removed a",
      "-removed b",
      "+added a",
      " context",
      "diff --git a/src/two.ts b/src/two.ts",
      "index 3333333..4444444 100644",
      "--- a/src/two.ts",
      "+++ b/src/two.ts",
      "@@ -5,1 +5,2 @@",
      "-gone",
      "+fresh",
      "+bonus",
    ].join("\n");
  }

  /** 单文件 10 hunk × 125 行(≈101k 字符):头部与尾部各放唯一锚点。 */
  function hugeSingleFileDiff(): string {
    const out = ["diff --git a/src/huge.ts b/src/huge.ts", "index 1..2 100644", "--- a/src/huge.ts", "+++ b/src/huge.ts"];
    const hunks = 10;
    const lines = 125;
    for (let h = 1; h <= hunks; h++) {
      out.push(`@@ -${h * 100},${lines} +${h * 100},${lines} @@`);
      for (let l = 0; l < lines; l++) {
        const anchor = h === 1 && l === 0
          ? " HEAD_ANCHOR"
          : h === hunks && l === lines - 1
            ? " TAIL_ANCHOR"
            : "";
        out.push(`+line ${h}-${l} ${"x".repeat(70)}${anchor}`);
      }
    }
    return out.join("\n");
  }

  it("diffStats:只数 hunk 内的 +/-,排除 +++/---,路径取 b 侧,逐文件与合计数字准确", () => {
    const stats = diffStats(diffStatsFixture());
    expect(stats.fileCount).toBe(2);
    expect(stats.files).toEqual([
      { path: "src/one.ts", added: 3, removed: 3, hunks: 2 },
      { path: "src/two.ts", added: 2, removed: 1, hunks: 1 },
    ]);
    expect(stats.totalAdded).toBe(5);
    expect(stats.totalRemoved).toBe(4);
    const block = diffStatsBlock(stats);
    expect(block).toContain("## 确定性统计(必须逐字使用,禁止自行计算或改写)");
    expect(block).toContain("- src/one.ts +3/-3, 2 hunk");
    expect(block).toContain("- src/two.ts +2/-1, 1 hunk");
    expect(block).toContain("- 合计:+5/-4, 2 个文件");
  });

  it("diffPrompt:确定性统计块出现在「## 改了哪些文件」之前,且文案指向它为准", () => {
    const stats = diffStats(diffStatsFixture());
    const p = diffPrompt("查这次改动", "diff --git a/src/one.ts b/src/one.ts", "git_diff", diffStatsBlock(stats));
    const statsAt = p.indexOf("## 确定性统计");
    const filesAt = p.indexOf("## 改了哪些文件");
    expect(statsAt).toBeGreaterThan(-1);
    expect(filesAt).toBeGreaterThan(statsAt);
    expect(p).toContain("以「确定性统计」为准");
    expect(p).toContain("- src/one.ts +3/-3, 2 hunk");
  });

  it("单文件 100k diff:压缩后 prompt 同时含头部锚点与尾部 TAIL_ANCHOR,跳过处有标注", async () => {
    const dir = tmpDir();
    const content = hugeSingleFileDiff();
    expect(content.length).toBeGreaterThan(100_000);
    let prompt = "";
    const out = await intakeToolResult({
      content, callId: "call_00_diff_tail", toolName: "git_diff", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async (p) => { prompt = p; return "## 改了哪些文件\n- src/huge.ts +1200/-0"; } }),
    });
    expect(out!.meta.policy).toBe("digest");
    expect(prompt).toContain("HEAD_ANCHOR");
    expect(prompt).toContain("TAIL_ANCHOR");
    expect(prompt).toContain("跳过");
    expect(prompt).toContain("## 确定性统计");
    expect(prompt).toContain("- src/huge.ts +1250/-0, 10 hunk");
    expect(out!.meta.digestInputChars).toBeLessThanOrEqual(24_000);
  });

  it("digest(diff) header:不再报切块/筛掉清单,带压缩送提炼账与单行 JSON 标记", async () => {
    const dir = tmpDir();
    const patch = diffFixture(["src/a.ts", "src/b.ts"], 6);
    const json = JSON.stringify({ tool: "git diff", stdout: patch.split("\n"), padding: "n".repeat(30_000) });
    expect(json.split("\n").length).toBe(1);
    const out = await intakeToolResult({
      content: json, callId: "call_00_diff_header", toolName: "git_diff", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async () => "## 改了哪些文件\n- src/a.ts +6/-3" }),
    });
    expect(out!.meta.policy).toBe("digest");
    const c = out!.content;
    expect(c).toContain("[工具结果已精炼:大结果闸门 digest(diff);原共 ");
    expect(c).toContain("单行 JSON");
    expect(c).toMatch(/压缩 \d+ 字符送提炼\(2 个文件\)/);
    expect(c).not.toContain("切 ");
    expect(c).not.toContain("保留 ");
    expect(c).not.toContain("筛掉清单");
  });

  it("digest(diff) 直接文本:header 用真实行数,不标「单行 JSON」", async () => {
    const dir = tmpDir();
    const content = diffFixture(Array.from({ length: 10 }, (_, i) => `src/mod${i + 1}.ts`), 8);
    const out = await intakeToolResult({
      content, callId: "call_00_diff_lines", toolName: "git_diff", goal: "g", budgetTokens: 1_500,
      config: cfg({ dumpDir: dir, digest: async () => "## 风险\n- 无" }),
    });
    expect(out!.meta.policy).toBe("digest");
    expect(out!.content).toContain(`${content.split("\n").length} 行`);
    expect(out!.content).not.toContain("单行 JSON");
    expect(out!.content).not.toContain("筛掉清单");
  });

  it("generic digest header 仍按选块账目(切/保留/筛掉清单),不受 digest(diff) 分流影响", async () => {
    const dir = tmpDir();
    const out = await intakeToolResult({
      content: linesFixture(3000), callId: "call_00_generic_header", toolName: "terminal", goal: "g", budgetTokens: 2_000,
      config: cfg({ dumpDir: dir, digest: async () => "## 关键结论\n- 无" }),
    });
    expect(out!.meta.policy).toBe("digest");
    expect(out!.meta.digestKind).toBe("generic");
    expect(out!.content).toContain("大结果闸门 digest;原共 ");
    expect(out!.content).toContain("切 ");
    expect(out!.content).toContain("保留 ");
    expect(out!.content).toContain("筛掉清单");
    expect(out!.content).not.toContain("digest(diff)");
  });

  it("diffPrompt:四段固定 + 开头声明 + 末尾带任务目标/工具", () => {
    const p = diffPrompt("查这次改动", "diff --git a/src/a.ts b/src/a.ts", "git_diff");
    expect(p).toContain("只依据给定 diff 内容输出");
    expect(p).toContain("禁止推测");
    expect(p).toContain("## 改了哪些文件");
    expect(p).toContain("## 每个文件的关键改动");
    expect(p).toContain("## 风险");
    expect(p).toContain("## 建议");
    expect(p).toContain("任务目标:查这次改动");
    expect(p).toContain("工具:git_diff");
  });
});
