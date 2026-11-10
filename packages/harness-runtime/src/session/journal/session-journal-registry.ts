// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { readdirSync } from 'node:fs'
import { stat, unlink, rmdir, utimes } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SessionLog } from './session-journal'
import { readSessionLogSync } from './session-journal-reader'
import { logRetention, latestLogTasks, needsLogRecovery, recordSize } from './session-journal-retention'
import { SessionEventType } from '../shared/session-events'

function pathSegment(value, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  // Injective and traversal-safe: unlike replacing punctuation with '_', this
  // cannot make two distinct owner/session ids share a journal directory.
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** Owns per-owner/per-session journals without coupling them to a domain model. */
export class SessionLogRegistry {
  constructor({
    directory, logger = null, retention,
    maxCachedJournals = 8, maxFiles = 256, maxTotalBytes = 128 * 1024 * 1024,
    maxAgeMs = 30 * 24 * 60 * 60 * 1000, maintenanceIntervalMs = 10 * 60 * 1000,
    maxQueuedOperations = 256, maxQueuedBytes = 16 * 1024 * 1024,
    now = () => Date.now(),
  } = {}) {
    if (!directory) throw new TypeError('directory is required')
    this.directory = resolve(directory)
    this.logger = logger
    this.journals = new Map() // cacheKey → SessionLog(LRU 触达刷新)
    this.retention = logRetention(retention)
    // 限额参数逐一显式校验:必须是 ≥1 的安全整数(写错配置早炸早好)。
    const limits = { maxCachedJournals, maxFiles, maxTotalBytes, maxAgeMs, maintenanceIntervalMs, maxQueuedOperations, maxQueuedBytes }
    for (const [name, limit] of Object.entries(limits)) {
      const valid = Number.isSafeInteger(limit) && limit >= 1
      if (!valid) throw new TypeError(`invalid journal limit ${name}`)
      this[name] = limit
    }
    this.now = now
    this.lastMaintenance = -Infinity
    this.operationQueue = Promise.resolve()
    this.queuedOperations = 0
    this.queuedBytes = 0
  }

  maintenanceDue() {
    return this.now() - this.lastMaintenance >= this.maintenanceIntervalMs
  }

  // 日志缓存键(owner\0session);与路径分段无关,纯内存索引。
  key(ownerId, sessionId) {
    return `${String(ownerId || 'personal')}\u0000${String(sessionId || 'main')}`
  }

  get(ownerId, sessionId = 'main') {
    const cacheKey = this.key(ownerId, sessionId)
    let journal = this.journals.get(cacheKey)
    if (!journal) {
      journal = this.#createJournal(ownerId, sessionId)
      this.journals.set(cacheKey, journal)
    }
    // 触达即重插(刷新 LRU 顺序),再裁剪缓存。
    this.journals.delete(cacheKey)
    this.journals.set(cacheKey, journal)
    this.trimCache(journal)
    return journal
  }

  #createJournal(ownerId, sessionId) {
    return new SessionLog({
      filePath: resolve(this.directory, pathSegment(ownerId, 'personal'), pathSegment(sessionId, 'main'), 'session.jsonl'),
      sessionId: String(sessionId || 'main'),
      metadata: { ownerId: String(ownerId || 'personal') },
      retention: this.retention,
    })
  }

  // 缓存超容时逐个淘汰:保住指定句柄与仍在飞(未落盘/未装载)的,其余从最旧开始删。
  trimCache(keep = null) {
    for (const [cacheKey, journal] of this.journals) {
      if (this.journals.size <= this.maxCachedJournals) break
      const idle = journal !== keep && !journal.pendingWrites && !journal.openPromise
      if (idle) this.journals.delete(cacheKey)
    }
  }

  // 全部写与读都过这条串行队列;计数+字节双上限,满载拒新(背压直接给调用方)。
  enqueue(operation, bytes = 0) {
    const saturated =
      this.queuedOperations >= this.maxQueuedOperations
      || this.queuedBytes + bytes > this.maxQueuedBytes
    if (saturated) {
      return Promise.reject(Object.assign(new Error('Session journal write queue is full'), { code: 'SESSION_JOURNAL_BUSY' }))
    }
    this.queuedOperations += 1
    this.queuedBytes += bytes
    const result = this.operationQueue.then(operation).finally(() => {
      this.queuedOperations -= 1
      this.queuedBytes -= bytes
    })
    // 队列本体吞掉失败(结果 promise 保留原错误给调用方)。
    this.operationQueue = result.catch(() => {})
    return result
  }

  // 追加一条事件:先按保留策略度量字节,入队执行;到维护周期顺带 prune。
  // 失败只告警不抛(调用方是热路径,故障不能打断会话)。
  append({ ownerId, sessionId = 'main', event } = {}) {
    let bytes
    try { bytes = recordSize(event) } catch (error) { return Promise.reject(error) }
    const run = async () => {
      const journal = this.get(ownerId, sessionId)
      const appended = await journal.append(event)
      if (this.maintenanceDue()) await this.prune(journal.filePath)
      return appended
    }
    return this.enqueue(run, bytes).catch((error) => {
      this.logger?.warn('session_journal.append_failed', {
        ownerId,
        sessionId,
        eventType: event?.type,
        error,
      })
      return null
    })
  }

  // 全量冲刷:先等队列排空,再冲每本日志,最后裁缓存。
  async flush() {
    await this.operationQueue
    await Promise.all([...this.journals.values()].map(journal => journal.flush()))
    this.trimCache()
  }

  // 一致性读:入队 → 冲本日志 → 确保装载 → 逐条吐出。
  async read(ownerId, sessionId = 'main') {
    return this.enqueue(async () => {
      const journal = this.get(ownerId, sessionId)
      await journal.flush()
      await journal.open()
      return journal.list()
    })
  }

  maintain() { return this.enqueue(() => this.prune()) }

  async prune(keepPath = null) {
    this.lastMaintenance = this.now()
    const survey = await this.#surveyFiles(keepPath)
    const outcome = await this.#evict(survey, keepPath)
    this.trimCache()
    if (outcome.removed) this.logger?.info('session_journal.pruned', { removed: outcome.removed, files: outcome.files, bytes: outcome.bytes })
    if (outcome.files > this.maxFiles || outcome.bytes > this.maxTotalBytes) {
      this.logger?.warn('session_journal.retention_protected', { files: outcome.files, bytes: outcome.bytes })
    }
    return outcome
  }

  // 阶段一:清点全部日志文件(只 stat,不解析);在飞/被指名保留的跳过。
  async #surveyFiles(keepPath) {
    const candidates = []
    let totalBytes = 0
    let files = 0
    const inFlight = journal => journal.pendingWrites || journal.openPromise
    for (const path of this.paths()) {
      try {
        const info = await stat(path)
        files += 1
        totalBytes += info.size
        const cached = [...this.journals.values()].find(journal => journal.filePath === path)
        const untouchable = path === keepPath || cached == null || !inFlight(cached)
        if (untouchable && path !== keepPath) candidates.push({ path, info, cached })
        else if (path === keepPath || (cached && inFlight(cached))) continue
        else if (!untouchable) candidates.push({ path, info, cached })
      } catch (error) {
        // 读不了/损坏的文件绝不作为保留策略的一部分被清掉。
        this.logger?.warn('session_journal.maintenance_failed', { path, error })
      }
    }
    candidates.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)
    return { candidates, totalBytes, files }
  }

  // 阶段二:逐候选评估淘汰。例行维护只 stat 已保留文件,不为「无需清理」这个
  // 结论每十分钟解析全量历史。
  async #evict({ candidates, totalBytes, files }, keepPath) {
    let removed = 0
    const overBudget = () => files > this.maxFiles || totalBytes > this.maxTotalBytes
    for (const candidate of candidates) {
      const expired = this.now() - candidate.info.mtimeMs > this.maxAgeMs
      if (!expired && !overBudget() && candidate.info.size <= this.retention.maxBytes) continue
      try {
        const decoded = readSessionLogSync(candidate.path, { retention: this.retention })
        const compacted = await this.#applyRetentionTrim(candidate, decoded)
        if (compacted) {
          totalBytes += compacted - candidate.info.size
          candidate.info = await stat(candidate.path)
        }
        if (!expired && !overBudget()) continue
        if (latestLogTasks(decoded.events).some(needsLogRecovery)) continue
        await unlink(candidate.path)
        files -= 1
        totalBytes -= candidate.info.size
        removed += 1
        for (const [key, journal] of this.journals) {
          if (journal.filePath === candidate.path) this.journals.delete(key)
        }
        // 只删空了的会话目录,绝不递归清状态。
        await rmdir(dirname(candidate.path)).catch(() => {})
      } catch (error) {
        this.logger?.warn('session_journal.prune_failed', { path: candidate.path, error })
      }
    }
    return { removed, files, bytes: totalBytes }
  }

  // 文件里有可裁记录时:就地压实一次并 touch 时间戳。
  // 返回新字节数,无可裁返回 0。
  async #applyRetentionTrim(candidate, decoded) {
    if (!decoded.removed) return 0
    const journal = candidate.cached || new SessionLog({
      filePath: candidate.path, sessionId: decoded.header.sessionId, retention: this.retention,
    })
    await journal.open()
    await utimes(candidate.path, candidate.info.atime, candidate.info.mtime)
    const updated = await stat(candidate.path)
    return updated.size
  }

  // 物化全量快照(启动投影推荐直接用 iterateSync 流式消费)。
  readAllSync() {
    return [...this.iterateSync()]
  }

  // 递归枚举所有 session.jsonl;目录缺失静默(首启常态),其余扫描错误走告警。
  *paths(directory = this.directory, onError = (error, path) => this.logger?.warn('session_journal.scan_failed', { path, error })) {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') onError(error, directory)
      return
    }
    for (const entry of entries) {
      const target = resolve(directory, entry.name)
      if (!entry.isFile()) {
        if (entry.isDirectory()) yield* this.paths(target, onError)
        continue
      }
      if (entry.name === 'session.jsonl') yield target
    }
  }

  // 启动投影一次只消费一个文件,不把所有解析结果同时攥在手里;
  // 需要物化快照的调用方仍可用 readAllSync 数组形态。撕坏的尾行计入告警。
  *iterateSync() {
    for (const target of this.paths()) {
      try {
        const decoded = readSessionLogSync(target, { retention: this.retention })
        if (decoded.discardedBytes) {
          this.logger?.warn('session_journal.torn_tail', {
            path: target,
            discardedBytes: decoded.discardedBytes,
          })
        }
        yield { path: target, records: decoded.records }
      } catch (error) {
        this.logger?.warn('session_journal.read_failed', { path: target, error })
      }
    }
  }

  taskSnapshotsSync() {
    const snapshots = new Map()
    const revisions = new Map()
    for (const journalFile of this.iterateSync()) {
      for (const event of journalFile.records || []) {
        const task = event?.payload?.task
        // schema 换代前后的任务事件值双认(旧文件仍要能投影)
        if ((event?.type !== SessionEventType.TASK_EVENT && event?.type !== 'qwaudio/task/event') || !task?.id) continue
        // seq 是单文件内的序号,不是全局修订号;短 id 被回收复用时,
        // 决不能把长日志里的旧任务捞回来 —— 所以按三元组逐位比新旧。
        const fingerprint = [Number(task.createdAt) || 0, Date.parse(event.time) || 0, event.seq]
        const previous = revisions.get(task.id)
        const newer = !previous || fingerprint.some((value, index) => value > (previous[index] ?? -Infinity))
        if (newer) {
          snapshots.set(task.id, { ...task, journalSeq: event.seq })
          revisions.set(task.id, fingerprint)
        }
      }
    }
    return [...snapshots.values()]
  }
}
