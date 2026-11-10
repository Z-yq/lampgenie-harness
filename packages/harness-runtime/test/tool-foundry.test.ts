/**
 * Tool Foundry 纯逻辑直测:观察校验 / 挖掘门槛与估算 / 报告渲染 / 影子三态 / 注册与下线 / dataToolSpec 映射。
 * 全内存零 IO。
 */
import { describe, expect, it } from "vitest";
import {
  FOUNDRY_CODES,
  FOUNDRY_KINDS,
  FOUNDRY_VERSION,
  evaluateShadow,
  mineCandidates,
  observe,
  registerCandidate,
  renderCandidateReport,
  retireCandidate,
  startShadow,
  toDataToolSpec,
} from "../src/agent/tool-foundry.ts";
import type { FoundryKind, ToolCandidate } from "../src/agent/tool-foundry.ts";

function obs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "s1",
    projectId: "p1",
    at: 100,
    kind: "command-sequence",
    signature: "git.status->git.diff",
    steps: ["git status", "git diff"],
    cost: { tokens: 100, wallMs: 40, toolCalls: 2 },
    success: true,
    ...overrides,
  };
}

function obsFor(signature: string, sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return obs({ signature, sessionId, ...overrides });
}

/** 造一个达标候选(3 次观测 / 2 会话),再用 overrides 覆盖。 */
function makeCandidate(overrides: Partial<ToolCandidate> = {}): ToolCandidate {
  const mined = mineCandidates(
    [obsFor("git.status->git.diff", "s1"), obsFor("git.status->git.diff", "s2"), obsFor("git.status->git.diff", "s3")],
    { now: 1000 },
  );
  const base = mined.candidates[0];
  if (!base) throw new Error("fixture 未产出候选");
  return { ...base, ...overrides };
}

function shadowCandidate(overrides: Partial<ToolCandidate> = {}): ToolCandidate {
  return startShadow(makeCandidate(), 2000).candidate;
}

describe("基础导出", () => {
  it("版本号为 1", () => {
    expect(FOUNDRY_VERSION).toBe(1);
  });

  it("三种模式种类固定", () => {
    expect([...FOUNDRY_KINDS]).toEqual(["command-sequence", "inline-script", "manual-step"]);
  });

  it("码表恰为 12 个稳定码且顺序固定", () => {
    expect([...FOUNDRY_CODES]).toEqual([
      "FOUNDRY_INVALID",
      "FOUNDRY_OBSERVED",
      "FOUNDRY_CANDIDATE",
      "FOUNDRY_NO_CANDIDATE",
      "FOUNDRY_SHADOW_STARTED",
      "FOUNDRY_SHADOW_PASS",
      "FOUNDRY_SHADOW_FAIL",
      "FOUNDRY_REGISTERED",
      "FOUNDRY_RETIRED",
      "FOUNDRY_DUPLICATE",
      "FOUNDRY_NEEDS_APPROVAL",
      "FOUNDRY_LOW_REUSE",
    ]);
  });
});

describe("observe 合法输入", () => {
  it("规范化合法观测并给出 OBSERVED", () => {
    const res = observe(obs());
    expect(res.ok).toBe(true);
    expect(res.codes).toEqual(["FOUNDRY_OBSERVED"]);
    expect(res.observation?.signature).toBe("git.status->git.diff");
    expect(res.observation?.steps).toEqual(["git status", "git diff"]);
    expect(res.observation?.cost).toEqual({ tokens: 100, wallMs: 40, toolCalls: 2 });
    expect(res.observation?.kind).toBe("command-sequence");
    expect(res.observation?.at).toBe(100);
  });

  it("id 确定性:同输入两次同 id,不用随机数", () => {
    const a = observe(obs());
    const b = observe(obs());
    expect(a.observation?.id).toBe(b.observation?.id);
    expect(a.observation?.id).toMatch(/^obs_[0-9a-f]{8}$/);
  });

  it("ctx.id 覆盖派生 id", () => {
    const res = observe(obs(), { id: "fixed-id" });
    expect(res.observation?.id).toBe("fixed-id");
  });

  it("at 缺省回落到 ctx.at", () => {
    const input = obs();
    delete input.at;
    const res = observe(input, { at: 777 });
    expect(res.observation?.at).toBe(777);
  });

  it("at 完全缺省时为 0", () => {
    const input = obs();
    delete input.at;
    expect(observe(input).observation?.at).toBe(0);
  });

  it("failureMode 保留并裁剪空白", () => {
    const res = observe(obs({ success: false, failureMode: " timeout " }));
    expect(res.observation?.success).toBe(false);
    expect(res.observation?.failureMode).toBe("timeout");
  });
});

describe("observe 非法输入", () => {
  it("非对象 → INVALID", () => {
    for (const bad of [null, undefined, 42, "x", [obs()]]) {
      const res = observe(bad);
      expect(res.ok).toBe(false);
      expect(res.codes).toEqual(["FOUNDRY_INVALID"]);
      expect(typeof res.reason).toBe("string");
    }
  });

  it("空 signature → INVALID", () => {
    expect(observe(obs({ signature: "   " })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ signature: 3 })).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("空 steps → INVALID", () => {
    expect(observe(obs({ steps: [] })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ steps: "git status" })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ steps: ["git status", " "] })).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("cost 非对象或字段非数 → INVALID", () => {
    expect(observe(obs({ cost: null })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ cost: { tokens: "100", wallMs: 1, toolCalls: 1 } })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ cost: { tokens: 1, wallMs: Number.NaN, toolCalls: 1 } })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ cost: { tokens: 1, wallMs: 1, toolCalls: Number.POSITIVE_INFINITY } })).codes).toEqual([
      "FOUNDRY_INVALID",
    ]);
  });

  it("kind 非法 → INVALID", () => {
    expect(observe(obs({ kind: "shell" })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ kind: 1 })).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("缺 sessionId / projectId → INVALID", () => {
    const noSession = obs();
    delete noSession.sessionId;
    expect(observe(noSession).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(observe(obs({ projectId: "" })).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("success 非布尔 → INVALID", () => {
    expect(observe(obs({ success: "yes" })).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("非法输入不抛异常", () => {
    expect(() => observe(Symbol("x") as unknown)).not.toThrow();
    expect(() => observe({ ...obs(), cost: [1, 2, 3] })).not.toThrow();
  });
});

describe("mineCandidates 门槛", () => {
  it("频次不足 → low-frequency + NO_CANDIDATE", () => {
    const res = mineCandidates([obsFor("sig.a", "s1"), obsFor("sig.a", "s2")]);
    expect(res.candidates).toEqual([]);
    expect(res.codes).toEqual(["FOUNDRY_NO_CANDIDATE"]);
    expect(res.discarded).toContainEqual({ signature: "sig.a", reason: "low-frequency" });
  });

  it("单会话 → single-session", () => {
    const res = mineCandidates([obsFor("sig.b", "s1"), obsFor("sig.b", "s1"), obsFor("sig.b", "s1")]);
    expect(res.candidates).toEqual([]);
    expect(res.discarded).toContainEqual({ signature: "sig.b", reason: "single-session" });
  });

  it("恰好达标 → 产出候选", () => {
    const res = mineCandidates([obsFor("sig.c", "s1"), obsFor("sig.c", "s2"), obsFor("sig.c", "s1")]);
    expect(res.codes).toEqual(["FOUNDRY_CANDIDATE"]);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]?.frequency).toBe(3);
    expect(res.candidates[0]?.sessions).toBe(2);
    expect(res.discarded).toEqual([]);
  });

  it("非法观测记 invalid-observation,同时不影响其它组", () => {
    const res = mineCandidates([
      obsFor("sig.d", "s1"),
      obsFor("sig.d", "s2"),
      obsFor("sig.d", "s3"),
      { signature: "sig.bad" },
      null,
    ]);
    expect(res.discarded.filter((entry) => entry.reason === "invalid-observation")).toHaveLength(2);
    expect(res.candidates).toHaveLength(1);
  });

  it("observations 非数组 → INVALID 且不抛异常", () => {
    expect(mineCandidates(null).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(() => mineCandidates("nope")).not.toThrow();
  });

  it("自定义门槛生效", () => {
    const res = mineCandidates([obsFor("sig.e", "s1"), obsFor("sig.e", "s2")], { minOccurrences: 2, minSessions: 1 });
    expect(res.candidates).toHaveLength(1);
  });

  it("existing 中已 retired 的同签名 → duplicate-retired 不复活", () => {
    const retired = makeCandidate({ status: "retired" });
    const res = mineCandidates([obsFor("git.status->git.diff", "s1"), obsFor("git.status->git.diff", "s2"), obsFor("git.status->git.diff", "s3")], {
      existing: [retired],
    });
    expect(res.candidates).toEqual([]);
    expect(res.discarded).toContainEqual({ signature: "git.status->git.diff", reason: "duplicate-retired" });
  });

  it("existing 中 registered 不阻止挖掘", () => {
    const registered = makeCandidate({ status: "registered" });
    const res = mineCandidates(
      [obsFor("git.status->git.diff", "s1"), obsFor("git.status->git.diff", "s2"), obsFor("git.status->git.diff", "s3")],
      { existing: [registered] },
    );
    expect(res.candidates).toHaveLength(1);
  });
});

describe("mineCandidates 聚合与估算", () => {
  it("tokens 节省按 round 口径", () => {
    const list = [1, 2, 3].map((i) => obsFor("sig.f", `s${i}`, { cost: { tokens: 33, wallMs: 1, toolCalls: 1 } }));
    const res = mineCandidates(list);
    // 3 * 33 = 99 → 99 * 0.6 = 59.4 → round 59
    expect(res.candidates[0]?.estimatedSavings.tokens).toBe(59);
  });

  it("savingsRatio 可注入", () => {
    const list = [1, 2, 3].map((i) => obsFor("sig.g", `s${i}`, { cost: { tokens: 10, wallMs: 1, toolCalls: 1 } }));
    expect(mineCandidates(list, { savingsRatio: 1 }).candidates[0]?.estimatedSavings.tokens).toBe(30);
  });

  it("toolCalls 节省不为负", () => {
    const list = [1, 2, 3].map((i) => obsFor("sig.h", `s${i}`, { cost: { tokens: 10, wallMs: 1, toolCalls: 0 } }));
    expect(mineCandidates(list).candidates[0]?.estimatedSavings.toolCalls).toBe(0);
  });

  it("toolCalls 节省 = Σ - frequency", () => {
    const list = [1, 2, 3].map((i) => obsFor("sig.i", `s${i}`, { cost: { tokens: 10, wallMs: 1, toolCalls: 2 } }));
    expect(mineCandidates(list).candidates[0]?.estimatedSavings.toolCalls).toBe(3);
  });

  it("failureModes 只取失败观测、去空去重排序", () => {
    const res = mineCandidates([
      obsFor("sig.j", "s1", { success: false, failureMode: "timeout" }),
      obsFor("sig.j", "s2", { success: false, failureMode: "E_NOFILE" }),
      obsFor("sig.j", "s3", { success: false, failureMode: "timeout" }),
      obsFor("sig.j", "s4", { success: false, failureMode: "   " }),
      obsFor("sig.j", "s5", { success: true, failureMode: "ignored" }),
    ]);
    expect(res.candidates[0]?.failureModes).toEqual(["E_NOFILE", "timeout"]);
  });

  it("projects 去重并排序", () => {
    const res = mineCandidates([
      obsFor("sig.k", "s1", { projectId: "zeta" }),
      obsFor("sig.k", "s2", { projectId: "alpha" }),
      obsFor("sig.k", "s3", { projectId: "alpha" }),
    ]);
    expect(res.candidates[0]?.projects).toEqual(["alpha", "zeta"]);
  });

  it("契约与默认权限固定", () => {
    const candidate = makeCandidate();
    expect(candidate.contract).toEqual({ parameters: { input: { type: "string" } }, returns: "string" });
    expect(candidate.permissions).toEqual({ mode: "read" });
    expect(candidate.status).toBe("candidate");
    expect(candidate.createdAt).toBe(1000);
    expect(candidate.updatedAt).toBe(1000);
  });

  it("kind 取组内首个观测", () => {
    const kinds: FoundryKind[] = ["inline-script", "manual-step", "command-sequence"];
    const res = mineCandidates([0, 1, 2].map((i) => obsFor("sig.l", `s${i}`, { kind: kinds[i] })));
    expect(res.candidates[0]?.kind).toBe("inline-script");
  });

  it("name 匹配 /^[a-z0-9_]{3,48}$/ 且确定性", () => {
    const a = makeCandidate();
    const b = makeCandidate();
    expect(a.name).toMatch(/^[a-z0-9_]{3,48}$/);
    expect(a.name.startsWith("tf_")).toBe(true);
    expect(a.name).toBe(b.name);
    expect(a.id).toBe(b.id);
  });

  it("超长/怪字符签名也能得到合法 name", () => {
    const signature = "git log --oneline -20 && grep 'FIXME' -- **/*.ts??".repeat(4);
    const res = mineCandidates([1, 2, 3].map((i) => obsFor(signature, `s${i}`)));
    const name = res.candidates[0]?.name ?? "";
    expect(name).toMatch(/^[a-z0-9_]{3,48}$/);
  });

  it("排序:tokens 降序优先", () => {
    const res = mineCandidates([
      obsFor("sig.small", "s1", { cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      obsFor("sig.small", "s2", { cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      obsFor("sig.small", "s3", { cost: { tokens: 100, wallMs: 1, toolCalls: 1 } }),
      obsFor("sig.big", "s1", { cost: { tokens: 200, wallMs: 1, toolCalls: 1 } }),
      obsFor("sig.big", "s2", { cost: { tokens: 200, wallMs: 1, toolCalls: 1 } }),
      obsFor("sig.big", "s3", { cost: { tokens: 200, wallMs: 1, toolCalls: 1 } }),
    ]);
    expect(res.candidates.map((candidate) => candidate.sourceSignature)).toEqual(["sig.big", "sig.small"]);
  });

  it("排序:同 tokens 时按频次降序", () => {
    const res = mineCandidates([
      ...[1, 2, 3].map((i) => obsFor("sig.few", `s${i}`, { cost: { tokens: 100, wallMs: 1, toolCalls: 1 } })),
      ...[1, 2, 3, 4].map((i) => obsFor("sig.many", `s${i}`, { cost: { tokens: 75, wallMs: 1, toolCalls: 1 } })),
    ]);
    expect(res.candidates.map((candidate) => candidate.sourceSignature)).toEqual(["sig.many", "sig.few"]);
  });

  it("排序:同 tokens 同频次时按 signature 升序", () => {
    const res = mineCandidates([
      ...[1, 2, 3].map((i) => obsFor("sig.zzz", `s${i}`)),
      ...[1, 2, 3].map((i) => obsFor("sig.aaa", `s${i}`)),
    ]);
    expect(res.candidates.map((candidate) => candidate.sourceSignature)).toEqual(["sig.aaa", "sig.zzz"]);
  });
});

describe("renderCandidateReport", () => {
  it("空数组给明确空态", () => {
    const text = renderCandidateReport([]);
    expect(text).toContain("候选");
    expect(text).toContain("无");
  });

  it("含关键字段", () => {
    const candidate = makeCandidate({ failureModes: ["timeout"] });
    const text = renderCandidateReport([candidate]);
    expect(text).toContain(candidate.name);
    expect(text).toContain(candidate.sourceSignature);
    expect(text).toContain("3 次");
    expect(text).toContain("会话");
    expect(text).toContain("项目");
    expect(text).toContain("tokens");
    expect(text).toContain("toolCalls");
    expect(text).toContain("契约");
    expect(text).toContain("权限");
    expect(text).toContain("timeout");
  });

  it("不修改入参", () => {
    const candidate = makeCandidate({ failureModes: ["timeout"] });
    const snapshot = JSON.stringify(candidate);
    renderCandidateReport([candidate]);
    expect(JSON.stringify(candidate)).toBe(snapshot);
  });
});

describe("影子段", () => {
  it("startShadow 只接受 candidate,返回新对象", () => {
    const base = makeCandidate();
    const res = startShadow(base, 5000);
    expect(res.codes).toEqual(["FOUNDRY_SHADOW_STARTED"]);
    expect(res.candidate.status).toBe("shadow");
    expect(res.candidate.shadow).toEqual({ runs: 0, successes: 0 });
    expect(res.candidate.updatedAt).toBe(5000);
    expect(base.status).toBe("candidate");
    expect(res.candidate).not.toBe(base);
  });

  it("startShadow 非 candidate → INVALID", () => {
    expect(startShadow(makeCandidate({ status: "registered" })).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(startShadow(null as unknown as ToolCandidate).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("evaluateShadow 非 shadow → INVALID", () => {
    expect(evaluateShadow(makeCandidate(), { runs: 3, successes: 3 }).codes).toEqual(["FOUNDRY_INVALID"]);
  });

  it("样本不足 → LOW_REUSE 且仍是 shadow", () => {
    const res = evaluateShadow(shadowCandidate(), { runs: 2, successes: 2, now: 6000 });
    expect(res.codes).toEqual(["FOUNDRY_LOW_REUSE"]);
    expect(res.candidate.status).toBe("shadow");
    expect(res.candidate.shadow).toEqual({ runs: 2, successes: 2 });
    expect(res.candidate.updatedAt).toBe(6000);
  });

  it("成功率 2/3 → rejected + rejectedAt", () => {
    const res = evaluateShadow(shadowCandidate(), { runs: 3, successes: 2, now: 6000 });
    expect(res.codes).toEqual(["FOUNDRY_SHADOW_FAIL"]);
    expect(res.candidate.status).toBe("rejected");
    expect(res.candidate.shadow).toEqual({ runs: 3, successes: 2, rejectedAt: 6000 });
  });

  it("3/3 → SHADOW_PASS 且保持 shadow", () => {
    const res = evaluateShadow(shadowCandidate(), { runs: 3, successes: 3, now: 6000 });
    expect(res.codes).toEqual(["FOUNDRY_SHADOW_PASS"]);
    expect(res.candidate.status).toBe("shadow");
  });

  it("自定义 minRuns / minSuccessRate 生效", () => {
    const candidate = shadowCandidate();
    expect(evaluateShadow(candidate, { runs: 4, successes: 4, minRuns: 5 }).codes).toEqual(["FOUNDRY_LOW_REUSE"]);
    expect(evaluateShadow(candidate, { runs: 2, successes: 2, minRuns: 2, minSuccessRate: 1 }).codes).toEqual([
      "FOUNDRY_SHADOW_PASS",
    ]);
  });

  it("successes > runs 或非有限数值 → INVALID", () => {
    const candidate = shadowCandidate();
    expect(evaluateShadow(candidate, { runs: 2, successes: 3 }).codes).toEqual(["FOUNDRY_INVALID"]);
    expect(evaluateShadow(candidate, { runs: Number.NaN, successes: 0 }).codes).toEqual(["FOUNDRY_INVALID"]);
  });
});

describe("注册与下线", () => {
  it("未 approve → NEEDS_APPROVAL", () => {
    const res = registerCandidate(shadowCandidate(), { approved: false });
    expect(res.codes).toEqual(["FOUNDRY_NEEDS_APPROVAL"]);
    expect(res.candidate.status).toBe("shadow");
  });

  it("非 shadow 且 approve → NEEDS_APPROVAL", () => {
    const res = registerCandidate(makeCandidate(), { approved: true });
    expect(res.codes).toEqual(["FOUNDRY_NEEDS_APPROVAL"]);
    expect(res.candidate.status).toBe("candidate");
  });

  it("approve 后注册成功并挂 dataToolSpec", () => {
    const res = registerCandidate(shadowCandidate(), { approved: true, now: 7000 });
    expect(res.codes).toEqual(["FOUNDRY_REGISTERED"]);
    expect(res.candidate.status).toBe("registered");
    expect(res.candidate.dataToolSpec?.name).toBe(res.candidate.name);
    expect(res.candidate.updatedAt).toBe(7000);
  });

  it("已 registered → DUPLICATE", () => {
    const registered = makeCandidate({ status: "registered" });
    expect(registerCandidate(registered, { approved: true }).codes).toEqual(["FOUNDRY_DUPLICATE"]);
  });

  it("retire → retired", () => {
    const res = retireCandidate(makeCandidate({ status: "registered" }), { reason: "被原生工具取代", now: 8000 });
    expect(res.codes).toEqual(["FOUNDRY_RETIRED"]);
    expect(res.candidate.status).toBe("retired");
    expect(res.candidate.updatedAt).toBe(8000);
  });

  it("重复 retire → DUPLICATE", () => {
    const retired = makeCandidate({ status: "retired" });
    expect(retireCandidate(retired, { reason: "again" }).codes).toEqual(["FOUNDRY_DUPLICATE"]);
  });

  it("reason 为空 → INVALID 且状态不变", () => {
    const candidate = makeCandidate();
    const res = retireCandidate(candidate, { reason: "   " });
    expect(res.codes).toEqual(["FOUNDRY_INVALID"]);
    expect(res.candidate.status).toBe("candidate");
  });

  it("非法入参不抛异常", () => {
    expect(() => registerCandidate(undefined as unknown as ToolCandidate, undefined as never)).not.toThrow();
    expect(() => retireCandidate(42 as unknown as ToolCandidate, null as never)).not.toThrow();
    expect(() => evaluateShadow({} as ToolCandidate, null as never)).not.toThrow();
  });
});

describe("toDataToolSpec", () => {
  it("字段映射符合 data 层契约", () => {
    const candidate = makeCandidate();
    const spec = toDataToolSpec(candidate);
    expect(spec.name).toBe(candidate.name);
    expect(spec.version).toBe("1.0.0");
    expect(spec.owner).toBe("tool-foundry");
    expect(spec.description).toBe(candidate.description);
    expect(spec.layer).toBe("data");
    expect(spec.registeredBy).toBe("rsi");
    expect(spec.handler).toEqual({ kind: "command", ref: candidate.sourceSignature });
    expect(spec.parameters).toEqual(candidate.contract.parameters);
    expect(spec.permissions).toEqual(candidate.permissions);
  });

  it("register 产出的 dataToolSpec 与 toDataToolSpec 一致", () => {
    const candidate = shadowCandidate();
    const registered = registerCandidate(candidate, { approved: true });
    expect(registered.candidate.dataToolSpec).toEqual(toDataToolSpec(candidate));
  });

  it("非法候选也返回合法 spec 而不抛异常", () => {
    const spec = toDataToolSpec({} as ToolCandidate);
    expect(spec.name).toMatch(/^[a-z0-9_]{3,48}$/);
    expect(spec.permissions.mode).toBe("read");
  });
});
