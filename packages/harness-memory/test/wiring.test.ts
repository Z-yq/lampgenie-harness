// wiring 集成面测试:桶导出可解析、contextBlock 渲染语义、会话关闭钩子
// (无 LLM no-op / 抽取器落盘 / 最少用户消息门 / 观察器证据守卫 / 两会话晋升),
// 以及 MarkdownDocumentStore 的精确编辑契约(stale/ambiguous/owner 隔离)。
// 运行方式与包脚本一致:NODE_OPTIONS=--conditions=development npx vitest run
// (带 @lampgenie/memory 名称导入的用例依赖 development 条件解析到 src)。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  // 名称导入:同时验证 package exports("development" -> src/index.ts)可解析。
  createMemoryWiring as createMemoryWiringFromPackage,
  PROMOTION_MARKERS,
  guardMemoryProvider,
  buildMemoryBriefing,
  summarizeMemoryProvider,
} from '@lampgenie/memory'
import {
  createMemoryWiring,
  type MemoryAuditEvent,
  type MemoryAuditSink,
  type MemoryLlmRequest,
  type MemoryWiring,
  type TranscriptMessage,
} from '../src/index'

const OBSERVED_NOTICE = PROMOTION_MARKERS.OBSERVED_NOTICE

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-memory-wiring-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface LlmRouter {
  calls: MemoryLlmRequest[]
  llmCall: (request: MemoryLlmRequest) => Promise<string>
}

/** 抽取器与观察器共用一个 llmCall 入口,按 system 提示词分派假响应。 */
function llmRouter(overrides: {
  extractor?: (request: MemoryLlmRequest) => string
  observer?: (request: MemoryLlmRequest) => string
} = {}): LlmRouter {
  const calls: MemoryLlmRequest[] = []
  const llmCall = async (request: MemoryLlmRequest): Promise<string> => {
    calls.push(request)
    const isExtractor = request.system.includes('USER.md')
    const handler = isExtractor ? overrides.extractor : overrides.observer
    return handler
      ? handler(request)
      : (isExtractor ? '{"changes":[]}' : '{"answers":[]}')
  }
  return { calls, llmCall }
}

function auditSink(events: MemoryAuditEvent[]): MemoryAuditSink {
  return { record: event => events.push(event) }
}

function userTranscript(...lines: string[]): TranscriptMessage[] {
  return lines.map(content => ({ role: 'user' as const, content }))
}

const TEACHER_TRANSCRIPT = userTranscript(
  '我在市一中教高中语文，带毕业班',
  '平时喜欢跑步',
  '周末常去图书馆看书',
  '最近在准备一门公开课',
)

const TEACHER_ANSWER = JSON.stringify({
  answers: [
    {
      field: 'occupation',
      value: '高中语文老师',
      quote: '我在市一中教高中语文',
      basis: '用户自述职业',
      vs_known: 'first_time',
    },
    { field: 'response_length', value: 'unknown', quote: '', basis: '', vs_known: '' },
    { field: 'response_style', value: 'unknown', quote: '', basis: '', vs_known: '' },
    { field: 'special_skills', value: 'unknown', quote: '', basis: '', vs_known: '' },
  ],
})

describe('createMemoryWiring 构造与包导出', () => {
  it('src/index 与包名入口解析到同一实现', async () => {
    const wiring = createMemoryWiring({ root })
    expect(typeof createMemoryWiringFromPackage).toBe('function')
    expect(createMemoryWiringFromPackage).toBe(createMemoryWiring)
    expect(wiring.root).toBe(root)
    // provider 满足 MemoryProvider 协议(protocol v2, markdown)。
    const description = summarizeMemoryProvider(wiring.provider)
    expect(description.key).toBe('markdown')
    expect(description.protocolVersion).toBe(2)
    expect(() => guardMemoryProvider(wiring.provider)).not.toThrow()
    // 缺 llmCall:学习链路关闭,读路径照常。
    expect(wiring.learningEnabled()).toEqual({
      extractor: false,
      observer: false,
      promoter: true,
    })
    expect(wiring.candidatePool.health().persistenceEnabled).toBe(true)
  })

  it('缺 root 抛 TypeError', () => {
    expect(() => createMemoryWiring({ root: '' })).toThrow(TypeError)
  })
})

describe('contextBlock 渲染', () => {
  it('空库返回空串,调用方无需前缀处理', () => {
    const wiring = createMemoryWiring({ root })
    expect(wiring.contextBlock('u_nobody')).toBe('')
    expect(buildMemoryBriefing({ memories: [] })).toBe('')
  })

  it('渲染 user/memory 两文档,剥离模板注释但保留观察声明', () => {
    const wiring = createMemoryWiring({ root })
    const ownerId = 'u_ctx'
    wiring.provider.apply(ownerId, [
      {
        document: 'user',
        append: [
          '<!-- 编辑指引：模板注释不是事实 -->',
          '## 用户明确要求',
          '- 叫我小飞',
          '',
          '## 观察推断',
          OBSERVED_NOTICE,
          '- 职业：高中语文老师',
        ].join('\n'),
      },
      { document: 'memory', append: '- 用户在杭州工作' },
    ])

    const block = wiring.contextBlock(ownerId)
    expect(block).toContain('<user_preferences revision="')
    expect(block).toContain('叫我小飞')
    expect(block).toContain('职业：高中语文老师')
    expect(block).toContain(OBSERVED_NOTICE)
    expect(block).toContain('<user_memory')
    expect(block).toContain('用户在杭州工作')
    // 模板注释是编辑指引,不是保存的用户事实。
    expect(block).not.toContain('编辑指引')

    // 其他 owner 隔离(users/<digest>/ 子目录)。
    expect(wiring.contextBlock('u_other')).toBe('')
  })
})

describe('onSessionClose', () => {
  it('无 llmCall 时全程 no-op:不写盘、不抛错', async () => {
    const wiring = createMemoryWiring({ root })
    await expect(wiring.onSessionClose({
      ownerId: 'u_cold',
      sessionId: 's1',
      transcript: userTranscript('一条', '两条', '三条', '四条'),
    })).resolves.toBeUndefined()
    expect(wiring.provider.list('u_cold')).toEqual([])
    expect(wiring.candidatePool.list('u_cold')).toEqual([])
    // 未写任何文档文件(候选池快照也未被触碰)。
    expect(readdirSync(root)).toEqual([])
    // 空转写与缺 ownerId 同样安全。
    await expect(wiring.onSessionClose({
      ownerId: 'u_cold',
      sessionId: 's1',
      transcript: [],
    })).resolves.toBeUndefined()
    await expect(wiring.onSessionClose({
      ownerId: '',
      sessionId: 's1',
      transcript: userTranscript('x'),
    })).resolves.toBeUndefined()
  })

  it('抽取器链路:假 LLM 返回 JSON ops,写入经 provider 可读回', async () => {
    const events: MemoryAuditEvent[] = []
    const router = llmRouter({
      extractor: () => JSON.stringify({
        changes: [
          { document: 'user', edits: [], append: '## 用户明确要求\n- 以后叫我小飞' },
        ],
      }),
    })
    const wiring = createMemoryWiring({
      root,
      llmCall: router.llmCall,
      audit: auditSink(events),
    })

    const transcript: TranscriptMessage[] = [
      { role: 'user', content: '以后请叫我小飞' },
      { role: 'assistant', content: '好的,小飞。' },
      ...userTranscript('今天聊点工作上的事吧', '我们团队在做语音助手', '回头帮你看看部署文档'),
    ]
    await wiring.onSessionClose({ ownerId: 'u_ext', sessionId: 's-ext-1', transcript })

    const documents = wiring.provider.list('u_ext')
    const userDoc = documents.find(document => document.scope === 'user')
    expect(userDoc?.content).toContain('以后叫我小飞')

    // llmCall 契约:({system, user}) 对象;user 里带现有文档与转写。
    const extractorCall = router.calls.find(call => call.system.includes('USER.md'))
    expect(extractorCall).toBeDefined()
    expect(extractorCall?.system).toContain('只输出一个 JSON 对象')
    expect(extractorCall?.user).toContain('以后请叫我小飞')
    expect(extractorCall?.user).toContain('## 当前 USER.md')

    const patch = events.find(event => event.op === 'patch')
    expect(patch).toBeDefined()
    expect(patch?.documents).toEqual(['user'])
    expect(events.filter(event => event.op === 'error')).toEqual([])
  })

  it('最少用户消息门:1 条用户消息不触发任何 llm 调用', async () => {
    const router = llmRouter()
    const wiring = createMemoryWiring({ root, llmCall: router.llmCall })
    await wiring.onSessionClose({
      ownerId: 'u_gate',
      sessionId: 's-gate',
      transcript: [
        { role: 'user', content: '帮我查个东西' },
        { role: 'assistant', content: '好的' },
      ],
    })
    expect(router.calls).toEqual([])
    expect(wiring.provider.list('u_gate')).toEqual([])
    expect(wiring.candidatePool.list('u_gate')).toEqual([])

    // 显式调低门槛后同样转写可触发(两条即跑)。
    const tuned = createMemoryWiring({
      root,
      llmCall: router.llmCall,
      learning: { minUserMessages: 2 },
    })
    await tuned.onSessionClose({
      ownerId: 'u_gate2',
      sessionId: 's-gate2',
      transcript: userTranscript('以后回答简短点', '就这样'),
    })
    expect(router.calls.length).toBeGreaterThan(0)
  })

  it('证据守卫:quote 不在用户发言里的观察被结构性拒收,池不变', async () => {
    const events: MemoryAuditEvent[] = []
    const router = llmRouter({
      observer: () => JSON.stringify({
        answers: [
          {
            field: 'occupation',
            value: '高中语文老师',
            quote: '我在市一中教高中语文',
            basis: '用户自述职业',
            vs_known: 'first_time',
          },
          {
            // 编造证据:quote 不在转写里。
            field: 'special_skills',
            value: '量子计算',
            quote: '我昨天在研究量子计算',
            basis: '凭空',
            vs_known: 'first_time',
          },
        ],
      }),
    })
    const wiring = createMemoryWiring({
      root,
      llmCall: router.llmCall,
      audit: auditSink(events),
    })

    await wiring.onSessionClose({
      ownerId: 'u_guard',
      sessionId: 's-guard-1',
      transcript: TEACHER_TRANSCRIPT,
    })

    const slots = wiring.candidatePool.list('u_guard')
    expect(slots).toHaveLength(1)
    expect(slots[0]?.field).toBe('occupation')
    expect(slots[0]?.value).toBe('高中语文老师')
    expect(slots[0]?.state).toBe('tentative')
    expect(slots[0]?.confirm).toBe(1)
    expect(slots[0]?.evidence[0]?.quote).toBe('我在市一中教高中语文')

    const rejection = events.find(
      event => event.op === 'skip' && event.reason === 'quote_not_from_user',
    )
    expect(rejection).toBeDefined()
    expect(events.filter(event => event.op === 'error')).toEqual([])
  })

  it('两场会话攒够确认后自动晋升进 USER.md 观察区,contextBlock 带观察声明', async () => {
    const events: MemoryAuditEvent[] = []
    const router = llmRouter({ observer: () => TEACHER_ANSWER })
    const wiring = createMemoryWiring({
      root,
      llmCall: router.llmCall,
      audit: auditSink(events),
    })

    // 第一场:观察入池(confirm=1, 1 个会话),尚不可晋升。
    await wiring.onSessionClose({
      ownerId: 'u_promo',
      sessionId: 's-promo-1',
      transcript: TEACHER_TRANSCRIPT,
    })
    const afterFirst = wiring.candidatePool.list('u_promo')
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0]?.ready).toBe(false)
    expect(wiring.promoter.listObserved('u_promo')).toEqual([])

    // 第二场:跨会话确认凑满,关闭钩子尾部自动晋升。
    await wiring.onSessionClose({
      ownerId: 'u_promo',
      sessionId: 's-promo-2',
      transcript: TEACHER_TRANSCRIPT,
    })

    const slots = wiring.candidatePool.list('u_promo')
    expect(slots[0]?.state).toBe('active')
    expect(slots[0]?.confirm).toBe(2)
    expect(slots[0]?.sessions).toEqual(['s-promo-1', 's-promo-2'])

    const userDoc = wiring.provider.list('u_promo').find(document => document.scope === 'user')
    expect(userDoc?.content).toContain('## 观察推断')
    expect(userDoc?.content).toContain(OBSERVED_NOTICE)
    expect(userDoc?.content).toContain('- 职业：高中语文老师')
    // 明说区物理分区:晋升器只写观察区。
    expect(userDoc?.content).not.toContain('## 用户明确要求')

    const block = wiring.contextBlock('u_promo')
    expect(block).toContain('<user_preferences revision="')
    expect(block).toContain(OBSERVED_NOTICE)
    expect(block).toContain('职业：高中语文老师')

    const appended = events.find(event => event.op === 'append' && event.reason === 'promoted')
    expect(appended).toBeDefined()
    expect(events.filter(event => event.op === 'error')).toEqual([])
  })

  it('autoPromote=false 时候选停留在池里,可手动 promote', async () => {
    const router = llmRouter({ observer: () => TEACHER_ANSWER })
    const wiring = createMemoryWiring({
      root,
      llmCall: router.llmCall,
      learning: { autoPromote: false },
    })
    await wiring.onSessionClose({
      ownerId: 'u_manual',
      sessionId: 's-manual-1',
      transcript: TEACHER_TRANSCRIPT,
    })
    await wiring.onSessionClose({
      ownerId: 'u_manual',
      sessionId: 's-manual-2',
      transcript: TEACHER_TRANSCRIPT,
    })
    expect(wiring.candidatePool.list('u_manual')[0]?.state).toBe('tentative')
    expect(wiring.provider.list('u_manual')).toEqual([])

    const promoted = await wiring.promote('u_manual')
    // promote() 返回的是晋升时的候选快照(state 仍为 tentative),生效状态以池为准。
    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.label).toBe('职业：高中语文老师')
    expect(wiring.candidatePool.list('u_manual')[0]?.state).toBe('active')
    expect(
      wiring.provider.list('u_manual').find(document => document.scope === 'user')?.content).toContain('- 职业：高中语文老师')
  })

  it('学习链路抛错不冒泡:audit 记 error,onSessionClose 照常 resolve', async () => {
    const events: MemoryAuditEvent[] = []
    const wiring = createMemoryWiring({
      root,
      llmCall: async () => {
        throw new Error('llm down')
      },
      audit: auditSink(events),
    })
    await expect(wiring.onSessionClose({
      ownerId: 'u_boom',
      sessionId: 's-boom',
      transcript: userTranscript('一', '二', '三', '四'),
    })).resolves.toBeUndefined()
    // 抽取器与观察器各自把异常降级为内部 error 审计(maybeRun 内部 catch)。
    const errors = events.filter(event => event.op === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(2)
    expect(errors.every(event => String(event.error).includes('llm down'))).toBe(true)
  })
})

describe('MarkdownDocumentStore 精确编辑契约(经 provider)', () => {
  it('expectedRevision 过期拒绝,old_text 命中多次拒绝', () => {
    const wiring = createMemoryWiring({ root })
    const ownerId = 'u_edits'
    wiring.provider.apply(ownerId, [{ document: 'memory', append: '- 事实甲\n- 事实乙' }])
    const document = wiring.provider.list(ownerId).find(item => item.scope === 'memory')

    // 陈旧修订:再写一次同 revision 应被拒。
    wiring.provider.apply(ownerId, [{
      document: 'memory',
      append: '- 事实丙',
      expectedRevision: document?.revision,
    }])
    expect(() => wiring.provider.apply(ownerId, [{
      document: 'memory',
      append: '- 迟到写入',
      expectedRevision: document?.revision,
    }])).toThrowError(/changed|再读/)

    // old_text 必须恰好命中一次。
    wiring.provider.apply(ownerId, [{
      document: 'memory',
      append: '重复行\n重复行',
    }])
    expect(() => wiring.provider.apply(ownerId, [{
      document: 'memory',
      edits: [{ old_text: '重复行', new_text: '替换' }],
    }])).toThrowError(/exactly once/)

    // 合法的精确编辑:替换唯一命中的原文。
    wiring.provider.apply(ownerId, [{
      document: 'memory',
      edits: [{ old_text: '事实甲', new_text: '唯一替换' }],
    }])
    const content = wiring.provider.list(ownerId).find(item => item.scope === 'memory')?.content
    expect(content).toContain('唯一替换')
    expect(content).toContain('事实乙')
    expect(content).not.toContain('事实甲')
  })
})
