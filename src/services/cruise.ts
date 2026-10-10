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
export function sampleCruiseTrack(track: CruiseTrack, currentDist: number, lookaheadM = 15): CruiseState {
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
  // 为避免短线段抖动，向前瞻探测至少 lookaheadM 米（调用方按地图比例尺给，约 30 像素）计算朝向
  let lookaheadIdx = Math.min(points.length - 1, idx + 1)
  while (lookaheadIdx < points.length - 1 && points[lookaheadIdx].dist - dist < lookaheadM) {
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

// ───────────────────────── 巡游时间轴 ─────────────────────────
// 思路借鉴 map-motion（github.com/SpaceZephyr/map-motion，MIT）的 trip 镜头：
// 先排好一张时间表——全景开场 → 每段路单独定时长（按 √里程压缩）→ 到站停留 → 下一段 → 拉回全景收尾，
// 每段起步加速、到站减速；播放时按「时间」求状态，拖动、倍速、录屏都能复现。

export type CruisePhase = 'intro' | 'drive' | 'stay' | 'outro'

export interface CruiseLeg {
  index: number
  from: number // milestones 下标
  to: number
  d0: number // 轨迹累计距离（米）
  d1: number
  t0: number // 1 倍速下的开始 / 结束时刻（秒）
  t1: number
  dayIndex: number // 到达站所属天
}

export interface CruiseStay {
  milestone: number
  t0: number
  t1: number
  dayEnd: boolean // 是否为一天的最后一站（停留稍长）
}

export interface CruiseTimeline {
  legs: CruiseLeg[]
  stays: CruiseStay[]
  introEnd: number
  outroStart: number
  duration: number
}

export interface CruiseMoment {
  t: number
  dist: number
  phase: CruisePhase
  leg: number // 当前（或刚结束 / 即将开始的）路段下标
  stayAt: number // 正在停留的站点（milestones 下标），否则 -1
  phaseProgress: number // 当前阶段 0~1
}

export const TIMELINE = {
  intro: 2.4, // 全景开场
  outro: 3.2, // 收尾拉回全景
  stay: 1.5, // 途经站停留
  stayDayEnd: 2.2, // 一天结束（住宿点）停留
  minStopGapM: 30, // 两站距离小于它视为同一处，不单独成段
}

/** 一段路的播放时长（秒，1 倍速）：短的景点段不会一闪而过，长途段也不会拖太久。5 km≈2.5s，50 km≈3.3s，500 km≈5.6s */
export function legDuration(meters: number): number {
  const km = Math.max(0, meters) / 1000
  return Math.min(7, 2.2 + 2.6 * Math.sqrt(km / 300))
}

/** 段内进度：匀加速 r 秒 → 匀速 → 匀减速 r 秒（与 map-motion 的 prog() 同一写法），返回 0~1 */
export function driveEase(u: number, T: number): number {
  if (T <= 0) return 1
  u = Math.max(0, Math.min(T, u))
  const r = Math.min(0.8, T * 0.25)
  const v = 1 / (T - r)
  if (u < r) return (v * u * u) / (2 * r)
  if (u > T - r) return 1 - (v * (T - u) ** 2) / (2 * r)
  return v * (u - r / 2)
}

export function buildCruiseTimeline(track: CruiseTrack): CruiseTimeline {
  const ms = track.milestones
  // 合并几乎重合的相邻站点（接续节点等），只保留需要真正开过去的站
  const keep: number[] = []
  for (let i = 0; i < ms.length; i++) {
    const last = keep.length ? ms[keep[keep.length - 1]] : null
    if (last && ms[i].milestoneDist - last.milestoneDist < TIMELINE.minStopGapM) {
      keep[keep.length - 1] = i // 用后一个（同一处，保留更晚的站名/天数）
      continue
    }
    keep.push(i)
  }

  const legs: CruiseLeg[] = []
  const stays: CruiseStay[] = []
  let t = TIMELINE.intro
  const introEnd = t

  if (keep.length < 2) {
    // 站点不足两个：整条轨迹当一段开
    const T = legDuration(track.totalDistance)
    legs.push({ index: 0, from: keep[0] ?? 0, to: keep[0] ?? 0, d0: 0, d1: track.totalDistance, t0: t, t1: t + T, dayIndex: ms[0]?.dayIndex ?? 0 })
    t += T
  } else {
    for (let k = 1; k < keep.length; k++) {
      const a = ms[keep[k - 1]]
      const b = ms[keep[k]]
      const d0 = k === 1 ? 0 : a.milestoneDist // 第一段从轨迹起点开
      const d1 = k === keep.length - 1 ? track.totalDistance : b.milestoneDist // 最后一段开到轨迹终点
      const T = legDuration(d1 - d0)
      legs.push({ index: legs.length, from: keep[k - 1], to: keep[k], d0, d1, t0: t, t1: t + T, dayIndex: b.dayIndex })
      t += T
      if (k < keep.length - 1) {
        const next = ms[keep[k + 1]]
        const dayEnd = next.dayIndex !== b.dayIndex
        const dur = dayEnd ? TIMELINE.stayDayEnd : TIMELINE.stay
        stays.push({ milestone: keep[k], t0: t, t1: t + dur, dayEnd })
        t += dur
      }
    }
  }

  const outroStart = t
  return { legs, stays, introEnd, outroStart, duration: t + TIMELINE.outro }
}

/** 时间轴上 t 秒（1 倍速时间）时小车在哪、处于哪个阶段 */
export function timelineAt(tl: CruiseTimeline, track: CruiseTrack, t: number): CruiseMoment {
  t = Math.max(0, Math.min(tl.duration, t))
  if (t < tl.introEnd) {
    return { t, dist: 0, phase: 'intro', leg: 0, stayAt: -1, phaseProgress: t / tl.introEnd }
  }
  if (t >= tl.outroStart) {
    const last = tl.legs[tl.legs.length - 1]
    return {
      t,
      dist: track.totalDistance,
      phase: 'outro',
      leg: tl.legs.length - 1,
      stayAt: last ? last.to : -1,
      phaseProgress: (t - tl.outroStart) / Math.max(0.001, tl.duration - tl.outroStart),
    }
  }
  for (let i = 0; i < tl.legs.length; i++) {
    const L = tl.legs[i]
    if (t < L.t1) {
      const T = L.t1 - L.t0
      const e = driveEase(t - L.t0, T)
      return { t, dist: L.d0 + (L.d1 - L.d0) * e, phase: 'drive', leg: i, stayAt: -1, phaseProgress: (t - L.t0) / T }
    }
    const S = tl.stays[i]
    if (S && t < S.t1) {
      return { t, dist: L.d1, phase: 'stay', leg: i, stayAt: S.milestone, phaseProgress: (t - S.t0) / (S.t1 - S.t0) }
    }
  }
  return { t, dist: track.totalDistance, phase: 'outro', leg: tl.legs.length - 1, stayAt: -1, phaseProgress: 0 }
}

/** 已行驶距离 → 时间轴时刻（拖动「按距离」的旧接口、或按里程定位时用） */
export function timeOfDist(tl: CruiseTimeline, dist: number): number {
  for (const L of tl.legs) {
    if (dist <= L.d1) {
      const T = L.t1 - L.t0
      const target = (dist - L.d0) / Math.max(1e-6, L.d1 - L.d0)
      let lo = 0
      let hi = T
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2
        if (driveEase(mid, T) < target) lo = mid
        else hi = mid
      }
      return L.t0 + (lo + hi) / 2
    }
  }
  return tl.outroStart
}
