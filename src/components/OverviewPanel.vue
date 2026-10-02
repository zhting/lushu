<script setup lang="ts">
import { ref } from 'vue'
import { useTripStore } from '../stores/trip'
import { cnOrdinal, dateOfDay, fmtDate } from '../services/geo'

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
