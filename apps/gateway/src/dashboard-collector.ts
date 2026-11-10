/**
 * 运行看板数据核心(参考项目 dashboard-collector 的 journal 原生重写,功能面 1:1):
 * 事件源折算重建会话状态 + 每会话指标聚合。
 * 数据源映射(ref 概念 → journal 事件,详见):
 *  - session_start   → 会话首个事件(任意 kind 首现即建卡)
 *  - prompt_submit   → message.user
 *  - tool_use        → tool.call
 *  - stop            → turn.end(reason=completed/max-steps)= LLM 说完等用户
 *  - session_end     → task 终态(done/failed/cancelled)
 *  - process_exit    → 无外部进程可监听,由 stale 超时承担(机制适配)
 *  - interrupt       → turn.end reason=cancelled
 *  - toolReject      → permission.gate effect=denied
 *  - tokens          → message.agent payload.usage(诚实子集:无 cache 字段不造数)
 * 纯函数无 IO:同一份事件重放结果恒定(测试可锚定);时间由调用方注入(now),
 * 单时钟纪律与 @lampgenie/runtime projection 同拍。
 */
import type { JournalEvent } from "@lampgenie/core";

/** 会话状态灯(ref 五态全保留)。 */
export type DashSessionStatus = "running" | "waiting_for_input" | "error" | "idle" | "stopped";

export interface DashInterventions {
  /** 用户打断(turn.end reason=cancelled)。 */
  interrupt: number;
  /** 权限拒绝(permission.gate effect=denied)。 */
  denied: number;
  /** 纠正式追问(turn.end 后短窗内的改错式追问)。 */
  correction: number;
}

export interface DashTokens {
  input: number;
  output: number;
  total: number;
}

export interface DashSubagents {
  spawned: number;
  results: number;
  failed: number;
  backgrounded: number;
}

export interface DashDenial {
  time: number;
  tool: string;
  by: string;
}

/** 看板会话卡(ref DashboardSession 对应物 + C 阶段新维度)。 */
export interface DashSession {
  sessionId: string;
  status: DashSessionStatus;
  /** 归属项目(任务首条带 projectId 的事件定主;无任务= null → 面板落「未归属」桶)。 */
  projectId: string | null;
  /** 最新任务状态;无任务会话(wf、companion、smoke 等前缀)= null。 */
  taskState: string | null;
  promptSummary: string;
  lastActivity: number;
  startedAt: number;
  lastTool: string;
  prompts: string[];
  promptCount: number;
  /** LLM 轮次(turn.start 计数)。 */
  turns: number;
  toolCalls: number;
  /** 最后一条非空 agent 文本(≤500 字符;ref stoppedOutput 对应物)。 */
  stoppedOutput: string;
  /** 0 = 未停。 */
  stoppedAt: number;
  interventions: DashInterventions;
  interventionCount: number;
  tokens: DashTokens;
  /** LLM 累计耗时(message.agent llmMs 合计;缺 0)。 */
  llmMs: number;
  /** 活跃时长:相邻事件间距 ≤ idle 窗口的求和(ref durationMs 同口径)。 */
  durationMs: number;
  /** 历史中出现过 error 轮/失败任务(趋势成功判定用)。 */
  hadError: boolean;
  subagents: DashSubagents;
  /** 白板更新次数(board.update 计数,C 阶段板角标)。 */
  boards: number;
  /** 最近权限拒绝(时间正序,最多 5 条,C 阶段权限门事件流)。 */
  denials: DashDenial[];
  /** plan.gate effect=phase-auto-advanced 次数(B2 阶段门自动推进;正常口径,非干预)。 */
  phaseAutoAdvanced: number;
}

/** 无活动超过此时长(毫秒)标记 idle。 */
export const DASH_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** idle 超过此时长从看板移除(ref stale 30min)。 */
export const DASH_STALE_TIMEOUT_MS = 30 * 60 * 1000;
/** 停止会话在板上的保留窗。ref 是 30s,但本产品任务是「跑几分钟即终态」的离散形态,
 * 30s=看板在两个任务之间恒空(用户「看板呢」注意)——改 24h,当天工作留在板上。 */
export const DASH_STOPPED_DISPLAY_MS = 24 * 60 * 60 * 1000;
/** turn 结束后到下一条消息可计纠正的窗口。 */
export const CORRECTION_WINDOW_MS = 60 * 1000;
/** 纠正式追问关键词(ref 内置词表移植;中日韩文保持子串匹配,拉丁文整词)。 */
export const CORRECTION_KEYWORDS = [
  "不对", "不是", "错了", "错误", "重来", "重新", "撤销", "回退", "别这样", "不要",
  "wrong", "redo", "undo", "revert", "mistake", "instead", "don't", "that's not", "not what",
  "違う", "ちがう", "そうじゃな", "そうではな", "やり直", "やりなおし", "間違って", "間違え", "勝手に", "戻して",
];
/** stoppedOutput 截断上限(字符)。 */
export const STOPPED_OUTPUT_MAX_CHARS = 500;
/** 权限拒绝列表保留条数(C 阶段:面板只展示最近 N 条)。 */
export const DASH_DENIALS_MAX = 5;

const LATIN_WORD_RE = /[a-z0-9]+/g;

/** 是否纠正式追问(ref isCorrectionPrompt 移植:拉丁词整词匹配,中日韩子串匹配)。 */
export function isCorrectionPrompt(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const kw of CORRECTION_KEYWORDS) {
    if (/[a-z0-9']/.test(kw[0] ?? "")) {
      const words: string[] = lower.match(LATIN_WORD_RE) ?? [];
      if (kw.includes(" ") || kw.includes("'")) {
        // 多词短语:子串匹配(与 ref containsKeyword 短语分支同语义)。
        if (lower.includes(kw)) return true;
      } else if (words.includes(kw)) return true;
    } else if (lower.includes(kw)) return true;
  }
  return false;
}

interface SessionFold {
  status: DashSessionStatus;
  projectId: string | null;
  projectFixed: boolean;
  taskState: string | null;
  promptSummary: string;
  lastActivity: number;
  startedAt: number;
  lastTool: string;
  prompts: string[];
  promptCount: number;
  turns: number;
  toolCalls: number;
  stoppedOutput: string;
  stoppedAt: number;
  interventions: DashInterventions;
  tokens: DashTokens;
  llmMs: number;
  lastEventAt: number;
  /** 会话历史中出现过 error(ref hasError:任一事件 error 即整会话不算成功)。 */
  everError: boolean;
  subagents: DashSubagents;
  boards: number;
  denials: DashDenial[];
  /** plan.gate effect=phase-auto-advanced 次数(B2:板含内容节点→阶段自动置 plan)。正常推进口径,非干预计数。 */
  phaseAutoAdvanced: number;
}

const TERMINAL_TASK_STATES = new Set(["done", "failed", "cancelled"]);

function newFold(ev: JournalEvent): SessionFold {
  return {
    status: "running",
    projectId: null,
    projectFixed: false,
    taskState: null,
    promptSummary: "",
    lastActivity: ev.time,
    startedAt: ev.time,
    lastTool: "",
    prompts: [],
    promptCount: 0,
    turns: 0,
    toolCalls: 0,
    stoppedOutput: "",
    stoppedAt: 0,
    interventions: { interrupt: 0, denied: 0, correction: 0 },
    tokens: { input: 0, output: 0, total: 0 },
    llmMs: 0,
    lastEventAt: ev.time,
    everError: false,
    subagents: { spawned: 0, results: 0, failed: 0, backgrounded: 0 },
    boards: 0,
    denials: [],
    phaseAutoAdvanced: 0,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** 归属项目定主(ref「首条匹配事件定整个会话归属」语义):首个带 projectId 的 task.* 事件获胜。 */
export function sessionProjectOwners(events: JournalEvent[]): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  for (const ev of events) {
    if (!ev.kind.startsWith("task.")) continue;
    const pid = (ev.payload as { projectId?: string } | null | undefined)?.projectId;
    if (!pid) continue;
    const cur = owners.get(ev.sessionId);
    if (cur === undefined || cur === null) owners.set(ev.sessionId, pid);
  }
  return owners;
}

/**
 * 事件源折算:journal 事件流 → 看板会话卡。
 * ref rebuildSessions 全功能保留(五态状态机/idle/stale/stopped 窗口/运行时长排序),
 * 纠正检测与指标聚合同趟完成(原 aggregateSessionMetrics 的单会话子集——本地看板
 * 不需要 Codex rollout 分段与价格体系,机制适配见 designs)。
 */
export function rebuildDashboardSessions(
  events: JournalEvent[],
  now = Date.now(),
  opts?: { /** true=不过超时窗(趋势聚合用全量折算;ref aggregateSessionMetrics 对应物)。 */ keepAll?: boolean },
): DashSession[] {
  const folds = new Map<string, SessionFold>();
  const owners = sessionProjectOwners(events);
  // 纠正窗:每轮 turn 结束时刻只被下一条用户消息消费一次(ref stop 消费语义)。
  const lastTurnEnd = new Map<string, number>();

  for (const ev of events) {
    let f = folds.get(ev.sessionId);
    if (!f) {
      f = newFold(ev);
      folds.set(ev.sessionId, f);
    }
    f.lastActivity = ev.time;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.kind) {
      case "task.enqueue":
      case "task.start":
      case "task.progress":
      case "task.done":
      case "task.fail": {
        const state = typeof p.state === "string" ? p.state : ev.kind === "task.start" ? "running" : ev.kind === "task.enqueue" ? "queued" : ev.kind === "task.done" ? "done" : ev.kind === "task.fail" ? "failed" : null;
        if (state) f.taskState = state;
        if (state === "done") {
          f.status = "stopped";
          f.stoppedAt = ev.time;
        } else if (state === "failed") {
          f.status = "error";
          f.stoppedAt = ev.time;
          f.everError = true;
        } else if (state === "cancelled") {
          f.status = "stopped";
          f.stoppedAt = ev.time;
        } else if (state === "running") {
          f.status = "running";
        }
        break;
      }
      case "message.user": {
        f.status = "running";
        f.promptCount++;
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (text) {
          if (!f.promptSummary) f.promptSummary = text;
          f.prompts.push(text);
        }
        // 纠正式追问:上一轮刚结束(60s 窗)+ 关键词命中;窗口消费一次。
        const turnEndAt = lastTurnEnd.get(ev.sessionId);
        if (turnEndAt !== undefined) {
          lastTurnEnd.delete(ev.sessionId);
          const gap = ev.time - turnEndAt;
          if (gap >= 0 && gap <= CORRECTION_WINDOW_MS && isCorrectionPrompt(text)) {
            f.interventions.correction++;
          }
        }
        break;
      }
      case "message.agent": {
        const usage = p.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
        if (usage) {
          const input = Number(usage.inputTokens) || 0;
          const output = Number(usage.outputTokens) || 0;
          f.tokens.input += input;
          f.tokens.output += output;
          f.tokens.total += Number(usage.totalTokens) || input + output;
        }
        f.llmMs += Number(p.llmMs) || 0;
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (text) f.stoppedOutput = truncate(text, STOPPED_OUTPUT_MAX_CHARS);
        break;
      }
      case "tool.call": {
        f.status = "running";
        f.toolCalls++;
        if (typeof p.name === "string") f.lastTool = p.name;
        break;
      }
      case "turn.start": {
        f.turns++;
        f.status = "running";
        break;
      }
      case "turn.end": {
        const reason = typeof p.reason === "string" ? p.reason : "";
        if (reason === "error") {
          f.status = "error";
          f.everError = true;
        } else if (reason === "cancelled") {
          f.interventions.interrupt++;
          f.status = "stopped";
          f.stoppedAt = ev.time;
        } else {
          // completed / max-steps:LLM 说完,等用户接话(ref waiting_for_input)。
          f.status = "waiting_for_input";
          lastTurnEnd.set(ev.sessionId, ev.time);
        }
        break;
      }
      case "permission.gate": {
        if (p.effect === "denied") {
          f.interventions.denied++;
          f.denials.push({ time: ev.time, tool: String(p.tool ?? ""), by: String(p.by ?? "") });
          if (f.denials.length > DASH_DENIALS_MAX) f.denials.splice(0, f.denials.length - DASH_DENIALS_MAX);
        }
        break;
      }
      case "custom": {
 // B2:板含内容节点→阶段门自动推进——正常放行口径,与 denied(人工干预)分桶,
        // 消费面(运行看板)把零 denied 读作「无异常」而非「闸门失灵」。
        const pl = p as { type?: string; effect?: string };
        if (pl.type === "plan.gate" && pl.effect === "phase-auto-advanced") f.phaseAutoAdvanced++;
        break;
      }
      case "subagent.spawn":
        f.subagents.spawned++;
        break;
      case "subagent.result": {
        f.subagents.results++;
        const inner = p.event as { result?: { ok?: boolean } } | undefined;
        if (inner && inner.result && inner.result.ok === false) f.subagents.failed++;
        break;
      }
      case "subagent.backgrounded":
        f.subagents.backgrounded++;
        break;
      case "board.update":
        f.boards++;
        break;
      default:
        break;
    }
  }

  // 归属项目(ref:首条匹配定主;无任务事件=null → unassigned 桶)。
  for (const [sid, f] of folds) {
    const owner = owners.get(sid);
    if (owner !== undefined) f.projectId = owner;
  }

  // 超时窗 + 排序(ref 同语义:停止的垫底,其余按运行时长降序)。
  const result: DashSession[] = [];
  for (const [sid, f] of folds) {
    const elapsed = now - f.lastActivity;
    if (!opts?.keepAll) {
      if (f.status === "stopped" || f.status === "error") {
        const endedAt = f.stoppedAt || f.lastActivity;
        if (now - endedAt > DASH_STOPPED_DISPLAY_MS) continue;
      } else {
        if (elapsed > DASH_STALE_TIMEOUT_MS) continue;
        if (elapsed > DASH_IDLE_TIMEOUT_MS) f.status = "idle";
      }
    }
    result.push({
      sessionId: sid,
      status: f.status,
      projectId: f.projectId,
      taskState: f.taskState,
      promptSummary: f.promptSummary,
      lastActivity: f.lastActivity,
      startedAt: f.startedAt,
      lastTool: f.lastTool,
      prompts: f.prompts,
      promptCount: f.promptCount,
      turns: f.turns,
      toolCalls: f.toolCalls,
      stoppedOutput: f.stoppedOutput,
      stoppedAt: f.stoppedAt,
      interventions: { ...f.interventions },
      interventionCount: f.interventions.interrupt + f.interventions.denied + f.interventions.correction,
      tokens: { ...f.tokens },
      llmMs: f.llmMs,
      durationMs: 0,
      hadError: f.everError,
      subagents: { ...f.subagents },
      boards: f.boards,
      denials: [...f.denials],
      phaseAutoAdvanced: f.phaseAutoAdvanced,
    });
  }

  // 活跃时长:相邻事件间距 ≤ idle 窗口求和(ref durationMs 口径)。
  const byId = new Map(result.map((s) => [s.sessionId, s]));
  const lastAt = new Map<string, number>();
  for (const ev of events) {
    const prev = lastAt.get(ev.sessionId);
    const s = byId.get(ev.sessionId);
    if (s && prev !== undefined) {
      const gap = ev.time - prev;
      if (Number.isFinite(gap) && gap >= 0 && gap <= DASH_IDLE_TIMEOUT_MS) s.durationMs += gap;
    }
    lastAt.set(ev.sessionId, ev.time);
  }

  result.sort((a, b) => {
    const aStopped = a.status === "stopped" || a.status === "error";
    const bStopped = b.status === "stopped" || b.status === "error";
    if (aStopped !== bStopped) return aStopped ? 1 : -1;
    const aEnd = a.stoppedAt || now;
    const bEnd = b.stoppedAt || now;
    return (bEnd - b.startedAt) - (aEnd - a.startedAt);
  });
  return result;
}
