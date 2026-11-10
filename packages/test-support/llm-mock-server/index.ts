// 脚本化 Messages mock 服务(本仓自研实现;「一个请求吃掉一个脚本行为」的可编程故障注入
// 形态参考 deepseek-harness 的 llm-mock-server,MIT,致谢)。服务永不重试、永不解释
// harness 策略——它只按剧本演故障,让上层恢复逻辑在受控输入下被验证。
/**
 * Scriptable HTTP/SSE mock of a Messages LLM endpoint for transport,
 * protocol, and semantic-empty recovery tests.
 * @module @lampgenie/test-support/llm-mock-server
 */

import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { isIP, type AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** 请求级剧本行为,由 {@link startMockLlmServer} 依序消费。 */
export const MOCK_LLM_BEHAVIORS = [
  'connection_reset',
  'stream_disconnect',
  'empty',
  'empty_body',
  'stream_eof',
  'partial_eof',
  'partial_disconnect',
  'stall',
  'malformed_json',
  'malformed_event',
  'wrong_content_type',
  'rate_limit',
  'server_error',
  'service_unavailable',
  'auth_error',
  'invalid_request',
  'context_overflow',
  'quota_exceeded',
  'success',
  'reasoning_success',
  'tool_call_success',
  'max_tokens',
  'slow_success',
  'random',
] as const

export type MockLlmBehavior = typeof MOCK_LLM_BEHAVIORS[number]
export type ConcreteMockLlmBehavior = Exclude<MockLlmBehavior, 'random'>
export type MockLlmRandomWeights = Partial<Record<ConcreteMockLlmBehavior, number>>

/**
 * `random` 的缺省压力配比。权重是测试压力参数,不是对生产故障频率的断言。
 */
export const DEFAULT_MOCK_LLM_RANDOM_WEIGHTS: Readonly<MockLlmRandomWeights> = Object.freeze({
  success: 48,
  slow_success: 10,
  max_tokens: 2,
  connection_reset: 5,
  stream_disconnect: 5,
  partial_disconnect: 10,
  empty: 5,
  stall: 2,
  rate_limit: 5,
  server_error: 4,
  service_unavailable: 2,
  partial_eof: 1,
  malformed_json: 1,
})

/** Node 定时器不截断的最大毫秒延时。 */
export const MAX_MOCK_LLM_TIMER_DELAY_MS = 2_147_483_647

export type MockLlmRequestOutcome = 'completed' | 'reset' | 'stalled' | 'client_closed' | 'server_error'

export type MockLlmServerEvent =
  | {
    readonly type: 'request'
    readonly attempt: number
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
    readonly path: string
  }
  | {
    readonly type: 'result'
    readonly attempt: number
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
    readonly outcome: MockLlmRequestOutcome
    readonly chunksSent: number
  }

export interface MockLlmRequestRecord {
  readonly attempt: number
  readonly scriptBehavior: MockLlmBehavior | 'script_exhausted'
  readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted'
  readonly path: string
  readonly headers: Readonly<IncomingHttpHeaders>
  readonly body: unknown
  chunksSent: number
  outcome?: MockLlmRequestOutcome
}

export interface MockLlmServerOptions {
  readonly host?: string
  readonly port?: number
  readonly apiKey?: string
  readonly sequence: readonly MockLlmBehavior[]
  readonly repeatLast?: boolean
  readonly randomSeed?: number
  readonly randomWeights?: Readonly<MockLlmRandomWeights>
  readonly successText?: string
  readonly partialText?: string
  readonly reasoningText?: string
  readonly chunkSize?: number
  readonly chunkDelayMs?: number
  readonly disconnectDelayMs?: number
  readonly retryAfterMs?: number
  readonly requestId?: string
  readonly toolName?: string
  readonly toolArguments?: string
  readonly onEvent?: (event: MockLlmServerEvent) => void
}

export interface MockLlmServer {
  readonly baseURL: string
  readonly port: number
  readonly randomSeed: number
  readonly requests: readonly MockLlmRequestRecord[]
  close(): Promise<void>
}

// ————————————————————————————————— 配置解析 —————————————————————————————————

interface ResolvedOptions {
  readonly host: string
  readonly port: number
  readonly apiKey?: string
  readonly sequence: readonly MockLlmBehavior[]
  readonly lastBehavior: MockLlmBehavior
  readonly repeatLast: boolean
  readonly randomSeed: number
  readonly randomWeights: readonly (readonly [ConcreteMockLlmBehavior, number])[]
  readonly successText: string
  readonly partialText: string
  readonly reasoningText: string
  readonly chunkSize: number
  readonly chunkDelayMs: number
  readonly disconnectDelayMs: number
  readonly retryAfterMs: number
  readonly requestId?: string
  readonly toolName: string
  readonly toolArguments: string
  readonly onEvent?: (event: MockLlmServerEvent) => void
}

const DEFAULT_SUCCESS_TEXT = 'mock response recovered'
const DEFAULT_PARTIAL_TEXT = 'discarded partial response'
const DEFAULT_REASONING_TEXT = 'mock reasoning'
const DEFAULT_TOOL_NAME = 'mock_tool'
const DEFAULT_TOOL_ARGUMENTS = '{"value":"mock"}'

const CONCRETE_BEHAVIORS: ReadonlySet<string> = new Set(
  MOCK_LLM_BEHAVIORS.filter(behavior => behavior !== 'random'),
)

// 数值参数的边界表:name → [缺省, 下界, 上界]。
const NUMERIC_BOUNDS = {
  port: [0, 0, 65_535],
  chunkSize: [8, 1, Number.MAX_SAFE_INTEGER],
  chunkDelayMs: [25, 0, MAX_MOCK_LLM_TIMER_DELAY_MS],
  disconnectDelayMs: [10, 0, MAX_MOCK_LLM_TIMER_DELAY_MS],
  retryAfterMs: [1_000, 1, MAX_MOCK_LLM_TIMER_DELAY_MS],
  randomSeed: [undefined, 0, 0xffff_ffff],
} as const

function requireInteger(name: string, value: number, min: number, max: number): number {
  const ok = Number.isInteger(value) && value >= min && value <= max
  if (!ok) throw new Error(`llm-mock-server: ${name} must be an integer between ${min} and ${max}`)
  return value
}

function requireNonEmpty(name: string, value: string | undefined): string {
  if (value === '') throw new Error(`llm-mock-server: ${name} must not be empty`)
  return value as string
}

function parseWeights(configured: Readonly<MockLlmRandomWeights>) {
  const pairs: Array<readonly [ConcreteMockLlmBehavior, number]> = []
  for (const [behavior, weight] of Object.entries(configured)) {
    if (!CONCRETE_BEHAVIORS.has(behavior)) {
      throw new Error(`llm-mock-server: randomWeights contains unknown concrete behavior ${JSON.stringify(behavior)}`)
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`llm-mock-server: random weight for ${behavior} must be a non-negative finite number`)
    }
    if (weight > 0) pairs.push([behavior as ConcreteMockLlmBehavior, weight])
  }
  if (pairs.length === 0) {
    throw new Error('llm-mock-server: randomWeights must contain at least one positive weight')
  }
  return pairs
}

function resolveOptions(options: MockLlmServerOptions): ResolvedOptions {
  const values: Record<string, number> = {}
  for (const [name, [fallback, min, max]] of Object.entries(NUMERIC_BOUNDS)) {
    const raw = (options as unknown as Record<string, number | undefined>)[name] ?? fallback
    values[name] = requireInteger(name, (raw ?? randomBytes(4).readUInt32LE(0)) as number, min, max)
  }

  const successText = requireNonEmpty('successText', options.successText ?? DEFAULT_SUCCESS_TEXT)
  const partialText = requireNonEmpty('partialText', options.partialText ?? DEFAULT_PARTIAL_TEXT)
  const reasoningText = requireNonEmpty('reasoningText', options.reasoningText ?? DEFAULT_REASONING_TEXT)
  const toolName = requireNonEmpty('toolName', options.toolName ?? DEFAULT_TOOL_NAME)
  const toolArguments = options.toolArguments ?? DEFAULT_TOOL_ARGUMENTS
  if (toolArguments === '') throw new Error('llm-mock-server: toolArguments must not be empty')
  try {
    JSON.parse(toolArguments)
  } catch {
    throw new Error('llm-mock-server: toolArguments must be valid JSON')
  }
  if ((options.host ?? '127.0.0.1').length === 0) throw new Error('llm-mock-server: host must not be empty')
  if (options.sequence.length === 0) throw new Error('llm-mock-server: sequence must not be empty')
  if (options.apiKey === '') throw new Error('llm-mock-server: apiKey must not be empty')
  if (options.requestId === '') throw new Error('llm-mock-server: requestId must not be empty')

  return {
    host: options.host ?? '127.0.0.1',
    port: values.port!,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    sequence: [...options.sequence],
    lastBehavior: options.sequence[options.sequence.length - 1]!,
    repeatLast: options.repeatLast ?? false,
    randomSeed: values.randomSeed!,
    randomWeights: parseWeights(options.randomWeights ?? DEFAULT_MOCK_LLM_RANDOM_WEIGHTS),
    successText,
    partialText,
    reasoningText,
    chunkSize: values.chunkSize!,
    chunkDelayMs: values.chunkDelayMs!,
    disconnectDelayMs: values.disconnectDelayMs!,
    retryAfterMs: values.retryAfterMs!,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    toolName,
    toolArguments,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  }
}

// ————————————————————————————————— 请求通道 —————————————————————————————————

/** 单个已接受请求的 SSE 出口:写事件、计数、收敛终态。 */
class SseChannel {
  constructor(
    readonly config: ResolvedOptions,
    readonly record: MockLlmRequestRecord,
    private readonly response: ServerResponse) {}

  get closed(): boolean {
    return this.response.destroyed
  }

  open(contentType = 'text/event-stream; charset=utf-8'): void {
    this.response.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    this.response.flushHeaders()
  }

  write(event: MessageSseEvent | string): void {
    const frame = typeof event === 'string'
      ? `data: ${event}\n\n`
      : `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    this.response.write(frame)
    this.record.chunksSent += 1
  }

  end(): void {
    this.response.end()
  }

  destroy(): void {
    this.response.destroy()
  }

  /** 以指定状态头/体直接应答(HTTP 错误形态)。 */
  replyError(status: number, headers: Record<string, string>, body: string): void {
    this.response.writeHead(status, headers)
    this.response.end(body)
  }

  /** 等待指定毫秒;客户端提前断开时返回 false(等待被 response 的 close 取消)。 */
  async hold(milliseconds: number): Promise<boolean> {
    if (milliseconds === 0) return !this.response.destroyed
    const gate = new AbortController()
    const abort = (): void => gate.abort()
    this.response.once('close', abort)
    try {
      await delay(milliseconds, undefined, { signal: gate.signal })
      return true
    } catch {
      return false
    } finally {
      this.response.off('close', abort)
    }
  }

  /** 记录终态并广播 result 事件;已收敛的请求忽略二次结算。 */
  finish(outcome: MockLlmRequestOutcome): void {
    if (this.record.outcome !== undefined) return
    this.record.outcome = outcome
    notify(this.config, {
      type: 'result',
      attempt: this.record.attempt,
      scriptBehavior: this.record.scriptBehavior,
      behavior: this.record.behavior,
      outcome,
      chunksSent: this.record.chunksSent,
    })
  }
}

interface MessageSseEvent {
  type: string
  [field: string]: unknown
}

function notify(options: ResolvedOptions, event: MockLlmServerEvent): void {
  try {
    options.onEvent?.(Object.freeze(event))
  } catch {
    // 遥测是观察者:观察者抛错不允许改变 wire 行为。
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  const body = Buffer.concat(chunks).toString('utf8')
  return body.length === 0 ? undefined : JSON.parse(body)
}

function codePoints(text: string): string[] {
  return Array.from(text)
}

function intoChunks(text: string, size: number): string[] {
  const points = codePoints(text)
  const out: string[] = []
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''))
  return out
}

// ————————————————————————————————— SSE 形状 —————————————————————————————————

function hello(channel: SseChannel): void {
  channel.write({
    type: 'message_start',
    message: { id: 'mock-message', type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } },
  })
}

function blockStart(channel: SseChannel, index: number, block: Record<string, unknown>): void {
  channel.write({ type: 'content_block_start', index, content_block: block })
}

function blockDelta(channel: SseChannel, index: number, delta: Record<string, unknown>): void {
  channel.write({ type: 'content_block_delta', index, delta })
}

function blockStop(channel: SseChannel, index: number): void {
  channel.write({ type: 'content_block_stop', index })
}

function stopFrame(reason: string, outputTokens: number): MessageSseEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }
}

function goodbye(channel: SseChannel): void {
  channel.write({ type: 'message_stop' })
}

// ————————————————————————————————— HTTP 错误行为表 —————————————————————————————————

interface HttpErrorSpec {
  status: number
  message: string
  code: string
  type?: string
}

const HTTP_ERROR_BEHAVIORS: Readonly<Record<string, HttpErrorSpec>> = {
  rate_limit: { status: 429, message: 'mock rate limit', code: 'rate_limit' },
  server_error: { status: 500, message: 'mock server error', code: 'server_error' },
  service_unavailable: { status: 503, message: 'mock service unavailable', code: 'service_unavailable' },
  auth_error: { status: 401, message: 'mock authentication failed', code: 'invalid_api_key' },
  invalid_request: { status: 400, message: 'mock invalid request', code: 'invalid_request' },
  context_overflow: {
    status: 400,
    message: 'mock input exceeds the model context window',
    code: 'context_length_exceeded',
    type: 'invalid_request_error',
  },
}

function respondHttpError(channel: SseChannel, spec: HttpErrorSpec): void {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (channel.record.behavior === 'rate_limit') {
    headers['retry-after'] = String(Math.ceil(channel.config.retryAfterMs / 1_000))
  }
  if (channel.config.requestId !== undefined) headers['x-request-id'] = channel.config.requestId
  channel.replyError(spec.status, headers, JSON.stringify({ error: { message: spec.message, type: spec.type ?? 'mock_error', code: spec.code } }))
  channel.finish('completed')
}

// ————————————————————————————————— 行为分发表 —————————————————————————————————

type BehaviorRunner = (channel: SseChannel, request: IncomingMessage) => Promise<void> | void

/** 打开 SSE + message_start 的公共前缀;多数流式行为都以它起手。 */
function openStream(channel: SseChannel): void {
  channel.open()
  hello(channel)
}

/** 发送正文并以指定停止原因完整收尾(end_turn / max_tokens / slow 共用)。 */
async function runTextBody(
  channel: SseChannel,
  options: ResolvedOptions,
  reason: 'end_turn' | 'max_tokens',
  gapMs: number,
  index = 0): Promise<void> {
  blockStart(channel, index, { type: 'text', text: '' })
  for (const piece of intoChunks(options.successText, options.chunkSize)) {
    blockDelta(channel, index, { type: 'text_delta', text: piece })
    if (!await channel.hold(gapMs)) {
      channel.finish('client_closed')
      return
    }
  }
  blockStop(channel, index)
  channel.write(stopFrame(reason, codePoints(options.successText).length))
  goodbye(channel)
  channel.end()
  channel.finish('completed')
}

/** 延时后强断连接;客户端先行关闭则按 client_closed 收敛。 */
async function cutLater(channel: SseChannel, options: ResolvedOptions): Promise<void> {
  if (!await channel.hold(options.disconnectDelayMs)) {
    channel.finish('client_closed')
    return
  }
  channel.finish('reset')
  channel.destroy()
}

const BEHAVIOR_RUNNERS: Readonly<Record<string, BehaviorRunner>> = {
  script_exhausted(channel) {
    respondHttpError(channel, { status: 500, message: 'mock script exhausted', code: 'MOCK_SCRIPT_EXHAUSTED' })
  },

  connection_reset(channel, request) {
    channel.finish('reset')
    request.socket.destroy()
  },

  async stream_disconnect(channel) {
    channel.open()
    await cutLater(channel, channel.config)
  },

  empty(channel) {
    openStream(channel)
    channel.write(stopFrame('end_turn', 0))
    goodbye(channel)
    channel.end()
    channel.finish('completed')
  },

  empty_body(channel) {
    channel.open()
    channel.end()
    channel.finish('completed')
  },

  stream_eof(channel) {
    openStream(channel)
    channel.end()
    channel.finish('completed')
  },

  async partial_eof(channel) {
    openStream(channel)
    blockStart(channel, 0, { type: 'text', text: '' })
    for (const piece of intoChunks(channel.config.partialText, channel.config.chunkSize)) {
      blockDelta(channel, 0, { type: 'text_delta', text: piece })
    }
    channel.end()
    channel.finish('completed')
  },

  async partial_disconnect(channel) {
    const options = channel.config
    openStream(channel)
    blockStart(channel, 0, { type: 'text', text: '' })
    for (const piece of intoChunks(options.partialText, options.chunkSize)) {
      blockDelta(channel, 0, { type: 'text_delta', text: piece })
      if (!await channel.hold(options.chunkDelayMs)) return
    }
    await cutLater(channel, options)
  },

  stall(channel) {
    channel.open()
    channel.finish('stalled')
  },

  malformed_json(channel) {
    openStream(channel)
    channel.write('{not-json')
    goodbye(channel)
    channel.end()
    channel.finish('completed')
  },

  malformed_event(channel) {
    openStream(channel)
    channel.write({ type: 'content_block_start', index: 0, content_block: null })
    goodbye(channel)
    channel.end()
    channel.finish('completed')
  },

  async wrong_content_type(channel) {
    channel.open('application/json')
    hello(channel)
    await runTextBody(channel, channel.config, 'end_turn', 0)
  },

  async success(channel) {
    openStream(channel)
    await runTextBody(channel, channel.config, 'end_turn', 0)
  },

  async reasoning_success(channel) {
    const options = channel.config
    openStream(channel)
    blockStart(channel, 0, { type: 'thinking', thinking: '' })
    for (const piece of intoChunks(options.reasoningText, options.chunkSize)) {
      blockDelta(channel, 0, { type: 'thinking_delta', thinking: piece })
    }
    blockStop(channel, 0)
    await runTextBody(channel, options, 'end_turn', 0, 1)
  },

  tool_call_success(channel) {
    const options = channel.config
    openStream(channel)
    const cut = Math.max(1, Math.floor(options.toolArguments.length / 2))
    blockStart(channel, 0, { type: 'tool_use', id: 'mock-call-1', name: options.toolName, input: {} })
    for (const partial of [options.toolArguments.slice(0, cut), options.toolArguments.slice(cut)]) {
      blockDelta(channel, 0, { type: 'input_json_delta', partial_json: partial })
    }
    blockStop(channel, 0)
    channel.write(stopFrame('tool_use', 2))
    goodbye(channel)
    channel.end()
    channel.finish('completed')
  },

  async max_tokens(channel) {
    openStream(channel)
    await runTextBody(channel, channel.config, 'max_tokens', 0)
  },

  async slow_success(channel) {
    const options = channel.config
    openStream(channel)
    await runTextBody(channel, options, 'end_turn', options.chunkDelayMs)
  },
}

function runnerFor(behavior: string): BehaviorRunner | undefined {
  const direct = BEHAVIOR_RUNNERS[behavior]
  if (direct) return direct
  const asHttp = HTTP_ERROR_BEHAVIORS[behavior]
  if (asHttp) return channel => respondHttpError(channel, asHttp)
  return undefined
}

// ————————————————————————————————— 随机行为 —————————————————————————————————

/** 无状态 32 位混合发生器(逐请求确定性;种子对外暴露以便复现)。 */
function makeDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x9e37_79b9) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21_f0_aa_ad)
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x73_59_a7_fd)
    return ((mixed ^= mixed >>> 16) >>> 0) / 0x1_0000_0000
  }
}

function drawWeighted(
  weights: readonly (readonly [ConcreteMockLlmBehavior, number])[],
  uniform: () => number): ConcreteMockLlmBehavior {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0)
  let dart = uniform() * total
  for (const [behavior, weight] of weights) {
    if (dart < weight) return behavior
    dart -= weight
  }
  // 浮点减法只可能在上边界留下舍入残差;uniform 严格小于 1,这里兜住残差。
  return weights[weights.length - 1]![0]
}

// ————————————————————————————————— 服务装配 —————————————————————————————————

/**
 * 启动本地 Messages mock:每个被接受的 POST `/v1/messages` 消费一条剧本行为。
 * 非法路由/方法/密钥/JSON 走普通 4xx,不消耗剧本。关闭句柄会终止挂起的连接。
 */
export async function startMockLlmServer(options: MockLlmServerOptions): Promise<MockLlmServer> {
  const resolved = resolveOptions(options)
  const records: MockLlmRequestRecord[] = []
  const uniform = makeDeterministicRandom(resolved.randomSeed)
  let cursor = 0

  const nextBehavior = (): {
    scriptBehavior: MockLlmBehavior | 'script_exhausted'
    behavior: ConcreteMockLlmBehavior | 'script_exhausted'
  } => {
    const scripted = resolved.sequence[cursor]
    cursor += 1
    const scriptBehavior = scripted ?? (resolved.repeatLast ? resolved.lastBehavior : 'script_exhausted')
    const behavior = scriptBehavior === 'random'
      ? drawWeighted(resolved.randomWeights, uniform)
      : scriptBehavior
    return { scriptBehavior, behavior }
  }

  async function accept(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://mock.invalid').pathname
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end()
      return
    }
    if (!path.endsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    if (resolved.apiKey !== undefined && request.headers['x-api-key'] !== resolved.apiKey) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid mock API key', code: 'invalid_api_key' } }))
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(request)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'request body must be valid JSON', code: 'invalid_json' } }))
      return
    }

    const picked = nextBehavior()
    const channel = new SseChannel(resolved, {
      attempt: records.length + 1,
      scriptBehavior: picked.scriptBehavior,
      behavior: picked.behavior,
      path,
      headers: { ...request.headers },
      body,
      chunksSent: 0,
    }, response)
    records.push(channel.record)

    response.once('close', () => {
      if (!response.writableFinished && channel.record.outcome === undefined) {
        channel.finish('client_closed')
      }
    })
    notify(resolved, {
      type: 'request',
      attempt: channel.record.attempt,
      scriptBehavior: channel.record.scriptBehavior,
      behavior: channel.record.behavior,
      path,
    })

    const runner = runnerFor(channel.record.behavior)
    if (!runner) {
      respondHttpError(channel, { status: 500, message: 'mock script exhausted', code: 'MOCK_SCRIPT_EXHAUSTED' })
      return
    }
    await runner(channel, request)
  }

  const server = createServer((request, response) => {
    accept(request, response).catch((error: unknown) => {
      const last = records[records.length - 1]
      const channelLike = { record: last } as unknown as SseChannel
      if (last !== undefined) channelLike.finish('server_error')
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
        return
      }
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'mock server handler failed', code: 'MOCK_HANDLER_FAILED' } }))
    })
  })

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => (closing ??= new Promise((done) => {
    server.close(() => done())
    server.closeAllConnections()
  }))

  await new Promise<void>((listenOk, listenFail) => {
    server.once('error', listenFail)
    server.listen(resolved.port, resolved.host, () => {
      server.off('error', listenFail)
      listenOk()
    })
  })

  const address = server.address() as AddressInfo
  const advertisedHost = isIP(resolved.host) === 6 ? `[${resolved.host}]` : resolved.host
  return {
    baseURL: `http://${advertisedHost}:${address.port}`,
    port: address.port,
    randomSeed: resolved.randomSeed,
    requests: records,
    close,
  }
}
