/**
 * 父子 ask-answer broker(step-071):子代理就重操作(build/install/全量测试等)向父 agent
 * 申请、父 agent LLM 决策批准/拒绝并回流的通用问答机制。
 *
 * 问题流向(与旧链路的差别):子代理工具 ask 的旧链路=面板(用户)或静默拒绝,父 agent 从不参与;
 * 本机制把「重操作申请」路由给**父 agent**——结构化问题(谁/什么命令/为何类重操作)进入父侧,
 * 父 LLM 按决策指引批准或拒绝并给理由,答案回流唤醒阻塞中的子代理;超时=拒绝(fail-closed)。
 *
 * 复用既有链不造平行机制:闸门本体在 loop.ts executeWithPermission(permission.heavyOp),
 * 本模块只承问答编排与审计。父决策两条通道(同一 broker):
 * - 并发泵(前台 spawn,父 loop 阻塞在工具内不可注入):driveParentDecision 在接线方 await
 *   子代理结果期间被并发调用,直接驱动父 LLM 做一次决策 mini-turn;
 * - 注入式(后台 spawn,父 loop 在轮转):onPending 时把 renderPendingQuestionsBlock 追加进
 *   父 journal(message.user,[steer] 同款先例),父代理下一 step 可见,调 answer_subagent 应答。
 *
 * 审计:问答全程落父 journal(kind="custom",payload.topic="subagent.heavy-ask"/"-answer",
 * 含 requestId/命令/分类/决策来源 by/reason);不改 core journal types 的 closed union。
 * 决策 mini-turn 不写父会话 message.agent(防 deriveMessages 把无 tool.result 配对的
 * assistant 消息喂回污染对话史)。
 */
import type { Journal, HeavyOpMatch } from "@lampgenie/core";
import type { LlmProvider, Tool, ToolSpec } from "./loop";

/** 审批缺省时限:父 LLM 决策一次 mini-turn 的合理窗(面板 broker 是 60s;此处略宽)。 */
export const HEAVY_ASK_TIMEOUT_MS = 120_000;

/** 一条待决问题(结构化:谁/什么命令/为何类重操作)。 */
export interface HeavyQuestion {
  requestId: string;
  /** 子代理任务 id(spawn 的 taskId)。 */
  taskId: string;
  /** 子代理角色(worker/explore/…)。 */
  role: string;
  /** 发起工具名(run_cmd)。 */
  tool: string;
  /** 请求执行的命令原文。 */
  command: string;
  /** heavy-op 判定结果(分类/命中模式/说明)。 */
  match: HeavyOpMatch;
  /** 子代理补充上下文(可缺省;接线方可带子代理近期叙述摘要)。 */
  note?: string;
  askedAt: number;
  timeoutMs: number;
}

/** 答案:by=决策来源(parent-llm=父 LLM;timeout=超时 fail-closed;error=决策通道故障)。 */
export interface HeavyAnswer {
  requestId: string;
  approved: boolean;
  reason?: string;
  by: "parent-llm" | "timeout" | "error";
}

export interface ParentAskBrokerOptions {
  /** 父会话 journal(问答审计落这里;缺席=不入账,测试可省)。 */
  journal?: Journal;
  /** 父会话 id(审计事件归属)。 */
  sessionId?: string;
  /** 新问题注册回调(接线方据此注入父 loop / 启动决策泵)。 */
  onPending?: (q: HeavyQuestion) => void;
  /** 问题了结回调(批准/拒绝/超时都触发;接线方据此通知面板)。 */
  onSettled?: (a: HeavyAnswer, q: HeavyQuestion) => void;
}

interface PendingEntry extends HeavyQuestion {
  resolve: (a: HeavyAnswer) => void;
  timer: NodeJS.Timeout;
}

export class ParentAskBroker {
  private readonly pendingMap = new Map<string, PendingEntry>();
  private counter = 0;
  /** 新问题注册回调(接线方据此注入父 loop / 启动决策泵;公开可变=装配后可挂)。 */
  onPending?: (q: HeavyQuestion) => void;
  /** 问题了结回调(批准/拒绝/超时都触发;接线方据此通知面板)。 */
  onSettled?: (a: HeavyAnswer, q: HeavyQuestion) => void;
  private readonly journal?: Journal;
  private readonly sessionId?: string;

  constructor(opts: ParentAskBrokerOptions = {}) {
    this.journal = opts.journal;
    this.sessionId = opts.sessionId;
    this.onPending = opts.onPending;
    this.onSettled = opts.onSettled;
  }

  /** 子代理侧入口:注册待决问题并阻塞等待答案;超时=拒绝(fail-closed)+ 了结通知。 */
  ask(input: Omit<HeavyQuestion, "requestId" | "askedAt" | "timeoutMs"> & { timeoutMs?: number }): Promise<HeavyAnswer> {
    const timeoutMs = Math.max(input.timeoutMs ?? HEAVY_ASK_TIMEOUT_MS, 1);
    const requestId = "heavy-" + Date.now().toString(36) + "-" + (++this.counter).toString(36);
    const q: HeavyQuestion = {
      ...input,
      requestId,
      askedAt: Date.now(),
      timeoutMs,
    };
    return new Promise<HeavyAnswer>((resolve) => {
      // 注意:此处 timer 不 unref——「超时=拒绝(fail-closed)」是机制语义,timer 必须可靠触发
      // (unref 后,裸 Node 进程里唯一的未决 ask 会在事件循环空转时直接退出、超时永不触发,
      // step-071 探针实锤 exit 13 unfinished top-level await);代价=未决 ask 至多拖住进程退出
      // timeoutMs,有界可接受。生产 gateway 常驻进程无感。
      const timer = setTimeout(() => {
        this.settle(requestId, { requestId, approved: false, reason: "审批超时(父代理未在时限内应答),按拒绝处理(fail-closed)", by: "timeout" });
      }, timeoutMs);
      this.pendingMap.set(requestId, { ...q, resolve, timer });
      this.journal?.append({
        kind: "custom",
        sessionId: this.sessionId ?? "parent",
        payload: { topic: "subagent.heavy-ask", ...q },
      });
      try { this.onPending?.(q); } catch { /* 通知失败不影响子代理等待(超时兜底) */ }
    });
  }

  /** 父侧待决清单(旧者在前)。 */
  pending(): HeavyQuestion[] {
    return [...this.pendingMap.values()]
      .sort((a, b) => a.askedAt - b.askedAt)
      .map(stripResolve);
  }

  has(requestId: string): boolean {
    return this.pendingMap.has(requestId);
  }

  /**
   * 父侧应答:唤醒等待方。返回 false=无此待决请求(已超时被拒/已应答/id 拼错)。
   * by 缺省 parent-llm(本机制的应答主体就是父 agent;面板代答等场景显式传)。
   */
  answer(requestId: string, decision: { approved: boolean; reason?: string }, by: HeavyAnswer["by"] = "parent-llm"): boolean {
    const entry = this.pendingMap.get(requestId);
    if (!entry) return false;
    this.settle(requestId, { requestId, approved: decision.approved, ...(decision.reason ? { reason: decision.reason } : {}), by });
    return true;
  }

  /** 了结:清 timer/移出 pending/落审计/通知/唤醒。 */
  private settle(requestId: string, answer: HeavyAnswer): void {
    const entry = this.pendingMap.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingMap.delete(requestId);
    this.journal?.append({
      kind: "custom",
      sessionId: this.sessionId ?? "parent",
      payload: { topic: "subagent.heavy-answer", ...answer, question: stripResolve(entry) },
    });
    try { this.onSettled?.(answer, stripResolve(entry)); } catch { /* 通知失败不影响应答 */ }
    entry.resolve(answer);
  }
}

/** 去 resolve/timer(审计与回调只带数据面)。 */
function stripResolve(e: PendingEntry): HeavyQuestion {
  return {
    requestId: e.requestId, taskId: e.taskId, role: e.role, tool: e.tool,
    command: e.command, match: e.match, askedAt: e.askedAt, timeoutMs: e.timeoutMs,
    ...(e.note ? { note: e.note } : {}),
  };
}

// ---- 父侧注入与应答面(注入式通道) ----

/** 待决问题块(注入父 loop 的结构化文本;system-reminder 形态,面板与模型都可读)。 */
export function renderPendingQuestionsBlock(questions: HeavyQuestion[]): string {
  if (questions.length === 0) return "";
  const lines = [
    "<system-reminder>",
    `[子代理重操作审批] 有 ${questions.length} 个待决申请需要你决策——立即用 answer_subagent 工具逐条应答(超时未答=自动拒绝)。决策看三点:该命令对任务是否必要、当前资源余量、是否已有重操作在跑;批准或拒绝都给一句理由。`,
  ];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.requestId}] 子代理 ${q.role}(task=${q.taskId})经 ${q.tool} 请求执行 [${q.match.category}] \`${q.command.slice(0, 160)}\`(判重:${q.match.note ?? q.match.pattern})${q.note ? ";补充:" + q.note.slice(0, 120) : ""}`);
  });
  lines.push("</system-reminder>");
  return lines.join("\n");
}

/** answer_subagent 工具 schema(决策 mini-turn 与父 loop 工具共用同一名义与参数)。 */
export const ANSWER_SUBAGENT_SPEC: ToolSpec = {
  name: "answer_subagent",
  description: "应答子代理的重操作执行申请(批准=子代理放行执行;拒绝=子代理收到拒绝与理由,须走替代路径)。每个待决 requestId 恰好应答一次。",
  parameters: {
    type: "object",
    properties: {
      requestId: { type: "string", description: "待决申请 id(问题块里方括号内的 id)" },
      approved: { type: "boolean", description: "true=批准放行;false=拒绝" },
      reason: { type: "string", description: "一句理由(拒绝必填;批准建议填)" },
    },
    required: ["requestId", "approved"],
  },
};

/** answer_subagent 工具(挂父 loop):执行=broker.answer,结果回模型。
 * isReadOnly=true(控制面豁免):本工具无文件/命令副作用,只应答本机制自己的待决状态——
 * 若过规则闸,缺省 ask 会把「应答审批」自己送去审批(机制自锁,缺省模式=ask 必现)。
 * 语义先例=skill_view(纯进程内状态+遥测,不设闸)。 */
export function buildSubagentAnswerTool(broker: ParentAskBroker): Tool {
  return {
    ...ANSWER_SUBAGENT_SPEC,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args: unknown) {
      const a = (args ?? {}) as { requestId?: string; approved?: boolean; reason?: string };
      if (!a.requestId || typeof a.approved !== "boolean") return "错误:requestId 与 approved 必填";
      const ok = broker.answer(a.requestId, { approved: a.approved, ...(a.reason ? { reason: a.reason } : {}) });
      return ok
        ? `已应答 ${a.requestId}:${a.approved ? "批准" : "拒绝"}${a.reason ? "(" + a.reason + ")" : ""}`
        : `错误:无此待决请求 ${a.requestId}(可能已超时自动拒绝或已应答过)`;
    },
  };
}

// ---- 父决策泵(并发通道:前台 spawn 期间父 loop 阻塞,由接线方并发调用本函数驱动父 LLM) ----

export const PARENT_DECISION_SYSTEM = [
  "你是 coding 主 agent。子代理在执行你派发的任务时,就重操作(build/install/全量测试等大资源命令)向你申请批准。",
  "决策指引:",
  "1. 必要性:该命令对完成子任务是否必要?有没有更轻的等价替代(单文件测试/只构建涉及的包)?",
  "2. 资源与并发:当前是否已有构建/安装/全量测试在跑?同时跑多个重操作会拖垮整机。",
  "3. 裁决:必要且资源允许→批准;不必要或资源紧张→拒绝。批准或拒绝都要在 reason 给一句理由,让子代理知道下一步怎么走。",
  "只应答列出的问题,不回答其它事情;对每个 requestId 恰好调用一次 answer_subagent。",
].join("\n");

export interface DriveParentDecisionResult {
  /** 本轮驱动的问题数。 */
  asked: number;
  /** 实际应答数(解析不到工具调用时 < asked,未答的由超时 fail-closed 兜底)。 */
  answered: number;
}

/**
 * 决策泵:取 broker 待决清单→以决策指引+结构化问题+answer_subagent 工具调父 LLM 一次
 * 决策 mini-turn→解析 toolCalls 逐条应答。解析不到任何应答工具调用时重试一次(R4:
 * mini-turn 幻觉兜底;仍失败=不 answer,超时 fail-closed 兜底,绝不编造批准)。
 */
export async function driveParentDecision(
  broker: ParentAskBroker,
  llm: LlmProvider,
  opts: { signal?: AbortSignal; maxQuestions?: number } = {},
): Promise<DriveParentDecisionResult> {
  const run = async (): Promise<DriveParentDecisionResult> => {
    const questions = broker.pending().slice(0, Math.max(opts.maxQuestions ?? 8, 1));
    if (questions.length === 0) return { asked: 0, answered: 0 };
    const block = renderPendingQuestionsBlock(questions).replace(/<\/?system-reminder>/g, "");
    const messages: import("./loop").Message[] = [
      { role: "system", content: PARENT_DECISION_SYSTEM },
      { role: "user", content: "待决申请如下,请逐条用 answer_subagent 应答:\n\n" + block },
    ];
    const res = await llm.chat(messages, [ANSWER_SUBAGENT_SPEC], opts.signal);
    let answered = 0;
    for (const call of res.toolCalls ?? []) {
      if (call.name !== ANSWER_SUBAGENT_SPEC.name) continue;
      let args: { requestId?: string; approved?: boolean; reason?: string } = {};
      try { args = JSON.parse(call.arguments ?? "{}"); } catch { continue; }
      if (!args.requestId || typeof args.approved !== "boolean") continue;
      if (broker.answer(args.requestId, { approved: args.approved, ...(args.reason ? { reason: args.reason } : {}) })) answered++;
    }
    return { asked: questions.length, answered };
  };
  const first = await run();
  if (first.answered > 0 || first.asked === 0) return first;
  // 幻觉兜底:一次 mini-turn 没产生任何有效应答→重试一次;仍失败交给超时 fail-closed。
  return await run();
}
