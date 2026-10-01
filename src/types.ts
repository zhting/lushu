export type StopKind = 'waypoint' | 'scenic' | 'hotel' | 'food' | 'fuel'
export type RoutePolicy = 'fastest' | 'shortest' | 'leastFee'
export type MapProvider = 'osm' | 'amap'

export interface Stop {
  id: string
  kind: StopKind
  name: string
  lng: number
  lat: number
  address: string
  stayMinutes: number
  note?: string
}

export interface Day {
  id: string
  departTime: string // 'HH:mm'
  startAuto: boolean // >0 天：从前一天最后一个节点出发（否则从本日第一个节点出发）
  stops: Stop[] // 当天按顺序的地点列表（无固定起点/终点）
  note: string
}

export interface Trip {
  id: string
  title: string
  startDate: string // yyyy-mm-dd
  policy: RoutePolicy
  driveWarnMinutes: number // 单日驾驶提醒阈值
  days: Day[]
}

/** 本地存储中的一份路书（含路线缓存） */
export interface StoredTrip {
  id: string
  savedAt: number
  trip: Trip
  routes: Record<string, RouteMeta>
  paths: Record<string, [number, number][]>
}

/** 相邻两个节点之间的行车数据 */
export interface RouteLeg {
  distanceM: number
  durationS: number
}

export interface RouteMeta {
  status: 'pending' | 'done' | 'error'
  hash: string
  distanceM: number
  durationS: number
  tolls: number | null
  legs: RouteLeg[] | null // 接口不支持分段时为 null
  error: string
}

export interface Poi {
  name: string
  address: string
  district: string
  lng: number
  lat: number
}

export interface RouteResult {
  distanceM: number
  durationS: number
  tolls: number | null
  legs: RouteLeg[] | null
  path: [number, number][]
}
