/** 上下文温度三区派生测试(数据链,白板节点 n1)。
 * 真实 deriveMessages 经动态 import 拉入整个 loop.ts 模块链(内部 ./stream-anchor 等
 * 子模块在 vitest/直跑环境缺 node_modules 解析),单测环境下不可稳定构造——按任务书预案,
 * 把切分/统计/尾扫拆成纯函数直测,入口函数只测「空会话/非法 journal → null」与
 * 模块 mock 的失败路径。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { partitionZones, zoneStatsOf, frozenCountOf, deriveContextZones } from "../src/context-zones.js";

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

describe("deriveContextZones 入口", () => {
  it("空会话/非法 journal → null(不造数)", async () => {
    expect(await deriveContextZones({ readSession: () => [], readAll: () => [] }, "s1")).toBeNull();
    expect(await deriveContextZones(null, "s1")).toBeNull();
    expect(await deriveContextZones({} as never, "s1")).toBeNull();
  });

  it("⑤a loop 模块缺 deriveMessages 导出 → null", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({}));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    expect(await d({ readSession: () => [{ kind: "message.user", payload: { text: "a" } }], readAll: () => [] }, "s1", { hotTail: 1 })).toBeNull();
  });

  it("⑤b protection-windows 缺导出 → 回退 6/default;有导出 → 读 scoringHotTailMessages", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({})); // 缺导出=回退
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    const j = () => ({ readSession: () => [{ kind: "message.user", payload: {} }], readAll: () => Array.from({ length: 8 }) });
    const r = await d(j(), "s1");
    expect(r?.hotTailSource).toBe("default");
    expect(r?.zones.hot.messages).toBe(6); // 8 条,N=6
    expect(r?.zones.warm.messages).toBe(2);
  });

  it("⑤b2 protection-windows 正常导出 → hotTailSource=protection-windows 且 N 生效", async () => {
    vi.doMock("@lampgenie/runtime/agent/loop", () => ({
      deriveMessages: (j: { readAll: () => unknown[] }) => j.readAll().map(() => ({ content: "aaaa" })),
    }));
    vi.doMock("@lampgenie/runtime/agent/protection-windows", () => ({
      PROTECTION_WINDOWS: { scoringHotTailMessages: 3 },
    }));
    const { deriveContextZones: d } = await import("../src/context-zones.js");
    const j = () => ({ readSession: () => [], readAll: () => Array.from({ length: 8 }) });
    const r = await d(j(), "s1");
    expect(r?.hotTailSource).toBe("protection-windows");
    expect(r?.zones.hot.messages).toBe(3);
    expect(r?.zones.warm.messages).toBe(5);
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
    const r2 = await m2.deriveContextZones({ readSession: () => events, readAll: () => Array.from({ length: 6 }) }, "s1", { hotTail: 1 });
    expect(r2?.frozenCount).toBe(4);
    expect(r2?.frozenFrom).toBe("context.prune");
    expect(r2?.zones.cold.messages).toBe(4);
    expect(r2?.zones.warm.messages).toBe(1);
    expect(r2?.zones.hot.messages).toBe(1);
    expect(r2?.totalMessages).toBe(6);
  });
});
