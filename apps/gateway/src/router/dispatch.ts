/**
 * dispatch:explicit/订阅命中派发 + observe 零派发 + 订阅直通(steer)。
 * - explicit → tm.submit 恰 1 次(idempotencyKey 派生自 trigger;task.submitted 回执与现状同构);
 * - 订阅命中且承接任务仍 running → journal 注入 steer(agent-wiring steer_task 同语义),直投 owner worker;
 * - observe 路径只落 disposition 即返回——observe 模式零 LLM 边界落点(不调 tm.submit、不触发 runSuperAgentTurn);
 * - P2:auto 模式 inferred 候选接 LLM 研判(deps.assess=runSuperAgentTurn 包装),
 *   settleAccept 闸(sr8):accept 必须带 intent_evidence,缺证据降级 ignore;研判产物全量落 audit。
 * - :身份在入口派生一次并冻结(freezeRouteIdentity),gate 只校验不重算;派生失败按 observe 落账,零派发。
 */
import type { Task } from "@lampgenie/core";
import type { Ticket, Trigger, Disposition } from "./model.js";
import { gate, policyVersion, revalidate, type PolicyConfig, type Mandate } from "./policy.js";
import { subscriptionsFromTickets } from "./ticket-subscriptions.js";
import { settleAccept } from "./audit.js";
import {
  freezeRouteIdentity,
  type FreezeRouteIdentityResult,
} from "@lampgenie/runtime/router/route-identity";

/** 最小 TaskSupervisor 面(router 只用到 submit/get)。 */
export interface TmFace {
  submit(kind: "user" | "system", sessionId: string, instruction: string, extra?: Partial<Pick<Task, "targetNode" | "resourceTags" | "idempotencyKey" | "credentialRef" | "projectId" | "title" | "attachments">>): Task;
  get(taskId: string): Task | undefined;
}

export interface DispatchDeps {
  tm: TmFace;
  config: PolicyConfig;
  /** Ticket 登记表(ticketId → Ticket)。 */
  tickets: Map<string, Ticket>;
  /** threadKey → 活(open)Ticket 订阅表。 */
  liveSubscriptions: Map<string, boolean>;
  /** steer 直通注入(agent-wiring steer_task 同语义:message.user + task.progress)。 */
  steer?: (ticket: Ticket, trigger: Trigger) => void;
  /** disposition 落账。 */
  saveDisposition: (d: Disposition) => void;
  /** ticket.updated 广播(payload 含 phase 字段;P3 面板阶段表消费)。 */
  broadcast?: (payload: { ticketId: string; phase: string; taskId?: string; triggerId: string; threadKey: string }) => void;
  now?: () => number;
  /** 面板主径透传字段(targetNode/projectId/attachments 等;回执逐字段保持)。 */
  extra?: Partial<Pick<Task, "targetNode" | "resourceTags" | "credentialRef" | "projectId" | "attachments">>;
  /** P2 LLM 研判接口位(runCompanionTurn 产 intent_evidence;P1 不得调用任何模型,恒 undefined)。 */
  assess?: (trigger: Trigger) => ({ decision: "accept" | "ignore"; intent_evidence?: string } | undefined) | Promise<{ decision: "accept" | "ignore"; intent_evidence?: string } | undefined>;
  /** P3 Mandate 产出钩子(缺省=内置 issueMandate;测试/恢复路径可注入 stub)。 */
  issueMandate?: (trigger: Trigger, config: PolicyConfig, now: number) => Mandate;
}

export type DispatchOutcome =
  | { kind: "dispatched"; task: Task; ticket: Ticket }
  | { kind: "steered"; ticket: Ticket; task?: Task }
  | { kind: "observed"; disposition: Disposition };

let ticketSeq = 0;

/**
 * 从入口 trigger + 当前策略派生并冻结路由身份(纯逻辑,不 throw,确定性)。
 * - tenantId = 入口来源名(panel/im);
 * - sourceKind:panel=dm、im=group;
 * - subjectId = trigger.identity ?? trigger.sessionId(不知道主体的来源不进入判定);
 * - allowedTenants = 已监听来源名(未监听来源 → TENANT_DENIED,与监听门同源)。
 */
export function deriveDispatchRouteIdentity(trigger: Trigger, config: PolicyConfig): FreezeRouteIdentityResult {
  return freezeRouteIdentity(
    { id: trigger.id, source: trigger.source, identity: trigger.identity, threadKey: trigger.threadKey },
    {
      tenantId: trigger.source,
      sourceKind: trigger.source === "panel" ? "dm" : "group",
      subjectId: trigger.identity ?? trigger.sessionId,
      allowedTenants: config.sources.filter((s) => s.listened).map((s) => s.name),
    },
  );
}

/** P3 Mandate 产出(explicit/auto-accept 派发时):只含授权溯源要素,无任何凭证字段(audit assertNoCredential 守门)。 */
export function issueMandate(trigger: Trigger, config: PolicyConfig, at: number, strength: "explicit" | "inferred" = "explicit"): Mandate {
  return {
    policyVersion: policyVersion(config),
    scope: trigger.source,
    strength,
    ruleIds: config.rules.filter((r) => r.enabled).map((r) => r.id),
    sender: trigger.identity ?? trigger.source,
    at,
  };
}

/** P3 复验活 Ticket 的 mandate:失效 → phase=closed + disposition outcome="revalidate_failed"(不 throw,幂等)。 */
export function revalidateTicket(ticket: Ticket, currentPolicyConfig: PolicyConfig, hooks: {
  now: number;
  saveDisposition: (d: Disposition) => void;
  broadcast?: (payload: { ticketId: string; phase: string; taskId?: string; triggerId: string; threadKey: string }) => void;
}): boolean {
  if (!ticket.mandate || revalidate(ticket.mandate, currentPolicyConfig)) return true;
  ticket.phase = "closed";
  ticket.updatedAt = hooks.now;
  hooks.saveDisposition({
    triggerId: `${ticket.ticketId}:revalidate`,
    outcome: "revalidate_failed",
    policyVersion: policyVersion(currentPolicyConfig),
    at: hooks.now,
    ...(ticket.routeIdentity !== undefined ? { routeIdentity: ticket.routeIdentity, routeIdentityCode: "OK" as const } : {}),
  });
  hooks.broadcast?.({ ticketId: ticket.ticketId, phase: ticket.phase, ...(ticket.taskId !== undefined ? { taskId: ticket.taskId } : {}), triggerId: ticket.triggerId, threadKey: ticket.threadKey });
  return false;
}

/** 订阅直通幂等键派生:客户端键沿用 user. 命名空间(与 server.ts 现状一致);无键用 router.<triggerId>。 */
export function deriveIdempotencyKey(trigger: Trigger): string {
  return trigger.idempotencyKey !== undefined ? `user.${trigger.idempotencyKey}` : `router.${trigger.id}`;
}

/** 派发/直通/观察三出口(全部确定性,零 LLM)。 */
export async function dispatch(trigger: Trigger, deps: DispatchDeps): Promise<DispatchOutcome> {
  const now = deps.now ?? Date.now;
  const version = policyVersion(deps.config);
 // 身份在 gate 之前派生并冻结一次。
 // 恢复/revalidate 路径:threadKey 上已有 open Ticket 且 Ticket 带着冻结快照 → 直接复用同一快照,
 // 不从 trigger 重新派生(重启恢复的 ticket 由 tickets.json 回读,身份不重算)。
  const openTicket = trigger.threadKey
    ? [...deps.tickets.values()].find((t) => t.threadKey === trigger.threadKey && t.phase === "open")
    : undefined;
  const frozen: FreezeRouteIdentityResult = openTicket?.routeIdentity !== undefined
    ? { ok: true, identity: openTicket.routeIdentity }
    : deriveDispatchRouteIdentity(trigger, deps.config);
  if (!frozen.ok) {
 // 派生失败:按 observe 落 disposition,零派发、不 throw(reason 带稳定码,调用方按码判档)。
    const disposition: Disposition = {
      triggerId: trigger.id,
      outcome: "observed",
      reason: `route-identity:${frozen.code}`,
      routeIdentityCode: frozen.code,
      policyVersion: version,
      at: now(),
    };
    deps.saveDisposition(disposition);
    return { kind: "observed", disposition };
  }
  const routeIdentity = frozen.identity;
 // 生产 dispatch 合成正式订阅表(open Ticket + liveSubscriptions)交给 gate,
 // 新订阅机制默认生效;旧 liveSubscriptions 参数保留(传了新表时 gate 只看新表)。
  const gateNow = now();
 // 只校验不重算:gate 读快照主体判白名单;不传 currentGeneration(冻结值 generation 缺省 0,当前代际同为 0)。
  const verdict = gate(trigger, deps.config, deps.liveSubscriptions, {
    routeIdentity,
    subscriptions: subscriptionsFromTickets(deps.tickets, deps.liveSubscriptions, { now: gateNow }),
    now: gateNow,
  });
  // 订阅直通:threadKey 命中 open Ticket 且承接任务仍 running → steer 注入,不再新开任务。
  if (verdict.admissible && trigger.threadKey && deps.liveSubscriptions.get(trigger.threadKey) === true) {
    const ticket = openTicket;
    const running = ticket?.taskId !== undefined && deps.tm.get(ticket.taskId)?.state === "running";
    if (ticket && running) {
      deps.steer?.(ticket, trigger);
      deps.saveDisposition({ triggerId: trigger.id, outcome: "steered", steeredTicketId: ticket.ticketId, routeIdentityCode: "OK", policyVersion: version, at: now() });
      ticket.updatedAt = now();
      const task = ticket.taskId !== undefined ? deps.tm.get(ticket.taskId) : undefined;
      deps.broadcast?.({ ticketId: ticket.ticketId, phase: ticket.phase, ...(ticket.taskId !== undefined ? { taskId: ticket.taskId } : {}), triggerId: trigger.id, threadKey: ticket.threadKey });
      return { kind: "steered", ticket, ...(task ? { task } : {}) };
    }
 // P3:订阅命中但承接任务已终态(非 running)→ steer 落空不静默:落 steer_miss 审计行
    // (此前直接掉到 explicit 快径,回退行为保持,只补 disposition)。
    deps.saveDisposition({ triggerId: trigger.id, outcome: "steer_miss", steeredTicketId: ticket?.ticketId, routeIdentityCode: "OK", policyVersion: version, at: now() });
  }
  if (verdict.admissible) {
    // explicit 快径:server.ts:850 调用点带 idempotencyKey(派生自 trigger.id;同 trigger 重发不重建任务)。
    const task = deps.tm.submit("user", trigger.sessionId, trigger.instruction, {
      idempotencyKey: deriveIdempotencyKey(trigger),
      ...(deps.extra ?? {}),
    });
    const t = now();
    const ticket: Ticket = {
      ticketId: `ticket-${++ticketSeq}`,
      triggerId: trigger.id,
      sessionId: trigger.sessionId,
      phase: "open",
      threadKey: trigger.threadKey,
      taskId: task.id,
 // 冻结身份随 Ticket 落账(只读快照;恢复后 gate 复用不重算)。
      routeIdentity,
      createdAt: t,
      updatedAt: t,
      mandate: (deps.issueMandate ?? issueMandate)(trigger, deps.config, t, "explicit"),
    };
    deps.tickets.set(ticket.ticketId, ticket);
    deps.liveSubscriptions.set(trigger.threadKey, true);
    deps.saveDisposition({ triggerId: trigger.id, outcome: "dispatched", routeIdentity, routeIdentityCode: "OK", policyVersion: version, at: now(), mandate: ticket.mandate });
    deps.broadcast?.({ ticketId: ticket.ticketId, phase: ticket.phase, taskId: task.id, triggerId: trigger.id, threadKey: ticket.threadKey });
    return { kind: "dispatched", task, ticket };
  }
 // P2 研判接线:observe 落账前,gate 判 inferred(不派发)且 mode=auto 时走 LLM 研判
  // (runSuperAgentTurn 产 decision+intent_evidence;observe 模式恒不调——P1 零新增 LLM 调用不回归)。
  // settleAccept 闸(sr8):accept 必须带 intent_evidence,缺证据仍 ignore 落账。
  if (deps.config.mode === "auto" && deps.assess && !verdict.admissible) {
 // P3 Eval 重试熔断(DSH evals.ts 等价):deadline(Promise.race)内未 settle 或抛错 →
    // 重排同一 trigger(≤2 次);第三次失败记 unavailable(fail-soft,不派发不 throw)。observe/explicit 不经此路径。
    const deadline = deps.config.evalDeadlineMs ?? 120_000;
    const attemptAssess = async (): Promise<{ decision: "accept" | "ignore"; intent_evidence?: string } | undefined | "timeout"> => {
      return await Promise.race([
        deps.assess!(trigger),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadline)),
      ]).catch(() => "timeout" as const);
    };
    let assessment: { decision: "accept" | "ignore"; intent_evidence?: string } | undefined | "timeout";
    let attempts = 0;
    // attempts 计数含首跑:1=首发,2/3=重排(DSH「过期重排×2 后 unavailable」)
    do {
      assessment = await attemptAssess();
      attempts++;
    } while (assessment === "timeout" && attempts < 3);
    if (assessment === "timeout") {
      deps.saveDisposition({ triggerId: trigger.id, outcome: "unavailable", reason: `assess-timeout-${attempts}`, routeIdentityCode: "OK", policyVersion: version, at: now() });
      return { kind: "observed", disposition: { triggerId: trigger.id, outcome: "unavailable", reason: `assess-timeout-${attempts}`, routeIdentityCode: "OK", policyVersion: version, at: now() } };
    }
    if (assessment) {
      const settled = settleAccept(assessment);
      const assessRecord: Disposition = {
        triggerId: trigger.id,
        outcome: settled.kind === "accept" ? "assessed-accept" : "assessed-ignore",
        ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
        ...(assessment.intent_evidence !== undefined ? { intent_evidence: assessment.intent_evidence } : {}),
        routeIdentity,
        routeIdentityCode: "OK",
        policyVersion: version,
        at: now(),
      };
      deps.saveDisposition(assessRecord);
      if (settled.kind === "accept") {
        const task = deps.tm.submit("user", trigger.sessionId, trigger.instruction, {
          idempotencyKey: deriveIdempotencyKey(trigger),
          ...(deps.extra ?? {}),
        });
        const t = now();
        const ticket: Ticket = {
          ticketId: `ticket-${++ticketSeq}`,
          triggerId: trigger.id,
          sessionId: trigger.sessionId,
          phase: "open",
          threadKey: trigger.threadKey,
          taskId: task.id,
          routeIdentity,
          createdAt: t,
          updatedAt: t,
          mandate: (deps.issueMandate ?? issueMandate)(trigger, deps.config, t, "inferred"),
        };
        deps.tickets.set(ticket.ticketId, ticket);
        deps.liveSubscriptions.set(trigger.threadKey, true);
        // accept 派发落单条 dispatched 记录(研判 evidence 随行落审计;不再另落 assessed-accept——
        // intake disposition 表按 triggerId 去重,两条会互相覆盖)。
        deps.saveDisposition({ triggerId: trigger.id, outcome: "dispatched", ...(assessment.intent_evidence !== undefined ? { intent_evidence: assessment.intent_evidence } : {}), ...(ticket.mandate !== undefined ? { mandate: ticket.mandate } : {}), routeIdentity, routeIdentityCode: "OK", policyVersion: version, at: now() });
        deps.broadcast?.({ ticketId: ticket.ticketId, phase: ticket.phase, taskId: task.id, triggerId: trigger.id, threadKey: ticket.threadKey });
        return { kind: "dispatched", task, ticket };
      }
      return { kind: "observed", disposition: assessRecord };
    }
  }
  // observe 零派发:只落 disposition(observed),不调 tm.submit、不触发任何 LLM/super agent 回合。
  const disposition: Disposition = { triggerId: trigger.id, outcome: "observed", ...(verdict.would_accept ? { would_accept: true } : {}), routeIdentity, routeIdentityCode: "OK", policyVersion: version, at: now() };
  deps.saveDisposition(disposition);
  return { kind: "observed", disposition };
}
