// 记忆注入块冻结 + 召回预取门(纯逻辑,零 IO;时间可注入,结果确定)。
// 为什么冻结能省 token:
// USER.md/MEMORY.md 的渲染块在系统提示里逐字重复。会话中途的写盘(学习链路/用户编辑)
// 会让「本轮重建块」与「上轮块」出现字节差异——哪怕只差一个 revision 属性,整节记忆在
// 下一轮就变成未命中前缀(缓存按前缀命中,一处改动后面全重算)。同一 owner 且
// 内容/revision 未变时直接复用上一份快照(同一引用),系统提示前缀保持稳定。
// 为什么 trivial prompt 跳过召回能省 token:
// 「你好」「谢谢」「好的」「/compact」这类输入不携带任务信息,记忆块对回答零增益。
// 跳过整块注入就等于把数千 token 的上下文从这一次调用里省掉,回答行为与无记忆一致。

import { createHash } from 'node:crypto'

/** 冻结后的注入块:文本 + 内容指纹。对象本身不可变。 */
export interface MemorySnapshot {
  readonly text: string
  readonly hash: string
  readonly revision?: string
  readonly frozenAt: number
}

/** 内容指纹 = sha256 十六进制前 16 位(够用且短,审计里可读)。 */
export function hashMemoryBlock(text: string): string {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

function normalizeRevision(revision: unknown): string | undefined {
  if (revision === undefined || revision === null) return undefined
  const value = String(revision).trim()
  return value ? value : undefined
}

/**
 * 冻结一份注入块。不可变:调用方拿到的对象不能被后续写盘改写。
 * `now` 只用于冻结时间戳,缺省取当前毫秒(测试可注入固定值,保证确定性)。
 */
export function freezeMemoryBlock(text: string, revision?: string, now: number = Date.now()): MemorySnapshot {
  const safeText = String(text ?? '')
  const safeRevision = normalizeRevision(revision)
  const snapshot: MemorySnapshot = {
    text: safeText,
    hash: hashMemoryBlock(safeText),
    ...(safeRevision ? { revision: safeRevision } : {}),
    frozenAt: now,
  }
  return Object.freeze(snapshot)
}

/** 一次冻结的结果:快照 + 是否复用了上一份(同引用)。 */
export interface FreezeResult {
  readonly snapshot: MemorySnapshot
  readonly reused: boolean
}

interface CacheEntry {
  readonly text: string
  readonly revision?: string
  readonly snapshot: MemorySnapshot
}

/**
 * 进程内冻结缓存(按 owner 分槽)。
 * 同 owner 且 text/revision 未变 → 返回同一份快照(reused=true),渲染前缀稳定;
 * 任一变 → 生成新快照(reused=false)。invalidate 清单个 owner 或全部。
 */
export class SnapshotCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  getOrFreeze(ownerId: string, text: string, revision?: string): FreezeResult {
    const owner = String(ownerId ?? '')
    const nextText = String(text ?? '')
    const nextRevision = normalizeRevision(revision)
    const cached = this.entries.get(owner)
    if (cached && cached.text === nextText && cached.revision === nextRevision) {
      return { snapshot: cached.snapshot, reused: true }
    }
    const snapshot = freezeMemoryBlock(nextText, nextRevision, this.now())
    this.entries.set(owner, { text: nextText, revision: nextRevision, snapshot })
    return { snapshot, reused: false }
  }

 /** ownerId 缺省 = 清空全部(切换配置/测试收尾用)。 */
  invalidate(ownerId?: string): void {
    if (ownerId === undefined) this.entries.clear()
    else this.entries.delete(String(ownerId ?? ''))
  }

 /** 当前缓存槽数(观察/测试面)。 */
  size(): number {
    return this.entries.size
  }
}

/** 召回判定原因(全部确定性,便于审计聚合)。 */
export type MemoryRecallReason =
  | 'trivial-empty'
  | 'trivial-greeting'
  | 'command'
  | 'task'
  | 'non-trivial'
  | 'disabled'

export interface MemoryRecallDecision {
  readonly recall: boolean
  readonly reason: MemoryRecallReason
}

export interface MemoryRecallOptions {
 /** enabled=false 时恒 recall(回退开关:疑似的误杀直接在配置里关掉)。 */
  readonly enabled?: boolean
}

// 阈值词表集中常量:改这里就改全部行为,不散落在逻辑里。
const GREETING_TOKENS: ReadonlySet<string> = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'thx',
  'ok',
  'okay',
  'yes',
  'yep',
  'yeah',
  'no',
  'nope',
  'sure',
  'got it',
  '收到',
  '谢谢',
  '多谢',
  '谢了',
  '好的',
  '好',
  '行',
  '可以',
  '嗯',
  '嗯嗯',
  '在吗',
  '你好',
  '您好',
  '早安',
  '晚安',
  '辛苦了',
])

// 任务信号:中文动词/疑问、英文动词、问号、代码片段特征。命中即 recall(带记忆更有用)。
const TASK_SIGNALS: readonly RegExp[] = [
  /(帮我|请|麻烦|把|改|修|加|删|查|写|读|跑|测|实现|优化|重构|部署|安装|配置|解释|分析|看看|检查|报错|失败|错误|问题|为什么|怎么|如何|能否|能不能|是否|建议|对比|生成|设计|统计|列出|总结|翻译)/,
  /\b(fix|add|remove|delete|update|change|refactor|implement|build|test|run|check|write|read|debug|error|fail|why|how|what|where|when|which|explain|analyze|compare|design|generate|install|deploy|configure|review|investigate|help)\b/i,
  /[?？]/,
  /(`|\{|\}|\(\)|=>|<[^>]+>|#include|function\s|const\s|let\s|var\s|\S+\.(ts|js|py|json|md|sh|go|rs|java)\b)/,
]

// 首尾标点/符号剥离("谢谢!" / "hello." / "「好的」" 归一后精确匹配词表)。
const EDGE_PUNCTUATION = /^[\s\p{P}\p{S}]+|[\s\P{L}\p{N}]+$/gu

/**
 * 判定这次 prompt 是否需要注入记忆。
 * 规则顺序固定(命令 → 归一 → 空 → 问候 → ≤2 字 → 任务信号 → 兜底),确定性。
 */
export function shouldRecallMemory(prompt: string): MemoryRecallDecision {
  const raw = String(prompt ?? '').trim()
 // 斜杠命令:以 / 开头且正文无空格(与面板命令一致),不携带任务信息。
  if (/^\/\S+$/.test(raw)) return Object.freeze({ recall: false, reason: 'command' as const })
  const normalized = raw.replace(EDGE_PUNCTUATION, '').trim().toLowerCase()
  if (!normalized) return Object.freeze({ recall: false, reason: 'trivial-empty' as const })
  if (GREETING_TOKENS.has(normalized)) return Object.freeze({ recall: false, reason: 'trivial-greeting' as const })
 // ≤2 字(剥掉空格后)的输入没有任务承载能力。
  if (normalized.replace(/\s+/g, '').length <= 2) return Object.freeze({ recall: false, reason: 'trivial-empty' as const })
  for (const signal of TASK_SIGNALS) {
    if (signal.test(normalized)) return Object.freeze({ recall: true, reason: 'task' as const })
  }
  return Object.freeze({ recall: true, reason: 'non-trivial' as const })
}

/** 带开关的召回门:enabled=false 恒 recall(回退,不因误判丢记忆)。 */
export function recallGate(prompt: string, opts: MemoryRecallOptions = {}): MemoryRecallDecision {
  if (opts.enabled === false) return Object.freeze({ recall: true, reason: 'disabled' as const })
  return shouldRecallMemory(prompt)
}
