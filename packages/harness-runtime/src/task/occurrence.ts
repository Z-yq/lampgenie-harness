// 定时任务的「发生身份」(occurrence identity):一次计划中的发生 = 作业(job) × 计划瞬间
// (scheduled instant),与派发(dispatch)时间戳无关。
// 为什么 occurrence 身份不能用派发时间戳:
// - tick 的派发时刻受事件循环、队列、进程启停影响,同一次计划发生可能在不同时刻被派发;
// 拿派发时间戳当身份,重启后就认不出「这次发生已经做过」,会重复执行。
// - 更糟的是 tick 若「先推进 next_run 再派发」:进程在两步之间死掉,next_run 已推进、
// 派发却没发生,这次发生就永久丢失。身份必须由 plan 侧 (job, scheduledInstant) 派生,
// 跨重启逐字一致;状态转移全部落到独立账本——先 claim 再推进 next_run,claim 成功才
// pop pending slot,进程死掉时未完成的认领可在重启后由 owner 回收重跑。
// 本模块为零 IO 纯逻辑:不抛异常、不读时钟(时间一律由调用方注入)、除账本内部状态外不可变。

export type OccurrenceStatus = 'claimed' | 'completed' | 'failed' | 'pruned'

export interface OccurrenceEntry {
  readonly key: string
  readonly jobId: string
  readonly instant: number
  readonly status: OccurrenceStatus
  readonly ownerId: string | null
  readonly claimedAt: number | null
  readonly settledAt: number | null
}

export interface OccurrenceLedgerSnapshot {
  readonly version: 1
  readonly entries: ReadonlyArray<OccurrenceEntry>
}

export type ClaimCode = 'CLAIMED' | 'ALREADY_COMPLETED' | 'ALREADY_CLAIMED'

export interface ClaimResult {
  readonly ok: boolean
  readonly code: ClaimCode
  readonly key: string
}

export type CompleteCode =
  | 'COMPLETED'
  | 'RECORDED'
  | 'ALREADY_COMPLETED'
  | 'RELEASED'
  | 'INVALID'

export interface CompleteOptions {
  status: 'completed' | 'failed' | 'pruned'
  at?: number
  manual?: boolean
}

export interface CompleteResult {
  readonly ok: boolean
  readonly code: CompleteCode
  readonly key: string
  readonly recorded: boolean
  readonly stamped: boolean
}

export interface DueClassification {
  run: number[]
  skippedCompleted: number[]
  skippedClaimed: number[]
}

export interface LedgerStats {
  total: number
  claimed: number
  completed: number
  failed: number
  pruned: number
  owners: number
}

export type PendingSlotAction = 'fire' | 'wait' | 'catch-up'

export interface PendingSlotDecision {
  action: PendingSlotAction
  instant: number | null
}

// 「跨重启/长停后补跑」的判据阈值:到期超过该宽限仍未被认领,视作补跑(catch-up);
// 只补最新一次 due instant,更早的错过发生不枚举、不重放。
export const CATCH_UP_SLACK_MS = 60_000

const STATUS_RANK: Record<OccurrenceStatus, number> = {
  completed: 3,
  claimed: 2,
  failed: 1,
  pruned: 0,
}

// 稳定身份:job + 计划瞬间。非法输入返回空串(fail-closed:宁可跳过也不重复执行)。
export function occurrenceKey(
  jobId: string | number | null | undefined,
  scheduledInstant: number | string | null | undefined): string {
  const job = String(jobId ?? '').trim()
  const instant = Number(scheduledInstant)
  if (!job || !Number.isFinite(instant)) return ''
  return `${job}@${instant}`
}

// 从 key 取回 instant(只用于同 job 的 keys 与 dueInstants 对齐)。
function instantOfKey(key: string): number {
  const text = String(key ?? '')
  const at = text.lastIndexOf('@')
  return at >= 0 ? Number(text.slice(at + 1)) : NaN
}

function settledAtOf(at: number | undefined): number {
  const parsed = Number(at)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 把到期瞬间分成「该跑 / 已完成跳过 / 已被认领跳过」。
 * completed 只认 status="completed" 的账本条目(由调用方从账本投影得到 completedKeys);
 * 未知或 failed 一律不算完成。同一 instant 重复出现只算一次。
 */
export function classifyDueOccurrences({
  dueInstants = [],
  completedKeys = [],
  claimedKeys = [],
}: {
  dueInstants?: ReadonlyArray<number | string>
  completedKeys?: ReadonlyArray<string>
  claimedKeys?: ReadonlyArray<string>
} = {}): DueClassification {
  const completedInstants = new Set(
    completedKeys.map(instantOfKey).filter(Number.isFinite),
  )
  const claimedInstants = new Set(
    claimedKeys.map(instantOfKey).filter(Number.isFinite),
  )
  const run: number[] = []
  const skippedCompleted: number[] = []
  const skippedClaimed: number[] = []
  const seen = new Set<number>()
  for (const raw of dueInstants) {
    const instant = Number(raw)
    if (!Number.isFinite(instant) || seen.has(instant)) continue
    seen.add(instant)
    if (completedInstants.has(instant)) skippedCompleted.push(instant)
    else if (claimedInstants.has(instant)) skippedClaimed.push(instant)
    else run.push(instant)
  }
  return { run, skippedCompleted, skippedClaimed }
}

/**
 * 发生账本(内存态,可快照/恢复)。语义:
 * - claim 前先查 completed,再 CAS 认领;failed/pruned 记录不阻止重试;
 * - complete 只在 status="completed" 且非 manual 时 stamp 完成;
 * - release / recoverOwner 把认领退回「未认领」(可再次 claim);recoverOwner 幂等。
 */
export class OccurrenceLedger {
  #entries = new Map<string, OccurrenceEntry>()

  get size(): number {
    return this.#entries.size
  }

  claim(
    jobId: string | number | null | undefined,
    instant: number | string | null | undefined,
    { ownerId = '', at = 0 }: { ownerId?: string; at?: number } = {},
  ): ClaimResult {
    const key = occurrenceKey(jobId, instant)
 // 身份不可用:承认领会造出无法对账的条目,直接判「已被认领」让调用方跳过。
    if (!key) return { ok: false, code: 'ALREADY_CLAIMED', key }
    const existing = this.#entries.get(key)
    if (existing?.status === 'completed') {
      return { ok: false, code: 'ALREADY_COMPLETED', key }
    }
    if (existing?.status === 'claimed') {
      return { ok: false, code: 'ALREADY_CLAIMED', key }
    }
    this.#entries.set(key, Object.freeze({
      key,
      jobId: String(jobId),
      instant: Number(instant),
      status: 'claimed' as const,
      ownerId: String(ownerId || ''),
      claimedAt: settledAtOf(at),
      settledAt: null,
    }))
    return { ok: true, code: 'CLAIMED', key }
  }

  complete(
    jobId: string | number | null | undefined,
    instant: number | string | null | undefined,
    { status, at = 0, manual = false }: CompleteOptions): CompleteResult {
    const key = occurrenceKey(jobId, instant)
    if (!key) {
      return { ok: false, code: 'INVALID', key, recorded: false, stamped: false }
    }
    const existing = this.#entries.get(key)
    const normalized: OccurrenceStatus = status === 'completed'
      ? 'completed'
      : status === 'pruned'
        ? 'pruned'
        : 'failed'
 // manual/force 触发不是「计划发生已完成」:若 stamp 完成,手动补跑一次就会把定时槽
 // 吞掉,后续 tick 永远跳过这次发生。只回收认领,让它按原计划继续。
    if (normalized === 'completed' && manual) {
      this.#entries.delete(key)
      return { ok: true, code: 'RELEASED', key, recorded: false, stamped: false }
    }
    if (existing?.status === 'completed') {
      return { ok: true, code: 'ALREADY_COMPLETED', key, recorded: false, stamped: false }
    }
    this.#entries.set(key, Object.freeze({
      key,
      jobId: String(jobId),
      instant: Number(instant),
      status: normalized,
      ownerId: existing?.ownerId ?? null,
      claimedAt: existing?.claimedAt ?? null,
      settledAt: settledAtOf(at),
    }))
    return {
      ok: true,
      code: normalized === 'completed' ? 'COMPLETED' : 'RECORDED',
      key,
      recorded: true,
      stamped: normalized === 'completed',
    }
  }

 // 认领回收(claim 之后启动失败/被取消):退回未认领状态,下次可重试。
  release(
    jobId: string | number | null | undefined,
    instant: number | string | null | undefined): boolean {
    const key = occurrenceKey(jobId, instant)
    if (!key) return false
    const existing = this.#entries.get(key)
    if (!existing || existing.status !== 'claimed') return false
    this.#entries.delete(key)
    return true
  }

 // owner 死亡(进程重启)后的回收:只释放该 owner 的 claimed,幂等,只回收一次。
  recoverOwner(ownerId: string | null | undefined, _options: { at?: number } = {}): string[] {
    const owner = String(ownerId || '')
    if (!owner) return []
    const released: string[] = []
    for (const [key, entry] of [...this.#entries.entries()]) {
      if (entry.status !== 'claimed' || entry.ownerId !== owner) continue
      this.#entries.delete(key)
      released.push(key)
    }
    released.sort()
    return released
  }

  isCompleted(
    jobId: string | number | null | undefined,
    instant: number | string | null | undefined): boolean {
    const key = occurrenceKey(jobId, instant)
    if (!key) return false
    return this.#entries.get(key)?.status === 'completed'
  }

  statusOf(
    jobId: string | number | null | undefined,
    instant: number | string | null | undefined): OccurrenceStatus | null {
    const key = occurrenceKey(jobId, instant)
    if (!key) return null
    return this.#entries.get(key)?.status ?? null
  }

  stats(): LedgerStats {
    let claimed = 0
    let completed = 0
    let failed = 0
    let pruned = 0
    const owners = new Set<string>()
    for (const entry of this.#entries.values()) {
      if (entry.status === 'claimed') {
        claimed += 1
        if (entry.ownerId) owners.add(entry.ownerId)
      } else if (entry.status === 'completed') completed += 1
      else if (entry.status === 'failed') failed += 1
      else pruned += 1
    }
    return { total: this.#entries.size, claimed, completed, failed, pruned, owners: owners.size }
  }

 // 对同一 job 的到期列表分流(completed 只认 completed 条目)。
  classifyDue(dueInstants: ReadonlyArray<number | string>): DueClassification {
    const completedKeys: string[] = []
    const claimedKeys: string[] = []
    for (const entry of this.#entries.values()) {
      if (entry.status === 'completed') completedKeys.push(entry.key)
      else if (entry.status === 'claimed') claimedKeys.push(entry.key)
    }
    return classifyDueOccurrences({ dueInstants, completedKeys, claimedKeys })
  }

  claimedOwners(): string[] {
    const owners = new Set<string>()
    for (const entry of this.#entries.values()) {
      if (entry.status === 'claimed' && entry.ownerId) owners.add(entry.ownerId)
    }
    return [...owners].sort()
  }

  entries(): OccurrenceEntry[] {
    return [...this.#entries.values()].sort((left, right) => left.key.localeCompare(right.key))
  }

 // 单 job 的快照:任务持久化只背自己这一份,重启后合并即可。
  snapshotForJob(jobId: string | number | null | undefined): OccurrenceLedgerSnapshot {
    const job = String(jobId ?? '')
    const entries = this.entries().filter(entry => entry.jobId === job)
    return Object.freeze({ version: 1 as const, entries: Object.freeze(entries) })
  }

  toJSON(): OccurrenceLedgerSnapshot {
    return Object.freeze({ version: 1 as const, entries: Object.freeze(this.entries()) })
  }

  merge(snapshot: OccurrenceLedgerSnapshot | OccurrenceLedger | null | undefined): number {
    const source = snapshot instanceof OccurrenceLedger
      ? snapshot.toJSON()
      : snapshot
    if (!source || !Array.isArray(source.entries)) return 0
    let merged = 0
    for (const raw of source.entries) {
      if (!raw || typeof raw.key !== 'string' || !raw.key) continue
      const status = raw.status as OccurrenceStatus
      if (!(status in STATUS_RANK)) continue
      const existing = this.#entries.get(raw.key)
 // 同 key 冲突时保留语义更强的记录(completed > claimed > failed > pruned)。
      if (existing && STATUS_RANK[existing.status] >= STATUS_RANK[status]) continue
      this.#entries.set(raw.key, Object.freeze({
        key: raw.key,
        jobId: String(raw.jobId ?? ''),
        instant: Number(raw.instant),
        status,
        ownerId: raw.ownerId == null ? null : String(raw.ownerId),
        claimedAt: raw.claimedAt == null ? null : Number(raw.claimedAt),
        settledAt: raw.settledAt == null ? null : Number(raw.settledAt),
      }))
      merged += 1
    }
    return merged
  }

  static fromJSON(snapshot: OccurrenceLedgerSnapshot | null | undefined): OccurrenceLedger {
    const ledger = new OccurrenceLedger()
    ledger.merge(snapshot)
    return ledger
  }
}

/**
 * pending slot 判据(纯函数):tick 要先 claim 再推进 next_run,所以这里不 pop slot,
 * 只回答「这个 instant 该怎么处理」:
 * - claimed=false → wait:认领失败绝不 pop,slot 留待重试;
 * - claimed=true → fire:已认领,可推进 next_run 并派发;
 * - 未认领且已到期 → fire(需要调用方先 claim);到期已超过宽限 → catch-up,
 * 表示进程停过,只补这一个最新 instant(更早的错过发生不枚举)。
 * - lastFiredInstant 已覆盖 due → wait,防重复派发。
 */
export function pendingSlotDecision({
  now,
  nextRunAt,
  lastFiredInstant = null,
  claimed = null,
}: {
  now: number
  nextRunAt: number | string | null | undefined
  lastFiredInstant?: number | string | null
  claimed?: boolean | null
}): PendingSlotDecision {
  const due = Number(nextRunAt)
  if (!Number.isFinite(due)) return { action: 'wait', instant: null }
  if (claimed === false) return { action: 'wait', instant: due }
  if (claimed !== true) {
    const nowValue = Number(now)
    if (!Number.isFinite(nowValue)) return { action: 'wait', instant: due }
    if (due > nowValue) return { action: 'wait', instant: due }
    const fired = lastFiredInstant == null ? NaN : Number(lastFiredInstant)
    if (Number.isFinite(fired) && fired >= due) return { action: 'wait', instant: due }
    return {
      action: nowValue - due > CATCH_UP_SLACK_MS ? 'catch-up' : 'fire',
      instant: due,
    }
  }
 // 已认领:直接放行派发(即使 tick 晚到,认领已保证这次发生只跑一次)。
  return { action: 'fire', instant: due }
}

// manual/force 触发一律不 stamp 完成(见 OccurrenceLedger.complete)。
export function isManualTrigger(trigger: unknown): boolean {
  const mode = String(trigger ?? '').trim().toLowerCase()
  return mode === 'manual' || mode === 'force'
}

// —— 生产账本(扁平 Record<key, {status, at, owner}>)的容量与重启恢复辅助 ——
// 与 OccurrenceLedger(类形态)并存:调度器把账本序列化进 automations.json 时只需这两个纯函数。

/** 账本容量上限:只保留最近 N 个发生,超出淘汰最旧。 */
export const OCCURRENCE_RECORD_LIMIT = 50

/** 容量裁剪(纯函数,不改入参):按 at 升序淘汰最旧,同时刻按键名序;返回保留后的新对象。 */
export function pruneOccurrenceRecords<T extends { at: number }>(
  records: Record<string, T> | null | undefined,
  limit: number = OCCURRENCE_RECORD_LIMIT): Record<string, T> {
  const src = records && typeof records === 'object' ? records : {}
  const keys = Object.keys(src)
  const max = Math.floor(Number(limit))
  if (!Number.isFinite(max) || max < 0 || keys.length <= max) {
    const copy: Record<string, T> = {}
    for (const key of keys) copy[key] = src[key]!
    return copy
  }
  const ordered = keys.slice().sort((left, right) => {
    const dl = Number(src[left]?.at)
    const dr = Number(src[right]?.at)
    const al = Number.isFinite(dl) ? dl : 0
    const ar = Number.isFinite(dr) ? dr : 0
    return al === ar ? left.localeCompare(right) : al - ar
  })
  const keep = new Set(ordered.slice(ordered.length - max))
  const out: Record<string, T> = {}
  for (const key of keys) if (keep.has(key)) out[key] = src[key]!
  return out
}

/**
 * 重启恢复(纯函数,幂等):claimed 是「进程死在 submit 前」的残留,重置为 failed 让下一次
 * claim 可重试;completed 永不动,其它状态原样保留。返回新对象与恢复条数。
 */
export function recoverClaimedOccurrences<T extends { status: string; at: number }>(
  records: Record<string, T> | null | undefined): { records: Record<string, T>; recovered: number } {
  const src = records && typeof records === 'object' ? records : {}
  const out: Record<string, T> = {}
  let recovered = 0
  for (const [key, record] of Object.entries(src)) {
    if (record && record.status === 'claimed') {
      out[key] = Object.freeze({ ...record, status: 'failed' }) as T
      recovered += 1
    } else {
      out[key] = record
    }
  }
  return { records: out, recovered }
}
