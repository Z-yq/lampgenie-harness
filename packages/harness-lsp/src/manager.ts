/**
 * LSP 客户端实例缓存 + 空闲回收。
 * 与 code-sense 索引单飞同族:同 (server,root) 只拉起一个进程;并发首次检查共享同一 spawn Promise;
 * 失败标记 broken(本进程内不再重试,避免每次编辑都等一次启动超时)。
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
const entries = new Map<string, Entry>();
const broken = new Set<string>();

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
  if (broken.has(key)) return null;
  let entry = entries.get(key);
  if (!entry) {
    const clientPromise = LspClient.start(server, root, Math.max(timeoutMs, MIN_START_TIMEOUT_MS));
    entry = { key, clientPromise, lastUsed: Date.now(), chain: Promise.resolve() };
    entries.set(key, entry);
    clientPromise.catch(() => {
      broken.add(key);
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
  broken.clear();
  await Promise.all(all.map(async (e) => {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    try { const c = await e.clientPromise; await c.shutdown(); } catch { /* ignore */ }
  }));
}

/** 测试用:清状态并异步关闭实例(超时用例防挂)。 */
export function resetLspManagerState(): void {
  const all = [...entries.values()];
  entries.clear();
  broken.clear();
  for (const e of all) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    void e.clientPromise.then((c) => c.shutdown()).catch(() => { /* 已死 */ });
  }
}
