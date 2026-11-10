import { describe, it, expect } from "vitest";
import { buildFactsLedger } from "../src/agent/facts-ledger";
import type { Message } from "../src/agent/loop";

describe("facts-ledger:压缩前的关键事实台账", () => {
  it("抽取错误/测试/路径/动作锚点", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "src/auth.ts" }) }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        content: [
          "Traceback (most recent call last):",
          "  at src/auth.ts:42:5",
          "FAILED tests/auth.test.ts::login",
          "PASSED tests/other.test.ts::ok",
        ].join("\n"),
      },
    ];
    const { text, lineCount } = buildFactsLedger(messages);
    expect(text).toContain("[错误/异常]");
    expect(text).toContain("Traceback");
    expect(text).toContain("[测试结果]");
    expect(text).toContain("FAILED tests/auth.test.ts::login");
    expect(text).toContain("[关键路径]");
    expect(text).toContain("src/auth.ts:42");
    expect(text).toContain("[动作锚点]");
    expect(text).toContain("read_file path=src/auth.ts");
    expect(lineCount).toBeGreaterThan(0);
  });

  it("跳过 microcompact 占位行(折叠说明不是事实)", () => {
    const messages: Message[] = [
      {
        role: "tool",
        toolCallId: "c1",
        content: "[工具结果已精炼:read_file src/a.ts 原共 9000 字符,中段 4000 字符已剪除]",
      },
    ];
    expect(buildFactsLedger(messages).text).toBe("");
  });

  it("同一条事实只入账一次", () => {
    const messages: Message[] = [
      { role: "tool", toolCallId: "c1", content: "src/a.ts:10" },
      { role: "tool", toolCallId: "c2", content: "src/a.ts:10" },
    ];
    const text = buildFactsLedger(messages).text;
    expect(text.split("src/a.ts:10").length - 1).toBe(1);
  });

  it("总量有上限,不把台账变成新的膨胀源", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Error: failure ${i} at src/f${i}.ts:${i + 1}`);
    const messages: Message[] = [{ role: "tool", toolCallId: "c1", content: lines.join("\n") }];
    const { text } = buildFactsLedger(messages);
    expect(text.length).toBeLessThanOrEqual(3_000);
  });
});
