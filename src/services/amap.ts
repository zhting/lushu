import type { Poi } from '../types'

let AMapNS: any = null
let loadPromise: Promise<any> | null = null

export function getAMap(): any {
  return AMapNS
}

/**
 * 动态加载高德 JS API 2.0。
 * 2021-12-02 之后申请的 Key 必须配合安全密钥（securityJsCode）使用，
 * 需在脚本加载前写入 window._AMapSecurityConfig。
 */
export function loadAMap(key: string, securityJsCode = ''): Promise<any> {
  if (AMapNS) return Promise.resolve(AMapNS)
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    if (securityJsCode) {
      ;(window as any)._AMapSecurityConfig = { securityJsCode }
    }
    const script = document.createElement('script')
    script.src =
      `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}` +
      `&plugin=AMap.Driving,AMap.PlaceSearch,AMap.Geocoder,AMap.Geolocation`
    script.async = true
    script.onerror = () => {
      loadPromise = null
      reject(new Error('高德 JS API 脚本加载失败，请检查网络后重试'))
    }
    script.onload = () => {
      const AMap = (window as any).AMap
      if (!AMap) {
        loadPromise = null
        reject(new Error('高德 JS API 加载异常'))
        return
      }
      AMapNS = AMap
      resolve(AMap)
    }
    document.head.appendChild(script)
  })
  return loadPromise
}

function friendlyError(status: string, result?: any): string {
  const info = String(result?.info ?? '')
  if (/INVALID_USER_SCODE/.test(info)) return '安全密钥（securityJsCode）缺失或不正确，请检查 Key 设置'
  if (/INVALID_USER_KEY|USERKEY/i.test(info)) return '高德 Key 无效：请确认 Key 正确且类型为「Web端(JS API)」'
  if (/DAILY_QUERY_OVER|QUOTA|LIMIT/i.test(info)) return '今日调用配额已用完，请明日再试或提升配额'
  if (status === 'no_data') return '未查询到结果'
  return info ? `高德接口返回错误：${info}` : '请求失败，请稍后重试'
}

/** POI 关键词搜索（高德 PlaceSearch 插件） */
export function searchPlaces(kw: string, city = ''): Promise<Poi[]> {
  const AMap = getAMap()
  if (!AMap) return Promise.reject(new Error('地图尚未加载完成'))
  const ps = new AMap.PlaceSearch({ pageSize: 8, pageIndex: 1, city, citylimit: false })
  return new Promise((resolve, reject) => {
    ps.search(kw, (status: string, result: any) => {
      if (status === 'complete') {
        const pois = result?.poiList?.pois ?? []
        resolve(
          pois.map((p: any) => ({
            name: p.name ?? '未命名地点',
            address: [p.pname, p.cityname, p.adname, p.address].filter(Boolean).join(''),
            district: [p.pname, p.cityname].filter(Boolean).join('·'),
            lng: p.location?.lng,
            lat: p.location?.lat,
          })).filter((p: Poi) => Number.isFinite(p.lng) && Number.isFinite(p.lat)),
        )
      } else if (status === 'no_data') {
        resolve([])
      } else {
        reject(new Error(friendlyError(status, result)))
      }
    })
  })
}

/** 逆地理编码：坐标 → 名称/地址（用于地图点选） */
export function reverseGeocode(lng: number, lat: number): Promise<{ name: string; address: string }> {
  const AMap = getAMap()
  if (!AMap) return Promise.reject(new Error('地图尚未加载完成'))
  const geocoder = new AMap.Geocoder()
  return new Promise((resolve, reject) => {
    geocoder.getAddress(new AMap.LngLat(lng, lat), (status: string, result: any) => {
      if (status !== 'complete' || !result?.regeocode) {
        reject(new Error(friendlyError(status, result)))
        return
      }
      const re = result.regeocode
      const poiName = re.pois?.[0]?.name
      const addr = re.formattedAddress ?? ''
      resolve({
        name: poiName || (addr ? addr.slice(0, 30) : `${lng.toFixed(4)}, ${lat.toFixed(4)}`),
        address: addr,
      })
    })
  })
}

/** 浏览器/高德定位（返回 GCJ-02 坐标，与地图一致） */
export function currentPosition(): Promise<{ lng: number; lat: number }> {
  const AMap = getAMap()
  if (!AMap) return Promise.reject(new Error('地图尚未加载完成'))
  const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 8000 })
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition((status: string, result: any) => {
      if (status === 'complete' && result?.position) {
        resolve({ lng: result.position.lng, lat: result.position.lat })
      } else {
        reject(new Error(result?.message || '定位失败，请检查浏览器定位权限'))
      }
    })
  })
}

const legCache = new Map<string, { distanceM: number; durationS: number; path: [number, number][] }>()

/** 相邻两点间的车行导航线路（高德 Driving）：距离 + 耗时 + 完整折线，按坐标对缓存 */
export async function legRoute(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
  key = '',
  securityJsCode = '',
): Promise<{ distanceM: number; durationS: number; path: [number, number][] }> {
  // 地图库可能尚未被地图组件加载（如刷新后未打开过地图），这里自行加载，不依赖地图容器
  if (!getAMap()) await loadAMap(key, securityJsCode)
  const AMap = getAMap()!
  const key0 = `${a.lng.toFixed(5)},${a.lat.toFixed(5)}|${b.lng.toFixed(5)},${b.lat.toFixed(5)}`
  const hit = legCache.get(key0)
  if (hit) return hit
  return new Promise((resolve, reject) => {
    const driving = new AMap.Driving()
    driving.search(new AMap.LngLat(a.lng, a.lat), new AMap.LngLat(b.lng, b.lat), (status: string, result: any) => {
      if (status !== 'complete') {
        reject(new Error(friendlyError(status, result)))
        return
      }
      const route = result?.routes?.[0]
      const d = Number(route?.distance)
      const dur = Number(route?.time) || 0
      const path: [number, number][] = []
      for (const step of route?.steps ?? []) {
        for (const p of step.path ?? []) path.push([p.lng, p.lat])
      }
      if (!Number.isFinite(d) || path.length < 2) {
        reject(new Error('未测到车行线路'))
        return
      }
      const out = { distanceM: d, durationS: Math.round(dur), path }
      legCache.set(key0, out)
      resolve(out)
    })
  })
}
