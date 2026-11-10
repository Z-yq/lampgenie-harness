/**
 * 运行看板数据核心测试(ref dashboard-collector.test.ts 当规格,journal 事件源重写):
 * 状态机/超时窗/干预与纠正/token/子代理/权限拒绝/项目归属/趋势窗。
 * 纯函数锚定:同一份事件重放结果恒定;时间显式注入(now 参数),不依赖真实时钟。
 */
import { describe, it, expect } from "vitest";
import type { JournalEvent } from "@lampgenie/core";
import {
  rebuildDashboardSessions,
  isCorrectionPrompt,
  DASH_IDLE_TIMEOUT_MS,
  DASH_STALE_TIMEOUT_MS,
  DASH_STOPPED_DISPLAY_MS,
  CORRECTION_WINDOW_MS,
  STOPPED_OUTPUT_MAX_CHARS,
  DASH_DENIALS_MAX,
} from "../src/dashboard-collector.js";
import {
  aggregateDailySessions,
  computeDailyBuckets,
  summarizeTrendWindow,
  dailyWindow,
  isSessionEnded,
} from "../src/dashboard-trends.js";
import { dashboardScopes, eventsForScope, UNASSIGNED_SCOPE } from "../src/dashboard-scope.js";

const T0 = 1_700_000_000_000;

/** 造事件(time 偏移毫秒;journal 事件形状)。 */
function ev(kind: string, sid: string, offsetMs: number, payload: unknown = {}): JournalEvent {
  return { kind: kind as JournalEvent["kind"], sessionId: sid, seq: 0, time: T0 + offsetMs, payload };
}

function taskEvent(kind: string, sid: string, offsetMs: number, state: string, projectId?: string): JournalEvent {
  return ev(kind, sid, offsetMs, { id: "t1", sessionId: sid, state, ...(projectId ? { projectId } : {}) });
}

describe("看板状态机(ref rebuildSessions 五态)", () => {
  it("工具活动=运行中,turn.end completed=等输入,任务终态=已结束/出错", () => {
    const events = [
      taskEvent("task.start", "s1", 0, "running"),
      ev("message.user", "s1", 100, { text: "帮我查一下" }),
      ev("tool.call", "s1", 200, { name: "code_sense" }),
      ev("turn.end", "s1", 5_000, { reason: "completed" }),
    ];
    const sessions = rebuildDashboardSessions(events, T0 + 6_000);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.status).toBe("waiting_for_input");
    expect(s.promptSummary).toBe("帮我查一下");
    expect(s.lastTool).toBe("code_sense");
    expect(s.taskState).toBe("running");
    expect(s.turns).toBe(0);
    expect(s.toolCalls).toBe(1);
  });

  it("turn.end error=出错;cancelled 计打断且=已结束", () => {
    const base = [
      taskEvent("task.start", "s1", 0, "running"),
      ev("message.user", "s1", 100, { text: "x" }),
    ];
    const err = rebuildDashboardSessions([...base, ev("turn.end", "s1", 500, { reason: "error" })], T0 + 600);
    expect(err[0].status).toBe("error");
    expect(err[0].hadError).toBe(true);
    const cancel = rebuildDashboardSessions([...base, ev("turn.end", "s1", 500, { reason: "cancelled" })], T0 + 600);
    expect(cancel[0].status).toBe("stopped");
    expect(cancel[0].interventions.interrupt).toBe(1);
  });

  it("用户再开口=回到运行中;新会话首条消息即摘要", () => {
    const events = [
      taskEvent("task.start", "s1", 0, "running"),
      ev("message.user", "s1", 100, { text: "第一问" }),
      ev("turn.end", "s1", 5_000, { reason: "completed" }),
      ev("message.user", "s1", 8_000, { text: "第二问" }),
    ];
    const sessions = rebuildDashboardSessions(events, T0 + 9_000);
    expect(sessions[0].status).toBe("running");
    expect(sessions[0].promptSummary).toBe("第一问");
    expect(sessions[0].prompts).toEqual(["第一问", "第二问"]);
    expect(sessions[0].promptCount).toBe(2);
  });

  it("超时窗:idle 5min / stale 30min / 停止显示 30s(ref 常量同值)", () => {
    const events = [ev("message.user", "s1", 0, { text: "hi" }), ev("turn.end", "s1", 100, { reason: "completed" })];
    expect(rebuildDashboardSessions(events, T0 + 100 + DASH_IDLE_TIMEOUT_MS - 1)[0].status).toBe("waiting_for_input");
    expect(rebuildDashboardSessions(events, T0 + 100 + DASH_IDLE_TIMEOUT_MS + 1)[0].status).toBe("idle");
    expect(rebuildDashboardSessions(events, T0 + 100 + DASH_STALE_TIMEOUT_MS + 1)).toHaveLength(0);
    const stopped = [taskEvent("task.start", "s2", 0, "running"), taskEvent("task.done", "s2", 1_000, "done")];
    expect(rebuildDashboardSessions(stopped, T0 + 1_000 + DASH_STOPPED_DISPLAY_MS - 1)).toHaveLength(1);
    expect(rebuildDashboardSessions(stopped, T0 + 1_000 + DASH_STOPPED_DISPLAY_MS + 1)).toHaveLength(0);
  });

  it("排序:活跃在前,组内运行时长降序(ref 同语义)", () => {
    const events = [
      taskEvent("task.start", "short", 0, "running"),
      taskEvent("task.done", "short", 59_000, "done"), // 运行 59s,已结束(保留窗内)
      ev("message.user", "long", 0, { text: "长会话" }),
      ev("tool.call", "long", 60_000, { name: "bash" }), // 运行中,全程 60.5s
    ];
    const sessions = rebuildDashboardSessions(events, T0 + 60_500);
    expect(sessions.map((s) => s.sessionId)).toEqual(["long", "short"]);
  });
});

describe("干预与纠正(ref interventions 语义)", () => {
  it("权限拒绝计数+最近列表截断", () => {
    const events: JournalEvent[] = [taskEvent("task.start", "s1", 0, "running")];
    for (let i = 0; i < DASH_DENIALS_MAX + 3; i++) {
      events.push(ev("permission.gate", "s1", 100 + i, { tool: "bash", effect: "denied", by: "rule-denied" }));
    }
    const s = rebuildDashboardSessions(events, T0 + 1_000)[0];
    expect(s.interventions.denied).toBe(DASH_DENIALS_MAX + 3);
    expect(s.denials).toHaveLength(DASH_DENIALS_MAX);
    expect(s.denials[0].tool).toBe("bash");
  });

  it("B2 阶段门 auto-advanced:plan.gate phase-auto-advanced 计入正常推进桶,不计干预 denied", () => {
 // B2:板含内容节点→phase 自动置 plan,journal 落 plan.gate effect=phase-auto-advanced。
    // 消费面契约:该事件是正常放行口径——denied(干预)与 phaseAutoAdvanced(自动推进)分桶,
    // 防止「denied 归零」被读作闸门失灵,也防止把自动推进误算成人工干预。
    const events: JournalEvent[] = [
      taskEvent("task.start", "s1", 0, "running"),
      ev("custom", "s1", 50, { type: "plan.gate", effect: "phase-auto-advanced", tool: "board_upsert", actor: "main", from: "understand", to: "plan", nodeCount: 4 }),
      ev("custom", "s1", 60, { type: "plan.gate", effect: "phase-auto-advanced", tool: "write_file", actor: "main", from: "understand", to: "plan", nodeCount: 4 }),
      ev("custom", "s1", 70, { type: "plan.gate", effect: "board-present", tool: "write_file", nodeCount: 4, p0: 2 }),
      // 无关 custom 事件不计
      ev("custom", "s1", 80, { type: "board.exempt", reason: "无表达结构" }),
    ];
    const s = rebuildDashboardSessions(events, T0 + 1_000)[0];
    expect(s.phaseAutoAdvanced).toBe(2);
    expect(s.interventions.denied).toBe(0);
    expect(s.interventionCount).toBe(0);
  });

  it("phase-auto-advanced 与真实 denied 互不污染:两事件并存时各计各桶", () => {
    const events: JournalEvent[] = [
      taskEvent("task.start", "s1", 0, "running"),
      ev("custom", "s1", 50, { type: "plan.gate", effect: "phase-auto-advanced", tool: "board_upsert", from: "understand", to: "plan" }),
      ev("permission.gate", "s1", 60, { tool: "bash", effect: "denied", by: "rule-denied" }),
    ];
    const s = rebuildDashboardSessions(events, T0 + 1_000)[0];
    expect(s.phaseAutoAdvanced).toBe(1);
    expect(s.interventions.denied).toBe(1);
    expect(s.denials).toHaveLength(1);
  });

  it("纠正:turn.end 后窗口内改错式追问计 1,窗口消费一次,超窗/非纠正不计", () => {
    const events = [
      ev("message.user", "s1", 0, { text: "写下划线函数" }),
      ev("turn.end", "s1", 1_000, { reason: "completed" }),
      ev("message.user", "s1", 1_000 + 1_000, { text: "不对,要驼峰" }), // 窗口内+关键词=纠正
      ev("turn.end", "s1", 4_000, { reason: "completed" }),
      ev("message.user", "s1", 4_000 + CORRECTION_WINDOW_MS + 1, { text: "错了,重来" }), // 超窗不计
      ev("turn.end", "s1", 10_000, { reason: "completed" }),
      ev("message.user", "s1", 11_000, { text: "再加个测试" }), // 窗口内但非纠正
    ];
    const s = rebuildDashboardSessions(events, T0 + 12_000)[0];
    expect(s.interventions.correction).toBe(1);
  });

  it("isCorrectionPrompt:中文子串/拉丁整词(undo 不误伤 segundo)", () => {
    expect(isCorrectionPrompt("不对,重来")).toBe(true);
    expect(isCorrectionPrompt("please undo that")).toBe(true);
    expect(isCorrectionPrompt("segundo paso")).toBe(false);
    expect(isCorrectionPrompt(undefined)).toBe(false);
  });
});

describe("token 与输出(ref tokens/stoppedOutput)", () => {
  it("usage 累加;末条非空 agent 文本截断 500", () => {
    const longText = "字".repeat(STOPPED_OUTPUT_MAX_CHARS + 100);
    const events = [
      ev("message.agent", "s1", 0, { text: "", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }),
      ev("message.agent", "s1", 500, { text: longText, llmMs: 1_500, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } }),
      ev("turn.end", "s1", 900, { reason: "completed" }),
    ];
    const s = rebuildDashboardSessions(events, T0 + 1_000)[0];
    expect(s.tokens.input).toBe(300);
    expect(s.tokens.output).toBe(30);
    expect(s.tokens.total).toBe(330);
    expect(s.llmMs).toBe(1_500);
    expect(s.stoppedOutput).toHaveLength(STOPPED_OUTPUT_MAX_CHARS);
  });
});

describe("C 阶段新维度:子代理/白板/项目归属", () => {
  it("子代理 spawn/result 计数,失败(result.ok=false)单列", () => {
    const events = [
      ev("subagent.spawn", "s1", 0, { agentId: "a1", backend: "echo-child" }),
      ev("subagent.spawn", "s1", 100, { agentId: "a2", backend: "echo-child" }),
      ev("subagent.result", "s1", 500, { agentId: "a1", event: { type: "result", result: { ok: true } } }),
      ev("subagent.result", "s1", 600, { agentId: "a2", event: { type: "result", result: { ok: false, error: { kind: "timeout" } } } }),
      ev("subagent.backgrounded", "s1", 700, { agentId: "a3" }),
    ];
    const s = rebuildDashboardSessions(events, T0 + 800)[0];
    expect(s.subagents).toEqual({ spawned: 2, results: 2, failed: 1, backgrounded: 1 });
  });

  it("board.update 计数入板角标字段", () => {
    const events = [
      ev("board.update", "s1", 0, { path: "/x.json" }),
      ev("board.update", "s1", 100, { path: "/x.json" }),
    ];
    expect(rebuildDashboardSessions(events, T0 + 200)[0].boards).toBe(2);
  });

  it("项目归属:首条带 projectId 的任务事件定主;无任务=null(未归属)", () => {
    const events = [
      taskEvent("task.enqueue", "own", 0, "queued"),
      taskEvent("task.start", "own", 10, "running", "proj-a"),
      taskEvent("task.start", "own", 20, "running", "proj-b"), // 已定主,不改判
      taskEvent("task.enqueue", "free", 0, "queued"),
    ];
    const sessions = rebuildDashboardSessions(events, T0 + 100);
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    expect(byId.get("own")?.projectId).toBe("proj-a");
    expect(byId.get("free")?.projectId).toBeNull();
  });

  it("活跃时长:相邻事件间距 ≤ idle 窗求和,大间隙不计", () => {
    const events = [
      ev("message.user", "s1", 0, { text: "a" }),
      ev("tool.call", "s1", 30_000, { name: "bash" }),       // +30s
      ev("tool.result", "s1", 90_000, {}),                    // +60s(累计 90s)
      ev("message.user", "s1", 90_000 + DASH_IDLE_TIMEOUT_MS + 1, { text: "回来继续" }), // 间隙超 cap 不计
    ];
    const s = rebuildDashboardSessions(events, T0 + 90_000 + DASH_IDLE_TIMEOUT_MS + 2_000)[0];
    expect(s.durationMs).toBe(90_000);
  });
});

describe("趋势(ref session-trends 7 天 vs 前 7 天)", () => {
  it("无终态不入样;成功=无错/无打断/无纠正", () => {
    const day = (offsetDays: number) => T0 + offsetDays * 86_400_000;
    const ended = [
      taskEvent("task.start", "ok1", 0, "running"),
      ev("message.user", "ok1", 100, { text: "a" }),
      taskEvent("task.done", "ok1", 1_000, "done"),
      taskEvent("task.start", "bad1", 0, "running"),
      ev("message.user", "bad1", 100, { text: "b" }),
      taskEvent("task.fail", "bad1", 1_000, "failed"),
      ev("message.user", "noend", 100, { text: "永不终态" }),
    ];
    const snaps = aggregateDailySessions(ended);
    expect(snaps.size).toBe(2);
    expect(snaps.get("ok1")?.succeeded).toBe(1);
    expect(snaps.get("bad1")?.succeeded).toBe(0);
    expect(isSessionEnded("done")).toBe(true);
    expect(isSessionEnded("running")).toBe(false);
  });

  it("日桶聚合+窗口摘要:current 7 天/previous 前 7 天互不串窗", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    const dayMs = 86_400_000;
    const mk = (sid: string, dayOffsetFromNow: number, succeeded: 0 | 1, prompts: number): JournalEvent[] => {
      const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + dayOffsetFromNow * dayMs + 3_600_000;
      return [
        { kind: "task.start", sessionId: sid, seq: 0, time: end - 1_000, payload: { state: "running" } },
        { kind: "task.done", sessionId: sid, seq: 0, time: end, payload: { state: succeeded ? "done" : "failed" } },
      ];
    };
    const events = [
      ...mk("cur1", 0, 1, 0),
      ...mk("cur2", -1, 0, 0),
      ...mk("old1", -10, 1, 0),  // 落前 7 天窗
      ...mk("old2", -20, 1, 0),  // 两窗之外
    ];
    // 事件时间已定,快照与桶都从事件折算;correction 窗口需要 message.user,这里成功口径只看 error/interrupt。
    const snaps = aggregateDailySessions(events);
    expect(snaps.size).toBe(4);
    const buckets = computeDailyBuckets(snaps);
    const { current, previous } = summarizeTrendWindow(buckets, now);
    expect(current.sessionsEnded).toBe(2);
    expect(current.successRate).toBeCloseTo(0.5);
    expect(previous.sessionsEnded).toBe(1); // old1 进前窗,old2 出双窗——互不串窗
    const win = dailyWindow(buckets, 14, now);
    expect(win).toHaveLength(14);
    expect(win[win.length - 1].sessionsEnded).toBe(1);
  });
});

describe("作用域(ref workspaces 三桶对应物)", () => {
  it("全部+用到的项目+未归属(仅当存在无主会话)", () => {
    const projects = [
      { id: "proj-a", label: "Alpha" },
      { id: "proj-empty", label: "Empty" },
    ];
    const events = [
      taskEvent("task.start", "s1", 0, "running", "proj-a"),
      ev("message.user", "s2", 0, { text: "自由会话" }),
    ];
    const scopes = dashboardScopes(events, projects);
    expect(scopes.map((s) => s.id)).toEqual(["all", "proj-a", UNASSIGNED_SCOPE]);
    const scoped = eventsForScope(events, "proj-a");
    expect(new Set(scoped.map((e) => e.sessionId))).toEqual(new Set(["s1"]));
    const un = eventsForScope(events, UNASSIGNED_SCOPE);
    expect(new Set(un.map((e) => e.sessionId))).toEqual(new Set(["s2"]));
    expect(eventsForScope(events, "all")).toHaveLength(events.length);
  });

  it("纯函数重放恒定(同输入两次结果逐字段一致)", () => {
    const events = [
      taskEvent("task.start", "s1", 0, "running", "p"),
      ev("message.user", "s1", 100, { text: "重放一致性" }),
      ev("tool.call", "s1", 200, { name: "read" }),
      ev("turn.end", "s1", 300, { reason: "completed" }),
    ];
    const a = rebuildDashboardSessions(events, T0 + 400);
    const b = rebuildDashboardSessions(events, T0 + 400);
    expect(a).toEqual(b);
  });
});
