/**
 * 模型热切回归(2026-10-20 用户实报「最新的 session 用配置过的 GLM 模型一直不行」):
 * 根因=面板只发 model/旧路由,运行时拿旧端点+旧 key(智谱端点收到阿里云 Key → 401);
 * 且旧凭证回退让 env 的 GENIE_LLM_API_KEY 压过 Provider 专属密钥。
 * 这里锁死两组行为:选择即 Registry(路由由模型拥有者派生)+ 专属密钥优先。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, applyConfigPatch } from "@lampgenie/core";
import { reconcileCodingRoute, reconcileRoleRoute, resolveModelSwitch, resolveRoleSwitch } from "../src/model-switch.js";
import { buildModelProviders } from "../src/factory.js";

function tmpRepo(secrets: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gh-model-switch-"));
  mkdirSync(join(root, ".genie"), { recursive: true });
  writeFileSync(join(root, ".genie", "secrets.json"), JSON.stringify(secrets), "utf-8");
  return root;
}

const cfg = (llm: Record<string, unknown> = {}, models: Record<string, unknown> = {}) => ConfigSchema.parse({
  providers: [
    {
      id: "main", name: "主端点", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", models: ["glm-5.3", "deepseek-v4.1-flash-1017"],
    },
    {
      id: "bigmodel-plan", name: "智谱套餐", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", apiType: "anthropic",
      models: [{ name: "GLM-5.3" }, { name: "GLM-5.3-Flash" }],
    },
  ],
  coding: {
    llm: {
      providerId: "main", baseUrl: "https://aliyun.example/compatible-mode",
      apiKeyEnv: "GENIE_LLM_API_KEY", model: "deepseek-v4.1-flash-1017", ...llm,
    },
    models,
  },
});

const OLD_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in OLD_ENV)) delete process.env[k];
  for (const [k, v] of Object.entries(OLD_ENV)) process.env[k] = v;
});

describe("reconcileCodingRoute + resolveModelSwitch", () => {
  beforeEach(() => {
    delete process.env.GENIE_LLM_API_KEY;
    delete process.env.BIGMODEL_CODING_PLAN_API_KEY;
  });

  it("只发 model(旧路由仍在 config)→ 校正到智谱端点,并使用 Provider 专属密钥(不被 env 旧键压住)", () => {
    const root = tmpRepo({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "legacy-secret" });
    const base = cfg();
    const { next } = applyConfigPatch(base, { coding: { llm: { model: "GLM-5.3" } } });
    const rec = reconcileCodingRoute(next);
    expect(rec.changed).toEqual(["coding.llm.providerId", "coding.llm.baseUrl", "coding.llm.apiKeyEnv"]);
    expect(next.coding.llm).toMatchObject({
      providerId: "bigmodel-plan",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY",
      model: "GLM-5.3",
    });
    // 关键回归:env 里残留阿里云 GENIE_LLM_API_KEY 时,绝不能拿它打智谱端点(旧实现正是如此 → 401)。
    const r = resolveModelSwitch(next, root, { GENIE_LLM_API_KEY: "aliyun-env-key" } as NodeJS.ProcessEnv);
    expect(r.routeError).toBeUndefined();
    expect(r.hotLlm).toMatchObject({
      model: "GLM-5.3",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "bigmodel-secret",
      apiType: "anthropic",
    });
    expect(r.effective).toMatchObject({
      model: "GLM-5.3", providerId: "bigmodel-plan", apiType: "anthropic", credentialSource: "secrets", unverified: false,
    });
  });

  it("专属密钥完全缺失 → 不热切并返回可操作的 routeError(不再假装「已热应用」)", () => {
    const root = tmpRepo({});
    const base = cfg({ providerId: "bigmodel-plan", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", model: "GLM-5.3" });
    const r = resolveModelSwitch(base, root, {} as NodeJS.ProcessEnv);
    expect(r.hotLlm).toBeUndefined();
    expect(r.routeError).toContain("BIGMODEL_CODING_PLAN_API_KEY");
    expect(r.effective?.credentialSource).toBe("none");
  });

  it("切回阿里云小写模型 → 协议回到 chat、密钥回到 GENIE_LLM_API_KEY", () => {
    const root = tmpRepo({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const base = cfg({ providerId: "bigmodel-plan", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", model: "GLM-5.3" });
    const { next } = applyConfigPatch(base, { coding: { llm: { model: "glm-5.3" } } });
    reconcileCodingRoute(next);
    const r = resolveModelSwitch(next, root, {} as NodeJS.ProcessEnv);
    expect(r.hotLlm).toMatchObject({ model: "glm-5.3", baseUrl: "https://aliyun.example/compatible-mode", apiKey: "aliyun-secret", apiType: "chat" });
  });
});

describe("角色模型热切(role 只配 model)", () => {
  it("review 从 deepseek(阿里云)切到 GLM-5.3-Flash(智谱)→ 完整路由/凭证/协议一起切", () => {
    const root = tmpRepo({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const base = cfg({}, { review: { model: "deepseek-v4.1-flash-1017" } });
    const { next } = applyConfigPatch(base, { coding: { models: { review: { model: "GLM-5.3-Flash" } } } });
    const rec = reconcileRoleRoute(next, "review");
    expect(rec?.changed).toEqual(["coding.models.review.providerId", "coding.models.review.baseUrl", "coding.models.review.apiKeyEnv"]);
    const rr = resolveRoleSwitch(next, root, "review", {} as NodeJS.ProcessEnv);
    expect(rr?.hot).toMatchObject({
      model: "GLM-5.3-Flash",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "bigmodel-secret",
      apiType: "anthropic",
      reasoningEffort: "xhigh",
    });
  });

  it("digest 角色:配 model → hot 就绪且 effective.model 正确;未配 → undefined", () => {
    const root = tmpRepo({ GENIE_LLM_API_KEY: "test-digest-key" });
    const base = cfg({}, { digest: { model: "glm-5.3" } });
    reconcileRoleRoute(base, "digest");
    const rr = resolveRoleSwitch(base, root, "digest", {} as NodeJS.ProcessEnv);
    expect(rr?.hot).toBeDefined();
    expect(rr?.hot?.model).toBe("glm-5.3");
    expect(rr?.effective?.model).toBe("glm-5.3");
    expect(resolveRoleSwitch(cfg(), root, "digest", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("未配置 model 的角色(compact)不产生热切", () => {
    const root = tmpRepo({ GENIE_LLM_API_KEY: "aliyun-secret" });
    const base = cfg();
    expect(reconcileRoleRoute(base, "compact")).toBeUndefined();
    expect(resolveRoleSwitch(base, root, "compact", {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("buildModelProviders 角色路由(registry 语义)", () => {
  it("review 只配 model 时,端点/协议跟随模型拥有者,而不是盲目继承主轨", () => {
    const root = tmpRepo({
      BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret",
      GENIE_LLM_API_KEY: "aliyun-secret",
    });
    const c = cfg(
      { providerId: "bigmodel-plan", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "BIGMODEL_CODING_PLAN_API_KEY", model: "GLM-5.3" },
      { review: { model: "deepseek-v4.1-flash-1017" } },
    );
    const p = buildModelProviders(c, root);
    expect(p.main?.describe()).toMatchObject({
      model: "GLM-5.3", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiType: "anthropic",
    });
    expect(p.review?.describe()).toMatchObject({
      model: "deepseek-v4.1-flash-1017", baseUrl: "https://aliyun.example/compatible-mode", apiType: "chat",
    });
    // 2026-10-20 用户口径:子代理未显式配置=回退主 provider(与主 agent 同模型同端点),不再恒建独立轨
    expect(p.subagent).toBeUndefined();
  });

  it("主轨 config 的 providerId 与 model 不匹配时,装配按模型拥有者自愈", () => {
    const root = tmpRepo({ BIGMODEL_CODING_PLAN_API_KEY: "bigmodel-secret", GENIE_LLM_API_KEY: "aliyun-secret" });
    const c = cfg({ providerId: "main", baseUrl: "https://aliyun.example/compatible-mode", apiKeyEnv: "GENIE_LLM_API_KEY", model: "GLM-5.3" });
    const p = buildModelProviders(c, root);
    expect(p.main?.describe()).toMatchObject({
      model: "GLM-5.3", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiType: "anthropic",
    });
  });
});
