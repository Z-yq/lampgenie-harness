import { describe, it, expect } from "vitest";
import { receive, createIntakeStore, buildTrigger } from "../../src/router/intake.js";
import { DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../../src/router/policy.js";

const configOf = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ ...DEFAULT_POLICY_CONFIG, ...over });

describe("router intake 三判据(step-0143 sr2)", () => {
  it("正常路径返回 stored", () => {
    const store = createIntakeStore(configOf());
    const t = buildTrigger({ source: "panel", sessionId: "s1", instruction: "写个 README", now: () => 1000 });
    expect(receive(t, store, () => 1000)).toBe("stored");
  });

  it("同 trigger.id 二次 receive 返回 duplicate 且不重复入队", () => {
    const store = createIntakeStore(configOf());
    const t = buildTrigger({ source: "panel", sessionId: "s1", instruction: "x", triggerId: "tr-1", now: () => 1000 });
    expect(receive(t, store, () => 1000)).toBe("stored");
    expect(receive({ ...t, at: 2000 }, store, () => 2000)).toBe("duplicate");
    // 不重复入队:dispositions 无新增(首次 stored 未落 filtered/disposition)
    expect(store.dispositions()).toHaveLength(0);
  });

  it("scope 未监听返回 filtered 并落 disposition", () => {
    const store = createIntakeStore(configOf({ sources: [{ name: "panel", listened: true }, { name: "im", listened: false }] }));
    const t = buildTrigger({ source: "im", sessionId: "s1", instruction: "x", triggerId: "tr-2", now: () => 1000 });
    expect(receive(t, store, () => 1000)).toBe("filtered");
    const d = store.dispositions();
    expect(d).toHaveLength(1);
    expect(d[0]?.outcome).toBe("filtered");
    expect(d[0]?.triggerId).toBe("tr-2");
  });

  it("filtered 后同 id 再来仍 duplicate(去重先于 scope)", () => {
    const store = createIntakeStore(configOf({ sources: [{ name: "im", listened: false }] }));
    const t = buildTrigger({ source: "im", sessionId: "s1", instruction: "x", triggerId: "tr-3", now: () => 1000 });
    expect(receive(t, store, () => 1000)).toBe("filtered");
    expect(receive(t, store, () => 2000)).toBe("duplicate");
  });
});

// 2026-11-04 修复回归:Trigger.instruction 携带全文——200 字「预览截断」曾把任务书截成
// 214 字(硬纪律段全丢,五任务实锤);预览语义只允许在渲染层,不进数据本体。
it("buildTrigger 超长指令不截断(全文进 Trigger,派发与 agent 任务书同源)", () => {
  const long = "任".repeat(559) + "尾部标记";
  const t = buildTrigger({ source: "panel", sessionId: "s-x", instruction: long, now: () => 1 });
  expect(t.instruction).toBe(long);
  expect(t.instruction.length).toBe(563); // 559+4(尾部标记)
  expect(t.instruction).toContain("尾部标记");
  expect(t.instruction).not.toContain("截断");
});
