// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { appendFile, mkdir, open, rename, unlink, truncate } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  createSessionHeader,
  normalizeSessionEvent,
} from '../../shared/session-events'
import { readSessionLogSync } from './session-journal-reader'
import { compactLogEvents, logRetention, recordSize, retainedLogHeader } from './session-journal-retention'

const asLine = value => `${JSON.stringify(value)}\n`

/**
 * 单个逻辑 Agent 会话的持久事件日志,按保留策略周期压实。
 * 刻意不认识 TaskSupervisor/ConversationSync/ACP:它们消费事件流、自建投影。
 */
export class SessionLog {
  // filePath/sessionId 必填;retention 走 logRetention 归一;now 取 ISO 字符串。
  constructor({ filePath, sessionId, metadata = {}, retention, now = () => new Date().toISOString() } = {}) {
    if (!filePath) throw new TypeError('filePath is required')
    if (!sessionId) throw new TypeError('sessionId is required')
    this.filePath = filePath
    this.sessionId = String(sessionId)
    this.metadata = { ...metadata }
    this.now = now
    this.retention = logRetention(retention)
    this.header = createSessionHeader({ sessionId: this.sessionId, ...metadata })
    this.events = []          // 已装载的事件(内存投影)
    this.eventIds = new Set() // 幂等键索引
    this.initialized = false  // 是否已完成首启装载
    this.openPromise = null   // 并发 open 合并句柄
    this.writeQueue = Promise.resolve() // 串行写队列
    this.bytes = recordSize(this.header)
    this.pendingWrites = 0    // 在飞写数(保留策略回收时不可动)
  }

  // 打开(幂等):并发调用共享同一个装载 promise。
  async open() {
    if (this.initialized) return this
    if (!this.openPromise) {
      this.openPromise = this.openFile().finally(() => { this.openPromise = null })
    }
    return this.openPromise
  }

  async openFile() {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    let validated
    try {
      validated = readSessionLogSync(this.filePath, { sessionId: this.sessionId, retention: this.retention })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await appendFile(this.filePath, asLine(this.header), { encoding: 'utf8', mode: 0o600 })
      this.initialized = true
      return this
    }
    if (validated.removed) {
      await this.replaceFile(validated.header, validated.events)
    } else {
      if (validated.discardedBytes) await truncate(this.filePath, validated.validBytes)
      if (validated.needsNewline) await appendFile(this.filePath, '\n', 'utf8')
    }
    this.install(validated.header, validated.events)
    this.initialized = true
    return this
  }

  // 把「已验证的 header+事件集」安装进内存态,并重算字节账与幂等键索引。
  install(header, events) {
    this.header = header
    this.events = events
    this.bytes = [header, ...events].reduce((sum, item) => sum + recordSize(item), 0)
    this.eventIds = new Set(events.map(event => event.eventId).filter(Boolean))
  }

  // 原子整体重写(tmp+fsync+rename),用于保留裁剪与修复;半途失败清理 tmp。
  async replaceFile(header, events) {
    const staging = `${this.filePath}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(staging, 'wx', 0o600)
      await handle.writeFile([header, ...events].map(asLine).join(''), 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(staging, this.filePath)
    } finally {
      await handle?.close()
      await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  // 追加:串行队列内打开→幂等键检查→归一→保留线判断→落盘。
  append(event) {
    this.pendingWrites += 1
    const operation = this.writeQueue.then(async () => {
      await this.open()
      // 幂等键重放:同 eventId 直接返回已落账事件。
      if (event?.eventId && this.eventIds.has(event.eventId)) {
        return this.events.find(item => item.eventId === event.eventId) || null
      }
      const incoming = normalizeSessionEvent(event, {
        sessionId: this.sessionId,
        seq: (this.events.at(-1)?.seq || 0) + 1,
        time: this.now(),
      })
      const incomingBytes = recordSize(incoming)
      // 保留线触发(条数或字节):整文件重写为压实后的集合,而不是原地追加。
      const overCount = this.events.length + 1 > this.retention.maxEvents
      const overBytes = this.bytes + incomingBytes + 256 > this.retention.maxBytes
      if (overCount || overBytes) {
        const pool = [...this.events, incoming]
        const retained = compactLogEvents(pool, this.retention, recordSize(this.header) + 256)
        const header = retainedLogHeader(this.header, pool.length - retained.length)
        await this.replaceFile(header, retained)
        this.install(header, retained)
        return incoming
      }
      try {
        await appendFile(this.filePath, asLine(incoming), { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        // 失败的写入也可能留下了半截字节:不信任内存态,把重放修复交给下一次 open。
        this.initialized = false
        throw error
      }
      this.events.push(incoming)
      this.bytes += incomingBytes
      if (incoming.eventId) this.eventIds.add(incoming.eventId)
      return incoming
    }).finally(() => { this.pendingWrites -= 1 })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  async flush() { await this.writeQueue }
  // 只读视图:header + 全部事件的浅拷贝(调用方改动不影响内存态)。
  list() { return [this.header, ...this.events].map(item => ({ ...item })) }
  eventsSince(seq = 0) { return this.events.filter(event => event.seq > seq).map(event => ({ ...event })) }

  // 左折叠投影:调用方自备 reducer 与初值,日志本身不解释事件语义。
  project(reducer, initialState) {
    if (typeof reducer !== 'function') throw new TypeError('reducer must be a function')
    return this.events.reduce((state, event) => reducer(state, event), initialState)
  }
}

// 便捷入口:构造即打开(装载完成才返回)。
export async function openSessionLog(filePath, options = {}) {
  const journal = new SessionLog({ filePath, ...options })
  await journal.open()
  return journal
}
