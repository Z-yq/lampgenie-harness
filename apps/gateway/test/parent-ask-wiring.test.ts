/**
 * step-071 父子 ask-answer 接线锚(llm-loop-backend.parentAsk):子代理 run_cmd 重操作命中
 * →onHeavyAsk→parentAsk 回调(生产=ParentAskBroker.ask);批准放行/拒绝阻断/轻命令不过闸。
 * 生产 agent-wiring 构造形态(parentAsk 直通 broker.ask)同构锚定。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmLoopBackend } from "../src/llm-loop-backend.js";
import { ParentAskBroker } from "@lampgenie/runtime/agent/parent-ask-broker";

function fakeLlm(script: Array<{ content: string; toolCalls?: { id: string; name: string; arguments: string }[] }>) {
  let i = 0;
  return { async chat() { const r = script[Math.min(i, script.length - 1)]!; i++; return r; } } as never;
}

/** 后端驱动:spawn 后轮询 result(与 llm-loop-backend.test 同款形态)。 */
async function runBackend(backend: LlmLoopBackend, taskId: string, dir: string) {
  let result: { ok: boolean; finalText?: string; error?: { kind?: string } } | undefined;
  const handle = await backend.spawn({ taskId, instructions: "做任务", workdir: dir, permissions: "sandbox" }, (e) => { if (e.type === "result") result = e.result; });
  for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 100));
  return { result, handle };
}

describe("llm-loop-backend parentAsk(step-071 父子 ask-answer 接线)", () => {
  it("批准分支:build 命令被闸拦→broker.ask→父批准→真实执行;journal 问答成对", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-ok-"));
    const broker = new ParentAskBroker();
    broker.onPending = (q) => { setImmediate(() => broker.answer(q.requestId, { approved: true, reason: "任务需要" })); };
    const backend = new LlmLoopBackend({
      llm: fakeLlm([
        { content: "构建", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "pnpm build" }) }] },
        { content: "构建完成" },
      ]),
      roots: [dir], workdir: dir, role: "worker",
      // 生产 agent-wiring 同构:parentAsk 直通 broker.ask
      parentAsk: (input) => broker.ask(input),
    });
    const { result } = await runBackend(backend, "pa-ok-1", dir);
    expect(result?.ok).toBe(true);
    expect(result?.finalText).toContain("构建完成");
  }, 20_000);

  it("拒绝分支:父拒绝→命令不执行,拒绝语义回流", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-no-"));
    const broker = new ParentAskBroker();
    broker.onPending = (q) => { setImmediate(() => broker.answer(q.requestId, { approved: false, reason: "资源紧张" })); };
    const backend = new LlmLoopBackend({
      llm: fakeLlm([
        { content: "构建", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "tsc -b" }) }] },
        { content: "报告:构建被父代理拒绝(资源紧张),未执行" },
      ]),
      roots: [dir], workdir: dir, role: "worker",
      parentAsk: (input) => broker.ask(input),
    });
    const { result } = await runBackend(backend, "pa-no-1", dir);
    expect(result?.ok).toBe(true); // 子代理如实报告拒绝,任务可收口
    expect(result?.finalText).toContain("拒绝");
    const asks = broker.pending();
    expect(asks).toHaveLength(0); // 已应答了结
  }, 20_000);

  it("轻命令不过闸:grep 直通(parentAsk 永不被调)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pa-light-"));
    let asked = 0;
    const backend = new LlmLoopBackend({
      llm: fakeLlm([
        { content: "检索", toolCalls: [{ id: "c1", name: "run_cmd", arguments: JSON.stringify({ command: "echo hi" }) }] },
        { content: "完成" },
      ]),
      roots: [dir], workdir: dir, role: "worker",
      parentAsk: (input) => { asked++; return Promise.resolve({ approved: false, by: "parent-llm" }); },
    });
    const { result } = await runBackend(backend, "pa-light-1", dir);
    expect(result?.ok).toBe(true);
    expect(asked).toBe(0);
  }, 20_000);
});
