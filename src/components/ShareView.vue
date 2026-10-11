<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { api } from '../services/api'
import { cnOrdinal, dateOfDay, fmtDate, fmtDistance, fmtDuration } from '../services/geo'
import { fmtClock, fmtStay, fmtYuan } from '../services/schedule'
import { DAY_COLORS, ENERGY_META } from '../constants'
import MapView from './MapView.vue'
import NavMenu from './NavMenu.vue'
import WeatherChip from './WeatherChip.vue'

/** 只读分享页：/s/<token>，无需登录 */
const props = defineProps<{ token: string }>()
const store = useTripStore()
const state = ref<'loading' | 'ok' | 'error'>('loading')
const error = ref('')
const owner = ref('')

onMounted(async () => {
  try {
    const data = await api.getShared(props.token)
    owner.value = data.owner || ''
    store.openShared(data.trip, data.config)
    document.title = `${data.trip.title} · 小鹿路书`
    state.value = 'ok'
  } catch (e: any) {
    error.value = e?.message || '分享链接无法打开'
    state.value = 'error'
  }
})

const totals = computed(() => store.tripTotals)
const energyLabel = computed(() => ENERGY_META[store.vehicle.energy].costLabel)

function stopTime(dayId: string, j: number, total: number): string {
  const sc = store.schedules[dayId]
  if (!sc) return ''
  if (j === 0) return total > 1 ? `${fmtClock(sc.departMin)} 出发` : ''
  const parts: string[] = []
  const arr = sc.arrive[j]
  if (arr != null) parts.push(`${fmtClock(arr)} 到`)
  const stay = store.trip?.days.find((d) => d.id === dayId)?.stops[j].stayMinutes ?? 0
  if (j < total - 1 && stay) parts.push(`停留 ${fmtStay(stay)}`)
  return parts.join(' · ')
}

function legText(dayId: string, j: number): string {
  const dist = store.legDistances[dayId]?.[j]
  const dur = store.legDurations[dayId]?.[j]
  if (dist == null) return ''
  const toll = store.legTolls[dayId]?.[j]
  return [`车行约 ${fmtDistance(dist)}`, dur ? fmtDuration(dur) : '', toll ? `过路费 ${fmtYuan(toll)}` : '']
    .filter(Boolean)
    .join(' · ')
}

function focusDay(dayId: string) {
  store.view = store.view === dayId ? 'overview' : dayId
}
</script>

<template>
  <div class="app-root">
    <div v-if="state === 'loading'" class="center-screen"><p class="muted">路书加载中…</p></div>
    <div v-else-if="state === 'error'" class="center-screen share-error">
      <p>😕 {{ error }}</p>
      <p class="muted">链接可能已被作者关闭，或路书已删除。</p>
    </div>

    <div v-else-if="store.trip" class="trip-page-layout share-page">
      <header class="immersive-trip-header">
        <img src="/images/trip_hero.jpg" alt="行程背景" class="header-bg-image" />
        <div class="header-gradient-mask"></div>
        <div class="immersive-title-block">
          <div class="brand-row">
            <img src="/images/logo.png" alt="Logo" class="brand-row-logo" />
            <span class="brand-row-text">小鹿路书</span>
            <span class="share-readonly-badge">只读分享</span>
          </div>
          <h1 class="immersive-title">{{ store.trip.title }}</h1>
          <div class="immersive-sub">
            <span>📅 {{ store.trip.startDate }} · {{ store.trip.days.length }} 天<template v-if="owner"> · 由 {{ owner }} 分享</template></span>
          </div>
        </div>
      </header>

      <main class="trip-main-card">
        <div class="tab-capsule-bar-wrap">
          <div class="tab-capsule-bar">
            <button class="tab-pill" :class="{ active: !store.mapOpen }" @click="store.closeMap()">
              <span class="tab-icon">☰</span><span>行程</span>
            </button>
            <button class="tab-pill" :class="{ active: store.mapOpen }" @click="store.openMapOverview()">
              <span class="tab-icon">🗺️</span><span>地图</span>
            </button>
          </div>
        </div>

        <div class="trip-content-main" :class="{ 'map-full-mode': store.mapOpen }">
          <aside class="trip-side-panel">
            <div class="card">
              <h3>全程</h3>
              <div class="stat-tiles">
                <div class="stat-tile">
                  <div class="stat-label">总里程</div>
                  <div class="stat-value">{{ totals.distanceM ? fmtDistance(totals.distanceM) : '—' }}</div>
                </div>
                <div class="stat-tile">
                  <div class="stat-label">驾驶时长</div>
                  <div class="stat-value">{{ fmtDuration(totals.driveS) || '—' }}</div>
                </div>
                <div class="stat-tile">
                  <div class="stat-label">{{ energyLabel }}（估）</div>
                  <div class="stat-value">{{ totals.distanceM ? fmtYuan(totals.energy) : '—' }}</div>
                </div>
                <div class="stat-tile">
                  <div class="stat-label">过路费</div>
                  <div class="stat-value" :class="{ 'stat-na': totals.tolls == null }">
                    {{ totals.tolls != null ? fmtYuan(totals.tolls) : '—' }}
                  </div>
                </div>
              </div>
              <p v-if="totals.pendingDays" class="stat-foot muted">线路计算中，合计稍后更新。</p>
            </div>

            <section v-for="(d, i) in store.trip.days" :key="d.id" class="card share-day">
              <div class="share-day-head" role="button" title="在地图上查看这一天" @click="focusDay(d.id)">
                <span class="poster-day-badge" :style="{ background: DAY_COLORS[i % DAY_COLORS.length] }">D{{ i + 1 }}</span>
                <span class="share-day-title">第{{ cnOrdinal(i + 1) }}天</span>
                <span class="muted share-day-date">{{ fmtDate(dateOfDay(store.trip.startDate, i)) }}</span>
                <WeatherChip :day-id="d.id" />
                <span style="flex: 1"></span>
                <button class="btn btn-mini" @click.stop="store.showDayOnMap(d.id)">地图</button>
              </div>
              <div v-if="store.schedules[d.id]?.driveS" class="share-day-sum muted">
                驾驶 {{ fmtDuration(store.schedules[d.id].driveS!) }}
                <template v-if="store.schedules[d.id].distanceM"> · {{ fmtDistance(store.schedules[d.id].distanceM!) }}</template>
                <template v-if="store.schedules[d.id].endMin != null"> · 预计 {{ fmtClock(store.schedules[d.id].endMin!) }} 到达</template>
              </div>
              <div v-if="!d.stops.length" class="muted">未安排</div>
              <ol class="share-stops">
                <li v-for="(s, j) in d.stops" :key="s.id">
                  <span class="share-stop-no" :style="{ borderColor: DAY_COLORS[i % DAY_COLORS.length], color: DAY_COLORS[i % DAY_COLORS.length] }">{{ j + 1 }}</span>
                  <div class="share-stop-body">
                    <div class="share-stop-name">{{ s.name }}</div>
                    <div v-if="stopTime(d.id, j, d.stops.length)" class="tl-stop-time share-stop-time">{{ stopTime(d.id, j, d.stops.length) }}</div>
                    <div v-if="s.note" class="muted share-stop-note">{{ s.note }}</div>
                    <div v-if="j < d.stops.length - 1" class="share-leg">
                      <span class="muted">{{ legText(d.id, j) || '↓' }}</span>
                      <NavMenu :from="s" :to="d.stops[j + 1]" />
                    </div>
                  </div>
                </li>
              </ol>
              <p v-if="d.note" class="muted share-day-note">{{ d.note }}</p>
            </section>

            <p class="muted share-foot">用 <a href="/">小鹿路书</a> 规划你自己的自驾行程</p>
          </aside>

          <MapView />
        </div>
      </main>
    </div>

    <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
  </div>
</template>
