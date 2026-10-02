export type StopKind = 'waypoint' | 'scenic' | 'hotel' | 'food' | 'fuel'
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
  days: Day[]
}

/** 本地存储中的一份路书 */
export interface StoredTrip {
  id: string
  savedAt: number
  trip: Trip
}

export interface Poi {
  name: string
  address: string
  district?: string
  lng: number
  lat: number
}
