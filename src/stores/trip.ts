import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Day, EnergyType, MapProvider, Poi, Stop, StopKind, StoredTrip, Trip, Vehicle } from '../types'
import * as mapSvc from '../services/map'
import { cnOrdinal, dateOfDay, todayStr } from '../services/geo'
import { fetchForecast, FORECAST_DAYS, type DayWeather } from '../services/weather'
import { ymd } from '../services/exporters'
import { uid } from '../services/id'
import { DAY_COLORS, KIND_META, VEHICLE_DEFAULTS } from '../constants'
import { daySchedule, energyCost, parseClock, type DaySchedule } from '../services/schedule'
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

function mkContinuedStop(prevLast: Stop): Stop {
  return {
    id: uid('stop'),
    kind: prevLast.kind,
    name: prevLast.name,
    lng: prevLast.lng,
    lat: prevLast.lat,
    address: prevLast.address,
    stayMinutes: 0,
    note: '',
    fromPrev: true,
  }
}

/** 确保所有启用接续出发的次日，真实拥有并同步前一天最后的节点作为出发节点 */
function syncContinuationStops(t: Trip | null): boolean {
  if (!t || !t.days || !t.days.length) return false
  let changed = false

  // 第一天绝对不可能从前一天接续，若首节点误带 fromPrev 则坚决清除。
  // 必须放在单天判断之前：删到只剩一天时，原第二天的接续节点也要清掉。
  if (t.days[0]?.stops[0]?.fromPrev) {
    t.days[0].stops.shift()
    changed = true
  }
  if (t.days.length <= 1) return changed

  for (let i = 1; i < t.days.length; i++) {
    const curr = t.days[i]
    const prev = t.days[i - 1]
    const prevLast = prev.stops.length > 0 ? prev.stops[prev.stops.length - 1] : null

    if (curr.startAuto) {
      if (prevLast) {
        const first = curr.stops[0]
        if (!first) {
          curr.stops.push(mkContinuedStop(prevLast))
          changed = true
        } else if (first.fromPrev) {
          if (
            first.name !== prevLast.name ||
            first.lng !== prevLast.lng ||
            first.lat !== prevLast.lat ||
            first.address !== prevLast.address ||
            first.kind !== prevLast.kind
          ) {
            first.name = prevLast.name
            first.lng = prevLast.lng
            first.lat = prevLast.lat
            first.address = prevLast.address
            first.kind = prevLast.kind
            changed = true
          }
        } else {
          const isSameLoc =
            Math.abs(prevLast.lng - first.lng) < 5e-4 && Math.abs(prevLast.lat - first.lat) < 5e-4
          if (isSameLoc) {
            first.fromPrev = true
          } else {
            curr.stops.unshift(mkContinuedStop(prevLast))
            changed = true
          }
        }
      } else {
        if (curr.stops[0]?.fromPrev) {
          curr.stops.shift()
          changed = true
        }
      }
    } else {
      if (curr.stops[0]?.fromPrev) {
        curr.stops.shift()
        changed = true
      }
    }
  }
  return changed
}

/** 迁移路书数据，并确保多天接续出发节点实体化同步 */
function migrateTrip(t: any): Trip {
  const days: Day[] = (t?.days ?? []).map(migrateDay)
  const res: Trip = { ...t, id: t?.id ?? uid('trip'), days }
  syncContinuationStops(res)
  return res
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
  const pickerKind = ref<StopKind>('waypoint') // 选点页新增节点时选定的类型
  // 分享视频：总览/弹窗发起「为分享录制」→ 地图组件录制 → 录完交回给分享弹窗上传
  const shareRecordSeq = ref(0)
  const recordingForShare = ref(false)
  const pendingShareVideo = shallowRef<Blob | null>(null)

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
    // 地图引擎由系统管理员在后台统一确定，移除用户本地覆盖
    try {
      localStorage.removeItem('lushu.provider')
    } catch {}
    mapCfg.provider = (cfg.defaultProvider as MapProvider) || 'osm'
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
    Object.keys(legDurations).forEach((k) => delete legDurations[k])
    Object.keys(legTolls).forEach((k) => delete legTolls[k])
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

  // ───────────────────────── 数据源管理（开源 OSM / 高德，管理员统一指定） ─────────────────────────

  /** 应用服务端下发的地图配置（管理后台保存后调用） */
  function applyServerConfig(cfg: { amapKey: string; amapSecurityJsCode: string; defaultProvider: string }) {
    mapCfg.key = cfg.amapKey || ''
    mapCfg.securityJsCode = cfg.amapSecurityJsCode || ''
    hasAmapKey.value = !!mapCfg.key
    const targetProvider: MapProvider =
      cfg.defaultProvider === 'amap' && hasAmapKey.value ? 'amap' : 'osm'
    applyProvider(targetProvider, mapCfg.key, mapCfg.securityJsCode)
  }

  /** 选择地图数据源。两种地图坐标系不同（WGS-84 / GCJ-02），切换后旧线路作废并全部重算。 */
  function applyProvider(provider: MapProvider, key = '', securityJsCode = '') {
    const changed = mapCfg.provider !== provider
    mapCfg.provider = provider
    mapCfg.key = key.trim()
    mapCfg.securityJsCode = securityJsCode.trim()
    mapSvc.setProvider(provider)
    if (changed) {
      // 坐标系不同，旧的车行线路/距离不可混用
      Object.keys(legDistances).forEach((k) => delete legDistances[k])
      Object.keys(legDurations).forEach((k) => delete legDurations[k])
      Object.keys(legTolls).forEach((k) => delete legTolls[k])
      Object.keys(legPaths).forEach((k) => delete legPaths[k])
      notify(mapCfg.provider === 'osm' ? '全站已切换到开源地图（OpenStreetMap），线路重新规划中' : '全站已切换到高德地图，线路重新规划中')
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
    mapOpen.value = false
    mapReturnView.value = null
    view.value = trip.value?.days[0]?.id ?? 'overview'
    page.value = 'trip'
    trip.value?.days.forEach((d) => touchLegs(d.id)) // 会话内重算各段距离（坐标对缓存命中则零请求）
    saveNow()
  }

  function goHome() {
    saveNow()
    mapOpen.value = false
    page.value = 'home'
  }

  /** 顶栏「总览」：进入独立总览页（地图显示全部天） */
  function goOverview() {
    if (!trip.value) return
    mapOpen.value = false
    mapReturnView.value = null
    view.value = 'overview'
    page.value = 'overview'
  }

  /** 从总览页或地图页返回日程列表，恢复或默认展开第一天 */
  function goDays() {
    if (!trip.value) return
    const restoreView = mapReturnView.value
    mapOpen.value = false
    mapReturnView.value = null
    page.value = 'trip'
    if (restoreView && trip.value.days.some((d) => d.id === restoreView)) {
      view.value = restoreView
    } else if (!view.value || view.value === 'overview' || !trip.value.days.some((d) => d.id === view.value)) {
      view.value = trip.value.days[0]?.id ?? 'overview'
    }
  }

  /** 顶栏「地图」：查看整个路书（全部天）的纯地图视图，关闭或切换 Tab 后恢复之前展开的天 */
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
   * 次日（startAuto）默认在 stops[0] 保存前一天最后节点作为真实实体节点。
   */
  function routePoints(day: Day): Stop[] {
    return day.stops
  }

  function routePointsOf(dayId: string): Stop[] {
    const day = findDay(dayId)
    return day ? routePoints(day) : []
  }

  /** 首节点是否来自前一天的终点 */
  function originFromPrev(day: Day): boolean {
    return !!(day.startAuto && day.stops[0]?.fromPrev)
  }

  // ───────────────────────── 相邻节点车行距离与线路 ─────────────────────────
  /** key = dayId，值 = 相邻节点间车行距离（与 routePointsOf 序列一一对应，长度 = 点数-1）；拉取失败不写入 */
  const legDistances = reactive<Record<string, number[]>>({})
  /** key = dayId，值 = 相邻节点间车行预估时长（单位：秒，与 routePointsOf 序列一一对应）；拉取失败不写入 */
  const legDurations = reactive<Record<string, number[]>>({})
  /** key = dayId，值 = 相邻节点间过路费（元）；数据源不提供时该段为 null */
  const legTolls = reactive<Record<string, (number | null)[]>>({})
  /** key = dayId，值 = true 表示该天线路重试后仍未算出（界面据此区分「计算中」与「未算出」） */
  const legFailed = reactive<Record<string, boolean>>({})
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
    delete legFailed[dayId]
    if (pts.length < 2) {
      delete legDistances[dayId]
      delete legDurations[dayId]
      delete legTolls[dayId]
      delete legPaths[dayId]
      return
    }
    const dists: number[] = []
    const durations: number[] = []
    const tolls: (number | null)[] = []
    const path: [number, number][] = []
    try {
      for (let i = 1; i < pts.length; i++) {
        // 逐段顺序请求并留出间隔，避免触发公共服务的频率限制；单段失败重试一次
        if (i > 1) await new Promise((r) => setTimeout(r, 400))
        let r: Awaited<ReturnType<typeof mapSvc.legRoute>>
        try {
          r = await mapSvc.legRoute(pts[i - 1], pts[i], mapCfg.key, mapCfg.securityJsCode)
        } catch {
          await new Promise((r2) => setTimeout(r2, 900))
          r = await mapSvc.legRoute(pts[i - 1], pts[i], mapCfg.key, mapCfg.securityJsCode)
        }
        if (legSeq[dayId] !== seqId) return // 期间又被编辑，丢弃过期结果
        dists.push(r.distanceM)
        durations.push(r.durationS)
        tolls.push(r.tollsYuan)
        path.push(...r.path)
      }
    } catch {
      if (legSeq[dayId] !== seqId) return
      legFailed[dayId] = true
      delete legDistances[dayId] // 重试后仍失败：距离回退直线、地图回退虚线
      delete legDurations[dayId]
      delete legTolls[dayId]
      delete legPaths[dayId]
      return
    }
    if (legSeq[dayId] !== seqId) return
    legDistances[dayId] = dists
    legDurations[dayId] = durations
    legTolls[dayId] = tolls
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
      if (i === 0 && sd.start) stops.push(mkStop(sd.start, sd.start.kind ?? 'waypoint'))
      for (const wp of sd.waypoints ?? []) {
        const s = mkStop(wp, wp.kind ?? 'scenic')
        s.stayMinutes = wp.stay ?? defaultStay(s.kind)
        stops.push(s)
      }
      if (sd.end) stops.push(mkStop(sd.end, sd.end.kind ?? 'hotel'))
      day.stops = stops
    })
    // 次日的接续出发节点要先实体化，否则线路按缺少首节点的序列计算，之后一同步就对不上
    syncContinuationStops(trip.value)
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
    syncContinuationStops(t)
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
    syncContinuationStops(t)
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
    if (trip.value) syncContinuationStops(trip.value)
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
    save()
    return true
  }

  /** 在指定位置插入节点（沿途补给加入当天用）；index 越界时追加到末尾 */
  function insertStop(dayId: string, poi: Poi, kind: StopKind, index: number): boolean {
    const day = findDay(dayId)
    if (!day) return false
    const s = mkStop(poi, kind)
    s.stayMinutes = defaultStay(kind)
    // 不能插到接续出发节点之前
    const minIdx = day.stops[0]?.fromPrev ? 1 : 0
    const at = Math.max(minIdx, Math.min(day.stops.length, Math.round(index)))
    day.stops.splice(at, 0, s)
    if (trip.value) syncContinuationStops(trip.value)
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
    save()
    return true
  }

  function removeStop(dayId: string, stopId: string) {
    const day = findDay(dayId)
    if (!day) return
    const idx = day.stops.findIndex((s) => s.id === stopId)
    if (idx < 0) return
    const isContinuationNode = idx === 0 && day.stops[0].fromPrev
    day.stops.splice(idx, 1)
    if (isContinuationNode) {
      // 用户主动删除了复制过来的接续出发节点，切换为从本日第一地出发
      day.startAuto = false
    }
    if (trip.value) syncContinuationStops(trip.value)
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
    if (trip.value) syncContinuationStops(trip.value)
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
    save()
  }

  /** 拖拽排序天数：vuedraggable 已直接修改 trip.days 数组 */
  function reorderDays() {
    const t = trip.value
    if (!t) return
    // 天数顺序变动后，各天的出发接续关系相应更新
    syncContinuationStops(t)
    t.days.forEach((d) => touchLegs(d.id))
    save()
  }

  /** 拖拽排序节点：vuedraggable 已直接修改 day.stops 数组，这里负责接续保护与刷新线路 */
  function reorderStops(dayId: string) {
    const day = findDay(dayId)
    if (!day) return
    if (day.stops.length > 0) {
      if (!day.stops[0].fromPrev) {
        let hasDetached = false
        day.stops.forEach((s) => {
          if (s.fromPrev) {
            s.fromPrev = false
            hasDetached = true
          }
        })
        if (hasDetached) {
          day.startAuto = false
        }
      }
    }
    if (trip.value) syncContinuationStops(trip.value)
    touchLegs(dayId)
    touchLegs(nextDayId(dayId))
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
    if (s.fromPrev) s.fromPrev = false
    if (trip.value) syncContinuationStops(trip.value)
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
      if (s.fromPrev) s.fromPrev = false
      if (trip.value && syncContinuationStops(trip.value)) retryLegs()
      touchLegs(nextDayId(dayId))
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
    if (s.fromPrev) s.fromPrev = false
    // 同步若增删了接续节点，节点序列变了，线路要重算（坐标对缓存命中则零请求）
    if (trip.value && syncContinuationStops(trip.value)) retryLegs()
    save()
  }

  /** 切换“从前一天终点出发 / 从本日第一个地点出发”（仅 i>0 的天） */
  function toggleStartAuto(dayId: string) {
    const day = findDay(dayId)
    const i = dayIndex(dayId)
    if (!day || i <= 0 || !trip.value) return
    day.startAuto = !day.startAuto
    syncContinuationStops(trip.value)
    touchLegs(dayId)
    save()
  }

  /** 设置当天出发时间（'HH:mm'） */
  function setDepartTime(dayId: string, hhmm: string) {
    const day = findDay(dayId)
    if (!day || parseClock(hhmm) == null) return
    day.departTime = hhmm
    save()
  }

  // ───────────────────────── 车辆与费用 ─────────────────────────
  /** 当前路书的车辆能耗设置（旧路书没有该字段时用默认燃油车） */
  const vehicle = computed<Vehicle>(() => trip.value?.vehicle ?? VEHICLE_DEFAULTS.fuel)

  /** 切换能源类型时整体换成该类型的默认值；改数值时只改对应字段 */
  function setVehicle(patch: { energy?: EnergyType; consumption?: number; price?: number }) {
    const t = trip.value
    if (!t) return
    let v: Vehicle = { ...vehicle.value }
    if (patch.energy && patch.energy !== v.energy) v = { ...VEHICLE_DEFAULTS[patch.energy] }
    if (patch.consumption != null && Number.isFinite(patch.consumption)) v.consumption = Math.max(0, Math.min(100, patch.consumption))
    if (patch.price != null && Number.isFinite(patch.price)) v.price = Math.max(0, Math.min(100, patch.price))
    t.vehicle = v
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
        if (s.fromPrev) s.fromPrev = false
        if (trip.value) syncContinuationStops(trip.value)
        touchLegs(target.dayId)
        touchLegs(nextDayId(target.dayId))
        save()
      }
    } else {
      addStop(target.dayId, poi, pickerKind.value)
    }
    closePicker()
  }

  // ───────────────────────── 添加 / 修改节点（全屏选点页） ─────────────────────────
  function openPicker(dayId: string) {
    pickTarget.value = { dayId }
    pickerKind.value = 'waypoint'
    pickerResults.value = []
    pickerOpen.value = true
  }

  /** 修改节点：全屏选点页上同时编辑名称/类型/停留，并在地图上选新位置替换 */
  function openStopEditor(dayId: string, stopId: string) {
    pickTarget.value = { dayId, stopId }
    pickerResults.value = []
    pickerOpen.value = true
  }

  function closePicker() {
    pickerOpen.value = false
    pickerResults.value = []
    pickTarget.value = null
  }

  /** 点击地图上的搜索结果标记（或结果列表项）：新增节点或替换节点位置 */
  function pickSearchResult(poi: Poi) {
    const t = pickTarget.value
    if (!pickerOpen.value || !t) return
    if (t.stopId) updateStopPlace(t.dayId, t.stopId, poi)
    else addStop(t.dayId, poi, pickerKind.value)
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

  /** 每天的时间表与里程（key = dayId） */
  const schedules = computed<Record<string, DaySchedule>>(() => {
    const out: Record<string, DaySchedule> = {}
    for (const d of trip.value?.days ?? []) {
      out[d.id] = daySchedule(d, legDistances[d.id], legDurations[d.id], legTolls[d.id])
    }
    return out
  })

  /** 单日费用：能耗费按里程估算；过路费仅高德模式可得 */
  function dayCost(dayId: string): { energy: number | null; tolls: number | null } {
    const sc = schedules.value[dayId]
    if (!sc) return { energy: null, tolls: null }
    return {
      energy: sc.distanceM == null ? null : energyCost(sc.distanceM, vehicle.value),
      tolls: sc.tollsYuan,
    }
  }

  /** 全程合计；pendingDays 为有 ≥2 个地点但线路尚未算出的天数（合计不含这些天） */
  const tripTotals = computed(() => {
    let distanceM = 0
    let driveS = 0
    let tolls = 0
    let tollsUnknownDays = 0
    let pendingDays = 0
    for (const d of trip.value?.days ?? []) {
      const sc = schedules.value[d.id]
      if (!sc) continue
      if (sc.distanceM == null || sc.driveS == null) {
        pendingDays++
        continue
      }
      distanceM += sc.distanceM
      driveS += sc.driveS
      if (sc.tollsYuan == null) tollsUnknownDays++
      else tolls += sc.tollsYuan
    }
    return {
      distanceM,
      driveS,
      energy: energyCost(distanceM, vehicle.value),
      tolls: tollsUnknownDays ? null : tolls,
      pendingDays,
    }
  })

  // ───────────────────────── 天气（当天最后一个地点、当天日期） ─────────────────────────
  /** key = 「纬度,经度,日期」（坐标取两位小数），值 = 预报；null 表示查过但没有数据 */
  const weatherCache = reactive<Record<string, DayWeather | null>>({})
  const weatherInflight = new Set<string>()

  function weatherKeyOf(dayIndexNum: number): { key: string; lat: number; lng: number; date: string } | null {
    const t = trip.value
    const d = t?.days[dayIndexNum]
    const s = d?.stops[d.stops.length - 1]
    if (!t || !s) return null
    const date = ymd(dateOfDay(t.startDate, dayIndexNum))
    return { key: `${s.lat.toFixed(2)},${s.lng.toFixed(2)},${date}`, lat: s.lat, lng: s.lng, date }
  }

  /** 当天天气；不在预报范围内或未取到时为 null */
  function dayWeather(dayId: string): DayWeather | null {
    const k = weatherKeyOf(dayIndex(dayId))
    return k ? weatherCache[k.key] ?? null : null
  }

  /** 拉取当前路书在预报范围（今天起 16 天）内各天的天气；同一地点合并为一次请求 */
  async function refreshWeather() {
    const t = trip.value
    if (!t) return
    const today = todayStr()
    const lastDay = ymd(dateOfDay(today, FORECAST_DAYS - 1))
    const groups = new Map<string, { lat: number; lng: number; dates: string[]; keys: string[] }>()
    t.days.forEach((_, i) => {
      const k = weatherKeyOf(i)
      if (!k || k.date < today || k.date > lastDay) return
      if (k.key in weatherCache || weatherInflight.has(k.key)) return
      const loc = `${k.lat.toFixed(2)},${k.lng.toFixed(2)}`
      const g = groups.get(loc) ?? { lat: k.lat, lng: k.lng, dates: [], keys: [] }
      g.dates.push(k.date)
      g.keys.push(k.key)
      groups.set(loc, g)
    })
    for (const g of groups.values()) {
      g.keys.forEach((k) => weatherInflight.add(k))
      const from = g.dates.reduce((a, b) => (a < b ? a : b))
      const to = g.dates.reduce((a, b) => (a > b ? a : b))
      try {
        const list = await fetchForecast(g.lat, g.lng, from, to)
        g.keys.forEach((k, i) => {
          weatherCache[k] = list.find((w) => w.date === g.dates[i]) ?? null
        })
      } catch {
        // 天气只是辅助信息，失败不打扰用户，下次打开路书再试
      } finally {
        g.keys.forEach((k) => weatherInflight.delete(k))
      }
    }
  }

  // 出发日期或各天终点变化后刷新天气（防抖）
  let weatherTimer = 0
  watch(
    () => {
      const t = trip.value
      if (!t) return ''
      return t.startDate + '|' + t.days.map((d) => {
        const s = d.stops[d.stops.length - 1]
        return s ? `${s.lat.toFixed(2)},${s.lng.toFixed(2)}` : '-'
      }).join(';')
    },
    (sig) => {
      if (!sig) return
      window.clearTimeout(weatherTimer)
      weatherTimer = window.setTimeout(() => void refreshWeather(), 800)
    },
  )

  // ───────────────────────── 分享视频录制 ─────────────────────────
  /** 请地图组件录制全程巡游视频，录完不下载、交给分享弹窗上传 */
  function requestShareRecording() {
    if (!trip.value) return
    recordingForShare.value = true
    pendingShareVideo.value = null
    openMapOverview()
    shareRecordSeq.value++
  }

  /** 地图组件录制结束（blob 为 null 表示取消或失败） */
  function deliverShareVideo(blob: Blob | null) {
    recordingForShare.value = false
    pendingShareVideo.value = blob
  }

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
    trip, currentId, page, savedTrips, view, pickTarget, toast, mapCfg, hasAmapKey, adminOpen, mapOpen, pickerOpen, pickerResults, pickerCity, pickerKind, shareRecordSeq, recordingForShare, pendingShareVideo, legDistances, legDurations, legTolls, legFailed, legPaths,
    tripSummaries,
    init: loadAll, notify, save, saveNow, reset,
    applyProvider, applyServerConfig, retryLegs,
    createTrip, loadSample, openTrip, goHome, goOverview, goDays, openMapOverview, closeMap, showDayOnMap, deleteTrip, deleteCurrentTrip,
    setTitle, setStartDate, setDayCount, deleteDay, reorderDays,
    addStop, insertStop, removeStop, moveStop, reorderStops, updateStopPlace, setStopName, setStay, setStopKind, toggleStartAuto, setDepartTime, applyPicked,
    openPicker, openStopEditor, closePicker, pickSearchResult,
    routePointsOf, originFromPrev,
    dayStats, schedules, dayCost, tripTotals, vehicle, setVehicle,
    dayWeather, refreshWeather, requestShareRecording, deliverShareVideo,
    exportJson, importJson,
  }
})
