// @ts-nocheck — MemoryProvider 持久化端口契约(本仓自有词汇;「describe/list/apply 三面 + 能力位」的端口设计参考 qwen-audio-agent,Apache-2.0,致谢);strict 类型化列入 backlog。
export const MEMORY_PROVIDER_API_VERSION = 2
export const LEGACY_MEMORY_PROVIDER_API_VERSION = 1

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LEGACY_MEMORY_PROVIDER_API_VERSION,
  MEMORY_PROVIDER_API_VERSION,
])

const PROVIDER_KEY = /^[a-z0-9][a-z0-9-]*$/u

export function clean(value, maxChars) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

export function summarizeMemoryProvider(provider) {
  const description = provider?.describe?.()
  const protocolVersion = Number(description?.protocolVersion)
  if (
    !description
    || !SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)
    || !PROVIDER_KEY.test(String(description.key || ''))
    || !String(description.label || '').trim()
  ) {
    throw new TypeError(
      'MemoryProvider describe() returned an invalid identity or protocol version',
    )
  }
  // v2 起才存在的能力位;逐位显式判断,未知字段不透传。
  const v2Capable = protocolVersion >= 2
  const capabilityOf = name => v2Capable && description.capabilities?.[name] === true
  return {
    protocolVersion,
    key: String(description.key),
    label: clean(description.label, 120),
    capabilities: {
      semanticQuery: capabilityOf('semanticQuery'),
      sessionObservation: capabilityOf('sessionObservation'),
      audioStreamObservation: capabilityOf('audioStreamObservation'),
    },
  }
}

/**
 * Provider-neutral persistence port for frontend memory.
 * Required methods:
 *   describe() -> { protocolVersion, key, label }
 *   list(ownerId, options) -> MemoryDocument[]
 *   apply(ownerId, changes, context) -> MemoryApplyResult | Promise<...>
 * list() is deliberately synchronous because it supplies the latency-sensitive
 * Realtime prompt. Remote providers should keep a bounded local snapshot and
 * refresh it after apply(). Writes may be asynchronous.
 * Protocol v2 optional capabilities:
 *   query(ownerId, query, options, context) -> MemoryQueryResult
 *   observe(ownerId, exchange, context) -> void
 *   flush(ownerId, context) -> void
 *   observeAudio(ownerId, event, context) -> void
 * Providers advertise semanticQuery/sessionObservation/audioStreamObservation
 * from describe(). observeAudio() runs on the accepted PCM16 input hot path
 * and receives chunk, speech_started, speech_stopped, and session_ended events.
 * It must therefore be synchronous, bounded, and free of remote I/O. A
 * provider that owns sessionObservation replaces the built-in Markdown
 * extractor and preference learner; the two learning pipelines never run in
 * parallel. Such providers also own retention, sensitive-data filtering, and
 * deletion policy for the exchanges they observe.
 * Optional lifecycle methods:
 *   health() -> { ok, ... }
 *   close()
 */
export function guardMemoryProvider(value, { name = 'MemoryProvider' } = {}) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  // 三件必选方法缺一不可;可选方法给了就必须是函数。
  const REQUIRED_METHODS = ['describe', 'list', 'apply']
  const missing = REQUIRED_METHODS.filter(method => typeof value[method] !== 'function')
  if (missing.length) {
    throw new TypeError(`${name} is missing required methods: ${missing.join(', ')}`)
  }
  for (const optional of ['health', 'close', 'flush']) {
    const provided = value[optional] != null
    if (provided && typeof value[optional] !== 'function') {
      throw new TypeError(`${name} ${optional} must be a function when provided`)
    }
  }
  // 声明了能力位就必须带对应方法:宣传与实现必须对账。
  const description = summarizeMemoryProvider(value)
  const CAPABILITY_METHODS = [
    ['semanticQuery', 'query'],
    ['sessionObservation', 'observe'],
    ['audioStreamObservation', 'observeAudio'],
  ]
  for (const [capability, method] of CAPABILITY_METHODS) {
    const advertised = description.capabilities[capability]
    if (advertised && typeof value[method] !== 'function') {
      throw new TypeError(`${name} advertises ${capability} but has no ${method} method`)
    }
  }
  return value
}

// 健康信息归一:非对象当空对象;ok 缺省按健康(只有显式 false 才是不健康)。
export function tidyProviderHealth(value) {
  const health = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { ...health, ok: health.ok !== false }
}
