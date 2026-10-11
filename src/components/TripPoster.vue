<script setup lang="ts">
import { computed } from 'vue'
import { useTripStore } from '../stores/trip'
import { cnOrdinal, dateOfDay, fmtDate, fmtDistance, fmtDuration } from '../services/geo'
import { fmtClock, fmtStay, fmtYuan } from '../services/schedule'
import { DAY_COLORS, ENERGY_META } from '../constants'

/** 长图版路书：只用于导出图片，渲染在屏幕外，宽 750px */
const store = useTripStore()
const t = computed(() => store.trip!)
const totals = computed(() => store.tripTotals)
const site = typeof location !== 'undefined' ? location.host : ''

const dateRange = computed(() => {
  const n = t.value.days.length
  const a = fmtDate(dateOfDay(t.value.startDate, 0))
  if (n <= 1) return a
  return `${a} 至 ${fmtDate(dateOfDay(t.value.startDate, n - 1))}`
})

function stopTime(dayId: string, j: number, total: number): string {
  const sc = store.schedules[dayId]
  if (!sc) return ''
  if (j === 0) return total > 1 ? `${fmtClock(sc.departMin)} 出发` : ''
  const arr = sc.arrive[j]
  const d = store.trip?.days.find((x) => x.id === dayId)
  const stay = d?.stops[j].stayMinutes ?? 0
  const parts: string[] = []
  if (arr != null) parts.push(`${fmtClock(arr)} 到`)
  if (j < total - 1 && stay) parts.push(`停留 ${fmtStay(stay)}`)
  return parts.join(' · ')
}

function legText(dayId: string, j: number): string {
  const dist = store.legDistances[dayId]?.[j]
  const dur = store.legDurations[dayId]?.[j]
  if (dist == null) return ''
  return dur ? `${fmtDistance(dist)} · ${fmtDuration(dur)}` : fmtDistance(dist)
}
</script>

<template>
  <div class="poster">
    <div class="poster-hero">
      <img src="/images/trip_hero.jpg" alt="" class="poster-hero-img" />
      <div class="poster-hero-mask"></div>
      <div class="poster-hero-text">
        <div class="poster-brand">小鹿路书</div>
        <div class="poster-title">{{ t.title }}</div>
        <div class="poster-sub">{{ dateRange }} · {{ t.days.length }} 天</div>
      </div>
    </div>

    <div class="poster-totals">
      <div><span>总里程</span><b>{{ totals.distanceM ? fmtDistance(totals.distanceM) : '—' }}</b></div>
      <div><span>驾驶</span><b>{{ fmtDuration(totals.driveS) || '—' }}</b></div>
      <div>
        <span>{{ ENERGY_META[store.vehicle.energy].costLabel }}{{ totals.tolls != null ? '+过路费' : '' }}</span>
        <b>{{ totals.distanceM ? fmtYuan(totals.energy + (totals.tolls ?? 0)) : '—' }}</b>
      </div>
    </div>

    <div v-for="(d, i) in t.days" :key="d.id" class="poster-day">
      <div class="poster-day-head">
        <span class="poster-day-badge" :style="{ background: DAY_COLORS[i % DAY_COLORS.length] }">D{{ i + 1 }}</span>
        <span class="poster-day-title">第{{ cnOrdinal(i + 1) }}天</span>
        <span class="poster-day-date">{{ fmtDate(dateOfDay(t.startDate, i)) }}</span>
        <span v-if="store.dayWeather(d.id)" class="poster-day-weather">
          {{ store.dayWeather(d.id)!.icon }} {{ store.dayWeather(d.id)!.text }}
          {{ store.dayWeather(d.id)!.tMin }}~{{ store.dayWeather(d.id)!.tMax }}℃
        </span>
      </div>
      <div v-if="store.schedules[d.id]?.driveS" class="poster-day-sum">
        驾驶 {{ fmtDuration(store.schedules[d.id].driveS!) }}
        <template v-if="store.schedules[d.id].distanceM"> · {{ fmtDistance(store.schedules[d.id].distanceM!) }}</template>
        <template v-if="store.schedules[d.id].endMin != null"> · 预计 {{ fmtClock(store.schedules[d.id].endMin!) }} 到达</template>
      </div>
      <div v-if="!d.stops.length" class="poster-empty">未安排</div>
      <div v-for="(s, j) in d.stops" :key="s.id" class="poster-stop">
        <div class="poster-stop-rail">
          <span class="poster-stop-no" :style="{ borderColor: DAY_COLORS[i % DAY_COLORS.length], color: DAY_COLORS[i % DAY_COLORS.length] }">{{ j + 1 }}</span>
          <span v-if="j < d.stops.length - 1" class="poster-stop-line"></span>
        </div>
        <div class="poster-stop-body">
          <div class="poster-stop-name">{{ s.name }}</div>
          <div v-if="stopTime(d.id, j, d.stops.length)" class="poster-stop-time">{{ stopTime(d.id, j, d.stops.length) }}</div>
          <div v-if="j < d.stops.length - 1 && legText(d.id, j)" class="poster-stop-leg">🚗 {{ legText(d.id, j) }}</div>
        </div>
      </div>
    </div>

    <div class="poster-foot">小鹿路书 · {{ site }}</div>
  </div>
</template>
