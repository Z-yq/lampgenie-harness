/**
 * 子代理进程交接与委派分桶:纯逻辑、零 IO。
 *
 * 为什么:子代理起的 watcher / CI 进程原先有四个结构性病灶——
 * ① 子代理一结束,它起的进程被一起杀掉(长跑进程没有「换主人」的合法动作);
 * ② 两个子代理并发时互相抢对方起的进程(没有归属校验,谁都能翻别人的 owner);
 * ③ 一批子代理只要有一个慢任务,整批 join 被拖住(没有分桶 join);
 * ④ 每个任务完成都推一条消息,把 orchestrator 的上下文冲碎(没有按桶聚合)。
 * 本模块给出四件事:
 * - handoff:锁内把进程 owner 从 fromAgent 翻到 toAgent,每次交接必须给 purpose、
 *   默认每代理最多 3 次;非 owner 交接直接拒(抢进程的病根);
 * - inventory:代理退出时盘点 handedOff(交出去但历史里还记着我)/ orphaned(owner 已不存在)/
 *   unreadCompletions(队列里我还没读的完成数,由调用方计数传入);
 * - delegateGroup / joinBucket:按 group 分桶,桶间并行、桶内串行 join;
 *   分桶只改 join 边界,**不改并发计费**——总并发仍是 concurrency,不因为多分了一个桶就多拿 slot;
 * - stripGroupField:实验开关 default-off 时把 group 字段从工具 schema 里整个删掉,
 *   而不是留着字段让模型继续填(字段存在即被使用)。
 *
 * 纪律:不抛异常(非法输入折叠成 HANDOFF_INVALID)、不做 IO、不改入参(返回新 registry)、
 * 不依赖其它 runtime 模块。稳定码由调用方分流,文案不是契约。
 */

/** 数据契约版本(落盘行与本模块共用)。 */
export const HANDOFF_VERSION = 1;

/** 稳定的交接/分桶码:调用方按码分流,不解析文案。 */
export const HANDOFF_CODES = [
  "HANDOFF_INVALID",
  "HANDOFF_HANDED_OFF",
  "HANDOFF_PURPOSE_REQUIRED",
  "HANDOFF_NOT_OWNER",
  "HANDOFF_LIMIT",
  "HANDOFF_INVENTORY",
  "HANDOFF_GROUP_ASSIGNED",
  "HANDOFF_GROUP_STRIPPED",
  "HANDOFF_JOINED",
] as const;

export type HandoffCode = (typeof HANDOFF_CODES)[number];

/** 缺省每代理交接上限(超过说明进程在代理之间来回踢皮球,该收口了)。 */
export const DEFAULT_MAX_HANDOFFS = 3;

/** 委派任务缺 group 时落进的桶名(仍然一条聚合消息,不会每任务一条)。 */
export const DEFAULT_GROUP = "default";

/** 一个被接管的子进程。owner 是当前唯一有权操作它的代理。 */
export interface ManagedProcess {
  id: string;
  owner: string;
  /** 本次 owner 接手时的用途说明(交接必填,便于事后追「谁为什么接管」)。 */
  purpose?: string;
  /** 已发生的交接次数(成功才 +1,拒收不计)。 */
  handoffs: number;
  /** 历史上当过 owner 的代理(去重,按发生顺序)。 */
  handedOffFrom?: string[];
  /** owner 已不再是注册代理时为 true(重放时由盘点标记,纯函数不写回)。 */
  orphaned?: boolean;
}

/** 注册代理:每代理可带自己的交接上限。 */
export interface RegistryAgent {
  maxHandoffs: number;
}

/** 进程台账(纯数据,落盘层按行重放成它)。 */
export interface Registry {
  processes: Record<string, ManagedProcess>;
  agents: Record<string, RegistryAgent>;
}

/** 委派任务:group 决定进哪个桶,agentId 决定谁执行。 */
export interface DelegateTask {
  id: string;
  group?: string;
  agentId: string;
}

/** 交接结果:成功返回新 registry(纯函数,入参不变)。 */
export interface HandoffResult {
  registry: Registry;
  code: HandoffCode;
  ok: boolean;
  process?: ManagedProcess;
}

/** 退出盘点:三个数就是「子代理结束后还有什么没交代」。 */
export interface HandoffInventory {
  agentId: string;
  /** 我交出去、但历史记录里仍是我交接得来的进程。 */
  handedOff: string[];
  /** owner 已不在注册表里的进程(全局视图:它们没有代理可归)。 */
  orphaned: string[];
  /** 队列里该代理尚未读取的完成数(由调用方计数,纯函数不猜)。 */
  unreadCompletions: number;
  codes: HandoffCode[];
}

/** 分桶计划:桶内串行、桶间并行。 */
export interface GroupPlan {
  buckets: Record<string, DelegateTask[]>;
  joinOrder: string[];
  /** 总并发预算,与分桶数量无关(分桶不增加 slot)。 */
  concurrency: number;
  /** 本次实际能并发的桶数上限 = min(concurrency, 桶数)。 */
  slots: number;
  codes: HandoffCode[];
}

/** 单任务完成回报(joinBucket 的输入)。 */
export interface JoinTaskResult {
  taskId: string;
  group?: string;
  ok?: boolean;
  output?: string;
}

/** 一桶的聚合消息:每桶一条,不每任务一条。 */
export interface BucketJoin {
  bucket: string;
  joined: number;
  failed: number;
  ok: boolean;
  taskIds: string[];
  /** 单行聚合文案(orchestrator 每桶只吃一条消息)。 */
  message: string;
  code: HandoffCode;
}

/** 删字段结果:schema 为原对象或新对象,stripped 说明是否真删了。 */
export interface StripResult {
  schema: unknown;
  stripped: boolean;
  codes: HandoffCode[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function finiteInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

/** 空台账(调用方从它开始注册)。 */
export function emptyRegistry(): Registry {
  return { processes: {}, agents: {} };
}

/** 宽松归一:坏台账 → 空台账(不 throw)。 */
export function coerceRegistry(raw: unknown): Registry {
  if (!isRecord(raw)) return emptyRegistry();
  const processes: Record<string, ManagedProcess> = {};
  const agents: Record<string, RegistryAgent> = {};
  const rawProcesses = isRecord(raw.processes) ? raw.processes : {};
  for (const [id, value] of Object.entries(rawProcesses)) {
    if (!isRecord(value)) continue;
    const owner = textOf(value.owner);
    if (owner === undefined) continue;
    const handoffs = finiteInt(value.handoffs);
    const handedOffFrom = Array.isArray(value.handedOffFrom)
      ? value.handedOffFrom
          .map((item) => textOf(item))
          .filter((item): item is string => item !== undefined)
      : undefined;
    processes[id] = {
      id: textOf(value.id) ?? id,
      owner,
      ...(textOf(value.purpose) !== undefined ? { purpose: textOf(value.purpose) } : {}),
      handoffs: handoffs !== undefined && handoffs > 0 ? handoffs : 0,
      ...(handedOffFrom !== undefined && handedOffFrom.length > 0 ? { handedOffFrom } : {}),
      ...(value.orphaned === true ? { orphaned: true } : {}),
    };
  }
  const rawAgents = isRecord(raw.agents) ? raw.agents : {};
  for (const [id, value] of Object.entries(rawAgents)) {
    if (!isRecord(value)) continue;
    const maxHandoffs = finiteInt(value.maxHandoffs);
    agents[id] = {
      maxHandoffs:
        maxHandoffs !== undefined && maxHandoffs >= 1 ? maxHandoffs : DEFAULT_MAX_HANDOFFS,
    };
  }
  return { processes, agents };
}

/** 注册(或更新)一个代理;maxHandoffs 缺省 3,非法值回落到缺省。 */
export function registerAgent(
  registry: Registry,
  agentId: string,
  opts: { maxHandoffs?: number } = {},
): { registry: Registry; ok: boolean; code?: HandoffCode } {
  const id = textOf(agentId);
  if (id === undefined) return { registry, ok: false, code: "HANDOFF_INVALID" };
  const max = finiteInt(opts.maxHandoffs);
  const next: Registry = {
    processes: { ...registry.processes },
    agents: {
      ...registry.agents,
      [id]: { maxHandoffs: max !== undefined && max >= 1 ? max : DEFAULT_MAX_HANDOFFS },
    },
  };
  return { registry: next, ok: true };
}

/** 登记一个被管理进程(owner 不存在时自动登记,避免一登记就是孤儿)。 */
export function registerProcess(
  registry: Registry,
  input: { id?: string; owner?: string; purpose?: string },
): { registry: Registry; ok: boolean; code?: HandoffCode; process?: ManagedProcess } {
  const id = textOf(input?.id);
  const owner = textOf(input?.owner);
  if (id === undefined || owner === undefined) return { registry, ok: false, code: "HANDOFF_INVALID" };
  if (registry.processes[id] !== undefined) return { registry, ok: false, code: "HANDOFF_INVALID" };
  const withOwner =
    registry.agents[owner] !== undefined ? registry : registerAgent(registry, owner).registry;
  const process: ManagedProcess = {
    id,
    owner,
    ...(textOf(input?.purpose) !== undefined ? { purpose: textOf(input?.purpose) } : {}),
    handoffs: 0,
  };
  return {
    registry: {
      processes: { ...withOwner.processes, [id]: process },
      agents: { ...withOwner.agents },
    },
    ok: true,
    process,
  };
}

/**
 * 交接:把 processId 的 owner 从 fromAgent 翻到 toAgent。
 *
 * 校验顺序(每一步对应一个稳定码,互斥):
 * 1. 结构/存在性非法 → HANDOFF_INVALID(进程不存在、from/to 空白、自己交给自己);
 * 2. purpose 空白 → HANDOFF_PURPOSE_REQUIRED(交接必须写清为什么接管);
 * 3. fromAgent 不是当前 owner → HANDOFF_NOT_OWNER(抢别人进程的入口在这里焊死);
 * 4. 该 fromAgent 已交接 >= 上限 → HANDOFF_LIMIT(来回踢皮球收口)。
 *
 * 成功:handoffs+1、handedOffFrom 追加 fromAgent(去重)、purpose 更新为本次说明。
 * 「锁内」在本模块体现为纯函数:先复制 registry 再翻转,调用方拿到的新 registry 是唯一可见结果,
 * 不会出现半个 owner 的中间态;校验失败时原 registry 原样返回。
 */
export function handoff(
  registry: Registry,
  input: { processId?: string; fromAgent?: string; toAgent?: string; purpose?: string },
  opts: { maxPerAgent?: number } = {},
): HandoffResult {
  if (!isRecord(registry) || !isRecord(input)) {
    return { registry, code: "HANDOFF_INVALID", ok: false };
  }
  const processId = textOf(input.processId);
  const fromAgent = textOf(input.fromAgent);
  const toAgent = textOf(input.toAgent);
  if (processId === undefined || fromAgent === undefined || toAgent === undefined) {
    return { registry, code: "HANDOFF_INVALID", ok: false };
  }
  const current = registry.processes?.[processId];
  if (current === undefined) return { registry, code: "HANDOFF_INVALID", ok: false };
  if (fromAgent === toAgent) return { registry, code: "HANDOFF_INVALID", ok: false };
  const purpose = textOf(input.purpose);
  if (purpose === undefined) return { registry, code: "HANDOFF_PURPOSE_REQUIRED", ok: false };
  if (current.owner !== fromAgent) return { registry, code: "HANDOFF_NOT_OWNER", ok: false };
  const explicitMax = finiteInt(opts.maxPerAgent);
  const agentMax = finiteInt(registry.agents?.[fromAgent]?.maxHandoffs);
  const max =
    explicitMax !== undefined && explicitMax >= 1
      ? explicitMax
      : agentMax !== undefined && agentMax >= 1
        ? agentMax
        : DEFAULT_MAX_HANDOFFS;
  const handoffs = finiteInt(current.handoffs) ?? 0;
  if (handoffs >= max) return { registry, code: "HANDOFF_LIMIT", ok: false };

  const history = Array.isArray(current.handedOffFrom) ? current.handedOffFrom.slice() : [];
  if (!history.includes(fromAgent)) history.push(fromAgent);
  const nextProcess: ManagedProcess = {
    ...current,
    owner: toAgent,
    purpose,
    handoffs: handoffs + 1,
    handedOffFrom: history,
  };
  const nextAgents: Record<string, RegistryAgent> = { ...registry.agents };
  if (nextAgents[toAgent] === undefined) nextAgents[toAgent] = { maxHandoffs: DEFAULT_MAX_HANDOFFS };
  return {
    registry: { processes: { ...registry.processes, [processId]: nextProcess }, agents: nextAgents },
    code: "HANDOFF_HANDED_OFF",
    ok: true,
    process: nextProcess,
  };
}

/**
 * 退出盘点。
 * - handedOff:owner 已不是该代理,但 handedOffFrom 里记着它(它交出去了,别再回收);
 * - orphaned:owner 不在注册表里的进程(全局列表:孤儿没有代理可归,归属「退出盘点」而非某个代理);
 * - unreadCompletions:队列里该代理还没读的完成数,由调用方计数传入(纯函数不猜队列状态)。
 */
export function inventory(
  registry: Registry,
  agentId: string,
  opts: { unreadCompletions?: number; count?: number } = {},
): HandoffInventory {
  const id = textOf(agentId) ?? "";
  const processes = isRecord(registry) && isRecord(registry.processes) ? registry.processes : {};
  const agents = isRecord(registry) && isRecord(registry.agents) ? registry.agents : {};
  const handedOff: string[] = [];
  const orphaned: string[] = [];
  for (const [processId, process] of Object.entries(processes)) {
    if (!isRecord(process)) continue;
    const owner = textOf(process.owner) ?? "";
    const history = Array.isArray(process.handedOffFrom)
      ? process.handedOffFrom
          .map((item) => textOf(item))
          .filter((item): item is string => item !== undefined)
      : [];
    if (owner !== "" && agents[owner] === undefined) orphaned.push(processId);
    if (id !== "" && owner !== id && history.includes(id)) handedOff.push(processId);
  }
  const rawCount = finiteInt(opts?.unreadCompletions) ?? finiteInt(opts?.count) ?? 0;
  const unreadCompletions = rawCount > 0 ? rawCount : 0;
  const codes: HandoffCode[] =
    id === "" ? ["HANDOFF_INVALID", "HANDOFF_INVENTORY"] : ["HANDOFF_INVENTORY"];
  return {
    agentId: id,
    handedOff: handedOff.sort(),
    orphaned: orphaned.sort(),
    unreadCompletions,
    codes,
  };
}

/**
 * 委派分桶:按 group 分桶(任务自带 group 优先,否则用入参 group,再否则 default)。
 * joinOrder 按桶首次出现顺序(稳定、可复现)。
 * 并发:concurrency 是整体预算,分桶只决定 join 边界,不因桶多而扩张;slots = min(concurrency, 桶数)。
 */
export function delegateGroup(input: {
  tasks?: readonly DelegateTask[];
  group?: string;
  concurrency?: number;
}): GroupPlan {
  const fallback = textOf(input?.group) ?? DEFAULT_GROUP;
  const concurrencyRaw = finiteInt(input?.concurrency);
  const concurrency = concurrencyRaw !== undefined && concurrencyRaw >= 1 ? concurrencyRaw : 1;
  const buckets: Record<string, DelegateTask[]> = {};
  const joinOrder: string[] = [];
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  for (const raw of tasks) {
    if (!isRecord(raw)) continue;
    const taskId = textOf(raw.id);
    const agentId = textOf(raw.agentId);
    if (taskId === undefined || agentId === undefined) continue;
    const ownGroup = textOf(raw.group);
    const group = ownGroup ?? fallback;
    const task: DelegateTask = {
      id: taskId,
      agentId,
      ...(ownGroup !== undefined ? { group: ownGroup } : {}),
    };
    const bucket = buckets[group];
    if (bucket === undefined) {
      buckets[group] = [task];
      joinOrder.push(group);
    } else {
      bucket.push(task);
    }
  }
  const bucketCount = joinOrder.length;
  return {
    buckets,
    joinOrder,
    concurrency,
    slots: bucketCount === 0 ? 0 : Math.min(concurrency, bucketCount),
    codes: bucketCount === 0 ? ["HANDOFF_INVALID"] : ["HANDOFF_GROUP_ASSIGNED"],
  };
}

/**
 * 桶内聚合:按桶内完成顺序拼接成一条消息。
 * 每桶一条(不是每任务一条),这是 orchestrator 上下文不被冲碎的关键。
 */
export function joinBucket(results: readonly JoinTaskResult[], bucket: string): BucketJoin {
  const name = textOf(bucket) ?? DEFAULT_GROUP;
  const mine: JoinTaskResult[] = [];
  for (const raw of Array.isArray(results) ? results : []) {
    if (!isRecord(raw)) continue;
    const taskId = textOf(raw.taskId);
    if (taskId === undefined) continue;
    const group = textOf(raw.group);
    if (group !== undefined && group !== name) continue;
    mine.push({
      taskId,
      ...(group !== undefined ? { group } : {}),
      ...(raw.ok === true ? { ok: true } : raw.ok === false ? { ok: false } : {}),
      ...(textOf(raw.output) !== undefined ? { output: textOf(raw.output) } : {}),
    });
  }
  const taskIds = mine.map((item) => item.taskId);
  const failed = mine.filter((item) => item.ok === false).length;
  // ok 未给 = 还没回报(委派计划刚分桶时的占位),不能当成功算。
  const pending = mine.filter((item) => item.ok !== false && item.ok !== true).length;
  const ok = failed === 0 && pending === 0;
  const parts = mine.map((item) => {
    const head = item.ok === false ? `${item.taskId} 失败` : item.ok === true ? `${item.taskId} 完成` : `${item.taskId} 待回报`;
    return item.output === undefined ? head : `${head}(${item.output})`;
  });
  const settled = taskIds.length - failed - pending;
  const head = `${name}: ${settled}/${taskIds.length} 完成${failed > 0 ? ` · ${failed} 失败` : ""}${pending > 0 ? ` · ${pending} 待回报` : ""}`;
  const message = parts.length === 0 ? `${head}(无任务)` : `${head} · ${parts.join("; ")}`;
  return { bucket: name, joined: mine.length, failed, ok, taskIds, message, code: "HANDOFF_JOINED" };
}

/**
 * default-off 时把 group 字段从工具 schema 整个删掉。
 * 为什么不「留着但忽略」:字段存在模型就会填,填了就有人读,开关等于没关。
 * 返回新对象,原 schema 不变(纯函数);schema 不合法 → HANDOFF_INVALID,
 * 未开启 default-off 或 schema 本就没有 group → stripped=false(不是错误)。
 */
export function stripGroupField(schema: unknown, opts: { defaultOff?: boolean } = {}): StripResult {
  const defaultOff = opts?.defaultOff === true;
  if (!isRecord(schema)) return { schema, stripped: false, codes: ["HANDOFF_INVALID"] };
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!defaultOff) return { schema, stripped: false, codes: [] };
  if (properties === undefined || !("group" in properties)) {
    return { schema, stripped: false, codes: [] };
  }
  const nextProperties: UnknownRecord = { ...properties };
  delete nextProperties.group;
  const next: UnknownRecord = { ...schema, properties: nextProperties };
  if (Array.isArray(schema.required)) {
    next.required = schema.required.filter((item) => item !== "group");
  }
  return { schema: next, stripped: true, codes: ["HANDOFF_GROUP_STRIPPED"] };
}
