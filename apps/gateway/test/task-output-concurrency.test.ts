import { AGENT_WIRING_SRC } from "./panel-source.js";
/**
 * task_output 降级回归(task_output 免独立往返)。
 * **级别说明:本文件是源码级断言,不是行为级。** task_output 工具对象定义在 wireAgentLoop
 * 函数体内部(`const taskOutputTool: Tool = {`,agent-wiring.ts:4156),构造它需要 Journal/executor/
 * 子代理注册表等全套 gateway 依赖——单测里没有可构造入口,硬启 gateway 会把纯断言变成 e2e。
 * 因此这里从**源文件文本**截取 taskOutputTool 定义块断言(与 panel-trace-error.test.ts 同一手法),
 * 验的是真身代码;若将来重命名/移动该工具,本测试会直接报「抽取失败」而不是静默通过。
 * 锁四件:
 *  ① 工具对象带 isConcurrencySafe: () => true(能与其他工具同一步并行,不再独占一个 step);
 *  ② description 口径改成「终态自动注入,通常无需调用」+「补查」,同时保留 waitFor/waitSec 语义;
 *  ③ 工具仍挂在 mainTools 里(没被删,只是降级);
 *  ④ 子代理「结构性不给」清单仍含 task_output(派发类工具不给子代理——未被误改)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = AGENT_WIRING_SRC;
const TEXT = readFileSync(SRC, "utf8");

/** 截取 taskOutputTool 定义块(到下一个工具定义 taskPhaseTool 之前)。 */
function taskOutputBlock(): string {
  const start = TEXT.indexOf("const taskOutputTool: Tool = {");
  const end = TEXT.indexOf("const taskPhaseTool: Tool = {");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("agent-wiring.ts 抽取失败:taskOutputTool 定义块找不到(工具被重命名或移动,请更新本测试)");
  }
  return TEXT.slice(start, end);
}

describe("task_output 并发安全(源码级断言)", () => {
  it("定义块内带 isConcurrencySafe: () => true", () => {
    const block = taskOutputBlock();
    expect(block).toMatch(/isConcurrencySafe:\s*\(\)\s*=>\s*true/);
    // 与「不可并发」的写法不能并存(防误留两行)
    expect(block).not.toMatch(/isConcurrencySafe:\s*\(\)\s*=>\s*false/);
  });

  it("仍是 task_output 工具本体(名字没被改)", () => {
    expect(taskOutputBlock()).toContain('name: "task_output"');
  });

  it("description 先说「自动注入、通常无需调用」,并给出补查场景与 waitFor/waitSec 语义", () => {
    const block = taskOutputBlock();
    const desc = block.slice(block.indexOf("description:"), block.indexOf("parameters:"));
    expect(desc).toContain("自动注入");
    expect(desc).toContain("补查");
    expect(desc).toContain("waitFor");
    expect(desc).toContain("waitSec");
    expect(desc).toContain("stale"); // 止损场景仍在说明里
  });

  it("工具仍挂在 mainTools 列表里(降级不删)", () => {
    const line = TEXT.split("\n").find((l) => l.includes("const mainTools: Tool[]") && l.includes("taskOutputTool"));
    expect(line, "mainTools 里找不到 taskOutputTool —— 工具被摘掉了").toBeTruthy();
  });

  it("子代理「结构性不给」清单没被误改(仍含 task_output)", () => {
    const idx = TEXT.indexOf("结构性不给");
    expect(idx).toBeGreaterThan(-1);
    const around = TEXT.slice(Math.max(0, idx - 400), idx + 400);
    expect(around).toContain("task_output");
  });

  it("工具面 hint 已同步为「结果通常已自动注入」口径", () => {
    const hintLine = TEXT.split("\n").find((l) => l.includes('name: "task_output",') && l.includes("hint:"));
    expect(hintLine, "找不到 task_output 的 hint 行").toBeTruthy();
    expect(hintLine!).toContain("自动注入");
  });
});
