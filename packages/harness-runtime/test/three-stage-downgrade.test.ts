import { describe, it, expect } from "vitest";
import { PROTECTION_WINDOWS, OBSERVATION_STEPS, stageOf } from "../src/agent/protection-windows";
import { DEFAULT_KEEP_RECENT_GROUPS } from "../src/agent/microcompact";
import { AGE_DEFAULTS } from "../src/agent/microcompact-age";

/**
 * 缺口#27:三段式降级 + 保护窗统一登记。
 * 断言两件事:①stageOf 四态判定;②PROTECTION_WINDOWS 的值与 microcompact /
 * microcompact-age 的**实际缺省常量**一致(import 实际常量对比,防两处漂移)。
 */

describe("stageOf 四态(缺口#27)", () => {
  it("hardProtected → protected(硬保护先出局,任何阶段都不进可裁池)", () => {
    expect(stageOf({ lastTouchedStep: 0, currentStep: 100, stillReferenced: false, hardProtected: true })).toBe("protected");
  });

  it("观察期内(currentStep - lastTouchedStep < OBSERVATION_STEPS)→ observing", () => {
    expect(stageOf({ lastTouchedStep: 5, currentStep: 5, stillReferenced: false, hardProtected: false })).toBe("observing");
    expect(stageOf({ lastTouchedStep: 5, currentStep: 7, stillReferenced: false, hardProtected: false })).toBe("observing"); // 差 2 < 3
    expect(OBSERVATION_STEPS).toBe(3);
  });

  it("观察期到期 + stillReferenced → protected(回保护区)", () => {
    expect(stageOf({ lastTouchedStep: 5, currentStep: 8, stillReferenced: true, hardProtected: false })).toBe("protected"); // 差 3 ≥ 3
  });

  it("观察期到期 + 不再被引用 → prunable(可裁候选,裁不裁由经济门裁决)", () => {
    expect(stageOf({ lastTouchedStep: 5, currentStep: 8, stillReferenced: false, hardProtected: false })).toBe("prunable");
  });
});

describe("PROTECTION_WINDOWS 统一登记(缺口#27)", () => {
  it("四键值 = 各机制现状缺省(microcompact 5 组 / 评分 6 条 / path_prune 3 个 / 按龄 3 组)", () => {
    expect(PROTECTION_WINDOWS.microcompactKeepRecentGroups).toBe(5);
    expect(PROTECTION_WINDOWS.scoringHotTailMessages).toBe(6);
    expect(PROTECTION_WINDOWS.pathPruneKeepRecent).toBe(3);
    expect(PROTECTION_WINDOWS.ageKeepRecentGroups).toBe(3);
  });

  it("microcompact 实际缺省 keepRecent 从 PROTECTION_WINDOWS 引用(防漂移断言)", () => {
 // import 的是 microcompact.ts 真正用作缺省的常量:两处必须相等,否则就是漂移。
    expect(DEFAULT_KEEP_RECENT_GROUPS).toBe(PROTECTION_WINDOWS.microcompactKeepRecentGroups);
  });

  it("microcompact-age 实际缺省 keepRecentGroups 从 PROTECTION_WINDOWS 引用(防漂移断言)", () => {
    expect(AGE_DEFAULTS.keepRecentGroups).toBe(PROTECTION_WINDOWS.ageKeepRecentGroups);
  });
});
