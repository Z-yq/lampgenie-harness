/**
 * intake 去重三判据(step-0143 P1,参照 dsh-superagent-prototype/src/core/intake.ts#receive):
 * stored / duplicate / filtered——scope 未监听落 filtered;同 trigger.id 二次 receive 返回 duplicate 不重复入队。
 * P1 只接两个主径入口:面板 task.submit(server.ts)与飞书 im-inbound.ts;
 * 其余 tm.submit 直调点不收敛(等效 explicit,不破坏行为)。
 */
import type { Trigger, Disposition } from "./model.js";
import type { PolicyConfig } from "./policy.js";

export type ReceiveResult = "stored" | "duplicate" | "filtered";

export interface IntakeStore {
  /** trigger 去重表:id → 已收到。 */
  hasTrigger(id: string): boolean;
  saveTrigger(trigger: Trigger): void;
  saveDisposition(disposition: Disposition): void;
  /** disposition 账本(读面)。 */
  dispositions(): Disposition[];
  /** scope 判定用的来源监听表(source → listened)。 */
  sourceScope(source: string): { listened: boolean };
}

export function createIntakeStore(config?: PolicyConfig): IntakeStore {
  const triggers = new Map<string, Trigger>();
  const dispositions = new Map<string, Disposition>();
  const scope = (source: string): { listened: boolean } => {
    if (!config) return { listened: true };
    const s = config.sources.find((x) => x.name === source);
    return { listened: !!s && s.listened };
  };
  return {
    hasTrigger: (id) => triggers.has(id),
    saveTrigger: (t) => { triggers.set(t.id, t); },
    saveDisposition: (d) => { dispositions.set(d.triggerId, d); },
    dispositions: () => [...dispositions.values()],
    sourceScope: scope,
  };
}

/**
 * 三判据 receive(确定性,零 LLM):
 * 1. 同 trigger.id 二次 receive → duplicate,不重复入队(duplicate 复用 TaskSupervisor 幂等回执);
 * 2. scope 未监听 → filtered,只落 disposition 不入队;
 * 3. 正常 → stored,交 gate 判定。
 */
export function receive(trigger: Trigger, store: IntakeStore, now: () => number = Date.now): ReceiveResult {
  if (store.hasTrigger(trigger.id)) return "duplicate";
  store.saveTrigger(trigger);
  const at = trigger.at ?? now();
  const filter = store.sourceScope(trigger.source);
  if (!filter.listened) {
    store.saveDisposition({ triggerId: trigger.id, outcome: "filtered", at });
    return "filtered";
  }
  return "stored";
}

/** 入口辅助:构造面板/飞书 Trigger。 */
export function buildTrigger(input: {
  source: "panel" | "im";
  sessionId: string;
  instruction: string;
  threadKey?: string;
  idempotencyKey?: string;
  triggerId?: string;
  now?: () => number;
}): Trigger {
  const now = input.now ?? Date.now;
  // 2026-11-04 修复:删除 200 字「预览截断」——旧实现把截断文写进 Trigger.instruction 本体,
  // dispatch 的 tm.submit 与 agent 任务书拿到的就是截断文(实锤:五任务书全被截到 214 字,
  // 硬纪律段全丢)。「预览」语义只允许存在于渲染层,不允许进数据本体;且本路由是确定性闸门,
  // 没有任何研判提示词消费长文本——截断的前提本身不成立。需要预览的消费方自行局部截断。
  const instruction = input.instruction;
  return {
    id: input.triggerId ?? `${input.source}-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: input.source,
    sessionId: input.sessionId,
    instruction,
    threadKey: input.threadKey ?? `session:${input.sessionId}`,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    at: now(),
  };
}
