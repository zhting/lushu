<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { fmtDistance, fmtDuration, haversineKm } from '../services/geo'
import { fmtClock, fmtStay, fmtYuan } from '../services/schedule'
import { DRIVE_WARN_MINUTES, ENERGY_META, LATE_ARRIVAL_MINUTES } from '../constants'
import Draggable from 'vuedraggable'
import NavMenu from './NavMenu.vue'
import SupplyPanel from './SupplyPanel.vue'
import WeatherChip from './WeatherChip.vue'

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

/** 节点在整条路线中的自然序号 */
function stationNumber(j: number): number {
  return j + 1
}

/** 本节点到下一节点的距离与耗时。优先车行导航距离与时长，未取到时回退直线 */
function legText(j: number): string {
  if (!day.value || j + 1 >= day.value.stops.length) return ''
  const legs = store.legDistances[props.dayId]
  const durations = store.legDurations[props.dayId]
  if (legs && legs.length === day.value.stops.length - 1) {
    const d = legs[j]
    const dur = durations?.[j]
    if (d != null) {
      const parts = [`车行约 ${fmtDistance(d)}`]
      if (dur) parts.push(fmtDuration(dur))
      const toll = store.legTolls[props.dayId]?.[j]
      if (toll) parts.push(`过路费 ${fmtYuan(toll)}`)
      return parts.join(' · ')
    }
  }
  const m = Math.round(haversineKm(day.value.stops[j], day.value.stops[j + 1]) * 1000)
  return m > 0 ? `直线约 ${fmtDistance(m)}` : ''
}

// ── 当天时间表与费用 ──
const sched = computed(() => store.schedules[props.dayId] ?? null)
const cost = computed(() => store.dayCost(props.dayId))
const energyLabel = computed(() => ENERGY_META[store.vehicle.energy].costLabel)
const driveWarn = computed(() => (sched.value?.driveS ?? 0) / 60 > DRIVE_WARN_MINUTES)
const lateWarn = computed(() => sched.value?.endMin != null && sched.value.endMin > LATE_ARRIVAL_MINUTES)
const tollsUnsupported = computed(() => store.mapCfg.provider !== 'amap')

function onDepartChange(e: Event) {
  store.setDepartTime(props.dayId, (e.target as HTMLInputElement).value)
}

/** 节点下方的时间说明：首站「08:00 出发」，其余「10:30 到 · 停留 2小时」 */
function stopTimeText(j: number): string {
  const sc = sched.value
  const d = day.value
  if (!sc || !d) return ''
  if (j === 0) return d.stops.length > 1 ? `${fmtClock(sc.departMin)} 出发` : ''
  const parts: string[] = []
  const arr = sc.arrive[j]
  if (arr != null) parts.push(`${fmtClock(arr)} 到`)
  const stay = d.stops[j].stayMinutes
  if (j < d.stops.length - 1 && stay) parts.push(`停留 ${fmtStay(stay)}`)
  return parts.join(' · ')
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

    <!-- 当天时间表：出发时间 / 驾驶时长 / 预计到达 / 费用 -->
    <div v-if="sched" class="day-plan">
      <div class="day-plan-main">
        <label class="depart-field" title="修改当天出发时间">
          <span>出发</span>
          <input type="time" :value="day.departTime" @change="onDepartChange" />
        </label>
        <WeatherChip :day-id="dayId" />
        <template v-if="day.stops.length > 1">
          <span v-if="!sched.durationsKnown" class="day-plan-stat muted">
            {{ store.legFailed[dayId] ? '车行线路未算出，暂无法推算到达时间' : '线路计算中…' }}
          </span>
          <template v-else>
            <span class="day-plan-stat">
              <span class="muted">驾驶</span> <b>{{ fmtDuration(sched.driveS ?? 0) || '—' }}</b>
              <span v-if="sched.distanceM" class="muted"> · {{ fmtDistance(sched.distanceM) }}</span>
            </span>
            <span v-if="sched.endMin != null" class="day-plan-stat">
              <span class="muted">预计</span> <b>{{ fmtClock(sched.endMin) }}</b> <span class="muted">到达</span>
            </span>
          </template>
        </template>
        <span v-else class="day-plan-stat muted">添加两个以上地点后推算到达时间</span>
      </div>
      <div v-if="day.stops.length > 1 && sched.durationsKnown" class="day-plan-cost">
        <span v-if="cost.energy != null">{{ energyLabel }}约 <b>{{ fmtYuan(cost.energy) }}</b></span>
        <span v-if="cost.tolls != null">过路费 <b>{{ fmtYuan(cost.tolls) }}</b></span>
        <span v-else-if="tollsUnsupported" class="muted">过路费：开源地图不提供</span>
        <span v-if="sched.stayMin" class="muted">途中停留 {{ fmtStay(sched.stayMin) }}</span>
      </div>
      <div v-if="driveWarn" class="day-plan-warn">
        ⚠️ 今天驾驶约 {{ fmtDuration(sched.driveS ?? 0) }}，超过 {{ DRIVE_WARN_MINUTES / 60 }} 小时，建议拆成两天或多安排休息
      </div>
      <div v-if="lateWarn && sched.endMin != null" class="day-plan-warn">
        🌙 预计 {{ fmtClock(sched.endMin) }} 才到，注意夜间行车，可提早出发或减少停留
      </div>
    </div>

    <!-- 拖拽排序的节点时间轴 -->
    <Draggable
      v-model="day.stops"
      item-key="id"
      animation="200"
      handle=".tl-node-col, .station-drag-handle"
      class="timeline-list"
      ghost-class="timeline-row-ghost"
      drag-class="timeline-row-dragging"
      @end="store.reorderStops(dayId)"
    >
      <template #item="{ element: s, index: j }">
        <div class="timeline-row" :class="{ 'timeline-row-last': j === day.stops.length - 1 }">
          <!-- 左侧节点序号与垂直虚线 -->
          <div class="tl-node-col" title="按住拖拽调整顺序">
            <div class="tl-node-number">{{ stationNumber(j) }}</div>
            <!-- 垂直虚线连接线（即使最后一项也延伸一段与设计图一致） -->
            <div class="tl-vertical-line" :class="{ 'line-short': j === day.stops.length - 1 }"></div>
          </div>

          <!-- 右侧节点主体卡片 -->
          <div class="tl-body-col">
            <div class="tl-station-card">
              <!-- 图标：统一精致深灰蓝色矢量图标 -->
              <div class="station-icon-wrap">
                <svg v-if="s.kind === 'scenic'" class="station-svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L2 7v2h20V7L12 2zm1 19v-9h-2v9H4v2h16v-2h-7zm-4-9h2v9H9v-9zm6 0h2v9h-2v-9z"/>
                </svg>
                <svg v-else-if="s.kind === 'food'" class="station-svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/>
                </svg>
                <svg v-else-if="s.kind === 'fuel'" class="station-svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33a2.5 2.5 0 002.5 2.5c.36 0 .69-.1.97-.28l1.46 1.46c-.76 2.36-2.28 4.95-3.43 6.32V19h-2v-8c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v10h10v-3.81c1.55-1.78 3.52-5.11 4.41-7.85l1.36 1.36 1.42-1.41-1.42-1.41v-.01l-.01.01-1.99-1.99zM12 14H6v-3h6v3z"/>
                </svg>
                <svg v-else-if="s.kind === 'hotel'" class="station-svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 13c1.66 0 3-1.34 3-3S8.66 7 7 7s-3 1.34-3 3 1.34 3 3 3zm12-6h-8v7H3V5H1v15h2v-3h18v3h2v-9c0-2.21-1.79-4-4-4z"/>
                </svg>
                <svg v-else class="station-svg" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/>
                </svg>
              </div>

              <!-- 名称与橙红色编辑小铅笔 -->
              <div class="station-name-wrap" @click="store.openStopEditor(day.id, s.id)">
                <span class="station-name">{{ s.name }}</span>
                <span v-if="s.fromPrev" class="station-origin-badge" title="接续自前一天终点">接续出发</span>
                <!-- 纯正橙色铅笔图标 -->
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

              <!-- 拖拽手柄（六点微标） -->
              <div class="station-drag-handle" title="按住拖拽调整顺序" @click.stop>
                <svg viewBox="0 0 20 20" class="drag-dots-svg" fill="currentColor">
                  <path d="M7 4a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 6a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 6a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm9-12a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 6a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm0 6a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/>
                </svg>
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
                    ✏️ 编辑地点 / 类型 / 停留
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

            <!-- 预计到达 / 停留 -->
            <div v-if="stopTimeText(j)" class="tl-stop-time">{{ stopTimeText(j) }}</div>

            <!-- 节点间车行信息 -->
            <div v-if="legText(j)" class="tl-leg-pill">
              <svg class="car-icon-svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.85 7h10.29l1.04 3H5.81l1.04-3zM19 17H5v-4.66l.12-.34h13.77l.11.34V17z"/>
                <circle cx="7.5" cy="14.5" r="1.5"/>
                <circle cx="16.5" cy="14.5" r="1.5"/>
              </svg>
              <span class="leg-info-text">{{ legText(j) }}</span>
              <NavMenu :from="s" :to="day.stops[j + 1]" />
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

    <!-- 沿途补给：终点住宿 / 加油 / 充电 / 服务区 -->
    <SupplyPanel :day-id="day.id" />
  </div>
</template>
