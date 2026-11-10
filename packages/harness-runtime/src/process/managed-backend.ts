// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有。
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import {
  backendRuntimeDriver,
  normalizeBackendRuntimeProtocol,
} from './backend-drivers/registry'
import { serviceEndpointPort } from './backend-drivers/shared'
import { backendEnvironment } from '../shared/backend/environment'
import { effectiveBackendPermissionMode } from '../shared/backend/catalog'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function permissionMode(env) {
  const mode = String(
    env.GENIE_BACKEND_PERMISSION_MODE || 'native',
  ).toLowerCase()
  if (!['native', 'full'].includes(mode)) {
    throw new Error(`不支持的后台权限模式：${mode}（可选 native、full）`)
  }
  return mode
}

function backendOwnership(driver, env) {
  const requested = String(
    env.GENIE_BACKEND_OWNERSHIP || '',
  ).trim().toLowerCase()
  if (requested && !['owned', 'external'].includes(requested)) {
    throw new Error(`不支持的后台进程归属：${requested}`)
  }
  if (requested === 'external' && !driver.supportsExternalService) {
    throw new Error(`${driver.id} 不支持连接外部后台服务`)
  }
  if (requested) return requested
  return driver.supportsExternalService
    && driver.baseUrlEnvironment
    && String(env[driver.baseUrlEnvironment] || '').trim()
    ? 'external'
    : 'owned'
}

// 从环境读协议 → 驱动 → 归属/权限解析 → 产出启动规格;协议缺失返回 null(未托管)。
export function resolveBackendLauncher(env = process.env) {
  const protocol = normalizeBackendRuntimeProtocol(env.AGENT_PROTOCOL)
  if (!protocol) return null
  const driver = backendRuntimeDriver(protocol)
  const resolvedPermissionMode = effectiveBackendPermissionMode(
    protocol,
    permissionMode(env),
  )
  const ownership = backendOwnership(driver, env)
  if (resolvedPermissionMode === 'full' && ownership !== 'owned') {
    throw new Error('最高权限模式只支持由 Gateway 启动的后台 Agent')
  }
  return driver.resolve({
    env,
    ownership,
    permissionMode: resolvedPermissionMode,
  })
}

export function setBackendPermissionMode(env, backend) {
  if (backend.permissionMode !== 'full') return env
  if (backend.ownership !== 'owned') {
    throw new Error('最高权限模式只支持由 Gateway 启动的后台 Agent')
  }
  return backendRuntimeDriver(backend.protocol)
    .applyPermissionMode?.(env, backend)
    || env
}

export function isLocalBackendKind(baseUrl) {
  return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)
}

// 探测地址上是否已有服务在听(300ms 内连得上 = 忙)。
export function backendAddressBusy(baseUrl, timeoutMs = 300) {
  const target = new URL(baseUrl)
  const port = serviceEndpointPort(target)
  return new Promise(settled => {
    const probe = createConnection({ host: target.hostname, port })
    const settle = value => {
      probe.destroy()
      settled(value)
    }
    probe.setTimeout(timeoutMs)
    probe.once('connect', () => settle(true)) // 连得上 = 有服务在听
    probe.once('timeout', () => settle(false))
    probe.once('error', () => settle(false))
  })
}

// 让 OS 分配一个空闲端口,回填进 baseUrl。
// 借 OS 临时监听拿一个空闲端口,随即归还并回填进 baseUrl。
export function pickBackendAddress(baseUrl) {
  const target = new URL(baseUrl)
  const host = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname
  return new Promise((granted, denied) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', denied)
    probe.listen(0, host, () => {
      const address = probe.address()
      probe.close((closeError) => {
        if (closeError) return denied(closeError)
        target.hostname = host
        target.port = String(address.port)
        granted(target.origin)
      })
    })
  })
}

function applyBackendAddress(env, backend) {
  backendRuntimeDriver(backend.protocol).applyAddress?.(env, backend)
}

// 地址已被占(常见:开发态已有服务在听)→ 记录并让 OS 重发一个空闲口。
async function ensureFreeAddress(backend, { isAddressInUse, findFreeAddress, logger }) {
  if (!await isAddressInUse(backend.baseUrl)) return backend.baseUrl
  logger?.info('backend.address_reallocated', {
    backend: backend.protocol,
    requestedBaseUrl: backend.baseUrl,
  })
  return findFreeAddress(backend.baseUrl)
}

// 子进程规格:统一用当前 node(Electron 打包态即 ELECTRON_RUN_AS_NODE=1)拉驱动的托管脚本;
// POSIX 用独立进程组,便于整组回收。
function buildSpawnSpec(root, platform, env, driver) {
  const childEnv = backendEnvironment(driver.id, {
    env,
    additions: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const entry = resolve(root, `scripts/runtime/${driver.managedScript}`)
  return {
    command: process.execPath,
    args: [entry],
    options: {
      cwd: root,
      env: childEnv,
      detached: platform !== 'win32',
      stdio: 'inherit',
    },
  }
}

export class ManagedBackendHandle {
  constructor(child = null, {
    platform = process.platform,
    killImpl = process.kill,
  } = {}) {
    this.child = child
    this.platform = platform
    this.killImpl = killImpl
  }

  // 网关是否真的拉了子进程(false = 外部服务/无分支进程形态,无需回收)。
  get ownsProcess() {
    return Boolean(this.child)
  }

  close(signal = 'SIGTERM') {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return
    // POSIX 优先整组杀(负 pid);组可能在状态检查与信号之间已退出,容错降级单杀。
    if (this.platform !== 'win32' && Number.isInteger(child.pid)) {
      try {
        this.killImpl(-child.pid, signal)
        return
      } catch {
        // 组已退出,忽略。
      }
    }
    child.kill(signal)
  }

  // 宽限期内等退出,超时 SIGKILL;幂等(已终结的子进程直接返回)。
  async stop(signal = 'SIGTERM', timeoutMs = 1500) {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return
    this.close(signal)
    await new Promise(settled => {
      let done = false
      const settle = () => {
        if (done) return
        done = true
        clearTimeout(timeout)
        child.off?.('exit', settle)
        settled()
      }
      // 宽限到点升级 SIGKILL,不再等。
      const timeout = setTimeout(() => {
        this.close('SIGKILL')
        settle()
      }, timeoutMs)
      child.once?.('exit', settle)
    })
  }
}

// 启动托管后台。四种早退:无协议=无托管;驱动不分支进程/外部归属=网关不拉子进程。
export async function launchManagedBackend({
  root,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  isAddressInUse = backendAddressBusy,
  findFreeAddress = pickBackendAddress,
  logger,
} = {}) {
  const backend = resolveBackendLauncher(env)
  const driver = backend && backendRuntimeDriver(backend.protocol)
  const gatewaySpawned = backend && driver.separateManagedProcess && backend.ownership === 'owned'
  if (!gatewaySpawned) {
    if (backend && backend.ownership !== 'owned' && backend.ownership !== 'external') {
      throw new Error(`不支持的后台进程归属：${backend.ownership}`)
    }
    return new ManagedBackendHandle(null, { platform })
  }
  env.GENIE_BACKEND_OWNERSHIP = backend.ownership
  setBackendPermissionMode(env, backend)
  driver.prepareEnvironment?.(env, backend)
  if (!isLocalBackendKind(backend.baseUrl)) {
    throw new Error(`Gateway 只能启动本机后台 Agent：${backend.baseUrl}`)
  }
  backend.baseUrl = await ensureFreeAddress(backend, { isAddressInUse, findFreeAddress, logger })
  applyBackendAddress(env, backend)
  const spec = buildSpawnSpec(root, platform, env, driver)
  const child = spawnImpl(spec.command, spec.args, spec.options)
  logger?.info('backend.process_started', {
    backend: backend.protocol,
    pid: child.pid,
    baseUrl: backend.baseUrl,
    ownership: backend.ownership,
  })
  child.once?.('error', error => {
    logger?.error('backend.process_start_failed', { backend: backend.protocol, error })
  })
  return new ManagedBackendHandle(child, { platform })
}
