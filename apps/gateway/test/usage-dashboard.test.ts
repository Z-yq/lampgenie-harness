/**
 * 用量仪表盘归约测试:computeUsageDashboard 吃 MemoryJournal 造数据——
 * 验证按天分组 / token 求和 / 任务时间窗归属 / 窗口裁剪 / 纯函数确定性。
 * 事件形态对齐生产:task.* payload=Task 快照(app.ts onChange 落 journal),
 * message.agent payload 带 usage{inputTokens,outputTokens,totalTokens,cachedTokens?}。
 */
import { describe, it, expect } from "vitest";
import { MemoryJournal } from "@lampgenie/core";
import { computeUsageDashboard } from "../src/stats.js";

const DAY = 86_400_000;
// 今天/昨天本地 10:00(无论测试何时跑都落在对应自然日;窗口按自然日切)。
const today10 = new Date(new Date().setHours(10, 0, 0, 0)).getTime();
const yest10 = today10 - DAY;

type TaskSnap = {
  id: string; sessionId: string; instruction: string; state: string;
  createdAt: number; updatedAt: number; startedAt?: number; title?: string;
};

function taskSnap(id: string, sid: string, state: string, createdAt: number, updatedAt: number, extra: Partial<TaskSnap> = {}): TaskSnap {
  return { id, sessionId: sid, instruction: "", state, createdAt, updatedAt, ...extra };
}

/** 造一个任务的登记事件(enqueue+start,与 app.ts onChange 落 journal 同构)。 */
function seedTask(j: MemoryJournal, snap: TaskSnap, startAt: number): void {
  j.append({ kind: "task.enqueue", sessionId: snap.sessionId, time: startAt, payload: { ...snap, state: "queued" } });
  j.append({ kind: "task.start", sessionId: snap.sessionId, time: startAt, payload: { ...snap, state: "running" } });
}

/** 标准语料:双天双任务 + 无任务会话 + 同会话串行双任务。 */
function buildJournal(): MemoryJournal {
  const j = new MemoryJournal();
  // s1/t1:今天,2 步 2 次 LLM(带 cachedTokens)+2 次工具,30 分钟后完成。
  const t1 = taskSnap("t1", "s1", "running", today10, today10, { startedAt: today10, title: "重构统计模块", instruction: "把统计归约改成纯函数并补齐测试用例,覆盖按天聚合与任务归属两条路径" });
  seedTask(j, t1, today10);
  j.append({ kind: "step.start", sessionId: "s1", time: today10 + 60_000, payload: { turn: 1, step: 0 } });
  j.append({ kind: "message.agent", sessionId: "s1", time: today10 + 120_000, payload: { text: "", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } });
  j.append({ kind: "step.start", sessionId: "s1", time: today10 + 180_000, payload: { turn: 1, step: 1 } });
  j.append({ kind: "message.agent", sessionId: "s1", time: today10 + 240_000, payload: { text: "", usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedTokens: 10 } } });
  j.append({ kind: "tool.result", sessionId: "s1", time: today10 + 250_000, payload: { toolCallId: "c1", name: "read_file", content: "", durationMs: 5 } });
  j.append({ kind: "tool.result", sessionId: "s1", time: today10 + 260_000, payload: { toolCallId: "c2", name: "bash", content: "", durationMs: 8 } });
  j.append({ kind: "task.done", sessionId: "s1", time: today10 + 1_800_000, payload: { ...t1, state: "done", updatedAt: today10 + 1_800_000 } });

  // s2/t2:昨天,1 次 LLM(无 totalTokens→回退 in+out),失败收场。
  const t2 = taskSnap("t2", "s2", "running", yest10, yest10, { startedAt: yest10 });
  seedTask(j, t2, yest10);
  j.append({ kind: "message.agent", sessionId: "s2", time: yest10 + 60_000, payload: { text: "", usage: { inputTokens: 40, outputTokens: 10 } } });
  j.append({ kind: "task.fail", sessionId: "s2", time: yest10 + 300_000, payload: { ...t2, state: "failed", updatedAt: yest10 + 300_000 } });

  // s3:无任务会话(伴侣闲聊),只进天级不进任务级。
  j.append({ kind: "message.agent", sessionId: "s3", time: today10 + 300_000, payload: { text: "", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });

  // s4:同会话串行双任务,t3 先跑完再 t4——验证时间窗归属不串任务。
  const t3 = taskSnap("t3", "s4", "running", today10 + 1_200_000, today10 + 1_200_000, { startedAt: today10 + 1_200_000 });
  seedTask(j, t3, today10 + 1_200_000);
  j.append({ kind: "step.start", sessionId: "s4", time: today10 + 1_260_000, payload: { turn: 1, step: 0 } });
  j.append({ kind: "message.agent", sessionId: "s4", time: today10 + 1_300_000, payload: { text: "", usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } } });
  j.append({ kind: "task.done", sessionId: "s4", time: today10 + 1_800_000, payload: { ...t3, state: "done", updatedAt: today10 + 1_800_000 } });
  const t4 = taskSnap("t4", "s4", "running", today10 + 2_400_000, today10 + 2_400_000, { startedAt: today10 + 2_400_000 });
  seedTask(j, t4, today10 + 2_400_000);
  j.append({ kind: "step.start", sessionId: "s4", time: today10 + 2_460_000, payload: { turn: 1, step: 0 } });
  j.append({ kind: "message.agent", sessionId: "s4", time: today10 + 2_500_000, payload: { text: "", usage: { inputTokens: 250, outputTokens: 0, totalTokens: 250 } } });
  j.append({ kind: "task.done", sessionId: "s4", time: today10 + 3_000_000, payload: { ...t4, state: "done", updatedAt: today10 + 3_000_000 } });
  return j;
}

describe("computeUsageDashboard(用量仪表盘)", () => {
  it("按天分组:任务数/token 求和/步骤/工具落对应自然日,空日补零", () => {
    const dash = computeUsageDashboard(buildJournal(), 30);
    expect(dash.days).toHaveLength(30);
    const today = dash.days[dash.days.length - 1];
    const yest = dash.days[dash.days.length - 2];
    // 今天:s1(120+80)+s3(10)+s4(100+250)=560;LLM 5 次;步骤 4;工具 2;任务起 3 成 3 败 0。
    expect(today.tokens).toEqual({ input: 507, output: 53, cached: 10, total: 560 });
    expect(today.llmCalls).toBe(5);
    expect(today.steps).toBe(4);
    expect(today.toolCalls).toBe(2);
    expect(today.tasks).toEqual({ started: 3, done: 3, failed: 0 });
    // 昨天:仅 s2(40+10)。
    expect(yest.tokens).toEqual({ input: 40, output: 10, cached: 0, total: 50 });
    expect(yest.tasks).toEqual({ started: 1, done: 0, failed: 1 });
    // 其余 28 天全零;窗口求和=全量。
    for (const d of dash.days.slice(0, 28)) {
      expect(d.tokens.total).toBe(0);
      expect(d.tasks.started).toBe(0);
    }
    expect(dash.days.reduce((a, b) => a + b.tokens.total, 0)).toBe(610);
  });

  it("任务归属:token/步骤按时间窗归到同会话正确任务,无任务会话不进任务级", () => {
    const dash = computeUsageDashboard(buildJournal(), 30);
    const byId = new Map(dash.topTasks.map((r) => [r.taskId, r]));
    // 按 token 降序:t4(250) > t1(200) > t3(100) > t2(50)。
    expect(dash.topTasks.map((r) => r.taskId)).toEqual(["t4", "t1", "t3", "t2"]);
    // s1 的两次 LLM 全归 t1(伴侣会话的 10 token 不沾)。
    expect(byId.get("t1")!.tokens).toEqual({ input: 150, output: 50, total: 200 });
    expect(byId.get("t1")!.steps).toBe(2);
    expect(byId.get("t1")!.state).toBe("done");
    expect(byId.get("t1")!.sessionId).toBe("s1");
    expect(byId.get("t1")!.title).toBe("重构统计模块");
    // s4 串行双任务各拿各的 token,不串窗。
    expect(byId.get("t3")!.tokens.total).toBe(100);
    expect(byId.get("t4")!.tokens.total).toBe(250);
    expect(byId.get("t4")!.steps).toBe(1);
    // 任务级合计=600(610 减去无任务会话的 10)。
    expect(dash.topTasks.reduce((a, b) => a + b.tokens.total, 0)).toBe(600);
  });

  it("行字段:instruction 截 80 字符,durationMs=startedAt→终态快照 updatedAt", () => {
    const dash = computeUsageDashboard(buildJournal(), 30);
    const t1 = dash.topTasks.find((r) => r.taskId === "t1")!;
    expect(t1.instruction.length).toBeLessThanOrEqual(80);
    expect(t1.instruction.startsWith("把统计归约改成纯函数")).toBe(true);
    expect(t1.durationMs).toBe(1_800_000); // 30 分钟
    const t2 = dash.topTasks.find((r) => r.taskId === "t2")!;
    expect(t2.durationMs).toBe(300_000);
    expect(t2.state).toBe("failed");
  });

  it("窗口裁剪:days=1 只剩今天,yesterday 事件不进窗口(任务 token 归零仍保留行)", () => {
    const dash = computeUsageDashboard(buildJournal(), 1);
    expect(dash.days).toHaveLength(1);
    expect(dash.days[0].tokens.total).toBe(560);
    expect(dash.days[0].tasks.failed).toBe(0);
    const t2 = dash.topTasks.find((r) => r.taskId === "t2");
    expect(t2).toBeDefined(); // 任务登记不受窗口裁剪
    expect(t2!.tokens.total).toBe(0);
  });

  it("纯函数零 IO:同 journal 两次计算结果恒定(除 generatedAt)", () => {
    const j = buildJournal();
    const a = computeUsageDashboard(j, 7);
    const b = computeUsageDashboard(j, 7);
    const strip = (d: ReturnType<typeof computeUsageDashboard>) => {
      const { generatedAt: _g, ...rest } = d;
      return rest;
    };
    expect(strip(b)).toEqual(strip(a));
  });

  it("空 journal:30 天全零行,无 top 任务", () => {
    const dash = computeUsageDashboard(new MemoryJournal(), 30);
    expect(dash.days).toHaveLength(30);
    expect(dash.days.every((d) => d.tokens.total === 0 && d.llmCalls === 0)).toBe(true);
    expect(dash.topTasks).toEqual([]);
  });
});
