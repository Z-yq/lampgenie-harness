/**
 * LSP 客户端实例缓存 + 空闲回收。
 * 与 code-sense 索引单飞同族:同 (server,root) 只拉起一个进程;并发首次检查共享同一 spawn Promise;
 * 启动失败按指数退避重试:1m/5m/15m,最多 3 次退避后永久 broken,避免每次编辑都等一次启动超时。
 */
import { LspClient } from "./client.js";
import type { ServerSpec } from "./servers.js";

interface Entry {
  key: string;
  clientPromise: Promise<LspClient>;
  lastUsed: number;
  idleTimer?: NodeJS.Timeout;
  chain: Promise<void>;
}

const IDLE_MS = 60_000;
/**
 * 冷启动容忍:server 首次 spawn+initialize(pylsp 经验证 ~2.5s)不占用单次诊断预算。
 * 诊断收集仍严格受 settings.timeoutMs 约束;这里只避免「首条编辑因冷启动被误判超时」。
 */
const MIN_START_TIMEOUT_MS = 3000;
/** 启动失败退避阶梯:第 n 次失败等第 n 档;第 4 次失败转永久 broken。 */
export const LSP_BROKEN_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];
const entries = new Map<string, Entry>();
/** key → 允许重试的时间戳;Infinity = 永久 broken。 */
const brokenUntil = new Map<string, number>();
/** key → 连续启动失败次数(成功即清零)。 */
const failures = new Map<string, number>();

function keyOf(server: ServerSpec, root: string): string {
  return `${server.id}|${root}`;
}

function armIdle(entry: Entry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    void entry.clientPromise.then((c) => c.shutdown()).catch(() => { /* 已死 */ });
  }, IDLE_MS);
  entry.idleTimer.unref?.();
}

/** 退避期内(或永久 broken)跳过启动;到期后允许重试一次。 */
function brokenNow(key: string, now = Date.now()): boolean {
  const until = brokenUntil.get(key);
  if (until === undefined) return false;
  return until === Infinity || now < until;
}

/** 记一次启动失败:按失败序号升档退避,超过阶梯长度即永久。 */
function markFailed(key: string): void {
  const n = (failures.get(key) ?? 0) + 1;
  failures.set(key, n);
  const idx = n - 1;
  brokenUntil.set(key, idx < LSP_BROKEN_BACKOFF_MS.length ? Date.now() + LSP_BROKEN_BACKOFF_MS[idx]! : Infinity);
}

/** 启动成功:清除 broken/失败计数。 */
function clearBroken(key: string): void {
  brokenUntil.delete(key);
  failures.delete(key);
}

/**
 * 在同一 (server,root) 实例上串行执行 fn。
 * 返回 null=server 不可用(缺失/启动失败/已标记 broken)——调用方走兜底,绝不抛错。
 */
export async function withLspClient<T>(
  server: ServerSpec,
  root: string,
  timeoutMs: number,
  fn: (client: LspClient) => Promise<T>,
): Promise<T | null> {
  const key = keyOf(server, root);
  if (brokenNow(key)) return null;
  let entry = entries.get(key);
  if (!entry) {
    const clientPromise = LspClient.start(server, root, Math.max(timeoutMs, MIN_START_TIMEOUT_MS));
    entry = { key, clientPromise, lastUsed: Date.now(), chain: Promise.resolve() };
    entries.set(key, entry);
    clientPromise.then(() => {
      clearBroken(key);
    }, () => {
      markFailed(key);
      if (entries.get(key) === entry) entries.delete(key);
    });
  }
  entry.lastUsed = Date.now();
  armIdle(entry);
  try {
    const client = await entry.clientPromise;
    const run = entry.chain.then(() => fn(client));
    entry.chain = run.then(() => undefined, () => undefined);
    return await run;
  } catch (err) {
    if (process.env.DEBUG_LSP) console.error("[lsp-debug]", err);
    return null;
  }
}

/** 收尾:关闭全部实例(测试/进程退出用)。 */
export async function disposeAllLspClients(): Promise<void> {
  const all = [...entries.values()];
  entries.clear();
  resetLspBroken();
  await Promise.all(all.map(async (e) => {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    try { const c = await e.clientPromise; await c.shutdown(); } catch { /* ignore */ }
  }));
}

/** 测试用:清状态并异步关闭实例(超时用例防挂)。 */
export function resetLspManagerState(): void {
  const all = [...entries.values()];
  entries.clear();
  resetLspBroken();
  for (const e of all) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    void e.clientPromise.then((c) => c.shutdown()).catch(() => { /* 已死 */ });
  }
}

export interface LspBrokenState {
  key: string;
  failures: number;
 /** 允许重试的时间戳(毫秒);permanent=true 时不出现。 */
  retryAt?: number;
 /** 超过退避阶梯次数=永久 broken。 */
  permanent?: boolean;
}

/** 诊断/测试:当前 broken 状态快照(key → 失败次数 + 下次重试时间或永久标记)。 */
export function lspBrokenState(): LspBrokenState[] {
  const out: LspBrokenState[] = [];
  for (const [key, until] of brokenUntil) {
    const n = failures.get(key) ?? 0;
    if (until === Infinity) out.push({ key, failures: n, permanent: true });
    else out.push({ key, failures: n, retryAt: until });
  }
  return out;
}

/** 清除 broken 记录:给 key=只清该 (server,root);缺省=全清。 */
export function resetLspBroken(key?: string): void {
  if (key === undefined) {
    brokenUntil.clear();
    failures.clear();
    return;
  }
  brokenUntil.delete(key);
  failures.delete(key);
}
