<script setup lang="ts">
import { onMounted } from 'vue'
import { useTripStore } from './stores/trip'
import KeySetup from './components/KeySetup.vue'
import TripListPage from './components/TripListPage.vue'
import DayAccordion from './components/DayAccordion.vue'
import OverviewPanel from './components/OverviewPanel.vue'
import MapView from './components/MapView.vue'
import PlacePicker from './components/PlacePicker.vue'

const store = useTripStore()

onMounted(() => store.init())
</script>

<template>
  <div class="app">
    <template v-if="store.gateOpen">
      <KeySetup />
    </template>
    <template v-else-if="store.page === 'home'">
      <TripListPage />
    </template>
    <template v-else>
      <header class="topbar">
        <button
          class="btn btn-mini"
          @click="store.page === 'overview' ? store.goDays() : store.goHome()"
        >
          {{ store.page === 'overview' ? '← 返回' : '← 列表' }}
        </button>
        <h1 v-if="store.trip" class="trip-title">{{ store.trip.title }}</h1>
        <div style="flex: 1"></div>
        <button v-if="store.page === 'trip'" class="btn btn-mini" @click="store.goOverview()">
          📊 总览
        </button>
        <button class="btn btn-mini map-toggle" @click="store.openMapOverview()">🗺 地图</button>
      </header>
      <div class="main">
        <aside class="side">
          <OverviewPanel v-if="store.page === 'overview'" />
          <DayAccordion v-else />
        </aside>
        <MapView />
        <PlacePicker v-if="store.pickerOpen" />
      </div>
    </template>
    <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
  </div>
</template>
