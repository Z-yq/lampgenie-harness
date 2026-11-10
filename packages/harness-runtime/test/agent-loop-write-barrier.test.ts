/**
 *  写前持久化屏障(loop 侧):工具执行前 / LLM 请求前 flushStrict 失败即 fail-closed。
 * 断言语义:
 * ①flushStrict 抛错 → 工具**未执行**,tool.result 写固定错误框(含原因),turn 以 [写前屏障] 失败;
 * ②flushStrict 成功 → 工具正常执行,且 flush 发生在 execute 之前(顺序断言);
 * ③LLM 请求前 flushStrict 抛错 → provider 未被调用;
 * ④writeBarrier=off → 完全不调 flushStrict(旧行为);
 * ⑤lastFlushedSeq:同 step 无新 append 不重复 flush,append 后再次 flush;取消在 flush 前返回 cancelled;
 * ⑥journal 无 flushStrict(旧/假 journal)→ no-op,零回归。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import type { Journal, NewEvent, JournalEvent, EventListener } from "@lampgenie/core";
import { AgentLoop, type LlmProvider, type Tool } from "../src/agent/loop";

/** 可控的假 journal:记录 flushStrict 调用次数,failFrom 之后每次抛错。
 *  用组合而非继承 MemoryJournal:@lampgenie/core 的类型面经 dist 解析,基类未导出时
 *  子类成员不可见(TS2339),委托更稳。 */
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

/** 第一轮要求调工具,第二轮给最终答案。 */
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

const savedEnv = process.env["GENIE_WRITE_BARRIER"];
beforeEach(() => { delete process.env["GENIE_WRITE_BARRIER"]; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env["GENIE_WRITE_BARRIER"];
  else process.env["GENIE_WRITE_BARRIER"] = savedEnv;
});

describe("AgentLoop 写前屏障(工具执行前)", () => {
  it("flushStrict 抛错:工具未执行,tool.result 为固定错误框(含原因),turn 以 [写前屏障] 失败", async () => {
    const journal = new BarrierJournal();
    journal.failFrom = 2; // 第 1 次(LLM 前)成功,第 2 次(工具前)失败
    let executed = 0;
    let chats = 0;
    const loop = new AgentLoop({
      journal, sessionId: "wb-1", system: "s",
      llm: scriptedLlm(() => { chats += 1; }),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    let err: unknown;
    try { await loop.runTurn("go"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("[写前屏障]");
    expect(executed).toBe(0); // 工具未被调用
    expect(chats).toBe(1); // 只发生了工具前那次 LLM 调用
    const results = journal.readAll().filter((e) => e.kind === "tool.result");
    expect(results).toHaveLength(1);
    const content = String((results[0]!.payload as { content: string }).content);
    expect(content).toContain("[写前屏障] journal 落盘失败");
    expect(content).toContain("ENOSPC");
    expect(content).toContain("已阻止工具执行");
    const error = (results[0]!.payload as { error?: { origin?: string } }).error;
    expect(error?.origin).toBe("write-barrier");
 // 事件:turn.end reason=write-barrier
    const turnEnds = journal.readAll().filter((e) => e.kind === "turn.end");
    expect((turnEnds[turnEnds.length - 1]!.payload as { reason: string }).reason).toBe("write-barrier");
  });

  it("flushStrict 成功:工具正常执行,且 flush 发生在 execute 之前(顺序断言)", async () => {
    const journal = new BarrierJournal();
    const order: string[] = [];
    const origFlush = journal.flushStrict.bind(journal);
    journal.flushStrict = () => { order.push("flush"); origFlush(); };
    const loop = new AgentLoop({
      journal, sessionId: "wb-2", system: "s",
      llm: scriptedLlm(() => { order.push("chat"); }),
      tools: [mkTool("act", async () => { order.push("execute"); return "ok"; })],
    });
    const out = await loop.runTurn("go");
    expect(out).toBe("done");
    expect(order).toContain("execute");
    const execAt = order.indexOf("execute");
    expect(order.lastIndexOf("flush", execAt)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("flush")).toBeLessThan(execAt); // 首次 flush(LLM 前)早于 execute
  });
});

describe("AgentLoop 写前屏障(LLM 请求前)", () => {
  it("flushStrict 抛错:provider 未被调用,turn 以 [写前屏障] 失败", async () => {
    const journal = new BarrierJournal();
    journal.failFrom = 1; // 第一次(LLM 前)就失败
    let chats = 0;
    const loop = new AgentLoop({
      journal, sessionId: "wb-3", system: "s",
      llm: scriptedLlm(() => { chats += 1; }),
      tools: [mkTool("act", async () => "ok")],
    });
    let err: unknown;
    try { await loop.runTurn("go"); } catch (e) { err = e; }
    expect((err as Error).message).toContain("[写前屏障]");
    expect(chats).toBe(0); // provider 未被调用
    expect(journal.readAll().filter((e) => e.kind === "tool.result")).toHaveLength(0);
  });

  it("writeBarrier=off:完全不调 flushStrict,行为旧版", async () => {
    const journal = new BarrierJournal();
    journal.failFrom = 1; // 若被调用必炸
    let executed = 0;
    const loop = new AgentLoop({
      journal, sessionId: "wb-4", system: "s", writeBarrier: "off",
      llm: scriptedLlm(() => {}),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    const out = await loop.runTurn("go");
    expect(out).toBe("done");
    expect(executed).toBe(1);
    expect(journal.strictCalls).toBe(0);
  });

  it("env GENIE_WRITE_BARRIER=off 优先于 opts(hard)", async () => {
    process.env["GENIE_WRITE_BARRIER"] = "off";
    const journal = new BarrierJournal();
    journal.failFrom = 1;
    const loop = new AgentLoop({
      journal, sessionId: "wb-5", system: "s", writeBarrier: "hard",
      llm: scriptedLlm(() => {}),
      tools: [mkTool("act", async () => "ok")],
    });
    expect(await loop.runTurn("go")).toBe("done");
    expect(journal.strictCalls).toBe(0);
  });
});

describe("AgentLoop 写前屏障(async flushStrict: 生产态 RPC ack)", () => {
  /** flushStrict 返回 Promise 的 journal(worker ProxyJournal 形态)。 */
  class AsyncJournal implements Journal {
    private inner = new MemoryJournal();
    strictCalls = 0;
    mode: "resolve" | "reject" = "resolve";
    order: string[] = [];
    async flushStrict(): Promise<void> {
      this.strictCalls += 1;
      this.order.push("flush:start");
      await Promise.resolve();
      this.order.push("flush:end");
      if (this.mode === "reject") throw new Error("journal flushStrict failed: host 通道不可用");
    }
    append<T>(event: NewEvent<T>): JournalEvent<T> { return this.inner.append(event); }
    appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[] { return this.inner.appendMany(events); }
    readAll(sinceSeq?: number): JournalEvent[] { return this.inner.readAll(sinceSeq); }
    readSession(sessionId: string, sinceSeq?: number): JournalEvent[] { return this.inner.readSession(sessionId, sinceSeq); }
    subscribe(listener: EventListener): () => void { return this.inner.subscribe(listener); }
    get length(): number { return this.inner.length; }
  }

  it("async flushStrict reject:工具未执行(与同步 throw 同语义:固定错误框 + turn 收口)", async () => {
    const journal = new AsyncJournal();
    journal.mode = "reject";
    let executed = 0;
    let chats = 0;
    const loop = new AgentLoop({
      journal, sessionId: "wb-a1", system: "s",
      llm: scriptedLlm(() => { chats += 1; }),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    let err: unknown;
    try { await loop.runTurn("go"); } catch (e) { err = e; }
    expect((err as Error).message).toContain("[写前屏障]");
    expect(executed).toBe(0);
    expect(chats).toBe(0); // 第一次(LLM 前)就 reject → provider 未被调用
    const turnEnds = journal.readAll().filter((e) => e.kind === "turn.end");
    expect((turnEnds[turnEnds.length - 1]!.payload as { reason: string }).reason).toBe("write-barrier");
  });

  it("async flushStrict resolve:工具执行,且 await 到 flush:end 之后才 execute(顺序断言)", async () => {
    const journal = new AsyncJournal();
    const order: string[] = [];
    journal.order = order;
    const loop = new AgentLoop({
      journal, sessionId: "wb-a2", system: "s",
      llm: scriptedLlm(() => { order.push("chat"); }),
      tools: [mkTool("act", async () => { order.push("execute"); return "ok"; })],
    });
    expect(await loop.runTurn("go")).toBe("done");
    // flush 次数 ≥2(LLM 前 + 工具前;后续 step 有新 append 时还会再 flush)——顺序断言才是重点。
    expect(order.filter((x) => x === "flush:end").length).toBeGreaterThanOrEqual(2);
    const execAt = order.indexOf("execute");
    expect(execAt).toBeGreaterThan(order.lastIndexOf("flush:end", execAt));
    expect(order[order.indexOf("chat") - 1]).toBe("flush:end"); // provider 调用前已 ack 完毕
  });
});

describe("AgentLoop 写前屏障(lastFlushedSeq 复用 / 取消 / 无 flushStrict)", () => {
  it("同 step 无新 append 不重复 flush;append 后再次 flush", async () => {
    const journal = new BarrierJournal();
    const loop = new AgentLoop({ journal, sessionId: "wb-6", system: "s", llm: scriptedLlm(() => {}) });
    const call = (loop as unknown as { writeBarrier(kind: "llm" | "tool", signal?: AbortSignal): Promise<{ ok: boolean }> }).writeBarrier.bind(loop);
    expect(await call("llm")).toEqual({ ok: true });
    expect(journal.strictCalls).toBe(1);
    // 其间无 append → 复用上次检查点
    expect(await call("llm")).toEqual({ ok: true });
    expect(journal.strictCalls).toBe(1);
    // 新 append → 水位变化 → 再 flush
    journal.append({ kind: "custom", sessionId: "wb-6", payload: { what: "x" } });
    expect(await call("tool")).toEqual({ ok: true });
    expect(journal.strictCalls).toBe(2);
  });

  it("flush 前已取消:返回 cancelled 码且不调 flushStrict", async () => {
    const journal = new BarrierJournal();
    const loop = new AgentLoop({ journal, sessionId: "wb-7", system: "s", llm: scriptedLlm(() => {}) });
    const call = (loop as unknown as { writeBarrier(kind: "llm" | "tool", signal?: AbortSignal): Promise<{ ok: boolean; cancelled?: boolean }> }).writeBarrier.bind(loop);
    const ac = new AbortController();
    ac.abort();
    expect(await call("tool", ac.signal)).toEqual({ ok: false, cancelled: true });
    expect(journal.strictCalls).toBe(0);
  });

  it("journal 无 flushStrict(旧/假 journal)→ 视为成功(no-op),turn 正常", async () => {
    const journal = new MemoryJournal();
    delete (journal as unknown as { flushStrict?: () => void }).flushStrict;
    let executed = 0;
    const loop = new AgentLoop({
      journal, sessionId: "wb-8", system: "s",
      llm: scriptedLlm(() => {}),
      tools: [mkTool("act", async () => { executed += 1; return "ok"; })],
    });
    expect(await loop.runTurn("go")).toBe("done");
    expect(executed).toBe(1);
  });
});
