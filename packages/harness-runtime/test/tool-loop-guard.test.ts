/**
 * 工具循环护栏:纯状态机单测(不启 AgentLoop)。
 * 覆盖:canonical args / 结果 hash / 同签名 3 notice 5 stop / 2~4 轮批次周期 / 结果 stub 范围 /
 * 每轮配额与 env / 成功 mutation 重置 / poller 与参数错误不计失败。
 */
import { describe, it, expect } from "vitest";
import {
  ToolLoopGuard,
  canonicalArgs,
  callSignature,
  resultHashOf,
  isStubTool,
  isPoller,
  isMutation,
  GUARD_WEB_SEARCH_ENV,
  GUARD_SUBAGENT_ENV,
} from "../src/agent/tool-loop-guard";

const env = (o: Record<string, string> = {}): Record<string, string | undefined> => o;

describe("canonicalArgs / signature / resultHash", () => {
  it("键序无关、数组保序、undefined 与函数忽略", () => {
    expect(canonicalArgs({ b: 1, a: { d: 2, c: [1, 2] } }))
      .toBe(canonicalArgs({ a: { c: [1, 2], d: 2 }, b: 1 }));
    expect(canonicalArgs({ a: [1, 2] })).not.toBe(canonicalArgs({ a: [2, 1] }));
    expect(canonicalArgs({ a: 1, b: undefined, c: () => 1 })).toBe(canonicalArgs({ a: 1 }));
    expect(canonicalArgs(undefined)).toBe("null");
    expect(callSignature("read_file", { path: "a", limit: 10 }))
      .toBe(callSignature("read_file", { limit: 10, path: "a" }));
    expect(callSignature("read_file", { path: "a" }))
      .not.toBe(callSignature("grep", { path: "a" }));
  });

  it("resultHash 是稳定 16 位且按内容区分", () => {
    const h = resultHashOf("same");
    expect(h).toHaveLength(16);
    expect(resultHashOf("same")).toBe(h);
    expect(resultHashOf("other")).not.toBe(h);
  });
});

describe("同签名连击:3 次 notice,5 次 stop", () => {
  it("第 3 次记 notice;第 5 次在 beforeCall 就被拦下,之后同签名继续拦", () => {
    const g = new ToolLoopGuard(1, { env: env() });
    const sig = callSignature("read_file", { path: "a" });
    const notices: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      expect(g.beforeCall("read_file", sig)).toBeUndefined();
      const dec = g.record(sig, resultHashOf(`r${i}`));
      if (dec.notice) notices.push(dec.notice);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("同一调用已连续第 3 次");
    const block = g.beforeCall("read_file", sig);
    expect(block?.code).toBe("GUARD_STOP");
    expect(block?.text).toContain("GUARD_STOP");
    expect(g.beforeCall("read_file", sig)?.code).toBe("GUARD_STOP");
    expect(g.stats().stops).toBeGreaterThanOrEqual(1);
  });
});

describe("批次周期:A,B,A,B 重复两轮 notice,第三轮 stop", () => {
  const A = callSignature("read_file", { path: "a" });
  const B = callSignature("grep", { pattern: "x" });

  it("2 轮一轮:第 4 次 notice,第 6 次 stop", () => {
    const g = new ToolLoopGuard(2, { env: env() });
    const calls: { tool: string; sig: string }[] = [
      { tool: "read_file", sig: A }, { tool: "grep", sig: B },
      { tool: "read_file", sig: A }, { tool: "grep", sig: B },
    ];
    let notice: string | undefined;
    calls.forEach((c, i) => {
      expect(g.beforeCall(c.tool, c.sig)).toBeUndefined();
      const dec = g.record(c.sig, resultHashOf(`h${i}`));
      if (dec.notice) notice = dec.notice;
    });
    expect(notice).toContain("批次循环");
    // 第 5 次(A)不重复报 notice(轮换等价去重)
    expect(g.beforeCall("read_file", A)).toBeUndefined();
    expect(g.record(A, resultHashOf("h5")).notice).toBeUndefined();
    // 第 6 次(B)= 第三轮 → 不执行
    expect(g.beforeCall("grep", B)?.code).toBe("GUARD_STOP");
  });

  it("3 次一轮同样能识别", () => {
    const g = new ToolLoopGuard(3, { env: env() });
    const C = callSignature("glob", { pattern: "*.ts" });
    const seq = [
      { tool: "read_file", sig: A }, { tool: "grep", sig: B }, { tool: "glob", sig: C },
      { tool: "read_file", sig: A }, { tool: "grep", sig: B }, { tool: "glob", sig: C },
    ];
    let notice: string | undefined;
    seq.forEach((c, i) => {
      expect(g.beforeCall(c.tool, c.sig)).toBeUndefined();
      const dec = g.record(c.sig, resultHashOf(`k${i}`));
      if (dec.notice) notice = dec.notice;
    });
    expect(notice).toContain("批次循环");
  });
});

describe("结果去重 stub 范围", () => {
  it("只读工具第 2 次相同结果 → stub;mutation 工具不 stub", () => {
    const g = new ToolLoopGuard(4, { env: env() });
    const sig1 = callSignature("read_file", { path: "a" });
    const sig2 = callSignature("read_file", { path: "b" });
    expect(g.record(sig1, resultHashOf("SAME")).stub).toBeUndefined();
    const dec = g.record(sig2, resultHashOf("SAME"));
    expect(dec.stub).toContain("结果与第 1 次调用相同");
    expect(g.record(callSignature("write_file", { path: "a" }), resultHashOf("OK")).stub).toBeUndefined();
    expect(g.record(callSignature("write_file", { path: "b" }), resultHashOf("OK")).stub).toBeUndefined();
    expect(g.stats().stubbed).toBe(1);
  });

  it("范围判定:job read / browser snapshot 属于只读,job kill / terminal send 不是", () => {
    expect(isStubTool("job", canonicalArgs({ action: "read" }))).toBe(true);
    expect(isStubTool("job", canonicalArgs({ action: "kill" }))).toBe(false);
    expect(isStubTool("browser", canonicalArgs({ action: "snapshot" }))).toBe(true);
    expect(isStubTool("browser", canonicalArgs({}))).toBe(true);
    expect(isStubTool("write_file", canonicalArgs({ path: "a" }))).toBe(false);
  });
});

describe("每轮配额", () => {
  const callN = (g: ToolLoopGuard, tool: string, i: number) => {
    const sig = callSignature(tool, { query: `q${i}`, action: "open" });
    const block = g.beforeCall(tool, sig);
    if (!block) g.record(sig, resultHashOf(`${tool}${i}`));
    return block;
  };

  it("web_search 默认 8:第 9 次 GUARD_QUOTA", () => {
    const g = new ToolLoopGuard(5, { env: env() });
    for (let i = 0; i < 8; i += 1) expect(callN(g, "web_search", i)).toBeUndefined();
    expect(callN(g, "web_search", 8)?.code).toBe("GUARD_QUOTA");
    expect(g.stats().quotas).toBe(1);
  });

  it("spawn_subagent 默认 6:第 7 次 GUARD_QUOTA", () => {
    const g = new ToolLoopGuard(6, { env: env() });
    for (let i = 0; i < 6; i += 1) expect(callN(g, "spawn_subagent", i)).toBeUndefined();
    expect(callN(g, "spawn_subagent", 6)?.code).toBe("GUARD_QUOTA");
  });

  it("env 可调,0=关", () => {
    const g2 = new ToolLoopGuard(7, { env: env({ [GUARD_WEB_SEARCH_ENV]: "1" }) });
    expect(callN(g2, "web_search", 0)).toBeUndefined();
    expect(callN(g2, "web_search", 1)?.code).toBe("GUARD_QUOTA");
    const g0 = new ToolLoopGuard(8, { env: env({ [GUARD_SUBAGENT_ENV]: "0" }) });
    for (let i = 0; i < 9; i += 1) expect(callN(g0, "spawn_subagent", i)).toBeUndefined();
    const gBad = new ToolLoopGuard(9, { env: env({ [GUARD_WEB_SEARCH_ENV]: "abc" }) });
    for (let i = 0; i < 8; i += 1) expect(callN(gBad, "web_search", i)).toBeUndefined();
    expect(callN(gBad, "web_search", 8)?.code).toBe("GUARD_QUOTA");
  });
});

describe("成功 mutation 重置连击/失败,白名单不计失败", () => {
  it("read×2 → write 成功 → read 重新从 1 数,不再 notice", () => {
    const g = new ToolLoopGuard(10, { env: env() });
    const sig = callSignature("read_file", { path: "a" });
    g.record(sig, resultHashOf("1"));
    g.record(sig, resultHashOf("2"));
    expect(g.record(callSignature("write_file", { path: "a" }), resultHashOf("ok")).notice).toBeUndefined();
    expect(g.record(sig, resultHashOf("3")).notice).toBeUndefined();
    expect(g.record(sig, resultHashOf("4")).notice).toBeUndefined();
    expect(g.record(sig, resultHashOf("5")).notice).toContain("同一调用已连续第 3 次");
  });

  it("poller / 参数错误 / guardrail 拒绝不算失败,真错误才算;mutation 成功清零", () => {
    const g = new ToolLoopGuard(11, { env: env() });
    const jobWait = callSignature("job", { action: "wait", id: "j1" });
    const taskOut = callSignature("task_output", { agentId: "a1" });
    g.record(jobWait, resultHashOf("1"), { ok: false, kind: "error" });
    g.record(jobWait, resultHashOf("2"), { ok: false, kind: "error" });
    g.record(taskOut, resultHashOf("3"), { ok: false, kind: "error" });
    expect(g.failures).toBe(0);
    g.record(callSignature("read_file", { path: "p" }), resultHashOf("4"), { ok: false, kind: "arg-error" });
    g.record(callSignature("edit_file", { path: "p" }), resultHashOf("5"), { ok: false, kind: "guardrail-refusal" });
    expect(g.failures).toBe(0);
    g.record(callSignature("read_file", { path: "q" }), resultHashOf("6"), { ok: false, kind: "error" });
    expect(g.failures).toBe(1);
    g.record(callSignature("write_file", { path: "q" }), resultHashOf("7"), { ok: true });
    expect(g.failures).toBe(0);
  });

  it("mutation / poller 判定:job start 是 mutation,job wait 是 poller", () => {
    expect(isMutation("job", canonicalArgs({ action: "start" }))).toBe(true);
    expect(isMutation("terminal", canonicalArgs({ action: "send" }))).toBe(true);
    expect(isMutation("job", canonicalArgs({ action: "wait" }))).toBe(false);
    expect(isPoller("job", canonicalArgs({ action: "wait" }))).toBe(true);
    expect(isPoller("task_output", canonicalArgs({}))).toBe(true);
    expect(isPoller("read_file", canonicalArgs({ path: "a" }))).toBe(false);
  });
});

describe("turn 状态隔离", () => {
  it("新 turn 的 guard 从零开始(loop 每 turn new 一个实例)", () => {
    const sig = callSignature("read_file", { path: "a" });
    const t1 = new ToolLoopGuard(1, { env: env() });
    for (let i = 0; i < 3; i += 1) { t1.beforeCall("read_file", sig); t1.record(sig, resultHashOf(`x${i}`)); }
    expect(t1.hasActivity()).toBe(true);
    const t2 = new ToolLoopGuard(2, { env: env() });
    expect(t2.hasActivity()).toBe(false);
    expect(t2.beforeCall("read_file", sig)).toBeUndefined();
    expect(t2.record(sig, resultHashOf("x0")).notice).toBeUndefined(); // 结果 hash 也不跨 turn 复用
  });
});
