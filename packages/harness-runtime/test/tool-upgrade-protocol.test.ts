/**
 * 工具热升级协议:四段位(shadow→canary→switch→retire)、双跑判据、确定性分流、降级窗口、
 * 回滚、历史回放、原生兼容策略、#192 实验对象形状。全纯函数直测,不触 IO。
 */
import { describe, expect, it } from "vitest";
import {
  TOOL_UPGRADE_VERSION,
  TOOL_UP_CANARY_PROMOTED,
  TOOL_UP_CODES,
  TOOL_UP_DUAL_RUN_FAIL,
  TOOL_UP_DUAL_RUN_PASS,
  TOOL_UP_GUARDRAIL_BREACH,
  TOOL_UP_INVALID,
  TOOL_UP_KEEP_WINDOW_ACTIVE,
  TOOL_UP_NATIVE_STRATEGY,
  TOOL_UP_NOT_FOUND,
  TOOL_UP_RETIRED,
  TOOL_UP_ROLLED_BACK,
  TOOL_UP_SHADOW_STARTED,
  TOOL_UP_STAGE_ORDER,
  TOOL_UP_SWITCHED,
  buildExperimentRecord,
  compareDualRun,
  initState,
  nativeUpgradePlan,
  promoteCanary,
  resolveForCall,
  resolveHistorical,
  retireVersion,
  rollback,
  startShadow,
  switchVersion,
} from "../src/agent/tool-upgrade-protocol";
import type { CanaryConfig, UpgradeState } from "../src/agent/tool-upgrade-protocol";

const AT = 1_000;
const NAME = "search.tool";

type StatefulResult = { ok: boolean; codes: string[]; state?: UpgradeState };

/** 断言成功并取出新 state(失败时把码打进错误信息,便于定位)。 */
function mustState(result: StatefulResult): UpgradeState {
  expect(result.ok).toBe(true);
  if (!result.state) throw new Error(`expected state, codes=${result.codes.join(",")}`);
  return result.state;
}

function base(): UpgradeState {
  return mustState(initState({ name: NAME, version: "v1", at: AT }));
}

function withShadow(version = "v2", alias = "beta"): UpgradeState {
  return mustState(startShadow(base(), { newVersion: version, alias, at: AT + 1 }));
}

function canaryState(canary: CanaryConfig, version = "v2"): UpgradeState {
  return mustState(promoteCanary(withShadow(version), { version, canary, at: AT + 2 }));
}

function switched(): UpgradeState {
  return mustState(switchVersion(canaryState({ scope: "session" }), { version: "v2", at: AT + 3, experimentId: "exp-1" }));
}

function versionOf(state: UpgradeState, version: string) {
  return state.versions.find((v) => v.version === version);
}

describe("initState", () => {
  it("既有在线工具初始化:stage=switch、current=version、history 记 init", () => {
    const result = initState({ name: NAME, version: "v1", at: AT });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([]);
    const state = mustState(result);
    expect(state.name).toBe(NAME);
    expect(state.current).toBe("v1");
    expect(state.aliasMap).toEqual({});
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.stage).toBe("switch");
    expect(state.versions[0]?.registeredAt).toBe(AT);
    expect(state.history).toEqual([{ at: AT, action: "init", to: "v1" }]);
  });

  it("空 name / 空 version → TOOL_UP_INVALID 且不带 state", () => {
    const noName = initState({ name: "  ", version: "v1" });
    expect(noName.ok).toBe(false);
    expect(noName.codes).toEqual([TOOL_UP_INVALID]);
    expect(noName.state).toBeUndefined();
    expect(initState({ name: NAME, version: "" }).codes).toEqual([TOOL_UP_INVALID]);
  });

  it("init 缺省 at 记 0(不读时钟,同一输入同一输出)", () => {
    const a = mustState(initState({ name: NAME, version: "v1" }));
    const b = mustState(initState({ name: NAME, version: "v1" }));
    expect(a.history[0]?.at).toBe(0);
    expect(a).toEqual(b);
  });
});

describe("shadow", () => {
  it("起影子:新版本 stage=shadow、挂 alias、写 aliasMap、码只给 SHADOW_STARTED", () => {
    const result = startShadow(base(), { newVersion: "v2", alias: "beta", at: AT + 1 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([TOOL_UP_SHADOW_STARTED]);
    const state = mustState(result);
    expect(versionOf(state, "v2")?.stage).toBe("shadow");
    expect(versionOf(state, "v2")?.alias).toBe("beta");
    expect(versionOf(state, "v2")?.registeredAt).toBe(AT + 1);
    expect(state.aliasMap["beta"]).toBe("v2");
    expect(state.current).toBe("v1");
    expect(state.history.at(-1)).toEqual({ at: AT + 1, action: "shadow", to: "v2" });
  });

  it("alias 冲突(已在 aliasMap)→ TOOL_UP_INVALID", () => {
    const state = withShadow("v2", "beta");
    const conflict = startShadow(state, { newVersion: "v3", alias: "beta", at: AT + 2 });
    expect(conflict.ok).toBe(false);
    expect(conflict.codes).toEqual([TOOL_UP_INVALID]);
  });

  it("同版本重复起影子 → TOOL_UP_INVALID;已过 shadow 段的同版本 → TOOL_UP_STAGE_ORDER", () => {
    const state = withShadow("v2", "beta");
    expect(startShadow(state, { newVersion: "v2", alias: "gamma", at: AT + 2 }).codes).toEqual([TOOL_UP_INVALID]);
    const advanced = canaryState({ scope: "session" });
    expect(startShadow(advanced, { newVersion: "v2", alias: "gamma", at: AT + 3 }).codes).toEqual([TOOL_UP_STAGE_ORDER]);
  });

  it("起影子不改入参 state(深比较快照一致)", () => {
    const state = base();
    const snapshot = JSON.stringify(state);
    const next = mustState(startShadow(state, { newVersion: "v2", alias: "beta", at: AT + 1 }));
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(next).not.toBe(state);
    expect(next.versions).not.toBe(state.versions);
  });
});

describe("四段位顺序", () => {
  it("shadow→canary→switch→retire 逐步 ok(每一步的码都对)", () => {
    const shadowed = startShadow(base(), { newVersion: "v2", alias: "beta", at: AT + 1 });
    expect(shadowed.codes).toEqual([TOOL_UP_SHADOW_STARTED]);
    const canaried = promoteCanary(mustState(shadowed), { version: "v2", canary: { scope: "session" }, at: AT + 2 });
    expect(canaried.codes).toEqual([TOOL_UP_CANARY_PROMOTED]);
    const switchedState = switchVersion(mustState(canaried), { version: "v2", at: AT + 3 });
    expect(switchedState.codes).toEqual([TOOL_UP_SWITCHED]);
    const state = mustState(switchedState);
    expect(state.current).toBe("v2");
    expect(versionOf(state, "v2")?.stage).toBe("switch");
  });

  it("跳级:对还在 switch 段的版本 promoteCanary → TOOL_UP_STAGE_ORDER", () => {
    const result = promoteCanary(base(), { version: "v1", canary: { scope: "session" }, at: AT + 1 });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([TOOL_UP_STAGE_ORDER]);
  });

  it("跳级:对还在 switch 段的版本 switchVersion → TOOL_UP_STAGE_ORDER", () => {
    const result = switchVersion(base(), { version: "v1", at: AT + 1 });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([TOOL_UP_STAGE_ORDER]);
  });

  it("跳级失败时入参 state 未被修改", () => {
    const state = base();
    const snapshot = JSON.stringify(state);
    promoteCanary(state, { version: "v1", canary: { scope: "session" }, at: AT + 1 });
    switchVersion(state, { version: "v1", at: AT + 1 });
    retireVersion(state, { version: "v1", at: AT + 1 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });

  it("canary 版本可被直接 switch(允许跳过显式回滚)", () => {
    const state = canaryState({ scope: "session" });
    expect(versionOf(state, "v2")?.stage).toBe("canary");
    const next = mustState(switchVersion(state, { version: "v2", at: AT + 3 }));
    expect(next.current).toBe("v2");
  });
});

describe("compareDualRun", () => {
  it("样本够、无守卫越界 → pass + DUAL_RUN_PASS", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 40, latency: 20 },
      newMetrics: { runs: 40, latency: 18 },
      guardrails: [],
    });
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.codes).toEqual([TOOL_UP_DUAL_RUN_PASS]);
    expect(result.reason).toBeUndefined();
    expect(result.deltas["latency"]).toBe(-10);
  });

  it("样本不足 → fail + reason=sample-low + DUAL_RUN_FAIL", () => {
    const result = compareDualRun({ oldMetrics: { runs: 10 }, newMetrics: { runs: 40 }, guardrails: [] });
    expect(result.verdict).toBe("fail");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sample-low");
    expect(result.codes).toEqual([TOOL_UP_DUAL_RUN_FAIL]);
  });

  it("runs 缺失按 0 → 一样算样本不足", () => {
    const result = compareDualRun({ oldMetrics: {}, newMetrics: { runs: 100 }, guardrails: [] });
    expect(result.reason).toBe("sample-low");
    expect(result.codes).toContain(TOOL_UP_DUAL_RUN_FAIL);
  });

  it("minRuns 可下调(minRuns=3 时 runs=5 通过)", () => {
    const result = compareDualRun({ oldMetrics: { runs: 5 }, newMetrics: { runs: 5 } }, { minRuns: 3 });
    expect(result.verdict).toBe("pass");
  });

  it("guardrail increase(越高越好)跌破阈值 → GUARDRAIL_BREACH + DUAL_RUN_FAIL", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 40, accuracy: 0.9 },
      newMetrics: { runs: 40, accuracy: 0.7 },
      guardrails: [{ metric: "accuracy", direction: "increase", threshold: 0.8 }],
    });
    expect(result.verdict).toBe("fail");
    expect(result.codes).toEqual([TOOL_UP_GUARDRAIL_BREACH, TOOL_UP_DUAL_RUN_FAIL]);
    expect(result.reason).toBeUndefined();
  });

  it("guardrail decrease(越低越好)涨过阈值 → GUARDRAIL_BREACH + DUAL_RUN_FAIL", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 40, p95: 100 },
      newMetrics: { runs: 40, p95: 250 },
      guardrails: [{ metric: "p95", direction: "decrease", threshold: 200 }],
    });
    expect(result.codes).toEqual([TOOL_UP_GUARDRAIL_BREACH, TOOL_UP_DUAL_RUN_FAIL]);
  });

  it("正好等于阈值不算越界", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 40, accuracy: 0.8 },
      newMetrics: { runs: 40, accuracy: 0.8 },
      guardrails: [{ metric: "accuracy", direction: "increase", threshold: 0.8 }],
    });
    expect(result.verdict).toBe("pass");
    expect(result.codes).toEqual([TOOL_UP_DUAL_RUN_PASS]);
  });

  it("样本不足 + 守卫越界:两条码都在,sample-low 仍标出", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 2, accuracy: 0.9 },
      newMetrics: { runs: 2, accuracy: 0.1 },
      guardrails: [{ metric: "accuracy", direction: "increase", threshold: 0.5 }],
    });
    expect(result.codes).toEqual([TOOL_UP_GUARDRAIL_BREACH, TOOL_UP_DUAL_RUN_FAIL]);
    expect(result.reason).toBe("sample-low");
  });

  it("deltas 保留 4 位小数,old=0 的 metric 跳过(不产生 Infinity)", () => {
    const result = compareDualRun({
      oldMetrics: { runs: 40, third: 3, zero: 0 },
      newMetrics: { runs: 40, third: 4, zero: 7 },
    });
    expect(result.deltas["third"]).toBe(33.3333);
    expect(result.deltas["runs"]).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(result.deltas, "zero")).toBe(false);
    expect(Number.isFinite(result.deltas["third"] ?? Number.NaN)).toBe(true);
  });

  it("非法/缺字段输入不 throw:空对象也能给出 fail 而不是异常", () => {
    const result = compareDualRun({ oldMetrics: {} as Record<string, number>, newMetrics: {} as Record<string, number> });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("sample-low");
  });
});

describe("canary 分流", () => {
  it("percent 钳到 0..100(250 → 100、-30 → 0)", () => {
    const high = mustState(promoteCanary(withShadow(), { version: "v2", canary: { scope: "percent", percent: 250 }, at: AT }));
    expect(versionOf(high, "v2")?.canary?.percent).toBe(100);
    const low = mustState(promoteCanary(withShadow(), { version: "v2", canary: { scope: "percent", percent: -30 }, at: AT }));
    expect(versionOf(low, "v2")?.canary?.percent).toBe(0);
  });

  it("promoteCanary 保留 alias 与 aliasMap", () => {
    const state = canaryState({ scope: "session" });
    expect(versionOf(state, "v2")?.alias).toBe("beta");
    expect(state.aliasMap["beta"]).toBe("v2");
    expect(state.current).toBe("v1");
  });

  it("promoteCanary 版本不存在 → NOT_FOUND;重复 promote → STAGE_ORDER", () => {
    expect(promoteCanary(base(), { version: "v9", canary: { scope: "session" }, at: AT }).codes).toEqual([
      TOOL_UP_NOT_FOUND,
    ]);
    expect(
      promoteCanary(canaryState({ scope: "session" }), { version: "v2", canary: { scope: "session" }, at: AT }).codes,
    ).toEqual([TOOL_UP_STAGE_ORDER]);
  });

  it("percent=0 恒不命中(全部落 current)", () => {
    const state = canaryState({ scope: "percent", percent: 0 });
    for (const sessionId of ["s1", "s2", "s3", "s4"]) {
      const resolved = resolveForCall(state, { sessionId });
      expect(resolved.ok).toBe(true);
      expect(resolved.version).toBe("v1");
      expect(resolved.source).toBe("current");
    }
  });

  it("percent=100 恒命中 canary", () => {
    const state = canaryState({ scope: "percent", percent: 100 });
    for (const sessionId of ["s1", "s2", "s3", "s4"]) {
      const resolved = resolveForCall(state, { sessionId });
      expect(resolved.version).toBe("v2");
      expect(resolved.source).toBe("canary");
      expect(resolved.stage).toBe("canary");
    }
  });

  it("percent=50:同一 sessionId 重复调用结果稳定", () => {
    const state = canaryState({ scope: "percent", percent: 50 });
    const first = resolveForCall(state, { sessionId: "session-stable" });
    const second = resolveForCall(state, { sessionId: "session-stable" });
    expect(second.version).toBe(first.version);
    expect(second.source).toBe(first.source);
  });

  it("percent=50:不同 sessionId 既有命中也有不命中", () => {
    const state = canaryState({ scope: "percent", percent: 50 });
    const sources = new Set<string>();
    for (let i = 0; i < 40; i += 1) sources.add(resolveForCall(state, { sessionId: `s-${i}` }).source);
    expect(sources.has("canary")).toBe(true);
    expect(sources.has("current")).toBe(true);
  });

  it("percent 分流受工具名参与 hash(同 sessionId 换工具名结论可变)", () => {
    const alpha = mustState(initState({ name: "alpha", version: "a1", at: AT }));
    const beta = mustState(initState({ name: "beta", version: "b1", at: AT }));
    const mkV2 = (s: UpgradeState, v: string) =>
      mustState(startShadow(s, { newVersion: v, alias: "n", at: AT + 1 }));
    const alphaCanary = mustState(
      promoteCanary(mkV2(alpha, "a2"), { version: "a2", canary: { scope: "percent", percent: 50 }, at: AT + 2 }),
    );
    const betaCanary = mustState(
      promoteCanary(mkV2(beta, "b2"), { version: "b2", canary: { scope: "percent", percent: 50 }, at: AT + 2 }),
    );
    const ids = ["x1", "x2", "x3", "x4", "x5", "x6"];
    const differ = ids.some(
      (sessionId) => resolveForCall(alphaCanary, { sessionId }).source !== resolveForCall(betaCanary, { sessionId }).source,
    );
    expect(differ).toBe(true);
  });

  it("scope=session:名单内命中 canary,名单外落 current", () => {
    const state = canaryState({ scope: "session", sessions: ["s1", "s3"] });
    expect(resolveForCall(state, { sessionId: "s1" }).source).toBe("canary");
    expect(resolveForCall(state, { sessionId: "s1" }).version).toBe("v2");
    expect(resolveForCall(state, { sessionId: "s2" }).source).toBe("current");
    expect(resolveForCall(state, { sessionId: "s2" }).version).toBe("v1");
  });

  it("scope=session 但调用没带 sessionId → 不命中", () => {
    const state = canaryState({ scope: "session", sessions: ["s1"] });
    expect(resolveForCall(state, {}).source).toBe("current");
  });

  it("scope=project:按 projectId 名单命中/不命中", () => {
    const state = canaryState({ scope: "project", projects: ["p1"] });
    expect(resolveForCall(state, { projectId: "p1" }).source).toBe("canary");
    expect(resolveForCall(state, { projectId: "p2" }).source).toBe("current");
    expect(resolveForCall(state, {}).source).toBe("current");
  });

  it("显式 alias 命中 source=alias 且带出版本段位", () => {
    const state = withShadow("v2", "beta");
    const resolved = resolveForCall(state, { alias: "beta" });
    expect(resolved.ok).toBe(true);
    expect(resolved.version).toBe("v2");
    expect(resolved.source).toBe("alias");
    expect(resolved.stage).toBe("shadow");
  });

  it("显式 alias 未命中 → NOT_FOUND 且 version 为空串(不偷渡到 current)", () => {
    const resolved = resolveForCall(withShadow("v2", "beta"), { alias: "nope" });
    expect(resolved.ok).toBe(false);
    expect(resolved.version).toBe("");
    expect(resolved.codes).toEqual([TOOL_UP_NOT_FOUND]);
  });

  it("无 canary 时一律落 current", () => {
    const resolved = resolveForCall(base(), { sessionId: "s1" });
    expect(resolved.version).toBe("v1");
    expect(resolved.stage).toBe("switch");
    expect(resolved.source).toBe("current");
  });
});

describe("switch / rollback", () => {
  it("switch:新版接管 current,旧版降级记 demotedFrom/keepWindows/aliasMap", () => {
    const state = switched();
    expect(state.current).toBe("v2");
    expect(versionOf(state, "v2")?.stage).toBe("switch");
    const demoted = versionOf(state, "v1");
    expect(demoted?.stage).toBe("switch");
    expect(demoted?.demotedFrom).toBe(NAME);
    expect(demoted?.keepWindows).toBe(2);
    expect(state.aliasMap["v1"]).toBe("v1");
  });

  it("switch:history 记 from/to/experimentId", () => {
    const state = switched();
    const entry = state.history.at(-1);
    expect(entry?.action).toBe("switch");
    expect(entry?.from).toBe("v1");
    expect(entry?.to).toBe("v2");
    expect(entry?.experimentId).toBe("exp-1");
    expect(entry?.at).toBe(AT + 3);
  });

  it("switch 未知版本 → NOT_FOUND", () => {
    expect(switchVersion(base(), { version: "v9", at: AT + 1 }).codes).toEqual([TOOL_UP_NOT_FOUND]);
  });

  it("rollback:目标接管 current,被撤下的新版回 shadow 且保留 alias 映射", () => {
    const before = switched();
    const after = mustState(rollback(before, { toVersion: "v1", at: AT + 5 }));
    expect(after.current).toBe("v1");
    expect(versionOf(after, "v2")?.stage).toBe("shadow");
    expect(versionOf(after, "v2")?.alias).toBe("beta");
    expect(after.aliasMap["beta"]).toBe("v2");
    expect(after.history.at(-1)).toEqual({ at: AT + 5, action: "rollback", from: "v2", to: "v1" });
    // 入参不被改
    expect(before.current).toBe("v2");
  });

  it("rollback 目标已 retire → 取消退役(段位回 switch、清 retiredAt)", () => {
    const retired = mustState(retireVersion(withShadow("v2", "beta"), { version: "v2", at: AT + 5 }));
    expect(retired.current).toBe("v1");
    expect(versionOf(retired, "v2")?.stage).toBe("retire");
    const result = rollback(retired, { toVersion: "v2", at: AT + 6 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([TOOL_UP_ROLLED_BACK]);
    const after = mustState(result);
    expect(after.current).toBe("v2");
    expect(versionOf(after, "v2")?.stage).toBe("switch");
    expect(versionOf(after, "v2")?.retiredAt).toBeUndefined();
  });

  it("rollback 未知版本 → NOT_FOUND;at 非法 → INVALID", () => {
    expect(rollback(base(), { toVersion: "v9", at: AT }).codes).toEqual([TOOL_UP_NOT_FOUND]);
    expect(rollback(base(), { toVersion: "v1", at: Number.NaN }).codes).toEqual([TOOL_UP_INVALID]);
  });
});

describe("retire / keep window / 历史回放", () => {
  it("降级后立即 retire → KEEP_WINDOW_ACTIVE", () => {
    const result = retireVersion(switched(), { version: "v1", at: AT + 4 });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual([TOOL_UP_KEEP_WINDOW_ACTIVE]);
    expect(result.state).toBeUndefined();
  });

  it("再 switch 两次(窗口走完)后同版本 retire 成功", () => {
    let state = switched();
    for (const version of ["v3", "v4"]) {
      state = mustState(startShadow(state, { newVersion: version, alias: `slot-${version}`, at: AT + 5 }));
      state = mustState(switchVersion(state, { version, at: AT + 6 }));
    }
    expect(state.current).toBe("v4");
    const result = retireVersion(state, { version: "v1", at: AT + 9 });
    expect(result.ok).toBe(true);
    expect(result.codes).toEqual([TOOL_UP_RETIRED]);
    const retired = mustState(result);
    expect(versionOf(retired, "v1")?.stage).toBe("retire");
    expect(versionOf(retired, "v1")?.retiredAt).toBe(AT + 9);
    expect(retired.history.at(-1)).toEqual({ at: AT + 9, action: "retire", to: "v1" });
  });

  it("从未被降级的版本没有保留窗口,可直接 retire", () => {
    const state = withShadow("v2", "beta");
    const result = retireVersion(state, { version: "v2", at: AT + 4 });
    expect(result.codes).toEqual([TOOL_UP_RETIRED]);
    const retired = mustState(result);
    expect(retired.versions).toHaveLength(2);
    expect(versionOf(retired, "v2")?.demotedFrom).toBeUndefined();
  });

  it("retire current → STAGE_ORDER;retire 未知版本 → NOT_FOUND", () => {
    expect(retireVersion(base(), { version: "v1", at: AT + 1 }).codes).toEqual([TOOL_UP_STAGE_ORDER]);
    expect(retireVersion(base(), { version: "v9", at: AT + 1 }).codes).toEqual([TOOL_UP_NOT_FOUND]);
  });

  it("retire 后 resolveHistorical 仍能解析(含 retiredAt)", () => {
    const retired = mustState(retireVersion(withShadow("v2", "beta"), { version: "v2", at: AT + 4 }));
    const found = resolveHistorical(retired, { version: "v2" });
    expect(found.ok).toBe(true);
    expect(found.codes).toEqual([]);
    expect(found.version?.stage).toBe("retire");
    expect(found.version?.retiredAt).toBe(AT + 4);
    expect(found.version?.alias).toBe("beta");
  });

  it("resolveHistorical 未知版本 → NOT_FOUND;version 空 → INVALID", () => {
    expect(resolveHistorical(base(), { version: "v9" }).codes).toEqual([TOOL_UP_NOT_FOUND]);
    expect(resolveHistorical(base(), { version: "" }).codes).toEqual([TOOL_UP_INVALID]);
  });

  it("retire 后普通调用不再返回它,但显式 alias 仍按历史解析(stage=retire)", () => {
    const retired = mustState(retireVersion(withShadow("v2", "beta"), { version: "v2", at: AT + 4 }));
    const byAlias = resolveForCall(retired, { alias: "beta" });
    expect(byAlias.ok).toBe(true);
    expect(byAlias.version).toBe("v2");
    expect(byAlias.stage).toBe("retire");
    expect(byAlias.source).toBe("alias");
    expect(resolveForCall(retired, { sessionId: "s1" }).version).toBe("v1");
    expect(resolveForCall(retired, { sessionId: "s1" }).source).toBe("current");
  });
});

describe("nativeUpgradePlan", () => {
  it("wrap:前后钩子 + note", () => {
    const plan = nativeUpgradePlan({ kind: "wrap", ref: "old.tool" });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.kind !== "wrap") throw new Error("expected wrap plan");
    expect(plan.ref).toBe("old.tool");
    expect(typeof plan.hooks.pre).toBe("string");
    expect(typeof plan.hooks.post).toBe("string");
    expect(plan.note.length).toBeGreaterThan(0);
  });

  it("demote:带 successor 与 alias 映射", () => {
    const plan = nativeUpgradePlan({ kind: "demote", ref: "old.tool", successor: "new.tool" });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.kind !== "demote") throw new Error("expected demote plan");
    expect(plan.successor).toBe("new.tool");
    expect(plan.alias).toEqual({ from: "old.tool", to: "new.tool" });
  });

  it("demote 缺 successor → TOOL_UP_NATIVE_STRATEGY", () => {
    const plan = nativeUpgradePlan({ kind: "demote", ref: "old.tool" });
    expect(plan.ok).toBe(false);
    expect(plan.codes).toEqual([TOOL_UP_NATIVE_STRATEGY]);
  });

  it("tips:三条中文用法迁移提示", () => {
    const plan = nativeUpgradePlan({ kind: "tips", ref: "old.tool" });
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.kind !== "tips") throw new Error("expected tips plan");
    expect(plan.tips).toHaveLength(3);
    for (const tip of plan.tips) expect(/[\u4e00-\u9fa5]/.test(tip)).toBe(true);
  });

  it("kind 非法 / ref 空 → TOOL_UP_INVALID", () => {
    expect(nativeUpgradePlan({ kind: "rename" as "wrap", ref: "x" }).codes).toEqual([TOOL_UP_INVALID]);
    expect(nativeUpgradePlan({ kind: "wrap", ref: "  " }).codes).toEqual([TOOL_UP_INVALID]);
  });
});

describe("buildExperimentRecord", () => {
  it("#192 兼容最小对象:强制字段(hypothesis.claim / intervention.ref)非空", () => {
    const record = buildExperimentRecord({ name: NAME, from: "v1", to: "v2" });
    expect("ok" in record).toBe(false);
    if ("ok" in record) throw new Error("expected record");
    expect(record.hypothesis.claim.trim()).not.toBe("");
    expect(record.hypothesis.claim).toContain(`${NAME} v1→v2`);
    expect(record.intervention.ref).toBe(NAME);
    expect(record.intervention.surface).toBe("tool");
    expect(record.intervention.variant).toBe("v2");
    expect(record.rollbackPoint).toEqual({ kind: "flag", ref: `tool:${NAME}@v1` });
    expect(record.canary).toEqual({ scope: "session", sessions: 0, status: "pending" });
    expect(record.decision).toEqual({ kind: "pending" });
    expect(record.guardrails).toEqual([]);
    expect(record.strata).toEqual([]);
    expect(record.metrics).toEqual([]);
  });

  it("空 name/from/to → TOOL_UP_INVALID", () => {
    expect(buildExperimentRecord({ name: "", from: "v1", to: "v2" }).ok).toBe(false);
    expect(buildExperimentRecord({ name: NAME, from: "", to: "v2" }).codes).toEqual([TOOL_UP_INVALID]);
    expect(buildExperimentRecord({ name: NAME, from: "v1", to: "  " }).codes).toEqual([TOOL_UP_INVALID]);
  });
});

describe("非法输入统一走码", () => {
  it("state 缺失 → TOOL_UP_INVALID(各函数都不 throw)", () => {
    const missing = undefined as unknown as UpgradeState;
    expect(startShadow(missing, { newVersion: "v2", alias: "b", at: AT }).codes).toEqual([TOOL_UP_INVALID]);
    expect(promoteCanary(missing, { version: "v2", canary: { scope: "session" }, at: AT }).codes).toEqual([
      TOOL_UP_INVALID,
    ]);
    expect(switchVersion(missing, { version: "v2", at: AT }).codes).toEqual([TOOL_UP_INVALID]);
    expect(rollback(missing, { toVersion: "v1", at: AT }).codes).toEqual([TOOL_UP_INVALID]);
    expect(retireVersion(missing, { version: "v1", at: AT }).codes).toEqual([TOOL_UP_INVALID]);
    expect(resolveForCall(missing).codes).toEqual([TOOL_UP_INVALID]);
    expect(resolveHistorical(missing, { version: "v1" }).codes).toEqual([TOOL_UP_INVALID]);
  });

  it("version 空 / at 非法 → TOOL_UP_INVALID", () => {
    const state = withShadow("v2", "beta");
    expect(startShadow(state, { newVersion: "", alias: "g", at: AT }).codes).toEqual([TOOL_UP_INVALID]);
    expect(startShadow(state, { newVersion: "v3", alias: "g", at: Number.NaN }).codes).toEqual([TOOL_UP_INVALID]);
    expect(promoteCanary(state, { version: "", canary: { scope: "session" } }).codes).toEqual([TOOL_UP_INVALID]);
    expect(switchVersion(state, { version: "v2", at: Number.POSITIVE_INFINITY }).codes).toEqual([TOOL_UP_INVALID]);
    expect(retireVersion(state, { version: "v2", at: Number.NaN }).codes).toEqual([TOOL_UP_INVALID]);
  });

  it("canary.scope 非法 → TOOL_UP_INVALID", () => {
    const state = withShadow("v2", "beta");
    const result = promoteCanary(state, { version: "v2", canary: { scope: "room" as "session" } });
    expect(result.codes).toEqual([TOOL_UP_INVALID]);
  });
});

describe("码表", () => {
  it("TOOL_UPGRADE_VERSION === 1", () => {
    expect(TOOL_UPGRADE_VERSION).toBe(1);
  });

  it("TOOL_UP_CODES 冻结且含 13 个稳定码", () => {
    expect(Object.isFrozen(TOOL_UP_CODES)).toBe(true);
    const values = Object.values(TOOL_UP_CODES) as string[];
    expect(values).toHaveLength(13);
    expect(new Set(values).size).toBe(13);
    for (const code of values) expect(code.startsWith("TOOL_UP_")).toBe(true);
  });
});
