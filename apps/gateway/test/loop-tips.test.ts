/**
 * tips 即时增强引擎( 「每条 user message 跟一条匹配式 tips」多余且
 * 常错配——模型上下文已含会话语境,code_sense 内容必须是拉取式)。契约:
 * - buildLoopTips 只剩功能性 tip:dispatch(首触 spawn_subagent)/board-comments(白板评论投递);
 * - code-orient/history-align 两类匹配式注入已删(回归锚:代码工具/规划工具/阶段事件都不再触发);
 * - kickoff 任务书不含 orient/经验/devlog/历史档案四块;
 * - GENIE_TIPS=off 全关。
 */
import { it, expect, afterEach } from "vitest";
import { createGatewayApp } from "../src/app.js";
import { buildExecutorFromConfig } from "../src/factory.js";
import { buildLoopTips } from "../src/agent-wiring.js";

const apps: ReturnType<typeof createGatewayApp>[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); delete process.env.GENIE_PERMISSION_RULES; });

/** 可见化:buildLoopTips 返回 {text,keys}(keys 供 tip.injected 留痕分类展示)。 */
const txt = (r: { text: string } | null) => (r ? r.text : null);

it("buildLoopTips:dispatch 首触 spawn_subagent 注入一次;代码/规划工具不再触发任何 tip(2026-10-23 回归锚)", () => {
  const tips = buildLoopTips({ sessionId: "s1" });
  expect(tips({ step: 1, lastStepTools: [] })).toBeNull();
 // 代码类/规划类工具: 版的 code-orient/history-align 已删——零注入
  expect(tips({ step: 1, lastStepTools: ["edit_file", "code_sense", "code_review"] })).toBeNull();
  expect(tips({ step: 1, lastStepTools: ["board_upsert", "run_workflow"] })).toBeNull();
  // 首触 spawn_subagent → dispatch(唯一留存的动作类 tip)
  const r = tips({ step: 2, lastStepTools: ["spawn_subagent"] });
  expect(txt(r)).toContain("派发 tips");
  expect(txt(r)).toContain("<system-reminder>");
  expect(r?.keys).toEqual(["dispatch"]);
  expect(tips({ step: 3, lastStepTools: ["spawn_subagent"] })).toBeNull(); // 一次为限
});

it("buildLoopTips:compact 后 fired 清空,dispatch 允许重注入一次(compact 计数增长触发)", () => {
 // compact 后 tip 失忆自愈:tips 是 ephemeral 不落 journal,autoCompact 之后模型
  // 看不见已注入的 tip;loop 每 step 带 ctx.compacts(compact.done 计数),计数增长=fired 清空。
  const tips = buildLoopTips({ sessionId: "s1" });
  expect(txt(tips({ step: 1, lastStepTools: ["spawn_subagent"], compacts: 0 }))).toContain("派发 tips");
  expect(tips({ step: 2, lastStepTools: ["spawn_subagent"], compacts: 0 })).toBeNull(); // 一次为限
  expect(txt(tips({ step: 3, lastStepTools: ["spawn_subagent"], compacts: 1 }))).toContain("派发 tips"); // compact 后重注入一次
  expect(tips({ step: 4, lastStepTools: ["spawn_subagent"], compacts: 1 })).toBeNull();
  expect(tips({ step: 5, lastStepTools: ["spawn_subagent"], compacts: 1 })).toBeNull(); // 计数不增长不重放
  // 无 compacts 字段的旧式直调:不触发重置(向后兼容)
  expect(tips({ step: 6, lastStepTools: ["spawn_subagent"] })).toBeNull();
});

it("buildLoopTips:GENIE_TIPS=off 全关", () => {
  const tips = buildLoopTips({ sessionId: "s1" });
  expect(txt(tips({ step: 1, lastStepTools: ["spawn_subagent"] }))).toContain("派发 tips");
  process.env.GENIE_TIPS = "off";
  try {
    const fresh = buildLoopTips({ sessionId: "s2" });
    expect(fresh({ step: 1, lastStepTools: ["spawn_subagent"] })).toBeNull();
  } finally { delete process.env.GENIE_TIPS; }
});

it("buildLoopTips:并行提醒(2026-11-04)——上一步恰好 1 个只读探测调用时注入,冷却 8 步、每 episode ≤3 次", () => {
 // 经验证:85.4% 的步只发 1 个调用(并行率 11.4%);静态并行纪律在长会话里注意力衰减。
  // 这里把「上一步只发 1 个可配对探测」变成确定性触发,冷却窗防刷屏。
  const tips = buildLoopTips({ sessionId: "s1" });
  // 单调用 + 可配对工具 → 注入
  const r = tips({ step: 1, lastStepTools: ["read_file"] });
  expect(txt(r)).toContain("并行 tips");
  expect(txt(r)).toContain("同一条消息");
  expect(r?.keys).toContain("parallel");
  // 冷却窗内再单调用 → 不重复注入
  expect(tips({ step: 2, lastStepTools: ["code_sense"] })).toBeNull();
  expect(tips({ step: 5, lastStepTools: ["grep"] })).toBeNull();
  // 冷却窗(8 步)过后再注入一次
  const again = tips({ step: 9, lastStepTools: ["list_dir"] });
  expect(txt(again)).toContain("并行 tips");
});

it("buildLoopTips:并行提醒不注入的三种情形(多调用/零调用/不可配对工具/GENIE_TIPS=off)", () => {
  // ① 多调用步 = 已经在并行,不需要提醒
  const a = buildLoopTips({ sessionId: "a" });
  expect(a({ step: 1, lastStepTools: ["read_file", "grep"] })).toBeNull();
  // ② 零调用步 = 纯文本(可能已收尾)
  expect(a({ step: 2, lastStepTools: [] })).toBeNull();
  // ③ 不可配对工具(写文件/派发/浏览器/终端):只断言没有 parallel tip(spawn_subagent 另会触发 dispatch)
  for (const t of ["write_file", "edit_file", "spawn_subagent", "browser", "terminal", "board_upsert"]) {
    const b = buildLoopTips({ sessionId: `b-${t}` });
    const got = b({ step: 1, lastStepTools: [t] });
    expect(got?.keys ?? []).not.toContain("parallel");
  }
  // ④ GENIE_TIPS=off 全关
  process.env.GENIE_TIPS = "off";
  try {
    const c = buildLoopTips({ sessionId: "c" });
    expect(c({ step: 1, lastStepTools: ["read_file"] })).toBeNull();
  } finally { delete process.env.GENIE_TIPS; }
});

it("buildLoopTips:并行提醒每压缩 episode 至多 3 次(compact 后额度重开)", () => {
  const tips = buildLoopTips({ sessionId: "s1" });
  // 冷却 8 步 + episode 上限 3:step 1/9/17 注入,step 25 应被 episode 上限挡住
  expect(txt(tips({ step: 1, lastStepTools: ["read_file"], compacts: 0 }))).toContain("并行 tips");
  expect(txt(tips({ step: 9, lastStepTools: ["read_file"], compacts: 0 }))).toContain("并行 tips");
  expect(txt(tips({ step: 17, lastStepTools: ["read_file"], compacts: 0 }))).toContain("并行 tips");
  expect(tips({ step: 25, lastStepTools: ["read_file"], compacts: 0 })).toBeNull(); // 3 次用完
  // compact 后额度重开(与其余 tip 的 compact 清空语义一致)
  expect(txt(tips({ step: 33, lastStepTools: ["read_file"], compacts: 1 }))).toContain("并行 tips");
});

it("e2e:kickoff 任务书瘦身(只留原文+纪律卡);首派子代理后 dispatch tip 即时注入", async () => {
  process.env.GENIE_PERMISSION_RULES = JSON.stringify([{ permission: "spawn_subagent", pattern: "*", action: "allow" }, { permission: "task_phase", pattern: "*", action: "allow" }]);
  const seen: string[] = [];
  const sid = "tip-e2e-1";
  const app = createGatewayApp({
    port: 0,
    llm: { async chat(_m: unknown) {
      const m = JSON.stringify(_m);
      if (m.includes("独立上下文")) return { content: "子代理完成" };
      seen.push(m);
      const step = seen.length - 1;
      if (step === 0) return { content: "", toolCalls: [{ id: "t1", name: "task_phase", arguments: JSON.stringify({ phase: "understand", note: "先理解" }) }] };
      if (step === 1) return { content: "", toolCalls: [{ id: "t2", name: "spawn_subagent", arguments: JSON.stringify({ instructions: "勘察", agentType: "explore" }) }] };
      return { content: "终稿" };
    } } as never,
    executor: buildExecutorFromConfig({ executor: { kind: "echo" } } as never) as never,
    useExternalHttp: true,
  });
  apps.push(app);
  app.taskManager.submit("user", sid, "画布tips验证任务");
  for (let k = 0; k < 160; k++) {
    const t = app.taskManager.list().find((x) => x.sessionId === sid);
    if (t && (t.state === "done" || t.state === "failed")) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  expect(seen.length).toBeGreaterThanOrEqual(3);
  const first = seen[0] ?? "";
  // kickoff 瘦身:匹配式注入不进首条 user message;纪律卡保留
  expect(first).toContain("核心纪律卡");
  expect(first).toContain("画布tips验证任务");
  expect(first).not.toContain("## 代码全局意识");
  expect(first).not.toContain("## 历史任务档案");
  expect(first).not.toContain("## 过往经验提示");
  // 首派子代理后的下一步请求里出现 dispatch tip(ephemeral)
  const afterPhase = seen[1] ?? "";
  // 2026-11 tips SOP 化:understand 首见恰时注入 SOP·理解卡(原断言「阶段声明零 tip」锚的是
 // 删匹配式 tips 的旧世界,已被 phase 首见 SOP 卡特性取代;此处仍断言无匹配式残留)
  expect(afterPhase).toContain("SOP·理解");
  expect(afterPhase).not.toContain("派发 tips");
  expect(afterPhase).not.toContain("## 代码全局意识");
  const afterSpawn = seen[2] ?? "";
  expect(afterSpawn).toContain("派发 tips");
}, 45_000);
