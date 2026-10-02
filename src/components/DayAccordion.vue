<script setup lang="ts">
import { useTripStore } from '../stores/trip'
import { cityOfAddress, cnOrdinal, dateOfDay, fmtDate } from '../services/geo'
import DayEditor from './DayEditor.vue'

const store = useTripStore()

/** 头部路线摘要：起点城市 → 终点城市（无地点时回退为日期） */
function routeLabel(i: number): string {
  const d = store.trip!.days[i]
  if (!d.stops.length) return ''
  const a = cityOfAddress(d.stops[0].address)
  const b = cityOfAddress(d.stops[d.stops.length - 1].address)
  if (!a && !b) return ''
  if (!b || a === b) return a || b
  return `${a} → ${b}`
}

function toggleDay(id: string) {
  store.view = store.view === id ? '' : id
}
</script>

<template>
  <div v-if="store.trip" class="acc">
    <section
      v-for="(d, i) in store.trip.days"
      :key="d.id"
      class="acc-item"
      :class="{ open: store.view === d.id }"
    >
      <div class="acc-head" :class="{ open: store.view === d.id }" role="button" @click="toggleDay(d.id)">
        <span class="acc-caret">▸</span>
        <span class="acc-name">第{{ cnOrdinal(i + 1) }}天</span>
        <span class="acc-route">
          <template v-if="routeLabel(i)">📍 {{ routeLabel(i) }}</template>
          <template v-else>{{ fmtDate(dateOfDay(store.trip!.startDate, i)) }}</template>
        </span>
        <button class="icon-btn acc-map" title="在地图上查看当天路线" @click.stop="store.showDayOnMap(d.id)">🗺</button>
        <button class="icon-btn acc-del" title="删除这一天" @click.stop="store.deleteDay(d.id)">🗑</button>
      </div>
      <div v-if="store.view === d.id" class="acc-body">
        <DayEditor :day-id="d.id" />
      </div>
    </section>

    <button class="acc-add" @click="store.setDayCount(store.trip.days.length + 1)">＋ 增加一天</button>
  </div>
</template>
