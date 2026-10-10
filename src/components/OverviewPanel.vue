<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { cnOrdinal, dateOfDay, fmtDate, fmtDistance, fmtDuration } from '../services/geo'
import { fmtYuan } from '../services/schedule'
import { DAY_COLORS, DRIVE_WARN_MINUTES, ENERGY_META } from '../constants'
import type { EnergyType } from '../types'

const store = useTripStore()
const fileInput = ref<HTMLInputElement | null>(null)
const editing = ref(false) // 总览默认只读，点「编辑」才显示设置 / 数据 / 删除

function onTitleChange(e: Event) {
  store.setTitle((e.target as HTMLInputElement).value)
}

function onDateChange(e: Event) {
  store.setStartDate((e.target as HTMLInputElement).value)
}

/** 每日概览行：跳回日程页并展开对应天 */
function openDay(dayId: string) {
  store.mapOpen = false
  store.view = dayId
  store.page = 'trip'
}

function exportJson() {
  const blob = new Blob([store.exportJson()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${store.trip?.title || '路书'}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  file
    .text()
    .then((text) => store.importJson(text))
    .catch((err) => store.notify(err?.message || '导入失败', 'error'))
    .finally(() => (input.value = ''))
}

function removeCurrent() {
  store.deleteCurrentTrip()
}

// ── 全程合计与每日对比 ──
const totals = computed(() => store.tripTotals)
const energyMeta = computed(() => ENERGY_META[store.vehicle.energy])
const tollsUnsupported = computed(() => store.mapCfg.provider !== 'amap')
const totalCost = computed(() => totals.value.energy + (totals.value.tolls ?? 0))

/** 每日对比条：按当天车行里程，与最长一天比例；未算出的天显示占位 */
const dayBars = computed(() => {
  const days = store.trip?.days ?? []
  const rows = days.map((d, i) => {
    const sc = store.schedules[d.id]
    const cost = store.dayCost(d.id)
    return {
      id: d.id,
      index: i,
      color: DAY_COLORS[i % DAY_COLORS.length],
      distanceM: sc?.distanceM ?? null,
      driveS: sc?.driveS ?? null,
      cost: cost.energy == null ? null : cost.energy + (cost.tolls ?? 0),
      empty: d.stops.length < 2,
      failed: !!store.legFailed[d.id],
      warn: (sc?.driveS ?? 0) / 60 > DRIVE_WARN_MINUTES,
    }
  })
  const max = Math.max(1, ...rows.map((r) => r.distanceM ?? 0))
  return rows.map((r) => ({ ...r, pct: r.distanceM ? Math.max(2, (r.distanceM / max) * 100) : 0 }))
})

function onEnergy(e: EnergyType) {
  store.setVehicle({ energy: e })
}

function onConsumption(e: Event) {
  store.setVehicle({ consumption: Number((e.target as HTMLInputElement).value) })
}

function onPrice(e: Event) {
  store.setVehicle({ price: Number((e.target as HTMLInputElement).value) })
}
</script>

<template>
  <div v-if="store.trip">
    <div class="ov-head">
      <button class="btn btn-mini" :class="{ 'btn-primary': editing }" style="margin-left: auto" @click="editing = !editing">
        {{ editing ? '✓ 完成' : '✏️ 编辑' }}
      </button>
    </div>

    <template v-if="editing">
      <div class="card">
        <h3>行程设置</h3>
        <div class="field">
          <label>行程名称</label>
          <input :value="store.trip.title" @change="onTitleChange" />
        </div>
        <div class="row2">
          <div class="field">
            <label>出发日期</label>
            <input type="date" :value="store.trip.startDate" @change="onDateChange" />
          </div>
          <div class="field">
            <label>天数（增减会自动继承起点）</label>
            <div style="display: flex; gap: 6px; align-items: center">
              <button class="btn" style="width: 36px" @click="store.setDayCount(store.trip!.days.length - 1)">−</button>
              <b style="min-width: 30px; text-align: center">{{ store.trip.days.length }}</b>
              <button class="btn" style="width: 36px" @click="store.setDayCount(store.trip!.days.length + 1)">＋</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>车辆与费用</h3>
        <div class="field">
          <label>能源类型</label>
          <div class="chip-group">
            <button
              v-for="e in (['fuel', 'ev'] as const)"
              :key="e"
              type="button"
              class="chip"
              :class="{ 'chip-active': store.vehicle.energy === e }"
              @click="onEnergy(e)"
            >
              {{ e === 'fuel' ? '⛽' : '🔌' }} {{ ENERGY_META[e].label }}
            </button>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>{{ store.vehicle.energy === 'fuel' ? '油耗' : '电耗' }}（{{ energyMeta.consumptionUnit }}）</label>
            <input type="number" min="0" max="100" step="0.1" :value="store.vehicle.consumption" @change="onConsumption" />
          </div>
          <div class="field">
            <label>{{ store.vehicle.energy === 'fuel' ? '油价' : '电价' }}（{{ energyMeta.priceUnit }}）</label>
            <input type="number" min="0" max="100" step="0.01" :value="store.vehicle.price" @change="onPrice" />
          </div>
        </div>
        <p class="muted" style="margin: 0">{{ energyMeta.costLabel }}按车行里程估算。过路费仅高德地图提供，开源地图下不计。</p>
      </div>

      <div class="card">
        <h3>数据</h3>
        <div class="ops-row">
          <button class="btn btn-mini" @click="exportJson">导出 JSON</button>
          <button class="btn btn-mini" @click="fileInput?.click()">导入 JSON</button>
          <button class="btn btn-mini" style="color: var(--danger)" @click="removeCurrent">删除当前路书</button>
        </div>
        <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFile" />
        <p class="muted" style="margin: 8px 0 0">数据自动保存到服务端；导入的文件会作为新路程加入首页列表。</p>
      </div>
    </template>

    <div class="card">
      <h3>全程合计</h3>
      <div class="stat-tiles">
        <div class="stat-tile">
          <div class="stat-label">总里程</div>
          <div class="stat-value">{{ totals.distanceM ? fmtDistance(totals.distanceM) : '—' }}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">驾驶时长</div>
          <div class="stat-value">{{ fmtDuration(totals.driveS) || '—' }}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">{{ energyMeta.costLabel }}（估）</div>
          <div class="stat-value">{{ totals.distanceM ? fmtYuan(totals.energy) : '—' }}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">过路费</div>
          <div class="stat-value" :class="{ 'stat-na': totals.tolls == null }">
            {{ totals.tolls != null ? fmtYuan(totals.tolls) : '—' }}
          </div>
        </div>
      </div>
      <p class="stat-foot muted">
        <template v-if="totals.distanceM">
          合计约 <b>{{ fmtYuan(totalCost) }}</b>{{ totals.tolls == null ? '（不含过路费）' : '' }}。
        </template>
        {{ energyMeta.costLabel }}按 {{ store.vehicle.consumption }} {{ energyMeta.consumptionUnit }}、{{ store.vehicle.price }} {{ energyMeta.priceUnit }} 估算，可点右上「编辑」修改。
        <template v-if="tollsUnsupported">过路费需切换到高德地图才能获取。</template>
        <template v-if="totals.pendingDays">另有 {{ totals.pendingDays }} 天线路还没算出，暂未计入。</template>
      </p>
    </div>

    <div class="card">
      <h3>每日对比</h3>
      <div class="day-bars" role="table" aria-label="每日车行里程与驾驶时长">
        <div
          v-for="r in dayBars"
          :key="r.id"
          class="day-bar-row"
          role="row"
          :title="r.distanceM != null && !r.empty
            ? `第${cnOrdinal(r.index + 1)}天：${fmtDistance(r.distanceM)}，驾驶 ${fmtDuration(r.driveS ?? 0)}${r.cost != null ? '，费用约 ' + fmtYuan(r.cost) : ''}`
            : ''"
          @click="openDay(r.id)"
        >
          <span class="day-bar-label" role="cell">
            <i class="day-bar-dot" :style="{ background: r.color }"></i>D{{ r.index + 1 }}
          </span>
          <span class="day-bar-track" role="cell">
            <span v-if="r.pct" class="day-bar-fill" :style="{ width: r.pct + '%' }"></span>
          </span>
          <span class="day-bar-value" role="cell">
            <template v-if="r.empty"><span class="muted">未安排</span></template>
            <template v-else-if="r.distanceM == null"><span class="muted">{{ r.failed ? '未算出' : '计算中' }}</span></template>
            <template v-else>
              <b>{{ fmtDistance(r.distanceM) }}</b>
              <span class="muted"> · {{ fmtDuration(r.driveS ?? 0) || '—' }}</span>
              <span v-if="r.warn" class="day-bar-warn">⚠️ 超 {{ DRIVE_WARN_MINUTES / 60 }} 小时</span>
            </template>
          </span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>每日概览（点击进入单日）</h3>
      <div v-for="s in store.dayStats" :key="s.day.id" class="ov-day-block">
        <div class="ov-row" @click="openDay(s.day.id)">
          <span class="ov-day">第{{ cnOrdinal(s.index + 1) }}天</span>
          <span class="muted" style="flex: none; font-size: 12px">{{ fmtDate(dateOfDay(store.trip!.startDate, s.index)) }}</span>
          <span class="ov-route">
            {{ s.day.stops.length
              ? (s.day.stops.length > 1
                  ? `${s.day.stops[0].name} → ${s.day.stops[s.day.stops.length - 1].name}`
                  : s.day.stops[0].name)
              : '未添加地点' }}
          </span>
          <span class="ov-num" v-if="s.day.stops.length">{{ s.day.stops.length }} 个地点</span>
        </div>
        <ul v-if="s.day.stops.length" class="ov-stops">
          <li v-for="(st, j) in s.day.stops" :key="st.id" @click="openDay(s.day.id)">
            <span class="ov-stop-no">{{ j + 1 }}</span>
            <span class="ov-stop-name">{{ st.name }}</span>
          </li>
        </ul>
      </div>
      <p class="muted" style="margin: 8px 0 0">
        每天按顺序添加地点即可，最后一个地点通常是当晚住宿；次日默认从前一天最后一个地点出发（可在单日里改为从本日第一地出发）。
      </p>
    </div>
  </div>
</template>
