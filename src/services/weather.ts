/**
 * 天气预报：Open-Meteo（免 Key，全球覆盖，最长 16 天逐日预报）。
 * 高德模式的 GCJ-02 坐标与 WGS-84 只差几百米，对城市级天气没有影响，直接使用。
 */

export interface DayWeather {
  date: string // yyyy-mm-dd
  code: number // WMO 天气代码
  text: string
  icon: string
  tMax: number
  tMin: number
  precipProb: number | null // 最大降水概率 %
}

/** 预报可覆盖的天数（含今天） */
export const FORECAST_DAYS = 16

/** WMO 天气代码 → 中文描述与图标 */
export function describeWeather(code: number): { text: string; icon: string } {
  if (code === 0) return { text: '晴', icon: '☀️' }
  if (code === 1) return { text: '晴间多云', icon: '🌤️' }
  if (code === 2) return { text: '多云', icon: '⛅' }
  if (code === 3) return { text: '阴', icon: '☁️' }
  if (code === 45 || code === 48) return { text: '雾', icon: '🌫️' }
  if (code >= 51 && code <= 57) return { text: '毛毛雨', icon: '🌦️' }
  if (code === 61 || code === 80) return { text: '小雨', icon: '🌦️' }
  if (code === 63 || code === 81) return { text: '中雨', icon: '🌧️' }
  if (code === 65 || code === 82) return { text: '大雨', icon: '🌧️' }
  if (code === 66 || code === 67) return { text: '冻雨', icon: '🌧️' }
  if (code === 71 || code === 85) return { text: '小雪', icon: '🌨️' }
  if (code === 73) return { text: '中雪', icon: '🌨️' }
  if (code === 75 || code === 86) return { text: '大雪', icon: '❄️' }
  if (code === 77) return { text: '米雪', icon: '🌨️' }
  if (code >= 95) return { text: '雷阵雨', icon: '⛈️' }
  return { text: '—', icon: '🌡️' }
}

/** 是否属于需要提醒的天气（雨雪雾雷） */
export function isBadWeather(code: number): boolean {
  return code === 45 || code === 48 || code >= 61
}

/** 拉取某地一段日期的逐日预报；日期须在今天起 16 天内 */
export async function fetchForecast(lat: number, lng: number, startDate: string, endDate: string): Promise<DayWeather[]> {
  const p = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Shanghai',
    start_date: startDate,
    end_date: endDate,
  })
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p.toString()}`)
  if (!res.ok) throw new Error(`天气服务请求失败（HTTP ${res.status}）`)
  const data = await res.json()
  const d = data?.daily
  if (!d?.time) return []
  return (d.time as string[]).map((date, i) => {
    const code = Number(d.weather_code?.[i] ?? -1)
    const { text, icon } = describeWeather(code)
    const pp = d.precipitation_probability_max?.[i]
    return {
      date,
      code,
      text,
      icon,
      tMax: Math.round(Number(d.temperature_2m_max?.[i])),
      tMin: Math.round(Number(d.temperature_2m_min?.[i])),
      precipProb: pp == null ? null : Math.round(Number(pp)),
    }
  })
}
