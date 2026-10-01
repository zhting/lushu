<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { dateOfDay, fmtDate, fmtDistance, fmtDuration } from '../services/geo'
import { POLICY_OPTIONS } from '../constants'
import type { RoutePolicy } from '../types'

const store = useTripStore()
const fileInput = ref<HTMLInputElement | null>(null)
const editing = ref(false) // 总览默认只读，点「编辑」才显示设置 / 数据 / 删除

function onDateChange(e: Event) {
  store.setStartDate((e.target as HTMLInputElement).value)
}

function onPolicyChange(e: Event) {
  store.setPolicy((e.target as HTMLSelectElement).value as RoutePolicy)
}

function onWarnChange(e: Event) {
  store.setDriveWarn(parseFloat((e.target as HTMLInputElement).value) * 60)
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
</script>

<template>
  <div v-if="store.trip">
    <div class="ov-head">
      <h2>总览</h2>
      <div style="flex: 1"></div>
      <button class="btn btn-mini" :class="{ 'btn-primary': editing }" @click="editing = !editing">
        {{ editing ? '✓ 完成' : '✏️ 编辑' }}
      </button>
    </div>

    <div class="stat-grid">
      <div class="stat"><b>{{ fmtDistance(store.totals.dist) }}</b><span>总里程</span></div>
      <div class="stat"><b>{{ fmtDuration(store.totals.dur) }}</b><span>总驾驶时长</span></div>
    </div>

    <template v-if="editing">
      <div class="card">
        <h3>行程设置</h3>
        <div class="row2">
          <div class="field">
            <label>出发日期</label>
            <input type="date" :value="store.trip.startDate" @change="onDateChange" />
          </div>
          <div class="field">
            <label>路线策略（重新计算全程）</label>
            <select :value="store.trip.policy" @change="onPolicyChange">
              <option v-for="p in POLICY_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
            <p v-if="store.mapCfg.provider === 'osm'" class="muted" style="margin: 4px 0 0">
              开源地图模式下策略暂不生效（OSRM 演示服务仅默认策略），过路费不可用。
            </p>
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label>天数（增减会自动继承起点）</label>
            <div style="display: flex; gap: 6px; align-items: center">
              <button class="btn" style="width: 36px" @click="store.setDayCount(store.trip!.days.length - 1)">−</button>
              <b style="min-width: 30px; text-align: center">{{ store.trip.days.length }}</b>
              <button class="btn" style="width: 36px" @click="store.setDayCount(store.trip!.days.length + 1)">＋</button>
            </div>
          </div>
          <div class="field">
            <label>单日驾驶提醒阈值（小时）</label>
            <input
              type="number"
              min="1"
              max="24"
              :value="store.trip.driveWarnMinutes / 60"
              @change="onWarnChange"
            />
          </div>
        </div>
      </div>

      <div class="card">
        <h3>数据</h3>
        <div class="ops-row">
          <button class="btn btn-mini" @click="exportJson">导出 JSON</button>
          <button class="btn btn-mini" @click="fileInput?.click()">导入 JSON</button>
          <button class="btn btn-mini" style="color: var(--danger)" @click="removeCurrent">删除当前路书</button>
        </div>
        <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFile" />
        <p class="muted" style="margin: 8px 0 0">数据自动保存在本机浏览器；导入的文件会作为新路程加入首页列表。</p>
      </div>
    </template>

    <div class="card">
      <h3>每日概览（点击进入单日）</h3>
      <div
        v-for="s in store.dayStats"
        :key="s.day.id"
        class="ov-row"
        @click="store.view = s.day.id"
      >
        <span class="dot" :style="{ background: s.color }"></span>
        <span class="ov-day">D{{ s.index + 1 }}</span>
        <span class="muted" style="flex: none; font-size: 12px">{{ fmtDate(dateOfDay(store.trip!.startDate, s.index)) }}</span>
        <span class="ov-route">
          {{ s.day.stops.length
            ? (s.day.stops.length > 1
                ? `${s.day.stops[0].name} → ${s.day.stops[s.day.stops.length - 1].name}`
                : s.day.stops[0].name)
            : '未添加地点' }}
        </span>
        <span class="ov-num" v-if="s.route?.status === 'done'">
          {{ fmtDistance(s.route.distanceM) }} · {{ fmtDuration(s.route.durationS) }}
        </span>
        <span class="ov-num muted" v-else-if="s.route?.status === 'pending'">计算中…</span>
        <span class="ov-num error-text" v-else-if="s.route?.status === 'error'">失败</span>
        <span class="ov-num muted" v-else>未设置</span>
        <span v-if="store.overDrive(s.day.id)" class="warn-dot">⚠️</span>
      </div>
      <p class="muted" style="margin: 8px 0 0">
        每天按顺序添加地点即可，最后一个地点通常是当晚住宿；次日的路线会自动从它出发（可在单日里改为从本日第一地出发）。
      </p>
    </div>
  </div>
</template>
