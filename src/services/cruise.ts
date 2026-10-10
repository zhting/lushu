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
  passedCoords: [number, number][] // 已经行驶过的坐标点（用于点亮路线）
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

    // 如果多天拼接，并且与前一天有间隙，将当前天起点加入
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
      })
    })
  })

  if (rawPath.length < 2) return null

  // 坐标去重：过滤掉距离小于 1 米的连续微小抖动点
  const dedupedCoords: [number, number][] = [rawPath[0]]
  for (let i = 1; i < rawPath.length; i++) {
    const prev = dedupedCoords[dedupedCoords.length - 1]
    const curr = rawPath[i]
    const dist = haversineM({ lng: prev[0], lat: prev[1] }, { lng: curr[0], lat: curr[1] })
    if (dist >= 1) {
      dedupedCoords.push(curr)
    }
  }

  if (dedupedCoords.length < 2) return null

  // 构建累积距离数组
  const points: CruisePoint[] = []
  let accDist = 0

  points.push({
    lng: dedupedCoords[0][0],
    lat: dedupedCoords[0][1],
    dist: 0,
  })

  for (let i = 1; i < dedupedCoords.length; i++) {
    const prev = points[i - 1]
    const curr = dedupedCoords[i]
    const segDist = haversineM(prev, { lng: curr[0], lat: curr[1] })
    accDist += segDist
    points.push({
      lng: curr[0],
      lat: curr[1],
      dist: accDist,
    })
  }

  const totalDistance = accDist
  if (totalDistance <= 0) return null

  // 为每个站点计算在整条折线上的最近里程点
  milestones.forEach((m) => {
    let bestDist = 0
    let minErr = Infinity
    for (let i = 0; i < points.length; i++) {
      const err = haversineM({ lng: m.stop.lng, lat: m.stop.lat }, points[i])
      if (err < minErr) {
        minErr = err
        bestDist = points[i].dist
      }
    }
    m.milestoneDist = bestDist
  })

  // 按里程顺序排序 milestones
  milestones.sort((a, b) => a.milestoneDist - b.milestoneDist)

  return {
    points,
    totalDistance,
    milestones,
    targetLabel: rangeLabel || '自驾路线',
  }
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
  const passedCoords: [number, number][] = []

  // 收集之前走过的折线点
  for (let i = 0; i <= idx; i++) {
    passedCoords.push([points[i].lng, points[i].lat])
  }

  const segLen = p1.dist - p0.dist
  let t = 0
  if (segLen > 0) {
    t = Math.max(0, Math.min(1, (dist - p0.dist) / segLen))
    currentLng = p0.lng + (p1.lng - p0.lng) * t
    currentLat = p0.lat + (p1.lat - p0.lat) * t
  }

  // 将当前位置追加至已走过点
  passedCoords.push([currentLng, currentLat])

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

  milestones.forEach((m) => {
    const diff = Math.abs(m.milestoneDist - dist)
    if (diff < nearestDiff) {
      nearestDiff = diff
      nearestM = m
    }
  })

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
    passedCoords,
  }
}
