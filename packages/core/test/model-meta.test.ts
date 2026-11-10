import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { modelMetaOf } from "../src/config/load";

describe("providers[].models 条目元数据(,ZCode 模型管理)", () => {
  it("旧字符串形态兼容解析", () => {
    const c = ConfigSchema.parse({ providers: [{ id: "p1", baseUrl: "https://x", models: ["glm-5.3", "glm-5.3-flash"] }] });
    expect(c.providers![0]!.models[0]).toBe("glm-5.3"); // 字符串原样保留(union)
  });
  it("条目形态:contextWindow/maxTokens 解析", () => {
    const c = ConfigSchema.parse({ providers: [{ id: "p1", baseUrl: "https://x", models: [{ name: "GLM-5.3", contextWindow: 1_000_000, maxTokens: 32_000 }] }] });
    const meta = modelMetaOf(c as never, "GLM-5.3");
    expect(meta).toEqual({ contextWindow: 1_000_000, maxTokens: 32_000 });
  });
  it("modelMetaOf:未知名/字符串条目=null(走轨级回退)", () => {
    const c = ConfigSchema.parse({ providers: [{ id: "p1", baseUrl: "https://x", models: ["glm-5.3"] }] });
    expect(modelMetaOf(c as never, "glm-5.3")).toBeNull();
    expect(modelMetaOf(c as never, "unknown")).toBeNull();
    expect(modelMetaOf(c as never, undefined)).toBeNull();
  });
});
