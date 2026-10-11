import type { MapProvider, Trip } from '../types'
import { gcj02ToWgs84 } from './coords'
import { cnOrdinal, dateOfDay, fmtDistance, fmtDuration } from './geo'
import { fmtClock, fmtStay, type DaySchedule } from './schedule'
import { KIND_META } from '../constants'

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** 文件名里去掉系统不允许的字符 */
export function safeFilename(name: string): string {
  return (name || '路书').replace(/[\\/:*?"<>|]+/g, ' ').trim() || '路书'
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * GPX 1.1：每个地点一个航点（wpt），每天一条轨迹（trk，取车行折线，未算出时用节点连线）。
 * GPX 标准坐标为 WGS-84；高德模式的 GCJ-02 坐标在这里转换。
 */
export function toGpx(trip: Trip, legPaths: Record<string, [number, number][]>, provider: MapProvider): string {
  const conv = (lng: number, lat: number): [number, number] => (provider === 'amap' ? gcj02ToWgs84(lng, lat) : [lng, lat])
  const pt = (lng: number, lat: number) => {
    const [x, y] = conv(lng, lat)
    return `lat="${y.toFixed(6)}" lon="${x.toFixed(6)}"`
  }
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="小鹿路书" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${xmlEscape(trip.title)}</name><time>${new Date().toISOString()}</time></metadata>`,
  ]
  trip.days.forEach((d, i) => {
    d.stops.forEach((s, j) => {
      if (j === 0 && s.fromPrev) return // 接续节点与前一天终点重复
      lines.push(
        `  <wpt ${pt(s.lng, s.lat)}><name>${xmlEscape(s.name)}</name>` +
          `<desc>${xmlEscape(`第${cnOrdinal(i + 1)}天 · ${KIND_META[s.kind]?.label ?? ''}${s.address ? ' · ' + s.address : ''}`)}</desc>` +
          `<type>${s.kind}</type></wpt>`,
      )
    })
  })
  trip.days.forEach((d, i) => {
    const path = legPaths[d.id]?.length ? legPaths[d.id] : d.stops.map((s) => [s.lng, s.lat] as [number, number])
    if (path.length < 2) return
    lines.push(`  <trk><name>${xmlEscape(`D${i + 1} ${d.stops[0].name} → ${d.stops[d.stops.length - 1].name}`)}</name><trkseg>`)
    for (const [lng, lat] of path) lines.push(`    <trkpt ${pt(lng, lat)}/>`)
    lines.push('  </trkseg></trk>')
  })
  lines.push('</gpx>')
  return lines.join('\n')
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** 当天分钟数（可超过 1440）→ ICS 本地时间（不带时区，按设备本地时间解释） */
function icsLocal(date: Date, minutes: number): string {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setMinutes(Math.round(minutes))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`
}

/** 每行不超过 75 字节的折行（RFC 5545），中文按 UTF-8 计算 */
function foldLine(line: string): string {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ch
    } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n ')
}

/**
 * ICS 日历：每天一个日程，从出发时间到预计到达；描述里列出各站到达时间与车程。
 * 车程未算出的天按 1 小时占位。
 */
export function toIcs(trip: Trip, schedules: Record<string, DaySchedule>, legDistances: Record<string, number[]>): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//lushu//roadbook//CN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEscape(trip.title)}`]
  trip.days.forEach((d, i) => {
    if (!d.stops.length) return
    const sc = schedules[d.id]
    const date = dateOfDay(trip.startDate, i)
    const start = sc?.departMin ?? 8 * 60
    const end = sc?.endMin ?? start + 60
    const first = d.stops[0].name
    const last = d.stops[d.stops.length - 1].name
    const desc: string[] = []
    d.stops.forEach((s, j) => {
      const t = j === 0 ? `${fmtClock(start)} 出发` : sc?.arrive[j] != null ? `${fmtClock(sc.arrive[j]!)} 到` : ''
      const stay = j > 0 && j < d.stops.length - 1 && s.stayMinutes ? `，停留 ${fmtStay(s.stayMinutes)}` : ''
      desc.push(`${j + 1}. ${s.name}${t ? '（' + t + stay + '）' : ''}`)
      const leg = legDistances[d.id]?.[j]
      if (j < d.stops.length - 1 && leg != null) desc.push(`   ↓ 车行 ${fmtDistance(leg)}`)
    })
    if (sc?.driveS) desc.push(`全天驾驶约 ${fmtDuration(sc.driveS)}${sc.distanceM ? '，' + fmtDistance(sc.distanceM) : ''}`)
    if (d.note) desc.push(d.note)
    lines.push(
      'BEGIN:VEVENT',
      `UID:${d.id}-${trip.id}@lushu`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocal(date, start)}`,
      `DTEND:${icsLocal(date, Math.max(end, start + 15))}`,
      foldLine(`SUMMARY:${icsEscape(`D${i + 1} ${first === last ? first : first + ' → ' + last}`)}`),
      foldLine(`LOCATION:${icsEscape(last)}`),
      foldLine(`DESCRIPTION:${icsEscape(desc.join('\n'))}`),
      'END:VEVENT',
    )
  })
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

export { ymd }
