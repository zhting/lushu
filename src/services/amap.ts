import type { Poi, RoutePolicy, RouteResult, Stop } from '../types'

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

function policyValue(AMap: any, policy: RoutePolicy): number {
  const DP = AMap.DrivingPolicy ?? {}
  if (policy === 'leastFee') return DP.LEAST_FEE ?? 1
  if (policy === 'shortest') return DP.LEAST_DISTANCE ?? 2
  return DP.LEAST_TIME ?? 0
}

/**
 * 驾车路径规划：起点 → 途经点（≤16）→ 终点，一次请求。
 * 返回总里程、总时长、过路费（若接口提供）与完整折线。
 */
export function fetchRoute(points: Stop[], policy: RoutePolicy): Promise<RouteResult> {
  const AMap = getAMap()
  if (!AMap) return Promise.reject(new Error('地图尚未加载完成'))
  const pts = points.filter(Boolean)
  if (pts.length < 2) return Promise.reject(new Error('请先设置起点和终点'))
  const waypoints = pts.slice(1, -1)
  if (waypoints.length > 16) return Promise.reject(new Error('途经点超过 16 个上限，请拆分到其他天'))

  const driving = new AMap.Driving({ policy: policyValue(AMap, policy) })
  const origin = new AMap.LngLat(pts[0].lng, pts[0].lat)
  const destination = new AMap.LngLat(pts[pts.length - 1].lng, pts[pts.length - 1].lat)

  return new Promise((resolve, reject) => {
    driving.search(
      origin,
      destination,
      { waypoints: waypoints.map((p) => new AMap.LngLat(p.lng, p.lat)) },
      (status: string, result: any) => {
        if (status !== 'complete') {
          const msg =
            status === 'no_data' ? '未找到可行驾车路线（可能无路网或距离过远）' : friendlyError(status, result)
          reject(new Error(msg))
          return
        }
        const route = result?.routes?.[0]
        if (!route) {
          reject(new Error('未找到可行驾车路线'))
          return
        }
        const path: [number, number][] = []
        for (const step of route.steps ?? []) {
          for (const p of step.path ?? []) {
            path.push([p.lng, p.lat])
          }
        }
        resolve({
          distanceM: Number(route.distance) || 0,
          durationS: Number(route.time) || 0,
          tolls: route.tolls != null ? Number(route.tolls) : null,
          legs: null, // JS API 驾车结果不提供按途经点的分段数据，分段用直线近似
          path,
        })
      },
    )
  })
}
