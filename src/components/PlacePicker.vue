<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useTripStore } from '../stores/trip'
import { COMMON_CITIES } from '../constants'
import { cityOfAddress } from '../services/geo'
import * as mapSvc from '../services/map'
import type { Poi } from '../types'
import CitySelect from './CitySelect.vue'

const store = useTripStore()
const kw = ref('')
const searching = ref(false)
const error = ref('')
let timer = 0
let seq = 0

// 编辑模式：把节点当前地点与所在城市带入，原地点会标在地图上，便于对照或就近重选
onMounted(() => {
  const t = store.pickTarget
  if (!t?.stopId) return
  const day = store.trip?.days.find((d) => d.id === t.dayId)
  const s = day?.stops.find((x) => x.id === t.stopId)
  if (!s) return
  const city = cityOfAddress(s.address || '').replace(/市$/, '')
  if (city) store.pickerCity = city
  if (s.name) {
    kw.value = s.name
    void search(s.name)
  }
})

function onInput() {
  window.clearTimeout(timer)
  const q = kw.value.trim()
  if (!q) {
    store.pickerResults = []
    error.value = ''
    return
  }
  timer = window.setTimeout(() => void search(q), 400)
}

function onEnter() {
  window.clearTimeout(timer)
  const q = kw.value.trim()
  if (q) void search(q)
}

// 切换城市后用当前关键词重搜，保证结果始终限定在所选城市
watch(
  () => store.pickerCity,
  () => {
    window.clearTimeout(timer)
    const q = kw.value.trim()
    if (q) void search(q)
  },
)

async function search(q: string) {
  const id = ++seq
  searching.value = true
  error.value = ''
  try {
    const list = await mapSvc.searchPlaces(q, store.pickerCity)
    if (id !== seq) return // 已有更新的搜索，丢弃过期结果
    store.pickerResults = list
    if (!list.length) error.value = store.pickerCity ? `${store.pickerCity}未找到相关地点` : '未找到相关地点'
  } catch (e: any) {
    if (id !== seq) return
    store.pickerResults = []
    error.value = e?.message || '搜索失败'
  } finally {
    if (id === seq) searching.value = false
  }
}

function pick(poi: Poi) {
  store.pickSearchResult(poi)
}
</script>

<template>
  <div class="picker-panel">
    <div class="picker-top">
      <CitySelect v-model="store.pickerCity" />
      <input
        v-model="kw"
        class="picker-input"
        :placeholder="store.pickerCity ? `在${store.pickerCity}搜索地点` : '搜索地点，结果会标在地图上'"
        autocomplete="off"
        autofocus
        @input="onInput"
        @keyup.enter="onEnter"
      />
      <button class="btn btn-mini" @click="store.closePicker()">✕ 关闭</button>
    </div>

    <div v-if="searching" class="picker-status muted">搜索中…</div>
    <div v-else-if="error" class="picker-status error-text">{{ error }}</div>

    <ul v-if="store.pickerResults.length" class="picker-list">
      <li v-for="(p, i) in store.pickerResults" :key="`${p.lng},${p.lat},${i}`" @click="pick(p)">
        <span class="mk mk-mini" style="--mk: #2f6bed">{{ i + 1 }}</span>
        <div class="picker-item-body">
          <div class="r-name">{{ p.name }}</div>
          <div class="r-addr">{{ p.address || p.district }}</div>
        </div>
      </li>
    </ul>

    <div class="picker-tip muted">点击地图上带编号的蓝色标记，或直接点击地图上任意位置。</div>
  </div>
</template>
