/**
 * 定时任务内容门(纯逻辑、零 IO、确定性)。
 * 定时任务不是「到点再想做什么」:创建时就要把「跑模型 / 只落提醒」「跑到什么条件才允许执行」
 * 「要不要把上次结果带进来」这些内容口径钉死。本模块只做三件事:
 * 1. validateScheduleContent:校验并归一化(mode/preRun/contextFrom/continuity),未知键一律丢弃;
 * 2. composeScheduledObjective:把上次结果摘要拼到本次任务书前面(无摘要=原样返回);
 * 3. preRunVerdict:把前置命令的退出码翻译成 OK / PRE_RUN_FAILED。
 * 不抛异常(非法输入返回 INVALID + issues),不读时钟,除返回值外不改入参。
 */

export const SCHEDULE_CODES = [
  'OK',
  'INVALID',
  'NO_AGENT',
  'PRE_RUN_FAILED',
  'CONTEXT_MISSING',
] as const
export type ScheduleCode = (typeof SCHEDULE_CODES)[number]

export const SCHEDULE_MODES = ['agent', 'no_agent'] as const
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

/** 任务书上限:与面板单任务正文同量级,超长拒收而不是静默截断。 */
export const MAX_INSTRUCTION_CHARS = 8_000
/** 前置命令上限:命令是 shell 单行,500 字符足够覆盖常见探测。 */
export const MAX_PRE_RUN_CHARS = 500
/** 摘要字符窗口:100..8000,缺省 2000。 */
export const DEFAULT_CONTEXT_MAX_CHARS = 2_000
export const MIN_CONTEXT_MAX_CHARS = 100
export const MAX_CONTEXT_MAX_CHARS = 8_000
/** preRunVerdict 的 stdout 尾巴截断长度。 */
export const PRE_RUN_STDOUT_TAIL_CHARS = 200

export interface NormalizedPreRun {
  readonly command: string
}

export interface NormalizedContextFrom {
  readonly taskId: string | null
  readonly sessionId: string | null
  readonly maxChars: number
}

export interface NormalizedContinuity {
  readonly maxChars: number
}

export interface NormalizedScheduleContent {
  readonly instruction: string
  readonly mode: ScheduleMode
  readonly preRun: NormalizedPreRun | null
  readonly contextFrom: NormalizedContextFrom | null
  readonly continuity: NormalizedContinuity | null
}

export interface ScheduleValidationInput {
  instruction?: unknown
  mode?: unknown
  preRun?: unknown
  contextFrom?: unknown
  continuity?: unknown
}

export interface ScheduleValidation {
  readonly ok: boolean
  readonly code: ScheduleCode
  readonly issues: readonly string[]
  readonly normalized: NormalizedScheduleContent
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function maxCharsOf(value: unknown, issues: string[], label: string): number {
  if (value === undefined || value === null || value === '') return DEFAULT_CONTEXT_MAX_CHARS
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed)
    || parsed < MIN_CONTEXT_MAX_CHARS
    || parsed > MAX_CONTEXT_MAX_CHARS
  ) {
    issues.push(`${label}.maxChars 必须是 ${MIN_CONTEXT_MAX_CHARS}..${MAX_CONTEXT_MAX_CHARS} 的整数`)
    return DEFAULT_CONTEXT_MAX_CHARS
  }
  return parsed
}

function normalizeMode(value: unknown, issues: string[]): ScheduleMode {
  if (value === undefined || value === null || value === '') return 'agent'
  const mode = textOf(value)
  if (!(SCHEDULE_MODES as readonly string[]).includes(mode)) {
    issues.push(`mode 未知:${mode}(只支持 ${SCHEDULE_MODES.join('/')})`)
    return 'agent'
  }
  return mode as ScheduleMode
}

function normalizePreRun(value: unknown, issues: string[]): NormalizedPreRun | null {
  if (value === undefined || value === null) return null
  const source = typeof value === 'string' ? { command: value } : value
  if (typeof source !== 'object') {
    issues.push('preRun 必须是 {command} 或命令字符串')
    return null
  }
  const command = textOf((source as { command?: unknown }).command)
  if (!command) {
    issues.push('preRun.command 不能为空')
    return null
  }
  if (command.length > MAX_PRE_RUN_CHARS) {
    issues.push(`preRun.command 超长(${command.length}>${MAX_PRE_RUN_CHARS})`)
    return null
  }
  return Object.freeze({ command })
}

function normalizeContextFrom(value: unknown, issues: string[]): NormalizedContextFrom | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') {
    issues.push('contextFrom 必须是 {taskId|sessionId, maxChars?}')
    return null
  }
  const source = value as { taskId?: unknown; sessionId?: unknown; maxChars?: unknown }
  const taskId = textOf(source.taskId)
  const sessionId = textOf(source.sessionId)
  if (!taskId && !sessionId) {
    issues.push('contextFrom 需要 taskId 或 sessionId 至少一个')
    return null
  }
  const maxChars = maxCharsOf(source.maxChars, issues, 'contextFrom')
  return Object.freeze({
    taskId: taskId || null,
    sessionId: sessionId || null,
    maxChars,
  })
}

function normalizeContinuity(value: unknown, issues: string[]): NormalizedContinuity | null {
  if (value === undefined || value === null || value === false) return null
  if (value === true) return Object.freeze({ maxChars: DEFAULT_CONTEXT_MAX_CHARS })
  if (typeof value !== 'object') {
    issues.push('continuity 必须是布尔或 {maxChars}')
    return null
  }
  const maxChars = maxCharsOf(
    (value as { maxChars?: unknown }).maxChars,
    issues,
    'continuity',
  )
  return Object.freeze({ maxChars })
}

function emptyNormalized(instruction: string): NormalizedScheduleContent {
  return Object.freeze({
    instruction,
    mode: 'agent' as const,
    preRun: null,
    contextFrom: null,
    continuity: null,
  })
}

/** 校验并归一化定时任务内容;未知键不进 normalized(调用方无需自行清理)。 */
export function validateScheduleContent(input: ScheduleValidationInput = {}): ScheduleValidation {
  const issues: string[] = []
  const instruction = textOf(input.instruction)
  if (!instruction) {
    issues.push('instruction 不能为空')
  } else if (instruction.length > MAX_INSTRUCTION_CHARS) {
    issues.push(`instruction 超长(${instruction.length}>${MAX_INSTRUCTION_CHARS})`)
  }
  const mode = normalizeMode(input.mode, issues)
  const preRun = normalizePreRun(input.preRun, issues)
  const contextFrom = normalizeContextFrom(input.contextFrom, issues)
  const continuity = normalizeContinuity(input.continuity, issues)
 // no_agent 提醒也必须带正文:只有 mode 没有 instruction 的「空提醒」视为非法(上面已拦)。
  const normalized = issues.length
    ? emptyNormalized(instruction)
    : Object.freeze({ instruction, mode, preRun, contextFrom, continuity })
  const ok = issues.length === 0
  return Object.freeze({
    ok,
    code: ok ? (normalized.mode === 'no_agent' ? 'NO_AGENT' : 'OK') : 'INVALID',
    issues: Object.freeze([...issues]),
    normalized,
  })
}

export interface ComposeObjectiveInput {
  instruction?: unknown
  contextSummary?: unknown
  continuitySummary?: unknown
}

function summaryOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_INSTRUCTION_CHARS)
}

/**
 * 拼接本次任务书:上下文段在前、系列段居中、原 instruction 在最后(收尾指令不被摘要淹没)。
 * 两段摘要都没有时逐字返回原 instruction(旧路径零变化)。
 */
export function composeScheduledObjective(input: ComposeObjectiveInput = {}): string {
  const instruction = typeof input.instruction === 'string' ? input.instruction : ''
  const contextSummary = summaryOf(input.contextSummary)
  const continuitySummary = summaryOf(input.continuitySummary)
  if (!contextSummary && !continuitySummary) return instruction
  const sections: string[] = []
  if (contextSummary) sections.push(`[上次任务结果摘要]\n${contextSummary}`)
  if (continuitySummary) sections.push(`[本系列上次结果]\n${continuitySummary}`)
  sections.push(instruction)
  return sections.join('\n\n')
}

export interface PreRunVerdictInput {
  exitCode?: unknown
  stdoutTail?: unknown
}

export interface PreRunVerdict {
  readonly ok: boolean
  readonly code: 'OK' | 'PRE_RUN_FAILED'
  readonly reason: string
}

/** 前置命令退出码判定:0=OK;非 0/无退出码(超时、被信号杀)=PRE_RUN_FAILED。 */
export function preRunVerdict(input: PreRunVerdictInput = {}): PreRunVerdict {
  const raw = input.exitCode
  const exitCode = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  const tail = typeof input.stdoutTail === 'string'
    ? input.stdoutTail.trim().slice(0, PRE_RUN_STDOUT_TAIL_CHARS)
    : ''
  if (Number.isFinite(exitCode) && exitCode === 0) {
    return Object.freeze({ ok: true, code: 'OK' as const, reason: 'pre_run 通过 (exit 0)' })
  }
  const label = Number.isFinite(exitCode) ? `exit ${exitCode}` : '未返回退出码(超时/被终止)'
  return Object.freeze({
    ok: false,
    code: 'PRE_RUN_FAILED' as const,
    reason: tail ? `pre_run 失败 (${label}): ${tail}` : `pre_run 失败 (${label})`,
  })
}
