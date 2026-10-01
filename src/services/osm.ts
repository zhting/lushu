import type { Poi, RoutePolicy, RouteResult, Stop } from '../types'

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
export async function searchPlaces(kw: string): Promise<Poi[]> {
  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-CN&q=${encodeURIComponent(kw)}`,
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

/**
 * 驾车路径规划（OSRM 演示服务器）。
 * 注意：演示服务器只有默认策略（路线策略参数暂不生效），也不提供过路费数据。
 */
export async function fetchRoute(points: Stop[], _policy: RoutePolicy): Promise<RouteResult> {
  const pts = points.filter(Boolean)
  if (pts.length < 2) throw new Error('请先设置起点和终点')
  if (pts.length - 2 > 16) throw new Error('途经点超过 16 个上限，请拆分到其他天')

  const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';')
  const data = await fetchJson(
    `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    '路线规划（OSRM）',
  )
  const route = data?.routes?.[0]
  if (data?.code !== 'Ok' || !route) throw new Error('未找到可行驾车路线（OSRM）')
  // legs 与传入点一一对应：legs[i] 即第 i → i+1 个节点之间的真实行车距离/时长
  const legs = (route.legs ?? [])
    .map((l: any) => ({ distanceM: Number(l.distance) || 0, durationS: Number(l.duration) || 0 }))
  return {
    distanceM: Number(route.distance) || 0,
    durationS: Number(route.duration) || 0,
    tolls: null,
    legs: legs.length ? legs : null,
    path: (route.geometry?.coordinates ?? []) as [number, number][],
  }
}
