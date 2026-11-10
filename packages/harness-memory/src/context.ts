// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
import { scopeKey, isPolicyScope } from './scopes'

// These existing document notices carry context semantics, not template facts.
// Preserve their exact legacy wording without adding rules to the system prompt.
const OBSERVED_NOTICE = '<!-- 以下为系统观察推断，权威低于上方用户明确要求；如与其冲突，以上方为准 -->'
const TRUNCATED_NOTICE = '<!-- 内容过长，已截断；精确编辑前请缩小文档 -->'

function squeeze(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function renderVisible(document) {
  const content = String(document?.content || '').trim()
  if (document?.format === 'text') return content

  // 截断可能停在未闭合的模板注释里:先摘下追加的截断声明,
  // 这样清理模板注释时不会把它一并吞掉。
  const truncated = content.endsWith(TRUNCATED_NOTICE)
  const body = truncated ? content.slice(0, -TRUNCATED_NOTICE.length) : content
  // Markdown 模板注释是编辑指引,不是用户事实;原文/修订号保持不动供 API 与精确编辑使用。
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => (
    comment === OBSERVED_NOTICE ? comment : ''
  )).trim()
  return [visible, truncated ? TRUNCATED_NOTICE : ''].filter(Boolean).join('\n\n')
}

// 两个注入段:匹配器找文档,标签是提示词里的 XML 包裹(契约,别改措辞)。
const BRIEFING_SECTIONS = [
  {
    tag: 'user_preferences',
    find: memories => memories.find(memory => isPolicyScope(squeeze(memory.scope))),
  },
  {
    tag: 'user_memory',
    find: memories => memories.find(memory => scopeKey(squeeze(memory.scope)) === 'memory'),
  },
]

function sectionXml(tag, document) {
  const content = renderVisible(document)
  if (!content) return ''
  const revision = squeeze(document.revision)
  const opening = revision ? `<${tag} revision="${revision}">` : `<${tag}>`
  return [opening, content, `</${tag}>`].join('\n')
}

export function buildMemoryBriefing({ memories = [] } = {}) {
  return BRIEFING_SECTIONS
    .map(({ tag, find }) => sectionXml(tag, find(memories)))
    .filter(Boolean)
    .join('\n\n')
}
