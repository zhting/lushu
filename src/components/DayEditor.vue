<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { dateOfDay, fmtDate, fmtClock, fmtDistance, fmtDuration, fmtMinutes } from '../services/geo'
import { KIND_META, KIND_OPTIONS, MAX_STOPS } from '../constants'
import type { Poi, Stop, StopKind } from '../types'
import PlaceSearchBox from './PlaceSearchBox.vue'
import draggable from 'vuedraggable'

const props = defineProps<{ dayId: string }>()
const store = useTripStore()

const drafting = ref(false) // 底部「添加节点」展开的新节点卡片
const editingId = ref<string | null>(null) // 正在编辑的节点

const index = computed(() => store.trip?.days.findIndex((d) => d.id === props.dayId) ?? -1)
const day = computed(() => store.trip?.days.find((d) => d.id === props.dayId) ?? null)
const meta = computed(() => store.routes[props.dayId] ?? null)

const dateText = computed(() =>
  store.trip && index.value >= 0 ? fmtDate(dateOfDay(store.trip.startDate, index.value)) : '',
)

const routeLine = computed(() => {
  if (!day.value || store.routePointsOf(props.dayId).length < 2) return '添加至少 2 个地点后自动计算路线'
  const m = meta.value
  if (!m || m.status === 'pending') return '⏳ 路线计算中…'
  if (m.status === 'error') return `❗ ${m.error}`
  const toll = m.tolls != null ? ` · 过路费约 ¥${m.tolls}` : ''
  return `🚗 ${fmtDistance(m.distanceM)} · ⏱ ${fmtDuration(m.durationS)}${toll}`
})

const rows = computed(() => store.timeline(props.dayId))

const fromPrev = computed(() => (day.value ? store.originFromPrev(day.value) : false))
const prevLast = computed(() => {
  const i = index.value
  const prev = i > 0 ? store.trip?.days[i - 1] : null
  return prev?.stops[prev.stops.length - 1] ?? null
})

const overDriveText = computed(() => {
  const m = meta.value
  if (!store.trip || !m || m.status !== 'done' || !store.overDrive(props.dayId)) return ''
  const warnH = Math.round(store.trip.driveWarnMinutes / 60)
  return `⚠️ 当日驾驶约 ${fmtMinutes(m.durationS / 60)}，超过 ${warnH} 小时提醒阈值，建议减少地点或提前住宿`
})

/** 节点在整条路线中的序号（含继承的出发地） */
function stationNumber(j: number): number {
  return j + 1 + (fromPrev.value ? 1 : 0)
}

/** 该节点相对上一节点的行车信息 */
function seg(j: number) {
  const seqIndex = j + (fromPrev.value ? 1 : 0)
  return store.segmentInfo(props.dayId, seqIndex)
}

function onNameChange(s: Stop, e: Event) {
  store.setStopName(props.dayId, s.id, (e.target as HTMLInputElement).value)
}

function onKindChange(s: Stop, e: Event) {
  store.setStopKind(props.dayId, s.id, (e.target as HTMLSelectElement).value as StopKind)
}

function onStayChange(s: Stop, e: Event) {
  store.setStay(props.dayId, s.id, parseFloat((e.target as HTMLInputElement).value))
}

function toggleEdit(s: Stop) {
  editingId.value = editingId.value === s.id ? null : s.id
}

function onRepick(s: Stop, poi: Poi) {
  store.updateStopPlace(props.dayId, s.id, poi)
  editingId.value = null
}

function onDraftSelect(poi: Poi) {
  store.addStop(props.dayId, poi)
  drafting.value = false
}
</script>

<template>
  <template v-if="day">
    <div class="card day-head">
      <div class="day-title">
        <span class="dot" :style="{ background: store.dayStats[index]?.color }"></span>
        Day {{ index + 1 }}
        <span class="day-date">{{ dateText }}</span>
      </div>
      <div class="route-line">
        <span>{{ routeLine }}</span>
        <button v-if="meta?.status === 'error' || meta?.status === 'done'" class="btn btn-mini" @click="store.recalc(day.id)">
          重算
        </button>
      </div>
    </div>

    <div class="card">
      <h3>行程节点（{{ day.stops.length }} / {{ MAX_STOPS }}）· 按顺序经过，可拖拽调整</h3>

      <div v-if="index > 0" class="origin-banner">
        <template v-if="day.startAuto">
          <span v-if="prevLast">🚩 从前一天终点「{{ prevLast.name }}」出发</span>
          <span v-else class="muted">前一天还没有地点，将从本日第一个地点出发</span>
          <button class="btn btn-mini" @click="store.toggleStartAuto(day.id)">改为从本日第一地出发</button>
        </template>
        <template v-else>
          <span>🚩 从本日第一个地点出发</span>
          <button v-if="prevLast" class="btn btn-mini" @click="store.toggleStartAuto(day.id)">改为接续前一天终点</button>
        </template>
      </div>

      <template v-for="(s, j) in day.stops" :key="s.id">
        <div v-if="seg(j) && editingId !== s.id" class="seg-line">
          🚗 距上一地点 {{ seg(j)!.approx ? '直线约' : '' }} {{ fmtDistance(seg(j)!.distanceM) }} · {{ fmtMinutes(seg(j)!.driveMin) }}
        </div>
        <div class="stop" :class="{ 'stop-editing': editingId === s.id }">
          <span class="drag" title="拖拽排序">⠿</span>
          <span class="emoji">{{ KIND_META[s.kind].emoji }}</span>

          <!-- 编辑态：改名 + 卡片内搜索更换地点 -->
          <div v-if="editingId === s.id" class="body">
            <div class="edit-row">
              <label>名称</label>
              <input :value="s.name" @change="onNameChange(s, $event)" @keyup.enter="onNameChange(s, $event)" />
            </div>
            <PlaceSearchBox placeholder="搜索新地点以更换位置，选中即生效" @select="onRepick(s, $event)" />
            <button class="btn btn-mini" style="margin-top: 6px" @click="toggleEdit(s)">完成</button>
          </div>

          <!-- 展示态 -->
          <div v-else class="body">
            <div class="name">
              {{ stationNumber(j) }}. {{ s.name }}<span class="chip">{{ KIND_META[s.kind].label }}</span>
              <span v-if="j === day.stops.length - 1" class="chip chip-auto">当晚住宿</span>
            </div>
            <div class="addr" v-if="s.address">{{ s.address }}</div>
            <div class="stay">
              停留
              <input
                class="stay-input"
                type="number"
                min="0"
                max="1440"
                :value="s.stayMinutes"
                @change="onStayChange(s, $event)"
              />
              分钟
              <select
                style="width: auto; margin-left: auto; font-size: 12px; padding: 2px 4px"
                :value="s.kind"
                @change="onKindChange(s, $event)"
              >
                <option v-for="k in KIND_OPTIONS" :key="k" :value="k">{{ KIND_META[k].label }}</option>
              </select>
            </div>
          </div>

          <div class="ops" v-if="editingId !== s.id">
            <button class="icon-btn" title="上移" :disabled="j === 0" @click="store.moveStop(day.id, j, j - 1)">▲</button>
            <button class="icon-btn" title="下移" :disabled="j === day.stops.length - 1" @click="store.moveStop(day.id, j, j + 1)">▼</button>
            <button class="icon-btn" title="编辑（改名 / 更换地点）" @click="toggleEdit(s)">✏️</button>
            <button class="icon-btn" title="删除" @click="store.removeStop(day.id, s.id)">✕</button>
          </div>
        </div>
      </template>

      <p v-if="!day.stops.length && !drafting" class="muted" style="margin: 0 0 6px">
        还没有地点，点下方「＋ 添加节点」开始：在卡片里搜索并选择地点即可。
      </p>

      <!-- 新节点卡片：在卡片内搜索 -->
      <div v-if="drafting" class="stop stop-draft">
        <span class="emoji">➕</span>
        <div class="body">
          <div class="draft-title">新节点：搜索并选择一个地点（将排在当天最后）</div>
          <PlaceSearchBox @select="onDraftSelect" />
        </div>
      </div>

      <button
        class="btn add-node-btn"
        :class="{ 'btn-primary': !drafting }"
        @click="drafting = !drafting"
      >
        {{ drafting ? '取消添加' : '＋ 添加节点' }}
      </button>
    </div>

    <div v-if="rows" class="card">
      <h3>时间轴推算（出发 {{ day.departTime }}）</h3>
      <template v-for="(r, i) in rows" :key="r.stop.id">
        <div v-if="i > 0" class="tl-drive">🚗 驾驶约 {{ fmtMinutes(r.driveMin) }}</div>
        <div class="tl-row">
          <span class="tl-time">{{ fmtClock(r.arrive) }} 到达</span>
          <span :style="{ fontWeight: r.isEnd ? 600 : 400 }">
            <template v-if="r.fromPrev">🚩 前一日终点 · </template>{{ r.stop.name }}
          </span>
          <span v-if="!r.isEnd && r.depart > r.arrive" class="muted">停留 {{ fmtMinutes(r.depart - r.arrive) }}</span>
        </div>
      </template>
      <div v-if="overDriveText" class="warn-banner">{{ overDriveText }}</div>
    </div>
  </template>
</template>
