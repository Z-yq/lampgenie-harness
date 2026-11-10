// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { clean } from "../text-utils";
// 用户画像槽位池：自更新机制的隔离带。
//
// 为什么需要它：现有抽取器有一条刻意的硬约束「不得推测」——只记录用户明确
// 说过的话。这保护了 USER.md 的纯净，但也意味着系统永远不会自己学：用户
// 连续十次要求「简短点」，第十一次还是啰嗦，除非他明说「以后都简短」。
//
// 槽位池的作用是在【不放松那条约束】的前提下打开推测能力：
//   观察产物写进槽位 → 不注入、不生效 → 攒够确认才晋升进 USER.md
//
// 为什么是「槽位」而不是「候选计数 + 三道门」：
//   上一版按 OpenClaw Dreaming 的六信号加权 + 三道门实现，但 OpenClaw 的候选
//   强度来自「被检索命中过多少次」（recall store），而前端记忆是全量注入、
//   不做检索，这个信号我们结构上就没有。剔掉检索类信号后剩下的四项里，
//   recency 因为「会话结束立刻扫描」恒等于 1，实际只有三项在起作用；再加上
//   自由文本 trait 的哈希归并根本合并不了同义措辞（「简短点」与「说重点」
//   各自 count=1），三道门一道也过不去 —— 与 OpenClaw #64068 的静默零晋升
//   同构。
//   改用 LangMem 的 profile 形态：字段固定、单槽 in-place、每次把现值一起
//   交给模型做一致性判断。单槽不需要跨措辞归并，所以自由文本重新变得可用，
//   评分与门槛也就没有存在的必要了。
//
// 正确性不来自门槛。语音产品没有确认 UI，正确性来自「保守写入 + 易于语音
// 纠正 + 审计留痕」——这是抽取器开头就写明的立场。本模块只保留服务于
// 「用户能看见、能撤销」的部分：证据留痕、黑名单、可列出。
//
// 隐私约束：evidence 存的是用户原话片段，不加限制会累积成一份变相的转写留存，
// 与「不做完整转写持久化」的立场矛盾。因此 evidence 最多 3 条、每条 ≤50 字；
// 确认次数继续累加但不再留原话，证据强度不受影响。

const MAX_EVIDENCE_ITEMS = 3
const MAX_EVIDENCE_CHARS = 50
// 判据比原话长一些：它要说明「凭什么从这句话得出这个结论」，
// 是用户日后追问「你怎么知道我是老师的」时唯一答得上的东西。
const MAX_BASIS_CHARS = 80
const MAX_VALUE_CHARS = 120
const MAX_LIST_ITEMS = 6

// 生效条件：确认 ≥2 次且跨 ≥2 个会话。
// 已知限制：桌面场景下用户一天可能开五个会话，「跨 2 会话」未必等于「跨时间
// 稳定」。这两个字段错了都可见可撤销，因此不再额外加最小间隔约束。
const CONFIRM_TARGET = 2
const SESSION_TARGET = 2

// 证据时效：职业本身是稳定的，但「半年前只观察到一次」这种残留证据不能一直
// 有效等着被凑满 —— 否则用户换了工作，偶然再匹配一次就会让过时的值生效。
// 超期只把确认次数归零，值本身留着供 diagnose 查看。
const STALE_MS = 90 * 24 * 60 * 60_000

const STATES = new Set(['tentative', 'active', 'rejected'])

// 字段定义。kind=slot 单值互斥就地更新；kind=list 多值共存各自计数。
// values 非空表示枚举字段：取值空间封闭且有数据支持才枚举，此时一致性判断
// 退化成字符串相等；其余走自由文本，靠单槽 in-place 免掉归一化。
export const PROFILE_KEYS = Object.freeze({
  occupation: Object.freeze({ kind: 'slot', values: null }),
  response_style: Object.freeze({ kind: 'slot', values: null }),
  response_length: Object.freeze({
    kind: 'slot',
    values: Object.freeze(['brief', 'normal', 'detailed']),
  }),
  special_skills: Object.freeze({
    kind: 'list',
    values: null,
    max: MAX_LIST_ITEMS,
  }),
})

// 枚举字段写进 USER.md 的措辞查表得到，不由模型生成 —— 否则同一个取值每次
// 晋升写出来的话都不一样，用户会以为系统学了好几条。
const ENUM_LABELS = Object.freeze({
  response_length: Object.freeze({
    brief: '回答简短，直接说要点',
    normal: '回答长度适中',
    detailed: '回答详细，展开说明',
  }),
})

// 自由文本字段的值本身就是可读的，只需要一个前缀说明它是什么。
const FIELD_PREFIX = Object.freeze({
  occupation: '职业',
  response_style: '表达风格',
  special_skills: '熟悉的领域或技术',
})

// 值 → 注入用可读行:枚举走查表(措辞固定,不由模型生成);自由文本加字段前缀。
export function formatFieldLabel(field, value) {
  const fixedWording = ENUM_LABELS[field]?.[value]
  if (fixedWording) return fixedWording
  const prefix = FIELD_PREFIX[field]
  return prefix ? `${prefix}：${value}` : String(value || '')
}

// 判断观察区里的某一行是否属于同一个单槽字段。
//
// 单槽字段是互斥的：晋升「回答简短」必须同时删掉旧的「回答详细」，否则观察区
// 里两条相反的偏好并存，模型只能瞎猜。观察区是给人读的纯文本 bullet，没有字段
// 标记，所以靠 label 的固定形状反查：枚举字段的 label 取值有限，可以全量比对；
// 自由文本字段的 label 带固定前缀，比前缀即可。
// 多值字段（list）本就允许共存，不参与替换。
export function sameFieldLabel(field, line) {
  const definition = PROFILE_KEYS[field]
  if (!definition || definition.kind === 'list') return false
  const text = String(line || '').trim()
  if (!text) return false
  const fixedWording = ENUM_LABELS[field]
  if (fixedWording) return Object.values(fixedWording).includes(text)
  const prefix = FIELD_PREFIX[field]
  return Boolean(prefix) && text.startsWith(`${prefix}：`)
}


// 枚举字段只接受词表内的取值。观察器给出词表外的值说明分类失败，
// 宁可丢掉这次观察也不要让脏值进槽位。
function tidyFieldValue(field, value) {
  const definition = PROFILE_KEYS[field]
  if (!definition) return null
  const safe = clean(value, MAX_VALUE_CHARS)
  if (!safe) return null
  if (!definition.values) return safe
  const lowered = safe.toLocaleLowerCase()
  return definition.values.includes(lowered) ? lowered : null
}

// 槽位定位键:单槽=字段名(互斥),多值=字段::取值(共存)。
function slotId(field, value) {
  return PROFILE_KEYS[field]?.kind === 'list' ? `${field}::${value}` : field
}

// 是否够格晋升。返回缺哪几项,diagnose 与晋升器共用同一套判定。
// sessionCount 刻意不叫 sessions:判定结果会展开合并进槽位快照,与那里的
// sessions 数组同名会被静默覆盖成数字。
export function scoreSlot(slot) {
  const confirm = slot?.confirm || 0
  const sessionCount = slot?.sessions?.length || 0
  const shortfall = []
  if (confirm < CONFIRM_TARGET) shortfall.push('confirm')
  if (sessionCount < SESSION_TARGET) shortfall.push('sessions')
  return {
    confirm,
    confirmTarget: CONFIRM_TARGET,
    sessionCount,
    sessionTarget: SESSION_TARGET,
    missing: shortfall,
    ready: shortfall.length === 0,
  }
}

// 反序列化单个槽位。文件可能被手工编辑过，所以每个字段都要校验与收敛，
// 不合法的整条丢弃而不是让脏数据参与判定。
function reviveSlot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const field = String(raw.field || '')
  if (!PROFILE_KEYS[field]) return null
  const value = tidyFieldValue(field, raw.value)
  if (!value) return null
  const lastSeenAt = Number(raw.lastAt) || 0
  // basis 是后加的字段，早先落盘的证据没有它 —— 给空串而不是判为无效，
  // 否则会把已经攒下的确认全部作废。
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .map(item => ({
      sessionId: String(item?.sessionId || ''),
      quote: clean(item?.quote, MAX_EVIDENCE_CHARS),
      basis: clean(item?.basis, MAX_BASIS_CHARS),
    }))
    .filter(item => item.quote)
    .slice(-MAX_EVIDENCE_ITEMS)
  const restored = {
    key: slotId(field, value),
    field,
    value,
    confirm: Math.max(1, Math.trunc(Number(raw.confirm) || 1)),
    sessions: [...new Set((Array.isArray(raw.sessions) ? raw.sessions : []).map(String).filter(Boolean))],
    firstAt: Number(raw.firstAt) || lastSeenAt,
    lastAt: lastSeenAt,
    evidence,
    state: STATES.has(raw.state) ? raw.state : 'tentative',
  }
  if (raw.resolvedAt) restored.resolvedAt = Number(raw.resolvedAt)
  return restored
}

export class PreferenceDraftPool {
  constructor({
    now = () => Date.now(),
    confirmTarget = CONFIRM_TARGET,
    sessionTarget = SESSION_TARGET,
    staleMs = STALE_MS,
    // 可选注入:进程重启后仍能攒证据;不传则纯内存运行(测试与桌面调试便利)。
    store = null,
  } = {}) {
    this.now = now
    this.targets = { confirmTarget, sessionTarget }
    this.staleMs = staleMs
    this.store = store
    this.owners = new Map()      // ownerId → Map<槽位键, 槽位>
    this.blocklist = new Map()   // ownerId → Set<槽位键>(用户否决过的不再晋升)
    this.slotVersions = new WeakMap() // 仅运行时的槽位版本号,不进持久化格式
    this.snapshots = new WeakMap()    // 快照 → 槽位+版本的绑定(isCurrent 依据)
    if (store) this.reload()
  }

  // 从磁盘覆盖内存池。上层可以在文件被别的 Gateway 改过后主动调。
  reload() {
    if (!this.store) return
    const snapshot = this.store.load()
    this.owners = this.#reviveOwners(snapshot)
    this.blocklist = this.#reviveBlocklist(snapshot)
  }

  #reviveOwners(snapshot) {
    const owners = new Map()
    for (const [ownerId, slots] of Object.entries(snapshot?.owners || {})) {
      if (!Array.isArray(slots)) continue
      const bucket = new Map()
      for (const raw of slots) {
        const revived = reviveSlot(raw)
        if (revived) bucket.set(revived.key, revived)
      }
      if (bucket.size) owners.set(String(ownerId), bucket)
    }
    return owners
  }

  #reviveBlocklist(snapshot) {
    const blocklist = new Map()
    for (const [ownerId, keys] of Object.entries(snapshot?.blocklist || {})) {
      if (!Array.isArray(keys) || !keys.length) continue
      blocklist.set(String(ownerId), new Set(keys.map(String)))
    }
    return blocklist
  }

  serialise() {
    const owners = {}
    for (const [ownerId, bucket] of this.owners) {
      if (!bucket.size) continue
      owners[ownerId] = [...bucket.values()].map(slot => this.#slotSnapshot(slot))
    }
    const blocklist = {}
    for (const [ownerId, keys] of this.blocklist) {
      if (!keys.size) continue
      blocklist[ownerId] = [...keys]
    }
    return { owners, blocklist }
  }

  #slotSnapshot(slot) {
    return {
      field: slot.field,
      value: slot.value,
      confirm: slot.confirm,
      sessions: [...slot.sessions],
      firstAt: slot.firstAt,
      lastAt: slot.lastAt,
      evidence: slot.evidence.map(item => ({ ...item })),
      state: slot.state,
      resolvedAt: slot.resolvedAt || null,
    }
  }

  persist() {
    if (!this.store) return
    this.store.save(this.serialise())
  }

  bucket(ownerId) {
    const key = String(ownerId || '')
    if (!this.owners.has(key)) this.owners.set(key, new Map())
    return this.owners.get(key)
  }

  // 某个槽位是否已被用户否决。
  //
  // 粒度刻意不一致，因为两类字段的否决语义不同：
  //   单槽字段 → 字段级。用户删掉「回答简短」表达的是「别猜我的回复长度」，
  //              而不是「改猜详细」；过两天写上相反的一条只会更烦人。
  //   多值字段 → 取值级。删掉「AEC」不该连带封禁其它技能。
  // 这个差异由 slotKey 天然给出：单槽的 key 就是字段名，多值的 key 含取值。
  blocked(ownerId, field, value) {
    const normalised = tidyFieldValue(field, value)
    if (!normalised) return false
    const denied = this.blocklist.get(String(ownerId || ''))
    return Boolean(denied?.has(slotId(field, normalised)))
  }

  // 观察到一次画像信号。
  //
  // relation 描述这次观察与槽位现值的关系，由观察器（LLM）给出：
  //   same       取值一致           → 确认次数 +1
  //   refine     更精确的同一件事   → 就地替换，确认次数保留（老师 → 语文老师）
  //   contradict 与现值冲突         → 就地替换，确认次数归零重新攒
  // 不传则按「值相等即 same，否则 contradict」保守处理。
  observe({
    ownerId,
    sessionId,
    field,
    value,
    quote = '',
    basis = '',
    relation = null,
  }) {
    const definition = PROFILE_KEYS[field]
    if (!definition || !String(ownerId || '')) return null
    const safeValue = tidyFieldValue(field, value)
    if (!safeValue) return null
    if (this.blocked(ownerId, field, safeValue)) return null

    const bucket = this.bucket(ownerId)
    const at = this.now()
    // 单槽字段按字段名定位现值，多值字段按取值定位自己那一条。
    const existing = definition.kind === 'list'
      ? bucket.get(slotId(field, safeValue))
      : bucket.get(field)

    if (!existing) return this.#plantSlot(bucket, at, { definition, field, safeValue, sessionId, quote, basis })

    // 已被用户否决的槽位不再接受新证据。
    if (existing.state === 'rejected') return null

    // 证据超期：确认次数归零重新开始，避免陈旧观察被后来的偶发信号凑满。
    if (at - existing.lastAt > this.staleMs) {
      existing.confirm = 0
      existing.sessions = []
      existing.evidence = []
    }

    const link = relation || (existing.value === safeValue ? 'same' : 'contradict')
    if (link === 'contradict') {
      // 矛盾等于重新开始：换值、清证据、已生效的值退回待确认。
      existing.value = safeValue
      existing.key = slotId(field, safeValue)
      existing.confirm = 1
      existing.sessions = sessionId ? [String(sessionId)] : []
      existing.evidence = []
      existing.firstAt = at
      existing.state = 'tentative'
    } else {
      // same 与 refine 都算同一件事的又一次确认；refine 顺带把值写得更准。
      if (link === 'refine') {
        existing.value = safeValue
        existing.key = slotId(field, safeValue)
      }
      existing.confirm += 1
      if (sessionId && !existing.sessions.includes(String(sessionId))) {
        existing.sessions.push(String(sessionId))
      }
    }
    existing.lastAt = at
    this.slotVersions.set(existing, (this.slotVersions.get(existing) || 0) + 1)
    this.#fileEvidence(existing, { sessionId, quote, basis })
    // 单槽字段的 key 可能随 refine/contradict 变了，重新落位。
    if (!bucket.has(existing.key)) {
      for (const [key, slot] of bucket) {
        if (slot === existing) bucket.delete(key)
      }
      bucket.set(existing.key, existing)
    }
    this.persist()
    return existing
  }

  // 新槽位落地(list 字段先淘汰弱者再插入)。
  #plantSlot(bucket, at, { definition, field, safeValue, sessionId, quote, basis }) {
    if (definition.kind === 'list') this.#trimListOverflow(bucket, field)
    const created = {
      key: slotId(field, safeValue),
      field,
      value: safeValue,
      confirm: 1,
      sessions: sessionId ? [String(sessionId)] : [],
      firstAt: at,
      lastAt: at,
      evidence: [],
      state: 'tentative',
    }
    this.#fileEvidence(created, { sessionId, quote, basis })
    bucket.set(created.key, created)
    this.persist()
    return created
  }

  // 追加一条原话证据;只留最近 N 条。确认次数不受影响,证据强度照旧。
  #fileEvidence(slot, { sessionId, quote, basis }) {
    if (!quote) return
    slot.evidence.push({
      sessionId: String(sessionId || ''),
      quote: clean(quote, MAX_EVIDENCE_CHARS),
      basis: clean(basis, MAX_BASIS_CHARS),
    })
    if (slot.evidence.length > MAX_EVIDENCE_ITEMS) {
      slot.evidence = slot.evidence.slice(-MAX_EVIDENCE_ITEMS)
    }
  }

  // 多值字段超限时淘汰最弱的一条：先看确认次数，再看最后活跃时间。
  // 不用 FIFO —— 那样会淘汰掉反复确认过的核心项，留下偶然提过一次的。
  #trimListOverflow(bucket, field) {
    const definition = PROFILE_KEYS[field]
    const cap = definition?.max || MAX_LIST_ITEMS
    const items = [...bucket.values()].filter(slot => slot.field === field)
    if (items.length < cap) return
    items.sort((left, right) => (
      (left.confirm - right.confirm) || (left.lastAt - right.lastAt)
    ))
    const drop = items.length - cap + 1
    for (const slot of items.slice(0, drop)) bucket.delete(slot.key)
  }

  // 只读快照列表:深拷贝集合字段,带可读 label 与晋升判据;按确认数、活跃度排序。
  list(ownerId, { state = null, field = null } = {}) {
    const wanted = slot => (!state || slot.state === state) && (!field || slot.field === field)
    const views = [...this.bucket(ownerId).values()]
      .filter(wanted)
      .map(slot => this.#viewOf(slot))
    return views.sort((left, right) => (right.confirm - left.confirm) || (right.lastAt - left.lastAt))
  }

  #viewOf(slot) {
    const snapshot = {
      ...slot,
      sessions: [...slot.sessions],
      evidence: slot.evidence.map(item => ({ ...item })),
      label: formatFieldLabel(slot.field, slot.value),
      ...scoreSlot(slot),
    }
    // 快照↔槽位+版本的绑定,isCurrent 用它判断「扫描后有没有被别人动过」。
    this.snapshots.set(snapshot, { slot, version: this.slotVersions.get(slot) })
    return snapshot
  }

  // 攒够确认的槽位(晋升扫描的输入);黑名单里的即便 ready 也剔除。
  promotable(ownerId) {
    const eligible = slot => slot.ready && !this.blocked(ownerId, slot.field, slot.value)
    return this.list(ownerId, { state: 'tentative' }).filter(eligible)
  }

  // 现势校验:快照仍绑定原槽位,且槽位版本没变(没被并发写动过)。
  isCurrent(ownerId, snapshot) {
    const binding = this.snapshots.get(snapshot)
    if (!binding) return false
    const live = this.owners.get(String(ownerId || ''))?.get(snapshot.key)
    const sameSlot = live === binding.slot
    const sameVersion = this.slotVersions.get(binding.slot) === binding.version
    return Boolean(sameSlot && sameVersion)
  }

  // 晋升销账:槽位转 active 并盖时间戳;对象入参必须先过现势校验。
  markPromoted(ownerId, candidate) {
    const key = typeof candidate === 'string' ? candidate : candidate?.key
    if (typeof candidate !== 'string' && !this.isCurrent(ownerId, candidate)) return null
    const slot = this.bucket(ownerId).get(key)
    if (!slot) return null
    slot.state = 'active'
    slot.resolvedAt = this.now()
    this.slotVersions.set(slot, (this.slotVersions.get(slot) || 0) + 1)
    this.persist()
    return slot
  }

  // 手工修改记忆后,丢弃修改前尚未生效的证据;这不是否决,后续新对话仍可重新学习。
  discardPending(ownerId) {
    const ownerKey = String(ownerId || '')
    const bucket = this.owners.get(ownerKey)
    if (!bucket) return 0
    let discarded = 0
    for (const [key, slot] of bucket) {
      if (slot.state !== 'tentative') continue
      bucket.delete(key)
      discarded += 1
    }
    if (discarded) {
      if (!bucket.size) this.owners.delete(ownerKey)
      this.persist()
    }
    return discarded
  }

  // 用户否决：状态置 rejected 并进黑名单，此后不再被自动晋升。
  reject({ ownerId, field = '', value = '', key = '' }) {
    const bucket = this.bucket(ownerId)
    const normalised = tidyFieldValue(field, value)
    const target = key || (normalised ? slotId(field, normalised) : '')
    if (!target) return null
    const slot = bucket.get(target)
    const ownerKey = String(ownerId || '')
    if (!this.blocklist.has(ownerKey)) this.blocklist.set(ownerKey, new Set())
    this.blocklist.get(ownerKey).add(target)
    if (slot) this.#markRejected(slot)
    this.persist()
    return slot
  }

  #markRejected(slot) {
    slot.state = 'rejected'
    slot.resolvedAt = this.now()
    this.slotVersions.set(slot, (this.slotVersions.get(slot) || 0) + 1)
    slot.evidence = [] // 否决后不再需要保留原话
  }

  stats(ownerId) {
    const counts = { tentative: 0, active: 0, rejected: 0 }
    for (const slot of this.bucket(ownerId).values()) {
      counts[slot.state] = (counts[slot.state] || 0) + 1
    }
    const blockedCount = this.blocklist.get(String(ownerId || ''))?.size || 0
    return { ...counts, blocked: blockedCount }
  }

  // 可观测性入口：逐字段报告「现在攒到哪一步、还差什么」。
  //
  // OpenClaw #64068 的教训是零晋升可以静默持续数周而无人察觉：cron 正常跑、
  // 耗时几毫秒、日志无异常，只是候选强度永远不够。没有这个入口就无法区分
  // 「用户确实没有稳定偏好」和「观察链路坏了」。
  // 可观测性入口:逐字段报告「现在攒到哪一步、还差什么」。
  //
  // OpenClaw #64068 的教训是零晋升可以静默持续数周而无人察觉:cron 正常跑、
  // 耗时几毫秒、日志无异常,只是候选强度永远不够。没有这个入口就无法区分
  // 「用户确实没有稳定偏好」和「观察链路坏了」。
  diagnose(ownerId) {
    const fields = {}
    for (const field of Object.keys(PROFILE_KEYS)) {
      const slots = this.list(ownerId, { field })
      fields[field] = slots.length ? slots.map(slot => this.#diagnoseRow(slot)) : null
    }
    const observed = this.list(ownerId)
    return {
      fields,
      // 从未被观察到的字段:整片为 null 说明生产者可能压根没接上。
      neverObserved: Object.keys(PROFILE_KEYS).filter(field => fields[field] === null),
      ready: observed.filter(slot => slot.ready && slot.state === 'tentative').length,
      ...this.stats(ownerId),
    }
  }

  #diagnoseRow(slot) {
    return {
      value: slot.value,
      label: slot.label,
      state: slot.state,
      confirm: slot.confirm,
      confirmTarget: slot.confirmTarget,
      sessions: slot.sessionCount,
      sessionTarget: slot.sessionTarget,
      missing: slot.missing,
      ready: slot.ready,
      lastAt: slot.lastAt,
    }
  }

  health() {
    const storeHealth = this.store?.health()
    return {
      ok: this.store ? storeHealth.ok : true,
      persistenceConfigured: Boolean(this.store?.configured()),
      persistenceEnabled: Boolean(this.store?.enabled()),
      warning: storeHealth?.warning || null,
      owners: this.owners.size,
    }
  }
}

export const DRAFT_DEFAULTS = {
  CONFIRM_TARGET,
  SESSION_TARGET,
  STALE_MS,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_CHARS,
  MAX_LIST_ITEMS,
  PROFILE_KEYS,
}
