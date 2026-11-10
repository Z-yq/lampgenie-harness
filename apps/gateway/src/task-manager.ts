/**
 * TaskSupervisor:双调度器(user/system)+ 每 owner lane 串行 + 幂等去重。
 * 模式参照 qwen-audio-agent 的 task-manager,但实现自研。
 */
import { randomUUID } from "node:crypto";
import {
  type Task,
  type TaskState,
  transition,
  TERMINAL_STATES,
} from "@lampgenie/core";

export type TaskKind = "user" | "system";

export interface TaskSupervisorOptions {
  /** 全局并发上限。 */
  maxConcurrent: number;
  /** 同一 owner(sessionId)同时只跑几条 user 任务。 */
  maxConcurrentPerOwner: number;
  /** system 任务并发上限。 */
  maxConcurrentSystem: number;
}

export type TaskListener = (task: Task) => void;

/** 派生短标题:首行压空白取前 40 字符,超长加省略号;与全文同则不设(显示层一致)。 */
function deriveTitle(instruction: string): string | undefined {
  const first = instruction.trim().split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!first || first === instruction.trim()) return undefined;
  return first.length > 40 ? first.slice(0, 40) + "…" : first;
}

export class TaskSupervisor {
  private tasks = new Map<string, Task>();
  private idempotency = new Map<string, string>(); // key -> taskId
  /** 墓碑集(2026-10-19「删不掉」根治):删除过的任务 id。内存侧只有 tasks Map 时,运行中任务
   * 的后续 setState / 重启 restore 都能把已删任务塞回 Map;墓碑是删除的唯一权威,入队路径一律先查。 */
  private tombstones = new Set<string>();
  private listeners = new Set<TaskListener>();
  private opts: TaskSupervisorOptions;

  constructor(opts: Partial<TaskSupervisorOptions> = {}) {
    this.opts = {
      maxConcurrent: opts.maxConcurrent ?? 4,
      maxConcurrentPerOwner: opts.maxConcurrentPerOwner ?? 2,
      maxConcurrentSystem: opts.maxConcurrentSystem ?? 2,
    };
  }

  onChange(l: TaskListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(task: Task) {
    for (const l of this.listeners) l(task);
  }

  /** 提交任务。幂等:同 key 返回已有任务。 */
  submit(
    kind: TaskKind,
    sessionId: string,
    instruction: string,
    extra: Partial<Pick<Task, "targetNode" | "resourceTags" | "idempotencyKey" | "credentialRef" | "projectId" | "title" | "attachments" | "group">> = {},
  ): Task {
    if (extra.idempotencyKey) {
      const existingId = this.idempotency.get(extra.idempotencyKey);
      if (existingId) {
        const existing = this.tasks.get(existingId);
        if (existing) return existing;
      }
    }
    const task: Task = {
      id: randomUUID(),
      sessionId,
      instruction,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // 短标题派生(step-042,ZCode deriveSessionTitle 裁剪):首 40 字符;显式 title 覆盖。
      title: extra.title ?? deriveTitle(instruction),
      ...extra,
    };
    this.tasks.set(task.id, task);
    if (task.idempotencyKey) this.idempotency.set(task.idempotencyKey, task.id);
    this.emit(task);
    this.drain();
    // drain 可能已把它推到 running(换了新对象),返回 map 里的最新态,
    // 不能把 drain 前的快照给调用者(R1 审计 C3/C4)。
    return this.tasks.get(task.id)!;
  }

  /** 尝试把排队任务推进到 running(受并发上限约束)。 */
  drain(): void {
    const running = [...this.tasks.values()].filter((t) => t.state === "running");
    const runningSystem = running.filter((t) => this.kindOf(t) === "system").length;
    const runningUser = running.length - runningSystem;

    const perOwner = new Map<string, number>();
    for (const t of running) perOwner.set(t.sessionId, (perOwner.get(t.sessionId) ?? 0) + 1);

    const queued = [...this.tasks.values()]
      .filter((t) => t.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt); // 先进先出

    for (const task of queued) {
      if (running.length >= this.opts.maxConcurrent) break;
      const kind = this.kindOf(task);
      if (kind === "system") {
        if (runningSystem >= this.opts.maxConcurrentSystem) continue;
      } else {
        const ownerCount = perOwner.get(task.sessionId) ?? 0;
        if (ownerCount >= this.opts.maxConcurrentPerOwner) continue;
      }
      this.setState(task, "running");
      if (kind === "system") {
        // systemRunning 计数在下轮 drain 重新算
      }
      perOwner.set(task.sessionId, (perOwner.get(task.sessionId) ?? 0) + 1);
      running.push(task);
    }
  }

  /** 任务推进到终态/阻塞。墓碑命中的任务不再回写登记表(已删任务不能被在跑的执行链复活)。 */
  setState(task: Task, to: TaskState, result?: string): Task {
    const next = transition(task, to, result);
    if (this.tombstones.has(task.id)) return next;
    this.tasks.set(task.id, next);
    this.emit(next);
    if (TERMINAL_STATES.has(to)) this.drain(); // 释放一个位置,尝试调度下一个
    return next;
  }

  /**
   * 宕机恢复:批量装载任务登记表(不发变更事件、不触发调度)。
   * 非终态任务=被重启打断,收编为 cancelled 并注明原因。
   * 2026-10-19 用户实报修复(侧栏历史会话时间全变「刚刚」):**收编不得篡改 updatedAt**——
   * 原实现写 Date.now(),且不落 journal,导致每次重启僵尸任务时间戳被刷成启动时刻,
   * 历史会话在侧栏集体显示「刚刚」。时间戳是事实,收编只改状态+注明原因,时间保持原值。
   * 返回被收编的任务列表(调用方据此回写 journal 终态,防下次重启重复收编)。
   */
  /** 非终态原样注入(2026-10-21 会话 worker 专用):restore 会把非终态强翻 cancelled(重启收编
   *  语义),worker 需要「同 id+queued」入表走正常状态机(queued→running 合法迁移);
   *  墓碑命中仍拒(已删任务不可复活)。终态入参直接原样入表(与 restore 终态分支同)。 */
  inject(task: Task): Task {
    if (this.tombstones.has(task.id)) throw new Error(`任务 ${task.id} 已删除,不可注入`);
    this.tasks.set(task.id, { ...task });
    if (task.idempotencyKey) this.idempotency.set(task.idempotencyKey, task.id);
    return this.tasks.get(task.id)!;
  }

  restore(tasks: Task[], opts?: { receipt?: (t: Task) => string; userStopped?: (t: Task) => boolean }): Task[] {
    const collected: Task[] = [];
    for (const t of tasks) {
      if (this.tombstones.has(t.id)) continue; // 墓碑命中:已删除任务不得回填(重启回放复活根治)
      // 2026-11-05 状态机恢复语义(11-04 三次 OOM 实锤痛点):
      //  - queued=尚未开始,重启不是它的"中断":原样入表等 drain 重排队(不收编、不改写、不回写 journal);
      //  - running/blocked=被外因打断:语义诚实标 interrupted(非人为取消),可续跑;回执带原任务 id+sessionId;
      //  - interrupted(上次重启已收编)幂等原样保留,不重复收编;
      //  - 2026-10-19 教训保留:不篡改 updatedAt(时间戳是事实,收编只改状态+注明原因)。
      let finalTask: Task = t;
      if (!TERMINAL_STATES.has(t.state) && t.state !== "interrupted" && t.state !== "queued") {
        // M34:用户已停止(running/blocked 且会话在任务创建后有停止标记)→ 收编 cancelled,
        // 结果注明「用户已停止」;不得写成 interrupted(否则面板一键续跑/自动恢复会复活它)。
        const stopped = opts?.userStopped?.(t) === true;
        finalTask = {
          ...t,
          state: stopped ? "cancelled" : "interrupted",
          result: stopped
            ? `用户已停止(原任务书 ${t.id} / 会话 ${t.sessionId};不自动续跑)`
            : opts?.receipt
              ? opts.receipt(t)
              : `网关重启中断(原任务书 ${t.id} / 会话 ${t.sessionId};可续跑)`,
        };
      }
      if (finalTask !== t) collected.push(finalTask);
      this.tasks.set(finalTask.id, finalTask);
      if (finalTask.idempotencyKey) this.idempotency.set(finalTask.idempotencyKey, finalTask.id);
    }
    return collected;
  }

  /**
   * 续跑 interrupted 任务(2026-11-05 状态机恢复,两级恢复的共用内核):
   * 复用幂等 submit 重提同 session 续跑指令;idempotencyKey=resume:<原id>——自动恢复与面板一键
   * 共用同一键,并发/双击/跨重启重入都命中同一新任务,天然不双跑。
   * 原任务转 cancelled(interrupted→cancelled 合法迁移,"被续跑替代"而非"被取消")。
   * legacy:旧版清算成 cancelled 且 result 含「重启中断」的存量任务同样可续跑(已是终态,只重提不迁移)。
   * buildInstruction 由调用方注入:自动恢复带 journal 步数,面板一键带原任务书。
   */
  resumeInterrupted(id: string, buildInstruction: (t: Task) => string): Task | undefined {
    // 幂等先行(2026-11-05):同任务已续跑过(双击/重连/自动+手动竞争)→直接返回既有新任务。
    // 必须在状态判定之前:首次续跑后原任务已转 cancelled(result=已续跑→…),走 legacy 判定会误拒。
    const priorId = this.idempotency.get(`resume:${id}`);
    if (priorId) {
      const prior = this.tasks.get(priorId);
      if (prior) return prior;
    }
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const legacy = t.state === "cancelled" && /重启中断/.test(t.result ?? "");
    if (t.state !== "interrupted" && !legacy) return undefined;
    const nt = this.submit(
      this.kindOf(t),
      t.sessionId,
      buildInstruction(t),
      {
        idempotencyKey: `resume:${t.id}`,
        projectId: t.projectId,
        title: `续跑:${t.title ?? t.instruction.slice(0, 20)}`,
        ...(t.attachments ? { attachments: t.attachments } : {}),
      },
    );
    // 原任务收口:仍 interrupted 才迁移(重入时已 cancelled,跳过——cancelled→cancelled 非法)。
    const cur = this.tasks.get(t.id);
    if (cur && cur.state === "interrupted") {
      this.setState(cur, "cancelled", `已续跑→新任务 ${nt.id}`);
    }
    return nt;
  }

  /**
   * 自动恢复窗(env GENIE_AUTORESUME_MINUTES,缺省=关):重启后对「中断发生在窗内」的 interrupted
   * 任务自动重提。窗口以中断时刻(updatedAt)计:网关死后 N 分钟内完成重启的才自动恢复——
   * 陈年中断(早已被人工处理或放弃)不自动重提,留面板一键。
   */
  autoResumeInterrupted(opts: { windowMs: number; now?: number; buildInstruction: (t: Task) => string; blocked?: (t: Task) => boolean }): Task[] {
    const now = opts.now ?? Date.now();
    const out: Task[] = [];
    for (const t of [...this.tasks.values()]) {
      if (t.state !== "interrupted") continue;
      if (opts.blocked?.(t)) continue; // M34:用户停止过的会话不再自动续跑
      if (now - (t.updatedAt ?? t.createdAt) > opts.windowMs) continue;
      const nt = this.resumeInterrupted(t.id, opts.buildInstruction);
      if (nt) out.push(nt);
    }
    return out;
  }

  /** 保留期(step-005 二期能力收口):终态且超期(非置顶)清除;返回清除数。days≤0=不启用。
   * 2026-10-19「删不掉」配套:保留期清理与面板删除同属删除路径,必须一并登记墓碑
   * (code_review findings:此前直接 tasks.delete 绕开墓碑,journal 里 task.* 快照仍在,重启即复活)。
   * 返回被清理任务快照,调用方据此落 task.deleted。 */
  applyRetentionTasks(days: number): Task[] {
    if (!Number.isFinite(days) || days <= 0) return [];
    const cutoff = Date.now() - days * 86_400_000;
    const out: Task[] = [];
    for (const t of [...this.tasks.values()]) {
      if (!TERMINAL_STATES.has(t.state)) continue;
      if (t.pinned) continue;
      if ((t.updatedAt ?? t.createdAt) > cutoff) continue;
      const d = this.delete(t.id);
      if (d) out.push(d);
    }
    return out;
  }

  /** 保留期兼容入口(返回清除数;内部走 applyRetentionTasks,墓碑语义一致)。 */
  applyRetention(days: number): number {
    return this.applyRetentionTasks(days).length;
  }

  /** ---- F3 任务行操作(ZCode TaskListItemContextMenu 移植):正交元数据,不改状态机 ---- */
  rename(id: string, title: string): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    // step-165 gaps3.1/3.2(ref taskIndexRepo.ts:1328 agent 只管核心标题+session-mgmt.ts:132-136 用户侧
    // 不冲 agent 时间线):rename 不再把 updatedAt 推成 now(旧会话不因重命名被顶到最新);
    // titleCustom 标记=用户改名粘性,面板据此免被后续任务派生标题顶掉;空 title=清除标记回默认派生。
    const next: Task = { ...t, title: title.trim() || undefined, updatedAt: t.updatedAt, ...(title.trim() ? { titleCustom: true } : { titleCustom: undefined }) };
    this.tasks.set(id, next);
    this.emit(next);
    return next;
  }

  /** F3 自定义分组(用户桶;null=移出)。 */
  setGroup(id: string, group: string | null): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const next: Task = { ...t, group: group || undefined, updatedAt: t.updatedAt };
    this.tasks.set(id, next);
    this.emit(next);
    return next;
  }

  setPinned(id: string, pinned: boolean): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const next: Task = { ...t, pinned: pinned || undefined, updatedAt: t.updatedAt };
    this.tasks.set(id, next);
    this.emit(next);
    return next;
  }

  setArchived(id: string, archived: boolean): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const next: Task = { ...t, archived: archived || undefined, updatedAt: t.updatedAt };
    this.tasks.set(id, next);
    this.emit(next);
    return next;
  }

  /** 清除某项目全部任务的 projectId 引用(项目移除后的关联引用清理,2026-10-14「已移除项目」残留根治)。
   * 静默变更不 emit:终态任务若重 emit,通用落 journal 监听会以同 kind(task.done 等)重复计数,
   * 且幂等键(task.<id>.<state>)命中去重导致纠偏不落盘——持久化由调用方落专用事件(见 server.ts/app.ts)。
   * updatedAt 不动(与 rename 同拍):清引用不是任务活动,不应把旧会话顶到列表最新。 */
  clearProjectRef(projectId: string): Task[] {
    const touched: Task[] = [];
    for (const [id, t] of [...this.tasks]) {
      if (t.projectId !== projectId) continue;
      const next: Task = { ...t };
      delete next.projectId;
      this.tasks.set(id, next);
      touched.push(next);
    }
    return touched;
  }

  /** 删除任务(step-042;幂等,幂等键与登记一并清)。
   * 2026-10-19「删不掉」根治:删除同时登记墓碑——① 在跑任务的后续 setState 不得把它塞回 Map;
   * ② 重启回放时 restore 跳过;③ 返回被删任务快照给调用方落 task.deleted 事件(持久化删除意图)。
   * 删掉的是 running 任务时必须 drain:并发槽是靠 running 计数算的,不补一次调度排队任务会一直卡到
   * 下一个无关的 drain 触发点(code_review 2026-10-19 findings:删运行中任务释放槽却不 drain)。 */
  delete(id: string): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.idempotencyKey) this.idempotency.delete(t.idempotencyKey);
    this.tasks.delete(id);
    this.tombstones.add(id);
    if (t.state === "running") this.drain();
    return t;
  }

  /** 会话级批量删除(侧栏一行=一个会话,删单条撑不住整行):删除该会话全部任务,返回被删快照。 */
  deleteSession(sessionId: string): Task[] {
    const victims = [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
    const gone = victims.map((t) => this.delete(t.id)).filter((t): t is Task => !!t);
    return gone;
  }

  /** 墓碑回填(启动回放用):journal 里 task.deleted 事件声明的已删 id,先于 restore 注入,
   * 让回放重建直接跳过——不从 journal 里认墓碑就不能防复活。 */
  markDeleted(ids: Iterable<string>): void {
    for (const id of ids) this.tombstones.add(id);
  }

  /** 墓碑快照(只读,测试与诊断用)。 */
  deletedIds(): string[] {
    return [...this.tombstones];
  }

  /** 批量清空归档(step-042,ZCode DeleteAllArchivedTasks 等价);返回被删快照。 */
  clearArchived(): Task[] {
    const out: Task[] = [];
    for (const [id, t] of [...this.tasks]) {
      if (!t.archived) continue;
      const d = this.delete(id);
      if (d) out.push(d);
    }
    return out;
  }

  /**
   * 汇报任务进展(2026-11 token 轮):只写 `progress` 元数据,不改状态机。
   * 语义:**不复活、不重建**——任务不存在或墓碑命中一律返回 undefined(已删任务的在跑执行链
   * 后续 touch 不得把它塞回 Map);**不改 state / updatedAt / startedAt**(与 restore 收编同纪律:
   * 时间戳与状态是事实,进展只是旁注);写回新对象(不可变风格,与 setState 一致)并发 emit,
   * 让面板/会话行拿到最新态。合并口径=`{...prev.progress, ...patch 中非 undefined 的键}`,
   * 缺省 `at=Date.now()`(仅当 patch 未给)。
   */
  touch(
    taskId: string,
    patch: { phase?: string; step?: number; note?: string; at?: number },
  ): Task | undefined {
    if (this.tombstones.has(taskId)) return undefined;
    const prev = this.tasks.get(taskId);
    if (!prev) return undefined;
    const delta: { phase?: string; step?: number; note?: string; at: number } = { at: Date.now() };
    if (patch.phase !== undefined) delta.phase = patch.phase;
    if (patch.step !== undefined) delta.step = patch.step;
    if (patch.note !== undefined) delta.note = patch.note;
    if (patch.at !== undefined) delta.at = patch.at;
    const next: Task = { ...prev, progress: { ...prev.progress, ...delta } };
    this.tasks.set(taskId, next);
    this.emit(next);
    return next;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(filter: { state?: TaskState; sessionId?: string } = {}): Task[] {
    return [...this.tasks.values()].filter(
      (t) =>
        (filter.state === undefined || t.state === filter.state) &&
        (filter.sessionId === undefined || t.sessionId === filter.sessionId),
    );
  }

  /** 简化:用 instruction 前缀区分 system("sys:" 开头)。 */
  private kindOf(task: Task): TaskKind {
    return task.instruction.startsWith("sys:") ? "system" : "user";
  }
}
