/**
 * LLM 调用轨迹(glm-5.3-flash 会话「不知道在干什么」,每次调用的
 * message 和 output 都要记录方便 debug):
 * ①sink 单元:全量 messages+响应+model 落 <baseDir>/<sessionId>/call-NNNN-tXsY.json,
 *   序号递增,journal 挂 llm.trace 指针(file+turn/step+usage);写失败静默(坏 baseDir 不抛)。
 * ②AgentLoop 集成:两步 fake provider(工具步+终稿步)→每步一文件,system 与 user 原文、
 *   响应 content/toolCalls 全量在场;provider 带 model 字段则如实记录。
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLlmTraceSink } from "../src/llm-trace.js";
import { estimateInputTokens, estimateCachedInputTokens } from "../src/llm-trace.js";
import { AgentLoop } from "@lampgenie/runtime/agent/loop";
import { setCalibrationFile, resetForTest, calibrationOf } from "@lampgenie/runtime/agent/token-estimate";
import { MemoryJournal } from "@lampgenie/core";
import type { Journal } from "@lampgenie/core";
import type { LlmProvider, LlmResponse } from "@lampgenie/runtime/agent/loop";
import { PANEL_SRC as src } from "./panel-source.js";

/** 等异步落盘完成(冻结治理:写改 fs.promises fire-and-forget,测试轮询等文件)。 */
const waitFiles = async (dir: string, n: number, ms = 3000): Promise<string[]> => {
  const t0 = Date.now();
  for (;;) {
    try {
      const files = readdirSync(dir).sort();
      if (files.length >= n) return files;
    } catch { /* 目录还没建好 */ }
    if (Date.now() - t0 > ms) throw new Error(`等 ${dir} 出现 ${n} 个文件超时`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("makeLlmTraceSink()", () => {
  it("① 全量落盘+序号递增+journal llm.trace 指针(meta 不带 payload)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t1-"));
    const j = new MemoryJournal();
    const sink = makeLlmTraceSink(j, dir);
    sink({
      sessionId: "web-test", turn: 1, step: 0, model: "glm-5.3-flash", durationMs: 1234, ttftMs: 88,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "修权限菜单" }],
      toolNames: ["grep", "read_file"],
      tools: [
        { name: "grep", description: "检索", parameters: { type: "object", properties: { pattern: { type: "string" } } } },
        { name: "read_file", description: "读文件", parameters: { type: "object", properties: {} } },
      ],
      provider: { baseUrl: "https://open.bigmodel.cn/api/anthropic", apiType: "anthropic", model: "glm-5.3-flash", maxTokens: 128000, reasoningEffort: "xhigh" },
      response: { content: "开始定位", toolCalls: [{ id: "c1", name: "grep", arguments: "{\"pattern\":\"x\"}" }], usage: { inputTokens: 10, outputTokens: 5 } },
    });
    sink({
      sessionId: "web-test", turn: 1, step: 1, model: "glm-5.3-flash", durationMs: 567,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "修权限菜单" }],
      toolNames: [], tools: [], response: { content: "完成" },
    });
    const files = await waitFiles(join(dir, "web-test"), 2);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^call-0001-t1s0-\d+\.json$/);
    expect(files[1]).toMatch(/^call-0002-t1s1-\d+\.json$/);
    const a = JSON.parse(readFileSync(join(dir, "web-test", files[0]!), "utf-8"));
    expect(a.model).toBe("glm-5.3-flash");
    expect(a.request.messages).toHaveLength(2);
    expect(a.request.messages[1].content).toBe("修权限菜单"); // 请求侧全文在场
    expect(a.response.toolCalls[0].name).toBe("grep"); // 输出侧全文在场
    expect(a.response.usage.inputTokens).toBe(10);
    expect(a.ttftMs).toBe(88);
    // 扩容(怎么送 LLM 就怎么记):完整工具 schema+provider 参数面(复现 wire 请求)
    expect(a.tools).toHaveLength(2);
    expect(a.tools[0].parameters.properties.pattern.type).toBe("string");
    expect(a.provider.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(a.provider.apiType).toBe("anthropic");
    expect(a.provider.maxTokens).toBe(128000);
    expect(JSON.stringify(a)).not.toContain("apiKey"); // 凭证永不落盘
    const b = JSON.parse(readFileSync(join(dir, "web-test", files[1]!), "utf-8"));
    expect(b.response.content).toBe("完成");
    expect(b.ttftMs).toBeUndefined();
 // journal 指针:file+meta,不带 messages(全文在文件);构型摘要在场(用户用户反馈配套)
    const ptrs = j.readAll().filter((e) => e.kind === "llm.trace");
    expect(ptrs).toHaveLength(2);
    const p0 = ptrs[0]!.payload as { file: string; turn: number; step: number; model?: string; usage?: unknown; messageRoles?: string[]; systemHead?: string; responseHead?: string; toolCalls?: string[] };
    expect(p0.file.endsWith(files[0]!)).toBe(true);
    expect(p0.turn).toBe(1);
    expect(p0.model).toBe("glm-5.3-flash");
    expect(p0.usage).toBeTruthy();
    expect(p0.messageRoles).toEqual(["system", "user"]); // 消息构型 journal 可见
    expect(p0.systemHead).toContain("SYS"); // system 头部摘要
    expect(p0.responseHead).toBe("开始定位");
    expect(p0.toolCalls).toEqual(["grep"]);
    expect(JSON.stringify(ptrs[0])).not.toContain("修权限菜单"); // 摘要有界,全文不进 journal
    rmSync(dir, { recursive: true, force: true });
  });

  it("② 写失败静默(轨迹旁路不打断主链);sessionId 防御性清洗做目录名", async () => {
    const j = new MemoryJournal();
    // baseDir 指向一个普通文件 → mkdir ENOTDIR 快速失败(勿用 /proc:该路径在本 WSL 上
 // sync mkdir 会真挂死,阻塞事件循环连测试超时器都失效—— 经验证注意)。
    const notDir = join(tmpdir(), "llm-trace-notdir-" + Date.now() + ".txt");
    writeFileSync(notDir, "x");
    const sink = makeLlmTraceSink(j, notDir);
    expect(() => sink({
      sessionId: "web-x", turn: 1, step: 0, durationMs: 1,
      messages: [{ role: "user", content: "x" }], toolNames: [], response: { content: "y" },
    })).not.toThrow();
    await new Promise((r) => setTimeout(r, 150)); // 异步失败落地
    expect(j.readAll().filter((e) => e.kind === "llm.trace")).toHaveLength(0); // 失败不落指针
 // 清洗:非法目录字符 → _;合法分隔符保留
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t2-"));
    const sink2 = makeLlmTraceSink(new MemoryJournal(), dir);
    sink2({ sessionId: "companion:20261019/../evil", turn: 1, step: 0, durationMs: 1, messages: [], toolNames: [], response: { content: "" } });
    await waitFiles(dir, 1);
    const dirs = readdirSync(dir);
    expect(dirs[0]).toBe("companion:20261019_.._evil"); // 无路径穿越
    rmSync(dir, { recursive: true, force: true });
    rmSync(notDir, { force: true });
  });
});

describe("AgentLoop×llmTrace 集成", () => {
  it("③ 两步 turn:每步一文件,system/user 原文+响应 toolCalls/终稿全量在场;model 尽力读 provider 字段", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t3-"));
    const j = new MemoryJournal();
    const seen: string[] = [];
    let n = 0;
    const llm: LlmProvider & { model: string; describe(): Record<string, unknown> } = {
      model: "fake-model-x",
      describe() { return { baseUrl: "https://fake.example/v1", apiType: "chat", model: "fake-model-x", maxTokens: 4096 }; },
      async chat(messages): Promise<LlmResponse> {
        seen.push(messages.map((m) => m.role).join(","));
        n++;
        return n === 1
          ? { content: "第一步", toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }] }
          : { content: "最终答复" };
      },
    };
    const loop = new AgentLoop({
      journal: j,
      sessionId: "it-trace",
      system: "你是测试 agent",
      llm,
      llmTrace: makeLlmTraceSink(j, dir),
      tools: [{
        name: "echo", description: "d",
        parameters: { type: "object", properties: {} },
        isConcurrencySafe: () => true,
        async execute() { return "ok"; },
      } as never],
      maxSteps: 4,
    });
    const out = await loop.runTurn("修一下这个 bug");
    expect(out).toBe("最终答复");
    const files = await waitFiles(join(dir, "it-trace"), 2);
    expect(files).toHaveLength(2);
    const step0 = JSON.parse(readFileSync(join(dir, "it-trace", files[0]!), "utf-8"));
    expect(step0.model).toBe("fake-model-x");
    expect(step0.request.messages[0]).toEqual({ role: "system", content: "你是测试 agent" });
    expect(step0.request.messages.at(-1)!.content).toContain("修一下这个 bug");
    expect(step0.response.toolCalls[0].name).toBe("echo");
    // 扩容:loop 透传完整工具规格+provider describe()(集成面)
    expect(step0.tools[0].name).toBe("echo");
    expect(step0.tools[0].parameters.type).toBe("object");
    expect(step0.provider.model).toBe("fake-model-x");
    expect(step0.provider.baseUrl).toBe("https://fake.example/v1");
    const step1 = JSON.parse(readFileSync(join(dir, "it-trace", files[1]!), "utf-8"));
    expect(step1.response.content).toBe("最终答复");
    // 第二步请求侧含工具结果回填(role=tool)
    expect(seen[1]).toContain("tool");
    // journal 指针与文件对齐
    const ptrs = j.readAll().filter((e) => e.kind === "llm.trace");
    expect(ptrs).toHaveLength(2);
    expect((ptrs[1]!.payload as { file: string }).file.endsWith(files[1]!)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe(" 本地估算 + 前缀缓存估算", () => {
  const ascii1000 = "a".repeat(1000);
  const han1000 = "汉".repeat(1000);
  const tool = (name: string, desc: string) => ({
    name, description: desc,
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
  });

  it("⑤ 估算器口径:ASCII BPE 压缩比、中文逐字更高、工具面严格增大、空输入=0", () => {
    // 自有估算口径:重复 ASCII 按 0.25/字(4 字符/token);role 也计入,故带 role 时 +1
    expect(estimateInputTokens([{ content: ascii1000 }])).toBe(250);
    expect(estimateInputTokens([{ role: "user", content: ascii1000 }])).toBe(251);
    // 1000 汉字 → 1950 tok(汉字类 1.95/字);只断言区间,不锁死具体数字
    const han = estimateInputTokens([{ role: "user", content: han1000 }]);
    expect(han).toBeGreaterThanOrEqual(1000);
    expect(han).toBeLessThan(3000);
    // 带工具 schema 时严格大于不带(工具面 name+description+parameters JSON 全计)
    const noTools = estimateInputTokens([{ role: "user", content: ascii1000 }]);
    const withTools = estimateInputTokens([{ role: "user", content: ascii1000 }], [tool("grep", "检索文件内容")]);
    expect(withTools).toBeGreaterThan(noTools);
    // 空输入 → 0,不返回 NaN/负数
    expect(estimateInputTokens([])).toBe(0);
    expect(estimateInputTokens([], [])).toBe(0);
    expect(estimateInputTokens(undefined, undefined)).toBe(0);
    expect(Number.isNaN(estimateInputTokens(null, null))).toBe(false);
    expect(estimateInputTokens([{ role: "user", content: "" }])).toBeGreaterThanOrEqual(0);
  });

  it("⑥ 前缀缓冲:首调 0、尾部追加≈上次全量、中途分叉只覆盖断点前", () => {
    const tools = [tool("grep", "检索文件内容")];
    const p1 = { role: "system", content: "SYS " + ascii1000 };
    const m2 = { role: "user", content: "修权限菜单 " + han1000 };
    const first = [p1, m2];
    // 首调(无 prev)→ 0
    expect(estimateCachedInputTokens(undefined, { messages: first, tools })).toBe(0);
    expect(estimateCachedInputTokens({ messages: [], tools }, { messages: first, tools })).toBe(0);
    const est1 = estimateInputTokens(first, tools);
    // 尾部追加一条消息:命中前 2 条(+工具面相同)= 几乎就是上一次的全量
    const second = [...first, { role: "assistant", content: "开始定位" }];
    const cached2 = estimateCachedInputTokens({ messages: first, tools }, { messages: second, tools });
    expect(cached2).toBeGreaterThanOrEqual(Math.floor(est1 * 0.9));
    // 中途分叉:第 3 条 content 改一个字 → 命中只有前 2 条,不大于前 2 条的估算上界
    const branch = [p1, m2, { role: "assistant", content: "开始定X" }];
    const cached3 = estimateCachedInputTokens({ messages: second, tools }, { messages: branch, tools });
    const bound = estimateInputTokens([p1, m2], tools); // 前 2 条 + 工具面(工具未变,仍命中)
    expect(cached3).toBeLessThanOrEqual(bound);
    expect(cached3).toBeGreaterThan(0);
    // 工具面变了 → 工具面不算命中(但仍覆盖命中消息部分)
    const cached4 = estimateCachedInputTokens({ messages: first, tools }, { messages: second, tools: [tool("grep", "改了描述")] });
    expect(cached4).toBeLessThan(cached2);
    expect(cached4).toBeGreaterThan(0);
  });

  it("⑦ sink 两请求:cached 超过上一步 input → usageSuspect + 带数字原因;估算稳定", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t7-"));
    const j = new MemoryJournal();
    const sink = makeLlmTraceSink(j, dir);
    const tools = [tool("grep", "检索文件内容")];
    const base = [
      { role: "system", content: "SYS " + ascii1000 },
      { role: "user", content: "修权限菜单 " + han1000 },
    ];
    sink({
      sessionId: "web-est", turn: 1, step: 0, model: "glm-5.3-flash", durationMs: 100,
      messages: base as never, tools: tools as never, toolNames: ["grep"],
      response: { content: "ok", usage: { inputTokens: 111976, outputTokens: 10, cachedTokens: 110848 } },
    });
    sink({
      sessionId: "web-est", turn: 1, step: 1, model: "glm-5.3-flash", durationMs: 100,
      messages: [...base, { role: "tool", content: "grep 回执 ok", toolCallId: "c1" }] as never,
      tools: tools as never, toolNames: ["grep"],
      response: { content: "done", usage: { inputTokens: 166159, outputTokens: 10, cachedTokens: 150528 } },
    });
    await waitFiles(join(dir, "web-est"), 2);
    const ptrs = j.readAll().filter((e) => e.kind === "llm.trace");
    expect(ptrs).toHaveLength(2);
    type P = {
      estimatedInputTokens?: number; estimatedCachedTokens?: number;
      usageSuspect?: boolean; usageAnomaly?: string;
    };
    const p0 = ptrs[0]!.payload as P;
    const p1 = ptrs[1]!.payload as P;
    // 本地估算总是下发;首调 cached=0
    expect(typeof p0.estimatedInputTokens).toBe("number");
    expect(p0.estimatedInputTokens!).toBeGreaterThan(0);
    expect(p0.estimatedCachedTokens).toBe(0);
    // 第二次:前缀几乎全命中 → cached 接近第一次的全量估算
    expect(p1.estimatedCachedTokens!).toBeGreaterThanOrEqual(Math.floor(p0.estimatedInputTokens! * 0.9));
    // 只追加一条小回执 → 两次估算差值远小于上报增量 54283(证明估算稳定)
    expect(Math.abs(p1.estimatedInputTokens! - p0.estimatedInputTokens!)).toBeLessThan(5000);
    // cached 150528 > 上一步 input 111976 → 可疑并给出带数字的原因
    expect(p1.usageSuspect).toBe(true);
    expect(p1.usageAnomaly!).toMatch(/\d/);
    expect(p1.usageAnomaly!).toContain("150528");
    expect(p1.usageAnomaly!).toContain("111976");
    rmSync(dir, { recursive: true, force: true });
  });

  it("⑧ 反向:两次几乎不变且上报与估算±10%内 → 不含 usageSuspect 键", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t8-"));
    const j = new MemoryJournal();
    const sink = makeLlmTraceSink(j, dir);
    const msgs = [{ role: "user", content: "短问题 " + ascii1000 }];
    const est = estimateInputTokens(msgs, []);
    const report = Math.round(est * 1.02); // 上报贴着本地估算(±10% 内)
    sink({
      sessionId: "web-ok", turn: 2, step: 0, durationMs: 50,
      messages: msgs as never, tools: [] as never, toolNames: [],
      response: { content: "a", usage: { inputTokens: report, outputTokens: 3, cachedTokens: Math.round(est * 0.5) } },
    });
    sink({
      sessionId: "web-ok", turn: 2, step: 1, durationMs: 50,
      messages: msgs as never, tools: [] as never, toolNames: [],
      response: { content: "b", usage: { inputTokens: report, outputTokens: 3, cachedTokens: Math.round(est * 0.5) } },
    });
    await waitFiles(join(dir, "web-ok"), 2);
    const ptrs = j.readAll().filter((e) => e.kind === "llm.trace");
    type P = { estimatedInputTokens?: number; usageSuspect?: boolean; usageAnomaly?: string };
    const p1 = ptrs[1]!.payload as P;
    expect(p1.estimatedInputTokens!).toBeGreaterThan(0);
    expect(p1).not.toHaveProperty("usageSuspect");
    expect(p1).not.toHaveProperty("usageAnomaly");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe(" 标定接线:usage 回写 ratio,第二轮起估计收敛", () => {
  it("⑨ 前三轮 ratio 未启用=raw;样本≥3 后 estRatio<1 且 estimatedInput 向上报值收敛", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-t9-"));
    const calFile = join(dir, "token-calibration.json");
    resetForTest();
    setCalibrationFile(calFile);
    const j = new MemoryJournal();
    const sink = makeLlmTraceSink(j, join(dir, "trace"));
    const provider = { baseUrl: "https://mock.provider/v1", apiType: "openai" as const, model: "mock-m1", maxTokens: 8192 };
    const msgs = [{ role: "user", content: "标定样本 " + "汉".repeat(300) + "a".repeat(300) }];
    // 上报值固定为本地 raw 的 0.8 倍(模拟 provider 口径偏低 20%)
    for (let i = 0; i < 5; i++) {
      const raw = estimateInputTokens(msgs, []);
      sink({
        sessionId: "web-cal", turn: 1, step: i, model: "mock-m1", durationMs: 20, provider,
        messages: msgs as never, tools: [] as never, toolNames: [],
        response: { content: "ok", usage: { inputTokens: Math.round(raw * 0.8), outputTokens: 5 } },
      });
    }
    await waitFiles(join(dir, "trace", "web-cal"), 5);
    const ptrs = j.readAll().filter((e) => e.kind === "llm.trace");
    type P = { estimatedInputTokens?: number; estRatio?: number; usageSuspect?: boolean; step?: number };
    // sink 是异步 fire-and-forget(文件写完才发指针),事件顺序不保证 → 按 step 定位而非数组下标。
    const byStep = (n: number) => ptrs.map((e) => e.payload as P).find((p) => p.step === n)!;
    const p1 = byStep(0);
    const p5 = byStep(4);
    // 第 1 轮:样本不足,ratio 恒 1(仍落键,便于观测「未启用」)
    expect(p1.estRatio!).toBe(1);
    // 第 5 轮:已采 4 个 0.8 样本 → ratio 启用且 <1
    const cal = calibrationOf("https://mock.provider/v1", "mock-m1");
    expect(cal.samples).toBeGreaterThanOrEqual(3);
    expect(cal.ratio).toBeLessThan(1);
    expect(cal.ratio).toBeGreaterThan(0.7);
    expect(p5.estRatio!).toBeCloseTo(cal.ratio, 5);
    // 标定后估计贴近上报值(相对误差≤10%),且严格小于未标定 raw
    const raw = estimateInputTokens(msgs, []);
    expect(p5.estimatedInputTokens!).toBeLessThan(raw);
    const reported = Math.round(raw * 0.8);
    expect(Math.abs(p5.estimatedInputTokens! - reported) / reported).toBeLessThan(0.1);
    resetForTest();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe("llm.trace 指针事件不丢失(2026-11 丢事件修复:重试 + drop 日志)", () => {
  /** 轮询等条件成立(异步落盘/异步 drop 日志都要等)。 */
  const waitUntil = async (fn: () => boolean, ms = 3000): Promise<void> => {
    const t0 = Date.now();
    for (;;) {
      if (fn()) return;
      if (Date.now() - t0 > ms) throw new Error("等条件成立超时");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** 读 drop 日志的非空行(等它出现)。 */
  const waitDropLines = async (file: string, ms = 3000): Promise<string[]> => {
    let lines: string[] = [];
    await waitUntil(() => {
      try {
        lines = readFileSync(file, "utf-8").split("\n").filter((x) => x.trim() !== "");
        return lines.length > 0;
      } catch { return false; }
    }, ms);
    return lines;
  };
  const callInfo = (sessionId: string, turn: number, step: number) => ({
    sessionId, turn, step, model: "fake-model", durationMs: 15,
    messages: [{ role: "user", content: "轨迹落盘" }],
    toolNames: [], tools: [],
    response: { content: "ok", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } },
  });

  it("⑩ append 恒抛错 → 轨迹文件仍落盘 + drop 日志恰好 1 行(含 sessionId/step/file)+ append 被调用 2 次(重试一次)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-drop-"));
    const dropLog = join(dir, "logs", "llm-trace-drop.log");
    let calls = 0;
    // 可注入 fake journal:append 恒抛(模拟 9p/EIO 之类的持久故障)
    const fake = { append() { calls += 1; throw new Error("journal 落盘失败: EIO"); } } as unknown as Journal;
    const sink = makeLlmTraceSink(fake, join(dir, "trace"), dropLog);
    sink(callInfo("web-drop", 3, 7));

    // 不变量 1:文件仍落盘(先写文件、再发指针;发指针失败不回收文件)
    const files = await waitFiles(join(dir, "trace", "web-drop"), 1);
    expect(files).toHaveLength(1);
    // 不变量 2:失败后立即重试一次 → append 共 2 次
    await waitUntil(() => calls >= 2);
    expect(calls).toBe(2);
    // 不变量 3:两投两失 → drop 日志恰好 1 行,字段可定位
    const lines = await waitDropLines(dropLog);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec.sessionId).toBe("web-drop");
    expect(rec.step).toBe(7);
    expect(rec.turn).toBe(3);
    expect(typeof rec.ts).toBe("number");
    expect(rec.file.endsWith(files[0]!)).toBe(true);
    expect(String(rec.error)).toContain("EIO");
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("⑪ append 第一次抛错、第二次成功 → 无 drop 日志行 + journal 里恰好 1 条 llm.trace(重试成功不双写)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-trace-retry-"));
    const dropLog = join(dir, "logs", "llm-trace-drop.log");
    process.env.GENIE_LLM_TRACE_DROP_LOG = dropLog; // 走 env 注入(tmpdir),验 env 路径也可用
    try {
      const events: unknown[] = [];
      let calls = 0;
      const fake = {
        append(e: unknown) {
          calls += 1;
          if (calls === 1) throw new Error("瞬时失败: 第一次 EIO");
          events.push(e);
          return { seq: events.length, time: Date.now(), ...(e as object) };
        },
      } as unknown as Journal;
      const sink = makeLlmTraceSink(fake, join(dir, "trace"));
      sink(callInfo("web-retry", 1, 2));

      const files = await waitFiles(join(dir, "trace", "web-retry"), 1);
      expect(files).toHaveLength(1);
      await waitUntil(() => events.length >= 1);
      expect(calls).toBe(2); // 第一次抛 + 第二次成功
      expect(events).toHaveLength(1); // 幂等:不双写
      const ev = events[0] as { kind: string; payload: { file: string; step: number } };
      expect(ev.kind).toBe("llm.trace");
      expect(ev.payload.file.endsWith(files[0]!)).toBe(true);
      expect(ev.payload.step).toBe(2);
      // 重试成功 → 不落 drop 日志(留点时间给可能的异步写,确认真没有)
      await new Promise((r) => setTimeout(r, 150));
      expect(existsSync(dropLog)).toBe(false);
    } finally {
      delete process.env.GENIE_LLM_TRACE_DROP_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("panel LLM 调用速览行(源结构锁)", () => {
  it("④ 渲染分支+点击复制路径绑定在场", () => {
        expect(src).toContain('ev.kind === "llm.trace"');
    expect(src).toContain("llm-trace-line");
    expect(src).toContain("data-trace-file");
    expect(src).toContain("轨迹文件路径已复制");
    expect(src).toContain("messageRoles"); // 构型链渲染
  });
});
