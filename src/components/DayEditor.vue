<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { fmtDistance, fmtDuration, haversineKm } from '../services/geo'
import Draggable from 'vuedraggable'
import type { StopKind } from '../types'

const props = defineProps<{ dayId: string }>()
const store = useTripStore()
const activeMenuStopId = ref<string | null>(null)

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

/** 获取地点类型的代表性图标（设计图中为房屋/景点微标） */
function kindIcon(kind?: StopKind): string {
  switch (kind) {
    case 'hotel':
      return '🏠'
    case 'scenic':
      return '🏛️'
    case 'food':
      return '🍜'
    case 'fuel':
      return '⛽️'
    default:
      return '🏠'
  }
}

/** 本节点到下一节点的距离与耗时。优先车行导航距离与时长，未取到时回退直线 */
function legText(j: number): string {
  const k = j + (fromPrev.value ? 1 : 0)
  if (k + 1 >= seq.value.length) return ''
  const legs = store.legDistances[props.dayId]
  const durations = store.legDurations[props.dayId]
  if (legs && legs.length === seq.value.length - 1) {
    const d = legs[k]
    const dur = durations?.[k]
    if (d != null) {
      const durStr = dur ? fmtDuration(dur) : ''
      return durStr ? `车行约 ${fmtDistance(d)} · ${durStr}` : `车行约 ${fmtDistance(d)}`
    }
  }
  const m = Math.round(haversineKm(seq.value[k], seq.value[k + 1]) * 1000)
  return m > 0 ? `直线约 ${fmtDistance(m)}` : ''
}

function toggleStopMenu(stopId: string, e: MouseEvent) {
  e.stopPropagation()
  activeMenuStopId.value = activeMenuStopId.value === stopId ? null : stopId
}
</script>

<template>
  <div v-if="day" class="day-editor-content" @click="activeMenuStopId = null">
    <!-- 跨天接续提示条 -->
    <div v-if="index > 0" class="origin-banner">
      <template v-if="day.startAuto">
        <span v-if="prevLast" class="banner-text">
          🚩 从前一天终点「{{ prevLast.name }}」接续出发
        </span>
        <span v-else class="banner-text muted">前一天暂无地点，将从本日首地出发</span>
        <button class="btn-text-action" @click="store.toggleStartAuto(day.id)">改为从本日第一地出发</button>
      </template>
      <template v-else>
        <span class="banner-text">🚩 从本日第一个地点出发</span>
        <button v-if="prevLast" class="btn-text-action" @click="store.toggleStartAuto(day.id)">改为接续前一天终点</button>
      </template>
    </div>

    <!-- 拖拽排序的节点时间轴 -->
    <Draggable
      v-model="day.stops"
      item-key="id"
      animation="200"
      handle=".tl-node-number"
      class="timeline-list"
      @end="store.reorderStops(dayId)"
    >
      <template #item="{ element: s, index: j }">
        <div class="timeline-row" :class="{ 'timeline-row-last': j === day.stops.length - 1 }">
          <!-- 左侧节点序号与垂直虚线 -->
          <div class="tl-node-col">
            <div class="tl-node-number" title="按住拖拽排序">{{ stationNumber(j) }}</div>
            <!-- 垂直虚线连接线（即使最后一项也延伸一段与设计图一致） -->
            <div class="tl-vertical-line" :class="{ 'line-short': j === day.stops.length - 1 }"></div>
          </div>

          <!-- 右侧节点主体卡片 -->
          <div class="tl-body-col">
            <div class="tl-station-card">
              <!-- 图标：灰底小方块 -->
              <div class="station-icon-wrap">
                <span>{{ kindIcon(s.kind) }}</span>
              </div>

              <!-- 名称与橙红色编辑小铅笔 -->
              <div class="station-name-wrap" @click="store.openStopEditor(day.id, s.id)">
                <span class="station-name">{{ s.name }}</span>
                <!-- 橙色斜向铅笔图标 -->
                <button
                  class="pencil-edit-btn"
                  title="修改地点/类型"
                  @click.stop="store.openStopEditor(day.id, s.id)"
                >
                  <svg class="pencil-icon-svg" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                  </svg>
                </button>
              </div>

              <!-- 垂直三点操作项 ⋮ -->
              <div class="station-actions-wrap" @click.stop>
                <button
                  class="action-dots-btn"
                  title="操作选项"
                  @click="toggleStopMenu(s.id, $event)"
                >
                  ⋮
                </button>
                <div v-if="activeMenuStopId === s.id" class="dropdown-popover stop-popover">
                  <button
                    class="popover-item"
                    @click="store.openStopEditor(day.id, s.id); activeMenuStopId = null"
                  >
                    ✏️ 编辑地点信息
                  </button>
                  <div class="popover-divider"></div>
                  <button
                    class="popover-item danger-item"
                    @click="store.removeStop(day.id, s.id); activeMenuStopId = null"
                  >
                    🗑️ 删除此地点
                  </button>
                </div>
              </div>
            </div>

            <!-- 节点间车行信息 -->
            <div v-if="legText(j)" class="tl-leg-pill">
              <span class="car-emoji">🚗</span>
              <span class="leg-info-text">{{ legText(j) }}</span>
            </div>
          </div>
        </div>
      </template>
    </Draggable>

    <!-- 底部浅蓝底虚线按钮：「＋ 搜索添加新的目的地」 -->
    <div class="add-destination-wrap">
      <button class="add-destination-btn" @click="store.openPicker(day.id)">
        <span class="add-circle-icon">＋</span>
        <span class="btn-text">搜索添加新的目的地</span>
      </button>
    </div>
  </div>
</template>
