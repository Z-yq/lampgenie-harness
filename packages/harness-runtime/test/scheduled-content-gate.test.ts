/**
 * 内容门纯逻辑测试:校验/归一化/摘要拼接/pre_run 判定。
 * 全部走真实函数,不 mock;断言集中在确定性行为(不读时钟、不改入参)。
 */
import { describe, it, expect } from 'vitest'
import {
  SCHEDULE_CODES,
  SCHEDULE_MODES,
  DEFAULT_CONTEXT_MAX_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_PRE_RUN_CHARS,
  preRunVerdict,
  composeScheduledObjective,
  validateScheduleContent,
} from '../src/task/scheduled-content-gate'

describe('内容门常量', () => {
  it('SCHEDULE_CODES 全集固定', () => {
    expect([...SCHEDULE_CODES]).toEqual([
      'OK', 'INVALID', 'NO_AGENT', 'PRE_RUN_FAILED', 'CONTEXT_MISSING',
    ])
  })

  it('SCHEDULE_MODES 只支持 agent/no_agent', () => {
    expect([...SCHEDULE_MODES]).toEqual(['agent', 'no_agent'])
  })
})

describe('validateScheduleContent', () => {
  it('缺省输入=agent 纯任务书,无 preRun/context/continuity', () => {
    const r = validateScheduleContent({ instruction: '  整理周报  ' })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('OK')
    expect(r.issues).toEqual([])
    expect(r.normalized.instruction).toBe('整理周报')
    expect(r.normalized.mode).toBe('agent')
    expect(r.normalized.preRun).toBeNull()
    expect(r.normalized.contextFrom).toBeNull()
    expect(r.normalized.continuity).toBeNull()
  })

  it('instruction 为空 → INVALID 且不产出可用 normalized', () => {
    const r = validateScheduleContent({ instruction: '   ' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID')
    expect(r.issues.length).toBeGreaterThan(0)
  })

  it('instruction 超 8000 → INVALID', () => {
    const r = validateScheduleContent({ instruction: 'a'.repeat(MAX_INSTRUCTION_CHARS + 1) })
    expect(r.code).toBe('INVALID')
    expect(r.issues.join()).toContain('超长')
  })

  it('未知 mode → INVALID', () => {
    const r = validateScheduleContent({ instruction: 'x', mode: 'no-model' })
    expect(r.code).toBe('INVALID')
    expect(r.issues.join()).toContain('mode')
  })

  it('no_agent 合法 → code=NO_AGENT 且 mode 归一', () => {
    const r = validateScheduleContent({ instruction: '提醒我喝水', mode: 'no_agent' })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('NO_AGENT')
    expect(r.normalized.mode).toBe('no_agent')
  })

  it('preRun 字符串与 {command} 两种写法都归一为 {command}', () => {
    const fromString = validateScheduleContent({ instruction: 'x', preRun: 'test -f ok' })
    expect(fromString.ok).toBe(true)
    expect(fromString.normalized.preRun).toEqual({ command: 'test -f ok' })
    const fromObject = validateScheduleContent({ instruction: 'x', preRun: { command: ' npm test ' } })
    expect(fromObject.normalized.preRun).toEqual({ command: 'npm test' })
  })

  it('preRun 空命令 / 超 500 → INVALID', () => {
    expect(validateScheduleContent({ instruction: 'x', preRun: { command: '  ' } }).code).toBe('INVALID')
    const tooLong = 'a'.repeat(MAX_PRE_RUN_CHARS + 1)
    expect(validateScheduleContent({ instruction: 'x', preRun: { command: tooLong } }).code).toBe('INVALID')
  })

  it('contextFrom 缺 taskId/sessionId → INVALID', () => {
    const r = validateScheduleContent({ instruction: 'x', contextFrom: { maxChars: 500 } })
    expect(r.code).toBe('INVALID')
    expect(r.issues.join()).toContain('taskId')
  })

  it('contextFrom maxChars 缺省 2000;越界(50/9000) → INVALID', () => {
    const ok = validateScheduleContent({ instruction: 'x', contextFrom: { taskId: 't1' } })
    expect(ok.ok).toBe(true)
    expect(ok.normalized.contextFrom).toEqual({ taskId: 't1', sessionId: null, maxChars: DEFAULT_CONTEXT_MAX_CHARS })
    expect(validateScheduleContent({ instruction: 'x', contextFrom: { taskId: 't1', maxChars: 50 } }).code).toBe('INVALID')
    expect(validateScheduleContent({ instruction: 'x', contextFrom: { taskId: 't1', maxChars: 9000 } }).code).toBe('INVALID')
  })

  it('contextFrom 与 continuity 可并存', () => {
    const r = validateScheduleContent({
      instruction: 'x',
      contextFrom: { sessionId: 's1', maxChars: 400 },
      continuity: { maxChars: 600 },
    })
    expect(r.ok).toBe(true)
    expect(r.normalized.contextFrom).toEqual({ taskId: null, sessionId: 's1', maxChars: 400 })
    expect(r.normalized.continuity).toEqual({ maxChars: 600 })
  })

  it('continuity=true 归一为缺省窗口;false/null 清除', () => {
    expect(validateScheduleContent({ instruction: 'x', continuity: true }).normalized.continuity)
      .toEqual({ maxChars: DEFAULT_CONTEXT_MAX_CHARS })
    expect(validateScheduleContent({ instruction: 'x', continuity: false }).normalized.continuity).toBeNull()
    expect(validateScheduleContent({ instruction: 'x', continuity: null }).normalized.continuity).toBeNull()
  })

  it('未知键被丢弃(normalized 只含已知字段)', () => {
    const r = validateScheduleContent({
      instruction: 'x',
      mode: 'agent',
      mystery: 'nope',
      preRun: { command: 'true', extra: 1 },
    } as never)
    expect(Object.keys(r.normalized).sort()).toEqual([
      'contextFrom', 'continuity', 'instruction', 'mode', 'preRun',
    ])
    expect(Object.keys(r.normalized.preRun as object)).toEqual(['command'])
    expect(JSON.stringify(r.normalized)).not.toContain('mystery')
  })

  it('确定性 + 返回值不可变', () => {
    const input = { instruction: 'x', mode: 'agent', contextFrom: { taskId: 't', maxChars: 300 } }
    const a = validateScheduleContent(input)
    const b = validateScheduleContent(input)
    expect(a).toEqual(b)
    expect(Object.isFrozen(a)).toBe(true)
    expect(Object.isFrozen(a.normalized)).toBe(true)
    expect(Object.isFrozen(a.normalized.contextFrom)).toBe(true)
  })
})

describe('composeScheduledObjective', () => {
  it('无摘要=逐字返回原 instruction', () => {
    expect(composeScheduledObjective({ instruction: '原任务书' })).toBe('原任务书')
    expect(composeScheduledObjective({ instruction: '原任务书', contextSummary: '   ' })).toBe('原任务书')
  })

  it('context 段在前、instruction 在最后', () => {
    const text = composeScheduledObjective({ instruction: '继续写报告', contextSummary: '上次完成了 A' })
    expect(text).toContain('[上次任务结果摘要]')
    expect(text).toContain('上次完成了 A')
    expect(text.indexOf('上次完成了 A')).toBeLessThan(text.indexOf('继续写报告'))
  })

  it('context 与 continuity 同时存在时顺序固定', () => {
    const text = composeScheduledObjective({
      instruction: '第三步',
      contextSummary: '外部摘要',
      continuitySummary: '系列摘要',
    })
    const order = ['[上次任务结果摘要]', '外部摘要', '[本系列上次结果]', '系列摘要', '第三步']
    let cursor = -1
    for (const piece of order) {
      const at = text.indexOf(piece)
      expect(at).toBeGreaterThan(cursor)
      cursor = at
    }
  })
})

describe('preRunVerdict', () => {
  it('exit 0 → OK', () => {
    const r = preRunVerdict({ exitCode: 0 })
    expect(r).toEqual({ ok: true, code: 'OK', reason: expect.stringContaining('exit 0') })
  })

  it('非 0 → PRE_RUN_FAILED,reason 带退出码与 stdout 尾巴', () => {
    const r = preRunVerdict({ exitCode: 1, stdoutTail: 'missing dependency' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('PRE_RUN_FAILED')
    expect(r.reason).toContain('exit 1')
    expect(r.reason).toContain('missing dependency')
  })

  it('无退出码(超时/被终止) → PRE_RUN_FAILED', () => {
    for (const exitCode of [undefined, null, '', Number.NaN]) {
      const r = preRunVerdict({ exitCode })
      expect(r.ok).toBe(false)
      expect(r.code).toBe('PRE_RUN_FAILED')
    }
  })

  it('stdoutTail 截 200 字符', () => {
    const r = preRunVerdict({ exitCode: 2, stdoutTail: 'x'.repeat(400) })
    expect(r.reason.length).toBeLessThanOrEqual(200 + 40)
    expect(r.reason).toContain('x'.repeat(200))
    expect(r.reason).not.toContain('x'.repeat(201))
  })
})
