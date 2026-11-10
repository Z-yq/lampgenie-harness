// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { closeSync, openSync, readSync } from 'node:fs'
import { validateSessionLog } from '../../shared/session-events'
import {
  compactLogEvents, logRetention, recordSize, retainedLogHeader,
} from './session-journal-retention'

/** 恢复用的有界流式解码器(本仓自研;同类「边读边压实、绝不改输入文件」的做法参考
 *  qwen-audio-agent,Apache-2.0,致谢)。 */
export function readSessionLogSync(filePath, { sessionId, retention } = {}) {
  const policy = logRetention(retention)
  const RETENTION_HEADROOM = 256 // header 里保留策略元数据的预算
  const fd = openSync(filePath, 'r')
  let header
  let events = []
  let bytes = 0
  let lastSeq = 0
  let dropped = 0
  let committedBytes = 0
  let rawBytes = 0
  let endsClean = false
  let partial = Buffer.alloc(0)

  // 单行消费:首行当 header 校验,其余按事件校验入账;超保留线就地压实。
  // 未收尾的尾行 JSON 解析失败返回 false(交给调用方按撕坏尾处理)。
  const consume = (raw, terminated) => {
    const text = raw.toString('utf8').trim()
    if (text) {
      let record
      try { record = JSON.parse(text) } catch (error) {
        if (!terminated && header) return false
        throw new TypeError('invalid committed session journal JSON', { cause: error })
      }
      if (!header) {
        validateSessionLog([record], { sessionId })
        header = record
        bytes = recordSize(header) + RETENTION_HEADROOM
      } else {
        validateSessionLog([header, record], { sessionId })
        if (record.seq <= lastSeq) throw new TypeError('invalid session event sequence')
        lastSeq = record.seq
        events.push(record)
        bytes += recordSize(record)
        const saturated = events.length > policy.maxEvents || bytes > policy.maxBytes
        if (saturated) {
          const retained = compactLogEvents(events, policy, recordSize(header) + RETENTION_HEADROOM)
          dropped += events.length - retained.length
          events = retained
          bytes = recordSize(header) + RETENTION_HEADROOM
            + events.reduce((sum, item) => sum + recordSize(item), 0)
        }
      }
    }
    committedBytes += raw.length + (terminated ? 1 : 0)
    endsClean = terminated
    return true
  }
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let filled
    while ((filled = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      rawBytes += filled
      const pending = Buffer.concat([partial, chunk.subarray(0, filled)])
      let lineStart = 0
      let newlineAt
      while ((newlineAt = pending.indexOf(10, lineStart)) !== -1) {
        if (newlineAt - lineStart > policy.maxBytes) {
          throw new RangeError('session journal record exceeds byte limit')
        }
        consume(pending.subarray(lineStart, newlineAt), true)
        lineStart = newlineAt + 1
      }
      partial = Buffer.from(pending.subarray(lineStart))
      if (partial.length > policy.maxBytes) {
        throw new RangeError('session journal record exceeds byte limit')
      }
    }
    if (partial.length) consume(partial, false)
    if (!header) throw new TypeError('session log is empty')
    header = retainedLogHeader(header, dropped)
    return {
      header, events, records: [header, ...events], removed: dropped,
      validBytes: committedBytes, discardedBytes: rawBytes - committedBytes, needsNewline: !endsClean,
    }
  } finally {
    closeSync(fd)
  }
}
