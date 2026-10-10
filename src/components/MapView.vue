<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useTripStore } from '../stores/trip'
import { loadMapLib, reverseGeocode } from '../services/map'
import { cnOrdinal, fmtDistance } from '../services/geo'
import { DAY_COLORS } from '../constants'
import type { Stop, Trip } from '../types'
import {
  buildCruiseTrack,
  sampleCruiseTrack,
  type CruiseTrack,
  type CruiseState,
} from '../services/cruise'
import {
  start16x9Recording,
  downloadVideoBlob,
  isVideoRecordingSupported,
  type RecordingSession,
} from '../services/videoRecorder'

const store = useTripStore()
const el = ref<HTMLDivElement | null>(null)

let map: any = null
let lib: any = null
let layerGroup: any = null // Leaflet 图层组（行程地点与常规线路）
let pickerLayer: any = null // Leaflet 图层组（选点页搜索结果）
let overlays: any[] = [] // AMap 覆盖物
let pickerOverlays: any[] = [] // AMap：选点页搜索结果标记
let infoWindow: any = null
let loading = false
let loadedProvider: string | null = null

// ───────────────────────── 巡游播放状态与对象 ─────────────────────────
const cruiseActive = ref(false)
const cruisePlaying = ref(false)
const cruiseRange = ref<string>('all') // 'all' 或 dayId
const cruiseSpeed = ref<number>(1) // 默认 1 倍速 (1x, 2x, 4x, 8x)
const cruiseViewMode = ref<'follow' | 'overview'>('follow') // 视角模式：'follow' 跟随小车 / 'overview' 完整路线全景
const cruiseDist = ref(0)
const cruiseTrack = ref<CruiseTrack | null>(null)
const cruiseCurrentState = ref<CruiseState | null>(null)
const cruiseProgressSlider = ref(0) // 0~1000

// Leaflet 巡游图层与覆盖物
let cruiseLayerGroup: any = null
let cruiseBaseCasingLeaflet: any = null // 待行驶完整规划路线底层白色轮廓
let cruiseBasePolylineLeaflet: any = null // 待行驶完整规划路线高对比度科技蓝主线
let cruiseCarMarkerLeaflet: any = null
let cruisePolylineLeaflet: any = null // 已行驶经过路线（暖橙红高亮覆盖）

// AMap 巡游覆盖物
let cruiseBaseCasingAmap: any = null // 待行驶完整规划路线底层白色轮廓
let cruiseBasePolylineAmap: any = null // 待行驶完整规划路线高对比度科技蓝主线
let cruiseCarMarkerAmap: any = null
let cruisePolylineAmap: any = null // 已行驶经过路线（暖橙红高亮覆盖）

let cruiseRafId: number | null = null
let cruiseLastTimestamp: number | null = null
// 已行驶路线缓冲（按当前地图库的坐标顺序存放）：顶点 0..passedBufIdx，末尾再跟一个小车当前位置。
// 每帧只追加新驶过的顶点，不再整段重建数组。
let passedBuf: [number, number][] = []
let passedBufIdx = -1

// ───────────────────────── 16:9 视频导出状态 ─────────────────────────
const exportModalOpen = ref(false)
const exportSpeed = ref<number>(1) // 默认 1 倍速 (1x, 2x, 4x, 8x)
const exportIsOverview = ref<boolean>(true) // 是否全景（默认推荐全景展示完整路线）
const exportRange = ref<string>('all') // 'all' 或 dayId

const isRecording = ref(false)
const recordingSeconds = ref(0)
let recordingTimer: number | null = null
let activeRecordingSession: RecordingSession | null = null

const estimateRecordSeconds = computed(() => {
  if (!store.trip) return 20
  const track = buildCruiseTrack(
    store.trip,
    exportRange.value,
    store.legPaths,
    store.routePointsOf,
  )
  if (!track) return 20
  const total = track.totalDistance
  const baseTimeSec = Math.max(22, Math.min(50, (total / 1000) * 0.18 + 20))
  return Math.round(baseTimeSec / exportSpeed.value)
})

/** 容器当前是否可见（移动端地图收起时宽度为 0，此时不初始化/不绘制） */
function containerVisible(): boolean {
  return !!el.value && el.value.clientWidth > 0
}

function tryInit() {
  if (!containerVisible()) return
  void ensureMap()
}

onMounted(() => {
  tryInit()
})

onUnmounted(() => {
  document.body.classList.remove('is-recording-video')
  abortRecording()
  stopCruise()
})

// 录制中给 body 打标记，让全局 toast 收进画框外的黑边（见 style.css）
watch(isRecording, (rec) => {
  document.body.classList.toggle('is-recording-video', rec)
})

watch(
  () => store.mapCfg.provider,
  () => {
    abortRecording('地图数据源已切换，视频录制已取消')
    stopCruise()
    if (map) destroyMap()
    tryInit()
  },
)

// 移动端展开地图浮层：容器从 display:none 变为全屏，需要等布局稳定后重算尺寸并重绘适配视野
watch(
  () => store.mapOpen,
  (open) => {
    if (!open) {
      abortRecording('地图已关闭，视频录制已取消')
      if (cruiseActive.value) stopCruise()
      return
    }
    void nextTick(() => {
      if (!map) {
        tryInit()
        return
      }
      requestAnimationFrame(() => {
        if (loadedProvider === 'osm') map.invalidateSize()
        redraw()
        setTimeout(() => {
          if (loadedProvider === 'osm' && store.mapOpen) map.invalidateSize()
        }, 150)
      })
    })
  },
)

async function ensureMap() {
  if (loading) return
  const provider = store.mapCfg.provider
  if (map && loadedProvider === provider) return
  if (map) destroyMap()
  loading = true
  try {
    lib = await loadMapLib(store.mapCfg.key, store.mapCfg.securityJsCode)
    if (provider === 'amap') {
      map = new lib.Map(el.value!, { zoom: 5, center: [104.5, 37.5], viewMode: '2D' })
      infoWindow = new lib.InfoWindow({ offset: new lib.Pixel(0, -30) })
      map.on('click', onMapClickAmap)
    } else {
      map = lib.map(el.value!, { zoom: 4, center: [36.5, 104.5] })
      lib
        .tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
        .addTo(map)
      layerGroup = lib.layerGroup().addTo(map)
      pickerLayer = lib.layerGroup().addTo(map)
      cruiseLayerGroup = lib.layerGroup().addTo(map)
      map.on('click', onMapClickLeaflet)
      window.addEventListener('resize', invalidateSize)
    }
    loadedProvider = provider
    redraw()
    store.retryLegs()
  } catch (e: any) {
    store.notify(e?.message || '地图加载失败', 'error')
  } finally {
    loading = false
  }
}

function invalidateSize() {
  if (loadedProvider === 'osm' && map) map.invalidateSize()
}

function destroyMap() {
  stopCruise()
  if (loadedProvider === 'osm') {
    window.removeEventListener('resize', invalidateSize)
    try {
      map?.remove()
    } catch { /* 已销毁 */ }
  } else {
    try {
      map?.destroy()
    } catch { /* 已销毁 */ }
  }
  map = null
  layerGroup = null
  pickerLayer = null
  cruiseLayerGroup = null
  overlays = []
  pickerOverlays = []
  infoWindow = null
  loadedProvider = null
}

async function onMapClickAmap(e: any) {
  if (!store.pickTarget) return
  const target = { ...store.pickTarget }
  const { lng, lat } = e.lnglat
  store.notify('正在解析位置…')
  try {
    const poi = await reverseGeocode(lng, lat)
    store.applyPicked(target, { ...poi, district: '', lng, lat })
  } catch (err: any) {
    store.notify(err?.message || '位置解析失败', 'error')
  }
}

async function onMapClickLeaflet(e: any) {
  if (!store.pickTarget) return
  const target = { ...store.pickTarget }
  const { lat, lng } = e.latlng
  store.notify('正在解析位置…')
  try {
    const poi = await reverseGeocode(lng, lat)
    store.applyPicked(target, { ...poi, district: '', lng, lat })
  } catch (err: any) {
    store.notify(err?.message || '位置解析失败', 'error')
  }
}

interface Mark {
  s: Stop
  color: string
  dayIndex: number
  dayLabel: string
  stopIndex: number
  numText: string
  name: string
  isJoint?: boolean
  jointDesc?: string
}

function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** 生成自驾路书专业地点图钉：数字气泡 + 天数徽标 + 地名胶囊标签 */
function markerHtml(m: Mark): string {
  const isJoint = !!m.isJoint
  const bubbleClass = `marker-bubble ${isJoint ? 'joint-bubble' : ''}`
  const safeName = escapeHtml(m.name)
  return `<div class="map-marker-anchor" style="--mk-color:${m.color}">` +
    `<div class="map-marker-pin" title="${m.dayLabel} 第${m.stopIndex}站：${safeName}">` +
      `<div class="${bubbleClass}">` +
        `<span class="marker-day-tag">${m.dayLabel}</span>` +
        `<span class="marker-num-val">${m.numText}</span>` +
      `</div>` +
      `<div class="marker-name-tag">${safeName}</div>` +
    `</div>` +
  `</div>`
}

/** 地点弹窗详细信息卡片 */
function popupHtml(m: Mark): string {
  const s = m.s
  const safeName = escapeHtml(s.name)
  const safeAddr = s.address ? escapeHtml(s.address) : ''
  return `<div class="mk-info-card">` +
    `<div class="mk-info-header">` +
      `<span class="mk-info-badge" style="background:${m.color}">${m.dayLabel} · 第${m.stopIndex}站</span>` +
    `</div>` +
    `<div class="mk-info-title">${safeName}</div>` +
    (m.jointDesc ? `<div style="font-size:11.5px;color:#2563eb;font-weight:700;margin-top:2px;">🔄 ${escapeHtml(m.jointDesc)}</div>` : '') +
    (safeAddr ? `<div class="mk-info-addr">📍 ${safeAddr}</div>` : '') +
    (s.stayMinutes ? `<div class="mk-info-stay">⏱️ 建议停留 ${s.stayMinutes} 分钟</div>` : '') +
  `</div>`
}

/** 单日视角：当天按地点自然序号 1, 2, 3... 顺次标记 */
function dayMarks(trip: Trip, dayId: string): Mark[] {
  const day = trip.days.find((d) => d.id === dayId)
  if (!day) return []
  const di = trip.days.indexOf(day)
  const color = DAY_COLORS[di % DAY_COLORS.length]
  const stops = store.routePointsOf(dayId)

  return stops.map((s, i) => ({
    s,
    color,
    dayIndex: di,
    dayLabel: `D${di + 1}`,
    stopIndex: i + 1,
    numText: String(i + 1),
    name: s.name,
    isJoint: s.fromPrev && i === 0,
    jointDesc: s.fromPrev && i === 0 ? '从前一天接续出发' : undefined,
  }))
}

/** 总览视角：把每一天地点用数字标在地图路径上 */
function globalMarks(trip: Trip): Mark[] {
  const marks: Mark[] = []

  trip.days.forEach((day, di) => {
    const color = DAY_COLORS[di % DAY_COLORS.length]
    day.stops.forEach((s, si) => {
      if (s.fromPrev && si === 0 && marks.length > 0) {
        const lastMark = marks[marks.length - 1]
        const isSame =
          Math.abs(lastMark.s.lng - s.lng) < 5e-4 && Math.abs(lastMark.s.lat - s.lat) < 5e-4
        if (isSame) {
          lastMark.isJoint = true
          const daysPart = lastMark.dayLabel.includes('/') || lastMark.dayLabel.includes('~')
            ? `${lastMark.dayLabel.split(/[/~]/)[0]}~D${di + 1}`
            : `${lastMark.dayLabel}/D${di + 1}`
          lastMark.dayLabel = daysPart
          lastMark.numText = `${lastMark.stopIndex}/${si + 1}`
          lastMark.jointDesc = `第${lastMark.dayIndex + 1}天终点 ➔ 第${di + 1}天接续出发`
          return
        }
      }

      marks.push({
        s,
        color,
        dayIndex: di,
        dayLabel: `D${di + 1}`,
        stopIndex: si + 1,
        numText: String(si + 1),
        name: s.name,
      })
    })
  })

  return marks
}

function redraw() {
  if (!map || !containerVisible()) return
  if (cruiseActive.value) {
    // 巡游播放中时暂缓重绘普通图钉避免跳动
    return
  }
  if (loadedProvider === 'amap') redrawAmap()
  else if (loadedProvider === 'osm') redrawLeaflet()
}

function redrawAmap() {
  const AMap = lib
  map.clearMap()
  const trip = store.trip
  if (!trip) return

  const days = store.view === 'overview' ? trip.days : trip.days.filter((d) => d.id === store.view)
  overlays = []
  const dayView = store.view !== 'overview'

  for (const day of days) {
    const idx = trip.days.indexOf(day)
    const color = DAY_COLORS[idx % DAY_COLORS.length]
    const seq = store.routePointsOf(day.id)

    if (seq.length > 1) {
      const drivePath = store.legPaths[day.id]
      const real = !!drivePath && drivePath.length > 1
      const pathCoords = real ? drivePath! : seq.map((s) => [s.lng, s.lat])

      // 1. 底层纯白高光外边框（物理隔绝地图底图自带黄色/橙色公路，使规划路线立体浮起）
      const casing = new AMap.Polyline({
        path: pathCoords,
        strokeColor: '#ffffff',
        strokeWeight: dayView ? 9.5 : 8,
        strokeOpacity: 0.95,
        strokeStyle: 'solid',
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 38,
      })
      map.add(casing)
      overlays.push(casing)

      // 2. 主层高对比度彩色规划路线
      const line = new AMap.Polyline({
        path: pathCoords,
        strokeColor: color,
        strokeWeight: dayView ? 6.5 : 5,
        strokeOpacity: 0.95,
        strokeStyle: real ? 'solid' : 'dashed',
        showDir: real,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 40,
      })
      map.add(line)
      overlays.push(line)
    }
  }

  const marks = store.view === 'overview' ? globalMarks(trip) : dayMarks(trip, store.view)
  for (const m of marks) {
    const marker = new AMap.Marker({
      position: [m.s.lng, m.s.lat],
      content: markerHtml(m),
      anchor: 'top-left',
      zIndex: 120,
    })
    marker.on('click', () => {
      infoWindow.setContent(popupHtml(m))
      infoWindow.open(map, [m.s.lng, m.s.lat])
    })
    map.add(marker)
    overlays.push(marker)
  }

  drawPickerMarkers()
  if (overlays.length) map.setFitView(overlays, false, [70, 90, 70, 90], 15)
}

function redrawLeaflet() {
  layerGroup.clearLayers()
  const trip = store.trip
  if (!trip) return

  const days = store.view === 'overview' ? trip.days : trip.days.filter((d) => d.id === store.view)
  const dayView = store.view !== 'overview'
  const bounds: [number, number][] = []

  for (const day of days) {
    const idx = trip.days.indexOf(day)
    const color = DAY_COLORS[idx % DAY_COLORS.length]
    const seq = store.routePointsOf(day.id)

    if (seq.length > 1) {
      const drivePath = store.legPaths[day.id]
      const real = !!drivePath && drivePath.length > 1
      const latlngs = real
        ? drivePath!.map(([lng, lat]) => [lat, lng] as [number, number])
        : seq.map((s) => [s.lat, s.lng] as [number, number])

      // 1. 底层纯白高光外边框（隔绝底图自带公路，强化路线立体感）
      lib
        .polyline(latlngs, {
          color: '#ffffff',
          weight: dayView ? 9.5 : 8,
          opacity: 0.95,
          lineJoin: 'round',
          lineCap: 'round',
        })
        .addTo(layerGroup)

      // 2. 主层高对比度彩色规划路线
      lib
        .polyline(latlngs, {
          color,
          weight: dayView ? 6.5 : 5,
          opacity: 0.95,
          dashArray: real ? undefined : '6 8',
          lineJoin: 'round',
          lineCap: 'round',
        })
        .addTo(layerGroup)
      bounds.push(...latlngs)
    }
  }

  const marks = store.view === 'overview' ? globalMarks(trip) : dayMarks(trip, store.view)
  for (const m of marks) {
    const icon = lib.divIcon({
      className: '',
      html: markerHtml(m),
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    })
    const marker = lib.marker([m.s.lat, m.s.lng], { icon, zIndexOffset: 120 }).addTo(layerGroup)
    marker.bindPopup(popupHtml(m))
    bounds.push([m.s.lat, m.s.lng])
  }

  drawPickerMarkers()
  if (bounds.length === 1) map.setView(bounds[0], 13)
  else if (bounds.length) map.fitBounds(lib.latLngBounds(bounds), { padding: [70, 90], maxZoom: 15, animate: false })
}

/** 选点页：把搜索结果画成可点击的编号标记 */
function drawPickerMarkers() {
  if (!map) return
  if (loadedProvider === 'osm' && pickerLayer) {
    pickerLayer.clearLayers()
    if (!store.pickerOpen) return
    store.pickerResults.forEach((p, i) => {
      const icon = lib.divIcon({
        className: '',
        html: `<div class="marker-search-pin">${i + 1}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      const m = lib.marker([p.lat, p.lng], { icon, zIndexOffset: 1000 }).addTo(pickerLayer)
      m.on('click', () => store.pickSearchResult(p))
    })
  } else if (loadedProvider === 'amap') {
    for (const o of pickerOverlays) map.remove(o)
    pickerOverlays = []
    if (!store.pickerOpen) return
    store.pickerResults.forEach((p, i) => {
      const marker = new lib.Marker({
        position: [p.lng, p.lat],
        content: `<div class="marker-search-pin">${i + 1}</div>`,
        anchor: 'center',
        zIndex: 200,
      })
      marker.on('click', () => store.pickSearchResult(p))
      map.add(marker)
      pickerOverlays.push(marker)
    })
  }
}

/** 选点页：搜索后把视野适配到结果 */
function fitPickerResults() {
  if (!map || !store.pickerResults.length) return
  if (loadedProvider === 'osm') {
    const pts = store.pickerResults.map((p) => [p.lat, p.lng] as [number, number])
    if (pts.length === 1) map.setView(pts[0], 13)
    else map.fitBounds(lib.latLngBounds(pts), { padding: [80, 80], maxZoom: 14, animate: false })
  } else if (loadedProvider === 'amap') {
    map.setFitView(pickerOverlays, false, [80, 80, 80, 80], 14)
  }
}

watch(
  () => [store.pickerOpen, store.pickerResults],
  () => {
    drawPickerMarkers()
    if (store.pickerOpen) fitPickerResults()
  },
)

watch(
  () => store.pickerOpen,
  () => {
    void nextTick(() => {
      if (!map) return
      requestAnimationFrame(() => {
        if (loadedProvider === 'osm') map.invalidateSize()
        redraw()
      })
    })
  },
)

watch(() => [store.view, store.trip, store.legPaths], () => {
  if (!cruiseActive.value) redraw()
}, { deep: true })

const pickLabel = () => {
  const t = store.pickTarget
  if (!t || !store.trip) return ''
  const i = store.trip.days.findIndex((d) => d.id === t.dayId)
  return `第${cnOrdinal(i + 1)}天`
}

// ───────────────────────── 巡游动画小轿车与车顶标记 ─────────────────────────

/** 生成小轿车与车顶经过城市地点 HTML */
function carMarkerHtml(state: CruiseState): string {
  const safeCity = escapeHtml(state.city)
  const safePlace = escapeHtml(state.place)
  const safeStatus = escapeHtml(state.statusText)
  const rot = Math.round(state.heading)

  return `
    <div class="cruise-car-anchor">
      <!-- 车顶气泡悬浮标签（不随车身旋转，端正向上展示城市与地点） -->
      <div class="cruise-roof-bubble" id="cruise-roof-bubble">
        <div class="cruise-roof-header">
          <span class="cruise-roof-badge" style="background: linear-gradient(135deg, #ff5722, #ea580c); box-shadow: 0 2px 6px rgba(234,88,12,0.4);">🚗 经过地点</span>
          <span class="cruise-roof-city" id="cruise-roof-city">${safeCity}</span>
        </div>
        <div class="cruise-roof-place" id="cruise-roof-place" title="${safePlace}">${safePlace}</div>
        <div class="cruise-roof-status" id="cruise-roof-status">${safeStatus}</div>
        <div class="cruise-roof-arrow"></div>
      </div>

      <!-- 可爱圆润萌系小轿车主体（随行驶路线精准顺滑转向） -->
      <div class="cruise-car-hull" id="cruise-car-hull" style="transform: rotate(${rot}deg);">
        <svg viewBox="0 0 48 72" class="cruise-car-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <!-- 萌系活力暖黄烤漆立体光影 -->
            <linearGradient id="cuteCarBodyGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#f59e0b" />
              <stop offset="35%" stop-color="#fbbf24" />
              <stop offset="70%" stop-color="#fde047" />
              <stop offset="100%" stop-color="#d97706" />
            </linearGradient>
            <!-- 水灵灵圆润大风挡玻璃 -->
            <linearGradient id="cuteGlassGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#7dd3fc" stop-opacity="0.95" />
              <stop offset="100%" stop-color="#0284c7" stop-opacity="0.85" />
            </linearGradient>
            <filter id="cuteCarShadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="4" stdDeviation="3.5" flood-color="rgba(15,23,42,0.38)" />
            </filter>
          </defs>

          <!-- 前大灯柔和扇形光芒 -->
          <polygon points="12.5,0 3,13 17,13" fill="rgba(254, 240, 138, 0.45)" />
          <polygon points="35.5,0 31,13 45,13" fill="rgba(254, 240, 138, 0.45)" />

          <!-- 四个圆滚滚胖轮胎 -->
          <rect x="1" y="13" width="6.5" height="13" rx="3.25" fill="#1e293b" />
          <rect x="40.5" y="13" width="6.5" height="13" rx="3.25" fill="#1e293b" />
          <rect x="1" y="46" width="6.5" height="13" rx="3.25" fill="#1e293b" />
          <rect x="40.5" y="46" width="6.5" height="13" rx="3.25" fill="#1e293b" />

          <!-- 圆润萌系车体 -->
          <g filter="url(#cuteCarShadow)">
            <!-- 左右圆润水滴后视镜 -->
            <ellipse cx="3.8" cy="25.5" rx="2.8" ry="3.2" fill="#f59e0b" />
            <ellipse cx="44.2" cy="25.5" rx="2.8" ry="3.2" fill="#f59e0b" />

            <!-- 胖嘟嘟圆角胶囊主车壳 -->
            <rect x="6.5" y="7" width="35" height="58" rx="17.5" ry="17.5" fill="url(#cuteCarBodyGrad)" stroke="#d97706" stroke-width="1.2" />

            <!-- 萌萌大风挡玻璃（圆角笑眼弧度） -->
            <path d="M 11.5 20.5 Q 24 17.5, 36.5 20.5 Q 38.5 30, 34.5 32 Q 24 30.5, 13.5 32 Q 9.5 30, 11.5 20.5 Z" fill="url(#cuteGlassGrad)" />

            <!-- 可爱圆角全景天窗 -->
            <rect x="13.5" y="34.5" width="21" height="17" rx="6" fill="#0f172a" opacity="0.85" />
            <path d="M 16 37.5 L 21 37.5 L 18 48.5 L 15 48.5 Z" fill="#ffffff" opacity="0.28" />

            <!-- 圆润后风挡玻璃 -->
            <path d="M 13.5 53.5 Q 24 52.5, 34.5 53.5 Q 36.5 58.5, 33 59.5 Q 24 60.5, 15 59.5 Q 11.5 58.5, 13.5 53.5 Z" fill="url(#cuteGlassGrad)" />

            <!-- 两只圆溜溜“大眼睛”车灯（带水灵灵高光瞳孔） -->
            <circle cx="12.5" cy="11.5" r="4.2" fill="#fef08a" stroke="#d97706" stroke-width="0.8" />
            <circle cx="11.5" cy="10.5" r="1.6" fill="#ffffff" />

            <circle cx="35.5" cy="11.5" r="4.2" fill="#fef08a" stroke="#d97706" stroke-width="0.8" />
            <circle cx="34.5" cy="10.5" r="1.6" fill="#ffffff" />

            <!-- 萌萌微笑小嘴巴与粉嫩小腮红 -->
            <path d="M 21 12.5 Q 24 14.8, 27 12.5" stroke="#d97706" stroke-width="1.3" stroke-linecap="round" fill="none" />
            <circle cx="17.5" cy="13.5" r="1.4" fill="#fb7185" opacity="0.75" />
            <circle cx="30.5" cy="13.5" r="1.4" fill="#fb7185" opacity="0.75" />

            <!-- 尾部圆润小草莓红尾灯 -->
            <ellipse cx="12.5" cy="63.5" rx="2.8" ry="2" fill="#ef4444" />
            <ellipse cx="35.5" cy="63.5" rx="2.8" ry="2" fill="#ef4444" />
          </g>
        </svg>
      </div>
    </div>
  `
}

/** 切换巡游播放模式开关 */
function toggleCruiseMode() {
  if (cruiseActive.value) {
    stopCruise()
  } else {
    startCruise()
  }
}

/** 启动巡游播放 */
function startCruise() {
  if (!store.trip) {
    store.notify('请先打开或创建一份路书', 'error')
    return
  }

  // 若当前为单日视角，默认选定该天，否则选定全程
  if (store.view && store.view !== 'overview') {
    cruiseRange.value = store.view
  } else {
    cruiseRange.value = 'all'
  }

  const track = buildCruiseTrack(
    store.trip,
    cruiseRange.value,
    store.legPaths,
    store.routePointsOf,
  )

  if (!track || track.points.length < 2) {
    store.notify('当前路线暂无可行驶路段，请先添加至少 2 个地点', 'error')
    return
  }

  cruiseTrack.value = track
  cruiseDist.value = 0
  cruiseActive.value = true
  cruisePlaying.value = true

  const initialState = sampleCruiseTrack(track, 0)
  cruiseCurrentState.value = initialState
  cruiseProgressSlider.value = 0

  initCruiseMapOverlays(initialState)

  // 根据当前选定的视角模式初始化视野
  if (cruiseViewMode.value === 'overview') {
    fitCruiseOverview()
  } else {
    // 跟随模式：镜头对准起点
    if (loadedProvider === 'osm' && map) {
      map.setView([initialState.lat, initialState.lng], Math.max(map.getZoom(), 13))
    } else if (loadedProvider === 'amap' && map) {
      map.setZoomAndCenter(Math.max(map.getZoom(), 13), [initialState.lng, initialState.lat])
    }
  }

  cruiseLastTimestamp = performance.now()
  cruiseRafId = requestAnimationFrame(cruiseLoop)
}

/** 将地图视野平滑适配到当前巡游路线全貌（全景模式） */
function fitCruiseOverview() {
  if (!map || !cruiseTrack.value || !cruiseTrack.value.points.length) return
  const pts = cruiseTrack.value.points

  // 顶部 60px，右侧 60px，底部 150px（避开底部的悬浮播放控制面板），左侧 60px
  const padTop = 60
  const padRight = 60
  const padBottom = 150
  const padLeft = 60

  if (loadedProvider === 'osm' && lib) {
    const latlngs = pts.map((p) => [p.lat, p.lng] as [number, number])
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 12)
    } else {
      map.fitBounds(lib.latLngBounds(latlngs), {
        paddingTopLeft: [padLeft, padTop],
        paddingBottomRight: [padRight, padBottom],
        maxZoom: 16,
        animate: true,
      })
    }
  } else if (loadedProvider === 'amap' && lib) {
    let minLng = pts[0].lng
    let maxLng = pts[0].lng
    let minLat = pts[0].lat
    let maxLat = pts[0].lat
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]
      if (p.lng < minLng) minLng = p.lng
      if (p.lng > maxLng) maxLng = p.lng
      if (p.lat < minLat) minLat = p.lat
      if (p.lat > maxLat) maxLat = p.lat
    }
    const bounds = new lib.Bounds([minLng, minLat], [maxLng, maxLat])
    map.setBounds(bounds, false, [padTop, padRight, padBottom, padLeft])
  }
}

/** 切换视角模式：跟随（特写小车） / 全景（显示完整路线） */
function setViewMode(mode: 'follow' | 'overview') {
  cruiseViewMode.value = mode
  if (mode === 'overview') {
    fitCruiseOverview()
  } else {
    // 切换为跟随视角：镜头平滑对准当前小车
    if (cruiseCurrentState.value && map) {
      const { lat, lng } = cruiseCurrentState.value
      if (loadedProvider === 'osm') {
        map.setView([lat, lng], Math.max(map.getZoom(), 13), { animate: true })
      } else if (loadedProvider === 'amap') {
        map.setZoomAndCenter(Math.max(map.getZoom(), 13), [lng, lat])
      }
    }
  }
}

/** 初始化地图巡游小车与已行驶高亮图层 */
function initCruiseMapOverlays(initialState: CruiseState) {
  const allPts = cruiseTrack.value?.points ?? []
  passedBuf = []
  passedBufIdx = -1
  const allCoordsLeaflet = allPts.map((p) => [p.lat, p.lng] as [number, number])
  const allCoordsAmap = allPts.map((p) => [p.lng, p.lat] as [number, number])

  if (loadedProvider === 'osm' && lib && map) {
    if (!cruiseLayerGroup) {
      cruiseLayerGroup = lib.layerGroup().addTo(map)
    }
    cruiseLayerGroup.clearLayers()

    // 1. 巡游整段待行驶规划路线底层纯白外轮廓（彻底剥离地图底图自带黄色/橙色公路）
    cruiseBaseCasingLeaflet = lib
      .polyline(allCoordsLeaflet, {
        color: '#ffffff',
        weight: 10,
        opacity: 0.98,
        lineCap: 'round',
        lineJoin: 'round',
      })
      .addTo(cruiseLayerGroup)

    // 2. 巡游待行驶规划路线中层高反差主线（经典科技深蓝，在浅色/黄色地图底图上清晰浮现）
    cruiseBasePolylineLeaflet = lib
      .polyline(allCoordsLeaflet, {
        color: '#2563eb',
        weight: 6.5,
        opacity: 0.92,
        lineCap: 'round',
        lineJoin: 'round',
      })
      .addTo(cruiseLayerGroup)

    // 3. 小车走过的经过路线（鲜艳醒目的活力自驾暖橙红，覆盖在科技深蓝规划线之上）
    cruisePolylineLeaflet = lib
      .polyline([[initialState.lat, initialState.lng]], {
        color: '#ff5722',
        weight: 7,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      })
      .addTo(cruiseLayerGroup)

    const carIcon = lib.divIcon({
      className: '',
      html: carMarkerHtml(initialState),
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    })

    cruiseCarMarkerLeaflet = lib
      .marker([initialState.lat, initialState.lng], {
        icon: carIcon,
        zIndexOffset: 3000,
      })
      .addTo(cruiseLayerGroup)
  } else if (loadedProvider === 'amap' && lib && map) {
    if (cruiseCarMarkerAmap) map.remove(cruiseCarMarkerAmap)
    if (cruisePolylineAmap) map.remove(cruisePolylineAmap)
    if (cruiseBasePolylineAmap) map.remove(cruiseBasePolylineAmap)
    if (cruiseBaseCasingAmap) map.remove(cruiseBaseCasingAmap)

    // 1. 巡游整段待行驶规划路线底层纯白外轮廓（zIndex: 138，彻底杜绝地图底图公路干扰）
    cruiseBaseCasingAmap = new lib.Polyline({
      path: allCoordsAmap,
      strokeColor: '#ffffff',
      strokeWeight: 10,
      strokeOpacity: 0.98,
      lineCap: 'round',
      lineJoin: 'round',
      zIndex: 138,
    })
    map.add(cruiseBaseCasingAmap)

    // 2. 巡游待行驶规划路线中层高对比主线（科技深蓝，zIndex: 140）
    cruiseBasePolylineAmap = new lib.Polyline({
      path: allCoordsAmap,
      strokeColor: '#2563eb',
      strokeWeight: 6.5,
      strokeOpacity: 0.92,
      lineCap: 'round',
      lineJoin: 'round',
      zIndex: 140,
    })
    map.add(cruiseBasePolylineAmap)

    // 3. 小车走过的经过路线（活力自驾暖橙红，zIndex: 150 覆盖于深蓝规划线之上）
    cruisePolylineAmap = new lib.Polyline({
      path: [[initialState.lng, initialState.lat]],
      strokeColor: '#ff5722',
      strokeWeight: 7,
      strokeOpacity: 1,
      lineCap: 'round',
      lineJoin: 'round',
      zIndex: 150,
    })
    map.add(cruisePolylineAmap)

    cruiseCarMarkerAmap = new lib.Marker({
      position: [initialState.lng, initialState.lat],
      content: carMarkerHtml(initialState),
      anchor: 'center',
      zIndex: 3000,
    })
    map.add(cruiseCarMarkerAmap)
  }
}

/** 退出并清理巡游播放 */
function stopCruise() {
  cruiseActive.value = false
  cruisePlaying.value = false
  if (cruiseRafId !== null) {
    cancelAnimationFrame(cruiseRafId)
    cruiseRafId = null
  }
  cruiseLastTimestamp = null

  if (loadedProvider === 'osm' && cruiseLayerGroup) {
    cruiseLayerGroup.clearLayers()
    cruiseCarMarkerLeaflet = null
    cruisePolylineLeaflet = null
    cruiseBasePolylineLeaflet = null
    cruiseBaseCasingLeaflet = null
  } else if (loadedProvider === 'amap' && map) {
    if (cruiseCarMarkerAmap) {
      map.remove(cruiseCarMarkerAmap)
      cruiseCarMarkerAmap = null
    }
    if (cruisePolylineAmap) {
      map.remove(cruisePolylineAmap)
      cruisePolylineAmap = null
    }
    if (cruiseBasePolylineAmap) {
      map.remove(cruiseBasePolylineAmap)
      cruiseBasePolylineAmap = null
    }
    if (cruiseBaseCasingAmap) {
      map.remove(cruiseBaseCasingAmap)
      cruiseBaseCasingAmap = null
    }
  }

  cruiseTrack.value = null
  cruiseCurrentState.value = null

  // 恢复普通路线视野
  redraw()
}

/** 切换播放/暂停 */
function togglePlay() {
  if (!cruiseActive.value || !cruiseTrack.value) return
  cruisePlaying.value = !cruisePlaying.value

  if (cruisePlaying.value) {
    // 若已到终点，重新从起点开始
    if (cruiseDist.value >= cruiseTrack.value.totalDistance) {
      cruiseDist.value = 0
    }
    cruiseLastTimestamp = performance.now()
    cruiseRafId = requestAnimationFrame(cruiseLoop)
  } else {
    if (cruiseRafId !== null) {
      cancelAnimationFrame(cruiseRafId)
      cruiseRafId = null
    }
  }
}

/** 从头重新巡游 */
function restartCruise() {
  if (!cruiseTrack.value) return
  cruiseDist.value = 0
  cruisePlaying.value = true
  updateCruiseFrame()
  cruiseLastTimestamp = performance.now()
  if (cruiseRafId !== null) cancelAnimationFrame(cruiseRafId)
  cruiseRafId = requestAnimationFrame(cruiseLoop)
}

/** 切换单天或全天范围 */
function handleRangeChange() {
  if (!store.trip) return
  const track = buildCruiseTrack(
    store.trip,
    cruiseRange.value,
    store.legPaths,
    store.routePointsOf,
  )
  if (!track || track.points.length < 2) {
    store.notify('所选天数暂无可行驶路线', 'error')
    return
  }

  cruiseTrack.value = track
  cruiseDist.value = 0
  cruisePlaying.value = true
  const state = sampleCruiseTrack(track, 0)
  cruiseCurrentState.value = state
  initCruiseMapOverlays(state)
  updateCruiseFrame()

  if (cruiseViewMode.value === 'overview') {
    fitCruiseOverview()
  } else {
    if (loadedProvider === 'osm' && map) {
      map.panTo([state.lat, state.lng])
    } else if (loadedProvider === 'amap' && map) {
      map.panTo([state.lng, state.lat])
    }
  }

  cruiseLastTimestamp = performance.now()
  if (cruiseRafId !== null) cancelAnimationFrame(cruiseRafId)
  cruiseRafId = requestAnimationFrame(cruiseLoop)
}

/** 拖拽进度条 */
function onProgressSliderInput(e: Event) {
  if (!cruiseTrack.value) return
  const val = Number((e.target as HTMLInputElement).value)
  cruiseProgressSlider.value = val
  cruiseDist.value = (val / 1000) * cruiseTrack.value.totalDistance
  updateCruiseFrame()
}

/** 帧动画主循环 */
function cruiseLoop(timestamp: number) {
  if (!cruiseActive.value || !cruisePlaying.value || !cruiseTrack.value) return

  const lastTime = cruiseLastTimestamp ?? timestamp
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1) // 限制最大 0.1s 防止切后台卡顿跳跃
  cruiseLastTimestamp = timestamp

  // 根据总里程自适应基准速度（全长约 28~45 秒），并叠加倍速系数
  const total = cruiseTrack.value.totalDistance
  const baseTimeSec = Math.max(22, Math.min(50, (total / 1000) * 0.18 + 20))
  const v0 = total / baseTimeSec
  const v = v0 * cruiseSpeed.value

  cruiseDist.value += v * dt

  if (cruiseDist.value >= total) {
    cruiseDist.value = total
    cruisePlaying.value = false
    updateCruiseFrame()
    if (isRecording.value) {
      void finishRecording()
    } else {
      store.notify('🎉 巡游播放完成！')
    }
    return
  }

  updateCruiseFrame()
  cruiseRafId = requestAnimationFrame(cruiseLoop)
}

/** 增量维护已行驶路线：前进时只追加新顶点，拖回进度时截断，末尾始终是小车当前位置 */
function syncPassedBuffer(state: CruiseState): [number, number][] {
  const pts = cruiseTrack.value?.points ?? []
  const toPair = (lng: number, lat: number): [number, number] =>
    loadedProvider === 'osm' ? [lat, lng] : [lng, lat]
  if (passedBuf.length === passedBufIdx + 2) passedBuf.pop() // 去掉上一帧的小车位置
  const want = Math.min(state.passedIdx, pts.length - 1)
  if (want < passedBufIdx) {
    passedBuf.length = want + 1
  } else {
    for (let i = passedBufIdx + 1; i <= want; i++) passedBuf.push(toPair(pts[i].lng, pts[i].lat))
  }
  passedBufIdx = want
  passedBuf.push(toPair(state.lng, state.lat))
  return passedBuf
}

/** 采样并同步渲染小轿车位置、旋转与车顶城市地点信息 */
function updateCruiseFrame() {
  if (!cruiseTrack.value) return

  const state = sampleCruiseTrack(cruiseTrack.value, cruiseDist.value)
  cruiseCurrentState.value = state
  cruiseProgressSlider.value = Math.round(state.progress * 1000)

  // 1. 同步小车经纬度与走过路线
  const passed = syncPassedBuffer(state)
  if (loadedProvider === 'osm') {
    cruiseCarMarkerLeaflet?.setLatLng([state.lat, state.lng])
    cruisePolylineLeaflet?.setLatLngs(passed)
    if (cruiseViewMode.value === 'follow' && map) {
      map.panTo([state.lat, state.lng], { animate: false })
    }
  } else if (loadedProvider === 'amap') {
    cruiseCarMarkerAmap?.setPosition([state.lng, state.lat])
    cruisePolylineAmap?.setPath(passed.slice()) // 高德可能持有数组引用，传浅拷贝避免下帧修改影响其内部状态
    if (cruiseViewMode.value === 'follow' && map) {
      map.panTo([state.lng, state.lat])
    }
  }

  // 2. DOM 高性能直接更新车身旋转角与车顶文字（避免整个 Marker HTML 重新解析）
  const carHull = document.getElementById('cruise-car-hull')
  if (carHull) {
    carHull.style.transform = `rotate(${Math.round(state.heading)}deg)`
  }

  const cityEl = document.getElementById('cruise-roof-city')
  if (cityEl) {
    cityEl.textContent = state.city
  }

  const placeEl = document.getElementById('cruise-roof-place')
  if (placeEl) {
    placeEl.textContent = state.place
    placeEl.title = state.place
  }

  const statusEl = document.getElementById('cruise-roof-status')
  if (statusEl) {
    statusEl.textContent = state.statusText
  }
}

// ───────────────────────── 16:9 巡游视频录制与导出 ─────────────────────────

function openExportModal() {
  if (!store.trip) {
    store.notify('请先打开或创建一份路书', 'error')
    return
  }
  exportSpeed.value = cruiseSpeed.value || 1
  exportIsOverview.value = cruiseViewMode.value === 'overview'
  exportRange.value = cruiseRange.value || 'all'
  exportModalOpen.value = true
}

let hasTriggeredDownload = false

function safeTriggerVideoDownload(blob: Blob) {
  if (hasTriggeredDownload) return
  hasTriggeredDownload = true

  const title = store.trip?.title || '自驾路线'
  const viewName = exportIsOverview.value ? '全景' : '跟随'
  const fmt = downloadVideoBlob(blob, `${title}-巡游视频-16比9-${viewName}`)
  store.notify(
    fmt.ext === 'mp4'
      ? '🎉 16:9 巡游 MP4 视频已成功导出并下载！'
      : '🎉 视频已导出为 WebM（当前浏览器不支持录制 MP4，如需 MP4 请用新版 Chrome / Edge）',
  )
}

async function startExportVideo() {
  if (!store.trip) return
  if (!isVideoRecordingSupported()) {
    store.notify('当前浏览器不支持屏幕视频录制，建议使用 Chrome 或 Edge 浏览器', 'error')
    return
  }

  exportModalOpen.value = false
  hasTriggeredDownload = false

  // 1. 应用用户选定的参数（速度、是否全景、天数范围）
  cruiseSpeed.value = exportSpeed.value
  cruiseViewMode.value = exportIsOverview.value ? 'overview' : 'follow'
  cruiseRange.value = exportRange.value

  const track = buildCruiseTrack(
    store.trip,
    cruiseRange.value,
    store.legPaths,
    store.routePointsOf,
  )

  if (!track || track.points.length < 2) {
    store.notify('当前路线暂无可行驶路段，请先添加至少 2 个地点', 'error')
    return
  }

  cruiseTrack.value = track
  cruiseDist.value = 0
  cruiseActive.value = true
  cruisePlaying.value = false // 先暂停，等待录制会话就绪后同步开始

  const initialState = sampleCruiseTrack(track, 0)
  cruiseCurrentState.value = initialState
  cruiseProgressSlider.value = 0
  initCruiseMapOverlays(initialState)

  // 2. 进入 16:9 纯净录制视口画框模式（彻底隐藏控制面板与窗口内容）
  isRecording.value = true
  recordingSeconds.value = 0

  await nextTick()
  if (loadedProvider === 'osm' && map) map.invalidateSize()

  if (cruiseViewMode.value === 'overview') {
    fitCruiseOverview()
  } else {
    if (loadedProvider === 'osm' && map) {
      map.setView([initialState.lat, initialState.lng], Math.max(map.getZoom(), 13))
    } else if (loadedProvider === 'amap' && map) {
      map.setZoomAndCenter(Math.max(map.getZoom(), 13), [initialState.lng, initialState.lat])
    }
  }

  // 延时等待地图瓦片和布局渲染平稳
  await new Promise((r) => setTimeout(r, 260))

  try {
    store.notify('请在浏览器弹出窗口中选择「此标签页」开始 16:9 视频录制')
    const targetMapEl = el.value!
    const session = await start16x9Recording({
      targetElement: targetMapEl,
      width: 1920,
      height: 1080,
      fps: 30,
      onAutoStop: (blob) => {
        if (isRecording.value) {
          isRecording.value = false
          activeRecordingSession = null
          if (recordingTimer) clearInterval(recordingTimer)
          safeTriggerVideoDownload(blob)
        }
      },
    })

    // 等待用户授权期间录制可能已被取消（关闭地图、切换数据源等），此时直接丢弃会话
    if (!isRecording.value) {
      session.cancel()
      return
    }

    activeRecordingSession = session
    recordingTimer = window.setInterval(() => {
      recordingSeconds.value++
    }, 1000)

    // 启动小轿车巡游动画
    cruisePlaying.value = true
    cruiseLastTimestamp = performance.now()
    if (cruiseRafId !== null) cancelAnimationFrame(cruiseRafId)
    cruiseRafId = requestAnimationFrame(cruiseLoop)
  } catch (err: any) {
    isRecording.value = false
    activeRecordingSession = null
    store.notify(err?.message || '屏幕录制启动失败', 'error')
    void nextTick(() => {
      if (loadedProvider === 'osm' && map) map.invalidateSize()
      redraw()
    })
  }
}

async function finishRecording() {
  if (recordingTimer !== null) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  if (!activeRecordingSession) return

  store.notify('正在生成 16:9 巡游视频文件…')
  try {
    const session = activeRecordingSession
    activeRecordingSession = null
    const blob = await session.stop()
    isRecording.value = false

    void nextTick(() => {
      if (loadedProvider === 'osm' && map) map.invalidateSize()
      redraw()
    })

    safeTriggerVideoDownload(blob)
  } catch (err: any) {
    isRecording.value = false
    store.notify(err?.message || '视频生成失败', 'error')
  }
}

/** 非用户主动的中止（地图关闭 / 组件卸载 / 切换数据源）：停止屏幕共享与计时，不生成文件 */
function abortRecording(reason?: string) {
  if (!isRecording.value && !activeRecordingSession) return
  if (recordingTimer !== null) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  activeRecordingSession?.cancel()
  activeRecordingSession = null
  isRecording.value = false
  cruisePlaying.value = false
  if (reason) store.notify(reason, 'error')
}

function cancelRecording() {
  if (recordingTimer !== null) {
    clearInterval(recordingTimer)
    recordingTimer = null
  }
  if (activeRecordingSession) {
    activeRecordingSession.cancel()
    activeRecordingSession = null
  }
  isRecording.value = false
  cruisePlaying.value = false
  void nextTick(() => {
    if (loadedProvider === 'osm' && map) map.invalidateSize()
    redraw()
  })
  store.notify('已取消视频录制')
}
</script>

<template>
  <div class="mapwrap" :class="{ 'map-open': store.mapOpen, 'picker-open': store.pickerOpen, 'in-cruise': cruiseActive, 'recording-16-9': isRecording }">
    <div ref="el" class="map"></div>

    <!-- 地图右上角操作栏：巡游模式按钮 + 导出视频 + 关闭地图按钮 -->
    <div v-if="!store.pickerOpen && !isRecording" class="map-top-bar">
      <button
        class="btn map-cruise-btn btn-export-entry"
        title="配置并导出 16:9 巡游视频"
        @click="openExportModal"
      >
        🎬 导出视频
      </button>
      <button
        class="btn map-cruise-btn"
        :class="{ 'btn-primary': !cruiseActive, 'btn-cruise-active': cruiseActive }"
        :title="cruiseActive ? '退出巡游播放模式' : '开启小车巡游播放模式'"
        @click="toggleCruiseMode"
      >
        🚗 {{ cruiseActive ? '退出巡游' : '巡游播放' }}
      </button>
      <button class="map-close btn" @click="store.closeMap()">✕ 关闭地图</button>
    </div>

    <!-- 选点提示 -->
    <div v-if="store.pickTarget && !store.pickerOpen" class="pick-hint">
      <span>正在地图选点：{{ pickLabel() }}（点击地图确认）</span>
      <button class="btn btn-mini" @click="store.pickTarget = null">取消</button>
    </div>

    <!-- 正在录制 16:9 视频悬浮状态条 -->
    <div v-if="isRecording" class="recording-bar-float">
      <div class="recording-pulse-dot"></div>
      <div class="recording-bar-text">
        <span class="recording-bold">16:9 录制中</span>
        <span class="recording-time">{{ recordingSeconds }}s</span>
        <span class="recording-status">{{ cruiseCurrentState?.city || '途经城市' }} · {{ cruiseCurrentState?.place || '自驾沿途' }}</span>
      </div>
      <div class="recording-bar-actions">
        <button class="btn btn-mini btn-record-finish" @click="finishRecording">
          ⏹ 完成并导出
        </button>
        <button class="btn btn-mini btn-record-cancel" @click="cancelRecording">
          ✕ 取消
        </button>
      </div>
    </div>

    <!-- 巡游播放控制器浮层：普通巡游时显示，16:9 录制时纯净隐藏，不录入任何窗口内容 -->
    <div v-if="cruiseActive && !isRecording" class="cruise-panel-float">
      <div class="cruise-panel-card">
        <!-- 顶部信息栏：经过城市与地点高亮 -->
        <div class="cruise-roof-headline">
          <div class="cruise-headline-left">
            <span class="cruise-badge-pulse">● 巡游中</span>
            <span class="cruise-range-tag">{{ cruiseTrack?.targetLabel || '自驾路线' }}</span>
          </div>
          <div class="cruise-headline-center">
            <span class="cruise-city-highlight">{{ cruiseCurrentState?.city || '途经城市' }}</span>
            <span class="cruise-divider">·</span>
            <span class="cruise-place-highlight" :title="cruiseCurrentState?.place">{{ cruiseCurrentState?.place || '自驾沿途' }}</span>
          </div>
          <div class="cruise-headline-right">
            <span class="cruise-km-text">{{ fmtDistance(cruiseCurrentState?.currentDist || 0) }} / {{ fmtDistance(cruiseTrack?.totalDistance || 0) }}</span>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="cruise-slider-box">
          <input
            type="range"
            min="0"
            max="1000"
            step="1"
            :value="cruiseProgressSlider"
            @input="onProgressSliderInput"
            class="cruise-slider"
          />
        </div>

        <!-- 底部控制按钮行 -->
        <div class="cruise-controls-row">
          <div class="cruise-ctrl-btns">
            <!-- 播放/暂停 -->
            <button
              class="cruise-action-btn cruise-play-btn"
              :title="cruisePlaying ? '暂停播放' : '继续播放'"
              @click="togglePlay"
            >
              {{ cruisePlaying ? '⏸' : '▶' }}
            </button>
            <!-- 重新开始 -->
            <button
              class="cruise-action-btn"
              title="从头开始巡游"
              @click="restartCruise"
            >
              ↺
            </button>
          </div>

          <!-- 倍速调节 -->
          <div class="cruise-speed-pills">
            <button
              v-for="s in [1, 2, 4, 8]"
              :key="s"
              class="cruise-speed-pill"
              :class="{ active: cruiseSpeed === s }"
              @click="cruiseSpeed = s"
            >
              {{ s }}x
            </button>
          </div>

          <!-- 视角模式切换：跟随 / 全景 -->
          <div class="cruise-view-group">
            <button
              class="cruise-view-pill"
              :class="{ active: cruiseViewMode === 'follow' }"
              title="跟随视角：镜头锁定跟随小轿车特写"
              @click="setViewMode('follow')"
            >
              🎯 跟随
            </button>
            <button
              class="cruise-view-pill"
              :class="{ active: cruiseViewMode === 'overview' }"
              title="全景视角：画面中显示完整规划路线"
              @click="setViewMode('overview')"
            >
              🌐 全景
            </button>
          </div>

          <!-- 路线天数范围选择 -->
          <select
            v-if="store.trip && store.trip.days.length > 1"
            v-model="cruiseRange"
            class="cruise-range-select"
            @change="handleRangeChange"
          >
            <option value="all">全程自驾</option>
            <option v-for="(d, i) in store.trip.days" :key="d.id" :value="d.id">
              第 {{ i + 1 }} 天
            </option>
          </select>

          <!-- 导出视频按钮 -->
          <button
            class="cruise-action-btn cruise-export-btn"
            title="配置并导出 16:9 巡游视频"
            @click="openExportModal"
          >
            🎬
          </button>

          <!-- 关闭退出 -->
          <button
            class="cruise-action-btn cruise-close-btn"
            title="退出巡游播放"
            @click="stopCruise"
          >
            ✕
          </button>
        </div>
      </div>
    </div>

    <!-- 导出 16:9 巡游视频配置弹窗 -->
    <div v-if="exportModalOpen" class="modal-backdrop" @click="exportModalOpen = false">
      <div class="modal-card export-video-modal" @click.stop>
        <div class="modal-head">
          <div class="modal-title-row">
            <span class="modal-icon">🎬</span>
            <h3>导出 16:9 巡游视频</h3>
          </div>
          <button class="modal-close-btn" @click="exportModalOpen = false" title="关闭">✕</button>
        </div>

        <div class="modal-body export-body">
          <p class="export-subtitle">生成高清自驾路线巡游动画视频，按照 16:9 画幅录制导出，可直接分享至各大视频平台与朋友圈。</p>

          <!-- 1. 速度选择 -->
          <div class="export-field">
            <label class="export-label">⏱️ 播放速度</label>
            <div class="export-pill-group">
              <button
                v-for="s in [1, 2, 4, 8]"
                :key="s"
                class="export-pill-btn"
                :class="{ active: exportSpeed === s }"
                @click="exportSpeed = s"
              >
                <span class="speed-text">{{ s }}x</span>
                <span v-if="s === 1" class="speed-sub-tag">默认</span>
              </button>
            </div>
            <div class="export-hint">预估视频录制时长约 {{ estimateRecordSeconds }} 秒</div>
          </div>

          <!-- 2. 是否全景 -->
          <div class="export-field">
            <label class="export-label">📐 视角模式（是否全景）</label>
            <div class="export-view-cards">
              <div
                class="export-view-card"
                :class="{ active: exportIsOverview }"
                @click="exportIsOverview = true"
              >
                <div class="export-view-icon-wrap icon-blue">🌐</div>
                <div class="export-view-info">
                  <div class="export-view-title-row">
                    <span class="export-view-title">全景视角</span>
                    <span class="export-badge-tag">推荐</span>
                  </div>
                  <div class="export-view-desc">画面中完整展示全程规划路线与地理全貌</div>
                </div>
                <div class="export-check-dot"></div>
              </div>

              <div
                class="export-view-card"
                :class="{ active: !exportIsOverview }"
                @click="exportIsOverview = false"
              >
                <div class="export-view-icon-wrap icon-orange">🎯</div>
                <div class="export-view-info">
                  <div class="export-view-title-row">
                    <span class="export-view-title">跟随视角</span>
                  </div>
                  <div class="export-view-desc">镜头特写跟拍小轿车与沿途经过站点城市</div>
                </div>
                <div class="export-check-dot"></div>
              </div>
            </div>
          </div>

          <!-- 3. 路线范围（多天时） -->
          <div v-if="store.trip && store.trip.days.length > 1" class="export-field">
            <label class="export-label">🗺️ 路线范围</label>
            <select v-model="exportRange" class="export-select">
              <option value="all">全程自驾路线</option>
              <option v-for="(d, i) in store.trip.days" :key="d.id" :value="d.id">
                第 {{ i + 1 }} 天自驾路线
              </option>
            </select>
          </div>

          <div class="export-feature-note">
            <div class="feature-item"><span>🎬</span> 新版 Chrome / Edge 导出 .mp4；其他浏览器导出 .webm</div>
            <div class="feature-item"><span>📐</span> 严格按 16:9 画幅录制并居中重采样</div>
            <div class="feature-item"><span>🚗</span> 包含动态小轿车、车顶途经城市地点标签与高亮行车路线</div>
            <div class="feature-item"><span>💡</span> 点击后请在浏览器共享弹窗中选择「当前标签页」开始</div>
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn btn-secondary" @click="exportModalOpen = false">取消</button>
          <button class="btn btn-primary export-start-btn" @click="startExportVideo">
            ▶ 开始录制并导出
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
