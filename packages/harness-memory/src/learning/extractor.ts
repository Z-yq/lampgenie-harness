// @ts-nocheck — 会话收尾自动记忆提取(隐形记忆设计 P0)。语音连接关闭后,轻量文本模型
// 读会话转写、对既有 Markdown 提议最小修改。管线刻意保守:语音产品没有确认界面,
// 正确性来自「写入保守 + 语音原生易纠正 + 审计留痕」,而不是问用户。
// 同类「session-end 提取 + 双文档边界」的领域模型参考 qwen-audio-agent(Apache-2.0,致谢),
// 本文件为独立实现;strict 类型化列入 backlog。
//
// 代码级安全不变量(不得弱化):
// - 一切写入都走与 Realtime 记忆工具相同的 MemoryProvider 运行时;提取器不直接改文档。
// - USER.md 只收显式交互指令;MEMORY.md 拒收指令形内容。
// - 失败静默:提取绝不拖慢/打断会话收尾,也绝不产生语音。

import { firstJsonObject } from "../text-utils";

const DOC_KINDS = new Set(['user', 'memory'])
const MAX_OPS_PER_RUN = 5
const MAX_PATCH_CHARS = 1000

// 提取提示词之后的第二道敏感内容闸。刻意保守:误报丢一条候选事实,
// 误漏则持久化一个秘密——两种错误不对称。
const SECRET_LIKE_PATTERNS = [
  /(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)/i,
  /(?:密码|密钥|口令|验证码|令牌|证件号|身份证)/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\b\d{11,19}\b/,
  /[A-Za-z0-9+/]{40,}={0,2}/,
]

// 提取输出的文档边界分类器:USER.md 必须是指令形,MEMORY.md 拒收同一形态。
const INTERACTION_DIRECTIVE_PATTERNS = [
  /(?:我叫|我的名字|用户姓名|用户身份)/,
  /(?:叫我|称呼我|如何称呼|我的称呼)/,
  /(?:你|助手).{0,12}(?:叫|自称|名字|称为)/,
  /(?:你|助手).{0,12}(?:像|作为|当作).{0,8}(?:朋友|伙伴|老师|教练|秘书|助理)/,
  /(?:回复|回答|说话|表达).{0,12}(?:简短|简洁|详细|展开|正式|随意|语气|风格)/,
  /(?:默认|以后).{0,12}(?:中文|英文|语言|时区|称呼|回复|回答)/,
  /(?:用户)?.{0,8}(?:希望|要求|让|请).{0,8}(?:助手|你).{0,30}(?:每次|每回|始终|总是|以后|默认|开头|结尾|加上|带上|说一句)/,
  /(?:助手|你).{0,20}(?:回复|回答|说话|表达|对话).{0,20}(?:每次|开头|结尾|加上|带上|说)/,
  /(?:每次|每回|以后|默认).{0,12}(?:回复|回答|说话|表达|称呼)/,
  /(?:回复|回答|说话|表达|对话).{0,12}(?:开头|结尾|加上|带上|说一句)/,
  /(?:助手称呼用户|用户称呼助手)/,
]

// 转写层面判定「用户真的亲口下过指令」;USER.md 的写入门槛。
const TRANSCRIPT_DIRECTIVE_PATTERNS = [
  /(?:以后|今后|从现在|每次|每回|始终|总是|默认|不要再|别再).{0,40}(?:叫|称呼|回复|回答|说|使用|用|加|带)/,
  /(?:叫我|称呼我|你叫|你以后叫|我叫你)/,
  /(?:我希望|我想让你|请你|你要).{0,40}(?:叫|称呼|回复|回答|说|表达|使用|加|带)/,
  /(?:回复|回答|说话|表达).{0,20}(?:简短|简洁|详细|正式|随意|温柔|慢一点|快一点)/,
]

const EXTRACTOR_SYSTEM_PROMPT = [
  '你维护语音助手的 USER.md 和 MEMORY.md。根据对话转写，对现有普通 Markdown 做一次最小修改。',
  '只输出一个 JSON 对象，不要输出任何其他文字。格式：',
  '{"changes":[{"document":"user 或 memory","edits":[{"old_text":"文档中的精确原文","new_text":"替换后的 Markdown"}],"append":"追加的 Markdown 块"}]}',
  '',
  '规则：',
  '- user 只保存用户本人明确提出、会直接改变未来交互方式的长期指令：称呼、关系、助手在该用户面前的名称、语言、表达风格和默认做法。不得推测。',
  '- memory 只保存用户本人明确陈述、稳定且具有跨会话价值的非交互事实与决定：所在地、习惯、兴趣、人际关系事实、项目、长期目标或计划。不得推测。',
  // 别在这条规则上再加「不要把对话原话当 old_text」之类的强调 —— 试过了，
  // A/B 各 15 轮同时段交替发起：edit 误用率 73% → 73%，一点没降，只是把写入
  // 成功率从 MEMORY 挪到了 USER（60%→20% / 13%→47%），总量还少 1。
  // 模型误用 edits 这件事靠 prompt 管不住，已改为在 dropDeadEdits 里
  // 结构性兜住。
  '- edits 用于更正或删除已有内容；old_text 必须逐字来自对应的现有文档且只出现一次。删除时 new_text 为空。',
  '- append 是追加到对应文档的完整 Markdown 块，可包含多项信息并使用合适的小标题；没有新增时为空字符串。',
  '- 保持文档简洁、自然、可直接由人阅读，不添加 ID、时间戳、来源或 JSON 字段。',
  '- 不提取：一次性情绪、临时安排、本次任务的执行细节、助手自身的行为、常识、随时可以再查到的事实。',
  '- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
  '- 已有内容覆盖的信息不要重复追加；新陈述明确纠正旧内容时用 edits 替换，并清理另一个文档中放错位置或冲突的旧内容。',
  '- 同一文档的修改合并为一个 change，每个 document 最多出现一次。',
  '- 没有值得修改的内容时输出 {"changes":[]}。',
].join('\n')

function matchesAny(value, patterns) {
  return patterns.some(pattern => pattern.test(value))
}

// 与 MarkdownDocStore 的 old_text 判定同口径:不重叠计数,必须恰好一次。
// 两处口径必须一致,否则这里放行的 edit 会在 prepareEdit 里再次被拒。
function countNonOverlapping(content, needle) {
  if (!needle) return 0
  let hits = 0
  let at = content.indexOf(needle)
  while (at >= 0) {
    hits += 1
    at = content.indexOf(needle, at + needle.length)
  }
  return hits
}

function clampPatch(value) {
  const normalized = String(value || '').replaceAll('\0', '').replace(/\r\n?/g, '\n').trim()
  return Array.from(normalized).slice(0, MAX_PATCH_CHARS).join('')
}

// 摘掉落不了地的 edit。
//
// 模型很容易把【对话里的原话】当成 old_text,而 old_text 必须是【现有文档里】的
// 原文;文档还是空模板时更是必错。这类 edit 在 prepareEdit 里会抛错,而 apply 是
// 整批原子的 —— 一条坏 edit 会连带丢掉同批完全正确的 append。
//
// 这里按顺序在副本上模拟替换(edits 是顺序应用的,后一条可能依赖前一条的结果),
// 找不到或出现多次的单独摘出去,保住其余部分。
//
// 已知限制:这里用 memoryService.list() 的内容,与喂给模型的是同一份,视角一致;
// 但 prepareEdit 用未截断原文。文档超过注入预算时,被截断部分若含重复文本,
// 仍可能在 prepareEdit 处判为 ambiguous 而整批失败。那种情况 read 侧本就有
// 截断告警,属可接受的窄边界。
function dropDeadEdits(edits = [], currentContent = '') {
  let working = String(currentContent || '')
  const alive = []
  const dead = []
  for (const edit of edits) {
    const anchor = String(edit?.old_text || '').trim()
    const hits = countNonOverlapping(working, anchor)
    if (hits !== 1) {
      dead.push({
        reason: anchor ? (hits ? 'ambiguous' : 'not_found') : 'empty',
        old_text: anchor.slice(0, 40),
      })
      continue
    }
    working = working.replace(anchor, String(edit?.new_text || ''))
    alive.push(edit)
  }
  return { kept: alive, dropped: dead }
}

// 模型可能在 JSON 外包 Markdown 围栏,或无视指令补一句解释。
// 只取第一个完整 JSON 对象:无害的后缀不该作废本已有效的记忆补丁。
function parseChanges(text) {
  const raw = String(text || '').trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed = JSON.parse(firstJsonObject(unfenced))
  if (!parsed || !Array.isArray(parsed.changes)) {
    throw new Error('extractor output has no changes array')
  }
  return parsed.changes.slice(0, 2).map(change => ({
    document: String(change?.document || '').trim().toLowerCase(),
    edits: Array.isArray(change?.edits)
      ? change.edits.slice(0, MAX_OPS_PER_RUN).map(edit => ({
          old_text: clampPatch(edit?.old_text),
          new_text: clampPatch(edit?.new_text),
        }))
      : [],
    append: clampPatch(change?.append),
  }))
}

// 预算内的转写行;超预算时保留最近的轮次。
function transcriptLines(messages, maxChars) {
  const kept = []
  let used = 0
  for (const message of messages.toReversed()) {
    const content = String(message.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const line = `${message.role === 'user' ? '用户' : '助手'}: ${content}`
    if (kept.length && used + line.length > maxChars) break
    kept.unshift(line)
    used += line.length
  }
  return kept
}

function looksSecret(value) {
  return matchesAny(value, SECRET_LIKE_PATTERNS)
}

function isInteractionDirective(value) {
  return matchesAny(value, INTERACTION_DIRECTIVE_PATTERNS)
}

// 转写里用户是否亲口说过指令形的话(只看用户行)。
function transcriptHasExplicitDirective(lines) {
  const userSaid = lines.filter(line => line.startsWith('用户:')).join('\n')
  return matchesAny(userSaid, TRANSCRIPT_DIRECTIVE_PATTERNS)
}

// change 形状校验:文档名合法、不重复、每条至少有一个操作。
function changesAreWellFormed(changes) {
  const documents = changes.map(change => change.document)
  const knownDocs = documents.every(document => DOC_KINDS.has(document))
  const uniqueDocs = new Set(documents).size === documents.length
  const hasOperation = changes.every(change => change.edits.length > 0 || change.append)
  return knownDocs && uniqueDocs && hasOperation
}

// 提议写入的全部新文本(供敏感闸扫描)。
function proposedText(changes) {
  return changes
    .flatMap(change => [...change.edits.map(edit => edit.new_text), change.append])
    .join('\n')
}

// 文档边界:新增内容必须匹配目标文档的语义(user=指令形,memory=非指令形)。
function respectsDocumentBoundary(changes) {
  return !changes.some((change) => {
    const additions = [...change.edits.map(edit => edit.new_text), change.append].filter(Boolean).join('\n')
    if (!additions) return false
    return change.document === 'user'
      ? !isInteractionDirective(additions)
      : isInteractionDirective(additions)
  })
}

export class MemoryMiner {
  constructor({
    memoryService,
    conversationSync,
    audit = null,
    llmCall = null,
    logger = console,
    now = () => Date.now(),
    debounceMs = 30 * 60_000,
    minUserMessages = 4,
    maxTranscriptChars = 6000,
  } = {}) {
    this.memoryService = memoryService
    this.conversationSync = conversationSync
    this.audit = audit
    this.llmCall = llmCall
    this.logger = logger
    this.now = now
    this.debounceMs = debounceMs
    this.minUserMessages = minUserMessages
    this.maxTranscriptChars = maxTranscriptChars
    this.lastRunAt = new Map()
  }

  enabled() {
    return typeof this.llmCall === 'function' && Boolean(this.memoryService)
  }

  // Fire-and-forget 的会话收尾钩子。闸门全部同步判定,跳过零成本;
  // 返回 promise 仅供测试,永不 reject。
  maybeRun({ ownerId, sessionId }) {
    if (!this.enabled()) return null
    const owner = String(ownerId || '')
    if (!owner) return null
    // 只对真正的新学习批做去抖;恢复的历史对话不算。
    const previous = this.lastRunAt.get(owner)
    if (previous !== undefined && this.now() - previous < this.debounceMs) {
      return null
    }
    const batch = this.conversationSync?.pendingRecords?.({ ownerId: owner, sessionId }, this)
    const messages = batch?.messages || []
    const userTurns = messages.filter(message => message.role === 'user')
    if (userTurns.length < this.minUserMessages) return null
    batch.consume()
    this.lastRunAt.set(owner, this.now())
    return this.run({ ownerId: owner, messages, isCurrent: batch.isCurrent }).catch((error) => {
      this.audit?.record({ op: 'error', ownerId: owner, error: String(error?.message || error) })
      this.logger?.warn?.('memory.extract_failed', { error: String(error?.message || error) })
    })
  }

  async run({ ownerId, messages, isCurrent = () => true }) {
    const lines = transcriptLines(messages, this.maxTranscriptChars)
    if (!lines.length) return
    const existing = this.memoryService.list(ownerId)
    const documents = new Map(existing.map(document => [document.scope, document]))

    const user = [
      '## 当前 USER.md',
      documents.get('user')?.content || '# USER',
      '',
      '## 当前 MEMORY.md',
      documents.get('memory')?.content || '# MEMORY',
      '',
      '## 对话转写',
      lines.join('\n'),
    ].join('\n')
    const response = await this.llmCall({ system: EXTRACTOR_SYSTEM_PROMPT, user })

    if (!isCurrent()) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'stale_observation' })
      return
    }
    let changes
    try {
      changes = parseChanges(response)
    } catch {
      this.audit?.record({ op: 'skip', ownerId, reason: 'invalid_change' })
      return
    }
    if (!changes.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'no_change' })
      return
    }
    if (!changesAreWellFormed(changes)) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'invalid_change' })
      return
    }
    if (looksSecret(proposedText(changes))) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'sensitive' })
      return
    }

    // 摘掉落不了地的 edit(见 dropDeadEdits 注释)。必须排在边界校验之前:
    // 被摘掉的 new_text 不会写入,不该参与「该进哪个文档」的判断。
    const deadEdits = []
    const applicable = []
    for (const change of changes) {
      const current = documents.get(change.document)?.content || ''
      const { kept, dropped } = dropDeadEdits(change.edits, current)
      deadEdits.push(...dropped.map(item => ({ document: change.document, ...item })))
      if (kept.length || change.append) applicable.push({ ...change, edits: kept })
    }
    if (deadEdits.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'edit_not_applicable', detail: deadEdits })
    }
    if (!applicable.length) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'no_applicable_change' })
      return
    }
    if (!respectsDocumentBoundary(applicable)) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'document_boundary' })
      return
    }
    if (
      applicable.some(change => change.document === 'user')
      && !transcriptHasExplicitDirective(lines)
    ) {
      this.audit?.record({ op: 'skip', ownerId, reason: 'user_directive_not_explicit' })
      return
    }

    const prepared = applicable.map(change => ({
      ...change,
      expectedRevision: documents.get(change.document)?.revision || '',
    }))
    const editCount = prepared.reduce((sum, change) => sum + change.edits.length, 0)
    const anyAppend = prepared.some(change => Boolean(change.append))
    try {
      const result = await this.memoryService.apply(ownerId, prepared, { source: 'automatic-extraction' }, isCurrent)
      if (!result) {
        this.audit?.record({ op: 'skip', ownerId, reason: 'stale_observation' })
        return
      }
      this.audit?.record({
        op: 'patch',
        ownerId,
        documents: prepared.map(change => change.document),
        changed: result.changed,
        beforeRevisions: Object.fromEntries(prepared.map(change => [
          change.document,
          documents.get(change.document)?.revision || null,
        ])),
        afterRevisions: Object.fromEntries(result.documents.map(document => [
          document.scope,
          document.revision,
        ])),
        edits: editCount,
        appended: anyAppend,
      })
      this.logger?.debug?.('memory.extract_completed', {
        documents: prepared.map(change => change.document),
        edits: editCount,
        appended: anyAppend,
        changed: result.changed,
      })
    } catch (error) {
      this.audit?.record({ op: 'error', ownerId, error: String(error?.message || error) })
    }
  }
}
