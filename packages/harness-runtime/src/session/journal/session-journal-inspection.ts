// @ts-nocheck — 日志目录的只读体检(本仓自研;同类「限额体检不修复」的边界参考
// qwen-audio-agent,Apache-2.0,致谢;strict 类型化列入 backlog)。
// 有界只读:绝不修复、绝不打开/创建日志本体。
import { readFile, stat } from 'node:fs/promises'
import { SessionLogRegistry } from './session-journal-registry'
import { parseSessionLog } from './session-journal-format'

export async function inspectSessionLogs(directory, {
  maxBytes = 64 * 1024 * 1024,
  maxFileBytes = 8 * 1024 * 1024,
  maxFiles = 1_000,
} = {}) {
  const tally = {
    files: 0, bytes: 0, checked: 0, damaged: 0,
    tornTails: 0, skipped: 0, unreadable: 0, partial: false,
  }
  let spentBytes = 0
  const scanner = new SessionLogRegistry({ directory })
  const paths = scanner.paths(directory, () => { tally.unreadable += 1 })

  for (const path of paths) {
    if (tally.files >= maxFiles) {
      tally.partial = true // 文件数超体检上限:结果标「不全」,不静默截断
      break
    }
    tally.files += 1
    try {
      const info = await stat(path)
      tally.bytes += info.size
      const overBudget = info.size > maxFileBytes || spentBytes + info.size > maxBytes
      if (overBudget) { tally.skipped += 1; continue }
      spentBytes += info.size
      const decoded = parseSessionLog(await readFile(path))
      tally.checked += 1
      if (decoded.discardedBytes) tally.tornTails += 1
    } catch {
      tally.damaged += 1
    }
  }
  return tally
}
