/**
 * 子代理卡死治理四件套的后端侧(2026-10-15「subagent 很容易卡住不返回」根治):
 * 机制1 spawn deadline 到点强制收割(部分结果交付,与用户取消=丢弃语义分离);
 * 机制2 心跳 flush(节流,时间戳+工具名);机制3 无产出预警([warn] 行)。
 * 直接驱动 LlmLoopBackend(同 llm-loop-backend.test.ts 形态,不起网关)。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";

type FakeResp = { content: string; toolCalls?: { id: string; name: string; arguments: string }[] };

/** 第一步真调工具、随后挂死的 LLM(可响应 abort=诚实提供者;测试收割/取消走快速路径)。 */
function hangAfterOneTool(opts?: { ignoreAbort?: boolean }) {
  let i = 0;
  return { async chat(_m: unknown, _t: unknown, sig?: AbortSignal): Promise<FakeResp> {
    i++;
    if (i === 1) return { content: "第一步:检索", toolCalls: [{ id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "anything" }) }] };
    return await new Promise<FakeResp>((_, rej) => {
      if (opts?.ignoreAbort) return; // 永不落:挂死提供者(预警测试;stall watchdog 600s 不会在测试窗触发)
      sig?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    });
  } } as never;
}

function newBackend(llm: unknown, extra: Partial<ConstructorParameters<typeof LlmLoopBackend>[0]> = {}): LlmLoopBackend {
  const dir = mkdtempSync(join(tmpdir(), "sub-ka-"));
  return new LlmLoopBackend({ llm: llm as never, roots: [dir], workdir: dir, role: "explore", ...extra });
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, stepMs = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("机制1:spawn deadline 到点强制收割", () => {
  it("到点=子 loop 收中止+部分结果打包交付(ok=true,显式标注,非失败)", async () => {
    const progressNotes: string[] = [];
    let result: { ok?: boolean; finalText?: string; note?: string; error?: { kind?: string } } | undefined;
    const backend = newBackend(hangAfterOneTool(), { deadlineMs: 600, deadlineGraceMs: 5_000, heartbeatMs: 50 });
    await backend.spawn({ taskId: "dl1", instructions: "长调查任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "progress") progressNotes.push(e.note);
      if (e.type === "result") result = e.result as typeof result;
    });
    await waitFor(() => result, 6_000);
    expect(result!.ok, "收割不是 fail——是交付已有进展").toBe(true);
    expect(result!.finalText).toContain("[deadline 收割]");
    expect(result!.finalText).toContain("非最终结论");
    expect(result!.finalText).toContain("1 次工具调用");
    expect(result!.note).toContain("部分结果");
    expect(progressNotes.some((n) => n.includes("[deadline] 时间盒到")), "收割动作应可观测").toBe(true);
  }, 15_000);

  it("用户取消=丢弃语义:ok=false cancelled,无 deadline 收割标注(与死线交付分离)", async () => {
    let result: { ok?: boolean; finalText?: string; error?: { kind?: string } } | undefined;
    const backend = newBackend(hangAfterOneTool(), { heartbeatMs: 50 });
    const handle = await backend.spawn({ taskId: "dl2", instructions: "会被用户取消的任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "result") result = e.result as typeof result;
    });
    await new Promise((r) => setTimeout(r, 400)); // 等第一步工具跑完,进入挂死 LLM 调用
    await handle.cancel("user");
    await waitFor(() => result, 6_000);
    expect(result!.ok).toBe(false);
    expect(result!.error?.kind).toBe("cancelled");
    expect(result!.finalText ?? "").not.toContain("[deadline 收割]");
  }, 15_000);

  it("不设 deadline:不限时,收割路径不触发(自然挂死由 stall watchdog 兜底,测试窗内零 result)", async () => {
    let result: unknown;
    const backend = newBackend(hangAfterOneTool({ ignoreAbort: true }), {});
    await backend.spawn({ taskId: "dl3", instructions: "无时间盒任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "result") result = e.result;
    });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(result, "无 deadline 不应提前收割(stall 阈值 600s 远在测试窗外)").toBeUndefined();
  }, 10_000);
});

describe("机制2:子代理进度心跳(节流 flush)", () => {
  it("step/tool 节点出 [心跳 时间戳] 行;节流窗内合并(不把慢盘打爆)", async () => {
    let i = 0;
    const llm = { async chat(): Promise<FakeResp> {
      i++;
      if (i <= 3) return { content: `step${i}`, toolCalls: [{ id: "s" + i, name: "grep", arguments: JSON.stringify({ pattern: "x" }) }] };
      return { content: "最终报告" };
    } } as never;
    const notes: string[] = [];
    const backend = newBackend(llm, { heartbeatMs: 1_000 }); // 1s 节流窗:同步假 LLM 的 13 个 journal 节点几乎必然落进同一窗
    await backend.spawn({ taskId: "hb1", instructions: "心跳任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "progress") notes.push(e.note);
    });
    await new Promise((r) => setTimeout(r, 800));
    const beats = notes.filter((n) => n.startsWith("[心跳 "));
    expect(beats.length, "至少首条必发心跳").toBeGreaterThanOrEqual(1);
    expect(beats.length, "节流:16 个活动节点至多 3 条心跳(慢盘写放大治理;同步假 LLM 全程 <1s 窗)").toBeLessThanOrEqual(3);
    // loop 事件序:step.start 先于 tool.call → 首条心跳是「第 0 步开始」;时间戳格式逐条校验
    expect(beats[0]).toMatch(/\[心跳 \d{2}:\d{2}:\d{2}\] 第 0 步开始/);
  }, 15_000);
});

describe("机制3:无产出预警([warn])", () => {
  it("超 staleWarnMs 无新工具调用→[warn] 无进展 N 分钟", async () => {
    const notes: string[] = [];
    const backend = newBackend(hangAfterOneTool({ ignoreAbort: true }), { staleWarnMs: 300, heartbeatMs: 50 });
    const handle = await backend.spawn({ taskId: "st1", instructions: "会停滞的任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "progress") notes.push(e.note);
    });
    await waitFor(() => notes.find((n) => n.includes("[warn] 无进展")), 5_000);
    const warn = notes.find((n) => n.includes("[warn] 无进展"))!;
    expect(warn).toMatch(/\[warn\] 无进展 \d+ 分钟\(自上次工具调用 \d{2}:\d{2}:\d{2}\)/);
    await handle.cancel("user"); // 静默预警定时器(挂死 chat 由 stall watchdog 兜底,测试不需其 result)
  }, 15_000);

  it("有产出则不预警:持续工具活动的子代理零 [warn](测试窗 1.2s,staleWarnMs=300ms 的幂等窗不命中)", async () => {
    let i = 0;
    const llm = { async chat(): Promise<FakeResp> {
      i++;
      if (i <= 3) return { content: `step${i}`, toolCalls: [{ id: "s" + i, name: "grep", arguments: JSON.stringify({ pattern: "x" }) }] };
      return { content: "最终报告" };
    } } as never;
    const notes: string[] = [];
    const backend = newBackend(llm, { staleWarnMs: 300, heartbeatMs: 5_000 });
    await backend.spawn({ taskId: "st2", instructions: "正常任务", workdir: tmpdir(), permissions: "readonly" }, (e) => {
      if (e.type === "progress") notes.push(e.note);
    });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(notes.some((n) => n.includes("[warn]")), "持续产出不预警").toBe(false);
  }, 15_000);
});
