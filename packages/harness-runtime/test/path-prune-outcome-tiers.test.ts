import { describe, expect, it } from "vitest";
import {
  isFailureResult, renderAbandonedPlaceholderTiered,
  type PathAbandonedDeclaration,
} from "../src/agent/path-prune.js";

const decl: PathAbandonedDeclaration = {
  seq: 100, reason: "该方案与代价模型冲突", lesson: "",
  tools: new Set(["terminal"]), keywords: ["docker"], keepRecent: 3,
};

describe("path_prune 成败分档(缺口#15)", () => {
  it("失败结果:压狠档——无原文头,只留结论+锚点+失败行", () => {
    const content = "Step 1 ok\nStep 2\nError: connection refused ECONNREFUSED\nStack trace ...".repeat(20);
    expect(isFailureResult(content)).toBe(true);
    const { text, tier } = renderAbandonedPlaceholderTiered(decl, "call-1", content);
    expect(tier).toBe("failure");
    expect(text).toContain("toolCallId=call-1");
    expect(text).toContain("失败");
    expect(text).not.toContain("Stack trace"); // 原文细节不进占位
    expect(text.length).toBeLessThan(400); // 压狠
  });
  it("成功结果:留细节档——head+tail+寻址", () => {
    const content = Array.from({ length: 200 }, (_, i) => `line-${i} normal output`).join("\n");
    expect(isFailureResult(content)).toBe(false);
    const { text, tier } = renderAbandonedPlaceholderTiered(decl, "call-2", content);
    expect(tier).toBe("success");
    expect(text).toContain("原始输出(前 ");
    expect(text).toContain("尾部(末 ");
    expect(text).toContain("重跑/重读");
  });
  it("空串/正常输出不判失败", () => {
    expect(isFailureResult("")).toBe(false);
    expect(isFailureResult("all good, done")).toBe(false);
  });
});
