/**
 * :delivery-receipt 纯逻辑行为测试(不 mock 被测对象,不读时钟,时间全注入)。
 * 覆盖:码表/键派生/错误分类/退避与封顶/receipt 状态机/不可变与确定性/ready 判据/容量裁剪。
 */
import { describe, it, expect } from 'vitest'
import {
  RECEIPT_CODES,
  RECEIPT_KEEP,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffMs,
  classifyDeliveryError,
  isReady,
  nextReceipt,
  pruneReceipts,
  receiptKeyFor,
} from '../src/task/delivery-receipt'
import type { Receipt } from '../src/task/delivery-receipt'

describe('码表与键派生', () => {
  it('RECEIPT_CODES 逐字锁定', () => {
    expect([...RECEIPT_CODES]).toEqual(['OK', 'PENDING', 'DELIVERED', 'FAILED', 'CONFLICT', 'DUPLICATE', 'INVALID'])
  })

  it('receiptKeyFor:trim 后拼接,空身份返回空串(不与 occurrence 的 @ 串味)', () => {
    expect(receiptKeyFor('a1', 'a1@1000')).toBe('a1#a1@1000')
    expect(receiptKeyFor(' a1 ', ' a1@1000 ')).toBe('a1#a1@1000')
    expect(receiptKeyFor('', 'x@1')).toBe('')
    expect(receiptKeyFor('x', '')).toBe('')
    expect(receiptKeyFor('x', 'y')).not.toBe(receiptKeyFor('x', 'y') + ' ')
  })
})

describe('classifyDeliveryError', () => {
  const transient = [
    'request timeout',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'HTTP 429 Too Many Requests',
    'HTTP 503 Service Unavailable',
    'HTTP 599 edge',
    'network down',
    'temporarily unavailable',
  ]
  for (const text of transient) {
    it(`transient:${text}`, () => {
      expect(classifyDeliveryError(new Error(text)).kind).toBe('transient')
    })
  }

  const permanent = ['HTTP 401 Unauthorized', 'HTTP 403 Forbidden', 'HTTP 404 Not Found', 'HTTP 400 Bad Request', 'invalid token', 'permission denied']
  for (const text of permanent) {
    it(`permanent:${text}`, () => {
      expect(classifyDeliveryError(new Error(text)).kind).toBe('permanent')
    })
  }

  it('未知错误保守判 transient,字符串/对象/undefined 都不 throw', () => {
    expect(classifyDeliveryError(new Error('boom')).kind).toBe('transient')
    expect(classifyDeliveryError('boom').kind).toBe('transient')
    expect(classifyDeliveryError({ weird: true }).kind).toBe('transient')
    expect(classifyDeliveryError(undefined).kind).toBe('transient')
    expect(classifyDeliveryError(undefined).reason).toBe('unknown')
  })

  it('reason 与原文同源且截断 ≤200;超长不抛', () => {
    const long = 'x'.repeat(500)
    const r = classifyDeliveryError(new Error(long))
    expect(r.reason).toHaveLength(200)
    expect(classifyDeliveryError('  timeout  ').reason).toBe('timeout')
  })
})

describe('backoffMs', () => {
  it('30s 起、依次翻倍、15min 封顶;attempts<=0 → 0', () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(-3)).toBe(0)
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS) // 30_000
    expect(backoffMs(2)).toBe(60_000)
    expect(backoffMs(3)).toBe(120_000)
    expect(backoffMs(4)).toBe(240_000)
    expect(backoffMs(6)).toBe(BACKOFF_MAX_MS) // 30000*32=960000 → 封顶 900000
    expect(backoffMs(50)).toBe(BACKOFF_MAX_MS)
    expect(backoffMs(Number.NaN)).toBe(0)
  })
})

describe('nextReceipt 状态机', () => {
  it('首次成功:DELIVERED,attempts=0,key 由 opts 派生', () => {
    const r = nextReceipt(null, { ok: true }, { at: 1_000, key: 'a#k' })
    expect(r).toEqual({ key: 'a#k', status: 'DELIVERED', attempts: 0, at: 1_000 })
  })

  it('transient:PENDING + attempts+1 + nextAttemptAt=at+backoff,error 留原文', () => {
    const r = nextReceipt(null, { ok: false, error: new Error('timeout') }, { at: 2_000, key: 'a#k' })
    expect(r.status).toBe('PENDING')
    expect(r.attempts).toBe(1)
    expect(r.nextAttemptAt).toBe(2_000 + 30_000)
    expect(r.error).toBe('timeout')
    const r2 = nextReceipt(r, { ok: false, error: 'timeout again' }, { at: 32_000 })
    expect(r2.key).toBe('a#k')
    expect(r2.attempts).toBe(2)
    expect(r2.nextAttemptAt).toBe(32_000 + 60_000)
  })

  it('permanent:FAILED 且无 nextAttemptAt,attempts 不累加', () => {
    const r = nextReceipt(null, { ok: false, error: new Error('HTTP 401 Unauthorized') }, { at: 5, key: 'a#k' })
    expect(r.status).toBe('FAILED')
    expect(r.nextAttemptAt).toBeUndefined()
    expect(r.attempts).toBe(0)
    expect(r.error).toContain('401')
  })

  it('prev 已 DELIVERED:再投 → DUPLICATE,不改 prev', () => {
    const prev: Receipt = { key: 'a#k', status: 'DELIVERED', attempts: 1, at: 100 }
    const r = nextReceipt(prev, { ok: true }, { at: 200 })
    expect(r.status).toBe('DUPLICATE')
    expect(r.key).toBe('a#k')
    expect(prev.status).toBe('DELIVERED')
    expect(prev.attempts).toBe(1)
  })

  it('不可变:冻结入参不抛,返回新对象,same 输入 same 输出', () => {
    const prev = Object.freeze({ key: 'a#k', status: 'PENDING', attempts: 1, nextAttemptAt: 31_000, error: 'timeout', at: 1_000 }) as Receipt
    const a = nextReceipt(prev, { ok: false, error: 'timeout' }, { at: 40_000 })
    const b = nextReceipt(prev, { ok: false, error: 'timeout' }, { at: 40_000 })
    expect(a).not.toBe(prev)
    expect(a).toEqual(b)
    expect(prev.nextAttemptAt).toBe(31_000)
  })

  it('非法 opts 不 throw(at 缺省归 0)', () => {
    const r = nextReceipt(null, { ok: true }, { at: Number.NaN as unknown as number })
    expect(r.at).toBe(0)
  })
})

describe('isReady', () => {
  const pending = (nextAttemptAt?: number): Receipt => ({ key: 'k', status: 'PENDING', attempts: 2, at: 0, ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}) })

  it('无 receipt → ready', () => {
    expect(isReady(undefined, 0)).toBe(true)
    expect(isReady(null, 0)).toBe(true)
  })

  it('PENDING 按 nextAttemptAt(边界含等号;缺字段视为到期)', () => {
    expect(isReady(pending(100), 99)).toBe(false)
    expect(isReady(pending(100), 100)).toBe(true)
    expect(isReady(pending(100), 101)).toBe(true)
    expect(isReady(pending(), 0)).toBe(true)
  })

  it('DELIVERED/FAILED 不重投,其余码也不 ready', () => {
    expect(isReady({ key: 'k', status: 'DELIVERED', attempts: 0, at: 0 }, 1e9)).toBe(false)
    expect(isReady({ key: 'k', status: 'FAILED', attempts: 0, at: 0 }, 1e9)).toBe(false)
    expect(isReady({ key: 'k', status: 'DUPLICATE', attempts: 0, at: 0 }, 1e9)).toBe(false)
  })
})

describe('pruneReceipts 容量', () => {
  it('保留最近 N 条(按 at 升序淘汰最旧),不改入参,总量 ≤20', () => {
    const src: Record<string, { at: number }> = {}
    for (let i = 0; i < 25; i++) src[`k${i}`] = { at: 1_000 + i }
    const out = pruneReceipts(src, RECEIPT_KEEP)
    expect(Object.keys(out)).toHaveLength(20)
    expect(out.k0).toBeUndefined()
    expect(out.k4).toBeUndefined()
    expect(out.k5).toEqual({ at: 1_005 })
    expect(out.k24).toEqual({ at: 1_024 })
    expect(Object.keys(src)).toHaveLength(25)
  })

  it('未超限原样复制;空/undefined 容忍', () => {
    expect(pruneReceipts({ a: { at: 1 } })).toEqual({ a: { at: 1 } })
    expect(pruneReceipts(undefined)).toEqual({})
    expect(pruneReceipts(null, 0)).toEqual({})
  })
})
