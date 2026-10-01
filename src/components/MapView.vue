<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { pathCache, useTripStore } from '../stores/trip'
import { loadMapLib, reverseGeocode } from '../services/map'
import { DAY_COLORS } from '../constants'
import type { Stop } from '../types'

const store = useTripStore()
const el = ref<HTMLDivElement | null>(null)

let map: any = null
let lib: any = null
let layerGroup: any = null // Leaflet 图层组
let overlays: any[] = [] // AMap 覆盖物
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
  if (store.setupDone) tryInit()
})

watch(
  () => store.setupDone,
  (v) => {
    if (v) tryInit()
  },
)

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
      map.on('click', onMapClickLeaflet)
      window.addEventListener('resize', invalidateSize)
    }
    loadedProvider = provider
    redraw()
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
  overlays = []
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
    // 参与路线的点序列（次日默认从前一天终点出发）
    const seq = store.routePointsOf(day.id)
    const fromPrev = idx > 0 && day.startAuto && day.stops.length > 0 && seq[0] !== day.stops[0]
    const meta = store.routes[day.id]
    const path = meta?.status === 'done' ? pathCache.get(meta.hash) : undefined

    if (path && path.length > 1 && seq.length >= 2) {
      const line = new AMap.Polyline({
        path,
        strokeColor: color,
        strokeWeight: dayView ? 7 : 5,
        strokeOpacity: 0.92,
        showDir: true,
        lineJoin: 'round',
        lineCap: 'round',
        zIndex: 50,
      })
      map.add(line)
      overlays.push(line)
    }

    seq.forEach((s, i) => {
      // 总览下，继承自前一天终点的起点不再重复画标记（前一天已画过「终」）
      if (i === 0 && fromPrev && store.view === 'overview') return
      const isEnd = i === seq.length - 1
      const text = i === 0 ? '起' : isEnd ? '终' : String(i)
      const marker = new AMap.Marker({
        position: [s.lng, s.lat],
        content: markerHtml(color, text, i === 0 || isEnd),
        anchor: 'center',
        zIndex: 120,
      })
      marker.on('click', () => {
        infoWindow.setContent(popupHtml(s))
        infoWindow.open(map, [s.lng, s.lat])
      })
      map.add(marker)
      overlays.push(marker)
    })
  }

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
    const fromPrev = idx > 0 && day.startAuto && day.stops.length > 0 && seq[0] !== day.stops[0]
    const meta = store.routes[day.id]
    const path = meta?.status === 'done' ? pathCache.get(meta.hash) : undefined

    if (path && path.length > 1 && seq.length >= 2) {
      const latlngs = path.map(([lng, lat]) => [lat, lng] as [number, number])
      lib
        .polyline(latlngs, { color, weight: dayView ? 7 : 5, opacity: 0.92, lineJoin: 'round', lineCap: 'round' })
        .addTo(layerGroup)
      bounds.push(...latlngs)
    }

    seq.forEach((s, i) => {
      // 总览下，继承自前一天终点的起点不再重复画标记（前一天已画过「终」）
      if (i === 0 && fromPrev && store.view === 'overview') return
      const isEnd = i === seq.length - 1
      const text = i === 0 ? '起' : isEnd ? '终' : String(i)
      const size = i === 0 || isEnd ? 30 : 26
      const icon = lib.divIcon({
        className: '',
        html: markerHtml(color, text, i === 0 || isEnd),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      })
      const marker = lib.marker([s.lat, s.lng], { icon }).addTo(layerGroup)
      marker.bindPopup(popupHtml(s))
      bounds.push([s.lat, s.lng])
    })
  }

  if (bounds.length === 1) map.setView(bounds[0], 13)
  else if (bounds.length) map.fitBounds(lib.latLngBounds(bounds), { padding: [70, 90], maxZoom: 15, animate: false })
}

watch(() => [store.view, store.trip, store.routes], () => redraw(), { deep: true })

const pickLabel = (() => {
  const slotNames = { start: '起点', end: '终点', waypoint: '途经点' } as const
  return () => {
    const t = store.pickTarget
    if (!t || !store.trip) return ''
    const i = store.trip.days.findIndex((d) => d.id === t.dayId)
    return `Day ${i + 1} · ${slotNames[t.slot]}`
  }
})()
</script>

<template>
  <div class="mapwrap" :class="{ 'map-open': store.mapOpen }">
    <div ref="el" class="map"></div>
    <button class="map-close btn" @click="store.mapOpen = false">✕ 关闭地图</button>
    <div v-if="store.pickTarget" class="pick-hint">
      <span>正在地图选点：{{ pickLabel() }}（点击地图确认）</span>
      <button class="btn btn-mini" @click="store.pickTarget = null">取消</button>
    </div>
  </div>
</template>
