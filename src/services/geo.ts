import type { Stop } from '../types'

/** 球面直线距离（km） */
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

/** 格式化车程预估时长（秒 → X小时Y分 / X分钟 / <1分钟） */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return ''
  const totalMins = Math.round(s / 60)
  if (totalMins < 1) return '<1分钟'
  if (totalMins < 60) return `${totalMins}分钟`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours < 24) {
    return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`
  }
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `${days}天${remainHours}小时` : `${days}天`
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

/** 从地址文本粗取城市名（第一个以「市」结尾的 2-4 字词，排除「市场」），取不到返回空串 */
export function cityOfAddress(address: string): string {
  if (!address) return ''
  for (const token of address.split(/[,，]/)) {
    const m = token.trim().match(/(?:^|[省区])([\u4e00-\u9fa5]{2,4}市)(?![场])/)
    if (m) return m[1]
  }
  const m = address.match(/(?:^|[省区])([\u4e00-\u9fa5]{2,4}市)(?![场])/)
  return m ? m[1] : ''
}

export function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 序数 → 中文数字（1-99），用于「第一天」等标签；超出范围回退阿拉伯数字 */
export function cnOrdinal(n: number): string {
  if (n <= 0 || n >= 100) return String(n)
  const tens = Math.floor(n / 10)
  const ones = n % 10
  const t = tens === 0 ? '' : tens === 1 ? '十' : `${CN_DIGITS[tens]}十`
  const o = ones === 0 ? '' : CN_DIGITS[ones]
  return t + o
}
