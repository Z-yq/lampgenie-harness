/**
 * step-137 回归:chat 端点归一(chatCompletionsUrl)。
 * 覆盖实机踩到的形态:面板预设写入的 baseUrl 常自带 /v1。
 */
import { describe, expect, it } from "vitest";
import { chatCompletionsUrl } from "../src/agent/openai-provider.js";

describe("chatCompletionsUrl(baseUrl 归一)", () => {
  it("baseUrl 自带 /v1 不重复拼", () => {
    expect(chatCompletionsUrl("https://llm.test/v1")).toBe("https://llm.test/v1/chat/completions");
  });

  it("baseUrl 不带 /v1 → 补一次", () => {
    expect(chatCompletionsUrl("https://llm.test")).toBe("https://llm.test/v1/chat/completions");
  });

  it("尾斜杠 + 带 /v1 → 归一", () => {
    expect(chatCompletionsUrl("https://llm.test/v1/")).toBe("https://llm.test/v1/chat/completions");
  });

  it("实机形态:compatible-mode/v1(阿里云百炼)", () => {
    expect(chatCompletionsUrl("https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toBe(
      "https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
  });

  it("绝不产出 /v1/v1(旧 bug 形态)", () => {
    for (const base of ["https://x.test/v1", "https://x.test/v1/", "https://x.test"]) {
      expect(chatCompletionsUrl(base)).not.toContain("/v1/v1");
    }
  });

  it("路径中的 /v1 只在末尾时剥(兼容 …/compatible-mode/v1)", () => {
    expect(chatCompletionsUrl("https://x.test/api/v1beta")).toBe("https://x.test/api/v1beta/v1/chat/completions");
  });
});