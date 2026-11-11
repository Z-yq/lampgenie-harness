/**
 * occurrence 纯逻辑行为测试:不 mock 被测对象,直接驱 OccurrenceLedger 与纯函数。
 * 覆盖:身份稳定(跨重启)/重复 instant/CAS 认领/失败可重试/manual 不 stamp/
 * owner 恢复幂等/快照恢复/空账本/确定性/pending slot 判据。
 */
import { describe, it, expect } from 'vitest'
import {
  classifyDueOccurrences,
  occurrenceKey,
  OccurrenceLedger,
  pendingSlotDecision,
  isManualTrigger,
  pruneOccurrenceRecords,
  recoverClaimedOccurrences,
  OCCURRENCE_RECORD_LIMIT,
  CATCH_UP_SLACK_MS,
} from '../src/task/occurrence'
import type { OccurrenceLedgerSnapshot } from '../src/task/occurrence'

const JOB = 'job-1'
const T0 = 1_700_000_000_000
const T1 = T0 + 86_400_000

describe('occurrenceKey(身份稳定)', () => {
  it('身份 = job@计划瞬间,跨进程/多次调用逐字一致', () => {
    const first = occurrenceKey(JOB, T0)
    const second = occurrenceKey('job-1', String(T0))
    expect(first).toBe(`${JOB}@${T0}`)
    expect(second).toBe(first)
  })

  it('同 instant 不同 job 身份不同;同 job 不同 instant 身份不同', () => {
    expect(occurrenceKey('a', T0)).not.toBe(occurrenceKey('b', T0))
    expect(occurrenceKey('a', T0)).not.toBe(occurrenceKey('a', T1))
  })

  it('非法输入 fail-closed 返回空串(不 throw)', () => {
    expect(occurrenceKey('', T0)).toBe('')
    expect(occurrenceKey(JOB, Number.NaN)).toBe('')
    expect(occurrenceKey(null, undefined)).toBe('')
    expect(() => occurrenceKey(undefined, null)).not.toThrow()
  })
})

describe('classifyDueOccurrences(到期分流)', () => {
  it('completed/claimed/待跑三分,顺序与输入一致', () => {
    const result = classifyDueOccurrences({
      dueInstants: [T0, T1, T1 + 1000],
      completedKeys: [occurrenceKey(JOB, T0)],
      claimedKeys: [occurrenceKey(JOB, T0 + 1)],
    })
 // T0 完成跳过;T0+1 不在 due 列表;T1/T1+1000 待跑
    expect(result.run).toEqual([T1, T1 + 1000])
    expect(result.skippedCompleted).toEqual([T0])
    expect(result.skippedClaimed).toEqual([])
  })

  it('claimed 的 instant 进 skippedClaimed', () => {
    const result = classifyDueOccurrences({
      dueInstants: [T0],
      claimedKeys: [occurrenceKey(JOB, T0)],
    })
    expect(result.run).toEqual([])
    expect(result.skippedClaimed).toEqual([T0])
  })

  it('failed/未知状态不算完成:没有 completed key 就照跑', () => {
    const result = classifyDueOccurrences({
      dueInstants: [T0],
      completedKeys: [],
      claimedKeys: [],
    })
    expect(result.run).toEqual([T0])
    expect(result.skippedCompleted).toEqual([])
  })

  it('同一 instant 重复出现只算一次(首现位置)', () => {
    const result = classifyDueOccurrences({
      dueInstants: [T1, T0, T1, T0],
    })
    expect(result.run).toEqual([T1, T0])
  })

  it('空输入与非法 instant 安全', () => {
    expect(classifyDueOccurrences()).toEqual({ run: [], skippedCompleted: [], skippedClaimed: [] })
    const result = classifyDueOccurrences({ dueInstants: ['x', Number.NaN] })
    expect(result.run).toEqual([])
  })

  it('completedKeys 里带其它 job 的 key 不误伤(按 instant 对齐)', () => {
    const result = classifyDueOccurrences({
      dueInstants: [T0],
      completedKeys: [occurrenceKey('other-job', T0 + 5)],
    })
    expect(result.run).toEqual([T0])
  })
})

describe('OccurrenceLedger 认领 CAS', () => {
  it('首次 claim 成功并记录 owner/时间', () => {
    const ledger = new OccurrenceLedger()
    const claim = ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 111 })
    expect(claim).toEqual({ ok: true, code: 'CLAIMED', key: `${JOB}@${T0}` })
    const [entry] = ledger.entries()
    expect(entry?.status).toBe('claimed')
    expect(entry?.ownerId).toBe('owner-a')
    expect(entry?.claimedAt).toBe(111)
    expect(ledger.isCompleted(JOB, T0)).toBe(false)
    expect(ledger.stats()).toMatchObject({ total: 1, claimed: 1, completed: 0 })
  })

  it('双击 claim 第二次 = ALREADY_CLAIMED', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    const second = ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 2 })
    expect(second.ok).toBe(false)
    expect(second.code).toBe('ALREADY_CLAIMED')
    expect(ledger.size).toBe(1)
  })

  it('claim→complete→再次 claim = ALREADY_COMPLETED', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    ledger.complete(JOB, T0, { status: 'completed', at: 2 })
    const again = ledger.claim(JOB, T0, { ownerId: 'owner-b', at: 3 })
    expect(again.code).toBe('ALREADY_COMPLETED')
    expect(ledger.isCompleted(JOB, T0)).toBe(true)
  })

  it('failed 记录不阻止重试:再次 claim 成功', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    ledger.complete(JOB, T0, { status: 'failed', at: 2 })
    expect(ledger.statusOf(JOB, T0)).toBe('failed')
    const retry = ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 3 })
    expect(retry.ok).toBe(true)
    expect(ledger.statusOf(JOB, T0)).toBe('claimed')
  })

  it('非法身份 claim 不产生条目(不 throw)', () => {
    const ledger = new OccurrenceLedger()
    const claim = ledger.claim('', Number.NaN)
    expect(claim.ok).toBe(false)
    expect(ledger.size).toBe(0)
  })
})

describe('OccurrenceLedger 完成/失败/剪除', () => {
  it('completed 才 stamp 完成', () => {
    const ledger = new OccurrenceLedger()
    const result = ledger.complete(JOB, T0, { status: 'completed', at: 5 })
    expect(result.stamped).toBe(true)
    expect(ledger.isCompleted(JOB, T0)).toBe(true)
    expect(ledger.stats().completed).toBe(1)
  })

  it('failed/pruned 记录但不 stamp,isCompleted=false', () => {
    const ledger = new OccurrenceLedger()
    ledger.complete(JOB, T0, { status: 'failed', at: 5 })
    ledger.complete(JOB, T1, { status: 'pruned', at: 6 })
    expect(ledger.isCompleted(JOB, T0)).toBe(false)
    expect(ledger.isCompleted(JOB, T1)).toBe(false)
    expect(ledger.stats()).toMatchObject({ failed: 1, pruned: 1, completed: 0 })
  })

  it('completed 粘滞:后续 failed 记录不覆盖', () => {
    const ledger = new OccurrenceLedger()
    ledger.complete(JOB, T0, { status: 'completed', at: 5 })
    const later = ledger.complete(JOB, T0, { status: 'failed', at: 6 })
    expect(later.code).toBe('ALREADY_COMPLETED')
    expect(ledger.isCompleted(JOB, T0)).toBe(true)
  })

  it('manual 完成不 stamp:认领被回收,下次仍可跑', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    const manual = ledger.complete(JOB, T0, { status: 'completed', at: 2, manual: true })
    expect(manual.stamped).toBe(false)
    expect(manual.code).toBe('RELEASED')
    expect(ledger.isCompleted(JOB, T0)).toBe(false)
    expect(ledger.size).toBe(0)
    expect(ledger.claim(JOB, T0, { ownerId: 'owner-b', at: 3 }).ok).toBe(true)
  })

  it('未认领的 manual 完成同样不留下完成记录', () => {
    const ledger = new OccurrenceLedger()
    ledger.complete(JOB, T0, { status: 'completed', at: 2, manual: true })
    expect(ledger.isCompleted(JOB, T0)).toBe(false)
    expect(ledger.stats().completed).toBe(0)
  })

  it('release 只回收 claimed;重复 release 第二次 false', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    expect(ledger.release(JOB, T0)).toBe(true)
    expect(ledger.release(JOB, T0)).toBe(false)
    expect(ledger.size).toBe(0)
    ledger.complete(JOB, T1, { status: 'completed', at: 2 })
    expect(ledger.release(JOB, T1)).toBe(false)
    expect(ledger.isCompleted(JOB, T1)).toBe(true)
  })
})

describe('OccurrenceLedger owner 恢复(幂等)', () => {
  it('recoverOwner 只释放该 owner 的 claimed,重复调用第二次为空', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'dead', at: 1 })
    ledger.claim(JOB, T1, { ownerId: 'dead', at: 2 })
    ledger.claim(JOB, T1 + 1, { ownerId: 'alive', at: 3 })
    const released = ledger.recoverOwner('dead', { at: 10 })
    expect(released).toEqual([`${JOB}@${T0}`, `${JOB}@${T1}`])
    expect(ledger.claimedOwners()).toEqual(['alive'])
    expect(ledger.recoverOwner('dead', { at: 11 })).toEqual([])
  })

  it('recoverOwner 不动 completed 记录', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'dead', at: 1 })
    ledger.complete(JOB, T0, { status: 'completed', at: 2 })
    expect(ledger.recoverOwner('dead')).toEqual([])
    expect(ledger.isCompleted(JOB, T0)).toBe(true)
  })

  it('recoverOwner(空 owner) 不做事', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: '', at: 1 })
    expect(ledger.recoverOwner('')).toEqual([])
    expect(ledger.size).toBe(1)
  })
})

describe('OccurrenceLedger 快照/恢复', () => {
  it('toJSON → fromJSON 往返保留 completed 与 claimed 状态', () => {
    const ledger = new OccurrenceLedger()
    ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    ledger.complete(JOB, T0, { status: 'completed', at: 2 })
    ledger.claim(JOB, T1, { ownerId: 'owner-b', at: 3 })
    const restored = OccurrenceLedger.fromJSON(ledger.toJSON())
    expect(restored.isCompleted(JOB, T0)).toBe(true)
    expect(restored.statusOf(JOB, T1)).toBe('claimed')
    expect(restored.claimedOwners()).toEqual(['owner-b'])
  })

  it('snapshotForJob 只带该 job 的条目', () => {
    const ledger = new OccurrenceLedger()
    ledger.complete('job-1', T0, { status: 'completed', at: 1 })
    ledger.complete('job-2', T1, { status: 'completed', at: 2 })
    const snapshot = ledger.snapshotForJob('job-1')
    expect(snapshot.version).toBe(1)
    expect(snapshot.entries.map(entry => entry.key)).toEqual([`job-1@${T0}`])
  })

  it('merge 快照:completed 压过 claimed(冲突取更强语义)', () => {
    const target = new OccurrenceLedger()
    target.claim(JOB, T0, { ownerId: 'owner-a', at: 1 })
    const source = new OccurrenceLedger()
    source.complete(JOB, T0, { status: 'completed', at: 2 })
    expect(target.merge(source)).toBe(1)
    expect(target.isCompleted(JOB, T0)).toBe(true)
 // 反向合并不会把 completed 降级
    const downgrade = new OccurrenceLedger()
    downgrade.claim(JOB, T0, { ownerId: 'x', at: 9 })
    expect(target.merge(downgrade)).toBe(0)
    expect(target.isCompleted(JOB, T0)).toBe(true)
  })

  it('merge 非法快照安全返回 0', () => {
    const ledger = new OccurrenceLedger()
    expect(ledger.merge(null)).toBe(0)
    expect(ledger.merge({ version: 1, entries: [] })).toBe(0)
    expect(ledger.merge({ version: 1, entries: [{ key: 'bad' } as never] })).toBe(0)
  })

  it('空账本:stats 全零、classifyDue 全空、快照为空', () => {
    const ledger = new OccurrenceLedger()
    expect(ledger.stats()).toEqual({ total: 0, claimed: 0, completed: 0, failed: 0, pruned: 0, owners: 0 })
    expect(ledger.classifyDue([T0, T1])).toEqual({ run: [T0, T1], skippedCompleted: [], skippedClaimed: [] })
    const snapshot: OccurrenceLedgerSnapshot = ledger.toJSON()
    expect(snapshot.entries).toEqual([])
  })
})

describe('OccurrenceLedger.classifyDue(账本视角)', () => {
  it('completed/claimed 跳过,failed 重跑', () => {
    const ledger = new OccurrenceLedger()
    ledger.complete(JOB, T0, { status: 'completed', at: 1 })
    ledger.claim(JOB, T1, { ownerId: 'owner-a', at: 2 })
    ledger.complete(JOB, T1 + 1, { status: 'failed', at: 3 })
    const result = ledger.classifyDue([T0, T1, T1 + 1, T1 + 2])
    expect(result.run).toEqual([T1 + 1, T1 + 2])
    expect(result.skippedCompleted).toEqual([T0])
    expect(result.skippedClaimed).toEqual([T1])
  })
})

describe('确定性', () => {
  it('同输入两次构造产出逐字相同的快照(entries 按 key 排序)', () => {
    const build = () => {
      const ledger = new OccurrenceLedger()
      ledger.complete(JOB, T1, { status: 'completed', at: 1 })
      ledger.claim(JOB, T0, { ownerId: 'owner-a', at: 2 })
      return ledger.toJSON()
    }
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
    expect(build().entries.map(entry => entry.key)).toEqual([`${JOB}@${T0}`, `${JOB}@${T1}`])
  })
})

describe('pendingSlotDecision(claim 成功才 pop slot)', () => {
  const now = T0 + 1_000

  it('未到期 → wait', () => {
    expect(pendingSlotDecision({ now, nextRunAt: T1 })).toEqual({ action: 'wait', instant: T1 })
  })

  it('到期且未认领 → fire(调用方须先 claim)', () => {
    expect(pendingSlotDecision({ now, nextRunAt: T0 })).toEqual({ action: 'fire', instant: T0 })
  })

  it('认领失败(claimed=false) → wait,slot 绝不 pop', () => {
    expect(pendingSlotDecision({ now, nextRunAt: T0, claimed: false }))
      .toEqual({ action: 'wait', instant: T0 })
  })

  it('认领成功(claimed=true) → fire', () => {
    expect(pendingSlotDecision({ now: T0 + 999_999, nextRunAt: T0, claimed: true }))
      .toEqual({ action: 'fire', instant: T0 })
  })

  it('到期超过宽限 → catch-up,只补这一个最新 instant', () => {
    const late = T0 + CATCH_UP_SLACK_MS + 1
    expect(pendingSlotDecision({ now: late, nextRunAt: T0 }))
      .toEqual({ action: 'catch-up', instant: T0 })
    expect(pendingSlotDecision({ now: T0 + CATCH_UP_SLACK_MS, nextRunAt: T0 }).action).toBe('fire')
  })

  it('水位已覆盖 due → wait(防重复派发)', () => {
    expect(pendingSlotDecision({ now, nextRunAt: T0, lastFiredInstant: T0 }))
      .toEqual({ action: 'wait', instant: T0 })
  })

  it('非法 nextRunAt → wait/null,不 throw', () => {
    expect(pendingSlotDecision({ now, nextRunAt: Number.NaN })).toEqual({ action: 'wait', instant: null })
    expect(pendingSlotDecision({ now: Number.NaN, nextRunAt: T0 })).toEqual({ action: 'wait', instant: T0 })
  })
})

describe('isManualTrigger', () => {
  it('manual/force 一律视为手动,其它触发不算', () => {
    expect(isManualTrigger('manual')).toBe(true)
    expect(isManualTrigger(' FORCE ')).toBe(true)
    expect(isManualTrigger('schedule')).toBe(false)
    expect(isManualTrigger('')).toBe(false)
    expect(isManualTrigger(null)).toBe(false)
  })
})

describe('生产账本辅助(prune/recover)', () => {
  type Rec = { status: 'claimed' | 'completed' | 'failed'; at: number }

  it('pruneOccurrenceRecords:保留最近 limit 条,超出淘汰 at 最旧', () => {
    const records: Record<string, Rec> = {}
    for (let i = 0; i < 55; i++) records[`job-1@${1000 + i}`] = { status: 'claimed', at: 2000 + i }
    const pruned = pruneOccurrenceRecords(records, OCCURRENCE_RECORD_LIMIT)
    expect(Object.keys(pruned)).toHaveLength(50)
    expect(pruned['job-1@1000']).toBeUndefined()
    expect(pruned['job-1@1004']).toBeUndefined()
    expect(pruned['job-1@1005']).toBeDefined()
    expect(pruned['job-1@1054']).toBeDefined()
 // 纯函数:入参不变
    expect(Object.keys(records)).toHaveLength(55)
    expect(pruneOccurrenceRecords({ a: { status: 'claimed', at: 1 } }, 50)).toEqual({ a: { status: 'claimed', at: 1 } })
    expect(Object.keys(pruneOccurrenceRecords({}, 0))).toHaveLength(0)
  })

  it('recoverClaimedOccurrences:claimed→failed 可重试,completed 不动,幂等', () => {
    const records: Record<string, Rec> = {
      'j@1': { status: 'claimed', at: 5 },
      'j@2': { status: 'completed', at: 6 },
      'j@3': { status: 'failed', at: 7 },
    }
    const once = recoverClaimedOccurrences(records)
    expect(once.recovered).toBe(1)
    expect(once.records['j@1']!).toEqual({ status: 'failed', at: 5 })
    expect(once.records['j@2']!.status).toBe('completed')
    expect(once.records['j@3']!.status).toBe('failed')
    const twice = recoverClaimedOccurrences(once.records)
    expect(twice.recovered).toBe(0)
    expect(twice.records).toEqual(once.records)
    expect(recoverClaimedOccurrences(undefined)).toEqual({ records: {}, recovered: 0 })
  })
})
