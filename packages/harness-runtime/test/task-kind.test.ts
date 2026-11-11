/**
 * 任务 kind 封闭枚举与逐类能力表的纯逻辑测试(零 IO:不碰文件/网络/环境)。
 * 每例标题带探针标签,与任务验收的 A–G 对应:
 * A) 8 类能力表齐; B) 未知 kind → user + normalized=false; C) reminder guard write_file → DENY;
 * D) 工具过滤(reminder 无 terminal/write/spawn,minimal 保留); E) memoryScope(project/session);
 * F) 默认 user 能力全开(接线兼容的口径保证); G) 不可变与确定性。
 */
import { describe, it, expect } from 'vitest'
import {
  TASK_KINDS,
  TASK_KIND_CAPABILITIES,
  KIND_SPAWN_TOOLS,
  KIND_TERMINAL_TOOLS,
  KIND_WRITE_TOOLS,
  KIND_READONLY_TOOLS,
  normalizeTaskKind,
  taskKindCapabilities,
  kindGuard,
  filterToolNamesByKindCapabilities,
  type TaskKind,
  type TaskKindCapabilities,
} from '../src/task/task-kind'

describe('A) 枚举与能力表齐备', () => {
  it('枚举共 8 类且顺序固定(封闭集合,新增必须显式改表)', () => {
    expect([...TASK_KINDS]).toEqual([
      'user', 'system', 'reminder', 'scheduled_task', 'subagent', 'workflow', 'meeting', 'automation',
    ])
    expect(new Set(TASK_KINDS).size).toBe(8)
  })

  it('枚举本身冻结(就地 push/改写不生效)', () => {
    expect(Object.isFrozen(TASK_KINDS)).toBe(true)
    expect(() => (TASK_KINDS as unknown as string[]).push('ghost')).toThrow()
  })

  it('能力表键集与枚举完全一致(无缺项、无多余项)', () => {
    expect(Object.keys(TASK_KIND_CAPABILITIES).sort()).toEqual([...TASK_KINDS].sort())
    for (const kind of TASK_KINDS) {
      expect(TASK_KIND_CAPABILITIES[kind as TaskKind], kind).toBeTruthy()
    }
  })

  it('user/system:全能力 + project 域', () => {
    for (const kind of ['user', 'system'] as const) {
      const caps = TASK_KIND_CAPABILITIES[kind]
      expect(caps, kind).toMatchObject({
        canSpawnSubagent: true, canUseTerminal: true, canWriteFiles: true, memoryScope: 'project', canAnnounce: true,
      })
      expect(caps.minimalLifecycleTools).toEqual([])
    }
  })

  it('reminder/scheduled_task:只读 + session 域 + minimal 三件', () => {
    for (const kind of ['reminder', 'scheduled_task'] as const) {
      const caps = TASK_KIND_CAPABILITIES[kind]
      expect(caps, kind).toMatchObject({
        canSpawnSubagent: false, canUseTerminal: false, canWriteFiles: false, memoryScope: 'session',
      })
      expect(caps.minimalLifecycleTools).toEqual(['todo_write', 'task_phase', 'ask_user'])
    }
  })

  it('subagent/workflow:全能力 + session 域且不公告终态', () => {
    for (const kind of ['subagent', 'workflow'] as const) {
      const caps = TASK_KIND_CAPABILITIES[kind]
      expect(caps, kind).toMatchObject({
        canSpawnSubagent: true, canUseTerminal: true, canWriteFiles: true, memoryScope: 'session',
      })
      expect(caps.canAnnounce, kind).toBe(false)
    }
  })

  it('meeting:只读 + project 域', () => {
    const caps = TASK_KIND_CAPABILITIES.meeting
    expect(caps).toMatchObject({ canSpawnSubagent: false, canUseTerminal: false, canWriteFiles: false, memoryScope: 'project' })
    expect(caps.minimalLifecycleTools).toEqual([])
  })

  it('automation:全能力 + project 域', () => {
    expect(TASK_KIND_CAPABILITIES.automation).toMatchObject({
      canSpawnSubagent: true, canUseTerminal: true, canWriteFiles: true, memoryScope: 'project',
    })
  })

  it('G) 能力表逐项冻结(表、能力对象、minimal 数组)', () => {
    expect(Object.isFrozen(TASK_KIND_CAPABILITIES)).toBe(true)
    for (const kind of TASK_KINDS) {
      const caps = TASK_KIND_CAPABILITIES[kind as TaskKind]
      expect(Object.isFrozen(caps), kind).toBe(true)
      expect(Object.isFrozen(caps.minimalLifecycleTools), kind).toBe(true)
    }
  })
})

describe('B) normalizeTaskKind 归一与显式回落', () => {
  it('已知 kind 原样返回且 normalized=true', () => {
    for (const kind of TASK_KINDS) {
      expect(normalizeTaskKind(kind)).toEqual({ kind, normalized: true, original: kind })
    }
  })

  it('未知 kind → user,normalized=false,original 保留原值', () => {
    expect(normalizeTaskKind('work')).toEqual({ kind: 'user', normalized: false, original: 'work' })
    expect(normalizeTaskKind('system_job')).toEqual({ kind: 'user', normalized: false, original: 'system_job' })
  })

  it('空串 / undefined / null → user,original 为空串', () => {
    expect(normalizeTaskKind('')).toEqual({ kind: 'user', normalized: false, original: '' })
    expect(normalizeTaskKind(undefined)).toEqual({ kind: 'user', normalized: false, original: '' })
    expect(normalizeTaskKind(null)).toEqual({ kind: 'user', normalized: false, original: '' })
  })

  it('非字符串输入按 String 归一(42 / true)', () => {
    expect(normalizeTaskKind(42)).toEqual({ kind: 'user', normalized: false, original: '42' })
    expect(normalizeTaskKind(true)).toEqual({ kind: 'user', normalized: false, original: 'true' })
  })

  it('自定义 fallback 生效(未知 → fallback 且 normalized=false)', () => {
    expect(normalizeTaskKind('nope', { fallback: 'meeting' })).toEqual({ kind: 'meeting', normalized: false, original: 'nope' })
  })

  it('非法 fallback 再回落 user(不抛错)', () => {
    expect(normalizeTaskKind('nope', { fallback: 'ghost' }).kind).toBe('user')
  })

  it('前后空白被 trim 后命中枚举(original 保留原文)', () => {
    expect(normalizeTaskKind('  reminder ')).toEqual({ kind: 'reminder', normalized: true, original: '  reminder ' })
  })
})

describe('C) taskKindCapabilities / kindGuard', () => {
  it('已知 kind → code OK 且能力表同一对象(只读引用)', () => {
    const look = taskKindCapabilities('reminder')
    expect(look.code).toBe('OK')
    expect(look.kind).toBe('reminder')
    expect(look.capabilities).toBe(TASK_KIND_CAPABILITIES.reminder)
  })

  it('未知 kind → user 能力 + UNKNOWN_KIND(不静默)', () => {
    const look = taskKindCapabilities('work')
    expect(look.kind).toBe('user')
    expect(look.code).toBe('UNKNOWN_KIND')
    expect(look.capabilities).toBe(TASK_KIND_CAPABILITIES.user)
  })

  it('reminder 的四种动作全部 DENY(write/terminal/spawn/memory_project)', () => {
    for (const action of ['write_file', 'terminal', 'spawn_subagent', 'memory_project'] as const) {
      expect(kindGuard('reminder', action), action).toEqual({ allow: false, code: 'KIND_DENY' })
    }
  })

  it('user 的四种动作全部 OK', () => {
    for (const action of ['write_file', 'terminal', 'spawn_subagent', 'memory_project'] as const) {
      expect(kindGuard('user', action), action).toEqual({ allow: true, code: 'OK' })
    }
  })

  it('meeting 只读:写/终端/委派 DENY,但 project 记忆域放行', () => {
    expect(kindGuard('meeting', 'write_file')).toEqual({ allow: false, code: 'KIND_DENY' })
    expect(kindGuard('meeting', 'memory_project')).toEqual({ allow: true, code: 'OK' })
  })

  it('subagent/workflow:session 域 → memory_project DENY(只注入会话域)', () => {
    for (const kind of ['subagent', 'workflow'] as const) {
      expect(kindGuard(kind, 'memory_project')).toEqual({ allow: false, code: 'KIND_DENY' })
    }
  })

  it('未知 kind 的 guard 走 user 能力(fail-safe 放行)且不抛错', () => {
    expect(() => kindGuard('ghost', 'write_file')).not.toThrow()
    expect(kindGuard('ghost', 'write_file')).toEqual({ allow: true, code: 'OK' })
  })
})

describe('D) 工具面按能力位过滤', () => {
  const ALL_NAMES = [
    'spawn_subagent', 'steer_agent', 'resume_agent', 'stop_agent', 'list_agents',
    'terminal', 'run_cmd', 'write_file', 'edit_file', 'apply_patch', 'board_upsert',
    'read_file', 'glob', 'grep', 'code_sense', 'tool_view', 'todo_write', 'task_phase', 'ask_user',
    'run_code', 'browser',
  ]

  it('reminder:删干净 spawn/terminal/write,只留 minimal + 只读工具', () => {
    const { kept, removed } = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.reminder)
    expect(kept).toEqual(['read_file', 'glob', 'grep', 'code_sense', 'tool_view', 'todo_write', 'task_phase', 'ask_user'])
    expect(removed).toEqual(['spawn_subagent', 'steer_agent', 'resume_agent', 'stop_agent', 'list_agents', 'terminal', 'run_cmd', 'write_file', 'edit_file', 'apply_patch', 'board_upsert', 'run_code', 'browser'])
  })

  it('D) reminder:三类工具名一个都不在 kept 里', () => {
    const { kept } = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.reminder)
    for (const name of [...KIND_SPAWN_TOOLS, ...KIND_TERMINAL_TOOLS, ...KIND_WRITE_TOOLS]) {
      expect(kept, name).not.toContain(name)
    }
    for (const name of KIND_READONLY_TOOLS) {
      expect(kept, name).toContain(name)
    }
  })

  it('F) 默认 user:removed 为空,kept 与输入逐字同序(兼容)', () => {
    const { kept, removed } = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.user)
    expect(removed).toEqual([])
    expect(kept).toEqual(ALL_NAMES)
  })

  it('meeting(只读但 minimal 为空):只删三类工具,其余保留', () => {
    const names = ['read_file', 'run_workflow', 'terminal', 'write_file', 'spawn_subagent', 'browser']
    const { kept, removed } = filterToolNamesByKindCapabilities(names, TASK_KIND_CAPABILITIES.meeting)
    expect(kept).toEqual(['read_file', 'run_workflow', 'browser'])
    expect(removed).toEqual(['terminal', 'write_file', 'spawn_subagent'])
  })

  it('D) 自定义 caps(minimal 非空)按 minimal + 只读收敛', () => {
    const caps: TaskKindCapabilities = {
      ...TASK_KIND_CAPABILITIES.reminder,
      minimalLifecycleTools: ['todo_write'],
    }
    const { kept } = filterToolNamesByKindCapabilities(['todo_write', 'read_file', 'grep', 'task_phase', 'run_workflow'], caps)
 // task_phase 属只读集合 → 即便不在 minimal 里也保留;run_workflow 非只读 → 收敛掉。
    expect(kept).toEqual(['todo_write', 'read_file', 'grep', 'task_phase'])
  })

  it('G) 过滤确定性:同输入两次结果逐字相同', () => {
    const a = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.scheduled_task)
    const b = filterToolNamesByKindCapabilities(ALL_NAMES, TASK_KIND_CAPABILITIES.scheduled_task)
    expect(a).toEqual(b)
  })

  it('G) 能力查询确定性:同 kind 两次返回同一能力对象', () => {
    expect(taskKindCapabilities('workflow').capabilities).toBe(taskKindCapabilities('workflow').capabilities)
    expect(taskKindCapabilities('workflow')).toEqual(taskKindCapabilities('workflow'))
  })

  it('空工具面与全程不抛错(边界)', () => {
    expect(filterToolNamesByKindCapabilities([], TASK_KIND_CAPABILITIES.reminder)).toEqual({ kept: [], removed: [] })
    expect(() => filterToolNamesByKindCapabilities([''], TASK_KIND_CAPABILITIES.meeting)).not.toThrow()
  })
})

describe('E) 记忆域位(memoryScope)', () => {
  it('project=user/system/meeting/automation;session=reminder/scheduled_task/subagent/workflow', () => {
    const project = TASK_KINDS.filter((k) => TASK_KIND_CAPABILITIES[k as TaskKind].memoryScope === 'project')
    const session = TASK_KINDS.filter((k) => TASK_KIND_CAPABILITIES[k as TaskKind].memoryScope === 'session')
    expect(project).toEqual(['user', 'system', 'meeting', 'automation'])
    expect(session).toEqual(['reminder', 'scheduled_task', 'subagent', 'workflow'])
  })

  it('记忆域 none 是能力位合法取值(类型面),且 kindGuard memory_project 判 DENY', () => {
    const caps: TaskKindCapabilities = { ...TASK_KIND_CAPABILITIES.user, memoryScope: 'none' }
    expect(caps.memoryScope).toBe('none')
 // 无 kind 对应 none,但 guard 的判定口径对非 project 域一律 DENY
    expect(kindGuard('subagent', 'memory_project').code).toBe('KIND_DENY')
  })
})
