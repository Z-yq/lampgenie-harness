/**
 * 子代理生命周期注册表:纯逻辑、零 IO、不 throw、返回快照。
 * 为什么需要它:agent-wiring 里已有的 `bgAgents` 是「输出文件 + cancel 句柄」的运行态镜像,
 * 生命周期语义散落在各条 spawn 分支里(后台/前台/auto-bg/超时收割/watchdog),主 agent 无法
 * 统一查询「我派了哪些子代理、各自到哪一步、还能不能停」。本模块把「状态机」独立出来:
 * - 主 agent 可查询自身后代(list/descendants)——按 parentId 递归,天然隔离其它任务;
 * - 中断只作用于指定 agentId 一条记录(interrupt),父/兄弟记录不动:
 * 并行子代理是同一个主 agent 的兄弟,停一个不能连带停另一个,更不能反向影响父任务本身;
 * - 终态不可回退到 running(update 拒绝),防止迟到的 progress 事件把已收尾的子代理「复活」;
 * - 所有返回值是快照副本,调用方改返回值不会污染注册表;内部实现不抛异常,
 * 非法输入一律以 code 返回——注册表是观测/控制面,不能因脏数据打断主循环。
 * 持久化/恢复:registry 本身不落盘。gateway 侧在装配时从既有 __bgAgents 镜像 restore,
 * 进程内 re-wire(每个 task 一次 wireAgentLoop)复用同一个实例,终态记录保留。
 */

export const SUBAGENT_STATES = ["running", "done", "failed", "cancelled", "interrupted"] as const;

/** 子代理状态:running=运行中;done/failed/cancelled/interrupted 均为终态(终态不可回退)。 */
export type SubagentState = (typeof SUBAGENT_STATES)[number];

const TERMINAL_STATES: ReadonlySet<SubagentState> = new Set<SubagentState>(["done", "failed", "cancelled", "interrupted"]);

/** 一条子代理记录(返回给调用方的都是冻结快照)。 */
export interface SubagentRecord {
 /** 全局唯一:spawn_subagent 返回的 agentId。 */
  agentId: string;
 /** 父 agent 的 id(顶层子代理=派发它的主 task id;可空=没有父记录)。 */
  parentId?: string;
 /** 子代理自身的任务 id(gateway 侧为 subTaskId);用于轨迹/日志交叉检索。 */
  taskId: string;
  sessionId: string;
  title?: string;
  model?: string;
  state: SubagentState;
 /** 派发时刻(epoch ms)。 */
  spawnedAt: number;
 /** 最近一次事件时刻(update 默认刷新;用于算耗时与 stale)。 */
  lastEventAt?: number;
 /** 时间盒到点时刻(epoch ms;无时间盒则缺席)。 */
  deadlineAt?: number;
 /** 终态结果摘要(≤200 字;list 输出用)。 */
  resultSummary?: string;
}

export type SubagentRegistryCode = "DUPLICATE" | "NOT_FOUND" | "INVALID" | "ALREADY_TERMINAL";

export interface SubagentRegistryResult {
  ok: boolean;
  record?: SubagentRecord;
  code?: SubagentRegistryCode;
}

export interface SubagentListOptions {
 /** 过滤根:命中该节点的**全部后代**(递归、防环);不含根自身。 */
  parentId?: string;
  sessionId?: string;
 /** 缺省 true=含终态;false=只看运行中。 */
  includeDone?: boolean;
 /** 截断条数,缺省 50。 */
  limit?: number;
}

export interface SubagentStats {
  total: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  terminal: number;
}

export interface SubagentRestoreResult {
  restored: number;
  skipped: number;
}

const DEFAULT_LIMIT = 50;
const MAX_SUMMARY_CHARS = 200;

function isState(v: unknown): v is SubagentState {
  return typeof v === "string" && (SUBAGENT_STATES as readonly string[]).includes(v);
}

function isTerminalState(s: SubagentState): boolean {
  return TERMINAL_STATES.has(s);
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 快照:浅拷贝(字段都是原始值)+ 冻结。返回值可安全交给 UI/工具输出。 */
function snapshot(r: SubagentRecord): SubagentRecord {
  return Object.freeze({ ...r });
}

function compareRecords(a: SubagentRecord, b: SubagentRecord): number {
  const dt = finiteOr(a.spawnedAt, 0) - finiteOr(b.spawnedAt, 0);
  return dt !== 0 ? dt : a.agentId.localeCompare(b.agentId);
}

function normalizeRecord(input: SubagentRecord): SubagentRecord | undefined {
  if (!input || typeof input !== "object") return undefined;
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  if (!agentId) return undefined;
  if (!isState(input.state)) return undefined;
  const rec: SubagentRecord = {
    agentId,
    taskId: String(input.taskId ?? ""),
    sessionId: String(input.sessionId ?? ""),
    state: input.state,
    spawnedAt: finiteOr(input.spawnedAt, Date.now()),
  };
  if (typeof input.parentId === "string" && input.parentId) rec.parentId = input.parentId;
  if (typeof input.title === "string" && input.title) rec.title = input.title;
  if (typeof input.model === "string" && input.model) rec.model = input.model;
  if (typeof input.lastEventAt === "number" && Number.isFinite(input.lastEventAt)) rec.lastEventAt = input.lastEventAt;
  if (typeof input.deadlineAt === "number" && Number.isFinite(input.deadlineAt)) rec.deadlineAt = input.deadlineAt;
  if (typeof input.resultSummary === "string" && input.resultSummary) rec.resultSummary = input.resultSummary.slice(0, MAX_SUMMARY_CHARS);
  return rec;
}

export class SubagentRegistry {
  private records = new Map<string, SubagentRecord>();

 /**
 * 幂等注册:同 agentId 已存在 → 返回已有记录与 code=DUPLICATE(不覆盖,避免迟到登记把
 * 已更新到终态的记录打回 running)。parentId 可空=顶层。
 */
  register(record: SubagentRecord): SubagentRegistryResult {
    const normalized = normalizeRecord(record);
    if (!normalized) return { ok: false, code: "INVALID" };
    const existing = this.records.get(normalized.agentId);
    if (existing) return { ok: true, code: "DUPLICATE", record: snapshot(existing) };
    this.records.set(normalized.agentId, normalized);
    return { ok: true, record: snapshot(normalized) };
  }

 /** 单条读取(不存在→undefined,不 throw)。 */
  get(agentId: string): SubagentRecord | undefined {
    const rec = this.records.get(agentId);
    return rec ? snapshot(rec) : undefined;
  }

 /**
 * 局部更新:不存在→NOT_FOUND;state 非法→INVALID;终态→running 回退→INVALID。
 * 每次成功更新都刷新 lastEventAt(显式传入则用显式值)。
 */
  update(agentId: string, patch: Partial<Omit<SubagentRecord, "agentId">>): SubagentRegistryResult {
    const cur = this.records.get(agentId);
    if (!cur) return { ok: false, code: "NOT_FOUND" };
    if (patch.state !== undefined) {
      if (!isState(patch.state)) return { ok: false, code: "INVALID", record: snapshot(cur) };
 // 终态不可复活:迟到事件/重复收割不允许把 done/failed/cancelled/interrupted 打回 running。
      if (isTerminalState(cur.state) && patch.state === "running") return { ok: false, code: "INVALID", record: snapshot(cur) };
    }
    const next: SubagentRecord = { ...cur };
    if (patch.state !== undefined) next.state = patch.state;
    if (patch.parentId !== undefined && patch.parentId) next.parentId = patch.parentId;
    if (patch.taskId !== undefined && patch.taskId) next.taskId = String(patch.taskId);
    if (patch.sessionId !== undefined && patch.sessionId) next.sessionId = String(patch.sessionId);
    if (patch.title !== undefined) next.title = String(patch.title);
    if (patch.model !== undefined) next.model = String(patch.model);
    if (patch.deadlineAt !== undefined && Number.isFinite(patch.deadlineAt)) next.deadlineAt = patch.deadlineAt;
    if (patch.resultSummary !== undefined) next.resultSummary = String(patch.resultSummary).slice(0, MAX_SUMMARY_CHARS);
    next.lastEventAt = typeof patch.lastEventAt === "number" && Number.isFinite(patch.lastEventAt) ? patch.lastEventAt : Date.now();
    this.records.set(agentId, next);
    return { ok: true, record: snapshot(next) };
  }

 /**
 * 列表:按 spawnedAt 升序(同刻按 agentId 字典序,保证确定性)。
 * parentId 过滤时含**全部后代**(递归、visited 防环),不含根自身。
 */
  list(options: SubagentListOptions = {}): SubagentRecord[] {
    const includeDone = options.includeDone !== false;
    const limit = typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : DEFAULT_LIMIT;
    let pool: SubagentRecord[];
    if (options.parentId) {
      pool = [];
      for (const id of this.descendants(options.parentId)) {
        const rec = this.records.get(id);
        if (rec) pool.push(rec);
      }
    } else {
      pool = [...this.records.values()];
    }
    if (options.sessionId) pool = pool.filter((r) => r.sessionId === options.sessionId);
    if (!includeDone) pool = pool.filter((r) => !isTerminalState(r.state));
    return pool.sort(compareRecords).slice(0, limit).map(snapshot);
  }

 /** 递归后代 id 集(不含自身;防环;按 spawnedAt 升序)。 */
  descendants(agentId: string): string[] {
    const out = new Set<string>();
    const visited = new Set<string>([agentId]); // 把自己放进 visited:父子链成环时不会无限展开
    const queue: string[] = [agentId];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const rec of this.records.values()) {
        if (rec.parentId === cur && !visited.has(rec.agentId)) {
          visited.add(rec.agentId);
          out.add(rec.agentId);
          queue.push(rec.agentId);
        }
      }
    }
    const recs: SubagentRecord[] = [];
    for (const id of out) {
      const rec = this.records.get(id);
      if (rec) recs.push(rec);
    }
    return recs.sort(compareRecords).map((r) => r.agentId);
  }

 /**
 * 中断指定子代理:只改这一条记录。
 * 为什么 stop 只作用于指定 agent:并行子代理共享同一个父记录,停一个不能误伤兄弟;
 * 父任务不在 records 里(它是调用方),所以也不会反向中断父任务。
 * 非终态→interrupted 并返回记录;终态→ALREADY_TERMINAL;不存在→NOT_FOUND。
 */
  interrupt(agentId: string): SubagentRegistryResult {
    const cur = this.records.get(agentId);
    if (!cur) return { ok: false, code: "NOT_FOUND" };
    if (isTerminalState(cur.state)) return { ok: false, code: "ALREADY_TERMINAL", record: snapshot(cur) };
    const next: SubagentRecord = { ...cur, state: "interrupted", lastEventAt: Date.now() };
    this.records.set(agentId, next);
    return { ok: true, record: snapshot(next) };
  }

 /** 状态计数(面板/运维观测用)。 */
  stats(): SubagentStats {
    const out: SubagentStats = { total: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0, terminal: 0 };
    for (const rec of this.records.values()) {
      out.total += 1;
      out[rec.state] += 1;
      if (isTerminalState(rec.state)) out.terminal += 1;
    }
    return out;
  }

 /**
 * 启动恢复:同 agentId 已存在→跳过(不覆盖进程内已更新的状态,终态因此天然保留);
 * 非法记录跳过不抛。返回条数便于装配侧留痕。
 */
  restore(records: readonly SubagentRecord[]): SubagentRestoreResult {
    let restored = 0;
    let skipped = 0;
    for (const input of records ?? []) {
      const normalized = normalizeRecord(input);
      if (!normalized || this.records.has(normalized.agentId)) {
        skipped += 1;
        continue;
      }
      this.records.set(normalized.agentId, normalized);
      restored += 1;
    }
    return { restored, skipped };
  }
}

/** 快照是否终态(给装配侧做判定的公共谓词,避免各处重复写状态集合)。 */
export function isTerminalSubagentState(state: unknown): boolean {
  return isState(state) && isTerminalState(state);
}
