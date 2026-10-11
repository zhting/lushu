import type { MapProvider } from '../types'

export interface NavPoint {
  lng: number
  lat: number
  name: string
}

/** 当前路书坐标对应的坐标系：开源模式为 WGS-84，高德模式为 GCJ-02 */
function coordOf(provider: MapProvider): 'wgs84' | 'gcj02' {
  return provider === 'amap' ? 'gcj02' : 'wgs84'
}

function clean(name: string): string {
  // 名称中的分隔符会破坏 URI 参数结构
  return (name || '地点').replace(/[|,&]/g, ' ').trim()
}

/**
 * 高德地图 URI：手机上装了高德 App 时 callnative=1 会唤起 App，否则打开高德网页版。
 * 不传 from 时由高德以「我的位置」作为起点。
 */
export function amapNavUrl(from: NavPoint | null, to: NavPoint, provider: MapProvider): string {
  const p = new URLSearchParams()
  if (from) p.set('from', `${from.lng},${from.lat},${clean(from.name)}`)
  p.set('to', `${to.lng},${to.lat},${clean(to.name)}`)
  p.set('mode', 'car')
  p.set('policy', '1')
  p.set('src', 'lushu')
  p.set('coordinate', provider === 'amap' ? 'gaode' : 'wgs84')
  p.set('callnative', '1')
  return `https://uri.amap.com/navigation?${p.toString()}`
}

/** 百度地图 URI（网页版，装了百度地图 App 时浏览器会提示打开 App） */
export function baiduNavUrl(from: NavPoint | null, to: NavPoint, provider: MapProvider): string {
  const p = new URLSearchParams()
  if (from) p.set('origin', `latlng:${from.lat},${from.lng}|name:${clean(from.name)}`)
  p.set('destination', `latlng:${to.lat},${to.lng}|name:${clean(to.name)}`)
  p.set('mode', 'driving')
  p.set('coord_type', coordOf(provider))
  p.set('output', 'html')
  p.set('src', 'webapp.lushu')
  return `https://api.map.baidu.com/direction?${p.toString()}`
}
