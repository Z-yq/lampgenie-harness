/**
 * 定时计划持久化:ScheduledTaskFileStore 单测(全部 /tmp 临时目录)。
 * 覆盖探针 A(save→新实例 load 还原)、B(坏 JSON→[])、C(防抖后 flush 落盘)
 * 与原子写 / 元数据游标 / 幂等 / 失败不抛。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ScheduledTaskFileStore } from '../src/scheduled-task-store'

const dirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genie-schedstore-'))
  dirs.push(dir)
  return dir
}

function readDoc(file: string): { version: number; savedAt: number; tasks: unknown[]; meta: Record<string, unknown> } {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.endsWith('.tmp'))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('A) save → 新实例 load 还原', () => {
  it('任务数组逐字还原,nextTaskNumber 随 meta 还原', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const tasks = [
      { id: 'task_1', objective: '每天 9 点汇总', status: 'scheduled', schedule: { at: 1_700_000_000_000, recurrence: 'daily' } },
      { id: 'task_2', objective: 'weekly report', status: 'scheduled', schedule: { at: 1_700_100_000_000, recurrence: 'once' } },
    ]
    new ScheduledTaskFileStore({ file }).save(tasks, { nextTaskNumber: 7 })

    const fresh = new ScheduledTaskFileStore({ file })
    expect(fresh.load()).toEqual(tasks)
    expect(fresh.nextTaskNumber).toBe(7)
  })

  it('嵌套/空值/中文原样保存,不裁剪字段(调用方传什么存什么)', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const task = {
      id: 'task_3',
      objective: '带上下文的计划',
      schedule: {
        at: 1_700_000_000_000,
        occurrenceLedger: { 'job@1700000000000': { state: 'claimed', at: 1 } },
        timeZone: null,
      },
      error: null,
      tags: [],
    }
    new ScheduledTaskFileStore({ file }).save([task])
    expect(new ScheduledTaskFileStore({ file }).load()).toEqual([task])
  })

  it('文件不存在 → 空表,nextTaskNumber 回落 1', () => {
    const file = join(tmpDir(), 'missing', 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    expect(store.load()).toEqual([])
    expect(store.nextTaskNumber).toBe(1)
  })
})

describe('原子写', () => {
  it('tmp 文件写完即 rename,盘上无 .tmp 残留', () => {
    const dir = tmpDir()
    const file = join(dir, 'scheduled-tasks.json')
    new ScheduledTaskFileStore({ file }).save([{ id: 'task_1' }])
    expect(tmpLeftovers(dir)).toEqual([])
    const doc = readDoc(file)
    expect(doc.version).toBe(1)
    expect(doc.tasks).toEqual([{ id: 'task_1' }])
  })

  it('父目录不存在时自动创建', () => {
    const file = join(tmpDir(), 'deep', 'nested', 'scheduled-tasks.json')
    new ScheduledTaskFileStore({ file }).save([{ id: 'task_1' }])
    expect(existsSync(file)).toBe(true)
  })

  it('同内容重复 save 幂等(解析结果一致、无残留)', () => {
    const dir = tmpDir()
    const file = join(dir, 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file, now: () => 42 })
    const tasks = [{ id: 'task_1', objective: 'x' }]
    store.save(tasks, { nextTaskNumber: 2 })
    const first = readFileSync(file, 'utf8')
    store.save(tasks, { nextTaskNumber: 2 })
    expect(readFileSync(file, 'utf8')).toBe(first)
    expect(tmpLeftovers(dir)).toEqual([])
    expect(readDoc(file).savedAt).toBe(42)
  })

  it('落盘失败不抛,console.warn 只告警一次', () => {
    const dir = tmpDir()
    const blocker = join(dir, 'blocked')
    mkdirSync(blocker)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new ScheduledTaskFileStore({ file: blocker })
    expect(() => store.save([{ id: 'task_1' }])).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(() => store.save([{ id: 'task_2' }])).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('B) 坏文件容忍', () => {
  it('坏 JSON → [] 且不 throw', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    writeFileSync(file, '{not json', 'utf8')
    const store = new ScheduledTaskFileStore({ file })
    expect(() => store.load()).not.toThrow()
    expect(store.load()).toEqual([])
  })

  it('形状不符(标量/null/无 tasks 的对象)→ []', () => {
    const dir = tmpDir()
    for (const body of ['"just a string"', 'null', '123', '{"meta":{}}']) {
      const file = join(dir, `bad-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(file, body, 'utf8')
      expect(new ScheduledTaskFileStore({ file }).load()).toEqual([])
    }
  })

  it('裸数组(手工/早期文件)原样返回', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const legacy = [{ id: 'task_9', objective: 'legacy' }]
    writeFileSync(file, JSON.stringify(legacy), 'utf8')
    expect(new ScheduledTaskFileStore({ file }).load()).toEqual(legacy)
  })
})

describe('C) saveDeferred 防抖', () => {
  it('调用后未到 200ms 不落盘,flush() 强制落盘', () => {
    vi.useFakeTimers()
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    store.saveDeferred([{ id: 'task_1' }], { nextTaskNumber: 2 })
    vi.advanceTimersByTime(150)
    expect(existsSync(file)).toBe(false)
    store.flush()
    expect(readDoc(file).tasks).toEqual([{ id: 'task_1' }])
    expect(readDoc(file).meta.nextTaskNumber).toBe(2)
  })

  it('200ms 到点自动落盘', () => {
    vi.useFakeTimers()
    const file = join(tmpDir(), 'scheduled-tasks.json')
    new ScheduledTaskFileStore({ file }).saveDeferred([{ id: 'task_1' }])
    vi.advanceTimersByTime(199)
    expect(existsSync(file)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(readDoc(file).tasks).toEqual([{ id: 'task_1' }])
  })

  it('窗口内多次调用合并为一次写,只落最后快照', () => {
    vi.useFakeTimers()
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    store.saveDeferred([{ id: 'task_1' }])
    store.saveDeferred([{ id: 'task_2' }])
    store.saveDeferred([{ id: 'task_3' }], { nextTaskNumber: 9 })
    vi.advanceTimersByTime(200)
    const doc = readDoc(file)
    expect(doc.tasks).toEqual([{ id: 'task_3' }])
    expect(doc.meta.nextTaskNumber).toBe(9)
    const stamp = statSync(file).mtimeMs
    vi.advanceTimersByTime(1_000)
    expect(statSync(file).mtimeMs).toBe(stamp)
  })

  it('save 会取消在途防抖,不被旧快照覆盖', () => {
    vi.useFakeTimers()
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    store.saveDeferred([{ id: 'task_old' }])
    store.save([{ id: 'task_new' }])
    vi.advanceTimersByTime(500)
    expect(readDoc(file).tasks).toEqual([{ id: 'task_new' }])
  })

  it('close() 落盘并清定时器', () => {
    vi.useFakeTimers()
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    store.saveDeferred([{ id: 'task_1' }])
    store.close()
    expect(readDoc(file).tasks).toEqual([{ id: 'task_1' }])
    const stamp = statSync(file).mtimeMs
    vi.advanceTimersByTime(1_000)
    expect(statSync(file).mtimeMs).toBe(stamp)
    expect(() => store.flush()).not.toThrow()
  })
})

describe('元数据游标', () => {
  it('nextTaskNumber / nextJobNumber 写入 meta 并可被新实例读回', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    const store = new ScheduledTaskFileStore({ file })
    store.nextJobNumber = 42
    store.save([], { nextJobNumber: 42 })
    const fresh = new ScheduledTaskFileStore({ file })
    fresh.load()
    expect(fresh.nextJobNumber).toBe(42)
 // nextTaskNumber 显式写了 1(游标仍是初始值),不做旧字段回退
    expect(fresh.nextTaskNumber).toBe(1)
  })

  it('旧字段名 nextJobNumber 单独存在时作为兼容来源', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [], meta: { nextJobNumber: 9 } }), 'utf8')
    const store = new ScheduledTaskFileStore({ file })
    expect(store.load()).toEqual([])
    expect(store.nextTaskNumber).toBe(9)
    expect(store.nextJobNumber).toBe(9)
  })

  it('非法游标(0/负数/非整数)回落,不污染下一轮', () => {
    const file = join(tmpDir(), 'scheduled-tasks.json')
    writeFileSync(file, JSON.stringify({ version: 1, tasks: [], meta: { nextTaskNumber: 0, nextJobNumber: -3 } }), 'utf8')
    const store = new ScheduledTaskFileStore({ file })
    store.load()
    expect(store.nextTaskNumber).toBe(1)
    expect(store.nextJobNumber).toBe(1)
    store.nextTaskNumber = Number.NaN
    expect(store.nextTaskNumber).toBe(1)
  })
})
