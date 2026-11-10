// @ts-nocheck — 小型 JSON 快照持久化基类(本仓自有实现;同类「原子写 + 损坏隔离 +
// 降级禁写 + mtime/哈希双重变化检测」的健壮性组合参考 qwen-audio-agent,致谢)。
// 只负责「把 JSON 快照安全落盘、下次启动读回」;数据模型对它不透明,serialise/deserialise
// 由使用方自理。写入范式:
//   · 原子写:tmp → replaceFileSync → chmod 600
//   · 损坏隔离:JSON 解析失败搬到 .corrupt-<ts>,服务带空快照继续跑
//   · I/O 失败降级:setWarning + 关闭持久化,不阻塞主链路
//   · mtime + 内容哈希双重检测:NTFS 与快速连续写入可能落同一时间刻度
// fileVersion 由子类指定,数据模型变更必须递增:版本不匹配走 quarantine(否则旧文件会被
// 当新格式逐条校验、全部丢弃、静默变空)。

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileSync } from '../shared/file-transaction-lock'

function fingerprint(data) {
  return createHash('sha1').update(data).digest('hex')
}

export class JsonCheckpointStore {
  constructor({
    filePath = null,
    fileVersion = 1,
    label = '数据', // 只进警告文案,方便运维定位是哪份数据
    requiredKeys = [], // 快照里除 version 外必须存在的顶层对象字段(挡旧格式)
    now = () => Date.now(),
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.fileVersion = fileVersion
    this.label = label
    this.requiredKeys = requiredKeys
    this.now = now
    this.onWarning = onWarning
    this.persistenceDisabled = false
    this.warning = null
    // 载入时点的磁盘指纹(mtime + 内容哈希),hasChanged 用它判断「别人改过没」。
    this.loadedMtimeMs = 0
    this.loadedContentHash = ''
  }

  configured() { return Boolean(this.filePath) }

  enabled() { return this.configured() && !this.persistenceDisabled }

  // 损坏、版本不符或缺字段时返回 null;上层据此决定是否走空快照。
  load() {
    if (!this.filePath) return null
    let raw
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      this.disablePersistence(`无法读取${this.label}文件：${error.message}`)
      return null
    }
    this.loadedMtimeMs = this.fileMtimeMs()
    this.loadedContentHash = fingerprint(raw)
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.quarantine(`${this.label}文件不是有效的 JSON：${error.message}`)
      return null
    }
    const versionOk = parsed && parsed.version === this.fileVersion
    if (!versionOk || !this.hasRequiredKeys(parsed)) {
      this.quarantine(`${this.label}文件格式无效`)
      return null
    }
    return parsed
  }

  hasRequiredKeys(parsed) {
    const isPlainObject = key => {
      const slot = parsed[key]
      return Boolean(slot) && typeof slot === 'object' && !Array.isArray(slot)
    }
    return this.requiredKeys.every(isPlainObject)
  }

  // 磁盘可能被其它 Gateway 更新过时由上层调用;true = 磁盘有新变化,需重新 load。
  // mtime 与内容哈希双重判断:NTFS 与快速连写可能落同一时间刻度。
  hasChanged() {
    if (!this.enabled()) return false
    const mtimeMoved = this.fileMtimeMs() !== this.loadedMtimeMs
    return mtimeMoved || this.currentContentHash() !== this.loadedContentHash
  }

  // 原子写;任何失败降级为「禁写 + 告警」,主链路不被持久化问题拖住。
  save(snapshot) {
    if (!this.filePath) return true
    if (this.persistenceDisabled) return false
    try {
      this.#writeAtomically(snapshot)
      this.loadedMtimeMs = this.fileMtimeMs()
      this.loadedContentHash = this.currentContentHash()
      return true
    } catch (error) {
      this.disablePersistence(`无法写入${this.label}文件：${error.message}`)
      return false
    }
  }

  #writeAtomically(snapshot) {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const body = `${JSON.stringify({ version: this.fileVersion, ...snapshot }, null, 2)}\n`
    const staging = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(staging, body, { encoding: 'utf8', mode: 0o600 })
    replaceFileSync(staging, this.filePath)
    chmodSync(this.filePath, 0o600)
  }

  // 磁盘指纹:mtime(便宜,先看)与内容哈希(贵,确认用)。异常一律按「无信息」。
  fileMtimeMs() {
    try {
      return statSync(this.filePath).mtimeMs
    } catch {
      return 0
    }
  }

  currentContentHash() {
    try {
      return fingerprint(readFileSync(this.filePath))
    } catch {
      return ''
    }
  }

  // 损坏隔离:把可疑文件搬到 .corrupt-<ts>,服务带空快照继续跑;搬不动则直接禁写。
  quarantine(reason) {
    const sideCar = `${this.filePath}.corrupt-${this.now()}`
    try {
      renameSync(this.filePath, sideCar)
      this.note(
        `${reason}；原文件已隔离为 ${sideCar}，服务将使用空${this.label}继续运行。`,
        sideCar)
    } catch (error) {
      this.persistenceDisabled = true
      this.note(
        `${reason}；隔离失败（${error.message}），已禁用${this.label}持久化以保护原文件。`,
      )
    }
  }

  disablePersistence(message) {
    this.persistenceDisabled = true
    this.note(`${message}；已禁用${this.label}持久化，服务将继续运行。`)
  }

  // 记录并外发告警;观察者抛错不允许拖垮服务启动。
  note(message, quarantinePath = null) {
    this.warning = { message, quarantinePath, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // 告警通道的失败被吞掉(诊断不能反噬主链)。
    }
  }

  health() {
    const clean = !this.warning
    return { ok: clean, persistenceEnabled: this.enabled(), warning: this.warning }
  }
}
