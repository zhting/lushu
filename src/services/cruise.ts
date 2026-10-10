import type { Stop, Trip } from '../types'
import { cityOfAddress, haversineKm } from './geo'

export interface CruisePoint {
  lng: number
  lat: number
  dist: number // 距起点累积距离（米）
}

export interface CruiseMilestone {
  stop: Stop
  dayIndex: number
  dayId: string
  stopIndex: number
  city: string
  name: string
  milestoneDist: number // 沿路线累积距离（米）
  dayOrder: number // 在本次巡游范围内属于第几段（用于按天限定匹配范围）
}

export interface CruiseTrack {
  points: CruisePoint[]
  totalDistance: number // 总里程（米）
  milestones: CruiseMilestone[]
  targetLabel: string
}

export interface CruiseState {
  lng: number
  lat: number
  heading: number // 车辆朝向角（0~360度，0为正北）
  progress: number // 0~1
  currentDist: number
  totalDist: number
  city: string // 当前经过的城市
  place: string // 当前经过/前往的地点
  statusText: string // 巡游状态短语
  isNearStop: boolean
  passedIdx: number // 已完整驶过的最后一个轨迹点下标（地图层据此增量点亮已走路线）
}

/** 计算两经纬度点之间的球面距离（米） */
export function haversineM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  return haversineKm(a, b) * 1000
}

/** 智能提取地点所属城市（支持地址、行政区或地名中的城市关键词） */
export function extractCity(stop: Stop): string {
  if (stop.address) {
    const c = cityOfAddress(stop.address)
    if (c) return c
    const m = stop.address.match(/(?:^|[省区])([\u4e00-\u9fa5]{2,4}(?:市|州|盟|地区))/)?.[1]
    if (m) return m
  }
  if (stop.name) {
    const m = stop.name.match(/^([\u4e00-\u9fa5]{2,4}(?:市|州|盟))/)?.[1]
    if (m) return m
  }
  return ''
}

/**
 * 构建用于巡游播放的连续轨迹
 * 支持单天或全路书总览（自动拼接高精度导航折线或直线回退）
 */
export function buildCruiseTrack(
  trip: Trip,
  targetRange: string, // 'all' 或 dayId
  legPaths: Record<string, [number, number][]>,
  routePointsOf: (dayId: string) => Stop[],
): CruiseTrack | null {
  const daysToInclude =
    targetRange === 'all'
      ? trip.days
      : trip.days.filter((d) => d.id === targetRange)

  if (!daysToInclude.length) return null

  const rawPath: [number, number][] = []
  const milestones: CruiseMilestone[] = []
  const dayBreaks: number[] = [] // 每一天在 rawPath 中的起始下标（与 milestone.dayOrder 对应）

  let rangeLabel = targetRange === 'all' ? '全程自驾' : ''

  daysToInclude.forEach((day) => {
    const dayIdx = trip.days.indexOf(day)
    if (targetRange !== 'all') {
      rangeLabel = `第${dayIdx + 1}天`
    }
    const stops = routePointsOf(day.id)
    if (!stops.length) return

    // 获取当天车行导航折线
    const drivePath = legPaths[day.id]
    const dayCoords: [number, number][] =
      drivePath && drivePath.length > 1
        ? drivePath
        : stops.map((s) => [s.lng, s.lat])

    if (!dayCoords.length) return

    const dayOrder = dayBreaks.length
    dayBreaks.push(rawPath.length)
    rawPath.push(...dayCoords)

    // 记录站点里程碑信息
    stops.forEach((s, sIdx) => {
      // 避免第一天终点与第二天接续起点在里程碑中重复显示
      if (s.fromPrev && sIdx === 0 && milestones.length > 0) {
        const lastM = milestones[milestones.length - 1]
        if (Math.abs(lastM.stop.lng - s.lng) < 5e-4 && Math.abs(lastM.stop.lat - s.lat) < 5e-4) {
          return
        }
      }

      milestones.push({
        stop: s,
        dayIndex: dayIdx,
        dayId: day.id,
        stopIndex: sIdx + 1,
        city: extractCity(s),
        name: s.name,
        milestoneDist: 0, // 下面根据轨迹匹配
        dayOrder,
      })
    })
  })

  if (rawPath.length < 2) return null

  // 折线抽稀（Douglas-Peucker，容差 4 米）：保持道路形状，同时把每帧绘制的点数降下来。
  // 每天的起点强制保留，便于下面按天限定站点匹配范围。
  const forced = new Set<number>(dayBreaks)
  for (const b of dayBreaks) if (b > 0) forced.add(b - 1)
  const kept = simplifyIndices(rawPath, SIMPLIFY_TOLERANCE_M, forced)

  // 坐标去重（< 1 米的连续抖动点），并记录每个保留点来自 rawPath 的哪个下标
  const points: CruisePoint[] = []
  const srcIdx: number[] = []
  let accDist = 0
  for (const ri of kept) {
    const [lng, lat] = rawPath[ri]
    if (points.length) {
      const prev = points[points.length - 1]
      const seg = haversineM(prev, { lng, lat })
      if (seg < 1) continue
      accDist += seg
    }
    points.push({ lng, lat, dist: accDist })
    srcIdx.push(ri)
  }

  if (points.length < 2) return null
  const totalDistance = accDist
  if (totalDistance <= 0) return null

  // 每天在 points 中的下标范围 [start, end]（相邻两天共享接续点）
  const dayStart = dayBreaks.map((b) => {
    const i = srcIdx.findIndex((ri) => ri >= b)
    return i < 0 ? points.length - 1 : Math.max(0, i - 1)
  })
  const dayEnd = dayStart.map((_, d) => (d + 1 < dayStart.length ? dayStart[d + 1] + 1 : points.length - 1))

  // 按站点原有顺序沿轨迹向前匹配：每个站点只在本天范围内、上一站之后查找，
  // 并取「误差不超过最小误差 + 30 米」的最早一点——环线、折返、原路返回都不会吸附到错误位置。
  let cursor = 0
  for (const m of milestones) {
    const from = Math.max(cursor, dayStart[m.dayOrder] ?? 0)
    const to = Math.min(points.length - 1, Math.max(from, dayEnd[m.dayOrder] ?? points.length - 1))
    const target = { lng: m.stop.lng, lat: m.stop.lat }
    const errs: number[] = []
    let minErr = Infinity
    for (let i = from; i <= to; i++) {
      const e = haversineM(target, points[i])
      errs.push(e)
      if (e < minErr) minErr = e
    }
    let best = from
    for (let k = 0; k < errs.length; k++) {
      if (errs[k] <= minErr + 30) {
        best = from + k
        break
      }
    }
    m.milestoneDist = points[best].dist
    cursor = best
  }

  return {
    points,
    totalDistance,
    milestones,
    targetLabel: rangeLabel || '自驾路线',
  }
}

const SIMPLIFY_TOLERANCE_M = 4
const DEG = Math.PI / 180
const EARTH_R = 6371000

/** 点 p 到线段 ab 的距离（米，以 a 为原点做局部平面近似） */
function segDistM(p: [number, number], a: [number, number], b: [number, number]): number {
  const k = Math.cos(a[1] * DEG) * DEG * EARTH_R
  const ky = DEG * EARTH_R
  const bx = (b[0] - a[0]) * k
  const by = (b[1] - a[1]) * ky
  const px = (p[0] - a[0]) * k
  const py = (p[1] - a[1]) * ky
  const len2 = bx * bx + by * by
  let t = len2 > 0 ? (px * bx + py * by) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const dx = px - bx * t
  const dy = py - by * t
  return Math.sqrt(dx * dx + dy * dy)
}

/** Douglas-Peucker 抽稀（迭代实现，避免长折线递归爆栈），返回保留的下标（升序） */
function simplifyIndices(coords: [number, number][], tol: number, forced: Set<number>): number[] {
  const n = coords.length
  if (n <= 2) return coords.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  for (const f of forced) if (f >= 0 && f < n) keep[f] = 1

  // 以强制保留点切分，各段分别抽稀
  const anchors: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i)

  const stack: Array<[number, number]> = []
  for (let a = 0; a + 1 < anchors.length; a++) stack.push([anchors[a], anchors[a + 1]])
  while (stack.length) {
    const [s, e] = stack.pop()!
    if (e - s < 2) continue
    let maxD = -1
    let maxI = -1
    for (let i = s + 1; i < e; i++) {
      const d = segDistM(coords[i], coords[s], coords[e])
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > tol) {
      keep[maxI] = 1
      stack.push([s, maxI], [maxI, e])
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/** 根据当前累积距离采样车辆位置、朝向角、经过城市地点及行车状态 */
export function sampleCruiseTrack(track: CruiseTrack, currentDist: number): CruiseState {
  const { points, totalDistance, milestones } = track
  const dist = Math.max(0, Math.min(totalDistance, currentDist))
  const progress = totalDistance > 0 ? dist / totalDistance : 0

  // 二分查找所在线段
  let low = 0
  let high = points.length - 1
  let idx = 0

  while (low <= high) {
    const mid = (low + high) >> 1
    if (points[mid].dist <= dist) {
      idx = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const p0 = points[idx]
  const p1 = points[Math.min(points.length - 1, idx + 1)]

  let currentLng = p0.lng
  let currentLat = p0.lat

  const segLen = p1.dist - p0.dist
  let t = 0
  if (segLen > 0) {
    t = Math.max(0, Math.min(1, (dist - p0.dist) / segLen))
    currentLng = p0.lng + (p1.lng - p0.lng) * t
    currentLat = p0.lat + (p1.lat - p0.lat) * t
  }

  // 计算航向角（顺时针度数，0 为正北）
  // 为避免短线段抖动，向前瞻探测至少 15 米或接下来的若干点计算朝向
  let lookaheadIdx = Math.min(points.length - 1, idx + 1)
  while (lookaheadIdx < points.length - 1 && points[lookaheadIdx].dist - dist < 15) {
    lookaheadIdx++
  }
  const targetPt = points[lookaheadIdx]
  const dLng = targetPt.lng - currentLng
  const dLat = targetPt.lat - currentLat
  const radLat = (currentLat * Math.PI) / 180
  const dx = dLng * Math.cos(radLat)
  const dy = dLat

  let heading = 0
  if (Math.abs(dx) > 1e-7 || Math.abs(dy) > 1e-7) {
    heading = (Math.atan2(dx, dy) * 180) / Math.PI
    if (heading < 0) heading += 360
  }

  // 判定途经城市与地点信息
  let city = ''
  let place = ''
  let statusText = ''
  let isNearStop = false

  // 寻找距离最近的站点
  let nearestM: CruiseMilestone | null = null
  let nearestDiff = Infinity

  for (const m of milestones) {
    const diff = Math.abs(m.milestoneDist - dist)
    if (diff < nearestDiff) {
      nearestDiff = diff
      nearestM = m
    }
  }

  // 寻找上一站和下一站
  let prevM: CruiseMilestone | null = null
  let nextM: CruiseMilestone | null = null

  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i]
    if (m.milestoneDist <= dist) {
      prevM = m
    }
    if (m.milestoneDist > dist && !nextM) {
      nextM = m
    }
  }

  // 若小车距某个站点在 500 米以内，判定为「正在经过该站点」
  if (nearestM && nearestDiff <= 500) {
    isNearStop = true
    city = nearestM.city || (prevM?.city || nextM?.city || '')
    place = nearestM.name
    statusText = `📍 经过 D${nearestM.dayIndex + 1} 第${nearestM.stopIndex}站`
  } else if (prevM && nextM) {
    city = prevM.city || nextM.city || '自驾途中'
    place = `${prevM.name} ➔ ${nextM.name}`
    statusText = `🚗 前往：${nextM.name}（D${nextM.dayIndex + 1}）`
  } else if (nextM) {
    city = nextM.city || '自驾途中'
    place = `出发前往 ➔ ${nextM.name}`
    statusText = `🏁 前往第 1 站：${nextM.name}`
  } else if (prevM) {
    city = prevM.city || '自驾途中'
    place = `${prevM.name}（已到达本程终点）`
    statusText = `🎉 顺利抵达终点`
  } else {
    city = '自驾途中'
    place = '自驾路线规划中'
    statusText = '🚗 沿途巡游中'
  }

  return {
    lng: currentLng,
    lat: currentLat,
    heading,
    progress,
    currentDist: dist,
    totalDist: totalDistance,
    city: city || '沿途风景',
    place,
    statusText,
    isNearStop,
    passedIdx: idx,
  }
}
