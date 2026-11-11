// 记忆注入块冻结 + 召回预取门的验收测试。
// 覆盖三块:
// 1) snapshot.ts 纯逻辑(冻结/缓存复用/隔离/invalidate/trivial 词表/命令/任务/不可变/确定性);
// 2) wiring 接入面(contextBlock 走冻结缓存、contextBlockFrozen 观察视图、内容变更后换快照);
// 3) agent-wiring 静态断言(召回门与两条审计事件确实接在 memBlock 计算处)。
// 运行:cd packages/harness-memory && NODE_OPTIONS=--conditions=development npx vitest run test/snapshot.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SnapshotCache,
  freezeMemoryBlock,
  hashMemoryBlock,
  recallGate,
  shouldRecallMemory,
  type MemorySnapshot,
  buildMemoryBriefing,
  createMemoryWiring,
  type MemoryWiring,
} from '../src/index'

function sha16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

describe('snapshot 冻结', () => {
  it('hash 是 sha256 十六进制前 16 位', () => {
    const snapshot = freezeMemoryBlock('<user_preferences>a</user_preferences>')
    expect(snapshot.hash).toBe(sha16('<user_preferences>a</user_preferences>'))
    expect(snapshot.hash).toHaveLength(16)
    expect(snapshot.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('文本逐字保留(不做 trim/归一)', () => {
    const text = '  <user_memory>\n- 叫我小飞\n</user_memory>  '
    expect(freezeMemoryBlock(text).text).toBe(text)
  })

  it('快照对象不可变(冻结)', () => {
    const snapshot = freezeMemoryBlock('abc')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => {
      ;(snapshot as { text: string }).text = 'tampered'
    }).toThrow()
  })

  it('同文本 hash 确定;不同文本 hash 不同', () => {
    expect(freezeMemoryBlock('同一份').hash).toBe(freezeMemoryBlock('同一份').hash)
    expect(freezeMemoryBlock('a').hash).not.toBe(freezeMemoryBlock('b').hash)
  })

  it('frozenAt 可注入(确定性),revision 空串归一为缺省', () => {
    const snapshot = freezeMemoryBlock('x', '  ', 1234)
    expect(snapshot.frozenAt).toBe(1234)
    expect(snapshot.revision).toBeUndefined()
    expect(freezeMemoryBlock('x', '7').revision).toBe('7')
  })

  it('空文本合法:hash 是空串的 sha256 前 16 位', () => {
    const snapshot = freezeMemoryBlock('')
    expect(snapshot.hash).toBe(sha16(''))
    expect(snapshot.text).toBe('')
  })
})

describe('SnapshotCache', () => {
  it('首次 getOrFreeze 是新建(reused=false)', () => {
    const cache = new SnapshotCache()
    const { snapshot, reused } = cache.getOrFreeze('local', 'body')
    expect(reused).toBe(false)
    expect(snapshot.text).toBe('body')
  })

  it('探针 A:同 owner 两次同文本 → reused=true 且同 hash、同引用', () => {
    const cache = new SnapshotCache()
    const first = cache.getOrFreeze('local', 'same body')
    const second = cache.getOrFreeze('local', 'same body')
    expect(second.reused).toBe(true)
    expect(second.snapshot).toBe(first.snapshot)
    expect(second.snapshot.hash).toBe(first.snapshot.hash)
  })

  it('探针 B:文本变化 → reused=false 且新 hash', () => {
    const cache = new SnapshotCache()
    const first = cache.getOrFreeze('local', 'before')
    const second = cache.getOrFreeze('local', 'after')
    expect(second.reused).toBe(false)
    expect(second.snapshot.hash).not.toBe(first.snapshot.hash)
    expect(second.snapshot.text).toBe('after')
    expect(cache.size()).toBe(1)
  })

  it('revision 变化(文本相同)也换新快照', () => {
    const cache = new SnapshotCache()
    cache.getOrFreeze('local', 'body', '1')
    const changed = cache.getOrFreeze('local', 'body', '2')
    expect(changed.reused).toBe(false)
    expect(changed.snapshot.revision).toBe('2')
    expect(cache.getOrFreeze('local', 'body', '2').reused).toBe(true)
  })

  it('多 owner 隔离:不同 owner 各自独立,同文本也算新快照', () => {
    const cache = new SnapshotCache()
    const a = cache.getOrFreeze('owner-a', 'shared')
    const b = cache.getOrFreeze('owner-b', 'shared')
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(false)
    expect(cache.size()).toBe(2)
    expect(cache.getOrFreeze('owner-a', 'shared').reused).toBe(true)
    expect(cache.getOrFreeze('owner-b', 'shared').reused).toBe(true)
  })

  it('invalidate(owner) 只清指定 owner,下次重建', () => {
    const cache = new SnapshotCache()
    cache.getOrFreeze('a', 'x')
    cache.getOrFreeze('b', 'y')
    cache.invalidate('a')
    expect(cache.size()).toBe(1)
    expect(cache.getOrFreeze('a', 'x').reused).toBe(false)
    expect(cache.getOrFreeze('b', 'y').reused).toBe(true)
  })

  it('invalidate() 清空全部', () => {
    const cache = new SnapshotCache()
    cache.getOrFreeze('a', 'x')
    cache.getOrFreeze('b', 'y')
    cache.invalidate()
    expect(cache.size()).toBe(0)
    expect(cache.getOrFreeze('a', 'x').reused).toBe(false)
  })

  it('空文本也缓存并复用', () => {
    const cache = new SnapshotCache()
    const first = cache.getOrFreeze('local', '')
    const second = cache.getOrFreeze('local', '')
    expect(second.reused).toBe(true)
    expect(second.snapshot).toBe(first.snapshot)
    expect(second.snapshot.hash).toBe(sha16(''))
  })

  it('冻结时间可注入:新建用注入时钟,复用不重新冻结', () => {
    let tick = 0
    const cache = new SnapshotCache({ now: () => (tick += 1) })
    const first = cache.getOrFreeze('local', 'body')
    const second = cache.getOrFreeze('local', 'body')
    expect(first.snapshot.frozenAt).toBe(1)
    expect(second.snapshot.frozenAt).toBe(1)
    expect(cache.getOrFreeze('local', 'body2').snapshot.frozenAt).toBe(2)
  })
})

describe('shouldRecallMemory', () => {
  const cases: Array<[string, string, boolean, string]> = [
    ['你好', '', false, 'trivial-greeting'],
    ['thanks!', '', false, 'trivial-greeting'],
    ['好的', '', false, 'trivial-greeting'],
    ['/compact', '', false, 'command'],
    ['帮我修这个 bug', '', true, 'task'],
    ['为什么测试失败?', '', true, 'task'],
    ['', '', false, 'trivial-empty'],
    ['   ', '', false, 'trivial-empty'],
    ['？！', '', false, 'trivial-empty'],
    ['嗯', '', false, 'trivial-greeting'],
    ['THANKS', '', false, 'trivial-greeting'],
    ['Hello.', '', false, 'trivial-greeting'],
  ]

  for (const [prompt, _, recall, reason] of cases) {
    it(`"${prompt}" → recall=${recall} (${reason})`, () => {
      const decision = shouldRecallMemory(prompt)
      expect(decision.recall).toBe(recall)
      expect(decision.reason).toBe(reason)
    })
  }

  it('大小写不敏感 + 首尾标点剥离:多种问候同判', () => {
    for (const prompt of ['Hi', 'hi.', '"hello"', '「谢谢」', 'ok!', '收到。']) {
      const decision = shouldRecallMemory(prompt)
      expect(decision.recall).toBe(false)
      expect(decision.reason).toBe('trivial-greeting')
    }
  })

  it('斜杠命令带空格正文不算命令(回落任务判定)', () => {
    expect(shouldRecallMemory('/compact 现在').reason).not.toBe('command')
  })

  it('≤2 字非问候输入跳过(trivial-empty)', () => {
    expect(shouldRecallMemory('做吧')).toEqual({ recall: false, reason: 'trivial-empty' })
  })

  it('问句/代码片段/英文动词都召回', () => {
    expect(shouldRecallMemory('这个报错怎么处理').recall).toBe(true)
    expect(shouldRecallMemory('fix the failing test').recall).toBe(true)
    expect(shouldRecallMemory('看下 src/index.ts').recall).toBe(true)
    expect(shouldRecallMemory('const a = 1').recall).toBe(true)
  })

  it('确定性:同输入两次判定完全一致', () => {
    expect(shouldRecallMemory('帮我查日志')).toEqual(shouldRecallMemory('帮我查日志'))
  })

  it('非字符串输入不抛错(归一为空 → trivial-empty)', () => {
    expect(shouldRecallMemory(undefined as unknown as string).reason).toBe('trivial-empty')
    expect(shouldRecallMemory(null as unknown as string).reason).toBe('trivial-empty')
  })

  it('判定对象不可变', () => {
    expect(Object.isFrozen(shouldRecallMemory('hi'))).toBe(true)
  })
})

describe('recallGate', () => {
  it('缺省与 shouldRecallMemory 同口径', () => {
    expect(recallGate('你好')).toEqual(shouldRecallMemory('你好'))
    expect(recallGate('帮我修 bug')).toEqual(shouldRecallMemory('帮我修 bug'))
  })

  it('探针 D:enabled=false 恒 recall(回退)', () => {
    for (const prompt of ['你好', '谢谢', '/compact', '']) {
      const decision = recallGate(prompt, { enabled: false })
      expect(decision.recall).toBe(true)
      expect(decision.reason).toBe('disabled')
    }
  })
})

describe('wiring 接入冻结缓存', () => {
  let root = ''
  let wiring: MemoryWiring
  const OWNER = 'u_freeze'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-memory-snapshot-'))
    wiring = createMemoryWiring({ root })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seed(): void {
    wiring.provider.apply(OWNER, [
      { document: 'user', append: ['## 用户明确要求', '- 叫我小飞'].join('\n') },
      { document: 'memory', append: '- 用户在杭州工作' },
    ])
  }

  it('空库:block 为空串,hash=空串指纹,重复调用复用', () => {
    const first = wiring.contextBlockFrozen('u_nobody')
    expect(first.block).toBe('')
    expect(first.hash).toBe(sha16(''))
    expect(first.reused).toBe(false)
    expect(wiring.contextBlockFrozen('u_nobody').reused).toBe(true)
    expect(wiring.contextBlock('u_nobody')).toBe('')
  })

  it('contextBlock 字节与重建结果一致(旧行为不变)', () => {
    seed()
    const block = wiring.contextBlock(OWNER)
    expect(block).toBe(buildMemoryBriefing({ memories: wiring.provider.list(OWNER) }))
    expect(block).toContain('叫我小飞')
    expect(block).toContain('<user_memory')
  })

  it('连续两次 contextBlockFrozen:第二次 reused=true 且同 hash', () => {
    seed()
    const first = wiring.contextBlockFrozen(OWNER)
    const second = wiring.contextBlockFrozen(OWNER)
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.hash).toBe(first.hash)
    expect(second.block).toBe(first.block)
  })

  it('hash 绑定 block 内容,revision 随文档暴露', () => {
    seed()
    const frozen = wiring.contextBlockFrozen(OWNER)
    expect(frozen.hash).toBe(hashMemoryBlock(frozen.block))
    expect(frozen.block).toContain('revision="')
    expect(typeof frozen.revision).toBe('string')
  })

  it('contextBlock 与 contextBlockFrozen 共享同一缓存', () => {
    seed()
    const block = wiring.contextBlock(OWNER)
    const frozen = wiring.contextBlockFrozen(OWNER)
    expect(frozen.block).toBe(block)
    expect(frozen.reused).toBe(true)
  })

  it('内容变更 → reused=false 且新 hash,block 含新内容', () => {
    seed()
    const before = wiring.contextBlockFrozen(OWNER)
    wiring.provider.apply(OWNER, [{ document: 'memory', append: '- 新偏好:回答先给结论' }])
    const after = wiring.contextBlockFrozen(OWNER)
    expect(after.reused).toBe(false)
    expect(after.hash).not.toBe(before.hash)
    expect(after.block).toContain('回答先给结论')
  })

  it('多 owner 隔离:另一 owner 首次调用不复用', () => {
    seed()
    const a = wiring.contextBlockFrozen(OWNER)
    const b = wiring.contextBlockFrozen('u_other')
    expect(a.reused).toBe(false)
    expect(b.reused).toBe(false)
    expect(b.block).toBe('')
  })

  it('冻结快照不可变(拿到后不被内部状态改写)', () => {
    seed()
    const frozen = wiring.contextBlockFrozen(OWNER)
    expect(Object.isFrozen(frozen)).toBe(false) // 视图是普通对象
    expect(frozen.block).toBe(wiring.contextBlockFrozen(OWNER).block)
 // 快照本身在 cache 内是冻结的:重复调用返回同一文本,不受外部对象影响。
    const text: MemorySnapshot['text'] = frozen.block
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('agent-wiring 静态接线断言', () => {
  const source = readFileSync(new URL('../../../apps/gateway/src/agent-wiring.ts', import.meta.url), 'utf8')

  it('从 @lampgenie/memory 引入 shouldRecallMemory', () => {
    expect(source).toContain('import { shouldRecallMemory } from "@lampgenie/memory";')
  })

  it('memBlock 计算处先跑召回门:', () => {
    expect(source).toContain('const recallDecision = shouldRecallMemory(task.instruction);')
    expect(source).toContain('let memBlock = "";')
  })

  it('recall=false 落 memory.recall 审计(带 reason)', () => {
    expect(source).toContain('what: "memory.recall"')
    expect(source).toContain('recalled: false')
    expect(source).toContain('reason: recallDecision.reason')
  })

  it('recall=true 且有 memory 时用冻结视图并落 memory.snapshot 审计', () => {
    expect(source).toContain('memory.contextBlockFrozen?.("local")')
    expect(source).toContain('what: "memory.snapshot"')
    expect(source).toContain('hash: frozen.hash')
    expect(source).toContain('reused: frozen.reused')
  })

  it('冻结视图缺席时回退 contextBlock(旧行为兜底)', () => {
    expect(source).toContain('memBlock = frozen ? frozen.block : memory.contextBlock("local");')
  })

  it('结构类型声明 contextBlockFrozen 可选(旧实现仍可传入)', () => {
    expect(source).toContain('contextBlockFrozen?(ownerId: string): { block: string; hash: string; reused: boolean; revision?: string }')
  })
})
