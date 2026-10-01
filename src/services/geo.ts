import type { Day, Stop } from '../types'

/** 球面直线距离（km），用于时间轴按比例分摊驾驶时长 */
export function haversineKm(a: Pick<Stop, 'lng' | 'lat'>, b: Pick<Stop, 'lng' | 'lat'>): number {
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export function fmtDistance(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—'
  if (m < 1000) return `${Math.round(m)} 米`
  const km = m / 1000
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`
}

export function fmtDuration(s: number): string {
  const min = Math.round(s / 60)
  return fmtMinutes(min)
}

export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return '0 分钟'
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h === 0) return `${m} 分钟`
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

export function parseHM(s: string): number {
  const [h, m] = s.split(':').map((v) => parseInt(v, 10))
  return (Number.isFinite(h) ? h : 8) * 60 + (Number.isFinite(m) ? m : 0)
}

/** 分钟数 → HH:mm，超过 24 小时标注 +N 天 */
export function fmtClock(min: number): string {
  const day = Math.floor(min / 1440)
  const m = ((min % 1440) + 1440) % 1440
  const h = Math.floor(m / 60)
  const mm = Math.round(m % 60)
  const base = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  return day > 0 ? `${base} +${day}天` : base
}

/** 路线缓存键：版本 + 途经点序列坐标（5 位小数 ≈ 1m）+ 策略 + 数据源（不同源坐标系不同，不能混用缓存） */
export function hashPoints(points: Stop[], policy: string, provider: string): string {
  const pts = points.filter(Boolean).map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`)
  const str = 'v2|' + pts.join('|') + '#' + policy + '#' + provider
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return 'h' + (h >>> 0).toString(36)
}

export function dateOfDay(startDate: string, index: number): Date {
  const d = new Date((startDate || '2026-01-01') + 'T00:00:00')
  d.setDate(d.getDate() + index)
  return d
}

export function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd} 周${'日一二三四五六'[d.getDay()]}`
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
