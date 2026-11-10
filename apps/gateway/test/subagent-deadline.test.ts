/**
 * 子代理时间盒解析(2026-10-25 大并发修复):
 * 显式 deadlineMin > 全局 agent.subagentDeadlineMin > planner 专属缺省(8 分钟,0=关闭)。
 * planner 缺省时间盒用于防止单个慢 planner 长期占住 TaskSupervisor 全局并发槽,导致大批任务排队看起来「挂住」;
 * 其他子代理角色未配置时仍不限时(2026-10-21 口径)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubagentDeadlineMin } from "../src/agent-wiring.js";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";

describe("resolveSubagentDeadlineMin", () => {
  it("显式参数优先;0/非法值走配置回退", () => {
    expect(resolveSubagentDeadlineMin("planner", 3, { plannerDeadlineMin: 12 })).toBe(3);
    expect(resolveSubagentDeadlineMin("worker", 7, { subagentDeadlineMin: 5 })).toBe(7);
    expect(resolveSubagentDeadlineMin("planner", 0, { subagentDeadlineMin: 5 })).toBe(5);
    expect(resolveSubagentDeadlineMin("planner", "bad", { subagentDeadlineMin: 5 })).toBe(5);
  });

  it("全局 subagentDeadlineMin 对 planner/worker 都生效,高于 planner 专属缺省", () => {
    expect(resolveSubagentDeadlineMin("planner", undefined, { subagentDeadlineMin: 5, plannerDeadlineMin: 12 })).toBe(5);
    expect(resolveSubagentDeadlineMin("worker", undefined, { subagentDeadlineMin: 5 })).toBe(5);
  });

  it("planner 未配置专属时间盒=10 分钟(2026-11-06 按 14 天复盘 8→10,正常组 p90=9.2);显式 0=不限时", () => {
    expect(resolveSubagentDeadlineMin("planner", undefined, {})).toBe(10);
    expect(resolveSubagentDeadlineMin("planner", undefined, { plannerDeadlineMin: 0 })).toBe(0);
    expect(resolveSubagentDeadlineMin("planner", undefined, { plannerDeadlineMin: 12 })).toBe(12);
    expect(resolveSubagentDeadlineMin("PLANNER", undefined, { plannerDeadlineMin: 10 })).toBe(10);
  });

  it("其他角色未配置=不限时(旧口径)", () => {
    expect(resolveSubagentDeadlineMin("worker", undefined, {})).toBe(0);
    expect(resolveSubagentDeadlineMin("explore", undefined, {})).toBe(0);
    expect(resolveSubagentDeadlineMin(undefined, undefined, {})).toBe(0);
  });
});

/**
 * P1-4 产出纪律强制提醒(2026-10-29):连续 25 步只调工具、零文本 → 下一次请求注入 [产出纪律] 块;
 * 每 25 步最多一次;已产出过文本=不再提醒(negative,不打断正常推进)。
 * 判据=message.agent.payload.text 为空;通道=tips(ephemeral,与 deadlineWarn 同机制)。
 */
describe("产出纪律硬注入(P1-4)", () => {
  /** 脚本化 LLM:记录每次 chat 是否带 [产出纪律] 块 + 调用序号。 */
  function probe(pick: (i: number) => { content: string; toolCalls?: { id: string; name: string; arguments: string }[] }) {
    const nudgedAt: number[] = [];
    const state = { calls: 0 };
    const llm = {
      async chat(m: { content?: string }[]) {
        if (m.some((x) => String(x.content ?? "").includes("[产出纪律]"))) nudgedAt.push(state.calls);
        const r = pick(state.calls);
        state.calls++;
        return r;
      },
    } as never;
    return { llm, nudgedAt, state };
  }

  it("连续 25 步零文本 → 第 26 次请求注入 [产出纪律];第 51 次再注入一次(共 2 次)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-nudge-"));
    const call = () => ({ content: "", toolCalls: [{ id: "c", name: "list_dir", arguments: JSON.stringify({ path: dir }) }] });
    const { llm, nudgedAt, state } = probe((i) => (i < 60 ? call() : { content: "最终报告:勘察完成,证据见 file:line。" }));
    const backend = new LlmLoopBackend({ llm, roots: [dir], workdir: dir, role: "explore" });
    const results: { ok: boolean; finalText?: string }[] = [];
    await backend.spawn({ taskId: "nudge", instructions: "勘察目录", workdir: dir, permissions: "readonly" }, (e) => { if (e.type === "result") results.push(e.result); });
    await new Promise((r) => setTimeout(r, 4000));
    expect(state.calls).toBe(61);
    expect(nudgedAt).toEqual([25, 50]);
    expect(results[0]?.ok).toBe(true);
  }, 30_000);

  it("negative:持续有实质产出(每步 ≥200 字)时永不注入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-nudge-neg-"));
    const call = () => ({ content: "", toolCalls: [{ id: "c", name: "list_dir", arguments: JSON.stringify({ path: dir }) }] });
    // 每步都给 ≥200 字实质结论(同时继续干活)→ pending 恒清零 → 永不注入。
    const substantive = "阶段性结论:已完成核对,证据逐条落账,file:line 见上。" .repeat(10);
    const { llm, nudgedAt } = probe((i) => (i < 40
      ? { content: substantive, toolCalls: call().toolCalls }
      : { content: "最终报告:核对完毕。" }));
    const backend = new LlmLoopBackend({ llm, roots: [dir], workdir: dir, role: "explore" });
    const results: { ok: boolean; finalText?: string }[] = [];
    await backend.spawn({ taskId: "nudge-neg", instructions: "勘察目录", workdir: dir, permissions: "readonly" }, (e) => { if (e.type === "result") results.push(e.result); });
    await new Promise((r) => setTimeout(r, 4000));
    expect(nudgedAt).toEqual([]);
    expect(results[0]?.ok).toBe(true);
  }, 30_000);

  it("2026-10-30 修永久锁:第 0 步只给一行短文(非实质产出),之后零文本 → 仍注入", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p14-nudge-lock-"));
    const call = () => ({ content: "", toolCalls: [{ id: "c", name: "list_dir", arguments: JSON.stringify({ path: dir }) }] });
    // 旧实现:`p.text.trim()` 非空即 seenText=true → 闸门永久焊死,一个都不触发。
    // 实测今日 18 个大 run 里 16 个「有文本步 <15%」却全不触发,最高 89 步零产出。
    const { llm, nudgedAt } = probe((i) => (i === 0
      ? { content: "我先看看目录。", toolCalls: call().toolCalls }
      : i < 35 ? call() : { content: "最终报告:" + "证据已核。".repeat(50) }));
    const backend = new LlmLoopBackend({ llm, roots: [dir], workdir: dir, role: "explore" });
    const results: { ok: boolean; finalText?: string }[] = [];
    await backend.spawn({ taskId: "nudge-lock", instructions: "勘察目录", workdir: dir, permissions: "readonly" }, (e) => { if (e.type === "result") results.push(e.result); });
    await new Promise((r) => setTimeout(r, 4000));
    expect(nudgedAt.length, "一行短文不得永久关闸").toBeGreaterThanOrEqual(1);
    expect(results[0]?.ok).toBe(true);
  }, 30_000);
});
