/**
 * env 占用甄别(2026-10-19 模型切换失效根治配套):loadConfig 层级 user→project→env 压顶,
 * GENIE_LLM_* 在场时面板切模型永远不生效(写盘成功但运行时/重启都被 env 盖回)。
 * envOccupiedOf 只挑 sources 标 env 的键;envOccupiedHint 点名对应环境变量。
 */
import { describe, it, expect } from "vitest";
import { envOccupiedOf, envOccupiedHint, legacyEnvContamination } from "../src/cfg-env-occupancy.js";

describe("envOccupiedOf", () => {
  const sources = {
    "coding.llm.model": "env",
    "coding.llm.baseUrl": "env",
    "coding.llm.providerId": "project",
    "permissions.mode": "project",
  };

  it("① 只报 env 层占用的键;project/default 层不报", () => {
    const applied = ["coding.llm.model", "coding.llm.providerId", "permissions.mode"];
    expect(envOccupiedOf(applied, sources)).toEqual(["coding.llm.model"]);
  });

  it("② sources 缺席/空 applied=空清单(不误报)", () => {
    expect(envOccupiedOf(["coding.llm.model"], undefined)).toEqual([]);
    expect(envOccupiedOf([], sources)).toEqual([]);
  });
});

describe("envOccupiedHint", () => {
  it("③ 点名 GENIE_LLM_MODEL/BASE_URL;audio 键点 GENIE_AUDIO_CHAT_*;未知键用通用话术", () => {
    expect(envOccupiedHint(["coding.llm.model", "coding.llm.baseUrl"])).toContain("GENIE_LLM_MODEL");
    expect(envOccupiedHint(["coding.llm.model", "coding.llm.baseUrl"])).toContain("GENIE_LLM_BASE_URL");
    expect(envOccupiedHint(["audio.chat.model"])).toContain("GENIE_AUDIO_CHAT_MODEL");
    expect(envOccupiedHint(["gateway.port"])).toContain("env 占用");
    expect(envOccupiedHint(["coding.llm.apiKeyEnv"])).toContain("GENIE_LLM_API_KEY");
  });
});

describe("legacyEnvContamination", () => {
  it("MODEL/BASE_URL 一旦在场就报;API_KEY 只在路由用专属键且专属 env 缺失时报", () => {
    const env = { GENIE_LLM_MODEL: "m", GENIE_LLM_BASE_URL: "https://old", GENIE_LLM_API_KEY: "old-key" } as NodeJS.ProcessEnv;
    expect(legacyEnvContamination(env, "BIGMODEL_KEY")).toEqual(["GENIE_LLM_MODEL", "GENIE_LLM_BASE_URL", "GENIE_LLM_API_KEY"]);
    expect(legacyEnvContamination({ ...env, BIGMODEL_KEY: "specific" }, "BIGMODEL_KEY")).toEqual(["GENIE_LLM_MODEL", "GENIE_LLM_BASE_URL"]);
    expect(legacyEnvContamination({ GENIE_LLM_API_KEY: "only-legacy" }, "GENIE_LLM_API_KEY")).toEqual(["GENIE_LLM_API_KEY"]);
  });
});
