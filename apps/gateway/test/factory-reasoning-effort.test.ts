/**
 * reasoningEffort 装配面直测(起源; O2 语义更新; subagent 语义再更新):
 * 旧语义(仅显式配置携带)→ 新语义:
 *  - 主实施轨 effort = coding.llm.implementationEffort(缺省 high 恒携带;""=显式关;唯一权威,
 *    旧 coding.llm.reasoningEffort 对主轨不再生效——2026-10-20 用户拍板);
 *  - review 未显式配置也建 provider,effort 缺省 xhigh,可经 coding.models.review.reasoningEffort
 *    显式覆盖(""=关);
 * - subagent未显式配 model=undefined 回退主
 *    provider(同实例同模型同档位,主模型热切天然跟随);显式配 model 才按 review 同语义建独立实例。
 * explicitReasoningEffort 纯函数(audio.chat 轨仍在用)保持 语义不变。
 * fetch 桩捕获请求体(无网络;端到端 dump 见)。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { buildLlmFromConfig, buildModelProviders, explicitReasoningEffort } from "../src/factory.js";
import type { Config } from "@lampgenie/core";

const origFetch = globalThis.fetch;
const origKey = process.env.GENIE_LLM_API_KEY;
beforeEach(() => { process.env.GENIE_LLM_API_KEY = "test-key-not-real"; }); // 凭证解析面只验在场,非真凭证
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.GENIE_LLM_API_KEY; else process.env.GENIE_LLM_API_KEY = origKey;
});

const baseConfig = (reasoningEffort?: string, implementationEffort?: string) => ({
  coding: {
    llm: {
      baseUrl: "https://llm.test/v1", model: "m1", apiKeyEnv: "K",
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(implementationEffort !== undefined ? { implementationEffort } : {}),
    },
    models: {},
    disabledModels: [],
  },
  audio: { chat: {}, asr: {}, tts: {} },
  providers: [],
  executor: { kind: "echo" },
  gateway: { port: 7700, panel: true },
} as unknown as Config);

function captureBody(): { body: Record<string, unknown> | undefined; calls: number } {
  const state = { body: undefined as Record<string, unknown> | undefined, calls: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    state.calls++;
    state.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

describe("explicitReasoningEffort 判定(纯函数,audio.chat 轨沿用)", () => {
  it("user/project/env 层=显式携带;default 层/无 sources/空值=不携带", () => {
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "project" }, "coding.llm.reasoningEffort", "xhigh")).toBe("xhigh");
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "user" }, "coding.llm.reasoningEffort", "low")).toBe("low");
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "env" }, "coding.llm.reasoningEffort", "high")).toBe("high");
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "default" }, "coding.llm.reasoningEffort", "high")).toBeUndefined();
    expect(explicitReasoningEffort(undefined, "coding.llm.reasoningEffort", "high")).toBeUndefined();
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "project" }, "coding.llm.reasoningEffort", "")).toBeUndefined();
    expect(explicitReasoningEffort({ "coding.llm.reasoningEffort": "project" }, "coding.llm.reasoningEffort", undefined)).toBeUndefined();
  });
});

describe("buildLlmFromConfig 装配(主实施轨=implementationEffort, O2)", () => {
  it("未配置 → 请求体恒带 reasoning_effort=high(实施轨缺省档)", async () => {
    const state = captureBody();
    const llm = buildLlmFromConfig(baseConfig(), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.calls).toBe(1);
    expect(state.body?.reasoning_effort).toBe("high");
  });

  it("显式 implementationEffort=xhigh → 携带 xhigh(覆盖缺省)", async () => {
    const state = captureBody();
    const llm = buildLlmFromConfig(baseConfig(undefined, "xhigh"), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.body?.reasoning_effort).toBe("xhigh");
  });

  it("旧 coding.llm.reasoningEffort 对主轨不再生效(显式 xhigh 也不带走主轨)", async () => {
    const state = captureBody();
    const llm = buildLlmFromConfig(baseConfig("xhigh"), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.body?.reasoning_effort).toBe("high"); // implementationEffort 缺省,不被旧字段覆盖
  });

  it("implementationEffort=空串=显式关(不带);热更 update 语义保持(空=关,档位=带)", async () => {
    const state = captureBody();
    const llm = buildLlmFromConfig(baseConfig(undefined, ""), "/tmp")!;
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.body && "reasoning_effort" in state.body).toBe(false);
    // cfg.set 热路径同形(provider.update):档位→带,空→关
    (llm as unknown as { update: (p: Record<string, unknown>) => void }).update({ reasoningEffort: "low" });
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.body?.reasoning_effort).toBe("low");
    (llm as unknown as { update: (p: Record<string, unknown>) => void }).update({ reasoningEffort: "" });
    await llm.chat([{ role: "user", content: "hi" }], []);
    expect(state.body && "reasoning_effort" in state.body).toBe(false);
  });
});

describe("buildModelProviders 角色分档( O2;2026-10-20 subagent 改跟随主轨)", () => {
  it("subagent 未显式配 model → undefined(回退主 provider=同实例同模型同 effort,与主 agent 完全一致)", () => {
    const providers = buildModelProviders(baseConfig(), "/tmp");
    expect(providers.subagent).toBeUndefined();
    expect(providers.main).toBeDefined();
  });

  it("subagent 显式配 model → 独立实例(高级用法);review 语义不变(未配也建,effort xhigh)", () => {
    const providers = buildModelProviders(
      { ...baseConfig(), coding: { ...baseConfig().coding, models: { subagent: {} as { model?: string }, review: {} as { model?: string } } } } as unknown as Config,
      "/tmp",
    );
    expect(providers.subagent).toBeUndefined(); // 只配 reasoningEffort 不配 model 仍=跟随主轨
    expect(providers.review).toBeDefined(); // review 保持恒建
  });

  it("角色模型名仍落位;effort=角色档(xhigh),不再继承轨级 reasoningEffort", async () => {
    const explicit = captureBody();
    const providers = buildModelProviders(
      { ...baseConfig("xhigh"), coding: { ...baseConfig("xhigh").coding, models: { subagent: { model: "sub-m" }, compact: { model: "cmp-m" }, review: { model: "rev-m" } } } } as unknown as Config,
      "/tmp",
    );
    expect(providers.subagent!.modelName).toBe("sub-m");
    expect(providers.compact!.modelName).toBe("cmp-m");
    expect(providers.review!.modelName).toBe("rev-m");
    await providers.subagent!.chat([{ role: "user", content: "hi" }], []);
    expect(explicit.body?.reasoning_effort).toBe("xhigh"); // 角色缺省 xhigh(与主轨 high 分档)

    const silent = captureBody();
    const providers2 = buildModelProviders(
      { ...baseConfig(), coding: { ...baseConfig().coding, models: { subagent: { model: "sub-m", reasoningEffort: "" } } } } as unknown as Config,
      "/tmp",
    );
    await providers2.subagent!.chat([{ role: "user", content: "hi" }], []);
    expect(silent.body && "reasoning_effort" in silent.body).toBe(false); // 角色显式关=不带
  });
});

describe("buildModelProviders digest 角色(2026-11 提炼模型)", () => {
  it("配 coding.models.digest.model → models.digest 存在且 modelName 正确", () => {
    const providers = buildModelProviders(
      { ...baseConfig(), coding: { ...baseConfig().coding, models: { digest: { model: "dgt-m" } } } } as unknown as Config,
      "/tmp",
    );
    expect(providers.digest).toBeDefined();
    expect(providers.digest!.modelName).toBe("dgt-m");
  });

  it("未配 digest → models.digest === undefined(调用方回退 compact)", () => {
    const providers = buildModelProviders(baseConfig(), "/tmp");
    expect(providers.digest).toBeUndefined();
  });
});
