import type { Day, Vehicle } from '../types'

/** 'HH:mm' → 当天分钟数；格式不对返回 null */
export function parseClock(s: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 当天分钟数 → 'HH:mm'，跨过午夜加「次日」/「第 N 日」前缀 */
export function fmtClock(totalMin: number): string {
  const t = Math.round(totalMin)
  const dayOffset = Math.floor(t / 1440)
  const inDay = ((t % 1440) + 1440) % 1440
  const hh = String(Math.floor(inDay / 60)).padStart(2, '0')
  const mm = String(inDay % 60).padStart(2, '0')
  const prefix = dayOffset === 0 ? '' : dayOffset === 1 ? '次日 ' : `+${dayOffset}天 `
  return `${prefix}${hh}:${mm}`
}

/** 停留时长（分钟）→ 「不停留 / 30分钟 / 2小时 / 1.5小时」 */
export function fmtStay(min: number): string {
  if (!min) return '不停留'
  if (min < 60) return `${min}分钟`
  const h = min / 60
  return Number.isInteger(h) ? `${h}小时` : `${Math.floor(h)}小时${min % 60}分`
}

export interface DaySchedule {
  /** 当天出发时刻（分钟） */
  departMin: number
  /** 每个节点的预计到达时刻（分钟）；首节点为 null（出发点），车程未知时为 null */
  arrive: (number | null)[]
  /** 车程是否全部已知（车行时长已按当前节点序列算出） */
  durationsKnown: boolean
  /** 当天驾驶总时长（秒），未知为 null */
  driveS: number | null
  /** 当天车行总距离（米），未知为 null */
  distanceM: number | null
  /** 中途停留合计（分钟，不含首站和末站） */
  stayMin: number
  /** 预计到达最后一个节点的时刻（分钟），未知为 null */
  endMin: number | null
  /** 当天过路费合计（元）；数据源不提供或未知时为 null */
  tollsYuan: number | null
}

/**
 * 推算一天的时间表：出发时间 + 逐段车程 + 中途停留 → 每个节点的到达时刻。
 * 首节点的停留不计（以出发时间为准）；末节点通常是住宿，其停留也不影响到达时刻。
 * legs 数组长度须等于节点数 - 1，否则视为过期数据（节点刚变化、线路还在重算）。
 */
export function daySchedule(
  day: Day,
  legDistances?: number[],
  legDurations?: number[],
  legTolls?: (number | null)[],
): DaySchedule {
  const n = day.stops.length
  const departMin = parseClock(day.departTime) ?? 8 * 60
  const expected = Math.max(0, n - 1)
  const durationsKnown = n >= 2 && !!legDurations && legDurations.length === expected
  const distKnown = n >= 2 && !!legDistances && legDistances.length === expected

  const arrive: (number | null)[] = day.stops.map(() => null)
  let stayMin = 0
  let clock = departMin
  for (let j = 1; j < n; j++) {
    if (durationsKnown) {
      clock += (legDurations![j - 1] || 0) / 60
      arrive[j] = clock
    }
    if (j < n - 1) {
      const stay = day.stops[j].stayMinutes || 0
      stayMin += stay
      clock += stay
    }
  }

  const driveS = durationsKnown ? legDurations!.reduce((a, b) => a + (b || 0), 0) : n < 2 ? 0 : null
  const distanceM = distKnown ? legDistances!.reduce((a, b) => a + (b || 0), 0) : n < 2 ? 0 : null

  let tollsYuan: number | null = null
  if (n < 2) tollsYuan = 0
  else if (legTolls && legTolls.length === expected && legTolls.every((t) => t != null)) {
    tollsYuan = (legTolls as number[]).reduce((a, b) => a + b, 0)
  }

  return {
    departMin,
    arrive,
    durationsKnown,
    driveS,
    distanceM,
    stayMin,
    endMin: n >= 2 && durationsKnown ? arrive[n - 1] : null,
    tollsYuan,
  }
}

/** 按里程估算能耗费用（元） */
export function energyCost(distanceM: number, v: Vehicle): number {
  return (distanceM / 1000) * (v.consumption / 100) * v.price
}

/** 金额显示：整数元，带千分位 */
export function fmtYuan(y: number): string {
  return `¥${Math.round(y).toLocaleString('zh-CN')}`
}
