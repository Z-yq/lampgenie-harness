/**
 * 系统上下文代(M125 / gap-matrix #125)单测:removal 三态、单块合成、代重开、codec 往返。
 * 这些断言只依赖本模块的纯函数,不需要 AgentLoop/journal(接线回归见 system-in-history.test.ts)。
 */
import { describe, it, expect } from "vitest";
import {
  reconcileSystemContext,
  renderSystemContextBlock,
  renderGenerationBaseline,
  openNewGeneration,
  sectionSha,
  TEXT_CODEC,
  type SystemContextCodec,
  type SystemContextEntry,
  type SystemContextLoad,
  type SystemContextSource,
  type SystemContextState,
} from "../src/agent/system-context-generation";

function entry(text: string): SystemContextEntry {
  return { text, sha: sectionSha(text) };
}

function stateOf(entries: Record<string, SystemContextEntry>, generation = 0, baselineSeq = 0): SystemContextState {
  return { generation, baselineSeq, entries };
}

function src<T>(
  key: string,
  load: () => Promise<SystemContextLoad<T>>,
  codec: SystemContextCodec<T> = TEXT_CODEC as unknown as SystemContextCodec<T>,
): SystemContextSource<T> {
  return { key, codec, load };
}

const ok = <T>(value: T): SystemContextLoad<T> => ({ status: "ok", value });
const unavailable = <T>(): SystemContextLoad<T> => ({ status: "unavailable" });
const absent = <T>(): SystemContextLoad<T> => ({ status: "absent" });

describe("reconcileSystemContext:removal 三态", () => {
  it("首次出现(基线无该 key)→ baseline,进 block 并写入基线", async () => {
    const r = await reconcileSystemContext(
      stateOf({}),
      [src("memory", async () => ok("MEMORY v1"))],
    );
    expect(r.ops).toEqual([{ key: "memory", kind: "baseline", text: "## memory\nMEMORY v1" }]);
    expect(r.block).toBe("## memory\nMEMORY v1");
    expect(r.next.entries["memory"]).toEqual(entry("MEMORY v1"));
  });

  it("sha 与基线一致 → unchanged,零追加", async () => {
    const r = await reconcileSystemContext(
      stateOf({ memory: entry("MEMORY v1") }),
      [src("memory", async () => ok("MEMORY v1"))],
    );
    expect(r.ops).toEqual([{ key: "memory", kind: "unchanged" }]);
    expect(r.block).toBe("");
    // 基线原样保留
    expect(r.next.entries["memory"]).toEqual(entry("MEMORY v1"));
  });

  it("sha 不同 → update 进 block,但基线**不**原地改写(下轮仍能 diff 出同一处变更)", async () => {
    const base = entry("MEMORY v1");
    const r = await reconcileSystemContext(
      stateOf({ memory: base }),
      [src("memory", async () => ok("MEMORY v2"))],
    );
    expect(r.ops).toEqual([{ key: "memory", kind: "update", text: "## memory\nMEMORY v2" }]);
    expect(r.block).toBe("## memory\nMEMORY v2");
    expect(r.next.entries["memory"]).toEqual(base); // ★ 基线不动
    // 同一基线再跑一次:仍然产出 update(不是 unchanged)
    const again = await reconcileSystemContext(r.next, [src("memory", async () => ok("MEMORY v2"))]);
    expect(again.ops[0]?.kind).toBe("update");
  });

  it("unavailable → kept-unavailable:保留旧值,**绝不**产出 removed(读失败≠删除)", async () => {
    const base = entry("MEMORY v1");
    const r = await reconcileSystemContext(
      stateOf({ memory: base }),
      [src("memory", async () => unavailable<string>())],
    );
    expect(r.ops).toEqual([{ key: "memory", kind: "kept-unavailable" }]);
    expect(r.block).toBe("");
    expect(r.ops.some((o) => o.kind === "removed")).toBe(false);
    expect(r.block).not.toContain("已移除");
    expect(r.next.entries["memory"]).toEqual(base); // 旧值还在,下次读到还能自愈
  });

  it("load() 抛错也算 unavailable(不炸、不删)", async () => {
    const base = entry("MEMORY v1");
    const r = await reconcileSystemContext(stateOf({ memory: base }), [
      src("memory", async () => { throw new Error("EIO"); }),
    ]);
    expect(r.ops).toEqual([{ key: "memory", kind: "kept-unavailable" }]);
    expect(r.next.entries["memory"]).toEqual(base);
  });

  it("absent 且基线有该 key → removed:显式移除声明进 block,基线剔除", async () => {
    const r = await reconcileSystemContext(
      stateOf({ goal: entry("GOAL v1") }),
      [src("goal", async () => absent<string>())],
    );
    expect(r.ops).toEqual([{ key: "goal", kind: "removed", text: "## goal\n(本节已移除,不再生效)" }]);
    expect(r.block).toBe("## goal\n(本节已移除,不再生效)");
    expect(r.next.entries["goal"]).toBeUndefined();
  });

  it("absent 且基线无该 key → 不产出任何 op(从未存在不等于删除)", async () => {
    const r = await reconcileSystemContext(stateOf({}), [src("plan", async () => absent<string>())]);
    expect(r.ops).toEqual([]);
    expect(r.block).toBe("");
  });

  it("基线有、但本次 sources 没提供该 key → 不产出 op(没问它,不是它没了)", async () => {
    const r = await reconcileSystemContext(
      stateOf({ goal: entry("GOAL v1") }),
      [src("memory", async () => ok("MEMORY v1"))],
    );
    expect(r.ops.map((o) => o.key)).toEqual(["memory"]);
    expect(r.next.entries["goal"]).toEqual(entry("GOAL v1"));
  });
});

describe("renderSystemContextBlock:单块合成", () => {
  it("按 key 字典序稳定排序,与 sources 给出顺序无关(逐字节相同)", async () => {
    const s = stateOf({ a: entry("A0"), b: entry("B0"), c: entry("C0") });
    const r1 = await reconcileSystemContext(s, [
      src("c", async () => ok("C1")),
      src("a", async () => ok("A1")),
      src("b", async () => ok("B1")),
    ]);
    const r2 = await reconcileSystemContext(s, [
      src("b", async () => ok("B1")),
      src("c", async () => ok("C1")),
      src("a", async () => ok("A1")),
    ]);
    expect(r1.block).toBe("## a\nA1\n\n## b\nB1\n\n## c\nC1");
    expect(r1.block).toBe(r2.block);
  });

  it("空 ops / 全 unchanged / 全 unavailable → 空串(零追加)", async () => {
    expect(renderSystemContextBlock([])).toBe("");
    const r = await reconcileSystemContext(
      stateOf({ a: entry("A0"), b: entry("B0") }),
      [src("a", async () => ok("A0")), src("b", async () => unavailable<string>())],
    );
    expect(r.block).toBe("");
  });

  it("内容自带 `## ` 标题时不再叠加节名(f2 双层标题回归)", async () => {
    const r = await reconcileSystemContext(stateOf({}), [
      src("date", async () => ok("\n\n## 当前日期\n2026-11-07(周六)")),
    ]);
    expect(r.block).toBe("## 当前日期\n2026-11-07(周六)");
    expect(r.block).not.toContain("## date");
  });
});

describe("openNewGeneration:压缩越过基线后重开代", () => {
  it("generation+1、baselineSeq 推进、基线收窄为当前渲染文本的组成", () => {
    const s = stateOf({ a: entry("A1"), b: entry("B1"), c: entry("C1") }, 2, 10);
    const next = openNewGeneration(s, ["b", "a"]);
    expect(next.generation).toBe(3);
    expect(next.baselineSeq).toBe(11);
    expect(Object.keys(next.entries).sort()).toEqual(["a", "b"]); // c 不属于这一代基线
    expect(renderGenerationBaseline(next, ["b", "a"])).toBe("B1\n\nA1"); // 基线=当前渲染文本
  });

  it("可显式传真实 journal seq 作为 baselineSeq", () => {
    const s = stateOf({ a: entry("A1") }, 0, 0);
    expect(openNewGeneration(s, ["a"], 4096).baselineSeq).toBe(4096);
  });

  it("重开代后旧基线键即使内容相同也重新进入 baseline(不被当成 unchanged 静默吞掉)", async () => {
    const s = stateOf({ a: entry("A1") }, 0, 0);
    const next = openNewGeneration(s, []); // 这一代基线里没有 a
    const r = await reconcileSystemContext(next, [src("a", async () => ok("A1"))]);
    expect(r.ops).toEqual([{ key: "a", kind: "baseline", text: "## a\nA1" }]);
    expect(r.block).toBe("## a\nA1");
  });
});

describe("codec:结构化源往返", () => {
  it("encode 决定基线文本与 sha,decode 能把基线文本还原成值", async () => {
    const codec: SystemContextCodec<{ count: number }> = {
      encode: (v) => JSON.stringify(v),
      decode: (t) => JSON.parse(t) as { count: number },
    };
    const r = await reconcileSystemContext(stateOf({}), [src("stats", async () => ok({ count: 3 }), codec)]);
    expect(r.block).toBe('## stats\n{"count":3}');
    const stored = r.next.entries["stats"]!;
    expect(stored.sha).toBe(sectionSha('{"count":3}'));
    expect(codec.decode(stored.text)).toEqual({ count: 3 });
    // 同值不同对象(引用不同)→ 仍是 unchanged(codec 归一到文本)
    const again = await reconcileSystemContext(r.next, [src("stats", async () => ok({ count: 3 }), codec)]);
    expect(again.ops).toEqual([{ key: "stats", kind: "unchanged" }]);
  });

  it("重复 key 首个胜出,结果确定", async () => {
    const r = await reconcileSystemContext(stateOf({}), [
      src("k", async () => ok("FIRST")),
      src("k", async () => ok("SECOND")),
    ]);
    expect(r.block).toBe("## k\nFIRST");
    expect(r.ops).toHaveLength(1);
  });
});
