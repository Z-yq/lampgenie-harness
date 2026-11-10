/**
 * O2/O3/O4 装配面测试(gateway 侧):
 * O2:effort-policy 纯函数(主=high、review/subagent=xhigh、显式覆盖)+ buildModelProviders
 *     按角色建 provider(未配 roles 也建;effort 值进请求体)。
 * O3:autoCompactGate 阈值口径对齐 ZCode(窗口−min(out,21000)−13000;显式阈值仅无窗口兜底)。
 * O4:请求 max_tokens 默认 32000(meta 只当上限);显式 >32k 保留+warning;reserve=min(实际,21000)。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { resolveImplementationEffort, resolveRoleEffort } from "../src/effort-policy.js";
import { resolveRequestMaxTokens, DEFAULT_REQUEST_MAX_TOKENS } from "../src/request-budget.js";
import { autoCompactGate, autoCompactOutputReserve, AUTOCOMPACT_BUFFER_TOKENS, type GateEvent } from "../src/compact-gate.js";
import { buildModelProviders } from "../src/factory.js";
import type { Config } from "@lampgenie/core";

// ---- 公共桩:捕获请求体,无网络 ----
const origFetch = globalThis.fetch;
const origKey = process.env.GENIE_LLM_API_KEY;
beforeEach(() => { process.env.GENIE_LLM_API_KEY = "test-key-not-real"; });
afterEach(() => {
  globalThis.fetch = origFetch;
  if (origKey === undefined) delete process.env.GENIE_LLM_API_KEY; else process.env.GENIE_LLM_API_KEY = origKey;
});
function captureBody(): { body: Record<string, unknown> | undefined; calls: number } {
  const state = { body: undefined as Record<string, unknown> | undefined, calls: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    state.calls++;
    state.body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return state;
}

const baseConfig = (over: {
  implementationEffort?: string;
  llmMaxTokens?: number;
  review?: { model?: string; reasoningEffort?: string };
  subagent?: { model?: string; reasoningEffort?: string };
  compact?: { model?: string; reasoningEffort?: string };
} = {}) => ({
  coding: {
    llm: {
      baseUrl: "https://llm.test/v1", model: "m1", apiKeyEnv: "K",
      ...(over.implementationEffort !== undefined ? { implementationEffort: over.implementationEffort } : {}),
      ...(over.llmMaxTokens !== undefined ? { maxTokens: over.llmMaxTokens } : {}),
    },
    models: {
      ...(over.review ? { review: over.review } : {}),
      ...(over.subagent ? { subagent: over.subagent } : {}),
      ...(over.compact ? { compact: over.compact } : {}),
    },
    disabledModels: [],
  },
  audio: { chat: {}, asr: {}, tts: {} },
  providers: [],
  executor: { kind: "echo" },
  gateway: { port: 7700, panel: true },
} as unknown as Config);

describe("O2 effort-policy 纯函数", () => {
  it("主实施轨:未配置=high;显式覆盖生效;空串=显式关(undefined)", () => {
    expect(resolveImplementationEffort(undefined)).toBe("high");
    expect(resolveImplementationEffort("xhigh")).toBe("xhigh");
    expect(resolveImplementationEffort("low")).toBe("low");
    expect(resolveImplementationEffort("")).toBeUndefined();
  });

  it("角色轨:review/subagent/compact 未配置=xhigh;显式覆盖生效;空串=关", () => {
    expect(resolveRoleEffort(undefined)).toBe("xhigh");
    expect(resolveRoleEffort("medium")).toBe("medium");
    expect(resolveRoleEffort("")).toBeUndefined();
  });
});

describe("O2 buildModelProviders 按角色分档", () => {
  it("未配置:review 也建(xhigh);subagent=undefined 回退主轨(2026-10-20 同模型口径);主=high", async () => {
    const mainCap = captureBody();
    const providers = buildModelProviders(baseConfig(), "/tmp");
    expect(providers.review).toBeTruthy();
    expect(providers.subagent).toBeUndefined(); // 子代理默认与主 agent 同模型(同实例同档位),不再恒建独立轨
    expect(providers.compact).toBeUndefined(); // compact 仍只在显式配置时建
    expect(providers.review!.modelName).toBe("m1");

    await providers.main!.chat([{ role: "user", content: "hi" }], []);
    expect(mainCap.body?.reasoning_effort).toBe("high"); // 主实施轨缺省 high

    const revCap = captureBody();
    await providers.review!.chat([{ role: "user", content: "hi" }], []);
    expect(revCap.body?.reasoning_effort).toBe("xhigh"); // 评审轨缺省 xhigh
  });

  it("显式覆盖生效:主=low、review=medium、subagent=空串(关)", async () => {
    const providers = buildModelProviders(baseConfig({
      implementationEffort: "low",
      review: { model: "rev-m", reasoningEffort: "medium" },
      subagent: { model: "sub-m", reasoningEffort: "" },
    }), "/tmp");
    const mainCap = captureBody();
    await providers.main!.chat([{ role: "user", content: "hi" }], []);
    expect(mainCap.body?.reasoning_effort).toBe("low");
    const revCap = captureBody();
    await providers.review!.chat([{ role: "user", content: "hi" }], []);
    expect(revCap.body?.reasoning_effort).toBe("medium");
    expect(providers.review!.modelName).toBe("rev-m");
    const subCap = captureBody();
    await providers.subagent!.chat([{ role: "user", content: "hi" }], []);
    expect(subCap.body && "reasoning_effort" in subCap.body).toBe(false); // 显式关=不带
  });

  it("旧 coding.llm.reasoningEffort 对主轨不再生效(implementationEffort 是唯一权威)", async () => {
    // schema 语义下 reasoningEffort 仍在 config 上(旧字段),但装配面只读 implementationEffort。
    const cfg = baseConfig() as unknown as { coding: { llm: Record<string, unknown> } };
    cfg.coding.llm.reasoningEffort = "xhigh";
    const providers = buildModelProviders(cfg as unknown as Config, "/tmp");
    const cap = captureBody();
    await providers.main!.chat([{ role: "user", content: "hi" }], []);
    expect(cap.body?.reasoning_effort).toBe("high"); // 不被旧字段 xhigh 带走
  });
});

describe("O3 autoCompactGate 阈值(ZCode 口径)", () => {
  let seq = 0;
  const ev = (kind: string, payload: Record<string, unknown> = {}): GateEvent => ({ kind, sessionId: "s1", seq: ++seq, payload });
  const thresholdOf = (contextWindow: number | undefined, fallback: number, maxOut?: number) =>
    autoCompactGate([ev("message.agent", { usage: { inputTokens: 1 } })], "s1", contextWindow, fallback, maxOut).threshold;
  /** 直接调纯函数并临时覆盖 env(验证封顶可关而窗口口径原值不变)。 */
  const thresholdWithEnv = (env: string, contextWindow: number, fallback: number, maxOut?: number) => {
    const prev = process.env.GENIE_MAX_COMPACT_TOKENS;
    process.env.GENIE_MAX_COMPACT_TOKENS = env;
    try {
      return autoCompactGate([ev("message.agent", { usage: { inputTokens: 1 } })], "s1", contextWindow, fallback, maxOut).threshold;
    } finally {
      if (prev === undefined) delete process.env.GENIE_MAX_COMPACT_TOKENS;
      else process.env.GENIE_MAX_COMPACT_TOKENS = prev;
    }
  };

  it("reserve = min(maxOutputTokens ?? 32000, 21000)", () => {
    expect(autoCompactOutputReserve(undefined)).toBe(21_000); // 32000 → 封顶 21000
    expect(autoCompactOutputReserve(128_000)).toBe(21_000);  // O4 显式 128k → 仍封顶 21000
    expect(autoCompactOutputReserve(16_000)).toBe(16_000);   // 小于封顶按实际
    expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(13_000);
  });

  it("(1M 窗口, 24000 显式)→300000(窗口口径 966000 被 MAX_COMPACT_TOKENS 封顶;显式阈值仍不作上限)", () => {
    expect(thresholdOf(1_000_000, 24_000)).toBe(300_000);
  });

  it("(200k 窗口, 无显式)→166000", () => {
    expect(thresholdOf(200_000, 0)).toBe(166_000);
  });

  it("(无窗口, 24000)→24000(显式阈值只在无窗口时兜底)", () => {
    expect(thresholdOf(undefined, 24_000)).toBe(24_000);
  });

  it("(无窗口, 无显式)→300000(0.8×缺省 1M 再受封顶)", () => {
    expect(thresholdOf(undefined, 0)).toBe(300_000);
  });

  it("maxOutputTokens 参与窗口口径(1M−16000−13000=971000),再受封顶 → 300000", () => {
    expect(thresholdOf(1_000_000, 24_000, 16_000)).toBe(300_000);
    // 关闭封顶时窗口口径原值可见(证明 maxOut 仍在参与计算,封顶是叠加层而非替换)
    expect(thresholdWithEnv("0", 1_000_000, 24_000, 16_000)).toBe(971_000);
  });

  it("极小窗口(8k)退回 80% 比例:6554(ZCode 式会算出 0=永远压缩)", () => {
    expect(thresholdOf(8192, 0)).toBe(6554);
  });
});

describe("O4 请求 max_tokens 收敛", () => {
  it("默认(无显式无 meta)=32000;meta 只当上限(meta 384k → 仍 32000)", () => {
    expect(DEFAULT_REQUEST_MAX_TOKENS).toBe(32_000);
    expect(resolveRequestMaxTokens(undefined, undefined).value).toBe(32_000);
    expect(resolveRequestMaxTokens(undefined, 384_000).value).toBe(32_000);
    expect(resolveRequestMaxTokens(undefined, 16_000).value).toBe(16_000); // meta 低于默认按 meta
  });

  it("显式 128000 保留 + warning;显式 ≤32k 无 warning", () => {
    const r = resolveRequestMaxTokens(128_000, undefined);
    expect(r.value).toBe(128_000);
    expect(r.warning).toBeTruthy();
    expect(r.warning).toContain("128000");
    const ok = resolveRequestMaxTokens(8_000, undefined);
    expect(ok.value).toBe(8_000);
    expect(ok.warning).toBeUndefined();
  });

  it("规则④(2026-10-21 400 [1210] 实测确认):显式值超过模型 meta 上限 → 钳制到 meta + warning", () => {
    // 残留形态:deepseek 的 384000 写进轨级,切到 GLM-5.3(meta 128000)
    const clamped = resolveRequestMaxTokens(384_000, 128_000);
    expect(clamped.value).toBe(128_000);
    expect(clamped.warning).toContain("384000");
    expect(clamped.warning).toContain("128000");
    // 显式 ≤ meta 时不受影响(保留既有语义)
    const fine = resolveRequestMaxTokens(128_000, 128_000);
    expect(fine.value).toBe(128_000);
    // meta 缺席时不钳制(无端点上限信息,维持规则②/③)
    const noMeta = resolveRequestMaxTokens(384_000, undefined);
    expect(noMeta.value).toBe(384_000);
    expect(noMeta.warning).toBeTruthy();
  });

  it("装配面:显式轨级 maxTokens 超过模型 meta → 请求体钳制到 meta(残留值不打穿端点)", async () => {
    const cfg = baseConfig({ llmMaxTokens: 384_000 }) as unknown as { providers: unknown[] };
    cfg.providers = [{ id: "main", baseUrl: "https://llm.test/v1", apiKeyEnv: "K", apiType: "chat", models: [{ name: "m1", contextWindow: 1_000_000, maxTokens: 131_072 }] }];
    const providers = buildModelProviders(cfg as unknown as Config, "/tmp");
    const cap = captureBody();
    await providers.main!.chat([{ role: "user", content: "hi" }], []);
    expect(cap.body?.max_tokens).toBe(131_072);
  });

  it("装配面:无显式 maxTokens 时请求体 max_tokens=32000(不再吃 model meta 大值)", async () => {
    // providers[].models 里 m1 条目带 maxTokens:384000(modelMetaOf 通道),装配仍应收敛到 32000。
    const cfg = baseConfig() as unknown as { providers: unknown[] };
    cfg.providers = [{ id: "main", baseUrl: "https://llm.test/v1", apiKeyEnv: "K", apiType: "chat", models: [{ name: "m1", contextWindow: 1_000_000, maxTokens: 384_000 }] }];
    const providers = buildModelProviders(cfg as unknown as Config, "/tmp");
    const cap = captureBody();
    await providers.main!.chat([{ role: "user", content: "hi" }], []);
    expect(cap.body?.max_tokens).toBe(32_000);
  });
});
