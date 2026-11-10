/**
 * M90 团队任务 DAG(journal 持久团队任务板)。
 *
 * 问题:多 agent 协作时「谁在做什么、谁等谁、谁认领了哪块」只存在于对话里——子代理各自跑,
 * 主 agent 不知道彼此边界,重复改同一个文件、越权推进未就绪的步骤、断了没人续手。
 *
 * 本模块只做「任务板 + 依赖拓扑 + 认领租约」这一层,事实源只有 journal(append-only):
 *   team.task.created {task}                      创建(全量行,revision=1)
 *   team.task.changed {id,patch}                  变更(局部字段 + revision/updatedAt)
 *   team.task.deleted {id,at}                     删除
 * 冷恢复 = foldTeamTasks(readAll 的 team.task.* 事件):create 落行、changed 覆盖、deleted 移除,
 * 未知 kind 一律忽略(与其它 fold 族一致,不因新增 kind 崩)。
 *
 * 语义边角:
 * - 依赖就绪传播只在 `complete` 一处发生(只升一层;链式 A→B→C 靠 B 完成时再升 C);
 * - CAS 只防「读到旧值再写」:凡 mutation 传了 expectedRevision 就比对,不等抛
 *   TEAM_TASK_REVISION_CONFLICT 且 details.current=当前 revision(绝不静默覆盖);
 * - writeScopes 重叠**只警告不加锁**:claim 返回 warnings,用于提示两个 agent 可能撞同一批文件;
 * - 认领租约 claimExpiresAt 过期后不自动易主,必须 reclaimExpired(now) 回收再 claim(显式、可审计)。
 */
import type { EventKind, Journal, JournalEvent } from "@lampgenie/core";

/** 团队任务状态。 */
export type TeamTaskStatus = "pending" | "ready" | "claimed" | "done" | "failed" | "blocked";

/** 任务行(硬契约:字段名逐字)。 */
export type Task = {
  id: string;
  title: string;
  status: TeamTaskStatus;
  blockedBy: string[];
  writeScopes: string[];
  owner?: string;
  claimExpiresAt?: number;
  heartbeatAt?: number;
  attempts: number;
  result?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

/** 团队任务事件的 kind 全集(唯一持久面)。 */
export type TeamTaskJournalKind = "team.task.created" | "team.task.changed" | "team.task.deleted";

/** created 事件 payload:整行快照(revision=1)。 */
export interface TeamTaskCreatedPayload {
  task: Task;
}

/** changed 事件 payload:局部补丁(必带 revision/updatedAt)。 */
export interface TeamTaskChangedPayload {
  id: string;
  patch: Partial<Task> & { revision: number; updatedAt: number };
}

/** deleted 事件 payload:墓碑。 */
export interface TeamTaskDeletedPayload {
  id: string;
  at: number;
}

export type TeamTaskErrorCode =
  | "TEAM_TASK_NOT_FOUND"
  | "TEAM_TASK_REVISION_CONFLICT"
  | "TEAM_TASK_BLOCKER_MISSING"
  | "TEAM_TASK_CYCLE"
  | "TEAM_TASK_NOT_READY"
  | "TEAM_TASK_ALREADY_CLAIMED"
  | "TEAM_TASK_HAS_DEPENDENTS"
  | "TEAM_TASK_INVALID";

/** 任务板错误:code 是硬契约(工具面原样透传到 JSON),details 带定位信息。 */
export class TeamTaskError extends Error {
  readonly code: TeamTaskErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: TeamTaskErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TeamTaskError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** 缺省认领租约(5 分钟)。 */
export const DEFAULT_CLAIM_TTL_MS = 300_000;
/** 缺省失败熔断阈值(第 3 次失败进 blocked)。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** EventKind 是闭合联合(只增不改),本机制的 3 个 kind 尚未进类型面——写入值逐字为契约 kind,
 * 故此处做一次显式断言。types.ts 收录后可删(不在本步文件面内)。 */
function asEventKind(kind: TeamTaskJournalKind): EventKind {
  return kind as unknown as EventKind;
}

function cloneTask(t: Task): Task {
  return {
    ...t,
    blockedBy: [...t.blockedBy],
    writeScopes: [...t.writeScopes],
  };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

/** 写域规范化:去尾斜杠、去尾部通配段(`src/a/**` → `src/a`)、`\`→`/`。 */
function normalizeScope(scope: string): string {
  return scope
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\/\*\*?$/, "")
    .replace(/\/+$/, "");
}

/** 通配段之前的字面前缀(`src/**\/*.ts` → `src`,`src/a/*.ts` → `src/a`,`**` → ``)。 */
function scopePrefix(scope: string): string {
  const parts = normalizeScope(scope).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p.includes("*") || p.includes("?")) break;
    out.push(p);
  }
  return out.join("/");
}

/** 两写域是否重叠:同串 / 字面前缀包含 / 任一为根通配。只用于 warning,不做锁。 */
export function scopesOverlap(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  if (na.length > 0 && na === nb) return true;
  const pa = scopePrefix(a);
  const pb = scopePrefix(b);
  if (pa === "" || pb === "") return true; // 通配起点即仓库根:与任何写域都有交集
  if (pa === pb) return true;
  return pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

/** 冷恢复:按 seq 折叠三类事件成任务表(未知 kind 忽略)。传 readAll() 结果即可。 */
export function foldTeamTasks(events: readonly JournalEvent[]): Map<string, Task> {
  const tasks = new Map<string, Task>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of ordered) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    // EventKind 闭合联合暂未收录本机制 3 个 kind(见 asEventKind 注释),按字符串比对。
    const kind: string = ev.kind;
    if (kind === "team.task.created") {
      const row = payload.task as Task | undefined;
      if (row && typeof row.id === "string") tasks.set(row.id, cloneTask(row));
    } else if (kind === "team.task.changed") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const patch = payload.patch as Partial<Task> | undefined;
      const cur = tasks.get(id);
      if (!cur || !patch) continue;
      tasks.set(id, cloneTask({ ...cur, ...patch }));
    } else if (kind === "team.task.deleted") {
      const id = typeof payload.id === "string" ? payload.id : "";
      if (id) tasks.delete(id);
    }
  }
  return tasks;
}

export interface TeamTaskStoreOptions {
  /** journal 事件归属会话(任务板本身团队全局可见;事件仍按会话落账)。 */
  sessionId?: string;
  /** 缺省熔断阈值。 */
  maxAttempts?: number;
}

export interface ClaimResult {
  task: Task;
  warnings: string[];
}

export interface DeleteResult {
  id: string;
  revision: number;
  deleted: true;
}

/** 团队任务板:journal 唯一真源 + 内存折叠表(构造后首次访问时回放)。 */
export class TeamTaskStore {
  readonly journal: Journal;
  readonly sessionId: string;
  readonly maxAttempts: number;
  private tasks = new Map<string, Task>();
  private loaded = false;
  private seqCounter = 0;

  constructor(journal: Journal, opts: TeamTaskStoreOptions = {}) {
    this.journal = journal;
    this.sessionId = opts.sessionId ?? "";
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** 冷恢复(幂等):首次访问自动调用;journal 被外部追加后可手动重放。 */
  reload(): void {
    this.tasks = foldTeamTasks(this.journal.readAll());
    this.loaded = true;
  }

  private ensure(): void {
    if (!this.loaded) this.reload();
  }

  list(): Task[] {
    this.ensure();
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(cloneTask);
  }

  get(id: string): Task | undefined {
    this.ensure();
    const t = this.tasks.get(id);
    return t ? cloneTask(t) : undefined;
  }

  // —— 写入口:先 append 再从事件回填内存表(内存表永远等于 fold(journal)) ——

  private nextSeq(): number {
    return this.seqCounter++;
  }

  private newId(): string {
    return `tt-${Date.now().toString(36)}-${this.nextSeq().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  private appendCreated(task: Task): void {
    const payload: TeamTaskCreatedPayload = { task: cloneTask(task) };
    this.journal.append({ kind: asEventKind("team.task.created"), sessionId: this.sessionId, payload });
    this.tasks.set(task.id, cloneTask(task));
  }

  private applyChange(id: string, patch: Partial<Task> & { revision: number; updatedAt: number }): Task {
    const cur = this.tasks.get(id);
    if (!cur) throw new TeamTaskError("TEAM_TASK_NOT_FOUND", `团队任务不存在:${id}`, { id });
    const payload: TeamTaskChangedPayload = { id, patch: { ...patch } };
    this.journal.append({ kind: asEventKind("team.task.changed"), sessionId: this.sessionId, payload });
    const next = cloneTask({ ...cur, ...patch });
    this.tasks.set(id, next);
    return next;
  }

  private mustGet(id: string): Task {
    this.ensure();
    const cur = this.tasks.get(id);
    if (!cur) throw new TeamTaskError("TEAM_TASK_NOT_FOUND", `团队任务不存在:${id}`, { id });
    return cur;
  }

  /** CAS 闸:传了 expectedRevision 就比对,不等即拒(never silent overwrite)。 */
  private cas(cur: Task, expectedRevision?: number): void {
    if (expectedRevision === undefined) return;
    if (cur.revision !== expectedRevision) {
      throw new TeamTaskError(
        "TEAM_TASK_REVISION_CONFLICT",
        `revision 冲突:期望 ${expectedRevision},当前 ${cur.revision}`,
        { id: cur.id, current: cur.revision, expected: expectedRevision },
      );
    }
  }

  private blockersDone(t: Task): boolean {
    return t.blockedBy.every((dep) => this.tasks.get(dep)?.status === "done");
  }

  private readyStatus(t: { blockedBy: string[] }): TeamTaskStatus {
    return t.blockedBy.every((dep) => this.tasks.get(dep)?.status === "done") ? "ready" : "pending";
  }

  /** DFS 查环(同时覆盖自引与既有图里的历史环)。 */
  private assertNoCycle(id: string, blockedBy: string[]): void {
    const visit = (node: string, path: string[]): void => {
      if (node === id) {
        throw new TeamTaskError("TEAM_TASK_CYCLE", `依赖成环:${[...path, node].join(" → ")}`, { id, cycle: [...path, node] });
      }
      if (path.includes(node)) {
        throw new TeamTaskError("TEAM_TASK_CYCLE", `依赖成环:${[...path, node].join(" → ")}`, { id, cycle: [...path, node] });
      }
      const dep = this.tasks.get(node);
      if (!dep) return;
      for (const next of dep.blockedBy) visit(next, [...path, node]);
    };
    for (const b of blockedBy) visit(b, []);
  }

  /**
   * 新建任务。blockedBy 必须逐个存在且无环;初始 status = 依赖全 done ? ready : pending。
   * expectedRevision 在此无对照对象(新行 revision 恒为 1),保留入参只为与其余 mutation 同形。
   */
  create(input: { title: string; blockedBy?: string[]; writeScopes?: string[] }, expectedRevision?: number): Task {
    this.ensure();
    void expectedRevision;
    const title = typeof input?.title === "string" ? input.title.trim() : "";
    if (!title) throw new TeamTaskError("TEAM_TASK_INVALID", "title 必填(非空字符串)", { field: "title" });
    const blockedBy = strList(input.blockedBy);
    const writeScopes = strList(input.writeScopes);
    const id = this.newId();
    for (const dep of blockedBy) {
      if (!this.tasks.has(dep)) {
        throw new TeamTaskError("TEAM_TASK_BLOCKER_MISSING", `依赖任务不存在:${dep}`, { id: dep, blockedBy });
      }
    }
    this.assertNoCycle(id, blockedBy);
    const now = Date.now();
    const task: Task = {
      id,
      title,
      status: this.readyStatus({ blockedBy }),
      blockedBy,
      writeScopes,
      attempts: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.appendCreated(task);
    return cloneTask(task);
  }

  /**
   * 认领:仅 pending/ready 且依赖全 done、无未过期 owner;写 owner/claimExpiresAt/heartbeatAt。
   * 返回 writeScopes 与其它在租 claimed 任务重叠的警告(只警告不加锁)。
   */
  claim(id: string, owner: string, opts: { expectedRevision?: number; ttlMs?: number; now?: number } = {}): ClaimResult {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
    const who = typeof owner === "string" ? owner.trim() : "";
    if (!who) throw new TeamTaskError("TEAM_TASK_INVALID", "owner 必填(非空字符串)", { id, field: "owner" });
    this.cas(cur, opts.expectedRevision);
    if (cur.status === "claimed") {
      const live = cur.claimExpiresAt !== undefined && cur.claimExpiresAt > now;
      if (live) {
        throw new TeamTaskError("TEAM_TASK_ALREADY_CLAIMED", `任务已被 ${cur.owner ?? "?"} 认领(租约未过期)`, {
          id,
          owner: cur.owner,
          claimExpiresAt: cur.claimExpiresAt,
        });
      }
      throw new TeamTaskError("TEAM_TASK_NOT_READY", "认领租约已过期:先 reclaimExpired 回收再认领", {
        id,
        claimExpiresAt: cur.claimExpiresAt,
        reason: "lease-expired",
      });
    }
    if (cur.status !== "pending" && cur.status !== "ready") {
      throw new TeamTaskError("TEAM_TASK_NOT_READY", `任务状态 ${cur.status} 不可认领`, { id, status: cur.status });
    }
    const openBlockers = cur.blockedBy.filter((dep) => this.tasks.get(dep)?.status !== "done");
    if (openBlockers.length > 0) {
      throw new TeamTaskError("TEAM_TASK_NOT_READY", `依赖未完成:${openBlockers.join(", ")}`, {
        id,
        blockers: openBlockers,
      });
    }
    const warnings: string[] = [];
    for (const other of this.tasks.values()) {
      if (other.id === id || other.status !== "claimed") continue;
      if (other.claimExpiresAt !== undefined && other.claimExpiresAt <= now) continue; // 过期租约不算占用
      for (const mine of cur.writeScopes) {
        for (const theirs of other.writeScopes) {
          if (scopesOverlap(mine, theirs)) {
            warnings.push(`写域重叠:${mine} ↔ ${other.owner ?? "?"}(${other.id}) 的 ${theirs}(只警告,不加锁)`);
          }
        }
      }
    }
    const next = this.applyChange(id, {
      status: "claimed",
      owner: who,
      claimExpiresAt: now + ttlMs,
      heartbeatAt: now,
      revision: cur.revision + 1,
      updatedAt: now,
    });
    return { task: next, warnings };
  }

  /** 心跳/续租:仅 owner 且未过期。 */
  heartbeat(id: string, owner: string, opts: { expectedRevision?: number; ttlMs?: number; now?: number } = {}): Task {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.cas(cur, opts.expectedRevision);
    if (cur.owner !== owner) {
      throw new TeamTaskError("TEAM_TASK_INVALID", `非 owner 不可续租(当前 owner=${cur.owner ?? "无"})`, {
        id,
        reason: "not-owner",
        owner: cur.owner,
      });
    }
    if (cur.status !== "claimed") {
      throw new TeamTaskError("TEAM_TASK_NOT_READY", `任务状态 ${cur.status} 无租约可续`, { id, status: cur.status });
    }
    if (cur.claimExpiresAt !== undefined && cur.claimExpiresAt <= now) {
      throw new TeamTaskError("TEAM_TASK_INVALID", "认领租约已过期:先 reclaimExpired 回收再认领", {
        id,
        reason: "lease-expired",
        claimExpiresAt: cur.claimExpiresAt,
      });
    }
    const anchor = Math.max(cur.claimExpiresAt ?? now, now);
    return this.applyChange(id, {
      heartbeatAt: now,
      claimExpiresAt: anchor + ttlMs,
      revision: cur.revision + 1,
      updatedAt: now,
    });
  }

  /** 完成:仅 owner(传 owner 时校验);status=done,并把依赖它的 pending 任务在依赖全 done 时升 ready。 */
  complete(id: string, opts: { expectedRevision?: number; result?: string; now?: number; owner?: string } = {}): Task {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    this.cas(cur, opts.expectedRevision);
    if (opts.owner !== undefined && cur.owner !== opts.owner) {
      throw new TeamTaskError("TEAM_TASK_INVALID", `非 owner 不可完成(当前 owner=${cur.owner ?? "无"})`, {
        id,
        reason: "not-owner",
        owner: cur.owner,
      });
    }
    if (cur.status !== "claimed") {
      throw new TeamTaskError("TEAM_TASK_NOT_READY", `任务状态 ${cur.status} 不可完成`, { id, status: cur.status });
    }
    const done = this.applyChange(id, {
      status: "done",
      ...(opts.result !== undefined ? { result: opts.result } : {}),
      revision: cur.revision + 1,
      updatedAt: now,
    });
    this.unblockDependents(id, now);
    return done;
  }

  /** 失败:attempts+1;达阈值进 blocked(熔断),否则回 pending/ready(就绪判定不变)。 */
  fail(id: string, opts: { expectedRevision?: number; error?: string; now?: number; owner?: string } = {}): Task {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    this.cas(cur, opts.expectedRevision);
    if (opts.owner !== undefined && cur.owner !== opts.owner) {
      throw new TeamTaskError("TEAM_TASK_INVALID", `非 owner 不可标记失败(当前 owner=${cur.owner ?? "无"})`, {
        id,
        reason: "not-owner",
        owner: cur.owner,
      });
    }
    if (cur.status !== "claimed") {
      throw new TeamTaskError("TEAM_TASK_NOT_READY", `任务状态 ${cur.status} 不可标记失败`, { id, status: cur.status });
    }
    const attempts = cur.attempts + 1;
    const nextStatus: TeamTaskStatus = attempts >= this.maxAttempts ? "blocked" : this.readyStatus(cur);
    return this.applyChange(id, {
      status: nextStatus,
      attempts,
      owner: undefined,
      claimExpiresAt: undefined,
      heartbeatAt: undefined,
      revision: cur.revision + 1,
      updatedAt: now,
    });
  }

  /** 改派:claimed 任务转移 owner(租约不变)。 */
  reassign(id: string, newOwner: string, opts: { expectedRevision?: number; now?: number } = {}): Task {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    const who = typeof newOwner === "string" ? newOwner.trim() : "";
    if (!who) throw new TeamTaskError("TEAM_TASK_INVALID", "newOwner 必填(非空字符串)", { id, field: "newOwner" });
    this.cas(cur, opts.expectedRevision);
    if (cur.status !== "claimed") {
      throw new TeamTaskError("TEAM_TASK_INVALID", `任务状态 ${cur.status} 不可改派(仅 claimed)`, {
        id,
        reason: "not-claimed",
        status: cur.status,
      });
    }
    return this.applyChange(id, {
      owner: who,
      revision: cur.revision + 1,
      updatedAt: now,
    });
  }

  /** 删除:仍被未删任务依赖 → HAS_DEPENDENTS(拒绝删除,板保持自洽)。 */
  delete(id: string, opts: { expectedRevision?: number; now?: number } = {}): DeleteResult {
    const cur = this.mustGet(id);
    const now = opts.now ?? Date.now();
    this.cas(cur, opts.expectedRevision);
    const dependents = [...this.tasks.values()].filter((t) => t.id !== id && t.blockedBy.includes(id)).map((t) => t.id);
    if (dependents.length > 0) {
      throw new TeamTaskError("TEAM_TASK_HAS_DEPENDENTS", `任务仍被依赖:${dependents.join(", ")}`, { id, dependents });
    }
    const payload: TeamTaskDeletedPayload = { id, at: now };
    this.journal.append({ kind: asEventKind("team.task.deleted"), sessionId: this.sessionId, payload });
    this.tasks.delete(id);
    return { id, revision: cur.revision + 1, deleted: true };
  }

  /** 过期回收:claimed 且 claimExpiresAt < now → 回 pending/ready、owner 清空、attempts 不变。 */
  reclaimExpired(now: number = Date.now()): string[] {
    this.ensure();
    const reclaimed: string[] = [];
    for (const cur of [...this.tasks.values()]) {
      if (cur.status !== "claimed") continue;
      if (cur.claimExpiresAt === undefined || cur.claimExpiresAt >= now) continue;
      this.applyChange(cur.id, {
        status: this.readyStatus(cur),
        owner: undefined,
        claimExpiresAt: undefined,
        heartbeatAt: undefined,
        revision: cur.revision + 1,
        updatedAt: now,
      });
      reclaimed.push(cur.id);
    }
    return reclaimed;
  }

  /** 依赖传播(只升一层):id 完成后,blockedBy 含 id 且依赖全 done 的未完成任务逐条 changed。 */
  private unblockDependents(doneId: string, now: number): void {
    for (const t of [...this.tasks.values()]) {
      if (t.id === doneId) continue;
      if (!t.blockedBy.includes(doneId)) continue;
      if (t.status !== "pending") continue;
      if (!this.blockersDone(t)) continue;
      this.applyChange(t.id, { status: "ready", revision: t.revision + 1, updatedAt: now });
    }
  }
}
