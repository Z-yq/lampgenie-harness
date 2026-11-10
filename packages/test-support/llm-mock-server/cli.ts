// mock LLM 服务的 CLI 解析(零依赖,本仓自研;「选项词汇 + 约束校验」的做法参考
// deepseek-harness 的 llm-mock-server,MIT,致谢)。
/**
 * Dependency-free CLI parsing for the standalone mock LLM server.
 * @module @lampgenie/test-support/llm-mock-server/cli
 */

import { parseArgs } from 'node:util'
import { MAX_MOCK_LLM_TIMER_DELAY_MS, MOCK_LLM_BEHAVIORS } from './index'
import type {
  ConcreteMockLlmBehavior,
  MockLlmBehavior,
  MockLlmRandomWeights,
  MockLlmServerOptions,
} from './index'

/** 仅独立 CLI 理解的监听期行为。 */
export const CONNECTION_REFUSED_BEHAVIOR = 'connection_refused'

export interface MockLlmCliConfig {
  /** 去掉 lifecycle 专属 `connection_refused` 后的服务端选项。 */
  readonly server: MockLlmServerOptions
  /** 绑定模型端口前的延时;0 ~ Node 定时器上限的整数。 */
  readonly listenDelayMs: number
  /** 剧本是否要求真正的拒连窗口。 */
  readonly startsUnavailable: boolean
}

export type MockLlmCliParseResult =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly config: MockLlmCliConfig }

const BEHAVIORS = new Set<string>(MOCK_LLM_BEHAVIORS)
const DEFAULT_LISTEN_DELAY_MS = 750
const DEFAULT_PORT = 8_000

export const MOCK_LLM_CLI_USAGE = `Usage: genie-llm-mock [options]

Required:
  --sequence <a,b,...>       Ordered behaviors; connection_refused is allowed first

Listener:
  --host <host>              Default 127.0.0.1
  --port <port>              Default 8000; required and nonzero for connection_refused
  --api-key <token>          Validate exact Bearer token when present
  --listen-delay-ms <ms>     Unavailable interval (default 750 with connection_refused)
  --repeat-last              Repeat the final request behavior after exhaustion
  --seed <uint32>            Reproduce random selections
  --random-weights <a=n,...> Relative weights for concrete behaviors

Response:
  --success-text <text>
  --partial-text <text>
  --reasoning-text <text>
  --chunk-size <count>
  --chunk-delay-ms <ms>
  --disconnect-delay-ms <ms>
  --retry-after-ms <ms>
  --request-id <id>
  --tool-name <name>
  --tool-arguments <json>

Other:
  --help
`

function numberValue(option: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`genie-llm-mock: ${option} must be a finite number`)
  return parsed
}

function boundedIntegerValue(option: string, value: string, min: number, max: number): number {
  const parsed = numberValue(option, value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`genie-llm-mock: ${option} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function parseSequence(raw: string): { startsUnavailable: boolean; sequence: MockLlmBehavior[] } {
  const entries = raw.split(',').map(entry => entry.trim())
  if (entries.some(entry => entry.length === 0)) {
    throw new Error('genie-llm-mock: --sequence must contain non-empty comma-separated behaviors')
  }
  const startsUnavailable = entries[0] === CONNECTION_REFUSED_BEHAVIOR
  if (entries.slice(1).includes(CONNECTION_REFUSED_BEHAVIOR)) {
    throw new Error('genie-llm-mock: connection_refused is allowed only as the first behavior')
  }
  const requestEntries = startsUnavailable ? entries.slice(1) : entries
  if (requestEntries.length === 0) {
    throw new Error('genie-llm-mock: connection_refused must be followed by a request behavior')
  }
  for (const entry of requestEntries) {
    if (!BEHAVIORS.has(entry)) throw new Error(`genie-llm-mock: unknown behavior ${JSON.stringify(entry)}`)
  }
  return { startsUnavailable, sequence: requestEntries as MockLlmBehavior[] }
}

function parseRandomWeights(raw: string): MockLlmRandomWeights {
  const weights: MockLlmRandomWeights = {}
  for (const entry of raw.split(',')) {
    const [behavior, rawWeight, ...extra] = entry.split('=')
    if (behavior === undefined || behavior === '' || rawWeight === undefined || rawWeight === '' || extra.length > 0) {
      throw new Error('genie-llm-mock: --random-weights expects behavior=weight comma-separated entries')
    }
    if (!BEHAVIORS.has(behavior) || behavior === 'random') {
      throw new Error(`genie-llm-mock: random weight requires a concrete behavior, got ${JSON.stringify(behavior)}`)
    }
    if (Object.hasOwn(weights, behavior)) {
      throw new Error(`genie-llm-mock: duplicate random weight for ${JSON.stringify(behavior)}`)
    }
    weights[behavior as ConcreteMockLlmBehavior] = numberValue('--random-weights', rawWeight)
  }
  return weights
}

/** parseArgs 词汇表:全部文档化 flag;只有 --repeat-last 与 --help 是布尔。 */
const CLI_OPTIONS = {
  'sequence': { type: 'string' },
  'host': { type: 'string' },
  'port': { type: 'string' },
  'api-key': { type: 'string' },
  'listen-delay-ms': { type: 'string' },
  'repeat-last': { type: 'boolean' },
  'seed': { type: 'string' },
  'random-weights': { type: 'string' },
  'success-text': { type: 'string' },
  'partial-text': { type: 'string' },
  'reasoning-text': { type: 'string' },
  'chunk-size': { type: 'string' },
  'chunk-delay-ms': { type: 'string' },
  'disconnect-delay-ms': { type: 'string' },
  'retry-after-ms': { type: 'string' },
  'request-id': { type: 'string' },
  'tool-name': { type: 'string' },
  'tool-arguments': { type: 'string' },
} as const

// 文本/数值选项 → 服务端选项键的搬运表:统一从 values 装配,不再逐行手写。
// [flag, serverKey, 类型];数值型做有限数校验,整型再加边界。
type Copier = readonly [flag: string, key: string, kind: 'string' | 'number' | 'int']

const OPTION_COPIERS: readonly Copier[] = [
  ['success-text', 'successText', 'string'],
  ['partial-text', 'partialText', 'string'],
  ['reasoning-text', 'reasoningText', 'string'],
  ['request-id', 'requestId', 'string'],
  ['tool-name', 'toolName', 'string'],
  ['tool-arguments', 'toolArguments', 'string'],
  ['chunk-size', 'chunkSize', 'number'],
  ['chunk-delay-ms', 'chunkDelayMs', 'number'],
  ['disconnect-delay-ms', 'disconnectDelayMs', 'number'],
  ['retry-after-ms', 'retryAfterMs', 'number'],
]

/**
 * 解析独立服务参数;不起进程不监听。分词走 node:util parseArgs(strict、无位置参数);
 * 数值与跨选项约束在其下手工校验。
 */
export function parseMockLlmCliArgs(argv: readonly string[]): MockLlmCliParseResult {
  if (argv.includes('--help')) return { kind: 'help' }

  const { values } = parseArgs({ args: [...argv], options: CLI_OPTIONS, strict: true, allowPositionals: false })

  if (values.sequence === undefined) throw new Error('genie-llm-mock: --sequence is required')
  const sequence = parseSequence(values.sequence)
  const port = values.port === undefined ? DEFAULT_PORT : numberValue('--port', values.port)
  const listenDelayMs = values['listen-delay-ms'] === undefined
    ? undefined
    : boundedIntegerValue('--listen-delay-ms', values['listen-delay-ms'], 0, MAX_MOCK_LLM_TIMER_DELAY_MS)
  const randomSeed = values.seed === undefined ? undefined : numberValue('--seed', values.seed)
  const randomWeights = values['random-weights'] === undefined ? undefined : parseRandomWeights(values['random-weights'])

  if (sequence.startsUnavailable && port === 0) {
    throw new Error('genie-llm-mock: connection_refused requires an explicit nonzero --port')
  }
  if (!sequence.startsUnavailable && listenDelayMs !== undefined) {
    throw new Error('genie-llm-mock: --listen-delay-ms requires connection_refused first in --sequence')
  }
  if (!sequence.sequence.includes('random') && (randomSeed !== undefined || randomWeights !== undefined)) {
    throw new Error('genie-llm-mock: --seed and --random-weights require random in --sequence')
  }

  const server: Record<string, unknown> = {
    sequence: sequence.sequence,
    port,
    repeatLast: values['repeat-last'] ?? false,
  }
  for (const [flag, key, kind] of OPTION_COPIERS) {
    const raw = values[flag as keyof typeof values]
    if (raw === undefined || typeof raw === 'boolean') continue
    server[key] = kind === 'string' ? raw : numberValue(`--${flag}`, raw)
  }
  for (const [flag, key] of [
    ['host', 'host'],
    ['api-key', 'apiKey'],
  ] as const) {
    if (values[flag] !== undefined) server[key] = values[flag]
  }
  if (randomSeed !== undefined) server.randomSeed = randomSeed
  if (randomWeights !== undefined) server.randomWeights = randomWeights

  return {
    kind: 'run',
    config: {
      server: server as unknown as MockLlmServerOptions,
      listenDelayMs: sequence.startsUnavailable ? listenDelayMs ?? DEFAULT_LISTEN_DELAY_MS : 0,
      startsUnavailable: sequence.startsUnavailable,
    },
  }
}
