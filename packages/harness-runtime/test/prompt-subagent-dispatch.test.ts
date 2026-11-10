import { describe, it, expect } from "vitest";
import { composeSystemPrompt, renderSubagentDispatchSection, renderSubagentHeavyOpDiscipline } from "../src/agent/system-composer";

describe("system-composer 子代理资源调度节(step-071 D7)", () => {
  const base = "你是 lampgenie-harness 的 vibe coding 主 agent(代表 identity 节)。";

  it("subagentDispatch 缺席=不渲染该节(与旧版零差异)", () => {
    const before = composeSystemPrompt({ base, tools: [{ name: "spawn_subagent", hint: "派子任务" }] });
    expect(before.sections.map((s) => s.name)).toEqual(["identity", "tools"]);
    expect(before.text).not.toContain("子代理资源调度");
  });

  it("subagentDispatch 在场=独立 subagent-dispatch 节,位于 tools 之后", () => {
    const after = composeSystemPrompt({
      base,
      tools: [{ name: "spawn_subagent", hint: "派子任务" }],
      subagentDispatch: renderSubagentDispatchSection({ answerToolMounted: true }),
    });
    expect(after.sections.map((s) => s.name)).toEqual(["identity", "tools", "subagent-dispatch"]);
    expect(after.sections.every((s) => s.cacheHint === "dynamic" || s.name === "identity")).toBe(true);
    expect(after.text).toContain("## 子代理资源调度(重操作审批)");
    expect(after.text).toContain("answer_subagent");
  });

  it("父节内容三要素:spawn 告知义务/决策三点/不应答=超时拒绝;精简 ≤900 字符", () => {
    const s = renderSubagentDispatchSection({ answerToolMounted: true });
    expect(s).toContain("任务书里写明预期命令");
    expect(s).toContain("不要拆分命令绕行");
    expect(s).toContain("必要性");
    expect(s).toContain("资源余量");
    expect(s).toContain("重操作在跑");
    expect(s).toContain("超时自动拒绝");
    expect(s).toContain("父代理自己执行重操作不受此闸");
    expect(s.length).toBeLessThanOrEqual(900);
    // 未挂载应答工具时不提工具名(提示词只提在场工具纪律)
    const s2 = renderSubagentDispatchSection();
    expect(s2).not.toContain("answer_subagent");
  });

  it("字符数对比:同输入加节后的增量=节长度+分隔(报告数字锚)", () => {
    const before = composeSystemPrompt({ base }).text.length;
    const dispatch = renderSubagentDispatchSection({ answerToolMounted: true });
    const after = composeSystemPrompt({ base, subagentDispatch: dispatch }).text.length;
    expect(after - before).toBe(dispatch.length + 2); // "\n\n" 连接
    // 子代理纪律块形态:先申请/不绕行/如实报告三禁;精简 ≤400 字符
    const d = renderSubagentHeavyOpDiscipline();
    expect(d).toContain("如实等待审批结果");
    expect(d).toContain("禁止拆分命令、换等价命令或改写命令字面来规避判定");
    expect(d).toContain("最终报告里如实说明");
    expect(d.length).toBeLessThanOrEqual(400);
  });
});
