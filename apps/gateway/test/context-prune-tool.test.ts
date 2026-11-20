/**
 * context_prune 工具测试(错误路径定向剪枝 agent 面):
 * 参数校验 / dryRun 不落账 / 零匹配附分布 / 节省下限拒 / 命中面过宽拒 /
 * 落账(journal custom 事件带 stats)/ 教训进负面知识库 / 与 deriveMessages 的全链闭环
 * (工具写声明 → 下一次 derive 重放折叠)。
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { contextPruneTool, CONTEXT_PRUNE_TOOL_NAME } from "../src/context-prune-tool";
import { deriveMessages } from "@lampgenie/runtime/agent/loop";

const tempDirs: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genie-cprune-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const SID = "cprune-1";

function seed(j: InstanceType<typeof MemoryJournal>): void {
  j.append({ kind: "message.user", sessionId: SID, payload: { text: "起服务" } });
 // journal 真实时序:每个调用是 assistant → tool.call → tool.result 一步(孤儿 tool.result
 // 会被 derive 的 provider 兼容规则丢弃,不能把全部 assistant 前置)。
  const steps: Array<{ id: string; name: string; args: string; content: string }> = [
    { id: "d1", name: "run_cmd", args: '{"command":"docker-compose up"}', content: "docker 错误输出 ".repeat(120) },
    { id: "d2", name: "run_cmd", args: '{"command":"docker-compose logs"}', content: "docker 日志 ".repeat(100) },
    { id: "d3", name: "terminal", args: '{"command":"docker ps -a"}', content: "docker 容器清单 ".repeat(90) },
    { id: "ok1", name: "run_cmd", args: '{"command":"systemctl status postgres"}', content: "postgres active ".repeat(60) },
    { id: "ed1", name: "edit_file", args: '{"path":"docker-compose.yml"}', content: "<edited docker-compose.yml> ".repeat(80) },
  ];
  for (const s of steps) {
    j.append({ kind: "message.agent", sessionId: SID, payload: { text: "", toolCalls: [{ id: s.id, name: s.name, arguments: s.args, type: "function" }] } });
    j.append({ kind: "tool.call", sessionId: SID, payload: { toolCallId: s.id, name: s.name, arguments: s.args, turn: 1, step: 1 } });
    j.append({ kind: "tool.result", sessionId: SID, payload: { toolCallId: s.id, content: s.content } });
  }
}

function makeTool(root: string): { tool: ReturnType<typeof contextPruneTool>; j: InstanceType<typeof MemoryJournal> } {
  const j = new MemoryJournal();
  seed(j);
  return { tool: contextPruneTool(j, SID, root), j };
}

describe("context_prune / 参数与守门", () => {
  it("缺 reason / 选择器全空 → usage 指引", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    expect(String(await tool.execute({ keywords: ["x"] }))).toContain("需要 reason");
    expect(String(await tool.execute({ reason: "r" }))).toContain("至少给一个");
  });

  it("零匹配 → 拒并附本会话工具分布", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    const out = String(await tool.execute({ reason: "r", keywords: ["kubernetes"] }));
    expect(out).toContain("零匹配");
    expect(out).toContain("run_cmd×3"); // d1 d2 ok1
    expect(out).toContain("terminal×1");
  });

  it("节省过小 → 拒(不值得破前缀)", async () => {
    const root = await tmpRoot();
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: SID, payload: { text: "u" } });
    j.append({ kind: "message.agent", sessionId: SID, payload: { text: "", toolCalls: [{ id: "s1", name: "run_cmd", arguments: '{"command":"x"}', type: "function" }] } });
    j.append({ kind: "tool.call", sessionId: SID, payload: { toolCallId: "s1", name: "run_cmd", arguments: '{"command":"x"}', turn: 1, step: 1 } });
    j.append({ kind: "tool.result", sessionId: SID, payload: { toolCallId: "s1", content: "tiny" } });
    const tool = contextPruneTool(j, SID, root);
    const out = String(await tool.execute({ reason: "r", keywords: ["tiny"], keepRecent: 0 }));
    expect(out).toContain("不值得");
  });

  it("命中面过宽(>60%)→ 拒,要求收窄", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
 // 关键词命中 d1/d2/d3/ed1 内容(不可逆 ed1 预演也豁免——预演规则与 derive 一致),
 // 但 keepRecent=0 时 d1/d2/d3 全命中,字符占比远超 60%(ok1/ed1 只占小头)。
    const out = String(await tool.execute({ reason: "全部都错", keywords: ["docker", "postgres", "edited"], keepRecent: 0 }));
    expect(out).toContain("过宽");
  });

  it("dryRun → 预览命中与节省,journal 不增长", async () => {
    const root = await tmpRoot();
    const { tool, j } = makeTool(root);
    const before = j.readAll().length;
    const out = String(await tool.execute({ reason: "docker 方案错", keywords: ["docker"], keepRecent: 0, dryRun: true }));
    expect(out).toContain("dryRun 预览");
    expect(out).toContain("run_cmd (1440 字):docker 错误输出");
    expect(j.readAll().length).toBe(before);
  });
});

describe("context_prune / 落账与闭环", () => {
  it("落账:journal custom 事件带 stats;derive 下一次重放即折叠", async () => {
    const root = await tmpRoot();
    const { tool, j } = makeTool(root);
    const out = String(await tool.execute({
      reason: "docker 方案在 WSL 起不来",
      lesson: "改用本机 postgres",
      keywords: ["docker"],
      keepRecent: 0,
    }));
    expect(out).toContain("已声明放弃该路径");
    expect(out).toContain("负面知识库"); // 教训带上了(登记成功或跳过都会提及)
    const decls = j.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "context.path.abandoned");
    expect(decls.length).toBe(1);
    const stats = (decls[0]!.payload as { stats?: { matched?: number } }).stats;
    expect(stats?.matched).toBe(3); // d1/d2/d3(ed1 不可逆豁免)
 // 全链:derive 折叠
    const tools = new Map<string, string>();
    for (const m of deriveMessages(j, SID)) {
      if (m.role === "tool") tools.set((m as { toolCallId: string }).toolCallId, String(m.content));
    }
    expect(tools.get("d1")).toContain("路径已放弃");
    expect(tools.get("d3")).toContain("路径已放弃");
    expect(tools.get("ok1")).not.toContain("路径已放弃"); // 正确路径
    expect(tools.get("ed1")).not.toContain("路径已放弃"); // 不可逆保护
    const texts = deriveMessages(j, SID).map((m) => String(m.content));
    expect(texts.some((t) => t.includes("教训:改用本机 postgres"))).toBe(true);
  });

  it("教训进负面知识库:negkb.jsonl 落一条 record", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    await tool.execute({ reason: "docker 方案错", lesson: "用本机服务", keywords: ["docker"], keepRecent: 0 });
    const text = await readFile(join(root, ".genie/rsi/negkb.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const rec = JSON.parse(lines[0]!) as { type?: string; record?: { failureEvidence?: Array<{ kind?: string }> } };
    expect(rec.type).toBe("record");
    expect(rec.record?.failureEvidence?.[0]?.kind).toBe("abandon");
  });

  it("无 lesson → 不写 negkb", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    const out = String(await tool.execute({ reason: "docker 方案错", keywords: ["docker"], keepRecent: 0 }));
    expect(out).not.toContain("负面知识库(");
    await expect(readFile(join(root, ".genie/rsi/negkb.jsonl"), "utf8")).rejects.toBeTruthy();
  });

  it("fromToolCallId 锚定:锚点前的同关键词命中不折(derive 闭环)", async () => {
    const root = await tmpRoot();
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: SID, payload: { text: "u" } });
    const steps = [
      { id: "early", name: "run_cmd", args: '{"command":"docker pull alpine"}', content: "docker 早期成功 ".repeat(100) },
      { id: "bad", name: "run_cmd", args: '{"command":"docker-compose up"}', content: "docker 失败输出 ".repeat(120) },
      { id: "bad2", name: "terminal", args: '{"command":"docker-compose logs"}', content: "docker 日志 ".repeat(110) },
    ];
    for (const s of steps) {
      j.append({ kind: "message.agent", sessionId: SID, payload: { text: "", toolCalls: [{ id: s.id, name: s.name, arguments: s.args, type: "function" }] } });
      j.append({ kind: "tool.call", sessionId: SID, payload: { toolCallId: s.id, name: s.name, arguments: s.args, turn: 1, step: 1 } });
      j.append({ kind: "tool.result", sessionId: SID, payload: { toolCallId: s.id, content: s.content } });
    }
    const tool = contextPruneTool(j, SID, root);
 // 锚点指向 bad(第一条失败结果)
    const out = String(await tool.execute({ reason: "docker 方案错", keywords: ["docker"], keepRecent: 0, fromToolCallId: "bad" }));
    expect(out).toContain("已声明放弃该路径");
    expect(out).toContain("区间 [");
    const tools = new Map<string, string>();
    for (const m of deriveMessages(j, SID)) {
      if (m.role === "tool") tools.set((m as { toolCallId: string }).toolCallId, String(m.content));
    }
    expect(tools.get("early")).not.toContain("路径已放弃"); // 锚点前不折
    expect(tools.get("early")).toContain("早期成功");
    expect(tools.get("bad")).toContain("路径已放弃");
    expect(tools.get("bad2")).toContain("路径已放弃");
    const decls = j.readAll().filter((e) => e.kind === "custom" && (e.payload as { type?: string }).type === "context.path.abandoned");
    expect((decls[0]!.payload as { fromSeq?: number }).fromSeq).toBeGreaterThan(0);
  });

  it("非法锚点拒:dryRun 线程分段给出 fromSeq 建议行", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    const bad = String(await tool.execute({ reason: "r", keywords: ["docker"], keepRecent: 0, fromToolCallId: "nope" }));
    expect(bad).toContain("不存在");
    const badSeq = String(await tool.execute({ reason: "r", keywords: ["docker"], keepRecent: 0, fromSeq: -3 }));
    expect(badSeq).toContain("非法");
    const zero = String(await tool.execute({ reason: "r", keywords: ["kubernetes"], dryRun: true }));
    expect(zero).toContain("零匹配");
    expect(zero).toContain("fromSeq="); // 线程分段建议行
    const wide = String(await tool.execute({ reason: "r", keywords: ["docker", "postgres", "edited"], keepRecent: 0 }));
    expect(wide).toContain("过宽");
    expect(wide).toContain("fromSeq"); // 过宽守门也带线程建议
  });

  it("工具名与 description 面向 agent 可发现", async () => {
    const root = await tmpRoot();
    const { tool } = makeTool(root);
    expect(tool.name).toBe(CONTEXT_PRUNE_TOOL_NAME);
    expect(String(tool.description)).toContain("wrong path");
    expect(tool.isReadOnly?.()).toBe(false);
  });
});
