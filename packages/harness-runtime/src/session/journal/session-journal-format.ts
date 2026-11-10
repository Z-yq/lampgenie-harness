// @ts-nocheck — 会话日志行帧解析(本仓自有实现)。回放与追加恢复共用同一个解码器;
// 只有未提交的坏尾行才允许被丢弃——坏头、坏序号、已提交记录绝不能触发破坏性「恢复」。
import { validateSessionLog } from '../../shared/session-events'

export function parseSessionLog(value, options = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const records = []
  let validBytes = bytes.length
  let lineNumber = 0
  let cursor = 0

  while (cursor < bytes.length) {
    const newlineAt = bytes.indexOf(10, cursor)
    const lineEnd = newlineAt === -1 ? bytes.length : newlineAt
    const text = bytes.subarray(cursor, lineEnd).toString('utf8').trim()
    lineNumber += 1
    if (text) {
      try {
        records.push(JSON.parse(text))
      } catch (error) {
        // 中段坏行 = 文件本身损坏,如实抛错;
        // 末行坏 JSON 且无换行 = 进程写一半被杀,截断即可。
        if (newlineAt !== -1) throw new TypeError(`invalid JSON at line ${lineNumber}`, { cause: error })
        validBytes = cursor
        break
      }
    }
    cursor = lineEnd + 1
  }

  // 先校验再交给调用方修复:header/seq/已提交记录的问题不允许被静默截断。
  const validated = validateSessionLog(records, options)
  return {
    ...validated,
    records,
    validBytes,
    discardedBytes: bytes.length - validBytes,
    needsNewline: validBytes > 0 && bytes[validBytes - 1] !== 10,
  }
}
