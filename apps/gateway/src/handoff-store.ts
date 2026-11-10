/**
 * 子代理进程交接台账:把 subagent-handoff 的纯逻辑落到 append-only jsonl。
 *
 * 为什么 append-only:交接是一次审计事实(谁在什么时候把哪个进程交给谁、为什么),
 * 事后改写 owner 会让「谁把进程弄丢了」变成不可查。每行只增不改,当前状态由重放得到。
 *
 * 数据面:`<root>/.genie/rsi/handoff.jsonl`,每行 `{v:1,type,at,...}`
 * - agent     {id,maxHandoffs}                                  一次代理注册
 * - process   {id,owner,purpose?}                               一个进程登记(owner 自动登记)
 * - handoff   {processId,fromAgent,toAgent,purpose,maxPerAgent}  一次交接(成功才写)
 * - delegate  {group,concurrency,joinOrder,buckets}             一次按 group 分桶
 * - inventory {agentId,handedOff,orphaned,unreadCompletions}    一次退出盘点
 *
 * 投影语义:按行序重放;坏行(JSON 坏 / v 不是 1 / type 未知 / 载荷不合法)只计入 parseErrors
 * 并跳过——一行坏不整文件失效、不 throw。重放中语义非法的交接(非 owner、超限)计入 replayRejects,
 * 同样不 throw(它只说明台账里有过被拒的尝试,真相以行序为准)。
 *
 * 写作纪律:单行追加 + 写后重读行数校验,让「写成功了吗」成为可复核断言。
 *
 * 依赖纪律:node:fs / node:path + runtime 纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块两跳解析(同 cohort-metrics-store 套路):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除 root 非法外不 throw:IO/投影失败一律折叠成稳定码返回。
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BucketJoin,
  DelegateTask,
  GroupPlan,
  HandoffCode,
  HandoffInventory,
  JoinTaskResult,
  ManagedProcess,
  Registry,
} from "@lampgenie/runtime/agent/subagent-handoff";

/** store 稳定码:说「存/取」的失败;语义判断码沿用 runtime 的 HANDOFF_*。 */
export const HANDOFF_STORE_CODES = [
  "HANDOFF_DUPLICATE",
  "HANDOFF_INVALID_INPUT",
  "HANDOFF_MISSING_PROCESS",
  "HANDOFF_LEDGER_WRITE_VERIFY_FAILED",
  "HANDOFF_STORE_ERROR",
] as const;

export type HandoffStoreCode = (typeof HANDOFF_STORE_CODES)[number];

/** 落盘行类型(只增不改)。 */
export const HANDOFF_LINE_TYPES = ["agent", "process", "handoff", "delegate", "inventory"] as const;

export type HandoffLineType = (typeof HANDOFF_LINE_TYPES)[number];

/** 一行台账(联合体对调用方只读收窄,写用下面的 append 辅助)。 */
export interface HandoffLine {
  v: 1;
  type: HandoffLineType;
  at: number;
  id?: string;
  owner?: string;
  maxHandoffs?: number;
  purpose?: string;
  processId?: string;
  fromAgent?: string;
  toAgent?: string;
  maxPerAgent?: number;
  group?: string;
  concurrency?: number;
  joinOrder?: string[];
  buckets?: Record<string, string[]>;
  agentId?: string;
  handedOff?: string[];
  orphaned?: string[];
  unreadCompletions?: number;
}

/** 重放后的完整视图。 */
export interface HandoffLedger {
  version: 1;
  registry: Registry;
  totalLines: number;
  parseErrors: number;
  replayRejects: number;
  counts: Record<HandoffLineType, number>;
  handoffs: Array<{
    processId: string;
    fromAgent: string;
    toAgent: string;
    purpose: string;
    maxPerAgent: number;
    at: number;
  }>;
  delegations: Array<{
    group: string;
    concurrency: number;
    joinOrder: string[];
    buckets: Record<string, string[]>;
    at: number;
  }>;
  inventories: Array<{
    agentId: string;
    handedOff: string[];
    orphaned: string[];
    unreadCompletions: number;
    at: number;
  }>;
}

/** 写操作的统一返回:ok=false 时 code 说原因。 */
export interface StoreResult {
  ok: boolean;
  code: string;
  at: number;
}

interface HandoffRuntime {
  HANDOFF_VERSION: number;
  DEFAULT_MAX_HANDOFFS: number;
  DEFAULT_GROUP: string;
  emptyRegistry(): Registry;
  registerAgent(
    registry: Registry,
    agentId: string,
    opts?: { maxHandoffs?: number },
  ): { registry: Registry; ok: boolean; code?: HandoffCode };
  registerProcess(
    registry: Registry,
    input: { id?: string; owner?: string; purpose?: string },
  ): { registry: Registry; ok: boolean; code?: HandoffCode; process?: ManagedProcess };
  handoff(
    registry: Registry,
    input: { processId?: string; fromAgent?: string; toAgent?: string; purpose?: string },
    opts?: { maxPerAgent?: number },
  ): { registry: Registry; code: HandoffCode; ok: boolean; process?: ManagedProcess };
  inventory(
    registry: Registry,
    agentId: string,
    opts?: { unreadCompletions?: number; count?: number },
  ): HandoffInventory;
  delegateGroup(input: {
    tasks?: readonly DelegateTask[];
    group?: string;
    concurrency?: number;
  }): GroupPlan;
  joinBucket(results: readonly JoinTaskResult[], bucket: string): BucketJoin;
}

let handoffRuntime: HandoffRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadHandoffRuntime(): Promise<HandoffRuntime> {
  if (handoffRuntime) return handoffRuntime;
  const spec = "@lampgenie/runtime/agent/subagent-handoff";
  try {
    handoffRuntime = (await import(spec)) as HandoffRuntime;
  } catch {
    const srcUrl = new URL(
      "../../../packages/harness-runtime/src/agent/subagent-handoff.ts",
      import.meta.url,
    ).href;
    handoffRuntime = (await import(srcUrl)) as HandoffRuntime;
  }
  return handoffRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadHandoffRuntime();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 台账文件绝对路径:`<root>/.genie/rsi/handoff.jsonl`。 */
export function handoffPath(root: string): string {
  const base = assertRoot(root);
  return join(base, ".genie", "rsi", "handoff.jsonl");
}

function assertRoot(root: unknown): string {
  if (typeof root !== "string" || root.trim() === "") throw new Error("root 必须是非空字符串");
  return root;
}

/** 统计文件非空行数;文件不存在/读失败按 0。 */
function countLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n += 1;
  return n;
}

/** 追加一行并做写后行数校验;失败折叠成 HANDOFF_LEDGER_WRITE_VERIFY_FAILED,不 throw。 */
function appendLine(root: string, line: HandoffLine): { ok: boolean; code: string } {
  const path = handoffPath(root);
  const before = countLines(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    return { ok: false, code: "HANDOFF_STORE_ERROR" };
  }
  const after = countLines(path);
  if (after !== before + 1) return { ok: false, code: "HANDOFF_LEDGER_WRITE_VERIFY_FAILED" };
  return { ok: true, code: "HANDOFF_HANDED_OFF" };
}

function emptyCounts(): Record<HandoffLineType, number> {
  return { agent: 0, process: 0, handoff: 0, delegate: 0, inventory: 0 };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => textOf(item)).filter((item): item is string => item !== undefined);
}

function isLineType(value: unknown): value is HandoffLineType {
  return typeof value === "string" && (HANDOFF_LINE_TYPES as readonly string[]).includes(value);
}

/** 读全部行并重放;坏行计入 parseErrors,语义非法的交接计入 replayRejects。 */
export function loadHandoff(root: string): HandoffLedger {
  const path = handoffPath(root);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }
  let registry = rt.emptyRegistry();
  let totalLines = 0;
  let parseErrors = 0;
  let replayRejects = 0;
  const counts = emptyCounts();
  const handoffs: HandoffLedger["handoffs"] = [];
  const delegations: HandoffLedger["delegations"] = [];
  const inventories: HandoffLedger["inventories"] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "") continue;
    totalLines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !isLineType(parsed.type)) {
      parseErrors += 1;
      continue;
    }
    const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0;
    counts[parsed.type] += 1;
    switch (parsed.type) {
      case "agent": {
        const id = textOf(parsed.id);
        if (id === undefined) {
          parseErrors += 1;
          break;
        }
        const maxHandoffs = typeof parsed.maxHandoffs === "number" ? parsed.maxHandoffs : undefined;
        registry = rt.registerAgent(registry, id, { maxHandoffs }).registry;
        break;
      }
      case "process": {
        // 重放不从 process 行反推 agent:owner 没有 agent 行就是孤儿,
        // 这正是「代理被清出注册表、它的进程还在」要盘出来的状态。
        const id = textOf(parsed.id);
        const owner = textOf(parsed.owner);
        if (id === undefined || owner === undefined) {
          parseErrors += 1;
          break;
        }
        if (registry.processes[id] !== undefined) {
          replayRejects += 1;
          break;
        }
        registry = {
          processes: {
            ...registry.processes,
            [id]: {
              id,
              owner,
              ...(textOf(parsed.purpose) !== undefined ? { purpose: textOf(parsed.purpose) } : {}),
              handoffs: 0,
            },
          },
          agents: { ...registry.agents },
        };
        break;
      }
      case "handoff": {
        const processId = textOf(parsed.processId);
        const fromAgent = textOf(parsed.fromAgent);
        const toAgent = textOf(parsed.toAgent);
        const purpose = textOf(parsed.purpose);
        if (processId === undefined || fromAgent === undefined || toAgent === undefined || purpose === undefined) {
          parseErrors += 1;
          break;
        }
        const maxPerAgent =
          typeof parsed.maxPerAgent === "number" && parsed.maxPerAgent >= 1
            ? Math.floor(parsed.maxPerAgent)
            : rt.DEFAULT_MAX_HANDOFFS;
        const result = rt.handoff(
          registry,
          { processId, fromAgent, toAgent, purpose },
          { maxPerAgent },
        );
        if (!result.ok) {
          replayRejects += 1;
          break;
        }
        registry = result.registry;
        handoffs.push({ processId, fromAgent, toAgent, purpose, maxPerAgent, at });
        break;
      }
      case "delegate": {
        const group = textOf(parsed.group) ?? rt.DEFAULT_GROUP;
        const concurrency =
          typeof parsed.concurrency === "number" && parsed.concurrency >= 1
            ? Math.floor(parsed.concurrency)
            : 1;
        const joinOrder = stringList(parsed.joinOrder);
        const buckets: Record<string, string[]> = {};
        if (isRecord(parsed.buckets)) {
          for (const [bucket, ids] of Object.entries(parsed.buckets)) buckets[bucket] = stringList(ids);
        }
        delegations.push({ group, concurrency, joinOrder, buckets, at });
        break;
      }
      case "inventory": {
        const agentId = textOf(parsed.agentId);
        if (agentId === undefined) {
          parseErrors += 1;
          break;
        }
        inventories.push({
          agentId,
          handedOff: stringList(parsed.handedOff),
          orphaned: stringList(parsed.orphaned),
          unreadCompletions:
            typeof parsed.unreadCompletions === "number" && parsed.unreadCompletions > 0
              ? Math.floor(parsed.unreadCompletions)
              : 0,
          at,
        });
        break;
      }
    }
  }

  return {
    version: 1,
    registry,
    totalLines,
    parseErrors,
    replayRejects,
    counts,
    handoffs,
    delegations,
    inventories,
  };
}

/** 登记代理(已存在 → HANDOFF_DUPLICATE,不覆盖历史)。 */
export function registerAgent(
  root: string,
  input: { id?: string; maxHandoffs?: number },
): StoreResult & { agent?: { id: string; maxHandoffs: number } } {
  const at = Date.now();
  const id = textOf(input?.id);
  if (id === undefined) return { ok: false, code: "HANDOFF_INVALID_INPUT", at };
  const ledger = loadHandoff(root);
  if (ledger.registry.agents[id] !== undefined) return { ok: false, code: "HANDOFF_DUPLICATE", at };
  const applied = rt.registerAgent(ledger.registry, id, { maxHandoffs: input?.maxHandoffs });
  if (!applied.ok) return { ok: false, code: applied.code ?? "HANDOFF_INVALID_INPUT", at };
  const agent = applied.registry.agents[id];
  if (agent === undefined) return { ok: false, code: "HANDOFF_STORE_ERROR", at };
  const written = appendLine(root, { v: 1, type: "agent", at, id, maxHandoffs: agent.maxHandoffs });
  if (!written.ok) return { ok: false, code: written.code, at };
  return { ok: true, code: "HANDOFF_HANDED_OFF", at, agent: { id, maxHandoffs: agent.maxHandoffs } };
}

/** 登记进程(已存在 → HANDOFF_DUPLICATE;owner 不存在会被自动登记成代理)。 */
export function registerProcess(
  root: string,
  input: { id?: string; owner?: string; purpose?: string },
): StoreResult & { process?: ManagedProcess } {
  const at = Date.now();
  const id = textOf(input?.id);
  const owner = textOf(input?.owner);
  if (id === undefined || owner === undefined) return { ok: false, code: "HANDOFF_INVALID_INPUT", at };
  const ledger = loadHandoff(root);
  if (ledger.registry.processes[id] !== undefined) return { ok: false, code: "HANDOFF_DUPLICATE", at };
  const applied = rt.registerProcess(ledger.registry, {
    id,
    owner,
    purpose: textOf(input?.purpose),
  });
  if (!applied.ok || applied.process === undefined) {
    return { ok: false, code: applied.code ?? "HANDOFF_INVALID_INPUT", at };
  }
  // owner 是新的:先落一行 agent,重放时 owner 才算「存在」(否则进程一写就是孤儿)。
  if (ledger.registry.agents[owner] === undefined) {
    const agentLine = appendLine(root, {
      v: 1,
      type: "agent",
      at,
      id: owner,
      maxHandoffs: rt.DEFAULT_MAX_HANDOFFS,
    });
    if (!agentLine.ok) return { ok: false, code: agentLine.code, at };
  }
  const written = appendLine(root, {
    v: 1,
    type: "process",
    at,
    id,
    owner,
    ...(textOf(input?.purpose) !== undefined ? { purpose: textOf(input?.purpose) } : {}),
  });
  if (!written.ok) return { ok: false, code: written.code, at };
  return { ok: true, code: "HANDOFF_HANDED_OFF", at, process: applied.process };
}

/** 交接:语义判断全在 runtime,store 只负责重放 + 落一行(成功才写)。 */
export function handoff(
  root: string,
  input: { processId?: string; fromAgent?: string; toAgent?: string; purpose?: string },
  opts: { maxPerAgent?: number } = {},
): StoreResult & { process?: ManagedProcess } {
  const at = Date.now();
  const ledger = loadHandoff(root);
  const result = rt.handoff(ledger.registry, input, { maxPerAgent: opts.maxPerAgent });
  if (!result.ok) {
    const missing = result.code === "HANDOFF_INVALID" && textOf(input?.processId) !== undefined
      && ledger.registry.processes[textOf(input?.processId)!] === undefined;
    return { ok: false, code: missing ? "HANDOFF_MISSING_PROCESS" : result.code, at };
  }
  const written = appendLine(root, {
    v: 1,
    type: "handoff",
    at,
    processId: textOf(input.processId)!,
    fromAgent: textOf(input.fromAgent)!,
    toAgent: textOf(input.toAgent)!,
    purpose: textOf(input.purpose)!,
    maxPerAgent: rt.DEFAULT_MAX_HANDOFFS,
  });
  if (!written.ok) return { ok: false, code: written.code, at };
  return { ok: true, code: "HANDOFF_HANDED_OFF", at, process: result.process };
}

/** 退出盘点:算一遍三态并落一行 inventory(写失败不改返回值,只标 stored=false)。 */
export function inventory(
  root: string,
  agentId: string,
  opts: { unreadCompletions?: number } = {},
): StoreResult & { inventory: HandoffInventory; stored: boolean } {
  const at = Date.now();
  const ledger = loadHandoff(root);
  const report = rt.inventory(ledger.registry, agentId, { unreadCompletions: opts.unreadCompletions });
  if (textOf(agentId) === undefined) {
    return { ok: false, code: "HANDOFF_INVALID_INPUT", at, inventory: report, stored: false };
  }
  const written = appendLine(root, {
    v: 1,
    type: "inventory",
    at,
    agentId: report.agentId,
    handedOff: report.handedOff,
    orphaned: report.orphaned,
    unreadCompletions: report.unreadCompletions,
  });
  return {
    ok: true,
    code: "HANDOFF_INVENTORY",
    at,
    inventory: report,
    stored: written.ok,
  };
}

/** 委派分桶:每桶一条聚合消息(不是每任务一条),并发预算不因分桶扩张。 */
export function delegate(
  root: string,
  input: {
    tasks?: readonly DelegateTask[];
    group?: string;
    concurrency?: number;
    results?: readonly JoinTaskResult[];
  },
): StoreResult & {
  plan: GroupPlan;
  joins: BucketJoin[];
  joined: { messages: string[]; count: number };
} {
  const at = Date.now();
  const plan = rt.delegateGroup({
    tasks: input?.tasks,
    group: textOf(input?.group),
    concurrency: input?.concurrency,
  });
  const planned: JoinTaskResult[] = [];
  for (const bucket of plan.joinOrder) {
    for (const task of plan.buckets[bucket] ?? []) planned.push({ taskId: task.id, group: bucket });
  }
  // 真实结果按 taskId 覆盖计划占位;没回报的任务保持「待回报」,不能默认算成功。
  const provided = Array.isArray(input?.results) ? input.results : [];
  const byId = new Map<string, JoinTaskResult>();
  for (const row of provided) byId.set(row.taskId, row);
  const results: JoinTaskResult[] = planned.map((item) => byId.get(item.taskId) ?? item);
  for (const row of provided) {
    if (!planned.some((item) => item.taskId === row.taskId)) results.push(row);
  }
  const joins = plan.joinOrder.map((bucket) => rt.joinBucket(results, bucket));
  const written = appendLine(root, {
    v: 1,
    type: "delegate",
    at,
    group: textOf(input?.group) ?? rt.DEFAULT_GROUP,
    concurrency: plan.concurrency,
    joinOrder: plan.joinOrder,
    buckets: Object.fromEntries(
      plan.joinOrder.map((bucket) => [bucket, (plan.buckets[bucket] ?? []).map((task) => task.id)]),
    ),
  });
  if (!written.ok) {
    return {
      ok: false,
      code: written.code,
      at,
      plan,
      joins,
      joined: { messages: joins.map((join) => join.message), count: joins.length },
    };
  }
  return {
    ok: true,
    code: "HANDOFF_JOINED",
    at,
    plan,
    joins,
    joined: { messages: joins.map((join) => join.message), count: joins.length },
  };
}

/** 汇总报表:台账计数 + 当前 owner 分布 + 孤儿 + 每代理最近一次盘点的 handedOff。 */
export function reportHandoff(root: string): {
  version: 1;
  totalLines: number;
  parseErrors: number;
  replayRejects: number;
  counts: Record<HandoffLineType, number>;
  agents: number;
  processes: number;
  handoffs: number;
  owners: Record<string, number>;
  orphaned: string[];
  handedOff: Record<string, string[]>;
  unreadCompletions: Record<string, number>;
  codes: string[];
} {
  const ledger = loadHandoff(root);
  const owners: Record<string, number> = {};
  const orphaned: string[] = [];
  const processes: Record<string, ManagedProcess> = ledger.registry.processes;
  for (const process of Object.values(processes)) {
    owners[process.owner] = (owners[process.owner] ?? 0) + 1;
    if (ledger.registry.agents[process.owner] === undefined) orphaned.push(process.id);
  }
  const handedOff: Record<string, string[]> = {};
  const unreadCompletions: Record<string, number> = {};
  for (const row of ledger.inventories) {
    handedOff[row.agentId] = row.handedOff;
    unreadCompletions[row.agentId] = row.unreadCompletions;
  }
  const codes: string[] = [];
  if (ledger.parseErrors > 0) codes.push("HANDOFF_STORE_ERROR");
  if (orphaned.length > 0) codes.push("HANDOFF_INVENTORY");
  return {
    version: 1,
    totalLines: ledger.totalLines,
    parseErrors: ledger.parseErrors,
    replayRejects: ledger.replayRejects,
    counts: ledger.counts,
    agents: Object.keys(ledger.registry.agents).length,
    processes: Object.keys(ledger.registry.processes).length,
    handoffs: ledger.handoffs.length,
    owners,
    orphaned: orphaned.sort(),
    handedOff,
    unreadCompletions,
    codes,
  };
}
