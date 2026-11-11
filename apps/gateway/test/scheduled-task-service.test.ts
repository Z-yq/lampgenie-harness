/**
 * 生产定时任务调度器测试:真实 runtime TaskSupervisor(createScheduled/start 真路径)
 * + 假时钟 + 假 runner。覆盖探针 A~F 与旧行为兼容。
 */
import { describe, it, expect } from 'vitest'
import { TaskSupervisor } from '@lampgenie/runtime/task/task-manager'
import { ScheduledTaskService, type ScheduledTaskManagerLike } from '../src/scheduled-task-service'

const T0 = 1_700_000_000_000
const DAY = 86_400_000

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

function makeClock(start = T0) {
  let now = start
  return {
    now: () => now,
    set: (value: number) => { now = value },
    advance: (ms: number) => { now += ms },
  }
}

function makeManager() {
  return new TaskSupervisor({ maxConcurrent: 20 })
}

function makeService(
  manager: TaskSupervisor,
  clock: ReturnType<typeof makeClock>,
  extra: Record<string, unknown> = {},
) {
  return new ScheduledTaskService({
    taskManager: manager as unknown as ScheduledTaskManagerLike,
    now: clock.now,
    tickMs: 30_000,
    ownerId: 'test-owner',
    ...extra,
  })
}

function scheduled(manager: TaskSupervisor) {
  return manager.list({ scope: 'all' }).filter(task => task.status === 'scheduled')
}

describe('A) 内容门:非法内容不建任务', () => {
  it('instruction 为空 + mode → INVALID,manager 里零任务', () => {
    const clock = makeClock()
    const manager = makeManager()
    const service = makeService(manager, clock)
    const created = service.schedule({ instruction: '   ', at: T0, mode: 'agent' })
    expect(created.error).toBe('INVALID')
    expect(Array.isArray(created.issues)).toBe(true)
    expect((created.issues as string[]).length).toBeGreaterThan(0)
    expect(manager.list({ scope: 'all' })).toHaveLength(0)
  })

  it('非法 mode / 缺 at 都被拒收', () => {
    const manager = makeManager()
    const service = makeService(manager, makeClock())
    expect(service.schedule({ instruction: 'x', at: T0, mode: 'wat' }).error).toBe('INVALID')
    expect(service.schedule({ instruction: 'x' }).error).toBe('INVALID')
    expect(manager.list({ scope: 'all' })).toHaveLength(0)
  })

  it('合法 no_agent 创建:mode 透传、状态 scheduled', () => {
    const manager = makeManager()
    const service = makeService(manager, makeClock())
    const created = service.schedule({ instruction: '提醒喝水', at: T0, type: 'reminder', mode: 'no_agent' })
    expect(created.error ?? undefined).toBeUndefined()
    expect(created.mode).toBe('no_agent')
    expect(created.status).toBe('scheduled')
  })
})

describe('B) no_agent:到点只落提醒,runner 0 次', () => {
  it('tick 后完成且 content=instruction', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    let launches = 0
    const created = manager.createScheduled({
      objective: '提醒我 15:00 开会',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'reminder',
      mode: 'no_agent',
      runner: async () => { launches += 1; return { content: '不该跑' } },
    })
    const service = makeService(manager, clock)
    service.tick()
    await settle()
 // 终态观测在下一轮 tick 结算(started 当轮即计,completed 由 sweep 计)。
    service.tick(T0 + 30_000)
    expect(launches).toBe(0)
    expect(manager.get(created.id)?.status).toBe('completed')
    expect(manager.get(created.id)?.result).toBe('提醒我 15:00 开会')
    expect(service.stats().started).toBe(1)
    expect(service.stats().completed).toBe(1)
  })
})

describe('C) pre_run:exit 1 → failed 且不调 runner;exit 0 放行', () => {
  it('preRunCheck=false → failed(PRE_RUN_FAILED),runner 0 次', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    manager.setScheduledHooks({ preRunCheck: () => false })
    let launches = 0
    const created = manager.createScheduled({
      objective: '只有数据就绪才跑',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      preRun: { command: 'test -f /tmp/ready' },
      runner: async () => { launches += 1; return { content: 'ok' } },
    })
    const service = makeService(manager, clock)
    service.tick()
    await settle()
    service.tick(T0 + 30_000)
    expect(launches).toBe(0)
    expect(manager.get(created.id)?.status).toBe('failed')
    expect(manager.get(created.id)?.error).toBe('PRE_RUN_FAILED')
    expect(service.stats().failed).toBe(1)
  })

  it('preRunCheck=true → runner 被调用一次', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    const seen: string[] = []
    manager.setScheduledHooks({
      preRunCheck: (payload: { command?: string }) => { seen.push(String(payload.command)); return true },
    })
    let launches = 0
    const created = manager.createScheduled({
      objective: '数据就绪后跑',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      preRun: { command: 'true' },
      runner: async () => { launches += 1; return { content: 'ok' } },
    })
    const service = makeService(manager, clock)
    service.tick()
    await settle()
    expect(seen).toEqual(['true'])
    expect(launches).toBe(1)
    expect(manager.get(created.id)?.status).toBe('completed')
  })
})

describe('D) context_from / continuity:摘要进 objective', () => {
  it('provider 两段摘要 → compose 后传给 runner,原 instruction 在最后', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    manager.setScheduledHooks({
      contextProvider: () => ({
        contextSummary: '上次完成了 A 章节',
        continuitySummary: '系列上一篇是第 2 章',
      }),
    })
    let captured = ''
    const created = manager.createScheduled({
      objective: '继续写第 3 章',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      contextFrom: { taskId: 'task-old', maxChars: 1000 },
      continuity: true,
      runner: async (objective: string) => { captured = objective; return { content: 'ok' } },
    })
    const service = makeService(manager, clock)
    service.tick()
    await settle()
    expect(manager.get(created.id)?.status).toBe('completed')
    expect(captured).toContain('[上次任务结果摘要]')
    expect(captured).toContain('上次完成了 A 章节')
    expect(captured).toContain('[本系列上次结果]')
    expect(captured).toContain('系列上一篇是第 2 章')
    expect(captured.indexOf('上次完成了 A 章节')).toBeLessThan(captured.indexOf('继续写第 3 章'))
  })

  it('未注入 provider = 原 objective 逐字不变(旧行为)', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    let captured = ''
    const created = manager.createScheduled({
      objective: '原任务书逐字',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      contextFrom: { taskId: 'task-old' },
      runner: async (objective: string) => { captured = objective; return { content: 'ok' } },
    })
    const service = makeService(manager, clock)
    service.tick()
    await settle()
    expect(captured).toBe('原任务书逐字')
    expect(manager.get(created.id)?.status).toBe('completed')
  })
})

describe('E) recurring:完成后排下一次且不重复;once 不重建', () => {
  it('daily 完成后生成下一 occurrence,seriesId 继承,重复 tick 不重复建', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    const created = manager.createScheduled({
      objective: '每日巡检',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'daily', timeZone: 'UTC' },
      recurrenceStartAt: T0,
      type: 'task',
      mode: 'agent',
      runner: async () => ({ content: 'done' }),
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    expect(manager.get(created.id)?.status).toBe('completed')

    service.tick(T0) // 观察终态 + 排下一次
    const next = scheduled(manager)
    expect(next).toHaveLength(1)
    expect(next[0]?.schedule?.at).toBe(T0 + DAY)
    expect(next[0]?.seriesId).toBe(created.seriesId)
    expect(next[0]?.mode).toBe('agent')

    service.tick(T0)
    service.tick(T0)
    expect(scheduled(manager)).toHaveLength(1)
    expect(service.stats().scheduledNext).toBe(1)
  })

  it('recurring 失败(pre_run)只跳过本次,仍排下一次', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    manager.setScheduledHooks({ preRunCheck: () => false })
    const created = manager.createScheduled({
      objective: '每日门禁',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'daily', timeZone: 'UTC' },
      recurrenceStartAt: T0,
      type: 'task',
      mode: 'agent',
      preRun: { command: 'false' },
      runner: async () => ({ content: '不该跑' }),
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    service.tick(T0)
    expect(manager.get(created.id)?.status).toBe('failed')
    expect(manager.get(created.id)?.error).toBe('PRE_RUN_FAILED')
    const next = scheduled(manager)
    expect(next).toHaveLength(1)
    expect(next[0]?.schedule?.at).toBe(T0 + DAY)
  })

  it('once 任务完成后不重建', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    const created = manager.createScheduled({
      objective: '只跑一次',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      runner: async () => ({ content: 'ok' }),
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    service.tick(T0)
    expect(manager.list({ scope: 'all' })).toHaveLength(1)
    expect(manager.get(created.id)?.status).toBe('completed')
    expect(service.stats().scheduledNext).toBe(0)
  })
})

describe('F) 单飞:同一 occurrence 同 tick 只起跑一次', () => {
  it('连续两次 tick 只有一个 runner 在跑', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    let launches = 0
    let release: ((value: { content: string }) => void) | null = null
    const created = manager.createScheduled({
      objective: '慢任务',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      runner: () => {
        launches += 1
        return new Promise<{ content: string }>(resolve => { release = resolve })
      },
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    service.tick(T0)
    service.tick(T0)
    await settle()
    expect(launches).toBe(1)
    expect(service.stats().started).toBe(1)
    expect(manager.get(created.id)?.status).toBe('running')
    const finish = release as ((value: { content: string }) => void) | null
    finish?.({ content: 'ok' })
    await settle()
    service.tick(T0)
    expect(service.stats().completed).toBe(1)
  })
})

describe('旧行为兼容与生命周期', () => {
  it('不传内容字段:无 mode 键、objective 逐字、runner 正常跑', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    let captured = ''
    const created = manager.createScheduled({
      objective: '旧式定时公告',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      runner: async (objective: string) => { captured = objective; return { content: 'ok' } },
    })
    expect('mode' in created).toBe(false)
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    expect(captured).toBe('旧式定时公告')
    expect(manager.get(created.id)?.status).toBe('completed')
  })

  it('失败终态被观察且 fail-soft,不影响后续 tick', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    const created = manager.createScheduled({
      objective: '会失败',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      runner: async () => { throw new Error('boom') },
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    service.tick(T0 + 30_000)
    expect(manager.get(created.id)?.status).toBe('failed')
    expect(service.stats().failed).toBe(1)
    expect(service.stats().ticks).toBe(2)
  })

  it('start/stop 幂等,stats 暴露 tickMs 与 inFlight', () => {
    const service = makeService(makeManager(), makeClock())
    service.start()
    service.start()
    service.stop()
    service.stop()
    const stats = service.stats()
    expect(stats.tickMs).toBe(30_000)
    expect(stats.inFlight).toBe(0)
    expect(stats.ticks).toBe(0)
  })

  it('未到期任务不派发', async () => {
    const clock = makeClock(T0)
    const manager = makeManager()
    let launches = 0
    manager.createScheduled({
      objective: '明天再说',
      ownerId: 'u1',
      sessionId: 's1',
      schedule: { at: T0 + DAY, recurrence: 'once' },
      type: 'task',
      mode: 'agent',
      runner: async () => { launches += 1; return { content: 'ok' } },
    })
    const service = makeService(manager, clock)
    service.tick(T0)
    await settle()
    expect(launches).toBe(0)
    expect(service.stats().due).toBe(0)
  })
})
