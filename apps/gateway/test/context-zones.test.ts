/** 上下文温度三区派生测试(数据链,白板节点 n1)。
 * 真实 deriveMessages 经动态 import 拉入整个 loop.ts 模块链(内部 ./stream-anchor 等
 * 子模块在 vitest/直跑环境缺 node_modules 解析),单测环境下不可稳定构造——按任务书预案,
 * 把切分/统计/尾扫拆成纯函数直测,入口函数只测「空会话/非法 journal → null」与
 * 模块 mock 的失败路径。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { partitionZones, zoneStatsOf, frozenCountOf, deriveContextZones, openChainScanOf, afterTraceStartOf } from "../src/context-zones.js";

beforeEach(() => vi.resetModules());

describe("partitionZones 纯切分", () => {
  it("①正常三分:frozen=2,N=2,total=6 → cold 2/warm 2/hot 2", () => {
    const { coldEnd, hotStart } = partitionZones(6, 2, 2);
    expect(coldEnd).toBe(2);
    expect(hotStart).toBe(4);
    expect(6 - hotStart).toBe(2); // hot 条数
    expect(hotStart - coldEnd).toBe(2); // warm 条数
  });
  it("②frozenCount 越界:frozen=10>total=3 → 冷区=全部,热区让渡为 0", () => {
    const { coldEnd, hotStart } = partitionZones(3, 10, 2);
    expect(coldEnd).toBe(3);
    expect(hotStart).toBe(3); // max(coldEnd, total-N)=max(3,1)=3 → hot 0 条
  });
  it("N 越界(frozen=0,N=10>total=3)→ 热区=全部,cold 0", () => {
    const { coldEnd, hotStart } = partitionZones(3, 0, 10);
    expect(coldEnd).toBe(0);
    expect(hotStart).toBe(0);
  });
  it("③无 prune:frozen=0 → cold 0", () => {
    expect(partitionZones(5, 0, 2).coldEnd).toBe(0);
  });
  it("负数输入钳 0(脏数据防御)", () => {
    expect(partitionZones(5, -3, -1)).toEqual({ coldEnd: 0, hotStart: 6 - 1 + 0 });
  });
});

describe("frozenCountOf 尾扫(journal 恢复语义,loop.ts seedPruneState 同款)", () => {
  it("取最后一条带数字 frozenCount 的 context.prune", () => {
    const ev = [
      { kind: "context.prune", payload: { frozenCount: 1 } },
      { kind: "message.agent", payload: { text: "x" } },
      { kind: "context.prune", payload: { frozenCount: 3 } },
    ];
    expect(frozenCountOf(ev)).toEqual({ frozenCount: 3, frozenFrom: "context.prune" });
  });
  it("③无 context.prune → none/0;非数字 frozenCount 忽略", () => {
    expect(frozenCountOf([{ kind: "message.agent", payload: {} }])).toEqual({ frozenCount: 0, frozenFrom: "none" });
    expect(frozenCountOf([{ kind: "context.prune", payload: { frozenCount: "2" } }])).toEqual({ frozenCount: 0, frozenFrom: "none" });
    expect(frozenCountOf([])).toEqual({ frozenCount: 0, frozenFrom: "none" });
  });
  it("④尾扫方向:最后一条胜出(前一条不覆盖)", () => {
    const ev = [
      { kind: "context.prune", payload: { frozenCount: 5 } },
      { kind: "context.prune", payload: { frozenCount: 0 } },
    ];
    expect(frozenCountOf(ev).frozenCount).toBe(0);
  });
});

describe("zoneStatsOf 统计(④chars/4 估算)", () => {
  it("8 chars → estTokens 2;5 chars → round(5/4)=1(四舍五入非向下)", () => {
    const z = zoneStatsOf([{ content: "abcdefgh" }, { content: "wxyz" }], { coldEnd: 1, hotStart: 1 });
    expect(z.cold).toEqual({ messages: 1, chars: 8, estTokens: 2 });
    expect(z.warm).toEqual({ messages: 0, chars: 0, estTokens: 0 });
    expect(z.hot).toEqual({ messages: 1, chars: 4, estTokens: 1 });
    expect(zoneStatsOf([{ content: "abcde" }], { coldEnd: 0, hotStart: 0 }).hot.estTokens).toBe(1);
  });
  it("content 缺失/非字符串按空串计", () => {
    const z = zoneStatsOf([{}, { content: null }, { content: 123 }], { coldEnd: 0, hotStart: 0 });
    expect(z.hot).toEqual({ messages: 3, chars: 3, estTokens: 1 }); // "123".length=1,null→""
  });
});

describe("openChainScanOf 闭合边界扫描(热区口径:未闭合动作链)", () => {
 /** 场景:1 user + 11 连续 tool 链事件(agent 带 toolCalls ×6 + tool.result ×5)= 12 条派生消息全未闭合。 */
  const openChainEvents = (n: number) => {
    const ev: Array<{ kind?: unknown; payload?: unknown }> = [{ kind: "message.user", payload: { text: "指令" } }];
    for (let i = 0; i < n; i++) {
      ev.push({ kind: "message.agent", payload: { text: "call" + i, toolCalls: [{ id: "c" + i, name: "t" }] } });
      ev.push({ kind: "tool.result", payload: { toolCallId: "c" + i, content: "r" + i } });
    }
    return ev;
  };
  it("①12 条未闭合链(fixture=1 user+11 组 tool 链)→ openStart=0、全量热区", () => {
    const s = openChainScanOf(openChainEvents(6));
    expect(s.derivedTotal).toBe(13); // 1 user + 6 agent + 6 result
    expect(s.openStart).toBe(0);
    expect(s.openChains).toBe(1);
  });
  it("②agent 纯文本无 toolCalls=动作完成 → 自身降级温区,其后新链热区", () => {
    const s = openChainScanOf([
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "回答A" } }, // 闭合:纯文本
      { kind: "message.user", payload: { text: "B" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: { content: "r" } },
    ]);
    expect(s.derivedTotal).toBe(5);
    expect(s.openStart).toBe(2); // 最后一个 user(B)下标(0 起:user=0,agent=1,user=2)
    expect(s.openChains).toBe(1);
  });
  it("③context.prune 真实裁中(compacted>0/policy=reset)→ 此前全部闭合", () => {
    const s = openChainScanOf([
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: { content: "r" } },
      { kind: "context.prune", payload: { frozenCount: 1, compacted: 1, policy: "reset" } },
      { kind: "message.agent", payload: { text: "call2", toolCalls: [{ id: "c2" }] } },
      { kind: "tool.result", payload: { content: "r2" } },
    ]);
    expect(s.openStart).toBe(3); // prune 时 count=3 → 此后链消息从下标 3 起
    expect(s.openChains).toBe(1);
  });
  it("③b low-context-skip/append-only 不是闭合:不推进热区边界", () => {
    const s = openChainScanOf([
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: { content: "r" } },
      { kind: "context.prune", payload: { frozenCount: 0, compacted: 0, policy: "low-context-skip" } },
      { kind: "message.agent", payload: { text: "call2", toolCalls: [{ id: "c2" }] } },
      { kind: "tool.result", payload: { content: "r2" } },
    ]);
    expect(s.openStart).toBe(0); // 空操作不闭合:整条链仍开放
    expect(s.openChains).toBe(1);
  });
  it("③c 段闭合信号与 segment-tracker 对齐:turn.end / task.phase / path.abandoned 均闭合", () => {
    const base = [
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: { content: "r" } },
    ];
    expect(openChainScanOf([...base, { kind: "turn.end", payload: { turn: 0 } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "custom", payload: { type: "task.phase", phase: "implement" } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "custom", payload: { what: "task_phase" } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "custom", payload: { type: "context.path.abandoned" } }]).openStart).toBe(3);
 // 与 tracker 同口径的扩展信号:子代理终态 / 白板 done / goal_progress
    expect(openChainScanOf([...base, { kind: "subagent.event", payload: { status: "completed" } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "subagent.result", payload: { ok: true } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "board.update", payload: { status: "done" } }]).openStart).toBe(3);
    expect(openChainScanOf([...base, { kind: "custom", payload: { type: "goal_progress" } }]).openStart).toBe(3);
  });
  it("③d 工具目标漂移:同段三个不同目录根 → 热区在新工具调用处重开", () => {
    const s = openChainScanOf([
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] } },
      { kind: "tool.result", payload: { content: "r1" } },
      { kind: "tool.call", payload: { arguments: JSON.stringify({ path: "apps/gateway/src/a.ts" }) } },
      { kind: "tool.call", payload: { arguments: JSON.stringify({ path: "packages/runtime/src/b.ts" }) } },
      { kind: "tool.call", payload: { arguments: JSON.stringify({ path: "packages/wiki/src/c.ts" }) } },
      { kind: "tool.result", payload: { content: "r2" } },
    ]);
    expect(s.openStart).toBe(3); // 漂移点当前派生消息数=3;新段从其后热区起
    expect(s.openChains).toBe(1);
  });
  it("④user 新指令=主题切换:旧链闭合,新链从 user 起算", () => {
    const s = openChainScanOf([
      { kind: "message.user", payload: { text: "A" } },
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: {  content: "r" } },
      { kind: "message.user", payload: { text: "B(主题切换)" } },
      { kind: "message.agent", payload: { text: "call2", toolCalls: [{ id: "c2" }] } },
      { kind: "tool.result", payload: { content: "r2" } },
    ]);
    expect(s.openStart).toBe(3);
    expect(s.openChains).toBe(1);
  });
  it("⑤无闭合事件(罕见:agent 起手带 toolCalls)→ 防御分支起链", () => {
    const s = openChainScanOf([
      { kind: "message.agent", payload: { text: "call", toolCalls: [{ id: "c1" }] } },
      { kind: "tool.result", payload: { content: "r" } },
    ]);
    expect(s.openStart).toBe(0);
    openChainEvents(0); // 1 user fixture 冒烟
  });
});

describe("afterTraceStartOf 增量锚点(增量并入热区,全量划分)", () => {
  it("①最后一条 llm.trace 之后有增量消息 → 返回首条增量消息的事件下标", () => {
    const ev = [
      { kind: "message.user", payload: { text: "x".repeat(40) } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 100 } } },
      { kind: "tool.result", payload: { content: "y".repeat(20) } },
      { kind: "message.agent", payload: { text: "z".repeat(10) } },
    ];
    expect(afterTraceStartOf(ev)).toBe(2); // trace@1,其后首条增量消息@2
  });
  it("②无 llm.trace,或末条 trace 之后无增量消息 → null(不造数)", () => {
    expect(afterTraceStartOf([{ kind: "message.user", payload: { text: "a" } }])).toBeNull();
    expect(afterTraceStartOf([])).toBeNull();
    expect(afterTraceStartOf([{ kind: "llm.trace", payload: {} }])).toBeNull();
    expect(afterTraceStartOf([{ kind: "message.user", payload: {} }, { kind: "llm.trace", payload: {} }, { kind: "task.done", payload: {} }])).toBeNull();
  });
  it("③取最后一条 llm.trace(尾扫语义);trace 之间的非消息事件跳过", () => {
    const ev = [
      { kind: "message.user", payload: {} },
      { kind: "llm.trace", payload: {} },
      { kind: "message.agent", payload: {} },
      { kind: "llm.trace", payload: {} },
      { kind: "notice", payload: {} },
      { kind: "message.user", payload: {} },
    ];
    expect(afterTraceStartOf(ev)).toBe(5); // 最后 trace@3,跳过 notice,首条增量消息@5
  });
});

describe("deriveContextZones 入口", () => {
  it("空会话/非法 journal → null(不造数)", async () => {
    expect(await deriveContextZones({ readSession: () => [], readAll: () => [] }, "s1")).toBeNull();
    expect(await deriveContextZones(null, "s1")).toBeNull();
    expect(await deriveContextZones({} as never, "s1")).toBeNull();
  });

  it("⑤a loop 模块缺 deriveMessages 导出 → null", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({}));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    expect(await d({ readSession: () => [{ kind: "message.user", payload: { text: "a" } }], readAll: () => [] }, "s1", { hotTailNote: 1 })).toBeNull();
  });

  it("⑤b protection-windows 缺导出 → hotTailNote 回退 6;有导出 → 读 scoringHotTailMessages(仅小注,不参与切分)", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({})); // 缺导出=回退
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    const j = () => ({ readSession: () => [{ kind: "message.user", payload: {} }], readAll: () => Array.from({ length: 8 }) });
    const r = await d(j(), "s1");
    expect(r?.hotTailNote).toBe(6); // 6 只是小注(评分器保护窗),不切热区
    expect(r?.zones.hot.messages).toBe(8); // 8 条全部未闭合 → 全量热区
    expect(r?.zones.warm.messages).toBe(0); // 无闭合事件 → 温区为空
  });

  it("⑤b2 protection-windows 正常导出 → hotTailNote 读到 3,但热区仍=未闭合链(不受窗口影响)", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({
      PROTECTION_WINDOWS: { scoringHotTailMessages: 3 },
    }));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    const j = () => ({ readSession: () => [], readAll: () => Array.from({ length: 8 }) });
    const r = await d(j(), "s1");
    expect(r?.hotTailNote).toBe(3); // 小注=3
    expect(r?.zones.hot.messages).toBe(8); // 热区=未闭合链=全部(不是 3!)
    expect(r?.zones.warm.messages).toBe(0);
  });

  it("⑤d 12 条未闭合链 fixture:hot.messages=12 而非 6(任务书验收口径)", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({}));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
 // journal:1 user + 11 组 agent(toolCalls)/tool.result = 13 raw 事件 → 13 条派生消息全未闭合;
 // 最后再补一条纯文本 agent 闭合 → 未闭合链=该 agent 之后无 → 验证冷区优先+闭合降级。
    const events: Array<{ kind?: unknown; payload?: unknown }> = [{ kind: "message.user", payload: { text: "指令" } }];
    for (let i = 0; i < 6; i++) {
      events.push({ kind: "message.agent", payload: { text: "call" + i, toolCalls: [{ id: "c" + i }] } });
      events.push({ kind: "tool.result", payload: { content: "r" + i } } as never);
    }
    const r = await d({ readSession: () => events, readAll: () => Array.from({ length: 13 }) }, "s1");
    expect(r?.totalMessages).toBe(13);
    expect(r?.zones.hot.messages).toBe(13); // 全部未闭合(含 user 链锚)
    expect(r?.zoneBasis).toBe("open-chains");
    expect(r?.openChains).toBe(1);
    expect(r?.afterTraceStart).toBeNull(); // fixture 无 llm.trace → 热区=未闭合链原跨度
  });

  it("⑤e 增量并入热区(全量划分):末条 llm.trace 之后的闭合文本也归热区", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({}));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
 // 事件流:trace@0 → user(1) 开链 → agent 纯文本(2) 闭合(1603 口径该段属温区)——但整段在
 // 末条 llm.trace 之后=本步新增/未发出 → 全量划分下归热区:afterTraceStart=1,
 // openStart=3(闭合),ats=1(事件)→atsDerived=0 → hotStart=min(3,0)=0 → hot=[0,2)=2 条,温区空。
    const events: Array<{ kind?: unknown; payload?: unknown }> = [
      { kind: "llm.trace", payload: { usage: { inputTokens: 5 } } },
      { kind: "message.user", payload: { text: "B" } },
      { kind: "message.agent", payload: { text: "回答B" } },
    ];
    const r = await d({ readSession: () => events, readAll: () => Array.from({ length: 2 }) }, "s1");
    expect(r?.afterTraceStart).toBe(1);
    expect(r?.zones.hot.messages).toBe(2); // 增量整段归热(全量划分)
    expect(r?.zones.warm.messages).toBe(0);
    expect(r?.openChains).toBe(0);
  });

  it("⑤e2 post-trace 无增量消息 → 热区=未闭合链原跨度(afterTraceStart=null)", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({}));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
 // user(0) 开链未闭合;llm.trace(1) 之后无消息 → afterTraceStart=null → hotStart=openStart=0。
    const events: Array<{ kind?: unknown; payload?: unknown }> = [
      { kind: "message.user", payload: { text: "A" } },
      { kind: "llm.trace", payload: { usage: { inputTokens: 5 } } },
    ];
    const r = await d({ readSession: () => events, readAll: () => Array.from({ length: 3 }) }, "s1");
    expect(r?.afterTraceStart).toBeNull();
    expect(r?.zones.hot.messages).toBe(3); // 未闭合链原跨度,不受 trace 影响
  });

  it("⑤c loop import 抛错 → null;frozenCount 经 readSession 尾扫贯通", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => { throw new Error("boom"); });
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    expect(await d({ readSession: () => [], readAll: () => [] }, "s1")).toBeNull();

    vi.resetModules();
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "ab" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({}));
    const m2 = await import("../src/context-zones.js");
    const events = [
      { kind: "message.user", payload: {} },
      { kind: "context.prune", payload: { frozenCount: 2 } },
      { kind: "context.prune", payload: { frozenCount: 4 } }, // 尾扫取这条
    ];
    const r2 = await m2.deriveContextZones({ readSession: () => events, readAll: () => Array.from({ length: 6 }) }, "s1");
    expect(r2?.frozenCount).toBe(4);
    expect(r2?.frozenFrom).toBe("context.prune");
 // 闭合扫描:user(1 条)后 prune×2 → openStart=1;热区=[max(coldEnd=4, 1), 6) → hot 2 条
    expect(r2?.zones.cold.messages).toBe(4);
    expect(r2?.zones.warm.messages).toBe(0);
    expect(r2?.zones.hot.messages).toBe(2);
    expect(r2?.totalMessages).toBe(6);
  });
});
