/**
 * loop 注入枢纽(事件面 v1)单测:预算整块跳过/fail-soft/来源标签/幂等注册/确定性顺序。
 */
import { describe, it, expect } from "vitest";
import { createLoopInjectionHub } from "@lampgenie/runtime/agent/loop-injection-hub";

const INPUT = { point: "kickoff", sessionId: "s1", taskText: "替换 X 模块", taskClass: "coding" };

describe("createLoopInjectionHub", () => {
  it("多 listener 按注册序合成,带来源与字节", async () => {
    const hub = createLoopInjectionHub();
    hub.register({ id: "a", collect: () => "AA" });
    hub.register({ id: "b", collect: () => "BB" });
    const r = await hub.collect(INPUT);
    expect(r.blocks.map((b) => b.source)).toEqual(["a", "b"]);
    expect(r.blocks[0]).toMatchObject({ text: "AA", bytes: 2 });
    expect(r.totalBytes).toBe(4);
    expect(r.skipped).toEqual([]);
  });

  it("空串=零注入(宁缺勿错);全部空=零块", async () => {
    const hub = createLoopInjectionHub();
    hub.register({ id: "a", collect: () => "" });
    const r = await hub.collect(INPUT);
    expect(r.blocks).toEqual([]);
    expect(r.totalBytes).toBe(0);
  });

  it("单 listener 抛错折叠 skipped(error),其余照常", async () => {
    const hub = createLoopInjectionHub();
    hub.register({ id: "bad", collect: () => { throw new Error("boom"); } });
    hub.register({ id: "good", collect: () => "OK" });
    const r = await hub.collect(INPUT);
    expect(r.blocks.map((b) => b.source)).toEqual(["good"]);
    expect(r.skipped).toEqual([{ id: "bad", reason: "error", error: "boom" }]);
  });

  it("超单块预算整块跳过(不截断半句),记 over-budget+bytes", async () => {
    const hub = createLoopInjectionHub();
    hub.register({ id: "big", maxBytes: 4, collect: () => "0123456789" });
    const r = await hub.collect(INPUT);
    expect(r.blocks).toEqual([]);
    expect(r.skipped).toEqual([{ id: "big", reason: "over-budget", bytes: 10 }]);
  });

  it("超总预算:前面的块保留,装不下的整块跳过", async () => {
    const hub = createLoopInjectionHub({ totalMaxBytes: 5 });
    hub.register({ id: "a", collect: () => "AAA" }); // 3B
    hub.register({ id: "b", collect: () => "BBBB" }); // 4B → 3+4>5 跳过
    hub.register({ id: "c", collect: () => "BB" }); // 2B → 3+2≤5 保留
    const r = await hub.collect(INPUT);
    expect(r.blocks.map((b) => b.source)).toEqual(["a", "c"]);
    expect(r.skipped.map((s) => s.id)).toEqual(["b"]);
  });

  it("同 id 重复注册=覆盖(幂等);异步 listener 可 await", async () => {
    const hub = createLoopInjectionHub();
    hub.register({ id: "a", collect: () => "old" });
    hub.register({ id: "a", collect: async () => "new" });
    expect(hub.listenerIds()).toEqual(["a"]);
    const r = await hub.collect(INPUT);
    expect(r.blocks[0]?.text).toBe("new");
  });
});
