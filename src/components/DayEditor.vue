<script setup lang="ts">
import { computed } from 'vue'
import { useTripStore } from '../stores/trip'
import { fmtDistance, haversineKm } from '../services/geo'
import Draggable from 'vuedraggable'

const props = defineProps<{ dayId: string }>()
const store = useTripStore()

const index = computed(() => store.trip?.days.findIndex((d) => d.id === props.dayId) ?? -1)
const day = computed(() => store.trip?.days.find((d) => d.id === props.dayId) ?? null)

const seq = computed(() => store.routePointsOf(props.dayId))

const fromPrev = computed(() => (day.value ? store.originFromPrev(day.value) : false))
const prevLast = computed(() => {
  const i = index.value
  const prev = i > 0 ? store.trip?.days[i - 1] : null
  return prev?.stops[prev.stops.length - 1] ?? null
})

/** 节点在整条路线中的序号（含继承的出发地） */
function stationNumber(j: number): number {
  return j + 1 + (fromPrev.value ? 1 : 0)
}

/** 本节点到下一节点的距离（显示在节点下方；末节点没有）。优先车行导航距离，未取到时回退直线 */
function legText(j: number): string {
  const k = j + (fromPrev.value ? 1 : 0)
  if (k + 1 >= seq.value.length) return ''
  const legs = store.legDistances[props.dayId]
  if (legs && legs.length === seq.value.length - 1) {
    const d = legs[k]
    if (d != null) return `车行约 ${fmtDistance(d)}`
  }
  const m = Math.round(haversineKm(seq.value[k], seq.value[k + 1]) * 1000)
  return m > 0 ? `直线约 ${fmtDistance(m)}` : ''
}
</script>

<template>
  <template v-if="day">
    <div class="card">
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

      <!-- 拖拽排序的节点时间轴 -->
      <Draggable
        v-model="day.stops"
        item-key="id"
        animation="200"
        filter="input, select, textarea, button"
        :prevent-on-filter="false"
        class="tl"
        @end="store.reorderStops(dayId)"
      >
        <template #item="{ element: s, index: j }">
          <div class="tl-item" :class="{ 'tl-item-last': j === day.stops.length - 1 }">
            <span class="tl-no" title="拖动调整顺序">{{ stationNumber(j) }}</span>
            <div class="tl-body">
              <div class="tl-name">
                {{ s.name }}
                <span class="tl-ops">
                  <button class="icon-btn" title="修改（名称 / 位置 / 类型）" @click="store.openStopEditor(day.id, s.id)">✏️</button>
                  <button class="icon-btn" title="删除" @click="store.removeStop(day.id, s.id)">✕</button>
                </span>
              </div>
              <div v-if="legText(j)" class="tl-leg">🚗 {{ legText(j) }}</div>
            </div>
          </div>
        </template>
      </Draggable>

      <div class="tl-item tl-item-add">
        <span class="tl-no tl-no-add">🔍</span>
        <button class="tl-add-btn" @click="store.openPicker(day.id)">搜索添加新的目的地</button>
      </div>
    </div>
  </template>
</template>
