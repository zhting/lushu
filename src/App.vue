<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useTripStore } from './stores/trip'
import { useAuthStore } from './stores/auth'
import LoginPage from './components/LoginPage.vue'
import AdminPage from './components/AdminPage.vue'
import TripListPage from './components/TripListPage.vue'
import DayAccordion from './components/DayAccordion.vue'
import OverviewPanel from './components/OverviewPanel.vue'
import MapView from './components/MapView.vue'
import PlacePicker from './components/PlacePicker.vue'

const store = useTripStore()
const auth = useAuthStore()

onMounted(() => auth.init())

// 登录后加载服务端配置与路书；退出时清空会话数据
watch(
  () => auth.user,
  async (u) => {
    if (u) {
      try {
        await store.init()
      } catch (e: any) {
        store.notify(e?.message || '数据加载失败，请刷新重试', 'error')
      }
    } else {
      store.reset()
    }
  },
)
</script>

<template>
  <div class="app">
    <template v-if="!auth.ready">
      <div class="center-screen"><p class="muted">加载中…</p></div>
    </template>
    <template v-else-if="!auth.user">
      <LoginPage />
    </template>
    <template v-else-if="store.adminOpen">
      <AdminPage />
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
        <button v-if="store.hasAmapKey" class="btn btn-mini" @click="store.toggleProvider()">
          {{ store.mapCfg.provider === 'osm' ? '🌍 开源' : '🇨🇳 高德' }}
        </button>
        <button v-if="auth.user?.isAdmin" class="btn btn-mini" title="管理后台" @click="store.adminOpen = true">⚙</button>
        <button v-if="store.page === 'trip'" class="btn btn-mini" @click="store.goOverview()">📊 总览</button>
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
