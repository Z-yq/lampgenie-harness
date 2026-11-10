/**
 * Router 装配( P1):面板 task.submit(server.ts)与飞书 im-inbound.ts(app.ts)两主径
 * 统一 Trigger 入 router;其余 tm.submit 直调点不收敛(等效 explicit,不破坏行为)。
 * P1 零 LLM:engine 不做任何模型调用(P2 才接 runCompanionTurn)。
 */
import type { Journal, Task } from "@lampgenie/core";
import type { TaskSupervisor } from "../task-manager.js";
import type { Trigger, Ticket, Disposition } from "./model.js";
import { loadPolicyConfig, policyVersion, gate, type PolicyConfig } from "./policy.js";
import { createIntakeStore, receive, buildTrigger, type ReceiveResult, type IntakeStore } from "./intake.js";
import { dispatch, revalidateTicket, type DispatchOutcome } from "./dispatch.js";
import { createAuditLog, type AuditLog } from "./audit.js";

export interface RouterDeps {
  taskManager: TaskSupervisor;
  journal: Journal;
  /** harness 根(.genie/router/ 落账根);缺省=仅内存账本(测试形态)。 */
  root?: string;
  /** ticket.updated 广播钩子(app.ts broadcastRaw / server broadcast 注入)。 */
  onTicketUpdated?: (payload: { ticketId: string; phase: string; taskId?: string; triggerId: string; threadKey: string }) => void;
  /** steer 注入钩子(app.ts 注入 journal 语义:对齐 agent-wiring steer_task)。 */
  steer?: (ticket: Ticket, trigger: Trigger) => void;
 /** P2 LLM 研判钩子:auto 模式 inferred 候选研判(runSuperAgentTurn 包装,可异步);
   *  observe 模式恒不调用(dispatch 侧 auto 闸);返回 undefined=fail-soft 缺证据→ignore。 */
  assess?: (trigger: Trigger) => ({ decision: "accept" | "ignore"; intent_evidence?: string } | undefined) | Promise<{ decision: "accept" | "ignore"; intent_evidence?: string } | undefined>;
  now?: () => number;
  config?: PolicyConfig;
 /** P3 tickets.json 持久化/恢复 + audit 落盘共用的 io 注入(测试可 stub)。 */
  io?: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    mkdirSync: (p: string, opts: { recursive: boolean }) => void;
    appendFileSync: (p: string, data: string, enc: string) => void;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  };
}

export interface RouterSubmitInput {
  source: "panel" | "im";
  sessionId: string;
  instruction: string;
  idempotencyKey?: string;
  threadKey?: string;
  /** 发送者身份(im 白名单判定用)。 */
  identity?: string;
  /** 人显式点名(dm/mention 命中 task 路由)= addressed → explicit,保持飞书既有行为。 */
  addressed?: boolean;
  /** TaskSupervisor.submit 透传字段(回执逐字段保持:targetNode/projectId/attachments/title 等)。 */
  extra?: Partial<Pick<Task, "targetNode" | "resourceTags" | "credentialRef" | "projectId" | "title" | "attachments">>;
}

export interface RouterApi {
  /** 主径入口:面板 task.submit / 飞书 im-inbound 提交。返回 intake 三判据 + 派发结果。 */
  submit(input: RouterSubmitInput): Promise<{ intake: ReceiveResult; outcome: DispatchOutcome | null }>;
  /** 已显式派发(server 直提路径)登记 Ticket(直调点等效 explicit,不破坏行为)。 */
  registerExplicit(input: { triggerId: string; source: "panel" | "im"; sessionId: string; taskId: string }): Ticket;
  tickets(): Ticket[];
  dispositions(): Disposition[];
  policyVersion(): string;
  config(): PolicyConfig;
}

export function createRouter(deps: RouterDeps): RouterApi {
  const now = deps.now ?? Date.now;
  const config = deps.config ?? loadPolicyConfig(deps.root ?? "", {
    existsSync: deps.io?.existsSync ?? (() => false),
    readFileSync: (p) => (deps.io?.readFileSync ? deps.io.readFileSync(p, "utf8") : ""),
  });
  const audit: AuditLog | null = deps.root
    ? createAuditLog(deps.root.replace(/\\/g, "/").replace(/\/$/, "") + "/.genie/router/audit.jsonl", deps.io ? {
      mkdirSync: deps.io.mkdirSync,
      appendFileSync: deps.io.appendFileSync,
      existsSync: deps.io.existsSync,
      readFileSync: deps.io.readFileSync,
    } : undefined)
    : null;
  const store: IntakeStore = createIntakeStore(config);
  const tickets = new Map<string, Ticket>();
  const liveSubscriptions = new Map<string, boolean>();
  /** trigger.id → 首次结果(duplicate 二次 receive 直接回放,不重复入队/派发)。 */
  const results = new Map<string, { intake: ReceiveResult; outcome: DispatchOutcome | null }>();
  let seq = 0;

  const persist = (d: Disposition): void => {
    store.saveDisposition(d);
    audit?.append({
      at: d.at,
      triggerId: d.triggerId,
      outcome: d.outcome,
      ...(d.steeredTicketId !== undefined ? { steeredTicketId: d.steeredTicketId } : {}),
      ...(d.would_accept !== undefined ? { would_accept: d.would_accept } : {}),
      ...(d.policyVersion !== undefined ? { policyVersion: d.policyVersion } : {}),
      ...(d.reason !== undefined ? { reason: d.reason } : {}),
      ...(d.intent_evidence !== undefined ? { intent_evidence: d.intent_evidence } : {}),
    });
    ticketSink.touch();
  };
 // ── P3 重启恢复(DSH restore 等价):tickets.json 落盘 + 启动重放 phase=open Ticket ──
  // 落盘文件:.genie/router/tickets.json(数组形式,全量覆写;Ticket 数小,无增量必要)。
  const routerDir = deps.root ? deps.root.replace(/\\/g, "/").replace(/\/$/, "") + "/.genie/router" : null;
  const ticketsPath = routerDir ? routerDir + "/tickets.json" : null;
  const writeTickets = (): void => {
    if (!ticketsPath || !deps.io?.writeFileSync) return;
    try { deps.io.writeFileSync(ticketsPath, JSON.stringify({ seq, tickets: [...tickets.values()] }, null, 2), "utf8"); } catch { /* fail-soft:持久化失败不阻断派发 */ }
  };
  const ticketSink = {
    save: writeTickets,
    /** dispatch 侧 ticket 变更后回写(经 onChange 钩子挂接,避免循环 import)。 */
    touch: (): void => { writeTickets(); },
  };
  if (ticketsPath && deps.io?.existsSync?.(ticketsPath) && deps.io?.readFileSync) {
    try {
      const raw = JSON.parse(deps.io.readFileSync(ticketsPath, "utf8")) as { seq?: number; tickets?: Ticket[] };
      for (const t of raw.tickets ?? []) {
        if (t && typeof t.ticketId === "string" && t.phase === "open") {
          // 只恢复 open Ticket:closed 是终态,重放无意义;同 ticketId 幂等(重复 restore 不双开)。
          tickets.set(t.ticketId, t);
          liveSubscriptions.set(t.threadKey, true);
        }
      }
      seq = Math.max(seq, raw.seq ?? 0, ...[...(raw.tickets ?? [])].map((t) => Number(/^\d+$/.exec(t.ticketId ?? "")?.[1] ?? 0)));
      // 恢复后逐个 revalidate:policy 已变 → 吊销(closed+审计);未变 → 订阅直通直接可用。
      for (const t of [...tickets.values()]) {
        revalidateTicket(t, config, { now: now(), saveDisposition: persist, ...(deps.onTicketUpdated ? { broadcast: deps.onTicketUpdated } : {}) });
      }
      writeTickets();
    } catch { /* 损坏文件:忽略恢复,从空表开始(fail-soft) */ }
  }


  const api: RouterApi = {
    async submit(input) {
      const trigger = buildTrigger({
        source: input.source,
        sessionId: input.sessionId,
        instruction: input.instruction,
        idempotencyKey: input.idempotencyKey,
        threadKey: input.threadKey,
        now,
      });
      const enriched: Trigger = {
        ...trigger,
        ...(input.identity !== undefined ? { identity: input.identity } : {}),
        ...(input.addressed !== undefined ? { addressed: input.addressed } : {}),
      };
      const first = receive(enriched, store, now);
      if (first === "duplicate") {
        // 同 trigger.id 二次 receive:回放首次结果,不重复入队(duplicate 复用 TaskSupervisor 幂等回执)。
        const cached = results.get(enriched.id);
        if (cached) return cached;
        return { intake: "duplicate", outcome: null };
      }
      if (first === "filtered") {
        const outcome: DispatchOutcome = { kind: "observed", disposition: { triggerId: enriched.id, outcome: "filtered", at: now() } };
        persist(outcome.disposition);
        results.set(enriched.id, { intake: "filtered", outcome });
        return { intake: "filtered", outcome };
      }
      const outcome = await dispatch(enriched, {
        tm: deps.taskManager,
        config,
        tickets,
        liveSubscriptions,
        steer: deps.steer,
        ...(deps.assess ? { assess: deps.assess } : {}),
        saveDisposition: persist,
        broadcast: deps.onTicketUpdated,
        now,
        ...(input.extra !== undefined ? { extra: input.extra } : {}),
      });
      results.set(enriched.id, { intake: "stored", outcome });
      return { intake: "stored", outcome };
    },
    registerExplicit(input) {
      const t = now();
      const ticket: Ticket = {
        ticketId: `ticket-${++seq}`,
        triggerId: input.triggerId,
        sessionId: input.sessionId,
        phase: "open",
        threadKey: `session:${input.sessionId}`,
        taskId: input.taskId,
        createdAt: t,
        updatedAt: t,
      };
      tickets.set(ticket.ticketId, ticket);
      liveSubscriptions.set(ticket.threadKey, true);
      ticketSink.touch();
      deps.onTicketUpdated?.({ ticketId: ticket.ticketId, phase: ticket.phase, taskId: ticket.taskId, triggerId: input.triggerId, threadKey: ticket.threadKey });
      return ticket;
    },
    tickets: () => [...tickets.values()],
    dispositions: () => store.dispositions(),
    policyVersion: () => policyVersion(config),
    config: () => config,
  };
  return api;
}

export { gate, policyVersion, loadPolicyConfig, receive, buildTrigger, createIntakeStore };
export type { PolicyConfig, ReceiveResult };
