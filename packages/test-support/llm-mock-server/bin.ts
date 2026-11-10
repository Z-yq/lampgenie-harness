// 脚本化 mock LLM 服务的独立进程壳(本仓自研;「stdout 通告 ready/unavailable + 事件流」的
// 进程协议参考 deepseek-harness 的 llm-mock-server,MIT,致谢)。
/**
 * Standalone process wrapper for the scriptable mock LLM server.
 * @module @lampgenie/test-support/llm-mock-server/bin
 */

import { setTimeout as delay } from 'node:timers/promises'
import { MOCK_LLM_CLI_USAGE, parseMockLlmCliArgs, type MockLlmCliConfig } from './cli'
import { startMockLlmServer } from './index'

/** 起服务、通告 ready、挂信号;返回后进程随 close 退出。 */
async function serve(config: MockLlmCliConfig): Promise<void> {
  const { server: serverOptions, listenDelayMs, startsUnavailable } = config
  const host = serverOptions.host ?? '127.0.0.1'
  const port = serverOptions.port ?? 8_000

  // connection_refused 剧本:先通告「不可用窗口」,让客户端撞一次拒连再重试。
  if (startsUnavailable) {
    process.stdout.write(`${JSON.stringify({ type: 'unavailable', baseURL: `http://${host}:${port}/v1`, listenDelayMs })}\n`)
    await delay(listenDelayMs)
  }

  const server = await startMockLlmServer({
    ...serverOptions,
    onEvent: (event) => { process.stdout.write(`${JSON.stringify(event)}\n`) },
  })
  process.stdout.write(`${JSON.stringify({ type: 'ready', baseURL: `${server.baseURL}/v1`, randomSeed: server.randomSeed })}\n`)

  let closing = false
  const shutDown = (exitCode: number): void => {
    if (closing) return
    closing = true
    void server.close().finally(() => { process.exit(exitCode) })
  }
  process.on('SIGINT', () => shutDown(130))
  process.on('SIGTERM', () => shutDown(143))
}

/* v8 ignore start -- 进程/信号薄胶水;解析器与服务行为已被直接覆盖 */
try {
  const parsed = parseMockLlmCliArgs(process.argv.slice(2))
  if (parsed.kind === 'help') {
    process.stdout.write(MOCK_LLM_CLI_USAGE)
  } else {
    await serve(parsed.config)
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${MOCK_LLM_CLI_USAGE}`)
  process.exitCode = 1
}
/* v8 ignore stop */
