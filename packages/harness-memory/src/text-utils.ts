/**
 * 共享清洗工具(harness-memory 内部; code_index 扫雷:三份 firstJsonObject/
 * 五份 clean 逐字重复收敛于此。放独立文件防循环依赖——wiring 是最上游,观察器/抽取器
 * 反向 import 它会翻转加载顺序)。
 */
export function firstJsonObject(value: unknown): string {
  const text = String(value ?? '')
  const start = text.indexOf('{')
  if (start < 0) return text
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text.charAt(index)
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) {
      return text.slice(start, index + 1)
    }
  }
  return text.slice(start)
}

/** 空白归一+按码点截断(maxChars;emoji 安全)。 */
export function clean(value: unknown, maxChars: number): string {
  return [...String(value || '').replace(/\s+/g, ' ').trim()].slice(0, maxChars).join('')
}
