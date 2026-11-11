/**
 * Router 模型( super-agent 关系升级 P1):
 * Trigger(入口事件)/ Ticket(任务登记)/ phase(阶段)/ disposition(处置落账)。
 * P1 零 LLM:Trigger 只做确定性判定;Ticket 承接既有 TaskSupervisor 的 task.id。
 */

/** 入口来源。 */
import type { Mandate } from "./policy.js";
import type { RouteIdentity, RouteIdentityCode } from "@lampgenie/runtime/router/route-identity";

export type TriggerSource = "panel" | "im";

/** 入口事件:面板 task.submit / 飞书 im-inbound 统一形态。 */
export interface Trigger {
  id: string;
  source: TriggerSource;
  /** 落到的会话(owner lane)。 */
  sessionId: string;
  instruction: string;
  /** 订阅关联键:活 Ticket 的 threadKey 后续 Trigger 直投 owner worker(steer 直通)。 */
  threadKey: string;
  /** 显式授权面板请求携带的幂等键(task.submit.idempotencyKey;server 侧再加 user. 前缀)。 */
  idempotencyKey?: string;
  /** 发送者身份(im 白名单判定用)。 */
  identity?: string;
  /** 人显式点名(dm/mention)→ explicit 判定。 */
  addressed?: boolean;
  at?: number;
}

/** Ticket 阶段:observed(只落账零派发)→ open(已派发,承接 task.id)→ closed。 */
export type TicketPhase = "observed" | "open" | "closed";

/** Router 侧任务登记(承接 TaskSupervisor 的 task,不替代)。 */
export interface Ticket {
  ticketId: string;
  triggerId: string;
  sessionId: string;
  phase: TicketPhase;
  threadKey: string;
  /** 派发承接的 TaskSupervisor task id(open 起)。 */
  taskId?: string;
 /** P3 Mandate 授权凭证(explicit/auto-accept 派发时产出;重启恢复后按当前 policy revalidate)。 */
  mandate?: Mandate;
 /**
 * 入站时冻结的路由身份快照(只读)。Ticket 存在期间后续判定复用它,不从 trigger 重新派生;
 * 重启恢复后随 tickets.json 一并回读(只校验不重算)。
 */
  routeIdentity?: RouteIdentity;
  /** 创建时刻(epoch ms)。 */
  createdAt: number;
  updatedAt: number;
}

/** 触发处置落账(intake/filter/observe/派发全链路审计行)。 */
export interface Disposition {
  triggerId: string;
  /** stored / duplicate / filtered / dispatched / steered / observed。 */
  outcome: string;
  /** 订阅直通命中的 ticketId(仅 steered)。 */
  steeredTicketId?: string;
  /** observe 负面断言用:若 auto 模式本应 accept(推断候选恒不派发)。 */
  would_accept?: boolean;
  /** policy 版本哈希(派发/观察决策时的 policy 快照)。 */
  policyVersion?: string;
 /** P2 研判:ignore 降级原因(missing-intent-evidence / decision-ignore)。 */
  reason?: string;
 /** P2 研判:accept 派发时引用的触发原文证据(sr8 闸必备)。 */
  intent_evidence?: string;
 /** P3 派发随行的 Mandate 摘要(无凭证字段,assertNoCredential 守门)。 */
  mandate?: Mandate;
 /** :本次判定所用的冻结路由身份快照(可审计复算;不含凭证字段)。 */
  routeIdentity?: RouteIdentity;
 /** :身份码(OK / 派生失败码);不写=旧口径行。 */
  routeIdentityCode?: RouteIdentityCode;
  at: number;
}
