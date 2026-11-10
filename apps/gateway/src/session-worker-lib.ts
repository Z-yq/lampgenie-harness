/**
 * 会话 worker 库(2026-10-21):IPC 基座 + ProxyJournal(本地副本读源/批量上行写)+
 * 权限·wfAsk·askUser·MCP 代理工厂。与入口(session-worker.ts)分离=可单测、无副作用。
 */
import type { Journal, JournalEvent, NewEvent, EventListener } from "@lampgenie/core";
import type { WorkerRequest } from "./session-worker-protocol.js";

// ---- IPC 基座(worker 侧)----
type ResHandler = (value: unknown) => void;
const pendingRpc = new Map<number, { resolve: ResHandler; reject: (e: Error) => void }>();
let rpcSeq = 0;
let hostDead = false;

/** IPC 传输层:缺省=process.send(fork 通道);测试可注入(setIpcTransport)。 */
let ipcSend: ((msg: unknown) => void) | null =
  typeof process.send === "function" ? (msg) => { process.send!(msg as never); } : null;

/** 测试缝:替换 IPC 传输(单测无 fork 通道时注入;null=通道不可用)。 */
export function setIpcTransport(fn: ((msg: unknown) => void) | null): void { ipcSend = fn; }

export function request<T = unknown>(kind: WorkerRequest["kind"], payload: unknown): Promise<T> { /* payload 宽进:各 kind 的精确形状由协议层保证 */
  return new Promise<T>((resolve, reject) => {
    if (hostDead || !ipcSend) { reject(new Error("host 通道不可用")); return; }
    const id = ++rpcSeq;
    pendingRpc.set(id, { resolve: resolve as ResHandler, reject });
    try {
      ipcSend({ t: "req", id, kind, payload });
    } catch (err) {
      pendingRpc.delete(id);
      reject(err as Error);
    }
  });
}
export function notify(msg: Record<string, unknown>): void {
  if (hostDead || !ipcSend) return;
  try { ipcSend(msg); } catch { /* 已断:由 ppid 看门狗收尾 */ }
}

/** host 应答分发(入口的 process.on("message") res 分支转发到这里)。 */
export function handleHostResponse(msg: { id: number; ok: boolean; value?: unknown; error?: string }): void {
  const p = pendingRpc.get(msg.id);
  if (!p) return;
  pendingRpc.delete(msg.id);
  if (msg.ok) p.resolve(msg.value);
  else p.reject(new Error(msg.error ?? "RPC 失败"));
}

/** 标记 host 通道不可用(父进程失联等;后续 request 全部快速失败)。 */
export function setHostDead(): void { hostDead = true; }

// ---- ProxyJournal:本地副本为读源,append 批量上行(本地 seq 仅保序)----
export class ProxyJournal implements Journal {
  /** 本地副本(seq=本地数组下标,单调);种子=会话全量 RPC,后续=自身 append + gateway 推送。 */
  private replica: JournalEvent[] = [];
  private listeners = new Set<EventListener>();
  private upBatch: JournalEvent[] = [];
  private flushScheduled = false;
  private seenIds = new Set<string>();

  constructor(private readonly sessionId: string) {}

  /** 种子快照里见过的最大 gateway seq(水位;catchUp 增量起点)。 */
  private maxGatewaySeq = -1;

  /** 启动种子:会话全量(阻塞到拿到;失败=空副本继续,首个读会再拉)。 */
  async seed(): Promise<void> {
    try {
      const evs = await request<JournalEvent[]>("journal.readSession", { sessionId: this.sessionId });
      if (Array.isArray(evs)) {
        this.replica = evs;
        for (const e of evs) {
          if (e.idempotencyKey) this.seenIds.add(e.idempotencyKey);
          if (typeof e.seq === "number" && e.seq > this.maxGatewaySeq) this.maxGatewaySeq = e.seq;
        }
      }
    } catch (err) {
      console.error("[session-worker] journal 种子拉取失败(空副本继续)", err);
    }
  }
  /** 水位补拉(2026-10-21 四轮复审 R4-1:ZCode SUBAGENTS.md「先订阅后读史+只应用水位以上」——
   *  种子快照→ready 之间 gateway 侧新事件(steer/系统消息)既不在种子、又被转发器 ready 门丢弃,
   *  恰好落窗的指令会永久丢失。ready 后按 maxGatewaySeq+1 补拉一次,键去重并入(push 与补拉
   *  双到达的安全网);此后转发器已在推,无窗口。 */
  async catchUp(): Promise<void> {
    try {
      const evs = await request<JournalEvent[]>("journal.readSession", { sessionId: this.sessionId, sinceSeq: this.maxGatewaySeq + 1 });
      if (Array.isArray(evs) && evs.length) this.ingestRemote(evs);
    } catch (err) {
      console.error("[session-worker] journal 水位补拉失败(转发器仍在推,仅丢窗口内事件)", err);
    }
  }
  /** gateway 推送并入(steer/系统消息等 gateway 侧写入)。 */
  ingestRemote(events: unknown[]): void {
    for (const raw of events) {
      const e = raw as JournalEvent;
      if (!e || typeof e !== "object") continue;
      if (String(e.sessionId ?? "") !== this.sessionId) continue; // 只保本会话副本(读面只用本会话)
      // 回声去重键(2026-10-22 修复):**不含 time**——gateway 落账会重分配 seq/time(权威),
      // 推回事件的 time 与本地 append 的 time 必不相同,旧键(time|kind|payload 前 200 字)对
      // 回声永不命中 → worker 自身事件全部双入 → 重复 assistant(toolCalls) 触发端点 400
      // 「insufficient tool messages following tool_calls」(生产实锤;与 repairToolPairing
      // 第 0 遍重复 assistant 去重构成双保险)。payload 用全文:截断会碰撞同前缀的不同 tool.result。
      const key = `${e.kind}|${JSON.stringify(e.payload ?? null)}`;
      if (this.recentKeys.has(key)) continue; // 回声去重(自己上行又推回来的)
      this.recentKeys.add(key);
      if (this.recentKeys.size > 500) this.recentKeys.clear();
      if (e.idempotencyKey) this.seenIds.add(e.idempotencyKey);
      if (typeof e.seq === "number" && e.seq > this.maxGatewaySeq) this.maxGatewaySeq = e.seq;
      this.replica.push({ ...e, seq: this.replica.length });
      for (const l of this.listeners) l(this.replica[this.replica.length - 1]!);
    }
  }
  private recentKeys = new Set<string>();

  append<T>(event: NewEvent<T>): JournalEvent<T> {
    const key = event.idempotencyKey;
    if (key && this.seenIds.has(key)) {
      // 幂等命中:本地副本里找同键事件返回(与 BaseJournal 同语义)。
      const existing = this.replica.find((e) => e.idempotencyKey === key);
      return existing as JournalEvent<T>;
    }
    const full = { ...event, seq: this.replica.length, time: event.time ?? Date.now() } as JournalEvent<T>;
    this.replica.push(full);
    if (key) this.seenIds.add(key);
    // 回声去重键(自己的 append 被 gateway 推回来时不双入;2026-10-22 与 ingestRemote 键
    // 对齐:kind+payload 全文,不含被网关落账重赋的 time)。
    this.recentKeys.add(`${full.kind}|${JSON.stringify((full as { payload?: unknown }).payload ?? null)}`);
    if (this.recentKeys.size > 500) this.recentKeys.clear();
    this.upBatch.push(full);
    this.scheduleFlush();
    for (const l of this.listeners) l(full);
    return full;
  }
  appendMany<T>(events: NewEvent<T>[]): JournalEvent<T>[] {
    return events.map((e) => this.append(e));
  }
  readAll(sinceSeq = 0): JournalEvent[] {
    // worker 读面只消费本会话(deriveMessages/compact/goal 全部 readSession);跨会话读在 gateway。
    return this.replica.filter((e) => e.seq >= sinceSeq);
  }
  readSession(sessionId: string, sinceSeq = 0): JournalEvent[] {
    if (sessionId !== this.sessionId) return [];
    return this.replica.filter((e) => e.seq >= sinceSeq);
  }
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get length(): number { return this.replica.length; }

  /** 写前持久化屏障(M24 生产态,2026-11-07):把待上行事件**同步送到 gateway** 落账并由
   *  gateway FileJournal flushStrict 落盘,host ack(ok)之后才返回——loop 的 await 因此真正成为屏障。
   *  - 有事件:发 journal.appendSync(批内剥掉本地 seq,gateway 重分配权威 seq);host 落账 + flush 都成功才 ack;
   *  - 无事件:发 journal.flushStrict,让 host 清掉此前 notify 批(journal.append)在 FileJournal 队列里的尾巴;
   *  - 任一失败/host 通道不可用:**抛错**(不静默),失败批原样放回队首待重试(事件不丢)。
   *  与 scheduleFlush 的竞争安全:两者都用 splice 取快照,后到的 microtask 见空队直接 return(不重发)。 */
  async flushStrict(): Promise<void> {
    const raw = this.upBatch.splice(0); // 快照:并发 scheduleFlush 的微任务看到空队即退出
    if (raw.length === 0) {
      try {
        await request("journal.flushStrict", {});
      } catch (err) {
        throw new Error(`journal flushStrict failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    const batch = raw.map((e) => {
      const c = { ...(e as unknown as Record<string, unknown>) };
      delete c.seq; // gateway 重分配权威 seq
      return c;
    });
    try {
      await request("journal.appendSync", { events: batch });
    } catch (err) {
      // 失败:整批放回队首(保序,不丢),本批事件仍在内存在账(append 已入 replica);
      // 不在这里重排 notify 微任务——留着让下一次 flushStrict 原样重试整批(不掩盖主错误)。
      this.upBatch.unshift(...raw);
      throw new Error(`journal flushStrict failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    void Promise.resolve().then(() => {
      this.flushScheduled = false;
      if (this.upBatch.length === 0) return;
      const batch = this.upBatch.splice(0).map((e) => {
        const c = { ...(e as unknown as Record<string, unknown>) };
        delete c.seq; // gateway 重分配权威 seq
        return c;
      });
      notify({ t: "journal.append", events: batch });
    });
  }
}

// ---- 代理:权限/workflow ask/ask_user/MCP(全部 RPC 到 gateway)----
interface ProxyBrokerShape { ask(input: { sessionId?: string; tool: string; summary: string; risk?: string }): Promise<{ decision: "allow-once" | "reject"; rule?: unknown }> }
export function makePermissionProxy(sessionId: string): ProxyBrokerShape {
  return {
    async ask(input) {
      try {
        return await request("permission.ask", { sessionId: input.sessionId ?? sessionId, tool: input.tool, summary: input.summary, risk: input.risk });
      } catch {
        return { decision: "reject" }; // 通道断=fail-closed(与 broker offline 同语义)
      }
    },
  };
}
export function makeWfAskProxy() {
  return {
    async ask(wfId: string, cacheKey: string, instructions: string): Promise<string | null> {
      try { return await request<string | null>("wfAsk", { wfId, cacheKey, instructions }); }
      catch { return null; }
    },
  };
}
export function makeAskUserProxy() {
  return {
    async ask(sessionId: string, payload: unknown): Promise<string | null> {
      try { return await request<string | null>("askUser", { sessionId, payload }); }
      catch { return null; }
    },
  };
}
export function makeMcpProxy(toolsSnapshot: { serverId: string; serverName: string; name: string; description: string }[]) {
  return {
    async allToolsForAgent() { return toolsSnapshot; },
    async callTool(serverId: string, tool: string, args: unknown): Promise<string> {
      try { return await request<string>("mcp.call", { serverId, tool, args }); }
      catch (err) { return `MCP 调用失败:${String(err).slice(0, 200)}`; }
    },
  };
}

