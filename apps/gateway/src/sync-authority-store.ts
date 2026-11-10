/**
 * 同步权威协议的持久层:把 runtime 的纯逻辑(packages/harness-runtime 的 agent/sync-authority)落到
 * `<root>/.genie/rsi/sync.json`。
 *
 * 为什么需要这一层:sync-authority 是纯函数,状态在内存里;而「会话迁移后谁是权威」这件事
 * 一旦重启就丢,等于没协议。落盘面必须同时满足四条:
 * ① **原子写**(tmp + rename):读到半个文件 = 读出一份不存在的历史。rename 在同一文件系统上
 *    是原子的,崩溃只会留下一个临时文件,绝不留下残缺的权威状态。
 * ② **坏 JSON / 文件不存在 → 空状态,不抛**:权威文件坏了要「表现得像从没写过」并让上层继续
 *    跑,而不是把整个网关带崩;坏字段逐条过滤(坏的聚合不参与,好的照常读)。
 * ③ **同进程按 root 串行**:read-modify-write 若并发交错,后写会把前一条事件抹掉——「并发
 *    accept 丢更新」正是这类事故的典型现场。这里用 promise 链把同一 root 的操作排队。
 * ④ **拒收不落盘**:NOOP / CONFLICT_DIE / DROPPED_OWNER / INVALID 一律不写文件,连 mtime
 *    都不动,便于用「文件内容不变」复核「拒收确实零副作用」。
 *
 * 依赖纪律:node:fs / node:path + runtime 的纯逻辑模块;不引 agent loop、不引 gateway 其余业务模块。
 * runtime 模块按 cohort-signature-store 的既有套路惰性解析(两跳):
 * ① 带 `--conditions=development` 的运行时(vitest)走包导出 src 入口;
 * ② 裸 tsx/dist 缺该文件时回退到仓内源文件(new URL,避免静态 .ts specifier 触发 TS5097/TS6059)。
 * 除参数错误(root 非法)外不 throw:IO 失败折叠成稳定码返回。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AuthorityEvent,
  MigrateOutcome,
  SubscribeOutcome,
  SyncCode,
  SyncState,
} from "@lampgenie/runtime/agent/sync-authority";

/** 落盘格式版本:字段语义变化时递增(读取方只认 1,其余按空状态处理)。 */
export const SYNC_STORE_VERSION = 1;

type SyncRuntime = {
  emptyState: () => SyncState;
  acceptEvent: (state: SyncState, event: AuthorityEvent) => { state: SyncState; code: SyncCode };
  migrate: (
    state: SyncState,
    options: { aggregateId: string; fromOwner: string; toOwner: string; at?: number },
  ) => MigrateOutcome;
  subscribeThenRead: (state: SyncState, input: { aggregateId: string; sinceSeq: number }) => SubscribeOutcome;
  watermarkFor: (state: SyncState, aggregateId: string) => number;
};

let syncRuntime: SyncRuntime | undefined;

/** 两跳解析 runtime 模块(见文件头依赖纪律)。 */
async function loadSyncRuntime(): Promise<SyncRuntime> {
  if (syncRuntime) return syncRuntime;
  const spec = "@lampgenie/runtime/agent/sync-authority";
  try {
    syncRuntime = (await import(spec)) as SyncRuntime;
  } catch {
    const srcUrl = new URL("../../../packages/harness-runtime/src/agent/sync-authority.ts", import.meta.url).href;
    syncRuntime = (await import(srcUrl)) as SyncRuntime;
  }
  return syncRuntime;
}

/** runtime 面(顶层 await:所有导出函数保持同步签名)。 */
const rt = await loadSyncRuntime();

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 权威文件绝对路径:`<root>/.genie/rsi/sync.json`。 */
export function syncPath(root: string): string {
  const text = textOf(root);
  if (!text) throw new TypeError("sync-authority-store: root 必须是非空字符串");
  return join(text, ".genie", "rsi", "sync.json");
}

function eventOf(value: unknown): AuthorityEvent | undefined {
  if (!isRecord(value)) return undefined;
  const aggregateId = textOf(value.aggregateId);
  const ownerId = textOf(value.ownerId);
  const payloadHash = textOf(value.payloadHash);
  const seq = value.seq;
  const at = value.at;
  if (!aggregateId || !ownerId || !payloadHash) return undefined;
  if (!isFiniteNumber(seq) || !Number.isInteger(seq) || seq <= 0) return undefined;
  if (!isFiniteNumber(at)) return undefined;
  return { aggregateId, seq, ownerId, payloadHash, at };
}

/**
 * 把任意外来结构归一成合法 SyncState:坏字段逐条丢弃,不整文件失效、不 throw。
 * 与 runtime 的校验保持一致(seq 正整数、字符串非空、time 有限)。
 */
function normalizeState(raw: unknown): SyncState {
  const state = rt.emptyState();
  if (!isRecord(raw)) return state;
  if (raw.v !== undefined && raw.v !== SYNC_STORE_VERSION) return state;

  const owners: Record<string, { since: number }> = {};
  if (isRecord(raw.owners)) {
    for (const [id, value] of Object.entries(raw.owners)) {
      const ownerId = textOf(id);
      if (!ownerId || !isRecord(value) || !isFiniteNumber(value.since)) continue;
      owners[ownerId] = { since: value.since };
    }
  }

  const aggregates: Record<string, { aggregateId: string; ownerId: string; watermark: number; events: AuthorityEvent[] }> = {};
  if (isRecord(raw.aggregates)) {
    for (const [id, value] of Object.entries(raw.aggregates)) {
      const aggregateId = textOf(id);
      if (!aggregateId || !isRecord(value)) continue;
      const ownerId = textOf(value.ownerId);
      if (!ownerId) continue;
      const events = Array.isArray(value.events)
        ? value.events
            .map(eventOf)
            .filter((item): item is AuthorityEvent => item !== undefined && item.aggregateId === aggregateId)
            .sort((a, b) => a.seq - b.seq)
        : [];
      const maxSeq = events.reduce((max, item) => Math.max(max, item.seq), 0);
      const declared = isFiniteNumber(value.watermark) ? Math.trunc(value.watermark) : 0;
      aggregates[aggregateId] = {
        aggregateId,
        ownerId,
        watermark: Math.max(declared, maxSeq),
        events,
      };
    }
  }

  return { aggregates, owners };
}

/** 读权威状态:不存在 / 空文件 / 坏 JSON / 结构不符 → 空状态(不抛)。 */
function readState(file: string): SyncState {
  if (!existsSync(file)) return rt.emptyState();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return rt.emptyState();
  }
  if (text.trim() === "") return rt.emptyState();
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return rt.emptyState();
  }
  return normalizeState(raw);
}

let tmpCounter = 0;

/** 原子写:先写同目录 tmp,再 rename 覆盖;任何异常都不留半截权威文件。 */
function writeState(file: string, state: SyncState): void {
  mkdirSync(dirname(file), { recursive: true });
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  const body = { v: SYNC_STORE_VERSION, aggregates: state.aggregates, owners: state.owners };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** 同 root(同目标文件)串行:read-modify-write 不允许交错。 */
const chains = new Map<string, Promise<unknown>>();

function runExclusive<T>(key: string, task: () => T): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = (): T => task();
  const next = prev.then(run, run);
  // 链上只保留「已完成」信号:前一次失败不得毒化后续操作。
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export type AcceptResult = {
  code: SyncCode;
  state: SyncState;
  /** 是否真的落盘(拒收路径为 false,文件与 mtime 都不动)。 */
  persisted: boolean;
  error?: string;
};

/** 接受一条事件并落盘。拒收(INVALID/NOOP/CONFLICT_DIE/DROPPED_OWNER)不写文件。 */
export async function accept(root: string, event: AuthorityEvent): Promise<AcceptResult> {
  const file = syncPath(root);
  return runExclusive(file, () => {
    const state = readState(file);
    const outcome = rt.acceptEvent(state, event);
    if (outcome.code !== "SYNC_ACCEPTED") {
      return { code: outcome.code, state: outcome.state, persisted: false };
    }
    try {
      writeState(file, outcome.state);
    } catch (error) {
      return {
        code: "SYNC_INVALID",
        state,
        persisted: false,
        error: `sync-authority-store: 写入失败 ${(error as Error).message}`,
      };
    }
    return { code: outcome.code, state: outcome.state, persisted: true };
  });
}

export type MigrateStoreResult = MigrateOutcome & { persisted: boolean; error?: string };

/** 归属转移:四段全成功才落盘;失败时文件一字不改,可安全重试。 */
export async function migrate(
  root: string,
  options: { aggregateId: string; fromOwner: string; toOwner: string; at?: number },
): Promise<MigrateStoreResult> {
  const file = syncPath(root);
  return runExclusive(file, () => {
    const state = readState(file);
    const outcome = rt.migrate(state, options);
    if (outcome.code !== "SYNC_MIGRATED") return { ...outcome, persisted: false };
    try {
      writeState(file, outcome.state);
    } catch (error) {
      return {
        ...outcome,
        state,
        code: "SYNC_MIGRATE_FAILED" as SyncCode,
        persisted: false,
        error: `sync-authority-store: 写入失败 ${(error as Error).message}`,
      };
    }
    return { ...outcome, persisted: true };
  });
}

export type SubscribeStoreResult = SubscribeOutcome & { watermark: number };

/** 先订阅拿脏位、再读历史(迁移后新实例的接手入口)。 */
export async function subscribe(
  root: string,
  input: { aggregateId: string; sinceSeq: number },
): Promise<SubscribeStoreResult> {
  const file = syncPath(root);
  return runExclusive(file, () => {
    const state = readState(file);
    const outcome = rt.subscribeThenRead(state, input);
    return { ...outcome, watermark: rt.watermarkFor(state, input?.aggregateId ?? "") };
  });
}

/** 水位查询:聚合不存在(或文件坏)→ 0。 */
export async function watermark(root: string, aggregateId: string): Promise<number> {
  const file = syncPath(root);
  return runExclusive(file, () => rt.watermarkFor(readState(file), aggregateId));
}

export type SyncReport = {
  aggregates: { id: string; ownerId: string; watermark: number; events: number }[];
  owners: Record<string, { since: number }>;
  totalEvents: number;
};

/** 报表:聚合摘要(按 id 排序)+ owner 登记 + 事件总数。 */
export async function report(root: string): Promise<SyncReport> {
  const file = syncPath(root);
  return runExclusive(file, () => {
    const state = readState(file);
    const aggregates: SyncReport["aggregates"] = [];
    for (const [id, aggregate] of Object.entries(state.aggregates)) {
      aggregates.push({
        id,
        ownerId: aggregate.ownerId,
        watermark: aggregate.watermark,
        events: aggregate.events.length,
      });
    }
    aggregates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const totalEvents = aggregates.reduce((sum, item) => sum + item.events, 0);
    return { aggregates, owners: state.owners, totalEvents };
  });
}

/** 当前状态快照(只读,供 CLI /report 之外的诊断用)。 */
export async function loadState(root: string): Promise<SyncState> {
  const file = syncPath(root);
  return runExclusive(file, () => readState(file));
}
