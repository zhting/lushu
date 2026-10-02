import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Day, MapProvider, Poi, Stop, StopKind, StoredTrip, Trip } from '../types'
import * as mapSvc from '../services/map'
import { cnOrdinal, todayStr } from '../services/geo'
import { uid } from '../services/id'
import { DAY_COLORS, KIND_META } from '../constants'
import { SAMPLE_DAYS, SAMPLE_TITLE } from '../sample'
import { api } from '../services/api'

function emptyDay(): Day {
  return { id: uid('day'), departTime: '08:00', startAuto: true, stops: [], note: '' }
}

function mkStop(poi: Poi, kind: StopKind = 'waypoint'): Stop {
  return {
    id: uid('stop'),
    kind,
    name: poi.name,
    lng: poi.lng,
    lat: poi.lat,
    address: poi.address || poi.district || '',
    stayMinutes: 0,
    note: '',
  }
}

function defaultStay(kind: StopKind): number {
  return KIND_META[kind].stay
}

/** 旧结构（start/waypoints/end 三个槽位）→ 新结构（stops 有序列表） */
function migrateDay(d: any): Day {
  if (Array.isArray(d?.stops)) {
    return { id: d.id ?? uid('day'), departTime: d.departTime ?? '08:00', startAuto: !!d.startAuto, stops: d.stops ?? [], note: d.note ?? '' }
  }
  const stops: Stop[] = []
  if (d?.start) stops.push({ ...d.start })
  for (const w of d?.waypoints ?? []) stops.push({ ...w })
  if (d?.end) stops.push({ ...d.end })
  return { id: d.id ?? uid('day'), departTime: d.departTime ?? '08:00', startAuto: !!d.startAuto, stops, note: d.note ?? '' }
}

/** 旧模型里 startAuto 天的首节点是前一天终点的克隆，去掉与接续起点重复的节点 */
function migrateTrip(t: any): Trip {
  const days: Day[] = (t?.days ?? []).map(migrateDay)
  for (let i = 1; i < days.length; i++) {
    if (!days[i].startAuto) continue
    const prevLast = days[i - 1].stops[days[i - 1].stops.length - 1]
    const first = days[i].stops[0]
    if (prevLast && first && Math.abs(prevLast.lng - first.lng) < 5e-4 && Math.abs(prevLast.lat - first.lat) < 5e-4) {
      days[i].stops.splice(0, 1)
    }
  }
  return { ...t, id: t?.id ?? uid('trip'), days }
}

export const useTripStore = defineStore('trip', () => {
  // ───────────────────────── 基础状态 ─────────────────────────
  const trip = ref<Trip | null>(null)
  const currentId = ref<string | null>(null) // 当前打开的路书 id
  const page = ref<'home' | 'overview' | 'trip'>('home') // 首页（路书列表）/ 总览页 / 日程编辑
  const savedTrips = reactive<{ list: StoredTrip[] }>({ list: [] })
  const view = ref<string>('overview') // 'overview' | dayId
  const pickTarget = ref<{ dayId: string; stopId?: string } | null>(null) // 选点目标：带 stopId 为替换该节点位置
  const toast = ref<{ text: string; kind: 'info' | 'error' } | null>(null)
  const mapCfg = reactive<{ provider: MapProvider; key: string; securityJsCode: string }>({
    provider: 'osm',
    key: '',
    securityJsCode: '',
  })
  const hasAmapKey = ref(false) // 服务端是否已配置高德 Key
  const adminOpen = ref(false) // 管理后台页（仅管理员可见入口）
  const mapOpen = ref(false) // 移动端：地图按需全屏展开（桌面端地图常驻，不受影响）
  const pickerOpen = ref(false) // 「添加节点」全屏选点页：上搜索、背后地图
  const pickerResults = ref<Poi[]>([]) // 选点页当前搜索结果（同步为地图上的编号标记）
  const pickerCity = ref('') // 选点页限定的城市（'' = 不限），打开选点页间保持上次选择

  let toastTimer = 0
  function notify(text: string, kind: 'info' | 'error' = 'info') {
    toast.value = { text, kind }
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.value = null), 3500)
  }

  // ───────────────────────── 服务端数据加载 / 持久化 ─────────────────────────
  /** 登录后加载：服务端地图配置 + 当前用户的全部路书 */
  async function loadAll() {
    const cfg = await api.getConfig()
    mapCfg.key = cfg.amapKey || ''
    mapCfg.securityJsCode = cfg.amapSecurityJsCode || ''
    hasAmapKey.value = cfg.hasAmapKey
    const saved = localStorage.getItem('lushu.provider')
    mapCfg.provider =
      saved === 'amap' && cfg.hasAmapKey ? 'amap' : saved === 'osm' ? 'osm' : (cfg.defaultProvider as MapProvider)
    mapSvc.setProvider(mapCfg.provider)

    const data = await api.getTrips()
    savedTrips.list = (data.trips || [])
      .filter((e: any) => e?.trip?.days?.length)
      .map((e: any) => ({ ...e, trip: migrateTrip(e.trip) }))
  }

  /** 退出登录时清空会话内数据 */
  function reset() {
    trip.value = null
    currentId.value = null
    page.value = 'home'
    view.value = 'overview'
    savedTrips.list.splice(0)
    Object.keys(legDistances).forEach((k) => delete legDistances[k])
    Object.keys(legPaths).forEach((k) => delete legPaths[k])
    mapCfg.key = ''
    mapCfg.securityJsCode = ''
    mapCfg.provider = 'osm'
    hasAmapKey.value = false
    adminOpen.value = false
    pickerOpen.value = false
    pickerResults.value = []
    mapOpen.value = false
  }

  let saveTimer = 0
  function save() {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveNow, 400)
  }

  function saveNow() {
    const t = trip.value
    if (!t || !currentId.value) return
    const entry: StoredTrip = { id: currentId.value, savedAt: Date.now(), trip: t }
    const i = savedTrips.list.findIndex((e) => e.id === entry.id)
    if (i >= 0) savedTrips.list.splice(i, 1, entry)
    else savedTrips.list.unshift(entry)
    api.putTrip(entry).catch((e) => notify(e?.message || '保存到服务端失败', 'error'))
  }

  // ───────────────────────── 数据源管理（开源 OSM / 高德） ─────────────────────────

  /** 应用服务端下发的地图配置（管理后台保存后调用） */
  function applyServerConfig(cfg: { amapKey: string; amapSecurityJsCode: string; defaultProvider: string }) {
    mapCfg.key = cfg.amapKey || ''
    mapCfg.securityJsCode = cfg.amapSecurityJsCode || ''
    hasAmapKey.value = !!mapCfg.key
    if (mapCfg.provider === 'amap' && !hasAmapKey.value) {
      // 高德 Key 被移除：回退开源并重算
      applyProvider('osm', '', '')
      return
    }
    applyProvider(mapCfg.provider, mapCfg.key, mapCfg.securityJsCode)
  }

  /** 顶栏「数据源」：在开源 / 高德之间直接切换（高德需服务端已配置 Key） */
  function toggleProvider() {
    const next: MapProvider = mapCfg.provider === 'osm' ? 'amap' : 'osm'
    if (next === 'amap' && !hasAmapKey.value) {
      notify('管理员尚未在后台配置高德 Key，暂无法使用高德地图', 'error')
      return
    }
    applyProvider(next, mapCfg.key, mapCfg.securityJsCode)
  }

  /** 选择地图数据源。两种地图坐标系不同（WGS-84 / GCJ-02），切换后旧线路作废并全部重算。 */
  function applyProvider(provider: MapProvider, key = '', securityJsCode = '') {
    const changed = mapCfg.provider !== provider
    mapCfg.provider = provider
    mapCfg.key = key.trim()
    mapCfg.securityJsCode = securityJsCode.trim()
    localStorage.setItem('lushu.provider', provider)
    mapSvc.setProvider(provider)
    if (changed) {
      // 坐标系不同，旧的车行线路/距离不可混用
      Object.keys(legDistances).forEach((k) => delete legDistances[k])
      Object.keys(legPaths).forEach((k) => delete legPaths[k])
      notify(mapCfg.provider === 'osm' ? '已切换到开源地图（OpenStreetMap），线路将重新计算' : '已切换到高德地图，线路将重新计算')
    }
    retryLegs()
  }

  // ───────────────────────── 路书库（首页列表） ─────────────────────────
  const tripSummaries = computed(() =>
    savedTrips.list.map((e) => ({
      id: e.id,
      title: e.trip.title,
      startDate: e.trip.startDate,
      days: e.trip.days.length,
      savedAt: e.savedAt,
    })),
  )

  function openTrip(id: string) {
    const entry = savedTrips.list.find((e) => e.id === id)
    if (!entry) return
    trip.value = migrateTrip(entry.trip)
    currentId.value = id
    view.value = trip.value?.days[0]?.id ?? 'overview'
    page.value = 'trip'
    trip.value?.days.forEach((d) => touchLegs(d.id)) // 会话内重算各段距离（坐标对缓存命中则零请求）
    saveNow()
  }

  function goHome() {
    saveNow()
    page.value = 'home'
  }

  /** 顶栏「总览」：进入独立总览页（地图显示全部天） */
  function goOverview() {
    if (!trip.value) return
    view.value = 'overview'
    page.value = 'overview'
  }

  /** 从总览页返回日程列表，默认展开第一天 */
  function goDays() {
    if (!trip.value) return
    page.value = 'trip'
    view.value = trip.value.days[0]?.id ?? 'overview'
  }

  /** 顶栏「地图」：全屏查看整个路书（全部天）的路线，关闭后恢复之前展开的天 */
  const mapReturnView = ref<string | null>(null)

  function openMapOverview() {
    if (!trip.value) return
    if (view.value !== 'overview') mapReturnView.value = view.value
    view.value = 'overview'
    mapOpen.value = true
  }

  function closeMap() {
    mapOpen.value = false
    if (mapReturnView.value) {
      view.value = mapReturnView.value
      mapReturnView.value = null
    }
  }

  /** 每天标题上的地图图标：地图定位并展示该天路线 */
  function showDayOnMap(dayId: string) {
    if (!findDay(dayId)) return
    view.value = dayId
    mapOpen.value = true
  }

  function deleteTrip(id: string) {
    const i = savedTrips.list.findIndex((e) => e.id === id)
    if (i < 0) return
    const title = savedTrips.list[i].trip.title
    if (!window.confirm(`删除「${title}」？此操作不可恢复。`)) return
    savedTrips.list.splice(i, 1)
    api.deleteTrip(id).catch((e) => notify(e?.message || '服务端删除失败', 'error'))
    if (currentId.value === id) {
      trip.value = null
      currentId.value = null
      page.value = 'home'
    }
  }

  function deleteCurrentTrip() {
    if (currentId.value) deleteTrip(currentId.value)
    else page.value = 'home'
  }

  // ───────────────────────── 天与地点（纯顺序结构） ─────────────────────────

  function findDay(dayId: string): Day | undefined {
    return trip.value?.days.find((d) => d.id === dayId)
  }

  function dayIndex(dayId: string): number {
    return trip.value?.days.findIndex((d) => d.id === dayId) ?? -1
  }

  /**
   * 当天参与绘图/接续的点序列。
   * 次日（startAuto）默认从前一天最后一个地点出发，因此会把 prevLast 拼在最前面。
   */
  function routePoints(day: Day): Stop[] {
    const i = dayIndex(day.id)
    if (i > 0 && day.startAuto) {
      const prev = trip.value?.days[i - 1]
      const prevLast = prev?.stops[prev.stops.length - 1]
      if (prevLast) return [prevLast, ...day.stops]
    }
    return day.stops
  }

  function routePointsOf(dayId: string): Stop[] {
    const day = findDay(dayId)
    return day ? routePoints(day) : []
  }

  /** 首节点是否来自前一天的终点 */
  function originFromPrev(day: Day): boolean {
    const seq = routePoints(day)
    return seq.length > 0 && seq[0] !== day.stops[0]
  }

  // ───────────────────────── 相邻节点车行距离与线路 ─────────────────────────
  /** key = dayId，值 = 相邻节点间车行距离（与 routePointsOf 序列一一对应，长度 = 点数-1）；拉取失败不写入 */
  const legDistances = reactive<Record<string, number[]>>({})
  /** key = dayId，值 = 该天逐段车行线路拼接后的折线（地图绘制用） */
  const legPaths = reactive<Record<string, [number, number][]>>({})
  const legTimers: Record<string, number> = {}
  const legSeq: Record<string, number> = {}

  function nextDayId(dayId: string): string | null {
    const next = trip.value?.days[dayIndex(dayId) + 1]
    return next?.id ?? null
  }

  /** 节点变化后防抖拉取本天各段车行线路 */
  function touchLegs(dayId: string | null) {
    if (!dayId || !findDay(dayId)) return
    window.clearTimeout(legTimers[dayId])
    legTimers[dayId] = window.setTimeout(() => void calcLegs(dayId), 600)
  }

  async function calcLegs(dayId: string) {
    const pts = routePointsOf(dayId)
    const seqId = (legSeq[dayId] ?? 0) + 1
    legSeq[dayId] = seqId
    if (pts.length < 2) {
      delete legDistances[dayId]
      delete legPaths[dayId]
      return
    }
    const dists: number[] = []
    const path: [number, number][] = []
    try {
      for (let i = 1; i < pts.length; i++) {
        // 逐段顺序请求并留出间隔，避免触发公共服务的频率限制；单段失败重试一次
        if (i > 1) await new Promise((r) => setTimeout(r, 400))
        let r: { distanceM: number; path: [number, number][] }
        try {
          r = await mapSvc.legRoute(pts[i - 1], pts[i], mapCfg.key, mapCfg.securityJsCode)
        } catch {
          await new Promise((r2) => setTimeout(r2, 900))
          r = await mapSvc.legRoute(pts[i - 1], pts[i], mapCfg.key, mapCfg.securityJsCode)
        }
        if (legSeq[dayId] !== seqId) return // 期间又被编辑，丢弃过期结果
        dists.push(r.distanceM)
        path.push(...r.path)
      }
    } catch {
      if (legSeq[dayId] !== seqId) return
      delete legDistances[dayId] // 重试后仍失败：距离回退直线、地图回退虚线
      delete legPaths[dayId]
      return
    }
    if (legSeq[dayId] !== seqId) return
    legDistances[dayId] = dists
    legPaths[dayId] = path
    save()
  }

  /** 重新拉取当前行程所有天的车行线路（数据源切换 / 地图库就绪后调用；坐标对缓存命中则零请求） */
  function retryLegs() {
    trip.value?.days.forEach((d) => touchLegs(d.id))
  }

  // ───────────────────────── 行程 / 日程编辑 ─────────────────────────
  function createTrip(title: string, startDate: string, dayCount: number) {
    const t: Trip = {
      id: uid('trip'),
      title: title.trim() || '未命名行程',
      startDate: startDate || todayStr(),
      days: Array.from({ length: Math.max(1, Math.min(30, dayCount)) }, emptyDay),
    }
    trip.value = t
    currentId.value = t.id
    view.value = t.days[0].id
    page.value = 'trip'
    saveNow()
  }

  function loadSample() {
    createTrip(SAMPLE_TITLE, todayStr(), SAMPLE_DAYS.length)
    const days = trip.value!.days
    SAMPLE_DAYS.forEach((sd, i) => {
      const day = days[i]
      day.departTime = sd.departTime
      const stops: Stop[] = []
      if (i === 0 && sd.start) stops.push(mkStop(sd.start, 'waypoint'))
      for (const wp of sd.waypoints ?? []) {
        const s = mkStop(wp, wp.kind ?? 'scenic')
        s.stayMinutes = wp.stay ?? defaultStay(s.kind)
        stops.push(s)
      }
      if (sd.end) stops.push(mkStop(sd.end, 'hotel'))
      day.stops = stops
    })
    view.value = days[0].id
    trip.value?.days.forEach((d) => touchLegs(d.id))
    saveNow()
  }

  function setTitle(t: string) {
    if (trip.value) {
      trip.value.title = t
      save()
    }
  }

  function setStartDate(d: string) {
    if (trip.value) {
      trip.value.startDate = d
      save()
    }
  }

  function setDayCount(n: number) {
    const t = trip.value
    if (!t) return
    n = Math.max(1, Math.min(30, Math.round(n)))
    if (n === t.days.length) return
    if (n < t.days.length) {
      const removeCount = t.days.length - n
      if (!window.confirm(`将删除最后 ${removeCount} 天的日程及其全部地点，确定？`)) return
      t.days.splice(n)
    } else {
      while (t.days.length < n) t.days.push(emptyDay())
    }
    if (!t.days.some((d) => d.id === view.value)) view.value = t.days[0]?.id ?? 'overview'
    t.days.forEach((d) => touchLegs(d.id))
    saveNow()
  }

  /** 删除单独一天（至少保留一天） */
  function deleteDay(dayId: string) {
    const t = trip.value
    if (!t) return
    if (t.days.length <= 1) {
      notify('至少保留一天', 'error')
      return
    }
    const i = t.days.findIndex((d) => d.id === dayId)
    if (i < 0) return
    if (!window.confirm(`删除第${cnOrdinal(i + 1)}天及其全部地点？`)) return
    t.days.splice(i, 1)
    if (view.value === dayId) view.value = t.days[Math.min(i, t.days.length - 1)].id
    t.days.forEach((d) => touchLegs(d.id))
    saveNow()
  }

  // ── 节点（每天一个有序列表，无固定起点/终点，不设数量上限） ──
  function addStop(dayId: string, poi: Poi, kind: StopKind = 'waypoint'): boolean {
    const day = findDay(dayId)
    if (!day) return false
    const s = mkStop(poi, kind)
    s.stayMinutes = defaultStay(kind)
    day.stops.push(s)
    touchLegs(dayId)
    save()
    return true
  }

  function removeStop(dayId: string, stopId: string) {
    const day = findDay(dayId)
    if (!day) return
    const idx = day.stops.findIndex((s) => s.id === stopId)
    if (idx < 0) return
    day.stops.splice(idx, 1)
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
    save()
  }

  function moveStop(dayId: string, from: number, to: number) {
    const day = findDay(dayId)
    if (!day) return
    if (from < 0 || to < 0 || from >= day.stops.length || to >= day.stops.length || from === to) return
    const [s] = day.stops.splice(from, 1)
    day.stops.splice(to, 0, s)
    touchLegs(dayId)
    save()
  }

  /** 拖拽排序：vuedraggable 已直接修改数组，这里只负责刷新距离与保存 */
  function reorderStops(dayId: string) {
    touchLegs(dayId)
    save()
  }

  /** 更换已有节点的地点（保留类型/停留设置） */
  function updateStopPlace(dayId: string, stopId: string, poi: Poi) {
    const day = findDay(dayId)
    const s = day?.stops.find((w) => w.id === stopId)
    if (!s) return
    s.name = poi.name
    s.lng = poi.lng
    s.lat = poi.lat
    s.address = poi.address || poi.district || ''
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
    save()
  }

  /** 重命名节点 */
  function setStopName(dayId: string, stopId: string, name: string) {
    const day = findDay(dayId)
    const s = day?.stops.find((w) => w.id === stopId)
    const trimmed = name.trim()
    if (s && trimmed) {
      s.name = trimmed
      save()
    }
  }

  function setStay(dayId: string, stopId: string, minutes: number) {
    const day = findDay(dayId)
    const s = day?.stops.find((w) => w.id === stopId)
    if (s) {
      s.stayMinutes = Math.max(0, Math.min(1440, Math.round(minutes) || 0))
      save()
    }
  }

  function setStopKind(dayId: string, stopId: string, kind: StopKind) {
    const day = findDay(dayId)
    const s = day?.stops.find((w) => w.id === stopId)
    if (!s) return
    s.kind = kind
    if (s.stayMinutes === 0 && defaultStay(kind) > 0) s.stayMinutes = defaultStay(kind)
    save()
  }

  /** 切换“从前一天终点出发 / 从本日第一个地点出发”（仅 i>0 的天） */
  function toggleStartAuto(dayId: string) {
    const day = findDay(dayId)
    const i = dayIndex(dayId)
    if (!day || i <= 0) return
    day.startAuto = !day.startAuto
    touchLegs(dayId)
    save()
  }

  /** 地图点选落点（点击地图任意位置，逆地理命名）：新增节点或替换节点位置 */
  function applyPicked(target: { dayId: string; stopId?: string }, poi: Poi) {
    if (target.stopId) {
      // 替换位置：保留节点名称，仅更新坐标与地址
      const s = findDay(target.dayId)?.stops.find((w) => w.id === target.stopId)
      if (s) {
        s.lng = poi.lng
        s.lat = poi.lat
        s.address = poi.address || poi.district || ''
        touchLegs(target.dayId)
        save()
      }
    } else {
      addStop(target.dayId, poi)
    }
    closePicker()
  }

  // ───────────────────────── 添加 / 修改节点（全屏选点页） ─────────────────────────
  function openPicker(dayId: string) {
    pickTarget.value = { dayId }
    pickerResults.value = []
    pickerOpen.value = true
    mapOpen.value = true // 移动端同时展开地图；桌面端此值无副作用
  }

  /** 修改节点：全屏选点页上同时编辑名称/类型/停留，并在地图上选新位置替换 */
  function openStopEditor(dayId: string, stopId: string) {
    pickTarget.value = { dayId, stopId }
    pickerResults.value = []
    pickerOpen.value = true
    mapOpen.value = true
  }

  function closePicker() {
    pickerOpen.value = false
    pickerResults.value = []
    pickTarget.value = null
    mapOpen.value = false
  }

  /** 点击地图上的搜索结果标记（或结果列表项）：新增节点或替换节点位置 */
  function pickSearchResult(poi: Poi) {
    const t = pickTarget.value
    if (!pickerOpen.value || !t) return
    if (t.stopId) updateStopPlace(t.dayId, t.stopId, poi)
    else addStop(t.dayId, poi)
    closePicker()
  }

  // ───────────────────────── 统计 ─────────────────────────
  const dayStats = computed(() => {
    const t = trip.value
    if (!t) return []
    return t.days.map((d, i) => ({
      index: i,
      day: d,
      color: DAY_COLORS[i % DAY_COLORS.length],
    }))
  })

  // ───────────────────────── 导入 / 导出 ─────────────────────────
  function exportJson(): string {
    return JSON.stringify({ version: 3, exportedAt: new Date().toISOString(), trip: trip.value })
  }

  /** 导入：作为新路程加入路书库并打开 */
  function importJson(text: string) {
    const data = JSON.parse(text)
    const t = data?.trip
    if (!t || !Array.isArray(t.days) || !t.days.length) throw new Error('文件格式不正确：缺少 trip.days')
    const id = typeof t.id === 'string' && t.id && !savedTrips.list.some((e) => e.id === t.id) ? t.id : uid('trip')
    trip.value = migrateTrip({ ...t, id })
    currentId.value = id
    view.value = trip.value?.days[0]?.id ?? 'overview'
    page.value = 'trip'
    trip.value?.days.forEach((d) => touchLegs(d.id))
    saveNow()
  }

  return {
    trip, currentId, page, savedTrips, view, pickTarget, toast, mapCfg, hasAmapKey, adminOpen, mapOpen, pickerOpen, pickerResults, pickerCity, legDistances, legPaths,
    tripSummaries,
    init: loadAll, notify, save, saveNow, reset,
    applyProvider, applyServerConfig, toggleProvider, retryLegs,
    createTrip, loadSample, openTrip, goHome, goOverview, goDays, openMapOverview, closeMap, showDayOnMap, deleteTrip, deleteCurrentTrip,
    setTitle, setStartDate, setDayCount, deleteDay,
    addStop, removeStop, moveStop, reorderStops, updateStopPlace, setStopName, setStay, setStopKind, toggleStartAuto, applyPicked,
    openPicker, openStopEditor, closePicker, pickSearchResult,
    routePointsOf, originFromPrev,
    dayStats,
    exportJson, importJson,
  }
})
