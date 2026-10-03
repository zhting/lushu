<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
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
const showTripMoreMenu = ref(false)

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

function handleExport() {
  if (!store.trip) return
  const blob = new Blob([store.exportJson()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${store.trip.title || '路书'}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  store.notify('已成功导出路书 JSON 文件')
}

function handleTabClick(tab: 'trip' | 'overview' | 'map') {
  if (tab === 'map') {
    store.openMapOverview()
  } else if (tab === 'overview') {
    store.goOverview()
  } else {
    store.goDays()
  }
}
</script>

<template>
  <div class="app-root" @click="showTripMoreMenu = false">
    <!-- 加载中状态 -->
    <template v-if="!auth.ready">
      <div class="center-screen"><p class="muted">小鹿路书加载中…</p></div>
    </template>

    <!-- 登录注册页 -->
    <template v-else-if="!auth.user">
      <LoginPage />
    </template>

    <!-- 管理后台 -->
    <template v-else-if="store.adminOpen">
      <AdminPage />
    </template>

    <!-- 首页路书列表 -->
    <template v-else-if="store.page === 'home'">
      <TripListPage />
    </template>

    <!-- 行程编辑/总览主界面 -->
    <template v-else>
      <div class="trip-page-layout">
        <!-- 沉浸式顶部风景 Header -->
        <header class="immersive-trip-header">
          <img src="/images/trip_hero.jpg" alt="行程背景" class="header-bg-image" />
          <div class="header-gradient-mask"></div>

          <!-- 顶部快捷操作栏（中间留空透出湖山风光） -->
          <div class="immersive-top-nav">
            <button class="glass-circle-btn" title="返回路书列表" @click="store.goHome()">
              ‹
            </button>

            <!-- 分享导出与三点菜单 -->
            <div class="header-right-actions" @click.stop>
              <button class="glass-circle-btn" title="导出 JSON" @click="handleExport">
                <svg class="share-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </button>
              <div class="relative-wrap">
                <button
                  class="glass-circle-btn"
                  title="更多设置"
                  @click="showTripMoreMenu = !showTripMoreMenu"
                >
                  •••
                </button>
                <div v-if="showTripMoreMenu" class="dropdown-popover header-popover">
                  <button class="popover-item" @click="store.goOverview(); showTripMoreMenu = false">
                    ✏️ 编辑行程设置
                  </button>
                  <button class="popover-item" @click="handleExport(); showTripMoreMenu = false">
                    ⎘ 导出路书 JSON
                  </button>
                  <button v-if="auth.user?.isAdmin" class="popover-item" @click="store.adminOpen = true; showTripMoreMenu = false">
                    ⚙️ 管理后台
                  </button>
                  <div class="popover-divider"></div>
                  <button
                    class="popover-item danger-item"
                    @click="store.deleteCurrentTrip(); showTripMoreMenu = false"
                  >
                    🗑️ 删除该路书
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 行程大标题区域：品牌Logo+名称置于大标题左上方 -->
          <div v-if="store.trip" class="immersive-title-block">
            <div class="brand-row">
              <img src="/images/logo.png" alt="Logo" class="brand-row-logo" />
              <span class="brand-row-text">小鹿路书</span>
            </div>
            <h1 class="immersive-title">{{ store.trip.title }}</h1>
            <div class="immersive-sub">
              <span>📅 {{ store.trip.startDate }} · {{ store.trip.days.length }} 天</span>
            </div>
          </div>
        </header>

        <!-- 下方主体白色圆角大卡片（向上浮动覆盖在封面图底沿） -->
        <main class="trip-main-card">
          <!-- 悬浮 Tab 胶囊切换栏 -->
          <div class="tab-capsule-bar-wrap">
            <div class="tab-capsule-bar">
              <button
                class="tab-pill"
                :class="{ active: store.page === 'trip' && !store.mapOpen }"
                @click="handleTabClick('trip')"
              >
                <span class="tab-icon">☰</span>
                <span>列表</span>
              </button>
              <button
                class="tab-pill"
                :class="{ active: store.page === 'overview' }"
                @click="handleTabClick('overview')"
              >
                <span class="tab-icon">📊</span>
                <span>总览</span>
              </button>
              <button
                class="tab-pill"
                :class="{ active: store.mapOpen }"
                @click="handleTabClick('map')"
              >
                <span class="tab-icon">🗺️</span>
                <span>地图</span>
              </button>
            </div>
          </div>

          <!-- 核心内容区域：左侧行程面板 + 右侧地图 -->
          <div class="trip-content-main">
            <aside class="trip-side-panel">
              <OverviewPanel v-if="store.page === 'overview'" />
              <DayAccordion v-else />
            </aside>

            <!-- 地图视图（PC端常驻右侧，移动端点击Tab「地图」全屏浮层展示） -->
            <MapView />

            <!-- 全屏选点组件 -->
            <PlacePicker v-if="store.pickerOpen" />
          </div>
        </main>
      </div>
    </template>

    <!-- Toast 提示 -->
    <div v-if="store.toast" class="toast" :class="store.toast.kind">{{ store.toast.text }}</div>
  </div>
</template>
