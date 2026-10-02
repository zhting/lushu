<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { todayStr } from '../services/geo'
import { DAY_COLORS } from '../constants'

const store = useTripStore()
const showCreate = ref(false)
const title = ref('')
const startDate = ref(todayStr())

function create() {
  store.createTrip(title.value, startDate.value, 1)
}

function fmtSavedAt(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

function stripStyle(i: number) {
  const n = DAY_COLORS.length
  const c = [0, 1, 2, 3].map((k) => DAY_COLORS[(i + k) % n])
  return { background: `linear-gradient(90deg, ${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})` }
}
</script>

<template>
  <div class="home-page">
    <header class="topbar">
      <div class="brand">🚗 路书</div>
      <span class="muted">按天规划你的自驾行程</span>
      <div style="flex: 1"></div>
      <button
        class="btn btn-mini"
        :title="store.mapCfg.provider === 'osm' ? '当前：开源地图（OSM），点击切换' : '当前：高德地图，点击切换'"
        @click="store.gateOpen = true"
      >
        {{ store.mapCfg.provider === 'osm' ? '🌍 数据源' : '🇨🇳 数据源' }}
      </button>
    </header>

    <div class="home-body">
      <div class="home-head">
        <h2>我的路书</h2>
        <div style="flex: 1"></div>
        <button class="btn btn-primary" @click="showCreate = !showCreate">
          {{ showCreate ? '收起' : '＋ 创建新路书' }}
        </button>
      </div>

      <div v-if="showCreate" class="card create-card">
        <h3>新建路书</h3>
        <div class="field">
          <label>行程名称</label>
          <input v-model="title" placeholder="例如：国庆草原环线" @keyup.enter="create" />
        </div>
        <div class="field">
          <label>出发日期</label>
          <input v-model="startDate" type="date" />
        </div>
        <button class="btn btn-primary" @click="create">创建路书</button>
        <div class="divider">或者</div>
        <button class="btn btn-block" @click="store.loadSample()">载入示例行程（京北草原 3 日）</button>
      </div>

      <div v-if="!store.tripSummaries.length && !showCreate" class="card empty-card">
        <p style="font-size: 15px">还没有路书，点击右上角「创建新路书」开始规划第一次自驾之旅 🗺️</p>
        <button class="btn" @click="showCreate = true">＋ 创建新路书</button>
      </div>

      <div v-if="store.tripSummaries.length" class="trip-grid">
        <div
          v-for="(s, i) in store.tripSummaries"
          :key="s.id"
          class="trip-card"
          @click="store.openTrip(s.id)"
        >
          <div class="trip-strip" :style="stripStyle(i)"></div>
          <div class="trip-card-body">
            <div class="t-title">{{ s.title }}</div>
            <div class="t-meta">📅 {{ s.startDate }} · {{ s.days }} 天</div>
            <div class="t-foot">
              <span class="muted">{{ fmtSavedAt(s.savedAt) }}</span>
              <button class="icon-btn" title="删除" @click.stop="store.deleteTrip(s.id)">🗑</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
