import type { LegResult } from './amap'
import type { Poi } from '../types'

let L: any = null
let loadPromise: Promise<any> | null = null

export function getLeaflet(): any {
  return L
}

const LEAFLET_VERSION = '1.9.4'
const CDN = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist`

/** 动态加载 Leaflet（开源模式，无需任何 Key） */
export function loadLeaflet(): Promise<any> {
  if (L) return Promise.resolve(L)
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${CDN}/leaflet.css`
    document.head.appendChild(link)

    const script = document.createElement('script')
    script.src = `${CDN}/leaflet.js`
    script.async = true
    script.onerror = () => {
      loadPromise = null
      reject(new Error('Leaflet 脚本加载失败，请检查网络'))
    }
    script.onload = () => {
      L = (window as any).L
      if (!L) {
        loadPromise = null
        reject(new Error('Leaflet 加载异常'))
        return
      }
      resolve(L)
    }
    document.head.appendChild(script)
  })
  return loadPromise
}

async function fetchJson(url: string, source: string): Promise<any> {
  let res: Response
  try {
    res = await fetch(url)
  } catch {
    throw new Error(`${source}请求失败，请检查网络`)
  }
  if (!res.ok) throw new Error(`${source}返回错误（HTTP ${res.status}）`)
  return res.json()
}

/** POI 关键词搜索（Nominatim）。测试用：有每秒 1 次的官方使用限制，生产环境建议自建或换商用服务 */
export async function searchPlaces(kw: string, city = ''): Promise<Poi[]> {
  // Nominatim 无城市参数，把城市名拼进关键词限定范围
  const q = city ? `${kw} ${city}` : kw
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-CN&q=${encodeURIComponent(q)}`,
    '地点搜索（Nominatim）',
  )
  return (Array.isArray(data) ? data : [])
    .map((d: any) => ({
      name: d.name || String(d.display_name || '').split(',')[0] || '未命名地点',
      address: String(d.display_name ?? ''),
      district: '',
      lng: parseFloat(d.lon),
      lat: parseFloat(d.lat),
    }))
    .filter((p: Poi) => Number.isFinite(p.lng) && Number.isFinite(p.lat))
}

/** 逆地理编码：坐标 → 名称/地址（Nominatim） */
export async function reverseGeocode(lng: number, lat: number): Promise<{ name: string; address: string }> {
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=zh-CN`,
    '位置解析（Nominatim）',
  )
  const display = String(data?.display_name ?? '')
  const name = data?.name || (display ? display.split(',')[0] : `${lng.toFixed(4)}, ${lat.toFixed(4)}`)
  return { name, address: display }
}

/** 浏览器定位（WGS-84，与 OSM 瓦片坐标系一致，无需转换） */
export function currentPosition(): Promise<{ lng: number; lat: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('浏览器不支持定位'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      (err) => reject(new Error(err.message || '定位失败，请检查浏览器定位权限')),
      { enableHighAccuracy: true, timeout: 8000 },
    )
  })
}

const legCache = new Map<string, LegResult>()

/** 相邻两点间的车行导航线路（OSRM 演示服务）：距离 + 耗时 + 完整折线，按坐标对缓存 */
export async function legRoute(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): Promise<LegResult> {
  const key = `${a.lng.toFixed(5)},${a.lat.toFixed(5)}|${b.lng.toFixed(5)},${b.lat.toFixed(5)}`
  const hit = legCache.get(key)
  if (hit) return hit
  const data = await fetchJson(
    `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`,
    '距离测算（OSRM）',
  )
  const route = data?.routes?.[0]
  const d = Number(route?.distance)
  const dur = Number(route?.duration) || 0
  const path = (route?.geometry?.coordinates ?? []) as [number, number][]
  if (data?.code !== 'Ok' || !Number.isFinite(d) || path.length < 2) throw new Error('未测到车行线路（OSRM）')
  const out: LegResult = { distanceM: d, durationS: Math.round(dur), tollsYuan: null, path } // OSRM 不提供过路费
  legCache.set(key, out)
  return out
}

/**
 * Overpass 查询（OSM 标签检索）。公共服务，有频率与超时限制，只适合测试与小流量。
 * query 为 Overpass QL 主体（不含输出语句）。
 */
export async function overpass(query: string, limit = 60): Promise<Poi[]> {
  const ql = `[out:json][timeout:25];(${query});out center ${limit};`
  let res: Response
  try {
    res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(ql),
    })
  } catch {
    throw new Error('沿途搜索（Overpass）请求失败，请检查网络')
  }
  if (res.status === 429 || res.status === 504) throw new Error('沿途搜索服务繁忙，请稍后再试')
  if (!res.ok) throw new Error(`沿途搜索返回错误（HTTP ${res.status}）`)
  const data = await res.json()
  return (data?.elements ?? [])
    .map((e: any) => {
      const t = e.tags ?? {}
      const lat = e.lat ?? e.center?.lat
      const lng = e.lon ?? e.center?.lon
      const name = t['name:zh'] || t.name || t.brand || t.operator || ''
      const address = [t['addr:city'], t['addr:district'], t['addr:street'], t['addr:housenumber']].filter(Boolean).join('')
      return { name, address: address || (t.brand && t.name ? t.brand : ''), lat: Number(lat), lng: Number(lng) }
    })
    .filter((p: Poi) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
}
