<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useTripStore } from '../stores/trip'
import { KIND_META, KIND_OPTIONS, STAY_PRESETS } from '../constants'
import { cityOfAddress } from '../services/geo'
import { fmtStay } from '../services/schedule'
import * as mapSvc from '../services/map'
import type { Poi, StopKind } from '../types'
import CitySelect from './CitySelect.vue'

const store = useTripStore()
const kw = ref('')
const searching = ref(false)
const error = ref('')
let timer = 0
let seq = 0

// 编辑模式下正在修改的节点（新增模式为 null）
const editing = computed(() => {
  const t = store.pickTarget
  if (!t?.stopId) return null
  const day = store.trip?.days.find((d) => d.id === t.dayId)
  const idx = day?.stops.findIndex((x) => x.id === t.stopId) ?? -1
  if (!day || idx < 0) return null
  return { dayId: day.id, stop: day.stops[idx], isFirst: idx === 0 }
})

const currentKind = computed<StopKind>(() => editing.value?.stop.kind ?? store.pickerKind)

function chooseKind(k: StopKind) {
  const e = editing.value
  if (e) store.setStopKind(e.dayId, e.stop.id, k)
  else store.pickerKind = k
}

function chooseStay(min: number) {
  const e = editing.value
  if (e) store.setStay(e.dayId, e.stop.id, min)
}

function onCustomStay(ev: Event) {
  const v = Number((ev.target as HTMLInputElement).value)
  if (Number.isFinite(v)) chooseStay(v)
}

function onRename(ev: Event) {
  const e = editing.value
  if (e) store.setStopName(e.dayId, e.stop.id, (ev.target as HTMLInputElement).value)
}

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
      <button class="btn btn-mini" :class="{ 'btn-primary': editing }" @click="store.closePicker()">
        {{ editing ? '✓ 完成' : '✕ 关闭' }}
      </button>
    </div>

    <!-- 节点属性：新增时选类型；编辑时可改名称 / 类型 / 停留，改动即时保存 -->
    <div class="picker-props">
      <div v-if="editing?.stop.fromPrev" class="picker-prop-hint picker-prop-hint-flush muted">
        这是接续前一天终点的出发地点，名称和类型跟随前一天，出发时间在当天顶部设置。
      </div>
      <div v-if="editing && !editing.stop.fromPrev" class="picker-prop-row">
        <span class="picker-prop-label">名称</span>
        <input class="picker-name-input" :value="editing.stop.name" maxlength="40" @change="onRename" />
      </div>
      <div v-if="!editing?.stop.fromPrev" class="picker-prop-row">
        <span class="picker-prop-label">类型</span>
        <div class="chip-group">
          <button
            v-for="k in KIND_OPTIONS"
            :key="k"
            type="button"
            class="chip"
            :class="{ 'chip-active': currentKind === k }"
            @click="chooseKind(k)"
          >
            {{ KIND_META[k].emoji }} {{ KIND_META[k].label }}
          </button>
        </div>
      </div>
      <div v-if="editing && !editing.isFirst" class="picker-prop-row">
        <span class="picker-prop-label">停留</span>
        <div class="chip-group">
          <button
            v-for="m in STAY_PRESETS"
            :key="m"
            type="button"
            class="chip"
            :class="{ 'chip-active': editing.stop.stayMinutes === m }"
            @click="chooseStay(m)"
          >
            {{ fmtStay(m) }}
          </button>
          <label class="chip chip-input" :class="{ 'chip-active': !STAY_PRESETS.includes(editing.stop.stayMinutes) }">
            <input
              type="number"
              min="0"
              max="1440"
              step="5"
              :value="editing.stop.stayMinutes"
              @change="onCustomStay"
            />
            分钟
          </label>
        </div>
      </div>
      <div v-else-if="editing && !editing.stop.fromPrev" class="picker-prop-hint muted">这是当天第一个地点，以当天出发时间为准，不计停留。</div>
      <div v-else-if="KIND_META[currentKind].stay" class="picker-prop-hint muted">
        默认停留 {{ fmtStay(KIND_META[currentKind].stay) }}，添加后可点地点名称修改。
      </div>
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

    <div class="picker-tip muted">
      {{ editing
        ? '改完点「完成」即可；要换位置，点地图上带编号的蓝色标记或地图上任意位置。'
        : '点击地图上带编号的蓝色标记，或直接点击地图上任意位置。' }}
    </div>
  </div>
</template>
