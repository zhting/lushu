<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useTripStore } from './stores/trip'
import { fmtDistance, fmtDuration } from './services/geo'
import KeySetup from './components/KeySetup.vue'
import TripListPage from './components/TripListPage.vue'
import DayTabs from './components/DayTabs.vue'
import OverviewPanel from './components/OverviewPanel.vue'
import DayEditor from './components/DayEditor.vue'
import MapView from './components/MapView.vue'

const store = useTripStore()

onMounted(() => store.init())

const totalsText = computed(() => {
  const t = store.totals
  if (!store.trip) return ''
  const warn = t.warns ? ` · ⚠️${t.warns} 天驾驶偏长` : ''
  return `${t.days} 天 · 总里程 ${fmtDistance(t.dist)} · 驾驶 ${fmtDuration(t.dur)}${warn}`
})

function onTitleChange(e: Event) {
  store.setTitle((e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="app">
    <template v-if="!store.setupDone || store.gateOpen">
      <KeySetup />
    </template>
    <template v-else-if="store.page === 'home'">
      <TripListPage />
    </template>
    <template v-else>
      <header class="topbar">
        <button class="btn btn-mini" @click="store.goHome()">← 列表</button>
        <div class="brand">🚗 路书</div>
        <input
          v-if="store.trip"
          class="title-input"
          :value="store.trip.title"
          placeholder="行程名称"
          @change="onTitleChange"
        />
        <div v-if="store.trip" class="topstats">{{ totalsText }}</div>
        <div style="flex: 1"></div>
        <button class="btn btn-mini map-toggle" @click="store.mapOpen = true">🗺 地图</button>
        <button
          class="btn btn-mini"
          :title="store.mapCfg.provider === 'osm' ? '当前：开源地图（OSM），点击切换' : '当前：高德地图，点击切换'"
          @click="store.gateOpen = true"
        >
          {{ store.mapCfg.provider === 'osm' ? '🌍 数据源' : '🇨🇳 数据源' }}
        </button>
      </header>
      <div class="main">
        <aside class="side">
          <DayTabs />
          <OverviewPanel v-if="store.view === 'overview'" />
          <DayEditor v-else :day-id="store.view" />
        </aside>
        <MapView />
      </div>
    </template>
    <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
  </div>
</template>
