// @ts-nocheck — 持久会话事件词汇(本仓自有的 facts-not-logs 设计;同类「 durable session
// 事件流」的思路参考 qwen-audio-agent 与 deepseek-harness,致谢)。事件是事实而非诊断行:
// 投影层(UI/任务/记忆)必须能只靠事件重建状态。
// 兼容注:历史落盘文件使用旧 schema 串 `qwaudio.session/v1`,读取侧双认,新写入一律用本仓串。

export const SESSION_LOG_SCHEMA = 'genie.session-log/v1'
/** 历史文件里可能出现的旧 schema 串(只读兼容,不再产生)。 */
export const SESSION_LOG_SCHEMA_LEGACY = 'qwaudio.session/v1'
export const SESSION_LOG_FORMAT_VERSION = 1

const ACCEPTED_SCHEMAS = new Set([SESSION_LOG_SCHEMA, SESSION_LOG_SCHEMA_LEGACY])

const EVENT_DEFINITIONS = [
  ['SESSION_START', 'session/start'],
  ['SESSION_END', 'session/end'],
  ['TURN_START', 'turn/start'],
  ['TURN_END', 'turn/end'],
  ['STEP_START', 'step/start'],
  ['STEP_END', 'step/end'],
  ['USER_MESSAGE', 'user/message'],
  ['ASSISTANT_CHUNK', 'assistant/chunk'],
  ['ASSISTANT_MESSAGE', 'assistant/message'],
  ['TOOL_CALL', 'tool/call'],
  ['TOOL_RESULT', 'tool/result'],
  ['ERROR', 'error'],
  ['INPUT_REGISTERED', 'genie/input/registered'],
  ['INPUT_CONSUMED', 'genie/input/consumed'],
  ['REALTIME_REQUEST', 'genie/realtime/request'],
  ['ACP_REQUEST', 'genie/acp/request'],
  ['ACP_UPDATE', 'genie/acp/update'],
  ['ACP_RESULT', 'genie/acp/result'],
  ['TASK_EVENT', 'genie/task/event'],
  ['DELIVERY_EVENT', 'genie/delivery/event'],
  ['MEMORY_EVENT', 'genie/memory/event'],
]

export const SessionEventType = Object.freeze(Object.fromEntries(EVENT_DEFINITIONS))

/** 旧词汇(上游串)→ 新词汇;新词汇原样返回,未知值原样返回。 */
export function migrateSessionEventType(value) {
  const legacy = {
    'qwaudio/input/registered': 'genie/input/registered',
    'qwaudio/input/consumed': 'genie/input/consumed',
    'qwaudio/realtime/request': 'genie/realtime/request',
    'qwaudio/acp/request': 'genie/acp/request',
    'qwaudio/acp/update': 'genie/acp/update',
    'qwaudio/acp/result': 'genie/acp/result',
    'qwaudio/task/event': 'genie/task/event',
    'qwaudio/delivery/event': 'genie/delivery/event',
    'qwaudio/memory/event': 'genie/memory/event',
  }
  return legacy[value] ?? value
}

export function createSessionHeader({ sessionId, createdAt = new Date().toISOString(), ...meta } = {}) {
  if (!String(sessionId || '').trim()) throw new TypeError('sessionId is required')
  return {
    schema: SESSION_LOG_SCHEMA,
    type: 'session',
    version: SESSION_LOG_FORMAT_VERSION,
    sessionId: String(sessionId),
    createdAt,
    ...meta,
  }
}

export function normalizeSessionEvent(event, { sessionId, seq, time = new Date().toISOString() } = {}) {
  if (!event || typeof event !== 'object') throw new TypeError('session event must be an object')
  const type = String(event.type || '').trim()
  if (!type || type === 'session') throw new TypeError('session event type is required')
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('session event seq must be a positive integer')
  return Object.freeze({
    schema: SESSION_LOG_SCHEMA,
    ...event,
    sessionId: String(event.sessionId || sessionId || ''),
    seq,
    time: event.time || time,
    type,
  })
}

export function validateSessionLog(records, { sessionId } = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError('session log is empty')
  const [header, ...events] = records
  const headerOk =
    header?.type === 'session' && typeof header.schema === 'string' && ACCEPTED_SCHEMAS.has(header.schema)
  if (!headerOk) throw new TypeError('invalid session log header')
  if (sessionId && header.sessionId !== sessionId) throw new TypeError('session id mismatch')
  let previousSeq = 0
  events.forEach((event, index) => {
    const seqOk = Number.isInteger(event.seq) && event.seq >= 1 && event.seq > previousSeq
    const scopeOk = event.sessionId === header.sessionId && ACCEPTED_SCHEMAS.has(event.schema)
    if (!seqOk || !scopeOk) {
      throw new TypeError(`invalid session event at index ${index + 1}`)
    }
    previousSeq = event.seq
  })
  return { header, events }
}
