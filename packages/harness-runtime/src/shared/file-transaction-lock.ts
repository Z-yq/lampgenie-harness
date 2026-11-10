// @ts-nocheck — 跨进程文件事务锁 + Windows 安全替换(本仓自有实现;同类「目录即锁 +
// 按年龄回收 + 事务内读改写」的做法参考 qwen-audio-agent,致谢)。

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))
const nap = ms => Atomics.wait(sleepBuffer, 0, 0, ms)

function readOwnerRecord(lockPath) {
  // 新锁形态是目录 + owner.json;第二个候选路径兼容旧版遗留的文件锁。
  for (const candidate of [`${lockPath}/owner.json`, lockPath]) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'))
    } catch {
      // 旧形态文件锁在锁形态切换后仍可被识别与回收。
    }
  }
  return null
}

function olderThan(lockPath, now, staleMs) {
  try {
    return now() - statSync(lockPath).mtimeMs >= staleMs
  } catch (error) {
    // ENOENT = 锁已被释放(甚至被别人重新持有):不算陈旧,重试获取即可。
    // 其余 stat 失败也不是过期证明,必须原样上抛,不能动一个可能活着的锁。
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function takeAway(lockPath, tag) {
  const aside = `${lockPath}.stale.${tag}`
  try {
    renameSync(lockPath, aside)
  } catch {
    return false
  }
  rmSync(aside, { recursive: true, force: true })
  return true
}

function acquire(filePath, { timeoutMs = 2000, retryMs = 10, staleMs = 30_000, now = Date.now } = {}) {
  const lockPath = `${filePath}.lock`
  const token = randomUUID()
  const deadline = now() + timeoutMs
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })

  for (;;) {
    const owner = { token, pid: process.pid, createdAt: now() }
    try {
      // 锁原语 = 目录创建(本地文件系统上原子),避免文件锁暴露半写状态。
      mkdirSync(lockPath, { mode: 0o700 })
      try {
        writeFileSync(`${lockPath}/owner.json`, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600 })
      } catch (error) {
        // 窄窗竞态:他人可能在我们写下 owner.json 前观察到空目录并回收之。
        // 按一次失败的获取处理,不让调用方的事务失败。
        if (error?.code === 'ENOENT') continue
        rmSync(lockPath, { recursive: true, force: true })
        throw error
      }
      return () => {
        const current = readOwnerRecord(lockPath)
        if (current?.token !== token) return false
        return takeAway(lockPath, `released.${token}`)
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // 按年龄回收,不做 PID 探测:跨主机/容器 PID 不可见会让两个活进程都自认持锁。
      // 这里的事务同步且短,遗弃锁在有限的 stale 间隔后可回收。
      if (olderThan(lockPath, now, staleMs) && takeAway(lockPath, token)) continue
      if (now() >= deadline) {
        const timeout = new Error(`timed out waiting for shared file lock: ${filePath}`)
        timeout.code = 'shared_file_busy'
        throw timeout
      }
      nap(Math.min(retryMs, Math.max(1, deadline - now())))
    }
  }
}

// 共享档案文件被 Desktop 与 CLI 两个网关刻意共写;每次读改写都必须在同一个
// 跨进程事务内,独立运行时不能静默互相覆盖。
export function withFileTransaction(filePath, action, options) {
  if (!filePath) return action()
  const release = acquire(filePath, options)
  try {
    return action()
  } finally {
    release()
  }
}

const WINDOWS_BUSY_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

function renameWithRetry(source, target, retries, retryMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      const retryable = WINDOWS_BUSY_ERRORS.has(error?.code) && attempt < retries
      if (!retryable) throw error
      nap(retryMs)
    }
  }
}

// Windows 的 rename 不能稳定替换已存在的目标,还可能被读取器/杀软延迟。保留旧目标
// 作为可恢复备份再换新;调用方在事务锁内使用本函数,窄窗被锁保护。
export function replaceFileSync(temporaryPath, targetPath, { retries = 20, retryMs = 10 } = {}) {
  if (process.platform !== 'win32') {
    renameSync(temporaryPath, targetPath)
    return
  }

  try {
    renameSync(temporaryPath, targetPath)
    return
  } catch (error) {
    if (!WINDOWS_BUSY_ERRORS.has(error?.code)) throw error
  }

  const backupPath = `${targetPath}.replace.${randomUUID()}.bak`
  try {
    renameWithRetry(targetPath, backupPath, retries, retryMs)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    // 目标本不存在:直接换入即可。
    renameWithRetry(temporaryPath, targetPath, retries, retryMs)
    return
  }
  try {
    renameWithRetry(temporaryPath, targetPath, retries, retryMs)
  } catch (error) {
    try {
      renameWithRetry(backupPath, targetPath, retries, retryMs)
    } catch {
      // 回滚也被阻塞时,备份留在盘上等人工恢复。
    }
    throw error
  }
  rmSync(backupPath, { force: true })
}
