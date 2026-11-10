import { describe, it, expect } from "vitest";
import { hasSensitiveText } from "@lampgenie/runtime/core/sensitive-content";

describe("敏感内容硬闸门(memory 入库前必过)", () => {
  it("API key 模式被拒", () => {
    expect(hasSensitiveText("我的 key 是 sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });
  it("普通偏好内容放行", () => {
    expect(hasSensitiveText("我喜欢用深色主题")).toBe(false);
  });
});
