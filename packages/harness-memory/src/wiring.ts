// Gateway-facing integration glue for @lampgenie/memory.
// createMemoryWiring() bundles the four memory pieces (context renderer,
// session-end extractor, profile observer, preference pool/promoter; their
// domain model design-references the qwen-audio-agent project — attribution
// in NOTICE.md) behind a markdown provider rooted at a directory, and exposes
// the three hooks a voice/agent gateway
// actually needs: render a prompt context block, feed a closed session's
// transcript to the learning pipelines, and promote confirmed profile
// candidates into USER.md.
// PORTING NOTES (read before "fixing" anything here):
// 1. MarkdownDocumentStore is a behavior-preserving typed port of
//    src/providers/markdown/context-store.ts. The original cannot be imported:
//    it does `import ... from '../../../../../shared/file-transaction-lock'`,
//    which resolves to `<repo>/shared/` — the file actually lives at
//    packages/harness-runtime/src/shared/. The ported module is @ts-nocheck, so
//    tsc never surfaced this. Deviation: the cross-process withFileTransaction
//    lock is dropped (single-process gateway assumption); writes stay atomic
//    via tmp file + rename, mode 0600, directory 0700, exactly like the
//    original persist().
// 2. ProfileWatcher is a behavior-preserving typed port of
//    src/learning/profile-observer.ts. The original cannot be imported either:
//    it imports `@lampgenie/runtime/src/core/sensitive-content`, which the
//    runtime exports map resolves to `src/src/core/sensitive-content.ts` under
//    the development condition and `dist/src/core/sensitive-content.js` under
//    the default condition — neither path exists (the runtime builds to
//    dist/core/..., and no condition falls through). The correct specifier is
//    `@lampgenie/runtime/core/sensitive-content`, which this port uses.
//    When the original module's import is fixed, prefer it and delete this
//    port. All structural guards are preserved verbatim: evidence quote must
//    appear in the user's own words, values must be anchored in the quote,
//    interaction fields must point at the assistant, unknown answers are
//    digested silently, list values are split before validation, and the
//    sensitive-content gate stays on the single runtime implementation.
// 3. PreferencePoolFileStore implements the store contract
//    PreferenceDraftPool expects (load/save/health/configured/enabled)
//    with the same v2 snapshot format as learning/preference-candidate-store.ts
//    ({version: 2, owners, blocklist}), so the JSON file stays compatible with
//    the original store class. The original is likewise un-importable (broken
//    runtime deep specifier, and its base JsonCheckpointStore imports the same
//    out-of-repo shared module). Corruption is quarantined to
//    `<file>.corrupt-<ts>`; I/O failures disable persistence instead of
//    throwing, matching JsonCheckpointStore's fail-soft contract.
// The real MemoryMiner / PreferenceDraftPool / PreferenceAdvancer /
// MarkdownMemoryStore classes ARE importable and are used directly; their
// @ts-nocheck declarations expose hostile constructor types (e.g. `llmCall?:
// null`, injected stores typed `null`, un-annotated params dropped from the
// emitted signature), so each constructor is cast exactly once below and the
// instances are surfaced through the explicit interfaces defined here.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { buildMemoryBriefing } from './context'
import { SnapshotCache } from './snapshot'
// 冻结/召回门是包级公共面(网关 agent-wiring 直接用),经 index 的 `export *` 透出。
export * from './snapshot'
import { MemoryMiner } from './learning/extractor'
import {
  PROFILE_KEYS,
  PreferenceDraftPool,
} from './learning/preference-candidates'
import { PreferenceAdvancer } from './learning/preference-promoter'
import { MarkdownMemoryStore } from './providers/markdown/provider'
import { hasSensitiveText } from '@lampgenie/runtime/core/sensitive-content'
import { clean, firstJsonObject } from "./text-utils";

// ---------------------------------------------------------------------------
// Shared contracts
// ---------------------------------------------------------------------------

export interface MemoryAuditEvent {
  op: string
  ownerId: string
  [key: string]: unknown
}

export interface MemoryAuditSink {
  record(event: MemoryAuditEvent): void
}

/** Real learning-pipeline LLM contract: both ported components call
 *  `llmCall({ system, user })` and expect the model's text back. */
export interface MemoryLlmRequest {
  system: string
  user: string
}

export type MemoryLlmCall = (request: MemoryLlmRequest) => Promise<string>

export interface MemoryLogger {
  warn?: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What the ported learning components read via conversationSync. */
export interface TranscriptBatch {
  messages: TranscriptMessage[]
  isCurrent: () => boolean
  consume: () => void
}

export interface ConversationSyncPort {
  pendingRecords(
    query: { ownerId: string; sessionId?: string },
    component?: unknown): TranscriptBatch
}

export interface SessionCloseInput {
  ownerId: string
  sessionId?: string
  transcript: TranscriptMessage[]
}

export interface MemoryChange {
  document: string
  edits?: { old_text: string; new_text: string }[]
  append?: string
  expectedRevision?: string
}

export interface MemoryDocumentLike {
  id?: string
  scope: string
  content: string
  format?: string
  revision?: string
  editable?: boolean
}

export interface MemoryProviderInstance {
  describe(): {
    protocolVersion: number
    key: string
    label: string
    capabilities: { semanticQuery: boolean; sessionObservation: boolean }
  }
  list(ownerId: string, options?: { scope?: string | null }): MemoryDocumentLike[]
  apply(
    ownerId: string,
    changes: MemoryChange[],
    context?: unknown,
    isCurrent?: unknown): { changed: number; documents: unknown[] }
  health(): { ok: boolean; documents: Record<string, unknown> }
}

export type CandidateSlotState = 'tentative' | 'active' | 'rejected'
export type CandidateRelation = 'same' | 'refine' | 'contradict'

export interface CandidateEvidence {
  sessionId: string
  quote: string
  basis: string
}

export interface CandidateSlotView {
  key: string
  field: string
  value: string
  confirm: number
  sessions: string[]
  firstAt: number
  lastAt: number
  evidence: CandidateEvidence[]
  state: CandidateSlotState
  resolvedAt?: number
  label: string
  ready: boolean
  missing: string[]
  confirmTarget: number
  sessionTarget: number
  sessionCount: number
}

export interface CandidatePoolInstance {
  observe(input: {
    ownerId: string
    sessionId?: string
    field: string
    value: string
    quote?: string
    basis?: string
    relation?: CandidateRelation | null
  }): CandidateSlotView | null
  list(
    ownerId: string,
    options?: { state?: CandidateSlotState | null; field?: string | null },
  ): CandidateSlotView[]
  promotable(ownerId: string): CandidateSlotView[]
  isCurrent(ownerId: string, snapshot: CandidateSlotView): boolean
  markPromoted(ownerId: string, candidate: CandidateSlotView | string): CandidateSlotView | null
  reject(input: { ownerId: string; key?: string; field?: string; value?: string }): CandidateSlotView | null
  discardPending(ownerId: string): number
  blocked(ownerId: string, field: string, value: string): boolean
  stats(ownerId: string): { tentative: number; active: number; rejected: number; blocked: number }
  diagnose(ownerId: string): unknown
  health(): {
    ok: boolean
    persistenceConfigured: boolean
    persistenceEnabled: boolean
    warning: { message: string; at: number } | null
    owners: number
  }
  reload(): void
  serialise(): { owners: Record<string, unknown[]>; blocklist: Record<string, string[]> }
  persist(): void
}

export interface PromotedObservationView {
  label: string
  field: string | null
  value: string | null
  key: string | null
  confirm: number | null
  sessions: number | null
  promotedAt: number | null
}

export interface PromoterInstance {
  enabled(): boolean
  run(input: { ownerId: string }): Promise<CandidateSlotView[]>
  promote(ownerId: string, candidates?: CandidateSlotView[]): Promise<CandidateSlotView[]>
  reject(input: {
    ownerId: string
    key?: string
    field?: string
    value?: string
    label?: string
  }): Promise<boolean>
  listObserved(ownerId: string): PromotedObservationView[]
}

export interface ExtractorInstance {
  enabled(): boolean
  maybeRun(input: { ownerId: string; sessionId?: string }): Promise<void> | null
  run(input: {
    ownerId: string
    messages: TranscriptMessage[]
    isCurrent?: () => boolean
  }): Promise<void>
}

// ---------------------------------------------------------------------------
// MarkdownDocumentStore — typed port of providers/markdown/context-store.ts
// ---------------------------------------------------------------------------

const MAX_EDIT_ITEMS = 20
const TRUNCATED_NOTICE = '<!-- 内容过长，已截断；精确编辑前请缩小文档 -->'

export interface StoreWarning {
  message: string
  at: number
  overBudget: boolean
}

function toText(value: unknown): string {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function publicDocument(
  scope: string,
  content: string,
  revisionSource: string = content): MemoryDocumentLike {
  return {
    id: `${scope}_document`,
    scope,
    content,
    format: 'markdown',
    revision: digest(revisionSource),
    editable: true,
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(needle, offset)) >= 0) {
    count += 1
    offset += needle.length
  }
  return count
}

function normalizeMarkdown(content: string): string {
  const lines = toText(content).split('\n')
  const seenBullets = new Set<string>()
  const deduped = lines
    .filter(line => !/^\s*[-*+]\s*$/.test(line))
    .filter(line => {
      const match = line.match(/^\s*[-*+]\s+(.+?)\s*$/)
      if (!match) return true
      const item = (match[1] ?? '').replace(/\s+/g, ' ').trim()
      if (seenBullets.has(item)) return false
      seenBullets.add(item)
      return true
    })
 // 空节清理(用户用户反馈「空标题污染」):标题后紧跟标题/EOF=无内容节,整节丢弃。
 // 经验证 USER.md 曾积累 69 个空「## 用户明确要求」——每个都进 system 提示词白烧 token。
  return dropEmptySections(deduped)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

/** 去掉「标题后无正文」的空节(标题行本身也丢弃,连同其后的空行)。 */
export function dropEmptySections(lines: string[]): string[] {
  const isHeading = (l: string) => /^#{1,6}\s+\S/.test(l)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i] ?? '')) {
      let j = i + 1
      while (j < lines.length && !(lines[j] ?? '').trim()) j++
      if (j >= lines.length || isHeading(lines[j] ?? '')) continue
    }
    out.push(lines[i] ?? '')
  }
  return out
}

function editFailure(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export interface MarkdownDocumentStoreOptions {
  filePath: string
  scope: string
  personalOwnerId?: string
  maxChars?: number
  hardMaxChars?: number | null
  template?: string
  now?: () => number
  onWarning?: (warning: StoreWarning) => void
}

export interface DocumentEditInput {
  edits?: MemoryChange['edits']
  append?: string
  expectedRevision?: string
}

export interface PreparedEdit {
  changed: number
  content: string
  document: MemoryDocumentLike
}

/**
 * Two-document markdown persistence (USER.md / MEMORY.md) with the exact-edit
 * semantics the Realtime memory tool and the automatic extractor both rely
 * on: old_text must match exactly once, expectedRevision guards concurrent
 * edits, append joins with a blank line, and the injection budget truncates
 * reads while only the absolute hard cap rejects writes.
 */
export class MarkdownDocumentStore {
  readonly scope: string
  private readonly filePath: string
  private readonly personalOwnerId: string
  private readonly maxChars: number
  private readonly hardMaxChars: number
  private readonly template: string
  private readonly now: () => number
  private readonly onWarning?: (warning: StoreWarning) => void
  private warning: StoreWarning | null = null

  constructor(options: MarkdownDocumentStoreOptions) {
    this.filePath = options.filePath
    this.scope = options.scope
    this.personalOwnerId = String(options.personalOwnerId ?? 'user_personal')
    this.maxChars = options.maxChars ?? 8000
    this.hardMaxChars =
      Number(options.hardMaxChars) > 0 ? Number(options.hardMaxChars) : this.maxChars * 4
    this.template = toText(options.template ?? '').trimEnd()
    this.now = options.now ?? (() => Date.now())
    this.onWarning = options.onWarning
  }

  pathFor(ownerId: string): string {
    const owner = String(ownerId || this.personalOwnerId)
    if (owner === this.personalOwnerId) return this.filePath
    return join(dirname(this.filePath), 'users', digest(owner), basename(this.filePath))
  }

  read(ownerId: string): string {
    const content = this.readRaw(ownerId)
    if ([...content].length <= this.maxChars) return content
    return `${[...content].slice(0, this.maxChars).join('')}\n\n${TRUNCATED_NOTICE}`
  }

  readRaw(ownerId: string): string {
    try {
      const content = toText(readFileSync(this.pathFor(ownerId), 'utf8')).trim()
      if ([...content].length > this.maxChars) {
        this.warn(
          `${basename(this.filePath)} 已超过注入预算 ${this.maxChars} 个字符`
          + `（当前 ${[...content].length}）：注入时会被截断。`,
          { overBudget: true },
        )
      } else {
        this.warning = null
      }
      return content
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return ''
      this.warn(`无法读取 ${basename(this.filePath)}：${String((error as Error)?.message || error)}`)
      return ''
    }
  }

  list(ownerId: string): MemoryDocumentLike[] {
    const raw = this.readRaw(ownerId)
    if (!raw) return []
    const content = [...raw].length <= this.maxChars
      ? raw
      : `${[...raw].slice(0, this.maxChars).join('')}\n\n${TRUNCATED_NOTICE}`
    return [publicDocument(this.scope, content, raw)]
  }

  /** Convenience single-shot edit (prepare + persist). The provider itself
   *  only uses prepareEdit/persist so batches stay atomic across documents. */
  edit(ownerId: string, change: DocumentEditInput = {}): PreparedEdit {
    const prepared = this.prepareEdit(ownerId, change)
    if (prepared.changed) this.persist(ownerId, `${prepared.content}\n`)
    return prepared
  }

  prepareEdit(ownerId: string, change: DocumentEditInput = {}): PreparedEdit {
    const current = this.readRaw(ownerId) || this.template
    const expectedRevision = String(change?.expectedRevision ?? '')
    if (expectedRevision && expectedRevision !== digest(current)) {
      throw editFailure('memory document changed; read it again before editing', 'stale_document')
    }
    const operations = (Array.isArray(change?.edits) ? change.edits : []).slice(0, MAX_EDIT_ITEMS)
    let next = current
    let changed = 0
    for (const operation of operations) {
      const oldText = toText(operation?.old_text)
      const newText = toText(operation?.new_text)
      if (!oldText) {
        throw editFailure('old_text is required for an exact edit', 'invalid_edit')
      }
      const matches = countOccurrences(next, oldText)
      if (matches !== 1) {
        throw editFailure(
          matches ? 'old_text must match exactly once' : 'old_text was not found',
          matches ? 'ambiguous_edit' : 'edit_not_found',
        )
      }
      next = next.replace(oldText, newText)
      changed += 1
    }
    const addition = toText(change?.append).trim()
    if (addition) {
      next = `${next.trimEnd()}\n\n${addition}\n`
      changed += 1
    }
    // Exact edits must not rewrite unrelated rows, comments, or placeholders.
    next = operations.length ? next.trimEnd() : normalizeMarkdown(next)
    if (!changed || next === current.trimEnd()) {
      return {
        changed: 0,
        content: current.trimEnd(),
        document: publicDocument(this.scope, current),
      }
    }
    if ([...next].length > this.hardMaxChars) {
      throw editFailure(
        `${basename(this.filePath)} 已超出绝对上限 ${this.hardMaxChars} 个字符，请先精简`,
        'document_too_large',
      )
    }
    if ([...next].length > this.maxChars) {
      this.warn(
        `${basename(this.filePath)} 已超过注入预算 ${this.maxChars} 个字符`
        + `（当前 ${[...next].length}）：内容已完整写盘，但注入时会被截断。`,
        { overBudget: true },
      )
    }
    return { changed, content: next, document: publicDocument(this.scope, next) }
  }

  persist(ownerId: string, content: string): void {
    const path = this.pathFor(ownerId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    if (!this.warning?.overBudget) {
      this.warning = null
    }
  }

  health(): { ok: boolean; configured: boolean; warning: StoreWarning | null } {
    return {
      ok: !this.warning,
      configured: Boolean(this.filePath),
      warning: this.warning,
    }
  }

  private warn(message: string, options: { overBudget?: boolean } = {}): void {
    this.warning = { message, at: this.now(), overBudget: options.overBudget === true }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must not break the voice service.
    }
  }
}

// ---------------------------------------------------------------------------
// PreferencePoolFileStore — v2-compatible store for PreferenceDraftPool
// ---------------------------------------------------------------------------

const POOL_FILE_VERSION = 2

export interface PoolSnapshot {
  version: number
  owners: Record<string, unknown[]>
  blocklist?: Record<string, string[]>
}

export interface PreferencePoolFileStoreOptions {
  filePath: string
  now?: () => number
  onWarning?: (warning: { message: string; at: number }) => void
}

/**
 * Fail-soft JSON persistence for the candidate pool. Same snapshot format and
 * file name convention as learning/preference-candidate-store.ts (v2), so the
 * file on disk stays interchangeable with the original store class.
 */
export class PreferencePoolFileStore {
  private readonly filePath: string
  private readonly now: () => number
  private readonly onWarning: (warning: { message: string; at: number }) => void
  private persistenceDisabled = false
  private warning: { message: string; at: number } | null = null

  constructor(options: PreferencePoolFileStoreOptions) {
    this.filePath = options.filePath
    this.now = options.now ?? (() => Date.now())
    this.onWarning = options.onWarning ?? (warning => console.warn(warning.message))
  }

  configured(): boolean {
    return Boolean(this.filePath)
  }

  enabled(): boolean {
    return this.configured() && !this.persistenceDisabled
  }

  /** Returns the snapshot, or null when missing/unusable (empty-pool start). */
  load(): PoolSnapshot | null {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      return this.disable(`无法读取候选池文件：${String((error as Error)?.message || error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.quarantine(`候选池文件不是有效的 JSON：${String((error as Error)?.message || error)}`)
      return null
    }
    const snapshot = parsed as PoolSnapshot | null
    if (
      !snapshot
      || snapshot.version !== POOL_FILE_VERSION
      || !snapshot.owners
      || typeof snapshot.owners !== 'object'
    ) {
      this.quarantine('候选池文件版本或结构不符合当前格式（期望 v2 owners 快照）')
      return null
    }
    return snapshot
  }

  save(snapshot: PoolSnapshot): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      this.disable(`无法写入候选池文件：${String((error as Error)?.message || error)}`)
    }
  }

  health(): { ok: boolean; warning: { message: string; at: number } | null } {
    return { ok: !this.warning, warning: this.warning }
  }

  private disable(message: string): null {
    this.setWarning(message)
    this.persistenceDisabled = true
    return null
  }

  private quarantine(message: string): void {
    this.setWarning(message)
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`)
    } catch {
      // Best effort; the empty snapshot is already the safe state.
    }
  }

  private setWarning(message: string): void {
    this.warning = { message, at: this.now() }
    try {
      this.onWarning?.(this.warning)
    } catch {
      // Diagnostics must not break the voice service.
    }
  }
}

// ---------------------------------------------------------------------------
// ProfileWatcher — typed port of learning/profile-observer.ts
// ---------------------------------------------------------------------------

const MAX_OBSERVATIONS_PER_RUN = 5
const MAX_VALUE_CHARS = 120
const MAX_QUOTE_CHARS = 50
// 与 preference-candidates 的 MAX_BASIS_CHARS 同值：判据要说明「凭什么从这句话
// 得出这个结论」，比原话稍长；两处不一致会让落盘时被二次截断。
const MAX_BASIS_CHARS = 80

const RELATIONS: ReadonlySet<string> = new Set<CandidateRelation>(['same', 'refine', 'contradict'])

// 「说 / 讲 / 答」的单字也要收：真实指令里大量是省略第二人称的祈使句
// （「说短点」「长话短说」），只匹配长词会全部误杀。
const POINTS_AT_ASSISTANT = /(?:你|您|回复|回答|说|讲|答|表达|语气|措辞)/

const FIELD_GUIDE = [
  '- occupation：用户的职业或身份。自由文本。给一个够用的范围即可，不要强行细分。',
  '- special_skills：用户熟悉的具体领域、技术或工具。自由文本，一次最多 3 项。',
  '- response_length：用户希望回复的详略。只能是 brief、normal、detailed 三者之一。',
  '- response_style：用户希望的表达风格或组织方式，例如「先说结论再展开」「语气轻松些」。自由文本。',
].join('\n')

// 输出形态刻意做成【逐字段问答】：「不报」是消极出口而 unknown 是必须主动选的
// 答案，承认不知道反而成了正常选项（详见原模块注释里的 A/B 数据）。
export const OBSERVER_SYSTEM_PROMPT = [
  '下面是用户在一场对话里说过的话（只有用户的话，没有助手的）。',
  '针对每个字段回答一个问题。答不出来就填 unknown —— 这是完全正当的答案，',
  '大多数对话里多数字段本来就该是 unknown。',
  '',
  '要回答的四个问题：',
  FIELD_GUIDE,
  '',
  '只输出一个 JSON 对象，不要输出任何其他文字：',
  '{"answers":[{"field":"字段名","value":"取值或 unknown","quote":"用户原话片段","basis":"一句话说明凭什么这么判断","vs_known":"first_time|same|refine|contradict"}]}',
  '',
  'vs_known 是本次判断与「当前已知画像」里那个值的关系：',
  '- first_time：画像里这个字段还是（未知）',
  '- same：和画像里记的是同一件事',
  '- refine：同一件事但更精确（老师 → 中学语文老师）',
  '- contradict：和画像里记的冲突（老师 → 程序员）',
  '',
  '规则：',
  '- 四个字段都要出现。答不出的填 value: "unknown"，此时 quote、basis、vs_known 都留空字符串。',
  '- quote 必须逐字照抄用户原话里的一段连续文字，不要改写、不要合并两句话。',
  '- basis 要说明推理依据。如果 basis 写起来很勉强、要绕好几步，说明这个字段该答 unknown。',
  '- response_length 与 response_style 讲的是【助手该怎么回话】。用户在说题目、文档、代码的长短详略，不算。',
  '- special_skills 只填用户【已经掌握】的，不填他正在问的、正在学的、说自己不懂的。多项用「、」分隔。',
  '- 绝不提取：密码、密钥、验证码、令牌、证件号码、详细住址、健康与医疗信息。',
].join('\n')

interface ProfileFieldDefinition {
  kind: 'slot' | 'list'
  values: readonly string[] | null
  max?: number
}

// PROFILE_KEYS 是冻结的字面量对象;观察器按模型给出的字段名动态查表,收敛成
// 一处带 undefined 的查表,避免在 strict 模式下散布索引断言。
const FIELD_DEFINITIONS = PROFILE_KEYS as unknown as Record<
  string,
  ProfileFieldDefinition | undefined
>

function fieldDefinition(field: string): ProfileFieldDefinition | undefined {
  return FIELD_DEFINITIONS[field]
}

const OBSERVER_INTERACTION_FIELDS: ReadonlySet<string> = new Set([
  'response_length',
  'response_style',
])

// quote 专用：只压缩空格与制表符，【保留换行】，quoteForValue 才能拆回单句。
function cleanQuote(value: unknown, maxChars: number): string {
  return [...String(value ?? '').replace(/[ \t]+/g, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}


// 只保留字母数字与文字，用于宽松比对 quote 是否真的来自用户发言（ASR 标点不稳）。
function bareText(value: unknown): string {
  return String(value ?? '').replace(/[^\p{L}\p{N}]+/gu, '')
}

function buildTranscript(
  messages: TranscriptMessage[],
  maxChars: number): { lines: string[]; userText: string } {
  const lines: string[] = []
  const userParts: string[] = []
  let used = 0
  for (const message of [...messages].reverse()) {
    const content = String(message.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (message.role !== 'user') continue
    const line = `用户: ${content}`
    if (lines.length && used + line.length > maxChars) break
    lines.unshift(line)
    used += line.length
    userParts.unshift(content)
  }
  return { lines, userText: userParts.join('\n') }
}


interface RawObservation {
  field: string
  value: string
  relation: CandidateRelation | null
  quote: string
  basis: string
}

export interface AcceptedObservation extends RawObservation {
  confirm: number
}

interface ObserverCandidatePool {
  list(ownerId: string): { field: string; value: string; state: string }[]
  observe(input: {
    ownerId: string
    sessionId?: string
    field: string
    value: string
    quote?: string
    basis?: string
    relation?: CandidateRelation | null
  }): { confirm: number } | null
}

// unknown 在解析阶段被消化：模型主动认「答不出」的字段直接丢弃，不留痕
// （每场四个字段近一半是 unknown，记 skip 只会刷满审计）。空串不在此列 ——
// 那是输出残缺，属于异常，要走 empty_value 留下痕迹。
const UNKNOWN_VALUES: ReadonlySet<string> = new Set(['unknown', '未知', 'n/a', 'null', 'none'])

// vs_known 是「本次判断与画像里那个值的关系」。first_time 与 same 对槽位池是
// 同一件事（都算又一次确认），prompt 里刻意分开问比让模型猜抽象标签准。
const VS_KNOWN_TO_RELATION = new Map<string, CandidateRelation>([
  ['first_time', 'same'],
  ['same', 'same'],
  ['refine', 'refine'],
  ['contradict', 'contradict'],
])

function parseObservations(text: unknown): RawObservation[] {
  const raw = String(text ?? '').trim()
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const parsed: unknown = JSON.parse(firstJsonObject(unfenced))
  const record = (parsed ?? {}) as { answers?: unknown; observations?: unknown }
  // answers 是当前形态，observations 是旧形态（既有测试与旧调用方兼容）。
  const rows = Array.isArray(record.answers)
    ? record.answers
    : (Array.isArray(record.observations) ? record.observations : null)
  if (!rows) throw new Error('observer output has no answers array')
  return (rows as unknown[])
    .slice(0, MAX_OBSERVATIONS_PER_RUN)
    .map(item => {
      const row = (item ?? {}) as Record<string, unknown>
      const directRelation =
        typeof row.relation === 'string' && RELATIONS.has(row.relation)
          ? (row.relation as CandidateRelation)
          : null
      return {
        field: String(row.field ?? '').trim(),
        value: clean(row.value, MAX_VALUE_CHARS),
        relation:
          directRelation
          ?? (VS_KNOWN_TO_RELATION.get(String(row.vs_known ?? '').trim()) ?? null),
        quote: cleanQuote(row.quote, MAX_QUOTE_CHARS),
        basis: clean(row.basis, MAX_BASIS_CHARS),
      }
    })
    .filter(item => !UNKNOWN_VALUES.has(item.value.toLowerCase()))
    .flatMap(expandListValues)
}

// list 字段（special_skills）的槽位 key 是 `field::value`，合并值（「Rust、Python」）
// 会变成互相独立的槽位、谁都攒不够 —— 解析阶段按分隔符拆开，每一项各自过值
// 锚定校验，本场没提到的项自然被 value_not_anchored 拦掉。
const LIST_VALUE_SEPARATORS = /[、,，;；/｜|]+/

function expandListValues(observation: RawObservation): RawObservation[] {
  if (fieldDefinition(observation.field)?.kind !== 'list') return [observation]
  const parts = String(observation.value)
    .split(LIST_VALUE_SEPARATORS)
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [observation]
  return parts.map(part => ({ ...observation, value: part }))
}

// 「值必须锚定在证据里」：quote 逐字校验只保证这句话用户真说过，不保证从这句
// 话推得出这个结论。判据是「改写」与「跳跃」之分：结论的字面成分能在证据里
// 找到落点才算改写。用 2-gram 而非分词（中文分词要引库，2-gram 已经够分）。
function valueAnchoredInQuote(value: string, quote: string): boolean {
  const bareValue = bareText(value)
  const bareQuote = bareText(quote)
  if (!bareValue || !bareQuote) return false
  if (bareValue.length <= 2) return bareQuote.includes(bareValue)
  for (let index = 0; index + 2 <= bareValue.length; index += 1) {
    if (bareQuote.includes(bareValue.slice(index, index + 2))) return true
  }
  return false
}

// 模型常把多句话拼成一个 quote。拆回单句并为每个值挑出能支撑它自己的那一段；
// 找不到再退到任意一段来自用户轮的，让 value_not_anchored 去拦。
function quoteForValue(value: string, quote: string, bareUserText: string): string {
  const segments = String(quote || '')
    .split(/[\n、；;]+/)
    .map(part => part.trim())
    .filter(Boolean)
  if (segments.length <= 1) return quote
  const fromUser = segments.filter(segment => {
    const bare = bareText(segment)
    return bare && bareUserText.includes(bare)
  })
  if (!fromUser.length) return quote
  return fromUser.find(segment => valueAnchoredInQuote(value, segment)) ?? fromUser[0] ?? quote
}

export interface ProfileObserverOptions {
  candidatePool: ObserverCandidatePool
  conversationSync: ConversationSyncPort
  audit?: MemoryAuditSink | null
  llmCall?: MemoryLlmCall | null
  logger?: MemoryLogger
  minUserMessages?: number
  maxTranscriptChars?: number
}

/**
 * Profile observer: the producer of the candidate slot pool. Where the
 * extractor must never speculate, the observer is allowed to — but its output
 * never touches the documents directly, it can only accumulate confirmations
 * in the pool. Deliberately not merged into one LLM call with the extractor:
 * 「不得推测」与「允许推测」放进同一个 prompt 会互相污染。
 */
export class ProfileWatcher {
  private readonly candidatePool: ObserverCandidatePool
  private readonly conversationSync: ConversationSyncPort
  private readonly audit: MemoryAuditSink | null
  private readonly llmCall: MemoryLlmCall | null
  private readonly logger: MemoryLogger
  readonly minUserMessages: number
  readonly maxTranscriptChars: number

  constructor(options: ProfileObserverOptions) {
    this.candidatePool = options.candidatePool
    this.conversationSync = options.conversationSync
    this.audit = options.audit ?? null
    this.llmCall = options.llmCall ?? null
    this.logger = options.logger ?? {}
    this.minUserMessages = options.minUserMessages ?? 4
    this.maxTranscriptChars = options.maxTranscriptChars ?? 6000
  }

  enabled(): boolean {
    return typeof this.llmCall === 'function' && Boolean(this.candidatePool)
  }

  // 当前已知画像，交给模型判断 relation。只放 active —— tentative 是还在攒
  // 确认的候选，让候选对模型隐形，跨会话确认才真的能累积。
  knownProfile(ownerId: string): string {
    const slots = this.candidatePool.list(ownerId) || []
    const lines: string[] = []
    for (const field of Object.keys(PROFILE_KEYS)) {
      const values = slots
        .filter(slot => slot.field === field && slot.state === 'active')
        .map(slot => slot.value)
      lines.push(`${field}: ${values.length ? values.join('、') : '（未知）'}`)
    }
    return lines.join('\n')
  }

  // 会话关闭钩子。刻意不做 debounce：门槛要求跨 ≥2 个会话，桌面用户可能短时间
  // 连开几场，防抖会直接吃掉这些会话的证据。返回值仅供测试，永不 reject。
  maybeRun(input: { ownerId: string; sessionId?: string }): Promise<AcceptedObservation[]> | null {
    if (!this.enabled()) return null
    const safeOwnerId = String(input?.ownerId || '')
    if (!safeOwnerId) return null
    if (typeof this.conversationSync?.pendingRecords !== 'function') return null
    const batch = this.conversationSync.pendingRecords(
      { ownerId: safeOwnerId, sessionId: input?.sessionId },
      this)
    const userMessages = batch.messages.filter(message => message.role === 'user')
    if (userMessages.length < this.minUserMessages) return null
    // Claim fresh evidence before yielding so repeated close hooks cannot reuse it.
    batch.consume()
    return this.run({
      ownerId: safeOwnerId,
      sessionId: input?.sessionId,
      messages: batch.messages,
      isCurrent: batch.isCurrent,
    }).catch((error: unknown) => {
      const message = String((error as Error)?.message || error)
      this.audit?.record({ op: 'error', ownerId: safeOwnerId, error: message })
      this.logger?.warn?.('preference.observe_failed', { error: message })
      return [] as AcceptedObservation[]
    })
  }

  async run(input: {
    ownerId: string
    sessionId?: string
    messages: TranscriptMessage[]
    isCurrent?: () => boolean
  }): Promise<AcceptedObservation[]> {
    if (!this.llmCall) return []
    const isCurrent = input?.isCurrent ?? (() => true)
    const { lines, userText } = buildTranscript(input.messages, this.maxTranscriptChars)
    if (!lines.length) return []
    const user = [
      '## 当前已知画像',
      this.knownProfile(input.ownerId),
      '',
      '## 用户说过的话',
      lines.join('\n'),
    ].join('\n')

    const response = await this.llmCall({ system: OBSERVER_SYSTEM_PROMPT, user })
    if (!isCurrent()) {
      this.audit?.record({ op: 'skip', ownerId: input.ownerId, reason: 'stale_observation' })
      return []
    }
    const observations = parseObservations(response)
    if (!observations.length) {
      this.audit?.record({ op: 'skip', ownerId: input.ownerId, reason: 'no_observation' })
      return []
    }

    const bareUserText = bareText(userText)
    const accepted: AcceptedObservation[] = []
    for (const raw of observations) {
      const observation: RawObservation = {
        ...raw,
        quote: quoteForValue(raw.value, raw.quote, bareUserText),
      }
      const reason = this.rejectionReason(observation, bareUserText)
      if (reason) {
        this.audit?.record({
          op: 'skip',
          ownerId: input.ownerId,
          reason,
          detail: { field: observation.field },
        })
        continue
      }
      const slot = this.candidatePool.observe({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        field: observation.field,
        value: observation.value,
        relation: observation.relation,
        quote: observation.quote,
        basis: observation.basis,
      })
      // 槽位池也会拒（枚举外取值、已被否决的字段），那不是错误，只是没收下。
      if (!slot) {
        this.audit?.record({
          op: 'skip',
          ownerId: input.ownerId,
          reason: 'pool_rejected',
          detail: { field: observation.field },
        })
        continue
      }
      accepted.push({ ...observation, confirm: slot.confirm })
    }

    if (accepted.length) {
      this.audit?.record({
        op: 'observe',
        ownerId: input.ownerId,
        scope: 'user',
        reason: 'observed',
        detail: accepted.map(item => ({
          field: item.field,
          value: item.value,
          relation: item.relation,
          confirm: item.confirm,
        })),
      })
    }
    this.logger?.debug?.('preference.observe_completed', {
      proposed: observations.length,
      accepted: accepted.length,
    })
    return accepted
  }

  // 返回拒收原因，null 表示通过。审计里能直接看出模型在哪一步不听话。
  rejectionReason(observation: RawObservation, bareUserText: string): string | null {
    const definition = fieldDefinition(observation.field)
    if (!definition) return 'unknown_field'
    if (!observation.value) return 'empty_value'
    if (!observation.quote) return 'missing_quote'
    if (hasSensitiveText(`${observation.value}\n${observation.quote}`)) {
      return 'sensitive'
    }
    // 第一道：证据必须真的来自用户发言（挡编造证据 / 把助手的话当用户偏好 /
    // 自我强化循环——USER.md 注入内容走 instructions 不进对话轮，永远过不了）。
    const bareQuote = bareText(observation.quote)
    if (!bareQuote || !bareUserText.includes(bareQuote)) return 'quote_not_from_user'
    // 第二道：交互偏好必须由指向助手的话产生，与值是枚举还是自由文本无关。
    if (
      OBSERVER_INTERACTION_FIELDS.has(observation.field)
      && !POINTS_AT_ASSISTANT.test(observation.quote)
    ) {
      return 'quote_not_about_interaction'
    }
    // 枚举值是英文标签，落不到中文原话里，锚定判据对它无效；自由文本字段都要过。
    if (!definition.values) {
      if (!valueAnchoredInQuote(observation.value, observation.quote)) {
        return 'value_not_anchored'
      }
      // 值就是原话本身 —— 模型在复读，没有提取出特征
      if (bareText(observation.value) === bareQuote) return 'value_parrots_quote'
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const USER_DOCUMENT_FILE = 'USER.md'
const MEMORY_DOCUMENT_FILE = 'MEMORY.md'
const CANDIDATE_STORE_FILE = 'preference-candidates.json'

const DEFAULT_MIN_USER_MESSAGES = 4
const DEFAULT_MAX_TRANSCRIPT_CHARS = 6000
const DEFAULT_EXTRACTOR_DEBOUNCE_MS = 30 * 60_000

const TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(['user', 'assistant'])

export interface MemoryLearningOptions {
  /** 学习链路的最少用户消息数(抽取器与观察器各自的门,默认 4)。 */
  minUserMessages?: number
  /** 抽取器按 ownerId 的防抖窗口(默认 30 分钟;观察器刻意不防抖)。 */
  debounceMs?: number
  /** 转写注入预算字符数(默认 6000,超出保留最近轮次)。 */
  maxTranscriptChars?: number
  /** 会话关闭后自动尝试晋升攒够确认的候选(默认 true)。 */
  autoPromote?: boolean
}

export interface MemoryWiringOptions {
  /** 记忆文档根目录(markdown provider 存储;USER.md/MEMORY.md 等)。 */
  root: string
  /**
   * LLM 调用,契约由移植代码决定:`llmCall({ system, user }) => Promise<string>`。
   * 缺失 = 学习链路 enabled() = false,全程 no-op fail-soft(读路径照常工作)。
   */
  llmCall?: MemoryLlmCall | null
  /** 审计(可选)。 */
  audit?: MemoryAuditSink | null
  logger?: MemoryLogger | null
  now?: () => number
  learning?: MemoryLearningOptions
}

export interface MemoryWiring {
  readonly root: string
  readonly provider: MemoryProviderInstance
  readonly extractor: ExtractorInstance
  readonly observer: ProfileWatcher
  readonly candidatePool: CandidatePoolInstance
  readonly promoter: PromoterInstance
  /** 学习链路可用性(缺 llmCall 时 extractor/observer 为 false)。 */
  learningEnabled(): { extractor: boolean; observer: boolean; promoter: boolean }
 /** 读 user+memory 两份文档并渲染注入块;空库返回 ''(调用方无需前缀处理)。
 * 同一 owner 且内容/revision 未变时复用冻结快照(文本逐字节与重建结果一致)。 */
  contextBlock(ownerId: string): string
 /** 冻结视图(观察/测试面):注入块 + 内容指纹 + 是否复用上一份快照。 */
  contextBlockFrozen(ownerId: string): { block: string; hash: string; reused: boolean; revision?: string }
  /**
   * 会话关闭钩子:把转写喂给抽取器与画像观察器(各自内部门控),随后尝试晋升。
   * 永不抛错;审计 op='error' 带失败阶段。每个转写只应关一次 —— consume() 是
   * no-op(转写生命周期归调用方),重复关闭会重复计数确认。
   */
  onSessionClose(input: SessionCloseInput): Promise<void>
  /** 手动晋升扫描(自动晋升关闭时的替代入口);永不抛错。 */
  promote(ownerId: string): Promise<CandidateSlotView[]>
  health(): {
    provider: { ok: boolean; documents: Record<string, unknown> }
    candidatePool: ReturnType<CandidatePoolInstance['health']>
  }
}

/** 会话关闭适配器:maybeRun 通过 conversationSync 读转写,这里是唯一的缝。
 *  转写生命周期归调用方,consume() 刻意 no-op;isCurrent 恒真(单次关闭语义)。 */
class TranscriptBuffer implements ConversationSyncPort {
  private batch: TranscriptBatch | null = null

  begin(messages: TranscriptMessage[]): void {
    this.batch = {
      messages,
      isCurrent: () => true,
      consume: () => {},
    }
  }

  end(): void {
    this.batch = null
  }

  pendingRecords(): TranscriptBatch {
    return this.batch ?? { messages: [], isCurrent: () => true, consume: () => {} }
  }
}

function sanitizeTranscript(transcript: unknown): TranscriptMessage[] {
  if (!Array.isArray(transcript)) return []
  const messages: TranscriptMessage[] = []
  for (const raw of transcript as unknown[]) {
    const row = (raw ?? {}) as { role?: unknown; content?: unknown }
    const role = String(row.role ?? '')
    const content = String(row.content ?? '').trim()
    if (!TRANSCRIPT_ROLES.has(role) || !content) continue
    messages.push({ role: role as TranscriptMessage['role'], content })
  }
  return messages
}

// 摘要两份记忆文档的 revision(排序拼接,稳定)。渲染文本已含 revision 属性,
// 这里再单列一份是为了让冻结缓存能按「内容/revision 未变」直接判定复用。
function documentRevision(memories: unknown): string | undefined {
  const list = Array.isArray(memories) ? memories : []
  const parts: string[] = []
  for (const item of list) {
    const doc = (item ?? {}) as { scope?: unknown; revision?: unknown }
    const revision = doc.revision
    if (revision === undefined || revision === null || String(revision).trim() === '') continue
    parts.push(`${String(doc.scope ?? '')}=${String(revision).trim()}`)
  }
  if (parts.length === 0) return undefined
  parts.sort()
  return parts.join(',')
}

export function createMemoryWiring(options: MemoryWiringOptions): MemoryWiring {
  const root = String(options?.root ?? '').trim()
  if (!root) throw new TypeError('createMemoryWiring requires a non-empty root directory')
  const now = options.now ?? (() => Date.now())
  const audit = options.audit ?? null
  const logger: MemoryLogger = options.logger ?? {}
  const llmCall = typeof options.llmCall === 'function' ? options.llmCall : null
  const learning = options.learning ?? {}
  const autoPromote = learning.autoPromote !== false

  const onDocumentWarning = (scope: string) => (warning: StoreWarning): void => {
    logger.warn?.('memory.document_warning', {
      scope,
      message: warning.message,
      overBudget: warning.overBudget,
    })
  }

  const userStore = new MarkdownDocumentStore({
    filePath: join(root, USER_DOCUMENT_FILE),
    scope: 'user',
    now,
    onWarning: onDocumentWarning('user'),
  })
  const memoryStore = new MarkdownDocumentStore({
    filePath: join(root, MEMORY_DOCUMENT_FILE),
    scope: 'memory',
    now,
    onWarning: onDocumentWarning('memory'),
  })

  // 每个移植类只在此处转型一次;对外暴露的是上面定义的显式接口。
  const ProviderCtor = MarkdownMemoryStore as unknown as new (options: {
    userStore: MarkdownDocumentStore
    memoryStore: MarkdownDocumentStore
  }) => MemoryProviderInstance
  const provider = new ProviderCtor({ userStore, memoryStore })

  const poolStore = new PreferencePoolFileStore({
    filePath: join(root, CANDIDATE_STORE_FILE),
    now,
    onWarning: warning => logger.warn?.('memory.candidate_store_warning', warning),
  })

  const PoolCtor = PreferenceDraftPool as unknown as new (options: {
    now: () => number
    store: PreferencePoolFileStore | null
  }) => CandidatePoolInstance
  const candidatePool = new PoolCtor({ now, store: poolStore })

  const transcripts = new TranscriptBuffer()

  const observer = new ProfileWatcher({
    candidatePool,
    conversationSync: transcripts,
    audit,
    llmCall,
    logger,
    minUserMessages: learning.minUserMessages ?? DEFAULT_MIN_USER_MESSAGES,
    maxTranscriptChars: learning.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
  })

  const ExtractorCtor = MemoryMiner as unknown as new (options: {
    memoryService: MemoryProviderInstance
    conversationSync: ConversationSyncPort
    audit: MemoryAuditSink | null
    llmCall: MemoryLlmCall | null
    logger: MemoryLogger
    now: () => number
    debounceMs: number
    minUserMessages: number
    maxTranscriptChars: number
  }) => ExtractorInstance
  const extractor = new ExtractorCtor({
    memoryService: provider,
    conversationSync: transcripts,
    audit,
    llmCall,
    logger,
    now,
    debounceMs: learning.debounceMs ?? DEFAULT_EXTRACTOR_DEBOUNCE_MS,
    minUserMessages: learning.minUserMessages ?? DEFAULT_MIN_USER_MESSAGES,
    maxTranscriptChars: learning.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS,
  })

  const PromoterCtor = PreferenceAdvancer as unknown as new (options: {
    memoryService: MemoryProviderInstance
    candidatePool: CandidatePoolInstance
    audit: MemoryAuditSink | null
    logger: MemoryLogger
    now: () => number
  }) => PromoterInstance
  const promoter = new PromoterCtor({
    memoryService: provider,
    candidatePool,
    audit,
    logger,
    now,
  })

  async function guard(
    stage: string,
    ownerId: string,
    run: () => unknown): Promise<unknown> {
    try {
      return await run()
    } catch (error) {
      const message = String((error as Error)?.message || error)
      audit?.record({ op: 'error', ownerId, stage, error: message })
      logger.warn?.('memory.wiring_stage_failed', { stage, ownerId, error: message })
      return undefined
    }
  }

 // 冻结缓存:同一会话内 USER.md/MEMORY.md 渲染块按 owner 复用——中途写盘只要
 // 内容/revision 未变就不换快照,系统提示的前缀不会整节失效(省下重复计费的输入 token)。
  const snapshots = new SnapshotCache()
  const freezeContext = (ownerId: string): { block: string; hash: string; reused: boolean; revision?: string } => {
    const memories = provider.list(ownerId)
    const text = buildMemoryBriefing({ memories })
    const revision = documentRevision(memories)
    const { snapshot, reused } = snapshots.getOrFreeze(ownerId, text, revision)
    return {
      block: snapshot.text,
      hash: snapshot.hash,
      reused,
      ...(snapshot.revision ? { revision: snapshot.revision } : {}),
    }
  }

  return {
    root,
    provider,
    extractor,
    observer,
    candidatePool,
    promoter,
    learningEnabled() {
      return {
        extractor: extractor.enabled(),
        observer: observer.enabled(),
        promoter: promoter.enabled(),
      }
    },
    contextBlock(ownerId: string): string {
      return freezeContext(String(ownerId ?? '')).block
    },
    contextBlockFrozen(ownerId: string) {
      return freezeContext(String(ownerId ?? ''))
    },
    async onSessionClose(input: SessionCloseInput): Promise<void> {
      const ownerId = String(input?.ownerId ?? '').trim()
      if (!ownerId) return
      const sessionId = String(input?.sessionId ?? '').trim()
      const messages = sanitizeTranscript(input?.transcript)
      transcripts.begin(messages)
      try {
        if (extractor.enabled()) {
          await guard('extract', ownerId, () => extractor.maybeRun({ ownerId, sessionId }))
        }
        if (observer.enabled()) {
          await guard('observe', ownerId, () => observer.maybeRun({ ownerId, sessionId }))
        }
        if (autoPromote && promoter.enabled()) {
          await guard('promote', ownerId, () => promoter.run({ ownerId }))
        }
      } finally {
        transcripts.end()
      }
    },
    async promote(ownerId: string): Promise<CandidateSlotView[]> {
      const safeOwnerId = String(ownerId ?? '').trim()
      if (!safeOwnerId || !promoter.enabled()) return []
      const promoted = await guard('promote', safeOwnerId, () => promoter.run({ ownerId: safeOwnerId }))
      return Array.isArray(promoted) ? (promoted as CandidateSlotView[]) : []
    },
    health() {
      return {
        provider: provider.health(),
        candidatePool: candidatePool.health(),
      }
    },
  }
}
