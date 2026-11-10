// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import {
  SCOPE_ALL,
  MEMORY_DOC_KINDS,
  scopeKey,
} from '../../scopes'
import {
  MEMORY_PROVIDER_API_VERSION,
} from '../../provider'

function normalizeScope(value, fallback = SCOPE_ALL) {
  const scope = scopeKey(String(value || fallback))
  if (scope !== SCOPE_ALL && !MEMORY_DOC_KINDS.includes(scope)) {
    throw new Error(`unsupported memory scope: ${scope}`)
  }
  return scope
}

export class MarkdownMemoryStore {
  constructor({ userStore = null, memoryStore = null } = {}) {
    this.stores = { user: userStore, memory: memoryStore }
  }

  describe() {
    return {
      protocolVersion: MEMORY_PROVIDER_API_VERSION,
      key: 'markdown',
      label: 'Local Markdown memory',
      capabilities: {
        semanticQuery: false,
        sessionObservation: false,
      },
    }
  }

  list(ownerId, { scope = null } = {}) {
    const wanted = normalizeScope(scope)
    const targets = wanted === SCOPE_ALL ? MEMORY_DOC_KINDS : [wanted]
    return targets.flatMap(name => this.stores[name]?.list(ownerId) || [])
  }

  // apply 两阶段:先对全部 change 做预演(prepareEdit 校验+算结果),全过再统一
  // 落盘——任何一条不合法都不会留下半截写入。
  apply(ownerId, changes = []) {
    if (!Array.isArray(changes) || !changes.length) {
      throw new Error('at least one memory change is required')
    }
    const seen = new Set()
    const staged = changes.map((change) => {
      const document = normalizeScope(change?.document)
      if (document === SCOPE_ALL) throw new Error('each change requires a concrete document')
      if (seen.has(document)) throw new Error(`duplicate memory document: ${document}`)
      seen.add(document)
      const store = this.stores[document]
      if (!store) throw new Error(`${document} memory document is unavailable`)
      return {
        document,
        store,
        result: store.prepareEdit(ownerId, {
          edits: change.edits,
          append: change.append,
          expectedRevision: change.expectedRevision,
        }),
      }
    })
    for (const item of staged) {
      if (item.result.changed) item.store.persist(ownerId, `${item.result.content}\n`)
    }
    return {
      changed: staged.reduce((sum, item) => sum + item.result.changed, 0),
      documents: staged.map(item => item.result.document),
    }
  }

  health() {
    return {
      ok: MEMORY_DOC_KINDS.every(scope => this.stores[scope]?.health().ok !== false),
      documents: Object.fromEntries(MEMORY_DOC_KINDS.map(scope => [
        scope,
        this.stores[scope]?.health() || {
          ok: true,
          configured: false,
          warning: null,
        },
      ])),
    }
  }
}
