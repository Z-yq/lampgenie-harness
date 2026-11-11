/**
 * 计划持久化接线:探针 D(真 RuntimeTaskSupervisor + 真 store,重启后计划仍在)
 * 与探针 E(app.ts 源码含 store 注入 + exit flush)。临时文件全部在 /tmp。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskSupervisor } from '@lampgenie/runtime/task/task-manager'
import { ScheduledTaskFileStore } from '../src/scheduled-task-store'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000

const dirs: string[] = []

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genie-schedwire-'))
  dirs.push(dir)
  return join(dir, 'scheduled-tasks.json')
}

function supervisor(store: ScheduledTaskFileStore): TaskSupervisor {
  return new TaskSupervisor({ maxConcurrent: 2, store } as never)
}

function scheduledOf(manager: TaskSupervisor): any[] {
  return (manager.list({ scope: 'all' }) as any[]).filter(task => task.status === 'scheduled')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('D) 真 supervisor 持久化 → 重启恢复', () => {
  it('createScheduled 后,新 store + 新实例能把计划读回来', () => {
    const file = tmpFile()
    const first = supervisor(new ScheduledTaskFileStore({ file }))
    const created: any = first.createScheduled({
      objective: '每天 9 点汇总昨日提交',
      ownerId: 'u1',
      sessionId: 'main',
      schedule: { at: T0 + HOUR },
      type: 'task',
    })
    expect(created.error ?? null).toBeNull()
    expect(created.status).toBe('scheduled')

 // 模拟进程重启:全新 store 读同一文件,全新 supervisor 恢复
    const second = supervisor(new ScheduledTaskFileStore({ file }))
    const restored = scheduledOf(second).find(task => task.id === created.id)
    expect(restored).toBeTruthy()
    expect(restored.objective).toBe('每天 9 点汇总昨日提交')
    expect(restored.schedule.at).toBe(T0 + HOUR)
    expect(restored.sessionId).toBe('main')
  })

  it('同一 store 实例重建 supervisor 也恢复(reload 走文件而非内存)', () => {
    const file = tmpFile()
    const store = new ScheduledTaskFileStore({ file })
    const first = supervisor(store)
    const created: any = first.createScheduled({
      objective: '周报',
      ownerId: 'u1',
      sessionId: 'main',
      schedule: { at: T0 + HOUR, recurrence: 'daily' },
      type: 'task',
    })
    const second = supervisor(store)
    const restored = scheduledOf(second).find(task => task.id === created.id)
    expect(restored).toBeTruthy()
    expect(restored.schedule.recurrence).toBe('daily')
  })

  it('nextTaskNumber 随计划一起还原:重启后继续发号不与已存任务撞车', () => {
    const file = tmpFile()
    const first = supervisor(new ScheduledTaskFileStore({ file }))
    const a: any = first.createScheduled({
      objective: 'A', ownerId: 'u1', sessionId: 'main', schedule: { at: T0 + HOUR }, type: 'task',
    })
    const second = supervisor(new ScheduledTaskFileStore({ file }))
    const b: any = second.createScheduled({
      objective: 'B', ownerId: 'u1', sessionId: 'main', schedule: { at: T0 + 2 * HOUR }, type: 'task',
    })
    expect(b.id).not.toBe(a.id)
    const third = supervisor(new ScheduledTaskFileStore({ file }))
    const ids = scheduledOf(third).map(task => task.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })

  it('重复重启幂等:恢复不产生重复任务、不丢计划', () => {
    const file = tmpFile()
    const first = supervisor(new ScheduledTaskFileStore({ file }))
    first.createScheduled({ objective: 'x', ownerId: 'u1', sessionId: 'main', schedule: { at: T0 + HOUR }, type: 'task' })
    const count1 = scheduledOf(supervisor(new ScheduledTaskFileStore({ file }))).length
    const count2 = scheduledOf(supervisor(new ScheduledTaskFileStore({ file }))).length
    expect(count1).toBe(1)
    expect(count2).toBe(1)
  })
})

describe('E) app.ts 接线(源码断言)', () => {
  const src = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

  it('RuntimeTaskSupervisor 构造注入 store 与 maxConcurrent', () => {
    expect(src).toMatch(/new ScheduledTaskFileStore\(\{/)
    expect(src).toMatch(/new RuntimeTaskSupervisor\(\{\s*maxConcurrent:\s*2,\s*store:\s*scheduledTaskStore(?:\s+as\s+\w+)?\s*\}\)/)
  })

  it('落盘路径为 repoRoot/.genie/scheduled-tasks.json', () => {
    expect(src).toMatch(/join\(repoRoot\(\),\s*"\.genie",\s*"scheduled-tasks\.json"\)/)
  })

  it('进程 exit 时同步 flush', () => {
    expect(src).toMatch(/process\.once\("exit"/)
    expect(src).toMatch(/\.flush\(\)/)
  })

  it('旧构造(纯内存,无 store)已不存在', () => {
    expect(src).not.toMatch(/new RuntimeTaskSupervisor\(\{\s*maxConcurrent:\s*2\s*\}\)/)
  })
})
