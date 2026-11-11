/**
 * WS 接线(纯源码断言,不连网):协议面 / server case / app 装配三处缺一即假接线。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const protocol = source('../../../packages/protocol/src/index.ts')
const server = source('../src/server.ts')
const app = source('../src/app.ts')
const service = source('../src/scheduled-task-service.ts')
const capabilities = source('../src/client-capabilities.ts')

describe('G) WS task.schedule 源码接线', () => {
  it('protocol 定义请求与两种回执', () => {
    expect(protocol).toContain('type: z.literal("task.schedule")')
    expect(protocol).toContain('type: z.literal("task.schedule.cancel")')
    expect(protocol).toContain('type: z.literal("task.schedule.result")')
    expect(protocol).toContain('type: z.literal("task.schedule.cancel.result")')
    expect(protocol).toMatch(/TaskSubmit, TaskCancel, TaskSchedule, TaskScheduleCancel/)
  })

  it('server 有 task.schedule / cancel 两个 case 并把 projectId 按 session 归属决议', () => {
    expect(server).toContain('case "task.schedule":')
    expect(server).toContain('case "task.schedule.cancel":')
    expect(server).toContain('service.schedule({')
    expect(server).toContain('resolveSubmitProjectId(tm, msg.sessionId, msg.projectId, opts)')
    expect(server).toContain('type: "task.schedule.result"')
    expect(server).toContain('type: "task.schedule.cancel.result"')
    expect(server).toContain('scheduledTaskService?: ScheduledTaskService')
  })

  it('app 装配 service:runtime supervisor + pre_run shell 门 + 30s tick + 关停 stop', () => {
    expect(app).toContain('new RuntimeTaskSupervisor(')
    expect(app).toContain('configureScheduledTaskRunner(')
    expect(app).toContain('setScheduledHooks({')
    expect(app).toContain('execFile("sh", ["-c", command]')
    expect(app).toContain('preRunVerdict(')
    expect(app).toContain('new ScheduledTaskService({')
    expect(app).toContain('scheduledTaskService.start()')
    expect(app).toContain('scheduledTaskService.stop()')
    expect(app).toContain('scheduledTaskService,')
  })
})

describe('H) 面板能力白名单', () => {
  it('PANEL_CHANNELS 登记两个 channel;readonly/agent 最小集不登记', () => {
    const panelStart = capabilities.indexOf('export const PANEL_CHANNELS')
    const readonlyStart = capabilities.indexOf('export const READONLY_CHANNELS')
    const agentStart = capabilities.indexOf('export const AGENT_CHANNELS')
    expect(panelStart).toBeGreaterThanOrEqual(0)
    expect(readonlyStart).toBeGreaterThan(panelStart)
    expect(agentStart).toBeGreaterThan(readonlyStart)
    const body = (from: number): string => capabilities.slice(from, capabilities.indexOf('];', from))
    const panelBody = body(panelStart)
    expect(panelBody).toContain('"task.schedule"')
    expect(panelBody).toContain('"task.schedule.cancel"')
    expect(body(readonlyStart)).not.toContain('task.schedule')
    expect(body(agentStart)).not.toContain('task.schedule')
  })
})

describe('service 实现面', () => {
  it('30s 缺省 tick、interval unref、stop/stats', () => {
    expect(service).toContain('numberOr(options.tickMs, 30_000)')
    expect(service).toContain('this.timer.unref?.()')
    expect(service).toContain('stop(): void')
    expect(service).toContain('stats(): ServiceStats')
  })

  it('occurrence claim 单飞 + recurring 重排 + fail-soft', () => {
    expect(service).toContain('this.ledger.claim(jobId, instant')
    expect(service).toContain('this.inFlight.has(key)')
    expect(service).toContain('nextRunAt(anchor, recurrence')
    expect(service).toContain('scheduledNext')
    expect(service).toContain('catch (error)')
  })
})
