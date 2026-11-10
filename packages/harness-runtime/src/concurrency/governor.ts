// ============================================================
// Workflow 并发协调器（进程级，按 provider key 分泳道，**每个模型请求**准入）
// ============================================================
// 一个 CLI 进程里所有 run 加主代理
// 共用一个 provider 配额，所以协调器是**进程级**的：每个 `${providerId}/${modelId}` 一条泳道，
// 泳道里一台纯 AIMD 状态机（`AimdRegulator`）+ 一条按 run 轮转的准入队列。
// 进程级 AIMD 并发治理的设计参考 ZCode 项目的 dynamic-workflow 思路（致谢，Apache-2.0）；
// 本目录为独立实现：类型、状态机方法面、协调器结构与命名均为本仓自有。
//
// 闸门粒度是**模型请求的每一次尝试**：runner 每次尝试前 `take`、尝试结束 `release`，
// 退避 sleep 期间不持槽。ticket 就是该次尝试的状态事件汇：runner 把该尝试的
// 生命周期事件同时投递给 ticket，协调器从 ticket 上读结果。本方案
// **不**再用 adapter 级 `addStatusSink`——同一事件不能既经 ticket 又经 adapter sink 各喂一次。
//
// 这里是协调器里**唯一**会碰时钟与定时器的地方：状态机只收 `now`；冷却到期要唤醒等待者，
// 所以需要一个 setTimeout（可注入，unref）。

import type {
  ModelLifecycleEvent,
  RequestAdmission,
  AdmissionTicket,
  ModelRoute,
} from "./admission";
import {
  AimdRegulator,
  type ConcurrencyShift,
  type AimdRegulatorSnapshot,
  type AimdThrottleCause,
} from "./aimd-controller";
import { deriveWorkflowConcurrencyCeiling } from "./ceiling";

/** provider key：最具体的配额键。 */
export function providerModelKey(model: ModelRoute): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * driver 看到的窄端口（不是整个协调器）。
 *
 * - `tryEnter`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `enter` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `enter`：排队（run 间轮转）直到 `inFlight < cap` 且不在 Retry-After 冷却；`signal` 被 abort 即
 *   出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。广播只到**此刻在该 key 上有在飞或排队请求**的
 *   run。
 */
export interface WorkflowConcurrencyGate {
  tryEnter(runId: string, key: string): AdmissionTicket | undefined;
  enter(runId: string, key: string, signal: AbortSignal): Promise<AdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyShift) => void): () => void;
}

interface WorkflowConcurrencyCoordinator extends WorkflowConcurrencyGate {
  /**
   * 主代理用的 admission：take 立即放行——不排队、不看冷却——但**计入 inFlight**
   * 且喂信号（它的请求 provider 同样看得见）。主代理的 turn 永不被 workflow 流量阻塞。
   */
  passthrough(): RequestAdmission;
  /** 控制器只读快照；没有这个 key 的桶时为 undefined。 */
  snapshot(key: string): AimdRegulatorSnapshot | undefined;
}

interface WorkflowConcurrencyCoordinatorOptions {
  /** 天花板：桶创建时的初值与上界；进程启动时算一次。 */
  ceiling: number;
  /** 时钟（可注入）。 */
  now?: () => number;
  /** 定时器（可注入）：冷却到期唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 限流类 retry 原因 → 控制器的 throttled 信号。 */
const THROTTLE_CAUSES: ReadonlySet<string> = new Set<AimdThrottleCause>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** 不是 provider 失败的 retry 原因：既不减 cap 也不清 streak——只当尝试终结。 */
const NON_FAILURE_RETRIES: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface PendingRequest {
  runId: string;
  resolve: (ticket: AdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface ProviderLane {
  readonly key: string;
  readonly controller: AimdRegulator;
  /** 每个 run 在飞（已准入未结算）的请求数（广播的依据：有在飞或排队请求的 run 才收 cap 变化）。 */
  readonly inFlightByRun: Map<string, number>;
  /** 等待者按 run 分队列（run 间轮转，大 fan-out 不能饿死后来的小 run）。 */
  readonly queues: Map<string, PendingRequest[]>;
  /** 轮转游标：上一次放行的 run，下一次从它之后开始找。 */
  lastGrantedRun?: string;
  cancelCooldownTimer?: () => void;
}

/** passthrough（主代理）的 run 身份：不排队、不订阅，只在广播过滤里作为「不是任何 run」出现。 */
const PASSTHROUGH_RUN_ID = "\0passthrough";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等冷却的定时器把进程钉住：run 结束、进程要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyCoordinator(
  options: WorkflowConcurrencyCoordinatorOptions,
): WorkflowConcurrencyCoordinator {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const lanes = new Map<string, ProviderLane>();
  /** run 级订阅（不按 key）：广播时按泳道的 engaged 集合过滤。 */
  const listeners = new Map<string, Set<(change: ConcurrencyShift) => void>>();

  const laneFor = (key: string): ProviderLane => {
    let lane = lanes.get(key);
    if (lane === undefined) {
      // 惰性建泳道，初值 = 天花板；此后 run 来来去去都不重置它（只有空闲 5 分钟会）。
      lane = {
        key,
        controller: new AimdRegulator(key, options.ceiling),
        inFlightByRun: new Map(),
        queues: new Map(),
      };
      lanes.set(key, lane);
    }
    return lane;
  };

  const pendingCount = (lane: ProviderLane): number => {
    let total = 0;
    for (const queue of lane.queues.values()) total += queue.length;
    return total;
  };

  /** 广播：只给此刻在该 key 上有在飞或排队请求的 run。 */
  const broadcast = (lane: ProviderLane, changes: ConcurrencyShift[]): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (lane.inFlightByRun.get(runId) ?? 0) > 0 || (lane.queues.get(runId)?.length ?? 0) > 0;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  const adjustInFlight = (lane: ProviderLane, runId: string, delta: number): void => {
    const next = (lane.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) lane.inFlightByRun.delete(runId);
    else lane.inFlightByRun.set(runId, next);
  };

  /**
   * 一次已准入尝试的 ticket：事件映射保持一致。任一终结映射后结算（幂等）；`release()`
   * 未见终结事件即按 `ended` 处理。结算后的 emit / release 一律惰性——runner 在极少数路径上
   * （尝试已结束后的兜底事件）可能仍会投递。
   */
  const issueTicket = (
    lane: ProviderLane,
    runId: string,
    epoch: number,
  ): AdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyShift[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // 先广播再减在飞：产生这条变化的请求正是本 run 的，它此刻仍算 engaged——否则一个 run 唯一的
      // 在飞请求撞出的减半，会因为「已经不在飞」而漏发给它自己。
      broadcast(lane, changes);
      adjustInFlight(lane, runId, -1);
      // 结算释放了一个名额（或改了 cap），排队者可能可以放行。
      pump(lane);
    };
    return {
      emit(event: ModelLifecycleEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // 准入时已计入 inFlight，这里没有新信息。
            return;
          case "model_request_completed":
            settle((at) => lane.controller.noteSuccess(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRIES.has(reason)) {
              settle((at) => lane.controller.noteClosed(at));
              return;
            }
            if (THROTTLE_CAUSES.has(reason)) {
              settle((at) =>
                lane.controller.noteThrottled(
                  at,
                  epoch,
                  reason as AimdThrottleCause,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => lane.controller.noteTransientFailure(at));
            return;
          }
          case "model_request_failed":
            // retryable:true 的 failed 紧随一条 retry_scheduled——那条才是信号。
            if (event.retryable) return;
            // 不可重试的限流：
            // 主对话 / 工具侧撞上 3008 这类被分类器判终止的 429，仍是一次字面意义上的并发信号——
            // 只当「链结束」会让 cap 从未因它降过。配额码也走这一支：多减一次半，run 随即停下，无害。
            if (event.reason === "rate_limited") {
              settle((at) =>
                lane.controller.noteThrottled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => lane.controller.noteClosed(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => lane.controller.noteClosed(at));
      },
    };
  };

  /** 放行一个请求：`pulse` 在前（准入也是一次「信号」），再 `noteAdmitted` 拿 epoch。 */
  const grantSlot = (lane: ProviderLane, runId: string): AdmissionTicket => {
    broadcast(lane, lane.controller.pulse(now()));
    const epoch = lane.controller.noteAdmitted(now());
    adjustInFlight(lane, runId, 1);
    lane.lastGrantedRun = runId;
    return issueTicket(lane, runId, epoch);
  };

  /** 按轮转挑下一个有等待者的 run。 */
  const pickNextRun = (lane: ProviderLane): string | undefined => {
    const runs = [...lane.queues.keys()].filter(
      (runId) => (lane.queues.get(runId)?.length ?? 0) > 0,
    );
    if (runs.length === 0) return undefined;
    const last = lane.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownTimer = (lane: ProviderLane): void => {
    lane.cancelCooldownTimer?.();
    lane.cancelCooldownTimer = undefined;
    if (pendingCount(lane) === 0) return;
    const until = lane.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    lane.cancelCooldownTimer = schedule(() => {
      lane.cancelCooldownTimer = undefined;
      pump(lane);
    }, delay);
  };

  /** 放行尽可能多的等待者（闸门：inFlight < cap 且不在冷却），喂 noteQueueDepth，必要时定冷却闹钟。 */
  const pump = (lane: ProviderLane): void => {
    broadcast(lane, lane.controller.pulse(now()));
    for (;;) {
      broadcast(lane, lane.controller.noteQueueDepth(now(), pendingCount(lane)));
      if (!lane.controller.hasSlot(now())) break;
      const runId = pickNextRun(lane);
      if (runId === undefined) break;
      const queue = lane.queues.get(runId)!;
      const pending = queue.shift()!;
      if (queue.length === 0) lane.queues.delete(runId);
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.resolve(grantSlot(lane, runId));
    }
    broadcast(lane, lane.controller.noteQueueDepth(now(), pendingCount(lane)));
    armCooldownTimer(lane);
  };

  const tryEnter: WorkflowConcurrencyGate["tryEnter"] = (runId, key) => {
    const lane = laneFor(key);
    broadcast(lane, lane.controller.pulse(now()));
    if (pendingCount(lane) > 0 || !lane.controller.hasSlot(now())) return undefined;
    return grantSlot(lane, runId);
  };

  const enter: WorkflowConcurrencyGate["enter"] = (runId, key, signal) => {
    const lane = laneFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    return new Promise<AdmissionTicket>((resolve, reject) => {
      const pending: PendingRequest = { runId, resolve, reject, signal, onAbort: () => {} };
      pending.onAbort = () => {
        const queue = lane.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(pending);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) lane.queues.delete(runId);
        }
        reject(abortedError(signal));
        broadcast(lane, lane.controller.noteQueueDepth(now(), pendingCount(lane)));
        armCooldownTimer(lane);
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      const queue = lane.queues.get(runId) ?? [];
      queue.push(pending);
      lane.queues.set(runId, queue);
      pump(lane);
    });
  };

  const subscribe: WorkflowConcurrencyGate["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  // 不排队、不看冷却；pulse 在 grantSlot 里。快路径总命中，所以 runner 永远不会为主代理
  // 的请求发 queued / admitted。
  const passthroughAdmission: RequestAdmission = {
    tryTake: ({ model }) => grantSlot(laneFor(providerModelKey(model)), PASSTHROUGH_RUN_ID),
    take: ({ model }) =>
      Promise.resolve(grantSlot(laneFor(providerModelKey(model)), PASSTHROUGH_RUN_ID)),
  };

  return {
    tryEnter,
    enter,
    subscribe,
    passthrough: () => passthroughAdmission,
    snapshot(key) {
      return lanes.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processCoordinator: WorkflowConcurrencyCoordinator | undefined;

/**
 * 进程级单例：天花板在首次取用时算一次；此后每个 app（会话）的主 runtime 挂它的
 * passthrough，run service 拿同一个端口给 driver。
 */
export function getWorkflowConcurrencyCoordinator(): WorkflowConcurrencyCoordinator {
  processCoordinator ??= createWorkflowConcurrencyCoordinator({
    ceiling: deriveWorkflowConcurrencyCeiling(),
  });
  return processCoordinator;
}
