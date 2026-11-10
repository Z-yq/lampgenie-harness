/**
 * 模型选择 → Provider 路由(2026-10-20 Provider Registry 语义)。
 * 核心断言:选择是 (providerId, model) 对;模型在谁家目录里,端点/协议/凭证就必须用谁家的;
 * 绝不允许「模型来自 A 家、baseUrl/key 还是 B 家」的半切换。
 */
import { describe, it, expect } from "vitest";
import { ConfigSchema, findModelProvider, resolveCodingModelRoute } from "../src/index.js";

const base = () => ConfigSchema.parse({
  providers: [
    {
      id: "main", name: "主端点", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", models: ["glm-5.3", "deepseek-v4.1-flash-1017"],
    },
    {
      id: "bigmodel-plan", name: "智谱套餐", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", apiType: "anthropic",
      models: [{ name: "GLM-5.3", contextWindow: 1_000_000 }, { name: "GLM-5.3-Flash" }],
    },
  ],
  coding: {
    llm: {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "deepseek-v4.1-flash-1017",
    },
  },
});

describe("findModelProvider", () => {
  it("精确匹配唯一拥有者;大小写不同不算同一模型", () => {
    const c = base();
    expect(findModelProvider(c, "GLM-5.3")?.id).toBe("bigmodel-plan");
    expect(findModelProvider(c, "glm-5.3")?.id).toBe("main");
    expect(findModelProvider(c, "不存在")).toBeUndefined();
  });

  it("精确无命中时才做大小写不敏感匹配,且多义不猜", () => {
    const c = ConfigSchema.parse({
      providers: [
        { id: "a", baseUrl: "https://a", models: ["Foo-Bar"] },
        { id: "b", baseUrl: "https://b", models: ["foo-bar"] },
      ],
    });
    expect(findModelProvider(c, "foo-bar")?.id).toBe("b"); // 精确命中
    expect(findModelProvider(c, "FOO-BAR")).toBeUndefined(); // 两个大小写近似 + 无精确 → 不猜
    const one = ConfigSchema.parse({ providers: [{ id: "a", baseUrl: "https://a", models: ["Foo-Bar"] }] });
    expect(findModelProvider(one, "FOO-BAR")?.id).toBe("a"); // 唯一近似 → 允许
  });
});

describe("resolveCodingModelRoute:模型拥有者决定路由", () => {
  it("只发 model(路由仍是旧端点)→ 自动切到模型拥有者,含 apiKeyEnv/apiType", () => {
    const c = base();
    const r = resolveCodingModelRoute(c, { model: "GLM-5.3" });
    expect(r).toMatchObject({
      model: "GLM-5.3",
      providerId: "bigmodel-plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY",
      apiType: "anthropic",
      unverified: false,
    });
  });

  it("providerId 与模型不匹配 → 以模型拥有者为准(拒绝「模型新、路由旧」)", () => {
    const c = base();
    const r = resolveCodingModelRoute(c, {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "GLM-5.3",
    });
    expect(r.providerId).toBe("bigmodel-plan");
    expect(r.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(r.apiKeyEnv).toBe("BIGMODEL_CODING_PLAN_API_KEY");
    expect(r.apiType).toBe("anthropic");
  });

  it("切回小写 glm-5.3 → 回到主端点(chat 协议)", () => {
    const c = base();
    const r = resolveCodingModelRoute(c, {
      providerId: "bigmodel-plan", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", model: "glm-5.3",
    });
    expect(r.providerId).toBe("main");
    expect(r.baseUrl).toBe("https://aliyun.example/compatible-mode");
    expect(r.apiKeyEnv).toBe("GENIE_LLM_API_KEY");
    expect(r.apiType).toBeUndefined();
  });

  it("自定义 baseUrl(非任何 Provider 端点)保留,协议不继承;Provider 专属 keyEnv 仍生效", () => {
    const c = base();
    const r = resolveCodingModelRoute(c, {
      providerId: "bigmodel-plan", baseUrl: "https://my-proxy.example/v1", model: "GLM-5.3",
    });
    expect(r.baseUrl).toBe("https://my-proxy.example/v1");
    expect(r.apiKeyEnv).toBe("BIGMODEL_CODING_PLAN_API_KEY");
    expect(r.apiType).toBeUndefined(); // 不知道代理后面是什么协议 → 按 chat
  });

  it("同一模型名出现在多家目录时,显式 providerId 优先(端点拉取会合并同名 ID)", () => {
    const c = ConfigSchema.parse({
      providers: [
        { id: "a", baseUrl: "https://a", apiKeyEnv: "A_KEY", models: ["shared-model"] },
        { id: "b", baseUrl: "https://b", apiKeyEnv: "B_KEY", apiType: "anthropic", models: ["shared-model"] },
      ],
      coding: { llm: { providerId: "b", model: "shared-model" } },
    });
    const r = resolveCodingModelRoute(c, c.coding.llm);
    expect(r.providerId).toBe("b");
    expect(r.baseUrl).toBe("https://b");
    expect(r.apiKeyEnv).toBe("B_KEY");
    expect(r.apiType).toBe("anthropic");
    expect(r.unverified).toBe(false);
  });

  it("手填模型(不在任何目录)= unverified,保留显式路由", () => {
    const c = base();
    const r = resolveCodingModelRoute(c, {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "my-custom-model",
    });
    expect(r.providerId).toBe("main");
    expect(r.baseUrl).toBe("https://aliyun.example/compatible-mode");
    expect(r.apiKeyEnv).toBe("GENIE_LLM_API_KEY");
    expect(r.unverified).toBe(true);
  });
});
