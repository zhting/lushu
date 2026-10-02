<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useTripStore } from '../stores/trip'
import { loadMapLib, reverseGeocode } from '../services/map'
import { cnOrdinal } from '../services/geo'
import { DAY_COLORS } from '../constants'
import type { Stop, Trip } from '../types'

const store = useTripStore()
const el = ref<HTMLDivElement | null>(null)

let map: any = null
let lib: any = null
let layerGroup: any = null // Leaflet 图层组（行程地点）
let pickerLayer: any = null // Leaflet 图层组（选点页搜索结果）
let overlays: any[] = [] // AMap 覆盖物
let pickerOverlays: any[] = [] // AMap：选点页搜索结果标记
let infoWindow: any = null
let loading = false
let loadedProvider: string | null = null

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

watch(
  () => store.mapCfg.provider,
  () => {
    if (map) destroyMap()
    tryInit()
  },
)

// 移动端展开地图浮层：容器从 display:none 变为全屏，需要等布局稳定后重算尺寸并重绘适配视野
watch(
  () => store.mapOpen,
  (open) => {
    if (!open) return
    void nextTick(() => {
      if (!map) {
        tryInit()
        return
      }
      requestAnimationFrame(() => {
        if (loadedProvider === 'osm') map.invalidateSize()
        redraw()
        // 双重保险：布局完全稳定后再校正一次尺寸
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
      map.on('click', onMapClickLeaflet)
      window.addEventListener('resize', invalidateSize)
    }
    loadedProvider = provider
    redraw()
    // 地图库就绪：之前因库未加载而失败的线路/距离拉取在此重试
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

function markerHtml(color: string, text: string, main: boolean): string {
  return `<div class="mk ${main ? 'mk-main' : ''}" style="--mk:${color}">${text}</div>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function popupHtml(s: Stop): string {
  return (
    `<div class="mk-info"><b>${escapeHtml(s.name)}</b>` +
    (s.address ? `<br/><span style="color:#68758a">${escapeHtml(s.address)}</span>` : '') +
    '</div>'
  )
}

interface Mark {
  s: Stop
  color: string
  text: string
  main: boolean
}

/** 单日视角：当天 起 → 序号 → 终 */
function dayMarks(trip: Trip, dayId: string): Mark[] {
  const day = trip.days.find((d) => d.id === dayId)
  if (!day) return []
  const color = DAY_COLORS[trip.days.indexOf(day) % DAY_COLORS.length]
  return store.routePointsOf(dayId).map((s, i, seq) => {
    const isEnd = i === seq.length - 1
    return { s, color, text: i === 0 ? '起' : isEnd ? '终' : String(i), main: i === 0 || isEnd }
  })
}

/** 总览视角：全程统一编号 —— 首点 起，末点 终，中间从 1 顺次（颜色仍按天） */
function globalMarks(trip: Trip): Mark[] {
  const all: { s: Stop; color: string }[] = []
  trip.days.forEach((day, di) => {
    const color = DAY_COLORS[di % DAY_COLORS.length]
    for (const s of day.stops) all.push({ s, color })
  })
  const total = all.length
  return all.map((m, i) => ({
    s: m.s,
    color: m.color,
    text: total === 1 ? '起' : i === 0 ? '起' : i === total - 1 ? '终' : String(i),
    main: i === 0 || i === total - 1,
  }))
}

function redraw() {
  if (!map || !containerVisible()) return
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
    // 点序列（次日默认从前一天终点出发，首段为跨天接续的直线）
    const seq = store.routePointsOf(day.id)

    if (seq.length > 1) {
      // 车行导航线路（逐段拼接）；尚未取到时回退直线虚线示意
      const drivePath = store.legPaths[day.id]
      const real = !!drivePath && drivePath.length > 1
      const line = new AMap.Polyline({
        path: real ? drivePath! : seq.map((s) => [s.lng, s.lat]),
        strokeColor: color,
        strokeWeight: dayView ? 6 : 4,
        strokeOpacity: 0.9,
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

  // 标记：总览 = 全程统一编号（起 → 1..N → 终）；单日 = 当天起终与序号
  const marks = store.view === 'overview' ? globalMarks(trip) : dayMarks(trip, store.view)
  for (const m of marks) {
    const marker = new AMap.Marker({
      position: [m.s.lng, m.s.lat],
      content: markerHtml(m.color, m.text, m.main),
      anchor: 'center',
      zIndex: 120,
    })
    marker.on('click', () => {
      infoWindow.setContent(popupHtml(m.s))
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
  const bounds: [number, number][] = [] // [lat, lng]

  for (const day of days) {
    const idx = trip.days.indexOf(day)
    const color = DAY_COLORS[idx % DAY_COLORS.length]
    const seq = store.routePointsOf(day.id)

    if (seq.length > 1) {
      // 车行导航线路（逐段拼接）；尚未取到时回退直线虚线示意
      const drivePath = store.legPaths[day.id]
      const real = !!drivePath && drivePath.length > 1
      const latlngs = real
        ? drivePath!.map(([lng, lat]) => [lat, lng] as [number, number])
        : seq.map((s) => [s.lat, s.lng] as [number, number])
      lib
        .polyline(latlngs, {
          color,
          weight: dayView ? 6 : 4,
          opacity: 0.9,
          dashArray: real ? undefined : '6 8',
          lineJoin: 'round',
          lineCap: 'round',
        })
        .addTo(layerGroup)
      bounds.push(...latlngs)
    }
  }

  // 标记：总览 = 全程统一编号（起 → 1..N → 终）；单日 = 当天起终与序号
  const marks = store.view === 'overview' ? globalMarks(trip) : dayMarks(trip, store.view)
  for (const m of marks) {
    const size = m.main ? 30 : 26
    const icon = lib.divIcon({
      className: '',
      html: markerHtml(m.color, m.text, m.main),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    })
    const marker = lib.marker([m.s.lat, m.s.lng], { icon }).addTo(layerGroup)
    marker.bindPopup(popupHtml(m.s))
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
        html: markerHtml('#2f6bed', String(i + 1), true),
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
        content: markerHtml('#2f6bed', String(i + 1), true),
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

// 选点页打开/关闭会改变地图容器尺寸（桌面端全屏 ⇄ 侧栏），需要重算尺寸并重绘
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

watch(() => [store.view, store.trip, store.legPaths], () => redraw(), { deep: true })

const pickLabel = () => {
  const t = store.pickTarget
  if (!t || !store.trip) return ''
  const i = store.trip.days.findIndex((d) => d.id === t.dayId)
  return `第${cnOrdinal(i + 1)}天`
}
</script>

<template>
  <div class="mapwrap" :class="{ 'map-open': store.mapOpen, 'picker-open': store.pickerOpen }">
    <div ref="el" class="map"></div>
    <button v-if="!store.pickerOpen" class="map-close btn" @click="store.closeMap()">✕ 关闭地图</button>
    <div v-if="store.pickTarget && !store.pickerOpen" class="pick-hint">
      <span>正在地图选点：{{ pickLabel() }}（点击地图确认）</span>
      <button class="btn btn-mini" @click="store.pickTarget = null">取消</button>
    </div>
  </div>
</template>
