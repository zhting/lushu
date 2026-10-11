import type { MapProvider, Poi } from '../types'
import * as amapSvc from './amap'
import * as osmSvc from './osm'
import { routeCacheGet, routeCachePut } from './offline'

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
  return provider === 'amap' ? amapSvc.searchPlaces(kw, city) : osmSvc.searchPlaces(kw, city)
}

export function reverseGeocode(lng: number, lat: number): Promise<{ name: string; address: string }> {
  return provider === 'amap' ? amapSvc.reverseGeocode(lng, lat) : osmSvc.reverseGeocode(lng, lat)
}

export function currentPosition(): Promise<{ lng: number; lat: number }> {
  return provider === 'amap' ? amapSvc.currentPosition() : osmSvc.currentPosition()
}

/**
 * 相邻两点间的车行导航线路（距离 + 耗时 + 折线）。
 * 结果按「数据源 + 坐标对」存进 IndexedDB：刷新页面不用重算，离线也能显示。fromCache 表示命中本机缓存。
 */
export async function legRoute(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
  key = '',
  securityJsCode = '',
): Promise<amapSvc.LegResult & { fromCache?: boolean }> {
  const p = provider
  const k = `${p}|${a.lng.toFixed(5)},${a.lat.toFixed(5)}|${b.lng.toFixed(5)},${b.lat.toFixed(5)}`
  const hit = await routeCacheGet<amapSvc.LegResult>(k)
  if (hit && Array.isArray(hit.path)) return { ...hit, fromCache: true }
  const r = p === 'amap' ? await amapSvc.legRoute(a, b, key, securityJsCode) : await osmSvc.legRoute(a, b)
  void routeCachePut(k, r)
  return r
}

/** 城市/行政区搜索接口 */
export function searchCities(kw: string): Promise<Array<{ name: string; province?: string }>> {
  return provider === 'amap' ? amapSvc.searchCities(kw) : Promise.resolve([])
}

