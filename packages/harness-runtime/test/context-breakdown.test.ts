import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryJournal } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Tool } from "../src/agent/loop";
import {
  CONTEXT_BREAKDOWN_KEYS,
  buildContextBreakdown,
  renderBreakdownTable,
  type ContextBreakdownEntry,
} from "../src/agent/context-breakdown";

const getTime: Tool = {
  name: "getTime",
  description: "获取当前时间",
  parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  async execute() { return "2026-11-08 12:00"; },
};

const tmpDirs: string[] = [];
const envBackup = new Map<string, string | undefined>();
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of envBackup) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  envBackup.clear();
});

function setEnv(k: string, v: string | undefined): void {
  if (!envBackup.has(k)) envBackup.set(k, process.env[k]);
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-bd-"));
  tmpDirs.push(d);
  return d;
}

function breakdownEvent(journal: MemoryJournal): Record<string, unknown> | undefined {
  return journal
    .readAll()
    .filter((e) => e.kind === "custom")
    .map((e) => e.payload as Record<string, unknown>)
    .find((p) => p["what"] === "context.breakdown");
}

describe("buildContextBreakdown 分类与口径", () => {
  it("固定 8 类、全配置时 configured=true、tokens 全为 local_estimate", () => {
    const toolDefs = [{ name: "getTime", description: "时间", parameters: { type: "object" } }];
    const bd = buildContextBreakdown({
      systemText: "SYS",
      rulesText: "RULES",
      skillsText: "SKILLS",
      mcpText: "MCP",
      subagentText: "SUBAGENT",
      memoryText: "MEMORY",
      toolDefs,
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "在的" },
      ],
    });
    expect(bd.entries.map((e) => e.key)).toEqual([...CONTEXT_BREAKDOWN_KEYS]);
    for (const e of bd.entries) {
      expect(e.configured).toBe(true);
      expect(e.source).toBe("local_estimate");
      expect(e.tokens).toBeGreaterThan(0);
    }
    const byKey = new Map(bd.entries.map((e) => [e.key, e]));
    expect(byKey.get("system_prompt")!.chars).toBe(3); // 逐字 exact
    expect(byKey.get("tool_definitions")!.chars).toBe(JSON.stringify(toolDefs).length);
    expect(byKey.get("conversation")!.chars).toBeGreaterThan(0);
    // total = 各类求和
    expect(bd.total.chars).toBe(bd.entries.reduce((n, e) => n + e.chars, 0));
    expect(bd.total.tokensEstimate).toBe(bd.entries.reduce((n, e) => n + e.tokens, 0));
  });

  it("undefined=未配置(0/0),空串/空数组=真实 0(configured=true)", () => {
    const missing = buildContextBreakdown({});
    for (const e of missing.entries) {
      expect(e.configured).toBe(false);
      expect(e.chars).toBe(0);
      expect(e.tokens).toBe(0);
    }
    expect(missing.total).toEqual({ chars: 0, tokensEstimate: 0 });

    const empty = buildContextBreakdown({ systemText: "", toolDefs: [], messages: [] });
    for (const key of ["system_prompt", "tool_definitions", "conversation"] as const) {
      const e = empty.entries.find((x) => x.key === key)!;
      expect(e.configured).toBe(true);
      expect(e.chars).toBe(0);
      expect(e.tokens).toBe(0);
    }
    for (const e of empty.entries.filter((x) => !["system_prompt", "tool_definitions", "conversation"].includes(x.key))) {
      expect(e.configured).toBe(false);
    }
    expect(empty.total).toEqual({ chars: 0, tokensEstimate: 0 });
  });

  it("toolDefs 计入 tool_definitions、messages 计入 conversation", () => {
    const bd = buildContextBreakdown({
      toolDefs: [{ name: "t", description: "d", parameters: {} }],
      messages: [{ role: "user", content: "hello world" }],
    });
    const tool = bd.entries.find((e) => e.key === "tool_definitions")!;
    const conv = bd.entries.find((e) => e.key === "conversation")!;
    expect(tool.chars).toBe(JSON.stringify([{ name: "t", description: "d", parameters: {} }]).length);
    expect(tool.tokens).toBeGreaterThan(0);
    expect(conv.chars).toBe("user".length + 1 + "hello world".length);
    expect(conv.tokens).toBeGreaterThan(0);
    // 其它 6 类未配置
    expect(bd.entries.filter((e) => e.configured).map((e) => e.key)).toEqual(["tool_definitions", "conversation"]);
  });

  it("renderBreakdownTable 标出未配置与合计", () => {
    const bd = buildContextBreakdown({ systemText: "abc", toolDefs: undefined, messages: [] });
    const table = renderBreakdownTable(bd.entries);
    expect(table).toContain("类别");
    expect(table).toContain("system 提示");
    expect(table).toContain("(未配置)");
    expect(table).toContain("合计");
    expect(table).toContain("100.0");
  });
});

describe("loop 接线:请求成功后落 context.breakdown", () => {
  it("一轮请求后存在事件、含 providerUsage 与 8 类 entries", async () => {
    setEnv("GENIE_CONTEXT_BREAKDOWN_EVERY", undefined);
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        return { content: "答", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s-bd", system: "你是助手", llm, tools: [getTime] });
    await loop.runTurn("hi");
    const p = breakdownEvent(journal)!;
    expect(p).toBeDefined();
    expect(p["sessionId"]).toBe("s-bd");
    expect(typeof p["turn"]).toBe("number");
    expect(typeof p["step"]).toBe("number");
    expect(typeof p["at"]).toBe("number");
    expect(p["providerUsage"]).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(p["entries"]).toHaveLength(8);
    expect(p["totalChars"]).toBeGreaterThan(0);
    expect(p["totalTokensEstimate"]).toBeGreaterThan(0);
  });

  it("provider 无 usage 也照落,providerUsage 为空对象", async () => {
    setEnv("GENIE_CONTEXT_BREAKDOWN_EVERY", undefined);
    const journal = new MemoryJournal();
    const llm: LlmProvider = { async chat() { return { content: "答" }; } };
    const loop = new AgentLoop({ journal, sessionId: "s-bd2", system: "sys", llm });
    await loop.runTurn("hi");
    const p = breakdownEvent(journal)!;
    expect(p["providerUsage"]).toEqual({});
  });

  it("请求失败不落 context.breakdown", async () => {
    setEnv("GENIE_CONTEXT_BREAKDOWN_EVERY", undefined);
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() {
        throw new Error("boom");
      },
    };
    const loop = new AgentLoop({ journal, sessionId: "s-bd3", system: "sys", llm });
    await expect(loop.runTurn("hi")).rejects.toThrow("boom");
    expect(breakdownEvent(journal)).toBeUndefined();
  });

  it("GENIE_CONTEXT_BREAKDOWN_EVERY=0 关闭", async () => {
    setEnv("GENIE_CONTEXT_BREAKDOWN_EVERY", "0");
    const journal = new MemoryJournal();
    const llm: LlmProvider = {
      async chat() { return { content: "答", usage: { inputTokens: 1, outputTokens: 1 } }; },
    };
    const loop = new AgentLoop({ journal, sessionId: "s-bd4", system: "sys", llm });
    await loop.runTurn("hi");
    expect(breakdownEvent(journal)).toBeUndefined();
  });

  it("GENIE_CONTEXT_BREAKDOWN_EVERY=2 → 3 步只落 2 帧(step 0/2)", async () => {
    setEnv("GENIE_CONTEXT_BREAKDOWN_EVERY", "2");
    let n = 0;
    const llm: LlmProvider = {
      async chat() {
        n += 1;
        return { content: "调", toolCalls: [{ id: `c${n}`, name: "getTime", arguments: "{}" }] };
      },
    };
    const journal = new MemoryJournal();
    const loop = new AgentLoop({ journal, sessionId: "s-bd5", system: "sys", llm, tools: [getTime], maxSteps: 3 });
    await loop.runTurn("hi");
    const frames = journal
      .readAll()
      .filter((e) => e.kind === "custom" && (e.payload as Record<string, unknown>)["what"] === "context.breakdown");
    expect(n).toBe(3);
    expect(frames.map((e) => (e.payload as Record<string, unknown>)["step"])).toEqual([0, 2]);
  });
});

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliScript = join(repoRoot, "scripts", "context-breakdown.mts");

function runCli(args: string[]) {
  return spawnSync(tsxBin, [cliScript, ...args], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
}

function fakeEntry(key: string): ContextBreakdownEntry {
  return { key, label: key, chars: 10, tokens: 3, source: "local_estimate", configured: true } as ContextBreakdownEntry;
}

function fakeFrame(sessionId: string, turn: number, step: number, at: number): string {
  return JSON.stringify({
    kind: "custom",
    sessionId,
    payload: {
      what: "context.breakdown",
      sessionId,
      turn,
      step,
      entries: CONTEXT_BREAKDOWN_KEYS.map(fakeEntry),
      totalChars: 80,
      totalTokensEstimate: 24,
      providerUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      at,
    },
  });
}

describe("CLI scripts/context-breakdown.mts", () => {
  it("2 帧 + --last 1 只打最后一帧,并带 provider usage 对照行", () => {
    const dir = mkTmp();
    writeFileSync(join(dir, "cli-s.jsonl"), `${fakeFrame("cli-s", 0, 0, 1)}\n${fakeFrame("cli-s", 1, 0, 2)}\n`, "utf8");
    const res = runCli(["--session", "cli-s", "--journal", dir, "--last", "1"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("turn 1 step 0");
    expect(res.stdout).not.toContain("turn 0 step 0");
    expect(res.stdout).toContain("provider usage: input=100 output=20 total=120");
    expect(res.stdout).toContain("合计");
  }, 60_000);

  it("--json 字段齐全", () => {
    const dir = mkTmp();
    writeFileSync(join(dir, "cli-s.jsonl"), `${fakeFrame("cli-s", 0, 0, 1)}\n${fakeFrame("cli-s", 1, 2, 2)}\n`, "utf8");
    const res = runCli(["--session", "cli-s", "--journal", dir, "--json"]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as {
      sessionId: string;
      count: number;
      frames: { turn: number; step: number; totalChars: number; totalTokensEstimate: number; providerUsage: Record<string, number>; entries: unknown[] }[];
    };
    expect(out.sessionId).toBe("cli-s");
    expect(out.count).toBe(1);
    expect(out.frames[0]!.turn).toBe(1);
    expect(out.frames[0]!.step).toBe(2);
    expect(out.frames[0]!.entries).toHaveLength(8);
    expect(out.frames[0]!.totalChars).toBe(80);
    expect(out.frames[0]!.totalTokensEstimate).toBe(24);
    expect(out.frames[0]!.providerUsage["totalTokens"]).toBe(120);
  }, 60_000);

  it("无事件明确提示并 exit 0;坏 journal exit 2", () => {
    const dir = mkTmp();
    writeFileSync(join(dir, "none.jsonl"), `${JSON.stringify({ kind: "turn.start", sessionId: "none", payload: { turn: 0 } })}\n`, "utf8");
    const none = runCli(["--session", "none", "--journal", dir]);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("该会话无 context.breakdown");

    const badDir = mkTmp();
    writeFileSync(join(badDir, "bad.jsonl"), "not-json\n", "utf8");
    const bad = runCli(["--session", "bad", "--journal", badDir]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("journal 解析失败");
  }, 60_000);
});
