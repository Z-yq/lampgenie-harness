/**
 * 生产定时任务调度器(gateway 侧驱动面)。
 * 职责边界:
 * - 任务内容门/发生身份/终态语义都在 runtime 的 TaskSupervisor(createScheduled/start)里;
 * - 本服务只做「due 扫描 → occurrence claim 单飞 → start → 终态观察 → recurring 重排」的循环,
 * 以及 stop/stats 生命周期。30s tick,interval unref(不阻止进程退出)。
 * 关键口径:
 * - claim 先于 start:同一 (job, 计划瞬间) 在一个进程里只起跑一次;claim 失败(已完成/已被认领)
 * 或已在本进程 inFlight 集合里 → 跳过,绝不重复启动。
 * - recurring 任务完成后按 nextRunAt(系列锚点, recurrence, {now}) 排下一次,seriesId 继承;
 * once 不重建。scheduledNext 集合防同一 next instant 被重复建两次。
 * - 单个任务抛错不影响其它任务(fail-soft),错误进 onEvent/journal 由装配方决定。
 */

import { OccurrenceLedger, occurrenceKey } from '@lampgenie/runtime/task/occurrence'
import { nextRunAt, tidyRecurrence, tidyTimeZone } from '@lampgenie/runtime/task/recurrence'

export interface ScheduledTaskSnapshot {
  readonly id: string
  readonly status?: string
  readonly objective?: string
  readonly kind?: string
  readonly seriesId?: string | null
  readonly sessionId?: string
  readonly ownerId?: string
  readonly projectId?: string
  readonly result?: string | null
  readonly completedAt?: number | null
  readonly recurrenceStartAt?: number | null
  readonly schedule?: {
    readonly at?: number
    readonly scheduledInstant?: number
    readonly occurrenceKey?: string
    readonly recurrence?: string
    readonly timeZone?: string
  } | null
  readonly mode?: string
  readonly preRun?: { readonly command?: string } | null
  readonly contextFrom?: {
    readonly taskId?: string | null
    readonly sessionId?: string | null
    readonly maxChars?: number
  } | null
  readonly continuity?: { readonly maxChars?: number } | boolean | null
  readonly [key: string]: unknown
}

/** 管理器窄接口:runtime TaskSupervisor 满足;测试可注入假实现。 */
export interface ScheduledTaskManagerLike {
  list(filter?: {
    ownerId?: string
    sessionId?: string
    active?: boolean
    scope?: string
  }): Array<Record<string, unknown> & { id?: string }>
  get(id: string, options?: Record<string, unknown>): Record<string, unknown> | null
  start(task: string | Record<string, unknown>): unknown
  createScheduled(options: Record<string, unknown>): Record<string, unknown> & {
    error?: string
    issues?: readonly string[]
  }
  cancel?(id: string, options?: Record<string, unknown>): Promise<unknown> | unknown
}

export interface ScheduleRequest {
  instruction?: string
  objective?: string
  at?: number
  recurrence?: string
  timeZone?: string
  mode?: string
  preRun?: unknown
  contextFrom?: unknown
  continuity?: unknown
  title?: string
  sessionId?: string
  ownerId?: string
  projectId?: string | null
 /** runtime createScheduled 的 type:task=跑模型,reminder=只落提醒(缺省 task)。 */
  type?: 'task' | 'reminder'
}

export type ScheduleEventType =
  | 'tick'
  | 'start'
  | 'skip'
  | 'complete'
  | 'failed'
  | 'recur'
  | 'error'

export interface ScheduleEvent {
  readonly at: number
  readonly type: ScheduleEventType
  readonly taskId?: string
  readonly occurrenceKey?: string
  readonly detail?: string
}

export interface ScheduledTaskServiceOptions {
  taskManager: ScheduledTaskManagerLike
  now?: () => number
  tickMs?: number
  onEvent?: (event: ScheduleEvent) => void
 /** claim 账本的 owner 标识(缺省进程内随机串;测试可注入固定值)。 */
  ownerId?: string
}

interface InFlightOccurrence {
  readonly taskId: string
  readonly jobId: string
  readonly instant: number
  readonly key: string
}

interface ServiceStats {
  ticks: number
  due: number
  started: number
  skipped: number
  completed: number
  failed: number
  scheduledNext: number
  errors: number
}

const MAX_SCHEDULED_NEXT_MEMORY = 500

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export class ScheduledTaskService {
  private readonly ledger = new OccurrenceLedger()
  private readonly ownerId: string
  private readonly inFlight = new Map<string, InFlightOccurrence>()
  private readonly scheduledNext = new Set<string>()
  private readonly counters: ServiceStats = {
    ticks: 0,
    due: 0,
    started: 0,
    skipped: 0,
    completed: 0,
    failed: 0,
    scheduledNext: 0,
    errors: 0,
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(private readonly options: ScheduledTaskServiceOptions) {
    if (!options || !options.taskManager) {
      throw new Error('ScheduledTaskService 需要 taskManager')
    }
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.tickMs = Math.max(100, numberOr(options.tickMs, 30_000))
    this.ownerId = String(options.ownerId || `scheduled_service_${Math.random().toString(36).slice(2)}`)
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null
  }

  private readonly now: () => number
  private readonly tickMs: number
  private readonly onEvent: ((event: ScheduleEvent) => void) | null

 /** 创建一条定时任务;内容门拒收时原样返回 {error, issues}(不建任务)。 */
  schedule(request: ScheduleRequest): Record<string, unknown> & {
    error?: string
    issues?: readonly string[]
  } {
    const instruction = String(request?.instruction ?? request?.objective ?? '').trim()
    const at = Number(request?.at)
    if (!Number.isFinite(at)) {
      return { error: 'INVALID', issues: Object.freeze(['at 必须是毫秒时间戳']) }
    }
    return this.options.taskManager.createScheduled({
      objective: instruction,
      ownerId: String(request.ownerId || request.sessionId || this.ownerId),
      sessionId: String(request.sessionId || 'main'),
      projectId: request.projectId || null,
      schedule: {
        at,
        recurrence: request.recurrence || 'once',
        timeZone: request.timeZone || null,
      },
      type: request.type || 'task',
      mode: request.mode,
      preRun: request.preRun,
      contextFrom: request.contextFrom,
      continuity: request.continuity,
    })
  }

  async cancel(taskId: string): Promise<unknown> {
    const manager = this.options.taskManager
    if (typeof manager.cancel !== 'function') return null
    return manager.cancel(String(taskId))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
 /* tick 本身 fail-soft:外层定时器不能因单轮异常停摆 */
      }
    }, this.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stats(): ServiceStats & { inFlight: number; tickMs: number } {
    return {
      ...this.counters,
      inFlight: this.inFlight.size,
      tickMs: this.tickMs,
    }
  }

 /** 一轮扫描:先观察在飞任务的终态,再派发本轮到期的计划发生。 */
  tick(nowInput?: number): void {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Number.isFinite(Number(nowInput)) ? Number(nowInput) : this.now()
      this.counters.ticks += 1
      this.#sweepInFlight(now)
      const due = this.#dueTasks(now)
      this.counters.due += due.length
      for (const task of due) this.#fire(task, now)
      this.#emit({ at: now, type: 'tick', detail: `due=${due.length}` })
    } finally {
      this.ticking = false
    }
  }

  #emit(event: ScheduleEvent): void {
    if (!this.onEvent) return
    try {
      this.onEvent(event)
    } catch {
 /* 观测回调失败不影响调度 */
    }
  }

  #dueTasks(now: number): ScheduledTaskSnapshot[] {
    const rows = this.options.taskManager.list({ scope: 'all' })
    const due: ScheduledTaskSnapshot[] = []
    for (const row of rows) {
      const snapshot = row as unknown as ScheduledTaskSnapshot
      if (String(snapshot.status) !== 'scheduled') continue
      if (numberOr(snapshot.schedule?.at, Number.POSITIVE_INFINITY) > now) continue
      due.push(snapshot)
    }
    return due.sort((left, right) => (
      numberOr(left.schedule?.at, 0) - numberOr(right.schedule?.at, 0)
      || String(left.id).localeCompare(String(right.id))
    ))
  }

  #fire(task: ScheduledTaskSnapshot, now: number): void {
    const schedule = task.schedule || {}
    const jobId = String(task.seriesId || task.id)
    const instant = numberOr(schedule.scheduledInstant ?? schedule.at, NaN)
    const key = String(schedule.occurrenceKey || occurrenceKey(jobId, instant))
    if (!key || !Number.isFinite(instant)) {
      this.counters.skipped += 1
      this.#emit({ at: now, type: 'skip', taskId: task.id, detail: 'occurrence-key-missing' })
      return
    }
 // 本进程单飞:上一次 tick 已认领但还没终态的发生不再重复起跑。
    if (this.inFlight.has(key)) {
      this.counters.skipped += 1
      this.#emit({ at: now, type: 'skip', taskId: task.id, occurrenceKey: key, detail: 'in-flight' })
      return
    }
    const claim = this.ledger.claim(jobId, instant, { ownerId: this.ownerId, at: now })
    if (!claim.ok) {
      this.counters.skipped += 1
      this.#emit({
        at: now,
        type: 'skip',
        taskId: task.id,
        occurrenceKey: key,
        detail: claim.code,
      })
      return
    }
    this.inFlight.set(key, { taskId: task.id, jobId, instant, key })
    try {
      this.options.taskManager.start(task.id)
      this.counters.started += 1
      this.#emit({
        at: now,
        type: 'start',
        taskId: task.id,
        occurrenceKey: key,
        detail: String(task.objective || '').slice(0, 120),
      })
    } catch (error) {
 // 单任务启动失败:释放认领让下一轮可重试,不影响本 tick 其它任务。
      this.inFlight.delete(key)
      this.ledger.release(jobId, instant)
      this.counters.errors += 1
      this.#emit({
        at: now,
        type: 'error',
        taskId: task.id,
        occurrenceKey: key,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  #sweepInFlight(now: number): void {
    for (const [key, flight] of [...this.inFlight.entries()]) {
      let current: Record<string, unknown> | null = null
      try {
 // TaskSupervisor.get 的 scope 缺省=user(只有 list 支持 'all'),这里按缺省取。
        current = this.options.taskManager.get(flight.taskId)
      } catch {
        current = null
      }
      if (!current) {
 // 任务被删/不可见:释放认领,避免永久占住这次发生。
        this.inFlight.delete(key)
        this.ledger.release(flight.jobId, flight.instant)
        this.counters.skipped += 1
        continue
      }
      const status = String(current.status || '')
      if (status === 'completed') {
        this.inFlight.delete(key)
        this.ledger.complete(flight.jobId, flight.instant, { status: 'completed', at: now })
        this.counters.completed += 1
        this.#emit({
          at: now,
          type: 'complete',
          taskId: flight.taskId,
          occurrenceKey: key,
        })
        this.#scheduleNext(current as unknown as ScheduledTaskSnapshot, now)
      } else if (status === 'failed' || status === 'cancelled') {
        this.inFlight.delete(key)
        if (status === 'failed') {
          this.ledger.complete(flight.jobId, flight.instant, { status: 'failed', at: now })
        } else {
          this.ledger.release(flight.jobId, flight.instant)
        }
        this.counters.failed += 1
        this.#emit({
          at: now,
          type: 'failed',
          taskId: flight.taskId,
          occurrenceKey: key,
          detail: status,
        })
 // failed 只跳过「本次发生」,不终止系列:pre_run 不满足/临时失败后下一次照常排。
 // cancelled 是用户意图停止,不重建。
        if (status === 'failed') {
          this.#scheduleNext(current as unknown as ScheduledTaskSnapshot, now)
        }
      }
    }
  }

 // recurring 完成后排下一次:seriesId 继承、内容门字段原样带过去;once 不重建。
  #scheduleNext(task: ScheduledTaskSnapshot, now: number): void {
    const schedule = task.schedule || {}
    const recurrence = tidyRecurrence(schedule.recurrence)
    if (recurrence === 'once') return
    const anchor = numberOr(task.recurrenceStartAt, numberOr(schedule.at, NaN))
    if (!Number.isFinite(anchor)) return
    const timeZone = schedule.timeZone || 'UTC'
    const nextAt = nextRunAt(anchor, recurrence, { now, timeZone: tidyTimeZone(timeZone) })
    if (!Number.isFinite(Number(nextAt))) return
    const nextInstant = Number(nextAt)
    const key = occurrenceKey(String(task.seriesId || task.id), nextInstant)
    if (!key || this.scheduledNext.has(key)) return
    this.scheduledNext.add(key)
    if (this.scheduledNext.size > MAX_SCHEDULED_NEXT_MEMORY) {
 // 只保留最近的一批;Set 迭代序=插入序,淘汰最旧。
      const oldest = this.scheduledNext.values().next().value
      if (typeof oldest === 'string') this.scheduledNext.delete(oldest)
    }
    try {
      const created = this.options.taskManager.createScheduled({
        objective: String(task.objective || ''),
        ownerId: String(task.ownerId || ''),
        sessionId: String(task.sessionId || 'main'),
        projectId: task.projectId || null,
        schedule: { at: nextInstant, recurrence, timeZone },
        type: String(task.kind || '') === 'reminder' ? 'reminder' : 'task',
        seriesId: task.seriesId || null,
        recurrenceStartAt: anchor,
        scheduledInstant: nextInstant,
        mode: task.mode,
        preRun: task.preRun,
        contextFrom: task.contextFrom,
        continuity: task.continuity,
      })
      if (created && created.error) {
        this.counters.errors += 1
        this.#emit({
          at: now,
          type: 'error',
          taskId: task.id,
          detail: `next-occurrence-rejected:${String(created.error)}`,
        })
        return
      }
      this.counters.scheduledNext += 1
      this.#emit({
        at: now,
        type: 'recur',
        taskId: task.id,
        occurrenceKey: key,
        detail: `next=${nextInstant}`,
      })
    } catch (error) {
      this.counters.errors += 1
      this.#emit({
        at: now,
        type: 'error',
        taskId: task.id,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
