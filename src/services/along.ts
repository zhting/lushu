import type { MapProvider, Poi, Stop, StopKind } from '../types'
import { haversineKm } from './geo'
import * as amapSvc from './amap'
import * as osmSvc from './osm'

export type SupplyKind = 'hotel' | 'fuel' | 'charge' | 'services'

export const SUPPLY_META: Record<
  SupplyKind,
  { label: string; icon: string; stopKind: StopKind; amapType: string; osm: string; radiusM: number; fallbackName: string }
> = {
  hotel: {
    label: '终点附近住宿',
    icon: '🏨',
    stopKind: 'hotel',
    amapType: '100100', // 宾馆酒店
    osm: 'nwr["tourism"~"^(hotel|motel|guest_house|hostel)$"]',
    radiusM: 5000,
    fallbackName: '住宿',
  },
  fuel: {
    label: '沿途加油站',
    icon: '⛽',
    stopKind: 'fuel',
    amapType: '010100', // 加油站
    osm: 'nwr["amenity"="fuel"]',
    radiusM: 2000,
    fallbackName: '加油站',
  },
  charge: {
    label: '沿途充电站',
    icon: '🔌',
    stopKind: 'fuel',
    amapType: '011100', // 充电站
    osm: 'nwr["amenity"="charging_station"]',
    radiusM: 2000,
    fallbackName: '充电站',
  },
  services: {
    label: '沿途服务区',
    icon: '🅿️',
    stopKind: 'waypoint',
    amapType: '180300', // 服务区
    osm: 'nwr["highway"~"^(services|rest_area)$"]',
    radiusM: 3000,
    fallbackName: '服务区',
  },
}

export interface AlongResult {
  poi: Poi
  /** 距当天出发点的沿路里程（km） */
  alongKm: number
  /** 离路线的直线距离（km） */
  offKm: number
  /** 加入当天时应插入的位置（day.stops 下标） */
  insertAt: number
}

type LngLat = [number, number]

/** 折线累计里程（km），与 path 下标一一对应 */
function cumulative(path: LngLat[]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i++) {
    out.push(out[i - 1] + haversineKm({ lng: path[i - 1][0], lat: path[i - 1][1] }, { lng: path[i][0], lat: path[i][1] }))
  }
  return out
}

/** 按里程间隔取样（首尾必取），最多 maxPoints 个 */
function sampleByDistance(path: LngLat[], cum: number[], stepKm: number, maxPoints: number): LngLat[] {
  if (!path.length) return []
  const total = cum[cum.length - 1]
  const step = Math.max(stepKm, total / Math.max(1, maxPoints - 1))
  const out: LngLat[] = [path[0]]
  let next = step
  for (let i = 1; i < path.length; i++) {
    if (cum[i] >= next) {
      out.push(path[i])
      next = cum[i] + step
    }
  }
  const last = path[path.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/** POI 投影到折线：取最近的折线顶点，返回沿路里程与离线距离 */
function project(p: Poi, path: LngLat[], cum: number[]): { alongKm: number; offKm: number } {
  let best = Infinity
  let bi = 0
  for (let i = 0; i < path.length; i++) {
    const d = haversineKm(p, { lng: path[i][0], lat: path[i][1] })
    if (d < best) {
      best = d
      bi = i
    }
  }
  return { alongKm: cum[bi] ?? 0, offKm: best }
}

/** 插在哪两个相邻节点之间绕路最少，返回插入下标 */
export function bestInsertIndex(stops: Pick<Stop, 'lng' | 'lat'>[], p: Pick<Poi, 'lng' | 'lat'>): number {
  if (stops.length < 2) return stops.length
  let best = Infinity
  let at = stops.length
  for (let j = 0; j < stops.length - 1; j++) {
    const detour = haversineKm(stops[j], p) + haversineKm(p, stops[j + 1]) - haversineKm(stops[j], stops[j + 1])
    if (detour < best) {
      best = detour
      at = j + 1
    }
  }
  return at
}

function dedupe(list: Poi[]): Poi[] {
  const out: Poi[] = []
  for (const p of list) {
    const dup = out.some(
      (q) => haversineKm(p, q) < 0.05 || (p.name && p.name === q.name && haversineKm(p, q) < 0.3),
    )
    if (!dup) out.push(p)
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 沿当天路线搜索补给点。
 * - 住宿：只搜当天最后一个地点附近，加入时放到当天末尾。
 * - 加油 / 充电 / 服务区：沿车行折线取样搜索，按沿路里程排序，加入时插在绕路最少的两站之间。
 * path 为当天车行折线（与 stops 同一坐标系）；没有时退化为节点连线。
 */
export async function searchAlong(opts: {
  kind: SupplyKind
  stops: Stop[]
  path?: LngLat[]
  provider: MapProvider
  amapKey?: string
  amapSecurityJsCode?: string
}): Promise<AlongResult[]> {
  const { kind, stops, provider } = opts
  const meta = SUPPLY_META[kind]
  if (!stops.length) return []
  const path: LngLat[] = opts.path && opts.path.length >= 2 ? opts.path : stops.map((s) => [s.lng, s.lat] as LngLat)
  const cum = cumulative(path)
  const end = stops[stops.length - 1]

  let raw: Poi[] = []
  if (kind === 'hotel') {
    if (provider === 'amap') {
      raw = await amapSvc.searchNearby(end, meta.amapType, meta.radiusM, opts.amapKey, opts.amapSecurityJsCode)
    } else {
      raw = await osmSvc.overpass(`${meta.osm}(around:${meta.radiusM},${end.lat},${end.lng});`, 40)
    }
  } else if (provider === 'amap') {
    // 高德只能按点搜周边：沿线每约 25 km 取一个点，最多 12 个，逐个请求
    const pts = sampleByDistance(path, cum, 25, 12)
    for (let i = 0; i < pts.length; i++) {
      if (i) await sleep(250)
      const list = await amapSvc.searchNearby(
        { lng: pts[i][0], lat: pts[i][1] },
        meta.amapType,
        meta.radiusM + 1000,
        opts.amapKey,
        opts.amapSecurityJsCode,
      )
      raw.push(...list)
    }
  } else {
    // Overpass 的 around 支持传一条折线：沿线约每 2 km 取点，最多 150 个
    const pts = sampleByDistance(path, cum, 2, 150)
    const coords = pts.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',')
    raw = await osmSvc.overpass(`${meta.osm}(around:${meta.radiusM},${coords});`, 80)
  }

  const results = dedupe(raw).map((poi) => {
    const named = poi.name ? poi : { ...poi, name: meta.fallbackName }
    if (kind === 'hotel') {
      return { poi: named, alongKm: cum[cum.length - 1] ?? 0, offKm: haversineKm(named, end), insertAt: stops.length }
    }
    const { alongKm, offKm } = project(named, path, cum)
    return { poi: named, alongKm, offKm, insertAt: bestInsertIndex(stops, named) }
  })

  // 剔除离路线（住宿为离终点）太远的结果：高德按点搜的半径更大，可能带出远处的结果
  const filtered = results.filter((r) => r.offKm <= meta.radiusM / 1000 + (kind === 'hotel' ? 1 : 0.5))
  filtered.sort((a, b) => (kind === 'hotel' ? a.offKm - b.offKm : a.alongKm - b.alongKm))
  return filtered.slice(0, 40)
}
