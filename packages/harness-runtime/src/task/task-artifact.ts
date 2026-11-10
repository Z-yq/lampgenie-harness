// @ts-nocheck — 领域模型与行为语义设计参考 qwen-audio-agent(Apache-2.0,致谢);导出接口、类型与命名为本仓自有;strict 类型化列入 backlog。
const MAX_ARTIFACTS = 32
const MAX_PARTS = 64
const MAX_TEXT_CHARS = 1_000_000
const MAX_RAW_CHARS = 16_000_000
const MAX_DATA_CHARS = 1_000_000
const MAX_TOTAL_PART_CHARS = 16_000_000
const PUBLIC_URL_PROTOCOLS = new Set(['data:', 'http:', 'https:'])

function clip(value, max) {
  return String(value || '').replaceAll('\u0000', '').trim().slice(0, max)
}

function hasField(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function safeMediaType(value, fallback) {
  const normalized = clean(value, 160).toLowerCase()
  return /^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : fallback
}

function jsonValue(value) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > MAX_DATA_CHARS) return null
    return JSON.parse(serialized)
  } catch {
    return null
  }
}

// 单个 part 按其携带字段(text/raw/url/data)归一;不认识或不合法的返回 null。
function conformPart(part) {
  if (!part || typeof part !== 'object') return null
  const filename = clip(part.filename, 240)
  if (hasField(part, 'text')) {
    const body = clip(part.text, MAX_TEXT_CHARS)
    if (!text) return null
    return {
      text,
      mediaType: safeMediaType(part.mediaType || part.mimeType, 'text/plain'),
      ...(filename ? { filename } : {}),
    }
  }
  if (hasField(part, 'raw')) {
    const raw = clip(part.raw, MAX_RAW_CHARS).replace(/\s/g, '')
    if (!raw || !/^[a-z\d+/]*={0,2}$/i.test(raw)) return null
    return {
      raw,
      mediaType: mediaType(
        part.mediaType || part.mimeType,
        'application/octet-stream',
      ),
      ...(filename ? { filename } : {}),
    }
  }
  if (hasField(part, 'url')) {
    const url = clip(part.url, 20_000)
    if (!url) return null
    try {
      if (!PUBLIC_URL_PROTOCOLS.has(new URL(url).protocol)) return null
    } catch {
      return null
    }
    return {
      url,
      mediaType: mediaType(
        part.mediaType || part.mimeType,
        'application/octet-stream',
      ),
      ...(filename ? { filename } : {}),
    }
  }
  if (hasField(part, 'data')) {
    const data = jsonValue(part.data)
    if (data === null && part.data !== null) return null
    return {
      data,
      mediaType: safeMediaType(part.mediaType || part.mimeType, 'application/json'),
      ...(filename ? { filename } : {}),
    }
  }
  return null
}

// 整条 artifact 收敛:parts 归一、id 兜底、可选字段按存在性展开。
function conformArtifact(artifact, index) {
  if (!artifact || typeof artifact !== 'object') return null
  const parts = (Array.isArray(artifact.parts) ? artifact.parts : [])
    .slice(0, MAX_PARTS)
    .map(conformPart)
    .filter(Boolean)
  if (!parts.length) return null
  const artifactId = clip(artifact.artifactId || artifact.id, 160)
    || `artifact_${index + 1}`
  const name = clip(artifact.name, 240)
  const description = clip(artifact.description, 1000)
  return {
    artifactId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    parts,
  }
}

// 预算口径:各形态按字符数计;data 序列化失败按超预算处理。
function partSize(part) {
  if (part.text !== undefined) return part.text.length
  if (part.raw !== undefined) return part.raw.length
  if (part.url !== undefined) return part.url.length
  try {
    return JSON.stringify(part.data).length
  } catch {
    return MAX_TOTAL_PART_CHARS + 1
  }
}

// 归一 + 总量预算(字符数) + 按 artifactId 去重;超预算的 part 逐个丢弃。
export function tidyArtifacts(artifacts) {
  const normalized = (Array.isArray(artifacts) ? artifacts : [])
    .slice(0, MAX_ARTIFACTS)
    .map(conformArtifact)
    .filter(Boolean)
  const seenIds = new Set()
  let budget = MAX_TOTAL_PART_CHARS
  return normalized.flatMap((artifact) => {
    if (seenIds.has(artifact.artifactId)) return []
    seenIds.add(artifact.artifactId)
    const affordable = artifact.parts.filter((part) => {
      const cost = partSize(part)
      if (cost > budget) return false
      budget -= cost
      return true
    })
    return affordable.length ? [{ ...artifact, parts: affordable }] : []
  })
}

// 两批 artifacts 合并(后者覆盖同 id);合并后再过一遍归一与预算。
export function unionArtifacts(current, incoming) {
  const byId = new Map()
  for (const artifact of tidyArtifacts(current)) byId.set(artifact.artifactId, artifact)
  for (const artifact of tidyArtifacts(incoming)) byId.set(artifact.artifactId, artifact)
  return tidyArtifacts([...byId.values()])
}

// 从任务结果对象里找 artifacts(顶层或 metadata 兜底)。
export function artifactsOfOutcome(outcome) {
  return tidyArtifacts(outcome?.artifacts || outcome?.metadata?.artifacts)
}
