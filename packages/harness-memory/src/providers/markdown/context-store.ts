// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  replaceFileSync,
  withFileTransaction,
} from '@lampgenie/runtime/shared/file-transaction-lock'

const MAX_EDIT_ITEMS = 20

function tidyText(value) {
  return String(value || '').replaceAll('\0', '').replace(/\r\n?/g, '\n')
}

// 修订号 = 内容摘要前 16 位(hex)。只用于乐观并发判断,不是安全摘要。
function shortDigest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

// 统一的编辑错误:错误码是调用方(提取器/晋升器)路由依据,不可改名。
function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function publicDocument(scope, content, revisionSource = content) {
  return {
    id: `${scope}_document`,
    scope,
    content,
    format: 'markdown',
    revision: shortDigest(revisionSource),
    editable: true,
  }
}

// 不重叠计数;edit 的 old_text 必须恰好命中一次。
function countDistinctMatches(content, needle) {
  if (!needle) return 0
  let hits = 0
  let at = content.indexOf(needle)
  while (at >= 0) {
    hits += 1
    at = content.indexOf(needle, at + needle.length)
  }
  return hits
}

// 追加路径的整理:去空 bullet、去重 bullet、丢空节、压连续空行。
function tidyMarkdown(content) {
  const seenBullets = new Set()
  const kept = tidyText(content)
    .split('\n')
    .filter(line => !/^\s*[-*+]\s*$/.test(line)) // 只有一个点没有字的 bullet 行
    .filter((line) => {
      const bullet = line.match(/^\s*[-*+]\s+(.+?)\s*$/)
      if (!bullet) return true
      const item = bullet[1].replace(/\s+/g, ' ').trim()
      if (seenBullets.has(item)) return false
      seenBullets.add(item)
      return true
    })
 // 空节清理:标题后紧跟标题/EOF = 无内容节,整节丢弃
 // (经验证 USER.md 积累 69 个空「## 用户明确要求」,每个都白烧注入 token)。
  return dropEmptySections(kept)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** 去掉「标题后无正文」的空节(标题行本身也丢弃)。 */
export function dropEmptySections(lines) {
  const isHeading = l => /^#{1,6}\s+\S/.test(l)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i])) {
      let j = i + 1
      while (j < lines.length && !String(lines[j] || '').trim()) j++
      if (j >= lines.length || isHeading(lines[j])) continue
    }
    out.push(lines[i])
  }
  return out
}

export class MarkdownDocStore {
  constructor({
    filePath,
    scope,
    personalOwnerId = 'user_personal',
    maxChars = 8000,
    // maxChars 是「注入预算」而非存储上限：超出后仍然写盘保留全量，
    // 只在 read()/list() 注入时截断并给出告警（读写两侧行为一致）。
    // hardMaxChars 是防失控的绝对上限，只有它才拒绝写入。
    hardMaxChars = null,
    template = '',
    onWarning = warning => console.warn(warning.message),
  } = {}) {
    this.filePath = filePath
    this.scope = scope
    this.personalOwnerId = String(personalOwnerId)
    this.maxChars = maxChars
    this.hardMaxChars = Number(hardMaxChars) > 0
      ? Number(hardMaxChars)
      : maxChars * 4
    this.template = tidyText(template).trimEnd()
    this.onWarning = onWarning
    this.warning = null
  }

  // 个人文档=配置路径本体;其他 owner 隔离到 users/<摘要>/ 子目录(摘要防注入)。
  pathFor(ownerId) {
    if (!this.filePath) return null
    const owner = String(ownerId || this.personalOwnerId)
    if (owner === this.personalOwnerId) return this.filePath
    return join(dirname(this.filePath), 'users', shortDigest(owner), basename(this.filePath))
  }

  // 注入预算截断:超出部分丢弃并附截断说明(存储仍是全量)。
  #clipForInjection(content) {
    if ([...content].length <= this.maxChars) return content
    return `${[...content].slice(0, this.maxChars).join('')}\n\n<!-- 内容过长，已截断；精确编辑前请缩小文档 -->`
  }

  // 注入用读取(截断版);list() 走同一裁剪。
  read(ownerId) {
    return this.#clipForInjection(this.readRaw(ownerId))
  }

  readRaw(ownerId) {
    const path = this.pathFor(ownerId)
    if (!path) return ''
    try {
      const content = text(readFileSync(path, 'utf8')).trim()
      if ([...content].length > this.maxChars) {
        // 文档现状就超预算（可能由上一次写入或外部编辑造成）——注入会被截断，
        // 这个状态必须让上层看见，而不是被"读成功"清掉。
        this.warn(
          `${basename(path)} 已超过注入预算 ${this.maxChars} 个字符`
          + `（当前 ${[...content].length}）：注入时会被截断。`,
          { overBudget: true },
        )
      } else {
        this.warning = null
      }
      return content
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      this.warn(`无法读取 ${basename(path)}：${error.message}`)
      return ''
    }
  }

  list(ownerId) {
    const raw = this.readRaw(ownerId)
    if (!raw) return []
    return [publicDocument(this.scope, this.#clipForInjection(raw), raw)]
  }

  // 编辑入口:同一路径的读-改-写锁在一次跨进程事务里,独立运行时不能互相覆盖。
  edit(ownerId, { edits = [], append = '', expectedRevision = '' } = {}) {
    const path = this.pathFor(ownerId)
    return withFileTransaction(path, () => {
      const prepared = this.prepareEdit(ownerId, { edits, append, expectedRevision })
      if (!prepared.changed) return { changed: 0, document: prepared.document }
      this.persist(ownerId, `${prepared.content}\n`)
      return { changed: prepared.changed, document: prepared.document }
    })
  }

  prepareEdit(ownerId, {
    edits = [],
    append = '',
    expectedRevision = '',
  } = {}) {
    const current = this.readRaw(ownerId) || this.template
    // 乐观并发:revision 对不上 = 文档被别人改过,强制重读后再编辑。
    if (expectedRevision && expectedRevision !== shortDigest(current)) {
      throw fail('stale_document', 'memory document changed; read it again before editing')
    }
    const operations = Array.isArray(edits) ? edits.slice(0, MAX_EDIT_ITEMS) : []
    // 逐条应用替换(edits 顺序语义:后一条可能依赖前一条的结果)。
    let next = current
    let changed = 0
    for (const operation of operations) {
      const anchor = tidyText(operation?.old_text)
      const patchWith = tidyText(operation?.new_text)
      if (!anchor) throw fail('invalid_edit', 'old_text is required for an exact edit')
      const matches = countDistinctMatches(next, anchor)
      if (matches !== 1) {
        const why = matches ? 'old_text must match exactly once' : 'old_text was not found'
        throw fail(matches ? 'ambiguous_edit' : 'edit_not_found', why)
      }
      next = next.replace(anchor, patchWith)
      changed += 1
    }
    const addition = tidyText(append).trim()
    if (addition) {
      next = `${next.trimEnd()}\n\n${addition}\n`
      changed += 1
    }
    // 精确编辑不得重写无关行/注释/占位符;只有追加路径才顺带做格式清理
    // (保持尾随空白约定,返回的 revision 才能和落盘读回一致)。
    next = operations.length ? next.trimEnd() : normalizeMarkdown(next)
    const unchanged = !changed || next === current.trimEnd()
    if (unchanged) {
      return {
        changed: 0,
        content: current.trimEnd(),
        document: publicDocument(this.scope, current),
      }
    }
    this.#enforceSizeBudget(next)
    return {
      changed,
      content: next,
      document: publicDocument(this.scope, next),
    }
  }

  // 只有绝对上限才拒绝写;注入预算(maxChars)被突破时仍全量写盘,由 read()/list()
  // 截断并告警——用户的记忆不能因为「太长」就写不进去。
  #enforceSizeBudget(next) {
    const length = [...next].length
    if (length > this.hardMaxChars) {
      throw fail(
        'document_too_large',
        `${basename(this.filePath)} 已超出绝对上限 ${this.hardMaxChars} 个字符，请先精简`,
      )
    }
    if (length > this.maxChars) {
      this.warn(
        `${basename(this.filePath)} 已超过注入预算 ${this.maxChars} 个字符`
        + `（当前 ${length}）：内容已完整写盘，但注入时会被截断。`,
        { overBudget: true },
      )
    }
  }

  // 原子落盘(tmp → replace → chmod 600)。
  // 写成功清除 I/O 类告警,但「超出注入预算」这类现状告警保留:它描述的是
  // 文档形态(注入会被截断),不因写成功而消失。
  persist(ownerId, content) {
    const path = this.pathFor(ownerId)
    if (!path) throw new Error('memory document is unavailable')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const staging = `${path}.${process.pid}.tmp`
    writeFileSync(staging, content, { encoding: 'utf8', mode: 0o600 })
    replaceFileSync(staging, path)
    chmodSync(path, 0o600)
    if (!this.warning?.overBudget) this.warning = null
  }

  // 记录并外发告警;观察者抛错不允许拖垮语音服务。
  warn(message, { overBudget = false } = {}) {
    this.warning = { message, at: Date.now(), overBudget }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // 告警观察者的失败被吞掉(诊断通道不能反噬主链)。
    }
  }

  health() {
    return {
      ok: !this.warning,
      configured: Boolean(this.filePath),
      warning: this.warning,
    }
  }
}
