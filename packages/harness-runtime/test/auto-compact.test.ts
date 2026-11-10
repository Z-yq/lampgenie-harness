import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCompact, estimateTokens } from "../src/agent/auto-compact";
import { deriveMessages, type LlmProvider } from "../src/agent/loop";

const fakeCompactLlm: LlmProvider = {
  async chat() { return { content: "摘要:做了一个功能" }; },
};

describe("auto-compact + DevLog", () => {
  it("低于阈值不触发", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "短" } });
    const r = await autoCompact(j, "s", { thresholdTokens: 10000, keepRecentMessages: 5, compactLlm: fakeCompactLlm, devlogDir: "/tmp/x" });
    expect(r.compacted).toBe(false);
  });

  it("超阈值触发:boundary 落盘+reminder 重注入+DevLog 双格式", async () => {
    const j = new MemoryJournal();
    // 造一个长会话
    for (let i = 0; i < 20; i++) {
      j.append({ kind: "message.user", sessionId: "s", payload: { text: "很长很长的内容".repeat(50) } });
    }
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: fakeCompactLlm, devlogDir: dir });
    expect(r.compacted).toBe(true);
    // boundary + reminder
    const events = j.readAll();
    expect(events.some((e) => e.kind === "compact.done")).toBe(true);
    const sys = events.find((e) => e.kind === "message.system");
    expect(String((sys!.payload as { text: string }).text)).toContain("上下文已压缩");
    // DevLog 双格式
    const files = readdirSync(dir);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    const md = readFileSync(join(dir, files.find((f) => f.endsWith(".md"))!), "utf-8");
    expect(md).toContain("摘要:做了一个功能");
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 修「主动 /compact 感觉没运行」(板节点 n1/n2):
 * ①消息数 ≤ keepRecentMessages 时 head 为空 → 旧实现只把 system 提示喂模型、摘要空串,
 *   仍写 compact.done 且 summary="";loop 的边界判定(summary 非空才截断)忽略它 → 上下文
 *   一条没减,前端却报「已压缩(摘要 0 字)」。现在必须诚实返回 + 不留假压缩痕迹。
 * ②compact.done 带 tail,deriveMessages 边界=清空历史 + 重放 tail + 重注入摘要。
 */
describe("auto-compact 诚实性(n1/n2:空摘要假压缩 + tail 丢失)", () => {
  it("消息数 ≤ keepRecentMessages:compacted:false,journal 无 compact.done(也不留 compact.start)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "第一轮" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "答" } });
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "第二轮" } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    let called = 0;
    const llm: LlmProvider = { async chat() { called += 1; return { content: "不该被调用" }; } };
    // force:true = 手动 /compact 语义:必须靠 head 空守卫拦下(阈值拦不住)
    const r = await autoCompact(j, "s", { thresholdTokens: 1, keepRecentMessages: 5, compactLlm: llm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("无可压缩部分");
    expect(called).toBe(0); // 没内容就别调模型
    const kinds = j.readAll().map((e) => e.kind);
    expect(kinds).not.toContain("compact.done");
    expect(kinds).not.toContain("compact.start"); // 假压缩不留痕
    // 边界元数据:head 空=跳过,必须落 compact.skipped(带 reason/trigger),不能静默
    const skipEv = j.readAll().find((e) => e.kind === "compact.skipped");
    expect(skipEv).toBeTruthy();
    const skipP = skipEv!.payload as { reason?: string; trigger?: string };
    expect(String(skipP.reason ?? "")).toContain("无可压缩部分");
    expect(skipP.trigger).toBe("auto"); // 缺省 trigger
    expect(readdirSync(dir)).toHaveLength(0); // 也不落 devlog
    rmSync(dir, { recursive: true, force: true });
  });

  it("摘要为空串(mock llm content:\"\"):compacted:false,journal 无 compact.done,上下文不变", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 20; i++) {
      j.append({ kind: "message.user", sessionId: "s", payload: { text: "内容".repeat(50) } });
    }
    const before = deriveMessages(j, "s").length;
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const emptyLlm: LlmProvider = { async chat() { return { content: "" }; } };
    const r = await autoCompact(j, "s", { thresholdTokens: 1, keepRecentMessages: 3, compactLlm: emptyLlm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("空内容");
    const events = j.readAll();
    // compact.start 是过程事件可保留;compact.done 是边界,绝不能写
    expect(events.some((e) => e.kind === "compact.done")).toBe(false);
    // 边界元数据:摘要空串=失败,必须落 compact.failed(带 reason/trigger)
    const failEv = events.find((e) => e.kind === "compact.failed");
    expect(failEv).toBeTruthy();
    const failP = failEv!.payload as { reason?: string; trigger?: string };
    expect(String(failP.reason ?? "")).toContain("空内容");
    expect(failP.trigger).toBe("auto");
    expect(readdirSync(dir)).toHaveLength(0);
    // 没有边界 → deriveMessages 一条不少(上下文没被清空也不会假恢复)
    expect(deriveMessages(j, "s").length).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("正常压缩:deriveMessages = tail 条数 + 摘要重注入,head 内容确实不在了", async () => {
    const j = new MemoryJournal();
    const HEAD_MARK = "HEAD-ONLY-MARKER";
    j.append({ kind: "message.user", sessionId: "s", payload: { text: HEAD_MARK + "开头任务" } });
    for (let i = 0; i < 20; i++) {
      j.append({ kind: "message.agent", sessionId: "s", payload: { text: `第${i}步` } });
    }
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 1, keepRecentMessages: 3, compactLlm: fakeCompactLlm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(true);
    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const tail = (done.payload as { tail?: unknown[] }).tail!;
    expect(tail).toHaveLength(3);
    // 边界元数据(2026-11):summaryChars 与 summary 同口径、trigger 透传、boundaryId 有值
    const doneP = done.payload as { summary?: string; summaryChars?: number; trigger?: string; boundaryId?: string; summaryMessageIds?: unknown };
    expect(doneP.summaryChars).toBe((doneP.summary ?? "").length);
    expect(doneP.trigger).toBe("auto");
    expect(String(doneP.boundaryId ?? "")).toMatch(/^cb-s-\d+$/);
    expect(Array.isArray(doneP.summaryMessageIds)).toBe(true);
    // compact.start 带 trigger/startedAt
    const startP = j.readAll().find((e) => e.kind === "compact.start")!.payload as { trigger?: string; startedAt?: number };
    expect(startP.trigger).toBe("auto");
    expect(typeof startP.startedAt).toBe("number");

    const out = deriveMessages(j, "s");
    // tail 3 条 + 边界后的 message.system 摘要重注入 1 条(derive 里以 user 角色注入)
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3).map((m) => m.content)).toEqual(["第17步", "第18步", "第19步"]);
    expect(out[3]!.content).toContain("上下文已压缩");
    expect(out.some((m) => m.content.includes(HEAD_MARK))).toBe(false); // head 真不在了
    rmSync(dir, { recursive: true, force: true });
  });

  it("tool 配对:tail 首条是 tool 结果时 deriveMessages 不出现孤立 tool 消息(repairToolPairing 兜住)", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "跑工具" } });
    for (let i = 0; i < 5; i++) j.append({ kind: "message.agent", sessionId: "s", payload: { text: `步${i}` } });
    // 被压进 head 的 assistant(toolCalls) + 它的结果:结果落在 tail 里而调用在 head 里
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "", toolCalls: [{ id: "c-old", name: "read_file", arguments: "{}" }] } });
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c-old", content: "结果" } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "收尾" } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeCompactLlm, devlogDir: dir, force: true });
    expect(r.compacted).toBe(true);
    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const tail = (done.payload as { tail: { role: string }[] }).tail;
    expect(tail[0]!.role).toBe("tool"); // 前提成立:tail 首条就是那个 tool 结果
    const out = deriveMessages(j, "s");
    // 孤立 tool 结果被 repairToolPairing 丢弃(其 assistant 调用已在 head 里被清掉)
    expect(out.some((m) => m.role === "tool")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tail 单条 content 超过 8000 字被截断并标注", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "长输出" } });
    for (let i = 0; i < 5; i++) j.append({ kind: "message.agent", sessionId: "s", payload: { text: `步${i}` } });
    j.append({ kind: "message.agent", sessionId: "s", payload: { text: "X".repeat(9000) } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    await autoCompact(j, "s", { thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeCompactLlm, devlogDir: dir, force: true });
    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const last = (done.payload as { tail: { content: string }[] }).tail.at(-1)!;
    expect(last.content.length).toBeLessThan(8100);
    expect(last.content.endsWith("…(截断)")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Phase 0:摘要前 microcompact + 关键事实台账", () => {
  it("摘要模型看到头尾(而非整段洪泛),compact.done/重注入保留 path:line 与错误", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "修登录" } });
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/noisy.ts" }) }] },
    });
    const flood = "日志".repeat(5_000);
    j.append({
      kind: "tool.result", sessionId: "s",
      payload: { toolCallId: "c1", content: flood },
    });
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c2", name: "terminal", arguments: JSON.stringify({ command: "npm test" }) }] },
    });
    j.append({
      kind: "tool.result", sessionId: "s",
      payload: {
        toolCallId: "c2",
        content: "Traceback (most recent call last):\n  at src/auth.ts:42:5\nError: boom",
      },
    });
    for (let i = 0; i < 6; i++) {
      j.append({ kind: "message.user", sessionId: "s", payload: { text: `后续${i}` } });
    }

    let seenSystem = "";
    let seenAll = "";
    const llm: LlmProvider = {
      async chat(messages) {
        seenSystem = String(messages[0]?.content ?? "");
        seenAll = messages.map((m) => String(m.content ?? "")).join("\n");
        return { content: "摘要:修登录" };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", {
      thresholdTokens: 1, keepRecentMessages: 2, compactLlm: llm, devlogDir: dir,
      force: true, microcompact: { thresholdTokens: 1 },
    });
    expect(r.compacted).toBe(true);
    expect(seenAll).toContain("[工具结果已精炼:");
    expect(seenAll).not.toContain(flood); // 摘要输入不再包含整段洪泛
    expect(seenSystem).toContain("关键事实台账");
    expect(seenSystem).toContain("src/auth.ts:42");

    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    expect((done.payload as { facts?: string }).facts).toContain("src/auth.ts:42");
    const sys = j.readAll().find((e) => e.kind === "message.system")!;
    const sysText = String((sys.payload as { text: string }).text);
    expect(sysText).toContain("[关键事实台账]");
    expect(sysText).toContain("src/auth.ts:42");
    rmSync(dir, { recursive: true, force: true });
  });

  it("非错误大结果中段 path:剪枝后丢失,facts ledger 从原始消息保留", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "查中间路径" } });
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c-mid", name: "grep", arguments: JSON.stringify({ pattern: "marker", path: "src" }) }] },
    });
    const huge = "x".repeat(9_000) + "\nsrc/middle.ts:77: marker\n" + "y".repeat(9_000);
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c-mid", content: huge } });
    for (let i = 0; i < 6; i++) {
      j.append({ kind: "message.user", sessionId: "s", payload: { text: `后续${i}` } });
    }

    let seenSystem = "";
    let seenHead = "";
    const llm: LlmProvider = {
      async chat(messages) {
        seenSystem = String(messages[0]?.content ?? "");
        seenHead = messages.slice(1).map((m) => String(m.content ?? "")).join("\n");
        return { content: "摘要" };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", {
      thresholdTokens: 1, keepRecentMessages: 2, compactLlm: llm, devlogDir: dir, force: true,
      microcompact: { thresholdTokens: 1 },
    });
    expect(r.compacted).toBe(true);
    expect(seenHead).not.toContain("src/middle.ts:77"); // head/tail 确实剪掉了中段
    expect(seenSystem).toContain("src/middle.ts:77");   // 台账从原始消息保住了
    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    expect((done.payload as { facts?: string }).facts).toContain("src/middle.ts:77");
    rmSync(dir, { recursive: true, force: true });
  });

  it("tail 中段栈帧:tail 8000 字截断后,facts ledger 仍保留被截掉的 path:line", async () => {
    const j = new MemoryJournal();
    j.append({ kind: "message.user", sessionId: "s", payload: { text: "修登录" } });
    for (let i = 0; i < 5; i++) {
      j.append({ kind: "message.agent", sessionId: "s", payload: { text: `步${i}` } });
    }
    j.append({
      kind: "message.agent", sessionId: "s",
      payload: { text: "", toolCalls: [{ id: "c-tail", name: "terminal", arguments: JSON.stringify({ command: "npm test" }) }] },
    });
    // 中段关键帧放在 8000 字之后:toTailMessage 截断会丢它,facts ledger 从全量消息抽取应保住。
    const huge = "Traceback (most recent call last):\n"
      + "a".repeat(9_000) + "\n  File \"src/critical.ts\", line 99, in foo\n" + "b".repeat(2_000);
    j.append({ kind: "tool.result", sessionId: "s", payload: { toolCallId: "c-tail", content: huge } });

    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", {
      thresholdTokens: 1, keepRecentMessages: 2, compactLlm: fakeCompactLlm, devlogDir: dir, force: true,
    });
    expect(r.compacted).toBe(true);
    const done = j.readAll().find((e) => e.kind === "compact.done")!;
    const payload = done.payload as { tail?: { content: string }[]; facts?: string };
    const tailTool = payload.tail?.find((m) => m.content.includes("Traceback"));
    expect(tailTool?.content.length ?? 0).toBeLessThan(8_100);
    expect(tailTool?.content.includes("src/critical.ts") ?? false).toBe(false); // 前提:tail 截断确实丢了中段
    expect(payload.facts).toContain("src/critical.ts");
    const sys = j.readAll().find((e) => e.kind === "message.system")!;
    expect(String((sys.payload as { text: string }).text)).toContain("src/critical.ts");
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 强压守卫(压缩死亡螺旋根治,web-1793696471953 注意):
 * gate 的 hardOver force 在「对话史估算已低于阈值」时,压缩只能把已缩小的对话史反复重压
 * (60 次连环强压,每次仅 12 条消息、est 6~17K,摘要套摘要,原始用户消息全丢)。
 * 守卫:trigger=auto + force + est < 阈值 → 跳过并落 compact.skipped(guard=force-vs-est);
 * 手动 /compact(manual)不受限。
 */
describe("auto-compact 强压守卫(force-vs-est,2026-11-04)", () => {
  it("auto 强压 + est < 阈值:拒压,落 compact.skipped 带 guard 标记与阈值(死亡螺旋形态)", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 12; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: `第${i}轮短消息` } });
    let called = 0;
    const llm: LlmProvider = { async chat() { called += 1; return { content: "不该被调用" }; } };
 // 螺旋经验证形态:阈值 300000(窗口口径),est≈数百,force=true(hardOver)
    const r = await autoCompact(j, "s", { thresholdTokens: 300_000, keepRecentMessages: 5, compactLlm: llm, devlogDir: "/tmp/x", force: true, trigger: "auto" });
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("强压守卫");
    expect(called).toBe(0);
    const skip = j.readAll().find((e) => e.kind === "compact.skipped")!;
    const p = skip.payload as { guard?: string; thresholdTokens?: number };
    expect(p.guard).toBe("force-vs-est");
    expect(p.thresholdTokens).toBe(300_000);
    expect(j.readAll().some((e) => e.kind === "compact.done")).toBe(false);
  });

  it("auto 强压 + est ≥ 阈值:真实历史增长,正常压缩(守卫不拦)", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 20; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: "很长很长的内容".repeat(50) } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: fakeCompactLlm, devlogDir: dir, force: true, trigger: "auto" });
    expect(r.compacted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("手动 /compact(manual + force + est < 阈值):不受守卫限制,照常压缩", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 12; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: `第${i}轮短消息` } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 300_000, keepRecentMessages: 5, compactLlm: fakeCompactLlm, devlogDir: dir, force: true, trigger: "manual" });
    expect(r.compacted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("compact.start 自带 threshold 观测字段(2026-11-04:死亡螺旋复盘不再反推阈值)", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 20; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: "很长很长的内容".repeat(50) } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    await autoCompact(j, "s", { thresholdTokens: 100, keepRecentMessages: 3, compactLlm: fakeCompactLlm, devlogDir: dir });
    const start = j.readAll().find((e) => e.kind === "compact.start")!;
    expect((start.payload as { threshold?: number }).threshold).toBe(100);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 骑线修复:阈值附近的真实大历史(≥50% 阈值)的 auto 强压必须真压——
 * 闸门按真实 input 测(含系统/工具面),est 常停在阈下 90%+,旧守卫「est<阈即拒」会把
 * 「每步喊压/每步拒」打成空转(web-1793790405127 注意:293K est vs 300K 阈,15 连 skip)。
 */
describe("auto-compact 骑线守卫比例(2026-11-05)", () => {
  it("est 达阈值 50% 以上的大历史:auto 强压真压(不再空转)", async () => {
    const j = new MemoryJournal();
    // 造 ~16 万 token 的真实历史(阈值 30 万的 54%)
    for (let i = 0; i < 10; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: "长".repeat(32000) } });
    const dir = mkdtempSync(join(tmpdir(), "gh-devlog-"));
    const r = await autoCompact(j, "s", { thresholdTokens: 300_000, keepRecentMessages: 3, compactLlm: fakeCompactLlm, devlogDir: dir, force: true, trigger: "auto" });
    expect(r.compacted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it("est 远小于阈值(死螺旋形态,2~6%):仍拒压", async () => {
    const j = new MemoryJournal();
    for (let i = 0; i < 12; i++) j.append({ kind: "message.user", sessionId: "s", payload: { text: `第${i}轮短消息` } });
    const llm: LlmProvider = { async chat() { return { content: "不该被调用" }; } };
    const r = await autoCompact(j, "s", { thresholdTokens: 300_000, keepRecentMessages: 5, compactLlm: llm, devlogDir: "/tmp/x", force: true, trigger: "auto" });
    expect(r.compacted).toBe(false);
    expect(String(r.reason ?? "")).toContain("强压守卫");
  });
});
