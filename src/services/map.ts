import type { MapProvider, Poi, RoutePolicy, RouteResult, Stop } from '../types'
import * as amapSvc from './amap'
import * as osmSvc from './osm'

/**
 * 地图服务调度层：根据当前数据源（开源 OSM / 高德）分发同一套接口。
 * provider 由 Pinia store 在初始化和切换数据源时写入。
 */
let provider: MapProvider = 'osm'

export function setProvider(p: MapProvider) {
  provider = p
}

export function currentProvider(): MapProvider {
  return provider
}

export function loadMapLib(key = '', securityJsCode = ''): Promise<any> {
  return provider === 'amap' ? amapSvc.loadAMap(key, securityJsCode) : osmSvc.loadLeaflet()
}

export function searchPlaces(kw: string, city = ''): Promise<Poi[]> {
  return provider === 'amap' ? amapSvc.searchPlaces(kw, city) : osmSvc.searchPlaces(kw)
}

export function reverseGeocode(lng: number, lat: number): Promise<{ name: string; address: string }> {
  return provider === 'amap' ? amapSvc.reverseGeocode(lng, lat) : osmSvc.reverseGeocode(lng, lat)
}

export function currentPosition(): Promise<{ lng: number; lat: number }> {
  return provider === 'amap' ? amapSvc.currentPosition() : osmSvc.currentPosition()
}

export function fetchRoute(points: Stop[], policy: RoutePolicy): Promise<RouteResult> {
  return provider === 'amap' ? amapSvc.fetchRoute(points, policy) : osmSvc.fetchRoute(points, policy)
}
