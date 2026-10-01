import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Day, MapProvider, Poi, RouteMeta, RoutePolicy, Stop, StopKind, StoredTrip, Trip } from '../types'
import * as mapSvc from '../services/map'
import { hashPoints, haversineKm, parseHM, todayStr } from '../services/geo'
import { uid } from '../services/id'
import { DAY_COLORS, DEFAULT_DRIVE_WARN_MINUTES, KIND_META, MAX_STOPS } from '../constants'
import { SAMPLE_DAYS, SAMPLE_TITLE } from '../sample'

const LS_TRIPS = 'lushu.trips.v2' // 路书库
const LS_TRIP_V1 = 'lushu.trip.v1' // 旧版单路书，仅用于迁移
const LS_MAPCFG = 'lushu.mapcfg.v1'

/**
 * 路线折线数据量大（单日可达上万点），不放进 Pinia 响应式，
 * 按路线 hash 存这里，地图组件直接读取；持久化时一并写盘。
 */
export const pathCache = new Map<string, [number, number][]>()

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
  const page = ref<'home' | 'trip'>('home') // 首页（路书列表） / 行程编辑
  const savedTrips = reactive<{ list: StoredTrip[] }>({ list: [] })
  const view = ref<string>('overview') // 'overview' | dayId
  const routes = reactive<Record<string, RouteMeta>>({})
  const pickTarget = ref<{ dayId: string } | null>(null)
  const toast = ref<{ text: string; kind: 'info' | 'error' } | null>(null)
  const mapCfg = reactive<{ provider: MapProvider; key: string; securityJsCode: string }>({
    provider: 'osm',
    key: '',
    securityJsCode: '',
  })
  const setupDone = ref(false) // 是否已完成数据源选择（决定首屏显示选择页还是主界面）
  const gateOpen = ref(false) // 从顶栏主动打开数据源选择页
  const mapOpen = ref(false) // 移动端：地图按需全屏展开（桌面端地图常驻，不受影响）

  let toastTimer = 0
  function notify(text: string, kind: 'info' | 'error' = 'info') {
    toast.value = { text, kind }
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.value = null), 3500)
  }

  // ───────────────────────── 初始化 / 持久化 ─────────────────────────
  function init() {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_MAPCFG) || 'null')
      if (saved?.provider) {
        mapCfg.provider = saved.provider
        mapCfg.key = saved.key || ''
        mapCfg.securityJsCode = saved.securityJsCode || ''
        setupDone.value = true
      }
    } catch { /* 忽略损坏数据 */ }
    mapSvc.setProvider(mapCfg.provider)

    try {
      const saved = JSON.parse(localStorage.getItem(LS_TRIPS) || 'null')
      if (Array.isArray(saved)) savedTrips.list = saved.filter((e: any) => e?.trip?.days?.length).map((e: any) => ({ ...e, trip: migrateTrip(e.trip) }))
    } catch { /* 忽略损坏数据 */ }
    // 旧版（单路书）数据迁移
    if (!savedTrips.list.length) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LS_TRIP_V1) || 'null')
        if (legacy?.trip?.days?.length) {
          savedTrips.list = [{ id: uid('trip'), savedAt: Date.now(), trip: migrateTrip(legacy.trip), routes: legacy.routes ?? {}, paths: legacy.paths ?? {} }]
          persistTrips()
        }
      } catch { /* 忽略损坏数据 */ }
    }
  }

  let saveTimer = 0
  function save() {
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(saveNow, 400)
  }

  function collectSave() {
    const routeMeta: Record<string, RouteMeta> = {}
    const paths: Record<string, [number, number][]> = {}
    if (trip.value) {
      for (const d of trip.value.days) {
        const r = routes[d.id]
        if (!r) continue
        routeMeta[d.id] = r
        const p = pathCache.get(r.hash)
        if (p) paths[r.hash] = p
      }
    }
    return { routeMeta, paths }
  }

  function persistTrips(stripPaths = false): boolean {
    try {
      const payload = savedTrips.list.map((e) => (stripPaths ? { ...e, paths: {} } : e))
      localStorage.setItem(LS_TRIPS, JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  function saveNow() {
    const t = trip.value
    if (!t || !currentId.value) return
    const { routeMeta, paths } = collectSave()
    const entry: StoredTrip = { id: currentId.value, savedAt: Date.now(), trip: t, routes: routeMeta, paths }
    const i = savedTrips.list.findIndex((e) => e.id === entry.id)
    if (i >= 0) savedTrips.list.splice(i, 1, entry)
    else savedTrips.list.unshift(entry)
    if (!persistTrips()) {
      // 存储超限：丢弃折线缓存再试
      entry.paths = {}
      if (persistTrips(true)) notify('本地存储空间不足，已仅保存行程数据（路线折线缓存已丢弃）', 'error')
      else notify('浏览器本地存储空间不足，修改可能未被保存', 'error')
    }
  }

  // ───────────────────────── 数据源管理（开源 OSM / 高德） ─────────────────────────
  const mapConfigured = computed(() => mapCfg.provider === 'osm' || !!mapCfg.key)

  function persistMapCfg() {
    localStorage.setItem(
      LS_MAPCFG,
      JSON.stringify({ provider: mapCfg.provider, key: mapCfg.key, securityJsCode: mapCfg.securityJsCode }),
    )
  }

  /** 选择地图数据源。两种地图坐标系不同（WGS-84 / GCJ-02），切换会清空路线缓存并重算。 */
  function applyProvider(provider: MapProvider, key = '', securityJsCode = '') {
    const changed = mapCfg.provider !== provider
    mapCfg.provider = provider
    mapCfg.key = key.trim()
    mapCfg.securityJsCode = securityJsCode.trim()
    setupDone.value = true
    gateOpen.value = false
    mapSvc.setProvider(provider)
    persistMapCfg()
    revalidateAllRoutes(changed)
  }

  /** 全部天重新校验路线缓存：hash 不一致或缺折线的天才真正重算，其余复用缓存 */
  function revalidateAllRoutes(bySwitch = false) {
    const t = trip.value
    if (!t) {
      saveNow()
      return
    }
    for (const d of t.days) {
      const r = routes[d.id]
      const pts = routePoints(d)
      const h = pts.length >= 2 ? hashPoints(pts, t.policy, mapCfg.provider) : ''
      if (!r || r.hash !== h || (r.status === 'done' && !pathCache.has(r.hash))) {
        delete routes[d.id]
        touch(d.id)
      }
    }
    if (bySwitch) {
      notify(
        mapCfg.provider === 'osm'
          ? '已切换到开源地图（OpenStreetMap），路线将重新计算'
          : '已切换到高德地图，路线将重新计算',
      )
    }
    saveNow()
  }

  // ───────────────────────── 路书库（首页列表） ─────────────────────────
  const tripSummaries = computed(() =>
    savedTrips.list.map((e) => {
      let dist = 0
      let dur = 0
      let doneDays = 0
      for (const m of Object.values(e.routes ?? {})) {
        if (m?.status === 'done') {
          dist += m.distanceM
          dur += m.durationS
          doneDays++
        }
      }
      return {
        id: e.id,
        title: e.trip.title,
        startDate: e.trip.startDate,
        days: e.trip.days.length,
        savedAt: e.savedAt,
        dist,
        dur,
        doneDays,
      }
    }),
  )

  function openTrip(id: string) {
    const entry = savedTrips.list.find((e) => e.id === id)
    if (!entry) return
    trip.value = migrateTrip(entry.trip)
    currentId.value = id
    Object.keys(routes).forEach((k) => delete routes[k])
    pathCache.clear()
    for (const [dayId, meta] of Object.entries(entry.routes ?? {})) {
      routes[dayId] = meta as RouteMeta
      const p = (entry.paths ?? {})[(meta as RouteMeta).hash]
      if (p) pathCache.set((meta as RouteMeta).hash, p)
    }
    view.value = 'overview'
    page.value = 'trip'
    revalidateAllRoutes()
  }

  function goHome() {
    saveNow()
    page.value = 'home'
  }

  function deleteTrip(id: string) {
    const i = savedTrips.list.findIndex((e) => e.id === id)
    if (i < 0) return
    const title = savedTrips.list[i].trip.title
    if (!window.confirm(`删除「${title}」？此操作不可恢复。`)) return
    savedTrips.list.splice(i, 1)
    if (!persistTrips()) notify('本地存储写入失败，请重试', 'error')
    if (currentId.value === id) {
      trip.value = null
      currentId.value = null
      Object.keys(routes).forEach((k) => delete routes[k])
      pathCache.clear()
      page.value = 'home'
    }
  }

  function deleteCurrentTrip() {
    if (currentId.value) deleteTrip(currentId.value)
    else page.value = 'home'
  }

  // ───────────────────────── 路线计算（带缓存） ─────────────────────────
  const timers: Record<string, number> = {}

  function findDay(dayId: string): Day | undefined {
    return trip.value?.days.find((d) => d.id === dayId)
  }

  function dayIndex(dayId: string): number {
    return trip.value?.days.findIndex((d) => d.id === dayId) ?? -1
  }

  /**
   * 当天参与路线计算的点序列。
   * 次日（startAuto）默认从前一天最后一个节点出发，因此会把 prevLast 拼在最前面。
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

  function touch(dayId: string) {
    const day = trip.value?.days.find((d) => d.id === dayId)
    if (!day) return
    const pts = routePoints(day)
    if (pts.length < 2) {
      delete routes[dayId]
      save()
      return
    }
    const h = hashPoints(pts, trip.value!.policy, mapCfg.provider)
    const cur = routes[dayId]
    if (cur && cur.hash === h && cur.status !== 'error') return // 点没变，不重复请求
    routes[dayId] = { status: 'pending', hash: h, distanceM: 0, durationS: 0, tolls: null, legs: null, error: '' }
    window.clearTimeout(timers[dayId])
    timers[dayId] = window.setTimeout(() => void calc(dayId, h), 600)
    save()
  }

  async function calc(dayId: string, hash: string) {
    const day = trip.value?.days.find((d) => d.id === dayId)
    if (!day || !trip.value) return
    const points = routePoints(day)
    if (points.length < 2) return
    try {
      const r = await mapSvc.fetchRoute(points, trip.value.policy)
      if (routes[dayId]?.hash !== hash) return // 已过期（期间又被编辑）
      pathCache.set(hash, r.path)
      routes[dayId] = { status: 'done', hash, distanceM: r.distanceM, durationS: r.durationS, tolls: r.tolls, legs: r.legs, error: '' }
    } catch (e: any) {
      if (routes[dayId]?.hash !== hash) return
      routes[dayId] = { status: 'error', hash, distanceM: 0, durationS: 0, tolls: null, legs: null, error: e?.message || '路线计算失败' }
    }
    save()
  }

  function recalc(dayId: string) {
    delete routes[dayId]
    touch(dayId)
  }

  /** 当天的节点/顺序变化可能改变前一天末节点 → 影响次日的接续起点 */
  function touchNext(dayId: string) {
    const i = dayIndex(dayId)
    const next = trip.value?.days[i + 1]
    if (next) touch(next.id)
  }

  // ───────────────────────── 行程 / 日程编辑 ─────────────────────────
  function createTrip(title: string, startDate: string, dayCount: number) {
    const t: Trip = {
      id: uid('trip'),
      title: title.trim() || '未命名行程',
      startDate: startDate || todayStr(),
      policy: 'fastest',
      driveWarnMinutes: DEFAULT_DRIVE_WARN_MINUTES,
      days: Array.from({ length: Math.max(1, Math.min(30, dayCount)) }, emptyDay),
    }
    trip.value = t
    currentId.value = t.id
    Object.keys(routes).forEach((k) => delete routes[k])
    pathCache.clear()
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
    days.forEach((d) => touch(d.id))
    view.value = days[0].id
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

  function setPolicy(p: RoutePolicy) {
    if (!trip.value) return
    trip.value.policy = p
    trip.value.days.forEach((d) => recalc(d.id)) // 策略变了重新计算所有天
  }

  function setDriveWarn(minutes: number) {
    if (!trip.value) return
    trip.value.driveWarnMinutes = Math.max(60, Math.min(1440, Math.round(minutes) || DEFAULT_DRIVE_WARN_MINUTES))
    save()
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
      if (view.value !== 'overview' && !t.days.some((d) => d.id === view.value)) view.value = 'overview'
      Object.keys(routes).forEach((id) => {
        if (!t.days.some((d) => d.id === id)) delete routes[id]
      })
    } else {
      while (t.days.length < n) t.days.push(emptyDay())
    }
    t.days.forEach((d) => touch(d.id))
    saveNow()
  }

  // ── 节点（每天一个有序列表，无固定起点/终点） ──
  function addStop(dayId: string, poi: Poi, kind: StopKind = 'waypoint'): boolean {
    const day = findDay(dayId)
    if (!day) return false
    if (day.stops.length >= MAX_STOPS) {
      notify(`单日节点最多 ${MAX_STOPS} 个`, 'error')
      return false
    }
    const s = mkStop(poi, kind)
    s.stayMinutes = defaultStay(kind)
    day.stops.push(s)
    touch(dayId)
    touchNext(dayId) // 本天末节点变化 → 次日接续起点变化
    return true
  }

  function removeStop(dayId: string, stopId: string) {
    const day = findDay(dayId)
    if (!day) return
    const idx = day.stops.findIndex((s) => s.id === stopId)
    if (idx < 0) return
    day.stops.splice(idx, 1)
    touch(dayId)
    touchNext(dayId)
  }

  function moveStop(dayId: string, from: number, to: number) {
    const day = findDay(dayId)
    if (!day) return
    if (from < 0 || to < 0 || from >= day.stops.length || to >= day.stops.length || from === to) return
    const [s] = day.stops.splice(from, 1)
    day.stops.splice(to, 0, s)
    touch(dayId)
    touchNext(dayId)
  }

  /** vuedraggable 直接改了数组，这里只负责触发重算 */
  function dragReordered(dayId: string) {
    touch(dayId)
    touchNext(dayId)
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
    touch(dayId)
    touchNext(dayId)
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
    touch(dayId)
  }

  /** 地图点选落点：一律追加为节点 */
  function applyPicked(target: { dayId: string }, poi: Poi) {
    addStop(target.dayId, poi)
    pickTarget.value = null
  }

  // ───────────────────────── 统计 / 时间轴 ─────────────────────────
  const dayStats = computed(() => {
    const t = trip.value
    if (!t) return []
    return t.days.map((d, i) => ({
      index: i,
      day: d,
      color: DAY_COLORS[i % DAY_COLORS.length],
      route: routes[d.id] ?? null,
    }))
  })

  const totals = computed(() => {
    let dist = 0
    let dur = 0
    let fee = 0
    let feeKnown = true
    let warns = 0
    let okDays = 0
    for (const s of dayStats.value) {
      if (s.route?.status === 'done') {
        dist += s.route.distanceM
        dur += s.route.durationS
        okDays++
        if (s.route.tolls != null) fee += s.route.tolls
        else feeKnown = false
        if (s.route.durationS / 60 > (trip.value?.driveWarnMinutes ?? DEFAULT_DRIVE_WARN_MINUTES)) warns++
      }
    }
    return { dist, dur, fee: feeKnown ? fee : null, warns, okDays, days: dayStats.value.length }
  })

  function overDrive(dayId: string): boolean {
    const m = routes[dayId]
    return !!m && m.status === 'done' && m.durationS / 60 > (trip.value?.driveWarnMinutes ?? DEFAULT_DRIVE_WARN_MINUTES)
  }

  /**
   * 某节点相对上一节点的行车数据。
   * 优先用接口返回的分段（OSRM legs），否则用直线距离 × 全程均速估算。
   */
  function segmentInfo(dayId: string, seqIndex: number): { distanceM: number; driveMin: number; approx: boolean } | null {
    const day = findDay(dayId)
    const r = routes[dayId]
    if (!day || r?.status !== 'done') return null
    const seq = routePoints(day)
    if (seqIndex <= 0 || seqIndex >= seq.length) return null
    if (r.legs && r.legs.length === seq.length - 1) {
      return { distanceM: r.legs[seqIndex - 1].distanceM, driveMin: Math.round(r.legs[seqIndex - 1].durationS / 60), approx: false }
    }
    const km = haversineKm(seq[seqIndex - 1], seq[seqIndex])
    const speed = r.durationS > 0 ? r.distanceM / r.durationS : 22 // m/s，约 80km/h
    return { distanceM: Math.round(km * 1000), driveMin: Math.round((km * 1000) / speed / 60), approx: true }
  }

  /**
   * 时间轴推算：出发时间 + 各段驾驶时长 + 停留时长。
   * 优先用接口分段数据；否则按直线距离比例分摊。
   */
  function timeline(dayId: string) {
    const t = trip.value
    const day = t?.days.find((d) => d.id === dayId)
    const r = routes[dayId]
    if (!t || !day || r?.status !== 'done') return null
    const seq = routePoints(day)
    if (seq.length < 2) return null
    const fromPrev = seq[0] !== day.stops[0]
    const driveTotal = r.durationS / 60
    const legs = r.legs && r.legs.length === seq.length - 1 ? r.legs : null
    const straights: number[] = []
    for (let i = 1; i < seq.length; i++) straights.push(haversineKm(seq[i - 1], seq[i]))
    const sumS = straights.reduce((a, b) => a + b, 0)
    let clock = parseHM(day.departTime)
    return seq.map((stop, i) => {
      const isEnd = i === seq.length - 1
      const driveMin =
        i === 0
          ? 0
          : legs
            ? Math.round(legs[i - 1].durationS / 60)
            : Math.round(sumS > 0 ? (straights[i - 1] / sumS) * driveTotal : driveTotal / Math.max(1, seq.length - 1))
      const arrive = clock + (i === 0 ? 0 : driveMin)
      const stay = isEnd ? 0 : stop.stayMinutes
      const depart = arrive + stay
      clock = depart
      return { stop, driveMin, arrive, depart, isEnd, fromPrev: i === 0 && fromPrev }
    })
  }

  // ───────────────────────── 导入 / 导出 ─────────────────────────
  function exportJson(): string {
    const { routeMeta, paths } = collectSave()
    return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), trip: trip.value, routes: routeMeta, paths })
  }

  /** 导入：作为新路程加入路书库并打开 */
  function importJson(text: string) {
    const data = JSON.parse(text)
    const t = data?.trip
    if (!t || !Array.isArray(t.days) || !t.days.length) throw new Error('文件格式不正确：缺少 trip.days')
    const id = typeof t.id === 'string' && t.id && !savedTrips.list.some((e) => e.id === t.id) ? t.id : uid('trip')
    trip.value = migrateTrip({ ...t, id })
    currentId.value = id
    Object.keys(routes).forEach((k) => delete routes[k])
    pathCache.clear()
    for (const [dayId, meta] of Object.entries(data.routes ?? {})) routes[dayId] = meta as RouteMeta
    for (const [h, p] of Object.entries(data.paths ?? {})) pathCache.set(h, p as [number, number][])
    view.value = 'overview'
    page.value = 'trip'
    revalidateAllRoutes()
    saveNow()
  }

  return {
    trip, currentId, page, savedTrips, view, routes, pickTarget, toast, mapCfg, setupDone, gateOpen, mapConfigured, mapOpen,
    tripSummaries,
    init, notify, save, saveNow,
    applyProvider,
    touch, recalc, dragReordered,
    createTrip, loadSample, openTrip, goHome, deleteTrip, deleteCurrentTrip,
    setTitle, setStartDate, setPolicy, setDriveWarn, setDayCount,
    addStop, removeStop, moveStop, updateStopPlace, setStopName, setStay, setStopKind, toggleStartAuto, applyPicked,
    routePointsOf, originFromPrev, segmentInfo,
    dayStats, totals, overDrive, timeline,
    exportJson, importJson,
  }
})
