import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_AGENT_PROFILES, loadAgentProfiles, formatAgentProfiles, composeSubagentInstructions } from "../src/agent/agent-profiles.js";

const tmp = () => mkdtempSync(join(tmpdir(), "zh-agents-"));

describe("agent-profiles", () => {
  it("内置 6 型:worker/explore/judge/test-analyst/planner/ppt-master(与 workflow 模板名对齐;planner=step-138;ppt-master=2026-11-05)", () => {
    expect(BUILTIN_AGENT_PROFILES.map((p) => p.name)).toEqual(["worker", "explore", "judge", "test-analyst", "planner", "ppt-master"]);
    expect(BUILTIN_AGENT_PROFILES.every((p) => p.systemPrompt.length > 40 && p.description.length > 5)).toBe(true);
  });
  it("ppt-master 角色:判型/四步流水/版式容量/能力边界/反模式齐备,工具面是产出面(2026-11-05)", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "ppt-master")!;
    const s = p.systemPrompt;
    // 判型按产物生命周期,不按话题
    expect(s).toContain("产物生命周期与变更模型");
    // 四步各有门
    for (const k of ["Step 1 立项", "Step 2 结构", "Step 3 页级正文", "Step 4 导出与过门"]) expect(s).toContain(k);
    // 单一页面设计源 + 导出器只读不推断
    expect(s).toContain("唯一页面设计源");
    expect(s).toContain("不猜");
    // 能力边界必须如实(不许承诺原生编辑既有 pptx)
    expect(s).toContain("不能原生编辑");
    expect(s).toContain("做不到");
    // 反模式:改校验器绕门 = 红线
    expect(s).toContain("改阈值/绕门");
    // 工具面:产出面(读+写+exec+技能+导出),不派子代理
    expect(p.tools).toEqual(["read", "write", "exec", "code_sense", "skill_view", "board_export_pptx", "board_read"]);
    expect(p.tools).not.toContain("spawn_subagent");
  });

  it("planner 落板口径=画现状逻辑(含大主线)不画执行进度(2026-10-23 讨论结论守卫)", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!;
    const s = p.systemPrompt;
    // 2026-11 口径变更:板画现有代码/内容怎么走(逻辑为主),agent 的实施计划留在 step.md
    expect(s).toContain("代码/内容逻辑图");
    expect(s).toContain("现在怎么走");
    expect(s).not.toContain("画「计划」,不画「进度」");
    expect(s).toContain("入口→主线→出口");
    expect(s).toContain("不画");
    expect(s).toContain("执行进度");
    expect(s).toContain("task_phase");
    // 上轮过头的「不画执行流程」全禁口径不得回退
    expect(s).not.toContain("不画执行流程");
    expect(s).not.toContain("不画执行流程,不画");
  });
  it("planner 勘察预算/产出优先/并发前缀纪律(实测 3 个 planner 全撞时间盒零产出)", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!;
    const s = p.systemPrompt;
    expect(s).toContain("勘察预算");
    expect(s).toContain("唯一前缀");
    expect(s).toContain("骨架板");
    expect(s).toContain("产出优先");
    // 数字预算与「任何时刻被收割都必须已有板 + step.md」不得退化
    expect(s).toContain("25 次工具调用");
    expect(s).toContain("step.md");
  });
  it("planner 自报 scope 纪律(t2):并行落板主动传 scope 短前缀,不依赖系统派生的 p+4 位随机码", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!;
    const s = p.systemPrompt;
    expect(s).toContain("scope");
    expect(s).toContain("自报");
    expect(s).toContain("短前缀");
    // 「同一 planner 全程同一个 scope」不得退化(换 scope=换分区,旧节点看着像丢了)
    expect(s).toContain("同一个 scope");
    // 系统派生形态要点名,否则 planner 不知道不传会发生什么
    expect(s).toContain("pqa6e");
  });
  it("worker 勘察预算:步数上限 + 产出优先 + 到线先交(2026-10-29 token 轮 P2)", () => {
    // 实测驱动:24h 内 spawn_subagent 61 次,多个因无限勘察被时间盒收割、零文本产出
    // (其中 2/2 本轮实测的 worker 都超时零产出)。planner 早有预算纪律,worker 一直没有。
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "worker")!;
    const s = p.systemPrompt;
    expect(s).toContain("勘察预算");
    expect(s).toContain("不超过 12 次"); // 步数上限
    expect(s).toContain("60%");          // 时间盒比例
    expect(s).toContain("产出优先");      // 被打断也要能交付
    expect(s).toContain("未覆盖部分");    // 到线先交部分结论
    // negative 不得写成「无限勘察直到任务书全覆盖」
    expect(s).not.toContain("覆盖全部再返回");
  });

it("negative planner 预算纪律未被子代理改动污染(planner 仍有自己的时间盒/产出优先)", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "planner")!;
    expect(p.systemPrompt.length).toBeGreaterThan(0);
    // planner 的预算文本由 planner 自己的提示词承载,不应依赖 worker 那段
    expect(p.systemPrompt).not.toContain("勘察预算(2026-10-29 token 轮 P2");
  });

it("worker 输出契约:三段(结论/证据 file:line/未完成)+ ≤1200 字上限 + 禁复述任务书(2026-11 轮 05)", () => {
    const p = BUILTIN_AGENT_PROFILES.find((x) => x.name === "worker")!;
    const s = p.systemPrompt;
    expect(s).toContain("1200"); // 总长上限(字符口径)
    expect(s).toContain("file:line"); // 证据必须是可核地址
    expect(s).toContain("不复述任务书");
    expect(s).toContain("未完成项");
    expect(s).toContain("结论一行");
    expect(s).toContain("5 行"); // 不贴超过 5 行代码块
    // 旧的「四类结果(语法/单元/MVP/主链路)」输出格式本轮废弃,不得回退
    expect(s).not.toContain("四类结果");
    expect(s).not.toContain("MVP 行为");
    // 诚实性约束必须保留:失败如实 / 偏离点名 / 不创建文档
    expect(s).toContain("失败如实说失败");
    expect(s).toContain("不编造成功");
    expect(s).toContain("偏离任务书");
    expect(s).toContain("不创建任何文件");
  });
  it("markdown 覆盖内置同名 + 新增自定义类型(frontmatter+正文=systemPrompt)", () => {
    const root = tmp();
    mkdirSync(join(root, ".genie", "agents"), { recursive: true });
    writeFileSync(join(root, ".genie", "agents", "judge.md"), `---
name: judge
description: 我的定制评审员
tools: code_sense, code_review
---
只按我的标准评。`, "utf-8");
    writeFileSync(join(root, ".genie", "agents", "custom.md"), `---
name: translator
description: 中英翻译
---
只做翻译。`, "utf-8");
    const ps = loadAgentProfiles(root);
    const judge = ps.find((p) => p.name === "judge")!;
    expect(judge.builtin).toBe(false);
    expect(judge.systemPrompt).toBe("只按我的标准评。");
    expect(judge.tools).toEqual(["code_sense", "code_review"]);
    expect(ps.find((p) => p.name === "translator")).toBeTruthy();
    expect(ps.find((p) => p.name === "worker")!.builtin).toBe(true); // 未覆盖保留
  });
  it("formatAgentProfiles 清单格式(注入主 agent)", () => {
    const out = formatAgentProfiles(BUILTIN_AGENT_PROFILES);
    expect(out).toContain("可用子智能体类型");
    expect(out).toContain("- worker:");
    expect(out).toContain("- explore:");
  });
  it("composeSubagentInstructions:类型前缀进任务书;未知类型=原任务书", () => {
    const out = composeSubagentInstructions(BUILTIN_AGENT_PROFILES, "explore", "查 X");
    expect(out.startsWith("【子智能体角色:explore】")).toBe(true);
    expect(out).toContain("【任务书】\n查 X");
    expect(composeSubagentInstructions(BUILTIN_AGENT_PROFILES, undefined, "查 X")).toBe("查 X");
    expect(composeSubagentInstructions(BUILTIN_AGENT_PROFILES, "不存在", "查 X")).toBe("查 X");
  });
});
