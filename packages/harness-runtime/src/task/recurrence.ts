// @ts-nocheck — 循环任务的「下一次时刻」求解器(本仓自研实现;「壁钟重复 + DST 正确 +
// 追赶合并」的问题设定参考 qwen-audio-agent,Apache-2.0,致谢;strict 类型化列入 backlog)。
// 设计要点:
// - 一切以【壁钟时刻】(当地墙上的时间)为准:夏令时切换不改变「每天 09:00」的含义;
// - 壁钟→瞬间的换算要处理 DST 的两种病态:本地时刻不存在(春季跳变,前移跨过缺口)
//   与本地时刻出现两次(秋季回拨,取第一次出现);
// - 错过的次数合并成一次追赶:下次执行严格晚于 now,而不是连补 N 次。
// 行为锚:test/recurrence.test.ts(DST 跳变/重复、weekly/weekdays 追赶、时区容错)。

const RECURRENCE_MODES = new Set(['once', 'daily', 'weekly', 'weekdays'])
const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000
// weekdays 的护栏:第一候选至多跨一个周末,再走不到就该报设计缺陷。
const WEEKDAY_ATTEMPT_CAP = 8

// 时区→格式化器的缓存(同进程内同一时区反复求解)。
const ZONE_FORMATTERS = new Map()

export function tidyRecurrence(value) {
  const mode = String(value || '').trim().toLowerCase()
  return RECURRENCE_MODES.has(mode) ? mode : 'once'
}

export function tidyTimeZone(value) {
  const zone = String(value || '').trim()
  if (!zone) return 'UTC'
  try {
    zoneFormatter(zone)
    return zone
  } catch {
    return 'UTC'
  }
}

function zoneFormatter(timeZone) {
  let formatter = ZONE_FORMATTERS.get(timeZone)
  if (!formatter) {
    // en-US + h23:formatToParts 稳定产出 year/month/day/hour/minute/second 数字字段。
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    ZONE_FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

// 瞬间 → 某时区的壁钟分量(全数字)。
function wallParts(instant, timeZone) {
  const parts = Object.create(null)
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

// 壁钟分量按「当作 UTC」解读的伪瞬间:用于壁钟之间的算术与比较。
function asPseudoEpoch(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

// 壁钟日期整体平移 N 天(时分秒/毫秒原样保留)。
function shiftDays(parts, days) {
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    millisecond: parts.millisecond,
  }
}

function weekdayOf(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

// 自纪元日起的壁钟天数差(只比日期,不带时分秒)。
function dayNumber(parts) {
  const probe = new Date(0)
  probe.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  probe.setUTCHours(0, 0, 0, 0)
  return probe.getTime() / MS_PER_DAY
}

// 目标日期附近实际出现过的 UTC 偏移集合(±3 天逐小时探测覆盖所有 DST 边)。
function observedOffsets(target, timeZone) {
  const offsets = new Set()
  for (let delta = -3 * MS_PER_DAY; delta <= 3 * MS_PER_DAY; delta += MS_PER_HOUR) {
    const probe = target + delta
    offsets.add(asPseudoEpoch(wallParts(probe, timeZone)) - probe)
  }
  return [...offsets]
}

/**
 * 壁钟时刻 → 真实瞬间。本地时刻在时区切换附近可能不存在或出现两次:
 * 逐个候选偏移反解,精确命中的取最早;不存在的取「跳变后第一个合法时刻」。
 */
function zonedWallToInstant(parts, timeZone) {
  const wanted = asPseudoEpoch(parts)
  const exact = []
  const later = []
  const earlier = []
  for (const offset of observedOffsets(wanted, timeZone)) {
    const candidate = wanted - offset
    const actualWall = asPseudoEpoch(wallParts(candidate, timeZone))
    if (actualWall === wanted) exact.push(candidate)
    else if (actualWall > wanted) later.push({ candidate, actualWall })
    else earlier.push({ candidate, actualWall })
  }
  if (exact.length) return Math.min(...exact) + parts.millisecond
  if (later.length) {
    later.sort((a, b) => a.actualWall - b.actualWall || a.candidate - b.candidate)
    return later[0].candidate + parts.millisecond
  }
  earlier.sort((a, b) => b.actualWall - a.actualWall || b.candidate - a.candidate)
  return (earlier[0]?.candidate ?? wanted) + parts.millisecond
}

function finite(value) {
  return Number.isFinite(Number(value))
}

/**
 * 求循环日程在 now 之后(严格大于)的下一次发生时刻。
 * once / 非法输入返回 null;错过的发生合并为一次追赶,再排到下一个日历位。
 */
export function nextRunAt(at, recurrence, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const mode = tidyRecurrence(recurrence)
  if (mode === 'once' || !finite(at) || !finite(now)) return null

  const zone = tidyTimeZone(timeZone)
  const startInstant = new Date(Number(at))
  const nowInstant = new Date(Number(now))
  if (!Number.isFinite(startInstant.getTime()) || !Number.isFinite(nowInstant.getTime())) return null

  const startParts = {
    ...wallParts(Number(at), zone),
    millisecond: startInstant.getUTCMilliseconds(),
  }
  const nowParts = wallParts(Number(now), zone)
  const stepDays = mode === 'weekly' ? 7 : 1
  const elapsedDays = dayNumber(nowParts) - dayNumber(startParts)

  let offset
  if (Number(at) > Number(now)) {
    offset = 0
  } else if (mode === 'weekly') {
    offset = Math.max(stepDays, Math.ceil(Math.max(0, elapsedDays) / stepDays) * stepDays)
  } else {
    offset = Math.max(stepDays, elapsedDays)
  }

  // weekdays 的第一候选至多跨一个周末;再走不到说明模式有缺陷,护栏兜底返回 null。
  for (let attempt = 0; attempt < WEEKDAY_ATTEMPT_CAP; attempt += 1) {
    const candidateParts = shiftDays(startParts, offset)
    const isWeekend = weekdayOf(candidateParts) === 0 || weekdayOf(candidateParts) === 6
    if (mode !== 'weekdays' || !isWeekend) {
      const instant = zonedWallToInstant(candidateParts, zone)
      if (instant > Number(now)) return instant
    }
    offset += stepDays
  }
  return null
}
