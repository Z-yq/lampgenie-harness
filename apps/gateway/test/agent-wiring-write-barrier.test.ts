/**
 * config.agent.writeBarrier 从 gateway 装配面透传到 AgentLoop 的回归锚(2026-11 验收)。
 * 契约:
 * a.wireBarrierOf 是装配层唯一取值口径:只认 "off"/"hard",其它值/缺席 → undefined
 *   (undefined = 不写键,把缺省留给 loop 内部的 hard = 现状行为);不读 env。
 * b.真跑 loop 证明 config off 生效:journal.flushStrict 抛错时工具**仍被执行**(屏障关掉)。
 * c.对照组 hard:同条件工具**不**执行(证明上面那条判据有辨别力,不是恒真断言)。
 * d.静态断言(llm-loop-backend 首跑+重派两处 / super-agent / agent-wiring 主构造点):
 *   口径=源码静态断言,非端到端 —— 装配面链路起不来(需真 provider/executor),
 *   故用「源码必须含传递式」把断线钉死,行为面由 b/c 的 loop 级用例兜。
 * env 说明:GENIE_WRITE_BARRIER 由 loop 内部**优先于** opts 解析(见
 * packages/harness-runtime/test/agent-loop-write-barrier.test.ts:150 一带),测试环境若残留
 * 会掩盖 opts 的效果 —— 故块首先 delete,块末恢复原值。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryJournal } from "@lampgenie/core";
import type { Journal, NewEvent, JournalEvent, EventListener } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Tool } from "@lampgenie/runtime/agent/loop";
import { writeBarrierOf } from "../src/agent-wiring.js";

const savedEnv = process.env["GENIE_WRITE_BARRIER"];
beforeEach(() => { delete process.env["GENIE_WRITE_BARRIER"]; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env["GENIE_WRITE_BARRIER"];
  else process.env["GENIE_WRITE_BARRIER"] = savedEnv;
});

/** 可控假 journal:记录 flushStrict 调用次数;failFrom 之后每次抛错(模拟磁盘写不下去)。
 *  组合而非继承(与 runtime 侧同名测试同法):core 类型面经 dist 解析,委托更稳。 */
class BarrierJournal implements Journal {
  private inner = new MemoryJournal();
  strictCalls = 0;
  failFrom = Number.POSITIVE_INFINITY;
  flushStrict(): void {
    this.strictCalls += 1;
    if (this.strictCalls >= this.failFrom) throw new Error("ENOSPC: no space left on device");
  }
  append<T>(event: NewEvent<T>): JournalEvent<T> { return this.inner.append(event); }
  appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[] { return this.inner.appendMany(events); }
  readAll(sinceSeq?: number): JournalEvent[] { return this.inner.readAll(sinceSeq); }
  readSession(sessionId: string, sinceSeq?: number): JournalEvent[] { return this.inner.readSession(sessionId, sinceSeq); }
  subscribe(listener: EventListener): () => void { return this.inner.subscribe(listener); }
  get length(): number { return this.inner.length; }
}

const mkTool = (name: string, exec: () => Promise<string>): Tool => ({
  name, description: "d", parameters: { type: "object", properties: {} },
  isConcurrencySafe: () => true,
  execute: exec,
});

/** 第一轮要求调 act,第二轮给最终答案。 */
function scriptedLlm(onChat: () => void): LlmProvider {
  let round = 0;
  return {
    async chat() {
      onChat();
      round++;
      if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "act", arguments: "{}" }] };
      return { content: "done" };
    },
  };
}

const src = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("writeBarrierOf(装配层取值口径)", () => {
  it("off/hard 原样透传;{} / undefined / {agent:{}} → undefined(缺省留给 loop)", () => {
    expect(writeBarrierOf({ agent: { writeBarrier: "off" } })).toBe("off");
    expect(writeBarrierOf({ agent: { writeBarrier: "hard" } })).toBe("hard");
    expect(writeBarrierOf({})).toBeUndefined();
    expect(writeBarrierOf(undefined)).toBeUndefined();
    expect(writeBarrierOf({ agent: {} })).toBeUndefined();
  });

  it("非法值不猜(拼错/非字符串 → undefined,不 fail-closed 也不误关屏障)", () => {
    expect(writeBarrierOf({ agent: { writeBarrier: "nope" as unknown as "off" } })).toBeUndefined();
    expect(writeBarrierOf({ agent: { writeBarrier: "" as unknown as "off" } })).toBeUndefined();
  });
});

describe("config off → 真跑 loop:flushStrict 抛错也照常执行工具", () => {
  it("writeBarrierOf 取到 off → 工具执行一次,flushStrict 零调用", async () => {
    const writeBarrier = writeBarrierOf({ agent: { writeBarrier: "off" } });
    const journal = new BarrierJournal();
    journal.failFrom = 1; // 一旦被调用必炸
    let executed = 0;
    const loop = new AgentLoop({
      journal, sessionId: "gw-wb-off", system: "s",
      ...(writeBarrier ? { writeBarrier } : {}),
      llm: scriptedLlm(() => {}),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    expect(await loop.runTurn("go")).toBe("done");
    expect(executed).toBe(1);
    expect(journal.strictCalls).toBe(0);
  });

  it("对照组 writeBarrier: \"hard\" 同条件 → 工具不执行(turn 以 [写前屏障] 失败)", async () => {
    const writeBarrier = writeBarrierOf({ agent: { writeBarrier: "hard" } });
    const journal = new BarrierJournal();
    journal.failFrom = 1;
    let executed = 0;
    const loop = new AgentLoop({
      journal, sessionId: "gw-wb-hard", system: "s",
      ...(writeBarrier ? { writeBarrier } : {}),
      llm: scriptedLlm(() => {}),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    let err: unknown;
    try { await loop.runTurn("go"); } catch (e) { err = e; }
    expect((err as Error).message).toContain("[写前屏障]");
    expect(executed).toBe(0);
    expect(journal.strictCalls).toBeGreaterThan(0);
  });
});

describe("静态断言:装配面四处都挂上了 writeBarrier(口径=源码静态断言,非端到端)", () => {
  it("llm-loop-backend 首跑+重派两处 / super-agent / agent-wiring 主构造点都有传递式", () => {
    const backend = src("../src/llm-loop-backend.ts");
    expect(backend.match(/this\.opts\.writeBarrier/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(backend).toContain("writeBarrier?: \"off\" | \"hard\";");

    const superAgent = src("../src/super-agent.ts");
    expect(superAgent).toContain("deps.writeBarrier");
    expect(superAgent).toContain("writeBarrier?: \"off\" | \"hard\";");

    const wiring = src("../src/agent-wiring.ts");
    expect(wiring).toContain("writeBarrierOf(agentConfig)");
    // 子代理后端与主构造点两处装配(主点=局部 const,子代理点=直接取值)
    expect(wiring.match(/writeBarrierOf\(agentConfig\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(wiring).toContain("...(writeBarrier ? { writeBarrier } : {})");

    const app = src("../src/app.ts");
    expect(app).toContain("writeBarrierOf(");
    expect(app).toContain("writeBarrier: writeBarrierOf(");
  });
});
